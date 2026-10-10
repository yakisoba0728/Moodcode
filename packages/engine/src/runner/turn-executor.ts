import { createHash, randomUUID } from 'node:crypto';
import { EngineError, SESSION_SCHEMA_VERSION, type MessagePart, type ProviderAttempt, type Run, type TurnRecord } from '@moodcode/contracts';
import type { EngineStore, ExecutionRecordStore, ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { BudgetAccount } from '../config/budgets.js';
import type { AttemptCleanupSettlement } from '../storage/attempt-cleanup.js';

type Wait = <T>(operation: () => Promise<T>, signal: AbortSignal, label: string) => Promise<T>;
const timestamp = () => new Date().toISOString();
export function executionRecords(store: EngineStore): ExecutionRecordStore | undefined {
  const native = store as EngineStore & Partial<ExecutionRecordStore>;
  return typeof native.putTurn === 'function' && typeof native.putAttempt === 'function' && typeof native.putPart === 'function' ? native as ExecutionRecordStore : undefined;
}
interface TurnExecutorOptions {
  run: Run; index: number; inputIds: string[]; budget: BudgetAccount; store: EngineStore; wait: Wait;
  contextRevisionId?: string;
  currentContextRevisionId?: () => string | undefined;
  assertContextFresh?: (request: TurnRequest, signal: AbortSignal) => Promise<void>;
  recoverContextOverflow?: () => Promise<import('../ports.js').ProviderMessage[]>;
  beforeAdapterIntent?: (originalRequest: TurnRequest, signal: AbortSignal) => void;
  beforeAdapterDispatch?: (originalRequest: TurnRequest, signal: AbortSignal) => void;
  afterAdapterSettlement?: (originalRequest: TurnRequest) => void;
}

/** Owns provider dispatch/attempt timeouts and durable part lifecycle; tools settle this turn later. */
export class TurnExecutor {
  readonly id = randomUUID();
  readonly records: ExecutionRecordStore | undefined;
  private turn: TurnRecord;
  private attempt?: ProviderAttempt;
  private readonly parts = new Map<string, MessagePart>();
  private readonly partIndices = new Map<string, number>();
  private summaryDependency?: NonNullable<TurnRecord['uncertainty']>['summaryDependency'];
  constructor(private readonly options: TurnExecutorOptions) {
    this.records = executionRecords(options.store);
    this.turn = { schemaVersion: SESSION_SCHEMA_VERSION, id: this.id, sessionId: options.run.sessionId, runId: options.run.id, inputIds: options.inputIds,
      index: options.index, state: 'created', createdAt: timestamp(), ...(options.contextRevisionId ? { contextRevisionId: options.contextRevisionId } : {}) };
    this.records?.putTurn(this.turn);
  }
  get attemptId(): string | undefined { return this.attempt?.id; }
  async *stream(provider: ProviderAdapter, request: TurnRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const budgets = this.options.budget.budgets;
    let overflowRecovered = false;
    for (let index = 0; index < budgets.maxProviderAttempts; index++) {
      this.options.budget.startProviderAttempt();
      const contextRevisionId = this.options.currentContextRevisionId?.() ?? this.options.contextRevisionId;
      this.attempt = { schemaVersion: SESSION_SCHEMA_VERSION, id: randomUUID(), sessionId: this.turn.sessionId, runId: this.turn.runId, turnId: this.id, index,
        providerId: provider.id, modelId: request.modelId, state: 'prepared', createdAt: timestamp(), ...(contextRevisionId ? { contextRevisionId } : {}) };
      this.records?.putAttempt(this.attempt);
      // Each attempt owns detached data; adapter mutation must not change the
      // original tools/messages used by a retry or its durable request digest.
      const dispatchedRequest: TurnRequest = structuredClone({ ...request, turnId: this.id, attemptId: this.attempt.id, ...(this.records ? { includeMetadata: true } : {}) });
      const cleanupStore = this.records?.createAttemptCleanup && this.records.dispatchAttemptCleanup && this.records.settleAttemptCleanup ? this.records : undefined;
      if (this.records && [this.records.createAttemptCleanup, this.records.dispatchAttemptCleanup, this.records.settleAttemptCleanup].some(Boolean) && !cleanupStore) {
        throw new EngineError('CLEANUP_UNCERTAIN', 'Provider cleanup storage is only partially configured');
      }
      if (cleanupStore) {
        const encoded = JSON.stringify(dispatchedRequest);
        cleanupStore.createAttemptCleanup!({ attemptId: this.attempt.id, sessionId: this.turn.sessionId, workspaceId: this.options.run.workspaceId,
          runId: this.turn.runId, turnId: this.id, providerId: provider.id, modelId: request.modelId,
          requestProjection: 'engine-turn-request-v1', requestSha256: createHash('sha256').update(encoded).digest('hex'), requestBytes: Buffer.byteLength(encoded),
          ...(contextRevisionId ? { contextRevisionId } : {}) });
      }
      const timerAbort = new AbortController(), combined = AbortSignal.any([signal, timerAbort.signal]);
      const requestTimer = setTimeout(() => timerAbort.abort(new EngineError('PROVIDER_REQUEST_TIMEOUT', 'Provider request exceeded its absolute timeout')), budgets.providerRequestTimeoutMs);
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
      const resetInactivity = () => { clearTimeout(inactivityTimer); inactivityTimer = setTimeout(() => timerAbort.abort(new EngineError('PROVIDER_INACTIVITY_TIMEOUT', 'Provider stream stopped making progress')), budgets.providerInactivityTimeoutMs); };
      let iterator: AsyncIterator<ProviderEvent> | undefined;
      let observed = false;
      let contentObserved = false;
      let providerInvoked = false, streamDone = false, cleanupDispatched = false;
      let failure: unknown;
      try {
        if (combined.aborted) throw combined.reason;
        // Validate the fixed logical request on every attempt, including after retry backoff.
        // A stale source ends this Turn; it must not silently replace a retry's messages.
        if (this.options.assertContextFresh) {
          const expected = createHash('sha256').update(JSON.stringify(dispatchedRequest)).digest('hex');
          const checking = structuredClone(dispatchedRequest);
          await this.options.wait(() => this.options.assertContextFresh!(checking, combined), combined, 'Context freshness');
          if (combined.aborted) throw combined.reason;
          if (createHash('sha256').update(JSON.stringify(checking)).digest('hex') !== expected)
            throw new EngineError('CONTEXT_REVISION_STALE', 'Context freshness validation attempted to rewrite a frozen request');
          if (this.options.currentContextRevisionId && this.options.currentContextRevisionId() !== contextRevisionId)
            throw new EngineError('CONTEXT_REVISION_STALE', 'Context revision changed during attempt freshness validation');
        }
        // Record dispatch intent first. If its transaction fails, the ordinary
        // attempt still has no dispatch timestamp and can prove no-dispatch.
        this.options.beforeAdapterIntent?.(dispatchedRequest, combined);
        cleanupStore?.dispatchAttemptCleanup!(this.attempt.id); cleanupDispatched = true;
        const dispatched: ProviderAttempt = { ...this.attempt, state: 'dispatched', dispatchedAt: timestamp() };
        this.records?.putAttempt(dispatched); this.attempt = dispatched;
        this.options.beforeAdapterDispatch?.(dispatchedRequest, combined);
        providerInvoked = true;
        iterator = provider.streamTurn(dispatchedRequest, combined)[Symbol.asyncIterator]();
        resetInactivity();
        while (true) {
          const item = await this.options.wait(() => iterator!.next(), combined, 'Provider stream');
          if (item.done === true) { streamDone = true; return; }
          resetInactivity();
          if (!observed) { observed = true; this.attempt = { ...this.attempt, state: 'streaming' }; this.records?.putAttempt(this.attempt); this.setTurn('streaming'); }
          if (item.value.type === 'progress' && item.value.providerRequestId !== undefined) {
            const providerRequestId = item.value.providerRequestId;
            if (typeof providerRequestId !== 'string' || !providerRequestId.trim() || Buffer.byteLength(providerRequestId) > 256 || /[\u0000-\u001f\u007f]/u.test(providerRequestId) || this.attempt.providerRequestId && this.attempt.providerRequestId !== providerRequestId) throw new EngineError('PROVIDER_PROTOCOL_ERROR', 'Provider request identity changed during the attempt');
            this.attempt = { ...this.attempt, providerRequestId }; this.records?.putAttempt(this.attempt);
          }
          if (item.value.type !== 'progress') contentObserved = true;
          yield item.value;
        }
      } catch (error) {
        failure = (combined.aborted ? combined.reason : error) ?? new EngineError('PROVIDER_ERROR', 'Provider failed without an error value');
      } finally {
        clearTimeout(requestTimer); clearTimeout(inactivityTimer);
        // This finally also runs when the consumer closes at a yield. The outer
        // generator closing is not evidence that the actual provider has closed.
        const reason = streamDone ? 'natural-done' : signal.aborted ? 'cancel' : failure !== undefined ? 'error' : 'consumer-close';
        let settlement: AttemptCleanupSettlement;
        if (streamDone) settlement = { outcome: 'confirmed', method: 'iterator-next-done', reason };
        else if (!providerInvoked && !cleanupDispatched) settlement = { outcome: 'not-dispatched', method: 'no-dispatch', reason };
        else {
          timerAbort.abort(new EngineError('PROVIDER_STREAM_CLOSED', 'Provider attempt stream is closing'));
          let method: AttemptCleanupSettlement['method'] = 'iterator-unavailable';
          if (!iterator) method = 'iterator-unavailable';
          else {
            // Reading a custom iterator's return or done property can itself
            // fail. Such a failure is an unknown cleanup observation as well.
            let close: AsyncIterator<ProviderEvent>['return'];
            try { close = iterator.return; } catch { method = 'return-rejected'; }
            if (method !== 'return-rejected') {
              if (typeof close !== 'function') method = 'return-missing';
              else {
                let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
                method = await Promise.race([
                  Promise.resolve().then(() => close!.call(iterator)).then(result => result?.done === true ? 'iterator-return-done' as const : 'return-not-done' as const).catch(() => 'return-rejected' as const),
                  new Promise<'return-timeout'>(resolve => { cleanupTimer = setTimeout(() => resolve('return-timeout'), 1000); }),
                ]);
                clearTimeout(cleanupTimer);
              }
            }
          }
          settlement = { outcome: method === 'iterator-return-done' ? 'confirmed' : 'uncertain', method, reason };
        }
        if (this.attempt.providerRequestId) settlement.providerRequestId = this.attempt.providerRequestId;
        if (failure instanceof EngineError) settlement.errorCode = failure.code;
        try { cleanupStore?.settleAttemptCleanup!(this.attempt.id, settlement); }
        catch { throw new EngineError('CLEANUP_UNCERTAIN', 'Provider cleanup observation could not be durably recorded', { attemptId: this.attempt.id }); }
        finally { this.options.afterAdapterSettlement?.(dispatchedRequest); }
        if (settlement.outcome === 'uncertain') throw new EngineError('CLEANUP_UNCERTAIN', 'Provider attempt cleanup could not be confirmed', { attemptId: this.attempt.id, method: settlement.method });
      }
      const retry = !observed && !signal.aborted && failure instanceof EngineError && failure.code === 'PROVIDER_HTTP_ERROR'
        && (provider.retryableHttpStatuses ?? [429, 503]).includes(failure.details?.status as number) && index + 1 < budgets.maxProviderAttempts;
      const recoverOverflow = !contentObserved && !overflowRecovered && !signal.aborted && failure instanceof EngineError && failure.code === 'PROVIDER_CONTEXT_OVERFLOW'
        && this.options.recoverContextOverflow !== undefined && index + 1 < budgets.maxProviderAttempts;
      if (!retry && !recoverOverflow) throw failure;
      this.setAttempt('failed');
      if (recoverOverflow) {
        overflowRecovered = true;
        try { request = { ...request, messages: await this.options.recoverContextOverflow!() }; }
        catch (error) {
          const summaryAttemptId = error instanceof EngineError && error.code === 'CLEANUP_UNCERTAIN' ? error.details?.summaryAttemptId : undefined;
          if (typeof summaryAttemptId === 'string' && this.records?.getSummaryOverflowDependency) {
            try { this.summaryDependency = this.records.getSummaryOverflowDependency(summaryAttemptId, this.id, this.attempt.id); }
            catch { throw new EngineError('CLEANUP_UNCERTAIN', 'Overflow summary dependency could not be durably established', { summaryAttemptId, failedAttemptId: this.attempt.id }); }
          }
          throw error;
        }
        continue;
      }
      const supplied = (failure as EngineError).details?.retryAfterMs;
      const delay = typeof supplied === 'number' && Number.isSafeInteger(supplied) && supplied >= 0 ? Math.min(60_000, supplied) : Math.min(60_000, budgets.retryBaseDelayMs * 2 ** index);
      // Retry backoff follows durable cleanup and belongs to the whole Run.
      await this.options.wait(() => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      }), signal, 'Provider retry delay');
    }
    throw new EngineError('RETRY_LIMIT', 'Provider attempt budget was exhausted');
  }
  outputFinished(finishReason: string, tools: boolean): void {
    this.setAttempt('completed');
    this.turn = { ...this.turn, finishReason };
    if (tools) this.setTurn('awaiting_tools'); else this.complete();
  }
  complete(): void {
    this.finishParts('completed');
    this.setTurn('completed', timestamp());
  }
  fail(error: unknown): void {
    if (['completed', 'failed', 'interrupted', 'uncertain'].includes(this.turn.state)) return;
    const code = error instanceof EngineError ? error.code : 'INTERNAL_ERROR';
    const ambiguous = ['CLEANUP_UNCERTAIN', 'PROVIDER_TRANSPORT_ERROR', 'PROVIDER_TIMEOUT', 'PROVIDER_REQUEST_TIMEOUT', 'PROVIDER_INACTIVITY_TIMEOUT'].includes(code);
    const state = ambiguous ? 'uncertain' : ['RUN_CANCELLED', 'ENGINE_CLOSED', 'RUN_TIME_LIMIT'].includes(code) ? 'interrupted' : 'failed';
    const reason = { kind: this.summaryDependency ? 'cleanup' as const : this.turn.state === 'awaiting_tools' ? 'tool_effect' as const : 'provider_dispatch' as const,
      message: 'Execution dispatch, effects or cleanup could not be established', requiresRecovery: true as const,
      ...(this.summaryDependency ? { summaryDependency: this.summaryDependency } : {}) };
    if (this.attempt && !['completed', 'failed', 'interrupted', 'uncertain'].includes(this.attempt.state)) {
      // A cleanup dispatch intent can be uncertain even when the separate
      // ordinary dispatch transaction failed. Preserve that prepared boundary;
      // the cleanup row and uncertain Turn continue to block new execution.
      const attemptState = ambiguous && this.attempt.state === 'prepared' && !this.attempt.dispatchedAt ? 'interrupted' : state;
      this.attempt = { ...this.attempt, state: attemptState, completedAt: timestamp(), ...(attemptState === 'uncertain' ? { uncertainty: reason } : {}) };
      this.records?.putAttempt(this.attempt);
    }
    this.finishParts(state === 'uncertain' ? 'interrupted' : state);
    this.turn = { ...this.turn, state, completedAt: timestamp(), ...(ambiguous ? { uncertainty: reason } : {}) };
    this.records?.putTurn(this.turn);
  }
  putText(messageId: string, type: 'text' | 'reasoning', content: string): void {
    const key = `${type}:${messageId}`;
    const previous = this.parts.get(key);
    const part: MessagePart = previous && (previous.type === 'text' || previous.type === 'reasoning') ? { ...previous, revision: previous.revision + 1, text: previous.text + content }
      : { ...this.partBase(messageId), type, text: content };
    this.parts.set(key, part); this.records?.putPart(part);
  }
  putMedia(messageId: string, event: Extract<ProviderEvent, { type: 'media' }>): void {
    const part: MessagePart = { ...this.partBase(messageId), type: 'media', mime: event.mime, artifact: event.artifact, ...(event.name ? { name: event.name } : {}) };
    this.records?.putPart(part); this.parts.set(part.id, part);
  }
  toolProposal(messageId: string, internalId: string, call: import('@moodcode/contracts').ProviderToolCall): void {
    const part: MessagePart = { ...this.partBase(messageId), type: 'tool', toolCallId: internalId, providerCallId: call.id, name: call.name, input: call.input };
    this.parts.set(internalId, part); this.records?.putPart(part);
  }
  toolResult(internalId: string, result: import('@moodcode/contracts').JsonValue, failed: boolean): void {
    const part = this.parts.get(internalId);
    if (!part || part.type !== 'tool') throw new EngineError('TOOL_PART_NOT_FOUND', 'Tool result has no durable proposal');
    const next: MessagePart = { ...part, result, revision: part.revision + 1, state: failed ? 'failed' : 'completed', completedAt: timestamp() };
    this.parts.set(internalId, next); this.records?.putPart(next);
  }
  private partBase(messageId: string) {
    const index = this.partIndices.get(messageId) ?? 0;
    this.partIndices.set(messageId, index + 1);
    return { schemaVersion: SESSION_SCHEMA_VERSION, id: randomUUID(), sessionId: this.turn.sessionId, runId: this.turn.runId, turnId: this.id, messageId,
      index, revision: 0, state: 'open' as const, createdAt: timestamp() };
  }
  private finishParts(state: 'completed' | 'failed' | 'interrupted'): void {
    for (const [key, part] of this.parts) if (part.state === 'open') {
      const next = { ...part, state, revision: part.revision + 1, completedAt: timestamp() };
      this.parts.set(key, next); this.records?.putPart(next);
    }
  }
  private setAttempt(state: 'completed' | 'failed'): void { if (this.attempt) { this.attempt = { ...this.attempt, state, completedAt: timestamp() }; this.records?.putAttempt(this.attempt); } }
  private setTurn(state: TurnRecord['state'], completedAt?: string): void { this.turn = { ...this.turn, state, ...(completedAt ? { completedAt } : {}) }; this.records?.putTurn(this.turn); }
}
