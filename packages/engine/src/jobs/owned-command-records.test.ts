import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_LIMITS,
  EngineError,
  type Checkpoint,
  type JsonObject,
  type MessagePart,
  type ToolCallRecord,
} from "@moodcode/contracts";
import { SqliteStore } from "../storage/index.js";
import type { NativeSessionStorage } from "../storage/native.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { signJobData } from "./validation.js";
import {
  ownedCommandJobId,
  ownedCommandJobKind,
  validateOwnedCommandJob,
  validateOwnedCommandJobDatabase,
  readOwnedCommandJob,
  readOwnedCommandJobs,
  recoverInterruptedOwnedCommandJobs,
  pauseImportedOwnedCommandJobs,
  type OwnedCommandJobRecord,
  type OwnedCommandJobSource,
  type OwnedCommandCompletion,
} from "./owned-command-records.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
/** Explicit trusted SQL-shape fixture; no physical process, Original callback or execution authority is claimed. */
function fixture(t: test.TestContext, platform: string = process.platform, termination: string = platform === "win32" ? "windows-job-object" : "posix-process-group") {
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
    if (interrupted) Object.assign(completion.outcome, { exitCode: null, cancelled: true });
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
        ...(interrupted ? { state: tool.state, error: tool.error! } : {
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
      ...(interrupted ? {} : { result: { output: tool.output!, isError: false, truncated: false } }),
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

test("owned command DATA validates exact digests and compact checkpoint summaries without executing accessors", (t) => {
  const f = fixture(t);
  assert.equal(validateOwnedCommandJob(f.record).jobId, f.jobId);
  let getters = 0;
  assert.throws(() =>
    validateOwnedCommandJob({
      ...f.record,
      get source() {
        getters++;
        return f.pin;
      },
    }),
  );
  assert.equal(getters, 0);
  assert.throws(
    () =>
      validateOwnedCommandJob(signJobData({ ...f.record, state: "completed" })),
    code("OWNED_COMMAND_JOB_INVALID"),
  );
  assert.throws(
    () =>
      validateOwnedCommandJob(
        signJobData({ ...f.record, jobId: "foreign-job" }),
      ),
    code("OWNED_COMMAND_JOB_INVALID"),
  );
  assert.throws(
    () =>
      validateOwnedCommandJob(
        signJobData({
          ...f.record,
          state: "settling",
          completion: {
            ...f.completion,
            checkpoint: { ...f.completion.checkpoint, runId: "foreign" },
          },
        }),
      ),
    code("OWNED_COMMAND_JOB_INVALID"),
  );
});

test("native owned command document CAS and anchor reject generic rewritten data and foreign allowed approval", (t) => {
  const f = fixture(t);
  validateOwnedCommandJobDatabase(f.db);
  assert.equal(readOwnedCommandJobs(f.db, "workspace").length, 1);
  assert.equal(readOwnedCommandJob(f.db, "workspace", f.jobId)!.revision, 1);
  assert.throws(() => f.put(f.record), code("REVISION_CONFLICT"));
  f.db.exec("SAVEPOINT owned_probe");
  try {
    const changed = signJobData({
      ...f.record,
      state: "uncertain",
      errorCode: "forged_without_native_anchor",
    });
    f.db
      .prepare("UPDATE session_documents SET data=? WHERE kind=?")
      .run(JSON.stringify(changed), ownedCommandJobKind(f.jobId));
    assert.throws(
      () => validateOwnedCommandJobDatabase(f.db),
      code("OWNED_COMMAND_DOCUMENT_INVALID"),
    );
  } finally {
    f.db.exec("ROLLBACK TO owned_probe;RELEASE owned_probe");
  }
  f.db.exec("SAVEPOINT owned_probe");
  try {
    f.db
      .prepare(
        "UPDATE approvals SET status='denied',data=json_set(data,'$.status','denied') WHERE id='approval'",
      )
      .run();
    assert.throws(
      () => validateOwnedCommandJobDatabase(f.db),
      code("OWNED_COMMAND_SOURCE_INVALID"),
    );
  } finally {
    f.db.exec("ROLLBACK TO owned_probe;RELEASE owned_probe");
  }
  validateOwnedCommandJobDatabase(f.db);
});

test("native owned command completion needs its actual checkpoint, terminal Tool Part and matching cleanup event", (t) => {
  const f = fixture(t);
  f.closed();
  f.put(
    validateOwnedCommandJob(
      signJobData({
        ...f.record,
        revision: 2,
        state: "completed",
        groupPid: 1234,
        completion: f.completion,
      }),
    ),
  );
  assert.throws(
    () => validateOwnedCommandJobDatabase(f.db),
    code("OWNED_COMMAND_COMPLETION_INVALID"),
  );
  f.terminalPart();
  validateOwnedCommandJobDatabase(f.db);
  f.db.exec("SAVEPOINT owned_probe");
  try {
    f.db
      .prepare(
        "UPDATE checkpoints SET data=json_set(data,'$.incomplete',true) WHERE id='checkpoint'",
      )
      .run();
    assert.throws(
      () => validateOwnedCommandJobDatabase(f.db),
      code("OWNED_COMMAND_COMPLETION_INVALID"),
    );
  } finally {
    f.db.exec("ROLLBACK TO owned_probe;RELEASE owned_probe");
  }
  f.db.exec("SAVEPOINT owned_probe");
  try {
    f.db
      .prepare(
        "UPDATE events SET data=json_set(data,'$.payload.cleanupConfirmed',false) WHERE type='tool.completed'",
      )
      .run();
    assert.throws(
      () => validateOwnedCommandJobDatabase(f.db),
      code("OWNED_COMMAND_COMPLETION_INVALID"),
    );
  } finally {
    f.db.exec("ROLLBACK TO owned_probe;RELEASE owned_probe");
  }
});

test("Windows interrupted cancellation requires its exact physical close receipt and terminal native Part", (t) => {
  const f = fixture(t, "win32"), cancelled = () => validateOwnedCommandJob(signJobData({
    ...f.record, revision: 2, state: "cancelled", groupPid: 1234, completion: f.completion,
  }));
  f.closed(true);
  f.put(cancelled());
  assert.throws(() => validateOwnedCommandJobDatabase(f.db), code("OWNED_COMMAND_COMPLETION_INVALID"));
  f.terminalPart(true);
  validateOwnedCommandJobDatabase(f.db);
  for (const mutation of [
    "UPDATE events SET data=json_set(data,'$.payload.cleanupConfirmed',false) WHERE type='tool.interrupted'",
    "DELETE FROM session_events WHERE type='command.job.closed_observed'",
    "UPDATE events SET data=json_set(data,'$.payload.toolCallId','foreign') WHERE type='tool.interrupted'",
    "UPDATE message_parts SET state='open',data=json_set(data,'$.state','open') WHERE id='part'",
  ]) {
    f.db.exec("SAVEPOINT windows_cancel_probe");
    try {
      f.db.exec(mutation);
      assert.throws(() => validateOwnedCommandJobDatabase(f.db), code("OWNED_COMMAND_COMPLETION_INVALID"));
    } finally { f.db.exec("ROLLBACK TO windows_cancel_probe;RELEASE windows_cancel_probe"); }
  }
  f.db.exec("SAVEPOINT windows_cancel_probe");
  try {
    f.db.exec("UPDATE approvals SET data=json_set(data,'$.preview.platform','darwin','$.preview.termination','posix-process-group') WHERE id='approval'");
    assert.throws(() => validateOwnedCommandJobDatabase(f.db), code("OWNED_COMMAND_SOURCE_INVALID"));
  } finally { f.db.exec("ROLLBACK TO windows_cancel_probe;RELEASE windows_cancel_probe"); }
  assert.throws(() => validateOwnedCommandJob(signJobData({ ...cancelled(), completion: null })), code("OWNED_COMMAND_JOB_INVALID"));
  f.completion.outcome.cleanupConfirmed = false;
  assert.throws(cancelled, code("OWNED_COMMAND_JOB_INVALID"));
});

test("a POSIX interrupted Tool without its matching cleanup event stays unconfirmed", (t) => {
  const f = fixture(t, "darwin");
  f.closed(true);
  f.terminalPart(true);
  f.put(validateOwnedCommandJob(signJobData({
    ...f.record, revision: 2, state: "cancelled", groupPid: 1234, completion: f.completion,
  })));
  assert.throws(() => validateOwnedCommandJobDatabase(f.db), code("OWNED_COMMAND_COMPLETION_INVALID"));
});

test("restart and import use native CAS document callbacks, retain source pins and never reconstruct a runtime producer", (t) => {
  const f = fixture(t);
  f.put(
    validateOwnedCommandJob(
      signJobData({
        ...f.record,
        revision: 2,
        state: "running",
        groupPid: 1234,
      }),
    ),
  );
  assert.throws(
    () => recoverInterruptedOwnedCommandJobs(f.db, { writeDocument: f.write }),
    code("OWNED_COMMAND_TRANSACTION_REQUIRED"),
  );
  assert.equal(
    f.tx(() =>
      recoverInterruptedOwnedCommandJobs(f.db, { writeDocument: f.write }),
    ),
    1,
  );
  const recovered = readOwnedCommandJob(f.db, "workspace", f.jobId)!;
  assert.equal(recovered.state, "uncertain");
  assert.equal(recovered.groupPid, 1234);
  assert.deepEqual(recovered.source, f.record.source);
  assert.equal(
    f.tx(() =>
      recoverInterruptedOwnedCommandJobs(f.db, { writeDocument: f.write }),
    ),
    0,
  );
  assert.equal(
    f.tx(() =>
      pauseImportedOwnedCommandJobs(f.db, "workspace", "f".repeat(64), {
        writeDocument: f.write,
      }),
    ),
    1,
  );
  const paused = readOwnedCommandJob(f.db, "workspace", f.jobId)!;
  assert.equal(paused.state, "paused-import");
  assert.equal(paused.completion, null);
  assert.equal(paused.revision, 4);
  assert.equal(paused.errorCode, "COMMAND_JOB_CLEANUP_UNCERTAIN");
  assert.equal(
    f.tx(() =>
      pauseImportedOwnedCommandJobs(f.db, "workspace", "f".repeat(64), {
        writeDocument: f.write,
      }),
    ),
    0,
  );
  assert.equal(f.db.prepare("SELECT count(*) n FROM runs").get()!.n, 1);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM session_inputs").get()!.n,
    1,
  );
  validateOwnedCommandJobDatabase(f.db);
});

test("a genuine generic document CAS cannot rewrite the sealed compact completion", (t) => {
  const f = fixture(t);
  f.closed();
  f.terminalPart();
  const done = validateOwnedCommandJob(
    signJobData({
      ...f.record,
      revision: 2,
      state: "completed",
      groupPid: 1234,
      completion: f.completion,
    }),
  );
  f.put(done);
  validateOwnedCommandJobDatabase(f.db);
  const rewritten = validateOwnedCommandJob(
    signJobData({
      ...done,
      revision: 3,
      completion: {
        ...f.completion,
        stdout: { ...f.completion.stdout, sha256: "f".repeat(64) },
      },
    }),
  );
  f.put(rewritten);
  assert.throws(
    () => readOwnedCommandJob(f.db, "workspace", f.jobId),
    code("OWNED_COMMAND_COMPLETION_INVALID"),
  );
});

test("a genuine generic document CAS cannot substitute or erase the admitted process group PID", (t) => {
  const f = fixture(t);
  f.closed();
  f.terminalPart();
  const completed = validateOwnedCommandJob(
    signJobData({
      ...f.record,
      revision: 2,
      state: "completed",
      groupPid: 1234,
      completion: f.completion,
    }),
  );
  f.put(completed);
  validateOwnedCommandJobDatabase(f.db);
  for (const [index, groupPid] of [5678, null].entries()) {
    f.put(
      validateOwnedCommandJob(
        signJobData({ ...completed, revision: 3 + index, groupPid }),
      ),
    );
    assert.throws(
      () => readOwnedCommandJob(f.db, "workspace", f.jobId),
      code("OWNED_COMMAND_PROCESS_INVALID"),
    );
  }
});

test("owned command metadata caps reject oversized rows before body parsing", (t) => {
  const f = fixture(t);
  f.db.exec("SAVEPOINT owned_cap_probe");
  try {
    for (let i = 0; i < 128; i++)
      f.db
        .prepare(
          "INSERT INTO session_documents(session_id,kind,revision,data) VALUES('session',?,1,'{}')",
        )
        .run(`command.job.${i.toString(16).padStart(32, "0")}`);
    assert.throws(
      () => readOwnedCommandJobs(f.db, "workspace"),
      code("OWNED_COMMAND_JOB_LIMIT"),
    );
  } finally {
    f.db.exec("ROLLBACK TO owned_cap_probe;RELEASE owned_cap_probe");
  }
  f.db
    .prepare("UPDATE session_documents SET data=? WHERE kind=?")
    .run("x".repeat(65_537), ownedCommandJobKind(f.jobId));
  assert.throws(
    () => readOwnedCommandJobs(f.db, "workspace"),
    code("OWNED_COMMAND_DOCUMENT_INVALID"),
  );
});

test("owned source fingerprints preserve exact Windows Job Object platform approval and historical POSIX approval", t => {
  for (const platform of ["win32", "darwin", "linux", "freebsd"]) {
    const f = fixture(t, platform);
    validateOwnedCommandJobDatabase(f.db);
    const actual = readOwnedCommandJob(f.db, "workspace", f.jobId);
    assert.ok(actual);
    assert.equal(actual.source.preparedFingerprint, f.record.source.preparedFingerprint);
  }
});

test("owned source validation rejects mismatched platform and termination despite consistent source fingerprints", t => {
  for (const [platform, termination] of [["win32", "posix-process-group"], ["linux", "windows-job-object"], ["unsupported", "windows-job-object"]]) {
    const f = fixture(t, platform, termination);
    assert.throws(() => validateOwnedCommandJobDatabase(f.db), code("OWNED_COMMAND_SOURCE_INVALID"));
  }
});
