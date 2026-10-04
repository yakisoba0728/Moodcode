import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type ApprovalRecord, type Message, type RunConfig, type ToolCallRecord } from '@moodcode/contracts';
import { SqliteStore } from './index.js';

const date = '2026-10-04T00:00:00.000Z';
const config: RunConfig = { providerId: 'codex', modelId: 'gpt-fixture', mode: 'build', reasoningEffort: 'ultra', limits: { ...DEFAULT_LIMITS, maxOutputBytes: 1_048_576 } };
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-next-stage-history-'));
  const dbPath = join(directory, 'engine.sqlite');
  let store = new SqliteStore(dbPath);
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: 'main', createdAt: date });
  for (const id of ['session', 'other']) store.createSession({ id, workspaceId: 'workspace', title: id, createdAt: date });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  function start(requestId: string, sessionId = 'session') {
    const receipt = store.admit({ sessionId, requestId, prompt: requestId, config: structuredClone(config) });
    store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
    return store.getRun(receipt.runId);
  }
  function complete(requestId: string, bytes = 0, sessionId = 'session') {
    const run = start(requestId, sessionId);
    const message: Message = { id: `${run.id}-assistant`, runId: run.id, sessionId, role: 'assistant', content: bytes ? 'a'.repeat(bytes) : `${requestId} answer`, createdAt: date,
      providerReplay: { providerId: 'codex', items: [{ type: 'reasoning', encrypted_content: `opaque-${requestId}` }] } };
    store.commit(run.id, 'message.completed', {}, { message });
    if (bytes) {
      const tool: ToolCallRecord = { id: `${run.id}-tool`, runId: run.id, sessionId, name: 'read_file', input: { path: 'fixture.py' }, state: 'completed', output: 'b'.repeat(bytes) };
      store.commit(run.id, 'tool.completed', {}, { tool, message: { id: `${run.id}-tool-message`, runId: run.id, sessionId, role: 'tool', content: tool.output!, toolCallId: 'provider-call', createdAt: date } });
    }
    store.commit(run.id, 'run.completed', {}, { run: { state: 'completed' } });
    return run;
  }
  return { get store() { return store; }, start, complete, reopen() { store.close(); store = new SqliteStore(dbPath); } };
}

test('real SQLite history pages preserve chronological whole-run boundaries and hide native replay without deleting it', t => {
  const f = fixture(t);
  const ids = Array.from({ length: 7 }, (_, index) => f.complete(`request-${index}`).id);
  let cursor: string | undefined;
  const seen: string[] = [];
  for (let index = 0; index < 4; index++) {
    const page = f.store.getHistory('session', cursor, 2);
    assert.equal(page.snapshot.lastSeq, f.store.getSnapshot('session').lastSeq);
    assert.ok(page.snapshot.messages.every(message => page.snapshot.runs.some(run => run.id === message.runId)));
    assert.ok(page.snapshot.messages.every(message => !Object.hasOwn(message, 'providerReplay')));
    assert.ok(page.snapshot.runs.every(run => run.config.reasoningEffort === 'ultra'));
    seen.unshift(...page.snapshot.runs.map(run => run.id));
    assert.equal(page.beforeRunId, page.snapshot.runs[0]!.id);
    cursor = page.beforeRunId!;
    if (!page.hasMore) break;
  }
  assert.deepEqual(seen, ids);
  assert.equal(new Set(seen).size, ids.length);
  assert.equal(f.store.getHistory('session', ids[0], 2).snapshot.runs.length, 0);
  const original = f.store.getSnapshot('session');
  assert.equal(original.messages.filter(message => message.providerReplay).length, 7);
  f.reopen();
  assert.deepEqual(f.store.getSnapshot('session'), original);
  assert.deepEqual(f.store.getHistory('session', undefined, 2).snapshot.runs.map(run => run.id), ids.slice(-2));
  const other = f.complete('other-run', 0, 'other');
  assert.throws(() => f.store.getHistory('session', other.id), code('INVALID_HISTORY_CURSOR'));
  assert.throws(() => f.store.getHistory('session', 'absent'), code('INVALID_HISTORY_CURSOR'));
  for (const limit of [0, 51, 1.5]) assert.throws(() => f.store.getHistory('session', undefined, limit), code('INVALID_PAGE_SIZE'));
});

