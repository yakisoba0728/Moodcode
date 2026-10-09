import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MoodcodeEngine } from "../engine.js";
import type { ProviderAdapter } from "../ports.js";
import { batchUntil, batchCommand } from "./fixtures/batch.js";
import { retainCrashFixture } from "../git/fixtures/crash-retention.js";
for (const boundary of [
  "child-complete",
  "selected",
  "merge-receipt",
  "export",
  "input-before-commit",
  "input-after-commit",
])
  test(
    `actual Root SIGKILL at ${boundary} preserves native effects/debt and never replays attempts or selection`,
    { timeout: 30000 },
    async (t) => {
      const base = realpathSync(
          mkdtempSync(join(tmpdir(), "moodcode-batch-crash-")),
        ),
        direct = fileURLToPath(
          new URL(
            `./fixtures/crash-batch.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
            import.meta.url,
          ),
        ),
        fallback = fileURLToPath(
          new URL(
            "../../dist/coding-runs/fixtures/crash-batch.js",
            import.meta.url,
          ),
        ),
        entry = existsSync(direct) ? direct : fallback;
      let stderr = "",
        reopenedEngine: MoodcodeEngine | undefined,
        childClosed = false;
      const child = fork(entry, [base, boundary], {
        execArgv: entry.endsWith(".ts")
          ? ["--import", fileURLToPath(import.meta.resolve("tsx"))]
          : [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      child.stderr!.on(
        "data",
        (b) => (stderr = (stderr + String(b)).slice(-8192)),
      );
      const exited = new Promise<void>((resolve) =>
        child.once("close", () => {
          childClosed = true;
          resolve();
        }),
      );
      t.after(async () => {
        await retainCrashFixture({
          base,
          dbPath: join(base, "engine.sqlite"),
          boundary,
          stderr,
          settleChild: async () => {
            if (!childClosed) child.kill("SIGKILL");
            await exited;
          },
          closeEngine: reopenedEngine
            ? () => reopenedEngine!.close()
            : undefined,
          diagnostic: (message) => t.diagnostic(message),
        });
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("actual IPC boundary missing " + stderr));
        }, 15000);
        child.once("message", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(
            new Error("fixture exited before boundary " + code + " " + stderr),
          );
        });
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      child.kill("SIGKILL");
      await exited;
      const data = JSON.parse(
        readFileSync(join(base, "boundary.json"), "utf8"),
      );
      let calls = 0;
      const provider: ProviderAdapter = {
        id: "coding-batch-fixture",
        async *streamTurn() {
          calls++;
          yield {
            type: "text.delta",
            delta: "Only existing exact pending result consumed.",
          };
          yield { type: "finish", reason: "stop" };
        },
      };
      const engine = new MoodcodeEngine({
        ...data.configuration,
        providers: [provider],
        workflows: true,
        codingBatches: true,
        verificationTools: true,
      });
      reopenedEngine = engine;
      const g = engine.inspectBatchEvidence(data.workspaceId, data.groupId);
      assert.equal(calls, 0);
      if (["child-complete", "selected", "merge-receipt"].includes(boundary)) {
        assert.equal(g.state, "uncertain");
        await assert.rejects(
          engine.resumeVerifiedBatch({
            workspaceId: data.workspaceId,
            groupId: g.groupId,
            requestId: "resume",
            expectedRevision: g.revision,
            approved: true,
          }),
        );
      } else {
        assert.equal(g.state, "completed");
        assert.throws(() =>
          engine.captureCodingBatchDeliveryTarget({
            workspaceId: data.workspaceId,
            groupId: g.groupId,
            config: data.configuration.defaults,
          }),
        );
      }
      const inputs = engine.store
        .listInputs(data.sessionId)
        .inputs.filter((i) => i.requestId.startsWith("workflow-result:"));
      assert.equal(inputs.length, boundary === "input-after-commit" ? 1 : 0);
      if (boundary === "input-after-commit") {
        assert.equal(inputs[0]!.state, "pending");
        await batchCommand(engine, "session.resume", {
          sessionId: data.sessionId,
        });
        await batchUntil(
          () => engine.store.getInput(inputs[0]!.id).state === "promoted",
          "exact committed pending receipt promotes",
        );
        await batchUntil(
          () => calls === 1,
          "actual provider consumes one exact committed result",
        );
        assert.equal(calls, 1);
      }
      assert.equal(
        readFileSync(join(base, "repository", "seed.txt"), "utf8"),
        [
          "merge-receipt",
          "export",
          "input-before-commit",
          "input-after-commit",
        ].includes(boundary)
          ? "candidate A\n"
          : "batch baseline\n",
      );
      assert.equal(
        engine.children.tasks
          .list(data.sessionId)
          .filter((c) => c.state === "starting" || c.state === "running")
          .length,
        0,
      );
      t.after(() => {
        assert.ok(existsSync(join(base, "engine.sqlite")));
        assert.ok(existsSync(join(base, "crash-retention.json")));
        assert.ok(existsSync(join(base, "boundary.json")));
      });
    },
  );
