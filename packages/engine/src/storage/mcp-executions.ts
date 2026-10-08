import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { EngineError, isTerminal, type ApprovalRecord, type EngineEvent, type JsonObject, type Run, type ToolCallRecord} from '@moodcode/contracts';
import { validateMessagePart, validateProviderAttempt, validateTurnRecord } from '@moodcode/contracts/validation';
import { NativeSessionStorage } from './native.js';
import { invalidateEvidenceRead, readEvidenceBody, withEvidenceRead } from './evidence-read.js';

export const MCP_EXECUTION_TABLES = ['mcp_executions'] as const;
export const MCP_EXECUTION_LIMITS = Object.freeze({ maxRecordBytes: 16_384, maxOwnerBytes: 1_048_576, maxMessageBytes: 1_048_576, recoveryPageSize: 100 });
export const MCP_EXECUTION_SCHEMA = `CREATE TABLE mcp_executions (
 tool_call_id TEXT PRIMARY KEY REFERENCES tools(id), session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 run_id TEXT NOT NULL REFERENCES runs(id), turn_id TEXT NOT NULL REFERENCES session_turns(id), attempt_id TEXT NOT NULL REFERENCES provider_attempts(id),
 approval_id TEXT NOT NULL REFERENCES approvals(id), approval_fingerprint TEXT NOT NULL CHECK(length(approval_fingerprint)=64),
 provider_id TEXT NOT NULL, model_id TEXT NOT NULL, context_revision_id TEXT REFERENCES context_revisions(id),
 tool_name TEXT NOT NULL, server_id TEXT NOT NULL, connection_id TEXT NOT NULL, catalogue_revision INTEGER NOT NULL CHECK(catalogue_revision BETWEEN 0 AND 9007199254740991),
 remote_tool TEXT NOT NULL, protocol_version TEXT NOT NULL CHECK(protocol_version IN ('2026-07-28','2025-11-25')), transport_kind TEXT NOT NULL CHECK(transport_kind IN ('http','stdio')),
 logical_rpc_id TEXT NOT NULL, request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64), request_bytes INTEGER NOT NULL CHECK(request_bytes BETWEEN 1 AND 1048576),
 proposal_part_id TEXT NOT NULL REFERENCES message_parts(id), proposal_sha256 TEXT NOT NULL CHECK(length(proposal_sha256)=64), approval_sha256 TEXT NOT NULL CHECK(length(approval_sha256)=64),
 state TEXT NOT NULL CHECK(state IN ('prepared','dispatch-intent','response-terminal','uncertain','not-dispatched')),
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991), transport_cleanup_confirmed INTEGER CHECK(transport_cleanup_confirmed IN (0,1)),
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) BETWEEN 1 AND 16384)
) STRICT;
CREATE INDEX mcp_executions_session ON mcp_executions(session_id);
CREATE INDEX mcp_executions_run ON mcp_executions(run_id);
CREATE INDEX mcp_executions_turn ON mcp_executions(turn_id);
CREATE INDEX mcp_executions_workspace_blocked ON mcp_executions(workspace_id) WHERE state IN ('dispatch-intent','uncertain') OR transport_cleanup_confirmed=0;
CREATE INDEX mcp_executions_pending ON mcp_executions(state) WHERE state IN ('prepared','dispatch-intent');
CREATE INDEX mcp_native_tool_proposals ON message_parts(json_extract(data,'$.toolCallId')) WHERE json_extract(data,'$.type')='tool';`;

