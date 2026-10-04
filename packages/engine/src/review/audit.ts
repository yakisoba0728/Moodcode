import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { EngineError } from '@moodcode/contracts';
import type { RestoreResult } from './index.js';

export const REVIEW_JOURNAL_SCHEMA_VERSION = 1;
export const REVIEW_JOURNAL_LIMITS = Object.freeze({
  maxIdBytes: 512,
  maxPathBytes: 4_096,
  maxTextBytes: 4_096,
  maxResultBytes: 128 * 1_024,
  maxEntries: 2_048,
  maxListLimit: 100,
  maxRecoveryOperations: 10_000,
});

export interface RestoreOperationInput {
  id: string;
  checkpointId: string;
  runId: string;
  sessionId: string;
  workspaceId: string;
  fingerprint: string;
}
export interface BoundedRestoreResult extends RestoreResult {
  /** Lists/messages may be shortened; totals retain the service's actual counts. */
  truncated: boolean;
  totals: { restored: number; conflicts: number; failed: number; observations: number; warnings: number };
}
export interface RestoreOperation extends RestoreOperationInput {
  /** completed means the service returned; inspect result for partial failure/cancellation. */
  state: 'started' | 'completed' | 'failed' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  result?: BoundedRestoreResult;
  error?: { code: string; message: string };
}
export type RestoreOperationOutcome = RestoreResult | { error: { code: string; message: string } };

const APPLICATION_ID = 0x4d43524a; // MCRJ: never treat the primary engine DB as a review journal.
const SHA256 = /^[a-f0-9]{64}$/;
const BINDING_KEYS = ['id', 'checkpointId', 'runId', 'sessionId', 'workspaceId', 'fingerprint'] as const;
const RESULT_LIST_KEYS = ['restored', 'conflicts', 'failed', 'observations', 'warnings'] as const;
const INTERRUPTED_ERROR = {
  code: 'RESTORE_INTERRUPTED',
  message: 'Restoration did not record a final outcome; filesystem effects are unknown. Reconcile the workspace before further effects.',
};
const TABLE_SQL = [
  'CREATE TABLE review_operations (',
  'ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, checkpoint_id TEXT NOT NULL,',
  'run_id TEXT NOT NULL, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL, fingerprint TEXT NOT NULL,',
  "state TEXT NOT NULL CHECK(state IN ('started','completed','failed','interrupted')),",
  'started_at TEXT NOT NULL, finished_at TEXT, result TEXT, error TEXT, outcome_hash TEXT,',
  'CHECK(result IS NULL OR length(CAST(result AS BLOB)) <= ' + REVIEW_JOURNAL_LIMITS.maxResultBytes + '),',
  'CHECK(error IS NULL OR length(CAST(error AS BLOB)) <= 32768),',
  "CHECK((state='started' AND finished_at IS NULL AND result IS NULL AND error IS NULL AND outcome_hash IS NULL)",
  "OR (state='completed' AND finished_at IS NOT NULL AND result IS NOT NULL AND error IS NULL AND outcome_hash IS NOT NULL)",
  "OR (state IN ('failed','interrupted') AND finished_at IS NOT NULL AND result IS NULL AND error IS NOT NULL AND outcome_hash IS NOT NULL))",
  ') STRICT',
].join(' ');
const INDEX_SQL = 'CREATE INDEX review_operations_run ON review_operations(run_id, ordinal DESC)';
type Row = Record<string, SQLOutputValue>;

