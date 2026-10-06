import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { EngineError, isTerminal, type EngineEvent, type JsonObject, type Run } from '@moodcode/contracts';
import type { NativeSessionStorage } from '../storage/native.js';
import type { SummaryAttemptRecord, SummaryAttemptStorage } from '../storage/summary-attempts.js';
import { canonical } from './snapshot.js';

export const SUMMARY_RECOVERY_TABLES = ['summary_recovery_acknowledgments'] as const;
export const SUMMARY_RECOVERY_SCHEMA = `CREATE TABLE summary_recovery_acknowledgments (
  id TEXT PRIMARY KEY, summary_attempt_id TEXT NOT NULL REFERENCES summary_attempts(id),
  session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), run_id TEXT NOT NULL REFERENCES runs(id),
  request_id TEXT NOT NULL, binding_scope TEXT NOT NULL CHECK(length(binding_scope)=64), attempt_revision INTEGER NOT NULL CHECK(attempt_revision>0),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64), record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64),
  usage_sha256 TEXT, source_owner_sha256 TEXT NOT NULL CHECK(length(source_owner_sha256)=64),
  data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),
  UNIQUE(binding_scope,workspace_id,request_id), UNIQUE(binding_scope,summary_attempt_id)
) STRICT;
CREATE INDEX summary_recovery_workspace ON summary_recovery_acknowledgments(workspace_id,binding_scope);`;
export const SUMMARY_RECOVERY_LIMITS = Object.freeze({ maxCandidates: 64, maxMessages: 512, maxTurns: 128, maxSourceBytes: 2097152, maxInspectionBytes: 8388608, maxLedgerBytes: 65536 });
export interface SummaryRecoveryRequest { sessionId: string; summaryAttemptId: string; requestId: string; fingerprint: string; acknowledged: true }
export interface SummaryRecoveryReceipt {
  version: 1; id: string; requestId: string; sessionId: string; workspaceId: string; runId: string; summaryAttemptId: string;
  fingerprint: string; bindingScope: string; acknowledgedAt: string; state: 'uncertain'; cleanupConfirmed: false; publication: 'discarded';
  providerRetried: false; checkpointActivated: false; executionResumed: false; duplicate: boolean;
}
export interface SummaryRecoveryPreview {
  version: 1; status: 'eligible' | 'acknowledged' | 'blocked'; fingerprint: string | null; blockers: string[];
  sessionId: string; workspaceId: string; runId: string; summaryAttemptId: string; summaryScope: SummaryAttemptRecord['scope'];
  attemptRevision: number; recordSha256: string; usageSha256: string | null; sourceSha256: string; requestSha256: string;
  bindingScope: string; sourceOwnerSha256: string | null; contextBaselineSha256: string | null; acknowledgment?: SummaryRecoveryReceipt;
}
interface Pin { table: 'messages' | 'context_revisions'; id: string; sha256: string }
interface Audit { receipt: SummaryRecoveryReceipt; attemptRevision: number; recordSha256: string; usageSha256: string | null; sourceOwnerSha256: string; pins: Pin[]; contextBaselineSha256: string }
interface Budget { bytes: number; max: number }
interface Evidence { recordSha256: string; usageSha256: string | null; sourceOwnerSha256: string }
type Row = Record<string, unknown>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => sha(canonical(value));
const validSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
function fail(suffix: string, message: string): never { throw new EngineError(`SUMMARY_RECOVERY_${suffix}`, message); }
function plain(value: unknown, keys?: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_REQUEST', 'Summary recovery accepts plain data only');
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || keys && !keys.includes(key) || !property?.enumerable || !('value' in property)) fail('INVALID_REQUEST', 'Summary recovery rejects accessors and unknown fields');
  }
}
export function validateSummaryRecoveryRequest(value: unknown): SummaryRecoveryRequest {
  plain(value, ['sessionId', 'summaryAttemptId', 'requestId', 'fingerprint', 'acknowledged']);
  if (value.acknowledged !== true) fail('ACKNOWLEDGMENT_REQUIRED', 'Explicit acknowledgment of this exact preview is required');
  if (!identifier(value.sessionId) || !identifier(value.summaryAttemptId) || !identifier(value.requestId) || !validSha(value.fingerprint)) fail('INVALID_REQUEST', 'Summary recovery requires bounded owner and request identities');
  return { sessionId: value.sessionId, summaryAttemptId: value.summaryAttemptId, requestId: value.requestId, fingerprint: value.fingerprint, acknowledged: true };
}
export function captureSummaryRecoveryHighWater(db: DatabaseSync): string {
  return String(db.prepare('SELECT CAST(coalesce(max(rowid),0) AS TEXT) AS ordinal FROM summary_attempts').get()!.ordinal);
}
function charge(budget: Budget, bytes: number): void { if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.max - budget.bytes) fail('LIMIT', 'Summary recovery exceeds its bounded evidence budget'); budget.bytes += bytes; }
function parse(text: string): JsonObject { try { return JSON.parse(text) as JsonObject; } catch { return fail('SOURCE_CHANGED', 'Pinned recovery evidence is not valid JSON'); } }
const columns: Record<string, string> = {
  messages: 'id,session_id,run_id,CAST(ordinal AS TEXT) AS ordinal', runs: 'id,session_id,workspace_id,state',
  session_turns: 'id,session_id,run_id,turn_index,state', provider_attempts: 'id,session_id,run_id,turn_id,attempt_index,state',
  message_parts: 'id,session_id,run_id,turn_id,message_id,part_index,revision,state', tools: 'id,session_id,run_id,state',
  context_revisions: 'id,session_id,run_id,turn_id,CAST(revision AS TEXT) AS revision,supersedes_id',
};
function record(db: DatabaseSync, table: string, id: string, budget: Budget): { row: Row; data: JsonObject; sha256: string } {
  const row = db.prepare(`SELECT ${columns[table]},length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE id=?`).get(id);
  if (!row) fail('SOURCE_CHANGED', 'Pinned evidence no longer exists');
  charge(budget, Number(row.bytes));
  const data = parse(String(db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id)!.data));
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.id !== id || data.sessionId !== row.session_id
    || table !== 'runs' && table !== 'context_revisions' && data.runId !== row.run_id
    || table === 'runs' && (data.workspaceId !== row.workspace_id || data.state !== row.state)
    || table === 'context_revisions' && (data.runId ?? null) !== row.run_id
    || table === 'context_revisions' && ((data.turnId ?? null) !== row.turn_id || Number(data.revision) !== Number(row.revision))
    || ['session_turns','provider_attempts','message_parts','tools'].includes(table) && data.state !== row.state
    || ['provider_attempts','message_parts'].includes(table) && data.turnId !== row.turn_id
    || table === 'message_parts' && (data.messageId !== row.message_id || data.index !== row.part_index || data.revision !== row.revision)
    || table === 'session_turns' && data.index !== row.turn_index || table === 'provider_attempts' && data.index !== row.attempt_index) fail('SOURCE_CHANGED', 'Pinned payload and SQL owner disagree');
  if (table === 'messages' && (!Number.isSafeInteger(Number(row.ordinal)) || Number(row.ordinal) < 1)) fail('SOURCE_CHANGED', 'Pinned message ordinal is unsafe');
  return { row, data, sha256: digest({ row: { ...row, bytes: undefined }, data }) };
}
function ids(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || !value.length || value.length > maximum || new Set(value).size !== value.length || !value.every(identifier)) fail('LIMIT', 'Summary recovery requires bounded exact source identities');
  return value as string[];
}
function owned(data: JsonObject, sessionId: string, runId?: string): void { if (data.sessionId !== sessionId || runId !== undefined && data.runId !== runId) fail('OWNER_MISMATCH', 'Summary source belongs to another owner'); }
function projection(data: JsonObject, row: Row): JsonObject {
  const fact: JsonObject = { id: data.id!, sessionId: data.sessionId!, runId: data.runId!, ordinal: Number(row.ordinal), role: data.role!, content: data.content! };
  for (const key of ['toolCalls','toolCallId','toolResult']) if (data[key] !== undefined && data[key] !== null) fact[key] = data[key]!;
  return fact;
}

