import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTick } from 'node:timers/promises';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, type Checkpoint, type CommandResult, type JsonObject, type RunReceipt, type Session, type SubmitInput, type Workspace } from '@moodcode/contracts';
import { createEngine, type RestoreCommandResult, type ReviewHistoryResult } from './engine.js';
import { retainBackendFixture } from './agent-backends/fixtures/backend.js';
import type { RestorePreview } from './review/index.js';
import { assertExecutionLockAvailable, inspectExecutionLock } from './tools/command/execution-lock.js';
import type { WorkspaceFilePresentation, WorkspaceFilesPresentation, WorkspaceStatusPresentation } from './workspace/presentation.js';

const execFileAsync = promisify(execFile);
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
type Engine = ReturnType<typeof createEngine>;

function dispatch(engine: Engine, type: string, payload: JsonObject, commandId: string = randomUUID()): Promise<CommandResult> {
  return engine.dispatch({ schemaVersion: 1, commandId, type, payload });
}
async function command<T>(engine: Engine, type: string, payload: JsonObject, commandId?: string): Promise<T> {
  const reply = await dispatch(engine, type, payload, commandId);
  assert.equal(reply.ok, true, `${type}: ${JSON.stringify(reply.error)}`);
  return reply.result as unknown as T;
}
function rejected(reply: CommandResult, code: string): void { assert.equal(reply.ok, false); assert.equal(reply.error?.code, code); }

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(process.env.MOODCODE_CONTEXT_FIXTURE_ROOT ?? tmpdir(), 'moodcode-gui-facade-')));
  const dbPath = join(directory, 'engine.sqlite');
  const artifactDir = join(directory, 'artifacts');
  let engine = createEngine({ dbPath, artifactDir });
  const engines = new Set([engine]);
  const workspaces: Workspace[] = [], sessions: Session[] = [];
  for (let index = 0; index < 2; index++) {
    const root = join(directory, `repo-${index}`);
    await mkdir(root); await execFileAsync('git', ['init', '--quiet', root]);
    await writeFile(join(root, 'target.txt'), 'user preimage\n');
    const workspace = await command<Workspace>(engine, 'workspace.open', { path: root });
    workspaces.push(workspace);
    sessions.push(await command<Session>(engine, 'session.create', { workspaceId: workspace.id, title: `Facade ${index}` }));
  }
  t.after(async () => { await retainBackendFixture(t, directory, engines); });
  const input = (index = 0): SubmitInput => ({ sessionId: sessions[index]!.id, requestId: randomUUID(), prompt: 'Facade fixture', config: { providerId: 'scripted', modelId: 'local', mode: 'build', limits: { ...DEFAULT_LIMITS } } });
  return {
    directory, dbPath, artifactDir, workspaces, sessions, input,
    get engine() { return engine; },
    async reopen() { await engine.close(); engine = createEngine({ dbPath, artifactDir }); engines.add(engine); return engine; },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Valid real SQLite accounting fixture; facade commands execute the actual restore service. */
async function saveCheckpoint(f: Fixture, active = false) {
  const input = f.input();
  const receipt = f.engine.store.admit(input);
  const target = join(f.workspaces[0]!.root, 'target.txt');
  const before = 'user preimage\n', after = 'engine postimage\n';
  await writeFile(target, after);
  f.engine.store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
  const tool = { id: randomUUID(), runId: receipt.runId, sessionId: input.sessionId, name: 'apply_patch', input: {}, state: 'running' as const };
  f.engine.store.commit(receipt.runId, 'tool.running', { toolCallId: tool.id }, { tool });
  const checkpoint: Checkpoint = { id: randomUUID(), runId: receipt.runId, toolCallId: tool.id, kind: 'patch', createdAt: new Date().toISOString(), warnings: [], files: [{ path: 'target.txt', before, after, beforeHash: hash(before), afterHash: hash(after) }] };
  f.engine.store.commit(receipt.runId, 'workspace.changed', { checkpointId: checkpoint.id }, { checkpoint });
  f.engine.store.commit(receipt.runId, 'tool.completed', { toolCallId: tool.id }, { tool: { ...tool, state: 'completed', output: 'Recorded fixture effects' } });
  if (!active) f.engine.store.commit(receipt.runId, 'run.completed', {}, { run: { state: 'completed' } });
  return { input, receipt, checkpoint, target, before, after };
}
async function preview(f: Fixture, saved: Awaited<ReturnType<typeof saveCheckpoint>>): Promise<RestorePreview> {
  return command(f.engine, 'review.previewRestore', { runId: saved.receipt.runId, checkpointId: saved.checkpoint.id });
}
const payload = (saved: Awaited<ReturnType<typeof saveCheckpoint>>, fingerprint: string): JsonObject => ({ runId: saved.receipt.runId, checkpointId: saved.checkpoint.id, previewFingerprint: fingerprint });

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => { resolve = finish; });
  return { promise, resolve };
}

