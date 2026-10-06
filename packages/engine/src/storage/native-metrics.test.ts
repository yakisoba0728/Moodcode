import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type ArtifactReference, type ContextRevision, type MessagePart, type ProviderAttempt, type TurnRecord } from '@moodcode/contracts';
import { SqliteStore } from './index.js';
import { migrateDatabase } from './migrations.js';
import { readNativeMetrics } from './native-metrics.js';

const stamp = '2026-10-01T00:00:00.000Z';
const config = { providerId: 'scripted', modelId: 'local', mode: 'build' as const, limits: { ...DEFAULT_LIMITS } };
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
function fixture(t: TestContext) {
  const store = new SqliteStore(':memory:');
  store.putWorkspace({ id: 'workspace', root: '/tmp/moodcode-metrics', gitRoot: '/tmp/moodcode-metrics', branch: null, createdAt: stamp });
  for (const id of ['session', 'other']) store.createSession({ id, workspaceId: 'workspace', title: id, createdAt: stamp });
  t.after(() => store.close());
  const start = (requestId = 'first', sessionId = 'session') => {
    const receipt = store.admit({ sessionId, requestId, prompt: 'fixture prompt must not appear in metrics', config });
    store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
    return store.getRun(receipt.runId);
  };
  return { store, start };
}
function context(store: SqliteStore, revision: number, id: string, supersedesId?: string): ContextRevision {
  const text = `Context ${revision}`;
  return store.putContextRevision({ schemaVersion: 2, id, sessionId: 'session', revision, kind: revision === 1 ? 'baseline' : 'update', text, sourceIds: [], sha256: createHash('sha256').update(text).digest('hex'), createdAt: stamp, ...(supersedesId ? { supersedesId } : {}) });
}
function records(store: SqliteStore, run: ReturnType<SqliteStore['getRun']>) {
  const turn: TurnRecord = { schemaVersion: 2, id: 'turn', sessionId: run.sessionId, runId: run.id, inputIds: [run.inputId], index: 0, state: 'created', createdAt: stamp };
  const attempt: ProviderAttempt = { schemaVersion: 2, id: 'attempt', sessionId: run.sessionId, runId: run.id, turnId: turn.id, index: 0, state: 'prepared', providerId: 'scripted', modelId: 'local', createdAt: stamp };
  const part: MessagePart = { schemaVersion: 2, id: 'part', sessionId: run.sessionId, runId: run.id, turnId: turn.id, messageId: 'message', index: 0, revision: 0, state: 'open', type: 'text', text: '한글', createdAt: stamp };
  store.putTurn(turn);
  return { turn, attempt, part };
}

test('empty metrics distinguish zero records from unobserved usage and unavailable external state', t => {
  const f = fixture(t), report = f.store.getNativeMetrics();
  assert.equal(report.sessions.total, 2);
  assert.equal(report.inputs.total, 0);
  assert.equal(report.inputs.pendingRequestBytes, 0);
  assert.equal(report.turns.elapsed.totalMs, null);
  assert.equal(report.providerUsage.inputTokens.tokens, null);
  assert.equal(report.summary.usage.samples, 0);
  assert.equal(report.artifacts.declaredStoredBytes, null);
  assert.equal(report.artifacts.physicalBytes, null);
  assert.equal(report.recovery.runtimeQuarantinedWorkspaces, null);
  assert.equal(report.attempts.overflowRecoveries, null);
  assert.equal(report.coverage.usage.oldest, null);
  assert.equal(f.store.getNativeMetrics('session').sessions.total, 1);
  assert.throws(() => f.store.getNativeMetrics('missing'), code('SESSION_NOT_FOUND'));
  f.store.close();
  assert.throws(() => f.store.getNativeMetrics(), code('STORE_CLOSED'));
});

