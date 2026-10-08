import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  type ApprovalRecord,
  type RunConfig,
  type RunReceipt,
  EngineError,
} from "@moodcode/contracts";
import type { ProviderAdapter, ProviderEvent, TurnRequest } from "../ports.js";
import { jobCommand, jobFixture, jobInvoke, jobUntil } from "./fixtures/job.js";
import { createEngine } from "../engine.js";
import type { OwnedCommandJobRecord } from "./owned-command-records.js";
import { ownedCommandJobKind } from "./owned-command-records.js";
import { signJobData } from "./validation.js";

const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 20_000,
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function commandFixture(
  t: TestContext,
  options: { jobs?: boolean; outputBytes?: number } = {},
) {
  const f = await jobFixture(t, { createTerminal: false, jobs: options.jobs }),
    marker = join(f.root, "owned-command.pid"),
    release = join(f.root, "owned-command.release"),
    script = join(f.root, "owned-command.mjs");
  writeFileSync(
    script,
    `import{writeFileSync,existsSync}from'node:fs';
writeFileSync(${JSON.stringify(marker)},String(process.pid));
process.stdout.write('OWNED_COMMAND_READY:'+process.pid+'\\n');
${options.outputBytes ? `process.stdout.write('한글🙂'.repeat(${Math.ceil(options.outputBytes / 10)}));` : ""}
const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write('\\nOWNED_COMMAND_DONE\\n',()=>process.exit(0));}},10);
`,
  );
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const calls: TurnRequest[] = [];
  const provider: ProviderAdapter = {
    id: f.config.providerId,
    async *streamTurn(request): AsyncIterable<ProviderEvent> {
      calls.push(request);
      if (calls.length === 1) {
        yield {
          type: "tool.call",
          call: {
            id: "actual-owned-command",
            name: "run_command",
            input: { command, timeoutMs: 8_000 },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else yield { type: "finish", reason: "stop" };
    },
  };
  const providers = Reflect.get(f.engine, "runtimeProviders") as Map<
    string,
    ProviderAdapter
  >;
  providers.set(provider.id, provider);
  f.engine.profiles.register({
    id: "actual-owned-command-profile",
    description: "Actual owned command test",
    instructions: "Use only the explicitly approved run_command",
    tools: ["run_command"],
  });
  const config: RunConfig = {
    ...f.config,
    agentProfileId: "actual-owned-command-profile",
    mode: "build",
    limits: {
      ...f.config.limits,
      maxTurns: 2,
      maxToolCalls: 1,
      maxOutputBytes: 131_072,
      toolTimeoutMs: 10_000,
    },
    budgets: { ...f.config.budgets!, turnAllowance: 2, maxProviderAttempts: 1 },
  };
  async function submit(): Promise<RunReceipt> {
    return jobCommand<RunReceipt>(f.engine, "run.submit", {
      sessionId: f.session.id,
      requestId: randomUUID(),
      prompt: "Execute the actual approved owned command",
      config: JSON.parse(JSON.stringify(config)),
    });
  }
  async function approval(receipt: RunReceipt): Promise<ApprovalRecord> {
    await jobUntil(() => {
      const run = f.engine.store.getRun(receipt.runId);
      assert.ok(
        !["completed", "failed", "cancelled", "interrupted"].includes(
          run.state,
        ),
        `Run ended before command approval: ${JSON.stringify({ run, providerCalls: calls.length, tools: f.rows("tools") })}`,
      );
      return f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some(
          (row) => row.runId === receipt.runId && row.status === "pending",
        );
    }, "The actual command did not request native approval");
    const record = f.engine.store
      .getSnapshot(f.session.id)
      .approvals.find(
        (row) => row.runId === receipt.runId && row.status === "pending",
      );
    assert.ok(record);
    return record;
  }
  async function started(): Promise<number> {
    let pid = 0;
    await jobUntil(() => {
      if (!existsSync(marker)) return false;
      const text = readFileSync(marker, "utf8");
      if (!/^\d+$/.test(text)) return false;
      pid = Number(text);
      return Number.isSafeInteger(pid) && pid > 0;
    }, "The actual approved command did not publish its PID");
    return pid;
  }
  function finish() {
    writeFileSync(release, "Explicit fixture continuation\n");
  }
  return {
    ...f,
    marker,
    release,
    script,
    command,
    calls,
    config,
    submit,
    approval,
    started,
    finish,
  };
}

type Fixture = Awaited<ReturnType<typeof commandFixture>>;
interface OwnedOutputPage {
  readonly jobId: string;
  readonly sourceSha256: string;
  readonly snapshotSha256: string;
  readonly throughSeq: number;
  readonly oldestSeq: number;
  readonly observedBytes: number;
  readonly output: readonly {
    seq: number;
    stream: "stdout" | "stderr";
    data: string;
    bytes: number;
  }[];
  readonly nextAfterSeq: number;
  readonly hasMore: boolean;
  readonly rawBytes: number;
  readonly gap: null | { fromSeq: number; toSeq: number; oldestSeq: number };
}
function jobs(f: Fixture): OwnedCommandJobRecord[] {
  return jobInvoke(
    f.engine,
    "inspectOwnedCommandJobs",
    f.workspace.id,
    f.session.id,
  );
}
function get(f: Fixture, jobId: string): OwnedCommandJobRecord {
  return jobInvoke(f.engine, "getOwnedCommandJob", f.workspace.id, jobId);
}
async function running(f: Fixture, receipt: RunReceipt) {
  const approval = await f.approval(receipt);
  f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
  const pid = await f.started();
  await jobUntil(
    () => jobs(f).some((job) => job.state === "running"),
    "Actual owned native command job was not admitted",
  );
  const job = jobs(f)[0]!;
  assert.equal(job.source.runId, receipt.runId);
  assert.equal(job.source.toolCallId, approval.toolCallId);
  assert.equal(job.source.approvalId, approval.id);
  assert.equal(job.source.approvalFingerprint, approval.fingerprint);
  assert.equal(f.engine.store.getTurn(job.source.turnId).runId, receipt.runId);
  assert.equal(
    f.engine.store.getAttempt(job.source.attemptId).turnId,
    job.source.turnId,
  );
  assert.equal(
    f.engine.store.getToolCall(job.source.toolCallId).state,
    "running",
  );
  assert.ok(job.groupPid && job.groupPid > 0);
  await jobUntil(() => {
    const handle = jobInvoke<object>(f.engine, "captureOwnedCommandJobOutput", {
      workspaceId: f.workspace.id,
      jobId: job.jobId,
    });
    try {
      return (
        jobInvoke<OwnedOutputPage>(
          f.engine,
          "readOwnedCommandJobOutput",
          handle,
          { maxBytes: 65_536 },
        ).observedBytes > 0
      );
    } finally {
      jobInvoke(f.engine, "releaseOwnedCommandJobHandle", handle);
    }
  }, "The real owned output readiness event did not arrive");
  return { job, pid, approval };
}
function gone(pid: number) {
  assert.throws(
    () => process.kill(pid, 0),
    (error) => (error as NodeJS.ErrnoException).code === "ESRCH",
  );
}

test(
  "a denied or mismatched actual native command approval cannot create an owned job or launch a process",
  posix,
  async (t) => {
    const f = await commandFixture(t),
      receipt = await f.submit(),
      approval = await f.approval(receipt);
    assert.deepEqual(jobs(f), []);
    assert.throws(
      () => f.engine.approvals.decide(approval.id, "allow", "changed"),
      (error) => error instanceof EngineError,
    );
    assert.equal(existsSync(f.marker), false);
    f.engine.approvals.decide(approval.id, "deny", approval.fingerprint);
    await f.engine.waitForRun(receipt.runId);
    assert.equal(existsSync(f.marker), false);
    assert.deepEqual(jobs(f), []);
    assert.equal(
      f.engine.store.getToolCall(approval.toolCallId).state,
      "denied",
    );
  },
);

test(
  "a genuine approved command keeps its native owner while readers detach and settles only with ToolPart, checkpoint and sealed artifacts",
  posix,
  async (t) => {
    const f = await commandFixture(t),
      receipt = await f.submit(),
      selected = await running(f, receipt);
    const handle = jobInvoke<object>(f.engine, "captureOwnedCommandJobOutput", {
      workspaceId: f.workspace.id,
      jobId: selected.job.jobId,
    });
    const first = jobInvoke<OwnedOutputPage>(
      f.engine,
      "readOwnedCommandJobOutput",
      handle,
      { maxBytes: 65_536 },
    );
    assert.ok(
      first.output
        .map((row) => row.data)
        .join("")
        .includes("OWNED_COMMAND_READY"),
    );
    assert.throws(
      () => jobInvoke(f.engine, "readOwnedCommandJobOutput", { ...handle }, {}),
      (error) => error instanceof EngineError,
    );
    jobInvoke(f.engine, "releaseOwnedCommandJobHandle", handle);
    assert.throws(
      () => jobInvoke(f.engine, "readOwnedCommandJobOutput", handle, {}),
      (error) => error instanceof EngineError,
    );
    assert.equal(f.engine.store.getRun(receipt.runId).state, "running");
    process.kill(selected.pid, 0);
    f.finish();
    assert.equal((await f.engine.waitForRun(receipt.runId)).state, "completed");
    gone(selected.pid);
    const final = get(f, selected.job.jobId);
    assert.equal(final.state, "completed");
    assert.ok(final.completion);
    assert.equal(final.completion.outcome.cleanupConfirmed, true);
    assert.equal(final.completion.outcome.exitCode, 0);
    assert.equal(
      f.engine.store.getToolCall(final.source.toolCallId).state,
      "completed",
    );
    const part = f.engine.store
      .listParts(final.source.turnId)
      .find(
        (row) =>
          row.type === "tool" && row.toolCallId === final.source.toolCallId,
      );
    assert.equal(part?.state, "completed");
    assert.ok(
      f.engine.store
        .listCheckpoints(receipt.runId)
        .some((row) => row.id === final.completion!.checkpoint.id),
    );
    for (const artifact of [final.completion.stdout, final.completion.stderr]) {
      const bytes = readFileSync(artifact.path);
      assert.equal(bytes.byteLength, artifact.artifactBytes);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        artifact.sha256,
      );
    }
    const events = f.rows("session_events").length;
    get(f, final.jobId);
    jobs(f);
    assert.equal(
      f.rows("session_events").length,
      events,
      "History inspection cannot append events to the terminal Run",
    );
  },
);

test(
  "actual owned output has bounded immutable pages and honest artifact truncation under sustained output",
  posix,
  async (t) => {
    const f = await commandFixture(t, { outputBytes: 1_300_000 }),
      receipt = await f.submit(),
      selected = await running(f, receipt);
    await jobUntil(() => {
      const handle = jobInvoke<object>(
        f.engine,
        "captureOwnedCommandJobOutput",
        { workspaceId: f.workspace.id, jobId: selected.job.jobId },
      );
      try {
        return (
          jobInvoke<OwnedOutputPage>(
            f.engine,
            "readOwnedCommandJobOutput",
            handle,
            { maxBytes: 65_536 },
          ).observedBytes >= 1_300_000
        );
      } finally {
        jobInvoke(f.engine, "releaseOwnedCommandJobHandle", handle);
      }
    }, "Actual owned output was not fully observed");
    const handle = jobInvoke<object>(f.engine, "captureOwnedCommandJobOutput", {
      workspaceId: f.workspace.id,
      jobId: selected.job.jobId,
    });
    const first = jobInvoke<OwnedOutputPage>(
      f.engine,
      "readOwnedCommandJobOutput",
      handle,
      { maxBytes: 16_384 },
    );
    assert.ok(first.gap);
    assert.ok(first.rawBytes > 0 && first.rawBytes <= 16_384);
    assert.equal(
      first.output
        .map((row) => row.data)
        .join("")
        .includes("\ufffd"),
      false,
    );
    assert.throws(
      () =>
        jobInvoke(f.engine, "readOwnedCommandJobOutput", handle, {
          maxBytes: 8192,
        }),
      (error) => error instanceof EngineError,
    );
    f.finish();
    await f.engine.waitForRun(receipt.runId);
    const frozen = jobInvoke<OwnedOutputPage>(
      f.engine,
      "readOwnedCommandJobOutput",
      handle,
      { maxBytes: 16_384 },
    );
    assert.deepEqual(frozen, first);
    jobInvoke(f.engine, "releaseOwnedCommandJobHandle", handle);
    const final = get(f, selected.job.jobId);
    assert.equal(final.state, "completed");
    assert.ok(final.completion);
    assert.equal(final.completion.stdout.truncated, true);
    assert.ok(final.completion.stdout.artifactBytes <= 1_048_576);
    assert.ok(final.completion.stdout.observedBytes >= 1_300_000);
    assert.equal(final.completion.outcome.cleanupConfirmed, true);
    gone(selected.pid);
  },
);

test(
  "owned command cancellation requires the current native revision and really joins the source Run and process",
  posix,
  async (t) => {
    const f = await commandFixture(t),
      receipt = await f.submit(),
      selected = await running(f, receipt);
    await assert.rejects(
      async () =>
        jobInvoke<Promise<unknown>>(f.engine, "cancelOwnedCommandJob", {
          workspaceId: f.workspace.id,
          jobId: selected.job.jobId,
          expectedRevision: selected.job.revision + 1,
          requestId: randomUUID(),
        }),
      (error) => error instanceof EngineError,
    );
    assert.equal(f.engine.store.getRun(receipt.runId).state, "running");
    process.kill(selected.pid, 0);
    const current = get(f, selected.job.jobId);
    const cancelled = await jobInvoke<Promise<{ state: string }>>(
      f.engine,
      "cancelOwnedCommandJob",
      {
        workspaceId: f.workspace.id,
        jobId: current.jobId,
        expectedRevision: current.revision,
        requestId: randomUUID(),
      },
    );
    assert.equal(cancelled.state, "cancelled");
    gone(selected.pid);
    const final = get(f, current.jobId);
    assert.ok(
      ["cancelled", "uncertain"].includes(final.state),
      "Missing durable native outcome must remain uncertain",
    );
    if (final.state === "cancelled")
      assert.equal(final.completion!.outcome.cleanupConfirmed, true);
  },
);

test(
  "closing the real Root cancels a held owned command and reopen cannot reconstruct output or replay its process",
  posix,
  async (t) => {
    const f = await commandFixture(t),
      receipt = await f.submit(),
      selected = await running(f, receipt);
    const handle = jobInvoke<object>(f.engine, "captureOwnedCommandJobOutput", {
      workspaceId: f.workspace.id,
      jobId: selected.job.jobId,
    });
    await f.engine.close();
    gone(selected.pid);
    const reopened = createEngine({ ...f.configuration, jobs: false });
    f.engines.add(reopened);
    const stored = jobInvoke<OwnedCommandJobRecord>(
      reopened,
      "getOwnedCommandJob",
      f.workspace.id,
      selected.job.jobId,
    );
    assert.ok(["cancelled", "uncertain"].includes(stored.state));
    assert.throws(
      () => jobInvoke(reopened, "readOwnedCommandJobOutput", handle, {}),
      (error) => error instanceof EngineError,
    );
    assert.throws(
      () =>
        jobInvoke(reopened, "captureOwnedCommandJobOutput", {
          workspaceId: f.workspace.id,
          jobId: stored.jobId,
        }),
      (error) => error instanceof EngineError,
    );
    assert.equal(
      reopened.store.getRun(receipt.runId).state === "completed",
      false,
    );
    assert.equal(f.calls.length, 1);
  },
);

test(
  "ordinary approved run_command still executes when owned-job observation is disabled",
  posix,
  async (t) => {
    const f = await commandFixture(t, { jobs: false }),
      receipt = await f.submit(),
      approval = await f.approval(receipt);
    f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
    const pid = await f.started();
    f.finish();
    assert.equal((await f.engine.waitForRun(receipt.runId)).state, "completed");
    gone(pid);
    assert.deepEqual(jobs(f), []);
  },
);

test(
  "a genuine generic document CAS cannot forge a completed owned command's sealed artifact receipt",
  posix,
  async (t) => {
    const f = await commandFixture(t),
      receipt = await f.submit(),
      selected = await running(f, receipt);
    f.finish();
    assert.equal((await f.engine.waitForRun(receipt.runId)).state, "completed");
    gone(selected.pid);
    const original = get(f, selected.job.jobId);
    assert.equal(original.state, "completed");
    assert.ok(original.completion);
    const rollback = new Error("Roll back the actual forged document probe");
    const transaction = Reflect.get(f.engine.store, "transaction");
    assert.equal(typeof transaction, "function");
    assert.throws(
      () =>
        Reflect.apply(transaction, f.engine.store, [
          () => {
            const rewritten = signJobData({
              ...original,
              revision: original.revision + 1,
              completion: {
                ...original.completion!,
                stdout: {
                  ...original.completion!.stdout,
                  sha256: "f".repeat(64),
                },
              },
            });
            f.engine.store.putSessionDocument(
              f.session.id,
              ownedCommandJobKind(original.jobId),
              original.revision,
              JSON.parse(JSON.stringify(rewritten)),
            );
            for (const read of [() => get(f, original.jobId), () => jobs(f)])
              assert.throws(
                read,
                (error) =>
                  error instanceof EngineError &&
                  error.code === "OWNED_COMMAND_COMPLETION_INVALID",
              );
            throw rollback;
          },
        ]),
      (error) => error === rollback,
    );
    assert.deepEqual(get(f, original.jobId), original);
  },
);
