import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EngineError } from '@moodcode/contracts';
import { createEngine, CodexProvider, getCodexAuthStatus, SqliteStore } from '@moodcode/engine';

// An authored transport failure in an isolated database, followed by exactly
// one real account request. Existing project recovery records are never opened.
if (!process.argv.includes('--live')) throw new Error('Use --live for actual Codex account verification.');
const auth = await getCodexAuthStatus(); assert.equal(auth.state, 'ready'); assert.ok(auth.modelId);
const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-provider-recovery-live-')));
const transport = new CodexProvider({ timeoutMs: 90_000 }), actualRequests = [], fixtureRequests = [];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let engine, reader, phase = 'fixture', fullSnapshotReads = 0, liveCleanupObservedConfirmed = false;
const provider = { id: transport.id, replayProtocol: transport.replayProtocol, inputModalities: transport.inputModalities,
  retryableHttpStatuses: transport.retryableHttpStatuses, streamTurn(request, signal) {
    if (phase === 'live') {
      assert.equal(actualRequests.length, 0, 'This fixture allows exactly one actual account request');
      assert.ok(request.turnId, 'This fixture allows an ordinary turn only');
      const observation = { attemptId: request.attemptId, turnId: request.turnId,
        logicalRequestSha256: hash(request), logicalRequestBytes: Buffer.byteLength(JSON.stringify(request)), usage: null };
      actualRequests.push(observation);
      const inner = transport.streamTurn(request, signal)[Symbol.asyncIterator]();
      return { [Symbol.asyncIterator]() { return this; }, async next() {
        const item = await inner.next();
        if (!item.done && item.value.type === 'usage') observation.usage = { ...observation.usage, ...item.value };
        return item;
      }, async return() { assert.ok(inner.return); return inner.return(); } };
    }
    assert.equal(fixtureRequests.length, 0); fixtureRequests.push(structuredClone(request));
    const events = [
      { type: 'usage', inputTokens: 7, outputTokens: 3 },
      { type: 'text.delta', delta: 'Synthetic partial output retained before a transport failure.' },
      { type: 'reasoning.delta', delta: 'Synthetic reasoning retained before the same failure.' },
      { type: 'tool.call', call: { id: 'synthetic-unexecuted-proposal', name: 'read_file', input: { path: 'must-never-be-read.txt' } } },
    ];
    let index = 0;
    return { [Symbol.asyncIterator]() { return this; }, async next() {
      if (index < events.length) return { done: false, value: events[index++] };
      throw new EngineError('PROVIDER_TRANSPORT_ERROR', 'Synthetic provider outcome remains unknown');
    }, async return() { return { done: true, value: undefined }; } };
  } };
const report = { kind: 'confirmed-cleanup-unknown-provider-outcome-hybrid-live',
  implementationCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), timestamp: new Date().toISOString(),
  runtime: { node: process.versions.node, platform: process.platform, arch: process.arch }, providerId: provider.id, modelId: auth.modelId,
  scope: { syntheticUncertainProviderOutcome: true, realUncertainTransportVerified: false, requestedRealNewRuns: 1,
    existingProjectRecoveryAcknowledged: false, originalProviderAutomaticallyRetried: false,
    requestProjection: 'engine-turn-request-v1', rawHttpBodyOrResolvedPixelsHashed: false },
  actualRequests, passed: false, cleanupConfirmed: false };
