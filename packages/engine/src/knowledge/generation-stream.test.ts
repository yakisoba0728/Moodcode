import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import type { HostGenerationProviderPort, HostGenerationRequest } from '../provider/generation.js';
import { ScriptedProvider } from '../provider/scripted.js';
import { normalizeKnowledgeGenerationBudget } from './generation-budget.js';
import type { KnowledgeGenerationBudget, KnowledgeGenerationObservation, KnowledgeGenerationSettlement } from './generation-types.js';
import { streamKnowledgeGeneration, type KnowledgeGenerationStreamOptions } from './generation-stream.js';

const request: HostGenerationRequest = { owner: { kind: 'host-generation', workspaceId: 'fixture-workspace', generationId: 'fixture-generation', attemptId: 'fixture-attempt' }, modelId: 'fixture-model', messages: [{ role: 'system', content: 'Tools-free extraction.' }, { role: 'user', content: '{"sourceBody":"quoted evidence"}' }], tools: [], includeMetadata: true };
const budgets = (value: Partial<KnowledgeGenerationBudget> = {}) => normalizeKnowledgeGenerationBudget({ maxDurationMs: 2_000, providerRequestTimeoutMs: 1_000, inactivityTimeoutMs: 500, cleanupTimeoutMs: 25, ...value });
const text = (delta = 'Supported project knowledge.') => ({ type: 'text.delta', delta });
const finish = { type: 'finish', reason: 'stop' };
const code = (value: string) => (error: unknown) => error instanceof EngineError && error.code === value;
function fixture(events: unknown[] = [text(), finish], behavior: { neverDone?: boolean; nextError?: unknown; close?: 'missing' | 'reject' | 'hang' | 'not-done'; returnValue?: unknown } = {}) {
  const counters = { entered: 0, next: 0, returned: 0, dispatch: 0, settlements: 0 }, order: string[] = [], observations: KnowledgeGenerationObservation[] = [], settlements: KnowledgeGenerationSettlement[] = [], controller = new AbortController();
  let index = 0, signal: AbortSignal | undefined, resolveEntered!: () => void;
  const entered = new Promise<void>(resolve => { resolveEntered = resolve; });
  const iterator = {
    next(): Promise<unknown> { counters.next++; if (index < events.length) return Promise.resolve({ done: false, value: events[index++] }); if (behavior.nextError) return Promise.reject(behavior.nextError); if (behavior.neverDone) return new Promise(() => {}); return Promise.resolve({ done: true }); },
    ...(behavior.close === 'missing' ? {} : { return(): Promise<unknown> { counters.returned++; order.push('return'); if (behavior.close === 'reject') return Promise.reject(new Error('private-close-error')); if (behavior.close === 'hang') return new Promise(() => {}); return Promise.resolve(behavior.returnValue ?? { done: behavior.close !== 'not-done' }); } }),
  };
  const provider: HostGenerationProviderPort = { streamGeneration(actual, actualSignal) { counters.entered++; order.push('adapter'); assert.ok(Object.isFrozen(actual) && Object.isFrozen(actual.owner)); signal = actualSignal; resolveEntered(); return { [Symbol.asyncIterator]: () => iterator } as never; } };
  const options: KnowledgeGenerationStreamOptions = { provider, request, signal: controller.signal, budget: budgets(), deadline: Date.now() + 2_000, onDispatch() { counters.dispatch++; order.push('dispatch'); }, onObservation(value) { observations.push(value); order.push(value.finishReason ? 'finish' : value.streamDone ? 'done' : 'observe'); }, onSettlement(value) { counters.settlements++; settlements.push(value); order.push('settlement'); } };
  return { provider, counters, order, observations, settlements, controller, options, iterator, entered, get signal() { return signal; } };
}

