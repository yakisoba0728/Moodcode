import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError, type MessagePart, type ProviderAttempt, type Run, type TurnRecord } from '@moodcode/contracts';
import { normalizeEngineBudgets } from '@moodcode/contracts/validation';
import { BudgetAccount } from '../config/budgets.js';
import type { EngineStore, ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import type { AttemptCleanupIdentity, AttemptCleanupSettlement } from '../storage/attempt-cleanup.js';
import { TurnExecutor } from './turn-executor.js';

const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
const text: ProviderEvent = { type: 'text.delta', delta: 'A visible observation' };
const stop: ProviderEvent = { type: 'finish', reason: 'stop' };
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of stream) values.push(value); return values; }
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function wait<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
function fixture(options: { recover?: () => Promise<import('../ports.js').ProviderMessage[]>; failSettlement?: boolean; failDispatch?: boolean; failOrdinaryDispatch?: boolean; legacy?: boolean } = {}) {
  const run: Run = { id: 'run', inputId: 'input', sessionId: 'session', workspaceId: 'workspace', requestId: 'request', prompt: 'exact goal', state: 'running',
    config: { providerId: 'fixture', modelId: 'model', mode: 'build', limits: { ...DEFAULT_LIMITS }, budgets: normalizeEngineBudgets({ retryBaseDelayMs: 0 }) },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const turns = new Map<string, TurnRecord>(), attempts = new Map<string, ProviderAttempt>(), parts = new Map<string, MessagePart>();
  const identities: AttemptCleanupIdentity[] = [], dispatches: string[] = [], settlements: { id: string; data: AttemptCleanupSettlement }[] = [], order: string[] = [];
  const records = {
    putTurn(value: TurnRecord) { turns.set(value.id, structuredClone(value)); return value; },
    putAttempt(value: ProviderAttempt) { if (options.failOrdinaryDispatch && value.state === 'dispatched') throw new EngineError('STORAGE_COMMIT_FAILED', 'Injected ordinary dispatch failure'); attempts.set(value.id, structuredClone(value)); order.push(`attempt:${value.state}`); return value; },
    putPart(value: MessagePart) { parts.set(value.id, structuredClone(value)); return value; },
    createAttemptCleanup(value: AttemptCleanupIdentity) { identities.push(structuredClone(value)); order.push('cleanup:prepared'); },
    dispatchAttemptCleanup(id: string) { if (options.failDispatch) throw new EngineError('STORAGE_COMMIT_FAILED', 'Injected dispatch journal failure'); dispatches.push(id); order.push('cleanup:dispatched'); },
    settleAttemptCleanup(id: string, value: AttemptCleanupSettlement) { if (options.failSettlement) throw new EngineError('STORAGE_COMMIT_FAILED', 'Injected cleanup journal failure'); settlements.push({ id, data: structuredClone(value) }); order.push(`cleanup:${value.outcome}`); },
    getSummaryOverflowDependency(summaryAttemptId: string, turnId: string, failedAttemptId: string) {
      assert.equal(turnId, executor.id); assert.equal(attempts.get(failedAttemptId)?.state, 'failed');
      assert.equal(settlements.find(item => item.id === failedAttemptId)?.data.outcome, 'confirmed');
      return { summaryAttemptId, failedAttemptId, cleanupRecordSha256: 'a'.repeat(64) };
    },
  };
  if (options.legacy) for (const key of ['createAttemptCleanup', 'dispatchAttemptCleanup', 'settleAttemptCleanup'] as const) delete (records as Partial<typeof records>)[key];
  const budget = new BudgetAccount(run.config); budget.startTurn();
  const executor = new TurnExecutor({ run, index: 0, inputIds: [run.inputId], budget, store: records as unknown as EngineStore, wait,
    contextRevisionId: 'context-before-dispatch', ...(options.recover ? { recoverContextOverflow: options.recover } : {}) });
  const request: TurnRequest = { runId: run.id, sessionId: run.sessionId, turnIndex: 0, modelId: run.config.modelId,
    messages: [{ role: 'user', content: run.prompt }], tools: [], reasoningEffort: 'high' };
  return { run, budget, executor, records, turns, attempts, parts, identities, dispatches, settlements, order, request, signal: new AbortController() };
}
function provider(iterator: AsyncIterator<ProviderEvent>, onInvoke?: (request: TurnRequest, signal: AbortSignal) => void): ProviderAdapter {
  return { id: 'fixture', streamTurn(request, signal) { onInvoke?.(request, signal); return { [Symbol.asyncIterator]: () => iterator }; } };
}

test('natural next done creates exact owner/context/request evidence before output settlement', async () => {
  const f = fixture(); let delivered!: TurnRequest, returnCalls = 0, step = 0;
  const selected = provider({ async next() { return ++step === 1 ? { done: false, value: stop } : { done: true, value: undefined }; }, async return() { returnCalls++; return { done: true, value: undefined }; } }, request => { delivered = structuredClone(request); f.order.push('provider:invoked'); });
  assert.deepEqual(await collect(f.executor.stream(selected, f.request, f.signal.signal)), [stop]);
  const identity = f.identities[0]!;
  assert.equal(identity.attemptId, f.executor.attemptId); assert.equal(identity.runId, f.run.id); assert.equal(identity.sessionId, f.run.sessionId);
  assert.equal(identity.workspaceId, f.run.workspaceId); assert.equal(identity.turnId, f.executor.id); assert.equal(identity.contextRevisionId, 'context-before-dispatch');
  assert.equal(identity.requestProjection, 'engine-turn-request-v1'); assert.equal(identity.requestBytes, Buffer.byteLength(JSON.stringify(delivered)));
  assert.equal(identity.requestSha256, createHash('sha256').update(JSON.stringify(delivered)).digest('hex')); assert.equal(delivered.includeMetadata, true);
  assert.deepEqual(f.settlements, [{ id: identity.attemptId, data: { outcome: 'confirmed', method: 'iterator-next-done', reason: 'natural-done' } }]);
  assert.equal(returnCalls, 0); assert.ok(f.order.indexOf('cleanup:dispatched') < f.order.indexOf('provider:invoked'));
  f.executor.outputFinished('stop', false); assert.equal(f.turns.get(f.executor.id)?.state, 'completed');
});

test('consumer close at a yielded event aborts and closes the actual inner iterator once', async () => {
  const f = fixture(); let returnCalls = 0, innerSignal!: AbortSignal;
  const iterator = f.executor.stream(provider({ async next() { return { done: false, value: text }; }, async return() { returnCalls++; assert.equal(innerSignal.aborted, true); return { done: true, value: undefined }; } }, (_request, signal) => { innerSignal = signal; }), f.request, f.signal.signal);
  assert.deepEqual((await iterator.next()).value, text); assert.equal(f.settlements.length, 0);
  assert.equal((await iterator.return(undefined)).done, true); assert.equal(returnCalls, 1);
  assert.deepEqual(f.settlements[0]?.data, { outcome: 'confirmed', method: 'iterator-return-done', reason: 'consumer-close' });
  await iterator.return(undefined); assert.equal(returnCalls, 1); assert.equal(f.settlements.length, 1);
  f.executor.fail(new EngineError('OUTPUT_LIMIT', 'Consumer rejected this output'));
  assert.equal(f.attempts.get(f.executor.attemptId!)?.state, 'failed'); assert.equal(f.turns.get(f.executor.id)?.state, 'failed');
});

for (const method of ['return-missing', 'return-rejected', 'return-not-done', 'return-timeout'] as const) test(`consumer close preserves uncertain ${method} and never claims outer closure as cleanup`, async () => {
  const f = fixture(); let returns = 0;
  const inner: AsyncIterator<ProviderEvent> = { async next() { return { done: false, value: text }; } };
  if (method !== 'return-missing') inner.return = async () => { returns++; if (method === 'return-rejected') throw new Error('close rejected'); if (method === 'return-timeout') return new Promise(() => {}); return { done: false, value: text }; };
  const iterator = f.executor.stream(provider(inner), f.request, f.signal.signal); await iterator.next();
  await assert.rejects(iterator.return(undefined), code('CLEANUP_UNCERTAIN'));
  assert.deepEqual(f.settlements[0]?.data, { outcome: 'uncertain', method, reason: 'consumer-close' });
  f.executor.fail(new EngineError('CLEANUP_UNCERTAIN', 'Unconfirmed provider close'));
  assert.equal(f.attempts.get(f.executor.attemptId!)?.state, 'uncertain'); assert.equal(f.turns.get(f.executor.id)?.state, 'uncertain');
  assert.equal(returns, method === 'return-missing' ? 0 : 1); assert.equal(f.identities.length, 1);
});

test('confirmed HTTP cleanup is durably settled before a second attempt can dispatch', async () => {
  const f = fixture(); let invokes = 0, returned = 0;
  const selected: ProviderAdapter = { id: 'fixture', streamTurn() {
    invokes++; f.order.push(`provider:${invokes}`);
    if (invokes === 1) return { [Symbol.asyncIterator]() { return { async next(): Promise<IteratorResult<ProviderEvent>> { throw new EngineError('PROVIDER_HTTP_ERROR', 'Try again', { status: 503 }); }, async return() { returned++; return { done: true, value: undefined }; } }; } };
    assert.equal(f.settlements[0]?.data.outcome, 'confirmed'); assert.equal(f.attempts.get(f.identities[0]!.attemptId)?.state, 'failed');
    return { async *[Symbol.asyncIterator]() { yield stop; } };
  } };
  await collect(f.executor.stream(selected, f.request, f.signal.signal));
  assert.equal(invokes, 2); assert.equal(returned, 1); assert.equal(f.identities.length, 2);
  assert.ok(f.order.indexOf('cleanup:confirmed') < f.order.indexOf('provider:2')); assert.equal(f.settlements[1]?.data.method, 'iterator-next-done');
});

test('cleanup journal failure overrides retry eligibility even when the provider returned done true', async () => {
  const f = fixture({ failSettlement: true }); let invokes = 0, returned = 0;
  const selected = provider({ async next(): Promise<IteratorResult<ProviderEvent>> { throw new EngineError('PROVIDER_HTTP_ERROR', 'Retryable rejection', { status: 503 }); }, async return() { returned++; return { done: true, value: undefined }; } }, () => { invokes++; });
  await assert.rejects(collect(f.executor.stream(selected, f.request, f.signal.signal)), code('CLEANUP_UNCERTAIN'));
  assert.equal(invokes, 1); assert.equal(returned, 1); assert.equal(f.settlements.length, 0);
  f.executor.fail(new EngineError('CLEANUP_UNCERTAIN', 'Durable observation failed')); assert.equal(f.turns.get(f.executor.id)?.state, 'uncertain');
});

test('dispatch journal failure records no-dispatch without calling the provider', async () => {
  const f = fixture({ failDispatch: true }); let invoked = 0;
  await assert.rejects(collect(f.executor.stream(provider({ async next() { return { done: true, value: undefined }; } }, () => { invoked++; }), f.request, f.signal.signal)), code('STORAGE_COMMIT_FAILED'));
  assert.equal(invoked, 0); assert.deepEqual(f.settlements[0]?.data, { outcome: 'not-dispatched', method: 'no-dispatch', reason: 'error', errorCode: 'STORAGE_COMMIT_FAILED' });
  assert.equal(f.attempts.get(f.executor.attemptId!)?.state, 'prepared'); assert.equal(f.attempts.get(f.executor.attemptId!)?.dispatchedAt, undefined);
});

test('ordinary dispatch failure after cleanup intent stays uncertain without falsely recording no-dispatch', async () => {
  const f = fixture({ failOrdinaryDispatch: true }); let invoked = 0;
  await assert.rejects(collect(f.executor.stream(provider({ async next() { return { done: true, value: undefined }; } }, () => { invoked++; }), f.request, f.signal.signal)), code('CLEANUP_UNCERTAIN'));
  assert.equal(invoked, 0); assert.equal(f.dispatches.length, 1); assert.equal(f.attempts.get(f.executor.attemptId!)?.state, 'prepared');
  assert.deepEqual(f.settlements[0]?.data, { outcome: 'uncertain', method: 'iterator-unavailable', reason: 'error', errorCode: 'STORAGE_COMMIT_FAILED' });
  f.executor.fail(new EngineError('CLEANUP_UNCERTAIN', 'The dispatch intent remains unknown'));
  assert.equal(f.attempts.get(f.executor.attemptId!)?.state, 'interrupted'); assert.equal(f.attempts.get(f.executor.attemptId!)?.dispatchedAt, undefined);
  assert.equal(f.turns.get(f.executor.id)?.state, 'uncertain'); assert.equal(f.settlements[0]?.data.outcome, 'uncertain');
});

test('natural provider completion cannot be exposed as success when its durable cleanup write fails', async () => {
  const f = fixture({ failSettlement: true }); let returned = 0;
  await assert.rejects(collect(f.executor.stream(provider({ async next() { return { done: true, value: undefined }; }, async return() { returned++; return { done: true, value: undefined }; } }), f.request, f.signal.signal)), code('CLEANUP_UNCERTAIN'));
  assert.equal(returned, 0); assert.equal(f.settlements.length, 0); assert.notEqual(f.attempts.get(f.executor.attemptId!)?.state, 'completed');
});

test('actual next done retains natural completion proof when cancellation arrives at the same boundary', async () => {
  const f = fixture();
  await collect(f.executor.stream(provider({ async next() { return Object.defineProperty({ value: undefined }, 'done', { get() { f.signal.abort(new EngineError('RUN_CANCELLED', 'Cancellation concurrent with done')); return true; } }) as IteratorReturnResult<undefined>; } }), f.request, f.signal.signal));
  assert.deepEqual(f.settlements[0]?.data, { outcome: 'confirmed', method: 'iterator-next-done', reason: 'natural-done' });
  f.executor.fail(f.signal.signal.reason); assert.equal(f.turns.get(f.executor.id)?.state, 'interrupted');
});

test('provider factory throw after durable dispatch is uncertain without an actual iterator', async () => {
  const f = fixture(); const selected: ProviderAdapter = { id: 'fixture', streamTurn() { throw new EngineError('PROVIDER_HTTP_ERROR', 'Factory threw after invocation', { status: 503 }); } };
  await assert.rejects(collect(f.executor.stream(selected, f.request, f.signal.signal)), code('CLEANUP_UNCERTAIN'));
  assert.equal(f.identities.length, 1); assert.deepEqual(f.settlements[0]?.data, { outcome: 'uncertain', method: 'iterator-unavailable', reason: 'error', errorCode: 'PROVIDER_HTTP_ERROR' });
});

test('cancel while next is pending closes the real provider before terminal failure', async () => {
  const f = fixture(), entered = gate(); let returns = 0;
  const stream = f.executor.stream(provider({ async next() { entered.resolve(); return new Promise(() => {}); }, async return() { returns++; return { done: true, value: undefined }; } }), f.request, f.signal.signal);
  const pending = stream.next(); await entered.promise; f.signal.abort(new EngineError('RUN_CANCELLED', 'Cancelled by host'));
  await assert.rejects(pending, code('RUN_CANCELLED'));
  assert.deepEqual(f.settlements[0]?.data, { outcome: 'confirmed', method: 'iterator-return-done', reason: 'cancel', errorCode: 'RUN_CANCELLED' });
  f.executor.fail(f.signal.signal.reason); assert.equal(returns, 1); assert.equal(f.turns.get(f.executor.id)?.state, 'interrupted');
});

test('request cancellation before dispatch saves a no-dispatch intent without provider or return', async () => {
  const f = fixture(); f.signal.abort(new EngineError('RUN_CANCELLED', 'Already cancelled')); let invoked = 0;
  await assert.rejects(collect(f.executor.stream(provider({ async next() { return { done: true, value: undefined }; } }, () => { invoked++; }), f.request, f.signal.signal)), code('RUN_CANCELLED'));
  assert.equal(invoked, 0); assert.equal(f.dispatches.length, 0);
  assert.deepEqual(f.settlements[0]?.data, { outcome: 'not-dispatched', method: 'no-dispatch', reason: 'cancel', errorCode: 'RUN_CANCELLED' });
});

test('overflow-summary uncertainty preserves failed ordinary attempt and its confirmed cleanup proof', async () => {
  const f = fixture({ recover: async () => { throw new EngineError('CLEANUP_UNCERTAIN', 'Summary cleanup is unknown', { summaryAttemptId: 'summary-uncertain' }); } });
  const failure = new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'Explicit context overflow');
  const selected = provider({ async next(): Promise<IteratorResult<ProviderEvent>> { throw failure; }, async return() { return { done: true, value: undefined }; } });
  await assert.rejects(collect(f.executor.stream(selected, f.request, f.signal.signal)), code('CLEANUP_UNCERTAIN'));
  const ordinary = structuredClone(f.attempts.get(f.executor.attemptId!)!); assert.equal(ordinary.state, 'failed'); assert.equal(f.settlements[0]?.data.outcome, 'confirmed');
  f.executor.fail(new EngineError('CLEANUP_UNCERTAIN', 'Summary remains unresolved'));
  assert.deepEqual(f.attempts.get(f.executor.attemptId!), ordinary); assert.equal(f.turns.get(f.executor.id)?.state, 'uncertain');
  assert.deepEqual(f.turns.get(f.executor.id)?.uncertainty?.summaryDependency, { summaryAttemptId: 'summary-uncertain', failedAttemptId: ordinary.id, cleanupRecordSha256: 'a'.repeat(64) });
  assert.equal(f.turns.get(f.executor.id)?.uncertainty?.kind, 'cleanup'); assert.equal(f.identities.length, 1);
});

