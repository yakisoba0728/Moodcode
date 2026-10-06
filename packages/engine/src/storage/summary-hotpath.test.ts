import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { measureSummarySql, runSummaryHotpathBenchmark, summaryHotpathFixture } from './fixtures/summary-hotpath-benchmark.js';

const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;

test('1k/10k historical records do not amplify exact lookup bytes; usage never returns the 64KiB text', () => {
  const measurements = [1000,10000].map(runSummaryHotpathBenchmark);
  for (const result of measurements) {
    assert.equal(result.getUsage.summaryTextBytesReturned, 0); assert.equal(result.getUsage.summaryFullPayloadReads, 0);
    assert.ok(result.getUsage.returnedSqlBytes < 4096); assert.equal(result.getUsage.writeStatements, 0);
    for (const operation of [result.duplicateUsage,result.duplicateProgress,result.textObservation,result.settlement]) assert.equal(operation.summaryFullPayloadReads, 1);
    assert.equal(result.duplicateUsage.writeStatements, 0); assert.equal(result.duplicateProgress.writeStatements, 0);
    assert.ok(result.textObservation.returnedSqlBytes < 70000);
  }
  for (const operation of ['getUsage','duplicateUsage','duplicateProgress','textObservation','settlement'] as const) {
    assert.equal(measurements[0]![operation].returnedSqlBytes, measurements[1]![operation].returnedSqlBytes);
    assert.equal(measurements[0]![operation].queries, measurements[1]![operation].queries);
  }
});

test('metadata lookup validates SQL owners, source/proof/status and exact retained bytes without fetching text', () => {
  const f = summaryHotpathFixture(1);
  try {
    const original = String(f.db.prepare("SELECT data FROM summary_attempts WHERE id='target'").get()!.data);
    const target = JSON.parse(original) as Record<string,unknown>;
    const mismatches: [string,unknown,string][] = [['runId','wrong-run','SUMMARY_BINDING_MISMATCH'], ['sourceSha256','invalid-sha','INVALID_SUMMARY_RECORD'], ['requestSha256','invalid','INVALID_SUMMARY_RECORD'],
      ['expectedMemoryRevision',-1,'INVALID_SUMMARY_RECORD'], ['sourceMessageIds',['duplicate','duplicate'],'INVALID_SUMMARY_RECORD'], ['boundaryAttemptId','\0bad','INVALID_SUMMARY_RECORD'],
      ['publication','activated','INVALID_SUMMARY_RECORD'], ['retainedTextBytes',65535,'INVALID_SUMMARY_RECORD'], ['observedOutputBytes',0,'INVALID_SUMMARY_RECORD'], ['cleanupConfirmed',0,'INVALID_SUMMARY_RECORD'],
      ['partialText',1,'INVALID_SUMMARY_RECORD'], ['schemaVersion',3,'SUMMARY_BINDING_MISMATCH']];
    for (const [key,value,code] of mismatches) {
      f.db.prepare("UPDATE summary_attempts SET data=? WHERE id='target'").run(JSON.stringify({ ...target,[key]:value }));
      const result = measureSummarySql(f.db, () => assert.throws(() => f.store.getSummaryUsage('target'), hasCode(code)));
      assert.equal(result.measurement.summaryTextBytesReturned, 0, key); assert.equal(result.measurement.summaryFullPayloadReads, 0, key);
    }
    f.db.prepare("UPDATE summary_attempts SET data=? WHERE id='target'").run(original);
    assert.equal(f.store.getSummaryUsage('target')!.usage.inputTokens, 20);
    assert.equal(f.store.getSummaryAttempt('target').partialText.length, 65536);
  } finally { f.store.close(); }
});

test('owner preflight rejects wrong session before metadata projection even when its stored JSON is malformed', () => {
  const f = summaryHotpathFixture(1);
  try {
    f.db.prepare("UPDATE summary_attempts SET data='not JSON' WHERE id='target'").run();
    const result = measureSummarySql(f.db, () => assert.throws(() => f.store.getSummaryUsage('target', 'another-session'), hasCode('SUMMARY_BINDING_MISMATCH')));
    assert.equal(result.measurement.queries, 1); assert.equal(result.measurement.summaryFullPayloadReads, 0);
    assert.equal(result.measurement.summaryTextBytesReturned, 0); assert.ok(result.measurement.returnedSqlBytes < 512);
  } finally { f.store.close(); }
});

test('oversized metadata, complete record and duplicate retained-text keys fail before text can be returned', () => {
  const f = summaryHotpathFixture(1);
  try {
    const original = String(f.db.prepare("SELECT data FROM summary_attempts WHERE id='target'").get()!.data), target = JSON.parse(original) as Record<string,unknown>;
    for (const data of [JSON.stringify({ ...target, unexpected: 'x'.repeat(90000) }), `{"partialText":"duplicate",${original.slice(1)}`]) {
      f.db.prepare("UPDATE summary_attempts SET data=? WHERE id='target'").run(data);
      const result = measureSummarySql(f.db, () => assert.throws(() => f.store.getSummaryUsage('target')));
      assert.equal(result.measurement.summaryTextBytesReturned, 0); assert.ok(result.measurement.returnedSqlBytes < 512);
    }
    f.db.exec('PRAGMA ignore_check_constraints=ON');
    f.db.prepare("UPDATE summary_attempts SET data=? WHERE id='target'").run(JSON.stringify({ ...target, unexpected: 'x'.repeat(524288) }));
    const large = measureSummarySql(f.db, () => assert.throws(() => f.store.getSummaryUsage('target'), hasCode('SUMMARY_RECORD_LIMIT')));
    assert.equal(large.measurement.queries, 1); assert.equal(large.measurement.summaryTextBytesReturned, 0);
  } finally { f.store.close(); }
});

