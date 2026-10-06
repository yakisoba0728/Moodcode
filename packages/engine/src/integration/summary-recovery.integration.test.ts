import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { createEngine, type EngineOptions, type MoodcodeEngine } from '../engine.js';
import { exportEngineArchive, importEngineArchive } from '../storage/archive.js';
import { acquireExecutionLock } from '../tools/command/execution-lock.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';

const oldGoal = 'Exact historical recovery fixture goal.';
const secondHistoricalGoal = 'Exact second-session historical recovery fixture goal.';
const currentGoal = 'Keep the current original recovery constraint authoritative. '.repeat(145);
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
const sameBootBlocked = (error: unknown) => error instanceof EngineError && ['SUMMARY_RECOVERY_RESTART_REQUIRED', 'CLEANUP_PENDING'].includes(error.code);
type Request = Parameters<MoodcodeEngine['acknowledgeSummaryRecovery']>[0];
interface Fixture {
  root: string; dbPath: string; artifactDir: string; reader: DatabaseSync; options: EngineOptions; engine: MoodcodeEngine;
  runId: string; oldRunId: string; summaryId: string; main: TurnRequest[]; summaries: TurnRequest[];
  reopen(): Promise<void>; fullReads(): number; original(): unknown; context(): unknown; rows(): number;
}

