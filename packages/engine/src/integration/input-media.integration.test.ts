import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { InputImageAttachment, JsonObject } from '@moodcode/contracts';
import { createEngine, type MoodcodeEngine } from '../engine.js';
import type { ProviderAdapter, TurnRequest } from '../ports.js';
import { png } from '../media/fixtures.js';
import { exportEngineArchive, importEngineArchive } from '../storage/archive.js';

async function fixture(t: test.TestContext, provider?: ProviderAdapter) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-input-media-'))), workspace = join(root, 'repo'); await mkdir(workspace);
  execFileSync('git', ['init', '-q', workspace]);
  const dbPath = join(root, 'engine.sqlite'), artifactDir = join(root, 'artifacts');
  const engine = createEngine({ dbPath, artifactDir, ...(provider ? { providers: [provider], defaults: { providerId: provider.id, modelId: 'fixture' } } : {}) });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const opened = await engine.dispatch({ schemaVersion: 1, commandId: 'open', type: 'workspace.open', payload: { path: workspace } }); assert.equal(opened.ok, true, JSON.stringify(opened.error));
  const create = await engine.dispatch({ schemaVersion: 1, commandId: 'session', type: 'session.create', payload: { workspaceId: (opened.result as JsonObject).id } }); assert.equal(create.ok, true);
  return { root, dbPath, artifactDir, engine, sessionId: (create.result as JsonObject).id as string };
}
const accept = (engine: MoodcodeEngine, sessionId: string, requestId: string, attachments: InputImageAttachment[]) => engine.dispatchSession({ schemaVersion: 2, commandId: requestId, type: 'input.accept', payload: { sessionId, requestId, prompt: 'Inspect the image', attachments, delivery: 'queue' } });

test('imported image reaches actual provider dispatch while durable records keep references and attempt usage is deduplicated', async t => {
  const requests: TurnRequest[] = [];
  const provider: ProviderAdapter = { id: 'image-fixture', inputModalities: ['text', 'image'], async *streamTurn(request) {
    requests.push(structuredClone(request));
    yield { type: 'usage', inputTokens: 5, outputTokens: 2, cachedInputTokens: 1 };
    yield { type: 'usage', inputTokens: 5, outputTokens: 2, cachedInputTokens: 1 };
    yield { type: 'text.delta', delta: 'Observed fixture image' }; yield { type: 'finish', reason: 'stop' };
  } };
  const f = await fixture(t, provider), bytes = png(), ref = await f.engine.importImage(f.sessionId, bytes, 'image/png');
  const accepted = await accept(f.engine, f.sessionId, 'image', [ref]); assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
  await f.engine.scheduler.waitForSession(f.sessionId);
  const runId = f.engine.store.getInput((accepted.result as JsonObject).inputId as string).runId!; const run = await f.engine.coordinator.waitForRun(runId); assert.equal(run.state, 'completed');
  assert.equal(requests.length, 1); assert.equal(requests[0]?.sessionId, f.sessionId);
  assert.deepEqual(requests[0]?.resolvedImages, [{ attachment: ref, data: bytes.toString('base64') }]);
  const snapshot = f.engine.store.getSnapshot(f.sessionId); assert.deepEqual(snapshot.messages.find(message => message.role === 'user')?.attachments, [ref]);
  assert.equal(JSON.stringify(snapshot).includes(bytes.toString('base64')), false);
  assert.equal(JSON.stringify(f.engine.store.getLatestContextRevision(f.sessionId)).includes(bytes.toString('base64')), false);
  const diagnostic = f.engine.context.diagnostics(f.sessionId)!; assert.equal(diagnostic.plan.inputEstimate.complete, false);
  assert.equal(diagnostic.plan.inputEstimate.imageTokens, null);
  const metrics = f.engine.store.getNativeMetrics(f.sessionId);
  assert.equal(metrics.attemptUsage.samples, 1); assert.equal(metrics.attemptUsage.inputTokens.tokens, 5); assert.equal(metrics.attemptUsage.outputTokens.tokens, 2);
  assert.equal(metrics.providerUsage.inputTokens.tokens, 10);
  const duplicate = await accept(f.engine, f.sessionId, 'image', [ref]); assert.equal(duplicate.ok, true); assert.equal((duplicate.result as JsonObject).runId, runId);
});

test('wrong session and unsupported provider reject image admission before creating an Input or Run', async t => {
  let dispatches = 0;
  const provider: ProviderAdapter = { id: 'image-fixture', inputModalities: ['text', 'image'], async *streamTurn() { dispatches++; yield { type: 'finish', reason: 'stop' }; } };
  const f = await fixture(t, provider), ref = await f.engine.importImage(f.sessionId, png(), 'image/png');
  const second = f.engine.store.createSession({ id: 'another-session', workspaceId: f.engine.store.getSession(f.sessionId).workspaceId, title: 'Second', createdAt: new Date().toISOString() });
  const rejected = await accept(f.engine, second.id, 'wrong-owner', [ref]); assert.equal(rejected.ok, false); assert.equal(rejected.error?.code, 'RECORD_SCOPE_MISMATCH');
  const unsupported = await f.engine.dispatch({ schemaVersion: 1, commandId: 'unsupported', type: 'run.submit', payload: { sessionId: f.sessionId, requestId: 'unsupported', prompt: 'image', attachments: [ref] as unknown as JsonObject[], config: { providerId: 'scripted' } } });
  assert.equal(unsupported.ok, false); assert.equal(unsupported.error?.code, 'PROVIDER_UNSUPPORTED_INPUT');
  assert.equal(f.engine.store.getSnapshot(f.sessionId).runs.length, 0); assert.equal(f.engine.store.getSnapshot(second.id).runs.length, 0); assert.equal(dispatches, 0);
});

test('closed engine rejects new imports and archive preserves image index plus immutable raw blobs', async t => {
  const f = await fixture(t), bytes = png(), ref = await f.engine.importImage(f.sessionId, bytes, 'image/png'); await f.engine.close();
  await assert.rejects(f.engine.importImage(f.sessionId, bytes, 'image/png'), (error: unknown) => (error as { code: string }).code === 'ENGINE_CLOSED');
  const directory = join(f.root, 'archive'); await exportEngineArchive({ dbPath: f.dbPath, artifactDir: f.artifactDir, destination: directory });
  const restored = await importEngineArchive({ directory, destination: join(f.root, 'imported') });
  assert.deepEqual(await readFile(join(restored.artifactDir, 'input-media', ref.id + '.blob')), bytes);
  const reopened = createEngine({ dbPath: restored.dbPath, artifactDir: restored.artifactDir });
  try { assert.deepEqual(reopened.store.getSessionDocument(f.sessionId, 'input_images')?.data.attachments, [ref]); assert.equal(reopened.store.getSnapshot(f.sessionId).runs.length, 0); }
  finally { await reopened.close(); }
});
