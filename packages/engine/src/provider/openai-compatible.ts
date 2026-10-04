import { EngineError, type ProviderToolCall } from '@moodcode/contracts';
import type { ProviderAdapter, ProviderEvent, ProviderMessage, TurnRequest } from '../ports.js';
import { malformed, optionalString, positiveLimit, publicError, record, redactJson, redactText, TextRedactor } from './helpers.js';
import { readSseData } from './sse.js';

export interface OpenAICompatibleProviderOptions {
  /** API prefix, such as https://api.openai.com/v1 or a local fixture URL. */
  baseURL?: string;
  /** Injected only; never read from the environment or included in diagnostics. */
  apiKey?: string;
  id?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxFrameBytes?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  /** Total argument bytes across all calls in this turn. */
  maxToolArgumentBytes?: number;
  maxToolCalls?: number;
}

interface Limits {
  maxFrameBytes: number; maxResponseBytes: number; maxRequestBytes: number;
  maxToolArgumentBytes: number; maxToolCalls: number; timeoutMs: number;
}
interface PendingCall { id?: string; name?: string; type?: 'function'; arguments: string }
type FinishReason = Extract<ProviderEvent, { type: 'finish' }>['reason'];
type Usage = Extract<ProviderEvent, { type: 'usage' }>;

function finishReason(value: unknown): FinishReason {
  if (value === 'stop' || value === 'tool_calls' || value === 'length') return value;
  if (value === 'content_filter') throw new EngineError('PROVIDER_CONTENT_FILTERED', 'Provider filtered the completion.');
  throw new EngineError('PROVIDER_UNSUPPORTED_FINISH_REASON', 'Provider returned an unsupported finish reason.');
}
function usageEvent(value: unknown): Usage {
  const usage = record(value);
  const event: Usage = { type: 'usage' };
  for (const [key, target] of [['prompt_tokens', 'inputTokens'], ['completion_tokens', 'outputTokens']] as const) {
    const count = usage[key];
    if (count === undefined || count === null) continue;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) malformed();
    event[target] = count;
  }
  return event;
}

function messageBody(message: ProviderMessage): Record<string, unknown> {
  const result: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.role === 'assistant' && message.toolCalls?.length) {
    result.tool_calls = message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }));
  }
  if (message.role === 'tool') {
    if (!message.toolCallId) throw new EngineError('PROVIDER_INVALID_REQUEST', 'Tool messages require a tool call identifier.');
    result.tool_call_id = message.toolCallId;
  }
  return result;
}

