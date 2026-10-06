import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import test, { type TestContext } from 'node:test';
import { EngineError, type JsonObject, type ProviderToolCall } from '@moodcode/contracts';
import type { ProviderEvent, TurnRequest } from '../ports.js';
import { AnthropicProvider, ANTHROPIC_PROVIDER_CAPABILITIES, anthropicModelSpec, type AnthropicProviderOptions } from './anthropic.js';

// Synthetic protocol fixtures, not recorded production/account traffic or model capability proof.
const SECRET = 'sk-ant-moodcode-fixture-abcdef123456';
type Wire = Record<string, unknown>;
const request = (): TurnRequest => ({ runId: 'fixture-run', turnIndex: 0, modelId: 'fixture-explicit-model', messages: [{ role: 'user', content: 'fixture request' }], tools: [] });
const start = (usage: Wire = { input_tokens: 7, output_tokens: 1 }): Wire => ({ type: 'message_start', message: { id: 'msg-fixture', type: 'message', role: 'assistant', model: 'fixture-explicit-model', content: [], stop_reason: null, stop_sequence: null, usage } });
const blockStart = (index: number, block: Wire): Wire => ({ type: 'content_block_start', index, content_block: block });
const blockDelta = (index: number, delta: Wire): Wire => ({ type: 'content_block_delta', index, delta });
const blockStop = (index: number): Wire => ({ type: 'content_block_stop', index });
const delta = (reason: string, usage: Wire = { output_tokens: 3 }): Wire => ({ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage });
const stop = (): Wire => ({ type: 'message_stop' });
const textBlocks = (text = 'fixture response', index = 0): Wire[] => [blockStart(index, { type: 'text', text: '' }), blockDelta(index, { type: 'text_delta', text }), blockStop(index)];
const toolBlocks = (args = '{"path":"a.txt"}', index = 0, id = 'toolu-fixture'): Wire[] => [blockStart(index, { type: 'tool_use', id, name: 'read_file', input: {} }), blockDelta(index, { type: 'input_json_delta', partial_json: args }), blockStop(index)];
const thinkingBlocks = (summary = '', signature = 'encrypted-fixture-signature', index = 0): Wire[] => [blockStart(index, { type: 'thinking', thinking: '', signature: '' }), blockDelta(index, { type: 'thinking_delta', thinking: summary }), blockDelta(index, { type: 'signature_delta', signature }), blockStop(index)];
const textStream = (text = 'fixture response'): Wire[] => [start(), ...textBlocks(text), delta('end_turn'), stop()];
const wire = (events: Wire[]): string => events.map(event => `event: ${String(event.type)}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('');
const streamFetch = (events: Wire[]): typeof fetch => async () => new Response(wire(events), { headers: { 'Content-Type': 'text/event-stream' } });
const provider = (events = textStream(), options: AnthropicProviderOptions = {}) => new AnthropicProvider({ apiKey: SECRET, fetch: streamFetch(events), ...options });
async function collect(adapter: AnthropicProvider, input = request(), signal = new AbortController().signal): Promise<ProviderEvent[]> {
  const result: ProviderEvent[] = []; for await (const event of adapter.streamTurn(input, signal)) result.push(event); return result;
}
function noSecret(value: unknown): void {
  const content = value instanceof Error ? `${value.message}\n${value.stack}\n${JSON.stringify(value)}\n${String(value.cause)}` : JSON.stringify(value);
  assert.ok(!content.includes(SECRET));
}
function noEffects(events: readonly ProviderEvent[]): void { assert.ok(events.every(event => event.type !== 'tool.call' && event.type !== 'finish')); }
async function failure(adapter: AnthropicProvider, code: string, input = request(), signal = new AbortController().signal): Promise<{ error: EngineError; events: ProviderEvent[] }> {
  const events: ProviderEvent[] = []; let captured!: EngineError;
  await assert.rejects(async () => { for await (const event of adapter.streamTurn(input, signal)) events.push(event); }, error => {
    assert.ok(error instanceof EngineError); assert.equal(error.code, code); captured = error; noSecret(error); return true;
  });
  noEffects(events); noSecret(events); return { error: captured, events };
}
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
async function body(incoming: IncomingMessage): Promise<Wire> {
  const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Wire;
}
async function local(t: TestContext, handler: (incoming: IncomingMessage) => Promise<Wire[]>): Promise<string> {
  const errors: unknown[] = [];
  const server = createServer((incoming, outgoing) => { void handler(incoming).then(events => { outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' }); outgoing.end(wire(events)); }, error => { errors.push(error); outgoing.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); assert.deepEqual(errors, []); });
  const address = server.address(); assert.ok(address && typeof address === 'object'); return `http://127.0.0.1:${address.port}/v1`;
}

