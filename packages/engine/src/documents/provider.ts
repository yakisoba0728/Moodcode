import { types } from 'node:util';
import { EngineError, type InputDocumentAttachment } from '@moodcode/contracts';
import type { ProviderMessage, ResolvedInputDocument, ResolvedInputImage } from '../ports.js';
import type { ProviderTransportRequest } from '../provider/generation.js';
import { providerImages } from '../media/provider.js';
import { attachments as imageAttachments, DEFAULT_IMAGE_LIMITS } from '../media/validation.js';
import { isPlainArray } from '../shared/data.js';
import { attachments as documentAttachments, DEFAULT_DOCUMENT_LIMITS, digest, sameAttachment, validateDocumentBytes } from './validation.js';

const MAX_DOCUMENT_BYTES = DEFAULT_DOCUMENT_LIMITS.maxDocumentBytes;
const MAX_DOCUMENT_OCCURRENCES = DEFAULT_DOCUMENT_LIMITS.maxInputDocuments;
function invalid(): never { throw new EngineError('PROVIDER_INVALID_REQUEST', 'Provider document input is invalid.'); }
function limited(): never { throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider input media exceeds its configured bound.'); }
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.'); }

function ownValue(value: object, key: string): unknown {
  if (types.isProxy(value)) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) invalid();
  return descriptor.value;
}
/** Ref presence only; never reads resolved bytes or invokes attachment getters. */
export function hasDocumentInputs(request: ProviderTransportRequest): boolean {
  const messages = ownValue(request, 'messages');
  if (!Array.isArray(messages) || types.isProxy(messages)) invalid();
  for (const message of messages) {
    if (!message || typeof message !== 'object') invalid();
    const refs = ownValue(message, 'documents');
    if (refs !== undefined && (!Array.isArray(refs) || types.isProxy(refs))) invalid();
    if (Array.isArray(refs) && refs.length) return true;
  }
  const resolved = ownValue(request, 'resolvedDocuments');
  if (resolved !== undefined && (!Array.isArray(resolved) || types.isProxy(resolved))) invalid();
  return Array.isArray(resolved) && resolved.length > 0;
}

/** Transport projection only. Session/workspace ownership must be checked by the host resolver. */
export function providerDocuments(request: ProviderTransportRequest, supported: boolean, signal?: AbortSignal,
  validatedImages?: ReadonlyMap<string, ResolvedInputImage>): ReadonlyMap<string, ResolvedInputDocument> {
  cancelled(signal);
  try {
    const wanted = new Map<string, InputDocumentAttachment>();
    let total = 0, occurrences = 0;
    if (types.isProxy(request) || !Array.isArray(request.messages) || types.isProxy(request.messages)) invalid();
    for (const message of request.messages) {
      if (!message || typeof message !== 'object') invalid();
      const value = ownValue(message, 'documents');
      if (value === undefined) continue;
      if (!Array.isArray(value) || types.isProxy(value)) invalid();
      if (value.length && message.role !== 'user') invalid();
      if (value.length > MAX_DOCUMENT_OCCURRENCES) limited();
      for (let index = 0; index < value.length; index++) {
        const ref = ownValue(value, String(index));
        if (!ref || typeof ref !== 'object' || types.isProxy(ref)) invalid();
      }
      for (const ref of documentAttachments(value)) {
        if (++occurrences > MAX_DOCUMENT_OCCURRENCES || ref.bytes > MAX_DOCUMENT_BYTES) limited();
        const old = wanted.get(ref.id); if (old && !sameAttachment(old, ref)) invalid();
        wanted.set(ref.id, ref); total += ref.bytes;
      }
    }
    const supplied = ownValue(request, 'resolvedDocuments');
    if (supplied !== undefined && !isPlainArray(supplied)) invalid();
    if (!supported && (wanted.size || Array.isArray(supplied) && supplied.length)) {
      throw new EngineError('PROVIDER_UNSUPPORTED_INPUT', 'Provider/model does not support PDF document input.');
    }
    if (!wanted.size) {
      if (supplied === undefined || Array.isArray(supplied) && !supplied.length) return new Map();
      invalid();
    }
    // Images are decoded once by adapters that already validated them. Direct
    // callers still receive the same image boundary before sharing the byte cap.
    if (!validatedImages) providerImages(request, true, signal);
    for (const message of request.messages) for (const image of imageAttachments(message.attachments ?? [])) {
      total += image.bytes;
      if (total > DEFAULT_IMAGE_LIMITS.maxInputBytes) limited();
    }
    if (total > DEFAULT_IMAGE_LIMITS.maxInputBytes) limited();
    if (!Array.isArray(supplied) || supplied.length !== wanted.size || typeof request.sessionId !== 'string' || !request.sessionId) invalid();
    const result = new Map<string, ResolvedInputDocument>();
    for (let index = 0; index < supplied.length; index++) {
      cancelled(signal);
      const item = ownValue(supplied, String(index));
      if (!item || typeof item !== 'object' || types.isProxy(item) || Array.isArray(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))
        || Reflect.ownKeys(item).length !== 2) invalid();
      const rawRef = ownValue(item, 'attachment');
      if (!rawRef || typeof rawRef !== 'object' || types.isProxy(rawRef)) invalid();
      const refs = documentAttachments([rawRef]);
      const ref = refs[0]!;
      const data = ownValue(item, 'data'), expected = wanted.get(ref.id);
      if (!expected || !sameAttachment(ref, expected) || result.has(ref.id) || typeof data !== 'string'
        || data.length !== Math.ceil(ref.bytes / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) invalid();
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length !== ref.bytes || bytes.toString('base64') !== data || digest(bytes) !== ref.sha256) invalid();
      validateDocumentBytes(bytes, ref.mimeType);
      result.set(ref.id, { attachment: ref, data });
    }
    return result;
  } catch (error) {
    if (signal?.aborted) cancelled(signal);
    if (error instanceof EngineError && ['PROVIDER_LIMIT_EXCEEDED', 'PROVIDER_UNSUPPORTED_INPUT', 'PROVIDER_CANCELLED'].includes(error.code)) throw error;
    if (error instanceof EngineError && ['DOCUMENT_LIMIT_EXCEEDED', 'IMAGE_LIMIT_EXCEEDED'].includes(error.code)) limited();
    invalid();
  }
}

export function messageDocuments(message: ProviderMessage, documents: ReadonlyMap<string, ResolvedInputDocument>): ResolvedInputDocument[] {
  return (message.documents ?? []).map(ref => documents.get(ref.id)!);
}
