import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { EngineError } from '@moodcode/contracts';
import { acquireRecoveryLease } from '../recovery/index.js';
import { readAudits, readOperations, scope } from '../recovery/ledger.js';
import { canonical, checkDatabase, recoveryPaths, regular, sameIdentity, takeSnapshot, type Identity } from '../recovery/snapshot.js';
import { backupDatabase } from './maintenance.js';
import { databaseVersion, DB_VERSION } from './migrations.js';
import { NATIVE_SESSION_TABLES } from './native-schema.js';
import { SUMMARY_STORAGE_TABLES } from './summary-attempts.js';
import { SUMMARY_RECOVERY_TABLES } from '../recovery/summary.js';
import { ATTEMPT_CLEANUP_TABLES } from './attempt-cleanup.js';
import { PROVIDER_RECOVERY_TABLES } from '../recovery/provider.js';
import { MCP_EXECUTION_TABLES } from './mcp-executions.js';
import { KNOWLEDGE_LIMITS, KNOWLEDGE_STORAGE_TABLES, validateKnowledgeArchiveRow } from '../knowledge/validation.js';
import { KNOWLEDGE_GENERATION_TABLES, validateKnowledgeGenerationArchiveRow } from '../knowledge/generation-store.js';
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
import { validateTeamChildInputRelations } from '../teams/child-input-proof.js';
import { knowledgeHash } from '../knowledge/validation.js';
import { SqliteStore } from './index.js';
import { inspectInputDocumentIndex, type InputDocumentIndexReport } from './input-document-index.js';
import { attachments as documentAttachments, sameAttachment as sameDocumentAttachment, validateDocumentBytes } from '../documents/validation.js';
import type { ManagedWorktree } from '../worktrees/index.js';
import { childStoragePhysicalIdentity, readChildStorageSelection, validateChildStorageRecord, type ChildStorageHostIdentity, type ChildStorageRecord } from '../child-tasks/storage-binding.js';
import { createChildDocumentReadFrame, openChildDocumentReader } from './child-document-reader.js';
import { buildArchivedChildDocumentStorageReport, validateArchivedChildDocumentStorageRequest,
  type ArchivedChildDocumentStorageRequest, type ArchivedChildDocumentStorageReport } from '../diagnostics/archive-child-documents.js';
type DocumentFrame = ReturnType<typeof createChildDocumentReadFrame>;

