import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { JsonObject } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import { png } from '../media/fixtures.js';
import type { ProviderAdapter, TurnRequest } from '../ports.js';
import type { SemanticCheckpoint } from '../context/semantic-memory.js';

for (const mode of ['default', 'opt-in'] as const) test(`actual ${mode} cross-Run latest image survives restart and forty text/tool turns`, { timeout: 20000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-cross-run-image-'))), repository = join(root, 'repository'), dbPath = join(root, 'engine.sqlite');
  await mkdir(repository); for (let index = 0; index < 80; index++) await writeFile(join(repository, `observed-${index}.txt`), 'Bounded local text observation '.repeat(60));
  let fullReads = 0, frames = 0, currentRunId: string | undefined, finalRequest: TurnRequest | undefined;
  const provider: ProviderAdapter = { id: 'cross-run-vision', inputModalities: ['text', 'image'], async *streamTurn(request) {
    assert.equal(request.resolvedImages?.length, 1); frames++;
    if (request.runId === currentRunId && request.turnIndex < 40) {
      for (let index = request.turnIndex * 2; index < request.turnIndex * 2 + 2; index++) yield { type: 'tool.call', call: { id: `observation-${index}`, name: 'read_file', input: { path: `observed-${index}.txt` } } };
      yield { type: 'finish', reason: 'tool_calls' };
    } else { finalRequest = structuredClone(request); yield { type: 'text.delta', delta: 'Image retained' }; yield { type: 'finish', reason: 'stop' }; }
  } };
  const options = { dbPath, artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: ['read_file'],
    defaults: { providerId: provider.id, modelId: 'vision', mode: 'plan' as const, limits: { maxTurns: 48, maxToolCalls: 96, maxOutputBytes: 1_048_576, maxContextBytes: 16_384 } },
    ...(mode === 'opt-in' ? { mediaHistoryPolicy: { kind: 'reference-only-older-images' as const, version: 1 as const } } : {}) };
  let engine = createEngine(options);
  t.after(async () => { try { await engine.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const createdAt = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Cross Run image', createdAt });
  const bytes = png(), image = await engine.importImage('session', bytes, 'image/png');
  const old = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'old-image', prompt: 'Exact original image constraint', attachments: [image], config: engine.getCapabilities().defaults });
  assert.equal((await engine.waitForRun(old.runId)).state, 'completed');
  const oldImageMessageId = engine.context.diagnostics('session')!.sessionImageAnchor!.messageId;
  await engine.close(); engine = createEngine(options);
  engine.store.getSnapshot = () => { fullReads++; throw new Error('Cross Run images require bounded SQL'); };
  const current = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'current-text', prompt: 'Continue with exact text-only goal', config: engine.getCapabilities().defaults }); currentRunId = current.runId;
  const completed = await engine.waitForRun(current.runId); assert.equal(completed.state, 'completed', JSON.stringify(completed.error)); assert.ok(finalRequest);
  assert.equal(frames, 42); assert.equal(fullReads, 0); assert.equal(engine.coordinator.getRunUsage(current.runId).toolCalls, 80);
  assert.deepEqual(finalRequest.resolvedImages, [{ attachment: image, data: bytes.toString('base64') }]);
  assert.deepEqual(finalRequest.messages.filter(message => message.attachments?.length).map(message => [message.content, message.attachments]), [['Exact original image constraint', [image]]]);
  assert.ok(finalRequest.messages.some(message => message.content === 'Continue with exact text-only goal'));
  const diagnostics = engine.context.diagnostics('session')!; assert.equal(diagnostics.sessionImageAnchor?.messageId, oldImageMessageId);
  assert.equal(diagnostics.sessionImageAnchor?.runId, old.runId); assert.ok(diagnostics.activeWindow); assert.ok(diagnostics.omittedDatabaseMessages > 0);
  assert.ok(Buffer.byteLength(JSON.stringify({ messages: finalRequest.messages, tools: finalRequest.tools })) <= 16_384);
  assert.deepEqual(engine.store.getInput(old.inputId).attachments, [image]);
  assert.equal(engine.store.getLatestContextRevision('session')!.text.includes(bytes.toString('base64')), false);
});

