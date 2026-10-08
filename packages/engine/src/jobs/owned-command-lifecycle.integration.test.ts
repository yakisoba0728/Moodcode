import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EngineError, type RunConfig } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import type { ProviderAdapter, ProviderEvent } from "../ports.js";
import {
  exportEngineArchive,
  importEngineArchive,
  validateEngineArchive,
} from "../storage/archive.js";
import { jobInvoke, jobUntil } from "./fixtures/job.js";
import {
  ownedLifecycleFixture,
  ownedLifecycleProfile,
} from "./fixtures/owned-command-lifecycle.js";
import type { OwnedCommandJobRecord } from "./owned-command-records.js";
import { inspectExecutionLock } from "../tools/command/execution-lock.js";

const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 25_000,
};
const error = (value: unknown) => value instanceof EngineError;
function absent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (failure) {
    return (failure as NodeJS.ErrnoException).code === "ESRCH";
  }
}
function counts(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(
      [
        "runs",
        "tools",
        "session_inputs",
        "session_turns",
        "provider_attempts",
      ].map((table) => [
        table,
        Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),
      ]),
    );
  } finally {
    db.close();
  }
}
interface Ready {
  readonly type: "ready";
  readonly base: string;
  readonly root: string;
  readonly dbPath: string;
  readonly artifactDir: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly job: OwnedCommandJobRecord;
  readonly pid: number;
  readonly launches: string;
  readonly config: RunConfig;
}

