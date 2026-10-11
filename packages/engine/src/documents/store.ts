import type { InputDocumentAttachment } from '@moodcode/contracts';
import type { ResolvedInputDocument } from '../ports.js';
import { SessionBlobStore, type SessionBlobDocuments, type SessionBlobKind } from '../storage/session-blob-store.js';
import { attachment, attachments, cancelled, digest, fail, documentLimits, sameAttachment, validateDocumentBytes, type DocumentLimits } from './validation.js';

export const INPUT_DOCUMENT_KIND = 'input_documents';
export type DocumentDocuments = SessionBlobDocuments;
export interface DocumentAttachmentStoreOptions { directory: string; documents: DocumentDocuments; limits?: Partial<DocumentLimits> }
const DOCUMENTS: SessionBlobKind<InputDocumentAttachment, DocumentLimits> = {
  code: 'DOCUMENT', message: 'Document input operation failed.', documentKind: INPUT_DOCUMENT_KIND, indexKey: 'documents', idPrefix: 'doc_',
  fail, cancelled, limits: documentLimits, item: attachment, refs: attachments, same: sameAttachment,
  bounds: limits => ({ maxBlobBytes: limits.maxDocumentBytes, maxSessionItems: limits.maxSessionDocuments, maxSessionBytes: limits.maxSessionBytes }),
  validate: (bytes, ref, limits) => validateDocumentBytes(bytes, ref.mimeType, limits),
};

/** Immutable local PDF blobs; refs become visible only after a successful session-document CAS. */
export class DocumentAttachmentStore {
  readonly limits: Readonly<DocumentLimits>;
  readonly #blobs: SessionBlobStore<InputDocumentAttachment, DocumentLimits>;
  constructor(options: DocumentAttachmentStoreOptions) { this.#blobs = new SessionBlobStore(options, DOCUMENTS); this.limits = this.#blobs.limits; }
  import(sessionId: string, data: Uint8Array, signal?: AbortSignal): Promise<InputDocumentAttachment> {
    return this.#blobs.import(sessionId, data, signal, bytes => {
      validateDocumentBytes(bytes, 'application/pdf', this.limits);
      return id => ({ id, kind: 'document', mimeType: 'application/pdf', bytes: bytes.byteLength, sha256: digest(bytes) });
    });
  }
  resolve(sessionId: string, input: readonly InputDocumentAttachment[], signal?: AbortSignal): Promise<ResolvedInputDocument[]> {
    return this.#blobs.resolve(sessionId, input, signal);
  }
}
