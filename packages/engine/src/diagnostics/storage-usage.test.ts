import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createStorageInspectorForTesting, inspectEngineStorage, type StorageImageIndex } from './storage-usage.js';

async function temporary(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-storage-usage-')));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
const id = (index: number): string => 'img_' + index.toString(16).padStart(32, '0');
function completeIndex(ids: string[] = []): StorageImageIndex { return { scope: 'primary-database-only', observedAt: new Date().toISOString(), complete: true, imageIds: ids }; }

test('logical file sizes, groups and explicit database sidecars are observed without reading their contents', async t => {
  const directory = await temporary(t), artifacts = join(directory, 'artifacts'), db = join(directory, 'engine.sqlite');
  for (const group of ['managed', 'input-media', 'children', 'terminals']) await mkdir(join(artifacts, group), { recursive: true });
  const files = [
    [join(artifacts, 'managed', 'content'), 7], [join(artifacts, 'input-media', id(1) + '.blob'), 11],
    [join(artifacts, 'children', 'child-output'), 13], [join(artifacts, 'terminals', 'output'), 17],
    [join(artifacts, 'terminals.sqlite'), 19], [join(artifacts, 'other'), 23], [db, 29], [db + '-wal', 31], [db + '-shm', 37],
  ] as const;
  for (const [path, bytes] of files) await writeFile(path, Buffer.alloc(bytes, 'a'));
  const content = 'fixture-credential-content-must-not-appear';
  await writeFile(join(artifacts, 'credential.json'), content, { mode: 0o000 });
  const before = await lstat(join(artifacts, 'credential.json'));
  const report = await inspectEngineStorage({ artifactDir: artifacts, dbPath: db });
  const after = await lstat(join(artifacts, 'credential.json'));
  assert.equal(report.complete, true); assert.equal(report.stopReason, null); assert.equal(report.logicalPathBytes, 187 + Buffer.byteLength(content));
  assert.equal(report.uniqueObservedInodeBytes, report.logicalPathBytes); assert.equal(report.groups.database.logicalPathBytes, 97);
  assert.equal(report.groups.managed.logicalPathBytes, 7); assert.equal(report.groups['input-media'].logicalPathBytes, 11);
  assert.equal(report.groups.children.logicalPathBytes, 13); assert.equal(report.groups.terminals.logicalPathBytes, 36);
  assert.equal(report.observedRegularFiles, 10); assert.equal(report.observedDirectories, 5);
  assert.equal(after.atimeMs, before.atimeMs); assert.equal(report.coverage.contentsRead, false); assert.equal(report.coverage.databaseOpened, false);
  assert.equal(report.coverage.physicalAllocatedBytes, null); assert.equal(report.coverage.cleanup, 'not-performed');
  const json = JSON.stringify(report); assert.ok(!json.includes(content)); assert.ok(!json.includes(directory));
  assert.ok(report.samples.every(sample => !sample.path.startsWith('/')));
});

test('an explicit database inside the artifact root is counted only once', async t => {
  const root = await temporary(t), db = join(root, 'engine.sqlite');
  await writeFile(db, '12345'); await writeFile(db + '-wal', '678');
  const report = await inspectEngineStorage({ artifactDir: root, dbPath: db });
  assert.equal(report.complete, true); assert.equal(report.logicalPathBytes, 8); assert.equal(report.groups.database.logicalPathBytes, 8);
  assert.equal(report.stableFiles, 2); assert.equal(report.duplicateInodePaths, 0);
});

test('hardlink accounting distinguishes path sizes from observed unique inode sizes', async t => {
  const root = await temporary(t); await writeFile(join(root, 'first'), '1234567'); await link(join(root, 'first'), join(root, 'second'));
  const report = await inspectEngineStorage({ artifactDir: root });
  assert.equal(report.complete, true); assert.equal(report.logicalPathBytes, 14); assert.equal(report.uniqueObservedInodeBytes, 7);
  assert.equal(report.duplicateInodePaths, 1); assert.equal(report.groups.other.hardlinkedFiles, 2);
  assert.equal(report.samples.filter(sample => sample.hardlinked).length, 2);
});

test('directory symlinks, file symlinks and special files are reported without following or reading them', { skip: process.platform === 'win32' }, async t => {
  const parent = await temporary(t), root = join(parent, 'root'), outside = join(parent, 'outside');
  await mkdir(root); await mkdir(outside); await writeFile(join(outside, 'outside-secret-name'), 'outside-content');
  await symlink(outside, join(root, 'linked-directory')); await symlink(join(outside, 'outside-secret-name'), join(root, 'linked-file'));
  assert.equal(spawnSync('mkfifo', [join(root, 'pipe')]).status, 0);
  const report = await inspectEngineStorage({ artifactDir: root });
  assert.equal(report.complete, false); assert.equal(report.logicalPathBytes, 0); assert.equal(report.groups.other.symlinks, 2);
  assert.equal(report.groups.other.specialFiles, 1); assert.ok(report.stopReasons.includes('symlink_skipped')); assert.ok(report.stopReasons.includes('special_file_skipped'));
  assert.ok(!JSON.stringify(report).includes('outside-secret-name')); assert.equal(report.coverage.symlinkTargets, 'not-scanned');
});

test('a symlink artifact root and an ancestor symlink are rejected as unsafe metadata scope', { skip: process.platform === 'win32' }, async t => {
  const parent = await temporary(t), real = join(parent, 'real'); await mkdir(join(real, 'artifacts'), { recursive: true });
  await writeFile(join(real, 'artifacts', 'sample'), 'bytes'); await symlink(real, join(parent, 'alias'));
  for (const path of [join(parent, 'alias'), join(parent, 'alias', 'artifacts')]) {
    const report = await inspectEngineStorage({ artifactDir: path });
    assert.equal(report.roots.artifacts, 'unsafe'); assert.equal(report.complete, false); assert.equal(report.stableFiles, 0); assert.ok(report.stopReasons.includes('unsafe_path'));
  }
});

test('only generated root image blobs are orphan candidates with a complete primary index', async t => {
  const root = await temporary(t); await mkdir(join(root, 'input-media')); await mkdir(join(root, 'children', 'input-media'), { recursive: true });
  const files = [
    ['input-media/' + id(1) + '.blob', 'referenced'], ['input-media/' + id(2) + '.blob', 'candidate'],
    ['input-media/' + id(3) + '.blob', 'hardlinked'], ['input-media/.pending_' + id(4), 'staging'],
    ['input-media/arbitrary.blob', 'arbitrary'], ['children/input-media/' + id(5) + '.blob', 'child'],
  ];
  for (const [path, content] of files) await writeFile(join(root, path!), content!);
  await link(join(root, 'input-media', id(3) + '.blob'), join(root, 'hardlink'));
  const options = { artifactDir: root, imageIndex: completeIndex([id(1)]), limits: { maxSamplePathBytes: 32 } };
  const report = await inspectEngineStorage(options);
  assert.equal(report.images.indexStatus, 'complete'); assert.equal(report.images.complete, true); assert.equal(report.images.candidateFiles, 1);
  assert.equal(report.images.candidateBytes, 9); assert.equal(report.images.candidates[0]?.id, id(2));
  assert.ok(Buffer.byteLength(report.images.candidates[0]!.path) <= 32); assert.equal(report.images.candidates[0]?.pathTruncated, true);
  assert.equal(report.images.deletionPerformed, false); assert.equal(await readFile(join(root, 'input-media', id(2) + '.blob'), 'utf8'), 'candidate');
  for (const imageIndex of [undefined, { ...completeIndex(), complete: false }, { ...completeIndex(), scope: 'child' } as unknown as StorageImageIndex, completeIndex([id(1), id(1)])]) {
    const partial = await inspectEngineStorage({ artifactDir: root, ...(imageIndex === undefined ? {} : { imageIndex }) });
    assert.equal(partial.images.candidateFiles, 0); assert.equal(partial.images.candidates.length, 0); assert.equal(partial.images.complete, false);
  }
});

test('entry and directory caps stop traversal and report unknown remaining coverage', async t => {
  const root = await temporary(t); await mkdir(join(root, 'one')); await mkdir(join(root, 'two'));
  await writeFile(join(root, 'one', 'a'), 'a'); await writeFile(join(root, 'two', 'b'), 'bb');
  for (const limits of [{ maxEntries: 2 }, { maxDirectories: 1 }, { maxOperations: 1 }]) {
    const report = await inspectEngineStorage({ artifactDir: root, limits });
    assert.equal(report.complete, false); assert.equal(report.unvisitedEntries, null);
    if ('maxEntries' in limits) { assert.equal(report.observedEntries, 2); assert.ok(report.stopReasons.includes('entry_limit')); }
    if ('maxDirectories' in limits) { assert.equal(report.observedDirectories, 1); assert.ok(report.stopReasons.includes('directory_limit')); }
    if ('maxOperations' in limits) { assert.equal(report.operations, 1); assert.ok(report.stopReasons.includes('operation_limit')); }
  }
});

test('depth bounds preserve already observed file bytes and report skipped directories', async t => {
  const root = await temporary(t); await mkdir(join(root, 'one', 'two'), { recursive: true });
  await writeFile(join(root, 'top'), 'top'); await writeFile(join(root, 'one', 'nested'), 'nested');
  const report = await inspectEngineStorage({ artifactDir: root, limits: { maxDepth: 1 } });
  assert.equal(report.complete, false); assert.equal(report.logicalPathBytes, 3); assert.equal(report.skippedDepthDirectories, 1);
  assert.ok(report.stopReasons.includes('depth_limit')); assert.equal(report.groups.other.directories, 2);
});

test('cooperative time and cancellation limits join directory handles and retain partial observations', async t => {
  const root = await temporary(t); await writeFile(join(root, 'sample'), 'sample');
  let clock = 0;
  const timed = createStorageInspectorForTesting({ now: () => clock, beforeOperation: phase => { if (phase === 'before_file_recheck') clock = 11; } });
  const report = await timed({ artifactDir: root, limits: { maxDurationMs: 10 } });
  assert.equal(report.complete, false); assert.equal(report.stopReason, 'time_limit'); assert.equal(report.elapsedMs, 11);
  assert.equal(report.observedRegularFiles, 1); assert.equal(report.stableFiles, 0);
  const controller = new AbortController();
  const aborted = createStorageInspectorForTesting({ beforeOperation: phase => { if (phase === 'before_directory_read') controller.abort(); } });
  const cancelled = await aborted({ artifactDir: root, signal: controller.signal });
  assert.equal(cancelled.stopReason, 'aborted'); assert.equal(cancelled.complete, false);
  const beforeStart = new AbortController(); beforeStart.abort();
  const empty = await inspectEngineStorage({ artifactDir: root, signal: beforeStart.signal });
  assert.equal(empty.operations, 0); assert.equal(empty.observedEntries, 0); assert.equal(empty.stopReason, 'aborted');
  assert.equal((await inspectEngineStorage({ artifactDir: root })).complete, true);
});

test('a file replacement or size change before recheck is excluded from stable byte totals', async t => {
  const root = await temporary(t), file = join(root, 'sample');
  for (const replace of [false, true]) {
    await writeFile(file, 'original'); let changed = false;
    const inspect = createStorageInspectorForTesting({ beforeOperation: async (phase, path) => {
      if (phase !== 'before_file_recheck' || path !== 'sample' || changed) return; changed = true;
      if (replace) { await rename(file, file + '.old'); await writeFile(file, 'replacement'); }
      else await writeFile(file, 'longer-mutated-file');
    } });
    const report = await inspect({ artifactDir: root });
    assert.equal(report.complete, false); assert.ok(report.stopReasons.includes('changed_entry')); assert.ok(report.groups.other.changedEntries >= 1);
    assert.ok(report.samples.some(sample => sample.path === 'sample' && sample.kind === 'changed'));
    // The replaced old name may be discovered later; it never licenses the new file's unvalidated size.
    assert.ok(report.samples.every(sample => sample.path !== 'sample' || sample.bytes === undefined));
    await rm(file + '.old', { force: true });
  }
});

test('a directory replaced by a symlink is detected before enumerating its target', { skip: process.platform === 'win32' }, async t => {
  const parent = await temporary(t), root = join(parent, 'root'), outside = join(parent, 'outside');
  await mkdir(join(root, 'child'), { recursive: true }); await mkdir(outside); await writeFile(join(outside, 'external-name-must-not-appear'), 'external');
  let replaced = false;
  const inspect = createStorageInspectorForTesting({ beforeOperation: async (phase, path) => {
    if (phase === 'before_directory_open' && path === 'child' && !replaced) { replaced = true; await rename(join(root, 'child'), join(parent, 'removed')); await symlink(outside, join(root, 'child')); }
  } });
  const report = await inspect({ artifactDir: root });
  assert.equal(report.complete, false); assert.ok(report.stopReasons.includes('changed_entry')); assert.equal(report.stableFiles, 0);
  assert.ok(!JSON.stringify(report).includes('external-name-must-not-appear'));
});

test('directory contents changing after enumeration make the non-atomic observation incomplete', async t => {
  const root = await temporary(t); await writeFile(join(root, 'first'), 'a'); let changed = false;
  const inspect = createStorageInspectorForTesting({ beforeOperation: async (phase, path) => {
    if (phase === 'before_directory_recheck' && path === '.' && !changed) { changed = true; await writeFile(join(root, 'late'), 'late'); }
  } });
  const report = await inspect({ artifactDir: root });
  assert.equal(report.complete, false); assert.ok(report.stopReasons.includes('changed_entry')); assert.equal(report.logicalPathBytes, 1);
  assert.equal(report.coverage.snapshot, 'non-atomic-with-identity-and-size-rechecks');
});

test('samples and compact JSON remain bounded without claiming sampled paths are exhaustive', async t => {
  const root = await temporary(t);
  for (let index = 0; index < 80; index++) await writeFile(join(root, index.toString().padStart(3, '0') + '-' + '한'.repeat(70)), 'a');
  const report = await inspectEngineStorage({ artifactDir: root, limits: { maxSamples: 80, maxSamplePathBytes: 64, maxReportBytes: 4_096 } });
  assert.equal(report.complete, true); assert.equal(report.logicalPathBytes, 80); assert.equal(report.stableFiles, 80);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 4_096); assert.ok(report.samplesOmitted > 0); assert.equal(report.reportTruncated, true);
  assert.ok(report.samples.every(sample => Buffer.byteLength(sample.path) <= 64)); assert.ok(report.samples.some(sample => sample.pathTruncated));
});

test('missing roots and invalid options produce bounded explicit outcomes without echoing paths', async t => {
  const root = await temporary(t); const report = await inspectEngineStorage({ artifactDir: join(root, 'missing') });
  assert.equal(report.complete, false); assert.equal(report.roots.artifacts, 'missing'); assert.equal(report.stopReason, 'root_missing');
  assert.ok(!JSON.stringify(report).includes(root));
  for (const options of [
    { artifactDir: 'relative-secret' }, { artifactDir: root, limits: { maxEntries: 0 } }, { artifactDir: root, limits: { maxDepth: 33 } },
    { artifactDir: root, limits: { maxReportBytes: 4_095 } }, { artifactDir: root, unknown: 'fixture-secret' },
  ]) {
    await assert.rejects(inspectEngineStorage(options as Parameters<typeof inspectEngineStorage>[0]), error => error instanceof Error && 'code' in error && error.code === 'INVALID_STORAGE_USAGE_OPTIONS' && !error.message.includes('secret'));
  }
});
