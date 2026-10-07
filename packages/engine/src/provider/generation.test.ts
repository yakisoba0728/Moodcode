import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { AnthropicProvider } from './anthropic.js';
import { CodexProvider } from './codex.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { ResponsesProvider } from './responses.js';
import { ScriptedProvider } from './scripted.js';
import { HOST_GENERATION_REQUEST_LIMITS, hostGenerationTransportRequest, validateHostGenerationRequest, type HostGenerationProviderPort, type HostGenerationRequest } from './generation.js';

const SECRET = 'moodcode-synthetic-generation-secret-123456';
const signal = () => new AbortController().signal;
const request = (): HostGenerationRequest => ({ owner: { kind: 'host-generation', workspaceId: 'workspace-fixture', generationId: 'generation-fixture', attemptId: 'attempt-fixture' },
  modelId: 'explicit-fixture-model', messages: [{ role: 'system', content: 'Extract a bounded summary.' }, { role: 'user', content: 'Source fixture.' }], tools: [], reasoningEffort: 'high', includeMetadata: true });
const codingRequest = (): TurnRequest => ({ runId: 'actual-coding-fixture', turnIndex: 0, modelId: 'explicit-fixture-model', messages: [{ role: 'user', content: 'coding' }], tools: [] });
const code = (expected: string) => (error: unknown) => { assert.ok(error instanceof EngineError); assert.equal(error.code, expected); assert.ok(!JSON.stringify(error).includes(SECRET)); return true; };
async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> { const result: ProviderEvent[] = []; for await (const event of events) result.push(event); return result; }
const text = (events: ProviderEvent[]) => events.filter(event => event.type === 'text.delta').map(event => event.delta).join('');

test('legacy providers remain compatible and host requests cannot become coding Turns', () => {
  const legacy: ProviderAdapter = { id: 'legacy', async *streamTurn() { yield { type: 'finish', reason: 'stop' }; } };
  assert.equal(legacy.streamGeneration, undefined);
  if (false) {
    // @ts-expect-error A host generation has no coding runId or turnIndex.
    const turn: TurnRequest = request();
    // @ts-expect-error A coding turn lacks the independent host owner and text-only payload.
    const generation: HostGenerationRequest = codingRequest();
    void turn; void generation;
  }
});

test('plain and deeply frozen requests detach before iterator acquisition and strip owner from transport', () => {
  const original = request(), detached = validateHostGenerationRequest(original);
  assert.deepEqual(detached, original);
  assert.notEqual(detached, original); assert.notEqual(detached.owner, original.owner); assert.notEqual(detached.messages, original.messages);
  for (const value of [detached, detached.owner, detached.messages, detached.messages[0], detached.tools]) assert.ok(Object.isFrozen(value));
  assert.deepEqual(validateHostGenerationRequest(detached), detached);
  const transport = hostGenerationTransportRequest(detached);
  assert.deepEqual(Object.keys(transport).sort(), ['includeMetadata', 'messages', 'modelId', 'reasoningEffort', 'tools']);
  assert.equal(Object.hasOwn(transport, 'owner'), false); assert.equal(Object.hasOwn(transport, 'runId'), false);
});

