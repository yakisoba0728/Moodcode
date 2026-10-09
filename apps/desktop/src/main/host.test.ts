import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { DEFAULT_LIMITS, type CommandEnvelope, type EngineCapabilities } from '@moodcode/contracts';
import type { DesktopSettings, DesktopUpdate, HostStatus, SaveDesktopSettings } from '../shared/protocol.js';
import type { WorkerRequest, WorkerResponse, WorkerStartPayload } from '../worker/protocol.js';
import { DesktopHost, HostError, UTILITY_CLOSE_DIAGNOSTIC_LIMIT, type HostSettingsStore, type UtilityTransport, type UtilityCloseDiagnostics } from './host.js';
import type { PreparedSettings, ResolvedDesktopSettings } from './settings.js';

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const local: SaveDesktopSettings = { providerId: 'scripted', modelId: 'local', baseURL: '' };
const remote: SaveDesktopSettings = {
  providerId: 'openai-compatible', modelId: 'fixture-model', baseURL: 'http://127.0.0.1:3000/v1', apiKey: 'fixture-private-key',
};
function resolved(input: SaveDesktopSettings): ResolvedDesktopSettings {
  const { providerId, modelId, baseURL, apiKey } = input;
  const view: DesktopSettings = {
    providerId, modelId, baseURL, keyConfigured: !!apiKey, keySource: apiKey ? 'stored' : 'none', credentialStorage: 'available',
  };
  const result = { view } as ResolvedDesktopSettings;
  Object.defineProperty(result, 'engineConfig', {
    value: { providerId, modelId, baseURL, ...(apiKey ? { apiKey } : {}) }, enumerable: false,
  });
  return result;
}
class FakeSettings implements HostSettingsStore {
  current: ResolvedDesktopSettings;
  loadCalls = 0;
  prepareCalls = 0;
  commitCalls = 0;
  loadHook?: () => Promise<ResolvedDesktopSettings>;
  prepareHook?: (input: SaveDesktopSettings) => Promise<PreparedSettings>;
  commitHook?: (input: PreparedSettings) => Promise<ResolvedDesktopSettings>;
  constructor(readonly trace: string[], input: SaveDesktopSettings = local) { this.current = resolved(input); }
  getView(): DesktopSettings { return { ...this.current.view }; }
  async load(): Promise<ResolvedDesktopSettings> {
    this.trace.push('settings.load'); this.loadCalls += 1;
    return this.loadHook ? this.loadHook() : this.current;
  }
  async prepare(input: SaveDesktopSettings): Promise<PreparedSettings> {
    this.trace.push('settings.prepare'); this.prepareCalls += 1;
    return this.prepareHook ? this.prepareHook(input) : resolved(input);
  }
  async commit(input: PreparedSettings): Promise<ResolvedDesktopSettings> {
    this.trace.push('settings.commit'); this.commitCalls += 1;
    const committed = this.commitHook ? await this.commitHook(input) : input;
    this.current = committed;
    return committed;
  }
}

const capabilities: EngineCapabilities = {
  schemaVersion: 1,
  runtime: { node: '24-fixture', electron: '44-fixture', platform: 'darwin', commandExecution: 'posix-process-group' },
  providerIds: ['scripted'], tools: [], modes: ['plan', 'build'],
  defaults: { providerId: 'scripted', modelId: 'local', mode: 'plan', limits: { ...DEFAULT_LIMITS } },
};

class FakeUtility implements UtilityTransport {
  readonly messages: WorkerRequest[] = [];
  readonly outstanding = new Map<string, WorkerRequest>();
  readonly messageListeners = new Set<(message: unknown) => void>();
  readonly exitListeners = new Set<(code: number) => void>();
  readonly held = new Set<WorkerRequest['type']>();
  onRequest?: (request: WorkerRequest, utility: FakeUtility) => boolean;
  sendFailure?: Error;
  autoExit = true;
  constructor(readonly index: number, readonly trace: string[]) {}
  postMessage(message: WorkerRequest): void {
    if (this.sendFailure) throw this.sendFailure;
    this.messages.push(message);
    this.outstanding.set(message.id, message);
    this.trace.push(`worker${this.index}.${message.type}`);
    if (this.held.has(message.type) || this.onRequest?.(message, this)) return;
    queueMicrotask(() => this.success(message));
  }
  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => { this.messageListeners.delete(listener); };
  }
  onExit(listener: (code: number) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }
  defaultResult(message: WorkerRequest): unknown {
    if (message.type === 'bootstrap') return { workspaces: [], capabilities };
    if (message.type === 'subscribe') return `subscription-${this.index}`;
    if (message.type === 'command') {
      const command = message.payload as CommandEnvelope;
      return { schemaVersion: 1, commandId: command.commandId, ok: true, result: { fixture: true } };
    }
    return undefined;
  }
  success(message: WorkerRequest, result: unknown = this.defaultResult(message)): void {
    this.outstanding.delete(message.id);
    this.trace.push(`worker${this.index}.${message.type}.confirmed`);
    this.emit({ id: message.id, ok: true, result } satisfies WorkerResponse);
    if (message.type === 'close' && this.autoExit) queueMicrotask(() => this.exit(0));
  }
  failure(message: WorkerRequest, code: string, text: string): void {
    this.outstanding.delete(message.id);
    this.emit({ id: message.id, ok: false, error: { code, message: text } } satisfies WorkerResponse);
  }
  emit(message: unknown): void { for (const listener of [...this.messageListeners]) listener(message); }
  exit(code = 1): void { for (const listener of [...this.exitListeners]) listener(code); }
  requests(type: WorkerRequest['type']): WorkerRequest[] { return this.messages.filter(message => message.type === type); }
  release(type: WorkerRequest['type']): void {
    this.held.delete(type);
    for (const message of [...this.outstanding.values()]) if (message.type === type) this.success(message);
  }
  settleAll(): void {
    this.held.clear(); this.onRequest = undefined; this.sendFailure = undefined;
    for (const request of [...this.outstanding.values()]) this.success(request);
  }
}