test('stateless local Messages POST converts system/client tools and groups parallel results first', async t => {
  const received: Wire[] = [];
  const baseURL = await local(t, async incoming => { received.push({ path: incoming.url, method: incoming.method, headers: incoming.headers, body: await body(incoming) }); return textStream(); });
  const input = request();
  input.reasoningEffort = 'high';
  input.messages = [{ role: 'system', content: 'system fixture' }, { role: 'system', content: 'second fixture' }, { role: 'user', content: 'inspect' },
    { role: 'assistant', content: 'checking', toolCalls: [{ id: 'old-a', name: 'read_file', input: { path: 'a.txt' } }, { id: 'old-b', name: 'read_file', input: { path: 'b.txt' } }] },
    { role: 'tool', content: 'A', toolCallId: 'old-a' }, { role: 'tool', content: 'B', toolCallId: 'old-b' }, { role: 'user', content: 'continue' }];
  input.tools = [{ name: 'read_file', description: 'Read exact file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
  const adapter = new AnthropicProvider({ baseURL, apiKey: SECRET, maxTokens: 2048 });
  await collect(adapter, input); await collect(adapter, input);
  assert.deepEqual(received.map(item => item.body), Array(2).fill({ model: input.modelId, max_tokens: 2048, stream: true,
    system: [{ type: 'text', text: 'system fixture' }, { type: 'text', text: 'second fixture' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'inspect' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'old-a', name: 'read_file', input: { path: 'a.txt' } }, { type: 'tool_use', id: 'old-b', name: 'read_file', input: { path: 'b.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-a', content: 'A' }, { type: 'tool_result', tool_use_id: 'old-b', content: 'B' }, { type: 'text', text: 'continue' }] }],
    tools: [{ name: 'read_file', description: 'Read exact file', input_schema: input.tools[0]!.inputSchema }], thinking: { type: 'adaptive', display: 'omitted' }, output_config: { effort: 'high' } }));
  const headers = received[0]!.headers as Wire;
  assert.equal(received[0]!.path, '/v1/messages'); assert.equal(received[0]!.method, 'POST'); assert.equal(headers['x-api-key'], SECRET);
  assert.equal(headers['anthropic-version'], '2023-06-01'); assert.equal(headers.authorization, undefined);
});

test('defaults are explicit model/text API with no credential discovery or silent media claims', async () => {
  let url!: string, init!: RequestInit;
  await collect(new AnthropicProvider({ fetch: async (endpoint, options) => { url = String(endpoint); init = options!; return new Response(wire(textStream()), { headers: { 'Content-Type': 'text/event-stream' } }); } }));
  assert.equal(url, 'https://api.anthropic.com/v1/messages'); assert.equal(init.redirect, 'error'); assert.equal(new Headers(init.headers).get('x-api-key'), null);
  assert.equal(JSON.parse(String(init.body)).tools, undefined);
  assert.deepEqual(ANTHROPIC_PROVIDER_CAPABILITIES.inputModalities, ['text']); assert.equal(ANTHROPIC_PROVIDER_CAPABILITIES.media, false);
  const spec = anthropicModelSpec('fixture-explicit-model', { observedAt: '2026-10-07T00:00:00Z' });
  assert.equal(spec.contextWindow, null); assert.equal(spec.maxOutputTokens, null); assert.equal(spec.source.kind, 'host'); assert.deepEqual(spec.modalities, ['text']);
  assert.equal(anthropicModelSpec('fixture', { thinking: 'disabled' }).reasoning, false);
});

test('byte split UTF-8, BOM, CRLF and unknown top-level extensions remain bounded', async () => {
  const bytes = Buffer.from(`\uFEFF: fixture\r\n\r\n${wire([start(), { type: 'ping' }, { type: 'future_metadata', private: SECRET }, ...textBlocks('안녕 🌊 café'), delta('end_turn'), stop()])}`);
  let offset = 0, cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (offset === bytes.length) controller.close(); else controller.enqueue(bytes.subarray(offset, ++offset)); }, cancel() { cancelled++; } });
  const events = await collect(provider([], { fetch: async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }) }));
  assert.equal(events.filter(event => event.type === 'text.delta').map(event => event.delta).join(''), '안녕 🌊 café'); assert.ok(cancelled <= 1); assert.equal(stream.locked, false); noSecret(events);
});

