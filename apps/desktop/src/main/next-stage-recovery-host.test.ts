import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { DesktopRecoveryResult, DesktopRecoveryStatus, DesktopSettings } from '../shared/protocol.js';
import type { WorkerRequest } from '../worker/protocol.js';
import type { ResolvedDesktopSettings } from './settings.js';
import { DesktopHost, type UtilityTransport } from './host.js';

const fingerprint = 'a'.repeat(64);
const view: DesktopSettings = { providerId: 'scripted', modelId: 'local', baseURL: '', keyConfigured: false, keySource: 'none', credentialStorage: 'unavailable' };
const recovery: DesktopRecoveryResult = { recoveryId: 'fixture-recovery', restoredAcknowledgments: 1, effectMarkerCleared: false, backupVerified: true };
const status = (blockers = ['RECOVERY_OWNER_BUSY']): DesktopRecoveryStatus => ({ schemaVersion: 1, state: blockers.length ? 'blocked' : 'clear', fingerprint, blockers, marker: null, pendingRestoreCount: 0, resolvedRestoreCount: 0 });

class FixtureUtility implements UtilityTransport {
  readonly messages: WorkerRequest[] = [];
  readonly pending = new Map<string, WorkerRequest>();
  readonly held = new Set<WorkerRequest['type']>();
  readonly listeners = new Set<(message: unknown) => void>();
  readonly exits = new Set<(code: number) => void>();
  readonly historicalExits: ((code: number) => void)[] = [];
  active = false;
  autoExit = true;
  constructor(readonly index: number, readonly trace: string[], readonly diagnostic: () => DesktopRecoveryStatus) {}
  postMessage(request: WorkerRequest): void {
    this.messages.push(request); this.pending.set(request.id, request); this.trace.push(`${this.index}:${request.type}`);
    if (!this.held.has(request.type)) queueMicrotask(() => this.respond(request));
  }
  onMessage(listener: (message: unknown) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onExit(listener: (code: number) => void): () => void { this.exits.add(listener); this.historicalExits.push(listener); return () => { this.exits.delete(listener); }; }
  requests(type: WorkerRequest['type']) { return this.messages.filter(request => request.type === type); }
  respond(request: WorkerRequest): void {
    if (!this.pending.delete(request.id)) return;
    this.trace.push(`${this.index}:${request.type}:ack`);
    const failed = this.active && ['assertIdle', 'backup'].includes(request.type);
    const result = request.type === 'diagnostics' ? structuredClone(this.diagnostic()) : request.type === 'recover' ? recovery : request.type === 'backup' ? { bytes: 1234 } : undefined;
    const response = failed ? { id: request.id, ok: false, error: { code: 'WORKSPACE_BUSY', message: 'Fixture active Run' } } : { id: request.id, ok: true, result };
    for (const listener of [...this.listeners]) listener(response);
    if (request.type === 'close' && !failed && this.autoExit) queueMicrotask(() => this.exit(0));
  }
  exit(code = 0): void { for (const listener of [...this.exits]) listener(code); }
  release(type: WorkerRequest['type']): void { this.held.delete(type); for (const request of [...this.pending.values()]) if (request.type === type) this.respond(request); }
  settle(): void { this.held.clear(); this.active = false; for (const request of [...this.pending.values()]) this.respond(request); }
}

function fixture(t: TestContext) {
  const trace: string[] = [];
  const workers: FixtureUtility[] = [];
  let diagnostic = status();
  let configure: ((worker: FixtureUtility) => void) | undefined;
  const resolved: ResolvedDesktopSettings = { view, engineConfig: { providerId: 'scripted', modelId: 'local', baseURL: '' } };
  const host = new DesktopHost({
    dbPath: '/main-owned/engine.sqlite', artifactDir: '/main-owned/artifacts', platform: 'fixture', version: 'fixture', rpcTimeoutMs: 1000, closeTimeoutMs: 1000,
    settings: { getView: () => view, load: async () => resolved, prepare: async () => resolved, commit: async () => resolved },
    spawn() { const worker = new FixtureUtility(workers.length, trace, () => diagnostic); workers.push(worker); configure?.(worker); return worker; },
  });
  t.after(async () => { for (const worker of workers) { worker.autoExit = true; worker.settle(); worker.exit(); } await host.close(); });
  return { host, trace, workers, setStatus(value: DesktopRecoveryStatus) { diagnostic = value; }, configure(value: typeof configure) { configure = value; } };
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await setImmediate(); }
  assert.fail('Expected host boundary transition was not reached');
}

test('diagnostics use a fresh auxiliary worker without engine/provider start and only the ready idle owner blocker is stripped', async t => {
  const f = fixture(t);
  await f.host.initialize();
  f.setStatus(status(['RECOVERY_OWNER_BUSY', 'RECOVERY_EFFECT_BUSY', 'PROCESS_OWNER_ALIVE', 'PROCESS_GROUP_ALIVE']));
  const blocked = await f.host.getRecoveryStatus();
  assert.deepEqual(blocked.blockers, ['RECOVERY_EFFECT_BUSY', 'PROCESS_OWNER_ALIVE', 'PROCESS_GROUP_ALIVE']);
  assert.equal(blocked.state, 'blocked');
  assert.deepEqual(f.workers[1]!.messages.map(request => request.type), ['diagnostics', 'close']);
  assert.deepEqual(f.workers[1]!.requests('diagnostics')[0]!.payload, { dbPath: '/main-owned/engine.sqlite', artifactDir: '/main-owned/artifacts' });
  assert.equal(f.workers[1]!.listeners.size, 0);
  assert.equal(f.workers[1]!.exits.size, 0);
  assert.equal(f.host.getStatus().state, 'ready');
  // A Run admitted after the initial idle observation remains blocked in the newer snapshot.
  f.setStatus({ ...status(), activeRunCount: 1 });
  assert.deepEqual((await f.host.getRecoveryStatus()).blockers, ["RECOVERY_OWNER_BUSY"]);
  f.setStatus(status());
  assert.equal((await f.host.getRecoveryStatus()).state, 'clear');
  f.setStatus({ ...status(), pendingRestoreCount: 1 });
  assert.equal((await f.host.getRecoveryStatus()).state, 'recoverable');
  f.workers[0]!.active = true;
  assert.deepEqual((await f.host.getRecoveryStatus()).blockers, ['RECOVERY_OWNER_BUSY']);
});

