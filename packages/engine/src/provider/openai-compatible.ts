import {declaredMediaModels,providerSegments,messageSegments,segmentNotice,type ProviderSegmentSource} from '../media/segment-provider.js';
import {jobJson} from '../jobs/validation.js';
import { EngineError, type ProviderToolCall } from '@moodcode/contracts';
import type { ProviderAdapter, ProviderEvent, ProviderMessage, TurnRequest } from '../ports.js';
import { hostGenerationTransportRequest, type HostGenerationRequest, type ProviderTransportRequest } from './generation.js';
import { boundedGenerationBody } from './generation-body.js';
import { malformed, optionalString, positiveLimit, providerHttpFailure, providerRemoteError, publicError, record, redactJson, redactText, TextRedactor } from './helpers.js';
import { readSseData } from './sse.js';
import { messageImages, providerImages } from '../media/provider.js';
import type { ResolvedInputImage } from '../ports.js';
import { providerDocuments } from '../documents/provider.js';

export interface OpenAICompatibleProviderOptions {
  /** API prefix, such as https://api.openai.com/v1 or a local fixture URL. */
  baseURL?: string;
  /** Injected only; never read from the environment or included in diagnostics. */
  apiKey?: string;
  id?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Host generation must confirm underlying body cancellation within this bound. */
  cleanupTimeoutMs?: number;
  maxFrameBytes?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  /** Total argument bytes across all calls in this turn. */
  maxToolArgumentBytes?: number;
  maxToolCalls?: number;
  audioModelIds?:readonly string[];
  videoModelIds?:readonly string[];
  /** Layout is explicitly verified by the host; no sample-rate inference from a different API. */
  outputAudio?:{modelIds:readonly string[];voice:string;sampleRate:number;channels:number};
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
function usageEvent(value: unknown, includeMetadata = false): Usage {
  const usage = record(value);
  const event: Usage = { type: 'usage' };
  for (const [key, target] of [['prompt_tokens', 'inputTokens'], ['completion_tokens', 'outputTokens']] as const) {
    const count = usage[key];
    if (count === undefined || count === null) continue;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) malformed();
    event[target] = count;
  }
  for (const [details, key, target, total] of includeMetadata ? [['prompt_tokens_details', 'cached_tokens', 'cachedInputTokens', 'inputTokens'], ['completion_tokens_details', 'reasoning_tokens', 'reasoningOutputTokens', 'outputTokens']] as const : []) {
    if (usage[details] === undefined || usage[details] === null) continue;
    const count = record(usage[details])[key]; if (count === undefined || count === null) continue;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || event[total] !== undefined && count > event[total]!) malformed();
    event[target] = count;
  }
  return event;
}

