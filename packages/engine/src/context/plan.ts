import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { EngineError } from '@moodcode/contracts';
import type { ContextRequest, ProviderMessage } from '../ports.js';
import { buildContext } from './index.js';
import type { ModelSpec } from './model-spec.js';
import { boundedJson } from '../artifacts/validation.js';
import { REPOSITORY_CONTRIBUTION_LIMITS } from './repository-contributions.js';

export interface TokenEstimate { tokens: number; source: 'utf8-byte-upper-bound'; estimated: true; imageTokens?: null; documentTokens?: null; complete?: false }
export interface ContextPlan {
  messages: ProviderMessage[];
  sha256: string;
  selectedMessageIds: string[];
  omittedMessageCount: number;
  reservations: { envelopeBytes: number; outputTokens: number; repositoryBytes?: number; knowledgeBytes?: number };
  bytes: number;
  byteLimit: number;
  inputEstimate: TokenEstimate;
  tokenLimit: number | null;
  model: { providerId: string; modelId: string; source: ModelSpec['source'] | null };
  warnings: string[];
}

/** A conservative fallback, explicitly separate from measured provider usage. */
export function estimateTokens(messages: ProviderMessage[], envelopeBytes = 0): TokenEstimate {
  return { tokens: Buffer.byteLength(JSON.stringify(messages)) + envelopeBytes, source: 'utf8-byte-upper-bound', estimated: true,
    ...(messages.some(message => message.attachments?.length) ? { imageTokens: null, complete: false } as const : {}),
    ...(messages.some(message => message.documents?.length) ? { documentTokens: null, complete: false } as const : {}) };
}

function assertKnowledgeData(value: unknown): void {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (input: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > 64) throw new Error('Knowledge data is too deeply nested');
    if (!input || typeof input !== 'object') return;
    if (types.isProxy(input) || seen.has(input)) throw new Error('Knowledge data must be detached plain JSON');
    const array = Array.isArray(input), descriptors = Object.getOwnPropertyDescriptors(input);
    if (Object.getPrototypeOf(input) !== (array ? Array.prototype : Object.prototype) && Object.getPrototypeOf(input) !== null)
      throw new Error('Knowledge data must be plain JSON');
    seen.add(input);
    try {
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') throw new Error('Knowledge data cannot contain symbols');
        const descriptor = descriptors[key]!;
        if (!('value' in descriptor) || (!descriptor.enumerable && !(array && key === 'length'))) throw new Error('Knowledge data cannot contain accessors');
        visit(descriptor.value, depth + 1);
      }
    } finally { seen.delete(input); }
  };
  visit(value, 0);
}

