import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setImmediate as nextTick } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import type { ProviderEvent, TurnRequest } from '../ports.js';
import { OpenAICompatibleProvider, type OpenAICompatibleProviderOptions } from './openai-compatible.js';

const SECRET = 'sk-fixture-private-1234567890';
const DONE = 'data: [DONE]\r\n\r\n';
type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

function request(): TurnRequest {
  return {
    runId: 'run-fixture', turnIndex: 0, modelId: 'explicit-fixture-model',
    messages: [{ role: 'user', content: 'fixture prompt' }], tools: [],
  };
}

function chunk(delta: Record<string, unknown> = {}, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\r\n\r\n`;
}

function usage(value: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [], usage: value })}\r\n\r\n`;
}

function tool(index: number, id: string, name: string, args: string): Record<string, unknown> {
  return { index, id, type: 'function', function: { name, arguments: args } };
}

function sse(response: ServerResponse): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
}

async function fixture(t: TestContext, handler: Handler): Promise<{ baseURL: string; requestCount: () => number }> {
  let requests = 0;
  const failures: unknown[] = [];
  const server = createServer((incoming, outgoing) => {
    requests += 1;
    void Promise.resolve().then(() => handler(incoming, outgoing)).catch(error => {
      failures.push(error);
      outgoing.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.deepEqual(failures, [], 'Local HTTP fixture failed.');
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, requestCount: () => requests };
}

async function body(incoming: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  for await (const part of incoming) parts.push(Buffer.from(part));
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>;
}

async function collect(provider: OpenAICompatibleProvider, input = request(), signal = new AbortController().signal): Promise<ProviderEvent[]> {
  const result: ProviderEvent[] = [];
  for await (const event of provider.streamTurn(input, signal)) result.push(event);
  return result;
}

function noSecret(value: unknown): void {
  const rendered = value instanceof Error
    ? `${value.name}\n${value.message}\n${value.stack}\n${JSON.stringify(value)}\n${String(value.cause)}`
    : JSON.stringify(value);
  assert.ok(!rendered.includes(SECRET), 'Public provider output reflected the injected credential.');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function failure(provider: OpenAICompatibleProvider, code: string, input = request(), signal = new AbortController().signal): Promise<{ events: ProviderEvent[]; error: EngineError }> {
  const events: ProviderEvent[] = [];
  let found: EngineError | undefined;
  await assert.rejects(async () => {
    for await (const event of provider.streamTurn(input, signal)) events.push(event);
  }, error => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    noSecret(error);
    found = error;
    return true;
  });
  assert.ok(found);
  noSecret(events);
  assert.ok(events.every(event => event.type !== 'tool.call' && event.type !== 'finish'));
  return { events, error: found };
}

async function deadline<T>(promise: Promise<T>, milliseconds = 1_500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Local HTTP operation did not finish in time.')), milliseconds);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function text(events: ProviderEvent[]): string {
  return events.filter(event => event.type === 'text.delta').map(event => event.delta).join('');
}

test('POST serializes the explicit model, function tools, assistant calls and tool history', async t => {
  let received: { method?: string; url?: string; authorization?: string; accept?: string; body: Record<string, unknown> } | undefined;
  const local = await fixture(t, async (incoming, outgoing) => {
    received = { method: incoming.method, url: incoming.url, authorization: incoming.headers.authorization, accept: incoming.headers.accept, body: await body(incoming) };
    sse(outgoing);
    outgoing.end(chunk({ content: 'result' }) + chunk({}, 'stop') + usage({ prompt_tokens: 7, completion_tokens: 3 }) + DONE);
  });
  const input = request();
  input.messages = [
    { role: 'system', content: 'system instruction' }, { role: 'user', content: 'user instruction' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'old-call', name: 'read_file', input: { path: 'file.txt' } }] },
    { role: 'tool', content: 'old result', toolCallId: 'old-call' },
  ];
  input.tools = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
  const provider = new OpenAICompatibleProvider({ baseURL: `${local.baseURL}/`, apiKey: SECRET, id: 'fixture-provider' });
  const events = await collect(provider, input);
  assert.equal(provider.id, 'fixture-provider');
  assert.deepEqual(received, {
    method: 'POST', url: '/v1/chat/completions', authorization: `Bearer ${SECRET}`, accept: 'text/event-stream',
    body: {
      model: 'explicit-fixture-model', n: 1, stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'system instruction' }, { role: 'user', content: 'user instruction' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"file.txt"}' } }] },
        { role: 'tool', content: 'old result', tool_call_id: 'old-call' },
      ],
      tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: input.tools[0]!.inputSchema } }],
    },
  });
  assert.equal(text(events), 'result');
  assert.deepEqual(events.slice(-2), [{ type: 'usage', inputTokens: 7, outputTokens: 3 }, { type: 'finish', reason: 'stop' }]);
});

