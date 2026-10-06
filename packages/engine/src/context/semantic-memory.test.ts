import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ENGINE_BUDGETS, DEFAULT_LIMITS, type RunConfig } from '@moodcode/contracts';
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

test('semantic checkpoint uses a tool-free request, exact provenance, inclusive usage and immutable original messages', async t => {
  const f = fixture(t), before = f.store.getSnapshot('session').messages;
  let bytes = 0;
  const checkpoint = await f.memory.summarize({ ...f.request, consumeSummaryOutput: count => { bytes += count; } }, provider([
    { type: 'text.delta', delta: 'Goal retained; fixture verified; continue work.' }, { type: 'usage', inputTokens: 20, outputTokens: 8, cachedInputTokens: 5, reasoningOutputTokens: 2 }, { type: 'finish', reason: 'stop' },
  ], request => { assert.deepEqual(request.tools, []); assert.ok(request.messages[0]!.content.includes('historical')); }));
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