test('input counters and request bytes cover all durable records and scope reads do not write', t => {
  const f = fixture(t); f.start();
  const queue = f.store.acceptInput({ sessionId: 'session', requestId: 'queue', prompt: '한글 queue', config, delivery: 'queue' });
  f.store.acceptInput({ sessionId: 'session', requestId: 'steer', prompt: 'steer', config, delivery: 'steer' });
  const cancelled = f.store.acceptInput({ sessionId: 'session', requestId: 'cancelled', prompt: 'cancelled', config, delivery: 'queue' });
  f.store.cancelInput(cancelled.inputId);
  f.store.acceptInput({ sessionId: 'other', requestId: 'other', prompt: 'other session', config, delivery: 'queue' });
  const before = f.store.readSessionEvents('session', 0), legacy = f.store.readEvents('session', 0);
  const report = f.store.getNativeMetrics('session');
  assert.deepEqual(report.inputs.states, { pending: 2, promoted: 1, cancelled: 1 });
  assert.equal(report.inputs.pendingQueue, 1); assert.equal(report.inputs.pendingSteer, 1);
  const expectedBytes = Buffer.byteLength(JSON.stringify({ sessionId: 'session', requestId: 'queue', prompt: '한글 queue', config, delivery: 'queue' })) + Buffer.byteLength(JSON.stringify({ sessionId: 'session', requestId: 'steer', prompt: 'steer', config, delivery: 'steer' }));
  assert.equal(report.inputs.pendingRequestBytes, expectedBytes);
  assert.equal(report.inputs.pendingAge.samples, 2);
  assert.equal(report.inputs.promotionWait.samples, 1);
  assert.equal(f.store.getNativeMetrics().inputs.total, 5);
  assert.equal(f.store.getNativeMetrics('other').inputs.states.pending, 1);
  assert.equal(f.store.getInput(queue.inputId).state, 'pending');
  assert.deepEqual(f.store.readSessionEvents('session', 0), before);
  assert.deepEqual(f.store.readEvents('session', 0), legacy);
  assert.ok(!JSON.stringify(report).includes('fixture prompt'));
});

test('inclusive usage totals preserve legacy metrics and expose cache/reasoning subsets without addition', t => {
  const f = fixture(t), run = f.start();
  f.store.commit(run.id, 'run.usage', { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1 });
  f.store.commit(run.id, 'run.usage', { inputTokens: 0, outputTokens: 0 });
  f.store.commit(run.id, 'context.prepared', { bytes: 123, limit: 4096, turnIndex: 0, summaryIncluded: true });
  const report = f.store.getNativeMetrics('session'), legacy = f.store.getMetrics('session');
  assert.equal(report.providerUsage.inputTokens.tokens, legacy.inputTokens);
  assert.equal(report.providerUsage.outputTokens.tokens, legacy.outputTokens);
  assert.equal(report.providerUsage.inputTokens.observed, 2);
  assert.equal(report.providerUsage.cachedInputTokens.tokens, 2);
  assert.equal(report.providerUsage.cachedInputTokens.missing, 1);
  assert.equal(report.providerUsage.reasoningOutputTokens.tokens, 1);
  assert.deepEqual(report.providerUsage.latestContext, legacy.context);
  assert.equal(report.providerUsage.inclusiveTotals, true);
  assert.equal(report.coverage.usage.selectedEvents, 3);
  assert.equal(f.store.getNativeMetrics('other').providerUsage.inputTokens.tokens, null);
});

test('invalid usage, missing fields and safe integer overflow remain explicit', t => {
  const f = fixture(t), run = f.start();
  f.store.commit(run.id, 'run.usage', { inputTokens: -1, outputTokens: 0, cachedInputTokens: true, reasoningOutputTokens: 2 });
  f.store.commit(run.id, 'run.usage', { inputTokens: 1.5, outputTokens: 0, cachedInputTokens: null });
  let usage = f.store.getNativeMetrics('session').providerUsage;
  assert.equal(usage.inputTokens.tokens, null); assert.equal(usage.inputTokens.invalid, 2);
  assert.equal(usage.cachedInputTokens.invalid, 1); assert.equal(usage.cachedInputTokens.missing, 1);
  assert.equal(usage.reasoningOutputTokens.invalid, 1);
  assert.equal(usage.outputTokens.tokens, 0);
  f.store.commit(run.id, 'run.usage', { inputTokens: Number.MAX_SAFE_INTEGER });
  f.store.commit(run.id, 'run.usage', { inputTokens: 1 });
  usage = f.store.getNativeMetrics('session').providerUsage;
  assert.equal(usage.inputTokens.tokens, null); assert.equal(usage.inputTokens.sumOverflow, true);
  assert.equal(usage.inputTokens.observed, 2);
});