const invalidCases: { name: string; value(): unknown }[] = [
  { name: 'coding Run field', value: () => ({ ...request(), runId: 'fabricated' }) },
  { name: 'coding Session field', value: () => ({ ...request(), sessionId: 'fabricated' }) },
  { name: 'coding turn index', value: () => ({ ...request(), turnIndex: 0 }) },
  { name: 'resolved media', value: () => ({ ...request(), resolvedImages: [] }) },
  { name: 'resolved documents', value: () => ({ ...request(), resolvedDocuments: [] }) },
  { name: 'assistant input', value: () => ({ ...request(), messages: [{ role: 'assistant', content: 'opaque history' }] }) },
  { name: 'tool result input', value: () => ({ ...request(), messages: [{ role: 'tool', content: 'model proof' }] }) },
  { name: 'provider replay', value: () => ({ ...request(), messages: [{ role: 'user', content: 'text', providerReplay: {} }] }) },
  { name: 'attachment', value: () => ({ ...request(), messages: [{ role: 'user', content: 'text', attachments: [] }] }) },
  { name: 'document', value: () => ({ ...request(), messages: [{ role: 'user', content: 'text', documents: [] }] }) },
  { name: 'executable tools', value: () => ({ ...request(), tools: [{ name: 'run_command' }] }) },
  { name: 'wrong host owner', value: () => ({ ...request(), owner: { ...request().owner, kind: 'run' } }) },
  { name: 'foreign owner field', value: () => ({ ...request(), owner: { ...request().owner, sessionId: 'fake' } }) },
  { name: 'missing owner', value: () => ({ modelId: 'fixture', messages: [], tools: [], includeMetadata: true }) },
  { name: 'empty identifier', value: () => ({ ...request(), owner: { ...request().owner, attemptId: ' ' } }) },
  { name: 'model identifier control bytes', value: () => ({ ...request(), modelId: 'model\nprivate' }) },
  { name: 'missing metadata', value: () => ({ ...request(), includeMetadata: false }) },
  { name: 'invalid effort', value: () => ({ ...request(), reasoningEffort: 'unbounded' }) },
  { name: 'own undefined effort', value: () => ({ ...request(), reasoningEffort: undefined }) },
  { name: 'empty messages', value: () => ({ ...request(), messages: [] }) },
  { name: 'too many messages', value: () => ({ ...request(), messages: Array.from({ length: 257 }, () => ({ role: 'user', content: '' })) }) },
  { name: 'sparse messages', value: () => ({ ...request(), messages: new Array(1) }) },
  { name: 'message prototype', value: () => ({ ...request(), messages: [Object.create({ role: 'user', content: 'hidden' })] }) },
  { name: 'symbol field', value: () => ({ ...request(), [Symbol('private')]: SECRET }) },
  { name: 'array custom field', value: () => ({ ...request(), tools: Object.assign([], { extra: true }) }) },
  { name: 'request byte ceiling', value: () => ({ ...request(), messages: [{ role: 'user', content: 'x'.repeat(HOST_GENERATION_REQUEST_LIMITS.maxBytes) }] }) },
  { name: 'escaped text byte ceiling', value: () => ({ ...request(), messages: [{ role: 'user', content: '\u0000'.repeat(50_000) }] }) },
];
for (const fixture of invalidCases) test(`host generation rejects ${fixture.name}`, () => assert.throws(() => validateHostGenerationRequest(fixture.value()), code('PROVIDER_INVALID_REQUEST')));

test('host validation never invokes request/owner/message getters or proxy traps', () => {
  let reads = 0;
  for (const value of [
    Object.defineProperty(request(), 'modelId', { enumerable: true, get() { reads++; return SECRET; } }),
    { ...request(), owner: Object.defineProperty({ ...request().owner }, 'attemptId', { enumerable: true, get() { reads++; return SECRET; } }) },
    { ...request(), messages: [Object.defineProperty({ role: 'user' }, 'content', { enumerable: true, get() { reads++; return SECRET; } })] },
    new Proxy(request(), { ownKeys() { reads++; throw new Error(SECRET); }, getPrototypeOf() { reads++; throw new Error(SECRET); } }),
    { ...request(), messages: new Proxy([], { get() { reads++; throw new Error(SECRET); } }) },
  ]) assert.throws(() => validateHostGenerationRequest(value), code('PROVIDER_INVALID_REQUEST'));
  assert.equal(reads, 0);
});