async function until(predicate: () => boolean, message = 'expected asynchronous operation'): Promise<void> {
  for (let count = 0; count < 100; count++) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail(message);
}
function errorCode(expected: string, secret?: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof HostError);
    assert.equal(error.code, expected);
    if (secret) assert.ok(!`${error.message}${JSON.stringify(error)}`.includes(secret));
    return true;
  };
}
let commandNumber = 0;
function command(): CommandEnvelope {
  return { schemaVersion: 1, commandId: `fixture-${++commandNumber}`, type: 'session.getSnapshot', payload: { sessionId: 'session-fixture' } };
}
test('an explicit fixture launch starts and retries without saved real-provider credentials', async t => {
  const { host, settings, workers } = setup(t, { testScenario: 'slow', settingsInput: remote });
  settings.loadHook = async () => { throw new HostError('SETTINGS_KEY_REQUIRED', 'The saved provider requires its key.'); };
  assert.equal((await host.initialize()).state, 'ready');
  const started = workers[0]!.requests('start')[0]!.payload as WorkerStartPayload;
  assert.deepEqual(started.config, { providerId: 'scripted', modelId: 'desktop-slow-fixture', baseURL: '' });
  assert.equal((await host.retryEngine()).state, 'ready');
  assert.equal(workers.length, 2);
  assert.equal(host.getSettings().keyConfigured, false);
});
test('ordinary startup preserves a missing selected-provider credential failure', async t => {
  const { host, settings, workers } = setup(t, { settingsInput: remote });
  settings.loadHook = async () => { throw new HostError('SETTINGS_KEY_REQUIRED', 'The saved provider requires its key.'); };
  const status = await host.initialize();
  assert.equal(status.state, 'failed');
  assert.equal(status.error?.code, 'SETTINGS_KEY_REQUIRED');
  assert.equal(workers.length, 0);
});
test('a fixture override does not hide corrupted settings files', async t => {
  const { host, settings, workers } = setup(t, { testScenario: 'coding' });
  settings.loadHook = async () => { throw new HostError('SETTINGS_JSON', 'The settings file is invalid.'); };
  assert.equal((await host.initialize()).error?.code, 'SETTINGS_JSON');
  assert.equal(workers.length, 0);
});
function setup(t: TestContext, input: {
  settingsInput?: SaveDesktopSettings;
  configureWorker?: (worker: FakeUtility) => void;
  testScenario?: 'coding' | 'slow' | 'account';
  rpcTimeoutMs?: number;
  closeTimeoutMs?: number;
  utilityExitTimeoutMs?: number;
  onUtilityClose?: (diagnostics: UtilityCloseDiagnostics) => void;
  spawnFailure?: Error;
} = {}) {
  const trace: string[] = [];
  const workers: FakeUtility[] = [];
  const statuses: HostStatus[] = [];
  const updates: Array<{ ownerId: string; update: DesktopUpdate }> = [];
  const settings = new FakeSettings(trace, input.settingsInput);
  const host = new DesktopHost({
    settings, dbPath: '/fixture/engine.sqlite', artifactDir: '/fixture/artifacts', platform: 'darwin', version: 'fixture-version',
    ...(input.testScenario ? { testScenario: input.testScenario } : {}),
    rpcTimeoutMs: input.rpcTimeoutMs ?? 1_000, closeTimeoutMs: input.closeTimeoutMs ?? 500, utilityExitTimeoutMs: input.utilityExitTimeoutMs ?? 100,
    onUtilityClose: input.onUtilityClose,
    spawn: () => {
      if (input.spawnFailure) throw input.spawnFailure;
      trace.push(`worker${workers.length}.spawn`);
      const worker = new FakeUtility(workers.length, trace);
      workers.push(worker); input.configureWorker?.(worker);
      return worker;
    },
    onStatus: status => { statuses.push(status); },
    onUpdate: (ownerId, update) => { updates.push({ ownerId, update }); },
  });
  t.after(async () => {
    for (const worker of workers) { worker.autoExit = true; worker.settleAll(); worker.exit(0); }
    await host.close().catch(() => undefined);
  });
  return { host, settings, workers, trace, statuses, updates };
}

test('account rotation closes the old bearer before authenticating and gates all admissions until fresh startup', async t => {
  const f = setup(t, { settingsInput: remote });
  await f.host.initialize();
  const auth = gate<void>(); let entered = false;
  const rotating = f.host.accountTransition(async () => {
    entered = true; assert.equal(f.workers[0]!.requests('close').length, 1);
    await auth.promise;
    f.settings.current = resolved({ ...remote, apiKey: 'fixture-rotated-key' });
    return 'rotated';
  });
  await until(() => entered);
  assert.throws(() => f.host.command(command()), errorCode('ENGINE_BUSY'));
  assert.throws(() => f.host.advanced('window', { sessionId: 'session', type: 'session.pause' }), errorCode('ENGINE_BUSY'));
  auth.resolve(); assert.equal(await rotating, 'rotated');
  assert.equal(f.workers.length, 2);
  const started = f.workers[1]!.requests('start')[0]!.payload as WorkerStartPayload;
  assert.equal(started.config.apiKey, 'fixture-rotated-key');
  assert.ok(!JSON.stringify(await f.host.getBootstrap()).includes('fixture-rotated-key'));
});

test('account GUI fixtures preserve an explicit credential failure instead of hiding it with scripted settings', async t => {
  const f = setup(t, { testScenario: 'account', settingsInput: remote });
  f.settings.loadHook = async () => { throw new HostError('SETTINGS_KEY_REQUIRED', 'The selected account is signed out.'); };
  assert.equal((await f.host.initialize()).state, 'failed');
  assert.equal(f.host.getSettings().providerId, 'openai-compatible');
  assert.equal(f.workers.length, 0);
});

