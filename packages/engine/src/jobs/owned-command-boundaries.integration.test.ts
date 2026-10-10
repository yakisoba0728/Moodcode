import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  EngineError,
  type ApprovalRecord,
  type RunConfig,
  type RunReceipt,
} from "@moodcode/contracts";
import type {
  PreparedTool,
  ProviderAdapter,
  ProviderEvent,
  ToolContext,
  TurnRequest,
} from "../ports.js";
import type { OwnedCommandOutputPage } from "./owned-command-host.js";
import type { OwnedCommandJobRecord } from "./owned-command-records.js";
import { jobCommand, jobFixture, jobInvoke, jobUntil } from "./fixtures/job.js";

const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 20_000,
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const nativeError = (error: unknown) => error instanceof EngineError;

/** Independent actual provider/approval/process fixture, without importing a test module. */
async function boundaryFixture(t: TestContext) {
  const f = await jobFixture(t, { createTerminal: false }),
    marker = join(f.root, "boundary-command.pid"),
    release = join(f.root, "boundary-command.release"),
    script = join(f.root, "boundary-command.mjs");
  writeFileSync(
    script,
    `import{writeFileSync,existsSync}from'node:fs';
writeFileSync(${JSON.stringify(marker)},String(process.pid));
process.stdout.write('BOUNDARY_READY:'+process.pid+'\\n');
const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write('BOUNDARY_DONE\\n',()=>process.exit(0));}},10);
`,
  );
  const command = `${quote(process.execPath)} ${quote(script)}`,
    calls: TurnRequest[] = [];
  const provider: ProviderAdapter = {
    id: f.config.providerId,
    async *streamTurn(request): AsyncIterable<ProviderEvent> {
      calls.push(request);
      if (calls.length === 1) {
        yield {
          type: "tool.call",
          call: {
            id: "actual-boundary-command",
            name: "run_command",
            input: { command, timeoutMs: 8_000 },
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
    id: "actual-boundary-command-profile",
    description: "Actual command observation boundary",
    instructions: "Execute only the native explicitly approved command",
    tools: ["run_command"],
  });
  const config: RunConfig = {
    ...f.config,
    mode: "build",
    agentProfileId: "actual-boundary-command-profile",
    limits: {
      ...f.config.limits,
      maxTurns: 2,
      maxToolCalls: 1,
      maxOutputBytes: 131_072,
      toolTimeoutMs: 10_000,
    },
    budgets: { ...f.config.budgets!, turnAllowance: 2, maxProviderAttempts: 1 },
  };
  async function submit() {
    return jobCommand<RunReceipt>(f.engine, "run.submit", {
      sessionId: f.session.id,
      requestId: randomUUID(),
      prompt: "Execute the explicitly approved actual boundary command",
      config: JSON.parse(JSON.stringify(config)),
    });
  }
  async function approve(receipt: RunReceipt) {
    await jobUntil(
      () =>
        f.engine.store
          .getSnapshot(f.session.id)
          .approvals.some(
            (value) =>
              value.runId === receipt.runId && value.status === "pending",
          ),
      "Actual command did not request native approval",
    );
    const approval = f.engine.store
      .getSnapshot(f.session.id)
      .approvals.find(
        (value) => value.runId === receipt.runId && value.status === "pending",
      )!;
    f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
    return approval;
  }
  const inspect = () =>
    jobInvoke<readonly OwnedCommandJobRecord[]>(
      f.engine,
      "inspectOwnedCommandJobs",
      f.workspace.id,
      f.session.id,
    );
  async function running(receipt: RunReceipt) {
    const approval = await approve(receipt);
    await jobUntil(
      () =>
        existsSync(marker) &&
        inspect().some((value) => value.state === "running"),
      "Actual approved command did not acquire its native running source",
    );
    return {
      approval,
      job: inspect()[0]!,
      pid: Number(readFileSync(marker, "utf8")),
    };
  }
  const host = Reflect.get(f.engine, "ownedCommandHost") as {
    beforeSpawn(context: ToolContext, prepared: PreparedTool): object;
  };
  return {
    ...f,
    marker,
    command,
    calls,
    host,
    inspect,
    submit,
    approve,
    running,
    finish: () => writeFileSync(release, "Actual explicit continuation\n"),
  };
}

test(
  "actual command producer rejects copied contexts without invoking traps and expires the original after native settlement",
  posix,
  async (t) => {
    const f = await boundaryFixture(t),
      before = f.host.beforeSpawn.bind(f.host);
    let original: ToolContext | undefined,
      approved:
        | ReturnType<typeof f.engine.coordinator.readOwnedCommandContext>
        | undefined,
      traps = 0;
    f.host.beforeSpawn = (context, prepared) => {
      original = context;
      approved = f.engine.coordinator.readOwnedCommandContext(context, "start");
      assert.throws(
        () =>
          f.engine.coordinator.readOwnedCommandContext({ ...context }, "start"),
        nativeError,
      );
      const proxy = new Proxy(context, {
        get() {
          traps++;
          throw new Error("Proxy trap must remain unused");
        },
        getPrototypeOf() {
          traps++;
          throw new Error("Proxy trap must remain unused");
        },
        ownKeys() {
          traps++;
          throw new Error("Proxy trap must remain unused");
        },
      });
      assert.throws(
        () => f.engine.coordinator.readOwnedCommandContext(proxy, "start"),
        nativeError,
      );
      const getterCopy = { ...context };
      Object.defineProperty(getterCopy, "workspace", {
        get() {
          traps++;
          throw new Error("Copied getter must remain unused");
        },
      });
      assert.throws(
        () => f.engine.coordinator.readOwnedCommandContext(getterCopy, "start"),
        nativeError,
      );
      assert.equal(traps, 0);
      return before(context, prepared);
    };
    const receipt = await f.submit(),
      selected = await f.running(receipt);
    assert.ok(original && approved);
    assert.equal(approved.runId, receipt.runId);
    assert.equal(approved.approvalId, selected.approval.id);
    assert.equal(approved.approvalFingerprint, selected.approval.fingerprint);
    assert.equal(approved.toolCallId, selected.job.source.toolCallId);
    assert.equal(f.inspect().length, 1);
    process.kill(selected.pid, 0);
    f.finish();
    assert.equal((await f.engine.waitForRun(receipt.runId)).state, "completed");
    assert.equal(f.inspect()[0]!.state, "completed");
    for (const phase of ["start", "settle"] as const)
      assert.throws(
        () => f.engine.coordinator.readOwnedCommandContext(original!, phase),
        nativeError,
      );
    assert.equal(traps, 0);
  },
);

test(
  "an accessor inserted into genuine command context metadata is rejected before native source admission or process spawn",
  posix,
  async (t) => {
    const f = await boundaryFixture(t),
      before = f.host.beforeSpawn.bind(f.host);
    let traps = 0,
      observations = 0;
    f.host.beforeSpawn = (context, prepared) => {
      observations++;
      const descriptor = Object.getOwnPropertyDescriptor(
        context.limits,
        "maxOutputBytes",
      )!;
      Object.defineProperty(context.limits, "maxOutputBytes", {
        configurable: true,
        enumerable: true,
        get() {
          traps++;
          throw new Error("Genuine metadata getter must remain unused");
        },
      });
      try {
        return before(context, prepared);
      } finally {
        Object.defineProperty(context.limits, "maxOutputBytes", descriptor);
      }
    };
    const receipt = await f.submit(),
      approval = await f.approve(receipt);
    await f.engine.waitForRun(receipt.runId);
    assert.equal(observations, 1);
    assert.equal(traps, 0);
    assert.equal(existsSync(f.marker), false);
    assert.deepEqual(f.inspect(), []);
    const tool = f.engine.store.getToolCall(approval.toolCallId);
    assert.equal(tool.state, "failed");
    assert.match(tool.output!, /TEAM_MODEL_OWNER_STALE/);
    assert.equal(f.engine.store.listCheckpoints(receipt.runId).length, 0);
  },
);

test(
  "actual native owned source SQL admission failure rolls back its anchor and cannot spawn the approved command",
  posix,
  async (t) => {
    const f = await boundaryFixture(t),
      db = new DatabaseSync(f.dbPath);
    const before = f.host.beforeSpawn.bind(f.host);
    let admissionFailure: unknown;
    f.host.beforeSpawn = (context, prepared) => {
      try {
        return before(context, prepared);
      } catch (error) {
        admissionFailure = error;
        throw error;
      }
    };
    try {
      db.exec(`CREATE TRIGGER reject_owned_source BEFORE INSERT ON session_documents
WHEN NEW.kind LIKE 'command.job.%' AND json_extract(NEW.data,'$.state')='starting'
BEGIN SELECT RAISE(ABORT,'Actual owned source admission failed'); END;`);
      const receipt = await f.submit(),
        approval: ApprovalRecord = await f.approve(receipt);
      await f.engine.waitForRun(receipt.runId);
      assert.equal(existsSync(f.marker), false);
      assert.deepEqual(f.inspect(), []);
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS count FROM session_documents WHERE kind LIKE 'command.job.%'",
          )
          .get()!.count,
        0,
      );
      const tool = f.engine.store.getToolCall(approval.toolCallId);
      assert.equal(tool.state, "failed");
      assert.ok(admissionFailure instanceof Error);
      assert.match(
        admissionFailure.message,
        /Actual owned source admission failed/,
      );
      assert.match(tool.output!, /TOOL_ERROR/);
      assert.equal(f.engine.store.listCheckpoints(receipt.runId).length, 0);
      assert.equal(
        f
          .rows("session_events")
          .filter(
            (row) =>
              row.type === "session.document.updated" &&
              String(row.payload).includes("command.job."),
          ).length,
        0,
      );
    } finally {
      db.exec("DROP TRIGGER IF EXISTS reject_owned_source");
      db.close();
    }
  },
);

test(
  "same-byte completed artifact inode replacement or removal rejects new physical capture while an original frozen output page remains data",
  posix,
  async (t) => {
    const f = await boundaryFixture(t),
      receipt = await f.submit(),
      selected = await f.running(receipt);
    f.finish();
    assert.equal((await f.engine.waitForRun(receipt.runId)).state, "completed");
    const completed = f.inspect()[0]!;
    assert.equal(completed.state, "completed");
    assert.ok(completed.completion);
    const artifact = completed.completion.stdout,
      handle = jobInvoke<object>(f.engine, "captureOwnedCommandJobOutput", {
        workspaceId: f.workspace.id,
        jobId: completed.jobId,
      }),
      frozen = jobInvoke<OwnedCommandOutputPage>(
        f.engine,
        "readOwnedCommandJobOutput",
        handle,
      ),
      backup = `${artifact.path}.original-inode`,
      events = f.rows("session_events").length;
    assert.match(
      frozen.output.map((value) => value.data).join(""),
      /BOUNDARY_DONE/,
    );
    renameSync(artifact.path, backup);
    try {
      copyFileSync(backup, artifact.path);
      assert.notEqual(
        statSync(artifact.path, { bigint: true }).ino.toString(),
        artifact.inode,
      );
      assert.equal(
        createHash("sha256").update(readFileSync(artifact.path)).digest("hex"),
        artifact.sha256,
      );
      assert.throws(
        () =>
          jobInvoke(f.engine, "captureOwnedCommandJobOutput", {
            workspaceId: f.workspace.id,
            jobId: completed.jobId,
          }),
        (error) =>
          error instanceof EngineError &&
          error.code === "COMMAND_JOB_ARTIFACT_STALE",
      );
      assert.deepEqual(
        jobInvoke<OwnedCommandOutputPage>(
          f.engine,
          "readOwnedCommandJobOutput",
          handle,
        ),
        frozen,
      );
      rmSync(artifact.path);
      assert.throws(
        () =>
          jobInvoke(f.engine, "captureOwnedCommandJobOutput", {
            workspaceId: f.workspace.id,
            jobId: completed.jobId,
          }),
        (error) =>
          error instanceof EngineError &&
          error.code === "COMMAND_JOB_ARTIFACT_STALE",
      );
      assert.equal(f.inspect()[0]!.state, "completed");
      assert.equal(f.rows("session_events").length, events);
      assert.equal(f.calls.length, 2);
    } finally {
      rmSync(artifact.path, { force: true });
      renameSync(backup, artifact.path);
      jobInvoke(f.engine, "releaseOwnedCommandJobHandle", handle);
    }
  },
);
