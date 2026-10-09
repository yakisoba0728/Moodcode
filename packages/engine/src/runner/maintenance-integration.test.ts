import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTick } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import {
  DEFAULT_LIMITS, EngineError,
  type Checkpoint, type RunReceipt, type Session, type SubmitInput, type Workspace,
} from '@moodcode/contracts';
import { buildContext } from '../context/index.js';
import { ApprovalManager } from '../permission/index.js';
import { ScriptedProvider } from '../provider/index.js';
import { getReviewDiff, previewRestoreCheckpoint, restoreCheckpoint, type RestoreResult } from '../review/index.js';
import { SqliteStore } from '../storage/index.js';
import { acquireExecutionLock, assertExecutionLockAvailable, inspectExecutionLock } from '../tools/command/execution-lock.js';
import { RunCoordinator } from './index.js';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const hasCode = (code: string) => (error: unknown): boolean => error instanceof EngineError && error.code === code;
const writable = (flags: Parameters<typeof fs.open>[1]): boolean => typeof flags === 'number' && (flags & 3) === constants.O_RDWR;
const readonly = (flags: Parameters<typeof fs.open>[1]): boolean => typeof flags === 'number' && (flags & 3) === constants.O_RDONLY;

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => { resolve = finish; });
  return { promise, resolve };
}