test('usage is cumulative and total input includes cache creation and cache read without double counting', async () => {
  const input = request(); input.includeMetadata = true;
  const events = await collect(provider([start({ input_tokens: 7, cache_creation_input_tokens: 11, cache_read_input_tokens: 13, output_tokens: 1 }), ...textBlocks(),
    { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 2 } }, delta('end_turn', { output_tokens: 3 }), stop()],
    { fetch: async () => new Response(wire([start({ input_tokens: 7, cache_creation_input_tokens: 11, cache_read_input_tokens: 13, output_tokens: 1 }), ...textBlocks(), { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 2 } }, delta('end_turn', { output_tokens: 3 }), stop()]), { headers: { 'Content-Type': 'text/event-stream', 'request-id': 'req-fixture' } }) }), input);
  assert.deepEqual(events.filter(event => event.type === 'usage'), [{ type: 'usage', inputTokens: 31, outputTokens: 3, cachedInputTokens: 13 }]);
  assert.deepEqual(events[0], { type: 'progress', providerRequestId: 'req-fixture' });
  const plain = await collect(provider([start({ input_tokens: 2, cache_read_input_tokens: 5, output_tokens: 1 }), delta('end_turn'), stop()]));
  assert.deepEqual(plain[0], { type: 'usage', inputTokens: 7, outputTokens: 3 });
});

test('public summary alone becomes reasoning events and thinking replay retains encrypted signature unchanged', async () => {
  const adapter = provider([start(), ...thinkingBlocks('I will inspect the current file.'), ...textBlocks('checking', 1), ...toolBlocks('{}', 2), delta('tool_use'), stop()], { publicReasoningSummary: true });
  const events = await collect(adapter);
  assert.deepEqual(events.filter(event => event.type === 'reasoning.delta'), [{ type: 'reasoning.delta', delta: 'I will inspect the current file.' }]);
  const finish = events.find(event => event.type === 'finish'); assert.ok(finish?.type === 'finish');
  assert.deepEqual(finish.replayItems?.[0], { type: 'thinking', thinking: 'I will inspect the current file.', signature: 'encrypted-fixture-signature' });
  assert.ok(events.filter(event => event.type !== 'finish').every(event => !JSON.stringify(event).includes('encrypted-fixture-signature')));
  let encoded!: Wire;
  const continuation = provider(textStream(), { publicReasoningSummary: true, fetch: async (_url, init) => { encoded = JSON.parse(String(init?.body)) as Wire; return new Response(wire(textStream()), { headers: { 'Content-Type': 'text/event-stream' } }); } });
  const input = request(); input.messages.push({ role: 'assistant', content: 'checking', toolCalls: [{ id: 'toolu-fixture', name: 'read_file', input: {} }],
    providerReplay: { providerId: adapter.id, modelId: input.modelId, protocol: adapter.replayProtocol, version: 1, items: finish.replayItems! } }, { role: 'tool', toolCallId: 'toolu-fixture', content: 'file result' });
  await collect(continuation, input);
  assert.deepEqual((encoded.messages as Wire[])[1]!.content, finish.replayItems);
  assert.deepEqual(encoded.thinking, { type: 'adaptive', display: 'summarized' });
});

