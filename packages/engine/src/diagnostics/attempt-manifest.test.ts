import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError, type Run, type SessionEventV2 } from '@moodcode/contracts';
import { createCodingEvidenceManifest } from './attempt-manifest.js';
import { exportTrajectory } from './trajectory.js';

const stamp = '2026-10-07T01:00:00.000Z';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const session = { id: 'session', workspaceId: 'workspace', title: 'private-title', createdAt: stamp };
function run(): Run { return { id: 'coding-run', inputId: 'input', sessionId: session.id, workspaceId: session.workspaceId, requestId: 'request', prompt: 'private-user-prompt', config: { providerId: 'scripted', modelId: 'fixture', mode: 'build', limits: { ...DEFAULT_LIMITS } }, state: 'failed', createdAt: stamp, updatedAt: stamp, error: { code: 'PROVIDER_HTTP_ERROR', message: 'private-error-detail' } }; }
function event(seq: number, payload: SessionEventV2['payload'], extra: Partial<SessionEventV2> = {}): SessionEventV2 { return { schemaVersion: 2, stream: 'session-v2', sessionId: session.id, eventId: `event-${seq}`, seq, timestamp: stamp, runId: 'coding-run', turnId: 'turn', type: 'provider.attempt.failed', payload, ...extra }; }
function trajectory(rows: SessionEventV2[] = []) { return exportTrajectory({ getSession: () => session, readSessionEvents: (_, after, limit) => rows.filter(item => item.seq > after).slice(0, limit) }, { sessionId: session.id, runId: 'coding-run', maxBytes: 65_536 }); }
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;

test('coding Run identity is separate from multiple provider retries and retains partial output and unknown usage', () => {
  const rows = [
    event(1, { attempt: { id: 'provider-one', state: 'failed', contextRevisionId: 'context-before' } }, { attemptId: 'provider-one' }),
    event(2, { cleanup: { requestProjection: 'engine-turn-request-v1', requestSha256: hash('private-request-body'), requestBytes: 11, state: 'confirmed', cleanupConfirmed: true } }, { attemptId: 'provider-one', type: 'provider.cleanup.confirmed' }),
    event(3, { attempt: { id: 'provider-two', state: 'uncertain', contextRevisionId: 'context-after' } }, { attemptId: 'provider-two', type: 'provider.attempt.uncertain' }),
    event(4, { observation: { revision: 1, usage: { outputTokens: 0 } } }, { attemptId: 'provider-two', type: 'provider.attempt.usage' }),
    event(5, { part: { id: 'part', type: 'text', state: 'failed', text: 'private-partial-output' } }, { attemptId: 'provider-two', type: 'message.part.updated' }),
  ];
  const report = createCodingEvidenceManifest(run(), trajectory(rows));
  assert.equal(report.kind, 'coding-run-observation'); assert.equal(report.codingRunId, 'coding-run');
  assert.deepEqual(report.providerAttempts.map(attempt => attempt.attemptId), ['provider-one', 'provider-two']);
  assert.equal(report.providerAttempts[0]!.usage, null); assert.equal(report.providerAttempts[0]!.requestSha256, hash('private-request-body')); assert.equal(report.providerAttempts[1]!.usage!.inputTokens, null); assert.equal(report.providerAttempts[1]!.usage!.outputTokens, 0);
  assert.equal(report.outputs[0]!.partial, true); assert.equal(report.outputs[0]!.sha256, hash('private-partial-output'));
  assert.equal(report.outcome.execution, 'failed'); assert.equal(report.outcome.taskSuccess, 'not-established'); assert.equal(report.outcome.verification, 'not-observed'); assert.equal(report.outcome.billedTokens, null);
  assert.equal(report.journal.rawJournalSha256, null); assert.equal(report.runObservation.rawRunSha256, null);
  for (const secret of ['private-user-prompt', 'private-error-detail', 'private-request-body', 'private-partial-output', 'private-title']) assert.ok(!JSON.stringify(report).includes(secret));
});

