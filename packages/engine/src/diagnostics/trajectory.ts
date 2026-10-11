import { types } from 'node:util';
import { EngineError, type Session, type SessionEventV2 } from '@moodcode/contracts';
import { jsonTextSha256, sha256Hex } from '../shared/canonical.js';
import { isBoundedId, isSha256, plainRecord } from '../shared/data.js';
import { ownData } from './validation.js';

export const TRAJECTORY_LIMITS = Object.freeze({ defaultEvents: 50, maxEvents: 100, defaultBytes: 65_536, minBytes: 2_048, maxBytes: 262_144 });
export interface TrajectoryReader {
  getSession(sessionId: string): Session;
  readSessionEvents(sessionId: string, afterSeq: number, limit?: number): SessionEventV2[];
}
export interface TrajectoryOptions {
  sessionId: string;
  afterSeq?: number;
  /** An immutable journal boundary, not an assertion that this is the current session frontier. */
  throughSeq?: number;
  limit?: number;
  maxBytes?: number;
  /** Selection does not change the session cursor: pages still advance past other Runs. */
  runId?: string;
}
export type DiagnosticErrorClass = 'authentication' | 'rate-limit' | 'context-limit' | 'rejection' | 'transport' | 'timeout' | 'protocol' | 'cancelled' | 'cleanup-uncertain' | 'unknown';
export interface DiagnosticError {
  code: string | null;
  category: DiagnosticErrorClass;
  requiresRecoveryObservation: boolean;
  retryDecision: 'not-decided-by-inspector';
}
export interface TrajectoryUsage {
  source: 'journal-usage-observation';
  revision: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningOutputTokens: number | null;
  invalidFields: string[];
  inclusiveTotals: true;
  billedTokens: null;
}
export interface TrajectoryEvent {
  eventId: string; seq: number; timestamp: string; type: string;
  runId: string | null; turnId: string | null; attemptId: string | null; inputId: string | null;
  record: { kind: string; id: string | null; state: string | null; revision: number | null; contextRevisionId: string | null; sourceSha256: string | null } | null;
  output: { kind: 'text' | 'reasoning'; bytes: number; sha256: string; partial: boolean } | null;
  tool: { toolCallId: string | null; name: string | null; inputSha256: string | null; resultSha256: string | null; state: string | null; resultObserved: boolean } | null;
  request: { projection: 'engine-turn-request-v1'; sha256: string; bytes: number | null; cleanupState: string | null; cleanupConfirmed: boolean | null } | null;
  usage: TrajectoryUsage | null;
  error: DiagnosticError | null;
}
export interface JournalProjection {
  schemaVersion: 1;
  projection: 'engine-diagnostic-trajectory-v1';
  stream: 'session-v2'; sessionId: string; workspaceId: string; runId: string | null;
  range: { afterSeq: number; requestedThroughSeq: number | null; frozenThroughSeq: number; inspectedThroughSeq: number };
  events: TrajectoryEvent[];
  coverage: {
    source: 'bounded-native-journal-page'; sessionFrontier: 'unknown';
    inspectedEvents: number; selectedEvents: number; omittedSelectedEvents: number;
    completeRequestedRange: boolean | null; truncated: boolean;
    stopReason: 'event-limit' | 'byte-limit' | 'requested-boundary' | 'source-page-end';
    rawPayloads: 'not-exported'; opaqueProviderReplay: 'not-exported'; credentials: 'not-read';
    producerEffects: 'not-executed'; replay: 'inspection-only'; rawJournalSha256: null;
  };
  nextCursor: { sessionId: string; afterSeq: number; throughSeq: number | null } | null;
  projectionSha256: string;
}

function invalid(message: string): never { throw new EngineError('INVALID_TRAJECTORY_OPTIONS', message); }
function id(value: unknown): string | null { return isBoundedId(value) ? value : null; }
function number(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function digest(value: unknown): string | null { return isSha256(value) ? value : null; }
function state(value: unknown): string | null {
  return typeof value === 'string' && ['created', 'pending', 'promoted', 'cancelled', 'prepared', 'dispatched', 'streaming', 'awaiting_tools', 'open', 'completed', 'failed', 'interrupted', 'uncertain', 'confirmed', 'not-dispatched', 'running', 'allowed', 'denied'].includes(value) ? value : null;
}
function jsonDigest(value: unknown): string | null {
  let nodes = 8_192, bytes = 0;
  const parents = new Set<object>();
  const valid = (item: unknown, depth: number): boolean => {
    if (--nodes < 0 || depth > 32) return false;
    if (typeof item === 'string') { bytes += Buffer.byteLength(item); return bytes <= 1_048_576; }
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return true;
    if (!item || typeof item !== 'object' || types.isProxy(item) || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(item)) || parents.has(item)) return false;
    parents.add(item);
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || !valid(descriptor.value, depth + 1)) return false;
      bytes += Buffer.byteLength(key); if (bytes > 1_048_576) return false;
    }
    parents.delete(item); return true;
  };
  if (!valid(value, 0)) return null;
  const encoded = JSON.stringify(value);
  return Buffer.byteLength(encoded) <= 1_048_576 ? sha256Hex(encoded) : null;
}

