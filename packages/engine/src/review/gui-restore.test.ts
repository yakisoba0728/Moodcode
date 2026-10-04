import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DEFAULT_LIMITS, EngineError, type Checkpoint, type CheckpointFile, type FileDiff, type ReviewDiff, type Workspace } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import { ApprovalManager } from '../permission/index.js';
import { RunCoordinator } from '../runner/index.js';
import { assertExecutionLockAvailable } from '../tools/command/execution-lock.js';
import { getReviewDiff, previewRestoreCheckpoint, restoreCheckpoint } from './index.js';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const image = (relative: string, before: string | null, after: string | null): CheckpointFile => ({ path: relative, before, after, beforeHash: before === null ? null : digest(before), afterHash: after === null ? null : digest(after) });
const hasCode = (code: string) => (error: unknown): boolean => error instanceof EngineError && error.code === code;

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function selectedUndo(review: ReviewDiff, checkpointId: string): FileDiff[] {
  const selected = review.checkpoints.find((entry) => entry.id === checkpointId);
  assert.ok(selected, 'The selected checkpoint must be available independently of the merged Run diff');
  return selected.files.map((file) => ({ path: file.path, before: file.after, after: file.before, beforeHash: file.afterHash, afterHash: file.beforeHash }));
}

async function fixture(context: TestContext, steps: CheckpointFile[][]) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moodcode-gui-restore-')));
  const root = path.join(directory, 'workspace');
  await fs.mkdir(root);
  const workspace: Workspace = { id: randomUUID(), root, gitRoot: root, branch: null, createdAt: new Date().toISOString() };
  const store = new SqliteStore(path.join(directory, 'records.sqlite'));
  context.after(async () => {
    try { store.close(); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  store.putWorkspace(workspace);
  const sessionId = randomUUID();
  store.createSession({ id: sessionId, workspaceId: workspace.id, title: 'GUI restore fixture', createdAt: workspace.createdAt });
  const receipt = store.admit({ sessionId, requestId: randomUUID(), prompt: 'Record sequential changes in one Run', config: { providerId: 'scripted', modelId: 'local', mode: 'build', limits: DEFAULT_LIMITS } });
  store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
  const checkpoints: Checkpoint[] = [];
  const firstTimestamp = Date.now();
  for (const [index, files] of steps.entries()) {
    for (const file of files) {
      const absolute = path.join(root, file.path);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      if (file.after !== null) await fs.writeFile(absolute, file.after, 'utf8');
      else await fs.unlink(absolute).catch((error: unknown) => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; });
    }
    const toolCallId = randomUUID();
    const checkpoint: Checkpoint = { id: randomUUID(), runId: receipt.runId, toolCallId, kind: 'patch', createdAt: new Date(firstTimestamp + index).toISOString(), files, warnings: [] };
    store.commit(receipt.runId, 'tool.running', { toolCallId }, { tool: { id: toolCallId, runId: receipt.runId, sessionId, name: 'apply_patch', input: {}, state: 'running' } });
    store.commit(receipt.runId, 'workspace.changed', { checkpointId: checkpoint.id }, { checkpoint });
    store.commit(receipt.runId, 'tool.completed', { toolCallId }, { tool: { id: toolCallId, runId: receipt.runId, sessionId, name: 'apply_patch', input: {}, state: 'completed', output: 'Recorded checkpoint' } });
    checkpoints.push(checkpoint);
  }
  store.commit(receipt.runId, 'run.completed', {}, { run: { state: 'completed' } });
  return { directory, store, workspace, sessionId, runId: receipt.runId, checkpoints, executionLockPath: path.join(directory, 'effects.sqlite') };
}

const A = 'A: existing user edits\n';
const B = 'B: first engine edit\n';
const C = 'C: second engine edit\n';

test('GUI restore data distinguishes archived Run A→C from selected checkpoint C→B and actual current B', async (context) => {
  const f = await fixture(context, [[image('shared.txt', A, B)], [image('shared.txt', B, C)]]);
  const [first, second] = f.checkpoints;
  assert.ok(first && second);
  const target = path.join(f.workspace.root, 'shared.txt');
  const archivedRun = getReviewDiff(f.store, f.runId);
  assert.deepEqual(archivedRun.files, [image('shared.txt', A, C)]);
  assert.deepEqual(selectedUndo(archivedRun, first.id), [image('shared.txt', B, A)]);
  assert.deepEqual(selectedUndo(archivedRun, second.id), [image('shared.txt', C, B)]);

  const prematureFirst = await previewRestoreCheckpoint(f.store, f.workspace, first.id);
  assert.equal(prematureFirst.runId, f.runId);
  assert.equal(prematureFirst.atomic, false);
  assert.deepEqual(prematureFirst.diff, [], 'Conflicted recorded images must not be presented as the live file content');
  assert.equal(prematureFirst.canRestore, false);
  assert.equal(prematureFirst.files[0]?.status, 'conflict');
  assert.equal(prematureFirst.files[0]?.currentHash, digest(C));
  assert.equal(prematureFirst.files[0]?.postimageHash, digest(B));
  assert.equal(prematureFirst.files[0]?.restoreHash, digest(A));

  const secondPreview = await previewRestoreCheckpoint(f.store, f.workspace, second.id);
  assert.equal(secondPreview.runId, f.runId);
  assert.equal(secondPreview.atomic, false);
  assert.deepEqual(secondPreview.diff, [image('shared.txt', C, B)]);
  assert.equal(secondPreview.canRestore, true);
  assert.equal(secondPreview.files[0]?.currentHash, digest(C));
  assert.equal(secondPreview.files[0]?.postimageHash, digest(C));
  assert.equal(secondPreview.files[0]?.restoreHash, digest(B));
  const result = await restoreCheckpoint(f.store, f.workspace, second.id, { executionLockPath: f.executionLockPath, previewFingerprint: secondPreview.fingerprint });
  assert.equal(result.runId, f.runId);
  assert.equal(result.atomic, false);
  assert.deepEqual(result.restored, ['shared.txt']);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.failed, []);
  assert.equal(result.observations[0]?.currentHash, digest(B));
  assert.equal(result.observations[0]?.state, 'present');
  assert.equal(result.observations[0]?.bytes, Buffer.byteLength(B));
  assert.equal(await fs.readFile(target, 'utf8'), B);

  const archivedAfterRestore = getReviewDiff(f.store, f.runId);
  assert.deepEqual(archivedAfterRestore, archivedRun, 'Restoration must not rewrite immutable historical Run observations');
  assert.equal(archivedAfterRestore.files[0]?.afterHash, digest(C));
  assert.notEqual(archivedAfterRestore.files[0]?.afterHash, result.observations[0]?.currentHash);
  const secondRefetch = await previewRestoreCheckpoint(f.store, f.workspace, second.id);
  assert.deepEqual(secondRefetch.diff, []);
  assert.equal(secondRefetch.files[0]?.status, 'conflict');
  assert.equal(secondRefetch.files[0]?.currentHash, digest(B));
  const firstRefetch = await previewRestoreCheckpoint(f.store, f.workspace, first.id);
  assert.deepEqual(firstRefetch.diff, [image('shared.txt', B, A)]);
  assert.equal(firstRefetch.canRestore, true);
  assert.equal(firstRefetch.files[0]?.currentHash, digest(B));
  assert.equal(firstRefetch.files[0]?.restoreHash, digest(A));
  assert.deepEqual(selectedUndo(archivedAfterRestore, first.id), [image('shared.txt', B, A)]);

  await assert.rejects(restoreCheckpoint(f.store, f.workspace, second.id, { executionLockPath: f.executionLockPath, previewFingerprint: secondPreview.fingerprint }), hasCode('RESTORE_PREVIEW_STALE'));
  await assert.rejects(restoreCheckpoint(f.store, f.workspace, first.id, { executionLockPath: f.executionLockPath, previewFingerprint: prematureFirst.fingerprint }), hasCode('RESTORE_PREVIEW_STALE'));
  assert.equal(await fs.readFile(target, 'utf8'), B);
  const firstResult = await restoreCheckpoint(f.store, f.workspace, first.id, { executionLockPath: f.executionLockPath, previewFingerprint: firstRefetch.fingerprint });
  assert.deepEqual(firstResult.restored, ['shared.txt']);
  assert.equal(firstResult.observations[0]?.currentHash, digest(A));
  assert.equal(await fs.readFile(target, 'utf8'), A);
  assert.deepEqual(getReviewDiff(f.store, f.runId), archivedRun);
});