test('summary snapshots and completion mirrors are deduplicated per attempt including failed usage', t => {
  const f = fixture(t), run = f.start();
  f.store.commit(run.id, 'summary.prepared', { summaryAttemptId: 'success' });
  f.store.commit(run.id, 'summary.dispatched', { summaryAttemptId: 'success' });
  f.store.commit(run.id, 'provider.usage', { purpose: 'summary', summaryAttemptId: 'success', inputTokens: 10, outputTokens: 1 });
  f.store.commit(run.id, 'provider.usage', { purpose: 'summary', summaryAttemptId: 'success', inputTokens: 10, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1 });
  const text = '요약';
  f.store.commitContextDocument(run.id, 'summary.completed', { summaryAttemptId: 'success', usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1 } }, { revision: { schemaVersion: 2, id: 'summary', sessionId: 'session', runId: run.id, revision: 1, kind: 'summary', sourceIds: [], text, sha256: createHash('sha256').update(text).digest('hex'), createdAt: stamp }, kind: 'context.memory', expectedRevision: 0, data: { active: 'summary' } });
  f.store.commit(run.id, 'summary.prepared', { summaryAttemptId: 'failed' });
  f.store.commit(run.id, 'provider.usage', { purpose: 'summary', summaryAttemptId: 'failed', inputTokens: 4, outputTokens: 1 });
  f.store.commit(run.id, 'summary.failed', { summaryAttemptId: 'failed', code: 'SUMMARY_INVALID' });
  f.store.commit(run.id, 'provider.usage', { purpose: 'summary', inputTokens: 999 });
  const report = f.store.getNativeMetrics('session');
  assert.equal(report.summary.completedEvents, 1);
  assert.equal(report.summary.failedEvents, 1);
  assert.equal(report.summary.preparedEvents, 2);
  assert.equal(report.summary.usage.samples, 2);
  assert.equal(report.summary.usage.inputTokens.tokens, 14);
  assert.equal(report.summary.usage.outputTokens.tokens, 4);
  assert.equal(report.summary.usage.cachedInputTokens.tokens, 2);
  assert.equal(report.summary.usageEventsWithoutAttemptId, 1);
  assert.equal(report.summary.revisions, 1);
  assert.equal(report.summary.textUtf8Bytes, Buffer.byteLength(text));
  assert.equal(report.providerUsage.samples, 0);
  assert.equal(f.store.readSessionEvents('session', 0).filter(event => event.type === 'summary.completed').length, 1);
});

test('state, retry, context change, UTF-8 bytes and durable wall clock interval evidence are separate', t => {
  const f = fixture(t), run = f.start(), r = records(f.store, run);
  context(f.store, 1, 'context-one'); context(f.store, 2, 'context-two', 'context-one');
  const first = { ...r.attempt, contextRevisionId: 'context-one' };
  f.store.putAttempt(first);
  f.store.putAttempt({ ...first, state: 'dispatched', dispatchedAt: '2026-10-01T00:00:01.000Z' });
  f.store.putAttempt({ ...first, state: 'failed', dispatchedAt: '2026-10-01T00:00:01.000Z', completedAt: '2026-10-01T00:00:02.000Z' });
  const second: ProviderAttempt = { ...r.attempt, id: 'retry', index: 1, contextRevisionId: 'context-two' };
  f.store.putAttempt(second); f.store.putAttempt({ ...second, state: 'dispatched', dispatchedAt: '2026-10-01T00:00:03.000Z' });
  f.store.putAttempt({ ...second, state: 'failed', dispatchedAt: '2026-10-01T00:00:03.000Z', completedAt: '2026-10-01T00:00:04.000Z' });
  f.store.putPart(r.part);
  f.store.putPart({ ...r.part, id: 'reasoning', index: 1, type: 'reasoning', text: '생각' });
  f.store.putTurn({ ...r.turn, state: 'failed', completedAt: '2026-10-01T00:00:04.000Z' });
  const report = f.store.getNativeMetrics('session');
  assert.deepEqual(report.attempts.states, { prepared: 0, dispatched: 0, streaming: 0, completed: 0, failed: 2, interrupted: 0, uncertain: 0 });
  assert.equal(report.attempts.retries, 1); assert.equal(report.attempts.turnsWithRetries, 1);
  assert.equal(report.attempts.retriesWithChangedContext, 1); assert.equal(report.attempts.overflowRecoveries, null);
  assert.equal(report.attempts.elapsed.totalMs, 6000);
  assert.equal(report.attempts.dispatchedElapsed.samples, 2); assert.equal(report.attempts.dispatchedElapsed.invalid, 0);
  assert.equal(report.attempts.dispatchedElapsed.totalMs, 2000);
  assert.equal(report.turns.elapsed.totalMs, 4000);
  assert.equal(report.parts.textUtf8Bytes, 6); assert.equal(report.parts.reasoningUtf8Bytes, 6);
  assert.deepEqual(report.parts.types, { text: 1, reasoning: 1, tool: 0, media: 0 });
  assert.ok(report.parts.serializedJsonBytes! > 12);
});