test('facade fixture retains the original native database and attempts every Engine close when cleanup and diagnostics fail', async (t) => {
  let cleanup!: () => Promise<void>;
  const diagnosticError = new Error('Authored retention diagnostic failure');
  const owner = {
    after(callback: () => Promise<void>) { cleanup = callback; },
    passed: true,
    diagnostic() { throw diagnosticError; },
  };
  const f = await fixture(owner as unknown as TestContext), first = f.engine;
  const firstClose = first.close.bind(first);
  await f.reopen();
  const second = f.engine, secondClose = second.close.bind(second);
  t.after(async () => { await firstClose(); await secondClose(); });
  const primary = Reflect.get(second.store, 'db') as DatabaseSync;
  const ownership = Reflect.get(second.store, 'ownership') as DatabaseSync;
  assert.equal(primary.isOpen, true); assert.equal(ownership.isOpen, true);
  const originalError = new Error('Authored original Engine close failure');
  let firstAttempts = 0, secondAttempts = 0;
  t.mock.method(first, 'close', async () => { firstAttempts++; await firstClose(); throw originalError; });
  t.mock.method(second, 'close', async () => { secondAttempts++; await secondClose(); });
  // The manifest path and diagnostic callback both fail after real native closure.
  await mkdir(join(f.directory, 'fixture-retention.json'));
  await assert.rejects(cleanup(), error => error === originalError);
  assert.equal(firstAttempts, 1); assert.equal(secondAttempts, 1);
  assert.equal(primary.isOpen, false); assert.equal(ownership.isOpen, false);
  const original = await readFile(f.dbPath);
  const reader = new DatabaseSync(f.dbPath, { readOnly: true });
  assert.equal(reader.isOpen, true);
  try { assert.equal(reader.prepare('PRAGMA user_version').get()!.user_version, 23); }
  finally { reader.close(); }
  assert.equal(reader.isOpen, false);
  assert.deepEqual(await readFile(f.dbPath), original);
  assert.equal(await readFile(join(f.workspaces[0]!.root, 'target.txt'), 'utf8'), 'user preimage\n');
});

test('facade presents real Git files and restores once across simultaneous and durable duplicate requests without rewriting terminal history', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t), saved = await saveCheckpoint(f);
  const snapshot = f.engine.store.getSnapshot(f.sessions[0]!.id), events = f.engine.store.readEvents(f.sessions[0]!.id, 0);
  const files = await command<WorkspaceFilesPresentation>(f.engine, 'file.list', { workspaceId: f.workspaces[0]!.id });
  assert.ok(files.entries.some((file) => file.path === 'target.txt')); assert.ok(!files.entries.some((file) => file.path === '.git'));
  const read = await command<WorkspaceFilePresentation>(f.engine, 'file.read', { workspaceId: f.workspaces[0]!.id, path: 'target.txt' });
  assert.equal(read.content, saved.after); assert.equal(read.sha256, hash(saved.after));
  const status = await command<WorkspaceStatusPresentation>(f.engine, 'workspace.getStatus', { workspaceId: f.workspaces[0]!.id });
  assert.equal(status.dirty, true); assert.ok(status.totalChangedFiles > 0);
  const selected = await preview(f, saved); assert.equal(selected.canRestore, true); assert.equal(selected.atomic, false);
  const request = payload(saved, selected.fingerprint), operationId = randomUUID();
  const first = dispatch(f.engine, 'review.restore', request, operationId);
  const second = dispatch(f.engine, 'review.restore', request, operationId);
  const replies = await Promise.all([first, second]);
  for (const reply of replies) assert.equal(reply.ok, true, JSON.stringify(reply.error));
  const results = replies.map((reply) => reply.result as unknown as RestoreCommandResult);
  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true]);
  assert.deepEqual(results[0]!.restored, ['target.txt']); assert.equal(results[0]!.observations[0]?.currentHash, hash(saved.before));
  assert.equal(await readFile(saved.target, 'utf8'), saved.before); assertExecutionLockAvailable(`${f.dbPath}.effects.sqlite`);
  const history = await command<ReviewHistoryResult>(f.engine, 'review.history', { runId: saved.receipt.runId });
  assert.equal(history.operations.length, 1); assert.equal(history.operations[0]?.id, operationId); assert.equal(history.operations[0]?.state, 'completed');
  assert.deepEqual(f.engine.store.getSnapshot(f.sessions[0]!.id), snapshot); assert.deepEqual(f.engine.store.readEvents(f.sessions[0]!.id, 0), events);
  await writeFile(saved.target, 'external edit after restore\n');
  await f.reopen();
  const duplicate = await command<RestoreCommandResult>(f.engine, 'review.restore', request, operationId);
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.restored, ['target.txt']);
  assert.equal(await readFile(saved.target, 'utf8'), 'external edit after restore\n');
  rejected(await dispatch(f.engine, 'review.restore', { ...request, previewFingerprint: '0'.repeat(64) }, operationId), 'REVIEW_JOURNAL_OPERATION_CONFLICT');
  assert.deepEqual(f.engine.store.getSnapshot(f.sessions[0]!.id), snapshot);
});

