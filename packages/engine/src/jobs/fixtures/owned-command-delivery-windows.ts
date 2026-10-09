import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import type test from "node:test";
import {
  DEFAULT_LIMITS,
  DEFAULT_ENGINE_BUDGETS,
  type Checkpoint,
  type JsonObject,
  type MessagePart,
  type ToolCallRecord,
  type RunConfig,
  type RunReceipt,
} from "@moodcode/contracts";
import {
  normalizeSubmitInput,
  normalizeAcceptInput,
} from "@moodcode/contracts/validation";
import { SqliteStore } from "../../storage/index.js";
import type { NativeSessionStorage } from "../../storage/native.js";
import type { DatabaseSync } from "node:sqlite";
import { knowledgeHash } from "../../knowledge/validation.js";
import { signJobData } from "../validation.js";
import {
  ownedCommandJobId,
  ownedCommandJobKind,
  validateOwnedCommandJob,
  type OwnedCommandJobRecord,
  type OwnedCommandJobSource,
  type OwnedCommandCompletion,
} from "../owned-command-records.js";
import { validateOwnedCommandDeliveryTargetProof } from "../owned-command-result.js";
import {
  deliverOwnedCommandResultAtomic,
  type OwnedCommandDeliveryPorts,
} from "../owned-command-delivery-records.js";
import type { JobAcceptedInputProof } from "../delivery.js";
import { jobFixture, jobCommand, jobUntil } from "./job.js";
import type { ProviderAdapter, ProviderEvent } from "../../ports.js";
import { activePids } from "../../tools/command/windows-native-test-helpers.fixture.js";

