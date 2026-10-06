import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ENGINE_BUDGETS, DEFAULT_LIMITS, EngineError, type RunConfig } from '@moodcode/contracts';
import { BudgetAccount } from '../config/budgets.js';
import type { ContextRequest, ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { streamSummary, type SummaryLifecycleStore } from './summary-stream.js';

const config: RunConfig = { providerId: 'fixture', modelId: 'summary', mode: 'plan', limits: { ...DEFAULT_LIMITS }, budgets: { ...DEFAULT_ENGINE_BUDGETS } };
const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
function fixture() {
  const log: Array<{ type: string; data?: unknown }> = [];
  const controller = new AbortController();
  const request: ContextRequest = { workspace: { id: 'workspace', root: process.cwd(), gitRoot: process.cwd(), branch: null, createdAt: new Date().toISOString() },
    snapshot: { session: { id: 'session', workspaceId: 'workspace', title: 'Summary', createdAt: new Date().toISOString() }, runs: [], messages: [], tools: [], approvals: [], lastSeq: 0 },
    config, budget: new BudgetAccount(config), signal: controller.signal };
  const store = {
    dispatchSummaryAttempt() { log.push({ type: 'dispatch' }); },
    observeSummaryAttempt(_id: string, data: unknown) { log.push({ type: 'observe', data }); },
    markSummaryProviderCompleted() { log.push({ type: 'provider-complete' }); },
    settleSummaryAttempt(_id: string, data: unknown) { log.push({ type: 'settle', data }); },
  } as unknown as SummaryLifecycleStore;
  const turnRequest: TurnRequest = { runId: 'run', modelId: config.modelId, turnIndex: 0, attemptId: 'summary', tools: [], messages: [{ role: 'user', content: 'quoted observations' }] };
  return { log, controller, request, store, turnRequest };
}
function sequence(events: ProviderEvent[]): ProviderAdapter { return { id: 'fixture', async *streamTurn() { yield* events; } }; }

test('finish alone cannot establish provider-complete proof until next done, and partial nullable usage is merged without summing', async () => {
  const f = fixture();
  const result = await streamSummary({ ...f, id: 'summary', maxOutputBytes: 64, provider: sequence([
    { type: 'text.delta', delta: 'fact' }, { type: 'usage', inputTokens: 10, cachedInputTokens: 2 },
    { type: 'usage', inputTokens: null, outputTokens: null } as unknown as ProviderEvent,
    { type: 'finish', reason: 'stop' }, { type: 'usage', outputTokens: 3, reasoningOutputTokens: 1 },
  ]) });
  assert.deepEqual(result, { text: 'fact', usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1 } });
  assert.equal(f.log.at(-1)?.type, 'provider-complete');
  assert.equal(f.log.filter(item => item.type === 'settle').length, 0);
  assert.equal(f.request.budget!.snapshot().logicalTurns, 0);
});

test('a return resolving done false does not prove cleanup, and failure settles once after cleanup', async () => {
  const f = fixture();
  const provider: ProviderAdapter = { id: 'fixture', streamTurn() {
    return { [Symbol.asyncIterator]() {
      return { async next() { return { done: false, value: { type: 'tool.call', call: { id: 'invalid', name: 'tool', input: {} } } as ProviderEvent }; },
        async return() { f.log.push({ type: 'cleanup-not-done' }); return { done: false, value: { type: 'progress' } as ProviderEvent }; } };
    } };
  } };
  await assert.rejects(streamSummary({ ...f, id: 'summary', maxOutputBytes: 64, provider }), hasCode('CLEANUP_UNCERTAIN'));
  assert.deepEqual(f.log.slice(-2).map(item => item.type), ['cleanup-not-done', 'settle']);
  assert.deepEqual(f.log.at(-1)?.data, { state: 'uncertain', errorCode: 'CLEANUP_UNCERTAIN', cleanupConfirmed: false });
});

