import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as tick } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { EngineError, type ApprovalRecord, type JsonObject, type RunReceipt } from '@moodcode/contracts';
import { createEngine, type EngineOptions } from '../engine.js';
import { retainBackendFixture } from '../agent-backends/fixtures/backend.js';
import type { PreparedTool, ProviderAdapter, ProviderEvent, ToolDefinition, TurnRequest } from '../ports.js';
import { LifecycleHookRegistry, type LifecycleCapture, type LifecycleHookRegistration, type LifecycleHookResult, type LifecycleInvocation } from './index.js';

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stop: ProviderEvent = { type: 'finish', reason: 'stop' };
const hook = (id: string, stages: LifecycleHookRegistration['stages'], callback: LifecycleHookRegistration['callback'], options: Partial<LifecycleHookRegistration> = {}): LifecycleHookRegistration => ({ id, revision: 1, stages, callback, ...options });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(predicate: () => boolean) { const deadline = performance.now() + 3_000; while (!predicate()) { if (performance.now() > deadline) assert.fail('Authored lifecycle boundary did not arrive'); await tick(); } }

async function fixture(t: TestContext, provider: ProviderAdapter, options: Omit<EngineOptions, 'dbPath' | 'providers'> = {}) {
  const root = await realpath(await mkdtemp(join(process.env.MOODCODE_CONTEXT_FIXTURE_ROOT ?? tmpdir(), 'moodcode-host-lifecycle-'))), dbPath = join(root, 'state.sqlite');
  const engine = createEngine({ dbPath, artifactDir: join(root, 'artifacts'), tools: [], providers: [provider], ...options });
  engine.store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt: new Date().toISOString() });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Host lifecycle integration', createdAt: new Date().toISOString() });
  t.after(async () => { await retainBackendFixture(t, root, new Set([engine])); });
  const submit = async () => {
    const response = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type: 'run.submit', payload: { sessionId: 'session', requestId: randomUUID(), prompt: 'Complete the authored local fixture', config: { providerId: provider.id, modelId: 'authored-model', mode: 'build', limits: { maxTurns: 4, maxDurationMs: 5_000 }, budgets: { maxProviderAttempts: 3, retryBaseDelayMs: 0 } } } });
    assert.equal(response.ok, true, JSON.stringify(response.error)); return response.result as unknown as RunReceipt;
  };
  const events = () => engine.store.readEvents('session', 0, 1_024);
  const nativeCount = (table: 'attempt_cleanup' | 'provider_attempts', runId: string) => { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id = ?`).get(runId) as { count: number }).count); } finally { db.close(); } };
  const pendingApproval = async (runId: string): Promise<ApprovalRecord> => {
    let found: ApprovalRecord | undefined;
    await until(() => { found = engine.store.getSnapshot('session').approvals.find(item => item.runId === runId && item.status === 'pending'); return !!found; }); return found!;
  };
  return { root, dbPath, engine, submit, events, nativeCount, pendingApproval };
}

function producer(name = 'authored_write', effect: 'read' | 'write' = 'write', options: { uncertain?: boolean; checkpoint?: boolean } = {}) {
  const handles = new WeakSet<PreparedTool>(), counts = { prepare: 0, execute: 0 };
  const tool: ToolDefinition = { name, description: 'Authored local lifecycle producer', effectClass: effect, inputSchema: { type: 'object', properties: { marker: { type: 'string', enum: ['original'] } } },
    async prepare(input) { counts.prepare++; const value = { name, input: input as JsonObject, fingerprint: sha(input), requiresApproval: effect === 'write', preview: { marker: 'original' } }; handles.add(value); return value; },
    async execute(prepared, context) {
      assert.equal(handles.has(prepared), true, 'Lifecycle does not replace the original opaque producer handle'); counts.execute++;
      if (effect === 'write') {
        await writeFile(join(context.workspace.root, 'observed-effect.txt'), 'authored effect');
        if (options.checkpoint) context.recordCheckpoint({ id: randomUUID(), runId: context.runId, toolCallId: context.toolCallId, kind: 'patch', createdAt: new Date().toISOString(), files: [{ path: 'observed-effect.txt', before: null, after: 'authored effect', beforeHash: null, afterHash: createHash('sha256').update('authored effect').digest('hex') }], warnings: [] });
      }
      return options.uncertain ? { content: 'Unconfirmed authored cleanup', data: { cleanupConfirmed: false } } : { content: 'Authored producer completed' };
    } };
  return { tool, counts };
}
function callingProvider(name: string, requests: TurnRequest[] = []): ProviderAdapter {
  return { id: 'authored-provider', async *streamTurn(request) { requests.push(structuredClone(request)); if (!request.turnIndex) { yield { type: 'tool.call', call: { id: 'authored-call', name, input: { marker: 'original' } } }; yield { type: 'finish', reason: 'tool_calls' }; } else { yield { type: 'text.delta', delta: 'Authored final response' }; yield stop; } } };
}

test('initial before-model denial prevents native provider invocation, Attempt and cleanup creation', async t => {
  let invoked = 0;
  const provider: ProviderAdapter = { id: 'authored-denied', async *streamTurn() { invoked++; yield stop; } };
  const f = await fixture(t, provider, { lifecycleHooks: [hook('deny-model', ['before-model'], () => ({ kind: 'deny', code: 'HOST_DENY', reason: 'Authored policy' }))] });
  const receipt = await f.submit(), run = await f.engine.waitForRun(receipt.runId);
  assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'LIFECYCLE_DENIED'); assert.equal(invoked, 0);
  assert.equal(f.nativeCount('provider_attempts', run.id), 0); assert.equal(f.nativeCount('attempt_cleanup', run.id), 0);
  const event = f.events().find(item => item.type === 'lifecycle.outcome' && item.payload.stage === 'before-model'); assert.equal(event?.payload.action, 'deny');
});

test('logical model hook digest and detached metadata do not change same-Turn retry snapshots or native cleanup digests', async t => {
  const source = producer('authored_read', 'read'), schema = structuredClone(source.tool.inputSchema), requests: TurnRequest[] = [], observed: LifecycleInvocation[] = [];
  const provider: ProviderAdapter = { id: 'authored-retry', async *streamTurn(request) {
    requests.push(structuredClone(request));
    if (requests.length === 1) { request.messages[0]!.content = 'Adapter-only mutation'; request.tools[0]!.inputSchema.type = 'array'; throw new EngineError('PROVIDER_HTTP_ERROR', 'Authored retry', { status: 429, retryAfterMs: 0 }); }
    yield stop;
  } };
  const f = await fixture(t, provider, { tools: [source.tool], lifecycleHooks: [hook('observe-model', ['before-model', 'after-model'], event => { observed.push(event); assert.equal(Object.isFrozen(event.metadata), true); assert.equal('messages' in event.metadata, false); return { kind: 'observe', metadata: { privateHostObservation: 'not-journalled' } }; })] });
  const receipt = await f.submit(), run = await f.engine.waitForRun(receipt.runId);
  assert.equal(run.state, 'completed'); assert.equal(requests.length, 2); assert.equal(observed.filter(item => item.stage === 'before-model').length, 1);
  assert.deepEqual(requests[1]!.messages, requests[0]!.messages); assert.deepEqual(requests[1]!.tools, requests[0]!.tools); assert.deepEqual(source.tool.inputSchema, schema);
  const logical = structuredClone(requests[0]!); delete logical.turnId; delete logical.attemptId; delete logical.includeMetadata;
  const before = observed.find(item => item.stage === 'before-model')!; assert.equal(before.stage, 'before-model');
  if (before.stage === 'before-model') { assert.equal(before.metadata.requestSha256, sha(logical)); assert.equal(before.metadata.toolCount, logical.tools.length); }
  for (const request of requests) { const cleanup = f.engine.store.getAttemptCleanup(request.attemptId!, 'session'); assert.equal(cleanup.state, 'confirmed'); assert.equal(cleanup.requestSha256, sha(request)); }
  assert.equal(JSON.stringify(f.events().filter(item => item.type === 'lifecycle.outcome')).includes('privateHostObservation'), false);
  const legacy = f.events().filter(item => item.type === 'lifecycle.outcome'), native = f.engine.store.readSessionEvents('session', 0, 100).filter(item => item.type === 'lifecycle.outcome');
  assert.deepEqual(native.map(item => item.payload), legacy.map(item => item.payload)); assert.equal(native.length, 2);
  for (const event of native) { assert.equal(event.runId, run.id); assert.equal(event.turnId, requests[0]!.turnId); }
  assert.equal(native[0]!.attemptId, undefined); assert.equal(native[1]!.attemptId, requests[1]!.attemptId);
});

test('after-model observes durable message, completed Attempt and confirmed native iterator cleanup', async t => {
  let f!: Awaited<ReturnType<typeof fixture>>, seen = false;
  const provider: ProviderAdapter = { id: 'authored-completion', async *streamTurn() { yield { type: 'text.delta', delta: 'Authored answer' }; yield stop; } };
  f = await fixture(t, provider, { lifecycleHooks: [hook('after', ['after-model'], event => {
    assert.equal(event.stage, 'after-model'); if (event.stage !== 'after-model') return;
    const attempt = f.engine.store.getAttempt(event.metadata.attemptId!); assert.equal(attempt.state, 'completed');
    assert.equal(f.engine.store.getTurn(event.metadata.turnId!).state, 'completed');
    assert.equal(f.engine.store.getAttemptCleanup(attempt.id, 'session').state, 'confirmed');
    assert.ok(f.events().some(item => item.type === 'message.completed')); assert.equal(f.engine.store.getRun(event.identity.runId).state, 'running'); seen = true;
  })] });
  assert.equal((await f.engine.waitForRun((await f.submit()).runId)).state, 'completed'); assert.equal(seen, true);
});

test('tool-prepared denial preserves exact metadata and durable denied result without an approval or producer effect', async t => {
  const source = producer(), requests: TurnRequest[] = []; let seen: LifecycleInvocation | undefined;
  const f = await fixture(t, callingProvider(source.tool.name, requests), { tools: [source.tool], lifecycleHooks: [hook('deny-tool', ['tool-prepared'], event => { seen = event; return { kind: 'deny', code: 'HOST_DENY', reason: 'Authored denial' }; })] });
  const receipt = await f.submit(), run = await f.engine.waitForRun(receipt.runId);
  assert.equal(run.state, 'completed'); assert.equal(source.counts.prepare, 1); assert.equal(source.counts.execute, 0);
  assert.equal(f.engine.store.getSnapshot('session').approvals.length, 0); assert.ok(f.events().some(item => item.type === 'tool.denied'));
  assert.ok(requests[1]!.messages.some(item => item.role === 'tool' && item.content.includes('LIFECYCLE_DENIED')));
  assert.equal(seen?.stage, 'tool-prepared'); if (seen?.stage === 'tool-prepared') { assert.match(seen.metadata.fingerprint, /^.+$/); assert.equal(seen.metadata.requiresApproval, true); assert.equal('input' in seen.metadata, false); assert.equal('preview' in seen.metadata, false); }
});

test('tool observation preserves exact native approval and produces one durable effect before settled stop', async t => {
  const source = producer('authored_write', 'write', { checkpoint: true }); let prepared: LifecycleInvocation | undefined, settled = false, f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, callingProvider(source.tool.name), { tools: [source.tool], lifecycleHooks: [hook('prepared', ['tool-prepared'], event => { prepared = event; }), hook('settled-stop', ['tool-settled'], event => {
    assert.equal(event.stage, 'tool-settled'); if (event.stage !== 'tool-settled') return;
    const tool = f.engine.store.getSnapshot('session').tools.find(item => item.id === event.metadata.toolCallId)!; assert.equal(tool.state, 'completed');
    assert.equal(f.engine.store.listCheckpoints(event.identity.runId).length, 1); settled = true;
    return { kind: 'stop', code: 'HOST_STOP', reason: 'Stop after observing the durable effect' };
  })] });
  const receipt = await f.submit(), approval = await f.pendingApproval(receipt.runId);
  assert.equal(prepared?.stage, 'tool-prepared'); if (prepared?.stage === 'tool-prepared') assert.equal(approval.fingerprint, prepared.metadata.fingerprint);
  f.engine.approvals.decide(approval.id, 'allow', approval.fingerprint);
  const run = await f.engine.waitForRun(receipt.runId); assert.equal(run.state, 'cancelled'); assert.equal(source.counts.execute, 1); assert.equal(settled, true);
  assert.equal(await readFile(join(f.root, 'observed-effect.txt'), 'utf8'), 'authored effect'); assert.equal(f.engine.store.listCheckpoints(run.id).length, 1);
  assert.equal(f.engine.store.getSnapshot('session').tools[0]!.state, 'completed'); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), false);
});

test('registry mutation while exact approval waits prevents effect and terminates with stale policy', async t => {
  const source = producer();
  const f = await fixture(t, callingProvider(source.tool.name), { tools: [source.tool], lifecycleHooks: [hook('prepared', ['tool-prepared'], () => {})] });
  const receipt = await f.submit(), approval = await f.pendingApproval(receipt.runId);
  f.engine.registerLifecycleHook(hook('new-policy', ['before-model'], () => ({ kind: 'deny', code: 'NEW_POLICY', reason: 'Authored newer policy' })));
  f.engine.approvals.decide(approval.id, 'allow', approval.fingerprint);
  const run = await f.engine.waitForRun(receipt.runId); assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'LIFECYCLE_REGISTRY_STALE'); assert.equal(source.counts.execute, 0);
});

test('model callback deadline prevents native dispatch and late resolve cannot reopen the terminal Run', async t => {
  let invokes = 0; const pending = deferred<LifecycleHookResult>();
  const provider: ProviderAdapter = { id: 'authored-timeout', async *streamTurn() { invokes++; yield stop; } };
  const f = await fixture(t, provider, { lifecycleHooks: [hook('slow', ['before-model'], () => pending.promise, { timeoutMs: 15 })] });
  const receipt = await f.submit(), run = await f.engine.waitForRun(receipt.runId); assert.equal(run.state, 'cancelled'); assert.equal(invokes, 0); assert.equal(f.nativeCount('attempt_cleanup', run.id), 0);
  const outcomes = f.events().filter(item => item.type === 'lifecycle.outcome'); assert.equal((outcomes[0]!.payload.outcomes as JsonObject[])[0]!.status, 'timed-out');
  pending.resolve({ kind: 'observe' }); await tick(); assert.equal(f.engine.store.getRun(run.id).state, 'cancelled'); assert.equal(invokes, 0);
});

test('Run cancellation during a pending model callback cancels result acceptance without native cleanup fabrication', async t => {
  let invokes = 0, entered = false; const pending = deferred<LifecycleHookResult>();
  const provider: ProviderAdapter = { id: 'authored-cancel', async *streamTurn() { invokes++; yield stop; } };
  const f = await fixture(t, provider, { lifecycleHooks: [hook('pending', ['before-model'], () => { entered = true; return pending.promise; })] });
  const receipt = await f.submit(); await until(() => entered); f.engine.coordinator.cancel(receipt.runId);
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'cancelled'); assert.equal(invokes, 0); assert.equal(f.nativeCount('attempt_cleanup', receipt.runId), 0);
  pending.resolve({ kind: 'deny', code: 'LATE', reason: 'Too late' }); await tick(); assert.equal(invokes, 0);
});

test('native cleanup uncertainty remains authoritative when a terminal observation callback requests stop', async t => {
  let returns = 0, terminalObserved = false;
  const provider: ProviderAdapter = { id: 'authored-uncertain-provider', streamTurn() { return { [Symbol.asyncIterator]() { return { async next(): Promise<IteratorResult<ProviderEvent>> { throw new EngineError('PROVIDER_ERROR', 'Authored source failure'); }, async return() { returns++; return { done: false, value: stop }; } }; } }; } };
  const f = await fixture(t, provider, { lifecycleHooks: [hook('terminal', ['before-stop'], event => { terminalObserved = true; assert.equal(event.stage, 'before-stop'); if (event.stage === 'before-stop') assert.equal(event.metadata.errorCode, 'CLEANUP_UNCERTAIN'); return { kind: 'stop', code: 'HOST_STOP', reason: 'Does not replace cleanup evidence' }; })] });
  const run = await f.engine.waitForRun((await f.submit()).runId); assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(returns, 1); assert.equal(terminalObserved, true); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), true);
});

test('effect cleanup uncertainty survives a settled callback stop and leaves the original checkpoint quarantined', async t => {
  const source = producer('authored_write', 'write', { uncertain: true, checkpoint: true }); let settledObserved = false;
  const f = await fixture(t, callingProvider(source.tool.name), { tools: [source.tool], lifecycleHooks: [hook('settled', ['tool-settled'], () => { settledObserved = true; return { kind: 'stop', code: 'HOST_STOP', reason: 'Cannot replace producer uncertainty' }; })] });
  const receipt = await f.submit(), approval = await f.pendingApproval(receipt.runId); f.engine.approvals.decide(approval.id, 'allow', approval.fingerprint);
  const run = await f.engine.waitForRun(receipt.runId); assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(source.counts.execute, 1); assert.equal(settledObserved, true);
  assert.equal(f.engine.store.listCheckpoints(run.id).length, 1); assert.equal(f.engine.store.getSnapshot('session').tools[0]!.state, 'interrupted'); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), true);
});

test('successful terminal observation runs before terminal commit and every Run capture is released', async t => {
  let f!: Awaited<ReturnType<typeof fixture>>, captured: LifecycleCapture | undefined, beforeTerminal = false;
  const provider: ProviderAdapter = { id: 'authored-terminal', async *streamTurn() { yield stop; } };
  f = await fixture(t, provider, { lifecycleHooks: [hook('terminal', ['before-stop'], event => { assert.equal(f.engine.store.getRun(event.identity.runId).state, 'running'); assert.equal(f.events().some(item => item.type === 'run.completed'), false); beforeTerminal = true; })] });
  const capture = f.engine.lifecycleHooks.capture.bind(f.engine.lifecycleHooks); f.engine.lifecycleHooks.capture = identity => { captured = capture(identity); return captured; };
  const run = await f.engine.waitForRun((await f.submit()).runId); assert.equal(run.state, 'completed'); assert.equal(beforeTerminal, true);
  assert.throws(() => f.engine.lifecycleHooks.assertCurrent(captured!), { code: 'LIFECYCLE_CAPTURE_RELEASED' });
  await f.engine.close(); assert.throws(() => f.engine.registerLifecycleHook(hook('closed', ['before-model'], () => {})), { code: 'ENGINE_CLOSED' });
});

test('explicit shared registry option applies dynamic host registration and rejects ambiguous setup before storage', async t => {
  const registry = new LifecycleHookRegistry(); let invokes = 0;
  const provider: ProviderAdapter = { id: 'authored-shared', async *streamTurn() { invokes++; yield stop; } };
  assert.throws(() => createEngine({ dbPath: ':memory:', lifecycleHookRegistry: registry, lifecycleHooks: [] }), { code: 'INVALID_LIFECYCLE_HOOK' });
  assert.throws(() => createEngine({ dbPath: ':memory:', lifecycleHookRegistry: {} as LifecycleHookRegistry }), { code: 'INVALID_LIFECYCLE_HOOK' });
  const f = await fixture(t, provider, { lifecycleHookRegistry: registry });
  f.engine.registerLifecycleHook(hook('dynamic', ['before-model'], () => ({ kind: 'deny', code: 'HOST_DENY', reason: 'Explicit shared host policy' })));
  assert.equal(f.engine.lifecycleHooks, registry); assert.equal((await f.engine.waitForRun((await f.submit()).runId)).error?.code, 'LIFECYCLE_DENIED'); assert.equal(invokes, 0);
});

test('after-model stop retains completed Attempt and confirmed cleanup without starting another producer', async t => {
  let invokes = 0, f!: Awaited<ReturnType<typeof fixture>>, attemptId: string | undefined;
  const provider: ProviderAdapter = { id: 'authored-after-stop', async *streamTurn(request) { invokes++; attemptId = request.attemptId; yield { type: 'text.delta', delta: 'Durable authored output' }; yield stop; } };
  f = await fixture(t, provider, { lifecycleHooks: [hook('after-stop', ['after-model'], () => ({ kind: 'stop', code: 'HOST_STOP', reason: 'Stop after successful native settlement' }))] });
  const run = await f.engine.waitForRun((await f.submit()).runId); assert.equal(run.state, 'cancelled'); assert.equal(invokes, 1);
  assert.equal(f.engine.store.getAttempt(attemptId!).state, 'completed'); assert.equal(f.engine.store.getAttemptCleanup(attemptId!, 'session').state, 'confirmed');
  assert.equal(f.engine.store.getSnapshot('session').messages.some(item => item.content.includes('Durable authored output')), true); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), false);
});

test('tool registry mutation during model hook refuses the frozen eager capture before native dispatch', async t => {
  const source = producer('authored_read', 'read'); let invokes = 0, f!: Awaited<ReturnType<typeof fixture>>;
  const provider: ProviderAdapter = { id: 'authored-catalogue-stale', async *streamTurn() { invokes++; yield stop; } };
  f = await fixture(t, provider, { tools: [source.tool], lifecycleHooks: [hook('catalogue-change', ['before-model'], () => { f.engine.toolRuntime.register('engine', producer('later_read', 'read').tool); })] });
  const run = await f.engine.waitForRun((await f.submit()).runId); assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'TOOL_CATALOGUE_STALE'); assert.equal(invokes, 0); assert.equal(f.nativeCount('attempt_cleanup', run.id), 0);
});

test('actual owned child receives dynamically registered host policy through the shared registry', { timeout: 15_000 }, async t => {
  const root = await realpath(await mkdtemp(join(process.env.MOODCODE_CONTEXT_FIXTURE_ROOT ?? tmpdir(), 'moodcode-lifecycle-child-'))), repo = join(root, 'repo'); await mkdir(repo);
  execFileSync('git', ['init', '-q', repo]); await writeFile(join(repo, 'file.txt'), 'Authored child source'); execFileSync('git', ['-C', repo, 'add', 'file.txt']); execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Authored child source']);
  const parentEntered = deferred<void>(), release = deferred<void>(); let childInvokes = 0, shared = false, parentWorkspaceId = '', childFailure: string | undefined;
  const provider: ProviderAdapter = { id: 'authored-child-policy', async *streamTurn(request, signal) {
    const prompt = request.messages.findLast(item => item.role === 'user')?.content;
    if (prompt === 'authored-parent') {
      parentEntered.resolve(); let abort!: () => void;
      try { await Promise.race([release.promise, new Promise<void>(resolve => { abort = resolve; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]); }
      finally { signal.removeEventListener('abort', abort); }
      if (!signal.aborted) yield stop; return;
    }
    childInvokes++; yield stop;
  } };
  const engine = createEngine({ dbPath: join(root, 'state.sqlite'), artifactDir: join(root, 'artifacts'), providers: [provider], defaults: { providerId: provider.id, modelId: 'authored-model', mode: 'build', limits: { maxTurns: 4, maxDurationMs: 10_000 } }, configureChild: child => {
    shared = child.lifecycleHooks === engine.lifecycleHooks;
    const wait = child.waitForRun.bind(child); child.waitForRun = id => wait(id).then(run => { childFailure = run.error?.code; return run; });
  } });
  t.after(async () => { release.resolve(); await retainBackendFixture(t, root, new Set([engine])); });
  const opened = await engine.dispatch({ schemaVersion: 1, commandId: 'open', type: 'workspace.open', payload: { path: repo } }); assert.equal(opened.ok, true); parentWorkspaceId = (opened.result as { id: string }).id;
  const session = engine.store.createSession({ id: 'root-session', workspaceId: parentWorkspaceId, title: 'Authored policy child', createdAt: new Date().toISOString() });
  const worktree = await engine.createWorktree(session.id, 'authored-child-worktree');
  engine.registerLifecycleHook(hook('host-child-deny', ['before-model'], event => event.identity.workspaceId === parentWorkspaceId ? { kind: 'observe' } : { kind: 'deny', code: 'HOST_CHILD_DENY', reason: 'Inherited dynamic host policy' }));
  const parent = engine.scheduler.submitLegacy({ sessionId: session.id, requestId: 'parent', prompt: 'authored-parent', config: engine.getCapabilities().defaults }); await parentEntered.promise;
  const task = await engine.startChildTask({ sessionId: session.id, requestId: 'child', parentRunId: parent.runId, worktreeId: worktree.id, prompt: 'authored-child', tools: ['read_file'], allocation: { turns: 2, toolCalls: 1, outputBytes: 4_096, durationMs: 5_000 } });
  const outcome = await engine.children.tasks.wait(session.id, task.id);
  assert.equal(shared, true); assert.equal(childInvokes, 0); assert.equal(outcome.state, 'failed'); assert.equal(outcome.outcome?.state, 'failed');
  assert.equal(childFailure, 'LIFECYCLE_DENIED'); release.resolve(); assert.equal((await engine.waitForRun(parent.runId)).state, 'completed');
});

for (const discovery of [false, true]) test(`observing lifecycle hooks retain ${discovery ? 'bounded discovery' : 'eager'} captured schemas and producer identity`, async t => {
  const source = producer('authored_read', 'read'), requests: TurnRequest[] = []; let prepared = 0;
  const f = await fixture(t, callingProvider(source.tool.name, requests), { tools: [source.tool], ...(discovery ? { toolDiscoveryPolicy: { kind: 'bounded-tool-discovery', version: 1, alwaysVisibleToolNames: [source.tool.name] } as const } : {}), lifecycleHooks: [hook('model', ['before-model'], event => { assert.equal(event.stage, 'before-model'); source.tool.inputSchema.type = 'array'; }), hook('prepared', ['tool-prepared'], () => { prepared++; })] });
  const run = await f.engine.waitForRun((await f.submit()).runId); assert.equal(run.state, 'completed'); assert.equal(source.counts.execute, 1); assert.equal(prepared, 1);
  for (const request of requests) assert.equal(request.tools.find(item => item.name === source.tool.name)!.inputSchema.type, 'object');
  assert.ok(requests[1]!.messages.some(item => item.role === 'tool' && item.content.includes('Authored producer completed'))); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), false);
});