/** Trusted Windows-shaped SQL fixture only: no physical close or Root Original is claimed as runtime proof. */
function windowsRecordFixture(
  t: test.TestContext,
  platform: string = process.platform,
  termination: string = platform === "win32"
    ? "windows-job-object"
    : "posix-process-group",
) {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const db = Reflect.get(store, "db") as DatabaseSync;
  const native = Reflect.get(store, "native") as NativeSessionStorage;
  const at = new Date().toISOString(),
    root = "/trusted-sql-fixture",
    sha = "a".repeat(64);
  store.putWorkspace({
    id: "workspace",
    root,
    gitRoot: root,
    branch: null,
    createdAt: at,
  });
  store.createSession({
    id: "session",
    workspaceId: "workspace",
    title: "Trusted native record fixture",
    createdAt: at,
  });
  const admitted = store.admit({
    sessionId: "session",
    requestId: "sql-fixture",
    prompt: "Fixture DATA",
    config: {
      providerId: "fixture",
      modelId: "fixture",
      mode: "build",
      limits: { ...DEFAULT_LIMITS },
    },
  });
  const runId = admitted.runId;
  store.commit(runId, "run.started", {}, { run: { state: "running" } });
  store.putTurn({
    schemaVersion: 2,
    id: "turn",
    sessionId: "session",
    runId,
    inputIds: [admitted.inputId],
    index: 0,
    state: "created",
    createdAt: at,
  });
  store.putAttempt({
    schemaVersion: 2,
    id: "attempt",
    sessionId: "session",
    runId,
    turnId: "turn",
    index: 0,
    providerId: "fixture",
    modelId: "fixture",
    state: "prepared",
    createdAt: at,
  });
  const command = "printf fixture",
    cwd = root,
    timeoutMs = 1000;
  const preview = {
    command,
    cwd,
    timeoutMs,
    workspaceId: "workspace",
    runId,
    toolCallId: "tool",
    platform,
    termination,
  };
  const data = { workspaceRoot: root, sessionId: "session" };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ version: 1, name: "run_command", preview, data }))
    .digest("hex");
  const prepared = {
    name: "run_command",
    input: { command, cwd, timeoutMs },
    fingerprint,
    requiresApproval: true,
    preview,
    data,
  };
  const tool: ToolCallRecord = {
    id: "tool",
    runId,
    sessionId: "session",
    name: "run_command",
    input: prepared.input,
    state: "requested",
  };
  store.commit(runId, "tool.requested", { toolCallId: tool.id }, { tool });
  const approval = {
    id: "approval",
    sessionId: "session",
    runId,
    toolCallId: "tool",
    toolName: "run_command",
    fingerprint: "b".repeat(64),
    preview: { ...preview, runtimeExtra: "allowed" },
    status: "allowed" as const,
    createdAt: at,
    resolvedAt: at,
  };
  store.commit(
    runId,
    "approval.allowed",
    { approvalId: approval.id },
    { approval },
  );
  tool.state = "running";
  store.commit(runId, "tool.running", { toolCallId: tool.id }, { tool });
  const pin = signJobData({
    workspaceId: "workspace",
    sessionId: "session",
    runId,
    turnId: "turn",
    attemptId: "attempt",
    toolCallId: "tool",
    approvalId: "approval",
    approvalFingerprint: approval.fingerprint,
    rootBindingSha256: sha,
    catalogueSha256: sha,
    ownerEpoch: sha,
    command,
    cwd,
    timeoutMs,
    preparedFingerprint: fingerprint,
    preparedSha256: knowledgeHash(prepared),
  }) as OwnedCommandJobSource;
  const jobId = ownedCommandJobId({ runId, toolCallId: "tool" });
  native.write("session", () =>
    native.appendEvent(
      "session",
      "command.job.source_admitted",
      { jobId, source: pin as unknown as JsonObject, workspaceRoot: root },
      { runId, turnId: "turn", attemptId: "attempt" },
    ),
  );
  const record = validateOwnedCommandJob(
    signJobData({
      version: 1,
      jobId,
      revision: 1,
      source: pin,
      state: "starting",
      groupPid: null,
      completion: null,
      errorCode: null,
      createdAt: at,
      updatedAt: at,
    }),
  );
  const write = (
    sessionId: string,
    kind: string,
    expected: number,
    value: JsonObject,
  ) => store.putSessionDocument(sessionId, kind, expected, value);
  const put = (r: OwnedCommandJobRecord) => {
    if (
      r.groupPid !== null &&
      !db
        .prepare(
          "SELECT seq FROM session_events WHERE type='command.job.process_admitted'",
        )
        .get()
    )
      native.write("session", () =>
        native.appendEvent(
          "session",
          "command.job.process_admitted",
          { jobId, sourceSha256: pin.sha256, groupPid: r.groupPid },
          { runId, turnId: "turn", attemptId: "attempt" },
        ),
      );
    return write(
      "session",
      ownedCommandJobKind(jobId),
      r.revision - 1,
      r as unknown as JsonObject,
    );
  };
  put(record);
  const checkpoint: Checkpoint = {
    id: "checkpoint",
    runId,
    toolCallId: "tool",
    kind: "command",
    createdAt: at,
    files: [],
    warnings: [],
    incomplete: false,
  };
  const artifact = (path: string) => ({
    version: 1 as const,
    path,
    sha256: sha,
    device: "1",
    inode: path.endsWith("stdout") ? "2" : "3",
    size: 0,
    mtimeNs: "1",
    observedBytes: 0,
    artifactBytes: 0,
    truncated: false,
  });
  const completion: OwnedCommandCompletion = {
    outcome: {
      exitCode: 0,
      signal: null,
      cancelled: false,
      timedOut: false,
      cleanupConfirmed: true,
      started: true,
    },
    stdout: artifact(root + "/stdout"),
    stderr: artifact(root + "/stderr"),
    checkpoint: {
      id: checkpoint.id,
      runId,
      toolCallId: "tool",
      kind: "command",
      createdAt: at,
      incomplete: false,
      sha256: knowledgeHash(checkpoint),
    },
  };
  const part: Extract<MessagePart, { type: "tool" }> = {
    schemaVersion: 2,
    id: "part",
    sessionId: "session",
    runId,
    turnId: "turn",
    messageId: "assistant",
    index: 0,
    revision: 0,
    state: "open",
    createdAt: at,
    type: "tool",
    toolCallId: "tool",
    providerCallId: "provider-tool",
    name: "run_command",
    input: prepared.input,
  };
  store.putPart(part);
  function closed(interrupted = false) {
    if (interrupted)
      Object.assign(completion.outcome, { exitCode: null, cancelled: true });
    store.commit(
      runId,
      "workspace.changed",
      { toolCallId: "tool", checkpointId: checkpoint.id },
      { checkpoint },
    );
    native.write("session", () =>
      native.appendEvent(
        "session",
        "command.job.closed_observed",
        {
          jobId,
          sourceSha256: pin.sha256,
          completionSha256: knowledgeHash(completion),
        },
        { runId, turnId: "turn", attemptId: "attempt" },
      ),
    );
    tool.state = interrupted ? "interrupted" : "completed";
    if (interrupted) tool.error = "Run was cancelled";
    else tool.output = "Command completed";
    store.commit(
      runId,
      interrupted ? "tool.interrupted" : "tool.completed",
      {
        toolCallId: "tool",
        providerToolCallId: "provider-tool",
        name: "run_command",
        ...(interrupted
          ? { state: tool.state, error: tool.error! }
          : {
              output: tool.output!,
              cleanupConfirmed: true,
              artifacts: [
                { path: completion.stdout.path, bytes: 0, truncated: false },
                { path: completion.stderr.path, bytes: 0, truncated: false },
              ],
            }),
      },
      { tool },
    );
  }
  function terminalPart(interrupted = false) {
    store.putPart({
      ...part,
      revision: 1,
      state: interrupted ? "interrupted" : "completed",
      completedAt: at,
      ...(interrupted
        ? {}
        : {
            result: { output: tool.output!, isError: false, truncated: false },
          }),
    });
  }
  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  return {
    store,
    db,
    native,
    record,
    pin,
    completion,
    put,
    closed,
    terminalPart,
    write,
    tx,
    at,
    jobId,
  };
}

