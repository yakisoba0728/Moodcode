import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DEFAULT_LIMITS, EngineError, type Checkpoint, type CheckpointFile, type RunState, type Workspace } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import { acquireExecutionLock, assertExecutionLockAvailable } from '../tools/command/execution-lock.js';
import { previewRestoreCheckpoint, restoreCheckpoint } from './index.js';

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const image = (relative: string, before: string | null, after: string | null): CheckpointFile => ({ path: relative, before, after, beforeHash: before === null ? null : digest(before), afterHash: after === null ? null : digest(after) });
const hasCode = (code: string) => (error: unknown): boolean => error instanceof EngineError && error.code === code;
const writable = (flags: Parameters<typeof fs.open>[1]): boolean => typeof flags === 'number' && (flags & 3) === constants.O_RDWR;
const readonly = (flags: Parameters<typeof fs.open>[1]): boolean => typeof flags === 'number' && (flags & 3) === constants.O_RDONLY;
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => { resolve = finish; });
  return { promise, resolve };
}

interface Fixture {
  directory: string;
  dbPath: string;
  executionLockPath: string;
  workspace: Workspace;
  sessionId: string;
  store: SqliteStore;
  save(files: CheckpointFile[]): Promise<Checkpoint>;
  reopen(): void;
}

async function fixture(context: TestContext): Promise<Fixture> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moodcode-restore-integration-')));
  const root = path.join(directory, 'workspace');
  await fs.mkdir(root);
  const workspace: Workspace = { id: randomUUID(), root, gitRoot: root, branch: null, createdAt: new Date().toISOString() };
  const dbPath = path.join(directory, 'records.sqlite');
  const sessionId = randomUUID();
  const result: Fixture = {
    directory, dbPath, executionLockPath: path.join(directory, 'effects.sqlite'), workspace, sessionId,
    store: new SqliteStore(dbPath),
    async save(files) {
      for (const file of files) {
        const absolute = path.join(root, file.path);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        if (file.after !== null) await fs.writeFile(absolute, file.after, 'utf8');
      }
      const receipt = result.store.admit({ sessionId, requestId: randomUUID(), prompt: 'persist a restoration fixture', config: { providerId: 'scripted', modelId: 'local', mode: 'build', limits: DEFAULT_LIMITS } });
      result.store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
      const toolCallId = randomUUID();
      result.store.commit(receipt.runId, 'tool.running', { toolCallId }, { tool: { id: toolCallId, runId: receipt.runId, sessionId, name: 'apply_patch', input: {}, state: 'running' } });
      const checkpoint: Checkpoint = { id: randomUUID(), runId: receipt.runId, toolCallId, kind: 'patch', createdAt: new Date().toISOString(), files, warnings: [] };
      result.store.commit(receipt.runId, 'workspace.changed', { checkpointId: checkpoint.id }, { checkpoint });
      result.store.commit(receipt.runId, 'tool.completed', { toolCallId }, { tool: { id: toolCallId, runId: receipt.runId, sessionId, name: 'apply_patch', input: {}, state: 'completed', output: 'Fixture effects are recorded' } });
      result.store.commit(receipt.runId, 'run.completed', {}, { run: { state: 'completed' } });
      return checkpoint;
    },
    reopen() { result.store.close(); result.store = new SqliteStore(dbPath); },
  };
  result.store.putWorkspace(workspace);
  result.store.createSession({ id: sessionId, workspaceId: workspace.id, title: 'restore fixture', createdAt: workspace.createdAt });
  context.after(async () => {
    try { result.store.close(); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  return result;
}

function activeMarker(executionLockPath: string): number {
  const db = new DatabaseSync(executionLockPath, { timeout: 0 });
  try {
    const row = db.prepare('SELECT active FROM command_execution WHERE id=1').get();
    assert.ok(row);
    return Number(row.active);
  } finally { db.close(); }
}

async function withOpenMock<T>(context: TestContext, implementation: typeof fs.open, operation: () => Promise<T>): Promise<T> {
  const mocked = context.mock.method(fs, 'open', implementation);
  syncBuiltinESMExports();
  try { return await operation(); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
}

test('SQLite restoration preview is read-only and describes create/update/delete/no-op', async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('deleted.txt', 'deleted user text', null), image('updated.txt', 'user text', 'engine text'), image('created.txt', null, 'created engine text'), image('same.txt', 'same text', 'same text')]);
  const beforeSeq = f.store.getSnapshot(f.sessionId).lastSeq;
  const preview = await previewRestoreCheckpoint(f.store, f.workspace, saved.id);
  assert.equal(preview.checkpointId, saved.id);
  assert.equal(preview.workspaceId, f.workspace.id);
  assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(preview.canRestore, true);
  assert.deepEqual(preview.activeRunIds, []);
  assert.deepEqual(preview.files.map((entry) => [entry.path, entry.operation, entry.status]), [
    ['deleted.txt', 'create', 'ready'], ['updated.txt', 'update', 'ready'], ['created.txt', 'delete', 'ready'], ['same.txt', 'noop', 'ready'],
  ]);
  for (const [index, entry] of preview.files.entries()) {
    assert.equal(entry.postimageHash, saved.files[index]?.afterHash);
    assert.equal(entry.restoreHash, saved.files[index]?.beforeHash);
    assert.equal(entry.currentHash, saved.files[index]?.afterHash);
  }
  assert.ok(preview.totalBytes > 0);
  assert.ok(preview.limits.maxFiles >= 4);
  assert.ok(preview.limits.maxFileBytes > 0 && preview.limits.maxTotalBytes > 0);
  assert.equal(f.store.getSnapshot(f.sessionId).lastSeq, beforeSeq);
  assert.equal(await fs.readFile(path.join(f.workspace.root, 'updated.txt'), 'utf8'), 'engine text');
  assert.equal(await fs.readFile(path.join(f.workspace.root, 'created.txt'), 'utf8'), 'created engine text');
  await assert.rejects(fs.lstat(path.join(f.workspace.root, 'deleted.txt')), { code: 'ENOENT' });
});