export type McpExecutionState = 'prepared' | 'dispatch-intent' | 'response-terminal' | 'uncertain' | 'not-dispatched';
export type McpDispatchBoundary = 'http-fetch' | 'stdio-write' | 'legacy-api-entry';
export type McpExecutionReason = 'response' | 'timeout' | 'disconnect' | 'cancel' | 'transport-error' | 'invalid-response' | 'cleanup-error' | 'restart' | 'journal-error' | 'preflight-error';
export interface McpExecutionIdentity {
  toolCallId: string; sessionId: string; workspaceId: string; runId: string; turnId: string; attemptId: string;
  providerId: string; modelId: string; contextRevisionId?: string; toolName: string;
  approvalId: string; approvalFingerprint: string; serverId: string; connectionId: string; catalogueRevision: number; remoteTool: string;
  protocolVersion: '2026-07-28' | '2025-11-25'; transportKind: 'http' | 'stdio'; logicalRpcId: number | string;
  requestProjection: 'mcp-jsonrpc-tools-call-v1'; requestSha256: string; requestBytes: number;
}
export interface McpExecutionSettlement {
  outcome: 'response-terminal' | 'uncertain' | 'not-dispatched'; reason: McpExecutionReason;
  /** Only request-local reader/body/pending cleanup, never peer abort or shared-process termination. */
  transportCleanupConfirmed: boolean; errorCode?: string;
  responseKind?: 'tool-result' | 'jsonrpc-error'; responseSha256?: string; responseBytes?: number; isError?: boolean;
}
export interface McpExecutionRecord extends McpExecutionIdentity {
  schemaVersion: 2; revision: number; state: McpExecutionState;
  proposalPartId: string; proposalSha256: string; approvalSha256: string;
  createdAt: string; updatedAt: string; dispatchedAt?: string; settledAt?: string; dispatchBoundary?: McpDispatchBoundary;
  reason?: McpExecutionReason; errorCode?: string; responseKind?: 'tool-result' | 'jsonrpc-error'; responseSha256?: string; responseBytes?: number; isError?: boolean;
  transportCleanupConfirmed: boolean | null; remoteResponseObserved: boolean; effectsUncertain: boolean; executionBlocked: boolean;
}
const IDENTITY_KEYS = ['toolCallId','sessionId','workspaceId','runId','turnId','attemptId','providerId','modelId','contextRevisionId','toolName','approvalId','approvalFingerprint','serverId','connectionId','catalogueRevision','remoteTool','protocolVersion','transportKind','logicalRpcId','requestProjection','requestSha256','requestBytes'] as const;
const OBSERVATION_KEYS = ['outcome','reason','transportCleanupConfirmed','errorCode','responseKind','responseSha256','responseBytes','isError'] as const;
const RECORD_KEYS = [...IDENTITY_KEYS,'schemaVersion','revision','state','proposalPartId','proposalSha256','approvalSha256','createdAt','updatedAt','dispatchedAt','settledAt','dispatchBoundary','reason','errorCode','responseKind','responseSha256','responseBytes','isError','transportCleanupConfirmed','remoteResponseObserved','effectsUncertain','executionBlocked'] as const;
const REASONS: readonly McpExecutionReason[] = ['response','timeout','disconnect','cancel','transport-error','invalid-response','cleanup-error','restart','journal-error','preflight-error'];
const TERMINAL = new Set<McpExecutionState>(['response-terminal','uncertain','not-dispatched']);
type Row = Record<string, unknown>;
const HEADER_TEXT_FIELDS = ['tool_call_id','session_id','workspace_id','run_id','turn_id','attempt_id','approval_id','approval_fingerprint','provider_id','model_id','context_revision_id','tool_name','server_id','connection_id','remote_tool','protocol_version','transport_kind','logical_rpc_id','request_sha256','proposal_part_id','proposal_sha256','approval_sha256','state'] as const;
const HEADER_PROJECTION = HEADER_TEXT_FIELDS.map(key => `CASE WHEN length(CAST(${key} AS BLOB))<=${key==='logical_rpc_id'?512:256} THEN ${key} ELSE NULL END AS ${key}`).join(',');
function fail(suffix: string, message: string): never { throw new EngineError(`MCP_EXECUTION_${suffix}`, message); }
function id(value: unknown): value is string { return typeof value === 'string' && Buffer.byteLength(value) >= 1 && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value); }
function sha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function instant(value: unknown): value is string { return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function plain(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID', 'MCP execution records require plain data');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID', 'MCP execution records reject accessors and unknown fields');
  }
}
function size(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) fail('LIMIT', 'MCP selected evidence exceeds its bounded read limit');
  return Number(value);
}
function parse(raw: unknown): unknown {
  if (typeof raw !== 'string') return fail('BINDING_MISMATCH', 'MCP evidence changed between its owner header and body read');
  try { return JSON.parse(raw); } catch { return fail('INVALID', 'Stored MCP evidence contains invalid JSON'); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Row)[key])).join(',') + '}';
  return JSON.stringify(value)!;
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function picked(value: McpExecutionIdentity): McpExecutionIdentity { return Object.fromEntries(IDENTITY_KEYS.filter(key => value[key] !== undefined).map(key => [key, value[key]])) as unknown as McpExecutionIdentity; }
function identity(value: McpExecutionIdentity): McpExecutionIdentity {
  plain(value, IDENTITY_KEYS);
  for (const key of ['toolCallId','sessionId','workspaceId','runId','turnId','attemptId','providerId','modelId','toolName','approvalId','connectionId'] as const) if (!id(value[key])) fail('INVALID', 'MCP execution owner is invalid');
  if (value.contextRevisionId !== undefined && !id(value.contextRevisionId) || typeof value.serverId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(value.serverId)
    || typeof value.remoteTool !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/u.test(value.remoteTool) || !sha(value.approvalFingerprint) || !sha(value.requestSha256)
    || !Number.isSafeInteger(value.catalogueRevision) || value.catalogueRevision < 0 || !['2026-07-28','2025-11-25'].includes(value.protocolVersion)
    || !['http','stdio'].includes(value.transportKind) || !(typeof value.logicalRpcId === 'number' ? Number.isSafeInteger(value.logicalRpcId) && value.logicalRpcId > 0 : id(value.logicalRpcId) && Buffer.byteLength(value.logicalRpcId) <= 128)
    || value.requestProjection !== 'mcp-jsonrpc-tools-call-v1' || !Number.isSafeInteger(value.requestBytes) || value.requestBytes < 1 || value.requestBytes > MCP_EXECUTION_LIMITS.maxMessageBytes) fail('INVALID', 'MCP request or authorization identity is invalid');
  return structuredClone(value);
}
function observation(value: McpExecutionSettlement): McpExecutionSettlement {
  plain(value, OBSERVATION_KEYS);
  if (!['response-terminal','uncertain','not-dispatched'].includes(value.outcome) || !REASONS.includes(value.reason) || typeof value.transportCleanupConfirmed !== 'boolean'
    || value.errorCode !== undefined && !id(value.errorCode)) fail('INVALID', 'MCP settlement is invalid');
  const fields = [value.responseKind,value.responseSha256,value.responseBytes,value.isError];
  const response = fields.some(field => field !== undefined);
  if (response && (!['tool-result','jsonrpc-error'].includes(value.responseKind!) || !sha(value.responseSha256) || !Number.isSafeInteger(value.responseBytes)
    || value.responseBytes! < 1 || value.responseBytes! > MCP_EXECUTION_LIMITS.maxMessageBytes || value.isError !== undefined && typeof value.isError !== 'boolean'
    || value.responseKind === 'jsonrpc-error' && value.isError === false)) fail('INVALID', 'MCP terminal response requires its exact bounded observation');
  if (value.outcome === 'response-terminal' && (!response || value.reason !== 'response' || !value.transportCleanupConfirmed)
    || value.outcome !== 'response-terminal' && value.reason === 'response'
    || value.outcome === 'not-dispatched' && (response || !['cancel','preflight-error','transport-error','journal-error','restart'].includes(value.reason))) fail('INVALID', 'MCP settlement cannot invent dispatch or terminal response proof');
  return { ...structuredClone(value), ...(response ? {isError:value.responseKind==='jsonrpc-error'||value.isError===true} : {}) };
}
function flags(state: McpExecutionState, transport: boolean | null, response: boolean) {
  return { remoteResponseObserved: response, effectsUncertain: ['dispatch-intent','uncertain'].includes(state) && !response,
    executionBlocked: ['dispatch-intent','uncertain'].includes(state) || transport === false };
}
function validateRecord(value: McpExecutionRecord): void {
  plain(value, RECORD_KEYS); identity(picked(value));
  if (value.schemaVersion !== 2 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !['prepared','dispatch-intent','response-terminal','uncertain','not-dispatched'].includes(value.state)
    || !id(value.proposalPartId) || !sha(value.proposalSha256) || !sha(value.approvalSha256) || !instant(value.createdAt) || !instant(value.updatedAt)
    || value.dispatchedAt !== undefined && !instant(value.dispatchedAt) || value.settledAt !== undefined && !instant(value.settledAt)) fail('INVALID', 'Stored MCP execution lifecycle is invalid');
  if (TERMINAL.has(value.state)) {
    if(canonical(observation(toObservation(value)))!==canonical(toObservation(value)))fail('INVALID','Stored MCP terminal response flags are not canonical');
    if (!value.settledAt || (value.state === 'not-dispatched' ? value.dispatchedAt !== undefined : !value.dispatchedAt)) fail('INVALID', 'Stored MCP execution frontier is inconsistent');
  } else if (value.transportCleanupConfirmed !== null || value.settledAt !== undefined || value.reason !== undefined || value.errorCode !== undefined || value.responseKind !== undefined || value.responseSha256 !== undefined || value.responseBytes !== undefined || value.isError !== undefined) fail('INVALID', 'Pending MCP execution cannot contain terminal observations');
  if ((value.state === 'prepared' || value.state === 'not-dispatched') !== (value.dispatchedAt === undefined) || (!!value.dispatchedAt) !== (value.dispatchBoundary !== undefined)
    || value.dispatchBoundary !== undefined && !['http-fetch','stdio-write','legacy-api-entry'].includes(value.dispatchBoundary)
    || value.dispatchBoundary === 'http-fetch' && value.transportKind !== 'http' || value.dispatchBoundary === 'stdio-write' && value.transportKind !== 'stdio'
    || value.updatedAt < value.createdAt || value.dispatchedAt !== undefined && (value.dispatchedAt < value.createdAt || value.dispatchedAt > value.updatedAt)
    || value.settledAt !== undefined && (value.settledAt < (value.dispatchedAt ?? value.createdAt) || value.settledAt !== value.updatedAt)) fail('INVALID', 'MCP lifecycle timestamps and dispatch boundary disagree');
  const expected = flags(value.state, value.transportCleanupConfirmed, value.responseKind !== undefined);
  for (const key of ['remoteResponseObserved','effectsUncertain','executionBlocked'] as const) if (value[key] !== expected[key]) fail('INVALID', 'MCP uncertainty flags disagree with their durable observations');
}
function toObservation(value: McpExecutionRecord): McpExecutionSettlement {
  return { outcome: value.state as McpExecutionSettlement['outcome'], reason: value.reason!, transportCleanupConfirmed: value.transportCleanupConfirmed!,
    ...Object.fromEntries(['errorCode','responseKind','responseSha256','responseBytes','isError'].filter(key => value[key as keyof McpExecutionRecord] !== undefined).map(key => [key,value[key as keyof McpExecutionRecord]])) };
}
export function canonicalMcpExecutionSha256(value: McpExecutionRecord): string { validateRecord(value); return digest(value); }