test('omitted and redacted thinking produce no reasoning/text/tool content from encrypted data', async () => {
  const events = await collect(provider([start(), ...thinkingBlocks(), blockStart(1, { type: 'redacted_thinking', data: 'encrypted-redacted-fixture' }), blockStop(1), ...textBlocks('answer', 2), delta('end_turn'), stop()]));
  assert.equal(events.some(event => event.type === 'reasoning.delta'), false);
  assert.ok(events.filter(event => event.type !== 'finish').every(event => !JSON.stringify(event).includes('encrypted')));
});

test('tool proposals wait for full message stop and every argument validates before exposure', async () => {
  const deliverStop = deferred<void>(), textSeen = deferred<void>();
  let outgoing!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { outgoing = controller; controller.enqueue(Buffer.from(wire([start(), ...toolBlocks('{}'), ...textBlocks('ready', 1), delta('tool_use')]))); } });
  const events: ProviderEvent[] = [];
  const consuming = (async () => { for await (const event of provider([], { fetch: async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }) }).streamTurn(request(), new AbortController().signal)) { events.push(event); if (event.type === 'text.delta') textSeen.resolve(); } })();
  await textSeen.promise; noEffects(events); deliverStop.resolve(); await deliverStop.promise;
  outgoing.enqueue(Buffer.from(wire([stop()]))); outgoing.close(); await consuming;
  assert.deepEqual(events.find(event => event.type === 'tool.call'), { type: 'tool.call', call: { id: 'toolu-fixture', name: 'read_file', input: {} } });
  await failure(provider([start(), ...toolBlocks('{}'), ...toolBlocks('not JSON', 1, 'toolu-second'), delta('tool_use'), stop()]), 'PROVIDER_MALFORMED_STREAM');
});

for (const reason of ['max_tokens', 'model_context_window_exceeded']) test(`${reason} preserves partial text but never releases partial tool arguments or replay`, async () => {
  const events = await collect(provider([start(), ...textBlocks('partial'), ...toolBlocks('{"path":', 1), delta(reason), stop()]));
  assert.ok(events.every(event => event.type !== 'tool.call'));
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'length' });
});

test('length during thinking may finish without a signature and still cannot replay', async () => {
  const events = await collect(provider([start(), blockStart(0, { type: 'thinking', thinking: '', signature: '' }), blockDelta(0, { type: 'thinking_delta', thinking: 'Public partial summary.' }), blockStop(0), delta('max_tokens'), stop()], { publicReasoningSummary: true }));
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'length' });
});

for (const [reason, code] of [['refusal', 'PROVIDER_CONTENT_FILTERED'], ['pause_turn', 'PROVIDER_UNSUPPORTED_FINISH_REASON'], ['future_stop', 'PROVIDER_UNSUPPORTED_FINISH_REASON']] as const) test(`${reason} is not silently treated as a successful stop`, async () => {
  await failure(provider([start(), ...textBlocks(), delta(reason), stop()]), code);
});

test('stop_sequence is a complete text finish', async () => {
  assert.equal((await collect(provider([start(), ...textBlocks(), delta('stop_sequence'), stop()]))).at(-1)?.type, 'finish');
});

for (const [name, events] of [
  ['missing start', [...textBlocks(), delta('end_turn'), stop()]],
  ['duplicate start', [start(), start(), delta('end_turn'), stop()]],
  ['unclosed block', [start(), blockStart(0, { type: 'text', text: '' }), delta('end_turn'), stop()]],
  ['duplicate stop', [start(), ...textBlocks(), blockStop(0), delta('end_turn'), stop()]],
  ['noncontiguous index', [start(), ...textBlocks('a', 1), delta('end_turn'), stop()]],
  ['tool stop without calls', [start(), delta('tool_use'), stop()]],
  ['calls without tool stop', [start(), ...toolBlocks(), delta('end_turn'), stop()]],
  ['duplicate IDs', [start(), ...toolBlocks(), ...toolBlocks('{}', 1), delta('tool_use'), stop()]],
  ['array tool input', [start(), ...toolBlocks('[]'), delta('tool_use'), stop()]],
  ['usage decreases', [start(), delta('end_turn', { output_tokens: 0 }), stop()]],
  ['negative usage', [start({ input_tokens: -1 }), delta('end_turn'), stop()]],
  ['unsafe integer', [start({ input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 1 }), delta('end_turn'), stop()]],
] as [string, Wire[]][]) test(`malformed ${name} fails without effects`, async () => { await failure(provider(events), 'PROVIDER_MALFORMED_STREAM'); });

