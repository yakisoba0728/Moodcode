import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineError } from '@moodcode/contracts';
import { createEngine, CodexProvider, getCodexAuthStatus } from '@moodcode/engine';

// Private synthetic overflow/unknown-summary fixture, then one actual Codex
// request. This never acknowledges recovery records in an existing project DB.
if (!process.argv.includes('--live')) throw new Error('Use --live for actual Codex account verification.');
const auth = await getCodexAuthStatus(); assert.equal(auth.state, 'ready'); assert.ok(auth.modelId);
const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-attempt-cleanup-live-')));
const transport = new CodexProvider({ timeoutMs: 90_000 }), actualRequests = [], fixtureRequests = [];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let engine, phase = 'fixture', fullSnapshotReads = 0;
const provider = { id: transport.id, replayProtocol: transport.replayProtocol, inputModalities: transport.inputModalities,
  retryableHttpStatuses: transport.retryableHttpStatuses, streamTurn(request, signal) {
    if (phase === 'live') {
      assert.equal(actualRequests.length, 0, 'The live fixture allows exactly one actual account request');
      assert.ok(request.turnId, 'The live fixture allows an ordinary turn only');
      const encoded = JSON.stringify(request);
      const observation = { attemptId: request.attemptId, turnId: request.turnId,
        logicalRequestSha256: hash(request), logicalRequestBytes: Buffer.byteLength(encoded), usage: null };
      actualRequests.push(observation);
      const inner = transport.streamTurn(request, signal)[Symbol.asyncIterator]();
      return { [Symbol.asyncIterator]() { return this; }, async next() {
        const item = await inner.next();
        if (!item.done && item.value.type === 'usage') observation.usage = { ...observation.usage, ...item.value };
        return item;
      }, async return() { assert.ok(inner.return); return inner.return(); } };
    }
    fixtureRequests.push(structuredClone(request));
    if (fixtureRequests.length === 1) return (async function* () {
      yield { type: 'text.delta', delta: 'Synthetic historical discussion. '.repeat(285) };
      yield { type: 'finish', reason: 'stop' };
    })();
    if (fixtureRequests.length === 2) return { [Symbol.asyncIterator]() { return this; }, async next() {
      throw new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'Synthetic context overflow before current output');
    }, async return() { return { done: true, value: undefined }; } };
    assert.equal(fixtureRequests.length, 3); assert.equal(request.turnId, undefined); assert.equal(request.tools.length, 0);
    let index = 0;
    // The summary intentionally has no return operation; closure stays unknown.
    return { [Symbol.asyncIterator]() { return this; }, async next() {
      if (index++ === 0) return { done: false, value: { type: 'usage', inputTokens: 9 } };
      if (index === 2) return { done: false, value: { type: 'text.delta', delta: 'Synthetic partial overflow memory.' } };
      throw new EngineError('PROVIDER_TRANSPORT_ERROR', 'Synthetic summary cleanup is unknown');
    } };
  } };
const report = { kind: 'ordinary-cleanup-and-overflow-summary-recovery-hybrid-live',
  implementationCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), timestamp: new Date().toISOString(),
  runtime: { node: process.versions.node, platform: process.platform, arch: process.arch }, providerId: provider.id, modelId: auth.modelId,
  scope: { syntheticOrdinaryOverflow: true, syntheticUncertainSummary: true, realUncertainTransportVerified: false,
    requestedRealNewRuns: 1, existingProjectRecoveryAcknowledged: false, originalSummaryAutomaticallyRetried: false,
    requestProjection: 'engine-turn-request-v1', rawHttpBodyOrResolvedPixelsHashed: false }, actualRequests, passed: false, cleanupConfirmed: false };
