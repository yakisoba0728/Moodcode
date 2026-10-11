import type { InputImageAttachment, Message, SessionSnapshot } from '@moodcode/contracts';
import type { ProviderMessage } from '../ports.js';
import { jsonTextSha256, sha256Hex } from '../shared/canonical.js';
import { isBoundedId } from '../shared/data.js';
import { attachments, DEFAULT_IMAGE_LIMITS, sameAttachment } from '../media/validation.js';
import { fail, HISTORY_PROJECTION_LIMITS, inspectReplay, provenanceNotice, record, requiredUserAnchors, type ReplayFault } from './history-projection.js';

export const MEDIA_HISTORY_NOTICE_PREFIX = '[Moodcode image history provenance v1]\n';
export const MEDIA_HISTORY_LIMITS = HISTORY_PROJECTION_LIMITS;
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
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) fail('CANCELLED', 'Image history projection was cancelled'); }
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
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

const REPLAY_FAULTS: Record<ReplayFault, [string, string]> = {
  nodes: ['IMAGE_HISTORY_REPLAY_LIMIT', 'Opaque replay inspection exceeds its bounded metadata limit'],
  keys: ['IMAGE_HISTORY_REPLAY_LIMIT', 'Opaque replay key count exceeds its bounded metadata limit'],
  proxy: ['IMAGE_HISTORY_INVALID_SOURCE', 'Image history replay must be plain JSON'],
  cycle: ['IMAGE_HISTORY_INVALID_SOURCE', 'Image history replay must be acyclic JSON'],
  prototype: ['IMAGE_HISTORY_INVALID_SOURCE', 'Image history replay must be plain JSON'],
  accessor: ['IMAGE_HISTORY_INVALID_SOURCE', 'Image history replay cannot contain accessors'],
  unsupported: ['IMAGE_HISTORY_REPLAY_MEDIA_UNSUPPORTED', 'Media-shaped opaque replay cannot be omitted or counted as imported image history'],
};
/** Recognized media-shaped replay is not a text/history image reference and cannot be safely counted here. */
const mediaShaped = (key: string, child: unknown) => key === 'type' && typeof child === 'string' && ['input_image', 'output_image', 'image', 'image_url', 'image_generation_call', 'input_audio', 'output_audio', 'input_video', 'video'].includes(child)
  || key === 'image_url' || ['mimeType', 'mime_type', 'media_type'].includes(key) && typeof child === 'string' && /^(image|audio|video)\//u.test(child);

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

