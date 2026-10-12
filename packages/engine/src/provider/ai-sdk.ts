import { isDeepStrictEqual } from 'node:util';
import { streamText, jsonSchema, tool, isStepCount, APICallError, InvalidResponseDataError, TypeValidationError, type LanguageModel, type ModelMessage, type ToolSet, type LanguageModelUsage } from 'ai';
import { createGoogle } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createXai } from '@ai-sdk/xai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { AI_SDK_PROVIDERS, isAiSdkProviderId, EngineError, type AiSdkProviderId, type JsonObject, type ProviderToolCall } from '@moodcode/contracts';
import type { ProviderAdapter, ProviderEvent, ProviderMessage, ProviderTransportRequest, TurnRequest } from '../ports.js';
import { plainJson } from '../shared/data.js';
import { raceAbort, settleWithin } from '../shared/runtime.js';
import { boundedGenerationBody } from './generation-body.js';
import { hostGenerationTransportRequest, type HostGenerationRequest } from './generation.js';
import { replayCompatible } from './replay.js';
import { boundedText, CredentialTextRedactor, providerApiKey, providerEndpoint, providerFetch, providerHttpFailure, providerTurnError, providerUsage, positiveLimit, redactCredentialJson, redactCredentialText, turnTimer } from './helpers.js';

export interface AiSdkProviderOptions {
  providerId: AiSdkProviderId;
  apiKey: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

function fail(code = 'PROVIDER_MALFORMED_STREAM'): never { throw new EngineError(code, 'AI SDK provider data is invalid.'); }
function json<T>(value: T, maxBytes: number, code: string): T {
  return plainJson(value, { maxBytes, maxNodes: 100_000, maxDepth: 64, accounting: 'encoded', fail: () => fail(code) });
}

/** One SDK step; the engine owns every tool effect, retry, approval and recovery decision. */
export class AiSdkProvider implements ProviderAdapter {
  readonly id: AiSdkProviderId;
  readonly replayProtocol = 'ai-sdk-v7-messages';
  // shortcut: SDK input is text only; add media with provider admission and replay fixtures.
  readonly inputModalities = ['text'] as const;
  #apiKey: string;
  #baseURL: string;
  #fetch: typeof globalThis.fetch;
  #timeoutMs: number;
  #cleanupTimeoutMs: number;
  #maxRequestBytes: number;
  #maxResponseBytes: number;

