import { constants, lstatSync, openSync, closeSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EngineError } from '@moodcode/contracts';
import { TERMINAL_LIMITS, type TerminalJournal, type TerminalSnapshot } from './types.js';
import { validatePtyDiagnostics } from './diagnostics.js';

const STATES = new Set(['starting', 'running', 'completed', 'cancelled', 'failed', 'interrupted', 'uncertain']);
function validSnapshot(value: unknown): TerminalSnapshot {
  const snapshot = value as TerminalSnapshot, record = snapshot?.record;
  if (!record || record.version !== 1 || typeof record.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(record.id)
    || record.owner?.authority !== 'user' || ![record.owner.workspaceId, record.owner.sessionId, record.cwd, record.file, record.createdAt, record.updatedAt].every(item => typeof item === 'string' && item.length > 0 && item.length <= 8192)
    || !STATES.has(record.state) || !Array.isArray(record.args) || record.args.length > 128 || !record.args.every(arg => typeof arg === 'string' && Buffer.byteLength(arg) <= 8192)
    || !Number.isSafeInteger(record.outputSeq) || record.outputSeq < 0 || !Number.isSafeInteger(record.oldestSeq) || record.oldestSeq < 1
    || !Number.isSafeInteger(record.observedBytes) || record.observedBytes < 0 || !Number.isSafeInteger(record.retainedBytes) || record.retainedBytes < 0 || record.retainedBytes > TERMINAL_LIMITS.bufferBytes
    || !Number.isSafeInteger(record.cols) || record.cols < 1 || record.cols > TERMINAL_LIMITS.maxCols || !Number.isSafeInteger(record.rows) || record.rows < 1 || record.rows > TERMINAL_LIMITS.maxRows
    || !Array.isArray(snapshot.output) || snapshot.output.length > TERMINAL_LIMITS.bufferBytes) throw new EngineError('TERMINAL_JOURNAL_INVALID', 'Stored terminal metadata is invalid');
  let bytes = 0, seq = record.oldestSeq - 1;
  for (const item of snapshot.output) {
    if (!Number.isSafeInteger(item.seq) || item.seq !== seq + 1 || item.seq > record.outputSeq || typeof item.data !== 'string' || item.bytes !== Buffer.byteLength(item.data) || item.bytes < 1 || item.bytes > TERMINAL_LIMITS.eventBytes) throw new EngineError('TERMINAL_JOURNAL_INVALID', 'Stored terminal replay is invalid');
    seq = item.seq; bytes += item.bytes;
  }
  if (bytes !== record.retainedBytes || seq !== record.outputSeq || record.observedBytes < bytes) throw new EngineError('TERMINAL_JOURNAL_INVALID', 'Stored terminal replay accounting is invalid');
  if (record.diagnostics !== undefined) {
    try { validatePtyDiagnostics(record.diagnostics); }
    catch { throw new EngineError('TERMINAL_JOURNAL_INVALID', 'Stored terminal diagnostics are invalid'); }
  }
  return structuredClone(snapshot);
}

export class MemoryTerminalJournal implements TerminalJournal {
  private readonly records = new Map<string, TerminalSnapshot>();
  load(): TerminalSnapshot[] { return [...this.records.values()].map(value => structuredClone(value)); }
  read(id: string): TerminalSnapshot | undefined { const value = this.records.get(id); return value ? structuredClone(value) : undefined; }
  save(snapshot: TerminalSnapshot): void {
    const validated = validSnapshot(snapshot);
    if (!this.records.has(validated.record.id) && this.records.size >= TERMINAL_LIMITS.maxRecords) throw new EngineError('TERMINAL_RECORD_LIMIT', 'Terminal history capacity was exceeded');
    this.records.set(validated.record.id, validated);
  }
  remove(id: string): void { this.records.delete(id); }
}

/** A host-selected local journal. Restored rows are history, never live handles. */
export class SqliteTerminalJournal implements TerminalJournal {
  private readonly db: DatabaseSync;
  constructor(location = ':memory:') {
    let filename = location;
    if (location !== ':memory:') {
      filename = resolve(location);
      if (realpathSync(dirname(filename)) !== dirname(filename) || !statSync(dirname(filename)).isDirectory()) throw new EngineError('TERMINAL_JOURNAL_PATH', 'Terminal history requires a canonical local directory');
      try {
        const info = lstatSync(filename);
        if (!info.isFile() || info.isSymbolicLink()) throw new EngineError('TERMINAL_JOURNAL_PATH', 'Terminal history must be a regular file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const fd = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(fd);
      }
    }
    this.db = new DatabaseSync(filename);
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== 0 && version !== 1) { this.db.close(); throw new EngineError('TERMINAL_JOURNAL_VERSION', 'Terminal history schema is unsupported'); }
    this.db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS terminals (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(length(payload) <= 4194304)); PRAGMA user_version=1;');
  }
  load(): TerminalSnapshot[] {
    const rows = this.db.prepare('SELECT payload FROM terminals ORDER BY id LIMIT ?').all(TERMINAL_LIMITS.maxRecords + 1);
    if (rows.length > TERMINAL_LIMITS.maxRecords) throw new EngineError('TERMINAL_RECORD_LIMIT', 'Terminal history capacity was exceeded');
    return rows.map(row => { try { return validSnapshot(JSON.parse(String(row.payload))); } catch { throw new EngineError('TERMINAL_JOURNAL_INVALID', 'Stored terminal history is invalid'); } });
  }
  read(id: string): TerminalSnapshot | undefined {
    const head = this.db.prepare('SELECT length(CAST(payload AS BLOB)) bytes FROM terminals WHERE id=?').get(id);
    if (!head) return;
    if (!Number.isSafeInteger(head.bytes) || Number(head.bytes) > 4_194_304) throw new EngineError('TERMINAL_JOURNAL_LIMIT', 'Terminal observation exceeds its stored byte bound');
    const row = this.db.prepare('SELECT payload FROM terminals WHERE id=? AND length(CAST(payload AS BLOB))=?').get(id, Number(head.bytes));
    if (!row) throw new EngineError('TERMINAL_JOURNAL_INVALID', 'Terminal observation changed during its bounded read');
    try { return validSnapshot(JSON.parse(String(row.payload))); }
    catch { throw new EngineError('TERMINAL_JOURNAL_INVALID', 'Stored terminal observation is invalid'); }
  }
  save(snapshot: TerminalSnapshot): void {
    const value = validSnapshot(snapshot), payload = JSON.stringify(value);
    if (Buffer.byteLength(payload) > 4_194_304) throw new EngineError('TERMINAL_JOURNAL_LIMIT', 'Stored terminal history is too large');
    if (!this.db.prepare('SELECT id FROM terminals WHERE id = ?').get(value.record.id) && Number(this.db.prepare('SELECT count(*) AS count FROM terminals').get()?.count) >= TERMINAL_LIMITS.maxRecords) throw new EngineError('TERMINAL_RECORD_LIMIT', 'Terminal history capacity was exceeded');
    this.db.prepare('INSERT INTO terminals (id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(value.record.id, payload);
  }
  remove(id: string): void { this.db.prepare('DELETE FROM terminals WHERE id = ?').run(id); }
  close(): void { this.db.close(); }
}