for (const state of ['created', 'running', 'awaiting_approval', 'cancelling'] as const) test(`restore rejects a ${state} Run in another workspace session before effects`, async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('a.txt', 'user before', 'engine after')]);
  const otherSessionId = randomUUID();
  f.store.createSession({ id: otherSessionId, workspaceId: f.workspace.id, title: 'another session', createdAt: new Date().toISOString() });
  const receipt = f.store.admit({ sessionId: otherSessionId, requestId: randomUUID(), prompt: 'active run', config: { providerId: 'scripted', modelId: 'local', mode: 'build', limits: DEFAULT_LIMITS } });
  if (state !== 'created') f.store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
  if (state === 'awaiting_approval' || state === 'cancelling') f.store.commit(receipt.runId, `run.${state}`, {}, { run: { state: state as RunState } });
  const preview = await previewRestoreCheckpoint(f.store, f.workspace, saved.id);
  assert.equal(preview.canRestore, false);
  assert.deepEqual(preview.activeRunIds, [receipt.runId]);
  await assert.rejects(restoreCheckpoint(f.store, f.workspace, saved.id, { executionLockPath: f.executionLockPath }), hasCode('RESTORE_WORKSPACE_BUSY'));
  assert.equal(await fs.readFile(path.join(f.workspace.root, 'a.txt'), 'utf8'), 'engine after');
});

test('restore rejects an old preview after external edits before restoring any independent file', async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('safe.txt', 'safe before', 'safe after'), image('edited.txt', 'edited before', 'edited after')]);
  const preview = await previewRestoreCheckpoint(f.store, f.workspace, saved.id);
  await fs.writeFile(path.join(f.workspace.root, 'edited.txt'), 'external user edit');
  const updated = await previewRestoreCheckpoint(f.store, f.workspace, saved.id);
  assert.notEqual(updated.fingerprint, preview.fingerprint);
  assert.equal(updated.files.find((entry) => entry.path === 'edited.txt')?.status, 'conflict');
  await assert.rejects(restoreCheckpoint(f.store, f.workspace, saved.id, { executionLockPath: f.executionLockPath, previewFingerprint: preview.fingerprint }), hasCode('RESTORE_PREVIEW_STALE'));
  assert.equal(await fs.readFile(path.join(f.workspace.root, 'safe.txt'), 'utf8'), 'safe after');
  assert.equal(await fs.readFile(path.join(f.workspace.root, 'edited.txt'), 'utf8'), 'external user edit');
});