test('artifact declarations deduplicate unique IDs, retain conflicting/unknown metadata and separate physical size', t => {
  const f = fixture(t), run = f.start(), r = records(f.store, run);
  const ref: ArtifactReference = { id: 'artifact', identity: { sessionId: 'session', runId: run.id, toolCallId: 'tool', turnId: r.turn.id }, sha256: 'a'.repeat(64), storedBytes: 5, observedBytes: 9, producerTruncatedBytes: 0, artifactTruncatedBytes: 4, createdAt: stamp, expiresAt: '2026-10-08T00:00:00.000Z', complete: false, outcome: 'interrupted' };
  const { text: _text, ...mediaBase } = r.part;
  f.store.putPart({ ...mediaBase, type: 'media', mime: 'text/plain', artifact: ref });
  f.store.commit(run.id, 'tool.failed', { artifactRefs: [JSON.parse(JSON.stringify(ref))], cleanupConfirmed: false, artifacts: [{ path: 'legacy', bytes: 7, truncated: true }] });
  f.store.commit(run.id, 'checkpoint.artifacts', { artifacts: [{ artifactId: ref.id, complete: false }, { artifactId: 'unobserved', complete: true }] });
  let report = f.store.getNativeMetrics('session');
  assert.equal(report.artifacts.references, 4); assert.equal(report.artifacts.uniqueIds, 2);
  assert.equal(report.artifacts.declaredStoredBytes, 5); assert.equal(report.artifacts.declaredObservedBytes, 9);
  assert.equal(report.artifacts.storedBytesUnknownIds, 1); assert.equal(report.artifacts.legacyDeclaredBytes, 7);
  assert.equal(report.artifacts.checkpointBindingEvents, 1);
  assert.equal(report.recovery.cleanupUncertainToolEvents, 1);
  assert.equal(report.artifacts.physicalBytes, null);
  f.store.commit(run.id, 'tool.failed', { artifactRefs: [{ id: ref.id, storedBytes: 99, observedBytes: 100, sha256: 'b'.repeat(64) }] });
  report = f.store.getNativeMetrics('session');
  assert.equal(report.artifacts.conflictingMetadataIds, 1);
  assert.equal(report.artifacts.declaredStoredBytes, null);
  assert.equal(report.artifacts.storedBytesUnknownIds, 2);
});

test('checkpoint aggregates count durable file images separately from declared artifact bytes', t => {
  const f = fixture(t), run = f.start();
  f.store.commit(run.id, 'checkpoint.created', {}, {
    tool: { id: 'write', sessionId: 'session', runId: run.id, name: 'apply_patch', input: {}, state: 'completed' },
    checkpoint: { id: 'checkpoint', runId: run.id, toolCallId: 'write', kind: 'patch', createdAt: stamp, incomplete: true, warnings: [], files: [{ path: 'file.ts', before: null, after: '한글', beforeHash: null, afterHash: createHash('sha256').update('한글').digest('hex') }] },
  });
  const report = f.store.getNativeMetrics('session');
  assert.equal(report.checkpoints.total, 1); assert.equal(report.checkpoints.incomplete, 1);
  assert.equal(report.checkpoints.files, 1); assert.ok(report.checkpoints.serializedJsonBytes! > 6);
  assert.equal(report.artifacts.declaredStoredBytes, null);
  assert.equal(f.store.getNativeMetrics('other').checkpoints.total, 0);
});

