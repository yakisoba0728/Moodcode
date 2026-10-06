import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { EngineError, type Run, type RunConfig } from '@moodcode/contracts';
import { createEngine, type EngineOptions, type MoodcodeEngine } from '../engine.js';
import { exportEngineArchive, importEngineArchive } from '../storage/archive.js';
import type { AttemptCleanupRecord } from '../storage/attempt-cleanup.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';

// These fixtures use authored, synthetic provider iterators and private SQLite
// files. No provider account, GUI, command tool or external API is exercised.
const prompt = 'Exact synthetic ordinary cleanup fixture goal.';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
type ReturnKind = 'done' | 'missing' | 'rejected' | 'not-done' | 'timeout' | 'held';
interface Observation { request: TurnRequest; returns: number; nexts: number; entered: ReturnType<typeof deferred>; returning: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
type Stream = (observation: Observation, signal: AbortSignal, index: number) => AsyncIterable<ProviderEvent>;
interface Fixture {
  root: string; dbPath: string; artifactDir: string; reader: DatabaseSync; engine: MoodcodeEngine; options: EngineOptions; observed: Observation[];
  dispatch: ReturnType<typeof deferred>; runId: string; done: Promise<Run>; start(requestId?: string): void; reopen(): Promise<void>; fullReads(): number;
}
async function fixture(t: TestContext, stream: Stream, config: { limits?: Partial<RunConfig['limits']>; budgets?: Partial<NonNullable<RunConfig['budgets']>> } = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-attempt-cleanup-'))), repository = join(root, 'repository'), dbPath = join(root, 'engine.sqlite'), artifactDir = join(root, 'artifacts');
  await mkdir(repository); let f!: Fixture, reads = 0; const observed: Observation[] = [], dispatch = deferred();
  const provider: ProviderAdapter = { id: 'attempt-cleanup-fixture', streamTurn(request, signal) {
    const observation: Observation = { request: structuredClone(request), returns: 0, nexts: 0, entered: deferred(), returning: deferred(), release: deferred() };
    observed.push(observation); dispatch.resolve(); return stream(observation, signal, observed.length - 1);
  } };
  const options: EngineOptions = { dbPath, artifactDir, providers: [provider], allowedToolNames: ['read_file'], defaults: {
    providerId: provider.id, modelId: 'fixture-model', mode: 'plan', limits: { maxContextBytes: 262144, maxOutputBytes: 1024, maxDurationMs: 10000, ...config.limits },
    budgets: { maxProviderAttempts: 2, retryBaseDelayMs: 1, providerRequestTimeoutMs: 5000, providerInactivityTimeoutMs: 5000, ...config.budgets },
  } };
  const engine = createEngine(options), reader = new DatabaseSync(dbPath, { readOnly: true });
  const trap = () => { f.engine.store.getSnapshot = () => { reads++; throw new Error('Ordinary cleanup fixtures forbid whole session snapshots'); }; };
  f = { root, dbPath, artifactDir, reader, engine, options, observed, dispatch, runId: '', done: undefined!,
    start(requestId = 'primary') { const receipt = f.engine.coordinator.submit({ sessionId: 'session', requestId, prompt, config: f.engine.getCapabilities().defaults }); f.runId = receipt.runId; f.done = f.engine.waitForRun(receipt.runId); },
    async reopen() { await f.engine.close(); f.engine = createEngine(options); trap(); await tick(); }, fullReads: () => reads,
  };
  t.after(async () => { for (const item of observed) item.release.resolve(); try { await f.engine.close(); } finally { reader.close(); await rm(root, { recursive: true, force: true }); } });
  const createdAt = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt });
  for (const id of ['session', 'other-session']) engine.store.createSession({ id, workspaceId: 'workspace', title: id, createdAt });
  trap(); return f;
}
function raw(observation: Observation, signal: AbortSignal, events: ProviderEvent[], kind: ReturnKind = 'done', failure?: EngineError, waitForAbort = false): AsyncIterableIterator<ProviderEvent> {
  let index = 0;
  const iterator: AsyncIterableIterator<ProviderEvent> = {
    [Symbol.asyncIterator]() { return iterator; },
    async next() {
      observation.nexts++;
      if (index < events.length) { observation.entered.resolve(); return { done: false, value: events[index++]! }; }
      if (waitForAbort) return new Promise<IteratorResult<ProviderEvent>>((_, reject) => {
        const abort = () => reject(signal.reason ?? new EngineError('RUN_CANCELLED', 'Synthetic provider observed cancellation'));
        signal.addEventListener('abort', abort, { once: true }); observation.entered.resolve(); if (signal.aborted) abort();
      });
      observation.entered.resolve(); if (failure) throw failure; return { done: true, value: undefined };
    },
  };
  if (kind !== 'missing') iterator.return = async () => {
    observation.returns++; observation.returning.resolve();
    if (kind === 'held') await observation.release.promise;
    if (kind === 'rejected') throw new Error('Synthetic underlying return rejected');
    if (kind === 'timeout') return new Promise<IteratorResult<ProviderEvent>>(() => {});
    return kind === 'not-done' ? { done: false, value: { type: 'progress' } } : { done: true, value: undefined };
  };
  return iterator;
}
async function entered(f: Fixture, stage: 'entered' | 'returning' = 'entered'): Promise<void> {
  await Promise.race([f.dispatch.promise, f.done.then(run => assert.fail(`Run settled before provider dispatch: ${run.state}/${run.error?.code}`))]);
  const observation = f.observed[0]; assert.ok(observation, 'Actual provider dispatch must precede fixture readiness');
  await Promise.race([observation[stage].promise, f.done.then(run => assert.fail(`Run settled before ${stage}: ${run.state}/${run.error?.code}`))]);
}
function evidence(f: Fixture, index = 0): AttemptCleanupRecord {
  const request = f.observed[index]!.request; assert.ok(request.attemptId); assert.ok(request.turnId);
  const proof = f.engine.store.getAttemptCleanup(request.attemptId, 'session');
  assert.equal(proof.attemptId, request.attemptId); assert.equal(proof.turnId, request.turnId); assert.equal(proof.runId, request.runId); assert.equal(proof.sessionId, 'session'); assert.equal(proof.workspaceId, 'workspace');
  assert.equal(proof.providerId, f.options.defaults!.providerId); assert.equal(proof.modelId, request.modelId); assert.equal(proof.requestProjection, 'engine-turn-request-v1');
  assert.equal(proof.requestSha256, hash(JSON.stringify(request))); assert.equal(proof.requestBytes, Buffer.byteLength(JSON.stringify(request)));
  assert.equal(proof.contextRevisionId, f.engine.store.getAttempt(request.attemptId).contextRevisionId);
  assert.equal(JSON.stringify(proof).includes(prompt), false); return proof;
}
function attempts(f: Fixture) { return f.reader.prepare('SELECT id FROM provider_attempts WHERE run_id=? ORDER BY attempt_index LIMIT 16').all(f.runId).map(row => f.engine.store.getAttempt(String(row.id))); }
function assertBlocked(f: Fixture): void {
  for (const sessionId of ['session', 'other-session']) assert.throws(() => f.engine.coordinator.submit({ sessionId, requestId: `new-${sessionId}`, prompt: 'Explicit new task', config: f.engine.getCapabilities().defaults }), code('CLEANUP_PENDING'));
  assert.throws(() => f.engine.scheduler.resume('other-session'), code('CLEANUP_PENDING'));
}
async function exactRetry(f: Fixture): Promise<void> {
  const calls = f.observed.length, run = f.engine.store.getRun(f.runId);
  const receipt = f.engine.coordinator.submit({ sessionId: 'session', requestId: 'primary', prompt, config: run.config }); assert.equal(receipt.duplicate, true); assert.equal(receipt.runId, run.id);
  assert.throws(() => f.engine.coordinator.submit({ sessionId: 'session', requestId: 'primary', prompt: prompt + ' changed', config: run.config }), code('REQUEST_ID_CONFLICT'));
  await tick(); assert.equal(f.observed.length, calls); assert.equal(f.fullReads(), 0);
}