// The provider emits synthetic public text/usage and has no account or decoder.
// A real missing-return failure creates uncertainty; host decisions only touch
// this fixture's private, temporary SQLite database and artifact directory.
async function fixture(t: TestContext): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-summary-recovery-'))), repository = join(root, 'repository'), dbPath = join(root, 'engine.sqlite'), artifactDir = join(root, 'artifacts');
  await mkdir(repository); const nonce = randomBytes(16).toString('hex'), main: TurnRequest[] = [], summaries: TurnRequest[] = [];
  let f!: Fixture, fullReads = 0;
  const provider: ProviderAdapter = { id: 'summary-recovery', streamTurn(request) {
    if (request.tools.length) return (async function* (): AsyncGenerator<ProviderEvent> {
      main.push(structuredClone(request)); yield { type: 'usage', inputTokens: 7, outputTokens: 2 };
      const historical = request.runId === f.oldRunId || request.messages.findLast(message => message.role === 'user')?.content === secondHistoricalGoal;
      yield { type: 'text.delta', delta: historical ? `SYNTHETIC_NONCE=${nonce}\n` + 'Synthetic historical discussion. '.repeat(285) : 'Explicit new work completed.' };
      yield { type: 'finish', reason: 'stop' };
    })();
    assert.ok(request.attemptId); assert.deepEqual(request.tools, []); assert.equal(request.turnId, undefined);
    const quoted = JSON.parse(request.messages.findLast(message => message.role === 'user')!.content) as { content: string }[];
    assert.ok(quoted.some(message => /SYNTHETIC_NONCE=[a-f0-9]{32}/u.test(message.content)));
    summaries.push(structuredClone(request)); let index = 0;
    return { [Symbol.asyncIterator]() { return { async next(): Promise<IteratorResult<ProviderEvent>> {
      if (index++ === 0) return { done: false, value: { type: 'usage', inputTokens: 9 } };
      if (index === 2) return { done: false, value: { type: 'text.delta', delta: 'Synthetic partial historical recovery memory.' } };
      throw new EngineError('PROVIDER_TRANSPORT_ERROR', 'Synthetic summary iterator has no underlying cleanup operation');
    } }; } };
  } };
  const options: EngineOptions = { dbPath, artifactDir, providers: [provider], allowedToolNames: ['read_file'],
    defaults: { providerId: provider.id, modelId: 'fixture-model', mode: 'plan', limits: { maxContextBytes: 16_384, maxOutputBytes: 1_048_576 }, budgets: { maxSummaryCalls: 32, maxSummaryBytes: 65_536 } } };
  const engine = createEngine(options), reader = new DatabaseSync(dbPath, { readOnly: true });
  t.after(async () => { try { await f.engine.close(); } finally { reader.close(); await rm(root, { recursive: true, force: true }); } });
  const trap = () => { f.engine.store.getSnapshot = () => { fullReads++; throw new Error('Summary recovery forbids whole session snapshots'); }; };
  f = { root, dbPath, artifactDir, reader, options, engine, runId: '', oldRunId: '', summaryId: '', main, summaries,
    async reopen() { await f.engine.close(); f.engine = createEngine(options); trap(); await tick(); }, fullReads: () => fullReads,
    original() { return {
      attempt: f.engine.getSummaryAttempt('session', f.summaryId), usage: f.engine.getSummaryUsage('session', f.summaryId), run: f.engine.store.getRun(f.runId),
      messages: reader.prepare('SELECT data FROM messages WHERE run_id IN (?,?) ORDER BY ordinal LIMIT 64').all(f.oldRunId, f.runId).map(row => String(row.data)),
      revisions: reader.prepare('SELECT data FROM context_revisions WHERE run_id IN (?,?) ORDER BY revision LIMIT 64').all(f.oldRunId, f.runId).map(row => String(row.data)),
    }; },
    context() { return ['context.head', 'context.memory', 'context.active_memory'].map(kind => f.engine.store.getSessionDocument('session', kind)); },
    rows() { return Number(reader.prepare('SELECT count(*) AS count FROM summary_recovery_acknowledgments').get()!.count); },
  }; trap();
  const now = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt: now });
  for (const id of ['session', 'other-session']) engine.store.createSession({ id, workspaceId: 'workspace', title: id, createdAt: now });
  f.oldRunId = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'historical', prompt: oldGoal, config: engine.getCapabilities().defaults }).runId;
  assert.equal((await engine.waitForRun(f.oldRunId)).state, 'completed');
  f.runId = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'primary', prompt: currentGoal, config: engine.getCapabilities().defaults }).runId;
  const failed = await engine.waitForRun(f.runId); await engine.waitForSession('session');
  assert.equal(failed.state, 'failed'); assert.equal(failed.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(main.length, 1); assert.equal(summaries.length, 1);
  f.summaryId = summaries[0]!.attemptId!; assert.equal(engine.getSummaryAttempt('session', f.summaryId).state, 'uncertain'); assert.equal(f.rows(), 0); return f;
}
function request(f: Fixture, requestId = 'host-decision'): Request {
  const preview = f.engine.getSummaryRecoveryPreview('session', f.summaryId);
  assert.equal(preview.status, 'eligible', JSON.stringify(preview)); assert.match(preview.fingerprint!, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(preview).includes('Synthetic partial historical'), false); assert.equal(JSON.stringify(preview).includes('SYNTHETIC_NONCE='), false);
  return { sessionId: 'session', summaryAttemptId: f.summaryId, requestId, fingerprint: preview.fingerprint!, acknowledged: true };
}
function auditCount(f: Fixture, journal: 'events' | 'session_events'): number {
  return Number(f.reader.prepare(`SELECT count(*) AS count FROM ${journal} WHERE type='summary.recovery.acknowledged' AND json_extract(data,'$.payload.summaryAttemptId')=?`).get(f.summaryId)!.count);
}

test('actual same-boot summary uncertainty cannot be acknowledged; preview is bounded metadata and owner scope is exact', { timeout: 30000 }, async t => {
  const f = await fixture(t), original = f.original(), context = f.context(), preview = f.engine.getSummaryRecoveryPreview('session', f.summaryId);
  assert.equal(preview.status, 'blocked'); assert.ok(preview.blockers.includes('SUMMARY_RECOVERY_RESTART_REQUIRED'));
  await assert.rejects(f.engine.acknowledgeSummaryRecovery({ sessionId: 'session', summaryAttemptId: f.summaryId, requestId: 'same-boot', fingerprint: preview.fingerprint ?? '0'.repeat(64), acknowledged: true }), sameBootBlocked);
  assert.throws(() => f.engine.getSummaryRecoveryPreview('other-session', f.summaryId), code('SUMMARY_RECOVERY_OWNER_MISMATCH'));
  assert.deepEqual(f.original(), original); assert.deepEqual(f.context(), context); assert.equal(f.rows(), 0); assert.equal(f.fullReads(), 0);
});

