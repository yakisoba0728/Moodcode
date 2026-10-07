import type { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { EngineError } from '@moodcode/contracts';

export const EVIDENCE_READ_LIMITS = Object.freeze({ maxSelectedBytes: 8_388_608, maxCachedBodies: 4096 });
const primaryKeys = {
  workspaces: 'id', sessions: 'id', runs: 'id', inputs: 'id', session_inputs: 'id', session_turns: 'id',
  provider_attempts: 'id', attempt_cleanup: 'attempt_id', attempt_usage: 'attempt_id', summary_attempts: 'id', summary_usage: 'summary_attempt_id', mcp_executions: 'tool_call_id',
  messages: 'id', message_parts: 'id', tools: 'id', approvals: 'id', checkpoints: 'id', events: 'event_id', session_events: 'event_id',
  context_revisions: 'id', session_documents: 'session_id', summary_recovery_acknowledgments: 'id', provider_recovery_acknowledgments: 'id',
} as const;
export type EvidenceTable = keyof typeof primaryKeys;
export type EvidenceProjection = 'data' | 'summary-metadata-v1' | 'context-owner-v1' | 'mcp-proposal-v1';
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
function identifier(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value); }
function address(value: EvidenceAddress): { table: EvidenceTable; parameters: string[]; where: string; projection: EvidenceProjection; expression: string; cacheKey: string } {
  plain(value, ['table','key','projection'], ['table','key']);
  if (typeof value.table !== 'string' || !Object.hasOwn(primaryKeys, value.table)) fail('INVALID_REQUEST', 'Evidence reads require a known primary table');
  const table = value.table as EvidenceTable, projection = Object.hasOwn(value, 'projection') ? value.projection : 'data';
  if (typeof projection !== 'string' || !['data','summary-metadata-v1','context-owner-v1','mcp-proposal-v1'].includes(projection) || projection === 'summary-metadata-v1' && table !== 'summary_attempts'
    || projection === 'context-owner-v1' && table !== 'context_revisions' || projection === 'mcp-proposal-v1' && table !== 'message_parts') fail('INVALID_REQUEST', 'Evidence reads require a known table projection');
  let parameters: string[], where: string;
  if (table === 'session_documents') {
    if (!Array.isArray(value.key) || types.isProxy(value.key) || value.key.length !== 2) fail('INVALID_REQUEST', 'Session document evidence requires its exact composite key');
    for (const index of ['0','1']) { const property = Object.getOwnPropertyDescriptor(value.key, index); if (!property || !('value' in property) || !identifier(property.value)) fail('INVALID_REQUEST', 'Evidence composite keys require bounded data identities'); }
    parameters = [value.key[0]!, value.key[1]!];
    if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(parameters[1]!)) fail('INVALID_REQUEST', 'Evidence document kind is invalid');
    where = 'session_id=? AND kind=?';
  } else {
    if (!identifier(value.key)) fail('INVALID_REQUEST', 'Evidence reads require a bounded primary identity');
    parameters = [value.key]; where = `${primaryKeys[table]}=?`;
  }
  const expression = projection === 'summary-metadata-v1' ? "json_remove(data,'$.partialText')" : projection === 'context-owner-v1'
    ? "json_object('id',json_extract(data,'$.id'),'sessionId',json_extract(data,'$.sessionId'),'runId',json_extract(data,'$.runId'),'turnId',json_extract(data,'$.turnId'))" : projection === 'mcp-proposal-v1' ? "json_remove(data,'$.result')" : 'data';
  return { table, parameters, where, projection: projection as EvidenceProjection, expression, cacheKey: JSON.stringify([table, parameters, projection]) };
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
/** General store getters keep their existing behavior outside proof selection. */
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
  const metadata = expectedBytes === undefined ? db.prepare(`SELECT length(CAST(${selected.expression} AS BLOB)) AS bytes FROM ${selected.table} WHERE ${selected.where}`).get(...selected.parameters) : { bytes: expectedBytes };
  if (!metadata) return undefined;
  if (!Number.isSafeInteger(metadata.bytes) || Number(metadata.bytes) < 0 || Number(metadata.bytes) > maxBytes) return limit(frame);
  const bytes = Number(metadata.bytes);
  if (frame) {
    if (frame.cache.size >= EVIDENCE_READ_LIMITS.maxCachedBodies || bytes > EVIDENCE_READ_LIMITS.maxSelectedBytes - frame.bytes) return limit(frame);
    frame.bytes += bytes;
  }
  const field = selected.projection === 'data' ? 'data' : `${selected.expression} AS data`;
  // A host/native callback may write after its owner header was selected. Keep
  // the byte proof in the body SQL as well, so stale sizes cannot copy a larger
  // value into JavaScript before the caller detects the changed source.
  const row = db.prepare(`SELECT ${field} FROM ${selected.table} WHERE ${selected.where} AND length(CAST(${selected.expression} AS BLOB))=?`).get(...selected.parameters, bytes);
  if (!row) return undefined;
  if (typeof row.data !== 'string' || Buffer.byteLength(row.data) !== bytes) fail('CHANGED', 'Returned evidence disagrees with its selected byte size');
  if (frame) frame.cache.set(selected.cacheKey, { raw: row.data, bytes });
  return row.data;
}
