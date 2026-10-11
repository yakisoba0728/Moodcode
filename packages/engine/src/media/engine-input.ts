import { join } from 'node:path';
import { types } from 'node:util';
import { EngineError, INPUT_MEDIA_LIMITS, type InputDocumentAttachment, type InputImageAttachment, type InputMediaAttachment, type InputMediaSegment, type RunConfig } from '@moodcode/contracts';
import { assertInputMediaBudget, type normalizeSubmitInput } from '@moodcode/contracts/validation';
import type { ProviderAdapter, ProviderEvent, ProviderMessage } from '../ports.js';
import type { SqliteStore } from '../storage/index.js';
import type { ArtifactStore } from '../artifacts/store.js';
import type { EngineLifetime } from '../engine-kernel.js';
import type { EngineOptions } from '../engine-options.js';
import { ModelRegistry, type ModelSpec } from '../context/model-spec.js';
import { ScriptedProvider } from '../provider/index.js';
import { validateHostGenerationRequest, type HostGenerationRequest } from '../provider/generation.js';
import { DocumentAttachmentStore } from '../documents/store.js';
import { providerDocuments } from '../documents/provider.js';
import { jobJson } from '../jobs/validation.js';
import { plainRecord } from '../shared/data.js';
import { ImageAttachmentStore } from './store.js';
import { providerImages } from './provider.js';
import { MediaSegmentStore } from './segment-store.js';
import { providerSegments } from './segment-provider.js';

type FreshMediaInput = Pick<ReturnType<typeof normalizeSubmitInput>, 'sessionId' | 'config' | 'attachments' | 'documents' | 'media'>;

function assertDocumentSupport(provider: ProviderAdapter | undefined, models: ModelRegistry, config: Pick<RunConfig, 'providerId' | 'modelId'>, allowUnknownTokenCost: boolean): void {
  if (!provider?.inputFileTypes?.includes('application/pdf') || !models.get(config.providerId, config.modelId).inputFileTypes?.includes('application/pdf')
    || provider.supportsInputFile?.(config.modelId, 'application/pdf') === false) throw new EngineError('PROVIDER_UNSUPPORTED_INPUT', 'Selected provider and model require explicit PDF support');
  if (!allowUnknownTokenCost || provider.allowUnknownDocumentTokenCost !== true) throw new EngineError('DOCUMENT_TOKEN_COST_UNKNOWN', 'PDF token cost is unknown; host and provider must explicitly permit this cost');
}

export function assertMediaCommandData(value:unknown):void{
  if(types.isProxy(value))throw new EngineError('INVALID_INPUT','command must be an inspectable JSON object',{path:'command'});if(!value||typeof value!=='object')return;const p=Object.getOwnPropertyDescriptor(value,'payload');if(!p||!('value'in p)||!p.value||typeof p.value!=='object')return;if(types.isProxy(p.value))throw new EngineError('INVALID_INPUT','payload must be an inspectable JSON object',{path:'payload'});const m=Object.getOwnPropertyDescriptor(p.value,'media');if(m&&'value'in m)jobJson(m.value,65536);
}

function assertSegmentSupport(provider:ProviderAdapter|undefined,models:ModelRegistry,modelId:string,refs:readonly InputMediaAttachment[],allowUnknown:boolean):void{
  const caps=provider?models.get(provider.id,modelId).mediaCapabilities:null;
  for(const ref of refs)if(provider?.supportsInputMedia?.(modelId,ref.kind)!==true||(ref.kind==='audio'?caps?.audioInput:caps?.videoFrames)!==true)throw new EngineError('PROVIDER_UNSUPPORTED_INPUT','Selected provider and exact model require verified media support');
  if(provider?.requestedOutputMedia?.(modelId)&&caps?.audioOutput!==true)throw new EngineError('PROVIDER_UNSUPPORTED_OUTPUT','Selected exact model requires verified audio output support');
  if((refs.length||provider?.requestedOutputMedia?.(modelId))&&!allowUnknown)throw new EngineError('MEDIA_TOKEN_COST_UNKNOWN','Media token cost is unknown and requires explicit host policy');
}