type Wire = Record<string, unknown>;
const sse = (events: Wire[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
function responseWire(answer: string, tool = false): string {
  const item: Wire = tool
    ? { id: 'fc-fixture', type: 'function_call', status: 'completed', call_id: 'call-fixture', name: 'run_command', arguments: '{}' }
    : { id: 'msg-fixture', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: answer }] };
  return sse([
    { type: 'response.created', response: { id: 'resp-fixture', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: tool ? { ...item, status: 'in_progress', arguments: '' } : { ...item, status: 'in_progress', content: [] } },
    ...(tool ? [{ type: 'response.function_call_arguments.done', item_id: 'fc-fixture', output_index: 0, arguments: '{}' }]
      : [{ type: 'response.output_text.done', item_id: 'msg-fixture', output_index: 0, content_index: 0, text: answer }]),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp-fixture', status: 'completed', output: [item], usage: { input_tokens: 4, output_tokens: 2, input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 1 } } } },
  ]);
}
function chatWire(answer: string, tool = false): string {
  return sse([
    { choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: 'call-fixture', type: 'function', function: { name: 'run_command', arguments: '{}' } }] } : { content: answer }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] },
    { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 1 } } },
  ]) + 'data: [DONE]\n\n';
}
function anthropicWire(answer: string, tool = false): string {
  return sse([
    { type: 'message_start', message: { id: 'msg-fixture', type: 'message', role: 'assistant', model: 'explicit-fixture-model', content: [], stop_reason: null, usage: { input_tokens: 4, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call-fixture', name: 'run_command', input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text: answer } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]);
}
interface Fixture { name: string; wire(answer: string, tool?: boolean): string; adapter(fetch: typeof globalThis.fetch): HostGenerationProviderPort }
const native: Fixture[] = [
  { name: 'Responses', wire: responseWire, adapter: fetch => new ResponsesProvider({ fetch, apiKey: SECRET, cleanupTimeoutMs: 20 }) },
  { name: 'OpenAICompatible', wire: chatWire, adapter: fetch => new OpenAICompatibleProvider({ fetch, apiKey: SECRET, cleanupTimeoutMs: 20 }) },
  { name: 'Anthropic', wire: anthropicWire, adapter: fetch => new AnthropicProvider({ fetch, apiKey: SECRET, cleanupTimeoutMs: 20, publicReasoningSummary: true }) },
];
const response = (wire: string | ReadableStream<Uint8Array>) => new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } });

for (const fixture of native) {
  test(`${fixture.name} generation sends explicit owner-free text wire and normalized usage, never coding history`, async () => {
    let sent = 0, body!: Wire;
    const adapter = fixture.adapter(async (_url, init) => { sent++; body = JSON.parse(String(init?.body)); assert.equal(init?.redirect, 'error'); return response(fixture.wire('exact generated answer')); });
    const result = await collect(adapter.streamGeneration(request(), signal()));
    assert.equal(sent, 1); assert.equal(text(result), 'exact generated answer');
    assert.equal(body.model, 'explicit-fixture-model'); assert.equal(Object.hasOwn(body, 'tools'), false);
    for (const key of ['owner', 'runId', 'sessionId', 'turnIndex', 'generationId', 'attemptId']) assert.equal(Object.hasOwn(body, key), false);
    assert.ok(!JSON.stringify(body).includes('workspace-fixture')); assert.ok(!JSON.stringify(body).includes(SECRET));
    assert.equal(result.some(event => event.type === 'tool.call' || event.type === 'reasoning.delta'), false);
    assert.deepEqual(result.at(-1), { type: 'finish', reason: 'stop' });
    assert.ok(result.some(event => event.type === 'usage' && event.inputTokens === 4 && event.outputTokens === 2));
    if (fixture.name === 'Responses') { assert.equal(body.include, undefined); assert.deepEqual(body.reasoning, { effort: 'high' }); }
    if (fixture.name === 'OpenAICompatible') assert.equal(body.reasoning_effort, 'high');
    if (fixture.name === 'Anthropic') assert.deepEqual(body.thinking, { type: 'adaptive', display: 'omitted' });
  });

  test(`${fixture.name} validates malicious host shape synchronously with zero fetch and getter reads`, () => {
    let fetched = 0, read = 0;
    const adapter = fixture.adapter(async () => { fetched++; throw new Error('Unexpected fixture fetch.'); });
    const invalid = Object.defineProperty(request(), 'tools', { enumerable: true, get() { read++; return []; } });
    assert.throws(() => Reflect.apply(adapter.streamGeneration, adapter, [invalid, signal()]), code('PROVIDER_INVALID_REQUEST'));
    assert.equal(fetched, 0); assert.equal(read, 0);
  });

  test(`${fixture.name} snapshots caller request before streaming`, async () => {
    let sent!: Wire;
    const adapter = fixture.adapter(async (_url, init) => { sent = JSON.parse(String(init?.body)); return response(fixture.wire('answer')); });
    const input = request(), iterable = adapter.streamGeneration(input, signal());
    Object.assign(input, { modelId: 'changed', messages: [{ role: 'user', content: 'changed' }], tools: [{ name: 'run_command' }] });
    await collect(iterable);
    assert.equal(sent.model, 'explicit-fixture-model'); assert.equal(sent.tools, undefined); assert.ok(!JSON.stringify(sent).includes('changed'));
  });

  test(`${fixture.name} native unsolicited tools do not escape host generation`, async () => {
    const adapter = fixture.adapter(async () => response(fixture.wire('', true))), observed: ProviderEvent[] = [];
    await assert.rejects(async () => { for await (const event of adapter.streamGeneration(request(), signal())) observed.push(event); }, code('PROVIDER_UNSUPPORTED_OUTPUT'));
    assert.equal(observed.some(event => event.type === 'tool.call' || event.type === 'finish'), false);
  });

  test(`${fixture.name} early return confirms actual body cleanup and removes original signal listeners`, async () => {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(fixture.wire('partial observed output'))); }, cancel() { cancelled++; } });
    const abort = new AbortController(), before = getEventListeners(abort.signal, 'abort').length;
    const iterator = fixture.adapter(async () => response(stream)).streamGeneration(request(), abort.signal)[Symbol.asyncIterator]();
    let next = await iterator.next(); while (!next.done && next.value.type !== 'text.delta') next = await iterator.next();
    assert.equal(next.done, false); assert.ok(iterator.return);
    const closed = await iterator.return(); assert.equal(closed.done, true); assert.equal(cancelled, 1); assert.equal(stream.locked, false);
    assert.equal(getEventListeners(abort.signal, 'abort').length, before);
  });

  for (const mode of ['reject', 'stall'] as const) test(`${fixture.name} ${mode} body cancellation cannot produce finish or cleanup proof`, async () => {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(fixture.wire('observed answer'))); }, cancel() { cancelled++; return mode === 'reject' ? Promise.reject(new Error(SECRET)) : new Promise<void>(() => {}); } });
    const observed: ProviderEvent[] = [];
    await assert.rejects(async () => { for await (const event of fixture.adapter(async () => response(stream)).streamGeneration(request(), signal())) observed.push(event); }, code('CLEANUP_UNCERTAIN'));
    assert.equal(cancelled, 1); assert.equal(observed.some(event => event.type === 'finish'), false);
    assert.ok(!JSON.stringify(observed).includes(SECRET)); assert.equal(stream.locked, false);
  });

  test(`${fixture.name} cancellation during read aborts actual producer and confirms one cleanup`, async () => {
    let started!: () => void, cancelled = 0;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const stream = new ReadableStream<Uint8Array>({ pull() { started(); }, cancel() { cancelled++; } });
    const abort = new AbortController();
    const outcome = collect(fixture.adapter(async () => response(stream)).streamGeneration(request(), abort.signal));
    await reading; abort.abort(new Error(SECRET));
    await assert.rejects(outcome, code('PROVIDER_CANCELLED')); assert.equal(cancelled, 1); assert.equal(stream.locked, false);
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  });

  test(`${fixture.name} pre-aborted generation performs zero HTTP requests`, async () => {
    let fetched = 0; const abort = new AbortController(); abort.abort(new Error(SECRET));
    await assert.rejects(collect(fixture.adapter(async () => { fetched++; throw new Error(SECRET); }).streamGeneration(request(), abort.signal)), code('PROVIDER_CANCELLED'));
    assert.equal(fetched, 0);
  });

  for (const status of [200, 429, 400]) test(`${fixture.name} invalid content/HTTP ${status} cannot conceal failed physical cleanup`, async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(status === 400 ? 'x'.repeat(8_193) : 'private malformed response')); }, cancel() { cancelled++; throw new Error(SECRET); } });
    const adapter = fixture.adapter(async () => new Response(body, { status, headers: { 'Content-Type': 'application/json' } }));
    await assert.rejects(collect(adapter.streamGeneration(request(), signal())), code('CLEANUP_UNCERTAIN'));
    assert.equal(cancelled, 1); assert.equal(body.locked, false);
  });

  test(`${fixture.name} pending fetch cannot masquerade as completed iterator cleanup after cancellation`, async () => {
    let start!: () => void, release!: (value: Response) => void, cancelled = 0, settled = false;
    const started = new Promise<void>(resolve => { start = resolve; });
    const fetching = new Promise<Response>(resolve => { release = resolve; });
    const abort = new AbortController();
    const iterator = fixture.adapter(async () => { start(); return fetching; }).streamGeneration(request(), abort.signal)[Symbol.asyncIterator]();
    const next = iterator.next(); void next.then(() => { settled = true; }, () => { settled = true; });
    await started; abort.abort(new Error(SECRET));
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, false);
    assert.ok(iterator.return); const closing = iterator.return(); let closed = false; void closing.then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed, false);
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
    release(response(body));
    await assert.rejects(next, code('PROVIDER_CANCELLED')); assert.equal((await closing).done, true);
    assert.equal(cancelled, 1); assert.equal(body.locked, false); assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  });
}

