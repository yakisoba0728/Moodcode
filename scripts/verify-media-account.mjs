import assert from "node:assert/strict";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { crc32, inflateSync } from "node:zlib";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  realpath,
  rm,
  unlink,
  lstat,
} from "node:fs/promises";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directEntrypoint = Boolean(
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url),
);
const processHooks =
  process.execArgv.some(
    (arg) =>
      /^--(?:import|require|loader|experimental-loader|eval)(?:=|$)/u.test(
        arg,
      ) || /^-[re](?:.*)$/u.test(arg),
  ) || Boolean(process.env.NODE_OPTIONS);
const OFFICIAL = "https://api.openai.com/v1";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const errorCode = (error) =>
  typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
    ? error.code
    : "MEDIA_VERIFICATION_FAILED";
function fail(code) {
  throw Object.assign(
    new Error(
      "Media verification did not satisfy its bounded evidence contract",
    ),
    { code },
  );
}
function integer(value, min, max) {
  if (
    !/^\d+$/u.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  )
    fail("VERIFY_INVALID_ARGUMENT");
  return Number(value);
}
const strings = new Set([
  "scenario",
  "audio-model",
  "video-model",
  "video-probe-size",
  "api-key-env",
  "pcm-sample-rate",
  "pcm-channels",
  "voice",
  "capability-reference",
  "max-requests",
  "fixture-endpoint",
  "report",
]);
const flags = new Set([
  "live",
  "declare-audio-input-output",
  "declare-video-frames",
  "allow-unknown-media-token-cost",
]);
/** Parse before importing an engine, reading credentials, or creating a transport. */
export function parseMediaAccountArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]?.slice(2);
    if (
      !argv[i]?.startsWith("--") ||
      Object.hasOwn(options, key) ||
      (!strings.has(key) && !flags.has(key))
    )
      fail("VERIFY_INVALID_ARGUMENT");
    if (flags.has(key)) options[key] = true;
    else {
      const value = argv[++i];
      if (
        typeof value !== "string" ||
        !value.trim() ||
        Buffer.byteLength(value) > 2048 ||
        /[\u0000-\u001f\u007f]/u.test(value) ||
        value.startsWith("--")
      )
        fail("VERIFY_INVALID_ARGUMENT");
      options[key] = value;
    }
  }
  const scenario = options.scenario ?? "all";
  if (!["audio", "video", "all"].includes(scenario))
    fail("VERIFY_INVALID_ARGUMENT");
  if (options.live && options["fixture-endpoint"])
    fail("VERIFY_INVALID_ARGUMENT");
  if (
    options["api-key-env"] &&
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(options["api-key-env"])
  )
    fail("VERIFY_INVALID_ARGUMENT");
  for (const name of ["audio-model", "video-model"])
    if (
      options[name] &&
      (Buffer.byteLength(options[name]) > 256 ||
        /^codex(?::|$)/iu.test(options[name]))
    )
      fail("VERIFY_INVALID_ARGUMENT");
  let endpoint = OFFICIAL;
  if (options["fixture-endpoint"]) {
    const url = new URL(options["fixture-endpoint"]);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      fail("VERIFY_INVALID_FIXTURE_ENDPOINT");
    endpoint = url.href.replace(/\/$/u, "");
  }
  const audio = scenario !== "video",
    video = scenario !== "audio";
  const videoProbeSize = options["video-probe-size"] ?? "8";
  if (!["8", "128"].includes(videoProbeSize)) fail("VERIFY_INVALID_ARGUMENT");
  const maxRequests = integer(options["max-requests"] ?? "4", 1, 4);
  const sampleRate = options["pcm-sample-rate"]
    ? integer(options["pcm-sample-rate"], 8000, 48000)
    : null;
  const channels = options["pcm-channels"]
    ? integer(options["pcm-channels"], 1, 2)
    : null;
  if (sampleRate !== null && ![8000, 16000, 24000, 48000].includes(sampleRate))
    fail("VERIFY_INVALID_ARGUMENT");
  const execute = Boolean(options.live || options["fixture-endpoint"]);
  if (execute) {
    if (
      !options["allow-unknown-media-token-cost"] ||
      !options["capability-reference"] ||
      (options.live && (!options["api-key-env"] || !options["max-requests"]))
    )
      fail("VERIFY_EXPLICIT_CAPABILITY_REQUIRED");
    if (
      audio &&
      (!options["audio-model"] ||
        !options["declare-audio-input-output"] ||
        !sampleRate ||
        !channels ||
        !options.voice)
    )
      fail("VERIFY_AUDIO_LAYOUT_REQUIRED");
    if (
      audio &&
      ![
        "alloy",
        "ash",
        "ballad",
        "coral",
        "echo",
        "fable",
        "nova",
        "onyx",
        "sage",
        "shimmer",
        "verse",
        "marin",
        "cedar",
      ].includes(options.voice)
    )
      fail("VERIFY_AUDIO_LAYOUT_REQUIRED");
    if (video && (!options["video-model"] || !options["declare-video-frames"]))
      fail("VERIFY_EXPLICIT_CAPABILITY_REQUIRED");
    if (
      video &&
      /^(?:gpt-audio|gpt-live|gpt-realtime)/iu.test(options["video-model"])
    )
      fail("VERIFY_VIDEO_MODEL_UNSUPPORTED");
    if (maxRequests < (audio ? 3 : 0) + (video ? 1 : 0))
      fail("VERIFY_REQUEST_BUDGET");
  }
  if (
    options.report &&
    (!isAbsolute(options.report) || !options.report.endsWith(".json"))
  )
    fail("VERIFY_INVALID_ARGUMENT");
  return Object.freeze({
    ...options,
    scenario,
    audio,
    video,
    execute,
    endpoint,
    maxRequests,
    sampleRate,
    channels,
    videoProbeSize: Number(videoProbeSize),
    videoProbeProfile: "rgb24-" + videoProbeSize + "px-v1",
  });
}

