import { types } from 'node:util';
import { EngineError, type Run } from '@moodcode/contracts';
import { jsonTextSha256, sha256Hex } from '../shared/canonical.js';
import { isBoundedId, isSha256, plainRecord } from '../shared/data.js';
import { validateTrajectoryOptions, type JournalProjection, type TrajectoryEvent, type TrajectoryOptions } from './trajectory.js';
import { ownData } from './validation.js';

export interface CodingSourceIdentity {
  /** The host must obtain this from its own frozen source observation. No filesystem is scanned here. */
  sha256: string;
  revision: string;
}
export type CodingEvidenceOptions = Omit<TrajectoryOptions, 'sessionId' | 'runId'> & { source?: CodingSourceIdentity };
export interface CodingEvidenceManifest {
  schemaVersion: 1;
  projection: 'coding-evidence-manifest-v1';
  kind: 'coding-run-observation';
  codingRunId: string;
  sessionId: string;
  workspaceId: string;
  inputId: string;
  identitySha256: string;
  prompt: { sha256: string; bytes: number; rawText: 'not-exported' };
  source: { kind: 'host-declared' | 'not-observed'; sha256: string | null; revision: string | null; filesystemVerified: false };
  configuration: {
    providerId: string; modelId: string; mode: 'plan' | 'build';
    reasoningEffort: string | null; agentProfileId: string | null; agentProfileRevision: string | null;
    limits: Record<string, number>; budgets: Record<string, number> | null; sha256: string;
    credentials: 'not-read'; providerRequest: 'not-exported';
  };
  journal: { stream: 'session-v2'; afterSeq: number; throughSeq: number; inspectedThroughSeq: number; projectionSha256: string; rawJournalSha256: null; sessionFrontier: 'unknown'; truncated: boolean };
  runObservation: { state: Run['state']; updatedAt: string; errorCode: string | null; runProjectionSha256: string; rawRunSha256: null };
  providerAttempts: Array<{
    attemptId: string; turnId: string | null; state: string | null; contextRevisionId: string | null;
    requestSha256: string | null; requestBytes: number | null;
    cleanupState: string | null; cleanupConfirmed: boolean | null;
    usage: { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; reasoningOutputTokens: number | null; revision: number | null } | null;
  }>;
  outputs: Array<{ partId: string | null; kind: 'text' | 'reasoning'; bytes: number; sha256: string; partial: boolean; sourceSeq: number }>;
  outcome: { execution: Run['state']; verification: 'not-observed'; taskSuccess: 'not-established'; billedTokens: null };
  coverage: { providerAttempts: 'selected-journal-window-only'; currentRecordJoin: 'not-read'; filesAndCheckpoints: 'not-read'; providerEffects: 'not-executed'; rawCredentialsAndReplay: 'not-exported'; attachmentBytes: 'not-read'; sourceClock: 'run-read-and-journal-read-separately'; mutableRunStateMayBeNewerThanJournal: true };
  manifestSha256: string;
}