/** One HTTP/SSE turn. Tool execution, retries and the agent loop belong to the runner. */
export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly id: string;
  #endpoint: string;
  #apiKey: string | undefined;
  #fetch: typeof globalThis.fetch;
  #limits: Limits;

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    this.#apiKey = options.apiKey;
    if (this.#apiKey !== undefined && (typeof this.#apiKey !== 'string' || this.#apiKey.length === 0 || this.#apiKey.length > 4096 || /[^\x21-\x7e]/.test(this.#apiKey))) {
      throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider API key must be a nonempty printable bearer token.');
    }
    this.id = options.id ?? 'openai-compatible';
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(this.id) || (this.#apiKey && this.id.includes(this.#apiKey))) throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider identifier is invalid.');
    let base: URL;
    try { base = new URL(options.baseURL ?? 'https://api.openai.com/v1'); } catch { throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider base URL is invalid.'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider base URL must be an HTTP API prefix without credentials, query or fragment.');
    base.pathname = base.pathname.replace(/\/+$/, '') + '/chat/completions';
    this.#endpoint = base.href;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function') throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider requires an HTTP fetch implementation.');
    this.#limits = {
      timeoutMs: positiveLimit(options.timeoutMs, 60_000),
      maxFrameBytes: positiveLimit(options.maxFrameBytes, 262_144),
      maxResponseBytes: positiveLimit(options.maxResponseBytes, 8_388_608),
      maxRequestBytes: positiveLimit(options.maxRequestBytes, 2_097_152),
      maxToolArgumentBytes: positiveLimit(options.maxToolArgumentBytes, 1_048_576),
      maxToolCalls: positiveLimit(options.maxToolCalls, 128),
    };
  }

  async *streamTurn(request: TurnRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    if (signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.');
    let serialized: string;
    try {
      if (typeof request.modelId !== 'string' || !request.modelId.trim()) throw new EngineError('PROVIDER_INVALID_REQUEST', 'Provider requires an explicit model identifier.');
      serialized = JSON.stringify({
        model: request.modelId,
        messages: request.messages.map(messageBody),
        ...(request.tools.length === 0 ? {} : { tools: request.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) }),
        n: 1, stream: true, stream_options: { include_usage: true },
      });
    } catch (error) {
      if (error instanceof EngineError && error.code === 'PROVIDER_INVALID_REQUEST') throw new EngineError('PROVIDER_INVALID_REQUEST', 'Provider request is invalid.');
      throw new EngineError('PROVIDER_INVALID_REQUEST', 'Provider request could not be encoded.');
    }
    if (Buffer.byteLength(serialized, 'utf8') > this.#limits.maxRequestBytes) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider request exceeds the byte limit.');
    const controller = new AbortController();
    const checkCancellation = () => {
      if (controller.signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.');
    };
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    // Covers both the initial HTTP response and a server stalled during the stream.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#limits.timeoutMs);
    let response: Response | undefined;
    try {
      if (signal.aborted) controller.abort();
      response = await this.#fetch(this.#endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}) },
        body: serialized,
      });
      checkCancellation();
      if (!response.ok) throw new EngineError('PROVIDER_HTTP_ERROR', `Provider HTTP request failed with status ${response.status}.`, { status: response.status });
      if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream' || !response.body) throw new EngineError('PROVIDER_MALFORMED_STREAM', 'Provider response must be an SSE stream.');
      const calls = new Map<number, PendingCall>();
      const redactor = new TextRedactor(this.#apiKey);
      let argumentBytes = 0;
      let finish: FinishReason | undefined;
      let usage: Usage | undefined;
      let done = false;
      for await (const frame of readSseData(response.body, controller.signal, this.#limits)) {
        if (frame.trim() === '[DONE]') { done = true; break; }
        let parsed: unknown;
        try { parsed = JSON.parse(frame); } catch { malformed(); }
        const chunk = record(parsed);
        if (chunk.error !== undefined && chunk.error !== null) throw new EngineError('PROVIDER_REMOTE_ERROR', 'Provider reported an error in the stream.');
        if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) malformed();
        if (chunk.usage !== undefined && chunk.usage !== null) {
          if (usage) malformed();
          usage = usageEvent(chunk.usage);
        }
        if (chunk.choices.length === 0) { if (!usage) malformed(); continue; }
        if (finish !== undefined) malformed();
        const choice = record(chunk.choices[0]);
        if (choice.index !== 0) malformed();
        const delta = record(choice.delta);
        if (delta.role !== undefined && delta.role !== null && delta.role !== 'assistant') malformed();
        if (delta.function_call !== undefined && delta.function_call !== null) throw new EngineError('PROVIDER_UNSUPPORTED_FINISH_REASON', 'Provider returned a deprecated function call.');
        for (const value of [delta.content, delta.refusal]) {
          const text = optionalString(value);
          if (text) { const safeText = redactor.push(text); if (safeText) { checkCancellation(); yield { type: 'text.delta', delta: safeText }; } }
        }
        if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
          if (!Array.isArray(delta.tool_calls)) malformed();
          for (const value of delta.tool_calls) {
            const patch = record(value);
            if (typeof patch.index !== 'number' || !Number.isSafeInteger(patch.index) || patch.index < 0) malformed();
            if (patch.index >= this.#limits.maxToolCalls) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider returned too many tool calls.');
            let pending = calls.get(patch.index);
            if (!pending) {
              if (calls.size >= this.#limits.maxToolCalls) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider returned too many tool calls.');
              pending = { arguments: '' };
              calls.set(patch.index, pending);
            }
            const id = optionalString(patch.id);
            if (id !== undefined) { if (pending.id !== undefined && pending.id !== id) malformed(); pending.id = id; }
            const type = optionalString(patch.type);
            if (type !== undefined) { if (type !== 'function') malformed(); pending.type = 'function'; }
            if (patch.function !== undefined && patch.function !== null) {
              const fn = record(patch.function);
              const name = optionalString(fn.name);
              if (name !== undefined) { if (pending.name !== undefined && pending.name !== name) malformed(); pending.name = name; }
              const args = optionalString(fn.arguments);
              if (args !== undefined) {
                argumentBytes += Buffer.byteLength(args, 'utf8');
                if (argumentBytes > this.#limits.maxToolArgumentBytes) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider tool arguments exceed the byte limit.');
                pending.arguments += args;
              }
            }
          }
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) finish = finishReason(choice.finish_reason);
      }
      if (!done || finish === undefined) throw new EngineError('PROVIDER_INCOMPLETE_STREAM', 'Provider stream ended without a complete finish and DONE marker.');
      if ((finish === 'tool_calls') !== (calls.size > 0)) malformed();
      // Validate every call before exposing any call. Truncated, malformed, or duplicate
      // tool inputs must never cause execution of an earlier otherwise valid call.
      const completed: ProviderToolCall[] = [];
      const identifiers = new Set<string>();
      for (const [index, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
        if (index !== completed.length || !call.id || !call.name || call.type !== 'function') malformed();
        const id = redactText(call.id, this.#apiKey);
        if (identifiers.has(id)) malformed();
        identifiers.add(id);
        let input: unknown;
        try { input = JSON.parse(call.arguments); } catch { malformed(); }
        completed.push({
          id,
          name: redactText(call.name, this.#apiKey),
          input: redactJson(input, this.#apiKey),
        });
      }
      const tail = redactor.push('', true);
      if (tail) { checkCancellation(); yield { type: 'text.delta', delta: tail }; }
      for (const call of completed) { checkCancellation(); yield { type: 'tool.call', call }; }
      if (usage) { checkCancellation(); yield usage; }
      checkCancellation();
      yield { type: 'finish', reason: finish };
    } catch (error) {
      if (signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.');
      if (timedOut) throw new EngineError('PROVIDER_TIMEOUT', 'Provider turn timed out.');
      // Fetch/decoder exception messages, causes and HTTP bodies can contain secrets.
      throw publicError(error);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.abort();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
}