test('actual ScriptedProvider generation lane is tools-free and independent of all coding calls', async () => {
  const provider = new ScriptedProvider([{ events: [{ type: 'text.delta', delta: 'coding lane must remain unused' }] }], [{ events: [text(), finish] as never }]), f = fixture();
  const result = await streamKnowledgeGeneration({ ...f.options, provider }); assert.equal(result.state, 'completed'); assert.equal(provider.generationCallCount, 1); assert.equal(provider.callCount, 0); assert.equal(result.cleanup.method, 'iterator-complete'); assert.equal(result.streamDone, true); assert.equal(result.text, 'Supported project knowledge.');
});

test('durable dispatch precedes exactly one adapter call, finish and actual done observations precede one settlement', async () => {
  const f = fixture([text('한글 😀'), finish]); const result = await streamKnowledgeGeneration(f.options);
  assert.equal(result.state, 'completed'); assert.deepEqual(f.order, ['dispatch', 'adapter', 'observe', 'finish', 'done', 'settlement']); assert.deepEqual(f.counters, { entered: 1, next: 3, returned: 0, dispatch: 1, settlements: 1 });
  assert.equal(result.observedTextBytes, Buffer.byteLength('한글 😀')); assert.equal(result.retainedBytes, result.observedTextBytes); assert.equal(result.events, 2); assert.deepEqual(f.observations.map(value => value.eventCount), [1, 2, 2]); assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.cleanup) && Object.isFrozen(f.observations[0]));
});

test('actual oversized UTF-8 text is charged before bounded codepoint-safe retention and candidate withholding', async () => {
  const f = fixture([text('😀가나다')]); const result = await streamKnowledgeGeneration({ ...f.options, budget: budgets({ maxOutputBytes: 5 }) });
  assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'KNOWLEDGE_OUTPUT_LIMIT'); assert.equal(result.observedTextBytes, 13); assert.equal(result.retainedBytes, 4); assert.equal(result.text, '😀'); assert.equal(result.outputTruncated, true); assert.equal(f.observations[0]!.textBytes, 13); assert.equal(f.observations[0]!.textDelta, '😀'); assert.equal(f.observations[0]!.outputTruncated, true); assert.equal(f.counters.returned, 1); assert.equal(result.candidate?.state, 'withheld');
});

test('reasoning is charged and discarded; partial public text survives reasoning overflow without becoming completed', async () => {
  const f = fixture([text('public'), { type: 'reasoning.delta', delta: 'private chain must not be persisted' }]); const result = await streamKnowledgeGeneration({ ...f.options, budget: budgets({ maxObservationBytes: 8 }) });
  assert.equal(result.errorCode, 'KNOWLEDGE_OBSERVATION_LIMIT'); assert.equal(result.text, 'public'); assert.equal(result.observationBytes, Buffer.byteLength('private chain must not be persisted')); assert.equal(JSON.stringify(f.observations).includes('private chain'), false); assert.equal(result.state, 'failed');
});

test('usage preserves unknown/null counters and requires monotonic totals and bounded subsets', async () => {
  const f = fixture([{ type: 'usage', inputTokens: null, outputTokens: null }, { type: 'usage', cachedInputTokens: 3 }, text(), { type: 'usage', inputTokens: 10, outputTokens: 7, reasoningOutputTokens: 2 }, finish, { type: 'usage', inputTokens: null, outputTokens: 9, reasoningOutputTokens: 3 }]);
  const result = await streamKnowledgeGeneration(f.options); assert.equal(result.state, 'completed'); assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 9, cachedInputTokens: 3, reasoningTokens: 3 }); assert.equal(f.observations[0]!.usage!.inputTokens, null);
});
for (const [name, usageEvents] of [
  ['regression', [{ type: 'usage', inputTokens: 8 }, { type: 'usage', inputTokens: 7 }]],
  ['cached subset', [{ type: 'usage', inputTokens: 1, cachedInputTokens: 2 }]],
  ['reasoning subset', [{ type: 'usage', outputTokens: 1, reasoningOutputTokens: 2 }]],
  ['unsafe integer', [{ type: 'usage', outputTokens: Number.MAX_SAFE_INTEGER + 1 }]],
  ['explicit undefined', [{ type: 'usage', outputTokens: undefined }]],
] as const) test(`invalid ${name} usage never supplies generation evidence`, async () => {
  const f = fixture([text(), ...usageEvents, finish]); const result = await streamKnowledgeGeneration(f.options); assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'KNOWLEDGE_USAGE_INVALID'); assert.equal(result.candidate?.state, 'withheld'); assert.equal(f.counters.returned, 1);
});

