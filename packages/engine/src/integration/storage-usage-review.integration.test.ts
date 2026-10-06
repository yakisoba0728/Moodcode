import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createEngine } from '../engine.js';
import { png } from '../media/fixtures.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-storage-review-'))), artifacts = join(root, 'artifacts'), workspace = join(root, 'workspace'), dbPath = join(root, 'engine.sqlite');
  await mkdir(workspace);
  const engine = createEngine({ dbPath, artifactDir: artifacts });
  const stamp = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root: workspace, gitRoot: workspace, branch: null, createdAt: stamp });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Storage diagnostics', createdAt: stamp });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  return { engine, root, artifacts, dbPath };
}
function deferred<T>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

test('the host facade byte limit includes its primary index metadata while preserving diagnostic scope', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 8; index++) await f.engine.importImage('session', png(), 'image/png');
  const before = f.engine.store.getSessionDocument('session', 'input_images');
  const report = await f.engine.getStorageUsage({ limits: { maxReportBytes: 4_096 } });
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 4_096, `Host report exceeds maxReportBytes: ${Buffer.byteLength(JSON.stringify(report))}`);
  assert.equal(report.images.indexStatus, 'complete'); assert.equal(report.images.indexedIds, 8);
  assert.equal(report.images.candidateFiles, 0); assert.equal(report.images.coverage, 'root-input-media-only');
  assert.ok(!JSON.stringify(report).includes(f.root)); assert.ok(!Object.hasOwn(report, 'imageIndex'));
  const index = f.engine.store.inspectInputImageIndex();
  assert.equal(index.scope, 'primary-database-only'); assert.equal(index.complete, true);
  assert.equal(index.totalDocuments, 1); assert.equal(index.imageIds.length, 8);
  assert.equal(report.coverage.physicalAllocatedBytes, null);
  assert.deepEqual(f.engine.store.getSessionDocument('session', 'input_images'), before);
});

test('engine close cancels and joins actual pending directory acquisition before storage ownership is released', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), acquired = deferred<void>(), release = deferred<void>(), actual = fs.opendir;
  let held = false;
  t.mock.method(fs, 'opendir', async (...args: Parameters<typeof fs.opendir>) => {
    const directory = await actual(...args);
    if (String(args[0]) === f.artifacts && !held) { held = true; acquired.resolve(); await release.promise; }
    return directory;
  });
  syncBuiltinESMExports();
  let inspection: ReturnType<typeof f.engine.getStorageUsage> | undefined, closing: Promise<void> | undefined;
  let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    inspection = f.engine.getStorageUsage();
    await Promise.race([acquired.promise, new Promise<never>((_, reject) => { readinessTimeout = setTimeout(() => reject(new Error('Actual directory acquisition did not reach the fixture gate')), 5_000); })]);
    clearTimeout(readinessTimeout);
    let closed = false; closing = f.engine.close().then(() => { closed = true; });
    for (let tick = 0; tick < 5; tick++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'Close returned while an owned storage directory acquisition remained pending');
    assert.equal(f.engine.store.getSession('session').id, 'session');
    release.resolve();
    const report = await inspection; await closing;
    assert.equal(report.complete, false); assert.ok(report.stopReasons.includes('aborted'));
    assert.throws(() => f.engine.store.getSession('session'), error => error instanceof Error && 'code' in error && error.code === 'STORE_CLOSED');
    await assert.rejects(f.engine.getStorageUsage(), error => error instanceof Error && 'code' in error && error.code === 'ENGINE_CLOSED');
  } finally {
    clearTimeout(readinessTimeout); release.resolve();
    const operations: Promise<unknown>[] = []; if (inspection) operations.push(inspection); if (closing) operations.push(closing);
    await Promise.allSettled(operations);
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});

test('an out-of-safe-integer stored image revision is classified as incomplete rather than escaping as a SQLite RangeError', async t => {
  const f = await fixture(t); await f.engine.importImage('session', png(), 'image/png');
  const writer = new DatabaseSync(f.dbPath);
  try {
    writer.prepare("UPDATE session_documents SET revision=? WHERE kind='input_images'").run(9_007_199_254_740_992n);
    const report = f.engine.store.inspectInputImageIndex();
    assert.equal(report.complete, false); assert.equal(report.invalidDocuments, 1); assert.equal(report.omittedReferences, null);
    assert.deepEqual(report.imageIds, []); assert.equal(report.coverage.filesystem, 'not-read');
  } finally { writer.close(); }
});
