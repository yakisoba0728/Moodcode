import type { InputImageAttachment } from '@moodcode/contracts';
import type { ResolvedInputImage } from '../ports.js';
import { SessionBlobStore, type SessionBlobDocuments, type SessionBlobKind } from '../storage/session-blob-store.js';
import { attachment, attachments, cancelled, digest, fail, imageLimits, sameAttachment, validateImageBytes, type ImageLimits } from './validation.js';

export const IMAGE_DOCUMENT_KIND = 'input_images';
export type ImageDocuments = SessionBlobDocuments;
export interface ImageAttachmentStoreOptions { directory: string; documents: ImageDocuments; limits?: Partial<ImageLimits> }
const IMAGES: SessionBlobKind<InputImageAttachment, ImageLimits> = {
  code: 'IMAGE', message: 'Image input operation failed.', documentKind: IMAGE_DOCUMENT_KIND, indexKey: 'attachments', idPrefix: 'img_',
  fail, cancelled, limits: imageLimits, item: attachment, refs: attachments, same: sameAttachment,
  bounds: limits => ({ maxBlobBytes: limits.maxImageBytes, maxSessionItems: limits.maxSessionImages, maxSessionBytes: limits.maxSessionBytes }),
  validate: (bytes, ref, limits) => validateImageBytes(bytes, ref.mimeType, limits),
};

/** Immutable local image blobs; refs become visible only after a successful session-document CAS. */
export class ImageAttachmentStore {
  readonly limits: Readonly<ImageLimits>;
  readonly #blobs: SessionBlobStore<InputImageAttachment, ImageLimits>;
  constructor(options: ImageAttachmentStoreOptions) { this.#blobs = new SessionBlobStore(options, IMAGES); this.limits = this.#blobs.limits; }
  import(sessionId: string, data: Uint8Array, mimeType: InputImageAttachment['mimeType'], signal?: AbortSignal): Promise<InputImageAttachment> {
    return this.#blobs.import(sessionId, data, signal, bytes => {
      validateImageBytes(bytes, mimeType, this.limits);
      return id => ({ id, kind: 'image', mimeType, bytes: bytes.byteLength, sha256: digest(bytes) });
    });
  }
  resolve(sessionId: string, input: readonly InputImageAttachment[], signal?: AbortSignal): Promise<ResolvedInputImage[]> {
    return this.#blobs.resolve(sessionId, input, signal);
  }
}