test('actual natural iterator completion records exact ordinary cleanup evidence without requiring return and preserves it on restart', { timeout: 30000 }, async t => {
  const f = await fixture(t, (item, signal) => raw(item, signal, [{ type: 'text.delta', delta: 'Synthetic public answer.' }, { type: 'finish', reason: 'stop' }], 'missing'));
  f.start(); assert.equal((await f.done).state, 'completed'); const proof = evidence(f);
  assert.equal(proof.state, 'confirmed'); assert.equal(proof.cleanupConfirmed, true); assert.equal(proof.method, 'iterator-next-done'); assert.equal(proof.reason, 'natural-done'); assert.equal(f.observed[0]!.returns, 0);
  assert.equal(attempts(f).length, 1); assert.equal(attempts(f)[0]!.state, 'completed');
  assert.throws(() => f.engine.store.getAttemptCleanup(proof.attemptId, 'other-session'), code('ATTEMPT_CLEANUP_BINDING_MISMATCH'));
  await f.reopen(); assert.deepEqual(evidence(f), proof); await exactRetry(f);
  await assert.doesNotReject(f.engine.coordinator.withWorkspaceLease('workspace', async () => ({ cleanupConfirmed: true })));
});

for (const failure of ['output-limit', 'protocol'] as const) test(`actual consumer ${failure} waits for the underlying iterator return before publishing failure and cleanup evidence`, { timeout: 30000 }, async t => {
  const event: ProviderEvent = failure === 'output-limit' ? { type: 'text.delta', delta: 'x'.repeat(129) } : { type: 'usage', inputTokens: -1 };
  const f = await fixture(t, (item, signal) => raw(item, signal, [event], 'held'), { limits: { maxOutputBytes: 128 } }); f.start();
  await entered(f, 'returning'); assert.equal(f.observed[0]!.returns, 1); assert.equal(evidence(f).state, 'dispatched'); assert.ok(!['completed','failed','cancelled'].includes(f.engine.store.getRun(f.runId).state));
  f.observed[0]!.release.resolve(); const run = await f.done;
  assert.equal(run.state, 'failed'); assert.equal(run.error?.code, failure === 'output-limit' ? 'OUTPUT_LIMIT' : 'PROVIDER_PROTOCOL_ERROR');
  const proof = evidence(f); assert.equal(proof.state, 'confirmed'); assert.equal(proof.cleanupConfirmed, true); assert.equal(proof.method, 'iterator-return-done'); assert.equal(proof.reason, 'consumer-close');
  assert.equal(f.observed.length, 1); assert.equal(attempts(f)[0]!.state, 'failed'); await f.reopen(); assert.deepEqual(evidence(f), proof); await exactRetry(f);
  await assert.doesNotReject(f.engine.coordinator.withWorkspaceLease('workspace', async () => ({ cleanupConfirmed: true })));
});

