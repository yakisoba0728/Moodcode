import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setImmediate as nextTick } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import { decodePcmWave } from '../media/segments.js';
import type { ProviderEvent, TurnRequest } from '../ports.js';
import { OpenAICompatibleProvider, type ChatMalformedStreamDiagnostic, type OpenAICompatibleProviderOptions } from './openai-compatible.js';

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

test('malformed audio diagnostics identify exact partial-field branches without exposing remote data', async t => {
  const privateId = 'private-remote-audio-id';
  const privateTranscript = 'private-remote-transcript';
  const privateKey = 'private-remote-key';
  const privateValue = 'private-remote-value';
  const cases = [
    { audio: { id: privateId, transcript: privateTranscript, [privateKey]: privateValue }, stage: 'audio-fields', type: 'missing' },
    { audio: { id: 17, transcript: privateTranscript }, stage: 'audio-id', type: 'missing' },
    { audio: { id: privateId, data: [privateValue] }, stage: 'audio-data', type: 'array' },
    { audio: { id: privateId, data: privateValue }, stage: 'audio-data', type: 'string' },
    { audio: { id: privateId, transcript: { [privateKey]: privateValue } }, stage: 'audio-transcript', type: 'missing' },
    { audio: { id: privateId, expires_at: privateValue }, stage: 'audio-expiry', type: 'missing' },
  ] as const;
  let ordinal = 0;
  const local = await fixture(t, (_incoming, outgoing) => {
    const selected = cases[ordinal++];
    assert.ok(selected);
    sse(outgoing);
    const wire = chunk({ role: 'assistant' }) + chunk({ audio: selected.audio }) + DONE;
    // Actual HTTP fragments do not necessarily align with SSE or JSON fields.
    outgoing.write(wire.slice(0, 19));
    outgoing.write(wire.slice(19, 137));
    outgoing.end(wire.slice(137));
  });
  for (const selected of cases) {
    const diagnostics: ChatMalformedStreamDiagnostic[] = [];
    const provider = new OpenAICompatibleProvider({
      baseURL: local.baseURL, apiKey: SECRET,
      outputAudio: { modelIds: ['explicit-fixture-model'], voice: 'alloy', sampleRate: 8_000, channels: 1 },
      onMalformedStream: diagnostic => diagnostics.push(diagnostic),
    });
    await failure(provider, 'PROVIDER_MALFORMED_STREAM');
    assert.equal(diagnostics.length, 1);
    const diagnostic = diagnostics[0]!;
    assert.ok(Object.isFrozen(diagnostic));
    assert.equal(diagnostic.version, 1);
    assert.equal(diagnostic.frameOrdinal, 2);
    assert.equal(diagnostic.stage, selected.stage);
    assert.equal(diagnostic.choicesType, 'array');
    assert.equal(diagnostic.choicesCount, 1);
    assert.equal(diagnostic.indexIsZero, true);
    assert.equal(diagnostic.audioType, 'object');
    assert.equal(diagnostic.audioDataType, selected.type);
    assert.equal(diagnostic.audioBytesSeen, 0);
    const rendered = JSON.stringify(diagnostic);
    assert.ok(Buffer.byteLength(rendered) < 4_096);
    for (const privateText of [privateId, privateTranscript, privateKey, privateValue, SECRET]) assert.ok(!rendered.includes(privateText));
    assert.ok(Object.values(diagnostic).every(value => value === diagnostic.top || value === diagnostic.precedingFrames || value === null || ['boolean', 'number', 'string'].includes(typeof value)));
    assert.ok(Object.isFrozen(diagnostic.top));
    assert.ok(Object.isFrozen(diagnostic.precedingFrames));
    assert.equal(diagnostic.precedingFrames.length, 1);
  }
  assert.equal(local.requestCount(), cases.length);
});

