import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { DEFAULT_LIMITS, EngineError, type ApprovalRecord, type JsonObject, type ReviewDiff, type RunReceipt, type Session, type Workspace } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ChildTaskRecord } from '../child-tasks/index.js';
import type { ProviderAdapter, ProviderEvent } from '../ports.js';

const exec = promisify(execFile);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const original = 'before\n';
const changed = 'approved child change\n';
type Engine = ReturnType<typeof createEngine>;
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function hold(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  let abort!: () => void;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]); }
  finally { signal.removeEventListener('abort', abort); }
}
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < end, 'child merge condition must progress'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function command<T>(engine: Engine, type: string, payload: JsonObject): Promise<T> {
  const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload });
  assert.equal(result.ok, true, `${type}: ${JSON.stringify(result.error)}`); return result.result as unknown as T;
}
async function fixture(t: TestContext, provider: ProviderAdapter) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-child-merge-'))), root = join(temporary, 'repository');
  await mkdir(root); await exec('git', ['init', '--quiet', '--template=', root]); await writeFile(join(root, 'file.txt'), original);
  await exec('git', ['-C', root, 'add', 'file.txt']);
  await exec('git', ['-C', root, '-c', 'user.name=Moodcode Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '--quiet', '-m', 'Child merge fixture']);
  const engine = createEngine({ dbPath: join(temporary, 'engine.sqlite'), artifactDir: join(temporary, 'artifacts'), worktreeDirectory: join(temporary, 'managed'), providers: [provider],
    defaults: { providerId: provider.id, modelId: 'fixture', mode: 'build', limits: { ...DEFAULT_LIMITS, maxTurns: 16, maxToolCalls: 16, maxOutputBytes: 262144, maxDurationMs: 20000 } } });
  t.after(async () => { await engine.close(); await rm(temporary, { recursive: true, force: true }); });
  const workspace = await command<Workspace>(engine, 'workspace.open', { path: root });
  const session = await command<Session>(engine, 'session.create', { workspaceId: workspace.id });
  return { engine, root, workspace, session };
}
async function childApproval(engine: Engine, sessionId: string, child: ChildTaskRecord): Promise<ApprovalRecord> {
  await until(() => engine.children.approvals(sessionId, child.id).length > 0);
  const approval = engine.children.approvals(sessionId, child.id)[0]!;
  assert.equal(approval.runId, engine.children.tasks.get(sessionId, child.id).childRunId); assert.notEqual(approval.sessionId, sessionId); assert.equal(approval.status, 'pending'); return approval;
}
function decideChild(engine: Engine, sessionId: string, child: ChildTaskRecord, approval: ApprovalRecord): void {
  assert.throws(() => engine.children.decide(sessionId, child.id, approval.id, 'incorrect-fingerprint', 'allow'), error => error instanceof EngineError && error.code === 'APPROVAL_FINGERPRINT_MISMATCH');
  assert.equal(engine.children.approvals(sessionId, child.id)[0]!.status, 'pending');
  assert.equal(engine.children.decide(sessionId, child.id, approval.id, approval.fingerprint, 'allow').status, 'allowed');
}

test('actual child effects remain isolated until approved direct or nested model merge creates parent review evidence', { timeout: 30000 }, async t => {
  for (const nested of [false, true]) await t.test(nested ? 'grandchild to child to root' : 'child to root', async inner => {
    const parentEntered = gate(), parentRelease = gate(), childEntered = gate(), childRelease = gate();
    let childId: string | undefined, grandchildId: string | undefined;
    const calls = { parent: 0, child: 0, grandchild: 0 };
    const provider: ProviderAdapter = { id: 'child-merge-fixture', async *streamTurn(request, signal): AsyncGenerator<ProviderEvent> {
      const prompt = request.messages.findLast(message => message.role === 'user')!.content;
      const role = prompt === 'root-parent' ? 'parent' : prompt === 'isolated-child' ? 'child' : 'grandchild'; calls[role]++;
      if (request.turnIndex === 0) {
        if (role === 'parent') { parentEntered.resolve(); yield { type: 'progress' }; await hold(parentRelease.promise, signal); assert.ok(childId); yield { type: 'tool.call', call: { id: 'root-merge-proposal', name: 'merge_child_changes', input: { childTaskId: childId } } }; }
        else if (role === 'child' && nested) { childEntered.resolve(); yield { type: 'progress' }; await hold(childRelease.promise, signal); assert.ok(grandchildId); yield { type: 'tool.call', call: { id: 'nested-merge-proposal', name: 'merge_child_changes', input: { childTaskId: grandchildId } } }; }
        else { assert.ok(request.tools.some(tool => tool.name === 'apply_patch')); yield { type: 'tool.call', call: { id: 'child-patch-proposal', name: 'apply_patch', input: { changes: [{ path: 'file.txt', expectedHash: hash(original), content: changed }] } } }; }
        yield { type: 'finish', reason: 'tool_calls' };
      } else { assert.ok(request.messages.some(message => message.role === 'tool')); yield { type: 'text.delta', delta: `${role} effect complete` }; yield { type: 'finish', reason: 'stop' }; }
    } };
    const f = await fixture(inner, provider);
    inner.after(parentRelease.resolve); inner.after(childRelease.resolve);
    const worktree = await f.engine.createWorktree(f.session.id, 'child-prepare');
    const grandchildWorktree = nested ? await f.engine.prepareChildWorktree(f.session.id, worktree.id, 'grandchild-prepare') : undefined;
    assert.equal(worktree.baseRoot, f.root);
    if (grandchildWorktree) { assert.equal(grandchildWorktree.baseRoot, worktree.root); assert.notEqual(grandchildWorktree.workspaceId, f.workspace.id); }
    const rootHead = (await exec('git', ['-C', f.root, 'rev-parse', 'HEAD'])).stdout.trim();
    const receipt = await command<RunReceipt>(f.engine, 'run.submit', { sessionId: f.session.id, requestId: 'root-parent', prompt: 'root-parent' });
    await parentEntered.promise;
    const beforeBudget = f.engine.coordinator.getRemainingChildBudget(receipt.runId);
    const allocation = { turns: nested ? 6 : 2, toolCalls: nested ? 4 : 1, outputBytes: nested ? 32768 : 8192, durationMs: 10000 };
    let child = await f.engine.startChildTask({ sessionId: f.session.id, requestId: 'isolated-child', parentRunId: receipt.runId, worktreeId: worktree.id, prompt: 'isolated-child', tools: nested ? ['apply_patch', 'merge_child_changes'] : ['apply_patch'], allocation });
    childId = child.id;
    await until(() => { const task = f.engine.children.tasks.get(f.session.id, child.id); return Boolean(task.childRunId) || ['failed', 'cancelled', 'uncertain'].includes(task.state); });
    child = f.engine.children.tasks.get(f.session.id, child.id);
    assert.equal(child.parentRunId, receipt.runId); assert.ok(child.childRunId, JSON.stringify(child)); assert.equal(child.depth, 1);
    const rootAfterReservation = f.engine.coordinator.getRemainingChildBudget(receipt.runId);
    assert.equal(rootAfterReservation.turns, beforeBudget.turns - allocation.turns); assert.equal(rootAfterReservation.toolCalls, beforeBudget.toolCalls - allocation.toolCalls); assert.equal(rootAfterReservation.outputBytes, beforeBudget.outputBytes - allocation.outputBytes);
    assert.equal(await readFile(join(f.root, 'file.txt'), 'utf8'), original);
    if (grandchildWorktree) {
      await childEntered.promise;
      const childBefore = f.engine.children.remainingBudget(f.session.id, child.id);
      const grandAllocation = { turns: 2, toolCalls: 1, outputBytes: 8192, durationMs: 5000 };
      const grandchild = await f.engine.startChildTask({ sessionId: f.session.id, requestId: 'isolated-grandchild', parentTaskId: child.id, parentRunId: child.childRunId!, worktreeId: grandchildWorktree.id, prompt: 'isolated-grandchild', tools: ['apply_patch'], allocation: grandAllocation });
      grandchildId = grandchild.id; assert.equal(grandchild.depth, 2); assert.equal(grandchild.rootRunId, receipt.runId); assert.equal(grandchild.parentRunId, child.childRunId);
      const childAfter = f.engine.children.remainingBudget(f.session.id, child.id);
      assert.equal(childAfter.turns, childBefore.turns - grandAllocation.turns); assert.equal(childAfter.toolCalls, childBefore.toolCalls - grandAllocation.toolCalls); assert.equal(childAfter.outputBytes, childBefore.outputBytes - grandAllocation.outputBytes);
      assert.equal(f.engine.coordinator.getRemainingChildBudget(receipt.runId).turns, rootAfterReservation.turns); assert.equal(f.engine.coordinator.getRemainingChildBudget(receipt.runId).toolCalls, rootAfterReservation.toolCalls); assert.equal(f.engine.coordinator.getRemainingChildBudget(receipt.runId).outputBytes, rootAfterReservation.outputBytes);
      const approval = await childApproval(f.engine, f.session.id, grandchild); assert.equal(approval.toolName, 'apply_patch');
      assert.equal(await readFile(join(grandchildWorktree.root, 'file.txt'), 'utf8'), original); decideChild(f.engine, f.session.id, grandchild, approval);
      const outcome = await f.engine.children.tasks.wait(f.session.id, grandchild.id); assert.equal(outcome.state, 'completed'); assert.equal(outcome.outcome!.usage.toolCalls, 1); assert.equal(outcome.outcome!.usage.turns, 2);
      assert.equal(await readFile(join(grandchildWorktree.root, 'file.txt'), 'utf8'), changed); assert.equal(await readFile(join(worktree.root, 'file.txt'), 'utf8'), original); assert.equal(await readFile(join(f.root, 'file.txt'), 'utf8'), original);
      childRelease.resolve();
      const merge = await childApproval(f.engine, f.session.id, child); assert.equal(merge.toolName, 'merge_child_changes'); assert.equal(merge.preview.childTaskId, grandchild.id); assert.equal(merge.preview.worktreeId, grandchildWorktree.id);
      assert.equal(await readFile(join(worktree.root, 'file.txt'), 'utf8'), original); decideChild(f.engine, f.session.id, child, merge);
    } else {
      const approval = await childApproval(f.engine, f.session.id, child); assert.equal(approval.toolName, 'apply_patch');
      assert.equal(await readFile(join(worktree.root, 'file.txt'), 'utf8'), original); decideChild(f.engine, f.session.id, child, approval);
    }
    const outcome = await f.engine.children.tasks.wait(f.session.id, child.id); assert.equal(outcome.state, 'completed'); assert.equal(outcome.outcome!.usage.turns, 2); assert.equal(outcome.outcome!.usage.toolCalls, 1); assert.ok(outcome.outcome!.usage.outputBytes > 0);
    assert.equal(f.engine.children.worktrees.get(f.session.id, worktree.id).ownerId, undefined);
    assert.equal(await readFile(join(worktree.root, 'file.txt'), 'utf8'), changed); assert.equal(await readFile(join(f.root, 'file.txt'), 'utf8'), original); assert.equal(f.engine.store.listCheckpoints(receipt.runId).length, 0);
    parentRelease.resolve();
    await until(() => f.engine.store.getSnapshot(f.session.id).approvals.some(approval => approval.status === 'pending'));
    const merge = f.engine.store.getSnapshot(f.session.id).approvals.find(approval => approval.status === 'pending')!;
    assert.equal(merge.toolName, 'merge_child_changes'); assert.equal(merge.preview.childTaskId, child.id); assert.equal(merge.preview.worktreeId, worktree.id); assert.equal(merge.preview.integration, 'approved_full_content_patch');
    assert.equal(await readFile(join(f.root, 'file.txt'), 'utf8'), original);
    const rejected = await f.engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type: 'approval.decide', payload: { approvalId: merge.id, fingerprint: 'incorrect-fingerprint', decision: 'allow' } });
    assert.equal(rejected.ok, false); assert.equal(rejected.error!.code, 'APPROVAL_FINGERPRINT_MISMATCH'); assert.equal(await readFile(join(f.root, 'file.txt'), 'utf8'), original);
    await command(f.engine, 'approval.decide', { approvalId: merge.id, fingerprint: merge.fingerprint, decision: 'allow' });
    assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed'); assert.equal(await readFile(join(f.root, 'file.txt'), 'utf8'), changed);
    const checkpoints = f.engine.store.listCheckpoints(receipt.runId); assert.equal(checkpoints.length, 1); assert.equal(checkpoints[0]!.files.length, 1);
    assert.equal(checkpoints[0]!.files[0]!.beforeHash, hash(original)); assert.equal(checkpoints[0]!.files[0]!.afterHash, hash(changed)); assert.equal(checkpoints[0]!.files[0]!.before, original); assert.equal(checkpoints[0]!.files[0]!.after, changed);
    const review = await command<ReviewDiff>(f.engine, 'review.getDiff', { runId: receipt.runId }); assert.equal(review.checkpoints[0]!.id, checkpoints[0]!.id); assert.deepEqual(review.files, [{ path: 'file.txt', before: original, after: changed, beforeHash: hash(original), afterHash: hash(changed) }]);
    assert.equal((await exec('git', ['-C', f.root, 'rev-parse', 'HEAD'])).stdout.trim(), rootHead);
    const usage = f.engine.coordinator.getRunUsage(receipt.runId); assert.equal(usage.toolCalls, 1); assert.equal(usage.turns, 2); assert.ok(usage.outputBytes > 0);
    assert.equal(checkpoints[0]!.toolCallId, f.engine.store.getSnapshot(f.session.id).tools[0]!.id);
    assert.deepEqual(calls, { parent: 2, child: 2, grandchild: nested ? 2 : 0 });
  });
});