test('a reload while account idle validation waits cannot start a stale authentication operation', async t => {
  const f = setup(t); await f.host.initialize();
  f.workers[0]!.held.add('assertIdle'); let current = true, entered = false;
  const pending = f.host.accountTransition(async () => { entered = true; }, () => { if (!current) throw new HostError('WINDOW_RELOADED', 'Window changed.'); });
  const rejected = assert.rejects(pending, errorCode('WINDOW_RELOADED'));
  await until(() => f.workers[0]!.requests('assertIdle').length === 1);
  current = false; f.workers[0]!.settleAll(); await rejected;
  assert.equal(entered, false); assert.equal(f.workers[0]!.requests('close').length, 0);
  assert.equal(f.host.getStatus().state, 'ready');
});

test('initialization sends private config to utility but bootstrap/settings return metadata only', async (t) => {
  const { host, workers } = setup(t, { settingsInput: remote });
  assert.equal((await host.initialize()).state, 'ready');
  const payload = workers[0]!.requests('start')[0]!.payload as WorkerStartPayload;
  assert.equal(payload.config.apiKey, remote.apiKey);
  const bootstrap = await host.getBootstrap();
  assert.equal(bootstrap.settings.keyConfigured, true);
  assert.equal(bootstrap.settings.keySource, 'stored');
  assert.deepEqual(bootstrap.workspaces, []);
  assert.deepEqual(bootstrap.capabilities, capabilities);
  assert.ok(!JSON.stringify(bootstrap).includes(remote.apiKey!));
  assert.ok(!JSON.stringify(host.getStatus()).includes(remote.apiKey!));
});

test('settings save rejected by active Run does not close, spawn, or commit', async (t) => {
  const { host, workers, settings } = setup(t);
  await host.initialize();
  workers[0]!.onRequest = (request, worker) => {
    if (request.type !== 'assertIdle') return false;
    queueMicrotask(() => worker.failure(request, 'WORKSPACE_BUSY', 'A Run is active.')); return true;
  };
  await assert.rejects(host.saveSettings(remote), errorCode('WORKSPACE_BUSY'));
  assert.equal(workers.length, 1);
  assert.equal(workers[0]!.requests('close').length, 0);
  assert.equal(settings.commitCalls, 0);
  assert.equal(host.getStatus().state, 'ready');
  assert.equal(host.getSettings().providerId, 'scripted');
  assert.equal((await host.command(command())).ok, true);
});

test('save synchronously gates new commands before asynchronous preparation or assertIdle', async (t) => {
  const { host, settings, workers } = setup(t);
  await host.initialize();
  const prepare = gate<PreparedSettings>();
  t.after(() => { prepare.resolve(resolved(remote)); });
  settings.prepareHook = () => prepare.promise;
  const saving = host.saveSettings(remote);
  assert.throws(() => host.command(command()), errorCode('ENGINE_BUSY'));
  assert.throws(() => host.subscribe('owner', 'session', 0), errorCode('ENGINE_BUSY'));
  await assert.rejects(host.saveSettings(local), errorCode('ENGINE_BUSY'));
  assert.equal(workers[0]!.requests('assertIdle').length, 0);
  prepare.resolve(resolved(remote));
  await saving;
  assert.equal(settings.commitCalls, 1);
});

test('save drains an admitted command before asking the worker whether Runs are idle', async (t) => {
  const { host, settings, workers, trace } = setup(t);
  await host.initialize();
  workers[0]!.held.add('command');
  const runningCommand = host.command(command());
  const saving = host.saveSettings(remote);
  await nextTurn();
  assert.equal(workers[0]!.requests('assertIdle').length, 0);
  workers[0]!.release('command');
  await runningCommand;
  await saving;
  assert.ok(trace.indexOf('worker0.command.confirmed') < trace.indexOf('worker0.assertIdle'));
  assert.equal(settings.commitCalls, 1);
});

test('save confirms the old close before spawning and commits only after the new start confirms', async (t) => {
  const { host, workers, settings, trace } = setup(t, { configureWorker(worker) {
    if (worker.index === 0) worker.held.add('close');
    if (worker.index === 1) worker.held.add('start');
  } });
  await host.initialize();
  const saving = host.saveSettings(remote);
  await until(() => workers[0]!.requests('close').length === 1);
  assert.equal(workers.length, 1);
  assert.equal(settings.commitCalls, 0);
  workers[0]!.release('close');
  await until(() => workers.length === 2 && workers[1]!.requests('start').length === 1);
  assert.equal(settings.commitCalls, 0);
  assert.equal(host.getStatus().state, 'starting');
  workers[1]!.release('start');
  await saving;
  assert.ok(trace.indexOf('worker0.close.confirmed') < trace.indexOf('worker1.spawn'));
  assert.ok(trace.indexOf('worker1.start.confirmed') < trace.indexOf('settings.commit'));
  assert.equal(host.getStatus().state, 'ready');
  assert.equal(host.getStatus().generation, 2);
});

test('a failed new start closes its partial engine, retains old settings and recovers by retry', async (t) => {
  const { host, workers, settings, trace } = setup(t, { configureWorker(worker) {
    if (worker.index !== 1) return;
    worker.onRequest = (request, utility) => {
      if (request.type !== 'start') return false;
      queueMicrotask(() => utility.failure(request, 'PROVIDER_FAILED', `fixture error ${remote.apiKey}`)); return true;
    };
  } });
  await host.initialize();
  await assert.rejects(host.saveSettings(remote), errorCode('SETTINGS_ENGINE_START_FAILED', remote.apiKey));
  assert.equal(settings.commitCalls, 0);
  assert.equal(host.getStatus().state, 'failed');
  assert.equal(host.getSettings().providerId, 'scripted');
  assert.equal(workers[1]!.requests('close').length, 1);
  assert.equal((await host.retryEngine()).state, 'ready');
  assert.equal(workers.length, 3);
  assert.equal(host.getStatus().generation, 3);
  assert.equal((workers[2]!.requests('start')[0]!.payload as WorkerStartPayload).config.providerId, 'scripted');
  assert.ok(trace.indexOf('worker1.close.confirmed') < trace.indexOf('worker2.spawn'));
});

