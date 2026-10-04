import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { EngineError, SCHEMA_VERSION, isTerminal, type ApprovalRecord, type CommandResult, type EngineEvent, type JsonObject, type RunReceipt, type Session, type SessionSnapshot, type Workspace } from '@moodcode/contracts';
import { CodexProvider, type MoodcodeEngine } from '@moodcode/engine';
import { UtilityWorker, WORKER_LIMITS } from './core.js';
import type { WorkerBootstrap, WorkerPush, WorkerRequest, WorkerStartPayload } from './protocol.js';

async function request<T>(worker: UtilityWorker, type: WorkerRequest['type'], payload?: unknown): Promise<T> {
  const response = await worker.handle({ id: randomUUID(), type, ...(payload === undefined ? {} : { payload }) });
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result?: unknown }).result as T;
}
async function command<T>(worker: UtilityWorker, type: string, payload: JsonObject = {}): Promise<T> {
  const response = await request<CommandResult>(worker, 'command', { schemaVersion: SCHEMA_VERSION, commandId: randomUUID(), type, payload });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result as T;
}
async function snapshot(worker: UtilityWorker, sessionId: string): Promise<SessionSnapshot> {
  return command(worker, 'session.getSnapshot', { sessionId });
}
async function until<T>(operation: () => Promise<T>, condition: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation();
    if (condition(value)) return value;
    await delay(10);
  }
  throw new Error('Fixture state did not become ready.');
}
async function fixture(t: TestContext, scenario?: 'coding' | 'slow') {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-desktop-worker-'));
  const repository = join(directory, 'repository');
  await mkdir(repository);
  execFileSync('git', ['init', '-q', repository]);
  const pushes: WorkerPush[] = [];
  const worker = new UtilityWorker({ emit: push => pushes.push(push) });
  const start: WorkerStartPayload = { dbPath: join(directory, 'state.sqlite'), artifactDir: join(directory, 'artifacts'),
    config: { providerId: 'scripted', modelId: 'scripted-echo', baseURL: '' }, ...(scenario ? { testScenario: scenario } : {}) };
  t.after(async () => { await worker.close(); await rm(directory, { recursive: true, force: true }); });
  const bootstrap = await request<WorkerBootstrap>(worker, 'start', start);
  const workspace = await command<Workspace>(worker, 'workspace.open', { path: repository });
  const session = await command<Session>(worker, 'session.create', { workspaceId: workspace.id });
  return { worker, pushes, start, bootstrap, workspace, session, repository, directory };
}
async function submit(worker: UtilityWorker, sessionId: string): Promise<RunReceipt> {
  return command(worker, 'run.submit', { sessionId, requestId: randomUUID(), prompt: 'Fix and verify add(a, b).', config: { mode: 'build' } });
}
async function pendingApproval(worker: UtilityWorker, sessionId: string, name: string): Promise<ApprovalRecord> {
  const value = await until(() => snapshot(worker, sessionId), current => current.approvals.some(approval => approval.toolName === name && approval.status === 'pending'));
  return value.approvals.find(approval => approval.toolName === name && approval.status === 'pending')!;
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function allowNestedTestCommand(t: TestContext): void {
  // A supervised node --test command must run the temporary workspace tests.
  // Node's own test harness marker would otherwise cause it to silently skip them.
  const prior = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (prior === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prior; });
}
function fakeEngine(options: Partial<Pick<MoodcodeEngine, 'dispatch' | 'subscribe' | 'close' | 'store'>> = {}): Pick<MoodcodeEngine, 'dispatch' | 'subscribe' | 'close' | 'store'> {
  return {
    store: { listWorkspaces: () => [] } as unknown as MoodcodeEngine['store'],
    dispatch: async value => ({ schemaVersion: 1, commandId: (value as { commandId: string }).commandId, ok: true, result: {} }),
    async *subscribe() {}, close: async () => {}, ...options,
  };
}

