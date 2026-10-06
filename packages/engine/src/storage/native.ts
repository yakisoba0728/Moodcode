import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  EngineError, isTerminal, SESSION_SCHEMA_VERSION, type AcceptInput, type EngineBudgets,
  type InputCursor, type InputPage, type InputReceipt, type InputRecord, type JsonObject,
  type Run, type RunReceipt, type Session, type SessionControl, type SessionEventV2, type SubmitInput,
} from '@moodcode/contracts';
import { normalizeAcceptInput, normalizeEngineBudgets, validateInputRecord, validateSessionEvent } from '@moodcode/contracts/validation';
import { requestIdentity } from './native-schema.js';

export interface NativeStorageHooks {
  assertOpen(): void;
  transaction<T>(operation: () => T): T;
  session(id: string): Session;
  run(id: string): Run;
  /** These callbacks are called within the shared primary transaction. */
  admit(input: SubmitInput, inputId: string): RunReceipt;
  steer(input: InputRecord, run: Run): number;
  notify(sessionId: string): void;
}
export interface StoredInputPromotion { input: InputRecord; run: Run; receipt: RunReceipt }
export type ExistingInputReceipt = InputReceipt | { inputId: string; state: 'promoted'; runId: string; legacyReceipt: RunReceipt };
type EventRefs = Pick<SessionEventV2, 'runId' | 'inputId' | 'turnId' | 'attemptId'>;
const PAGE_BYTES = 8_388_608;

export function storedJson(value: unknown): JsonObject { return JSON.parse(JSON.stringify(value)) as JsonObject; }
export function sameRecord(left: unknown, right: unknown, message: string): void {
  if (requestIdentity(left as AcceptInput) !== requestIdentity(right as AcceptInput)) throw new EngineError('RECORD_CONFLICT', message);
}
function nonnegative(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new EngineError('INVALID_CURSOR', 'Cursor must be a nonnegative safe integer');
}
function pageSize(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new EngineError('INVALID_PAGE_SIZE', 'Page size must be between 1 and 100');
}

