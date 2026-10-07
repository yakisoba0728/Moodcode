import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as tick } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { EngineError, type RunConfig } from '@moodcode/contracts';
import { createEngine, type EngineOptions, type MoodcodeEngine } from '../engine.js';
import { SqliteStore } from '../storage/index.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { measureRecoveryRead } from './fixtures/recovery-read-measure.js';

// All dispatches below are authored local iterators and all decisions target a
// private temporary database. No real account, command tool or GUI is used.
const WORKSPACE = 'workspace';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
type Origin = 'provider' | 'summary' | 'overflow';
interface Candidate { origin: Origin; sessionId: string; runId: string; attemptId?: string; turnId?: string; summaryId?: string }
interface Fixture {
  root: string; dbPath: string; reader: DatabaseSync; writer: DatabaseSync; engine: MoodcodeEngine; options: EngineOptions;
  requests: TurnRequest[]; candidates: Candidate[]; fullReads(): number; reopen(): Promise<void>;
  session(id: string): void; config(maxContextBytes?: number): RunConfig; submit(sessionId: string, requestId: string, prompt: string, config?: RunConfig): Promise<string>;
  provider(sessionId: string, bytes?: number, sharedHistory?: boolean, acknowledge?: boolean): Promise<Candidate>;
  summary(sessionId: string, bytes?: number): Promise<Candidate>;
  overflow(sessionId: string): Promise<Candidate>;
  acknowledge(candidate: Candidate): Promise<void>; immutable(): string;
}
function construct(options: EngineOptions, onRead: () => void): MoodcodeEngine {
  const original = SqliteStore.prototype.getSnapshot;
  const trap = () => { onRead(); throw new Error('Recovery read scope forbids whole session snapshots, including startup'); };
  SqliteStore.prototype.getSnapshot = trap;
  try { const engine = createEngine(options); engine.store.getSnapshot = trap; return engine; }
  finally { SqliteStore.prototype.getSnapshot = original; }
}
function raw(events: ProviderEvent[], failure?: EngineError, cleanup = true): AsyncIterableIterator<ProviderEvent> {
  let index = 0;
  const iterator: AsyncIterableIterator<ProviderEvent> = { [Symbol.asyncIterator]() { return iterator; }, async next() {
    if (index < events.length) return { done: false, value: events[index++]! };
    if (failure) throw failure;
    return { done: true, value: undefined };
  } };
  if (cleanup) iterator.return = async () => ({ done: true, value: undefined });
  return iterator;
}
const historyGoal = (bytes: number) => `HISTORY|${bytes}`;
const ordinaryGoal = (bytes: number) => `ORDINARY|${bytes}`;
const summaryGoal = (bytes: number) => 'SUMMARY_CURRENT|' + 'g'.repeat(bytes);
async function fixture(t: TestContext): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-recovery-read-'))), repository = join(root, 'repository'), dbPath = join(root, 'engine.sqlite');
  await mkdir(repository); let f!: Fixture, fullReads = 0; const requests: TurnRequest[] = [];
  const provider: ProviderAdapter = { id: 'recovery-read-fixture', streamTurn(request) {
    requests.push(structuredClone(request));
    if (request.tools.length === 0) {
      const quoted = JSON.parse(request.messages.findLast(message => message.role === 'user')!.content) as { content: string }[];
      assert.ok(quoted.some(message => message.content.includes('HISTORY_SOURCE=') || message.content.startsWith('public-ordinary-observation:')));
      return raw([{ type: 'usage', inputTokens: 9 }, { type: 'text.delta', delta: 'Synthetic partial historical memory.' }], new EngineError('PROVIDER_TRANSPORT_ERROR', 'Synthetic summary underlying cleanup is unknown'), false);
    }
    const goal = request.messages.findLast(message => message.role === 'user')?.content ?? '';
    if (goal.startsWith('HISTORY|')) {
      const bytes = Number(goal.slice('HISTORY|'.length)), prefix = 'HISTORY_SOURCE=owned-public-fixture\n';
      return raw([{ type: 'text.delta', delta: prefix + 'h'.repeat(bytes - Buffer.byteLength(prefix)) }, { type: 'finish', reason: 'stop' }]);
    }
    if (goal.startsWith('ORDINARY|')) {
      const bytes = Number(goal.slice('ORDINARY|'.length)), prefix = 'public-ordinary-observation:';
      return raw([{ type: 'usage', inputTokens: 11, outputTokens: 3 }, { type: 'text.delta', delta: prefix + 'p'.repeat(Math.max(0, bytes - Buffer.byteLength(prefix))) }], new EngineError('PROVIDER_TRANSPORT_ERROR', 'Synthetic ordinary outcome remains unknown after actual return'));
    }
    if (goal === 'OVERFLOW_CURRENT') return raw([], new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'Synthetic actual ordinary overflow before output'));
    return raw([{ type: 'text.delta', delta: 'Explicit independent work completed.' }, { type: 'finish', reason: 'stop' }]);
  } };
  const options: EngineOptions = { dbPath, artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: ['read_file'],
    defaults: { providerId: provider.id, modelId: 'fixture-model', mode: 'plan', limits: { maxContextBytes: 262144, maxOutputBytes: 1048576, maxDurationMs: 30000 },
      budgets: { maxProviderAttempts: 2, providerRequestTimeoutMs: 10000, providerInactivityTimeoutMs: 10000, maxSummaryBytes: 1048576 } } };
  const engine = construct(options, () => fullReads++), read = new DatabaseSync(dbPath, { readOnly: true }), writer = new DatabaseSync(dbPath);
  f = { root, dbPath, reader: read, writer, engine, options, requests, candidates: [], fullReads: () => fullReads,
    async reopen() { await f.engine.close(); f.engine = construct(options, () => fullReads++); await tick(); },
    session(id) { const createdAt = new Date().toISOString(); f.engine.store.createSession({ id, workspaceId: WORKSPACE, title: id, createdAt }); },
    config(maxContextBytes = 262144) { const config = f.engine.getCapabilities().defaults; return { ...config, limits: { ...config.limits, maxContextBytes } }; },
    async submit(sessionId, requestId, prompt, config = f.config()) {
      const receipt = f.engine.coordinator.submit({ sessionId, requestId, prompt, config }); await f.engine.waitForRun(receipt.runId); await f.engine.waitForSession(sessionId); return receipt.runId;
    },
    async provider(sessionId, bytes = 128, sharedHistory = false, acknowledge = true) {
      f.session(sessionId);
      if (sharedHistory) { const id = await f.submit(sessionId, 'history', historyGoal(9000)); assert.equal(f.engine.store.getRun(id).state, 'completed'); }
      const runId = await f.submit(sessionId, 'ordinary', ordinaryGoal(bytes)), request = requests.findLast(item => item.runId === runId)!;
      assert.equal(f.engine.store.getRun(runId).state, 'failed'); assert.equal(f.engine.store.getAttempt(request.attemptId!).state, 'uncertain');
      assert.equal(f.engine.getAttemptCleanup(sessionId, request.attemptId!).cleanupConfirmed, true);
      const candidate: Candidate = { origin: 'provider', sessionId, runId, attemptId: request.attemptId!, turnId: request.turnId! }; f.candidates.push(candidate); await f.reopen(); if (acknowledge) await f.acknowledge(candidate); return candidate;
    },
    async summary(sessionId, bytes = 9000) {
      f.session(sessionId); const history = await f.submit(sessionId, 'history', historyGoal(bytes)); assert.equal(f.engine.store.getRun(history).state, 'completed');
      const large = bytes > 65536, runId = await f.submit(sessionId, 'summary-current', summaryGoal(large ? 120000 : 8000), f.config(large ? bytes + 40000 : 16384));
      const request = requests.findLast(item => item.runId === runId && item.tools.length === 0); assert.ok(request, JSON.stringify(f.engine.store.getRun(runId).error));
      assert.equal(f.engine.store.getRun(runId).error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(f.engine.getSummaryAttempt(sessionId, request.attemptId!).state, 'uncertain');
      const candidate: Candidate = { origin: 'summary', sessionId, runId, summaryId: request.attemptId! }; f.candidates.push(candidate); await f.reopen(); await f.acknowledge(candidate); return candidate;
    },
    async overflow(sessionId) {
      f.session(sessionId); const old = await f.submit(sessionId, 'history', historyGoal(9000), f.config(16384)); assert.equal(f.engine.store.getRun(old).state, 'completed');
      const runId = await f.submit(sessionId, 'overflow', 'OVERFLOW_CURRENT', f.config(16384));
      const ordinary = requests.find(item => item.runId === runId && item.tools.length > 0), summary = requests.find(item => item.runId === runId && item.tools.length === 0); assert.ok(ordinary && summary);
      const turn = f.engine.store.getTurn(ordinary.turnId!); assert.equal(turn.uncertainty?.summaryDependency?.summaryAttemptId, summary.attemptId);
      assert.equal(f.engine.getAttemptCleanup(sessionId, ordinary.attemptId!).cleanupConfirmed, true); assert.equal(f.engine.store.getAttempt(ordinary.attemptId!).state, 'failed');
      const candidate: Candidate = { origin: 'overflow', sessionId, runId, attemptId: ordinary.attemptId!, turnId: ordinary.turnId!, summaryId: summary.attemptId! }; f.candidates.push(candidate); await f.reopen(); await f.acknowledge(candidate); return candidate;
    },
    async acknowledge(candidate) {
      if (candidate.origin === 'provider') {
        const preview = f.engine.getProviderRecoveryPreview(candidate.sessionId, candidate.attemptId!); assert.equal(preview.status, 'eligible', JSON.stringify(preview));
        await f.engine.acknowledgeProviderRecovery({ sessionId: candidate.sessionId, attemptId: candidate.attemptId!, requestId: `host-provider-${candidate.sessionId}`, fingerprint: preview.fingerprint!, acknowledged: true });
      } else {
        const preview = f.engine.getSummaryRecoveryPreview(candidate.sessionId, candidate.summaryId!); assert.equal(preview.status, 'eligible', JSON.stringify(preview));
        await f.engine.acknowledgeSummaryRecovery({ sessionId: candidate.sessionId, summaryAttemptId: candidate.summaryId!, requestId: `host-summary-${candidate.sessionId}`, fingerprint: preview.fingerprint!, acknowledged: true });
      }
    },
    immutable() {
      const tables = ['runs','session_turns','provider_attempts','attempt_cleanup','attempt_usage','messages','message_parts','tools','context_revisions','session_inputs','session_controls','session_documents','summary_attempts','summary_usage','provider_recovery_acknowledgments','summary_recovery_acknowledgments'];
      return sha(JSON.stringify(tables.map(table => [table, read.prepare(`SELECT data FROM ${table} ORDER BY rowid LIMIT 1025`).all().map(row => String(row.data))])));
    },
  };
  t.after(async () => { try { await f.engine.close(); } finally { read.close(); writer.close(); await rm(root, { recursive: true, force: true }); } });
  const createdAt = new Date().toISOString(); engine.store.putWorkspace({ id: WORKSPACE, root: repository, gitRoot: repository, branch: null, createdAt }); return f;
}
function database(f: Fixture): DatabaseSync { return (f.engine.store as unknown as { db: DatabaseSync }).db; }
function combined(f: Fixture): boolean {
  const store = f.engine.store as SqliteStore & { hasUncertainWorkspace?: (workspaceId: string) => boolean };
  assert.equal(typeof store.hasUncertainWorkspace, 'function', 'Combined persistent predicate must be wired to the actual engine store');
  return store.hasUncertainWorkspace!(WORKSPACE);
}
function unchangedRead(f: Fixture, operation: () => boolean) {
  const original = f.immutable(), dispatches = f.requests.length, observed = measureRecoveryRead(database(f), operation);
  assert.equal(observed.measurement.writeStatements, 0); assert.equal(observed.measurement.changedRows, 0);
  assert.equal(f.immutable(), original); assert.equal(f.requests.length, dispatches); assert.equal(f.fullReads(), 0); return observed;
}
async function mixed(t: TestContext) {
  const f = await fixture(t); await f.provider('provider-session', 128, true); await f.summary('summary-session'); await f.overflow('overflow-session'); return f;
}

