import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { EngineError, type InputDocumentAttachment, type JsonObject, type Message } from '@moodcode/contracts';
import { createEngine, type EngineOptions } from '../engine.js';
import type { ModelSpec } from '../context/model-spec.js';
import type { ProviderAdapter, TurnRequest } from '../ports.js';
import { DOCUMENT_HISTORY_NOTICE_PREFIX } from '../context/document-history.js';
import { ResponsesProvider, type ResponsesProviderOptions } from '../provider/responses.js';
import { png } from '../media/fixtures.js';
import { wav } from '../media/segment-fixtures.js';
import { exportEngineArchive, importEngineArchive } from '../storage/archive.js';

const MODEL = 'document-fixture-model';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// Authored bytes exercise transport identity, not a claim that a remote PDF parser ran.
const pdf = (nonce: string) => Buffer.from(`%PDF-1.7\n% Moodcode own document fixture ${nonce}\n%%EOF\n`);
const frames = (events: Record<string, unknown>[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
function response(text: string): string {
  const id = 'document-response', item = 'document-answer', part = { type: 'output_text', text, annotations: [] };
  const completed = { id: item, type: 'message', role: 'assistant', status: 'completed', content: [part] };
  return frames([{ type: 'response.created', response: { id, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...completed, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, item_id: item, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', output_index: 0, item_id: item, content_index: 0, delta: text },
    { type: 'response.output_text.done', output_index: 0, item_id: item, content_index: 0, text },
    { type: 'response.content_part.done', output_index: 0, item_id: item, content_index: 0, part },
    { type: 'response.output_item.done', output_index: 0, item: completed },
    { type: 'response.completed', response: { id, status: 'completed', output: [completed], usage: { input_tokens: 11, output_tokens: 3 } } }]);
}
function modelSpec(files: ModelSpec['inputFileTypes'] = ['application/pdf']): ModelSpec {
  return { providerId: 'document-responses', modelId: MODEL, contextWindow: 262144, maxOutputTokens: 4096,
    modalities: ['text', 'image'], inputFileTypes: files, tools: true, reasoning: null, nativeReplay: true,
    source: { kind: 'fixture', observedAt: new Date().toISOString(), reference: 'authored-local-PDF-encoding-fixture' } };
}
async function fixture(t: test.TestContext, overrides: { engine?: Partial<EngineOptions>; adapter?: Partial<ResponsesProviderOptions> } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-document-input-'))), repository = join(root, 'repository'); await mkdir(repository);
  const dbPath = join(root, 'engine.sqlite'), artifactDir = join(root, 'artifacts'), bodies: JsonObject[] = []; let fullReads = 0;
  const provider = new ResponsesProvider({ id: 'document-responses', pdfModelIds: [MODEL], allowUnknownDocumentTokenCost: true,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as JsonObject; bodies.push(body);
      const files = (body.input as JsonObject[]).flatMap(message => Array.isArray(message.content) ? message.content as JsonObject[] : []).filter(block => block.type === 'input_file');
      const observation = files.map(file => hash(Buffer.from(String(file.file_data).slice('data:application/pdf;base64,'.length), 'base64'))).join(',');
      return new Response(response(`Transport verified document hashes: ${observation}`), { headers: { 'Content-Type': 'text/event-stream' } });
    }, ...overrides.adapter });
  const options: EngineOptions = { dbPath, artifactDir, providers: [provider], tools: [], modelSpecs: [modelSpec()], allowUnknownDocumentTokenCost: true,
    defaults: { providerId: provider.id, modelId: MODEL, mode: 'plan', limits: { maxContextBytes: 262144, maxDurationMs: 10000 } }, ...overrides.engine };
  const engine = createEngine(options), reader = new DatabaseSync(dbPath, { readOnly: true });
  const f = { root, repository, dbPath, artifactDir, provider, options, engine, reader, bodies,
    fullReads: () => fullReads,
    trap() { f.engine.store.getSnapshot = () => { fullReads++; throw new Error('Document engine verification requires bounded history'); }; },
    async reopen(next: Partial<EngineOptions> = {}) { await f.engine.close(); f.engine = createEngine({ ...options, ...next }); f.trap(); },
  };
  t.after(async () => { try { await f.engine.close(); } finally { reader.close(); await rm(root, { recursive: true, force: true }); } });
  const createdAt = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt });
  for (const id of ['session', 'other-session']) engine.store.createSession({ id, workspaceId: 'workspace', title: id, createdAt });
  f.trap(); return f;
}
async function accept(f: Awaited<ReturnType<typeof fixture>>, requestId: string, documents?: InputDocumentAttachment[], prompt = 'Inspect exact local PDF', sessionId = 'session') {
  return f.engine.dispatchSession({ schemaVersion: 2, commandId: requestId, type: 'input.accept', payload: {
    sessionId, requestId, prompt, delivery: 'queue', ...(documents === undefined ? {} : { documents }) } });
}
async function completed(f: Awaited<ReturnType<typeof fixture>>, requestId: string, documents?: InputDocumentAttachment[], prompt?: string) {
  const accepted = await accept(f, requestId, documents, prompt); assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
  const inputId = (accepted.result as JsonObject).inputId as string; await f.engine.scheduler.waitForSession('session');
  const input = f.engine.store.getInput(inputId); assert.ok(input.runId);
  const run = await f.engine.waitForRun(input.runId); return { accepted, input, run };
}
function fileBlocks(body: JsonObject): JsonObject[] {
  return (body.input as JsonObject[]).flatMap(message => Array.isArray(message.content) ? message.content as JsonObject[] : []).filter(block => block.type === 'input_file');
}
function originals(f: Awaited<ReturnType<typeof fixture>>): Message[] {
  return f.reader.prepare("SELECT data FROM messages WHERE session_id='session' AND json_extract(data,'$.role')='user' ORDER BY ordinal LIMIT 32").all().map(row => JSON.parse(String(row.data)) as Message);
}

test('actual document import/inbox/Run/context/HTTP preserve bytes and keep durable state reference-only', async t => {
  const f = await fixture(t), bytes = pdf('FIRST_DOCUMENT_NONCE'), ref = await f.engine.importDocument('session', bytes);
  const accepted = await completed(f, 'document', [ref]); assert.equal(accepted.run.state, 'completed', JSON.stringify(accepted.run.error));
  assert.deepEqual(accepted.input.documents, [ref]); assert.deepEqual(accepted.run.documents, [ref]); assert.deepEqual(originals(f)[0]!.documents, [ref]);
  assert.deepEqual(fileBlocks(f.bodies[0]!)[0], { type: 'input_file', filename: ref.id + '.pdf', file_data: 'data:application/pdf;base64,' + bytes.toString('base64') });
  const durable = [accepted.input, accepted.run, originals(f), f.engine.store.getLatestContextRevision('session'), f.engine.store.readEvents('session', 0, 100), f.engine.store.readSessionEvents('session', 0, 100)];
  assert.equal(JSON.stringify(durable).includes(bytes.toString('base64')), false); assert.equal(JSON.stringify(durable).includes('FIRST_DOCUMENT_NONCE'), false);
  const diagnostics = f.engine.context.diagnostics('session')!; assert.equal(diagnostics.plan.inputEstimate.complete, false); assert.equal(diagnostics.plan.inputEstimate.documentTokens, null);
  assert.deepEqual(await readFile(join(f.artifactDir, 'input-documents', ref.id + '.blob')), bytes);
  const duplicate = await accept(f, 'document', [ref]); assert.equal(duplicate.ok, true); assert.equal((duplicate.result as JsonObject).runId, accepted.run.id); assert.equal(f.bodies.length, 1);
  const conflict = await accept(f, 'document', [ref], 'Changed exact request'); assert.equal(conflict.ok, false); assert.equal(conflict.error?.code, 'REQUEST_ID_CONFLICT'); assert.equal(f.fullReads(), 0);
});

for (const kind of ['model-unknown', 'model-denied', 'adapter-model-unknown', 'host-token-unknown', 'adapter-token-unknown'] as const) test(`actual PDF admission rejects ${kind} before native Input/Attempt or HTTP`, async t => {
  const f = await fixture(t, { engine: { ...(kind === 'model-unknown' ? { modelSpecs: [] } : {}), ...(kind === 'model-denied' ? { modelSpecs: [modelSpec([])] } : {}),
    ...(kind === 'host-token-unknown' ? { allowUnknownDocumentTokenCost: false } : {}) }, adapter: {
      ...(kind === 'adapter-model-unknown' ? { pdfModelIds: [] } : {}), ...(kind === 'adapter-token-unknown' ? { allowUnknownDocumentTokenCost: false } : {}) } });
  const ref = await f.engine.importDocument('session', pdf(kind)); const accepted = await accept(f, kind, [ref]);
  // Direct adapter opt-in is independent of the host port. A host preflight must
  // refuse this case too; it must not create an attempt only to learn locally.
  assert.equal(accepted.ok, false); assert.equal(accepted.error?.code, kind.includes('token') ? 'DOCUMENT_TOKEN_COST_UNKNOWN' : 'PROVIDER_UNSUPPORTED_INPUT');
  assert.equal(f.engine.store.listInputs('session').inputs.length, 0); assert.equal(Number(f.reader.prepare('SELECT count(*) AS n FROM provider_attempts').get()!.n), 0);
  assert.equal(f.bodies.length, 0); assert.equal(f.fullReads(), 0);
});

test('cross-session refs and same-sized blob tamper reject admission without changing input history', async t => {
  const f = await fixture(t), bytes = pdf('SOURCE'), ref = await f.engine.importDocument('session', bytes);
  const foreign = await accept(f, 'foreign', [ref], undefined, 'other-session'); assert.equal(foreign.ok, false); assert.equal(foreign.error?.code, 'RECORD_SCOPE_MISMATCH');
  const altered = Buffer.from(bytes); altered[altered.length - 8] = altered[altered.length - 8]! ^ 1; await writeFile(join(f.artifactDir, 'input-documents', ref.id + '.blob'), altered);
  const tampered = await accept(f, 'tampered', [ref]); assert.equal(tampered.ok, false); assert.equal(tampered.error?.code, 'DOCUMENT_INTEGRITY_FAILED');
  assert.equal(f.engine.store.listInputs('session').inputs.length, 0); assert.equal(f.bodies.length, 0); assert.equal(f.fullReads(), 0);
});

test('restart and later text-only Run retain the latest PDF source with no automatic dispatch', async t => {
  const f = await fixture(t), bytes = pdf('RESTART_DOCUMENT'), ref = await f.engine.importDocument('session', bytes);
  assert.equal((await completed(f, 'first', [ref], 'Original PDF condition')).run.state, 'completed'); const before = originals(f);
  await f.reopen(); assert.equal(f.bodies.length, 1); assert.deepEqual(originals(f), before);
  const next = await completed(f, 'text', undefined, 'New exact text-only goal'); assert.equal(next.run.state, 'completed', JSON.stringify(next.run.error));
  assert.equal(f.bodies.length, 2); assert.equal(fileBlocks(f.bodies[1]!).length, 1); assert.equal(fileBlocks(f.bodies[1]!)[0]!.file_data, 'data:application/pdf;base64,' + bytes.toString('base64'));
  const input = f.bodies[1]!.input as JsonObject[]; assert.ok(input.some(message => message.content === 'New exact text-only goal'));
  assert.deepEqual(originals(f)[0], before[0]); assert.equal(f.fullReads(), 0);
});

test('default document history rejects two PDF frames instead of silently omitting original content', async t => {
  const f = await fixture(t), old = await f.engine.importDocument('session', pdf('OLD')), latest = await f.engine.importDocument('session', pdf('LATEST'));
  assert.equal((await completed(f, 'old', [old], 'Original PDF condition')).run.state, 'completed'); const before = originals(f)[0];
  const next = await completed(f, 'latest', [latest], 'Latest PDF condition'); assert.equal(next.run.state, 'failed');
  assert.equal(next.run.error?.code, 'DOCUMENT_LIMIT_EXCEEDED', JSON.stringify(next.run.error));
  assert.equal(f.bodies.length, 1); assert.deepEqual(originals(f)[0], before); assert.deepEqual(originals(f)[1]!.documents, [latest]); assert.equal(f.fullReads(), 0);
});

test('explicit older-document omission sends latest bytes plus provenance and preserves both source texts', async t => {
  const f = await fixture(t, { engine: { documentHistoryPolicy: { kind: 'reference-only-older-documents', version: 1 } } });
  const oldBytes = pdf('OLD_POLICY'), latestBytes = pdf('LATEST_POLICY'), old = await f.engine.importDocument('session', oldBytes), latest = await f.engine.importDocument('session', latestBytes);
  assert.equal((await completed(f, 'old', [old], 'Original PDF quoted constraint')).run.state, 'completed'); const before = originals(f)[0];
  const next = await completed(f, 'latest', [latest], 'Latest PDF quoted constraint'); assert.equal(next.run.state, 'completed', JSON.stringify(next.run.error));
  const body = f.bodies[1]!; assert.equal(fileBlocks(body).length, 1); assert.equal(fileBlocks(body)[0]!.file_data, 'data:application/pdf;base64,' + latestBytes.toString('base64'));
  assert.equal(JSON.stringify(body).includes(oldBytes.toString('base64')), false);
  const input = body.input as JsonObject[]; assert.ok(input.some(message => message.content === 'Original PDF quoted constraint'));
  assert.ok(JSON.stringify(input).includes(old.id)); assert.ok(JSON.stringify(input).includes(old.sha256));
  const marker = input.find(message => message.role === 'assistant' && typeof message.content === 'string' && message.content.startsWith(DOCUMENT_HISTORY_NOTICE_PREFIX)); assert.ok(marker);
  const notice = JSON.parse(String(marker.content).slice(DOCUMENT_HISTORY_NOTICE_PREFIX.length));
  assert.equal(notice.summarized, false); assert.equal(notice.currentFileEvidence, false); assert.equal(notice.permissionOrInstruction, false);
  assert.deepEqual(notice.omissions[0].documents, [old]); assert.equal(notice.omissions[0].bytes, 'unavailable-in-this-request');
  const diagnostics = f.engine.context.diagnostics('session')!.documentHistory!;
  assert.equal(diagnostics.sourceDocumentOccurrences, 2); assert.equal(diagnostics.retainedDocumentOccurrences, 1); assert.equal(diagnostics.omittedDocumentOccurrences, 1);
  assert.equal(diagnostics.retainedDocumentBytes, latest.bytes); assert.equal(diagnostics.documentTokens, null);
  assert.ok(input.some(message => Array.isArray(message.content) && JSON.stringify(message.content).includes('Latest PDF quoted constraint')));
  assert.deepEqual(originals(f)[0], before); assert.deepEqual(originals(f)[1]!.documents, [latest]); assert.equal(f.fullReads(), 0);
  await f.reopen(); assert.equal(f.bodies.length, 2); const again = await completed(f, 'next-text', undefined, 'Continue after restore'); assert.equal(again.run.state, 'completed', JSON.stringify(again.run.error));
  assert.equal(fileBlocks(f.bodies[2]!).length, 1); assert.equal(fileBlocks(f.bodies[2]!)[0]!.file_data, 'data:application/pdf;base64,' + latestBytes.toString('base64')); assert.equal(f.fullReads(), 0);
});

test('document archive restores index and exact bytes but performs no model request', async t => {
  const f = await fixture(t), bytes = pdf('ARCHIVE_DOCUMENT'), ref = await f.engine.importDocument('session', bytes);
  await completed(f, 'original', [ref]); await f.engine.close();
  const destination = join(f.root, 'archive'); await exportEngineArchive({ dbPath: f.dbPath, artifactDir: f.artifactDir, destination });
  const restored = await importEngineArchive({ directory: destination, destination: join(f.root, 'restored') });
  assert.deepEqual(await readFile(join(restored.artifactDir, 'input-documents', ref.id + '.blob')), bytes);
  const engine = createEngine({ ...f.options, dbPath: restored.dbPath, artifactDir: restored.artifactDir });
  try {
    assert.deepEqual(engine.store.getSessionDocument('session', 'input_documents')?.data.documents, [ref]); assert.equal(f.bodies.length, 1);
    assert.equal(engine.store.getSessionControl('session').paused, true);
    engine.store.getSnapshot = () => { throw new Error('Archive document verification requires bounded history'); };
    const next = await engine.dispatchSession({ schemaVersion: 2, commandId: 'restored', type: 'input.accept', payload: { sessionId: 'session', requestId: 'restored', prompt: 'Continue from archive', delivery: 'queue' } });
    assert.equal(next.ok, true); assert.equal(f.bodies.length, 1);
    const resume = await engine.dispatchSession({ schemaVersion: 2, commandId: 'resume-restored', type: 'session.resume', payload: { sessionId: 'session' } });
    assert.equal(resume.ok, true, JSON.stringify(resume.error));
    await engine.scheduler.waitForSession('session'); const input = engine.store.getInput((next.result as JsonObject).inputId as string);
    assert.equal((await engine.waitForRun(input.runId!)).state, 'completed'); assert.equal(fileBlocks(f.bodies[1]!)[0]!.file_data, 'data:application/pdf;base64,' + bytes.toString('base64'));
  } finally { await engine.close(); }
});

test('cancelled and closed imports never admit an input or dispatch a model', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort('PRIVATE_DOCUMENT_ABORT');
  await assert.rejects(f.engine.importDocument('session', pdf('CANCEL'), controller.signal), error => error instanceof EngineError && error.code === 'DOCUMENT_CANCELLED');
  assert.equal(f.engine.store.getSessionDocument('session', 'input_documents'), null); assert.equal(f.bodies.length, 0);
  await f.engine.close(); await assert.rejects(f.engine.importDocument('session', pdf('CLOSED')), error => error instanceof EngineError && error.code === 'ENGINE_CLOSED');
});

