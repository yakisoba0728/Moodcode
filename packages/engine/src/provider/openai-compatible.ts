import {declaredMediaModels,providerSegments,messageSegments,segmentNotice,type ProviderSegmentSource} from '../media/segment-provider.js';
import {jobJson} from '../jobs/validation.js';
import { EngineError, type ProviderToolCall } from '@moodcode/contracts';
import type { ProviderAdapter, ProviderEvent, ProviderMessage, TurnRequest } from '../ports.js';
import { hostGenerationTransportRequest, type HostGenerationRequest, type ProviderTransportRequest } from './generation.js';
import { boundedGenerationBody } from './generation-body.js';
import { malformed, optionalString, positiveLimit, providerHttpFailure, providerRemoteError, providerURLAllowed, publicError, record, redactJson, redactText, TextRedactor } from './helpers.js';
import { readSseData } from './sse.js';
import { messageImages, providerImages } from '../media/provider.js';
import type { ResolvedInputImage } from '../ports.js';
import { providerDocuments } from '../documents/provider.js';

type DiagnosticType = 'missing' | 'null' | 'string' | 'number' | 'boolean' | 'array' | 'object';
type DiagnosticStage = 'response' | 'sse' | 'json' | 'chunk' | 'choices' | 'usage' | 'choice' | 'choice-index' | 'delta' | 'audio-metadata' | 'audio-fields' | 'audio-terminal' | 'audio-id' | 'audio-expiry' | 'audio-data' | 'audio-transcript' | 'role' | 'content' | 'tools' | 'finish' | 'complete-markers' | 'complete-audio' | 'completed-calls';
interface ChatMetadataTuple { id: string; object: 'chat.completion.chunk'; created: number; model: string }
function metadataText(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function metadataTuple(chunk: Record<string, unknown>): ChatMetadataTuple | undefined {
  if (!metadataText(chunk.id) || chunk.object !== 'chat.completion.chunk' || !Number.isSafeInteger(chunk.created) || Number(chunk.created) < 1 || !metadataText(chunk.model)) return undefined;
  return { id: chunk.id, object: chunk.object, created: chunk.created as number, model: chunk.model };
}
function sameMetadataTuple(left: ChatMetadataTuple, right: ChatMetadataTuple): boolean {
  return left.id === right.id && left.object === right.object && left.created === right.created && left.model === right.model;
}
function emptyAudioMetadata(chunk: Record<string, unknown>, expected: ChatMetadataTuple): boolean {
  const tuple = metadataTuple(chunk);
  if (!tuple || !sameMetadataTuple(tuple, expected) || chunk.usage !== undefined && chunk.usage !== null) return false;
  if (Object.keys(chunk).some(key => !['id', 'object', 'created', 'model', 'usage', 'system_fingerprint', 'service_tier', 'obfuscation'].includes(key))) return false;
  for (const key of ['system_fingerprint', 'service_tier']) if (chunk[key] !== undefined && chunk[key] !== null && !metadataText(chunk[key])) return false;
  if (chunk.obfuscation !== undefined && !metadataText(chunk.obfuscation, 4096)) return false;
  return true;
}
export interface ChatStreamFrameShape {
  readonly frameOrdinal: number;
  readonly rootType: DiagnosticType;
  readonly idType: DiagnosticType;
  readonly objectType: DiagnosticType;
  readonly createdType: DiagnosticType;
  readonly modelType: DiagnosticType;
  readonly objectKind: 'chat.completion.chunk' | 'chat.completion' | 'other-string' | 'not-string';
  readonly typeType: DiagnosticType;
  readonly typeKind: 'error' | 'other-string' | 'not-string';
  readonly choicesType: DiagnosticType;
  readonly audioType: DiagnosticType;
  readonly dataType: DiagnosticType;
  readonly deltaType: DiagnosticType;
  readonly usageType: DiagnosticType;
  readonly obfuscationType: DiagnosticType;
  readonly errorType: DiagnosticType;
  readonly audioDataType: DiagnosticType;
  readonly audioDataCharacters: number | null;
  readonly deltaAudioType: DiagnosticType;
  readonly unknownFieldCount: number;
}
/** Fixed structural facts only: no response strings, keys, identifiers, headers or bytes. */
export interface ChatMalformedStreamDiagnostic {
  readonly version: 1;
  readonly failureCode: 'PROVIDER_MALFORMED_STREAM' | 'PROVIDER_INCOMPLETE_STREAM';
  readonly doneSeen: boolean;
  readonly finishKind: 'missing' | 'stop' | 'tool_calls' | 'length';
  readonly frameOrdinal: number;
  readonly stage: DiagnosticStage;
  readonly choicesType: DiagnosticType;
  readonly choicesCount: number | null;
  readonly indexType: DiagnosticType;
  readonly indexIsZero: boolean;
  readonly deltaType: DiagnosticType;
  readonly finishReasonType: DiagnosticType;
  readonly audioType: DiagnosticType;
  readonly audioIdType: DiagnosticType;
  readonly audioDataType: DiagnosticType;
  readonly audioDataCharacters: number | null;
  readonly audioDataBase64Syntax: boolean | null;
  readonly audioTranscriptType: DiagnosticType;
  readonly audioExpiryType: DiagnosticType;
  readonly audioExpiryPositiveInteger: boolean;
  readonly audioHasUnknownFields: boolean;
  readonly audioIdSeen: boolean;
  readonly audioExpirySeen: boolean;
  readonly audioBytesSeen: number;
  readonly finishSeen: boolean;
  readonly top: ChatStreamFrameShape;
  readonly precedingFrames: readonly ChatStreamFrameShape[];
}
function diagnosticType(value: unknown): DiagnosticType {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as Exclude<DiagnosticType, 'missing' | 'null' | 'array'>;
}
function diagnosticObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function frameShape(frame: unknown, frameOrdinal: number): ChatStreamFrameShape {
  const chunk = diagnosticObject(frame);
  const audio = diagnosticObject(chunk.audio);
  const delta = diagnosticObject(chunk.delta);
  return Object.freeze({
    frameOrdinal, rootType: diagnosticType(frame), idType: diagnosticType(chunk.id), objectType: diagnosticType(chunk.object), createdType: diagnosticType(chunk.created), modelType: diagnosticType(chunk.model),
    objectKind: chunk.object === 'chat.completion.chunk' || chunk.object === 'chat.completion' ? chunk.object : typeof chunk.object === 'string' ? 'other-string' : 'not-string',
    typeType: diagnosticType(chunk.type), typeKind: chunk.type === 'error' ? 'error' : typeof chunk.type === 'string' ? 'other-string' : 'not-string',
    choicesType: diagnosticType(chunk.choices), audioType: diagnosticType(chunk.audio), dataType: diagnosticType(chunk.data), deltaType: diagnosticType(chunk.delta),
    usageType: diagnosticType(chunk.usage), obfuscationType: diagnosticType(chunk.obfuscation), errorType: diagnosticType(chunk.error),
    audioDataType: diagnosticType(audio.data), audioDataCharacters: typeof audio.data === 'string' ? Math.min(audio.data.length, 699_053) : null,
    deltaAudioType: diagnosticType(delta.audio),
    unknownFieldCount: Math.min(Object.keys(chunk).filter(key => !['id', 'object', 'type', 'choices', 'created', 'model', 'service_tier', 'system_fingerprint', 'usage', 'error', 'audio', 'data', 'delta', 'obfuscation'].includes(key)).length, 32),
  });
}
function streamDiagnostic(frame: unknown, frameOrdinal: number, stage: DiagnosticStage, audioIdSeen: boolean, audioExpirySeen: boolean, audioBytesSeen: number, finish: FinishReason | undefined, doneSeen: boolean, failureCode: ChatMalformedStreamDiagnostic['failureCode'], precedingFrames: readonly ChatStreamFrameShape[]): ChatMalformedStreamDiagnostic {
  const chunk = diagnosticObject(frame);
  const choice = diagnosticObject(Array.isArray(chunk.choices) ? chunk.choices[0] : undefined);
  const delta = diagnosticObject(choice.delta);
  const audio = diagnosticObject(delta.audio);
  const data = typeof audio.data === 'string' ? audio.data : undefined;
  return Object.freeze({
    version: 1, failureCode, doneSeen, finishKind: finish ?? 'missing', frameOrdinal, stage,
    choicesType: diagnosticType(chunk.choices), choicesCount: Array.isArray(chunk.choices) ? Math.min(chunk.choices.length, 2) : null,
    indexType: diagnosticType(choice.index), indexIsZero: choice.index === 0,
    deltaType: diagnosticType(choice.delta), finishReasonType: diagnosticType(choice.finish_reason),
    audioType: diagnosticType(delta.audio), audioIdType: diagnosticType(audio.id), audioDataType: diagnosticType(audio.data),
    audioDataCharacters: data === undefined ? null : Math.min(data.length, 699_053),
    audioDataBase64Syntax: data === undefined ? null : data.length <= 699_052 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data),
    audioTranscriptType: diagnosticType(audio.transcript), audioExpiryType: diagnosticType(audio.expires_at),
    audioExpiryPositiveInteger: Number.isSafeInteger(audio.expires_at) && Number(audio.expires_at) > 0,
    audioHasUnknownFields: Object.keys(audio).some(key => !['id', 'data', 'transcript', 'expires_at'].includes(key)),
    audioIdSeen, audioExpirySeen, audioBytesSeen: Math.min(audioBytesSeen, 524_245), finishSeen: finish !== undefined,
    top: frameShape(frame, frameOrdinal), precedingFrames: Object.freeze([...precedingFrames]),
  });
}

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
  /** Explicit transport selection; omitted preserves the API's obfuscation default. */
  includeStreamObfuscation?: boolean;
  /** Narrow audio transport compatibility; requires an exact preceding choice-chunk tuple. */
  allowEmptyAudioMetadata?: boolean;
  /** Exact output-audio compatibility: validated expiry, counts and DONE may replace a missing finish reason. */
  allowAudioExpiryCompletion?: boolean;
  audioModelIds?:readonly string[];
  videoModelIds?:readonly string[];
  /** Layout is explicitly verified by the host; no sample-rate inference from a different API. */
  outputAudio?:{modelIds:readonly string[];voice:string;sampleRate:number;channels:number};
  /** Invalid or incomplete stream metadata only; it cannot change validation or cleanup. */
  onMalformedStream?: (diagnostic: ChatMalformedStreamDiagnostic) => void;
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
  #includeStreamObfuscation: boolean | undefined;
  #allowEmptyAudioMetadata: boolean;
  #allowAudioExpiryCompletion: boolean;
  #onMalformedStream: OpenAICompatibleProviderOptions['onMalformedStream'];

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    if (options.includeStreamObfuscation !== undefined && typeof options.includeStreamObfuscation !== 'boolean') throw new EngineError('PROVIDER_INVALID_CONFIG', 'Stream obfuscation selection must be a boolean.');
    this.#includeStreamObfuscation = options.includeStreamObfuscation;
    if (options.allowEmptyAudioMetadata !== undefined && typeof options.allowEmptyAudioMetadata !== 'boolean') throw new EngineError('PROVIDER_INVALID_CONFIG', 'Empty audio metadata selection must be a boolean.');
    this.#allowEmptyAudioMetadata = options.allowEmptyAudioMetadata === true;
    if (options.allowAudioExpiryCompletion !== undefined && typeof options.allowAudioExpiryCompletion !== 'boolean') throw new EngineError('PROVIDER_INVALID_CONFIG', 'Audio expiry completion selection must be a boolean.');
    this.#allowAudioExpiryCompletion = options.allowAudioExpiryCompletion === true;
    if (options.onMalformedStream !== undefined && typeof options.onMalformedStream !== 'function') throw new EngineError('PROVIDER_INVALID_CONFIG', 'Malformed stream observer must be a function.');
    this.#onMalformedStream = options.onMalformedStream;
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
    if (!providerURLAllowed(base, this.#apiKey !== undefined)) throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider base URL must be an HTTP API prefix without credentials, query or fragment, using HTTPS or loopback HTTP when it carries an API key.');
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
        n: 1, stream: true, stream_options: { include_usage: true, ...(this.#includeStreamObfuscation === undefined ? {} : { include_obfuscation: this.#includeStreamObfuscation }) },
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
    let diagnosticFrame: unknown;
    let frameOrdinal = 0;
    const precedingFrames: ChatStreamFrameShape[] = [];
    const rememberFrame = () => {
      if (!this.#onMalformedStream) return;
      precedingFrames.push(frameShape(diagnosticFrame, frameOrdinal));
      if (precedingFrames.length > 3) precedingFrames.shift();
    };
    let diagnosticStage: DiagnosticStage = 'response';
    let finish: FinishReason | undefined;
    let done = false;
    let audioId: string | undefined, audioRawId: string | undefined, audioBytes = 0, audioExpired = false;
    let audioMetadataTuple: ChatMetadataTuple | undefined;
    let audioTupleComplete = true;
    const allowAudioMetadata = this.#allowEmptyAudioMetadata && !generation && (this.#audioModels.has(request.modelId) || this.#outputModels.has(request.modelId));
    const allowAudioExpiryCompletion = this.#allowAudioExpiryCompletion && !generation && this.#outputModels.has(request.modelId);
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
      let usage: Usage | undefined;
      const wantsAudio=!generation&&this.#outputModels.has(request.modelId);
      diagnosticStage = 'sse';
      for await (const frame of readSseData(generationBody?.stream ?? response.body, controller.signal, this.#limits)) {
        frameOrdinal = Math.min(frameOrdinal + 1, Number.MAX_SAFE_INTEGER);
        diagnosticFrame = undefined;
        diagnosticStage = 'json';
        if (frame.trim() === '[DONE]') { done = true; break; }
        let parsed: unknown;
        try { parsed = JSON.parse(frame); } catch { malformed(); }
        diagnosticFrame = parsed;
        diagnosticStage = 'chunk';
        const chunk = record(parsed);
        if (chunk.error !== undefined && chunk.error !== null) throw providerRemoteError(chunk.error);
        diagnosticStage = 'choices';
        if (chunk.choices === undefined && allowAudioMetadata) {
          diagnosticStage = 'audio-metadata';
          if (!audioMetadataTuple || !emptyAudioMetadata(chunk, audioMetadataTuple)) malformed();
          rememberFrame(); diagnosticFrame = undefined; diagnosticStage = 'sse'; continue;
        }
        if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) malformed();
        if (chunk.usage !== undefined && chunk.usage !== null) {
          diagnosticStage = 'usage';
          if (usage) malformed();
          usage = usageEvent(chunk.usage, request.includeMetadata);
        }
        diagnosticStage = 'choices';
        if (chunk.choices.length === 0) { if (!usage) malformed(); rememberFrame(); diagnosticFrame = undefined; diagnosticStage = 'sse'; continue; }

        diagnosticStage = 'choice';
        const choice = record(chunk.choices[0]);
        diagnosticStage = 'choice-index';
        if (choice.index !== 0) malformed();
        diagnosticStage = 'delta';
        const delta = record(choice.delta);
        if (allowAudioMetadata || allowAudioExpiryCompletion) {
          diagnosticStage = 'audio-metadata';
          const tuple = metadataTuple(chunk);
          if (!tuple) audioTupleComplete = false;
          if (audioMetadataTuple && (!tuple || !sameMetadataTuple(tuple, audioMetadataTuple))) malformed();
          if (tuple) audioMetadataTuple = tuple;
        }
        if (['image', 'images', 'video'].some(key => delta[key] !== undefined && delta[key] !== null)) throw new EngineError('PROVIDER_UNSUPPORTED_OUTPUT', 'Provider returned unsupported media output.');
        if(delta.audio!==undefined&&delta.audio!==null){
          if(!wantsAudio)throw new EngineError('PROVIDER_UNSUPPORTED_OUTPUT','Audio output requires an explicit exact model declaration');
          diagnosticStage = 'audio-fields';
          const audio=record(delta.audio);if(Object.keys(audio).some(k=>!['id','data','transcript','expires_at'].includes(k)))malformed();
          diagnosticStage = 'audio-terminal';
          if(finish!==undefined&&(Object.keys(delta).some(k=>k!=='audio')||Object.keys(audio).length!==1||audio.expires_at===undefined||choice.finish_reason!==undefined&&choice.finish_reason!==null))malformed();
          diagnosticStage = 'audio-id';
          if(audio.id!==undefined){if(typeof audio.id!=='string'||!audio.id||audio.id.length>256||/[\u0000-\u001f\u007f]/.test(audio.id)||audioRawId&&audioRawId!==audio.id)malformed();audioRawId=audio.id;audioId=redactText(audio.id,this.#apiKey);}
          diagnosticStage = 'audio-expiry';
          if(audio.expires_at!==undefined){if(!Number.isSafeInteger(audio.expires_at)||Number(audio.expires_at)<1||audioExpired||!audioId)malformed();audioExpired=true;}
          diagnosticStage = 'audio-data';
          if(audio.data!==undefined){if(audioExpired||!audioId||typeof audio.data!=='string'||audio.data.length>699052||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio.data))malformed();
            const bytes=Buffer.from(audio.data,'base64');if(!bytes.length||bytes.toString('base64')!==audio.data||(audioBytes+=bytes.length)>524244)throw new EngineError('PROVIDER_LIMIT_EXCEEDED','Audio output exceeded the bounded PCM capture');
            checkCancellation();yield {type:'media.delta',bytes,providerMediaId:audioId,sampleRate:this.#outputAudio!.sampleRate,channels:this.#outputAudio!.channels};}
          diagnosticStage = 'audio-transcript';
          const transcript=optionalString(audio.transcript);if(transcript){if(audioExpired)malformed();const text=redactor.push(transcript);if(text){checkCancellation();yield {type:'text.delta',delta:text};}}
        }else if(finish!==undefined)malformed();
        diagnosticStage = 'role';
        if (delta.role !== undefined && delta.role !== null && delta.role !== 'assistant') malformed();
        if (delta.function_call !== undefined && delta.function_call !== null) throw new EngineError('PROVIDER_UNSUPPORTED_FINISH_REASON', 'Provider returned a deprecated function call.');
        diagnosticStage = 'content';
        for (const value of [delta.content, delta.refusal]) {
          const text = optionalString(value);
          if (text) { const safeText = redactor.push(text); if (safeText) { checkCancellation(); yield { type: 'text.delta', delta: safeText }; } }
        }
        if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
          diagnosticStage = 'tools';
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
        diagnosticStage = 'finish';
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) finish = finishReason(choice.finish_reason);
        rememberFrame();
        diagnosticFrame = undefined;
        diagnosticStage = 'sse';
      }
      diagnosticStage = 'complete-markers';
      if (allowAudioExpiryCompletion && done && finish === undefined && wantsAudio && audioMetadataTuple && audioTupleComplete && audioId && audioBytes > 0 && audioBytes % (this.#outputAudio!.channels * 2) === 0 && audioExpired && usage?.inputTokens !== undefined && usage.outputTokens !== undefined && calls.size === 0) finish = 'stop';
      if (!done || finish === undefined) throw new EngineError('PROVIDER_INCOMPLETE_STREAM', 'Provider stream ended without a complete finish and DONE marker.');
      diagnosticStage = 'completed-calls';
      if ((finish === 'tool_calls') !== (calls.size > 0)) malformed();
      diagnosticStage = 'complete-audio';
      if(wantsAudio&&(!audioId||!audioBytes||!audioExpired||audioBytes%(this.#outputAudio!.channels*2)||finish!=='stop'))throw new EngineError('PROVIDER_INCOMPLETE_STREAM','Audio output lacks a complete bounded PCM and final expiry');
      // Validate every call before exposing any call. Truncated, malformed, or duplicate
      // tool inputs must never cause execution of an earlier otherwise valid call.
      const completed: ProviderToolCall[] = [];
      const identifiers = new Set<string>();
      diagnosticStage = 'completed-calls';
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
      if (error instanceof EngineError && (error.code === 'PROVIDER_MALFORMED_STREAM' || error.code === 'PROVIDER_INCOMPLETE_STREAM') && this.#onMalformedStream) {
        try {
          const notification: unknown = this.#onMalformedStream(streamDiagnostic(diagnosticFrame, frameOrdinal, diagnosticStage, audioId !== undefined, audioExpired, audioBytes, finish, done, error.code, precedingFrames));
          if (notification instanceof Promise) void notification.catch(() => {});
        } catch { /* Diagnostics cannot replace the actual failure or cleanup result. */ }
      }
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