try {
  const options = { dbPath: join(root, 'engine.sqlite'), artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: ['read_file'],
    defaults: { providerId: provider.id, modelId: auth.modelId, mode: 'plan',
      limits: { maxContextBytes: 262_144, maxOutputBytes: 32_768, maxDurationMs: 90_000, maxTurns: 1 },
      budgets: { providerRequestTimeoutMs: 90_000, providerInactivityTimeoutMs: 90_000, maxProviderAttempts: 1, turnAllowance: 1 } } };
  const open = () => {
    const original = SqliteStore.prototype.getSnapshot;
    const trap = () => { fullSnapshotReads++; throw new Error('Provider recovery verification forbids whole session snapshot reads, including startup'); };
    SqliteStore.prototype.getSnapshot = trap;
    try { engine = createEngine(options); engine.store.getSnapshot = trap; }
    finally { SqliteStore.prototype.getSnapshot = original; }
  };
  open(); reader = new DatabaseSync(options.dbPath, { readOnly: true });
  const createdAt = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt });
  for (const id of ['session', 'other-session']) engine.store.createSession({ id, workspaceId: 'workspace', title: 'Private provider recovery fixture', createdAt });
  const config = engine.getCapabilities().defaults;
  const failed = engine.coordinator.submit({ sessionId: 'session', requestId: 'synthetic-unknown-outcome',
    prompt: 'Exact synthetic provider recovery goal; preserve all partial observations.', config });
  assert.equal((await engine.waitForRun(failed.runId)).error?.code, 'PROVIDER_TRANSPORT_ERROR'); await engine.waitForSession('session');
  assert.equal(fixtureRequests.length, 1); assert.equal(actualRequests.length, 0);
  const dispatched = fixtureRequests[0], attempt = engine.store.getAttempt(dispatched.attemptId), turn = engine.store.getTurn(dispatched.turnId);
  const proof = engine.getAttemptCleanup('session', dispatched.attemptId);
  assert.equal(attempt.state, 'uncertain'); assert.equal(turn.state, 'uncertain'); assert.equal(turn.uncertainty?.kind, 'provider_dispatch');
  assert.equal(proof.state, 'confirmed'); assert.equal(proof.cleanupConfirmed, true); assert.equal(proof.method, 'iterator-return-done');
  assert.equal(proof.reason, 'error'); assert.equal(proof.errorCode, 'PROVIDER_TRANSPORT_ERROR');
  assert.equal(proof.requestSha256, hash(dispatched)); assert.equal(proof.requestBytes, Buffer.byteLength(JSON.stringify(dispatched)));
  const originalTables = ['runs','session_turns','provider_attempts','attempt_cleanup','attempt_usage','messages','message_parts','tools','context_revisions'];
  const original = () => hash(Object.fromEntries(originalTables.map(table => [table,
    reader.prepare(`SELECT data FROM ${table} WHERE ${table === 'runs' ? 'id' : 'run_id'}=? ORDER BY rowid LIMIT 128`).all(failed.runId).map(row => String(row.data))])));
  const originalHash = original(), parts = reader.prepare('SELECT data FROM message_parts WHERE run_id=? ORDER BY rowid').all(failed.runId).map(row => JSON.parse(String(row.data)));
  assert.equal(parts.length, 3); assert.deepEqual(parts.map(part => part.type).sort(), ['reasoning','text','tool']);
  assert.equal(parts.find(part => part.type === 'tool').state, 'interrupted');
  assert.equal(Number(reader.prepare('SELECT count(*) AS n FROM tools WHERE run_id=?').get(failed.runId).n), 0);
  const blocked = () => assert.throws(() => engine.coordinator.submit({ sessionId: 'other-session', requestId: randomUUID(), prompt: 'Explicit future task', config }), error => error?.code === 'CLEANUP_PENDING');
  blocked(); const sameBoot = engine.getProviderRecoveryPreview('session', dispatched.attemptId);
  assert.equal(sameBoot.status, 'blocked'); assert.ok(sameBoot.blockers.includes('PROVIDER_RECOVERY_RESTART_REQUIRED'));
  await engine.close(); open(); blocked();
  const control = engine.store.getSessionControl('session'), memory = engine.store.getSessionDocument('session','context.memory');
  const headBeforeDecision = engine.store.getSessionDocument('session','context.head'); assert.ok(headBeforeDecision);
  const preview = engine.getProviderRecoveryPreview('session', dispatched.attemptId); assert.equal(preview.status, 'eligible', JSON.stringify(preview));
  assert.ok(preview.fingerprint); const request = { sessionId: 'session', attemptId: dispatched.attemptId,
    requestId: randomUUID(), fingerprint: preview.fingerprint, acknowledged: true };
  const receipt = await engine.acknowledgeProviderRecovery(request);
  assert.equal(receipt.duplicate, false); assert.equal(receipt.cleanupConfirmed, true); assert.equal(receipt.providerOutcomeConfirmed, false);
  assert.equal(receipt.providerRetried, false); assert.equal(receipt.executionResumed, false); assert.equal(receipt.checkpointActivated, false);
  assert.equal(original(), originalHash); assert.deepEqual(engine.store.getSessionControl('session'), control);
  assert.deepEqual(engine.store.getSessionDocument('session','context.memory'), memory);
  assert.deepEqual(engine.store.getSessionDocument('session','context.head'), headBeforeDecision);
  assert.equal(engine.store.hasUncertainExecution('workspace'), false); assert.equal(actualRequests.length, 0); phase = 'live';
  const next = engine.coordinator.submit({ sessionId: 'session', requestId: 'explicit-new-independent-task',
    prompt: 'This is an explicit new independent task. Do not use tools. Reply with exactly READY.', config });
  assert.equal((await engine.waitForRun(next.runId)).state, 'completed'); await engine.waitForSession('session');
  assert.match(engine.store.getLastRunAssistantContent(next.runId).trim(), /^READY[.!]?$/u); assert.equal(actualRequests.length, 1);
  const observed = actualRequests[0], liveProof = engine.getAttemptCleanup('session', observed.attemptId);
  assert.equal(liveProof.state, 'confirmed'); assert.equal(liveProof.method, 'iterator-next-done'); assert.equal(liveProof.reason, 'natural-done');
  assert.equal(liveProof.requestSha256, observed.logicalRequestSha256); assert.equal(liveProof.requestBytes, observed.logicalRequestBytes);
  assert.equal(liveProof.contextRevisionId, engine.store.getAttempt(observed.attemptId).contextRevisionId);
  liveCleanupObservedConfirmed = true;
  assert.equal(original(), originalHash); const headAfterNewRun = engine.store.getSessionDocument('session','context.head');
  assert.ok(headAfterNewRun); assert.notDeepEqual(headAfterNewRun, headBeforeDecision);
  const metrics = engine.store.getNativeMetrics('session'); assert.equal(metrics.schemaVersion, 6);
  assert.equal(metrics.recovery.providerRecoveryAcknowledgments, 1); assert.equal(metrics.recovery.providerAcknowledgmentValidity, null);
  assert.equal(metrics.attemptCleanup.providerOutcomeConfirmed, null);
  await engine.close(); open(); assert.equal(original(), originalHash); assert.equal(engine.store.hasUncertainExecution('workspace'), false);
  assert.equal(engine.getProviderRecoveryPreview('session', dispatched.attemptId).status, 'acknowledged');
  assert.deepEqual(await engine.acknowledgeProviderRecovery(request), { ...receipt, duplicate: true });
  assert.deepEqual(engine.getAttemptCleanup('session', observed.attemptId), liveProof);
  assert.equal(actualRequests.length, 1); assert.equal(fixtureRequests.length, 1); assert.equal(fullSnapshotReads, 0);
  report.result = { sameBootBlocked: true, durableWorkspaceBlockedBeforeDecision: true, cleanupIndependentlyConfirmed: true,
    originalUnknownOutcomeAndPartialObservationsUnchanged: true, retainedPartialKinds: parts.map(part => part.type), unexecutedToolProposal: true,
    actualNewCodexRunCompleted: true, acknowledgmentSurvivedHeadChangeAndRestart: true, exactDecisionRetry: true,
    providerOutcomeConfirmedByDecision: false, checkpointActivatedByDecision: false, sourceProviderRetried: false,
    pauseUnchangedByDecision: true, contextHeadRevisionBeforeDecision: headBeforeDecision.revision,
    contextHeadRevisionAfterNewRun: headAfterNewRun.revision, fullSnapshotReads,
    liveCleanup: { state: liveProof.state, method: liveProof.method, reason: liveProof.reason,
      requestSha256MatchesLogicalRequest: true, requestBytes: liveProof.requestBytes, persistedAcrossRestart: true },
    providerAcknowledgmentRecords: metrics.recovery.providerRecoveryAcknowledgments, attemptCleanupMetrics: metrics.attemptCleanup, billedTokens: null };
  report.passed = true;
} catch (error) { report.failure = error?.code ?? 'LIVE_VERIFICATION_FAILED'; report.failureMessage = error?.message?.slice(0,1024); process.exitCode = 1;
} finally {
  try { if (engine) await engine.close(); } catch (error) { report.cleanupFailure = error?.code ?? 'CLEANUP_UNCERTAIN'; process.exitCode = 1; }
  if (reader) reader.close();
  report.hostCloseConfirmed = report.cleanupFailure === undefined;
  report.liveCleanupObservedConfirmed = actualRequests.length === 0 ? null : liveCleanupObservedConfirmed;
  report.cleanupConfirmed = report.hostCloseConfirmed && (actualRequests.length === 0 || liveCleanupObservedConfirmed);
  if (report.passed && report.cleanupConfirmed) await rm(root,{recursive:true,force:true}); else report.preservedTemporaryState = root;
}
console.log(JSON.stringify(report,null,2));
