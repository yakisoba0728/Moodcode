import { types } from 'node:util';
import { EngineError } from '@moodcode/contracts';
import { validateHostGenerationRequest, type HostGenerationProviderPort, type HostGenerationRequest } from '../provider/generation.js';
import { normalizeKnowledgeGenerationBudget } from './generation-budget.js';
import type { KnowledgeGenerationBudget, KnowledgeGenerationCleanup, KnowledgeGenerationObservation, KnowledgeGenerationSettlement } from './generation-types.js';
import type { KnowledgeUsage } from './types.js';
import { knowledgeHostRecord, UNKNOWN_KNOWLEDGE_USAGE } from './validation.js';

export interface KnowledgeGenerationStreamOptions {
  readonly provider: HostGenerationProviderPort;
  readonly request: HostGenerationRequest;
  readonly signal: AbortSignal;
  readonly budget: KnowledgeGenerationBudget;
  /** The original admitted operation deadline, including cleanup; never renewed. */
  readonly deadline: number;
  /** Synchronous durable dispatch intent, committed before entering the adapter. */
  readonly onDispatch: () => void;
  readonly onObservation: (observation: KnowledgeGenerationObservation) => void;
  /** Synchronous durable settlement; failure rejects rather than claiming completion. */
  readonly onSettlement: (settlement: KnowledgeGenerationSettlement) => void;
}
export interface KnowledgeGenerationStreamOutcome extends KnowledgeGenerationSettlement {
  readonly text: string;
  readonly observedTextBytes: number;
  readonly retainedBytes: number;
  readonly outputTruncated: boolean;
  readonly observationBytes: number;
  readonly events: number;
  readonly usage: KnowledgeUsage;
  readonly providerRequestId: string | null;
  readonly finishReason: 'stop' | null;
  readonly streamDone: boolean;
}

