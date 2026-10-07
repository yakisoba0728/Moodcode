import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { EngineError, type ExecutionUncertainty, type TurnRecord } from '@moodcode/contracts';
import { validateTurnRecord } from '@moodcode/contracts/validation';
import type { SqliteStore } from './index.js';
import { canonical } from '../recovery/snapshot.js';
import { readEvidenceBody } from './evidence-read.js';

export const EXECUTION_UNCERTAINTY_LIMITS = Object.freeze({ maxTurns: 64, maxOwnerBytes: 1_048_576, maxSelectedTurnPayloadBytes: 8_388_608 });
type Dependency = NonNullable<ExecutionUncertainty['summaryDependency']>;
type Store = Pick<SqliteStore, 'getAttemptCleanup' | 'getSummaryAttempt' | 'getTurn' | 'getAttempt'>;
export function cleanupRecordSha256(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function mismatch(): never { throw new EngineError('SUMMARY_OVERFLOW_BINDING_MISMATCH', 'Summary uncertainty requires its exact failed ordinary attempt and confirmed cleanup'); }
function ownerProbe(db: DatabaseSync, table: 'session_turns' | 'provider_attempts', id: string) {
  const row = db.prepare(`SELECT id,session_id,run_id,state,length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE id=?`).get(id);
  if (!row || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 1 || Number(row.bytes) > EXECUTION_UNCERTAINTY_LIMITS.maxOwnerBytes) mismatch();
  return row;
}

/** Resolve only a new, observed overflow failure; never derive a dependency from an old uncertain state. */
export function summaryOverflowDependency(db: DatabaseSync, store: Store, summaryAttemptId: string, turnId: string, failedAttemptId: string): Dependency {
  const turnHeader = ownerProbe(db, 'session_turns', turnId), attemptHeader = ownerProbe(db, 'provider_attempts', failedAttemptId);
  const turn = store.getTurn(turnId), attempt = store.getAttempt(failedAttemptId);
  if (turn.id !== turnId || turn.sessionId !== turnHeader.session_id || turn.runId !== turnHeader.run_id || turn.state !== turnHeader.state
    || !['created','streaming','uncertain','interrupted'].includes(turn.state)
    || (turn.state === 'interrupted' && turn.uncertainty !== undefined)
    || attempt.id !== failedAttemptId || attempt.state !== 'failed' || attemptHeader.state !== 'failed'
    || attempt.sessionId !== turn.sessionId || attempt.runId !== turn.runId || attempt.turnId !== turn.id || attemptHeader.session_id !== turn.sessionId || attemptHeader.run_id !== turn.runId) mismatch();
  const latest = db.prepare('SELECT id FROM provider_attempts WHERE turn_id=? ORDER BY attempt_index DESC LIMIT 1').get(turnId);
  if (latest?.id !== failedAttemptId || db.prepare('SELECT 1 FROM message_parts WHERE turn_id=? LIMIT 1').get(turnId)) mismatch();
  const summary = store.getSummaryAttempt(summaryAttemptId, turn.sessionId), cleanup = store.getAttemptCleanup(failedAttemptId, turn.sessionId);
  if (summary.runId !== turn.runId || summary.currentTurnId !== turnId || summary.failedAttemptId !== failedAttemptId || summary.state !== 'uncertain'
    || summary.cleanupConfirmed || summary.publication !== 'discarded' || summary.providerId !== attempt.providerId || summary.modelId !== attempt.modelId
    || cleanup.state !== 'confirmed' || cleanup.cleanupConfirmed !== true || cleanup.method !== 'iterator-return-done' || cleanup.reason !== 'error'
    || cleanup.errorCode !== 'PROVIDER_CONTEXT_OVERFLOW' || cleanup.attemptId !== failedAttemptId || cleanup.turnId !== turnId
    || cleanup.sessionId !== turn.sessionId || cleanup.runId !== turn.runId || cleanup.workspaceId !== summary.workspaceId
    || cleanup.providerId !== attempt.providerId || cleanup.modelId !== attempt.modelId || cleanup.contextRevisionId !== attempt.contextRevisionId
    || !cleanup.settledAt || Date.parse(summary.createdAt) < Date.parse(cleanup.settledAt)) mismatch();
  return { summaryAttemptId, failedAttemptId, cleanupRecordSha256: cleanupRecordSha256(cleanup) };
}

/** Bounded persisted blockers remain effective across process restarts and other sessions. */
export function hasExecutionUncertainty(db: DatabaseSync, store: Store, workspaceId: string, options: {
  excludedSummaryAttemptId?: string;
  hasValidSummaryAcknowledgment?: (sessionId: string, summaryAttemptId: string) => boolean;
  hasValidProviderAcknowledgment?: (sessionId: string, attemptId: string) => boolean;
  hasUnacknowledgedProviders?: (workspaceId: string) => boolean;
} = {}): boolean {
  try {
    const validatedProviderIds = new Set<string>();
    if (db.prepare("SELECT 1 FROM provider_attempts a JOIN runs r ON r.id=a.run_id WHERE r.workspace_id=? AND a.state='uncertain' LIMIT 1").get(workspaceId)) {
      if (options.hasUnacknowledgedProviders?.(workspaceId) ?? !options.hasValidProviderAcknowledgment) return true;
      const attempts = db.prepare("SELECT a.id,a.session_id FROM provider_attempts a JOIN runs r ON r.id=a.run_id WHERE r.workspace_id=? AND a.state='uncertain' ORDER BY a.rowid LIMIT ?").all(workspaceId, EXECUTION_UNCERTAINTY_LIMITS.maxTurns + 1);
      if (attempts.length > EXECUTION_UNCERTAINTY_LIMITS.maxTurns) return true;
      for (const attempt of attempts) {
        if (!options.hasUnacknowledgedProviders && !options.hasValidProviderAcknowledgment?.(String(attempt.session_id), String(attempt.id))) return true;
        validatedProviderIds.add(String(attempt.id));
      }
    }
    if (db.prepare("SELECT 1 FROM attempt_cleanup WHERE workspace_id=? AND state='uncertain' LIMIT 1").get(workspaceId)) return true;
    if (db.prepare("SELECT 1 FROM attempt_cleanup c JOIN runs r ON r.id=c.run_id WHERE c.workspace_id=? AND c.state='dispatched' AND r.state IN ('completed','cancelled','failed','interrupted') LIMIT 1").get(workspaceId)) return true;
    const rows = db.prepare("SELECT t.id,t.session_id,t.run_id,t.state,length(CAST(t.data AS BLOB)) AS bytes FROM session_turns t JOIN runs r ON r.id=t.run_id WHERE r.workspace_id=? AND t.state='uncertain' ORDER BY t.rowid LIMIT ?").all(workspaceId, EXECUTION_UNCERTAINTY_LIMITS.maxTurns + 1);
    if (rows.length > EXECUTION_UNCERTAINTY_LIMITS.maxTurns) return true;
    let bytes = 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.bytes) || Number(row.bytes) < 1 || Number(row.bytes) > EXECUTION_UNCERTAINTY_LIMITS.maxOwnerBytes
        || (bytes += Number(row.bytes)) > EXECUTION_UNCERTAINTY_LIMITS.maxSelectedTurnPayloadBytes) return true;
      const data = readEvidenceBody(db, { table: 'session_turns', key: String(row.id) }, { expectedBytes: Number(row.bytes), maxBytes: EXECUTION_UNCERTAINTY_LIMITS.maxOwnerBytes });
      if (data === undefined) return true;
      const turn: TurnRecord = validateTurnRecord(JSON.parse(data));
      const dependency = turn.uncertainty?.summaryDependency;
      if (turn.id !== row.id || turn.sessionId !== row.session_id || turn.runId !== row.run_id || turn.state !== 'uncertain') return true;
      if (turn.uncertainty?.kind === 'provider_dispatch' && !dependency) {
        const attempt = db.prepare('SELECT id,session_id,run_id,state FROM provider_attempts WHERE turn_id=? ORDER BY attempt_index DESC LIMIT 1').get(turn.id);
        if (!attempt || attempt.state !== 'uncertain' || attempt.session_id !== turn.sessionId || attempt.run_id !== turn.runId
          || !validatedProviderIds.has(String(attempt.id))) return true;
        continue;
      }
      if (turn.uncertainty?.kind !== 'cleanup' || !dependency) return true;
      const expected = summaryOverflowDependency(db, store, dependency.summaryAttemptId, turn.id, dependency.failedAttemptId);
      if (expected.cleanupRecordSha256 !== dependency.cleanupRecordSha256) return true;
      if (dependency.summaryAttemptId !== options.excludedSummaryAttemptId && !options.hasValidSummaryAcknowledgment?.(turn.sessionId, dependency.summaryAttemptId)) return true;
    }
    return false;
  } catch { return true; }
}