test('bootstrap uses persisted workspaces and scripted defaults without credentials', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.bootstrap.workspaces, []);
  assert.equal(f.bootstrap.capabilities.defaults.providerId, 'scripted');
  assert.equal(f.bootstrap.capabilities.defaults.modelId, 'scripted-echo');
  const boot = await request<WorkerBootstrap>(f.worker, 'bootstrap');
  assert.deepEqual(boot.workspaces, [f.workspace]);
  assert.ok(!JSON.stringify(boot).includes('apiKey'));
  const receipt = await submit(f.worker, f.session.id);
  const completed = await until(() => snapshot(f.worker, f.session.id), value => value.runs.some(run => run.id === receipt.runId && isTerminal(run.state)));
  assert.equal(completed.runs[0]?.state, 'completed');
  assert.ok(completed.messages.some(message => message.content.startsWith('Received:')));
  await request(f.worker, 'assertIdle');
});

test('selected remote missing key fails before engine or database creation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-desktop-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let creations = 0;
  const worker = new UtilityWorker({ emit() {}, createEngine: () => { creations++; return fakeEngine(); } });
  for (const providerId of ['openai-compatible', 'openai-responses']) {
    const response = await worker.handle({ id: 'missing-key', type: 'start', payload: { dbPath: join(directory, 'state.sqlite'), artifactDir: join(directory, 'artifacts'), config: { providerId, modelId: 'explicit-model', baseURL: 'https://example.invalid/v1' } } });
    assert.equal(response.ok, false);
    assert.equal(!response.ok && response.error.code, 'API_KEY_MISSING');
  }
  assert.equal(creations, 0);
  await assert.rejects(access(join(directory, 'state.sqlite')));
  await worker.close();
});

test('test scenario forces scripted provider even when a saved remote has no key', async t => {
  const f = await fixture(t);
  await f.worker.close();
  const worker = new UtilityWorker({ emit() {} });
  t.after(() => worker.close());
  const bootstrap = await request<WorkerBootstrap>(worker, 'start', { ...f.start, testScenario: 'slow', config: { providerId: 'openai-responses', modelId: 'saved-model', baseURL: 'https://example.invalid' } });
  assert.equal(bootstrap.capabilities.defaults.providerId, 'scripted');
  assert.equal(bootstrap.capabilities.defaults.modelId, 'desktop-slow-fixture');
  assert.deepEqual(bootstrap.capabilities.providerIds, ['scripted']);
});

test('invalid RPCs, accessors, cycles, depth and oversized requests stay bounded', async () => {
  const worker = new UtilityWorker({ emit() {} });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  let nested: unknown = {}; for (let i = 0; i < 40; i++) nested = { nested };
  let getterCalls = 0;
  const payload = Object.defineProperty({}, 'value', { enumerable: true, get() { getterCalls++; return 'private'; } });
  for (const value of [null, [], { id: 'x', type: 'unknown' }, { id: 'x', type: 'command', payload }, { id: 'x', type: 'command', payload: cycle }, { id: 'x', type: 'command', payload: nested }, { id: 'x', type: 'command', payload: 'a'.repeat(WORKER_LIMITS.maxRequestBytes + 1) }]) {
    const response = await worker.handle(value);
    assert.equal(response.ok, false);
    assert.ok(JSON.stringify(response).length < 3000);
  }
  const huge = await worker.handle({ id: 'bounded-id', type: 'command', payload: 'a'.repeat(WORKER_LIMITS.maxRequestBytes + 1) });
  assert.equal(huge.id, 'bounded-id');
  assert.equal(getterCalls, 0);
  await worker.close();
});

