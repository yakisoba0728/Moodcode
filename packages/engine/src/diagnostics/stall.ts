import { types } from 'node:util';
import { EngineError } from '@moodcode/contracts';
import type { JournalProjection } from './trajectory.js';
import type { DiagnosticExecutionObservation } from './execution-observation-types.js';

export const STALL_LIMITS = Object.freeze({ defaultWindow: 8, maxWindow: 64, defaultThreshold: 3, maxSamples: 100 });
export interface StallSample {
  runId: string; toolCallId: string; seq: number;
  inputSha256: string | null; resultSha256: string | null;
  /** These identities must describe source/effects at this sample's execution boundary. */
  sourceSha256: string | null; effectEpoch: number | null;
  effectClass: 'read' | 'state' | 'write' | 'execute' | 'network' | 'unknown';
  outcome: 'completed' | 'failed' | 'interrupted' | 'unknown';
  resultComplete: boolean;
  legitimateRepeat?: boolean;
}
export interface StallOptions { window?: number; threshold?: number }
export interface StallObservation {
  schemaVersion: 1;
  policy: 'advisory-only';
  signal: 'possible-stall' | 'no-signal' | 'unknown';
  reason: 'same-read-input-result-source-and-effect-epoch' | 'changed-observation' | 'insufficient-window' | 'incomplete-provenance' | 'legitimate-repeat' | 'non-read-observation';
  runId: string | null;
  firstSeq: number | null;
  lastSeq: number | null;
  selectedSamples: number;
  omittedSamples: number;
  repeatedExecutions: number;
  window: number;
  threshold: number;
  sourceSha256: string | null;
  effectEpoch: number | null;
  automaticAction: 'none';
  retryAuthority: false;
  taskSuccess: 'not-assessed';
}
function invalid(message: string): never { throw new EngineError('INVALID_STALL_OBSERVATION', message); }
function plain(value: unknown, keys: string[]): void {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Stall observations require plain data');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid('Stall observations reject unknown fields, accessors and symbols');
  }
}
function id(value: unknown): boolean { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value); }
function digest(value: unknown): boolean { return value === null || typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function validSample(value: StallSample): void {
  plain(value, ['runId', 'toolCallId', 'seq', 'inputSha256', 'resultSha256', 'sourceSha256', 'effectEpoch', 'effectClass', 'outcome', 'resultComplete', 'legitimateRepeat']);
  if (!id(value.runId) || !id(value.toolCallId) || !Number.isSafeInteger(value.seq) || value.seq < 1 || ![value.inputSha256, value.resultSha256, value.sourceSha256].every(digest) || value.effectEpoch !== null && (!Number.isSafeInteger(value.effectEpoch) || value.effectEpoch < 0) || !['read', 'state', 'write', 'execute', 'network', 'unknown'].includes(value.effectClass) || !['completed', 'failed', 'interrupted', 'unknown'].includes(value.outcome) || typeof value.resultComplete !== 'boolean' || value.legitimateRepeat !== undefined && typeof value.legitimateRepeat !== 'boolean') invalid('Stall sample is invalid');
}

/** A repeated read can be valid. This observation never denies tools, replays effects or cancels a Run. */
export function getStallObservation(samples: readonly StallSample[], options: StallOptions = {}): StallObservation {
  plain(options, ['window', 'threshold']);
  const window = options.window ?? STALL_LIMITS.defaultWindow, threshold = options.threshold ?? STALL_LIMITS.defaultThreshold;
  if (!Array.isArray(samples) || types.isProxy(samples) || samples.length > STALL_LIMITS.maxSamples || !Number.isSafeInteger(window) || window < 2 || window > STALL_LIMITS.maxWindow || !Number.isSafeInteger(threshold) || threshold < 2 || threshold > window) invalid('Stall count bounds are invalid');
  for (let i = 0; i < samples.length; i++) if (!Object.hasOwn(Object.getOwnPropertyDescriptor(samples, String(i)) ?? {}, 'value')) invalid('Stall sample arrays reject holes and accessors');
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    validSample(sample);
    if (i > 0 && (sample.runId !== samples[0]!.runId || sample.seq <= samples[i - 1]!.seq)) invalid('Stall samples must belong to one Run in increasing journal order');
  }
  // Streaming revisions of one tool are not multiple executions. Keep the last
  // revision before selecting the window, so a large single result never stalls.
  const seen = new Set<string>(), selected: StallSample[] = [];
  for (let i = samples.length - 1; i >= 0; i--) {
    const sample = samples[i]!;
    if (seen.has(sample.toolCallId)) continue;
    seen.add(sample.toolCallId);
    if (selected.length < window) selected.unshift(sample);
  }
  const latest = selected.at(-1);
  const report: StallObservation = { schemaVersion: 1, policy: 'advisory-only', signal: 'no-signal', reason: 'insufficient-window', runId: latest?.runId ?? null, firstSeq: selected[0]?.seq ?? null, lastSeq: latest?.seq ?? null, selectedSamples: selected.length, omittedSamples: samples.length - selected.length, repeatedExecutions: 0, window, threshold, sourceSha256: latest?.sourceSha256 ?? null, effectEpoch: latest?.effectEpoch ?? null, automaticAction: 'none', retryAuthority: false, taskSuccess: 'not-assessed' };
  if (!latest) return report;
  if (latest.legitimateRepeat === true) { report.reason = 'legitimate-repeat'; return report; }
  if (latest.effectClass !== 'read') { report.signal = 'unknown'; report.reason = 'non-read-observation'; return report; }
  const complete = (sample: StallSample): boolean => sample.sourceSha256 !== null && sample.effectEpoch !== null && sample.inputSha256 !== null && sample.resultSha256 !== null && sample.outcome !== 'unknown' && sample.resultComplete;
  if (!complete(latest)) { report.signal = 'unknown'; report.reason = 'incomplete-provenance'; return report; }
  let repeated = 0;
  for (let i = selected.length - 1; i >= 0; i--) {
    const sample = selected[i]!;
    if (!complete(sample) || sample.legitimateRepeat === true || sample.effectClass !== 'read' || sample.inputSha256 !== latest.inputSha256 || sample.resultSha256 !== latest.resultSha256 || sample.sourceSha256 !== latest.sourceSha256 || sample.effectEpoch !== latest.effectEpoch || sample.outcome !== latest.outcome) break;
    repeated++;
  }
  report.repeatedExecutions = repeated;
  if (repeated >= threshold) { report.signal = 'possible-stall'; report.reason = 'same-read-input-result-source-and-effect-epoch'; }
  else report.reason = selected.length < threshold ? 'insufficient-window' : 'changed-observation';
  return report;
}

