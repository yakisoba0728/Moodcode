import {providerSegments} from '../media/segment-provider.js';
import { isDeepStrictEqual } from 'node:util';
import { EngineError, type JsonObject, type JsonValue, type ProviderToolCall } from '@moodcode/contracts';
import type { ModelSpec } from '../context/model-spec.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { boundedJson, JsonBudgetError } from '../artifacts/validation.js';
import { credentialSecrets, CredentialTextRedactor, malformed, positiveLimit, providerHttpFailure, providerRemoteError, publicError, record, redactCredentialJson, redactCredentialText } from './helpers.js';
import { replayCompatible } from './replay.js';
import { readSseData } from './sse.js';
import { messageImages, providerImages } from '../media/provider.js';
import { providerDocuments } from '../documents/provider.js';
import { hostGenerationTransportRequest, type HostGenerationRequest, type ProviderTransportRequest } from './generation.js';

export interface AnthropicProviderOptions {
  /** Host-only API prefix; no environment lookup or account discovery. */
  baseURL?: string;
  apiKey?: string;
  id?: string;
  fetch?: typeof globalThis.fetch;
  redactionSecrets?: readonly string[];
  /** Required by Messages; a request ceiling, not an asserted model capability. */
  maxTokens?: number;
  /** Adaptive thinking is explicit by default; legacy models can use disabled. */
  thinking?: 'adaptive' | 'disabled';
  /** Only the documented display:summarized API output becomes reasoning.delta. */
  publicReasoningSummary?: boolean;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  maxFrameBytes?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  maxReplayBytes?: number;
  maxToolArgumentBytes?: number;
  maxToolCalls?: number;
  maxOutputBlocks?: number;
}

export const ANTHROPIC_PROVIDER_CAPABILITIES = Object.freeze({
  inputModalities: Object.freeze(['text', 'image'] as const), outputModalities: Object.freeze(['text'] as const),
  clientTools: true, publicReasoningSummary: true, nativeReplay: true, media: false,
});

/** Adapter/host metadata, never a guessed catalog window or model output limit. */
export function anthropicModelSpec(modelId: string, options: { providerId?: string; thinking?: 'adaptive' | 'disabled'; observedAt?: string } = {}): ModelSpec {
  if (typeof modelId !== 'string' || !modelId.trim() || Buffer.byteLength(modelId) > 256 || /[\u0000-\u001f\u007f]/u.test(modelId)
    || options.providerId !== undefined && !/^[a-z][a-z0-9_-]{0,63}$/u.test(options.providerId)
    || options.thinking !== undefined && options.thinking !== 'adaptive' && options.thinking !== 'disabled'
    || options.observedAt !== undefined && !Number.isFinite(Date.parse(options.observedAt))) {
    throw new EngineError('INVALID_MODEL_SPEC', 'Anthropic host metadata is invalid.');
  }
  return { providerId: options.providerId ?? 'anthropic', modelId, contextWindow: null, maxOutputTokens: null,
    modalities: ['text', 'image'], tools: true, reasoning: options.thinking !== 'disabled', nativeReplay: true,
    source: { kind: 'host', observedAt: options.observedAt ?? new Date().toISOString(), reference: 'https://platform.claude.com/docs/en/api/messages/create' } };
}

type Usage = Extract<ProviderEvent, { type: 'usage' }>;
type Finish = Extract<ProviderEvent, { type: 'finish' }>['reason'];
interface Limits { timeoutMs: number; cleanupTimeoutMs: number; maxFrameBytes: number; maxResponseBytes: number; maxRequestBytes: number;
  maxReplayBytes: number; maxToolArgumentBytes: number; maxToolCalls: number; maxOutputBlocks: number }
interface Block { type: 'text' | 'tool_use' | 'thinking' | 'redacted_thinking'; stopped: boolean; text: string; signature: string;
  signatureSeen: boolean; id?: string; name?: string; input?: JsonObject; arguments: string; argumentDelta: boolean; data?: string }

