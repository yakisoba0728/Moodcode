import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import type { ProviderAdapter, ProviderEvent, ResolvedInputDocument, TurnRequest } from '../ports.js';
import { imageFixture, png, pngChunk } from '../media/fixtures.js';
import { AnthropicProvider } from '../provider/anthropic.js';
import { CodexProvider } from '../provider/codex.js';
import { OpenAICompatibleProvider } from '../provider/openai-compatible.js';
import { ResponsesProvider } from '../provider/responses.js';
import { ScriptedProvider } from '../provider/scripted.js';
import { hasDocumentInputs, providerDocuments } from './provider.js';

// Authored transport fixture. Signature acceptance is not PDF parser validation.
function pdf(bytes = 96): Buffer {
  const result = Buffer.alloc(bytes, 0x20); result.write('%PDF-1.7\n% Moodcode document fixture\n');
  result.write('\n%%EOF\n', result.length - 7); return result;
}
function document(bytes = pdf(), digit = 'a'): ResolvedInputDocument {
  return { attachment: { id: 'doc_' + digit.repeat(32), kind: 'document', mimeType: 'application/pdf', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }, data: bytes.toString('base64') };
}
function request(): TurnRequest {
  const file = document(); return { runId: 'run', sessionId: 'session', modelId: 'fixture-pdf', turnIndex: 0, tools: [],
    messages: [{ role: 'user', content: 'Inspect this imported document', documents: [file.attachment] }], resolvedDocuments: [structuredClone(file)] };
}
function code(expected: string): (error: unknown) => boolean {
  return error => { assert.ok(error instanceof EngineError); assert.equal(error.code, expected); assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes(document().data)); return true; };
}
async function collect(adapter: ProviderAdapter, input = request(), signal = new AbortController().signal): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = []; for await (const event of adapter.streamTurn(input, signal)) events.push(event); return events;
}
const frames = (events: Record<string, unknown>[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
const done = frames([{ type: 'response.created', response: { id: 'doc-response', status: 'in_progress' } },
  { type: 'response.completed', response: { id: 'doc-response', status: 'completed', output: [] } }]);

test('document projection verifies exact references and keeps the input immutable', () => {
  const input = request(), before = structuredClone(input); const projected = providerDocuments(input, true);
  assert.deepEqual([...projected.values()], input.resolvedDocuments); assert.deepEqual(input, before);
  projected.get(input.messages[0]!.documents![0]!.id)!.attachment.sha256 = 'b'.repeat(64);
  assert.deepEqual(input, before); assert.equal(hasDocumentInputs(input), true);
});

const malformed: { name: string; mutate(input: TurnRequest): void }[] = [
  { name: 'missing resolution', mutate: input => { delete input.resolvedDocuments; } },
  { name: 'missing session boundary', mutate: input => { delete input.sessionId; } },
  { name: 'missing reference', mutate: input => { input.messages[0]!.documents = []; } },
  { name: 'different resolution identity', mutate: input => { input.resolvedDocuments![0]!.attachment.id = 'doc_' + 'b'.repeat(32); } },
  { name: 'different reference hash', mutate: input => { input.resolvedDocuments![0]!.attachment.sha256 = 'f'.repeat(64); } },
  { name: 'tampered decoded data', mutate: input => { input.resolvedDocuments![0]!.data = pdf(96).fill(0).toString('base64'); } },
  { name: 'noncanonical base64', mutate: input => { input.resolvedDocuments![0]!.data += '\n'; } },
  { name: 'remote URL data', mutate: input => { input.resolvedDocuments![0]!.data = 'https://foreign.invalid/document.pdf'; } },
  { name: 'data URL instead of base64', mutate: input => { input.resolvedDocuments![0]!.data = 'data:application/pdf;base64,' + input.resolvedDocuments![0]!.data; } },
  { name: 'raw filename field', mutate: input => { Object.assign(input.messages[0]!.documents![0]!, { filename: '/private/local.pdf' }); } },
  { name: 'non-document kind', mutate: input => { Object.assign(input.messages[0]!.documents![0]!, { kind: 'file' }); } },
  { name: 'non-PDF MIME', mutate: input => { Object.assign(input.messages[0]!.documents![0]!, { mimeType: 'text/html' }); } },
  { name: 'unused second resolution', mutate: input => { input.resolvedDocuments!.push(document(pdf(), 'b')); } },
  { name: 'truncated resolved bytes', mutate: input => { input.resolvedDocuments![0]!.data = Buffer.from('%PDF-1.7\n').toString('base64'); } },
  { name: 'invalid signature with exact SHA', mutate: input => { const file = document(Buffer.alloc(96)); input.messages[0]!.documents = [file.attachment]; input.resolvedDocuments = [file]; } },
];
for (const sample of malformed) test(`document projection rejects ${sample.name}`, async () => {
  const input = request(); sample.mutate(input); assert.throws(() => providerDocuments(input, true), code('PROVIDER_INVALID_REQUEST'));
  let calls = 0; const adapter = new ResponsesProvider({ pdfModelIds: ['fixture-pdf'], allowUnknownDocumentTokenCost: true,
    fetch: async () => { calls++; return new Response(done, { headers: { 'Content-Type': 'text/event-stream' } }); } });
  await assert.rejects(collect(adapter, input), code('PROVIDER_INVALID_REQUEST')); assert.equal(calls, 0);
});
for (const role of ['assistant', 'system', 'tool'] as const) test(`PDF references on ${role} messages cannot be sent`, () => {
  const input = request(); input.messages[0]!.role = role; assert.throws(() => providerDocuments(input, true), code('PROVIDER_INVALID_REQUEST'));
});

test('one document occurrence applies to repeated historical references, not just blob count', () => {
  const input = request(); input.messages.push({ role: 'assistant', content: 'Earlier turn' }, structuredClone(input.messages[0]!));
  assert.equal(input.resolvedDocuments!.length, 1);
  assert.throws(() => providerDocuments(input, true), code('PROVIDER_LIMIT_EXCEEDED'));
});
test('the document cap combines decoded image occurrences and PDF bytes before HTTP', async () => {
  const file = document(pdf(400_000)), images = ['a', 'b'].map(digit => imageFixture(png(1, 1, pngChunk('tEXt', Buffer.alloc(360_000))), 'image/png', digit));
  const input = request(); input.messages[0]!.documents = [file.attachment]; input.resolvedDocuments = [file];
  input.messages[0]!.attachments = images.map(image => image.attachment); input.resolvedImages = images;
  assert.ok(file.attachment.bytes <= 524_288 && images.reduce((sum, image) => sum + image.attachment.bytes, 0) <= 1_048_576);
  assert.throws(() => providerDocuments(input, true), code('PROVIDER_LIMIT_EXCEEDED'));
  let calls = 0; await assert.rejects(collect(new ResponsesProvider({ pdfModelIds: ['fixture-pdf'], allowUnknownDocumentTokenCost: true,
    fetch: async () => { calls++; throw new Error('No oversized dispatch'); } }), input), code('PROVIDER_LIMIT_EXCEEDED')); assert.equal(calls, 0);
});

test('document and resolution accessors or Proxies are rejected without invoking traps', () => {
  for (const boundary of ['ref', 'resolved', 'list', 'request'] as const) {
    let reads = 0; const input = request();
    if (boundary === 'ref') Object.defineProperty(input.messages[0]!.documents![0]!, 'sha256', { enumerable: true, get: () => { reads++; return 'a'.repeat(64); } });
    if (boundary === 'resolved') Object.defineProperty(input.resolvedDocuments![0]!, 'data', { enumerable: true, get: () => { reads++; return document().data; } });
    if (boundary === 'list') input.messages[0]!.documents = new Proxy(input.messages[0]!.documents!, { get: () => { reads++; throw new Error('trap'); } });
    const supplied = boundary === 'request' ? new Proxy(input, { get: () => { reads++; throw new Error('trap'); } }) : input;
    assert.throws(() => providerDocuments(supplied, true), code('PROVIDER_INVALID_REQUEST')); assert.equal(reads, 0, boundary);
  }
});

test('empty document fields preserve the ordinary text projection and session optionality', () => {
  const input = request(); input.messages[0]!.documents = []; input.resolvedDocuments = []; delete input.sessionId;
  assert.equal(providerDocuments(input, false).size, 0); assert.equal(hasDocumentInputs(input), false);
});
const unsupported = [
  { name: 'Codex', make: (fetch: typeof globalThis.fetch) => new CodexProvider({ codexHome: '/nonexistent/moodcode-document-fixture', fetch }) },
  { name: 'Anthropic', make: (fetch: typeof globalThis.fetch) => new AnthropicProvider({ fetch, thinking: 'disabled' }) },
  { name: 'Chat Compatible', make: (fetch: typeof globalThis.fetch) => new OpenAICompatibleProvider({ fetch }) },
  { name: 'Scripted', make: (_fetch: typeof globalThis.fetch) => new ScriptedProvider() },
];
for (const spec of unsupported) test(`${spec.name} rejects PDF before fetch or Codex credential lookup`, async () => {
  let calls = 0; const adapter = spec.make(async () => { calls++; throw new Error('Unsupported transport'); });
  assert.deepEqual(adapter.inputFileTypes, []); await assert.rejects(collect(adapter), code('PROVIDER_UNSUPPORTED_INPUT')); assert.equal(calls, 0);
  const controller = new AbortController(); controller.abort('PRIVATE_DOCUMENT_REASON');
  await assert.rejects(collect(adapter, request(), controller.signal), error => {
    assert.ok(error instanceof Error); assert.ok(!JSON.stringify(error).includes('PRIVATE_DOCUMENT_REASON'));
    return error instanceof EngineError ? error.code === 'PROVIDER_CANCELLED' : error.name === 'AbortError';
  });
});

test('PDF remains input-only; file output is rejected without executable output or media events', async () => {
  const output = frames([{ type: 'response.created', response: { id: 'doc-response', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'file', id: 'generated-file', status: 'in_progress' } }]);
  await assert.rejects(collect(new ResponsesProvider({ pdfModelIds: ['fixture-pdf'], allowUnknownDocumentTokenCost: true,
    fetch: async () => new Response(output, { headers: { 'Content-Type': 'text/event-stream' } }) })), code('PROVIDER_UNSUPPORTED_OUTPUT'));
});
