import { EngineError, AI_SDK_PROVIDERS, isAiSdkProviderId } from '@moodcode/contracts';
import type { ModelSpec } from '../context/model-spec.js';
import { plainJson } from '../shared/data.js';

export const MODEL_CATALOG_URL = 'https://models.dev/api.json';
export const CATALOG_PROVIDERS = ['openai-responses', 'anthropic', ...Object.keys(AI_SDK_PROVIDERS)] as const;
export interface CatalogModel {
  id: string; name: string; contextWindow: number | null; maxOutputTokens: number | null;
  tools: boolean | null; reasoning: boolean | null; input: string[]; output: string[]; deprecated: boolean;
}
export interface ModelCatalog {
  source: typeof MODEL_CATALOG_URL; observedAt: string;
  providers: { id: string; name: string; models: CatalogModel[] }[];
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 256): string | undefined => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
const count = (value: unknown): number | null => Number.isSafeInteger(value) && typeof value === 'number' && value > 0 && value <= 100_000_000 ? value : null;
const flag = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const modalities = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && ['text', 'image', 'pdf', 'audio', 'video'].includes(v)))].slice(0, 5) : [];

/** Catalogue declarations are metadata, never account access or additional adapter capabilities. */
export function parseModelCatalog(value: unknown, observedAt = new Date().toISOString()): ModelCatalog {
  if (typeof observedAt !== 'string' || Buffer.byteLength(observedAt) > 64 || !Number.isFinite(Date.parse(observedAt))) throw new EngineError('MODEL_CATALOG_INVALID', 'Catalogue observation time is invalid.');
  const source = object(plainJson(value, { maxBytes: 8 * 1024 * 1024, maxDepth: 16, maxNodes: 500_000, accounting: 'encoded', fail: () => { throw new EngineError('MODEL_CATALOG_INVALID', 'Catalogue must contain bounded plain JSON data.'); } }));
  const providers = CATALOG_PROVIDERS.map(id => {
    const entry = object(source[id === 'openai-responses' ? 'openai' : id]);
    const models = Object.entries(object(entry.models));
    if (models.length > 2000) throw new EngineError('MODEL_CATALOG_LIMIT', 'Provider model catalogue exceeds its limit.');
    return { id, name: text(entry.name) ?? id, models: models.flatMap(([key, raw]): CatalogModel[] => {
      const model = object(raw), identifier = text(model.id ?? key);
      if (!identifier || identifier.trim() !== identifier) return [];
      const limits = object(model.limit), media = object(model.modalities);
      return [{ id: identifier, name: text(model.name) ?? identifier, contextWindow: count(limits.context), maxOutputTokens: count(limits.output),
        tools: flag(model.tool_call), reasoning: flag(model.reasoning), input: modalities(media.input), output: modalities(media.output), deprecated: model.status === 'deprecated' }];
    }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
  });
  if (!providers.some(p => p.models.length)) throw new EngineError('MODEL_CATALOG_INVALID', 'No supported provider models were found.');
  return { source: MODEL_CATALOG_URL, observedAt, providers };
}

export function catalogModelSpec(catalog: ModelCatalog, providerId: string, modelId: string, baseURL: string): ModelSpec | undefined {
  const endpoint = isAiSdkProviderId(providerId) ? AI_SDK_PROVIDERS[providerId].baseURL : providerId === 'anthropic' ? 'https://api.anthropic.com/v1' : providerId === 'openai-responses' ? 'https://api.openai.com/v1' : undefined;
  if (!endpoint || endpoint.replace(/\/+$/, '') !== baseURL.replace(/\/+$/, '')) return undefined;
  const model = catalog.providers.find(p => p.id === providerId)?.models.find(m => m.id === modelId);
  if (!model || model.deprecated) return undefined;
  const supported = isAiSdkProviderId(providerId) ? ['text'] : ['text', 'image'];
  return { providerId, modelId, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens,
    modalities: model.input.length ? model.input.filter((v): v is 'text' | 'image' => supported.includes(v)) : null,
    inputFileTypes: isAiSdkProviderId(providerId) ? [] : model.input.includes('pdf') ? ['application/pdf'] : null,
    tools: model.tools, reasoning: model.reasoning, nativeReplay: true,
    source: { kind: 'provider-catalog', observedAt: catalog.observedAt, reference: catalog.source } };
}

export async function fetchModelCatalog(fetcher: typeof fetch = globalThis.fetch, signal?: AbortSignal): Promise<ModelCatalog> {
  const response = await fetcher(MODEL_CATALOG_URL, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) });
  if (!response.ok || response.redirected || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new EngineError('MODEL_CATALOG_UNAVAILABLE', 'The public model catalogue is unavailable.');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new EngineError('MODEL_CATALOG_LIMIT', 'Public model catalogue exceeds 8 MiB.');
      chunks.push(part.value);
    }
    try { return parseModelCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
    catch (error) { if (error instanceof EngineError) throw error; throw new EngineError('MODEL_CATALOG_INVALID', 'Public catalogue must be UTF-8 JSON.'); }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