test('missing terminal stop and unfinished SSE fail without executing validated earlier calls', async () => {
  await failure(provider([start(), ...toolBlocks(), delta('tool_use')]), 'PROVIDER_INCOMPLETE_STREAM');
  await failure(provider([], { fetch: async () => new Response('data: {"type":"message_start"}', { headers: { 'Content-Type': 'text/event-stream' } }) }), 'PROVIDER_INCOMPLETE_STREAM');
});

test('unsupported media/server tools and thinking text without public summary contract fail explicitly', async () => {
  for (const kind of ['image', 'audio', 'server_tool_use', 'compaction', 'fallback']) await failure(provider([start(), blockStart(0, { type: kind }), blockStop(0), delta('end_turn'), stop()]), 'PROVIDER_UNSUPPORTED_OUTPUT');
  await failure(provider([start(), ...thinkingBlocks('unexpected undisplayed text'), delta('end_turn'), stop()]), 'PROVIDER_UNSUPPORTED_OUTPUT');
  await failure(provider([start(), ...thinkingBlocks(), delta('end_turn'), stop()], { thinking: 'disabled' }), 'PROVIDER_UNSUPPORTED_OUTPUT');
});

test('native replay rejects cross-provider/model/protocol, normalized content mismatch and credential-bearing opaque state', async () => {
  const base: JsonObject[] = [{ type: 'text', text: 'stored text' }];
  for (const change of [{ providerId: 'other' }, { modelId: 'other-model' }, { protocol: 'other-protocol' }, { version: 2 },
    { items: [{ type: 'text', text: 'different' }] }, { items: [{ type: 'thinking', thinking: '', signature: SECRET }, ...base] },
    { items: [{ type: 'redacted_thinking', data: SECRET }, ...base] }, { items: [{ type: 'text', text: 'stored text', future: true }] },
    { items: [{ type: 'thinking', thinking: 'not omitted', signature: 'encrypted-signature' }, ...base] }]) {
    const input = request(); const adapter = provider();
    input.messages.push({ role: 'assistant', content: 'stored text', providerReplay: { providerId: adapter.id, modelId: input.modelId, protocol: adapter.replayProtocol, version: 1, items: base, ...change } }, { role: 'user', content: 'continue' });
    await failure(adapter, 'PROVIDER_INVALID_REPLAY', input);
  }
  await failure(provider([start(), ...thinkingBlocks('', SECRET), ...toolBlocks('{}', 1), delta('tool_use'), stop()]), 'PROVIDER_INVALID_REPLAY');
});

test('replay validates normalized tool input and rejects authenticated summary mutation', async () => {
  const adapter = provider(), input = request();
  input.messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'tool-old', name: 'read_file', input: { path: 'actual' } }], providerReplay: {
    providerId: adapter.id, modelId: input.modelId, protocol: adapter.replayProtocol, version: 1, items: [{ type: 'tool_use', id: 'tool-old', name: 'read_file', input: { path: 'other' } }] } }, { role: 'tool', toolCallId: 'tool-old', content: 'result' });
  await failure(adapter, 'PROVIDER_INVALID_REPLAY', input);
  await failure(provider([start(), ...thinkingBlocks(SECRET), delta('end_turn'), stop()], { publicReasoningSummary: true }), 'PROVIDER_INVALID_REPLAY');
});

