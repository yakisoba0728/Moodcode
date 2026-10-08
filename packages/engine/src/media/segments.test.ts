import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { decodeMediaSegments, decodePcmWave, segmentHash } from "./segments.js";
import { avi, wav } from "./segment-fixtures.js";
const code = (v: string) => (e: unknown) => (e as { code: string }).code === v;
test("WAV selection is exact original PCM with new valid RIFF layout and timestamp", () => {
  const source = wav(),
    selected = decodeMediaSegments(source, "audio/wav", [
      { startMs: 250, endMs: 500 },
    ]);
  const asset = selected.assets[0]!;
  assert.equal(asset.bytes.length, 8044);
  assert.deepEqual(
    decodePcmWave(asset.bytes).samples,
    decodePcmWave(source).samples.subarray(8000, 16000),
  );
  assert.equal(asset.startMs, 250);
  assert.equal(asset.endMs, 500);
  assert.equal(asset.sha256, segmentHash(asset.bytes));
});
test("AVI RGB frame decoder emits actual PNG pixels, source frame times, and ordered selected frames", () => {
  const media = decodeMediaSegments(avi(), "video/x-msvideo", [
    { startMs: 0, endMs: 1000 },
  ]);
  assert.equal(media.assets.length, 2);
  for (const [n, a] of media.assets.entries()) {
    assert.equal(a.startMs, n * 500);
    assert.equal(a.endMs, (n + 1) * 500);
    assert.deepEqual(
      a.bytes.subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const at = a.bytes.indexOf("IDAT"),
      length = a.bytes.readUInt32BE(at - 4);
    assert.deepEqual(
      [...inflateSync(a.bytes.subarray(at + 4, at + 4 + length))],
      n ? [0, 0, 255, 0] : [0, 255, 0, 0],
    );
  }
});
test("unsupported codec, mislabeled bytes, invalid selections and overlarge inputs reject", () => {
  assert.throws(
    () =>
      decodeMediaSegments(wav(), "video/x-msvideo", [
        { startMs: 0, endMs: 100 },
      ]),
    code("MEDIA_INVALID_SOURCE"),
  );
  const bad = wav();
  bad.writeUInt16LE(3, 20);
  assert.throws(() => decodePcmWave(bad), code("MEDIA_CODEC_UNSUPPORTED"));
  for (const selection of [
    [{ startMs: -1, endMs: 100 }],
    [{ startMs: 0, endMs: 2000 }],
    [
      { startMs: 500, endMs: 1000 },
      { startMs: 0, endMs: 500 },
    ],
  ])
    assert.throws(() => decodeMediaSegments(wav(), "audio/wav", selection));
  assert.throws(
    () => decodePcmWave(Buffer.alloc(524289)),
    code("MEDIA_LIMIT_EXCEEDED"),
  );
  assert.throws(
    () =>
      decodeMediaSegments(
        avi(
          Array.from({ length: 5 }, () => [255, 0, 0] as const),
          5,
        ),
        "video/x-msvideo",
        [{ startMs: 0, endMs: 1000 }],
      ),
    code("MEDIA_LIMIT_EXCEEDED"),
  );
});
test("selection accessors and proxies reject without invoking traps", () => {
  let traps = 0;
  const proxy = new Proxy(
    { startMs: 0, endMs: 100 },
    {
      ownKeys() {
        traps++;
        return [];
      },
    },
  );
  assert.throws(() => decodeMediaSegments(wav(), "audio/wav", [proxy]));
  const get = Object.defineProperty({ endMs: 100 }, "startMs", {
    enumerable: true,
    get() {
      traps++;
      return 0;
    },
  });
  assert.throws(() => decodeMediaSegments(wav(), "audio/wav", [get as never]));
  assert.equal(traps, 0);
});
