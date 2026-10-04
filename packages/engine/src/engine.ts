import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EngineError, isTerminal, SCHEMA_VERSION, type CommandEnvelope, type CommandResult, type EngineCapabilities, type EngineEvent, type JsonValue, type Run, type RunConfig, type RunConfigInput, type Session } from '@moodcode/contracts';
import { normalizeSubmitInput, validateCommand } from '@moodcode/contracts/validation';
import type { ProviderAdapter, ToolDefinition } from './ports.js';
import { SqliteStore, type DatabaseBackup, type IntegrityCheckResult, type StoreBackupOptions } from './storage/index.js';
import { RunCoordinator } from './runner/index.js';
import { ScriptedProvider } from './provider/index.js';
import { ApprovalManager } from './permission/index.js';
import { openWorkspace } from './workspace/index.js';
import { getWorkspaceStatus, listWorkspaceFiles, readWorkspaceFile } from './workspace/presentation.js';
import { buildContext } from './context/index.js';
import { createReadTools } from './tools/read/index.js';
import { createPatchTool } from './tools/patch/index.js';
import { createCommandTool } from './tools/command/index.js';
import { assertExecutionLockAvailable } from './tools/command/execution-lock.js';
import { getReviewDiff, previewRestoreCheckpoint, restoreCheckpoint, type RestoreResult } from './review/index.js';
import { readRecoveryAcknowledgments, isRestoreAcknowledged } from './recovery/index.js';
import { ReviewJournal, type RestoreOperation, type RestoreOperationInput } from './review/audit.js';

export type RestoreCommandResult = RestoreResult & {
  operationId: string;
  duplicate: boolean;
  recordMetadataError?: { code: string; message: string };
};

export interface ReviewHistoryResult {
  runId: string;
  operations: RestoreOperation[];
}

function metadataFailure(): { code: string; message: string } {
  return { code: 'REVIEW_RECORD_FAILED', message: 'Restoration outcome could not be recorded; reconcile the quarantined workspace before further effects' };
}

export interface EngineOptions {
  dbPath: string;
  artifactDir?: string;
  providers?: ProviderAdapter[];
  tools?: ToolDefinition[];
  defaults?: RunConfigInput;
}
function json(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return null;
  return JSON.parse(encoded) as JsonValue;
}

function verifyExecutionIdle(lockPath: string): void {
  try {
    assertExecutionLockAvailable(lockPath);
  } catch (error) {
    if (error instanceof EngineError && error.code === 'COMMAND_EFFECTS_BUSY') {
      throw new EngineError('CLEANUP_PENDING', 'A command supervisor is still cleaning up a previous engine execution; reopen after cleanup');
    }
    throw error;
  }
}

export class MoodcodeEngine {
  readonly store: SqliteStore;
  readonly coordinator: RunCoordinator;
  readonly approvals: ApprovalManager;
  readonly reviewJournal: ReviewJournal;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly defaults: RunConfig;
  private readonly capabilities: EngineCapabilities;
  private readonly executionLockPath: string;
  private readonly restoreRequests = new Map<string, { binding: RestoreOperationInput; promise: Promise<RestoreCommandResult> }>();