test('restore preview binds file identity even when a replacement has identical content', async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('a.txt', 'before', 'after')]);
  const preview = await previewRestoreCheckpoint(f.store, f.workspace, saved.id);
  const target = path.join(f.workspace.root, 'a.txt');
  await fs.rename(target, path.join(f.workspace.root, 'old-a.txt'));
  await fs.writeFile(target, 'after');
  const replaced = await previewRestoreCheckpoint(f.store, f.workspace, saved.id);
  assert.equal(replaced.files[0]?.currentHash, preview.files[0]?.currentHash);
  assert.notEqual(replaced.fingerprint, preview.fingerprint);
  await assert.rejects(restoreCheckpoint(f.store, f.workspace, saved.id, { previewFingerprint: preview.fingerprint }), hasCode('RESTORE_PREVIEW_STALE'));
  assert.equal(await fs.readFile(target, 'utf8'), 'after');
});

test('restore preserves an identical-content replacement made after fingerprint revalidation', async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('a.txt', 'user before', 'engine after')]);
  const preview = await previewRestoreCheckpoint(f.store, f.workspace, saved.id);
  const target = path.join(f.workspace.root, 'a.txt');
  const originalOpen = fs.open, originalLstat = fs.lstat;
  let readonlyCloses = 0, replaced = false;
  let replacementIdentity: { dev: number; ino: number } | undefined;
  const mockedLstat = context.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    // One readonly close is preflight; the second is the fingerprint recheck.
    // Replace before the final writable guard observes the target's new inode,
    // so its local open/stat checks pass and retained preflight identity matters.
    if (String(args[0]) === target && readonlyCloses >= 2 && !replaced) {
      replaced = true;
      await fs.rename(target, path.join(f.workspace.root, 'previous-a.txt'));
      await fs.writeFile(target, 'engine after');
      const info = await originalLstat(target);
      replacementIdentity = { dev: info.dev, ino: info.ino };
    }
    return originalLstat(...args);
  });
  const mockedOpen: typeof fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === target && readonly(args[1])) {
      const close = handle.close.bind(handle);
      context.mock.method(handle, 'close', async () => { await close(); readonlyCloses++; });
    }
    return handle;
  };
  try {
    const result = await withOpenMock(context, mockedOpen, () => restoreCheckpoint(f.store, f.workspace, saved.id, { executionLockPath: f.executionLockPath, previewFingerprint: preview.fingerprint }));
    assert.equal(replaced, true);
    assert.deepEqual(result.restored, []);
    assert.equal(result.conflicts.length, 1);
    assert.match(result.conflicts[0]?.reason ?? '', /identity.*preflight/);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.observations, []);
    assert.equal(await fs.readFile(target, 'utf8'), 'engine after');
    const current = await originalLstat(target);
    assert.deepEqual({ dev: current.dev, ino: current.ino }, replacementIdentity);
    assert.equal(result.effectsUncertain, false);
    assert.equal(result.executionBlocked, false);
    assert.equal(activeMarker(f.executionLockPath), 0);
  } finally {
    mockedLstat.mock.restore();
    syncBuiltinESMExports();
  }
});

