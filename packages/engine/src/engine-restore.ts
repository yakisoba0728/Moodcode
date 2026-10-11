import { createHash } from 'node:crypto';
import { EngineError, isTerminal, type Run } from '@moodcode/contracts';
import type { SqliteStore } from './storage/index.js';
import type { EngineRuntime } from './engine-runtime.js';
import type { WorkspaceLanguageSync } from './engine-language-sync.js';
import type { WorkspaceChangeHub } from './workspace/changes.js';
import { previewRestoreCheckpoint, restoreCheckpoint, type RestoreResult } from './review/index.js';
import { isRestoreAcknowledged, readRecoveryAcknowledgments } from './recovery/index.js';
import type { ReviewJournal, RestoreOperation, RestoreOperationInput } from './review/audit.js';

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

/** Checkpoint restoration with journal-backed idempotency: a recorded operation is answered, never replayed. */
export class EngineRestore {
  private readonly requests = new Map<string, { binding: RestoreOperationInput; promise: Promise<RestoreCommandResult> }>();

  constructor(private readonly store: SqliteStore, private readonly journal: ReviewJournal, private readonly engine: Pick<EngineRuntime, 'coordinator'>,
    private readonly sync: WorkspaceLanguageSync, private readonly changes: WorkspaceChangeHub, private readonly executionLockPath: string) {}

  /** Quarantines every workspace whose interrupted restoration the host has not acknowledged. */
  quarantineInterrupted(paths: { dbPath?: string; artifactDir: string }): void {
    const recoveredRestores = this.journal.recoverPending();
    const recoveryAcknowledgments = paths.dbPath ? readRecoveryAcknowledgments({ dbPath: paths.dbPath, artifactDir: paths.artifactDir }) : [];
    for (const operation of recoveredRestores) {
      const run = this.store.getRun(operation.runId);
      if (run.workspaceId !== operation.workspaceId || run.sessionId !== operation.sessionId
        || !this.store.listCheckpoints(run.id).some((checkpoint) => checkpoint.id === operation.checkpointId && checkpoint.runId === run.id)) {
        throw new EngineError('REVIEW_OPERATION_BINDING_MISMATCH', 'Interrupted restoration does not match the primary run and checkpoint');
      }
      if (!isRestoreAcknowledged(operation, recoveryAcknowledgments)) this.engine.coordinator.quarantineWorkspace(operation.workspaceId);
    }
  }

  preview(runId: string, checkpointId: string) {
    const run = this.restoreRun(runId, checkpointId);
    return previewRestoreCheckpoint(this.store, this.store.getWorkspace(run.workspaceId), checkpointId, { executionLockPath: this.executionLockPath });
  }

  history(runId: string): ReviewHistoryResult {
    const run = this.store.getRun(runId);
    return { runId: run.id, operations: this.journal.list(run.id) };
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

  restore(commandId: string, runId: string, checkpointId: string, fingerprint: string): Promise<RestoreCommandResult> {
    const sameRequest = (binding: RestoreOperationInput): boolean => binding.runId === runId && binding.checkpointId === checkpointId && binding.fingerprint === fingerprint;
    const conflict = (): never => { throw new EngineError('REVIEW_JOURNAL_OPERATION_CONFLICT', 'Operation ID is already bound to a different restore request'); };
    const inFlight = this.requests.get(commandId);
    if (inFlight) {
      if (!sameRequest(inFlight.binding)) conflict();
      return inFlight.promise.then((result) => ({ ...result, duplicate: true }));
    }
    const existing = this.journal.get(commandId);
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
    const lease = this.engine.coordinator.withWorkspaceLease(workspace.id, async (signal) => {
      // All audit writes stay inside the lease so close cannot release either
      // SQLite connection while a restoration is still recording its outcome.
      try {
        // The public journal may have been updated after synchronous dispatch
        // admission but before this microtask. Never execute a known operation.
        const previous = this.journal.get(commandId);
        if (previous) {
          if ((Object.keys(binding) as (keyof RestoreOperationInput)[]).some((key) => previous[key] !== binding[key])) conflict();
          observed = this.restoreReply(previous);
          return observed;
        }
        this.journal.start(binding);
      }
      catch (error) {
        if (error instanceof EngineError) throw error;
        throw new EngineError('REVIEW_RECORD_FAILED', 'Restoration could not start because audit recording failed');
      }
      let restored: RestoreResult;
      try { restored = await restoreCheckpoint(this.store, workspace, checkpointId, { signal, executionLockPath: this.executionLockPath, previewFingerprint: fingerprint }); }
      catch (error) {
        const failure = error instanceof EngineError ? error : new EngineError('RESTORE_FAILED', 'Checkpoint restoration failed');
        try { this.journal.finish(commandId, { error: { code: failure.code, message: failure.message } }); }
        catch {
          this.engine.coordinator.quarantineWorkspace(workspace.id);
          throw new EngineError(failure.code, failure.message, { ...(failure.details ?? {}), recordMetadataError: metadataFailure() });
        }
        throw failure;
      }
      observed = { ...restored, operationId: commandId, duplicate: false };
      if (restored.effectsUncertain || restored.executionBlocked) this.engine.coordinator.quarantineWorkspace(workspace.id);
      if (restored.restored.length) {
        const checkpoint = this.store.listCheckpoints(run.id).find(item => item.id === checkpointId)!;
        try {
          await this.sync.watch(workspace.id);
          const restoredPaths = new Set(restored.restored);
          const changes = await this.changes.recordCheckpoint({ workspace, sessionId: run.sessionId, runId: run.id, toolCallId: checkpoint.toolCallId, signal,
            checkpoints: [{ ...checkpoint, id: `restore_${createHash('sha256').update(commandId).digest('hex')}`, createdAt: new Date().toISOString(), files: checkpoint.files.filter(file => restoredPaths.has(file.path)).map(file => ({ ...file, before: file.after, after: file.before, beforeHash: file.afterHash, afterHash: file.beforeHash })) }] });
          await Promise.all(changes.map(change => this.sync.sync(change)));
        } catch { observed.warnings.push('Restoration effects were recorded, but workspace observation or language-service delivery could not be confirmed.'); }
      }
      try { this.journal.finish(commandId, restored); }
      catch {
        this.engine.coordinator.quarantineWorkspace(workspace.id);
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
    }).finally(() => { this.requests.delete(commandId); });
    this.requests.set(commandId, { binding, promise: pending });
    void pending.catch(() => {});
    return pending;
  }
}