test('commit failure closes the new engine and leaves persisted settings available to retry', async (t) => {
  const { host, workers, settings } = setup(t);
  await host.initialize();
  settings.commitHook = async () => { throw new Error(`fixture save failure ${remote.apiKey}`); };
  await assert.rejects(host.saveSettings(remote), errorCode('SETTINGS_COMMIT_FAILED', remote.apiKey));
  assert.equal(workers[1]!.requests('close').length, 1);
  assert.equal(host.getStatus().state, 'failed');
  assert.equal(host.getSettings().providerId, 'scripted');
  settings.commitHook = undefined;
  assert.equal((await host.retryEngine()).state, 'ready');
});

test('commit failure with unconfirmed cleanup has a distinct stage and retry awaits cleanup before reopening', async (t) => {
  let allowClose = false;
  const { host, workers, settings, trace } = setup(t, { configureWorker(worker) {
    if (worker.index !== 1) return;
    worker.onRequest = (request, utility) => {
      if (request.type !== 'close' || allowClose) return false;
      queueMicrotask(() => utility.failure(request, 'CLOSE_FAILED', 'fixture cleanup failure')); return true;
    };
  } });
  await host.initialize();
  settings.commitHook = async () => { throw new Error('fixture persistence failure'); };
  await assert.rejects(host.saveSettings(remote), errorCode('SETTINGS_COMMIT_CLEANUP_FAILED'));
  assert.equal(host.getStatus().state, 'failed');
  assert.equal(host.getStatus().error?.code, 'SETTINGS_COMMIT_CLEANUP_FAILED');
  assert.equal(host.getSettings().providerId, 'scripted');
  assert.equal(workers.length, 2);
  settings.commitHook = undefined;
  allowClose = true;
  workers[1]!.held.add('close');
  const retrying = host.retryEngine();
  await until(() => workers[1]!.requests('close').length === 2);
  assert.equal(workers.length, 2);
  workers[1]!.release('close');
  assert.equal((await retrying).state, 'ready');
  assert.equal(workers.length, 3);
  assert.ok(trace.indexOf('worker1.close.confirmed') < trace.indexOf('worker2.spawn'));
  assert.equal((workers[2]!.requests('start')[0]!.payload as WorkerStartPayload).config.providerId, 'scripted');
});

test('worker exit rejects pending calls, detaches listeners and retry ignores old traffic', async (t) => {
  const { host, workers, updates } = setup(t);
  await host.initialize();
  const old = workers[0]!;
  old.held.add('command');
  const pending = host.command(command());
  const rejection = assert.rejects(pending, errorCode('HOST_WORKER_EXITED'));
  old.exit(23);
  await rejection;
  assert.equal(host.getStatus().state, 'failed');
  assert.equal(old.messageListeners.size + old.exitListeners.size, 0);
  assert.equal((await host.retryEngine()).state, 'ready');
  old.emit({ type: 'update', ownerId: 'old', update: { subscriptionId: 'old-sub', sessionId: 'session', lastSeq: 99 } });
  old.release('command');
  assert.equal(updates.length, 0);
  assert.equal(old.requests('close').length, 0);
  assert.equal(host.getStatus().generation, 2);
});

test('close waits for engine confirmation, rejects new calls and returns one idempotent promise', async (t) => {
  const { host, workers } = setup(t);
  await host.initialize();
  workers[0]!.held.add('close');
  const closing = host.close();
  assert.equal(host.close(), closing);
  assert.throws(() => host.command(command()), errorCode('ENGINE_CLOSED'));
  let settled = false;
  void closing.then(() => { settled = true; });
  await until(() => workers[0]!.requests('close').length === 1);
  assert.equal(settled, false);
  assert.notEqual(host.getStatus().state, 'stopped');
  workers[0]!.release('close');
  await closing;
  assert.equal(host.getStatus().state, 'stopped');
  assert.equal(workers[0]!.requests('close').length, 1);
});

test('shutdown drains an already admitted command before sending engine.close', async (t) => {
  const { host, workers, trace } = setup(t);
  await host.initialize();
  workers[0]!.held.add('command');
  const admitted = host.command(command());
  const closing = host.close();
  await nextTurn();
  assert.equal(workers[0]!.requests('close').length, 0);
  workers[0]!.release('command');
  await admitted;
  await closing;
  assert.ok(trace.indexOf('worker0.command.confirmed') < trace.indexOf('worker0.close'));
  assert.equal(host.getStatus().state, 'stopped');
});

test('shutdown during settings preparation prevents replacement startup or commit', async (t) => {
  const { host, settings, workers } = setup(t);
  await host.initialize();
  const prepare = gate<PreparedSettings>();
  t.after(() => { prepare.resolve(resolved(remote)); });
  settings.prepareHook = () => prepare.promise;
  const saving = host.saveSettings(remote);
  const rejection = assert.rejects(saving, errorCode('ENGINE_CLOSED'));
  const closing = host.close();
  prepare.resolve(resolved(remote));
  await rejection;
  await closing;
  assert.equal(workers.length, 1);
  assert.equal(settings.commitCalls, 0);
  assert.equal(workers[0]!.requests('close').length, 1);
  assert.equal(host.getStatus().state, 'stopped');
});

test('shutdown during replacement start closes that engine and never commits it', async (t) => {
  const { host, settings, workers, statuses } = setup(t, { configureWorker(worker) {
    if (worker.index === 1) worker.held.add('start');
  } });
  await host.initialize();
  const saving = host.saveSettings(remote);
  const rejection = assert.rejects(saving, errorCode('SETTINGS_ENGINE_START_FAILED'));
  await until(() => workers.length === 2 && workers[1]!.requests('start').length === 1);
  const readyBefore = statuses.filter(status => status.state === 'ready').length;
  const closing = host.close();
  workers[1]!.release('start');
  await rejection;
  await closing;
  assert.equal(workers[1]!.requests('close').length, 1);
  assert.equal(settings.commitCalls, 0);
  assert.equal(workers.length, 2);
  assert.equal(statuses.filter(status => status.state === 'ready').length, readyBefore);
  assert.equal(host.getStatus().state, 'stopped');
});

