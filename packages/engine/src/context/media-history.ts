import { createHash } from 'node:crypto';
import { EngineError, type InputImageAttachment, type Message, type SessionSnapshot } from '@moodcode/contracts';
import type { ProviderMessage } from '../ports.js';
import { entryBytes } from './memory.js';
import { attachments, DEFAULT_IMAGE_LIMITS, sameAttachment } from '../media/validation.js';

export const MEDIA_HISTORY_NOTICE_PREFIX = '[Moodcode image history provenance v1]\n';
export const MEDIA_HISTORY_LIMITS = Object.freeze({ maxSourceMessages: 512, maxMetadataBytes: 16_384, maxReplayNodes: 4096, maxReplayDepth: 32 });
/** Host-only opt-in. These bounds can tighten, never expand, the image transport caps. */
export interface MediaHistoryPolicy {
  kind: 'reference-only-older-images';
  version: 1;
  maxImageOccurrences?: number;
  maxImageBytes?: number;
  maxMetadataBytes?: number;
}
export interface MediaHistoryOptions {
  policy?: MediaHistoryPolicy;
  activeRunId?: string;
}
export interface ImageHistoryProvenance {
  version: 1;
  sessionId: string;
  runId: string;
  messageId: string;
  sourceOrdinal: number;
  sourceContentSha256: string;
  attachments: InputImageAttachment[];
  pixels: 'unavailable-in-this-request';
  reason: 'host-reference-only-history' | 'older-exact-reference';
  summarized: false;
  currentFileEvidence: false;
}
export interface MediaHistoryDiagnostics {
  enabled: boolean;
  policySha256: string | null;
  sourceSha256: string | null;
  sourceImageOccurrences: number;
  retainedImageOccurrences: number;
  omittedImageOccurrences: number;
  retainedImageBytes: number;
  uniqueRetainedImages: number;
  metadataBytes: number;
  noticeBytes: number;
  metadataTokenEstimate: { tokens: number; source: 'utf8-byte-upper-bound'; estimated: true };
  imageTokens: null;
  summarized: false;
  activeCutoffCreated: false;
}
export interface MediaHistoryProjection {
  snapshot: SessionSnapshot;
  requiredNotice: ProviderMessage | null;
  provenance: ImageHistoryProvenance[];
  requiredTextMessageIds: string[];
  requiredExchangeMessageIds: string[];
  diagnostics: MediaHistoryDiagnostics;
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
function fail(code: string, message: string): never { throw new EngineError(code, message); }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) fail('CANCELLED', 'Image history projection was cancelled'); }
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function identifier(value: unknown): value is string { return typeof value === 'string' && !!value && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value); }
function dataRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
export function validateMediaHistoryPolicy(value: MediaHistoryPolicy): Required<MediaHistoryPolicy> {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['kind', 'version', 'maxImageOccurrences', 'maxImageBytes', 'maxMetadataBytes'].includes(key))
      || Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !('value' in item) || !item.enumerable)
      || value.kind !== 'reference-only-older-images' || value.version !== 1) fail('IMAGE_HISTORY_INVALID_POLICY', 'Image history requires an explicit supported host policy');
  const limits = { maxImageOccurrences: value.maxImageOccurrences ?? DEFAULT_IMAGE_LIMITS.maxInputImages,
    maxImageBytes: value.maxImageBytes ?? DEFAULT_IMAGE_LIMITS.maxInputBytes, maxMetadataBytes: value.maxMetadataBytes ?? MEDIA_HISTORY_LIMITS.maxMetadataBytes };
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const maximum = key === 'maxImageOccurrences' ? DEFAULT_IMAGE_LIMITS.maxInputImages : key === 'maxImageBytes' ? DEFAULT_IMAGE_LIMITS.maxInputBytes : MEDIA_HISTORY_LIMITS.maxMetadataBytes;
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum || Object.hasOwn(value, key) && value[key] === undefined) fail('IMAGE_HISTORY_INVALID_POLICY', 'Image history bounds must be positive integers within the hard caps');
  }
  return { kind: 'reference-only-older-images', version: 1, ...limits };
}

