import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, rm } from "node:fs/promises";
import { crc32, inflateSync } from "node:zlib";
import test from "node:test";
import { createEngine } from "../packages/engine/src/engine.ts";
import { createReadTools } from "../packages/engine/src/tools/read/index.ts";
import { AnthropicProvider, anthropicModelSpec } from "../packages/engine/src/provider/anthropic.ts";
import { EngineError } from "@moodcode/contracts";
import { anthropicColorProbe, verifyAnthropicCoverage } from "./verify-provider-coverage-anthropic.mjs";

const api = { createEngine, createReadTools };
const modelId = "local-anthropic-fixture";
const wire = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const start = () => ({ type: "message_start", message: { id: "msg-fixture", type: "message", role: "assistant", model: modelId, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } });
const block = (index, content, deltas) => [
  { type: "content_block_start", index, content_block: content },
  ...deltas.map((delta) => ({ type: "content_block_delta", index, delta })),
  { type: "content_block_stop", index },
];
const finish = (reason) => [
  { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
];
function probeColors(bytes) {
  const chunks = [], names = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), name = bytes.toString("ascii", offset + 4, offset + 8);
    assert.equal(bytes.readUInt32BE(offset + length + 8), crc32(bytes.subarray(offset + 4, offset + length + 8)));
    names.push(name);
    if (name === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  assert.deepEqual(names, ["IHDR", "IDAT", "IEND"]);
  assert.equal(bytes.readUInt32BE(16), 384); assert.equal(bytes.readUInt32BE(20), 128);
  const pixels = inflateSync(Buffer.concat(chunks));
  assert.equal(pixels.length, 128 * (384 * 3 + 1));
  const result = [];
  for (let tile = 0; tile < 3; tile++) {
    const expected = [...pixels.subarray(tile * 128 * 3 + 1, tile * 128 * 3 + 4)];
    const color = { "255,0,0": "red", "0,255,0": "green", "0,0,255": "blue" }[expected.join(",")];
    assert.ok(color);
    for (let y = 0; y < 128; y++) {
      assert.equal(pixels[y * (384 * 3 + 1)], 0);
      for (let x = tile * 128; x < (tile + 1) * 128; x++)
        assert.deepEqual([...pixels.subarray(y * (384 * 3 + 1) + x * 3 + 1, y * (384 * 3 + 1) + x * 3 + 4)], expected);
    }
    result.push(color);
  }
  return result;
}
async function fixture(t, mode = "complete") {
  const requests = [], errors = [];
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push({ path: incoming.url, headers: incoming.headers, body });
      assert.equal(incoming.url, "/v1/messages");
      if (mode === "http401") {
        outgoing.writeHead(401, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: { type: "authentication_error", message: "fixture-secret-must-never-leak" } })); return;
      }
      const blocks = body.messages.flatMap((message) => message.content);
      let events;
      if (blocks.some((item) => item.type === "image")) {
        const image = blocks.find((item) => item.type === "image");
        const expected = probeColors(Buffer.from(image.source.data, "base64")).join(" ");
        assert.ok(!JSON.stringify(body.messages.map((message) => message.content.filter((item) => item.type !== "image"))).includes(expected));
        events = [start(), ...block(0, { type: "text", text: "" }, [{ type: "text_delta", text: mode === "image-mismatch" ? "wrong" : expected }]), ...finish("end_turn")];
      } else if (blocks.some((item) => item.type === "tool_result")) {
        const toolResult = blocks.find((item) => item.type === "tool_result");
        const nonce = toolResult.content.match(/probe-[a-f0-9-]{36}/u)?.[0];
        assert.ok(nonce);
        const replay = blocks.find((item) => item.type === "thinking");
        assert.deepEqual(replay, { type: "thinking", thinking: "", signature: "opaque-fixture-signature" });
        events = [start(), ...block(0, { type: "text", text: "" }, [{ type: "text_delta", text: mode === "text-mismatch" ? "wrong" : nonce }]), ...finish("end_turn")];
      } else {
        assert.ok(!JSON.stringify(body).includes("probe-"));
        events = [start(), ...block(0, { type: "thinking", thinking: "", signature: "" }, [{ type: "signature_delta", signature: "opaque-fixture-signature" }]),
          ...block(1, { type: "tool_use", id: "toolu-read", name: "read_file", input: {} }, [{ type: "input_json_delta", partial_json: '{"path":"challenge.txt"}' }]), ...finish("tool_use")];
      }
      if (mode === "truncated") events.pop();
      if (mode === "usage-missing") events.find((event) => event.type === "message_delta").usage.output_tokens = 0;
      outgoing.writeHead(200, { "content-type": "text/event-stream" }); outgoing.end(wire(events));
    })().catch((error) => { errors.push(error); outgoing.destroy(); });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections(); await new Promise((done) => server.close(done));
    assert.deepEqual(errors, []);
  });
  return { requests, options: { api, AnthropicProvider, anthropicModelSpec, modelId, baseURL: `http://127.0.0.1:${server.address().port}/v1`, capabilityReference: "https://platform.claude.com/docs/en/models/overview", qualification: { transport: "local-fixture" } } };
}