async function fixture(t: TestContext, workspaceCount = 1) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'moodcode-maintenance-')));
  const store = new SqliteStore(join(directory, 'records.sqlite'));
  const scripted = new ScriptedProvider();
  const executionLockPath = join(directory, 'effects.sqlite');
  const runner = new RunCoordinator({
    store, providers: new Map([[scripted.id, scripted]]), tools: [],
    approvals: new ApprovalManager(store), artifactDir: join(directory, 'artifacts'), executionLockPath, buildContext,
  });
  let expectedCloseError: unknown;
  t.after(async () => {
    const failures: unknown[] = [], closedResources: string[] = [];
    try { await runner.close(); closedResources.push('runner'); } catch (error) { failures.push(error); }
    try { await store.closeAsync(); closedResources.push('store'); } catch (error) { failures.push(error); }
    const expectedFailureObserved = failures.length === 1 && failures[0] === expectedCloseError;
    const retention = { schemaVersion: 1, kind: 'runner-fixture-retention', root: directory, outcome: failures.length ? 'close-error' : t.error ? 'failure' : t.passed === true ? 'success' : 'unknown', closedResources, closeFailures: failures.length, expectedFailureObserved, nativeCleanupConfirmed: null, databaseRemoved: false };
    let manifestWritten = false;
    try { await fs.writeFile(join(directory, 'fixture-retention.json'), JSON.stringify(retention) + '\n', { flag: 'wx', mode: 0o600 }); manifestWritten = true; } catch { /* Preserve the first owned close error. */ }
    try { t.diagnostic(JSON.stringify({ ...retention, manifestWritten })); } catch { /* Diagnostics cannot replace close failure. */ }
    // Only the exact close rejection already asserted by this test is acknowledged.
    if (failures.length && !expectedFailureObserved) throw failures[0];
  });
  const workspaces: Workspace[] = [];
  const sessions: Session[] = [];
  for (let index = 0; index < workspaceCount; index++) {
    const root = join(directory, `workspace-${index}`);
    await fs.mkdir(root);
    const workspace = store.putWorkspace({ id: randomUUID(), root, gitRoot: root, branch: null, createdAt: new Date().toISOString() });
    workspaces.push(workspace);
    sessions.push(store.createSession({ id: randomUUID(), workspaceId: workspace.id, title: `Maintenance ${index}`, createdAt: workspace.createdAt }));
  }
  const input = (session = sessions[0]!, providerId = scripted.id): SubmitInput => ({
    sessionId: session.id, requestId: randomUUID(), prompt: 'Check the maintenance fixture',
    config: { providerId, modelId: 'local', mode: 'build', limits: { ...DEFAULT_LIMITS, maxDurationMs: 10_000 } },
  });
  return { directory, store, runner, scripted, executionLockPath, workspaces, sessions, input, expectCloseError(error: unknown) { expectedCloseError = error; } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Persist a valid completed patch checkpoint and its real current postimage. */
async function checkpoint(f: Fixture): Promise<{ checkpoint: Checkpoint; input: SubmitInput; receipt: RunReceipt; target: string }> {
  const submitted = f.input();
  const receipt = f.store.admit(submitted);
  const target = join(f.workspaces[0]!.root, 'target.txt');
  const before = 'user preimage\n';
  const after = 'engine postimage\n';
  await fs.writeFile(target, after);
  f.store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
  const tool = { id: randomUUID(), runId: receipt.runId, sessionId: submitted.sessionId, name: 'apply_patch', input: {}, state: 'running' as const };
  f.store.commit(receipt.runId, 'tool.running', { toolCallId: tool.id }, { tool });
  const saved: Checkpoint = {
    id: randomUUID(), runId: receipt.runId, toolCallId: tool.id, kind: 'patch', createdAt: new Date().toISOString(), warnings: [],
    files: [{ path: 'target.txt', before, after, beforeHash: digest(before), afterHash: digest(after) }],
  };
  f.store.commit(receipt.runId, 'workspace.changed', { checkpointId: saved.id, toolCallId: tool.id }, { checkpoint: saved });
  f.store.commit(receipt.runId, 'tool.completed', { toolCallId: tool.id }, { tool: { ...tool, state: 'completed', output: 'Recorded patch fixture' } });
  f.store.commit(receipt.runId, 'run.completed', {}, { run: { state: 'completed' } });
  return { checkpoint: saved, input: submitted, receipt, target };
}

function restore(f: Fixture, saved: Checkpoint, signal: AbortSignal, previewFingerprint?: string): Promise<RestoreResult> {
  return restoreCheckpoint(f.store, f.workspaces[0]!, saved.id, {
    signal, executionLockPath: f.executionLockPath, ...(previewFingerprint ? { previewFingerprint } : {}),
  });
}

async function withOpenMock<T>(t: TestContext, implementation: typeof fs.open, operation: () => Promise<T>): Promise<T> {
  const mocked = t.mock.method(fs, 'open', implementation);
  syncBuiltinESMExports();
  try { return await operation(); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
}

test('persisted unowned active runs in another session prevent maintenance before the callback starts', { timeout: 15_000 }, async (t) => {
  for (const state of ['created', 'running', 'awaiting_approval', 'cancelling'] as const) {
    await t.test(state, async (t) => {
      const f = await fixture(t);
      const saved = await checkpoint(f);
      const workspace = f.workspaces[0]!;
      const other = f.store.createSession({ id: randomUUID(), workspaceId: workspace.id, title: 'Persisted unowned run', createdAt: new Date().toISOString() });
      const active = f.store.admit(f.input(other));
      if (state !== 'created') f.store.commit(active.runId, 'run.started', {}, { run: { state: 'running' } });
      if (state === 'awaiting_approval' || state === 'cancelling') f.store.commit(active.runId, `run.${state}`, {}, { run: { state } });
      const lastSeq = f.store.getSnapshot(other.id).lastSeq;
      let called = false;
      await assert.rejects(async () => f.runner.withWorkspaceLease(workspace.id, (signal) => {
        called = true;
        return restore(f, saved.checkpoint, signal);
      }), hasCode('WORKSPACE_BUSY'));
      assert.equal(called, false);
      assert.equal(f.store.getRun(active.runId).state, state);
      assert.equal(f.store.getSnapshot(other.id).lastSeq, lastSeq);
      assert.equal(await fs.readFile(saved.target, 'utf8'), saved.checkpoint.files[0]!.after);
      assert.equal(f.scripted.callCount, 0);
      assert.equal(inspectExecutionLock(f.executionLockPath).status, 'not_initialized');
    });
  }
});

test('the actual restore writable guard rejects late Run admission and competing maintenance before file effects', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const saved = await checkpoint(f);
  const preview = await previewRestoreCheckpoint(f.store, f.workspaces[0]!, saved.checkpoint.id, { executionLockPath: f.executionLockPath });
  assert.equal(preview.canRestore, true);
  const sameWorkspaceSession = f.store.createSession({ id: randomUUID(), workspaceId: f.workspaces[0]!.id, title: 'Concurrent admission', createdAt: new Date().toISOString() });
  const originalOpen = fs.open;
  let checked = false;
  const mockedOpen: typeof fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === saved.target && writable(args[1])) {
      checked = true;
      assert.throws(() => f.runner.submit(f.input(sameWorkspaceSession)), hasCode('WORKSPACE_BUSY'));
      assert.equal(f.store.getSnapshot(sameWorkspaceSession.id).runs.length, 0);
      assert.deepEqual(f.runner.submit(saved.input), { ...saved.receipt, duplicate: true });
      assert.throws(() => f.runner.submit({ ...saved.input, prompt: 'Conflicting normalized input' }), hasCode('REQUEST_ID_CONFLICT'));
      let competingCalled = false;
      await assert.rejects(async () => f.runner.withWorkspaceLease(f.workspaces[0]!.id, (signal) => {
        competingCalled = true;
        return previewRestoreCheckpoint(f.store, f.workspaces[0]!, saved.checkpoint.id, { signal });
      }), hasCode('WORKSPACE_BUSY'));
      assert.equal(competingCalled, false);
    }
    return handle;
  };
  const result = await withOpenMock(t, mockedOpen, () => f.runner.withWorkspaceLease(f.workspaces[0]!.id, (signal) => restore(f, saved.checkpoint, signal, preview.fingerprint)));
  assert.equal(checked, true);
  assert.deepEqual(result.restored, ['target.txt']);
  assert.equal(result.effectsUncertain, false); assert.equal(result.executionBlocked, false);
  assert.equal(await fs.readFile(saved.target, 'utf8'), saved.checkpoint.files[0]!.before);
  assertExecutionLockAvailable(f.executionLockPath);
  const admitted = f.runner.submit(f.input(sameWorkspaceSession));
  assert.equal((await f.runner.waitForRun(admitted.runId)).state, 'completed');
  assert.equal(f.store.listCheckpoints(saved.receipt.runId).length, 1);
});