test('old selected-checkpoint preview cannot overwrite a user edit after a prior restore', async (context) => {
  const f = await fixture(context, [[image('shared.txt', A, B)], [image('shared.txt', B, C)]]);
  const [first, second] = f.checkpoints;
  assert.ok(first && second);
  const target = path.join(f.workspace.root, 'shared.txt');
  const originalSecondPreview = await previewRestoreCheckpoint(f.store, f.workspace, second.id);
  await restoreCheckpoint(f.store, f.workspace, second.id, { executionLockPath: f.executionLockPath, previewFingerprint: originalSecondPreview.fingerprint });
  const firstPreviewAtB = await previewRestoreCheckpoint(f.store, f.workspace, first.id);
  assert.equal(firstPreviewAtB.canRestore, true);
  const userEdit = 'User edits made after the first restoration\n';
  await fs.writeFile(target, userEdit);
  await assert.rejects(restoreCheckpoint(f.store, f.workspace, first.id, { executionLockPath: f.executionLockPath, previewFingerprint: firstPreviewAtB.fingerprint }), hasCode('RESTORE_PREVIEW_STALE'));
  await assert.rejects(restoreCheckpoint(f.store, f.workspace, second.id, { executionLockPath: f.executionLockPath, previewFingerprint: originalSecondPreview.fingerprint }), hasCode('RESTORE_PREVIEW_STALE'));
  assert.equal(await fs.readFile(target, 'utf8'), userEdit);
  const refetched = await previewRestoreCheckpoint(f.store, f.workspace, first.id);
  assert.deepEqual(refetched.diff, []);
  assert.equal(refetched.canRestore, false);
  assert.equal(refetched.files[0]?.status, 'conflict');
  assert.equal(refetched.files[0]?.currentHash, digest(userEdit));
  const archivedRun = getReviewDiff(f.store, f.runId);
  assert.deepEqual(archivedRun.files, [image('shared.txt', A, C)]);
  assert.deepEqual(selectedUndo(archivedRun, first.id), [image('shared.txt', B, A)]);
  assert.notEqual(refetched.files[0]?.currentHash, archivedRun.files[0]?.afterHash);
  assertExecutionLockAvailable(f.executionLockPath);
});

