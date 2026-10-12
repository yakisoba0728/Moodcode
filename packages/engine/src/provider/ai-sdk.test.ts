import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AI_SDK_PROVIDERS, EngineError, type AiSdkProviderId } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ProviderEvent, TurnRequest } from '../ports.js';
import { AiSdkProvider } from './ai-sdk.js';

const KEY = 'private-sdk-fixture-key';
const request = (): TurnRequest => ({ runId: 'fixture', turnIndex: 0, modelId: 'fixture-model', messages: [{ role: 'user', content: 'Hello' }], tools: [] });
const sse = (frames: unknown[]) => new Response(frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const chat = (text = 'OK') => sse([
  { id: 'fixture-response', model: 'fixture-model', created: 1, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
  { id: 'fixture-response', model: 'fixture-model', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, x_groq: { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } }, '[DONE]',
]);
const google = (parts: unknown[] = [{ text: 'OK' }]) => sse([{ candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }], responseId: 'fixture-response', usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } }]);
function xai() {
  const item = { type: 'message', id: 'message-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
  return sse([
    { type: 'response.created', response: { id: 'fixture-response', object: 'response', output: [], model: 'fixture-model', created_at: 1 } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'message-1', content_index: 0, delta: 'OK' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'fixture-response', object: 'response', output: [item], status: 'completed', usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
  ]);
}
async function collect(provider: AiSdkProvider, input = request(), signal = new AbortController().signal) {
  const events: ProviderEvent[] = [];
  for await (const event of provider.streamTurn(input, signal)) events.push(event);
  return events;
}
const text = (events: ProviderEvent[]) => events.flatMap(event => event.type === 'text.delta' ? [event.delta] : []).join('');

for (const id of Object.keys(AI_SDK_PROVIDERS) as AiSdkProviderId[]) {
  test(`real ${id} SDK encodes its endpoint and auth and maps text, usage and replay`, async () => {
    let calls = 0;
    const provider = new AiSdkProvider({ providerId: id, apiKey: KEY, fetch: async (url, init) => {
      calls++;
      assert.ok(String(url).startsWith(AI_SDK_PROVIDERS[id].baseURL + '/'));
      assert.equal(init?.redirect, 'error');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get(id === 'google' ? 'x-goog-api-key' : 'authorization'), id === 'google' ? KEY : `Bearer ${KEY}`);
      const body = JSON.parse(String(init?.body));
      assert.ok(!JSON.stringify(body).includes('runId'));
      return id === 'google' ? google() : id === 'xai' ? xai() : chat();
    } });
    const events = await collect(provider);
    assert.equal(text(events), 'OK');
    assert.ok(events.some(event => event.type === 'usage' && event.inputTokens === 5 && event.outputTokens === 2));
    const finish = events.find(event => event.type === 'finish');
    assert.ok(finish?.type === 'finish' && finish.reason === 'stop' && finish.replayItems?.length === 1);
    assert.ok(!JSON.stringify(events).includes(KEY));
    assert.equal(calls, 1);
  });
}

test('SDK tool calls retain Google thought signatures and replay with engine tool results', async () => {
  let calls = 0;
  const provider = new AiSdkProvider({ providerId: 'google', apiKey: KEY, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.ok(body.tools[0].functionDeclarations.some((tool: { name: string }) => tool.name === 'write_fixture'));
    if (++calls === 1) return google([{ text: 'Checking' }, { functionCall: { name: 'write_fixture', args: { value: 'new' } }, thoughtSignature: 'opaque-fixture-signature' }]);
    assert.ok(JSON.stringify(body).includes('opaque-fixture-signature'));
    assert.ok(JSON.stringify(body).includes('engine result'));
    return google();
  } });
  const input = request();
  input.tools = [{ name: 'write_fixture', description: 'Fixture write', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }];
  const first = await collect(provider, input);
  const call = first.find(event => event.type === 'tool.call');
  const finish = first.find(event => event.type === 'finish');
  assert.ok(call?.type === 'tool.call' && finish?.type === 'finish');
  assert.equal(finish.reason, 'tool_calls');
  const next = { ...input, messages: [...input.messages, { role: 'assistant' as const, content: text(first), toolCalls: [call.call], providerReplay: { providerId: provider.id, modelId: input.modelId, protocol: provider.replayProtocol, version: 1, items: finish.replayItems! } }, { role: 'tool' as const, content: 'engine result', toolCallId: call.call.id }] };
  assert.equal(text(await collect(provider, next)), 'OK');
  await assert.rejects(collect(provider, { ...next, modelId: 'another-model' }), { code: 'PROVIDER_INVALID_REPLAY' });
  const tampered = structuredClone(next);
  tampered.messages[1]!.content = 'tampered';
  await assert.rejects(collect(provider, tampered), { code: 'PROVIDER_INVALID_REPLAY' });
  assert.equal(calls, 2);
});