/** Typed errors are diagnostic observations. Retry and recovery eligibility stay in their original owners. */
export function classifyDiagnosticError(value: unknown): DiagnosticError {
  const raw = typeof value === 'string' ? value : ownData(value, 'code');
  const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(raw) ? raw : null;
  const httpStatus = number(ownData(ownData(value, 'details'), 'status'));
  let category: DiagnosticErrorClass = 'unknown';
  if (code === 'CLEANUP_UNCERTAIN') category = 'cleanup-uncertain';
  else if (['RUN_CANCELLED', 'ENGINE_CLOSED', 'RUN_TIME_LIMIT'].includes(code ?? '')) category = 'cancelled';
  else if (['PROVIDER_AUTH_ERROR', 'PROVIDER_AUTHENTICATION_ERROR'].includes(code ?? '') || code === 'PROVIDER_HTTP_ERROR' && [401, 403].includes(httpStatus ?? 0)) category = 'authentication';
  else if (code === 'PROVIDER_RATE_LIMIT' || code === 'PROVIDER_HTTP_ERROR' && httpStatus === 429) category = 'rate-limit';
  else if (code === 'PROVIDER_CONTEXT_OVERFLOW') category = 'context-limit';
  else if (['PROVIDER_TIMEOUT', 'PROVIDER_REQUEST_TIMEOUT', 'PROVIDER_INACTIVITY_TIMEOUT'].includes(code ?? '')) category = 'timeout';
  else if (code === 'PROVIDER_TRANSPORT_ERROR') category = 'transport';
  else if (['PROVIDER_PROTOCOL_ERROR', 'PROVIDER_INVALID_RESPONSE', 'PROVIDER_STREAM_ERROR'].includes(code ?? '')) category = 'protocol';
  else if (code === 'PROVIDER_HTTP_ERROR') category = 'rejection';
  return { code, category, requiresRecoveryObservation: ['transport', 'timeout', 'cleanup-uncertain'].includes(category), retryDecision: 'not-decided-by-inspector' };
}

function projectUsage(observation: unknown): TrajectoryUsage {
  const source = ownData(observation, 'usage');
  const usage = source === undefined ? observation : source;
  const invalidFields: string[] = [];
  const token = (key: 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'reasoningOutputTokens'): number | null => {
    const raw = ownData(usage, key), parsed = number(raw);
    if (raw !== undefined && raw !== null && parsed === null) invalidFields.push(key);
    return parsed;
  };
  const result: TrajectoryUsage = { source: 'journal-usage-observation', revision: number(ownData(observation, 'revision')), inputTokens: token('inputTokens'), outputTokens: token('outputTokens'), cachedInputTokens: token('cachedInputTokens'), reasoningOutputTokens: token('reasoningOutputTokens'), invalidFields, inclusiveTotals: true, billedTokens: null };
  if (result.cachedInputTokens !== null && result.inputTokens !== null && result.cachedInputTokens > result.inputTokens) { result.cachedInputTokens = null; invalidFields.push('cachedInputTokens'); }
  if (result.reasoningOutputTokens !== null && result.outputTokens !== null && result.reasoningOutputTokens > result.outputTokens) { result.reasoningOutputTokens = null; invalidFields.push('reasoningOutputTokens'); }
  return result;
}