test('missing return preserves observed partial data and classifies cleanup uncertainty', async () => {
  const f = fixture();
  let index = 0;
  const provider: ProviderAdapter = { id: 'fixture', streamTurn() {
    return { [Symbol.asyncIterator]() { return { async next() {
      if (index++ === 0) return { done: false, value: { type: 'text.delta', delta: 'observed partial fact' } as ProviderEvent };
      throw new EngineError('PROVIDER_TRANSPORT_ERROR', 'stream failed');
    } }; } };
  } };
  await assert.rejects(streamSummary({ ...f, id: 'summary', maxOutputBytes: 64, provider }), hasCode('CLEANUP_UNCERTAIN'));
  assert.ok(f.log.some(item => item.type === 'observe' && (item.data as { textDelta?: string }).textDelta === 'observed partial fact'));
  assert.equal(f.log.filter(item => item.type === 'settle').length, 1);
  assert.equal((f.log.at(-1)!.data as { state: string }).state, 'uncertain');
});

for (const boundary of ['return accessor', 'done accessor'] as const) test(`summary ${boundary} failure settles uncertainty with its exact summary identity`, async () => {
  const f = fixture();
  const provider: ProviderAdapter = { id: 'fixture', streamTurn() { return { [Symbol.asyncIterator]() {
    const iterator: AsyncIterator<ProviderEvent> = { async next() { throw new EngineError('PROVIDER_TRANSPORT_ERROR', 'Synthetic adapter failure'); } };
    if (boundary === 'return accessor') Object.defineProperty(iterator, 'return', { get() { throw new Error('return accessor failed'); } });
    else iterator.return = async () => Object.defineProperty({}, 'done', { get() { throw new Error('done accessor failed'); } }) as IteratorResult<ProviderEvent>;
    return iterator;
  } }; } };
  await assert.rejects(streamSummary({ ...f, id: 'exact-summary', maxOutputBytes: 64, provider }), (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_UNCERTAIN' && error.details?.summaryAttemptId === 'exact-summary');
  assert.deepEqual(f.log.at(-1)?.data, { state: 'uncertain', errorCode: 'CLEANUP_UNCERTAIN', cleanupConfirmed: false });
  assert.equal(f.log.filter(item => item.type === 'settle').length, 1);
  assert.equal(f.log.some(item => item.type === 'provider-complete'), false);
});

test('shared output failure remains fatal while the rejected observed delta is still retained', async () => {
  const f = fixture();
  f.request.consumeSummaryOutput = () => { throw new EngineError('OUTPUT_LIMIT', 'Shared budget exhausted'); };
  await assert.rejects(streamSummary({ ...f, id: 'summary', maxOutputBytes: 1, provider: sequence([{ type: 'text.delta', delta: 'fact' }]) }), hasCode('OUTPUT_LIMIT'));
  assert.ok(f.log.some(item => item.type === 'observe' && (item.data as { textDelta?: string }).textDelta === 'fact'));
  assert.deepEqual(f.log.at(-1)?.data, { state: 'failed', errorCode: 'OUTPUT_LIMIT', cleanupConfirmed: true });
});

test('invalid decreasing usage leaves the prior observation intact and confirmed cancellation records interrupted', async () => {
  const f = fixture();
  await assert.rejects(streamSummary({ ...f, id: 'summary', maxOutputBytes: 64, provider: sequence([{ type: 'usage', inputTokens: 10 }, { type: 'usage', inputTokens: 9 }]) }), hasCode('SUMMARY_PROTOCOL_ERROR'));
  assert.equal(f.log.filter(item => item.type === 'observe').length, 1);
  assert.equal((f.log.find(item => item.type === 'observe')!.data as { usage: { inputTokens: number } }).usage.inputTokens, 10);
  const cancelled = fixture();
  cancelled.controller.abort(new EngineError('CANCELLED', 'test cancellation'));
  await assert.rejects(streamSummary({ ...cancelled, id: 'summary', maxOutputBytes: 64, provider: sequence([]) }), hasCode('CANCELLED'));
  assert.equal(cancelled.log.filter(item => item.type === 'dispatch').length, 0);
  assert.deepEqual(cancelled.log.at(-1)?.data, { state: 'interrupted', errorCode: 'CANCELLED', cleanupConfirmed: true });
});