test('a Run admitted during the final writable guard prevents restoration effects', async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('a.txt', 'user before', 'engine after')]);
  const target = path.join(f.workspace.root, 'a.txt');
  const otherSessionId = randomUUID();
  f.store.createSession({ id: otherSessionId, workspaceId: f.workspace.id, title: 'late admission', createdAt: new Date().toISOString() });
  const originalOpen = fs.open;
  let admittedRunId: string | undefined;
  const mockedOpen: typeof fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === target && writable(args[1]) && admittedRunId === undefined) {
      admittedRunId = f.store.admit({ sessionId: otherSessionId, requestId: randomUUID(), prompt: 'admitted during restore guard', config: { providerId: 'scripted', modelId: 'local', mode: 'build', limits: DEFAULT_LIMITS } }).runId;
    }
    return handle;
  };
  await withOpenMock(context, mockedOpen, async () => {
    await assert.rejects(restoreCheckpoint(f.store, f.workspace, saved.id, { executionLockPath: f.executionLockPath }), hasCode('RESTORE_WORKSPACE_BUSY'));
  });
  assert.ok(admittedRunId);
  assert.equal(f.store.getRun(admittedRunId).state, 'created');
  assert.equal(await fs.readFile(target, 'utf8'), 'engine after');
  assert.equal(activeMarker(f.executionLockPath), 0);
  assertExecutionLockAvailable(f.executionLockPath);
});

test('restore rejects a preview invalidated while the shared execution lock is held', async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('safe.txt', 'safe before', 'safe after'), image('edited.txt', 'edited before', 'edited after')]);
  const preview = await previewRestoreCheckpoint(f.store, f.workspace, saved.id);
  const target = path.join(f.workspace.root, 'edited.txt');
  const originalOpen = fs.open;
  let changedUnderLock = false;
  const mockedOpen: typeof fs.open = async (...args) => {
    if (String(args[0]) === target && readonly(args[1]) && !changedUnderLock && existsSync(f.executionLockPath)) {
      try { assertExecutionLockAvailable(f.executionLockPath); }
      catch (error) {
        if (hasCode('COMMAND_EFFECTS_BUSY')(error)) {
          changedUnderLock = true;
          await fs.writeFile(target, 'external change during lock preflight');
        } else throw error;
      }
    }
    return originalOpen(...args);
  };
  await withOpenMock(context, mockedOpen, async () => {
    await assert.rejects(restoreCheckpoint(f.store, f.workspace, saved.id, { executionLockPath: f.executionLockPath, previewFingerprint: preview.fingerprint }), hasCode('RESTORE_PREVIEW_STALE'));
  });
  assert.equal(changedUnderLock, true);
  assert.equal(await fs.readFile(path.join(f.workspace.root, 'safe.txt'), 'utf8'), 'safe after');
  assert.equal(await fs.readFile(target, 'utf8'), 'external change during lock preflight');
  assertExecutionLockAvailable(f.executionLockPath);
});

test('restore refuses a held execution lock and preserves the workspace', async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('a.txt', 'before', 'after')]);
  const owner = acquireExecutionLock(f.executionLockPath);
  try {
    await assert.rejects(restoreCheckpoint(f.store, f.workspace, saved.id, { executionLockPath: f.executionLockPath }), hasCode('COMMAND_EFFECTS_BUSY'));
    assert.equal(await fs.readFile(path.join(f.workspace.root, 'a.txt'), 'utf8'), 'after');
  } finally { owner.release(true); }
});

test('restore refuses an orphaned active execution marker after reopening the record store', async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('a.txt', 'before', 'after')]);
  acquireExecutionLock(f.executionLockPath).release(false);
  f.reopen();
  await assert.rejects(restoreCheckpoint(f.store, f.workspace, saved.id, { executionLockPath: f.executionLockPath }), hasCode('COMMAND_CLEANUP_UNCERTAIN'));
  assert.equal(activeMarker(f.executionLockPath), 1);
  assert.equal(await fs.readFile(path.join(f.workspace.root, 'a.txt'), 'utf8'), 'after');
});

