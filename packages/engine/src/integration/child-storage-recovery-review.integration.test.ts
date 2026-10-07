import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import { createEngine, type EngineOptions, type MoodcodeEngine } from '../engine.js';
import type { ProviderAdapter } from '../ports.js';
import { CHILD_STORAGE_MIRROR_KIND, childStorageKind, validateChildStorageRecord } from '../child-tasks/storage-binding.js';
import { exportEngineArchive, importEngineArchive } from '../storage/archive.js';

type FailureBoundary = 'root-prepared' | 'mirror-prepared' | 'root-admitted' | 'mirror-admitted';
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function hold(promise: Promise<void>, signal: AbortSignal) {
  let abort!: () => void;
  try { await Promise.race([promise, new Promise<void>(yes => { abort = yes; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]); }
  finally { signal.removeEventListener('abort', abort); }
}
function fileEvidence(directory: string): Record<string, { sha256: string; bytes: number; ino: number; mtimeMs: number; ctimeMs: number }> {
  const evidence: ReturnType<typeof fileEvidence> = {};
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) Object.assign(evidence, fileEvidence(path));
    else { const stat = statSync(path); evidence[path] = { sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), bytes: stat.size, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; }
  }
  return evidence;
}
async function fixture(t: TestContext, failure?: FailureBoundary) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-child-recovery-review-'))), repository = join(directory, 'repo'), artifactDir = join(directory, 'artifacts'), dbPath = join(directory, 'engine.sqlite');
  mkdirSync(repository); execFileSync('git', ['init', '-q', '--template=', repository]); writeFileSync(join(repository, 'fixture.txt'), 'Authored child recovery boundary.\n');
  execFileSync('git', ['-C', repository, 'add', 'fixture.txt']); execFileSync('git', ['-C', repository, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-qm', 'fixture']);
  const parentEntered = gate(), parentRelease = gate(); let childCalls = 0, childConfigurations = 0, injected = false;
  const provider: ProviderAdapter = { id: 'child-recovery-review', async *streamTurn(request, signal) {
    if (request.messages.some(message => message.role === 'user' && message.content === 'AUTHORED_PARENT')) { parentEntered.resolve(); yield { type: 'progress' }; await hold(parentRelease.promise, signal); }
    else { childCalls++; yield { type: 'text.delta', delta: 'Exact closed child observation.' }; }
    yield { type: 'finish', reason: 'stop' };
  } };
  const shouldFail = (side: 'root' | 'mirror', kind: string, data: JsonObject) => failure === `${side}-${(data.binding as JsonObject | undefined)?.phase}` && (side === 'mirror' ? kind === CHILD_STORAGE_MIRROR_KIND : kind.startsWith('child.storage.'));
  const options: EngineOptions = { dbPath, artifactDir, providers: [provider], tools: [], defaults: { providerId: provider.id, modelId: 'fixture', mode: 'plan', limits: { maxTurns: 8, maxToolCalls: 8, maxOutputBytes: 32768, maxDurationMs: 20000, toolTimeoutMs: 3000, maxContextBytes: 262144 } }, configureChild(child) {
    childConfigurations++;
    const put = child.store.putSessionDocument.bind(child.store);
    child.store.putSessionDocument = (sessionId, kind, expectedRevision, data) => { if (shouldFail('mirror', kind, data)) { injected = true; throw new EngineError('AUTHORED_STORAGE_FAILURE', 'Authored mirror storage boundary'); } return put(sessionId, kind, expectedRevision, data); };
  } };
  const engine = createEngine(options), put = engine.store.putSessionDocument.bind(engine.store);
  engine.store.putSessionDocument = (sessionId, kind, expectedRevision, data) => { if (shouldFail('root', kind, data)) { injected = true; throw new EngineError('AUTHORED_STORAGE_FAILURE', 'Authored root storage boundary'); } return put(sessionId, kind, expectedRevision, data); };
  const opened: MoodcodeEngine[] = [engine];
  t.after(async () => { parentRelease.resolve(); try { for (const item of opened.reverse()) await item.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  const createdAt = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt }); engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Recovery owner', createdAt });
  t.mock.method(engine.store, 'getSnapshot', () => { throw new Error('Recovery boundary must not read whole snapshots'); });
  const worktree = await engine.createWorktree('session', 'worktree'), parent = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'parent', prompt: 'AUTHORED_PARENT', config: engine.getCapabilities().defaults }); await parentEntered.promise;
  const request = { sessionId: 'session', parentRunId: parent.runId, requestId: 'child', worktreeId: worktree.id, prompt: 'AUTHORED_CHILD', tools: [], allocation: { turns: 1, toolCalls: 1, outputBytes: 1024, durationMs: 6000 } };
  const finishParent = async () => { parentRelease.resolve(); await engine.waitForRun(parent.runId); await engine.close(); };
  const restart = () => { const next = createEngine(options); opened.push(next); t.mock.method(next.store, 'getSnapshot', () => { throw new Error('Restart must not read whole snapshots'); }); return next; };
  return { directory, artifactDir, dbPath, options, engine, worktree, parent, request, finishParent, restart, counts: () => ({ childCalls, childConfigurations, injected }), childPath: (taskId: string) => join(artifactDir, 'children', taskId) };
}

