import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import { knowledgeHash } from "../knowledge/validation.js";
import type { WorkflowStartPreview } from "./host.js";
import type { WorkflowInstanceRevision } from "./reducer.js";
import {
  WORKFLOW_STORAGE_LIMITS,
  WorkflowStorage,
  markImportedWorkflowsPaused,
  validateWorkflowDatabase,
  type WorkflowRequestResult,
  type WorkflowSpecRevision,
  type WorkflowStoragePorts,
} from "./store.js";
import { workflowFixture, workflowInvoke } from "./fixtures/workflow.js";

type Fixture = Awaited<ReturnType<typeof workflowFixture>>;
function code(expected: string) {
  return (error: unknown) =>
    error instanceof EngineError && error.code === expected;
}
async function started(t: test.TestContext) {
  const f = await workflowFixture(t, { worktreeCount: 1 }),
    spec = await f.spec();
  const registered = workflowInvoke<
    WorkflowRequestResult<WorkflowSpecRevision>
  >(f.engine, "registerWorkflow", {
    workspaceId: f.workspace.id,
    requestId: "register",
    expectedRevision: 0,
    spec,
  });
  const parent = await f.startParent(),
    parameters = { question: "Use the exact original readonly child." };
  const preview = await workflowInvoke<Promise<WorkflowStartPreview>>(
    f.engine,
    "previewWorkflowStart",
    {
      workspaceId: f.workspace.id,
      rootSessionId: f.session.id,
      parentRunId: parent.runId,
      workflowId: spec.id,
      expectedSpecRevision: registered.record.revision,
      parameters,
      stageWorktrees: f.stageWorktrees(spec),
    },
  );
  const created = workflowInvoke<
    WorkflowRequestResult<WorkflowInstanceRevision>
  >(f.engine, "startWorkflow", {
    workspaceId: f.workspace.id,
    requestId: "start",
    approved: true,
    preview,
  });
  const native = Reflect.get(f.engine, "workflowRecords") as WorkflowStorage;
  assert.ok(native instanceof WorkflowStorage);
  const service = Reflect.get(f.engine, "workflowService") as {
    owners: Map<string, { original: object }>;
  };
  const original = service.owners.get(created.record.instanceId)!.original;
  return { f, spec, registered, created, native, original, parameters };
}
function rollback(native: WorkflowStorage, fn: () => void) {
  native.db.exec("SAVEPOINT native_workflow_probe");
  try {
    fn();
  } finally {
    native.db.exec("ROLLBACK TO native_workflow_probe");
    native.db.exec("RELEASE native_workflow_probe");
  }
}
function resign(value: Record<string, unknown>) {
  const { sha256: _old, ...body } = value;
  return { ...body, sha256: knowledgeHash(body) };
}
/** Signed register pairs written straight to SQL: reaching the cap through registerWorkflow() is quadratic. */
function fillWithSpecRevisions(
  db: DatabaseSync,
  workspaceId: string,
  workflowId: string,
  limit: { rows: number; bytes: number },
) {
  const insert = db.prepare(
      "INSERT INTO workflow_revisions(id,workspace_id,kind,entity_id,revision,previous_id,root_session_id,root_run_id,owner_sha256,request_scope,request_id,request_sha256,sha256,data) VALUES(?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,?,?)",
    ),
    total = db
      .prepare(
        "SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM workflow_revisions",
      )
      .get()!;
  let rows = Number(total.count),
    bytes = Number(total.bytes),
    head = JSON.parse(
      String(
        db
          .prepare(
            "SELECT r.data FROM workflow_heads h JOIN workflow_revisions r ON r.id=h.revision_id WHERE h.workspace_id=? AND h.kind='spec' AND h.entity_id=?",
          )
          .get(workspaceId, workflowId)!.data,
      ),
    ) as WorkflowSpecRevision;
  db.exec("BEGIN");
  for (;;) {
    const requestId = `fill-${head.revision}`,
      requestInput = {
        workspaceId,
        requestId,
        expectedRevision: head.revision,
        spec: head.spec,
      },
      requestSha256 = knowledgeHash(requestInput),
      record = resign({
        ...head,
        id: randomUUID(),
        revision: head.revision + 1,
        previousId: head.id,
        lastReceiptId: randomUUID(),
      }) as unknown as WorkflowSpecRevision,
      receipt = resign({
        id: record.lastReceiptId,
        workspaceId,
        instanceId: null,
        workflowId,
        operation: "register",
        stageId: null,
        beforeRevisionId: head.id,
        afterRevisionId: record.id,
        afterSha256: record.sha256,
        requestId,
        requestSha256,
        requestInput,
        ownerSha256: null,
        createdAt: record.createdAt,
      }) as { id: string; sha256: string },
      size =
        Buffer.byteLength(JSON.stringify(record)) +
        Buffer.byteLength(JSON.stringify(receipt));
    if (rows + 2 > limit.rows || bytes + size > limit.bytes) break;
    insert.run(
      record.id,
      workspaceId,
      "spec",
      workflowId,
      record.revision,
      head.id,
      `register:${workflowId}`,
      requestId,
      requestSha256,
      record.sha256,
      JSON.stringify(record),
    );
    insert.run(
      receipt.id,
      workspaceId,
      "transition",
      `spec:${workflowId}`,
      record.revision,
      head.lastReceiptId,
      `receipt:spec:${workflowId}`,
      requestId,
      requestSha256,
      receipt.sha256,
      JSON.stringify(receipt),
    );
    rows += 2;
    bytes += size;
    head = record;
  }
  db.prepare(
    "UPDATE workflow_heads SET revision_id=?,revision=?,sha256=? WHERE workspace_id=? AND kind='spec' AND entity_id=?",
  ).run(head.id, head.revision, head.sha256, workspaceId, workflowId);
  db.exec("COMMIT");
}
function update(
  native: WorkflowStorage,
  id: string,
  record: Record<string, unknown>,
) {
  const value = resign(record);
  native.db
    .prepare("UPDATE workflow_revisions SET data=?,sha256=? WHERE id=?")
    .run(JSON.stringify(value), value.sha256, id);
  return value;
}

