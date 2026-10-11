import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { types } from 'node:util';
import { EngineError } from '@moodcode/contracts';
import { isBoundedId } from '../shared/data.js';

export const EVIDENCE_READ_LIMITS = Object.freeze({ maxSelectedBytes: 8_388_608, maxCachedBodies: 4096 });
const primaryKeys = {
  workspaces: 'id', sessions: 'id', runs: 'id', inputs: 'id', session_inputs: 'id', session_turns: 'id',
  provider_attempts: 'id', attempt_cleanup: 'attempt_id', attempt_usage: 'attempt_id', summary_attempts: 'id', summary_usage: 'summary_attempt_id', mcp_executions: 'tool_call_id',
  messages: 'id', message_parts: 'id', tools: 'id', approvals: 'id', checkpoints: 'id', events: 'event_id', session_events: 'event_id',
  context_revisions: 'id', session_documents: 'session_id', summary_recovery_acknowledgments: 'id', provider_recovery_acknowledgments: 'id',
} as const;
export type EvidenceTable = keyof typeof primaryKeys;
export type EvidenceProjection = 'data' | 'summary-metadata-v1' | 'mcp-proposal-v1';
export interface EvidenceAddress { table: EvidenceTable; key: string | readonly [sessionId: string, kind: string]; projection?: EvidenceProjection }
export interface EvidenceBodyBounds { expectedBytes?: number; maxBytes: number }
interface Frame { bytes: number; exhausted: boolean; epoch?: string; cache: Map<string, { raw: string; bytes: number }> }
const active = new WeakMap<DatabaseSync, Frame>();
function fail(suffix: string, message: string): never { throw new EngineError(`RECOVERY_EVIDENCE_${suffix}`, message); }
function limit(frame?: Frame): never { if (frame) frame.exhausted = true; return fail('LIMIT', 'Recovery selected evidence exceeds its bounded read budget'); }
function plain(value: unknown, fields: readonly string[], required: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_REQUEST', 'Evidence reads require plain descriptors');
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !fields.includes(key) || !property?.enumerable || !('value' in property)) fail('INVALID_REQUEST', 'Evidence read descriptors reject accessors and unknown fields');
  }
  if (required.some(key => !Object.hasOwn(value, key))) fail('INVALID_REQUEST', 'Evidence read descriptors require their own data fields');
}
function address(value: EvidenceAddress): { table: EvidenceTable; parameters: string[]; where: string; expression: string; cacheKey: string } {
  plain(value, ['table','key','projection'], ['table','key']);
  if (typeof value.table !== 'string' || !Object.hasOwn(primaryKeys, value.table)) fail('INVALID_REQUEST', 'Evidence reads require a known primary table');
  const table = value.table as EvidenceTable, projection = Object.hasOwn(value, 'projection') ? value.projection : 'data';
  if (typeof projection !== 'string' || !['data','summary-metadata-v1','mcp-proposal-v1'].includes(projection) || projection === 'summary-metadata-v1' && table !== 'summary_attempts'
    || projection === 'mcp-proposal-v1' && table !== 'message_parts') fail('INVALID_REQUEST', 'Evidence reads require a known table projection');
  let parameters: string[], where: string;
  if (table === 'session_documents') {
    if (!Array.isArray(value.key) || types.isProxy(value.key) || value.key.length !== 2) fail('INVALID_REQUEST', 'Session document evidence requires its exact composite key');
    for (const index of ['0','1']) { const property = Object.getOwnPropertyDescriptor(value.key, index); if (!property || !('value' in property) || !isBoundedId(property.value)) fail('INVALID_REQUEST', 'Evidence composite keys require bounded data identities'); }
    parameters = [value.key[0]!, value.key[1]!];
    if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(parameters[1]!)) fail('INVALID_REQUEST', 'Evidence document kind is invalid');
    where = 'session_id=? AND kind=?';
  } else {
    if (!isBoundedId(value.key)) fail('INVALID_REQUEST', 'Evidence reads require a bounded primary identity');
    parameters = [value.key]; where = `${primaryKeys[table]}=?`;
  }
  const expression = projection === 'summary-metadata-v1' ? "json_remove(data,'$.partialText')" : projection === 'mcp-proposal-v1' ? "json_remove(data,'$.result')" : 'data';
  return { table, parameters, where, expression, cacheKey: JSON.stringify([table, parameters, projection]) };
}
function observedEpoch(db: DatabaseSync): string {
  const row = db.prepare('SELECT CAST(total_changes() AS TEXT) AS changes,data_version FROM pragma_data_version').get();
  const changes = row?.changes, version = row?.data_version;
  if (typeof changes !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(changes) || !Number.isSafeInteger(version)) fail('CHANGED', 'Evidence transaction mutation markers are unavailable');
  return `${changes}:${version}`;
}
function current(db: DatabaseSync): Frame | undefined {
  const frame = active.get(db); if (!frame) return undefined;
  if (frame.exhausted) return limit(frame);
  if (!db.isTransaction) fail('TRANSACTION_REQUIRED', 'Evidence cache cannot survive its primary transaction');
  const epoch = observedEpoch(db);
  if (frame.epoch !== epoch) { frame.cache.clear(); frame.epoch = epoch; }
  return frame;
}