test('actual explicit host decision preserves original uncertainty and pause/backlog, dispatches zero work, and survives new context heads and restart', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.reopen(); const original = f.original(), context = f.context(), control = f.engine.store.getSessionControl('session'), otherControl = f.engine.store.getSessionControl('other-session'), decision = request(f);
  const queued = f.engine.scheduler.accept({ sessionId: 'other-session', requestId: 'preexisting-backlog', prompt: 'Explicit future queued work', config: f.engine.store.getRun(f.runId).config, delivery: 'queue' });
  const receipt = await f.engine.acknowledgeSummaryRecovery(decision); await f.engine.waitForSession('other-session'); await tick();
  assert.equal(receipt.duplicate, false); assert.equal(receipt.state, 'uncertain'); assert.equal(receipt.cleanupConfirmed, false); assert.equal(receipt.publication, 'discarded');
  assert.equal(receipt.providerRetried, false); assert.equal(receipt.checkpointActivated, false); assert.equal(receipt.executionResumed, false); assert.equal(receipt.summaryAttemptId, f.summaryId);
  assert.deepEqual(f.original(), original); assert.deepEqual(f.context(), context); assert.deepEqual(f.engine.store.getSessionControl('session'), control); assert.deepEqual(f.engine.store.getSessionControl('other-session'), otherControl);
  assert.equal(f.engine.store.getInput(queued.inputId).state, 'pending'); assert.equal(f.main.length, 1); assert.equal(f.summaries.length, 1); assert.equal(f.rows(), 1);
  assert.equal(auditCount(f, 'events'), 1); assert.equal(auditCount(f, 'session_events'), 1); assert.equal(f.engine.store.hasUncertainSummaries('workspace'), false);
  const metrics = f.engine.store.getNativeMetrics('session'); assert.equal(metrics.schemaVersion, 4); assert.equal(metrics.recovery.uncertainSummaries, 1);
  assert.equal(metrics.recovery.summaryRecoveryAcknowledgments, 1); assert.equal(metrics.recovery.summaryAcknowledgmentValidity, null); assert.equal(metrics.summaryAttemptUsage.billedTokens, null);
  assert.equal(f.engine.getSummaryRecoveryPreview('session', f.summaryId).status, 'acknowledged');
  const duplicate = await f.engine.acknowledgeSummaryRecovery(decision); assert.deepEqual(duplicate, { ...receipt, duplicate: true }); assert.equal(f.rows(), 1);
  await assert.rejects(f.engine.acknowledgeSummaryRecovery({ ...decision, fingerprint: 'f'.repeat(64) }), code('SUMMARY_RECOVERY_REQUEST_CONFLICT'));
  // Pause the queued session explicitly before testing independent manual Runs;
  // the decision itself did not resume or promote the preexisting input.
  f.engine.scheduler.pause('other-session');
  const explicitConfig = { ...f.engine.store.getRun(f.runId).config, limits: { ...f.engine.store.getRun(f.runId).config.limits, maxContextBytes: 262_144 } };
  for (let index = 0; index < 2; index++) {
    const next = f.engine.coordinator.submit({ sessionId: 'session', requestId: `new-explicit-${index}`, prompt: `Explicit new task ${index}`, config: explicitConfig });
    assert.equal((await f.engine.waitForRun(next.runId)).state, 'completed'); assert.equal(f.engine.store.hasUncertainSummaries('workspace'), false);
    assert.equal(f.engine.getSummaryRecoveryPreview('session', f.summaryId).status, 'acknowledged'); assert.deepEqual(f.original(), original);
  }
  const calls = f.main.length; await f.reopen(); assert.equal(f.engine.store.hasUncertainSummaries('workspace'), false); assert.equal(f.main.length, calls); assert.equal(f.summaries.length, 1);
  assert.deepEqual(await f.engine.acknowledgeSummaryRecovery(decision), { ...receipt, duplicate: true });
  const third = f.engine.coordinator.submit({ sessionId: 'session', requestId: 'new-after-restart', prompt: 'Explicit new task after restart', config: explicitConfig });
  assert.equal((await f.engine.waitForRun(third.runId)).state, 'completed'); assert.deepEqual(f.original(), original); assert.equal(f.engine.store.getInput(queued.inputId).state, 'pending'); assert.equal(f.fullReads(), 0);
});

