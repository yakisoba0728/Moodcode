import type {
  InputMediaAttachment,
  InputMediaSegment,
} from "@moodcode/contracts";
import type { ResolvedInputMedia } from "../ports.js";
import {
  SessionBlobStore,
  type SessionBlobDocuments,
  type SessionBlobKind,
} from "../storage/session-blob-store.js";
import {
  attachment,
  attachments,
  cancelled,
  fail,
  sameAttachment,
} from "./segment-validation.js";
import {
  decodeMediaSegments,
  SEGMENT_LIMITS,
  segmentHash,
} from "./segments.js";

export const SEGMENT_DOCUMENT_KIND = "input_media_segments";
interface MediaSegmentStoreOptions {
  directory: string;
  documents: SessionBlobDocuments;
}
const SEGMENTS: SessionBlobKind<InputMediaAttachment, typeof SEGMENT_LIMITS> = {
  code: "MEDIA",
  message: "Local media input operation failed.",
  documentKind: SEGMENT_DOCUMENT_KIND,
  indexKey: "attachments",
  idPrefix: "med_",
  fail,
  cancelled,
  limits: () => SEGMENT_LIMITS,
  bounds: (limits) => ({
    maxBlobBytes: limits.sourceBytes,
    maxSessionItems: limits.sessionSources,
    maxSessionBytes: limits.sessionBytes,
  }),
  item: attachment,
  refs: attachments,
  same: sameAttachment,
  validate: (bytes, ref) =>
    decodeMediaSegments(bytes, ref.mimeType, ref.segments),
};

/** Immutable local media blobs; refs become visible only after a successful session-document CAS. */
export class MediaSegmentStore {
  readonly limits: typeof SEGMENT_LIMITS;
  readonly #blobs: SessionBlobStore<
    InputMediaAttachment,
    typeof SEGMENT_LIMITS
  >;
  constructor(options: MediaSegmentStoreOptions) {
    this.#blobs = new SessionBlobStore(options, SEGMENTS);
    this.limits = this.#blobs.limits;
  }
  import(
    sessionId: string,
    data: Uint8Array,
    mimeType: InputMediaAttachment["mimeType"],
    segments: readonly InputMediaSegment[],
    signal?: AbortSignal,
  ): Promise<InputMediaAttachment> {
    return this.#blobs.import(sessionId, data, signal, (bytes) => {
      const draft = (id: string) =>
        attachment({
          id,
          kind: mimeType === "audio/wav" ? "audio" : "video",
          mimeType,
          bytes: bytes.length,
          sha256: segmentHash(bytes),
          decoder: mimeType === "audio/wav" ? "wav-pcm16-v1" : "avi-rgb24-v1",
          segments,
        });
      segments = draft("med_" + "0".repeat(32)).segments;
      decodeMediaSegments(bytes, mimeType, segments);
      return draft;
    });
  }
  resolve(
    sessionId: string,
    input: readonly InputMediaAttachment[],
    signal?: AbortSignal,
  ): Promise<ResolvedInputMedia[]> {
    return this.#blobs.resolve(sessionId, input, signal);
  }
}
