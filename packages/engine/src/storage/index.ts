import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  EngineError, isTerminal, SCHEMA_VERSION,
  type ApprovalRecord, type Checkpoint, type EngineEvent, type JsonObject,
  type Message, type Run, type RunReceipt, type RunState, type Session,
  type SessionSnapshot, type SubmitInput, type ToolCallRecord, type Workspace,
} from '@moodcode/contracts';
import type { CommitChange, EngineStore } from '../ports.js';
import { backupDatabase, inspectIntegrity, type DatabaseBackup, type IntegrityCheckResult, type StoreBackupOptions } from './maintenance.js';
export type { DatabaseBackup, IntegrityCheckResult, StoreBackupOptions } from './maintenance.js';

const DB_VERSION = 1;
const PAGE_SIZE = 128;
const MAX_PAGE_SIZE = 1_024;
type DataRow = { data: string };
type Waiter = { sessionId: string; wake: () => void };
const ACTIVE_STATES = "'created','running','awaiting_approval','cancelling'";
const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  created: ['running', 'cancelling', 'cancelled', 'failed', 'interrupted'],
  running: ['awaiting_approval', 'cancelling', 'completed', 'failed', 'interrupted'],
  awaiting_approval: ['running', 'cancelling', 'failed', 'interrupted'],
  cancelling: ['cancelled', 'failed', 'interrupted'],
  completed: [], cancelled: [], failed: [], interrupted: [],
};

function encode(value: unknown): string { return JSON.stringify(value); }
function decode<T>(row: DataRow): T { return JSON.parse(row.data) as T; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new EngineError('INVALID_RECORD', 'Records must contain JSON values');
  return result;
}
function requireMatch(actual: unknown, expected: unknown, description: string): void {
  if (canonical(actual) !== canonical(expected)) throw new EngineError('RECORD_CONFLICT', description);
}
function cursor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new EngineError('INVALID_CURSOR', 'Event cursor must be a nonnegative safe integer');
}
function assertSingleLink(path: string): void {
  if (statSync(path).nlink > 1) throw new EngineError('DB_PATH_UNSUPPORTED', 'Hard-linked SQLite database paths are unsupported');
}
function canonicalPath(path: string): string {
  if (!path || path.includes('\0')) throw new EngineError('DB_PATH_UNSUPPORTED', 'A database file path is required');
  if (path === ':memory:') return path;
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  if (existsSync(absolute)) {
    const result = realpathSync(absolute);
    if (!statSync(result).isFile()) throw new EngineError('DB_PATH_UNSUPPORTED', 'Database path must be a regular file');
    assertSingleLink(result);
    return result;
  }
  if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new EngineError('DB_PATH_UNSUPPORTED', 'A dangling database symlink is unsupported');
  }
  // Resolve parent aliases before the database exists, so both owners share the same lock.
  return join(realpathSync(dirname(absolute)), basename(absolute));
}
function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: number }).errcode;
  return code !== undefined && ((code & 0xff) === 5 || (code & 0xff) === 6);
}

/** SQLite records and journal. File-backed stores own one OS-released SQLite lock. */
export class SqliteStore implements EngineStore {
  private readonly db: DatabaseSync;
  private readonly databasePath: string;
  private readonly ownership?: DatabaseSync;
  private readonly waiters = new Set<Waiter>();
  private pendingBackups = 0;
  private released = false;
  private backupConnectionFailure?: EngineError;
  private resolveClose!: () => void;
  private rejectClose!: (error: unknown) => void;
  private readonly closeCompletion = new Promise<void>((resolveClose, rejectClose) => {
    this.resolveClose = resolveClose;
    this.rejectClose = rejectClose;
  });
  private closed = false;