test('close aborts an actual restore during after-effect accounting and waits for callback finally cleanup', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const saved = await checkpoint(f);
  const accountingEntered = deferred(), accountingRelease = deferred();
  const cleanupEntered = deferred(), cleanupRelease = deferred();
  const originalOpen = fs.open;
  let wroteAndClosed = false;
  let leaseSignal: AbortSignal | undefined;
  let observedResult: RestoreResult | undefined;
  const mockedOpen: typeof fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === saved.target && writable(args[1])) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { await close(); wroteAndClosed = true; });
    } else if (String(args[0]) === saved.target && readonly(args[1]) && wroteAndClosed) {
      accountingEntered.resolve();
      await accountingRelease.promise;
    }
    return handle;
  };
  await withOpenMock(t, mockedOpen, async () => {
    const restoring = f.runner.withWorkspaceLease(f.workspaces[0]!.id, async (signal) => {
      leaseSignal = signal;
      try { observedResult = await restore(f, saved.checkpoint, signal); return observedResult; }
      finally { cleanupEntered.resolve(); await cleanupRelease.promise; }
    });
    void restoring.catch(() => {});
    let closing: Promise<void> | undefined;
    let closed = false;
    try {
      await accountingEntered.promise;
      assert.equal(inspectExecutionLock(f.executionLockPath).status, 'busy');
      closing = f.runner.close().then(() => { closed = true; });
      assert.equal(leaseSignal!.aborted, true);
      assert.ok(leaseSignal!.reason instanceof EngineError); assert.equal(leaseSignal!.reason.code, 'ENGINE_CLOSED');
      await nextTick(); assert.equal(closed, false);
      accountingRelease.resolve();
      await cleanupEntered.promise;
      assert.ok(observedResult);
      assert.equal(observedResult.cancelled, true);
      assert.deepEqual(observedResult.restored, ['target.txt']);
      assert.equal(observedResult.observations[0]?.currentHash, saved.checkpoint.files[0]!.beforeHash);
      assert.equal(observedResult.effectsUncertain, false);
      assert.equal(await fs.readFile(saved.target, 'utf8'), saved.checkpoint.files[0]!.before);
      assertExecutionLockAvailable(f.executionLockPath);
      await nextTick(); assert.equal(closed, false, 'The callback finally gate remains part of the maintenance owner');
      cleanupRelease.resolve();
      const result = await restoring;
      assert.equal(result, observedResult, 'Safe cancellation accounting is returned to the caller');
      await closing; assert.equal(closed, true);
    } finally {
      accountingRelease.resolve(); cleanupRelease.resolve();
      await restoring.catch(() => {}); await closing?.catch(() => {});
    }
  });
});