/** Shares the owner's connection and transactions; never manufactures a Run for pending work. */
export class NativeSessionStorage {
  readonly budgets: EngineBudgets;
  constructor(readonly database: DatabaseSync, readonly hooks: NativeStorageHooks, budgets?: EngineBudgets) {
    this.budgets = Object.freeze(normalizeEngineBudgets(budgets));
  }
  write<T>(sessionId: string, operation: () => T): T {
    // A store-owned outer transaction publishes its combined journal only after commit.
    if (this.database.isTransaction) return operation();
    const result = this.hooks.transaction(operation);
    this.hooks.notify(sessionId);
    return result;
  }
  scopeRun(sessionId: string, runId: string): Run {
    const run = this.hooks.run(runId);
    if (run.sessionId !== sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Run does not belong to the session');
    return run;
  }
  private nextSeq(sessionId: string): number {
    const row = this.database.prepare('SELECT last_seq FROM session_sequences WHERE session_id=?').get(sessionId);
    const value = row ? Number(row.last_seq) : 0;
    if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) throw new EngineError('SEQUENCE_EXHAUSTED', 'Session v2 sequence exceeded the safe integer range');
    return value + 1;
  }
  appendEvent(sessionId: string, type: string, payload: JsonObject, refs: EventRefs = {}): SessionEventV2 {
    if (!this.database.isTransaction) throw new EngineError('STORAGE_TRANSACTION_REQUIRED', 'Session event publication requires an active primary transaction');
    this.hooks.session(sessionId);
    if (refs.runId) this.scopeRun(sessionId, refs.runId);
    if (refs.inputId) {
      const input = this.getInput(refs.inputId);
      if (input.sessionId !== sessionId || (refs.runId && input.runId !== refs.runId)) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Event input does not match its session or Run');
    }
    if (refs.turnId) {
      const row = this.database.prepare('SELECT session_id,run_id FROM session_turns WHERE id=?').get(refs.turnId);
      if (!row || row.session_id !== sessionId || row.run_id !== refs.runId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Event Turn does not match its session or Run');
    }
    if (refs.attemptId) {
      const row = this.database.prepare('SELECT turn_id FROM provider_attempts WHERE id=?').get(refs.attemptId);
      if (!row || row.turn_id !== refs.turnId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Event attempt does not match its Turn');
    }
    const seq = this.nextSeq(sessionId);
    const event = validateSessionEvent({ schemaVersion: SESSION_SCHEMA_VERSION, stream: 'session-v2', eventId: randomUUID(), sessionId, seq,
      timestamp: new Date().toISOString(), type, payload, ...refs });
    this.database.prepare('INSERT INTO session_sequences(session_id,last_seq) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET last_seq=excluded.last_seq').run(sessionId, seq);
    this.database.prepare('INSERT INTO session_events(session_id,seq,event_id,schema_version,run_id,input_id,turn_id,attempt_id,type,data) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(sessionId, seq, event.eventId, SESSION_SCHEMA_VERSION, refs.runId ?? null, refs.inputId ?? null, refs.turnId ?? null, refs.attemptId ?? null, type, JSON.stringify(event));
    return event;
  }
  getInput(id: string): InputRecord {
    this.hooks.assertOpen();
    const row = this.database.prepare('SELECT data FROM session_inputs WHERE id=?').get(id);
    if (!row) throw new EngineError('INPUT_NOT_FOUND', 'Session input was not found');
    return validateInputRecord(JSON.parse(String(row.data)));
  }
  private inputReceipt(input: InputRecord, duplicate: boolean): InputReceipt {
    return { inputId: input.id, admittedSeq: input.admittedSeq, state: input.state, duplicate, ...(input.runId ? { runId: input.runId } : {}) };
  }
  /** Identity lookup only: never backfills a legacy request or allocates an event seq. */
  lookupInputReceipt(value: AcceptInput): ExistingInputReceipt | undefined {
    const accepted=normalizeAcceptInput(value);
    this.hooks.session(accepted.sessionId);
    const fingerprint=requestIdentity(accepted);
    const row=this.database.prepare('SELECT id,fingerprint FROM session_inputs WHERE session_id=? AND request_id=?').get(accepted.sessionId,accepted.requestId);
    if(row) {
      if(row.fingerprint!==fingerprint) throw new EngineError('REQUEST_ID_CONFLICT','Request ID belongs to different input, configuration, attachments or delivery');
      const input=this.getInput(String(row.id));
      if(input.sessionId!==accepted.sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH','Input belongs to a different session');
      return this.inputReceipt(input,true);
    }
    const legacy=this.database.prepare('SELECT inputs.id,inputs.data,inputs.admitted_seq,runs.id AS run_id FROM inputs JOIN runs ON runs.input_id=inputs.id WHERE inputs.session_id=? AND inputs.request_id=?').get(accepted.sessionId,accepted.requestId);
    if(!legacy) return undefined;
    const input=JSON.parse(String(legacy.data)) as SubmitInput;
    if(requestIdentity({...input,delivery:'queue'})!==fingerprint) throw new EngineError('REQUEST_ID_CONFLICT','Request ID belongs to different legacy input');
    const run=this.scopeRun(accepted.sessionId,String(legacy.run_id));
    if(run.inputId!==legacy.id) throw new EngineError('RECORD_SCOPE_MISMATCH','Legacy receipt has inconsistent input identity');
    const legacyReceipt:RunReceipt={inputId:String(legacy.id),runId:run.id,admittedSeq:Number(legacy.admitted_seq),duplicate:true};
    return {inputId:legacyReceipt.inputId,state:'promoted',runId:run.id,legacyReceipt};
  }
  lookupRunReceipt(input: SubmitInput): RunReceipt | undefined {
    this.hooks.session(input.sessionId);
    const native=this.legacyReceipt(input);
    if(native) return native;
    const row=this.database.prepare('SELECT inputs.id,inputs.data,inputs.admitted_seq,runs.id AS run_id FROM inputs JOIN runs ON runs.input_id=inputs.id WHERE inputs.session_id=? AND inputs.request_id=?').get(input.sessionId,input.requestId);
    if(!row) return undefined;
    if(requestIdentity({...JSON.parse(String(row.data)),delivery:'queue'})!==requestIdentity({...input,delivery:'queue'})) throw new EngineError('REQUEST_ID_CONFLICT','Request ID belongs to different legacy input');
    const run=this.scopeRun(input.sessionId,String(row.run_id));
    if(run.inputId!==row.id) throw new EngineError('RECORD_SCOPE_MISMATCH','Legacy receipt has inconsistent input identity');
    return {inputId:String(row.id),runId:run.id,admittedSeq:Number(row.admitted_seq),duplicate:true};
  }
  acceptInput(value: AcceptInput): InputReceipt {
    const accepted = normalizeAcceptInput(value);
    return this.write(accepted.sessionId, () => {
      const session = this.hooks.session(accepted.sessionId);
      const fingerprint = requestIdentity(accepted);
      const existing = this.database.prepare('SELECT id,fingerprint FROM session_inputs WHERE session_id=? AND request_id=?').get(accepted.sessionId, accepted.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new EngineError('REQUEST_ID_CONFLICT', 'Request ID was already used for different input, configuration or delivery');
        return this.inputReceipt(this.getInput(String(existing.id)), true);
      }
      // A v1 admission after migration is still an existing durable request.
      const legacy = this.database.prepare('SELECT inputs.id,inputs.data,runs.id AS run_id FROM inputs JOIN runs ON runs.input_id=inputs.id WHERE inputs.session_id=? AND inputs.request_id=?').get(accepted.sessionId, accepted.requestId);
      if (legacy) {
        const input = JSON.parse(String(legacy.data)) as SubmitInput;
        if (requestIdentity({ ...input, delivery: 'queue' }) !== fingerprint) throw new EngineError('REQUEST_ID_CONFLICT', 'Request ID already belongs to legacy Run input');
        return this.inputReceipt(this.bindLegacy(input, this.hooks.run(String(legacy.run_id)), String(legacy.id)), true);
      }
      const requested = (accepted.config as typeof accepted.config & { budgets?: EngineBudgets }).budgets;
      const limits = requested === undefined ? this.budgets : normalizeEngineBudgets(requested);
      const maxInputs = Math.min(this.budgets.maxPendingInputs, limits.maxPendingInputs);
      const maxBytes = Math.min(this.budgets.maxPendingBytes, limits.maxPendingBytes);
      const backlog = this.database.prepare("SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM session_inputs WHERE session_id=? AND state='pending'").get(session.id)!;
      const bytes = Buffer.byteLength(JSON.stringify(accepted));
      if (Number(backlog.count) >= maxInputs || Number(backlog.bytes) + bytes > maxBytes) {
        throw new EngineError('INPUT_BACKLOG_LIMIT', 'Session pending input count or byte budget is full', { maxPendingInputs: maxInputs, maxPendingBytes: maxBytes });
      }
      const now = new Date().toISOString();
      const input: InputRecord = { ...accepted, schemaVersion: SESSION_SCHEMA_VERSION, id: randomUUID(), workspaceId: session.workspaceId,
        state: 'pending', admittedSeq: this.nextSeq(session.id), createdAt: now, updatedAt: now };
      this.database.prepare('INSERT INTO session_inputs(id,session_id,workspace_id,request_id,fingerprint,delivery,state,admitted_seq,bytes,data) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(input.id, input.sessionId, input.workspaceId, input.requestId, fingerprint, input.delivery, input.state, input.admittedSeq, bytes, JSON.stringify(input));
      this.appendEvent(session.id, 'input.accepted', { input: storedJson(input) }, { inputId: input.id });
      return this.inputReceipt(input, false);
    });
  }
  /** Called within legacy admission's transaction, without changing its v1 receipt or journal. */
  bindLegacy(value: SubmitInput, run: Run, inputId = run.inputId): InputRecord {
    const existing = this.database.prepare('SELECT id FROM session_inputs WHERE session_id=? AND request_id=?').get(value.sessionId, value.requestId);
    if (existing) return this.getInput(String(existing.id));
    const accepted: AcceptInput = { ...value, delivery: 'queue' };
    const admittedSeq = this.nextSeq(value.sessionId), promotedSeq = admittedSeq + 1;
    if (!Number.isSafeInteger(promotedSeq)) throw new EngineError('SEQUENCE_EXHAUSTED', 'Session v2 sequence exceeded the safe integer range');
    const legacy = this.database.prepare('SELECT admitted_seq FROM inputs WHERE id=?').get(inputId);
    if (!legacy) throw new EngineError('INPUT_NOT_FOUND', 'Legacy input was not found');
    const input: InputRecord = { ...accepted, schemaVersion: SESSION_SCHEMA_VERSION, id: inputId, workspaceId: run.workspaceId, state: 'promoted',
      admittedSeq, promotedSeq, runId: run.id, createdAt: run.createdAt, updatedAt: run.createdAt };
    this.database.prepare('INSERT INTO session_inputs(id,session_id,workspace_id,request_id,fingerprint,delivery,state,admitted_seq,promoted_seq,run_id,legacy_seq,bytes,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(input.id, input.sessionId, input.workspaceId, input.requestId, requestIdentity(accepted), input.delivery, input.state, admittedSeq, promotedSeq, run.id, Number(legacy.admitted_seq), Buffer.byteLength(JSON.stringify(accepted)), JSON.stringify(input));
    this.appendEvent(input.sessionId, 'input.legacy_bound', { requestId: input.requestId, legacy: true }, { inputId: input.id, runId: run.id });
    this.appendEvent(input.sessionId, 'input.promoted', { requestId: input.requestId, legacy: true }, { inputId: input.id, runId: run.id });
    return input;
  }
  /** Preserve v1 API identity while making pending/steer cross-command collisions explicit. */
  legacyReceipt(input: SubmitInput): RunReceipt | undefined {
    const row = this.database.prepare('SELECT id,fingerprint,delivery,state,run_id,legacy_seq FROM session_inputs WHERE session_id=? AND request_id=?').get(input.sessionId, input.requestId);
    if (!row) return undefined;
    if (row.delivery !== 'queue' || row.fingerprint !== requestIdentity({ ...input, delivery: 'queue' })) throw new EngineError('REQUEST_ID_CONFLICT', 'Request ID belongs to different session input');
    if (row.state !== 'promoted') throw new EngineError('INPUT_NOT_PROMOTED', 'A pending or cancelled session input has no legacy Run receipt');
    return { inputId: String(row.id), runId: String(row.run_id), admittedSeq: Number(row.legacy_seq), duplicate: true };
  }
  listInputs(sessionId: string, position?: InputCursor, limit = 50): InputPage {
    pageSize(limit);
    this.hooks.session(sessionId);
    if (position && position.sessionId !== sessionId) throw new EngineError('INVALID_INPUT_CURSOR', 'Input cursor belongs to a different session');
    nonnegative(position?.afterSeq ?? 0);
    return this.hooks.transaction(() => {
      const rows = this.database.prepare('SELECT id,length(CAST(data AS BLOB)) AS bytes FROM session_inputs WHERE session_id=? AND admitted_seq>? ORDER BY admitted_seq LIMIT ?').all(sessionId, position?.afterSeq ?? 0, limit + 1);
      const ids: string[] = []; let bytes = 0;
      for (const row of rows.slice(0, limit)) {
        const length = Number(row.bytes);
        if (bytes + length > PAGE_BYTES && ids.length) break;
        if (length > PAGE_BYTES) throw new EngineError('INPUT_PAGE_TOO_LARGE', 'One input exceeds the bounded page budget');
        ids.push(String(row.id)); bytes += length;
      }
      const inputs = ids.length ? this.database.prepare(`SELECT data FROM session_inputs WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY admitted_seq`).all(...ids).map(row => validateInputRecord(JSON.parse(String(row.data)))) : [];
      const last = inputs.at(-1);
      return { inputs, nextCursor: rows.length > inputs.length && last ? { sessionId, afterSeq: last.admittedSeq } : null };
    });
  }
  pendingInputs(sessionId: string, delivery?: AcceptInput['delivery'], limit = 100): InputRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024) throw new EngineError('INVALID_PAGE_SIZE', 'Pending batch size must be between 1 and 1024');
    this.hooks.session(sessionId);
    const rows = delivery === undefined
      ? this.database.prepare("SELECT id,length(CAST(data AS BLOB)) AS bytes FROM session_inputs WHERE session_id=? AND state='pending' ORDER BY admitted_seq LIMIT ?").all(sessionId, limit)
      : this.database.prepare("SELECT id,length(CAST(data AS BLOB)) AS bytes FROM session_inputs WHERE session_id=? AND state='pending' AND delivery=? ORDER BY admitted_seq LIMIT ?").all(sessionId, delivery, limit);
    let bytes = 0; const ids: string[] = [];
    for (const row of rows) {
      if (bytes + Number(row.bytes) > PAGE_BYTES) break;
      ids.push(String(row.id)); bytes += Number(row.bytes);
    }
    if (!ids.length) return [];
    return this.database.prepare(`SELECT data FROM session_inputs WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY admitted_seq`).all(...ids).map(row => validateInputRecord(JSON.parse(String(row.data))));
  }
  listRunInputIds(runId: string): string[] {
    this.hooks.run(runId);
    const rows = this.database.prepare('SELECT id FROM session_inputs WHERE run_id=? ORDER BY admitted_seq LIMIT 1025').all(runId);
    if (rows.length > 1024) throw new EngineError('RUN_INPUT_LIMIT', 'Run input provenance exceeds the bounded read budget');
    return rows.map(row => String(row.id));
  }
  listRunInputs(runId: string): InputRecord[] {
    this.hooks.run(runId);
    const sizes = this.database.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM session_inputs WHERE run_id=?').get(runId)!;
    if (Number(sizes.count) > 1024 || Number(sizes.bytes) > PAGE_BYTES) throw new EngineError('RUN_INPUT_LIMIT', 'Run input records exceed the bounded read budget');
    return this.database.prepare('SELECT data FROM session_inputs WHERE run_id=? ORDER BY admitted_seq LIMIT 1024').all(runId).map(row => validateInputRecord(JSON.parse(String(row.data))));
  }
  cancelInput(inputId: string): InputRecord {
    const input = this.getInput(inputId);
    return this.write(input.sessionId, () => {
      const current = this.getInput(inputId);
      if (current.state === 'cancelled') return current;
      if (current.state !== 'pending') throw new EngineError('INPUT_ALREADY_PROMOTED', 'Promoted input must be cancelled through its Run');
      const next = validateInputRecord({ ...current, state: 'cancelled', updatedAt: new Date().toISOString(), terminalReason: 'user_cancelled' });
      this.database.prepare("UPDATE session_inputs SET state='cancelled',data=? WHERE id=? AND state='pending'").run(JSON.stringify(next), inputId);
      this.appendEvent(input.sessionId, 'input.cancelled', { input: storedJson(next) }, { inputId });
      return next;
    });
  }
  getSessionControl(sessionId: string): SessionControl {
    const session = this.hooks.session(sessionId);
    const row = this.database.prepare('SELECT data FROM session_controls WHERE session_id=?').get(sessionId);
    return row ? JSON.parse(String(row.data)) as SessionControl : { sessionId, paused: false, revision: 0, updatedAt: session.createdAt };
  }
  setControlInTransaction(sessionId: string, paused: boolean, reason?: SessionControl['reason']): SessionControl {
    const previous = this.getSessionControl(sessionId);
    if (previous.paused === paused && previous.reason === (paused ? reason : undefined)) return previous;
    if (!Number.isSafeInteger(previous.revision) || previous.revision >= Number.MAX_SAFE_INTEGER) throw new EngineError('SEQUENCE_EXHAUSTED', 'Session control revision exceeded the safe integer range');
    const control: SessionControl = { sessionId, paused, revision: previous.revision + 1, updatedAt: new Date().toISOString(), ...(paused && reason ? { reason } : {}) };
    this.database.prepare('INSERT INTO session_controls(session_id,paused,revision,data) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET paused=excluded.paused,revision=excluded.revision,data=excluded.data')
      .run(sessionId, paused ? 1 : 0, control.revision, JSON.stringify(control));
    this.appendEvent(sessionId, paused ? 'session.paused' : 'session.resumed', { control: storedJson(control) });
    return control;
  }
  setSessionPaused(sessionId: string, paused: boolean, reason?: SessionControl['reason']): SessionControl {
    if (typeof paused !== 'boolean' || (reason !== undefined && !['user', 'run_cancelled', 'recovery_required'].includes(reason))) throw new EngineError('INVALID_SESSION_CONTROL', 'Session pause requires a boolean and supported reason');
    return this.write(sessionId, () => this.setControlInTransaction(sessionId, paused, paused ? reason ?? 'user' : undefined));
  }
  private promoteOne(inputId: string, runId?: string): StoredInputPromotion {
    const input = this.getInput(inputId);
    if (input.state === 'promoted') {
      if (runId && input.runId !== runId) throw new EngineError('INPUT_RUN_CONFLICT', 'Input already belongs to another Run');
      const row = this.database.prepare('SELECT legacy_seq FROM session_inputs WHERE id=?').get(inputId)!;
      return { input, run: this.hooks.run(input.runId!), receipt: { inputId, runId: input.runId!, admittedSeq: Number(row.legacy_seq), duplicate: true } };
    }
    if (input.state !== 'pending') throw new EngineError('INPUT_CANCELLED', 'Cancelled input cannot be promoted');
    if (this.getSessionControl(input.sessionId).paused) throw new EngineError('SESSION_PAUSED', 'Session input promotion is paused');
    let run: Run, receipt: RunReceipt;
    if (runId) {
      run = this.scopeRun(input.sessionId, runId);
      if (input.delivery !== 'steer') throw new EngineError('INPUT_DELIVERY_CONFLICT', 'Queued input must start a new Run');
      if (isTerminal(run.state) || run.state === 'cancelling') throw new EngineError('RUN_TERMINAL', 'Steering requires an active Run');
      sameRecord(input.config, run.config, 'Steering cannot replace the active Run configuration');
      receipt = { inputId, runId, admittedSeq: this.hooks.steer(input, run), duplicate: false };
    } else {
      // New Runs respect admission order across queue and idle steer deliveries.
      const first = this.database.prepare("SELECT id FROM session_inputs WHERE session_id=? AND state='pending' ORDER BY admitted_seq LIMIT 1").get(input.sessionId);
      if (first?.id !== inputId) throw new EngineError('INPUT_ORDER_CONFLICT', 'Promote the oldest pending input first');
      receipt = this.hooks.admit({ sessionId: input.sessionId, requestId: input.requestId, prompt: input.prompt, config: input.config,
        ...(input.attachments === undefined ? {} : { attachments: structuredClone(input.attachments) }) }, input.id);
      run = this.hooks.run(receipt.runId);
    }
    const promoted = validateInputRecord({ ...input, state: 'promoted', runId: run.id, promotedSeq: this.nextSeq(input.sessionId), updatedAt: new Date().toISOString() });
    this.database.prepare("UPDATE session_inputs SET state='promoted',run_id=?,promoted_seq=?,legacy_seq=?,data=? WHERE id=? AND state='pending'")
      .run(run.id, promoted.promotedSeq!, receipt.admittedSeq, JSON.stringify(promoted), inputId);
    this.appendEvent(input.sessionId, 'input.promoted', { input: storedJson(promoted) }, { inputId, runId: run.id });
    return { input: promoted, run, receipt };
  }
  promoteInput(inputId: string, runId?: string): StoredInputPromotion {
    const input = this.getInput(inputId);
    return this.write(input.sessionId, () => this.promoteOne(inputId, runId));
  }
  promoteSteers(inputIds: string[], runId: string): InputRecord[] {
    const run = this.hooks.run(runId);
    if (!inputIds.length || inputIds.length > this.budgets.maxSteerBatch || new Set(inputIds).size !== inputIds.length) throw new EngineError('INPUT_BATCH_LIMIT', 'Steering batch must have distinct bounded input IDs');
    return this.write(run.sessionId, () => {
      const requested = inputIds.map(id => this.getInput(id));
      if (requested.some(input => input.sessionId !== run.sessionId || input.delivery !== 'steer')) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Steering batch belongs to a different session or delivery');
      const pending = requested.filter(input => input.state === 'pending');
      const first = this.database.prepare("SELECT id FROM session_inputs WHERE session_id=? AND state='pending' AND delivery='steer' ORDER BY admitted_seq LIMIT ?").all(run.sessionId, pending.length);
      if (pending.some((input, index) => first[index]?.id !== input.id)) throw new EngineError('INPUT_ORDER_CONFLICT', 'Steering batch must preserve pending steering admission order');
      return requested.map(input => this.promoteOne(input.id, runId).input);
    });
  }
  readSessionEvents(sessionId: string, afterSeq: number, limit = 100): SessionEventV2[] {
    nonnegative(afterSeq); pageSize(limit); this.hooks.session(sessionId);
    return this.hooks.transaction(() => {
      const rows = this.database.prepare('SELECT seq,length(CAST(data AS BLOB)) AS bytes FROM session_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?').all(sessionId, afterSeq, limit);
      const seqs: number[] = []; let bytes = 0;
      for (const row of rows) {
        const length = Number(row.bytes);
        if (bytes + length > PAGE_BYTES && seqs.length) break;
        if (length > PAGE_BYTES) throw new EngineError('EVENT_PAGE_TOO_LARGE', 'One event exceeds the bounded page budget');
        seqs.push(Number(row.seq)); bytes += length;
      }
      return seqs.length ? this.database.prepare('SELECT data FROM session_events WHERE session_id=? AND seq>? AND seq<=? ORDER BY seq').all(sessionId, afterSeq, seqs.at(-1)!).map(row => validateSessionEvent(JSON.parse(String(row.data)))) : [];
    });
  }
}