test('audio expiry-only terminal update remains valid with the diagnostic observer enabled', async t => {
  const diagnostics: ChatMalformedStreamDiagnostic[] = [];
  const pcm = Buffer.from([0, 0, 1, 0]);
  const local = await fixture(t, (_incoming, outgoing) => {
    sse(outgoing);
    outgoing.end(chunk({ audio: { id: 'fixture-audio', data: pcm.toString('base64'), transcript: 'sound' } }) + chunk({}, 'stop')
      + `data: ${JSON.stringify({ choices: [{ index: 0, delta: { audio: { expires_at: 1_893_456_000 } } }] })}\r\n\r\n`
      + usage({ prompt_tokens: 2, completion_tokens: 3 }) + DONE);
  });
  const provider = new OpenAICompatibleProvider({
    baseURL: local.baseURL,
    outputAudio: { modelIds: ['explicit-fixture-model'], voice: 'alloy', sampleRate: 8_000, channels: 1 },
    onMalformedStream: diagnostic => diagnostics.push(diagnostic),
  });
  const events = await collect(provider);
  assert.deepEqual(diagnostics, []);
  assert.equal(events.filter(event => event.type === 'media.delta').length, 1);
  assert.equal(events.filter(event => event.type === 'media.end').length, 1);
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' });
  assert.equal(local.requestCount(), 1);
});

test('diagnostic observer throws cannot replace malformed failure or actual body cancellation', async t => {
  for (const asynchronous of [false, true]) {
    const closed = deferred<void>();
    let observations = 0;
    const local = await fixture(t, (_incoming, outgoing) => {
      outgoing.once('close', () => closed.resolve());
      sse(outgoing);
      outgoing.write(chunk({ audio: { id: 'fixture-audio', data: [] } }));
    });
    const onMalformedStream = asynchronous
      ? async () => { observations += 1; throw new Error(SECRET); }
      : () => { observations += 1; throw new Error(SECRET); };
    await deadline(failure(new OpenAICompatibleProvider({
      baseURL: local.baseURL,
      outputAudio: { modelIds: ['explicit-fixture-model'], voice: 'alloy', sampleRate: 8_000, channels: 1 },
      onMalformedStream,
    }), 'PROVIDER_MALFORMED_STREAM'));
    await deadline(closed.promise);
    await nextTick();
    assert.equal(observations, 1);
    assert.equal(local.requestCount(), 1);
  }
});

test('malformed response diagnostics expose a fixed response stage without reflecting headers', async t => {
  const diagnostics: ChatMalformedStreamDiagnostic[] = [];
  const local = await fixture(t, (_incoming, outgoing) => {
    outgoing.writeHead(200, { 'Content-Type': `application/private-${SECRET}` });
    outgoing.end(SECRET);
  });
  await failure(new OpenAICompatibleProvider({ baseURL: local.baseURL, onMalformedStream: diagnostic => diagnostics.push(diagnostic) }), 'PROVIDER_MALFORMED_STREAM');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.stage, 'response');
  assert.equal(diagnostics[0]!.frameOrdinal, 0);
  assert.equal(diagnostics[0]!.choicesType, 'missing');
  noSecret(diagnostics);
  assert.throws(() => new OpenAICompatibleProvider({ onMalformedStream: 'invalid' } as unknown as OpenAICompatibleProviderOptions), error => error instanceof EngineError && error.code === 'PROVIDER_INVALID_CONFIG');
});