for (const state of ['prepared','dispatched','confirmed','uncertain','not-dispatched'] as const) test(`typed cleanup ${state} metrics preserve separate outcome and missing observation coverage`, t => {
  const f = fixture(t), run = f.start(), r = records(f.store, run);
  f.store.putAttempt(r.attempt);
  const prior = f.store.getNativeMetrics('session');
  assert.equal(prior.attemptCleanup.total, 0); assert.equal(prior.attemptCleanup.attemptsWithoutObservation, 1);
  f.store.createAttemptCleanup({ attemptId: r.attempt.id, sessionId: 'session', workspaceId: 'workspace', runId: run.id, turnId: r.turn.id,
    providerId: 'scripted', modelId: 'local', requestProjection: 'engine-turn-request-v1', requestSha256: '1'.repeat(64), requestBytes: 1024 });
  if (state !== 'prepared' && state !== 'not-dispatched') {
    f.store.dispatchAttemptCleanup(r.attempt.id);
    f.store.putAttempt({ ...r.attempt, state: 'dispatched', dispatchedAt: new Date().toISOString() });
  }
  if (state === 'confirmed') f.store.settleAttemptCleanup(r.attempt.id, { outcome: state, method: 'iterator-next-done', reason: 'natural-done' });
  if (state === 'uncertain') f.store.settleAttemptCleanup(r.attempt.id, { outcome: state, method: 'return-missing', reason: 'error' });
  if (state === 'not-dispatched') f.store.settleAttemptCleanup(r.attempt.id, { outcome: state, method: 'no-dispatch', reason: 'cancel' });
  const report = f.store.getNativeMetrics('session');
  assert.equal(report.schemaVersion, 5); assert.equal(report.attemptCleanup.total, 1); assert.equal(report.attemptCleanup.states[state], 1);
  assert.equal(report.attemptCleanup.attemptsWithoutObservation, 0); assert.equal(report.attemptCleanup.recordValidity, null); assert.equal(report.attemptCleanup.providerOutcomeConfirmed, null);
  assert.equal(report.attemptUsage.inputTokens.tokens, null); assert.equal(report.attemptUsage.billedTokens, null);
  assert.equal(f.store.getNativeMetrics('other').attemptCleanup.total, 0);
  assert.equal(report.recovery.workspacesWithDurableEvidence, state === 'uncertain' ? 1 : 0);
  assert.equal(f.store.getNativeMetrics('other').recovery.workspacesWithDurableEvidence, 0);
  assert.equal(f.store.getAttempt(r.attempt.id).state, state === 'prepared' || state === 'not-dispatched' ? 'prepared' : 'dispatched');
});

test('missing, malformed and backwards legacy timestamp intervals are excluded with explicit coverage', t => {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  database.exec('PRAGMA foreign_keys=ON'); migrateDatabase(database);
  database.prepare('INSERT INTO workspaces(id,root,data) VALUES(?,?,?)').run('workspace', '/fixture', '{}');
  database.prepare('INSERT INTO sessions(id,workspace_id,data) VALUES(?,?,?)').run('session', 'workspace', '{}');
  database.prepare('INSERT INTO inputs(id,session_id,request_id,fingerprint,admitted_seq,data) VALUES(?,?,?,?,?,?)').run('input', 'session', 'request', '{}', 1, '{}');
  database.prepare('INSERT INTO runs(id,input_id,session_id,workspace_id,state,data) VALUES(?,?,?,?,?,?)').run('run', 'input', 'session', 'workspace', 'failed', '{}');
  const times = [{ createdAt: stamp }, { createdAt: 'invalid date', completedAt: stamp }, { createdAt: '2026-10-01T00:00:02.000Z', completedAt: stamp }];
  for (const [index, time] of times.entries()) database.prepare('INSERT INTO session_turns(id,session_id,run_id,turn_index,state,data) VALUES(?,?,?,?,?,?)').run(`turn-${index}`, 'session', 'run', index, 'failed', JSON.stringify(time));
  const report = readNativeMetrics(database, 'session');
  assert.equal(report.turns.elapsed.samples, 0); assert.equal(report.turns.elapsed.missing, 1);
  assert.equal(report.turns.elapsed.invalid, 2); assert.equal(report.turns.elapsed.totalMs, null);
});

