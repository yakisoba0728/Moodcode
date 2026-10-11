import { createHash } from 'node:crypto';
import { EngineError, type Message } from '@moodcode/contracts';
import type { ContextRequest, ProviderMessage } from '../ports.js';
import { buildContext } from './index.js';
import { entriesBytes } from './memory.js';
import type { ModelSpec } from './model-spec.js';
import { boundedJson } from '../artifacts/validation.js';
import { REPOSITORY_CONTRIBUTION_LIMITS } from './repository-contributions.js';

export interface TokenEstimate { tokens: number; source: 'utf8-byte-upper-bound'; estimated: true; imageTokens?: null; documentTokens?: null; mediaTokens?:null; complete?: false }
export interface ContextPlan {
  messages: ProviderMessage[];
  sha256: string;
  selectedMessageIds: string[];
  omittedMessageCount: number;
  reservations: { envelopeBytes: number; outputTokens: number; repositoryBytes?: number; knowledgeBytes?: number; proposalBytes?: number; lifecycleBytes?: number; forkBytes?: number };
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
    ...(messages.some(message => message.media?.length)?{mediaTokens:null,complete:false} as const:{}),
    ...(messages.some(message => message.documents?.length) ? { documentTokens: null, complete: false } as const : {}) };
}

interface SupplementalSource { cap: number; code: string; detached: boolean; prefix?: string; invalid: string; shape: string; oversize: string }
// Detached sources must also be plain data without proxies, symbol keys or hidden properties.
const SUPPLEMENTAL = {
  repository: { cap: REPOSITORY_CONTRIBUTION_LIMITS.messageBytes, code: 'INVALID_REPOSITORY_CONTEXT', detached: false, invalid: 'Repository context messages must be bounded JSON evidence',
    shape: 'Repository context accepts only a bounded plain assistant evidence entry', oversize: 'Repository evidence exceeds the additional message reservation cap' },
  knowledge: { cap: 16_384, code: 'INVALID_KNOWLEDGE_CONTEXT', detached: true, invalid: 'Knowledge context messages must be bounded JSON evidence',
    shape: 'Knowledge context accepts one bounded assistant data entry', oversize: 'Whole knowledge evidence exceeds its additional message reservation cap' },
  proposal: { cap: 32_768, code: 'INVALID_PROPOSAL_CONTEXT', detached: true, prefix: '[Moodcode pending proposal overlay v1]\n', invalid: 'Proposal overlay requires bounded detached JSON data',
    shape: 'Proposal overlay accepts one plain pending data entry', oversize: 'Whole proposal overlay exceeds its message reservation cap' },
} satisfies Record<string, SupplementalSource>;

function supplemental(source: SupplementalSource, value: readonly ProviderMessage[] | undefined): { messages: ProviderMessage[]; bytes: number } {
  let messages: ProviderMessage[] = [];
  if (value !== undefined) {
    try { messages = boundedJson(value, source.cap + 1, source.detached) as unknown as ProviderMessage[]; }
    catch { throw new EngineError(source.code, source.invalid); }
    if (!Array.isArray(messages) || messages.length > 1 || messages.some(message => !message || message.role !== 'assistant' || typeof message.content !== 'string'
      || source.prefix !== undefined && !message.content.startsWith(source.prefix) || Object.keys(message).sort().join(',') !== 'content,role'))
      throw new EngineError(source.code, source.shape);
  }
  const bytes = entriesBytes(messages);
  if (bytes > source.cap) throw new EngineError(source.code, source.oversize);
  return { messages, bytes };
}

/** Synthetic entries precede the first transcript message, so they never split a tool exchange. */
export function withSyntheticEntries(messages: readonly ProviderMessage[], entries: readonly ProviderMessage[], envelopeBytes: number): Pick<ContextPlan, 'messages' | 'sha256' | 'bytes' | 'inputEstimate'> {
  const first = messages.findIndex(message => message.role !== 'system'), index = first < 0 ? messages.length : first;
  const next = [...messages.slice(0, index), ...entries, ...messages.slice(index)], serialized = JSON.stringify(next);
  return { messages: next, sha256: createHash('sha256').update(serialized).digest('hex'), bytes: Buffer.byteLength(serialized) + envelopeBytes, inputEstimate: estimateTokens(next, envelopeBytes) };
}

