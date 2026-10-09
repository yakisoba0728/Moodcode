import { validateRecoveryInput } from '../shared/recovery.js';
import { randomUUID } from 'node:crypto';
import type { DesktopAdvancedAction, DesktopAdvancedSnapshot } from '../shared/advanced.js';
import type { JsonValue } from '@moodcode/contracts';
import type { CommandEnvelope, CommandResult } from '@moodcode/contracts';
import type { DesktopBootstrap, DesktopSettings, DesktopUpdate, HostStatus, SaveDesktopSettings, DesktopRecoveryStatus, DesktopRecoveryResult } from '../shared/protocol.js';
import type { WorkerBootstrap, WorkerEngineConfig, WorkerPush, WorkerRequest, WorkerStartPayload } from '../worker/protocol.js';
import type { PreparedSettings, ResolvedDesktopSettings } from './settings.js';

export interface UtilityTransport {
  readonly diagnosticSource?: 'original-electron-utility';
  postMessage(message: WorkerRequest): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onExit(listener: (code: number) => void): () => void;
}
export interface HostSettingsStore {
  load(): Promise<ResolvedDesktopSettings>;
  prepare(input: SaveDesktopSettings): Promise<PreparedSettings>;
  commit(prepared: PreparedSettings): Promise<ResolvedDesktopSettings>;
  getView(): DesktopSettings;
}
/** This receipt proves only original utility transport close/exit, never native effects. */
export interface UtilityCloseConnectionDiagnostic {
  connectionId: string;
  scope: 'engine' | 'storage';
  generation: number;
  source: 'original-electron-utility' | 'utility-transport';
  utilityExitObservable: boolean;
  closeRequested: boolean;
  engineCloseAcknowledged: boolean;
  utilityExitObserved: boolean;
  exitCode: number | null;
  cleanupConfirmed: boolean | null;
  forcedStop: false;
  reason: 'close-error' | 'close-timeout' | 'exit-timeout' | 'exit-without-ack' | 'nonzero-exit' | 'exit-status-unknown' | 'exit-unobservable' | null;
}
export interface UtilityCloseDiagnostics {
  schemaVersion: 1;
  utilityScope: 'main-utilities';
  complete: boolean;
  evictedCount: number;
  spawnAttempted: boolean;
  spawnUnobserved: boolean;
  connections: UtilityCloseConnectionDiagnostic[];
  utilityAcknowledged: boolean | null;
  utilityExitObserved: boolean | null;
  cleanupConfirmed: boolean | null;
  forcedStop: false;
}
export const UTILITY_CLOSE_DIAGNOSTIC_LIMIT = 64;

export interface DesktopHostOptions {
  spawn: () => UtilityTransport;
  settings: HostSettingsStore;
  dbPath: string;
  artifactDir: string;
  platform: string;
  version: string;
  testScenario?: 'coding' | 'slow' | 'advanced' | 'account';
  onStatus?: (status: HostStatus) => void;
  onUpdate?: (ownerId: string, update: DesktopUpdate) => void;
  onUtilityClose?: (diagnostics: UtilityCloseDiagnostics) => void;
  rpcTimeoutMs?: number;
  closeTimeoutMs?: number;
  utilityExitTimeoutMs?: number;
}
export class HostError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
interface PendingRpc {
  type: WorkerRequest['type'];
  resolve: (value: unknown) => void;
  reject: (error: HostError) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface Connection {
  transport: UtilityTransport;
  pending: Map<string, PendingRpc>;
  connectionId: string;
  scope: 'engine' | 'storage';
  generation: number;
  detachMessage?: () => void;
  detachExit?: () => void;
  utilityExitObservable: boolean;
  exitCode: number | null;
  closeFailureReason?: 'close-error' | 'close-timeout' | 'exit-unobservable';
  exitTimedOut: boolean;
  exitWaiters: Set<() => void>;
  closeTask?: Promise<void>;
  exited: boolean;
  closed: boolean;
  closeRequested: boolean;
  secrets: string[];
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function safeError(error: unknown, fallback: string, secrets: readonly string[] = []): HostError {
  let message = object(error) && typeof error.message === 'string' ? error.message : error instanceof Error ? error.message : 'The desktop engine operation failed.';
  const code = object(error) && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    && !secrets.some(secret => secret && error.code && String(error.code).includes(secret)) ? error.code : fallback;
  for (const secret of secrets) if (secret) message = message.split(secret).join('[REDACTED]');
  return new HostError(code, message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1024));
}

/** Main owns transport and settings; the utility process owns every engine/store. */
export class DesktopHost {
  private status: HostStatus = { state: 'starting', generation: 0 };
  private connection?: Connection;
  private readonly auxiliaries = new Set<Connection>();
  private readonly utilityConnections: Connection[] = [];
  private evictedUtilityCount = 0;
  private evictedUtilityUnconfirmed = false;
  private spawnAttempted = false;
  private spawnUnobserved = false;
  private diagnosticTask?: Promise<DesktopRecoveryStatus>;
  private transition = false;
  private transitionSettled?: Promise<void>;
  private finishTransition?: () => void;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly options: DesktopHostOptions;
  constructor(options: DesktopHostOptions) { this.options = options; }

