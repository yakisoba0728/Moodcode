import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { jobCommand, jobFixture, jobInvoke } from "./job.js";
import type { CommandJob, JobRequestResult } from "../store.js";

const boundary = process.argv[2];
assert.ok(boundary === "before-commit" || boundary === "after-commit");
const cleanups: Array<() => void | Promise<void>> = [];
// This scope collects fixture teardown only; all engine/process authority is genuine.
const scope = {
  after(fn: () => void | Promise<void>) {
    cleanups.push(fn);
  },
} as unknown as TestContext;
const f = await jobFixture(scope);
try {
  const attached = f.attach();
  await f.finish();
  const settled = jobInvoke<JobRequestResult<CommandJob>>(
    f.engine,
    "settleTerminalJob",
    attached.original,
    {
      workspaceId: f.workspace.id,
      jobId: attached.result.record.jobId,
      requestId: randomUUID(),
      expectedRevision: 1,
    },
  );
  await jobCommand(f.engine, "session.pause", { sessionId: f.session.id });
  const target = jobInvoke<object>(
    f.engine,
    "captureCommandJobDeliveryTarget",
    {
      workspaceId: f.workspace.id,
      jobId: settled.record.jobId,
      config: f.config,
    },
  );
  const requestId = randomUUID();
  const native = Reflect.get(f.engine, "jobRecords") as object;
  const database = Reflect.get(native, "db") as {
    readonly isTransaction: boolean;
  };
  let stopped = false;
  const stop = () => {
    assert.equal(stopped, false);
    stopped = true;
    assert.equal(database.isTransaction, boundary === "before-commit");
    assert.ok(
      process.send,
      "The real child fixture must have its parent IPC channel",
    );
    process.send({
      type: "ready",
      boundary,
      transactionOpen: database.isTransaction,
      base: f.base,
      root: f.root,
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      jobId: settled.record.jobId,
      settledSha256: settled.record.sha256,
      requestId,
      config: f.config,
    });
    process.kill(process.pid, "SIGSTOP");
  };
  if (boundary === "before-commit") {
    const ports = Reflect.get(native, "ports") as object;
    const original = Reflect.get(ports, "acceptAtomicInput");
    assert.equal(typeof original, "function");
    Reflect.set(ports, "acceptAtomicInput", (...args: unknown[]) => {
      const result = Reflect.apply(original, ports, args);
      stop();
      return result;
    });
  } else {
    const scheduler = f.engine.scheduler;
    const original = scheduler.wake;
    Reflect.set(scheduler, "wake", (...args: Parameters<typeof original>) => {
      stop();
      return Reflect.apply(original, scheduler, args);
    });
  }
  jobInvoke(f.engine, "deliverCommandJobResult", {
    workspaceId: f.workspace.id,
    requestId,
    expectedRevision: 0,
    target,
    approved: true,
  });
  assert.fail(
    "Actual atomic delivery did not reach its selected transaction boundary",
  );
} finally {
  for (const cleanup of cleanups) await cleanup();
}
