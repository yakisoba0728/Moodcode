import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { EngineError, type EngineEvent, type JsonObject, type Run, type ToolCallRecord } from '@moodcode/contracts';
import { validateMessagePart, validateProviderAttempt, validateTurnRecord } from '@moodcode/contracts/validation';
import { canonical } from '../recovery/snapshot.js';
import { readEvidenceBody, withEvidenceRead, type EvidenceTable } from './evidence-read.js';
import type { McpExecutionRecord } from './mcp-executions.js';
import type { NativeSessionStorage } from './native.js';

export const TOOL_RECOVERY_FRONTIER_LIMITS = Object.freeze({ maxCandidates: 1024, pageSize: 64, maxOwnerBytes: 1_048_576 });
export interface ToolRecoveryFrontier {
  schemaVersion: 1; scope: 'native-running-tool-intent'; sessionId: string; workspaceId: string; runId: string;
  turnId: string; attemptId: string; toolCallId: string; toolName: string; proposalPartId: string;
  providerId: string; modelId: string; contextRevisionId?: string; originalToolOrdinal: string;
  originalToolState: 'running'; toolRecordSha256: string; proposalSha256: string; turnRecordSha256: string;
  attemptRecordSha256: string; capturedAt: string; effectOutcome: 'unknown'; callbackEntry: 'unverified';
}
export type ToolRecoveryFrontiers = ReadonlyMap<string, readonly ToolRecoveryFrontier[]>;
interface Options {
  getMcpExecution(toolCallId: string, expectedSessionId: string): McpExecutionRecord;
  appendLegacy(run: Run, type: string, payload: JsonObject): EngineEvent;
}
type Row = Record<string, unknown>;
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function fail(suffix: string, message: string): never { throw new EngineError('TOOL_RECOVERY_FRONTIER_' + suffix, message); }
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value); }
function bytes(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > TOOL_RECOVERY_FRONTIER_LIMITS.maxOwnerBytes) fail('LIMIT', 'Selected original tool evidence exceeds its record byte limit');
  return Number(value);
}
function object(value: unknown): value is Row { return !!value && typeof value === 'object' && !Array.isArray(value); }
function body(db: DatabaseSync, table: EvidenceTable, key: string, length: unknown): Row {
  const raw = readEvidenceBody(db, { table, key }, { expectedBytes: bytes(length), maxBytes: TOOL_RECOVERY_FRONTIER_LIMITS.maxOwnerBytes });
  if (raw === undefined) fail('SOURCE_CHANGED', 'Selected original tool evidence changed before its bounded body read');
  let value: unknown; try { value = JSON.parse(raw); } catch { fail('INVALID', 'Original tool evidence is not valid JSON'); }
  if (!object(value)) fail('INVALID', 'Original tool evidence must be an object');
  return value;
}
function ownerHeader(db: DatabaseSync, selected: Row): Row {
  if (!id(selected.id) || !id(selected.session_id) || !id(selected.run_id) || typeof selected.cursor !== 'string' || !/^[1-9][0-9]*$/u.test(selected.cursor)) fail('BINDING_MISMATCH', 'Running tool SQL identity is invalid');
  const row = db.prepare(`SELECT r.id,CASE WHEN length(CAST(r.session_id AS BLOB))<=256 THEN r.session_id END AS session_id,
    CASE WHEN length(CAST(r.workspace_id AS BLOB))<=256 THEN r.workspace_id END AS workspace_id,
    CASE WHEN length(CAST(r.input_id AS BLOB))<=256 THEN r.input_id END AS input_id,
    CASE WHEN length(CAST(r.state AS BLOB))<=32 THEN r.state END AS state,length(CAST(r.data AS BLOB)) AS run_bytes,
    CASE WHEN length(CAST(s.workspace_id AS BLOB))<=256 THEN s.workspace_id END AS session_workspace_id,
    length(CAST(s.data AS BLOB)) AS session_bytes,length(CAST(w.data AS BLOB)) AS workspace_bytes
    FROM runs r JOIN sessions s ON s.id=r.session_id JOIN workspaces w ON w.id=r.workspace_id WHERE r.id=?`).get(selected.run_id);
  if (!row || row.id !== selected.run_id || row.session_id !== selected.session_id || !id(row.workspace_id) || row.session_workspace_id !== row.workspace_id) fail('BINDING_MISMATCH', 'Running tool Run, session and workspace SQL owners disagree');
  for (const key of ['run_bytes','session_bytes','workspace_bytes']) bytes(row[key]); bytes(selected.bytes);
  return row;
}
function owner(db: DatabaseSync, selected: Row, row: Row) {
  const run = body(db,'runs',String(row.id),row.run_bytes), session = body(db,'sessions',String(row.session_id),row.session_bytes), workspace = body(db,'workspaces',String(row.workspace_id),row.workspace_bytes);
  const tool = body(db,'tools',String(selected.id),selected.bytes);
  if (run.id !== row.id || run.sessionId !== row.session_id || run.workspaceId !== row.workspace_id || run.inputId !== row.input_id || run.state !== row.state
    || !object(run.config) || !id(run.config.providerId) || !id(run.config.modelId)
    || session.id !== row.session_id || session.workspaceId !== row.workspace_id || workspace.id !== row.workspace_id
    || Object.keys(tool).some(key => !['id','runId','sessionId','name','input','state','output','error'].includes(key))
    || tool.id !== selected.id || tool.sessionId !== selected.session_id || tool.runId !== selected.run_id || tool.state !== 'running' || !id(tool.name)
    || !Object.hasOwn(tool,'input') || tool.output !== undefined && typeof tool.output !== 'string' || tool.error !== undefined && typeof tool.error !== 'string') fail('BINDING_MISMATCH', 'Original running ToolRecord or Run payload disagrees with its SQL owner');
  return { run: run as unknown as Run, tool: tool as unknown as ToolCallRecord };
}