test('shutdown while initial settings load is pending prevents any utility from starting', async (t) => {
  const { host, settings, workers } = setup(t);
  const loading = gate<ResolvedDesktopSettings>();
  t.after(() => { loading.resolve(resolved(local)); });
  settings.loadHook = () => loading.promise;
  const initializing = host.initialize();
  const closing = host.close();
  loading.resolve(resolved(local));
  await initializing;
  await closing;
  assert.equal(workers.length, 0);
  assert.equal(host.getStatus().state, 'stopped');
});

test('subscription APIs forward owner identity and unmount removes subscriptions without cancelling a Run', async (t) => {
  const { host, workers, updates } = setup(t);
  await host.initialize();
  const id = await host.subscribe('window-main', 'session-fixture', 17);
  assert.equal(id, 'subscription-0');
  assert.deepEqual(workers[0]!.requests('subscribe')[0]!.payload, { ownerId: 'window-main', sessionId: 'session-fixture', afterSeq: 17 });
  const update = { subscriptionId: id, sessionId: 'session-fixture', lastSeq: 25 };
  workers[0]!.emit({ type: 'update', ownerId: 'window-main', update });
  assert.deepEqual(updates, [{ ownerId: 'window-main', update }]);
  await host.unsubscribe('window-main', id);
  await host.dropOwner('window-main');
  assert.deepEqual(workers[0]!.requests('unsubscribe')[0]!.payload, { ownerId: 'window-main', subscriptionId: id });
  assert.deepEqual(workers[0]!.requests('dropOwner')[0]!.payload, { ownerId: 'window-main' });
  assert.equal(workers[0]!.requests('command').length, 0);
  assert.equal(workers[0]!.requests('close').length, 0);
});

test('host RPC queue admits at most 128 requests and recovers after capacity drains', async (t) => {
  const { host, workers } = setup(t);
  await host.initialize();
  workers[0]!.held.add('command');
  const admitted = Array.from({ length: 128 }, () => host.command(command()));
  await assert.rejects(host.command(command()), errorCode('HOST_BACKPRESSURE'));
  assert.equal(workers[0]!.requests('command').length, 128);
  workers[0]!.release('command');
  assert.equal((await Promise.all(admitted)).length, 128);
  assert.equal((await host.command(command())).ok, true);
});

test('RPC timeout removes its pending entry and late responses do not affect a later request', async (t) => {
  const { host, workers } = setup(t, { rpcTimeoutMs: 20 });
  await host.initialize();
  const worker = workers[0]!;
  worker.held.add('command');
  const timedOut = host.command(command());
  const old = worker.requests('command')[0]!;
  await assert.rejects(timedOut, errorCode('HOST_RPC_TIMEOUT'));
  const fresh = host.command(command());
  const current = worker.requests('command')[1]!;
  worker.success(old, { schemaVersion: 1, commandId: 'late-fixture', ok: true });
  worker.success(current);
  assert.equal((await fresh).commandId, (current.payload as CommandEnvelope).commandId);
  assert.equal(host.getStatus().state, 'ready');
  worker.held.delete('command');
});

test('worker errors and subscription failures redact configured keys and bound error messages', async (t) => {
  const { host, workers, updates } = setup(t, { settingsInput: remote });
  await host.initialize();
  const worker = workers[0]!;
  worker.onRequest = (request, utility) => {
    if (request.type !== 'command') return false;
    queueMicrotask(() => utility.failure(request, 'INVALID_fixture-private-key', `failure ${remote.apiKey} ${'x'.repeat(2_000)}`));
    return true;
  };
  await assert.rejects(host.command(command()), errorCode('HOST_RPC_FAILED', remote.apiKey));
  worker.emit({ type: 'update', ownerId: 'owner', update: {
    subscriptionId: 'subscription', sessionId: 'session', lastSeq: 1,
    error: { code: 'PROVIDER_FAILED', message: `${remote.apiKey}${'x'.repeat(2_000)}` },
  } });
  assert.equal(updates.length, 1);
  assert.ok(!JSON.stringify(updates).includes(remote.apiKey!));
  assert.equal(updates[0]!.update.error!.message.length, 1_024);
});

test('malformed and oversized update pushes are ignored while valid pushes remain bounded', async (t) => {
  const { host, workers, updates } = setup(t);
  await host.initialize();
  const normal = { type: 'update', ownerId: 'owner', update: { subscriptionId: 'subscription', sessionId: 'session', lastSeq: 1 } };
  const worker = workers[0]!;
  for (const message of [
    null, [], {}, { ...normal, ownerId: 'x'.repeat(161) },
    { ...normal, update: { ...normal.update, lastSeq: -1 } },
    { ...normal, update: { ...normal.update, lastSeq: Number.MAX_SAFE_INTEGER + 1 } },
    { ...normal, update: { ...normal.update, subscriptionId: 'x'.repeat(161) } },
    { ...normal, update: { ...normal.update, sessionId: 'x'.repeat(161) } },
  ]) worker.emit(message);
  assert.deepEqual(updates, []);
  worker.emit(normal);
  assert.equal(updates.length, 1);
});

for (const scenario of ['coding', 'slow'] as const) {
  test(`the ${scenario} test scenario always uses scripted config despite saved remote credentials`, async (t) => {
    const { host, workers } = setup(t, { settingsInput: remote, testScenario: scenario });
    await host.initialize();
    const payload = workers[0]!.requests('start')[0]!.payload as WorkerStartPayload;
    assert.deepEqual(payload.config, { providerId: 'scripted', modelId: `desktop-${scenario}-fixture`, baseURL: '' });
    assert.equal(payload.testScenario, scenario);
    assert.ok(!JSON.stringify(payload).includes(remote.apiKey!));
    assert.equal(host.getSettings().keyConfigured, false);
    assert.equal(host.getSettings().keySource, 'none');
    assert.equal((await host.getBootstrap()).settings.providerId, 'scripted');
  });
}

test('a failed close does not claim stopped and a later close can retry confirmation', async (t) => {
  const { host, workers } = setup(t);
  await host.initialize();
  workers[0]!.onRequest = (request, utility) => {
    if (request.type !== 'close') return false;
    queueMicrotask(() => utility.failure(request, 'CLOSE_FAILED', 'Engine cleanup was not confirmed.')); return true;
  };
  await assert.rejects(host.close(), errorCode('CLOSE_FAILED'));
  assert.equal(host.getStatus().state, 'failed');
  assert.notEqual(host.getStatus().state, 'stopped');
  workers[0]!.onRequest = undefined;
  await host.close();
  assert.equal(host.getStatus().state, 'stopped');
  assert.equal(workers[0]!.requests('close').length, 2);
});