function failure(code: string, message: string): never { throw new EngineError(code, message); }
function object(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) failure(code, 'An object is required');
  return value as Record<string, unknown>;
}
function text(value: unknown, code: string, maxBytes?: number, nonempty = false): string {
  if (typeof value !== 'string' || nonempty && !value || Buffer.from(value, 'utf8').toString('utf8') !== value
    || maxBytes !== undefined && Buffer.byteLength(value, 'utf8') > maxBytes) {
    failure(code, 'A valid bounded UTF-8 string is required');
  }
  return value;
}
function identifier(value: unknown, code: string): string {
  const valueText = text(value, code, REVIEW_JOURNAL_LIMITS.maxIdBytes, true);
  if (valueText.includes('\0')) failure(code, 'Identifiers cannot contain NUL');
  return valueText;
}
function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function binding(value: unknown): RestoreOperationInput {
  const input = object(value, 'REVIEW_JOURNAL_INPUT_INVALID');
  const result = {
    id: identifier(input.id, 'REVIEW_JOURNAL_INPUT_INVALID'),
    checkpointId: identifier(input.checkpointId, 'REVIEW_JOURNAL_INPUT_INVALID'),
    runId: identifier(input.runId, 'REVIEW_JOURNAL_INPUT_INVALID'),
    sessionId: identifier(input.sessionId, 'REVIEW_JOURNAL_INPUT_INVALID'),
    workspaceId: identifier(input.workspaceId, 'REVIEW_JOURNAL_INPUT_INVALID'),
    fingerprint: text(input.fingerprint, 'REVIEW_JOURNAL_INPUT_INVALID', 64),
  };
  if (!SHA256.test(result.fingerprint)) failure('REVIEW_JOURNAL_INPUT_INVALID', 'A SHA-256 preview fingerprint is required');
  return result;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') failure('REVIEW_JOURNAL_RESULT_INVALID', 'Result flags must be boolean');
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) failure('REVIEW_JOURNAL_RESULT_INVALID', 'Result lists must be arrays');
  return value;
}
function currentHash(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !SHA256.test(value)) failure('REVIEW_JOURNAL_RESULT_INVALID', 'Observation hash must be SHA-256 or null');
  return value;
}
function resultShape(value: unknown): RestoreResult {
  const source = object(value, 'REVIEW_JOURNAL_RESULT_INVALID');
  const pathText = (v: unknown): string => text(v, 'REVIEW_JOURNAL_RESULT_INVALID', undefined, true);
  const message = (v: unknown): string => text(v, 'REVIEW_JOURNAL_RESULT_INVALID');
  if (source.atomic !== false) failure('REVIEW_JOURNAL_RESULT_INVALID', 'Restoration must describe independent file effects');
  return {
    checkpointId: identifier(source.checkpointId, 'REVIEW_JOURNAL_RESULT_INVALID'),
    runId: identifier(source.runId, 'REVIEW_JOURNAL_RESULT_INVALID'),
    atomic: false,
    restored: list(source.restored).map(pathText),
    conflicts: list(source.conflicts).map((value) => {
      const item = object(value, 'REVIEW_JOURNAL_RESULT_INVALID');
      return { path: pathText(item.path), reason: message(item.reason) };
    }),
    failed: list(source.failed).map((value) => {
      const item = object(value, 'REVIEW_JOURNAL_RESULT_INVALID');
      return { path: pathText(item.path), error: message(item.error), mayHaveChanged: boolean(item.mayHaveChanged) };
    }),
    warnings: list(source.warnings).map(message),
    cancelled: boolean(source.cancelled),
    observations: list(source.observations).map((value) => {
      const item = object(value, 'REVIEW_JOURNAL_RESULT_INVALID');
      const state = item.state;
      if (state !== 'present' && state !== 'absent' && state !== 'unobserved') failure('REVIEW_JOURNAL_RESULT_INVALID', 'Invalid observation state');
      const hash = currentHash(item.currentHash);
      const bytes = item.bytes;
      if (bytes !== undefined && (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0)) failure('REVIEW_JOURNAL_RESULT_INVALID', 'Invalid observation byte count');
      return {
        path: pathText(item.path), state,
        ...(hash !== undefined ? { currentHash: hash } : {}),
        ...(bytes !== undefined ? { bytes: bytes as number } : {}),
        ...(item.error !== undefined ? { error: message(item.error) } : {}),
      };
    }),
    effectsUncertain: boolean(source.effectsUncertain),
    executionBlocked: boolean(source.executionBlocked),
  };
}
function shortText(value: string, limit: number, shortened: () => void): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= limit) return value;
  shortened();
  let end = limit - 3; // Keep a UTF-8 boundary and an explicit ellipsis.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8') + '…';
}
function boundedResult(source: RestoreResult): BoundedRestoreResult {
  const result: BoundedRestoreResult = {
    checkpointId: source.checkpointId, runId: source.runId, atomic: false,
    restored: [], conflicts: [], failed: [], warnings: [], observations: [],
    cancelled: source.cancelled, effectsUncertain: source.effectsUncertain, executionBlocked: source.executionBlocked,
    truncated: false,
    totals: { restored: source.restored.length, conflicts: source.conflicts.length, failed: source.failed.length, observations: source.observations.length, warnings: source.warnings.length },
  };
  let bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  const shortened = (): void => { result.truncated = true; };
  const pathText = (value: string): string => shortText(value, REVIEW_JOURNAL_LIMITS.maxPathBytes, shortened);
  const message = (value: string): string => shortText(value, REVIEW_JOURNAL_LIMITS.maxTextBytes, shortened);
  function add<T>(target: T[], input: readonly T[]): void {
    const count = Math.min(input.length, REVIEW_JOURNAL_LIMITS.maxEntries);
    if (count !== input.length) shortened();
    for (let index = 0; index < count; index++) {
      const entry = input[index]!;
      const cost = Buffer.byteLength(JSON.stringify(entry), 'utf8') + (target.length ? 1 : 0);
      if (bytes + cost > REVIEW_JOURNAL_LIMITS.maxResultBytes) { shortened(); break; }
      target.push(entry);
      bytes += cost;
    }
  }
  // Retain failure details before large success lists. Only known metadata is copied.
  add(result.failed, source.failed.slice(0, REVIEW_JOURNAL_LIMITS.maxEntries).map((item) => ({ path: pathText(item.path), error: message(item.error), mayHaveChanged: item.mayHaveChanged })));
  add(result.conflicts, source.conflicts.slice(0, REVIEW_JOURNAL_LIMITS.maxEntries).map((item) => ({ path: pathText(item.path), reason: message(item.reason) })));
  add(result.warnings, source.warnings.slice(0, REVIEW_JOURNAL_LIMITS.maxEntries).map(message));
  add(result.observations, source.observations.slice(0, REVIEW_JOURNAL_LIMITS.maxEntries).map((item) => ({ ...item, path: pathText(item.path), ...(item.error !== undefined ? { error: message(item.error) } : {}) })));
  add(result.restored, source.restored.slice(0, REVIEW_JOURNAL_LIMITS.maxEntries).map(pathText));
  for (const key of RESULT_LIST_KEYS) if (result[key].length !== source[key].length) shortened();
  return result;
}
function normalOutcome(value: RestoreOperationOutcome, operation: RestoreOperationInput): {
  state: 'completed' | 'failed'; hash: string; result?: BoundedRestoreResult; error?: RestoreOperation['error'];
} {
  const source = object(value, 'REVIEW_JOURNAL_RESULT_INVALID');
  if ('error' in source) {
    const error = object(source.error, 'REVIEW_JOURNAL_RESULT_INVALID');
    const raw = {
      code: text(error.code, 'REVIEW_JOURNAL_RESULT_INVALID', undefined, true),
      message: text(error.message, 'REVIEW_JOURNAL_RESULT_INVALID'),
    };
    return { state: 'failed', hash: digest(JSON.stringify({ error: raw })), error: {
      code: shortText(raw.code, REVIEW_JOURNAL_LIMITS.maxIdBytes, () => {}),
      message: shortText(raw.message, REVIEW_JOURNAL_LIMITS.maxTextBytes, () => {}),
    } };
  }
  const raw = resultShape(value);
  if (raw.checkpointId !== operation.checkpointId || raw.runId !== operation.runId) failure('REVIEW_JOURNAL_OUTCOME_CONFLICT', 'Restore result belongs to a different operation binding');
  return { state: 'completed', hash: digest(JSON.stringify({ result: raw })), result: boundedResult(raw) };
}