test('bounded stable provider progress ID is recorded and opaque finish replay is discarded', async () => {
  const f = fixture([{ type: 'progress', providerRequestId: 'request-1' }, text(), { ...finish, replayItems: [{ privateCredential: 'opaque-never-store', nested: [1, true] }] }]); const result = await streamKnowledgeGeneration(f.options);
  assert.equal(result.state, 'completed'); assert.equal(result.providerRequestId, 'request-1'); assert.ok(result.observationBytes > 0); assert.equal(JSON.stringify(f.observations).includes('opaque-never-store'), false); assert.equal(JSON.stringify(result).includes('privateCredential'), false);
});
for (const id of ['changed', 'x'.repeat(257), 'bad\nidentity']) test(`progress identity ${id.length > 20 ? 'overflow/control' : 'change'} rejects without changing first recorded owner`, async () => {
  const f = fixture([{ type: 'progress', providerRequestId: 'original' }, { type: 'progress', providerRequestId: id }]); const result = await streamKnowledgeGeneration(f.options); assert.equal(result.state, 'failed'); assert.equal(result.providerRequestId, 'original'); assert.equal(result.errorCode, 'KNOWLEDGE_GENERATION_PROTOCOL');
});

for (const event of [{ type: 'tool.call', call: { name: 'shell', input: { command: 'must-not-run' } } }, { type: 'media', mime: 'image/png', artifact: {} }, { type: 'finish', reason: 'length' }, { type: 'finish', reason: 'tool_calls' }]) test(`unsolicited ${event.type}/${'reason' in event ? event.reason : 'executable'} output is withheld`, async () => {
  const f = fixture([text('partial'), event]); const result = await streamKnowledgeGeneration(f.options); assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'PROVIDER_UNSUPPORTED_OUTPUT'); assert.equal(result.text, 'partial'); assert.equal(f.counters.returned, 1); assert.equal(f.counters.entered, 1);
});

test('event ceiling charges the actual overflow event and synthetic iterator done does not increase count', async () => {
  const f = fixture([text('a'), text('b'), finish]); const result = await streamKnowledgeGeneration({ ...f.options, budget: budgets({ maxEvents: 2 }) }); assert.equal(result.events, 3); assert.equal(f.observations.at(-1)!.eventCount, 3); assert.equal(result.errorCode, 'KNOWLEDGE_EVENT_LIMIT'); assert.equal(result.text, 'ab');
});

for (const events of [[text()], [finish], [text(), finish, finish], [text(), finish, text('late')]]) test('missing, empty, repeated or late content finish cannot certify a candidate', async () => {
  const f = fixture(events), result = await streamKnowledgeGeneration(f.options); assert.equal(result.state, 'failed'); assert.equal(result.candidate?.state, 'withheld'); assert.equal(result.cleanup.confirmed, true);
});

test('finish alone never proves cleanup: hanging next is cancelled and actual underlying return is forwarded', async () => {
  const f = fixture([text(), finish], { neverDone: true }); const result = await streamKnowledgeGeneration({ ...f.options, budget: budgets({ inactivityTimeoutMs: 20 }) });
  assert.equal(result.finishReason, 'stop'); assert.equal(result.streamDone, false); assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'KNOWLEDGE_INACTIVITY_TIMEOUT'); assert.equal(result.cleanup.method, 'iterator-return'); assert.equal(result.cleanup.confirmed, true); assert.equal(f.counters.returned, 1); assert.equal(f.signal?.aborted, true); assert.equal(f.observations.some(value => value.streamDone), false);
});

