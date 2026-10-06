import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ENGINE_BUDGETS, DEFAULT_LIMITS, EngineError, type RunConfig } from '@moodcode/contracts';
import { createHash } from 'node:crypto';
import { SqliteStore } from '../storage/index.js';
import { BudgetAccount } from '../config/budgets.js';
import type { ContextRequest, ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { SemanticMemoryService, SEMANTIC_MEMORY_PREFIX } from './semantic-memory.js';
import { ContextService } from './service.js';

const config: RunConfig = { providerId: 'fixture', modelId: 'summary-model', mode: 'plan', limits: { ...DEFAULT_LIMITS }, budgets: { ...DEFAULT_ENGINE_BUDGETS } };
function fixture(t: test.TestContext) {
  const store = new SqliteStore(':memory:'); t.after(() => store.close());
  const createdAt = new Date().toISOString();
  store.putWorkspace({ id: 'workspace', root: process.cwd(), gitRoot: process.cwd(), branch: null, createdAt });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'memory', createdAt });
  const old = store.admit({ sessionId: 'session', requestId: 'old', prompt: 'Preserve the goal', config });
  store.commit(old.runId, 'run.started', {}, { run: { state: 'running' } });
  store.commit(old.runId, 'message.completed', {}, { message: { id: 'old-answer', sessionId: 'session', runId: old.runId, role: 'assistant', content: 'Changed a fixture and checked it.', createdAt } });
  store.commit(old.runId, 'run.completed', {}, { run: { state: 'completed' } });
  const current = store.admit({ sessionId: 'session', requestId: 'current', prompt: 'Continue unfinished work', config });
  store.commit(current.runId, 'run.started', {}, { run: { state: 'running' } });
  const budget = new BudgetAccount(config);
  const request: ContextRequest = { workspace: store.getWorkspace('workspace'), snapshot: store.getSnapshot('session'), config, signal: new AbortController().signal, run: store.getRun(current.runId), budget };
  return { store, request, memory: new SemanticMemoryService(store), oldRunId: old.runId, currentRunId: current.runId };
}
function provider(events: ProviderEvent[], inspect?: (request: TurnRequest) => void): ProviderAdapter {
  return { id: 'fixture', async *streamTurn(request) { inspect?.(request); yield* events; } };
}

test('concurrent summaries publish against their prepared memory revision and preserve the first completed checkpoint', async t => {
  const f = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  let entered!: () => void;
  const dispatched = new Promise<void>(resolve => { entered = resolve; });
  const slow: ProviderAdapter = { id: 'fixture', async *streamTurn() {
    entered(); await gate;
    yield { type: 'text.delta', delta: 'Stale slow summary must not overwrite the winner.' };
    yield { type: 'finish', reason: 'stop' };
  } };
  const pending = f.memory.summarize(f.request, slow);
  // Attach the rejection before the other stream publishes to avoid an
  // unhandled rejection if either execution completes immediately.
  const rejection = assert.rejects(pending, (error: unknown) => (error as { code: string }).code === 'REVISION_CONFLICT');
  await dispatched;
  const winner = await f.memory.summarize(f.request, provider([{ type: 'text.delta', delta: 'Winning complete derived memory.' }, { type: 'finish', reason: 'stop' }]));
  const document = f.store.getSessionDocument('session', 'context.memory');
  release(); await rejection;
  assert.deepEqual(f.store.getSessionDocument('session', 'context.memory'), document);
  assert.equal(f.memory.active('session')?.checkpoint.id, winner.id);
  assert.equal(f.store.getLatestContextRevision('session')?.id, winner.revisionId);
  const events = f.store.readEvents('session', 0);
  assert.equal(events.filter(event => event.type === 'summary.completed').length, 1);
  assert.ok(events.some(event => event.type === 'summary.failed' && event.payload.code === 'REVISION_CONFLICT'));
  assert.equal(f.request.budget!.snapshot().summaryCalls, 2);
});