test('actual pending output flush journal failure still closes the underlying provider and durably records cleanup', { timeout: 30000 }, async t => {
  const f = await fixture(t, (item, signal) => raw(item, signal, [{ type: 'text.delta', delta: 'a'.repeat(32) }, { type: 'text.delta', delta: 'x'.repeat(101) }]), { limits: { maxOutputBytes: 128 } });
  const writer = new DatabaseSync(f.dbPath);
  try {
    writer.exec("CREATE TRIGGER reject_pending_flush BEFORE INSERT ON events WHEN NEW.type='message.delta' AND length(json_extract(NEW.data,'$.payload.delta'))=96 BEGIN SELECT RAISE(ABORT,'synthetic pending flush rejected'); END");
    f.start(); const run = await f.done; assert.equal(run.state, 'failed'); assert.equal(f.observed[0]!.returns, 1);
    const proof = evidence(f); assert.equal(proof.state, 'confirmed'); assert.equal(proof.cleanupConfirmed, true); assert.equal(proof.method, 'iterator-return-done');
    const deltaRows = f.reader.prepare("SELECT data FROM events WHERE run_id=? AND type='message.delta' ORDER BY seq LIMIT 4").all(f.runId);
    assert.equal(deltaRows.length, 1); assert.equal(JSON.parse(String(deltaRows[0]!.data)).payload.delta, 'a'.repeat(32));
    assert.equal(attempts(f)[0]!.state, 'failed'); assert.equal(f.observed.length, 1); writer.exec('DROP TRIGGER reject_pending_flush');
  } finally { writer.close(); }
  await f.reopen(); await exactRetry(f); await assert.doesNotReject(f.engine.coordinator.withWorkspaceLease('workspace', async () => ({ cleanupConfirmed: true })));
});

