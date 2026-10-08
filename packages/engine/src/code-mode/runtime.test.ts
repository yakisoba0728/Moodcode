import test from "node:test";
import assert from "node:assert/strict";
import { probeCodeModeRuntime } from "./runtime.js";
import { parseCodeProgram, validateCodeAllocation } from "./types.js";
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