test('semantic checkpoint uses a tool-free request, exact provenance, inclusive usage and immutable original messages', async t => {
  const f = fixture(t), before = f.store.getSnapshot('session').messages;
  let bytes = 0, observedRequest: TurnRequest | undefined;
  const checkpoint = await f.memory.summarize({ ...f.request, consumeSummaryOutput: count => { bytes += count; } }, provider([
    { type: 'text.delta', delta: 'Goal retained; fixture verified; continue work.' }, { type: 'usage', inputTokens: 20, outputTokens: 8, cachedInputTokens: 5, reasoningOutputTokens: 2 }, { type: 'finish', reason: 'stop' },
  ], request => { observedRequest = structuredClone(request); assert.deepEqual(request.tools, []); assert.ok(request.messages[0]!.content.includes('historical')); }));
  assert.equal(bytes, Buffer.byteLength('Goal retained; fixture verified; continue work.'));
  assert.equal(f.request.budget!.snapshot().summaryCalls, 1);
  assert.deepEqual(checkpoint.usage, { inputTokens: 20, outputTokens: 8, cachedInputTokens: 5, reasoningOutputTokens: 2 });
  assert.deepEqual(checkpoint.sourceRunIds, [f.oldRunId]);
  assert.equal(f.store.getContextRevision(checkpoint.revisionId).kind, 'summary');
  assert.deepEqual(f.store.getSnapshot('session').messages, before);
  const projected = f.memory.project(f.request);
  assert.equal(projected.snapshot.messages.length, 1);
  assert.equal(projected.snapshot.messages[0]!.runId, f.currentRunId);
  assert.ok(projected.semanticMemory!.content.startsWith(SEMANTIC_MEMORY_PREFIX));
  assert.equal(f.store.readEvents('session', 0).filter(event => event.type === 'summary.completed').length, 1);
  assert.ok(observedRequest);
  const attempt = f.store.getSummaryAttempt(checkpoint.id);
  assert.equal(attempt.scope, 'completed-history'); assert.equal(attempt.state, 'completed');
  assert.equal(attempt.publication, 'activated'); assert.equal(attempt.cleanupConfirmed, true);
  assert.ok(attempt.providerCompletedAt); assert.equal(attempt.summaryRevisionId, checkpoint.revisionId);
  assert.equal(attempt.requestSha256, createHash('sha256').update(JSON.stringify(observedRequest)).digest('hex'));
  assert.equal(attempt.requestBytes, Buffer.byteLength(JSON.stringify(observedRequest)));
  assert.deepEqual(f.store.getSummaryUsage(checkpoint.id)?.usage, checkpoint.usage);
  assert.equal(f.request.budget!.snapshot().logicalTurns, 0);
});

test('observed delta bytes remain charged to the Run when the separate semantic summary cap rejects them', async t => {
  const f = fixture(t), budgets = { ...DEFAULT_ENGINE_BUDGETS, maxSummaryBytes: 4096 };
  let observedBytes = 0;
  const request = { ...f.request, config: { ...config, budgets }, budget: new BudgetAccount({ ...config, budgets }),
    consumeSummaryOutput: (bytes: number) => { observedBytes += bytes; } };
  await assert.rejects(f.memory.summarize(request, provider([{ type: 'text.delta', delta: 'x'.repeat(4097) }, { type: 'finish', reason: 'stop' }])),
    (error: unknown) => (error as { code: string }).code === 'SUMMARY_OUTPUT_LIMIT');
  assert.equal(observedBytes, 4097); assert.equal(request.budget.snapshot().summaryCalls, 1);
  assert.equal(f.store.getSessionDocument('session', 'context.memory'), null);
  assert.equal(f.store.getLatestContextRevision('session'), null);
  const id = String(f.store.readEvents('session', 0).findLast(event => event.type === 'summary.prepared')!.payload.summaryAttemptId);
  const attempt = f.store.getSummaryAttempt(id);
  assert.equal(attempt.state, 'failed'); assert.equal(attempt.observedOutputBytes, 4097);
  assert.equal(attempt.partialText, 'x'.repeat(4097)); assert.equal(attempt.cleanupConfirmed, true);
});

test('semantic decreasing cumulative usage preserves the last valid snapshot and partial output after confirmed cleanup', async t => {
  const f = fixture(t);
  let id: string | undefined;
  await assert.rejects(f.memory.summarize(f.request, provider([
    { type: 'text.delta', delta: 'Observed unfinished historical fact' },
    { type: 'usage', inputTokens: 20, outputTokens: 4, cachedInputTokens: 5 },
    { type: 'usage', inputTokens: 19, outputTokens: 5 },
  ], request => { id = request.attemptId; })), (error: unknown) => error instanceof EngineError && error.code === 'SUMMARY_PROTOCOL_ERROR');
  assert.ok(id); const attempt = f.store.getSummaryAttempt(id);
  assert.equal(attempt.state, 'failed'); assert.equal(attempt.cleanupConfirmed, true); assert.equal(attempt.providerCompletedAt, undefined);
  assert.equal(attempt.partialText, 'Observed unfinished historical fact');
  assert.deepEqual(f.store.getSummaryUsage(id)?.usage, { inputTokens: 20, outputTokens: 4, cachedInputTokens: 5, reasoningOutputTokens: null });
  assert.equal(f.store.readEvents('session', 0).filter(event => event.type === 'provider.usage' && event.payload.summaryAttemptId === id).length, 1);
  assert.equal(f.store.getSessionDocument('session', 'context.memory'), null); assert.equal(f.store.getLatestContextRevision('session'), null);
});