function projectEvent(event: SessionEventV2): TrajectoryEvent {
  const payload = ownData(event, 'payload');
  const type = String(ownData(event, 'type'));
  const result: TrajectoryEvent = {
    eventId: id(ownData(event, 'eventId'))!, seq: number(ownData(event, 'seq'))!, timestamp: String(ownData(event, 'timestamp')), type,
    runId: id(ownData(event, 'runId')), turnId: id(ownData(event, 'turnId')), attemptId: id(ownData(event, 'attemptId')), inputId: id(ownData(event, 'inputId')),
    record: null, output: null, tool: null, request: null, usage: null, error: null,
  };
  for (const kind of ['turn', 'attempt', 'part', 'context', 'input', 'observation', 'cleanup'] as const) {
    const record = ownData(payload, kind);
    if (!record || typeof record !== 'object' || types.isProxy(record)) continue;
    result.record = { kind, id: id(ownData(record, 'id')) ?? id(ownData(record, 'attemptId')), state: state(ownData(record, 'state')), revision: number(ownData(record, 'revision')), contextRevisionId: id(ownData(record, 'contextRevisionId')), sourceSha256: digest(ownData(record, 'sha256')) };
    if (kind === 'part' && (ownData(record, 'type') === 'text' || ownData(record, 'type') === 'reasoning')) {
      const text = ownData(record, 'text');
      if (typeof text === 'string') result.output = { kind: ownData(record, 'type') as 'text' | 'reasoning', bytes: Buffer.byteLength(text), sha256: sha256Hex(text), partial: state(ownData(record, 'state')) !== 'completed' };
    }
    if (kind === 'part' && ownData(record, 'type') === 'tool') result.tool = { toolCallId: id(ownData(record, 'toolCallId')), name: id(ownData(record, 'name')), inputSha256: jsonDigest(ownData(record, 'input')), resultSha256: jsonDigest(ownData(record, 'result')), state: state(ownData(record, 'state')), resultObserved: ownData(record, 'result') !== undefined };
    if (ownData(record, 'requestProjection') === 'engine-turn-request-v1' && digest(ownData(record, 'requestSha256'))) {
      const confirmed = ownData(record, 'cleanupConfirmed');
      result.request = { projection: 'engine-turn-request-v1', sha256: digest(ownData(record, 'requestSha256'))!, bytes: number(ownData(record, 'requestBytes')), cleanupState: state(ownData(record, 'state')), cleanupConfirmed: typeof confirmed === 'boolean' ? confirmed : null };
    }
    const errorCode = ownData(record, 'errorCode');
    if (errorCode !== undefined) result.error = classifyDiagnosticError(errorCode);
    if (kind === 'observation' && type === 'provider.attempt.usage') result.usage = projectUsage(record);
    break;
  }
  const directError = ownData(payload, 'error');
  if (directError !== undefined) result.error = classifyDiagnosticError(directError);
  else if (ownData(payload, 'errorCode') !== undefined) result.error = classifyDiagnosticError(ownData(payload, 'errorCode'));
  return result;
}

/** Host wrappers call this before reading any selection property. */
export function validateTrajectoryOptions(options: TrajectoryOptions): void {
  plainRecord(options, [], ['sessionId', 'afterSeq', 'throughSeq', 'limit', 'maxBytes', 'runId'], fault => invalid(fault === 'shape' ? 'Trajectory options must be plain data' : 'Trajectory options reject unknown fields and accessors'));
  if (!id(ownData(options, 'sessionId')) || options.runId !== undefined && !id(options.runId)) return invalid('Session and Run identities must be bounded strings');
  const afterSeq = options.afterSeq ?? 0, throughSeq = options.throughSeq, limit = options.limit ?? TRAJECTORY_LIMITS.defaultEvents, maxBytes = options.maxBytes ?? TRAJECTORY_LIMITS.defaultBytes;
  if (number(afterSeq) === null || throughSeq !== undefined && (number(throughSeq) === null || throughSeq < afterSeq)) return invalid('Journal boundaries must be ordered nonnegative safe integers');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TRAJECTORY_LIMITS.maxEvents || !Number.isSafeInteger(maxBytes) || maxBytes < TRAJECTORY_LIMITS.minBytes || maxBytes > TRAJECTORY_LIMITS.maxBytes) return invalid('Event count or export byte budget is invalid');
}

