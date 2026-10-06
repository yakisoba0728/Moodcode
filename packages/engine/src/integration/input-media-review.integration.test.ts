import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EngineError, type InputImageAttachment, type JsonObject } from '@moodcode/contracts';
import { createEngine, type EngineOptions, type MoodcodeEngine } from '../engine.js';
import type { ProviderAdapter, TurnRequest } from '../ports.js';
import { png } from '../media/fixtures.js';
import { ResponsesProvider } from '../provider/responses.js';

async function fixture(t: test.TestContext, provider: ProviderAdapter, options: Partial<EngineOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-media-review-'))), repository = join(root, 'repo'), dbPath = join(root, 'engine.sqlite'), artifactDir = join(root, 'artifacts');
  await mkdir(repository); execFileSync('git', ['init', '-q', repository]);
  const engine = createEngine({ ...options, dbPath, artifactDir, providers: [provider], defaults: { providerId: provider.id, modelId: 'fixture', ...options.defaults } });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const opened = await engine.dispatch({ schemaVersion: 1, commandId: 'open', type: 'workspace.open', payload: { path: repository } }); assert.equal(opened.ok, true);
  const session = await engine.dispatch({ schemaVersion: 1, commandId: 'session', type: 'session.create', payload: { workspaceId: (opened.result as JsonObject).id } }); assert.equal(session.ok, true);
  return { root, dbPath, artifactDir, engine, sessionId: (session.result as JsonObject).id as string };
}
function submit(engine: MoodcodeEngine, sessionId: string, requestId: string, attachments?: InputImageAttachment[], prompt = 'Inspect image', config?: JsonObject) {
  return engine.dispatch({ schemaVersion: 1, commandId: requestId, type: 'run.submit', payload: { sessionId, requestId, prompt, ...(attachments === undefined ? {} : { attachments: attachments as unknown as JsonObject[] }), ...(config === undefined ? {} : { config }) } });
}
function accept(engine: MoodcodeEngine, sessionId: string, requestId: string, attachments: InputImageAttachment[]) {
  return engine.dispatchSession({ schemaVersion: 2, commandId: requestId, type: 'input.accept', payload: { sessionId, requestId, prompt: 'Inspect image', delivery: 'queue', attachments: attachments as unknown as JsonObject[] } });
}
const receiptRun = (value: { result?: unknown }) => (value.result as JsonObject).runId as string;

test('known text-only model rejects admission; unknown vision metadata remains unknown with explicit incomplete image estimate', async t => {
  let calls = 0;
  const provider: ProviderAdapter = { id: 'vision-review', inputModalities: ['text', 'image'], async *streamTurn() { calls++; yield { type: 'finish', reason: 'stop' }; } };
  const model = { providerId: provider.id, modelId: 'fixture', contextWindow: 100_000, maxOutputTokens: null, modalities: ['text'] as const, tools: null, reasoning: null, nativeReplay: null, source: { kind: 'fixture' as const, observedAt: new Date().toISOString() } };
  const known = await fixture(t, provider, { modelSpecs: [model] }), ref = await known.engine.importImage(known.sessionId, png(), 'image/png');
  const rejected = await accept(known.engine, known.sessionId, 'known', [ref]); assert.equal(rejected.ok, false); assert.equal(rejected.error?.code, 'PROVIDER_UNSUPPORTED_INPUT');
  assert.equal(known.engine.store.getSnapshot(known.sessionId).runs.length, 0);
  const unknown = await fixture(t, provider), other = await unknown.engine.importImage(unknown.sessionId, png(), 'image/png');
  const accepted = await submit(unknown.engine, unknown.sessionId, 'unknown', [other]); assert.equal(accepted.ok, true);
  assert.equal((await unknown.engine.waitForRun(receiptRun(accepted))).state, 'completed');
  const plan = unknown.engine.context.diagnostics(unknown.sessionId)!.plan;
  assert.equal(plan.tokenLimit, null); assert.equal(plan.inputEstimate.complete, false); assert.equal(plan.inputEstimate.imageTokens, null);
  assert.ok(plan.warnings.some(warning => warning.includes('complete model token window is not verified')));
  assert.equal(calls, 1);
});

