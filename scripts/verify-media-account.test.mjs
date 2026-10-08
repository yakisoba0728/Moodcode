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
function frameColor(url) {
  const bytes = Buffer.from(url.split(",")[1], "base64"),
    compressed = [];
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  for (let at = 8; at < bytes.length;) {
    const n = bytes.readUInt32BE(at),
      type = bytes.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") compressed.push(bytes.subarray(at + 8, at + 8 + n));
    at += 12 + n;
  }
  const pixels = inflateSync(Buffer.concat(compressed));
  assert.equal(pixels[0], 0);
  const color = [...pixels.subarray(1, 4)].join(",");
  return {
    "255,0,0": "red",
    "0,255,0": "green",
    "0,0,255": "blue",
    "255,255,0": "yellow",
  }[color];
}
async function httpFixture(t, mode = "normal") {
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
        outgoing.end(
          responseText(
            frames.map((frame) => frameColor(frame.image_url)).join(" "),
          ),
        );
        return;
      }
      if (body.modalities?.includes("audio")) {
        outputCount++;
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
  "video-only uses genuine selected AVI for source-loss and unknown model admission; one Responses request",
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
