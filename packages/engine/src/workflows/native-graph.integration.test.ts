import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { validateWorkflowDatabase } from "./store.js";
import { workflowFixture } from "./fixtures/workflow.js";

function invalid(error: unknown): boolean {
  return (
    error instanceof EngineError && error.code === "WORKFLOW_DATABASE_INVALID"
  );
}

test("an extra native head cannot borrow a different workflow revision even with valid foreign keys", async (t) => {
  const f = await workflowFixture(t),
    spec = await f.spec();
  const registered = f.engine.registerWorkflow({
    workspaceId: f.workspace.id,
    requestId: "register-head-alias",
    expectedRevision: 0,
    spec,
  });
  const db = new DatabaseSync(f.dbPath);
  try {
    validateWorkflowDatabase(db);
    db.prepare(
      "INSERT INTO workflow_heads(workspace_id,kind,entity_id,revision_id,revision,sha256) VALUES(?,'spec',?,?,?,?)",
    ).run(
      f.workspace.id,
      "borrowed-workflow",
      registered.record.id,
      registered.record.revision,
      registered.record.sha256,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => validateWorkflowDatabase(db), invalid);
  } finally {
    db.prepare(
      "DELETE FROM workflow_heads WHERE entity_id='borrowed-workflow'",
    ).run();
    db.close();
  }
});

test("a native head cannot rewind to an older valid revision while preserving every historical row", async (t) => {
  const f = await workflowFixture(t),
    spec = await f.spec();
  const first = f.engine.registerWorkflow({
    workspaceId: f.workspace.id,
    requestId: "register-first-head",
    expectedRevision: 0,
    spec,
  });
  const second = f.engine.registerWorkflow({
    workspaceId: f.workspace.id,
    requestId: "register-second-head",
    expectedRevision: 1,
    spec: { ...spec, description: "A newer immutable workflow definition." },
  });
  const db = new DatabaseSync(f.dbPath);
  try {
    validateWorkflowDatabase(db);
    db.prepare(
      "UPDATE workflow_heads SET revision_id=?,revision=?,sha256=? WHERE workspace_id=? AND kind='spec' AND entity_id=?",
    ).run(
      first.record.id,
      first.record.revision,
      first.record.sha256,
      f.workspace.id,
      spec.id,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => validateWorkflowDatabase(db), invalid);
  } finally {
    db.prepare(
      "UPDATE workflow_heads SET revision_id=?,revision=?,sha256=? WHERE workspace_id=? AND kind='spec' AND entity_id=?",
    ).run(
      second.record.id,
      second.record.revision,
      second.record.sha256,
      f.workspace.id,
      spec.id,
    );
    db.close();
  }
});

test(
  "actual child completion before the workflow admission receipt retains its original historical proof",
  { timeout: 15000 },
  async (t) => {
    const f = await workflowFixture(t),
      spec = await f.spec(),
      parent = await f.startParent();
    f.engine.registerWorkflow({
      workspaceId: f.workspace.id,
      requestId: "register-fast-child",
      expectedRevision: 0,
      spec,
    });
    const preview = await f.engine.previewWorkflowStart({
      workspaceId: f.workspace.id,
      rootSessionId: f.session.id,
      parentRunId: parent.runId,
      workflowId: spec.id,
      expectedSpecRevision: 1,
      parameters: { question: "Observe actual early child completion." },
      stageWorktrees: f.stageWorktrees(spec),
    });
    const created = f.engine.startWorkflow({
      workspaceId: f.workspace.id,
      requestId: "start-fast-child",
      approved: true,
      preview,
    });
    const actualStart = f.engine.children.start.bind(f.engine.children);
    t.mock.method(
      f.engine.children,
      "start",
      async (
        request: Parameters<typeof actualStart>[0],
        signal?: AbortSignal,
      ) => {
        const originalStarting = await actualStart(request, signal);
        await f.engine.children.tasks.wait(
          request.sessionId,
          originalStarting.id,
        );
        return originalStarting;
      },
    );
    const pending = f.engine.startWorkflowStage({
      workspaceId: f.workspace.id,
      instanceId: created.record.instanceId,
      stageId: "plan",
      requestId: "dispatch-fast-child",
      expectedRevision: created.record.revision,
      approved: true,
    });
    const child = await f.waitChild();
    child.release.resolve();
    const admitted = await pending;
    assert.equal(
      f.engine.children.tasks.get(f.session.id, child.task.id).state,
      "completed",
    );
    assert.equal(admitted.record.stages[0]!.state, "running");
    assert.equal(admitted.record.stages[0]!.child!.taskId, child.task.id);
    const settled = await f.engine.observeWorkflowStage({
      workspaceId: f.workspace.id,
      instanceId: admitted.record.instanceId,
      stageId: "plan",
      requestId: "observe-fast-child",
      expectedRevision: admitted.record.revision,
    });
    assert.equal(settled.record.state, "completed");
    assert.deepEqual(settled.record.result, {
      observation: "Actual readonly child 0 completed.",
    });
    const db = new DatabaseSync(f.dbPath, { readOnly: true });
    try {
      validateWorkflowDatabase(db);
    } finally {
      db.close();
    }
  },
);
