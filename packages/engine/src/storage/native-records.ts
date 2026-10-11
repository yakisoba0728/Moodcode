import { assertMediaIndexCapacity, assertProviderMediaPartCapacity } from '../media/storage-capacity.js';
import type { DatabaseSync } from 'node:sqlite';
import {
  EngineError, isTerminal, type ContextRevision, type JsonObject, type MessagePart,
  type ProviderAttempt, type TurnRecord,
} from '@moodcode/contracts';
import { validateContextRevision, validateMessagePart, validateProviderAttempt, validateSessionEvent, validateTurnRecord } from '@moodcode/contracts/validation';
import { sha256Hex } from '../shared/canonical.js';
import { NativeSessionStorage, sameRecord, storedJson } from './native.js';
import { hasEvidenceRead, invalidateEvidenceRead, readBoundedBody, readBoundedHeader, readEvidenceBody } from './evidence-read.js';
import type { ToolRecoveryFrontiers } from './tool-recovery-frontier.js';

const FINAL = new Set(['completed', 'failed', 'interrupted', 'uncertain']);
const TURN_TRANSITIONS: Record<TurnRecord['state'], readonly TurnRecord['state'][]> = {
  created: ['streaming', 'failed', 'interrupted', 'uncertain'],
  streaming: ['awaiting_tools', 'completed', 'failed', 'interrupted', 'uncertain'],
  awaiting_tools: ['completed', 'failed', 'interrupted', 'uncertain'], completed: [], failed: [], interrupted: [], uncertain: [],
};
const ATTEMPT_TRANSITIONS: Record<ProviderAttempt['state'], readonly ProviderAttempt['state'][]> = {
  prepared: ['dispatched', 'failed', 'interrupted'], dispatched: ['streaming', 'completed', 'failed', 'interrupted', 'uncertain'],
  streaming: ['completed', 'failed', 'interrupted', 'uncertain'], completed: [], failed: [], interrupted: [], uncertain: [],
};
const PARTS_LIMIT = 4_096;
const RECORDS_BYTES = 16_777_216;
const DOCUMENT_ANCHOR_BYTES = 8_192;
const EVENT_REFS = [['runId', 'run_id'], ['inputId', 'input_id'], ['turnId', 'turn_id'], ['attemptId', 'attempt_id']] as const;
const PAYLOAD_PATH = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/u;
export interface SessionDocument { revision: number; data: JsonObject }
export interface TurnPage { turns: TurnRecord[]; nextCursor: string | null }
export interface PartPage { parts: MessagePart[]; nextCursor: string | null }
export interface NativeReadErrors { limit: () => never; invalid: () => never }
export interface EventSearch {
  sessionId: string;
  type: string;
  /** null selects events without that reference. */
  refs?: { runId?: string | null; inputId?: string | null; turnId?: string | null; attemptId?: string | null };
  /** Raw substring of the event, such as a digest. */
  contains?: string;
  /** Payload values by dotted path. */
  payload?: Readonly<Record<string, string | number>>;
  maxRows: number;
  maxRowBytes: number;
  maxTotalBytes?: number;
}
export interface AnchoredDocument { revision: number; raw: string; data: unknown }