test('document close joins pre-CAS cancellation and retains exact post-CAS success across reopen', async t => {
  const before = await fixture(t), pending = before.engine.importDocument('session', pdf('BEFORE_CAS'));
  const outcomes = await Promise.allSettled([pending, before.engine.close()]);
  assert.equal(outcomes[0]!.status, 'rejected'); assert.equal(outcomes[1]!.status, 'fulfilled');
  await before.reopen(); assert.equal(before.engine.store.getSessionDocument('session', 'input_documents'), null);
  const after = await fixture(t), bytes = pdf('AFTER_CAS'), original = after.engine.store.putSessionDocument.bind(after.engine.store);
  let closing: Promise<void> | undefined;
  after.engine.store.putSessionDocument = (sessionId, kind, revision, data) => {
    const result = original(sessionId, kind, revision, data);
    if (kind === 'input_documents') closing = after.engine.close();
    return result;
  };
  const ref = await after.engine.importDocument('session', bytes); assert.ok(closing); await closing;
  await after.reopen();
  assert.deepEqual(after.engine.store.getSessionDocument('session', 'input_documents')?.data.documents, [ref]);
  assert.deepEqual(await readFile(join(after.artifactDir, 'input-documents', ref.id + '.blob')), bytes);
  assert.equal(before.bodies.length + after.bodies.length, 0);
  assert.equal(Number(after.reader.prepare('SELECT count(*) AS n FROM inputs').get()!.n), 0);
  assert.equal(Number(after.reader.prepare('SELECT count(*) AS n FROM runs').get()!.n), 0);
});