test('text/tool JSON/request identity redacts explicit secrets across deltas without leaking signatures', async () => {
  const prefix = SECRET.slice(0, 13), suffix = SECRET.slice(13);
  const events = await collect(provider([start(), blockStart(0, { type: 'text', text: '' }), blockDelta(0, { type: 'text_delta', text: `before ${prefix}` }),
    blockDelta(0, { type: 'text_delta', text: `${suffix} after` }), blockStop(0), ...toolBlocks(JSON.stringify({ private: SECRET, [SECRET]: 'hidden' }), 1), delta('tool_use'), stop()]));
  noSecret(events); assert.equal(events.filter(event => event.type === 'text.delta').map(event => event.delta).join(''), 'before [REDACTED] after');
  const call = events.find(event => event.type === 'tool.call'); assert.deepEqual(call?.type === 'tool.call' && call.call.input, { private: '[REDACTED]', '[REDACTED]': 'hidden' });
  await failure(provider([], { fetch: async () => { throw new Error(SECRET); } }), 'PROVIDER_TRANSPORT_ERROR');
});

test('credential boundaries across text blocks keep public text and native replay bound', async () => {
  const events = await collect(provider([start(), ...textBlocks(`before ${SECRET.slice(0, 13)}`), ...textBlocks(`${SECRET.slice(13)} after`, 1), delta('end_turn'), stop()]));
  const content = events.filter(event => event.type === 'text.delta').map(event => event.delta).join('');
  assert.equal(content, 'before [REDACTED] after');
  const finish = events.find(event => event.type === 'finish'); assert.ok(finish?.type === 'finish');
  assert.equal(finish.replayItems!.filter(block => block.type === 'text').map(block => block.text).join(''), content);
  const adapter = provider(), input = request(); input.messages.push({ role: 'assistant', content, providerReplay: { providerId: adapter.id, modelId: input.modelId, protocol: adapter.replayProtocol, version: 1, items: finish.replayItems! } }, { role: 'user', content: 'continue' });
  await collect(adapter, input);
  await failure(provider([start(), ...thinkingBlocks(SECRET.slice(0, 13)), ...thinkingBlocks(SECRET.slice(13), 'second-signature', 1), delta('end_turn'), stop()], { publicReasoningSummary: true }), 'PROVIDER_INVALID_REPLAY');
});

for (const status of [400, 401, 403, 413, 429, 500, 503, 504, 529]) test(`HTTP ${status} keeps only status/retry delay and performs one dispatch`, async () => {
  let calls = 0;
  const { error, events } = await failure(provider([], { fetch: async () => { calls++; return new Response(JSON.stringify({ error: { type: 'fixture_error', message: SECRET } }), { status, headers: { 'Retry-After': '120' } }); } }), 'PROVIDER_HTTP_ERROR');
  assert.equal(calls, 1); assert.deepEqual(events, []); assert.deepEqual(error.details, { status, retryAfterMs: 60_000 });
});

test('only structured context overflow normalizes; 413 and arbitrary invalid_request_error prose stay HTTP errors', async () => {
  await failure(provider([], { fetch: async () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'context_window_exceeded', message: SECRET } }), { status: 400 }) }), 'PROVIDER_CONTEXT_OVERFLOW');
  await failure(provider([], { fetch: async () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: `prompt is too long: ${SECRET}` } }), { status: 400 }) }), 'PROVIDER_HTTP_ERROR');
  await failure(provider([start(), { type: 'error', error: { code: 'context_length_exceeded', message: SECRET } }]), 'PROVIDER_CONTEXT_OVERFLOW');
});

test('stream overload/status normalization retains partial public output and never retries internally', async () => {
  for (const [kind, status] of [['rate_limit_error', 429], ['api_error', 500], ['timeout_error', 504], ['overloaded_error', 529]] as const) {
    const { error } = await failure(provider([{ type: 'error', error: { type: kind, message: SECRET } }]), 'PROVIDER_HTTP_ERROR'); assert.deepEqual(error.details, { status });
  }
  const failed = await failure(provider([start(), ...textBlocks('already public'), { type: 'error', error: { type: 'overloaded_error', message: SECRET } }]), 'PROVIDER_HTTP_ERROR');
  assert.deepEqual(failed.events, [{ type: 'text.delta', delta: 'already public' }]);
  assert.deepEqual(provider().retryableHttpStatuses, [429, 500, 503, 504, 529]);
});

