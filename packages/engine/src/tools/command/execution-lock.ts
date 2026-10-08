import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EngineError } from '@moodcode/contracts';
import { randomInt } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

export interface ExecutionLock {
  recordGroup(pid: number): void;
  release(cleanupConfirmed: boolean): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS command_execution (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
  group_pid INTEGER CHECK (group_pid IS NULL OR group_pid > 0),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL
);`;

export interface ExecutionLockMarker {
  ownerPid: number;
  groupPid: number | null;
  active: boolean;
  updatedAt: string;
}

type Marker = ExecutionLockMarker;

export interface ExecutionLockReservation { readonly id: string }
const heldLocks = new WeakMap<object, () => void>();
export function assertExecutionLockCurrent(original: ExecutionLock): void { const assert = heldLocks.get(original); if (!assert) throw new EngineError('COMMAND_EXECUTION_LOCK_STALE', 'Original held execution lock required'); assert(); }
const reservations = new WeakMap<object, { path: string; marker: ExecutionLockMarker; used: boolean }>();
/** Reserve the exact durable marker before a host records its physical effect intent. */
export function reserveExecutionLock(path: string): ExecutionLockReservation {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new EngineError('INVALID_COMMAND_LOCK_PATH', 'Execution lock reservation requires an absolute path');
  const updatedAt = new Date().toISOString().replace('Z', `${String(randomInt(1_000_000)).padStart(6, '0')}Z`);
  const reservation = Object.freeze({ id: updatedAt });
  reservations.set(reservation, { path, marker: { ownerPid: process.pid, groupPid: null, active: true, updatedAt }, used: false });
  return reservation;
}
export function readExecutionLockReservation(reservation: ExecutionLockReservation): Readonly<ExecutionLockMarker> {
  const owned = reservations.get(reservation);
  if (!owned || owned.used) throw new EngineError('COMMAND_EXECUTION_RESERVATION_INVALID', 'Execution reservation is foreign or consumed');
  return Object.freeze({ ...owned.marker });
}

/** Version 0 is the existing, unmigrated command_execution schema. */
export const EXECUTION_LOCK_SCHEMA_VERSION = 0;
export const EXECUTION_LOCK_INSPECTION_LIMITS = Object.freeze({ maxDatabaseBytes: 1_048_576, maxTimestampBytes: 128 });
export interface ExecutionLockInspectionOptions { signal?: AbortSignal }
export type ExecutionLockInspection =
  | { status: 'not_initialized'; marker: null; schemaVersion: number | null }
  | { status: 'busy'; marker: null; schemaVersion: null }
  | { status: 'available' | 'uncertain'; marker: ExecutionLockMarker; schemaVersion: number };

function checkInspectionAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new EngineError('COMMAND_EFFECTS_INSPECT_ABORTED', 'Command execution lock inspection was aborted.');
}

function checkLockVersion(version: unknown): void {
  if (version !== EXECUTION_LOCK_SCHEMA_VERSION) {
    throw new EngineError('COMMAND_EFFECTS_LOCK_UNSUPPORTED_VERSION', 'The command execution lock uses an unsupported schema version.', {
      schemaVersion: typeof version === 'number' && Number.isSafeInteger(version) ? version : null,
      supportedSchemaVersion: EXECUTION_LOCK_SCHEMA_VERSION,
    });
  }
}

function inspectionError(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  const value = error as { code?: unknown; errcode?: unknown } | null;
  const sqliteCode = value && typeof value.errcode === 'number' ? value.errcode & 0xff : undefined;
  if (value?.code === 'EACCES' || value?.code === 'EPERM' || sqliteCode === 3 || sqliteCode === 23) {
    return new EngineError('COMMAND_EFFECTS_INSPECT_PERMISSION_DENIED', 'Permission denied while inspecting the command execution lock.');
  }
  if (sqliteCode === 8) {
    return new EngineError('COMMAND_EFFECTS_INSPECT_RECOVERY_REQUIRED', 'SQLite requires writable recovery before this execution lock can be inspected; inspection performed no recovery.');
  }
  if ([1, 11, 26].includes(sqliteCode ?? -1)) {
    return new EngineError('COMMAND_EFFECTS_INSPECT_CORRUPT', 'The command execution lock database or schema is invalid.');
  }
  return new EngineError('COMMAND_EFFECTS_INSPECT_FAILED', 'Could not inspect the command execution lock.');
}

function inspectionCorrupt(): never {
  throw new EngineError('COMMAND_EFFECTS_INSPECT_CORRUPT', 'The command execution lock database, schema, or marker is invalid.');
}

/**
 * An observation, never an execution admission or PID-liveness authority.
 * Opens only existing regular DELETE-mode files, using SQLite readOnly and a
 * zero busy timeout. It does not create parents/schema or recover journals.
 * Abort is checked at synchronous-operation boundaries; it cannot interrupt a
 * synchronous filesystem/SQLite syscall while that call is executing.
 */
export function inspectExecutionLock(path: string, options: ExecutionLockInspectionOptions = {}): ExecutionLockInspection {
  const signal = options.signal;
  checkInspectionAbort(signal);
  if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path)) {
    throw new EngineError('COMMAND_EFFECTS_INSPECT_INVALID_PATH', 'Inspection requires an absolute persistent database file path.');
  }
  let db: DatabaseSync | undefined;
  let transaction = false;
  try {
    let metadata;
    try { metadata = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        checkInspectionAbort(signal);
        return { status: 'not_initialized', marker: null, schemaVersion: null };
      }
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new EngineError('COMMAND_EFFECTS_INSPECT_INVALID_PATH', 'Inspection requires a regular database file and does not follow database file symlinks.');
    }
    // Reject WAL before SQLite opens it: even a read-only WAL connection can
    // create shared-memory sidecars. Our effect-lock writer always uses DELETE.
    const header = Buffer.alloc(100);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let bytesRead = 0;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile()) throw new EngineError('COMMAND_EFFECTS_INSPECT_INVALID_PATH', 'Inspection requires a regular database file.');
      if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        throw new EngineError('COMMAND_EFFECTS_INSPECT_FAILED', 'The database file identity changed during inspection.');
      }
      if (!Number.isSafeInteger(opened.size) || opened.size > EXECUTION_LOCK_INSPECTION_LIMITS.maxDatabaseBytes) inspectionCorrupt();
      metadata = opened;
      while (bytesRead < header.byteLength) {
        const read = readSync(fd, header, bytesRead, header.byteLength - bytesRead, bytesRead);
        if (read === 0) break;
        bytesRead += read;
      }
      if (fstatSync(fd).size !== metadata.size) {
        throw new EngineError('COMMAND_EFFECTS_INSPECT_FAILED', 'The database file size changed during inspection.');
      }
    } finally { closeSync(fd); }
    checkInspectionAbort(signal);
    if (bytesRead > 0) {
      if (bytesRead !== header.byteLength || !header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) inspectionCorrupt();
      if (header[18] !== 1 || header[19] !== 1) {
        throw new EngineError('COMMAND_EFFECTS_LOCK_UNSUPPORTED_VERSION', 'Inspection supports the existing DELETE-journal execution lock format only.', {
          writeFormat: header[18] ?? null, readFormat: header[19] ?? null,
        });
      }
    }
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== metadata.dev || current.ino !== metadata.ino || current.size !== metadata.size) {
      throw new EngineError('COMMAND_EFFECTS_INSPECT_FAILED', 'The database path changed during inspection.');
    }
    db = new DatabaseSync(path, { readOnly: true, timeout: 0 });
    // This flag is connection-local and does not write the file. Integrity
    // inspection must not execute arbitrary CHECK expressions from a damaged
    // or substituted database; marker fields are validated directly below.
    db.exec('PRAGMA ignore_check_constraints=ON; BEGIN');
    transaction = true;
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    checkLockVersion(version);
    checkInspectionAbort(signal);
    const table = db.prepare("SELECT type FROM sqlite_schema WHERE name='command_execution' COLLATE NOCASE LIMIT 2").all();
    let result: ExecutionLockInspection;
    if (table.length === 0) result = { status: 'not_initialized', marker: null, schemaVersion: EXECUTION_LOCK_SCHEMA_VERSION };
    else {
      if (table.length !== 1 || table[0]?.type !== 'table') inspectionCorrupt();
      const columns = db.prepare('SELECT name, type, "notnull", pk, hidden FROM pragma_table_xinfo(\'command_execution\') LIMIT 6').all();
      const expected = [
        ['id', 'INTEGER', 0, 1], ['owner_pid', 'INTEGER', 1, 0], ['group_pid', 'INTEGER', 0, 0],
        ['active', 'INTEGER', 1, 0], ['updated_at', 'TEXT', 1, 0],
      ] as const;
      if (columns.length !== expected.length || columns.some((column, index) => {
        const spec = expected[index]!;
        return String(column.name).toLowerCase() !== spec[0] || String(column.type).toUpperCase() !== spec[1] || column.notnull !== spec[2] || column.pk !== spec[3] || column.hidden !== 0;
      })) inspectionCorrupt();
      const check = db.prepare('PRAGMA quick_check(1)').get();
      if (!check || Object.values(check)[0] !== 'ok') inspectionCorrupt();
      // UTF-16 storage can require twice the returned UTF-8 bytes for ASCII.
      // Bound the read first, then enforce the actual UTF-8 response ceiling.
      const statement = db.prepare(`SELECT id AS id, owner_pid AS owner_pid, group_pid AS group_pid, active AS active,
        CASE WHEN typeof(updated_at)='text' AND length(CAST(updated_at AS BLOB)) BETWEEN 1 AND ${EXECUTION_LOCK_INSPECTION_LIMITS.maxTimestampBytes * 2}
        THEN updated_at ELSE NULL END AS updated_at FROM command_execution LIMIT 2`);
      statement.setReadBigInts(true);
      const rows = statement.all();
      if (rows.length === 0) result = { status: 'not_initialized', marker: null, schemaVersion: EXECUTION_LOCK_SCHEMA_VERSION };
      else {
        if (rows.length !== 1) inspectionCorrupt();
        const row = rows[0]!;
        const pid = (value: unknown): value is bigint => typeof value === 'bigint' && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER);
        if (row.id !== 1n || !pid(row.owner_pid) || (row.group_pid !== null && !pid(row.group_pid)) ||
            (row.active !== 0n && row.active !== 1n) || typeof row.updated_at !== 'string' || Buffer.byteLength(row.updated_at, 'utf8') > EXECUTION_LOCK_INSPECTION_LIMITS.maxTimestampBytes || !Number.isFinite(Date.parse(row.updated_at))) inspectionCorrupt();
        const marker: ExecutionLockMarker = {
          ownerPid: Number(row.owner_pid), groupPid: row.group_pid === null ? null : Number(row.group_pid),
          active: row.active === 1n, updatedAt: row.updated_at,
        };
        result = { status: marker.active ? 'uncertain' : 'available', marker, schemaVersion: EXECUTION_LOCK_SCHEMA_VERSION };
      }
    }
    checkInspectionAbort(signal);
    db.exec('ROLLBACK');
    transaction = false;
    db.close();
    db = undefined;
    checkInspectionAbort(signal);
    return result;
  } catch (error) {
    discard(db, transaction);
    checkInspectionAbort(signal);
    const sqliteCode = typeof (error as { errcode?: unknown } | null)?.errcode === 'number' ? (error as { errcode: number }).errcode & 0xff : undefined;
    if (sqliteCode === 5 || sqliteCode === 6) return { status: 'busy', marker: null, schemaVersion: null };
    throw inspectionError(error);
  }
}

function normalizeError(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  const value = error as { errcode?: unknown } | null;
  if (value && typeof value.errcode === 'number' && [5, 6].includes(value.errcode & 0xff)) {
    return new EngineError('COMMAND_EFFECTS_BUSY', 'A command supervisor still holds the execution lock.');
  }
  return new EngineError('COMMAND_EFFECTS_LOCK_FAILED', `Could not manage the command execution lock: ${error instanceof Error ? error.message : String(error)}`);
}

function openDatabase(path: string): DatabaseSync {
  if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path)) {
    throw new EngineError('COMMAND_EFFECTS_LOCK_FAILED', 'The command execution lock requires an absolute persistent database path.');
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    checkLockVersion(db.prepare('PRAGMA user_version').get()?.user_version);
    // DELETE mode makes BEGIN EXCLUSIVE exclude both readers and writers.
    // The committed active marker, rather than PID liveness, survives crashes.
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL');
    return db;
  } catch (error) {
    try { db.close(); } catch { /* Preserve the original locking error. */ }
    throw error;
  }
}

function readMarker(db: DatabaseSync): Marker | undefined {
  const row = db.prepare('SELECT owner_pid, group_pid, active, updated_at FROM command_execution WHERE id=1').get();
  if (!row) return undefined;
  const ownerPid = Number(row.owner_pid);
  const groupPid = row.group_pid === null ? null : Number(row.group_pid);
  const active = Number(row.active);
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1 || (groupPid !== null && (!Number.isSafeInteger(groupPid) || groupPid < 1)) || (active !== 0 && active !== 1) || typeof row.updated_at !== 'string') {
    throw new EngineError('COMMAND_EFFECTS_LOCK_FAILED', 'The command execution marker is invalid; manual reconciliation is required.');
  }
  return { ownerPid, groupPid, active: active === 1, updatedAt: row.updated_at };
}

function uncertain(marker: Marker): EngineError {
  return new EngineError('COMMAND_CLEANUP_UNCERTAIN', 'A previous command has an active execution marker. Confirm its effects have stopped and reconcile the marker manually before reopening.', {
    ownerPid: marker.ownerPid, groupPid: marker.groupPid, updatedAt: marker.updatedAt,
  });
}

function discard(db: DatabaseSync | undefined, transaction: boolean): void {
  if (!db) return;
  if (transaction) {
    try { db.exec('ROLLBACK'); } catch { /* close also rolls back an open transaction. */ }
  }
  try { db.close(); } catch { /* Preserve the error that made this lock unusable. */ }
}

/** Checks availability without clearing or replacing a persisted active marker. */
export function assertExecutionLockAvailable(path: string): void {
  let db: DatabaseSync | undefined;
  let transaction = false;
  try {
    db = openDatabase(path);
    db.exec('BEGIN EXCLUSIVE');
    transaction = true;
    // A new file can be inspected without committing a schema or marker.
    db.exec(SCHEMA);
    const marker = readMarker(db);
    if (marker?.active) throw uncertain(marker);
    db.exec('ROLLBACK');
    transaction = false;
    db.close();
    db = undefined;
  } catch (error) {
    discard(db, transaction);
    throw normalizeError(error);
  }
}

/**
 * Commits active=1 before effects can start, then holds an exclusive transaction.
 * recordGroup updates remain uncommitted while held; a crash may leave group_pid
 * null, but the durable active marker still prevents another command from starting.
 */
/** Explicit host recovery only; a live or unverifiable PID never authorizes clearing a marker. */
export function reconcileStoppedExecutionLock(path: string, input: Readonly<ExecutionLockMarker>): void {
  if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new EngineError('COMMAND_EFFECTS_RECOVERY_INVALID', 'Execution recovery requires plain marker metadata');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== 4 || Object.keys(descriptors).sort().join(',') !== 'active,groupPid,ownerPid,updatedAt' || Object.values(descriptors).some(value => !('value' in value) || !value.enumerable)) throw new EngineError('COMMAND_EFFECTS_RECOVERY_INVALID', 'Execution recovery cannot execute marker accessors');
  const expected = Object.freeze({ ownerPid: descriptors.ownerPid!.value as number, groupPid: descriptors.groupPid!.value as number | null, active: descriptors.active!.value as boolean, updatedAt: descriptors.updatedAt!.value as string });
  if (!Number.isSafeInteger(expected.ownerPid) || expected.ownerPid < 1 || expected.ownerPid > 2_147_483_647 || expected.groupPid !== null || expected.active !== true || typeof expected.updatedAt !== 'string' || expected.updatedAt.length > 128 || !Number.isFinite(Date.parse(expected.updatedAt))) throw new EngineError('COMMAND_EFFECTS_RECOVERY_INVALID', 'Execution recovery requires the exact bounded file marker');
  const inspected = inspectExecutionLock(path);
  if (inspected.status !== 'uncertain' || expected.groupPid !== null || JSON.stringify(inspected.marker) !== JSON.stringify(expected)) throw new EngineError('COMMAND_EFFECTS_RECOVERY_STALE', 'Execution recovery requires the exact original file marker');
  try { process.kill(expected.ownerPid, 0); throw new EngineError('COMMAND_EFFECTS_OWNER_ALIVE', 'The original file effect process is still alive'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  const db = openDatabase(path); let transaction = false;
  try {
    db.exec('BEGIN EXCLUSIVE'); transaction = true;
    const marker = readMarker(db);
    if (JSON.stringify(marker) !== JSON.stringify(expected)) throw new EngineError('COMMAND_EFFECTS_RECOVERY_STALE', 'Execution marker changed before recovery');
    const changed = db.prepare('UPDATE command_execution SET active=0,updated_at=? WHERE id=1 AND owner_pid=? AND group_pid IS NULL AND active=1 AND updated_at=?').run(new Date().toISOString(), expected.ownerPid, expected.updatedAt);
    if (Number(changed.changes) !== 1) throw new EngineError('COMMAND_EFFECTS_RECOVERY_STALE', 'Execution recovery lost its marker comparison');
    db.exec('COMMIT'); transaction = false;
  } finally { if (transaction) db.exec('ROLLBACK'); db.close(); }
}

export function acquireExecutionLock(path: string, reservation?: ExecutionLockReservation): ExecutionLock {
  const owned = reservation === undefined ? undefined : reservations.get(reservation);
  if (reservation !== undefined && (!owned || owned.used || owned.path !== path)) throw new EngineError('COMMAND_EXECUTION_RESERVATION_INVALID', 'Execution reservation is foreign, consumed or bound to another lock');
  if (owned) owned.used = true;
  let database: DatabaseSync | undefined;
  let transaction = false;
  try {
    database = openDatabase(path);
    database.exec('BEGIN EXCLUSIVE');
    transaction = true;
    database.exec(SCHEMA);
    const previous = readMarker(database);
    if (previous?.active) throw uncertain(previous);
    database.prepare(`INSERT INTO command_execution (id, owner_pid, group_pid, active, updated_at)
      VALUES (1, ?, NULL, 1, ?)
      ON CONFLICT(id) DO UPDATE SET owner_pid=excluded.owner_pid, group_pid=NULL, active=1, updated_at=excluded.updated_at`).run(process.pid, owned?.marker.updatedAt ?? new Date().toISOString());
    database.exec('COMMIT');
    transaction = false;
    // A contender may briefly observe active=1 in this gap and fail closed.
    // If reacquisition itself fails, the already committed marker stays active.
    database.exec('BEGIN EXCLUSIVE');
    transaction = true;
    const claimed = readMarker(database);
    if (!claimed?.active || claimed.ownerPid !== process.pid || owned && claimed.updatedAt !== owned.marker.updatedAt) {
      throw new EngineError('COMMAND_CLEANUP_UNCERTAIN', 'The committed execution marker changed before its exclusive lock was acquired.');
    }
    const db = database;
    let released = false;
    const identity = lstatSync(path);
    const lock: ExecutionLock = {
      recordGroup(pid) {
        if (released) throw new EngineError('COMMAND_EXECUTION_LOCK_RELEASED', 'The command execution lock was already released.');
        if (!Number.isSafeInteger(pid) || pid < 1) throw new EngineError('INVALID_COMMAND_GROUP', 'Command process group PID must be a positive safe integer.');
        try {
          const changed = db.prepare('UPDATE command_execution SET group_pid=?, updated_at=? WHERE id=1 AND owner_pid=? AND active=1').run(pid, new Date().toISOString(), process.pid);
          if (Number(changed.changes) !== 1) throw new EngineError('COMMAND_CLEANUP_UNCERTAIN', 'The held command execution marker changed unexpectedly.');
        } catch (error) { throw normalizeError(error); }
      },
      release(cleanupConfirmed) {
        if (released) return;
        try {
          if (cleanupConfirmed === true) {
            const changed = db.prepare('UPDATE command_execution SET active=0, updated_at=? WHERE id=1 AND owner_pid=? AND active=1').run(new Date().toISOString(), process.pid);
            if (Number(changed.changes) !== 1) throw new EngineError('COMMAND_CLEANUP_UNCERTAIN', 'The held command execution marker changed unexpectedly.');
            db.exec('COMMIT');
          } else {
            db.exec('ROLLBACK');
          }
          transaction = false;
          db.close();
        } catch (error) {
          discard(db, transaction);
          throw normalizeError(error);
        } finally {
          released = true;
        }
      },
    };
    heldLocks.set(lock, () => { const current = lstatSync(path), marker = readMarker(db); if (released || !current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || !marker?.active || marker.ownerPid !== process.pid || marker.updatedAt !== claimed.updatedAt || marker.groupPid !== claimed.groupPid) throw new EngineError('COMMAND_EXECUTION_LOCK_STALE', 'Held execution lock identity or epoch changed'); });
    return lock;
  } catch (error) {
    discard(database, transaction);
    throw normalizeError(error);
  }
}
