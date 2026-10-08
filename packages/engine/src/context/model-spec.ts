import { EngineError } from '@moodcode/contracts';
import { jobJson } from '../jobs/validation.js';
import { types } from 'node:util';

export interface ModelSpec {
  providerId: string;
  modelId: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  modalities: readonly ('text' | 'image' | 'audio' | 'video')[] | null;
  /** null/omitted means unknown; an empty list explicitly declares no native file inputs. */
  inputFileTypes?: readonly 'application/pdf'[] | null;
  mediaCapabilities?: {audioInput:boolean;videoFrames:boolean;audioOutput:boolean} | null;
  tools: boolean | null;
  reasoning: boolean | null;
  nativeReplay: boolean | null;
  source: { kind: 'host' | 'provider-catalog' | 'fixture'; observedAt: string; reference?: string };
}

function identifier(value: string): void {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new EngineError('INVALID_MODEL_SPEC', 'Model identifiers must be bounded text');
  }
}
function count(value: number | null): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 100_000_000)) {
    throw new EngineError('INVALID_MODEL_SPEC', 'Known model limits must be positive bounded integers');
  }
}
export function unknownModelSpec(providerId: string, modelId: string): ModelSpec {
  identifier(providerId); identifier(modelId);
  return { providerId, modelId, contextWindow: null, maxOutputTokens: null, modalities: null, inputFileTypes: null, tools: null, reasoning: null, nativeReplay: null,
    source: { kind: 'host', observedAt: new Date().toISOString() } };
}

function fileTypes(spec: ModelSpec): readonly 'application/pdf'[] | null {
  if (types.isProxy(spec)) throw new EngineError('INVALID_MODEL_SPEC', 'Model metadata must be a plain value');
  const property = Object.getOwnPropertyDescriptor(spec, 'inputFileTypes');
  if (!property) return null;
  if (!property.enumerable || !('value' in property)) throw new EngineError('INVALID_MODEL_SPEC', 'File capabilities must be enumerable data');
  const value: unknown = property.value;
  if (value === undefined || value === null) return null;
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new EngineError('INVALID_MODEL_SPEC', 'File capabilities must be a plain array or null');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > 1 || Reflect.ownKeys(value).length !== length + 1) throw new EngineError('INVALID_MODEL_SPEC', 'Unsupported file capability metadata');
  if (length === 0) return [];
  const entry = descriptors['0'];
  if (!entry?.enumerable || !('value' in entry) || entry.value !== 'application/pdf') throw new EngineError('INVALID_MODEL_SPEC', 'Unsupported file capability metadata');
  return ['application/pdf'];
}

/** Metadata is supplied by a catalog/host; missing limits stay unknown. */
export class ModelRegistry {
  private readonly specs = new Map<string, ModelSpec>();
  private key(providerId: string, modelId: string): string { return JSON.stringify([providerId, modelId]); }
  put(spec: ModelSpec): ModelSpec {
    const inputFileTypes = fileTypes(spec);
    const capDescriptor=Object.getOwnPropertyDescriptor(spec,'mediaCapabilities');
    if(capDescriptor&&(!capDescriptor.enumerable||!Object.hasOwn(capDescriptor,'value')))throw new EngineError('INVALID_MODEL_SPEC','Media metadata must be data');
    const rawCaps=capDescriptor?.value, mediaCapabilities=rawCaps===undefined||rawCaps===null?null:jobJson(rawCaps,4096);
    if(mediaCapabilities!==null&&(typeof mediaCapabilities!=='object'||Array.isArray(mediaCapabilities)||Object.keys(mediaCapabilities).length!==3||['audioInput','videoFrames','audioOutput'].some(k=>typeof (mediaCapabilities as Record<string,unknown>)[k]!=='boolean')))throw new EngineError('INVALID_MODEL_SPEC','Explicit media capability fields are invalid');
    identifier(spec.providerId); identifier(spec.modelId);
    count(spec.contextWindow); count(spec.maxOutputTokens);
    for (const value of [spec.tools, spec.reasoning, spec.nativeReplay]) if (value !== null && typeof value !== 'boolean') {
      throw new EngineError('INVALID_MODEL_SPEC', 'Capabilities must be known booleans or null');
    }
    if (spec.modalities !== null && (!Array.isArray(spec.modalities) || spec.modalities.length > 4 || new Set(spec.modalities).size !== spec.modalities.length
      || spec.modalities.some(value => !['text', 'image', 'audio', 'video'].includes(value)))) throw new EngineError('INVALID_MODEL_SPEC', 'Unsupported modality metadata');
    if (!spec.source || !['host', 'provider-catalog', 'fixture'].includes(spec.source.kind) || !Number.isFinite(Date.parse(spec.source.observedAt))
      || (spec.source.reference !== undefined && (typeof spec.source.reference !== 'string' || Buffer.byteLength(spec.source.reference) > 2048))) {
      throw new EngineError('INVALID_MODEL_SPEC', 'Model metadata requires a bounded source and observation time');
    }
    const key = this.key(spec.providerId, spec.modelId);
    if (!this.specs.has(key) && this.specs.size >= 256) throw new EngineError('MODEL_CATALOG_LIMIT', 'Model metadata catalog is full');
    const copy:ModelSpec = { ...structuredClone(spec), inputFileTypes, ...(capDescriptor ? {mediaCapabilities:mediaCapabilities as ModelSpec['mediaCapabilities']} : {}) };
    this.specs.set(key, copy);
    return structuredClone(copy);
  }
  get(providerId: string, modelId: string): ModelSpec {
    identifier(providerId); identifier(modelId);
    return structuredClone(this.specs.get(this.key(providerId, modelId)) ?? unknownModelSpec(providerId, modelId));
  }
  list(): ModelSpec[] { return [...this.specs.values()].map(spec => structuredClone(spec)); }
}