for (const kind of ['missing','rejected','not-done','timeout'] as const) test(`actual consumer protocol failure with ${kind} underlying return persists unknown cleanup and blocks new work after restart`, { timeout: 30000 }, async t => {
  const f = await fixture(t, (item, signal) => raw(item, signal, [{ type: 'usage', inputTokens: -1 }], kind)); f.start();
  const run = await f.done; assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN');
  const proof = evidence(f); assert.equal(proof.state, 'uncertain'); assert.equal(proof.cleanupConfirmed, false);
  // Proof names describe the registered adapter iterator. The image-input
  // wrapper rejects its return when the raw iterator has no return operation.
  assert.equal(proof.method, ({ missing: 'return-rejected', rejected: 'return-rejected', 'not-done': 'return-not-done', timeout: 'return-timeout' } as const)[kind]);
  assert.equal(f.observed[0]!.returns, kind === 'missing' ? 0 : 1); assert.equal(f.observed.length, 1); assertBlocked(f); await exactRetry(f);
  await f.reopen(); assert.deepEqual(evidence(f), proof); assertBlocked(f);
  await assert.rejects(f.engine.coordinator.withWorkspaceLease('workspace', async () => ({ cleanupConfirmed: true })), code('CLEANUP_PENDING'));
  await exactRetry(f);
});

for (const reason of ['cancel','request-timeout','inactivity-timeout'] as const) test(`actual ordinary ${reason} distinguishes confirmed underlying cleanup from the failed/cancelled execution outcome`, { timeout: 30000 }, async t => {
  const budgets = reason === 'request-timeout' ? { providerRequestTimeoutMs: 100, providerInactivityTimeoutMs: 5000 } : reason === 'inactivity-timeout' ? { providerRequestTimeoutMs: 5000, providerInactivityTimeoutMs: 100 } : {};
  const f = await fixture(t, (item, signal) => raw(item, signal, [], 'done', undefined, true), { budgets }); f.start(); await entered(f);
  if (reason === 'cancel') f.engine.coordinator.cancel(f.runId);
  const run = await f.done; assert.equal(run.state, reason === 'cancel' ? 'cancelled' : 'failed');
  if (reason !== 'cancel') assert.equal(run.error?.code, reason === 'request-timeout' ? 'PROVIDER_REQUEST_TIMEOUT' : 'PROVIDER_INACTIVITY_TIMEOUT');
  const proof = evidence(f); assert.equal(proof.state, 'confirmed'); assert.equal(proof.cleanupConfirmed, true); assert.equal(proof.method, 'iterator-return-done'); assert.equal(f.observed[0]!.returns, 1);
  await f.reopen(); assert.deepEqual(evidence(f), proof); await exactRetry(f);
  if (reason === 'cancel') await assert.doesNotReject(f.engine.coordinator.withWorkspaceLease('workspace', async () => ({ cleanupConfirmed: true })));
  else {
    assert.equal(attempts(f)[0]!.state, 'uncertain'); assertBlocked(f);
    await assert.rejects(f.engine.coordinator.withWorkspaceLease('workspace', async () => ({ cleanupConfirmed: true })), code('CLEANUP_PENDING'));
  }
});

test('actual synchronous provider entry failure has no iterator cleanup proof and is never retried or inferred safe after restart', { timeout: 30000 }, async t => {
  const f = await fixture(t, item => { item.entered.resolve(); throw new EngineError('PROVIDER_HTTP_ERROR', 'Synthetic provider entry threw before returning its iterator', { status: 503 }); });
  f.start(); const run = await f.done; assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); const proof = evidence(f);
  assert.equal(proof.state, 'uncertain'); assert.equal(proof.cleanupConfirmed, false); assert.equal(proof.method, 'return-rejected'); assert.equal(f.observed.length, 1);
  await f.reopen(); assert.deepEqual(evidence(f), proof); assertBlocked(f); await exactRetry(f);
});

test('actual safe HTTP retry records the first return proof before dispatching a second ordinary attempt', { timeout: 30000 }, async t => {
  const f = await fixture(t, (item, signal, index) => index === 0
    ? raw(item, signal, [], 'done', new EngineError('PROVIDER_HTTP_ERROR', 'Synthetic retryable HTTP failure before output', { status: 503, retryAfterMs: 1 }))
    : raw(item, signal, [{ type: 'text.delta', delta: 'Confirmed bounded retry result.' }, { type: 'finish', reason: 'stop' }], 'missing'));
  f.start(); assert.equal((await f.done).state, 'completed'); assert.equal(f.observed.length, 2);
  assert.equal(evidence(f, 0).method, 'iterator-return-done'); assert.equal(evidence(f, 1).method, 'iterator-next-done');
  assert.deepEqual(attempts(f).map(attempt => attempt.state), ['failed','completed']);
  for (const journal of ['events','session_events']) {
    const rows = f.reader.prepare(`SELECT type,data FROM ${journal} WHERE run_id=? ORDER BY seq LIMIT 128`).all(f.runId);
    const confirmed = rows.findIndex(row => row.type === 'provider.cleanup.confirmed' && String(row.data).includes(f.observed[0]!.request.attemptId!));
    const secondDispatch = rows.findIndex(row => row.type === 'provider.cleanup.dispatched' && String(row.data).includes(f.observed[1]!.request.attemptId!));
    assert.ok(confirmed >= 0 && secondDispatch > confirmed, 'Second dispatch requires the first durable confirmed cleanup observation');
  }
  await f.reopen(); await exactRetry(f);
});

