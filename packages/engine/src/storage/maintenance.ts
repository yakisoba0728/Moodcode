import {
  constants, closeSync, fchmodSync, fsyncSync, fstatSync, linkSync, lstatSync,
  mkdirSync, mkdtempSync, openSync, rmSync, statSync, unlinkSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { EngineError, type JsonObject } from '@moodcode/contracts';

export interface IntegrityCheckResult {
  ok: boolean;
  schemaVersion: number;
  errors: string[];
  foreignKeyViolations: { table: string; rowId: number | null; parent: string; foreignKeyIndex: number }[];
}
export interface DatabaseBackup {
  destination: string;
  bytes: number;
  schemaVersion: number;
}
export interface StoreBackupOptions { signal?: AbortSignal }

/** Call under a source read transaction, or against an unpublished private backup. */
export function inspectIntegrity(db: DatabaseSync, expectedVersion: number): IntegrityCheckResult {
  const schemaVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  const errors = db.prepare('PRAGMA integrity_check').all().map(row => String(row.integrity_check)).filter(message => message !== 'ok');
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().map(row => ({
    table: String(row.table), rowId: row.rowid === null ? null : Number(row.rowid),
    parent: String(row.parent), foreignKeyIndex: Number(row.fkid),
  }));
  if (schemaVersion !== expectedVersion) errors.push(`Database version ${schemaVersion} does not match supported version ${expectedVersion}`);
  return { ok: errors.length === 0 && foreignKeyViolations.length === 0, schemaVersion, errors, foreignKeyViolations };
}

type PathIdentity = { path: string; dev: number; ino: number };
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal', '.owner.sqlite', '.owner.sqlite-journal'];
function sameIdentity(actual: Stats, expected: { dev: number; ino: number }): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}
function validateDirectory(path: string): Stats {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new EngineError('BACKUP_PATH_UNSUPPORTED', 'Backup parents must be directories without symlinks');
  return info;
}
function validateInputParents(destination: string): void {
  // Do not let lexical resolve() erase a symlink component followed by "..".
  const input = isAbsolute(destination) ? destination : `${process.cwd()}${sep}${destination}`;
  const parent = dirname(input);
  const root = parse(parent).root;
  let current = root;
  for (const part of parent.slice(root.length).split(sep).filter(Boolean)) {
    if (part === '.') continue;
    if (part === '..') { current = dirname(current); continue; }
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new EngineError('BACKUP_PATH_UNSUPPORTED', 'Backup parents must be directories without symlinks');
  }
}
function prepareParents(destination: string): PathIdentity[] {
  const parent = dirname(destination);
  const root = parse(parent).root;
  const identities: PathIdentity[] = [];
  let current = root;
  const rootInfo = validateDirectory(root);
  identities.push({ path: root, dev: rootInfo.dev, ino: rootInfo.ino });
  for (const part of parent.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!lstatSync(current, { throwIfNoEntry: false })) {
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const info = validateDirectory(current);
    identities.push({ path: current, dev: info.dev, ino: info.ino });
  }
  return identities;
}
function recheckParents(identities: readonly PathIdentity[]): void {
  for (const expected of identities) {
    const actual = validateDirectory(expected.path);
    if (!sameIdentity(actual, expected)) throw new EngineError('BACKUP_PATH_CHANGED', 'Backup parent changed while the operation was in progress');
  }
}
function assertNewDestination(destination: string): void {
  if (lstatSync(destination, { throwIfNoEntry: false })) throw new EngineError('BACKUP_DESTINATION_EXISTS', 'Backup requires a new destination file');
  for (const suffix of SIDECAR_SUFFIXES) {
    if (lstatSync(`${destination}${suffix}`, { throwIfNoEntry: false })) throw new EngineError('BACKUP_DESTINATION_EXISTS', 'Backup destination already has SQLite sidecar files');
  }
}
function normalizeFailure(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  const nativeCode = (error as { code?: unknown }).code;
  if (nativeCode === 'EEXIST') return new EngineError('BACKUP_DESTINATION_EXISTS', 'Backup requires a new destination file');
  const details: JsonObject = {};
  if (typeof nativeCode === 'string') details.causeCode = nativeCode;
  const sqliteCode = (error as { errcode?: unknown }).errcode;
  if (typeof sqliteCode === 'number') details.sqliteCode = sqliteCode;
  const nativeMessage = (error as { message?: unknown }).message;
  if (typeof nativeMessage === 'string') details.nativeMessage = nativeMessage.slice(0, 1_024);
  return new EngineError('BACKUP_FAILED', 'SQLite backup could not be completed', details);
}
function removePublished(destination: string, identity: Stats): void {
  const current = lstatSync(destination, { throwIfNoEntry: false });
  // A competing path belongs to its creator. Never delete it on our failure path.
  if (current && sameIdentity(current, identity) && current.isFile()) unlinkSync(destination);
}

