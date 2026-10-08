import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { EngineError, REASONING_EFFORTS, SCHEMA_VERSION, isTerminal, type EngineCapabilities } from '@moodcode/contracts';
import { getRecoveryStatus, recoverEngine, createEngine, CodexProvider, OpenAICompatibleProvider, ResponsesProvider, ScriptedProvider, type EngineOptions, type MoodcodeEngine, type ProviderAdapter } from '@moodcode/engine';
import type { DesktopUpdate } from '../shared/protocol.js';
import type { WorkerBootstrap, WorkerEngineConfig, WorkerPush, WorkerResponse, WorkerStartPayload } from './protocol.js';
import { testFixtureProvider } from './fixtures.js';
import { AdvancedService } from './advanced.js';
import { validateAdvancedAction } from '../shared/advanced.js';

export const WORKER_LIMITS = Object.freeze({ maxRequestBytes: 1_048_576, maxDepth: 32, maxNodes: 20_000, maxInflightCommands: 64,
  maxSubscriptions: 128, maxOwnerSubscriptions: 32, invalidationDelayMs: 25 });
const TYPES = new Set(['start', 'bootstrap', 'command', 'advanced', 'advancedSnapshot', 'subscribe', 'unsubscribe', 'dropOwner', 'assertIdle', 'diagnostics', 'recover', 'backup', 'close']);
type WorkerEngine = Pick<MoodcodeEngine, 'store' | 'dispatch' | 'subscribe' | 'close'> & Partial<Pick<MoodcodeEngine, 'backup'>>;
export interface UtilityWorkerOptions {
  emit(push: WorkerPush): void;
  createEngine?: (options: EngineOptions) => WorkerEngine;
}
interface Subscription {
  id: string; ownerId: string; sessionId: string; abort: AbortController; task: Promise<void>;
  lastSeq: number; timer?: ReturnType<typeof setTimeout>; pending?: DesktopUpdate;
  finished?: boolean;
}

function invalid(message = 'Worker request is invalid.'): never { throw new EngineError('INVALID_INPUT', message); }
function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) invalid();
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) invalid('Worker request contains an unsupported field.');
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !property.enumerable || !('value' in property)) invalid();
    output[key] = property.value;
  }
  return output;
}
function text(value: unknown, name: string, maximum = 256, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value) > maximum) invalid(`${name} must be a bounded string without control characters.`);
  return value;
}
function boundedJson(value: unknown): void {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (++nodes > WORKER_LIMITS.maxNodes || depth > WORKER_LIMITS.maxDepth) throw new EngineError('REQUEST_TOO_LARGE', 'Worker request exceeds its size limit.');
    if (typeof item === 'string') bytes += Buffer.byteLength(item) + 2;
    else if (item === null || typeof item === 'boolean') bytes += 5;
    else if (typeof item === 'number' && Number.isFinite(item)) bytes += 32;
    else if (typeof item === 'object') {
      if (ancestors.has(item)) invalid('Worker request must not contain cycles.');
      ancestors.add(item);
      const prototype = Object.getPrototypeOf(item);
      if (Array.isArray(item)) {
        if (item.length > WORKER_LIMITS.maxNodes) throw new EngineError('REQUEST_TOO_LARGE', 'Worker request exceeds its size limit.');
        for (let index = 0; index < item.length; index++) {
          const property = Object.getOwnPropertyDescriptor(item, String(index));
          if (!property || !('value' in property)) invalid();
          visit(property.value, depth + 1);
        }
      } else {
        if (prototype !== null && prototype !== Object.prototype) invalid();
        for (const key of Reflect.ownKeys(item)) {
          if (typeof key !== 'string') invalid();
          bytes += Buffer.byteLength(key) + 4;
          const property = Object.getOwnPropertyDescriptor(item, key);
          if (!property || !property.enumerable || !('value' in property)) invalid();
          visit(property.value, depth + 1);
        }
      }
      ancestors.delete(item);
    } else invalid('Worker request must contain only JSON values.');
    if (bytes > WORKER_LIMITS.maxRequestBytes) throw new EngineError('REQUEST_TOO_LARGE', 'Worker request exceeds its size limit.');
  }
  visit(value, 0);
}