test('first empty progress establishes streaming exactly once; duplicate observations preserve counters, proof and revision', () => {
  const f = summaryHotpathFixture(1);
  try {
    f.store.createSummaryAttempt({ id: 'prepared', scope: 'completed-history', sessionId: 'session', workspaceId: 'workspace', runId: f.runId, providerId: 'scripted', modelId: 'local',
      sourceProjection: 'conversation-text-v1', sourceSha256: '1'.repeat(64), requestSha256: '2'.repeat(64), requestBytes: 1024, expectedMemoryRevision: 0 });
    const dispatch = measureSummarySql(f.db, () => f.store.dispatchSummaryAttempt('prepared')); assert.equal(dispatch.measurement.summaryFullPayloadReads, 1);
    const first = f.store.observeSummaryAttempt('prepared', {}); assert.equal(first.state, 'streaming'); assert.ok(first.firstObservationAt);
    const empty = measureSummarySql(f.db, () => f.store.observeSummaryAttempt('prepared', {})); assert.deepEqual(empty.result, first); assert.equal(empty.measurement.writeStatements, 0);
    const observed = f.store.getSummaryAttempt('target');
    for (const observation of [{ usage: { inputTokens: 20, cachedInputTokens: null } }, { providerRequestId: 'provider-request' }, { textDelta: '' }, {}]) {
      const next = measureSummarySql(f.db, () => f.store.observeSummaryAttempt('target', observation)); assert.deepEqual(next.result, observed); assert.equal(next.measurement.writeStatements, 0);
    }
    f.store.observeSummaryAttempt('prepared', { textDelta: 'complete', finishReason: 'stop' });
    const provider = f.store.markSummaryProviderCompleted('prepared');
    assert.deepEqual(f.store.observeSummaryAttempt('prepared', { usage: { inputTokens: null } }), provider);
    assert.throws(() => f.store.observeSummaryAttempt('prepared', {}), hasCode('SUMMARY_ATTEMPT_IMMUTABLE'));
    const final = f.store.settleSummaryAttempt('prepared', { state: 'failed', cleanupConfirmed: true, errorCode: 'FIXTURE_DONE' });
    const duplicate = measureSummarySql(f.db, () => f.store.settleSummaryAttempt('prepared', { state: 'failed', cleanupConfirmed: true, errorCode: 'FIXTURE_DONE' }));
    assert.deepEqual(duplicate.result, final); assert.equal(duplicate.measurement.writeStatements, 0); assert.equal(duplicate.measurement.summaryFullPayloadReads, 1);
  } finally { f.store.close(); }
});

test('single-read observation still rolls back invalid usage and a late journal failure with text and usage together', () => {
  const f = summaryHotpathFixture(1);
  try {
    const before = f.store.getSummaryAttempt('target'), usage = f.store.getSummaryUsage('target');
    assert.throws(() => f.store.observeSummaryAttempt('target', { textDelta: 'visible', usage: { inputTokens: 19 } }), hasCode('SUMMARY_USAGE_REGRESSION'));
    assert.deepEqual(f.store.getSummaryAttempt('target'), before); assert.deepEqual(f.store.getSummaryUsage('target'), usage);
    f.db.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON session_events WHEN NEW.type='provider.usage' BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END");
    const result = measureSummarySql(f.db, () => assert.throws(() => f.store.observeSummaryAttempt('target', { textDelta: 'visible', usage: { outputTokens: 11 } }), /synthetic late failure/u));
    assert.equal(result.measurement.summaryFullPayloadReads, 1);
    assert.deepEqual(f.store.getSummaryAttempt('target'), before); assert.deepEqual(f.store.getSummaryUsage('target'), usage);
  } finally { f.store.close(); }
});

test('UTF8 metadata bytes preserve split-surrogate observations and reject mutated terminal proof', () => {
  const f = summaryHotpathFixture(1);
  try {
    const target = f.store.getSummaryAttempt('target');
    f.db.prepare("UPDATE summary_attempts SET data=? WHERE id='target'").run(JSON.stringify({ ...target, partialText: '😀', retainedTextBytes: 4, observedOutputBytes: 6 }));
    assert.equal(f.store.getSummaryUsage('target')!.usage.outputTokens, 10); assert.equal(f.store.getSummaryAttempt('target').partialText, '😀');
    f.store.observeSummaryAttempt('target', { finishReason: 'stop' }); f.store.markSummaryProviderCompleted('target');
    f.store.settleSummaryAttempt('target', { state: 'failed', cleanupConfirmed: true, errorCode: 'FIXTURE_DONE' });
    const final = f.store.getSummaryAttempt('target');
    f.db.prepare("UPDATE summary_attempts SET data=? WHERE id='target'").run(JSON.stringify({ ...final, completedAt: undefined }));
    assert.throws(() => f.store.getSummaryUsage('target'), hasCode('INVALID_SUMMARY_RECORD'));
  } finally { f.store.close(); }
});
