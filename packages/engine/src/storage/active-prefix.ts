import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { EngineError, type JsonObject, type Run } from '@moodcode/contracts';
import type { ActivePrefixSource, ActivePrefixSourceOptions, PreparedActivePrefix, ActivePrefixContextPublication } from '../context/active-prefix.js';

const DOCUMENT = 'context.active_memory';
const PROJECTION = 'text-and-complete-tool-observations-v1' as const;
const METADATA_LIMIT = 1024;
const METADATA_BYTES = 1_048_576;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function mismatch(message: string): never { throw new EngineError('ACTIVE_PREFIX_BINDING_MISMATCH', message); }
function limit(message: string): never { throw new EngineError('ACTIVE_PREFIX_SOURCE_LIMIT', message); }
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const ids = (value: unknown, max = 1024): value is string[] => Array.isArray(value) && value.length <= max && value.every(string) && new Set(value).size === value.length;
export function activePrefixCanonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(activePrefixCanonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + activePrefixCanonical((value as Record<string, unknown>)[key])).join(',') + '}';
  const encoded = JSON.stringify(value); if (encoded === undefined) mismatch('Active-prefix values must be JSON'); return encoded;
}
type Row = Record<string, unknown>;
interface MessageHeader { id: string; ordinal: number; role: string; images: boolean; bytes: number; toolCalls: number }
interface TurnHeader { id: string; index: number; state: string; attemptId: string; attemptState: string; media: boolean }
function options(value: ActivePrefixSourceOptions): void {
  if (!value || !/^[a-f0-9]{64}$/u.test(value.policySha256)) mismatch('Active-prefix policy digest is required');
  for (const [name, min, max] of [['maxSourceMessages', 1, 128], ['maxSourceBytes', 256, 65536], ['keepRecentTurns', 1, 16], ['maxCoveredMessages', 1, 1024]] as const) {
    if (!Number.isSafeInteger(value[name]) || value[name] < min || value[name] > max) mismatch('Active-prefix selection limits are invalid');
  }
  if (value.maxSourceMessages > value.maxCoveredMessages || value.stage !== 'between-turns' && value.stage !== 'overflow-recovery') mismatch('Active-prefix selection stage is invalid');
  if (value.stage === 'overflow-recovery' && (!string(value.currentTurnId) || !string(value.failedAttemptId) || value.cleanupConfirmed !== true)) mismatch('Overflow source requires an owned failed attempt and confirmed cleanup');
  if (value.stage === 'between-turns' && ('currentTurnId' in value || 'failedAttemptId' in value || 'cleanupConfirmed' in value)) mismatch('Between-turn source cannot borrow an active attempt');
}
function owner(row: Row, run: Run): void {
  if (row.session_id !== run.sessionId || row.run_id !== run.id) mismatch('Active-prefix record belongs to another Run');
}
function document(database: DatabaseSync, sessionId: string, kind: string): { revision: number; data: JsonObject } | null {
  const row = database.prepare('SELECT CASE WHEN revision BETWEEN 1 AND 9007199254740991 THEN revision ELSE 0 END AS revision,length(CAST(data AS BLOB)) AS bytes FROM session_documents WHERE session_id=? AND kind=?').get(sessionId, kind);
  if (!row) return null;
  if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || Number(row.bytes) > 262144) mismatch('Active-prefix document has invalid revision or size');
  const data = JSON.parse(String(database.prepare('SELECT data FROM session_documents WHERE session_id=? AND kind=?').get(sessionId, kind)!.data));
  if (!object(data)) mismatch('Active-prefix document must contain JSON data');
  return { revision: Number(row.revision), data };
}
// Opaque replay, reasoning, attachments and pixel bytes are deliberately absent.
const MESSAGE_FACTS = `json_object('id',id,'sessionId',session_id,'runId',run_id,'ordinal',ordinal,
  'role',json_extract(data,'$.role'),'content',json_extract(data,'$.content'),
  'toolCalls',json_extract(data,'$.toolCalls'),'toolCallId',json_extract(data,'$.toolCallId'),
  'toolResult',json_extract(data,'$.toolResult'))`;

