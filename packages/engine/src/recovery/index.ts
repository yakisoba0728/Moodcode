import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EngineError } from '@moodcode/contracts';
import { backupDatabase } from '../storage/maintenance.js';
import { databaseVersion } from '../storage/migrations.js';
import { NATIVE_SESSION_TABLES } from '../storage/native-schema.js';
import { SUMMARY_STORAGE_TABLES } from '../storage/summary-attempts.js';
import { SUMMARY_RECOVERY_TABLES } from './summary.js';
import { ATTEMPT_CLEANUP_TABLES } from '../storage/attempt-cleanup.js';
import { PROVIDER_RECOVERY_TABLES } from './provider.js';
import { MCP_EXECUTION_TABLES } from '../storage/mcp-executions.js';
import { KNOWLEDGE_STORAGE_TABLES } from '../knowledge/validation.js';
import { KNOWLEDGE_GENERATION_TABLES } from '../knowledge/generation-store.js';
import { validateKnowledgeGenerationDatabase } from '../knowledge/generation-archive-relations.js';
import { KNOWLEDGE_PUBLICATION_TABLES } from '../knowledge/publication-store.js';
import { validateKnowledgePublicationDatabase } from '../knowledge/publication-archive-relations.js';
import { KNOWLEDGE_FILE_PUBLICATION_TABLES, validateKnowledgeFilePublicationDatabase } from '../knowledge/file-publication-store.js';
import { KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE, validateKnowledgeFileExecutionGuards } from '../knowledge/file-execution-guards.js';
import { DIAGNOSTIC_EXECUTION_OBSERVATION_TABLES, validateDiagnosticExecutionObservationDatabase } from '../diagnostics/execution-observation-store.js';
import { KNOWLEDGE_IMPORT_RECOVERY_TABLES, validateKnowledgeImportRecoveryDatabase } from '../knowledge/import-recovery-store.js';
import { PROPOSAL_TABLES, validateProposalDatabase } from '../proposals/store.js';
import { PROPOSAL_APPLY_TABLES, validateProposalApplyDatabase } from '../proposals/apply-store.js';
import { PROPOSAL_APPLY_GUARD_TABLE, validateProposalApplyExecutionGuards } from '../proposals/execution-guards.js';
import { TEAM_TABLES, validateTeamDatabase } from '../teams/store.js';
import { WORKFLOW_TABLES } from '../workflows/schema.js';
import { validateWorkflowDatabase } from '../workflows/store.js';
import { SCHEDULE_TABLES } from '../schedules/schema.js';
import { validateScheduleDatabase } from '../schedules/store.js';
import { acknowledgment, initializeLedger, isRestoreAcknowledged, matchingAcknowledgments, readAudits, readOperations, scope,
  type RecoveryAcknowledgment, type RecoveryAudit } from './ledger.js';
import { canonical, checkDatabase, fail, hash, preparePrivateDirectory, recoveryPaths, regular, safeError, sameIdentity, takeSnapshot,
  verifiedFileDigest, RECOVERY_LIMITS, type RecoveryPaths, type Snapshot } from './snapshot.js';

export { isRestoreAcknowledged, RECOVERY_LIMITS };
export type { RecoveryAcknowledgment };
export interface RecoveryOptions { dbPath: string; artifactDir: string }
export type RecoveryBlocker = 'RECOVERY_OWNER_BUSY' | 'RECOVERY_EFFECT_BUSY' | 'RECOVERY_DATABASE_INVALID' | 'RECOVERY_PATH_UNSUPPORTED'
  | 'RECOVERY_LIMIT_EXCEEDED' | 'RECOVERY_PERMISSION_DENIED' | 'RECOVERY_SOURCE_CHANGED' | 'PRIMARY_DATABASE_MISSING'
  | 'REVIEW_DATABASE_MISSING' | 'PROCESS_OWNER_ALIVE' | 'PROCESS_GROUP_ALIVE' | 'PROCESS_CLEANUP_UNVERIFIED'
  | 'PROCESS_GROUP_NOT_RECORDED' | 'RESTORE_RESTART_REQUIRED';
