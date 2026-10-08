import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { RunConfig, RunReceipt } from "@moodcode/contracts";
import type { ProviderAdapter, ProviderEvent, TurnRequest } from "../ports.js";
import { jobCommand, jobFixture, jobInvoke, jobUntil } from "./fixtures/job.js";
import type { OwnedCommandJobRecord } from "./owned-command-records.js";

const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 20_000,
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

for (const jobs of [false, true])
  test(
    `actual command input rewrite preserves original Tool data and exact effective approval with jobs ${jobs ? "enabled" : "disabled"}`,
    posix,
    async (t) => {
      const f = await jobFixture(t, { createTerminal: false, jobs }),
        originalMarker = join(f.root, "model-original.pid"),
        effectiveMarker = join(f.root, "host-effective.pid"),
        originalScript = join(f.root, "model-original.mjs"),
        effectiveScript = join(f.root, "host-effective.mjs");
      for (const [script, marker, output] of [
        [originalScript, originalMarker, "MODEL_ORIGINAL_ONLY"],
        [effectiveScript, effectiveMarker, "ACTUAL_HOST_EFFECTIVE"],
      ])
        writeFileSync(
          script!,
          `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},String(process.pid));process.stdout.write(${JSON.stringify(`${output}\n`)});`,
        );
      const originalCommand = `${quote(process.execPath)} ${quote(originalScript)}`,
        effectiveCommand = `${quote(process.execPath)} ${quote(effectiveScript)}`,
        originalInput = { command: originalCommand, timeoutMs: 4_000 },
        effectiveInput = { command: effectiveCommand, timeoutMs: 4_000 },
        originalSha256 = createHash("sha256")
          .update(JSON.stringify(originalInput))
          .digest("hex"),
        calls: TurnRequest[] = [];
      let rewrites = 0;
      f.engine.lifecycleHooks.register({
        id: "actual-command-input-rewrite",
        revision: 1,
        stages: ["tool-prepare"],
        callback(invocation) {
          assert.equal(invocation.stage, "tool-prepare");
          if (invocation.stage !== "tool-prepare") return;
          assert.equal(invocation.metadata.toolName, "run_command");
          assert.equal(invocation.metadata.inputSha256, originalSha256);
          rewrites++;
          return {
            kind: "rewrite-input",
            expectedInputSha256: invocation.metadata.inputSha256,
            input: effectiveInput,
          };
        },
      });
      const provider: ProviderAdapter = {
        id: f.config.providerId,
        async *streamTurn(request): AsyncIterable<ProviderEvent> {
          calls.push(request);
          if (calls.length === 1) {
            yield {
              type: "tool.call",
              call: {
                id: "actual-rewritten-command",
                name: "run_command",
                input: originalInput,
              },
            };
            yield { type: "finish", reason: "tool_calls" };
          } else yield { type: "finish", reason: "stop" };
        },
      };
      (
        Reflect.get(f.engine, "runtimeProviders") as Map<
          string,
          ProviderAdapter
        >
      ).set(provider.id, provider);
      f.engine.profiles.register({
        id: "actual-rewrite-command-profile",
        description: "Actual host-authored command input rewrite",
        instructions: "Run only the host-authored command after exact approval",
        tools: ["run_command"],
      });
      const config: RunConfig = {
        ...f.config,
        mode: "build",
        agentProfileId: "actual-rewrite-command-profile",
        limits: {
          ...f.config.limits,
          maxTurns: 2,
          maxToolCalls: 1,
          maxOutputBytes: 65_536,
          toolTimeoutMs: 10_000,
        },
        budgets: {
          ...f.config.budgets!,
          turnAllowance: 2,
          maxProviderAttempts: 1,
        },
      };
      const receipt = await jobCommand<RunReceipt>(f.engine, "run.submit", {
        sessionId: f.session.id,
        requestId: randomUUID(),
        prompt:
          "Execute the explicit host-rewritten command after native approval",
        config: JSON.parse(JSON.stringify(config)),
      });
      await jobUntil(
        () =>
          f.engine.store
            .getSnapshot(f.session.id)
            .approvals.some((value) => value.status === "pending"),
        "Actual rewritten command did not request native approval",
      );
      const approval = f.engine.store
        .getSnapshot(f.session.id)
        .approvals.find((value) => value.status === "pending")!;
      assert.equal(approval.preview.command, effectiveCommand);
      assert.notEqual(approval.preview.command, originalCommand);
      assert.equal(existsSync(originalMarker), false);
      assert.equal(existsSync(effectiveMarker), false);
      f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
      const run = await f.engine.waitForRun(receipt.runId),
        tool = f.engine.store.getToolCall(approval.toolCallId);
      assert.equal(run.state, "completed");
      assert.equal(tool.state, "completed");
      assert.deepEqual(tool.input, originalInput);
      assert.match(tool.output!, /ACTUAL_HOST_EFFECTIVE/);
      assert.doesNotMatch(tool.output!, /MODEL_ORIGINAL_ONLY/);
      assert.equal(existsSync(originalMarker), false);
      const actualPid = Number(readFileSync(effectiveMarker, "utf8"));
      assert.ok(Number.isSafeInteger(actualPid) && actualPid > 0);
      assert.throws(
        () => process.kill(actualPid, 0),
        (error) => (error as NodeJS.ErrnoException).code === "ESRCH",
      );
      assert.equal(rewrites, 1);
      assert.equal(calls.length, 2);
      const records = jobInvoke<readonly OwnedCommandJobRecord[]>(
        f.engine,
        "inspectOwnedCommandJobs",
        f.workspace.id,
        f.session.id,
      );
      if (!jobs) assert.deepEqual(records, []);
      else {
        assert.equal(records.length, 1);
        const record = records[0]!;
        assert.equal(record.state, "completed");
        assert.equal(record.source.command, effectiveCommand);
        assert.equal(record.source.approvalId, approval.id);
        assert.equal(record.source.approvalFingerprint, approval.fingerprint);
        assert.equal(record.source.toolCallId, tool.id);
        assert.equal(record.source.runId, run.id);
        assert.ok(record.completion?.outcome.cleanupConfirmed);
        assert.equal(record.completion!.outcome.exitCode, 0);
      }
    },
  );