test('a selected two-file checkpoint can restore partially while preserving a late user edit and refetching actual states', { timeout: 8_000 }, async (context) => {
  const safeBefore = 'safe user preimage', safeAfter = 'safe engine postimage';
  const editedBefore = 'edited user preimage', editedAfter = 'edited engine postimage';
  const f = await fixture(context, [[image('safe.txt', safeBefore, safeAfter), image('edited.txt', editedBefore, editedAfter)]]);
  const selected = f.checkpoints[0];
  assert.ok(selected);
  const archivedRun = getReviewDiff(f.store, f.runId);
  const preview = await previewRestoreCheckpoint(f.store, f.workspace, selected.id);
  assert.equal(preview.runId, f.runId);
  assert.equal(preview.atomic, false);
  assert.deepEqual(preview.diff, [image('safe.txt', safeAfter, safeBefore), image('edited.txt', editedAfter, editedBefore)]);
  assert.equal(preview.canRestore, true);
  const target = path.join(f.workspace.root, 'edited.txt');
  const originalOpen = fs.open;
  const guardStarted = deferred(), releaseGuard = deferred();
  let gated = false;
  const mocked = context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === target && typeof args[1] === 'number' && (args[1] & 3) === constants.O_RDWR && !gated) {
      gated = true;
      guardStarted.resolve();
      await releaseGuard.promise;
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  const userEdit = 'External user edit after fingerprint revalidation';
  let result: Awaited<ReturnType<typeof restoreCheckpoint>>;
  try {
    const restoring = restoreCheckpoint(f.store, f.workspace, selected.id, { executionLockPath: f.executionLockPath, previewFingerprint: preview.fingerprint });
    try {
      await Promise.race([guardStarted.promise, restoring.then(() => { throw new Error('Restore completed before the final guarded target was reached'); })]);
      assert.equal(await fs.readFile(path.join(f.workspace.root, 'safe.txt'), 'utf8'), safeBefore);
      assert.throws(() => assertExecutionLockAvailable(f.executionLockPath), hasCode('COMMAND_EFFECTS_BUSY'));
      await fs.writeFile(target, userEdit);
    } finally { releaseGuard.resolve(); }
    result = await restoring;
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(result.restored, ['safe.txt']);
  assert.equal(result.runId, f.runId);
  assert.equal(result.atomic, false);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]?.path, 'edited.txt');
  assert.match(result.conflicts[0]?.reason ?? '', /postimage|changed/);
  assert.deepEqual(result.failed, []);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0]?.path, 'safe.txt');
  assert.equal(result.observations[0]?.currentHash, digest(safeBefore));
  assert.equal(result.effectsUncertain, false);
  assert.equal(result.executionBlocked, false);
  assert.equal(await fs.readFile(target, 'utf8'), userEdit);
  assert.match(result.warnings.join('\n'), /Restoration was partial/);

  const refetched = await previewRestoreCheckpoint(f.store, f.workspace, selected.id);
  assert.deepEqual(refetched.diff, [], 'Neither conflicted target has a safe live reverse diff after partial restoration');
  assert.equal(refetched.canRestore, false);
  assert.deepEqual(refetched.files.map((entry) => [entry.path, entry.status, entry.currentHash]), [['safe.txt', 'conflict', digest(safeBefore)], ['edited.txt', 'conflict', digest(userEdit)]]);
  assert.deepEqual(getReviewDiff(f.store, f.runId), archivedRun);
  assert.deepEqual(selectedUndo(archivedRun, selected.id), [image('safe.txt', safeAfter, safeBefore), image('edited.txt', editedAfter, editedBefore)]);
  await assert.rejects(restoreCheckpoint(f.store, f.workspace, selected.id, { executionLockPath: f.executionLockPath, previewFingerprint: preview.fingerprint }), hasCode('RESTORE_PREVIEW_STALE'));
  assert.equal(await fs.readFile(path.join(f.workspace.root, 'safe.txt'), 'utf8'), safeBefore);
  assert.equal(await fs.readFile(target, 'utf8'), userEdit);
  assertExecutionLockAvailable(f.executionLockPath);
});