for (const boundary of ['root-prepared', 'mirror-prepared', 'root-admitted', 'mirror-admitted'] as const) test(`actual ${boundary} failure cancels queued provider before dispatch and exact restart retry is read-only`, { timeout: 20000 }, async t => {
  const f = await fixture(t, boundary), initial = await f.engine.startChildTask(f.request), task = await f.engine.children.tasks.wait('session', initial.id);
  assert.equal(f.counts().injected, true); assert.equal(task.state, 'uncertain', JSON.stringify(task)); assert.equal(f.counts().childCalls, 0); assert.equal(f.engine.children.worktrees.get('session', f.worktree.id).ownerId, task.id);
  const report = await f.engine.getChildDocumentStorageUsage({ sessionId: 'session', sourceRunId: f.parent.runId, taskIds: [task.id] }); assert.equal(report.complete, false); assert.equal(report.stats.openedChildren, 0); assert.equal(report.stats.rawMirrorBytes, 0);
  await f.finishParent(); const before = fileEvidence(f.childPath(task.id)), oldCounts = f.counts();
  const restarted = f.restart(), prepare = DatabaseSync.prototype.prepare; let childQueries = 0;
  const probe = t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) { if (this.location()?.startsWith(f.childPath(task.id) + '/')) childQueries++; return prepare.call(this, sql); });
  try {
    assert.deepEqual(await restarted.startChildTask(f.request), task); assert.deepEqual(await restarted.startChildTask(f.request), task);
    const status = await restarted.getChildDocumentStorageUsage({ sessionId: 'session', sourceRunId: f.parent.runId, taskIds: [task.id] }); assert.equal(status.complete, false); assert.equal(status.stats.openedChildren, 0);
    assert.equal(childQueries, 0); assert.deepEqual(f.counts(), oldCounts); assert.deepEqual(fileEvidence(f.childPath(task.id)), before);
  } finally { probe.mock.restore(); await restarted.close(); }
  const archiveInput = { dbPath: f.dbPath, artifactDir: f.artifactDir, destination: join(f.directory, 'unconfirmed-archive') };
  if (boundary === 'root-prepared') {
    // A missing first binding is explicitly unchecked legacy storage. The
    // archive preserves opaque files without claiming verified child authority.
    const archive = await exportEngineArchive(archiveInput); assert.equal(archive.manifest.documentAudit!.coverage, 'partial'); assert.equal(archive.manifest.documentAudit!.children.length, 0); assert.deepEqual(archive.manifest.documentAudit!.unchecked, [{ taskId: task.id, reason: 'legacy-unbound' }]);
  } else await assert.rejects(exportEngineArchive(archiveInput), error => error instanceof EngineError && error.code === 'ARCHIVE_CHILD_INVALID');
});