test('unknown raw provider cleanup cannot be reclassified as a summary dependency', async () => {
  const f = fixture({ recover: async () => { assert.fail('Unknown ordinary cleanup must not dispatch a summary'); } });
  await assert.rejects(collect(f.executor.stream(provider({ async next(): Promise<IteratorResult<ProviderEvent>> { throw new EngineError('CLEANUP_UNCERTAIN', 'Provider uncertainty', { summaryAttemptId: 'forged-summary' }); } }), f.request, f.signal.signal)), code('CLEANUP_UNCERTAIN'));
  f.executor.fail(new EngineError('CLEANUP_UNCERTAIN', 'Unknown provider cleanup'));
  assert.equal(f.turns.get(f.executor.id)?.uncertainty?.summaryDependency, undefined); assert.equal(f.turns.get(f.executor.id)?.uncertainty?.kind, 'provider_dispatch');
});

test('legacy stores still clean the actual iterator without pretending durable proof exists', async () => {
  const f = fixture({ legacy: true }); let returns = 0;
  const stream = f.executor.stream(provider({ async next() { return { done: false, value: text }; }, async return() { returns++; return { done: true, value: undefined }; } }), f.request, f.signal.signal);
  await stream.next(); await stream.return(undefined); assert.equal(returns, 1); assert.equal(f.identities.length, 0); assert.equal(f.settlements.length, 0);
});