function config(value: unknown, scenario?: 'coding' | 'slow' | 'advanced' | 'account'): WorkerEngineConfig {
  const source = record(value, ['providerId', 'modelId', 'baseURL', 'apiKey', 'reasoningEffort']);
  if (source.providerId !== 'scripted' && source.providerId !== 'openai-compatible' && source.providerId !== 'openai-responses' && source.providerId !== 'codex') {
    throw new EngineError('INVALID_CONFIG', 'Desktop provider is not supported.');
  }
  if (scenario) return { providerId: 'scripted', modelId: `desktop-${scenario}-fixture`, baseURL: '' };
  const reasoningEffort = source.reasoningEffort;
  if (reasoningEffort !== undefined && (!REASONING_EFFORTS.includes(reasoningEffort as never) || !['codex','openai-responses'].includes(String(source.providerId)))) throw new EngineError('INVALID_CONFIG', 'Provider reasoning effort is invalid.');
  const modelId = text(source.modelId, 'modelId');
  const baseURL = text(source.baseURL, 'baseURL', 4096, source.providerId === 'scripted' || source.providerId === 'codex');
  let apiKey: string | undefined;
  if (Object.hasOwn(source, 'apiKey')) {
    if (typeof source.apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(source.apiKey)) {
      throw new EngineError('INVALID_CONFIG', 'Provider credential must be a nonempty printable bearer token.');
    }
    apiKey = source.apiKey;
  }
  if (source.providerId === 'codex') {
    if (apiKey || baseURL !== '') throw new EngineError('INVALID_CONFIG', 'Codex uses its local authenticated session and a fixed trusted endpoint.');
    return { providerId: 'codex', modelId, baseURL: '', ...(reasoningEffort ? { reasoningEffort: reasoningEffort as import('@moodcode/contracts').ReasoningEffort } : {}) };
  }
  if (source.providerId !== 'scripted') {
    if (!apiKey) throw new EngineError('API_KEY_MISSING', 'The selected remote provider requires an API key.');
    let url: URL;
    try { url = new URL(baseURL); } catch { throw new EngineError('INVALID_CONFIG', 'Provider base URL is invalid.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new EngineError('INVALID_CONFIG', 'Provider base URL must be HTTP or HTTPS without credentials, query, or fragment.');
    }
    if (baseURL.includes(apiKey) || modelId.includes(apiKey)) throw new EngineError('INVALID_CONFIG', 'Provider metadata must not contain its credential.');
  }
  return { providerId: source.providerId, modelId, baseURL, ...(apiKey ? { apiKey } : {}), ...(reasoningEffort ? { reasoningEffort: reasoningEffort as import('@moodcode/contracts').ReasoningEffort } : {}) };
}
function startPayload(value: unknown): WorkerStartPayload {
  const source = record(value, ['dbPath', 'artifactDir', 'config', 'testScenario']);
  const dbPath = text(source.dbPath, 'dbPath', 4096);
  const artifactDir = text(source.artifactDir, 'artifactDir', 4096);
  if ((dbPath !== ':memory:' && !isAbsolute(dbPath)) || !isAbsolute(artifactDir)) throw new EngineError('INVALID_CONFIG', 'Engine storage paths must be absolute.');
  if (source.testScenario !== undefined && source.testScenario !== 'coding' && source.testScenario !== 'slow' && source.testScenario !== 'advanced' && source.testScenario !== 'account') invalid('Unknown desktop test scenario.');
  const resolved = config(source.config, source.testScenario);
  return { dbPath, artifactDir, config: resolved, ...(source.testScenario ? { testScenario: source.testScenario } : {}) };
}
function selectedProvider(payload: WorkerStartPayload): ProviderAdapter {
  if (payload.testScenario) return testFixtureProvider(payload.testScenario);
  switch (payload.config.providerId) {
    case 'scripted': return new ScriptedProvider();
    case 'openai-compatible': return new OpenAICompatibleProvider(payload.config);
    case 'openai-responses': return new ResponsesProvider(payload.config);
    case 'codex': return new CodexProvider();
  }
}

/** Engine and SQLite ownership never leave this utility worker. */
export class UtilityWorker {
  readonly #options: UtilityWorkerOptions;
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #ownerValidations = new Map<string, { pending: number; revision: number }>();
  readonly #commands = new Set<Promise<unknown>>();
  #engine?: WorkerEngine;
  #advanced?: AdvancedService;
  #closing = false;
  #closePromise?: Promise<void>;
  #secrets: string[] = [];
  constructor(options: UtilityWorkerOptions) { this.#options = options; }
  get subscriptionCount(): number { return this.#subscriptions.size; }

  async handle(value: unknown): Promise<WorkerResponse> {
    let id = '';
    try {
      const request = record(value, ['id', 'type', 'payload']);
      id = text(request.id, 'request.id');
      boundedJson({ id: request.id, type: request.type, ...(request.payload !== undefined ? { payload: request.payload } : {}) });
      if (typeof request.type !== 'string' || !TYPES.has(request.type)) invalid('Unknown worker request type.');
      if (request.type === 'close') {
        if (request.payload !== undefined) record(request.payload, []);
        await this.close();
        return { id, ok: true };
      }
      if (this.#closing) throw new EngineError('ENGINE_CLOSED', 'Desktop engine is closing.');
      let result: unknown;
      switch (request.type) {
        case 'start': {
          if (this.#engine) throw new EngineError('ENGINE_BUSY', 'Desktop engine has already started.');
          const payload = startPayload(request.payload);
          this.#secrets = payload.config.apiKey ? [payload.config.apiKey] : [];
          const provider = selectedProvider(payload);
          this.#engine = (this.#options.createEngine ?? createEngine)({
            dbPath: payload.dbPath, artifactDir: payload.artifactDir, providers: [provider],
            defaults: { providerId: payload.config.providerId, modelId: payload.config.modelId, ...(payload.config.reasoningEffort ? { reasoningEffort: payload.config.reasoningEffort } : {}) },
            teams: true, teamModelTools: true, residentTeams: true, workflows: true, jobs: true, diagnosticObservations: true,
          });
          if ('dispatchSession' in this.#engine) this.#advanced = new AdvancedService(this.#engine as MoodcodeEngine);
          try { result = await this.#tracked(() => this.#bootstrap()); }
          catch (error) { await this.#engine.close(); this.#engine = undefined; throw error; }
          break;
        }
        case 'diagnostics':
        case 'recover': {
          if (this.#engine) throw new EngineError('ENGINE_BUSY', 'Recovery uses a separate worker without an active engine.');
          const input = record(request.payload, request.type === 'recover' ? ['dbPath','artifactDir','fingerprint','acknowledged'] : ['dbPath','artifactDir']);
          const dbPath = text(input.dbPath, 'dbPath', 4096), artifactDir = text(input.artifactDir, 'artifactDir', 4096);
          if (!isAbsolute(dbPath) || !isAbsolute(artifactDir)) invalid();
          if (request.type === 'recover') {
            const fingerprint = text(input.fingerprint, 'fingerprint', 64);
            if (!/^[a-f0-9]{64}$/.test(fingerprint) || input.acknowledged !== true) invalid();
            result = await this.#tracked(() => recoverEngine({ dbPath, artifactDir, fingerprint, acknowledged: true }));
          } else result = await this.#tracked(() => getRecoveryStatus({ dbPath, artifactDir }));
          break;
        }
        case 'backup': {
          const input = record(request.payload, ['destination']);
          const destination = text(input.destination, 'destination', 4096);
          if (!isAbsolute(destination)) invalid();
          result = await this.#tracked(async () => { this.#assertIdle(); const engine = this.#ready(); if (!engine.backup) throw new EngineError('BACKUP_UNAVAILABLE', 'Database backup is unavailable.'); const backup = await engine.backup(destination); return { bytes: backup.bytes }; });
          break;
        }
        case 'bootstrap':
          if (request.payload !== undefined) record(request.payload, []);
          result = await this.#tracked(() => this.#bootstrap());
          break;
        case 'command':
          result = await this.#tracked(() => this.#ready().dispatch(request.payload));
          break;
        case 'advanced': {
          const input = record(request.payload, ['ownerId','input']);
          if (!this.#advanced) throw new EngineError('ENGINE_NOT_READY', 'Advanced engine APIs are unavailable.');
          const ownerId = text(input.ownerId, 'ownerId'), action = validateAdvancedAction(input.input);
          result = await this.#tracked(() => this.#advanced!.action(ownerId, action));
          break;
        }
        case 'advancedSnapshot': {
          const input = record(request.payload, ['sessionId']);
          if (!this.#advanced) throw new EngineError('ENGINE_NOT_READY', 'Advanced engine APIs are unavailable.');
          const sessionId = text(input.sessionId, 'sessionId');
          result = await this.#tracked(() => this.#advanced!.snapshot(sessionId));
          break;
        }
        case 'subscribe': {
          const input = record(request.payload, ['ownerId', 'sessionId', 'afterSeq']);
          const ownerId = text(input.ownerId, 'ownerId');
          const sessionId = text(input.sessionId, 'sessionId');
          const afterSeq = input.afterSeq;
          if (typeof afterSeq !== 'number' || !Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new EngineError('INVALID_CURSOR', 'afterSeq must be a non-negative safe integer.');
          result = await this.#tracked(() => this.#subscribe(ownerId, sessionId, afterSeq));
          break;
        }
        case 'unsubscribe': {
          const input = record(request.payload, ['ownerId', 'subscriptionId']);
          const ownerId = text(input.ownerId, 'ownerId');
          const subscriptionId = text(input.subscriptionId, 'subscriptionId');
          const subscription = this.#subscriptions.get(subscriptionId);
          if (subscription && subscription.ownerId !== ownerId) throw new EngineError('SUBSCRIPTION_FORBIDDEN', 'Subscription belongs to another renderer.');
          if (subscription) await this.#removeSubscription(subscription);
          break;
        }
        case 'dropOwner': {
          const input = record(request.payload, ['ownerId']);
          const ownerId = text(input.ownerId, 'ownerId');
          const validation = this.#ownerValidations.get(ownerId);
          if (validation) validation.revision++;
          await this.#advanced?.dropOwner(ownerId);
          await Promise.all([...this.#subscriptions.values()].filter(subscription => subscription.ownerId === ownerId).map(subscription => this.#removeSubscription(subscription)));
          break;
        }
        case 'assertIdle':
          if (request.payload !== undefined) record(request.payload, []);
          await this.#tracked(() => this.#assertIdle());
          break;
      }
      return this.#redact({ id, ok: true, ...(result !== undefined ? { result } : {}) }) as WorkerResponse;
    } catch (error) {
      return { id, ok: false, error: this.#publicError(error) };
    }
  }

  #ready(): WorkerEngine {
    if (!this.#engine) throw new EngineError('ENGINE_NOT_READY', 'Desktop engine has not started.');
    return this.#engine;
  }
  async #tracked<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.#commands.size >= WORKER_LIMITS.maxInflightCommands) throw new EngineError('ENGINE_BUSY', 'Desktop engine has too many pending commands.');
    const task = Promise.resolve().then(operation);
    this.#commands.add(task);
    try { return await task; }
    finally { this.#commands.delete(task); }
  }
  async #bootstrap(): Promise<WorkerBootstrap> {
    const engine = this.#ready();
    const result = await engine.dispatch({ schemaVersion: SCHEMA_VERSION, commandId: randomUUID(), type: 'engine.getCapabilities', payload: {} });
    if (!result.ok) throw new EngineError(result.error?.code ?? 'ENGINE_NOT_READY', result.error?.message ?? 'Engine capabilities are unavailable.');
    return { workspaces: engine.store.listWorkspaces(), capabilities: result.result as unknown as EngineCapabilities };
  }
  #assertIdle(): void {
    const engine = this.#ready();
    for (const workspace of engine.store.listWorkspaces()) {
      for (const session of engine.store.listSessions(workspace.id)) {
        if (engine.store.getSnapshot(session.id).runs.some(run => !isTerminal(run.state))) {
          throw new EngineError('WORKSPACE_BUSY', 'An active Run must finish or be cancelled before changing engine settings.');
        }
      }
    }
  }
  async #subscribe(ownerId: string, sessionId: string, afterSeq: number): Promise<string> {
    const engine = this.#ready();
    if (this.#subscriptions.size >= WORKER_LIMITS.maxSubscriptions
      || [...this.#subscriptions.values()].filter(subscription => subscription.ownerId === ownerId).length >= WORKER_LIMITS.maxOwnerSubscriptions) {
      throw new EngineError('SUBSCRIPTION_LIMIT', 'Desktop subscription limit reached.');
    }
    let owner = this.#ownerValidations.get(ownerId);
    if (!owner) { owner = { pending: 0, revision: 0 }; this.#ownerValidations.set(ownerId, owner); }
    owner.pending++;
    const revision = owner.revision;
    try {
      const validation = await engine.dispatch({ schemaVersion: SCHEMA_VERSION, commandId: randomUUID(), type: 'events.subscribe', payload: { sessionId, afterSeq } });
      if (!validation.ok) throw new EngineError(validation.error?.code ?? 'INVALID_INPUT', validation.error?.message ?? 'Subscription is invalid.');
      if (this.#closing) throw new EngineError('ENGINE_CLOSED', 'Desktop engine is closing.');
      if (revision !== owner.revision) throw new EngineError('SUBSCRIPTION_DROPPED', 'Renderer detached while its subscription was being created.');
      // Recheck after asynchronous validation so concurrent subscriptions cannot exceed the cap.
      if (this.#subscriptions.size >= WORKER_LIMITS.maxSubscriptions
        || [...this.#subscriptions.values()].filter(subscription => subscription.ownerId === ownerId).length >= WORKER_LIMITS.maxOwnerSubscriptions) {
        throw new EngineError('SUBSCRIPTION_LIMIT', 'Desktop subscription limit reached.');
      }
      const subscription: Subscription = { id: randomUUID(), ownerId, sessionId, lastSeq: afterSeq, abort: new AbortController(), task: Promise.resolve() };
      this.#subscriptions.set(subscription.id, subscription);
      subscription.task = this.#pump(subscription, engine);
      return subscription.id;
    } finally {
      owner.pending--;
      if (owner.pending === 0) this.#ownerValidations.delete(ownerId);
    }
  }
  async #pump(subscription: Subscription, engine: WorkerEngine): Promise<void> {
    try {
      for await (const event of engine.subscribe(subscription.sessionId, subscription.lastSeq, subscription.abort.signal)) {
        if (subscription.abort.signal.aborted) break;
        subscription.lastSeq = Math.max(subscription.lastSeq, event.seq);
        this.#queueUpdate(subscription, { subscriptionId: subscription.id, sessionId: subscription.sessionId, lastSeq: subscription.lastSeq });
      }
    } catch (error) {
      if (!subscription.abort.signal.aborted) {
        this.#queueUpdate(subscription, { subscriptionId: subscription.id, sessionId: subscription.sessionId, lastSeq: subscription.lastSeq, error: this.#publicError(error) });
      }
    } finally {
      if (subscription.abort.signal.aborted) this.#clearUpdate(subscription);
      else {
        subscription.finished = true;
        if (!subscription.pending) this.#subscriptions.delete(subscription.id);
      }
    }
  }
  #queueUpdate(subscription: Subscription, update: DesktopUpdate): void {
    subscription.pending = update;
    if (subscription.timer) return;
    subscription.timer = setTimeout(() => {
      subscription.timer = undefined;
      const pending = subscription.pending;
      subscription.pending = undefined;
      if (!pending || subscription.abort.signal.aborted || this.#closing) return;
      try { this.#options.emit({ type: 'update', ownerId: subscription.ownerId, update: pending }); }
      catch { void this.#removeSubscription(subscription); }
      if (pending.error || subscription.finished) void this.#removeSubscription(subscription);
    }, WORKER_LIMITS.invalidationDelayMs);
    subscription.timer.unref();
  }
  #clearUpdate(subscription: Subscription): void {
    if (subscription.timer) clearTimeout(subscription.timer);
    subscription.timer = undefined;
    subscription.pending = undefined;
  }
  async #removeSubscription(subscription: Subscription): Promise<void> {
    this.#subscriptions.delete(subscription.id);
    this.#clearUpdate(subscription);
    subscription.abort.abort();
    await subscription.task;
  }
  #publicError(error: unknown): { code: string; message: string } {
    const known = error instanceof EngineError;
    const code = known && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
      && !this.#secrets.some(secret => error.code.includes(secret)) ? error.code : 'INTERNAL_ERROR';
    const message = known ? this.#redactString(error.message).replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 1024) : 'Unexpected desktop engine error.';
    return { code, message };
  }
  #redactString(value: string): string {
    for (const secret of this.#secrets) value = value.split(secret).join('[REDACTED]');
    return value;
  }
  #redact(value: unknown): unknown {
    if (typeof value === 'string') return this.#redactString(value);
    if (Array.isArray(value)) return value.map(item => this.#redact(item));
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(value)) result[this.#redactString(key)] = this.#redact(item);
      return result;
    }
    return value;
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    const subscriptions = [...this.#subscriptions.values()];
    for (const subscription of subscriptions) { subscription.abort.abort(); this.#clearUpdate(subscription); }
    this.#subscriptions.clear();
    this.#closePromise = (async () => {
      await this.#advanced?.close();
      await Promise.allSettled([...this.#commands]);
      try { await this.#engine?.close(); }
      finally { await Promise.allSettled(subscriptions.map(subscription => subscription.task)); }
    })();
    return this.#closePromise;
  }
}