test('startup timeout confirms partial-engine cleanup before retry opens the same database', async (t) => {
  const { host, workers, trace } = setup(t, { rpcTimeoutMs: 20, configureWorker(worker) {
    if (worker.index === 0) worker.held.add('start');
  } });
  const failed = await host.initialize();
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error?.code, 'HOST_RPC_TIMEOUT');
  assert.equal(workers[0]!.requests('close').length, 1);
  assert.equal((await host.retryEngine()).state, 'ready');
  assert.ok(trace.indexOf('worker0.close.confirmed') < trace.indexOf('worker1.spawn'));
});

test('an unconfirmed failed-start cleanup prevents retry from opening another database owner', async (t) => {
  let allowClose = false;
  const { host, workers } = setup(t, { configureWorker(worker) {
    if (worker.index !== 1) return;
    worker.onRequest = (request, utility) => {
      if (request.type === 'start') {
        queueMicrotask(() => utility.failure(request, 'START_FAILED', 'fixture startup failed')); return true;
      }
      if (request.type === 'close' && !allowClose) {
        queueMicrotask(() => utility.failure(request, 'CLOSE_FAILED', 'fixture cleanup not confirmed')); return true;
      }
      return false;
    };
  } });
  await host.initialize();
  await assert.rejects(host.saveSettings(remote), errorCode('SETTINGS_ENGINE_START_FAILED'));
  assert.equal((await host.retryEngine()).state, 'failed');
  assert.equal(workers.length, 2);
  allowClose = true;
  assert.equal((await host.retryEngine()).state, 'ready');
  assert.equal(workers.length, 3);
});

test('close ACK detaches messages but retains the original exit listener until final close observes exit', async (t) => {
  const { host, workers } = setup(t);
  await host.initialize();
  const worker = workers[0]!; worker.autoExit = false;
  let settled = false;
  const closing = host.close().then(() => { settled = true; });
  await until(() => worker.requests('close').length === 1 && worker.messageListeners.size === 0);
  assert.equal(settled, false);
  assert.equal(worker.exitListeners.size, 1);
  const receipt = host.getUtilityCloseDiagnostics();
  assert.equal(receipt.cleanupConfirmed, null);
  assert.equal(receipt.utilityAcknowledged, true);
  assert.equal(receipt.utilityExitObserved, false);
  assert.equal(receipt.connections[0]!.engineCloseAcknowledged, true);
  worker.exit(0); await closing;
  assert.equal(host.getStatus().state, 'stopped');
  assert.equal(worker.exitListeners.size, 0);
  assert.equal(host.getUtilityCloseDiagnostics().cleanupConfirmed, true);
});

test('ACK without original exit times out safely and a late exit only settles physical quit', async (t) => {
  const { host, workers } = setup(t, { utilityExitTimeoutMs: 15 });
  await host.initialize(); const worker = workers[0]!; worker.autoExit = false;
  await assert.rejects(host.close(), errorCode('HOST_WORKER_EXIT_TIMEOUT'));
  assert.equal(host.getStatus().state, 'failed');
  assert.equal(worker.exitListeners.size, 1, 'original observation capability is retained for quit retry');
  const timedOut = host.getUtilityCloseDiagnostics();
  assert.equal(timedOut.cleanupConfirmed, false);
  assert.equal(timedOut.connections[0]!.reason, 'exit-timeout');
  worker.exit(0); await host.close();
  assert.equal(host.getUtilityCloseDiagnostics().connections[0]!.utilityExitObserved, true);
  await assert.rejects(host.closeForUpdate(), errorCode('HOST_UTILITY_CLOSE_UNCONFIRMED'));
  assert.equal(worker.requests('close').length, 1);
});

test('original exit without ACK rejects its pending close and never credits a late ACK', async (t) => {
  const { host, workers } = setup(t);
  await host.initialize(); const worker = workers[0]!; worker.held.add('close');
  const closing = host.close(); const rejected = assert.rejects(closing, errorCode('HOST_WORKER_EXITED'));
  await until(() => worker.requests('close').length === 1);
  const request = worker.requests('close')[0]!; worker.exit(0); await rejected;
  worker.success(request); await host.close();
  const receipt = host.getUtilityCloseDiagnostics();
  assert.equal(receipt.connections[0]!.reason, 'exit-without-ack');
  assert.equal(receipt.connections[0]!.engineCloseAcknowledged, false);
  assert.equal(receipt.cleanupConfirmed, false);
  await assert.rejects(host.closeForUpdate(), errorCode('HOST_UTILITY_CLOSE_UNCONFIRMED'));
});

test('a nonzero original exit after ACK is observed but is not confirmed cleanup', async (t) => {
  const { host, workers } = setup(t);
  await host.initialize(); const worker = workers[0]!; worker.autoExit = false;
  const closing = host.close();
  await until(() => worker.messageListeners.size === 0);
  worker.exit(7); await closing;
  const receipt = host.getUtilityCloseDiagnostics();
  assert.equal(receipt.utilityAcknowledged, true); assert.equal(receipt.utilityExitObserved, true);
  assert.equal(receipt.connections[0]!.exitCode, 7);
  assert.equal(receipt.connections[0]!.reason, 'nonzero-exit'); assert.equal(receipt.cleanupConfirmed, false);
  await assert.rejects(host.closeForUpdate(), errorCode('HOST_UTILITY_CLOSE_UNCONFIRMED'));
});