/** Durable execution records share the inbox's owner, transaction and versioned journal. */
export class NativeExecutionStorage {
  constructor(private readonly native: NativeSessionStorage, private readonly validateSummaryDependency?: (turn: TurnRecord) => void) {}
  private get database() { return this.native.database; }
  private requireActive(sessionId: string, runId: string): void {
    if (isTerminal(this.native.scopeRun(sessionId, runId).state)) throw new EngineError('RUN_TERMINAL', 'Execution records cannot change a terminal Run');
  }
  getTurn(id: string): TurnRecord {
    this.native.hooks.assertOpen();
    if (!hasEvidenceRead(this.database)) {
      const row = this.database.prepare('SELECT data FROM session_turns WHERE id=?').get(id);
      if (!row) throw new EngineError('TURN_NOT_FOUND', 'Turn was not found');
      return validateTurnRecord(JSON.parse(String(row.data)));
    }
    const row = this.database.prepare('SELECT id,session_id,run_id,turn_index,state,length(CAST(data AS BLOB)) AS bytes FROM session_turns WHERE id=?').get(id);
    if (!row) throw new EngineError('TURN_NOT_FOUND', 'Turn was not found');
    const raw = readEvidenceBody(this.database, { table: 'session_turns', key: id }, { expectedBytes: Number(row.bytes), maxBytes: 8388608 });
    const turn = validateTurnRecord(JSON.parse(String(raw)));
    if (turn.id !== row.id || turn.sessionId !== row.session_id || turn.runId !== row.run_id || turn.index !== row.turn_index || turn.state !== row.state) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Turn payload disagrees with its SQL owner');
    return turn;
  }
  listTurns(runId: string): TurnRecord[] {
    this.native.hooks.run(runId);
    const sizes = this.database.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM session_turns WHERE run_id=?').get(runId)!;
    if (Number(sizes.count) > 1024 || Number(sizes.bytes) > RECORDS_BYTES) throw new EngineError('TURN_PAGE_LIMIT', 'Run Turn list exceeds the bounded read budget');
    const rows = this.database.prepare('SELECT data FROM session_turns WHERE run_id=? ORDER BY turn_index LIMIT 1025').all(runId);
    if (rows.length > 1024 || rows.reduce((bytes, row) => bytes + Buffer.byteLength(String(row.data)), 0) > RECORDS_BYTES) throw new EngineError('TURN_PAGE_LIMIT', 'Run Turn list exceeds the bounded read budget');
    return rows.map(row => validateTurnRecord(JSON.parse(String(row.data))));
  }
  listTurnsPage(runId: string, afterTurnId?: string, limit = 50): TurnPage {
    return this.native.hooks.transaction(() => {
      this.native.hooks.run(runId);
      const page = this.recordPage('session_turns', 'run_id', runId, 'turn_index', afterTurnId, limit);
      return { turns: page.records.map(validateTurnRecord), nextCursor: page.nextCursor };
    });
  }
  private recordPage(table: 'session_turns' | 'message_parts', ownerColumn: 'run_id' | 'turn_id', ownerId: string,
    orderColumn: 'turn_index' | 'rowid', afterId: string | undefined, limit: number): { records: unknown[]; nextCursor: string | null } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new EngineError('INVALID_PAGE_SIZE', 'Execution page size must be between 1 and 100');
    let after = -1;
    if (afterId !== undefined) {
      const cursor = this.database.prepare(`SELECT ${orderColumn} AS position FROM ${table} WHERE id=? AND ${ownerColumn}=?`).get(afterId, ownerId);
      if (!cursor) throw new EngineError(table === 'session_turns' ? 'INVALID_TURN_CURSOR' : 'INVALID_PART_CURSOR', 'Execution cursor does not belong to this owner');
      after = Number(cursor.position);
    }
    const rows = this.database.prepare(`SELECT id,length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE ${ownerColumn}=? AND ${orderColumn}>? ORDER BY ${orderColumn} LIMIT ?`).all(ownerId, after, limit + 1);
    const ids: string[] = []; let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const length = Number(row.bytes);
      if (length > 8_388_608) throw new EngineError(table === 'session_turns' ? 'TURN_PAGE_LIMIT' : 'PART_PAGE_LIMIT', 'One execution record exceeds the bounded page budget');
      if (bytes + length > 8_388_608) break;
      ids.push(String(row.id)); bytes += length;
    }
    const records = ids.length ? this.database.prepare(`SELECT data FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY ${orderColumn}`).all(...ids).map(row => JSON.parse(String(row.data))) : [];
    return { records, nextCursor: rows.length > ids.length ? ids.at(-1)! : null };
  }
  putTurn(value: TurnRecord): TurnRecord {
    const turn = validateTurnRecord(value);
    return this.native.write(turn.sessionId, () => {
      this.native.scopeRun(turn.sessionId, turn.runId);
      const row = this.database.prepare('SELECT data FROM session_turns WHERE id=?').get(turn.id);
      const encoded = JSON.stringify(turn);
      if (row) {
        const previous = validateTurnRecord(JSON.parse(String(row.data)));
        if (JSON.stringify(previous) === encoded) return previous;
        this.requireActive(turn.sessionId, turn.runId);
        sameRecord([previous.id, previous.sessionId, previous.runId, previous.inputIds, previous.index, previous.createdAt],
          [turn.id, turn.sessionId, turn.runId, turn.inputIds, turn.index, turn.createdAt], 'Turn identity and input snapshot cannot change');
        if (FINAL.has(previous.state)) throw new EngineError('TURN_TERMINAL', 'Terminal Turn records are immutable');
        if (turn.state !== previous.state && !TURN_TRANSITIONS[previous.state].includes(turn.state)) throw new EngineError('INVALID_TURN_TRANSITION', 'Turn transition is invalid');
        if (previous.contextRevisionId && previous.contextRevisionId !== turn.contextRevisionId) throw new EngineError('RECORD_CONFLICT', 'Turn context revision cannot change after assignment');
      } else {
        this.requireActive(turn.sessionId, turn.runId);
        if (turn.state !== 'created') throw new EngineError('INVALID_TURN_TRANSITION', 'New Turns start in created state');
        const previous = this.database.prepare('SELECT turn_index,state FROM session_turns WHERE run_id=? ORDER BY turn_index DESC LIMIT 1').get(turn.runId);
        if (turn.index !== (previous ? Number(previous.turn_index) + 1 : 0)) throw new EngineError('TURN_ORDER_CONFLICT', 'Turn index must continue its Run order');
        if (previous && !FINAL.has(String(previous.state))) throw new EngineError('TURN_ACTIVE', 'The previous Turn has not settled');
      }
      for (const id of turn.inputIds) {
        const input = this.native.getInput(id);
        if (input.state !== 'promoted' || input.runId !== turn.runId || input.sessionId !== turn.sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Turn input does not belong to its Run');
      }
      if (turn.contextRevisionId) {
        const context = this.getContextRevision(turn.contextRevisionId);
        if (context.sessionId !== turn.sessionId || context.runId && context.runId !== turn.runId || context.turnId && context.turnId !== turn.id) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Turn context revision belongs to another owner');
      }
      if (turn.state === 'completed') {
        const attempt = this.database.prepare('SELECT state FROM provider_attempts WHERE turn_id=? ORDER BY attempt_index DESC LIMIT 1').get(turn.id);
        const openPart = this.database.prepare("SELECT id FROM message_parts WHERE turn_id=? AND state='open' LIMIT 1").get(turn.id);
        if (attempt?.state !== 'completed' || openPart) throw new EngineError('TURN_NOT_SETTLED', 'Turn completion requires a completed provider attempt and settled message parts');
      }
      if (turn.uncertainty?.summaryDependency) {
        if (!this.validateSummaryDependency) throw new EngineError('SUMMARY_OVERFLOW_BINDING_MISMATCH', 'Turn summary dependencies require durable cleanup validation');
        this.validateSummaryDependency(turn);
      }
      invalidateEvidenceRead(this.database);
      this.database.prepare('INSERT INTO session_turns(id,session_id,run_id,turn_index,state,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data')
        .run(turn.id, turn.sessionId, turn.runId, turn.index, turn.state, encoded);
      this.native.appendEvent(turn.sessionId, `turn.${turn.state}`, { turn: JSON.parse(encoded) as JsonObject }, { runId: turn.runId, turnId: turn.id });
      if (turn.state === 'uncertain') this.native.setControlInTransaction(turn.sessionId, true, 'recovery_required');
      return turn;
    });
  }
  getAttempt(id: string): ProviderAttempt {
    this.native.hooks.assertOpen();
    if (!hasEvidenceRead(this.database)) {
      const row = this.database.prepare('SELECT data FROM provider_attempts WHERE id=?').get(id);
      if (!row) throw new EngineError('ATTEMPT_NOT_FOUND', 'Provider attempt was not found');
      return validateProviderAttempt(JSON.parse(String(row.data)));
    }
    const row = this.database.prepare('SELECT id,session_id,run_id,turn_id,attempt_index,state,length(CAST(data AS BLOB)) AS bytes FROM provider_attempts WHERE id=?').get(id);
    if (!row) throw new EngineError('ATTEMPT_NOT_FOUND', 'Provider attempt was not found');
    const raw = readEvidenceBody(this.database, { table: 'provider_attempts', key: id }, { expectedBytes: Number(row.bytes), maxBytes: 8388608 });
    const attempt = validateProviderAttempt(JSON.parse(String(raw)));
    if (attempt.id !== row.id || attempt.sessionId !== row.session_id || attempt.runId !== row.run_id || attempt.turnId !== row.turn_id || attempt.index !== row.attempt_index || attempt.state !== row.state) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Attempt payload disagrees with its SQL owner');
    return attempt;
  }
  getLatestAttemptForTurn(turnId: string): ProviderAttempt | null {
    const turn = this.getTurn(turnId);
    const row = this.database.prepare('SELECT id,session_id,run_id,turn_id,length(CAST(data AS BLOB)) AS bytes FROM provider_attempts WHERE turn_id=? ORDER BY attempt_index DESC LIMIT 1').get(turnId);
    if (!row) return null;
    if (row.session_id !== turn.sessionId || row.run_id !== turn.runId || row.turn_id !== turn.id) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Latest Attempt metadata does not belong to its native Turn');
    if (Number(row.bytes) > 8_388_608) throw new EngineError('EVIDENCE_READ_LIMIT', 'Latest Attempt exceeds its bounded evidence read');
    return this.getAttempt(String(row.id));
  }
  putAttempt(value: ProviderAttempt): ProviderAttempt {
    const attempt = validateProviderAttempt(value);
    return this.native.write(attempt.sessionId, () => {
      const turn = this.getTurn(attempt.turnId);
      if (turn.sessionId !== attempt.sessionId || turn.runId !== attempt.runId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Attempt does not belong to its Turn');
      if (attempt.contextRevisionId) {
        const context = this.getContextRevision(attempt.contextRevisionId);
        if (context.sessionId !== attempt.sessionId || context.runId && context.runId !== attempt.runId || context.turnId && context.turnId !== attempt.turnId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Attempt context revision belongs to another owner');
      }
      const row = this.database.prepare('SELECT data FROM provider_attempts WHERE id=?').get(attempt.id);
      const encoded = JSON.stringify(attempt);
      if (row) {
        const previous = validateProviderAttempt(JSON.parse(String(row.data)));
        if (JSON.stringify(previous) === encoded) return previous;
        this.requireActive(attempt.sessionId, attempt.runId);
        if (FINAL.has(turn.state)) throw new EngineError('TURN_TERMINAL', 'Provider attempt cannot change after Turn settlement');
        sameRecord([previous.id, previous.sessionId, previous.runId, previous.turnId, previous.index, previous.providerId, previous.modelId, previous.contextRevisionId, previous.createdAt],
          [attempt.id, attempt.sessionId, attempt.runId, attempt.turnId, attempt.index, attempt.providerId, attempt.modelId, attempt.contextRevisionId, attempt.createdAt], 'Attempt identity cannot change');
        if (FINAL.has(previous.state)) throw new EngineError('ATTEMPT_TERMINAL', 'Terminal attempt records are immutable');
        if (attempt.state !== previous.state && !ATTEMPT_TRANSITIONS[previous.state].includes(attempt.state)) throw new EngineError('INVALID_ATTEMPT_TRANSITION', 'Provider attempt transition is invalid');
        if (previous.dispatchedAt && previous.dispatchedAt !== attempt.dispatchedAt) throw new EngineError('RECORD_CONFLICT', 'Recorded provider dispatch timestamp cannot change');
        if (previous.providerRequestId && previous.providerRequestId !== attempt.providerRequestId) throw new EngineError('RECORD_CONFLICT', 'Provider request identity cannot change');
      } else {
        this.requireActive(attempt.sessionId, attempt.runId);
        if (FINAL.has(turn.state) || attempt.state !== 'prepared') throw new EngineError('INVALID_ATTEMPT_TRANSITION', 'New attempts require an active Turn and prepared state');
        const previous = this.database.prepare('SELECT attempt_index,state FROM provider_attempts WHERE turn_id=? ORDER BY attempt_index DESC LIMIT 1').get(attempt.turnId);
        if (attempt.index !== (previous ? Number(previous.attempt_index) + 1 : 0)) throw new EngineError('ATTEMPT_ORDER_CONFLICT', 'Attempt index must continue its Turn order');
        if (previous && previous.state !== 'failed') throw new EngineError('ATTEMPT_RETRY_UNSAFE', 'Only a failed attempt can be followed by another attempt');
        if (attempt.index >= this.native.budgets.maxProviderAttempts) throw new EngineError('ATTEMPT_LIMIT', 'Provider attempt allowance was exhausted');
      }
      invalidateEvidenceRead(this.database);
      this.database.prepare('INSERT INTO provider_attempts(id,session_id,run_id,turn_id,attempt_index,state,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data')
        .run(attempt.id, attempt.sessionId, attempt.runId, attempt.turnId, attempt.index, attempt.state, encoded);
      this.native.appendEvent(attempt.sessionId, `provider.attempt.${attempt.state}`, { attempt: JSON.parse(encoded) as JsonObject }, { runId: attempt.runId, turnId: attempt.turnId, attemptId: attempt.id });
      if (attempt.state === 'uncertain') this.native.setControlInTransaction(attempt.sessionId, true, 'recovery_required');
      return attempt;
    });
  }
  putPart(value: MessagePart): MessagePart {
    const part = validateMessagePart(value);
    return this.native.write(part.sessionId, () => {
      const turn = this.getTurn(part.turnId);
      if (turn.sessionId !== part.sessionId || turn.runId !== part.runId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Message part belongs to another Turn');
      const row = this.database.prepare('SELECT data FROM message_parts WHERE id=?').get(part.id);
      const previous = row ? validateMessagePart(JSON.parse(String(row.data))) : undefined;
      const encoded = JSON.stringify(part);
      if (previous && JSON.stringify(previous) === encoded) return previous;
      this.requireActive(part.sessionId, part.runId);
      if (FINAL.has(turn.state)) throw new EngineError('TURN_TERMINAL', 'Message parts cannot change after Turn settlement');
      if (previous) {
        sameRecord([previous.id, previous.sessionId, previous.runId, previous.turnId, previous.messageId, previous.index, previous.type, previous.createdAt],
          [part.id, part.sessionId, part.runId, part.turnId, part.messageId, part.index, part.type, part.createdAt], 'Message part identity cannot change');
        if (previous.state !== 'open') throw new EngineError('PART_TERMINAL', 'Terminal message parts are immutable');
        if (part.revision !== previous.revision + 1) throw new EngineError('REVISION_CONFLICT', 'Message part revision must advance exactly once');
        if ((previous.type === 'text' || previous.type === 'reasoning') && (part.type === 'text' || part.type === 'reasoning') && !part.text.startsWith(previous.text)) throw new EngineError('RECORD_CONFLICT', 'Streaming text cannot rewrite its durable prefix');
        if (previous.type === 'tool' && part.type === 'tool') sameRecord([previous.toolCallId, previous.providerCallId, previous.name, previous.input], [part.toolCallId, part.providerCallId, part.name, part.input], 'Tool part identity and arguments cannot change');
      } else {
        if (part.revision !== 0 || part.state !== 'open') throw new EngineError('REVISION_CONFLICT', 'New message parts start open at revision zero');
        const owner = this.database.prepare('SELECT session_id,run_id,turn_id,part_index FROM message_parts WHERE message_id=? ORDER BY part_index DESC LIMIT 1').get(part.messageId);
        if (owner && (owner.session_id !== part.sessionId || owner.run_id !== part.runId || owner.turn_id !== part.turnId)) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Message identity belongs to another owner');
        if (part.index !== (owner ? Number(owner.part_index) + 1 : 0)) throw new EngineError('PART_ORDER_CONFLICT', 'Part index must continue its message order');
      }
      if (previous?.type === 'media' && part.type === 'media' && ('source' in previous.artifact.identity || 'source' in part.artifact.identity)) sameRecord([previous.artifact, previous.mime, previous.name], [part.artifact, part.mime, part.name], 'Provider media artifact identity and description are immutable');
      if(part.type==='media'&&'source'in part.artifact.identity){
        const owner=part.artifact.identity,attempt=this.getAttempt(owner.attemptId),run=this.native.scopeRun(part.sessionId,part.runId);
        const header=this.database.prepare('SELECT session_id,run_id,turn_id,attempt_index,state FROM provider_attempts WHERE id=?').get(attempt.id);
        if(header?.session_id!==attempt.sessionId||header.run_id!==attempt.runId||header.turn_id!==attempt.turnId||header.attempt_index!==attempt.index||header.state!==attempt.state)throw new EngineError('MEDIA_OWNER_INVALID','Media provider Attempt SQL owner disagrees with its native body');
        const latest=this.database.prepare('SELECT id FROM provider_attempts WHERE turn_id=? ORDER BY attempt_index DESC LIMIT 1').get(part.turnId);
        if(owner.source!=='provider'||owner.sessionId!==part.sessionId||owner.runId!==part.runId||owner.turnId!==part.turnId||attempt.turnId!==part.turnId||attempt.sessionId!==part.sessionId||attempt.runId!==part.runId||attempt.providerId!==owner.providerId||attempt.modelId!==owner.modelId||run.config.providerId!==owner.providerId||run.config.modelId!==owner.modelId||latest?.id!==attempt.id||!attempt.dispatchedAt)throw new EngineError('MEDIA_OWNER_INVALID','Media artifact lacks the exact native provider Attempt');
        if(!previous)this.native.appendEvent(part.sessionId,'provider.media.admitted',{part:JSON.parse(encoded) as JsonObject,attempt:storedJson(attempt)},{runId:part.runId,turnId:part.turnId,attemptId:attempt.id});
      }
      if (part.type === 'tool') {
        const tool = this.database.prepare('SELECT session_id,run_id FROM tools WHERE id=?').get(part.toolCallId);
        if (tool && (tool.session_id !== part.sessionId || tool.run_id !== part.runId)) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Tool call identity belongs to another owner');
      }
      if (part.type === 'media' && 'source' in part.artifact.identity) assertProviderMediaPartCapacity(this.database, { encoded, previousBytes: row ? Buffer.byteLength(String(row.data)) : 0, previousOpen: previous?.state === 'open', nextOpen: part.state === 'open', newRecord: !previous });
      const sizes = this.database.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM message_parts WHERE turn_id=?').get(part.turnId)!;
      const bytes = Number(sizes.bytes) - (row ? Buffer.byteLength(String(row.data)) : 0) + Buffer.byteLength(encoded);
      if (!previous && Number(sizes.count) >= PARTS_LIMIT || bytes > this.native.budgets.maxProducerBytes) throw new EngineError('PART_STORAGE_LIMIT', 'Turn part count or byte budget is full');
      invalidateEvidenceRead(this.database);
      this.database.prepare('INSERT INTO message_parts(id,session_id,run_id,turn_id,message_id,part_index,revision,state,data) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state,data=excluded.data')
        .run(part.id, part.sessionId, part.runId, part.turnId, part.messageId, part.index, part.revision, part.state, encoded);
      this.native.appendEvent(part.sessionId, previous ? 'message.part.updated' : 'message.part.created', { part: JSON.parse(encoded) as JsonObject }, { runId: part.runId, turnId: part.turnId });
      return part;
    });
  }
  listParts(turnId: string): MessagePart[] {
    this.getTurn(turnId);
    const sizes = this.database.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM message_parts WHERE turn_id=?').get(turnId)!;
    if (Number(sizes.count) > PARTS_LIMIT || Number(sizes.bytes) > RECORDS_BYTES) throw new EngineError('PART_PAGE_LIMIT', 'Turn parts exceed the bounded read budget');
    return this.database.prepare('SELECT data FROM message_parts WHERE turn_id=? ORDER BY rowid LIMIT ?').all(turnId, PARTS_LIMIT).map(row => validateMessagePart(JSON.parse(String(row.data))));
  }
  listPartsPage(turnId: string, afterPartId?: string, limit = 100): PartPage {
    return this.native.hooks.transaction(() => {
      this.getTurn(turnId);
      const page = this.recordPage('message_parts', 'turn_id', turnId, 'rowid', afterPartId, limit);
      return { parts: page.records.map(validateMessagePart), nextCursor: page.nextCursor };
    });
  }
  nextContextRevisionIndex(sessionId: string): number {
    this.native.hooks.session(sessionId);
    const previous = Number(this.database.prepare('SELECT coalesce(max(revision),0) AS revision FROM context_revisions WHERE session_id=?').get(sessionId)?.revision);
    if (!Number.isSafeInteger(previous) || previous >= Number.MAX_SAFE_INTEGER) throw new EngineError('SEQUENCE_EXHAUSTED', 'Context revision exceeded the safe integer range');
    return previous + 1;
  }
  getLatestContextRevision(sessionId: string): ContextRevision | null {
    this.native.hooks.session(sessionId);
    const row = this.database.prepare('SELECT data FROM context_revisions WHERE session_id=? ORDER BY revision DESC LIMIT 1').get(sessionId);
    return row ? validateContextRevision(JSON.parse(String(row.data))) : null;
  }
  getContextRevision(id: string): ContextRevision {
    this.native.hooks.assertOpen();
    if (!hasEvidenceRead(this.database)) {
      const row = this.database.prepare('SELECT data FROM context_revisions WHERE id=?').get(id);
      if (!row) throw new EngineError('CONTEXT_REVISION_NOT_FOUND', 'Context revision was not found');
      return validateContextRevision(JSON.parse(String(row.data)));
    }
    const row = this.database.prepare('SELECT id,session_id,run_id,turn_id,revision,supersedes_id,length(CAST(data AS BLOB)) AS bytes FROM context_revisions WHERE id=?').get(id);
    if (!row) throw new EngineError('CONTEXT_REVISION_NOT_FOUND', 'Context revision was not found');
    const raw = readEvidenceBody(this.database, { table: 'context_revisions', key: id }, { expectedBytes: Number(row.bytes), maxBytes: 8388608 });
    const context = validateContextRevision(JSON.parse(String(raw)));
    if (context.id !== row.id || context.sessionId !== row.session_id || (context.runId ?? null) !== row.run_id || (context.turnId ?? null) !== row.turn_id || context.revision !== row.revision || (context.supersedesId ?? null) !== row.supersedes_id) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Context payload disagrees with its SQL owner');
    return context;
  }
  putContextRevision(value: ContextRevision): ContextRevision {
    const context = validateContextRevision(value);
    if (sha256Hex(context.text) !== context.sha256) throw new EngineError('CONTEXT_HASH_MISMATCH', 'Context content does not match its hash');
    return this.native.write(context.sessionId, () => {
      this.native.hooks.session(context.sessionId);
      const existing = this.database.prepare('SELECT data FROM context_revisions WHERE id=?').get(context.id);
      if (existing) { sameRecord(JSON.parse(String(existing.data)), context, 'Context revision is immutable'); return context; }
      if (context.runId) this.requireActive(context.sessionId, context.runId);
      if (context.turnId) {
        const turn = this.getTurn(context.turnId);
        if (turn.sessionId !== context.sessionId || turn.runId !== context.runId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Context revision belongs to another Turn');
      }
      const last = this.database.prepare('SELECT id,revision FROM context_revisions WHERE session_id=? ORDER BY revision DESC LIMIT 1').get(context.sessionId);
      if (context.revision !== (last ? Number(last.revision) + 1 : 1)) throw new EngineError('REVISION_CONFLICT', 'Context revision must advance its session exactly once');
      if (context.supersedesId && context.supersedesId !== last?.id) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Context supersedes reference is not the previous session revision');
      invalidateEvidenceRead(this.database);
      const encoded = JSON.stringify(context);
      this.database.prepare('INSERT INTO context_revisions(id,session_id,revision,run_id,turn_id,supersedes_id,data) VALUES(?,?,?,?,?,?,?)')
        .run(context.id, context.sessionId, context.revision, context.runId ?? null, context.turnId ?? null, context.supersedesId ?? null, encoded);
      this.native.appendEvent(context.sessionId, 'context.revision.recorded', { context: JSON.parse(encoded) as JsonObject }, { ...(context.runId ? { runId: context.runId } : {}), ...(context.turnId ? { turnId: context.turnId } : {}) });
      return context;
    });
  }
  getSessionDocument(sessionId: string, kind: string): SessionDocument | null {
    this.native.hooks.session(sessionId); this.documentKind(kind);
    if (!hasEvidenceRead(this.database)) {
      const row = this.database.prepare('SELECT revision,data FROM session_documents WHERE session_id=? AND kind=?').get(sessionId,kind);
      return row ? { revision: Number(row.revision), data: JSON.parse(String(row.data)) as JsonObject } : null;
    }
    const row = this.database.prepare('SELECT revision,length(CAST(data AS BLOB)) AS bytes FROM session_documents WHERE session_id=? AND kind=?').get(sessionId, kind);
    if (!row) return null;
    const raw = readEvidenceBody(this.database, { table: 'session_documents', key: [sessionId,kind] }, { expectedBytes: Number(row.bytes), maxBytes: 262144 });
    return { revision: Number(row.revision), data: JSON.parse(String(raw)) as JsonObject };
  }
  private documentKind(kind: string): void {
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(kind)) throw new EngineError('INVALID_DOCUMENT_KIND', 'Session document kind must be a bounded namespace');
  }
  putSessionDocument(sessionId: string, kind: string, expectedRevision: number, data: JsonObject): SessionDocument {
    this.documentKind(kind);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new EngineError('REVISION_CONFLICT', 'Expected document revision must be a nonnegative safe integer');
    // Use the bounded JSON validator shared by native events, before entering SQL.
    const event = this.nativeEventDocument(sessionId, data);
    const encoded = JSON.stringify(event);
    if (Buffer.byteLength(encoded) > 262_144) throw new EngineError('SESSION_DOCUMENT_LIMIT', 'Session document exceeds 262144 bytes');
    return this.native.write(sessionId, () => {
      const current = this.getSessionDocument(sessionId, kind);
      if ((current?.revision ?? 0) !== expectedRevision) throw new EngineError('REVISION_CONFLICT', 'Session document was updated by another operation');
      const revision = expectedRevision + 1;
      if (kind === 'input_media_segments') assertMediaIndexCapacity(this.database, sessionId, encoded);
      invalidateEvidenceRead(this.database);
      this.database.prepare('INSERT INTO session_documents(session_id,kind,revision,data) VALUES(?,?,?,?) ON CONFLICT(session_id,kind) DO UPDATE SET revision=excluded.revision,data=excluded.data')
        .run(sessionId, kind, revision, encoded);
      this.native.appendEvent(sessionId, 'session.document.updated', { kind, revision, sha256: sha256Hex(encoded) });
      return { revision, data: event };
    });
  }
  private nativeEventDocument(sessionId: string, value: JsonObject): JsonObject {
    // Validation reuses a context-free native event solely to copy plain bounded JSON.
    const validation = requireDocumentJson(value);
    this.native.hooks.session(sessionId);
    return validation;
  }
  /** Caller shares the v1 recovery transaction; no effect is retried or treated as completed. */
  recoverInTransaction(affectedSessions: Set<string>, toolFrontiers: ToolRecoveryFrontiers = new Map()): void {
    const now = new Date().toISOString();
    const attempts = this.database.prepare("SELECT data FROM provider_attempts WHERE state IN ('prepared','dispatched','streaming') ORDER BY rowid").all();
    const ambiguous = new Set<string>();
    for (const row of attempts) {
      const previous = validateProviderAttempt(JSON.parse(String(row.data)));
      const dispatched = previous.state !== 'prepared';
      const attempt = validateProviderAttempt({ ...previous, state: dispatched ? 'uncertain' : 'interrupted', completedAt: now,
        ...(dispatched ? { uncertainty: { kind: 'provider_dispatch', message: 'Provider dispatch ended without a durable outcome; automatic retry is unsafe', requiresRecovery: true } } : {}) });
      if (dispatched) ambiguous.add(attempt.turnId);
      this.database.prepare('UPDATE provider_attempts SET state=?,data=? WHERE id=?').run(attempt.state, JSON.stringify(attempt), attempt.id);
      this.native.appendEvent(attempt.sessionId, `provider.attempt.${attempt.state}`, { attempt: storedJson(attempt) }, { runId: attempt.runId, turnId: attempt.turnId, attemptId: attempt.id });
      affectedSessions.add(attempt.sessionId);
    }
    const parts = this.database.prepare("SELECT data FROM message_parts WHERE state='open' ORDER BY rowid").all();
    for (const row of parts) {
      const previous = validateMessagePart(JSON.parse(String(row.data)));
      const part = validateMessagePart({ ...previous, state: 'interrupted', completedAt: now, revision: previous.revision + 1 });
      this.database.prepare("UPDATE message_parts SET state='interrupted',revision=?,data=? WHERE id=?").run(part.revision, JSON.stringify(part), part.id);
      this.native.appendEvent(part.sessionId, 'message.part.interrupted', { part: storedJson(part) }, { runId: part.runId, turnId: part.turnId });
      affectedSessions.add(part.sessionId);
    }
    const turns = this.database.prepare("SELECT data FROM session_turns WHERE state IN ('created','streaming','awaiting_tools') ORDER BY rowid").all();
    for (const row of turns) {
      const previous = validateTurnRecord(JSON.parse(String(row.data)));
      const mcp = this.database.prepare("SELECT 1 FROM mcp_executions WHERE turn_id=? AND session_id=? AND run_id=? AND (state IN ('dispatch-intent','uncertain') OR transport_cleanup_confirmed=0) LIMIT 1").get(previous.id,previous.sessionId,previous.runId);
      const runningIntent = toolFrontiers.has(previous.id);
      const unknown = !!mcp || runningIntent || ambiguous.has(previous.id);
      const turn = validateTurnRecord({ ...previous, state: unknown ? 'uncertain' : 'interrupted', completedAt: now,
        ...(unknown ? { uncertainty: { kind: mcp || runningIntent ? 'tool_effect' : 'provider_dispatch', message: mcp ? 'Turn owns a MCP call without a settled request outcome or local cleanup; no automatic retry is safe' : runningIntent ? 'Turn contains an original tool running intent without a durable generic outcome; callback entry and effects are unverified' : 'Turn contains a provider dispatch with an unknown outcome', requiresRecovery: true } } : {}) });
      this.database.prepare('UPDATE session_turns SET state=?,data=? WHERE id=?').run(turn.state, JSON.stringify(turn), turn.id);
      this.native.appendEvent(turn.sessionId, `turn.${turn.state}`, { turn: storedJson(turn) }, { runId: turn.runId, turnId: turn.id });
      affectedSessions.add(turn.sessionId);
    }
    for (const sessionId of affectedSessions) this.native.setControlInTransaction(sessionId, true, 'recovery_required');
  }
}

function requireDocumentJson(value: JsonObject): JsonObject {
  return validateSessionEvent({ schemaVersion: 2, stream: 'session-v2', eventId: 'document-validation', sessionId: 'document-validation', seq: 1,
    timestamp: '2026-10-07T00:00:00.000Z', type: 'session.document', payload: value }).payload;
}

/** Events of one session and type, oldest first. Each body is reread under its exact length and must agree with its SQL row and the search; a body that is not JSON stays a candidate so it reaches the caller's thunks. */
export function findEventPayloads(db: DatabaseSync, search: EventSearch, errors: NativeReadErrors): JsonObject[] {
  const refs = EVENT_REFS.filter(([field]) => search.refs?.[field] !== undefined), refValues = refs.flatMap(([field]) => search.refs![field] ?? []), paths = Object.entries(search.payload ?? {});
  if (paths.some(([path]) => !PAYLOAD_PATH.test(path))) throw new TypeError('Event payload paths must be dotted identifiers');
  const filters = ['session_id=?', 'type=?', ...refs.map(([field, column]) => search.refs![field] === null ? `${column} IS NULL` : `${column}=?`), ...(search.contains === undefined ? [] : ['instr(data,?)>0']), ...paths.map(([path]) => `CASE WHEN json_valid(data) THEN json_extract(data,'$.payload.${path}')=? ELSE 1 END`)];
  const rows = db.prepare(`SELECT seq,run_id,input_id,turn_id,attempt_id,length(CAST(data AS BLOB)) bytes FROM session_events WHERE ${filters.join(' AND ')} ORDER BY seq LIMIT ?`)
    .all(search.sessionId, search.type, ...refValues, ...(search.contains === undefined ? [] : [search.contains]), ...paths.map(([, value]) => value), search.maxRows + 1);
  if (rows.length > search.maxRows || search.maxTotalBytes !== undefined && rows.reduce((total, row) => total + Number(row.bytes), 0) > search.maxTotalBytes) errors.limit();
  return rows.map(row => {
    if (!Number.isSafeInteger(row.bytes) || Number(row.bytes) < 1 || Number(row.bytes) > search.maxRowBytes) errors.limit();
    const raw = readBoundedBody(db, { table: 'session_events', where: 'session_id=? AND seq=?', params: [search.sessionId, row.seq!] }, Number(row.bytes), errors.invalid) ?? errors.invalid();
    const event = parseObject(raw, errors.invalid), payload = event.payload;
    if (event.sessionId !== search.sessionId || event.seq !== row.seq || event.type !== search.type || !isObject(payload)
      || EVENT_REFS.some(([field, column]) => (event[field] ?? null) !== row[column]) || search.contains !== undefined && !raw.includes(search.contains)
      || paths.some(([path, value]) => path.split('.').reduce<unknown>((node, key) => isObject(node) && Object.hasOwn(node, key) ? node[key] : undefined, payload) !== value)) errors.invalid();
    return payload as JsonObject;
  });
}

/** A session document whose exact bytes match the one `session.document.updated` event putSessionDocument wrote for its revision. */
export function readAnchoredDocument(db: DatabaseSync, query: { sessionId: string; kind: string; revision?: number; maxBytes: number }, errors: NativeReadErrors & { anchor: () => never }): AnchoredDocument | undefined {
  const fenced = query.revision === undefined ? '' : ' AND revision=?', params = [query.sessionId, query.kind, ...(query.revision === undefined ? [] : [query.revision])];
  const header = readBoundedHeader(db, `SELECT revision,length(CAST(data AS BLOB)) AS bytes FROM session_documents WHERE session_id=? AND kind=?${fenced}`, params, query.maxBytes, errors.limit);
  if (!header) return undefined;
  const revision = header.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return errors.invalid();
  const raw = readBoundedBody(db, { table: 'session_documents', where: 'session_id=? AND kind=? AND revision=?', params: [query.sessionId, query.kind, revision] }, header.bytes, errors.invalid) ?? errors.invalid();
  const sha256 = sha256Hex(raw);
  const anchors = findEventPayloads(db, { sessionId: query.sessionId, type: 'session.document.updated', contains: sha256, payload: { kind: query.kind, revision, sha256 }, maxRows: 1,
    maxRowBytes: DOCUMENT_ANCHOR_BYTES }, { limit: errors.anchor, invalid: errors.anchor });
  if (anchors.length !== 1) errors.anchor();
  return { revision, raw, data: parseObject(raw, errors.invalid) };
}

function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function parseObject(raw: string, invalid: () => never): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return invalid(); }
  return isObject(value) ? value : invalid();
}