test('bounds frame/response/request/tool JSON/block count and replay before executable effects', async () => {
  await failure(provider(textStream('x'.repeat(1000)), { maxFrameBytes: 512 }), 'PROVIDER_LIMIT_EXCEEDED');
  await failure(provider(textStream(), { maxResponseBytes: 400 }), 'PROVIDER_LIMIT_EXCEEDED');
  await failure(provider(textStream(), { maxRequestBytes: 100 }), 'PROVIDER_LIMIT_EXCEEDED');
  await failure(provider([start(), ...toolBlocks('{"path":"long"}'), delta('tool_use'), stop()], { maxToolArgumentBytes: 5 }), 'PROVIDER_LIMIT_EXCEEDED');
  await failure(provider([start(), ...textBlocks('a'), ...textBlocks('b', 1), delta('end_turn'), stop()], { maxOutputBlocks: 1 }), 'PROVIDER_LIMIT_EXCEEDED');
  await failure(provider([start(), ...thinkingBlocks('', 'long-encrypted-signature'), delta('end_turn'), stop()], { maxReplayBytes: 30 }), 'PROVIDER_INVALID_REPLAY');
  await failure(provider([start(), ...toolBlocks('{}'), ...toolBlocks('{}', 1, 'tool-second'), delta('tool_use'), stop()], { maxToolCalls: 1 }), 'PROVIDER_LIMIT_EXCEEDED');
});

test('invalid final usage is checked before exposing otherwise complete tool proposals', async () => {
  await failure(provider([start({ input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 1, output_tokens: 1 }), ...toolBlocks('{}'), delta('tool_use'), stop()]), 'PROVIDER_MALFORMED_STREAM');
});

test('multiple tool argument fragments and non-streamed initial inputs retain exact JSON values', async () => {
  const events = await collect(provider([start(), blockStart(0, { type: 'tool_use', id: 'tool-fragmented', name: 'read_file', input: {} }),
    blockDelta(0, { type: 'input_json_delta', partial_json: '{"path":' }), blockDelta(0, { type: 'input_json_delta', partial_json: '"한글.txt"}' }), blockStop(0),
    blockStart(1, { type: 'tool_use', id: 'tool-initial', name: 'read_file', input: { path: 'initial.txt' } }), blockStop(1), delta('tool_use'), stop()]));
  assert.deepEqual(events.filter(event => event.type === 'tool.call').map(event => event.call), [{ id: 'tool-fragmented', name: 'read_file', input: { path: '한글.txt' } }, { id: 'tool-initial', name: 'read_file', input: { path: 'initial.txt' } }]);
});

test('caller abort closes a stalled body, removes listeners and suppresses finish', async () => {
  const reading = deferred<void>(); let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull() { reading.resolve(); }, cancel() { cancelled++; } });
  const controller = new AbortController(), before = getEventListeners(controller.signal, 'abort').length;
  const operation = failure(provider([], { fetch: async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }) }), 'PROVIDER_CANCELLED', request(), controller.signal);
  await reading.promise; controller.abort(); await operation;
  assert.equal(cancelled, 1); assert.equal(stream.locked, false); assert.equal(getEventListeners(controller.signal, 'abort').length, before);
});

test('timeout and early iterator return cancel the transport without waiting for remote EOF', async () => {
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(wire([start(), blockStart(0, { type: 'text', text: '' }), blockDelta(0, { type: 'text_delta', text: 'first' })]))); }, cancel() { cancelled++; } });
  const adapter = provider([], { fetch: async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }) });
  const iterator = adapter.streamTurn(request(), new AbortController().signal)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, 'text.delta'); await iterator.return?.(undefined); assert.equal(cancelled, 1); assert.equal(stream.locked, false);
  const stalled = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  await failure(provider([], { fetch: async () => new Response(stalled, { headers: { 'Content-Type': 'text/event-stream' } }), timeoutMs: 20 }), 'PROVIDER_TIMEOUT');
  assert.equal(cancelled, 2);
});