test('choice-less frame diagnostics retain only three preceding fixed top-level shapes', async t => {
  const diagnostics: ChatMalformedStreamDiagnostic[] = [];
  const privateText = 'private-remote-shape-value';
  const local = await fixture(t, (_incoming, outgoing) => {
    sse(outgoing);
    outgoing.end(chunk({ role: 'assistant' }) + chunk({}) + chunk({}) + chunk({ audio: { id: 'private-audio-id' } })
      + `data: ${JSON.stringify({ id: privateText, object: privateText, type: privateText, audio: { data: privateText }, data: privateText, delta: { audio: null }, usage: null, obfuscation: privateText, [privateText]: privateText })}\r\n\r\n` + DONE);
  });
  await failure(new OpenAICompatibleProvider({
    baseURL: local.baseURL, apiKey: SECRET,
    outputAudio: { modelIds: ['explicit-fixture-model'], voice: 'alloy', sampleRate: 8_000, channels: 1 },
    onMalformedStream: diagnostic => diagnostics.push(diagnostic),
  }), 'PROVIDER_MALFORMED_STREAM');
  assert.equal(diagnostics.length, 1);
  const diagnostic = diagnostics[0]!;
  assert.equal(diagnostic.stage, 'choices');
  assert.equal(diagnostic.frameOrdinal, 5);
  assert.equal(diagnostic.audioIdSeen, true);
  assert.equal(diagnostic.audioBytesSeen, 0);
  assert.deepEqual(diagnostic.precedingFrames.map(frame => frame.frameOrdinal), [2, 3, 4]);
  assert.equal(diagnostic.top.rootType, 'object');
  assert.equal(diagnostic.top.choicesType, 'missing');
  assert.equal(diagnostic.top.objectKind, 'other-string');
  assert.equal(diagnostic.top.typeKind, 'other-string');
  assert.equal(diagnostic.top.audioDataType, 'string');
  assert.equal(diagnostic.top.audioDataCharacters, privateText.length);
  assert.equal(diagnostic.top.deltaAudioType, 'null');
  assert.equal(diagnostic.top.obfuscationType, 'string');
  assert.equal(diagnostic.top.unknownFieldCount, 1);
  for (const shape of [diagnostic.top, ...diagnostic.precedingFrames]) {
    assert.ok(Object.isFrozen(shape));
    assert.ok(Object.values(shape).every(value => value === null || ['boolean', 'number', 'string'].includes(typeof value)));
  }
  const rendered = JSON.stringify(diagnostic);
  assert.ok(Buffer.byteLength(rendered) < 4_096);
  assert.ok(!rendered.includes(privateText));
  assert.ok(!rendered.includes('private-audio-id'));
  noSecret(diagnostic);
  assert.equal(local.requestCount(), 1);
});

test('explicit obfuscation transport selection completes audio without accepting choice-less metadata', async t => {
  const serializedOptions: unknown[] = [];
  const diagnostics: ChatMalformedStreamDiagnostic[] = [];
  let forceMetadata = false;
  const local = await fixture(t, async (incoming, outgoing) => {
    const received = await body(incoming);
    const streamOptions = received.stream_options as Record<string, unknown>;
    serializedOptions.push(streamOptions);
    sse(outgoing);
    const prefix = chunk({ audio: { id: 'fixture-audio' } });
    if (streamOptions.include_obfuscation !== false || forceMetadata) {
      outgoing.end(prefix + `data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', usage: null, obfuscation: 'private-padding' })}\r\n\r\n` + DONE);
      return;
    }
    outgoing.end(prefix + chunk({ audio: { data: Buffer.from([0, 0, 1, 0]).toString('base64') } }) + chunk({}, 'stop')
      + `data: ${JSON.stringify({ choices: [{ index: 0, delta: { audio: { expires_at: 1_893_456_000 } } }] })}\r\n\r\n` + DONE);
  });
  const options: OpenAICompatibleProviderOptions = {
    baseURL: local.baseURL,
    outputAudio: { modelIds: ['explicit-fixture-model'], voice: 'alloy', sampleRate: 8_000, channels: 1 },
    onMalformedStream: diagnostic => diagnostics.push(diagnostic),
  };
  await failure(new OpenAICompatibleProvider(options), 'PROVIDER_MALFORMED_STREAM');
  assert.deepEqual(serializedOptions[0], { include_usage: true });
  assert.equal(diagnostics[0]!.stage, 'choices');
  assert.equal(diagnostics[0]!.top.objectKind, 'chat.completion.chunk');
  assert.equal(diagnostics[0]!.top.obfuscationType, 'string');
  assert.equal(diagnostics[0]!.top.choicesType, 'missing');
  const events = await collect(new OpenAICompatibleProvider({ ...options, includeStreamObfuscation: false }));
  assert.deepEqual(serializedOptions[1], { include_usage: true, include_obfuscation: false });
  assert.equal(events.filter(event => event.type === 'media.delta').length, 1);
  assert.equal(events.filter(event => event.type === 'media.end').length, 1);
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' });
  assert.equal(diagnostics.length, 1, 'Successful transport selection emits no malformed diagnostic.');
  forceMetadata = true;
  await failure(new OpenAICompatibleProvider({ ...options, includeStreamObfuscation: false }), 'PROVIDER_MALFORMED_STREAM');
  assert.equal(diagnostics.length, 2, 'Opting out cannot authorize arbitrary choice-less frames.');
  assert.equal(local.requestCount(), 3);
});

