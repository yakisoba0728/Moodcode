import { deflateSync } from 'node:zlib';
import type { InputImageAttachment } from '@moodcode/contracts';
import { digest } from './validation.js';

// Synthetic local fixtures authored for the container/transport boundary, never account captures.
// JPEG/WebP samples exercise bounded headers, not a claimed complete pixel decoder.
function crc(bytes: Buffer): number { let state = 0xffffffff; for (const byte of bytes) { state ^= byte; for (let bit = 0; bit < 8; bit++) state = state >>> 1 ^ (state & 1 ? 0xedb88320 : 0); } return (state ^ 0xffffffff) >>> 0; }
export function pngChunk(name: string, content: Buffer): Buffer {
  const chunk = Buffer.alloc(content.length + 12); chunk.writeUInt32BE(content.length); chunk.write(name, 4, 4, 'ascii'); content.copy(chunk, 8); chunk.writeUInt32BE(crc(chunk.subarray(4, -4)), chunk.length - 4); return chunk;
}
export function png(width = 1, height = 1, extra: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.from([0, 20, 40, 60]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), extra, pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
}
export function gif(animated = false): Buffer {
  const header = Buffer.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255]);
  const frame = Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0]);
  return Buffer.concat([header, frame, ...(animated ? [frame] : []), Buffer.from([0x3b])]);
}
export function jpeg(width = 1, height = 1): Buffer {
  const frame = Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0]); frame.writeUInt16BE(height, 5); frame.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), frame, Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0, 0xff, 0xd9])]);
}
export function webp(animated = false): Buffer {
  const frame = Buffer.alloc(18); frame.write('VP8 ', 0, 'ascii'); frame.writeUInt32LE(10, 4); frame.set([0, 0, 0, 0x9d, 1, 0x2a, 1, 0, 1, 0], 8);
  const animation = Buffer.alloc(8); animation.write('ANIM');
  const content = Buffer.concat([...(animated ? [animation] : []), frame]); const header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(content.length + 4, 4); header.write('WEBP', 8);
  return Buffer.concat([header, content]);
}
export function imageFixture(data = png(), mimeType: InputImageAttachment['mimeType'] = 'image/png', digit = 'a'): { attachment: InputImageAttachment; data: string } {
  return { attachment: { id: 'img_' + digit.repeat(32), kind: 'image', mimeType, bytes: data.length, sha256: digest(data) }, data: data.toString('base64') };
}
