import { createHash } from 'node:crypto';
import { EngineError } from '@moodcode/contracts';
import type { ContextRequest, ProviderMessage } from '../ports.js';
import { buildContext } from './index.js';
import type { ModelSpec } from './model-spec.js';

export interface TokenEstimate { tokens: number; source: 'utf8-byte-upper-bound'; estimated: true }
export interface ContextPlan {
  messages: ProviderMessage[];
  sha256: string;
  selectedMessageIds: string[];
  omittedMessageCount: number;
  reservations: { envelopeBytes: number; outputTokens: number };
  bytes: number;
  byteLimit: number;
  inputEstimate: TokenEstimate;
  tokenLimit: number | null;
  model: { providerId: string; modelId: string; source: ModelSpec['source'] | null };
  warnings: string[];
}

/** A conservative fallback, explicitly separate from measured provider usage. */
export function estimateTokens(messages: ProviderMessage[], envelopeBytes = 0): TokenEstimate {
  return { tokens: Buffer.byteLength(JSON.stringify(messages)) + envelopeBytes, source: 'utf8-byte-upper-bound', estimated: true };
}

export async function planContext(request: ContextRequest, options: { model?: ModelSpec; outputTokens?: number } = {}): Promise<ContextPlan> {
  const messages = await buildContext(request);
  const envelopeBytes = request.reservedBytes ?? 0;
  const serialized = JSON.stringify(messages);
  const bytes = Buffer.byteLength(serialized) + envelopeBytes;
  const model = options.model;
  if (model && (model.providerId !== request.config.providerId || model.modelId !== request.config.modelId)) throw new EngineError('MODEL_BINDING_MISMATCH', 'Context metadata belongs to a different provider/model');
  const outputTokens = options.outputTokens ?? 0;
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0 || outputTokens > 100_000_000) throw new EngineError('INVALID_OUTPUT_RESERVE', 'Output token reserve must be a bounded nonnegative integer');
  if (model?.maxOutputTokens !== null && model?.maxOutputTokens !== undefined && outputTokens > model.maxOutputTokens) throw new EngineError('MODEL_OUTPUT_LIMIT', 'Output reserve exceeds the known model limit');
  const inputEstimate = estimateTokens(messages, envelopeBytes);
  const tokenLimit = model?.contextWindow ?? null;
  if (tokenLimit !== null && inputEstimate.tokens + outputTokens > tokenLimit) throw new EngineError('CONTEXT_TOKEN_LIMIT', 'Conservative input estimate and output reserve exceed the model context window', {
    estimatedInputTokens: inputEstimate.tokens, outputTokens, tokenLimit, estimateSource: inputEstimate.source,
  });
  const selectedMessageIds: string[] = [];
  // Duplicate text is matched in chronological order, rather than selecting every equal message.
  let next = 0;
  for (const selected of messages) {
    if (selected.role === 'system') continue;
    const index = request.snapshot.messages.findIndex((message, position) => position >= next && message.role === selected.role
      && message.content === selected.content && message.toolCallId === selected.toolCallId);
    if (index >= 0) { selectedMessageIds.push(request.snapshot.messages[index]!.id); next = index + 1; }
  }
  return {
    messages, sha256: createHash('sha256').update(serialized).digest('hex'), selectedMessageIds,
    omittedMessageCount: Math.max(0, request.snapshot.messages.length - selectedMessageIds.length),
    reservations: { envelopeBytes, outputTokens }, bytes, byteLimit: request.config.limits.maxContextBytes,
    inputEstimate, tokenLimit, model: { providerId: request.config.providerId, modelId: request.config.modelId, source: model?.source ?? null },
    warnings: tokenLimit === null ? ['Model context window is unknown; only the byte hard cap is enforced.'] : ['Token count is a conservative UTF-8 estimate, not measured usage.'],
  };
}