test('obfuscation selection is an exact optional boolean and true is transmitted unchanged', async t => {
  let requests = 0;
  const noFetch: typeof fetch = async () => { requests += 1; throw new Error('Unexpected HTTP request.'); };
  for (const value of [null, 'false', 0, {}]) {
    assert.throws(() => new OpenAICompatibleProvider({ fetch: noFetch, includeStreamObfuscation: value } as unknown as OpenAICompatibleProviderOptions), error => error instanceof EngineError && error.code === 'PROVIDER_INVALID_CONFIG');
  }
  assert.equal(requests, 0);
  const local = await fixture(t, async (incoming, outgoing) => {
    const received = await body(incoming);
    assert.deepEqual(received.stream_options, { include_usage: true, include_obfuscation: true });
    sse(outgoing);
    outgoing.end(chunk({}, 'stop') + DONE);
  });
  const events = await collect(new OpenAICompatibleProvider({ baseURL: local.baseURL, includeStreamObfuscation: true }));
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' });
  assert.equal(local.requestCount(), 1);
});

const audioMetadataTuple = { id: 'completion-fixture', object: 'chat.completion.chunk', created: 1_893_456_000, model: 'fixture-response-model' };
function metadataFrame(value: Record<string, unknown>): string {
  return `data: ${JSON.stringify(value)}\r\n\r\n`;
}
function metadataChoice(delta: Record<string, unknown> = {}, finish_reason: string | null = null, tuple = audioMetadataTuple): string {
  return metadataFrame({ ...tuple, choices: [{ index: 0, delta, finish_reason }] });
}

test('audio metadata compatibility requires a preceding exact tuple and rejects every payload or scope widening', async t => {
  const invalidFrames: Array<Record<string, unknown>> = [
    { ...audioMetadataTuple, id: 'different-completion' },
    { ...audioMetadataTuple, object: 'chat.completion' },
    { ...audioMetadataTuple, created: audioMetadataTuple.created + 1 },
    { ...audioMetadataTuple, model: 'different-model' },
    { ...audioMetadataTuple, id: 1 },
    { ...audioMetadataTuple, created: String(audioMetadataTuple.created) },
    { ...audioMetadataTuple, model: null },
    { ...audioMetadataTuple, usage: {} },
    { ...audioMetadataTuple, usage: { prompt_tokens: 1 } },
    { ...audioMetadataTuple, choices: null },
    { ...audioMetadataTuple, audio: null },
    { ...audioMetadataTuple, data: 'AAAA' },
    { ...audioMetadataTuple, delta: {} },
    { ...audioMetadataTuple, tool_calls: [] },
    { ...audioMetadataTuple, error: null },
    { ...audioMetadataTuple, unknown: 'private-value' },
    { ...audioMetadataTuple, service_tier: {} },
    { ...audioMetadataTuple, system_fingerprint: false },
    { ...audioMetadataTuple, obfuscation: [] },
  ];
  let current = 0;
  let wire = '';
  const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(wire); });
  const options: OpenAICompatibleProviderOptions = { baseURL: local.baseURL, allowEmptyAudioMetadata: true, audioModelIds: ['explicit-fixture-model'] };
  for (const invalid of invalidFrames) {
    wire = metadataChoice({ role: 'assistant' }) + metadataFrame(invalid) + metadataChoice({}, 'stop') + DONE;
    await failure(new OpenAICompatibleProvider(options), 'PROVIDER_MALFORMED_STREAM');
    current += 1;
  }
  wire = metadataFrame(audioMetadataTuple) + metadataChoice({}, 'stop') + DONE;
  await failure(new OpenAICompatibleProvider(options), 'PROVIDER_MALFORMED_STREAM');
  wire = metadataChoice({}) + metadataFrame(audioMetadataTuple) + metadataChoice({}, 'stop') + DONE;
  for (const disabled of [{ ...options, allowEmptyAudioMetadata: false }, { ...options, allowEmptyAudioMetadata: undefined }, { ...options, audioModelIds: [] }]) await failure(new OpenAICompatibleProvider(disabled), 'PROVIDER_MALFORMED_STREAM');
  wire = metadataChoice({}) + metadataChoice({ content: 'must-not-emit' }, null, { ...audioMetadataTuple, id: 'different-completion' }) + DONE;
  const drift = await failure(new OpenAICompatibleProvider(options), 'PROVIDER_MALFORMED_STREAM');
  assert.ok(!drift.events.some(event => event.type === 'text.delta'));
  assert.equal(local.requestCount(), current + 5);
  for (const value of [null, 'true', 1, {}]) assert.throws(() => new OpenAICompatibleProvider({ allowEmptyAudioMetadata: value } as unknown as OpenAICompatibleProviderOptions), error => error instanceof EngineError && error.code === 'PROVIDER_INVALID_CONFIG');
});

