import { EngineError, type InputMediaAttachment } from "@moodcode/contracts";
import { normalizeMediaAttachments } from "@moodcode/contracts/validation";
import { jobJson } from "../jobs/validation.js";
import { decodeMediaSegments, segmentHash } from "./segments.js";
export const DEFAULT_SEGMENT_LIMITS = Object.freeze({
  maxImageBytes: 524288,
  maxInputImages: 4,
  maxInputBytes: 1048576,
  maxSessionImages: 32,
  maxSessionBytes: 16777216,
});
export const digest = segmentHash;
export function fail(code: string): never {
  throw new EngineError(code, "Local media source operation failed");
}
export function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail("MEDIA_CANCELLED");
}
export function attachment(value: unknown): InputMediaAttachment {
  return normalizeMediaAttachments(jobJson([value], 16384))[0]!;
}
export function attachments(value: unknown): InputMediaAttachment[] {
  return normalizeMediaAttachments(jobJson(value, 65536));
}
export function sameAttachment(
  a: InputMediaAttachment,
  b: InputMediaAttachment,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function validateMediaBytes(
  bytes: Uint8Array,
  mime: InputMediaAttachment["mimeType"],
  segments: readonly import("@moodcode/contracts").InputMediaSegment[],
): void {
  decodeMediaSegments(bytes, mime, segments);
}
