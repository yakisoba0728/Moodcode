import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import type { JsonObject } from "@moodcode/contracts";
import type { ChildTaskRecord } from "../child-tasks/index.js";
import {
  childStorageKind,
  type ChildStorageRecord,
} from "../child-tasks/storage-binding.js";
import * as nativeWorkflow from "./store.js";
import type { WorkflowInstanceRevision } from "./reducer.js";
import type { WorkflowRequestResult, WorkflowSpecRevision } from "./store.js";
import {
  definition,
  invoke,
  readDatabase,
  workflowArchiveFixture,
} from "./fixtures/archive-workflow.js";

function revisions(dbPath: string) {
  return readDatabase(dbPath, (db) =>
    db.prepare("SELECT * FROM workflow_revisions ORDER BY id").all(),
  );
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                "Original host observation did not settle after cancellation",
              ),
            ),
          600,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  "host observation abort settles while original child keeps running and a later explicit observation consumes its real completion",
  { timeout: 15000 },
  async (t) => {
    const f = await workflowArchiveFixture(t),
      started = await f.start(),
      admitted = await f.stage(started.created.record),
      before = revisions(f.dbPath),
      controller = new AbortController();
    const operation = invoke<
      Promise<WorkflowRequestResult<WorkflowInstanceRevision>>
    >(f.engine, "observeWorkflowStage", {
      workspaceId: f.workspace.id,
      instanceId: admitted.record.instanceId,
      stageId: "plan",
      requestId: "workflow-aborted-observation",
      expectedRevision: admitted.record.revision,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(
      bounded(operation),
      (error) => error instanceof EngineError && error.code === "CANCELLED",
    );
    assert.deepEqual(revisions(f.dbPath), before);
    assert.equal(
      f.engine.children.tasks.get(
        f.session.id,
        admitted.record.stages[0]!.child!.taskId,
      ).state,
      "running",
    );
    assert.equal(f.inspect(admitted.record.instanceId).state, "running");
    const completed = await f.settle(admitted.record);
    assert.equal(completed.record.state, "completed");
    assert.deepEqual(completed.record.result, {
      observation: "Read-only original child observation.",
    });
    assert.equal(completed.receipt.operation, "settle");
  },
);

test(
  "original readonly child cancellation settles from confirmed native close after its parent Run ends",
  { timeout: 15000 },
  async (t) => {
    const f = await workflowArchiveFixture(t),
      started = await f.start(),
      admitted = await f.stage(started.created.record);
    const reply = await f.engine.dispatch({
      schemaVersion: 1,
      commandId: randomUUID(),
      type: "run.cancel",
      payload: { runId: started.parent.runId },
    });
    assert.equal(reply.ok, true, JSON.stringify(reply.error));
    assert.equal(
      (await f.engine.waitForRun(started.parent.runId)).state,
      "cancelled",
    );
    const task = await f.engine.children.tasks.wait(
      f.session.id,
      admitted.record.stages[0]!.child!.taskId,
    );
    assert.equal(task.state, "cancelled");
    const settled = await invoke<
      Promise<WorkflowRequestResult<WorkflowInstanceRevision>>
    >(f.engine, "observeWorkflowStage", {
      workspaceId: f.workspace.id,
      instanceId: admitted.record.instanceId,
      stageId: "plan",
      requestId: "workflow-cancelled-observe",
      expectedRevision: admitted.record.revision,
    });
    assert.equal(settled.record.state, "cancelled");
    assert.equal(settled.record.stages[0]!.state, "cancelled");
    assert.equal(settled.record.result, null);
    assert.equal(settled.record.stages[0]!.result, null);
    assert.equal(settled.receipt.operation, "settle");
  },
);

test(
  "original Root Run configuration drift before workflow preview creates no instance or child execution",
  { timeout: 15000 },
  async (t) => {
    const f = await workflowArchiveFixture(t);
    const registered = invoke<WorkflowRequestResult<WorkflowSpecRevision>>(
      f.engine,
      "registerWorkflow",
      {
        workspaceId: f.workspace.id,
        requestId: "workflow-drift-register",
        expectedRevision: 0,
        spec: definition(f.configuration.providers![0]!.id),
      },
    );
    const reply = await f.engine.dispatch({
      schemaVersion: 1,
      commandId: randomUUID(),
      type: "run.submit",
      payload: {
        sessionId: f.session.id,
        requestId: "workflow-drift-parent",
        prompt: "Actual drift parent",
      },
    });
    assert.equal(reply.ok, true, JSON.stringify(reply.error));
    const parent = reply.result as unknown as { runId: string };
    await f.parentEntered.promise;
    const before = revisions(f.dbPath),
      entries = f.providerEntries(),
      original = f.engine.store.getRun(parent.runId),
      database = new DatabaseSync(f.dbPath);
    try {
      database.prepare("UPDATE runs SET data=? WHERE id=?").run(
        JSON.stringify({
          ...original,
          config: { ...original.config, modelId: "fixture-drift" },
        }),
        original.id,
      );
      await assert.rejects(
        async () =>
          invoke<Promise<object>>(f.engine, "previewWorkflowStart", {
            workspaceId: f.workspace.id,
            rootSessionId: f.session.id,
            parentRunId: parent.runId,
            workflowId: registered.record.workflowId,
            expectedSpecRevision: registered.record.revision,
            parameters: { question: "Observe exact original config." },
            stageWorktrees: { plan: f.worktree.id },
          }),
        (error) => error instanceof EngineError,
      );
      assert.deepEqual(revisions(f.dbPath), before);
      assert.equal(f.engine.children.tasks.list(f.session.id).length, 0);
      assert.equal(f.providerEntries(), entries);
      assert.equal(
        f.engine.children.worktrees.get(f.session.id, f.worktree.id).ownerId,
        undefined,
      );
    } finally {
      database
        .prepare("UPDATE runs SET data=? WHERE id=?")
        .run(JSON.stringify(original), original.id);
      database.close();
    }
  },
);

test(
  "closed original child completion cannot commit a workflow receipt after its native task outcome changes",
  { timeout: 15000 },
  async (t) => {
    const f = await workflowArchiveFixture(t),
      started = await f.start(),
      admitted = await f.stage(started.created.record),
      before = revisions(f.dbPath);
    const storageClass: unknown = Reflect.get(
      nativeWorkflow,
      "WorkflowStorage",
    );
    assert.equal(typeof storageClass, "function");
    const prototype = Reflect.get(
        storageClass as object,
        "prototype",
      ) as object,
      original: unknown = Reflect.get(prototype, "settleStage");
    assert.equal(typeof original, "function");
    let altered = false,
      restoreData: JsonObject | undefined;
    Reflect.set(
      prototype,
      "settleStage",
      function (this: object, ...args: unknown[]) {
        const taskId = admitted.record.stages[0]!.child!.taskId,
          task = f.engine.children.tasks.get(f.session.id, taskId);
        assert.equal(task.state, "completed");
        assert.ok(task.outcome);
        const storage = f.engine.store.getSessionDocument(
          f.session.id,
          childStorageKind(task.id),
        )!.data as unknown as ChildStorageRecord;
        assert.equal(storage.confirmedClose?.bindingSha256, storage.sha256);
        const document = f.engine.store.getSessionDocument(
          f.session.id,
          "engine.child_tasks",
        )!;
        restoreData = structuredClone(document.data);
        const changed = structuredClone(document.data),
          tasks = changed.tasks as unknown as ChildTaskRecord[],
          nativeTask = tasks.find((value) => value.id === task.id)!;
        assert.ok(nativeTask.outcome);
        nativeTask.outcome.content = JSON.stringify({
          observation:
            "Different native outcome after original completion observation.",
        });
        f.engine.store.putSessionDocument(
          f.session.id,
          "engine.child_tasks",
          document.revision,
          changed,
        );
        altered = true;
        return Reflect.apply(
          original as (...values: unknown[]) => unknown,
          this,
          args,
        );
      },
    );
    try {
      f.childRelease.resolve();
      await assert.rejects(
        invoke<Promise<unknown>>(f.engine, "observeWorkflowStage", {
          workspaceId: f.workspace.id,
          instanceId: admitted.record.instanceId,
          stageId: "plan",
          requestId: "workflow-outcome-drift",
          expectedRevision: admitted.record.revision,
        }),
        (error) =>
          error instanceof EngineError && error.code === "WORKFLOW_CHILD_STALE",
      );
      assert.equal(altered, true);
      assert.deepEqual(revisions(f.dbPath), before);
      assert.equal(f.inspect(admitted.record.instanceId).state, "running");
    } finally {
      Reflect.set(prototype, "settleStage", original);
      if (restoreData) {
        const document = f.engine.store.getSessionDocument(
          f.session.id,
          "engine.child_tasks",
        )!;
        f.engine.store.putSessionDocument(
          f.session.id,
          "engine.child_tasks",
          document.revision,
          restoreData,
        );
      }
    }
    const completed = await f.settle(admitted.record);
    assert.equal(completed.record.state, "completed");
    assert.deepEqual(completed.record.result, {
      observation: "Read-only original child observation.",
    });
  },
);
