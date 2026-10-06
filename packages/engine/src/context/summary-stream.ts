import { EngineError } from '@moodcode/contracts';
import type { ContextRequest, ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import type { SqliteStore } from '../storage/index.js';

export interface SummaryUsageSnapshot {
  inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; reasoningOutputTokens: number | null;
}
export type SummaryLifecycleStore = Pick<SqliteStore, 'dispatchSummaryAttempt' | 'observeSummaryAttempt' | 'markSummaryProviderCompleted' | 'settleSummaryAttempt'>;
export function summaryFailureCode(error: unknown): string {
  return error instanceof EngineError ? error.code : error instanceof Error && error.name === 'AbortError' ? 'CANCELLED' : 'SUMMARY_FAILED';
}
function cancelled(signal: AbortSignal): void { if (signal.aborted) throw signal.reason ?? new EngineError('CANCELLED', 'Summary was cancelled'); }

/** A failed derived result never activates; unresolved cleanup or durable settlement is fatal. */
export function settleSummaryFailure(store: SummaryLifecycleStore, id: string, error: unknown, cleanupConfirmed: boolean, interrupted = false): void {
  const code = summaryFailureCode(error);
  try {
    store.settleSummaryAttempt(id, { state: !cleanupConfirmed ? 'uncertain' : interrupted || ['CANCELLED', 'ENGINE_CLOSED'].includes(code) ? 'interrupted' : 'failed',
      errorCode: code, cleanupConfirmed });
  } catch {
    throw new EngineError('CLEANUP_UNCERTAIN', 'Summary terminal outcome could not be durably recorded', { summaryAttemptId: id, failureCode: code });
  }
}

/** Shared provider protocol for both summary families; success remains unpublished until the checkpoint transaction. */
export async function streamSummary(options: {
  store: SummaryLifecycleStore; id: string; request: ContextRequest; provider: ProviderAdapter; turnRequest: TurnRequest; maxOutputBytes: number;
}): Promise<{ text: string; usage: SummaryUsageSnapshot }> {
  const { store, id, request, provider, turnRequest, maxOutputBytes } = options;
  if (!request.budget || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 65_536) throw new EngineError('SUMMARY_OWNER_REQUIRED', 'Summary stream requires a shared Run budget and bounded output');
  const deadline = new AbortController(), combined = AbortSignal.any([request.signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(new EngineError('SUMMARY_REQUEST_TIMEOUT', 'Summary request exceeded its timeout')), request.budget.budgets.providerRequestTimeoutMs);
  let inactivity: ReturnType<typeof setTimeout> | undefined;
  const progress = () => { clearTimeout(inactivity); inactivity = setTimeout(() => deadline.abort(new EngineError('SUMMARY_INACTIVITY_TIMEOUT', 'Summary stopped making progress')), request.budget!.budgets.providerInactivityTimeoutMs); };
  let usage: SummaryUsageSnapshot = { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null };
  let text = '', finish = false, streamDone = false, providerInvoked = false, cleanupConfirmed = false, iterator: AsyncIterator<ProviderEvent> | undefined;
  let failure: unknown;
  try {
    cancelled(combined);
    store.dispatchSummaryAttempt(id); cancelled(combined); providerInvoked = true;
    iterator = provider.streamTurn(turnRequest, combined)[Symbol.asyncIterator](); progress();
    for (;;) {
      const next = await new Promise<IteratorResult<ProviderEvent>>((resolve, reject) => {
        const abort = () => reject(combined.reason); combined.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => iterator!.next()).then(resolve, reject).finally(() => combined.removeEventListener('abort', abort));
        if (combined.aborted) abort();
      });
      cancelled(combined);
      if (next.done) { streamDone = true; cleanupConfirmed = true; break; }
      progress();
      const event = next.value;
      if (finish && event.type !== 'usage') throw new EngineError('SUMMARY_PROTOCOL_ERROR', 'Summary emitted content after finish');
      if (event.type === 'text.delta') {
        if (typeof event.delta !== 'string') throw new EngineError('SUMMARY_PROTOCOL_ERROR', 'Summary text must be a string');
        const bytes = Buffer.byteLength(event.delta);
        let budgetFailure: unknown;
        try { request.consumeSummaryOutput?.(bytes); } catch (error) { budgetFailure = error === undefined ? new EngineError('OUTPUT_LIMIT', 'Summary output budget failed without an error value') : error; }
        // Retain the observed prefix even if the shared budget or this local cap
        // rejects the result. Retention and observed-byte counters are independent.
        store.observeSummaryAttempt(id, { textDelta: event.delta });
        if (budgetFailure !== undefined) throw budgetFailure;
        if (Buffer.byteLength(text) + bytes > maxOutputBytes) throw new EngineError('SUMMARY_OUTPUT_LIMIT', 'Summary output exceeded its byte limit');
        text += event.delta;
      } else if (event.type === 'usage') {
        const nextUsage = { ...usage };
        for (const key of Object.keys(usage) as (keyof SummaryUsageSnapshot)[]) if (event[key] !== undefined && event[key] !== null) {
          const value = event[key]!;
          if (!Number.isSafeInteger(value) || value < 0 || usage[key] !== null && value < usage[key]!) throw new EngineError('SUMMARY_PROTOCOL_ERROR', 'Summary usage snapshots must be nonnegative and nondecreasing');
          nextUsage[key] = value;
        }
        if (nextUsage.cachedInputTokens !== null && nextUsage.inputTokens !== null && nextUsage.cachedInputTokens > nextUsage.inputTokens
          || nextUsage.reasoningOutputTokens !== null && nextUsage.outputTokens !== null && nextUsage.reasoningOutputTokens > nextUsage.outputTokens) throw new EngineError('SUMMARY_PROTOCOL_ERROR', 'Summary usage subsets exceed inclusive totals');
        store.observeSummaryAttempt(id, { usage: nextUsage }); usage = nextUsage;
      } else if (event.type === 'finish') {
        store.observeSummaryAttempt(id, { finishReason: event.reason });
        if (event.reason !== 'stop') throw new EngineError('SUMMARY_INCOMPLETE', 'Summary did not finish normally');
        finish = true;
      } else if (event.type === 'progress') {
        store.observeSummaryAttempt(id, { ...(event.providerRequestId !== undefined ? { providerRequestId: event.providerRequestId } : {}) });
      } else throw new EngineError('SUMMARY_PROTOCOL_ERROR', 'Summary must contain only text, progress and usage');
    }
    if (!finish || !text.trim()) throw new EngineError('SUMMARY_INCOMPLETE', 'Empty or incomplete summary cannot replace working memory');
    cancelled(combined);
  } catch (error) { failure = error === undefined ? new EngineError('SUMMARY_FAILED', 'Summary provider failed without an error value') : error; }
  finally {
    clearTimeout(timer); clearTimeout(inactivity);
    if (!streamDone) {
      deadline.abort();
      if (iterator?.return) {
        let cleanup: ReturnType<typeof setTimeout> | undefined;
        cleanupConfirmed = await Promise.race([Promise.resolve().then(() => iterator!.return!()).then(result => result?.done === true, () => false),
          new Promise<boolean>(resolve => { cleanup = setTimeout(() => resolve(false), 1000); })]);
        clearTimeout(cleanup);
      } else cleanupConfirmed = !providerInvoked;
      if (!cleanupConfirmed) failure = new EngineError('CLEANUP_UNCERTAIN', 'Summary provider cleanup could not be confirmed');
    }
  }
  if (failure !== undefined) {
    settleSummaryFailure(store, id, failure, cleanupConfirmed, request.signal.aborted); throw failure;
  }
  try {
    cancelled(request.signal); store.markSummaryProviderCompleted(id);
    return { text, usage };
  } catch (error) { settleSummaryFailure(store, id, error, true, request.signal.aborted); throw error; }
}