test('restore holds the shared lock through handle close and postimage accounting', async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('a.txt', 'before', 'longer engine after')]);
  const target = path.join(f.workspace.root, 'a.txt');
  const originalOpen = fs.open;
  let effectDone = false, checkedClose = false, checkedAccounting = false;
  const mockedOpen: typeof fs.open = async (...args) => {
    if (String(args[0]) === target && readonly(args[1]) && effectDone) {
      assert.throws(() => assertExecutionLockAvailable(f.executionLockPath), hasCode('COMMAND_EFFECTS_BUSY'));
      checkedAccounting = true;
    }
    const handle = await originalOpen(...args);
    if (String(args[0]) === target && writable(args[1])) {
      const sync = handle.sync.bind(handle), close = handle.close.bind(handle);
      context.mock.method(handle, 'sync', async () => { await sync(); effectDone = true; });
      context.mock.method(handle, 'close', async () => {
        assert.throws(() => assertExecutionLockAvailable(f.executionLockPath), hasCode('COMMAND_EFFECTS_BUSY'));
        checkedClose = true;
        await close();
      });
    }
    return handle;
  };
  const result = await withOpenMock(context, mockedOpen, () => restoreCheckpoint(f.store, f.workspace, saved.id, { executionLockPath: f.executionLockPath }));
  assert.deepEqual(result.restored, ['a.txt']);
  assert.equal(checkedClose, true);
  assert.equal(checkedAccounting, true);
  assert.equal(result.effectsUncertain, false);
  assert.equal(result.executionBlocked, false);
  assert.equal(activeMarker(f.executionLockPath), 0);
  assertExecutionLockAvailable(f.executionLockPath);
});

test('a checkpoint remains previewable and restorable after closing and reopening SQLite', async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('updated.txt', 'user original', 'engine after'), image('created.txt', null, 'created'), image('deleted.txt', 'deleted original', null)]);
  f.reopen();
  assert.equal(f.store.listCheckpoints(saved.runId)[0]?.id, saved.id);
  const preview = await previewRestoreCheckpoint(f.store, f.workspace, saved.id);
  const result = await restoreCheckpoint(f.store, f.workspace, saved.id, { executionLockPath: f.executionLockPath, previewFingerprint: preview.fingerprint });
  assert.deepEqual(result.restored, ['updated.txt', 'created.txt', 'deleted.txt']);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.failed, []);
  assert.equal(result.cancelled, false);
  assert.equal(result.effectsUncertain, false);
  assert.equal(result.executionBlocked, false);
  assert.equal(await fs.readFile(path.join(f.workspace.root, 'updated.txt'), 'utf8'), 'user original');
  assert.equal(await fs.readFile(path.join(f.workspace.root, 'deleted.txt'), 'utf8'), 'deleted original');
  await assert.rejects(fs.lstat(path.join(f.workspace.root, 'created.txt')), { code: 'ENOENT' });
  const createdObservation = result.observations.find((entry) => entry.path === 'created.txt');
  assert.equal(createdObservation?.state, 'absent');
  assert.equal(createdObservation?.currentHash, null);
  assertExecutionLockAvailable(f.executionLockPath);
});

test('legacy three-argument restore remains functional without a preview fingerprint', async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('a.txt', 'before', 'after')]);
  const result = await restoreCheckpoint(f.store, f.workspace, saved.id);
  assert.deepEqual(result.restored, ['a.txt']);
  assert.equal(await fs.readFile(path.join(f.workspace.root, 'a.txt'), 'utf8'), 'before');
});

test('preaborted preview and restore fail before filesystem effects', async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('a.txt', 'before', 'after')]);
  const signal = AbortSignal.abort();
  await assert.rejects(previewRestoreCheckpoint(f.store, f.workspace, saved.id, { signal }), hasCode('CANCELLED'));
  await assert.rejects(restoreCheckpoint(f.store, f.workspace, saved.id, { signal, executionLockPath: f.executionLockPath }), hasCode('CANCELLED'));
  assert.equal(await fs.readFile(path.join(f.workspace.root, 'a.txt'), 'utf8'), 'after');
});

