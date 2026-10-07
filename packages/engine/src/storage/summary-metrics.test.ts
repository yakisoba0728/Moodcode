import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS } from '@moodcode/contracts';
import { SqliteStore } from './index.js';

const config = { providerId: 'fixture', modelId: 'fixture', mode: 'plan' as const, limits: { ...DEFAULT_LIMITS } };
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'moodcode-summary-metrics-')), path = join(root, 'engine.sqlite'), store = new SqliteStore(path);
  const createdAt = new Date().toISOString(); store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt });
  for (const id of ['session', 'other']) store.createSession({ id, workspaceId: 'workspace', title: id, createdAt });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const receipt = store.admit({ sessionId: 'session', requestId: 'metrics', prompt: 'Metrics fixture', config });
  store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
  const prepare = (id: string) => store.createSummaryAttempt({ id, scope: 'completed-history', sessionId: 'session', workspaceId: 'workspace', runId: receipt.runId,
    providerId: 'fixture', modelId: 'fixture', sourceProjection: 'conversation-text-v1', sourceSha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64), requestBytes: 128,
    sourceMessageIds: [], sourceRunIds: [], expectedMemoryRevision: 0 });
  return { store, path, runId: receipt.runId, prepare };
}

test('durable summary metrics preserve unknown, zero, partial usage and ordinary Attempt separation', t => {
  const f = fixture(t); f.prepare('unknown'); f.prepare('partial'); f.store.dispatchSummaryAttempt('partial');
  f.store.observeSummaryAttempt('partial', { textDelta: 'Private summary partial text must not appear in metrics', usage: { inputTokens: 7, outputTokens: 0 } });
  f.store.observeSummaryAttempt('partial', { usage: { inputTokens: 9, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1 } });
  f.store.settleSummaryAttempt('partial', { state: 'failed', errorCode: 'SUMMARY_INCOMPLETE', cleanupConfirmed: true });
  const before = f.store.readEvents('session', 0), report = f.store.getNativeMetrics('session');
  assert.equal(report.schemaVersion, 6); assert.equal(report.summaryAttempts.total, 2); assert.equal(report.summaryAttempts.states.failed, 1); assert.equal(report.summaryAttempts.states.prepared, 1);
  assert.equal(report.summaryAttemptUsage.samples, 1); assert.equal(report.summaryAttemptUsage.attemptsWithoutUsage, 1);
  assert.equal(report.summaryAttemptUsage.inputTokens.tokens, 9); assert.equal(report.summaryAttemptUsage.outputTokens.tokens, 3);
  assert.equal(report.summaryAttemptUsage.cachedInputTokens.tokens, 2); assert.equal(report.summaryAttemptUsage.reasoningOutputTokens.tokens, 1);
  assert.equal(report.summaryAttemptUsage.billedTokens, null); assert.equal(report.attemptUsage.samples, 0); assert.equal(report.providerUsage.samples, 0);
  assert.equal(report.coverage.durableSummary, 'all-typed-summary-attempts-in-scope; legacy journals are not backfilled');
  assert.equal(JSON.stringify(report).includes('Private summary'), false); assert.deepEqual(f.store.readEvents('session', 0), before);
  const empty = f.store.getNativeMetrics('other'); assert.equal(empty.summaryAttempts.total, 0); assert.equal(empty.summaryAttemptUsage.samples, 0); assert.equal(empty.summaryAttemptUsage.outputTokens.tokens, null);
});

test('durable summary aggregates exceed the legacy event window without payload materialization or cross-owner usage', t => {
  const f = fixture(t); f.prepare('seed'); f.store.dispatchSummaryAttempt('seed'); f.store.observeSummaryAttempt('seed', { usage: { inputTokens: 7, outputTokens: 0 } });
  f.store.settleSummaryAttempt('seed', { state: 'failed', errorCode: 'SUMMARY_INCOMPLETE', cleanupConfirmed: true });
  const seed = f.store.getSummaryAttempt('seed'), seedUsage = f.store.getSummaryUsage('seed')!, db = new DatabaseSync(f.path);
  try {
    // Synthetic primary records test the SQL aggregate boundary, not live provider work.
    db.exec('BEGIN IMMEDIATE');
    const attempt = db.prepare('INSERT INTO summary_attempts(id,session_id,workspace_id,run_id,scope,state,revision,data) VALUES(?,?,?,?,?,?,?,?)');
    const usage = db.prepare('INSERT INTO summary_usage(summary_attempt_id,session_id,run_id,revision,data) VALUES(?,?,?,?,?)');
    for (let index = 0; index < 2100; index++) {
      const id = `scoped-${index}`, record = { ...seed, id }, observation = { ...seedUsage, summaryAttemptId: id, usage: { inputTokens: 1, outputTokens: 0, cachedInputTokens: null, reasoningOutputTokens: null } };
      attempt.run(id, 'session', 'workspace', f.runId, record.scope, record.state, record.revision, JSON.stringify(record));
      usage.run(id, 'session', f.runId, observation.revision, JSON.stringify(observation));
    }
    db.exec('COMMIT');
    for (let index = 0; index < 2005; index++) f.store.commit(f.runId, 'provider.usage', { purpose: 'summary', summaryAttemptId: `legacy-${index}`, inputTokens: 1, outputTokens: 0 });
    const report = f.store.getNativeMetrics('session');
    assert.equal(report.summaryAttempts.total, 2101); assert.equal(report.summaryAttemptUsage.samples, 2101);
    assert.equal(report.summaryAttemptUsage.inputTokens.tokens, 2107); assert.equal(report.summaryAttemptUsage.outputTokens.tokens, 0);
    assert.equal(report.summaryAttemptUsage.cachedInputTokens.tokens, null); assert.equal(report.summaryAttemptUsage.cachedInputTokens.missing, 2101);
    assert.equal(report.summary.usage.samples, 2000); assert.equal(report.coverage.summary.truncated, true);
    assert.equal(report.attemptUsage.samples, 0); assert.ok(Buffer.byteLength(JSON.stringify(report)) < 20000);
    db.prepare("UPDATE summary_usage SET session_id='other' WHERE summary_attempt_id='scoped-0'").run();
    const changed = f.store.getNativeMetrics('session'); assert.equal(changed.summaryAttemptUsage.samples, 2100); assert.equal(changed.summaryAttemptUsage.inputTokens.tokens, 2106);
    assert.equal(f.store.getNativeMetrics('other').summaryAttemptUsage.samples, 0);
  } finally { db.close(); }
});