for (const journal of ['events','session_events'] as const) test(`actual ${journal} cleanup-proof publication failure preserves uncertainty and rolls back both confirmation audits`, { timeout: 30000 }, async t => {
  const f = await fixture(t, (item, signal) => raw(item, signal, [{ type: 'text.delta', delta: 'Synthetic public text before durable cleanup.' }, { type: 'finish', reason: 'stop' }]));
  const writer = new DatabaseSync(f.dbPath);
  try {
    writer.exec(`CREATE TRIGGER reject_ordinary_cleanup BEFORE INSERT ON ${journal} WHEN NEW.type='provider.cleanup.confirmed' BEGIN SELECT RAISE(ABORT,'synthetic cleanup proof audit rejected'); END`);
    f.start(); const run = await f.done; assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(f.observed.length, 1);
    const before = evidence(f); assert.equal(before.state, 'dispatched'); assert.equal(before.cleanupConfirmed, null);
    for (const table of ['events','session_events']) assert.equal(Number(f.reader.prepare(`SELECT count(*) AS count FROM ${table} WHERE run_id=? AND type='provider.cleanup.confirmed'`).get(f.runId)!.count), 0);
    assertBlocked(f); await exactRetry(f); writer.exec('DROP TRIGGER reject_ordinary_cleanup');
  } finally { writer.close(); }
  await f.reopen(); const recovered = evidence(f); assert.equal(recovered.state, 'uncertain'); assert.equal(recovered.cleanupConfirmed, false); assert.equal(recovered.method, 'recovery'); assert.equal(recovered.reason, 'restart');
  assertBlocked(f); await exactRetry(f); assert.equal(f.observed.length, 1);
});

test('actual archive preserves uncertain ordinary cleanup and import blocks fresh admission without autonomous redispatch', { timeout: 30000 }, async t => {
  const f = await fixture(t, (item, signal) => raw(item, signal, [{ type: 'usage', inputTokens: -1 }], 'missing')); f.start(); await f.done;
  const proof = evidence(f), attempt = f.engine.store.getAttempt(proof.attemptId); await f.engine.close();
  const archive = await exportEngineArchive({ dbPath: f.dbPath, artifactDir: f.artifactDir, destination: join(f.root, 'archive') });
  assert.equal(archive.manifest.databases.find(database => database.role === 'primary')!.schemaVersion, 6);
  const imported = await importEngineArchive({ directory: archive.directory, destination: join(f.root, 'restored') }); assert.equal(imported.executionResumed, false);
  const restored = createEngine({ ...f.options, dbPath: imported.dbPath, artifactDir: imported.artifactDir }); t.after(() => restored.close());
  restored.store.getSnapshot = () => { throw new Error('Imported cleanup fixture forbids whole snapshots'); };
  assert.deepEqual(restored.store.getAttemptCleanup(proof.attemptId, 'session'), proof); assert.deepEqual(restored.store.getAttempt(proof.attemptId), attempt);
  assert.throws(() => restored.coordinator.submit({ sessionId: 'other-session', requestId: 'new-imported-work', prompt: 'Explicit new task', config: restored.getCapabilities().defaults }), code('CLEANUP_PENDING'));
  await assert.rejects(restored.coordinator.withWorkspaceLease('workspace', async () => ({ cleanupConfirmed: true })), code('CLEANUP_PENDING'));
  assert.equal(f.observed.length, 1); assert.equal(f.fullReads(), 0);
});