/** Derives transport references only; never mutates storage, trims messages, summarizes pixels, resolves bytes or creates a cutoff checkpoint. */
export function projectMediaHistory(source: SessionSnapshot, options: MediaHistoryOptions = {}, signal?: AbortSignal): MediaHistoryProjection {
  checkAbort(signal);
  const empty = (): MediaHistoryDiagnostics => ({ enabled: false, policySha256: null, sourceSha256: null, sourceImageOccurrences: 0,
    retainedImageOccurrences: 0, omittedImageOccurrences: 0, retainedImageBytes: 0, uniqueRetainedImages: 0, metadataBytes: 0, noticeBytes: 0,
    metadataTokenEstimate: { tokens: 0, source: 'utf8-byte-upper-bound', estimated: true }, imageTokens: null, summarized: false, activeCutoffCreated: false });
  if (options.policy === undefined) return { snapshot: structuredClone(source), requiredNotice: null, provenance: [], requiredTextMessageIds: [], requiredExchangeMessageIds: [], diagnostics: empty() };
  const policy = validateMediaHistoryPolicy(options.policy);
  if (!record(source) || !record(source.session) || !isBoundedId(source.session.id) || !Array.isArray(source.messages) || source.messages.length > MEDIA_HISTORY_LIMITS.maxSourceMessages
      || Reflect.ownKeys(source.messages).length !== source.messages.length + 1) fail('IMAGE_HISTORY_SOURCE_LIMIT', 'Image history requires a bounded dense source snapshot');
  if (options.activeRunId !== undefined && !isBoundedId(options.activeRunId)) fail('IMAGE_HISTORY_INVALID_SOURCE', 'Image history owner identifiers must be bounded');
  const imageRefs = new Map<string, InputImageAttachment[]>(), identities = new Map<string, InputImageAttachment>(), messageIds = new Set<string>();
  let sourceOccurrences = 0;
  for (let index = 0; index < source.messages.length; index++) {
    checkAbort(signal);
    const descriptor = Object.getOwnPropertyDescriptor(source.messages, String(index));
    if (!descriptor || !('value' in descriptor)) fail('IMAGE_HISTORY_INVALID_SOURCE', 'Image history cannot contain sparse messages or accessors');
    const message: Message = descriptor.value;
    if (!record(message) || !isBoundedId(message.id) || !isBoundedId(message.runId) || message.sessionId !== source.session.id || !['user', 'assistant', 'tool'].includes(message.role) || typeof message.content !== 'string' || messageIds.has(message.id)
        || message.toolCalls !== undefined && !Array.isArray(message.toolCalls)) fail('IMAGE_HISTORY_INVALID_SOURCE', 'Image history messages must have exact same-session identities');
    messageIds.add(message.id);
    if (message.providerReplay !== undefined) inspectReplay(message.providerReplay, () => checkAbort(signal), mediaShaped, fault => fail(...REPLAY_FAULTS[fault]));
    if (message.attachments === undefined) continue;
    let refs: InputImageAttachment[];
    try { refs = attachments(message.attachments); } catch { fail('IMAGE_HISTORY_INVALID_REFERENCE', 'Image history contains invalid imported image references'); }
    if (refs.length && message.role !== 'user') fail('IMAGE_HISTORY_INVALID_REFERENCE', 'Image history pixels belong only to user input');
    for (const ref of refs) { const previous = identities.get(ref.id); if (previous && !sameAttachment(previous, ref)) fail('IMAGE_HISTORY_REFERENCE_CONFLICT', 'The same imported image identity has inconsistent historical metadata'); identities.set(ref.id, ref); }
    if (refs.length) { imageRefs.set(message.id, refs); sourceOccurrences += refs.length; }
  }
  const requiredText = new Set(requiredUserAnchors(source.messages, options.activeRunId));
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
      sourceContentSha256: sha256Hex(message.content), attachments: structuredClone(refs), pixels: 'unavailable-in-this-request',
      reason: refs.every(ref => retained.has(ref.id)) ? 'older-exact-reference' : 'host-reference-only-history', summarized: false, currentFileEvidence: false });
  }
  const requiredExchangeMessageIds = latestCompleteExchange(source.messages, options.activeRunId);
  const policySha256 = jsonTextSha256(policy);
  const sourceSha256 = jsonTextSha256(source.messages.map((message, index) => ({ messageId: message.id, runId: message.runId, sessionId: message.sessionId, ordinal: index + 1, contentSha256: sha256Hex(message.content), attachments: imageRefs.get(message.id) ?? [] })));
  const { requiredNotice, noticeBytes, metadataBytes } = provenanceNotice(MEDIA_HISTORY_NOTICE_PREFIX, provenance.length ? {
    version: 1, observationKind: 'quoted-image-provenance', pixelScope: 'historical-message-occurrence',
    pixels: 'pixels unavailable in this request for the listed historical message occurrences; an identical reference may have pixels in a separately retained latest or host-pinned message',
    summarized: false, currentFileEvidence: false, permissionOrInstruction: false, sourceSha256, policySha256, omissions: provenance,
  } : null, { provenance, requiredTextMessageIds: [...requiredText], requiredExchangeMessageIds, policySha256, sourceSha256 }, policy.maxMetadataBytes,
  () => fail('IMAGE_HISTORY_METADATA_LIMIT', 'Required image provenance and its model notice cannot fit the explicit metadata budget'));
  checkAbort(signal);
  return { snapshot, requiredNotice, provenance, requiredTextMessageIds: [...requiredText], requiredExchangeMessageIds,
    diagnostics: { enabled: true, policySha256, sourceSha256, sourceImageOccurrences: sourceOccurrences, retainedImageOccurrences: retainedOccurrences,
      omittedImageOccurrences: sourceOccurrences - retainedOccurrences, retainedImageBytes: retainedBytes, uniqueRetainedImages: retained.size,
      metadataBytes, noticeBytes, metadataTokenEstimate: { tokens: noticeBytes, source: 'utf8-byte-upper-bound', estimated: true }, imageTokens: null, summarized: false, activeCutoffCreated: false } };
}