for (const schemaVersion of [1, 2] as const) test(`v${schemaVersion} mixed media admission preserves budget then segment then document then image failures without native effects`, async t => {
  const f = await fixture(t, { engine: { allowUnknownMediaTokenCost: true, modelSpecs: [{ ...modelSpec(), mediaCapabilities: { audioInput: true, videoFrames: false, audioOutput: false } }] } });
  let segmentChecks = 0; f.provider.supportsInputMedia = () => { segmentChecks++; return true; };
  const image = await f.engine.importImage('session', png(), 'image/png'), document = await f.engine.importDocument('session', pdf('PRIORITY'));
  const audioBytes = wav(), audio = await f.engine.importMedia('session', audioBytes, 'audio/wav', [{ startMs: 0, endMs: 100 }]);
  const audioPath = join(f.artifactDir, 'input-segments', audio.id + '.blob'), documentPath = join(f.artifactDir, 'input-documents', document.id + '.blob');
  const nativeCounts = () => ['inputs', 'runs', 'messages', 'provider_attempts', 'events', 'session_events'].map(table => Number(f.reader.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n));
  const before = nativeCounts();
  await rm(audioPath); await rm(documentPath); await rm(join(f.artifactDir, 'input-media', image.id + '.blob'));
  const dispatch = (requestId: string, attachments = [image]) => {
    const payload = { sessionId: 'session', requestId, prompt: 'All original media', config: f.engine.getCapabilities().defaults, attachments, documents: [document], media: [audio] };
    return schemaVersion === 1
      ? f.engine.dispatch({ schemaVersion, commandId: requestId, type: 'run.submit', payload })
      : f.engine.dispatchSession({ schemaVersion, commandId: requestId, type: 'input.accept', payload: { ...payload, delivery: 'queue' } });
  };
  const budget = await dispatch('budget', [{ ...image, bytes: 524288 }, { ...image, id: 'img_' + '0'.repeat(32), bytes: 524288 }]);
  assert.equal(budget.error?.code, 'INVALID_INPUT'); assert.equal(budget.error?.message, 'payload exceeds the combined input media byte limit'); assert.equal(segmentChecks, 0);
  assert.equal((await dispatch('segment')).error?.code, 'MEDIA_STORAGE_FAILED');
  await writeFile(audioPath, audioBytes);
  assert.equal((await dispatch('document')).error?.code, 'DOCUMENT_STORAGE_FAILED');
  await writeFile(documentPath, pdf('PRIORITY'));
  assert.equal((await dispatch('image')).error?.code, 'IMAGE_STORAGE_FAILED');
  assert.deepEqual(nativeCounts(), before); assert.equal(f.bodies.length, 0); assert.equal(f.fullReads(), 0);
});

