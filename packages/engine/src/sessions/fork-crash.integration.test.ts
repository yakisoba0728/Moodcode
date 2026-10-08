import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isTerminal, type RunConfig } from "@moodcode/contracts";
import { MoodcodeEngine } from "../engine.js";
import { forkCounts } from "./fixtures/fork.js";
const sourceTest = import.meta.url.endsWith(".ts");
interface Ready {
  type: "ready";
  boundary: string;
  transactionOpen: boolean;
  base: string;
  dbPath: string;
  artifactDir: string;
  workspaceId: string;
  sourceSessionId: string;
  targetSessionId: string;
  sourceRunId: string;
  counts: ReturnType<typeof forkCounts>;
  config: RunConfig;
  requestId: string;
  approvalFingerprint: string;
}
for (const boundary of ["before-commit", "after-commit"] as const)
  test(
    `actual SIGKILL ${boundary} preserves fork atomicity and never replays the source command`,
    { timeout: 25000 },
    async (t) => {
      const child = fork(
        new URL(
          `./fixtures/crash-fork.${sourceTest ? "ts" : "js"}`,
          import.meta.url,
        ),
        [boundary],
        {
          silent: true,
          execArgv: sourceTest
            ? ["--import", fileURLToPath(import.meta.resolve("tsx"))]
            : [],
        },
      );
      let output = "",
        ready: Ready | undefined,
        engine: MoodcodeEngine | undefined;
      child.stdout!.on(
        "data",
        (b) => (output = (output + b.toString()).slice(-32768)),
      );
      child.stderr!.on(
        "data",
        (b) => (output = (output + b.toString()).slice(-32768)),
      );
      const ended = new Promise<void>((yes, no) => {
        child.once("error", no);
        child.once("exit", () => yes());
      });
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await ended;
        }
        await engine?.close();
        if (ready) rmSync(ready.base, { recursive: true, force: true });
      });
      ready = await new Promise<Ready>((yes, no) => {
        const timer = setTimeout(
          () => no(new Error("No genuine crash boundary " + output)),
          18000,
        );
        child.on("message", (m) => {
          const value = m as Ready & { message?: string };
          if (value.type === "ready") {
            clearTimeout(timer);
            yes(value);
          } else if (value.message) {
            clearTimeout(timer);
            no(new Error(value.message));
          }
        });
        ended.then(() => {
          clearTimeout(timer);
          no(new Error("Child exited " + output));
        });
      });
      assert.equal(ready.transactionOpen, boundary === "before-commit");
      child.kill("SIGKILL");
      await ended;
      let calls = 0;
      const provider = {
        id: ready.config.providerId,
        async *streamTurn() {
          calls++;
          yield { type: "text.delta" as const, delta: "actual resumed fork" };
          yield { type: "finish" as const, reason: "stop" as const };
        },
      };
      engine = new MoodcodeEngine({
        dbPath: ready.dbPath,
        artifactDir: ready.artifactDir,
        providers: [provider],
        defaults: ready.config,
        conversationForks: true,
      });
      const current = forkCounts(ready.dbPath),
        effect = readFileSync(
          join(ready.base, "repository", "effect.txt"),
          "utf8",
        );
      assert.equal(effect, "effect\n");
      assert.equal(calls, 0);
      assert.equal(engine.store.getRun(ready.sourceRunId).state, "completed");
      if (boundary === "before-commit") {
        assert.deepEqual(current, ready.counts);
        assert.equal(
          engine.inspectConversationLineage(ready.targetSessionId),
          null,
        );
        assert.throws(() => engine.store.getSession(ready!.targetSessionId), {
          code: "SESSION_NOT_FOUND",
        });
      } else {
        assert.equal(current.inputs, ready.counts.inputs + 1);
        assert.equal(current.forks, 1);
        assert.equal(current.anchors, 1);
        const record = engine.inspectConversationLineage(
          ready.targetSessionId,
        )!;
        assert.equal(
          engine.store.getInput(record.input.inputId).state,
          "pending",
        );
        const duplicate = engine.forkConversationView({
          preview: {},
          requestId: ready.requestId,
          approved: true,
          approvalFingerprint: ready.approvalFingerprint,
        });
        assert.equal(duplicate.duplicate, true);
        assert.deepEqual(forkCounts(ready.dbPath), current);
        assert.equal(calls, 0);
        engine.scheduler.resume(ready.targetSessionId);
        const deadline = Date.now() + 6000;
        while (
          !engine.store
            .getSnapshot(ready.targetSessionId)
            .runs.some((r) => isTerminal(r.state))
        ) {
          assert.ok(
            Date.now() < deadline,
            "Explicit resumed fork did not settle",
          );
          await new Promise((r) => setTimeout(r, 5));
        }
        assert.equal(calls, 1);
        assert.equal(
          readFileSync(join(ready.base, "repository", "effect.txt"), "utf8"),
          effect,
        );
        assert.equal(forkCounts(ready.dbPath).tools, ready.counts.tools);
      }
    },
  );
