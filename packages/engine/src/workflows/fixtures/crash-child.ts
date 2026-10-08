import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import type { JsonObject } from "@moodcode/contracts";
import { createEngine, type EngineOptions } from "../../engine.js";
import type { ProviderAdapter, ProviderEvent } from "../../ports.js";
import {
  CHILD_STORAGE_MIRROR_KIND,
  childStorageKind,
  type ChildStorageRecord,
} from "../../child-tasks/storage-binding.js";
import * as nativeWorkflow from "../store.js";
import type { WorkflowInstanceRevision } from "../reducer.js";
import type { WorkflowRequestResult, WorkflowSpecRevision } from "../store.js";
import { definition, gate, invoke, readDatabase } from "./archive-workflow.js";

const [
  rawDbPath,
  rawArtifactDir,
  rawWorkspaceId,
  rawSessionId,
  rawWorktreeId,
  rawBoundary,
  rawReadyPath,
] = process.argv.slice(2);
assert.ok(
  rawDbPath &&
    rawArtifactDir &&
    rawWorkspaceId &&
    rawSessionId &&
    rawWorktreeId &&
    rawBoundary &&
    rawReadyPath,
);
const dbPath: string = rawDbPath,
  artifactDir: string = rawArtifactDir,
  workspaceId: string = rawWorkspaceId,
  sessionId: string = rawSessionId,
  worktreeId: string = rawWorktreeId,
  boundary: string = rawBoundary,
  readyPath: string = rawReadyPath;
assert.ok(
  [
    "dispatch-intent",
    "child-admitted",
    "child-completed",
    "stage-settled",
  ].includes(boundary),
);
const parentEntered = gate(),
  heldParent = gate(),
  heldChild = gate();