test(
  "actual Root SIGKILL leaves a native owned command uncertain and cannot replay its process on explicit session resume",
  posix,
  async (t) => {
    const here = dirname(fileURLToPath(import.meta.url));
    const child = fork(
      join(
        here,
        "fixtures",
        `owned-command-lifecycle${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
      ),
      ["--crash-child"],
      {
        silent: true,
        execArgv: import.meta.url.endsWith(".ts")
          ? [
              "--import",
              resolve(here, "../../../../node_modules/tsx/dist/loader.mjs"),
            ]
          : [],
      },
    );
    let ready: Ready | undefined,
      engine: ReturnType<typeof createEngine> | undefined,
      exited = false,
      output = "";
    const collect = (data: Buffer) => {
      output = (output + data.toString("utf8")).slice(-32_768);
    };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    const ended = new Promise<void>((yes, no) => {
      child.once("error", no);
      child.once("exit", () => {
        exited = true;
        yes();
      });
    });
    t.after(async () => {
      if (!exited) {
        child.kill("SIGKILL");
        await ended;
      }
      if (ready && !absent(ready.pid)) {
        try {
          process.kill(-ready.job.groupPid!, "SIGKILL");
        } catch {}
        try {
          process.kill(ready.pid, "SIGKILL");
        } catch {}
        await jobUntil(
          () => absent(ready!.pid),
          "Fixture must clean its actual surviving command PID",
          5000,
        );
      }
      await engine?.close();
      if (ready) rmSync(ready.base, { recursive: true, force: true });
    });
    ready = await new Promise<Ready>((yes, no) => {
      const timer = setTimeout(
        () => no(new Error(`Actual Root did not admit command: ${output}`)),
        15_000,
      );
      child.once("message", (value) => {
        clearTimeout(timer);
        const message = value as Ready;
        assert.equal(message.type, "ready");
        yes(message);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        no(new Error(`Actual Root exited before ready: ${output}`));
      });
      child.once("error", (failure) => {
        clearTimeout(timer);
        no(failure);
      });
    });
    const before = counts(ready.dbPath);
    assert.equal(ready.job.state, "running");
    assert.equal(
      readFileSync(ready.launches, "utf8").trim().split("\n").length,
      1,
    );
    process.kill(ready.pid, 0);
    child.kill("SIGKILL");
    await ended;
    await jobUntil(
      () => absent(ready!.pid),
      "The real command supervisor must clean its process after Root SIGKILL",
      5000,
    );
    await jobUntil(
      () =>
        inspectExecutionLock(`${ready!.dbPath}.effects.sqlite`).status ===
        "available",
      "The actual supervisor must release its execution lock after cleanup without a marker reset",
      5000,
    );
    let entries = 0;
    const provider: ProviderAdapter = {
      id: ready.config.providerId,
      async *streamTurn(): AsyncIterable<ProviderEvent> {
        entries++;
        yield { type: "finish", reason: "stop" };
      },
    };
    engine = createEngine({
      dbPath: ready.dbPath,
      artifactDir: ready.artifactDir,
      jobs: true,
      providers: [provider],
      defaults: ready.config,
      agentProfiles: [ownedLifecycleProfile],
    });
    const stored = jobInvoke<OwnedCommandJobRecord>(
      engine,
      "getOwnedCommandJob",
      ready.workspaceId,
      ready.job.jobId,
    );
    assert.equal(stored.state, "uncertain");
    assert.equal(
      stored.completion,
      null,
      "Physical disappearance after SIGKILL is not an Original durable completion receipt",
    );
    assert.equal(stored.source.sha256, ready.job.source.sha256);
    assert.equal(engine.store.getRun(ready.runId).state === "completed", false);
    assert.throws(
      () =>
        jobInvoke(engine!, "captureOwnedCommandJobOutput", {
          workspaceId: ready!.workspaceId,
          jobId: stored.jobId,
        }),
      error,
    );
    assert.throws(
      () => engine!.scheduler.resume(ready!.sessionId),
      (failure) =>
        failure instanceof EngineError && failure.code === "CLEANUP_PENDING",
      "An unknown native effect stays quarantined even when its physical process is gone",
    );
    assert.equal(entries, 0);
    assert.deepEqual(counts(ready.dbPath), before);
    assert.equal(
      readFileSync(ready.launches, "utf8").trim().split("\n").length,
      1,
    );
    assert.equal(absent(ready.pid), true);
  },
);

test(
  "an actually completed owned command imports as paused history without restoring an Original output handle or process grant",
  posix,
  async (t) => {
    const f = await ownedLifecycleFixture(t);
    const originalHandle = jobInvoke<object>(
      f.engine,
      "captureOwnedCommandJobOutput",
      { workspaceId: f.workspace.id, jobId: f.job.jobId },
    );
    f.finish();
    assert.equal(
      (await f.engine.waitForRun(f.receipt.runId)).state,
      "completed",
    );
    assert.equal(absent(f.pid), true);
    const completed = jobInvoke<OwnedCommandJobRecord>(
      f.engine,
      "getOwnedCommandJob",
      f.workspace.id,
      f.job.jobId,
    );
    assert.equal(completed.state, "completed");
    assert.ok(completed.completion);
    const before = counts(f.dbPath);
    await f.engine.close();
    const archived = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "owned-completed-archive"),
    });
    assert.equal(
      validateEngineArchive({ directory: archived.directory }).manifestSha256,
      archived.manifestSha256,
    );
    for (const jobs of [false, true]) {
      const imported = await importEngineArchive({
        directory: archived.directory,
        destination: join(f.base, jobs ? "owned-on" : "owned-off"),
      });
      assert.equal(imported.executionResumed, false);
      let entries = 0;
      const provider: ProviderAdapter = {
        id: f.config.providerId,
        async *streamTurn(): AsyncIterable<ProviderEvent> {
          entries++;
          yield { type: "finish", reason: "stop" };
        },
      };
      const engine = createEngine({
        ...f.configuration,
        dbPath: imported.dbPath,
        artifactDir: imported.artifactDir,
        providers: [provider],
        agentProfiles: [ownedLifecycleProfile],
        jobs,
      });
      f.engines.add(engine);
      const stored = jobInvoke<OwnedCommandJobRecord>(
        engine,
        "getOwnedCommandJob",
        f.workspace.id,
        completed.jobId,
      );
      assert.equal(stored.state, "paused-import");
      assert.equal(stored.source.sha256, completed.source.sha256);
      assert.deepEqual(stored.completion, completed.completion);
      assert.equal(engine.store.getSessionControl(f.session.id).paused, true);
      assert.throws(
        () =>
          jobInvoke(engine, "readOwnedCommandJobOutput", originalHandle, {}),
        error,
      );
      assert.throws(
        () =>
          jobInvoke(engine, "captureOwnedCommandJobOutput", {
            workspaceId: f.workspace.id,
            jobId: completed.jobId,
          }),
        error,
      );
      assert.throws(
        () =>
          jobInvoke(engine, "captureCommandJobDeliveryTarget", {
            workspaceId: f.workspace.id,
            jobId: completed.jobId,
            config: f.config,
          }),
        error,
      );
      engine.scheduler.resume(f.session.id);
      await engine.waitForSession(f.session.id);
      assert.equal(entries, 0);
      assert.deepEqual(counts(imported.dbPath), before);
      assert.equal(existsSync(completed.completion!.stdout.path), true);
      assert.equal(
        readFileSync(f.launches, "utf8").trim().split("\n").length,
        1,
      );
      assert.equal(absent(f.pid), true);
      await engine.close();
    }
  },
);