test('actual eligible recovery requires explicit acknowledgment and rejects a stale mutable-context preview without writing a decision', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.reopen(); const decision = request(f), original = f.original();
  await assert.rejects(f.engine.acknowledgeSummaryRecovery({ ...decision, acknowledged: false } as unknown as Request), code('SUMMARY_RECOVERY_ACKNOWLEDGMENT_REQUIRED'));
  await assert.rejects(f.engine.acknowledgeSummaryRecovery({ ...decision, sessionId: 'other-session' }), code('SUMMARY_RECOVERY_OWNER_MISMATCH'));
  const head = f.engine.store.getSessionDocument('session', 'context.head')!;
  f.engine.store.putSessionDocument('session', 'context.head', head.revision, { ...head.data, fixtureObservation: true });
  const changed = f.engine.getSummaryRecoveryPreview('session', f.summaryId); assert.equal(changed.status, 'eligible'); assert.notEqual(changed.fingerprint, decision.fingerprint);
  await assert.rejects(f.engine.acknowledgeSummaryRecovery(decision), code('SUMMARY_RECOVERY_STALE')); assert.equal(f.rows(), 0); assert.deepEqual(f.original(), original); assert.equal(f.fullReads(), 0);
});

test('actual host facade rejects accessors/proxies and snapshots the exact request before the asynchronous lease', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.reopen(); const decision = request(f), original = f.original(), context = f.context(); let reads = 0;
  const accessor = { ...decision }; Object.defineProperty(accessor, 'fingerprint', { enumerable: true, get() { reads++; throw new Error('Host request getter must never run'); } });
  const proxy = new Proxy({ ...decision }, { get() { reads++; throw new Error('Host request proxy must never run'); }, ownKeys() { reads++; throw new Error('Host request proxy must never enumerate'); } });
  for (const invalid of [null, [], accessor, proxy, { ...decision, extra: true }, { ...decision, requestId: 'x'.repeat(257) }, { ...decision, fingerprint: 'G'.repeat(64) }]) {
    await assert.rejects(f.engine.acknowledgeSummaryRecovery(invalid as unknown as Request), code('SUMMARY_RECOVERY_INVALID_REQUEST'));
    assert.equal(f.rows(), 0); assert.equal(reads, 0);
  }
  const mutable = { ...decision }, pending = f.engine.acknowledgeSummaryRecovery(mutable);
  mutable.sessionId = 'nonexistent-session'; mutable.requestId = 'mutated-request'; mutable.fingerprint = 'f'.repeat(64); mutable.summaryAttemptId = 'nonexistent-summary';
  const receipt = await pending; assert.equal(receipt.sessionId, decision.sessionId); assert.equal(receipt.requestId, decision.requestId); assert.equal(receipt.summaryAttemptId, decision.summaryAttemptId); assert.equal(receipt.fingerprint, decision.fingerprint);
  assert.equal(f.rows(), 1); assert.deepEqual(f.original(), original); assert.deepEqual(f.context(), context); assert.equal(f.main.length, 1); assert.equal(f.summaries.length, 1); assert.equal(f.fullReads(), 0);
});

