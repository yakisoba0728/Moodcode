import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, readFile, writeFile, readdir, lstat, symlink, unlink, link, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactIdentity, Checkpoint, JsonValue } from '@moodcode/contracts';
import { ArtifactStore, bindCheckpointArtifacts, createToolResultEnvelope, enrichLegacyToolResult, projectToolResult } from './index.js';
const owner: ArtifactIdentity = { sessionId: 'session-a', runId: 'run-a', toolCallId: 'tool-a', turnId: 'turn-a', attemptId: 'attempt-a' };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
async function fixture(t: test.TestContext) { const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-artifact-'))); t.after(() => rm(root, { recursive: true, force: true })); return { root, directory: join(root, 'store') }; }
const errorCode = (expected: string) => (error: unknown) => { assert.equal((error as { code: string }).code, expected); return true; };
test('complete artifact survives reopening with exact bytes, SHA, identity and private permissions', async t => {
  const { directory } = await fixture(t); const store = await ArtifactStore.open({ directory }); const item = await store.put({ identity: owner, content: 'Hello 🌙' });
  assert.equal(item.reference.sha256, hash('Hello 🌙')); assert.equal(item.reference.complete, true); assert.equal('path' in item.reference, false);
  assert.deepEqual((await (await ArtifactStore.open({ directory })).read(item.reference.id, { identity: owner })).bytes, Buffer.from('Hello 🌙'));
  assert.equal((await lstat(join(directory, item.reference.id, 'content'))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(directory, item.reference.id))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(directory), [item.reference.id]);
});
test('producer, stored artifact, display and model budgets count separate losses', async t => {
  const { directory } = await fixture(t); const store = await ArtifactStore.open({ directory, limits: { maxProducerBytes: 8, maxArtifactBytes: 5, maxDisplayBytes: 7, maxModelBytes: 3 } });
  const item = await store.put({ identity: owner, content: '0123456789' });
  assert.equal(item.reference.observedBytes, 10); assert.equal(item.reference.producerTruncatedBytes, 2); assert.equal(item.reference.artifactTruncatedBytes, 3); assert.equal(item.reference.storedBytes, 5);
  assert.equal(item.modelContent, '012'); assert.equal(item.displayContent, '0123456'); assert.equal(item.reference.complete, false);
  assert.equal(Buffer.from((await store.read(item.reference.id)).bytes).toString(), '01234');
});
test('rendered UTF8 previews never exceed byte budgets and raw pages preserve invalid UTF8', async t => {
  const { directory } = await fixture(t); const store = await ArtifactStore.open({ directory, limits: { maxDisplayBytes: 4, maxModelBytes: 3, maxReadBytes: 2 } });
  const raw = Buffer.from([0xff, 0xff, 0x61]); const item = await store.put({ identity: owner, content: raw });
  assert.ok(Buffer.byteLength(item.displayContent) <= 4); assert.ok(Buffer.byteLength(item.modelContent) <= 3); assert.equal(item.truncation.modelTruncated, true);
  const page = await store.read(item.reference.id); assert.deepEqual(page.bytes, raw.subarray(0, 2)); assert.equal(page.nextOffset, 2);
  assert.deepEqual((await store.read(item.reference.id, { offset: 2 })).bytes, raw.subarray(2));
  const unicode = await store.put({ identity: owner, content: '🌙🌙' }); assert.equal(unicode.modelContent, ''); assert.equal(unicode.displayContent, '🌙');
});
test('stream truncation does not invent unobserved total bytes', async t => {
  const { directory } = await fixture(t); const store = await ArtifactStore.open({ directory, limits: { maxProducerBytes: 3 } }); let returned = false;
  const source = { async *[Symbol.asyncIterator]() { try { yield 'abcdef'; yield 'not observed'; } finally { returned = true; } } };
  const item = await store.put({ identity: owner, content: source }); assert.equal(item.reference.producerTruncatedBytes, null); assert.equal(item.reference.observedBytes, 6); assert.equal(item.reference.storedBytes, 3); assert.equal(item.reference.complete, false); assert.equal(returned, true);
});
test('failed stream stores reviewable partial output without exposing error text', async t => {
  const { directory } = await fixture(t); const store = await ArtifactStore.open({ directory });
  const item = await store.put({ identity: owner, content: { async *[Symbol.asyncIterator]() { yield 'before'; throw new Error('SECRET_ERROR'); } } });
  assert.equal(item.reference.outcome, 'failed'); assert.equal(item.reference.complete, false); assert.equal(item.reference.producerTruncatedBytes, null); assert.equal(item.modelContent, 'before'); assert.ok(!item.warnings.join(' ').includes('SECRET_ERROR'));
});
test('noncooperating stream is interruptible and return cleanup never blocks publication', async t => {
  const { directory } = await fixture(t); const store = await ArtifactStore.open({ directory }); const controller = new AbortController();
  let blocked!: () => void; const entered = new Promise<void>(resolve => { blocked = resolve; });
  const source = { [Symbol.asyncIterator]() { let first = true; return { next() { if (first) { first = false; return Promise.resolve({ done: false as const, value: 'partial' }); } blocked(); return new Promise<IteratorResult<string>>(() => {}); }, return() { return new Promise<IteratorResult<string>>(() => {}); } }; } };
  const putting = store.put({ identity: owner, content: source, signal: controller.signal }); await entered; controller.abort();
  const item = await putting; assert.equal(item.reference.outcome, 'interrupted'); assert.equal(item.modelContent, 'partial');
});
test('empty stream chunks cannot evade producer work limit and last observed chunk is counted', async t => {
  const { directory } = await fixture(t); const store = await ArtifactStore.open({ directory, limits: { maxProducerChunks: 2 } });
  const item = await store.put({ identity: owner, content: { async *[Symbol.asyncIterator]() { yield ''; yield ''; yield 'x'; while (true) yield ''; } } });
  assert.equal(item.reference.observedBytes, 1); assert.equal(item.reference.storedBytes, 0); assert.equal(item.reference.producerTruncatedBytes, null);
});
test('upstream truncated source remains partial even when retained bytes fit', async t => {
  const { directory } = await fixture(t); const store = await ArtifactStore.open({ directory }); const item = await store.put({ identity: owner, content: 'known', sourceComplete: false }); assert.equal(item.reference.complete, false); assert.equal(item.reference.producerTruncatedBytes, null);
});
test('expiry denies reads, prune removes only expired valid managed artifacts', async t => {
  const { root, directory } = await fixture(t); let now = 1_000; const store = await ArtifactStore.open({ directory, retentionMs: 100, now: () => now });
  const expired = await store.put({ identity: owner, content: 'old' }); now = 1_050; const active = await store.put({ identity: owner, content: 'new' });
  const outside = join(root, 'outside'); await writeFile(outside, 'keep'); const fake = 'artifact_' + 'a'.repeat(32); await symlink(outside, join(directory, fake)); await writeFile(join(directory, 'unrelated'), 'keep');
  const malformed = 'artifact_' + 'b'.repeat(32); await mkdir(join(directory, malformed)); await writeFile(join(directory, malformed, 'manifest.json'), '{}'); now = 1_101;
  await assert.rejects(store.get(expired.reference.id), errorCode('ARTIFACT_EXPIRED')); const result = await store.prune(); assert.deepEqual(result.removed, [expired.reference.id]); assert.ok(result.warnings.length > 0);
  assert.equal((await store.get(active.reference.id)).complete, true); assert.equal(await readFile(outside, 'utf8'), 'keep'); assert.ok((await readdir(directory)).includes('unrelated'));
});
test('bounded prune scan reports remaining work', async t => { const { directory } = await fixture(t); const store = await ArtifactStore.open({ directory, limits: { maxScanEntries: 1 } }); await writeFile(join(directory, 'a'), ''); await writeFile(join(directory, 'b'), ''); const result = await store.prune(); assert.equal(result.scanned, 1); assert.equal(result.scanTruncated, true); });
test('owner mismatch includes optional turn and attempt identities', async t => { const { directory } = await fixture(t); const store = await ArtifactStore.open({ directory }); const item = await store.put({ identity: owner, content: '' }); await assert.rejects(store.get(item.reference.id, { ...owner, attemptId: 'other' }), errorCode('ARTIFACT_OWNER_MISMATCH')); await assert.rejects(store.get('../content'), errorCode('INVALID_ARTIFACT_ID')); });
test('manifest and same-size content tampering are rejected', async t => {
  const { directory } = await fixture(t); const store = await ArtifactStore.open({ directory }); const item = await store.put({ identity: owner, content: 'aaaa' }); const path = join(directory, item.reference.id);
  await writeFile(join(path, 'content'), 'bbbb'); await assert.rejects(store.read(item.reference.id), errorCode('ARTIFACT_INTEGRITY_FAILED'));
  const data = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')); data.reference.storedBytes = 100; await writeFile(join(path, 'manifest.json'), JSON.stringify(data)); await assert.rejects(store.get(item.reference.id), errorCode('INVALID_ARTIFACT'));
});
test('nofollow opens reject content symlinks and hardlinks while outside files remain untouched', async t => {
  const { root, directory } = await fixture(t); const store = await ArtifactStore.open({ directory }); const item = await store.put({ identity: owner, content: 'inside' }); const content = join(directory, item.reference.id, 'content'); const outside = join(root, 'outside'); await writeFile(outside, 'inside'); await unlink(content); await symlink(outside, content);
  await assert.rejects(store.read(item.reference.id), errorCode('ARTIFACT_PATH_UNSAFE')); await unlink(content); await link(outside, content); await assert.rejects(store.read(item.reference.id), errorCode('ARTIFACT_PATH_UNSAFE')); assert.equal(await readFile(outside, 'utf8'), 'inside');
});
test('managed directory symlinks and root inode replacement are rejected', async t => {
  const { root, directory } = await fixture(t); await mkdir(join(root, 'target')); await symlink(join(root, 'target'), directory); await assert.rejects(ArtifactStore.open({ directory }), errorCode('ARTIFACT_PATH_UNSAFE')); await unlink(directory);
  const store = await ArtifactStore.open({ directory }); await rename(directory, join(root, 'original')); await mkdir(directory); await assert.rejects(store.put({ identity: owner, content: 'x' }), errorCode('ARTIFACT_PATH_UNSAFE')); assert.deepEqual(await readdir(directory), []);
});
test('invalid source and accessor/cyclic metadata never publish staging artifacts', async t => {
  const { directory } = await fixture(t); const store = await ArtifactStore.open({ directory });
  await assert.rejects(store.put({ identity: owner, content: { async *[Symbol.asyncIterator]() { yield 42 as unknown as string; } } }), errorCode('INVALID_ARTIFACT_DATA'));
  let invoked = false; const metadata = Object.defineProperty({}, 'secret', { enumerable: true, get() { invoked = true; return 'bad'; } }); await assert.rejects(store.put({ identity: owner, content: '', metadata }), errorCode('INVALID_ARTIFACT_DATA')); assert.equal(invoked, false);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle; await assert.rejects(store.put({ identity: owner, content: '', metadata: cycle as never }), errorCode('INVALID_ARTIFACT_DATA')); assert.deepEqual(await readdir(directory), []);
});
test('structured projection budgets are independent and legacy enrichment preserves existing fields', () => {
  const envelope = createToolResultEnvelope({ displayContent: 'display', modelContent: 'model', structuredData: { long: '0123456789' }, metadata: { kind: 'test' } }, { maxDisplayBytes: 4, maxModelBytes: 3, maxStructuredBytes: 3 }); assert.equal(envelope.displayContent, 'disp'); assert.equal(envelope.modelContent, 'mod'); assert.equal(envelope.structuredData, undefined); assert.equal(envelope.warnings.length, 3);
  const legacy = { content: 'original', data: { x: 1 }, artifacts: [{ path: '/legacy', bytes: 10, truncated: false }] }; const enriched = enrichLegacyToolResult(legacy, {}, { maxModelBytes: 2 }); assert.equal(enriched.content, 'original'); assert.deepEqual(enriched.data, legacy.data); assert.deepEqual(enriched.artifacts, legacy.artifacts); assert.equal(enriched.structuredResult?.modelContent, 'or');
  const projected = projectToolResult({ displayContent: 'display', modelContent: 'model', structuredData: [1], outcome: 'interrupted' }); assert.equal(projected.content, 'model'); assert.equal(projected.isError, true); assert.deepEqual(projected.data, [1]);
});
test('checkpoint binding requires matching execution and detects partial artifact result', async t => {
  const { directory } = await fixture(t); const store = await ArtifactStore.open({ directory }); const item = await store.put({ identity: owner, content: 'partial', outcome: 'failed' });
  const checkpoint: Checkpoint = { id: 'checkpoint-a', runId: owner.runId, toolCallId: owner.toolCallId, kind: 'command', createdAt: new Date().toISOString(), files: [], warnings: [] };
  assert.deepEqual(bindCheckpointArtifacts(checkpoint, owner, [item.reference]), { ...owner, checkpointId: 'checkpoint-a', artifactIds: [item.reference.id], partial: true });
  assert.throws(() => bindCheckpointArtifacts({ ...checkpoint, runId: 'other' }, owner, [item.reference]), errorCode('CHECKPOINT_ARTIFACT_MISMATCH')); assert.throws(() => bindCheckpointArtifacts(checkpoint, owner, [item.reference, item.reference]), errorCode('CHECKPOINT_ARTIFACT_MISMATCH'));
  assert.throws(() => createToolResultEnvelope({ displayContent: '', artifactRefs: [{ ...item.reference, complete: true }] }), errorCode('INVALID_ARTIFACT'));
});
test('JSON projection rejects malformed values while oversized JSON is omitted', () => {
  assert.throws(() => createToolResultEnvelope({ displayContent: '', structuredData: [NaN] }), errorCode('INVALID_ARTIFACT_DATA'));
  const array = new Array(2) as JsonValue; assert.throws(() => createToolResultEnvelope({ displayContent: '', structuredData: array }), errorCode('INVALID_ARTIFACT_DATA'));
});