function messageBody(message: ProviderMessage, images: ReadonlyMap<string, ResolvedInputImage>,segments:ReadonlyMap<string,ProviderSegmentSource>): Record<string, unknown> {
  const result: Record<string, unknown> = { role: message.role, content: message.content };
  const media = messageImages(message, images);
  const selected=messageSegments(message,segments);
  if (media.length||selected.length) result.content = [
    ...selected.flatMap(({source,asset})=>[{type:'text',text:segmentNotice(source,asset)},asset.kind==='audio'?{type:'input_audio',input_audio:{data:asset.bytes.toString('base64'),format:'wav'}}:{type:'image_url',image_url:{url:`data:image/png;base64,${asset.bytes.toString('base64')}`,detail:'auto'}}]),
    ...media.map(image => ({ type: 'image_url', image_url: { url: `data:${image.attachment.mimeType};base64,${image.data}`, detail: 'auto' } })),
    ...(message.content ? [{ type: 'text', text: message.content }] : []),
  ];
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
  readonly inputModalities = Object.freeze(['text', 'image'] as const);
  readonly inputFileTypes = Object.freeze([] as const);
  #audioModels:ReadonlySet<string>;#videoModels:ReadonlySet<string>;#outputModels:ReadonlySet<string>;#outputAudio?:{voice:string;sampleRate:number;channels:number};
  supportsInputMedia(modelId:string,kind:'audio'|'video'):boolean{return (kind==='audio'?this.#audioModels:this.#videoModels).has(modelId);}
  requestedOutputMedia(modelId:string):'audio/wav'|null{return this.#outputModels.has(modelId)?'audio/wav':null;}
  #endpoint: string;
  #apiKey: string | undefined;
  #fetch: typeof globalThis.fetch;
  #limits: Limits;
  #generationCleanupTimeoutMs: number;

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    this.#audioModels=declaredMediaModels(options.audioModelIds);this.#videoModels=declaredMediaModels(options.videoModelIds);this.#outputModels=new Set();
    if(options.outputAudio!==undefined){const output=jobJson(options.outputAudio,16384) as unknown as NonNullable<OpenAICompatibleProviderOptions['outputAudio']>;
      if(Object.keys(output).sort().join(',')!=='channels,modelIds,sampleRate,voice'||!['alloy','ash','ballad','coral','echo','fable','nova','onyx','sage','shimmer','verse','marin','cedar'].includes(output.voice)||![8000,16000,24000,48000].includes(output.sampleRate)||![1,2].includes(output.channels))throw new EngineError('PROVIDER_INVALID_CONFIG','Explicit audio layout and voice are required');
      this.#outputModels=declaredMediaModels(output.modelIds);this.#outputAudio={voice:output.voice,sampleRate:output.sampleRate,channels:output.channels};}
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
    this.#generationCleanupTimeoutMs = positiveLimit(options.cleanupTimeoutMs, 1_000);
  }

  streamTurn(request: TurnRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    return this.#stream(request, signal, false);
  }

  streamGeneration(request: HostGenerationRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    return this.#stream(hostGenerationTransportRequest(request), signal, true);
  }

  async *#stream(request: ProviderTransportRequest, signal: AbortSignal, generation: boolean): AsyncGenerator<ProviderEvent> {
    if (signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.');
    providerDocuments(request, false, signal);
    let serialized: string;
    try {
      if (typeof request.modelId !== 'string' || !request.modelId.trim()) throw new EngineError('PROVIDER_INVALID_REQUEST', 'Provider requires an explicit model identifier.');
      const images = providerImages(request, true, signal);
      const segments=providerSegments(request,kind=>!generation&&this.supportsInputMedia(request.modelId,kind),signal);
      const audioOutput=!generation&&this.#outputModels.has(request.modelId);
      serialized = JSON.stringify({
        model: request.modelId,
        messages: request.messages.map(message => messageBody(message, images,segments)),
        ...(audioOutput?{modalities:['text','audio'],audio:{voice:this.#outputAudio!.voice,format:'pcm16'}}:{}),
        ...(generation && request.reasoningEffort !== undefined ? { reasoning_effort: request.reasoningEffort } : {}),
        ...(request.tools.length === 0 ? {} : { tools: request.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) }),
        n: 1, stream: true, stream_options: { include_usage: true },
      });
    } catch (error) {
      if (error instanceof EngineError && ['PROVIDER_INVALID_REQUEST', 'PROVIDER_LIMIT_EXCEEDED', 'PROVIDER_CANCELLED'].includes(error.code)) throw publicError(error);
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
    let generationBody: ReturnType<typeof boundedGenerationBody> | undefined;
    try {
      if (signal.aborted) controller.abort();
      response = await this.#fetch(this.#endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}) },
        body: serialized,
      });
      if ((generation||this.#outputModels.has(request.modelId)||request.messages.some(m=>m.media?.length)) && response.body) generationBody = boundedGenerationBody(response.body, controller.signal, this.#generationCleanupTimeoutMs);
      checkCancellation();
      if (!response.ok) throw await providerHttpFailure(generationBody ? new Response(generationBody.stream, { status: response.status, headers: response.headers }) : response, controller.signal);
      if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream' || !response.body) throw new EngineError('PROVIDER_MALFORMED_STREAM', 'Provider response must be an SSE stream.');
      const calls = new Map<number, PendingCall>();
      const redactor = new TextRedactor(this.#apiKey);
      let argumentBytes = 0;
      let finish: FinishReason | undefined;
      let usage: Usage | undefined;
      let done = false;let audioId:string|undefined,audioRawId:string|undefined,audioBytes=0,audioExpired=false;const wantsAudio=!generation&&this.#outputModels.has(request.modelId);
      for await (const frame of readSseData(generationBody?.stream ?? response.body, controller.signal, this.#limits)) {
        if (frame.trim() === '[DONE]') { done = true; break; }
        let parsed: unknown;
        try { parsed = JSON.parse(frame); } catch { malformed(); }
        const chunk = record(parsed);
        if (chunk.error !== undefined && chunk.error !== null) throw providerRemoteError(chunk.error);
        if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) malformed();
        if (chunk.usage !== undefined && chunk.usage !== null) {
          if (usage) malformed();
          usage = usageEvent(chunk.usage, request.includeMetadata);
        }
        if (chunk.choices.length === 0) { if (!usage) malformed(); continue; }

        const choice = record(chunk.choices[0]);
        if (choice.index !== 0) malformed();
        const delta = record(choice.delta);
        if (['image', 'images', 'video'].some(key => delta[key] !== undefined && delta[key] !== null)) throw new EngineError('PROVIDER_UNSUPPORTED_OUTPUT', 'Provider returned unsupported media output.');
        if(delta.audio!==undefined&&delta.audio!==null){
          if(!wantsAudio)throw new EngineError('PROVIDER_UNSUPPORTED_OUTPUT','Audio output requires an explicit exact model declaration');
          const audio=record(delta.audio);if(Object.keys(audio).some(k=>!['id','data','transcript','expires_at'].includes(k)))malformed();
          if(finish!==undefined&&(Object.keys(delta).some(k=>k!=='audio')||Object.keys(audio).length!==1||audio.expires_at===undefined||choice.finish_reason!==undefined&&choice.finish_reason!==null))malformed();
          if(audio.id!==undefined){if(typeof audio.id!=='string'||!audio.id||audio.id.length>256||/[\u0000-\u001f\u007f]/.test(audio.id)||audioRawId&&audioRawId!==audio.id)malformed();audioRawId=audio.id;audioId=redactText(audio.id,this.#apiKey);}
          if(audio.expires_at!==undefined){if(!Number.isSafeInteger(audio.expires_at)||Number(audio.expires_at)<1||audioExpired||!audioId)malformed();audioExpired=true;}
          if(audio.data!==undefined){if(audioExpired||!audioId||typeof audio.data!=='string'||audio.data.length>699052||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio.data))malformed();
            const bytes=Buffer.from(audio.data,'base64');if(!bytes.length||bytes.toString('base64')!==audio.data||(audioBytes+=bytes.length)>524244)throw new EngineError('PROVIDER_LIMIT_EXCEEDED','Audio output exceeded the bounded PCM capture');
            checkCancellation();yield {type:'media.delta',bytes,providerMediaId:audioId,sampleRate:this.#outputAudio!.sampleRate,channels:this.#outputAudio!.channels};}
          const transcript=optionalString(audio.transcript);if(transcript){if(audioExpired)malformed();const text=redactor.push(transcript);if(text){checkCancellation();yield {type:'text.delta',delta:text};}}
        }else if(finish!==undefined)malformed();
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
      if(wantsAudio&&(!audioId||!audioBytes||!audioExpired||audioBytes%(this.#outputAudio!.channels*2)||finish!=='stop'))throw new EngineError('PROVIDER_INCOMPLETE_STREAM','Audio output lacks a complete bounded PCM and final expiry');
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
      if (generation && completed.length) throw new EngineError('PROVIDER_UNSUPPORTED_OUTPUT', 'Host generation cannot propose executable tools.');
      if (generationBody && !await generationBody.close()) throw new EngineError('CLEANUP_UNCERTAIN', 'Provider generation cleanup could not be confirmed.');
      if (tail) { checkCancellation(); yield { type: 'text.delta', delta: tail }; }
      for (const call of completed) { checkCancellation(); yield { type: 'tool.call', call }; }
      if (usage) { checkCancellation(); yield usage; }
      checkCancellation();
      if(audioId){checkCancellation();yield {type:'media.end',providerMediaId:audioId};}
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
      if (generationBody) {
        if (!await generationBody.close()) throw new EngineError('CLEANUP_UNCERTAIN', 'Provider generation cleanup could not be confirmed.');
      } else if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
}
