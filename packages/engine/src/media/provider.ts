import { EngineError, type InputImageAttachment } from '@moodcode/contracts';
import type { ProviderMessage, ResolvedInputImage } from '../ports.js';
import type { ProviderTransportRequest } from '../provider/generation.js';
import { attachment, attachments, DEFAULT_IMAGE_LIMITS, digest, sameAttachment, validateImageBytes } from './validation.js';

/** Transport-only projection. The engine must verify session ownership before supplying bytes. */
export function providerImages(request: ProviderTransportRequest, supported: boolean, signal?: AbortSignal): ReadonlyMap<string, ResolvedInputImage> {
  const cancelled = () => { if (signal?.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.'); };
  cancelled();
  const invalid = () => { throw new EngineError('PROVIDER_INVALID_REQUEST', 'Provider image input is invalid.'); };
  const wanted = new Map<string, InputImageAttachment>(); let occurrences = 0, total = 0;
  try {
    for (const message of request.messages) {
      if (message.attachments === undefined) continue;
      if (!Array.isArray(message.attachments)) invalid();
      if (message.attachments.length && message.role !== 'user') invalid();
      for (const value of attachments(message.attachments)) {
        if (++occurrences > DEFAULT_IMAGE_LIMITS.maxInputImages) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider image input exceeds the configured bound.');
        const ref = attachment(value); const old = wanted.get(ref.id);
        if (old && !sameAttachment(old, ref)) invalid(); wanted.set(ref.id, ref); total += ref.bytes;
        if (total > DEFAULT_IMAGE_LIMITS.maxInputBytes) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider image input exceeds the configured bound.');
      }
    }
    if (!supported && (wanted.size || request.resolvedImages?.length)) throw new EngineError('PROVIDER_UNSUPPORTED_INPUT', 'Provider does not support image input.');
    if (!wanted.size && (request.resolvedImages === undefined || Array.isArray(request.resolvedImages) && request.resolvedImages.length === 0)) return new Map();
    if (!Array.isArray(request.resolvedImages) || request.resolvedImages.length !== wanted.size || typeof request.sessionId !== 'string' || !request.sessionId) invalid();
    const resolved = new Map<string, ResolvedInputImage>();
    for (const image of request.resolvedImages!) {
      cancelled();
      if (!image || typeof image !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(image)) || Reflect.ownKeys(image).length !== 2
        || !Object.getOwnPropertyDescriptor(image, 'attachment') || !('value' in Object.getOwnPropertyDescriptor(image, 'attachment')!)
        || !Object.getOwnPropertyDescriptor(image, 'data') || !('value' in Object.getOwnPropertyDescriptor(image, 'data')!)) invalid();
      const ref = attachment(image.attachment), expected = wanted.get(ref.id);
      if (!expected || !sameAttachment(ref, expected) || resolved.has(ref.id) || typeof image.data !== 'string'
        || image.data.length !== Math.ceil(ref.bytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(image.data)) invalid();
      const bytes = Buffer.from(image.data, 'base64');
      if (bytes.length !== ref.bytes || bytes.toString('base64') !== image.data || digest(bytes) !== ref.sha256) invalid();
      validateImageBytes(bytes, ref.mimeType);
      resolved.set(ref.id, { attachment: ref, data: image.data });
    }
    return resolved;
  } catch (error) {
    if (error instanceof EngineError && ['PROVIDER_UNSUPPORTED_INPUT', 'PROVIDER_LIMIT_EXCEEDED'].includes(error.code)) throw error;
    if (error instanceof EngineError && error.code === 'IMAGE_LIMIT_EXCEEDED') throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider image input exceeds the configured bound.');
    if (signal?.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.');
    throw new EngineError('PROVIDER_INVALID_REQUEST', 'Provider image input is invalid.');
  }
}
export function messageImages(message: ProviderMessage, images: ReadonlyMap<string, ResolvedInputImage>): ResolvedInputImage[] {
  return (message.attachments ?? []).map(ref => images.get(ref.id)!);
}
