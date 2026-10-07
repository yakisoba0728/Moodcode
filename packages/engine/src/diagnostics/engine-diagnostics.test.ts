import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { EngineError, type MessagePart } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ProviderAdapter } from '../ports.js';
import type { CodingEvidenceOptions } from './attempt-manifest.js';
import type { TrajectoryOptions } from './trajectory.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-engine-diagnostics-')));
  let producerCalls = 0, forbiddenReads = 0;
  const provider: ProviderAdapter = { id: 'diagnostic-fixture', async *streamTurn() { producerCalls++; throw new Error('Inspector must not execute providers'); } };
  const engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [provider], tools: [], defaults: { providerId: provider.id, modelId: 'fixture', mode: 'plan' } });
  t.after(async () => { await engine.close(); rmSync(directory, { recursive: true, force: true }); });
  const stamp = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: stamp });
  const session = engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'private-diagnostic-title', createdAt: stamp });
  engine.store.createSession({ id: 'other-session', workspaceId: 'workspace', title: 'other', createdAt: stamp });
  const receipt = engine.store.acceptInput({ sessionId: session.id, requestId: 'request', prompt: 'private-user-input', config: structuredClone(engine.getCapabilities().defaults), delivery: 'queue' });
  const run = engine.store.promoteInput(receipt.inputId).run;
  engine.store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
  const turn = { schemaVersion: 2 as const, id: 'turn', sessionId: session.id, runId: run.id, inputIds: [receipt.inputId], index: 0, state: 'created' as const, createdAt: stamp };
  engine.store.putTurn(turn);
  const attempt = { schemaVersion: 2 as const, id: 'provider-attempt', sessionId: session.id, runId: run.id, turnId: turn.id, index: 0, providerId: provider.id, modelId: 'fixture', state: 'prepared' as const, createdAt: stamp };
  engine.store.putAttempt(attempt);
  engine.store.createAttemptCleanup({ attemptId: attempt.id, sessionId: session.id, workspaceId: 'workspace', runId: run.id, turnId: turn.id, providerId: provider.id, modelId: 'fixture', requestProjection: 'engine-turn-request-v1', requestSha256: hash('private-original-request'), requestBytes: 24 });
  engine.store.dispatchAttemptCleanup(attempt.id);
  const dispatched = { ...attempt, state: 'dispatched' as const, dispatchedAt: stamp, providerRequestId: 'private-provider-request-opaque' };
  engine.store.putAttempt(dispatched);
  engine.store.putAttemptUsage(attempt.id, { inputTokens: 0, outputTokens: 7 });
  const part: MessagePart = { schemaVersion: 2, id: 'reasoning-part', sessionId: session.id, runId: run.id, turnId: turn.id, messageId: 'message', index: 0, revision: 0, type: 'reasoning', state: 'open', text: 'private-partial-reasoning', providerData: { signature: 'private-opaque-replay' }, createdAt: stamp };
  engine.store.putPart(part);
  engine.store.putPart({ ...part, revision: 1, state: 'failed', completedAt: new Date().toISOString() });
  engine.store.settleAttemptCleanup(attempt.id, { outcome: 'confirmed', method: 'iterator-return-done', reason: 'error', errorCode: 'PROVIDER_HTTP_ERROR', providerRequestId: 'private-provider-request-opaque' });
  engine.store.putAttempt({ ...dispatched, state: 'failed', completedAt: new Date().toISOString() });
  engine.store.putTurn({ ...turn, state: 'failed', completedAt: new Date().toISOString() });
  engine.store.commit(run.id, 'run.failed', { code: 'PROVIDER_HTTP_ERROR', message: 'private-http-detail' }, { run: { state: 'failed', error: { code: 'PROVIDER_HTTP_ERROR', message: 'private-http-detail' } } });
  const nativeBefore = engine.store.readSessionEvents(session.id, 0, 100), legacyBefore = engine.store.readEvents(session.id, 0, 100);
  engine.store.getSnapshot = () => { forbiddenReads++; throw new Error('Full snapshot prohibited'); };
  engine.store.getHistory = () => { forbiddenReads++; throw new Error('Full display history prohibited'); };
  engine.store.recoverInterrupted = () => { forbiddenReads++; throw new Error('Recovery effect prohibited'); };
  return { engine, session, run, nativeBefore, legacyBefore, calls: () => producerCalls, forbidden: () => forbiddenReads };
}