test('latest usage snapshots are selected per Attempt rather than summed as independent billed events', () => {
  const rows = [event(1, { observation: { revision: 1, usage: { inputTokens: 4, outputTokens: 1 } } }, { attemptId: 'provider', type: 'provider.attempt.usage' }), event(2, { observation: { revision: 2, usage: { inputTokens: 4, outputTokens: 9 } } }, { attemptId: 'provider', type: 'provider.attempt.usage' })];
  const report = createCodingEvidenceManifest(run(), trajectory(rows));
  assert.equal(report.providerAttempts.length, 1); assert.equal(report.providerAttempts[0]!.usage!.inputTokens, 4); assert.equal(report.providerAttempts[0]!.usage!.outputTokens, 9); assert.equal(report.providerAttempts[0]!.usage!.revision, 2); assert.equal(report.outcome.billedTokens, null);
});

test('identity pins input, exact configuration and optional declared source separately from mutable Run state', () => {
  const original = run(), page = trajectory();
  const first = createCodingEvidenceManifest(original, page);
  const completed = createCodingEvidenceManifest({ ...original, state: 'completed', updatedAt: '2026-10-07T01:02:00.000Z' }, page);
  assert.equal(first.identitySha256, completed.identitySha256); assert.notEqual(first.runObservation.runProjectionSha256, completed.runObservation.runProjectionSha256);
  assert.equal(completed.outcome.taskSuccess, 'not-established'); assert.equal(completed.coverage.mutableRunStateMayBeNewerThanJournal, true);
  const changedModel = createCodingEvidenceManifest({ ...original, config: { ...original.config, modelId: 'other' } }, page);
  const changedPrompt = createCodingEvidenceManifest({ ...original, prompt: 'other' }, page);
  const declaredSource = createCodingEvidenceManifest(original, page, { sha256: hash('source'), revision: 'source-revision' });
  for (const changed of [changedModel, changedPrompt, declaredSource]) assert.notEqual(changed.identitySha256, first.identitySha256);
  assert.equal(first.source.kind, 'not-observed'); assert.equal(first.source.sha256, null); assert.equal(declaredSource.source.filesystemVerified, false);
});

test('only known Run configuration fields are read and credential/replay objects and accessors are omitted', () => {
  const selected = run(); let calls = 0;
  Object.defineProperty(selected.config, 'apiKey', { enumerable: true, get() { calls++; throw new Error('Credential read'); } });
  Object.defineProperty(selected.config, 'providerReplay', { enumerable: true, get() { calls++; throw new Error('Replay read'); } });
  Object.defineProperty(selected, 'attachments', { enumerable: true, get() { calls++; throw new Error('Attachment byte read'); } });
  const report = createCodingEvidenceManifest(selected, trajectory());
  assert.equal(calls, 0); assert.equal(report.configuration.credentials, 'not-read'); assert.equal(report.coverage.attachmentBytes, 'not-read'); assert.ok(!JSON.stringify(report).includes('apiKey'));
  const { manifestSha256, ...rest } = report;
  assert.equal(manifestSha256, hash(JSON.stringify(rest)));
});

test('mutated projection, foreign scope, invalid source and invalid config fail before creating an authoritative-looking manifest', () => {
  const page = trajectory([event(1, { attempt: { id: 'attempt', state: 'failed' } }, { attemptId: 'attempt' })]);
  page.events[0]!.record!.state = 'completed';
  assert.throws(() => createCodingEvidenceManifest(run(), page), code('INVALID_CODING_EVIDENCE'));
  assert.throws(() => createCodingEvidenceManifest({ ...run(), sessionId: 'other' }, trajectory()), code('INVALID_CODING_EVIDENCE'));
  assert.throws(() => createCodingEvidenceManifest(run(), trajectory(), { sha256: 'invalid', revision: 'source' }), code('INVALID_CODING_EVIDENCE'));
  const selected = run(); selected.config.limits.maxTurns = Number.POSITIVE_INFINITY;
  assert.throws(() => createCodingEvidenceManifest(selected, trajectory()), code('INVALID_CODING_EVIDENCE'));
});

test('hostile structured trajectory input is rejected without invoking getters or recursive producer effects', () => {
  const page = trajectory(); let calls = 0;
  Object.defineProperty(page, 'providerReplay', { enumerable: true, get() { calls++; throw new Error('Opaque replay evaluated'); } });
  assert.throws(() => createCodingEvidenceManifest(run(), page), code('INVALID_CODING_EVIDENCE')); assert.equal(calls, 0);
  const second = trajectory(); Object.defineProperty(second.events, 'nested', { enumerable: true, value: second });
  assert.throws(() => createCodingEvidenceManifest(run(), second), code('INVALID_CODING_EVIDENCE'));
});
