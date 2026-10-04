import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import type { ProviderEvent, TurnRequest } from '../ports.js';
import { ScriptedProvider } from './scripted.js';

function request(turnIndex = 0): TurnRequest {
  return {
    runId: 'test-run', turnIndex, modelId: 'local', tools: [],
    messages: [
      { role: 'user', content: 'first prompt' },
      { role: 'assistant', content: 'previous answer' },
      { role: 'user', content: 'latest prompt' },
      { role: 'tool', content: 'tool output', toolCallId: 'tool-1' },
    ],
  };
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function assertCancelled(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'AbortError');
  assert.equal(error.message, 'Scripted provider request cancelled.');
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(String(error), /SECRET|PRIVATE/);
  return true;
}

test('default provider echoes the last user prompt and finishes', async () => {
  const provider = new ScriptedProvider();
  assert.equal(provider.id, 'scripted');
  assert.equal(provider.callCount, 0);
  const events = provider.streamTurn(request(), new AbortController().signal);
  assert.equal(provider.callCount, 1);
  assert.deepEqual(await collect(events), [
    { type: 'text.delta', delta: 'Received: latest prompt' },
    { type: 'finish', reason: 'stop' },
  ]);
});

test('default echo is brief and preserves complete Unicode code points', async () => {
  const input = request();
  input.messages = [{ role: 'user', content: '🌊'.repeat(161) }];
  const events = await collect(new ScriptedProvider().streamTurn(input, new AbortController().signal));
  assert.deepEqual(events[0], { type: 'text.delta', delta: `Received: ${'🌊'.repeat(160)}…` });
  input.messages = [];
  assert.deepEqual((await collect(new ScriptedProvider().streamTurn(input, new AbortController().signal)))[0], {
    type: 'text.delta', delta: 'Ready for a prompt.',
  });
});

test('request turnIndex selects the script independently from call order', async () => {
  const first: ProviderEvent[] = [{ type: 'text.delta', delta: 'first' }, { type: 'finish', reason: 'stop' }];
  const second: ProviderEvent[] = [
    { type: 'tool.call', call: { id: 'call-1', name: 'read_file', input: { path: 'file.txt' } } },
    { type: 'usage', inputTokens: 3, outputTokens: 5 },
    { type: 'finish', reason: 'tool_calls' },
  ];
  const provider = new ScriptedProvider([{ events: first }, { events: second }]);
  const [secondResult, firstResult] = await Promise.all([
    collect(provider.streamTurn(request(1), new AbortController().signal)),
    collect(provider.streamTurn(request(0), new AbortController().signal)),
  ]);
  assert.deepEqual(secondResult, second);
  assert.deepEqual(firstResult, first);
  assert.equal(provider.callCount, 2);
  assert.deepEqual((await collect(provider.streamTurn(request(2), new AbortController().signal)))[0], {
    type: 'text.delta', delta: 'Received: latest prompt',
  });
});

test('fixtures and yielded tool inputs are isolated from later streams', async () => {
  const event: ProviderEvent = { type: 'tool.call', call: { id: 'call-1', name: 'read_file', input: { path: 'file.txt' } } };
  const fixture = [{ events: [event] }];
  const provider = new ScriptedProvider(fixture);
  event.call.name = 'changed';
  fixture[0]!.events.length = 0;
  const result = await collect(provider.streamTurn(request(), new AbortController().signal));
  const yielded = result[0];
  assert.ok(yielded?.type === 'tool.call');
  yielded.call.input = { path: 'changed.txt' };
  assert.deepEqual(await collect(provider.streamTurn(request(), new AbortController().signal)), [
    { type: 'tool.call', call: { id: 'call-1', name: 'read_file', input: { path: 'file.txt' } } },
  ]);
});

