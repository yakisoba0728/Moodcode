import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, CodexProvider, getCodexAuthStatus } from '@moodcode/engine';
import { EngineError } from '@moodcode/contracts';

if (!process.argv.includes('--live')) throw new Error('Use --live for actual Codex account verification.');
const auth = await getCodexAuthStatus(); assert.equal(auth.state, 'ready'); assert.ok(auth.modelId);
const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-summary-recovery-live-')));
const transport = new CodexProvider({ timeoutMs: 90_000 }), observations = [];
let engine, phase = 'fixture', fixtureMainCalls = 0, fixtureSummaryCalls = 0, fullSnapshotReads = 0;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const provider = { id: transport.id, replayProtocol: transport.replayProtocol, inputModalities: transport.inputModalities,
  retryableHttpStatuses: transport.retryableHttpStatuses, streamTurn(request, signal) {
    if (phase === 'live') {
      const observation = { attemptId: request.attemptId, turnId: request.turnId, usage: null };
      observations.push(observation);
      const inner = transport.streamTurn(request, signal)[Symbol.asyncIterator]();
      return { [Symbol.asyncIterator]() { return this; }, async next() {
        const result = await inner.next();
        if (!result.done && result.value.type === 'usage') observation.usage = { ...observation.usage, ...result.value };
        return result;
      }, async return() { assert.ok(inner.return); return inner.return(); } };
    }
    if (!request.tools.length) {
      fixtureSummaryCalls++; let index = 0;
      // Intentional tool-free provider fixture with no cleanup operation.
      return { [Symbol.asyncIterator]() { return { async next() {
        if (index++ === 0) return { done: false, value: { type: 'usage', inputTokens: 9 } };
        if (index === 2) return { done: false, value: { type: 'text.delta', delta: 'Synthetic incomplete historical memory.' } };
        throw new EngineError('PROVIDER_TRANSPORT_ERROR', 'Synthetic provider omitted its cleanup operation');
      } }; } };
    }
    fixtureMainCalls++;
    return (async function* () { yield { type: 'text.delta', delta: 'Synthetic historical discussion. '.repeat(285) }; yield { type: 'finish', reason: 'stop' }; })();
  } };
const report = { kind: 'explicit-summary-recovery-hybrid-live', implementationCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  timestamp: new Date().toISOString(), runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
  providerId: provider.id, modelId: auth.modelId, actualRequests: observations,
  scope: { syntheticUncertainSummary: true, realUncertainTransportVerified: false, requestedRealNewRuns: 1, originalSummaryAutomaticallyRetried: false },
  passed: false, cleanupConfirmed: false };