async function overflowFixture(t: TestContext) {
  const nonce = 'SYNTHETIC_OVERFLOW_NONCE=0123456789abcdef0123456789abcdef';
  const f = await fixture(t, (item, signal, index) => {
    if (index === 0) return raw(item, signal, [{ type: 'text.delta', delta: nonce + '\n' + 'Synthetic historical discussion. '.repeat(285) }, { type: 'finish', reason: 'stop' }]);
    if (index === 1) return raw(item, signal, [], 'done', new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'Synthetic actual overflow before any current output'));
    if (item.request.tools.length === 0) {
      assert.equal(item.request.turnId, undefined);
      const quoted = JSON.parse(item.request.messages.findLast(message => message.role === 'user')!.content) as { content: string }[];
      assert.ok(quoted.some(message => message.content.includes(nonce)), 'The summary must use actual persisted historical observations');
      return raw(item, signal, [{ type: 'usage', inputTokens: 9 }, { type: 'text.delta', delta: 'Synthetic partial overflow memory.' }], 'missing', new EngineError('PROVIDER_TRANSPORT_ERROR', 'Synthetic overflow summary cleanup is unknown'));
    }
    return raw(item, signal, [{ type: 'text.delta', delta: 'Explicit new task after the exact host decision.' }, { type: 'finish', reason: 'stop' }]);
  }, { limits: { maxContextBytes: 16384, maxOutputBytes: 32768 } });
  const old = f.engine.coordinator.submit({ sessionId: 'session', requestId: 'historical', prompt: 'Exact synthetic historical overflow goal.', config: f.engine.getCapabilities().defaults });
  assert.equal((await f.engine.waitForRun(old.runId)).state, 'completed');
  f.start(); const run = await f.done; assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(f.observed.length, 3);
  const ordinary = f.observed[1]!.request, summaryId = f.observed[2]!.request.attemptId!, proof = evidence(f, 1), turn = f.engine.store.getTurn(ordinary.turnId!);
  assert.equal(proof.state, 'confirmed'); assert.equal(proof.method, 'iterator-return-done'); assert.equal(f.engine.store.getAttempt(ordinary.attemptId!).state, 'failed');
  assert.equal(turn.state, 'uncertain'); assert.equal(turn.uncertainty?.kind, 'cleanup');
  assert.equal(turn.uncertainty?.summaryDependency?.summaryAttemptId, summaryId); assert.equal(turn.uncertainty?.summaryDependency?.failedAttemptId, ordinary.attemptId);
  assert.match(turn.uncertainty?.summaryDependency?.cleanupRecordSha256 ?? '', /^[a-f0-9]{64}$/u);
  const summary = f.engine.store.getSummaryAttempt(summaryId, 'session'); assert.equal(summary.state, 'uncertain'); assert.equal(summary.cleanupConfirmed, false); assert.equal(summary.currentTurnId, ordinary.turnId); assert.equal(summary.failedAttemptId, ordinary.attemptId);
  assertBlocked(f); return { f, ordinary, summaryId, proof, turn, summary, run };
}

test('actual overflow summary uncertainty can be acknowledged only through its exact failed ordinary attempt cleanup dependency', { timeout: 30000 }, async t => {
  const { f, ordinary, summaryId, proof, turn, summary, run } = await overflowFixture(t); await f.reopen();
  const preview = f.engine.getSummaryRecoveryPreview('session', summaryId); assert.equal(preview.status, 'eligible', JSON.stringify(preview)); assert.ok(preview.fingerprint);
  const receipt = await f.engine.acknowledgeSummaryRecovery({ sessionId: 'session', summaryAttemptId: summaryId, requestId: 'explicit-overflow-decision', fingerprint: preview.fingerprint, acknowledged: true });
  assert.equal(receipt.state, 'uncertain'); assert.equal(receipt.cleanupConfirmed, false); assert.equal(receipt.executionResumed, false);
  assert.deepEqual(f.engine.store.getTurn(ordinary.turnId!), turn); assert.deepEqual(f.engine.store.getSummaryAttempt(summaryId, 'session'), summary); assert.deepEqual(evidence(f, 1), proof); assert.equal(f.observed.length, 3);
  const nextConfig = { ...run.config, limits: { ...run.config.limits, maxContextBytes: 262144 } };
  const next = f.engine.coordinator.submit({ sessionId: 'session', requestId: 'new-after-overflow-decision', prompt: 'Explicit new independent task.', config: nextConfig });
  assert.equal((await f.engine.waitForRun(next.runId)).state, 'completed'); assert.equal(f.observed.length, 4); assert.deepEqual(f.engine.store.getTurn(ordinary.turnId!), turn); assert.equal(f.fullReads(), 0);
});