const childEngines: ReturnType<typeof createEngine>[] = [];
let providerEntries = 0;
async function wait(promise: Promise<void>, signal: AbortSignal) {
  let listener!: () => void;
  try {
    await Promise.race([
      promise,
      new Promise<void>((done) => {
        listener = done;
        signal.addEventListener("abort", listener, { once: true });
        if (signal.aborted) done();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}
const provider: ProviderAdapter = {
  id: "actual-workflow-provider",
  streamTurn(request, signal) {
    providerEntries++;
    const child = request.messages.some(
      (message) =>
        message.role === "user" &&
        message.content.startsWith("[Moodcode workflow stage v1]"),
    );
    const original = (async function* (): AsyncGenerator<ProviderEvent> {
      if (child && request.turnIndex === 0) {
        yield {
          type: "tool.call",
          call: {
            id: "workflow-crash-original-read",
            name: "read_file",
            input: { path: "seed.txt" },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      yield { type: "progress" };
      if (!child) parentEntered.resolve();
      await wait(child ? heldChild.promise : heldParent.promise, signal);
      if (!signal.aborted) {
        if (child)
          yield {
            type: "text.delta",
            delta: JSON.stringify({
              observation: "Actual readonly crash child completed.",
            }),
          };
        yield { type: "finish", reason: "stop" };
      }
    })();
    return {
      [Symbol.asyncIterator]() {
        return {
          next: (value?: unknown) => original.next(value),
          return: (value?: unknown) => original.return(value as never),
        };
      },
    };
  },
};
const engine = createEngine({
  dbPath,
  artifactDir,
  workflows: true,
  providers: [provider],
  configureChild(child) {
    childEngines.push(child);
  },
  defaults: {
    providerId: provider.id,
    modelId: "fixture",
    mode: "build",
    limits: {
      maxTurns: 12,
      maxToolCalls: 12,
      maxDurationMs: 30000,
      maxOutputBytes: 65536,
    },
  },
} as EngineOptions);
async function command<T>(type: string, payload: JsonObject): Promise<T> {
  const reply = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type,
    payload,
  });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.result as unknown as T;
}
const registration = invoke<WorkflowRequestResult<WorkflowSpecRevision>>(
  engine,
  "registerWorkflow",
  {
    workspaceId,
    requestId: "workflow-crash-register",
    expectedRevision: 0,
    spec: definition(provider.id),
  },
);
const parent = await command<{ runId: string }>("run.submit", {
  sessionId,
  requestId: "workflow-crash-parent",
  prompt: "Actual original workflow crash parent",
});
await parentEntered.promise;
const preview = await invoke<Promise<object>>(engine, "previewWorkflowStart", {
  workspaceId,
  rootSessionId: sessionId,
  parentRunId: parent.runId,
  workflowId: registration.record.workflowId,
  expectedSpecRevision: registration.record.revision,
  parameters: { question: "Observe original committed files." },
  stageWorktrees: { plan: worktreeId },
});
const created = invoke<WorkflowRequestResult<WorkflowInstanceRevision>>(
  engine,
  "startWorkflow",
  { workspaceId, requestId: "workflow-crash-start", approved: true, preview },
);

/** Observers forward every original native operation; no owner or child receipt is fabricated. */
function freeze() {
  const instance = invoke<WorkflowInstanceRevision>(
    engine,
    "inspectWorkflow",
    workspaceId,
    created.record.instanceId,
  );
  assert.ok(instance);
  const tasks = engine.children.tasks.list(sessionId);
  assert.ok(tasks.length <= 1);
  const task = tasks[0] ?? null;
  const childStorage = task
    ? (engine.store.getSessionDocument(sessionId, childStorageKind(task.id))!
        .data as unknown as ChildStorageRecord)
    : null;
  if (childStorage) {
    assert.equal(childStorage.binding.phase, "admitted");
    assert.equal(childStorage.binding.child.runId, task!.childRunId);
    assert.ok(childEngines.length === 1);
  }
  const childRun = childStorage
    ? readDatabase(childStorage.binding.physical.database.path, (db) =>
        db.prepare("SELECT * FROM runs WHERE id=?").get(task!.childRunId!),
      )
    : null;
  const childTools = childStorage
    ? readDatabase(childStorage.binding.physical.database.path, (db) =>
        db.prepare("SELECT * FROM tools ORDER BY ordinal").all(),
      )
    : [];
  const childMirror = childStorage
    ? readDatabase(childStorage.binding.physical.database.path, (db) =>
        JSON.parse(
          String(
            db
              .prepare(
                "SELECT data FROM session_documents WHERE session_id=? AND kind=?",
              )
              .get(
                childStorage.binding.child.sessionId,
                CHILD_STORAGE_MIRROR_KIND,
              )!.data,
          ),
        ),
      )
    : null;
  const revisions = readDatabase(dbPath, (db) =>
    db.prepare("SELECT * FROM workflow_revisions ORDER BY id").all(),
  );
  const proof = {
    boundary,
    pid: process.pid,
    instance,
    parent,
    task,
    childStorage,
    childRun,
    childTools,
    childMirror,
    revisions,
    providerEntries,
  };
  writeFileSync(readyPath + ".tmp", JSON.stringify(proof));
  renameSync(readyPath + ".tmp", readyPath);
  process.kill(process.pid, "SIGSTOP");
  throw Error("Parent must SIGKILL this original stopped process");
}
const storageClass: unknown = Reflect.get(nativeWorkflow, "WorkflowStorage");
assert.equal(
  typeof storageClass,
  "function",
  "Actual native WorkflowStorage export is required",
);
const prototype = Reflect.get(storageClass as object, "prototype") as object;
for (const name of ["prepareStage", "admitStage", "settleStage"] as const) {
  const original: unknown = Reflect.get(prototype, name);
  assert.equal(
    typeof original,
    "function",
    `Actual native ${name} is required`,
  );
  Reflect.set(prototype, name, function (this: object, ...args: unknown[]) {
    if (name === "admitStage" && boundary === "child-admitted") freeze();
    if (name === "settleStage" && boundary === "child-completed") freeze();
    const result = Reflect.apply(
      original as (...values: unknown[]) => unknown,
      this,
      args,
    );
    if (name === "prepareStage" && boundary === "dispatch-intent") freeze();
    if (name === "settleStage" && boundary === "stage-settled") freeze();
    return result;
  });
}
const admitted = await invoke<
  Promise<WorkflowRequestResult<WorkflowInstanceRevision>>
>(engine, "startWorkflowStage", {
  workspaceId,
  instanceId: created.record.instanceId,
  stageId: "plan",
  requestId: "workflow-crash-stage",
  expectedRevision: created.record.revision,
  approved: true,
});
heldChild.resolve();
await invoke<Promise<WorkflowRequestResult<WorkflowInstanceRevision>>>(
  engine,
  "observeWorkflowStage",
  {
    workspaceId,
    instanceId: admitted.record.instanceId,
    stageId: "plan",
    requestId: "workflow-crash-settle",
    expectedRevision: admitted.record.revision,
  },
);
throw Error("Requested original workflow crash boundary was not reached");