function regularFile(file: string): Stats | undefined {
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) {
    failure('REVIEW_JOURNAL_PATH_UNSUPPORTED', 'Review journal paths must be regular files with one link');
  }
  return info;
}
function privateFile(file: string): Stats {
  if (!regularFile(file)) {
    let fd: number | undefined;
    try { fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return regularFile(file)!;
}
function sidecars(file: string): void { for (const suffix of ['-journal', '-wal', '-shm']) regularFile(file + suffix); }
function canonicalPath(file: string): string {
  if (typeof file !== 'string' || !file || file.includes('\0') || file === ':memory:') failure('REVIEW_JOURNAL_PATH_UNSUPPORTED', 'A persistent review journal file path is required');
  const absolute = resolve(file);
  regularFile(absolute); // Reject leaf aliases, including dangling symlinks.
  mkdirSync(dirname(absolute), { recursive: true });
  return join(realpathSync(dirname(absolute)), basename(absolute));
}
function sameIdentity(left: Stats, right: Stats | undefined): boolean {
  return Boolean(right && right.dev === left.dev && right.ino === left.ino);
}
function busy(error: unknown): boolean {
  const code = (error as { errcode?: number }).errcode;
  return typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6);
}
function normalizedSql(value: unknown): string { return String(value).trim().replace(/;$/, '').replace(/\s+/g, ' ').toLowerCase(); }
function schema(db: DatabaseSync): void {
  const rows = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 4").all();
  if (rows.length !== 2
    || rows[0]?.type !== 'table' || rows[0].name !== 'review_operations' || normalizedSql(rows[0].sql) !== normalizedSql(TABLE_SQL)
    || rows[1]?.type !== 'index' || rows[1].name !== 'review_operations_run' || normalizedSql(rows[1].sql) !== normalizedSql(INDEX_SQL)) {
    failure('REVIEW_JOURNAL_SCHEMA_INVALID', 'Review journal schema is invalid');
  }
  const check = db.prepare('PRAGMA quick_check(1)').get();
  if (!check || Object.values(check)[0] !== 'ok') failure('REVIEW_JOURNAL_SCHEMA_INVALID', 'Review journal integrity check failed');
}
function operationFromRow(row: Row): RestoreOperation {
  try {
    const input = binding({ id: row.id, checkpointId: row.checkpoint_id, runId: row.run_id, sessionId: row.session_id, workspaceId: row.workspace_id, fingerprint: row.fingerprint });
    const timestamp = (value: unknown): string => {
      const result = text(value, 'REVIEW_JOURNAL_SCHEMA_INVALID', 64, true);
      if (new Date(result).toISOString() !== result) failure('REVIEW_JOURNAL_SCHEMA_INVALID', 'Invalid review journal timestamp');
      return result;
    };
    const state = row.state;
    if (state !== 'started' && state !== 'completed' && state !== 'failed' && state !== 'interrupted') failure('REVIEW_JOURNAL_SCHEMA_INVALID', 'Invalid review journal state');
    const operation: RestoreOperation = { ...input, state, startedAt: timestamp(row.started_at) };
    if (state === 'started') {
      if (row.finished_at !== null || row.result !== null || row.error !== null || row.outcome_hash !== null) failure('REVIEW_JOURNAL_SCHEMA_INVALID', 'Started operation already has an outcome');
      return operation;
    }
    operation.finishedAt = timestamp(row.finished_at);
    if (typeof row.outcome_hash !== 'string' || !SHA256.test(row.outcome_hash)) failure('REVIEW_JOURNAL_SCHEMA_INVALID', 'Invalid outcome digest');
    if (state === 'completed') {
      if (typeof row.result !== 'string' || row.error !== null || Buffer.byteLength(row.result, 'utf8') > REVIEW_JOURNAL_LIMITS.maxResultBytes) failure('REVIEW_JOURNAL_SCHEMA_INVALID', 'Invalid recorded restore result');
      const raw = object(JSON.parse(row.result), 'REVIEW_JOURNAL_SCHEMA_INVALID');
      const result = resultShape(raw);
      if (boundedResult(result).truncated) failure('REVIEW_JOURNAL_SCHEMA_INVALID', 'Recorded result exceeds its metadata limits');
      if (result.checkpointId !== input.checkpointId || result.runId !== input.runId || typeof raw.truncated !== 'boolean') failure('REVIEW_JOURNAL_SCHEMA_INVALID', 'Recorded result binding is invalid');
      const totalsSource = object(raw.totals, 'REVIEW_JOURNAL_SCHEMA_INVALID');
      const totals = {} as BoundedRestoreResult['totals'];
      for (const key of RESULT_LIST_KEYS) {
        const total = totalsSource[key];
        if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < result[key].length || !raw.truncated && total !== result[key].length) failure('REVIEW_JOURNAL_SCHEMA_INVALID', 'Recorded result totals are invalid');
        totals[key] = total;
      }
      operation.result = { ...result, truncated: raw.truncated, totals };
    } else {
      if (row.result !== null || typeof row.error !== 'string' || Buffer.byteLength(row.error, 'utf8') > 32_768) failure('REVIEW_JOURNAL_SCHEMA_INVALID', 'Invalid recorded restore error');
      const error = object(JSON.parse(row.error), 'REVIEW_JOURNAL_SCHEMA_INVALID');
      operation.error = { code: text(error.code, 'REVIEW_JOURNAL_SCHEMA_INVALID', REVIEW_JOURNAL_LIMITS.maxIdBytes, true), message: text(error.message, 'REVIEW_JOURNAL_SCHEMA_INVALID', REVIEW_JOURNAL_LIMITS.maxTextBytes) };
    }
    return operation;
  } catch (error) {
    if (error instanceof EngineError && error.code === 'REVIEW_JOURNAL_SCHEMA_INVALID') throw error;
    failure('REVIEW_JOURNAL_SCHEMA_INVALID', 'A review journal record is invalid');
  }
}