test('SDK errors are sanitized, HTTP retries stay in the engine and request/output bounds are enforced', async () => {
  let calls = 0;
  const errorProvider = new AiSdkProvider({ providerId: 'deepseek', apiKey: KEY, fetch: async () => {
    calls++; return new Response(JSON.stringify({ error: { message: KEY } }), { status: 503, headers: { 'retry-after': '1' } });
  } });
  await assert.rejects(collect(errorProvider), error => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, 'PROVIDER_HTTP_ERROR');
    assert.equal(error.details?.status, 503);
    assert.equal(error.details?.retryAfterMs, 1000);
    assert.ok(!JSON.stringify(error).includes(KEY));
    return true;
  });
  assert.equal(calls, 1, 'SDK must not retry a request');
  const bounded = new AiSdkProvider({ providerId: 'deepseek', apiKey: KEY, maxResponseBytes: 128, fetch: async () => chat('x'.repeat(1000)) });
  await assert.rejects(collect(bounded), { code: 'PROVIDER_LIMIT_EXCEEDED' });
  const small = new AiSdkProvider({ providerId: 'google', apiKey: KEY, maxRequestBytes: 64, fetch: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(collect(small, { ...request(), messages: [{ role: 'user', content: 'x'.repeat(200) }] }), { code: 'PROVIDER_LIMIT_EXCEEDED' });
  assert.throws(() => new AiSdkProvider({ providerId: 'google', apiKey: KEY, baseURL: 'http://remote.invalid/v1' }), { code: 'PROVIDER_INVALID_CONFIG' });
  const events = await collect(new AiSdkProvider({ providerId: 'deepseek', apiKey: KEY, fetch: async () => chat(`prefix ${KEY} suffix`) }));
  assert.equal(text(events), 'prefix [REDACTED] suffix');
  assert.ok(!JSON.stringify(events).includes(KEY));
});