for (const origin of [1, 2] as const) test(`v${origin} durable document receipt bypasses deleted source through both admission APIs`, async t => {
  const f = await fixture(t), ref = await f.engine.importDocument('session', pdf('RECEIPT'));
  const payload = { sessionId: 'session', requestId: 'original', prompt: 'Exact document', config: f.engine.getCapabilities().defaults, documents: [ref] };
  const dispatch = (schemaVersion: 1 | 2, request = payload) => schemaVersion === 1
    ? f.engine.dispatch({ schemaVersion, commandId: 'document', type: 'run.submit', payload: request })
    : f.engine.dispatchSession({ schemaVersion, commandId: 'document', type: 'input.accept', payload: { ...request, delivery: 'queue' } });
  const first = await dispatch(origin); assert.equal(first.ok, true, JSON.stringify(first.error));
  await f.engine.scheduler.waitForSession('session');
  const inputId = (first.result as JsonObject).inputId as string, runId = f.engine.store.getInput(inputId).runId!;
  assert.equal((await f.engine.waitForRun(runId)).state, 'completed');
  await rm(join(f.artifactDir, 'input-documents', ref.id + '.blob'));
  for (const version of [1, 2] as const) {
    const duplicate = await dispatch(version); assert.equal(duplicate.ok, true, JSON.stringify(duplicate.error));
    assert.equal((duplicate.result as JsonObject).runId, runId); assert.equal((duplicate.result as JsonObject).duplicate, true);
    assert.equal((await dispatch(version, { ...payload, requestId: 'fresh' })).error?.code, 'DOCUMENT_STORAGE_FAILED');
    assert.equal((await dispatch(version, { ...payload, prompt: 'Changed exact request' })).error?.code, 'REQUEST_ID_CONFLICT');
  }
  assert.equal(f.bodies.length, 1); assert.equal(f.engine.store.listInputs('session').inputs.length, 1);
  assert.equal(Number(f.reader.prepare('SELECT count(*) AS n FROM runs').get()!.n), 1);
  assert.equal(Number(f.reader.prepare('SELECT count(*) AS n FROM provider_attempts').get()!.n), 1);
});

