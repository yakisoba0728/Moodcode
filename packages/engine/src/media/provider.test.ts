import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { AnthropicProvider } from '../provider/anthropic.js';
import { CodexProvider } from '../provider/codex.js';
import { OpenAICompatibleProvider } from '../provider/openai-compatible.js';
import { ResponsesProvider } from '../provider/responses.js';
import { ScriptedProvider } from '../provider/scripted.js';
import { providerImages } from './provider.js';
import { gif, imageFixture, jpeg, png, pngChunk, webp } from './fixtures.js';

const image = imageFixture();
function request(): TurnRequest { return { sessionId: 'fixture-session', runId: 'fixture-run', turnIndex: 0, modelId: 'fixture-model', messages: [{ role: 'user', content: 'Describe local image', attachments: [{ ...image.attachment }] }], tools: [], resolvedImages: [structuredClone(image)] }; }
function frames(events: Record<string, unknown>[]): string { return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''); }
const responses = frames([{ type: 'response.created', response: { id: 'response-image-fixture', status: 'in_progress' } }, { type: 'response.completed', response: { id: 'response-image-fixture', status: 'completed', output: [] } }]);
const anthropic = frames([{ type: 'message_start', message: { id: 'message-image-fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }, { type: 'message_stop' }]);
const chat = frames([{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]) + 'data: [DONE]\n\n';
async function collect(adapter: ProviderAdapter, input = request(), signal = new AbortController().signal): Promise<ProviderEvent[]> { const events: ProviderEvent[] = []; for await (const event of adapter.streamTurn(input, signal)) events.push(event); return events; }
function code(expected: string) { return (error: unknown) => { assert.ok(error instanceof EngineError); assert.equal(error.code, expected); assert.equal(error.cause, undefined); assert.ok(!JSON.stringify(error).includes(image.data)); return true; }; }
const adapters = [
  { name: 'Responses', wire: responses, make: (fetch: typeof globalThis.fetch) => new ResponsesProvider({ fetch }) },
  { name: 'ChatCompletions', wire: chat, make: (fetch: typeof globalThis.fetch) => new OpenAICompatibleProvider({ fetch }) },
  { name: 'Anthropic', wire: anthropic, make: (fetch: typeof globalThis.fetch) => new AnthropicProvider({ fetch, thinking: 'disabled' }) },
];

for (const spec of adapters) test(`${spec.name} emits verified user image blocks while preserving non-image history`, async () => {
  const bodies: Record<string, unknown>[] = []; const input = request(), before = structuredClone(input);
  input.messages.unshift({ role: 'system', content: 'local system' });
  const adapter = spec.make(async (_url, init) => { bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return new Response(spec.wire, { headers: { 'Content-Type': 'text/event-stream' } }); });
  assert.deepEqual(adapter.inputModalities, ['text', 'image']); await collect(adapter, input);
  assert.deepEqual(input.messages[1], before.messages[0]); assert.deepEqual(input.resolvedImages, before.resolvedImages);
  const blocks = spec.name === 'Responses' ? (bodies[0]!.input as { role: string; content: unknown }[]) : (bodies[0]!.messages as { role: string; content: unknown }[]);
  const user = blocks.find(item => item.role === 'user')!;
  assert.deepEqual(user.content, spec.name === 'Responses' ? [{ type: 'input_image', image_url: `data:image/png;base64,${image.data}`, detail: 'auto' }, { type: 'input_text', text: 'Describe local image' }]
    : spec.name === 'ChatCompletions' ? [{ type: 'image_url', image_url: { url: `data:image/png;base64,${image.data}`, detail: 'auto' } }, { type: 'text', text: 'Describe local image' }]
      : [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data } }, { type: 'text', text: 'Describe local image' }]);
  assert.ok(!JSON.stringify(bodies[0]).includes(image.attachment.id)); assert.ok(!JSON.stringify(bodies[0]).includes(image.attachment.sha256));
});

for (const spec of adapters) test(`${spec.name} accepts image-only user input and preserves text-only string/block encoding`, async () => {
  const bodies: Record<string, unknown>[] = [], adapter = spec.make(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(spec.wire, { headers: { 'Content-Type': 'text/event-stream' } }); });
  const input = request(); input.messages[0]!.content = ''; await collect(adapter, input);
  const plain = request(); delete plain.resolvedImages; delete plain.sessionId; delete plain.messages[0]!.attachments; await collect(adapter, plain);
  const messages = (spec.name === 'Responses' ? bodies[1]!.input : bodies[1]!.messages) as { content: unknown }[];
  assert.deepEqual(messages[0]!.content, spec.name === 'Anthropic' ? [{ type: 'text', text: 'Describe local image' }] : 'Describe local image');
});

const malformed: { name: string; mutate(input: TurnRequest): void }[] = [
  { name: 'unresolved ref', mutate: input => { delete input.resolvedImages; } },
  { name: 'missing session boundary', mutate: input => { delete input.sessionId; } },
  { name: 'different resolved id', mutate: input => { input.resolvedImages![0]!.attachment.id = 'img_' + 'b'.repeat(32); } },
  { name: 'hash mismatch', mutate: input => { input.resolvedImages![0]!.attachment.sha256 = '0'.repeat(64); } },
  { name: 'decoded byte mismatch', mutate: input => { input.resolvedImages![0]!.data = Buffer.alloc(image.attachment.bytes).toString('base64'); } },
  { name: 'noncanonical base64 whitespace', mutate: input => { input.resolvedImages![0]!.data += '\n'; } },
  { name: 'remote URL substituted for bytes', mutate: input => { input.resolvedImages![0]!.data = 'https://untrusted.invalid/image.png'; } },
  { name: 'data URL substituted for base64', mutate: input => { input.resolvedImages![0]!.data = `data:image/png;base64,${image.data}`; } },
  { name: 'extra resolved attachment', mutate: input => { input.resolvedImages!.push(structuredClone(image)); } },
  { name: 'extra ref property/path', mutate: input => { (input.messages[0]!.attachments![0]! as unknown as Record<string, unknown>).path = '/private/host.png'; } },
  { name: 'unsupported media kind', mutate: input => { (input.messages[0]!.attachments![0]! as unknown as Record<string, unknown>).kind = 'audio'; } },
  { name: 'mime mismatch despite hash match', mutate: input => { input.messages[0]!.attachments![0]!.mimeType = 'image/jpeg'; input.resolvedImages![0]!.attachment.mimeType = 'image/jpeg'; } },
  { name: 'animated PNG', mutate: input => { const animated = imageFixture(png(1, 1, pngChunk('acTL', Buffer.alloc(8)))); input.messages[0]!.attachments = [animated.attachment]; input.resolvedImages = [animated]; } },
  { name: 'non-user image', mutate: input => { input.messages[0]!.role = 'system'; } },
];
for (const sample of malformed) test(`all HTTP adapters reject ${sample.name} before dispatch`, async () => {
  for (const spec of adapters) { let dispatched = false; const adapter = spec.make(async () => { dispatched = true; throw new Error('must not dispatch'); }); const input = request(); sample.mutate(input);
    await assert.rejects(collect(adapter, input), code('PROVIDER_INVALID_REQUEST')); assert.equal(dispatched, false, spec.name); }
});
test('public projection has hard image count/decoded byte budgets and rejects unused resolved bytes', () => {
  const input = request(); input.messages[0]!.attachments = Array(5).fill(image.attachment);
  assert.throws(() => providerImages(input, true), code('PROVIDER_LIMIT_EXCEEDED'));
  input.messages[0]!.attachments = []; assert.throws(() => providerImages(input, true), code('PROVIDER_INVALID_REQUEST'));
  const larger = ['a', 'b', 'c'].map(digit => imageFixture(png(1, 1, pngChunk('tEXt', Buffer.alloc(360_000))), 'image/png', digit)); const bulk = request(); bulk.messages[0]!.attachments = larger.map(item => item.attachment); bulk.resolvedImages = larger;
  assert.throws(() => providerImages(bulk, true), code('PROVIDER_LIMIT_EXCEEDED'));
});
test('same verified reference can appear in multiple user messages; resolved data remains deduplicated', async () => {
  const input = request(); input.messages.push({ role: 'assistant', content: 'Earlier observation' }, structuredClone(input.messages[0]!));
  assert.equal(providerImages(input, true).size, 1);
  input.messages[2]!.attachments![0]!.sha256 = 'f'.repeat(64); assert.throws(() => providerImages(input, true), code('PROVIDER_INVALID_REQUEST'));
});
test('scripted adapter explicitly rejects image input; cancellation emits nothing', async () => {
  const adapter = new ScriptedProvider(); assert.deepEqual(adapter.inputModalities, ['text']); await assert.rejects(collect(adapter), code('PROVIDER_UNSUPPORTED_INPUT'));
  const aborted = new AbortController(); aborted.abort('PRIVATE_ABORT');
  for (const spec of adapters) await assert.rejects(collect(spec.make(async () => { throw new Error('must not dispatch'); }), request(), aborted.signal), code('PROVIDER_CANCELLED'));
});
test('Codex fixture uses the fixed Responses route and image encoding without changing host credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-codex-image-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const tokens = { access_token: 'fixture-image-access-token', refresh_token: 'fixture-image-refresh-token', id_token: 'fixture-image-id-token', account_id: 'fixture-image-account' };
  await writeFile(join(directory, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens }), { mode: 0o600 });
  let called = false; const adapter = new CodexProvider({ codexHome: directory, fetch: async (url, init) => {
    called = true; assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/responses'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${tokens.access_token}`);
    const body = JSON.parse(String(init?.body)); assert.equal(body.input[0].content[0].image_url, `data:image/png;base64,${image.data}`); assert.ok(!String(init?.body).includes(tokens.access_token));
    return new Response(responses, { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  assert.deepEqual(adapter.inputModalities, ['text', 'image']); const events = await collect(adapter); assert.equal(called, true);
  assert.ok(!JSON.stringify(events).includes(image.data)); assert.ok(!JSON.stringify(events).includes(tokens.access_token));
});
test('Codex rejects invalid image data before consulting even a missing credential fixture', async () => {
  const input = request(); input.resolvedImages![0]!.data = 'not-image';
  const adapter = new CodexProvider({ codexHome: '/path-that-does-not-exist/moodcode-fixture', fetch: async () => { throw new Error('must not dispatch'); } });
  await assert.rejects(collect(adapter, input), code('PROVIDER_INVALID_REQUEST'));
});
test('ChatCompletions media output is explicitly unsupported instead of silently dropped', async () => {
  for (const key of ['audio', 'image', 'images', 'video']) { const output = frames([{ choices: [{ index: 0, delta: { [key]: { data: 'fixture-output-media' } }, finish_reason: 'stop' }] }]) + 'data: [DONE]\n\n';
    const adapter = new OpenAICompatibleProvider({ fetch: async () => new Response(output, { headers: { 'Content-Type': 'text/event-stream' } }) }); await assert.rejects(collect(adapter), code('PROVIDER_UNSUPPORTED_OUTPUT')); }
});
test('Responses and Anthropic output image blocks remain explicitly unsupported', async () => {
  const output = frames([{ type: 'response.created', response: { id: 'response-image-fixture', status: 'in_progress' } }, { type: 'response.output_item.added', output_index: 0, item: { id: 'image-output', type: 'image_generation_call', status: 'in_progress' } }]);
  await assert.rejects(collect(new ResponsesProvider({ fetch: async () => new Response(output, { headers: { 'Content-Type': 'text/event-stream' } }) })), code('PROVIDER_UNSUPPORTED_OUTPUT'));
  const blocks = frames([{ type: 'message_start', message: { id: 'message-image-fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data } } }]);
  await assert.rejects(collect(new AnthropicProvider({ fetch: async () => new Response(blocks, { headers: { 'Content-Type': 'text/event-stream' } }), thinking: 'disabled' })), code('PROVIDER_UNSUPPORTED_OUTPUT'));
});
test('all supported MIME containers keep the verified MIME and bytes in each vendor encoding', async () => {
  for (const [mimeType, data] of [['image/png', png()], ['image/jpeg', jpeg()], ['image/gif', gif()], ['image/webp', webp()]] as const) for (const spec of adapters) {
    const localImage = imageFixture(data, mimeType), input = request(); input.messages[0]!.attachments = [localImage.attachment]; input.resolvedImages = [localImage];
    let payload = ''; await collect(spec.make(async (_url, init) => { payload = String(init?.body); return new Response(spec.wire, { headers: { 'Content-Type': 'text/event-stream' } }); }), input);
    assert.ok(payload.includes(spec.name === 'Anthropic' ? '"media_type":"' + mimeType + '"' : `data:${mimeType};base64,`)); assert.ok(payload.includes(localImage.data));
  }
});
test('decoded valid images still respect the whole serialized request ceiling before HTTP', async () => {
  const constructors = [ResponsesProvider, OpenAICompatibleProvider, AnthropicProvider];
  for (const Adapter of constructors) { let dispatched = false; const adapter = new Adapter({ maxRequestBytes: 64, fetch: async () => { dispatched = true; throw new Error('must not dispatch'); } });
    await assert.rejects(collect(adapter), code('PROVIDER_LIMIT_EXCEEDED')); assert.equal(dispatched, false); }
});
test('resolved entry accessors and duplicate user refs are invalid without invoking getters', () => {
  const input = request(); let accessed = false;
  Object.defineProperty(input.resolvedImages![0]!, 'data', { enumerable: true, get() { accessed = true; return image.data; } });
  assert.throws(() => providerImages(input, true), code('PROVIDER_INVALID_REQUEST')); assert.equal(accessed, false);
  const duplicates = request(); duplicates.messages[0]!.attachments!.push({ ...image.attachment }); assert.throws(() => providerImages(duplicates, true), code('PROVIDER_INVALID_REQUEST'));
});
test('empty resolved images do not change existing text-only request behavior', async () => {
  for (const spec of adapters) { const input = request(); delete input.sessionId; delete input.messages[0]!.attachments; input.resolvedImages = [];
    await collect(spec.make(async () => new Response(spec.wire, { headers: { 'Content-Type': 'text/event-stream' } })), input); }
});
