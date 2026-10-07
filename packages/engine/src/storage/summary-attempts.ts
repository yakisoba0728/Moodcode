import { types } from 'node:util';
import { EngineError, type EngineEvent, type JsonObject, type Run } from '@moodcode/contracts';
import { NativeSessionStorage } from './native.js';
import { invalidateEvidenceRead, readEvidenceBody } from './evidence-read.js';

export const SUMMARY_STORAGE_TABLES = ['summary_attempts', 'summary_usage'] as const;
export const SUMMARY_ATTEMPT_SCHEMA = `CREATE TABLE summary_attempts (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  run_id TEXT NOT NULL REFERENCES runs(id), scope TEXT NOT NULL CHECK(scope IN ('completed-history','active-run-prefix')),
  state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','streaming','completed','failed','interrupted','uncertain')),
  revision INTEGER NOT NULL CHECK(revision>0), data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=524288)
) STRICT;
CREATE INDEX summary_attempts_session ON summary_attempts(session_id);
CREATE INDEX summary_attempts_run_state ON summary_attempts(run_id,state);
CREATE TABLE summary_usage (
  summary_attempt_id TEXT PRIMARY KEY REFERENCES summary_attempts(id), session_id TEXT NOT NULL REFERENCES sessions(id),
  run_id TEXT NOT NULL REFERENCES runs(id), revision INTEGER NOT NULL CHECK(revision>0), data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=4096)
) STRICT;
CREATE INDEX summary_usage_session ON summary_usage(session_id);`;
export type SummaryAttemptState = 'prepared' | 'dispatched' | 'streaming' | 'completed' | 'failed' | 'interrupted' | 'uncertain';
export interface SummaryUsageSnapshot { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; reasoningOutputTokens: number | null }
export interface SummaryAttemptIdentity {
  id: string; scope: 'completed-history' | 'active-run-prefix'; sessionId: string; workspaceId: string; runId: string; providerId: string; modelId: string;
  sourceProjection: string; sourceSha256: string; requestSha256: string; requestBytes: number; expectedMemoryRevision: number;
  manifestSha256?: string; policySha256?: string; expectedContextHeadRevision?: number; priorCheckpointId?: string;
  sourceMessageIds?: string[]; sourceRunIds?: string[]; sourceTurnIds?: string[];
  boundaryTurnId?: string; boundaryAttemptId?: string; currentTurnId?: string; failedAttemptId?: string; createdAt?: string;
}
export interface SummaryAttemptRecord extends Omit<SummaryAttemptIdentity, 'createdAt'> {
  schemaVersion: 2; revision: number; state: SummaryAttemptState; createdAt: string; updatedAt: string; dispatchedAt?: string; firstObservationAt?: string;
  providerCompletedAt?: string; completedAt?: string; cleanupConfirmed: boolean; publication: 'pending' | 'activated' | 'discarded'; providerRequestId?: string; finishReason?: string;
  observedOutputBytes: number; retainedTextBytes: number; partialText: string; partialTextTruncated: boolean;
  summaryRevisionId?: string; contextRevisionId?: string; errorCode?: string; uncertainty?: { kind: 'provider_dispatch'; requiresRecovery: true };
}
export interface SummaryUsageRecord { summaryAttemptId: string; sessionId: string; runId: string; revision: number; usage: SummaryUsageSnapshot; observedAt: string }
export interface SummaryObservation { textDelta?: string; usage?: Partial<SummaryUsageSnapshot>; providerRequestId?: string; finishReason?: string }
export interface SummarySettlement { state: 'failed' | 'interrupted' | 'uncertain'; errorCode?: string; cleanupConfirmed: boolean }
export interface SummaryAttemptListOptions { afterId?: string; runId?: string; limit?: number }
export interface SummaryAttemptPage { attempts: SummaryAttemptRecord[]; nextCursor: string | null }
const terminal = new Set<SummaryAttemptState>(['completed', 'failed', 'interrupted', 'uncertain']);
const keys = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens'] as const;
const unknownUsage = (): SummaryUsageSnapshot => ({ inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null });
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function fail(code: string, message: string): never { throw new EngineError(code, message); }
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value); }
function json(value: unknown): JsonObject { return JSON.parse(JSON.stringify(value)) as JsonObject; }
function plain(value: unknown, allowed: readonly string[]): void {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_SUMMARY_RECORD', 'Summary records must be plain data');
  for (const key of Reflect.ownKeys(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key)!; if (typeof key !== 'string' || !allowed.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_SUMMARY_RECORD', 'Summary records cannot contain unknown fields or accessors'); }
}
function ids(values: unknown, max: number): values is string[] {
  if (!Array.isArray(values) || types.isProxy(values) || Object.getPrototypeOf(values) !== Array.prototype || values.length > max || Reflect.ownKeys(values).length !== values.length + 1) return false;
  for (let index = 0; index < values.length; index++) { const descriptor = Object.getOwnPropertyDescriptor(values, String(index)); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !id(descriptor.value)) return false; }
  return new Set(values).size === values.length;
}
const identityKeys = ['id', 'scope', 'sessionId', 'workspaceId', 'runId', 'providerId', 'modelId', 'sourceProjection', 'sourceSha256', 'requestSha256', 'requestBytes', 'expectedMemoryRevision', 'manifestSha256', 'policySha256', 'expectedContextHeadRevision', 'priorCheckpointId', 'sourceMessageIds', 'sourceRunIds', 'sourceTurnIds', 'boundaryTurnId', 'boundaryAttemptId', 'currentTurnId', 'failedAttemptId', 'createdAt'];
function identity(value: SummaryAttemptIdentity): SummaryAttemptIdentity {
  plain(value, identityKeys);
  for (const key of ['id', 'sessionId', 'workspaceId', 'runId', 'providerId', 'modelId', 'sourceProjection'] as const) if (!id(value[key])) fail('INVALID_SUMMARY_RECORD', 'Summary owner and projection require bounded identities');
  if (!['completed-history', 'active-run-prefix'].includes(value.scope) || !sha(value.sourceSha256) || !sha(value.requestSha256) || !Number.isSafeInteger(value.requestBytes) || value.requestBytes < 1 || value.requestBytes > 1048576
    || !Number.isSafeInteger(value.expectedMemoryRevision) || value.expectedMemoryRevision < 0) fail('INVALID_SUMMARY_RECORD', 'Summary source/request identity is invalid');
  for (const key of ['manifestSha256', 'policySha256'] as const) if (value[key] !== undefined && !sha(value[key])) fail('INVALID_SUMMARY_RECORD', 'Summary digest is invalid');
  for (const key of ['priorCheckpointId', 'boundaryTurnId', 'boundaryAttemptId', 'currentTurnId', 'failedAttemptId'] as const) if (value[key] !== undefined && !id(value[key])) fail('INVALID_SUMMARY_RECORD', 'Summary proof identity is invalid');
  if (value.expectedContextHeadRevision !== undefined && (!Number.isSafeInteger(value.expectedContextHeadRevision) || value.expectedContextHeadRevision < 0)) fail('INVALID_SUMMARY_RECORD', 'Summary context baseline is invalid');
  for (const key of ['sourceMessageIds', 'sourceRunIds', 'sourceTurnIds'] as const) {
    const values = value[key]; if (values !== undefined && !ids(values, key === 'sourceMessageIds' ? 512 : 128)) fail('INVALID_SUMMARY_RECORD', 'Summary source identities exceed their bound');
  }
  if (value.createdAt !== undefined && (typeof value.createdAt !== 'string' || value.createdAt.length > 64 || !Number.isFinite(Date.parse(value.createdAt)))) fail('INVALID_SUMMARY_RECORD', 'Summary creation time is invalid');
  if (Buffer.byteLength(JSON.stringify(value)) > 65536) fail('SUMMARY_RECORD_LIMIT', 'Summary source identity exceeds its byte budget');
  return structuredClone(value);
}
function prefix(text: string, bytes: number): string {
  if (bytes <= 0) return '';
  if (Buffer.byteLength(text) <= bytes) return text;
  const value = Buffer.from(text.slice(0, bytes)); let end = Math.min(bytes, value.length);
  while (end > 0 && end < value.length && (value[end]! & 0xc0) === 0x80) end--;
  return value.subarray(0, end).toString();
}
type SummaryAttemptMetadata = Omit<SummaryAttemptRecord, 'partialText'>;
function validateMetadata(value: SummaryAttemptMetadata, textType: string, textBytes: number): void {
  plain(value, [...identityKeys, 'schemaVersion', 'revision', 'state', 'updatedAt', 'dispatchedAt', 'firstObservationAt', 'providerCompletedAt', 'completedAt', 'cleanupConfirmed', 'publication', 'providerRequestId', 'finishReason', 'observedOutputBytes', 'retainedTextBytes', 'partialText', 'partialTextTruncated', 'summaryRevisionId', 'contextRevisionId', 'errorCode', 'uncertainty']);
  identity(Object.fromEntries(identityKeys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key as keyof SummaryAttemptMetadata]])) as unknown as SummaryAttemptIdentity);
  if (value.schemaVersion !== 2 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !['prepared','dispatched','streaming','completed','failed','interrupted','uncertain'].includes(value.state)
    || typeof value.cleanupConfirmed !== 'boolean' || !['pending','activated','discarded'].includes(value.publication) || textType !== 'text' || typeof value.partialTextTruncated !== 'boolean'
    || !Number.isSafeInteger(value.observedOutputBytes) || value.observedOutputBytes < 0 || !Number.isSafeInteger(value.retainedTextBytes) || value.retainedTextBytes < 0 || value.retainedTextBytes > 65536
    || !Number.isSafeInteger(textBytes) || textBytes !== value.retainedTextBytes || value.retainedTextBytes > value.observedOutputBytes) fail('INVALID_SUMMARY_RECORD', 'Stored summary state or retained byte counters are invalid');
  for (const key of ['createdAt','updatedAt','dispatchedAt','firstObservationAt','providerCompletedAt','completedAt'] as const) if ((key === 'createdAt' || key === 'updatedAt' || value[key] !== undefined) && (typeof value[key] !== 'string' || value[key]!.length > 64 || !Number.isFinite(Date.parse(value[key]!)))) fail('INVALID_SUMMARY_RECORD', 'Stored summary timestamp is invalid');
  for (const key of ['providerRequestId','summaryRevisionId','contextRevisionId','errorCode'] as const) if (value[key] !== undefined && !id(value[key])) fail('INVALID_SUMMARY_RECORD', 'Stored summary metadata is invalid');
  if (value.finishReason !== undefined && !['stop','length','tool_calls'].includes(value.finishReason)) fail('INVALID_SUMMARY_RECORD', 'Stored summary finish reason is invalid');
  if (value.uncertainty !== undefined) { plain(value.uncertainty, ['kind','requiresRecovery']); if (value.uncertainty.kind !== 'provider_dispatch' || value.uncertainty.requiresRecovery !== true || value.state !== 'uncertain') fail('INVALID_SUMMARY_RECORD', 'Summary uncertainty is inconsistent'); }
  if (terminal.has(value.state) !== !!value.completedAt || value.state === 'completed' && (value.publication !== 'activated' || !value.providerCompletedAt || !value.cleanupConfirmed || !value.summaryRevisionId || value.partialTextTruncated)
    || !terminal.has(value.state) && value.publication !== 'pending' || ['failed','interrupted','uncertain'].includes(value.state) && value.publication !== 'discarded') fail('INVALID_SUMMARY_RECORD', 'Stored summary publication state is inconsistent');
}
function validateRecord(value: SummaryAttemptRecord): void { validateMetadata(value, typeof value.partialText === 'string' ? 'text' : 'invalid', typeof value.partialText === 'string' ? Buffer.byteLength(value.partialText) : -1); }
function usageMerge(previous: SummaryUsageSnapshot, supplied: Partial<SummaryUsageSnapshot>): SummaryUsageSnapshot {
  plain(supplied, keys);
  const merged = { ...previous };
  for (const key of keys) if (supplied[key] !== undefined && supplied[key] !== null) {
    const count = supplied[key]!; if (!Number.isSafeInteger(count) || count < 0 || previous[key] !== null && count < previous[key]!) fail('SUMMARY_USAGE_REGRESSION', 'Summary token observations must be nonnegative and nondecreasing'); merged[key] = count;
  }
  if (merged.cachedInputTokens !== null && merged.inputTokens !== null && merged.cachedInputTokens > merged.inputTokens || merged.reasoningOutputTokens !== null && merged.outputTokens !== null && merged.reasoningOutputTokens > merged.outputTokens) fail('INVALID_SUMMARY_USAGE', 'Summary breakdowns exceed inclusive totals');
  return merged;
}
/** Typed summaries never acquire a provider_attempts row or consume an ordinary Turn. */
export class SummaryAttemptStorage {
  constructor(private readonly native: NativeSessionStorage, private readonly append: (run: Run, type: string, payload: JsonObject) => EngineEvent) {}
  private get db() { return this.native.database; }
  private emit(record: SummaryAttemptRecord, type: string, payload: JsonObject): void {
    const event = this.native.appendEvent(record.sessionId, type, payload, { runId: record.runId }); this.append(this.native.scopeRun(record.sessionId, record.runId), type, event.payload);
  }
  private owner(record: SummaryAttemptMetadata): Run {
    const header = this.db.prepare('SELECT r.session_id,r.workspace_id,s.workspace_id AS session_workspace_id FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.id=?').get(record.runId);
    if (header?.session_id !== record.sessionId || header.workspace_id !== record.workspaceId || header.session_workspace_id !== record.workspaceId) fail('SUMMARY_BINDING_MISMATCH', 'Summary owner metadata does not match its Run and session');
    const run = this.native.scopeRun(record.sessionId, record.runId), session = this.native.hooks.session(record.sessionId);
    const columns = this.db.prepare('SELECT session_id,workspace_id FROM runs WHERE id=?').get(record.runId);
    if (columns?.session_id !== record.sessionId || columns.workspace_id !== record.workspaceId || record.workspaceId !== run.workspaceId || session.workspaceId !== run.workspaceId || record.providerId !== run.config.providerId || record.modelId !== run.config.modelId) fail('SUMMARY_BINDING_MISMATCH', 'Summary owner does not match its Run provider and workspace');
    return run;
  }
  private save(record: SummaryAttemptRecord): void {
    validateRecord(record);
    const encoded = JSON.stringify(record); if (Buffer.byteLength(encoded) > 524288) fail('SUMMARY_RECORD_LIMIT', 'Summary record exceeds its serialized byte budget');
    invalidateEvidenceRead(this.db);
    this.db.prepare('INSERT INTO summary_attempts(id,session_id,workspace_id,run_id,scope,state,revision,data) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,revision=excluded.revision,data=excluded.data')
      .run(record.id, record.sessionId, record.workspaceId, record.runId, record.scope, record.state, record.revision, encoded);
  }
  get(idValue: string, expectedSessionId?: string): SummaryAttemptRecord {
    return this.read(idValue, expectedSessionId).record;
  }
  private read(idValue: string, expectedSessionId?: string): { record: SummaryAttemptRecord; run: Run } {
    this.native.hooks.assertOpen(); if (!id(idValue)) fail('INVALID_SUMMARY_RECORD', 'Summary attempt ID is invalid');
    const row = this.db.prepare('SELECT session_id,workspace_id,run_id,scope,state,CASE WHEN revision BETWEEN 1 AND 9007199254740991 THEN revision ELSE 0 END AS revision,length(CAST(data AS BLOB)) AS bytes FROM summary_attempts WHERE id=?').get(idValue);
    if (!row) fail('SUMMARY_ATTEMPT_NOT_FOUND', 'Summary attempt was not found');
    if (expectedSessionId !== undefined && row.session_id !== expectedSessionId) fail('SUMMARY_BINDING_MISMATCH', 'Summary attempt belongs to another session');
    if (Number(row.bytes) > 524288) fail('SUMMARY_RECORD_LIMIT', 'Stored summary exceeds its read bound');
    const record = JSON.parse(String(readEvidenceBody(this.db, { table: 'summary_attempts', key: idValue }, { expectedBytes: Number(row.bytes), maxBytes: 524288 }))) as SummaryAttemptRecord;
    if (record.id !== idValue || record.sessionId !== row.session_id || record.workspaceId !== row.workspace_id || record.runId !== row.run_id || record.scope !== row.scope || record.state !== row.state || record.revision !== row.revision || record.schemaVersion !== 2) fail('SUMMARY_BINDING_MISMATCH', 'Summary payload and SQL owner differ');
    validateRecord(record); return { record, run: this.owner(record) };
  }
  /** Full identity/status/proof validation, with text type/UTF8 length checked in SQL. */
  private metadata(idValue: string, expectedSessionId?: string): SummaryAttemptMetadata {
    this.native.hooks.assertOpen(); if (!id(idValue)) fail('INVALID_SUMMARY_RECORD', 'Summary attempt ID is invalid');
    const row = this.db.prepare(`SELECT session_id,workspace_id,run_id,scope,state,
      CASE WHEN revision BETWEEN 1 AND 9007199254740991 THEN revision ELSE 0 END AS revision,
      length(CAST(data AS BLOB)) AS bytes FROM summary_attempts WHERE id=?`).get(idValue);
    if (!row) fail('SUMMARY_ATTEMPT_NOT_FOUND', 'Summary attempt was not found');
    if (expectedSessionId !== undefined && row.session_id !== expectedSessionId) fail('SUMMARY_BINDING_MISMATCH', 'Summary attempt belongs to another session');
    // Identity is capped at 64KiB; 16KiB additionally covers status/proof fields.
    if (Number(row.bytes) > 524288) fail('SUMMARY_RECORD_LIMIT', 'Stored summary exceeds its read bound');
    const projected = this.db.prepare(`SELECT json_type(data,'$.partialText') AS text_type,
      length(CAST(json_extract(data,'$.partialText') AS BLOB)) AS text_bytes,
      json_type(json_remove(data,'$.partialText'),'$.partialText') AS remaining_text_type,
      length(CAST(json_remove(data,'$.partialText') AS BLOB)) AS metadata_bytes FROM summary_attempts WHERE id=?`).get(idValue);
    if (Number(projected?.metadata_bytes) > 81920) fail('SUMMARY_RECORD_LIMIT', 'Stored summary metadata exceeds its read bound');
    if (projected?.text_type !== 'text' || !Number.isSafeInteger(projected.text_bytes) || Number(projected.text_bytes) > 65536 || projected.remaining_text_type !== null) fail('INVALID_SUMMARY_RECORD', 'Stored summary retained text is invalid');
    const raw = readEvidenceBody(this.db, { table: 'summary_attempts', key: idValue, projection: 'summary-metadata-v1' }, { expectedBytes: Number(projected?.metadata_bytes), maxBytes: 81920 });
    if (typeof raw !== 'string') fail('SUMMARY_RECORD_LIMIT', 'Stored summary metadata exceeds its read bound');
    const record = JSON.parse(raw) as SummaryAttemptMetadata;
    if (Object.hasOwn(record, 'partialText')) fail('INVALID_SUMMARY_RECORD', 'Summary metadata must not contain retained text');
    if (record.id !== idValue || record.sessionId !== row.session_id || record.workspaceId !== row.workspace_id || record.runId !== row.run_id || record.scope !== row.scope || record.state !== row.state || record.revision !== row.revision || record.schemaVersion !== 2) fail('SUMMARY_BINDING_MISMATCH', 'Summary payload and SQL owner differ');
    validateMetadata(record, String(projected.text_type), Number(projected.text_bytes)); this.owner(record); return record;
  }
  /** Validate once within the shared transaction, without a pre-transaction full read. */
  private update(idValue: string, operation: (record: SummaryAttemptRecord, run: Run) => SummaryAttemptRecord): SummaryAttemptRecord {
    this.native.hooks.assertOpen();
    if (this.db.isTransaction) { const owned = this.read(idValue); return operation(owned.record, owned.run); }
    let sessionId = '', changed = false;
    const result = this.native.hooks.transaction(() => { const owned = this.read(idValue); sessionId = owned.record.sessionId; const next = operation(owned.record, owned.run); changed = next.revision !== owned.record.revision; return next; });
    if (changed) this.native.hooks.notify(sessionId);
    return result;
  }
  getUsage(idValue: string, expectedSessionId?: string): SummaryUsageRecord | null {
    return this.usageFor(this.metadata(idValue, expectedSessionId));
  }
  private usageFor(attempt: SummaryAttemptMetadata): SummaryUsageRecord | null {
    const idValue = attempt.id, row = this.db.prepare('SELECT session_id,run_id,CASE WHEN revision BETWEEN 1 AND 9007199254740991 THEN revision ELSE 0 END AS revision,length(CAST(data AS BLOB)) AS bytes FROM summary_usage WHERE summary_attempt_id=?').get(idValue);
    if (!row) return null;
    if (row.session_id !== attempt.sessionId || row.run_id !== attempt.runId || Number(row.bytes) > 4096) fail('SUMMARY_BINDING_MISMATCH', 'Summary usage owner or size is invalid');
    const record = JSON.parse(String(readEvidenceBody(this.db, { table: 'summary_usage', key: idValue }, { expectedBytes: Number(row.bytes), maxBytes: 4096 }))) as SummaryUsageRecord;
    if (record.summaryAttemptId !== idValue || record.sessionId !== row.session_id || record.runId !== row.run_id || record.revision !== row.revision) fail('SUMMARY_BINDING_MISMATCH', 'Summary usage payload and SQL owner differ');
    plain(record, ['summaryAttemptId','sessionId','runId','revision','usage','observedAt']);
    if (!Number.isSafeInteger(record.revision) || record.revision < 1 || typeof record.observedAt !== 'string' || !Number.isFinite(Date.parse(record.observedAt)) || keys.some(key => !Object.hasOwn(record.usage, key))) fail('INVALID_SUMMARY_USAGE','Stored usage record is invalid');
    usageMerge(unknownUsage(), record.usage); return record;
  }
  create(value: SummaryAttemptIdentity): SummaryAttemptRecord {
    const supplied = identity(value);
    return this.native.write(supplied.sessionId, () => {
      const existing = this.db.prepare('SELECT id FROM summary_attempts WHERE id=?').get(supplied.id);
      if (existing) {
        const previous = this.get(supplied.id); for (const key of identityKeys) if (key !== 'createdAt' || supplied.createdAt !== undefined) if (JSON.stringify(previous[key as keyof SummaryAttemptRecord]) !== JSON.stringify(supplied[key as keyof SummaryAttemptIdentity])) fail('SUMMARY_IDENTITY_CONFLICT', 'Exact summary identity cannot change'); return previous;
      }
      const now = new Date().toISOString();
      const record: SummaryAttemptRecord = { ...supplied, schemaVersion: 2, revision: 1, state: 'prepared', createdAt: supplied.createdAt ?? now, updatedAt: now, cleanupConfirmed: true,
        publication: 'pending', observedOutputBytes: 0, retainedTextBytes: 0, partialText: '', partialTextTruncated: false };
      if (this.owner(record).state !== 'running') fail('SUMMARY_OWNER_REQUIRED', 'Summary preparation requires a running Run');
      this.save(record); this.emit(record, 'summary.prepared', { ...json(supplied), summaryAttemptId: record.id, factsSha256: record.sourceSha256 }); return record;
    });
  }
  dispatch(idValue: string): SummaryAttemptRecord {
    return this.update(idValue, (record, run) => {
      if (record.state !== 'prepared' || run.state !== 'running') fail('SUMMARY_TRANSITION_INVALID', 'Summary dispatch requires a prepared live owner');
      const next = { ...record, state: 'dispatched' as const, revision: record.revision + 1, updatedAt: new Date().toISOString(), dispatchedAt: new Date().toISOString(), cleanupConfirmed: false };
      this.save(next); this.emit(next, 'summary.dispatched', { summaryAttemptId: idValue, scope: next.scope, providerId: next.providerId, modelId: next.modelId }); return next;
    });
  }
  observe(idValue: string, supplied: SummaryObservation): SummaryAttemptRecord {
    plain(supplied, ['textDelta', 'usage', 'providerRequestId', 'finishReason']);
    if (supplied.textDelta !== undefined && typeof supplied.textDelta !== 'string' || supplied.providerRequestId !== undefined && !id(supplied.providerRequestId) || supplied.finishReason !== undefined && !['stop', 'length', 'tool_calls'].includes(supplied.finishReason)) fail('INVALID_SUMMARY_RECORD', 'Summary observation has invalid fields');
    return this.update(idValue, record => {
      const priorUsage = this.usageFor(record), usage = supplied.usage === undefined ? priorUsage?.usage ?? unknownUsage() : usageMerge(priorUsage?.usage ?? unknownUsage(), supplied.usage);
      const usageChanged = JSON.stringify(usage) !== JSON.stringify(priorUsage?.usage ?? unknownUsage());
      if (terminal.has(record.state) || record.providerCompletedAt) {
        if (usageChanged || supplied.usage === undefined || Object.keys(supplied).some(key => key !== 'usage')) fail('SUMMARY_ATTEMPT_IMMUTABLE', 'Settled provider observations cannot change'); return record;
      }
      if (!['dispatched', 'streaming'].includes(record.state)) fail('SUMMARY_TRANSITION_INVALID', 'Only dispatched summaries accept provider observations');
      if (record.providerRequestId && supplied.providerRequestId && record.providerRequestId !== supplied.providerRequestId || record.finishReason && supplied.finishReason && record.finishReason !== supplied.finishReason || record.finishReason && supplied.textDelta) fail('SUMMARY_PROTOCOL_ERROR', 'Provider request or completed text identity changed');
      if (record.state === 'streaming' && !usageChanged && !supplied.textDelta && (supplied.providerRequestId === undefined || supplied.providerRequestId === record.providerRequestId)
        && (supplied.finishReason === undefined || supplied.finishReason === record.finishReason)) return record;
      const now = new Date().toISOString(), next: SummaryAttemptRecord = { ...record, state: 'streaming', firstObservationAt: record.firstObservationAt ?? now, updatedAt: now, revision: record.revision + 1 };
      if (supplied.textDelta !== undefined) {
        const bytes = Buffer.byteLength(supplied.textDelta); if (!Number.isSafeInteger(next.observedOutputBytes + bytes)) fail('SUMMARY_OUTPUT_BYTES_EXHAUSTED', 'Observed summary bytes exhausted safe integers'); next.observedOutputBytes += bytes;
        const remaining = 65536 - next.retainedTextBytes;
        next.partialText += prefix(supplied.textDelta, remaining); next.retainedTextBytes = Buffer.byteLength(next.partialText); next.partialTextTruncated ||= bytes > remaining;
      }
      if (supplied.providerRequestId) next.providerRequestId = supplied.providerRequestId;
      if (supplied.finishReason) next.finishReason = supplied.finishReason;
      if (usageChanged) {
        if ((priorUsage?.revision ?? 0) >= Number.MAX_SAFE_INTEGER) fail('SUMMARY_USAGE_REVISION_EXHAUSTED', 'Summary usage revision exceeded its safe integer range');
        const observation: SummaryUsageRecord = { summaryAttemptId: idValue, sessionId: record.sessionId, runId: record.runId, revision: (priorUsage?.revision ?? 0) + 1, usage, observedAt: now };
        invalidateEvidenceRead(this.db);
        this.db.prepare('INSERT INTO summary_usage(summary_attempt_id,session_id,run_id,revision,data) VALUES(?,?,?,?,?) ON CONFLICT(summary_attempt_id) DO UPDATE SET revision=excluded.revision,data=excluded.data')
          .run(idValue, record.sessionId, record.runId, observation.revision, JSON.stringify(observation));
        this.emit(next, 'provider.usage', { purpose: 'summary', summaryAttemptId: idValue, scope: record.scope, ...json(usage) });
      }
      this.save(next); if (record.state === 'dispatched') this.emit(next, 'summary.streaming', { summaryAttemptId: idValue, scope: record.scope }); return next;
    });
  }
  providerCompleted(idValue: string): SummaryAttemptRecord {
    return this.update(idValue, record => {
      if (record.providerCompletedAt) return record;
      if (record.state !== 'streaming' || record.finishReason !== 'stop' || !record.partialText.trim() || record.partialTextTruncated) fail('SUMMARY_PROTOCOL_ERROR', 'Provider completion requires a complete nonempty retained stop response');
      const next = { ...record, revision: record.revision + 1, updatedAt: new Date().toISOString(), providerCompletedAt: new Date().toISOString(), cleanupConfirmed: true };
      this.save(next); this.emit(next, 'summary.provider_completed', { summaryAttemptId: idValue, scope: record.scope, cleanupConfirmed: true }); return next;
    });
  }
  settle(idValue: string, supplied: SummarySettlement): SummaryAttemptRecord {
    plain(supplied, ['state', 'errorCode', 'cleanupConfirmed']);
    if (!['failed', 'interrupted', 'uncertain'].includes(supplied.state) || typeof supplied.cleanupConfirmed !== 'boolean' || supplied.errorCode !== undefined && !id(supplied.errorCode)
      || supplied.state !== 'uncertain' && !supplied.cleanupConfirmed) fail('INVALID_SUMMARY_RECORD', 'Terminal summary outcome requires honest cleanup proof');
    return this.update(idValue, record => {
      if (terminal.has(record.state)) { if (record.state !== supplied.state || record.cleanupConfirmed !== supplied.cleanupConfirmed || record.errorCode !== supplied.errorCode) fail('SUMMARY_ATTEMPT_IMMUTABLE', 'Terminal summaries are immutable'); return record; }
      const now = new Date().toISOString(), next: SummaryAttemptRecord = { ...record, ...supplied, publication: 'discarded', revision: record.revision + 1, updatedAt: now, completedAt: now,
        ...(supplied.state === 'uncertain' ? { uncertainty: { kind: 'provider_dispatch' as const, requiresRecovery: true as const } } : {}) };
      this.save(next); this.emit(next, `summary.${next.state}`, { summaryAttemptId: idValue, scope: record.scope, code: next.errorCode ?? 'SUMMARY_FAILED', cleanupConfirmed: next.cleanupConfirmed });
      if (next.state === 'uncertain') this.native.setControlInTransaction(record.sessionId, true, 'recovery_required'); return next;
    });
  }
  completeInTransaction(runId: string, idValue: string, scope: SummaryAttemptIdentity['scope'], revisionId: string, text: string, usage: unknown, binding: Partial<SummaryAttemptIdentity>, contextRevisionId?: string): void {
    if (!this.db.isTransaction) fail('STORAGE_TRANSACTION_REQUIRED', 'Summary activation shares its checkpoint transaction');
    // Legacy journals are retained without claiming a typed backfill. Updated services always prepare a typed record.
    if (!this.db.prepare('SELECT 1 FROM summary_attempts WHERE id=?').get(idValue)) return;
    const { record, run } = this.read(idValue), actualUsage = this.usageFor(record)?.usage ?? unknownUsage();
    const suppliedUsage = usage as SummaryUsageSnapshot; usageMerge(unknownUsage(), suppliedUsage);
    if (record.runId !== runId || record.scope !== scope || record.state !== 'streaming' || !record.providerCompletedAt || !record.cleanupConfirmed || record.partialTextTruncated || record.partialText !== text
      || run.state !== 'running' || keys.some(key => !Object.hasOwn(suppliedUsage,key) || suppliedUsage[key] !== actualUsage[key])
      || Object.entries(binding).some(([key,value]) => JSON.stringify(record[key as keyof SummaryAttemptRecord]) !== JSON.stringify(value))) fail('SUMMARY_BINDING_MISMATCH', 'Checkpoint does not match a completed owned summary provider observation');
    const now = new Date().toISOString(); this.save({ ...record, state: 'completed', publication: 'activated', revision: record.revision + 1, updatedAt: now, completedAt: now, summaryRevisionId: revisionId,
      ...(contextRevisionId ? { contextRevisionId } : {}) });
  }
  recoverInTransaction(sessions: Set<string>): void {
    for (;;) {
      const page = this.db.prepare("SELECT id FROM summary_attempts WHERE state IN ('prepared','dispatched','streaming') ORDER BY rowid LIMIT 128").all();
      if (!page.length) return;
      for (const row of page) { const record = this.get(String(row.id)), confirmed = record.state === 'prepared' || !!record.providerCompletedAt && record.cleanupConfirmed;
        this.settle(record.id, { state: confirmed ? 'interrupted' : 'uncertain', errorCode: confirmed ? 'SUMMARY_INTERRUPTED' : 'SUMMARY_RECOVERY_UNCERTAIN', cleanupConfirmed: confirmed }); sessions.add(record.sessionId); }
    }
  }
  list(sessionId: string, supplied: SummaryAttemptListOptions = {}): SummaryAttemptPage {
    plain(supplied, ['afterId', 'runId', 'limit']); this.native.hooks.session(sessionId);
    const count = supplied.limit ?? 50; if (!Number.isSafeInteger(count) || count < 1 || count > 100) fail('INVALID_PAGE_SIZE', 'Summary page size must be between 1 and 100');
    if (supplied.runId) this.native.scopeRun(sessionId, supplied.runId);
    let after = '0';
    if (supplied.afterId) {
      const previous = this.db.prepare('SELECT session_id,run_id,CAST(rowid AS TEXT) AS position FROM summary_attempts WHERE id=?').get(supplied.afterId);
      if (!previous || previous.session_id !== sessionId || supplied.runId && previous.run_id !== supplied.runId) fail('INVALID_SUMMARY_CURSOR', 'Summary cursor belongs to another owner'); after = String(previous.position);
    }
    const metadata = this.db.prepare('SELECT id,length(CAST(data AS BLOB)) AS bytes FROM summary_attempts WHERE session_id=? AND (? IS NULL OR run_id=?) AND rowid>CAST(? AS INTEGER) ORDER BY rowid LIMIT ?').all(sessionId, supplied.runId ?? null, supplied.runId ?? null, after, count + 1);
    // Includes the envelope and an escaped bounded cursor, not only record payloads.
    const attempts: SummaryAttemptRecord[] = []; let bytes = 1024;
    for (const row of metadata.slice(0, count)) { if (Number(row.bytes) > 524288) fail('SUMMARY_RECORD_LIMIT', 'One summary exceeds its read limit'); if (bytes + Number(row.bytes) + 1 > 1048576) break; const record = this.get(String(row.id), sessionId); attempts.push(record); bytes += Number(row.bytes) + 1; }
    return { attempts, nextCursor: metadata.length > attempts.length ? attempts.at(-1)?.id ?? null : null };
  }
}