test('provider configuration rejects unknown IDs, malformed URLs and credentials in metadata', async () => {
  const worker = new UtilityWorker({ emit() {} });
  for (const config of [
    { providerId: 'guess-a-transport', modelId: 'model', baseURL: '' },
    { providerId: 'openai-compatible', modelId: 'model', baseURL: 'file:///tmp/nope', apiKey: 'fixture-key' },
    { providerId: 'openai-responses', modelId: 'model', baseURL: 'https://user:password@example.invalid', apiKey: 'fixture-key' },
    { providerId: 'openai-responses', modelId: 'fixture-key', baseURL: 'https://example.invalid', apiKey: 'fixture-key' },
    { providerId: 'codex', modelId: 'model', baseURL: '', apiKey: 'fixture-key' },
  ]) {
    const response = await worker.handle({ id: 'invalid-config', type: 'start', payload: { dbPath: ':memory:', artifactDir: '/tmp/moodcode-unused', config } });
    assert.equal(response.ok, false);
    assert.ok(!JSON.stringify(response).includes('fixture-key'));
  }
  await worker.close();
});

test('selected Codex uses its own credential-free native adapter without calling an account', async () => {
  let selected: string | undefined;
  const worker = new UtilityWorker({ emit() {}, createEngine: options => {
    selected = options.providers?.[0]?.id;
    assert.ok(options.providers?.[0] instanceof CodexProvider);
    assert.equal(options.defaults?.providerId, 'codex');
    assert.equal(options.defaults?.modelId, 'explicit-codex-model');
    return fakeEngine();
  } });
  const response = await worker.handle({ id: 'codex', type: 'start', payload: {
    dbPath: ':memory:', artifactDir: '/tmp/moodcode-unused', config: { providerId: 'codex', modelId: 'explicit-codex-model', baseURL: '' },
  } });
  assert.equal(response.ok, true);
  assert.equal(selected, 'codex');
  await worker.close();
});

test('constructor failure allows another start and does not expose private exception text', async () => {
  let calls = 0;
  const worker = new UtilityWorker({ emit() {}, createEngine: () => { if (++calls === 1) throw new Error('private backend details'); return fakeEngine(); } });
  const payload = { dbPath: ':memory:', artifactDir: '/tmp/moodcode-unused', config: { providerId: 'scripted', modelId: 'echo', baseURL: '' } };
  const failed = await worker.handle({ id: 'first', type: 'start', payload });
  assert.equal(failed.ok, false);
  assert.ok(!JSON.stringify(failed).includes('private backend details'));
  await request(worker, 'start', payload);
  const duplicate = await worker.handle({ id: 'duplicate', type: 'start', payload });
  assert.equal(!duplicate.ok && duplicate.error.code, 'ENGINE_BUSY');
  await worker.close();
});

test('credential strings are redacted from engine errors and nested public results', async () => {
  const key = 'desktop-fixture-private-key';
  let fail = false;
  const worker = new UtilityWorker({ emit() {}, createEngine: () => fakeEngine({
    dispatch: async value => {
      if (fail) throw new EngineError('FIXTURE_FAILURE', `Message with ${key}`);
      return { schemaVersion: 1, commandId: (value as { commandId: string }).commandId, ok: true, result: { nested: [key] } };
    },
  }) });
  const response = await request<WorkerBootstrap>(worker, 'start', { dbPath: ':memory:', artifactDir: '/tmp/moodcode-unused', config: { providerId: 'openai-compatible', modelId: 'remote', baseURL: 'http://127.0.0.1:1/v1', apiKey: key } });
  assert.ok(!JSON.stringify(response).includes(key));
  fail = true;
  const failed = await worker.handle({ id: 'failure', type: 'command', payload: {} });
  assert.equal(!failed.ok && failed.error.message, 'Message with [REDACTED]');
  await worker.close();
});

test('credential-bearing error codes use a generic code and credential JSON keys are redacted', async () => {
  const key = 'UPPERCASEPRIVATEKEY';
  let fail = false;
  const worker = new UtilityWorker({ emit() {}, createEngine: () => fakeEngine({
    dispatch: async value => {
      if (fail) throw new EngineError(`FAILED_${key}`, `Message with ${key}`);
      return { schemaVersion: 1, commandId: (value as { commandId: string }).commandId, ok: true, result: { [key]: key } };
    },
  }) });
  const bootstrap = await request<WorkerBootstrap>(worker, 'start', { dbPath: ':memory:', artifactDir: '/tmp/moodcode-unused', config: {
    providerId: 'openai-compatible', modelId: 'remote', baseURL: 'http://127.0.0.1:1/v1', apiKey: key,
  } });
  assert.ok(!JSON.stringify(bootstrap).includes(key));
  fail = true;
  const failed = await worker.handle({ id: 'failure', type: 'command', payload: {} });
  assert.equal(!failed.ok && failed.error.code, 'INTERNAL_ERROR');
  assert.equal(!failed.ok && failed.error.message, 'Message with [REDACTED]');
  assert.ok(!JSON.stringify(failed).includes(key));
  await worker.close();
});