test('actual combined image/document input keeps exact independent refs and both token costs unknown', async t => {
  const f = await fixture(t), imageBytes = png(), documentBytes = pdf('COMBINED_INPUT');
  const image = await f.engine.importImage('session', imageBytes, 'image/png'), file = await f.engine.importDocument('session', documentBytes);
  const accepted = await f.engine.dispatchSession({ schemaVersion: 2, commandId: 'combined', type: 'input.accept', payload: { sessionId: 'session', requestId: 'combined', prompt: 'Inspect both bounded observations', delivery: 'queue', attachments: [image], documents: [file] } });
  assert.equal(accepted.ok, true, JSON.stringify(accepted.error)); await f.engine.scheduler.waitForSession('session');
  const input = f.engine.store.getInput((accepted.result as JsonObject).inputId as string); assert.equal((await f.engine.waitForRun(input.runId!)).state, 'completed');
  const blocks = (f.bodies[0]!.input as JsonObject[]).flatMap(message => Array.isArray(message.content) ? message.content as JsonObject[] : []);
  assert.equal(blocks.find(block => block.type === 'input_file')!.file_data, 'data:application/pdf;base64,' + documentBytes.toString('base64'));
  assert.equal(blocks.find(block => block.type === 'input_image')!.image_url, 'data:image/png;base64,' + imageBytes.toString('base64'));
  const estimate = f.engine.context.diagnostics('session')!.plan.inputEstimate; assert.equal(estimate.complete, false); assert.equal(estimate.documentTokens, null); assert.equal(estimate.imageTokens, null);
  assert.deepEqual(originals(f)[0]!.documents, [file]); assert.deepEqual(originals(f)[0]!.attachments, [image]); assert.equal(f.fullReads(), 0);
});

