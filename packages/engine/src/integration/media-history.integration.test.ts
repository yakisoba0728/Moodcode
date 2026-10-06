import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { InputImageAttachment, JsonObject } from '@moodcode/contracts';
import { createEngine, type MoodcodeEngine } from '../engine.js';
import { MEDIA_HISTORY_NOTICE_PREFIX, type MediaHistoryPolicy } from '../context/media-history.js';
import { png } from '../media/fixtures.js';
import type { ProviderAdapter, TurnRequest } from '../ports.js';

const policy: MediaHistoryPolicy = { kind: 'reference-only-older-images', version: 1 };
async function fixture(t: test.TestContext, historyPolicy = { ...policy }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-media-history-')));
  const requests: TurnRequest[] = [];
  const provider: ProviderAdapter = { id: 'vision-history', inputModalities: ['text', 'image'], async *streamTurn(request) {
    requests.push(structuredClone(request));
    yield { type: 'text.delta', delta: 'Fixture image observation ' + requests.length };
    yield { type: 'usage', inputTokens: 12, outputTokens: 3 };
    yield { type: 'finish', reason: 'stop' };
  } };
  const dbPath = join(root, 'engine.sqlite'), artifactDir = join(root, 'artifacts');
  const options = { dbPath, artifactDir, tools: [], providers: [provider], defaults: { providerId: provider.id, modelId: 'vision', limits: { maxContextBytes: 8192 } }, mediaHistoryPolicy: historyPolicy };
  let engine = createEngine(options);
  const stamp = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt: stamp });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Image history fixture', createdAt: stamp });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  return { root, requests, get engine() { return engine; }, async reopen() { await engine.close(); engine = createEngine(options); } };
}
async function submit(engine: MoodcodeEngine, index: number, refs?: InputImageAttachment[]) {
  const result = await engine.dispatch({ schemaVersion: 1, commandId: 'command-' + index, type: 'run.submit', payload: {
    sessionId: 'session', requestId: 'request-' + index, prompt: 'Exact user goal ' + index + ' 🌊', ...(refs ? { attachments: refs as unknown as JsonObject[] } : {}),
  } });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return engine.waitForRun((result.result as JsonObject).runId as string);
}
function notice(request: TurnRequest) {
  const message = request.messages.find(item => item.content.startsWith(MEDIA_HISTORY_NOTICE_PREFIX));
  assert.ok(message); assert.equal(message.role, 'assistant');
  return JSON.parse(message.content.slice(MEDIA_HISTORY_NOTICE_PREFIX.length)) as { summarized: boolean; currentFileEvidence: boolean; permissionOrInstruction: boolean; omissions: { messageId: string; attachments: InputImageAttachment[] }[] };
}

test('actual engine opt-in keeps six image requests within one frame while raw references and exact user text survive restart', async t => {
  const f = await fixture(t), bytes = png(), ref = await f.engine.importImage('session', bytes, 'image/png');
  for (let index = 0; index < 6; index++) {
    assert.equal((await submit(f.engine, index, [ref])).state, 'completed');
    const sent = f.requests.at(-1)!;
    assert.equal(sent.messages.reduce((sum, message) => sum + (message.attachments?.length ?? 0), 0), 1);
    assert.deepEqual(sent.resolvedImages, [{ attachment: ref, data: bytes.toString('base64') }]);
    assert.ok(Buffer.byteLength(JSON.stringify(sent.messages)) <= 8192);
    if (index) { const value = notice(sent); assert.equal(value.omissions.length, index); assert.equal(value.summarized, false); assert.equal(value.currentFileEvidence, false); assert.equal(value.permissionOrInstruction, false); }
  }
  const before = f.engine.store.getSnapshot('session').messages;
  assert.deepEqual(before.filter(message => message.role === 'user').map(message => [message.content, message.attachments]), Array.from({ length: 6 }, (_, index) => ['Exact user goal ' + index + ' 🌊', [ref]]));
  const diagnostics = f.engine.context.diagnostics('session')!;
  assert.equal(diagnostics.mediaHistory?.omittedImageOccurrences, 5);
  assert.equal(diagnostics.mediaHistory?.activeCutoffCreated, false);
  assert.equal(diagnostics.plan.inputEstimate.complete, false);
  assert.equal(diagnostics.plan.inputEstimate.imageTokens, null);
  const revision = f.engine.store.getLatestContextRevision('session')!;
  assert.ok(revision.sourceIds.some(id => id.startsWith('image-policy:')));
  assert.ok(revision.sourceIds.some(id => id.startsWith('image-message:')));
  for (const value of [before, diagnostics, revision]) assert.equal(JSON.stringify(value).includes(bytes.toString('base64')), false);
  await f.reopen();
  assert.deepEqual(f.engine.store.getSnapshot('session').messages, before);
  assert.deepEqual(f.engine.context.diagnostics('session'), diagnostics);
  // A text-only continuation still receives the latest historical image pixels.
  assert.equal((await submit(f.engine, 6)).state, 'completed');
  assert.equal(f.requests.length, 7);
  assert.deepEqual(f.requests.at(-1)?.resolvedImages, [{ attachment: ref, data: bytes.toString('base64') }]);
  assert.equal(notice(f.requests.at(-1)!).omissions.length, 5);
});

test('required media metadata overflow stops before provider dispatch and preserves the last context plus original input', async t => {
  const f = await fixture(t, { ...policy, maxMetadataBytes: 1024 }), ref = await f.engine.importImage('session', png(), 'image/png');
  assert.equal((await submit(f.engine, 0, [ref])).state, 'completed');
  const revision = f.engine.store.getLatestContextRevision('session')!;
  const failed = await submit(f.engine, 1, [ref]);
  assert.equal(failed.state, 'failed'); assert.equal(failed.error?.code, 'IMAGE_HISTORY_METADATA_LIMIT');
  assert.equal(f.requests.length, 1);
  assert.equal(f.engine.store.getLatestContextRevision('session')?.id, revision.id);
  assert.equal(f.engine.store.getSnapshot('session').messages.filter(message => message.attachments?.length).length, 2);
  assert.equal(f.engine.context.memory.active('session'), null);
});

test('engine clones and validates the host policy at construction rather than adopting later caller mutations', async t => {
  const hostPolicy = { ...policy }, f = await fixture(t, hostPolicy), ref = await f.engine.importImage('session', png(), 'image/png');
  hostPolicy.maxImageOccurrences = 0;
  assert.equal((await submit(f.engine, 0, [ref])).state, 'completed');
  assert.equal((await submit(f.engine, 1, [ref])).state, 'completed');
  assert.equal(notice(f.requests.at(-1)!).omissions.length, 1);
});
