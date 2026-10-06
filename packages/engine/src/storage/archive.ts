import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EngineError } from '@moodcode/contracts';
import { acquireRecoveryLease } from '../recovery/index.js';
import { readAudits, readOperations, scope } from '../recovery/ledger.js';
import { canonical, checkDatabase, recoveryPaths, regular, sameIdentity, takeSnapshot, type Identity } from '../recovery/snapshot.js';
import { backupDatabase } from './maintenance.js';
import { databaseVersion, DB_VERSION } from './migrations.js';
import { NATIVE_SESSION_TABLES } from './native-schema.js';
import { SqliteStore } from './index.js';
import type { ManagedWorktree } from '../worktrees/index.js';

export const ENGINE_ARCHIVE_VERSION = 1;
export const ENGINE_ARCHIVE_LIMITS = Object.freeze({ maxFiles: 4096, maxFileBytes: 268_435_456, maxTotalBytes: 536_870_912, maxManifestBytes: 4_194_304 });
type Role = 'primary' | 'review' | 'ledger' | 'effect';
const databaseFiles: Record<Role, string> = { primary: 'engine.sqlite', review: 'engine.sqlite.review.sqlite', ledger: 'engine.sqlite.recovery.sqlite', effect: 'engine.sqlite.effects.sqlite' };
const primaryTables = ['workspaces', 'sessions', 'inputs', 'runs', 'messages', 'tools', 'approvals', 'checkpoints', 'events'];
export interface ArchiveFile { file: string; bytes: number; sha256: string }
export interface ArchiveDatabase extends ArchiveFile { role: Role; schemaVersion: number; logicalHash: string }
export interface EngineArchiveManifest {
  archiveVersion: 1; archiveId: string; createdAt: string;
  source: { dbPath: string; artifactDir: string; binding: { db: Identity; review: Identity; artifacts: Identity }; bindingScope: string };
  databases: ArchiveDatabase[]; artifacts: ArchiveFile[];
  recoveryAcknowledgmentsRebound: false;
}
export interface ExportEngineArchiveOptions { dbPath: string; artifactDir: string; destination: string; signal?: AbortSignal }
export interface ImportEngineArchiveOptions { directory: string; destination: string; signal?: AbortSignal }
export interface EngineArchiveResult { directory: string; manifest: EngineArchiveManifest; manifestSha256: string }
export interface ImportedEngineArchive extends EngineArchiveResult { dbPath: string; artifactDir: string; migratedFromVersion: number; schemaVersion: number; sessionsPaused: number; worktreesRelocated: number; artifactPathMapping: { from: string; to: string }; executionResumed: false }
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
    return { schemaVersion, logicalHash: checkDatabase(db, schemaVersion, schemaVersion >= 3 ? [...tables,'attempt_usage'] : tables, check) };
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
  return { manifest: value, manifestSha256: digest(raw) };
}
export function validateEngineArchive(options: { directory: string; signal?: AbortSignal }): EngineArchiveResult {
  const root = manifestRoot(options.directory), check = () => abort(options.signal);
  check(); const parsed = parseManifest(join(root, 'manifest.json'));
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
  if (parseManifest(join(root, 'manifest.json')).manifestSha256 !== initialManifestHash) fail('ARCHIVE_SOURCE_CHANGED', 'Archive manifest changed during validation');
  return { directory: checkedDirectory(options.directory), ...parsed };
}
/** Offline export: leases block engine/review/recovery writes across the entire capture. */
export async function exportEngineArchive(options: ExportEngineArchiveOptions): Promise<EngineArchiveResult> {
  abort(options.signal); const paths = recoveryPaths(options), destination = destinationPath(options.destination);
  if (inside(paths.artifacts, destination)) fail('ARCHIVE_PATH_UNSUPPORTED', 'Archive destination must be outside the source artifact tree');
  if (!regular(paths.db) || !regular(paths.review)) fail('ARCHIVE_DATABASE_MISSING', 'Archive requires primary and review databases');
  const leases: ReturnType<typeof acquireRecoveryLease>[] = [];
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
    const check = () => { abort(options.signal); for (const lease of leases) if (!sameIdentity(lease.identity, regular(lease.file))) fail('ARCHIVE_SOURCE_CHANGED', 'Source database lease identity changed'); if (!sameIdentity(rootIdentity, lstatSync(paths.artifacts))) fail('ARCHIVE_SOURCE_CHANGED', 'Source artifact directory identity changed'); };
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
    const sourceFiles = artifactFiles(paths.artifacts), artifacts: ArchiveFile[] = [];
    for (const source of sourceFiles) {
      check(); const name = `artifacts/${relative(paths.artifacts, source).split(sep).join('/')}`, output = join(staging, name);
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 }); const content = stableFile(source, check, output); artifacts.push({ ...content, file: name });
    }
    if (canonical(artifactFiles(paths.artifacts)) !== canonical(sourceFiles)) fail('ARCHIVE_SOURCE_CHANGED', 'Artifact tree changed during capture');
    for (let index = 0; index < sourceFiles.length; index++) if (stableFile(sourceFiles[index]!, check).sha256 !== artifacts[index]!.sha256) fail('ARCHIVE_SOURCE_CHANGED', 'Artifact content changed during capture');
    const binding = { db: leases.find(lease => lease.file === paths.db)!.identity, review: leases.find(lease => lease.file === paths.review)!.identity, artifacts: { dev: rootIdentity.dev, ino: rootIdentity.ino } };
    const manifest: EngineArchiveManifest = { archiveVersion: 1, archiveId: randomUUID(), createdAt: new Date().toISOString(), source: { dbPath: paths.db, artifactDir: paths.artifacts, binding, bindingScope: scope(snapshot) }, databases, artifacts, recoveryAcknowledgmentsRebound: false };
    const raw = JSON.stringify(manifest, null, 2) + '\n';
    if (Buffer.byteLength(raw) > ENGINE_ARCHIVE_LIMITS.maxManifestBytes || [...databases, ...artifacts].reduce((sum, item) => sum + item.bytes, 0) > ENGINE_ARCHIVE_LIMITS.maxTotalBytes) fail('ARCHIVE_FILE_LIMIT', 'Archive exceeds its total manifest or byte budget');
    writeFileSync(join(staging, 'manifest.json'), raw, { flag: 'wx', mode: 0o600 });
    const fd = openSync(join(staging, 'manifest.json'), constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
    directorySync(staging); check(); publish(staging, destination); staging = undefined;
    return { directory: destination, manifest, manifestSha256: digest(raw) };
  } finally {
    const failures: unknown[] = [];
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
    const store = new SqliteStore(join(staging, databaseFiles.primary)); let sessionsPaused = 0, worktreesRelocated = 0;
    try { for (const workspace of store.listWorkspaces()) for (const session of store.listSessions(workspace.id)) {
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
    } }
    finally { await store.closeAsync(); }
    const receipt = { archiveId: archive.manifest.archiveId, archiveManifestSha256: archive.manifestSha256, source: archive.manifest.source, recoveryAcknowledgmentsRebound: false, migratedFromVersion: primary.schemaVersion, schemaVersion: DB_VERSION, sessionsPaused, worktreesRelocated, executionResumed: false };
    writeFileSync(join(staging, 'import.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    directorySync(staging); check(); publish(staging, destination); staging = undefined;
    return { ...archive, directory: destination, dbPath: join(destination, 'data', databaseFiles.primary), artifactDir, migratedFromVersion: primary.schemaVersion, schemaVersion: DB_VERSION, sessionsPaused, worktreesRelocated, artifactPathMapping: { from: archive.manifest.source.artifactDir, to: artifactDir }, executionResumed: false };
  } finally { if (staging) rmSync(staging, { recursive: true, force: true }); }
}