function invalidRequest(): never { throw new EngineError('PROVIDER_INVALID_REQUEST', 'Provider request is invalid.'); }
function invalidReplay(): never { throw new EngineError('PROVIDER_INVALID_REPLAY', 'Provider replay is invalid.'); }
function safeJson(value: unknown, maximum: number, code: 'PROVIDER_INVALID_REQUEST' | 'PROVIDER_INVALID_REPLAY' | 'PROVIDER_MALFORMED_STREAM'): JsonValue {
  try { return boundedJson(value, maximum); } catch (error) {
    throw new EngineError(error instanceof JsonBudgetError && code !== 'PROVIDER_INVALID_REPLAY' ? 'PROVIDER_LIMIT_EXCEEDED' : code, 'Provider JSON is invalid or exceeds the configured bound.');
  }
}
function nonempty(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum || /[\u0000-\u001f\u007f]/u.test(value)) malformed();
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) malformed();
  return value;
}
function knownKeys(value: JsonObject, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalidReplay();
}
function stopReason(value: unknown): Finish {
  if (value === 'end_turn' || value === 'stop_sequence') return 'stop';
  if (value === 'tool_use') return 'tool_calls';
  if (value === 'max_tokens' || value === 'model_context_window_exceeded') return 'length';
  if (value === 'refusal') throw new EngineError('PROVIDER_CONTENT_FILTERED', 'Provider filtered the completion.');
  throw new EngineError('PROVIDER_UNSUPPORTED_FINISH_REASON', 'Provider returned an unsupported finish reason.');
}

/** Error strings are never reflected or guessed into context overflow. */
function streamError(value: unknown): EngineError {
  const source = record(value);
  const overflow = providerRemoteError(source);
  if (overflow.code === 'PROVIDER_CONTEXT_OVERFLOW') return overflow;
  const statuses: Readonly<Record<string, number>> = { rate_limit_error: 429, api_error: 500, timeout_error: 504, overloaded_error: 529 };
  const status = typeof source.type === 'string' && Object.hasOwn(statuses, source.type) ? statuses[source.type] : undefined;
  return status === undefined ? new EngineError('PROVIDER_REMOTE_ERROR', 'Provider reported an error in the stream.')
    : new EngineError('PROVIDER_HTTP_ERROR', `Provider HTTP request failed with status ${status}.`, { status });
}

function accumulateUsage(previous: JsonObject, value: unknown): JsonObject {
  const source = record(value);
  const result = { ...previous };
  for (const key of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
    if (source[key] === undefined || source[key] === null) continue;
    const next = count(source[key]);
    if (result[key] !== undefined && next < count(result[key])) malformed();
    result[key] = next;
  }
  return result;
}
function usageEvent(source: JsonObject, metadata: boolean): Usage {
  const event: Usage = { type: 'usage' };
  if (source.input_tokens !== undefined) {
    const total = count(source.input_tokens) + count(source.cache_creation_input_tokens ?? 0) + count(source.cache_read_input_tokens ?? 0);
    if (!Number.isSafeInteger(total)) malformed();
    event.inputTokens = total;
  }
  if (source.output_tokens !== undefined) event.outputTokens = count(source.output_tokens);
  if (metadata && source.cache_read_input_tokens !== undefined) event.cachedInputTokens = count(source.cache_read_input_tokens);
  // Output includes billed thinking tokens; summary length is not a reasoning token count.
  return event;
}

async function settles(operation: Promise<unknown>, timeout: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation.then(() => true, () => false), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeout); })]); }
  finally { clearTimeout(timer); }
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const abort = () => { aborted = true; reject(new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.')); };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); if (aborted) late?.(value); else resolve(value); }, error => { signal.removeEventListener('abort', abort); if (!aborted) reject(error); });
    if (signal.aborted) abort();
  });
}

/** Bound reader cancellation, including an injected non-cooperative stream. */
function boundedBody(body: ReadableStream<Uint8Array>, signal: AbortSignal, timeout: number): { stream: ReadableStream<Uint8Array>; close(): Promise<boolean> } {
  const reader = body.getReader();
  let closing: Promise<boolean> | undefined;
  const close = () => closing ??= (async () => {
    const clean = await settles(Promise.resolve().then(() => reader.cancel()), timeout);
    try { reader.releaseLock(); } catch { return false; }
    return clean;
  })();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const item = await abortable(reader.read(), signal); if (item.done) controller.close(); else controller.enqueue(item.value); }
      catch (error) { controller.error(error); }
    },
    async cancel() { await close(); },
  });
  return { stream, close };
}