for (const close of ['missing', 'reject', 'hang', 'not-done'] as const) test(`cancelled actual ${close} return remains uncertain, bounded, and settled once`, async () => {
  const f = fixture([text('partial')], { neverDone: true, close }); const started = Date.now(), operation = streamKnowledgeGeneration(f.options); await f.entered; f.controller.abort(new Error('private user reason')); const result = await operation;
  assert.equal(result.state, 'uncertain'); assert.equal(result.cleanup.confirmed, false); assert.equal(f.counters.settlements, 1); assert.equal(f.counters.returned, close === 'missing' ? 0 : 1); assert.ok(Date.now() - started < 500); assert.equal(JSON.stringify(result).includes('private user reason'), false);
});

test('caller cancellation with real done return settles cancelled, preserving only observed partial output', async () => {
  const f = fixture([text('partial')], { neverDone: true }); const operation = streamKnowledgeGeneration(f.options);
  await f.entered; await new Promise(resolve => setImmediate(resolve)); f.controller.abort(); const result = await operation;
  assert.equal(result.state, 'cancelled'); assert.equal(result.text, 'partial'); assert.equal(result.cleanup.confirmed, true); assert.equal(f.counters.entered, 1); assert.equal(f.counters.returned, 1);
});

test('late unresolved next completion after timeout has no callback or candidate authority', async () => {
  const f = fixture([], { neverDone: true }); let resolveNext!: (value: unknown) => void; f.iterator.next = () => new Promise(resolve => { resolveNext = resolve; });
  const result = await streamKnowledgeGeneration({ ...f.options, budget: budgets({ inactivityTimeoutMs: 15 }) }), observations = f.observations.length, settlements = f.settlements.length;
  resolveNext({ done: false, value: text('late cannot publish') }); await new Promise(resolve => setImmediate(resolve)); assert.equal(result.state, 'failed'); assert.equal(f.observations.length, observations); assert.equal(f.settlements.length, settlements); assert.equal(result.text, '');
});

test('original request deadline and cleanup ceiling cannot be reset by progress observations', async () => {
  const f = fixture([], { neverDone: true, close: 'hang' });
  f.iterator.next = async () => { await new Promise(resolve => setTimeout(resolve, 7)); return { done: false, value: { type: 'progress', providerRequestId: 'fixed' } }; };
  // Isolate the original request boundary: a shorter inactivity window can legitimately
  // expire first when the event loop delays the fixture's progress events under load.
  const started = Date.now(); const result = await streamKnowledgeGeneration({ ...f.options, deadline: started + 35, budget: budgets({ providerRequestTimeoutMs: 25, inactivityTimeoutMs: 25, cleanupTimeoutMs: 25 }) });
  assert.equal(result.state, 'uncertain'); assert.equal(result.errorCode, 'KNOWLEDGE_REQUEST_TIMEOUT'); assert.ok(Date.now() - started < 120); assert.equal(f.counters.entered, 1);
});