test('SDK cancellation closes an owned body; a hanging cancel or fetch stays uncertain', { timeout: 5000 }, async () => {
  for (const hangs of [false, true]) {
    const abort = new AbortController();
    let closed = false, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const provider = new AiSdkProvider({ providerId: 'deepseek', apiKey: KEY, cleanupTimeoutMs: 30, fetch: async () => {
      started();
      return new Response(new ReadableStream({ cancel() { closed = true; return hangs ? new Promise<void>(() => {}) : undefined; } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
    const pending = collect(provider, request(), abort.signal);
    await ready;
    await new Promise(resolve => setImmediate(resolve));
    abort.abort();
    await assert.rejects(pending, { code: hangs ? 'CLEANUP_UNCERTAIN' : 'PROVIDER_CANCELLED' });
    assert.equal(closed, true);
  }
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const abort = new AbortController();
  const provider = new AiSdkProvider({ providerId: 'deepseek', apiKey: KEY, cleanupTimeoutMs: 30, fetch: () => { started(); return new Promise<Response>(() => {}); } });
  const pending = collect(provider, request(), abort.signal);
  await ready; abort.abort();
  await assert.rejects(pending, { code: 'CLEANUP_UNCERTAIN' });
});

test('SDK engine loop requires approval, persists replay and never executes a duplicate request', { timeout: 10000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-sdk-')));
  let calls = 0, effects = 0;
  const provider = new AiSdkProvider({ providerId: 'google', apiKey: KEY, fetch: async (_url, init) => {
    if (++calls === 1) return google([{ functionCall: { name: 'write_fixture', args: { value: 'new' } }, thoughtSignature: 'fixture-signature' }]);
    assert.ok(String(init?.body).includes('fixture-signature'));
    assert.ok(String(init?.body).includes('engine result'));
    return google();
  } });
  const options: import('../engine.js').EngineOptions = { dbPath: join(root, 'engine.sqlite'), artifactDir: join(root, 'artifacts'), providers: [provider],
    tools: [{ name: 'write_fixture', description: 'Fixture effect', effectClass: 'write', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      async prepare(input) { return { name: 'write_fixture', input: input as import('@moodcode/contracts').JsonValue, fingerprint: 'fixture-fingerprint', requiresApproval: true, preview: {} }; },
      async execute() { effects++; return { content: 'engine result' }; } }],
    defaults: { providerId: 'google', modelId: 'fixture-model', mode: 'build' } };
  let engine = createEngine(options);
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const createdAt = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'SDK', createdAt });
  const input = { sessionId: 'session', requestId: 'same-request', prompt: 'Write fixture', config: engine.getCapabilities().defaults };
  const receipt = engine.coordinator.submit(input);
  const subscription = engine.subscribe('session', 0)[Symbol.asyncIterator]();
  while (true) {
    const event = await subscription.next();
    assert.ok(!event.done);
    if (event.value.type === 'run.failed' || event.value.type === 'run.completed' || event.value.type === 'run.cancelled') {
      assert.fail(JSON.stringify(engine.store.getRun(receipt.runId)));
    }
    if (event.value.type === 'approval.requested') {
      assert.equal(effects, 0);
      const approval = engine.store.listPendingRunApprovals(receipt.runId)[0]!;
      engine.approvals.decide(approval.id, 'allow', approval.fingerprint);
      break;
    }
  }
  await subscription.return?.();
  const run = await engine.waitForRun(receipt.runId);
  assert.equal(run.state, 'completed', JSON.stringify(run.error));
  assert.equal(effects, 1); assert.equal(calls, 2);
  const duplicate = engine.coordinator.submit(input);
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.runId, receipt.runId);
  assert.equal(calls, 2); assert.equal(effects, 1);
  assert.ok(!JSON.stringify(engine.store.getSnapshot('session')).includes(KEY));
  await engine.close(); engine = createEngine(options);
  const continued = engine.coordinator.submit({ ...input, requestId: 'after-restart', prompt: 'Continue' });
  assert.equal((await engine.waitForRun(continued.runId)).state, 'completed');
  assert.equal(calls, 3); assert.equal(effects, 1, 'Reopening must not replay a committed effect');
});

test('unconfirmed SDK cancellation persists recovery quarantine and prevents requests after restart', { timeout: 10000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-sdk-recovery-')));
  let started!: () => void, calls = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const provider = new AiSdkProvider({ providerId: 'deepseek', apiKey: KEY, cleanupTimeoutMs: 30, fetch: () => { calls++; started(); return new Promise<Response>(() => {}); } });
  const options = { dbPath: join(root, 'engine.sqlite'), artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: [], defaults: { providerId: 'deepseek', modelId: 'fixture-model', mode: 'plan' as const } };
  let engine = createEngine(options);
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const createdAt = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Recovery', createdAt });
  const input = { sessionId: 'session', requestId: 'cancel-request', prompt: 'Wait', config: engine.getCapabilities().defaults };
  const receipt = engine.coordinator.submit(input);
  await ready; engine.coordinator.cancel(receipt.runId);
  const run = await engine.waitForRun(receipt.runId);
  assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN');
  assert.equal(engine.store.listTurns(run.id)[0]!.state, 'uncertain');
  await engine.close(); engine = createEngine(options);
  assert.equal(engine.store.getSessionControl('session').reason, 'recovery_required');
  assert.throws(() => engine.coordinator.submit({ ...input, requestId: 'blocked-request' }), { code: 'CLEANUP_PENDING' });
  assert.equal(calls, 1);
});