/** Native SQLite backup into private staging, with an atomic exclusive publication. */
export async function backupDatabase(
  db: DatabaseSync, requestedDestination: string, expectedVersion: number, checkCancelled: () => void,
  synchronousMemorySource = false,
): Promise<DatabaseBackup> {
  checkCancelled();
  if (typeof requestedDestination !== 'string' || !requestedDestination || requestedDestination.includes('\0') || requestedDestination === ':memory:' || requestedDestination.endsWith(sep)) {
    throw new EngineError('BACKUP_PATH_UNSUPPORTED', 'Backup destination must be a filesystem file path');
  }
  const destination = resolve(requestedDestination);
  if (basename(destination) === '') throw new EngineError('BACKUP_PATH_UNSUPPORTED', 'Backup destination must be a file');
  validateInputParents(requestedDestination);
  const parents = prepareParents(destination);
  assertNewDestination(destination);
  const stagingDirectory = mkdtempSync(join(dirname(destination), '.moodcode-backup-'));
  const stagingIdentity = lstatSync(stagingDirectory);
  const stagedPath = join(stagingDirectory, 'database.sqlite');
  let fileIdentity: Stats | undefined;
  let published = false;
  let cleaned = false;
  let primaryFailure: EngineError | undefined;
  try {
    // mkdtemp is private even under permissive umasks. Track its inode before any setup fails.
    const directoryFd = openSync(stagingDirectory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try { fchmodSync(directoryFd, 0o700); } finally { closeSync(directoryFd); }
    recheckParents(parents);
    const fd = openSync(stagedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { fchmodSync(fd, 0o600); fileIdentity = fstatSync(fd); } finally { closeSync(fd); }
    checkCancelled();
    // Native backup reads the logical WAL database. It never copies the live main file.
    // Progress exceptions finalize the native job before the promise rejects (Node 24+).
    if (synchronousMemorySource) {
      // An in-memory DB cannot be reopened through a separate snapshot connection.
      // VACUUM INTO reads it synchronously without racing native worker-thread writes.
      db.prepare('VACUUM main INTO ?').run(stagedPath);
    } else {
      await sqliteBackup(db, stagedPath, { rate: 32, progress: () => checkCancelled() });
    }
    checkCancelled();
    const stagedInfo = lstatSync(stagedPath);
    if (!fileIdentity || !sameIdentity(stagedInfo, fileIdentity) || !stagedInfo.isFile() || stagedInfo.nlink !== 1) throw new EngineError('BACKUP_PATH_CHANGED', 'Backup staging file changed while the operation was in progress');

    const stagedDb = new DatabaseSync(stagedPath, { timeout: 1_000 });
    let inspection: IntegrityCheckResult;
    try {
      const version = Number(stagedDb.prepare('PRAGMA user_version').get()?.user_version);
      if (version !== expectedVersion) throw new EngineError('DB_VERSION_UNSUPPORTED', `Backup database version ${version} does not match supported version ${expectedVersion}`);
      // Native backups inherit the source WAL header. Export a self-contained main file.
      stagedDb.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
      inspection = inspectIntegrity(stagedDb, expectedVersion);
      if (!inspection.ok) throw new EngineError('DB_INTEGRITY_FAILED', 'Backup failed SQLite integrity or foreign key checks');
    } finally { stagedDb.close(); }
    const verifiedFd = openSync(stagedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: number;
    try {
      const info = fstatSync(verifiedFd);
      if (!sameIdentity(info, fileIdentity) || info.nlink !== 1) throw new EngineError('BACKUP_PATH_CHANGED', 'Backup staging file identity changed');
      fchmodSync(verifiedFd, 0o600);
      fsyncSync(verifiedFd);
      bytes = info.size;
    } finally { closeSync(verifiedFd); }
    checkCancelled();
    recheckParents(parents);
    assertNewDestination(destination);
    linkSync(stagedPath, destination); // Atomic no-overwrite publication, including concurrent creation.
    published = true;
    unlinkSync(stagedPath);
    const output = lstatSync(destination);
    if (!sameIdentity(output, fileIdentity) || !output.isFile() || output.nlink !== 1) throw new EngineError('BACKUP_PATH_CHANGED', 'Published backup file identity changed');
    checkCancelled();
    const parentFd = openSync(dirname(destination), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    if (!sameIdentity(lstatSync(stagingDirectory), stagingIdentity)) throw new EngineError('BACKUP_PATH_CHANGED', 'Backup staging directory changed');
    rmSync(stagingDirectory, { recursive: true });
    cleaned = true;
    return { destination, bytes, schemaVersion: inspection.schemaVersion };
  } catch (error) {
    primaryFailure = normalizeFailure(error);
    if (published && fileIdentity) {
      try { removePublished(destination, fileIdentity); }
      catch {
        throw new EngineError('BACKUP_CLEANUP_FAILED', 'Failed backup destination could not be removed', { partialPath: destination, causeCode: primaryFailure.code });
      }
    }
    throw primaryFailure;
  } finally {
    if (!cleaned) {
      try {
        const current = lstatSync(stagingDirectory, { throwIfNoEntry: false });
        if (current) {
          if (!sameIdentity(current, stagingIdentity) || !current.isDirectory() || current.isSymbolicLink()) throw new Error('Backup staging directory identity changed');
          rmSync(stagingDirectory, { recursive: true });
        }
      } catch {
        throw new EngineError('BACKUP_CLEANUP_FAILED', 'Backup temporary data could not be removed', { partialPath: stagingDirectory, ...(primaryFailure ? { causeCode: primaryFailure.code } : {}) });
      }
    }
  }
}