/** Scope raw strings only to one synchronous primary transaction, including nested owner reads. */
export function withEvidenceRead<T>(db: DatabaseSync, operation: () => T): T {
  if (!db.isTransaction) fail('TRANSACTION_REQUIRED', 'Evidence read scope requires an active primary transaction');
  if (typeof operation !== 'function' || types.isAsyncFunction(operation)) fail('INVALID_REQUEST', 'Evidence read scopes are synchronous');
  const outer = active.get(db), frame = outer ?? { bytes: 0, exhausted: false, cache: new Map() };
  if (!outer) active.set(db, frame);
  try {
    if (frame.exhausted) return limit(frame);
    const result = operation();
    if (types.isPromise(result)) fail('INVALID_REQUEST', 'Evidence read scopes cannot return asynchronous work');
    if (!db.isTransaction) fail('TRANSACTION_REQUIRED', 'Evidence read operation ended its primary transaction');
    if (frame.exhausted) return limit(frame);
    return result;
  } finally { if (!outer) { frame.cache.clear(); active.delete(db); } }
}

/** Explicit writes invalidate all cached bodies; already observed bytes are never refunded. */
export function invalidateEvidenceRead(db: DatabaseSync): void { const frame = active.get(db); if (frame) { frame.cache.clear(); frame.epoch = undefined; } }
export function hasEvidenceRead(db: DatabaseSync): boolean { return active.has(db); }

/** Call after native ownership/header validation; cache hits never replace those checks. */
export function readEvidenceBody(db: DatabaseSync, supplied: EvidenceAddress, suppliedBounds: EvidenceBodyBounds): string | undefined {
  const selected = address(supplied); plain(suppliedBounds, ['expectedBytes','maxBytes'], ['maxBytes']);
  const expectedBytes = Object.hasOwn(suppliedBounds, 'expectedBytes') ? suppliedBounds.expectedBytes : undefined, maxBytes = suppliedBounds.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > EVIDENCE_READ_LIMITS.maxSelectedBytes
    || expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)) fail('INVALID_REQUEST', 'Evidence reads require bounded safe byte sizes');
  const frame = current(db);
  if (expectedBytes !== undefined && expectedBytes > maxBytes) return limit(frame);
  const cached = frame?.cache.get(selected.cacheKey);
  if (cached) {
    if (cached.bytes > maxBytes) return limit(frame);
    if (expectedBytes !== undefined && expectedBytes !== cached.bytes) fail('CHANGED', 'Cached evidence no longer matches selected metadata');
    return cached.raw;
  }
  let bytes = expectedBytes;
  if (bytes === undefined) {
    const header = readBoundedHeader(db, `SELECT length(CAST(${selected.expression} AS BLOB)) AS bytes FROM ${selected.table} WHERE ${selected.where}`, selected.parameters, maxBytes, () => limit(frame));
    if (!header) return undefined;
    bytes = header.bytes;
  }
  if (frame) {
    if (frame.cache.size >= EVIDENCE_READ_LIMITS.maxCachedBodies || bytes > EVIDENCE_READ_LIMITS.maxSelectedBytes - frame.bytes) return limit(frame);
    frame.bytes += bytes;
  }
  const raw = readBoundedBody(db, { table: selected.table, where: selected.where, params: selected.parameters, expression: selected.expression }, bytes,
    () => fail('CHANGED', 'Returned evidence disagrees with its selected byte size'));
  if (raw !== undefined && frame) frame.cache.set(selected.cacheKey, { raw, bytes });
  return raw;
}