test('public result copy retains __proto__ as data without changing its prototype', async () => {
  const worker = new UtilityWorker({ emit() {}, createEngine: () => fakeEngine({ dispatch: async () => ({
    schemaVersion: 1, commandId: 'data', ok: true, result: JSON.parse('{"__proto__":{"polluted":true},"normal":"data"}') as JsonObject,
  }) }) });
  await request(worker, 'start', { dbPath: ':memory:', artifactDir: '/tmp/moodcode-unused', config: { providerId: 'scripted', modelId: 'echo', baseURL: '' } });
  const result = await request<CommandResult>(worker, 'command', {});
  const data = result.result as unknown as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(data), null);
  assert.deepEqual(Object.keys(data), ['__proto__', 'normal']);
  assert.equal(Object.hasOwn(data, '__proto__'), true);
  assert.equal(Reflect.get(data, 'polluted'), undefined);
  await worker.close();
});

test('owner reload drops subscriptions while active Run remains cancellable', async t => {
  const f = await fixture(t, 'slow');
  const subscriptionId = await request<string>(f.worker, 'subscribe', { ownerId: 'window-before-reload', sessionId: f.session.id, afterSeq: 0 });
  const receipt = await submit(f.worker, f.session.id);
  await until(() => snapshot(f.worker, f.session.id), value => value.runs[0]?.state === 'running');
  const busy = await f.worker.handle({ id: 'busy', type: 'assertIdle' });
  assert.equal(!busy.ok && busy.error.code, 'WORKSPACE_BUSY');
  const foreign = await f.worker.handle({ id: 'foreign', type: 'unsubscribe', payload: { ownerId: 'different-window', subscriptionId } });
  assert.equal(!foreign.ok && foreign.error.code, 'SUBSCRIPTION_FORBIDDEN');
  await request(f.worker, 'dropOwner', { ownerId: 'window-before-reload' });
  assert.equal(f.worker.subscriptionCount, 0);
  assert.equal((await snapshot(f.worker, f.session.id)).runs[0]?.state, 'running');
  await request(f.worker, 'subscribe', { ownerId: 'window-after-reload', sessionId: f.session.id, afterSeq: 0 });
  await command(f.worker, 'run.cancel', { runId: receipt.runId });
  const final = await until(() => snapshot(f.worker, f.session.id), value => value.runs[0]?.state === 'cancelled');
  await delay(40);
  assert.ok(f.pushes.some(push => push.ownerId === 'window-after-reload' && push.update.lastSeq === final.lastSeq));
  assert.ok(f.pushes.every(push => Object.keys(push.update).every(key => ['subscriptionId', 'sessionId', 'lastSeq', 'error'].includes(key))));
  await request(f.worker, 'assertIdle');
});

test('subscribe validates missing sessions and bad cursors without retaining tasks', async t => {
  const f = await fixture(t);
  for (const payload of [
    { ownerId: 'window', sessionId: 'missing', afterSeq: 0 },
    { ownerId: 'window', sessionId: f.session.id, afterSeq: -1 },
    { ownerId: 'window', sessionId: f.session.id, afterSeq: 0.5 },
  ]) {
    const response = await f.worker.handle({ id: 'invalid-subscribe', type: 'subscribe', payload });
    assert.equal(response.ok, false);
    assert.equal(f.worker.subscriptionCount, 0);
  }
});