/** One stateless Messages turn. Tool effects, attempts and retry budgets remain runner-owned. */
export class AnthropicProvider implements ProviderAdapter {
  readonly id: string;
  readonly replayProtocol: string;
  readonly retryableHttpStatuses = Object.freeze([429, 500, 503, 504, 529]);
  readonly inputModalities = ANTHROPIC_PROVIDER_CAPABILITIES.inputModalities;
  readonly inputFileTypes = Object.freeze([] as const);
  #endpoint: string;
  #apiKey: string | undefined;
  #secrets: string[];
  #fetch: typeof globalThis.fetch;
  #limits: Limits;
  #maxTokens: number;
  #thinking: 'adaptive' | 'disabled';
  #summary: boolean;

  constructor(options: AnthropicProviderOptions = {}) {
    this.#apiKey = options.apiKey;
    if (this.#apiKey !== undefined && (typeof this.#apiKey !== 'string' || !this.#apiKey.length || this.#apiKey.length > 4096 || /[^\x21-\x7e]/u.test(this.#apiKey))) {
      throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider API key must be bounded printable text.');
    }
    this.#secrets = credentialSecrets(this.#apiKey, options.redactionSecrets);
    this.id = options.id ?? 'anthropic';
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(this.id) || this.#secrets.some(secret => this.id.includes(secret))) throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider identifier is invalid.');
    let base: URL;
    try { base = new URL(options.baseURL ?? 'https://api.anthropic.com/v1'); } catch { throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider base URL is invalid.'); }
    if (base.username || base.password || base.search || base.hash || base.protocol !== 'https:' && (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) {
      throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider URL requires HTTPS or loopback HTTP without credentials, query or fragment.');
    }
    base.pathname = base.pathname.replace(/\/+$/u, '') + '/messages';
    this.#endpoint = base.href;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function') throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider requires HTTP fetch.');
    this.#thinking = options.thinking ?? 'adaptive';
    this.#summary = options.publicReasoningSummary ?? false;
    if (!['adaptive', 'disabled'].includes(this.#thinking) || typeof this.#summary !== 'boolean' || this.#summary && this.#thinking === 'disabled') {
      throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider thinking configuration is invalid.');
    }
    this.replayProtocol = `anthropic-messages-${this.#thinking === 'disabled' ? 'disabled' : this.#summary ? 'summarized' : 'omitted'}`;
    this.#maxTokens = positiveLimit(options.maxTokens, 4096);
    this.#limits = {
      timeoutMs: positiveLimit(options.timeoutMs, 60_000), cleanupTimeoutMs: positiveLimit(options.cleanupTimeoutMs, 1000),
      maxFrameBytes: positiveLimit(options.maxFrameBytes, 262_144), maxResponseBytes: positiveLimit(options.maxResponseBytes, 8_388_608),
      maxRequestBytes: positiveLimit(options.maxRequestBytes, 2_097_152), maxReplayBytes: positiveLimit(options.maxReplayBytes, 2_097_152),
      maxToolArgumentBytes: positiveLimit(options.maxToolArgumentBytes, 1_048_576), maxToolCalls: positiveLimit(options.maxToolCalls, 128),
      maxOutputBlocks: positiveLimit(options.maxOutputBlocks, 256),
    };
  }

  #replay(value: unknown): JsonObject[] {
    try {
      const cloned = safeJson(value, this.#limits.maxReplayBytes, 'PROVIDER_INVALID_REPLAY');
      if (!Array.isArray(cloned) || cloned.length > this.#limits.maxOutputBlocks) invalidReplay();
      let argumentBytes = 0, calls = 0;
      const ids = new Set<string>();
      const safeBlocks = cloned.map(value => {
        const block = record(value) as JsonObject;
        if (block.type === 'text') {
          knownKeys(block, ['type', 'text']); if (typeof block.text !== 'string') invalidReplay();
        } else if (block.type === 'tool_use') {
          knownKeys(block, ['type', 'id', 'name', 'input']);
          const id = nonempty(block.id), name = nonempty(block.name);
          if (ids.has(id) || ++calls > this.#limits.maxToolCalls) invalidReplay();
          ids.add(id); if (block.input === null || typeof block.input !== 'object' || Array.isArray(block.input)) invalidReplay();
          argumentBytes += Buffer.byteLength(JSON.stringify(block.input));
          if (argumentBytes > this.#limits.maxToolArgumentBytes || !/^[a-zA-Z0-9_-]{1,128}$/u.test(name)) invalidReplay();
        } else if (block.type === 'thinking') {
          knownKeys(block, ['type', 'thinking', 'signature']);
          if (this.#thinking === 'disabled' || typeof block.thinking !== 'string' || typeof block.signature !== 'string' || !block.signature
            || !this.#summary && block.thinking !== '' || this.#secrets.some(secret => String(block.signature).includes(secret))) invalidReplay();
        } else if (block.type === 'redacted_thinking') {
          knownKeys(block, ['type', 'data']);
          if (this.#thinking === 'disabled' || typeof block.data !== 'string' || !block.data || this.#secrets.some(secret => String(block.data).includes(secret))) invalidReplay();
        } else invalidReplay();
        const safe = redactCredentialJson(block, this.#secrets);
        if (safe === null || typeof safe !== 'object' || Array.isArray(safe)) invalidReplay();
        // Thinking text is authenticated along with its signature: redaction cannot mutate it.
        if (block.type === 'thinking' && !isDeepStrictEqual(block, safe)) invalidReplay();
        return safe;
      });
      const summaries = safeBlocks.filter(block => block.type === 'thinking').map(block => String(block.thinking)).join('');
      if (this.#secrets.some(secret => summaries.includes(secret))) invalidReplay();
      // Streaming redaction spans text blocks as well as network deltas. Replay must
      // preserve the same normalized text even when a credential straddled blocks.
      const texts = safeBlocks.filter(block => block.type === 'text');
      const textRedactor = new CredentialTextRedactor(this.#secrets);
      for (const [index, block] of texts.entries()) block.text = textRedactor.push(String(block.text), index === texts.length - 1);
      return safeBlocks;
    } catch { invalidReplay(); }
  }

  #messages(request: ProviderTransportRequest, signal: AbortSignal): { messages: JsonObject[]; system: JsonObject[] } {
    const messages: JsonObject[] = [], system: JsonObject[] = [];
    const images = providerImages(request, true, signal);
    let conversational = false;
    const pending = new Set<string>();
    const append = (role: 'user' | 'assistant', content: JsonObject[]) => {
      const last = messages.at(-1);
      if (last?.role === role) (last.content as JsonValue[]).push(...content);
      else messages.push({ role, content });
    };
    for (const message of request.messages) {
      if (typeof message.content !== 'string') invalidRequest();
      if (message.role === 'system') {
        if (conversational || message.toolCalls?.length || message.toolCallId || message.providerReplay) invalidRequest();
        if (message.content) system.push({ type: 'text', text: message.content });
        continue;
      }
      conversational = true;
      if (message.role === 'tool') {
        if (!message.toolCallId || !pending.delete(message.toolCallId) || message.toolCalls?.length || message.providerReplay) invalidRequest();
        append('user', [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }]);
        continue;
      }
      if (message.role !== 'user' && message.role !== 'assistant' || pending.size || message.toolCallId) invalidRequest();
      if (message.role === 'user' && (message.toolCalls?.length || message.providerReplay)) invalidRequest();
      let content: JsonObject[];
      if (message.role === 'assistant' && message.providerReplay) {
        if (!replayCompatible(message, this.id, request.modelId, this.replayProtocol)) invalidReplay();
        // Native binding is mandatory; old unbound or cross-model replay must not silently lose thinking.
        if (message.providerReplay.version !== 1 || message.providerReplay.modelId !== request.modelId || message.providerReplay.protocol !== this.replayProtocol) invalidReplay();
        content = this.#replay(message.providerReplay.items);
        const text = content.filter(block => block.type === 'text').map(block => String(block.text)).join('');
        const calls = content.filter(block => block.type === 'tool_use').map(block => ({ id: block.id, name: block.name, input: block.input }));
        const safeCalls = redactCredentialJson(message.toolCalls ?? [], this.#secrets);
        if (text !== redactCredentialText(message.content, this.#secrets) || !isDeepStrictEqual(calls, safeCalls)) invalidReplay();
      } else {
        content = [
          ...messageImages(message, images).map(image => ({ type: 'image', source: { type: 'base64', media_type: image.attachment.mimeType, data: image.data } })),
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ];
        for (const call of message.toolCalls ?? []) {
          if (!call.id || !/^[a-zA-Z0-9_-]{1,128}$/u.test(call.name)) invalidRequest();
          const input = safeJson(call.input, this.#limits.maxToolArgumentBytes, 'PROVIDER_INVALID_REQUEST');
          if (input === null || typeof input !== 'object' || Array.isArray(input)) invalidRequest();
          content.push({ type: 'tool_use', id: call.id, name: call.name, input });
        }
      }
      for (const block of content) if (block.type === 'tool_use') {
        if (pending.has(String(block.id))) invalidRequest(); pending.add(String(block.id));
      }
      if (content.length) append(message.role, content);
    }
    if (pending.size || !messages.length || messages[0]!.role !== 'user' || messages.at(-1)!.role !== 'user') invalidRequest();
    return { messages, system };
  }

  streamTurn(request: TurnRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    return this.#stream(request, signal, false);
  }

  streamGeneration(request: HostGenerationRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    return this.#stream(hostGenerationTransportRequest(request), signal, true);
  }

  async *#stream(request: ProviderTransportRequest, signal: AbortSignal, generation: boolean): AsyncGenerator<ProviderEvent> {
    if (signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.');
    providerSegments(request,()=>false,signal);
    providerDocuments(request, false, signal);
    let serialized: string;
    try {
      if (typeof request.modelId !== 'string' || !request.modelId.trim() || Buffer.byteLength(request.modelId) > 256 || /[\u0000-\u001f\u007f]/u.test(request.modelId)) invalidRequest();
      const input = this.#messages(request, signal);
      const tools = request.tools.map(tool => {
        if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(tool.name) || typeof tool.description !== 'string' || tool.inputSchema.type !== 'object') invalidRequest();
        return { name: tool.name, description: tool.description, input_schema: safeJson(tool.inputSchema, this.#limits.maxRequestBytes, 'PROVIDER_INVALID_REQUEST') };
      });
      if (new Set(tools.map(tool => tool.name)).size !== tools.length || tools.length > this.#limits.maxToolCalls) invalidRequest();
      // Unsupported effort names must not silently turn into a different setting.
      if (request.reasoningEffort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(request.reasoningEffort)) invalidRequest();
      const payload = { model: request.modelId, max_tokens: this.#maxTokens, stream: true, messages: input.messages,
        ...(input.system.length ? { system: input.system } : {}), ...(tools.length ? { tools } : {}),
        thinking: this.#thinking === 'disabled' ? { type: 'disabled' } : { type: 'adaptive', display: !generation && this.#summary ? 'summarized' : 'omitted' },
        ...(request.reasoningEffort === undefined ? {} : { output_config: { effort: request.reasoningEffort } }) };
      serialized = JSON.stringify(safeJson(payload, this.#limits.maxRequestBytes, 'PROVIDER_INVALID_REQUEST'));
    } catch (error) { throw publicError(error instanceof EngineError ? error : new EngineError('PROVIDER_INVALID_REQUEST', 'Provider request is invalid.')); }
    if (Buffer.byteLength(serialized) > this.#limits.maxRequestBytes) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider request exceeds the byte limit.');
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#limits.timeoutMs);
    let response: Response | undefined, body: ReturnType<typeof boundedBody> | undefined;
    const cancelled = () => { if (controller.signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.'); };
    try {
      if (signal.aborted) controller.abort();
      const fetching = Promise.resolve().then(() => this.#fetch(this.#endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'anthropic-version': '2023-06-01', ...(this.#apiKey ? { 'x-api-key': this.#apiKey } : {}) }, body: serialized,
      }));
      // A host owner cannot declare iterator cleanup while its actual fetch is still pending.
      response = generation ? await fetching : await abortable<Response>(fetching, controller.signal, late => { if (late.body && !late.body.locked) void settles(late.body.cancel(), this.#limits.cleanupTimeoutMs); });
      if (generation && response.body) body = boundedBody(response.body, controller.signal, this.#limits.cleanupTimeoutMs);
      cancelled();
      if (!response.ok) {
        // Shared bounded parser recognizes structured overflow codes, never remote prose.
        body ??= response.body ? boundedBody(response.body, controller.signal, this.#limits.cleanupTimeoutMs) : undefined;
        const rejection = body ? new Response(body.stream, { status: response.status, headers: response.headers }) : response;
        throw await providerHttpFailure(rejection, controller.signal);
      }
      if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream' || !response.body) malformed();
      body ??= boundedBody(response.body, controller.signal, this.#limits.cleanupTimeoutMs);
      const blocks = new Map<number, Block>();
      const text = new CredentialTextRedactor(this.#secrets), reasoning = new CredentialTextRedactor(this.#secrets);
      let started = false, stopped = false, finish: Finish | undefined, argumentBytes = 0, toolCount = 0;
      let usage: JsonObject = {};
      const requestId = response.headers.get('request-id');
      for await (const frame of readSseData(body.stream, controller.signal, this.#limits)) {
        cancelled();
        let parsed: unknown; try { parsed = JSON.parse(frame); } catch { malformed(); }
        const event = record(safeJson(parsed, this.#limits.maxFrameBytes, 'PROVIDER_MALFORMED_STREAM'));
        if (event.type === 'error') throw streamError(event.error);
        if (event.type === 'ping') continue;
        if (event.type === 'message_start') {
          if (started || finish !== undefined) malformed();
          const message = record(event.message);
          if (message.type !== 'message' || message.role !== 'assistant' || !Array.isArray(message.content) || message.content.length || message.stop_reason !== null) malformed();
          nonempty(message.id); nonempty(message.model); started = true;
          usage = accumulateUsage(usage, message.usage);
          if (request.includeMetadata) {
            const id = requestId && redactCredentialText(requestId, this.#secrets);
            if (id && id.trim() && Buffer.byteLength(id) <= 256 && !/[\u0000-\u001f\u007f]/u.test(id)) yield { type: 'progress', providerRequestId: id };
          }
          continue;
        }
        if (!started) malformed();
        if (event.type === 'content_block_start') {
          if (finish !== undefined) malformed();
          const index = count(event.index);
          if (index >= this.#limits.maxOutputBlocks) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider returned too many content blocks.');
          if (index !== blocks.size) malformed();
          const source = record(event.content_block), kind = source.type;
          if (!['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(String(kind))) throw new EngineError('PROVIDER_UNSUPPORTED_OUTPUT', 'Provider returned unsupported output.');
          const block: Block = { type: kind as Block['type'], stopped: false, text: '', signature: '', signatureSeen: false, arguments: '', argumentDelta: false };
          if (kind === 'text') { if (typeof source.text !== 'string') malformed(); block.text = source.text; }
          else if (kind === 'tool_use') {
            if (++toolCount > this.#limits.maxToolCalls) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider returned too many tool calls.');
            block.id = nonempty(source.id); block.name = nonempty(source.name, 128);
            if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(block.name)) malformed();
            block.input = record(source.input) as JsonObject;
          } else {
            if (this.#thinking === 'disabled') throw new EngineError('PROVIDER_UNSUPPORTED_OUTPUT', 'Provider returned unsupported thinking output.');
            if (kind === 'thinking') {
              if (typeof source.thinking !== 'string' || typeof source.signature !== 'string') malformed();
              if ((generation || !this.#summary) && source.thinking !== '') throw new EngineError('PROVIDER_UNSUPPORTED_OUTPUT', 'Provider returned thinking text without a summary contract.');
              block.text = source.thinking; block.signature = source.signature;
            } else { if (typeof source.data !== 'string' || !source.data) malformed(); block.data = source.data; }
          }
          blocks.set(index, block);
          if (block.text) { const delta = (kind === 'text' ? text : reasoning).push(block.text); if (delta && (!generation || kind === 'text')) yield { type: kind === 'text' ? 'text.delta' : 'reasoning.delta', delta }; }
          continue;
        }
        if (event.type === 'content_block_delta') {
          if (finish !== undefined) malformed();
          const block = blocks.get(count(event.index)); if (!block || block.stopped) malformed();
          const delta = record(event.delta);
          if (block.type === 'text' && delta.type === 'text_delta') {
            if (typeof delta.text !== 'string') malformed(); block.text += delta.text;
            const safe = text.push(delta.text); if (safe) yield { type: 'text.delta', delta: safe };
          } else if (block.type === 'tool_use' && delta.type === 'input_json_delta') {
            if (typeof delta.partial_json !== 'string' || Object.keys(block.input!).length) malformed();
            argumentBytes += Buffer.byteLength(delta.partial_json);
            if (argumentBytes > this.#limits.maxToolArgumentBytes) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider tool arguments exceed the byte limit.');
            block.argumentDelta = true; block.arguments += delta.partial_json;
          } else if (block.type === 'thinking' && delta.type === 'thinking_delta') {
            if (block.signatureSeen || typeof delta.thinking !== 'string') malformed();
            if ((generation || !this.#summary) && delta.thinking !== '') throw new EngineError('PROVIDER_UNSUPPORTED_OUTPUT', 'Provider returned thinking text without a summary contract.');
            block.text += delta.thinking;
            const safe = reasoning.push(delta.thinking); if (!generation && safe) yield { type: 'reasoning.delta', delta: safe };
          } else if (block.type === 'thinking' && delta.type === 'signature_delta') {
            if (block.signatureSeen || typeof delta.signature !== 'string' || !delta.signature) malformed();
            block.signatureSeen = true; block.signature += delta.signature;
          } else throw new EngineError('PROVIDER_UNSUPPORTED_EVENT', 'Provider returned an unsupported content delta.');
          continue;
        }
        if (event.type === 'content_block_stop') {
          if (finish !== undefined) malformed();
          const block = blocks.get(count(event.index)); if (!block || block.stopped) malformed(); block.stopped = true; continue;
        }
        if (event.type === 'message_delta') {
          if ([...blocks.values()].some(block => !block.stopped)) malformed();
          const delta = record(event.delta);
          if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
            const next = stopReason(delta.stop_reason); if (finish !== undefined && finish !== next) malformed(); finish = next;
          }
          if (event.usage !== undefined) usage = accumulateUsage(usage, event.usage);
          continue;
        }
        if (event.type === 'message_stop') { if (finish === undefined) malformed(); stopped = true; break; }
        // New top-level events cannot authorize effects; byte bounds still apply.
        if (typeof event.type !== 'string' || !event.type) malformed();
      }
      if (!started || !stopped || finish === undefined || [...blocks.values()].some(block => !block.stopped)) throw new EngineError('PROVIDER_INCOMPLETE_STREAM', 'Provider stream ended before completion.');
      if (!await body.close()) throw new EngineError('CLEANUP_UNCERTAIN', 'Provider stream cleanup could not be confirmed.');
      const native: JsonObject[] = [], calls: ProviderToolCall[] = [];
      const ids = new Set<string>();
      for (const block of blocks.values()) {
        if (block.type === 'text') native.push({ type: 'text', text: block.text });
        else if (block.type === 'thinking') {
          if (finish !== 'length' && !block.signature) malformed(); native.push({ type: 'thinking', thinking: block.text, signature: block.signature });
        } else if (block.type === 'redacted_thinking') native.push({ type: 'redacted_thinking', data: block.data! });
        else {
          // A length stop must never turn a partial argument prefix into an effect.
          if (finish === 'length') continue;
          let input: unknown = block.input;
          if (block.argumentDelta) { try { input = JSON.parse(block.arguments); } catch { malformed(); } }
          input = safeJson(input, this.#limits.maxToolArgumentBytes, 'PROVIDER_MALFORMED_STREAM');
          if (input === null || typeof input !== 'object' || Array.isArray(input)) malformed();
          const id = redactCredentialText(block.id!, this.#secrets), name = redactCredentialText(block.name!, this.#secrets);
          if (id !== block.id || name !== block.name || ids.has(id)) malformed(); ids.add(id);
          const safe = redactCredentialJson(input, this.#secrets);
          calls.push({ id, name, input: safe }); native.push({ type: 'tool_use', id, name, input: safe });
        }
      }
      if (finish !== 'length' && (finish === 'tool_calls') !== (calls.length > 0)) malformed();
      // Validate every native block and call before exposing any executable proposal.
      const replayItems = finish === 'length' ? undefined : this.#replay(native);
      const completedUsage = usageEvent(usage, request.includeMetadata === true);
      const textTail = text.push('', true), reasoningTail = reasoning.push('', true);
      if (generation && calls.length) throw new EngineError('PROVIDER_UNSUPPORTED_OUTPUT', 'Host generation cannot propose executable tools.');
      if (textTail) { cancelled(); yield { type: 'text.delta', delta: textTail }; }
      if (!generation && reasoningTail) { cancelled(); yield { type: 'reasoning.delta', delta: reasoningTail }; }
      for (const call of calls) { cancelled(); yield { type: 'tool.call', call }; }
      cancelled(); yield completedUsage;
      cancelled(); yield { type: 'finish', reason: finish, ...(generation || replayItems === undefined ? {} : { replayItems }) };
    } catch (error) {
      if (signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.');
      if (timedOut) throw new EngineError('PROVIDER_TIMEOUT', 'Provider turn timed out.');
      throw publicError(error);
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort();
      const clean = body ? await body.close() : response?.body && !response.body.locked ? await settles(response.body.cancel(), this.#limits.cleanupTimeoutMs) : true;
      if (!clean) throw new EngineError('CLEANUP_UNCERTAIN', 'Provider stream cleanup could not be confirmed.');
    }
  }
}