try {
  const options = { dbPath: join(root, 'engine.sqlite'), artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: ['read_file'],
    defaults: { providerId: provider.id, modelId: auth.modelId, mode: 'plan', limits: { maxContextBytes: 16_384, maxOutputBytes: 32_768, maxDurationMs: 90_000 },
      budgets: { providerRequestTimeoutMs: 90_000, providerInactivityTimeoutMs: 90_000 } } };
  const open = () => { engine = createEngine(options); engine.store.getSnapshot = () => {
    fullSnapshotReads++; throw new Error('Ordinary cleanup verification forbids whole session snapshot reads');
  }; };
  open(); const createdAt = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt });
  for (const id of ['session', 'other-session']) engine.store.createSession({ id, workspaceId: 'workspace', title: 'Private cleanup fixture', createdAt });
  const config = engine.getCapabilities().defaults;
  const seed = engine.coordinator.submit({ sessionId: 'session', requestId: 'historical', prompt: 'Exact synthetic historical overflow goal.', config });
  assert.equal((await engine.waitForRun(seed.runId)).state, 'completed'); await engine.waitForSession('session');
  const failed = engine.coordinator.submit({ sessionId: 'session', requestId: 'overflow', prompt: 'Exact synthetic ordinary cleanup fixture goal.', config });
  assert.equal((await engine.waitForRun(failed.runId)).error?.code, 'CLEANUP_UNCERTAIN'); await engine.waitForSession('session');
  assert.equal(fixtureRequests.length, 3); assert.equal(actualRequests.length, 0);
  const ordinary = fixtureRequests[1], summaryId = fixtureRequests[2].attemptId;
  const proof = engine.getAttemptCleanup('session', ordinary.attemptId), attempt = engine.store.getAttempt(ordinary.attemptId);
  const turn = engine.store.getTurn(ordinary.turnId), summary = engine.getSummaryAttempt('session', summaryId), usage = engine.getSummaryUsage('session', summaryId);
  assert.equal(attempt.state, 'failed'); assert.equal(proof.state, 'confirmed'); assert.equal(proof.cleanupConfirmed, true);
  assert.equal(proof.method, 'iterator-return-done'); assert.equal(proof.reason, 'error'); assert.equal(proof.errorCode, 'PROVIDER_CONTEXT_OVERFLOW');
  assert.equal(proof.requestSha256, hash(ordinary)); assert.equal(proof.requestBytes, Buffer.byteLength(JSON.stringify(ordinary)));
  assert.equal(turn.state, 'uncertain'); assert.equal(turn.uncertainty?.summaryDependency?.summaryAttemptId, summaryId);
  assert.equal(turn.uncertainty?.summaryDependency?.failedAttemptId, attempt.id);
  assert.equal(summary.state, 'uncertain'); assert.equal(summary.cleanupConfirmed, false); assert.equal(summary.publication, 'discarded');
  const original = hash({ proof, attempt, turn, summary, usage });
  assert.throws(() => engine.coordinator.submit({ sessionId: 'other-session', requestId: 'blocked', prompt: 'New task', config }), error => error?.code === 'CLEANUP_PENDING');
  const bootPreview = engine.getSummaryRecoveryPreview('session', summaryId);
  assert.equal(bootPreview.status, 'blocked'); assert.ok(bootPreview.blockers.includes('SUMMARY_RECOVERY_RESTART_REQUIRED'));
  await engine.close(); open();
  assert.equal(engine.store.hasUncertainExecution('workspace'), true);
  const pause = engine.store.getSessionControl('session'), memory = engine.store.getSessionDocument('session', 'context.memory');
  const headBeforeDecision = engine.store.getSessionDocument('session', 'context.head'); assert.ok(headBeforeDecision);
  const preview = engine.getSummaryRecoveryPreview('session', summaryId); assert.equal(preview.status, 'eligible'); assert.ok(preview.fingerprint);
  const request = { sessionId: 'session', summaryAttemptId: summaryId, requestId: randomUUID(), fingerprint: preview.fingerprint, acknowledged: true };
  const decision = await engine.acknowledgeSummaryRecovery(request);
  assert.equal(decision.duplicate, false); assert.equal(decision.cleanupConfirmed, false); assert.equal(decision.executionResumed, false);
  assert.equal(decision.providerRetried, false); assert.equal(decision.checkpointActivated, false);
  assert.deepEqual(engine.store.getSessionControl('session'), pause); assert.deepEqual(engine.store.getSessionDocument('session', 'context.memory'), memory);
  assert.deepEqual(engine.store.getSessionDocument('session', 'context.head'), headBeforeDecision);
  assert.equal(engine.store.hasUncertainExecution('workspace'), false); assert.equal(engine.store.hasUncertainSummaries('workspace'), false);
  assert.equal(actualRequests.length, 0); phase = 'live';
  const next = engine.coordinator.submit({ sessionId: 'session', requestId: 'explicit-new-task',
    prompt: 'This is an explicit new independent task. Do not use tools. Reply with exactly READY.',
    config: { ...config, limits: { ...config.limits, maxContextBytes: 262_144, maxTurns: 1 },
      budgets: { ...config.budgets, maxProviderAttempts: 1, turnAllowance: 1 } } });
  assert.equal((await engine.waitForRun(next.runId)).state, 'completed'); await engine.waitForSession('session');
  assert.match(engine.store.getLastRunAssistantContent(next.runId).trim(), /^READY[.!]?$/u); assert.equal(actualRequests.length, 1);
  const observed = actualRequests[0], liveProof = engine.getAttemptCleanup('session', observed.attemptId), liveAttempt = engine.store.getAttempt(observed.attemptId);
  assert.equal(liveProof.state, 'confirmed'); assert.equal(liveProof.method, 'iterator-next-done'); assert.equal(liveProof.reason, 'natural-done');
  assert.equal(liveProof.requestSha256, observed.logicalRequestSha256); assert.equal(liveProof.requestBytes, observed.logicalRequestBytes);
  assert.equal(liveProof.contextRevisionId, liveAttempt.contextRevisionId); assert.equal(liveAttempt.state, 'completed');
  const readOriginal = () => hash({ proof: engine.getAttemptCleanup('session', ordinary.attemptId), attempt: engine.store.getAttempt(ordinary.attemptId),
    turn: engine.store.getTurn(ordinary.turnId), summary: engine.getSummaryAttempt('session', summaryId), usage: engine.getSummaryUsage('session', summaryId) });
  assert.equal(readOriginal(), original);
  const headAfterNewRun = engine.store.getSessionDocument('session', 'context.head');
  assert.ok(headAfterNewRun); assert.notDeepEqual(headAfterNewRun, headBeforeDecision);
  const metrics = engine.store.getNativeMetrics('session'); assert.equal(metrics.schemaVersion, 5);
  assert.equal(metrics.recovery.uncertainSummaries, 1); assert.equal(metrics.recovery.summaryRecoveryAcknowledgments, 1);
  assert.equal(metrics.attemptCleanup.total, 3); assert.equal(metrics.attemptCleanup.states.confirmed, 3);
  assert.equal(metrics.attemptCleanup.providerOutcomeConfirmed, null); assert.equal(metrics.attemptCleanup.recordValidity, null);
  await engine.close(); open();
  assert.equal(readOriginal(), original); assert.equal(engine.store.hasUncertainExecution('workspace'), false);
  assert.equal(engine.getSummaryRecoveryPreview('session', summaryId).status, 'acknowledged');
  assert.deepEqual(await engine.acknowledgeSummaryRecovery(request), { ...decision, duplicate: true });
  assert.equal(actualRequests.length, 1); assert.equal(fixtureRequests.length, 3); assert.equal(fullSnapshotReads, 0);
  assert.deepEqual(engine.getAttemptCleanup('session', observed.attemptId), liveProof);
  report.result = { sameBootBlocked: true, durableWorkspaceBlockedBeforeDecision: true, exactOverflowOriginValidated: true,
    failedOrdinaryAttemptUnchanged: true, uncertainTurnAndSummaryUnchanged: true, originalSummaryUsageUnchanged: true,
    explicitNewCodexRunCompleted: true, acknowledgmentSurvivedHeadChangeAndRestart: true, exactDecisionRetry: true,
    contextHeadRevisionBeforeDecision: headBeforeDecision.revision, contextHeadRevisionAfterNewRun: headAfterNewRun.revision,
    sourceSummaryRetried: false, checkpointActivatedByDecision: false, pauseUnchangedByDecision: true, fullSnapshotReads,
    fixtureProviderCalls: fixtureRequests.length, liveCleanup: { state: liveProof.state, method: liveProof.method, reason: liveProof.reason,
      requestSha256MatchesLogicalRequest: true, requestBytes: liveProof.requestBytes, contextRevisionMatches: true, persistedAcrossRestart: true },
    overflowCleanup: { state: proof.state, method: proof.method, errorCode: proof.errorCode, originalAttemptState: attempt.state },
    storedUncertainSummaries: metrics.recovery.uncertainSummaries, acknowledgmentRecords: metrics.recovery.summaryRecoveryAcknowledgments,
    originalSummaryUsage: usage?.usage ?? null, attemptCleanupMetrics: metrics.attemptCleanup, billedTokens: null };
  report.passed = true;
} catch (error) {
  report.failure = error?.code ?? 'LIVE_VERIFICATION_FAILED'; report.failureMessage = error?.message?.slice(0, 1024); process.exitCode = 1;
} finally {
  try { if (engine) await engine.close(); } catch (error) { report.cleanupFailure = error?.code ?? 'CLEANUP_UNCERTAIN'; process.exitCode = 1; }
  report.cleanupConfirmed = report.cleanupFailure === undefined;
  if (report.cleanupConfirmed) await rm(root, { recursive: true, force: true });
  else report.preservedTemporaryState = root;
}
console.log(JSON.stringify(report, null, 2));
