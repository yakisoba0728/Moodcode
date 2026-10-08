import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { rm, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  verifyMediaAccount,
  parseMediaAccountArgs,
  inspectWave,
  colorAvi,
  inspectColorAvi,
} from "./verify-media-account.mjs";
const sourceEngine =
  process.env.MOODCODE_MEDIA_VERIFY_TEST_ENGINE === "compiled"
    ? import.meta.resolve("@moodcode/engine")
    : new URL("../packages/engine/src/index.ts", import.meta.url).href;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const baseArgs = [
  "--audio-model",
  "explicit-http-audio",
  "--video-model",
  "explicit-http-video",
  "--declare-audio-input-output",
  "--declare-video-frames",
  "--allow-unknown-media-token-cost",
  "--pcm-sample-rate",
  "24000",
  "--pcm-channels",
  "1",
  "--voice",
  "alloy",
  "--capability-reference",
  "local-http-fixture-host-layout",
  "--max-requests",
  "4",
];
const event = (data) => "data: " + JSON.stringify(data) + "\n\n";
const choice = (delta, finish_reason = null) => ({
  choices: [{ index: 0, delta, finish_reason }],
});
function textStream(text) {
  return (
    event(choice({ content: text })) +
    event(choice({}, "stop")) +
    event({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }) +
    "data: [DONE]\n\n"
  );
}
function responseText(text) {
  const item = {
    id: "native-local-message",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
  return [
    {
      type: "response.created",
      response: { id: "native-local-response", status: "in_progress" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: "response.content_part.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: item.content[0],
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "native-local-response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    },
  ]
    .map(event)
    .join("");
}
function frameColor(url, expectedSize = 8) {
  const bytes = Buffer.from(url.split(",")[1], "base64"),
    compressed = [];
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  let width, height;
  for (let at = 8; at < bytes.length;) {
    const n = bytes.readUInt32BE(at),
      type = bytes.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") compressed.push(bytes.subarray(at + 8, at + 8 + n));
    if (type === "IHDR") {
      width = bytes.readUInt32BE(at + 8);
      height = bytes.readUInt32BE(at + 12);
      assert.equal(bytes[at + 16], 8);
      assert.equal(bytes[at + 17], 2);
    }
    at += 12 + n;
  }
  const pixels = inflateSync(Buffer.concat(compressed));
  assert.equal(width, expectedSize);
  assert.equal(height, expectedSize);
  const stride = width * 3 + 1;
  assert.equal(pixels.length, stride * height);
  assert.equal(pixels[0], 0);
  const rgb = [...pixels.subarray(1, 4)];
  for (let y = 0; y < height; y++) {
    assert.equal(pixels[y * stride], 0);
    for (let x = 0; x < width; x++)
      assert.deepEqual(
        [...pixels.subarray(y * stride + 1 + x * 3, y * stride + 4 + x * 3)],
        rgb,
      );
  }
  const color = [...pixels.subarray(1, 4)].join(",");
  return {
    "255,0,0": "red",
    "0,255,0": "green",
    "0,0,255": "blue",
    "255,255,0": "yellow",
  }[color];
}
async function httpFixture(t, mode = "normal", probeSize = 8) {
  const requests = [],
    phraseForPcm = new Map(),
    errors = [];
  let closedCancel = 0,
    outputCount = 0;
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const pieces = [];
      for await (const chunk of incoming) {
        pieces.push(chunk);
        assert.ok(pieces.reduce((sum, b) => sum + b.length, 0) < 2097152);
      }
      const body = JSON.parse(Buffer.concat(pieces).toString());
      requests.push({ body, authorization: incoming.headers.authorization });
      if (mode === "http-error") {
        outgoing.writeHead(503);
        outgoing.end("sk-must-never-appear-in-report local error body");
        return;
      }
      outgoing.writeHead(200, { "content-type": "text/event-stream" });
      if (incoming.url.endsWith("/responses")) {
        const frames = body.input
          .flatMap((item) => item.content ?? [])
          .filter((b) => b.type === "input_image");
        assert.equal(frames.length, 3);
        const colors = frames.map((frame) =>
          frameColor(frame.image_url, probeSize),
        );
        const plaintext = body.input
          .flatMap((item) => item.content ?? [])
          .filter((item) => item.type === "input_text")
          .map((item) => item.text)
          .join("\n");
        assert.match(plaintext, /using English color names/u);
        for (const color of colors)
          assert.equal(
            new RegExp("\\b" + color + "\\b", "u").test(plaintext),
            false,
          );
        const answer =
          mode === "video-punctuation"
            ? colors.join(",")
            : mode === "video-wrong-order"
              ? colors.toReversed().join(" ")
              : mode === "video-extra-digit"
                ? colors.join(" 123 ")
                : mode === "video-extra-word"
                  ? "private-upstream-value " + colors.join(" ")
                  : mode === "video-unicode-script"
                    ? "秘密颜色 한글 кириллица"
                    : mode === "video-unicode-number"
                      ? colors.join(" ") + " ١۲３"
                      : colors.join(" ");
        outgoing.end(responseText(answer));
        return;
      }
      if (body.modalities?.includes("audio")) {
        outputCount++;
        if (mode === "malformed-audio") {
          outgoing.end(
            event(
              choice({
                audio: {
                  id: "private-remote-audio-id",
                  transcript: "private-remote-audio-transcript",
                  "private-remote-audio-key": "private-remote-audio-value",
                },
              }),
            ),
          );
          return;
        }
        const prompt = body.messages.at(-1).content;
        assert.equal(typeof prompt, "string");
        const phrase = prompt.includes("nothing else: ")
          ? prompt.split("nothing else: ")[1]
          : "fixture cancel prefix";
        const pcm = Buffer.alloc(4800);
        const seed = Buffer.from(digest(phrase), "hex");
        for (let i = 0; i < pcm.length; i++) pcm[i] = seed[i % seed.length];
        phraseForPcm.set(digest(pcm), phrase);
        const first = event(
          choice({
            audio: {
              id: "local-actual-audio-" + outputCount,
              data: pcm.subarray(0, 2400).toString("base64"),
            },
          }),
        );
        outgoing.write(first);
        if (outputCount > 1 || mode === "cancelled-generation") {
          outgoing.on("close", () => closedCancel++);
          return;
        }
        if (mode === "partial-generation") {
          outgoing.end();
          return;
        }
        outgoing.end(
          event(
            choice({
              audio: {
                data: pcm.subarray(2400).toString("base64"),
                transcript: "Generated local fixture sound",
              },
            }),
          ) +
            event(choice({}, "stop")) +
            event(choice({ audio: { expires_at: 1893456000 } })) +
            event({
              choices: [],
              usage: { prompt_tokens: 4, completion_tokens: 2 },
            }) +
            "data: [DONE]\n\n",
        );
        return;
      }
      const media = body.messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .find((b) => b.type === "input_audio");
      assert.ok(media);
      const wave = inspectWave(Buffer.from(media.input_audio.data, "base64"));
      const answer = phraseForPcm.get(digest(wave.pcm));
      assert.ok(answer);
      assert.equal(JSON.stringify(body).includes(answer), false);
      outgoing.end(
        textStream(
          mode === "wrong-recognition" ? "unrelated wrong answer" : answer,
        ),
      );
    })().catch((error) => {
      errors.push(error);
      outgoing.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  return {
    endpoint: "http://127.0.0.1:" + server.address().port + "/v1",
    requests,
    get closedCancel() {
      return closedCancel;
    },
  };
}
const fixtureArgs = (f, scenario = "all") => [
  ...baseArgs,
  "--scenario",
  scenario,
  "--fixture-endpoint",
  f.endpoint,
];
const hookRuntime = { engineModuleURL: sourceEngine };

function assertSelectedPreflights(report, modalities) {
  const expected = {
    "invalid-mime": "MEDIA_INVALID_SOURCE",
    "oversize-source": "MEDIA_LIMIT_EXCEEDED",
    "unknown-capability": "PROVIDER_UNSUPPORTED_INPUT",
    "source-loss": "MEDIA_STORAGE_FAILED",
  };
  const checks = report.scopeCoverage.filter((item) =>
    Object.hasOwn(expected, item.caseId),
  );
  assert.equal(checks.length, modalities.length * 4);
  for (const modality of modalities) {
    for (const [caseId, code] of Object.entries(expected)) {
      const matches = checks.filter(
        (item) => item.caseId === caseId && item.modality === modality,
      );
      assert.equal(matches.length, 1, modality + ":" + caseId);
      const item = matches[0];
      assert.equal(item.state, "passed");
      assert.equal(item.code, code);
      assert.equal(
        item.providerId,
        modality === "audio" ? "verify-audio-input" : "verify-video-frames",
      );
      assert.equal(item.selectedModelId, "explicit-http-" + modality);
      assert.equal(
        item.modelId,
        caseId === "unknown-capability"
          ? "undeclared-verification-model"
          : "explicit-http-" + modality,
      );
      assert.equal(item.requests, 0);
      assert.equal(item.attempts, 0);
      assert.equal(item.accountVerified, false);
    }
  }
}

function assertSelectedDuplicates(report, modalities) {
  const duplicates = report.scopeCoverage.filter(
    (item) => item.caseId === "duplicate-input",
  );
  assert.equal(duplicates.length, modalities.length);
  for (const modality of modalities) {
    const matches = duplicates.filter((item) => item.modality === modality);
    assert.equal(matches.length, 1, modality);
    const duplicate = matches[0];
    const positive = report.scopeCoverage.find(
      (item) =>
        item.caseId ===
        (modality === "audio"
          ? "audio-fresh-recognition"
          : "video-frame-recognition"),
    );
    assert.equal(duplicate.state, "passed");
    assert.equal(duplicate.inputId, positive.native.inputId);
    assert.equal(duplicate.runId, positive.native.runId);
    assert.equal(duplicate.sessionId, positive.native.sessionId);
    assert.equal(duplicate.sameNativeIdentity, true);
    assert.match(duplicate.inputSha256, /^[a-f0-9]{64}$/u);
    assert.match(duplicate.nativeSha256, /^[a-f0-9]{64}$/u);
    assert.equal(duplicate.requests, 0);
    assert.equal(duplicate.accountVerified, false);
  }
}

test("default is plan-only and invalid CLI never reads a credential or calls transport", async () => {
  let reads = 0,
    fetches = 0;
  const report = await verifyMediaAccount([], {
    readCredential: () => {
      reads++;
      throw new Error("no credentials");
    },
    fetch: () => {
      fetches++;
      throw new Error("no fetch");
    },
  });
  assert.equal(report.state, "plan-only");
  assert.equal(report.accountVerified, false);
  assert.equal(reads, 0);
  assert.equal(fetches, 0);
  assert.equal(report.actualRequests.length, 0);
  assert.deepEqual(report.videoProbe, {
    profile: "rgb24-8px-v1",
    width: 8,
    height: 8,
    stride: 24,
    frames: 3,
    modelMinimumClaimed: false,
  });
  for (const args of [
    ["--live"],
    ["--scenario", "audio", "--scenario", "video"],
    ["--max-requests", "Infinity"],
    ["--fixture-endpoint", "https://example.invalid"],
    [
      ...baseArgs,
      "--scenario",
      "video",
      "--fixture-endpoint",
      "http://127.0.0.1:1/v1",
      "--video-model",
      "gpt-audio-1.5",
    ],
  ])
    await assert.rejects(
      verifyMediaAccount(args, {
        readCredential: () => reads++,
        fetch: () => fetches++,
      }),
    );
  assert.equal(reads, 0);
  assert.equal(fetches, 0);
  const child = spawnSync(
    process.execPath,
    [new URL("./verify-media-account.mjs", import.meta.url).pathname],
    { encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).state, "plan-only");
});

test("video probe size is an explicit finite profile and invalid selections have zero credential and fetch reads", async () => {
  let reads = 0,
    fetches = 0;
  const runtime = { readCredential: () => reads++, fetch: () => fetches++ };
  for (const size of [
    "0",
    "16",
    "256",
    "08",
    "128.0",
    "Infinity",
    "-1",
    "1e2",
    "999999",
    "128x",
  ])
    await assert.rejects(
      verifyMediaAccount(["--video-probe-size", size], runtime),
      (error) => error.code === "VERIFY_INVALID_ARGUMENT",
    );
  const planned = await verifyMediaAccount(
    ["--scenario", "video", "--video-probe-size", "128"],
    runtime,
  );
  assert.equal(planned.state, "plan-only");
  assert.equal(planned.passed, false);
  assert.equal(planned.accountVerified, false);
  assert.equal(planned.actualRequests.length, 0);
  assert.equal(planned.credentialReads, 0);
  assert.deepEqual(planned.videoProbe, {
    profile: "rgb24-128px-v1",
    width: 128,
    height: 128,
    stride: 384,
    frames: 3,
    modelMinimumClaimed: false,
  });
  assert.equal(reads, 0);
  assert.equal(fetches, 0);
});

test("actual AVI profiles preserve historical 8px bytes and reject header, frame-length and pixel drift", () => {
  const colors = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ],
    legacy = colorAvi(colors);
  assert.equal(
    digest(legacy),
    "ee4c26a92691eb2c3b0f83ff53be2f45ae85b1792dd8e665124e8f5d6e3a75d6",
  );
  for (const size of [8, 128]) {
    const bytes = colorAvi(colors, size),
      audit = inspectColorAvi(bytes, colors, size);
    assert.equal(audit.width, size);
    assert.equal(audit.height, size);
    assert.equal(audit.stride, size * 3);
    assert.equal(audit.frameBytes, size * size * 3);
    assert.equal(audit.frames, 3);
    assert.equal(audit.sourceBytes, bytes.length);
    assert.ok(bytes.length < 524288);
    assert.equal(audit.sourceSha256, digest(bytes));
    assert.equal(audit.allPixelsVerified, true);
    assert.deepEqual(audit.timestamps, [0, 500, 1000]);
    const width = Buffer.from(bytes),
      length = Buffer.from(bytes),
      pixel = Buffer.from(bytes);
    width.writeInt32LE(size + 1, width.indexOf("strf") + 12);
    length.writeUInt32LE(audit.frameBytes - 1, length.indexOf("00db") + 4);
    pixel[pixel.length - 1] ^= 1;
    for (const wrong of [
      width,
      length,
      pixel,
      bytes.subarray(0, bytes.length - 1),
    ])
      assert.throws(
        () => inspectColorAvi(wrong, colors, size),
        (error) => error.code === "VERIFY_VIDEO_PROBE_INVALID",
      );
  }
  assert.throws(
    () => inspectColorAvi(legacy, colors, 128),
    (error) => error.code === "VERIFY_VIDEO_PROBE_INVALID",
  );
  assert.throws(
    () => colorAvi(colors, 256),
    (error) => error.code === "VERIFY_VIDEO_PROBE_INVALID",
  );
});

test(
  "explicit 128px probe binds actual AVI pixels and native source/input/Run to all three HTTP PNG frames with one request",
  { timeout: 20000 },
  async (t) => {
    const f = await httpFixture(t, "normal", 128);
    const args = fixtureArgs(f, "video");
    args[args.indexOf("--max-requests") + 1] = "1";
    const report = await verifyMediaAccount(
      [...args, "--video-probe-size", "128"],
      hookRuntime,
    );
    assert.equal(report.passed, true, JSON.stringify(report.failure));
    assert.equal(report.accountVerified, false);
    assert.equal(report.credentialReads, 0);
    assert.equal(report.actualRequests.length, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(report.cleanupConfirmed, true);
    assert.equal(report.sourceFreeze.unchanged, true);
    assert.equal(report.runtimeFreeze.unchanged, true);
    const positive = report.scopeCoverage.find(
        (item) => item.caseId === "video-frame-recognition",
      ),
      wire = report.actualRequests[0].videoProbe;
    assert.equal(positive.native.state, "completed");
    assert.equal(positive.state, "passed");
    assert.equal(positive.inputProfile.profile, "rgb24-128px-v1");
    assert.equal(positive.inputProfile.sourceBytes, 147704);
    assert.equal(positive.inputProfile.frameBytes, 49152);
    assert.equal(
      positive.inputProfile.nativeInputMediaSha256,
      positive.inputProfile.nativeRunMediaSha256,
    );
    assert.equal(wire.sourceSha256, positive.inputProfile.sourceSha256);
    assert.equal(
      wire.nativeAttachmentSha256,
      positive.inputProfile.nativeAttachmentSha256,
    );
    assert.equal(wire.nativeSourceId, positive.inputProfile.nativeSourceId);
    assert.equal(wire.allPixelsVerified, true);
    assert.equal(wire.wireFrames.length, 3);
    for (const frame of wire.wireFrames) {
      assert.equal(frame.width, 128);
      assert.equal(frame.height, 128);
      assert.equal(frame.allPixelsVerified, true);
      assert.equal(frame.crcVerified, true);
      assert.match(frame.sha256, /^[a-f0-9]{64}$/u);
    }
    assert.deepEqual(
      wire.wireFrames.map((frame) => frame.startMs),
      [0, 500, 1000],
    );
    assertSelectedPreflights(report, ["video"]);
    assertSelectedDuplicates(report, ["video"]);
    assert.equal(report.configuration.videoProbe.modelMinimumClaimed, false);
  },
);

test(
  "actual native video request rejects a single corrupt PNG CRC before HTTP even with matching wire asset digest",
  { timeout: 20000 },
  async (t) => {
    const f = await httpFixture(t),
      actual = await import(sourceEngine);
    let injected = 0,
      wireFailure;
    class CorruptPngProvider extends actual.ResponsesProvider {
      constructor(options) {
        super({
          ...options,
          fetch: async (url, init) => {
            const body = JSON.parse(String(init.body)),
              content = body.input.flatMap((item) =>
                Array.isArray(item.content) ? item.content : [],
              ),
              image = content.find((item) => item.type === "input_image"),
              bytes = Buffer.from(image.image_url.split(",")[1], "base64");
            assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
            const crcAt = 16 + bytes.readUInt32BE(8);
            bytes[crcAt] = bytes[crcAt] ^ 1;
            image.image_url =
              "data:image/png;base64," + bytes.toString("base64");
            const notice = content[content.indexOf(image) - 1],
              prefix = "[Moodcode quoted media DATA v1]\n",
              metadata = JSON.parse(notice.text.slice(prefix.length));
            metadata.assetSha256 = digest(bytes);
            notice.text = prefix + JSON.stringify(metadata);
            injected++;
            try {
              return await options.fetch(url, {
                ...init,
                body: JSON.stringify(body),
              });
            } catch (error) {
              wireFailure = error.code;
              throw error;
            }
          },
        });
      }
    }
    const report = await verifyMediaAccount(fixtureArgs(f, "video"), {
      ...hookRuntime,
      engineModule: { ...actual, ResponsesProvider: CorruptPngProvider },
    });
    assert.equal(injected, 1);
    assert.equal(wireFailure, "VERIFY_VIDEO_WIRE_INVALID");
    assert.equal(f.requests.length, 0);
    assert.equal(report.actualRequests.length, 0);
    assert.equal(report.passed, false);
    assert.equal(report.accountVerified, false);
    assert.equal(report.credentialReads, 0);
    assert.equal(report.cleanupConfirmed, true);
    assert.equal(report.sourceFreeze.unchanged, true);
    assert.equal(report.runtimeFreeze.unchanged, true);
    const positive = report.scopeCoverage.find(
      (item) => item.caseId === "video-frame-recognition",
    );
    assert.equal(positive.native.state, "failed");
    assert.equal(positive.native.attempts.length, 1);
    assert.deepEqual(positive.native.parts, []);
    assert.equal(positive.native.attempts[0].cleanup.confirmed, true);
    assert.equal(positive.inputProfile.allPixelsVerified, true);
    assert.equal(
      report.scopeCoverage.some((item) => item.caseId === "duplicate-input"),
      false,
    );
  },
);

test(
  "actual Engine/local HTTP audio and Responses video complete native output, fresh recognition, cancellation, duplicate and paused import",
  { timeout: 30000 },
  async (t) => {
    const f = await httpFixture(t);
    let reads = 0;
    const report = await verifyMediaAccount(fixtureArgs(f), {
      ...hookRuntime,
      readCredential: () => {
        reads++;
        throw new Error("must not read");
      },
    });
    assert.equal(
      report.passed,
      true,
      JSON.stringify({
        failure: report.failure,
        state: report.state,
        cases: report.scopeCoverage,
        cleanup: report.cleanupProofs,
      }),
    );
    assert.equal(report.state, "passed");
    assert.equal(report.accountVerified, false);
    assert.equal(report.transport, "local-fixture");
    assert.equal(reads, 0);
    assert.equal(report.cleanupConfirmed, true);
    assert.equal(report.sourceFreeze.unchanged, true);
    assert.equal(report.runtimeFreeze.unchanged, true);
    assert.equal(report.actualRequests.length, 4);
    assert.equal(f.requests.length, 4);
    assert.equal(f.closedCancel, 1);
    assert.ok(f.requests.every((r) => r.authorization === undefined));
    assert.equal(report.configuration.chatStreamObfuscation, false);
    for (const request of f.requests.filter(
      (r) => r.body.model === "explicit-http-audio",
    ))
      assert.equal(request.body.stream_options.include_obfuscation, false);
    assertSelectedPreflights(report, ["audio", "video"]);
    assertSelectedDuplicates(report, ["audio", "video"]);
    const cases = new Map(report.scopeCoverage.map((c) => [c.caseId, c]));
    for (const id of [
      "invalid-mime",
      "oversize-source",
      "unknown-capability",
      "source-loss",
      "audio-output-native",
      "audio-fresh-recognition",
      "audio-partial-cancel",
      "video-frame-recognition",
      "duplicate-input",
      "restart-paused-import",
    ])
      assert.equal(cases.get(id)?.state, "passed", id);
    const output = cases.get("audio-output-native"),
      recognition = cases.get("audio-fresh-recognition");
    assert.notEqual(output.native.sessionId, recognition.native.sessionId);
    assert.notEqual(output.native.runId, recognition.native.runId);
    assert.equal(
      output.output.artifactSha256,
      recognition.recognition.sourceSha256,
    );
    assert.equal(
      recognition.recognition.expectedSha256,
      recognition.recognition.observedSha256,
    );
    assert.equal(recognition.recognition.expectedAbsentFromFullWire, true);
    assert.ok(output.native.parts.every((part) => part.type !== "tool"));
    assert.ok(
      output.native.attempts.every(
        (a) => a.cleanup.confirmed === true && a.usage !== null,
      ),
    );
    assert.equal(cases.get("audio-partial-cancel").partial.complete, false);
    assert.equal(
      cases.get("audio-partial-cancel").partial.cleanupConfirmed,
      true,
    );
    assert.deepEqual(
      cases.get("video-frame-recognition").recognition.timestamps,
      [0, 500, 1000],
    );
    assert.ok(report.scopeCoverage.every((c) => c.accountVerified === false));
    assert.equal(
      JSON.stringify(report).includes("Generated local fixture sound"),
      false,
    );
    assert.equal(
      JSON.stringify(report).includes("unrelated wrong answer"),
      false,
    );
    assert.equal(report.retainedEvidenceDirectory, undefined);
  },
);

test(
  "video-only proves all four exact AVI admission failures and same native duplicate identity; one Responses request",
  { timeout: 20000 },
  async (t) => {
    const f = await httpFixture(t),
      report = await verifyMediaAccount(fixtureArgs(f, "video"), hookRuntime);
    assert.equal(
      report.passed,
      true,
      JSON.stringify({ failure: report.failure, cases: report.scopeCoverage }),
    );
    assert.equal(report.actualRequests.length, 1);
    assert.equal(f.requests.length, 1);
    assertSelectedPreflights(report, ["video"]);
    assertSelectedDuplicates(report, ["video"]);
    assert.equal(f.requests[0].body.model, "explicit-http-video");
    assert.equal(
      report.scopeCoverage.find((c) => c.caseId === "source-loss").code,
      "MEDIA_STORAGE_FAILED",
    );
    assert.equal(
      report.scopeCoverage.find((c) => c.caseId === "unknown-capability").code,
      "PROVIDER_UNSUPPORTED_INPUT",
    );
    assert.equal(report.accountVerified, false);
    assert.equal(report.cleanupConfirmed, true);
  },
);

test(
  "malformed audio retains only bounded structural diagnostics and genuine failed native cleanup evidence",
  { timeout: 20000 },
  async (t) => {
    const f = await httpFixture(t, "malformed-audio"),
      report = await verifyMediaAccount(fixtureArgs(f, "audio"), hookRuntime);
    assert.equal(report.passed, false);
    assert.equal(report.accountVerified, false);
    assert.equal(report.failure, "PROVIDER_MALFORMED_STREAM");
    assert.equal(report.actualRequests.length, 1);
    assert.equal(
      report.actualRequests[0].responseContentType,
      "text/event-stream",
    );
    assert.equal(report.cleanupConfirmed, true);
    assert.equal(report.streamDiagnostics.length, 1);
    assert.equal(report.streamDiagnostics[0].providerId, "verify-audio-output");
    assert.equal(report.streamDiagnostics[0].modelId, "explicit-http-audio");
    assert.ok(
      Buffer.byteLength(JSON.stringify(report.streamDiagnostics)) < 4096,
    );
    assert.equal(
      JSON.stringify(report).includes("private-remote-audio"),
      false,
    );
    const native = report.scopeCoverage.find(
      (item) => item.caseId === "audio-output-native",
    ).native;
    assert.equal(native.state, "failed");
    assert.ok(native.attempts.every((attempt) => attempt.cleanup.confirmed));
  },
);

test(
  "recognition mismatch cannot receive account credit or conceal actual completed native attempts",
  { timeout: 20000 },
  async (t) => {
    const f = await httpFixture(t, "wrong-recognition"),
      report = await verifyMediaAccount(fixtureArgs(f, "audio"), hookRuntime);
    assert.equal(report.passed, false);
    assert.equal(report.failure, "VERIFY_RECOGNITION_MISMATCH");
    assert.equal(report.accountVerified, false);
    assert.equal(report.cleanupConfirmed, true);
    assert.equal(report.actualRequests.length, 2);
    assert.equal(
      report.scopeCoverage.find((c) => c.caseId === "audio-fresh-recognition")
        .native.state,
      "completed",
    );
    assert.ok(report.remainingScopes.includes("audio-partial-cancel"));
    const recognition = report.scopeCoverage.find(
      (c) => c.caseId === "audio-fresh-recognition",
    );
    assert.equal(recognition.state, "recognition-mismatch");
    assert.equal(recognition.recognition.matched, false);
    assert.notEqual(
      recognition.recognition.expectedSha256,
      recognition.recognition.observedSha256,
    );
    assert.equal(
      JSON.stringify(report).includes("unrelated wrong answer"),
      false,
    );
  },
);

test(
  "video recognizes punctuation-separated colors without losing word boundaries",
  { timeout: 20000 },
  async (t) => {
    const f = await httpFixture(t, "video-punctuation");
    const report = await verifyMediaAccount(
      fixtureArgs(f, "video"),
      hookRuntime,
    );
    assert.equal(report.passed, true, report.failure);
    const recognition = report.scopeCoverage.find(
      (c) => c.caseId === "video-frame-recognition",
    );
    assert.equal(recognition.recognition.matched, true);
    assert.equal(recognition.recognition.tokenCount, 3);
    assert.deepEqual(
      recognition.recognition.observedTokenKinds,
      recognition.recognition.expectedColors,
    );
    assert.equal(report.actualRequests.length, 1);
    assert.equal(report.accountVerified, false);
  },
);

for (const mode of [
  "video-wrong-order",
  "video-extra-digit",
  "video-extra-word",
  "video-unicode-script",
  "video-unicode-number",
])
  test(
    "video mismatch retains bounded semantic diagnostics: " + mode,
    { timeout: 20000 },
    async (t) => {
      const f = await httpFixture(t, mode);
      const report = await verifyMediaAccount(
        fixtureArgs(f, "video"),
        hookRuntime,
      );
      assert.equal(report.failure, "VERIFY_RECOGNITION_MISMATCH");
      assert.equal(report.passed, false);
      assert.equal(report.accountVerified, false);
      assert.equal(report.actualRequests.length, 1);
      assert.equal(report.cleanupConfirmed, true);
      const recognition = report.scopeCoverage.find(
        (c) => c.caseId === "video-frame-recognition",
      );
      assert.equal(recognition.native.state, "completed");
      assert.equal(recognition.state, "recognition-mismatch");
      assert.equal(recognition.recognition.matched, false);
      assert.notEqual(
        recognition.recognition.expectedSha256,
        recognition.recognition.observedSha256,
      );
      assert.equal(recognition.recognition.tokensTruncated, false);
      const categories = recognition.recognition.characterCategories;
      assert.ok(Buffer.byteLength(JSON.stringify(categories)) < 1024);
      if (mode === "video-extra-digit") assert.ok(categories.ascii.digits > 0);
      if (mode === "video-unicode-script") {
        assert.ok(categories.scripts.han > 0);
        assert.ok(categories.scripts.hangul > 0);
        assert.ok(categories.scripts.cyrillic > 0);
        assert.equal(categories.ascii.letters, 0);
      }
      if (mode === "video-unicode-number")
        assert.equal(categories.nonAscii.numbers, 3);
      for (const forbidden of ["秘密颜色", "한글", "кириллица", "١۲３"])
        assert.equal(JSON.stringify(report).includes(forbidden), false);
      assert.equal(
        JSON.stringify(report).includes("private-upstream-value"),
        false,
      );
      assert.equal(
        report.scopeCoverage.some((c) => c.caseId === "duplicate-input"),
        false,
      );
    },
  );

test(
  "truncated HTTP audio has real interrupted Artifact/failed Part and confirmed iterator cleanup, never a recognition pass",
  { timeout: 20000 },
  async (t) => {
    const f = await httpFixture(t, "partial-generation"),
      report = await verifyMediaAccount(fixtureArgs(f, "audio"), hookRuntime);
    assert.equal(report.passed, false);
    assert.equal(report.accountVerified, false);
    assert.equal(report.actualRequests.length, 1);
    assert.equal(report.cleanupConfirmed, true);
    const native = report.scopeCoverage.find(
        (c) => c.caseId === "audio-output-native",
      ).native,
      part = native.parts.find((p) => p.type === "media");
    assert.equal(native.state, "failed");
    assert.equal(part.artifact.complete, false);
    assert.equal(part.artifact.outcome, "interrupted");
    assert.equal(part.state, "failed");
    assert.ok(native.attempts.every((a) => a.cleanup.confirmed === true));
  },
);

test(
  "503 is exactly one actual request, no retry, raw upstream failures are not reported",
  { timeout: 20000 },
  async (t) => {
    const f = await httpFixture(t, "http-error"),
      report = await verifyMediaAccount(fixtureArgs(f, "audio"), hookRuntime);
    assert.equal(report.passed, false);
    assert.equal(report.actualRequests.length, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(report.actualRequests[0].status, 503);
    assert.equal(
      JSON.stringify(report).includes("sk-must-never-appear"),
      false,
    );
    assert.equal(report.accountVerified, false);
    assert.equal(report.cleanupConfirmed, false);
    assert.equal(report.state, "uncertain");
    assert.equal(report.failure, "CLEANUP_UNCERTAIN");
    assert.ok(report.retainedEvidenceDirectory);
    await access(report.retainedEvidenceDirectory + "/engine.sqlite");
    t.after(() =>
      rm(report.retainedEvidenceDirectory, { recursive: true, force: true }),
    );
  },
);

test(
  "live with injected transport is never remote evidence and a synthetic empty URL response is rejected",
  { timeout: 20000 },
  async () => {
    let credentialReads = 0,
      fetches = 0;
    const report = await verifyMediaAccount(
      [
        ...baseArgs,
        "--scenario",
        "audio",
        "--live",
        "--api-key-env",
        "EXPLICIT_FAKE_KEY",
      ],
      {
        ...hookRuntime,
        readCredential: () => {
          credentialReads++;
          return "fixture-bearer-never-report";
        },
        fetch: async () => {
          fetches++;
          return new Response(textStream("bad"), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      },
    );
    assert.equal(credentialReads, 1);
    assert.equal(fetches, 1);
    assert.equal(report.transport, "local-fixture");
    assert.equal(report.accountVerified, false);
    assert.equal(report.passed, false);
    assert.equal(
      JSON.stringify(report).includes("fixture-bearer-never-report"),
      false,
    );
  },
);

// The only hook here intercepts genuine native proof reads in an actual source-engine instance;
// it does not fabricate a Run/Tool/context, success receipt or account evidence.
test(
  "missing genuine native cleanup proof preserves DB/Artifact and denies every level of account credit",
  { timeout: 20000 },
  async (t) => {
    const f = await httpFixture(t);
    const real = await import(sourceEngine);
    const shim = {
      ...real,
      createEngine(options) {
        const engine = real.createEngine(options);
        const original = engine.store.getAttemptCleanup.bind(engine.store);
        engine.store.getAttemptCleanup = (...args) => {
          const proof = original(...args);
          if (proof.state === "confirmed")
            throw Object.assign(new Error("native proof unavailable"), {
              code: "ERR_SQLITE_ERROR",
            });
          return proof;
        };
        return engine;
      },
    };
    const report = await verifyMediaAccount(fixtureArgs(f, "audio"), {
      ...hookRuntime,
      engineModule: shim,
    });
    // engineModule overrides are a testing-only module dependency; no production account credit.
    assert.equal(
      report.cleanupConfirmed,
      false,
      JSON.stringify({
        failure: report.failure,
        state: report.state,
        cases: report.scopeCoverage,
        cleanup: report.cleanupProofs,
      }),
    );
    assert.equal(report.state, "uncertain");
    assert.equal(report.passed, false);
    assert.equal(report.accountVerified, false);
    assert.ok(report.retainedEvidenceDirectory);
    await access(report.retainedEvidenceDirectory + "/engine.sqlite");
    assert.ok(report.scopeCoverage.every((c) => c.accountVerified === false));
    await rm(report.retainedEvidenceDirectory, {
      recursive: true,
      force: true,
    });
  },
);

test(
  "late genuine close failure keeps successful native scenario evidence but revokes all credit and retains files",
  { timeout: 20000 },
  async (t) => {
    const f = await httpFixture(t),
      real = await import(sourceEngine);
    const shim = {
      ...real,
      createEngine(options) {
        const engine = real.createEngine(options);
        if (options.dbPath.includes("/imported/")) {
          const original = engine.close.bind(engine);
          let first = true;
          engine.close = async () => {
            await original();
            if (first) {
              first = false;
              throw Object.assign(
                new Error("final native close proof unavailable"),
                { code: "CLEANUP_UNCERTAIN" },
              );
            }
          };
        }
        return engine;
      },
    };
    const report = await verifyMediaAccount(fixtureArgs(f), {
      ...hookRuntime,
      engineModule: shim,
    });
    assert.equal(report.actualRequests.length, 4);
    assert.equal(f.requests.length, 4);
    assert.equal(
      report.scopeCoverage.find((c) => c.caseId === "restart-paused-import")
        .state,
      "passed",
    );
    assert.equal(report.cleanupFailure, "CLEANUP_UNCERTAIN");
    assert.equal(report.cleanupConfirmed, false);
    assert.equal(report.state, "uncertain");
    assert.equal(report.passed, false);
    assert.equal(report.accountVerified, false);
    assert.ok(report.scopeCoverage.every((c) => c.accountVerified === false));
    assert.ok(report.retainedEvidenceDirectory);
    await access(report.retainedEvidenceDirectory + "/engine.sqlite");
    await access(report.retainedEvidenceDirectory + "/imported");
    t.after(() =>
      rm(report.retainedEvidenceDirectory, { recursive: true, force: true }),
    );
  },
);
