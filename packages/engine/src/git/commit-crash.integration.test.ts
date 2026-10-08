import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertExecutionLockAvailable } from "../tools/command/execution-lock.js";
import { groupExists } from "../tools/command/process-control.js";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createEngine } from "../engine.js";
import { gitFixture } from "./fixtures/commit.js";
import type { ProviderAdapter, ProviderEvent } from "../ports.js";
import type { CommitReviewedChangesInput } from "./types.js";
for (const boundary of ["before", "after"] as const)
  test(
    `actual SIGKILL ${boundary} Git commit leaves uncertain native intent and no repeated commit`,
    { timeout: 30000, skip: process.platform === "win32" },
    async (t) => {
      const path = fileURLToPath(
          new URL(
            `./fixtures/crash-commit.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
            import.meta.url,
          ),
        ),
        child = fork(path, [boundary], {
          silent: true,
          execArgv: import.meta.url.endsWith(".ts")
            ? ["--import", fileURLToPath(import.meta.resolve("tsx"))]
            : [],
        });
      let output = "",
        ready: any,
        engine: ReturnType<typeof createEngine> | undefined,
        exited = false;
      child.stderr!.on(
        "data",
        (b: Buffer) => (output = (output + b).slice(-8192)),
      );
      const ended = new Promise<void>((yes) =>
        child.once("exit", () => {
          exited = true;
          yes();
        }),
      );
      t.after(async () => {
        if (!exited) {
          child.kill("SIGKILL");
          await ended;
        }
        await engine?.close();
        if (ready) await rm(ready.base, { recursive: true, force: true });
      });
      ready = await new Promise((yes, no) => {
        const timer = setTimeout(
          () => no(new Error(`Actual crash boundary not reached: ${output}`)),
          12000,
        );
        child.once("message", (m) => {
          clearTimeout(timer);
          yes(m);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          no(new Error(output));
        });
      });
      assert.equal(ready.type, "ready");
      assert.equal(
        gitFixture(ready.root, "rev-list", "--count", "HEAD"),
        boundary === "before" ? "1" : "2",
      );
      if (boundary === "before") {
        const end = Date.now() + 5000;
        while (!existsSync(join(ready.root, "crash-hook-started"))) {
          assert.ok(Date.now() < end);
          await delay(10);
        }
        assert.equal(groupExists(ready.groupPid), true);
      }
      child.kill("SIGKILL");
      await ended;
      {
        const end = Date.now() + 5000;
        for (;;) {
          try {
            assertExecutionLockAvailable(`${ready.dbPath}.effects.sqlite`);
            break;
          } catch {
            assert.ok(Date.now() < end);
            await delay(10);
          }
        }
      }
      if (boundary === "before")
        assert.equal(groupExists(ready.groupPid), false);
      let calls = 0;
      const provider: ProviderAdapter = {
        id: "commit-fixture",
        async *streamTurn(): AsyncGenerator<ProviderEvent> {
          calls++;
          yield { type: "finish", reason: "stop" };
        },
      };
      engine = createEngine({
        dbPath: ready.dbPath,
        artifactDir: ready.artifactDir,
        verificationTools: true,
        gitCommits: true,
        providers: [provider],
        defaults: ready.defaults,
        agentProfiles: [
          {
            id: "verifier",
            description: "Actual verification",
            instructions: "Use the registered check.",
            tools: ["verify_changes", "run_command"],
          },
        ],
      });
      const input = ready.input as CommitReviewedChangesInput,
        unknown = engine.getGitCommitReceipt(
          ready.workspaceId,
          ready.sessionId,
          input.requestId,
        )!;
      assert.equal(unknown.state, "uncertain");
      assert.equal(unknown.outcome, null);
      assert.equal(engine.store.getRun(ready.runId).state, "completed");
      assert.equal(
        (await engine.commitReviewedChanges({}, input)).kind,
        "duplicate",
      );
      const receipt = await engine.reconcileGitCommit({
        workspaceId: ready.workspaceId,
        sessionId: ready.sessionId,
        requestId: input.requestId,
        expectedRevision: unknown.revision,
      });
      assert.equal(
        receipt.state,
        boundary === "before" ? "failed" : "committed",
      );
      assert.equal(
        receipt.commitSha,
        boundary === "before"
          ? null
          : gitFixture(ready.root, "rev-parse", "HEAD"),
      );
      assert.equal(
        gitFixture(ready.root, "rev-list", "--count", "HEAD"),
        boundary === "before" ? "1" : "2",
      );
      assert.equal(calls, 0);
    },
  );