test('concurrent subscriptions respect owner cap and unsubscribe is idempotent', async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: WORKER_LIMITS.maxOwnerSubscriptions + 4 }, () => f.worker.handle({ id: randomUUID(), type: 'subscribe', payload: { ownerId: 'window', sessionId: f.session.id, afterSeq: 0 } })));
  assert.equal(responses.filter(response => response.ok).length, WORKER_LIMITS.maxOwnerSubscriptions);
  assert.equal(f.worker.subscriptionCount, WORKER_LIMITS.maxOwnerSubscriptions);
  const successful = responses.find(response => response.ok)!;
  const subscriptionId = (successful as { result: string }).result;
  await request(f.worker, 'unsubscribe', { ownerId: 'window', subscriptionId });
  await request(f.worker, 'unsubscribe', { ownerId: 'window', subscriptionId });
  await request(f.worker, 'dropOwner', { ownerId: 'window' });
  assert.equal(f.worker.subscriptionCount, 0);
});

test('dropOwner also rejects subscriptions whose validation has not finished', async () => {
  const gate = deferred();
  const validationStarted = deferred();
  const worker = new UtilityWorker({ emit() {}, createEngine: () => fakeEngine({ dispatch: async value => {
    const command = value as { type: string; commandId: string };
    if (command.type === 'events.subscribe') { validationStarted.resolve(); await gate.promise; }
    return { schemaVersion: 1, commandId: command.commandId, ok: true, result: {} };
  } }) });
  await request(worker, 'start', { dbPath: ':memory:', artifactDir: '/tmp/moodcode-unused', config: { providerId: 'scripted', modelId: 'echo', baseURL: '' } });
  const pending = worker.handle({ id: 'subscribe', type: 'subscribe', payload: { ownerId: 'reload', sessionId: 'session', afterSeq: 0 } });
  await validationStarted.promise;
  await request(worker, 'dropOwner', { ownerId: 'reload' });
  gate.resolve();
  const response = await pending;
  assert.equal(!response.ok && response.error.code, 'SUBSCRIPTION_DROPPED');
  assert.equal(worker.subscriptionCount, 0);
  await worker.close();
});

test('burst event invalidations are coalesced into a bounded last sequence', async () => {
  const pushes: WorkerPush[] = [];
  const worker = new UtilityWorker({ emit: push => pushes.push(push), createEngine: () => fakeEngine({
    async *subscribe(_sessionId, _afterSeq, signal) {
      for (let seq = 1; seq <= 2000; seq++) yield { seq, sessionId: 'session', payload: { privateTokens: 'must not cross IPC' } } as unknown as EngineEvent;
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
    },
  }) });
  await request(worker, 'start', { dbPath: ':memory:', artifactDir: '/tmp/moodcode-unused', config: { providerId: 'scripted', modelId: 'echo', baseURL: '' } });
  await request(worker, 'subscribe', { ownerId: 'window', sessionId: 'session', afterSeq: 0 });
  await delay(60);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0]?.update.lastSeq, 2000);
  assert.ok(!JSON.stringify(pushes).includes('privateTokens'));
  await worker.close();
  assert.equal(worker.subscriptionCount, 0);
});

test('shutdown drains in-flight dispatch before closing engine and is idempotent', async () => {
  const gate = deferred();
  const started = deferred();
  const order: string[] = [];
  const worker = new UtilityWorker({ emit() {}, createEngine: () => fakeEngine({ dispatch: async value => {
    const command = value as { type: string; commandId: string };
    if (command.type === 'workspace.open') { started.resolve(); await gate.promise; order.push('command-finished'); }
    return { schemaVersion: 1, commandId: command.commandId, ok: true, result: {} };
  }, close: async () => { order.push('engine-closed'); } }) });
  await request(worker, 'start', { dbPath: ':memory:', artifactDir: '/tmp/moodcode-unused', config: { providerId: 'scripted', modelId: 'echo', baseURL: '' } });
  const pending = worker.handle({ id: 'command', type: 'command', payload: { type: 'workspace.open' } });
  await started.promise;
  const closing = worker.close();
  assert.equal(worker.close(), closing);
  assert.deepEqual(order, []);
  const rejected = await worker.handle({ id: 'after-close', type: 'bootstrap' });
  assert.equal(!rejected.ok && rejected.error.code, 'ENGINE_CLOSED');
  gate.resolve();
  await pending; await closing;
  assert.deepEqual(order, ['command-finished', 'engine-closed']);
});

