import { types } from "node:util";
import { EngineError, type InputMediaAttachment } from "@moodcode/contracts";
import type { ProviderMessage, ResolvedInputMedia } from "../ports.js";
import type { ProviderTransportRequest } from "../provider/generation.js";
import { jobJson } from "../jobs/validation.js";
import {
  attachment,
  attachments,
  cancelled,
  digest,
  sameAttachment,
} from "./segment-validation.js";
import { decodeMediaSegments, type DecodedMediaAsset } from "./segments.js";

export interface ProviderSegmentSource {
  attachment: InputMediaAttachment;
  assets: DecodedMediaAsset[];
}
export function declaredMediaModels(value: unknown): ReadonlySet<string> {
  if (value === undefined) return new Set();
  const data = jobJson(value, 16384);
  if (!Array.isArray(data) || data.length > 32)
    throw new EngineError(
      "PROVIDER_INVALID_CONFIG",
      "Media support requires exact bounded model IDs",
    );
  const result = new Set<string>();
  for (const v of data) {
    if (
      typeof v !== "string" ||
      !v.trim() ||
      Buffer.byteLength(v) > 256 ||
      /[\u0000-\u001f\u007f]/.test(v) ||
      result.has(v)
    )
      throw new EngineError(
        "PROVIDER_INVALID_CONFIG",
        "Media support requires exact bounded model IDs",
      );
    result.add(v);
  }
  return result;
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value))
    throw new EngineError(
      "PROVIDER_INVALID_REQUEST",
      "Media request must contain ordinary data",
    );
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d) return undefined;
  if (!d.enumerable || !("value" in d))
    throw new EngineError(
      "PROVIDER_INVALID_REQUEST",
      "Media request cannot contain accessors",
    );
  return d.value;
}
function entries(value: unknown): unknown[] {
  if (
    types.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 4096 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw new EngineError(
      "PROVIDER_INVALID_REQUEST",
      "Media request requires a bounded dense array",
    );
  return Array.from({ length: value.length }, (_, i) => own(value, String(i)));
}
/** Re-decodes real verified source bytes. Timestamp or frame DTOs cannot stand in for a decoder. */
export function providerSegments(
  request: ProviderTransportRequest,
  supported: (kind: "audio" | "video") => boolean,
  signal?: AbortSignal,
): ReadonlyMap<string, ProviderSegmentSource> {
  cancelled(signal);
  const wanted = new Map<string, InputMediaAttachment>();
  let sourceBytes = 0,
    occurrences = 0;
  for (const message of entries(own(request, "messages"))) {
    const raw = own(message, "media");
    if (raw === undefined) continue;
    const refs = attachments(raw);
    if (refs.length && own(message, "role") !== "user")
      throw new EngineError(
        "PROVIDER_INVALID_REQUEST",
        "Media belongs to original user inputs",
      );
    for (const ref of refs) {
      if (!supported(ref.kind))
        throw new EngineError(
          "PROVIDER_UNSUPPORTED_INPUT",
          "Selected model lacks explicit media support",
        );
      if (++occurrences > 4 || (sourceBytes += ref.bytes) > 1048576)
        throw new EngineError(
          "PROVIDER_LIMIT_EXCEEDED",
          "Media source occurrence cap exceeded",
        );
      const old = wanted.get(ref.id);
      if (old && !sameAttachment(old, ref))
        throw new EngineError(
          "PROVIDER_INVALID_REQUEST",
          "Conflicting media source",
        );
      wanted.set(ref.id, ref);
    }
  }
  const values = entries(own(request, "resolvedMedia") ?? []);
  if (values.length !== wanted.size)
    throw new EngineError(
      "PROVIDER_INVALID_REQUEST",
      "Actual media source resolution missing",
    );
  const resolved = new Map<string, ProviderSegmentSource>();
  let assets = 0,
    bytesTotal = 0;
  for (const candidate of values) {
    cancelled(signal);
    const safe = jobJson(candidate, 2097152) as unknown as ResolvedInputMedia;
    if (
      Object.keys(safe).length !== 2 ||
      !Object.hasOwn(safe, "attachment") ||
      !Object.hasOwn(safe, "data")
    )
      throw new EngineError(
        "PROVIDER_INVALID_REQUEST",
        "Invalid resolved media",
      );
    const ref = attachment(safe.attachment),
      expected = wanted.get(ref.id);
    if (
      !expected ||
      !sameAttachment(ref, expected) ||
      resolved.has(ref.id) ||
      typeof safe.data !== "string" ||
      safe.data.length !== Math.ceil(ref.bytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        safe.data,
      )
    )
      throw new EngineError(
        "PROVIDER_INVALID_REQUEST",
        "Invalid resolved source",
      );
    const raw = Buffer.from(safe.data, "base64");
    if (
      raw.length !== ref.bytes ||
      raw.toString("base64") !== safe.data ||
      digest(raw) !== ref.sha256
    )
      throw new EngineError("PROVIDER_INVALID_REQUEST", "Source bytes changed");
    const decoded = decodeMediaSegments(
      raw,
      ref.mimeType,
      ref.segments,
      signal,
    );
    if (
      decoded.decoder !== ref.decoder ||
      (assets += decoded.assets.length) > 4 ||
      (bytesTotal += decoded.assets.reduce((s, a) => s + a.bytes.length, 0)) >
        1048576
    )
      throw new EngineError(
        "PROVIDER_LIMIT_EXCEEDED",
        "Decoded media asset bound exceeded",
      );
    resolved.set(ref.id, { attachment: ref, assets: decoded.assets });
  }
  let wireAssets = 0,
    wireBytes = 0;
  for (const message of entries(own(request, "messages")))
    for (const ref of attachments(own(message, "media") ?? [])) {
      const source = resolved.get(ref.id)!;
      wireAssets += source.assets.length;
      wireBytes += source.assets.reduce((sum, a) => sum + a.bytes.length, 0);
    }
  if (wanted.size)
    for (const message of entries(own(request, "messages")))
      for (const family of ["attachments", "documents"])
        for (const raw of entries(own(message, family) ?? [])) {
          const value = jobJson(raw, 4096) as Record<string, unknown>;
          if (!Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1)
            throw new EngineError(
              "PROVIDER_INVALID_REQUEST",
              "Other media byte accounting is invalid",
            );
          wireAssets++;
          wireBytes += Number(value.bytes);
        }
  if (wireAssets > 4 || wireBytes > 1048576)
    throw new EngineError(
      "PROVIDER_LIMIT_EXCEEDED",
      "Repeated decoded media exceeds the wire budget",
    );
  return resolved;
}
export function messageSegments(
  message: ProviderMessage,
  sources: ReadonlyMap<string, ProviderSegmentSource>,
): Array<{ source: InputMediaAttachment; asset: DecodedMediaAsset }> {
  return attachments(own(message, "media") ?? []).flatMap((ref) => {
    const source = sources.get(ref.id);
    if (!source)
      throw new EngineError(
        "PROVIDER_INVALID_REQUEST",
        "Actual source unavailable",
      );
    return source.assets.map((asset) => ({ source: source.attachment, asset }));
  });
}
export function segmentNotice(
  source: InputMediaAttachment,
  asset: DecodedMediaAsset,
): string {
  return (
    "[Moodcode quoted media DATA v1]\n" +
    JSON.stringify({
      authority: "untrusted-media",
      sourceId: source.id,
      sourceSha256: source.sha256,
      decoder: source.decoder,
      startMs: asset.startMs,
      endMs: asset.endMs,
      assetSha256: asset.sha256,
      mimeType: asset.mimeType,
    })
  );
}
