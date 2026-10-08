import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { RunConfig, RunReceipt } from "@moodcode/contracts";
import type { ProviderAdapter, ProviderEvent, TurnRequest } from "../ports.js";
import type { OwnedCommandJobRecord } from "./owned-command-records.js";
import type { OwnedCommandDeliveryTargetProof } from "./owned-command-result.js";
import type { OwnedCommandDeliveryResult } from "./owned-command-delivery-records.js";
import { jobCommand, jobFixture, jobInvoke, jobUntil } from "./fixtures/job.js";

const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 20_000,
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function capFixture(t: TestContext, bytes: number) {
  const f = await jobFixture(t, { createTerminal: false }),
    script = join(f.root, "input-cap.mjs"),
    marker = join(f.root, "input-cap.pid");
  writeFileSync(
    script,
    `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},String(process.pid));process.stdout.write('ACTUAL_INPUT_CAP_COMPLETE\\n');`,
  );
  const executable = `${quote(process.execPath)} ${quote(script)}\n# `,
    command = executable + "h".repeat(bytes - Buffer.byteLength(executable)),
    calls: TurnRequest[] = [];
  assert.equal(Buffer.byteLength(command), bytes);
  const provider: ProviderAdapter = {
    id: f.config.providerId,
    async *streamTurn(request): AsyncIterable<ProviderEvent> {
      calls.push(request);
      if (calls.length === 1) {
        yield {
          type: "tool.call",
          call: {
            id: "actual-input-cap-command",
            name: "run_command",
            input: { command, timeoutMs: 4_000 },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else yield { type: "finish", reason: "stop" };
    },
  };
  (
    Reflect.get(f.engine, "runtimeProviders") as Map<string, ProviderAdapter>
  ).set(provider.id, provider);
  f.engine.profiles.register({
    id: "actual-input-cap-profile",
    description: "Actual bounded command input",
    instructions: "Only run the exact explicitly approved command",
    tools: ["run_command"],
  });
  const config: RunConfig = {
    ...f.config,
    mode: "build",
    agentProfileId: "actual-input-cap-profile",
    limits: { ...f.config.limits, maxTurns: 2, maxToolCalls: 1 },
    budgets: { ...f.config.budgets!, turnAllowance: 2 },
  };
  const receipt = await jobCommand<RunReceipt>(f.engine, "run.submit", {
    sessionId: f.session.id,
    requestId: randomUUID(),
    prompt: "Execute the exact bounded actual command input",
    config: JSON.parse(JSON.stringify(config)),
  });
  return { ...f, config, receipt, command, marker, calls };
}

test(
  "an actual approved 11 KiB command retains its full source and consumes no enlarged native budgets through result delivery",
  posix,
  async (t) => {
    const f = await capFixture(t, 11_264);
    await jobUntil(() => {
      const run = f.engine.store.getRun(f.receipt.runId);
      assert.ok(
        !["failed", "cancelled", "completed"].includes(run.state),
        `Actual bounded command ended before approval: ${JSON.stringify(run)}`,
      );
      return f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some((value) => value.status === "pending");
    }, "The actual 11 KiB command did not request native approval");
    const approval = f.engine.store
      .getSnapshot(f.session.id)
      .approvals.find((value) => value.status === "pending")!;
    assert.equal(approval.preview.command, f.command);
    assert.equal(existsSync(f.marker), false);
    f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
    const run = await f.engine.waitForRun(f.receipt.runId),
      tool = f.engine.store.getToolCall(approval.toolCallId);
    assert.equal(run.state, "completed");
    assert.equal(tool.state, "completed");
    assert.equal((tool.input as { command: string }).command, f.command);
    assert.match(tool.output!, /ACTUAL_INPUT_CAP_COMPLETE/);
    const pid = Number(readFileSync(f.marker, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(
      () => process.kill(pid, 0),
      (error) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
    assert.deepEqual(run.config.limits, f.config.limits);
    assert.deepEqual(run.config.budgets, f.config.budgets);
    assert.equal(
      run.config.limits.maxContextBytes,
      f.config.limits.maxContextBytes,
    );
    assert.equal(
      run.config.limits.maxOutputBytes,
      f.config.limits.maxOutputBytes,
    );
    const records = jobInvoke<readonly OwnedCommandJobRecord[]>(
      f.engine,
      "inspectOwnedCommandJobs",
      f.workspace.id,
    );
    assert.equal(records.length, 1);
    const job = records[0]!;
    assert.equal(job.state, "completed");
    assert.equal(job.source.command, f.command);
    assert.equal(job.source.approvalFingerprint, approval.fingerprint);
    assert.equal(job.completion?.outcome.cleanupConfirmed, true);
    assert.equal(job.completion?.outcome.exitCode, 0);
    await jobCommand(f.engine, "session.pause", { sessionId: f.session.id });
    const target = jobInvoke<object>(
      f.engine,
      "captureOwnedCommandJobDeliveryTarget",
      {
        workspaceId: f.workspace.id,
        jobId: job.jobId,
        config: f.config,
      },
    );
    try {
      const proof = jobInvoke<OwnedCommandDeliveryTargetProof>(
        f.engine,
        "readOwnedCommandJobDeliveryTarget",
        target,
      );
      assert.equal(proof.settled.source.command, f.command);
      assert.equal(proof.settled.sha256, job.sha256);
      const delivery = jobInvoke<OwnedCommandDeliveryResult>(
        f.engine,
        "deliverOwnedCommandJobResult",
        {
          workspaceId: f.workspace.id,
          requestId: randomUUID(),
          expectedRevision: 0,
          target,
          approved: true,
        },
      );
      assert.equal(delivery.kind, "accepted");
      const input = f.engine.store.getInput(delivery.record.accepted.inputId);
      assert.equal(input.state, "pending");
      assert.equal(input.prompt.includes(f.command), false);
      assert.match(input.prompt, /untrusted-command-observation/);
      assert.deepEqual(input.config.limits, f.config.limits);
      assert.deepEqual(input.config.budgets, f.config.budgets);
      assert.equal(f.calls.length, 2);
    } finally {
      jobInvoke(f.engine, "releaseOwnedCommandJobDeliveryHandle", target);
    }
  },
);

test(
  "an actual 16385-byte command is rejected before approval, native owned admission and process spawn",
  posix,
  async (t) => {
    const f = await capFixture(t, 16_385),
      run = await f.engine.waitForRun(f.receipt.runId),
      snapshot = f.engine.store.getSnapshot(f.session.id);
    assert.equal(run.state, "completed");
    assert.equal(existsSync(f.marker), false);
    assert.equal(snapshot.approvals.length, 0);
    assert.equal(snapshot.tools.length, 1);
    assert.equal(snapshot.tools[0]!.state, "failed");
    assert.match(snapshot.tools[0]!.output!, /INVALID_TOOL_INPUT/);
    assert.match(snapshot.tools[0]!.output!, /16384/);
    assert.equal(f.engine.store.listCheckpoints(run.id).length, 0);
    assert.deepEqual(
      jobInvoke(f.engine, "inspectOwnedCommandJobs", f.workspace.id),
      [],
    );
    assert.equal(
      f
        .rows("session_events")
        .filter((value) => String(value.type).startsWith("command.job."))
        .length,
      0,
    );
    assert.deepEqual(run.config.limits, f.config.limits);
    assert.deepEqual(run.config.budgets, f.config.budgets);
    assert.equal(f.calls.length, 2);
  },
);