/** Explicit host decisions waive a persisted summary blocker; they never establish cleanup or activate memory. */
export class SummaryRecoveryStorage {
  constructor(private readonly native: NativeSessionStorage, private readonly summaries: SummaryAttemptStorage, private readonly options: {
    bindingScope(workspaceId: string): string; startupHighWater: string; appendLegacy(run: Run, type: string, payload: JsonObject): EngineEvent;
  }) { if (!/^(0|[1-9][0-9]{0,18})$/u.test(options.startupHighWater)) fail('INVALID_REQUEST', 'Recovery requires the original boot frontier'); }
  private get db() { return this.native.database; }
  private read<T>(operation: () => T): T {
    this.native.hooks.assertOpen(); if (this.db.isTransaction) return operation();
    this.db.exec('BEGIN'); try { const result = operation(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private scope(workspaceId: string): string { const scope = this.options.bindingScope(workspaceId); if (!validSha(scope)) fail('BINDING_CHANGED', 'Recovery requires an unchanged physical host binding'); return scope; }
  private attempt(sessionId: string, id: string): SummaryAttemptRecord {
    this.native.hooks.session(sessionId); const row = this.db.prepare('SELECT session_id FROM summary_attempts WHERE id=?').get(id);
    if (row && row.session_id !== sessionId) fail('OWNER_MISMATCH', 'Summary belongs to another session');
    return this.summaries.get(id, sessionId);
  }
  private source(recordValue: SummaryAttemptRecord, budget: Budget): string {
    const owner = this.native.scopeRun(recordValue.sessionId, recordValue.runId);
    const pins: unknown[] = [record(this.db, 'runs', owner.id, budget).sha256];
    const messages = ids(recordValue.sourceMessageIds, SUMMARY_RECOVERY_LIMITS.maxMessages).map(id => record(this.db, 'messages', id, budget));
    const runIds = recordValue.scope === 'active-run-prefix' ? [owner.id] : ids(recordValue.sourceRunIds, SUMMARY_RECOVERY_LIMITS.maxTurns);
    const allowed = new Set(runIds);
    for (const id of runIds) { const sourceRun = record(this.db, 'runs', id, budget); if (sourceRun.data.sessionId !== recordValue.sessionId || sourceRun.data.workspaceId !== recordValue.workspaceId
      || !isTerminal(sourceRun.data.state as Run['state'])) fail('OWNER_MISMATCH', 'Summary source Run is not a settled matching owner'); pins.push(sourceRun.sha256); }
    for (const item of messages) {
      owned(item.data, recordValue.sessionId); if (!allowed.has(String(item.data.runId)) || typeof item.data.content !== 'string' || !['user','assistant','tool'].includes(String(item.data.role))
        || Array.isArray(item.data.attachments) && item.data.attachments.length) fail('SOURCE_CHANGED', 'Summary source is not exact text-only owned history'); pins.push(item.sha256);
    }
    if (messages.some((item, index) => index > 0 && Number(item.row.ordinal) <= Number(messages[index - 1]!.row.ordinal))) fail('SOURCE_CHANGED', 'Summary source chronology changed');
    let source: string;
    if (recordValue.scope === 'completed-history') {
      if (recordValue.sourceProjection !== 'conversation-text-v1') fail('SOURCE_CHANGED', 'Summary source projection is unsupported');
      source = JSON.stringify(messages.map(({ data }) => ({ id: data.id, runId: data.runId, role: data.role, content: data.content })));
    } else {
      if (recordValue.sourceProjection !== 'text-and-complete-tool-observations-v1') fail('SOURCE_CHANGED', 'Summary source projection is unsupported');
      const turnIds = ids(recordValue.sourceTurnIds, SUMMARY_RECOVERY_LIMITS.maxTurns), facts = messages.map(item => projection(item.data, item.row));
      for (const turnId of turnIds) {
        const turn = record(this.db, 'session_turns', turnId, budget); owned(turn.data, owner.sessionId, owner.id);
        const attemptId = this.db.prepare('SELECT id FROM provider_attempts WHERE turn_id=? ORDER BY attempt_index DESC LIMIT 1').get(turnId)?.id;
        if (!attemptId || turn.data.state !== 'completed') fail('SOURCE_CHANGED', 'Summary source Turn is not complete');
        const attempt = record(this.db, 'provider_attempts', String(attemptId), budget); owned(attempt.data, owner.sessionId, owner.id);
        if (attempt.data.state !== 'completed' || attempt.data.turnId !== turnId || attempt.data.providerId !== recordValue.providerId || attempt.data.modelId !== recordValue.modelId) fail('SOURCE_CHANGED', 'Summary source attempt owner changed');
        pins.push(turn.sha256, attempt.sha256);
        const headers = this.db.prepare('SELECT id FROM message_parts WHERE turn_id=? ORDER BY part_index LIMIT 129').all(turnId);
        if (headers.length > 128) fail('LIMIT', 'Summary source Parts exceed their read bound');
        const parts = headers.map(row => record(this.db, 'message_parts', String(row.id), budget));
        if (parts.some(part => !['completed','failed'].includes(String(part.data.state)) || part.data.type === 'media')) fail('SOURCE_CHANGED', 'Summary source includes unsettled Parts or media');
        for (const part of parts) { owned(part.data, owner.sessionId, owner.id); pins.push(part.sha256); }
        const assistantIds = new Set(parts.map(part => String(part.data.messageId)));
        const assistants = facts.filter(fact => fact.role === 'assistant' && assistantIds.has(String(fact.id)));
        if (assistants.length !== 1) fail('SOURCE_CHANGED', 'Source Turn must pin its whole assistant exchange');
        const assistant = assistants[0]!; assistant.turnId = turnId; assistant.attemptId = String(attemptId);
        const calls = Array.isArray(assistant.toolCalls) ? assistant.toolCalls as JsonObject[] : [];
        const toolParts = parts.filter(part => part.data.type === 'tool');
        if (calls.length !== toolParts.length) fail('SOURCE_CHANGED', 'Source tool proposals do not match their Parts');
        for (const part of toolParts) {
          if (part.data.messageId !== assistant.id || !identifier(part.data.toolCallId)) fail('SOURCE_CHANGED', 'Tool Part has a different message owner');
          const call = calls.filter(value => value.id === part.data.providerCallId), matching = facts.filter(fact => fact.role === 'tool' && fact.toolCallId === part.data.providerCallId && !fact.turnId);
          const assistantPosition = facts.indexOf(assistant), nextAssistant = facts.findIndex((fact, position) => position > assistantPosition && fact.role === 'assistant');
          const results = matching.filter(fact => facts.indexOf(fact) > assistantPosition && (nextAssistant < 0 || facts.indexOf(fact) < nextAssistant));
          if (call.length !== 1 || results.length !== 1 || call[0]!.name !== part.data.name || canonical(call[0]!.input) !== canonical(part.data.input)) fail('SOURCE_CHANGED', 'Tool call and result pairing changed');
          const fact = results[0]!, tool = record(this.db, 'tools', part.data.toolCallId, budget); owned(tool.data, owner.sessionId, owner.id); pins.push(tool.sha256);
          const result = part.data.result as JsonObject | undefined;
          if (!['completed','failed','denied'].includes(String(tool.data.state)) || tool.data.name !== part.data.name || canonical(tool.data.input) !== canonical(part.data.input)
            || tool.data.output !== fact.content || !result || result.output !== fact.content || (part.data.state === 'completed') !== (tool.data.state === 'completed')) fail('SOURCE_CHANGED', 'Tool observation changed from its settled owner');
          fact.turnId = turnId; fact.attemptId = String(attemptId); fact.internalToolCallId = part.data.toolCallId; fact.toolOutcome = tool.data.state!;
        }
      }
      if (facts.some(fact => fact.role !== 'user' && !fact.turnId)) fail('SOURCE_CHANGED', 'Pinned source splits an assistant/tool exchange');
      if (recordValue.boundaryTurnId) {
        const boundary = record(this.db, 'session_turns', recordValue.boundaryTurnId, budget); owned(boundary.data, owner.sessionId, owner.id);
        const attempt = record(this.db, 'provider_attempts', recordValue.boundaryAttemptId!, budget); owned(attempt.data, owner.sessionId, owner.id);
        if (boundary.data.state !== 'completed' || attempt.data.state !== 'completed' || attempt.data.turnId !== boundary.data.id) fail('SOURCE_CHANGED', 'The source completed boundary changed'); pins.push(boundary.sha256, attempt.sha256);
      }
      source = JSON.stringify({ version: 1, scope: 'active-run-prefix', projection: 'text-and-complete-tool-observations-v1', messages: facts });
    }
    if (Buffer.byteLength(source) > SUMMARY_RECOVERY_LIMITS.maxSourceBytes || sha(source) !== recordValue.sourceSha256) fail('SOURCE_CHANGED', 'Exact summary facts differ from their original digest');
    return digest(pins);
  }
  private evidence(attempt: SummaryAttemptRecord, budget: Budget): Evidence {
    charge(budget, Buffer.byteLength(JSON.stringify(attempt)));
    const usage = this.summaries.getUsage(attempt.id, attempt.sessionId); charge(budget, Buffer.byteLength(JSON.stringify(usage)));
    return { recordSha256: digest(attempt), usageSha256: usage ? digest(usage) : null, sourceOwnerSha256: this.source(attempt, budget) };
  }
  private baseline(sessionId: string, budget: Budget): { hash: string; pins: Pin[] } {
    const documents: unknown[] = [], pins: Pin[] = [];
    for (const kind of ['context.memory','context.active_memory','context.head']) {
      const row = this.db.prepare('SELECT CAST(revision AS TEXT) AS revision,length(CAST(data AS BLOB)) AS bytes FROM session_documents WHERE session_id=? AND kind=?').get(sessionId, kind);
      if (!row) { documents.push({ kind, absent: true }); continue; }
      if (!Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1 || Number(row.bytes) > 262144) fail('LIMIT', 'Context baseline metadata exceeds its bound');
      charge(budget, Number(row.bytes)); const data = parse(String(this.db.prepare('SELECT data FROM session_documents WHERE session_id=? AND kind=?').get(sessionId, kind)!.data));
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('SOURCE_CHANGED', 'Context baseline must contain JSON data');
      documents.push({ kind, revision: Number(row.revision), data });
      const active = data.active as JsonObject | undefined, id = kind === 'context.head' ? data.revisionId : active?.revisionId;
      if (id !== undefined) {
        if (!identifier(id)) fail('SOURCE_CHANGED', 'Context baseline has an invalid revision reference');
        const revision = record(this.db, 'context_revisions', id, budget); if (revision.data.sessionId !== sessionId || typeof revision.data.text !== 'string' || sha(revision.data.text) !== revision.data.sha256) fail('SOURCE_CHANGED', 'Context baseline revision owner or text changed');
        pins.push({ table: 'context_revisions', id, sha256: revision.sha256 });
        const sourceIds = revision.data.sourceIds;
        if (!Array.isArray(sourceIds) || sourceIds.length > 1024) fail('LIMIT', 'Immutable context source metadata exceeds its bound');
        for (const sourceId of sourceIds) if (typeof sourceId === 'string' && this.db.prepare('SELECT 1 FROM messages WHERE id=? LIMIT 1').get(sourceId)) {
          const message = record(this.db, 'messages', sourceId, budget); owned(message.data, sessionId);
          pins.push({ table: 'messages', id: sourceId, sha256: message.sha256 });
        }
      }
    }
    return { hash: digest(documents), pins: [...new Map(pins.map(pin => [`${pin.table}:${pin.id}`, pin])).values()] };
  }
  private audit(row: Row, budget: Budget): Audit {
    if (Number(row.bytes) > SUMMARY_RECOVERY_LIMITS.maxLedgerBytes) fail('LIMIT', 'Summary acknowledgment exceeds its read bound');
    charge(budget, Number(row.bytes));
    const data = parse(String(this.db.prepare('SELECT data FROM summary_recovery_acknowledgments WHERE id=?').get(String(row.id))!.data)) as unknown as Audit;
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('SOURCE_CHANGED', 'Summary acknowledgment must contain a bounded JSON object');
    const receipt = data.receipt;
    if (!receipt || receipt.version !== 1 || receipt.id !== row.id || receipt.summaryAttemptId !== row.summary_attempt_id || receipt.sessionId !== row.session_id || receipt.workspaceId !== row.workspace_id || receipt.runId !== row.run_id
      || receipt.requestId !== row.request_id || receipt.bindingScope !== row.binding_scope || receipt.fingerprint !== row.fingerprint || data.recordSha256 !== row.record_sha256 || data.usageSha256 !== row.usage_sha256 || data.sourceOwnerSha256 !== row.source_owner_sha256
      || !Number.isSafeInteger(data.attemptRevision) || data.attemptRevision < 1 || data.attemptRevision !== Number(row.attempt_revision)
      || receipt.state !== 'uncertain' || receipt.cleanupConfirmed !== false || receipt.publication !== 'discarded' || receipt.providerRetried !== false || receipt.checkpointActivated !== false || receipt.executionResumed !== false || receipt.duplicate !== false
      || !validSha(receipt.fingerprint) || !validSha(receipt.bindingScope) || ![receipt.id,receipt.requestId,receipt.sessionId,receipt.workspaceId,receipt.runId,receipt.summaryAttemptId].every(identifier)
      || typeof receipt.acknowledgedAt !== 'string' || Buffer.byteLength(receipt.acknowledgedAt)>64 || !Number.isFinite(Date.parse(receipt.acknowledgedAt)) || new Date(receipt.acknowledgedAt).toISOString() !== receipt.acknowledgedAt
      || !validSha(data.recordSha256) || data.usageSha256 !== null && !validSha(data.usageSha256) || !validSha(data.sourceOwnerSha256) || !validSha(data.contextBaselineSha256)
      || Object.keys(data).some(key => !['receipt','attemptRevision','recordSha256','usageSha256','sourceOwnerSha256','pins','contextBaselineSha256'].includes(key))
      || Object.keys(receipt).some(key => !['version','id','requestId','sessionId','workspaceId','runId','summaryAttemptId','fingerprint','bindingScope','acknowledgedAt','state','cleanupConfirmed','publication','providerRetried','checkpointActivated','executionResumed','duplicate'].includes(key))
      || !Array.isArray(data.pins) || data.pins.length > 1024 || data.pins.some(pin => !pin || typeof pin !== 'object' || !['messages','context_revisions'].includes(pin.table) || !identifier(pin.id) || !validSha(pin.sha256)
        || Object.keys(pin).some(key => !['table','id','sha256'].includes(key)))) fail('SOURCE_CHANGED', 'Summary acknowledgment payload and pinned SQL identity disagree');
    return data;
  }
  private ledger(where: string, ...parameters: string[]): Row | undefined {
    return this.db.prepare(`SELECT id,summary_attempt_id,session_id,workspace_id,run_id,request_id,binding_scope,CAST(attempt_revision AS TEXT) AS attempt_revision,fingerprint,record_sha256,usage_sha256,source_owner_sha256,length(CAST(data AS BLOB)) AS bytes FROM summary_recovery_acknowledgments WHERE ${where} LIMIT 1`).get(...parameters);
  }
  private valid(audit: Audit, attempt: SummaryAttemptRecord, evidence: Evidence, scope: string, budget: Budget): boolean {
    return audit.receipt.bindingScope === scope && audit.receipt.summaryAttemptId === attempt.id && audit.receipt.runId === attempt.runId && audit.receipt.sessionId === attempt.sessionId && audit.receipt.workspaceId === attempt.workspaceId
      && audit.attemptRevision === attempt.revision
      && audit.recordSha256 === evidence.recordSha256 && audit.usageSha256 === evidence.usageSha256 && audit.sourceOwnerSha256 === evidence.sourceOwnerSha256
      && audit.pins.every(pin => record(this.db, pin.table, pin.id, budget).sha256 === pin.sha256);
  }
  private previewInTransaction(sessionId: string, id: string): SummaryRecoveryPreview {
    const attempt = this.attempt(sessionId, id), scope = this.scope(attempt.workspaceId), usage = this.summaries.getUsage(id, sessionId);
    const base: SummaryRecoveryPreview = { version: 1, status: 'blocked', fingerprint: null, blockers: [], sessionId, workspaceId: attempt.workspaceId, runId: attempt.runId, summaryAttemptId: id,
      summaryScope: attempt.scope, attemptRevision: attempt.revision, recordSha256: digest(attempt), usageSha256: usage ? digest(usage) : null, sourceSha256: attempt.sourceSha256, requestSha256: attempt.requestSha256,
      bindingScope: scope, sourceOwnerSha256: null, contextBaselineSha256: null };
    const ordinal = String(this.db.prepare('SELECT CAST(rowid AS TEXT) AS ordinal FROM summary_attempts WHERE id=?').get(id)!.ordinal);
    const run = this.native.scopeRun(sessionId, attempt.runId);
    if (BigInt(ordinal) > BigInt(this.options.startupHighWater)) base.blockers.push('SUMMARY_RECOVERY_RESTART_REQUIRED');
    if (attempt.state !== 'uncertain' || attempt.cleanupConfirmed || attempt.publication !== 'discarded') base.blockers.push('SUMMARY_RECOVERY_NOT_NEEDED');
    if (!isTerminal(run.state) || this.db.prepare("SELECT 1 FROM runs WHERE workspace_id=? AND state IN ('created','running','awaiting_approval','cancelling') LIMIT 1").get(run.workspaceId)) base.blockers.push('SUMMARY_RECOVERY_BLOCKED');
    if (this.db.prepare("SELECT 1 FROM session_turns t JOIN runs r ON r.id=t.run_id WHERE r.workspace_id=? AND t.state='uncertain' LIMIT 1").get(run.workspaceId)
      || this.db.prepare("SELECT 1 FROM provider_attempts a JOIN runs r ON r.id=a.run_id WHERE r.workspace_id=? AND a.state='uncertain' LIMIT 1").get(run.workspaceId)) base.blockers.push('SUMMARY_RECOVERY_OTHER_UNCERTAINTY');
    if (base.blockers.length) return base;
    try {
      const budget = { bytes: 0, max: SUMMARY_RECOVERY_LIMITS.maxSourceBytes }, evidence = this.evidence(attempt, budget); base.sourceOwnerSha256 = evidence.sourceOwnerSha256;
      const existing = this.ledger('summary_attempt_id=? AND binding_scope=?', id, scope);
      if (existing) { const audit = this.audit(existing, budget); if (!this.valid(audit, attempt, evidence, scope, budget)) fail('SOURCE_CHANGED', 'An existing host acknowledgment no longer matches its immutable evidence');
        return { ...base, status: 'acknowledged', fingerprint: audit.receipt.fingerprint, acknowledgment: structuredClone(audit.receipt) }; }
      const context = this.baseline(sessionId, budget); base.contextBaselineSha256 = context.hash;
      return { ...base, status: 'eligible', fingerprint: digest({ ...base, sourceOwnerSha256: evidence.sourceOwnerSha256, contextBaselineSha256: context.hash, startupHighWater: this.options.startupHighWater }) };
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      return { ...base, blockers: [error.code] };
    }
  }
  preview(sessionId: string, id: string): SummaryRecoveryPreview { return this.read(() => this.previewInTransaction(sessionId, id)); }
  /** Original decisions are receipts, never a claim about current execution safety. */
  findReceipt(value: SummaryRecoveryRequest): SummaryRecoveryReceipt | null {
    const request = validateSummaryRecoveryRequest(value);
    return this.read(() => {
      const attempt = this.attempt(request.sessionId, request.summaryAttemptId), scope = this.scope(attempt.workspaceId);
      const row = this.ledger('workspace_id=? AND binding_scope=? AND request_id=?', attempt.workspaceId, scope, request.requestId);
      if (!row) return null;
      const audit = this.audit(row, { bytes: 0, max: SUMMARY_RECOVERY_LIMITS.maxLedgerBytes });
      if (audit.receipt.summaryAttemptId !== request.summaryAttemptId || audit.receipt.sessionId !== request.sessionId || audit.receipt.fingerprint !== request.fingerprint) fail('REQUEST_CONFLICT', 'Recovery request ID belongs to another exact decision');
      return { ...structuredClone(audit.receipt), duplicate: true };
    });
  }
  acknowledge(value: SummaryRecoveryRequest): SummaryRecoveryReceipt {
    const request = validateSummaryRecoveryRequest(value);
    const prior = this.findReceipt(request); if (prior) return prior;
    return this.native.write(request.sessionId, () => {
      const attempt = this.attempt(request.sessionId, request.summaryAttemptId), scope = this.scope(attempt.workspaceId);
      const existing = this.ledger('workspace_id=? AND binding_scope=? AND request_id=?', attempt.workspaceId, scope, request.requestId);
      if (existing) {
        const audit = this.audit(existing, { bytes: 0, max: SUMMARY_RECOVERY_LIMITS.maxLedgerBytes }); if (audit.receipt.summaryAttemptId !== request.summaryAttemptId || audit.receipt.sessionId !== request.sessionId || audit.receipt.fingerprint !== request.fingerprint) fail('REQUEST_CONFLICT', 'Recovery request ID belongs to another exact decision');
        return { ...structuredClone(audit.receipt), duplicate: true };
      }
      const preview = this.previewInTransaction(request.sessionId, request.summaryAttemptId);
      if (preview.status === 'blocked') throw new EngineError(preview.blockers[0]!, 'The summary is not eligible for this host recovery decision');
      if (preview.status === 'acknowledged') fail('REQUEST_CONFLICT', 'This summary already has a host decision; retry its original request');
      if (preview.fingerprint !== request.fingerprint) fail('STALE', 'Summary recovery preview changed before acknowledgment');
      const budget = { bytes: 0, max: SUMMARY_RECOVERY_LIMITS.maxSourceBytes }, evidence = this.evidence(attempt, budget), context = this.baseline(request.sessionId, budget);
      const receipt: SummaryRecoveryReceipt = { version: 1, id: randomUUID(), requestId: request.requestId, sessionId: attempt.sessionId, workspaceId: attempt.workspaceId, runId: attempt.runId, summaryAttemptId: attempt.id,
        fingerprint: request.fingerprint, bindingScope: scope, acknowledgedAt: new Date().toISOString(), state: 'uncertain', cleanupConfirmed: false, publication: 'discarded', providerRetried: false, checkpointActivated: false, executionResumed: false, duplicate: false };
      const audit: Audit = { receipt, attemptRevision: attempt.revision, ...evidence, pins: context.pins, contextBaselineSha256: context.hash }, encoded = JSON.stringify(audit);
      if (Buffer.byteLength(encoded) > SUMMARY_RECOVERY_LIMITS.maxLedgerBytes) fail('LIMIT', 'Summary acknowledgment exceeds its durable byte bound');
      this.db.prepare('INSERT INTO summary_recovery_acknowledgments(id,summary_attempt_id,session_id,workspace_id,run_id,request_id,binding_scope,attempt_revision,fingerprint,record_sha256,usage_sha256,source_owner_sha256,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(receipt.id, attempt.id, attempt.sessionId, attempt.workspaceId, attempt.runId, request.requestId, scope, attempt.revision, request.fingerprint, evidence.recordSha256, evidence.usageSha256, evidence.sourceOwnerSha256, encoded);
      const payload = JSON.parse(JSON.stringify(receipt)) as JsonObject; delete payload.duplicate;
      const nativeEvent = this.native.appendEvent(attempt.sessionId, 'summary.recovery.acknowledged', payload, { runId: attempt.runId });
      this.options.appendLegacy(this.native.scopeRun(attempt.sessionId, attempt.runId), nativeEvent.type, nativeEvent.payload);
      return structuredClone(receipt);
    });
  }
  hasUnacknowledged(workspaceId: string): boolean {
    return this.read(() => {
      // The overwhelmingly common first unresolved candidate needs neither text
      // nor current context. No forged or incomplete coverage ever becomes clear.
      try {
        if (!this.db.prepare("SELECT 1 FROM summary_attempts WHERE workspace_id=? AND state='uncertain' LIMIT 1").get(workspaceId)) return false;
        const scope = this.scope(workspaceId);
        if (this.db.prepare("SELECT 1 FROM summary_attempts s LEFT JOIN summary_recovery_acknowledgments a ON a.summary_attempt_id=s.id AND a.binding_scope=? WHERE s.workspace_id=? AND s.state='uncertain' AND a.id IS NULL LIMIT 1").get(scope, workspaceId)) return true;
        const candidates = this.db.prepare("SELECT id,session_id FROM summary_attempts WHERE workspace_id=? AND state='uncertain' LIMIT ?").all(workspaceId, SUMMARY_RECOVERY_LIMITS.maxCandidates + 1);
        if (candidates.length > SUMMARY_RECOVERY_LIMITS.maxCandidates) return true;
        const budget = { bytes: 0, max: SUMMARY_RECOVERY_LIMITS.maxInspectionBytes };
        for (const candidate of candidates) {
          const attempt = this.attempt(String(candidate.session_id), String(candidate.id));
          const row = this.ledger('summary_attempt_id=? AND binding_scope=?', attempt.id, scope); if (!row) return true;
          const audit = this.audit(row, budget), evidence = this.evidence(attempt, budget);
          if (!this.valid(audit, attempt, evidence, scope, budget)) return true;
        }
        return false;
      } catch { return true; }
    });
  }
}