test('facade restore requires the specified checkpoint owner and a terminal run while permitting an active readonly preview', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t), saved = await saveCheckpoint(f);
  const other = await command<RunReceipt>(f.engine, 'run.submit', f.input(1) as unknown as JsonObject);
  assert.equal((await f.engine.waitForRun(other.runId)).state, 'completed');
  const wrong = { runId: other.runId, checkpointId: saved.checkpoint.id };
  rejected(await dispatch(f.engine, 'review.previewRestore', wrong), 'CHECKPOINT_RUN_MISMATCH');
  rejected(await dispatch(f.engine, 'review.restore', { ...wrong, previewFingerprint: '0'.repeat(64) }), 'CHECKPOINT_RUN_MISMATCH');
  assert.deepEqual(f.engine.reviewJournal.list(other.runId), []);
  const active = await saveCheckpoint(f, true);
  const selected = await preview(f, active); assert.equal(selected.canRestore, false); assert.ok(selected.activeRunIds.includes(active.receipt.runId));
  rejected(await dispatch(f.engine, 'review.restore', payload(active, selected.fingerprint)), 'RUN_NOT_TERMINAL');
  assert.deepEqual(f.engine.reviewJournal.list(active.receipt.runId), []);
  assert.equal(await readFile(active.target, 'utf8'), active.after); assert.equal(f.engine.store.getRun(active.receipt.runId).state, 'running');
});

test('pending restoration becomes interrupted and remains quarantined on repeated startups while history and known request identity remain readable', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t), saved = await saveCheckpoint(f), selected = await preview(f, saved);
  const snapshot = f.engine.store.getSnapshot(f.sessions[0]!.id), operationId = randomUUID();
  f.engine.reviewJournal.start({ id: operationId, runId: saved.receipt.runId, checkpointId: saved.checkpoint.id, sessionId: f.sessions[0]!.id, workspaceId: f.workspaces[0]!.id, fingerprint: selected.fingerprint });
  for (let restart = 0; restart < 2; restart++) {
    await f.reopen();
    const history = await command<ReviewHistoryResult>(f.engine, 'review.history', { runId: saved.receipt.runId });
    assert.equal(history.operations[0]?.state, 'interrupted'); assert.equal(history.operations[0]?.error?.code, 'RESTORE_INTERRUPTED');
    rejected(await dispatch(f.engine, 'review.restore', payload(saved, selected.fingerprint), operationId), 'RESTORE_INTERRUPTED');
    rejected(await dispatch(f.engine, 'review.restore', payload(saved, selected.fingerprint)), 'CLEANUP_PENDING');
    rejected(await dispatch(f.engine, 'run.submit', f.input() as unknown as JsonObject), 'CLEANUP_PENDING');
    const duplicate = await command<RunReceipt>(f.engine, 'run.submit', saved.input as unknown as JsonObject);
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.runId, saved.receipt.runId);
    rejected(await dispatch(f.engine, 'run.submit', { ...saved.input, prompt: 'Conflicting known request' } as unknown as JsonObject), 'REQUEST_ID_CONFLICT');
    const read = await command<WorkspaceFilePresentation>(f.engine, 'file.read', { workspaceId: f.workspaces[0]!.id, path: 'target.txt' });
    assert.equal(read.content, saved.after); assert.deepEqual(f.engine.store.getSnapshot(f.sessions[0]!.id), snapshot);
    const other = await command<RunReceipt>(f.engine, 'run.submit', f.input(1) as unknown as JsonObject);
    assert.equal((await f.engine.waitForRun(other.runId)).state, 'completed');
    assertExecutionLockAvailable(`${f.dbPath}.effects.sqlite`);
  }
});