/** A tools/call receipt records local dispatch intent and a peer-declared outcome, never remote acceptance or abort. */
export class McpExecutionStorage {
  constructor(private readonly native: NativeSessionStorage, private readonly appendLegacy: (run: Run, type: string, payload: JsonObject) => EngineEvent) {}
  private get db() { return this.native.database; }
  private body(table: 'runs' | 'sessions' | 'workspaces' | 'provider_attempts' | 'session_turns' | 'tools' | 'approvals', key: string, bytes: unknown): unknown {
    return parse(readEvidenceBody(this.db, { table, key }, { expectedBytes: size(bytes, MCP_EXECUTION_LIMITS.maxOwnerBytes), maxBytes: MCP_EXECUTION_LIMITS.maxOwnerBytes }));
  }
  private owner(input: McpExecutionIdentity) {
    const row = this.db.prepare(`SELECT r.id,r.session_id,r.workspace_id,r.state,r.input_id,length(CAST(r.data AS BLOB)) AS run_bytes,
      s.workspace_id AS session_workspace_id,length(CAST(s.data AS BLOB)) AS session_bytes,length(CAST(w.data AS BLOB)) AS workspace_bytes,
      t.session_id AS turn_session_id,t.run_id AS turn_run_id,t.state AS turn_state,t.turn_index,length(CAST(t.data AS BLOB)) AS turn_bytes,
      a.session_id AS attempt_session_id,a.run_id AS attempt_run_id,a.turn_id AS attempt_turn_id,a.state AS attempt_state,a.attempt_index,length(CAST(a.data AS BLOB)) AS attempt_bytes,
      c.session_id AS tool_session_id,c.run_id AS tool_run_id,c.state AS tool_state,length(CAST(c.data AS BLOB)) AS tool_bytes,
      p.session_id AS approval_session_id,p.run_id AS approval_run_id,p.tool_call_id,p.status,length(CAST(p.data AS BLOB)) AS approval_bytes
      FROM runs r JOIN sessions s ON s.id=r.session_id JOIN workspaces w ON w.id=r.workspace_id
      JOIN session_turns t ON t.id=? JOIN provider_attempts a ON a.id=? JOIN tools c ON c.id=? JOIN approvals p ON p.id=? WHERE r.id=?`)
      .get(input.turnId,input.attemptId,input.toolCallId,input.approvalId,input.runId);
    if (!row || row.session_id !== input.sessionId || row.workspace_id !== input.workspaceId || row.session_workspace_id !== input.workspaceId
      || row.turn_session_id !== input.sessionId || row.turn_run_id !== input.runId || row.attempt_session_id !== input.sessionId || row.attempt_run_id !== input.runId || row.attempt_turn_id !== input.turnId
      || row.tool_session_id !== input.sessionId || row.tool_run_id !== input.runId || row.approval_session_id !== input.sessionId || row.approval_run_id !== input.runId || row.tool_call_id !== input.toolCallId || row.status !== 'allowed') fail('BINDING_MISMATCH', 'MCP Run, native execution, tool and approval SQL owners disagree');
    for (const key of ['run_bytes','session_bytes','workspace_bytes','turn_bytes','attempt_bytes','tool_bytes','approval_bytes']) size(row[key],MCP_EXECUTION_LIMITS.maxOwnerBytes);
    const run = this.body('runs',input.runId,row.run_bytes) as Run, session = this.body('sessions',input.sessionId,row.session_bytes) as Row, workspace = this.body('workspaces',input.workspaceId,row.workspace_bytes) as Row;
    const turn = validateTurnRecord(this.body('session_turns',input.turnId,row.turn_bytes)), attempt = validateProviderAttempt(this.body('provider_attempts',input.attemptId,row.attempt_bytes));
    const tool = this.body('tools',input.toolCallId,row.tool_bytes) as ToolCallRecord, approval = this.body('approvals',input.approvalId,row.approval_bytes) as ApprovalRecord;
    if (run.id !== input.runId || run.sessionId !== input.sessionId || run.workspaceId !== input.workspaceId || run.inputId !== row.input_id || run.state !== row.state || run.config?.providerId !== input.providerId || run.config?.modelId !== input.modelId
      || session?.id !== input.sessionId || session.workspaceId !== input.workspaceId || workspace?.id !== input.workspaceId
      || turn.id !== input.turnId || turn.sessionId !== input.sessionId || turn.runId !== input.runId || turn.index !== row.turn_index || turn.state !== row.turn_state
      || attempt.id !== input.attemptId || attempt.sessionId !== input.sessionId || attempt.runId !== input.runId || attempt.turnId !== input.turnId || attempt.index !== row.attempt_index || attempt.state !== row.attempt_state
      || attempt.providerId !== input.providerId || attempt.modelId !== input.modelId || attempt.contextRevisionId !== input.contextRevisionId
      || tool?.id !== input.toolCallId || tool.runId !== input.runId || tool.sessionId !== input.sessionId || tool.name !== input.toolName || tool.state !== row.tool_state
      || approval?.id !== input.approvalId || approval.runId !== input.runId || approval.sessionId !== input.sessionId || approval.toolCallId !== input.toolCallId || approval.toolName !== input.toolName || approval.status !== 'allowed' || approval.fingerprint !== input.approvalFingerprint) fail('BINDING_MISMATCH', 'MCP payload disagrees with its native owner or matching allowed outer approval');
    if (!approval.preview || approval.preview.serverId !== input.serverId || approval.preview.remoteTool !== input.remoteTool || approval.preview.catalogueRevision !== input.catalogueRevision
      || canonical(approval.preview.arguments) !== canonical(tool.input)) fail('BINDING_MISMATCH','MCP server, remote tool, catalogue and input must match the exact allowed approval preview');
    const latest = this.db.prepare('SELECT id FROM provider_attempts WHERE turn_id=? ORDER BY attempt_index DESC LIMIT 1').get(input.turnId);
    if (latest?.id !== input.attemptId) fail('BINDING_MISMATCH', 'MCP owner must be the latest native provider attempt for its Turn');
    if (input.contextRevisionId) {
      const context = this.db.prepare("SELECT id,session_id,run_id,turn_id,length(CAST(data AS BLOB)) AS bytes,json_extract(data,'$.id') AS payload_id,json_extract(data,'$.sessionId') AS payload_session_id,json_extract(data,'$.runId') AS payload_run_id,json_extract(data,'$.turnId') AS payload_turn_id FROM context_revisions WHERE id=?").get(input.contextRevisionId);
      if (!context || context.session_id !== input.sessionId || context.run_id !== null && context.run_id !== input.runId || context.turn_id !== null && context.turn_id !== input.turnId
        || context.id !== context.payload_id || context.session_id !== context.payload_session_id || context.run_id !== context.payload_run_id || context.turn_id !== context.payload_turn_id) fail('BINDING_MISMATCH', 'MCP context revision belongs to another native owner');
      size(context.bytes,MCP_EXECUTION_LIMITS.maxOwnerBytes);
    }
    const parts = this.db.prepare("SELECT id,session_id,run_id,turn_id,message_id,part_index,revision,state,length(CAST(json_remove(data,'$.result') AS BLOB)) AS bytes FROM message_parts WHERE json_extract(data,'$.type')='tool' AND json_extract(data,'$.toolCallId')=? LIMIT 2").all(input.toolCallId);
    const header = parts[0];
    if (parts.length !== 1 || !header || header.session_id !== input.sessionId || header.run_id !== input.runId || header.turn_id !== input.turnId) fail('BINDING_MISMATCH', 'MCP tool must have exactly one matching native proposal');
    const part = validateMessagePart(parse(readEvidenceBody(this.db,{table:'message_parts',key:String(header.id),projection:'mcp-proposal-v1'},{expectedBytes:size(header.bytes,MCP_EXECUTION_LIMITS.maxOwnerBytes),maxBytes:MCP_EXECUTION_LIMITS.maxOwnerBytes})));
    if (part.type !== 'tool' || part.id !== header.id || part.sessionId !== input.sessionId || part.runId !== input.runId || part.turnId !== input.turnId || part.messageId !== header.message_id || part.index !== header.part_index || part.revision !== header.revision || part.state !== header.state
      || part.toolCallId !== input.toolCallId || part.name !== input.toolName || canonical(part.input) !== canonical(tool.input)) fail('BINDING_MISMATCH', 'MCP native proposal and ToolRecord disagree');
    const proposal = Object.fromEntries(Object.entries(part).filter(([key]) => !['state','revision','completedAt','result'].includes(key)));
    return { run,turn,attempt,tool,part,proposalPartId:part.id,proposalSha256:digest(proposal),approvalSha256:digest(approval) };
  }
  private read(toolCallId: string, expectedSessionId?: string) {
    if (!id(toolCallId) || expectedSessionId !== undefined && !id(expectedSessionId)) fail('INVALID','MCP receipt lookup requires bounded identities');
    this.native.hooks.assertOpen();
    const row = this.db.prepare(`SELECT ${HEADER_PROJECTION},context_revision_id IS NOT NULL AND length(CAST(context_revision_id AS BLOB))>256 AS invalid_context,CAST(catalogue_revision AS TEXT) AS catalogue_revision,CAST(request_bytes AS TEXT) AS request_bytes,CAST(revision AS TEXT) AS safe_revision,CAST(transport_cleanup_confirmed AS TEXT) AS transport_cleanup_confirmed,length(CAST(data AS BLOB)) AS bytes FROM mcp_executions WHERE tool_call_id=?`).get(toolCallId);
    if (!row) fail('NOT_FOUND','MCP dispatch receipt was not recorded');
    if (expectedSessionId !== undefined && row.session_id !== expectedSessionId) fail('BINDING_MISMATCH','MCP receipt belongs to another session');
    return this.readHeader(row,toolCallId);
  }
  private readHeader(row: Row, toolCallId: string) {
    size(row.bytes,MCP_EXECUTION_LIMITS.maxRecordBytes);
    if (HEADER_TEXT_FIELDS.some(key => !['context_revision_id','logical_rpc_id'].includes(key) && !id(row[key])) || row.context_revision_id !== null && !id(row.context_revision_id) || row.invalid_context !== 0
      || typeof row.logical_rpc_id !== 'string' || Buffer.byteLength(row.logical_rpc_id)>512
      || !Number.isSafeInteger(Number(row.safe_revision)) || Number(row.safe_revision)<1 || !['prepared','dispatch-intent','response-terminal','uncertain','not-dispatched'].includes(String(row.state))
      || ![null,'0','1'].includes(row.transport_cleanup_confirmed as string|null)) fail('INVALID','Stored MCP receipt metadata is outside its bounded schema');
    const input: McpExecutionIdentity = {toolCallId:row.tool_call_id as string,sessionId:row.session_id as string,workspaceId:row.workspace_id as string,runId:row.run_id as string,turnId:row.turn_id as string,attemptId:row.attempt_id as string,providerId:row.provider_id as string,modelId:row.model_id as string,toolName:row.tool_name as string,approvalId:row.approval_id as string,approvalFingerprint:row.approval_fingerprint as string,serverId:row.server_id as string,connectionId:row.connection_id as string,catalogueRevision:Number(row.catalogue_revision),remoteTool:row.remote_tool as string,protocolVersion:row.protocol_version as McpExecutionIdentity['protocolVersion'],transportKind:row.transport_kind as McpExecutionIdentity['transportKind'],logicalRpcId:parse(row.logical_rpc_id) as number|string,requestProjection:'mcp-jsonrpc-tools-call-v1',requestSha256:row.request_sha256 as string,requestBytes:Number(row.request_bytes),...(row.context_revision_id===null?{}:{contextRevisionId:row.context_revision_id as string})};
    identity(input); const owner = this.owner(input);
    const value = parse(readEvidenceBody(this.db,{table:'mcp_executions',key:toolCallId},{expectedBytes:Number(row.bytes),maxBytes:MCP_EXECUTION_LIMITS.maxRecordBytes})) as McpExecutionRecord;
    validateRecord(value);
    if (canonical(picked(value)) !== canonical(input) || value.revision !== Number(row.safe_revision) || value.state !== row.state || value.proposalPartId !== row.proposal_part_id || value.proposalSha256 !== row.proposal_sha256 || value.approvalSha256 !== row.approval_sha256
      || value.transportCleanupConfirmed !== (row.transport_cleanup_confirmed === null ? null : row.transport_cleanup_confirmed === '1')
      || value.proposalPartId !== owner.proposalPartId || value.proposalSha256 !== owner.proposalSha256 || value.approvalSha256 !== owner.approvalSha256) fail('BINDING_MISMATCH','MCP receipt body, immutable proposal or approval disagrees with its SQL metadata');
    return { value,...owner };
  }
  private scope<T>(operation: () => T): T { return this.db.isTransaction ? withEvidenceRead(this.db,operation) : this.native.hooks.transaction(() => withEvidenceRead(this.db,operation)); }
  get(toolCallId: string, expectedSessionId?: string): McpExecutionRecord { return this.scope(() => this.read(toolCallId,expectedSessionId).value); }
  private save(value: McpExecutionRecord, run: Run, expectedRevision?: number): McpExecutionRecord {
    validateRecord(value); const data = JSON.stringify(value); size(Buffer.byteLength(data),MCP_EXECUTION_LIMITS.maxRecordBytes);
    invalidateEvidenceRead(this.db);
    if (expectedRevision === undefined) this.db.prepare(`INSERT INTO mcp_executions(tool_call_id,session_id,workspace_id,run_id,turn_id,attempt_id,approval_id,approval_fingerprint,provider_id,model_id,context_revision_id,tool_name,server_id,connection_id,catalogue_revision,remote_tool,protocol_version,transport_kind,logical_rpc_id,request_sha256,request_bytes,proposal_part_id,proposal_sha256,approval_sha256,state,revision,transport_cleanup_confirmed,data) VALUES(${Array(28).fill('?').join(',')})`).run(value.toolCallId,value.sessionId,value.workspaceId,value.runId,value.turnId,value.attemptId,value.approvalId,value.approvalFingerprint,value.providerId,value.modelId,value.contextRevisionId??null,value.toolName,value.serverId,value.connectionId,value.catalogueRevision,value.remoteTool,value.protocolVersion,value.transportKind,JSON.stringify(value.logicalRpcId),value.requestSha256,value.requestBytes,value.proposalPartId,value.proposalSha256,value.approvalSha256,value.state,value.revision,value.transportCleanupConfirmed===null?null:Number(value.transportCleanupConfirmed),data);
    else if (this.db.prepare('UPDATE mcp_executions SET state=?,revision=?,transport_cleanup_confirmed=?,data=? WHERE tool_call_id=? AND revision=?').run(value.state,value.revision,value.transportCleanupConfirmed===null?null:Number(value.transportCleanupConfirmed),data,value.toolCallId,expectedRevision).changes !== 1) fail('CONFLICT','MCP receipt revision changed before publication');
    const type = 'mcp.execution.' + value.state.replaceAll('-','_'), payload = { execution: JSON.parse(data) as JsonObject };
    this.native.appendEvent(value.sessionId,type,payload,{runId:value.runId,turnId:value.turnId,attemptId:value.attemptId}); this.appendLegacy(run,type,payload);
    if (value.executionBlocked && TERMINAL.has(value.state)) this.native.setControlInTransaction(value.sessionId,true,'recovery_required');
    return value;
  }
  create(supplied: McpExecutionIdentity): McpExecutionRecord {
    const input = identity(supplied);
    return this.native.write(input.sessionId,() => withEvidenceRead(this.db,() => {
      if (this.db.prepare('SELECT tool_call_id FROM mcp_executions WHERE tool_call_id=?').get(input.toolCallId)) {
        const current = this.read(input.toolCallId,input.sessionId).value;
        if (canonical(picked(current)) !== canonical(input)) fail('CONFLICT','Tool call already owns a different MCP execution identity');
        return current;
      }
      const owner = this.owner(input); this.requireDispatchable(owner);
      const createdAt = new Date().toISOString();
      return this.save({...input,schemaVersion:2,revision:1,state:'prepared',proposalPartId:owner.proposalPartId,proposalSha256:owner.proposalSha256,approvalSha256:owner.approvalSha256,createdAt,updatedAt:createdAt,transportCleanupConfirmed:null,...flags('prepared',null,false)},owner.run);
    }));
  }
  private requireDispatchable(owner: ReturnType<McpExecutionStorage['owner']>): void {
    if (isTerminal(owner.run.state) || owner.run.state !== 'running' || owner.turn.state !== 'awaiting_tools' || owner.attempt.state !== 'completed' || owner.tool.state !== 'running' || owner.part.state !== 'open') fail('TRANSITION_INVALID','MCP dispatch requires a live Run, settled provider attempt and approved running native proposal');
  }
  private update<T>(toolCallId: string, operation: (owner: ReturnType<McpExecutionStorage['read']>) => T): T {
    this.native.hooks.assertOpen(); if (!id(toolCallId)) fail('INVALID','MCP update requires a bounded tool call identity');
    const row = this.db.prepare('SELECT session_id FROM mcp_executions WHERE tool_call_id=?').get(toolCallId); if (!row) fail('NOT_FOUND','MCP dispatch receipt was not recorded');
    return this.native.write(String(row.session_id),() => withEvidenceRead(this.db,() => operation(this.read(toolCallId))));
  }
  dispatch(toolCallId: string, boundary: McpDispatchBoundary = 'legacy-api-entry'): McpExecutionRecord {
    if (!['http-fetch','stdio-write','legacy-api-entry'].includes(boundary)) fail('INVALID','MCP dispatch boundary is invalid');
    return this.update(toolCallId,owner => {
      const value = owner.value;
      if (value.state === 'dispatch-intent') {
        if (value.dispatchBoundary !== boundary) fail('CONFLICT','Recorded MCP dispatch boundary cannot change');
        return value;
      }
      if (value.state !== 'prepared') fail('TRANSITION_INVALID','A MCP tool call may record dispatch intent only once'); this.requireDispatchable(owner);
      const updatedAt = new Date().toISOString();
      return this.save({...value,state:'dispatch-intent',revision:value.revision+1,dispatchedAt:updatedAt,updatedAt,dispatchBoundary:boundary,...flags('dispatch-intent',null,false)},owner.run,value.revision);
    });
  }
  settle(toolCallId: string, supplied: McpExecutionSettlement): McpExecutionRecord {
    const selected = observation(supplied);
    return this.update(toolCallId,owner => this.settleInTransaction(owner,selected));
  }
  private settleInTransaction(owner: ReturnType<McpExecutionStorage['read']>, selected: McpExecutionSettlement): McpExecutionRecord {
    const value = owner.value;
    if (TERMINAL.has(value.state)) {
      if (canonical(toObservation(value)) !== canonical(selected)) fail('IMMUTABLE','A terminal MCP observation cannot be changed or reactivated');
      return value;
    }
    if (selected.outcome === 'not-dispatched' ? value.state !== 'prepared' : value.state !== 'dispatch-intent') fail('TRANSITION_INVALID','MCP observation disagrees with its durable dispatch frontier');
    const {outcome:state,...observed} = selected, updatedAt = new Date().toISOString();
    return this.save({...value,...observed,state,revision:value.revision+1,settledAt:updatedAt,updatedAt,...flags(state,selected.transportCleanupConfirmed,selected.responseKind!==undefined)},owner.run,value.revision);
  }
  recoverInTransaction(sessions: Set<string>): void {
    if (!this.db.isTransaction) throw new EngineError('STORAGE_TRANSACTION_REQUIRED','MCP startup settlement requires the shared primary transaction');
    withEvidenceRead(this.db,() => {
      while (true) {
        const rows = this.db.prepare("SELECT tool_call_id FROM mcp_executions WHERE state IN ('prepared','dispatch-intent') ORDER BY rowid LIMIT ?").all(MCP_EXECUTION_LIMITS.recoveryPageSize);
        if (!rows.length) break;
        for (const row of rows) {
          const owner = this.read(String(row.tool_call_id));
          this.settleInTransaction(owner,{outcome:owner.value.state==='prepared'?'not-dispatched':'uncertain',reason:'restart',transportCleanupConfirmed:owner.value.state==='prepared',errorCode:'ENGINE_INTERRUPTED'});
          sessions.add(owner.value.sessionId);
        }
      }
      let cursor = '0';
      while (true) {
        const rows = this.db.prepare("SELECT tool_call_id,CAST(rowid AS TEXT) AS cursor FROM mcp_executions WHERE rowid>? AND (state IN ('dispatch-intent','uncertain') OR transport_cleanup_confirmed=0) ORDER BY rowid LIMIT ?").all(cursor,MCP_EXECUTION_LIMITS.recoveryPageSize);
        if (!rows.length) break;
        for (const row of rows) {
          const {value} = this.read(String(row.tool_call_id));
          sessions.add(value.sessionId); this.native.setControlInTransaction(value.sessionId,true,'recovery_required');
          cursor = String(row.cursor);
        }
      }
    });
  }
}

/** Indexed existence only: neither original uncertainty nor a different domain's ACK is waived. */
export function hasMcpExecutionUncertainty(database: NativeSessionStorage['database'], workspaceId: string): boolean {
  if (!id(workspaceId)) return true;
  try { return database.prepare(`SELECT 1 FROM mcp_executions WHERE workspace_id=? AND (state IN ('dispatch-intent','uncertain') OR transport_cleanup_confirmed=0)
    UNION ALL SELECT 1 FROM runs r JOIN mcp_executions m INDEXED BY mcp_executions_run ON m.run_id=r.id
    WHERE r.workspace_id=? AND (m.state IN ('dispatch-intent','uncertain') OR m.transport_cleanup_confirmed=0) LIMIT 1`).get(workspaceId,workspaceId) !== undefined; }
  catch { return true; }
}