test('actual exact historical ACK retry is read-only during maintenance or independent quarantine and cannot unblock new work', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.reopen();
  f.engine.scheduler.pause('other-session');
  const queued = f.engine.scheduler.accept({ sessionId: 'other-session', requestId: 'unchanged-paused-backlog', prompt: 'Explicit future queued work', config: f.engine.store.getRun(f.runId).config, delivery: 'queue' });
  await f.engine.waitForSession('other-session');
  const decision = request(f), receipt = await f.engine.acknowledgeSummaryRecovery(decision), original = f.original(), context = f.context();
  const controls = ['session', 'other-session'].map(id => f.engine.store.getSessionControl(id)), backlog = f.engine.store.getInput(queued.inputId);
  const checkUnchanged = () => {
    assert.deepEqual(f.original(), original); assert.deepEqual(f.context(), context);
    assert.deepEqual(['session', 'other-session'].map(id => f.engine.store.getSessionControl(id)), controls);
    assert.deepEqual(f.engine.store.getInput(queued.inputId), backlog); assert.equal(f.rows(), 1);
    assert.equal(auditCount(f, 'events'), 1); assert.equal(auditCount(f, 'session_events'), 1);
    assert.equal(f.main.length, 1); assert.equal(f.summaries.length, 1); assert.equal(f.fullReads(), 0);
  };
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), release = new Promise<void>(resolve => { finish = resolve; });
  const lease = f.engine.coordinator.withWorkspaceLease('workspace', async () => { enter(); await release; return { cleanupConfirmed: true }; });
  try {
    await entered;
    assert.deepEqual(await f.engine.acknowledgeSummaryRecovery(decision), { ...receipt, duplicate: true });
    await assert.rejects(f.engine.acknowledgeSummaryRecovery({ ...decision, fingerprint: 'f'.repeat(64) }), code('SUMMARY_RECOVERY_REQUEST_CONFLICT'));
    await assert.rejects(f.engine.acknowledgeSummaryRecovery({ ...decision, requestId: 'new-during-maintenance' }), code('WORKSPACE_BUSY'));
    assert.throws(() => f.engine.coordinator.submit({ sessionId: 'session', requestId: 'new-work-during-maintenance', prompt: 'Explicit new task', config: f.engine.store.getRun(f.runId).config }), code('WORKSPACE_BUSY'));
    checkUnchanged();
  } finally { finish(); await lease; }
  await tick(); checkUnchanged();
  f.engine.coordinator.quarantineWorkspace('workspace');
  assert.deepEqual(await f.engine.acknowledgeSummaryRecovery(decision), { ...receipt, duplicate: true });
  await assert.rejects(f.engine.acknowledgeSummaryRecovery({ ...decision, fingerprint: 'f'.repeat(64) }), code('SUMMARY_RECOVERY_REQUEST_CONFLICT'));
  await assert.rejects(f.engine.acknowledgeSummaryRecovery({ ...decision, requestId: 'new-during-quarantine' }), code('CLEANUP_PENDING'));
  assert.throws(() => f.engine.coordinator.submit({ sessionId: 'session', requestId: 'new-work-during-quarantine', prompt: 'Explicit new task', config: f.engine.store.getRun(f.runId).config }), code('CLEANUP_PENDING'));
  checkUnchanged();
});