test('actual ReviewJournal finish SQLITE_BUSY preserves observed restore results and quarantines metadata failure after effects', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t), saved = await saveCheckpoint(f), selected = await preview(f, saved);
  const snapshot = f.engine.store.getSnapshot(f.sessions[0]!.id), operationId = randomUUID();
  const journal = f.engine.reviewJournal, finish = journal.finish.bind(journal);
  let busyObserved = false;
  const mock = t.mock.method(journal, 'finish', (id: Parameters<typeof finish>[0], outcome: Parameters<typeof finish>[1]) => {
    const blocker = new DatabaseSync(`${f.dbPath}.review.sqlite`, { timeout: 0 });
    try {
      blocker.exec('BEGIN EXCLUSIVE');
      try { return finish(id, outcome); }
      catch (error) {
        assert.ok(error instanceof Error);
        assert.equal(((error as Error & { errcode?: number }).errcode ?? -1) & 0xff, 5, 'The real journal transaction failed with SQLITE_BUSY');
        busyObserved = true; throw error;
      }
    } finally { blocker.exec('ROLLBACK'); blocker.close(); }
  });
  let result: RestoreCommandResult;
  try { result = await command(f.engine, 'review.restore', payload(saved, selected.fingerprint), operationId); }
  finally { mock.mock.restore(); }
  assert.equal(busyObserved, true); assert.equal(result.recordMetadataError?.code, 'REVIEW_RECORD_FAILED');
  assert.deepEqual(result.restored, ['target.txt']); assert.equal(result.observations[0]?.currentHash, hash(saved.before));
  assert.equal(result.effectsUncertain, false); assert.equal(result.executionBlocked, false);
  assert.equal(await readFile(saved.target, 'utf8'), saved.before); assert.equal(inspectExecutionLock(`${f.dbPath}.effects.sqlite`).status, 'available');
  const history = await command<ReviewHistoryResult>(f.engine, 'review.history', { runId: saved.receipt.runId });
  assert.equal(history.operations[0]?.state, 'started');
  rejected(await dispatch(f.engine, 'review.restore', payload(saved, selected.fingerprint), operationId), 'RESTORE_PENDING');
  rejected(await dispatch(f.engine, 'review.restore', payload(saved, selected.fingerprint)), 'CLEANUP_PENDING');
  rejected(await dispatch(f.engine, 'run.submit', f.input() as unknown as JsonObject), 'CLEANUP_PENDING');
  const duplicate = await command<RunReceipt>(f.engine, 'run.submit', saved.input as unknown as JsonObject); assert.equal(duplicate.duplicate, true);
  assert.deepEqual(f.engine.store.getSnapshot(f.sessions[0]!.id), snapshot);
  const other = await command<RunReceipt>(f.engine, 'run.submit', f.input(1) as unknown as JsonObject);
  assert.equal((await f.engine.waitForRun(other.runId)).state, 'completed');
});

test('stale restore previews record a durable failed operation and failed duplicates perform no filesystem reads or effects', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t), saved = await saveCheckpoint(f), selected = await preview(f, saved);
  const snapshot = f.engine.store.getSnapshot(f.sessions[0]!.id), operationId = randomUUID();
  await writeFile(saved.target, 'external edit after preview\n');
  const request = payload(saved, selected.fingerprint);
  rejected(await dispatch(f.engine, 'review.restore', request, operationId), 'RESTORE_PREVIEW_STALE');
  const recorded = f.engine.reviewJournal.get(operationId)!;
  assert.equal(recorded.state, 'failed'); assert.equal(recorded.error?.code, 'RESTORE_PREVIEW_STALE');
  assertExecutionLockAvailable(`${f.dbPath}.effects.sqlite`);
  const original = fs.open;
  const mock = t.mock.method(fs, 'open', (...args: Parameters<typeof fs.open>) => original(...args));
  syncBuiltinESMExports();
  try {
    rejected(await dispatch(f.engine, 'review.restore', request, operationId), 'RESTORE_PREVIEW_STALE');
    assert.equal(mock.mock.callCount(), 0, 'Recorded failed operations are replayed without calling the restore service');
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(f.engine.reviewJournal.get(operationId), recorded);
  assert.equal(await readFile(saved.target, 'utf8'), 'external edit after preview\n');
  assert.deepEqual(f.engine.store.getSnapshot(f.sessions[0]!.id), snapshot);
  const admitted = await command<RunReceipt>(f.engine, 'run.submit', f.input() as unknown as JsonObject);
  assert.equal((await f.engine.waitForRun(admitted.runId)).state, 'completed', 'A safe preview failure does not quarantine');
});