test('image-only history opt-in does not silently omit PDF sources', async t => {
  const f = await fixture(t, { engine: { mediaHistoryPolicy: { kind: 'reference-only-older-images', version: 1 } } });
  const first = await f.engine.importDocument('session', pdf('FIRST_PDF')), second = await f.engine.importDocument('session', pdf('SECOND_PDF'));
  assert.equal((await completed(f, 'first', [first])).run.state, 'completed');
  const next = await completed(f, 'second', [second]); assert.equal(next.run.state, 'failed'); assert.equal(next.run.error?.code, 'DOCUMENT_LIMIT_EXCEEDED');
  assert.equal(f.bodies.length, 1); assert.deepEqual(originals(f).map(message => message.documents), [[first], [second]]); assert.equal(f.fullReads(), 0);
});

test('direct coordinator PDF policy rejection has confirmed local cleanup and no execution quarantine', async t => {
  const f = await fixture(t, { engine: { allowUnknownDocumentTokenCost: false } }), ref = await f.engine.importDocument('session', pdf('LOCAL_POLICY_DENY'));
  const accepted = f.engine.coordinator.submit({ sessionId: 'session', requestId: 'direct', prompt: 'Direct bounded host input', documents: [ref], config: f.engine.getCapabilities().defaults });
  const run = await f.engine.waitForRun(accepted.runId); assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'DOCUMENT_TOKEN_COST_UNKNOWN');
  const attempts = f.reader.prepare('SELECT id FROM provider_attempts WHERE run_id=? ORDER BY attempt_index LIMIT 8').all(run.id); assert.equal(attempts.length, 1);
  const proof = f.engine.getAttemptCleanup('session', String(attempts[0]!.id)); assert.equal(proof.state, 'confirmed'); assert.equal(proof.cleanupConfirmed, true);
  assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), false); assert.equal(f.bodies.length, 0); assert.equal(f.fullReads(), 0);
});