test('valid empty audio metadata cannot manufacture media bytes, finish, expiry or DONE', async t => {
  const wires = [
    metadataChoice({}) + metadataFrame(audioMetadataTuple) + DONE,
    metadataChoice({ audio: { id: 'fixture-audio' } }) + metadataFrame(audioMetadataTuple) + metadataChoice({}, 'stop') + metadataChoice({ audio: { expires_at: 1_893_456_000 } }) + DONE,
    metadataChoice({ audio: { id: 'fixture-audio', data: 'AAAAAA==' } }) + metadataFrame(audioMetadataTuple) + metadataChoice({}, 'stop') + DONE,
    metadataChoice({ audio: { id: 'fixture-audio', data: 'AAAAAA==' } }) + metadataFrame(audioMetadataTuple) + metadataChoice({}, 'stop') + metadataChoice({ audio: { expires_at: 1_893_456_000 } }),
  ];
  let ordinal = 0;
  const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(wires[ordinal++]); });
  for (const _wire of wires) {
    const failed = await failure(new OpenAICompatibleProvider({
      baseURL: local.baseURL, allowEmptyAudioMetadata: true,
      outputAudio: { modelIds: ['explicit-fixture-model'], voice: 'alloy', sampleRate: 8_000, channels: 1 },
    }), 'PROVIDER_INCOMPLETE_STREAM');
    assert.ok(!failed.events.some(event => event.type === 'media.end'));
  }
  assert.equal(local.requestCount(), wires.length);
});

test('audio metadata compatibility preserves genuine remote overflow and error mapping without remote text exposure', async t => {
  const errors = [
    { error: { code: 'context_length_exceeded', message: SECRET }, expected: 'PROVIDER_CONTEXT_OVERFLOW' },
    { error: { message: SECRET }, expected: 'PROVIDER_REMOTE_ERROR' },
  ];
  let ordinal = 0;
  const diagnostics: ChatMalformedStreamDiagnostic[] = [];
  const local = await fixture(t, (_incoming, outgoing) => {
    sse(outgoing);
    const selected = errors[ordinal++];
    assert.ok(selected);
    outgoing.end(metadataChoice({ role: 'assistant' }) + metadataFrame({ ...audioMetadataTuple, error: selected.error }) + DONE);
  });
  for (const selected of errors) await failure(new OpenAICompatibleProvider({
    baseURL: local.baseURL, allowEmptyAudioMetadata: true, audioModelIds: ['explicit-fixture-model'], apiKey: SECRET,
    onMalformedStream: diagnostic => diagnostics.push(diagnostic),
  }), selected.expected);
  assert.deepEqual(diagnostics, []);
  assert.equal(local.requestCount(), errors.length);
});