for (const scenario of [
  { name: 'equal request/inactivity deadline', requestMs: 25, inactivityMs: 25, dispatchElapsed: 0, expected: 'KNOWLEDGE_REQUEST_TIMEOUT' },
  { name: 'inactivity clipped by remaining original request', requestMs: 100, inactivityMs: 25, dispatchElapsed: 80, expected: 'KNOWLEDGE_REQUEST_TIMEOUT' },
  { name: 'genuinely shorter inactivity deadline', requestMs: 100, inactivityMs: 25, dispatchElapsed: 0, expected: 'KNOWLEDGE_INACTIVITY_TIMEOUT' },
]) test(`actual pending producer ${scenario.name} preserves its correct timeout classification`, async t => {
  const start = Date.now(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const timers = t.mock.method(globalThis, 'setTimeout'), f = fixture([], { neverDone: true });
  const operation = streamKnowledgeGeneration({ ...f.options, budget: budgets({ providerRequestTimeoutMs: scenario.requestMs, inactivityTimeoutMs: scenario.inactivityMs }),
    onDispatch() { f.options.onDispatch(); t.mock.timers.setTime(start + scenario.dispatchElapsed); } });
  await f.entered;
  const remaining = scenario.requestMs - scenario.dispatchElapsed, inactivity = timers.mock.calls[1]!.arguments;
  assert.equal(inactivity[1], Math.min(remaining, scenario.inactivityMs));
  t.mock.timers.setTime(start + scenario.dispatchElapsed + Math.min(remaining, scenario.inactivityMs));
  // Execute the real scheduled callback first to cover either timer callback winning a tie.
  (inactivity[0] as () => void)();
  const result = await operation;
  assert.equal(result.errorCode, scenario.expected); assert.equal(result.state, 'failed'); assert.equal(result.cleanup.confirmed, true);
  assert.equal((f.signal!.reason as EngineError).code, scenario.expected); assert.equal(f.counters.next, 1); assert.equal(f.counters.returned, 1);
  assert.equal(f.counters.settlements, 1); assert.equal(result.candidate?.state, 'withheld'); assert.equal(result.events, 0);
});

test('late request/inactivity timer callbacks cannot reclassify an already observed caller cancellation', async t => {
  const start = Date.now(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const timers = t.mock.method(globalThis, 'setTimeout'), f = fixture([], { neverDone: true });
  const operation = streamKnowledgeGeneration({ ...f.options, budget: budgets({ providerRequestTimeoutMs: 25, inactivityTimeoutMs: 25 }) });
  await f.entered; f.controller.abort();
  t.mock.timers.setTime(start + 25);
  // Until's abort rejection has not resumed the async owner yet; both queued callbacks
  // can still run before its finally clears timers. The first owned reason must survive.
  for (const timer of timers.mock.calls.slice(0, 2)) (timer.arguments[0] as () => void)();
  const result = await operation;
  assert.equal(result.state, 'cancelled'); assert.equal(result.errorCode, 'KNOWLEDGE_GENERATION_CANCELLED');
  assert.equal((f.signal!.reason as EngineError).code, 'KNOWLEDGE_GENERATION_CANCELLED');
  assert.equal(result.cleanup.confirmed, true); assert.equal(f.counters.returned, 1); assert.equal(f.counters.settlements, 1); assert.equal(result.events, 0);
});

test('adapter-owned transport cleanup uncertainty survives a later closed iterator return', async () => {
  const f = fixture([text('partial')], { nextError: new EngineError('CLEANUP_UNCERTAIN', 'private transport body cancellation'), returnValue: { done: true } }); const result = await streamKnowledgeGeneration(f.options);
  assert.equal(result.state, 'uncertain'); assert.equal(result.cleanup.reason, 'adapter_cleanup_uncertain'); assert.equal(result.cleanup.confirmed, false); assert.equal(f.counters.returned, 1);
});

test('getter/proxy protocol events and result records are rejected without getter or trap effects', async () => {
  let effects = 0; const getter = { type: 'text.delta' }; Object.defineProperty(getter, 'delta', { enumerable: true, get() { effects++; return 'must-not-read'; } });
  const proxy = new Proxy({ type: 'finish', reason: 'stop' }, { ownKeys() { effects++; return []; } }), replay = { ...finish, replayItems: [{ get privateData() { effects++; return 'must-not-read'; } }] };
  for (const event of [getter, proxy, replay]) { const f = fixture([text('partial'), event]), result = await streamKnowledgeGeneration(f.options); assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'KNOWLEDGE_GENERATION_PROTOCOL'); }
  const f = fixture(); f.iterator.next = () => Promise.resolve(Object.defineProperty({}, 'done', { enumerable: true, get() { effects++; return true; } })); const result = await streamKnowledgeGeneration(f.options); assert.equal(result.state, 'failed'); assert.equal(effects, 0);
});

test('malformed return.done getters cannot fabricate confirmed cleanup', async () => {
  let effects = 0; const done = Object.defineProperty({}, 'done', { enumerable: true, get() { effects++; return true; } }); const f = fixture([], { neverDone: true, returnValue: done }); const operation = streamKnowledgeGeneration(f.options); await f.entered; f.controller.abort(); const result = await operation;
  assert.equal(result.state, 'uncertain'); assert.equal(result.cleanup.reason, 'iterator_return_malformed'); assert.equal(effects, 0);
});

test('no adapter entry after cancelled admission, expired deadline, invalid request or dispatch failure', async () => {
  const cancelled = fixture(); cancelled.controller.abort(); const a = await streamKnowledgeGeneration(cancelled.options); assert.equal(a.state, 'cancelled'); assert.equal(cancelled.counters.dispatch, 0); assert.equal(cancelled.counters.entered, 0);
  const expired = fixture(), b = await streamKnowledgeGeneration({ ...expired.options, deadline: Date.now() - 1 }); assert.equal(b.state, 'failed'); assert.equal(expired.counters.entered, 0); assert.equal(expired.counters.dispatch, 0);
  const invalid = fixture(); await assert.rejects(streamKnowledgeGeneration({ ...invalid.options, request: { ...request, tools: [{}] } as never }), code('PROVIDER_INVALID_REQUEST')); assert.equal(invalid.counters.dispatch, 0);
  const db = fixture(), c = await streamKnowledgeGeneration({ ...db.options, onDispatch() { throw new Error('private database failure'); } }); assert.equal(c.state, 'failed'); assert.equal(db.counters.entered, 0); assert.equal(db.counters.settlements, 1); assert.equal(c.cleanup.method, 'not-dispatched');
});

test('observation or settlement persistence failures cannot fabricate successful output', async () => {
  const f = fixture(), result = await streamKnowledgeGeneration({ ...f.options, onObservation() { throw new Error('private db error'); } }); assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'KNOWLEDGE_OBSERVATION_FAILED'); assert.equal(f.counters.returned, 1); assert.equal(f.counters.settlements, 1);
  const terminal = fixture(); await assert.rejects(streamKnowledgeGeneration({ ...terminal.options, onSettlement() { throw new Error('commit failed'); } }), code('KNOWLEDGE_SETTLEMENT_FAILED')); assert.equal(terminal.counters.entered, 1);
});

