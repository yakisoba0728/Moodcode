import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { EngineError, type ApprovalRecord } from '@moodcode/contracts';
import { createEngine, type MoodcodeEngine } from '../engine.js';
import type { ProviderAdapter } from '../ports.js';
import { SqliteStore } from '../storage/index.js';

function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function code(expected: string) { return (error: unknown) => error instanceof EngineError && error.code === expected; }
async function waitOrAbort(promise: Promise<void>, signal: AbortSignal) {
  let abort!: () => void;
  try { await Promise.race([promise, new Promise<void>(resolve => { abort = resolve; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-bounded-child-'))), repository = join(root, 'repo'), artifacts = join(root, 'artifacts');
  await mkdir(repository); execFileSync('git', ['init', '-q', repository]);
  await writeFile(join(repository, 'file.txt'), 'Bounded fixture observation\n');
  execFileSync('git', ['-C', repository, 'add', 'file.txt']);
  execFileSync('git', ['-C', repository, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture']);
  const parentEntered = gate(), parentRelease = gate(); let childEngine: MoodcodeEngine | undefined, fullReads = 0, childCalls = 0, toolObservation = '';
  const pendingReadRuns: string[] = [], toolReadIds: string[] = [];
  const provider: ProviderAdapter = { id: 'bounded-child-fixture', async *streamTurn(request, signal) {
    const prompt = request.messages.findLast(message => message.role === 'user')?.content;
    if (prompt === 'bounded-parent') {
      parentEntered.resolve(); yield { type: 'progress' }; await waitOrAbort(parentRelease.promise, signal);
      if (!signal.aborted) yield { type: 'finish', reason: 'stop' };
      return;
    }
    assert.equal(prompt, 'bounded-child'); childCalls++;
    assert.deepEqual(request.tools.map(tool => tool.name), ['read_file']);
    if (request.turnIndex === 0) {
      yield { type: 'tool.call', call: { id: 'bounded-local-read', name: 'read_file', input: { path: 'file.txt' } } };
      yield { type: 'finish', reason: 'tool_calls' };
    } else {
      toolObservation = request.messages.findLast(message => message.role === 'tool')?.content ?? '';
      assert.ok(toolObservation.includes('Bounded fixture observation'));
      yield { type: 'text.delta', delta: 'Completed bounded child observation' }; yield { type: 'finish', reason: 'stop' };
    }
  } };
  const engine = createEngine({ dbPath: join(root, 'engine.sqlite'), artifactDir: artifacts, providers: [provider], defaults: { providerId: provider.id, modelId: 'fixture', mode: 'build' },
    toolPolicy: [{ tool: 'read_file', decision: 'ask' }],
    configureChild: child => {
      childEngine = child;
      // Install before workspace/session creation and Run admission. A cached UI
      // snapshot must not hide a later hotpath call to the whole transcript.
      child.store.getSnapshot = () => { fullReads++; throw new Error('Child approval fixture forbids whole-session snapshots'); };
      const pending = child.store.listPendingRunApprovals.bind(child.store), prior = child.store.listToolApprovals.bind(child.store);
      child.store.listPendingRunApprovals = (runId, limit) => { pendingReadRuns.push(runId); return pending(runId, limit); };
      child.store.listToolApprovals = toolCallId => { toolReadIds.push(toolCallId); return prior(toolCallId); };
    },
  });
  t.after(async () => { parentRelease.resolve(); try { await engine.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const opened = await engine.dispatch({ schemaVersion: 1, commandId: 'open', type: 'workspace.open', payload: { path: repository } }); assert.equal(opened.ok, true, JSON.stringify(opened));
  const session = engine.store.createSession({ id: 'root-session', workspaceId: (opened.result as { id: string }).id, title: 'Bounded fixture', createdAt: new Date().toISOString() });
  const worktree = await engine.createWorktree(session.id, 'prepared-child-worktree');
  const parent = engine.scheduler.submitLegacy({ sessionId: session.id, requestId: 'bounded-parent', prompt: 'bounded-parent', config: engine.getCapabilities().defaults }); await parentEntered.promise;
  const task = await engine.startChildTask({ sessionId: session.id, requestId: 'bounded-child', parentRunId: parent.runId, worktreeId: worktree.id, prompt: 'bounded-child', tools: ['read_file'], allocation: { turns: 2, toolCalls: 1, outputBytes: 4096, durationMs: 10000 } });
  let approval: ApprovalRecord | undefined; const deadline = Date.now() + 5000;
  while (!approval) {
    approval = engine.children.approvals(session.id, task.id)[0];
    if (approval) break;
    const current = engine.children.tasks.get(session.id, task.id);
    assert.ok(['starting', 'running'].includes(current.state), `Child terminated before approval: ${current.state}/${current.errorCode}`);
    assert.ok(Date.now() < deadline, 'Actual child approval did not become ready'); await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(childEngine); assert.equal(approval.status, 'pending'); assert.equal(childEngine.store.getRun(approval.runId).state, 'awaiting_approval');
  assert.equal(fullReads, 0); assert.equal(childCalls, 1); assert.equal(toolReadIds.length, 1); assert.deepEqual(new Set(pendingReadRuns), new Set([approval.runId]));
  return { engine, childEngine, root, repository, artifacts, session, worktree, parent, task, approval, parentRelease, pendingReadRuns, reads: () => fullReads, calls: () => childCalls, observation: () => toolObservation };
}

test('actual owned child approval creation, bounded listing and allow finish without a session snapshot', { timeout: 15000 }, async t => {
  const f = await fixture(t), pending = f.engine.children.approvals(f.session.id, f.task.id);
  pending[0]!.preview.fixtureMutation = true;
  assert.equal(f.engine.children.approvals(f.session.id, f.task.id)[0]!.preview.fixtureMutation, undefined);
  assert.throws(() => f.engine.children.decide(f.session.id, f.task.id, f.approval.id, 'changed-fingerprint', 'allow'), code('APPROVAL_FINGERPRINT_MISMATCH'));
  assert.equal(f.engine.children.approvals(f.session.id, f.task.id).length, 1); assert.equal(f.calls(), 1);
  const decided = f.engine.children.decide(f.session.id, f.task.id, f.approval.id, f.approval.fingerprint, 'allow'); assert.equal(decided.status, 'allowed');
  const outcome = await f.engine.children.tasks.wait(f.session.id, f.task.id);
  assert.equal(outcome.state, 'completed'); assert.equal(outcome.outcome?.content, 'Completed bounded child observation'); assert.equal(outcome.outcome?.usage.toolCalls, 1);
  assert.ok(f.observation().includes('Bounded fixture observation')); assert.equal(f.calls(), 2); assert.equal(f.reads(), 0);
  assert.deepEqual(f.engine.children.approvals(f.session.id, f.task.id), []); assert.equal(outcome.deliveryState, 'none');
  assert.equal(f.engine.children.worktrees.get(f.session.id, f.worktree.id).ownerId, undefined);
  assert.equal(await readFile(join(f.repository, 'file.txt'), 'utf8'), 'Bounded fixture observation\n');
  const durable = new SqliteStore(join(f.artifacts, 'children', f.task.id, 'engine.sqlite'));
  try { assert.equal(durable.getApproval(f.approval.id).status, 'allowed'); assert.deepEqual(durable.listPendingRunApprovals(f.approval.runId), []); } finally { durable.close(); }
  f.parentRelease.resolve(); assert.equal((await f.engine.waitForRun(f.parent.runId)).state, 'completed');
});

for (const owner of ['parent', 'child'] as const) test(`actual ${owner} cancellation expires a pending owned child approval without a session snapshot`, { timeout: 15000 }, async t => {
  const f = await fixture(t);
  if (owner === 'parent') { f.engine.coordinator.cancel(f.parent.runId); assert.equal((await f.engine.waitForRun(f.parent.runId)).state, 'cancelled'); }
  else await f.engine.children.tasks.cancel(f.session.id, f.task.id);
  const outcome = await f.engine.children.tasks.wait(f.session.id, f.task.id);
  assert.equal(outcome.state, 'cancelled'); assert.equal(outcome.errorCode, undefined); assert.equal(outcome.outcome?.state, 'cancelled'); assert.equal(outcome.deliveryState, 'none');
  assert.equal(f.calls(), 1); assert.equal(f.reads(), 0); assert.deepEqual(new Set(f.pendingReadRuns), new Set([f.approval.runId]));
  assert.deepEqual(f.engine.children.approvals(f.session.id, f.task.id), []); assert.equal(f.engine.children.worktrees.get(f.session.id, f.worktree.id).ownerId, undefined);
  assert.throws(() => f.engine.children.decide(f.session.id, f.task.id, f.approval.id, f.approval.fingerprint, 'allow'), code('CHILD_OWNER_UNAVAILABLE'));
  const durable = new SqliteStore(join(f.artifacts, 'children', f.task.id, 'engine.sqlite'));
  try { assert.equal(durable.getApproval(f.approval.id).status, 'expired'); assert.equal(durable.getRun(f.approval.runId).state, 'cancelled'); assert.deepEqual(durable.listPendingRunApprovals(f.approval.runId), []); } finally { durable.close(); }
  assert.equal(await readFile(join(f.worktree.root, 'file.txt'), 'utf8'), 'Bounded fixture observation\n');
  if (owner === 'child') { f.parentRelease.resolve(); assert.equal((await f.engine.waitForRun(f.parent.runId)).state, 'completed'); }
});
