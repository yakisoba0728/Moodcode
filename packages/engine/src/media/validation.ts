import { createHash } from 'node:crypto';
import { EngineError, type InputImageAttachment } from '@moodcode/contracts';

export const INPUT_IMAGE_ID = /^img_[a-f0-9]{32}$/u;
export const INPUT_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export interface ImageLimits { maxImageBytes: number; maxInputImages: number; maxInputBytes: number; maxSessionImages: number; maxSessionBytes: number; maxDimension: number; maxPixels: number }
/** Local protection budgets; these are not vendor API limits or image token estimates. */
export const DEFAULT_IMAGE_LIMITS: Readonly<ImageLimits> = Object.freeze({ maxImageBytes: 524_288, maxInputImages: 4, maxInputBytes: 1_048_576,
  maxSessionImages: 32, maxSessionBytes: 16_777_216, maxDimension: 8192, maxPixels: 16_777_216 });
export function imageLimits(input: Partial<ImageLimits> = {}): Readonly<ImageLimits> {
  if (input === null || typeof input !== 'object' || Object.keys(input).some(key => !Object.hasOwn(DEFAULT_IMAGE_LIMITS, key))) fail('IMAGE_INVALID_CONFIG');
  const limits = { ...DEFAULT_IMAGE_LIMITS, ...input };
  for (const key of Object.keys(limits) as (keyof ImageLimits)[]) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULT_IMAGE_LIMITS[key]) fail('IMAGE_INVALID_CONFIG');
  return Object.freeze(limits);
}
export function fail(code: string): never { throw new EngineError(code, 'Image input validation failed.'); }
export function cancelled(signal?: AbortSignal): void { if (signal?.aborted) fail('IMAGE_CANCELLED'); }
export function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function attachment(value: unknown, limits = DEFAULT_IMAGE_LIMITS): InputImageAttachment {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('IMAGE_INVALID_REFERENCE');
  const keys = ['id', 'kind', 'mimeType', 'bytes', 'sha256'];
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.getOwnPropertyDescriptor(value, key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) fail('IMAGE_INVALID_REFERENCE');
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !INPUT_IMAGE_ID.test(item.id) || item.kind !== 'image'
    || !INPUT_IMAGE_MIME_TYPES.includes(item.mimeType as InputImageAttachment['mimeType']) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)
    || typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > limits.maxImageBytes) fail('IMAGE_INVALID_REFERENCE');
  return { id: item.id, kind: 'image', mimeType: item.mimeType as InputImageAttachment['mimeType'], bytes: item.bytes, sha256: item.sha256 };
}
export function sameAttachment(left: InputImageAttachment, right: InputImageAttachment): boolean {
  return left.id === right.id && left.kind === right.kind && left.mimeType === right.mimeType && left.bytes === right.bytes && left.sha256 === right.sha256;
}
export function attachments(value: unknown, limits = DEFAULT_IMAGE_LIMITS): InputImageAttachment[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail('IMAGE_INVALID_REFERENCE');
  if (value.length > limits.maxInputImages) fail('IMAGE_LIMIT_EXCEEDED');
  if (Reflect.ownKeys(value).length !== value.length + 1) fail('IMAGE_INVALID_REFERENCE');
  const items: InputImageAttachment[] = [], ids = new Set<string>();
  for (let index = 0; index < value.length; index++) { const property = Object.getOwnPropertyDescriptor(value, String(index)); if (!property?.enumerable || !('value' in property)) fail('IMAGE_INVALID_REFERENCE'); items.push(attachment(property.value, limits)); }
  let total = 0;
  for (const item of items) { if (ids.has(item.id)) fail('IMAGE_INVALID_REFERENCE'); ids.add(item.id); total += item.bytes; }
  if (total > limits.maxInputBytes) fail('IMAGE_LIMIT_EXCEEDED');
  return items;
}
function dimensions(width: number, height: number, limits: Readonly<ImageLimits>): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels) fail('IMAGE_DIMENSIONS_EXCEEDED');
}
function range(data: Buffer, start: number, length: number): void { if (start < 0 || length < 0 || start + length > data.length) fail('IMAGE_INVALID_FORMAT'); }
function png(data: Buffer, limits: Readonly<ImageLimits>): void {
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('IMAGE_MIME_MISMATCH');
  let position = 8, chunks = 0, image = false, ended = false;
  while (position < data.length) {
    if (++chunks > 4096) fail('IMAGE_LIMIT_EXCEEDED');
    range(data, position, 12); const length = data.readUInt32BE(position), name = data.toString('ascii', position + 4, position + 8);
    range(data, position, length + 12);
    if (name === 'acTL' || name === 'fcTL' || name === 'fdAT') fail('IMAGE_ANIMATION_UNSUPPORTED');
    if (chunks === 1) {
      if (name !== 'IHDR' || length !== 13) fail('IMAGE_INVALID_FORMAT');
      dimensions(data.readUInt32BE(position + 8), data.readUInt32BE(position + 12), limits);
      const depth = data[position + 16]!, color = data[position + 17]!;
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || data[position + 18] !== 0 || data[position + 19] !== 0 || data[position + 20]! > 1) fail('IMAGE_INVALID_FORMAT');
    } else if (name === 'IHDR') fail('IMAGE_INVALID_FORMAT');
    if (name === 'IDAT' && length > 0) image = true;
    position += length + 12;
    if (name === 'IEND') { if (length !== 0 || !image || position !== data.length) fail('IMAGE_INVALID_FORMAT'); ended = true; break; }
  }
  if (!ended) fail('IMAGE_INVALID_FORMAT');
}
function gif(data: Buffer, limits: Readonly<ImageLimits>): void {
  if (!['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) fail('IMAGE_MIME_MISMATCH');
  range(data, 0, 13); dimensions(data.readUInt16LE(6), data.readUInt16LE(8), limits);
  let position = 13 + (data[10]! & 128 ? 3 * 2 ** ((data[10]! & 7) + 1) : 0), frames = 0, blocks = 0;
  const subBlocks = () => { for (;;) { range(data, position, 1); const length = data[position++]!; if (!length) return; range(data, position, length); position += length; } };
  while (position < data.length) {
    if (++blocks > 4096) fail('IMAGE_LIMIT_EXCEEDED');
    const marker = data[position++]!;
    if (marker === 0x3b) { if (frames !== 1 || position !== data.length) fail('IMAGE_INVALID_FORMAT'); return; }
    if (marker === 0x21) { range(data, position, 1); position++; subBlocks(); continue; }
    if (marker !== 0x2c) fail('IMAGE_INVALID_FORMAT');
    if (++frames > 1) fail('IMAGE_ANIMATION_UNSUPPORTED');
    range(data, position, 9); dimensions(data.readUInt16LE(position + 4), data.readUInt16LE(position + 6), limits);
    const flags = data[position + 8]!; position += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0);
    range(data, position, 1); if (data[position]! < 2 || data[position]! > 8) fail('IMAGE_INVALID_FORMAT'); position++; subBlocks();
  }
  fail('IMAGE_INVALID_FORMAT');
}
function jpeg(data: Buffer, limits: Readonly<ImageLimits>): void {
  if (data[0] !== 0xff || data[1] !== 0xd8) fail('IMAGE_MIME_MISMATCH');
  let position = 2, blocks = 0, frame = false, scan = false;
  while (position < data.length) {
    if (++blocks > 4096) fail('IMAGE_LIMIT_EXCEEDED');
    if (data[position++] !== 0xff) fail('IMAGE_INVALID_FORMAT');
    while (data[position] === 0xff) position++;
    range(data, position, 1); const marker = data[position++]!;
    if (marker === 0xd9) { if (!frame || !scan || position !== data.length) fail('IMAGE_INVALID_FORMAT'); return; }
    if (marker === 0 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7) fail('IMAGE_INVALID_FORMAT');
    if (marker === 0x01) continue;
    range(data, position, 2); const length = data.readUInt16BE(position); if (length < 2) fail('IMAGE_INVALID_FORMAT'); range(data, position, length);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || length < 8 || data[position + 2] !== 8) fail('IMAGE_INVALID_FORMAT'); frame = true;
      dimensions(data.readUInt16BE(position + 5), data.readUInt16BE(position + 3), limits);
      const components = data[position + 7]!; if (components < 1 || components > 4 || length !== 8 + components * 3) fail('IMAGE_INVALID_FORMAT');
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) fail('IMAGE_FORMAT_UNSUPPORTED');
    position += length;
    if (marker === 0xda) {
      if (!frame) fail('IMAGE_INVALID_FORMAT'); scan = true;
      for (;;) {
        if (position >= data.length) fail('IMAGE_INVALID_FORMAT');
        if (data[position++] !== 0xff) continue;
        const beginning = position - 1; while (data[position] === 0xff) position++;
        range(data, position, 1); const next = data[position]!;
        if (next === 0 || next >= 0xd0 && next <= 0xd7) { position++; continue; }
        position = beginning; break;
      }
    }
  }
  fail('IMAGE_INVALID_FORMAT');
}
function webp(data: Buffer, limits: Readonly<ImageLimits>): void {
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') fail('IMAGE_MIME_MISMATCH');
  range(data, 0, 12); if (data.readUInt32LE(4) !== data.length - 8) fail('IMAGE_INVALID_FORMAT');
  let position = 12, blocks = 0, frame = false;
  while (position < data.length) {
    if (++blocks > 4096) fail('IMAGE_LIMIT_EXCEEDED');
    range(data, position, 8); const name = data.toString('ascii', position, position + 4), length = data.readUInt32LE(position + 4), start = position + 8;
    range(data, start, length + (length & 1));
    if (name === 'ANIM' || name === 'ANMF' || name === 'VP8X' && length >= 1 && data[start]! & 2) fail('IMAGE_ANIMATION_UNSUPPORTED');
    if (name === 'VP8X') { if (length !== 10) fail('IMAGE_INVALID_FORMAT'); dimensions(data.readUIntLE(start + 4, 3) + 1, data.readUIntLE(start + 7, 3) + 1, limits); }
    if (name === 'VP8 ') {
      if (frame || length < 10 || data[start]! & 1 || !data.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 1, 0x2a]))) fail('IMAGE_INVALID_FORMAT');
      frame = true; dimensions(data.readUInt16LE(start + 6) & 0x3fff, data.readUInt16LE(start + 8) & 0x3fff, limits);
    }
    if (name === 'VP8L') {
      if (frame || length < 5 || data[start] !== 0x2f) fail('IMAGE_INVALID_FORMAT');
      const bits = data.readUInt32LE(start + 1); if (bits >>> 29) fail('IMAGE_INVALID_FORMAT'); frame = true;
      dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, limits);
    }
    position = start + length + (length & 1);
  }
  if (!frame) fail('IMAGE_INVALID_FORMAT');
}
/** Checks bounded container headers/structure. It never decompresses or decodes image pixels. */
export function validateImageBytes(bytes: Uint8Array, mimeType: InputImageAttachment['mimeType'], limits = DEFAULT_IMAGE_LIMITS): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > limits.maxImageBytes) fail('IMAGE_LIMIT_EXCEEDED');
  if (!INPUT_IMAGE_MIME_TYPES.includes(mimeType)) fail('IMAGE_FORMAT_UNSUPPORTED');
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mimeType === 'image/png') png(data, limits); else if (mimeType === 'image/jpeg') jpeg(data, limits); else if (mimeType === 'image/gif') gif(data, limits); else webp(data, limits);
}
