import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

const WINDOW = 2_000;
const SAFE = Number.MAX_SAFE_INTEGER;
type Row = Record<string, unknown>;
export interface MetricEventCursor { sessionId: string; seq: number }
export interface MetricEventCoverage {
  journal: 'events-v1'; limit: number; matchingEvents: number; selectedEvents: number; omittedEvents: number;
  truncated: boolean; oldest: MetricEventCursor | null; latest: MetricEventCursor | null;
  ordering: 'database-insertion'; filter: string;
}
export interface MetricUsageField {
  tokens: number | null; observed: number; missing: number; invalid: number; sumOverflow: boolean;
}
export interface MetricUsage {
  samples: number; inputTokens: MetricUsageField; outputTokens: MetricUsageField;
  cachedInputTokens: MetricUsageField; reasoningOutputTokens: MetricUsageField;
}
export interface MetricDuration {
  samples: number; missing: number; invalid: number; totalMs: number | null; minMs: number | null; maxMs: number | null;
  source: 'persisted-wall-clock-timestamps';
}
export interface MetricStates { total: number; states: Record<string, number>; serializedJsonBytes: number | null }
export interface NativeMetricsReport {
  schemaVersion: 6; generatedAt: string; scope: { sessionId: string | null };
  sessions: { total: number; paused: number; recoveryRequired: number };
  inputs: MetricStates & { queue: number; steer: number; pendingQueue: number; pendingSteer: number; pendingRequestBytes: number | null; pendingAge: MetricDuration; promotionWait: MetricDuration };
  runs: MetricStates; turns: MetricStates & { elapsed: MetricDuration };
  attempts: MetricStates & { retries: number; turnsWithRetries: number; retriesWithChangedContext: number; overflowRecoveries: null; elapsed: MetricDuration; dispatchedElapsed: MetricDuration };
  attemptCleanup: MetricStates & { attemptsWithoutObservation: number; recordValidity: null; providerOutcomeConfirmed: null; source: 'all-typed-attempt-cleanup-records-in-scope' };
  parts: MetricStates & { types: Record<'text' | 'reasoning' | 'tool' | 'media', number>; textUtf8Bytes: number | null; reasoningUtf8Bytes: number | null };
  providerUsage: MetricUsage & { aggregation: 'observed-event-sum'; inclusiveTotals: true; latestContext: { bytes: number; limit: number; summaryIncluded: boolean; turnIndex: number } | null };
  attemptUsage: MetricUsage & { aggregation: 'latest-snapshot-per-durable-attempt'; inclusiveTotals: true; attemptsWithUsage: number; attemptsWithoutUsage: number; source: 'all-attempt_usage-records-in-scope'; billedTokens: null };
  summary: { preparedEvents: number; dispatchedEvents: number; completedEvents: number; failedEvents: number; revisions: number; textUtf8Bytes: number | null; usage: MetricUsage; observedAttempts: number; usageEventsWithoutAttemptId: number; aggregation: 'latest-snapshot-per-summaryAttemptId' };
  summaryAttempts: MetricStates & { scopes: Record<'completed-history' | 'active-run-prefix', number>; providerCompletedAwaitingPublication: number; elapsed: MetricDuration; observedOutputBytes: number | null; retainedTextBytes: number | null; truncatedPartialTexts: number };
  summaryAttemptUsage: MetricUsage & { aggregation: 'latest-snapshot-per-durable-summary-attempt'; inclusiveTotals: true; attemptsWithUsage: number; attemptsWithoutUsage: number; source: 'all-summary_usage-records-in-scope'; billedTokens: null };
  artifacts: { references: number; uniqueIds: number; incompleteReferences: number; conflictingMetadataIds: number; storedBytesKnownIds: number; storedBytesUnknownIds: number; declaredStoredBytes: number | null; observedBytesKnownIds: number; declaredObservedBytes: number | null; legacyReferences: number; legacyDeclaredBytes: number | null; checkpointBindingEvents: number; physicalFiles: null; physicalBytes: null };
  checkpoints: { total: number; incomplete: number; files: number; serializedJsonBytes: number | null };
  recovery: { pausedSessions: number; workspacesWithDurableEvidence: number; uncertainTurns: number; uncertainAttempts: number; uncertainSummaries: number; summaryRecoveryAcknowledgments: number; summaryAcknowledgmentValidity: null; providerRecoveryAcknowledgments: number; providerAcknowledgmentValidity: null; cleanupUncertainRuns: number; cleanupUncertainToolEvents: number; runtimeQuarantinedWorkspaces: null; externalRecoveryLedgerRecords: null };
  coverage: { records: 'all-primary-records-in-scope'; usage: MetricEventCoverage; summary: MetricEventCoverage; tools: MetricEventCoverage; bytes: 'UTF-8 serialized JSON or declared reference metadata; never filesystem allocation'; time: 'wall-clock record timestamps; not provider CPU time or time to first token'; sql: 'fixed result size; full record/count aggregates may scan scoped history'; usageAttribution: 'legacy event sums and durable attempt snapshots are separate observations, not billed totals'; summaryAttribution: 'deduplicated only within the selected summary window'; durableSummary: 'all-typed-summary-attempts-in-scope; legacy journals are not backfilled'; externalStores: 'not-read' };
  unavailable: Array<{ metric: string; reason: string }>;
}

