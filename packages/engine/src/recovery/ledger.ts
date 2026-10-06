import { DatabaseSync } from 'node:sqlite';
import { DB_VERSION } from '../storage/migrations.js';
import type { RestoreOperation } from '../review/audit.js';
import { canonical, checkDatabase, fail, hash, RECOVERY_LIMITS, type Snapshot } from './snapshot.js';

export interface RecoveryAcknowledgment {
  id: string;
  checkpointId: string;
  runId: string;
  sessionId: string;
  workspaceId: string;
  fingerprint: string;
  state: 'interrupted' | 'completed';
  outcomeHash: string;
  /** Hash of the bounded original operation, including its recorded timestamps/outcome. */
  operationHash: string;
}
export interface RecoveryBackupMetadata { bytes: number; schemaVersion: number; sha256: string }
export interface RecoveryAudit {
  id: string;
  fingerprint: string;
  scope: string;
  acknowledgedAt: string;
  markerClearRequested: boolean;
  markerHash: string | null;
  backups: { primary: RecoveryBackupMetadata; review: RecoveryBackupMetadata };
  acknowledgments: RecoveryAcknowledgment[];
}
export const RECOVERY_LEDGER_VERSION = 1;
export const RECOVERY_LEDGER_APPLICATION_ID = 0x4d43524c;
const TABLE = `CREATE TABLE recovery_audit (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= ${RECOVERY_LIMITS.maxLedgerRecordBytes})) STRICT`;
const SHA = /^[a-f0-9]{64}$/;
const bindingKeys = ['id', 'checkpointId', 'runId', 'sessionId', 'workspaceId', 'fingerprint'] as const;
const interruptedError = {
  code: 'RESTORE_INTERRUPTED',
  message: 'Restoration did not record a final outcome; filesystem effects are unknown. Reconcile the workspace before further effects.',
};
export function acknowledgment(operation: RestoreOperation, outcomeHash: string): RecoveryAcknowledgment {
  if (operation.state !== 'interrupted' && operation.state !== 'completed' || !SHA.test(outcomeHash)) fail('RECOVERY_DATABASE_INVALID');
  return {
    ...Object.fromEntries(bindingKeys.map(key => [key, operation[key]])) as Pick<RecoveryAcknowledgment, typeof bindingKeys[number]>,
    state: operation.state, outcomeHash, operationHash: hash(canonical(operation)),
  };
}
export function isRestoreAcknowledged(operation: RestoreOperation, acknowledgments: readonly RecoveryAcknowledgment[]): boolean {
  if (operation.state !== 'interrupted' && operation.state !== 'completed') return false;
  const operationHash = hash(canonical(operation));
  return acknowledgments.some(item => bindingKeys.every(key => item[key] === operation[key])
    && item.state === operation.state && item.operationHash === operationHash
    && (operation.state !== 'interrupted' || item.outcomeHash === hash(JSON.stringify(operation.error))));
}
function boundedString(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value) > max || Buffer.from(value).toString() !== value) fail('RECOVERY_DATABASE_INVALID');
  return value;
}
function digest(value: unknown): string { const result = boundedString(value, 64); if (!SHA.test(result)) fail('RECOVERY_DATABASE_INVALID'); return result; }
function timestamp(value: unknown): string {
  const result = boundedString(value, 64);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) fail('RECOVERY_DATABASE_INVALID');
  return result;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RECOVERY_DATABASE_INVALID');
  return value as Record<string, unknown>;
}
export function readOperations(db: DatabaseSync, check: () => void): { operations: { operation: RestoreOperation; outcomeHash: string | null }[]; logicalHash: string } {
  const logicalHash = checkDatabase(db, 1, ['review_operations'], check, 0x4d43524a);
  const statement = db.prepare(`SELECT id,checkpoint_id,run_id,session_id,workspace_id,fingerprint,state,started_at,finished_at,result,error,outcome_hash
    FROM review_operations WHERE state IN ('started','interrupted') OR (state='completed' AND (json_extract(result,'$.effectsUncertain')=1 OR json_extract(result,'$.executionBlocked')=1)) ORDER BY ordinal LIMIT ?`);
  const rows = statement.all(RECOVERY_LIMITS.maxOperations + 1);
  if (rows.length > RECOVERY_LIMITS.maxOperations) fail('RECOVERY_LIMIT_EXCEEDED');
  const operations = rows.map(row => {
    check();
    const state = row.state;
    if (state !== 'started' && state !== 'interrupted' && state !== 'completed') fail('RECOVERY_DATABASE_INVALID');
    const operation: RestoreOperation = {
      id: boundedString(row.id), checkpointId: boundedString(row.checkpoint_id), runId: boundedString(row.run_id),
      sessionId: boundedString(row.session_id), workspaceId: boundedString(row.workspace_id), fingerprint: digest(row.fingerprint),
      state, startedAt: timestamp(row.started_at),
    };
    let outcomeHash: string | null = null;
    if (state === 'started') {
      if (row.finished_at !== null || row.result !== null || row.error !== null || row.outcome_hash !== null) fail('RECOVERY_DATABASE_INVALID');
    } else {
      operation.finishedAt = timestamp(row.finished_at);
      outcomeHash = digest(row.outcome_hash);
      if (state === 'interrupted') {
        if (row.result !== null || typeof row.error !== 'string' || Buffer.byteLength(row.error) > 32_768) fail('RECOVERY_DATABASE_INVALID');
        const error = object(JSON.parse(row.error));
        if (canonical(error) !== canonical(interruptedError) || outcomeHash !== hash(row.error)) fail('RECOVERY_DATABASE_INVALID');
        operation.error = interruptedError;
      } else {
        if (row.error !== null || typeof row.result !== 'string' || Buffer.byteLength(row.result) > 128 * 1024) fail('RECOVERY_DATABASE_INVALID');
        const result = object(JSON.parse(row.result));
        if (result.checkpointId !== operation.checkpointId || result.runId !== operation.runId || result.atomic !== false
          || typeof result.truncated !== 'boolean' || typeof result.effectsUncertain !== 'boolean' || typeof result.executionBlocked !== 'boolean') fail('RECOVERY_DATABASE_INVALID');
        for (const key of ['restored', 'conflicts', 'failed', 'observations', 'warnings']) if (!Array.isArray(result[key])) fail('RECOVERY_DATABASE_INVALID');
        object(result.totals);
        operation.result = result as unknown as RestoreOperation['result'];
      }
    }
    return { operation, outcomeHash };
  });
  return { operations, logicalHash };
}
export function readAudits(db: DatabaseSync | undefined, check: () => void): { audits: RecoveryAudit[]; logicalHash: string } {
  if (!db) return { audits: [], logicalHash: hash('[]') };
  const logicalHash = checkDatabase(db, RECOVERY_LEDGER_VERSION, ['recovery_audit'], check, RECOVERY_LEDGER_APPLICATION_ID);
  const rows = db.prepare('SELECT id,data,length(CAST(data AS BLOB)) AS bytes FROM recovery_audit ORDER BY ordinal LIMIT ?').all(RECOVERY_LIMITS.maxOperations + 1);
  if (rows.length > RECOVERY_LIMITS.maxOperations) fail('RECOVERY_LIMIT_EXCEEDED');
  const audits = rows.map(row => {
    check();
    if (typeof row.data !== 'string' || Number(row.bytes) > RECOVERY_LIMITS.maxLedgerRecordBytes) fail('RECOVERY_DATABASE_INVALID');
    const source = object(JSON.parse(row.data));
    const backups = object(source.backups);
    const backup = (value: unknown, maximumVersion: number): RecoveryBackupMetadata => {
      const item = object(value);
      if (!Number.isSafeInteger(item.bytes) || Number(item.bytes) < 1 || !Number.isSafeInteger(item.schemaVersion) || Number(item.schemaVersion) < 1 || Number(item.schemaVersion) > maximumVersion) fail('RECOVERY_DATABASE_INVALID');
      return { bytes: item.bytes as number, schemaVersion: item.schemaVersion as number, sha256: digest(item.sha256) };
    };
    if (!Array.isArray(source.acknowledgments) || source.acknowledgments.length > RECOVERY_LIMITS.maxOperations || typeof source.markerClearRequested !== 'boolean') fail('RECOVERY_DATABASE_INVALID');
    const acknowledgments: RecoveryAcknowledgment[] = source.acknowledgments.map(value => {
      const item = object(value);
      if (item.state !== 'interrupted' && item.state !== 'completed') fail('RECOVERY_DATABASE_INVALID');
      return { id: boundedString(item.id), checkpointId: boundedString(item.checkpointId), runId: boundedString(item.runId),
        sessionId: boundedString(item.sessionId), workspaceId: boundedString(item.workspaceId), fingerprint: digest(item.fingerprint),
        state: item.state, outcomeHash: digest(item.outcomeHash), operationHash: digest(item.operationHash) };
    });
    const audit: RecoveryAudit = { id: boundedString(source.id), fingerprint: digest(source.fingerprint), scope: digest(source.scope),
      acknowledgedAt: timestamp(source.acknowledgedAt), markerClearRequested: source.markerClearRequested,
      markerHash: source.markerHash === null ? null : digest(source.markerHash),
      backups: { primary: backup(backups.primary, DB_VERSION), review: backup(backups.review, 1) }, acknowledgments };
    if (audit.id !== row.id || canonical(audit) !== canonical(source)) fail('RECOVERY_DATABASE_INVALID');
    return audit;
  });
  // An initialized empty ledger is equivalent to an absent ledger for confirmation.
  return { audits, logicalHash: audits.length ? logicalHash : hash('[]') };
}
export function scope(snapshot: Snapshot): string {
  return hash(canonical({ db: { dev: snapshot.files.get('db')?.signature.dev, ino: snapshot.files.get('db')?.signature.ino },
    review: { dev: snapshot.files.get('review')?.signature.dev, ino: snapshot.files.get('review')?.signature.ino }, artifacts: snapshot.artifactIdentity }));
}
export function matchingAcknowledgments(snapshot: Snapshot, operations: ReturnType<typeof readOperations>['operations'], audits: readonly RecoveryAudit[]): RecoveryAcknowledgment[] {
  const currentScope = scope(snapshot);
  const recorded = audits.filter(audit => audit.scope === currentScope).flatMap(audit => audit.acknowledgments);
  return operations.flatMap(({ operation, outcomeHash }) => {
    if (!outcomeHash || operation.state === 'started') return [];
    const current = acknowledgment(operation, outcomeHash);
    return recorded.some(item => canonical(item) === canonical(current)) ? [current] : [];
  });
}
export function initializeLedger(db: DatabaseSync): void {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  const app = db.prepare('PRAGMA application_id').get()?.application_id;
  if (version === 0 && app === 0 && db.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").get() === undefined) {
    db.exec('BEGIN IMMEDIATE');
    try { db.exec(TABLE + `; PRAGMA user_version=${RECOVERY_LEDGER_VERSION}; PRAGMA application_id=${RECOVERY_LEDGER_APPLICATION_ID}; COMMIT`); }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  } else readAudits(db, () => {});
}