try {
  const options = { dbPath: join(root, 'engine.sqlite'), artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: ['read_file'],
    defaults: { providerId: provider.id, modelId: auth.modelId, mode: 'plan', limits: { maxContextBytes: 16_384, maxOutputBytes: 262_144, maxDurationMs: 90_000 } } };
  const open = () => { engine = createEngine(options); engine.store.getSnapshot = () => { fullSnapshotReads++; throw new Error('Summary recovery verification forbids whole session snapshot reads'); }; };
  open(); const createdAt = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Synthetic recovery fixture', createdAt });
  const config = engine.getCapabilities().defaults;
  const first = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'historical', prompt: 'Record the synthetic historical discussion.', config });
  assert.equal((await engine.waitForRun(first.runId)).state, 'completed'); await engine.waitForSession('session');
  const failed = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'uncertain', prompt: 'Keep the current original recovery constraint authoritative. '.repeat(145), config });
  assert.equal((await engine.waitForRun(failed.runId)).error?.code, 'CLEANUP_UNCERTAIN'); await engine.waitForSession('session');
  assert.equal(fixtureMainCalls, 1); assert.equal(fixtureSummaryCalls, 1);
  const summary = engine.listSummaryAttempts('session').attempts[0]; assert.equal(summary.state, 'uncertain');
  const originalUsage = engine.getSummaryUsage('session', summary.id), originalSummaryHash = hash(summary), originalUsageHash = hash(originalUsage);
  const bootPreview = engine.getSummaryRecoveryPreview('session', summary.id);
  assert.equal(bootPreview.status, 'blocked'); assert.ok(bootPreview.blockers.includes('SUMMARY_RECOVERY_RESTART_REQUIRED'));
  await engine.close(); open();
  const pause = engine.store.getSessionControl('session'), memory = engine.store.getSessionDocument('session', 'context.memory');
  const preview = engine.getSummaryRecoveryPreview('session', summary.id); assert.equal(preview.status, 'eligible'); assert.ok(preview.fingerprint);
  const request = { sessionId: 'session', summaryAttemptId: summary.id, requestId: randomUUID(), fingerprint: preview.fingerprint, acknowledged: true };
  const acknowledged = await engine.acknowledgeSummaryRecovery(request);
  assert.equal(acknowledged.duplicate, false); assert.equal(acknowledged.cleanupConfirmed, false); assert.equal(acknowledged.executionResumed, false);
  assert.equal(acknowledged.providerRetried, false); assert.equal(acknowledged.checkpointActivated, false);
  assert.deepEqual(engine.store.getSessionControl('session'), pause); assert.deepEqual(engine.store.getSessionDocument('session', 'context.memory'), memory);
  assert.equal(engine.store.hasUncertainSummaries('workspace'), false); assert.equal(observations.length, 0);
  phase = 'live';
  const next = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'explicit-new-run', prompt: 'This is an explicit new task. Do not use tools. Reply with exactly READY.',
    config: { ...config, limits: { ...config.limits, maxContextBytes: 262_144 } } });
  assert.equal((await engine.waitForRun(next.runId)).state, 'completed'); await engine.waitForSession('session');
  assert.match(engine.store.getLastRunAssistantContent(next.runId).trim(), /^READY[.!]?$/u);
  assert.equal(observations.length, 1); assert.ok(observations[0].turnId);
  assert.equal(hash(engine.getSummaryAttempt('session', summary.id)), originalSummaryHash); assert.equal(hash(engine.getSummaryUsage('session', summary.id)), originalUsageHash);
  assert.equal(engine.getSummaryRecoveryPreview('session', summary.id).status, 'acknowledged');
  const metrics = engine.store.getNativeMetrics('session'); assert.equal(metrics.recovery.uncertainSummaries, 1); assert.equal(metrics.recovery.summaryRecoveryAcknowledgments, 1);
  await engine.close(); open();
  assert.equal(engine.store.hasUncertainSummaries('workspace'), false); assert.equal(engine.getSummaryRecoveryPreview('session', summary.id).status, 'acknowledged');
  const retry = await engine.acknowledgeSummaryRecovery(request); assert.deepEqual(retry, { ...acknowledged, duplicate: true });
  assert.equal(observations.length, 1); assert.equal(fixtureSummaryCalls, 1); assert.equal(fullSnapshotReads, 0);
  report.result = { sameBootBlocked: true, originalUncertaintyRetained: true, originalUsageUnchanged: true, explicitNewRunCompleted: true,
    sourceSummaryRetried: false, checkpointActivatedByDecision: false, pauseUnchangedByDecision: true, acknowledgmentSurvivedHeadChangeAndRestart: true,
    exactDecisionRetry: true, fullSnapshotReads, storedUncertainSummaries: metrics.recovery.uncertainSummaries, acknowledgmentRecords: metrics.recovery.summaryRecoveryAcknowledgments,
    originalSummaryUsage: originalUsage?.usage ?? null, ordinaryAttemptUsage: metrics.attemptUsage, billedTokens: null };
  report.passed = true;
} catch (error) { report.failure = error?.code ?? 'LIVE_VERIFICATION_FAILED'; report.failureMessage = error?.message?.slice(0, 1024); process.exitCode = 1; }
finally {
  try { if (engine) await engine.close(); } catch (error) { report.cleanupFailure = error?.code ?? 'CLEANUP_UNCERTAIN'; process.exitCode = 1; }
  await rm(root, { recursive: true, force: true }); report.cleanupConfirmed = report.cleanupFailure === undefined;
}
console.log(JSON.stringify(report, null, 2));