export const ENGINE_ARCHIVE_VERSION = 1;
export const ENGINE_ARCHIVE_LIMITS = Object.freeze({ maxFiles: 4096, maxFileBytes: 268_435_456, maxTotalBytes: 536_870_912, maxManifestBytes: 4_194_304 });
type Role = 'primary' | 'review' | 'ledger' | 'effect';
const databaseFiles: Record<Role, string> = { primary: 'engine.sqlite', review: 'engine.sqlite.review.sqlite', ledger: 'engine.sqlite.recovery.sqlite', effect: 'engine.sqlite.effects.sqlite' };
const primaryTables = ['workspaces', 'sessions', 'inputs', 'runs', 'messages', 'tools', 'approvals', 'checkpoints', 'events'];
export interface ArchiveFile { file: string; bytes: number; sha256: string }
export interface ArchiveDatabase extends ArchiveFile { role: Role; schemaVersion: number; logicalHash: string }
export interface ArchiveChildDatabase extends ArchiveFile { schemaVersion: number; logicalHash: string }
export interface ArchiveDocumentAudit {
  version: 1; coverage: 'complete' | 'partial'; primary: 'verified';
  children: Array<{ taskId: string; record: ChildStorageRecord; database: ArchiveChildDatabase; artifactPrefix: string }>;
  unchecked: Array<{ taskId: string; reason: 'legacy-unbound' | 'external-child-storage' }>;
}
export interface EngineArchiveManifest {
  archiveVersion: 1; archiveId: string; createdAt: string;
  source: { dbPath: string; artifactDir: string; binding: { db: Identity; review: Identity; artifacts: Identity }; bindingScope: string };
  databases: ArchiveDatabase[]; artifacts: ArchiveFile[];
  recoveryAcknowledgmentsRebound: false;
  documentAudit?: ArchiveDocumentAudit;
}
export interface ExportEngineArchiveOptions { dbPath: string; artifactDir: string; destination: string; signal?: AbortSignal }
export interface ImportEngineArchiveOptions { directory: string; destination: string; signal?: AbortSignal }
export interface EngineArchiveResult { directory: string; manifest: EngineArchiveManifest; manifestSha256: string }
export interface ImportedEngineArchive extends EngineArchiveResult { dbPath: string; artifactDir: string; migratedFromVersion: number; schemaVersion: number; sessionsPaused: number; worktreesRelocated: number; childSessionsPaused: number; documentAuditCoverage: 'complete' | 'partial' | 'unchecked'; artifactPathMapping: { from: string; to: string }; executionResumed: false }
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function fail(code: string, message: string): never { throw new EngineError(code, message); }
function abort(signal?: AbortSignal): void { if (signal?.aborted) fail('ARCHIVE_ABORTED', 'Engine archive operation was cancelled'); }
function checkedDirectory(input: string): string {
  if (typeof input !== 'string' || !isAbsolute(input) || !input || input.includes('\0')) fail('ARCHIVE_PATH_UNSUPPORTED', 'Archive paths must be absolute paths without symlinks');
  let current = parse(input).root;
  for (const component of input.slice(current.length).split(sep).filter(Boolean)) {
    if (component === '.') continue;
    if (component === '..') { current = dirname(current); continue; }
    current = join(current, component);
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('ARCHIVE_PATH_UNSUPPORTED', 'Archive directory components must be real directories');
  }
  return resolve(input);
}
function destinationPath(input: string): string {
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0') || basename(input) === '.' || basename(input) === '..') fail('ARCHIVE_PATH_UNSUPPORTED', 'Archive destination must be a new absolute directory');
  checkedDirectory(dirname(input));
  const destination = resolve(input);
  if (lstatSync(destination, { throwIfNoEntry: false })) fail('ARCHIVE_DESTINATION_EXISTS', 'Archive destination already exists');
  return destination;
}
function inside(parent: string, child: string): boolean { const path = relative(parent, child); return !path || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); }
function fileName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || value.length > 4096 || isAbsolute(value) || value.split('/').some(item => !item || item === '.' || item === '..')) fail('ARCHIVE_MANIFEST_INVALID', 'Archive member path is invalid');
  return value;
}
function fileInfo(file: string): Stats {
  const info = regular(file);
  if (!info || info.size > ENGINE_ARCHIVE_LIMITS.maxFileBytes) fail('ARCHIVE_FILE_LIMIT', 'Archive members must be bounded regular files');
  return info;
}
/** Streaming reads bind both the open descriptor and the pathname to one stable original file. */
function stableFile(file: string, check: () => void, destination?: string): ArchiveFile {
  check(); const before = fileInfo(file), fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let out: number | undefined;
  try {
    if (!sameIdentity(before, fstatSync(fd))) fail('ARCHIVE_SOURCE_CHANGED', 'Archive member identity changed');
    if (destination) out = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(262_144); let position = 0;
    for (;;) {
      check(); const bytes = readSync(fd, buffer, 0, buffer.length, position);
      if (!bytes) break;
      position += bytes;
      if (position > ENGINE_ARCHIVE_LIMITS.maxFileBytes) fail('ARCHIVE_FILE_LIMIT', 'Archive member exceeded its byte limit');
      hash.update(buffer.subarray(0, bytes));
      if (out !== undefined) for (let written = 0; written < bytes;) written += writeSync(out, buffer, written, bytes - written);
    }
    const after = fstatSync(fd), current = fileInfo(file);
    if (!sameIdentity(before, after) || !sameIdentity(before, current) || before.size !== position || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== current.mtimeMs || before.ctimeMs !== current.ctimeMs) fail('ARCHIVE_SOURCE_CHANGED', 'Archive member changed during capture');
    if (out !== undefined) fsyncSync(out);
    return { file, bytes: position, sha256: hash.digest('hex') };
  } finally { if (out !== undefined) closeSync(out); closeSync(fd); }
}
function artifactFiles(root: string): string[] {
  const files: string[] = []; let total = 0, entries = 0;
  const walk = (directory: string, depth = 0): void => {
    if (depth > 64) fail('ARCHIVE_FILE_LIMIT', 'Artifact tree exceeds its directory depth budget');
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > ENGINE_ARCHIVE_LIMITS.maxFiles * 2) fail('ARCHIVE_FILE_LIMIT', 'Artifact tree exceeds its entry budget');
      const path = join(directory, entry.name), info = lstatSync(path);
      if (info.isSymbolicLink()) fail('ARCHIVE_PATH_UNSUPPORTED', 'Artifact symlinks cannot be archived');
      if (info.isDirectory()) walk(path, depth + 1);
      else {
        fileInfo(path); total += info.size; files.push(path);
        if (files.length > ENGINE_ARCHIVE_LIMITS.maxFiles || total > ENGINE_ARCHIVE_LIMITS.maxTotalBytes) fail('ARCHIVE_FILE_LIMIT', 'Artifact tree exceeds the archive budget');
      }
    }
  };
  walk(root); return files;
}
function directorySync(path: string): void { const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)); try { fsyncSync(fd); } finally { closeSync(fd); } }
function publish(staging: string, destination: string): void {
  if (lstatSync(destination, { throwIfNoEntry: false })) fail('ARCHIVE_DESTINATION_EXISTS', 'Archive destination already exists');
  // Reserve a private container exclusively, then atomically publish its complete payload.
  mkdirSync(destination, { mode: 0o700 }); const identity = lstatSync(destination);
  try { renameSync(staging, join(destination, 'data')); directorySync(destination); directorySync(dirname(destination)); }
  catch (error) { if (sameIdentity(identity, lstatSync(destination, { throwIfNoEntry: false }))) rmSync(destination, { recursive: true, force: true }); throw error; }
}
function manifestRoot(directory: string): string { return checkedDirectory(join(checkedDirectory(directory), 'data')); }
function sqlite(path: string): DatabaseSync {
  // Self-contained archive members cannot reconstruct WAL or SHM on the archive source.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const header = Buffer.alloc(100); if (readSync(fd, header, 0, 100, 0) !== 100 || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' || header[18] !== 1 || header[19] !== 1) fail('ARCHIVE_DATABASE_INVALID', 'Archive database must be a self-contained DELETE-mode SQLite file'); }
  finally { closeSync(fd); }
  const db = new DatabaseSync(path, { readOnly: true }); db.exec('PRAGMA trusted_schema=OFF'); return db;
}
function logicalDatabase(db: DatabaseSync, role: Role, check: () => void): { schemaVersion: number; logicalHash: string } {
  const schemaVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (role === 'primary') {
    databaseVersion(db);
    if (schemaVersion < 1) fail('ARCHIVE_DATABASE_INVALID', 'Primary archive database has no supported schema');
    const tables = schemaVersion >= 2 ? [...primaryTables, ...NATIVE_SESSION_TABLES] : primaryTables;
    const usageTables = schemaVersion >= 3 ? [...tables, 'attempt_usage'] : tables;
    const summaryTables = schemaVersion >= 4 ? [...usageTables, ...SUMMARY_STORAGE_TABLES] : usageTables;
    const recoveryTables = schemaVersion >= 5 ? [...summaryTables, ...SUMMARY_RECOVERY_TABLES] : summaryTables;
    const cleanupTables = schemaVersion >= 6 ? [...recoveryTables, ...ATTEMPT_CLEANUP_TABLES] : recoveryTables;
    const providerTables = schemaVersion >= 7 ? [...cleanupTables, ...PROVIDER_RECOVERY_TABLES] : cleanupTables;
    const mcpTables = schemaVersion >= 9 ? [...providerTables, ...MCP_EXECUTION_TABLES] : providerTables;
    if (schemaVersion >= 10) for (const table of KNOWLEDGE_STORAGE_TABLES) {
      for (const row of db.prepare(`SELECT id,workspace_id,length(CAST(data AS BLOB)) AS bytes,substr(data,1,65537) AS data FROM ${table} ORDER BY id`).iterate()) {
        check(); if (Number(row.bytes) > KNOWLEDGE_LIMITS.rowBytes) fail('ARCHIVE_KNOWLEDGE_INVALID', 'Archived knowledge row exceeds its bound');
        try { validateKnowledgeArchiveRow({ table, key: row.id, workspaceId: row.workspace_id, data: JSON.parse(String(row.data)) }); }
        catch { fail('ARCHIVE_KNOWLEDGE_INVALID', 'Archived workspace trust or pending knowledge record is invalid'); }
      }
    }
    if (schemaVersion >= 11) for (const table of KNOWLEDGE_GENERATION_TABLES) {
      for (const row of db.prepare(`SELECT id,workspace_id,length(CAST(data AS BLOB)) AS bytes,substr(data,1,65537) AS data FROM ${table} ORDER BY id`).iterate()) {
        check(); if (Number(row.bytes) > KNOWLEDGE_LIMITS.rowBytes) fail('ARCHIVE_KNOWLEDGE_INVALID', 'Archived generation row exceeds its bound');
        try { validateKnowledgeGenerationArchiveRow({ table, key: row.id, workspaceId: row.workspace_id, data: JSON.parse(String(row.data)) }); }
        catch { fail('ARCHIVE_KNOWLEDGE_INVALID', 'Archived native generation record is invalid'); }
      }
    }
    if (schemaVersion >= 11) {
      try { validateKnowledgeGenerationDatabase(db, check); }
      catch (error) {
        if (error instanceof EngineError && !error.code.startsWith('KNOWLEDGE_') && !error.code.startsWith('INVALID_KNOWLEDGE')) throw error;
        fail('ARCHIVE_KNOWLEDGE_INVALID', 'Archived native generation relationships are invalid');
      }
    }
    const knowledgeTables = schemaVersion >= 10 ? [...mcpTables, ...KNOWLEDGE_STORAGE_TABLES] : mcpTables;
    const generationTables = schemaVersion >= 11 ? [...knowledgeTables, ...KNOWLEDGE_GENERATION_TABLES] : knowledgeTables;
    if (schemaVersion >= 12) {
      try { validateKnowledgePublicationDatabase(db, check); }
      catch (error) {
        if (error instanceof EngineError && !error.code.startsWith('KNOWLEDGE_') && !error.code.startsWith('INVALID_KNOWLEDGE')) throw error;
        fail('ARCHIVE_KNOWLEDGE_INVALID', 'Archived workspace publication relationships are invalid');
      }
    }
    if (schemaVersion >= 13) {
      try { validateKnowledgeFilePublicationDatabase(db, check); validateKnowledgeFileExecutionGuards(db, check); }
      catch { fail('ARCHIVE_KNOWLEDGE_INVALID', 'Archived physical file publication relationships are invalid'); }
    }
    const publicationTables = schemaVersion >= 12 ? [...generationTables, ...KNOWLEDGE_PUBLICATION_TABLES] : generationTables;
    const fileTables = schemaVersion >= 13 ? [...publicationTables, ...KNOWLEDGE_FILE_PUBLICATION_TABLES, KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE] : publicationTables;
    if (schemaVersion >= 14) {
      try { validateDiagnosticExecutionObservationDatabase(db, check); }
      catch { fail('ARCHIVE_EXECUTION_OBSERVATION_INVALID', 'Archived original execution observations or effect epochs are invalid'); }
    }
    const observationTables = schemaVersion >= 14 ? [...fileTables, ...DIAGNOSTIC_EXECUTION_OBSERVATION_TABLES] : fileTables;
    if (schemaVersion >= 15) {
      try { validateKnowledgeImportRecoveryDatabase(db, check); }
      catch { fail('ARCHIVE_KNOWLEDGE_IMPORT_INVALID', 'Archived imported knowledge recovery decisions or activation lineage are invalid'); }
    }
    const importTables = schemaVersion >= 15 ? [...observationTables, ...KNOWLEDGE_IMPORT_RECOVERY_TABLES] : observationTables;
    if (schemaVersion >= 16) {
      try { validateProposalDatabase(db, check); }
      catch { fail('ARCHIVE_PROPOSAL_INVALID', 'Archived pending proposals or their original artifact owners are invalid'); }
    }
    const proposalTables = schemaVersion >= 16 ? [...importTables, ...PROPOSAL_TABLES] : importTables;
    if (schemaVersion >= 17) {
      try { validateProposalApplyDatabase(db, check); validateProposalApplyExecutionGuards(db, check); }
      catch { fail('ARCHIVE_DATABASE_INVALID', 'Proposal apply ownership, checkpoints, artifacts or receipt proofs are invalid'); }
    }
    const applyTables = schemaVersion >= 17 ? [...proposalTables, ...PROPOSAL_APPLY_TABLES, PROPOSAL_APPLY_GUARD_TABLE] : proposalTables;
    if (schemaVersion >= 18) {
      try { validateTeamDatabase(db, check); }
      catch { fail('ARCHIVE_TEAM_INVALID', 'Team membership, mailbox, board or actual input delivery relationships are invalid'); }
    }
    const teamTables = schemaVersion >= 18 ? [...applyTables, ...TEAM_TABLES] : applyTables;
    if (schemaVersion >= 19) {
      try { validateWorkflowDatabase(db, { check }); }
      catch { fail('ARCHIVE_WORKFLOW_INVALID', 'Archived workflow revisions, native stage ownership or transition receipts are invalid'); }
    }
    const workflowTables = schemaVersion >= 19 ? [...teamTables, ...WORKFLOW_TABLES] : teamTables;
    if (schemaVersion >= 20) {
      try { validateScheduleDatabase(db, { check }); }
      catch { fail('ARCHIVE_SCHEDULE_INVALID', 'Archived schedule revisions, occurrence ownership or actual input relationships are invalid'); }
    }
    return { schemaVersion, logicalHash: checkDatabase(db, schemaVersion, schemaVersion >= 20 ? [...workflowTables, ...SCHEDULE_TABLES] : workflowTables, check) };
  }
  if (role === 'review') return { schemaVersion, logicalHash: readOperations(db, check).logicalHash };
  if (role === 'ledger') return { schemaVersion, logicalHash: readAudits(db, check).logicalHash };
  const hasMarker = db.prepare("SELECT name FROM sqlite_schema WHERE name='command_execution'").get() !== undefined;
  if (hasMarker) {
    const rows = db.prepare('SELECT id,owner_pid,group_pid,active,updated_at FROM command_execution LIMIT 2').all();
    const validPid = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
    if (rows.length > 1 || rows.some(row => row.id !== 1 || !validPid(row.owner_pid) || row.group_pid !== null && !validPid(row.group_pid) || row.active !== 0 && row.active !== 1 || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at)))) fail('ARCHIVE_DATABASE_INVALID', 'Effect marker record is invalid');
  }
  return { schemaVersion, logicalHash: checkDatabase(db, 0, hasMarker ? ['command_execution'] : [], check) };
}
function validateReviewBindings(primary: DatabaseSync, review: DatabaseSync, check: () => void): void {
  for (const { operation } of readOperations(review, check).operations) {
    check();
    const run = primary.prepare('SELECT workspace_id,session_id,state FROM runs WHERE id=?').get(operation.runId);
    const checkpoint = primary.prepare("SELECT json_extract(data,'$.id') AS id,json_extract(data,'$.runId') AS run_id FROM checkpoints WHERE id=? AND run_id=?").get(operation.checkpointId, operation.runId);
    if (!run || run.workspace_id !== operation.workspaceId || run.session_id !== operation.sessionId || !['completed', 'cancelled', 'failed', 'interrupted'].includes(String(run.state)) || checkpoint?.id !== operation.checkpointId || checkpoint.run_id !== operation.runId) fail('ARCHIVE_DATABASE_INVALID', 'Unresolved review operation does not match its primary checkpoint and owner');
  }
}
function validateReviewFiles(root: string, check: () => void): void {
  const primary = sqlite(join(root, databaseFiles.primary));
  try { const review = sqlite(join(root, databaseFiles.review)); try { validateReviewBindings(primary, review, check); } finally { review.close(); } }
  finally { primary.close(); }
}
/** Selected document JSON shares one monotonic budget across primary and managed children. */
function primaryDocumentIndex(primary: DatabaseSync, frame: DocumentFrame): InputDocumentIndexReport {
  const metadata = primary.prepare(`SELECT length(CAST(d.data AS BLOB)) AS document_bytes,
    length(CAST(s.data AS BLOB)) AS session_bytes,length(CAST(w.data AS BLOB)) AS workspace_bytes,
    CASE WHEN json_valid(d.data) THEN json_array_length(d.data,'$.documents') ELSE NULL END AS reference_count
    FROM session_documents d LEFT JOIN sessions s ON s.id=d.session_id LEFT JOIN workspaces w ON w.id=s.workspace_id
    WHERE d.kind='input_documents' LIMIT 65`).all();
  if (metadata.length > 64) fail('ARCHIVE_DOCUMENT_INDEX_INVALID', 'Document indexes exceed the bounded session inspection');
  let bytes = 0,refs=0;
  if(metadata.length*3>frame.remainingRows)fail('ARCHIVE_DOCUMENT_INDEX_INVALID','Document index owner rows exceed the shared inspection budget');
  for(const row of metadata){if(!Number.isSafeInteger(row.reference_count)||Number(row.reference_count)<0||Number(row.reference_count)>32)fail('ARCHIVE_DOCUMENT_INDEX_INVALID','Document index reference count is invalid');refs+=Number(row.reference_count);}
  if(refs>frame.remainingRefs)fail('ARCHIVE_DOCUMENT_INDEX_INVALID','Document indexes exceed the shared reference inspection budget');
  for (const row of metadata) for (const [key, cap] of [['document_bytes', 262144], ['session_bytes', 16384], ['workspace_bytes', 16384]] as const) {
    if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0 || Number(row[key]) > cap) fail('ARCHIVE_DOCUMENT_INDEX_INVALID', 'Document index owner or payload is invalid');
    bytes += Number(row[key]);
  }
  if (bytes > frame.remainingMetadataBytes) fail('ARCHIVE_DOCUMENT_INDEX_INVALID', 'Document indexes exceed the shared metadata inspection budget');
  const index = inspectInputDocumentIndex(primary,{maxDocuments:Math.max(1,Math.min(64,Math.floor(frame.remainingRows/3))),maxRefs:Math.max(1,Math.min(2048,frame.remainingRefs)),maxJsonBytes:Math.max(1,Math.min(4194304,frame.remainingMetadataBytes))});
  frame.chargeIndex(index);
  return index;
}
function validateDocumentFiles(primary: DatabaseSync, artifactRoot: string, check: () => void, frame: DocumentFrame, providedIndex?: InputDocumentIndexReport, members?: readonly ArchiveFile[], artifactPrefix='artifacts'): InputDocumentIndexReport|undefined {
  const version = providedIndex ? Number(primary.prepare('PRAGMA child.user_version').get()?.user_version) : databaseVersion(primary);
  if (version < 2) return;
  check(); const index = providedIndex ?? primaryDocumentIndex(primary, frame);
  if (!index.complete) fail('ARCHIVE_DOCUMENT_INDEX_INVALID', 'Document indexes cannot be completely audited within archive limits');
  if(index.declaredBytes===null || index.declaredBytes>ENGINE_ARCHIVE_LIMITS.maxTotalBytes || index.refs.length>ENGINE_ARCHIVE_LIMITS.maxFiles) fail('ARCHIVE_FILE_LIMIT','Indexed document bytes exceed the archive budget');
  const refs = new Map(index.refs.map(ref => [`${ref.sessionId}:${ref.id}`,ref]));
  for (const ref of index.refs) {
    if (members) {
      const member=members.find(member=>member.file===`${artifactPrefix}/input-documents/${ref.id}.blob`);
      if (!member || member.bytes!==ref.bytes || member.sha256!==ref.sha256) fail('ARCHIVE_DOCUMENT_REFERENCE_INVALID','Indexed document blob is absent from the exact archive member allowlist');
    }
    check(); const file = join(artifactRoot,'input-documents',ref.id+'.blob'); checkedDirectory(dirname(file));
    const info = fileInfo(file); if (info.size !== ref.bytes) fail('ARCHIVE_DOCUMENT_INTEGRITY_FAILED', 'Document blob does not match its index');
    const actual = stableFile(file, check);
    if (actual.bytes !== ref.bytes || actual.sha256 !== ref.sha256) fail('ARCHIVE_DOCUMENT_INTEGRITY_FAILED', 'Document blob does not match its index');
    const fd = openSync(file,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameIdentity(info,fstatSync(fd))) fail('ARCHIVE_SOURCE_CHANGED','Document blob identity changed');
      const header=Buffer.alloc(9); const count=readSync(fd,header,0,9,0); validateDocumentBytes(header.subarray(0,count),'application/pdf');
      if (!sameIdentity(info,fstatSync(fd)) || !sameIdentity(info,fileInfo(file))) fail('ARCHIVE_SOURCE_CHANGED','Document blob identity changed');
    } finally { closeSync(fd); }
  }
  let returnedBytes=0;
  for (const table of ['inputs','runs','messages','session_inputs']) {
    check();
    const runBinding=table==='runs' ? 'r.id=d.id' : table==='inputs' ? '0' : 'r.id=d.run_id';
    const pendingBinding=table==='session_inputs' ? 'd.run_id IS NULL' : '0';
    const recordIdentity=table==='inputs' ? '1' : "json_extract(d.data,'$.id')=d.id";
    const recordRun=table==='messages' ? "json_extract(d.data,'$.runId')=d.run_id" : table==='session_inputs' ? "json_extract(d.data,'$.runId') IS d.run_id" : '1';
    const recordWorkspace=table==='runs'||table==='session_inputs' ? "d.workspace_id=s.workspace_id AND json_extract(d.data,'$.workspaceId')=d.workspace_id" : '1';
    const rows=primary.prepare(`SELECT CAST(d.rowid AS TEXT) AS row_id,
      CASE WHEN length(CAST(d.session_id AS BLOB)) BETWEEN 1 AND 256 THEN d.session_id ELSE NULL END AS session_id,
      s.id IS NOT NULL AS has_session,w.id IS NOT NULL AS has_workspace,
      CASE WHEN ?='inputs' THEN 1 WHEN ?='session_inputs' AND ${pendingBinding} THEN 1 ELSE r.session_id=d.session_id AND r.workspace_id=s.workspace_id END AS run_owner_valid,
      json_extract(d.data,'$.sessionId')=d.session_id AS payload_session_valid,
      ${recordIdentity} AS payload_id_valid,${recordRun} AS payload_run_valid,${recordWorkspace} AS payload_workspace_valid,
      json_type(d.data,'$.documents') AS document_type,length(CAST(json_extract(d.data,'$.documents') AS BLOB)) AS document_bytes,json_array_length(d.data,'$.documents') AS document_count,
      CASE WHEN ?='messages' AND length(CAST(json_extract(d.data,'$.role') AS BLOB))<=16 THEN json_extract(d.data,'$.role') ELSE NULL END AS role
      FROM ${table} d LEFT JOIN sessions s ON s.id=d.session_id LEFT JOIN workspaces w ON w.id=s.workspace_id LEFT JOIN runs r ON ${runBinding}
      WHERE json_type(d.data,'$.documents') IS NOT NULL AND json_type(d.data,'$.documents')!='null' LIMIT ${Math.min(4097,frame.remainingRows+1)}`).all(table,table,table);
    if(rows.length>4096) fail('ARCHIVE_DOCUMENT_REFERENCE_LIMIT','Document references exceed the archive inspection budget');
    frame.chargeRows(rows.length);
    for(const row of rows) {
      check(); const bytes=Number(row.document_bytes),count=Number(row.document_count);
      if(row.session_id===null || row.has_session!==1 || row.has_workspace!==1 || row.run_owner_valid!==1 || row.payload_session_valid!==1 || row.payload_id_valid!==1 || row.payload_run_valid!==1 || row.payload_workspace_valid!==1 || row.document_type!=='array' || !Number.isSafeInteger(bytes) || bytes<2 || bytes>4096 || returnedBytes+bytes>1_048_576 || !Number.isSafeInteger(count) || count<0 || count>1 || count>frame.remainingRefs || table==='messages' && row.role!=='user') fail('ARCHIVE_DOCUMENT_REFERENCE_INVALID','Document reference owner or size is invalid');
      frame.charge(bytes);
      frame.chargeRefs(count);
      const value=primary.prepare(`SELECT json_extract(data,'$.documents') AS refs FROM ${table} WHERE rowid=? AND length(CAST(json_extract(data,'$.documents') AS BLOB))=?`).get(String(row.row_id),bytes);
      if(!value) fail('ARCHIVE_SOURCE_CHANGED','Document reference changed during inspection'); returnedBytes+=bytes;
      const observations=documentAttachments(JSON.parse(String(value.refs)));if(observations.length!==count)fail('ARCHIVE_SOURCE_CHANGED','Document reference count changed');
      for(const ref of observations) {
        const owner=refs.get(`${String(row.session_id)}:${ref.id}`);
        if(!owner || !sameDocumentAttachment(owner,ref)) fail('ARCHIVE_DOCUMENT_REFERENCE_INVALID','Document reference does not belong to its indexed session');
      }
    }
  }
  return index;
}
function validateDocumentArchive(root: string, manifest:EngineArchiveManifest,check: () => void, frame: DocumentFrame): void {
  const primary=sqlite(join(root,databaseFiles.primary));
  try { primary.exec('BEGIN');validateDocumentFiles(primary,join(root,'artifacts'),check,frame,undefined,manifest.artifacts); } finally { primary.close(); }
}
interface ChildSelection { records: ChildStorageRecord[]; unchecked: ArchiveDocumentAudit['unchecked'] }
/** Discover only the bounded primary task journal. Unknown SQLite artifact files are never opened. */
function selectArchiveChildren(primary: DatabaseSync, hostIdentity: ChildStorageHostIdentity, childrenDirectory: string, frame: DocumentFrame, mode: 'source' | 'archive-historical', check: () => void): ChildSelection {
  if (databaseVersion(primary) < 2) return { records: [], unchecked: [] };
  const metadata = primary.prepare(`SELECT CASE WHEN length(CAST(session_id AS BLOB)) BETWEEN 1 AND 256 THEN session_id ELSE NULL END AS session_id,length(CAST(data AS BLOB)) AS bytes
    FROM session_documents WHERE kind='engine.child_tasks' ORDER BY session_id LIMIT 33`).all();
  if (metadata.length > 32) fail('ARCHIVE_CHILD_LIMIT', 'Child task journals exceed the archive inspection bound');
  frame.chargeRows(metadata.length);
  const allIds = new Set<string>(),taskOwners=new Map<string,string>(), groups: Array<{ sessionId: string; sourceRunId: string; taskIds: string[]; states: Map<string, string> }> = [];
  for (const row of metadata) {
    check(); const bytes=Number(row.bytes);
    if (typeof row.session_id !== 'string' || Buffer.byteLength(row.session_id)>256 || !Number.isSafeInteger(bytes) || bytes<2 || bytes>245760) fail('ARCHIVE_CHILD_JOURNAL_INVALID','Child task journal owner or size is invalid');
    const owner=primary.prepare('SELECT s.id IS NOT NULL AND s.workspace_id=w.id AS valid FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE s.id=?').get(row.session_id);
    if (owner?.valid!==1) fail('ARCHIVE_CHILD_JOURNAL_INVALID','Child task journal owner is invalid');
    frame.charge(bytes);
    const body=primary.prepare("SELECT data FROM session_documents WHERE session_id=? AND kind='engine.child_tasks' AND length(CAST(data AS BLOB))=?").get(row.session_id,bytes);
    if (!body || typeof body.data!=='string') fail('ARCHIVE_SOURCE_CHANGED','Child task journal changed');
    const journal=JSON.parse(body.data) as { schemaVersion?: unknown; tasks?: unknown };
    if (journal.schemaVersion!==1 || !Array.isArray(journal.tasks) || journal.tasks.length>32) fail('ARCHIVE_CHILD_JOURNAL_INVALID','Child task journal is unsupported');
    for (const item of journal.tasks) {
      const task=item as { id?: unknown; sessionId?: unknown; rootRunId?: unknown; state?: unknown };
      if (!task || typeof task.id!=='string' || !/^child_[a-f0-9]{32}$/.test(task.id) || task.sessionId!==row.session_id || typeof task.rootRunId!=='string' || !task.rootRunId || Buffer.byteLength(task.rootRunId)>256 || typeof task.state!=='string' || allIds.has(task.id)) fail('ARCHIVE_CHILD_JOURNAL_INVALID','Child task identity is invalid');
      allIds.add(task.id);taskOwners.set(task.id,row.session_id); if (allIds.size>32) fail('ARCHIVE_CHILD_LIMIT','Managed child storage exceeds the archive child limit');
      let group=groups.find(group=>group.sessionId===row.session_id && group.sourceRunId===task.rootRunId);
      if (!group) { group={sessionId:row.session_id,sourceRunId:task.rootRunId,taskIds:[],states:new Map()}; groups.push(group); }
      group.taskIds.push(task.id); group.states.set(task.id,task.state);
    }
  }
  const declared=primary.prepare("SELECT CASE WHEN length(CAST(kind AS BLOB))<=256 THEN kind ELSE NULL END AS kind,CASE WHEN length(CAST(session_id AS BLOB)) BETWEEN 1 AND 256 THEN session_id ELSE NULL END AS session_id FROM session_documents WHERE kind GLOB 'child.storage.*' LIMIT 33").all();
  if (declared.length>32 || declared.some(row=>typeof row.kind!=='string' || typeof row.session_id!=='string' || taskOwners.get(row.kind.slice('child.storage.'.length))!==row.session_id)) fail('ARCHIVE_CHILD_JOURNAL_INVALID','Child storage bindings lack a bounded task journal owner');
  const records: ChildStorageRecord[]=[],unchecked: ArchiveDocumentAudit['unchecked']=[];
  for (const group of groups) {
    const selection=readChildStorageSelection(primary,{sessionId:group.sessionId,sourceRunId:group.sourceRunId,taskIds:group.taskIds,hostIdentity,childrenDirectory,mode},frame);
    frame.chargeRows(selection.selections.length);
    for (const item of selection.selections) {
      check();
      if (['starting','running','cancelling'].includes(group.states.get(item.taskId)!)) fail('ARCHIVE_CHILD_ACTIVE','Archive requires every managed child task to be stopped');
      if (item.status==='legacy') { unchecked.push({taskId:item.taskId,reason:'legacy-unbound'}); continue; }
      if (item.record && canonical(item.record.binding.hostIdentity)===canonical(hostIdentity) && (item.status==='archive-unsupported' || item.status==='relocated' && item.record.binding.childrenDirectory!==childrenDirectory && !inside(hostIdentity.artifacts.path,item.record.binding.childrenDirectory))) { unchecked.push({taskId:item.taskId,reason:'external-child-storage'}); continue; }
      if (!item.record || item.status!==(mode==='source'?'eligible':'historical')) fail('ARCHIVE_CHILD_INVALID','Managed child storage has no exact stopped ownership proof');
      if (mode==='archive-historical' && canonical(item.record.binding.hostIdentity)!==canonical(hostIdentity)) fail('ARCHIVE_CHILD_INVALID','Historical child storage has a different root owner');
      records.push(item.record);
    }
  }
  return {records,unchecked};
}
function assertAuditManifest(manifest: EngineArchiveManifest): void {
  const audit=manifest.documentAudit; if (audit===undefined) return;
  const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>Boolean(value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key)));
  if (!exact(audit,['version','coverage','primary','children','unchecked']) || audit.version!==1 || audit.primary!=='verified' || !['complete','partial'].includes(audit.coverage) || !Array.isArray(audit.children) || !Array.isArray(audit.unchecked) || audit.children.length+audit.unchecked.length>32 || (audit.unchecked.length===0)!==(audit.coverage==='complete')) fail('ARCHIVE_MANIFEST_INVALID','Document audit metadata is invalid');
  const ids=new Set<string>();
  for (const item of audit.children) {
    if (!exact(item,['taskId','record','database','artifactPrefix']) || typeof item.taskId!=='string' || !/^child_[a-f0-9]{32}$/.test(item.taskId) || ids.has(item.taskId) || !exact(item.database,['file','bytes','sha256','schemaVersion','logicalHash'])) fail('ARCHIVE_MANIFEST_INVALID','Child audit identity is invalid');
    ids.add(item.taskId); const record=validateChildStorageRecord(item.record);
    const prefix=`artifacts/children/${item.taskId}`;
    if (record.binding.lineage.taskId!==item.taskId || !record.confirmedClose || record.binding.phase!=='admitted' || item.database.file!==`${prefix}/engine.sqlite` || item.artifactPrefix!==`${prefix}/artifacts` || !Number.isSafeInteger(item.database.schemaVersion) || item.database.schemaVersion<2 || item.database.schemaVersion>DB_VERSION || !/^[a-f0-9]{64}$/.test(item.database.logicalHash)) fail('ARCHIVE_MANIFEST_INVALID','Child database audit metadata is invalid');
    const member=manifest.artifacts.find(member=>member.file===item.database.file);
    if (!member || canonical(member)!==canonical({file:item.database.file,bytes:item.database.bytes,sha256:item.database.sha256}) || manifest.artifacts.some(member=>member.file.startsWith(`${prefix}/engine.sqlite-`) || member.file.startsWith(`${prefix}/engine.sqlite.owner.sqlite`))) fail('ARCHIVE_MANIFEST_INVALID','Child database archive allowlist differs from the audit');
  }
  for (const item of audit.unchecked) {
    if (!exact(item,['taskId','reason']) || typeof item.taskId!=='string' || !/^child_[a-f0-9]{32}$/.test(item.taskId) || ids.has(item.taskId) || !['legacy-unbound','external-child-storage'].includes(item.reason)) fail('ARCHIVE_MANIFEST_INVALID','Unchecked child coverage is invalid');
    ids.add(item.taskId);
  }
}
function historicalHost(manifest: EngineArchiveManifest): ChildStorageHostIdentity {
  return {database:{path:manifest.source.dbPath,dev:String(manifest.source.binding.db.dev),ino:String(manifest.source.binding.db.ino)},artifacts:{path:manifest.source.artifactDir,dev:String(manifest.source.binding.artifacts.dev),ino:String(manifest.source.binding.artifacts.ino)}};
}
type ChildIndexCollector = (record: ChildStorageRecord, index: InputDocumentIndexReport) => void;
function requireTeamChildCoverage(primary: DatabaseSync, records: readonly ChildStorageRecord[], check: () => void): void {
  if (databaseVersion(primary) < 18) return;
  for (const row of primary.prepare("SELECT json_extract(data,'$.owner.childTaskId') AS task_id,json_extract(data,'$.owner.childStorageSha256') AS binding_sha FROM team_deliveries WHERE state='delivered' ORDER BY id").iterate()) {
    check();
    if (!records.some(record => record.binding.lineage.taskId === row.task_id && record.sha256 === row.binding_sha)) fail('ARCHIVE_TEAM_CHILD_UNCHECKED','Delivered team input requires its exact typed child audit; historical or unconfirmed child rebinding is unsupported');
  }
}
function validateChildDocumentArchive(root:string,manifest:EngineArchiveManifest,frame:DocumentFrame,check:()=>void,collect?:ChildIndexCollector):void {
  const primary=sqlite(join(root,databaseFiles.primary)), readers:ReturnType<typeof openChildDocumentReader>[]=[];
  try {
    primary.exec('BEGIN');
    if (!manifest.documentAudit) {
      requireTeamChildCoverage(primary,[],check);
      if(databaseVersion(primary)>=2 && primary.prepare("SELECT 1 FROM session_documents WHERE kind GLOB 'child.storage.*' LIMIT 1").get())fail('ARCHIVE_CHILD_AUDIT_REQUIRED','Typed child storage bindings require an explicit archive audit');
      return; // Genuine legacy bundles retain unchecked owned-child coverage.
    }
    const selected=selectArchiveChildren(primary,historicalHost(manifest),join(manifest.source.artifactDir,'children'),frame,'archive-historical',check);
    const audit=manifest.documentAudit;
    requireTeamChildCoverage(primary,selected.records,check);
    if (canonical(selected.unchecked)!==canonical(audit.unchecked) || selected.records.length!==audit.children.length) fail('ARCHIVE_CHILD_INVALID','Child audit coverage differs from the archived root journal');
    for (const record of selected.records) {
      const item=audit.children.find(item=>item.taskId===record.binding.lineage.taskId);
      if (!item || canonical(item.record)!==canonical(record)) fail('ARCHIVE_CHILD_INVALID','Child audit record differs from its immutable root binding');
      const childDb=sqlite(join(root,item.database.file));
      try {
        const actual=logicalDatabase(childDb,'primary',check); if (actual.schemaVersion!==item.database.schemaVersion || actual.logicalHash!==item.database.logicalHash) fail('ARCHIVE_CHILD_INVALID','Child logical database differs from its audited snapshot');
        try { validateTeamChildInputRelations(primary,childDb,record,check); }
        catch { fail('ARCHIVE_TEAM_INVALID','Team delivery receipt differs from the actual admitted child input'); }
      } finally { childDb.close(); }
      const reader=openChildDocumentReader({mode:'archive-historical',record,archive:{database:{path:join(root,item.database.file),bytes:item.database.bytes,sha256:item.database.sha256},artifacts:{path:join(root,item.artifactPrefix)},allowedMembers:manifest.artifacts.filter(member=>member.file.startsWith(`artifacts/children/${item.taskId}/`)),artifactPrefix:item.artifactPrefix}},frame);readers.push(reader);
      const index=reader.readIndex();
      validateDocumentFiles(reader.db,join(root,item.artifactPrefix),()=>{check();reader.check();},frame,index,manifest.artifacts,item.artifactPrefix); reader.check();
      collect?.(record,index);
    }
  } finally { for (const reader of readers.reverse()) reader.close(); primary.close(); }
}
function parseManifest(file: string): { manifest: EngineArchiveManifest; manifestSha256: string } {
  if (fileInfo(file).size > ENGINE_ARCHIVE_LIMITS.maxManifestBytes) fail('ARCHIVE_MANIFEST_INVALID', 'Archive manifest exceeded its byte limit');
  const raw = readFileSync(file), value = JSON.parse(raw.toString('utf8')) as EngineArchiveManifest;
  if (!value || value.archiveVersion !== ENGINE_ARCHIVE_VERSION || typeof value.archiveId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.archiveId) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || value.recoveryAcknowledgmentsRebound !== false || !value.source || typeof value.source.dbPath !== 'string' || typeof value.source.artifactDir !== 'string' || !value.source.binding || !/^[a-f0-9]{64}$/.test(value.source.bindingScope)) fail('ARCHIVE_MANIFEST_INVALID', 'Archive manifest is unsupported or invalid');
  for (const name of ['db', 'review', 'artifacts'] as const) {
    const identity = value.source.binding[name];
    if (!identity || !Number.isSafeInteger(identity.dev) || !Number.isSafeInteger(identity.ino) || identity.dev < 0 || identity.ino < 0) fail('ARCHIVE_MANIFEST_INVALID', 'Archive source binding is invalid');
  }
  if (digest(canonical(value.source.binding)) !== value.source.bindingScope) fail('ARCHIVE_MANIFEST_INVALID', 'Archive source binding hash does not match');
  if (!Array.isArray(value.databases) || !Array.isArray(value.artifacts) || value.databases.length < 2 || value.databases.length > 4 || value.artifacts.length > ENGINE_ARCHIVE_LIMITS.maxFiles) fail('ARCHIVE_MANIFEST_INVALID', 'Archive file lists are invalid');
  const names = new Set<string>(), roles = new Set<string>(); let bytes = 0;
  for (const item of [...value.databases, ...value.artifacts]) {
    fileName(item.file);
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > ENGINE_ARCHIVE_LIMITS.maxFileBytes || !/^[a-f0-9]{64}$/.test(item.sha256) || names.has(item.file)) fail('ARCHIVE_MANIFEST_INVALID', 'Archive file metadata is invalid');
    names.add(item.file); bytes += item.bytes;
  }
  for (const item of value.databases) {
    if (!Object.hasOwn(databaseFiles, item.role) || item.file !== databaseFiles[item.role] || roles.has(item.role) || !Number.isSafeInteger(item.schemaVersion) || !/^[a-f0-9]{64}$/.test(item.logicalHash)) fail('ARCHIVE_MANIFEST_INVALID', 'Archive database metadata is invalid');
    if (item.schemaVersion !== (item.role === 'effect' ? 0 : item.role === 'primary' ? Math.min(item.schemaVersion, DB_VERSION) : 1) || item.role !== 'effect' && item.schemaVersion < 1) fail('DB_VERSION_UNSUPPORTED', 'Archive database version is unsupported');
    roles.add(item.role);
  }
  if (!roles.has('primary') || !roles.has('review') || bytes > ENGINE_ARCHIVE_LIMITS.maxTotalBytes || value.artifacts.some(item => !item.file.startsWith('artifacts/'))) fail('ARCHIVE_MANIFEST_INVALID', 'Archive does not contain the required bounded engine data');
  assertAuditManifest(value);
  return { manifest: value, manifestSha256: digest(raw) };
}
function validateParsedArchive(root:string,parsed:ReturnType<typeof parseManifest>,check:()=>void,frame:DocumentFrame|(()=>DocumentFrame),collect?:ChildIndexCollector):void {
  const initialManifestHash = parsed.manifestSha256;
  for (const item of [...parsed.manifest.databases, ...parsed.manifest.artifacts]) {
    const file = join(root, item.file); checkedDirectory(dirname(file));
    const actual = stableFile(file, check);
    if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) fail('ARCHIVE_HASH_MISMATCH', 'Archive member hash or size does not match its manifest');
  }
  for (const item of parsed.manifest.databases) {
    const db = sqlite(join(root, item.file));
    try { const actual = logicalDatabase(db, item.role, check); if (actual.schemaVersion !== item.schemaVersion || actual.logicalHash !== item.logicalHash) fail('ARCHIVE_DATABASE_INVALID', 'Archive database logical content does not match'); }
    finally { db.close(); }
  }
  validateReviewFiles(root, check);
  // Preserve the existing validator's proof-only deadline. An explicit
  // inspection supplies its already-started operation-wide frame instead.
  const proofFrame=typeof frame==='function'?frame():frame;
  validateDocumentArchive(root,parsed.manifest,check,proofFrame);
  validateChildDocumentArchive(root,parsed.manifest,proofFrame,check,collect);
  if (parseManifest(join(root, 'manifest.json')).manifestSha256 !== initialManifestHash) fail('ARCHIVE_SOURCE_CHANGED', 'Archive manifest changed during validation');
  check();
}
export function validateEngineArchive(options: { directory: string; signal?: AbortSignal }): EngineArchiveResult {
  const root = manifestRoot(options.directory), check = () => abort(options.signal);
  check(); const parsed = parseManifest(join(root, 'manifest.json'));
  validateParsedArchive(root,parsed,check,()=>createChildDocumentReadFrame({signal:options.signal}));
  return { directory: checkedDirectory(options.directory), ...parsed };
}
/** Scalar owner/task preflight precedes selected index bodies; no current-host authority is accepted. */
function preflightArchivedChildSelection(root:string,request:ReturnType<typeof validateArchivedChildDocumentStorageRequest>,frame:DocumentFrame,check:()=>void):void {
  const primary=sqlite(join(root,databaseFiles.primary));
  try {
    primary.exec('BEGIN');check();frame.chargeRows(1);
    const owner=primary.prepare(`SELECT 1 AS matched FROM runs r JOIN sessions s ON s.id=r.session_id JOIN workspaces w ON w.id=r.workspace_id
      WHERE r.id=? AND r.session_id=? AND s.workspace_id=r.workspace_id
      AND length(CAST(r.id AS BLOB)) BETWEEN 1 AND 256 AND length(CAST(r.session_id AS BLOB)) BETWEEN 1 AND 256 AND length(CAST(r.workspace_id AS BLOB)) BETWEEN 1 AND 256
      AND json_extract(r.data,'$.id')=r.id AND json_extract(r.data,'$.sessionId')=s.id AND json_extract(r.data,'$.workspaceId')=w.id
      AND json_extract(s.data,'$.id')=s.id AND json_extract(s.data,'$.workspaceId')=w.id AND json_extract(w.data,'$.id')=w.id LIMIT 1`).get(request.sourceRunId,request.sessionId);
    if(!owner)fail('ARCHIVE_CHILD_OWNER_MISMATCH','Archived Run/session/workspace owner differs from the requested selection');
    frame.charge(Buffer.byteLength(JSON.stringify(owner)));
    if(request.taskIds.length===0)return;
    if(databaseVersion(primary)<2)fail('ARCHIVE_CHILD_TASK_NOT_FOUND','Archived task is absent from the native root journal');
    check();frame.chargeRows(1);
    const header=primary.prepare("SELECT length(CAST(data AS BLOB)) AS bytes FROM session_documents WHERE session_id=? AND kind='engine.child_tasks' LIMIT 1").get(request.sessionId);
    if(!header)fail('ARCHIVE_CHILD_TASK_NOT_FOUND','Archived child task journal is absent');
    const bytes=Number(header.bytes);
    if(!Number.isSafeInteger(bytes)||bytes<2||bytes>245760)fail('ARCHIVE_CHILD_JOURNAL_INVALID','Archived child task journal exceeds its bounded format');
    // JSON is inspected by SQLite; only bounded booleans escape this query. The
    // authoritative journal body is read/charged once by the whole audit below.
    for(const taskId of request.taskIds){
      check();frame.chargeRows(1);
      const rows=primary.prepare(`SELECT json_extract(d.data,'$.schemaVersion')=1 AND json_type(d.data,'$.tasks')='array' AND json_array_length(d.data,'$.tasks')<=32
        AND t.type='object' AND json_extract(t.value,'$.sessionId')=? AND json_extract(t.value,'$.rootRunId')=? AS matched
        FROM session_documents d,json_each(d.data,'$.tasks') t WHERE d.session_id=? AND d.kind='engine.child_tasks'
        AND length(CAST(d.data AS BLOB))=? AND json_extract(t.value,'$.id')=? LIMIT 2`).all(request.sessionId,request.sourceRunId,request.sessionId,bytes,taskId);
      if(rows.length===0)fail('ARCHIVE_CHILD_TASK_NOT_FOUND','Selected task does not exist in the archived root session');
      if(rows.length!==1||rows[0]!.matched!==1)fail('ARCHIVE_CHILD_OWNER_MISMATCH','Selected task belongs to different archived source lineage');
      frame.charge(Buffer.byteLength(JSON.stringify(rows)));
    }
  }finally{primary.close();}
}
/** Detached historical inspection. Whole archive validation and selected-proof budgets have distinct scopes. */
export async function inspectArchivedChildDocumentStorage(value:ArchivedChildDocumentStorageRequest):Promise<ArchivedChildDocumentStorageReport>{
  const request=validateArchivedChildDocumentStorageRequest(value);
  try{
    const {maxReportBytes:_maxReportBytes,maxDocumentSamples:_maxDocumentSamples,maxChildren:_requestedTaskCap,...readLimits}=request.limits;
    // The requested subset has its own cap. All verified archive children still
    // undergo the existing audit (manifest hard limit 32) in the same proof frame.
    const frame=createChildDocumentReadFrame({...(request.signal?{signal:request.signal}:{}),limits:{...readLimits,maxChildren:32}});
    const check=()=>{abort(request.signal);frame.check();};
    await new Promise<void>(resolve=>setImmediate(resolve));check();
    const root=manifestRoot(request.directory),parsed=parseManifest(join(root,'manifest.json'));
    if(parsed.manifestSha256!==request.expectedManifestSha256)fail('ARCHIVE_MANIFEST_SHA_MISMATCH','Archive manifest differs from the explicitly selected historical digest');
    preflightArchivedChildSelection(root,request,frame,check);
    const selectedIds=new Set(request.taskIds),indexes=new Map<string,{record:ChildStorageRecord;index:InputDocumentIndexReport}>();
    validateParsedArchive(root,parsed,check,frame,(record,index)=>{
      const taskId=record.binding.lineage.taskId;
      if(selectedIds.has(taskId)){
        if(indexes.has(taskId)||indexes.size>=request.limits.maxChildren)fail('ARCHIVE_CHILD_REPORT_INVALID','Archive index collector differs from its bounded requested subset');
        indexes.set(taskId,{record,index});
      }
    });
    const audit=parsed.manifest.documentAudit;
    const observations=request.taskIds.map(taskId=>{
      const observed=indexes.get(taskId);
      if(observed){const binding=observed.record.binding,lineage=binding.lineage;return{taskId,status:'observed' as const,index:observed.index,childSessionId:binding.child.sessionId,childRunId:binding.child.runId!,
        lineage:{rootRunId:lineage.sourceRunId,parentRunId:lineage.parentRunId,...(lineage.parentTaskId?{parentTaskId:lineage.parentTaskId}:{}),taskRequestId:lineage.taskRequestId,depth:lineage.depth}};}
      const unchecked=audit?.unchecked.find(item=>item.taskId===taskId);
      if(audit&&!unchecked)fail('ARCHIVE_CHILD_INVALID','Requested task has no matching validated archive audit entry');
      return{taskId,status:'unchecked' as const,reason:unchecked?.reason??'legacy-unbound'};
    });
    check();
    const report=buildArchivedChildDocumentStorageReport({archiveId:parsed.manifest.archiveId,manifestSha256:parsed.manifestSha256,expectedManifestSha256:request.expectedManifestSha256,
      sessionId:request.sessionId,sourceRunId:request.sourceRunId,archiveDocumentAuditCoverage:audit?.coverage??'unchecked',requestedTaskIds:request.taskIds,observations,stats:frame.stats(),limits:request.limits});
    // No I/O occurs in the pure builder; retain cancellation and the final exact
    // manifest check immediately before publishing its detached bounded result.
    if(parseManifest(join(root,'manifest.json')).manifestSha256!==request.expectedManifestSha256)fail('ARCHIVE_SOURCE_CHANGED','Archive manifest changed before historical inspection completed');
    check();return report;
  }catch(error){if(error instanceof EngineError)throw error;fail('ARCHIVE_DATABASE_INVALID','Historical archive inspection could not validate its bounded read-only selection');}
  finally{request.releaseSignal();}
}
/** Offline export: leases block engine/review/recovery writes across the entire capture. */
export async function exportEngineArchive(options: ExportEngineArchiveOptions): Promise<EngineArchiveResult> {
  abort(options.signal); const paths = recoveryPaths(options), destination = destinationPath(options.destination);
  if (inside(paths.artifacts, destination)) fail('ARCHIVE_PATH_UNSUPPORTED', 'Archive destination must be outside the source artifact tree');
  if (!regular(paths.db) || !regular(paths.review)) fail('ARCHIVE_DATABASE_MISSING', 'Archive requires primary and review databases');
  const leases: ReturnType<typeof acquireRecoveryLease>[] = [];
  const childReaders: ReturnType<typeof openChildDocumentReader>[]=[];
  let snapshot: ReturnType<typeof takeSnapshot> | undefined, staging: string | undefined;
  try {
    leases.push(acquireRecoveryLease(paths.db + '.owner.sqlite', 'owner'));
    leases.push(acquireRecoveryLease(paths.review + '.owner.sqlite', 'owner'));
    if (regular(paths.effect)) leases.push(acquireRecoveryLease(paths.effect, 'effect'));
    leases.push(acquireRecoveryLease(paths.db, 'source'));
    leases.push(acquireRecoveryLease(paths.review, 'source'));
    if (regular(paths.ledger)) leases.push(acquireRecoveryLease(paths.ledger, 'source'));
    snapshot = takeSnapshot(paths);
    const effect = snapshot.open('effect');
    if (effect) {
      try { if (effect.prepare("SELECT name FROM sqlite_schema WHERE name='command_execution'").get() && effect.prepare('SELECT 1 FROM command_execution WHERE active=1 LIMIT 1').get()) fail('ARCHIVE_EFFECT_ACTIVE', 'Archive requires stopped effects and reconciled execution markers'); }
      finally { effect.close(); }
    }
    const rootIdentity = lstatSync(paths.artifacts);
    const check = () => { abort(options.signal); for (const lease of leases) if (!sameIdentity(lease.identity, regular(lease.file))) fail('ARCHIVE_SOURCE_CHANGED', 'Source database lease identity changed'); if (!sameIdentity(rootIdentity, lstatSync(paths.artifacts))) fail('ARCHIVE_SOURCE_CHANGED', 'Source artifact directory identity changed'); for(const reader of childReaders)reader.check(); };
    staging = mkdtempSync(join(dirname(destination), '.moodcode-archive-')); mkdirSync(join(staging, 'artifacts'), { mode: 0o700 });
    const databases: ArchiveDatabase[] = [];
    for (const [key, role] of [['db', 'primary'], ['review', 'review'], ['ledger', 'ledger'], ['effect', 'effect']] as const) {
      const db = snapshot.open(key); if (!db) continue;
      try {
        const metadata = logicalDatabase(db, role, check);
        const output = join(staging, databaseFiles[role]); await backupDatabase(db, output, metadata.schemaVersion, check);
        const content = stableFile(output, check); databases.push({ ...content, file: databaseFiles[role], role, ...metadata });
      } finally { db.close(); }
    }
    const primary = snapshot.open('db')!;
    try { const review = snapshot.open('review')!; try { validateReviewBindings(primary, review, check); } finally { review.close(); } }
    finally { primary.close(); }
    const frame=createChildDocumentReadFrame({signal:options.signal}),documentPrimary=sqlite(join(staging,databaseFiles.primary)),expectedDocuments=new Map<string,{bytes:number;sha256:string}>();
    const pinDocuments=(index:InputDocumentIndexReport|undefined,prefix:string)=>{for(const ref of index?.refs??[])expectedDocuments.set(`${prefix}/input-documents/${ref.id}.blob`,{bytes:ref.bytes,sha256:ref.sha256});};
    let childSelection:ChildSelection;
    try {
      documentPrimary.exec('BEGIN');
      pinDocuments(validateDocumentFiles(documentPrimary,paths.artifacts,check,frame),'artifacts');
      childSelection=selectArchiveChildren(documentPrimary,{database:childStoragePhysicalIdentity(paths.db),artifacts:childStoragePhysicalIdentity(paths.artifacts,true)},join(paths.artifacts,'children'),frame,'source',check);
      requireTeamChildCoverage(documentPrimary,childSelection.records,check);
    } finally { documentPrimary.close(); }
    const documentAudit:ArchiveDocumentAudit={version:1,coverage:childSelection.unchecked.length?'partial':'complete',primary:'verified',children:[],unchecked:childSelection.unchecked};
    const replaced=new Set<string>(),excluded=new Set<string>();
    const artifacts: ArchiveFile[]=[];
    for(const record of childSelection.records) {
      const reader=openChildDocumentReader({mode:'source',record},frame);childReaders.push(reader);
      pinDocuments(validateDocumentFiles(reader.db,record.binding.physical.artifacts.path,check,frame,reader.readIndex()),`artifacts/children/${record.binding.lineage.taskId}/artifacts`);
      const taskId=record.binding.lineage.taskId,name=`artifacts/children/${taskId}/engine.sqlite`,output=join(staging,name);
      mkdirSync(dirname(output),{recursive:true,mode:0o700});
      const fd=openSync(output,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600),identity=fstatSync(fd);closeSync(fd);
      await sqliteBackup(reader.db,output,{source:reader.sourceName,rate:32,progress:()=>check()});check();
      if(!sameIdentity(identity,fileInfo(output)))fail('ARCHIVE_SOURCE_CHANGED','Child backup staging identity changed');
      const captured=new DatabaseSync(output);let metadata:{schemaVersion:number;logicalHash:string};
      try {
        captured.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');metadata=logicalDatabase(captured,'primary',check);
        const capturedPrimary=sqlite(join(staging,databaseFiles.primary));
        try {
          try { validateTeamChildInputRelations(capturedPrimary,captured,record,check); }
          catch { fail('ARCHIVE_TEAM_INVALID','Captured team receipt differs from the actual admitted child input'); }
        } finally { capturedPrimary.close(); }
      } finally {captured.close();}
      const durable=openSync(output,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{fsyncSync(durable);}finally{closeSync(durable);}
      const copy=stableFile(output,check),database={...copy,file:name,...metadata},artifactPrefix=`artifacts/children/${taskId}/artifacts`;
      artifacts.push({file:name,bytes:copy.bytes,sha256:copy.sha256});documentAudit.children.push({taskId,record,database,artifactPrefix});
      replaced.add(record.binding.physical.database.path);
      for(const suffix of ['','-journal','-wal','-shm'])excluded.add(record.binding.physical.owner.path+suffix);
      for(const suffix of ['-journal','-wal','-shm'])excluded.add(record.binding.physical.database.path+suffix);
    }
    const sourceFiles = artifactFiles(paths.artifacts),copied=new Map<string,ArchiveFile>();
    for (const source of sourceFiles) {
      if(replaced.has(source)||excluded.has(source))continue;
      check(); const name = `artifacts/${relative(paths.artifacts, source).split(sep).join('/')}`, output = join(staging, name);
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 }); const content = stableFile(source, check, output); artifacts.push({ ...content, file: name });
      copied.set(source,content);
    }
    if (canonical(artifactFiles(paths.artifacts)) !== canonical(sourceFiles)) fail('ARCHIVE_SOURCE_CHANGED', 'Artifact tree changed during capture');
    for (const [source,content] of copied) if (stableFile(source, check).sha256 !== content.sha256) fail('ARCHIVE_SOURCE_CHANGED', 'Artifact content changed during capture');
    const capturedFiles=new Map(artifacts.map(member=>[member.file,member]));
    for(const [name,expected] of expectedDocuments){const actual=capturedFiles.get(name);if(!actual||actual.bytes!==expected.bytes||actual.sha256!==expected.sha256)fail('ARCHIVE_DOCUMENT_INTEGRITY_FAILED','Captured document bytes differ from the owner-pinned source reference');}
    const binding = { db: leases.find(lease => lease.file === paths.db)!.identity, review: leases.find(lease => lease.file === paths.review)!.identity, artifacts: { dev: rootIdentity.dev, ino: rootIdentity.ino } };
    const manifest: EngineArchiveManifest = { archiveVersion: 1, archiveId: randomUUID(), createdAt: new Date().toISOString(), source: { dbPath: paths.db, artifactDir: paths.artifacts, binding, bindingScope: scope(snapshot) }, databases, artifacts, recoveryAcknowledgmentsRebound: false,documentAudit };
    const raw = JSON.stringify(manifest, null, 2) + '\n';
    if (Buffer.byteLength(raw) > ENGINE_ARCHIVE_LIMITS.maxManifestBytes || [...databases, ...artifacts].reduce((sum, item) => sum + item.bytes, 0) > ENGINE_ARCHIVE_LIMITS.maxTotalBytes) fail('ARCHIVE_FILE_LIMIT', 'Archive exceeds its total manifest or byte budget');
    writeFileSync(join(staging, 'manifest.json'), raw, { flag: 'wx', mode: 0o600 });
    const fd = openSync(join(staging, 'manifest.json'), constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
    directorySync(staging); check(); publish(staging, destination); staging = undefined;
    return { directory: destination, manifest, manifestSha256: digest(raw) };
  } finally {
    const failures: unknown[] = [];
    for(const reader of childReaders.reverse())try{reader.close();}catch(error){failures.push(error);}
    try { snapshot?.cleanup(); } catch (error) { failures.push(error); }
    try { if (staging) rmSync(staging, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    for (const lease of leases.reverse()) try { lease.release(); } catch (error) { failures.push(error); }
    if (failures.length) fail('ARCHIVE_CLEANUP_FAILED', 'Archive could not release all leases or remove its private partial data');
  }
}
/** New bundle only. Source acknowledgments and immutable row identities are retained, never rebound. */
export async function importEngineArchive(options: ImportEngineArchiveOptions): Promise<ImportedEngineArchive> {
  const archive = validateEngineArchive(options), destination = destinationPath(options.destination), sourceRoot = manifestRoot(options.directory);
  if (inside(archive.directory, destination)) fail('ARCHIVE_PATH_UNSUPPORTED', 'Import destination must be outside the archive');
  let staging: string | undefined;
  try {
    staging = mkdtempSync(join(dirname(destination), '.moodcode-import-'));
    mkdirSync(join(staging, 'artifacts'), { mode: 0o700 });
    const check = () => abort(options.signal);
    for (const member of [...archive.manifest.databases, ...archive.manifest.artifacts]) {
      const source = join(sourceRoot, member.file), output = join(staging, member.file);
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
      const actual = stableFile(source, check, output);
      if (actual.bytes !== member.bytes || actual.sha256 !== member.sha256) fail('ARCHIVE_SOURCE_CHANGED', 'Archive changed after validation');
    }
    if (parseManifest(join(sourceRoot, 'manifest.json')).manifestSha256 !== archive.manifestSha256) fail('ARCHIVE_SOURCE_CHANGED', 'Archive manifest changed during import');
    const primary = archive.manifest.databases.find(item => item.role === 'primary')!;
    const artifactDir = join(destination, 'data', 'artifacts');
    const store = new SqliteStore(join(staging, databaseFiles.primary)); let sessionsPaused = 0, worktreesRelocated = 0,childSessionsPaused=0;
    try { for (const workspace of store.listWorkspaces()) { store.pauseImportedWorkspaceKnowledge(workspace.id, archive.manifestSha256, { importId: randomUUID(), sourcePrimaryLogicalSha256: primary.logicalHash, sourceStorageBindingSha256: knowledgeHash(historicalHost(archive.manifest)) }); for (const session of store.listSessions(workspace.id)) {
      const document = store.getSessionDocument(session.id, 'engine.worktrees');
      if (document) {
        const records = document.data.records;
        if (document.data.schemaVersion !== 1 || !Array.isArray(records) || records.length > 128) fail('ARCHIVE_WORKTREE_BINDING_INVALID', 'Archived worktree journal is invalid');
        const relocated = records.map(value => {
          const record = value as unknown as ManagedWorktree;
          if (!record || record.sessionId !== session.id || !/^worktree_[a-f0-9]{32}$/u.test(record.id)
            || record.root !== join(archive.manifest.source.artifactDir, 'children', 'worktrees', record.id)
            || !Number.isSafeInteger(record.revision) || record.revision < 1 || record.revision >= Number.MAX_SAFE_INTEGER) fail('ARCHIVE_WORKTREE_BINDING_INVALID', 'Archived worktree path cannot be mapped to the default owned artifact tree');
          worktreesRelocated++;
          return { ...record, root: join(artifactDir, 'children', 'worktrees', record.id), revision: record.revision + 1,
            state: record.state === 'removed' ? 'removed' : 'uncertain', errorCode: 'WORKTREE_ARCHIVE_RELOCATION',
            relocation: { archiveId: archive.manifest.archiveId, manifestSha256: archive.manifestSha256, originalRoot: record.root, ownershipVerified: false },
          } as unknown as import('@moodcode/contracts').JsonObject;
        });
        store.putSessionDocument(session.id, 'engine.worktrees', document.revision, { ...document.data, records: relocated });
      }
      store.setSessionPaused(session.id, true, 'recovery_required'); sessionsPaused++;
    } } }
    finally { await store.closeAsync(); }
    for(const member of archive.manifest.documentAudit?.children??[]) {
      check();const child=new SqliteStore(join(staging,member.database.file));
      try {for(const workspace of child.listWorkspaces()){child.pauseImportedWorkspaceKnowledge(workspace.id,archive.manifestSha256,{importId:randomUUID(),sourcePrimaryLogicalSha256:member.database.logicalHash,sourceStorageBindingSha256:knowledgeHash({database:member.record.binding.physical.database,artifacts:member.record.binding.physical.artifacts})});for(const session of child.listSessions(workspace.id)){child.setSessionPaused(session.id,true,'recovery_required');childSessionsPaused++;}}}
      finally {await child.closeAsync();}
    }
    const documentAuditCoverage=archive.manifest.documentAudit?.coverage??'unchecked';
    const receipt = { archiveId: archive.manifest.archiveId, archiveManifestSha256: archive.manifestSha256, source: archive.manifest.source, recoveryAcknowledgmentsRebound: false, migratedFromVersion: primary.schemaVersion, schemaVersion: DB_VERSION, sessionsPaused, worktreesRelocated,childSessionsPaused,documentAuditCoverage, executionResumed: false };
    writeFileSync(join(staging, 'import.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    directorySync(staging); check(); publish(staging, destination); staging = undefined;
    return { ...archive, directory: destination, dbPath: join(destination, 'data', databaseFiles.primary), artifactDir, migratedFromVersion: primary.schemaVersion, schemaVersion: DB_VERSION, sessionsPaused, worktreesRelocated,childSessionsPaused,documentAuditCoverage, artifactPathMapping: { from: archive.manifest.source.artifactDir, to: artifactDir }, executionResumed: false };
  } finally { if (staging) rmSync(staging, { recursive: true, force: true }); }
}