  constructor(options: AiSdkProviderOptions) {
    if (!isAiSdkProviderId(options.providerId)) fail('PROVIDER_INVALID_CONFIG');
    this.id = options.providerId;
    this.#apiKey = providerApiKey(options.apiKey, 'Provider requires a printable API key.') ?? fail('PROVIDER_INVALID_CONFIG');
    this.#baseURL = providerEndpoint(options.baseURL, AI_SDK_PROVIDERS[this.id].baseURL, '', true, 'Provider requires HTTPS or loopback HTTP without credentials, query or fragment.').replace(/\/+$/, '');
    if (this.#baseURL.includes(this.#apiKey)) fail('PROVIDER_INVALID_CONFIG');
    this.#fetch = providerFetch(options.fetch, 'Provider fetch is unavailable.');
    this.#timeoutMs = positiveLimit(options.timeoutMs, 60_000);
    this.#cleanupTimeoutMs = positiveLimit(options.cleanupTimeoutMs, 1_000);
    this.#maxRequestBytes = positiveLimit(options.maxRequestBytes, 1_048_576);
    this.#maxResponseBytes = positiveLimit(options.maxResponseBytes, 4_194_304);
  }

  #model(modelId: string, fetch: typeof globalThis.fetch): LanguageModel {
    const options = { apiKey: this.#apiKey, baseURL: this.#baseURL, fetch };
    switch (this.id) {
      case 'google': return createGoogle(options)(modelId);
      case 'groq': return createGroq(options)(modelId);
      case 'mistral': return createMistral(options)(modelId);
      case 'xai': return createXai(options)(modelId);
      case 'deepseek': case 'openrouter': return createOpenAICompatible({ ...options, name: this.id })(modelId);
    }
  }

  #replay(items: unknown, message: Pick<ProviderMessage, 'content' | 'toolCalls'>): JsonObject[] {
    const copied = json(items, this.#maxResponseBytes, 'PROVIDER_INVALID_REPLAY');
    if (!Array.isArray(copied) || copied.length !== 1) fail('PROVIDER_INVALID_REPLAY');
    const assistant = copied[0] as JsonObject;
    if (!assistant || assistant.role !== 'assistant' || !Array.isArray(assistant.content)) fail('PROVIDER_INVALID_REPLAY');
    let text = '';
    const calls: ProviderToolCall[] = [];
    for (const value of assistant.content) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PROVIDER_INVALID_REPLAY');
      const part = value as JsonObject;
      if (part.providerOptions && JSON.stringify(part.providerOptions).includes(this.#apiKey)) fail('PROVIDER_INVALID_REPLAY');
      if (part.type === 'text' || part.type === 'reasoning') {
        if (typeof part.text !== 'string') fail('PROVIDER_INVALID_REPLAY');
        part.text = redactCredentialText(part.text, [this.#apiKey]);
        if (part.type === 'text') text += part.text;
      } else if (part.type === 'tool-call') {
        if (!boundedText(part.toolCallId) || !boundedText(part.toolName) || part.providerExecuted) fail('PROVIDER_INVALID_REPLAY');
        part.input = redactCredentialJson(part.input, [this.#apiKey]);
        calls.push({ id: part.toolCallId, name: part.toolName, input: part.input });
      } else fail('PROVIDER_INVALID_REPLAY');
    }
    if (text !== message.content || !isDeepStrictEqual(calls, message.toolCalls ?? [])) fail('PROVIDER_INVALID_REPLAY');
    if (JSON.stringify(copied).includes(this.#apiKey)) fail('PROVIDER_INVALID_REPLAY');
    return copied as JsonObject[];
  }

  #messages(request: ProviderTransportRequest): ModelMessage[] {
    return request.messages.flatMap((message): ModelMessage[] => {
      if (message.attachments?.length || message.documents?.length || message.media?.length) fail('PROVIDER_UNSUPPORTED_INPUT');
      if (message.role === 'system') return [];
      if (message.role === 'assistant') {
        if (message.providerReplay?.providerId === this.id) {
          if (!replayCompatible(message, this.id, request.modelId, this.replayProtocol)
            || message.providerReplay.version !== 1) fail('PROVIDER_INVALID_REPLAY');
          return this.#replay(message.providerReplay.items, message) as unknown as ModelMessage[];
        }
        return [{ role: 'assistant', content: [
          ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
          ...(message.toolCalls ?? []).map(call => ({ type: 'tool-call' as const, toolCallId: call.id, toolName: call.name, input: call.input })),
        ] }];
      }
      if (message.role === 'tool') {
        const call = request.messages.flatMap(item => item.toolCalls ?? []).find(call => call.id === message.toolCallId);
        if (!call) fail('PROVIDER_INVALID_REQUEST');
        return [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: call.id, toolName: call.name, output: { type: 'text', value: message.content } }] }];
      }
      return [{ role: message.role, content: message.content }];
    });
  }

  streamTurn(request: TurnRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> { return this.#ownedStream(request, signal, false); }
  streamGeneration(request: HostGenerationRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> { return this.#ownedStream(hostGenerationTransportRequest(request), signal, true); }

  #ownedStream(request: ProviderTransportRequest, signal: AbortSignal, generation: boolean): AsyncIterable<ProviderEvent> {
    const stream = this.#stream(request, signal, generation);
    let uncertain: EngineError | undefined;
    return { [Symbol.asyncIterator]: () => ({
      async next() {
        try { return await stream.next(); }
        catch (error) { if (error instanceof EngineError && error.code === 'CLEANUP_UNCERTAIN') uncertain = error; throw error; }
      },
      async return() {
        const result = await stream.return(undefined);
        // A cancelled next() can fail before return(); generator closure alone cannot prove cleanup.
        if (uncertain) throw uncertain;
        return result;
      },
    }) };
  }

  async *#stream(request: ProviderTransportRequest, signal: AbortSignal, generation: boolean): AsyncGenerator<ProviderEvent> {
    if (signal.aborted) fail('PROVIDER_CANCELLED');
    if (!boundedText(request.modelId) || request.modelId.includes(this.#apiKey)) fail('PROVIDER_INVALID_REQUEST');
    if (request.resolvedImages?.length || request.resolvedDocuments?.length || request.resolvedMedia?.length) fail('PROVIDER_UNSUPPORTED_INPUT');
    if (request.reasoningEffort !== undefined) fail('PROVIDER_INVALID_REQUEST');
    const messages = json(this.#messages(request), this.#maxRequestBytes, 'PROVIDER_LIMIT_EXCEEDED');
    const instructions = json(request.messages.filter(message => message.role === 'system').map(message => ({ role: 'system' as const, content: message.content })), this.#maxRequestBytes, 'PROVIDER_LIMIT_EXCEEDED');
    const definitions = json(request.tools, this.#maxRequestBytes, 'PROVIDER_LIMIT_EXCEEDED');
    const tools: ToolSet = Object.fromEntries(definitions.map(definition => [definition.name, tool({ description: definition.description, inputSchema: jsonSchema(definition.inputSchema) })]));
    let body: ReturnType<typeof boundedGenerationBody> | undefined;
    let fetching: Promise<Response> | undefined;
    const turn = turnTimer(signal, this.#timeoutMs, () => body);
    const { controller, checkCancellation } = turn;
    const base = new URL(this.#baseURL);
    const fetch: typeof globalThis.fetch = async (input, init) => {
      checkCancellation();
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/')) fail('PROVIDER_INVALID_REQUEST');
      if (typeof init?.body !== 'string' || Buffer.byteLength(init.body) > this.#maxRequestBytes) fail('PROVIDER_LIMIT_EXCEEDED');
      fetching = Promise.resolve().then(() => this.#fetch(input, { ...init, signal: controller.signal, redirect: 'error' }));
      // A late transport response still owns its body after a client cancellation.
      const response = await fetching;
      if (response.body) body = boundedGenerationBody(response.body, controller.signal, this.#cleanupTimeoutMs);
      if (controller.signal.aborted) { if (body) await body.close(); fail('PROVIDER_CANCELLED'); }
      if (!response.ok) throw await providerHttpFailure(new Response(body?.stream, { status: response.status, headers: response.headers }), controller.signal);
      if (!body) fail();
      let bytes = 0;
      return new Response(body.stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, output) {
          bytes += chunk.byteLength;
          if (bytes > responseLimit) fail('PROVIDER_LIMIT_EXCEEDED');
          output.enqueue(chunk);
        },
      })), { status: response.status, headers: response.headers });
    };
    const responseLimit = this.#maxResponseBytes;
    let reader: ReadableStreamDefaultReader<import('ai').TextStreamPart<ToolSet>> | undefined;
    try {
      const result = streamText({ model: this.#model(request.modelId, fetch), instructions, messages, tools,
        ...(this.id === 'xai' ? { providerOptions: { xai: { store: false } } } : {}),
        maxRetries: 0, stopWhen: isStepCount(1), abortSignal: controller.signal, onError() {} });
      reader = result.stream.getReader();
      const text = new CredentialTextRedactor([this.#apiKey]), reasoning = new CredentialTextRedactor([this.#apiKey]);
      let publicText = '', finish: 'stop' | 'tool_calls' | 'length' | undefined, usage: LanguageModelUsage | undefined;
      const calls: ProviderToolCall[] = [];
      while (true) {
        const item = await raceAbort(reader.read(), controller.signal, () => new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.'));
        checkCancellation();
        if (item.done) break;
        const part = item.value;
        switch (part.type) {
          case 'text-delta': { const delta = text.push(part.text); publicText += delta; if (delta) yield { type: 'text.delta', delta }; break; }
          case 'reasoning-delta': { const delta = reasoning.push(part.text); if (delta) yield { type: 'reasoning.delta', delta }; break; }
          case 'tool-call':
            if (part.invalid || part.providerExecuted || !boundedText(part.toolCallId) || !boundedText(part.toolName)
              || calls.length >= 64 || calls.some(call => call.id === part.toolCallId) || !Object.hasOwn(tools, part.toolName)) fail();
            calls.push({ id: part.toolCallId, name: part.toolName, input: redactCredentialJson(json(part.input, 262_144, 'PROVIDER_LIMIT_EXCEEDED'), [this.#apiKey]) });
            break;
          case 'finish-step':
            if (part.response.id !== undefined) {
              if (!boundedText(part.response.id) || part.response.id.includes(this.#apiKey)) fail();
              yield { type: 'progress', providerRequestId: part.response.id };
            }
            break;
          case 'finish':
            if (finish) fail();
            if (part.finishReason === 'content-filter') fail('PROVIDER_CONTENT_FILTERED');
            finish = part.finishReason === 'tool-calls' ? 'tool_calls' : part.finishReason === 'stop' || part.finishReason === 'length' ? part.finishReason : fail('PROVIDER_UNSUPPORTED_FINISH_REASON');
            usage = part.totalUsage;
            break;
          case 'error': throw part.error;
          case 'abort': fail('PROVIDER_CANCELLED');
          case 'file': case 'reasoning-file': case 'tool-result': case 'tool-error': case 'tool-approval-request': case 'tool-approval-response': case 'tool-output-denied': case 'custom': case 'source': fail('PROVIDER_UNSUPPORTED_OUTPUT');
        }
      }
      if (!finish) fail('PROVIDER_INCOMPLETE_STREAM');
      if (finish === 'tool_calls' && !calls.length || finish === 'stop' && calls.length) fail();
      if (generation && calls.length) fail('PROVIDER_UNSUPPORTED_OUTPUT');
      if (body && !await body.close()) fail('CLEANUP_UNCERTAIN');
      const tail = text.push('', true); publicText += tail;
      const reasonTail = reasoning.push('', true);
      const replayItems = generation || finish === 'length' ? undefined : this.#replay(JSON.parse(JSON.stringify(await result.responseMessages)), { content: publicText, toolCalls: calls });
      checkCancellation();
      if (tail) yield { type: 'text.delta', delta: tail };
      if (reasonTail) yield { type: 'reasoning.delta', delta: reasonTail };
      for (const call of calls) { checkCancellation(); yield { type: 'tool.call', call }; }
      if (usage) yield providerUsage({ input: usage.inputTokens, output: usage.outputTokens,
        inputDetails: { cached_tokens: usage.inputTokenDetails.cacheReadTokens }, outputDetails: { reasoning_tokens: usage.outputTokenDetails.reasoningTokens } },
        { input: 'input', output: 'output', inputDetails: 'inputDetails', outputDetails: 'outputDetails' }, request.includeMetadata);
      checkCancellation(); yield { type: 'finish', reason: finish, ...(replayItems ? { replayItems } : {}) };
    } catch (error) {
      const failure = APICallError.isInstance(error) && error.cause instanceof EngineError ? error.cause
        : InvalidResponseDataError.isInstance(error) || TypeValidationError.isInstance(error) ? new EngineError('PROVIDER_MALFORMED_STREAM', 'Provider returned an invalid stream.') : error;
      throw providerTurnError(failure, signal, turn.timedOut());
    }
    finally {
      turn.dispose();
      let clean = !body || await body.close();
      controller.abort();
      if (fetching && !await settleWithin(fetching, this.#cleanupTimeoutMs)) clean = false;
      if (reader) {
        if (!await settleWithin(reader.cancel(), this.#cleanupTimeoutMs)) clean = false;
        try { reader.releaseLock(); } catch { clean = false; }
      }
      if (!clean) fail('CLEANUP_UNCERTAIN');
    }
  }
}