test("native workflow SQLite tables enforce STRICT, FK, revision and byte constraints on actual root storage", async (t) => {
  const { native } = await started(t);
  for (const table of ["workflow_revisions", "workflow_heads"]) {
    const sql = String(
      native.db
        .prepare("SELECT sql FROM sqlite_schema WHERE name=?")
        .get(table)!.sql,
    );
    assert.match(sql, /STRICT/i);
    assert.match(sql, /WITHOUT ROWID/i);
    assert.throws(
      () => native.db.prepare(`SELECT rowid FROM ${table}`).get(),
      /no such column/,
    );
  }
  const row = native.db
    .prepare("SELECT id FROM workflow_revisions WHERE kind='spec'")
    .get()!;
  for (const [sql, arg] of [
    ["UPDATE workflow_revisions SET revision=? WHERE id=?", "not-an-integer"],
    ["UPDATE workflow_revisions SET revision=? WHERE id=?", 0],
    ["UPDATE workflow_revisions SET kind=? WHERE id=?", "unexpected"],
    [
      "UPDATE workflow_revisions SET workspace_id=? WHERE id=?",
      "missing-workspace",
    ],
    [
      "UPDATE workflow_revisions SET root_run_id=? WHERE id=?",
      "missing-native-run",
    ],
    ["UPDATE workflow_revisions SET data=? WHERE id=?", "x".repeat(131073)],
  ] as const)
    rollback(native, () =>
      assert.throws(
        () => native.db.prepare(sql).run(arg, String(row.id)),
        /constraint|datatype|cannot store/i,
      ),
    );
  validateWorkflowDatabase(native.db);
});

test("native dedupe precedes fresh owner producers and preserves atomic revision CAS and operation identity", async (t) => {
  const { f, spec, registered, created, native, original, parameters } =
    await started(t);
  const ports = Reflect.get(native, "ports") as WorkflowStoragePorts,
    read = ports.readOwner.bind(ports);
  let reads = 0;
  ports.readOwner = (handle) => {
    reads++;
    return read(handle);
  };
  const initial = f.counts();
  const duplicate = native.createInstance(
    {},
    {
      workspaceId: f.workspace.id,
      requestId: "start",
      workflowId: spec.id,
      expectedSpecRevision: registered.record.revision,
      parameters,
      worktrees: f.stageWorktrees(spec),
      ownerSha256: created.record.owner.sha256,
    },
  );
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.sha256, created.record.sha256);
  assert.equal(reads, 0);
  assert.deepEqual(f.counts(), initial);
  const input = {
    workspaceId: f.workspace.id,
    instanceId: created.record.instanceId,
    stageId: "plan",
    requestId: "native-intent",
    expectedRevision: created.record.revision,
    childRequestId: "native-child-intent",
    prompt: "An exact multiline prompt.\nReturn strict JSON.",
  };
  const prepared = native.prepareStage(original, input),
    after = f.counts();
  assert.equal(prepared.record.stages[0]!.state, "dispatching");
  assert.equal(f.children.length, 0);
  const priorReads = reads;
  assert.equal(native.prepareStage({}, input).duplicate, true);
  assert.equal(reads, priorReads);
  assert.deepEqual(f.counts(), after);
  const { childRequestId: _child, prompt: _prompt, ...admitInput } = input;
  assert.throws(
    () => native.admitStage({}, {}, admitInput),
    code("WORKFLOW_REQUEST_CONFLICT"),
  );
  assert.equal(reads, priorReads);
  assert.throws(
    () =>
      native.prepareStage(original, { ...input, requestId: "stale-intent" }),
    code("WORKFLOW_STALE"),
  );
  assert.deepEqual(f.counts(), after);
  validateWorkflowDatabase(native.db);
});