function safe(value: unknown): number | null {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : null;
}
function number(row: Row, key: string): number { return Number(row[key] ?? 0); }
function scope(sessionId: string | undefined, alias = ''): { clause: string; values: SQLInputValue[] } {
  return sessionId === undefined ? { clause: '1', values: [] } : { clause: `${alias}session_id=?`, values: [sessionId] };
}
function one(database: DatabaseSync, sql: string, values: SQLInputValue[] = []): Row {
  return database.prepare(sql).get(...values) as Row;
}
function states(database: DatabaseSync, table: string, names: readonly string[], sessionId?: string): MetricStates {
  const where = scope(sessionId);
  const row = one(database, `SELECT count(*) AS total,total(length(CAST(data AS BLOB))) AS bytes,${names.map(name => `count(CASE WHEN state='${name}' THEN 1 END) AS "${name}"`).join(',')} FROM ${table} WHERE ${where.clause}`, where.values);
  return { total: number(row, 'total'), serializedJsonBytes: safe(row.bytes), states: Object.fromEntries(names.map(name => [name, number(row, name)])) };
}

/** A numeric value must be a finite safe nonnegative integer. Zero is an observation. */
function validValue(object: string, key: string): string {
  const value = `json_extract(${object},'$.${key}')`;
  return `(json_type(${object},'$.${key}') IN ('integer','real') AND ${value}>=0 AND ${value}<=${SAFE} AND ${value}=CAST(${value} AS INTEGER))`;
}
function usage(database: DatabaseSync, cte: string, relation: string, values: SQLInputValue[]): MetricUsage {
  const keys = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens'] as const;
  const selects = keys.flatMap(key => {
    let valid = validValue('usage', key);
    if (key === 'cachedInputTokens' || key === 'reasoningOutputTokens') {
      const total = key === 'cachedInputTokens' ? 'inputTokens' : 'outputTokens';
      valid += ` AND (NOT ${validValue('usage', total)} OR json_extract(usage,'$.${key}')<=json_extract(usage,'$.${total}'))`;
    }
    const present = `json_type(usage,'$.${key}') IS NOT NULL AND json_type(usage,'$.${key}')!='null'`;
    return [`total(CASE WHEN ${valid} THEN json_extract(usage,'$.${key}') END) AS ${key}_sum`, `count(CASE WHEN ${valid} THEN 1 END) AS ${key}_observed`, `count(CASE WHEN NOT (${present}) THEN 1 END) AS ${key}_missing`, `count(CASE WHEN ${present} AND NOT (${valid}) THEN 1 END) AS ${key}_invalid`];
  });
  const row = one(database, `${cte} SELECT count(*) AS samples,${selects.join(',')} FROM ${relation}`, values);
  const fields = Object.fromEntries(keys.map(key => {
    const observed = number(row, `${key}_observed`), sum = safe(row[`${key}_sum`]);
    return [key, { tokens: observed ? sum : null, observed, missing: number(row, `${key}_missing`), invalid: number(row, `${key}_invalid`), sumOverflow: observed > 0 && sum === null }];
  })) as Pick<MetricUsage, typeof keys[number]>;
  return { samples: number(row, 'samples'), ...fields };
}
function duration(database: DatabaseSync, table: string, start: string, end: string, sessionId?: string): MetricDuration {
  const where = scope(sessionId);
  const row = one(database, `WITH records AS (SELECT json_extract(data,'$.${start}') AS startValue,json_extract(data,'$.${end}') AS endValue FROM ${table} WHERE ${where.clause}), samples AS (SELECT *,julianday(startValue) AS started,julianday(endValue) AS ended FROM records), intervals AS (SELECT CASE WHEN started IS NOT NULL AND ended>=started THEN round((ended-started)*86400000) END AS elapsed,CASE WHEN startValue IS NULL OR endValue IS NULL THEN 1 ELSE 0 END AS missing,CASE WHEN startValue IS NOT NULL AND endValue IS NOT NULL AND (started IS NULL OR ended IS NULL OR ended<started) THEN 1 ELSE 0 END AS invalid FROM samples) SELECT count(elapsed) AS samples,total(missing) AS missing,total(invalid) AS invalid,total(elapsed) AS total,min(elapsed) AS min,max(elapsed) AS max FROM intervals`, where.values);
  const samples = number(row, 'samples');
  return { samples, missing: number(row, 'missing'), invalid: number(row, 'invalid'), totalMs: samples ? safe(row.total) : null, minMs: safe(row.min), maxMs: safe(row.max), source: 'persisted-wall-clock-timestamps' };
}
function eventWindow(database: DatabaseSync, filter: string, sessionId?: string): { cte: string; values: SQLInputValue[]; coverage: MetricEventCoverage } {
  const where = scope(sessionId);
  const condition = `${where.clause} AND (${filter})`;
  const total = number(one(database, `SELECT count(*) AS count FROM events WHERE ${condition}`, where.values), 'count');
  // Ordering by rowid also works across sessions whose seq values are independent.
  // Materialize identities only. Large tool output/prompt fields are never copied
  // into a temporary 2,000-event payload table or materialized in JavaScript.
  const cte = `WITH window AS MATERIALIZED (SELECT rowid AS position,session_id,seq,type FROM events WHERE ${condition} ORDER BY rowid DESC LIMIT ${WINDOW}), selected AS NOT MATERIALIZED (SELECT w.*,json_extract(e.data,'$.payload') AS payload FROM window w JOIN events e ON e.rowid=w.position)`;
  const cursors = database.prepare(`${cte} SELECT session_id,seq FROM selected WHERE position IN ((SELECT min(position) FROM selected),(SELECT max(position) FROM selected)) ORDER BY position`).all(...where.values);
  const cursor = (row: Row | undefined): MetricEventCursor | null => row ? { sessionId: String(row.session_id), seq: Number(row.seq) } : null;
  const selected = Math.min(total, WINDOW);
  return { cte, values: where.values, coverage: { journal: 'events-v1', limit: WINDOW, matchingEvents: total, selectedEvents: selected, omittedEvents: total - selected, truncated: total > WINDOW, oldest: cursor(cursors[0]), latest: cursor(cursors.at(-1)), ordering: 'database-insertion', filter } };
}