test('one provider failure never triggers a retry or coding lane fallback', async () => {
  const f = fixture([], { nextError: new EngineError('PROVIDER_RATE_LIMITED', 'Retryable-looking failure') }), result = await streamKnowledgeGeneration(f.options); assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'PROVIDER_RATE_LIMITED'); assert.equal(f.counters.entered, 1); assert.equal(f.counters.returned, 1);
});

test('cancellation during durable observation does not invoke producer next again', async () => {
  const f = fixture([text('partial'), finish]), result = await streamKnowledgeGeneration({ ...f.options, onObservation(value) { f.observations.push(value); f.controller.abort(); } });
  assert.equal(result.state, 'cancelled'); assert.equal(f.counters.next, 1); assert.equal(f.counters.returned, 1); assert.equal(f.observations.length, 1); assert.equal(f.counters.settlements, 1);
});

test('expired original deadline after dispatch intent prevents adapter invocation', async () => {
  const f = fixture(), deadline = Date.now() + 8, result = await streamKnowledgeGeneration({ ...f.options, deadline, onDispatch() { f.counters.dispatch++; while (Date.now() <= deadline) { /* synchronous durable host transaction */ } } });
  assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'KNOWLEDGE_REQUEST_TIMEOUT'); assert.equal(f.counters.dispatch, 1); assert.equal(f.counters.entered, 0); assert.equal(f.counters.returned, 0); assert.equal(result.cleanup.confirmed, true);
});