export async function planContext(request: ContextRequest, options: { model?: ModelSpec; outputTokens?: number; repositoryMessages?: readonly ProviderMessage[]; knowledgeMessages?: readonly ProviderMessage[]; proposalMessages?: readonly ProviderMessage[]; forkMessages?: readonly ProviderMessage[]; requiredOnly?: boolean } = {}): Promise<ContextPlan> {
  const envelopeBytes = request.reservedBytes ?? 0;
  const forkMessages = options.forkMessages ? boundedJson(options.forkMessages,65537) as unknown as ProviderMessage[] : [];
  const forkBytes = entriesBytes(forkMessages);
  if (forkBytes>65536) throw new EngineError('FORK_CONTEXT_LIMIT','Whole frozen transcript exceeds its reservation');
  const repository = supplemental(SUPPLEMENTAL.repository, options.repositoryMessages);
  const knowledge = supplemental(SUPPLEMENTAL.knowledge, options.knowledgeMessages);
  const proposal = supplemental(SUPPLEMENTAL.proposal, options.proposalMessages);
  const repositoryBytes = repository.bytes, knowledgeBytes = knowledge.bytes, proposalBytes = proposal.bytes;
  const model = options.model;
  if (model && (model.providerId !== request.config.providerId || model.modelId !== request.config.modelId)) throw new EngineError('MODEL_BINDING_MISMATCH', 'Context metadata belongs to a different provider/model');
  const outputTokens = options.outputTokens ?? 0;
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0 || outputTokens > 100_000_000) throw new EngineError('INVALID_OUTPUT_RESERVE', 'Output token reserve must be a bounded nonnegative integer');
  if (model?.maxOutputTokens !== null && model?.maxOutputTokens !== undefined && outputTokens > model.maxOutputTokens) throw new EngineError('MODEL_OUTPUT_LIMIT', 'Output reserve exceeds the known model limit');
  const effectiveByteLimit = model?.contextWindow == null ? request.config.limits.maxContextBytes : Math.min(request.config.limits.maxContextBytes, model.contextWindow - outputTokens);
  let transcript: ProviderMessage[];
  try { transcript = await buildContext({ ...request, reservedBytes: envelopeBytes + repositoryBytes + knowledgeBytes + proposalBytes + forkBytes, config: { ...request.config, limits: { ...request.config.limits, maxContextBytes: effectiveByteLimit } } }, { requiredOnly: options.requiredOnly }); }
  catch (error) { if (error instanceof EngineError && error.code === 'CONTEXT_LIMIT' && effectiveByteLimit < request.config.limits.maxContextBytes) throw new EngineError('CONTEXT_TOKEN_LIMIT', 'The required current exchange exceeds the conservative model window and output reserve', { tokenLimit: model!.contextWindow, outputTokens, estimateSource: 'utf8-byte-upper-bound' }); throw error; }
  const entries = [...repository.messages, ...knowledge.messages, ...proposal.messages, ...forkMessages];
  const { messages, sha256, bytes, inputEstimate } = withSyntheticEntries(transcript, entries, envelopeBytes);
  if(forkBytes && bytes>effectiveByteLimit)throw new EngineError('CONTEXT_LIMIT','Whole context including frozen fork history exceeds the exact byte cap');
  const tokenLimit = model?.contextWindow ?? null;
  if (tokenLimit !== null && inputEstimate.tokens + outputTokens > tokenLimit) throw new EngineError('CONTEXT_TOKEN_LIMIT', 'Conservative input estimate and output reserve exceed the model context window', {
    estimatedInputTokens: inputEstimate.tokens, outputTokens, tokenLimit, estimateSource: inputEstimate.source,
  });
  const selectedMessageIds: string[] = [];
  const synthetic = new Set(entries), stored = request.snapshot.messages;
  const same = (message: Message, selected: ProviderMessage) => message.role === selected.role
    && message.content === selected.content && message.toolCallId === selected.toolCallId
    && JSON.stringify(message.attachments) === JSON.stringify(selected.attachments)
    && JSON.stringify(message.media) === JSON.stringify(selected.media) && JSON.stringify(message.documents) === JSON.stringify(selected.documents);
  // Duplicate text is matched in chronological order, rather than selecting every equal message.
  let previous = stored.length - 1;
  for (const selected of [...messages].reverse()) {
    if (selected.role === 'system' || synthetic.has(selected)) continue;
    let index = previous;
    while (index >= 0 && !same(stored[index]!, selected)) index--;
    if (index >= 0) { selectedMessageIds.unshift(stored[index]!.id); previous = index - 1; }
  }
  return {
    messages, sha256, selectedMessageIds,
    omittedMessageCount: Math.max(0, request.snapshot.messages.length - selectedMessageIds.length),
    reservations: { envelopeBytes, outputTokens, ...(repositoryBytes ? { repositoryBytes } : {}), ...(knowledgeBytes ? { knowledgeBytes } : {}), ...(proposalBytes ? { proposalBytes } : {}), ...(forkBytes ? { forkBytes } : {}) }, bytes, byteLimit: effectiveByteLimit,
    inputEstimate, tokenLimit, model: { providerId: request.config.providerId, modelId: request.config.modelId, source: model?.source ?? null },
    warnings: [...(tokenLimit === null ? ['Model context window is unknown; only the byte hard cap is enforced.'] : ['Token count is a conservative UTF-8 estimate, not measured usage.']),
      ...(inputEstimate.imageTokens === null ? ['Image token cost is unknown; the UTF-8 estimate covers text and reference metadata only. Image byte caps are enforced separately; the complete model token window is not verified.'] : []),
      ...(inputEstimate.mediaTokens===null?['Audio/video token cost is unknown; only text/reference estimates and separate source/decoded-byte caps are verified.']:[]),
      ...(inputEstimate.documentTokens === null ? ['PDF page/text token cost is unknown; the UTF-8 estimate covers text and reference metadata only. Document byte caps are enforced separately; the complete model token window is not verified.'] : [])],
  };
}
