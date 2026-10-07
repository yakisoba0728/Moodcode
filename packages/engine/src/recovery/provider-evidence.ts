import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { EngineError, type JsonObject, type MessagePart, type ProviderAttempt, type Run, type TurnRecord } from '@moodcode/contracts';
import { normalizeSubmitInput, validateContextRevision, validateInputRecord, validateMessagePart, validateProviderAttempt, validateTurnRecord } from '@moodcode/contracts/validation';
import type { SqliteStore } from '../storage/index.js';
import { canonicalAttemptCleanupSha256 } from '../storage/attempt-cleanup.js';
import { readEvidenceBody } from '../storage/evidence-read.js';
import { canonical } from './snapshot.js';
import { PROVIDER_RECOVERY_LIMITS as limits, type ProviderRecoveryBudget, type ProviderRecoveryEvidence, type ProviderRecoveryPin } from './provider-contract.js';

type Row = Record<string, unknown>;
interface Selected { table: Table; row: Row; data: JsonObject; sha256: string }
type Table = keyof typeof columns;
const columns = {
  sessions: 'id,workspace_id', workspaces: 'id,root', runs: 'id,input_id,session_id,workspace_id,state',
  session_turns: 'id,session_id,run_id,CAST(turn_index AS TEXT) AS turn_index,state', provider_attempts: 'id,session_id,run_id,turn_id,CAST(attempt_index AS TEXT) AS attempt_index,state',
  attempt_cleanup: 'attempt_id AS id,session_id,workspace_id,run_id,turn_id,provider_id,model_id,context_revision_id,request_sha256,request_bytes,state,CAST(revision AS TEXT) AS revision',
  attempt_usage: 'attempt_id AS id,session_id,run_id,turn_id,CAST(revision AS TEXT) AS revision',
  inputs: 'id,session_id,request_id,fingerprint,CAST(admitted_seq AS TEXT) AS admitted_seq',
  session_inputs: 'id,session_id,workspace_id,run_id,request_id,fingerprint,delivery,state,CAST(admitted_seq AS TEXT) AS admitted_seq,CAST(promoted_seq AS TEXT) AS promoted_seq,CAST(legacy_seq AS TEXT) AS legacy_seq',
  messages: 'id,session_id,run_id,CAST(ordinal AS TEXT) AS ordinal',
  message_parts: 'id,session_id,run_id,turn_id,message_id,CAST(part_index AS TEXT) AS part_index,CAST(revision AS TEXT) AS revision,state',
  tools: 'id,session_id,run_id,state', checkpoints: 'id,run_id,tool_call_id',
  events: 'event_id AS id,session_id,run_id,type,CAST(seq AS TEXT) AS seq',
  context_revisions: 'id,session_id,run_id,turn_id,CAST(revision AS TEXT) AS revision,supersedes_id',
} as const;
const key = (table: Table) => table === 'attempt_cleanup' || table === 'attempt_usage' ? 'attempt_id' : table === 'events' ? 'event_id' : 'id';
function hash(value: unknown): string { try { return createHash('sha256').update(canonical(value) ?? 'undefined').digest('hex'); } catch { return fail('SOURCE_CHANGED', 'Provider recovery evidence cannot be canonically encoded'); } }
const textHash = (value: string) => createHash('sha256').update(value).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function fail(suffix: string, message: string): never { throw new EngineError(`PROVIDER_RECOVERY_${suffix}`, message); }
function object(value: unknown): asserts value is JsonObject { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SOURCE_CHANGED', 'Stored provider recovery evidence must be JSON objects'); }
function parse(value: unknown): JsonObject { let result: unknown; try { result = JSON.parse(String(value)); } catch { return fail('SOURCE_CHANGED', 'Stored provider recovery evidence is malformed'); } object(result); return result; }
function number(value: unknown, minimum = 0): number { const result = Number(value); if (!Number.isSafeInteger(result) || result < minimum) fail('SOURCE_CHANGED', 'Stored provider recovery sequence is outside its exact integer range'); return result; }
function charge(budget: ProviderRecoveryBudget, bytes: unknown): void {
  if (!budget || types.isProxy(budget) || ![Object.prototype,null].includes(Object.getPrototypeOf(budget))) fail('INVALID_REQUEST', 'Recovery needs a plain selected-evidence budget');
  for (const field of ['bytes','max']) { const property = Object.getOwnPropertyDescriptor(budget, field); if (!property || !('value' in property)) fail('INVALID_REQUEST', 'Recovery budget rejects accessors'); }
  if (!Number.isSafeInteger(budget.max) || budget.max < 1 || budget.max > limits.maxEvidenceBytes || !Number.isSafeInteger(budget.bytes) || budget.bytes < 0 || budget.bytes > budget.max
    || !Number.isSafeInteger(bytes) || Number(bytes) < 0 || Number(bytes) > budget.max - budget.bytes) fail('LIMIT', 'Provider recovery selected evidence exceeds its byte budget');
  budget.bytes += Number(bytes);
}
function readonly<T>(db: DatabaseSync, operation: () => T): T {
  if (db.isTransaction) return operation(); db.exec('BEGIN');
  try { const result = operation(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function expectedOwner(row: Row, expected: { sessionId?: string; runId?: string; workspaceId?: string }): void {
  for (const [property, column] of [['sessionId','session_id'],['runId','run_id'],['workspaceId','workspace_id']] as const) {
    if (expected[property] !== undefined && row[column] !== undefined && row[column] !== expected[property]) fail('OWNER_MISMATCH', 'Selected recovery metadata belongs to another owner');
  }
}
function selected(db: DatabaseSync, table: Table, row: Row, budget: ProviderRecoveryBudget): Selected {
  if (!id(row.id) || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 2 || Number(row.bytes) > limits.maxOwnerBytes) fail('LIMIT', 'Selected recovery row exceeds its identity or payload bound');
  charge(budget, row.bytes);
  const raw = readEvidenceBody(db, { table, key: row.id }, { expectedBytes: Number(row.bytes), maxBytes: limits.maxOwnerBytes });
  if (raw === undefined) fail('SOURCE_CHANGED', 'Selected provider recovery evidence disappeared');
  const data = parse(raw), payloadId = table === 'inputs' ? row.id : table === 'events' ? data.eventId : table === 'attempt_cleanup' || table === 'attempt_usage' ? data.attemptId : data.id;
  if (payloadId !== row.id) fail('OWNER_MISMATCH', 'Selected payload identity disagrees with SQL');
  for (const [property, column] of [['sessionId','session_id'],['runId','run_id'],['workspaceId','workspace_id'],['turnId','turn_id'],['state','state'],['toolCallId','tool_call_id']] as const) {
    if (row[column] !== undefined && (data[property] ?? null) !== row[column]) fail('OWNER_MISMATCH', 'Selected payload owner or state disagrees with SQL');
  }
  if (row.revision !== undefined && data.revision !== number(row.revision, table === 'message_parts' ? 0 : 1) || row.turn_index !== undefined && data.index !== number(row.turn_index)
    || row.attempt_index !== undefined && data.index !== number(row.attempt_index) || row.message_id !== undefined && data.messageId !== row.message_id
    || row.part_index !== undefined && data.index !== number(row.part_index) || table === 'events' && (data.type !== row.type || data.seq !== number(row.seq, 1))
    || table === 'runs' && data.inputId !== row.input_id || table === 'workspaces' && data.root !== row.root
    || table === 'context_revisions' && (data.supersedesId ?? null) !== row.supersedes_id) fail('SOURCE_CHANGED', 'Selected payload metadata disagrees with SQL');
  const { bytes: _, ...metadata } = row;
  return { table, row, data, sha256: hash({ table, metadata, data }) };
}
function rows(db: DatabaseSync, table: Table, where: string, parameters: readonly string[], maximum: number, budget: ProviderRecoveryBudget,
  expected: { sessionId?: string; runId?: string; workspaceId?: string } = {}, order = 'rowid'): Selected[] {
  const headers = db.prepare(`SELECT ${columns[table]},length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE ${where} ORDER BY ${table}.${order} LIMIT ?`).all(...parameters, maximum + 1);
  if (headers.length > maximum) fail('LIMIT', 'Provider recovery exceeds its bounded record count');
  // Validate every selected owner and byte size before returning any body to JS.
  for (const header of headers) { expectedOwner(header, expected); if (!Number.isSafeInteger(header.bytes) || Number(header.bytes) < 2 || Number(header.bytes) > limits.maxOwnerBytes) fail('LIMIT', 'Selected recovery payload exceeds its bound'); }
  return headers.map(header => selected(db, table, header, budget));
}
function one(db: DatabaseSync, table: Table, identity: string, budget: ProviderRecoveryBudget, expected: { sessionId?: string; runId?: string; workspaceId?: string } = {}): Selected {
  const values = rows(db, table, `${key(table)}=?`, [identity], 1, budget, expected); if (!values[0]) fail('SOURCE_CHANGED', 'Pinned provider recovery evidence is missing'); return values[0];
}
function decoded<T>(operation: () => T): T { try { return operation(); } catch (error) { if (error instanceof EngineError && error.code.startsWith('PROVIDER_RECOVERY_')) throw error; return fail('SOURCE_CHANGED', 'Stored provider recovery records do not satisfy their native contracts'); } }
function digestOrder(values: Selected[], column: 'ordinal' | 'seq' | 'admitted_seq'): Selected[] {
  // V1 serialized these CAST text aliases in binary order. Keep the receipt
  // digest encoding while chronology validators use the numeric SQL columns.
  return [...values].sort((left, right) => String(left.row[column]) < String(right.row[column]) ? -1 : String(left.row[column]) > String(right.row[column]) ? 1 : 0);
}
function unsafeToolObservation(data: JsonObject): boolean {
  // The coordinator lifts real execution proofs onto the audit payload. Generic
  // envelope metadata/structuredData remain domain observations, not proofs.
  return data.cleanupConfirmed === false || data.cleanupUncertain === true || data.effectsUncertain === true || data.executionBlocked === true || data.timedOut === true
    || Boolean(data.structuredResult && typeof data.structuredResult === 'object' && !Array.isArray(data.structuredResult) && data.structuredResult.outcome === 'interrupted');
}
function toolEvidence(db: DatabaseSync, run: Run, parts: MessagePart[], messages: Selected[], source: Selected[], budget: ProviderRecoveryBudget): void {
  const toolRows = rows(db, 'tools', 'run_id=?', [run.id], limits.maxTools, budget, { sessionId: run.sessionId, runId: run.id });
  const checkpoints = rows(db, 'checkpoints', 'run_id=?', [run.id], limits.maxTools * 4, budget, { runId: run.id });
  const events = rows(db, 'events', "run_id=? AND (type GLOB 'tool.*' OR type='workspace.changed' OR type='checkpoint.artifacts')", [run.id], limits.maxTools * 8, budget, { sessionId: run.sessionId, runId: run.id }, 'seq');
  const byId = new Map(toolRows.map(value => [String(value.row.id), value]));
  for (const event of events) { object(event.data.payload); if (!id(event.data.payload.toolCallId) || !byId.has(event.data.payload.toolCallId)) fail('TOOLS_UNCERTAIN', 'Tool journal cannot be correlated with an owned tool'); if (unsafeToolObservation(event.data.payload)) fail('TOOLS_UNCERTAIN', 'Tool journal contains uncertain effects or cleanup'); }
  for (const checkpoint of checkpoints) {
    const recorded = events.filter(value => value.data.type === 'workspace.changed' && (value.data.payload as JsonObject).checkpointId === checkpoint.row.id);
    if (!byId.has(String(checkpoint.row.tool_call_id)) || checkpoint.data.incomplete === true || recorded.length !== 1) fail('TOOLS_UNCERTAIN', 'Workspace effects lack a complete owned checkpoint');
    const observation = recorded[0]!.data.payload as JsonObject;
    if (observation.toolCallId !== checkpoint.row.tool_call_id || observation.kind !== checkpoint.data.kind || observation.incomplete !== (checkpoint.data.incomplete ?? false)
      || hash(observation.warnings) !== hash(checkpoint.data.warnings)) fail('TOOLS_UNCERTAIN', 'Workspace checkpoint and its observation disagree');
  }
  if (events.some(value => value.data.type === 'workspace.changed' && !checkpoints.some(checkpoint => checkpoint.row.id === (value.data.payload as JsonObject).checkpointId))) fail('TOOLS_UNCERTAIN', 'Workspace effect journal lacks its checkpoint');
  for (const entry of toolRows) {
    const tool = entry.data, toolId = String(entry.row.id), proposal = parts.find(part => part.type === 'tool' && part.toolCallId === toolId);
    if (!id(tool.name) || tool.input === undefined || !proposal || proposal.type !== 'tool' || proposal.name !== tool.name || hash(proposal.input) !== hash(tool.input)) fail('TOOLS_UNCERTAIN', 'Tool records require their exact durable proposal');
    const history = events.filter(value => (value.data.payload as JsonObject).toolCallId === toolId);
    const requested = history.filter(value => value.data.type === 'tool.requested');
    if (requested.length !== 1) fail('TOOLS_UNCERTAIN', 'Tool admission journal is missing or ambiguous');
    const request = requested[0]!.data.payload as JsonObject;
    if (request.name !== tool.name || request.providerToolCallId !== proposal.providerCallId || hash(request.input) !== hash(tool.input)) fail('TOOLS_UNCERTAIN', 'Tool admission differs from its proposal');
    const running = history.filter(value => value.data.type === 'tool.running');
    if (running.length > 1 || running.some(value => number(value.row.seq, 1) <= number(requested[0]!.row.seq, 1))) fail('TOOLS_UNCERTAIN', 'Tool dispatch journal is ambiguous');
    const settled = history.filter(value => ['tool.completed','tool.failed','tool.denied'].includes(String(value.data.type)));
    if (['requested','awaiting_approval','interrupted'].includes(String(tool.state))) {
      if (running.length || settled.length || checkpoints.some(value => value.row.tool_call_id === toolId) || proposal.result !== undefined || ['completed','failed'].includes(proposal.state)) fail('TOOLS_UNCERTAIN', 'An interrupted tool may have started effects');
    } else if (['completed','failed','denied'].includes(String(tool.state))) {
      if (settled.length !== 1 || settled[0]!.data.type !== `tool.${tool.state}` || number(settled[0]!.row.seq, 1) <= number(requested[0]!.row.seq, 1)
        || running.length && number(settled[0]!.row.seq, 1) <= number(running[0]!.row.seq, 1) || tool.state === 'denied' && running.length
        || !['completed','failed'].includes(proposal.state) || proposal.result === undefined) fail('TOOLS_UNCERTAIN', 'Tool effects lack a matching terminal journal and Part');
      const outcome = settled[0]!.data.payload as JsonObject; object(proposal.result);
      if (outcome.name !== tool.name || outcome.providerToolCallId !== proposal.providerCallId || typeof tool.output !== 'string' || outcome.output !== tool.output
        || proposal.result.output !== tool.output || outcome.isError !== proposal.result.isError || outcome.truncated !== proposal.result.truncated
        || tool.state === 'completed' && (!running.length || proposal.state !== 'completed')) fail('TOOLS_UNCERTAIN', 'Tool terminal output differs from its stored result');
      const origin = messages.findIndex(value => value.row.id === proposal.messageId), after = messages.slice(origin + 1);
      const cutoff = after.findIndex(value => value.data.role === 'assistant'), exchange = cutoff < 0 ? after : after.slice(0, cutoff);
      const results = exchange.filter(value => value.data.role === 'tool' && value.data.toolCallId === proposal.providerCallId);
      if (origin < 0 || results.length !== 1 || results[0]!.data.content !== tool.output
        || results[0]!.data.toolResult && (results[0]!.data.toolResult as JsonObject).outcome === 'interrupted') fail('TOOLS_UNCERTAIN', 'Tool result history lacks its exact complete exchange');
    } else fail('TOOLS_UNCERTAIN', 'Tool dispatch has no confirmed terminal observation');
  }
  for (const part of parts) if (part.type === 'tool' && !byId.has(part.toolCallId) && (part.result !== undefined || ['completed','failed'].includes(part.state))) fail('TOOLS_UNCERTAIN', 'A tool result has no owned execution record');
  source.push(...toolRows, ...checkpoints, ...digestOrder(events, 'seq'));
}

function annotation(reference: string): { nativeId?: string } | null {
  if (/^(?:active-prefix-(?:policy|facts|manifest|checkpoint)|(?:image|document)-(?:policy|source)):[a-f0-9]{64}$/u.test(reference)) return {};
  if (reference.startsWith('instruction:')) {
    const tail = reference.lastIndexOf(':'), path = reference.slice('instruction:'.length, tail);
    if (sha(reference.slice(tail + 1)) && path.split('/').every(component => component !== '' && !['.','..'].includes(component)) && path.split('/').at(-1) === 'AGENTS.md') return {};
  }
  if (reference.startsWith('image-message:') || reference.startsWith('document-message:')) {
    const tail = reference.lastIndexOf(':'), nativeId = reference.slice(reference.indexOf(':') + 1, tail);
    if (id(nativeId) && sha(reference.slice(tail + 1))) return { nativeId };
  }
  return null;
}
function contextContract(context: Selected): void {
  if (Array.isArray(context.data.sourceIds) && context.data.sourceIds.length > limits.maxMessages * 2) fail('LIMIT', 'Immutable context source references exceed their bound');
  decoded(() => validateContextRevision(context.data));
}
function contextOwner(db: DatabaseSync, contextId: string, sessionId: string): void {
  const owner = db.prepare('SELECT c.session_id,c.run_id,c.turn_id,r.session_id AS run_session_id,r.workspace_id AS run_workspace_id,s.workspace_id,t.session_id AS turn_session_id,t.run_id AS turn_run_id FROM context_revisions c LEFT JOIN sessions s ON s.id=c.session_id LEFT JOIN runs r ON r.id=c.run_id LEFT JOIN session_turns t ON t.id=c.turn_id WHERE c.id=?').get(contextId);
  if (!owner) fail('SOURCE_CHANGED', 'Original immutable context revision is missing');
  if (owner.session_id !== sessionId || owner.workspace_id === null || owner.run_id !== null && (owner.run_session_id !== sessionId || owner.run_workspace_id !== owner.workspace_id)
    || owner.turn_id !== null && (owner.turn_session_id !== sessionId || owner.turn_run_id !== owner.run_id)) fail('OWNER_MISMATCH', 'Immutable context source belongs to another native owner');
}
function messageOwner(db: DatabaseSync, messageId: string, sessionId: string): void {
  const owner = db.prepare('SELECT m.session_id,m.run_id,r.session_id AS run_session_id,r.workspace_id AS run_workspace_id,s.workspace_id FROM messages m LEFT JOIN sessions s ON s.id=m.session_id LEFT JOIN runs r ON r.id=m.run_id WHERE m.id=?').get(messageId);
  if (!owner) fail('SOURCE_CHANGED', 'Immutable message source is missing');
  if (owner.session_id !== sessionId || owner.run_session_id !== sessionId || owner.workspace_id === null || owner.run_workspace_id !== owner.workspace_id) fail('OWNER_MISMATCH', 'Immutable message and its Run have different native owners');
}
function immutableSources(db: DatabaseSync, roots: Selected[], sessionId: string, budget: ProviderRecoveryBudget): Selected[] {
  const selectedSources: Selected[] = [], contexts = [...roots], visited = new Set(roots.map(context => `context_revisions:${context.row.id}`));
  let references = 0;
  for (let offset = 0; offset < contexts.length; offset++) {
    const context = contexts[offset]!;
    if (!Array.isArray(context.data.sourceIds) || context.data.sourceIds.length > limits.maxMessages * 2) fail('LIMIT', 'Immutable context source references exceed their bound');
    for (const reference of context.data.sourceIds) {
      if (!id(reference)) fail('SOURCE_CHANGED', 'Immutable context source identity is invalid');
      if (++references > limits.maxMessages * 2) fail('LIMIT', 'Immutable source closure exceeds its reference bound');
      const label = annotation(reference), nativeId = label?.nativeId ?? reference;
      if (label && !label.nativeId) continue;
      // Check original native ownership before returning the referenced body.
      const message = db.prepare('SELECT m.session_id,m.run_id,r.session_id AS run_session_id,r.workspace_id AS run_workspace_id,s.workspace_id FROM messages m LEFT JOIN sessions s ON s.id=m.session_id LEFT JOIN runs r ON r.id=m.run_id WHERE m.id=?').get(nativeId);
      const revision = db.prepare('SELECT c.session_id,c.run_id,c.turn_id,CAST(c.revision AS TEXT) AS revision,r.session_id AS run_session_id,t.session_id AS turn_session_id,t.run_id AS turn_run_id FROM context_revisions c LEFT JOIN runs r ON r.id=c.run_id LEFT JOIN session_turns t ON t.id=c.turn_id WHERE c.id=?').get(nativeId);
      if (!message && !revision || message && revision || label?.nativeId && !message) fail('SOURCE_CHANGED', 'An immutable context source is missing or ambiguous');
      const owner = message ?? revision!;
      if (owner.session_id !== sessionId || owner.run_id !== null && owner.run_session_id !== sessionId
        || revision?.turn_id !== undefined && revision.turn_id !== null && (revision.turn_session_id !== sessionId || revision.turn_run_id !== revision.run_id)) fail('OWNER_MISMATCH', 'Immutable context source belongs to another native owner');
      if (message) messageOwner(db, nativeId, sessionId);
      if (revision) contextOwner(db, nativeId, sessionId);
      if (revision && number(revision.revision, 1) >= Number(context.data.revision)) fail('SOURCE_CHANGED', 'Immutable context sources must precede their derived revision');
      const table = message ? 'messages' : 'context_revisions', pinId = `${table}:${nativeId}`;
      if (visited.has(pinId)) continue;
      if (visited.size >= limits.maxMessages * 2) fail('LIMIT', 'Immutable source closure exceeds its pin bound');
      const pinned = one(db, table, nativeId, budget, { sessionId }); visited.add(pinId); selectedSources.push(pinned);
      if (table === 'messages') {
        if (!['user','assistant','tool'].includes(String(pinned.data.role)) || typeof pinned.data.content !== 'string') fail('SOURCE_CHANGED', 'Immutable message source is malformed');
      } else {
        contextContract(pinned);
        if (pinned.data.sha256 !== textHash(String(pinned.data.text)) || Number(pinned.data.revision) >= Number(context.data.revision)) fail('SOURCE_CHANGED', 'Immutable context sources must precede their derived revision');
        contexts.push(pinned);
      }
    }
  }
  return selectedSources;
}

/** Selected evidence is bounded separately from the cleanup getter's own owner reads. */
export function readProviderRecoveryEvidence(db: DatabaseSync, store: Pick<SqliteStore,'getAttemptCleanup'|'getTurn'|'getAttempt'>,
  sessionId: string, attemptId: string, budget: ProviderRecoveryBudget): ProviderRecoveryEvidence {
  if (!id(sessionId) || !id(attemptId)) fail('INVALID_REQUEST', 'Provider recovery requires bounded exact owner identities');
  return readonly(db, () => {
    const attemptSource = one(db, 'provider_attempts', attemptId, budget, { sessionId });
    const attempt: ProviderAttempt = decoded(() => validateProviderAttempt(attemptSource.data));
    if (attempt.state !== 'uncertain' || attempt.uncertainty?.kind !== 'provider_dispatch') fail('NOT_NEEDED', 'Only an original uncertain provider dispatch is eligible');
    const runSource = one(db, 'runs', attempt.runId, budget, { sessionId }), run = runSource.data as unknown as Run;
    if (!['failed','cancelled','interrupted'].includes(run.state)) fail('BLOCKED', 'Provider recovery requires its own terminal failed or interrupted Run');
    const session = one(db, 'sessions', sessionId, budget, { workspaceId: run.workspaceId }), workspace = one(db, 'workspaces', run.workspaceId, budget);
    if (session.data.workspaceId !== run.workspaceId || workspace.data.id !== run.workspaceId) fail('OWNER_MISMATCH', 'Run workspace and session owner disagree');
    const normalized = decoded(() => normalizeSubmitInput({ sessionId, requestId: run.requestId, prompt: run.prompt, config: run.config, ...(run.attachments ? { attachments: run.attachments } : {}), ...(run.documents === undefined ? {} : { documents: run.documents }) }));
    if (hash(normalized.config) !== hash(run.config) || run.config.providerId !== attempt.providerId || run.config.modelId !== attempt.modelId) fail('OWNER_MISMATCH', 'Provider or model differs from the original Run');
    const turnSource = one(db, 'session_turns', attempt.turnId, budget, { sessionId, runId: run.id });
    const turn: TurnRecord = decoded(() => validateTurnRecord(turnSource.data));
    if (!(turn.state === 'uncertain' && turn.uncertainty?.kind === 'provider_dispatch') && !(turn.state === 'interrupted' && turn.uncertainty === undefined)) fail('OTHER_UNCERTAINTY', 'Provider recovery cannot waive tool, summary or independent cleanup uncertainty');
    if (db.prepare('SELECT id FROM session_turns WHERE run_id=? ORDER BY turn_index DESC LIMIT 1').get(run.id)?.id !== turn.id
      || db.prepare('SELECT id FROM provider_attempts WHERE turn_id=? ORDER BY attempt_index DESC LIMIT 1').get(turn.id)?.id !== attempt.id) fail('SOURCE_CHANGED', 'Provider recovery must select the latest exact Turn and Attempt');
    if (hash(decoded(() => store.getTurn(turn.id))) !== hash(turn) || hash(decoded(() => store.getAttempt(attempt.id))) !== hash(attempt)) fail('SOURCE_CHANGED', 'Native execution getters disagree with the selected snapshot');
    const cleanupSource = one(db, 'attempt_cleanup', attempt.id, budget, { sessionId, runId: run.id, workspaceId: run.workspaceId });
    const cleanup = decoded(() => store.getAttemptCleanup(attempt.id, sessionId));
    if (hash(cleanup) !== hash(cleanupSource.data) || cleanup.state !== 'confirmed' || cleanup.cleanupConfirmed !== true
      || !['iterator-next-done','iterator-return-done'].includes(String(cleanup.method)) || cleanup.attemptId !== attempt.id || cleanup.turnId !== turn.id
      || cleanup.providerId !== attempt.providerId || cleanup.modelId !== attempt.modelId || cleanup.contextRevisionId !== attempt.contextRevisionId
      || cleanup.requestProjection !== 'engine-turn-request-v1' || !sha(cleanup.requestSha256) || !Number.isSafeInteger(cleanup.requestBytes) || cleanup.requestBytes < 1
      || cleanup.providerRequestId !== attempt.providerRequestId) fail('CLEANUP_UNCONFIRMED', 'Provider recovery requires its actual exact request and confirmed iterator cleanup');
    const source: Selected[] = [runSource, turnSource, attemptSource, cleanupSource];
    let originalContext: Selected | undefined;
    if (attempt.contextRevisionId) {
      contextOwner(db, attempt.contextRevisionId, sessionId);
      const context = one(db, 'context_revisions', attempt.contextRevisionId, budget, { sessionId }); contextContract(context);
      if (context.data.runId !== undefined && context.data.runId !== run.id || context.data.turnId !== undefined && context.data.turnId !== turn.id
        || context.data.sha256 !== textHash(String(context.data.text))) fail('OWNER_MISMATCH', 'Original dispatch context revision is not owned by this request'); source.push(context); originalContext = context;
    }
    const input = one(db, 'inputs', run.inputId, budget, { sessionId });
    if (input.data.requestId !== run.requestId || input.row.request_id !== run.requestId || hash(input.data) !== hash(normalized) || input.row.fingerprint !== canonical(input.data)) fail('SOURCE_CHANGED', 'Original Run admission does not match its request'); source.push(input);
    const inputs = rows(db, 'session_inputs', 'run_id=?', [run.id], limits.maxMessages, budget, { sessionId, runId: run.id, workspaceId: run.workspaceId }, 'admitted_seq');
    for (const item of inputs) {
      const promoted = decoded(() => validateInputRecord(item.data));
      if (promoted.state !== 'promoted' || promoted.admittedSeq !== number(item.row.admitted_seq, 1) || promoted.promotedSeq !== number(item.row.promoted_seq, 1)
        || promoted.requestId !== item.row.request_id || promoted.delivery !== item.row.delivery
        || item.row.fingerprint !== canonical({ sessionId, requestId: promoted.requestId, prompt: promoted.prompt, config: promoted.config, delivery: promoted.delivery,
          ...(promoted.attachments === undefined ? {} : { attachments: promoted.attachments }), ...(promoted.documents === undefined ? {} : { documents: promoted.documents }) })) fail('SOURCE_CHANGED', 'Promoted input metadata is inconsistent');
    }
    if (!turn.inputIds.every(inputId => inputs.some(value => value.row.id === inputId)) || !inputs.some(value => value.row.id === run.inputId)) fail('SOURCE_CHANGED', 'Turn input provenance lacks its original promoted goal'); source.push(...digestOrder(inputs, 'admitted_seq'));
    const messages = rows(db, 'messages', 'run_id=?', [run.id], limits.maxMessages, budget, { sessionId, runId: run.id }, 'ordinal');
    for (const message of messages) if (!['user','assistant','tool'].includes(String(message.data.role)) || typeof message.data.content !== 'string' || number(message.row.ordinal, 1) < 1) fail('SOURCE_CHANGED', 'Run transcript message is malformed');
    const inputEvents = rows(db, 'events', "run_id=? AND type IN ('input.admitted','input.steered')", [run.id], limits.maxMessages, budget, { sessionId, runId: run.id }, 'seq');
    const admissions = inputEvents.filter(value => value.data.type === 'input.admitted'), initial = messages[0];
    if (admissions.length !== 1 || !initial || initial.data.role !== 'user' || initial.data.content !== run.prompt || hash(initial.data.attachments ?? null) !== hash(run.attachments ?? null) || hash(initial.data.documents ?? null) !== hash(run.documents ?? null)
      || initial.data.createdAt !== run.createdAt || number(admissions[0]!.row.seq, 1) !== number(input.row.admitted_seq, 1)) fail('SOURCE_CHANGED', 'Original user message does not match the admitted goal');
    object(admissions[0]!.data.payload); const admission = admissions[0]!.data.payload;
    if (admission.runId !== run.id || admission.inputId !== run.inputId || admission.requestId !== run.requestId) fail('SOURCE_CHANGED', 'Original admission event does not match the Run');
    const expectedUsers = new Set([initial.row.id]);
    for (const item of inputs) {
      if (item.row.id === run.inputId) {
        if (item.data.prompt !== run.prompt || item.data.requestId !== run.requestId || hash(item.data.config) !== hash(run.config) || hash(item.data.attachments ?? null) !== hash(run.attachments ?? null) || hash(item.data.documents ?? null) !== hash(run.documents ?? null)
          || number(item.row.legacy_seq, 1) !== number(input.row.admitted_seq, 1)) fail('SOURCE_CHANGED', 'Original promoted goal differs from the Run admission');
        continue;
      }
      const steering = inputEvents.filter(value => value.data.type === 'input.steered' && (value.data.payload as JsonObject)?.inputId === item.row.id);
      if (item.data.delivery !== 'steer' || steering.length !== 1) fail('SOURCE_CHANGED', 'Additional promoted input lacks its exact steering journal');
      object(steering[0]!.data.payload); const event = steering[0]!.data.payload, user = messages.find(value => value.row.id === event.messageId);
      if (event.requestId !== item.data.requestId || event.messageId !== item.row.id || number(steering[0]!.row.seq, 1) !== number(item.row.legacy_seq, 1)
        || !user || user.data.role !== 'user' || user.data.content !== item.data.prompt || hash(user.data.attachments ?? null) !== hash(item.data.attachments ?? null) || hash(user.data.documents ?? null) !== hash(item.data.documents ?? null)) fail('SOURCE_CHANGED', 'Steered user message differs from its promoted input');
      expectedUsers.add(user.row.id);
    }
    if (messages.some(value => value.data.role === 'user' && !expectedUsers.has(value.row.id)) || inputEvents.length !== inputs.length) fail('SOURCE_CHANGED', 'Run user history contains unmatched input provenance');
    source.push(...digestOrder(inputEvents, 'seq'));
    const partSources = rows(db, 'message_parts', 'run_id=?', [run.id], limits.maxMessages + limits.maxTools + limits.maxParts, budget, { sessionId, runId: run.id }, 'rowid');
    const parts = partSources.map(value => decoded(() => validateMessagePart(value.data)));
    if (parts.filter(value => value.turnId === turn.id).length > limits.maxParts) fail('LIMIT', 'Current provider parts exceed their bounded evidence count');
    for (const part of parts) {
      if (!messages.some(value => value.row.id === part.messageId && value.data.role === 'assistant') || part.state === 'open') fail('SOURCE_CHANGED', 'Provider Parts must retain a terminal owned assistant message');
      const header = db.prepare('SELECT session_id,run_id FROM session_turns WHERE id=?').get(part.turnId);
      if (header?.session_id !== sessionId || header.run_id !== run.id) fail('OWNER_MISMATCH', 'A provider Part belongs to another Turn owner');
    }
    source.push(...digestOrder(messages, 'ordinal'), ...partSources);
    if (originalContext) source.push(...immutableSources(db, [originalContext], sessionId, budget));
    toolEvidence(db, run, parts, messages, source, budget);
    const usage = rows(db, 'attempt_usage', 'attempt_id=?', [attempt.id], 1, budget, { sessionId, runId: run.id });
    if (usage[0]) {
      const value = usage[0]!.data; object(value.usage);
      if (value.turnId !== turn.id || value.revision !== number(usage[0]!.row.revision, 1) || Object.entries(value.usage).some(([field,count]) => !['inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens'].includes(field) || !Number.isSafeInteger(count) || Number(count) < 0)
        || value.usage.cachedInputTokens !== undefined && value.usage.inputTokens !== undefined && Number(value.usage.cachedInputTokens) > Number(value.usage.inputTokens)
        || value.usage.reasoningOutputTokens !== undefined && value.usage.outputTokens !== undefined && Number(value.usage.reasoningOutputTokens) > Number(value.usage.outputTokens)) fail('SOURCE_CHANGED', 'Attempt usage snapshot is inconsistent');
      source.push(usage[0]!);
    }
    const recordSha256 = hash({ run, turn, attempt }), cleanupRecordSha256 = decoded(() => canonicalAttemptCleanupSha256(cleanup)), usageSha256 = usage[0]?.sha256 ?? null;
    return { run, turn, attempt, cleanup, recordSha256, cleanupRecordSha256, usageSha256,
      sourceSha256: hash({ projection: 'provider-recovery-run-evidence-v1', recordSha256, cleanupRecordSha256, usageSha256, sources: source.map(value => ({ table: value.table, id: value.row.id, sha256: value.sha256 })) }) };
  });
}

/** Mutable documents are pinned for the decision; referenced immutable rows survive future head changes. */
export function readProviderRecoveryBaseline(db: DatabaseSync, sessionId: string, budget: ProviderRecoveryBudget): { hash: string; pins: ProviderRecoveryPin[] } {
  if (!id(sessionId)) fail('INVALID_REQUEST', 'Context baseline requires a bounded session identity');
  return readonly(db, () => {
    const session = one(db, 'sessions', sessionId, budget), documents: unknown[] = [], pins = new Map<string, ProviderRecoveryPin>();
    for (const kind of ['context.memory','context.active_memory','context.head']) {
      const row = db.prepare('SELECT CAST(revision AS TEXT) AS revision,length(CAST(data AS BLOB)) AS bytes FROM session_documents WHERE session_id=? AND kind=?').get(sessionId, kind);
      if (!row) { documents.push({ kind, absent: true }); continue; }
      const revision = number(row.revision, 1); if (!Number.isSafeInteger(row.bytes) || Number(row.bytes) > limits.maxContextDocumentBytes) fail('LIMIT', 'Context decision baseline exceeds its document bound'); charge(budget, row.bytes);
      const raw = readEvidenceBody(db, { table: 'session_documents', key: [sessionId, kind] }, { expectedBytes: Number(row.bytes), maxBytes: limits.maxContextDocumentBytes });
      if (raw === undefined) fail('SOURCE_CHANGED', 'Context decision baseline disappeared');
      const data = parse(raw); documents.push({ kind, revision, data });
      const pointer = kind === 'context.head' ? data.revisionId : data.active && typeof data.active === 'object' && !Array.isArray(data.active) ? data.active.revisionId : undefined;
      if (pointer === undefined) continue; if (!id(pointer)) fail('SOURCE_CHANGED', 'Context baseline contains an invalid immutable reference');
      contextOwner(db, pointer, sessionId);
      const context = one(db, 'context_revisions', pointer, budget, { sessionId }); contextContract(context);
      if (context.data.sha256 !== textHash(String(context.data.text))) fail('SOURCE_CHANGED', 'Immutable context text digest does not match');
      pins.set(`context_revisions:${pointer}`, { table: 'context_revisions', id: pointer, sha256: context.sha256 });
      for (const reference of immutableSources(db, [context], sessionId, budget)) pins.set(`${reference.table}:${reference.row.id}`, { table: reference.table as ProviderRecoveryPin['table'], id: String(reference.row.id), sha256: reference.sha256 });
      if (pins.size > limits.maxMessages * 2) fail('LIMIT', 'Context baseline exceeds its combined immutable pin bound');
    }
    return { hash: hash({ sessionId, workspaceId: session.data.workspaceId, documents }), pins: [...pins.values()] };
  });
}
export function providerRecoveryPinsValid(db: DatabaseSync, pins: ProviderRecoveryPin[], budget: ProviderRecoveryBudget): boolean {
  return readonly(db, () => {
    try {
      if (!Array.isArray(pins) || pins.length > limits.maxMessages * 2 || new Set(pins.map(pin => `${pin?.table}:${pin?.id}`)).size !== pins.length) return false;
      for (const pin of pins) {
        if (!pin || !['messages','context_revisions'].includes(pin.table) || !id(pin.id) || !sha(pin.sha256)) return false;
        const owner = db.prepare(`SELECT session_id FROM ${pin.table} WHERE id=?`).get(pin.id);
        if (!owner || !id(owner.session_id)) return false;
        if (pin.table === 'messages') messageOwner(db, pin.id, owner.session_id); else contextOwner(db, pin.id, owner.session_id);
        if (one(db, pin.table, pin.id, budget, { sessionId: owner.session_id }).sha256 !== pin.sha256) return false;
      }
      return true;
    } catch { return false; }
  });
}