/** Trusted SQL identifiers; values bind through params. */
export interface BoundedBodySource { table: string; where: string; params: readonly SQLInputValue[]; expression?: string }

/** The header's `bytes` column is the body length; an oversized body fails before any of it is copied. */
export function readBoundedHeader(db: DatabaseSync, sql: string, params: readonly SQLInputValue[], maxBytes: number, limit: () => never): Record<string, SQLOutputValue> & { bytes: number } | undefined {
  const row = db.prepare(sql).get(...params);
  if (!row) return undefined;
  if (!Number.isSafeInteger(row.bytes) || Number(row.bytes) < 0 || Number(row.bytes) > maxBytes) return limit();
  return row as Record<string, SQLOutputValue> & { bytes: number };
}

/** The body SQL repeats the byte proof, so a row changed after its header was selected never copies a larger value; a vanished or resized row reads as undefined. */
export function readBoundedBody(db: DatabaseSync, source: BoundedBodySource, bytes: number, changed: () => never): string | undefined {
  const expression = source.expression ?? 'data', field = expression === 'data' ? 'data' : `${expression} AS data`;
  const row = db.prepare(`SELECT ${field} FROM ${source.table} WHERE ${source.where} AND length(CAST(${expression} AS BLOB))=?`).get(...source.params, bytes);
  if (!row) return undefined;
  if (typeof row.data !== 'string' || Buffer.byteLength(row.data) !== bytes) return changed();
  return row.data;
}

export type OwnerReadFailure = 'owner' | 'payload' | 'limit';
export interface RunOwnerHeader {
  id: string; sessionId: string; workspaceId: string; inputId: unknown; state: unknown;
  runBytes: number; sessionBytes: number; workspaceBytes: number;
}
type OwnerBody = { id?: unknown; sessionId?: unknown; workspaceId?: unknown; inputId?: unknown; state?: unknown } | null | undefined;
function ownerBytes(value: SQLOutputValue | undefined, maxBytes: number, fail: (failure: OwnerReadFailure) => never): number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maxBytes ? Number(value) : fail('limit');
}

/** Bounds a Run's session and workspace SQL owners and all three body sizes before any body is read. */
export function readRunOwnerHeader(db: DatabaseSync, runId: string, expected: { sessionId: string; workspaceId?: string }, maxBytes: number, fail: (failure: OwnerReadFailure) => never): RunOwnerHeader {
  const row = db.prepare(`SELECT r.id,CASE WHEN length(CAST(r.session_id AS BLOB))<=256 THEN r.session_id END AS session_id,
    CASE WHEN length(CAST(r.workspace_id AS BLOB))<=256 THEN r.workspace_id END AS workspace_id,
    CASE WHEN length(CAST(r.input_id AS BLOB))<=256 THEN r.input_id END AS input_id,
    CASE WHEN length(CAST(r.state AS BLOB))<=32 THEN r.state END AS state,length(CAST(r.data AS BLOB)) AS run_bytes,
    CASE WHEN length(CAST(s.workspace_id AS BLOB))<=256 THEN s.workspace_id END AS session_workspace_id,
    length(CAST(s.data AS BLOB)) AS session_bytes,length(CAST(w.data AS BLOB)) AS workspace_bytes
    FROM runs r JOIN sessions s ON s.id=r.session_id JOIN workspaces w ON w.id=r.workspace_id WHERE r.id=?`).get(runId);
  if (!row || row.id !== runId || row.session_id !== expected.sessionId || !isBoundedId(row.workspace_id) || row.session_workspace_id !== row.workspace_id
    || expected.workspaceId !== undefined && row.workspace_id !== expected.workspaceId) return fail('owner');
  return { id: runId, sessionId: expected.sessionId, workspaceId: row.workspace_id, inputId: row.input_id, state: row.state,
    runBytes: ownerBytes(row.run_bytes, maxBytes, fail), sessionBytes: ownerBytes(row.session_bytes, maxBytes, fail), workspaceBytes: ownerBytes(row.workspace_bytes, maxBytes, fail) };
}