export function windowsOwnedDeliverySqlFixture(t: TestContext) {
  const f = windowsRecordFixture(t, "win32");
  f.closed(true);
  f.terminalPart(true);
  const settled = validateOwnedCommandJob(
    signJobData({
      ...f.record,
      revision: 2,
      state: "cancelled",
      groupPid: 1234,
      completion: f.completion,
    }),
  );
  f.put(settled);
  f.store.commit(
    f.pin.runId,
    "run.cancelling",
    {},
    { run: { state: "cancelling" } },
  );
  f.store.commit(
    f.pin.runId,
    "run.cancelled",
    {},
    { run: { state: "cancelled" } },
  );
  f.store.setSessionPaused("session", true, "user");
  const config = normalizeSubmitInput({
    sessionId: "session",
    requestId: "target",
    prompt: "DATA",
    config: {
      providerId: "fixture",
      modelId: "fixture",
      mode: "build",
      limits: { ...DEFAULT_LIMITS },
      budgets: { ...DEFAULT_ENGINE_BUDGETS },
    },
  }).config as RunConfig & { budgets: NonNullable<RunConfig["budgets"]> };
  const target = {
    workspaceId: "workspace",
    sessionId: "session",
    workspaceBindingSha256: "a".repeat(64),
    capabilitiesSha256: "a".repeat(64),
    catalogueSha256: "a".repeat(64),
    profile: null,
    config,
    runConfigSha256: knowledgeHash(config),
    tools: [],
    delivery: "queue" as const,
    allocation: {
      maxTurns: config.limits.maxTurns,
      maxToolCalls: config.limits.maxToolCalls,
      maxOutputBytes: config.limits.maxOutputBytes,
      maxDurationMs: config.limits.maxDurationMs,
    },
  };
  const proof = validateOwnedCommandDeliveryTargetProof(
    signJobData({
      version: 1,
      workspaceId: "workspace",
      jobId: f.jobId,
      jobSha256: settled.sha256,
      sourceSha256: f.pin.sha256,
      settled,
      target,
    }),
  );
  const original = Object.freeze({ sqlFixture: true }),
    accepted = new WeakMap<object, JobAcceptedInputProof>();
  let wakes = 0,
    accepts = 0;
  const ports: OwnedCommandDeliveryPorts = {
    readTargetOriginal(handle) {
      assert.equal(handle, original);
      return proof;
    },
    assertTarget(handle, expected) {
      assert.equal(handle, original);
      assert.deepEqual(expected, proof);
    },
    acceptAtomic(handle, request) {
      assert.equal(handle, original);
      accepts++;
      const input = normalizeAcceptInput({
        sessionId: "session",
        requestId: request.inputRequestId,
        prompt: request.prompt,
        config,
        delivery: "queue",
      });
      const receipt = f.store.acceptInput(input),
        stored = f.store.getInput(receipt.inputId),
        token = Object.freeze({});
      accepted.set(
        token,
        signJobData({
          workspaceId: "workspace",
          sessionId: "session",
          inputId: stored.id,
          requestId: stored.requestId,
          admittedSeq: stored.admittedSeq,
          inputSha256: knowledgeHash(input),
        }) as JobAcceptedInputProof,
      );
      f.store.publishAfterCommit(() => wakes++);
      return token;
    },
    readAccepted(handle) {
      assert.ok(accepted.has(handle));
      return accepted.get(handle)!;
    },
    releaseAccepted(handle) {
      accepted.delete(handle);
    },
    writeDocument: (...args) => f.store.putSessionDocument(...args),
    appendEvent: (...args) => f.native.appendEvent(...args),
  };
  const input = {
    workspaceId: "workspace",
    jobId: f.jobId,
    requestId: "windows-sql-result",
    expectedRevision: 0 as const,
    targetSha256: proof.sha256,
  };
  const transaction = <T>(operation: () => T) =>
    Reflect.apply(Reflect.get(f.store, "transaction"), f.store, [
      operation,
    ]) as T;
  const deliver = (handle = original) =>
    transaction(() =>
      deliverOwnedCommandResultAtomic(f.db, handle, input, ports),
    );
  const images = () =>
    Object.fromEntries(
      [
        "session_documents",
        "session_inputs",
        "session_events",
        "events",
        "message_parts",
        "tools",
        "approvals",
      ].map((table) => [
        table,
        f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  return {
    ...f,
    settled,
    proof,
    original,
    deliver,
    images,
    counts: () => ({ wakes, accepts }),
  };
}

/** Genuine Windows Job Object command. Only the source Run's original command is canceled through its host. */
export async function nativeWindowsOwnedDeliveryFixture(t: TestContext) {
  const f = await jobFixture(t, { createTerminal: false }),
    marker = join(f.root, "windows-owned-started.json"),
    script = join(f.root, "windows-owned-command.mjs");
  writeFileSync(
    script,
    `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));process.stdout.write('WINDOWS_OWNED_ORIGINAL\\n');setInterval(()=>{},1000);`,
  );
  const quote = (value: string) => {
    assert.ok(!/["\r\n%]/u.test(value));
    return `"${value}"`;
  };
  const command = `${quote(process.execPath)} ${quote(script)}`;
  let entries = 0;
  const provider: ProviderAdapter = {
    id: f.config.providerId,
    async *streamTurn(): AsyncIterable<ProviderEvent> {
      entries++;
      if (entries === 1) {
        yield {
          type: "tool.call",
          call: {
            id: "windows-owned-original",
            name: "run_command",
            input: { command, timeoutMs: 12000 },
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
    id: "windows-owned-delivery",
    description: "Original Windows command only",
    instructions: "Run only explicitly approved command",
    tools: ["run_command"],
  });
  const config: RunConfig = {
    ...f.config,
    agentProfileId: "windows-owned-delivery",
    mode: "build",
    limits: {
      ...f.config.limits,
      maxTurns: 2,
      maxToolCalls: 1,
      toolTimeoutMs: 12000,
    },
    budgets: { ...f.config.budgets!, turnAllowance: 2 },
  };
  const receipt = await jobCommand<RunReceipt>(f.engine, "run.submit", {
    sessionId: f.session.id,
    requestId: randomUUID(),
    prompt: "Execute actual Windows original",
    config: JSON.parse(JSON.stringify(config)),
  });
  await jobUntil(
    () =>
      f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some(
          (a) => a.runId === receipt.runId && a.status === "pending",
        ),
    "Native Windows approval absent",
  );
  const approval = f.engine.store
    .getSnapshot(f.session.id)
    .approvals.find(
      (a) => a.runId === receipt.runId && a.status === "pending",
    )!;
  assert.equal(approval.preview.platform, "win32");
  assert.equal(approval.preview.termination, "windows-job-object");
  f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
  await jobUntil(
    () =>
      existsSync(marker) &&
      f.engine
        .inspectOwnedCommandJobs(f.workspace.id)
        .some((j) => j.state === "running"),
    "Original Windows command missing native running state",
  );
  const original = f.engine.inspectOwnedCommandJobs(f.workspace.id)[0]!;
  const commandPid = Number(JSON.parse(readFileSync(marker, "utf8")).pid);
  assert.ok(Number.isSafeInteger(commandPid) && commandPid > 0);
  assert.ok(original.groupPid !== null);
  const physicalPids = [...new Set([commandPid, original.groupPid])];
  await f.engine.cancelOwnedCommandJob({
    workspaceId: f.workspace.id,
    jobId: original.jobId,
    expectedRevision: original.revision,
    requestId: randomUUID(),
  });
  await f.engine.waitForRun(receipt.runId);
  const settled = f.engine.inspectOwnedCommandJobs(f.workspace.id)[0]!;
  assert.equal(settled.state, "cancelled");
  assert.equal(settled.completion!.outcome.cleanupConfirmed, true);
  await jobUntil(
    () => activePids(physicalPids).length === 0,
    "Original Windows command remained in the native OS process listing after cancellation join",
  );
  assert.equal(entries, 1);
  const tool = f.engine.store.getToolCall(approval.toolCallId),
    event = f.engine.store
      .readEvents(f.session.id, 0, 1024)
      .find(
        (e) =>
          e.type === "tool.interrupted" && e.payload.toolCallId === tool.id,
      );
  assert.equal(tool.state, "interrupted");
  assert.ok(event);
  assert.equal(Object.hasOwn(event.payload, "cleanupConfirmed"), false);
  const part = f.engine.store
    .listParts(settled.source.turnId)
    .find((p) => p.type === "tool" && p.toolCallId === tool.id);
  assert.equal(part!.state, "interrupted");
  f.engine.store.setSessionPaused(f.session.id, true, "user");
  const target = f.engine.captureOwnedCommandJobDeliveryTarget({
    workspaceId: f.workspace.id,
    jobId: original.jobId,
    config: f.config,
  });
  return {
    ...f,
    original,
    settled,
    target,
    receipt,
    marker,
    event,
    part,
    physicalPids,
    entries: () => entries,
  };
}

/** Explicit opt-in evidence artifact directory; fixture never writes outside the requested ignored review unit. */
export function preserveOwnedDeliveryEvidence(
  name: string,
  value: unknown,
): void {
  const directory = process.env.MOODCODE_COMMANDS_EVIDENCE_DIR;
  if (!directory) return;
  const path = resolve(directory);
  assert.ok(
    path.endsWith(
      "/artifacts/next-continuation/full-review/automation-ci/fixes/jobs-commands",
    ) ||
      path.endsWith(
        "\\artifacts\\next-continuation\\full-review\\automation-ci\\fixes\\jobs-commands",
      ),
  );
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, name + ".json"),
    JSON.stringify(value, null, 2) + "\n",
  );
}
