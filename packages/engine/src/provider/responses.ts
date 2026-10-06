import { EngineError, REASONING_EFFORTS, type ProviderToolCall } from '@moodcode/contracts';
import type { ProviderAdapter, ProviderEvent, ProviderMessage, TurnRequest } from '../ports.js';
import type { OpenAICompatibleProviderOptions } from './openai-compatible.js';
import { credentialSecrets, CredentialTextRedactor, malformed, optionalString, positiveLimit, providerHttpFailure, providerRemoteError, publicError, record, redactCredentialJson, redactCredentialText } from './helpers.js';
import { replayCompatible, validateReplayBinding, validateReplayItems } from './replay.js';
import { readSseData } from './sse.js';

export interface ResponsesProviderOptions extends OpenAICompatibleProviderOptions {
  /** Includes message and opaque reasoning items as well as function calls. */
  maxOutputItems?: number;
  /** Server-side OAuth adapter secrets; never included in request JSON or diagnostics. */
  redactionSecrets?: readonly string[];
  /** Native Codex HTTP quirks; restricted to the fixed Codex identity and route. */
  streamProfile?: 'responses' | 'codex';
}
interface TextPart { type: 'output_text' | 'refusal'; text: string; done: boolean; sawDelta: boolean }
interface OutputItem {
  id: string; type: 'message' | 'function_call' | 'reasoning'; done: boolean; incomplete: boolean;
  parts: Map<number, TextPart>;
  phase?: 'commentary' | 'final_answer' | null;
  callId?: string; name?: string; arguments: string; argumentsDone: boolean; sawArgumentDelta: boolean;
  doneSnapshot?: Record<string, unknown>;
}
type Usage = Extract<ProviderEvent, { type: 'usage' }>;
type FinishReason = Extract<ProviderEvent, { type: 'finish' }>['reason'];

function nonempty(value: unknown): string {
  const text = optionalString(value);
  if (!text) malformed();
  return text;
}
function index(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) malformed();
  if (value >= maximum) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider output index exceeds the configured limit.');
  return value;
}
function phase(value: unknown): OutputItem['phase'] {
  if (value === undefined || value === null || value === 'commentary' || value === 'final_answer') return value;
  malformed();
}
function inputItems(message: ProviderMessage): Record<string, unknown>[] {
  if (message.role === 'tool') {
    if (!message.toolCallId) throw new EngineError('PROVIDER_INVALID_REQUEST', 'Tool messages require a call identifier.');
    return [{ type: 'function_call_output', call_id: message.toolCallId, output: message.content }];
  }
  const items: Record<string, unknown>[] = [];
  if (message.content || !message.toolCalls?.length) items.push({ role: message.role, content: message.content });
  if (message.role === 'assistant') {
    for (const call of message.toolCalls ?? []) {
      items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) });
    }
  }
  return items;
}
function normalizedUsage(value: unknown, includeMetadata = false): Usage | undefined {
  if (value === undefined || value === null) return undefined;
  const source = record(value);
  const event: Usage = { type: 'usage' };
  for (const [key, target] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens']] as const) {
    const count = source[key];
    if (count === undefined || count === null) continue;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) malformed();
    event[target] = count;
  }
  for (const [details, key, target, total] of includeMetadata ? [['input_tokens_details', 'cached_tokens', 'cachedInputTokens', 'inputTokens'], ['output_tokens_details', 'reasoning_tokens', 'reasoningOutputTokens', 'outputTokens']] as const : []) {
    if (source[details] === undefined || source[details] === null) continue;
    const count = record(source[details])[key]; if (count === undefined || count === null) continue;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || event[total] !== undefined && count > event[total]!) malformed();
    event[target] = count;
  }
  return event;
}

/** Stateless native Responses turn; the runner owns history, tool execution and retries. */
export class ResponsesProvider implements ProviderAdapter {
  readonly id: string;
  readonly replayProtocol: string;
  #endpoint: string;
  #apiKey: string | undefined;
  #secrets: string[];
  #codexProfile: boolean;
  #fetch: typeof globalThis.fetch;
  #limits: { timeoutMs: number; maxFrameBytes: number; maxResponseBytes: number; maxRequestBytes: number; maxToolArgumentBytes: number; maxToolCalls: number; maxOutputItems: number };