test('safe actual restore errors release the maintenance lease and leave external edits intact', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const saved = await checkpoint(f);
  const preview = await previewRestoreCheckpoint(f.store, f.workspaces[0]!, saved.checkpoint.id);
  await fs.writeFile(saved.target, 'external user edit\n');
  await assert.rejects(f.runner.withWorkspaceLease(f.workspaces[0]!.id, (signal) => restore(f, saved.checkpoint, signal, preview.fingerprint)), hasCode('RESTORE_PREVIEW_STALE'));
  assertExecutionLockAvailable(f.executionLockPath);
  const refreshed = await f.runner.withWorkspaceLease(f.workspaces[0]!.id, (signal) => previewRestoreCheckpoint(f.store, f.workspaces[0]!, saved.checkpoint.id, { signal }));
  assert.equal(refreshed.canRestore, false); assert.equal(refreshed.files[0]?.status, 'conflict');
  assert.equal(await fs.readFile(saved.target, 'utf8'), 'external user edit\n');
  const receipt = f.runner.submit(f.input());
  assert.equal((await f.runner.waitForRun(receipt.runId)).state, 'completed');
});

test('actual unobserved restore effects quarantine the workspace and preserve the durable execution marker', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, 2);
  const saved = await checkpoint(f);
  const originalOpen = fs.open;
  let wroteAndClosed = false;
  let result: RestoreResult | undefined;
  const mockedOpen: typeof fs.open = async (...args) => {
    if (String(args[0]) === saved.target && readonly(args[1]) && wroteAndClosed) {
      throw Object.assign(new Error('Injected post-effect observation read failure'), { code: 'EACCES' });
    }
    const handle = await originalOpen(...args);
    if (String(args[0]) === saved.target && writable(args[1])) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { await close(); wroteAndClosed = true; });
    }
    return handle;
  };
  await withOpenMock(t, mockedOpen, async () => {
    await assert.rejects(f.runner.withWorkspaceLease(f.workspaces[0]!.id, async (signal) => {
      result = await restore(f, saved.checkpoint, signal); return result;
    }), hasCode('CLEANUP_UNCERTAIN'));
  });
  assert.ok(result); assert.equal(result.effectsUncertain, true); assert.equal(result.executionBlocked, true);
  assert.equal(result.observations[0]?.state, 'unobserved');
  assert.equal(await fs.readFile(saved.target, 'utf8'), saved.checkpoint.files[0]!.before);
  assert.equal(inspectExecutionLock(f.executionLockPath).status, 'uncertain');
  assert.throws(() => assertExecutionLockAvailable(f.executionLockPath), hasCode('COMMAND_CLEANUP_UNCERTAIN'));
  assert.throws(() => f.runner.submit(f.input()), hasCode('CLEANUP_PENDING'));
  assert.deepEqual(f.runner.submit(saved.input), { ...saved.receipt, duplicate: true });
  assert.throws(() => f.runner.submit({ ...saved.input, prompt: 'Conflicting request in quarantine' }), hasCode('REQUEST_ID_CONFLICT'));
  let called = false;
  await assert.rejects(async () => f.runner.withWorkspaceLease(f.workspaces[0]!.id, async (signal) => {
    called = true; return restore(f, saved.checkpoint, signal);
  }), hasCode('CLEANUP_PENDING'));
  assert.equal(called, false);
  const unaffected = f.runner.submit(f.input(f.sessions[1]));
  assert.equal((await f.runner.waitForRun(unaffected.runId)).state, 'completed');
});

