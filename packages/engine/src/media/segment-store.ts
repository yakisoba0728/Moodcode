import type { InputMediaAttachment } from "@moodcode/contracts";
import {
  SessionBlobStore,
  type SessionBlobDocuments,
  type SessionBlobKind,
} from "../storage/session-blob-store.js";
export interface ResolvedInputMediaSource {
  attachment: InputMediaAttachment;
  data: string;
}
import {
  attachment,
  attachments,
  cancelled,
  digest,
  fail,
  DEFAULT_SEGMENT_LIMITS,
  sameAttachment,
  validateMediaBytes,
} from "./segment-validation.js";

export const SEGMENT_DOCUMENT_KIND = "input_media_segments";
interface MediaSegmentStoreOptions {
  directory: string;
  documents: SessionBlobDocuments;
  limits?: never;
}
const SEGMENTS: SessionBlobKind<
  InputMediaAttachment,
  typeof DEFAULT_SEGMENT_LIMITS
> = {
  code: "MEDIA",
  message: "Local media input operation failed.",
  documentKind: SEGMENT_DOCUMENT_KIND,
  indexKey: "attachments",
  idPrefix: "med_",
  fail,
  cancelled,
  limits: () => DEFAULT_SEGMENT_LIMITS,
  bounds: (limits) => ({
    maxBlobBytes: limits.maxImageBytes,
    maxSessionItems: limits.maxSessionImages,
    maxSessionBytes: limits.maxSessionBytes,
  }),
  item: attachment,
  refs: attachments,
  same: sameAttachment,
  validate: (bytes, ref) => validateMediaBytes(bytes, ref.mimeType, ref.segments),
};

/** Immutable local media blobs; refs become visible only after a successful session-document CAS. */
export class MediaSegmentStore {
  readonly limits: Readonly<typeof DEFAULT_SEGMENT_LIMITS>;
  readonly #blobs: SessionBlobStore<
    InputMediaAttachment,
    typeof DEFAULT_SEGMENT_LIMITS
  >;
  constructor(options: MediaSegmentStoreOptions) {
    this.#blobs = new SessionBlobStore(options, SEGMENTS);
    this.limits = this.#blobs.limits;
  }
  import(
    sessionId: string,
    data: Uint8Array,
    mimeType: InputMediaAttachment["mimeType"],
    segments: readonly import("@moodcode/contracts").InputMediaSegment[],
    signal?: AbortSignal,
  ): Promise<InputMediaAttachment> {
    return this.#blobs.import(sessionId, data, signal, (bytes) => {
      const draft = (id: string) =>
        attachment({
          id,
          kind: mimeType === "audio/wav" ? "audio" : "video",
          mimeType,
          bytes: bytes.length,
          sha256: digest(bytes),
          decoder: mimeType === "audio/wav" ? "wav-pcm16-v1" : "avi-rgb24-v1",
          segments,
        });
      segments = draft("med_" + "0".repeat(32)).segments;
      validateMediaBytes(bytes, mimeType, segments);
      return draft;
    });
  }
  resolve(
    sessionId: string,
    input: readonly InputMediaAttachment[],
    signal?: AbortSignal,
  ): Promise<ResolvedInputMediaSource[]> {
    return this.#blobs.resolve(sessionId, input, signal);
  }
}
