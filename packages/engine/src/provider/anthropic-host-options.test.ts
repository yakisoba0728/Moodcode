import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject } from '@moodcode/contracts';
import type { ProviderEvent, TurnRequest } from '../ports.js';
import { AnthropicProvider, type AnthropicProviderOptions } from './anthropic.js';

const request = (metadata = true): TurnRequest => ({ runId: 'host-options-run', turnIndex: 0,
  modelId: 'fixture-model', messages: [{ role: 'user', content: 'Fixture request' }], tools: [], includeMetadata: metadata });
function response(usages: JsonObject[] = [{ output_tokens: 12 }]): Response {
  const events = [
    { type: 'message_start', message: { id: 'fixture-message', type: 'message', role: 'assistant', model: 'fixture-model',
      content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fixture response' } },
    { type: 'content_block_stop', index: 0 },
    ...usages.map(usage => ({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage })),
    { type: 'message_stop' },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}
async function collect(adapter: AnthropicProvider, input = request()): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of adapter.streamTurn(input, new AbortController().signal)) events.push(event);
  return events;
}

for (const workspaceId of [undefined, 'wrkspc_Example123', `wrkspc_${'A'.repeat(128)}`]) {
  test(`Anthropic host workspace ${workspaceId === undefined ? 'omitted' : workspaceId.length} preserves transport`, async () => {
    let calls = 0;
    const adapter = new AnthropicProvider({ apiKey: 'fixture-host-key', workspaceId, fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('anthropic-workspace-id'), workspaceId ?? null);
      assert.equal(headers.get('x-api-key'), 'fixture-host-key');
      assert.equal(headers.get('anthropic-version'), '2023-06-01');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal instanceof AbortSignal);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.workspaceId, undefined);
      assert.deepEqual(body.output_config, { effort: 'high' });
      return response();
    } });
    const events = await collect(adapter, { ...request(), reasoningEffort: 'high' });
    assert.equal(calls, 1);
    assert.equal(events.at(-1)?.type, 'finish');
    assert.ok(!JSON.stringify(events).includes('fixture-host-key'));
    if (workspaceId) assert.ok(!JSON.stringify(events).includes(workspaceId));
  });
}
for (const workspaceId of ['', 'wrkspc_', ' wrkspc_One', 'wrkspc_One\r\nx-api-key: stolen',
  'wrkspc_a_b', 'wrkspc_a-b', 'wrkspc_한글', `wrkspc_${'a'.repeat(129)}`, null, 7]) {
  test(`Anthropic rejects invalid workspace ${JSON.stringify(workspaceId)} before transport`, () => {
    let calls = 0;
    const options = { workspaceId, fetch: async () => { calls++; return response(); } } as unknown as AnthropicProviderOptions;
    assert.throws(() => new AnthropicProvider(options), { code: 'PROVIDER_INVALID_CONFIG' });
    assert.equal(calls, 0);
  });
}

for (const thinking_tokens of [0, 4, 12]) test(`Anthropic reports explicit thinking token count ${thinking_tokens}`, async () => {
  const events = await collect(new AnthropicProvider({ fetch: async () => response([{ output_tokens: 12, output_tokens_details: { thinking_tokens } }]) }));
  assert.deepEqual(events.find(event => event.type === 'usage'), { type: 'usage', inputTokens: 5, outputTokens: 12, reasoningOutputTokens: thinking_tokens });
});
const missingDetails: readonly (JsonObject | null | undefined)[] = [undefined, null, {}, { thinking_tokens: null }, { unrelated: 100 }];
for (const details of missingDetails) {
  test(`Anthropic absent thinking breakdown stays unknown: ${JSON.stringify(details)}`, async () => {
    const events = await collect(new AnthropicProvider({ fetch: async () => response([{ output_tokens: 12,
      ...(details === undefined ? {} : { output_tokens_details: details }) }]) }));
    assert.equal(Object.hasOwn(events.find(event => event.type === 'usage')!, 'reasoningOutputTokens'), false);
  });
}
for (const value of [-1, 1.5, '4', Number.MAX_SAFE_INTEGER + 1, 13]) {
  test(`Anthropic rejects malformed thinking count ${value} without completing`, async () => {
    const events: ProviderEvent[] = [];
    const adapter = new AnthropicProvider({ fetch: async () => response([{ output_tokens: 12, output_tokens_details: { thinking_tokens: value } }]) });
    await assert.rejects(async () => {
      for await (const event of adapter.streamTurn(request(), new AbortController().signal)) events.push(event);
    }, { code: 'PROVIDER_MALFORMED_STREAM' });
    assert.equal(events.some(event => event.type === 'finish' || event.type === 'tool.call' || event.type === 'usage'), false);
  });
}
test('Anthropic thinking breakdown cannot decrease between cumulative usage events', async () => {
  const adapter = new AnthropicProvider({ fetch: async () => response([
    { output_tokens: 8, output_tokens_details: { thinking_tokens: 4 } },
    { output_tokens: 12, output_tokens_details: { thinking_tokens: 3 } },
  ]) });
  await assert.rejects(collect(adapter), { code: 'PROVIDER_MALFORMED_STREAM' });
});
test('Anthropic metadata opt-out excludes optional token breakdowns', async () => {
  const adapter = new AnthropicProvider({ fetch: async () => response([{ output_tokens: 12, output_tokens_details: { thinking_tokens: -1 } }]) });
  const events = await collect(adapter, request(false));
  assert.deepEqual(events.find(event => event.type === 'usage'), { type: 'usage', inputTokens: 5, outputTokens: 12 });
});

test('Anthropic closes the received reader before aborting fetch and suppresses buffered completion', async () => {
  let release!: () => void, closing = false, fetchSignal: AbortSignal | undefined;
  const bytes = new Uint8Array(await response().arrayBuffer());
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); },
    cancel() { closing = true; return new Promise<void>(resolve => { release = resolve; }); } });
  const adapter = new AnthropicProvider({ fetch: async (_url, init) => {
    fetchSignal = init?.signal ?? undefined;
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const abort = new AbortController(), iterator = adapter.streamTurn(request(), abort.signal);
  assert.equal((await iterator.next()).value?.type, 'text.delta');
  abort.abort();
  assert.equal(closing, false);
  const pending = iterator.next();
  const rejected = assert.rejects(pending, { code: 'PROVIDER_CANCELLED' });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closing, true);
  assert.equal(fetchSignal?.aborted, false);
  release();
  await rejected;
  assert.equal(fetchSignal?.aborted, true);
});