test('a confirmed child close cannot promote an uncertain task or emit a result input', { timeout: 20000 }, async t => {
  const f = await fixture(t), put = f.engine.store.putSessionDocument.bind(f.engine.store); let injected = false;
  f.engine.store.putSessionDocument = (sessionId, kind, revision, data) => {
    const tasks = data.tasks as unknown as { state: string }[] | undefined;
    if (kind === 'engine.child_tasks' && tasks?.some(task => task.state === 'completed') && !injected) { injected = true; throw new EngineError('AUTHORED_TASK_COMPLETION_FAILURE', 'Close succeeded before task completion write'); }
    return put(sessionId, kind, revision, data);
  };
  const initial = await f.engine.startChildTask(f.request), task = await f.engine.children.tasks.wait('session', initial.id); assert.equal(injected, true); assert.equal(task.state, 'uncertain'); assert.ok(task.childRunId);
  const proof = validateChildStorageRecord(f.engine.store.getSessionDocument('session', childStorageKind(task.id))!.data); assert.equal(proof.confirmedClose?.method, 'engine-close-resolved');
  const report = await f.engine.getChildDocumentStorageUsage({ sessionId: 'session', sourceRunId: f.parent.runId, taskIds: [task.id] }); assert.equal(report.complete, false); assert.equal(report.children[0]!.authorityStatus, 'unconfirmed'); assert.equal(report.stats.openedChildren, 0);
  await assert.rejects(f.engine.children.tasks.deliver('session', task.id), error => error instanceof EngineError && error.code === 'CHILD_RESULT_UNAVAILABLE'); assert.equal(f.engine.store.pendingInputs('session').length, 0);
  await f.finishParent(); const restarted = f.restart(); assert.deepEqual(await restarted.startChildTask(f.request), task); assert.equal(f.counts().childCalls, 1); await restarted.close();
  await assert.rejects(exportEngineArchive({ dbPath: f.dbPath, artifactDir: f.artifactDir, destination: join(f.directory, 'uncertain-archive') }), error => error instanceof EngineError && error.code === 'ARCHIVE_CHILD_INVALID');
});

test('terminal close with a retained worktree owner permits metadata audit but grants no cleanup or restored authority', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  // Model the durable state immediately after terminal-task commit, before the
  // separate lifecycle-owner release. No source execution proof is invented.
  const release = t.mock.method(f.engine.children.worktrees, 'releaseOwnership', (sessionId: string, worktreeId: string) => f.engine.children.worktrees.get(sessionId, worktreeId));
  const initial = await f.engine.startChildTask(f.request), task = await f.engine.children.tasks.wait('session', initial.id); assert.equal(task.state, 'completed'); release.mock.restore();
  assert.equal(f.engine.children.worktrees.get('session', f.worktree.id).ownerId, task.id);
  const report = await f.engine.getChildDocumentStorageUsage({ sessionId: 'session', sourceRunId: f.parent.runId, taskIds: [task.id] }); assert.equal(report.complete, true); assert.equal(report.coverage.cleanup, 'not-performed'); assert.equal(report.coverage.executionAuthority, 'not-granted'); assert.equal(f.engine.children.worktrees.get('session', f.worktree.id).ownerId, task.id);
  await f.finishParent(); const restarted = f.restart(); assert.deepEqual(await restarted.startChildTask(f.request), task); assert.equal(restarted.children.worktrees.get('session', f.worktree.id).ownerId, task.id);
  await assert.rejects(restarted.cleanupWorktree('session', f.worktree.id), error => error instanceof EngineError && error.code === 'WORKTREE_BUSY'); await restarted.close();
  const archive = await exportEngineArchive({ dbPath: f.dbPath, artifactDir: f.artifactDir, destination: join(f.directory, 'historical-complete') }); assert.equal(archive.manifest.documentAudit!.coverage, 'complete');
  const imported = await importEngineArchive({ directory: archive.directory, destination: join(f.directory, 'imported') }); assert.equal(imported.executionResumed, false); assert.equal(imported.childSessionsPaused, 1);
  const restored = createEngine({ ...f.options, dbPath: imported.dbPath, artifactDir: imported.artifactDir }); try {
    const worktree = restored.children.worktrees.get('session', f.worktree.id); assert.equal(worktree.ownerId, task.id); assert.equal(worktree.relocation?.ownershipVerified, false);
    const status = await restored.getChildDocumentStorageUsage({ sessionId: 'session', sourceRunId: f.parent.runId, taskIds: [task.id] }); assert.equal(status.complete, false); assert.equal(status.stats.openedChildren, 0); assert.equal(f.counts().childCalls, 1);
  } finally { await restored.close(); }
});
