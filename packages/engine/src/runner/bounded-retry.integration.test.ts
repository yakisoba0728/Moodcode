import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { EngineError, type SubmitInput } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ProviderAdapter } from '../ports.js';

function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function code(expected: string) { return (error: unknown) => error instanceof EngineError && error.code === expected; }
async function hold(promise: Promise<void>, signal: AbortSignal) { let abort!: () => void; try { await Promise.race([promise, new Promise<void>(resolve => { abort = resolve; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]); } finally { signal.removeEventListener('abort', abort); } }

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-bounded-retry-'))), entered = gate(), release = gate(); let calls = 0;
  const repository = join(root, 'repo'); await mkdir(repository); execFileSync('git', ['init', '-q', repository]);
  const provider: ProviderAdapter = { id: 'bounded-fixture', async *streamTurn(request, signal) {
    calls++; if (request.messages.findLast(message => message.role === 'user')?.content === 'active-owner') { entered.resolve(); yield { type: 'progress' }; await hold(release.promise, signal); }
    if (!signal.aborted) { yield { type: 'text.delta', delta: 'Original local completed observation' }; yield { type: 'finish', reason: 'stop' }; }
  } };
  const engine = createEngine({ dbPath: join(root, 'engine.sqlite'), artifactDir: join(root, 'artifacts'), providers: [provider], defaults: { providerId: provider.id, modelId: 'fixture', mode: 'plan' } });
  t.after(async () => { release.resolve(); await engine.close(); await rm(root, { recursive: true, force: true }); });
  const opened = await engine.dispatch({ schemaVersion: 1, commandId: 'open-fixture', type: 'workspace.open', payload: { path: repository } }); assert.equal(opened.ok, true, JSON.stringify(opened));
  const workspace = engine.store.getWorkspace((opened.result as { id: string }).id), session = engine.store.createSession({ id: 'session', workspaceId: workspace.id, title: 'Fixture', createdAt: new Date().toISOString() });
  const input = (requestId: string): SubmitInput => ({ sessionId: session.id, requestId, prompt: requestId, config: structuredClone(engine.getCapabilities().defaults) });
  const originalSnapshot = engine.store.getSnapshot.bind(engine.store); let fullReads = 0;
  const denySnapshot = () => { engine.store.getSnapshot = () => { fullReads++; throw new Error('Independent fixture prohibits whole-session snapshots on receipt hotpaths'); }; };
  const submitted = input('completed-original'), receipt = engine.coordinator.submit(submitted); assert.equal((await engine.waitForRun(receipt.runId)).state, 'completed');
  return { root, engine, workspace, session, input, submitted, receipt, entered, release, denySnapshot, reads: () => fullReads, calls: () => calls, originalSnapshot };
}

for (const mode of ['quarantine', 'lease'] as const) test(`actual completed Run exact retry is bounded and canonical under ${mode}`, async t => {
  const f = await fixture(t), leaseEntered = gate(), leaseRelease = gate(); let lease: Promise<void> | undefined;
  t.after(leaseRelease.resolve);
  if (mode === 'quarantine') f.engine.coordinator.quarantineWorkspace(f.workspace.id);
  else { f.denySnapshot(); lease = f.engine.coordinator.withWorkspaceLease(f.workspace.id, async () => { leaseEntered.resolve(); await leaseRelease.promise; }); await Promise.race([leaseEntered.promise, lease]); }
  try {
    f.denySnapshot(); const callsBefore = f.calls(), seqBefore = f.engine.store.readEvents(f.session.id, 0).at(-1)!.seq;
    assert.equal(f.engine.store.hasRunRequest(f.session.id, f.submitted.requestId), true);
    assert.deepEqual(f.engine.coordinator.submit(f.submitted), { ...f.receipt, duplicate: true });
    assert.throws(() => f.engine.coordinator.submit({ ...f.submitted, prompt: 'Changed normalized prompt' }), code('REQUEST_ID_CONFLICT'));
    assert.throws(() => f.engine.coordinator.submit({ ...f.submitted, config: { ...f.submitted.config, modelId: 'Changed model' } }), code('REQUEST_ID_CONFLICT'));
    assert.throws(() => f.engine.coordinator.submit(f.input('fresh-blocked')), code(mode === 'quarantine' ? 'CLEANUP_PENDING' : 'WORKSPACE_BUSY'));
    assert.equal(f.engine.store.hasRunRequest(f.session.id, 'fresh-blocked'), false); assert.equal(f.calls(), callsBefore); assert.equal(f.reads(), 0);
    assert.equal(f.engine.store.getRun(f.receipt.runId).state, 'completed'); assert.equal(f.engine.store.readEvents(f.session.id, 0).at(-1)!.seq, seqBefore);
    assert.equal(f.engine.store.listInputs(f.session.id).inputs.length, 1);
  } finally { leaseRelease.resolve(); await lease; f.engine.store.getSnapshot = f.originalSnapshot; }
});

test('pending queue and promoted steer are not primary Run identities and cannot bypass quarantine', async t => {
  const f = await fixture(t); f.engine.scheduler.pause(f.session.id);
  const queued = f.engine.store.acceptInput({ ...f.input('queued-input'), delivery: 'queue' });
  const steer = f.engine.store.acceptInput({ ...f.input('steer-input'), delivery: 'steer' });
  assert.equal(f.engine.store.hasRunRequest(f.session.id, 'queued-input'), false); assert.equal(f.engine.store.hasRunRequest(f.session.id, 'steer-input'), false);
  const active = f.engine.coordinator.submit(f.input('active-owner')); await f.entered.promise;
  f.engine.store.setSessionPaused(f.session.id, false);
  const promoted = f.engine.store.promoteSteers([steer.inputId], active.runId); f.engine.scheduler.pause(f.session.id); assert.equal(promoted[0]!.runId, active.runId);
  assert.equal(f.engine.store.hasRunRequest(f.session.id, 'active-owner'), true); assert.equal(f.engine.store.hasRunRequest(f.session.id, 'steer-input'), false);
  f.release.resolve(); assert.equal((await f.engine.waitForRun(active.runId)).state, 'completed');
  assert.equal(f.engine.store.getInput(queued.inputId).state, 'pending'); assert.equal(f.engine.store.getInput(steer.inputId).state, 'promoted');
  f.engine.coordinator.quarantineWorkspace(f.workspace.id); f.denySnapshot(); const before = f.calls(), seq = f.engine.store.readEvents(f.session.id, 0).at(-1)!.seq;
  for (const requestId of ['queued-input', 'steer-input', 'new-input']) assert.throws(() => f.engine.coordinator.submit(f.input(requestId)), code('CLEANUP_PENDING'));
  assert.deepEqual(f.engine.coordinator.submit(f.input('active-owner')), { ...active, duplicate: true });
  assert.equal(f.calls(), before); assert.equal(f.reads(), 0); assert.equal(f.engine.store.readEvents(f.session.id, 0).at(-1)!.seq, seq);
  assert.equal(f.engine.store.listInputs(f.session.id).inputs.length, 4);
});

test('completed native queue promotion is a primary Run request and has bounded exact legacy retry', async t => {
  const f = await fixture(t), accepted = f.engine.scheduler.accept({ ...f.input('native-primary'), delivery: 'queue' }); await f.engine.scheduler.waitForSession(f.session.id);
  const promoted = f.engine.store.getInput(accepted.inputId); assert.equal(promoted.state, 'promoted'); assert.ok(promoted.runId); assert.equal(f.engine.store.getRun(promoted.runId).state, 'completed');
  assert.equal(f.engine.store.hasRunRequest(f.session.id, 'native-primary'), true); f.engine.coordinator.quarantineWorkspace(f.workspace.id); f.denySnapshot(); const before = f.calls();
  const repeated = f.engine.coordinator.submit(f.input('native-primary')); assert.equal(repeated.runId, promoted.runId); assert.equal(repeated.inputId, accepted.inputId); assert.equal(repeated.duplicate, true);
  assert.throws(() => f.engine.coordinator.submit({ ...f.input('native-primary'), prompt: 'Conflicting native primary' }), code('REQUEST_ID_CONFLICT')); assert.equal(f.calls(), before); assert.equal(f.reads(), 0);
});