test('semantic cleanup uncertainty has one terminal record and retains partial observations without activating', async t => {
  const f = fixture(t); let id: string | undefined, index = 0;
  const broken: ProviderAdapter = { id: 'fixture', streamTurn(request) {
    id = request.attemptId;
    return { [Symbol.asyncIterator]() { return { async next() {
      if (index++ === 0) return { done: false, value: { type: 'text.delta', delta: 'Visible partial fact' } as ProviderEvent };
      if (index === 2) return { done: false, value: { type: 'usage', inputTokens: 7 } as ProviderEvent };
      throw undefined;
    } }; } };
  } };
  await assert.rejects(f.memory.summarize(f.request, broken), (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_UNCERTAIN');
  assert.ok(id); const attempt = f.store.getSummaryAttempt(id);
  assert.equal(attempt.state, 'uncertain'); assert.equal(attempt.cleanupConfirmed, false);
  assert.equal(attempt.partialText, 'Visible partial fact'); assert.equal(f.store.getSummaryUsage(id)?.usage.inputTokens, 7);
  const events = f.store.readEvents('session', 0).filter(event => event.payload.summaryAttemptId === id);
  assert.equal(events.filter(event => ['summary.failed', 'summary.interrupted', 'summary.uncertain', 'summary.completed'].includes(event.type)).length, 1);
  assert.equal(events.at(-1)?.type, 'summary.uncertain');
  assert.equal(f.store.getSessionDocument('session', 'context.memory'), null); assert.equal(f.store.getLatestContextRevision('session'), null);
});

test('a terminal Run still settles its owned interrupted summary after confirmed provider cleanup', async t => {
  const f = fixture(t); let id: string | undefined;
  const cancelledOwner: ProviderAdapter = { id: 'fixture', async *streamTurn(request) {
    id = request.attemptId; yield { type: 'text.delta', delta: 'Already observed before owner cancellation' };
    yield { type: 'usage', outputTokens: 3 };
    f.store.commit(f.currentRunId, 'run.cancelling', {}, { run: { state: 'cancelling' } });
    f.store.commit(f.currentRunId, 'run.cancelled', {}, { run: { state: 'cancelled' } });
    throw new EngineError('ENGINE_CLOSED', 'Fixture owner stopped');
  } };
  await assert.rejects(f.memory.summarize(f.request, cancelledOwner), (error: unknown) => error instanceof EngineError && error.code === 'ENGINE_CLOSED');
  assert.ok(id); const attempt = f.store.getSummaryAttempt(id);
  assert.equal(attempt.state, 'interrupted'); assert.equal(attempt.cleanupConfirmed, true); assert.equal(attempt.publication, 'discarded');
  assert.equal(attempt.partialText, 'Already observed before owner cancellation');
  assert.equal(f.store.getRun(f.currentRunId).state, 'cancelled'); assert.equal(f.store.getSummaryUsage(id)?.usage.outputTokens, 3);
  assert.equal(f.store.getSessionDocument('session', 'context.memory'), null);
});

test('empty, truncated, tool-producing and cancelled summaries preserve the previous active checkpoint', async t => {
  const f = fixture(t);
  const successful = await f.memory.summarize(f.request, provider([{ type: 'text.delta', delta: 'Previous valid memory.' }, { type: 'finish', reason: 'stop' }]));
  f.store.commit(f.currentRunId, 'run.completed', {}, { run: { state: 'completed' } });
  const later = f.store.admit({ sessionId: 'session', requestId: 'later', prompt: 'Continue after the checkpoint', config });
  f.store.commit(later.runId, 'run.started', {}, { run: { state: 'running' } });
  f.request.run = f.store.getRun(later.runId);
  f.request.snapshot = f.store.getSnapshot('session');
  // A fresh budget tests failed attempts independently of the bounded two-call allowance.
  for (const events of [[], [{ type: 'finish', reason: 'length' }], [{ type: 'tool.call', call: { id: 'forbidden', name: 'run_command', input: {} } }]] as ProviderEvent[][]) {
    await assert.rejects(f.memory.summarize({ ...f.request, snapshot: f.store.getSnapshot('session'), budget: new BudgetAccount(config) }, provider(events)));
    assert.equal(f.memory.active('session')!.checkpoint.id, successful.id);
  }
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.memory.summarize({ ...f.request, signal: aborted.signal }, provider([])));
  assert.equal(f.memory.active('session')!.checkpoint.id, successful.id);
});

test('context revisions bind the same selected input and remain stable until a source changes', async t => {
  const f = fixture(t), service = new ContextService(f.store);
  const request = { ...f.request, snapshot: service.snapshot('session', config) };
  const first = await service.build(request);
  const id = service.revisionId('session');
  assert.deepEqual(await service.build(request), first);
  assert.equal(service.revisionId('session'), id);
  assert.equal(service.diagnostics('session')!.plan.tokenLimit, null);
  const nextConfig = { ...config, mode: 'build' as const };
  await service.build({ ...request, config: nextConfig });
  assert.notEqual(service.revisionId('session'), id);
});