  constructor(dbPath: string) {
    // Legacy synchronous close may fail before any closeAsync caller attaches a handler.
    void this.closeCompletion.catch(() => {});
    const path = canonicalPath(dbPath);
    this.databasePath = path;
    let ownership: DatabaseSync | undefined;
    let db: DatabaseSync | undefined;
    try {
      if (path !== ':memory:') {
        const ownerPath = `${path}.owner.sqlite`;
        if (existsSync(ownerPath)) {
          if (lstatSync(ownerPath).isSymbolicLink()) throw new EngineError('DB_PATH_UNSUPPORTED', 'Ownership database cannot be a symlink');
          assertSingleLink(ownerPath);
        }
        ownership = new DatabaseSync(ownerPath, { timeout: 0 });
        try {
          // WAL would weaken BEGIN EXCLUSIVE to a reserved writer lock; keep DELETE mode.
          ownership.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
        } catch (error) {
          if (isBusy(error)) throw new EngineError('DB_LOCKED', 'Another engine already owns this database');
          throw error;
        }
      }
      db = new DatabaseSync(path, { timeout: 1_000 });
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (!Number.isInteger(version) || version < 0 || version > DB_VERSION) {
        throw new EngineError('DB_VERSION_UNSUPPORTED', `Database version ${version} is unsupported (maximum ${DB_VERSION})`);
      }
      // Inspect user_version before making any changes to a future-version database.
      db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      if (version === 0) this.migrate(db);
      if (path !== ':memory:') assertSingleLink(path);
      this.db = db;
      this.ownership = ownership;
    } catch (error) {
      try { db?.close(); } finally { ownership?.close(); }
      throw error;
    }
  }

