import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { getStallObservation, getTrajectoryStallObservation, STALL_LIMITS, type StallSample } from './stall.js';
import { exportTrajectory } from './trajectory.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function sample(seq: number, changes: Partial<StallSample> = {}): StallSample { return { runId: 'run', toolCallId: `tool-${seq}`, seq, inputSha256: hash('input'), resultSha256: hash('result'), sourceSha256: hash('source'), effectEpoch: 4, effectClass: 'read', outcome: 'completed', resultComplete: true, ...changes }; }
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;

test('only repeated complete reads at the same source and effect boundary emit an advisory signal', () => {
  const report = getStallObservation([sample(1), sample(2), sample(3)]);
  assert.equal(report.signal, 'possible-stall'); assert.equal(report.repeatedExecutions, 3); assert.equal(report.reason, 'same-read-input-result-source-and-effect-epoch'); assert.equal(report.automaticAction, 'none'); assert.equal(report.retryAuthority, false); assert.equal(report.taskSuccess, 'not-assessed');
});

test('source, effect epoch, input, result and outcome changes each break a repetition', () => {
  const changes: Partial<StallSample>[] = [{ sourceSha256: hash('new-source') }, { effectEpoch: 5 }, { inputSha256: hash('new-input') }, { resultSha256: hash('new-result') }, { outcome: 'failed' }];
  for (const change of changes) {
    const report = getStallObservation([sample(1), sample(2), sample(3, change)]);
    assert.equal(report.signal, 'no-signal'); assert.equal(report.repeatedExecutions, 1); assert.equal(report.reason, 'changed-observation');
  }
});

test('missing provenance, partial results and non-read effects remain unknown rather than authorizing repeats', () => {
  for (const change of [{ sourceSha256: null }, { effectEpoch: null }, { inputSha256: null }, { resultSha256: null }, { resultComplete: false }, { outcome: 'unknown' as const }]) {
    const report = getStallObservation([sample(1), sample(2), sample(3, change)]);
    assert.equal(report.signal, 'unknown'); assert.equal(report.reason, 'incomplete-provenance'); assert.equal(report.automaticAction, 'none');
  }
  for (const effectClass of ['state', 'write', 'execute', 'network', 'unknown'] as const) { const report = getStallObservation([sample(1), sample(2), sample(3, { effectClass })]); assert.equal(report.signal, 'unknown'); assert.equal(report.reason, 'non-read-observation'); }
});

test('host-declared legitimate repeated reads do not signal a stall', () => {
  const report = getStallObservation([sample(1), sample(2), sample(3, { legitimateRepeat: true })]);
  assert.equal(report.signal, 'no-signal'); assert.equal(report.reason, 'legitimate-repeat');
  const earlier = getStallObservation([sample(1), sample(2, { legitimateRepeat: true }), sample(3)]);
  assert.equal(earlier.signal, 'no-signal'); assert.equal(earlier.repeatedExecutions, 1);
});

test('streaming result revisions count as one execution and selected windows are bounded', () => {
  const report = getStallObservation([sample(1, { toolCallId: 'one-tool' }), sample(2, { toolCallId: 'one-tool' }), sample(3, { toolCallId: 'one-tool' })]);
  assert.equal(report.signal, 'no-signal'); assert.equal(report.repeatedExecutions, 1); assert.equal(report.selectedSamples, 1); assert.equal(report.omittedSamples, 2);
  const capped = getStallObservation(Array.from({ length: 20 }, (_, i) => sample(i + 1)), { window: 4, threshold: 3 });
  assert.equal(capped.selectedSamples, 4); assert.equal(capped.firstSeq, 17); assert.equal(capped.omittedSamples, 16); assert.equal(capped.repeatedExecutions, 4);
});

test('foreign Run, unordered sequence, malformed digests and exhausted count budgets are rejected', () => {
  for (const samples of [[sample(2), sample(1)], [sample(1), sample(2, { runId: 'other' })], [sample(1, { inputSha256: 'bad' })], [sample(1, { effectEpoch: -1 })], Array.from({ length: STALL_LIMITS.maxSamples + 1 }, (_, i) => sample(i + 1))]) assert.throws(() => getStallObservation(samples), code('INVALID_STALL_OBSERVATION'));
  for (const options of [{ window: 1 }, { threshold: 1 }, { threshold: 9, window: 8 }, { window: 65 }, { unknown: true }]) assert.throws(() => getStallObservation([sample(1)], options), code('INVALID_STALL_OBSERVATION'));
});

test('actual trajectory digests without execution-bound source and effect epoch cannot manufacture a stall', () => {
  const stamp = '2026-10-07T01:00:00.000Z';
  const rows = Array.from({ length: 3 }, (_, i) => ({ schemaVersion: 2 as const, stream: 'session-v2' as const, eventId: `event-${i}`, sessionId: 'session', runId: 'run', seq: i + 1, timestamp: stamp, type: 'message.part.updated', payload: { part: { id: `part-${i}`, type: 'tool', toolCallId: `tool-${i}`, state: 'completed', name: 'read_file', input: { path: 'same.ts' }, result: 'same text' } } }));
  const page = exportTrajectory({ getSession: () => ({ id: 'session', workspaceId: 'workspace', title: 'test', createdAt: stamp }), readSessionEvents: () => rows }, { sessionId: 'session', runId: 'run' });
  const report = getTrajectoryStallObservation(page);
  assert.equal(report.signal, 'unknown'); assert.equal(report.reason, 'non-read-observation'); assert.equal(report.sourceSha256, null); assert.equal(report.effectEpoch, null); assert.equal(report.automaticAction, 'none');
});

test('accessor and proxy samples are rejected before observing their contents', () => {
  let reads = 0; const hostile = sample(1);
  Object.defineProperty(hostile, 'resultSha256', { enumerable: true, get() { reads++; throw new Error('Hostile getter'); } });
  assert.throws(() => getStallObservation([hostile]), code('INVALID_STALL_OBSERVATION')); assert.equal(reads, 0);
  assert.throws(() => getStallObservation([new Proxy(sample(1), {})]), code('INVALID_STALL_OBSERVATION'));
  const samples: StallSample[] = [sample(1)]; Object.defineProperty(samples, '0', { enumerable: true, get() { reads++; throw new Error('Array accessor'); } });
  assert.throws(() => getStallObservation(samples), code('INVALID_STALL_OBSERVATION')); assert.equal(reads, 0);
});