test('non-cooperative cancellation is bounded and reported as cleanup uncertainty', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(wire([start(), blockStart(0, { type: 'text', text: '' }), blockDelta(0, { type: 'text_delta', text: 'observed' })]))); }, cancel() { return new Promise<void>(() => {}); } });
  const controller = new AbortController();
  const adapter = provider([], { fetch: async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }), cleanupTimeoutMs: 20 });
  const events: ProviderEvent[] = [];
  await assert.rejects(async () => { for await (const event of adapter.streamTurn(request(), controller.signal)) { events.push(event); controller.abort(); } }, error => error instanceof EngineError && error.code === 'CLEANUP_UNCERTAIN');
  noEffects(events);
});

test('unconfirmed cleanup after terminal response still withholds tool calls and finish', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(wire([start(), ...toolBlocks('{}'), delta('tool_use'), stop()]))); }, cancel() { return new Promise<void>(() => {}); } });
  await failure(provider([], { fetch: async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }), cleanupTimeoutMs: 20 }), 'CLEANUP_UNCERTAIN');
});

test('non-cooperative fetch abort returns promptly and cancels an eventual late response', async () => {
  const dispatched = deferred<void>(), late = deferred<Response>(), cancelled = deferred<void>();
  const controller = new AbortController();
  const operation = failure(provider([], { fetch: async () => { dispatched.resolve(); return late.promise; } }), 'PROVIDER_CANCELLED', request(), controller.signal);
  await dispatched.promise; controller.abort(); await operation;
  late.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled.resolve(); } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  await cancelled.promise;
});

test('abort before dispatch and invalid host/request configuration never call fetch', async () => {
  let calls = 0; const fetcher: typeof fetch = async () => { calls++; return new Response(); };
  const controller = new AbortController(); controller.abort(); await failure(provider([], { fetch: fetcher }), 'PROVIDER_CANCELLED', request(), controller.signal);
  for (const change of [{ modelId: '' }, { reasoningEffort: 'ultra' }, { messages: [{ role: 'user', content: [{ type: 'image', source: 'private' }] }] },
    { messages: [{ role: 'tool', toolCallId: 'missing', content: 'result' }] }, { messages: [{ role: 'user', content: 'u' }, { role: 'system', content: 'late' }] },
    { messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'read_file', input: {} }] }] }]) {
    await failure(provider([], { fetch: fetcher }), 'PROVIDER_INVALID_REQUEST', { ...request(), ...change } as TurnRequest);
  }
  for (const options of [{ baseURL: 'http://example.invalid/v1' }, { baseURL: 'https://user:secret@example.invalid' }, { baseURL: 'file:///tmp/private' },
    { timeoutMs: 0 }, { maxTokens: 0 }, { apiKey: 'bad\nkey' }, { thinking: 'disabled', publicReasoningSummary: true }]) {
    assert.throws(() => new AnthropicProvider(options as AnthropicProviderOptions), (error: unknown) => error instanceof EngineError && error.code === 'PROVIDER_INVALID_CONFIG');
  }
  assert.equal(calls, 0);
});

test('malformed/deep JSON and non-SSE response cannot bypass schema/cleanup bounds', async () => {
  await failure(provider([], { fetch: async () => new Response('data: invalid\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) }), 'PROVIDER_MALFORMED_STREAM');
  await failure(provider([], { fetch: async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }) }), 'PROVIDER_MALFORMED_STREAM');
  const nested = `${'{"p":'.repeat(66)}0${'}'.repeat(66)}`;
  await failure(provider([start(), ...toolBlocks(nested), delta('tool_use'), stop()]), 'PROVIDER_MALFORMED_STREAM');
  const input = request(); let getters = 0;
  const args = Object.defineProperty({}, 'path', { enumerable: true, get() { getters++; return SECRET; } });
  input.messages = [{ role: 'user', content: 'u' }, { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'read_file', input: args } as ProviderToolCall] }, { role: 'tool', toolCallId: 'call', content: 'result' }];
  await failure(provider(), 'PROVIDER_INVALID_REQUEST', input); assert.equal(getters, 0);
});
