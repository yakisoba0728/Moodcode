import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { EngineError, isTerminal, type EngineEvent, type JsonObject, type Run } from '@moodcode/contracts';
import { validateContextRevision } from '@moodcode/contracts/validation';
import type { NativeSessionStorage } from '../storage/native.js';
import type { SummaryAttemptRecord, SummaryAttemptStorage } from '../storage/summary-attempts.js';
import { invalidateEvidenceRead, readEvidenceBody, withEvidenceRead } from '../storage/evidence-read.js';
import { sha256Hex } from '../shared/canonical.js';
import { isBoundedId, isSha256, parseJsonOr, plainRecord } from '../shared/data.js';
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
/** DB7 adds proof metadata without rewriting any DB5 acknowledgment body or scope. */
export const SUMMARY_RECOVERY_PROOF_SCHEMA = `
ALTER TABLE summary_recovery_acknowledgments ADD COLUMN proof_version INTEGER NOT NULL DEFAULT 1 CHECK(proof_version IN (1,2));
ALTER TABLE summary_recovery_acknowledgments ADD COLUMN pins_sha256 TEXT CHECK(pins_sha256 IS NULL OR length(pins_sha256)=64);
ALTER TABLE summary_recovery_acknowledgments ADD COLUMN startup_high_water TEXT CHECK(startup_high_water IS NULL OR length(CAST(startup_high_water AS BLOB)) BETWEEN 1 AND 19);`;
export const SUMMARY_RECOVERY_LIMITS = Object.freeze({ maxCandidates: 64, maxMessages: 512, maxTurns: 128, maxSourceBytes: 2097152, maxInspectionBytes: 8388608, maxLedgerBytes: 65536,
  maxSourceReferences: 1024, maxOwnerBytes: 1_048_576 });
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
interface Audit { receipt: SummaryRecoveryReceipt; attemptRevision: number; recordSha256: string; usageSha256: string | null; sourceOwnerSha256: string; pins: Pin[]; contextBaselineSha256: string;
  proofVersion?: 2; pinsSha256?: string; startupHighWater?: string }