test('retry admits a new engine after ACK while a late old exit credits only its immutable connection', async (t) => {
  const { host, workers } = setup(t);
  await host.initialize(); const original = workers[0]!; original.autoExit = false;
  assert.equal((await host.retryEngine()).state, 'ready');
  const current = workers[1]!; current.autoExit = false;
  const before = host.getUtilityCloseDiagnostics();
  assert.notEqual(before.connections[0]!.connectionId, before.connections[1]!.connectionId);
  assert.deepEqual(before.connections.map(record => record.generation), [1, 2]);
  const closing = host.close();
  await until(() => current.messageListeners.size === 0);
  original.exit(0);
  const late = host.getUtilityCloseDiagnostics();
  assert.equal(late.connections[0]!.utilityExitObserved, true);
  assert.equal(late.connections[1]!.utilityExitObserved, false);
  assert.equal(late.cleanupConfirmed, null);
  current.exit(0); await closing;
  assert.equal(host.getUtilityCloseDiagnostics().cleanupConfirmed, true);
});

for (const mode of ['error', 'timeout'] as const) {
  test(`a close ${mode} retains uncertainty even if a later retry ACKs and exits`, async (t) => {
    const { host, workers } = setup(t, { closeTimeoutMs: 15 }); await host.initialize(); const worker = workers[0]!;
    if (mode === 'timeout') worker.held.add('close');
    else worker.onRequest = (request, utility) => {
      if (request.type !== 'close') return false;
      queueMicrotask(() => utility.failure(request, 'CLOSE_FAILED', `private ${remote.apiKey}`)); return true;
    };
    await assert.rejects(host.close(), errorCode(mode === 'timeout' ? 'HOST_RPC_TIMEOUT' : 'CLOSE_FAILED'));
    assert.equal(host.getUtilityCloseDiagnostics().connections[0]!.reason, `close-${mode}`);
    // A late timed-out reply is not the acknowledgement of a newer close RPC.
    if (mode === 'timeout') { worker.autoExit = false; worker.release('close'); }
    assert.equal(host.getUtilityCloseDiagnostics().connections[0]!.engineCloseAcknowledged, false);
    worker.autoExit = true; worker.held.delete('close'); worker.onRequest = undefined;
    await host.close();
    assert.equal(host.getUtilityCloseDiagnostics().cleanupConfirmed, false);
    await assert.rejects(host.closeForUpdate(), errorCode('HOST_UTILITY_CLOSE_UNCONFIRMED'));
  });
}

test('close receipts expose only bounded transport metadata and observers cannot affect lifecycle', async (t) => {
  const receipts: UtilityCloseDiagnostics[] = [];
  const { host } = setup(t, { settingsInput: remote, onUtilityClose(receipt) {
    receipts.push(structuredClone(receipt)); receipt.connections.length = 0; throw new Error('private observer');
  } });
  await host.initialize(); await host.closeForUpdate();
  const receipt = host.getUtilityCloseDiagnostics();
  assert.equal(receipt.connections.length, 1); assert.equal(receipt.cleanupConfirmed, true);
  assert.ok(receipts.some(value => value.utilityAcknowledged === true && value.utilityExitObserved === false));
  assert.equal(receipts.at(-1)!.cleanupConfirmed, true);
  assert.doesNotMatch(JSON.stringify(receipts), /fixture-private-key|fixture-model|fixture\/engine|private observer/u);
  receipt.connections[0]!.engineCloseAcknowledged = false;
  assert.equal(host.getUtilityCloseDiagnostics().connections[0]!.engineCloseAcknowledged, true);
});

test('settled ledger eviction keeps coverage incomplete and blocks updater confirmation', async (t) => {
  const { host, workers } = setup(t); await host.initialize();
  for (let count = 0; count < UTILITY_CLOSE_DIAGNOSTIC_LIMIT; count++) {
    assert.equal((await host.retryEngine()).state, 'ready');
  }
  await host.close();
  const receipt = host.getUtilityCloseDiagnostics();
  assert.equal(workers.length, UTILITY_CLOSE_DIAGNOSTIC_LIMIT + 1);
  assert.equal(receipt.connections.length, UTILITY_CLOSE_DIAGNOSTIC_LIMIT);
  assert.equal(receipt.evictedCount, 1); assert.equal(receipt.complete, false); assert.equal(receipt.cleanupConfirmed, null);
  await assert.rejects(host.closeForUpdate(), errorCode('HOST_UTILITY_CLOSE_UNCONFIRMED'));
});

test('live original utility capacity stops further spawning without abandoning original exit listeners', async (t) => {
  const { host, workers } = setup(t, { configureWorker(worker) { worker.autoExit = false; } }); await host.initialize();
  for (let count = 1; count < UTILITY_CLOSE_DIAGNOSTIC_LIMIT; count++) assert.equal((await host.retryEngine()).state, 'ready');
  const limited = await host.retryEngine();
  assert.equal(limited.state, 'failed'); assert.equal(limited.error?.code, 'HOST_UTILITY_CAPACITY');
  assert.equal(workers.length, UTILITY_CLOSE_DIAGNOSTIC_LIMIT);
  assert.ok(workers.every(worker => worker.exitListeners.size === 1));
  assert.equal(host.getUtilityCloseDiagnostics().evictedCount, 0);
  // An exact original exit frees capacity, but omitted history prevents a full receipt.
  workers[0]!.exit(0); assert.equal((await host.retryEngine()).state, 'ready');
  assert.equal(host.getUtilityCloseDiagnostics().evictedCount, 1);
  for (const worker of workers) worker.autoExit = true;
  for (const worker of workers.slice(0, -1)) worker.exit(0);
  await host.close();
});

test('strict update cleanup permits a never-spawned host and complete original utility cleanup', async (t) => {
  const empty = setup(t); await empty.host.closeForUpdate(); assert.equal(empty.workers.length, 0);
  assert.equal(empty.host.getUtilityCloseDiagnostics().cleanupConfirmed, null);
  const running = setup(t); await running.host.initialize(); await running.host.closeForUpdate();
  assert.equal(running.host.getUtilityCloseDiagnostics().cleanupConfirmed, true);
});