test('incomplete stream diagnostics distinguish DONE, finish and expiry without changing partial audio outcomes', async t => {
  const prefix = metadataChoice({ audio: { id: 'private-incomplete-audio-id', data: 'AAAAAA==' } });
  const cases = [
    { wire: prefix + metadataChoice({}, 'stop'), done: false, finish: 'stop', expiry: false, stage: 'complete-markers' },
    { wire: prefix + DONE, done: true, finish: 'missing', expiry: false, stage: 'complete-markers' },
    { wire: prefix + metadataChoice({}, 'stop') + DONE, done: true, finish: 'stop', expiry: false, stage: 'complete-audio' },
    { wire: prefix + 'data: {"private-incomplete-audio-id":', done: false, finish: 'missing', expiry: false, stage: 'sse' },
  ] as const;
  let ordinal = 0;
  const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(cases[ordinal++]!.wire); });
  for (const selected of cases) {
    const diagnostics: ChatMalformedStreamDiagnostic[] = [];
    const failed = await failure(new OpenAICompatibleProvider({
      baseURL: local.baseURL, allowEmptyAudioMetadata: true,
      outputAudio: { modelIds: ['explicit-fixture-model'], voice: 'alloy', sampleRate: 8_000, channels: 1 },
      onMalformedStream: diagnostic => diagnostics.push(diagnostic),
    }), 'PROVIDER_INCOMPLETE_STREAM');
    assert.equal(failed.events.filter(event => event.type === 'media.delta').length, 1);
    assert.ok(!failed.events.some(event => event.type === 'media.end'));
    assert.equal(diagnostics.length, 1);
    const diagnostic = diagnostics[0]!;
    assert.equal(diagnostic.failureCode, 'PROVIDER_INCOMPLETE_STREAM');
    assert.equal(diagnostic.doneSeen, selected.done);
    assert.equal(diagnostic.finishKind, selected.finish);
    assert.equal(diagnostic.audioExpirySeen, selected.expiry);
    assert.equal(diagnostic.stage, selected.stage);
    assert.equal(diagnostic.audioBytesSeen, 4);
    assert.equal(diagnostic.audioIdSeen, true);
    assert.ok(Buffer.byteLength(JSON.stringify(diagnostic)) < 4_096);
    assert.ok(!JSON.stringify(diagnostic).includes('private-incomplete-audio-id'));
  }
  assert.equal(local.requestCount(), cases.length);
});

