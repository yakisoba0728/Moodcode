import test from "node:test";
import assert from "node:assert/strict";
import { probeCodeModeRuntime } from "./runtime.js";
import {
  parseCodeProgram,
  validateCodeAllocation,
  validateCodeModePacket,
} from "./types.js";
import { OwnedCodeModeProcess } from "./process.js";
test(
  "actual kernel probes deny protected file read/write, loopback and process fork",
  { skip: process.platform !== "darwin" },
  async () => {
    const source = await probeCodeModeRuntime();
    assert.equal(source.capability.available, true);
    assert.equal(source.capability.fileIsolation, true);
    assert.equal(source.capability.networkIsolation, true);
    assert.equal(source.capability.processIsolation, true);
    assert.ok(source.capability.evidenceSha256);
    const process = new OwnedCodeModeProcess(
        source,
        "actual-test-generation",
        () => {},
      ),
      signal = AbortSignal.timeout(10000);
    const p = await process.start(signal);
    await process.write(
      {
        version: 1,
        type: "init",
        generation: "actual-test-generation",
        allocation: {
          maxSteps: 100,
          maxNestedCalls: 1,
          maxResultBytes: 1024,
          maxDurationMs: 1000,
        },
        program: {
          version: 1,
          statements: [{ op: "return", value: { op: "literal", value: 7 } }],
        },
      },
      signal,
    );
    const result = await process.next(signal);
    assert.equal(result.value, 7);
    const closed = await process.stop();
    assert.equal(closed.processId, p.processId);
    assert.equal(closed.cleanupConfirmed, true);
    assert.throws(() => globalThis.process.kill(p.processId, 0));
  },
);
test("closed language rejects arbitrary JS, imports, dynamic prototype paths and unsafe object descriptors", () => {
  for (const source of [
    "process.exit(0)",
    '{"version":1,"statements":[{"op":"eval","source":"1"}]}',
    '{"version":1,"statements":[{"op":"return","value":{"op":"get","value":{"op":"literal","value":{}},"key":"constructor"}}]}',
  ])
    assert.throws(() => parseCodeProgram(source));
  let hits = 0;
  const unsafe = {
    get maxSteps() {
      hits++;
      return 1;
    },
  };
  assert.throws(() => validateCodeAllocation(unsafe));
  assert.equal(hits, 0);
  assert.throws(() =>
    validateCodeAllocation({
      maxSteps: 4097,
      maxNestedCalls: 1,
      maxResultBytes: 1,
      maxDurationMs: 1,
    }),
  );
});
test("source duplicate and escaped duplicate keys are rejected before execution", () => {
  for (const s of [
    '{"version":1,"version":1,"statements":[]}',
    '{"version":1,"statements":[{"op":"return","value":{"op":"literal","value":{"key":1,"k\\u0065y":2}}}]}',
  ])
    assert.throws(() => parseCodeProgram(s), {
      code: "CODE_MODE_DUPLICATE_KEY",
    });
});
test("source nested deeper than 32 JSON levels is a code-mode limit", () => {
  let value: unknown = 0;
  for (let i = 0; i < 29; i++) value = [value];
  const source = JSON.stringify({
    version: 1,
    statements: [{ op: "return", value: { op: "literal", value } }],
  });
  assert.throws(() => parseCodeProgram(source), { code: "CODE_MODE_LIMIT" });
});
test("allocation accepts each named limit and rejects one past it", () => {
  const max = {
    maxSteps: 4096,
    maxNestedCalls: 16,
    maxResultBytes: 32768,
    maxDurationMs: 30000,
  };
  assert.deepEqual({ ...validateCodeAllocation(max) }, max);
  for (const key of Object.keys(max) as (keyof typeof max)[])
    assert.throws(
      () => validateCodeAllocation({ ...max, [key]: max[key] + 1 }),
      { code: "CODE_MODE_LIMIT" },
    );
});
test("worker packets keep protocol errors ahead of runtime and call-limit errors", () => {
  const state = {
      generation: "g",
      allocation: {
        maxSteps: 10,
        maxNestedCalls: 1,
        maxResultBytes: 64,
        maxDurationMs: 1000,
      },
      callsSoFar: 0,
      seenIds: new Set<string>(),
    },
    result = {
      version: 1,
      type: "result",
      generation: "g",
      steps: 0,
      calls: 0,
    },
    call = {
      version: 1,
      type: "call",
      generation: "g",
      id: "a",
      tool: "read_file",
      input: { path: "x" },
    },
    rejects = (packet: Record<string, unknown>, code: string) =>
      assert.throws(() => validateCodeModePacket(packet, state), { code });
  rejects(
    { ...result, generation: "other", ok: true },
    "CODE_MODE_PROTOCOL_INVALID",
  );
  rejects({ ...result, ok: true, extra: 1 }, "CODE_MODE_PROTOCOL_INVALID");
  rejects(
    { ...result, ok: false, errorCode: "CODE_MODE_STEP_LIMIT", steps: 12 },
    "CODE_MODE_PROTOCOL_INVALID",
  );
  rejects(
    { ...result, ok: false, errorCode: "CODE_MODE_STEP_LIMIT", steps: 11 },
    "CODE_MODE_STEP_LIMIT",
  );
  rejects({ ...result, ok: false }, "CODE_MODE_RUNTIME_FAILED");
  rejects({ ...result, ok: true, calls: 1 }, "CODE_MODE_PROTOCOL_INVALID");
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        validateCodeModePacket({ ...result, ok: true, value: { a: 1 } }, state),
      ),
    ),
    { type: "result", value: { a: 1 } },
  );
  assert.deepEqual(validateCodeModePacket(call, state), {
    type: "call",
    id: "a",
    tool: "read_file",
    input: { path: "x" },
  });
  rejects({ ...call, type: "other" }, "CODE_MODE_PROTOCOL_INVALID");
  state.seenIds.add("a");
  rejects(call, "CODE_MODE_PROTOCOL_INVALID");
  rejects({ ...call, id: "b", tool: "eval" }, "CODE_MODE_PROTOCOL_INVALID");
  rejects({ ...call, id: "b" }, "CODE_MODE_CALL_LIMIT");
});
