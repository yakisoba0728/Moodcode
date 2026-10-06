import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_LIMITS,
  EngineError,
  type ApprovalRecord,
  type ToolCallRecord,
} from "@moodcode/contracts";
import { SqliteStore } from "./index.js";

const date = "2026-10-07T00:00:00.000Z";
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "moodcode-tool-owner-")),
    store = new SqliteStore(join(directory, "engine.sqlite"));
  store.putWorkspace({
    id: "workspace",
    root: directory,
    gitRoot: directory,
    branch: null,
    createdAt: date,
  });
  store.createSession({
    id: "session",
    workspaceId: "workspace",
    title: "Owner",
    createdAt: date,
  });
  const receipt = store.admit({
    sessionId: "session",
    requestId: "owner",
    prompt: "Owner",
    config: {
      providerId: "fixture",
      modelId: "fixture",
      mode: "build",
      limits: { ...DEFAULT_LIMITS },
    },
  });
  store.commit(receipt.runId, "run.started", {}, { run: { state: "running" } });
  const tool: ToolCallRecord = {
    id: "delegate",
    runId: receipt.runId,
    sessionId: "session",
    name: "delegate_task",
    input: { prompt: "Child" },
    state: "requested",
  };
  store.commit(receipt.runId, "tool.requested", {}, { tool });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, tool };
}
test("single tool and approval reads preserve exact detached authority without loading a transcript", (t) => {
  const f = fixture(t);
  f.store.getSnapshot = () => {
    throw new Error("Unbounded authority lookup is forbidden");
  };
  const approval: ApprovalRecord = {
    id: "approval",
    sessionId: "session",
    runId: f.tool.runId,
    toolCallId: f.tool.id,
    toolName: f.tool.name,
    fingerprint: "exact",
    preview: { delegationFingerprint: "bound", nested: { prompt: "Child" } },
    status: "pending",
    createdAt: date,
  };
  f.store.commit(f.tool.runId, "approval.requested", {}, { approval });
  assert.deepEqual(f.store.getToolCall(f.tool.id), f.tool);
  assert.deepEqual(f.store.listToolApprovals(f.tool.id), [approval]);
  f.store.listToolApprovals(f.tool.id)[0]!.preview.nested = "caller mutation";
  assert.deepEqual(f.store.listToolApprovals(f.tool.id), [approval]);
  assert.throws(
    () => f.store.getToolCall("missing"),
    (error) => error instanceof EngineError && error.code === "TOOL_NOT_FOUND",
  );
});
test("approval authority reads reject count and UTF-8 byte excess before copying previews", (t) => {
  const f = fixture(t);
  for (let index = 0; index < 9; index++)
    f.store.commit(
      f.tool.runId,
      "approval.requested",
      {},
      {
        approval: {
          id: `approval-${index}`,
          sessionId: "session",
          runId: f.tool.runId,
          toolCallId: f.tool.id,
          toolName: f.tool.name,
          fingerprint: "exact",
          preview: { text: "observed" },
          status: "pending",
          createdAt: date,
        },
      },
    );
  assert.throws(
    () => f.store.listToolApprovals(f.tool.id),
    (error) =>
      error instanceof EngineError && error.code === "TOOL_APPROVAL_LIMIT",
  );
  const second: ToolCallRecord = { ...f.tool, id: "large-preview" };
  f.store.commit(f.tool.runId, "tool.requested", {}, { tool: second });
  f.store.commit(
    f.tool.runId,
    "approval.requested",
    {},
    {
      approval: {
        id: "large-approval",
        sessionId: "session",
        runId: f.tool.runId,
        toolCallId: second.id,
        toolName: second.name,
        fingerprint: "large-exact",
        preview: { text: "한".repeat(12_000) },
        status: "pending",
        createdAt: date,
      },
    },
  );
  assert.throws(
    () => f.store.listToolApprovals(second.id),
    (error) =>
      error instanceof EngineError && error.code === "TOOL_APPROVAL_LIMIT",
  );
});