test("color probe contains only complete authored pixels and CRC-checked PNG chunks", () => {
  for (const order of [["red", "green", "blue"], ["blue", "red", "green"], ["green", "blue", "red"]]) {
    const bytes = anthropicColorProbe(order); assert.deepEqual(probeColors(bytes), order);
    assert.ok(bytes.length < 524288);
  }
  assert.throws(() => anthropicColorProbe(["red", "red", "blue"]), { code: "VERIFY_INVALID_PROBE" });
});
test("actual source Engine/local HTTP produces exact native Tool/Parts/replay/usage; duplicates cost zero requests", { timeout: 30000 }, async (t) => {
  const f = await fixture(t), report = await verifyAnthropicCoverage(f.options);
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.state, "passed"); assert.equal(report.cleanupConfirmed, true);
  assert.equal(report.verifierUnchanged, true); assert.equal(report.accountVerified, false);
  assert.equal(report.accountQualificationEligible, false); assert.equal(report.retainedEvidenceDirectory, undefined);
  assert.equal(report.actualRequests.length, 3); assert.equal(f.requests.length, 3);
  assert.ok(f.requests.every((request) => request.headers["x-api-key"] === undefined));
  assert.ok(report.actualRequests.every((request) => request.modelId === modelId && request.requestSha256.length === 64));
  const text = report.scopeCoverage.find((scope) => scope.caseId === "text-tool-replay");
  assert.equal(text.native.attempts.length, 2); assert.equal(text.native.tools.length, 1);
  assert.equal(text.native.tools[0].state, "completed"); assert.equal(text.native.replay[0].types[0], "thinking");
  assert.ok(text.native.parts.some((part) => part.type === "tool"));
  assert.equal(text.recognition.matched, true); assert.equal(text.recognition.expectedAbsentFromInitialWire, true);
  assert.equal(report.actualRequests[1].replayMatch, true);
  const image = report.scopeCoverage.find((scope) => scope.caseId === "image-recognition");
  assert.notEqual(text.native.sessionId, image.native.sessionId);
  assert.equal(image.native.attempts.length, 1); assert.equal(image.recognition.matched, true);
  assert.equal(image.recognition.expectedAbsentFromFullWire, true);
  assert.ok(image.native.parts.every((part) => part.type === "text"));
  assert.equal(report.scopeCoverage.filter((scope) => scope.caseId === "duplicate-input" && scope.requests === 0 && scope.sameNativeIdentity).length, 2);
  assert.ok(report.cleanupProofs.every((proof) => proof.confirmed));
  assert.ok(report.observedAttempts.every((attempt) => attempt.ownerSha256.length === 64));
  assert.ok(!JSON.stringify(report).includes("opaque-fixture-signature"));
  assert.ok(!JSON.stringify(report).includes("probe-"));
});
for (const [mode, error, requestCount] of [["http401", "PROVIDER_HTTP_ERROR", 1], ["truncated", "PROVIDER_INCOMPLETE_STREAM", 1], ["usage-missing", "VERIFY_USAGE_MISSING", 2], ["text-mismatch", "VERIFY_RECOGNITION_MISMATCH", 2], ["image-mismatch", "VERIFY_RECOGNITION_MISMATCH", 3]])
  test(`actual native ${mode} preserves original failure, requests and cleanup without account credit`, { timeout: 30000 }, async (t) => {
    const f = await fixture(t, mode), report = await verifyAnthropicCoverage(f.options);
    assert.equal(report.passed, false, JSON.stringify(report)); assert.equal(report.state, "failed");
    assert.equal(report.failure, error); assert.equal(report.actualRequests.length, requestCount);
    assert.equal(f.requests.length, requestCount); assert.equal(report.cleanupConfirmed, true);
    assert.equal(report.accountVerified, false); assert.equal(report.accountQualificationEligible, false);
    assert.equal(report.retainedEvidenceDirectory, undefined);
    const native = report.scopeCoverage.at(-1).native; assert.ok(native.attempts.length > 0);
    assert.ok(native.attempts.every((attempt) => attempt.cleanup.confirmed));
    if (mode === "http401" || mode === "truncated") {
      assert.equal(native.errorCode, error); assert.equal(report.originalNativeErrorCode, error);
      assert.equal(native.tools.length, 0); assert.ok(!native.parts.some((part) => part.type === "tool"));
    } else assert.equal(native.state, "completed");
    assert.ok(!JSON.stringify(report).includes("fixture-secret-must-never-leak"));
    if (mode.endsWith("mismatch")) assert.equal(report.scopeCoverage.at(-1).recognition.matched, false);
  });