test('audio expiry completion opt-in requires real PCM, exact tuple, counted usage and every terminal condition', async t => {
  const pcm = metadataChoice({ audio: { id: 'fixture-expiry-audio', data: 'AAAAAA==' } });
  const counted = metadataFrame({ ...audioMetadataTuple, choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } });
  const expiry = metadataChoice({ audio: { expires_at: 1_893_456_000 } });
  const complete = pcm + counted + expiry + DONE;
  let wire = complete;
  const local = await fixture(t, (_incoming, outgoing) => { sse(outgoing); outgoing.end(wire); });
  const options: OpenAICompatibleProviderOptions = {
    baseURL: local.baseURL, allowAudioExpiryCompletion: true,
    outputAudio: { modelIds: ['explicit-fixture-model'], voice: 'alloy', sampleRate: 8_000, channels: 1 },
  };
  const events = await collect(new OpenAICompatibleProvider(options));
  assert.equal(events.filter(event => event.type === 'media.delta').length, 1);
  assert.equal(events.filter(event => event.type === 'media.end').length, 1);
  assert.deepEqual(events.find(event => event.type === 'usage'), { type: 'usage', inputTokens: 3, outputTokens: 4 });
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' });
  for (const disabled of [undefined, false]) await failure(new OpenAICompatibleProvider({ ...options, allowAudioExpiryCompletion: disabled }), 'PROVIDER_INCOMPLETE_STREAM');
  const negatives = [
    { wire: pcm + expiry + DONE, code: 'PROVIDER_INCOMPLETE_STREAM' },
    { wire: pcm + usage({ prompt_tokens: 3 }) + expiry + DONE, code: 'PROVIDER_INCOMPLETE_STREAM' },
    { wire: pcm + usage({}) + expiry + DONE, code: 'PROVIDER_INCOMPLETE_STREAM' },
    { wire: pcm + counted + DONE, code: 'PROVIDER_INCOMPLETE_STREAM' },
    { wire: pcm + counted + expiry, code: 'PROVIDER_INCOMPLETE_STREAM' },
    { wire: metadataChoice({ audio: { id: 'fixture-expiry-audio' } }) + counted + expiry + DONE, code: 'PROVIDER_INCOMPLETE_STREAM' },
    { wire: metadataChoice({ audio: { id: 'fixture-expiry-audio', data: 'AA==' } }) + counted + expiry + DONE, code: 'PROVIDER_INCOMPLETE_STREAM' },
    { wire: chunk({ audio: { id: 'fixture-expiry-audio', data: 'AAAAAA==' } }) + counted + expiry + DONE, code: 'PROVIDER_INCOMPLETE_STREAM' },
    { wire: pcm + metadataChoice({ tool_calls: [tool(0, 'call-fixture', 'read_file', '{}')] }) + counted + expiry + DONE, code: 'PROVIDER_INCOMPLETE_STREAM' },
    { wire: pcm + counted + metadataChoice({}, 'length') + expiry + DONE, code: 'PROVIDER_INCOMPLETE_STREAM' },
    { wire: pcm + metadataChoice({ tool_calls: [tool(0, 'call-fixture', 'read_file', '{}')] }, 'tool_calls') + counted + expiry + DONE, code: 'PROVIDER_INCOMPLETE_STREAM' },
    { wire: pcm + metadataChoice({}, 'content_filter') + counted + expiry + DONE, code: 'PROVIDER_CONTENT_FILTERED' },
  ];
  for (const selected of negatives) {
    wire = selected.wire;
    const failed = await failure(new OpenAICompatibleProvider(options), selected.code);
    assert.ok(!failed.events.some(event => event.type === 'media.end'));
  }
  wire = complete;
  await failure(new OpenAICompatibleProvider({ ...options, outputAudio: { modelIds: ['unknown-fixture-model'], voice: 'alloy', sampleRate: 8_000, channels: 1 } }), 'PROVIDER_UNSUPPORTED_OUTPUT');
  wire = metadataChoice({ content: 'text recognition is not audio output' }) + counted + DONE;
  await failure(new OpenAICompatibleProvider({ baseURL: local.baseURL, audioModelIds: ['explicit-fixture-model'], allowAudioExpiryCompletion: true }), 'PROVIDER_INCOMPLETE_STREAM');
  assert.equal(local.requestCount(), 1 + 2 + negatives.length + 2);
  for (const value of [null, 'true', 1, {}]) assert.throws(() => new OpenAICompatibleProvider({ allowAudioExpiryCompletion: value } as unknown as OpenAICompatibleProviderOptions), error => error instanceof EngineError && error.code === 'PROVIDER_INVALID_CONFIG');
});

