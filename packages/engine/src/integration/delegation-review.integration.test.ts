import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { EngineError, type ApprovalRecord, type JsonObject } from '@moodcode/contracts';
import { createEngine, type EngineOptions, type MoodcodeEngine } from '../engine.js';
import type { ProviderAdapter, ToolContext } from '../ports.js';
import type { ChildTaskHost, ChildTaskOptions } from '../child-tasks/index.js';
import { createChildMergeTool } from '../child-tasks/merge.js';
import { inspectExecutionLock } from '../tools/command/execution-lock.js';
import { SqliteStore } from '../storage/index.js';
import { exportEngineArchive, importEngineArchive } from '../storage/archive.js';

// Independently authored behavior fixtures. No account traffic, external provider or automatic merge.
const input = () => ({ requestId: 'review-observation', prompt: 'child-review', tools: ['read_file'], allocation: { turns: 2, toolCalls: 1, outputBytes: 4096, durationMs: 6000 } });
async function until(check: () => boolean, timeout = 8000): Promise<void> { const deadline = Date.now() + timeout; while (!check()) { assert.ok(Date.now() < deadline, 'independent delegation readiness timeout'); await new Promise(resolve => setTimeout(resolve, 5)); } }
const isParent = (messages: { content: string }[]) => messages.some(message => message.content === 'parent-review');
async function fixture(t: TestContext, provider: ProviderAdapter, extra: Partial<EngineOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-delegation-review-'))), repository = join(root, 'source'), dbPath = join(root, 'engine.sqlite'), artifactDir = join(root, 'artifacts');
  await mkdir(repository); execFileSync('git', ['init', '-q', repository]); await writeFile(join(repository, 'observed.txt'), 'pinned committed observation\n');
  execFileSync('git', ['-C', repository, 'add', 'observed.txt']); execFileSync('git', ['-C', repository, '-c', 'user.name=Independent fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'independent fixture']);
  const options: EngineOptions = { ...extra, dbPath, artifactDir, providers: [provider], defaults: { providerId: provider.id, modelId: 'review-fixture', mode: 'build' } };
  const engine = createEngine(options), lockPath = dbPath + '.effects.sqlite';
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const opened = await engine.dispatch({ schemaVersion: 1, commandId: 'open-source', type: 'workspace.open', payload: { path: repository } }); assert.equal(opened.ok, true);
  const workspace = engine.store.getWorkspace((opened.result as JsonObject).id as string);
  const created = await engine.dispatch({ schemaVersion: 1, commandId: 'create-session', type: 'session.create', payload: { workspaceId: workspace.id } }); assert.equal(created.ok, true);
  const sessionId = (created.result as JsonObject).id as string;
  const submit = async (config: JsonObject = {}) => {
    const receipt = await engine.dispatch({ schemaVersion: 1, commandId: 'submit-parent', type: 'run.submit', payload: { sessionId, requestId: 'parent-review', prompt: 'parent-review', config } });
    assert.equal(receipt.ok, true, receipt.error?.message ?? 'Parent submission failed'); return (receipt.result as JsonObject).runId as string;
  };
  const approval = async () => { await until(() => engine.store.getSnapshot(sessionId).approvals.some(value => value.status === 'pending')); return engine.store.getSnapshot(sessionId).approvals.find(value => value.status === 'pending')!; };
  const allow = async (value: ApprovalRecord) => { const reply = await engine.dispatch({ schemaVersion: 1, commandId: 'allow-' + value.id, type: 'approval.decide', payload: { approvalId: value.id, fingerprint: value.fingerprint, decision: 'allow' } }); assert.equal(reply.ok, true, reply.error?.message ?? 'Approval delivery failed'); };
  return { root, repository, dbPath, artifactDir, options, engine, lockPath, workspace, sessionId, submit, approval, allow };
}
function normalProvider(counter: { children: number }, value = input()): ProviderAdapter {
  return { id: 'independent-fixture', async *streamTurn(request) {
    if (isParent(request.messages) && request.turnIndex === 0) { yield { type: 'tool.call', call: { id: 'delegation-review', name: 'delegate_task', input: value } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { if (!isParent(request.messages)) counter.children++; yield { type: 'text.delta', delta: 'Observed child data.' }; yield { type: 'finish', reason: 'stop' }; }
  } };
}

test('default 21st tool stays exact-approved despite configured allowance and remembered broad grant', async t => {
  const counts = { children: 0 }, f = await fixture(t, normalProvider(counts), { toolPolicy: [{ tool: 'delegate_task', decision: 'allow' }] });
  assert.equal(f.engine.getCapabilities().tools.length, 21); assert.ok(f.engine.getCapabilities().tools.some(tool => tool.name === 'delegate_task'));
  assert.ok(!f.engine.toolRuntime.catalogue('engine', 'plan').tools.some(tool => tool.name === 'delegate_task'));
  const scope = { workspaceId: f.workspace.id, sessionId: f.sessionId, toolName: 'delegate_task', effect: 'write' as const };
  f.engine.toolRuntime.grants.issue({ ...scope, policyVersion: f.engine.toolRuntime.policy.version, ttlMs: 60000, maxUses: 10 });
  const runId = await f.submit(), pending = await f.approval();
  assert.equal(pending.preview.scopedGrantId, undefined); assert.deepEqual(f.engine.children.tasks.list(f.sessionId), []); assert.deepEqual(f.engine.children.worktrees.list(f.sessionId), []); assert.equal(counts.children, 0);
  f.engine.coordinator.cancel(runId); assert.equal((await f.engine.waitForRun(runId)).state, 'cancelled');
  assert.equal(f.engine.store.getApproval(pending.id).status, 'expired'); assert.ok(['available', 'not_initialized'].includes(inspectExecutionLock(f.lockPath).status));
  assert.equal(f.engine.toolRuntime.grants.find(scope, f.engine.toolRuntime.policy.version)!.remainingUses, 10);
});

test('Plan mode and parent profile restrictions reject model delegation before approval or Git effects', async t => {
  const counts = { children: 0 }, plan = await fixture(t, normalProvider(counts)); const planRun = await plan.submit({ mode: 'plan' });
  await plan.engine.waitForRun(planRun); assert.equal(plan.engine.store.getSnapshot(plan.sessionId).approvals.length, 0); assert.deepEqual(plan.engine.children.worktrees.list(plan.sessionId), []);
  const profile = await fixture(t, normalProvider(counts), { agentProfiles: [{ id: 'restricted', description: 'Read list only', instructions: 'Observe only listed files.', tools: ['delegate_task', 'list_files'] }] });
  const runId = await profile.submit({ agentProfileId: 'restricted' }); await profile.engine.waitForRun(runId);
  const result = profile.engine.store.getSnapshot(profile.sessionId).tools[0]!; assert.ok(result.output?.includes('DELEGATION_TOOL_ESCALATION'));
  assert.deepEqual(profile.engine.children.worktrees.list(profile.sessionId), []); assert.equal(profile.engine.store.getSnapshot(profile.sessionId).approvals.length, 0); assert.equal(counts.children, 0);
});

test('approval waiting time consumes current parent deadline and a stale allocation never creates a checkout', async t => {
  const counts = { children: 0 }, value = input(); value.allocation.durationMs = 1500;
  const f = await fixture(t, normalProvider(counts, value)), runId = await f.submit({ limits: { maxDurationMs: 3000, toolTimeoutMs: 2500 } }), pending = await f.approval();
  await until(() => f.engine.coordinator.getRemainingChildBudget(runId).durationMs < 1400, 3500); await f.allow(pending);
  await f.engine.waitForRun(runId); assert.ok(f.engine.store.getSnapshot(f.sessionId).tools[0]!.output?.includes('DELEGATION_BUDGET_EXCEEDED'));
  assert.equal(counts.children, 0); assert.deepEqual(f.engine.children.worktrees.list(f.sessionId), []); assert.ok(['available', 'not_initialized'].includes(inspectExecutionLock(f.lockPath).status));
});

test('child resource approvals inherit policy and parent cancellation cancels the pending child approval', async t => {
  let childEngine: MoodcodeEngine | undefined;
  const provider: ProviderAdapter = { id: 'independent-fixture', async *streamTurn(request) {
    if (isParent(request.messages)) { yield { type: 'tool.call', call: { id: 'delegate-read', name: 'delegate_task', input: input() } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { assert.deepEqual(request.tools.map(tool => tool.name), ['read_file']); yield { type: 'tool.call', call: { id: 'child-read', name: 'read_file', input: { path: 'observed.txt' } } }; yield { type: 'finish', reason: 'tool_calls' }; }
  } };
  const f = await fixture(t, provider, { toolPolicy: [{ tool: 'read_file', decision: 'ask' }], configureChild: engine => { childEngine = engine; } });
  const runId = await f.submit(); await f.allow(await f.approval());
  await until(() => { const task = f.engine.children.tasks.list(f.sessionId)[0]; return !!task && f.engine.children.approvals(f.sessionId, task.id).length === 1; });
  const task = f.engine.children.tasks.list(f.sessionId)[0]!, pending = f.engine.children.approvals(f.sessionId, task.id)[0]!;
  assert.equal(childEngine!.toolRuntime.policy, f.engine.toolRuntime.policy); assert.equal(pending.toolName, 'read_file');
  f.engine.coordinator.cancel(runId); const cancelled = await f.engine.children.tasks.wait(f.sessionId, task.id); await f.engine.waitForRun(runId);
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.deliveryState, 'none'); assert.equal(f.engine.children.worktrees.get(f.sessionId, task.worktreeId).ownerId, undefined);
  const documents = new SqliteStore(join(f.artifactDir, 'children', task.id, 'engine.sqlite'));
  try { assert.equal(documents.getApproval(pending.id).status, 'expired'); } finally { documents.close(); }
  assert.equal(f.engine.store.listInputs(f.sessionId).inputs.length, 1); assert.equal(await readFile(join(f.repository, 'observed.txt'), 'utf8'), 'pinned committed observation\n');
});

test('child deadline interrupts a cooperative real stream and releases ownership without delivery', async t => {
  let entered = false, aborted = false; const value = input(); value.allocation.durationMs = 150;
  const provider: ProviderAdapter = { id: 'independent-fixture', async *streamTurn(request, signal) {
    if (isParent(request.messages) && request.turnIndex === 0) { yield { type: 'tool.call', call: { id: 'delegate-timeout', name: 'delegate_task', input: value } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else if (isParent(request.messages)) yield { type: 'finish', reason: 'stop' };
    else { entered = true; yield { type: 'progress' }; if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); else aborted = true; }
  } };
  const f = await fixture(t, provider), runId = await f.submit(); await f.allow(await f.approval()); await f.engine.waitForRun(runId);
  const task = f.engine.children.tasks.list(f.sessionId)[0]!; assert.equal(entered, true); assert.equal(aborted, true); assert.equal(task.state, 'cancelled'); assert.equal(task.deliveryState, 'none');
  assert.equal(f.engine.children.worktrees.get(f.sessionId, task.worktreeId).ownerId, undefined); assert.equal(inspectExecutionLock(f.lockPath).status, 'available');
});

test('asynchronous child-start rejection retains uncertain ownership and never auto-retries or delivers', async t => {
  const counts = { children: 0 }, f = await fixture(t, normalProvider(counts));
  const options = (f.engine.children.tasks as unknown as { options: ChildTaskOptions }).options, host: ChildTaskHost = options.host, original = host.start;
  let calls = 0; host.start = async () => { calls++; await Promise.resolve(); throw new EngineError('INDEPENDENT_START_FAILURE', 'Synthetic start failure'); }; t.after(() => { host.start = original; });
  const runId = await f.submit(); await f.allow(await f.approval()); const run = await f.engine.waitForRun(runId), task = f.engine.children.tasks.list(f.sessionId)[0]!;
  assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(task.state, 'uncertain'); assert.equal(task.deliveryState, 'none'); assert.equal(calls, 1); assert.equal(counts.children, 0);
  const worktree = f.engine.children.worktrees.get(f.sessionId, task.worktreeId); assert.equal(worktree.ownerId, task.id);
  await assert.rejects(f.engine.children.worktrees.cleanup(f.sessionId, worktree.id, new AbortController().signal), { code: 'WORKTREE_BUSY' });
  f.engine.children.recover(f.sessionId); assert.equal(calls, 1); assert.equal(f.engine.store.listInputs(f.sessionId).inputs.length, 1);
});
test('async and thenable configureChild hooks fail before model admission and observe their rejection', async t => {
  for (const kind of ['promise', 'thenable']) {
    const counts = { children: 0 }, f = await fixture(t, normalProvider(counts), { configureChild: () => kind === 'promise'
      ? Promise.reject(new Error('Synthetic rejected setup'))
      : { then(_resolve: unknown, reject: (error: Error) => void) { reject(new Error('Synthetic rejected thenable setup')); } } });
    const runId = await f.submit(); await f.allow(await f.approval()); const run = await f.engine.waitForRun(runId), task = f.engine.children.tasks.list(f.sessionId)[0]!;
    assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(task.state, 'uncertain'); assert.equal(task.errorCode, 'INVALID_CHILD_CONFIGURATION'); assert.equal(counts.children, 0);
    assert.equal(task.childRunId, undefined); assert.equal(f.engine.children.worktrees.get(f.sessionId, task.worktreeId).ownerId, task.id); assert.equal(task.deliveryState, 'none');
  }
});

test('late child read-handler registration cannot expand the approved tool allowlist', async t => {
  let executed = false, child: MoodcodeEngine | undefined;
  const provider: ProviderAdapter = { id: 'independent-fixture', async *streamTurn(request) {
    if (isParent(request.messages) && request.turnIndex === 0) { yield { type: 'tool.call', call: { id: 'delegate-allowlist', name: 'delegate_task', input: input() } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { if (!isParent(request.messages)) assert.deepEqual(request.tools.map(tool => tool.name), ['read_file']); yield { type: 'finish', reason: 'stop' }; }
  } };
  const f = await fixture(t, provider, { configureChild: engine => { child = engine; engine.toolRuntime.register('engine', { name: 'independent_extra_read', effectClass: 'read', description: 'Independent fixture', inputSchema: { type: 'object' }, async prepare() { executed = true; throw new Error('Unexpected handler'); }, async execute() { executed = true; throw new Error('Unexpected handler'); } }); } });
  const runId = await f.submit(); await f.allow(await f.approval()); await f.engine.waitForRun(runId);
  assert.ok(!child!.getCapabilities().tools.some(tool => tool.name === 'independent_extra_read')); assert.equal(executed, false);
});

test('known post-Git failure preserves the created files but releases only its confirmed effect marker', async t => {
  const counts = { children: 0 }, f = await fixture(t, normalProvider(counts)), manager = f.engine.children.worktrees, create = manager.create.bind(manager);
  manager.create = async (...args) => { await create(...args); throw new EngineError('INDEPENDENT_POST_GIT_FAILURE', 'Synthetic failure after confirmed Git completion'); }; t.after(() => { manager.create = create; });
  const runId = await f.submit(); await f.allow(await f.approval()); await f.engine.waitForRun(runId);
  const tree = manager.list(f.sessionId)[0]!; assert.equal(tree.state, 'ready'); assert.equal(tree.ownerId, undefined); assert.equal(await readFile(join(tree.root, 'observed.txt'), 'utf8'), 'pinned committed observation\n');
  assert.equal(inspectExecutionLock(f.lockPath).status, 'available'); assert.equal(counts.children, 0); assert.deepEqual(f.engine.children.tasks.list(f.sessionId), []);
});

test('restart and archive import join the exact durable child without another dispatch, reservation or queued result', async t => {
  const counts = { children: 0 }, f = await fixture(t, normalProvider(counts)), runId = await f.submit(); await f.allow(await f.approval()); await f.engine.waitForRun(runId);
  const task = f.engine.children.tasks.list(f.sessionId)[0]!, request = { sessionId: f.sessionId, requestId: task.requestId, parentRunId: runId, worktreeId: task.worktreeId, prompt: 'child-review', tools: ['read_file'], allocation: input().allocation };
  const originalTree = f.engine.children.worktrees.get(f.sessionId, task.worktreeId);
  assert.equal(counts.children, 1); await f.engine.close();
  const restarted = createEngine(f.options);
  try { const joined = await restarted.startChildTask(request); assert.equal(joined.id, task.id); assert.equal(joined.state, 'completed'); assert.equal(joined.deliveryState, 'none');
    await assert.rejects(restarted.startChildTask({ ...request, prompt: 'Changed request' }), { code: 'CHILD_REQUEST_CONFLICT' }); assert.equal(counts.children, 1);
  } finally { await restarted.close(); }
  const archive = await exportEngineArchive({ dbPath: f.dbPath, artifactDir: f.artifactDir, destination: join(f.root, 'archive') });
  const imported = await importEngineArchive({ directory: archive.directory, destination: join(f.root, 'restored') });
  const restored = createEngine({ ...f.options, dbPath: imported.dbPath, artifactDir: imported.artifactDir });
  try { const joined = await restored.startChildTask(request); assert.equal(joined.id, task.id); assert.equal(joined.state, 'completed'); assert.equal(counts.children, 1);
    assert.equal(restored.children.tasks.list(f.sessionId).length, 1); assert.equal(restored.store.listInputs(f.sessionId).inputs.length, 1); assert.equal(joined.deliveryState, 'none');
    await access(join(imported.artifactDir, 'children', 'worktrees', task.worktreeId, 'observed.txt'));
    const relocated = restored.children.worktrees.get(f.sessionId, task.worktreeId);
    assert.equal(relocated.state, 'uncertain'); assert.equal(relocated.errorCode, 'WORKTREE_ARCHIVE_RELOCATION');
    assert.equal(relocated.root, join(imported.artifactDir, 'children', 'worktrees', task.worktreeId));
    assert.equal(relocated.ownerId, originalTree.ownerId); assert.equal(relocated.device, originalTree.device); assert.equal(relocated.inode, originalTree.inode);
    const signal = new AbortController().signal;
    await assert.rejects(restored.children.worktrees.verify(relocated, signal), { code: 'WORKTREE_RELOCATION_UNVERIFIED' });
    await assert.rejects(restored.children.worktrees.cleanup(f.sessionId, relocated.id, signal), { code: 'WORKTREE_RELOCATION_UNVERIFIED' });
    const mergeContext: ToolContext = { sessionId: f.sessionId, runId, toolCallId: 'independent-preview', workspace: f.workspace, signal, limits: restored.store.getRun(runId).config.limits, artifactDir: imported.artifactDir, recordCheckpoint() { assert.fail('Relocated preview cannot record a file checkpoint'); } };
    await assert.rejects(createChildMergeTool(restored.children.tasks, restored.children.worktrees).prepare({ childTaskId: task.id }, mergeContext), { code: 'WORKTREE_RELOCATION_UNVERIFIED' });
    assert.equal(await readFile(join(relocated.root, 'observed.txt'), 'utf8'), 'pinned committed observation\n');
    // A fresh Run/request must get a fresh verified checkout instead of adopting relocated ownership.
    const receipt = await restored.dispatch({ schemaVersion: 1, commandId: 'fresh-parent', type: 'run.submit', payload: { sessionId: f.sessionId, requestId: 'fresh-parent', prompt: 'parent-review' } });
    assert.equal(receipt.ok, true, receipt.error?.message ?? 'Restored fresh submission failed'); const freshRunId = (receipt.result as JsonObject).runId as string;
    await until(() => restored.store.getSnapshot(f.sessionId).approvals.some(value => value.status === 'pending'));
    const pending = restored.store.getSnapshot(f.sessionId).approvals.find(value => value.status === 'pending')!;
    const budgetBefore = restored.coordinator.getRemainingChildBudget(freshRunId);
    await assert.rejects(restored.startChildTask({ ...request, requestId: 'reject-relocated-worktree', parentRunId: freshRunId }), { code: 'CHILD_WORKTREE_NOT_READY' });
    const budgetAfter = restored.coordinator.getRemainingChildBudget(freshRunId);
    assert.equal(budgetAfter.turns, budgetBefore.turns); assert.equal(budgetAfter.toolCalls, budgetBefore.toolCalls); assert.equal(budgetAfter.outputBytes, budgetBefore.outputBytes);
    restored.approvals.decide(pending.id, 'allow', pending.fingerprint); assert.equal((await restored.waitForRun(freshRunId)).state, 'completed');
    assert.equal(counts.children, 2); assert.equal(restored.children.tasks.list(f.sessionId).length, 2);
    assert.equal(restored.children.worktrees.get(f.sessionId, task.worktreeId).state, 'uncertain');
  } finally { await restored.close(); }
});
