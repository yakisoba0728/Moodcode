import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { EngineError } from '@moodcode/contracts';
import { errnoCode, streamStableFile, symlinkFreeDirectorySync } from '../shared/fs.js';

export const RECOVERY_LIMITS = Object.freeze({
  maxFileBytes: 256 * 1024 * 1024,
  maxSnapshotBytes: 512 * 1024 * 1024,
  maxSnapshotFiles: 12,
  snapshotTimeoutMs: 10_000,
  maxOperations: 1_000,
  maxLedgerRecordBytes: 4 * 1024 * 1024,
  maxSchemaEntries: 160,
});
export interface RecoveryPaths { db: string; review: string; effect: string; ledger: string; artifacts: string }
export interface Identity { dev: number; ino: number }
interface FileSignature extends Identity { size: number; mtime: number; ctime: number; hash: string }
export interface Snapshot {
  directory: string;
  paths: RecoveryPaths;
  files: Map<string, { source: string; copy: string; signature: FileSignature }>;
  artifactIdentity: Identity;
  check(): void;
  open(name: 'db' | 'review' | 'effect' | 'ledger'): DatabaseSync | undefined;
  cleanup(): void;
}
export function fail(code: string): never { throw new EngineError(code, messages[code] ?? 'Recovery could not be completed safely'); }
const messages: Record<string, string> = {
  RECOVERY_PATH_UNSUPPORTED: 'Recovery requires pinned persistent files and an existing private artifact directory',
  RECOVERY_SOURCE_CHANGED: 'Recovery metadata changed; inspect the current status again',
  RECOVERY_LIMIT_EXCEEDED: 'Recovery inspection exceeds its bounded snapshot limits',
  RECOVERY_DATABASE_INVALID: 'Recovery could not verify the database schema and integrity',
  RECOVERY_PERMISSION_DENIED: 'Recovery could not access its pinned files',
  RECOVERY_OWNER_BUSY: 'An engine or recovery process still owns the database',
  RECOVERY_EFFECT_BUSY: 'An effect process still owns the execution lock',
  RECOVERY_STALE: 'Recovery status changed; inspect and confirm the current status again',
  RECOVERY_ACKNOWLEDGMENT_REQUIRED: 'Explicit confirmation of the current recovery fingerprint is required',
  RECOVERY_NOT_NEEDED: 'There is no unresolved recovery state to acknowledge',
  RECOVERY_BLOCKED: 'Recovery cannot prove that the previous effects have stopped',
  RECOVERY_METADATA_FAILED: 'Recovery could not durably record its backup and acknowledgment',
  RECOVERY_BACKUP_FAILED: 'Recovery could not create and verify all required backups',
};
export function safeError(error: unknown): EngineError {
  if (error instanceof EngineError && error.code.startsWith('RECOVERY_')) return error;
  const code = errnoCode(error);
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new EngineError('RECOVERY_PERMISSION_DENIED', messages.RECOVERY_PERMISSION_DENIED!);
  return new EngineError('RECOVERY_DATABASE_INVALID', messages.RECOVERY_DATABASE_INVALID!);
}
export function sameIdentity(a: Identity, b: Identity | undefined): boolean { return Boolean(b && a.dev === b.dev && a.ino === b.ino); }
export function regular(file: string): Stats | undefined {
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) fail('RECOVERY_PATH_UNSUPPORTED');
  return info;
}
function directoryPath(input: string): string {
  if (typeof input !== 'string' || !input || input.includes('\0') || !isAbsolute(input)) fail('RECOVERY_PATH_UNSUPPORTED');
  return realpathSync(symlinkFreeDirectorySync(input, { onUnsafe: () => fail('RECOVERY_PATH_UNSUPPORTED') }));
}
export function recoveryPaths(input: { dbPath: string; artifactDir: string }): RecoveryPaths {
  if (!input || typeof input.dbPath !== 'string' || !isAbsolute(input.dbPath) || input.dbPath.includes('\0') || input.dbPath === ':memory:') fail('RECOVERY_PATH_UNSUPPORTED');
  const parent = directoryPath(dirname(input.dbPath));
  const db = join(parent, basename(input.dbPath));
  regular(db);
  const artifacts = directoryPath(input.artifactDir);
  return { db, review: db + '.review.sqlite', effect: db + '.effects.sqlite', ledger: db + '.recovery.sqlite', artifacts };
}
export function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function canonical(value: unknown): string {
  if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString('base64'));
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  return JSON.stringify(value) ?? 'null';
}
function signature(file: string, check: () => void, copyTo?: string): FileSignature | undefined {
  check();
  const before = regular(file);
  if (!before) return undefined;
  const { sha256 } = streamStableFile(file, before, {
    maxBytes: RECOVERY_LIMITS.maxFileBytes, stable: ['size', 'mtime', 'ctime'], check, requireSingleLink: true, copyTo,
    onChanged: () => fail('RECOVERY_SOURCE_CHANGED'), onLimit: () => fail('RECOVERY_LIMIT_EXCEEDED'),
  });
  return { dev: before.dev, ino: before.ino, size: before.size, mtime: before.mtimeMs, ctime: before.ctimeMs, hash: sha256 };
}
export function verifiedFileDigest(file: string, check: () => void): { dev: number; ino: number; bytes: number; sha256: string } {
  const result = signature(file, check);
  if (!result) fail('RECOVERY_SOURCE_CHANGED');
  return { dev: result.dev, ino: result.ino, bytes: result.size, sha256: result.hash };
}
export function takeSnapshot(paths: RecoveryPaths): Snapshot {
  const deadline = performance.now() + RECOVERY_LIMITS.snapshotTimeoutMs;
  const check = (): void => { if (performance.now() > deadline) fail('RECOVERY_LIMIT_EXCEEDED'); };
  const artifactStats = lstatSync(paths.artifacts);
  const artifactIdentity = { dev: artifactStats.dev, ino: artifactStats.ino };
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-recovery-')));
  const files: Snapshot['files'] = new Map();
  let bytes = 0;
  try {
    for (const key of ['db', 'review', 'effect', 'ledger'] as const) {
      // SHM is a volatile cache. Reconstruct it on a private copy, never on the source.
      regular(paths[key] + '-shm');
      for (const suffix of ['', '-wal', '-journal']) {
        const source = paths[key] + suffix;
        const copy = join(directory, key + '.sqlite' + suffix);
        const anticipated = regular(source);
        if (anticipated && (bytes + anticipated.size > RECOVERY_LIMITS.maxSnapshotBytes || files.size >= RECOVERY_LIMITS.maxSnapshotFiles)) fail('RECOVERY_LIMIT_EXCEEDED');
        const info = signature(source, check, copy);
        if (!info) continue;
        bytes += info.size;
        if (bytes > RECOVERY_LIMITS.maxSnapshotBytes || files.size >= RECOVERY_LIMITS.maxSnapshotFiles) fail('RECOVERY_LIMIT_EXCEEDED');
        files.set(key + suffix, { source, copy, signature: info });
      }
    }
    // A stable entire set is required, including previously absent sidecars.
    for (const key of ['db', 'review', 'effect', 'ledger'] as const) for (const suffix of ['', '-wal', '-journal']) {
      const current = signature(paths[key] + suffix, check);
      if (canonical(current) !== canonical(files.get(key + suffix)?.signature)) fail('RECOVERY_SOURCE_CHANGED');
    }
    return {
      directory, paths, files, artifactIdentity, check,
      open(key) {
        const file = files.get(key);
        if (!file) return undefined;
        check();
        const db = new DatabaseSync(file.copy, { timeout: 0 });
        db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0');
        return db;
      },
      cleanup() { rmSync(directory, { recursive: true, force: true }); },
    };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw safeError(error); }
}
export function checkDatabase(db: DatabaseSync, version: number, expectedTables: readonly string[], check: () => void, applicationId?: number): string {
  check();
  if (db.prepare('PRAGMA user_version').get()?.user_version !== version || applicationId !== undefined && db.prepare('PRAGMA application_id').get()?.application_id !== applicationId) fail('RECOVERY_DATABASE_INVALID');
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name LIMIT ?").all(RECOVERY_LIMITS.maxSchemaEntries + 1);
  if (schema.length > RECOVERY_LIMITS.maxSchemaEntries) fail('RECOVERY_LIMIT_EXCEEDED');
  const tables = schema.filter(row => row.type === 'table').map(row => String(row.name)).sort();
  if (canonical(tables) !== canonical([...expectedTables].sort()) || schema.some(row => row.type !== 'table' && row.type !== 'index')) fail('RECOVERY_DATABASE_INVALID');
  const result = db.prepare('PRAGMA quick_check(1)').get();
  if (Object.values(result ?? {})[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) fail('RECOVERY_DATABASE_INVALID');
  const digest = createHash('sha256').update(canonical(schema));
  for (const name of tables) {
    digest.update(name);
    // Table names are an exact allowlist, not identifiers read from arbitrary SQL.
    const withoutRowid = db.prepare("SELECT wr FROM pragma_table_list WHERE schema='main' AND name=? LIMIT 2").all(name);
    if (withoutRowid.length !== 1) fail('RECOVERY_DATABASE_INVALID');
    let order = 'rowid';
    if (withoutRowid[0]!.wr === 1) {
      const primary = db.prepare('SELECT name FROM pragma_table_info(?) WHERE pk>0 ORDER BY pk LIMIT 33').all(name);
      if (!primary.length || primary.length > 32 || primary.some(column => typeof column.name !== 'string' || !/^[a-z_][a-z_0-9]*$/u.test(column.name))) fail('RECOVERY_DATABASE_INVALID');
      order = primary.map(column => '"' + String(column.name) + '"').join(',');
    }
    const statement = db.prepare('SELECT * FROM "' + name + '" ORDER BY ' + order);
    statement.setReadBigInts(true);
    for (const row of statement.iterate()) { check(); digest.update(canonical(row)).update('\n'); }
  }
  return digest.digest('hex');
}
export interface EffectMarker { ownerPid: number; groupPid: number | null; active: boolean; updatedAt: string }
const validPid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
/** The single command_execution row: null when the table is empty, 'invalid' when malformed. */
export function readEffectMarker(db: DatabaseSync): EffectMarker | null | 'invalid' {
  const [row, extra] = db.prepare('SELECT id,owner_pid,group_pid,active,updated_at FROM command_execution LIMIT 2').all();
  if (!row) return null;
  if (extra || row.id !== 1 || !validPid(row.owner_pid) || row.group_pid !== null && !validPid(row.group_pid)
    || row.active !== 0 && row.active !== 1 || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) return 'invalid';
  return { ownerPid: row.owner_pid, groupPid: row.group_pid as number | null, active: row.active === 1, updatedAt: row.updated_at };
}
export function preparePrivateDirectory(parent: string, name: string): string {
  const identity = lstatSync(parent);
  const output = join(parent, name);
  mkdirSync(output, { mode: 0o700 });
  if (!sameIdentity(identity, lstatSync(parent)) || lstatSync(output).isSymbolicLink()) fail('RECOVERY_SOURCE_CHANGED');
  return output;
}