/** Capture intent before legacy recovery overwrites it. No callback entry or effect is inferred. */
export function captureToolRecoveryFrontiers(native: NativeSessionStorage, options: Options): ToolRecoveryFrontiers {
  const db = native.database;
  if (!db.isTransaction) fail('TRANSACTION_REQUIRED', 'Tool frontier capture requires the shared recovery transaction');
  return withEvidenceRead(db, () => {
    const count = db.prepare("SELECT count(*) AS count FROM tools WHERE state='running'").get()?.count;
    if (!Number.isSafeInteger(count) || Number(count) > TOOL_RECOVERY_FRONTIER_LIMITS.maxCandidates) fail('LIMIT', 'Running tool candidate count exceeds the bounded recovery inspection');
    const result = new Map<string, ToolRecoveryFrontier[]>(), audits: {run:Run;type:string;payload:JsonObject;turnId?:string;attemptId?:string}[] = []; let cursor = '0';
    while (true) {
      const rows = db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id ELSE NULL END AS id,
        CASE WHEN length(CAST(session_id AS BLOB))<=256 THEN session_id ELSE NULL END AS session_id,
        CASE WHEN length(CAST(run_id AS BLOB))<=256 THEN run_id ELSE NULL END AS run_id,CAST(ordinal AS TEXT) AS cursor,length(CAST(data AS BLOB)) AS bytes
        FROM tools WHERE state='running' AND ordinal>? ORDER BY ordinal LIMIT ?`).all(cursor,TOOL_RECOVERY_FRONTIER_LIMITS.pageSize);
      if (!rows.length) break;
      for (const selected of rows) {
        const header = ownerHeader(db,selected); cursor = String(selected.cursor);
        const partRows = db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END AS id,
          CASE WHEN length(CAST(session_id AS BLOB))<=256 THEN session_id END AS session_id,
          CASE WHEN length(CAST(run_id AS BLOB))<=256 THEN run_id END AS run_id,
          CASE WHEN length(CAST(turn_id AS BLOB))<=256 THEN turn_id END AS turn_id,
          CASE WHEN length(CAST(message_id AS BLOB))<=256 THEN message_id END AS message_id,
          CAST(part_index AS TEXT) AS part_index,CAST(revision AS TEXT) AS revision,CASE WHEN length(CAST(state AS BLOB))<=32 THEN state END AS state,
          length(CAST(json_remove(data,'$.result') AS BLOB)) AS bytes FROM message_parts
          WHERE json_extract(data,'$.type')='tool' AND json_extract(data,'$.toolCallId')=? LIMIT 2`).all(String(selected.id));
        if (!partRows.length && !db.prepare('SELECT 1 FROM session_turns WHERE run_id=? LIMIT 1').get(String(selected.run_id))) {
          const {run,tool} = owner(db,selected,header);
          // Older v1 rows have no authoritative native execution owner. Record
          // the observation's missing coverage; never fabricate a Turn or proof.
          const payload: JsonObject = { coverage:'unchecked-no-native-execution',toolCallId:tool.id,originalToolState:'running',toolRecordSha256:digest(tool),originalToolOrdinal:cursor,effectOutcome:'unknown' };
          audits.push({run,type:'tool.recovery_frontier.unchecked',payload});
          continue;
        }
        const p = partRows[0];
        if (partRows.length !== 1 || !p || !id(p.id) || !id(p.turn_id) || !id(p.message_id) || p.session_id !== selected.session_id || p.run_id !== selected.run_id) fail('BINDING_MISMATCH', 'Running native tool requires exactly one proposal with the same SQL owner');
        const t = db.prepare(`SELECT id,CASE WHEN length(CAST(session_id AS BLOB))<=256 THEN session_id END AS session_id,
          CASE WHEN length(CAST(run_id AS BLOB))<=256 THEN run_id END AS run_id,CAST(turn_index AS TEXT) AS turn_index,
          CASE WHEN length(CAST(state AS BLOB))<=32 THEN state END AS state,length(CAST(data AS BLOB)) AS bytes FROM session_turns WHERE id=?`).get(p.turn_id);
        const a = db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB))<=256 THEN id END AS id,
          CASE WHEN length(CAST(session_id AS BLOB))<=256 THEN session_id END AS session_id,
          CASE WHEN length(CAST(run_id AS BLOB))<=256 THEN run_id END AS run_id,turn_id,CAST(attempt_index AS TEXT) AS attempt_index,
          CASE WHEN length(CAST(state AS BLOB))<=32 THEN state END AS state,length(CAST(data AS BLOB)) AS bytes FROM provider_attempts WHERE turn_id=? ORDER BY attempt_index DESC LIMIT 1`).get(p.turn_id);
        if (!t || !a || !id(a.id) || t.session_id !== selected.session_id || t.run_id !== selected.run_id || a.session_id !== selected.session_id || a.run_id !== selected.run_id || a.turn_id !== t.id) fail('BINDING_MISMATCH', 'Running proposal, Turn and latest Attempt SQL owners disagree');
        for (const row of [p,t,a]) bytes(row.bytes);
        for (const [row,key] of [[p,'part_index'],[p,'revision'],[t,'turn_index'],[a,'attempt_index']] as const) if (typeof row[key] !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(String(row[key])) || !Number.isSafeInteger(Number(row[key]))) fail('BINDING_MISMATCH','Native original tool indexes must be safe integers');
        const {run,tool} = owner(db,selected,header);
        const rawPart = readEvidenceBody(db,{table:'message_parts',key:String(p.id),projection:'mcp-proposal-v1'},{expectedBytes:Number(p.bytes),maxBytes:TOOL_RECOVERY_FRONTIER_LIMITS.maxOwnerBytes});
        if (rawPart === undefined) fail('SOURCE_CHANGED', 'Original native proposal changed before its bounded read');
        const part = validateMessagePart(JSON.parse(rawPart)), turn = validateTurnRecord(body(db,'session_turns',String(t.id),t.bytes)), attempt = validateProviderAttempt(body(db,'provider_attempts',String(a.id),a.bytes));
        if (part.type !== 'tool' || part.id !== p.id || part.sessionId !== run.sessionId || part.runId !== run.id || part.turnId !== t.id || part.messageId !== p.message_id || part.index !== Number(p.part_index) || part.revision !== Number(p.revision) || part.state !== p.state || part.toolCallId !== tool.id || part.name !== tool.name || canonical(part.input) !== canonical(tool.input)
          || turn.id !== t.id || turn.sessionId !== run.sessionId || turn.runId !== run.id || turn.index !== Number(t.turn_index) || turn.state !== t.state
          || attempt.id !== a.id || attempt.sessionId !== run.sessionId || attempt.runId !== run.id || attempt.turnId !== turn.id || attempt.index !== Number(a.attempt_index) || attempt.state !== a.state
          || attempt.providerId !== run.config.providerId || attempt.modelId !== run.config.modelId) fail('BINDING_MISMATCH', 'Original running intent and native proposal/Turn/Attempt payloads disagree');
        if (attempt.contextRevisionId) {
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
            json_extract(data,'$.turnId') IS NOT NULL AND length(CAST(json_extract(data,'$.turnId') AS BLOB))>256 AS invalid_payload_turn FROM context_revisions WHERE id=?`).get(attempt.contextRevisionId);
          if (!context || context.session_id !== run.sessionId || context.run_id !== null && context.run_id !== run.id || context.turn_id !== null && context.turn_id !== turn.id
            || context.invalid_run !== 0 || context.invalid_turn !== 0 || context.invalid_payload_run !== 0 || context.invalid_payload_turn !== 0
            || context.id !== context.payload_id || context.session_id !== context.payload_session_id || context.run_id !== context.payload_run_id || context.turn_id !== context.payload_turn_id) fail('BINDING_MISMATCH','Running tool context revision belongs to another native owner');
          bytes(context.bytes);
        }
        if (db.prepare('SELECT 1 FROM mcp_executions WHERE tool_call_id=?').get(tool.id)) {
          const receipt = options.getMcpExecution(tool.id,run.sessionId);
          if (receipt.toolCallId !== tool.id || receipt.runId !== run.id || receipt.turnId !== turn.id || receipt.attemptId !== attempt.id || receipt.workspaceId !== run.workspaceId) fail('BINDING_MISMATCH','MCP receipt does not match the original running native owner');
          if (receipt.transportCleanupConfirmed === true && (receipt.state === 'not-dispatched' || receipt.state === 'response-terminal')) continue;
        }
        if (turn.state === 'uncertain') continue; // Preserve its existing independent blocker.
        if (turn.state !== 'awaiting_tools' || attempt.state !== 'completed' || part.state !== 'open') fail('UNSETTLED_OWNER','Unresolved running tools require an active awaiting-tools owner; terminal states cannot be rewritten');
        const frontier: ToolRecoveryFrontier = {schemaVersion:1,scope:'native-running-tool-intent',sessionId:run.sessionId,workspaceId:run.workspaceId,runId:run.id,turnId:turn.id,attemptId:attempt.id,toolCallId:tool.id,toolName:tool.name,proposalPartId:part.id,providerId:attempt.providerId,modelId:attempt.modelId,
          ...(attempt.contextRevisionId ? {contextRevisionId:attempt.contextRevisionId} : {}),originalToolOrdinal:cursor,originalToolState:'running',toolRecordSha256:digest(tool),proposalSha256:digest(Object.fromEntries(Object.entries(part).filter(([key])=>!['state','revision','completedAt','result'].includes(key)))),turnRecordSha256:digest(turn),attemptRecordSha256:digest(attempt),capturedAt:new Date().toISOString(),effectOutcome:'unknown',callbackEntry:'unverified'};
        const payload = {frontier:JSON.parse(JSON.stringify(frontier)) as JsonObject};
        audits.push({run,type:'tool.recovery_frontier',payload,turnId:turn.id,attemptId:attempt.id});
        const previous = result.get(turn.id) ?? []; previous.push(frontier); result.set(turn.id,previous);
      }
    }
    // Selecting later tools can reuse owner bodies before journal writes.
    // Journal owner checks after writes still consume this same read budget.
    for (const audit of audits) {
      native.appendEvent(audit.run.sessionId,audit.type,audit.payload,{runId:audit.run.id,...(audit.turnId ? {turnId:audit.turnId,attemptId:audit.attemptId} : {})});
      options.appendLegacy(audit.run,audit.type,audit.payload);
    }
    return result;
  });
}