for (const journal of ['events', 'session_events'] as const) test(`actual ${journal} host decision audit failure rolls back the ACK ledger and preserves original uncertainty`, { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.reopen(); const decision = request(f), original = f.original(), context = f.context(), control = f.engine.store.getSessionControl('session'), writer = new DatabaseSync(f.dbPath);
  t.after(() => writer.close()); writer.exec(`CREATE TRIGGER reject_summary_ack BEFORE INSERT ON ${journal} WHEN NEW.type='summary.recovery.acknowledged' BEGIN SELECT RAISE(ABORT,'synthetic recovery audit rejected'); END`);
  await assert.rejects(f.engine.acknowledgeSummaryRecovery(decision)); assert.equal(f.rows(), 0); assert.equal(auditCount(f, 'events'), 0); assert.equal(auditCount(f, 'session_events'), 0);
  assert.deepEqual(f.original(), original); assert.deepEqual(f.context(), context); assert.deepEqual(f.engine.store.getSessionControl('session'), control); assert.equal(f.engine.store.hasUncertainSummaries('workspace'), true);
  assert.equal(f.main.length, 1); assert.equal(f.summaries.length, 1); writer.exec('DROP TRIGGER reject_summary_ack');
  await f.reopen(); assert.equal(f.engine.getSummaryRecoveryPreview('session', f.summaryId).status, 'eligible'); assert.equal(f.rows(), 0); assert.equal(f.fullReads(), 0);
});

test('actual summary host decision cannot bypass independent quarantine, a held command lock or a persisted active admission', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.reopen(); const decision = request(f), original = f.original();
  f.engine.coordinator.quarantineWorkspace('workspace');
  await assert.rejects(f.engine.acknowledgeSummaryRecovery(decision), code('CLEANUP_PENDING')); assert.equal(f.rows(), 0); assert.deepEqual(f.original(), original);
  await f.reopen(); const effect = acquireExecutionLock(f.dbPath + '.effects.sqlite');
  try { await assert.rejects(f.engine.acknowledgeSummaryRecovery(request(f))); assert.equal(f.rows(), 0); assert.deepEqual(f.original(), original); }
  finally { effect.release(true); }
  const admittedDecision = request(f), active = f.engine.store.admit({ sessionId: 'other-session', requestId: 'persisted-live-owner', prompt: 'Synthetic persisted workspace admission', config: f.engine.store.getRun(f.runId).config });
  assert.equal(f.engine.store.getRun(active.runId).state, 'created');
  await assert.rejects(f.engine.acknowledgeSummaryRecovery(admittedDecision), code('WORKSPACE_BUSY')); assert.equal(f.rows(), 0); assert.deepEqual(f.original(), original);
  assert.equal(f.main.length, 1); assert.equal(f.summaries.length, 1); assert.equal(f.fullReads(), 0);
});

test('actual ACK permits explicit new work but cannot acknowledge a new uncertain summary from the same boot', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.reopen(); await f.engine.acknowledgeSummaryRecovery(request(f)); const original = f.original();
  const config = f.engine.store.getRun(f.runId).config;
  const historical = f.engine.coordinator.submit({ sessionId: 'other-session', requestId: 'new-historical-goal', prompt: secondHistoricalGoal, config });
  assert.equal((await f.engine.waitForRun(historical.runId)).state, 'completed');
  const next = f.engine.coordinator.submit({ sessionId: 'other-session', requestId: 'new-long-goal', prompt: currentGoal, config });
  const failed = await f.engine.waitForRun(next.runId); assert.equal(failed.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(f.summaries.length, 2);
  const id = f.summaries[1]!.attemptId!, preview = f.engine.getSummaryRecoveryPreview('other-session', id); assert.equal(preview.status, 'blocked'); assert.ok(preview.blockers.includes('SUMMARY_RECOVERY_RESTART_REQUIRED'));
  await assert.rejects(f.engine.acknowledgeSummaryRecovery({ sessionId: 'other-session', summaryAttemptId: id, requestId: 'new-sameboot', fingerprint: preview.fingerprint ?? '0'.repeat(64), acknowledged: true }), sameBootBlocked);
  assert.throws(() => f.engine.coordinator.submit({ sessionId: 'session', requestId: 'fresh-after-new-unknown', prompt: 'Another fresh task', config: failed.config }), code('CLEANUP_PENDING'));
  assert.equal(f.rows(), 1); assert.deepEqual(f.original(), original); assert.equal(f.fullReads(), 0);
});