test('deadline crossed by durable observation prevents another producer call', async () => {
  const f = fixture([text('partial'), finish]), deadline = Date.now() + 8, result = await streamKnowledgeGeneration({ ...f.options, deadline, onObservation(value) { f.observations.push(value); while (Date.now() <= deadline) { /* synchronous durable host transaction */ } } });
  assert.equal(result.errorCode, 'KNOWLEDGE_REQUEST_TIMEOUT'); assert.equal(f.counters.next, 1); assert.equal(result.state, 'uncertain'); assert.equal(f.counters.returned, 1); assert.equal(result.cleanup.confirmed, false);
});

test('finished stream whose durable done observation exhausts original deadline is withheld', async () => {
  const f = fixture(), deadline = Date.now() + 8, result = await streamKnowledgeGeneration({ ...f.options, deadline, onObservation(value) { f.observations.push(value); if (value.streamDone) while (Date.now() <= deadline) { /* durable callback cannot renew admission */ } } });
  assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'KNOWLEDGE_GENERATION_DEADLINE'); assert.equal(result.streamDone, true); assert.equal(result.cleanup.confirmed, true); assert.equal(result.candidate?.state, 'withheld');
});

test('protocol-method getters cannot be executed to acquire cleanup or provider entry', async () => {
  let effects = 0; const f = fixture([], { neverDone: true }); Object.defineProperty(f.iterator, 'return', { enumerable: true, get() { effects++; return () => ({ done: true }); } });
  const operation = streamKnowledgeGeneration(f.options); await f.entered; f.controller.abort(); const result = await operation; assert.equal(result.state, 'uncertain'); assert.equal(effects, 0);
  const badProvider = Object.defineProperty({}, 'streamGeneration', { enumerable: true, get() { effects++; return f.provider.streamGeneration; } });
  await assert.rejects(streamKnowledgeGeneration({ ...f.options, provider: badProvider as never }), code('KNOWLEDGE_GENERATION_PROTOCOL')); assert.equal(effects, 0);
});

test('retained candidate text rejects invalid Unicode and NUL while preserving charged bytes', async () => {
  for (const delta of ['bad\ud800', 'bad\0text']) { const f = fixture([text('retained public prefix'), text(delta)]), result = await streamKnowledgeGeneration(f.options); assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'KNOWLEDGE_GENERATION_PROTOCOL'); assert.equal(result.observedTextBytes, Buffer.byteLength('retained public prefix') + Buffer.byteLength(delta)); assert.equal(result.retainedBytes, Buffer.byteLength('retained public prefix')); assert.equal(result.text, 'retained public prefix'); assert.equal(result.outputTruncated, true); assert.equal(f.observations[1]!.textBytes, Buffer.byteLength(delta)); assert.equal(f.observations[1]!.textDelta, ''); assert.equal(f.observations[1]!.outputTruncated, true); assert.equal(result.candidate!.state, 'withheld'); assert.equal(result.cleanup.confirmed, true); assert.equal(f.counters.returned, 1); }
});

test('opaque finish replay is capped without retention or execution of nested protocol accessors', async () => {
  const f = fixture([text('partial'), { ...finish, replayItems: [{ raw: 'secret'.repeat(20_000) }] }]), result = await streamKnowledgeGeneration(f.options); assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'KNOWLEDGE_OBSERVATION_LIMIT'); assert.equal(result.text, 'partial'); assert.equal(JSON.stringify(result).includes('secret'), false); assert.equal(f.counters.returned, 1);
});

test('cleanup timeout includes synchronous underlying return work and cannot renew after entry', async () => {
  const f = fixture([], { neverDone: true }); f.iterator.return = () => { f.counters.returned++; const until = Date.now() + 10; while (Date.now() <= until) { /* trusted adapter synchronous close work */ } return Promise.resolve({ done: true }); };
  const operation = streamKnowledgeGeneration({ ...f.options, budget: budgets({ cleanupTimeoutMs: 5 }) }); await f.entered; f.controller.abort(); const result = await operation; assert.equal(result.state, 'uncertain'); assert.equal(result.cleanup.reason, 'cleanup_deadline'); assert.equal(f.counters.returned, 1);
});