test("rejected credentials/qualification/budget cannot dispatch a request or discover auth", async () => {
  let calls = 0;
  const options = { api, AnthropicProvider, anthropicModelSpec, modelId, fetch: async () => { calls++; throw new Error("must not call"); } };
  for (const extra of [{ maxRequests: 4 }, { maxRequests: 1 }, { baseURL: "https://wrong.invalid/v1" }, { apiKey: "secret", qualification: { transport: "local-fixture", accountReference: "secret" } }, { qualification: { transport: "real-remote" } }])
    await assert.rejects(verifyAnthropicCoverage({ ...options, ...extra }), (error) => /^VERIFY_/u.test(error.code));
  assert.equal(calls, 0);
});
test("actual Engine close failure revokes success and retains native artifacts for review", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const report = await verifyAnthropicCoverage({ ...f.options, api: { ...api, createEngine(options) {
    const engine = createEngine(options), original = engine.close.bind(engine);
    engine.close = async () => { await original(); throw Object.assign(new Error("close proof failed"), { code: "CLEANUP_UNCERTAIN" }); };
    return engine;
  } } });
  assert.equal(report.passed, false); assert.equal(report.state, "uncertain");
  assert.equal(report.cleanupConfirmed, false); assert.equal(report.cleanupFailure, "CLEANUP_UNCERTAIN");
  assert.equal(report.accountVerified, false); assert.equal(report.accountQualificationEligible, false);
  assert.equal(report.actualRequests.length, 3); assert.ok(report.scopeCoverage.every((scope) => scope.state === "passed"));
  assert.ok(report.retainedEvidenceDirectory);
  await access(report.retainedEvidenceDirectory);
  t.after(() => rm(report.retainedEvidenceDirectory, { recursive: true, force: true }));
});
for (const mode of ["confirmed", "rejected", "unjoinable"])
  test(`endpoint mismatch owns ${mode} received-body cleanup before rejecting native execution`, { timeout: 10000 }, async (t) => {
    let cancellations = 0;
    const body = new ReadableStream({ cancel() {
      cancellations++;
      if (mode === "rejected") return Promise.reject(new Error("fixture rejected cancellation"));
      if (mode === "unjoinable") return new Promise(() => {});
    } });
    const report = await verifyAnthropicCoverage({
      api, AnthropicProvider, anthropicModelSpec, modelId, apiKey: "fixture-injected-key",
      qualification: { transport: "real-remote", accountReference: "fixture-account", sourceSha256: "a".repeat(64), runtimeSha256: "b".repeat(64) },
      fetch: async () => {
        const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
        Object.defineProperty(response, "url", { value: "https://unrelated.invalid/messages" });
        return response;
      },
    });
    assert.equal(cancellations, 1); assert.equal(report.actualRequests.length, 1);
    assert.equal(report.passed, false); assert.equal(report.accountVerified, false);
    assert.equal(report.accountQualificationEligible, false);
    assert.equal(report.actualRequests[0].rejectedBodyCleanupConfirmed, mode === "confirmed");
    assert.equal(report.failure, mode === "confirmed" ? "VERIFY_ENDPOINT_INVALID" : "CLEANUP_UNCERTAIN");
    assert.equal(report.originalNativeErrorCode, report.failure);
    assert.equal(report.state, mode === "confirmed" ? "failed" : "uncertain");
    assert.equal(report.cleanupConfirmed, mode === "confirmed");
    assert.equal(report.scopeCoverage[0].native.tools.length, 0);
    assert.equal(report.scopeCoverage[0].native.parts.length, 0);
    if (mode === "confirmed") assert.equal(report.retainedEvidenceDirectory, undefined);
    else {
      assert.ok(report.retainedEvidenceDirectory); await access(report.retainedEvidenceDirectory);
      t.after(() => rm(report.retainedEvidenceDirectory, { recursive: true, force: true }));
    }
  });
test("host capture cleanup uncertainty survives provider sanitization and preserves native quarantine", { timeout: 10000 }, async (t) => {
  const report = await verifyAnthropicCoverage({ api, AnthropicProvider, anthropicModelSpec, modelId,
    fetch: async () => { throw new EngineError("CLEANUP_UNCERTAIN", "Host owns an unjoinable response body"); },
  });
  assert.equal(report.passed, false); assert.equal(report.state, "uncertain");
  assert.equal(report.failure, "CLEANUP_UNCERTAIN"); assert.equal(report.originalNativeErrorCode, "CLEANUP_UNCERTAIN");
  assert.equal(report.actualRequests[0].errorCode, "CLEANUP_UNCERTAIN");
  assert.equal(report.actualRequests.length, 1); assert.equal(report.cleanupConfirmed, false);
  assert.equal(report.accountVerified, false); assert.ok(report.retainedEvidenceDirectory);
  await access(report.retainedEvidenceDirectory);
  t.after(() => rm(report.retainedEvidenceDirectory, { recursive: true, force: true }));
});