test('scripted errors occur after partial events, including an empty error message', async () => {
  const provider = new ScriptedProvider([
    { events: [{ type: 'text.delta', delta: 'partial' }], error: 'fixture failure' },
    { events: [], error: '' },
  ]);
  const received: ProviderEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of provider.streamTurn(request(), new AbortController().signal)) received.push(event);
  }, { name: 'Error', message: 'fixture failure' });
  assert.deepEqual(received, [{ type: 'text.delta', delta: 'partial' }]);
  await assert.rejects(collect(provider.streamTurn(request(1), new AbortController().signal)), { message: '' });
  assert.equal(provider.callCount, 2);
});

test('pre-aborted requests do not emit events or reflect the abort reason', async () => {
  const provider = new ScriptedProvider([{ events: [{ type: 'text.delta', delta: 'late' }], error: 'fixture failure' }]);
  const controller = new AbortController();
  controller.abort(new Error('SECRET PRIVATE key'));
  await assert.rejects(collect(provider.streamTurn(request(), controller.signal)), assertCancelled);
  assert.equal(provider.callCount, 1);
});

test('each event is delayed, delay listeners are cleaned up after success', async () => {
  const provider = new ScriptedProvider([{ events: [
    { type: 'text.delta', delta: 'one' }, { type: 'text.delta', delta: 'two' },
  ], delayMs: 30 }]);
  const controller = new AbortController();
  const iterator = provider.streamTurn(request(), controller.signal)[Symbol.asyncIterator]();
  for (const expected of ['one', 'two']) {
    let settled = false;
    const next = iterator.next().then(value => { settled = true; return value; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    assert.deepEqual(await next, { done: false, value: { type: 'text.delta', delta: expected } });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
  assert.equal((await iterator.next()).done, true);
});

test('cancelling an active long delay promptly rejects and cleans up listeners', async () => {
  const provider = new ScriptedProvider([{ events: [{ type: 'text.delta', delta: 'late' }], delayMs: 60_000 }]);
  const controller = new AbortController();
  const pending = collect(provider.streamTurn(request(), controller.signal));
  const rejected = assert.rejects(pending, assertCancelled);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort({ secret: 'SECRET PRIVATE key' });
  await Promise.race([rejected, wait(250).then(() => assert.fail('Cancellation waited for the long delay.'))]);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancelling between events prevents further events', async () => {
  const provider = new ScriptedProvider([{ events: [
    { type: 'text.delta', delta: 'first' }, { type: 'text.delta', delta: 'late' },
  ] }]);
  const controller = new AbortController();
  const iterator = provider.streamTurn(request(), controller.signal)[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: { type: 'text.delta', delta: 'first' } });
  controller.abort('SECRET PRIVATE reason');
  await assert.rejects(iterator.next(), assertCancelled);
  assert.equal((await iterator.next()).done, true);
});

test('error-only scripts can be cancelled while waiting', async () => {
  const provider = new ScriptedProvider([{ events: [], delayMs: 60_000, error: 'late failure' }]);
  const controller = new AbortController();
  const pending = collect(provider.streamTurn(request(), controller.signal));
  const rejected = assert.rejects(pending, assertCancelled);
  controller.abort('SECRET');
  await rejected;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('an explicit empty script emits no default or extra finish events', async () => {
  assert.deepEqual(await collect(new ScriptedProvider([{ events: [] }]).streamTurn(request(), new AbortController().signal)), []);
});

test('empty successful scripts still apply their configured delay', async () => {
  const controller = new AbortController();
  const pending = collect(new ScriptedProvider([{ events: [], delayMs: 30 }]).streamTurn(request(), controller.signal));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  assert.deepEqual(await pending, []);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('invalid timer durations and turn indexes fail without reflecting input', async () => {
  for (const delayMs of [-1, NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => new ScriptedProvider([{ events: [], delayMs }]), RangeError);
  }
  const provider = new ScriptedProvider();
  for (const turnIndex of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(collect(provider.streamTurn(request(turnIndex), new AbortController().signal)), {
      name: 'RangeError', message: 'Scripted provider turnIndex must be a non-negative safe integer.',
    });
  }
  assert.equal(provider.callCount, 5);
});