/** Recognized media-shaped replay is not a text/history image reference and cannot be safely counted here. */
function inspectReplay(value: unknown, signal?: AbortSignal): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }], seen = new Set<object>();
  let visited = 0, entries = 0;
  while (pending.length) {
    checkAbort(signal); const current = pending.pop()!;
    if (++visited > MEDIA_HISTORY_LIMITS.maxReplayNodes || current.depth > MEDIA_HISTORY_LIMITS.maxReplayDepth) fail('IMAGE_HISTORY_REPLAY_LIMIT', 'Opaque replay inspection exceeds its bounded metadata limit');
    if (current.value === null || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) fail('IMAGE_HISTORY_INVALID_SOURCE', 'Image history replay must be acyclic JSON'); seen.add(current.value);
    if (Object.getPrototypeOf(current.value) !== (Array.isArray(current.value) ? Array.prototype : Object.prototype) && Object.getPrototypeOf(current.value) !== null) fail('IMAGE_HISTORY_INVALID_SOURCE', 'Image history replay must be plain JSON');
    const descriptors = Object.getOwnPropertyDescriptors(current.value), keys = Reflect.ownKeys(current.value);
    entries += keys.length;
    if (entries > MEDIA_HISTORY_LIMITS.maxReplayNodes) fail('IMAGE_HISTORY_REPLAY_LIMIT', 'Opaque replay key count exceeds its bounded metadata limit');
    for (const key of keys) {
      const descriptor = typeof key === 'string' ? descriptors[key] : undefined;
      if (!descriptor || !('value' in descriptor)) fail('IMAGE_HISTORY_INVALID_SOURCE', 'Image history replay cannot contain accessors');
      const child: unknown = descriptor.value;
      if (key === 'type' && typeof child === 'string' && ['input_image', 'output_image', 'image', 'image_url', 'image_generation_call', 'input_audio', 'output_audio', 'input_video', 'video'].includes(child)
          || key === 'image_url' || ['mimeType', 'mime_type', 'media_type'].includes(String(key)) && typeof child === 'string' && /^(image|audio|video)\//u.test(child)) fail('IMAGE_HISTORY_REPLAY_MEDIA_UNSUPPORTED', 'Media-shaped opaque replay cannot be omitted or counted as imported image history');
      if (child !== null && typeof child === 'object') pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function latestCompleteExchange(messages: Message[], activeRunId?: string): string[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!; if (message.role !== 'assistant' || activeRunId !== undefined && message.runId !== activeRunId) continue;
    if (!message.toolCalls?.length) { if (message.content || message.providerReplay) return [message.id]; continue; }
    if (message.toolCalls.length > 64 || message.toolCalls.some(call => !call || typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.name)) continue;
    const ids = new Set(message.toolCalls.map(call => call.id));
    if (ids.size !== message.toolCalls.length) continue;
    const selected = [message.id]; let cursor = index + 1;
    while (cursor < messages.length && ids.size) {
      const result = messages[cursor++]!;
      if (result.role !== 'tool' || result.runId !== message.runId || result.sessionId !== message.sessionId || !result.toolCallId || !ids.delete(result.toolCallId)) break;
      selected.push(result.id);
    }
    if (!ids.size) return selected;
  }
  return [];
}

/**
 * Derive transport references only. Never mutate raw storage, trim messages,
 * summarize pixels, resolve bytes, or create an active-prefix/cutoff checkpoint.
 */
export function projectMediaHistory(source: SessionSnapshot, options: MediaHistoryOptions = {}, signal?: AbortSignal): MediaHistoryProjection {
  checkAbort(signal);
  const empty = (): MediaHistoryDiagnostics => ({ enabled: false, policySha256: null, sourceSha256: null, sourceImageOccurrences: 0,
    retainedImageOccurrences: 0, omittedImageOccurrences: 0, retainedImageBytes: 0, uniqueRetainedImages: 0, metadataBytes: 0, noticeBytes: 0,
    metadataTokenEstimate: { tokens: 0, source: 'utf8-byte-upper-bound', estimated: true }, imageTokens: null, summarized: false, activeCutoffCreated: false });
  if (options.policy === undefined) return { snapshot: structuredClone(source), requiredNotice: null, provenance: [], requiredTextMessageIds: [], requiredExchangeMessageIds: [], diagnostics: empty() };
  const policy = validateMediaHistoryPolicy(options.policy);
  if (!dataRecord(source) || !dataRecord(source.session) || !identifier(source.session.id) || !Array.isArray(source.messages) || source.messages.length > MEDIA_HISTORY_LIMITS.maxSourceMessages
      || Reflect.ownKeys(source.messages).length !== source.messages.length + 1) fail('IMAGE_HISTORY_SOURCE_LIMIT', 'Image history requires a bounded dense source snapshot');
  if (options.activeRunId !== undefined && !identifier(options.activeRunId)) fail('IMAGE_HISTORY_INVALID_SOURCE', 'Image history owner identifiers must be bounded');
  const imageRefs = new Map<string, InputImageAttachment[]>(), identities = new Map<string, InputImageAttachment>(), messageIds = new Set<string>();
  let sourceOccurrences = 0;
  for (let index = 0; index < source.messages.length; index++) {
    checkAbort(signal);
    const descriptor = Object.getOwnPropertyDescriptor(source.messages, String(index));
    if (!descriptor || !('value' in descriptor)) fail('IMAGE_HISTORY_INVALID_SOURCE', 'Image history cannot contain sparse messages or accessors');
    const message: Message = descriptor.value;
    if (!dataRecord(message) || !identifier(message.id) || !identifier(message.runId) || message.sessionId !== source.session.id || !['user', 'assistant', 'tool'].includes(message.role) || typeof message.content !== 'string' || messageIds.has(message.id)
        || message.toolCalls !== undefined && !Array.isArray(message.toolCalls)) fail('IMAGE_HISTORY_INVALID_SOURCE', 'Image history messages must have exact same-session identities');
    messageIds.add(message.id);
    if (message.providerReplay !== undefined) inspectReplay(message.providerReplay, signal);
    if (message.attachments === undefined) continue;
    let refs: InputImageAttachment[];
    try { refs = attachments(message.attachments); } catch { fail('IMAGE_HISTORY_INVALID_REFERENCE', 'Image history contains invalid imported image references'); }
    if (refs.length && message.role !== 'user') fail('IMAGE_HISTORY_INVALID_REFERENCE', 'Image history pixels belong only to user input');
    for (const ref of refs) { const previous = identities.get(ref.id); if (previous && !sameAttachment(previous, ref)) fail('IMAGE_HISTORY_REFERENCE_CONFLICT', 'The same imported image identity has inconsistent historical metadata'); identities.set(ref.id, ref); }
    if (refs.length) { imageRefs.set(message.id, refs); sourceOccurrences += refs.length; }
  }
  const users = source.messages.filter(message => message.role === 'user'), activeUsers = users.filter(message => options.activeRunId === undefined || message.runId === options.activeRunId);
  const requiredText = new Set([users[0]?.id, activeUsers[0]?.id, activeUsers.at(-1)?.id].filter((id): id is string => !!id));
  const latestImageId = source.messages.findLast(message => imageRefs.has(message.id))?.id;
  const retained = new Map<string, InputImageAttachment>(); let retainedOccurrences = 0, retainedBytes = 0;
  for (const ref of latestImageId ? imageRefs.get(latestImageId)! : []) { retainedOccurrences++; retainedBytes += ref.bytes; retained.set(ref.id, ref); }
  if (retainedOccurrences > policy.maxImageOccurrences || retainedBytes > policy.maxImageBytes) fail('IMAGE_HISTORY_REQUIRED_LIMIT', 'Required latest pixels exceed the request image frame or decoded-byte bound');
  const snapshot = structuredClone(source), provenance: ImageHistoryProvenance[] = [];
  for (let index = 0; index < snapshot.messages.length; index++) {
    checkAbort(signal); const message = snapshot.messages[index]!, refs = imageRefs.get(message.id);
    if (!refs || message.id === latestImageId) continue;
    // Keep the exact text, identity, chronology and surrounding replay/tool pairs.
    delete message.attachments;
    provenance.push({ version: 1, sessionId: source.session.id, runId: message.runId, messageId: message.id, sourceOrdinal: index + 1,
      sourceContentSha256: hash(message.content), attachments: structuredClone(refs), pixels: 'unavailable-in-this-request',
      reason: refs.every(ref => retained.has(ref.id)) ? 'older-exact-reference' : 'host-reference-only-history', summarized: false, currentFileEvidence: false });
  }
  const requiredExchangeMessageIds = latestCompleteExchange(source.messages, options.activeRunId);
  const policySha256 = hash(JSON.stringify(policy));
  const sourceSha256 = hash(JSON.stringify(source.messages.map((message, index) => ({ messageId: message.id, runId: message.runId, sessionId: message.sessionId, ordinal: index + 1, contentSha256: hash(message.content), attachments: imageRefs.get(message.id) ?? [] }))));
  const requiredNotice: ProviderMessage | null = provenance.length ? { role: 'assistant', content: MEDIA_HISTORY_NOTICE_PREFIX + JSON.stringify({
    version: 1, observationKind: 'quoted-image-provenance', pixelScope: 'historical-message-occurrence',
    pixels: 'pixels unavailable in this request for the listed historical message occurrences; an identical reference may have pixels in a separately retained latest or host-pinned message',
    summarized: false, currentFileEvidence: false, permissionOrInstruction: false, sourceSha256, policySha256, omissions: provenance,
  }) } : null;
  const noticeBytes = requiredNotice ? entryBytes(requiredNotice) : 0;
  const metadataBytes = noticeBytes + Buffer.byteLength(JSON.stringify({ provenance, requiredTextMessageIds: [...requiredText], requiredExchangeMessageIds, policySha256, sourceSha256 }));
  if (metadataBytes > policy.maxMetadataBytes) fail('IMAGE_HISTORY_METADATA_LIMIT', 'Required image provenance and its model notice cannot fit the explicit metadata budget');
  checkAbort(signal);
  return { snapshot, requiredNotice, provenance, requiredTextMessageIds: [...requiredText], requiredExchangeMessageIds,
    diagnostics: { enabled: true, policySha256, sourceSha256, sourceImageOccurrences: sourceOccurrences, retainedImageOccurrences: retainedOccurrences,
      omittedImageOccurrences: sourceOccurrences - retainedOccurrences, retainedImageBytes: retainedBytes, uniqueRetainedImages: retained.size,
      metadataBytes, noticeBytes, metadataTokenEstimate: { tokens: noticeBytes, source: 'utf8-byte-upper-bound', estimated: true }, imageTokens: null, summarized: false, activeCutoffCreated: false } };
}