test('a crashed original remains visible and blocks updates after successful engine retry', async (t) => {
  const { host, workers } = setup(t); await host.initialize(); workers[0]!.exit(1);
  assert.equal((await host.retryEngine()).state, 'ready'); await host.close();
  assert.equal(host.getStatus().state, 'stopped');
  const receipt = host.getUtilityCloseDiagnostics();
  assert.equal(receipt.connections[1]!.cleanupConfirmed, true); assert.equal(receipt.cleanupConfirmed, false);
  await assert.rejects(host.closeForUpdate(), errorCode('HOST_UTILITY_CLOSE_UNCONFIRMED'));
});

test('a spawn failure cannot publish the selected key in host state', async (t) => {
  const { host, statuses } = setup(t, { settingsInput: remote, spawnFailure: new Error(`utility spawn failed ${remote.apiKey}`) });
  const status = await host.initialize();
  assert.equal(status.state, 'failed');
  assert.ok(!JSON.stringify(status).includes(remote.apiKey!));
  assert.ok(!JSON.stringify(statuses).includes(remote.apiKey!));
});

test('a prepare failure cannot echo the submitted credential', async (t) => {
  const { host, settings } = setup(t);
  await host.initialize();
  settings.prepareHook = async () => { throw new HostError('SETTINGS_INVALID', `fixture validation failed ${remote.apiKey}`); };
  await assert.rejects(host.saveSettings(remote), errorCode('SETTINGS_INVALID', remote.apiKey));
  assert.equal(host.getStatus().state, 'ready');
});

test('an uppercase credential embedded in an otherwise valid worker error code remains private', async (t) => {
  const secret = 'FIXTUREUPPERCASEKEY';
  const { host, workers } = setup(t, { settingsInput: { ...remote, apiKey: secret } });
  await host.initialize();
  workers[0]!.onRequest = (request, utility) => {
    if (request.type !== 'command') return false;
    queueMicrotask(() => utility.failure(request, `FAILED_${secret}`, `fixture failure ${secret}`)); return true;
  };
  await assert.rejects(host.command(command()), (error: unknown) => {
    assert.ok(error instanceof HostError);
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.ok(!error.message.includes(secret));
    return true;
  });
});

test('bootstrap includes only documented worker metadata even if a worker response contains private fields', async (t) => {
  const { host, workers } = setup(t, { settingsInput: remote });
  await host.initialize();
  workers[0]!.onRequest = (request, utility) => {
    if (request.type !== 'bootstrap') return false;
    queueMicrotask(() => utility.success(request, {
      workspaces: [], capabilities, engineConfig: { apiKey: remote.apiKey }, privateCredential: remote.apiKey,
    })); return true;
  };
  const bootstrap = await host.getBootstrap();
  assert.ok(!JSON.stringify(bootstrap).includes(remote.apiKey!));
  assert.deepEqual(Object.keys(bootstrap).sort(), ['capabilities', 'host', 'platform', 'settings', 'version', 'workspaces']);
});

test('public settings strip unexpectedly private store fields while preserving documented metadata', async (t) => {
  const { host, settings } = setup(t, { settingsInput: remote });
  await host.initialize();
  const metadata = settings.getView();
  settings.getView = () => ({
    ...metadata, codexAuthState: 'available', codexModelId: 'fixture-codex-model',
    apiKey: remote.apiKey, engineConfig: settings.current.engineConfig,
  });
  const view = host.getSettings();
  assert.equal(view.codexAuthState, 'available');
  assert.equal(view.codexModelId, 'fixture-codex-model');
  assert.ok(!JSON.stringify(view).includes(remote.apiKey!));
  assert.deepEqual(Object.keys(view).sort(), [
    'baseURL', 'codexAuthState', 'codexModelId', 'credentialStorage', 'keyConfigured', 'keySource', 'modelId', 'providerId',
  ]);
  assert.ok(!JSON.stringify(await host.getBootstrap()).includes(remote.apiKey!));
});


test('the matching close ACK is recorded before a same-turn original exit', async t => {
  const { host, workers } = setup(t); await host.initialize(); const worker = workers[0]!; worker.autoExit = false;
  worker.onRequest = (request, utility) => {
    if (request.type !== 'close') return false;
    queueMicrotask(() => { utility.success(request); utility.exit(0); }); return true;
  };
  await host.closeForUpdate(); assert.equal(host.getUtilityCloseDiagnostics().cleanupConfirmed, true);
});

test('unknown original exit status stays uncertain despite a matching close ACK', async t => {
  const { host, workers } = setup(t); await host.initialize(); const worker = workers[0]!; worker.autoExit = false;
  const closing = host.close(); await until(() => worker.messageListeners.size === 0); worker.exit(Number.NaN); await closing;
  const receipt = host.getUtilityCloseDiagnostics();
  assert.equal(receipt.connections[0]!.exitCode, null); assert.equal(receipt.connections[0]!.reason, 'exit-status-unknown');
  assert.equal(receipt.cleanupConfirmed, false);
  await assert.rejects(host.closeForUpdate(), errorCode('HOST_UTILITY_CLOSE_UNCONFIRMED'));
});


test('a failed spawn attempt is unknown authority and cannot use the never-started updater exception', async t => {
  const f = setup(t, { spawnFailure: new Error('private native adapter failure') });
  assert.equal((await f.host.initialize()).state, 'failed');
  await assert.rejects(f.host.closeForUpdate(), errorCode('HOST_UTILITY_CLOSE_UNCONFIRMED'));
  const receipt = f.host.getUtilityCloseDiagnostics();
  assert.equal(receipt.connections.length, 0); assert.equal(receipt.spawnAttempted, true);
  assert.equal(receipt.spawnUnobserved, true); assert.equal(receipt.complete, false);
  assert.notEqual(receipt.cleanupConfirmed, true); assert.doesNotMatch(JSON.stringify(receipt), /private native/u);
});

test('settings failure before any spawn remains a legitimate never-started updater close', async t => {
  const f = setup(t); f.settings.loadHook = async () => { throw new HostError('SETTINGS_KEY_REQUIRED', 'Fixture requires its configured credential.'); };
  assert.equal((await f.host.initialize()).state, 'failed'); await f.host.closeForUpdate();
  assert.equal(f.workers.length, 0); assert.equal(f.host.getUtilityCloseDiagnostics().spawnAttempted, false);
});