const LIMIT_KEYS = ['maxTurns', 'maxToolCalls', 'maxDurationMs', 'toolTimeoutMs', 'maxOutputBytes', 'maxContextBytes'];
const BUDGET_KEYS = ['turnAllowance', 'maxToolCallsPerTurn', 'maxPendingInputs', 'maxPendingBytes', 'maxSteerBatch', 'maxReadConcurrency', 'maxProviderAttempts', 'providerRequestTimeoutMs', 'providerInactivityTimeoutMs', 'retryBaseDelayMs', 'maxSummaryCalls', 'maxSummaryBytes', 'maxArtifactBytes', 'maxProducerBytes'];
const RUN_STATES = ['created', 'running', 'awaiting_approval', 'cancelling', 'completed', 'cancelled', 'failed', 'interrupted'];
function fail(message: string): never { throw new EngineError('INVALID_CODING_EVIDENCE', message); }
function identifier(value: unknown): string {
  if (!isBoundedId(value)) return fail('Identity must be a bounded string');
  return value;
}
function digest(value: unknown): string {
  if (!isSha256(value)) return fail('Digest must be a lowercase SHA-256');
  return value;
}
function plain(value: unknown, keys: string[]): void {
  plainRecord(value, [], keys, fault => fail(fault === 'shape' ? 'Coding evidence options require plain data' : 'Coding evidence options reject unknown fields, accessors and symbols'));
}
/** Validate before the host wrapper destructures or spreads its optional page/source selection. */
export function validateCodingEvidenceOptions(options: CodingEvidenceOptions): void {
  plain(options, ['afterSeq', 'throughSeq', 'limit', 'maxBytes', 'source']);
  const { source, ...page } = options;
  validateTrajectoryOptions({ ...page, sessionId: 'validation-only' });
  if (source !== undefined) {
    plain(source, ['sha256', 'revision']); digest(ownData(source, 'sha256')); identifier(ownData(source, 'revision'));
  }
}
function numericRecord(value: unknown, keys: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of keys) {
    const found = ownData(value, key);
    if (typeof found !== 'number' || !Number.isSafeInteger(found) || found < 0) return fail('Run limits and budgets must be nonnegative safe integers');
    result[key] = found;
  }
  return result;
}
function validatePlainTree(value: unknown, ancestors = new Set<object>(), depth = 0, remaining = { nodes: 10_000 }): void {
  if (--remaining.nodes < 0 || depth > 12) fail('Journal projection exceeds the structured validation budget');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) fail('Journal projection accepts plain data only');
  if (ancestors.has(value)) fail('Journal projection cannot be cyclic');
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('Journal projection rejects accessors and symbols');
    validatePlainTree(descriptor.value, ancestors, depth + 1, remaining);
  }
  ancestors.delete(value);
}
function latestAttempts(events: readonly TrajectoryEvent[], runId: string): CodingEvidenceManifest['providerAttempts'] {
  const results = new Map<string, CodingEvidenceManifest['providerAttempts'][number]>();
  for (const event of events) {
    if (event.runId !== runId || event.attemptId === null) continue;
    let current = results.get(event.attemptId);
    if (!current) {
      current = { attemptId: event.attemptId, turnId: event.turnId, state: null, contextRevisionId: null, requestSha256: null, requestBytes: null, cleanupState: null, cleanupConfirmed: null, usage: null };
      results.set(event.attemptId, current);
    }
    if (event.record?.kind === 'attempt') { current.state = event.record.state; current.contextRevisionId = event.record.contextRevisionId; }
    if (event.request !== null) { current.requestSha256 = event.request.sha256; current.requestBytes = event.request.bytes; current.cleanupState = event.request.cleanupState; current.cleanupConfirmed = event.request.cleanupConfirmed; }
    if (event.usage !== null) current.usage = { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens, cachedInputTokens: event.usage.cachedInputTokens, reasoningOutputTokens: event.usage.reasoningOutputTokens, revision: event.usage.revision };
  }
  return [...results.values()];
}

