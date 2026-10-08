import { types } from "node:util";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { jobJson } from "../jobs/validation.js";
import {
  EngineError,
  type InputMediaAttachment,
  type InputMediaSegment,
} from "@moodcode/contracts";

export const SEGMENT_LIMITS = Object.freeze({
  sourceBytes: 524288,
  totalBytes: 1048576,
  assets: 4,
  sourceFrames: 32,
  chunks: 256,
  durationMs: 30000,
  width: 256,
  height: 256,
});
export interface DecodedMediaAsset {
  kind: "audio" | "image";
  mimeType: "audio/wav" | "image/png";
  startMs: number;
  endMs: number;
  bytes: Buffer;
  sha256: string;
}
export interface DecodedMedia {
  decoder: InputMediaAttachment["decoder"];
  durationMs: number;
  assets: DecodedMediaAsset[];
}
export const segmentHash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
function fail(code = "MEDIA_INVALID_SOURCE"): never {
  throw new EngineError(
    code,
    "Local media source or bounded selection is invalid or unsupported",
  );
}
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) fail("MEDIA_CANCELLED");
}
interface Chunk {
  id: string;
  at: number;
  end: number;
}
function chunks(bytes: Buffer, start: number, end: number): Chunk[] {
  const result: Chunk[] = [];
  for (let at = start; at < end;) {
    if (at + 8 > end || result.length >= SEGMENT_LIMITS.chunks) fail();
    const size = bytes.readUInt32LE(at + 4),
      finish = at + 8 + size,
      next = finish + (size & 1);
    if (finish > end || next > end || next <= at) fail();
    result.push({
      id: bytes.toString("ascii", at, at + 4),
      at: at + 8,
      end: finish,
    });
    at = next;
  }
  return result;
}
function riff(bytes: Uint8Array, type: string): Buffer {
  if (
    types.isProxy(bytes) ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 12 ||
    bytes.byteLength > SEGMENT_LIMITS.sourceBytes
  )
    fail("MEDIA_LIMIT_EXCEEDED");
  const b = Buffer.from(bytes);
  if (
    b.toString("ascii", 0, 4) !== "RIFF" ||
    b.toString("ascii", 8, 12) !== type ||
    b.readUInt32LE(4) + 8 !== b.length
  )
    fail();
  return b;
}
function one(values: Chunk[], id: string): Chunk {
  const found = values.filter((c) => c.id === id);
  if (found.length !== 1) fail();
  return found[0]!;
}
export interface PcmWave {
  samples: Buffer;
  sampleRate: number;
  channels: number;
  durationMs: number;
}
/** PCM samples are decoded by their real RIFF fmt/data layout; compressed formats never become PCM. */
export function decodePcmWave(bytes: Uint8Array): PcmWave {
  const b = riff(bytes, "WAVE"),
    all = chunks(b, 12, b.length),
    fmt = one(all, "fmt "),
    data = one(all, "data");
  if (![16, 18].includes(fmt.end - fmt.at) || b.readUInt16LE(fmt.at) !== 1)
    fail("MEDIA_CODEC_UNSUPPORTED");
  const channels = b.readUInt16LE(fmt.at + 2),
    sampleRate = b.readUInt32LE(fmt.at + 4),
    align = b.readUInt16LE(fmt.at + 12);
  if (
    ![1, 2].includes(channels) ||
    ![8000, 16000, 24000, 48000].includes(sampleRate) ||
    b.readUInt16LE(fmt.at + 14) !== 16 ||
    align !== channels * 2 ||
    b.readUInt32LE(fmt.at + 8) !== sampleRate * align ||
    (fmt.end - fmt.at === 18 && b.readUInt16LE(fmt.at + 16) !== 0) ||
    data.end <= data.at ||
    (data.end - data.at) % align
  )
    fail("MEDIA_CODEC_UNSUPPORTED");
  const durationMs = ((data.end - data.at) * 1000) / (sampleRate * align);
  if (durationMs > SEGMENT_LIMITS.durationMs) fail("MEDIA_LIMIT_EXCEEDED");
  return {
    samples: Buffer.from(b.subarray(data.at, data.end)),
    sampleRate,
    channels,
    durationMs,
  };
}
export function encodePcmWave(
  samples: Uint8Array,
  sampleRate = 24000,
  channels = 1,
): Buffer {
  if (
    types.isProxy(samples) ||
    !(samples instanceof Uint8Array) ||
    ![8000, 16000, 24000, 48000].includes(sampleRate) ||
    ![1, 2].includes(channels) ||
    samples.byteLength < 2 ||
    samples.byteLength % (channels * 2) ||
    samples.byteLength + 44 > SEGMENT_LIMITS.sourceBytes
  )
    fail("MEDIA_LIMIT_EXCEEDED");
  const b = Buffer.alloc(44 + samples.byteLength);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples.byteLength, 40);
  b.set(samples, 44);
  return b;
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, bytes: Buffer): Buffer {
  const chunk = Buffer.alloc(bytes.length + 12);
  chunk.writeUInt32BE(bytes.length);
  chunk.write(type, 4);
  bytes.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(chunk.subarray(4, chunk.length - 4)),
    chunk.length - 4,
  );
  return chunk;
}
/** Exact RGB pixels are encoded as PNG with lossless deflate and CRCs. No raw video bytes are labeled as frames. */
function pngRgb(
  width: number,
  height: number,
  dib: Buffer,
  bottomUp: boolean,
): Buffer {
  const stride = Math.ceil((width * 3) / 4) * 4;
  if (dib.length !== stride * height) fail();
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const source = (bottomUp ? height - y - 1 : y) * stride + x * 3,
        at = y * (width * 3 + 1) + 1 + x * 3;
      pixels[at] = dib[source + 2]!;
      pixels[at + 1] = dib[source + 1]!;
      pixels[at + 2] = dib[source]!;
    }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
