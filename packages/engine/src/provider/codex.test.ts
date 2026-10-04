import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import test, { type TestContext } from 'node:test';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import type { ProviderEvent, TurnRequest } from '../ports.js';
import { CodexProvider, createCodexProvider, type CodexProviderOptions } from './codex.js';

// Deliberately synthetic credentials. No test reads the user's Codex directory.
const TOKENS = {
  access_token: 'opaque-fixture-codex-access-12345',
  refresh_token: 'opaque-fixture-codex-refresh-12345',
  id_token: 'opaque-fixture-codex-id-12345',
  account_id: 'fixture-codex-account-12345',
};
const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const RESPONSE_ID = 'resp-codex-fixture';
type Native = Record<string, unknown>;

function request(): TurnRequest {
  return { runId: 'codex-fixture-run', turnIndex: 0, modelId: 'fixture-codex-model', messages: [{ role: 'user', content: 'fixture prompt' }], tools: [] };
}
function frame(event: Native): string { return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`; }
function wire(events: Native[]): string { return events.map(frame).join(''); }
function created(): Native { return { type: 'response.created', response: { id: RESPONSE_ID, status: 'in_progress' } }; }
function added(item: Native, outputIndex = 0): Native { return { type: 'response.output_item.added', output_index: outputIndex, item }; }
function itemDone(item: Native, outputIndex = 0): Native { return { type: 'response.output_item.done', output_index: outputIndex, item }; }
function completed(output: Native[], usage?: Native): Native {
  return { type: 'response.completed', response: { id: RESPONSE_ID, status: 'completed', output, ...(usage ? { usage } : {}) } };
}
function message(text: string, id = 'msg-codex-fixture', phase?: string): Native {
  return { id, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }], ...(phase ? { phase } : {}) };
}
function textItems(text: string, outputIndex = 0, id = 'msg-codex-fixture', phase?: string, deltas = [text]): Native[] {
  return [added({ id, type: 'message', status: 'in_progress', role: 'assistant', content: [], ...(phase ? { phase } : {}) }, outputIndex),
    ...deltas.map(delta => ({ type: 'response.output_text.delta', item_id: id, output_index: outputIndex, content_index: 0, delta })),
    { type: 'response.output_text.done', item_id: id, output_index: outputIndex, content_index: 0, text }, itemDone(message(text, id, phase), outputIndex)];
}
function textStream(text = 'fixture answer', phase?: string, deltas = [text]): Native[] {
  return [created(), ...textItems(text, 0, 'msg-codex-fixture', phase, deltas), completed([message(text, 'msg-codex-fixture', phase)], { input_tokens: 3, output_tokens: 2 })];
}
function call(args = '{}', id = 'fc-codex-fixture', callId = 'call-codex-fixture', name = 'read_file'): Native {
  return { id, type: 'function_call', status: 'completed', call_id: callId, name, arguments: args };
}
function callItems(args = '{}', outputIndex = 0, id = 'fc-codex-fixture', callId = 'call-codex-fixture', name = 'read_file'): Native[] {
  return [added({ ...call('', id, callId, name), status: 'in_progress' }, outputIndex),
    { type: 'response.function_call_arguments.done', item_id: id, output_index: outputIndex, arguments: args }, itemDone(call(args, id, callId, name), outputIndex)];
}
function response(events = textStream()): Response {
  return new Response(wire(events), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
function nativeResponse(events: Native[]): Response {
  // A string Response automatically adds text/plain; bytes preserve no header.
  return new Response(Buffer.from(wire(events)));
}
function nativeTextItems(text: string, outputIndex = 0, id = 'msg-codex-fixture', phase = 'final_answer'): Native[] {
  return [added({ id, type: 'message', status: 'completed', role: 'assistant', content: [], phase }, outputIndex),
    { type: 'response.content_part.added', item_id: id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', item_id: id, output_index: outputIndex, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: id, output_index: outputIndex, content_index: 0, text },
    { type: 'response.content_part.done', item_id: id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text } },
    itemDone(message(text, id, phase), outputIndex)];
}
function nativeCallItems(args = '{}', outputIndex = 0, id = 'fc-codex-fixture', callId = 'call-codex-fixture'): Native[] {
  return [added(call('', id, callId), outputIndex),
    { type: 'response.function_call_arguments.delta', item_id: id, output_index: outputIndex, delta: args },
    { type: 'response.function_call_arguments.done', item_id: id, output_index: outputIndex, arguments: args }, itemDone(call(args, id, callId), outputIndex)];
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Codex fixture timed out.')), 2_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function home(t: TestContext, tokens: Native = TOKENS): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-codex-provider-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeAuth(directory, tokens);
  return directory;
}
async function writeAuth(directory: string, tokens: Native = TOKENS): Promise<void> {
  await writeFile(join(directory, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens }), { mode: 0o600 });
}
function noCredentials(value: unknown): void {
  const rendered = `${inspect(value, { depth: 20 })}\n${value instanceof Error ? `${value.stack}\n${String(value.cause)}` : ''}\n${JSON.stringify(value)}`;
  for (const token of Object.values(TOKENS)) assert.ok(!rendered.includes(token), 'Public provider output reflected an injected fixture credential.');
}
function visibleText(events: ProviderEvent[]): string {
  return events.filter(event => event.type === 'text.delta').map(event => event.delta).join('');
}
async function collect(provider: CodexProvider, input = request(), signal = new AbortController().signal): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.streamTurn(input, signal)) events.push(event);
  noCredentials(events);
  return events;
}
async function failure(provider: CodexProvider, code: string, input = request(), signal = new AbortController().signal): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  await assert.rejects(async () => { for await (const event of provider.streamTurn(input, signal)) events.push(event); }, error => {
    assert.ok(error instanceof EngineError); assert.equal(error.code, code); assert.equal(error.cause, undefined); noCredentials(error); return true;
  });
  noCredentials(events);
  assert.ok(events.every(event => event.type !== 'tool.call' && event.type !== 'finish'), 'Invalid stream exposed executable output.');
  return events;
}

test('Codex provider uses the trusted legacy token endpoint and explicit request headers', async t => {
  const codexHome = await home(t);
  const authBefore = await readFile(join(codexHome, 'auth.json'), 'utf8');
  let count = 0;
  const transport: typeof fetch = async (url, init) => {
    count += 1;
    assert.equal(String(url), ENDPOINT);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${TOKENS.access_token}`);
    assert.equal(headers.get('chatgpt-account-id'), TOKENS.account_id);
    assert.equal(headers.get('originator'), 'moodcode');
    assert.equal(headers.get('user-agent'), 'Moodcode/0.1.0');
    assert.equal(headers.get('accept'), 'text/event-stream');
    assert.equal(headers.get('content-type'), 'application/json');
    const payload = JSON.parse(String(init?.body)) as Native;
    assert.equal(payload.model, 'fixture-codex-model');
    assert.equal(payload.instructions, '');
    assert.equal(payload.stream, true);
    assert.equal(payload.store, false);
    assert.deepEqual(payload.include, ['reasoning.encrypted_content']);
    assert.deepEqual(payload.input, [{ role: 'developer', content: 'project instruction' }, { role: 'user', content: 'fixture prompt' }]);
    assert.deepEqual(payload.tools, [{ type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object' }, strict: false }]);
    assert.equal(payload.previous_response_id, undefined);
    assert.equal(payload.conversation, undefined);
    for (const token of Object.values(TOKENS)) assert.ok(!String(init?.body).includes(token));
    return response();
  };
  const input = request();
  input.messages.unshift({ role: 'system', content: 'project instruction' });
  input.tools = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }];
  const provider = createCodexProvider({ codexHome, fetch: transport });
  assert.ok(provider instanceof CodexProvider);
  assert.equal(provider.id, 'codex');
  noCredentials(provider);
  const events = await collect(provider, input);
  assert.equal(visibleText(events), 'fixture answer');
  assert.deepEqual(events.find(event => event.type === 'usage'), { type: 'usage', inputTokens: 3, outputTokens: 2 });
  assert.equal(events.at(-1)?.type, 'finish');
  assert.equal(count, 1);
  assert.equal(await readFile(join(codexHome, 'auth.json'), 'utf8'), authBefore, 'Provider must not refresh or rewrite Codex auth.');
});

