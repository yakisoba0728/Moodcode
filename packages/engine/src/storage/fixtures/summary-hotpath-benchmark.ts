import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LIMITS } from '@moodcode/contracts';
import { SqliteStore } from '../index.js';

export interface HotpathMeasurement { returnedSqlBytes: number; queries: number; summaryFullPayloadReads: number; summaryTextBytesReturned: number; writeStatements: number; elapsedMs: number }
/** Measures SQL values returned to JS, not SQLite pages read or physical I/O. */
export function measureSummarySql<T>(db: DatabaseSync, operation: () => T): { result: T; measurement: HotpathMeasurement } {
  const prepare = db.prepare.bind(db), measurement: HotpathMeasurement = { returnedSqlBytes: 0, queries: 0, summaryFullPayloadReads: 0, summaryTextBytesReturned: 0, writeStatements: 0, elapsedMs: 0 };
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    for (const method of ['get','all'] as const) {
      const original = statement[method].bind(statement);
      const wrapped = (...args: unknown[]) => {
        const result = Reflect.apply(original, undefined, args); measurement.queries++;
        if (result !== undefined) measurement.returnedSqlBytes += Buffer.byteLength(JSON.stringify(result));
        if (/^SELECT data FROM summary_attempts WHERE id=/u.test(sql)) measurement.summaryFullPayloadReads++;
        if (/FROM summary_attempts/u.test(sql)) for (const row of Array.isArray(result) ? result : result ? [result] : []) {
          if (row && typeof row === 'object' && typeof row.data === 'string') { const parsed = JSON.parse(row.data) as { partialText?: unknown }; if (typeof parsed.partialText === 'string') measurement.summaryTextBytesReturned += Buffer.byteLength(parsed.partialText); }
        }
        return result;
      };
      Object.defineProperty(statement, method, { value: wrapped, configurable: true, writable: true });
    }
    const run = statement.run.bind(statement);
    statement.run = ((...args: unknown[]) => { measurement.writeStatements++; return Reflect.apply(run, undefined, args); }) as typeof statement.run;
    return statement;
  }) as typeof db.prepare;
  const started = performance.now();
  try { return { result: operation(), measurement }; }
  finally { measurement.elapsedMs = performance.now()-started; db.prepare = prepare; }
}

/** Synthetic historical row cardinality plus one real 64KiB provider observation. */
export function summaryHotpathFixture(records: number) {
  const store = new SqliteStore(':memory:'), db = (store as unknown as { db: DatabaseSync }).db, createdAt = '2026-10-07T00:00:00.000Z';
  store.putWorkspace({ id: 'workspace', root: '/tmp/moodcode-summary-hotpath-fixture', gitRoot: '/tmp/moodcode-summary-hotpath-fixture', branch: null, createdAt });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Hotpath fixture', createdAt });
  const config = { providerId: 'scripted', modelId: 'local', mode: 'build' as const, limits: { ...DEFAULT_LIMITS } };
  const runId = store.admit({ sessionId: 'session', requestId: 'goal', prompt: 'Fixture goal', config }).runId;
  store.commit(runId, 'run.started', {}, { run: { state: 'running' } });
  store.createSummaryAttempt({ id: 'target', scope: 'completed-history', sessionId: 'session', workspaceId: 'workspace', runId, providerId: 'scripted', modelId: 'local',
    sourceProjection: 'conversation-text-v1', sourceSha256: '1'.repeat(64), requestSha256: '2'.repeat(64), requestBytes: 1024, expectedMemoryRevision: 0, sourceMessageIds: ['source'], sourceRunIds: ['source-run'], createdAt });
  store.dispatchSummaryAttempt('target'); store.observeSummaryAttempt('target', { textDelta: 't'.repeat(65536), providerRequestId: 'provider-request', usage: { inputTokens: 20, outputTokens: 10 } });
  const template = { ...store.getSummaryAttempt('target'), observedOutputBytes: 0, retainedTextBytes: 0, partialText: '' };
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare('INSERT INTO summary_attempts(id,session_id,workspace_id,run_id,scope,state,revision,data) VALUES(?,?,?,?,?,?,?,?)');
    for (let index = 1; index < records; index++) { const record = { ...template, id: `history-${index}` }; insert.run(record.id,record.sessionId,record.workspaceId,record.runId,record.scope,record.state,record.revision,JSON.stringify(record)); }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); store.close(); throw error; }
  return { store, db, runId };
}
export function runSummaryHotpathBenchmark(records: number) {
  const f = summaryHotpathFixture(records);
  try {
    const getUsage = measureSummarySql(f.db, () => f.store.getSummaryUsage('target')).measurement;
    const duplicateUsage = measureSummarySql(f.db, () => f.store.observeSummaryAttempt('target', { usage: { inputTokens: 20, outputTokens: 10 } })).measurement;
    const duplicateProgress = measureSummarySql(f.db, () => f.store.observeSummaryAttempt('target', { providerRequestId: 'provider-request' })).measurement;
    const textObservation = measureSummarySql(f.db, () => f.store.observeSummaryAttempt('target', { textDelta: 'x' })).measurement;
    const settlement = measureSummarySql(f.db, () => f.store.settleSummaryAttempt('target', { state: 'failed', errorCode: 'FIXTURE_END', cleanupConfirmed: true })).measurement;
    return { records, targetRetainedTextBytes: 65536, scope: 'SQL-values-returned-to-JavaScript;not-physical-I/O', getUsage, duplicateUsage, duplicateProgress, textObservation, settlement };
  } finally { f.store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) for (const count of [1000,10000]) process.stdout.write(`${JSON.stringify(runSummaryHotpathBenchmark(count))}\n`);