test('an actual restore error from a persisted uncertain command marker quarantines maintenance', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const saved = await checkpoint(f);
  acquireExecutionLock(f.executionLockPath).release(false);
  await assert.rejects(f.runner.withWorkspaceLease(f.workspaces[0]!.id, (signal) => restore(f, saved.checkpoint, signal)), hasCode('CLEANUP_UNCERTAIN'));
  assert.equal(await fs.readFile(saved.target, 'utf8'), saved.checkpoint.files[0]!.after);
  assert.equal(inspectExecutionLock(f.executionLockPath).status, 'uncertain');
  assert.throws(() => f.runner.submit(f.input()), hasCode('CLEANUP_PENDING'));
});

test('close rejects after actual restore observation fails during aborted accounting', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const saved = await checkpoint(f);
  const accountingEntered = deferred(), accountingRelease = deferred();
  const originalOpen = fs.open;
  let wroteAndClosed = false;
  let result: RestoreResult | undefined;
  const mockedOpen: typeof fs.open = async (...args) => {
    if (String(args[0]) === saved.target && readonly(args[1]) && wroteAndClosed) {
      accountingEntered.resolve(); await accountingRelease.promise;
      throw Object.assign(new Error('Injected accounting failure after close abort'), { code: 'EACCES' });
    }
    const handle = await originalOpen(...args);
    if (String(args[0]) === saved.target && writable(args[1])) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { await close(); wroteAndClosed = true; });
    }
    return handle;
  };
  await withOpenMock(t, mockedOpen, async () => {
    const restoring = f.runner.withWorkspaceLease(f.workspaces[0]!.id, async (signal) => {
      result = await restore(f, saved.checkpoint, signal); return result;
    });
    const rejected = assert.rejects(restoring, hasCode('CLEANUP_UNCERTAIN'));
    let closing: Promise<void> | undefined;
    try {
      await accountingEntered.promise;
      closing = assert.rejects(f.runner.close(), error => { assert.ok(hasCode('CLEANUP_UNCERTAIN')(error)); f.expectCloseError(error); return true; });
      accountingRelease.resolve();
      await Promise.all([rejected, closing]);
      assert.ok(result); assert.equal(result.cancelled, true); assert.equal(result.effectsUncertain, true);
      assert.equal(result.executionBlocked, true);
      assert.equal(inspectExecutionLock(f.executionLockPath).status, 'uncertain');
    } finally { accountingRelease.resolve(); await restoring.catch(() => {}); await closing?.catch(() => {}); }
  });
});