  constructor(options: EngineOptions) {
    if (!options || typeof options.dbPath !== 'string' || options.dbPath.length === 0) {
      throw new EngineError('INVALID_CONFIG', 'dbPath must be a non-empty string');
    }
    this.defaults = normalizeSubmitInput({ sessionId: 'defaults', requestId: 'defaults', prompt: 'defaults', config: options.defaults ?? {} }).config;
    const dbPath = options.dbPath === ':memory:' ? options.dbPath : resolve(options.dbPath);
    const artifactDir = options.artifactDir !== undefined ? resolve(options.artifactDir)
      : dbPath === ':memory:' ? mkdtempSync(join(tmpdir(), 'moodcode-memory-artifacts-')) : resolve(`${options.dbPath}.artifacts`);
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    this.store = new SqliteStore(dbPath);
    let reviewJournal: ReviewJournal | undefined;
    try {
      const canonicalDbPath = dbPath === ':memory:' ? undefined : realpathSync(dbPath);
      this.executionLockPath = canonicalDbPath === undefined ? resolve(artifactDir, 'effects.sqlite') : `${canonicalDbPath}.effects.sqlite`;
      verifyExecutionIdle(this.executionLockPath);
      reviewJournal = new ReviewJournal(canonicalDbPath === undefined ? resolve(artifactDir, 'review.sqlite') : `${canonicalDbPath}.review.sqlite`);
      this.reviewJournal = reviewJournal;
      this.store.recoverInterrupted();
      this.approvals = new ApprovalManager(this.store);
      const providers = new Map<string, ProviderAdapter>([['scripted', new ScriptedProvider()]]);
      for (const provider of options.providers ?? []) providers.set(provider.id, provider);
      const tools = options.tools ?? [...createReadTools(), createPatchTool(), createCommandTool()];
      this.capabilities = {
        schemaVersion: SCHEMA_VERSION,
        runtime: { node: process.versions.node, electron: process.versions.electron ?? null, platform: process.platform, commandExecution: process.platform === 'win32' ? 'unsupported' : 'posix-process-group' },
        providerIds: [...providers.keys()].sort(),
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: structuredClone(inputSchema) })),
        modes: ['plan', 'build'], defaults: structuredClone(this.defaults),
        features: { historyPaging: true, sessionMetrics: true },
      };
      this.coordinator = new RunCoordinator({
        store: this.store,
        providers,
        tools,
        approvals: this.approvals,
        artifactDir,
        executionLockPath: this.executionLockPath,
        buildContext,
      });
      const recoveredRestores = this.reviewJournal.recoverPending();
      const recoveryAcknowledgments = canonicalDbPath ? readRecoveryAcknowledgments({ dbPath: canonicalDbPath, artifactDir: realpathSync(artifactDir) }) : [];
      for (const operation of recoveredRestores) {
        const run = this.store.getRun(operation.runId);
        if (run.workspaceId !== operation.workspaceId || run.sessionId !== operation.sessionId
          || !this.store.listCheckpoints(run.id).some((checkpoint) => checkpoint.id === operation.checkpointId && checkpoint.runId === run.id)) {
          throw new EngineError('REVIEW_OPERATION_BINDING_MISMATCH', 'Interrupted restoration does not match the primary run and checkpoint');
        }
        if (!isRestoreAcknowledged(operation, recoveryAcknowledgments)) this.coordinator.quarantineWorkspace(operation.workspaceId);
      }
    } catch (error) {
      try { reviewJournal?.close(); }
      finally { this.store.close(); }
      throw error;
    }
  }

  async dispatch(value: CommandEnvelope | unknown): Promise<CommandResult> {
    let commandId = '';
    try {
      const command = validateCommand(value, this.defaults);
      commandId = command.commandId;
      if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
      const payload = command.payload;
      let result: unknown;
      switch (command.type) {
        case 'engine.getCapabilities':
          result = this.capabilities;
          break;
        case 'workspace.open': {
          const workspace = await openWorkspace(payload.path as string);
          result = this.store.putWorkspace(workspace);
          break;
        }
        case 'workspace.getStatus':
          result = await getWorkspaceStatus(this.store.getWorkspace(payload.workspaceId as string));
          break;
        case 'file.list':
          result = await listWorkspaceFiles(this.store.getWorkspace(payload.workspaceId as string), payload.path as string | undefined, { ...(payload.limit === undefined ? {} : { limit: payload.limit as number }), ...(payload.continuation === undefined ? {} : { continuation: payload.continuation as string }) });
          break;
        case 'file.read':
          result = await readWorkspaceFile(this.store.getWorkspace(payload.workspaceId as string), payload.path as string);
          break;
        case 'session.create': {
          const workspaceId = payload.workspaceId as string;
          this.store.getWorkspace(workspaceId);
          const session: Session = { id: randomUUID(), workspaceId, title: (payload.title as string | undefined) ?? 'New session', createdAt: new Date().toISOString() };
          result = this.store.createSession(session);
          break;
        }
        case 'session.list': {
          this.store.getWorkspace(payload.workspaceId as string);
          result = this.store.listSessions(payload.workspaceId as string);
          break;
        }
        case 'session.getSnapshot':
          result = this.store.getSnapshot(payload.sessionId as string);
          break;
        case 'session.getHistory':
          result = this.store.getHistory(payload.sessionId as string, payload.beforeRunId as string | undefined, payload.limit as number | undefined);
          break;
        case 'session.getMetrics':
          result = this.store.getMetrics(payload.sessionId as string);
          break;
        case 'run.submit':
          result = this.coordinator.submit(normalizeSubmitInput(payload));
          break;
        case 'run.cancel':
          result = this.coordinator.cancel(payload.runId as string);
          break;
        case 'approval.decide':
          result = this.approvals.decide(payload.approvalId as string, payload.decision as 'allow' | 'deny', payload.fingerprint as string);
          break;
        case 'review.getDiff':
          result = await getReviewDiff(this.store, payload.runId as string);
          break;
        case 'review.previewRestore': {
          const run = this.restoreRun(payload.runId as string, payload.checkpointId as string);
          result = await previewRestoreCheckpoint(this.store, this.store.getWorkspace(run.workspaceId), payload.checkpointId as string, { executionLockPath: this.executionLockPath });
          break;
        }
        case 'review.restore':
          result = await this.restore(command.commandId, payload.runId as string, payload.checkpointId as string, payload.previewFingerprint as string);
          break;
        case 'review.history': {
          const run = this.store.getRun(payload.runId as string);
          result = { runId: run.id, operations: this.reviewJournal.list(run.id) } satisfies ReviewHistoryResult;
          break;
        }
        case 'events.subscribe':
          this.store.getSession(payload.sessionId as string);
          result = { sessionId: payload.sessionId, afterSeq: payload.afterSeq ?? 0 };
          break;
        default:
          throw new EngineError('UNKNOWN_COMMAND', 'Unknown engine command');
      }
      return { schemaVersion: SCHEMA_VERSION, commandId, ok: true, result: json(result) };
    } catch (error) {
      if (!commandId && value && typeof value === 'object') {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(value, 'commandId');
          if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
            && descriptor.value.trim().length > 0 && descriptor.value.length <= 256
            && !/[\u0000-\u001f\u007f]/u.test(descriptor.value)
            && Buffer.byteLength(descriptor.value) <= 256) commandId = descriptor.value;
        } catch { /* Invalid object traps must not escape the command result boundary. */ }
      }
      return {
        schemaVersion: SCHEMA_VERSION,
        commandId,
        ok: false,
        error: error instanceof EngineError ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } : { code: 'INTERNAL_ERROR', message: 'Unexpected engine error' },
      };
    }
  }

  private restoreRun(runId: string, checkpointId: string): Run {
    const run = this.store.getRun(runId);
    if (!this.store.listCheckpoints(runId).some((checkpoint) => checkpoint.id === checkpointId && checkpoint.runId === runId)) {
      throw new EngineError('CHECKPOINT_RUN_MISMATCH', 'Checkpoint does not belong to the requested run');
    }
    return run;
  }

  private restoreReply(operation: RestoreOperation): RestoreCommandResult {
    if (operation.state === 'completed' && operation.result) return { ...operation.result, operationId: operation.id, duplicate: true };
    if (operation.state === 'started') throw new EngineError('RESTORE_PENDING', 'Restoration has already started and has no recorded final outcome; effects will not be replayed');
    if (operation.error) throw new EngineError(operation.error.code, operation.error.message);
    throw new EngineError('RESTORE_INTERRUPTED', 'Restoration has no confirmed outcome; effects will not be replayed');
  }

  private restore(commandId: string, runId: string, checkpointId: string, fingerprint: string): Promise<RestoreCommandResult> {
    const sameRequest = (binding: RestoreOperationInput): boolean => binding.runId === runId && binding.checkpointId === checkpointId && binding.fingerprint === fingerprint;
    const conflict = (): never => { throw new EngineError('REVIEW_JOURNAL_OPERATION_CONFLICT', 'Operation ID is already bound to a different restore request'); };
    const inFlight = this.restoreRequests.get(commandId);
    if (inFlight) {
      if (!sameRequest(inFlight.binding)) conflict();
      return inFlight.promise.then((result) => ({ ...result, duplicate: true }));
    }
    const existing = this.reviewJournal.get(commandId);
    if (existing) {
      if (!sameRequest(existing)) conflict();
      const recordedRun = this.restoreRun(runId, checkpointId);
      if (existing.sessionId !== recordedRun.sessionId || existing.workspaceId !== recordedRun.workspaceId) conflict();
      return Promise.resolve(this.restoreReply(existing));
    }
    const run = this.restoreRun(runId, checkpointId);
    if (!isTerminal(run.state)) throw new EngineError('RUN_NOT_TERMINAL', 'An active run cannot be restored');
    const workspace = this.store.getWorkspace(run.workspaceId);
    const binding: RestoreOperationInput = { id: commandId, runId, checkpointId, fingerprint, sessionId: run.sessionId, workspaceId: run.workspaceId };
    let observed: RestoreCommandResult | undefined;
    const lease = this.coordinator.withWorkspaceLease(workspace.id, async (signal) => {
      // All audit writes stay inside the lease so close cannot release either
      // SQLite connection while a restoration is still recording its outcome.
      try {
        // The public journal may have been updated after synchronous dispatch
        // admission but before this microtask. Never execute a known operation.
        const previous = this.reviewJournal.get(commandId);
        if (previous) {
          if ((Object.keys(binding) as (keyof RestoreOperationInput)[]).some((key) => previous[key] !== binding[key])) conflict();
          observed = this.restoreReply(previous);
          return observed;
        }
        this.reviewJournal.start(binding);
      }
      catch (error) {
        if (error instanceof EngineError) throw error;
        throw new EngineError('REVIEW_RECORD_FAILED', 'Restoration could not start because audit recording failed');
      }
      let restored: RestoreResult;
      try { restored = await restoreCheckpoint(this.store, workspace, checkpointId, { signal, executionLockPath: this.executionLockPath, previewFingerprint: fingerprint }); }
      catch (error) {
        const failure = error instanceof EngineError ? error : new EngineError('RESTORE_FAILED', 'Checkpoint restoration failed');
        try { this.reviewJournal.finish(commandId, { error: { code: failure.code, message: failure.message } }); }
        catch {
          this.coordinator.quarantineWorkspace(workspace.id);
          throw new EngineError(failure.code, failure.message, { ...(failure.details ?? {}), recordMetadataError: metadataFailure() });
        }
        throw failure;
      }
      observed = { ...restored, operationId: commandId, duplicate: false };
      if (restored.effectsUncertain || restored.executionBlocked) this.coordinator.quarantineWorkspace(workspace.id);
      try { this.reviewJournal.finish(commandId, restored); }
      catch {
        this.coordinator.quarantineWorkspace(workspace.id);
        observed.recordMetadataError = metadataFailure();
        observed.warnings = [...observed.warnings, observed.recordMetadataError.message];
      }
      return observed;
    });
    const pending = lease.catch((error: unknown) => {
      // A returned service result retains its observed partial effects even
      // when the coordinator refuses to claim confirmed cleanup.
      if (observed && error instanceof EngineError && error.code === 'CLEANUP_UNCERTAIN') return observed;
      throw error;
    }).finally(() => { this.restoreRequests.delete(commandId); });
    this.restoreRequests.set(commandId, { binding, promise: pending });
    void pending.catch(() => {});
    return pending;
  }

  subscribe(sessionId: string, afterSeq = 0, signal?: AbortSignal): AsyncIterable<EngineEvent> {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new EngineError('INVALID_CURSOR', 'afterSeq must be a non-negative safe integer');
    return this.store.subscribe(sessionId, afterSeq, signal);
  }

  waitForRun(runId: string): Promise<Run> { return this.coordinator.waitForRun(runId); }

  integrityCheck(): IntegrityCheckResult {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.integrityCheck();
  }

  backup(destination: string, options?: StoreBackupOptions): Promise<DatabaseBackup> {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    return this.store.backup(destination, options);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.closePromise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void (async () => {
      try { await this.coordinator.close(); }
      finally {
        try { this.reviewJournal.close(); }
        finally { await this.store.closeAsync(); }
      }
    })().then(resolve, reject);
    return this.closePromise;
  }
}

export function createEngine(options: EngineOptions): MoodcodeEngine { return new MoodcodeEngine(options); }