test('a previously persisted completed-history cutoff cannot stand in for latest session pixels', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-image-cutoff-'))), dbPath = join(root, 'engine.sqlite');
  let finalRequest: TurnRequest | undefined;
  const provider: ProviderAdapter = { id: 'cutoff-vision', inputModalities: ['text', 'image'], async *streamTurn(request) {
    finalRequest = structuredClone(request); yield { type: 'text.delta', delta: 'Done' }; yield { type: 'finish', reason: 'stop' };
  } };
  const engine = createEngine({ dbPath, artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: [], defaults: { providerId: provider.id, modelId: 'vision', mode: 'plan' } });
  t.after(async () => { try { await engine.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const createdAt = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Cutoff', createdAt });
  const bytes = png(), image = await engine.importImage('session', bytes, 'image/png');
  const old = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'image', prompt: 'Exact unsummarizable pixels and text', attachments: [image], config: engine.getCapabilities().defaults });
  assert.equal((await engine.waitForRun(old.runId)).state, 'completed');
  // Imported historical memory is a fixture, not proof that a text summary ever
  // observed these pixels. The normal model dispatch must retain the raw image.
  const summaryText = 'Previously persisted historical text memory', revisionId = 'historical-cutoff';
  engine.store.putContextRevision({ schemaVersion: 2, id: revisionId, sessionId: 'session', revision: engine.store.getLatestContextRevision('session')!.revision + 1, kind: 'summary', text: summaryText,
    sourceIds: [], sha256: createHash('sha256').update(summaryText).digest('hex'), createdAt });
  const checkpoint: SemanticCheckpoint = { id: 'imported-memory', revisionId, version: 1, sessionId: 'session', runId: old.runId,
    providerId: provider.id, modelId: 'vision', sourceRunIds: [old.runId], sourceMessageIds: [engine.context.diagnostics('session')!.sessionImageAnchor!.messageId], cutoffRunId: old.runId,
    sourceSha256: 'a'.repeat(64), createdAt, usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null } };
  engine.store.putSessionDocument('session', 'context.memory', 0, { active: JSON.parse(JSON.stringify(checkpoint)) as JsonObject });
  engine.store.getSnapshot = () => { throw new Error('No full history reads'); };
  const current = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'text', prompt: 'New text-only Run', config: engine.getCapabilities().defaults });
  assert.equal((await engine.waitForRun(current.runId)).state, 'completed'); assert.ok(finalRequest);
  assert.deepEqual(finalRequest.resolvedImages, [{ attachment: image, data: bytes.toString('base64') }]);
  assert.ok(finalRequest.messages.some(message => message.content === 'Exact unsummarizable pixels and text' && message.attachments?.[0]?.id === image.id));
  assert.ok(finalRequest.messages.some(message => message.content.includes(summaryText)));
  assert.equal(engine.context.memory.active('session')?.checkpoint.id, checkpoint.id);
});

for (const failure of ['unsupported-provider', 'context-cap'] as const) test(`actual new text Run rejects retained session image ${failure} before another provider request`, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-image-required-failure-'))), dbPath = join(root, 'engine.sqlite');
  let calls = 0;
  const provider: ProviderAdapter = { id: 'image-failure', inputModalities: ['text', 'image'], async *streamTurn() {
    calls++; yield { type: 'text.delta', delta: 'Done' }; yield { type: 'finish', reason: 'stop' };
  } };
  const options = { dbPath, artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: [], defaults: { providerId: provider.id, modelId: 'vision', mode: 'plan' as const } };
  let engine = createEngine(options);
  t.after(async () => { try { await engine.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const createdAt = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Image limits', createdAt });
  const image = await engine.importImage('session', png(), 'image/png');
  const old = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'image', prompt: failure === 'context-cap' ? 'Exact long image constraint '.repeat(300) : 'Original image', attachments: [image], config: engine.getCapabilities().defaults });
  assert.equal((await engine.waitForRun(old.runId)).state, 'completed'); assert.equal(calls, 1);
  await engine.close();
  engine = createEngine({ ...options, providers: [{ ...provider, inputModalities: failure === 'unsupported-provider' ? ['text'] : ['text', 'image'] }] });
  const head = engine.store.getSessionDocument('session', 'context.head');
  engine.store.getSnapshot = () => { throw new Error('No full history reads'); };
  const config = engine.getCapabilities().defaults;
  const current = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'new-text', prompt: 'New text Run', config: { ...config,
    ...(failure === 'context-cap' ? { limits: { ...config.limits, maxContextBytes: 4096 } } : {}) } });
  const run = await engine.waitForRun(current.runId); assert.equal(run.state, 'failed');
  assert.equal(run.error?.code, failure === 'unsupported-provider' ? 'PROVIDER_UNSUPPORTED_INPUT' : 'IMAGE_CONTEXT_LIMIT'); assert.equal(calls, 1);
  assert.deepEqual(engine.store.getInput(old.inputId).attachments, [image]);
  if (failure === 'context-cap') assert.deepEqual(engine.store.getSessionDocument('session', 'context.head'), head);
});