test('each turn rereads credentials so a Codex refresh is adopted without mutation', async t => {
  const codexHome = await home(t);
  const second = { ...TOKENS, access_token: 'opaque-fixture-second-access', refresh_token: 'opaque-fixture-second-refresh', id_token: 'opaque-fixture-second-id', account_id: 'fixture-second-account' };
  const seen: string[] = [];
  const transport: typeof fetch = async (_url, init) => {
    seen.push(new Headers(init?.headers).get('authorization')!);
    return response();
  };
  const provider = new CodexProvider({ codexHome, fetch: transport });
  await collect(provider);
  await writeAuth(codexHome, second);
  const before = await readFile(join(codexHome, 'auth.json'), 'utf8');
  await collect(provider);
  assert.deepEqual(seen, [`Bearer ${TOKENS.access_token}`, `Bearer ${second.access_token}`]);
  assert.equal(await readFile(join(codexHome, 'auth.json'), 'utf8'), before);
  noCredentials(provider);
});

for (const field of ['baseURL', 'apiKey', 'id', 'endpoint', 'headers', 'redactionSecrets', 'streamProfile']) test(`Codex provider rejects a runtime ${field} override`, () => {
  const value = field === 'id' ? 'foreign' : field === 'apiKey' ? TOKENS.access_token : 'https://third-party.invalid/v1';
  assert.throws(() => new CodexProvider({ [field]: value } as unknown as CodexProviderOptions), error => {
    assert.ok(error instanceof EngineError); assert.equal(error.code, 'PROVIDER_INVALID_CONFIG'); noCredentials(error); return true;
  });
});