/** A coding Run can contain many provider Attempts. This report grants no retry, replay or completion authority. */
export function createCodingEvidenceManifest(run: Run, trajectory: JournalProjection, source?: CodingSourceIdentity): CodingEvidenceManifest {
  const runId = identifier(ownData(run, 'id')), sessionId = identifier(ownData(run, 'sessionId')), workspaceId = identifier(ownData(run, 'workspaceId')), inputId = identifier(ownData(run, 'inputId'));
  validatePlainTree(trajectory);
  if (Buffer.byteLength(JSON.stringify(trajectory)) > 262_144 || trajectory.schemaVersion !== 1 || trajectory.projection !== 'engine-diagnostic-trajectory-v1' || trajectory.stream !== 'session-v2' || trajectory.sessionId !== sessionId || trajectory.workspaceId !== workspaceId || trajectory.runId !== null && trajectory.runId !== runId || !Array.isArray(trajectory.events) || trajectory.events.length > 100) return fail('Trajectory and Run have incompatible scope or projection');
  const { projectionSha256: journalHash, ...journalProjection } = trajectory;
  if (digest(journalHash) !== jsonTextSha256(journalProjection)) return fail('Journal projection changed after it was frozen');
  const rawConfig = ownData(run, 'config');
  const providerId = identifier(ownData(rawConfig, 'providerId')), modelId = identifier(ownData(rawConfig, 'modelId')), mode = ownData(rawConfig, 'mode');
  if (mode !== 'plan' && mode !== 'build') return fail('Run mode is invalid');
  const reasoning = ownData(rawConfig, 'reasoningEffort');
  if (reasoning !== undefined && (typeof reasoning !== 'string' || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoning))) return fail('Reasoning effort is invalid');
  const configuration = { providerId, modelId, mode: mode as 'plan' | 'build', reasoningEffort: reasoning === undefined ? null : String(reasoning), agentProfileId: ownData(rawConfig, 'agentProfileId') === undefined ? null : identifier(ownData(rawConfig, 'agentProfileId')), agentProfileRevision: ownData(rawConfig, 'agentProfileRevision') === undefined ? null : identifier(ownData(rawConfig, 'agentProfileRevision')), limits: numericRecord(ownData(rawConfig, 'limits'), LIMIT_KEYS), budgets: ownData(rawConfig, 'budgets') === undefined ? null : numericRecord(ownData(rawConfig, 'budgets'), BUDGET_KEYS) };
  const prompt = ownData(run, 'prompt');
  if (typeof prompt !== 'string' || Buffer.byteLength(prompt) > 1_048_576) return fail('Run prompt exceeds the coding evidence read bound');
  const state = ownData(run, 'state'), updatedAt = ownData(run, 'updatedAt');
  if (typeof state !== 'string' || !RUN_STATES.includes(state) || typeof updatedAt !== 'string' || updatedAt.length !== 24 || !Number.isFinite(Date.parse(updatedAt))) return fail('Run state or observation timestamp is invalid');
  let sourceIdentity: CodingEvidenceManifest['source'] = { kind: 'not-observed', sha256: null, revision: null, filesystemVerified: false };
  if (source !== undefined) sourceIdentity = { kind: 'host-declared', sha256: digest(ownData(source, 'sha256')), revision: identifier(ownData(source, 'revision')), filesystemVerified: false };
  const configHash = jsonTextSha256(configuration);
  const promptIdentity = { sha256: sha256Hex(prompt), bytes: Buffer.byteLength(prompt), rawText: 'not-exported' as const };
  const identity = { runId, sessionId, workspaceId, inputId, prompt: promptIdentity, configurationSha256: configHash, source: sourceIdentity };
  const error = ownData(ownData(run, 'error'), 'code');
  const errorCode = typeof error === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(error) ? error : null;
  const runObservation = { state: state as Run['state'], updatedAt, errorCode };
  const manifest: CodingEvidenceManifest = {
    schemaVersion: 1, projection: 'coding-evidence-manifest-v1', kind: 'coding-run-observation', codingRunId: runId, sessionId, workspaceId, inputId, identitySha256: jsonTextSha256(identity),
    prompt: promptIdentity, source: sourceIdentity, configuration: { ...configuration, sha256: configHash, credentials: 'not-read', providerRequest: 'not-exported' },
    journal: { stream: 'session-v2', afterSeq: trajectory.range.afterSeq, throughSeq: trajectory.range.frozenThroughSeq, inspectedThroughSeq: trajectory.range.inspectedThroughSeq, projectionSha256: journalHash, rawJournalSha256: null, sessionFrontier: 'unknown', truncated: trajectory.coverage.truncated },
    runObservation: { ...runObservation, runProjectionSha256: jsonTextSha256({ identity, observation: runObservation }), rawRunSha256: null },
    providerAttempts: latestAttempts(trajectory.events, runId),
    outputs: trajectory.events.filter(event => event.runId === runId && event.output !== null).map(event => ({ partId: event.record?.id ?? null, ...event.output!, sourceSeq: event.seq })),
    outcome: { execution: state as Run['state'], verification: 'not-observed', taskSuccess: 'not-established', billedTokens: null },
    coverage: { providerAttempts: 'selected-journal-window-only', currentRecordJoin: 'not-read', filesAndCheckpoints: 'not-read', providerEffects: 'not-executed', rawCredentialsAndReplay: 'not-exported', attachmentBytes: 'not-read', sourceClock: 'run-read-and-journal-read-separately', mutableRunStateMayBeNewerThanJournal: true },
    manifestSha256: '0'.repeat(64),
  };
  const { manifestSha256: _omitted, ...projection } = manifest;
  manifest.manifestSha256 = jsonTextSha256(projection);
  return manifest;
}