test('actual archive preserves the original ACK row and unknown receipt but import requires a fresh physical binding decision', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.reopen(); const decision = request(f), receipt = await f.engine.acknowledgeSummaryRecovery(decision), original = f.original();
  const ackRow = f.reader.prepare('SELECT data FROM summary_recovery_acknowledgments WHERE id=?').get(receipt.id); assert.ok(ackRow);
  await f.engine.close(); const archive = await exportEngineArchive({ dbPath: f.dbPath, artifactDir: f.artifactDir, destination: join(f.root, 'archive') });
  assert.equal(archive.manifest.databases.find(database => database.role === 'primary')!.schemaVersion, 5);
  const imported = await importEngineArchive({ directory: archive.directory, destination: join(f.root, 'restored') }); assert.equal(imported.executionResumed, false);
  const restored = createEngine({ ...f.options, dbPath: imported.dbPath, artifactDir: imported.artifactDir }); t.after(() => restored.close());
  restored.store.getSnapshot = () => { throw new Error('Imported summary recovery forbids whole snapshots'); };
  const read = new DatabaseSync(imported.dbPath, { readOnly: true });
  try { assert.deepEqual(read.prepare('SELECT data FROM summary_recovery_acknowledgments WHERE id=?').get(receipt.id), ackRow); } finally { read.close(); }
  const preview = restored.getSummaryRecoveryPreview('session', f.summaryId); assert.equal(preview.status, 'eligible'); assert.notEqual(preview.bindingScope, receipt.bindingScope);
  assert.deepEqual(restored.getSummaryAttempt('session', f.summaryId), (original as { attempt: unknown }).attempt); assert.deepEqual(restored.getSummaryUsage('session', f.summaryId), (original as { usage: unknown }).usage);
  assert.equal(restored.store.hasUncertainSummaries('workspace'), true);
  assert.throws(() => restored.coordinator.submit({ sessionId: 'other-session', requestId: 'before-fresh-decision', prompt: 'Fresh imported task', config: restored.store.getRun(f.runId).config }), code('CLEANUP_PENDING'));
  const fresh = await restored.acknowledgeSummaryRecovery({ ...decision, requestId: 'imported-host-decision', fingerprint: preview.fingerprint! }); assert.notEqual(fresh.bindingScope, receipt.bindingScope);
  assert.equal(restored.store.hasUncertainSummaries('workspace'), false); assert.equal(restored.store.getSessionControl('session').paused, true); assert.equal(f.main.length, 1); assert.equal(f.summaries.length, 1); assert.equal(f.fullReads(), 0);
});

type CrashPhase = 'before-commit' | 'after-commit';
interface CrashReady { phase: CrashPhase; sessionId: string; runId: string; summaryAttemptId: string; request: Request }
async function launchCrash(t: TestContext, root: string, phase: CrashPhase) {
  const source = import.meta.url.endsWith('.ts'), extension = source ? 'ts' : import.meta.url.endsWith('.mjs') ? 'mjs' : 'js';
  const path = fileURLToPath(new URL(`./fixtures/summary-recovery-child.${extension}`, import.meta.url));
  const child = spawn(process.execPath, [...(source ? ['--import', 'tsx'] : []), path, root, phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = ''; child.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-8192); });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const ready = await new Promise<CrashReady>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Summary recovery child did not reach ${phase}: ${diagnostics}`)), 12000);
    child.once('message', message => { clearTimeout(timer); resolve(message as CrashReady); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Recovery child exited before ${phase}: ${diagnostics}`)); });
  });
  assert.equal(ready.phase, phase); assert.equal(ready.sessionId, 'session'); return { child, ready, exited };
}