test('long local access tokens are supported without the API key size assumption', async t => {
  const accessToken = 'opaque-fixture-long-access-' + 'a'.repeat(5_000);
  const codexHome = await home(t, { ...TOKENS, access_token: accessToken });
  const provider = new CodexProvider({ codexHome, fetch: async (url, init) => {
    assert.equal(String(url), ENDPOINT);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${accessToken}`);
    return response(textStream(accessToken));
  } });
  const events = await collect(provider);
  assert.equal(visibleText(events), '[REDACTED]');
  assert.ok(!JSON.stringify(events).includes(accessToken));
  assert.ok(!inspect(provider).includes(accessToken));
});

test('missing authentication fails before any transport request', async t => {
  const codexHome = await home(t);
  await rm(join(codexHome, 'auth.json'));
  let fetched = false;
  await failure(new CodexProvider({ codexHome, fetch: async () => { fetched = true; return response(); } }), 'CODEX_AUTH_MISSING');
  assert.equal(fetched, false);
});

test('malformed authentication fails before any transport request', async t => {
  const codexHome = await home(t);
  await writeFile(join(codexHome, 'auth.json'), `{"tokens":"${TOKENS.access_token}"}`);
  let fetched = false;
  await failure(new CodexProvider({ codexHome, fetch: async () => { fetched = true; return response(); } }), 'CODEX_AUTH_INVALID');
  assert.equal(fetched, false);
});

test('expired authentication fails without rotating a refresh token', async t => {
  const payload = Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url');
  const codexHome = await home(t, { ...TOKENS, access_token: `fixture.${payload}.fixture` });
  const authBefore = await readFile(join(codexHome, 'auth.json'), 'utf8');
  let fetched = false;
  await failure(new CodexProvider({ codexHome, now: () => 10_000, fetch: async () => { fetched = true; return response(); } }), 'CODEX_AUTH_EXPIRED');
  assert.equal(fetched, false);
  assert.equal(await readFile(join(codexHome, 'auth.json'), 'utf8'), authBefore);
});

test('a directory in place of auth.json is rejected before transport', async t => {
  const codexHome = await home(t);
  await rm(join(codexHome, 'auth.json'));
  await mkdir(join(codexHome, 'auth.json'));
  let fetched = false;
  await failure(new CodexProvider({ codexHome, fetch: async () => { fetched = true; return response(); } }), 'CODEX_AUTH_UNREADABLE');
  assert.equal(fetched, false);
});

test('already aborted turns avoid auth and fetch and do not publish the abort reason', async t => {
  const codexHome = await home(t);
  await rm(join(codexHome, 'auth.json'));
  const controller = new AbortController();
  controller.abort(TOKENS.refresh_token);
  let fetched = false;
  await failure(new CodexProvider({ codexHome, fetch: async () => { fetched = true; return response(); } }), 'PROVIDER_CANCELLED', request(), controller.signal);
  assert.equal(fetched, false);
});

test('HTTP failure exposes only status and never response credentials', async t => {
  const codexHome = await home(t);
  await failure(new CodexProvider({ codexHome, fetch: async () => new Response(Object.values(TOKENS).join(' '), { status: 401 }) }), 'PROVIDER_HTTP_ERROR');
});

test('transport errors discard sensitive messages, causes and custom fields', async t => {
  const codexHome = await home(t);
  await failure(new CodexProvider({ codexHome, fetch: async () => {
    throw Object.assign(new Error(TOKENS.access_token, { cause: TOKENS.refresh_token }), { body: TOKENS.id_token, account: TOKENS.account_id });
  } }), 'PROVIDER_TRANSPORT_ERROR');
});

test('native response failure remains sanitized and exposes no executable call', async t => {
  const codexHome = await home(t);
  const events = [created(), ...callItems('{"path":"fixture.txt"}'), { type: 'response.failed', response: { id: RESPONSE_ID, status: 'failed', error: { message: Object.values(TOKENS).join(' ') } } }];
  await failure(new CodexProvider({ codexHome, fetch: async () => response(events) }), 'PROVIDER_REMOTE_ERROR');
});

test('EOF after complete arguments cannot expose an executable call', async t => {
  const codexHome = await home(t);
  await failure(new CodexProvider({ codexHome, fetch: async () => response([created(), ...callItems('{"path":"fixture.txt"}')]) }), 'PROVIDER_INCOMPLETE_STREAM');
});

test('incomplete native output finishes as length with no reusable replay', async t => {
  const codexHome = await home(t);
  const item = message('partial');
  item.status = 'incomplete';
  const events = [created(), added({ id: 'msg-codex-fixture', type: 'message', status: 'in_progress', role: 'assistant', content: [] }),
    { type: 'response.output_text.delta', item_id: 'msg-codex-fixture', output_index: 0, content_index: 0, delta: 'partial' },
    itemDone(item), { type: 'response.incomplete', response: { id: RESPONSE_ID, status: 'incomplete', output: [item], incomplete_details: { reason: 'max_output_tokens' } } }];
  const output = await collect(new CodexProvider({ codexHome, fetch: async () => response(events) }));
  assert.equal(visibleText(output), 'partial');
  assert.deepEqual(output.at(-1), { type: 'finish', reason: 'length' });
});

test('abort cancels an in-flight transport and removes the external listener', async t => {
  const codexHome = await home(t);
  const external = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let transportAborted = false;
  const transport: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { transportAborted = true; reject(new Error(TOKENS.access_token)); }, { once: true });
    entered();
  });
  const pending = failure(new CodexProvider({ codexHome, fetch: transport }), 'PROVIDER_CANCELLED', request(), external.signal);
  await started;
  external.abort(TOKENS.refresh_token);
  await pending;
  assert.equal(transportAborted, true);
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
});

test('timeout cancels transport and returns a static public error', async t => {
  const codexHome = await home(t);
  let aborted = false;
  const transport: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error(TOKENS.access_token)); }, { once: true });
  });
  await failure(new CodexProvider({ codexHome, fetch: transport, timeoutMs: 15 }), 'PROVIDER_TIMEOUT');
  assert.equal(aborted, true);
});

test('text redaction holds split prefixes for access, refresh, identity and account strings', async t => {
  const codexHome = await home(t);
  const source = Object.values(TOKENS).join(' | ');
  const deltas: string[] = [];
  for (const token of Object.values(TOKENS)) deltas.push(token.slice(0, 9), token.slice(9), ' | ');
  deltas[deltas.length - 1] = '';
  const provider = new CodexProvider({ codexHome, fetch: async () => response(textStream(source, 'final_answer', deltas)) });
  const events = await collect(provider);
  assert.ok(visibleText(events).includes('[REDACTED]'));
  assert.equal(events.at(-1)?.type, 'finish');
  noCredentials(provider);
});

test('tool calls and native replay redact all credential strings including JSON escapes', async t => {
  const codexHome = await home(t);
  const input: Native = Object.fromEntries(Object.entries(TOKENS).map(([key, value]) => [key, value]));
  const argumentsJson = JSON.stringify(input).replaceAll('opaque', '\\u006fpaque');
  const id = `fc-${TOKENS.id_token}`;
  const callId = `call-${TOKENS.access_token}`;
  const name = `name-${TOKENS.account_id}`;
  const functionItem = call(argumentsJson, id, callId, name);
  const output = await collect(new CodexProvider({ codexHome, fetch: async () => response([created(), ...callItems(argumentsJson, 0, id, callId, name), completed([functionItem])]) }));
  const tool = output.find(event => event.type === 'tool.call');
  assert.ok(tool?.type === 'tool.call');
  assert.ok(tool.call.id.includes('[REDACTED]'));
  assert.ok(tool.call.name.includes('[REDACTED]'));
  assert.deepEqual(tool.call.input, Object.fromEntries(Object.keys(TOKENS).map(key => [key, '[REDACTED]'])));
  const finish = output.at(-1);
  assert.ok(finish?.type === 'finish');
  assert.ok(Array.isArray(finish.replayItems));
  noCredentials(finish.replayItems);
});

for (const field of Object.keys(TOKENS) as (keyof typeof TOKENS)[]) test(`unsafe opaque reasoning containing ${field} fails before calls or replay`, async t => {
  const codexHome = await home(t);
  const reasoning = { id: 'rs-codex-fixture', type: 'reasoning', summary: [], encrypted_content: `cipher:${TOKENS[field]}` };
  const events = [created(), added({ id: reasoning.id, type: 'reasoning', summary: [] }), itemDone(reasoning), ...callItems('{}', 1), completed([reasoning, call()])];
  await failure(new CodexProvider({ codexHome, fetch: async () => response(events) }), 'PROVIDER_INVALID_REPLAY');
});

test('native reasoning, commentary phase and tool output round-trip through the own loop', async t => {
  const codexHome = await home(t);
  const reasoning = { id: 'rs-codex-fixture', type: 'reasoning', summary: [{ type: 'summary_text', text: 'checking' }], encrypted_content: 'opaque-fixture-ciphertext' };
  const commentary = message('checking fixture', 'msg-commentary', 'commentary');
  const args = '{"path":"fixture.txt"}';
  const functionItem = call(args);
  const payloads: Native[] = [];
  let turn = 0;
  const transport: typeof fetch = async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)) as Native);
    turn += 1;
    return turn === 1 ? response([created(), added({ id: reasoning.id, type: 'reasoning', summary: [] }), itemDone(reasoning),
      ...textItems('checking fixture', 1, 'msg-commentary', 'commentary'), ...callItems(args, 2), completed([reasoning, commentary, functionItem])]) : response(textStream('fixture read complete', 'final_answer'));
  };
  const provider = new CodexProvider({ codexHome, fetch: transport });
  const input = request();
  input.messages.unshift({ role: 'system', content: 'project instruction' });
  const first = await collect(provider, input);
  const finish = first.at(-1);
  const tool = first.find(event => event.type === 'tool.call');
  assert.ok(finish?.type === 'finish' && finish.replayItems);
  assert.ok(tool?.type === 'tool.call');
  assert.equal(finish.reason, 'tool_calls');
  assert.deepEqual(finish.replayItems, [reasoning, commentary, functionItem]);
  const next = request();
  next.turnIndex = 1;
  next.messages = [...input.messages, { role: 'assistant', content: visibleText(first), toolCalls: [tool.call], providerReplay: { providerId: provider.id, items: finish.replayItems } },
    { role: 'tool', content: 'fixture file content', toolCallId: tool.call.id }];
  const second = await collect(provider, next);
  assert.deepEqual(payloads[1]!.input, [{ role: 'developer', content: 'project instruction' }, { role: 'user', content: 'fixture prompt' }, reasoning, commentary, functionItem,
    { type: 'function_call_output', call_id: 'call-codex-fixture', output: 'fixture file content' }]);
  assert.equal(visibleText(second), 'fixture read complete');
  const secondFinish = second.at(-1);
  assert.ok(secondFinish?.type === 'finish');
  assert.equal(secondFinish.replayItems?.[0]?.phase, 'final_answer');
  assert.equal(payloads[1]!.previous_response_id, undefined);
});

test('same-provider replay binding failure prevents transport', async t => {
  const codexHome = await home(t);
  let fetched = false;
  const input = request();
  input.messages.push({ role: 'assistant', content: 'conflicting text', providerReplay: { providerId: 'codex', items: [message('native text') as JsonObject] } });
  await failure(new CodexProvider({ codexHome, fetch: async () => { fetched = true; return response(); } }), 'PROVIDER_INVALID_REPLAY', input);
  assert.equal(fetched, false);
});

test('foreign-provider replay falls back to normalized assistant content', async t => {
  const codexHome = await home(t);
  let payload: Native | undefined;
  const input = request();
  input.messages.push({ role: 'assistant', content: 'normalized answer', providerReplay: { providerId: 'openai-responses', items: [{ arbitrary: true }] } });
  await collect(new CodexProvider({ codexHome, fetch: async (_url, init) => { payload = JSON.parse(String(init?.body)) as Native; return response(); } }), input);
  assert.deepEqual(payload?.input, [{ role: 'user', content: 'fixture prompt' }, { role: 'assistant', content: 'normalized answer' }]);
});

test('request and SSE bounds are enforced through the Codex wrapper', async t => {
  const codexHome = await home(t);
  let fetched = false;
  await failure(new CodexProvider({ codexHome, maxRequestBytes: 10, fetch: async () => { fetched = true; return response(); } }), 'PROVIDER_LIMIT_EXCEEDED');
  assert.equal(fetched, false);
  await failure(new CodexProvider({ codexHome, maxFrameBytes: 10, fetch: async () => response() }), 'PROVIDER_LIMIT_EXCEEDED');
});

test('tool argument and output item bounds are enforced before exposing calls', async t => {
  const codexHome = await home(t);
  const args = '{"path":"too-large.txt"}';
  const stream = [created(), ...callItems(args), completed([call(args)])];
  await failure(new CodexProvider({ codexHome, maxToolArgumentBytes: 2, fetch: async () => response(stream) }), 'PROVIDER_LIMIT_EXCEEDED');
  await failure(new CodexProvider({ codexHome, maxOutputItems: 1, fetch: async () => response([created(), ...callItems('{}', 1), completed([call()])]) }), 'PROVIDER_LIMIT_EXCEEDED');
});

test('returning from a partial stream cancels its reader', async t => {
  const codexHome = await home(t);
  let cancelled = false;
  const payload = wire([created(), added({ id: 'msg-codex-fixture', type: 'message', status: 'in_progress', role: 'assistant', content: [] }),
    { type: 'response.output_text.delta', item_id: 'msg-codex-fixture', output_index: 0, content_index: 0, delta: 'partial' }]);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(payload)); }, cancel() { cancelled = true; } });
  const provider = new CodexProvider({ codexHome, fetch: async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }) });
  for await (const event of provider.streamTurn(request(), new AbortController().signal)) {
    assert.equal(event.type, 'text.delta');
    break;
  }
  assert.equal(cancelled, true);
});

test('native Codex profile accepts absent content type, completed added status and empty terminal output together', async t => {
  const codexHome = await home(t);
  const provider = new CodexProvider({ codexHome, fetch: async () => {
    const result = nativeResponse([created(), ...nativeTextItems('native fixture answer'), completed([], { input_tokens: 7, output_tokens: 2 })]);
    assert.equal(result.headers.get('content-type'), null);
    return result;
  } });
  const events = await collect(provider);
  assert.equal(visibleText(events), 'native fixture answer');
  assert.deepEqual(events.find(event => event.type === 'usage'), { type: 'usage', inputTokens: 7, outputTokens: 2 });
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop', replayItems: [message('native fixture answer', 'msg-codex-fixture', 'final_answer')] });
});

test('native empty terminal output reconstructs native reasoning, message phase and function order for replay', async t => {
  const codexHome = await home(t);
  const reasoning = { id: 'rs-native-fixture', type: 'reasoning', summary: [{ type: 'summary_text', text: 'checking fixture' }], encrypted_content: 'opaque-native-fixture-ciphertext' };
  const text = 'native fixture checking';
  const commentary = message(text, 'msg-native-commentary', 'commentary');
  const args = '{"path":"native-fixture.txt"}';
  const functionItem = call(args);
  const firstStream = [created(), added({ id: reasoning.id, type: 'reasoning', summary: [] }, 0),
    ...nativeTextItems(text, 1, 'msg-native-commentary', 'commentary'), ...nativeCallItems(args, 2), itemDone(reasoning, 0), completed([])];
  let turn = 0;
  let secondInput: unknown;
  const provider = new CodexProvider({ codexHome, fetch: async (_url, init) => {
    turn += 1;
    if (turn === 1) return nativeResponse(firstStream);
    secondInput = (JSON.parse(String(init?.body)) as Native).input;
    return nativeResponse([created(), ...nativeTextItems('native fixture complete'), completed([])]);
  } });
  const first = await collect(provider);
  const finish = first.at(-1);
  const tool = first.find(event => event.type === 'tool.call');
  assert.ok(finish?.type === 'finish' && finish.replayItems);
  assert.ok(tool?.type === 'tool.call');
  assert.equal(finish.reason, 'tool_calls');
  assert.deepEqual(finish.replayItems, [reasoning, commentary, functionItem], 'Replay uses output indexes rather than item.done arrival order.');
  const next = request();
  next.turnIndex = 1;
  next.messages.push({ role: 'assistant', content: text, toolCalls: [tool.call], providerReplay: { providerId: 'codex', items: finish.replayItems } },
    { role: 'tool', content: 'native fixture file content', toolCallId: tool.call.id });
  const second = await collect(provider, next);
  assert.equal(visibleText(second), 'native fixture complete');
  assert.deepEqual(secondInput, [{ role: 'user', content: 'fixture prompt' }, reasoning, commentary, functionItem,
    { type: 'function_call_output', call_id: 'call-codex-fixture', output: 'native fixture file content' }]);
});

test('completed added function status does not expose calls before arguments done, item done and terminal', async t => {
  const codexHome = await home(t);
  const argsReady = deferred(), itemReady = deferred();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const args = '{"path":"native-fixture.txt"}';
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const send = (events: Native[]) => controller.enqueue(Buffer.from(wire(events)));
  const provider = new CodexProvider({ codexHome, fetch: async () => {
    send([created(), added(call('')), { type: 'response.function_call_arguments.delta', item_id: 'fc-codex-fixture', output_index: 0, delta: args },
      { type: 'response.function_call_arguments.done', item_id: 'fc-codex-fixture', output_index: 0, arguments: args },
      added({ id: 'msg-gate', type: 'message', status: 'completed', role: 'assistant', content: [], phase: 'commentary' }, 1),
      { type: 'response.content_part.added', item_id: 'msg-gate', output_index: 1, content_index: 0, part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', item_id: 'msg-gate', output_index: 1, content_index: 0, delta: 'args-ready' }]);
    return new Response(stream);
  } });
  const events: ProviderEvent[] = [];
  const pending = (async () => {
    for await (const event of provider.streamTurn(request(), new AbortController().signal)) {
      events.push(event);
      if (event.type === 'text.delta' && event.delta === 'args-ready') argsReady.resolve();
      if (event.type === 'text.delta' && event.delta === ' items-ready') itemReady.resolve();
    }
  })();
  t.after(() => { try { controller.close(); } catch {} });
  await deadline(argsReady.promise);
  assert.deepEqual(events, [{ type: 'text.delta', delta: 'args-ready' }]);
  send([itemDone(call(args)), { type: 'response.output_text.delta', item_id: 'msg-gate', output_index: 1, content_index: 0, delta: ' items-ready' }]);
  await deadline(itemReady.promise);
  assert.ok(events.every(event => event.type !== 'tool.call' && event.type !== 'finish'));
  const full = 'args-ready items-ready';
  send([{ type: 'response.output_text.done', item_id: 'msg-gate', output_index: 1, content_index: 0, text: full },
    { type: 'response.content_part.done', item_id: 'msg-gate', output_index: 1, content_index: 0, part: { type: 'output_text', text: full } },
    itemDone(message(full, 'msg-gate', 'commentary'), 1), completed([])]);
  controller.close();
  await deadline(pending);
  assert.equal(events.filter(event => event.type === 'tool.call').length, 1);
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'tool_calls', replayItems: [call(args), message(full, 'msg-gate', 'commentary')] });
  noCredentials(events);
});

for (const [label, events] of [
  ['missing message item.done', [created(), ...nativeTextItems('fixture').slice(0, -1), completed([])]],
  ['missing function item.done', [created(), ...nativeCallItems().slice(0, -1), completed([])]],
  ['missing arguments.done', [created(), ...nativeCallItems().filter(event => event.type !== 'response.function_call_arguments.done'), completed([])]],
  ['invalid complete argument JSON', [created(), ...nativeCallItems('{invalid-json'), completed([])]],
  ['mismatched item identifier', [created(), ...nativeCallItems().slice(0, -1), itemDone(call('{}', 'fc-other')), completed([])]],
  ['mismatched argument identifier', [created(), added(call('')), { type: 'response.function_call_arguments.done', item_id: 'fc-other', output_index: 0, arguments: '{}' }, itemDone(call()), completed([])]],
  ['mismatched full terminal output', [created(), ...nativeTextItems('fixture'), completed([message('conflicting text', 'msg-codex-fixture', 'final_answer')])]],
  ['nonempty terminal with mismatched native ID', [created(), ...nativeCallItems(), completed([call('{}', 'fc-other')])]],
  ['full terminal output without item.done', [created(), ...nativeCallItems().slice(0, -1), completed([call()])]],
] as [string, Native[]][]) test(`native fallback rejects ${label}`, async t => {
  const codexHome = await home(t);
  await failure(new CodexProvider({ codexHome, fetch: async () => nativeResponse(events) }), 'PROVIDER_MALFORMED_STREAM');
});

test('a missing content type cannot turn arbitrary JSON into a native SSE completion', async t => {
  const codexHome = await home(t);
  await failure(new CodexProvider({ codexHome, fetch: async () => new Response(Buffer.from(JSON.stringify({ response: { id: RESPONSE_ID, status: 'completed' }, private: TOKENS.access_token }))) }), 'PROVIDER_INCOMPLETE_STREAM');
});

test('native Codex profile rejects an explicitly wrong content type', async t => {
  const codexHome = await home(t);
  await failure(new CodexProvider({ codexHome, fetch: async () => new Response(Buffer.from(wire([created(), ...nativeTextItems('fixture'), completed([])])), { headers: { 'Content-Type': 'application/json' } }) }), 'PROVIDER_MALFORMED_STREAM');
});

test('native fallback reconstructs redacted output but refuses credential-bearing opaque reasoning', async t => {
  const codexHome = await home(t);
  const text = Object.values(TOKENS).join(' | ');
  const events = await collect(new CodexProvider({ codexHome, fetch: async () => nativeResponse([created(), ...nativeTextItems(text), completed([])]) }));
  assert.ok(visibleText(events).includes('[REDACTED]'));
  const finish = events.at(-1);
  assert.ok(finish?.type === 'finish' && finish.replayItems);
  noCredentials(finish.replayItems);
  const reasoning = { id: 'rs-native-fixture', type: 'reasoning', summary: [], encrypted_content: `cipher:${TOKENS.refresh_token}` };
  await failure(new CodexProvider({ codexHome, fetch: async () => nativeResponse([created(), added({ id: reasoning.id, type: 'reasoning', summary: [] }), itemDone(reasoning), ...nativeCallItems('{}', 1), completed([])]) }), 'PROVIDER_INVALID_REPLAY');
});

test('native completed-added stream cancellation still cancels its reader before calls', async t => {
  const codexHome = await home(t);
  const external = new AbortController();
  let cancelled = false;
  const payload = [created(), ...nativeCallItems().slice(0, -1), ...nativeTextItems('abort marker', 1).slice(0, 3)];
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(wire(payload))); }, cancel() { cancelled = true; } });
  const provider = new CodexProvider({ codexHome, fetch: async () => new Response(stream) });
  const events: ProviderEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of provider.streamTurn(request(), external.signal)) {
      events.push(event);
      if (event.type === 'text.delta') external.abort(TOKENS.id_token);
    }
  }, error => { assert.ok(error instanceof EngineError); assert.equal(error.code, 'PROVIDER_CANCELLED'); noCredentials(error); return true; });
  assert.equal(cancelled, true);
  assert.ok(events.every(event => event.type !== 'tool.call' && event.type !== 'finish'));
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
});

test('native empty output fallback enforces response bytes and tool argument limits', async t => {
  const codexHome = await home(t);
  const args = '{"path":"native-fixture.txt"}';
  const stream = [created(), ...nativeCallItems(args), completed([])];
  await failure(new CodexProvider({ codexHome, maxResponseBytes: 100, fetch: async () => nativeResponse(stream) }), 'PROVIDER_LIMIT_EXCEEDED');
  await failure(new CodexProvider({ codexHome, maxToolArgumentBytes: 2, fetch: async () => nativeResponse(stream) }), 'PROVIDER_LIMIT_EXCEEDED');
});