  constructor(options: ResponsesProviderOptions = {}) {
    this.#apiKey = options.apiKey;
    if (this.#apiKey !== undefined && (typeof this.#apiKey !== 'string' || !this.#apiKey.length || this.#apiKey.length > 4096 || /[^\x21-\x7e]/.test(this.#apiKey))) {
      throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider API key must be a nonempty printable bearer token.');
    }
    this.#secrets = credentialSecrets(this.#apiKey, options.redactionSecrets);
    this.id = options.id ?? 'openai-responses';
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(this.id) || this.#secrets.some(secret => this.id.includes(secret))) throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider identifier is invalid.');
    let base: URL;
    try { base = new URL(options.baseURL ?? 'https://api.openai.com/v1'); } catch { throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider base URL is invalid.'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider base URL must be an HTTP API prefix without credentials, query or fragment.');
    base.pathname = base.pathname.replace(/\/+$/, '') + '/responses';
    this.#endpoint = base.href;
    if (options.streamProfile !== undefined && options.streamProfile !== 'responses' && options.streamProfile !== 'codex') throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider stream profile is invalid.');
    this.#codexProfile = options.streamProfile === 'codex';
    this.replayProtocol = this.#codexProfile ? 'codex-responses' : 'openai-responses';
    if (this.#codexProfile && (this.id !== 'codex' || this.#endpoint !== 'https://chatgpt.com/backend-api/codex/responses')) throw new EngineError('PROVIDER_INVALID_CONFIG', 'Codex stream profile requires its fixed provider identity and route.');
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function') throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider requires an HTTP fetch implementation.');
    this.#limits = {
      timeoutMs: positiveLimit(options.timeoutMs, 60_000),
      maxFrameBytes: positiveLimit(options.maxFrameBytes, 262_144),
      maxResponseBytes: positiveLimit(options.maxResponseBytes, 8_388_608),
      maxRequestBytes: positiveLimit(options.maxRequestBytes, 2_097_152),
      maxToolArgumentBytes: positiveLimit(options.maxToolArgumentBytes, 1_048_576),
      maxToolCalls: positiveLimit(options.maxToolCalls, 128),
      maxOutputItems: positiveLimit(options.maxOutputItems, 256),
    };
  }

  async *streamTurn(request: TurnRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    if (signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.');
    let serialized: string;
    try {
      if (typeof request.modelId !== 'string' || !request.modelId.trim()) throw new EngineError('PROVIDER_INVALID_REQUEST', 'Provider requires an explicit model identifier.');
      if (request.reasoningEffort !== undefined && !REASONING_EFFORTS.includes(request.reasoningEffort)) throw new EngineError('PROVIDER_INVALID_REQUEST', 'Provider reasoning effort is invalid.');
      const input: Record<string, unknown>[] = [];
      let inputBytes = 2;
      for (const message of request.messages) {
        let messageItems: Record<string, unknown>[];
        if (message.role === 'assistant' && replayCompatible(message, this.id, request.modelId, this.replayProtocol)) {
          const replayItems = validateReplayItems(message.providerReplay!.items, {
            secrets: this.#secrets, maxItems: this.#limits.maxOutputItems,
            maxBytes: this.#limits.maxRequestBytes,
            maxToolArgumentBytes: this.#limits.maxToolArgumentBytes, maxToolCalls: this.#limits.maxToolCalls,
          });
          validateReplayBinding(message, replayItems);
          messageItems = replayItems;
        } else messageItems = inputItems(message);
        for (const item of messageItems) {
          inputBytes += Buffer.byteLength(JSON.stringify(item), 'utf8') + (input.length ? 1 : 0);
          if (inputBytes > this.#limits.maxRequestBytes) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider request exceeds the byte limit.');
          input.push(item);
        }
      }
      serialized = JSON.stringify({
        model: request.modelId, input, stream: true, store: false, include: ['reasoning.encrypted_content'],
        ...(request.reasoningEffort === undefined ? {} : { reasoning: { effort: request.reasoningEffort } }),
        ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })) } : {}),
      });
    } catch (error) {
      if (error instanceof EngineError && ['PROVIDER_INVALID_REPLAY', 'PROVIDER_LIMIT_EXCEEDED'].includes(error.code)) throw publicError(error);
      throw new EngineError('PROVIDER_INVALID_REQUEST', 'Provider request could not be encoded.');
    }
    if (Buffer.byteLength(serialized, 'utf8') > this.#limits.maxRequestBytes) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider request exceeds the byte limit.');
    const controller = new AbortController();
    const checkCancellation = () => { if (controller.signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.'); };
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
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
      if (!response.ok) throw await providerHttpFailure(response, controller.signal);
      const contentType = response.headers.get('content-type');
      const acceptsStream = contentType?.split(';')[0]?.trim().toLowerCase() === 'text/event-stream' || this.#codexProfile && contentType === null;
      if (!acceptsStream || !response.body) throw new EngineError('PROVIDER_MALFORMED_STREAM', 'Provider response must be an SSE stream.');

      const items = new Map<number, OutputItem>();
      const itemIds = new Set<string>();
      const callIds = new Set<string>();
      const redactor = new CredentialTextRedactor(this.#secrets);
      const summaryRedactor = new CredentialTextRedactor(this.#secrets);
      let responseId: string | undefined;
      let inProgress = false;
      let sequence: number | undefined;
      let argumentBytes = 0;
      let publicText = '';
      let terminal: Record<string, unknown> | undefined;
      let replayOutput: unknown[] | undefined;
      let finish: FinishReason | undefined;
      const argumentSize = (before: string, after: string) => {
        argumentBytes += Buffer.byteLength(after, 'utf8') - Buffer.byteLength(before, 'utf8');
        if (argumentBytes > this.#limits.maxToolArgumentBytes) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider tool arguments exceed the byte limit.');
      };
      const appendArguments = (item: OutputItem, delta: string) => {
        let bytes = Buffer.byteLength(delta, 'utf8');
        const last = item.arguments.charCodeAt(item.arguments.length - 1);
        const first = delta.charCodeAt(0);
        // JSON escapes can split a UTF-16 pair across argument deltas. Its joined
        // UTF-8 size is four bytes rather than two replacement characters (six).
        if (last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) bytes -= 2;
        argumentBytes += bytes;
        if (argumentBytes > this.#limits.maxToolArgumentBytes) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider tool arguments exceed the byte limit.');
        item.arguments += delta;
      };
      const eventItem = (event: Record<string, unknown>, expected?: OutputItem['type']): OutputItem => {
        const item = items.get(index(event.output_index, this.#limits.maxOutputItems));
        if (!item || nonempty(event.item_id) !== item.id || (expected && item.type !== expected)) malformed();
        return item;
      };
      const callEvent = (event: Record<string, unknown>): OutputItem => {
        const item = eventItem(event, 'function_call');
        if (item.done) malformed();
        for (const [field, expected] of [['name', item.name], ['call_id', item.callId]] as const) {
          if (event[field] !== undefined && event[field] !== expected) malformed();
        }
        return item;
      };
      const textPart = (item: OutputItem, partIndex: number, kind: TextPart['type']): TextPart => {
        let part = item.parts.get(partIndex);
        if (!part) { part = { type: kind, text: '', done: false, sawDelta: false }; item.parts.set(partIndex, part); }
        if (part.type !== kind) malformed();
        return part;
      };
      const snapshot = (value: unknown, item: OutputItem, incomplete: boolean): void => {
        const source = record(value);
        if (source.id !== item.id || source.type !== item.type) malformed();
        if (!incomplete && item.incomplete) malformed();
        if (source.status !== undefined && source.status !== 'completed' && !(incomplete && source.status === 'incomplete')) malformed();
        if (item.type === 'function_call') {
          if (!item.argumentsDone || source.call_id !== item.callId || source.name !== item.name || source.arguments !== item.arguments) malformed();
        } else if (item.type === 'message') {
          const finalPhase = phase(source.phase);
          if (item.phase !== undefined && finalPhase !== item.phase) malformed();
          if (source.role !== 'assistant' || !Array.isArray(source.content) || source.content.length !== item.parts.size) malformed();
          for (let partIndex = 0; partIndex < source.content.length; partIndex++) {
            const part = item.parts.get(partIndex);
            const final = record(source.content[partIndex]);
            if (!part || final.type !== part.type || (!incomplete && !part.done)) malformed();
            if ((part.type === 'output_text' ? final.text : final.refusal) !== part.text) malformed();
          }
        }
        // Reasoning is kept in validated finish replay data, outside public text.
      };

      for await (const frame of readSseData(response.body, controller.signal, this.#limits)) {
        if (frame.trim() === '[DONE]') throw new EngineError('PROVIDER_INCOMPLETE_STREAM', 'Provider stream ended without a Responses lifecycle terminal.');
        let parsed: unknown;
        try { parsed = JSON.parse(frame); } catch { malformed(); }
        const event = record(parsed);
        const type = nonempty(event.type);
        if (event.sequence_number !== undefined) {
          const current = event.sequence_number;
          if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 0 || (sequence !== undefined && current <= sequence)) malformed();
          sequence = current;
        }
        if (type === 'error' || type === 'response.failed') throw providerRemoteError(type === 'error' ? event.error ?? event : event.response && typeof event.response === 'object' ? (event.response as Record<string, unknown>).error : undefined);
        if (type !== 'response.created' && event.response_id !== undefined && event.response_id !== responseId) malformed();
        if (type === 'response.created') {
          if (responseId !== undefined) malformed();
          const created = record(event.response);
          responseId = nonempty(created.id);
          if (event.response_id !== undefined && event.response_id !== responseId) malformed();
          if (created.status !== 'in_progress') malformed();
          if (request.includeMetadata) { checkCancellation(); yield { type: 'progress', providerRequestId: responseId }; }
          continue;
        }
        if (responseId === undefined) malformed();
        if (type === 'response.in_progress') {
          const progress = record(event.response);
          if (inProgress || progress.id !== responseId || progress.status !== 'in_progress') malformed();
          inProgress = true;
          if (request.includeMetadata) { checkCancellation(); yield { type: 'progress' }; }
          continue;
        }
        if (type === 'response.completed' || type === 'response.incomplete') {
          terminal = record(event.response);
          if (terminal.id !== responseId) malformed();
          if (terminal.error !== undefined && terminal.error !== null) throw new EngineError('PROVIDER_REMOTE_ERROR', 'Provider reported an error in the stream.');
          if (type === 'response.incomplete') {
            if (terminal.status !== 'incomplete') malformed();
            const reason = record(terminal.incomplete_details).reason;
            if (reason === 'content_filter') throw new EngineError('PROVIDER_CONTENT_FILTERED', 'Provider filtered the completion.');
            if (reason !== 'max_output_tokens' || callIds.size > 0) throw new EngineError('PROVIDER_INCOMPLETE_STREAM', 'Provider response is incomplete.');
            finish = 'length';
          } else {
            if (terminal.status !== 'completed' || (terminal.incomplete_details !== undefined && terminal.incomplete_details !== null)) malformed();
            finish = callIds.size > 0 ? 'tool_calls' : 'stop';
          }
          if (!Array.isArray(terminal.output)) malformed();
          let output = terminal.output;
          if (this.#codexProfile && finish !== 'length' && output.length === 0 && items.size > 0) {
            // Codex's terminal can omit snapshots already delivered by item.done.
            // A completed status on item.added never substitutes for item.done.
            output = [];
            for (let outputIndex = 0; outputIndex < items.size; outputIndex++) {
              const item = items.get(outputIndex);
              if (!item?.done || !item.doneSnapshot) malformed();
              output.push(item.doneSnapshot);
            }
          }
          if (output.length !== items.size) malformed();
          for (let outputIndex = 0; outputIndex < output.length; outputIndex++) {
            const item = items.get(outputIndex);
            if (!item || (finish !== 'length' && !item.done)) malformed();
            snapshot(output[outputIndex], item, finish === 'length');
          }
          replayOutput = output;
          break;
        }
        if (type === 'response.output_item.added') {
          const outputIndex = index(event.output_index, this.#limits.maxOutputItems);
          const source = record(event.item);
          const id = nonempty(source.id);
          if (items.has(outputIndex) || itemIds.has(id)) malformed();
          if (source.type !== 'message' && source.type !== 'function_call' && source.type !== 'reasoning') throw new EngineError('PROVIDER_UNSUPPORTED_OUTPUT', 'Provider returned an unsupported output item.');
          if (source.status !== undefined && source.status !== 'in_progress' && !(this.#codexProfile && source.status === 'completed')) malformed();
          const item: OutputItem = { id, type: source.type, done: false, incomplete: false, parts: new Map(), arguments: '', argumentsDone: false, sawArgumentDelta: false };
          if (item.type === 'function_call') {
            item.callId = nonempty(source.call_id);
            item.name = nonempty(source.name);
            if (callIds.has(item.callId)) malformed();
            if (callIds.size >= this.#limits.maxToolCalls) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider returned too many tool calls.');
            item.arguments = optionalString(source.arguments) ?? '';
            argumentSize('', item.arguments);
            callIds.add(item.callId);
          } else if (item.type === 'message') {
            if (source.role !== 'assistant' || !Array.isArray(source.content) || source.content.length > 0) malformed();
            item.phase = phase(source.phase);
          }
          items.set(outputIndex, item);
          itemIds.add(id);
          continue;
        }
        if (type === 'response.output_item.done') {
          const item = items.get(index(event.output_index, this.#limits.maxOutputItems));
          if (!item || item.done) malformed();
          const source = record(event.item);
          item.incomplete = source.status === 'incomplete';
          snapshot(source, item, item.incomplete);
          if (item.type === 'message') item.phase = phase(source.phase);
          if (this.#codexProfile) item.doneSnapshot = source;
          item.done = true;
          continue;
        }
        if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
          const item = callEvent(event);
          if (item.argumentsDone) malformed();
          if (type.endsWith('.delta')) {
            const delta = optionalString(event.delta);
            if (delta === undefined) malformed();
            appendArguments(item, delta);
            item.sawArgumentDelta = true;
          } else {
            const full = optionalString(event.arguments);
            if (full === undefined || ((item.sawArgumentDelta || item.arguments !== '') && full !== item.arguments)) malformed();
            argumentSize(item.arguments, full);
            item.arguments = full;
            item.argumentsDone = true;
          }
          continue;
        }
        if (type === 'response.output_text.delta' || type === 'response.output_text.done' || type === 'response.refusal.delta' || type === 'response.refusal.done') {
          const item = eventItem(event, 'message');
          if (item.done) malformed();
          const kind = type.startsWith('response.refusal.') ? 'refusal' : 'output_text';
          const part = textPart(item, index(event.content_index, this.#limits.maxOutputItems), kind);
          if (part.done) malformed();
          let emitted = '';
          if (type.endsWith('.delta')) {
            const delta = optionalString(event.delta);
            if (delta === undefined) malformed();
            part.text += delta;
            part.sawDelta = true;
            emitted = delta;
          } else {
            const full = optionalString(kind === 'output_text' ? event.text : event.refusal);
            if (full === undefined || (part.sawDelta && full !== part.text)) malformed();
            if (!part.sawDelta) { emitted = full; part.text = full; }
            part.done = true;
          }
          const text = redactor.push(emitted);
          if (text) { checkCancellation(); publicText += text; yield { type: 'text.delta', delta: text }; }
          continue;
        }
        if (type === 'response.content_part.added' || type === 'response.content_part.done') {
          const item = eventItem(event);
          if (item.done) malformed();
          const source = record(event.part);
          if (source.type === 'reasoning_text') {
            if (item.type !== 'reasoning' || optionalString(source.text) === undefined) malformed();
            index(event.content_index, this.#limits.maxOutputItems);
            continue;
          }
          if (item.type !== 'message') malformed();
          if (source.type !== 'output_text' && source.type !== 'refusal') throw new EngineError('PROVIDER_UNSUPPORTED_OUTPUT', 'Provider returned an unsupported content part.');
          const part = textPart(item, index(event.content_index, this.#limits.maxOutputItems), source.type);
          const text = optionalString(source.type === 'output_text' ? source.text : source.refusal);
          if (text === undefined || text !== part.text || (type.endsWith('.added') && (part.done || part.sawDelta)) || (type.endsWith('.done') && !part.done)) malformed();
          continue;
        }
        if (type === 'response.output_text.annotation.added') {
          const item = eventItem(event, 'message');
          if (item.done) malformed();
          index(event.content_index, this.#limits.maxOutputItems);
          continue;
        }
        if (['response.reasoning_summary_part.added', 'response.reasoning_summary_part.done', 'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_text.delta', 'response.reasoning_text.done'].includes(type)) {
          const item = eventItem(event, 'reasoning');
          if (item.done) malformed();
          index(type.startsWith('response.reasoning_text.') ? event.content_index : event.summary_index, this.#limits.maxOutputItems);
          if (type.startsWith('response.reasoning_summary_part.')) {
            const part = record(event.part);
            if (part.type !== 'summary_text' || optionalString(part.text) === undefined) malformed();
          } else if (optionalString(type.endsWith('.delta') ? event.delta : event.text) === undefined) malformed();
          if (request.includeMetadata && type === 'response.reasoning_summary_text.delta') { const summary = summaryRedactor.push(event.delta as string); if (summary) { checkCancellation(); yield { type: 'reasoning.delta', delta: summary }; } }
          if (request.includeMetadata && type === 'response.reasoning_summary_text.done') { const summary = summaryRedactor.push('', true); if (summary) { checkCancellation(); yield { type: 'reasoning.delta', delta: summary }; } }
          continue;
        }
        throw new EngineError('PROVIDER_UNSUPPORTED_EVENT', 'Provider returned an unsupported stream event.');
      }
      if (!terminal || !finish) throw new EngineError('PROVIDER_INCOMPLETE_STREAM', 'Provider Responses stream ended before completion.');
      // Every input is validated before the first executable call is exposed.
      const completed: ProviderToolCall[] = [];
      const publicIds = new Set<string>();
      for (const [, item] of [...items.entries()].sort(([a], [b]) => a - b)) {
        if (item.type !== 'function_call') continue;
        if (!item.callId || !item.name || !item.argumentsDone || !item.done) malformed();
        const id = redactCredentialText(item.callId, this.#secrets);
        if (publicIds.has(id)) malformed();
        publicIds.add(id);
        let input: unknown;
        try { input = JSON.parse(item.arguments); } catch { malformed(); }
        completed.push({ id, name: redactCredentialText(item.name, this.#secrets), input: redactCredentialJson(input, this.#secrets) });
      }
      const usage = normalizedUsage(terminal.usage, request.includeMetadata);
      const tail = redactor.push('', true);
      const replayItems = finish === 'length' ? undefined : validateReplayItems(replayOutput, {
        secrets: this.#secrets, maxItems: this.#limits.maxOutputItems,
        maxBytes: this.#limits.maxResponseBytes,
        maxToolArgumentBytes: this.#limits.maxToolArgumentBytes, maxToolCalls: this.#limits.maxToolCalls,
      });
      if (replayItems) validateReplayBinding({ role: 'assistant', content: publicText + tail, toolCalls: completed }, replayItems);
      if (tail) { checkCancellation(); yield { type: 'text.delta', delta: tail }; }
      for (const call of completed) { checkCancellation(); yield { type: 'tool.call', call }; }
      if (usage) { checkCancellation(); yield usage; }
      checkCancellation();
      yield { type: 'finish', reason: finish, ...(replayItems ? { replayItems } : {}) };
    } catch (error) {
      if (signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.');
      if (timedOut) throw new EngineError('PROVIDER_TIMEOUT', 'Provider turn timed out.');
      throw publicError(error);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.abort();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
}