test('a separate SQLite metadata-table write lock quarantines successful observed restoration while preserving its result and history', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, 2);
  const saved = await checkpoint(f);
  const lastSeq = f.store.getSnapshot(saved.input.sessionId).lastSeq;
  const metadataPath = join(f.directory, 'metadata-fixture.sqlite');
  const writer = new DatabaseSync(metadataPath, { timeout: 0 });
  let blocker: DatabaseSync | undefined;
  let locked = false;
  try {
    // This is a scoped metadata-write fixture, not the ReviewJournal implementation.
    writer.exec('PRAGMA journal_mode=DELETE; CREATE TABLE restore_metadata(checkpoint_id TEXT PRIMARY KEY, status TEXT NOT NULL, result TEXT) STRICT');
    writer.prepare('INSERT INTO restore_metadata(checkpoint_id,status,result) VALUES(?,?,NULL)').run(saved.checkpoint.id, 'pending');
    const complete = writer.prepare('UPDATE restore_metadata SET status=?,result=? WHERE checkpoint_id=?');
    blocker = new DatabaseSync(metadataPath, { timeout: 0 });
    blocker.exec('BEGIN EXCLUSIVE'); locked = true;
    let metadataError: { code: string; sqliteCode: number; message: string } | undefined;
    let callbackResult: (RestoreResult & { recordMetadataError: typeof metadataError }) | undefined;
    const result = await f.runner.withWorkspaceLease(f.workspaces[0]!.id, async (signal) => {
      const observed = await restore(f, saved.checkpoint, signal);
      assert.equal(observed.effectsUncertain, false); assert.equal(observed.executionBlocked, false);
      try { complete.run('completed', JSON.stringify(observed), saved.checkpoint.id); }
      catch (error) {
        assert.ok(error instanceof Error);
        const native = error as Error & { errcode?: number };
        assert.equal((native.errcode ?? -1) & 0xff, 5, 'The metadata write failed with actual SQLITE_BUSY');
        metadataError = { code: 'SQLITE_BUSY', sqliteCode: native.errcode!, message: native.message };
        f.runner.quarantineWorkspace(f.workspaces[0]!.id);
      }
      assert.ok(metadataError, 'The second SQLite connection prevents the completion write');
      callbackResult = { ...observed, recordMetadataError: metadataError };
      return callbackResult;
    });
    assert.equal(result, callbackResult, 'The generic maintenance result is preserved');
    assert.equal(result.recordMetadataError, metadataError, 'The metadata error object is returned untouched');
    assert.equal(result.recordMetadataError!.code, 'SQLITE_BUSY');
    assert.deepEqual(result.restored, ['target.txt']);
    assert.equal(result.observations[0]?.currentHash, saved.checkpoint.files[0]!.beforeHash);
    assert.equal(result.effectsUncertain, false); assert.equal(result.executionBlocked, false);
    assert.equal(await fs.readFile(saved.target, 'utf8'), saved.checkpoint.files[0]!.before);
    assert.equal(inspectExecutionLock(f.executionLockPath).status, 'available');
    assertExecutionLockAvailable(f.executionLockPath);
    assert.throws(() => f.runner.submit(f.input()), hasCode('CLEANUP_PENDING'));
    await assert.rejects(async () => f.runner.withWorkspaceLease(f.workspaces[0]!.id, (signal) => restore(f, saved.checkpoint, signal)), hasCode('CLEANUP_PENDING'));
    assert.deepEqual(f.runner.submit(saved.input), { ...saved.receipt, duplicate: true });
    assert.throws(() => f.runner.submit({ ...saved.input, prompt: 'Conflicting input after metadata failure' }), hasCode('REQUEST_ID_CONFLICT'));
    const snapshot = f.store.getSnapshot(saved.input.sessionId);
    assert.equal(snapshot.lastSeq, lastSeq); assert.equal(snapshot.runs[0]?.state, 'completed');
    assert.equal(f.store.readEvents(saved.input.sessionId, 0).at(-1)?.type, 'run.completed');
    const review = getReviewDiff(f.store, saved.receipt.runId);
    assert.equal(review.checkpoints[0]?.id, saved.checkpoint.id);
    assert.equal(review.files[0]?.after, saved.checkpoint.files[0]!.after, 'Recorded history remains readable without rewriting it to the restored image');
    const other = f.runner.submit(f.input(f.sessions[1]));
    assert.equal((await f.runner.waitForRun(other.runId)).state, 'completed');
    blocker.exec('ROLLBACK'); locked = false;
    const row = writer.prepare('SELECT status,result FROM restore_metadata WHERE checkpoint_id=?').get(saved.checkpoint.id);
    assert.equal(row?.status, 'pending'); assert.equal(row?.result, null);
  } finally {
    if (locked) blocker?.exec('ROLLBACK');
    blocker?.close(); writer.close();
  }
});