const PROTOCOL_MESSAGE = 'Host knowledge generation did not satisfy its bounded text-only protocol.';
function fail(code: string): never { throw new EngineError(code, PROTOCOL_MESSAGE); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  return knowledgeHostRecord(value, required, optional, 'KNOWLEDGE_GENERATION_PROTOCOL', PROTOCOL_MESSAGE);
}
/** Opaque finish replay is charged and discarded, never copied into durable evidence. */
function dataBytes(value: unknown, maximum: number): number {
  let nodes = 0, bytes = 0;
  const charge = (count: number) => { bytes += count; if (bytes > maximum) fail('KNOWLEDGE_OBSERVATION_LIMIT'); };
  function visit(item: unknown, depth: number): void {
    if (++nodes > 4_096 || depth > 12) fail('KNOWLEDGE_GENERATION_PROTOCOL');
    if (item === null || typeof item === 'boolean') { charge(item === null ? 4 : item ? 4 : 5); return; }
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('KNOWLEDGE_GENERATION_PROTOCOL'); charge(String(item).length); return; }
    if (typeof item === 'string') { if (Buffer.byteLength(item) > maximum - bytes) fail('KNOWLEDGE_OBSERVATION_LIMIT'); charge(Buffer.byteLength(JSON.stringify(item))); return; }
    if (!item || typeof item !== 'object' || types.isProxy(item)) fail('KNOWLEDGE_GENERATION_PROTOCOL');
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 4_096 || Reflect.ownKeys(item).length !== item.length + 1) fail('KNOWLEDGE_GENERATION_PROTOCOL');
      charge(2 + Math.max(0, item.length - 1));
      for (let index = 0; index < item.length; index++) { const descriptor = Object.getOwnPropertyDescriptor(item, String(index)); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('KNOWLEDGE_GENERATION_PROTOCOL'); visit(descriptor.value, depth + 1); }
      return;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail('KNOWLEDGE_GENERATION_PROTOCOL');
    const descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(descriptors); charge(2 + Math.max(0, keys.length - 1));
    for (const key of keys) { const descriptor = descriptors[key as string]!; if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('KNOWLEDGE_GENERATION_PROTOCOL'); charge(Buffer.byteLength(JSON.stringify(key)) + 1); visit(descriptor.value, depth + 1); }
  }
  visit(value, 0); return bytes;
}
function code(error: unknown): string {
  if (error && typeof error === 'object' && !types.isProxy(error)) { const descriptor = Object.getOwnPropertyDescriptor(error, 'code'); if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(descriptor.value)) return descriptor.value; }
  return 'KNOWLEDGE_PROVIDER_FAILED';
}
function synchronous(result: unknown): void {
  if (types.isPromise(result)) { void (result as Promise<unknown>).catch(() => {}); fail('KNOWLEDGE_CALLBACK_ASYNC'); }
}
function prefix(text: string, bytes: number): string { let result = '', charged = 0; for (const point of text) { const size = Buffer.byteLength(point); if (charged + size > bytes) break; result += point; charged += size; } return result; }
function usageAfter(previous: KnowledgeUsage, event: Record<string, unknown>): KnowledgeUsage {
  const result = { ...previous }, mapping = { inputTokens: 'inputTokens', outputTokens: 'outputTokens', cachedInputTokens: 'cachedInputTokens', reasoningOutputTokens: 'reasoningTokens' } as const;
  for (const key of Object.keys(mapping) as (keyof typeof mapping)[]) {
    const value = event[key], target = mapping[key];
    if (!Object.hasOwn(event, key) || value === null) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 0 || result[target] !== null && (value as number) < result[target]!) fail('KNOWLEDGE_USAGE_INVALID');
    result[target] = value as number;
  }
  if (result.inputTokens !== null && result.cachedInputTokens !== null && result.cachedInputTokens > result.inputTokens || result.outputTokens !== null && result.reasoningTokens !== null && result.reasoningTokens > result.outputTokens) fail('KNOWLEDGE_USAGE_INVALID');
  return Object.freeze(result);
}
function iteratorResult(value: unknown): { done: boolean; value: unknown } {
  const fields = record(value, ['done'], ['value']);
  if (typeof fields.done !== 'boolean' || !fields.done && !Object.hasOwn(fields, 'value')) fail('KNOWLEDGE_GENERATION_PROTOCOL');
  return { done: fields.done, value: fields.value };
}
/** Protocol methods are executable ports; accessors and proxy traps are not protocol data. */
function method(value: unknown, key: string | symbol): ((...args: unknown[]) => unknown) | undefined {
  let current = value;
  for (let depth = 0; current !== null && depth < 8; depth++) {
    if (!current || typeof current !== 'object' && typeof current !== 'function' || types.isProxy(current)) fail('KNOWLEDGE_GENERATION_PROTOCOL');
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) { if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') fail('KNOWLEDGE_GENERATION_PROTOCOL'); return descriptor.value; }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}
async function until<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); throw signal.reason; }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
async function returnCleanup(iterator: AsyncIterator<unknown>, deadline: number, timeout: number): Promise<KnowledgeGenerationCleanup> {
  const cleanupDeadline = Math.min(deadline, Date.now() + timeout);
  let operation: Promise<unknown>;
  try { const close = method(iterator, 'return'); if (!close) return Object.freeze({ confirmed: false, method: 'unknown', reason: 'iterator_return_missing' }); operation = Promise.resolve(close.call(iterator)); }
  catch { return Object.freeze({ confirmed: false, method: 'iterator-return', reason: 'iterator_return_rejected' }); }
  const remaining = Math.max(0, cleanupDeadline - Date.now());
  if (!remaining) { void operation.catch(() => {}); return Object.freeze({ confirmed: false, method: 'iterator-return', reason: 'cleanup_deadline' }); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup deadline')), remaining); })]);
    if (Date.now() >= cleanupDeadline) return Object.freeze({ confirmed: false, method: 'iterator-return', reason: 'cleanup_deadline' });
    try { const actual = iteratorResult(result); return Object.freeze({ confirmed: actual.done, method: 'iterator-return', reason: actual.done ? null : 'iterator_return_not_done' }); }
    catch { return Object.freeze({ confirmed: false, method: 'iterator-return', reason: 'iterator_return_malformed' }); }
  } catch { return Object.freeze({ confirmed: false, method: 'iterator-return', reason: 'iterator_return_rejected_or_timeout' }); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Exactly one tools-free attempt. Callback observations are data; neither output nor this result confers owner authority. */
export async function streamKnowledgeGeneration(options: KnowledgeGenerationStreamOptions): Promise<KnowledgeGenerationStreamOutcome> {
  const request = validateHostGenerationRequest(options.request), budget = normalizeKnowledgeGenerationBudget(options.budget);
  const generate = method(options.provider, 'streamGeneration');
  if (!Number.isSafeInteger(options.deadline) || options.deadline < 0 || options.deadline > 8_640_000_000_000_000 || !generate || !options.signal || typeof options.signal.addEventListener !== 'function' || typeof options.onDispatch !== 'function' || typeof options.onObservation !== 'function' || typeof options.onSettlement !== 'function') fail('INVALID_KNOWLEDGE_GENERATION_STREAM');
  const start = Date.now(), deadline = Math.min(options.deadline, start + budget.maxDurationMs), requestDeadline = Math.min(deadline - budget.cleanupTimeoutMs, start + budget.providerRequestTimeoutMs), controller = new AbortController();
  let text = '', observedTextBytes = 0, retainedBytes = 0, observationBytes = 0, events = 0, usage = UNKNOWN_KNOWLEDGE_USAGE, providerRequestId: string | null = null, finishReason: 'stop' | null = null, streamDone = false, outputTruncated = false;
  let iterator: AsyncIterator<unknown> | undefined, providerEntered = false, callbackFailed = false, errorCode: string | undefined, timeout: 'request' | 'inactivity' | undefined;
  let requestTimer: ReturnType<typeof setTimeout> | undefined, inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => { controller.abort(new EngineError('KNOWLEDGE_GENERATION_CANCELLED', 'Host generation was cancelled.')); };
  options.signal.addEventListener('abort', abort, { once: true }); if (options.signal.aborted) abort();
  const stopForTimeout = (kind: 'request' | 'inactivity') => { if (controller.signal.aborted) return; timeout = kind; controller.abort(new EngineError(kind === 'request' ? 'KNOWLEDGE_REQUEST_TIMEOUT' : 'KNOWLEDGE_INACTIVITY_TIMEOUT', 'Host generation deadline expired.')); };
  function refreshInactivity(): void {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    const remaining = requestDeadline - Date.now(), kind = remaining <= budget.inactivityTimeoutMs ? 'request' : 'inactivity';
    inactivityTimer = setTimeout(() => stopForTimeout(kind), Math.max(0, Math.min(remaining, budget.inactivityTimeoutMs)));
  }
  function observe(value: Omit<KnowledgeGenerationObservation, 'eventCount'>): void {
    if (callbackFailed) fail('KNOWLEDGE_OBSERVATION_FAILED');
    try { synchronous(options.onObservation(Object.freeze({ ...value, eventCount: events }))); }
    catch { callbackFailed = true; fail('KNOWLEDGE_OBSERVATION_FAILED'); }
  }
  function charge(value: number): void { if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(observationBytes + value)) fail('KNOWLEDGE_OBSERVATION_LIMIT'); observationBytes += value; }
  let cleanup: KnowledgeGenerationCleanup;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (Date.now() >= requestDeadline) fail('KNOWLEDGE_REQUEST_TIMEOUT');
    synchronous(options.onDispatch());
    if (controller.signal.aborted) throw controller.signal.reason;
    if (Date.now() >= requestDeadline) fail('KNOWLEDGE_REQUEST_TIMEOUT');
    requestTimer = setTimeout(() => stopForTimeout('request'), Math.max(0, requestDeadline - Date.now())); refreshInactivity();
    providerEntered = true;
    const iterable = generate.call(options.provider, request, controller.signal);
    const open = method(iterable, Symbol.asyncIterator); if (!open) fail('KNOWLEDGE_GENERATION_PROTOCOL');
    iterator = open.call(iterable) as AsyncIterator<unknown>;
    const next = method(iterator, 'next'); if (!next) fail('KNOWLEDGE_GENERATION_PROTOCOL');
    while (true) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (Date.now() >= requestDeadline) fail('KNOWLEDGE_REQUEST_TIMEOUT');
      const result = iteratorResult(await until(Promise.resolve(next.call(iterator)), controller.signal));
      if (controller.signal.aborted) throw controller.signal.reason;
      if (Date.now() >= requestDeadline) fail('KNOWLEDGE_REQUEST_TIMEOUT');
      if (result.done) { streamDone = true; observe({ streamDone: true, observationBytes: 0 }); break; }
      refreshInactivity(); events++;
      if (events > budget.maxEvents) { observe({ observationBytes: 0 }); fail('KNOWLEDGE_EVENT_LIMIT'); }
      const header = record(result.value, ['type'], ['delta', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'providerRequestId', 'reason', 'replayItems', 'call', 'mime', 'name', 'artifact']);
      if (header.type === 'text.delta' || header.type === 'reasoning.delta') {
        const event = record(result.value, ['type', 'delta']); if (finishReason !== null || typeof event.delta !== 'string') fail('KNOWLEDGE_GENERATION_PROTOCOL');
        const bytes = Buffer.byteLength(event.delta);
        if (header.type === 'reasoning.delta') { charge(bytes); observe({ observationBytes: bytes }); }
        else {
          if (!Number.isSafeInteger(observedTextBytes + bytes)) fail('KNOWLEDGE_OUTPUT_LIMIT'); observedTextBytes += bytes;
          if (/[\uD800-\uDFFF]/u.test(event.delta) || event.delta.includes('\0')) { outputTruncated = true; observe({ textDelta: '', textBytes: bytes, outputTruncated: true, observationBytes: 0 }); fail('KNOWLEDGE_GENERATION_PROTOCOL'); }
          const selected = prefix(event.delta, Math.max(0, budget.maxOutputBytes - retainedBytes)); text += selected; retainedBytes += Buffer.byteLength(selected); outputTruncated ||= selected !== event.delta;
          observe({ textDelta: selected, textBytes: bytes, ...(outputTruncated ? { outputTruncated: true as const } : {}), observationBytes: 0 });
          if (observedTextBytes > budget.maxOutputBytes || outputTruncated) fail('KNOWLEDGE_OUTPUT_LIMIT');
        }
      } else if (header.type === 'usage') {
        const event = record(result.value, ['type'], ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens']);
        const next = usageAfter(usage, event), bytes = dataBytes(event, budget.maxObservationBytes); charge(bytes); usage = next; observe({ usage, observationBytes: bytes });
      } else if (header.type === 'progress') {
        const event = record(result.value, ['type'], ['providerRequestId']); if (finishReason !== null) fail('KNOWLEDGE_GENERATION_PROTOCOL');
        if (Object.hasOwn(event, 'providerRequestId')) { const id = event.providerRequestId; if (typeof id !== 'string' || !id.trim() || /[\u0000-\u001f\u007f]/u.test(id) || Buffer.byteLength(id) > 256 || providerRequestId !== null && providerRequestId !== id) fail('KNOWLEDGE_GENERATION_PROTOCOL'); providerRequestId = id; }
        const bytes = dataBytes(event, budget.maxObservationBytes); charge(bytes); observe({ ...(providerRequestId === null ? {} : { providerRequestId }), observationBytes: bytes });
      } else if (header.type === 'finish') {
        const event = record(result.value, ['type', 'reason'], ['replayItems']); if (finishReason !== null) fail('KNOWLEDGE_GENERATION_PROTOCOL'); if (event.reason !== 'stop') fail('PROVIDER_UNSUPPORTED_OUTPUT');
        const bytes = dataBytes(event, budget.maxObservationBytes); charge(bytes); finishReason = 'stop'; observe({ finishReason, observationBytes: bytes });
      } else if (header.type === 'tool.call' || header.type === 'media') fail('PROVIDER_UNSUPPORTED_OUTPUT');
      else fail('KNOWLEDGE_GENERATION_PROTOCOL');
      if (observationBytes > budget.maxObservationBytes) fail('KNOWLEDGE_OBSERVATION_LIMIT');
    }
    if (finishReason !== 'stop' || !text.trim()) fail('KNOWLEDGE_GENERATION_INCOMPLETE');
  } catch (error) { errorCode = code(error); }
  finally { if (requestTimer !== undefined) clearTimeout(requestTimer); if (inactivityTimer !== undefined) clearTimeout(inactivityTimer); options.signal.removeEventListener('abort', abort); }
  if (streamDone) cleanup = Object.freeze({ confirmed: true, method: 'iterator-complete', reason: null });
  else if (!providerEntered) cleanup = Object.freeze({ confirmed: true, method: 'not-dispatched', reason: null });
  else { controller.abort(new EngineError(errorCode ?? 'KNOWLEDGE_GENERATION_INCOMPLETE', 'Host generation is closing.')); cleanup = iterator ? await returnCleanup(iterator, deadline, budget.cleanupTimeoutMs) : Object.freeze({ confirmed: false, method: 'unknown', reason: 'iterator_unavailable' }); }
  // An adapter may own transport cleanup behind its iterator; its explicit failure cannot be erased by a later closed generator.
  if (errorCode === 'CLEANUP_UNCERTAIN') cleanup = Object.freeze({ confirmed: false, method: cleanup.method, reason: 'adapter_cleanup_uncertain' });
  if (callbackFailed) errorCode = 'KNOWLEDGE_OBSERVATION_FAILED';
  if (errorCode === undefined && options.signal.aborted) errorCode = 'KNOWLEDGE_GENERATION_CANCELLED';
  if (errorCode === undefined && Date.now() >= deadline) errorCode = 'KNOWLEDGE_GENERATION_DEADLINE';
  const state = !cleanup.confirmed ? 'uncertain' : options.signal.aborted && !timeout ? 'cancelled' : errorCode ? 'failed' : 'completed';
  const settlement: KnowledgeGenerationSettlement = Object.freeze({ state, ...(errorCode === undefined ? {} : { errorCode }), cleanup, candidate: Object.freeze(state === 'completed' ? { state: 'pending' as const } : { state: 'withheld' as const, reason: errorCode ?? 'CLEANUP_UNCERTAIN' }) });
  try { synchronous(options.onSettlement(settlement)); } catch { fail('KNOWLEDGE_SETTLEMENT_FAILED'); }
  return Object.freeze({ ...settlement, text, observedTextBytes, retainedBytes, outputTruncated, observationBytes, events, usage, providerRequestId, finishReason, streamDone });
}
