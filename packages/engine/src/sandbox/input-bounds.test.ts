import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { sandboxJson } from "./types.js";

const failure = (code: string) => (error: unknown) =>
  error instanceof EngineError && error.code === code;

test("sandbox input rejects a maximal sparse length before JSON serialization", () => {
  const sparse = new Array(0xffffffff);
  sparse[0xfffffffe] = "tail";
  const stringify = JSON.stringify;
  let serialized = 0;
  try {
    JSON.stringify = ((...args: unknown[]) => {
      serialized++;
      return Reflect.apply(stringify, JSON, args);
    }) as typeof JSON.stringify;
    assert.throws(() => sandboxJson(sparse), failure("SANDBOX_LIMIT"));
    assert.equal(serialized, 0);
  } finally {
    JSON.stringify = stringify;
  }
});

test("sandbox input rejects bounded holes and non-index array properties", () => {
  assert.throws(() => sandboxJson(new Array(2)), failure("SANDBOX_INVALID"));
  const decorated = Object.assign(["one"], { extra: "ignored-by-JSON" });
  assert.throws(() => sandboxJson(decorated), failure("SANDBOX_INVALID"));
});

test("sandbox input charges UTF8 strings and keys cumulatively before serialization", () => {
  assert.throws(
    () => sandboxJson("한".repeat(10), 20),
    failure("SANDBOX_LIMIT"),
  );
  assert.throws(
    () => sandboxJson({ a: "한".repeat(4), b: "한".repeat(4) }, 20),
    failure("SANDBOX_LIMIT"),
  );
  assert.throws(
    () => sandboxJson({ ["한".repeat(10)]: true }, 20),
    failure("SANDBOX_LIMIT"),
  );
  assert.throws(
    () => sandboxJson("a".repeat(131073)),
    failure("SANDBOX_LIMIT"),
  );
});

test("sandbox input preflight never invokes proxy traps or array accessors", () => {
  let calls = 0;
  const proxy = new Proxy([], {
    getOwnPropertyDescriptor() {
      calls++;
      throw new Error("unexpected");
    },
    ownKeys() {
      calls++;
      throw new Error("unexpected");
    },
  });
  assert.throws(() => sandboxJson(proxy), failure("SANDBOX_INVALID"));
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get() {
      calls++;
      throw new Error("unexpected");
    },
  });
  assert.throws(() => sandboxJson(accessor), failure("SANDBOX_INVALID"));
  assert.equal(calls, 0);
});

test("sandbox input retains dense immutable JSON and checks escaped serialized bytes", () => {
  const copied = sandboxJson({ paths: ["a", "한"], flags: [true, null, 1] });
  assert.equal(
    JSON.stringify(copied),
    '{"paths":["a","한"],"flags":[true,null,1]}',
  );
  assert.ok(Object.isFrozen(copied) && Object.isFrozen(copied.paths));
  assert.throws(
    () => sandboxJson("\n".repeat(9), 12),
    failure("SANDBOX_LIMIT"),
  );
});