/** Pure SQL projection; caller holds a read transaction and validates the optional owner. */
export function readNativeMetrics(database: DatabaseSync, sessionId?: string, generatedAt = new Date().toISOString()): NativeMetricsReport {
  const where = scope(sessionId);
  const inputs = states(database, 'session_inputs', ['pending', 'promoted', 'cancelled'], sessionId);
  const inputRow = one(database, `SELECT count(CASE WHEN delivery='queue' THEN 1 END) AS queue,count(CASE WHEN delivery='steer' THEN 1 END) AS steer,count(CASE WHEN state='pending' AND delivery='queue' THEN 1 END) AS pendingQueue,count(CASE WHEN state='pending' AND delivery='steer' THEN 1 END) AS pendingSteer,total(CASE WHEN state='pending' THEN bytes END) AS pendingBytes FROM session_inputs WHERE ${where.clause}`, where.values);
  // These views are connection-local CTEs, never persisted tables or extra reads of JSON in JS.
  const pendingDuration = (pending: boolean): MetricDuration => {
    const extra = pending ? "state='pending'" : "state='promoted'";
    const result = one(database, `WITH records AS (SELECT json_extract(data,'$.createdAt') AS startValue,${pending ? '?' : "json_extract(data,'$.updatedAt')"} AS endValue FROM session_inputs WHERE ${where.clause} AND ${extra}), intervals AS (SELECT *,julianday(startValue) AS started,julianday(endValue) AS ended FROM records), samples AS (SELECT CASE WHEN started IS NOT NULL AND ended>=started THEN round((ended-started)*86400000) END AS ms,CASE WHEN startValue IS NULL OR endValue IS NULL THEN 1 ELSE 0 END AS missing,CASE WHEN startValue IS NOT NULL AND endValue IS NOT NULL AND (started IS NULL OR ended IS NULL OR ended<started) THEN 1 ELSE 0 END AS invalid FROM intervals) SELECT count(ms) AS samples,total(missing) AS missing,total(invalid) AS invalid,total(ms) AS total,min(ms) AS min,max(ms) AS max FROM samples`, pending ? [generatedAt, ...where.values] : where.values);
    const samples = number(result, 'samples');
    return { samples, missing: number(result, 'missing'), invalid: number(result, 'invalid'), totalMs: samples ? safe(result.total) : null, minMs: safe(result.min), maxMs: safe(result.max), source: 'persisted-wall-clock-timestamps' };
  };
  const sessionScope = sessionId === undefined ? { clause: '1', values: [] } : { clause: 's.id=?', values: [sessionId] };
  const sessionRow = one(database, `SELECT count(*) AS total,count(CASE WHEN c.paused=1 THEN 1 END) AS paused,count(CASE WHEN c.paused=1 AND json_extract(c.data,'$.reason')='recovery_required' THEN 1 END) AS recovery FROM sessions s LEFT JOIN session_controls c ON c.session_id=s.id WHERE ${sessionScope.clause}`, sessionScope.values);
  const attempts = states(database, 'provider_attempts', ['prepared', 'dispatched', 'streaming', 'completed', 'failed', 'interrupted', 'uncertain'], sessionId);
  const retryScope = scope(sessionId, 'a.');
  const retryRow = one(database, `SELECT count(*) AS retries,count(DISTINCT a.turn_id) AS turns,count(CASE WHEN json_extract(a.data,'$.contextRevisionId') IS NOT json_extract(p.data,'$.contextRevisionId') THEN 1 END) AS changed FROM provider_attempts a LEFT JOIN provider_attempts p ON p.turn_id=a.turn_id AND p.attempt_index=a.attempt_index-1 WHERE ${retryScope.clause} AND a.attempt_index>0`, retryScope.values);
  const parts = states(database, 'message_parts', ['open', 'completed', 'failed', 'interrupted'], sessionId);
  const partRow = one(database, `SELECT ${['text', 'reasoning', 'tool', 'media'].map(type => `count(CASE WHEN json_extract(data,'$.type')='${type}' THEN 1 END) AS ${type}`).join(',')},total(CASE WHEN json_extract(data,'$.type')='text' THEN length(CAST(json_extract(data,'$.text') AS BLOB)) END) AS textBytes,total(CASE WHEN json_extract(data,'$.type')='reasoning' THEN length(CAST(json_extract(data,'$.text') AS BLOB)) END) AS reasoningBytes FROM message_parts WHERE ${where.clause}`, where.values);

  const main = eventWindow(database, "type IN ('run.usage','context.prepared')", sessionId);
  const mainUsage = usage(database, `${main.cte}, observations AS (SELECT payload AS usage FROM selected WHERE type='run.usage')`, 'observations', main.values);
  const attemptUsage = usage(database, `WITH observations AS (SELECT json_extract(u.data,'$.usage') AS usage FROM attempt_usage u
    JOIN provider_attempts a ON a.id=u.attempt_id AND a.session_id=u.session_id AND a.run_id=u.run_id AND a.turn_id=u.turn_id WHERE ${scope(sessionId,'u.').clause})`, 'observations', where.values);
  const summaryAttempts = states(database, 'summary_attempts', ['prepared', 'dispatched', 'streaming', 'completed', 'failed', 'interrupted', 'uncertain'], sessionId);
  const summaryRecoveryRow = one(database, `SELECT count(*) AS count FROM summary_recovery_acknowledgments WHERE ${where.clause}`, where.values);
  const providerRecoveryRow = one(database, `SELECT count(*) AS count FROM provider_recovery_acknowledgments WHERE ${where.clause}`, where.values);
  const summaryAttemptUsage = usage(database, `WITH observations AS (SELECT json_extract(u.data,'$.usage') AS usage FROM summary_usage u
    JOIN summary_attempts a ON a.id=u.summary_attempt_id AND a.session_id=u.session_id AND a.run_id=u.run_id WHERE ${scope(sessionId, 'u.').clause})`, 'observations', where.values);
  const summaryAttemptRow = one(database, `SELECT count(CASE WHEN scope='completed-history' THEN 1 END) AS history,
    count(CASE WHEN scope='active-run-prefix' THEN 1 END) AS prefix,
    count(CASE WHEN state='streaming' AND json_extract(data,'$.providerCompletedAt') IS NOT NULL AND json_extract(data,'$.cleanupConfirmed')=1 THEN 1 END) AS awaiting,
    total(json_extract(data,'$.observedOutputBytes')) AS observedBytes,total(json_extract(data,'$.retainedTextBytes')) AS retainedBytes,
    count(CASE WHEN json_extract(data,'$.partialTextTruncated')=1 THEN 1 END) AS truncated FROM summary_attempts WHERE ${where.clause}`, where.values);
  const contextRow = one(database, `${main.cte} SELECT json_extract(payload,'$.bytes') AS bytes,json_extract(payload,'$.limit') AS budget,json_extract(payload,'$.turnIndex') AS turnIndex,json_extract(payload,'$.summaryIncluded') AS summaryIncluded FROM selected WHERE type='context.prepared' ORDER BY position DESC LIMIT 1`, main.values);
  const contextValid = contextRow && safe(contextRow.bytes) !== null && safe(contextRow.budget) !== null && safe(contextRow.turnIndex) !== null;
  const summary = eventWindow(database, "type IN ('summary.prepared','summary.dispatched','summary.completed','summary.failed') OR (type='provider.usage' AND json_extract(data,'$.payload.purpose')='summary')", sessionId);
  const summaryCte = `${summary.cte}, snapshots AS (SELECT position,json_extract(payload,'$.summaryAttemptId') AS id,CASE WHEN type='summary.completed' THEN json_extract(payload,'$.usage') ELSE payload END AS usage FROM selected WHERE type IN ('summary.completed','provider.usage')), ranked AS (SELECT usage,id,row_number() OVER (PARTITION BY id ORDER BY position DESC) AS rank FROM snapshots WHERE typeof(id)='text' AND length(id)>0)`;
  const summaryUsage = usage(database, summaryCte, '(SELECT usage FROM ranked WHERE rank=1)', summary.values);
  const summaryRow = one(database, `${summary.cte} SELECT ${['prepared', 'dispatched', 'completed', 'failed'].map(type => `count(CASE WHEN type='summary.${type}' THEN 1 END) AS ${type}`).join(',')},count(CASE WHEN type IN ('summary.completed','provider.usage') AND (typeof(json_extract(payload,'$.summaryAttemptId'))!='text' OR length(json_extract(payload,'$.summaryAttemptId'))=0 OR json_extract(payload,'$.summaryAttemptId') IS NULL) THEN 1 END) AS missingId,count(DISTINCT CASE WHEN typeof(json_extract(payload,'$.summaryAttemptId'))='text' AND length(json_extract(payload,'$.summaryAttemptId'))>0 THEN json_extract(payload,'$.summaryAttemptId') END) AS attempts FROM selected`, summary.values);
  const revisionRow = one(database, `SELECT count(*) AS count,total(length(CAST(json_extract(data,'$.text') AS BLOB))) AS bytes FROM context_revisions WHERE ${where.clause} AND json_extract(data,'$.kind')='summary'`, where.values);
  const tools = eventWindow(database, "type IN ('tool.completed','tool.failed','tool.denied','checkpoint.artifacts')", sessionId);
  const cleanupRow = one(database, `${tools.cte} SELECT count(CASE WHEN type LIKE 'tool.%' AND (json_extract(payload,'$.cleanupConfirmed')=0 OR json_extract(payload,'$.cleanupUncertain')=1) THEN 1 END) AS cleanup,count(CASE WHEN type='checkpoint.artifacts' THEN 1 END) AS bindings FROM selected`, tools.values);
  // Artifact byte totals use unique IDs. A checkpoint-only ID has no byte observation.
  const artifactCte = `${tools.cte}, refs AS (
    SELECT json_extract(data,'$.artifact') AS ref FROM message_parts WHERE ${where.clause} AND json_extract(data,'$.type')='media'
    UNION ALL SELECT j.value FROM message_parts p,json_each(p.data,'$.result.artifactRefs') j WHERE ${scope(sessionId, 'p.').clause} AND json_extract(p.data,'$.type')='tool' AND j.type='object'
    UNION ALL SELECT j.value FROM selected s,json_each(s.payload,'$.artifactRefs') j WHERE s.type LIKE 'tool.%' AND j.type='object'
    UNION ALL SELECT json_object('id',json_extract(j.value,'$.artifactId'),'complete',json_extract(j.value,'$.complete')) FROM selected s,json_each(s.payload,'$.artifacts') j WHERE s.type='checkpoint.artifacts' AND j.type='object'
  ), identified AS (SELECT ref,json_extract(ref,'$.id') AS id FROM refs WHERE typeof(json_extract(ref,'$.id'))='text' AND length(json_extract(ref,'$.id'))>0), ids AS (
    SELECT id,count(*) AS refs,count(CASE WHEN json_extract(ref,'$.complete')=0 THEN 1 END) AS incomplete,min(CASE WHEN ${validValue('ref', 'storedBytes')} THEN json_extract(ref,'$.storedBytes') END) AS storedMin,max(CASE WHEN ${validValue('ref', 'storedBytes')} THEN json_extract(ref,'$.storedBytes') END) AS storedMax,min(CASE WHEN ${validValue('ref', 'observedBytes')} THEN json_extract(ref,'$.observedBytes') END) AS observedMin,max(CASE WHEN ${validValue('ref', 'observedBytes')} THEN json_extract(ref,'$.observedBytes') END) AS observedMax,min(json_extract(ref,'$.sha256')) AS shaMin,max(json_extract(ref,'$.sha256')) AS shaMax FROM identified GROUP BY id
  ), checked AS (SELECT *,CASE WHEN storedMin IS NOT storedMax OR observedMin IS NOT observedMax OR shaMin IS NOT shaMax THEN 1 ELSE 0 END AS conflict FROM ids)`;
  const artifactValues = [...tools.values, ...where.values, ...where.values];
  const artifactRow = one(database, `${artifactCte} SELECT total(refs) AS refs,count(*) AS ids,total(incomplete) AS incomplete,total(conflict) AS conflicts,count(CASE WHEN storedMax IS NOT NULL AND conflict=0 THEN 1 END) AS storedKnown,total(CASE WHEN conflict=0 THEN storedMax END) AS storedBytes,count(CASE WHEN observedMax IS NOT NULL AND conflict=0 THEN 1 END) AS observedKnown,total(CASE WHEN conflict=0 THEN observedMax END) AS observedBytes FROM checked`, artifactValues);
  const legacyRow = one(database, `${tools.cte} SELECT count(*) AS refs,count(CASE WHEN ${validValue('j.value', 'bytes')} THEN 1 END) AS known,total(CASE WHEN ${validValue('j.value', 'bytes')} THEN json_extract(j.value,'$.bytes') END) AS bytes FROM selected s,json_each(s.payload,'$.artifacts') j WHERE s.type LIKE 'tool.%' AND j.type='object'`, tools.values);
  const checkpointScope = scope(sessionId, 'r.');
  const checkpointRow = one(database, `SELECT count(*) AS count,count(CASE WHEN json_extract(c.data,'$.incomplete')=1 THEN 1 END) AS incomplete,total(json_array_length(c.data,'$.files')) AS files,total(length(CAST(c.data AS BLOB))) AS bytes FROM checkpoints c JOIN runs r ON r.id=c.run_id WHERE ${checkpointScope.clause}`, checkpointScope.values);
  const cleanupRunRow = one(database, `SELECT count(*) AS count FROM runs WHERE ${where.clause} AND json_extract(data,'$.error.code')='CLEANUP_UNCERTAIN'`, where.values);
  const evidenceRow = one(database, `WITH evidence AS (
    SELECT s.workspace_id FROM session_controls c JOIN sessions s ON s.id=c.session_id WHERE ${scope(sessionId, 'c.').clause} AND c.paused=1 AND json_extract(c.data,'$.reason')='recovery_required'
    UNION SELECT r.workspace_id FROM session_turns t JOIN runs r ON r.id=t.run_id WHERE ${scope(sessionId, 't.').clause} AND t.state='uncertain'
    UNION SELECT r.workspace_id FROM provider_attempts a JOIN runs r ON r.id=a.run_id WHERE ${scope(sessionId, 'a.').clause} AND a.state='uncertain'
    UNION SELECT workspace_id FROM summary_attempts WHERE ${where.clause} AND state='uncertain'
    UNION SELECT workspace_id FROM attempt_cleanup WHERE ${where.clause} AND state='uncertain'
    UNION SELECT workspace_id FROM runs WHERE ${where.clause} AND json_extract(data,'$.error.code')='CLEANUP_UNCERTAIN'
  ) SELECT count(*) AS count FROM evidence`, [...where.values, ...where.values, ...where.values, ...where.values, ...where.values, ...where.values]);
  const turns = states(database, 'session_turns', ['created', 'streaming', 'awaiting_tools', 'completed', 'failed', 'interrupted', 'uncertain'], sessionId);
  const attemptCleanup = states(database, 'attempt_cleanup', ['prepared','dispatched','confirmed','uncertain','not-dispatched'], sessionId);
  const noCleanup = one(database, `SELECT count(*) AS count FROM provider_attempts a LEFT JOIN attempt_cleanup c ON c.attempt_id=a.id AND c.session_id=a.session_id AND c.run_id=a.run_id AND c.turn_id=a.turn_id WHERE ${scope(sessionId, 'a.').clause} AND c.attempt_id IS NULL`, where.values);
  const artifactIds = number(artifactRow, 'ids'), storedKnown = number(artifactRow, 'storedKnown'), observedKnown = number(artifactRow, 'observedKnown');
  return {
    schemaVersion: 6, generatedAt, scope: { sessionId: sessionId ?? null },
    sessions: { total: number(sessionRow, 'total'), paused: number(sessionRow, 'paused'), recoveryRequired: number(sessionRow, 'recovery') },
    inputs: { ...inputs, queue: number(inputRow, 'queue'), steer: number(inputRow, 'steer'), pendingQueue: number(inputRow, 'pendingQueue'), pendingSteer: number(inputRow, 'pendingSteer'), pendingRequestBytes: safe(inputRow.pendingBytes), pendingAge: pendingDuration(true), promotionWait: pendingDuration(false) },
    runs: states(database, 'runs', ['created', 'running', 'awaiting_approval', 'cancelling', 'completed', 'cancelled', 'failed', 'interrupted'], sessionId),
    turns: { ...turns, elapsed: duration(database, 'session_turns', 'createdAt', 'completedAt', sessionId) },
    attempts: { ...attempts, retries: number(retryRow, 'retries'), turnsWithRetries: number(retryRow, 'turns'), retriesWithChangedContext: number(retryRow, 'changed'), overflowRecoveries: null, elapsed: duration(database, 'provider_attempts', 'createdAt', 'completedAt', sessionId), dispatchedElapsed: duration(database, 'provider_attempts', 'dispatchedAt', 'completedAt', sessionId) },
    attemptCleanup: { ...attemptCleanup, attemptsWithoutObservation: number(noCleanup, 'count'), recordValidity: null, providerOutcomeConfirmed: null, source: 'all-typed-attempt-cleanup-records-in-scope' },
    parts: { ...parts, types: { text: number(partRow, 'text'), reasoning: number(partRow, 'reasoning'), tool: number(partRow, 'tool'), media: number(partRow, 'media') }, textUtf8Bytes: safe(partRow.textBytes), reasoningUtf8Bytes: safe(partRow.reasoningBytes) },
    providerUsage: { ...mainUsage, aggregation: 'observed-event-sum', inclusiveTotals: true, latestContext: contextValid ? { bytes: Number(contextRow.bytes), limit: Number(contextRow.budget), turnIndex: Number(contextRow.turnIndex), summaryIncluded: contextRow.summaryIncluded === 1 } : null },
    attemptUsage: { ...attemptUsage, aggregation: 'latest-snapshot-per-durable-attempt', inclusiveTotals: true,
      attemptsWithUsage: attemptUsage.samples, attemptsWithoutUsage: attempts.total-attemptUsage.samples,
      source: 'all-attempt_usage-records-in-scope', billedTokens: null },
    summary: { preparedEvents: number(summaryRow, 'prepared'), dispatchedEvents: number(summaryRow, 'dispatched'), completedEvents: number(summaryRow, 'completed'), failedEvents: number(summaryRow, 'failed'), revisions: number(revisionRow, 'count'), textUtf8Bytes: safe(revisionRow.bytes), usage: summaryUsage, observedAttempts: number(summaryRow, 'attempts'), usageEventsWithoutAttemptId: number(summaryRow, 'missingId'), aggregation: 'latest-snapshot-per-summaryAttemptId' },
    summaryAttempts: { ...summaryAttempts, scopes: { 'completed-history': number(summaryAttemptRow, 'history'), 'active-run-prefix': number(summaryAttemptRow, 'prefix') },
      providerCompletedAwaitingPublication: number(summaryAttemptRow, 'awaiting'), elapsed: duration(database, 'summary_attempts', 'createdAt', 'completedAt', sessionId),
      observedOutputBytes: safe(summaryAttemptRow.observedBytes), retainedTextBytes: safe(summaryAttemptRow.retainedBytes), truncatedPartialTexts: number(summaryAttemptRow, 'truncated') },
    summaryAttemptUsage: { ...summaryAttemptUsage, aggregation: 'latest-snapshot-per-durable-summary-attempt', inclusiveTotals: true,
      attemptsWithUsage: summaryAttemptUsage.samples, attemptsWithoutUsage: summaryAttempts.total-summaryAttemptUsage.samples, source: 'all-summary_usage-records-in-scope', billedTokens: null },
    artifacts: { references: number(artifactRow, 'refs'), uniqueIds: artifactIds, incompleteReferences: number(artifactRow, 'incomplete'), conflictingMetadataIds: number(artifactRow, 'conflicts'), storedBytesKnownIds: storedKnown, storedBytesUnknownIds: artifactIds - storedKnown, declaredStoredBytes: storedKnown ? safe(artifactRow.storedBytes) : null, observedBytesKnownIds: observedKnown, declaredObservedBytes: observedKnown ? safe(artifactRow.observedBytes) : null, legacyReferences: number(legacyRow, 'refs'), legacyDeclaredBytes: number(legacyRow, 'known') ? safe(legacyRow.bytes) : null, checkpointBindingEvents: number(cleanupRow, 'bindings'), physicalFiles: null, physicalBytes: null },
    checkpoints: { total: number(checkpointRow, 'count'), incomplete: number(checkpointRow, 'incomplete'), files: number(checkpointRow, 'files'), serializedJsonBytes: safe(checkpointRow.bytes) },
    recovery: { pausedSessions: number(sessionRow, 'recovery'), workspacesWithDurableEvidence: number(evidenceRow, 'count'), uncertainTurns: turns.states.uncertain!, uncertainAttempts: attempts.states.uncertain!, uncertainSummaries: summaryAttempts.states.uncertain!, summaryRecoveryAcknowledgments: number(summaryRecoveryRow, 'count'), summaryAcknowledgmentValidity: null, providerRecoveryAcknowledgments: number(providerRecoveryRow, 'count'), providerAcknowledgmentValidity: null, cleanupUncertainRuns: number(cleanupRunRow, 'count'), cleanupUncertainToolEvents: number(cleanupRow, 'cleanup'), runtimeQuarantinedWorkspaces: null, externalRecoveryLedgerRecords: null },
    coverage: { records: 'all-primary-records-in-scope', usage: main.coverage, summary: summary.coverage, tools: tools.coverage, bytes: 'UTF-8 serialized JSON or declared reference metadata; never filesystem allocation', time: 'wall-clock record timestamps; not provider CPU time or time to first token', sql: 'fixed result size; full record/count aggregates may scan scoped history', usageAttribution: 'legacy event sums and durable attempt snapshots are separate observations, not billed totals', summaryAttribution: 'deduplicated only within the selected summary window', durableSummary: 'all-typed-summary-attempts-in-scope; legacy journals are not backfilled', externalStores: 'not-read' },
    unavailable: [
      { metric: 'attemptCleanup.recordValidity/providerOutcomeConfirmed', reason: 'SQL counts reflect stored observation states, not owner/request verification or provider outcome confirmation. Legacy attempts are not backfilled.' },
      { metric: 'attempts.overflowRecoveries', reason: 'Attempt records do not persist retry/overflow causes; a changed context is not proof of overflow recovery.' },
      { metric: 'providerUsage.billedTokens/attemptUsage.billedTokens', reason: 'Observed usage is not billing reconciliation. Legacy event sums and durable per-attempt snapshots are separate projections.' },
      { metric: 'summaryAttemptUsage.billedTokens/legacySummaryAttemptLifecycle', reason: 'Durable summary usage is a separate nullable observation. Legacy events do not prove a typed attempt lifecycle and are not backfilled.' },
      { metric: 'artifacts.physicalFiles/physicalBytes', reason: 'Primary metadata does not measure the artifact filesystem or terminal/review/recovery stores.' },
      { metric: 'recovery.runtimeQuarantinedWorkspaces', reason: 'Coordinator quarantine is runtime state; durable recovery evidence is reported separately.' },
      { metric: 'recovery.summaryAcknowledgmentValidity', reason: 'Recorded acknowledgment count includes archived or stale physical bindings; only the host preview and admission predicate validate current storage and source bindings.' },
      { metric: 'recovery.providerAcknowledgmentValidity', reason: 'Recorded provider decisions include historical or invalid bindings; raw counts do not validate cleanup, immutable source or current admission safety.' },
      { metric: 'recovery.externalRecoveryLedgerRecords', reason: 'This read does not inspect external recovery acknowledgements or review journals.' },
    ],
  };
}