test('Codex generation uses only fixed origin and fixture credentials after validation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-generation-codex-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: SECRET, refresh_token: 'fixture-refresh', id_token: 'fixture-id', account_id: 'fixture-account' } }), { mode: 0o600 });
  let fetched = 0;
  const adapter = new CodexProvider({ codexHome: directory, fetch: async (url, init) => {
    fetched++; assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/responses'); assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers); assert.equal(headers.get('Authorization'), `Bearer ${SECRET}`); assert.equal(headers.get('ChatGPT-Account-ID'), 'fixture-account');
    const body: Wire = JSON.parse(String(init?.body)); assert.equal(body.include, undefined); assert.equal(body.tools, undefined); assert.equal(body.instructions, '');
    assert.ok(Array.isArray(body.input)); assert.equal(body.input[0].role, 'developer'); assert.equal(body.input[1].role, 'user');
    assert.ok(!JSON.stringify(body).includes('generation-fixture')); assert.ok(!JSON.stringify(body).includes(SECRET));
    return response(responseWire(`public ${SECRET} answer`));
  } });
  assert.throws(() => Reflect.apply(adapter.streamGeneration, adapter, [{ ...request(), runId: 'fake' }, signal()]), code('PROVIDER_INVALID_REQUEST'));
  assert.equal(fetched, 0);
  const events = await collect(adapter.streamGeneration(request(), signal()));
  assert.equal(fetched, 1); assert.ok(!JSON.stringify(events).includes(SECRET)); assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' });
});

