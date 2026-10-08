import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  CommandOutputRing,
  COMMAND_OBSERVATION_LIMITS,
  validateCommandArtifactDescriptor,
} from "./observation.js";

const descriptor = () => ({
  version: 1,
  path: "/unopened/output-data.log",
  sha256: createHash("sha256").update("bytes").digest("hex"),
  device: "1",
  inode: "2",
  size: 5,
  mtimeNs: "123456789",
  observedBytes: 7,
  artifactBytes: 5,
  truncated: true,
});

test("sealed command artifact DATA validates exact bounded metadata without opening or granting a supplied source", () => {
  const value = descriptor(),
    checked = validateCommandArtifactDescriptor(value);
  assert.deepEqual(checked, value);
  assert.equal(Object.isFrozen(checked), true);
  value.size = 99;
  assert.equal(checked.size, 5);
  for (const patch of [
    { version: 2 },
    { sourceActor: "model" },
    { executable: "/bin/sh" },
    { sha256: "a" },
    { size: 0 },
    { observedBytes: 4 },
    { truncated: false },
    { artifactBytes: 1_048_577, size: 1_048_577, observedBytes: 1_048_577 },
    { device: "-1" },
    { path: "../relative" },
    { path: "/nul\0path" },
    { mtimeNs: "0".repeat(33) },
    { observedBytes: Infinity },
  ])
    assert.throws(() =>
      validateCommandArtifactDescriptor({ ...descriptor(), ...patch }),
    );
});

test("artifact accessors, serializers, proxies and hidden fields reject before caller traps", () => {
  let traps = 0;
  const accessor = Object.defineProperty(descriptor(), "path", {
    enumerable: true,
    get() {
      traps++;
      return "/unopened";
    },
  });
  const proxy = new Proxy(descriptor(), {
    get() {
      traps++;
      throw new Error("trap");
    },
    ownKeys() {
      traps++;
      throw new Error("trap");
    },
    getPrototypeOf() {
      traps++;
      throw new Error("trap");
    },
  });
  const serializer = {
    ...descriptor(),
    toJSON() {
      traps++;
      return descriptor();
    },
  };
  const hidden = Object.defineProperty(descriptor(), "hidden", {
    value: "unexpected",
  });
  for (const value of [accessor, proxy, serializer, hidden])
    assert.throws(() => validateCommandArtifactDescriptor(value));
  assert.equal(traps, 0);
});

test("actual byte chunks decode each stream independently and preserve UTF-8 across chunk boundaries", () => {
  const ring = new CommandOutputRing(),
    first = Buffer.from("한🙂"),
    second = Buffer.from("글😀");
  assert.equal(ring.push("stdout", first.subarray(0, 1)).length, 0);
  assert.equal(ring.push("stderr", second.subarray(0, 2)).length, 0);
  ring.push("stdout", first.subarray(1));
  ring.push("stderr", second.subarray(2));
  ring.end("stdout");
  ring.end("stderr");
  const result = ring.snapshot();
  assert.equal(
    result.output
      .filter((event) => event.stream === "stdout")
      .map((event) => event.data)
      .join(""),
    "한🙂",
  );
  assert.equal(
    result.output
      .filter((event) => event.stream === "stderr")
      .map((event) => event.data)
      .join(""),
    "글😀",
  );
  assert.equal(result.observedBytes, first.byteLength + second.byteLength);
  assert.equal(result.retainedBytes, result.observedBytes);
  assert.deepEqual(
    result.output.map((event) => event.seq),
    [1, 2],
  );
  assert.equal(Object.isFrozen(result.output), true);
});

test("incomplete and invalid UTF-8 retain honest raw observation counts and explicit replacement text", () => {
  const ring = new CommandOutputRing();
  ring.push("stdout", Buffer.from([0xe2, 0x82]));
  ring.push("stderr", Buffer.from([0xff]));
  ring.end("stdout");
  ring.end("stderr");
  const result = ring.snapshot();
  assert.equal(result.observedBytes, 3);
  assert.equal(result.retainedBytes, 6);
  assert.equal(
    result.output.map((event) => event.data).join(""),
    "\ufffd\ufffd",
  );
  assert.equal(
    result.output.every(
      (event) => event.bytes === Buffer.byteLength(event.data),
    ),
    true,
  );
});

test("Unicode output events stay under 16KiB and retention loss stays contiguous and bounded", () => {
  const ring = new CommandOutputRing(),
    bytes = Buffer.from("한글🙂".repeat(60_000));
  for (
    let at = 0;
    at < bytes.byteLength;
    at += COMMAND_OBSERVATION_LIMITS.outputHookBytes
  )
    ring.push(
      "stdout",
      bytes.subarray(at, at + COMMAND_OBSERVATION_LIMITS.outputHookBytes),
    );
  ring.end("stdout");
  ring.end("stderr");
  const result = ring.snapshot();
  assert.equal(result.observedBytes, bytes.byteLength);
  assert.ok(result.retainedBytes <= COMMAND_OBSERVATION_LIMITS.ringBytes);
  assert.ok(result.oldestSeq > 1);
  assert.equal(result.output[0]!.seq, result.oldestSeq);
  assert.equal(result.output.at(-1)!.seq, result.outputSeq);
  assert.equal(
    result.output.every(
      (event, index) =>
        event.bytes > 0 &&
        event.bytes <= COMMAND_OBSERVATION_LIMITS.eventBytes &&
        event.bytes === Buffer.byteLength(event.data) &&
        event.seq === result.oldestSeq + index &&
        !event.data.includes("\ufffd"),
    ),
    true,
  );
  assert.equal(
    result.retainedBytes,
    result.output.reduce((sum, event) => sum + event.bytes, 0),
  );
});

test("rings reject oversized, foreign and ended chunks without accepting Buffer proxy traps", () => {
  const ring = new CommandOutputRing();
  let traps = 0;
  const proxy = new Proxy(Buffer.from("bytes"), {
    get() {
      traps++;
      throw new Error("trap");
    },
    getPrototypeOf() {
      traps++;
      throw new Error("trap");
    },
  });
  assert.throws(() => ring.push("stdout", proxy));
  assert.throws(() =>
    ring.push(proxy as unknown as "stdout", Buffer.from("bytes")),
  );
  assert.throws(() => ring.end(proxy as unknown as "stdout"));
  assert.throws(() =>
    ring.push(
      "stdout",
      Buffer.alloc(COMMAND_OBSERVATION_LIMITS.outputHookBytes + 1),
    ),
  );
  assert.throws(() => ring.push("invalid" as "stdout", Buffer.from("bytes")));
  ring.end("stdout");
  assert.throws(() => ring.push("stdout", Buffer.from("late")));
  assert.throws(() => ring.end("stdout"));
  assert.equal(traps, 0);
  assert.equal(ring.snapshot().observedBytes, 0);
});