test('same imported reference counts per historical user occurrence and fifth occurrence fails before provider dispatch', async t => {
  const observed: TurnRequest[] = [];
  const provider: ProviderAdapter = { id: 'vision-review', inputModalities: ['text', 'image'], async *streamTurn(request) { observed.push(structuredClone(request)); yield { type: 'finish', reason: 'stop' }; } };
  const f = await fixture(t, provider), ref = await f.engine.importImage(f.sessionId, png(), 'image/png');
  for (let index = 0; index < 4; index++) { const accepted = await submit(f.engine, f.sessionId, `image-${index}`, [ref]); assert.equal(accepted.ok, true); assert.equal((await f.engine.waitForRun(receiptRun(accepted))).state, 'completed'); }
  assert.deepEqual(observed.map(request => request.messages.reduce((count, message) => count + (message.attachments?.length ?? 0), 0)), [1, 2, 3, 4]);
  assert.deepEqual(observed.map(request => request.resolvedImages?.length), [1, 1, 1, 1]);
  const fifth = await submit(f.engine, f.sessionId, 'image-4', [ref]); assert.equal(fifth.ok, true);
  assert.equal((await f.engine.waitForRun(receiptRun(fifth))).error?.code, 'PROVIDER_LIMIT_EXCEEDED');
  assert.equal(observed.length, 4);
  assert.equal(f.engine.store.getSnapshot(f.sessionId).messages.filter(message => message.role === 'user' && message.attachments?.[0]?.id === ref.id).length, 5);
});

test('exact v1/v2 admission retry returns durable receipt after blob deletion while a new request rejects the missing image', async t => {
  let calls = 0;
  const provider: ProviderAdapter = { id: 'vision-review', inputModalities: ['text', 'image'], async *streamTurn() { calls++; yield { type: 'finish', reason: 'stop' }; } };
  const f = await fixture(t, provider), ref = await f.engine.importImage(f.sessionId, png(), 'image/png');
  const first = await submit(f.engine, f.sessionId, 'original', [ref]); assert.equal(first.ok, true); const runId = receiptRun(first); await f.engine.waitForRun(runId);
  await rm(join(f.artifactDir, 'input-media', ref.id + '.blob'));
  const retry = await submit(f.engine, f.sessionId, 'original', [ref]); assert.equal(retry.ok, true, JSON.stringify(retry.error)); assert.equal(receiptRun(retry), runId); assert.equal((retry.result as JsonObject).duplicate, true);
  const cross = await accept(f.engine, f.sessionId, 'original', [ref]); assert.equal(cross.ok, true, JSON.stringify(cross.error)); assert.equal(receiptRun(cross), runId);
  const fresh = await accept(f.engine, f.sessionId, 'new', [ref]); assert.equal(fresh.ok, false); assert.equal(fresh.error?.code, 'IMAGE_STORAGE_FAILED');
  const changed = await submit(f.engine, f.sessionId, 'original', [ref], 'Different request'); assert.equal(changed.ok, false); assert.equal(changed.error?.code, 'REQUEST_ID_CONFLICT');
  assert.equal(calls, 1); assert.equal(f.engine.store.getSnapshot(f.sessionId).runs.length, 1); assert.equal(f.engine.store.listInputs(f.sessionId).inputs.length, 1);
});

test('overflow recovery cannot replace an image-bearing older Run with a text-only semantic checkpoint', async t => {
  let summaries = 0, primary = 0;
  const provider: ProviderAdapter = { id: 'vision-review', inputModalities: ['text', 'image'], async *streamTurn(request) {
    if (request.tools.length === 0) { summaries++; yield { type: 'text.delta', delta: 'Text-only historical summary' }; yield { type: 'finish', reason: 'stop' }; return; }
    if (++primary === 2) throw new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'Fixture overflow before content');
    yield { type: 'text.delta', delta: 'Image observation' }; yield { type: 'finish', reason: 'stop' };
  } };
  const f = await fixture(t, provider), ref = await f.engine.importImage(f.sessionId, png(), 'image/png');
  const first = await submit(f.engine, f.sessionId, 'image', [ref]); assert.equal(first.ok, true); await f.engine.waitForRun(receiptRun(first));
  const second = await submit(f.engine, f.sessionId, 'next', undefined, 'Continue earlier image discussion'); assert.equal(second.ok, true);
  const failure = await f.engine.waitForRun(receiptRun(second)); assert.equal(failure.error?.code, 'SUMMARY_IMAGE_SOURCE_UNSUPPORTED');
  assert.equal(summaries, 0); assert.equal(primary, 2); assert.equal(f.engine.store.getSessionDocument(f.sessionId, 'context.memory'), null);
  assert.deepEqual(f.engine.store.getSnapshot(f.sessionId).messages.find(message => message.role === 'user')?.attachments, [ref]);
  assert.equal(f.engine.store.listTurns(failure.id).length, 1);
  const dispatches = f.engine.store.readSessionEvents(f.sessionId, 0).filter(event => event.runId === failure.id && event.type === 'provider.attempt.dispatched');
  assert.equal(dispatches.length, 1);
});