test('invalid Codex host owner fails before missing credential source is consulted', () => {
  const adapter = new CodexProvider({ codexHome: '/tmp/moodcode-generation-auth-must-not-exist', fetch: async () => { throw new Error('Must not dispatch.'); } });
  assert.throws(() => Reflect.apply(adapter.streamGeneration, adapter, [{ ...request(), owner: {} }, signal()]), code('PROVIDER_INVALID_REQUEST'));
});

for (const failedCleanup of [false, true]) test(`Codex generation forwards actual delegate return ${failedCleanup ? 'failure' : 'completion'} after fixed-origin credential use`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-generation-codex-cleanup-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: SECRET, refresh_token: 'fixture-refresh', id_token: 'fixture-id', account_id: 'fixture-account' } }), { mode: 0o600 });
  let cancelled = 0, fetched = 0;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(responseWire('observed partial'))); }, cancel() { cancelled++; if (failedCleanup) throw new Error(SECRET); } });
  const abort = new AbortController();
  const adapter = new CodexProvider({ codexHome: directory, cleanupTimeoutMs: 20, fetch: async (url, init) => { fetched++; assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/responses'); assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${SECRET}`); return response(body); } });
  const iterator = adapter.streamGeneration(request(), abort.signal);
  let event = await iterator.next(); while (!event.done && event.value.type !== 'text.delta') event = await iterator.next();
  assert.equal(event.done, false);
  if (failedCleanup) await assert.rejects(iterator.return(undefined), code('CLEANUP_UNCERTAIN'));
  else assert.equal((await iterator.return(undefined)).done, true);
  assert.equal(fetched, 1); assert.equal(cancelled, 1); assert.equal(body.locked, false); assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('Responses host reasoning and ciphertext remain absent from public generation output', async () => {
  const opaque = 'fixture-ciphertext-never-forwarded', summary = 'fixture-reasoning-never-forwarded';
  const reason: Wire = { id: 'reason-fixture', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: summary }], encrypted_content: opaque };
  const output: Wire = { id: 'msg-fixture', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'visible summary' }] };
  const wire = sse([
    { type: 'response.created', response: { id: 'resp-fixture', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...reason, status: 'in_progress', summary: [] } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'reason-fixture', output_index: 0, summary_index: 0, delta: summary },
    { type: 'response.reasoning_summary_text.done', item_id: 'reason-fixture', output_index: 0, summary_index: 0, text: summary },
    { type: 'response.output_item.done', output_index: 0, item: reason },
    { type: 'response.output_item.added', output_index: 1, item: { ...output, status: 'in_progress', content: [] } },
    { type: 'response.output_text.done', item_id: 'msg-fixture', output_index: 1, content_index: 0, text: 'visible summary' },
    { type: 'response.output_item.done', output_index: 1, item: output },
    { type: 'response.completed', response: { id: 'resp-fixture', status: 'completed', output: [reason, output], usage: { input_tokens: 3, output_tokens: 2, output_tokens_details: { reasoning_tokens: 1 } } } },
  ]);
  const adapter = new ResponsesProvider({ fetch: async (_url, init) => { assert.equal(JSON.parse(String(init?.body)).include, undefined); return response(wire); } });
  const events = await collect(adapter.streamGeneration(request(), signal()));
  assert.equal(text(events), 'visible summary'); assert.equal(events.some(event => event.type === 'reasoning.delta'), false);
  assert.ok(!JSON.stringify(events).includes(opaque)); assert.ok(!JSON.stringify(events).includes(summary));
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' });
  assert.ok(events.some(event => event.type === 'usage' && event.reasoningOutputTokens === 1));
});