function decodeAvi(
  bytes: Uint8Array,
  segments: readonly InputMediaSegment[],
  signal?: AbortSignal,
): DecodedMedia {
  const b = riff(bytes, "AVI "),
    top = chunks(b, 12, b.length);
  const lists = top.filter((c) => c.id === "LIST");
  const byType = (type: string) => {
    const matches = lists.filter(
      (c) => c.end - c.at >= 4 && b.toString("ascii", c.at, c.at + 4) === type,
    );
    if (matches.length !== 1) fail();
    return matches[0]!;
  };
  const hdrl = byType("hdrl"),
    movi = byType("movi");
  if (hdrl.at > movi.at) fail();
  const headers = chunks(b, hdrl.at + 4, hdrl.end),
    avih = one(headers, "avih"),
    streams = headers.filter(
      (c) => c.id === "LIST" && b.toString("ascii", c.at, c.at + 4) === "strl",
    );
  if (
    avih.end - avih.at !== 56 ||
    b.readUInt32LE(avih.at + 24) !== 1 ||
    streams.length !== 1
  )
    fail("MEDIA_CODEC_UNSUPPORTED");
  const stream = chunks(b, streams[0]!.at + 4, streams[0]!.end),
    strh = one(stream, "strh"),
    strf = one(stream, "strf");
  if (
    strh.end - strh.at !== 56 ||
    strf.end - strf.at !== 40 ||
    b.toString("ascii", strh.at, strh.at + 4) !== "vids" ||
    !["DIB ", "\0\0\0\0"].includes(
      b.toString("ascii", strh.at + 4, strh.at + 8),
    ) ||
    b.readUInt32LE(strh.at + 28) !== 0 ||
    b.readUInt32LE(strh.at + 44) !== 0 ||
    b.readUInt32LE(strf.at) !== 40 ||
    b.readUInt16LE(strf.at + 12) !== 1 ||
    b.readUInt16LE(strf.at + 14) !== 24 ||
    b.readUInt32LE(strf.at + 16) !== 0
  )
    fail("MEDIA_CODEC_UNSUPPORTED");
  const width = b.readInt32LE(strf.at + 4),
    signedHeight = b.readInt32LE(strf.at + 8),
    height = Math.abs(signedHeight),
    scale = b.readUInt32LE(strh.at + 20),
    rate = b.readUInt32LE(strh.at + 24),
    count = b.readUInt32LE(strh.at + 32);
  if (
    Math.abs(b.readUInt32LE(avih.at) - (scale * 1000000) / rate) > 1 ||
    width < 1 ||
    width > 256 ||
    height < 1 ||
    height > 256 ||
    !scale ||
    !rate ||
    rate > 100000 ||
    scale > 100000 ||
    !count ||
    count > 32 ||
    b.readUInt32LE(avih.at + 16) !== count ||
    b.readUInt32LE(avih.at + 32) !== width ||
    b.readUInt32LE(avih.at + 36) !== height
  )
    fail("MEDIA_LIMIT_EXCEEDED");
  const durationMs = (count * scale * 1000) / rate;
  if (durationMs > 30000) fail("MEDIA_LIMIT_EXCEEDED");
  const frames = chunks(b, movi.at + 4, movi.end).filter(
    (c) => c.id !== "JUNK",
  );
  if (
    frames.length !== count ||
    frames.some(
      (c) =>
        c.id !== "00db" ||
        c.end - c.at !== Math.ceil((width * 3) / 4) * 4 * height,
    )
  )
    fail("MEDIA_CODEC_UNSUPPORTED");
  if (segments.some((s) => s.endMs > durationMs))
    fail("MEDIA_SELECTION_INVALID");
  const assets: DecodedMediaAsset[] = [];
  for (let n = 0; n < frames.length; n++) {
    abort(signal);
    const startMs = (n * scale * 1000) / rate,
      endMs = ((n + 1) * scale * 1000) / rate;
    if (!segments.some((s) => startMs >= s.startMs && startMs < s.endMs))
      continue;
    if (assets.length >= 4) fail("MEDIA_LIMIT_EXCEEDED");
    const c = frames[n]!,
      png = pngRgb(width, height, b.subarray(c.at, c.end), signedHeight > 0);
    assets.push({
      kind: "image",
      mimeType: "image/png",
      startMs,
      endMs,
      bytes: png,
      sha256: segmentHash(png),
    });
  }
  if (!assets.length) fail("MEDIA_SELECTION_INVALID");
  return { decoder: "avi-rgb24-v1", durationMs, assets };
}
export function decodeMediaSegments(
  bytes: Uint8Array,
  mimeType: InputMediaAttachment["mimeType"],
  segments: readonly InputMediaSegment[],
  signal?: AbortSignal,
): DecodedMedia {
  abort(signal);
  const safe = jobJson(segments, 4096);
  if (!Array.isArray(safe) || !safe.length || safe.length > 4)
    fail("MEDIA_SELECTION_INVALID");
  let previous = 0;
  for (const value of safe) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2
    )
      fail("MEDIA_SELECTION_INVALID");
    const s = value as unknown as InputMediaSegment;
    if (
      !Number.isSafeInteger(s.startMs) ||
      !Number.isSafeInteger(s.endMs) ||
      s.startMs < previous ||
      s.endMs <= s.startMs ||
      s.endMs > 30000 ||
      s.endMs - s.startMs > 10000
    )
      fail("MEDIA_SELECTION_INVALID");
    previous = s.endMs;
  }
  segments = safe as unknown as InputMediaSegment[];
  if (mimeType === "video/x-msvideo") return decodeAvi(bytes, segments, signal);
  if (mimeType !== "audio/wav") fail("MEDIA_MIME_UNSUPPORTED");
  const wave = decodePcmWave(bytes),
    assets: DecodedMediaAsset[] = [];
  for (const s of segments) {
    abort(signal);
    if (s.endMs > wave.durationMs) fail("MEDIA_SELECTION_INVALID");
    const start = (s.startMs * wave.sampleRate) / 1000,
      end = (s.endMs * wave.sampleRate) / 1000;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      end <= start
    )
      fail("MEDIA_SELECTION_INVALID");
    const wav = encodePcmWave(
      wave.samples.subarray(start * wave.channels * 2, end * wave.channels * 2),
      wave.sampleRate,
      wave.channels,
    );
    assets.push({
      kind: "audio",
      mimeType: "audio/wav",
      startMs: s.startMs,
      endMs: s.endMs,
      bytes: wav,
      sha256: segmentHash(wav),
    });
  }
  if (
    assets.reduce((sum, a) => sum + a.bytes.length, 0) >
    SEGMENT_LIMITS.totalBytes
  )
    fail("MEDIA_LIMIT_EXCEEDED");
  return { decoder: "wav-pcm16-v1", durationMs: wave.durationMs, assets };
}