/** Call only inside a read or publication transaction. Results are exact facts, never context excerpts. */
export function readActivePrefixSourceDatabase(database: DatabaseSync, run: Run, selection: ActivePrefixSourceOptions): ActivePrefixSource {
  options(selection);
  if (run.state !== 'running') throw new EngineError('ACTIVE_PREFIX_OWNER_REQUIRED', 'Active-prefix source requires a running owner');
  const scope = database.prepare('SELECT s.workspace_id,w.id FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE s.id=?').get(run.sessionId);
  if (scope?.workspace_id !== run.workspaceId || scope.id !== run.workspaceId) mismatch('Run workspace and session owners disagree');
  const memory = document(database, run.sessionId, DOCUMENT), head = document(database, run.sessionId, 'context.head');
  const pendingSteers = database.prepare("SELECT substr(id,1,257) AS id FROM session_inputs WHERE session_id=? AND state='pending' AND delivery='steer' ORDER BY admitted_seq LIMIT 65").all(run.sessionId);
  if (pendingSteers.length > 64) limit('Pending steering frontier exceeds the source manifest bound');
  if (pendingSteers.some(row => !string(row.id))) mismatch('Pending steering frontier has invalid identifiers');
  let priorId: string | undefined, priorCovered: string[] = [];
  const prior = memory?.data.active;
  if (prior !== undefined && !object(prior)) mismatch('Active-prefix pointer is invalid');
  if (object(prior) && prior.runId === run.id) {
    if (prior.version !== 1 || prior.scope !== 'active-run-prefix' || prior.projection !== PROJECTION || prior.sessionId !== run.sessionId || prior.workspaceId !== run.workspaceId
      || prior.providerId !== run.config.providerId || prior.modelId !== run.config.modelId || prior.policySha256 !== selection.policySha256 || !string(prior.id) || !string(prior.revisionId)
      || !ids(prior.coveredMessageIds, selection.maxCoveredMessages) || !ids(prior.protectedMessageIds) || prior.protectedMessageIds.some(id => (prior.coveredMessageIds as string[]).includes(id))) mismatch('Active-prefix predecessor has inconsistent owner or policy');
    const revision = database.prepare("SELECT session_id,run_id,turn_id,json_extract(data,'$.kind') AS kind,json_extract(data,'$.sha256') AS sha FROM context_revisions WHERE id=?").get(prior.revisionId as string);
    if (revision?.session_id !== run.sessionId || revision.run_id !== run.id || revision.turn_id !== null || revision.kind !== 'summary' || revision.sha !== prior.summarySha256) mismatch('Active-prefix predecessor revision is inconsistent');
    const binding = `active-prefix-checkpoint:${hash(JSON.stringify(prior))}`;
    if (!database.prepare("SELECT 1 FROM context_revisions c,json_each(c.data,'$.sourceIds') source WHERE c.id=? AND source.value=? LIMIT 1").get(prior.revisionId as string, binding)) mismatch('Active-prefix predecessor metadata is not bound to its immutable revision');
    priorId = prior.id as string; priorCovered = [...prior.coveredMessageIds as string[]];
  }
  const turnRows = database.prepare(`SELECT substr(t.id,1,257) AS id,substr(t.session_id,1,257) AS session_id,substr(t.run_id,1,257) AS run_id,t.turn_index,t.state,
    EXISTS(SELECT 1 FROM message_parts p WHERE p.turn_id=t.id AND json_extract(p.data,'$.type')='media') AS has_media,
    substr(json_extract(t.data,'$.id'),1,257) AS payload_id,substr(json_extract(t.data,'$.sessionId'),1,257) AS payload_session,substr(json_extract(t.data,'$.runId'),1,257) AS payload_run,
    json_extract(t.data,'$.state') AS payload_state,json_extract(t.data,'$.index') AS payload_index,
    substr(a.id,1,257) AS attempt_id,substr(a.session_id,1,257) AS attempt_session,substr(a.run_id,1,257) AS attempt_run,substr(a.turn_id,1,257) AS turn_id,a.state AS attempt_state,
    substr(json_extract(a.data,'$.id'),1,257) AS attempt_payload_id,substr(json_extract(a.data,'$.providerId'),1,257) AS provider,substr(json_extract(a.data,'$.modelId'),1,257) AS model,
    substr(json_extract(a.data,'$.sessionId'),1,257) AS attempt_payload_session,substr(json_extract(a.data,'$.runId'),1,257) AS attempt_payload_run,
    substr(json_extract(a.data,'$.turnId'),1,257) AS attempt_payload_turn,json_extract(a.data,'$.state') AS attempt_payload_state,
    json_extract(a.data,'$.index') AS attempt_payload_index,a.attempt_index
    FROM session_turns t LEFT JOIN provider_attempts a ON a.id=(SELECT id FROM provider_attempts WHERE turn_id=t.id ORDER BY attempt_index DESC LIMIT 1)
    WHERE t.run_id=? ORDER BY t.turn_index LIMIT ?`).all(run.id, METADATA_LIMIT + 1);
  if (turnRows.length > METADATA_LIMIT) limit('Run Turn metadata exceeds the fixed source read bound');
  const completed: TurnHeader[] = [];
  for (const [index, row] of turnRows.entries()) {
    owner(row, run);
    if (!string(row.id) || !string(row.attempt_id) || row.payload_id !== row.id || row.payload_session !== run.sessionId || row.payload_run !== run.id || row.turn_index !== index || row.payload_index !== index || row.payload_state !== row.state
      || row.attempt_session !== run.sessionId || row.attempt_run !== run.id || row.turn_id !== row.id || row.attempt_payload_id !== row.attempt_id || row.provider !== run.config.providerId || row.model !== run.config.modelId
      || row.attempt_payload_session !== run.sessionId || row.attempt_payload_run !== run.id || row.attempt_payload_turn !== row.id || row.attempt_payload_state !== row.attempt_state || row.attempt_payload_index !== row.attempt_index) mismatch('Turn and final attempt identity is inconsistent');
    const invalidPart = database.prepare(`SELECT 1 FROM message_parts WHERE turn_id=? AND (session_id IS NOT ? OR run_id IS NOT ?
      OR json_extract(data,'$.id') IS NOT id OR json_extract(data,'$.sessionId') IS NOT session_id OR json_extract(data,'$.runId') IS NOT run_id
      OR json_extract(data,'$.turnId') IS NOT turn_id OR json_extract(data,'$.messageId') IS NOT message_id OR json_extract(data,'$.state') IS NOT state
      OR json_extract(data,'$.index') IS NOT part_index OR json_extract(data,'$.revision') IS NOT revision) LIMIT 1`).get(String(row.id), run.sessionId, run.id);
    if (invalidPart) mismatch('Native Part SQL columns and payload ownership disagree');
    if (row.state === 'completed' && row.attempt_state === 'completed') {
      const unfinished = database.prepare("SELECT 1 FROM message_parts WHERE turn_id=? AND state IN ('open','interrupted') LIMIT 1").get(row.id as string);
      if (unfinished) mismatch('Completed source Turn has unsettled parts');
      completed.push({ id: String(row.id), index, state: String(row.state), attemptId: String(row.attempt_id), attemptState: String(row.attempt_state), media: row.has_media === 1 });
    } else {
      if (selection.stage !== 'overflow-recovery' || index !== turnRows.length - 1 || row.id !== selection.currentTurnId || row.attempt_id !== selection.failedAttemptId || row.attempt_state !== 'failed' || !['created', 'streaming'].includes(String(row.state))) mismatch('Summary source is not at a settled Turn boundary');
      if (database.prepare('SELECT 1 FROM message_parts WHERE turn_id=? LIMIT 1').get(row.id as string)) mismatch('Overflow recovery attempt already produced a durable part');
      const previous = database.prepare("SELECT 1 FROM provider_attempts WHERE turn_id=? AND state!='failed' LIMIT 1").get(row.id as string);
      if (previous) mismatch('Overflow recovery has an unfinished provider attempt');
    }
  }
  const boundary = completed.at(-1);
  if (!boundary || completed.length <= selection.keepRecentTurns) throw new EngineError('ACTIVE_PREFIX_NOT_AVAILABLE', 'No complete old exchange is available outside the protected recent suffix');
  const messageRows = database.prepare(`SELECT substr(id,1,257) AS id,substr(session_id,1,257) AS session_id,substr(run_id,1,257) AS run_id,ordinal,
    substr(json_extract(data,'$.id'),1,257) AS payload_id,substr(json_extract(data,'$.sessionId'),1,257) AS payload_session,substr(json_extract(data,'$.runId'),1,257) AS payload_run,
    json_extract(data,'$.role') AS role,json_type(data,'$.content') AS content_type,
    coalesce(json_array_length(data,'$.attachments'),0) AS images,coalesce(json_array_length(data,'$.toolCalls'),0) AS calls,
    length(CAST(${MESSAGE_FACTS} AS BLOB)) AS bytes
    FROM messages WHERE run_id=? ORDER BY ordinal LIMIT ?`).all(run.id, METADATA_LIMIT + 1);
  if (messageRows.length > METADATA_LIMIT || Buffer.byteLength(JSON.stringify(messageRows)) > METADATA_BYTES) limit('Run message metadata exceeds the fixed source read bound');
  const messages: MessageHeader[] = messageRows.map(row => {
    owner(row, run);
    if (!string(row.id) || row.payload_id !== row.id || row.payload_session !== run.sessionId || row.payload_run !== run.id || !['user', 'assistant', 'tool'].includes(String(row.role)) || row.content_type !== 'text' || !Number.isSafeInteger(row.ordinal)) mismatch('Source message has invalid identity or text');
    return { id: String(row.id), ordinal: Number(row.ordinal), role: String(row.role), images: Number(row.images) > 0, bytes: Number(row.bytes), toolCalls: Number(row.calls) };
  });
  const users = messages.filter(message => message.role === 'user'), assistants = messages.filter(message => message.role === 'assistant');
  const first = users[0], latest = users.at(-1);
  if (!first || !latest || assistants.length !== completed.length) mismatch('Completed native Turns must have exactly one complete assistant exchange');
  const recentOrdinal = assistants[completed.length - selection.keepRecentTurns]!.ordinal;
  const protectedIds = new Set(messages.filter(message => message.id === first.id || message.id === latest.id || message.images || message.ordinal >= recentOrdinal).map(message => message.id));
  for (const [index, turn] of completed.entries()) if (turn.media) {
    const start = assistants[index]!.ordinal, end = assistants[index + 1]?.ordinal ?? Number.MAX_SAFE_INTEGER;
    for (const message of messages) if (message.ordinal >= start && message.ordinal < end && message.role !== 'user') protectedIds.add(message.id);
  }
  if (priorCovered.some(id => !messages.some(message => message.id === id) || protectedIds.has(id))) mismatch('Prior exact coverage overlaps a protected or missing source message');
  const priorIds = new Set(priorCovered), eligible = messages.filter(message => message.ordinal < recentOrdinal && !protectedIds.has(message.id) && !priorIds.has(message.id));
  if (!eligible.length) throw new EngineError('ACTIVE_PREFIX_NOT_AVAILABLE', 'No new complete facts are available after the active checkpoint');
  const selectedIds = new Set(eligible.map(message => message.id));
  const facts: JsonObject[] = [], sourceTurns: string[] = [];
  for (let index = 0; index < completed.length; index++) {
    const turn = completed[index]!, assistant = assistants[index]!, next = assistants[index + 1]?.ordinal ?? Number.MAX_SAFE_INTEGER;
    // User steering can occur between complete exchanges. Tool results cannot cross another assistant or a user boundary.
    const group = messages.filter(message => message.ordinal >= assistant.ordinal && message.ordinal < next);
    const results = group.filter(message => message.role === 'tool');
    const selectedGroup = [assistant, ...results].filter(message => selectedIds.has(message.id));
    if (selectedGroup.length && selectedGroup.length !== results.length + 1) mismatch('Prefix coverage splits an assistant/tool exchange');
    if (priorIds.has(assistant.id) && [assistant, ...results].some(message => !priorIds.has(message.id))) mismatch('Prior coverage splits an assistant/tool exchange');
    if (!selectedGroup.length) continue;
    if (results.length !== assistant.toolCalls || results.some(message => group.some(user => user.role === 'user' && user.ordinal < message.ordinal))) mismatch('Complete assistant exchange has missing, extra or displaced tool results');
    // Previously protected steering holes become facts when a new complete exchange is selected.
    const groupUsers = eligible.filter(user => user.role === 'user' && user.ordinal < assistant.ordinal && !facts.some(fact => fact.id === user.id));
    const groupHeaders = [...groupUsers, ...selectedGroup];
    const projectedHeaderBytes = groupHeaders.reduce((total, header) => total + header.bytes, 0);
    if (facts.length + groupHeaders.length > selection.maxSourceMessages || priorCovered.length + facts.length + groupHeaders.length > selection.maxCoveredMessages
      || projectedHeaderBytes + Buffer.byteLength(JSON.stringify(facts)) > selection.maxSourceBytes) {
      if (!facts.length) limit('One complete exchange exceeds the source count, coverage or byte budget');
      break;
    }
    const partFacts = `json_object('toolCallId',json_extract(data,'$.toolCallId'),'providerCallId',json_extract(data,'$.providerCallId'),'name',json_extract(data,'$.name'),'input',json_extract(data,'$.input'),'result',json_extract(data,'$.result'))`;
    const toolPartSizes = database.prepare(`SELECT count(*) AS count,coalesce(sum(length(CAST(${partFacts} AS BLOB))),0) AS bytes
      FROM message_parts WHERE turn_id=? AND json_extract(data,'$.type')='tool'`).get(turn.id)!;
    if (Number(toolPartSizes.count) !== results.length) mismatch('Source tool proposal/result counts disagree');
    if (Number(toolPartSizes.count) > 128 || Number(toolPartSizes.bytes) > selection.maxSourceBytes) {
      if (!facts.length) limit('Complete tool part facts exceed the exact source byte bound');
      break;
    }
    const parts = database.prepare(`SELECT id,session_id,run_id,turn_id,message_id,state,
      ${partFacts} AS facts
      FROM message_parts WHERE turn_id=? AND json_extract(data,'$.type')='tool' ORDER BY part_index LIMIT 129`).all(turn.id);
    if (parts.length !== results.length || parts.some(part => Buffer.byteLength(String(part.facts)) > selection.maxSourceBytes)) mismatch('Source tool proposal and result count is inconsistent or exceeds the exact source bound');
    const a = projected(database, assistant, selection.maxSourceBytes); a.turnId = turn.id; a.attemptId = turn.attemptId;
    const calls = a.toolCalls;
    if (assistant.toolCalls && !Array.isArray(calls)) mismatch('Assistant tool calls are not complete JSON');
    const groupFacts: JsonObject[] = [a];
    const used = new Set<string>();
    for (const result of results) {
      const fact = projected(database, result, selection.maxSourceBytes), matching = parts.filter(part => {
        const proposal = JSON.parse(String(part.facts)) as JsonObject; return proposal.providerCallId === fact.toolCallId;
      });
      if (matching.length !== 1) mismatch('Tool result has no unique proposal in its own exchange');
      const part = matching[0]!, proposal = JSON.parse(String(part.facts)) as JsonObject;
      owner(part, run);
      if (part.turn_id !== turn.id || part.message_id !== assistant.id || !['completed', 'failed'].includes(String(part.state)) || !string(proposal.toolCallId) || used.has(proposal.toolCallId)) mismatch('Tool result proposal belongs to another Turn or has not settled');
      used.add(proposal.toolCallId);
      const call = (Array.isArray(calls) ? calls : []).find(value => object(value) && value.id === fact.toolCallId);
      if (!object(call) || call.name !== proposal.name || activePrefixCanonical(call.input) !== activePrefixCanonical(proposal.input)) mismatch('Observed tool arguments differ from the assistant proposal');
      const tool = database.prepare(`SELECT substr(session_id,1,257) AS session_id,substr(run_id,1,257) AS run_id,state,
        substr(json_extract(data,'$.id'),1,257) AS payload_id,substr(json_extract(data,'$.name'),1,129) AS name,
        substr(json_extract(data,'$.sessionId'),1,257) AS payload_session,substr(json_extract(data,'$.runId'),1,257) AS payload_run,json_extract(data,'$.state') AS payload_state,
        CASE WHEN length(CAST(json_quote(json_extract(data,'$.input')) AS BLOB)) <= ? THEN json_quote(json_extract(data,'$.input')) END AS input,json_extract(data,'$.output')= ? AS output_matches,
        length(CAST(json_quote(json_extract(data,'$.input')) AS BLOB)) AS input_bytes FROM tools WHERE id=?`).get(selection.maxSourceBytes, fact.content as string, proposal.toolCallId);
      if (!tool) mismatch('Complete tool result has no durable internal tool record');
      owner(tool, run);
      if (tool.payload_id !== proposal.toolCallId || tool.payload_session !== run.sessionId || tool.payload_run !== run.id || tool.payload_state !== tool.state || tool.name !== proposal.name || !['completed', 'failed', 'denied'].includes(String(tool.state)) || tool.output_matches !== 1 || Number(tool.input_bytes) > selection.maxSourceBytes
        || (part.state === 'completed') !== (tool.state === 'completed')) mismatch('Tool observation differs from its durable tool result');
      const input = JSON.parse(String(tool.input));
      if (activePrefixCanonical(input) !== activePrefixCanonical(proposal.input) || !object(proposal.result) || proposal.result.output !== fact.content) mismatch('Terminal part and tool observation disagree');
      fact.turnId = turn.id; fact.attemptId = turn.attemptId; fact.internalToolCallId = proposal.toolCallId; fact.toolOutcome = String(tool.state); groupFacts.push(fact);
    }
    for (const user of groupUsers) groupFacts.unshift(projected(database, user, selection.maxSourceBytes));
    const candidateFacts = [...facts, ...groupFacts].sort((left, right) => Number(left.ordinal) - Number(right.ordinal));
    const candidateJson = JSON.stringify({ version: 1, scope: 'active-run-prefix', projection: PROJECTION, messages: candidateFacts });
    if (candidateFacts.length > selection.maxSourceMessages || priorCovered.length + candidateFacts.length > selection.maxCoveredMessages || Buffer.byteLength(candidateJson) > selection.maxSourceBytes) {
      if (!facts.length) limit('One complete exchange exceeds the exact source count, coverage or byte budget');
      break;
    }
    facts.splice(0, facts.length, ...candidateFacts); sourceTurns.push(turn.id);
  }
  if (!facts.length || !sourceTurns.length) throw new EngineError('ACTIVE_PREFIX_NOT_AVAILABLE', 'No complete text/tool exchange is available outside protected observations');
  facts.sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
  const sourceJson = JSON.stringify({ version: 1, scope: 'active-run-prefix', projection: PROJECTION, messages: facts });
  if (Buffer.byteLength(sourceJson) > selection.maxSourceBytes) limit('Exact text/tool source JSON exceeds its byte budget');
  const sourceMessageIds = facts.map(fact => String(fact.id));
  for (const user of eligible) if (user.role === 'user' && !sourceMessageIds.includes(user.id)) protectedIds.add(user.id);
  const coveredIds = new Set([...priorCovered, ...sourceMessageIds]);
  const source: ActivePrefixSource = { version: 1, scope: 'active-run-prefix', projection: PROJECTION,
    sessionId: run.sessionId, workspaceId: run.workspaceId, runId: run.id, providerId: run.config.providerId, modelId: run.config.modelId,
    sourceJson, sourceMessageIds, sourceTurnIds: sourceTurns, coveredMessageIds: messages.filter(message => coveredIds.has(message.id)).map(message => message.id),
    protectedMessageIds: messages.filter(message => protectedIds.has(message.id)).map(message => message.id), boundaryTurnId: boundary.id, boundaryAttemptId: boundary.attemptId, latestUserMessageId: latest.id,
    factsSha256: hash(sourceJson), manifestSha256: '', policySha256: selection.policySha256, expectedMemoryRevision: memory?.revision ?? 0, expectedContextHeadRevision: head?.revision ?? 0,
    ...(priorId ? { priorCheckpointId: priorId } : {}), stage: selection.stage, pendingSteerIds: pendingSteers.map(row => String(row.id)),
    ...(selection.stage === 'overflow-recovery' ? { currentTurnId: selection.currentTurnId, failedAttemptId: selection.failedAttemptId, cleanupConfirmed: true as const } : {}),
    limits: { maxSourceMessages: selection.maxSourceMessages, maxSourceBytes: selection.maxSourceBytes, keepRecentTurns: selection.keepRecentTurns, maxCoveredMessages: selection.maxCoveredMessages } };
  const { sourceJson: _facts, manifestSha256: _digest, ...manifest } = source;
  source.manifestSha256 = hash(activePrefixCanonical(manifest));
  return source;
}
function projected(database: DatabaseSync, header: MessageHeader, max: number): JsonObject {
  if (header.bytes > max) limit('A selected exact message exceeds the source byte bound');
  const row = database.prepare(`SELECT ${MESSAGE_FACTS} AS facts FROM messages WHERE id=?`).get(header.id);
  if (!row || Buffer.byteLength(String(row.facts)) > max) limit('Selected source message changed or exceeds its byte bound');
  const value = JSON.parse(String(row.facts)) as JsonObject;
  for (const key of ['toolCalls', 'toolCallId', 'toolResult']) if (value[key] === null) delete value[key];
  return value;
}

