import { encodePcmWave } from "./segments.js";
/** Local synthetic byte fixtures, authored against the RIFF layouts. */
export function wav(ms = 1000): Buffer {
  const samples = Buffer.alloc(ms * 16 * 2);
  for (let i = 0; i < samples.length / 2; i++)
    samples.writeInt16LE((i % 160) - 80, i * 2);
  return encodePcmWave(samples, 16000, 1);
}
function chunk(id: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id);
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([
    header,
    data,
    ...(data.length % 2 ? [Buffer.alloc(1)] : []),
  ]);
}
function list(type: string, data: Buffer): Buffer {
  return chunk("LIST", Buffer.concat([Buffer.from(type), data]));
}
export function avi(
  colors: readonly (readonly [number, number, number])[] = [
    [255, 0, 0],
    [0, 255, 0],
  ],
  fps = 2,
): Buffer {
  const avih = Buffer.alloc(56);
  avih.writeUInt32LE(1000000 / fps);
  avih.writeUInt32LE(colors.length, 16);
  avih.writeUInt32LE(1, 24);
  avih.writeUInt32LE(1, 32);
  avih.writeUInt32LE(1, 36);
  const strh = Buffer.alloc(56);
  strh.write("vids");
  strh.write("DIB ", 4);
  strh.writeUInt32LE(1, 20);
  strh.writeUInt32LE(fps, 24);
  strh.writeUInt32LE(colors.length, 32);
  const strf = Buffer.alloc(40);
  strf.writeUInt32LE(40);
  strf.writeInt32LE(1, 4);
  strf.writeInt32LE(1, 8);
  strf.writeUInt16LE(1, 12);
  strf.writeUInt16LE(24, 14);
  strf.writeUInt32LE(4, 20);
  const body = Buffer.concat([
    Buffer.from("AVI "),
    list(
      "hdrl",
      Buffer.concat([
        chunk("avih", avih),
        list("strl", Buffer.concat([chunk("strh", strh), chunk("strf", strf)])),
      ]),
    ),
    list(
      "movi",
      Buffer.concat(
        colors.map(([r, g, b]) => chunk("00db", Buffer.from([b, g, r, 0]))),
      ),
    ),
  ]);
  return chunk("RIFF", body);
}