test('mid-write cancellation waits for pending I/O then accounts effects and releases the lock', { timeout: 8_000 }, async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('first.txt', 'old-a', 'after-a'), image('second.txt', 'old-b', 'after-b')]);
  const target = path.join(f.workspace.root, 'first.txt');
  const originalOpen = fs.open;
  const controller = new AbortController();
  const writing = deferred(), finishWrite = deferred();
  let gated = false;
  const mockedOpen: typeof fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === target && writable(args[1])) {
      const write = handle.write.bind(handle);
      context.mock.method(handle, 'write', async (buffer: Buffer, offset: number, length: number, position: number) => {
        if (!gated) {
          gated = true;
          writing.resolve();
          await finishWrite.promise;
          return write(buffer, offset, Math.min(2, length), position);
        }
        return write(buffer, offset, length, position);
      });
    }
    return handle;
  };
  const result = await withOpenMock(context, mockedOpen, async () => {
    let settled = false;
    const restoring = restoreCheckpoint(f.store, f.workspace, saved.id, { signal: controller.signal, executionLockPath: f.executionLockPath }).then((value) => { settled = true; return value; }, (error: unknown) => { settled = true; throw error; });
    try {
      await Promise.race([writing.promise, restoring.then(() => { throw new Error('Restoration settled before the write began'); })]);
      controller.abort();
      await nextTurn();
      assert.equal(settled, false, 'Cancellation must wait for the in-flight write to settle');
      assert.throws(() => assertExecutionLockAvailable(f.executionLockPath), hasCode('COMMAND_EFFECTS_BUSY'));
    } finally { finishWrite.resolve(); }
    return restoring;
  });
  assert.equal(result.cancelled, true);
  assert.equal(await fs.readFile(path.join(f.workspace.root, 'second.txt'), 'utf8'), 'after-b');
  const surviving = await fs.readFile(target);
  const observed = result.observations.find((entry) => entry.path === 'first.txt');
  assert.equal(observed?.state, 'present');
  assert.equal(observed?.currentHash, digest(surviving));
  assert.equal(observed?.bytes, surviving.byteLength);
  assert.equal(result.effectsUncertain, false);
  assert.equal(result.executionBlocked, false);
  assert.equal(activeMarker(f.executionLockPath), 0);
  assertExecutionLockAvailable(f.executionLockPath);
});

test('abort during post-effect observation waits for accounting and releases a settled marker', { timeout: 8_000 }, async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('a.txt', 'user original', 'longer engine postimage')]);
  const target = path.join(f.workspace.root, 'a.txt');
  const originalOpen = fs.open;
  const controller = new AbortController();
  const observing = deferred(), finishObservation = deferred();
  let effectsDone = false, gated = false;
  const mockedOpen: typeof fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === target && writable(args[1])) {
      const sync = handle.sync.bind(handle);
      context.mock.method(handle, 'sync', async () => { await sync(); effectsDone = true; });
    }
    if (String(args[0]) === target && readonly(args[1]) && effectsDone) {
      const read = handle.read.bind(handle);
      context.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
        if (!gated) {
          gated = true;
          observing.resolve();
          await finishObservation.promise;
        }
        return read(buffer, offset, length, position);
      });
    }
    return handle;
  };
  const result = await withOpenMock(context, mockedOpen, async () => {
    let settled = false;
    const restoring = restoreCheckpoint(f.store, f.workspace, saved.id, { signal: controller.signal, executionLockPath: f.executionLockPath }).then((value) => { settled = true; return value; }, (error: unknown) => { settled = true; throw error; });
    try {
      await Promise.race([observing.promise, restoring.then(() => { throw new Error('Restoration settled before post-effect observation began'); })]);
      assert.equal(await fs.readFile(target, 'utf8'), 'user original');
      controller.abort();
      await nextTurn();
      assert.equal(settled, false, 'Cancellation must wait for the post-effect observation to settle');
      assert.throws(() => assertExecutionLockAvailable(f.executionLockPath), hasCode('COMMAND_EFFECTS_BUSY'));
    } finally { finishObservation.resolve(); }
    return restoring;
  });
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.restored, ['a.txt']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.conflicts, []);
  assert.equal(await fs.readFile(target, 'utf8'), 'user original');
  const observed = result.observations.find((entry) => entry.path === 'a.txt');
  assert.equal(observed?.state, 'present');
  assert.equal(observed?.currentHash, digest('user original'));
  assert.equal(observed?.bytes, Buffer.byteLength('user original'));
  assert.equal(result.effectsUncertain, false);
  assert.equal(result.executionBlocked, false);
  assert.equal(activeMarker(f.executionLockPath), 0);
  assertExecutionLockAvailable(f.executionLockPath);
});

