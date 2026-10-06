import { randomUUID } from 'node:crypto';
import { EngineError, SESSION_SCHEMA_VERSION, type MessagePart, type ProviderAttempt, type Run, type TurnRecord } from '@moodcode/contracts';
import type { EngineStore, ExecutionRecordStore, ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { BudgetAccount } from '../config/budgets.js';

type Wait = <T>(operation: () => Promise<T>, signal: AbortSignal, label: string) => Promise<T>;
const timestamp = () => new Date().toISOString();
export function executionRecords(store: EngineStore): ExecutionRecordStore | undefined {
  const native = store as EngineStore & Partial<ExecutionRecordStore>;
  return typeof native.putTurn === 'function' && typeof native.putAttempt === 'function' && typeof native.putPart === 'function' ? native as ExecutionRecordStore : undefined;
}
export interface TurnExecutorOptions {
  run: Run; index: number; inputIds: string[]; budget: BudgetAccount; store: EngineStore; wait: Wait;
  contextRevisionId?: string;
  currentContextRevisionId?: () => string | undefined;
  recoverContextOverflow?: () => Promise<import('../ports.js').ProviderMessage[]>;
}

/** Owns provider dispatch/attempt timeouts and durable part lifecycle; tools settle this turn later. */
export class TurnExecutor {
  readonly id = randomUUID();
  readonly records: ExecutionRecordStore | undefined;
  private turn: TurnRecord;
  private attempt?: ProviderAttempt;
  private readonly parts = new Map<string, MessagePart>();
  private readonly partIndices = new Map<string, number>();
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
      const timerAbort = new AbortController(), combined = AbortSignal.any([signal, timerAbort.signal]);
      const requestTimer = setTimeout(() => timerAbort.abort(new EngineError('PROVIDER_REQUEST_TIMEOUT', 'Provider request exceeded its absolute timeout')), budgets.providerRequestTimeoutMs);
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
      const resetInactivity = () => { clearTimeout(inactivityTimer); inactivityTimer = setTimeout(() => timerAbort.abort(new EngineError('PROVIDER_INACTIVITY_TIMEOUT', 'Provider stream stopped making progress')), budgets.providerInactivityTimeoutMs); };
      let iterator: AsyncIterator<ProviderEvent> | undefined;
      let observed = false;
      let contentObserved = false;
      try {
        if (combined.aborted) throw combined.reason;
        this.attempt = { ...this.attempt, state: 'dispatched', dispatchedAt: timestamp() };
        this.records?.putAttempt(this.attempt);
        iterator = provider.streamTurn({ ...request, turnId: this.id, attemptId: this.attempt.id, ...(this.records ? { includeMetadata: true } : {}) }, combined)[Symbol.asyncIterator]();
        resetInactivity();
        while (true) {
          const item = await this.options.wait(() => iterator!.next(), combined, 'Provider stream');
          if (item.done) return;
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
        const failure = combined.aborted ? combined.reason : error;
        const retry = !observed && !signal.aborted && failure instanceof EngineError && failure.code === 'PROVIDER_HTTP_ERROR'
          && (provider.retryableHttpStatuses ?? [429, 503]).includes(failure.details?.status as number) && index + 1 < budgets.maxProviderAttempts;
        const recoverOverflow = !contentObserved && !overflowRecovered && !signal.aborted && failure instanceof EngineError && failure.code === 'PROVIDER_CONTEXT_OVERFLOW'
          && this.options.recoverContextOverflow !== undefined && index + 1 < budgets.maxProviderAttempts;
        if (iterator?.return) {
          // A return behind a non-cooperative next is bounded by the same cleanup rule.
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
          const clean = await Promise.race([Promise.resolve().then(() => iterator!.return!()).then(() => true, () => false), new Promise<boolean>(resolve => { cleanupTimer = setTimeout(() => resolve(false), 1000); })]);
          clearTimeout(cleanupTimer);
          if (!clean) throw new EngineError('CLEANUP_UNCERTAIN', 'Provider attempt cleanup could not be confirmed');
        }
        else if (iterator && (retry || recoverOverflow)) throw new EngineError('CLEANUP_UNCERTAIN', 'Provider retry requires an iterator with confirmed cleanup');
        if (!retry && !recoverOverflow) throw failure;
        this.setAttempt('failed');
        if (recoverOverflow) {
          overflowRecovered = true;
          clearTimeout(requestTimer); clearTimeout(inactivityTimer);
          request = { ...request, messages: await this.options.recoverContextOverflow!() };
          continue;
        }
        const supplied = failure.details?.retryAfterMs;
        const delay = typeof supplied === 'number' && Number.isSafeInteger(supplied) && supplied >= 0 ? Math.min(60_000, supplied) : Math.min(60_000, budgets.retryBaseDelayMs * 2 ** index);
        // Request timers belong to this attempt; retry backoff belongs to the whole Run.
        clearTimeout(requestTimer); clearTimeout(inactivityTimer);
        await this.options.wait(() => new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
          const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
          signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        }), signal, 'Provider retry delay');
      } finally { clearTimeout(requestTimer); clearTimeout(inactivityTimer); }
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
    const reason = { kind: this.turn.state === 'awaiting_tools' ? 'tool_effect' as const : 'provider_dispatch' as const, message: 'Execution dispatch, effects or cleanup could not be established', requiresRecovery: true as const };
    if (this.attempt && !['completed', 'failed', 'interrupted', 'uncertain'].includes(this.attempt.state)) {
      this.attempt = { ...this.attempt, state, completedAt: timestamp(), ...(ambiguous ? { uncertainty: reason } : {}) };
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
    this.parts.set(part.id, part); this.records?.putPart(part);
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
