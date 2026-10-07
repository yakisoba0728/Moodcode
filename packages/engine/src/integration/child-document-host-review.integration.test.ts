import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { createEngine, type EngineChildDocumentStorageOptions } from '../engine.js';
import { ScriptedProvider } from '../provider/index.js';

const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected && !error.message.includes('private-fixture');
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-child-document-host-review-')));
  const artifacts = join(root, 'artifacts'), engine = createEngine({
    dbPath: join(root, 'engine.sqlite'), artifactDir: artifacts,
    providers: [new ScriptedProvider([{ events: [{ type: 'text.delta', delta: 'Authored observation.' }, { type: 'finish', reason: 'stop' }] }])],
  });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const createdAt = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt });
  engine.store.createSession({ id: 'owner', workspaceId: 'workspace', title: 'Fixture', createdAt });
  engine.store.createSession({ id: 'other', workspaceId: 'workspace', title: 'Other fixture', createdAt });
  const receipt = engine.scheduler.submitLegacy({ sessionId: 'owner', requestId: 'parent', prompt: 'Observe', config: engine.getCapabilities().defaults });
  assert.equal((await engine.waitForRun(receipt.runId)).state, 'completed');
  const input = { sessionId: 'owner', sourceRunId: receipt.runId, taskIds: [] };
  return { engine, root, artifacts, input };
}

test('child-document host inspection rejects accessors, proxies and malformed selectors before root selection', async t => {
  const f = await fixture(t); let selected = 0, traps = 0;
  const original = f.engine.store.inspectChildDocumentStorageSources.bind(f.engine.store);
  t.mock.method(f.engine.store, 'inspectChildDocumentStorageSources', (...args: Parameters<typeof original>) => { selected++; return original(...args); });
  const accessor = { ...f.input };
  Object.defineProperty(accessor, 'signal', { enumerable: true, get() { traps++; throw new Error('private-fixture'); } });
  const proxy = new Proxy(f.input, { ownKeys() { traps++; throw new Error('private-fixture'); } });
  const proxyArray = new Proxy([], { get() { traps++; throw new Error('private-fixture'); } });
  for (const value of [accessor, proxy, { ...f.input, taskIds: proxyArray }, { ...f.input, sourceRunId: '' }, { ...f.input, signal: false }, { ...f.input, limits: null }, { ...f.input, limits: { maxMetadataBytes: 8_388_609 } }, { ...f.input, taskIds: ['child_' + 'a'.repeat(32), 'child_' + 'a'.repeat(32)] }, { ...f.input, surprise: true }]) {
    await assert.rejects(f.engine.getChildDocumentStorageUsage(value as unknown as EngineChildDocumentStorageOptions), error => error instanceof EngineError && /INVALID|REQUEST/u.test(error.code) && !error.message.includes('private-fixture'));
  }
  assert.equal(selected, 0); assert.equal(traps, 0);
});

test('foreign source Run and a pre-aborted request cannot inspect selected child document bodies', async t => {
  const f = await fixture(t);
  await assert.rejects(f.engine.getChildDocumentStorageUsage({ ...f.input, sessionId: 'other' }), code('CHILD_STORAGE_OWNER_MISMATCH'));
  const controller = new AbortController(); controller.abort('private-fixture');
  await assert.rejects(f.engine.getChildDocumentStorageUsage({ ...f.input, signal: controller.signal }), code('CANCELLED'));
  assert.equal(f.engine.store.getRun(f.input.sourceRunId).state, 'completed');
});

test('changed root artifact identity is rejected before child selection and can be restored for a fresh inspection', async t => {
  const f = await fixture(t), moved = join(f.root, 'original-artifacts');
  let selected = 0;
  const original = f.engine.store.inspectChildDocumentStorageSources.bind(f.engine.store);
  t.mock.method(f.engine.store, 'inspectChildDocumentStorageSources', (...args: Parameters<typeof original>) => { selected++; return original(...args); });
  await rename(f.artifacts, moved); await mkdir(f.artifacts);
  try {
    await assert.rejects(f.engine.getChildDocumentStorageUsage(f.input), code('CHILD_STORAGE_HOST_CHANGED'));
    assert.equal(selected, 0);
  } finally { await rm(f.artifacts, { recursive: true }); await rename(moved, f.artifacts); }
  const report = await f.engine.getChildDocumentStorageUsage(f.input);
  assert.equal(report.complete, true); assert.equal(selected, 1);
});

test('root-only document index remains available through explicit child inspection and close rejects new admission', async t => {
  const f = await fixture(t), before = f.engine.store.getSession('owner');
  await f.engine.importDocument('owner', Buffer.from('%PDF-1.7\nAuthored root-only bytes.\n', 'ascii'));
  const report = await f.engine.getChildDocumentStorageUsage(f.input);
  assert.equal(report.complete, true);
  assert.deepEqual(f.engine.store.getSession('owner'), before);
  assert.equal((await f.engine.getStorageUsage()).documents.indexedIds, 1);
  await f.engine.close();
  await assert.rejects(f.engine.getChildDocumentStorageUsage(f.input), code('ENGINE_CLOSED'));
});

test('a root document body exceeding the shared remaining metadata budget yields a partial observation and unknown totals', async t => {
  const f = await fixture(t);
  const ref = await f.engine.importDocument('owner', Buffer.from('%PDF-1.7\nAuthored budget fixture.\n', 'ascii'));
  const report = await f.engine.getChildDocumentStorageUsage({ ...f.input, limits: { maxMetadataBytes: 500 } });
  assert.equal(report.complete, false);
  assert.equal(report.rootIndex.status, 'incomplete');
  assert.equal(report.rootIndex.declaredBytes, null);
  assert.equal(report.declaredReferenceBytes.sum, null);
  assert.ok(report.stats.selectedMetadataBytes <= 500);
  assert.equal(report.stats.openedChildren, 0);
  assert.deepEqual(f.engine.store.inspectInputDocumentIndex().documentIds, [ref.id]);
  assert.equal((await f.engine.getChildDocumentStorageUsage(f.input)).complete, true);
});
