import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MoodcodeEngine } from "../engine.js";
import type { RunConfigInput } from "@moodcode/contracts";
import type { ProviderAdapter } from "../ports.js";
import {
  EFFECT_BEFORE,
  EFFECT_AFTER,
  effectsCommand,
  effectsUntil,
} from "./fixtures/effects.js";
const profile = {
  id: "actual-workflow-effects",
  description: "Actual bounded workflow effects.",
  instructions:
    "Only registered workflow stages. All effects require approval.",
  tools: [
    "request_workflow_stage",
    "observe_workflow_stage",
    "merge_workflow_stage",
    "deliver_workflow_result",
    "read_file",
    "apply_patch",
    "run_command",
    "verify_changes",
    "merge_child_changes",
  ],
};
for (const boundary of [
  "child-completed",
  "stage-before-commit",
  "merge-before-receipt",
  "delivery-before-commit",
  "delivery-after-commit",
] as const)
  test(
    `real Root SIGKILL at ${boundary} preserves native effects without any automatic child, merge or inbox replay`,
    { timeout: 30000 },
    async (t) => {
      const base = realpathSync(
          mkdtempSync(join(tmpdir(), "moodcode-workflow-effects-crash-")),
        ),
        child = fork(
          existsSync(new URL("./fixtures/effects-crash.js", import.meta.url))
            ? new URL("./fixtures/effects-crash.js", import.meta.url)
            : new URL(
                "../../dist/workflows/fixtures/effects-crash.js",
                import.meta.url,
              ),
          [base, boundary],
          { execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] },
        );
      let stderr = "",
        stdout = "";
      child.stderr!.on("data", (b) => (stderr += b));
      child.stdout!.on("data", (b) => (stdout += b));
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        rmSync(base, { recursive: true, force: true });
      });
      await new Promise<void>((yes, no) => {
        const timer = setTimeout(
          () => no(new Error("Crash fixture not ready: " + stderr + stdout)),
          20000,
        );
        child.once("error", no);
        child.once("exit", (code) => {
          clearTimeout(timer);
          no(
            new Error("Crash fixture exited " + code + ": " + stderr + stdout),
          );
        });
        child.once("message", () => {
          clearTimeout(timer);
          yes();
        });
      });
      child.kill("SIGKILL");
      await new Promise<void>((done) => child.once("exit", () => done()));
      const state = JSON.parse(
        readFileSync(join(base, "crash-state.json"), "utf8"),
      ) as {
        workspaceId: string;
        sessionId: string;
        parentRunId: string;
        instanceId: string;
        root: string;
        dbPath: string;
        artifactDir: string;
        defaults: RunConfigInput;
      };
      let entries = 0;
      const provider: ProviderAdapter = {
        id: "workflow-effects-fixture",
        async *streamTurn() {
          entries++;
          yield {
            type: "text.delta",
            delta: "Explicitly resumed result DATA.",
          };
          yield { type: "finish", reason: "stop" };
        },
      };
      const db = new DatabaseSync(state.dbPath, { readOnly: true }),
        inputCount = Number(
          db
            .prepare(
              "SELECT count(*) n FROM session_inputs WHERE request_id LIKE 'workflow-result:%'",
            )
            .get()!.n,
        ),
        receiptCount = Number(
          db
            .prepare(
              "SELECT count(*) n FROM session_documents WHERE kind LIKE 'workflow.delivery.%'",
            )
            .get()!.n,
        );
      db.close();
      assert.equal(inputCount, boundary === "delivery-after-commit" ? 1 : 0);
      assert.equal(receiptCount, inputCount);
      const engine = new MoodcodeEngine({
        dbPath: state.dbPath,
        artifactDir: state.artifactDir,
        providers: [provider],
        workflows: true,
        verificationTools: true,
        agentProfiles: [profile],
        defaults: state.defaults,
      });
      t.after(() => engine.close());
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(entries, 0);
      assert.throws(() =>
        engine.bindWorkflowModelTools({
          workspaceId: state.workspaceId,
          instanceId: state.instanceId,
        }),
      );
      assert.equal(
        readFileSync(join(state.root, "seed.txt"), "utf8"),
        [
          "merge-before-receipt",
          "delivery-before-commit",
          "delivery-after-commit",
        ].includes(boundary)
          ? EFFECT_AFTER
          : EFFECT_BEFORE,
      );
      const effect = engine.inspectWorkflowEffect(
        state.workspaceId,
        state.instanceId,
        "edit",
      );
      if (boundary === "merge-before-receipt") {
        assert.equal(effect!.state, "uncertain");
        assert.equal(
          engine.store.hasUncertainWorkspace(state.workspaceId),
          true,
        );
      }
      if (["child-completed", "stage-before-commit"].includes(boundary)) {
        assert.equal(effect, null);
        assert.equal(
          engine.inspectWorkflow(state.workspaceId, state.instanceId)!.state,
          "uncertain",
        );
      }
      if (boundary === "delivery-after-commit") {
        const receipt = engine.inspectWorkflowDelivery(
          state.workspaceId,
          state.instanceId,
        )!;
        assert.equal(receipt.state, "accepted");
        assert.equal(
          engine.store.getInput(receipt.input.inputId).state,
          "pending",
        );
        await effectsCommand(engine, "session.resume", {
          sessionId: state.sessionId,
        });
        await effectsUntil(
          () => entries === 1,
          "Committed result was not explicitly resumed",
        );
        await effectsUntil(
          () =>
            engine.store.getInput(receipt.input.inputId).state === "promoted",
          "Committed result did not promote",
        );
        assert.equal(engine.children.tasks.list(state.sessionId).length, 2);
      }
    },
  );