test("exported native workflow inputs reject accessors and proxy has traps before SQLite or owner effects", async (t) => {
  const { f, created, native } = await started(t),
    before = f.counts();
  let traps = 0;
  const input = {
    workspaceId: f.workspace.id,
    instanceId: created.record.instanceId,
    stageId: "plan",
    requestId: "trap-intent",
    expectedRevision: 1,
    childRequestId: "trap-child",
    prompt: "Valid prompt.",
  };
  const getter = { ...input };
  Object.defineProperty(getter, "prompt", {
    enumerable: true,
    get() {
      traps++;
      return "Untrusted getter.";
    },
  });
  const proxy = new Proxy(input, {
    has() {
      traps++;
      return true;
    },
    get() {
      traps++;
      return "Untrusted getter.";
    },
    ownKeys() {
      traps++;
      return [];
    },
  });
  assert.throws(() => native.prepareStage({}, getter));
  assert.throws(() => native.prepareStage({}, proxy));
  assert.throws(() => native.admitStage({}, {}, proxy));
  assert.equal(traps, 0);
  assert.deepEqual(f.counts(), before);
  assert.equal(f.children.length, 0);
});

async function completed(t: test.TestContext) {
  const value = await started(t),
    { f, created } = value;
  const admitted = await workflowInvoke<
    Promise<WorkflowRequestResult<WorkflowInstanceRevision>>
  >(f.engine, "startWorkflowStage", {
    workspaceId: f.workspace.id,
    instanceId: created.record.instanceId,
    stageId: "plan",
    requestId: "dispatch",
    expectedRevision: created.record.revision,
    approved: true,
  });
  const child = await f.waitChild();
  child.release.resolve();
  const settled = await workflowInvoke<
    Promise<WorkflowRequestResult<WorkflowInstanceRevision>>
  >(f.engine, "observeWorkflowStage", {
    workspaceId: f.workspace.id,
    instanceId: created.record.instanceId,
    stageId: "plan",
    requestId: "observe",
    expectedRevision: admitted.record.revision,
  });
  assert.equal(settled.record.state, "completed");
  return { ...value, settled };
}

test("native graph replay rejects fully rehashed transition preimages and child results that contradict actual native receipts", async (t) => {
  const { native, settled } = await completed(t);
  validateWorkflowDatabase(native.db);
  rollback(native, () => {
    const row = native.db
      .prepare(
        "SELECT id,data FROM workflow_revisions WHERE kind='transition' AND json_extract(data,'$.operation')='prepare'",
      )
      .get()!;
    const receipt = JSON.parse(String(row.data)) as Record<string, unknown>,
      request = receipt.requestInput as JsonObject;
    request.prompt = "Forged prompt with a different raw UTF-8 digest.";
    receipt.requestSha256 = knowledgeHash(request);
    native.db
      .prepare("UPDATE workflow_revisions SET request_sha256=? WHERE id=?")
      .run(String(receipt.requestSha256), String(receipt.afterRevisionId));
    update(native, String(row.id), receipt);
    native.db
      .prepare("UPDATE workflow_revisions SET request_sha256=? WHERE id=?")
      .run(String(receipt.requestSha256), String(row.id));
    assert.throws(
      () => validateWorkflowDatabase(native.db),
      code("WORKFLOW_DATABASE_INVALID"),
    );
  });
  rollback(native, () => {
    const record = structuredClone(settled.record),
      stage = structuredClone(record.stages[0]!),
      result = {
        observation: "Forged advisory output absent from the original child.",
      };
    const forgedStage = {
        ...stage,
        result,
        resultSha256: knowledgeHash(result),
      },
      forgedInstance = { ...record, stages: [forgedStage], result };
    const stageRow = native.db
      .prepare("SELECT data FROM workflow_revisions WHERE id=?")
      .get(stage.id)!;
    const updatedStage = update(native, stage.id, {
      ...JSON.parse(String(stageRow.data)),
      stage: forgedStage,
    });
    const updatedInstance = update(
      native,
      record.id,
      forgedInstance as unknown as Record<string, unknown>,
    );
    native.db
      .prepare("UPDATE workflow_heads SET sha256=? WHERE revision_id=?")
      .run(updatedStage.sha256, stage.id);
    native.db
      .prepare("UPDATE workflow_heads SET sha256=? WHERE revision_id=?")
      .run(updatedInstance.sha256, record.id);
    const receiptRow = native.db
      .prepare("SELECT data FROM workflow_revisions WHERE id=?")
      .get(record.lastReceiptId)!;
    update(native, record.lastReceiptId, {
      ...JSON.parse(String(receiptRow.data)),
      afterSha256: updatedInstance.sha256,
    });
    assert.throws(
      () => validateWorkflowDatabase(native.db),
      code("WORKFLOW_DATABASE_INVALID"),
    );
  });
  validateWorkflowDatabase(native.db);
});