export async function planContext(request: ContextRequest, options: { model?: ModelSpec; outputTokens?: number; repositoryMessages?: readonly ProviderMessage[]; knowledgeMessages?: readonly ProviderMessage[]; requiredOnly?: boolean } = {}): Promise<ContextPlan> {
  const envelopeBytes = request.reservedBytes ?? 0;
  let repositoryMessages: ProviderMessage[] = [];
  if (options.repositoryMessages !== undefined) {
    try { repositoryMessages = boundedJson(options.repositoryMessages, REPOSITORY_CONTRIBUTION_LIMITS.messageBytes + 1) as unknown as ProviderMessage[]; }
    catch { throw new EngineError('INVALID_REPOSITORY_CONTEXT', 'Repository context messages must be bounded JSON evidence'); }
    if (!Array.isArray(repositoryMessages) || repositoryMessages.length > 1 || repositoryMessages.some(message => !message || message.role !== 'assistant'
      || typeof message.content !== 'string' || Object.keys(message).sort().join(',') !== 'content,role'))
      throw new EngineError('INVALID_REPOSITORY_CONTEXT', 'Repository context accepts only a bounded plain assistant evidence entry');
  }
  const repositoryBytes = repositoryMessages.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)) + 1, 0);
  if (repositoryBytes > REPOSITORY_CONTRIBUTION_LIMITS.messageBytes) throw new EngineError('INVALID_REPOSITORY_CONTEXT', 'Repository evidence exceeds the additional message reservation cap');
  let knowledgeMessages: ProviderMessage[] = [];
  if (options.knowledgeMessages !== undefined) {
    try { assertKnowledgeData(options.knowledgeMessages); knowledgeMessages = boundedJson(options.knowledgeMessages, 16_385) as unknown as ProviderMessage[]; }
    catch { throw new EngineError('INVALID_KNOWLEDGE_CONTEXT', 'Knowledge context messages must be bounded JSON evidence'); }
    if (!Array.isArray(knowledgeMessages) || knowledgeMessages.length > 1 || knowledgeMessages.some(message => !message || message.role !== 'assistant'
      || typeof message.content !== 'string' || Object.keys(message).sort().join(',') !== 'content,role'))
      throw new EngineError('INVALID_KNOWLEDGE_CONTEXT', 'Knowledge context accepts one bounded assistant data entry');
  }
  const knowledgeBytes = knowledgeMessages.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)) + 1, 0);
  if (knowledgeBytes > 16_384) throw new EngineError('INVALID_KNOWLEDGE_CONTEXT', 'Whole knowledge evidence exceeds its additional message reservation cap');
  const model = options.model;
  if (model && (model.providerId !== request.config.providerId || model.modelId !== request.config.modelId)) throw new EngineError('MODEL_BINDING_MISMATCH', 'Context metadata belongs to a different provider/model');
  const outputTokens = options.outputTokens ?? 0;
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0 || outputTokens > 100_000_000) throw new EngineError('INVALID_OUTPUT_RESERVE', 'Output token reserve must be a bounded nonnegative integer');
  if (model?.maxOutputTokens !== null && model?.maxOutputTokens !== undefined && outputTokens > model.maxOutputTokens) throw new EngineError('MODEL_OUTPUT_LIMIT', 'Output reserve exceeds the known model limit');
  const effectiveByteLimit = model?.contextWindow == null ? request.config.limits.maxContextBytes : Math.min(request.config.limits.maxContextBytes, model.contextWindow - outputTokens);
  let messages: ProviderMessage[];
  try { messages = await buildContext({ ...request, reservedBytes: envelopeBytes + repositoryBytes + knowledgeBytes, config: { ...request.config, limits: { ...request.config.limits, maxContextBytes: effectiveByteLimit } } }, { requiredOnly: options.requiredOnly }); }
  catch (error) { if (error instanceof EngineError && error.code === 'CONTEXT_LIMIT' && effectiveByteLimit < request.config.limits.maxContextBytes) throw new EngineError('CONTEXT_TOKEN_LIMIT', 'The required current exchange exceeds the conservative model window and output reserve', { tokenLimit: model!.contextWindow, outputTokens, estimateSource: 'utf8-byte-upper-bound' }); throw error; }
  // Synthetic evidence precedes the first transcript message and never splits a tool exchange.
  if (repositoryMessages.length || knowledgeMessages.length) {
    const firstTranscript = messages.findIndex(message => message.role !== 'system');
    const index = firstTranscript < 0 ? messages.length : firstTranscript;
    messages = [...messages.slice(0, index), ...repositoryMessages, ...knowledgeMessages, ...messages.slice(index)];
  }
  const serialized = JSON.stringify(messages);
  const bytes = Buffer.byteLength(serialized) + envelopeBytes;
  const inputEstimate = estimateTokens(messages, envelopeBytes);
  const tokenLimit = model?.contextWindow ?? null;
  if (tokenLimit !== null && inputEstimate.tokens + outputTokens > tokenLimit) throw new EngineError('CONTEXT_TOKEN_LIMIT', 'Conservative input estimate and output reserve exceed the model context window', {
    estimatedInputTokens: inputEstimate.tokens, outputTokens, tokenLimit, estimateSource: inputEstimate.source,
  });
  const selectedMessageIds: string[] = [];
  // Duplicate text is matched in chronological order, rather than selecting every equal message.
  let previous = request.snapshot.messages.length - 1;
  for (const selected of [...messages].reverse()) {
    if (selected.role === 'system') continue;
    const index = request.snapshot.messages.findLastIndex((message, position) => position <= previous && message.role === selected.role
      && message.content === selected.content && message.toolCallId === selected.toolCallId
      && JSON.stringify(message.attachments) === JSON.stringify(selected.attachments)
      && JSON.stringify(message.documents) === JSON.stringify(selected.documents));
    if (index >= 0) { selectedMessageIds.unshift(request.snapshot.messages[index]!.id); previous = index - 1; }
  }
  return {
    messages, sha256: createHash('sha256').update(serialized).digest('hex'), selectedMessageIds,
    omittedMessageCount: Math.max(0, request.snapshot.messages.length - selectedMessageIds.length),
    reservations: { envelopeBytes, outputTokens, ...(repositoryBytes ? { repositoryBytes } : {}), ...(knowledgeBytes ? { knowledgeBytes } : {}) }, bytes, byteLimit: effectiveByteLimit,
    inputEstimate, tokenLimit, model: { providerId: request.config.providerId, modelId: request.config.modelId, source: model?.source ?? null },
    warnings: [...(tokenLimit === null ? ['Model context window is unknown; only the byte hard cap is enforced.'] : ['Token count is a conservative UTF-8 estimate, not measured usage.']),
      ...(inputEstimate.imageTokens === null ? ['Image token cost is unknown; the UTF-8 estimate covers text and reference metadata only. Image byte caps are enforced separately; the complete model token window is not verified.'] : []),
      ...(inputEstimate.documentTokens === null ? ['PDF page/text token cost is unknown; the UTF-8 estimate covers text and reference metadata only. Document byte caps are enforced separately; the complete model token window is not verified.'] : [])],
  };
}
