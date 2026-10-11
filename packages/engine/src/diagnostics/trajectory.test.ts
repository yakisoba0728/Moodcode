import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError, type SessionEventV2 } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import { classifyDiagnosticError, exportTrajectory, TRAJECTORY_LIMITS, type TrajectoryReader } from './trajectory.js';

const stamp = '2026-10-07T01:00:00.000Z';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const session = { id: 'session', workspaceId: 'workspace', title: 'private title', createdAt: stamp };
function event(seq: number, payload = {}, extra: Partial<SessionEventV2> = {}): SessionEventV2 { return { schemaVersion: 2, stream: 'session-v2', eventId: `event-${seq}`, sessionId: session.id, seq, timestamp: stamp, type: 'message.part.updated', payload, ...extra }; }
function reader(events: SessionEventV2[]): TrajectoryReader { return { getSession: () => session, readSessionEvents: (_, after, limit) => events.filter(item => item.seq > after).slice(0, limit) }; }
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;

test('actual SQLite native execution records project usage, cleanup/request identity and partial bytes without exposing replay or effects', t => {
  const dir = mkdtempSync(join(tmpdir(), 'moodcode-trajectory-'));
  const store = new SqliteStore(join(dir, 'engine.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.putWorkspace({ id: 'workspace', root: dir, gitRoot: dir, branch: null, createdAt: stamp }); store.createSession(session);
  const config = { providerId: 'scripted', modelId: 'fixture', mode: 'build' as const, limits: { ...DEFAULT_LIMITS } };
  const accepted = store.acceptInput({ sessionId: session.id, requestId: 'request', prompt: 'credential-prompt-secret', config, delivery: 'queue' });
  const run = store.promoteInput(accepted.inputId).run;
  store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
  const turn = { schemaVersion: 2 as const, id: 'turn', sessionId: session.id, runId: run.id, inputIds: [accepted.inputId], index: 0, state: 'created' as const, createdAt: stamp };
  store.putTurn(turn);
  const attempt = { schemaVersion: 2 as const, id: 'attempt', sessionId: session.id, runId: run.id, turnId: turn.id, index: 0, providerId: 'scripted', modelId: 'fixture', state: 'prepared' as const, createdAt: stamp };
  store.putAttempt(attempt);
  store.createAttemptCleanup({ attemptId: attempt.id, sessionId: session.id, workspaceId: 'workspace', runId: run.id, turnId: turn.id, providerId: 'scripted', modelId: 'fixture', requestProjection: 'engine-turn-request-v1', requestSha256: hash('request-credential-body'), requestBytes: 23 });
  store.dispatchAttemptCleanup(attempt.id);
  store.putAttempt({ ...attempt, state: 'dispatched', dispatchedAt: stamp });
  store.putAttemptUsage(attempt.id, { inputTokens: 0, outputTokens: 4 });
  store.putPart({ schemaVersion: 2, id: 'part', sessionId: session.id, runId: run.id, turnId: turn.id, messageId: 'message', index: 0, revision: 0, state: 'open', type: 'reasoning', text: 'partial reasoning secret', providerData: { opaqueReplay: 'provider-replay-secret' }, createdAt: stamp });
  const before = store.readSessionEvents(session.id, 0, 100);
  store.getSnapshot = () => { throw new Error('Full snapshot must not be loaded'); };
  store.recoverInterrupted = () => { throw new Error('Recovery must not be called'); };
  const report = exportTrajectory(store, { sessionId: session.id, throughSeq: before.at(-1)!.seq, maxBytes: 65_536 });
  assert.deepEqual(store.readSessionEvents(session.id, 0, 100), before);
  assert.equal(report.events.find(item => item.usage !== null)!.usage!.inputTokens, 0);
  assert.equal(report.events.find(item => item.usage !== null)!.usage!.cachedInputTokens, null);
  assert.equal(report.events.find(item => item.request !== null)!.request!.sha256, hash('request-credential-body'));
  assert.equal(report.events.at(-1)!.output!.partial, true);
  assert.equal(report.events.at(-1)!.output!.sha256, hash('partial reasoning secret'));
  assert.equal(report.coverage.completeRequestedRange, true);
  assert.equal(report.coverage.sessionFrontier, 'unknown');
  assert.equal(report.coverage.rawJournalSha256, null);
  const json = JSON.stringify(report);
  for (const secret of ['credential-prompt-secret', 'partial reasoning secret', 'provider-replay-secret', 'request-credential-body', dir]) assert.ok(!json.includes(secret));
  assert.equal(report.coverage.producerEffects, 'not-executed');
});

test('a frozen range excludes later rows and remains detached when producer records change', () => {
  const rows = [event(1, { part: { id: 'part', type: 'text', text: 'partial', state: 'open' } }), event(2)];
  const first = exportTrajectory(reader(rows), { sessionId: session.id, throughSeq: 1 });
  rows.push(event(3)); rows[0]!.payload.part = { id: 'part', type: 'text', text: 'partial then completed', state: 'completed' };
  assert.equal(first.events.length, 1); assert.equal(first.events[0]!.output!.bytes, 7); assert.equal(first.events[0]!.output!.partial, true);
  assert.equal(first.range.frozenThroughSeq, 1); assert.equal(first.nextCursor, null);
  const { projectionSha256, ...rest } = first;
  assert.equal(projectionSha256, hash(JSON.stringify(rest)));
});

test('event and byte caps retain a cursor before the first excluded selected record', () => {
  const rows = Array.from({ length: 9 }, (_, i) => event(i + 1, { part: { id: `part-${i}`, type: 'text', text: 'x'.repeat(4096), state: 'failed' } }, { runId: 'run' }));
  const limited = exportTrajectory(reader(rows), { sessionId: session.id, limit: 3, maxBytes: 65_536 });
  assert.equal(limited.events.length, 3); assert.equal(limited.coverage.stopReason, 'event-limit'); assert.equal(limited.range.inspectedThroughSeq, 3); assert.equal(limited.nextCursor!.afterSeq, 3);
  const small = exportTrajectory(reader(rows), { sessionId: session.id, limit: 9, maxBytes: 3072 });
  assert.equal(small.coverage.stopReason, 'byte-limit'); assert.ok(small.events.length < 9); assert.equal(small.nextCursor!.afterSeq, small.range.inspectedThroughSeq);
  assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 3072);
  const next = exportTrajectory(reader(rows), { sessionId: session.id, afterSeq: small.nextCursor!.afterSeq, maxBytes: 65_536 });
  assert.equal(next.events[0]!.seq, small.range.inspectedThroughSeq + 1);
});

test('run selection still advances the session cursor through other Run rows', () => {
  const rows = [event(1, {}, { runId: 'other' }), event(2, {}, { runId: 'run' }), event(3, {}, { runId: 'other' }), event(4, {}, { runId: 'run' })];
  const report = exportTrajectory(reader(rows), { sessionId: session.id, runId: 'run', limit: 3 });
  assert.deepEqual(report.events.map(row => row.seq), [2]); assert.equal(report.range.inspectedThroughSeq, 3); assert.equal(report.nextCursor!.afterSeq, 3); assert.equal(report.coverage.omittedSelectedEvents, 1);
});

test('short or empty native pages never establish the session frontier or future bound completion', () => {
  for (const rows of [[], [event(1)]]) {
    const report = exportTrajectory(reader(rows), { sessionId: session.id, throughSeq: 50 });
    assert.equal(report.coverage.completeRequestedRange, null); assert.equal(report.coverage.sessionFrontier, 'unknown'); assert.ok(report.nextCursor); assert.equal(report.coverage.stopReason, 'source-page-end');
    assert.equal(report.range.frozenThroughSeq, rows.at(-1)?.seq ?? 0);
  }
  const done = exportTrajectory(reader([]), { sessionId: session.id, afterSeq: 50, throughSeq: 50 });
  assert.equal(done.coverage.completeRequestedRange, true); assert.equal(done.nextCursor, null);
});

test('an already reached caller bound never reads unrelated later producer payloads', () => {
  let reads = 0;
  const report = exportTrajectory({ getSession: () => session, readSessionEvents() { reads++; throw new Error('Later oversized record must not be opened'); } }, { sessionId: session.id, afterSeq: 8, throughSeq: 8 });
  assert.equal(reads, 0); assert.equal(report.coverage.completeRequestedRange, true); assert.equal(report.events.length, 0);
});

test('native reader is called within its existing 100-row page maximum', () => {
  let called = 0;
  const rows = Array.from({ length: 100 }, (_, i) => event(i + 1));
  const source: TrajectoryReader = { getSession: () => session, readSessionEvents: (_, after, limit) => { called++; assert.equal(limit, 100); return rows.filter(row => row.seq > after).slice(0, limit); } };
  const report = exportTrajectory(source, { sessionId: session.id, limit: 100, maxBytes: TRAJECTORY_LIMITS.maxBytes });
  assert.equal(called, 1); assert.equal(report.events.length, 100); assert.equal(report.coverage.sessionFrontier, 'unknown');
});

test('journal owner, stream, order, count and options are validated without consulting full snapshots', () => {
  for (const rows of [[event(1, {}, { sessionId: 'other' })], [event(2), event(1)], [event(1, {}, { schemaVersion: 1 as unknown as 2 })], [event(1, {}, { seq: 0 })]]) assert.throws(() => exportTrajectory({ getSession: () => session, readSessionEvents: () => rows }, { sessionId: session.id }), code('TRAJECTORY_SOURCE_INVALID'));
  assert.throws(() => exportTrajectory({ getSession: () => session, readSessionEvents: () => Array.from({ length: 101 }, (_, i) => event(i + 1)) }, { sessionId: session.id }), code('TRAJECTORY_SOURCE_INVALID'));
  for (const options of [{ sessionId: session.id, afterSeq: -1 }, { sessionId: session.id, afterSeq: 3, throughSeq: 2 }, { sessionId: session.id, limit: 101 }, { sessionId: session.id, maxBytes: 1 }, { sessionId: session.id, unknown: true }]) assert.throws(() => exportTrajectory(reader([]), options), code('INVALID_TRAJECTORY_OPTIONS'));
});

test('trajectory options reject a hidden selection field like every other diagnostics option record', () => {
  const options = Object.defineProperty({ sessionId: session.id }, 'limit', { value: 1, enumerable: false });
  assert.throws(() => exportTrajectory(reader([event(1), event(2)]), options), code('INVALID_TRAJECTORY_OPTIONS'));
});

test('unknown usage is null, zero remains an observation and inclusive subsets are validated without summing revisions', () => {
  const rows = [event(1, { observation: { revision: 1, usage: { inputTokens: 0, outputTokens: -1, cachedInputTokens: 2 } } }, { type: 'provider.attempt.usage' }), event(2, { observation: { revision: 2, usage: { inputTokens: 5, outputTokens: 7 } } }, { type: 'provider.attempt.usage' })];
  const report = exportTrajectory(reader(rows), { sessionId: session.id });
  assert.equal(report.events[0]!.usage!.inputTokens, 0); assert.equal(report.events[0]!.usage!.outputTokens, null); assert.equal(report.events[0]!.usage!.cachedInputTokens, null);
  assert.deepEqual(report.events[0]!.usage!.invalidFields, ['outputTokens', 'cachedInputTokens']);
  assert.equal(report.events[1]!.usage!.inputTokens, 5); assert.equal(report.events[1]!.usage!.reasoningOutputTokens, null); assert.equal(report.events[1]!.usage!.billedTokens, null);
});

test('raw replay, credential accessors and hostile nested tool inputs are never evaluated', () => {
  let reads = 0;
  const part = { id: 'part', type: 'reasoning', state: 'failed', text: 'safe', providerData: {} };
  Object.defineProperty(part.providerData, 'secret', { enumerable: true, get() { reads++; throw new Error('Replay accessor must not run'); } });
  const input = {}; Object.defineProperty(input, 'apiKey', { enumerable: true, get() { reads++; throw new Error('Input accessor must not run'); } });
  const rows = [event(1, { part }), event(2, { part: { id: 'toolpart', type: 'tool', toolCallId: 'tool', name: 'read_file', state: 'completed', input, result: 'private-result' } })];
  const report = exportTrajectory(reader(rows), { sessionId: session.id });
  assert.equal(reads, 0); assert.equal(report.events[1]!.tool!.inputSha256, null); assert.equal(report.events[1]!.tool!.resultSha256, hash(JSON.stringify('private-result'))); assert.ok(!JSON.stringify(report).includes('private-result'));
});

test('payload values cannot invoke coercion effects during diagnostic classification', () => {
  let coerces = 0;
  const hostile = { toString() { coerces++; throw new Error('Payload coercion'); } };
  const report = exportTrajectory(reader([event(1, { part: { id: 'part', type: hostile, state: hostile, text: 'private' } })]), { sessionId: session.id });
  assert.equal(coerces, 0); assert.equal(report.events[0]!.output, null); assert.equal(report.events[0]!.record!.state, null);
});

test('typed provider error fixtures preserve uncertainty while assigning no retry authority', () => {
  const fixtures = [
    [new EngineError('PROVIDER_HTTP_ERROR', 'private-key', { status: 401 }), 'authentication'],
    [new EngineError('PROVIDER_HTTP_ERROR', 'private-key', { status: 429 }), 'rate-limit'],
    [new EngineError('PROVIDER_HTTP_ERROR', 'private-key', { status: 503 }), 'rejection'],
    [new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'private-key'), 'context-limit'],
    [new EngineError('PROVIDER_TRANSPORT_ERROR', 'private-key'), 'transport'],
    [new EngineError('PROVIDER_INACTIVITY_TIMEOUT', 'private-key'), 'timeout'],
    [new EngineError('CLEANUP_UNCERTAIN', 'private-key'), 'cleanup-uncertain'],
    [new EngineError('RUN_CANCELLED', 'private-key'), 'cancelled'],
    [new EngineError('PROVIDER_PROTOCOL_ERROR', 'private-key'), 'protocol'],
    [new Error('private-key'), 'unknown'],
  ] as const;
  for (const [error, category] of fixtures) {
    const result = classifyDiagnosticError(error); assert.equal(result.category, category); assert.equal(result.retryDecision, 'not-decided-by-inspector'); assert.ok(!JSON.stringify(result).includes('private-key'));
  }
  assert.equal(classifyDiagnosticError('PROVIDER_TRANSPORT_ERROR').requiresRecoveryObservation, true);
  assert.equal(classifyDiagnosticError('PROVIDER_HTTP_ERROR').requiresRecoveryObservation, false);
});