test('command admission is bounded while close still drains pending operations', async () => {
  const gate = deferred();
  let entered = 0;
  let closed = false;
  const worker = new UtilityWorker({ emit() {}, createEngine: () => fakeEngine({
    dispatch: async value => {
      const command = value as { type: string; commandId: string };
      if (command.type === 'hold') { entered++; await gate.promise; }
      return { schemaVersion: 1, commandId: command.commandId, ok: true, result: {} };
    }, close: async () => { closed = true; },
  }) });
  await request(worker, 'start', { dbPath: ':memory:', artifactDir: '/tmp/moodcode-unused', config: { providerId: 'scripted', modelId: 'echo', baseURL: '' } });
  const pending = Array.from({ length: WORKER_LIMITS.maxInflightCommands }, (_, index) => worker.handle({ id: `held-${index}`, type: 'command', payload: { type: 'hold' } }));
  await until(async () => entered, count => count === WORKER_LIMITS.maxInflightCommands);
  const overflow = await worker.handle({ id: 'overflow', type: 'command', payload: { type: 'hold' } });
  assert.equal(!overflow.ok && overflow.error.code, 'ENGINE_BUSY');
  const closing = worker.handle({ id: 'close', type: 'close' });
  assert.equal(closed, false);
  gate.resolve();
  await Promise.all(pending);
  const done = await closing;
  assert.equal(done.ok, true);
  assert.equal(closed, true);
});

test('close expires pending approvals and releases database for a fresh worker', async t => {
  const f = await fixture(t, 'coding');
  await writeFile(join(f.repository, 'math.mjs'), 'export function add(a, b) { return a - b; }\n');
  const receipt = await submit(f.worker, f.session.id);
  await pendingApproval(f.worker, f.session.id, 'apply_patch');
  await request(f.worker, 'subscribe', { ownerId: 'window', sessionId: f.session.id, afterSeq: 0 });
  await request(f.worker, 'close');
  assert.equal(f.worker.subscriptionCount, 0);
  const reopened = new UtilityWorker({ emit() {} });
  t.after(() => reopened.close());
  const { testScenario: _scenario, ...regularStart } = f.start;
  const boot = await request<WorkerBootstrap>(reopened, 'start', regularStart);
  assert.deepEqual(boot.workspaces, [f.workspace]);
  const saved = await snapshot(reopened, f.session.id);
  assert.equal(saved.runs.find(run => run.id === receipt.runId)?.state, 'cancelled');
  assert.ok(saved.approvals.every(approval => approval.status === 'expired'));
  assert.equal(await readFile(join(f.repository, 'math.mjs'), 'utf8'), 'export function add(a, b) { return a - b; }\n');
});

