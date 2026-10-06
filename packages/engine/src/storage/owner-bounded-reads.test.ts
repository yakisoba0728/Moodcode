import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_LIMITS,
  EngineError,
  type ApprovalRecord,
  type SubmitInput,
  type ToolCallRecord,
} from "@moodcode/contracts";
import { SqliteStore } from "./index.js";
const date = "2026-10-07T00:00:00.000Z";
const config = {
  providerId: "fixture",
  modelId: "fixture",
  mode: "build" as const,
  limits: { ...DEFAULT_LIMITS },
};
const code = (value: string) => (error: unknown) =>
  error instanceof EngineError && error.code === value;
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "moodcode-bounded-owner-")),
    store = new SqliteStore(join(directory, "engine.sqlite")),
    writer = new DatabaseSync(join(directory, "engine.sqlite"));
  store.putWorkspace({
    id: "workspace",
    root: directory,
    gitRoot: directory,
    branch: null,
    createdAt: date,
  });
  for (const id of ["session", "other"])
    store.createSession({
      id,
      workspaceId: "workspace",
      title: "Owner",
      createdAt: date,
    });
  const input: SubmitInput = {
      sessionId: "session",
      requestId: "primary",
      prompt: "Goal",
      config,
    },
    receipt = store.admit(input);
  store.commit(receipt.runId, "run.started", {}, { run: { state: "running" } });
  const tool: ToolCallRecord = {
    id: "effect",
    runId: receipt.runId,
    sessionId: "session",
    name: "write_file",
    input: { path: "sample.txt", content: "planned" },
    state: "requested",
  };
  store.commit(receipt.runId, "tool.requested", {}, { tool });
  const approval = (id: string, preview = "planned"): ApprovalRecord => ({
    id,
    sessionId: "session",
    runId: receipt.runId,
    toolCallId: tool.id,
    toolName: tool.name,
    fingerprint: "exact-" + id,
    preview: { text: preview },
    status: "pending",
    createdAt: date,
  });
  const rows = () =>
    Object.fromEntries(
      [
        "inputs",
        "runs",
        "session_inputs",
        "approvals",
        "events",
        "session_events",
        "session_sequences",
      ].map((table) => [
        table,
        writer.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  t.after(() => {
    writer.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, writer, input, receipt, tool, approval, rows };
}
test("Run request presence is owner-bound and never mistakes pending or promoted steering identities for Run admission", (t) => {
  const f = fixture(t),
    queue = f.store.acceptInput({
      ...f.input,
      requestId: "queued",
      delivery: "queue",
    }),
    steer = f.store.acceptInput({
      ...f.input,
      requestId: "steered",
      delivery: "steer",
    });
  f.store.promoteSteers([steer.inputId], f.receipt.runId);
  f.store.getSnapshot = () => {
    throw new Error("Whole transcript lookup is forbidden");
  };
  const before = f.rows();
  assert.equal(f.store.hasRunRequest("session", "primary"), true);
  assert.equal(f.store.hasRunRequest("session", "queued"), false);
  assert.equal(f.store.getInput(queue.inputId).state, "pending");
  assert.equal(f.store.hasRunRequest("session", "steered"), false);
  assert.equal(f.store.hasRunRequest("other", "primary"), false);
  assert.equal(f.store.hasRunRequest("session", "absent"), false);
  assert.throws(
    () => f.store.hasRunRequest("missing", "primary"),
    code("SESSION_NOT_FOUND"),
  );
  assert.deepEqual(f.rows(), before);
  const run = f.store.getRun(f.receipt.runId);
  f.writer
    .prepare("UPDATE runs SET data=? WHERE id=?")
    .run(JSON.stringify({ ...run, requestId: "changed-payload" }), run.id);
  assert.equal(
    f.store.hasRunRequest("session", "primary"),
    false,
    "input identity alone cannot stand in for the actual Run request",
  );
});
test("pending decision projection returns all exact detached records and excludes resolved decisions without reading messages", (t) => {
  const f = fixture(t),
    first = f.approval("first"),
    resolved = {
      ...f.approval("resolved"),
      status: "allowed" as const,
      resolvedAt: date,
      source: "user" as const,
    };
  f.store.commit(
    f.receipt.runId,
    "approval.requested",
    {},
    { approval: first },
  );
  f.store.commit(
    f.receipt.runId,
    "approval.requested",
    {},
    { approval: resolved },
  );
  f.store.getSnapshot = () => {
    throw new Error("Whole transcript lookup is forbidden");
  };
  const before = f.rows();
  assert.deepEqual(f.store.listPendingRunApprovals(f.receipt.runId), [first]);
  f.store.listPendingRunApprovals(f.receipt.runId)[0]!.preview.text =
    "caller mutation";
  assert.deepEqual(f.store.listPendingRunApprovals(f.receipt.runId), [first]);
  assert.deepEqual(f.rows(), before);
  assert.throws(
    () => f.store.listPendingRunApprovals("missing"),
    code("RUN_NOT_FOUND"),
  );
});
test("pending approval count/UTF-8 size limits reject partial decisions and malformed owners fail closed", (t) => {
  const f = fixture(t);
  for (const name of ["first", "second", "third"])
    f.store.commit(
      f.receipt.runId,
      "approval.requested",
      {},
      { approval: f.approval(name) },
    );
  assert.throws(
    () => f.store.listPendingRunApprovals(f.receipt.runId, 2),
    code("APPROVAL_READ_LIMIT"),
  );
  for (const limit of [0, 65, 1.5])
    assert.throws(
      () => f.store.listPendingRunApprovals(f.receipt.runId, limit),
      code("INVALID_PAGE_SIZE"),
    );
  const first = f.approval("first");
  f.writer
    .prepare("UPDATE approvals SET data=? WHERE id=?")
    .run(JSON.stringify({ ...first, sessionId: "other" }), "first");
  assert.throws(
    () => f.store.listPendingRunApprovals(f.receipt.runId),
    code("RECORD_SCOPE_MISMATCH"),
  );
  f.writer
    .prepare("UPDATE approvals SET data=? WHERE id=?")
    .run(
      JSON.stringify({ ...first, preview: { text: "한".repeat(180_000) } }),
      "first",
    );
  assert.throws(
    () => f.store.listPendingRunApprovals(f.receipt.runId),
    code("APPROVAL_READ_LIMIT"),
  );
  f.writer
    .prepare("UPDATE approvals SET data=? WHERE id=?")
    .run(JSON.stringify(first), "first");
  f.writer
    .prepare("UPDATE tools SET session_id=? WHERE id=?")
    .run("other", f.tool.id);
  assert.throws(
    () => f.store.listPendingRunApprovals(f.receipt.runId),
    code("RECORD_SCOPE_MISMATCH"),
  );
  f.writer
    .prepare("UPDATE tools SET session_id=?,data=? WHERE id=?")
    .run(
      "session",
      JSON.stringify({ ...f.tool, sessionId: "other" }),
      f.tool.id,
    );
  assert.throws(
    () => f.store.listPendingRunApprovals(f.receipt.runId),
    code("RECORD_SCOPE_MISMATCH"),
  );
});

test("last child assistant content belongs to the exact Run and excludes opaque replay, tool output and later Runs", (t) => {
  const f = fixture(t),
    message = {
      id: "first-answer",
      sessionId: "session",
      runId: f.receipt.runId,
      role: "assistant" as const,
      content: "Exact last answer 한글😀",
      createdAt: date,
      providerReplay: {
        providerId: "fixture",
        items: [
          {
            type: "reasoning",
            encrypted_content: "unread replay ".repeat(100_000),
          },
        ],
      },
    };
  f.store.getSnapshot = () => {
    throw new Error("Whole transcript lookup is forbidden");
  };
  assert.equal(f.store.getLastRunAssistantContent(f.receipt.runId), "");
  f.store.commit(f.receipt.runId, "message.completed", {}, { message });
  f.store.commit(
    f.receipt.runId,
    "message.completed",
    {},
    {
      message: {
        id: "later-tool",
        sessionId: "session",
        runId: f.receipt.runId,
        role: "tool",
        content: "Exclude tool output",
        toolCallId: "unused",
        createdAt: date,
      },
    },
  );
  assert.equal(
    f.store.getLastRunAssistantContent(f.receipt.runId),
    message.content,
  );
  f.store.commit(
    f.receipt.runId,
    "run.completed",
    {},
    { run: { state: "completed" } },
  );
  const second = f.store.admit({ ...f.input, requestId: "later-run" });
  f.store.commit(
    second.runId,
    "message.completed",
    {},
    {
      message: {
        id: "newer-answer",
        sessionId: "session",
        runId: second.runId,
        role: "assistant",
        content: "Other Run",
        createdAt: date,
      },
    },
  );
  const before = f.rows();
  assert.equal(
    f.store.getLastRunAssistantContent(f.receipt.runId),
    message.content,
  );
  assert.equal(f.store.getLastRunAssistantContent(second.runId), "Other Run");
  assert.deepEqual(f.rows(), before);
});

test("child content projection enforces UTF-8 bytes and detached payload ownership before returning output", (t) => {
  const f = fixture(t),
    run = f.store.getRun(f.receipt.runId),
    content = "한".repeat(21_845) + "x",
    message = {
      id: "bounded-answer",
      sessionId: "session",
      runId: run.id,
      role: "assistant" as const,
      content,
      createdAt: date,
    };
  assert.equal(Buffer.byteLength(content), config.limits.maxOutputBytes);
  f.store.commit(run.id, "message.completed", {}, { message });
  assert.equal(f.store.getLastRunAssistantContent(run.id), content);
  f.writer
    .prepare("UPDATE messages SET data=? WHERE id=?")
    .run(JSON.stringify({ ...message, content: content + "한" }), message.id);
  assert.throws(
    () => f.store.getLastRunAssistantContent(run.id),
    code("CHILD_OUTPUT_READ_LIMIT"),
  );
  f.writer
    .prepare("UPDATE messages SET data=? WHERE id=?")
    .run(JSON.stringify({ ...message, sessionId: "other" }), message.id);
  assert.throws(
    () => f.store.getLastRunAssistantContent(run.id),
    code("RECORD_SCOPE_MISMATCH"),
  );
});