test('baseline actual mixed Provider ACK, Summary ACK and overflow Turn proofs return bounded SQL evidence without mutation', { timeout: 90000 }, async t => {
  const f = await mixed(t), summaries = unchangedRead(f, () => f.engine.store.hasUncertainSummaries(WORKSPACE)), execution = unchangedRead(f, () => f.engine.store.hasUncertainExecution(WORKSPACE));
  assert.equal(summaries.result, false); assert.equal(execution.result, false);
  t.diagnostic(JSON.stringify({ kind: 'actual-private-engine-mixed-origin-baseline', scope: 'SQL-values-and-raw-JSON-bodies-returned-to-JavaScript;not-physical-I/O', summaries: summaries.measurement, execution: execution.measurement }));
});

test('actual combined workspace inspection reuses each immutable source once per transaction and discards the cache after return', { timeout: 90000 }, async t => {
  const f = await mixed(t), first = unchangedRead(f, () => combined(f)); assert.equal(first.result, false);
  const full = Object.entries(first.measurement.bodyReads).filter(([key]) => key.startsWith('messages:') || key.startsWith('context_revisions:'));
  assert.ok(full.length > 0); assert.ok(full.every(([, count]) => count === 1), JSON.stringify(full));
  const second = unchangedRead(f, () => combined(f)); assert.equal(second.result, false);
  assert.deepEqual(second.measurement.bodyReads, first.measurement.bodyReads); assert.equal(second.measurement.returnedBodyBytes, first.measurement.returnedBodyBytes);
  t.diagnostic(JSON.stringify({ kind: 'actual-mixed-shared-transaction', ...first.measurement }));
});