function withInputMedia(provider: ProviderAdapter, images: ImageAttachmentStore, documents: DocumentAttachmentStore, segments:MediaSegmentStore, store: SqliteStore, models: ModelRegistry, allowUnknownTokenCost: boolean, allowMediaCost:boolean): ProviderAdapter {
  return { id: provider.id,
    ...(provider.supportsInputMedia?{supportsInputMedia:(modelId:string,kind:'audio'|'video')=>provider.supportsInputMedia!(modelId,kind)}:{}),
    ...(provider.requestedOutputMedia?{requestedOutputMedia:(modelId:string)=>provider.requestedOutputMedia!(modelId)}:{}), ...(provider.replayProtocol ? { replayProtocol: provider.replayProtocol } : {}),
    ...(provider.retryableHttpStatuses ? { retryableHttpStatuses: provider.retryableHttpStatuses } : {}),
    ...(provider.inputModalities ? { inputModalities: provider.inputModalities } : {}),
    ...(provider.inputFileTypes ? { inputFileTypes: provider.inputFileTypes } : {}),
    ...(provider.allowUnknownDocumentTokenCost === undefined ? {} : { allowUnknownDocumentTokenCost: provider.allowUnknownDocumentTokenCost }),
    ...(provider.supportsInputFile ? { supportsInputFile: (modelId: string, mimeType: 'application/pdf') => provider.supportsInputFile!(modelId, mimeType) } : {}),
    ...(provider.streamGeneration ? { streamGeneration(request: HostGenerationRequest, signal: AbortSignal) {
      return provider.streamGeneration!(validateHostGenerationRequest(request), signal);
    } } : {}),
    streamTurn(request, signal) {
      let iterator: AsyncIterator<ProviderEvent> | undefined, initialization: Promise<void> | undefined;
      let providerEntered = false, confirmedDone = false;
      const initialize = () => initialization ??= (async () => {
        if (request.resolvedImages !== undefined || request.resolvedDocuments !== undefined || request.resolvedMedia !== undefined) throw new EngineError('PROVIDER_INVALID_REQUEST', 'Input bytes must be resolved by the engine');
        const collect = <T extends { id: string }>(pick: (message: ProviderMessage) => readonly T[] | undefined, noun: string) => {
          const collected = new Map<string, T>();
          for (const message of request.messages) for (const ref of pick(message) ?? []) {
            if (message.role !== 'user') throw new EngineError('PROVIDER_INVALID_REQUEST', `${noun} references belong to user messages`);
            const previous = collected.get(ref.id);
            if (previous && JSON.stringify(previous) !== JSON.stringify(ref)) throw new EngineError('PROVIDER_INVALID_REQUEST', `Conflicting ${noun.toLowerCase()} references`);
            collected.set(ref.id, ref);
          }
          return collected;
        };
        const refs = collect(message => message.attachments, 'Image'), documentRefs = collect(message => message.documents, 'Document'), segmentRefs = collect(message => message.media, 'Media');
        assertSegmentSupport(provider,models,request.modelId,[...segmentRefs.values()],allowMediaCost);
        let resolved = request;
        if (refs.size || documentRefs.size || segmentRefs.size) {
          const run = store.getRun(request.runId);
          if (request.sessionId !== run.sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Input request belongs to another session');
          if (documentRefs.size) assertDocumentSupport(provider, models, { providerId: provider.id, modelId: request.modelId }, allowUnknownTokenCost);
          if (refs.size) {
            const modalities = models.get(provider.id, request.modelId).modalities;
            if (!provider.inputModalities?.includes('image') || modalities !== null && !modalities.includes('image')) throw new EngineError('PROVIDER_UNSUPPORTED_INPUT', 'Selected provider or model does not support image input');
            resolved = { ...resolved, resolvedImages: await images.resolve(run.sessionId, [...refs.values()], signal) };
          }
          if (documentRefs.size) resolved = { ...resolved, resolvedDocuments: await documents.resolve(run.sessionId, [...documentRefs.values()], signal) };
          if(segmentRefs.size)resolved={...resolved,resolvedMedia:await segments.resolve(run.sessionId,[...segmentRefs.values()],signal)};
          const decoded=providerSegments(resolved,kind=>provider.supportsInputMedia?.(request.modelId,kind)===true,signal);
          const assetBytes=[...decoded.values()].reduce((sum,v)=>sum+v.assets.reduce((n,a)=>n+a.bytes.length,0),0);
          if([...refs.values()].reduce((sum,v)=>sum+v.bytes,0)+[...documentRefs.values()].reduce((sum,v)=>sum+v.bytes,0)+assetBytes>INPUT_MEDIA_LIMITS.maxTotalBytes)throw new EngineError('INPUT_MEDIA_LIMIT','Combined input media wire budget exceeded');
          providerImages(resolved, true, signal);
          if (documentRefs.size) providerDocuments(resolved, true, signal);
        }
        if (signal.aborted) throw signal.reason ?? new EngineError('CANCELLED', 'Provider request was cancelled');
        providerEntered = true;
        iterator = provider.streamTurn(resolved, signal)[Symbol.asyncIterator]();
      })();
      // An async-generator wrapper could falsely report return().done=true after inner next() throws.
      const stream: AsyncIterableIterator<ProviderEvent> = {
        [Symbol.asyncIterator]() { return stream; },
        async next() { await initialize(); const result = await iterator!.next(); if (result.done === true) confirmedDone = true; return result; },
        async return() {
          if (initialization) await initialization.catch(() => {});
          if (!providerEntered || confirmedDone) return { done: true, value: undefined };
          if (!iterator?.return) throw new EngineError('CLEANUP_UNCERTAIN', 'Underlying provider has no cleanup operation');
          const result = await iterator.return(); if (result.done === true) confirmedDone = true; return result;
        },
      };
      return stream;
    },
  };
}

export class EngineInputMedia {
  readonly models = new ModelRegistry();
  readonly images: ImageAttachmentStore;
  readonly segments: MediaSegmentStore;
  readonly documents: DocumentAttachmentStore;
  /** Runtime providers by ID; agent backends add and remove entries after construction. */
  readonly providers: Map<string, ProviderAdapter>;
  private readonly allowMediaCost: boolean;

  constructor(private readonly store: SqliteStore, artifactDir: string,
    private readonly options: Pick<EngineOptions, 'modelSpecs' | 'providers' | 'allowUnknownDocumentTokenCost' | 'allowUnknownMediaTokenCost'>,
    private readonly lifetime: EngineLifetime, private readonly managedArtifacts: () => Promise<ArtifactStore>) {
    this.allowMediaCost = options.allowUnknownMediaTokenCost === true;
    for (const spec of options.modelSpecs ?? []) this.models.put(spec);
    this.images = new ImageAttachmentStore({ directory: join(artifactDir, 'input-media'), documents: store });
    this.segments = new MediaSegmentStore({ directory: join(artifactDir, 'input-segments'), documents: store });
    this.documents = new DocumentAttachmentStore({ directory: join(artifactDir, 'input-documents'), documents: store });
    const providers = this.providers = new Map<string, ProviderAdapter>([['scripted', new ScriptedProvider()]]);
    for (const provider of options.providers ?? []) providers.set(provider.id, provider);
    for (const [id, provider] of providers) providers.set(id, withInputMedia(provider, this.images, this.documents, this.segments, store, this.models, options.allowUnknownDocumentTokenCost === true, this.allowMediaCost));
  }

  /** Resolves every reference of a newly admitted input before it is accepted. */
  async validateFresh(input: FreshMediaInput): Promise<void> {
    assertInputMediaBudget(input.attachments, input.documents);
    if (input.media?.length) await this.validateSegments(input.sessionId, input.config, input.media);
    if (input.documents?.length) await this.validateDocuments(input.sessionId, input.config, input.documents);
    if (input.attachments?.length) await this.validateImages(input.sessionId, input.config, input.attachments);
  }

  private async validateImages(sessionId: string, config: RunConfig, refs: InputImageAttachment[]): Promise<void> {
    const modalities = this.models.get(config.providerId, config.modelId).modalities;
    if (!this.providers.get(config.providerId)?.inputModalities?.includes('image') || modalities !== null && !modalities.includes('image')) throw new EngineError('PROVIDER_UNSUPPORTED_INPUT', 'Selected provider or model does not support image input');
    await this.images.resolve(sessionId, refs, this.lifetime.signal);
    this.lifetime.assertOpen();
  }

  private async validateDocuments(sessionId: string, config: RunConfig, refs: InputDocumentAttachment[]): Promise<void> {
    assertDocumentSupport(this.providers.get(config.providerId), this.models, config, this.options.allowUnknownDocumentTokenCost === true);
    await this.documents.resolve(sessionId, refs, this.lifetime.signal);
    this.lifetime.assertOpen();
  }

  private async validateSegments(sessionId: string, config: RunConfig, refs: InputMediaAttachment[]): Promise<void> {
    assertSegmentSupport(this.providers.get(config.providerId), this.models, config.modelId, refs, this.allowMediaCost);
    await this.segments.resolve(sessionId, refs, this.lifetime.signal);
  }

  capabilities(providerId: string, modelId: string): { audioInput: boolean; videoFrames: boolean; audioOutput: boolean; unknownTokenCostAllowed: boolean; tokenCost: null; source: ModelSpec['source'] } {
    const spec = this.models.get(providerId, modelId), provider = this.providers.get(providerId);
    return { audioInput: spec.mediaCapabilities?.audioInput === true && provider?.supportsInputMedia?.(modelId, 'audio') === true,
      videoFrames: spec.mediaCapabilities?.videoFrames === true && provider?.supportsInputMedia?.(modelId, 'video') === true,
      audioOutput: spec.mediaCapabilities?.audioOutput === true && provider?.requestedOutputMedia?.(modelId) === 'audio/wav',
      unknownTokenCostAllowed: this.allowMediaCost, tokenCost: null, source: spec.source };
  }

  private trackImport<T>(factory: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.lifetime.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    return this.lifetime.track(factory(this.lifetime.hostSignal(signal)));
  }

  importImage(sessionId: string, data: Uint8Array, mimeType: InputImageAttachment['mimeType'], signal?: AbortSignal): Promise<InputImageAttachment> {
    return this.trackImport(lifetime => this.images.import(sessionId, data, mimeType, lifetime), signal);
  }

  importDocument(sessionId: string, data: Uint8Array, signal?: AbortSignal): Promise<InputDocumentAttachment> {
    return this.trackImport(lifetime => this.documents.import(sessionId, data, lifetime), signal);
  }

  importMedia(sessionId: string, data: Uint8Array, mimeType: InputMediaAttachment['mimeType'], segments: readonly InputMediaSegment[], signal?: AbortSignal): Promise<InputMediaAttachment> {
    return this.trackImport(lifetime => this.segments.import(sessionId, data, mimeType, segments, lifetime), signal);
  }

  async readOutput(input: { sessionId: string; partId: string; offset?: number; limit?: number; signal?: AbortSignal }) {
    this.lifetime.assertOpen();
    const fields = plainRecord(input, ['sessionId', 'partId'], ['offset', 'limit', 'signal'], fault => {
      throw new EngineError('MEDIA_INVALID_READ', fault === 'shape' ? 'Read options must be ordinary data' : fault === 'fields' ? 'Bounded native media read options are required' : 'Read options cannot contain accessors');
    });
    const { signal, ...raw } = Object.assign(Object.create(null), fields) as typeof input;
    const safe = jobJson(raw, 4096);
    if (typeof safe.sessionId !== 'string' || typeof safe.partId !== 'string' || safe.offset !== undefined && (!Number.isSafeInteger(safe.offset) || safe.offset < 0)
      || safe.limit !== undefined && (!Number.isSafeInteger(safe.limit) || safe.limit < 1 || safe.limit > 65536)) throw new EngineError('MEDIA_INVALID_READ', 'Bounded native media read options are required');
    const part = this.store.readProviderMediaPart(safe.sessionId, safe.partId);
    return await this.lifetime.track((await this.managedArtifacts()).read(part.artifact.id, {
      identity: part.artifact.identity, ...(safe.offset === undefined ? {} : { offset: safe.offset }), limit: safe.limit ?? 8192, signal: this.lifetime.hostSignal(signal),
    }));
  }
}