for (const corruption of ['cleanup-payload','source-text','dependency-hash','unrelated-attempt'] as const) test(`actual overflow host ACK fails closed after independent ${corruption} corruption without clearing other execution uncertainty`, { timeout: 30000 }, async t => {
  const { f, ordinary, summaryId, summary } = await overflowFixture(t); await f.reopen();
  const originalPreview = f.engine.getSummaryRecoveryPreview('session', summaryId); assert.equal(originalPreview.status, 'eligible');
  const writer = new DatabaseSync(f.dbPath);
  try {
    if (corruption === 'cleanup-payload') writer.prepare("UPDATE attempt_cleanup SET data=json_set(data,'$.requestSha256',?) WHERE attempt_id=?").run('f'.repeat(64), ordinary.attemptId!);
    if (corruption === 'source-text') writer.prepare("UPDATE messages SET data=json_set(data,'$.content','Synthetic changed historical observation.') WHERE id=?").run(summary.sourceMessageIds![0]!);
    if (corruption === 'dependency-hash') writer.prepare("UPDATE session_turns SET data=json_set(data,'$.uncertainty.summaryDependency.cleanupRecordSha256',?) WHERE id=?").run('f'.repeat(64), ordinary.turnId!);
    if (corruption === 'unrelated-attempt') writer.prepare("UPDATE provider_attempts SET state='uncertain',data=json_set(data,'$.state','uncertain','$.uncertainty',json(?)) WHERE id=?").run(JSON.stringify({ kind: 'provider_dispatch', message: 'Synthetic independent ordinary outcome uncertainty.', requiresRecovery: true }), f.observed[0]!.request.attemptId!);
  } finally { writer.close(); }
  const preview = f.engine.getSummaryRecoveryPreview('session', summaryId); assert.equal(preview.status, 'blocked', JSON.stringify(preview)); assert.ok(preview.blockers.length > 0);
  await assert.rejects(f.engine.acknowledgeSummaryRecovery({ sessionId: 'session', summaryAttemptId: summaryId, requestId: 'must-not-waive-corruption', fingerprint: originalPreview.fingerprint!, acknowledged: true }));
  assert.equal(Number(f.reader.prepare('SELECT count(*) AS count FROM summary_recovery_acknowledgments').get()!.count), 0);
  assertBlocked(f); assert.equal(f.engine.store.getSummaryAttempt(summaryId).state, 'uncertain'); assert.equal(f.observed.length, 3); assert.equal(f.fullReads(), 0);
});

test('truthy nonboolean registered provider completion cannot synthesize confirmed cleanup', { timeout: 30000 }, async t => {
  const f = await fixture(t, () => {
    const iterator: AsyncIterableIterator<ProviderEvent> = { [Symbol.asyncIterator]() { return iterator; }, async next() {
      return { done: 'invalid' as unknown as true, value: undefined };
    } }; return iterator;
  });
  f.start(); assert.equal((await f.done).error?.code, 'CLEANUP_UNCERTAIN');
  const proof = evidence(f); assert.equal(proof.state, 'uncertain'); assert.equal(proof.cleanupConfirmed, false); assert.equal(proof.method, 'return-rejected');
  assertBlocked(f); await f.reopen(); assertBlocked(f); assert.equal(f.observed.length, 1); assert.equal(f.fullReads(), 0);
});