for (const phase of ['before-commit', 'after-commit'] as const) test(`actual SIGKILL ${phase} makes the host ACK and both journals atomic without retrying or activating the summary`, { timeout: 30000, skip: process.platform === 'win32' }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), `moodcode-summary-recovery-crash-${phase}-`))), dbPath = join(root, 'engine.sqlite');
  t.after(() => rm(root, { recursive: true, force: true })); const { child, ready, exited } = await launchCrash(t, root, phase);
  const read = new DatabaseSync(dbPath, { readOnly: true }), expectedRows = phase === 'before-commit' ? 0 : 1;
  const originalAttempt = JSON.parse(String(read.prepare('SELECT data FROM summary_attempts WHERE id=?').get(ready.summaryAttemptId)!.data)), originalUsage = JSON.parse(String(read.prepare('SELECT data FROM summary_usage WHERE summary_attempt_id=?').get(ready.summaryAttemptId)!.data));
  const messages = read.prepare('SELECT data FROM messages WHERE session_id=? ORDER BY ordinal LIMIT 64').all('session').map(row => String(row.data));
  const contexts = read.prepare('SELECT kind,revision,data FROM session_documents WHERE session_id=? ORDER BY kind LIMIT 32').all('session');
  assert.equal(Number(read.prepare('SELECT count(*) AS count FROM summary_recovery_acknowledgments').get()!.count), expectedRows);
  for (const journal of ['events', 'session_events']) assert.equal(Number(read.prepare(`SELECT count(*) AS count FROM ${journal} WHERE type='summary.recovery.acknowledged'`).get()!.count), expectedRows);
  read.close(); child.kill('SIGKILL'); await exited; const calls = await readFile(join(root, 'provider-calls.log'), 'utf8'); assert.equal(calls, 'main\nsummary\n');
  let unexpected = 0; const provider: ProviderAdapter = { id: 'summary-recovery-crash', async *streamTurn() { unexpected++; yield { type: 'finish', reason: 'stop' }; } };
  const options: EngineOptions = { dbPath, artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: ['read_file'] };
  let engine = createEngine(options); t.after(() => engine.close()); engine.store.getSnapshot = () => { throw new Error('Recovered decision fixture forbids whole snapshots'); };
  await tick(); assert.deepEqual(engine.getSummaryAttempt('session', ready.summaryAttemptId), originalAttempt); assert.deepEqual(engine.getSummaryUsage('session', ready.summaryAttemptId), originalUsage);
  const verify = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(Number(verify.prepare('SELECT count(*) AS count FROM summary_recovery_acknowledgments').get()!.count), expectedRows);
    for (const journal of ['events', 'session_events']) assert.equal(Number(verify.prepare(`SELECT count(*) AS count FROM ${journal} WHERE type='summary.recovery.acknowledged'`).get()!.count), expectedRows);
    assert.deepEqual(verify.prepare('SELECT data FROM messages WHERE session_id=? ORDER BY ordinal LIMIT 64').all('session').map(row => String(row.data)), messages);
    assert.deepEqual(verify.prepare('SELECT kind,revision,data FROM session_documents WHERE session_id=? ORDER BY kind LIMIT 32').all('session'), contexts);
  } finally { verify.close(); }
  const preview = engine.getSummaryRecoveryPreview('session', ready.summaryAttemptId); assert.equal(preview.status, phase === 'before-commit' ? 'eligible' : 'acknowledged');
  assert.equal(engine.store.hasUncertainSummaries('workspace'), phase === 'before-commit'); assert.equal(engine.store.getSessionControl('session').paused, true); assert.equal(unexpected, 0);
  const receipt = await engine.acknowledgeSummaryRecovery(phase === 'before-commit' ? { ...ready.request, fingerprint: preview.fingerprint! } : ready.request);
  assert.equal(receipt.duplicate, phase === 'after-commit'); assert.equal(receipt.executionResumed, false); assert.equal(unexpected, 0);
  await engine.close(); engine = createEngine(options); engine.store.getSnapshot = () => { throw new Error('Second decision restart forbids whole snapshots'); };
  assert.equal(engine.getSummaryRecoveryPreview('session', ready.summaryAttemptId).status, 'acknowledged'); assert.deepEqual(engine.getSummaryAttempt('session', ready.summaryAttemptId), originalAttempt); assert.equal(unexpected, 0);
});