test('coding fixture reads real hash, waits for both approvals, runs node --test and persists diff', { timeout: 30_000 }, async t => {
  allowNestedTestCommand(t);
  const f = await fixture(t, 'coding');
  const before = 'export function add(a, b) { return a - b; }\n';
  const after = 'export function add(a, b) { return a + b; }\n';
  await writeFile(join(f.repository, 'math.mjs'), before);
  await writeFile(join(f.repository, 'math.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from './math.mjs'; test('adds', () => assert.equal(add(2, 3), 5));\n");
  const receipt = await submit(f.worker, f.session.id);
  const patch = await pendingApproval(f.worker, f.session.id, 'apply_patch');
  assert.equal(await readFile(join(f.repository, 'math.mjs'), 'utf8'), before);
  const pending = await snapshot(f.worker, f.session.id);
  const patchInput = pending.tools.find(tool => tool.name === 'apply_patch')!.input as { changes: { expectedHash: string }[] };
  assert.equal(patchInput.changes[0]?.expectedHash, createHash('sha256').update(before).digest('hex'));
  const stale = await request<CommandResult>(f.worker, 'command', { schemaVersion: 1, commandId: 'stale', type: 'approval.decide', payload: { approvalId: patch.id, decision: 'allow', fingerprint: 'wrong-fingerprint' } });
  assert.equal(stale.ok, false);
  assert.equal(await readFile(join(f.repository, 'math.mjs'), 'utf8'), before);
  await command(f.worker, 'approval.decide', { approvalId: patch.id, decision: 'allow', fingerprint: patch.fingerprint });
  const processApproval = await pendingApproval(f.worker, f.session.id, 'run_command');
  assert.equal(processApproval.preview.command, 'node --test');
  assert.equal(await readFile(join(f.repository, 'math.mjs'), 'utf8'), after);
  assert.equal((await snapshot(f.worker, f.session.id)).tools.find(tool => tool.name === 'run_command')?.state, 'awaiting_approval');
  await command(f.worker, 'approval.decide', { approvalId: processApproval.id, decision: 'allow', fingerprint: processApproval.fingerprint });
  const completed = await until(() => snapshot(f.worker, f.session.id), value => value.runs.some(run => run.id === receipt.runId && isTerminal(run.state)), 20_000);
  assert.equal(completed.runs[0]?.state, 'completed', JSON.stringify(completed));
  assert.ok(completed.tools.every(tool => tool.state === 'completed'));
  assert.ok(completed.tools.find(tool => tool.name === 'run_command')?.output?.includes('adds'));
  assert.ok(completed.messages.some(message => message.role === 'assistant' && message.content.includes('verified')));
  const diff = await command<{ files: { path: string; before: string; after: string }[]; checkpoints: { kind: string; incomplete?: boolean }[] }>(f.worker, 'review.getDiff', { runId: receipt.runId });
  const file = diff.files.find(file => file.path === 'math.mjs');
  assert.equal(file?.before, before);
  assert.equal(file?.after, after);
  assert.ok(diff.checkpoints.some(checkpoint => checkpoint.kind === 'command' && !checkpoint.incomplete));
});

test('denied patch stops fixture before command and leaves original file intact', async t => {
  const f = await fixture(t, 'coding');
  const before = 'export const add = (a, b) => a - b;\n';
  await writeFile(join(f.repository, 'math.mjs'), before);
  const receipt = await submit(f.worker, f.session.id);
  const patch = await pendingApproval(f.worker, f.session.id, 'apply_patch');
  await command(f.worker, 'approval.decide', { approvalId: patch.id, decision: 'deny', fingerprint: patch.fingerprint });
  const final = await until(() => snapshot(f.worker, f.session.id), value => value.runs.some(run => run.id === receipt.runId && isTerminal(run.state)));
  assert.equal(final.runs[0]?.state, 'failed');
  assert.ok(final.tools.every(tool => tool.name !== 'run_command'));
  assert.equal(await readFile(join(f.repository, 'math.mjs'), 'utf8'), before);
});

test('file edit after preview fails the guarded patch without overwriting user content', async t => {
  const f = await fixture(t, 'coding');
  await writeFile(join(f.repository, 'math.mjs'), 'export const add = (a, b) => a - b;\n');
  const receipt = await submit(f.worker, f.session.id);
  const patch = await pendingApproval(f.worker, f.session.id, 'apply_patch');
  const edited = 'export const add = (a, b) => a - b; // user draft\n';
  await writeFile(join(f.repository, 'math.mjs'), edited);
  await command(f.worker, 'approval.decide', { approvalId: patch.id, decision: 'allow', fingerprint: patch.fingerprint });
  const final = await until(() => snapshot(f.worker, f.session.id), value => value.runs.some(run => run.id === receipt.runId && isTerminal(run.state)));
  assert.equal(final.runs[0]?.state, 'failed');
  assert.ok(final.tools.some(tool => tool.name === 'apply_patch' && tool.state === 'failed'));
  assert.ok(final.tools.every(tool => tool.name !== 'run_command'));
  assert.equal(await readFile(join(f.repository, 'math.mjs'), 'utf8'), edited);
});

test('close awaits cleanup of an approved running process before releasing database', { timeout: 20_000 }, async t => {
  allowNestedTestCommand(t);
  const f = await fixture(t, 'coding');
  await writeFile(join(f.repository, 'math.mjs'), 'export const add = (a, b) => a - b;\n');
  await writeFile(join(f.repository, 'math.test.mjs'), "import test from 'node:test'; import { writeFileSync } from 'node:fs'; import { setTimeout } from 'node:timers/promises'; test('slow cleanup fixture', async () => { writeFileSync('command-pid.txt', String(process.pid)); await setTimeout(60000); });\n");
  const receipt = await submit(f.worker, f.session.id);
  const patch = await pendingApproval(f.worker, f.session.id, 'apply_patch');
  await command(f.worker, 'approval.decide', { approvalId: patch.id, decision: 'allow', fingerprint: patch.fingerprint });
  const processApproval = await pendingApproval(f.worker, f.session.id, 'run_command');
  await command(f.worker, 'approval.decide', { approvalId: processApproval.id, decision: 'allow', fingerprint: processApproval.fingerprint });
  const pidText = await until(async () => {
    const current = await snapshot(f.worker, f.session.id);
    if (current.runs[0] && isTerminal(current.runs[0].state)) throw new Error(JSON.stringify(current.tools.find(tool => tool.name === 'run_command')));
    try { return await readFile(join(f.repository, 'command-pid.txt'), 'utf8'); } catch { return ''; }
  }, value => /^\d+$/.test(value));
  const pid = Number(pidText);
  process.kill(pid, 0);
  const started = Date.now();
  await request(f.worker, 'close');
  assert.ok(Date.now() - started < 5000, 'close must stop the test process rather than wait for its 60 second timer');
  assert.throws(() => process.kill(pid, 0), (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === 'ESRCH');
  const reopened = new UtilityWorker({ emit() {} });
  t.after(() => reopened.close());
  const { testScenario: _scenario, ...regularStart } = f.start;
  await request(reopened, 'start', regularStart);
  const final = await snapshot(reopened, f.session.id);
  assert.equal(final.runs.find(run => run.id === receipt.runId)?.state, 'cancelled');
  assert.ok(final.tools.some(tool => tool.name === 'run_command' && tool.state === 'interrupted'));
  const diff = await command<{ checkpoints: { kind: string }[] }>(reopened, 'review.getDiff', { runId: receipt.runId });
  assert.ok(diff.checkpoints.some(checkpoint => checkpoint.kind === 'command'));
});

test('failed fixture test never claims verification even after both approvals', { timeout: 20_000 }, async t => {
  allowNestedTestCommand(t);
  const f = await fixture(t, 'coding');
  await writeFile(join(f.repository, 'math.mjs'), 'export const add = (a, b) => a - b;\n');
  await writeFile(join(f.repository, 'math.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('fails intentionally', () => assert.equal(1, 2));\n");
  const receipt = await submit(f.worker, f.session.id);
  const patch = await pendingApproval(f.worker, f.session.id, 'apply_patch');
  await command(f.worker, 'approval.decide', { approvalId: patch.id, decision: 'allow', fingerprint: patch.fingerprint });
  const processApproval = await pendingApproval(f.worker, f.session.id, 'run_command');
  await command(f.worker, 'approval.decide', { approvalId: processApproval.id, decision: 'allow', fingerprint: processApproval.fingerprint });
  const final = await until(() => snapshot(f.worker, f.session.id), value => value.runs.some(run => run.id === receipt.runId && isTerminal(run.state)));
  assert.equal(final.runs[0]?.state, 'failed');
  assert.ok(final.tools.some(tool => tool.name === 'run_command' && tool.state === 'failed' && tool.output?.includes('fails intentionally')));
  assert.ok(final.messages.every(message => !message.content.includes('verified the change')));
});