export interface RecoveryStatus {
  schemaVersion: 1;
  state: 'clear' | 'recoverable' | 'blocked';
  fingerprint: string | null;
  blockers: RecoveryBlocker[];
  marker: { active: boolean; owner: 'absent' | 'alive' | 'unknown'; group: 'absent' | 'alive' | 'unknown' | 'not_recorded' } | null;
  pendingRestoreCount: number;
  resolvedRestoreCount: number;
  activeRunCount: number;
}
export interface RecoverEngineOptions extends RecoveryOptions { fingerprint: string; acknowledged: true }
export interface RecoveryResult { recoveryId: string; restoredAcknowledgments: number; effectMarkerCleared: boolean; backupVerified: true }
interface Marker { ownerPid: number; groupPid: number | null; active: boolean; updatedAt: string }
interface Inspection {
  status: RecoveryStatus;
  snapshot: Snapshot;
  marker: Marker | null;
  acknowledgments: RecoveryAcknowledgment[];
  unresolved: ReturnType<typeof readOperations>['operations'];
}
const PRIMARY_TABLES = ['workspaces', 'sessions', 'inputs', 'runs', 'messages', 'tools', 'approvals', 'checkpoints', 'events'];
function busy(error: unknown): boolean {
  const code = (error as { errcode?: number })?.errcode;
  return typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6);
}
function observe(pid: number, group: boolean): 'absent' | 'alive' | 'unknown' {
  if (group && process.platform === 'win32') return 'unknown';
  try { process.kill(group ? -pid : pid, 0); return 'alive'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'unknown'; }
}
function ownershipBusy(file: string): boolean {
  const before = regular(file);
  if (!before) return false;
  for (const suffix of ['-wal', '-shm', '-journal']) regular(file + suffix);
  // A readonly WAL connection can still create SHM. Only known DELETE-mode
  // owner/effect files are eligible for an original lock probe.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameIdentity(before, fstatSync(fd))) fail('RECOVERY_SOURCE_CHANGED');
    if (before.size > 0) {
      const header = Buffer.alloc(100);
      const bytes = readSync(fd, header, 0, header.length, 0);
      if (bytes !== 100 || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' || header[18] !== 1 || header[19] !== 1) fail('RECOVERY_DATABASE_INVALID');
    }
    if (!sameIdentity(before, regular(file))) fail('RECOVERY_SOURCE_CHANGED');
  } finally { closeSync(fd); }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 0 });
    db.exec('BEGIN');
    db.prepare('SELECT count(*) AS count FROM sqlite_schema').get();
    db.exec('ROLLBACK');
    if (!sameIdentity(before, regular(file))) fail('RECOVERY_SOURCE_CHANGED');
    return false;
  } catch (error) { if (busy(error)) return true; throw error; }
  finally { db?.close(); }
}
function inspect(options: RecoveryOptions, probeOwners = true): Inspection {
  const paths = recoveryPaths(options);
  const snapshot = takeSnapshot(paths);
  const opened: DatabaseSync[] = [];
  const open = (name: 'db' | 'review' | 'effect' | 'ledger'): DatabaseSync | undefined => {
    const db = snapshot.open(name); if (db) opened.push(db); return db;
  };
  try {
    const primary = open('db'); const review = open('review'); const effect = open('effect'); const ledger = open('ledger');
    const blockers: RecoveryBlocker[] = [];
    if (!primary) blockers.push('PRIMARY_DATABASE_MISSING');
    if (!review) blockers.push('REVIEW_DATABASE_MISSING');
    const primaryVersion = primary ? databaseVersion(primary) : 0;
    if (primary && primaryVersion < 1) fail('RECOVERY_DATABASE_INVALID');
    const primaryTables = primaryVersion >= 2 ? [...PRIMARY_TABLES, ...NATIVE_SESSION_TABLES] : PRIMARY_TABLES;
    const usageTables = primaryVersion >= 3 ? [...primaryTables, 'attempt_usage'] : primaryTables;
    const summaryTables = primaryVersion >= 4 ? [...usageTables, ...SUMMARY_STORAGE_TABLES] : usageTables;
    const recoveryTables = primaryVersion >= 5 ? [...summaryTables, ...SUMMARY_RECOVERY_TABLES] : summaryTables;
    const cleanupTables = primaryVersion >= 6 ? [...recoveryTables, ...ATTEMPT_CLEANUP_TABLES] : recoveryTables;
    const providerTables = primaryVersion >= 7 ? [...cleanupTables, ...PROVIDER_RECOVERY_TABLES] : cleanupTables;
    const mcpTables = primaryVersion >= 9 ? [...providerTables, ...MCP_EXECUTION_TABLES] : providerTables;
    const knowledgeTables = primaryVersion >= 10 ? [...mcpTables, ...KNOWLEDGE_STORAGE_TABLES] : mcpTables;
    if (primary && primaryVersion >= 11) validateKnowledgeGenerationDatabase(primary, snapshot.check);
    if (primary && primaryVersion >= 12) validateKnowledgePublicationDatabase(primary, snapshot.check);
    if (primary && primaryVersion >= 13) {
      validateKnowledgeFilePublicationDatabase(primary, snapshot.check);
      validateKnowledgeFileExecutionGuards(primary, snapshot.check);
    }
    const generationTables = primaryVersion >= 11 ? [...knowledgeTables, ...KNOWLEDGE_GENERATION_TABLES] : knowledgeTables;
    const publicationTables = primaryVersion >= 12 ? [...generationTables, ...KNOWLEDGE_PUBLICATION_TABLES] : generationTables;
    const fileTables = primaryVersion >= 13 ? [...publicationTables, ...KNOWLEDGE_FILE_PUBLICATION_TABLES, KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE] : publicationTables;
    if (primary && primaryVersion >= 14) validateDiagnosticExecutionObservationDatabase(primary, snapshot.check);
    const observationTables = primaryVersion >= 14 ? [...fileTables, ...DIAGNOSTIC_EXECUTION_OBSERVATION_TABLES] : fileTables;
    if (primary && primaryVersion >= 15) validateKnowledgeImportRecoveryDatabase(primary, snapshot.check);
    const importTables = primaryVersion >= 15 ? [...observationTables, ...KNOWLEDGE_IMPORT_RECOVERY_TABLES] : observationTables;
    if (primary && primaryVersion >= 16) validateProposalDatabase(primary, snapshot.check);
    const pendingProposalTables = primaryVersion >= 16 ? [...importTables, ...PROPOSAL_TABLES] : importTables;
    if (primary && primaryVersion >= 17) { validateProposalApplyDatabase(primary, snapshot.check); validateProposalApplyExecutionGuards(primary, snapshot.check); }
    const proposalTables = primaryVersion >= 17 ? [...pendingProposalTables, ...PROPOSAL_APPLY_TABLES, PROPOSAL_APPLY_GUARD_TABLE] : pendingProposalTables;
    if (primary && primaryVersion >= 18) validateTeamDatabase(primary, snapshot.check);
    const teamTables = primaryVersion >= 18 ? [...proposalTables, ...TEAM_TABLES] : proposalTables;
    if (primary && primaryVersion >= 19) validateWorkflowDatabase(primary, { check: snapshot.check });
    const workflowTables = primaryVersion >= 19 ? [...teamTables, ...WORKFLOW_TABLES] : teamTables;
    if (primary && primaryVersion >= 20) validateScheduleDatabase(primary, { check: snapshot.check });
    const scheduleTables = primaryVersion >= 20 ? [...workflowTables, ...SCHEDULE_TABLES] : workflowTables;
    const primaryHash = primary ? checkDatabase(primary, primaryVersion, scheduleTables, snapshot.check) : null;
    const operations = review ? readOperations(review, snapshot.check) : { operations: [], logicalHash: null };
    const audits = readAudits(ledger, snapshot.check);
    let marker: Marker | null = null;
    let effectHash: string | null = null;
    if (effect) {
      const exists = effect.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='command_execution'").get();
      effectHash = checkDatabase(effect, 0, exists ? ['command_execution'] : [], snapshot.check);
      if (exists) {
        const rows = effect.prepare('SELECT id,owner_pid,group_pid,active,updated_at FROM command_execution LIMIT 2').all();
        if (rows.length > 1) fail('RECOVERY_DATABASE_INVALID');
        const row = rows[0];
        if (row) {
          const validPid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
          if (row.id !== 1 || !validPid(row.owner_pid) || row.group_pid !== null && !validPid(row.group_pid)
            || row.active !== 0 && row.active !== 1 || typeof row.updated_at !== 'string' || Buffer.byteLength(row.updated_at) > 128 || !Number.isFinite(Date.parse(row.updated_at))) fail('RECOVERY_DATABASE_INVALID');
          marker = { ownerPid: row.owner_pid, groupPid: row.group_pid as number | null, active: row.active === 1, updatedAt: row.updated_at };
        }
      }
    }
    const markerStatus: RecoveryStatus['marker'] = marker ? {
      active: marker.active, owner: observe(marker.ownerPid, false),
      group: marker.groupPid === null ? 'not_recorded' : observe(marker.groupPid, true),
    } : null;
    if (markerStatus?.active) {
      if (markerStatus.owner === 'alive') blockers.push('PROCESS_OWNER_ALIVE');
      if (markerStatus.group === 'alive') blockers.push('PROCESS_GROUP_ALIVE');
      if (markerStatus.owner === 'unknown' || markerStatus.group === 'unknown') blockers.push('PROCESS_CLEANUP_UNVERIFIED');
      if (markerStatus.group === 'not_recorded') blockers.push('PROCESS_GROUP_NOT_RECORDED');
    }
    const acknowledgments = matchingAcknowledgments(snapshot, operations.operations, audits.audits);
    const unresolved = operations.operations.filter(({ operation }) => !isRestoreAcknowledged(operation, acknowledgments));
    if (unresolved.some(item => item.operation.state === 'started')) blockers.push('RESTORE_RESTART_REQUIRED');
    if (primary) for (const { operation } of operations.operations) {
      const run = primary.prepare('SELECT workspace_id,session_id,state FROM runs WHERE id=?').get(operation.runId);
      const checkpoint = primary.prepare("SELECT json_extract(data,'$.id') AS id,json_extract(data,'$.runId') AS run_id FROM checkpoints WHERE id=? AND run_id=?").get(operation.checkpointId, operation.runId);
      if (!run || run.workspace_id !== operation.workspaceId || run.session_id !== operation.sessionId
        || !['completed', 'cancelled', 'failed', 'interrupted'].includes(String(run.state)) || checkpoint?.id !== operation.checkpointId || checkpoint.run_id !== operation.runId) fail('RECOVERY_DATABASE_INVALID');
    }
    const activeRunCount = primary ? Number(primary.prepare("SELECT count(*) AS count FROM runs WHERE state IN ('created','running','awaiting_approval','cancelling')").get()?.count) : 0;
    if (!Number.isSafeInteger(activeRunCount) || activeRunCount < 0) fail('RECOVERY_DATABASE_INVALID');
    if (probeOwners) {
      if (ownershipBusy(paths.db + '.owner.sqlite') || ownershipBusy(paths.review + '.owner.sqlite')) blockers.push('RECOVERY_OWNER_BUSY');
      if (ownershipBusy(paths.effect)) blockers.push('RECOVERY_EFFECT_BUSY');
    }
    const identities = Object.fromEntries(['db', 'review', 'effect'].map(key => {
      const item = snapshot.files.get(key);
      return [key, item ? { dev: item.signature.dev, ino: item.signature.ino } : null];
    }));
    const fingerprint = primary && review ? hash(canonical({ schemaVersion: 1, pathsHash: hash(canonical(paths)), identities,
      artifacts: { dev: snapshot.artifactIdentity.dev, ino: snapshot.artifactIdentity.ino }, primaryHash,
      reviewHash: operations.logicalHash, effectHash, ledgerHash: audits.logicalHash })) : null;
    const needed = Boolean(marker?.active || unresolved.length);
    return { status: { schemaVersion: 1, state: blockers.length ? 'blocked' : needed ? 'recoverable' : 'clear', fingerprint,
      blockers, marker: markerStatus, pendingRestoreCount: unresolved.length, resolvedRestoreCount: acknowledgments.length, activeRunCount },
      snapshot, marker, acknowledgments, unresolved };
  } catch (error) { snapshot.cleanup(); throw safeError(error); }
  finally { for (const db of opened.reverse()) db.close(); }
}