test('default endpoint is inspectable with injected fetch and no API key is inferred', async () => {
  let endpoint: string | undefined;
  let options: RequestInit | undefined;
  const transport: typeof fetch = async (url, init) => {
    endpoint = String(url); options = init;
    return new Response(chunk({}, 'stop') + DONE, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const provider = new OpenAICompatibleProvider({ fetch: transport });
  assert.equal(provider.id, 'openai-compatible');
  await collect(provider);
  assert.equal(endpoint, 'https://api.openai.com/v1/chat/completions');
  assert.equal(new Headers(options?.headers).get('authorization'), null);
  assert.equal(options?.redirect, 'error');
});

test('fragmented UTF-8, BOM, comments, CRLF and multiline SSE data survive network boundaries', async t => {
  const local = await fixture(t, async (_incoming, outgoing) => {
    sse(outgoing);
    const first = JSON.stringify({ choices: [{ index: 0, delta: { content: '안녕 🌊 café' }, finish_reason: null }] });
    const newlineAt = first.indexOf('[');
    const wire = Buffer.from(`\uFEFF: keepalive\r\n\r\ndata: ${first.slice(0, newlineAt)}\r\ndata: ${first.slice(newlineAt)}\r\n\r\n${chunk({}, 'stop')}${DONE}`);
    for (let offset = 0; offset < wire.length; offset += 3) {
      outgoing.write(wire.subarray(offset, offset + 3));
      await nextTick();
    }
    outgoing.end();
  });
  const events = await collect(new OpenAICompatibleProvider({ baseURL: local.baseURL }));
  assert.equal(text(events), '안녕 🌊 café');
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' });
});

test('interleaved tool argument indexes yield only complete calls after the DONE marker', async t => {
  const marker = deferred<void>();
  const sendDone = deferred<void>();
  t.after(() => sendDone.resolve());
  const local = await fixture(t, async (_incoming, outgoing) => {
    sse(outgoing);
    outgoing.write(chunk({ content: 'Preparing tools. ', tool_calls: [tool(1, 'call-b', 'read_file', '{"path":'), tool(0, 'call-a', 'search_files', '{"query":"hel')] }));
    outgoing.write(chunk({ tool_calls: [{ index: 0, function: { arguments: 'lo"}' } }, { index: 1, function: { arguments: '"x.ts"}' } }] }));
    outgoing.write(chunk({}, 'tool_calls'));
    marker.resolve();
    await sendDone.promise;
    outgoing.end(usage({ completion_tokens: 6 }) + DONE);
  });
  const events: ProviderEvent[] = [];
  const provider = new OpenAICompatibleProvider({ baseURL: local.baseURL });
  const consuming = (async () => {
    for await (const event of provider.streamTurn(request(), new AbortController().signal)) events.push(event);
  })();
  await deadline(marker.promise);
  await nextTick();
  const noCompletedEventsYet: boolean = events.every(event => event.type !== 'tool.call' && event.type !== 'finish');
  assert.equal(noCompletedEventsYet, true);
  sendDone.resolve();
  await deadline(consuming);
  const calls = events.filter(event => event.type === 'tool.call').map(event => event.call).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(calls, [
    { id: 'call-a', name: 'search_files', input: { query: 'hello' } },
    { id: 'call-b', name: 'read_file', input: { path: 'x.ts' } },
  ]);
  const consumedUsage = events.find(event => event.type === 'usage');
  assert.deepEqual(consumedUsage, { type: 'usage', outputTokens: 6 });
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'tool_calls' });
});

