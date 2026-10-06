import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EngineError, type ApprovalRecord, type JsonObject } from '@moodcode/contracts';
import { createEngine, type EngineOptions } from '../engine.js';
import type { ProviderAdapter, ToolContext } from '../ports.js';
import { createDelegateTaskTool } from '../child-tasks/delegation.js';
import { acquireExecutionLock, inspectExecutionLock } from '../tools/command/execution-lock.js';

const request = { requestId: 'observe', prompt: 'child', tools: ['read_file'], allocation: { turns: 2, toolCalls: 1, outputBytes: 4096, durationMs: 5000 } };
async function until(check: () => boolean, timeout = 10000) { const deadline = Date.now() + timeout; while (!check()) { assert.ok(Date.now() < deadline, 'delegation fixture readiness timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } }
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function waitAbort(signal: AbortSignal) { if (signal.aborted) return; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }
async function fixture(t: test.TestContext, provider: ProviderAdapter, options: Partial<EngineOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-delegation-'))), repository = join(root, 'repo'), dbPath = join(root, 'engine.sqlite');
  await mkdir(repository); execFileSync('git', ['init', '-q', repository]); await writeFile(join(repository, 'file.txt'), 'committed\n');
  execFileSync('git', ['-C', repository, 'add', '.']); execFileSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const baseCommit = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const engine = createEngine({ ...options, dbPath, providers: [provider], defaults: { providerId: provider.id, modelId: 'fixture', mode: 'build' } });
  const executionLockPath = `${dbPath}.effects.sqlite`;
  // Exercise the host/factory through the actual runtime while public default wiring lands independently.
  if (!engine.getCapabilities().tools.some(tool => tool.name === 'delegate_task')) engine.toolRuntime.register('engine', createDelegateTaskTool(engine.children.delegationHost(executionLockPath)), { exactApproval: true });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const opened = await engine.dispatch({ schemaVersion: 1, commandId: 'open', type: 'workspace.open', payload: { path: repository } }); assert.equal(opened.ok, true);
  const workspace = opened.result as unknown as ToolContext['workspace'];
  const created = await engine.dispatch({ schemaVersion: 1, commandId: 'session', type: 'session.create', payload: { workspaceId: workspace.id } }); assert.equal(created.ok, true);
  const sessionId = (created.result as JsonObject).id as string;
  const submit = async (config: JsonObject = {}) => { const accepted = await engine.dispatch({ schemaVersion: 1, commandId: 'parent', type: 'run.submit', payload: { sessionId, requestId: 'parent', prompt: 'parent', config } }); assert.equal(accepted.ok, true); return (accepted.result as JsonObject).runId as string; };
  const pending = async () => { await until(() => engine.store.getSnapshot(sessionId).approvals.some(approval => approval.status === 'pending')); return engine.store.getSnapshot(sessionId).approvals.find(approval => approval.status === 'pending')!; };
  const decide = (approval: ApprovalRecord, decision: 'allow' | 'deny' = 'allow', fingerprint = approval.fingerprint) => engine.dispatch({ schemaVersion: 1, commandId: `decision-${approval.id}`, type: 'approval.decide', payload: { approvalId: approval.id, decision, fingerprint } });
  return { root, repository, engine, sessionId, workspace, executionLockPath, baseCommit, submit, pending, decide };
}

test('approved model delegation runs a real isolated read-only child and exact retry joins its result without another budget debit', async t => {
  let children = 0, childReads = 0, parentTurns = 0;
  const childTools: string[][] = [];
  const provider: ProviderAdapter = { id: 'fixture', async *streamTurn(input) {
    if (input.messages.some(message => message.role === 'user' && message.content === 'parent')) {
      parentTurns++;
      if (input.turnIndex < 2) { yield { type: 'tool.call', call: { id: `delegate-${input.turnIndex}`, name: 'delegate_task', input: request } }; yield { type: 'finish', reason: 'tool_calls' }; }
      else { yield { type: 'text.delta', delta: 'Parent observed child result.' }; yield { type: 'finish', reason: 'stop' }; }
    } else {
      childTools.push(input.tools.map(tool => tool.name));
      if (input.turnIndex === 0) { children++; yield { type: 'tool.call', call: { id: 'read', name: 'read_file', input: { path: 'file.txt' } } }; yield { type: 'finish', reason: 'tool_calls' }; }
      else { childReads++; assert.ok(input.messages.some(message => message.role === 'tool' && message.content.includes('committed') && !message.content.includes('dirty'))); yield { type: 'text.delta', delta: 'Observed committed file.' }; yield { type: 'finish', reason: 'stop' }; }
    }
  } };
  const f = await fixture(t, provider);
  await writeFile(join(f.repository, 'file.txt'), 'dirty parent\n');
  const runId = await f.submit({ limits: { maxTurns: 6, maxToolCalls: 3 } });
  const first = await f.pending();
  assert.equal(first.toolName, 'delegate_task'); assert.equal(first.preview.baseCommit, f.baseCommit); assert.equal(first.preview.uncommittedChangesIncluded, false);
  assert.deepEqual(f.engine.children.worktrees.list(f.sessionId), []);
  assert.deepEqual(f.engine.children.tasks.list(f.sessionId), []);
  const mismatch = await f.decide(first, 'allow', 'incorrect'); assert.equal(mismatch.ok, false); assert.equal(mismatch.error?.code, 'APPROVAL_FINGERPRINT_MISMATCH');
  assert.deepEqual(f.engine.children.worktrees.list(f.sessionId), []);
  assert.equal((await f.decide(first)).ok, true);
  await until(() => f.engine.store.getSnapshot(f.sessionId).approvals.filter(approval => approval.status === 'pending').length === 1 && f.engine.store.getSnapshot(f.sessionId).approvals.length === 2);
  const second = await f.pending();
  assert.notEqual(second.fingerprint, first.fingerprint); // Different internal parent tool identity.
  assert.equal(second.preview.delegationRequestFingerprint, first.preview.delegationRequestFingerprint);
  assert.equal(f.engine.coordinator.getRemainingChildBudget(runId).toolCalls, 0);
  assert.equal((await f.decide(second)).ok, true);
  const finished = await f.engine.waitForRun(runId);
  assert.equal(finished.state, 'completed', finished.error?.message ?? 'parent completion');
  assert.equal(children, 1); assert.equal(childReads, 1); assert.equal(parentTurns, 3);
  assert.deepEqual(childTools, [['read_file'], ['read_file']]);
  const tasks = f.engine.children.tasks.list(f.sessionId), trees = f.engine.children.worktrees.list(f.sessionId);
  assert.equal(tasks.length, 1); assert.equal(trees.length, 1); assert.equal(tasks[0]!.state, 'completed'); assert.equal(tasks[0]!.deliveryState, 'none'); assert.equal(trees[0]!.ownerId, undefined);
  assert.equal(await readFile(join(trees[0]!.root, 'file.txt'), 'utf8'), 'committed\n');
  assert.equal(await readFile(join(f.repository, 'file.txt'), 'utf8'), 'dirty parent\n');
  assert.equal(execFileSync('git', ['-C', f.repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), f.baseCommit);
  const snapshot = f.engine.store.getSnapshot(f.sessionId), results = snapshot.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
  assert.equal(results.length, 2); assert.equal(results[0].childTaskId, results[1].childTaskId); assert.equal(results[0].observation, 'Observed committed file.');
  assert.equal(f.engine.store.listInputs(f.sessionId).inputs.length, 1);
  assert.equal(inspectExecutionLock(f.executionLockPath).status, 'available');
});

test('denied approval and invalid child allocation cannot create a worktree or dispatch another model', async t => {
  let calls = 0;
  const provider: ProviderAdapter = { id: 'fixture', async *streamTurn(input) { calls++; if (input.turnIndex === 0) { yield { type: 'tool.call', call: { id: 'delegate', name: 'delegate_task', input: request } }; yield { type: 'finish', reason: 'tool_calls' }; } else yield { type: 'finish', reason: 'stop' }; } };
  const f = await fixture(t, provider), runId = await f.submit();
  const approval = await f.pending(); assert.equal((await f.decide(approval, 'deny')).ok, true);
  assert.equal((await f.engine.waitForRun(runId)).state, 'completed');
  assert.equal(calls, 2); assert.deepEqual(f.engine.children.worktrees.list(f.sessionId), []); assert.deepEqual(f.engine.children.tasks.list(f.sessionId), []);
  const separate = await fixture(t, provider), oversized = await separate.submit({ limits: { maxTurns: 1, maxToolCalls: 1 } });
  const failed = await separate.engine.waitForRun(oversized); assert.equal(failed.error?.code, 'TURN_LIMIT');
  const tools = separate.engine.store.getSnapshot(separate.sessionId).tools;
  assert.ok(tools[0]!.output?.includes('DELEGATION_BUDGET_EXCEEDED'));
  assert.deepEqual(separate.engine.children.worktrees.list(separate.sessionId), []); assert.deepEqual(separate.engine.children.tasks.list(separate.sessionId), []);
});

test('parent cancel stops the actual child stream and releases confirmed child ownership without result delivery', async t => {
  const entered = gate(), aborted = gate();
  const provider: ProviderAdapter = { id: 'fixture', async *streamTurn(input, signal) { if (input.messages.some(message => message.role === 'user' && message.content === 'parent')) { yield { type: 'tool.call', call: { id: 'delegate', name: 'delegate_task', input: request } }; yield { type: 'finish', reason: 'tool_calls' }; } else { const stopped = waitAbort(signal); signal.addEventListener('abort', aborted.resolve, { once: true }); entered.resolve(); yield { type: 'progress' }; await stopped; } } };
  const f = await fixture(t, provider), runId = await f.submit(); assert.equal((await f.decide(await f.pending())).ok, true);
  await entered.promise;
  const accepted = f.engine.children.tasks.list(f.sessionId)[0]!;
  assert.equal((await f.engine.dispatch({ schemaVersion: 1, commandId: 'cancel', type: 'run.cancel', payload: { runId } })).ok, true);
  const child = await f.engine.children.tasks.wait(f.sessionId, accepted.id);
  await aborted.promise;
  assert.equal(child.state, 'cancelled'); assert.equal(child.deliveryState, 'none');
  assert.equal((await f.engine.waitForRun(runId)).state, 'cancelled');
  assert.equal(f.engine.children.worktrees.get(f.sessionId, child.worktreeId).ownerId, undefined);
  assert.equal(inspectExecutionLock(f.executionLockPath).status, 'available');
  assert.equal(f.engine.store.listInputs(f.sessionId).inputs.length, 1);
});

test('changed HEAD after approval preparation rejects stale execution before isolated effects', async t => {
  const provider: ProviderAdapter = { id: 'fixture', async *streamTurn(input) { if (input.turnIndex === 0) { yield { type: 'tool.call', call: { id: 'delegate', name: 'delegate_task', input: request } }; yield { type: 'finish', reason: 'tool_calls' }; } else yield { type: 'finish', reason: 'stop' }; } };
  const f = await fixture(t, provider), runId = await f.submit(), approval = await f.pending();
  await writeFile(join(f.repository, 'another'), 'new commit'); execFileSync('git', ['-C', f.repository, 'add', 'another']); execFileSync('git', ['-C', f.repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'after preparation']);
  assert.equal((await f.decide(approval)).ok, true); assert.equal((await f.engine.waitForRun(runId)).state, 'completed');
  assert.ok(f.engine.store.getSnapshot(f.sessionId).tools[0]!.output?.includes('DELEGATION_APPROVAL_STALE'));
  assert.deepEqual(f.engine.children.worktrees.list(f.sessionId), []); assert.deepEqual(f.engine.children.tasks.list(f.sessionId), []);
});

test('wrong owner and an already-held effect marker cannot create worktrees or replace that marker', async t => {
  const provider: ProviderAdapter = { id: 'fixture', async *streamTurn(input) { if (input.turnIndex === 0) { yield { type: 'tool.call', call: { id: 'delegate', name: 'delegate_task', input: request } }; yield { type: 'finish', reason: 'tool_calls' }; } else yield { type: 'finish', reason: 'stop' }; } };
  const f = await fixture(t, provider), runId = await f.submit(), approval = await f.pending();
  const host = f.engine.children.delegationHost(f.executionLockPath), context: ToolContext = { sessionId: f.sessionId, runId, toolCallId: approval.toolCallId, workspace: f.workspace, signal: new AbortController().signal, limits: f.engine.store.getRun(runId).config.limits, artifactDir: join(f.root, 'artifacts'), executionLockPath: `${f.executionLockPath}.wrong`, recordCheckpoint() {} };
  await assert.rejects(host.inspect(context, request), { code: 'DELEGATION_OWNER_MISMATCH' });
  const lock = acquireExecutionLock(f.executionLockPath);
  try {
    assert.equal((await f.decide(approval)).ok, true);
    await until(() => f.engine.store.getSnapshot(f.sessionId).tools.some(tool => tool.state === 'failed'));
    assert.equal(inspectExecutionLock(f.executionLockPath).status, 'busy');
    assert.deepEqual(f.engine.children.worktrees.list(f.sessionId), []); assert.deepEqual(f.engine.children.tasks.list(f.sessionId), []);
  } finally { lock.release(true); }
  await f.engine.waitForRun(runId); assert.equal(inspectExecutionLock(f.executionLockPath).status, 'available');
  await assert.rejects(access(join(f.root, 'unexpected-execution')), { code: 'ENOENT' });
});

test('worktree journal observation failure after real Git effects retains the active marker and never dispatches a child', async t => {
  let modelCalls = 0;
  const provider: ProviderAdapter = { id: 'fixture', async *streamTurn() { modelCalls++; yield { type: 'tool.call', call: { id: 'delegate', name: 'delegate_task', input: request } }; yield { type: 'finish', reason: 'tool_calls' }; } };
  const f = await fixture(t, provider), manager = f.engine.children.worktrees;
  const originalCreate = manager.create.bind(manager), originalList = manager.list.bind(manager);
  let journalUnreadable = false;
  manager.create = async (input, signal) => { await originalCreate(input, signal); journalUnreadable = true; throw new EngineError('WORKTREE_RECORD_UNCERTAIN', 'Injected durable settlement observation failure'); };
  manager.list = sessionId => { if (journalUnreadable) throw new EngineError('INVALID_WORKTREE_JOURNAL', 'Injected journal read failure'); return originalList(sessionId); };
  t.after(() => { journalUnreadable = false; manager.create = originalCreate; manager.list = originalList; });
  const runId = await f.submit(); assert.equal((await f.decide(await f.pending())).ok, true);
  const failed = await f.engine.waitForRun(runId);
  assert.equal(failed.error?.code, 'CLEANUP_UNCERTAIN');
  assert.equal(inspectExecutionLock(f.executionLockPath).status, 'uncertain');
  assert.equal(modelCalls, 1); assert.deepEqual(f.engine.children.tasks.list(f.sessionId), []);
  const observed = originalList(f.sessionId); assert.equal(observed.length, 1);
  assert.equal(await readFile(join(observed[0]!.root, 'file.txt'), 'utf8'), 'committed\n');
});