test('a journal operation inserted between dispatch admission and the lease microtask is never executed again', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t), saved = await saveCheckpoint(f), selected = await preview(f, saved), operationId = randomUUID();
  const pending = dispatch(f.engine, 'review.restore', payload(saved, selected.fingerprint), operationId);
  f.engine.reviewJournal.start({ id: operationId, runId: saved.receipt.runId, checkpointId: saved.checkpoint.id,
    sessionId: f.sessions[0]!.id, workspaceId: f.workspaces[0]!.id, fingerprint: selected.fingerprint });
  rejected(await pending, 'RESTORE_PENDING');
  assert.equal(f.engine.reviewJournal.get(operationId)?.state, 'started');
  assert.equal(await readFile(saved.target, 'utf8'), saved.after);
  assertExecutionLockAvailable(`${f.dbPath}.effects.sqlite`);
});

test('facade close reentrance shares one promise and keeps audit/store open through actual restore accounting', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t), saved = await saveCheckpoint(f), selected = await preview(f, saved), operationId = randomUUID();
  const snapshot = f.engine.store.getSnapshot(f.sessions[0]!.id);
  const entered = gate(), release = gate();
  const originalOpen = fs.open, coordinator = f.engine.coordinator;
  const originalLease = coordinator.withWorkspaceLease.bind(coordinator);
  let writtenAndClosed = false, nestedClose: Promise<void> | undefined;
  const leaseMock = t.mock.method(coordinator, 'withWorkspaceLease', <T>(workspaceId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => originalLease(workspaceId, async (signal) => {
    signal.addEventListener('abort', () => { nestedClose = f.engine.close(); }, { once: true });
    return operation(signal);
  }));
  const openMock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === saved.target && typeof args[1] === 'number') {
      if ((args[1] & 3) === constants.O_RDWR) {
        const close = handle.close.bind(handle);
        t.mock.method(handle, 'close', async () => { await close(); writtenAndClosed = true; });
      } else if ((args[1] & 3) === constants.O_RDONLY && writtenAndClosed) {
        entered.resolve(); await release.promise;
      }
    }
    return handle;
  });
  syncBuiltinESMExports();
  const restoring = dispatch(f.engine, 'review.restore', payload(saved, selected.fingerprint), operationId);
  let closing: Promise<void> | undefined, closed = false;
  try {
    await entered.promise;
    assert.equal(f.engine.reviewJournal.get(operationId)?.state, 'started');
    closing = f.engine.close();
    void closing.then(() => { closed = true; });
    assert.strictEqual(nestedClose, closing);
    assert.strictEqual(f.engine.close(), closing);
    await nextTick(); assert.equal(closed, false);
    assert.equal(f.engine.reviewJournal.get(operationId)?.state, 'started', 'The audit connection remains open during accounting');
    assert.deepEqual(f.engine.store.getSnapshot(f.sessions[0]!.id), snapshot);
    release.resolve();
    const reply = await restoring; assert.equal(reply.ok, true, JSON.stringify(reply.error));
    const result = reply.result as unknown as RestoreCommandResult;
    assert.equal(result.cancelled, true); assert.equal(result.recordMetadataError, undefined);
    assert.equal(result.observations[0]?.currentHash, hash(saved.before));
    await closing; assert.equal(closed, true);
  } finally {
    release.resolve(); await restoring; await closing;
    openMock.mock.restore(); leaseMock.mock.restore(); syncBuiltinESMExports();
  }
  await f.reopen();
  const recorded = f.engine.reviewJournal.get(operationId)!;
  assert.equal(recorded.state, 'completed'); assert.equal(recorded.result?.cancelled, true);
  assert.deepEqual(f.engine.store.getSnapshot(f.sessions[0]!.id), snapshot);
  assert.equal(await readFile(saved.target, 'utf8'), saved.before);
});