for (const phase of ['summary-usage','summary-uncertain'] as const) test(`actual SIGKILL at overflow ${phase} retains confirmed ordinary cleanup and permits an exact host decision for an interrupted origin`, { timeout: 30000, skip: process.platform === 'win32' }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-overflow-cleanup-crash-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = import.meta.url.endsWith('.ts'), extension = source ? 'ts' : import.meta.url.endsWith('.mjs') ? 'mjs' : 'js';
  const path = fileURLToPath(new URL(`./fixtures/overflow-cleanup-child.${extension}`, import.meta.url));
  const child = spawn(process.execPath, [...(source ? ['--import','tsx'] : []), path, root, phase], { stdio: ['ignore','ignore','pipe','ipc'] });
  let diagnostics = '';
  child.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-8192); });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const ready = await new Promise<{ phase: string; summaryAttemptId: string; turnId: string; attemptId: string; runId: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Overflow child missed ${phase}: ${diagnostics}`)), 12000);
    child.once('message', message => { clearTimeout(timer); resolve(message as Awaited<typeof ready>); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Overflow child exited before ${phase}: ${diagnostics}`)); });
  });
  assert.equal(ready.phase, phase);
  const dbPath = join(root, 'engine.sqlite'), reader = new DatabaseSync(dbPath, { readOnly: true });
  const read = (table: string, key: string, id: string) => JSON.parse(String(reader.prepare(`SELECT data FROM ${table} WHERE ${key}=?`).get(id)!.data));
  const originalProof = read('attempt_cleanup', 'attempt_id', ready.attemptId), originalAttempt = read('provider_attempts', 'id', ready.attemptId);
  assert.equal(originalProof.state, 'confirmed'); assert.equal(originalProof.method, 'iterator-return-done'); assert.equal(originalAttempt.state, 'failed');
  assert.equal(read('session_turns', 'id', ready.turnId).state, 'created');
  assert.equal(read('summary_attempts', 'id', ready.summaryAttemptId).state, phase === 'summary-usage' ? 'streaming' : 'uncertain');
  reader.close(); child.kill('SIGKILL'); await exited;
  assert.equal(await readFile(join(root, 'calls.log'), 'utf8'), '1\n2\n3\n');
  let calls = 0, fullReads = 0;
  const provider: ProviderAdapter = { id: 'overflow-cleanup-crash', async *streamTurn() { calls++; yield { type: 'text.delta', delta: 'Explicit new independent task.' }; yield { type: 'finish', reason: 'stop' }; } };
  const options: EngineOptions = { dbPath, artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: ['read_file'],
    defaults: { providerId: provider.id, modelId: 'fixture-model', mode: 'plan', limits: { maxContextBytes: 262144, maxOutputBytes: 32768 } } };
  let engine = createEngine(options); t.after(() => engine.close());
  const trap = () => { engine.store.getSnapshot = () => { fullReads++; throw new Error('Overflow recovery forbids full snapshots'); }; }; trap();
  const interrupted = engine.store.getTurn(ready.turnId), summary = engine.getSummaryAttempt('session', ready.summaryAttemptId);
  assert.equal(interrupted.state, 'interrupted'); assert.equal(interrupted.uncertainty, undefined); assert.equal(engine.store.getRun(ready.runId).state, 'interrupted');
  assert.equal(summary.state, 'uncertain'); assert.equal(summary.cleanupConfirmed, false); assert.equal(summary.publication, 'discarded');
  assert.deepEqual(engine.getAttemptCleanup('session', ready.attemptId), originalProof); assert.deepEqual(engine.store.getAttempt(ready.attemptId), originalAttempt);
  assert.equal(calls, 0); assert.equal(engine.store.hasUncertainSummaries('workspace'), true);
  const preview = engine.getSummaryRecoveryPreview('session', ready.summaryAttemptId); assert.equal(preview.status, 'eligible', JSON.stringify(preview)); assert.ok(preview.fingerprint);
  const control = engine.store.getSessionControl('session'), memory = engine.store.getSessionDocument('session', 'context.memory');
  const decision = { sessionId: 'session', summaryAttemptId: ready.summaryAttemptId, requestId: `crash-${phase}`, fingerprint: preview.fingerprint, acknowledged: true as const };
  const receipt = await engine.acknowledgeSummaryRecovery(decision); assert.equal(receipt.executionResumed, false); assert.equal(receipt.cleanupConfirmed, false);
  assert.deepEqual(engine.store.getTurn(ready.turnId), interrupted); assert.deepEqual(engine.getSummaryAttempt('session', ready.summaryAttemptId), summary);
  assert.deepEqual(engine.store.getSessionControl('session'), control); assert.deepEqual(engine.store.getSessionDocument('session', 'context.memory'), memory); assert.equal(calls, 0);
  const next = engine.coordinator.submit({ sessionId: 'session', requestId: 'explicit-new-work', prompt: 'Explicit new task after host decision.', config: engine.getCapabilities().defaults });
  assert.equal((await engine.waitForRun(next.runId)).state, 'completed'); await engine.waitForSession('session'); assert.equal(calls, 1);
  await engine.close(); engine = createEngine(options); trap();
  assert.deepEqual(await engine.acknowledgeSummaryRecovery(decision), { ...receipt, duplicate: true });
  assert.deepEqual(engine.store.getTurn(ready.turnId), interrupted); assert.deepEqual(engine.getSummaryAttempt('session', ready.summaryAttemptId), summary);
  assert.deepEqual(engine.getAttemptCleanup('session', ready.attemptId), originalProof); assert.deepEqual(engine.store.getAttempt(ready.attemptId), originalAttempt);
  assert.equal(engine.store.hasUncertainSummaries('workspace'), false); assert.equal(calls, 1); assert.equal(fullReads, 0);
});
