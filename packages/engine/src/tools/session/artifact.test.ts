import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type ArtifactIdentity, type ArtifactReference, type JsonObject } from '@moodcode/contracts';
import { ArtifactStore } from '../../artifacts/store.js';
import { SqliteStore } from '../../storage/index.js';
import type { ToolContext } from '../../ports.js';
import { createArtifactReadTool } from './artifact.js';

const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
const config = { providerId: 'scripted', modelId: 'fixture', mode: 'plan' as const, limits: { ...DEFAULT_LIMITS } };
async function fixture(t: TestContext, bytes: string | Uint8Array = 'Historical file observation\n한글 🌊\n', options: { retentionMs?: number; now?: () => number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-artifact-tool-')));
  const directory = join(root, 'artifacts'), workspaceRoot = join(root, 'workspace'); await mkdir(workspaceRoot);
  const store = new SqliteStore(join(root, 'engine.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = store.putWorkspace({ id: 'workspace', root: workspaceRoot, gitRoot: workspaceRoot, branch: null, createdAt: new Date().toISOString() });
  const session = store.createSession({ id: 'session', workspaceId: workspace.id, title: 'Fixture', createdAt: new Date().toISOString() });
  const otherSession = store.createSession({ ...session, id: 'other-session' });
  const past = store.admit({ sessionId: session.id, requestId: 'past', prompt: 'past observation', config });
  store.commit(past.runId, 'run.started', {}, { run: { state: 'running' } }); store.commit(past.runId, 'run.completed', {}, { run: { state: 'completed' } });
  const other = store.admit({ sessionId: otherSession.id, requestId: 'other', prompt: 'other observation', config });
  store.commit(other.runId, 'run.started', {}, { run: { state: 'running' } }); store.commit(other.runId, 'run.completed', {}, { run: { state: 'completed' } });
  const current = store.admit({ sessionId: session.id, requestId: 'current', prompt: 'read historical artifact', config });
  const artifacts = await ArtifactStore.open({ directory, ...options });
  const identity: ArtifactIdentity = { sessionId: session.id, runId: past.runId, toolCallId: 'past-internal-tool', turnId: 'past-turn', attemptId: 'past-attempt' };
  const item = await artifacts.put({ identity, content: bytes });
  const context: ToolContext = { workspace, sessionId: session.id, runId: current.runId, toolCallId: 'current-internal-tool', turnId: 'current-turn', attemptId: 'current-attempt',
    signal: new AbortController().signal, limits: { ...DEFAULT_LIMITS }, artifactDir: directory, recordCheckpoint() { assert.fail('Artifact read must not create a checkpoint'); } };
  const input = { artifactId: item.reference.id, runId: identity.runId, toolCallId: identity.toolCallId, turnId: identity.turnId, attemptId: identity.attemptId };
  return { root, directory, store, artifacts, context, identity, input, reference: item.reference, otherSession, otherRunId: other.runId,
    tool: createArtifactReadTool(store, async () => artifacts) };
}

test('same-session historical artifact uses its full old identity while prepared owner is the current run', async t => {
  const f = await fixture(t); const before = f.store.getSnapshot(f.context.sessionId);
  const prepared = await f.tool.prepare(f.input, f.context); assert.equal(prepared.requiresApproval, false);
  const result = await f.tool.execute(prepared, f.context); const page = result.data as JsonObject;
  assert.equal(page.historicalObservation, true); assert.equal(page.encoding, 'base64'); assert.equal(page.offset, 0); assert.equal(page.nextOffset, null);
  assert.equal(Buffer.from(page.bytes as string, 'base64').toString('utf8'), 'Historical file observation\n한글 🌊\n');
  assert.deepEqual((page.reference as unknown as ArtifactReference).identity, f.identity);
  assert.equal(result.content, JSON.stringify(page)); assert.deepEqual(f.store.getSnapshot(f.context.sessionId), before);
});

test('base64 byte pages reconstruct UTF-8 and binary bytes without assuming scalar-aligned offsets', async t => {
  const bytes = Buffer.concat([Buffer.from('한글 🌊'), Buffer.from([0, 255, 128, 1])]); const f = await fixture(t, bytes);
  const collected: Buffer[] = []; let offset = 0;
  while (true) {
    const prepared = await f.tool.prepare({ ...f.input, offset, limit: 3 }, { ...f.context, toolCallId: `page-${offset}` });
    const result = await f.tool.execute(prepared, { ...f.context, toolCallId: `page-${offset}` }); const page = result.data as JsonObject;
    const buffer = Buffer.from(page.bytes as string, 'base64'); assert.ok(buffer.length <= 3); collected.push(buffer);
    if (page.nextOffset === null) break;
    assert.equal(page.nextOffset, offset + buffer.length); offset = page.nextOffset as number;
  }
  assert.deepEqual(Buffer.concat(collected), bytes);
  const eof = await f.tool.execute(await f.tool.prepare({ ...f.input, offset: bytes.length, limit: 3 }, f.context), f.context);
  assert.deepEqual({ bytes: (eof.data as JsonObject).bytes, nextOffset: (eof.data as JsonObject).nextOffset }, { bytes: '', nextOffset: null });
});

test('different session cannot read old reference even if it knows the complete artifact identity', async t => {
  const f = await fixture(t);
  await assert.rejects(f.tool.prepare(f.input, { ...f.context, sessionId: f.otherSession.id, runId: f.otherRunId }), code('RECORD_SCOPE_MISMATCH'));
  const artifact = await f.artifacts.put({ identity: { ...f.identity, sessionId: f.otherSession.id, runId: f.otherRunId }, content: 'OTHER_SESSION_PRIVATE' });
  await assert.rejects(f.tool.prepare({ ...f.input, artifactId: artifact.reference.id, runId: f.otherRunId }, f.context), code('RECORD_SCOPE_MISMATCH'));
  // Falsely claim a same-session run: the managed manifest still binds all old fields.
  const prepared = await f.tool.prepare({ ...f.input, artifactId: artifact.reference.id }, f.context);
  await assert.rejects(f.tool.execute(prepared, f.context), code('ARTIFACT_OWNER_MISMATCH'));
});

for (const field of ['runId', 'toolCallId', 'turnId', 'attemptId'] as const) test(`historical ${field} must match its manifest`, async t => {
  const f = await fixture(t);
  const input = { ...f.input, [field]: field === 'runId' ? f.context.runId : 'incorrect-identity' };
  await assert.rejects(f.tool.execute(await f.tool.prepare(input, f.context), f.context), code('ARTIFACT_OWNER_MISMATCH'));
});

test('omitted optional identity does not match an artifact produced with native turn/attempt fields', async t => {
  const f = await fixture(t); const { turnId: _turn, attemptId: _attempt, ...input } = f.input;
  await assert.rejects(f.tool.execute(await f.tool.prepare(input, f.context), f.context), code('ARTIFACT_OWNER_MISMATCH'));
  const legacy = await f.artifacts.put({ identity: { sessionId: f.identity.sessionId, runId: f.identity.runId, toolCallId: 'legacy-tool' }, content: 'legacy observation' });
  const prepared = await f.tool.prepare({ ...input, artifactId: legacy.reference.id, toolCallId: 'legacy-tool' }, f.context);
  assert.equal(Buffer.from(((await f.tool.execute(prepared, f.context)).data as JsonObject).bytes as string, 'base64').toString(), 'legacy observation');
});

test('prepared reads reject cloned, mutated, reused and changed current execution owners', async t => {
  const f = await fixture(t);
  const prepared = await f.tool.prepare(f.input, f.context);
  await assert.rejects(f.tool.execute(structuredClone(prepared), f.context), code('ARTIFACT_REQUEST_STALE'));
  prepared.preview.offset = 12; await assert.rejects(f.tool.execute(prepared, f.context), code('ARTIFACT_REQUEST_STALE'));
  for (const field of ['sessionId', 'runId', 'toolCallId', 'turnId', 'attemptId'] as const) {
    const fresh = await f.tool.prepare(f.input, f.context); await assert.rejects(f.tool.execute(fresh, { ...f.context, [field]: 'changed-owner' }), code('ARTIFACT_REQUEST_STALE'));
  }
  for (const workspace of [{ ...f.context.workspace, id: 'other-workspace' }, { ...f.context.workspace, root: join(f.root, 'other-root') }]) {
    const fresh = await f.tool.prepare(f.input, f.context); await assert.rejects(f.tool.execute(fresh, { ...f.context, workspace }), code('ARTIFACT_REQUEST_STALE'));
  }
  const fresh = await f.tool.prepare(f.input, f.context); await f.tool.execute(fresh, f.context);
  await assert.rejects(f.tool.execute(fresh, f.context), code('ARTIFACT_REQUEST_STALE'));
});

test('invalid offsets, limits, fields and native attempt without turn are rejected before artifact access', async t => {
  const f = await fixture(t);
  for (const extra of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 16385 }, { limit: 2.5 }, { path: '/private' }, { toolCallId: '' }, { runId: 'bad\nrun' }]) {
    await assert.rejects(f.tool.prepare({ ...f.input, ...extra }, f.context), code('INVALID_ARTIFACT_INPUT'));
  }
  const { turnId: _turn, ...withoutTurn } = f.input; await assert.rejects(f.tool.prepare(withoutTurn, f.context), code('INVALID_ARTIFACT_INPUT'));
  await assert.rejects(f.tool.prepare({ ...f.input, runId: 'missing-run' }, f.context), code('RUN_NOT_FOUND'));
  await assert.rejects(f.tool.execute(await f.tool.prepare({ ...f.input, offset: f.reference.storedBytes + 1 }, f.context), f.context), code('INVALID_ARTIFACT'));
  await assert.rejects(f.tool.execute(await f.tool.prepare({ ...f.input, artifactId: '../manifest.json' }, f.context), f.context), code('INVALID_ARTIFACT_ID'));
});

test('caller cancellation before prepare or during a real read cannot return artifact bytes', async t => {
  const f = await fixture(t, Buffer.alloc(262_144, 1));
  const before = new AbortController(); before.abort(); await assert.rejects(f.tool.prepare(f.input, { ...f.context, signal: before.signal }), code('CANCELLED'));
  const during = new AbortController(), context = { ...f.context, signal: during.signal };
  const prepared = await f.tool.prepare(f.input, context), reading = f.tool.execute(prepared, context);
  await nextTick(); during.abort(); await assert.rejects(reading, code('ARTIFACT_CANCELLED'));
  await assert.rejects(f.tool.execute(prepared, context), code('ARTIFACT_REQUEST_STALE'));
  assert.equal((await f.artifacts.get(f.reference.id, f.identity)).sha256, f.reference.sha256);
});

test('content tampering after prepare is rejected even for a small page outside the modified bytes', async t => {
  const f = await fixture(t, '0123456789'); const prepared = await f.tool.prepare({ ...f.input, limit: 1 }, f.context);
  await writeFile(join(f.directory, f.reference.id, 'content'), '012345678X');
  await assert.rejects(f.tool.execute(prepared, f.context), code('ARTIFACT_INTEGRITY_FAILED'));
});

test('manifest identity tampering and content symlinks cannot escape the prepared reference', async t => {
  const f = await fixture(t); const manifestPath = join(f.directory, f.reference.id, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { reference: ArtifactReference };
  manifest.reference.identity.attemptId = 'other-attempt'; await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(f.tool.execute(await f.tool.prepare(f.input, f.context), f.context), code('ARTIFACT_OWNER_MISMATCH'));
  manifest.reference.identity.attemptId = f.identity.attemptId; await writeFile(manifestPath, JSON.stringify(manifest));
  const external = join(f.root, 'outside'); await writeFile(external, 'private external bytes');
  const content = join(f.directory, f.reference.id, 'content'); await unlink(content); await symlink(external, content);
  await assert.rejects(f.tool.execute(await f.tool.prepare(f.input, f.context), f.context), code('ARTIFACT_PATH_UNSAFE'));
  assert.equal(await readFile(external, 'utf8'), 'private external bytes');
});

test('retention expiry after prepare is rechecked before returning historical evidence', async t => {
  let now = 1000; const f = await fixture(t, 'past', { retentionMs: 100, now: () => now });
  const prepared = await f.tool.prepare(f.input, f.context); now = 1101;
  await assert.rejects(f.tool.execute(prepared, f.context), code('ARTIFACT_EXPIRED'));
});