for (const where of ['return', 'done'] as const) test(`iterator ${where} accessor rejection is durably uncertain instead of losing cleanup evidence`, async () => {
  const f = fixture(), inner: AsyncIterator<ProviderEvent> = { async next() { return { done: false, value: text }; } };
  if (where === 'return') Object.defineProperty(inner, 'return', { get() { throw new Error('Return getter failed'); } });
  else inner.return = async () => Object.defineProperty({ value: undefined }, 'done', { get() { throw new Error('Done getter failed'); } }) as IteratorReturnResult<undefined>;
  const stream = f.executor.stream(provider(inner), f.request, f.signal.signal); await stream.next();
  await assert.rejects(stream.return(undefined), code('CLEANUP_UNCERTAIN'));
  assert.deepEqual(f.settlements[0]?.data, { outcome: 'uncertain', method: 'return-rejected', reason: 'consumer-close' });
});

test('failed overflow dependency validation keeps cleanup uncertainty without inventing a waiver', async () => {
  const f = fixture({ recover: async () => { throw new EngineError('CLEANUP_UNCERTAIN', 'Summary is unknown', { summaryAttemptId: 'summary-unverified' }); } });
  f.records.getSummaryOverflowDependency = () => { throw new EngineError('RECORD_SCOPE_MISMATCH', 'Dependency does not match the exact ordinary proof'); };
  const stream = f.executor.stream(provider({ async next(): Promise<IteratorResult<ProviderEvent>> { throw new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'Overflow'); }, async return() { return { done: true, value: undefined }; } }), f.request, f.signal.signal);
  let failure: unknown; try { await collect(stream); } catch (error) { failure = error; }
  assert.ok(code('CLEANUP_UNCERTAIN')(failure)); f.executor.fail(failure);
  assert.equal(f.turns.get(f.executor.id)?.state, 'uncertain'); assert.equal(f.turns.get(f.executor.id)?.uncertainty?.summaryDependency, undefined);
  assert.equal(f.attempts.get(f.executor.attemptId!)?.state, 'failed'); assert.equal(f.settlements[0]?.data.outcome, 'confirmed');
});