test('dispatch revalidates document blobs after a paused admission and safely fails local tamper', async t => {
  const f = await fixture(t), bytes = pdf('DISPATCH_TAMPER'), ref = await f.engine.importDocument('session', bytes);
  f.engine.scheduler.pause('session'); const accepted = await accept(f, 'paused-doc', [ref]); assert.equal(accepted.ok, true);
  assert.equal(f.bodies.length, 0); const bad = Buffer.from(bytes); bad[bad.length - 8] = bad[bad.length - 8]! ^ 1;
  await writeFile(join(f.artifactDir, 'input-documents', ref.id + '.blob'), bad); f.engine.scheduler.resume('session'); await f.engine.scheduler.waitForSession('session');
  const input = f.engine.store.getInput((accepted.result as JsonObject).inputId as string); const run = await f.engine.waitForRun(input.runId!);
  assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'DOCUMENT_INTEGRITY_FAILED'); assert.deepEqual(input.documents, [ref]);
  const attempts = f.reader.prepare('SELECT id FROM provider_attempts WHERE run_id=? LIMIT 8').all(run.id); assert.equal(attempts.length, 1);
  assert.equal(f.engine.getAttemptCleanup('session', String(attempts[0]!.id)).cleanupConfirmed, true);
  assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), false); assert.equal(f.bodies.length, 0); assert.equal(f.fullReads(), 0);
});