test('actual engine host APIs read failed native execution records without replay, producer invocation or full snapshots', async t => {
  const f = fixture(t);
  const report = f.engine.getTrajectory({ sessionId: f.session.id, runId: f.run.id, throughSeq: f.nativeBefore.at(-1)!.seq });
  const manifest = f.engine.getAttemptManifest(f.run.id, { throughSeq: f.nativeBefore.at(-1)!.seq, source: { sha256: hash('declared-source'), revision: 'declared-revision' } });
  const stall = f.engine.getStallObservation({ sessionId: f.session.id, runId: f.run.id });
  assert.equal(report.events.at(-1)!.record!.state, 'failed');
  assert.equal(manifest.codingRunId, f.run.id); assert.equal(manifest.providerAttempts[0]!.state, 'failed'); assert.equal(manifest.providerAttempts[0]!.cleanupConfirmed, true); assert.equal(manifest.providerAttempts[0]!.usage!.inputTokens, 0); assert.equal(manifest.providerAttempts[0]!.usage!.cachedInputTokens, null);
  assert.equal(manifest.outcome.verification, 'not-observed'); assert.equal(manifest.outcome.taskSuccess, 'not-established');
  assert.equal(manifest.outputs.at(-1)!.partial, true); assert.equal(manifest.outputs.at(-1)!.sha256, hash('private-partial-reasoning'));
  assert.equal(manifest.source.filesystemVerified, false); assert.equal(manifest.journal.rawJournalSha256, null);
  assert.equal(stall.automaticAction, 'none'); assert.equal(stall.retryAuthority, false);
  for (const secret of ['private-user-input', 'private-partial-reasoning', 'private-opaque-replay', 'private-original-request', 'private-provider-request-opaque', 'private-http-detail', 'private-diagnostic-title']) assert.ok(!JSON.stringify([report, manifest, stall]).includes(secret));
  assert.deepEqual(f.engine.store.readSessionEvents(f.session.id, 0, 100), f.nativeBefore); assert.deepEqual(f.engine.store.readEvents(f.session.id, 0, 100), f.legacyBefore); assert.equal(f.engine.store.getRun(f.run.id).state, 'failed');
  assert.equal(f.calls(), 0); assert.equal(f.forbidden(), 0);
});

test('actual host selection rejects a Run from another session before reading its journal', async t => {
  const f = fixture(t); let reads = 0;
  const original = f.engine.store.readSessionEvents.bind(f.engine.store);
  f.engine.store.readSessionEvents = (sessionId, after, limit) => { reads++; return original(sessionId, after, limit); };
  assert.throws(() => f.engine.getTrajectory({ sessionId: 'other-session', runId: f.run.id }), code('RECORD_SCOPE_MISMATCH'));
  assert.throws(() => f.engine.getStallObservation({ sessionId: 'other-session', runId: f.run.id }), code('RECORD_SCOPE_MISMATCH'));
  assert.equal(reads, 0); assert.equal(f.calls(), 0);
  assert.throws(() => f.engine.getAttemptManifest('missing-run'), code('RUN_NOT_FOUND'));
});

test('engine close stops new diagnostic reads through all host APIs', async t => {
  const f = fixture(t); await f.engine.close();
  assert.throws(() => f.engine.getTrajectory({ sessionId: f.session.id }), code('ENGINE_CLOSED'));
  assert.throws(() => f.engine.getAttemptManifest(f.run.id), code('ENGINE_CLOSED'));
  assert.throws(() => f.engine.getStallObservation({ sessionId: f.session.id }), code('ENGINE_CLOSED'));
  assert.equal(f.calls(), 0);
});

test('host wrapper validation precedes property selection or option spread and never invokes hostile getters', async t => {
  const f = fixture(t); let getters = 0, runReads = 0;
  const original = f.engine.store.getRun.bind(f.engine.store);
  f.engine.store.getRun = id => { runReads++; return original(id); };
  const selection: TrajectoryOptions = { sessionId: f.session.id };
  Object.defineProperty(selection, 'runId', { enumerable: true, get() { getters++; throw new Error('Selection getter'); } });
  assert.throws(() => f.engine.getTrajectory(selection), code('INVALID_TRAJECTORY_OPTIONS'));
  const options: CodingEvidenceOptions = {};
  Object.defineProperty(options, 'source', { enumerable: true, get() { getters++; throw new Error('Source getter'); } });
  assert.throws(() => f.engine.getAttemptManifest(f.run.id, options), code('INVALID_CODING_EVIDENCE'));
  const source = { sha256: hash('source'), revision: 'revision' };
  Object.defineProperty(source, 'sha256', { enumerable: true, get() { getters++; throw new Error('Digest getter'); } });
  assert.throws(() => f.engine.getAttemptManifest(f.run.id, { source }), code('INVALID_CODING_EVIDENCE'));
  assert.equal(getters, 0); assert.equal(runReads, 0); assert.equal(f.calls(), 0);
});
