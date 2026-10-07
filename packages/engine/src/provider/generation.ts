import { types } from 'node:util';
import { EngineError, REASONING_EFFORTS, type ReasoningEffort } from '@moodcode/contracts';
import type { ProviderEvent, ProviderMessage, ProviderTool, ResolvedInputDocument, ResolvedInputImage } from '../ports.js';

/** Host-owned work has no coding Run, Session, Turn, or tool authority. */
export interface HostGenerationOwner {
  readonly kind: 'host-generation';
  readonly workspaceId: string;
  readonly generationId: string;
  readonly attemptId: string;
}
export interface HostGenerationMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}
export interface HostGenerationPayload {
  readonly modelId: string;
  readonly messages: readonly HostGenerationMessage[];
  readonly tools: readonly [];
  readonly reasoningEffort?: ReasoningEffort;
  readonly includeMetadata: true;
}
export interface HostGenerationRequest extends HostGenerationPayload {
  readonly owner: HostGenerationOwner;
}
export interface HostGenerationProviderPort {
  streamGeneration(request: HostGenerationRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

/** Only fields consumed by provider encoding; coding ownership stays in the runner. */
export interface ProviderTransportRequest {
  readonly modelId: string;
  readonly messages: readonly ProviderMessage[];
  readonly tools: readonly ProviderTool[];
  readonly reasoningEffort?: ReasoningEffort;
  readonly includeMetadata?: boolean;
  readonly sessionId?: string;
  readonly resolvedImages?: readonly ResolvedInputImage[];
  readonly resolvedDocuments?: readonly ResolvedInputDocument[];
}

export const HOST_GENERATION_REQUEST_LIMITS = Object.freeze({ maxBytes: 262_144, maxMessages: 256, maxIdentifierBytes: 256 });

function invalid(): never {
  throw new EngineError('PROVIDER_INVALID_REQUEST', 'Host generation requires bounded plain text input and explicit host ownership.');
}
function plain(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key as string]!;
    if (!('value' in descriptor) || !descriptor.enumerable) invalid();
    result[key as string] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) invalid();
  return result;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some(key => typeof key !== 'string')) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
    result.push(descriptor.value);
  }
  return result;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > HOST_GENERATION_REQUEST_LIMITS.maxIdentifierBytes
    || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  return value;
}

/** Validate without invoking getters/proxy traps, then detach and freeze every field. */
export function validateHostGenerationRequest(value: unknown): HostGenerationRequest {
  const request = plain(value, ['owner', 'modelId', 'messages', 'tools', 'includeMetadata'], ['reasoningEffort']);
  const owner = plain(request.owner, ['kind', 'workspaceId', 'generationId', 'attemptId']);
  if (owner.kind !== 'host-generation' || request.includeMetadata !== true || array(request.tools, 0).length !== 0) invalid();
  const messages = array(request.messages, HOST_GENERATION_REQUEST_LIMITS.maxMessages);
  if (!messages.length) invalid();
  let bytes = 0;
  const detached = messages.map(value => {
    const message = plain(value, ['role', 'content']);
    if (message.role !== 'system' && message.role !== 'user' || typeof message.content !== 'string') invalid();
    bytes += Buffer.byteLength(message.content);
    if (bytes > HOST_GENERATION_REQUEST_LIMITS.maxBytes) invalid();
    return Object.freeze({ role: message.role, content: message.content });
  });
  const effort = request.reasoningEffort;
  if (Object.hasOwn(request, 'reasoningEffort') && (typeof effort !== 'string' || !REASONING_EFFORTS.includes(effort as ReasoningEffort))) invalid();
  const result: HostGenerationRequest = Object.freeze({
    owner: Object.freeze({ kind: 'host-generation', workspaceId: identifier(owner.workspaceId), generationId: identifier(owner.generationId), attemptId: identifier(owner.attemptId) }),
    modelId: identifier(request.modelId), messages: Object.freeze(detached), tools: Object.freeze([]) as readonly [],
    ...(effort === undefined ? {} : { reasoningEffort: effort as ReasoningEffort }), includeMetadata: true,
  });
  if (Buffer.byteLength(JSON.stringify(result)) > HOST_GENERATION_REQUEST_LIMITS.maxBytes) invalid();
  return result;
}

/** No owner identifiers or coding/media fields cross the shared encoding boundary. */
export function hostGenerationTransportRequest(value: unknown): ProviderTransportRequest {
  const request = validateHostGenerationRequest(value);
  return Object.freeze({ modelId: request.modelId, messages: request.messages, tools: request.tools,
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }), includeMetadata: true });
}