test('actual Engine metadata compatibility publishes PCM Artifact then recognizes newly admitted audio in a fresh session', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-audio-metadata-')));
  const repo = join(root, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
  const modelId = 'explicit-fixture-model';
  const pcm = Buffer.alloc(128);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(i - 32, i * 2);
  const captured: Record<string, unknown>[] = [];
  const local = await fixture(t, async (incoming, outgoing) => {
    const received = await body(incoming);
    captured.push(received);
    assert.deepEqual(received.stream_options, { include_usage: true, include_obfuscation: false });
    sse(outgoing);
    if (captured.length === 1) {
      assert.deepEqual(received.modalities, ['text', 'audio']);
      outgoing.end(metadataChoice({ role: 'assistant' }) + metadataChoice({ audio: { id: 'fixture-audio' } }) + metadataFrame({ ...audioMetadataTuple, usage: null })
        + metadataChoice({ audio: { data: pcm.toString('base64'), transcript: 'private-generation-transcript' } }) + metadataFrame(audioMetadataTuple)
        + metadataFrame({ ...audioMetadataTuple, choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } }) + metadataChoice({ audio: { expires_at: 1_893_456_000 } }) + DONE);
    } else {
      assert.equal(captured.length, 2);
      assert.equal(received.modalities, undefined);
      assert.ok(!JSON.stringify(received).includes('private-generation-transcript'));
      const messages = received.messages as Array<{ content: unknown }>;
      const content = messages.flatMap(message => Array.isArray(message.content) ? message.content : []) as Array<{ type: string; input_audio?: { data: string } }>;
      const audio = content.find(part => part.type === 'input_audio');
      assert.ok(audio?.input_audio);
      assert.deepEqual(decodePcmWave(Buffer.from(audio.input_audio.data, 'base64')).samples, pcm);
      outgoing.end(metadataChoice({ role: 'assistant' }) + metadataFrame({ ...audioMetadataTuple, usage: null }) + metadataChoice({ content: 'Recognized exact local PCM' }) + metadataChoice({}, 'stop') + DONE);
    }
  });
  const common = { baseURL: local.baseURL, audioModelIds: [modelId], includeStreamObfuscation: false, allowEmptyAudioMetadata: true, allowAudioExpiryCompletion: true };
  const providers = [
    new OpenAICompatibleProvider({ ...common, id: 'metadata-output', outputAudio: { modelIds: [modelId], voice: 'alloy', sampleRate: 8_000, channels: 1 } }),
    new OpenAICompatibleProvider({ ...common, id: 'metadata-input' }),
  ];
  const artifactDir = join(root, 'artifacts');
  const engine = createEngine({
    dbPath: join(root, 'engine.sqlite'), artifactDir, providers, allowUnknownMediaTokenCost: true,
    modelSpecs: providers.map(provider => ({ providerId: provider.id, modelId, contextWindow: 100_000, maxOutputTokens: 10_000, modalities: ['text', 'audio'], mediaCapabilities: { audioInput: true, videoFrames: false, audioOutput: provider.id === 'metadata-output' }, tools: true, reasoning: false, nativeReplay: false, source: { kind: 'fixture', observedAt: '2026-10-09T00:00:00Z' } })),
    defaults: { providerId: 'metadata-output', modelId },
  });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = await engine.dispatch({ schemaVersion: 1, commandId: 'open', type: 'workspace.open', payload: { path: repo } });
  assert.equal(workspace.ok, true, JSON.stringify(workspace.error));
  const createSession = async (id: string) => {
    const result = await engine.dispatch({ schemaVersion: 1, commandId: id, type: 'session.create', payload: { workspaceId: (workspace.result as JsonObject).id } });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return (result.result as JsonObject).id as string;
  };
  const submit = async (sessionId: string, requestId: string, extra: JsonObject = {}) => {
    const accepted = await engine.dispatchSession({ schemaVersion: 2, commandId: requestId, type: 'input.accept', payload: { sessionId, requestId, prompt: 'Inspect quoted local sound', delivery: 'queue', ...extra } });
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
    await engine.scheduler.waitForSession(sessionId);
    const runId = engine.store.getInput((accepted.result as JsonObject).inputId as string).runId!;
    return engine.coordinator.waitForRun(runId);
  };
  const outputSession = await createSession('output');
  const outputRun = await submit(outputSession, 'produce');
  assert.equal(outputRun.state, 'completed', JSON.stringify(outputRun));
  const media = engine.store.listTurns(outputRun.id).flatMap(turn => engine.store.listParts(turn.id)).find(part => part.type === 'media');
  assert.ok(media?.type === 'media');
  assert.equal(media.state, 'completed');
  assert.equal(media.artifact.complete, true);
  const bytes = await readFile(join(artifactDir, 'managed', media.artifact.id, 'content'));
  assert.deepEqual(decodePcmWave(bytes).samples, pcm);
  const inputSession = await createSession('fresh-recognition');
  const attachment = await engine.importMedia(inputSession, bytes, 'audio/wav', [{ startMs: 0, endMs: 8 }]);
  const inputRun = await submit(inputSession, 'recognize', { media: [attachment] as unknown as JsonObject['media'], config: { providerId: 'metadata-input', modelId } });
  assert.equal(inputRun.state, 'completed', JSON.stringify(inputRun));
  assert.equal(captured.length, 2);
  assert.equal(local.requestCount(), 2);
  assert.equal(engine.store.getSnapshot(inputSession).tools.length, 0);
  assert.equal(engine.store.getNativeMetrics(inputSession).attempts.total, 1);
  const textParts = engine.store.listTurns(inputRun.id).flatMap(turn => engine.store.listParts(turn.id)).filter(part => part.type === 'text');
  assert.ok(JSON.stringify(textParts).includes('Recognized exact local PCM'));
});
