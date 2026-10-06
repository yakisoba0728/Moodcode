import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { createEngine, type EngineOptions } from '../engine.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';

const historicalGoal = 'Exact historical quarantine fixture goal.';
const currentGoal = 'Keep the current original constraint authoritative. '.repeat(155);
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;

// Own temporary, synthetic provider and local SQLite only. The uncertain outcome
// comes from the real engine protocol, rather than inserting a terminal DB row.
test('actual orphan terminal-Run summary uncertainty survives restart and quarantines workspace admission, resume and maintenance', { timeout: 30000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-summary-quarantine-'))), repository = join(root, 'repository'), cleanRepository = join(root, 'clean-repository');
  await mkdir(repository); await mkdir(cleanRepository);
  const nonce = randomBytes(16).toString('hex'), main: TurnRequest[] = [], summary: TurnRequest[] = [];
  let oldRunId = '', fullReads = 0;
  const provider: ProviderAdapter = { id: 'summary-quarantine', streamTurn(request) {
    if (request.tools.length) return (async function* (): AsyncGenerator<ProviderEvent> {
      main.push(structuredClone(request)); yield { type: 'usage', inputTokens: 7, outputTokens: 2 };
      yield { type: 'text.delta', delta: request.runId === oldRunId ? `SYNTHETIC_NONCE=${nonce}\n` + 'Synthetic historical discussion. '.repeat(285) : 'Clean workspace completed.' };
      yield { type: 'finish', reason: 'stop' };
    })();
    assert.ok(request.attemptId); assert.equal(request.turnId, undefined); assert.deepEqual(request.tools, []);
    const source = JSON.parse(request.messages.findLast(message => message.role === 'user')!.content) as { content: string }[];
    assert.ok(source.some(message => /SYNTHETIC_NONCE=[a-f0-9]{32}/u.test(message.content)));
    summary.push(structuredClone(request)); let next = 0;
    return { [Symbol.asyncIterator]() { return { async next(): Promise<IteratorResult<ProviderEvent>> {
      if (next++ === 0) return { done: false, value: { type: 'usage', inputTokens: 9 } };
      if (next === 2) return { done: false, value: { type: 'text.delta', delta: 'Synthetic partial historical memory.' } };
      throw new EngineError('PROVIDER_TRANSPORT_ERROR', 'Synthetic iterator stopped without an underlying return operation');
    } }; } };
  } };
  const options: EngineOptions = { dbPath: join(root, 'engine.sqlite'), artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: ['read_file'],
    defaults: { providerId: provider.id, modelId: 'fixture-model', mode: 'plan', limits: { maxContextBytes: 16_384, maxOutputBytes: 1_048_576 }, budgets: { maxSummaryCalls: 32, maxSummaryBytes: 65_536 } } };
  let engine = createEngine(options);
  t.after(async () => { try { await engine.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const trap = () => { engine.store.getSnapshot = () => { fullReads++; throw new Error('Summary quarantine forbids whole session snapshots'); }; }; trap();
  const now = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt: now });
  engine.store.putWorkspace({ id: 'clean-workspace', root: cleanRepository, gitRoot: cleanRepository, branch: null, createdAt: now });
  for (const sessionId of ['session', 'other-session']) engine.store.createSession({ id: sessionId, workspaceId: 'workspace', title: sessionId, createdAt: now });
  engine.store.createSession({ id: 'clean-session', workspaceId: 'clean-workspace', title: 'clean', createdAt: now });
  engine.scheduler.pause('other-session');
  const old = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'historical', prompt: historicalGoal, config: engine.getCapabilities().defaults }); oldRunId = old.runId;
  assert.equal((await engine.waitForRun(oldRunId)).state, 'completed');
  const receipt = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'primary', prompt: currentGoal, config: engine.getCapabilities().defaults }), run = await engine.waitForRun(receipt.runId);
  await engine.waitForSession('session');
  assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(main.length, 1); assert.equal(summary.length, 1);
  const summaryId = summary[0]!.attemptId!, originalAttempt = engine.getSummaryAttempt('session', summaryId), originalUsage = engine.getSummaryUsage('session', summaryId);
  assert.equal(originalAttempt.state, 'uncertain'); assert.equal(originalAttempt.cleanupConfirmed, false); assert.equal(originalAttempt.publication, 'discarded');
  assert.equal(engine.store.hasActiveRuns('workspace'), false); assert.equal(engine.store.hasUncertainSummaries('workspace'), true); assert.equal(engine.store.hasUncertainSummaries('clean-workspace'), false);
  assert.equal(engine.store.getSessionDocument('session', 'context.memory'), null); assert.equal(engine.store.getSessionControl('session').reason, 'recovery_required');
  const calls = { main: main.length, summary: summary.length };
  async function fresh() {
    await engine.close(); engine = createEngine(options); trap(); await tick();
    assert.deepEqual(engine.getSummaryAttempt('session', summaryId), originalAttempt); assert.deepEqual(engine.getSummaryUsage('session', summaryId), originalUsage);
    assert.equal(main.length, calls.main); assert.equal(summary.length, calls.summary); assert.equal(engine.store.hasActiveRuns('workspace'), false);
    // Keep each independent first-action probe at the same explicit user pause.
    engine.scheduler.pause('other-session');
  }

  await t.test('maintenance as the first post-restart action never enters its callback', async () => {
    await fresh(); let callbacks = 0;
    await assert.rejects(engine.coordinator.withWorkspaceLease('workspace', async () => { callbacks++; return 'unexpected maintenance'; }), code('CLEANUP_PENDING'));
    assert.equal(callbacks, 0);
  });

  await t.test('another paused session cannot resume before any submit has populated runtime quarantine', async () => {
    await fresh(); const before = engine.store.getSessionControl('other-session'); assert.equal(before.reason, 'user'); assert.equal(before.paused, true);
    assert.throws(() => engine.scheduler.resume('other-session'), code('CLEANUP_PENDING')); assert.deepEqual(engine.store.getSessionControl('other-session'), before);
  });

  await t.test('same and other session fresh immediate admissions fail while exact receipt and conflict precedence remain intact', async () => {
    await fresh();
    const input = { sessionId: 'session', requestId: 'primary', prompt: currentGoal, config: run.config };
    const duplicate = engine.coordinator.submit(input); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.runId, run.id);
    assert.throws(() => engine.coordinator.submit({ ...input, prompt: currentGoal + ' changed' }), code('REQUEST_ID_CONFLICT'));
    for (const sessionId of ['session', 'other-session']) assert.throws(() => engine.coordinator.submit({ ...input, sessionId, requestId: 'fresh-' + sessionId }), code('CLEANUP_PENDING'));
    assert.equal(engine.store.listInputs('session').inputs.some(input => input.requestId.startsWith('fresh-')), false);
    assert.equal(engine.store.listInputs('other-session').inputs.length, 0); assert.equal(main.length, calls.main); assert.equal(summary.length, calls.summary);
  });

  await t.test('original session resume preserves its recovery pause on rejection', async () => {
    await fresh(); const before = engine.store.getSessionControl('session');
    assert.throws(() => engine.scheduler.resume('session'), code('CLEANUP_PENDING')); assert.deepEqual(engine.store.getSessionControl('session'), before);
  });

  await t.test('native backlog acceptance remains durable but never promotes or dispatches in the quarantined workspace', async () => {
    await fresh();
    const accepted = engine.scheduler.accept({ sessionId: 'other-session', requestId: 'durable-queue', prompt: 'Explicit future queued work', config: run.config, delivery: 'queue' });
    await engine.waitForSession('other-session'); assert.equal(engine.store.getInput(accepted.inputId).state, 'pending');
    assert.equal(engine.store.hasActiveRuns('workspace'), false); assert.equal(main.length, calls.main); assert.equal(summary.length, calls.summary);
    assert.throws(() => engine.scheduler.resume('other-session'), code('CLEANUP_PENDING')); assert.equal(engine.store.getInput(accepted.inputId).state, 'pending');
  });

  await t.test('bounded session-owned facade reads and schema-3 metrics retain nullable observations without exposing another owner', async () => {
    await fresh(); assert.equal(engine.getSummaryAttempt('session', summaryId).id, summaryId);
    assert.deepEqual(engine.getSummaryUsage('session', summaryId)!.usage, { inputTokens: 9, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null });
    assert.throws(() => engine.getSummaryAttempt('other-session', summaryId), code('SUMMARY_BINDING_MISMATCH'));
    assert.throws(() => engine.getSummaryUsage('other-session', summaryId), code('SUMMARY_BINDING_MISMATCH'));
    assert.deepEqual(engine.listSummaryAttempts('other-session', { limit: 1 }).attempts, []);
    assert.equal(engine.listSummaryAttempts('session', { limit: 1, runId: run.id }).attempts[0]!.id, summaryId);
    assert.throws(() => engine.listSummaryAttempts('other-session', { runId: run.id }), code('RECORD_SCOPE_MISMATCH'));
    const metrics = engine.store.getNativeMetrics('session'); assert.equal(metrics.schemaVersion, 3); assert.equal(metrics.recovery.uncertainSummaries, 1);
    assert.equal(metrics.summaryAttempts.states.uncertain, 1); assert.equal(metrics.summaryAttemptUsage.inputTokens.tokens, 9); assert.equal(metrics.summaryAttemptUsage.outputTokens.tokens, null);
    assert.equal(metrics.summaryAttemptUsage.billedTokens, null); assert.equal(metrics.attempts.total, 1); assert.equal(metrics.attemptUsage.inputTokens.tokens, 7);
  });

  await t.test('unrelated workspace maintenance and an explicit new Run remain available', async () => {
    await fresh(); assert.equal(await engine.coordinator.withWorkspaceLease('clean-workspace', async () => 'clean maintenance'), 'clean maintenance');
    const clean = engine.coordinator.submit({ sessionId: 'clean-session', requestId: 'clean', prompt: 'Explicit clean workspace task', config: run.config });
    assert.equal(engine.store.hasActiveRuns('clean-workspace'), true);
    engine.scheduler.pause('clean-session'); assert.equal(engine.scheduler.resume('clean-session').paused, false, 'A confirmed workspace can resume its user pause while its real Run is active');
    assert.equal((await engine.waitForRun(clean.runId)).state, 'completed'); assert.equal(main.length, calls.main + 1); assert.equal(summary.length, calls.summary);
  });
  assert.equal(fullReads, 0);
});