test('an observed partial write failure releases the durable marker after accounting', async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('safe.txt', 'safe before', 'safe after'), image('failing.txt', 'old', 'long engine postimage')]);
  const target = path.join(f.workspace.root, 'failing.txt');
  const originalOpen = fs.open;
  const mockedOpen: typeof fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === target && writable(args[1])) context.mock.method(handle, 'truncate', async () => { throw new Error('Injected truncate failure after a positional write'); });
    return handle;
  };
  const result = await withOpenMock(context, mockedOpen, () => restoreCheckpoint(f.store, f.workspace, saved.id, { executionLockPath: f.executionLockPath }));
  assert.deepEqual(result.restored, ['safe.txt']);
  assert.equal(result.failed.find((entry) => entry.path === 'failing.txt')?.mayHaveChanged, true);
  const surviving = await fs.readFile(target);
  assert.equal(result.observations.find((entry) => entry.path === 'failing.txt')?.currentHash, digest(surviving));
  assert.equal(result.effectsUncertain, false);
  assert.equal(result.executionBlocked, false);
  assert.equal(activeMarker(f.executionLockPath), 0);
  assertExecutionLockAvailable(f.executionLockPath);
});

test('unobserved effects retain the active durable marker and block another restore', async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('a.txt', 'old', 'long engine postimage')]);
  const target = path.join(f.workspace.root, 'a.txt');
  const originalOpen = fs.open;
  let effectsStarted = false;
  const mockedOpen: typeof fs.open = async (...args) => {
    if (String(args[0]) === target && readonly(args[1]) && effectsStarted) throw new Error('Injected postimage observation failure');
    const handle = await originalOpen(...args);
    if (String(args[0]) === target && writable(args[1])) {
      context.mock.method(handle, 'truncate', async () => { effectsStarted = true; throw new Error('Injected partial restoration failure'); });
    }
    return handle;
  };
  const result = await withOpenMock(context, mockedOpen, () => restoreCheckpoint(f.store, f.workspace, saved.id, { executionLockPath: f.executionLockPath }));
  assert.equal(result.effectsUncertain, true);
  assert.equal(result.executionBlocked, true);
  const observed = result.observations.find((entry) => entry.path === 'a.txt');
  assert.equal(observed?.state, 'unobserved');
  assert.match(observed?.error ?? '', /observation failure/);
  assert.equal(activeMarker(f.executionLockPath), 1);
  await assert.rejects(restoreCheckpoint(f.store, f.workspace, saved.id, { executionLockPath: f.executionLockPath }), hasCode('COMMAND_CLEANUP_UNCERTAIN'));
});

test('a failed writable-handle close retains the marker despite an observable postimage', async (context) => {
  const f = await fixture(context);
  const saved = await f.save([image('a.txt', 'before', 'after')]);
  const target = path.join(f.workspace.root, 'a.txt');
  const originalOpen = fs.open;
  const mockedOpen: typeof fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === target && writable(args[1])) {
      const close = handle.close.bind(handle);
      context.mock.method(handle, 'close', async () => { await close(); throw new Error('Injected close acknowledgement failure'); });
    }
    return handle;
  };
  const result = await withOpenMock(context, mockedOpen, () => restoreCheckpoint(f.store, f.workspace, saved.id, { executionLockPath: f.executionLockPath }));
  assert.equal(result.effectsUncertain, true);
  assert.equal(result.executionBlocked, true);
  assert.equal(result.observations.find((entry) => entry.path === 'a.txt')?.state, 'present');
  assert.equal(activeMarker(f.executionLockPath), 1);
  assert.throws(() => assertExecutionLockAvailable(f.executionLockPath), hasCode('COMMAND_CLEANUP_UNCERTAIN'));
});