test('GUI reverse preview explicitly represents create/delete/update/no-op direction', async (context) => {
  const f = await fixture(context, [[image('deleted.txt', 'removed user text', null), image('created.txt', null, 'engine created text'), image('updated.txt', 'old user text', 'new engine text'), image('same.txt', 'same text', 'same text')]]);
  const selected = f.checkpoints[0];
  assert.ok(selected);
  const preview = await previewRestoreCheckpoint(f.store, f.workspace, selected.id);
  assert.equal(preview.runId, f.runId);
  assert.equal(preview.atomic, false);
  assert.equal(preview.canRestore, true);
  assert.deepEqual(preview.files.map((entry) => [entry.path, entry.operation, entry.status]), [['deleted.txt', 'create', 'ready'], ['created.txt', 'delete', 'ready'], ['updated.txt', 'update', 'ready'], ['same.txt', 'noop', 'ready']]);
  assert.deepEqual(preview.diff, [image('deleted.txt', null, 'removed user text'), image('created.txt', 'engine created text', null), image('updated.txt', 'new engine text', 'old user text'), image('same.txt', 'same text', 'same text')]);
  assert.deepEqual(preview.diff, selectedUndo(getReviewDiff(f.store, f.runId), selected.id));
  await assert.rejects(fs.lstat(path.join(f.workspace.root, 'deleted.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.workspace.root, 'created.txt'), 'utf8'), 'engine created text');
});

test('coordinator close aborts a restore lease and drains accounting before releasing the shared marker', { timeout: 8_000 }, async (context) => {
  const before = 'user preimage', after = 'longer engine postimage';
  const f = await fixture(context, [[image('a.txt', before, after)]]);
  const selected = f.checkpoints[0];
  assert.ok(selected);
  const preview = await previewRestoreCheckpoint(f.store, f.workspace, selected.id);
  const coordinator = new RunCoordinator({ store: f.store, providers: new Map(), tools: [], approvals: new ApprovalManager(f.store), artifactDir: f.directory, executionLockPath: f.executionLockPath, buildContext: async () => [] });
  const target = path.join(f.workspace.root, 'a.txt');
  const originalOpen = fs.open;
  const observing = deferred(), releaseObservation = deferred();
  let effectsDone = false, gated = false;
  const mocked = context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === target && typeof args[1] === 'number' && (args[1] & 3) === constants.O_RDWR) {
      const sync = handle.sync.bind(handle);
      context.mock.method(handle, 'sync', async () => { await sync(); effectsDone = true; });
    }
    if (String(args[0]) === target && typeof args[1] === 'number' && (args[1] & 3) === constants.O_RDONLY && effectsDone) {
      const read = handle.read.bind(handle);
      context.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
        if (!gated) { gated = true; observing.resolve(); await releaseObservation.promise; }
        return read(buffer, offset, length, position);
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  let signal: AbortSignal | undefined;
  let maintenanceSettled = false, closeSettled = false;
  let closePromise: Promise<void> | undefined;
  const maintenance = coordinator.withWorkspaceLease(f.workspace.id, (leaseSignal) => {
    signal = leaseSignal;
    return restoreCheckpoint(f.store, f.workspace, selected.id, { executionLockPath: f.executionLockPath, previewFingerprint: preview.fingerprint, signal: leaseSignal });
  }).then((result) => { maintenanceSettled = true; return result; }, (error: unknown) => { maintenanceSettled = true; throw error; });
  try {
    try {
      await Promise.race([observing.promise, maintenance.then(() => { throw new Error('Restore lease settled before accounting was gated'); })]);
      assert.equal(await fs.readFile(target, 'utf8'), before);
      assert.throws(() => coordinator.submit({ sessionId: f.sessionId, requestId: randomUUID(), prompt: 'must wait for restore cleanup', config: { providerId: 'scripted', modelId: 'local', mode: 'build', limits: DEFAULT_LIMITS } }), hasCode('WORKSPACE_BUSY'));
      closePromise = coordinator.close().then(() => { closeSettled = true; });
      assert.equal(signal?.aborted, true);
      await nextTurn();
      assert.equal(maintenanceSettled, false);
      assert.equal(closeSettled, false, 'Coordinator close must await leased restoration accounting');
      assert.throws(() => assertExecutionLockAvailable(f.executionLockPath), hasCode('COMMAND_EFFECTS_BUSY'));
    } finally { releaseObservation.resolve(); }
    const result = await maintenance;
    await closePromise;
    assert.equal(result.cancelled, true);
    assert.equal(result.atomic, false);
    assert.equal(result.runId, f.runId);
    assert.deepEqual(result.restored, ['a.txt']);
    assert.equal(result.observations[0]?.state, 'present');
    assert.equal(result.observations[0]?.currentHash, digest(before));
    assert.equal(result.observations[0]?.bytes, Buffer.byteLength(before));
    assert.equal(result.effectsUncertain, false);
    assert.equal(result.executionBlocked, false);
    assert.equal(closeSettled, true);
    assertExecutionLockAvailable(f.executionLockPath);
    assert.deepEqual(getReviewDiff(f.store, f.runId).files, [image('a.txt', before, after)]);
  } finally {
    releaseObservation.resolve();
    mocked.mock.restore();
    syncBuiltinESMExports();
    await maintenance.catch(() => undefined);
    await coordinator.close();
  }
});