test('missing usage remains missing instead of becoming zero', async t => {
  const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(chunk({}, 'stop') + DONE); });
  const events = await collect(new OpenAICompatibleProvider({ baseURL: local.baseURL }));
  assert.deepEqual(events, [{ type: 'finish', reason: 'stop' }]);
});

test('text secrets split across deltas and complete tool fields are redacted', async t => {
  const input = { nested: ['safe', SECRET], [`key-${SECRET}`]: `value-${SECRET}` };
  const local = await fixture(t, (_incoming, outgoing) => {
    sse(outgoing);
    outgoing.end(
      chunk({ content: `before ${SECRET.slice(0, 8)}` }) +
      chunk({ content: `${SECRET.slice(8)} after ${SECRET}` }) +
      chunk({ tool_calls: [tool(0, `call-${SECRET}`, `function-${SECRET}`, JSON.stringify(input))] }) +
      chunk({}, 'tool_calls') + DONE,
    );
  });
  const events = await collect(new OpenAICompatibleProvider({ baseURL: local.baseURL, apiKey: SECRET }));
  noSecret(events);
  assert.equal(text(events), 'before [REDACTED] after [REDACTED]');
  assert.deepEqual(events.find(event => event.type === 'tool.call'), {
    type: 'tool.call', call: {
      id: 'call-[REDACTED]', name: 'function-[REDACTED]', input: { nested: ['safe', '[REDACTED]'], 'key-[REDACTED]': 'value-[REDACTED]' },
    },
  });
});

const invalidStreams: { name: string; wire: string; code: string }[] = [
  { name: 'invalid JSON', wire: 'data: {invalid}\r\n\r\n' + DONE, code: 'PROVIDER_MALFORMED_STREAM' },
  { name: 'invalid choices shape', wire: 'data: {"choices":"wrong"}\r\n\r\n' + DONE, code: 'PROVIDER_MALFORMED_STREAM' },
  { name: 'finish without DONE', wire: chunk({ tool_calls: [tool(0, 'call-1', 'read_file', '{"path":"a"}')] }) + chunk({}, 'tool_calls'), code: 'PROVIDER_INCOMPLETE_STREAM' },
  { name: 'DONE without finish', wire: chunk({ content: 'partial' }) + DONE, code: 'PROVIDER_INCOMPLETE_STREAM' },
  { name: 'EOF in a frame', wire: chunk({ content: 'partial' }) + 'data: {"choices":', code: 'PROVIDER_INCOMPLETE_STREAM' },
  { name: 'truncated tool JSON', wire: chunk({ tool_calls: [tool(0, 'call-1', 'read_file', '{"path":')] }) + chunk({}, 'tool_calls') + DONE, code: 'PROVIDER_MALFORMED_STREAM' },
  { name: 'second malformed call after a valid call', wire: chunk({ tool_calls: [tool(0, 'call-1', 'read_file', '{"path":"a"}'), tool(1, 'call-2', 'read_file', '{"path":')] }) + chunk({}, 'tool_calls') + DONE, code: 'PROVIDER_MALFORMED_STREAM' },
  { name: 'length with incomplete tool arguments', wire: chunk({ content: 'partial', tool_calls: [tool(0, 'call-1', 'read_file', '{"path":')] }) + chunk({}, 'length') + DONE, code: 'PROVIDER_MALFORMED_STREAM' },
  { name: 'content filter', wire: chunk({}, 'content_filter') + DONE, code: 'PROVIDER_CONTENT_FILTERED' },
  { name: 'unknown finish reason', wire: chunk({}, 'unexpected') + DONE, code: 'PROVIDER_UNSUPPORTED_FINISH_REASON' },
  { name: 'deprecated function call', wire: chunk({ function_call: { name: 'read_file', arguments: '{}' } }, 'function_call') + DONE, code: 'PROVIDER_UNSUPPORTED_FINISH_REASON' },
  { name: 'remote stream error', wire: `data: ${JSON.stringify({ error: { message: SECRET } })}\r\n\r\n${DONE}`, code: 'PROVIDER_REMOTE_ERROR' },
  { name: 'duplicate IDs after redaction', wire: chunk({ tool_calls: [tool(0, `call-${SECRET}`, 'read_file', '{}'), tool(1, 'call-[REDACTED]', 'read_file', '{}')] }) + chunk({}, 'tool_calls') + DONE, code: 'PROVIDER_MALFORMED_STREAM' },
];

