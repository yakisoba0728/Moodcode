import { EngineError, type InputMediaAttachment } from "@moodcode/contracts";
import { normalizeMediaAttachments } from "@moodcode/contracts/validation";
import { jobJson } from "../jobs/validation.js";
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