test('recovery evidence counts durable uncertainty without pretending to inspect runtime quarantine or ledgers', t => {
  const f = fixture(t), run = f.start(), r = records(f.store, run);
  f.store.putAttempt(r.attempt);
  f.store.putAttempt({ ...r.attempt, state: 'dispatched', dispatchedAt: stamp });
  const uncertainty = { kind: 'provider_dispatch' as const, message: 'dispatch outcome unknown', requiresRecovery: true as const };
  f.store.putAttempt({ ...r.attempt, state: 'uncertain', dispatchedAt: stamp, completedAt: stamp, uncertainty });
  f.store.putTurn({ ...r.turn, state: 'uncertain', completedAt: stamp, uncertainty });
  f.store.setSessionPaused('other', true, 'recovery_required');
  f.store.commit(run.id, 'run.failed', {}, { run: { state: 'failed', error: { code: 'CLEANUP_UNCERTAIN', message: 'fixture' } } });
  const scoped = f.store.getNativeMetrics('session'), global = f.store.getNativeMetrics();
  assert.equal(scoped.recovery.uncertainTurns, 1); assert.equal(scoped.recovery.uncertainAttempts, 1);
  assert.equal(scoped.recovery.cleanupUncertainRuns, 1);
  assert.equal(scoped.recovery.pausedSessions, 1); assert.equal(global.recovery.pausedSessions, 2);
  assert.equal(global.recovery.workspacesWithDurableEvidence, 1);
  assert.equal(global.recovery.runtimeQuarantinedWorkspaces, null);
  assert.equal(global.recovery.externalRecoveryLedgerRecords, null);
});

test('usage coverage exactly matches the legacy matching-event cap despite unrelated noise', t => {
  const f = fixture(t), run = f.start();
  for (let index = 0; index < 2001; index++) f.store.commit(run.id, 'run.usage', { inputTokens: 1, outputTokens: 0 });
  f.store.commit(run.id, 'context.prepared', { bytes: 100, limit: 1024, turnIndex: 0, summaryIncluded: false });
  for (let index = 0; index < 10; index++) f.store.commit(run.id, 'diagnostic.noise', { output: 'fixture secret output'.repeat(1000) });
  const report = f.store.getNativeMetrics('session'), legacy = f.store.getMetrics('session');
  assert.equal(report.coverage.usage.matchingEvents, 2002);
  assert.equal(report.coverage.usage.selectedEvents, 2000); assert.equal(report.coverage.usage.omittedEvents, 2);
  assert.equal(report.coverage.usage.truncated, true);
  assert.equal(report.providerUsage.samples, 1999);
  assert.equal(report.providerUsage.inputTokens.tokens, legacy.inputTokens);
  assert.equal(report.coverage.usage.latest?.seq, 2004);
  assert.equal(report.coverage.usage.oldest?.seq, 5);
  assert.ok(!JSON.stringify(report).includes('fixture secret'));
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 12000);
});

test('truncated summary windows retain the latest cumulative snapshot and expose the omitted observations', t => {
  const f = fixture(t), run = f.start();
  for (let index = 0; index < 2001; index++) f.store.commit(run.id, 'provider.usage', { purpose: 'summary', summaryAttemptId: 'one-summary', inputTokens: index + 1, outputTokens: 0 });
  f.store.commit(run.id, 'summary.failed', { summaryAttemptId: 'one-summary', code: 'SUMMARY_EMPTY' });
  const report = f.store.getNativeMetrics('session');
  assert.equal(report.summary.usage.samples, 1); assert.equal(report.summary.usage.inputTokens.tokens, 2001);
  assert.equal(report.summary.failedEvents, 1);
  assert.equal(report.coverage.summary.matchingEvents, 2002); assert.equal(report.coverage.summary.omittedEvents, 2);
  assert.equal(report.coverage.summary.truncated, true);
});

test('global event ordering uses insertion rather than independent per-session sequences', t => {
  const f = fixture(t), first = f.start();
  f.store.commit(first.id, 'run.usage', { inputTokens: 1 });
  f.store.commit(first.id, 'run.completed', {}, { run: { state: 'completed' } });
  const second = f.start('next', 'other');
  f.store.commit(second.id, 'run.usage', { inputTokens: 2 });
  const report = f.store.getNativeMetrics();
  assert.equal(report.providerUsage.inputTokens.tokens, 3);
  assert.equal(report.coverage.usage.oldest?.sessionId, 'session');
  assert.equal(report.coverage.usage.latest?.sessionId, 'other');
});