/** Authored RIFF PCM16 fixture/wrapper; no external decoder or audio API layout inference. */
export function pcmWave(samples, rate, channels) {
  assert.ok(
    Buffer.isBuffer(samples) &&
      samples.length > 0 &&
      samples.length % (channels * 2) === 0 &&
      samples.length + 44 <= 524288,
  );
  const out = Buffer.alloc(44 + samples.length);
  out.write("RIFF");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(samples.length, 40);
  samples.copy(out, 44);
  return out;
}
export function inspectWave(bytes) {
  if (
    bytes.length < 44 ||
    bytes.length > 524288 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    fail("VERIFY_WAVE_INVALID");
  let fmt, pcm;
  for (let at = 12, count = 0; at < bytes.length;) {
    if (++count > 256 || at + 8 > bytes.length) fail("VERIFY_WAVE_INVALID");
    const size = bytes.readUInt32LE(at + 4),
      end = at + 8 + size,
      type = bytes.toString("ascii", at, at + 4);
    if (end > bytes.length) fail("VERIFY_WAVE_INVALID");
    if (type === "fmt ") {
      if (fmt) fail("VERIFY_WAVE_INVALID");
      fmt = bytes.subarray(at + 8, end);
    }
    if (type === "data") {
      if (pcm) fail("VERIFY_WAVE_INVALID");
      pcm = bytes.subarray(at + 8, end);
    }
    at = end + (size & 1);
  }
  if (
    !fmt ||
    !pcm ||
    ![16, 18].includes(fmt.length) ||
    fmt.readUInt16LE() !== 1 ||
    fmt.readUInt16LE(14) !== 16
  )
    fail("VERIFY_WAVE_INVALID");
  const channels = fmt.readUInt16LE(2),
    sampleRate = fmt.readUInt32LE(4);
  if (
    ![1, 2].includes(channels) ||
    ![8000, 16000, 24000, 48000].includes(sampleRate) ||
    fmt.readUInt32LE(8) !== sampleRate * channels * 2 ||
    fmt.readUInt16LE(12) !== channels * 2 ||
    !pcm.length ||
    pcm.length % (channels * 2)
  )
    fail("VERIFY_WAVE_INVALID");
  return {
    channels,
    sampleRate,
    pcm,
    durationMs: (pcm.length * 1000) / (sampleRate * channels * 2),
  };
}
function riffChunk(type, data) {
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([
    header,
    data,
    ...(data.length % 2 ? [Buffer.alloc(1)] : []),
  ]);
}
function probeDimensions(size) {
  if (size !== 8 && size !== 128) fail("VERIFY_VIDEO_PROBE_INVALID");
  return { width: size, height: size, stride: Math.ceil((size * 3) / 4) * 4 };
}
function probeColors(colors) {
  if (
    !Array.isArray(colors) ||
    colors.length !== 3 ||
    colors.some(
      (rgb) =>
        !Array.isArray(rgb) ||
        rgb.length !== 3 ||
        rgb.some((n) => !Number.isInteger(n) || n < 0 || n > 255),
    )
  )
    fail("VERIFY_VIDEO_PROBE_INVALID");
}
/** Supported uncompressed RGB24 AVI. Size is a host probe profile, not a claim about a model minimum. */
export function colorAvi(colors, size = 8) {
  probeColors(colors);
  const { width, height, stride } = probeDimensions(size),
    frameBytes = stride * height;
  const avih = Buffer.alloc(56);
  avih.writeUInt32LE(500000);
  avih.writeUInt32LE(colors.length, 16);
  avih.writeUInt32LE(1, 24);
  avih.writeUInt32LE(width, 32);
  avih.writeUInt32LE(height, 36);
  const strh = Buffer.alloc(56);
  strh.write("vids");
  strh.write("DIB ", 4);
  strh.writeUInt32LE(1, 20);
  strh.writeUInt32LE(2, 24);
  strh.writeUInt32LE(colors.length, 32);
  const strf = Buffer.alloc(40);
  strf.writeUInt32LE(40);
  strf.writeInt32LE(width, 4);
  strf.writeInt32LE(height, 8);
  strf.writeUInt16LE(1, 12);
  strf.writeUInt16LE(24, 14);
  strf.writeUInt32LE(frameBytes, 20);
  const list = (type, data) =>
    riffChunk("LIST", Buffer.concat([Buffer.from(type), data]));
  const frames = colors.map(([r, g, b]) => {
    const frame = Buffer.alloc(frameBytes);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) frame.set([b, g, r], y * stride + x * 3);
    return riffChunk("00db", frame);
  });
  return riffChunk(
    "RIFF",
    Buffer.concat([
      Buffer.from("AVI "),
      list(
        "hdrl",
        Buffer.concat([
          riffChunk("avih", avih),
          list(
            "strl",
            Buffer.concat([riffChunk("strh", strh), riffChunk("strf", strf)]),
          ),
        ]),
      ),
      list("movi", Buffer.concat(frames)),
    ]),
  );
}
/** Audit actual headers, lengths and every source pixel before native import. */
export function inspectColorAvi(bytes, colors, size = 8) {
  probeColors(colors);
  const { width, height, stride } = probeDimensions(size);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > 524288 ||
    bytes.length < 240 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.toString("ascii", 8, 12) !== "AVI "
  )
    fail("VERIFY_VIDEO_PROBE_INVALID");
  const chunks = (start, end) => {
    const list = [];
    for (let at = start; at < end;) {
      if (at + 8 > end || list.length >= 8) fail("VERIFY_VIDEO_PROBE_INVALID");
      const n = bytes.readUInt32LE(at + 4),
        next = at + 8 + n + (n % 2);
      if (next > end) fail("VERIFY_VIDEO_PROBE_INVALID");
      list.push({
        id: bytes.toString("ascii", at, at + 4),
        at: at + 8,
        end: at + 8 + n,
      });
      at = next;
    }
    return list;
  };
  const top = chunks(12, bytes.length);
  if (top.length !== 2 || top.some((c) => c.id !== "LIST"))
    fail("VERIFY_VIDEO_PROBE_INVALID");
  const [header, movi] = top;
  if (
    bytes.toString("ascii", header.at, header.at + 4) !== "hdrl" ||
    bytes.toString("ascii", movi.at, movi.at + 4) !== "movi"
  )
    fail("VERIFY_VIDEO_PROBE_INVALID");
  const headers = chunks(header.at + 4, header.end);
  if (
    headers.length !== 2 ||
    headers[0].id !== "avih" ||
    headers[0].end - headers[0].at !== 56 ||
    headers[1].id !== "LIST" ||
    bytes.toString("ascii", headers[1].at, headers[1].at + 4) !== "strl"
  )
    fail("VERIFY_VIDEO_PROBE_INVALID");
  const avih = headers[0].at,
    stream = chunks(headers[1].at + 4, headers[1].end);
  if (
    stream.length !== 2 ||
    stream[0].id !== "strh" ||
    stream[0].end - stream[0].at !== 56 ||
    stream[1].id !== "strf" ||
    stream[1].end - stream[1].at !== 40
  )
    fail("VERIFY_VIDEO_PROBE_INVALID");
  const strh = stream[0].at,
    strf = stream[1].at,
    frameBytes = stride * height;
  if (
    bytes.readUInt32LE(avih) !== 500000 ||
    bytes.readUInt32LE(avih + 16) !== 3 ||
    bytes.readUInt32LE(avih + 24) !== 1 ||
    bytes.readUInt32LE(avih + 32) !== width ||
    bytes.readUInt32LE(avih + 36) !== height ||
    bytes.toString("ascii", strh, strh + 4) !== "vids" ||
    bytes.toString("ascii", strh + 4, strh + 8) !== "DIB " ||
    bytes.readUInt32LE(strh + 20) !== 1 ||
    bytes.readUInt32LE(strh + 24) !== 2 ||
    bytes.readUInt32LE(strh + 32) !== 3 ||
    bytes.readUInt32LE(strf) !== 40 ||
    bytes.readInt32LE(strf + 4) !== width ||
    bytes.readInt32LE(strf + 8) !== height ||
    bytes.readUInt16LE(strf + 12) !== 1 ||
    bytes.readUInt16LE(strf + 14) !== 24 ||
    bytes.readUInt32LE(strf + 16) !== 0 ||
    bytes.readUInt32LE(strf + 20) !== frameBytes
  )
    fail("VERIFY_VIDEO_PROBE_INVALID");
  const frames = chunks(movi.at + 4, movi.end);
  if (frames.length !== 3) fail("VERIFY_VIDEO_PROBE_INVALID");
  for (const [i, frame] of frames.entries()) {
    if (frame.id !== "00db" || frame.end - frame.at !== frameBytes)
      fail("VERIFY_VIDEO_PROBE_INVALID");
    const [r, g, b] = colors[i];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = frame.at + y * stride + x * 3;
        if (bytes[at] !== b || bytes[at + 1] !== g || bytes[at + 2] !== r)
          fail("VERIFY_VIDEO_PROBE_INVALID");
      }
      for (let at = width * 3; at < stride; at++)
        if (bytes[frame.at + y * stride + at] !== 0)
          fail("VERIFY_VIDEO_PROBE_INVALID");
    }
  }
  return {
    profile: "rgb24-" + size + "px-v1",
    width,
    height,
    stride,
    frameBytes,
    frames: 3,
    sourceBytes: bytes.length,
    sourceSha256: hash(bytes),
    timestamps: [0, 500, 1000],
    allPixelsVerified: true,
  };
}
function inspectProbePng(url, rgb, size) {
  if (typeof url !== "string" || !url.startsWith("data:image/png;base64,"))
    fail("VERIFY_VIDEO_WIRE_INVALID");
  const base64 = url.slice(22);
  if (
    base64.length > 699052 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      base64,
    )
  )
    fail("VERIFY_VIDEO_WIRE_INVALID");
  const bytes = Buffer.from(base64, "base64"),
    compressed = [];
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    fail("VERIFY_VIDEO_WIRE_INVALID");
  const types = [];
  for (let at = 8; at < bytes.length;) {
    if (at + 12 > bytes.length || types.length >= 3)
      fail("VERIFY_VIDEO_WIRE_INVALID");
    const n = bytes.readUInt32BE(at),
      type = bytes.toString("ascii", at + 4, at + 8);
    if (at + n + 12 > bytes.length) fail("VERIFY_VIDEO_WIRE_INVALID");
    if (
      bytes.readUInt32BE(at + 8 + n) !==
      crc32(bytes.subarray(at + 4, at + 8 + n))
    )
      fail("VERIFY_VIDEO_WIRE_INVALID");
    types.push(type);
    if (type === "IHDR") {
      if (
        n !== 13 ||
        bytes.readUInt32BE(at + 8) !== size ||
        bytes.readUInt32BE(at + 12) !== size ||
        !bytes.subarray(at + 16, at + 21).equals(Buffer.from([8, 2, 0, 0, 0]))
      )
        fail("VERIFY_VIDEO_WIRE_INVALID");
    } else if (type === "IDAT")
      compressed.push(bytes.subarray(at + 8, at + 8 + n));
    else if (type !== "IEND" || n !== 0) fail("VERIFY_VIDEO_WIRE_INVALID");
    at += n + 12;
  }
  if (types.join(",") !== "IHDR,IDAT,IEND") fail("VERIFY_VIDEO_WIRE_INVALID");
  const rowBytes = size * 3 + 1,
    expectedBytes = rowBytes * size;
  let pixels;
  try {
    pixels = inflateSync(Buffer.concat(compressed), {
      maxOutputLength: expectedBytes,
    });
  } catch {
    fail("VERIFY_VIDEO_WIRE_INVALID");
  }
  if (pixels.length !== expectedBytes) fail("VERIFY_VIDEO_WIRE_INVALID");
  for (let y = 0; y < size; y++) {
    if (pixels[y * rowBytes] !== 0) fail("VERIFY_VIDEO_WIRE_INVALID");
    for (let x = 0; x < size; x++)
      for (let c = 0; c < 3; c++)
        if (pixels[y * rowBytes + 1 + x * 3 + c] !== rgb[c])
          fail("VERIFY_VIDEO_WIRE_INVALID");
  }
  return {
    width: size,
    height: size,
    bytes: bytes.length,
    sha256: hash(bytes),
    allPixelsVerified: true,
    crcVerified: true,
  };
}
const normalizeAnswer = (value) =>
  value
    .toLowerCase()
    .replace(/\p{P}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
function recognitionCharacterCategories(raw) {
  const counts = {
    codePoints: 0,
    ascii: { letters: 0, digits: 0, whitespace: 0, punctuation: 0, other: 0 },
    nonAscii: {
      letters: 0,
      numbers: 0,
      whitespace: 0,
      punctuation: 0,
      other: 0,
    },
    scripts: {
      latin: 0,
      han: 0,
      hangul: 0,
      hiragana: 0,
      katakana: 0,
      cyrillic: 0,
      arabic: 0,
      devanagari: 0,
      otherLetters: 0,
    },
  };
  const scripts = [
    ["latin", /\p{Script=Latin}/u],
    ["han", /\p{Script=Han}/u],
    ["hangul", /\p{Script=Hangul}/u],
    ["hiragana", /\p{Script=Hiragana}/u],
    ["katakana", /\p{Script=Katakana}/u],
    ["cyrillic", /\p{Script=Cyrillic}/u],
    ["arabic", /\p{Script=Arabic}/u],
    ["devanagari", /\p{Script=Devanagari}/u],
  ];
  for (const character of raw) {
    counts.codePoints++;
    const ascii = character.codePointAt(0) < 128,
      letters = /\p{L}/u.test(character),
      bucket = ascii ? counts.ascii : counts.nonAscii;
    if (letters) {
      bucket.letters++;
      const script = scripts.find(([, pattern]) => pattern.test(character));
      counts.scripts[script?.[0] ?? "otherLetters"]++;
    } else if (/\p{N}/u.test(character)) bucket[ascii ? "digits" : "numbers"]++;
    else if (/\s/u.test(character)) bucket.whitespace++;
    else if (/\p{P}/u.test(character)) bucket.punctuation++;
    else bucket.other++;
  }
  return counts;
}
function recordRecognition(report, raw, expected, details) {
  const observed = normalizeAnswer(raw);
  const tokens = observed ? observed.split(" ") : [];
  const item = report.scopeCoverage.at(-1);
  item.recognition = {
    expectedSha256: hash(expected),
    observedSha256: hash(observed),
    matched: observed === expected,
    expectedAbsentFromFullWire: true,
    rawCharacters: raw.length,
    characterCategories: recognitionCharacterCategories(raw),
    tokenCount: tokens.length,
    // Fixed vocabulary only; never persist arbitrary upstream answer text.
    observedTokenKinds: tokens
      .slice(0, 16)
      .map((token) =>
        ["red", "green", "blue", "yellow"].includes(token) ? token : "other",
      ),
    tokensTruncated: tokens.length > 16,
    ...details,
  };
  item.state = item.recognition.matched ? "passed" : "recognition-mismatch";
  if (!item.recognition.matched) fail("VERIFY_RECOGNITION_MISMATCH");
}
function assertAnswerAbsent(body, answer) {
  const serialized = JSON.stringify(body);
  if (serialized.toLowerCase().includes(answer.toLowerCase()))
    fail("VERIFY_ANSWER_LEAKED");
  // Reject expected words in all plaintext fields, including prior history and advisory notices.
  const visit = (value, key = "") => {
    if (typeof value === "string") {
      if (key === "data" || value.startsWith("data:image/png;base64,")) return;
      const words = normalizeAnswer(value).split(" ");
      if (answer.split(" ").some((word) => words.includes(word)))
        fail("VERIFY_ANSWER_LEAKED");
    } else if (Array.isArray(value)) value.forEach((item) => visit(item));
    else if (value && typeof value === "object")
      Object.entries(value).forEach(([k, v]) => visit(v, k));
  };
  visit(body);
  return hash(serialized);
}
async function freezeSources() {
  const pins = {};
  for (const directory of ["packages/contracts/src", "packages/engine/src"]) {
    const walk = async (path) => {
      for (const item of (
        await readdir(join(root, path), { withFileTypes: true })
      ).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = join(path, item.name);
        if (item.isDirectory()) await walk(name);
        else if (
          item.isFile() &&
          name.endsWith(".ts") &&
          !name.includes(".test.") &&
          !name.includes("/fixtures/")
        )
          pins[name] = hash(await readFile(join(root, name)));
      }
    };
    await walk(directory);
  }
  pins["scripts/verify-media-account.mjs"] = hash(
    await readFile(fileURLToPath(import.meta.url)),
  );
  return pins;
}
async function freezeRuntime(engineURL) {
  const pins = {},
    paths = {};
  let total = 0;
  const directories = {
    engine: dirname(fileURLToPath(engineURL)),
    contracts: dirname(
      fileURLToPath(import.meta.resolve("@moodcode/contracts")),
    ),
  };
  for (const [prefix, directory] of Object.entries(directories)) {
    const walk = async (sub = "") => {
      for (const item of (
        await readdir(join(directory, sub), { withFileTypes: true })
      ).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = join(sub, item.name),
          path = join(directory, relative);
        if (item.isDirectory()) await walk(relative);
        else if (
          item.isFile() &&
          /\.(?:[cm]?js|json|ts)$/u.test(item.name) &&
          !/\.(?:test|integration.test)\./u.test(item.name) &&
          !relative.includes("fixtures/")
        ) {
          const stat = await lstat(path);
          if (
            Object.keys(pins).length >= 2048 ||
            stat.size > 4194304 ||
            (total += stat.size) > 67108864
          )
            fail("VERIFY_RUNTIME_LIMIT");
          const key = prefix + "/" + relative;
          pins[key] = hash(await readFile(path));
          paths[key] = path;
        }
      }
    };
    await walk();
  }
  return { pins, paths, bytes: total };
}
async function checkRuntime(frozen) {
  for (const [key, path] of Object.entries(frozen.paths))
    if (hash(await readFile(path)) !== frozen.pins[key]) return false;
  return true;
}
const parts = (engine, runId) =>
  engine.store
    .listTurns(runId)
    .flatMap((turn) => engine.store.listParts(turn.id));
async function readOutput(engine, part) {
  const chunks = [];
  let offset = 0;
  for (let i = 0; i < 9; i++) {
    const page = await engine.readMediaOutput({
      sessionId: part.sessionId,
      partId: part.id,
      offset,
      limit: 65536,
    });
    chunks.push(Buffer.from(page.bytes));
    if (page.nextOffset === undefined) {
      const bytes = Buffer.concat(chunks);
      assert.equal(bytes.length, part.artifact.storedBytes);
      assert.equal(hash(bytes), part.artifact.sha256);
      return bytes;
    }
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  fail("VERIFY_ARTIFACT_LIMIT");
}
function nativeEvidence(engine, run, observations) {
  const nativeParts = parts(engine, run.id),
    actual = observations.filter((item) => item.runId === run.id);
  const attempts = actual.map((item) => {
    const cleanup = engine.store.getAttemptCleanup(
      item.attemptId,
      run.sessionId,
    );
    return {
      runId: item.runId,
      turnId: item.turnId,
      attemptId: item.attemptId,
      requestSha256: cleanup.requestSha256,
      nativeOwnerSha256: item.ownerSha256,
      cleanup: {
        state: cleanup.state,
        confirmed: cleanup.cleanupConfirmed,
        method: cleanup.method,
        reason: cleanup.reason,
      },
      usage: engine.store.getAttemptUsage(item.attemptId)?.usage ?? null,
    };
  });
  return {
    sessionId: run.sessionId,
    runId: run.id,
    inputId: run.inputId,
    state: run.state,
    errorCode: run.error?.code ?? null,
    runSha256: hash(JSON.stringify(run)),
    attempts,
    parts: nativeParts.map((p) => ({
      id: p.id,
      type: p.type,
      state: p.state,
      turnId: p.turnId,
      sha256: hash(JSON.stringify(p)),
      ...(p.type === "media" ? { mime: p.mime, artifact: p.artifact } : {}),
    })),
  };
}

/** CLI and local tests share the actual Engine execution path. Test runtime hooks never receive account credit. */
export async function verifyMediaAccount(argv, runtime = {}) {
  const options = parseMediaAccountArgs(argv),
    before = await freezeSources();
  const report = {
    schemaVersion: 1,
    kind: "media-account-verification",
    state: options.execute ? "running" : "plan-only",
    observedAt: new Date().toISOString(),
    implementationCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    scenario: options.scenario,
    videoProbe: options.video
      ? {
          profile: options.videoProbeProfile,
          ...probeDimensions(options.videoProbeSize),
          frames: 3,
          modelMinimumClaimed: false,
        }
      : null,
    sourceFreeze: {
      sha256: hash(JSON.stringify(before)),
      files: Object.keys(before).length,
      executorSha256: before["scripts/verify-media-account.mjs"],
      unchanged: null,
    },
    accountVerified: false,
    credentialReads: 0,
    actualRequests: [],
    streamDiagnostics: [],
    maxRequests: options.maxRequests,
    transport:
      options["fixture-endpoint"] ||
      runtime.fetch ||
      runtime.engineModuleURL ||
      runtime.engineModule ||
      runtime.readCredential ||
      processHooks ||
      !directEntrypoint
        ? "local-fixture"
        : "real-remote",
    scopeCoverage: [],
    remainingScopes: [
      "unselected account/model modalities",
      "PDF",
      "Anthropic",
      "Codex new audio/video",
      "E5-13 broader environments",
    ],
    passed: false,
    cleanupConfirmed: false,
  };
  if (!options.execute) {
    report.transport = "none";
    report.state = "plan-only";
    report.sourceFreeze.unchanged = true;
    report.cleanupConfirmed = true;
    return report;
  }
  let engine,
    temporary,
    physicalUnknown = false,
    frozenRuntime,
    activeCase = "configuration";
  const engines = [],
    observations = [],
    answers = new Map(),
    videoProbes = new Map(),
    sessions = [],
    observedEngines = new Map(),
    cleanupProofs = new Map();
  try {
    let apiKey;
    if (options.live) {
      report.credentialReads++;
      apiKey = (runtime.readCredential ?? ((name) => process.env[name]))(
        options["api-key-env"],
      );
      if (!apiKey) fail("VERIFY_CREDENTIAL_UNAVAILABLE");
    }
    const engineURL =
      runtime.engineModuleURL ?? import.meta.resolve("@moodcode/engine");
    frozenRuntime = await freezeRuntime(engineURL);
    report.runtimeFreeze = {
      sha256: hash(JSON.stringify(frozenRuntime.pins)),
      files: Object.keys(frozenRuntime.pins).length,
      bytes: frozenRuntime.bytes,
      pins: frozenRuntime.pins,
      unchanged: null,
      engineEntrySha256: hash(await readFile(fileURLToPath(engineURL))),
    };
    const api = runtime.engineModule ?? (await import(engineURL));
    temporary = await realpath(
      await mkdtemp(join(tmpdir(), "moodcode-media-account-")),
    );
    await mkdir(join(temporary, "repository"));
    execFileSync("git", ["init", "-q", join(temporary, "repository")]);
    const dbPath = join(temporary, "engine.sqlite"),
      artifactDir = join(temporary, "artifacts"),
      requestFetch = runtime.fetch ?? globalThis.fetch;
    const captureFetch = async (url, init) => {
      if (report.actualRequests.length >= options.maxRequests)
        fail("VERIFY_REQUEST_BUDGET");
      const target = new URL(String(url));
      if (
        options.live &&
        (target.origin !== "https://api.openai.com" ||
          !["/v1/chat/completions", "/v1/responses"].includes(target.pathname))
      )
        fail("VERIFY_ENDPOINT_INVALID");
      const body = JSON.parse(String(init.body)),
        answer = answers.get(
          body.model +
            ":" +
            (body.modalities?.includes("audio") ? "output" : "input"),
        );
      const observation = {
        ordinal: report.actualRequests.length + 1,
        protocol: target.pathname.endsWith("/responses") ? "responses" : "chat",
        modelId: body.model,
        bodyBytes: Buffer.byteLength(String(init.body)),
        bodySha256: hash(String(init.body)),
        recognitionExpectedAbsent: answer
          ? Boolean(assertAnswerAbsent(body, answer))
          : null,
        status: null,
      };
      const probe =
        target.pathname.endsWith("/responses") && videoProbes.get(body.model);
      if (probe) {
        const content = body.input.flatMap((item) =>
            Array.isArray(item.content) ? item.content : [],
          ),
          images = content.filter((item) => item.type === "input_image");
        if (images.length !== 3) fail("VERIFY_VIDEO_WIRE_INVALID");
        const wireFrames = images.map((image, index) => {
          const png = inspectProbePng(
              image.image_url,
              probe.colors[index],
              options.videoProbeSize,
            ),
            notice = content[content.indexOf(image) - 1];
          if (
            notice?.type !== "input_text" ||
            !notice.text.startsWith("[Moodcode quoted media DATA v1]\n")
          )
            fail("VERIFY_VIDEO_WIRE_INVALID");
          let metadata;
          try {
            metadata = JSON.parse(
              notice.text.slice("[Moodcode quoted media DATA v1]\n".length),
            );
          } catch {
            fail("VERIFY_VIDEO_WIRE_INVALID");
          }
          if (
            metadata.authority !== "untrusted-media" ||
            metadata.sourceId !== probe.ref.id ||
            metadata.sourceSha256 !== probe.audit.sourceSha256 ||
            metadata.decoder !== "avi-rgb24-v1" ||
            metadata.assetSha256 !== png.sha256 ||
            metadata.mimeType !== "image/png" ||
            metadata.startMs !== index * 500 ||
            metadata.endMs !== (index + 1) * 500
          )
            fail("VERIFY_VIDEO_WIRE_INVALID");
          return { ...png, startMs: metadata.startMs, endMs: metadata.endMs };
        });
        observation.videoProbe = {
          ...probe.audit,
          nativeSourceId: probe.ref.id,
          nativeAttachmentSha256: hash(JSON.stringify(probe.ref)),
          wireFrames,
        };
      }
      report.actualRequests.push(observation);
      const response = await requestFetch(url, { ...init, redirect: "error" });
      observation.status = response.status;
      const contentType = response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      observation.responseContentType = [
        "text/event-stream",
        "application/json",
      ].includes(contentType)
        ? contentType
        : contentType
          ? "other"
          : "missing";
      if (
        response.redirected ||
        (options.live &&
          (!response.url ||
            new URL(response.url).origin !== "https://api.openai.com"))
      ) {
        await response.body?.cancel();
        fail("VERIFY_ENDPOINT_INVALID");
      }
      return response;
    };
    const specs = [],
      providers = [];
    const add = (id, modelId, audioOutput, videoFrames) => {
      const spec = {
        providerId: id,
        modelId,
        contextWindow: 128000,
        maxOutputTokens: 2048,
        modalities: videoFrames
          ? ["text", "image", "video"]
          : ["text", "audio"],
        mediaCapabilities: {
          audioInput: !videoFrames,
          videoFrames,
          audioOutput,
        },
        tools: false,
        reasoning: false,
        nativeReplay: false,
        source: {
          kind:
            options.live && report.transport === "real-remote"
              ? "host"
              : "fixture",
          observedAt: report.observedAt,
          reference: options["capability-reference"],
        },
      };
      specs.push(spec);
      const transport = videoFrames
        ? new api.ResponsesProvider({
            id,
            baseURL: options.endpoint,
            apiKey,
            videoModelIds: [modelId],
            fetch: captureFetch,
            timeoutMs: 45000,
          })
        : new api.OpenAICompatibleProvider({
            id,
            baseURL: options.endpoint,
            apiKey,
            audioModelIds: [modelId],
            includeStreamObfuscation: false,
            allowEmptyAudioMetadata: true,
            allowAudioExpiryCompletion: true,
            ...(audioOutput
              ? {
                  outputAudio: {
                    modelIds: [modelId],
                    voice: options.voice,
                    sampleRate: options.sampleRate,
                    channels: options.channels,
                  },
                }
              : {}),
            fetch: captureFetch,
            timeoutMs: 45000,
            onMalformedStream: (diagnostic) => {
              report.streamDiagnostics.push({
                providerId: id,
                modelId,
                ...diagnostic,
              });
            },
          });
      providers.push({
        id: transport.id,
        inputModalities: transport.inputModalities,
        replayProtocol: transport.replayProtocol,
        retryableHttpStatuses: transport.retryableHttpStatuses,
        supportsInputMedia: transport.supportsInputMedia.bind(transport),
        requestedOutputMedia: transport.requestedOutputMedia?.bind(transport),
        async *streamTurn(request, signal) {
          const native = engine.store.getAttemptCleanup(
            request.attemptId,
            request.sessionId,
          );
          for (const key of [
            "runId",
            "sessionId",
            "turnId",
            "attemptId",
            "modelId",
          ])
            assert.equal(native[key], request[key]);
          assert.equal(native.providerId, transport.id);
          assert.equal(native.state, "dispatched");
          const owner = {
            workspaceId: native.workspaceId,
            sessionId: native.sessionId,
            runId: native.runId,
            turnId: native.turnId,
            attemptId: native.attemptId,
            providerId: native.providerId,
            modelId: native.modelId,
            requestSha256: native.requestSha256,
          };
          observations.push({
            ...owner,
            ownerSha256: hash(JSON.stringify(owner)),
          });
          observedEngines.set(owner.attemptId, engine);
          for await (const event of transport.streamTurn(request, signal)) {
            yield event;
            if (
              event.type === "media.delta" &&
              request.sessionId === cancelSession
            )
              engine.coordinator.cancel(request.runId);
          }
        },
      });
      return id;
    };
    let cancelSession = null;
    const generationId = options.audio
      ? add("verify-audio-output", options["audio-model"], true, false)
      : null;
    const recognitionId = options.audio
      ? add("verify-audio-input", options["audio-model"], false, false)
      : null;
    const videoId = options.video
      ? add("verify-video-frames", options["video-model"], false, true)
      : null;
    report.configuration = {
      audioModelId: options["audio-model"] ?? null,
      videoModelId: options["video-model"] ?? null,
      videoProbe: report.videoProbe,
      chatStreamObfuscation: options.audio ? false : null,
      chatEmptyAudioMetadata: options.audio
        ? "explicit host compatibility; exact prior stream tuple and scalar metadata only"
        : null,
      chatAudioCompletion: options.audio
        ? "explicit host compatibility; exact stream tuple, PCM, expiry, final usage and DONE; no tool calls"
        : null,
      capabilitiesSha256: hash(JSON.stringify(specs)),
      capabilityReferenceSha256: hash(options["capability-reference"]),
      outputLayout: options.audio
        ? {
            sampleRate: options.sampleRate,
            channels: options.channels,
            bits: 16,
            provenance:
              "explicit-host-declaration; not inferred from Realtime/TTS or account success",
          }
        : null,
      tokenCost: null,
      unknownMediaTokenCostAllowed: true,
      providerAttemptsPerTurn: 1,
    };
    const engineOptions = {
      dbPath,
      artifactDir,
      providers,
      tools: [],
      modelSpecs: specs,
      allowUnknownMediaTokenCost: true,
      defaults: {
        providerId: generationId ?? videoId,
        modelId: options.audio
          ? options["audio-model"]
          : options["video-model"],
        limits: {
          maxTurns: 1,
          maxToolCalls: 1,
          maxContextBytes: 1048576,
          maxOutputBytes: 1048576,
          maxDurationMs: 60000,
        },
        budgets: {
          maxProviderAttempts: 1,
          providerRequestTimeoutMs: 45000,
          providerInactivityTimeoutMs: 10000,
          maxArtifactBytes: 524288,
          maxProducerBytes: 524288,
        },
      },
    };
    engine = api.createEngine(engineOptions);
    engines.push(engine);
    const opened = await engine.dispatch({
      schemaVersion: 1,
      commandId: randomUUID(),
      type: "workspace.open",
      payload: { path: join(temporary, "repository") },
    });
    assert.equal(opened.ok, true);
    const workspaceId = opened.result.id;
    const session = async () => {
      const response = await engine.dispatch({
        schemaVersion: 1,
        commandId: randomUUID(),
        type: "session.create",
        payload: { workspaceId },
      });
      assert.equal(response.ok, true);
      sessions.push(response.result.id);
      return response.result.id;
    };
    const submit = async (
      sessionId,
      providerId,
      modelId,
      prompt,
      media = [],
      requestId = randomUUID(),
    ) => {
      const payload = {
        sessionId,
        requestId,
        prompt,
        media,
        delivery: "queue",
        config: { providerId, modelId, budgets: { maxProviderAttempts: 1 } },
      };
      const result = await engine.dispatchSession({
        schemaVersion: 2,
        commandId: randomUUID(),
        type: "input.accept",
        payload,
      });
      if (!result.ok) fail(result.error.code);
      await engine.scheduler.waitForSession(sessionId);
      const runId = engine.store.getInput(result.result.inputId).runId;
      const run = await engine.coordinator.waitForRun(runId);
      let evidence;
      try {
        evidence = nativeEvidence(engine, run, observations);
        for (const attempt of evidence.attempts)
          cleanupProofs.set(attempt.attemptId, attempt.cleanup);
      } catch {
        physicalUnknown = true;
        fail("VERIFY_NATIVE_EVIDENCE_UNAVAILABLE");
      }
      report.scopeCoverage.push({
        caseId: activeCase,
        state:
          run.state === "completed"
            ? "observed-complete"
            : "observed-noncomplete",
        native: evidence,
        accountVerified: false,
      });
      if (
        evidence.attempts.some((a) => a.cleanup.confirmed !== true) ||
        run.state === "uncertain" ||
        run.cleanupUncertainty ||
        /UNCERTAIN/u.test(run.error?.code ?? "")
      )
        physicalUnknown = true;
      return { run, payload, receipt: result.result, evidence };
    };
    const checkDuplicate = async (accepted, modality) => {
      activeCase = modality + "-duplicate-input";
      const count = report.actualRequests.length;
      const beforeInput = engine.store.getInput(accepted.receipt.inputId);
      const beforeEvidence = nativeEvidence(
        engine,
        engine.store.getRun(accepted.run.id),
        observations,
      );
      const duplicate = await engine.dispatchSession({
        schemaVersion: 2,
        commandId: randomUUID(),
        type: "input.accept",
        payload: accepted.payload,
      });
      assert.equal(duplicate.ok, true);
      assert.equal(duplicate.result.inputId, accepted.receipt.inputId);
      await engine.scheduler.waitForSession(accepted.run.sessionId);
      assert.deepEqual(
        engine.store.getInput(duplicate.result.inputId),
        beforeInput,
      );
      assert.deepEqual(
        nativeEvidence(
          engine,
          engine.store.getRun(accepted.run.id),
          observations,
        ),
        beforeEvidence,
      );
      assert.equal(report.actualRequests.length, count);
      report.scopeCoverage.push({
        caseId: "duplicate-input",
        modality,
        state: "passed",
        sessionId: accepted.run.sessionId,
        inputId: duplicate.result.inputId,
        runId: accepted.run.id,
        inputSha256: hash(JSON.stringify(beforeInput)),
        nativeSha256: hash(JSON.stringify(beforeEvidence)),
        sameNativeIdentity: true,
        requests: 0,
        accountVerified: false,
      });
    };
    // Run independent actual import/admission checks for every selected provider path.
    // Each records the exact native error and checks zero new transport/Attempt effects.
    const silence = pcmWave(Buffer.alloc(4800), 24000, 1);
    const videoBytes = colorAvi(
      [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
      ],
      options.videoProbeSize,
    );
    for (const lane of [
      ...(options.audio
        ? [
            {
              modality: "audio",
              bytes: silence,
              mime: "audio/wav",
              invalidMime: "video/x-msvideo",
              endMs: 100,
              providerId: recognitionId,
              modelId: options["audio-model"],
            },
          ]
        : []),
      ...(options.video
        ? [
            {
              modality: "video",
              bytes: videoBytes,
              mime: "video/x-msvideo",
              invalidMime: "audio/wav",
              endMs: 1500,
              providerId: videoId,
              modelId: options["video-model"],
            },
          ]
        : []),
    ]) {
      activeCase = lane.modality + "-local-admission";
      const negative = await session();
      const baselineRequests = report.actualRequests.length,
        baselineAttempts = observations.length;
      const segments = [{ startMs: 0, endMs: lane.endMs }];
      const recordNegative = (caseId, code) => {
        assert.equal(report.actualRequests.length, baselineRequests);
        assert.equal(observations.length, baselineAttempts);
        report.scopeCoverage.push({
          caseId,
          modality: lane.modality,
          providerId: lane.providerId,
          selectedModelId: lane.modelId,
          modelId:
            caseId === "unknown-capability"
              ? "undeclared-verification-model"
              : lane.modelId,
          state: "passed",
          code,
          requests: 0,
          attempts: 0,
          accountVerified: false,
        });
      };
      for (const [caseId, bytes, mime, expectedCode] of [
        ["invalid-mime", lane.bytes, lane.invalidMime, "MEDIA_INVALID_SOURCE"],
        [
          "oversize-source",
          Buffer.alloc(524289),
          lane.mime,
          "MEDIA_LIMIT_EXCEEDED",
        ],
      ]) {
        let actualCode;
        await assert.rejects(
          engine.importMedia(negative, bytes, mime, segments),
          (error) => {
            actualCode = errorCode(error);
            assert.equal(actualCode, expectedCode);
            return true;
          },
        );
        recordNegative(caseId, actualCode);
      }
      const ref = await engine.importMedia(
        negative,
        lane.bytes,
        lane.mime,
        segments,
      );
      const unknown = await engine.dispatchSession({
        schemaVersion: 2,
        commandId: randomUUID(),
        type: "input.accept",
        payload: {
          sessionId: negative,
          requestId: "unknown",
          prompt: "Inspect this recording",
          media: [ref],
          delivery: "queue",
          config: {
            providerId: lane.providerId,
            modelId: "undeclared-verification-model",
            budgets: { maxProviderAttempts: 1 },
          },
        },
      });
      assert.equal(unknown.ok, false);
      assert.equal(unknown.error.code, "PROVIDER_UNSUPPORTED_INPUT");
      recordNegative("unknown-capability", unknown.error.code);
      const blob = join(artifactDir, "input-segments", ref.id + ".blob");
      const sourceBytes = await readFile(blob);
      await unlink(blob);
      const lost = await engine.dispatchSession({
        schemaVersion: 2,
        commandId: randomUUID(),
        type: "input.accept",
        payload: {
          sessionId: negative,
          requestId: "lost",
          prompt: "Inspect this recording",
          media: [ref],
          delivery: "queue",
          config: {
            providerId: lane.providerId,
            modelId: lane.modelId,
            budgets: { maxProviderAttempts: 1 },
          },
        },
      });
      assert.equal(lost.ok, false);
      assert.equal(lost.error.code, "MEDIA_STORAGE_FAILED");
      await writeFile(blob, sourceBytes, { flag: "wx", mode: 0o600 });
      recordNegative("source-loss", lost.error.code);
    }
    if (options.audio) {
      const words = [
        "amber",
        "otter",
        "canyon",
        "velvet",
        "cobalt",
        "maple",
        "silver",
        "falcon",
        "meadow",
        "crystal",
        "willow",
        "tulip",
      ];
      const selected = [];
      while (selected.length < 3) {
        const word = words[randomInt(words.length)];
        if (!selected.includes(word)) selected.push(word);
      }
      const expected = selected.join(" ");
      const generatedSession = await session();
      activeCase = "audio-output-native";
      const generated = await submit(
        generatedSession,
        generationId,
        options["audio-model"],
        "Speak these three words clearly, once, and nothing else: " + expected,
      );
      if (generated.run.state !== "completed")
        fail(generated.run.error?.code ?? "VERIFY_GENERATION_INCOMPLETE");
      const output = parts(engine, generated.run.id).find(
        (part) => part.type === "media",
      );
      assert.ok(
        output &&
          output.state === "completed" &&
          output.artifact.complete &&
          output.artifact.identity.source === "provider" &&
          !Object.hasOwn(output.artifact.identity, "toolCallId"),
      );
      const bytes = await readOutput(engine, output),
        decoded = inspectWave(bytes);
      assert.equal(decoded.sampleRate, options.sampleRate);
      assert.equal(decoded.channels, options.channels);
      report.scopeCoverage.at(-1).output = {
        partId: output.id,
        artifactSha256: hash(bytes),
        pcmSha256: hash(decoded.pcm),
        pcmBytes: decoded.pcm.length,
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
      };
      await engine.close();
      engine = api.createEngine(engineOptions);
      engines.push(engine);
      assert.deepEqual(
        parts(engine, generated.run.id).find((p) => p.type === "media"),
        output,
      );
      report.scopeCoverage.at(-1).state = "passed";
      const recognizedSession = await session();
      assert.notEqual(recognizedSession, generatedSession);
      const endMs = Math.floor(decoded.durationMs);
      if (endMs < 1) fail("VERIFY_AUDIO_TOO_SHORT");
      const input = await engine.importMedia(
        recognizedSession,
        bytes,
        "audio/wav",
        [{ startMs: 0, endMs }],
      );
      assert.equal(input.sha256, output.artifact.sha256);
      answers.set(options["audio-model"] + ":input", expected);
      activeCase = "audio-fresh-recognition";
      const recognition = await submit(
        recognizedSession,
        recognitionId,
        options["audio-model"],
        "Transcribe only the words spoken in this recording. Return those words in their original order, separated by spaces, without explanation.",
        [input],
      );
      if (recognition.run.state !== "completed")
        fail(recognition.run.error?.code ?? "VERIFY_RECOGNITION_INCOMPLETE");
      recordRecognition(
        report,
        engine.store.getLastRunAssistantContent(recognition.run.id),
        expected,
        {
          freshSession: true,
          sourceSha256: input.sha256,
          selectedEndMs: endMs,
        },
      );
      await checkDuplicate(recognition, "audio");
      cancelSession = await session();
      activeCase = "audio-partial-cancel";
      answers.delete(options["audio-model"] + ":input");
      const cancelled = await submit(
        cancelSession,
        generationId,
        options["audio-model"],
        "Speak a sequence of short words slowly for several seconds.",
      );
      const prefix = parts(engine, cancelled.run.id).find(
        (p) => p.type === "media",
      );
      if (
        cancelled.run.state !== "cancelled" ||
        !prefix ||
        prefix.artifact.complete ||
        prefix.artifact.outcome !== "interrupted"
      )
        fail("VERIFY_CANCEL_NOT_OBSERVED");
      const prefixBytes = await readOutput(engine, prefix);
      report.scopeCoverage.at(-1).state = "passed";
      report.scopeCoverage.at(-1).partial = {
        partId: prefix.id,
        artifactSha256: hash(prefixBytes),
        bytes: prefixBytes.length,
        complete: false,
        partState: prefix.state,
        cleanupConfirmed: cancelled.evidence.attempts.every(
          (a) => a.cleanup.confirmed === true,
        ),
      };
      cancelSession = null;
    }
    if (options.video) {
      const palette = [
          ["red", [255, 0, 0]],
          ["green", [0, 255, 0]],
          ["blue", [0, 0, 255]],
          ["yellow", [255, 255, 0]],
        ],
        selected = [];
      while (selected.length < 3) {
        const item = palette[randomInt(palette.length)];
        if (!selected.includes(item)) selected.push(item);
      }
      const expected = selected.map((item) => item[0]).join(" "),
        colors = selected.map((item) => item[1]),
        bytes = colorAvi(colors, options.videoProbeSize),
        audit = inspectColorAvi(bytes, colors, options.videoProbeSize),
        s = await session();
      const ref = await engine.importMedia(s, bytes, "video/x-msvideo", [
        { startMs: 0, endMs: 1500 },
      ]);
      const storedSource = await readFile(
        join(artifactDir, "input-segments", ref.id + ".blob"),
      );
      if (
        ref.sha256 !== audit.sourceSha256 ||
        ref.bytes !== bytes.length ||
        ref.decoder !== "avi-rgb24-v1" ||
        !storedSource.equals(bytes) ||
        hash(storedSource) !== audit.sourceSha256
      )
        fail("VERIFY_VIDEO_SOURCE_INVALID");
      videoProbes.set(options["video-model"], { audit, colors, ref });
      answers.set(options["video-model"] + ":input", expected);
      activeCase = "video-frame-recognition";
      const recognized = await submit(
        s,
        videoId,
        options["video-model"],
        "Name the predominant color of each video frame in temporal order using English color names. Return only the three color names separated by spaces.",
        [ref],
      );
      const input = engine.store.getInput(recognized.receipt.inputId);
      if (
        JSON.stringify(input.media) !== JSON.stringify([ref]) ||
        JSON.stringify(recognized.run.media) !== JSON.stringify([ref])
      )
        fail("VERIFY_VIDEO_SOURCE_INVALID");
      report.scopeCoverage.at(-1).inputProfile = {
        ...audit,
        nativeSourceId: ref.id,
        nativeAttachmentSha256: hash(JSON.stringify(ref)),
        nativeInputMediaSha256: hash(JSON.stringify(input.media)),
        nativeRunMediaSha256: hash(JSON.stringify(recognized.run.media)),
      };
      if (recognized.run.state !== "completed")
        fail(recognized.run.error?.code ?? "VERIFY_RECOGNITION_INCOMPLETE");
      recordRecognition(
        report,
        engine.store.getLastRunAssistantContent(recognized.run.id),
        expected,
        {
          decoder: ref.decoder,
          sourceSha256: ref.sha256,
          timestamps: [0, 500, 1000],
          expectedColors: selected.map((item) => item[0]),
        },
      );
      await checkDuplicate(recognized, "video");
    }
    const count = report.actualRequests.length,
      nativeBefore = sessions.map((id) => ({
        id,
        messages: hash(
          JSON.stringify(
            engine.store.readModelHistory(id, 512, 1048576).snapshot,
          ),
        ),
        control: engine.store.getSessionControl(id),
      }));
    await engine.close();
    engine = null;
    await api.exportEngineArchive({
      dbPath,
      artifactDir,
      destination: join(temporary, "archive"),
    });
    const imported = await api.importEngineArchive({
      directory: join(temporary, "archive"),
      destination: join(temporary, "imported"),
    });
    engine = api.createEngine({
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
      providers: [],
      tools: [],
    });
    engines.push(engine);
    for (const s of nativeBefore) {
      assert.equal(
        hash(
          JSON.stringify(
            engine.store.readModelHistory(s.id, 512, 1048576).snapshot,
          ),
        ),
        s.messages,
      );
      assert.equal(engine.store.getSessionControl(s.id).paused, true);
    }
    assert.equal(report.actualRequests.length, count);
    report.scopeCoverage.push({
      caseId: "restart-paused-import",
      state: "passed",
      sessions: sessions.length,
      requests: 0,
      accountVerified: false,
    });
    report.passed = !physicalUnknown;
    report.state = report.passed ? "passed" : "uncertain";
  } catch (error) {
    report.failure = errorCode(error);
    report.failureCaseId = activeCase;
    if (
      /UNCERTAIN|SQLITE|STORAGE_FAILED|ARTIFACT_WRITE_FAILED/u.test(
        report.failure,
      )
    )
      physicalUnknown = true;
    report.state = physicalUnknown ? "uncertain" : "failed";
  } finally {
    // Check each dispatched original Attempt while its store is open. Prior closed stores
    // must already have an actual captured terminal proof; missing evidence is never safe cleanup.
    for (const observation of observations) {
      if (cleanupProofs.has(observation.attemptId)) continue;
      try {
        const c = observedEngines
          .get(observation.attemptId)
          .store.getAttemptCleanup(
            observation.attemptId,
            observation.sessionId,
          );
        cleanupProofs.set(observation.attemptId, {
          state: c.state,
          confirmed: c.cleanupConfirmed,
          method: c.method,
          reason: c.reason,
        });
      } catch {
        physicalUnknown = true;
        report.cleanupFailure = "VERIFY_NATIVE_EVIDENCE_UNAVAILABLE";
      }
    }
    for (const owned of engines) {
      try {
        await owned.close();
      } catch (error) {
        physicalUnknown = true;
        report.cleanupFailure = errorCode(error);
      }
    }
    if ([...cleanupProofs.values()].some((proof) => proof.confirmed !== true))
      physicalUnknown = true;
    report.observedAttempts = observations.map(
      ({
        workspaceId,
        sessionId,
        runId,
        turnId,
        attemptId,
        providerId,
        modelId,
        requestSha256,
        ownerSha256,
      }) => ({
        workspaceId,
        sessionId,
        runId,
        turnId,
        attemptId,
        providerId,
        modelId,
        requestSha256,
        ownerSha256,
      }),
    );
    report.cleanupProofs = [...cleanupProofs].map(([attemptId, proof]) => ({
      attemptId,
      ...proof,
    }));
    try {
      report.sourceFreeze.unchanged =
        JSON.stringify(await freezeSources()) === JSON.stringify(before);
    } catch {
      report.sourceFreeze.unchanged = false;
    }
    if (frozenRuntime) {
      try {
        report.runtimeFreeze.unchanged = await checkRuntime(frozenRuntime);
      } catch {
        report.runtimeFreeze.unchanged = false;
      }
    }
    if (
      !report.sourceFreeze.unchanged ||
      report.runtimeFreeze?.unchanged === false
    ) {
      physicalUnknown = true;
      report.failure = "VERIFY_SOURCE_CHANGED";
    }
    report.cleanupConfirmed = !physicalUnknown;
    if (temporary) {
      if (physicalUnknown) report.retainedEvidenceDirectory = temporary;
      else {
        try {
          await rm(temporary, { recursive: true, force: true });
        } catch {
          report.cleanupConfirmed = false;
          report.retainedEvidenceDirectory = temporary;
        }
      }
    }
    if (!report.cleanupConfirmed) {
      report.passed = false;
      report.state = "uncertain";
    }
    report.accountVerified =
      report.passed &&
      report.cleanupConfirmed &&
      options.live === true &&
      report.transport === "real-remote";
    for (const item of report.scopeCoverage)
      item.accountVerified =
        report.accountVerified &&
        [
          "audio-output-native",
          "audio-fresh-recognition",
          "audio-partial-cancel",
          "video-frame-recognition",
        ].includes(item.caseId) &&
        item.state === "passed";
    const required = [
      ...(options.audio
        ? [
            "audio-output-native",
            "audio-fresh-recognition",
            "audio-partial-cancel",
          ]
        : []),
      ...(options.video ? ["video-frame-recognition"] : []),
    ];
    report.remainingScopes.unshift(
      ...required.filter(
        (id) =>
          !report.scopeCoverage.some(
            (item) => item.caseId === id && item.accountVerified,
          ),
      ),
    );
  }
  return report;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let report;
  try {
    report = await verifyMediaAccount(process.argv.slice(2));
  } catch (error) {
    report = {
      schemaVersion: 1,
      kind: "media-account-verification",
      state: "rejected",
      failure: errorCode(error),
      accountVerified: false,
      credentialReads: 0,
      actualRequests: [],
      cleanupConfirmed: true,
    };
  }
  if (
    report.state === "failed" ||
    report.state === "uncertain" ||
    report.state === "rejected"
  )
    process.exitCode = 1;
  const text = JSON.stringify(report, null, 2) + "\n";
  const argv = process.argv.slice(2),
    index = argv.indexOf("--report");
  if (index !== -1 && report.state !== "rejected") {
    try {
      await writeFile(argv[index + 1], text, { flag: "wx", mode: 0o600 });
    } catch {
      process.exitCode = 1;
      console.error("MEDIA_REPORT_WRITE_FAILED");
    }
  }
  console.log(text);
}