interface ProofAudit extends Audit { proofVersion: 2; pinsSha256: string; startupHighWater: string }
interface Budget { bytes: number; max: number }
interface Evidence { recordSha256: string; usageSha256: string | null; sourceOwnerSha256: string }
type ImmutableItem = ReturnType<typeof record> & { table: Pin['table'] };
type Row = Record<string, unknown>;
const digest = (value: unknown) => sha256Hex(canonical(value));
const highWater = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/u.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
function proofScope(storageBinding: string): string { return digest({ kind: 'summary-recovery', proofVersion: 2, storageBinding }); }
function proofFingerprint(attempt: SummaryAttemptRecord, evidence: Evidence, bindingScope: string, contextBaselineSha256: string, pinsSha256: string, startupHighWater: string): string {
  return digest({ kind: 'summary-recovery', proofVersion: 2, sessionId: attempt.sessionId, workspaceId: attempt.workspaceId, runId: attempt.runId,
    summaryAttemptId: attempt.id, summaryScope: attempt.scope, attemptRevision: attempt.revision,
    recordSha256: evidence.recordSha256, usageSha256: evidence.usageSha256, sourceOwnerSha256: evidence.sourceOwnerSha256,
    requestSha256: attempt.requestSha256, requestBytes: attempt.requestBytes, sourceSha256: attempt.sourceSha256,
    bindingScope, contextBaselineSha256, pinsSha256, startupHighWater });
}
function sourceAnnotation(value: string): { nativeId?: string } | undefined {
  if (/^(active-prefix-(policy|facts|manifest|checkpoint)|(image|document)-(policy|source)):[a-f0-9]{64}$/u.test(value)) return {};
  const separator = value.lastIndexOf(':');
  if (separator < 0 || !isSha256(value.slice(separator + 1))) return undefined;
  if (value.startsWith('instruction:')) {
    const path = value.slice('instruction:'.length, separator), components = path.split('/');
    if (!path.includes('\\') && components.at(-1) === 'AGENTS.md' && components.every(part => part !== '' && part !== '.' && part !== '..')) return {};
  }
  if (value.startsWith('image-message:') || value.startsWith('document-message:')) {
    const nativeId = value.slice(value.indexOf(':') + 1, separator); if (isBoundedId(nativeId)) return { nativeId };
  }
  return undefined;
}
function fail(suffix: string, message: string): never { throw new EngineError(`SUMMARY_RECOVERY_${suffix}`, message); }
export function validateSummaryRecoveryRequest(input: unknown): SummaryRecoveryRequest {
  const value = plainRecord(input, [], ['sessionId', 'summaryAttemptId', 'requestId', 'fingerprint', 'acknowledged'],
    fault => fail('INVALID_REQUEST', fault === 'shape' ? 'Summary recovery accepts plain data only' : 'Summary recovery rejects accessors and unknown fields'));
  if (value.acknowledged !== true) fail('ACKNOWLEDGMENT_REQUIRED', 'Explicit acknowledgment of this exact preview is required');
  if (!isBoundedId(value.sessionId) || !isBoundedId(value.summaryAttemptId) || !isBoundedId(value.requestId) || !isSha256(value.fingerprint)) fail('INVALID_REQUEST', 'Summary recovery requires bounded owner and request identities');
  return { sessionId: value.sessionId, summaryAttemptId: value.summaryAttemptId, requestId: value.requestId, fingerprint: value.fingerprint, acknowledged: true };
}
export function captureSummaryRecoveryHighWater(db: DatabaseSync): string {
  return String(db.prepare('SELECT CAST(coalesce(max(rowid),0) AS TEXT) AS ordinal FROM summary_attempts').get()!.ordinal);
}
function charge(budget: Budget, bytes: number): void { if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.max - budget.bytes) fail('LIMIT', 'Summary recovery exceeds its bounded evidence budget'); budget.bytes += bytes; }
function parse(text: string): JsonObject { return parseJsonOr(text, () => fail('SOURCE_CHANGED', 'Pinned recovery evidence is not valid JSON')) as JsonObject; }
const columns = {
  messages: 'id,session_id,run_id,CAST(ordinal AS TEXT) AS ordinal', runs: 'id,session_id,workspace_id,state',
  session_turns: 'id,session_id,run_id,turn_index,state', provider_attempts: 'id,session_id,run_id,turn_id,attempt_index,state',
  message_parts: 'id,session_id,run_id,turn_id,message_id,part_index,revision,state', tools: 'id,session_id,run_id,state',
  context_revisions: 'id,session_id,run_id,turn_id,CAST(revision AS TEXT) AS revision,supersedes_id',
} as const;
function record(db: DatabaseSync, table: keyof typeof columns, id: string, budget: Budget, expected?: { sessionId: string; runId?: string; workspaceId?: string }): { row: Row; data: JsonObject; sha256: string } {
  const row = db.prepare(`SELECT ${columns[table]},length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE id=?`).get(id);
  if (!row) fail('SOURCE_CHANGED', 'Pinned evidence no longer exists');
  if (expected && (row.session_id !== expected.sessionId || expected.runId !== undefined && row.run_id !== expected.runId
    || expected.workspaceId !== undefined && row.workspace_id !== expected.workspaceId)) fail('OWNER_MISMATCH', 'Pinned evidence belongs to another owner');
  charge(budget, Number(row.bytes));
  const data = parse(String(readEvidenceBody(db, { table, key: id }, { expectedBytes: Number(row.bytes), maxBytes: budget.max })));
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.id !== id || data.sessionId !== row.session_id
    || table !== 'runs' && table !== 'context_revisions' && data.runId !== row.run_id
    || table === 'runs' && (data.workspaceId !== row.workspace_id || data.state !== row.state)
    || table === 'context_revisions' && (data.runId ?? null) !== row.run_id
    || table === 'context_revisions' && ((data.turnId ?? null) !== row.turn_id || Number(data.revision) !== Number(row.revision) || (data.supersedesId ?? null) !== row.supersedes_id)
    || ['session_turns','provider_attempts','message_parts','tools'].includes(table) && data.state !== row.state
    || ['provider_attempts','message_parts'].includes(table) && data.turnId !== row.turn_id
    || table === 'message_parts' && (data.messageId !== row.message_id || data.index !== row.part_index || data.revision !== row.revision)
    || table === 'session_turns' && data.index !== row.turn_index || table === 'provider_attempts' && data.index !== row.attempt_index) fail('SOURCE_CHANGED', 'Pinned payload and SQL owner disagree');
  if (table === 'messages' && (!Number.isSafeInteger(Number(row.ordinal)) || Number(row.ordinal) < 1)) fail('SOURCE_CHANGED', 'Pinned message ordinal is unsafe');
  return { row, data, sha256: digest({ row: { ...row, bytes: undefined }, data }) };
}
function ids(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || !value.length || value.length > maximum || new Set(value).size !== value.length || !value.every(isBoundedId)) fail('LIMIT', 'Summary recovery requires bounded exact source identities');
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
    hasOtherExecutionUncertainty(workspaceId: string, excludedSummaryAttemptId: string): boolean;
    getSummaryOverflowDependency(summaryAttemptId: string, turnId: string, failedAttemptId: string): NonNullable<import('@moodcode/contracts').ExecutionUncertainty['summaryDependency']>;
  }) {
    if (!highWater(options.startupHighWater)) fail('INVALID_REQUEST', 'Recovery requires the original boot frontier');
    this.options = Object.freeze({ bindingScope: options.bindingScope, startupHighWater: options.startupHighWater, appendLegacy: options.appendLegacy,
      hasOtherExecutionUncertainty: options.hasOtherExecutionUncertainty, getSummaryOverflowDependency: options.getSummaryOverflowDependency });
  }
  private get db() { return this.native.database; }
  private read<T>(operation: () => T): T {
    this.native.hooks.assertOpen(); if (this.db.isTransaction) return withEvidenceRead(this.db, operation);
    this.db.exec('BEGIN'); try { const result = withEvidenceRead(this.db, operation); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private storageBinding(workspaceId: string): string { const scope = this.options.bindingScope(workspaceId); if (!isSha256(scope)) fail('BINDING_CHANGED', 'Recovery requires an unchanged physical host binding'); return scope; }
  private scope(workspaceId: string): string { return proofScope(this.storageBinding(workspaceId)); }
  private attempt(sessionId: string, id: string): SummaryAttemptRecord {
    this.native.hooks.session(sessionId); const row = this.db.prepare('SELECT session_id FROM summary_attempts WHERE id=?').get(id);
    if (row && row.session_id !== sessionId) fail('OWNER_MISMATCH', 'Summary belongs to another session');
    return this.summaries.get(id, sessionId);
  }
  private source(recordValue: SummaryAttemptRecord, budget: Budget): string {
    const owner = this.native.scopeRun(recordValue.sessionId, recordValue.runId);
    const pins: unknown[] = [record(this.db, 'runs', owner.id, budget, { sessionId: recordValue.sessionId, workspaceId: recordValue.workspaceId }).sha256];
    const runIds = recordValue.scope === 'active-run-prefix' ? [owner.id] : ids(recordValue.sourceRunIds, SUMMARY_RECOVERY_LIMITS.maxTurns);
    const allowed = new Set(runIds);
    for (const id of runIds) { const sourceRun = record(this.db, 'runs', id, budget, { sessionId: recordValue.sessionId, workspaceId: recordValue.workspaceId }); if (sourceRun.data.sessionId !== recordValue.sessionId || sourceRun.data.workspaceId !== recordValue.workspaceId
      || !isTerminal(sourceRun.data.state as Run['state'])) fail('OWNER_MISMATCH', 'Summary source Run is not a settled matching owner'); pins.push(sourceRun.sha256); }
    const messages = ids(recordValue.sourceMessageIds, SUMMARY_RECOVERY_LIMITS.maxMessages).map(id => {
      const header = this.db.prepare('SELECT m.session_id,m.run_id,r.session_id AS run_session_id,r.workspace_id FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.id=?').get(id);
      if (!header) fail('SOURCE_CHANGED', 'Summary source message is missing');
      if (header.session_id !== recordValue.sessionId || header.run_session_id !== recordValue.sessionId || header.workspace_id !== recordValue.workspaceId || !allowed.has(String(header.run_id))) fail('OWNER_MISMATCH', 'Summary source message belongs to another owner');
      return record(this.db, 'messages', id, budget, { sessionId: recordValue.sessionId, runId: String(header.run_id) });
    });
    for (const item of messages) {
      owned(item.data, recordValue.sessionId); if (!allowed.has(String(item.data.runId)) || typeof item.data.content !== 'string' || !['user','assistant','tool'].includes(String(item.data.role))
        || Array.isArray(item.data.attachments) && item.data.attachments.length || Array.isArray(item.data.documents) && item.data.documents.length) fail('SOURCE_CHANGED', 'Summary source is not exact text-only owned history'); pins.push(item.sha256);
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
        const turn = record(this.db, 'session_turns', turnId, budget, { sessionId: owner.sessionId, runId: owner.id }); owned(turn.data, owner.sessionId, owner.id);
        const attemptId = this.db.prepare('SELECT id FROM provider_attempts WHERE turn_id=? ORDER BY attempt_index DESC LIMIT 1').get(turnId)?.id;
        if (!attemptId || turn.data.state !== 'completed') fail('SOURCE_CHANGED', 'Summary source Turn is not complete');
        const attempt = record(this.db, 'provider_attempts', String(attemptId), budget, { sessionId: owner.sessionId, runId: owner.id }); owned(attempt.data, owner.sessionId, owner.id);
        if (attempt.data.state !== 'completed' || attempt.data.turnId !== turnId || attempt.data.providerId !== recordValue.providerId || attempt.data.modelId !== recordValue.modelId) fail('SOURCE_CHANGED', 'Summary source attempt owner changed');
        pins.push(turn.sha256, attempt.sha256);
        const headers = this.db.prepare('SELECT id FROM message_parts WHERE turn_id=? ORDER BY part_index LIMIT 129').all(turnId);
        if (headers.length > 128) fail('LIMIT', 'Summary source Parts exceed their read bound');
        const parts = headers.map(row => record(this.db, 'message_parts', String(row.id), budget, { sessionId: owner.sessionId, runId: owner.id }));
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
          if (part.data.messageId !== assistant.id || !isBoundedId(part.data.toolCallId)) fail('SOURCE_CHANGED', 'Tool Part has a different message owner');
          const call = calls.filter(value => value.id === part.data.providerCallId), matching = facts.filter(fact => fact.role === 'tool' && fact.toolCallId === part.data.providerCallId && !fact.turnId);
          const assistantPosition = facts.indexOf(assistant), nextAssistant = facts.findIndex((fact, position) => position > assistantPosition && fact.role === 'assistant');
          const results = matching.filter(fact => facts.indexOf(fact) > assistantPosition && (nextAssistant < 0 || facts.indexOf(fact) < nextAssistant));
          if (call.length !== 1 || results.length !== 1 || call[0]!.name !== part.data.name || canonical(call[0]!.input) !== canonical(part.data.input)) fail('SOURCE_CHANGED', 'Tool call and result pairing changed');
          const fact = results[0]!, tool = record(this.db, 'tools', part.data.toolCallId, budget, { sessionId: owner.sessionId, runId: owner.id }); owned(tool.data, owner.sessionId, owner.id); pins.push(tool.sha256);
          const result = part.data.result as JsonObject | undefined;
          if (!['completed','failed','denied'].includes(String(tool.data.state)) || tool.data.name !== part.data.name || canonical(tool.data.input) !== canonical(part.data.input)
            || tool.data.output !== fact.content || !result || result.output !== fact.content || (part.data.state === 'completed') !== (tool.data.state === 'completed')) fail('SOURCE_CHANGED', 'Tool observation changed from its settled owner');
          fact.turnId = turnId; fact.attemptId = String(attemptId); fact.internalToolCallId = part.data.toolCallId; fact.toolOutcome = tool.data.state!;
        }
      }
      if (facts.some(fact => fact.role !== 'user' && !fact.turnId)) fail('SOURCE_CHANGED', 'Pinned source splits an assistant/tool exchange');
      if (recordValue.boundaryTurnId) {
        const boundary = record(this.db, 'session_turns', recordValue.boundaryTurnId, budget, { sessionId: owner.sessionId, runId: owner.id }); owned(boundary.data, owner.sessionId, owner.id);
        const attempt = record(this.db, 'provider_attempts', recordValue.boundaryAttemptId!, budget, { sessionId: owner.sessionId, runId: owner.id }); owned(attempt.data, owner.sessionId, owner.id);
        if (boundary.data.state !== 'completed' || attempt.data.state !== 'completed' || attempt.data.turnId !== boundary.data.id) fail('SOURCE_CHANGED', 'The source completed boundary changed'); pins.push(boundary.sha256, attempt.sha256);
      }
      source = JSON.stringify({ version: 1, scope: 'active-run-prefix', projection: 'text-and-complete-tool-observations-v1', messages: facts });
    }
    if (Buffer.byteLength(source) > SUMMARY_RECOVERY_LIMITS.maxSourceBytes || sha256Hex(source) !== recordValue.sourceSha256) fail('SOURCE_CHANGED', 'Exact summary facts differ from their original digest');
    if (recordValue.currentTurnId || recordValue.failedAttemptId) {
      if (!recordValue.currentTurnId || !recordValue.failedAttemptId) fail('SOURCE_CHANGED', 'Overflow source requires its observed ordinary cleanup dependency');
      const dependency = this.options.getSummaryOverflowDependency(recordValue.id, recordValue.currentTurnId, recordValue.failedAttemptId);
      const current = record(this.db, 'session_turns', recordValue.currentTurnId, budget, { sessionId: owner.sessionId, runId: owner.id }), failed = record(this.db, 'provider_attempts', recordValue.failedAttemptId, budget, { sessionId: owner.sessionId, runId: owner.id });
      pins.push(dependency, current.sha256, failed.sha256);
    }
    return digest(pins);
  }
  private evidence(attempt: SummaryAttemptRecord, budget: Budget): Evidence {
    charge(budget, Buffer.byteLength(JSON.stringify(attempt)));
    const usage = this.summaries.getUsage(attempt.id, attempt.sessionId); charge(budget, Buffer.byteLength(JSON.stringify(usage)));
    return { recordSha256: digest(attempt), usageSha256: usage ? digest(usage) : null, sourceOwnerSha256: this.source(attempt, budget) };
  }
  private immutable(table: Pin['table'], id: string, sessionId: string, budget: Budget): ImmutableItem {
    if (!isBoundedId(id)) fail('SOURCE_CHANGED', 'Immutable context source has an invalid native identity');
    const context = table === 'context_revisions';
    const header = this.db.prepare(`SELECT p.session_id,p.run_id,${context ? 'p.turn_id,CAST(p.revision AS TEXT)' : 'NULL AS turn_id,NULL'} AS revision,
      r.session_id AS run_session_id,r.workspace_id AS run_workspace_id,s.workspace_id AS session_workspace_id,
      ${context ? 't.session_id AS turn_session_id,t.run_id AS turn_run_id,' : ''}length(CAST(p.data AS BLOB)) AS bytes
      FROM ${table} p JOIN sessions s ON s.id=p.session_id LEFT JOIN runs r ON r.id=p.run_id
      ${context ? 'LEFT JOIN session_turns t ON t.id=p.turn_id' : ''} WHERE p.id=?`).get(id);
    if (!header) fail('SOURCE_CHANGED', 'An immutable context source no longer exists');
    if (header.session_id !== sessionId || header.run_id !== null && (header.run_session_id !== sessionId || header.run_workspace_id !== header.session_workspace_id)
      || header.turn_id !== null && (header.turn_session_id !== sessionId || header.turn_run_id !== header.run_id)) fail('OWNER_MISMATCH', 'Immutable context source belongs to another native owner');
    if (!Number.isSafeInteger(header.bytes) || Number(header.bytes) < 2 || Number(header.bytes) > SUMMARY_RECOVERY_LIMITS.maxOwnerBytes) fail('LIMIT', 'Immutable context source exceeds its payload bound');
    const item = { ...record(this.db,table,id,budget), table };
    if (context) {
      try { validateContextRevision(item.data); } catch { fail('SOURCE_CHANGED', 'Immutable context revision no longer satisfies its native contract'); }
      if (typeof item.data.text !== 'string' || sha256Hex(item.data.text) !== item.data.sha256) fail('SOURCE_CHANGED', 'Immutable context revision text digest changed');
    } else if (!['user','assistant','tool'].includes(String(item.data.role)) || typeof item.data.content !== 'string') fail('SOURCE_CHANGED', 'Immutable context message is malformed');
    return item;
  }
  private sourceClosure(sessionId: string, items: Map<string, ImmutableItem>, budget: Budget): void {
    const contexts = [...items.values()].filter(item => item.table === 'context_revisions'); let references = 0;
    if (items.size > SUMMARY_RECOVERY_LIMITS.maxSourceReferences) fail('LIMIT', 'Immutable source closure exceeds its pin bound');
    for (let index = 0; index < contexts.length; index++) {
      const parent = contexts[index]!, sourceIds = parent.data.sourceIds;
      if (!Array.isArray(sourceIds) || sourceIds.length > SUMMARY_RECOVERY_LIMITS.maxSourceReferences) fail('LIMIT', 'Immutable context sources exceed their reference bound');
      for (const reference of sourceIds) {
        if (!isBoundedId(reference)) fail('SOURCE_CHANGED', 'Immutable context source has an invalid identity');
        if (++references > SUMMARY_RECOVERY_LIMITS.maxSourceReferences) fail('LIMIT', 'Immutable source closure exceeds its combined reference bound');
        const annotation = sourceAnnotation(reference);
        if (annotation && !annotation.nativeId) continue;
        const id = annotation?.nativeId ?? reference;
        const message = this.db.prepare('SELECT 1 FROM messages WHERE id=?').get(id), context = this.db.prepare('SELECT CAST(revision AS TEXT) AS revision FROM context_revisions WHERE id=?').get(id);
        if (!message && !context || message && context || annotation?.nativeId && !message) fail('SOURCE_CHANGED', 'Immutable context source is missing or ambiguous');
        if (context && (!Number.isSafeInteger(Number(context.revision)) || Number(context.revision) < 1 || Number(context.revision) >= Number(parent.data.revision))) fail('SOURCE_CHANGED', 'Immutable semantic source must precede its derived revision');
        const table: Pin['table'] = message ? 'messages' : 'context_revisions', key = `${table}:${id}`;
        if (items.has(key)) continue;
        if (items.size >= SUMMARY_RECOVERY_LIMITS.maxSourceReferences) fail('LIMIT', 'Immutable source closure exceeds its combined pin bound');
        const item = this.immutable(table,id,sessionId,budget); items.set(key,item);
        if (table === 'context_revisions') contexts.push(item);
      }
    }
  }
  private baseline(sessionId: string, budget: Budget): { hash: string; pins: Pin[] } {
    const documents: unknown[] = [], items = new Map<string, ImmutableItem>();
    for (const kind of ['context.memory','context.active_memory','context.head']) {
      const row = this.db.prepare('SELECT CAST(revision AS TEXT) AS revision,length(CAST(data AS BLOB)) AS bytes FROM session_documents WHERE session_id=? AND kind=?').get(sessionId, kind);
      if (!row) { documents.push({ kind, absent: true }); continue; }
      if (!Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1 || Number(row.bytes) > 262144) fail('LIMIT', 'Context baseline metadata exceeds its bound');
      charge(budget, Number(row.bytes)); const data = parse(String(readEvidenceBody(this.db, { table: 'session_documents', key: [sessionId, kind] }, { expectedBytes: Number(row.bytes), maxBytes: 262144 })));
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('SOURCE_CHANGED', 'Context baseline must contain JSON data');
      documents.push({ kind, revision: Number(row.revision), data });
      const active = data.active as JsonObject | undefined, id = kind === 'context.head' ? data.revisionId : active?.revisionId;
      if (id !== undefined) {
        if (!isBoundedId(id)) fail('SOURCE_CHANGED', 'Context baseline has an invalid revision reference');
        const key = `context_revisions:${id}`;
        if (!items.has(key)) items.set(key,this.immutable('context_revisions',id,sessionId,budget));
      }
    }
    this.sourceClosure(sessionId,items,budget);
    return { hash: digest(documents), pins: [...items.values()].map(item => ({ table: item.table, id: String(item.data.id), sha256: item.sha256 })) };
  }
  private audit(row: Row, budget: Budget): Audit {
    if (!Number.isSafeInteger(row.bytes) || Number(row.bytes) < 1 || Number(row.bytes) > SUMMARY_RECOVERY_LIMITS.maxLedgerBytes) fail('LIMIT', 'Summary acknowledgment exceeds its read bound');
    charge(budget, Number(row.bytes));
    const data = parse(String(readEvidenceBody(this.db, { table: 'summary_recovery_acknowledgments', key: String(row.id) }, { expectedBytes: Number(row.bytes), maxBytes: SUMMARY_RECOVERY_LIMITS.maxLedgerBytes }))) as unknown as Audit;
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('SOURCE_CHANGED', 'Summary acknowledgment must contain a bounded JSON object');
    const receipt = data.receipt;
    if (!receipt || receipt.version !== 1 || receipt.id !== row.id || receipt.summaryAttemptId !== row.summary_attempt_id || receipt.sessionId !== row.session_id || receipt.workspaceId !== row.workspace_id || receipt.runId !== row.run_id
      || receipt.requestId !== row.request_id || receipt.bindingScope !== row.binding_scope || receipt.fingerprint !== row.fingerprint || data.recordSha256 !== row.record_sha256 || data.usageSha256 !== row.usage_sha256 || data.sourceOwnerSha256 !== row.source_owner_sha256
      || !Number.isSafeInteger(data.attemptRevision) || data.attemptRevision < 1 || data.attemptRevision !== Number(row.attempt_revision)
      || receipt.state !== 'uncertain' || receipt.cleanupConfirmed !== false || receipt.publication !== 'discarded' || receipt.providerRetried !== false || receipt.checkpointActivated !== false || receipt.executionResumed !== false || receipt.duplicate !== false
      || !isSha256(receipt.fingerprint) || !isSha256(receipt.bindingScope) || ![receipt.id,receipt.requestId,receipt.sessionId,receipt.workspaceId,receipt.runId,receipt.summaryAttemptId].every(isBoundedId)
      || typeof receipt.acknowledgedAt !== 'string' || Buffer.byteLength(receipt.acknowledgedAt)>64 || !Number.isFinite(Date.parse(receipt.acknowledgedAt)) || new Date(receipt.acknowledgedAt).toISOString() !== receipt.acknowledgedAt
      || !isSha256(data.recordSha256) || data.usageSha256 !== null && !isSha256(data.usageSha256) || !isSha256(data.sourceOwnerSha256) || !isSha256(data.contextBaselineSha256)
      || ![1,2].includes(Number(row.proof_version))
      || Object.keys(data).some(key => !['receipt','attemptRevision','recordSha256','usageSha256','sourceOwnerSha256','pins','contextBaselineSha256', ...(row.proof_version === 2 ? ['proofVersion','pinsSha256','startupHighWater'] : [])].includes(key))
      || Object.keys(receipt).some(key => !['version','id','requestId','sessionId','workspaceId','runId','summaryAttemptId','fingerprint','bindingScope','acknowledgedAt','state','cleanupConfirmed','publication','providerRetried','checkpointActivated','executionResumed','duplicate'].includes(key))
      || !Array.isArray(data.pins) || data.pins.length > 1024 || data.pins.some(pin => !pin || typeof pin !== 'object' || !['messages','context_revisions'].includes(pin.table) || !isBoundedId(pin.id) || !isSha256(pin.sha256)
        || Object.keys(pin).some(key => !['table','id','sha256'].includes(key)))
      || row.proof_version === 1 && (row.pins_sha256 !== null || row.startup_high_water !== null || data.proofVersion !== undefined || data.pinsSha256 !== undefined || data.startupHighWater !== undefined)
      || row.proof_version === 2 && (data.proofVersion !== 2 || !isSha256(data.pinsSha256) || data.pinsSha256 !== row.pins_sha256
        || !highWater(data.startupHighWater) || data.startupHighWater !== row.startup_high_water || digest(data.pins) !== data.pinsSha256
        || new Set(data.pins.map(pin => `${pin.table}:${pin.id}`)).size !== data.pins.length)) fail('SOURCE_CHANGED', 'Summary acknowledgment payload and pinned SQL identity disagree');
    return data;
  }
  private ledger(where: string, ...parameters: string[]): Row | undefined {
    return this.db.prepare(`SELECT id,summary_attempt_id,session_id,workspace_id,run_id,request_id,binding_scope,CAST(attempt_revision AS TEXT) AS attempt_revision,fingerprint,record_sha256,usage_sha256,source_owner_sha256,proof_version,pins_sha256,startup_high_water,length(CAST(data AS BLOB)) AS bytes FROM summary_recovery_acknowledgments WHERE ${where} LIMIT 1`).get(...parameters);
  }
  private ledgerOwner(row: Row, attempt: Pick<SummaryAttemptRecord, 'id' | 'sessionId' | 'workspaceId' | 'runId'>): void {
    if (row.summary_attempt_id !== attempt.id || row.session_id !== attempt.sessionId || row.workspace_id !== attempt.workspaceId || row.run_id !== attempt.runId) fail('SOURCE_CHANGED', 'Summary acknowledgment SQL owner changed');
  }
  private valid(audit: Audit, attempt: SummaryAttemptRecord, evidence: Evidence, scope: string, budget: Budget): boolean {
    if (!(audit.proofVersion === 2 && isSha256(audit.pinsSha256) && highWater(audit.startupHighWater)
      && audit.receipt.bindingScope === scope && audit.receipt.summaryAttemptId === attempt.id && audit.receipt.runId === attempt.runId && audit.receipt.sessionId === attempt.sessionId && audit.receipt.workspaceId === attempt.workspaceId
      && audit.attemptRevision === attempt.revision
      && audit.recordSha256 === evidence.recordSha256 && audit.usageSha256 === evidence.usageSha256 && audit.sourceOwnerSha256 === evidence.sourceOwnerSha256
      && audit.receipt.fingerprint === proofFingerprint(attempt, evidence, scope, audit.contextBaselineSha256, audit.pinsSha256, audit.startupHighWater))) return false;
    const items = new Map<string, ImmutableItem>();
    for (const pin of audit.pins) {
      const item = this.immutable(pin.table,pin.id,attempt.sessionId,budget);
      if (item.sha256 !== pin.sha256) return false;
      items.set(`${pin.table}:${pin.id}`,item);
    }
    this.sourceClosure(attempt.sessionId,items,budget);
    return items.size === audit.pins.length;
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
    if (this.options.hasOtherExecutionUncertainty(run.workspaceId, attempt.id)) base.blockers.push('SUMMARY_RECOVERY_OTHER_UNCERTAINTY');
    if (base.blockers.length) return base;
    try {
      const budget = { bytes: 0, max: SUMMARY_RECOVERY_LIMITS.maxSourceBytes }, evidence = this.evidence(attempt, budget); base.sourceOwnerSha256 = evidence.sourceOwnerSha256;
      const existing = this.ledger('summary_attempt_id=? AND binding_scope=?', id, scope);
      if (existing) { this.ledgerOwner(existing, attempt); const audit = this.audit(existing, budget); if (!this.valid(audit, attempt, evidence, scope, budget)) fail('SOURCE_CHANGED', 'An existing host acknowledgment no longer matches its immutable evidence');
        return { ...base, status: 'acknowledged', fingerprint: audit.receipt.fingerprint, contextBaselineSha256: audit.contextBaselineSha256, acknowledgment: structuredClone(audit.receipt) }; }
      const context = this.baseline(sessionId, budget); base.contextBaselineSha256 = context.hash;
      return { ...base, status: 'eligible', fingerprint: proofFingerprint(attempt, evidence, scope, context.hash, digest(context.pins), this.options.startupHighWater) };
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      return { ...base, blockers: [error.code] };
    }
  }
  preview(sessionId: string, id: string): SummaryRecoveryPreview {
    let result: SummaryRecoveryPreview | undefined;
    try { return this.read(() => (result = this.previewInTransaction(sessionId, id))); }
    catch (error) {
      if (result && error instanceof EngineError && error.code === 'RECOVERY_EVIDENCE_LIMIT') return { ...result, status: 'blocked', fingerprint: null, acknowledgment: undefined, blockers: [error.code] };
      throw error;
    }
  }
  /** Admission checks immutable ACK evidence without recursively checking other execution blockers. */
  hasValidAcknowledgment(sessionId: string, id: string): boolean {
    try { return this.read(() => {
      try {
        const attempt = this.attempt(sessionId, id);
        if (attempt.state !== 'uncertain' || attempt.cleanupConfirmed || attempt.publication !== 'discarded') return false;
        const scope = this.scope(attempt.workspaceId), row = this.ledger('summary_attempt_id=? AND binding_scope=?', id, scope);
        if (!row) return false; this.ledgerOwner(row, attempt);
        const budget = { bytes: 0, max: SUMMARY_RECOVERY_LIMITS.maxInspectionBytes }, audit = this.audit(row, budget), evidence = this.evidence(attempt, budget);
        return this.valid(audit, attempt, evidence, scope, budget);
      } catch { return false; }
    }); } catch { return false; }
  }
  /** Original decisions are receipts, never a claim about current execution safety. */
  findReceipt(value: SummaryRecoveryRequest): SummaryRecoveryReceipt | null {
    const request = validateSummaryRecoveryRequest(value);
    return this.read(() => this.findReceiptInTransaction(request));
  }
  private findReceiptInTransaction(request: SummaryRecoveryRequest): SummaryRecoveryReceipt | null {
    const attempt = this.db.prepare(`SELECT a.id,a.session_id,a.workspace_id,a.run_id,r.session_id AS run_session_id,r.workspace_id AS run_workspace_id,
      s.workspace_id AS session_workspace_id FROM summary_attempts a JOIN runs r ON r.id=a.run_id JOIN sessions s ON s.id=a.session_id WHERE a.id=?`).get(request.summaryAttemptId);
    if (!attempt) fail('NOT_FOUND', 'Summary recovery Attempt was not found');
    if (attempt.session_id !== request.sessionId || attempt.run_session_id !== request.sessionId || attempt.workspace_id !== attempt.run_workspace_id
      || attempt.workspace_id !== attempt.session_workspace_id) fail('OWNER_MISMATCH', 'Summary recovery receipt belongs to another owner');
    if (![attempt.id,attempt.session_id,attempt.workspace_id,attempt.run_id].every(isBoundedId)) fail('SOURCE_CHANGED', 'Summary recovery receipt owner metadata is invalid');
    const storageBinding = this.storageBinding(String(attempt.workspace_id));
    for (const [scope, version] of [[proofScope(storageBinding),2],[storageBinding,1]] as const) {
      const row = this.ledger('workspace_id=? AND binding_scope=? AND request_id=?', String(attempt.workspace_id), scope, request.requestId);
      if (!row) continue;
      if (row.summary_attempt_id !== request.summaryAttemptId || row.session_id !== request.sessionId || row.workspace_id !== attempt.workspace_id || row.run_id !== attempt.run_id
        || row.fingerprint !== request.fingerprint) fail('REQUEST_CONFLICT', 'Recovery request ID belongs to another exact decision');
      if (row.proof_version !== version) fail('SOURCE_CHANGED', 'Summary recovery decision proof version disagrees with its scope');
      const audit = this.audit(row, { bytes: 0, max: SUMMARY_RECOVERY_LIMITS.maxLedgerBytes });
      return { ...structuredClone(audit.receipt), duplicate: true };
    }
    return null;
  }
  acknowledge(value: SummaryRecoveryRequest): SummaryRecoveryReceipt {
    const request = validateSummaryRecoveryRequest(value);
    const prior = this.findReceipt(request); if (prior) return prior;
    return this.native.write(request.sessionId, () => withEvidenceRead(this.db, () => {
      const duplicate = this.findReceiptInTransaction(request); if (duplicate) return duplicate;
      const attempt = this.attempt(request.sessionId, request.summaryAttemptId), scope = this.scope(attempt.workspaceId);
      const preview = this.previewInTransaction(request.sessionId, request.summaryAttemptId);
      if (preview.status === 'blocked') throw new EngineError(preview.blockers[0]!, 'The summary is not eligible for this host recovery decision');
      if (preview.status === 'acknowledged') fail('REQUEST_CONFLICT', 'This summary already has a host decision; retry its original request');
      if (preview.fingerprint !== request.fingerprint) fail('STALE', 'Summary recovery preview changed before acknowledgment');
      const budget = { bytes: 0, max: SUMMARY_RECOVERY_LIMITS.maxSourceBytes }, evidence = this.evidence(attempt, budget), context = this.baseline(request.sessionId, budget);
      if (scope !== preview.bindingScope || this.scope(attempt.workspaceId) !== scope || evidence.recordSha256 !== preview.recordSha256 || evidence.usageSha256 !== preview.usageSha256
        || evidence.sourceOwnerSha256 !== preview.sourceOwnerSha256 || context.hash !== preview.contextBaselineSha256
        || proofFingerprint(attempt, evidence, scope, context.hash, digest(context.pins), this.options.startupHighWater) !== request.fingerprint) fail('STALE', 'Summary recovery evidence changed during acknowledgment');
      const receipt: SummaryRecoveryReceipt = { version: 1, id: randomUUID(), requestId: request.requestId, sessionId: attempt.sessionId, workspaceId: attempt.workspaceId, runId: attempt.runId, summaryAttemptId: attempt.id,
        fingerprint: request.fingerprint, bindingScope: scope, acknowledgedAt: new Date().toISOString(), state: 'uncertain', cleanupConfirmed: false, publication: 'discarded', providerRetried: false, checkpointActivated: false, executionResumed: false, duplicate: false };
      const audit: ProofAudit = { receipt, attemptRevision: attempt.revision, ...evidence, pins: context.pins, contextBaselineSha256: context.hash,
        proofVersion: 2, pinsSha256: digest(context.pins), startupHighWater: this.options.startupHighWater }, encoded = JSON.stringify(audit);
      if (Buffer.byteLength(encoded) > SUMMARY_RECOVERY_LIMITS.maxLedgerBytes) fail('LIMIT', 'Summary acknowledgment exceeds its durable byte bound');
      invalidateEvidenceRead(this.db);
      this.db.prepare('INSERT INTO summary_recovery_acknowledgments(id,summary_attempt_id,session_id,workspace_id,run_id,request_id,binding_scope,attempt_revision,fingerprint,record_sha256,usage_sha256,source_owner_sha256,proof_version,pins_sha256,startup_high_water,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(receipt.id, attempt.id, attempt.sessionId, attempt.workspaceId, attempt.runId, request.requestId, scope, attempt.revision, request.fingerprint, evidence.recordSha256, evidence.usageSha256, evidence.sourceOwnerSha256, audit.proofVersion, audit.pinsSha256, audit.startupHighWater, encoded);
      const payload = JSON.parse(JSON.stringify(receipt)) as JsonObject; delete payload.duplicate;
      const nativeEvent = this.native.appendEvent(attempt.sessionId, 'summary.recovery.acknowledged', payload, { runId: attempt.runId });
      this.options.appendLegacy(this.native.scopeRun(attempt.sessionId, attempt.runId), nativeEvent.type, nativeEvent.payload);
      return structuredClone(receipt);
    }));
  }
  hasUnacknowledged(workspaceId: string): boolean {
    try { return this.read(() => {
      // The overwhelmingly common first unresolved candidate needs neither text
      // nor current context. No forged or incomplete coverage ever becomes clear.
      try {
        if (!this.db.prepare("SELECT 1 FROM summary_attempts WHERE workspace_id=? AND state='uncertain' LIMIT 1").get(workspaceId)) return false;
        const scope = this.scope(workspaceId);
        if (this.db.prepare("SELECT 1 FROM summary_attempts s LEFT JOIN summary_recovery_acknowledgments a ON a.summary_attempt_id=s.id AND a.binding_scope=? AND a.proof_version=2 WHERE s.workspace_id=? AND s.state='uncertain' AND a.id IS NULL LIMIT 1").get(scope, workspaceId)) return true;
        const candidates = this.db.prepare("SELECT id,session_id FROM summary_attempts WHERE workspace_id=? AND state='uncertain' LIMIT ?").all(workspaceId, SUMMARY_RECOVERY_LIMITS.maxCandidates + 1);
        if (candidates.length > SUMMARY_RECOVERY_LIMITS.maxCandidates) return true;
        const budget = { bytes: 0, max: SUMMARY_RECOVERY_LIMITS.maxInspectionBytes };
        for (const candidate of candidates) {
          const attempt = this.attempt(String(candidate.session_id), String(candidate.id));
          const row = this.ledger('summary_attempt_id=? AND binding_scope=?', attempt.id, scope); if (!row) return true; this.ledgerOwner(row, attempt);
          const audit = this.audit(row, budget), evidence = this.evidence(attempt, budget);
          if (!this.valid(audit, attempt, evidence, scope, budget)) return true;
        }
        return false;
      } catch { return true; }
    }); } catch { return true; }
  }
}