  private migrate(db: DatabaseSync): void {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, data TEXT NOT NULL) STRICT;
        CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), last_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_seq >= 0), data TEXT NOT NULL) STRICT;
        CREATE TABLE inputs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, admitted_seq INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(session_id, request_id)) STRICT;
        CREATE TABLE runs (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, input_id TEXT NOT NULL UNIQUE REFERENCES inputs(id), session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), state TEXT NOT NULL CHECK(state IN (${ACTIVE_STATES},'completed','cancelled','failed','interrupted')), data TEXT NOT NULL) STRICT;
        CREATE UNIQUE INDEX one_active_run_per_workspace ON runs(workspace_id) WHERE state IN (${ACTIVE_STATES});
        CREATE TABLE messages (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL) STRICT;
        CREATE TABLE tools (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id), state TEXT NOT NULL, data TEXT NOT NULL) STRICT;
        CREATE TABLE approvals (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id), tool_call_id TEXT NOT NULL REFERENCES tools(id), status TEXT NOT NULL, data TEXT NOT NULL) STRICT;
        CREATE TABLE checkpoints (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL REFERENCES runs(id), tool_call_id TEXT NOT NULL REFERENCES tools(id), data TEXT NOT NULL) STRICT;
        CREATE TABLE events (session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL CHECK(seq > 0), event_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL REFERENCES runs(id), type TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id, seq)) STRICT;
        CREATE INDEX runs_session ON runs(session_id, ordinal);
        CREATE INDEX messages_session ON messages(session_id, ordinal);
        CREATE INDEX tools_session ON tools(session_id, ordinal);
        CREATE INDEX approvals_session ON approvals(session_id, ordinal);
        CREATE INDEX checkpoints_run ON checkpoints(run_id, ordinal);
        PRAGMA user_version=1;
      `);
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back. */ } throw error; }
  }

  private assertOpen(): void {
    if (this.closed) throw new EngineError('STORE_CLOSED', 'Storage is closed');
  }
  private row(sql: string, ...values: SQLInputValue[]): DataRow | undefined {
    return this.db.prepare(sql).get(...values) as DataRow | undefined;
  }
  private rows<T>(sql: string, ...values: SQLInputValue[]): T[] {
    return (this.db.prepare(sql).all(...values) as DataRow[]).map(decode<T>);
  }
  private transaction<T>(operation: () => T, write = true): T {
    this.assertOpen();
    this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* Keep the transaction failure. */ } throw error; }
  }
  private notify(sessionId: string): void {
    for (const waiter of [...this.waiters]) if (waiter.sessionId === sessionId) waiter.wake();
  }

  putWorkspace(workspace: Workspace): Workspace {
    return this.transaction(() => {
      const byRoot = this.row('SELECT data FROM workspaces WHERE root=?', workspace.root);
      if (byRoot) return decode<Workspace>(byRoot);
      const byId = this.row('SELECT data FROM workspaces WHERE id=?', workspace.id);
      if (byId) throw new EngineError('RECORD_CONFLICT', 'Workspace ID already belongs to a different root');
      this.db.prepare('INSERT INTO workspaces(id,root,data) VALUES(?,?,?)').run(workspace.id, workspace.root, encode(workspace));
      return JSON.parse(encode(workspace)) as Workspace;
    });
  }
  getWorkspace(id: string): Workspace {
    this.assertOpen();
    const row = this.row('SELECT data FROM workspaces WHERE id=?', id);
    if (!row) throw new EngineError('WORKSPACE_NOT_FOUND', `Workspace ${id} was not found`);
    return decode(row);
  }
  listWorkspaces(): Workspace[] {
    this.assertOpen();
    return this.rows('SELECT data FROM workspaces ORDER BY rowid');
  }
  createSession(session: Session): Session {
    return this.transaction(() => {
      this.getWorkspace(session.workspaceId);
      const existing = this.row('SELECT data FROM sessions WHERE id=?', session.id);
      if (existing) { requireMatch(decode(existing), session, 'Session ID already exists'); return decode(existing); }
      this.db.prepare('INSERT INTO sessions(id,workspace_id,data) VALUES(?,?,?)').run(session.id, session.workspaceId, encode(session));
      return JSON.parse(encode(session)) as Session;
    });
  }
  getSession(id: string): Session {
    this.assertOpen();
    const row = this.row('SELECT data FROM sessions WHERE id=?', id);
    if (!row) throw new EngineError('SESSION_NOT_FOUND', `Session ${id} was not found`);
    return decode(row);
  }
  listSessions(workspaceId: string): Session[] {
    this.getWorkspace(workspaceId);
    return this.rows('SELECT data FROM sessions WHERE workspace_id=? ORDER BY rowid', workspaceId);
  }

  admit(input: SubmitInput): RunReceipt {
    let admitted: EngineEvent | undefined;
    const receipt = this.transaction(() => {
      const session = this.getSession(input.sessionId);
      const fingerprint = canonical(input);
      const existing = this.db.prepare('SELECT inputs.id, inputs.fingerprint, inputs.admitted_seq, runs.id AS run_id FROM inputs JOIN runs ON runs.input_id=inputs.id WHERE inputs.session_id=? AND inputs.request_id=?').get(input.sessionId, input.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new EngineError('REQUEST_ID_CONFLICT', 'Request ID was already used for different input');
        return { runId: String(existing.run_id), inputId: String(existing.id), admittedSeq: Number(existing.admitted_seq), duplicate: true };
      }
      const busy = this.db.prepare(`SELECT id FROM runs WHERE workspace_id=? AND state IN (${ACTIVE_STATES})`).get(session.workspaceId);
      if (busy) throw new EngineError('WORKSPACE_BUSY', 'Workspace already has an active run', { runId: String(busy.id), workspaceId: session.workspaceId });
      const timestamp = new Date().toISOString();
      const inputId = randomUUID();
      const run: Run = {
        id: randomUUID(), inputId, sessionId: session.id, workspaceId: session.workspaceId,
        requestId: input.requestId, prompt: input.prompt, config: input.config,
        state: 'created', createdAt: timestamp, updatedAt: timestamp,
      };
      this.db.prepare('INSERT INTO inputs(id,session_id,request_id,fingerprint,admitted_seq,data) VALUES(?,?,?,?,0,?)').run(inputId, session.id, input.requestId, fingerprint, encode(input));
      this.db.prepare('INSERT INTO runs(id,input_id,session_id,workspace_id,state,data) VALUES(?,?,?,?,?,?)').run(run.id, inputId, session.id, session.workspaceId, run.state, encode(run));
      const message: Message = { id: randomUUID(), sessionId: session.id, runId: run.id, role: 'user', content: input.prompt, createdAt: timestamp };
      this.writeMessage(run, message);
      admitted = this.append(run, 'input.admitted', { runId: run.id, inputId, requestId: input.requestId });
      this.db.prepare('UPDATE inputs SET admitted_seq=? WHERE id=?').run(admitted.seq, inputId);
      return { runId: run.id, inputId, admittedSeq: admitted.seq, duplicate: false };
    });
    if (admitted) this.notify(admitted.sessionId);
    return receipt;
  }
  getRun(id: string): Run {
    this.assertOpen();
    const row = this.row('SELECT data FROM runs WHERE id=?', id);
    if (!row) throw new EngineError('RUN_NOT_FOUND', `Run ${id} was not found`);
    return decode(row);
  }

  private append(run: Run, type: string, payload: JsonObject): EngineEvent {
    const row = this.db.prepare('UPDATE sessions SET last_seq=last_seq+1 WHERE id=? AND last_seq < ? RETURNING last_seq').get(run.sessionId, Number.MAX_SAFE_INTEGER);
    if (!row) throw new EngineError('SEQUENCE_EXHAUSTED', 'Session event sequence exceeded the safe integer range');
    const event: EngineEvent = { schemaVersion: SCHEMA_VERSION, eventId: randomUUID(), sessionId: run.sessionId, runId: run.id, seq: Number(row.last_seq), timestamp: new Date().toISOString(), type, payload };
    this.db.prepare('INSERT INTO events(session_id,seq,event_id,run_id,type,data) VALUES(?,?,?,?,?,?)').run(event.sessionId, event.seq, event.eventId, event.runId, type, encode(event));
    return event;
  }
  private assertScope(run: Run, record: { runId: string; sessionId?: string }): void {
    if (record.runId !== run.id || (record.sessionId !== undefined && record.sessionId !== run.sessionId)) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Record belongs to a different run or session');
  }
  private writeMessage(run: Run, message: Message): void {
    this.assertScope(run, message);
    const previous = this.row('SELECT data FROM messages WHERE id=?', message.id);
    if (previous) {
      const old = decode<Message>(previous);
      requireMatch([old.runId, old.sessionId, old.role, old.createdAt], [message.runId, message.sessionId, message.role, message.createdAt], 'Message identity cannot change');
    }
    this.db.prepare('INSERT INTO messages(id,session_id,run_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(message.id, message.sessionId, message.runId, encode(message));
  }
  private writeTool(run: Run, tool: ToolCallRecord): void {
    this.assertScope(run, tool);
    const previous = this.row('SELECT data FROM tools WHERE id=?', tool.id);
    if (previous) {
      const old = decode<ToolCallRecord>(previous);
      requireMatch([old.runId, old.sessionId, old.name, old.input], [tool.runId, tool.sessionId, tool.name, tool.input], 'Tool identity and input cannot change');
      if (['completed', 'failed', 'denied', 'interrupted'].includes(old.state)) requireMatch(old, tool, 'Finished tool record cannot change');
    }
    this.db.prepare('INSERT INTO tools(id,session_id,run_id,state,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data').run(tool.id, tool.sessionId, tool.runId, tool.state, encode(tool));
  }
  private writeApproval(run: Run, approval: ApprovalRecord): void {
    this.assertScope(run, approval);
    const toolRow = this.row('SELECT data FROM tools WHERE id=?', approval.toolCallId);
    if (!toolRow) throw new EngineError('TOOL_NOT_FOUND', `Tool ${approval.toolCallId} was not found`);
    const tool = decode<ToolCallRecord>(toolRow);
    this.assertScope(run, tool);
    if (tool.name !== approval.toolName) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Approval tool name does not match its tool');
    const previous = this.row('SELECT data FROM approvals WHERE id=?', approval.id);
    if (previous) {
      const old = decode<ApprovalRecord>(previous);
      requireMatch([old.runId, old.sessionId, old.toolCallId, old.toolName, old.fingerprint, old.preview, old.createdAt], [approval.runId, approval.sessionId, approval.toolCallId, approval.toolName, approval.fingerprint, approval.preview, approval.createdAt], 'Approval identity and request cannot change');
      if (old.status !== 'pending') requireMatch(old, approval, 'Resolved approval cannot change');
    }
    this.db.prepare('INSERT INTO approvals(id,session_id,run_id,tool_call_id,status,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(approval.id, approval.sessionId, approval.runId, approval.toolCallId, approval.status, encode(approval));
  }
  private writeCheckpoint(run: Run, checkpoint: Checkpoint): void {
    this.assertScope(run, checkpoint);
    const toolRow = this.row('SELECT data FROM tools WHERE id=?', checkpoint.toolCallId);
    if (!toolRow) throw new EngineError('TOOL_NOT_FOUND', `Tool ${checkpoint.toolCallId} was not found`);
    this.assertScope(run, decode<ToolCallRecord>(toolRow));
    const previous = this.row('SELECT data FROM checkpoints WHERE id=?', checkpoint.id);
    if (previous) { requireMatch(decode(previous), checkpoint, 'Checkpoint is immutable'); return; }
    this.db.prepare('INSERT INTO checkpoints(id,run_id,tool_call_id,data) VALUES(?,?,?,?)').run(checkpoint.id, checkpoint.runId, checkpoint.toolCallId, encode(checkpoint));
  }
  private apply(run: Run, change: CommitChange): Run {
    if (change.run) {
      run = { ...run, ...change.run, updatedAt: new Date().toISOString() };
      this.db.prepare('UPDATE runs SET state=?,data=? WHERE id=?').run(run.state, encode(run), run.id);
    }
    if (change.message) this.writeMessage(run, change.message);
    if (change.tool) this.writeTool(run, change.tool);
    if (change.approval) this.writeApproval(run, change.approval);
    if (change.checkpoint) this.writeCheckpoint(run, change.checkpoint);
    return run;
  }
  private expirePendingApprovals(run: Run, reason: 'run_terminal' | 'recovery'): void {
    const pending = this.rows<ApprovalRecord>("SELECT data FROM approvals WHERE run_id=? AND session_id=? AND status='pending' ORDER BY ordinal", run.id, run.sessionId);
    const resolvedAt = new Date().toISOString();
    for (const approval of pending) {
      const expired: ApprovalRecord = { ...approval, status: 'expired', resolvedAt };
      this.writeApproval(run, expired);
      this.append(run, 'approval.expired', {
        approvalId: approval.id, toolCallId: approval.toolCallId, toolName: approval.toolName,
        status: 'expired', reason, approval: JSON.parse(encode(expired)),
      });
    }
  }
  commit(runId: string, type: string, payload: JsonObject, change: CommitChange = {}): EngineEvent {
    const event = this.transaction(() => {
      let run = this.getRun(runId);
      if (isTerminal(run.state)) throw new EngineError('RUN_TERMINAL', 'Run is already terminal', { runId, state: run.state });
      const target = change.run?.state;
      if (target !== undefined && target !== run.state && !TRANSITIONS[run.state].includes(target)) throw new EngineError('INVALID_RUN_TRANSITION', `Cannot change run state from ${run.state} to ${target}`);
      if (target !== undefined && isTerminal(target) && type !== `run.${target}`) throw new EngineError('INVALID_TERMINAL_EVENT', 'Terminal state must be recorded with its terminal event');
      if (['run.completed', 'run.cancelled', 'run.failed', 'run.interrupted'].includes(type) && target !== type.slice(4)) throw new EngineError('INVALID_TERMINAL_EVENT', 'Terminal event must change the run to its matching state');
      run = this.apply(run, change);
      // Run termination and approval expiry are one durable state change. Publish
      // the Run terminal event last, so its cursor includes all approval outcomes.
      if (target !== undefined && isTerminal(target)) this.expirePendingApprovals(run, 'run_terminal');
      return this.append(run, type, payload);
    });
    this.notify(event.sessionId);
    return event;
  }

  getSnapshot(sessionId: string): SessionSnapshot {
    return this.transaction(() => {
      const session = this.getSession(sessionId);
      const lastSeq = Number(this.db.prepare('SELECT last_seq FROM sessions WHERE id=?').get(sessionId)?.last_seq);
      return {
        session,
        runs: this.rows<Run>('SELECT data FROM runs WHERE session_id=? ORDER BY ordinal', sessionId),
        messages: this.rows<Message>('SELECT data FROM messages WHERE session_id=? ORDER BY ordinal', sessionId),
        tools: this.rows<ToolCallRecord>('SELECT data FROM tools WHERE session_id=? ORDER BY ordinal', sessionId),
        approvals: this.rows<ApprovalRecord>('SELECT data FROM approvals WHERE session_id=? ORDER BY ordinal', sessionId),
        lastSeq,
      };
    }, false);
  }
  readEvents(sessionId: string, afterSeq: number, limit = PAGE_SIZE): EngineEvent[] {
    cursor(afterSeq);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new EngineError('INVALID_PAGE_SIZE', `Event page size must be between 1 and ${MAX_PAGE_SIZE}`);
    this.getSession(sessionId);
    return this.rows('SELECT data FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?', sessionId, afterSeq, limit);
  }
  async *subscribe(sessionId: string, afterSeq: number, signal?: AbortSignal): AsyncIterable<EngineEvent> {
    cursor(afterSeq);
    this.getSession(sessionId);
    let position = afterSeq;
    while (!this.closed && !signal?.aborted) {
      // Register before reading: a commit between a read and a wait cannot be missed.
      let release!: () => void;
      const changed = new Promise<void>(resolvePromise => { release = resolvePromise; });
      const waiter: Waiter = { sessionId, wake: release };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', release, { once: true });
      try {
        const page = this.readEvents(sessionId, position);
        if (page.length > 0) {
          for (const event of page) {
            if (this.closed || signal?.aborted) return;
            position = event.seq;
            yield event;
          }
        } else {
          await changed;
        }
      } finally {
        this.waiters.delete(waiter);
        signal?.removeEventListener('abort', release);
      }
    }
  }
  getApproval(id: string): ApprovalRecord {
    this.assertOpen();
    const row = this.row('SELECT data FROM approvals WHERE id=?', id);
    if (!row) throw new EngineError('APPROVAL_NOT_FOUND', `Approval ${id} was not found`);
    return decode(row);
  }
  listCheckpoints(runId: string): Checkpoint[] {
    this.getRun(runId);
    return this.rows('SELECT data FROM checkpoints WHERE run_id=? ORDER BY ordinal', runId);
  }

  recoverInterrupted(): Run[] {
    const sessions = new Set<string>();
    const recovered = this.transaction(() => {
      const active = this.rows<Run>(`SELECT data FROM runs WHERE state IN (${ACTIVE_STATES}) ORDER BY ordinal`);
      const affected = this.rows<Run>(`SELECT DISTINCT runs.data, runs.ordinal FROM runs LEFT JOIN tools ON tools.run_id=runs.id LEFT JOIN approvals ON approvals.run_id=runs.id WHERE runs.state IN (${ACTIVE_STATES}) OR tools.state IN ('requested','awaiting_approval','running') OR approvals.status='pending' ORDER BY runs.ordinal`);
      for (let run of affected) {
        const tools = this.rows<ToolCallRecord>("SELECT data FROM tools WHERE run_id=? AND state IN ('requested','awaiting_approval','running') ORDER BY ordinal", run.id);
        for (const tool of tools) {
          const interrupted: ToolCallRecord = { ...tool, state: 'interrupted', error: 'Engine process ended before the tool outcome was recorded' };
          this.writeTool(run, interrupted);
          this.append(run, 'tool.interrupted', { toolCallId: tool.id, tool: JSON.parse(encode(interrupted)) });
        }
        this.expirePendingApprovals(run, 'recovery');
        if (!isTerminal(run.state)) {
          const error = { code: 'ENGINE_INTERRUPTED', message: 'Engine process ended before this run finished' };
          run = this.apply(run, { run: { state: 'interrupted', error } });
          this.append(run, 'run.interrupted', { state: 'interrupted', error });
        }
        sessions.add(run.sessionId);
      }
      return active.map(run => this.getRun(run.id));
    });
    for (const sessionId of sessions) this.notify(sessionId);
    return recovered;
  }

  integrityCheck(): IntegrityCheckResult {
    return this.transaction(() => inspectIntegrity(this.db, DB_VERSION), false);
  }

  async backup(destination: string, options: StoreBackupOptions = {}): Promise<DatabaseBackup> {
    this.assertOpen();
    const checkCancelled = () => {
      this.assertOpen();
      if (options.signal?.aborted) throw new EngineError('BACKUP_ABORTED', 'SQLite backup was cancelled');
    };
    checkCancelled();
    this.pendingBackups++;
    let reader: DatabaseSync | undefined;
    try {
      if (this.databasePath !== ':memory:') {
        reader = new DatabaseSync(this.databasePath, { readOnly: true, timeout: 1_000 });
        reader.exec('BEGIN');
        // Fix a WAL read snapshot before the native job starts. The live writer uses
        // a different handle, so its transactions cannot produce SQLITE_LOCKED here.
        reader.prepare('SELECT last_seq FROM sessions LIMIT 1').get();
      }
      return await backupDatabase(reader ?? this.db, destination, DB_VERSION, checkCancelled, !reader);
    }
    finally {
      let readerFailure: EngineError | undefined;
      try { reader?.close(); }
      catch {
        readerFailure = new EngineError('STORE_CLOSE_FAILED', 'SQLite backup read connection could not be released');
        this.backupConnectionFailure ??= readerFailure;
      }
      this.pendingBackups--;
      if (this.closed && this.pendingBackups === 0) this.releaseConnections();
      if (readerFailure) throw readerFailure;
    }
  }

  private releaseConnections(): void {
    if (this.released) return;
    this.released = true;
    // Keep ownership until native backup, validation, publication and cleanup have settled.
    const failures: unknown[] = [];
    if (this.backupConnectionFailure) failures.push(this.backupConnectionFailure);
    try { this.db.close(); } catch (error) { failures.push(error); }
    try { this.ownership?.close(); } catch (error) { failures.push(error); }
    if (failures.length) {
      const error = new EngineError('STORE_CLOSE_FAILED', 'SQLite storage connections could not be fully released', { failedConnections: failures.length });
      this.rejectClose(error);
      throw error;
    }
    this.resolveClose();
  }

  async closeAsync(): Promise<void> {
    this.close();
    await this.closeCompletion;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of [...this.waiters]) waiter.wake();
    this.waiters.clear();
    // Never unlink a lock file: existing contenders might still hold its inode open.
    if (this.pendingBackups === 0) this.releaseConnections();
  }
}