test('byte pruning cannot silently replace a historical image-bearing block with an extractive text excerpt', async t => {
  let calls = 0;
  const provider: ProviderAdapter = { id: 'vision-review', inputModalities: ['text', 'image'], async *streamTurn() { calls++; yield { type: 'finish', reason: 'stop' }; } };
  const f = await fixture(t, provider), ref = await f.engine.importImage(f.sessionId, png(), 'image/png');
  const first = await submit(f.engine, f.sessionId, 'large-image', [ref], 'Image constraints: ' + 'description '.repeat(2000)); assert.equal(first.ok, true); assert.equal((await f.engine.waitForRun(receiptRun(first))).state, 'completed');
  const next = await submit(f.engine, f.sessionId, 'small-context', undefined, 'Keep the image context', { limits: { maxContextBytes: 16384 } }); assert.equal(next.ok, true);
  const failed = await f.engine.waitForRun(receiptRun(next)); assert.equal(failed.error?.code, 'IMAGE_CONTEXT_LIMIT');
  assert.equal(calls, 1); assert.equal(f.engine.store.getSessionDocument(f.sessionId, 'context.memory'), null);
  assert.deepEqual(f.engine.store.getSnapshot(f.sessionId).messages.find(message => message.role === 'user')?.attachments, [ref]);
});

test('close joins an in-flight import before store shutdown; cancellation after durable CAS retains its imported reference', async t => {
  const provider: ProviderAdapter = { id: 'vision-review', inputModalities: ['text', 'image'], async *streamTurn() { yield { type: 'finish', reason: 'stop' }; } };
  const before = await fixture(t, provider), pending = before.engine.importImage(before.sessionId, png(), 'image/png'), closing = before.engine.close();
  const settled = await Promise.allSettled([pending, closing]); assert.equal(settled[0]!.status, 'rejected'); assert.equal(settled[1]!.status, 'fulfilled');
  const reopened = createEngine({ dbPath: before.dbPath, artifactDir: before.artifactDir });
  try { assert.equal(reopened.store.getSessionDocument(before.sessionId, 'input_images'), null); } finally { await reopened.close(); }
  const after = await fixture(t, provider), original = after.engine.store.putSessionDocument.bind(after.engine.store);
  let committedClose: Promise<void> | undefined;
  after.engine.store.putSessionDocument = (sessionId, kind, revision, data) => { const result = original(sessionId, kind, revision, data); if (kind === 'input_images') committedClose = after.engine.close(); return result; };
  const ref = await after.engine.importImage(after.sessionId, png(), 'image/png'); await committedClose;
  assert.deepEqual(await readFile(join(after.artifactDir, 'input-media', ref.id + '.blob')), png());
  const durable = createEngine({ dbPath: after.dbPath, artifactDir: after.artifactDir });
  try { assert.deepEqual(durable.store.getSessionDocument(after.sessionId, 'input_images')?.data.attachments, [ref]); } finally { await durable.close(); }
});

test('closing during asynchronous image admission rejects that admission without a late Input or Run', async t => {
  let calls = 0;
  const provider: ProviderAdapter = { id: 'vision-review', inputModalities: ['text', 'image'], async *streamTurn() { calls++; yield { type: 'finish', reason: 'stop' }; } };
  const f = await fixture(t, provider), ref = await f.engine.importImage(f.sessionId, png(), 'image/png');
  const pending = accept(f.engine, f.sessionId, 'closing-admission', [ref]), closing = f.engine.close();
  const rejected = await pending; await closing;
  assert.equal(rejected.ok, false); assert.ok(['IMAGE_CANCELLED', 'ENGINE_CLOSED'].includes(rejected.error?.code ?? ''));
  const reopened = createEngine({ dbPath: f.dbPath, artifactDir: f.artifactDir });
  try { assert.equal(reopened.store.getSnapshot(f.sessionId).runs.length, 0); assert.equal(reopened.store.listInputs(f.sessionId).inputs.length, 0); } finally { await reopened.close(); }
  assert.equal(calls, 0);
});

test('native HTTP error echo cannot put raw image base64 into Run errors, event journals or context revisions', async t => {
  const raw = png().toString('base64'); let posted = '';
  const provider = new ResponsesProvider({ id: 'vision-review', baseURL: 'https://fixture.invalid/v1', fetch: async (_url, init) => { posted = String(init?.body); return new Response(JSON.stringify({ error: { code: 'invalid_request_error', message: 'Echo ' + raw } }), { status: 400, headers: { 'Content-Type': 'application/json' } }); } });
  const f = await fixture(t, provider), ref = await f.engine.importImage(f.sessionId, png(), 'image/png'), accepted = await submit(f.engine, f.sessionId, 'error', [ref]); assert.equal(accepted.ok, true);
  const run = await f.engine.waitForRun(receiptRun(accepted)); assert.equal(run.error?.code, 'PROVIDER_HTTP_ERROR'); assert.ok(posted.includes(raw));
  const publicRecords = JSON.stringify([run, f.engine.store.getSnapshot(f.sessionId), f.engine.store.readEvents(f.sessionId, 0), f.engine.store.readSessionEvents(f.sessionId, 0), f.engine.store.getLatestContextRevision(f.sessionId), f.engine.context.diagnostics(f.sessionId)]);
  assert.equal(publicRecords.includes(raw), false); assert.equal(publicRecords.includes('data:image/png;base64'), false);
});