test('diagnostic requests coalesce while pending and quit waits for diagnostic worker close acknowledgment', async t => {
  const f = fixture(t);
  await f.host.initialize();
  f.configure(worker => { worker.held.add('diagnostics'); worker.held.add('close'); });
  const first = f.host.getRecoveryStatus();
  const second = f.host.getRecoveryStatus();
  assert.strictEqual(first, second);
  await until(() => f.workers.length === 2);
  assert.equal(f.workers[1]!.requests('diagnostics').length, 1);
  let closed = false;
  const quitting = f.host.close().then(() => { closed = true; });
  await setImmediate();
  assert.equal(closed, false);
  f.workers[1]!.release('diagnostics');
  await until(() => f.workers[1]!.requests('close').length === 1);
  assert.equal(closed, false);
  f.workers[1]!.release('close');
  await first;
  await quitting;
  assert.equal(f.host.getStatus().state, 'stopped');
  for (const worker of f.workers) { assert.equal(worker.listeners.size, 0); assert.equal(worker.exits.size, 0); }
});

test('recovery waits for the normal engine close acknowledgment before mutation and late old exits do not fail the new ready host', async t => {
  const f = fixture(t);
  await f.host.initialize();
  const original = f.workers[0]!;
  original.held.add('close');
  const recovering = f.host.recoverEngine({ fingerprint, acknowledged: true });
  await until(() => original.requests('close').length === 1);
  assert.equal(f.workers.length, 1);
  assert.equal(f.trace.some(entry => entry.includes(':recover')), false);
  original.release('close');
  assert.deepEqual(await recovering, recovery);
  assert.deepEqual(f.workers[1]!.messages.map(request => request.type), ['recover', 'close']);
  assert.deepEqual(f.workers[1]!.requests('recover')[0]!.payload, { dbPath: '/main-owned/engine.sqlite', artifactDir: '/main-owned/artifacts', fingerprint, acknowledged: true });
  assert.ok(f.trace.indexOf('0:close:ack') < f.trace.indexOf('1:recover'));
  assert.ok(f.trace.indexOf('1:close:ack') < f.trace.indexOf('2:start'));
  assert.equal(f.host.getStatus().state, 'ready');
  for (const worker of [original, f.workers[1]!]) for (const listener of worker.historicalExits) listener(1);
  assert.equal(f.host.getStatus().state, 'ready');
  assert.equal(f.host.getStatus().generation, 2);
});

test('invalid recovery acknowledgments and renderer path overrides are rejected before close or auxiliary spawn', async t => {
  const f = fixture(t);
  await f.host.initialize();
  const invalid = [null, {}, { fingerprint }, { fingerprint, acknowledged: false }, { fingerprint: fingerprint.toUpperCase(), acknowledged: true }, { fingerprint: `${fingerprint}\n`, acknowledged: true }, { fingerprint, acknowledged: true, dbPath: '/renderer-selected' }, { fingerprint, acknowledged: true, artifactDir: '/renderer-selected' }];
  for (const input of invalid) await assert.rejects(f.host.recoverEngine(input as { fingerprint: string; acknowledged: true }), { code: 'INVALID_INPUT' });
  assert.equal(f.workers.length, 1);
  assert.equal(f.workers[0]!.requests('close').length, 0);
  assert.equal(f.host.getStatus().state, 'ready');
});

test('an active Run blocks recovery and backup without closing its engine or spawning a storage worker', async t => {
  const f = fixture(t);
  await f.host.initialize();
  f.workers[0]!.active = true;
  await assert.rejects(f.host.recoverEngine({ fingerprint, acknowledged: true }), { code: 'WORKSPACE_BUSY' });
  await assert.rejects(f.host.backupDatabase('/main-selected/backup.sqlite'), { code: 'WORKSPACE_BUSY' });
  assert.equal(f.workers.length, 1);
  assert.equal(f.workers[0]!.requests('close').length, 0);
  assert.equal(f.host.getStatus().state, 'ready');
});


test('final quit observes auxiliary originals even after storage ACK released the diagnostic request', async t => {
  const f = fixture(t); await f.host.initialize(); f.configure(worker => { worker.autoExit = false; });
  await f.host.getRecoveryStatus();
  const auxiliary = f.workers[1]!;
  const before = f.host.getUtilityCloseDiagnostics();
  assert.deepEqual(before.connections.map(connection => connection.scope), ['engine', 'storage']);
  assert.equal(before.connections[1]!.engineCloseAcknowledged, true);
  assert.equal(before.connections[1]!.utilityExitObserved, false);
  assert.equal(auxiliary.exits.size, 1);
  let settled = false; const closing = f.host.close().then(() => { settled = true; });
  await until(() => f.host.getUtilityCloseDiagnostics().connections[0]!.utilityExitObserved);
  assert.equal(settled, false); assert.notEqual(f.host.getUtilityCloseDiagnostics().cleanupConfirmed, true);
  auxiliary.exit(); await closing;
  assert.equal(f.host.getUtilityCloseDiagnostics().cleanupConfirmed, true);
  assert.equal(auxiliary.exits.size, 0);
});