for (const invalid of invalidStreams) {
  test(`invalid stream: ${invalid.name} exposes no tool call or finish`, async t => {
    const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(invalid.wire); });
    await failure(new OpenAICompatibleProvider({ baseURL: local.baseURL, apiKey: SECRET }), invalid.code);
  });
}

test('length finish with text and no tool arguments remains a normalized finish', async t => {
  const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(chunk({ content: 'shortened' }) + chunk({}, 'length') + DONE); });
  const events = await collect(new OpenAICompatibleProvider({ baseURL: local.baseURL }));
  assert.equal(text(events), 'shortened');
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'length' });
});

test('HTTP status is preserved while body and status text secrets remain private', async t => {
  const local = await fixture(t, (_incoming, outgoing) => {
    outgoing.writeHead(429, SECRET, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ error: { message: `Bearer ${SECRET}`, secret: SECRET } }));
  });
  const result = await failure(new OpenAICompatibleProvider({ baseURL: local.baseURL, apiKey: SECRET }), 'PROVIDER_HTTP_ERROR');
  assert.deepEqual(result.error.details, { status: 429 });
});

test('JSON responses are rejected instead of treated as nonstream completions', async t => {
  const local = await fixture(t, (_incoming, outgoing) => {
    outgoing.writeHead(200, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ choices: [{ message: { content: SECRET }, finish_reason: 'stop' }] }));
  });
  await failure(new OpenAICompatibleProvider({ baseURL: local.baseURL, apiKey: SECRET }), 'PROVIDER_MALFORMED_STREAM');
});

test('pre-aborted requests do not reach the local server or expose the reason', async t => {
  const local = await fixture(t, (_incoming, outgoing) => { outgoing.end(); });
  const controller = new AbortController();
  controller.abort(new Error(SECRET));
  await failure(new OpenAICompatibleProvider({ baseURL: local.baseURL, apiKey: SECRET }), 'PROVIDER_CANCELLED', request(), controller.signal);
  assert.equal(local.requestCount(), 0);
});

test('cancellation after a delta closes the active HTTP response and removes listeners', async t => {
  const closed = deferred<void>();
  const local = await fixture(t, (_incoming, outgoing) => {
    outgoing.once('close', () => closed.resolve());
    sse(outgoing); outgoing.write(chunk({ content: 'first delta' }));
  });
  const controller = new AbortController();
  const provider = new OpenAICompatibleProvider({ baseURL: local.baseURL, apiKey: SECRET });
  const iterator = provider.streamTurn(request(), controller.signal)[Symbol.asyncIterator]();
  assert.deepEqual(await deadline(iterator.next()), { done: false, value: { type: 'text.delta', delta: 'first delta' } });
  controller.abort(new Error(SECRET));
  await assert.rejects(deadline(iterator.next()), error => {
    assert.ok(error instanceof EngineError); assert.equal(error.code, 'PROVIDER_CANCELLED'); noSecret(error); return true;
  });
  await deadline(closed.promise);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation between content and refusal in one frame suppresses the second delta', async t => {
  const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(chunk({ content: 'first', refusal: 'late' }) + chunk({}, 'stop') + DONE); });
  const controller = new AbortController();
  const events: ProviderEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of new OpenAICompatibleProvider({ baseURL: local.baseURL }).streamTurn(request(), controller.signal)) {
      events.push(event); controller.abort(SECRET);
    }
  }, error => { assert.ok(error instanceof EngineError); assert.equal(error.code, 'PROVIDER_CANCELLED'); noSecret(error); return true; });
  assert.deepEqual(events, [{ type: 'text.delta', delta: 'first' }]);
});

