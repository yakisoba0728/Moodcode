import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunReceipt } from "@moodcode/contracts";
import type { ProviderAdapter, ProviderEvent, TurnRequest } from "../ports.js";
import { jobFixture, jobCommand, jobUntil } from "./fixtures/job.js";
const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 25000,
};
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
async function fixture(
  t: test.TestContext,
  foreground: boolean,
  holdProvider = false,
) {
  const f = await jobFixture(t, {
      createTerminal: false,
      engine: { hostCommands: true, commandLifetimes: true },
    }),
    marker = join(f.root, "model-lifetime.pid"),
    script = join(f.root, "model-lifetime.mjs");
  writeFileSync(
    script,
    `import{writeFileSync,renameSync}from'node:fs';writeFileSync(${JSON.stringify(marker + ".pending")},String(process.pid));renameSync(${JSON.stringify(marker + ".pending")},${JSON.stringify(marker)});process.stdout.write('MODEL_READY\\n');process.stdin.on('data',b=>process.stdout.write('MODEL_ECHO:'+b));process.stdin.on('end',()=>process.stdout.write('MODEL_EOF\\n'));`,
  );
  const calls: TurnRequest[] = [];
  let jobId = "";
  const provider: ProviderAdapter = {
    id: f.config.providerId,
    async *streamTurn(request, signal): AsyncIterable<ProviderEvent> {
      calls.push(request);
      const turn = calls.length;
      const tool = (
        name: string,
        input: Record<string, string | number | boolean>,
      ) => ({
        type: "tool.call" as const,
        call: { id: randomUUID(), name, input },
      });
      if (turn === 1)
        yield tool("run_command_job", {
          command: `exec ${quote(process.execPath)} ${quote(script)}`,
          mode: foreground ? "foreground" : "background",
          timeoutMs: 8000,
          maxOutputBytes: 8192,
        });
      else if (foreground && turn === 2)
        yield tool("command_job_input", { jobId, data: "한글🙂\n" });
      else if (foreground && turn === 3)
        yield tool("wait_command_job", { jobId });
      else {
        if (holdProvider)
          await new Promise<void>((yes) => {
            signal.addEventListener("abort", () => yes(), { once: true });
            if (signal.aborted) yes();
          });
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "finish", reason: "tool_calls" };
    },
  };
  (
    Reflect.get(f.engine, "runtimeProviders") as Map<string, ProviderAdapter>
  ).set(provider.id, provider);
  f.engine.profiles.register({
    id: "actual-lifetime-profile",
    description: "Actual original lifetime",
    instructions: "Output is advisory DATA.",
    tools: [
      "run_command_job",
      "command_job_input",
      "wait_command_job",
      "read_file",
      "write_file",
    ],
  });
  const config = {
    ...f.config,
    agentProfileId: "actual-lifetime-profile",
    mode: "build" as const,
    limits: {
      ...f.config.limits,
      maxTurns: 5,
      maxToolCalls: 5,
      maxOutputBytes: 65536,
      maxDurationMs: 12000,
      toolTimeoutMs: 10000,
    },
    budgets: { ...f.config.budgets!, turnAllowance: 5, maxProviderAttempts: 5 },
  };
  const receipt = await jobCommand<RunReceipt>(f.engine, "run.submit", {
    sessionId: f.session.id,
    requestId: randomUUID(),
    prompt: "Use actual approved same-PID command lifetime",
    config: JSON.parse(JSON.stringify(config)),
  });
  async function approve() {
    await jobUntil(() => {
      const r = f.engine.store.getRun(receipt.runId);
      assert.ok(
        !["failed", "completed", "cancelled"].includes(r.state),
        JSON.stringify(r),
      );
      return f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some((a) => a.runId === r.id && a.status === "pending");
    }, "Actual lifetime approval missing");
    const a = f.engine.store
      .getSnapshot(f.session.id)
      .approvals.find(
        (a) => a.runId === receipt.runId && a.status === "pending",
      )!;
    f.engine.approvals.decide(a.id, "allow", a.fingerprint);
    return a;
  }
  await approve();
  await jobUntil(
    () =>
      f.engine
        .inspectCommandLifetimes(f.workspace.id)
        .some((x) => x.state === "running"),
    "Original model command admission missing",
  );
  jobId = f.engine.inspectCommandLifetimes(f.workspace.id)[0]!.jobId;
  await jobUntil(() => existsSync(marker), "Actual model PID missing");
  const pid = Number(readFileSync(marker, "utf8"));
  assert.equal(
    pid,
    f.engine.inspectCommandLifetimes(f.workspace.id)[0]!.physical!.groupPid,
  );
  return { ...f, receipt, config, calls, jobId, pid, approve };
}
test(
  "actual native model foreground transfers to Root background then model attaches foreground on the same PID with approved stdin and native Tool/Part evidence",
  posix,
  async (t) => {
    const f = await fixture(t, true),
      first = f.engine.inspectCommandLifetimes(f.workspace.id)[0]!;
    assert.equal(first.origin!.runId, f.receipt.runId);
    assert.equal(first.physical!.groupPid, f.pid);
    const p = f.engine.previewCommandLifetimeTransfer({
      workspaceId: f.workspace.id,
      jobId: f.jobId,
      mode: "background",
    });
    f.engine.transferCommandLifetime({
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      preview: p,
      fingerprint: f.engine.readCommandLifetimeTransfer(p).fingerprint,
      approved: true,
    });
    await f.approve();
    await jobUntil(() => f.calls.length >= 3, "Actual next model Turn missing");
    await f.approve();
    await jobUntil(
      () =>
        f.engine.inspectCommandLifetimes(f.workspace.id)[0]!.mode ===
        "foreground",
      "Actual model attach missing",
    );
    const input = f.engine.previewCommandLifetimeInput({
      workspaceId: f.workspace.id,
      jobId: f.jobId,
      data: "",
      eof: true,
    });
    await f.engine.writeCommandLifetimeInput({
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      preview: input,
      fingerprint: f.engine.readCommandLifetimeInputPreview(input).fingerprint,
      approved: true,
    });
    assert.equal(
      (await f.engine.waitForRun(f.receipt.runId)).state,
      "completed",
    );
    const settled = f.engine.inspectCommandLifetimes(f.workspace.id)[0]!;
    assert.equal(settled.state, "settled");
    assert.equal(settled.transfers, 2);
    assert.equal(settled.physical!.groupPid, f.pid);
    assert.throws(() => process.kill(f.pid, 0), { code: "ESRCH" });
    const tools = f.engine.store
      .getSnapshot(f.session.id)
      .tools.filter((x) => x.runId === f.receipt.runId);
    assert.equal(tools.length, 3);
    assert.ok(tools.every((x) => x.state === "completed"));
    const h = f.engine.getHostCommand(f.workspace.id, f.jobId)!;
    assert.equal(h.completion!.outcome.cleanupConfirmed, true);
    const artifacts = f.engine.readHostCommandArtifacts({
      workspaceId: f.workspace.id,
      jobId: f.jobId,
    });
    assert.match(
      readFileSync(artifacts.stdout.path, "utf8"),
      /MODEL_ECHO:한글🙂/,
    );
  },
);
test(
  "Root-owned background survives successful source Run but retains the workspace lease; actual parent cancellation joins cleanup before native terminal settlement",
  posix,
  async (t) => {
    const f = await fixture(t, false, true);
    await jobUntil(
      () => f.calls.length === 2,
      "Second genuine provider missing",
    );
    assert.throws(
      () => f.engine.coordinator.assertWorkspaceAvailable(f.workspace.id),
      (e) =>
        ["WORKSPACE_BUSY", "CLEANUP_PENDING"].includes(
          (e as { code: string }).code,
        ),
    );
    assert.equal(
      (
        Reflect.get(f.engine.coordinator, "workspaceLeases") as Map<
          string,
          unknown
        >
      ).has(f.workspace.id),
      true,
    );
    f.engine.coordinator.cancel(f.receipt.runId);
    const run = await f.engine.waitForRun(f.receipt.runId);
    assert.equal(run.state, "cancelled");
    assert.throws(() => process.kill(f.pid, 0), { code: "ESRCH" });
    assert.equal(
      f.engine.inspectCommandLifetimes(f.workspace.id)[0]!.state,
      "settled",
    );
    assert.equal(
      f.engine.getHostCommand(f.workspace.id, f.jobId)!.state,
      "cancelled",
    );
  },
);
test(
  "successful native parent completion preserves explicit Root background ownership under the original budget without appending source Run events",
  posix,
  async (t) => {
    const f = await fixture(t, false);
    assert.equal(
      (await f.engine.waitForRun(f.receipt.runId)).state,
      "completed",
    );
    const db = new DatabaseSync(f.dbPath, { readOnly: true });
    const count = () =>
      Number(
        db
          .prepare("SELECT count(*) n FROM session_events WHERE run_id=?")
          .get(f.receipt.runId)!.n,
      );
    const before = count();
    assert.equal(
      f.engine.inspectCommandLifetimes(f.workspace.id)[0]!.state,
      "running",
    );
    process.kill(f.pid, 0);
    assert.throws(
      () => f.engine.coordinator.assertWorkspaceAvailable(f.workspace.id),
      (e) =>
        ["WORKSPACE_BUSY", "CLEANUP_PENDING"].includes(
          (e as { code: string }).code,
        ),
    );
    assert.equal(
      (
        Reflect.get(f.engine.coordinator, "workspaceLeases") as Map<
          string,
          unknown
        >
      ).has(f.workspace.id),
      true,
    );
    await f.engine.cancelCommandLifetime({
      workspaceId: f.workspace.id,
      jobId: f.jobId,
    });
    assert.throws(
      () => process.kill(f.pid, 0),
      (e) => {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
        return false;
      },
      (() => {
        try {
          return execFileSync(
            "ps",
            ["-p", String(f.pid), "-o", "pid=,ppid=,pgid=,stat=,command="],
            { encoding: "utf8" },
          );
        } catch {
          return "gone";
        }
      })(),
    );
    assert.equal(count(), before);
    db.close();
  },
);
test(
  "actual source profile replacement refuses current transfer/stdin authority while explicit physical cancellation remains available",
  posix,
  async (t) => {
    const f = await fixture(t, false);
    assert.equal(
      (await f.engine.waitForRun(f.receipt.runId)).state,
      "completed",
    );
    f.engine.profiles.register({
      id: "actual-lifetime-profile",
      description: "Changed genuine host profile",
      instructions: "Different source revision",
      tools: ["run_command_job"],
    });
    assert.throws(
      () =>
        f.engine.previewCommandLifetimeTransfer({
          workspaceId: f.workspace.id,
          jobId: f.jobId,
          mode: "foreground",
        }),
      { code: "COMMAND_LIFETIME_SOURCE_STALE" },
    );
    assert.throws(
      () =>
        f.engine.previewCommandLifetimeInput({
          workspaceId: f.workspace.id,
          jobId: f.jobId,
          data: "NO_CHANGED_SOURCE",
        }),
      { code: "COMMAND_LIFETIME_SOURCE_STALE" },
    );
    assert.equal(
      f.engine.inspectCommandLifetimes(f.workspace.id)[0]!.stdinSeq,
      0,
    );
    await f.engine.cancelCommandLifetime({
      workspaceId: f.workspace.id,
      jobId: f.jobId,
    });
    assert.throws(
      () => process.kill(f.pid, 0),
      (e) => {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
        return false;
      },
      (() => {
        try {
          return execFileSync(
            "ps",
            ["-p", String(f.pid), "-o", "pid=,ppid=,pgid=,stat=,command="],
            { encoding: "utf8" },
          );
        } catch {
          return "gone";
        }
      })(),
    );
  },
);