test('latest PDF from an older Run survives actual bounded history across twenty-four complete read exchanges', async t => {
  let currentRunId: string | undefined, lastRequest: TurnRequest | undefined, calls = 0;
  const provider: ProviderAdapter = { id: 'document-responses', inputModalities: ['text', 'image'], inputFileTypes: ['application/pdf'], allowUnknownDocumentTokenCost: true,
    async *streamTurn(request) {
      calls++; assert.equal(request.resolvedDocuments?.length, 1);
      if (request.runId === currentRunId && request.turnIndex < 24) {
        yield { type: 'tool.call', call: { id: `read-${request.turnIndex}`, name: 'read_file', input: { path: `source-${request.turnIndex}.txt` } } };
        yield { type: 'finish', reason: 'tool_calls' };
      } else { lastRequest = structuredClone(request); yield { type: 'text.delta', delta: 'Latest document remained available' }; yield { type: 'finish', reason: 'stop' }; }
    } };
  const f = await fixture(t, { engine: { providers: [provider], tools: undefined, allowedToolNames: ['read_file'], defaults: {
    providerId: provider.id, modelId: MODEL, mode: 'plan', limits: { maxTurns: 32, maxContextBytes: 16384, maxOutputBytes: 1048576, maxDurationMs: 20000 } } } });
  for (let index = 0; index < 24; index++) await writeFile(join(f.repository, `source-${index}.txt`), `Observation ${index}\n` + 'x'.repeat(3980));
  const bytes = pdf('BOUND_WINDOW_ORIGINAL'), ref = await f.engine.importDocument('session', bytes);
  const old = await completed(f, 'old-pdf', [ref], 'Original exact bounded PDF requirement'); assert.equal(old.run.state, 'completed'); const before = originals(f)[0];
  const oldAssistant = String(f.reader.prepare("SELECT id FROM messages WHERE run_id=? AND json_extract(data,'$.role')='assistant' LIMIT 1").get(old.run.id)!.id);
  await f.reopen(); assert.equal(calls, 1);
  const current = f.engine.coordinator.submit({ sessionId: 'session', requestId: 'long-text', prompt: 'Complete the bounded text-only goal', config: f.engine.getCapabilities().defaults }); currentRunId = current.runId;
  const run = await f.engine.waitForRun(current.runId); assert.equal(run.state, 'completed', JSON.stringify(run.error)); assert.equal(calls, 26); assert.ok(lastRequest);
  const diagnostics = f.engine.context.diagnostics('session')!; assert.ok(diagnostics.activeWindow); assert.ok(diagnostics.omittedDatabaseMessages > 0);
  assert.equal(diagnostics.plan.selectedMessageIds.includes(oldAssistant), false); assert.ok(diagnostics.plan.selectedMessageIds.includes(before!.id));
  assert.equal(diagnostics.sessionDocumentAnchor?.runId, old.run.id); assert.equal(diagnostics.sessionDocumentAnchor?.messageId, before!.id);
  assert.deepEqual(lastRequest.resolvedDocuments, [{ attachment: ref, data: bytes.toString('base64') }]);
  assert.ok(lastRequest.messages.some(message => message.content === before!.content && message.documents?.[0]?.id === ref.id));
  assert.ok(lastRequest.messages.some(message => message.content === 'Complete the bounded text-only goal'));
  assert.ok(Buffer.byteLength(JSON.stringify({ messages: lastRequest.messages, tools: lastRequest.tools })) <= 16384); assert.deepEqual(originals(f)[0], before); assert.equal(f.fullReads(), 0);
});