test("native workflow aggregate caps reject metadata before parsing bodies and abort new writes atomically", async (t) => {
  const { f, native, spec } = await started(t),
    before = f.counts();
  rollback(native, () => {
    const insert = native.db.prepare(
      "INSERT INTO workflow_revisions(id,workspace_id,kind,entity_id,revision,previous_id,root_session_id,root_run_id,owner_sha256,request_scope,request_id,request_sha256,sha256,data) VALUES(?,?,'spec',?,1,NULL,NULL,NULL,NULL,?,?,?,?,'invalid JSON')",
    );
    for (let index = 0; index < 4097; index++) {
      const id = randomUUID();
      insert.run(
        id,
        f.workspace.id,
        id,
        `cap:${index}`,
        id,
        "a".repeat(64),
        "b".repeat(64),
      );
    }
    assert.throws(
      () => validateWorkflowDatabase(native.db),
      code("WORKFLOW_LIMIT"),
    );
    const expanded = f.counts();
    assert.throws(
      () =>
        native.registerWorkflow({
          workspaceId: f.workspace.id,
          requestId: "over-cap",
          expectedRevision: 0,
          spec: { ...spec, id: "another-workflow" },
        }),
      code("WORKFLOW_LIMIT"),
    );
    assert.deepEqual(f.counts(), expanded);
  });
  assert.deepEqual(f.counts(), before);
  validateWorkflowDatabase(native.db);
});

test("a stage mutation reusing the create requestId is a typed request conflict before any write", async (t) => {
  const { f, created, native, original } = await started(t),
    before = f.counts();
  assert.throws(
    () =>
      native.prepareStage(original, {
        workspaceId: f.workspace.id,
        instanceId: created.record.instanceId,
        stageId: "plan",
        requestId: "start",
        expectedRevision: created.record.revision,
        childRequestId: "reused-create-child",
        prompt: "Reuses the create requestId.",
      }),
    code("WORKFLOW_REQUEST_CONFLICT"),
  );
  assert.deepEqual(f.counts(), before);
  validateWorkflowDatabase(native.db);
});

test("normal workflow writes stop while recovery and pause-import headroom remains, so a near-cap journal reopens and imports", async (t) => {
  const { f, spec, created, native, original } = await started(t);
  const prepared = native.prepareStage(original, {
    workspaceId: f.workspace.id,
    instanceId: created.record.instanceId,
    stageId: "plan",
    requestId: "near-cap-intent",
    expectedRevision: created.record.revision,
    childRequestId: "near-cap-child",
    prompt: "Dispatch before the journal fills.",
  });
  assert.equal(prepared.record.state, "running");
  assert.equal(prepared.record.stages[0]!.state, "dispatching");
  fillWithSpecRevisions(native.db, f.workspace.id, spec.id, {
    rows: WORKFLOW_STORAGE_LIMITS.rows - 32,
    bytes: WORKFLOW_STORAGE_LIMITS.bytes - 262144,
  });
  let rejected: unknown;
  for (let index = 0; index < 256 && !rejected; index++)
    try {
      native.registerWorkflow({
        workspaceId: f.workspace.id,
        requestId: `near-cap-${index}`,
        expectedRevision: native.getWorkflow(f.workspace.id, spec.id)!.revision,
        spec,
      });
    } catch (error) {
      rejected = error;
    }
  assert.ok(code("WORKFLOW_LIMIT")(rejected));
  assert.ok(
    Number(f.counts().workflow_revisions) + 5 <= WORKFLOW_STORAGE_LIMITS.rows,
  );
  await f.engine.close();
  f.engines.delete(f.engine);
  const reopened = createEngine(f.configuration);
  f.engines.add(reopened);
  const recovered = reopened.inspectWorkflow(
    f.workspace.id,
    created.record.instanceId,
  )!;
  assert.equal(recovered.state, "uncertain");
  assert.equal(recovered.stages[0]!.state, "uncertain");
  const db = (Reflect.get(reopened, "workflowRecords") as WorkflowStorage).db;
  validateWorkflowDatabase(db);
  db.exec("SAVEPOINT pause_import_probe");
  try {
    markImportedWorkflowsPaused(db, "a".repeat(64), f.workspace.id);
    validateWorkflowDatabase(db);
  } finally {
    db.exec("ROLLBACK TO pause_import_probe");
    db.exec("RELEASE pause_import_probe");
  }
});
