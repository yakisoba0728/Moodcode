import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { cooperativeGateOrAbort } from "./cooperative-gate.js";

function observeSignal(signal: AbortSignal) {
  const add = signal.addEventListener,
    remove = signal.removeEventListener;
  const added: unknown[] = [],
    removed: unknown[] = [];
  signal.addEventListener = (
    ...args: Parameters<AbortSignal["addEventListener"]>
  ) => {
    const [type, listener, options] = args;
    assert.equal(type, "abort");
    assert.deepEqual(options, { once: true });
    added.push(listener);
    add.call(signal, type, listener, options);
  };
  signal.removeEventListener = (
    ...args: Parameters<AbortSignal["removeEventListener"]>
  ) => {
    const [type, listener, options] = args;
    assert.equal(type, "abort");
    removed.push(listener);
    remove.call(signal, type, listener, options);
  };
  return { added, removed };
}

for (const order of ["pre-aborted", "gate-first", "abort-first"] as const) {
  test(
    "cooperative gate resolves " +
      order +
      " and removes its original abort listener",
    async () => {
      const controller = new AbortController();
      const observation = observeSignal(controller.signal);
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      if (order === "pre-aborted") controller.abort();
      const waiting = cooperativeGateOrAbort(gate, controller.signal);
      assert.equal(observation.added.length, 1);
      assert.deepEqual(
        getEventListeners(controller.signal, "abort"),
        observation.added,
      );
      if (order === "gate-first") release();
      if (order === "abort-first") controller.abort();
      assert.equal(await waiting, undefined);
      assert.deepEqual(observation.removed, observation.added);
      assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
      if (order === "gate-first") controller.abort();
      else release();
      assert.equal(observation.removed.length, 1);
    },
  );
}

test("cooperative gate preserves an original rejection and disposes its abort listener", async () => {
  const controller = new AbortController();
  const observation = observeSignal(controller.signal);
  const original = new Error("Original provider gate failure.");
  const waiting = cooperativeGateOrAbort(
    Promise.reject(original),
    controller.signal,
  );
  await assert.rejects(waiting, (error: unknown) => error === original);
  assert.deepEqual(observation.removed, observation.added);
  assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});