/** One bounded immutable journal page. It never invokes providers, tools, recovery or current-record replay. */
export function exportTrajectory(reader: TrajectoryReader, options: TrajectoryOptions): JournalProjection {
  validateTrajectoryOptions(options);
  const afterSeq = options.afterSeq ?? 0, throughSeq = options.throughSeq, limit = options.limit ?? TRAJECTORY_LIMITS.defaultEvents, maxBytes = options.maxBytes ?? TRAJECTORY_LIMITS.defaultBytes;
  const session = reader.getSession(options.sessionId);
  if (session.id !== options.sessionId || !id(session.workspaceId)) throw new EngineError('TRAJECTORY_SCOPE_MISMATCH', 'Trajectory session owner is invalid');
  // An extra row provides a bounded continuation observation. A short native
  // page may result from its own source byte cap and is never treated as EOF.
  const readLimit = Math.min(limit + 1, 100, throughSeq === undefined ? 100 : throughSeq - afterSeq);
  const raw = readLimit === 0 ? [] : reader.readSessionEvents(options.sessionId, afterSeq, readLimit);
  if (!Array.isArray(raw) || raw.length > readLimit) throw new EngineError('TRAJECTORY_SOURCE_INVALID', 'Journal reader exceeded its bounded contract');
  let previous = afterSeq;
  for (const event of raw) {
    if (ownData(event, 'sessionId') !== session.id || ownData(event, 'schemaVersion') !== 2 || ownData(event, 'stream') !== 'session-v2' || number(ownData(event, 'seq')) === null || Number(ownData(event, 'seq')) <= previous || !id(ownData(event, 'eventId')) || typeof ownData(event, 'type') !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/u.test(String(ownData(event, 'type'))) || typeof ownData(event, 'timestamp') !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(String(ownData(event, 'timestamp'))) || !Number.isFinite(Date.parse(String(ownData(event, 'timestamp'))))) throw new EngineError('TRAJECTORY_SOURCE_INVALID', 'Journal page has invalid ownership, identity or ordering');
    previous = event.seq;
  }
  const observedEnd = raw.at(-1)?.seq ?? afterSeq;
  const boundary = throughSeq === undefined ? observedEnd : Math.min(throughSeq, observedEnd);
  const report: JournalProjection = {
    schemaVersion: 1, projection: 'engine-diagnostic-trajectory-v1', stream: 'session-v2', sessionId: session.id, workspaceId: session.workspaceId, runId: options.runId ?? null,
    range: { afterSeq, requestedThroughSeq: throughSeq ?? null, frozenThroughSeq: boundary, inspectedThroughSeq: afterSeq }, events: [],
    coverage: { source: 'bounded-native-journal-page', sessionFrontier: 'unknown', inspectedEvents: 0, selectedEvents: 0, omittedSelectedEvents: 0, completeRequestedRange: throughSeq === afterSeq ? true : null, truncated: false, stopReason: 'source-page-end', rawPayloads: 'not-exported', opaqueProviderReplay: 'not-exported', credentials: 'not-read', producerEffects: 'not-executed', replay: 'inspection-only', rawJournalSha256: null },
    nextCursor: null, projectionSha256: '0'.repeat(64),
  };
  // Reserve final coverage/cursor metadata before admitting another record.
  const fits = (): boolean => Buffer.byteLength(JSON.stringify(report)) + 128 <= maxBytes;
  for (const event of raw) {
    if (event.seq > boundary) { report.coverage.stopReason = 'requested-boundary'; report.coverage.completeRequestedRange = true; break; }
    if (report.coverage.inspectedEvents >= limit) { report.coverage.truncated = true; report.coverage.stopReason = 'event-limit'; break; }
    const selected = options.runId === undefined || ownData(event, 'runId') === options.runId;
    if (selected) report.events.push(projectEvent(event));
    const lastInspected = report.range.inspectedThroughSeq;
    report.range.inspectedThroughSeq = event.seq; report.coverage.inspectedEvents++;
    report.coverage.selectedEvents = report.events.length;
    // Reserve the real cursor before testing bytes so the final report cannot
    // grow past its budget when truncation discovers one oversized event.
    report.nextCursor = { sessionId: session.id, afterSeq: event.seq, throughSeq: throughSeq ?? null };
    if (!fits()) {
      if (selected) report.events.pop();
      report.range.inspectedThroughSeq = lastInspected; report.coverage.inspectedEvents--; report.coverage.selectedEvents = report.events.length;
      report.coverage.truncated = true; report.coverage.stopReason = 'byte-limit'; break;
    }
  }
  const notExported = raw.filter(event => event.seq <= boundary && event.seq > report.range.inspectedThroughSeq && (options.runId === undefined || ownData(event, 'runId') === options.runId)).length;
  report.coverage.omittedSelectedEvents = notExported;
  if (throughSeq !== undefined && report.range.inspectedThroughSeq >= throughSeq) { report.coverage.completeRequestedRange = true; if (!report.coverage.truncated) report.coverage.stopReason = 'requested-boundary'; }
  else if (throughSeq !== undefined && report.coverage.truncated) report.coverage.completeRequestedRange = false;
  // Always allow a continuation when the session frontier is unknown, even for
  // empty/short pages. Consumers stop by their own bound, not by invented EOF.
  report.nextCursor = report.coverage.completeRequestedRange === true ? null : { sessionId: session.id, afterSeq: report.range.inspectedThroughSeq, throughSeq: throughSeq ?? null };
  if (Buffer.byteLength(JSON.stringify(report)) > maxBytes) throw new EngineError('TRAJECTORY_EXPORT_LIMIT', 'Trajectory metadata exceeds the byte budget');
  const { projectionSha256: _omitted, ...projection } = report;
  report.projectionSha256 = jsonTextSha256(projection);
  return report;
}