test('a display byte cap drops whole older run groups but makes every dropped group reachable on the next page', t => {
  const f = fixture(t);
  const ids = Array.from({ length: 5 }, (_, index) => f.complete(`large-${index}`, 350_000).id);
  const latest = f.store.getHistory('session', undefined, 5);
  assert.ok(latest.snapshot.runs.length < 5);
  assert.equal(latest.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(latest.snapshot)) <= 4_194_304);
  assert.equal(latest.truncatedRecords, false);
  for (const run of latest.snapshot.runs) {
    assert.equal(latest.snapshot.messages.filter(message => message.runId === run.id).length, 3);
    assert.equal(latest.snapshot.tools.filter(tool => tool.runId === run.id).length, 1);
  }
  const older = f.store.getHistory('session', latest.beforeRunId!, 5);
  assert.deepEqual([...older.snapshot.runs, ...latest.snapshot.runs].map(run => run.id), ids);
  assert.equal(older.hasMore, false);
  assert.equal(f.store.getSnapshot('session').runs.length, 5);
});

test('history pages keep the active approval fingerprint and preview exact and detached', t => {
  const f = fixture(t);
  f.complete('finished');
  const run = f.start('pending');
  const tool: ToolCallRecord = { id: 'pending-tool', runId: run.id, sessionId: 'session', name: 'apply_patch', input: { changes: [] }, state: 'awaiting_approval' };
  const approval: ApprovalRecord = { id: 'pending-approval', runId: run.id, sessionId: 'session', toolCallId: tool.id, toolName: tool.name, fingerprint: 'exact-fingerprint', status: 'pending', preview: { path: 'app.py', before: 'answer = 1', after: 'answer = 2', nested: { exact: true } }, createdAt: date };
  f.store.commit(run.id, 'approval.requested', {}, { run: { state: 'awaiting_approval' }, tool, approval });
  const page = f.store.getHistory('session', undefined, 1);
  assert.deepEqual(page.snapshot.approvals, [approval]);
  assert.equal(page.snapshot.tools[0]!.state, 'awaiting_approval');
  page.snapshot.approvals[0]!.preview.nested = 'caller mutation';
  assert.deepEqual(f.store.getApproval(approval.id), approval);
});

test('metrics distinguish missing usage from explicit zero and record the latest serialized context', t => {
  const f = fixture(t);
  assert.deepEqual(f.store.getMetrics('session'), { observedUsageEvents: 0, inputTokens: null, outputTokens: null, usageWindowTruncated: false, context: null });
  const run = f.start('usage');
  f.store.commit(run.id, 'run.usage', { turnIndex: 0, inputTokens: 7 });
  f.store.commit(run.id, 'context.prepared', { turnIndex: 0, bytes: 1024, limit: 8192, summaryIncluded: false });
  f.store.commit(run.id, 'run.usage', { turnIndex: 1, inputTokens: 0, outputTokens: 3 });
  f.store.commit(run.id, 'context.prepared', { turnIndex: 1, bytes: 2048, limit: 8192, summaryIncluded: true });
  assert.deepEqual(f.store.getMetrics('session'), { observedUsageEvents: 2, inputTokens: 7, outputTokens: 3, usageWindowTruncated: false, context: { turnIndex: 1, bytes: 2048, limit: 8192, summaryIncluded: true } });
  assert.equal(f.store.getMetrics('other').inputTokens, null);
  assert.throws(() => f.store.getMetrics('missing'), code('SESSION_NOT_FOUND'));
  f.store.commit(run.id, 'run.completed', {}, { run: { state: 'completed' } });
  f.reopen();
  assert.equal(f.store.getMetrics('session').context!.summaryIncluded, true);
});

test('the bounded metrics window advertises older omissions and recomputes supplied counts from its actual event window', t => {
  const f = fixture(t);
  const run = f.start('many-usage');
  for (let index = 0; index < 2001; index++) f.store.commit(run.id, 'run.usage', { turnIndex: index, inputTokens: 1, outputTokens: 0 });
  assert.deepEqual(f.store.getMetrics('session'), { observedUsageEvents: 2000, inputTokens: 2000, outputTokens: 0, usageWindowTruncated: true, context: null });
  f.store.commit(run.id, 'context.prepared', { turnIndex: 2001, bytes: 100, limit: 8192, summaryIncluded: true });
  const metrics = f.store.getMetrics('session');
  assert.equal(metrics.observedUsageEvents, 1999);
  assert.equal(metrics.inputTokens, 1999);
  assert.equal(metrics.outputTokens, 0);
  assert.equal(metrics.usageWindowTruncated, true);
  assert.equal(metrics.context!.summaryIncluded, true);
});