export function sameRunOwner(header: RunOwnerHeader, run: OwnerBody, session: OwnerBody, workspace: OwnerBody): boolean {
  return run?.id === header.id && run.sessionId === header.sessionId && run.workspaceId === header.workspaceId && run.inputId === header.inputId && run.state === header.state
    && session?.id === header.sessionId && session.workspaceId === header.workspaceId && workspace?.id === header.workspaceId;
}

/** The SQL owner must name this session, Run and Turn or none; the payload must repeat the SQL owner exactly. */
export function assertContextRevisionOwner(db: DatabaseSync, contextRevisionId: string, owner: { sessionId: string; runId: string; turnId: string }, maxBytes: number, fail: (failure: OwnerReadFailure) => never): void {
  const context = db.prepare(`SELECT id,CASE WHEN length(CAST(session_id AS BLOB))<=256 THEN session_id END AS session_id,
    CASE WHEN run_id IS NULL OR length(CAST(run_id AS BLOB))<=256 THEN run_id END AS run_id,
    CASE WHEN turn_id IS NULL OR length(CAST(turn_id AS BLOB))<=256 THEN turn_id END AS turn_id,
    run_id IS NOT NULL AND length(CAST(run_id AS BLOB))>256 AS invalid_run,turn_id IS NOT NULL AND length(CAST(turn_id AS BLOB))>256 AS invalid_turn,
    length(CAST(data AS BLOB)) AS bytes,
    CASE WHEN length(CAST(json_extract(data,'$.id') AS BLOB))<=256 THEN json_extract(data,'$.id') END AS payload_id,
    CASE WHEN length(CAST(json_extract(data,'$.sessionId') AS BLOB))<=256 THEN json_extract(data,'$.sessionId') END AS payload_session_id,
    CASE WHEN json_extract(data,'$.runId') IS NULL OR length(CAST(json_extract(data,'$.runId') AS BLOB))<=256 THEN json_extract(data,'$.runId') END AS payload_run_id,
    CASE WHEN json_extract(data,'$.turnId') IS NULL OR length(CAST(json_extract(data,'$.turnId') AS BLOB))<=256 THEN json_extract(data,'$.turnId') END AS payload_turn_id,
    json_extract(data,'$.runId') IS NOT NULL AND length(CAST(json_extract(data,'$.runId') AS BLOB))>256 AS invalid_payload_run,
    json_extract(data,'$.turnId') IS NOT NULL AND length(CAST(json_extract(data,'$.turnId') AS BLOB))>256 AS invalid_payload_turn FROM context_revisions WHERE id=?`).get(contextRevisionId);
  if (!context || context.id !== contextRevisionId || context.session_id !== owner.sessionId || context.run_id !== null && context.run_id !== owner.runId
    || context.turn_id !== null && context.turn_id !== owner.turnId || context.invalid_run !== 0 || context.invalid_turn !== 0) return fail('owner');
  if (context.invalid_payload_run !== 0 || context.invalid_payload_turn !== 0 || context.payload_id !== context.id || context.payload_session_id !== context.session_id
    || context.payload_run_id !== context.run_id || context.payload_turn_id !== context.turn_id) fail('payload');
  ownerBytes(context.bytes, maxBytes, fail);
}
