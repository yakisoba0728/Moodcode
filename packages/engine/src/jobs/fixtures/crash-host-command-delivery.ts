import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { hostDeliveryFixture } from "./host-command-delivery.js";
const boundary = process.argv[2];
assert.ok(boundary === "before-commit" || boundary === "after-commit");
const cleanups: Array<() => void | Promise<void>> = [];
const scope = {
  after(fn: () => void | Promise<void>) {
    cleanups.push(fn);
  },
} as unknown as TestContext;
const f = await hostDeliveryFixture(scope);
try {
  const job = await f.complete(),
    target = f.capture();
  const database = Reflect.get(f.engine.store, "db") as {
    isTransaction: boolean;
  };
  let stopped = false;
  const stop = () => {
    assert.equal(stopped, false);
    stopped = true;
    assert.equal(database.isTransaction, boundary === "before-commit");
    process.send!({
      type: "ready",
      boundary,
      base: f.base,
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      jobId: job.jobId,
      sourcePid: f.pid,
      config: f.config,
    });
    process.kill(process.pid, "SIGSTOP");
  };
  if (boundary === "before-commit") {
    const original = f.engine.store.acceptInput;
    Reflect.set(
      f.engine.store,
      "acceptInput",
      (...args: Parameters<typeof original>) => {
        const result = Reflect.apply(original, f.engine.store, args);
        if (args[0].requestId.startsWith("host-command-result:")) stop();
        return result;
      },
    );
  } else {
    const original = f.engine.scheduler.wake;
    Reflect.set(
      f.engine.scheduler,
      "wake",
      (...args: Parameters<typeof original>) => {
        stop();
        return Reflect.apply(original, f.engine.scheduler, args);
      },
    );
  }
  f.deliver(target, randomUUID());
  assert.fail("Did not reach genuine independent inbox transaction boundary");
} finally {
  for (const cleanup of cleanups) await cleanup();
}