/**
 * Separate durable audit history; never updates terminal Runs or primary journal rows.
 * Each start/finish commits a FULL synchronous SQLite transaction before returning.
 */
export class ReviewJournal {
  private readonly db: DatabaseSync;
  private readonly owner: DatabaseSync;
  private readonly databasePath: string;
  private readonly databaseIdentity: Stats;
  private readonly ownerIdentity: Stats;
  private closed = false;

  constructor(file: string) {
    const path = canonicalPath(file);
    const ownerPath = path + '.owner.sqlite';
    sidecars(path);
    sidecars(ownerPath);
    const ownerIdentity = privateFile(ownerPath);
    let owner: DatabaseSync | undefined;
    let db: DatabaseSync | undefined;
    try {
      owner = new DatabaseSync(ownerPath, { timeout: 0 });
      try { owner.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE'); }
      catch (error) {
        if (busy(error)) failure('REVIEW_JOURNAL_LOCKED', 'Another engine already owns this review journal');
        throw error;
      }
      if (!sameIdentity(ownerIdentity, regularFile(ownerPath))) failure('REVIEW_JOURNAL_PATH_UNSUPPORTED', 'Review journal owner path changed');
      const databaseIdentity = privateFile(path);
      db = new DatabaseSync(path, { timeout: 1_000 });
      db.exec('PRAGMA trusted_schema=OFF');
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (typeof version !== 'number' || version !== 0 && version !== REVIEW_JOURNAL_SCHEMA_VERSION) failure('REVIEW_JOURNAL_VERSION_UNSUPPORTED', 'Review journal schema version is unsupported');
      const appId = db.prepare('PRAGMA application_id').get()?.application_id;
      if (version === 0) {
        if (appId !== 0 || db.prepare('SELECT name FROM sqlite_schema LIMIT 1').get()) failure('REVIEW_JOURNAL_SCHEMA_INVALID', 'Cannot initialize a nonempty unrelated database as a review journal');
      } else {
        if (appId !== APPLICATION_ID) failure('REVIEW_JOURNAL_SCHEMA_INVALID', 'Database is not a Moodcode review journal');
        schema(db);
      }
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA busy_timeout=1000');
      if (version === 0) {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(TABLE_SQL + '; ' + INDEX_SQL + '; PRAGMA application_id=' + APPLICATION_ID + '; PRAGMA user_version=' + REVIEW_JOURNAL_SCHEMA_VERSION);
          db.exec('COMMIT');
        } catch (error) { try { db.exec('ROLLBACK'); } catch { /* Preserve the initialization error. */ } throw error; }
      }
      if (!sameIdentity(databaseIdentity, regularFile(path))) failure('REVIEW_JOURNAL_PATH_UNSUPPORTED', 'Review journal file identity changed');
      this.db = db;
      this.owner = owner;
      this.databasePath = path;
      this.databaseIdentity = databaseIdentity;
      this.ownerIdentity = ownerIdentity;
    } catch (error) {
      try { db?.close(); } finally { owner?.close(); }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) failure('REVIEW_JOURNAL_CLOSED', 'Review journal is closed');
    if (!sameIdentity(this.databaseIdentity, regularFile(this.databasePath))
      || !sameIdentity(this.ownerIdentity, regularFile(this.databasePath + '.owner.sqlite'))) failure('REVIEW_JOURNAL_PATH_UNSUPPORTED', 'Review journal or owner file identity changed');
    sidecars(this.databasePath);
    sidecars(this.databasePath + '.owner.sqlite');
  }
  private transaction<T>(action: () => T): T {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* Preserve the operation error. */ } throw error; }
  }
  private row(id: string): Row | undefined { return this.db.prepare('SELECT * FROM review_operations WHERE id=?').get(id); }

  get(id: string): RestoreOperation | undefined {
    identifier(id, 'REVIEW_JOURNAL_INPUT_INVALID');
    this.assertOpen();
    const row = this.row(id);
    return row ? operationFromRow(row) : undefined;
  }

  start(value: RestoreOperationInput): RestoreOperation {
    const input = binding(value);
    return this.transaction(() => {
      const existing = this.row(input.id);
      if (existing) {
        const operation = operationFromRow(existing);
        if (BINDING_KEYS.some((key) => operation[key] !== input[key])) failure('REVIEW_JOURNAL_OPERATION_CONFLICT', 'Operation ID is already bound to a different restore request');
        return operation; // Caller must not replay effects for an existing operation.
      }
      this.db.prepare('INSERT INTO review_operations(id,checkpoint_id,run_id,session_id,workspace_id,fingerprint,state,started_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(input.id, input.checkpointId, input.runId, input.sessionId, input.workspaceId, input.fingerprint, 'started', new Date().toISOString());
      return operationFromRow(this.row(input.id)!);
    });
  }

  finish(id: string, value: RestoreOperationOutcome): RestoreOperation {
    identifier(id, 'REVIEW_JOURNAL_INPUT_INVALID');
    return this.transaction(() => {
      const row = this.row(id);
      if (!row) failure('REVIEW_JOURNAL_OPERATION_NOT_FOUND', 'Restore operation was not started');
      const existing = operationFromRow(row);
      const outcome = normalOutcome(value, existing);
      if (existing.state !== 'started') {
        if (existing.state !== outcome.state || row.outcome_hash !== outcome.hash) failure('REVIEW_JOURNAL_OUTCOME_CONFLICT', 'A restore operation outcome is immutable');
        return existing;
      }
      this.db.prepare('UPDATE review_operations SET state=?,finished_at=?,result=?,error=?,outcome_hash=? WHERE id=? AND state=?')
        .run(outcome.state, new Date().toISOString(), outcome.result ? JSON.stringify(outcome.result) : null, outcome.error ? JSON.stringify(outcome.error) : null, outcome.hash, id, 'started');
      return operationFromRow(this.row(id)!);
    });
  }

  list(runId: string, limit = 20): RestoreOperation[] {
    identifier(runId, 'REVIEW_JOURNAL_INPUT_INVALID');
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > REVIEW_JOURNAL_LIMITS.maxListLimit) failure('REVIEW_JOURNAL_LIMIT_EXCEEDED', 'Review history limit must be between 0 and 100');
    this.assertOpen();
    return this.db.prepare('SELECT * FROM review_operations WHERE run_id=? ORDER BY ordinal DESC LIMIT ?').all(runId, limit).map(operationFromRow);
  }

  /** Returns all unresolved interrupted records so every startup can re-quarantine. */
  recoverPending(): RestoreOperation[] {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM review_operations WHERE state IN ('started','interrupted') ORDER BY ordinal LIMIT ?").all(REVIEW_JOURNAL_LIMITS.maxRecoveryOperations + 1);
      if (rows.length > REVIEW_JOURNAL_LIMITS.maxRecoveryOperations) failure('REVIEW_JOURNAL_LIMIT_EXCEEDED', 'Too many unresolved restore operations to recover safely');
      const operations = rows.map(operationFromRow);
      const finishedAt = new Date().toISOString();
      const error = JSON.stringify(INTERRUPTED_ERROR);
      const outcomeHash = digest(error);
      const update = this.db.prepare("UPDATE review_operations SET state='interrupted',finished_at=?,error=?,outcome_hash=? WHERE id=? AND state='started'");
      for (const operation of operations) if (operation.state === 'started') update.run(finishedAt, error, outcomeHash, operation.id);
      return operations.map((operation) => operation.state === 'started' ? operationFromRow(this.row(operation.id)!) : operation);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } finally { this.owner.close(); }
  }
}
