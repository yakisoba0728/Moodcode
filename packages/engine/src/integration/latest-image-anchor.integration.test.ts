import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { InputImageAttachment, JsonObject } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { MediaHistoryPolicy } from '../context/media-history.js';
import { png } from '../media/fixtures.js';
import type { ProviderAdapter, TurnRequest } from '../ports.js';

function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function waitOrAbort(promise: Promise<void>, signal: AbortSignal) {
  let abort!: () => void;
  try { await Promise.race([promise, new Promise<void>(resolve => { abort = resolve; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]); }
  finally { signal.removeEventListener('abort', abort); }
}
const policy: MediaHistoryPolicy = { kind: 'reference-only-older-images', version: 1 };

for (const mode of ['default', 'opt-in'] as const) test(`actual ${mode} image history keeps a middle image steer through forty complete tool turns and a later text steer`, { timeout: 20000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-latest-image-anchor-'))), repository = join(root, 'repository'), dbPath = join(root, 'engine.sqlite');
  await mkdir(repository);
  const middleEntered = gate(), middleRelease = gate(), laterEntered = gate(), laterRelease = gate();
  const fileContent = 'Synthetic bounded local observation '.repeat(60);
  for (let index = 0; index < 80; index++) await writeFile(join(repository, `observed-${index}.txt`), fileContent);
  let providerCalls = 0, fullReads = 0, finalRequest: TurnRequest | undefined;
  const provider: ProviderAdapter = { id: 'local-latest-image', inputModalities: ['text', 'image'], async *streamTurn(request, signal) {
    providerCalls++; assert.deepEqual(request.tools.map(tool => tool.name), ['read_file']);
    if (request.turnIndex === 2) { middleEntered.resolve(); yield { type: 'progress' }; await waitOrAbort(middleRelease.promise, signal); }
    if (request.turnIndex === 39) { laterEntered.resolve(); yield { type: 'progress' }; await waitOrAbort(laterRelease.promise, signal); }
    if (signal.aborted) return;
    if (request.turnIndex < 40) {
      for (let index = request.turnIndex * 2; index < request.turnIndex * 2 + 2; index++) yield { type: 'tool.call', call: { id: `observed-call-${index}`, name: 'read_file', input: { path: `observed-${index}.txt` } } };
      yield { type: 'finish', reason: 'tool_calls' };
    } else { finalRequest = structuredClone(request); yield { type: 'text.delta', delta: 'Finished local image-anchor observation' }; yield { type: 'finish', reason: 'stop' }; }
  } };
  const engine = createEngine({ dbPath, artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: ['read_file'],
    defaults: { providerId: provider.id, modelId: 'fixture-vision', mode: 'plan', limits: { maxTurns: 48, maxToolCalls: 96, maxOutputBytes: 1_048_576, maxContextBytes: 16_384 } },
    ...(mode === 'opt-in' ? { mediaHistoryPolicy: policy } : {}),
  });
  t.after(async () => { middleRelease.resolve(); laterRelease.resolve(); try { await engine.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const createdAt = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Latest image fixture', createdAt });
  engine.store.getSnapshot = () => { fullReads++; throw new Error('Latest image protection must use bounded source windows'); };
  const bytes = png(), image = await engine.importImage('session', bytes, 'image/png');
  const receipt = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'original-goal', prompt: 'Exact text-only original goal', config: engine.getCapabilities().defaults });
  // Race against actual completion so an early budget/protocol regression cannot
  // leave a fixture waiting forever for a gate that no longer exists.
  const finished = engine.waitForRun(receipt.runId);
  await Promise.race([middleEntered.promise, finished.then(run => assert.fail(`Run ended before image steer: ${run.state}/${run.error?.code}`))]);
  const middle = engine.scheduler.accept({ sessionId: 'session', requestId: 'middle-image', prompt: 'Exact middle image steer', attachments: [image], delivery: 'steer', config: engine.getCapabilities().defaults }); middleRelease.resolve();
  await Promise.race([laterEntered.promise, finished.then(run => assert.fail(`Run ended before text steer: ${run.state}/${run.error?.code}`))]);
  const later = engine.scheduler.accept({ sessionId: 'session', requestId: 'later-text', prompt: 'Exact latest text-only steer', delivery: 'steer', config: engine.getCapabilities().defaults }); laterRelease.resolve();
  const completed = await finished; assert.equal(completed.state, 'completed', JSON.stringify(completed.error)); assert.ok(finalRequest);
  assert.equal(providerCalls, 41); assert.equal(fullReads, 0); assert.equal(engine.coordinator.getRunUsage(receipt.runId).toolCalls, 80);
  assert.deepEqual(finalRequest.messages.filter(message => message.attachments?.length).map(message => [message.content, message.attachments]), [['Exact middle image steer', [image]]]);
  assert.deepEqual(finalRequest.resolvedImages, [{ attachment: image, data: bytes.toString('base64') }]);
  assert.equal(engine.store.getInput(middle.inputId).runId, receipt.runId); assert.equal(engine.store.getInput(later.inputId).runId, receipt.runId);
  const diagnostics = engine.context.diagnostics('session')!; assert.ok(diagnostics.activeWindow); assert.ok(diagnostics.activeWindow.omittedMessages > 0);
  assert.deepEqual(diagnostics.activeWindow.requiredImageAnchorIds, [middle.inputId]);
  assert.ok(diagnostics.activeWindow.requiredAnchorIds.includes(later.inputId)); assert.equal(diagnostics.activeWindow.summarized, false);
  assert.ok(diagnostics.activeWindow.selectedJsonBytes <= 65_536); assert.ok(Buffer.byteLength(JSON.stringify({ messages: finalRequest.messages, tools: finalRequest.tools })) <= 16_384);
  assert.ok(finalRequest.messages.some(message => message.content === 'Exact text-only original goal')); assert.ok(finalRequest.messages.some(message => message.content === 'Exact latest text-only steer'));
  for (const message of finalRequest.messages.filter(message => message.role === 'assistant')) for (const call of message.toolCalls ?? []) assert.equal(finalRequest.messages.filter(result => result.role === 'tool' && result.toolCallId === call.id).length, 1);
  const revision = engine.store.getLatestContextRevision('session')!, modelMessages = JSON.parse(revision.text) as TurnRequest['messages'];
  assert.deepEqual(modelMessages.find(message => message.content === 'Exact middle image steer')?.attachments, [image]);
  assert.equal(revision.text.includes(bytes.toString('base64')), false); assert.equal(engine.context.memory.active('session'), null);
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const original = JSON.parse(String(reader.prepare('SELECT data FROM messages WHERE id=? AND session_id=? AND run_id=?').get(middle.inputId, 'session', receipt.runId)?.data)) as { content: string; attachments: InputImageAttachment[] };
    assert.equal(original.content, 'Exact middle image steer'); assert.deepEqual(original.attachments, [image]);
    const storedConfig = JSON.parse(String(reader.prepare('SELECT data FROM messages WHERE id=?').get(later.inputId)?.data)) as JsonObject;
    assert.equal(storedConfig.attachments, undefined);
  } finally { reader.close(); }
  assert.equal(await readFile(join(repository, 'observed-0.txt'), 'utf8'), fileContent);
});