test('Responses host metadata and text never reflect injected provider credentials', async () => {
  const adapter = new ResponsesProvider({ apiKey: SECRET, fetch: async () => response(responseWire(`visible ${SECRET}`).replaceAll('resp-fixture', SECRET)) });
  const events = await collect(adapter.streamGeneration(request(), signal()));
  assert.ok(events.some(event => event.type === 'progress')); assert.ok(events.some(event => event.type === 'text.delta'));
  assert.ok(!JSON.stringify(events).includes(SECRET)); assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' });
});

test('Anthropic host reasoning signatures remain private even with a coding public-summary configuration', async () => {
  const opaque = 'fixture-thinking-signature-never-forwarded';
  const events: Wire[] = [
    { type: 'message_start', message: { id: 'msg-fixture', type: 'message', role: 'assistant', model: 'explicit-fixture-model', content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: opaque } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'visible summary' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  const adapter = new AnthropicProvider({ publicReasoningSummary: true, fetch: async (_url, init) => { assert.deepEqual(JSON.parse(String(init?.body)).thinking, { type: 'adaptive', display: 'omitted' }); return response(sse(events)); } });
  const result = await collect(adapter.streamGeneration(request(), signal()));
  assert.equal(text(result), 'visible summary'); assert.equal(result.some(event => event.type === 'reasoning.delta'), false);
  assert.ok(!JSON.stringify(result).includes(opaque)); assert.deepEqual(result.at(-1), { type: 'finish', reason: 'stop' });
});

test('Scripted generation fixtures and counters are independent from coding selection and caller mutation', async () => {
  const generationFixtures = [{ events: [{ type: 'text.delta', delta: 'host-first' }, { type: 'finish', reason: 'stop' }] as ProviderEvent[] }, { events: [{ type: 'text.delta', delta: 'host-second' }] as ProviderEvent[] }];
  const adapter = new ScriptedProvider([{ events: [{ type: 'text.delta', delta: 'coding-only' }] }], generationFixtures);
  generationFixtures[0]!.events.length = 0;
  const first = adapter.streamGeneration(request(), signal());
  assert.equal(adapter.callCount, 0); assert.equal(adapter.generationCallCount, 1);
  const result = await collect(first); assert.equal(text(result), 'host-first');
  const yielded = result[0]!; assert.ok(yielded.type === 'text.delta'); yielded.delta = 'mutated';
  assert.equal(text(await collect(adapter.streamTurn(codingRequest(), signal()))), 'coding-only');
  assert.equal(text(await collect(adapter.streamGeneration(request(), signal()))), 'host-second');
  assert.equal(adapter.callCount, 1); assert.equal(adapter.generationCallCount, 2);
});

test('Scripted host snapshot/default echo never requires turnIndex and preserves cancellation', async () => {
  const adapter = new ScriptedProvider(), input = request(), iterable = adapter.streamGeneration(input, signal());
  Object.assign(input, { messages: [{ role: 'user', content: 'changed' }] });
  assert.equal(text(await collect(iterable)), 'Received: Source fixture.');
  const abort = new AbortController(); abort.abort(new Error(SECRET));
  await assert.rejects(collect(adapter.streamGeneration(request(), abort.signal)), { name: 'AbortError', message: 'Scripted provider request cancelled.' });
  assert.equal(adapter.callCount, 0); assert.equal(adapter.generationCallCount, 2);
  assert.throws(() => Reflect.apply(adapter.streamGeneration, adapter, [{ ...request(), tools: ['tool'] }, signal()]), code('PROVIDER_INVALID_REQUEST'));
  assert.equal(adapter.generationCallCount, 2);
});