test('timeout interrupts a server stalled after SSE headers and closes its response', async t => {
  const closed = deferred<void>();
  const local = await fixture(t, (_incoming, outgoing) => {
    outgoing.once('close', () => closed.resolve());
    sse(outgoing); outgoing.flushHeaders();
  });
  const controller = new AbortController();
  await deadline(failure(new OpenAICompatibleProvider({ baseURL: local.baseURL, timeoutMs: 40 }), 'PROVIDER_TIMEOUT', request(), controller.signal));
  await deadline(closed.promise);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('consumer return closes a response that has not reached DONE', async t => {
  const closed = deferred<void>();
  const local = await fixture(t, (_incoming, outgoing) => {
    outgoing.once('close', () => closed.resolve());
    sse(outgoing); outgoing.write(chunk({ content: 'first' }));
  });
  const controller = new AbortController();
  const iterator = new OpenAICompatibleProvider({ baseURL: local.baseURL }).streamTurn(request(), controller.signal)[Symbol.asyncIterator]();
  assert.equal((await deadline(iterator.next())).done, false);
  assert.ok(iterator.return);
  await deadline(iterator.return(undefined));
  await deadline(closed.promise);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

const exceeded: { name: string; options: OpenAICompatibleProviderOptions; wire: string }[] = [
  { name: 'frame bytes', options: { maxFrameBytes: 64 }, wire: chunk({ content: '🌊'.repeat(30) }) + chunk({}, 'stop') + DONE },
  { name: 'response bytes across multiple frames', options: { maxResponseBytes: 128 }, wire: ': small comment\r\n\r\n'.repeat(20) + chunk({}, 'stop') + DONE },
  { name: 'aggregate tool argument bytes', options: { maxToolArgumentBytes: 20 }, wire: chunk({ tool_calls: [tool(0, 'call-1', 'read_file', '{"path":"a.txt"}'), tool(1, 'call-2', 'read_file', '{"path":"b.txt"}')] }) + chunk({}, 'tool_calls') + DONE },
  { name: 'tool call count', options: { maxToolCalls: 1 }, wire: chunk({ tool_calls: [tool(0, 'call-1', 'read_file', '{}'), tool(1, 'call-2', 'read_file', '{}')] }) + chunk({}, 'tool_calls') + DONE },
];
for (const limit of exceeded) {
  test(`configured limit: ${limit.name} rejects without terminal or tool events`, async t => {
    const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(limit.wire); });
    await failure(new OpenAICompatibleProvider({ baseURL: local.baseURL, ...limit.options }), 'PROVIDER_LIMIT_EXCEEDED');
  });
}

test('oversized requests fail before reaching the local server', async t => {
  const local = await fixture(t, (_incoming, outgoing) => { outgoing.end(); });
  const input = request(); input.messages = [{ role: 'user', content: 'x'.repeat(1_000) }];
  await failure(new OpenAICompatibleProvider({ baseURL: local.baseURL, maxRequestBytes: 128 }), 'PROVIDER_LIMIT_EXCEEDED', input);
  assert.equal(local.requestCount(), 0);
});

test('injected fetch exception details, cause and message never leak', async () => {
  const transport: typeof fetch = async () => { throw new Error(SECRET, { cause: SECRET }); };
  await failure(new OpenAICompatibleProvider({ fetch: transport, apiKey: SECRET }), 'PROVIDER_TRANSPORT_ERROR');
  const publicCodeTransport: typeof fetch = async () => {
    const error = new EngineError('PROVIDER_MALFORMED_STREAM', SECRET, { secret: SECRET });
    error.cause = new Error(SECRET);
    throw error;
  };
  const result = await failure(new OpenAICompatibleProvider({ fetch: publicCodeTransport, apiKey: SECRET }), 'PROVIDER_MALFORMED_STREAM');
  assert.equal(result.error.details, undefined);
});

test('malformed UTF-8 is rejected and cannot produce a replacement-character completion', async t => {
  const local = await fixture(t, (_incoming, outgoing) => {
    sse(outgoing);
    outgoing.end(Buffer.concat([Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"},"finish_reason":"stop"}]}\r\n\r\n' + DONE)]));
  });
  await failure(new OpenAICompatibleProvider({ baseURL: local.baseURL }), 'PROVIDER_MALFORMED_STREAM');
});