  getStatus(): HostStatus { return structuredClone(this.status); }
  getUtilityCloseDiagnostics(): UtilityCloseDiagnostics {
    const connections = this.utilityConnections.map(connection => {
      const reason: UtilityCloseConnectionDiagnostic['reason'] = connection.closeFailureReason
        ?? (connection.exitTimedOut ? 'exit-timeout'
          : !connection.exited ? null
          : !connection.closed ? 'exit-without-ack'
          : connection.exitCode === null ? 'exit-status-unknown'
          : connection.exitCode !== 0 ? 'nonzero-exit' : null);
      return {
        connectionId: connection.connectionId, scope: connection.scope, generation: connection.generation,
        source: connection.transport.diagnosticSource === 'original-electron-utility' ? 'original-electron-utility' as const : 'utility-transport' as const,
        utilityExitObservable: connection.utilityExitObservable, closeRequested: connection.closeRequested,
        engineCloseAcknowledged: connection.closed, utilityExitObserved: connection.exited, exitCode: connection.exitCode,
        cleanupConfirmed: reason ? false : connection.closed && connection.exited ? true : null,
        forcedStop: false as const, reason,
      };
    });
    const complete = this.evictedUtilityCount === 0 && !this.spawnUnobserved;
    const cleanupConfirmed = this.evictedUtilityUnconfirmed || connections.some(connection => connection.cleanupConfirmed === false) ? false
      : !complete || connections.length === 0 || connections.some(connection => connection.cleanupConfirmed !== true) ? null : true;
    return {
      schemaVersion: 1, utilityScope: 'main-utilities', complete, evictedCount: this.evictedUtilityCount,
      spawnAttempted: this.spawnAttempted, spawnUnobserved: this.spawnUnobserved, connections,
      utilityAcknowledged: !complete || connections.length === 0 ? null : connections.every(connection => connection.engineCloseAcknowledged),
      utilityExitObserved: !complete || connections.length === 0 ? null : connections.every(connection => connection.utilityExitObserved),
      cleanupConfirmed, forcedStop: false,
    };
  }
  private publishUtilityClose(): void {
    // Observers receive a new bounded DTO and cannot change cleanup or admission.
    try { this.options.onUtilityClose?.(this.getUtilityCloseDiagnostics()); } catch { /* Diagnostic observers are optional. */ }
  }
  private spawnUtility(): UtilityTransport {
    this.spawnAttempted = true;
    try { return this.options.spawn(); }
    catch (error) {
      // Native fork can allocate a child before its adapter throws. An absent
      // returned transport cannot establish that this attempt spawned nothing.
      this.spawnUnobserved = true;
      this.publishUtilityClose();
      throw error;
    }
  }
  private reserveUtilityConnection(): void {
    if (this.utilityConnections.length < UTILITY_CLOSE_DIAGNOSTIC_LIMIT) return;
    // A live original child retains its transport and exit listener. Bound further
    // admission instead of losing ownership to make room in a diagnostic ledger.
    const settled = this.utilityConnections.findIndex(connection => connection.exited);
    if (settled < 0) throw new HostError('HOST_UTILITY_CAPACITY', 'Original utility processes must exit before another utility can start.');
    const [removed] = this.utilityConnections.splice(settled, 1);
    this.evictedUtilityCount += 1;
    if (removed && (!removed.closed || removed.exitCode !== 0 || removed.closeFailureReason || removed.exitTimedOut)) this.evictedUtilityUnconfirmed = true;
  }
  private attachConnection(transport: UtilityTransport, scope: Connection['scope'], secrets: string[]): Connection {
    const connection: Connection = {
      transport, connectionId: randomUUID(), scope, generation: this.status.generation,
      pending: new Map(), utilityExitObservable: false, exitCode: null, exitTimedOut: false, exitWaiters: new Set(),
      exited: false, closed: false, closeRequested: false, secrets,
    };
    this.utilityConnections.push(connection);
    if (scope === 'engine') this.connection = connection; else this.auxiliaries.add(connection);
    try {
      connection.detachExit = transport.onExit(code => this.exited(connection, code));
      connection.utilityExitObservable = true;
      connection.detachMessage = transport.onMessage(message => this.receive(connection, message));
    } catch (error) {
      connection.closeFailureReason = 'exit-unobservable';
      this.publishUtilityClose();
      throw safeError(error, 'HOST_TRANSPORT_FAILED', secrets);
    }
    this.publishUtilityClose();
    return connection;
  }
  getSettings(): DesktopSettings {
    const view = this.options.settings.getView();
    const publicView: DesktopSettings = {
      providerId: view.providerId, modelId: view.modelId, baseURL: view.baseURL,
      ...(view.anthropicWorkspaceId ? { anthropicWorkspaceId: view.anthropicWorkspaceId } : {}),
      keyConfigured: view.keyConfigured, keySource: view.keySource, credentialStorage: view.credentialStorage,
      ...(view.credentialMode ? { credentialMode: view.credentialMode } : {}), ...(view.accountId ? { accountId: view.accountId } : {}),
      ...(view.codexAuthState ? { codexAuthState: view.codexAuthState } : {}),
      ...(view.codexModelId ? { codexModelId: view.codexModelId } : {}),
      ...(view.codexModels ? { codexModels: structuredClone(view.codexModels) } : {}),
      ...(view.reasoningEffort ? { reasoningEffort: view.reasoningEffort } : {}),
    };
    return { ...publicView, ...(this.options.testScenario && this.options.testScenario !== 'account' ? { providerId: 'scripted' as const, modelId: `desktop-${this.options.testScenario}-fixture`, baseURL: '', keyConfigured: false, keySource: 'none' as const } : {}) };
  }
  private beginTransition(): void {
    this.transition = true;
    this.transitionSettled = new Promise(resolve => { this.finishTransition = resolve; });
  }
  private endTransition(): void {
    this.transition = false;
    this.finishTransition?.();
    this.finishTransition = undefined;
    this.transitionSettled = undefined;
  }
  private publish(state: HostStatus['state'], error?: HostError): void {
    this.status = { state, generation: this.status.generation, ...(error ? { error: { code: error.code, message: error.message } } : {}) };
    this.options.onStatus?.(this.getStatus());
  }
  async initialize(): Promise<HostStatus> {
    if (this.connection || this.transition || this.closing) throw new HostError('ENGINE_BUSY', 'Desktop engine initialization is already in progress.');
    this.beginTransition();
    try {
      await this.start(await this.loadConfig());
    } catch (error) {
      this.publish('failed', safeError(error, 'HOST_START_FAILED'));
    } finally { this.endTransition(); }
    return this.getStatus();
  }
  private async loadConfig(): Promise<WorkerEngineConfig> {
    try { return (await this.options.settings.load()).engineConfig; }
    catch (error) {
      const failure = safeError(error, 'SETTINGS_LOAD_FAILED');
      if (this.options.testScenario && this.options.testScenario !== 'account' && [
        'SETTINGS_KEY_REQUIRED', 'SETTINGS_CODEX_AUTH_REQUIRED', 'SETTINGS_CODEX_MODEL_REQUIRED',
        'SETTINGS_CREDENTIAL_STORAGE_UNAVAILABLE', 'SETTINGS_CREDENTIAL_DECRYPT_FAILED',
        'SETTINGS_ENVIRONMENT_CREDENTIAL_INVALID',
      ].includes(failure.code)) {
        // An explicit fixture launch never depends on a saved real provider's
        // credentials. Malformed files/configuration still surface normally.
        return { providerId: 'scripted', modelId: `desktop-${this.options.testScenario}-fixture`, baseURL: '' };
      }
      throw failure;
    }
  }
  private async start(config: WorkerEngineConfig, publishReady = true): Promise<void> {
    if (this.closing) throw new HostError('ENGINE_CLOSED', 'Desktop is closing.');
    if (this.connection && !this.connection.closed && !this.connection.exited) throw new HostError('ENGINE_BUSY', 'The previous engine must close before a new one starts.');
    this.status.generation += 1;
    this.publish('starting');
    const secrets = config.apiKey ? [config.apiKey] : [];
    this.reserveUtilityConnection();
    let transport: UtilityTransport;
    try { transport = this.spawnUtility(); }
    catch (error) { throw safeError(error, 'HOST_SPAWN_FAILED', secrets); }
    const connection = this.attachConnection(transport, 'engine', secrets);
    const payload: WorkerStartPayload = {
      dbPath: this.options.dbPath, artifactDir: this.options.artifactDir,
      config: this.options.testScenario ? { providerId: 'scripted', modelId: `desktop-${this.options.testScenario}-fixture`, baseURL: '' } : { ...config },
      ...(this.options.testScenario ? { testScenario: this.options.testScenario } : {}),
    };
    try {
      await this.rpc(connection, 'start', payload);
      if (this.closing) throw new HostError('ENGINE_CLOSED', 'Desktop is closing.');
      if (publishReady) this.publish('ready');
    } catch (error) {
      // A rejected start may still have allocated an engine. Confirm its close
      // before permitting another process to open the same database.
      try { await this.closeConnection(connection); } catch { /* retained for retry/quit cleanup */ }
      throw safeError(error, 'HOST_START_FAILED', connection.secrets);
    }
  }
  private exited(connection: Connection, code: number): void {
    if (connection.exited) return;
    connection.exited = true;
    connection.exitCode = Number.isSafeInteger(code) && code >= -2_147_483_648 && code <= 2_147_483_647 ? code : null;
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HostError('HOST_WORKER_EXITED', 'The engine utility process exited. Retry to reopen its persisted state.'));
    }
    connection.pending.clear();
    connection.detachMessage?.(); connection.detachMessage = undefined;
    connection.detachExit?.(); connection.detachExit = undefined;
    connection.secrets.length = 0;
    for (const finish of [...connection.exitWaiters]) finish();
    this.publishUtilityClose();
    if (this.connection === connection && !connection.closed) this.publish('failed', new HostError('HOST_WORKER_EXITED', 'The engine utility process exited. Retry to reopen its persisted state.'));
  }
  private receive(connection: Connection, message: unknown): void {
    if (connection.exited || !object(message)) return;
    if (message.type === 'update') {
      if (this.connection !== connection) return;
      const push = message as unknown as WorkerPush;
      const update = push.update;
      if (typeof push.ownerId !== 'string' || push.ownerId.length > 160 || !object(update)
          || typeof update.subscriptionId !== 'string' || update.subscriptionId.length > 160
          || typeof update.sessionId !== 'string' || update.sessionId.length > 160
          || !Number.isSafeInteger(update.lastSeq) || update.lastSeq < 0) return;
      const clean: DesktopUpdate = { subscriptionId: update.subscriptionId, sessionId: update.sessionId, lastSeq: update.lastSeq };
      if (update.error) {
        const failure = safeError(update.error, 'SUBSCRIPTION_FAILED', connection.secrets);
        clean.error = { code: failure.code, message: failure.message };
      }
      this.options.onUpdate?.(push.ownerId, clean);
      return;
    }
    if (typeof message.id !== 'string' || typeof message.ok !== 'boolean') return;
    const pending = connection.pending.get(message.id);
    if (!pending) return;
    connection.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) {
      // Record the exact close reply before resolving its promise: an original
      // child exit in the same turn cannot be mistaken for exit without ACK.
      if (pending.type === 'close') this.acknowledgedClose(connection);
      pending.resolve(message.result);
    }
    else pending.reject(safeError(message.error, 'HOST_RPC_FAILED', connection.secrets));
  }
  private rpc(connection: Connection, type: WorkerRequest['type'], payload?: unknown, timeout = this.options.rpcTimeoutMs ?? 120_000): Promise<unknown> {
    if (connection.exited || connection.closed) return Promise.reject(new HostError('HOST_WORKER_UNAVAILABLE', 'The engine utility process is unavailable.'));
    if (connection.pending.size >= 128) return Promise.reject(new HostError('HOST_BACKPRESSURE', 'Too many engine requests are pending.'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        reject(new HostError('HOST_RPC_TIMEOUT', `The engine did not confirm the ${type} operation before its deadline.`));
      }, timeout);
      connection.pending.set(id, { type, resolve, reject, timer });
      try { connection.transport.postMessage({ id, type, ...(payload === undefined ? {} : { payload }) } as WorkerRequest); }
      catch (error) {
        connection.pending.delete(id); clearTimeout(timer);
        reject(safeError(error, 'HOST_SEND_FAILED', connection.secrets));
      }
    });
  }
  private requireReady(): Connection {
    if (this.closing) throw new HostError('ENGINE_CLOSED', 'Desktop is closing.');
    if (this.transition) throw new HostError('ENGINE_BUSY', 'Desktop engine settings are changing.');
    if (this.status.state !== 'ready' || !this.connection) throw new HostError('HOST_NOT_READY', 'The desktop engine is unavailable. Retry it from settings.');
    return this.connection;
  }
  private tracked<T>(task: Promise<unknown>): Promise<T> {
    this.inflight.add(task);
    void task.finally(() => this.inflight.delete(task)).catch(() => {});
    return task as Promise<T>;
  }
  command(command: CommandEnvelope): Promise<CommandResult> {
    return this.tracked(this.rpc(this.requireReady(), 'command', command));
  }
  advanced(ownerId: string, input: DesktopAdvancedAction): Promise<JsonValue> {
    return this.tracked(this.rpc(this.requireReady(), 'advanced', { ownerId, input }));
  }
  getAdvancedSnapshot(sessionId: string): Promise<DesktopAdvancedSnapshot> {
    return this.tracked(this.rpc(this.requireReady(), 'advancedSnapshot', { sessionId }));
  }
  subscribe(ownerId: string, sessionId: string, afterSeq: number): Promise<string> {
    return this.tracked(this.rpc(this.requireReady(), 'subscribe', { ownerId, sessionId, afterSeq }));
  }
  unsubscribe(ownerId: string, subscriptionId: string): Promise<void> {
    return this.tracked(this.rpc(this.requireReady(), 'unsubscribe', { ownerId, subscriptionId }));
  }
  async dropOwner(ownerId: string): Promise<void> {
    const connection = this.connection;
    if (!connection || connection.exited || connection.closed) return;
    await this.rpc(connection, 'dropOwner', { ownerId });
  }
  async getBootstrap(): Promise<DesktopBootstrap> {
    let content: Partial<WorkerBootstrap> & Pick<WorkerBootstrap, 'workspaces'> = { workspaces: [] };
    if (this.status.state === 'ready' && !this.transition && !this.closing && this.connection) {
      const snapshot = await this.tracked<WorkerBootstrap>(this.rpc(this.connection, 'bootstrap'));
      content = { workspaces: snapshot.workspaces, capabilities: snapshot.capabilities };
    }
    return { host: this.getStatus(), platform: this.options.platform, version: this.options.version, ...content, settings: this.getSettings() };
  }
  private async idle(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
    if (this.connection && !this.connection.exited && !this.connection.closed && !this.connection.closeRequested) await this.rpc(this.connection, 'assertIdle');
  }
  /** Account rotation holds admission for the complete browser/refresh operation. */
  async accountTransition<T>(operation: () => Promise<T>, assertCurrent: () => void = () => {}): Promise<T> {
    if (this.transition || this.closing) throw new HostError('ENGINE_BUSY', 'Desktop engine settings are already changing.');
    this.beginTransition();
    let stopped = false;
    try {
      await this.idle();
      assertCurrent();
      await this.closeConnection(this.connection); stopped = true;
      this.publish('starting');
      assertCurrent();
      const result = await operation();
      await this.start(await this.loadConfig());
      return result;
    } catch (error) {
      const failure = safeError(error, 'ACCOUNT_OPERATION_FAILED', this.connection?.secrets ?? []);
      if (stopped) {
        // A failed refresh/sign-out must not leave the utility holding the old bearer.
        try { await this.start(await this.loadConfig()); } catch { this.publish('failed', failure); }
      }
      throw failure;
    } finally { this.endTransition(); }
  }
  async saveSettings(input: SaveDesktopSettings): Promise<DesktopSettings> {
    if (this.transition || this.closing) throw new HostError('ENGINE_BUSY', 'Desktop engine settings are already changing.');
    this.beginTransition();
    let restarting = false;
    let inputSecrets: string[] = [];
    try {
      const descriptor = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'apiKey') : undefined;
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') inputSecrets = [descriptor.value];
    } catch { /* Invalid candidates are rejected by the settings validator. */ }
    try {
      const prepared = await this.options.settings.prepare(input);
      await this.idle();
      if (this.closing) throw new HostError('ENGINE_CLOSED', 'Desktop is closing.');
      restarting = true;
      this.publish('starting');
      await this.closeConnection(this.connection);
      try { await this.start(prepared.engineConfig, false); }
      catch (error) { throw new HostError('SETTINGS_ENGINE_START_FAILED', `The previous engine closed, but the new configuration could not start: ${safeError(error, 'HOST_START_FAILED', prepared.engineConfig.apiKey ? [prepared.engineConfig.apiKey] : []).message}`); }
      try { await this.options.settings.commit(prepared); }
      catch {
        try { await this.closeConnection(this.connection); }
        catch { throw new HostError('SETTINGS_COMMIT_CLEANUP_FAILED', 'Encrypted settings could not be saved, and the new engine has not confirmed cleanup. Previous saved settings remain available; retry engine cleanup before reopening it.'); }
        throw new HostError('SETTINGS_COMMIT_FAILED', 'The new engine closed because encrypted settings could not be saved. Previous saved settings remain available for retry.');
      }
      this.publish('ready');
      return this.getSettings();
    } catch (error) {
      const failure = safeError(error, 'SETTINGS_RESTART_FAILED', [...inputSecrets, ...(this.connection?.secrets ?? [])]);
      if (restarting) this.publish('failed', failure);
      throw failure;
    } finally { this.endTransition(); }
  }
  private async storageRequest<T>(type: 'diagnostics' | 'recover', input: Record<string, unknown> = {}): Promise<T> {
    if (this.closing) throw new HostError('ENGINE_CLOSED', 'Desktop is closing.');
    this.reserveUtilityConnection();
    const connection = this.attachConnection(this.spawnUtility(), 'storage', []);
    try { return await this.rpc(connection, type, { dbPath: this.options.dbPath, artifactDir: this.options.artifactDir, ...input }) as T; }
    finally { await this.closeConnection(connection); this.auxiliaries.delete(connection); }
  }
  getRecoveryStatus(): Promise<DesktopRecoveryStatus> {
    if (this.transition) throw new HostError('ENGINE_BUSY', 'Engine transition is in progress.');
    if (!this.diagnosticTask) {
      const current = this.connection;
      const task = this.tracked<DesktopRecoveryStatus>((async () => {
        let ownedIdle = false;
        if (this.status.state === 'ready' && current) {
          try { await this.rpc(current, 'assertIdle'); ownedIdle = true; } catch { /* Active work stays blocked. */ }
        }
        const status = await this.storageRequest<DesktopRecoveryStatus>('diagnostics');
        // The ready engine owns both lock databases. Its verified idle handles
        // are released by recoverEngine before mutation; all external/effect
        // blockers still apply and are checked again inside recovery.
        if (ownedIdle && (status.activeRunCount ?? 0) === 0 && this.connection === current && this.status.state === 'ready' && !this.transition) {
          const blockers = status.blockers.filter(code => code !== 'RECOVERY_OWNER_BUSY');
          return { ...status, blockers, state: blockers.length ? 'blocked' : status.pendingRestoreCount || status.marker?.active ? 'recoverable' : 'clear' };
        }
        return status;
      })());
      this.diagnosticTask = task;
      void task.finally(() => { if (this.diagnosticTask === task) this.diagnosticTask = undefined; }).catch(() => {});
    }
    return this.diagnosticTask;
  }
  async recoverEngine(input: { fingerprint: string; acknowledged: true }): Promise<DesktopRecoveryResult> {
    input = validateRecoveryInput(input);
    if (this.transition || this.closing) throw new HostError('ENGINE_BUSY', 'An engine transition is already in progress.');
    this.beginTransition();
    let closed = false;
    try {
      await this.idle();
      await this.closeConnection(this.connection);
      closed = true;
      this.publish('starting');
      const result = await this.storageRequest<DesktopRecoveryResult>('recover', input);
      await this.start(await this.loadConfig());
      return result;
    } catch (error) {
      const failure = safeError(error, 'RECOVERY_FAILED');
      if (closed) this.publish('failed', failure);
      throw failure;
    } finally { this.endTransition(); }
  }
  backupDatabase(destination: string): Promise<{ bytes: number }> {
    return this.tracked(this.rpc(this.requireReady(), 'backup', { destination }));
  }
  async retryEngine(): Promise<HostStatus> {
    if (this.transition || this.closing) throw new HostError('ENGINE_BUSY', 'Desktop engine settings are already changing.');
    this.beginTransition();
    let restarting = false;
    try {
      await this.idle();
      if (this.closing) throw new HostError('ENGINE_CLOSED', 'Desktop is closing.');
      restarting = true;
      this.publish('starting');
      await this.closeConnection(this.connection);
      await this.start(await this.loadConfig());
    } catch (error) {
      const failure = safeError(error, 'HOST_RETRY_FAILED');
      if (restarting) this.publish('failed', failure);
      else throw failure;
    } finally { this.endTransition(); }
    return this.getStatus();
  }
  private acknowledgedClose(connection: Connection): void {
    connection.closed = true;
    // Engine close admission and physical utility exit are separate evidence.
    connection.secrets.length = 0;
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HostError('ENGINE_CLOSED', 'The engine has closed.'));
    }
    connection.pending.clear();
    connection.detachMessage?.(); connection.detachMessage = undefined;
    this.publishUtilityClose();
  }
  private closeConnection(connection?: Connection): Promise<void> {
    if (!connection || connection.exited || connection.closed) return Promise.resolve();
    if (connection.closeTask) return connection.closeTask;
    connection.closeRequested = true;
    this.publishUtilityClose();
    const task = this.rpc(connection, 'close', undefined, this.options.closeTimeoutMs ?? 120_000).then(() => undefined, error => {
      // Exit without its matching close ACK remains visible as such, while a
      // failed/timed out close attempt is retained even if a later retry exits.
      if (!connection.exited) connection.closeFailureReason = error instanceof HostError && error.code === 'HOST_RPC_TIMEOUT' ? 'close-timeout' : 'close-error';
      this.publishUtilityClose();
      throw error;
    }).finally(() => { if (connection.closeTask === task) connection.closeTask = undefined; });
    connection.closeTask = task;
    return task;
  }
  private waitForUtilityExit(connection: Connection): Promise<void> {
    if (connection.exited) return Promise.resolve();
    if (!connection.utilityExitObservable) return Promise.reject(new HostError('HOST_WORKER_EXIT_UNOBSERVABLE', 'The original utility process exit cannot be observed.'));
    const configured = this.options.utilityExitTimeoutMs ?? 5_000;
    const timeout = Number.isFinite(configured) ? Math.max(1, Math.min(30_000, configured)) : 5_000;
    return new Promise((resolve, reject) => {
      const finish = (): void => { clearTimeout(timer); connection.exitWaiters.delete(finish); resolve(); };
      const timer = setTimeout(() => {
        connection.exitWaiters.delete(finish);
        connection.exitTimedOut = true;
        this.publishUtilityClose();
        // Keep the original listener for a subsequent quit retry and exact late
        // exit evidence; admission bounds the number of retained live children.
        reject(new HostError('HOST_WORKER_EXIT_TIMEOUT', 'The original engine utility process did not confirm exit before its deadline.'));
      }, timeout);
      connection.exitWaiters.add(finish);
    });
  }
  /** Installer admission requires every original utility ACK and successful exit. */
  async closeForUpdate(): Promise<void> {
    await this.close();
    const diagnostics = this.getUtilityCloseDiagnostics();
    const neverSpawned = !diagnostics.spawnAttempted && diagnostics.complete && diagnostics.connections.length === 0;
    if (!neverSpawned && diagnostics.cleanupConfirmed !== true) throw new HostError('HOST_UTILITY_CLOSE_UNCONFIRMED', 'Original utility cleanup has not been confirmed for update installation.');
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.transitionSettled;
      await Promise.allSettled([...this.inflight]);
      await this.closeConnection(this.connection);
      await Promise.all([...this.auxiliaries].map(connection => this.closeConnection(connection)));
      this.auxiliaries.clear();
      await Promise.all(this.utilityConnections.map(connection => this.waitForUtilityExit(connection)));
      this.publishUtilityClose();
      this.publish('stopped');
    })();
    void this.closePromise.catch(error => {
      this.publish('failed', safeError(error, 'HOST_CLOSE_FAILED'));
      this.closePromise = undefined;
    });
    return this.closePromise;
  }
}
