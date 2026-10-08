import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createEngine } from "../engine.js";
const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 20000,
};
for (const phase of ["before-commit", "after-commit"])
  test(
    "actual SIGKILL " +
      phase +
      " keeps atomic feedback and never auto-replays HTTP/input/provider",
    posix,
    async (t) => {
      const extension = import.meta.url.endsWith(".ts") ? "ts" : "js",
        worker = fileURLToPath(
          new URL("./fixtures/crash-pr." + extension, import.meta.url),
        ),
        child = fork(worker, [phase], {
          execArgv:
            extension === "ts"
              ? ["--import", fileURLToPath(import.meta.resolve("tsx"))]
              : [],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
      let error = "";
      child.stderr!.on("data", (x) => (error += String(x)));
      const ready = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("crash worker timeout " + error)),
          10000,
        );
        child.once("message", (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          reject(
            new Error("worker exited " + code + "/" + signal + " " + error),
          );
        });
      });
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      t.after(() => rm(ready.base, { recursive: true, force: true }));
      let providerCalls = 0;
      const engine = createEngine({
        dbPath: ready.dbPath,
        artifactDir: ready.artifactDir,
        prFeedback: true,
        prFeedbackLoopback: true,
        verificationTools: true,
        providers: [
          {
            id: "pr-fixture",
            async *streamTurn() {
              providerCalls++;
              yield { type: "finish" as const, reason: "stop" as const };
            },
          },
        ],
        defaults: {
          providerId: "pr-fixture",
          modelId: "fixture",
          mode: "build",
          limits: { maxTurns: 8, maxDurationMs: 20000, toolTimeoutMs: 5000 },
        },
        agentProfiles: [
          {
            id: "verifier",
            description: "Fixture verifier",
            instructions: "Use the host check",
            tools: ["verify_changes", "run_command"],
          },
        ],
      });
      t.after(() => engine.close());
      const watch = engine.getPrWatch(
        ready.workspace.id,
        ready.session.id,
        "watch",
      )!;
      assert.equal(watch.cursor, phase === "before-commit" ? 0 : 1);
      const inputs = engine.store.pendingInputs(ready.session.id, "queue");
      assert.equal(inputs.length, phase === "before-commit" ? 0 : 1);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(providerCalls, 0);
      if (phase === "after-commit") {
        const before = inputs[0]!,
          result = await engine.pollPrWatch({
            workspaceId: ready.workspace.id,
            sessionId: ready.session.id,
            watchId: "watch",
            requestId: "crash",
            expectedRevision: 1,
          });
        assert.equal(result.kind, "duplicate");
        assert.equal(result.occurrence!.accepted!.inputId, before.id);
        assert.equal(engine.store.pendingInputs(ready.session.id).length, 1);
      }
      const db = new DatabaseSync(ready.dbPath, { readOnly: true });
      try {
        assert.equal(
          Number(
            db
              .prepare(
                "SELECT count(*) n FROM session_events WHERE type='pr.feedback.admitted'",
              )
              .get()!.n,
          ),
          phase === "before-commit" ? 0 : 1,
        );
      } finally {
        db.close();
      }
    },
  );