/** Publisher validation is repeated against the database; callers cannot supply substitute source facts. */
export function validateActivePrefixPublication(database: DatabaseSync, run: Run, change: PreparedActivePrefix & ActivePrefixContextPublication): void {
  const { source, checkpoint, summaryRevision: summary, contextRevision: context, contextData } = change;
  if (!source || !source.limits || !checkpoint || !summary || !context || !contextData) mismatch('Active-prefix publication is incomplete');
  if ((document(database, run.sessionId, DOCUMENT)?.revision ?? 0) !== source.expectedMemoryRevision || (document(database, run.sessionId, 'context.head')?.revision ?? 0) !== source.expectedContextHeadRevision) {
    throw new EngineError('ACTIVE_PREFIX_SOURCE_CHANGED', 'Prepared summary memory or provider context baseline changed');
  }
  const stage: ActivePrefixSourceOptions = source.stage === 'overflow-recovery'
    ? { stage: 'overflow-recovery', currentTurnId: source.currentTurnId!, failedAttemptId: source.failedAttemptId!, cleanupConfirmed: source.cleanupConfirmed! , policySha256: source.policySha256, ...source.limits }
    : { stage: 'between-turns', policySha256: source.policySha256, ...source.limits };
  const fresh = readActivePrefixSourceDatabase(database, run, stage);
  if (activePrefixCanonical(source) !== activePrefixCanonical(fresh)) throw new EngineError('ACTIVE_PREFIX_SOURCE_CHANGED', 'Run source, input frontier or prepared context document baseline changed');
  for (const key of ['version', 'scope', 'projection', 'sessionId', 'workspaceId', 'runId', 'providerId', 'modelId', 'sourceMessageIds', 'sourceTurnIds', 'coveredMessageIds', 'protectedMessageIds', 'boundaryTurnId', 'boundaryAttemptId', 'latestUserMessageId', 'factsSha256', 'manifestSha256', 'policySha256'] as const) {
    if (activePrefixCanonical(checkpoint[key]) !== activePrefixCanonical(source[key])) mismatch('Checkpoint is not bound to its exact prepared source');
  }
  if (!string(checkpoint.id) || checkpoint.previousCheckpointId !== source.priorCheckpointId || checkpoint.revisionId !== summary.id || checkpoint.summarySha256 !== summary.sha256
    || summary.kind !== 'summary' || summary.turnId !== undefined || summary.sessionId !== run.sessionId || summary.runId !== run.id || hash(summary.text) !== summary.sha256 || !summary.text.trim()
    || source.sourceMessageIds.some(id => !summary.sourceIds.includes(id)) || !summary.sourceIds.includes(`active-prefix-checkpoint:${hash(JSON.stringify(checkpoint))}`)
    || context.sessionId !== run.sessionId || context.runId !== run.id || context.turnId !== undefined || context.kind === 'summary'
    || context.revision !== summary.revision + 1 || context.supersedesId !== summary.id || context.sha256 !== hash(context.text) || !context.sourceIds.includes(summary.id)
    || contextData.revisionId !== context.id || contextData.contextRevision !== context.revision) mismatch('Summary and provider context revisions have inconsistent bindings');
  if (!checkpoint.usage || Object.values(checkpoint.usage).some(count => count !== null && (!Number.isSafeInteger(count) || count < 0))
    || checkpoint.usage.cachedInputTokens !== null && checkpoint.usage.inputTokens !== null && checkpoint.usage.cachedInputTokens > checkpoint.usage.inputTokens
    || checkpoint.usage.reasoningOutputTokens !== null && checkpoint.usage.outputTokens !== null && checkpoint.usage.reasoningOutputTokens > checkpoint.usage.outputTokens) mismatch('Summary usage must be valid inclusive provider observations');
  const lifecycle = database.prepare(`SELECT type,json_object('scope',substr(json_extract(data,'$.payload.scope'),1,64),
    'factsSha256',substr(json_extract(data,'$.payload.factsSha256'),1,65),'manifestSha256',substr(json_extract(data,'$.payload.manifestSha256'),1,65),
    'expectedMemoryRevision',json_extract(data,'$.payload.expectedMemoryRevision'),'expectedContextHeadRevision',json_extract(data,'$.payload.expectedContextHeadRevision'),
    'providerId',substr(json_extract(data,'$.payload.providerId'),1,257),'modelId',substr(json_extract(data,'$.payload.modelId'),1,257)) AS payload
    FROM events WHERE run_id=? AND type IN ('summary.prepared','summary.dispatched','summary.completed','summary.failed')
    AND json_extract(data,'$.payload.summaryAttemptId')=? ORDER BY seq LIMIT 4`).all(run.id, checkpoint.id);
  if (lifecycle.length !== 2 || lifecycle[0]?.type !== 'summary.prepared' || lifecycle[1]?.type !== 'summary.dispatched') mismatch('Summary publication requires one unsettled durable prepared/dispatched journal attempt');
  const prepared = JSON.parse(String(lifecycle[0].payload)) as JsonObject, dispatched = JSON.parse(String(lifecycle[1].payload)) as JsonObject;
  if (prepared.scope !== 'active-run-prefix' || prepared.factsSha256 !== source.factsSha256 || prepared.manifestSha256 !== source.manifestSha256
    || prepared.expectedMemoryRevision !== source.expectedMemoryRevision || prepared.expectedContextHeadRevision !== source.expectedContextHeadRevision
    || dispatched.scope !== 'active-run-prefix' || dispatched.providerId !== source.providerId || dispatched.modelId !== source.modelId) mismatch('Summary journal is not bound to this source and provider');
}