test('actual mixed recovery domains independently below 8MiB fail closed at their combined distinct body budget', { timeout: 180000 }, async t => {
  const f = await fixture(t), bytes = 700 * 1024;
  for (let index = 0; index < 5; index++) await f.provider(`provider-${index}`, bytes);
  for (let index = 0; index < 2; index++) await f.summary(`summary-${index}`, bytes);
  const summaries = unchangedRead(f, () => f.engine.store.hasUncertainSummaries(WORKSPACE)), execution = unchangedRead(f, () => f.engine.store.hasUncertainExecution(WORKSPACE));
  assert.equal(summaries.result, false, JSON.stringify(summaries.measurement)); assert.equal(execution.result, false, JSON.stringify(execution.measurement));
  assert.ok(summaries.measurement.uniqueBodyBytes < 8388608); assert.ok(execution.measurement.uniqueBodyBytes < 8388608);
  const unionBytes = Object.values({ ...summaries.measurement.bodyBytes, ...execution.measurement.bodyBytes }).reduce((sum, value) => sum + value, 0);
  assert.ok(unionBytes > 8388608, 'This fixture must actually exceed the distinct aggregate, rather than a domain cap');
  const all = unchangedRead(f, () => combined(f)); assert.equal(all.result, true); assert.ok(all.measurement.returnedBodyBytes <= 8388608, JSON.stringify(all.measurement));
  const lastPart = f.reader.prepare('SELECT id FROM message_parts WHERE run_id=? ORDER BY part_index LIMIT 1').get(f.candidates.findLast(item => item.origin === 'provider')!.runId)!;
  assert.equal(all.measurement.bodyReads[`message_parts:${String(lastPart.id)}:full`], undefined, 'The row that would exceed the aggregate must not return its body');
  f.session('queued-session'); f.engine.scheduler.pause('queued-session');
  const queued = f.engine.scheduler.accept({ sessionId: 'queued-session', requestId: 'preserved-backlog', prompt: 'Explicit future work', config: f.config(), delivery: 'queue' }); await tick();
  const original = f.immutable(), dispatches = f.requests.length;
  const cleanupPending = (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_PENDING';
  assert.throws(() => f.engine.coordinator.submit({ sessionId: 'provider-0', requestId: 'new-blocked', prompt: 'Explicit new work', config: f.config() }), cleanupPending);
  assert.throws(() => f.engine.scheduler.resume('queued-session'), cleanupPending);
  assert.equal(f.engine.store.getInput(queued.inputId).state, 'pending'); assert.equal(f.immutable(), original); assert.equal(f.requests.length, dispatches);
  t.diagnostic(JSON.stringify({ kind: 'actual-mixed-aggregate-byte-cap', scope: 'raw-JSON-body-bytes;SQL-metadata-and-physical-I/O-excluded', unionBytes, summaries: summaries.measurement, execution: execution.measurement, combined: all.measurement }));
});

test('actual source mutations, deletion and native owner changes are rechecked after a prior successful workspace read', { timeout: 90000 }, async t => {
  const f = await mixed(t), candidate = f.candidates.find(item => item.origin === 'summary')!, attempt = f.engine.getSummaryAttempt(candidate.sessionId, candidate.summaryId!);
  assert.ok(attempt.sourceMessageIds);
  const id = attempt.sourceMessageIds.at(-1)!, row = f.reader.prepare('SELECT session_id,data FROM messages WHERE id=?').get(id)!;
  assert.equal(unchangedRead(f, () => combined(f)).result, false);
  const data = JSON.parse(String(row.data)) as { content: string };
  f.writer.prepare('UPDATE messages SET data=? WHERE id=?').run(JSON.stringify({ ...data, content: data.content.replace('owned-public-fixture', 'other-public-fixture') }), id);
  assert.equal(unchangedRead(f, () => combined(f)).result, true);
  f.writer.prepare('UPDATE messages SET data=? WHERE id=?').run(String(row.data), id);
  assert.equal(unchangedRead(f, () => combined(f)).result, false);
  f.writer.prepare('UPDATE messages SET session_id=? WHERE id=?').run('provider-session', id);
  const owner = unchangedRead(f, () => combined(f)); assert.equal(owner.result, true); assert.equal(owner.measurement.bodyReads[`messages:${id}:full`], undefined);
  f.writer.prepare('UPDATE messages SET session_id=? WHERE id=?').run(String(row.session_id), id);
  assert.equal(unchangedRead(f, () => combined(f)).result, false);
  f.writer.exec('BEGIN IMMEDIATE'); f.writer.prepare('DELETE FROM messages WHERE id=?').run(id); f.writer.exec('COMMIT');
  const absent = unchangedRead(f, () => combined(f)); assert.equal(absent.result, true); assert.equal(absent.measurement.bodyReads[`messages:${id}:full`], undefined);
});

test('actual large foreign summary source is rejected from owner metadata without fetching its body', { timeout: 90000 }, async t => {
  const f = await fixture(t), candidate = await f.summary('summary-session'); f.session('foreign-session');
  const foreignRun = await f.submit('foreign-session', 'foreign-history', historyGoal(700 * 1024)); assert.equal(f.engine.store.getRun(foreignRun).state, 'completed');
  const foreign = f.reader.prepare("SELECT id,length(CAST(data AS BLOB)) AS bytes FROM messages WHERE run_id=? AND json_extract(data,'$.role')='assistant' LIMIT 1").get(foreignRun)!;
  assert.ok(Number(foreign.bytes) > 700000);
  const attempt = f.engine.getSummaryAttempt(candidate.sessionId, candidate.summaryId!);
  assert.ok(attempt.sourceMessageIds);
  f.writer.prepare('UPDATE summary_attempts SET data=? WHERE id=?').run(JSON.stringify({ ...attempt, sourceMessageIds: [attempt.sourceMessageIds[0], String(foreign.id)] }), attempt.id);
  const original = f.immutable(), dispatches = f.requests.length;
  const result = measureRecoveryRead(database(f), () => f.engine.getSummaryRecoveryPreview(candidate.sessionId, candidate.summaryId!));
  assert.equal(result.result.status, 'blocked'); assert.ok(result.result.blockers.includes('SUMMARY_RECOVERY_OWNER_MISMATCH'), JSON.stringify(result.result));
  assert.equal(result.measurement.bodyReads[`messages:${String(foreign.id)}:full`], undefined);
  assert.equal(result.measurement.writeStatements, 0); assert.equal(result.measurement.changedRows, 0); assert.equal(f.immutable(), original); assert.equal(f.requests.length, dispatches); assert.equal(f.fullReads(), 0);
});

test('actual new Runs and document CAS receive fresh evidence while immutable host acknowledgments retain their meaning', { timeout: 90000 }, async t => {
  const f = await mixed(t), candidate = f.candidates.find(item => item.origin === 'provider')!;
  assert.equal(unchangedRead(f, () => combined(f)).result, false);
  const oldHead = f.engine.store.getSessionDocument(candidate.sessionId, 'context.head')!;
  f.engine.store.putSessionDocument(candidate.sessionId, 'context.head', oldHead.revision, { ...oldHead.data, fixtureObservation: true });
  assert.equal(unchangedRead(f, () => combined(f)).result, false, 'A later mutable head is not historical proof corruption');
  assert.equal(f.engine.getProviderRecoveryPreview(candidate.sessionId, candidate.attemptId!).status, 'acknowledged');
  const runId = await f.submit(candidate.sessionId, 'explicit-new-run', 'Explicit new independent work'); assert.equal(f.engine.store.getRun(runId).state, 'completed');
  assert.notEqual(f.engine.store.getSessionDocument(candidate.sessionId, 'context.head')!.data.revisionId, oldHead.data.revisionId);
  const current = unchangedRead(f, () => combined(f)); assert.equal(current.result, false); assert.ok(current.measurement.returnedBodyBytes > 0);
  await f.reopen(); const reopened = unchangedRead(f, () => combined(f)); assert.equal(reopened.result, false);
  assert.equal(f.engine.getProviderRecoveryPreview(candidate.sessionId, candidate.attemptId!).status, 'acknowledged');
});

test('actual new uncertainty and context CAS invalidate an earlier preview, and a fresh exact ACK is visible in the next transaction', { timeout: 90000 }, async t => {
  const f = await mixed(t); assert.equal(unchangedRead(f, () => combined(f)).result, false);
  const candidate = await f.provider('new-unknown-session', 128, false, false);
  assert.equal(unchangedRead(f, () => combined(f)).result, true);
  const preview = f.engine.getProviderRecoveryPreview(candidate.sessionId, candidate.attemptId!); assert.equal(preview.status, 'eligible');
  const head = f.engine.store.getSessionDocument(candidate.sessionId, 'context.head')!;
  f.engine.store.putSessionDocument(candidate.sessionId, 'context.head', head.revision, { ...head.data, fixtureObservation: 'changed-before-decision' });
  const request = { sessionId: candidate.sessionId, attemptId: candidate.attemptId!, requestId: 'exact-new-host', fingerprint: preview.fingerprint!, acknowledged: true as const };
  const original = f.immutable(), calls = f.requests.length;
  await assert.rejects(f.engine.acknowledgeProviderRecovery(request), (error: unknown) => error instanceof EngineError && error.code === 'PROVIDER_RECOVERY_STALE');
  assert.equal(f.immutable(), original); assert.equal(f.requests.length, calls);
  const fresh = f.engine.getProviderRecoveryPreview(candidate.sessionId, candidate.attemptId!); assert.equal(fresh.status, 'eligible'); assert.notEqual(fresh.fingerprint, preview.fingerprint);
  await f.engine.acknowledgeProviderRecovery({ ...request, fingerprint: fresh.fingerprint! });
  assert.equal(unchangedRead(f, () => combined(f)).result, false);
  assert.equal(f.engine.getProviderRecoveryPreview(candidate.sessionId, candidate.attemptId!).status, 'acknowledged');
});

test('actual legacy store without the optional combined port retains both conservative admission checks', { timeout: 90000 }, async t => {
  const f = await mixed(t), store = f.engine.store;
  const summaries = store.hasUncertainSummaries.bind(store), execution = store.hasUncertainExecution.bind(store);
  let summaryCalls = 0, executionCalls = 0;
  Object.defineProperty(store, 'hasUncertainWorkspace', { value: undefined, configurable: true });
  Object.defineProperty(store, 'hasUncertainSummaries', { value: (id: string) => { summaryCalls++; return summaries(id); }, configurable: true });
  Object.defineProperty(store, 'hasUncertainExecution', { value: (id: string) => { executionCalls++; return execution(id); }, configurable: true });
  try {
    const id = await f.submit('provider-session', 'legacy-explicit', 'Explicit new work through a legacy store'); assert.equal(store.getRun(id).state, 'completed');
    assert.ok(summaryCalls > 0); assert.ok(executionCalls > 0); assert.equal(f.fullReads(), 0);
  } finally {
    Reflect.deleteProperty(store, 'hasUncertainWorkspace'); Reflect.deleteProperty(store, 'hasUncertainSummaries'); Reflect.deleteProperty(store, 'hasUncertainExecution');
  }
});