/** Journal digests alone cannot establish the workspace version at a past read. */
export function getTrajectoryStallObservation(trajectory: JournalProjection, options: StallOptions = {}, observations: readonly DiagnosticExecutionObservation[] = []): StallObservation {
  const samples: StallSample[] = [];
  for (const event of trajectory.events) {
    if (event.runId === null || event.tool?.toolCallId === null || !event.tool) continue;
    if (trajectory.runId !== null && event.runId !== trajectory.runId) continue;
    if (samples.length && samples[0]!.runId !== event.runId) continue;
    const state = event.tool.state;
    const observation = observations.find(row => row.runId === event.runId && row.toolCallId === event.tool!.toolCallId && row.state === 'settled' && row.outcome === state && event.tool!.resultObserved);
    const unchanged = observation?.sourceBefore.completeness === 'full' && observation.sourceAfter?.completeness === 'full' && observation.sourceBefore.sha256 === observation.sourceAfter.sha256 && observation.effectEpochBefore === observation.effectEpochDispatch && observation.effectEpochDispatch === observation.effectEpochAfter;
    samples.push({ runId: event.runId, toolCallId: event.tool.toolCallId!, seq: event.seq, inputSha256: observation?.effectiveInputSha256 ?? event.tool.inputSha256, resultSha256: observation?.resultSha256 ?? event.tool.resultSha256, sourceSha256: unchanged ? observation!.sourceBefore.sha256 : null, effectEpoch: unchanged ? observation!.effectEpochDispatch : null, effectClass: observation?.effectClass ?? 'unknown', outcome: state === 'completed' || state === 'failed' || state === 'interrupted' ? state : 'unknown', resultComplete: observation?.resultComplete === true && event.tool.resultObserved && state === 'completed' });
  }
  return getStallObservation(samples, options);
}