/** No source database, marker, owner lock, Run, or journal is modified by diagnostics. */
export async function getRecoveryStatus(options: RecoveryOptions): Promise<RecoveryStatus> {
  try { const inspection = inspect(options); try { return inspection.status; } finally { inspection.snapshot.cleanup(); } }
  catch (error) {
    const normalized = safeError(error);
    return { schemaVersion: 1, state: 'blocked', fingerprint: null, blockers: [normalized.code as RecoveryBlocker], marker: null,
      pendingRestoreCount: 0, resolvedRestoreCount: 0, activeRunCount: 0 };
  }
}
/** Internal startup helper: only acknowledgments still matching the original review row are returned. */
export function readRecoveryAcknowledgments(options: RecoveryOptions): RecoveryAcknowledgment[] {
  const paths = recoveryPaths(options);
  if (!regular(paths.ledger)) return [];
  const inspection = inspect(options, false);
  try { return inspection.acknowledgments; } finally { inspection.snapshot.cleanup(); }
}
function privateFile(file: string): void {
  if (regular(file)) return;
  try { const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(fd); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; regular(file); }
}
export function acquireRecoveryLease(file: string, kind: 'owner' | 'effect' | 'source'): { db: DatabaseSync; release(): void; identity: { dev: number; ino: number }; file: string } {
  if (kind !== 'source') privateFile(file);
  const identity = regular(file);
  if (!identity) fail('RECOVERY_DATABASE_INVALID');
  for (const suffix of ['-wal', '-shm', '-journal']) regular(file + suffix);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { timeout: 0 });
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0');
    if (kind === 'effect') db.exec('PRAGMA synchronous=FULL; PRAGMA fullfsync=ON');
    if (kind === 'owner' && db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') fail('RECOVERY_DATABASE_INVALID');
    db.exec(kind === 'source' ? 'BEGIN IMMEDIATE' : 'BEGIN EXCLUSIVE');
    if (!sameIdentity(identity, regular(file))) fail('RECOVERY_SOURCE_CHANGED');
    const database = db;
    return { db, identity: { dev: identity.dev, ino: identity.ino }, file,
      release() { try { if (database.isTransaction) database.exec('ROLLBACK'); } finally { database.close(); } } };
  } catch (error) {
    db?.close();
    if (busy(error)) fail(kind === 'effect' ? 'RECOVERY_EFFECT_BUSY' : 'RECOVERY_OWNER_BUSY');
    throw safeError(error);
  }
}
const acquire = acquireRecoveryLease;
function requireRecoverable(inspection: Inspection, expected: string): void {
  if (inspection.status.fingerprint !== expected) fail('RECOVERY_STALE');
  if (inspection.status.blockers.length) fail('RECOVERY_BLOCKED');
  if (inspection.status.state === 'clear') fail('RECOVERY_NOT_NEEDED');
}
function assertIdentities(locks: ReturnType<typeof acquire>[], artifacts: RecoveryPaths, snapshot: Snapshot): void {
  for (const lock of locks) if (!sameIdentity(lock.identity, regular(lock.file))) fail('RECOVERY_SOURCE_CHANGED');
  if (!sameIdentity(snapshot.artifactIdentity, lstatSync(artifacts.artifacts))) fail('RECOVERY_SOURCE_CHANGED');
}
function backupDirectory(paths: RecoveryPaths, id: string): string {
  const root = join(paths.artifacts, 'recovery');
  const existing = lstatSync(root, { throwIfNoEntry: false });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) fail('RECOVERY_PATH_UNSUPPORTED');
  if (!existing) preparePrivateDirectory(paths.artifacts, 'recovery');
  return preparePrivateDirectory(root, id);
}
function durableDirectory(file: string): void {
  const fd = openSync(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Acknowledges stopped effects; never signals processes, reruns tools, or edits original Runs/review operations. */
export async function recoverEngine(options: RecoverEngineOptions): Promise<RecoveryResult> {
  if (!options || options.acknowledged !== true || typeof options.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(options.fingerprint)) fail('RECOVERY_ACKNOWLEDGMENT_REQUIRED');
  const locks: ReturnType<typeof acquire>[] = [];
  let inspection: Inspection | undefined;
  let ledger: DatabaseSync | undefined;
  try {
    const paths = recoveryPaths(options);
    // Ownership is admission authority; an observation from diagnostics never grants a lease.
    locks.push(acquire(paths.db + '.owner.sqlite', 'owner'));
    locks.push(acquire(paths.review + '.owner.sqlite', 'owner'));
    if (regular(paths.effect)) locks.push(acquire(paths.effect, 'effect'));
    locks.push(acquire(paths.db, 'source'));
    locks.push(acquire(paths.review, 'source'));
    inspection = inspect(options, false);
    requireRecoverable(inspection, options.fingerprint);
    const id = randomUUID();
    const destination = backupDirectory(paths, id);
    const recoveryDirectory = join(paths.artifacts, 'recovery');
    const recoveryIdentity = lstatSync(recoveryDirectory), backupIdentity = lstatSync(destination);
    const backupFiles: { file: string; dev: number; ino: number; bytes: number; sha256: string }[] = [];
    const verify = (): void => {
      inspection!.snapshot.check(); assertIdentities(locks, paths, inspection!.snapshot);
      const recoveryCurrent = lstatSync(recoveryDirectory), backupCurrent = lstatSync(destination);
      if (!sameIdentity(recoveryIdentity, recoveryCurrent) || recoveryCurrent.isSymbolicLink()
        || !sameIdentity(backupIdentity, backupCurrent) || backupCurrent.isSymbolicLink()) fail('RECOVERY_SOURCE_CHANGED');
      for (const file of backupFiles) if (!sameIdentity(file, regular(file.file))) fail('RECOVERY_SOURCE_CHANGED');
    };
    const backups: RecoveryAudit['backups'] = {} as RecoveryAudit['backups'];
    for (const [key, label] of [['db', 'primary'], ['review', 'review']] as const) {
      const db = inspection.snapshot.open(key);
      if (!db) fail('RECOVERY_BACKUP_FAILED');
      try {
        const file = join(destination, label + '.sqlite');
        const expectedVersion = key === 'db' ? databaseVersion(db) : 1;
        if (expectedVersion < 1) fail('RECOVERY_DATABASE_INVALID');
        const result = await backupDatabase(db, file, expectedVersion, verify);
        const digest = verifiedFileDigest(file, verify);
        if (digest.bytes !== result.bytes) fail('RECOVERY_SOURCE_CHANGED');
        backupFiles.push({ file, ...digest });
        backups[label] = { bytes: result.bytes, schemaVersion: result.schemaVersion, sha256: digest.sha256 };
      } catch (error) {
        if (error instanceof EngineError && error.code.startsWith('RECOVERY_')) throw error;
        fail('RECOVERY_BACKUP_FAILED');
      } finally { db.close(); }
    }
    durableDirectory(destination);
    durableDirectory(join(paths.artifacts, 'recovery'));
    verify();
    // The held source write leases prevent changes between this second inspection and commit.
    const current = inspect(options, false);
    try { requireRecoverable(current, options.fingerprint); } finally { current.snapshot.cleanup(); }
    for (const file of backupFiles) if (canonical(verifiedFileDigest(file.file, verify)) !== canonical({ dev: file.dev, ino: file.ino, bytes: file.bytes, sha256: file.sha256 })) fail('RECOVERY_SOURCE_CHANGED');
    privateFile(paths.ledger);
    const ledgerIdentity = regular(paths.ledger)!;
    ledger = new DatabaseSync(paths.ledger, { timeout: 0 });
    ledger.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON');
    initializeLedger(ledger);
    durableDirectory(dirname(paths.db));
    const acknowledgments = inspection.unresolved.map(({ operation, outcomeHash }) => {
      if (!outcomeHash || operation.state === 'started') fail('RECOVERY_BLOCKED');
      return acknowledgment(operation, outcomeHash);
    });
    const audit: RecoveryAudit = { id, fingerprint: options.fingerprint, scope: scope(inspection.snapshot), acknowledgedAt: new Date().toISOString(),
      markerClearRequested: Boolean(inspection.marker?.active), markerHash: inspection.marker ? hash(canonical(inspection.marker)) : null, backups, acknowledgments };
    const data = JSON.stringify(audit);
    if (Buffer.byteLength(data) > RECOVERY_LIMITS.maxLedgerRecordBytes) fail('RECOVERY_LIMIT_EXCEEDED');
    try {
      ledger.exec('BEGIN IMMEDIATE');
      ledger.prepare('INSERT INTO recovery_audit(id,data) VALUES(?,?)').run(id, data);
      verify();
      if (!sameIdentity(ledgerIdentity, regular(paths.ledger))) fail('RECOVERY_SOURCE_CHANGED');
      ledger.exec('COMMIT');
    } catch { fail('RECOVERY_METADATA_FAILED'); }
    let cleared = false;
    if (inspection.marker?.active) {
      const marker = inspection.marker;
      // Repeat real OS observations immediately before the only effect-marker mutation.
      if (observe(marker.ownerPid, false) !== 'absent' || marker.groupPid === null || observe(marker.groupPid, true) !== 'absent') fail('RECOVERY_BLOCKED');
      verify();
      const lock = locks.find(item => item.file === paths.effect);
      if (!lock) fail('RECOVERY_EFFECT_BUSY');
      const changes = lock.db.prepare('UPDATE command_execution SET active=0,updated_at=? WHERE id=1 AND active=1 AND owner_pid=? AND group_pid IS ? AND updated_at=?')
        .run(new Date().toISOString(), marker.ownerPid, marker.groupPid, marker.updatedAt).changes;
      if (changes !== 1) fail('RECOVERY_SOURCE_CHANGED');
      lock.db.exec('COMMIT');
      cleared = true;
    }
    assertIdentities(locks, paths, inspection.snapshot);
    return { recoveryId: id, restoredAcknowledgments: acknowledgments.length, effectMarkerCleared: cleared, backupVerified: true };
  } catch (error) { throw safeError(error); }
  finally {
    try { ledger?.close(); }
    finally { try { inspection?.snapshot.cleanup(); } finally { for (const lock of locks.reverse()) lock.release(); } }
  }
}
