import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeHash } from "../knowledge/validation.js";
import { backendFixture } from "./fixtures/backend.js";
import {
  AgentBackendStorage,
  validateAgentBackendDatabase,
  type AgentBackendRecord,
  type BackendTransitionReceipt,
} from "./store.js";

async function completed(t: test.TestContext, mode = "read") {
  const f = await backendFixture(t, { mode });
  f.register();
  const first = await f.submit();
  const run = await first.done;
  assert.equal(run.state, "completed", JSON.stringify(run));
  const native = Reflect.get(f.engine, "backendRecords") as AgentBackendStorage;
  validateAgentBackendDatabase(native.db);
  return { f, native, first };
}
function rollback(native: AgentBackendStorage, run: () => void) {
  native.db.exec("SAVEPOINT backend_graph_probe");
  try {
    run();
  } finally {
    native.db.exec("ROLLBACK TO backend_graph_probe");
    native.db.exec("RELEASE backend_graph_probe");
  }
}
function sign<T extends object>(input: T): T & { sha256: string } {
  const { sha256: _sha, ...body } = input as T & { sha256?: string };
  return { ...body, sha256: knowledgeHash(body) } as T & { sha256: string };
}
function rewrite(
  native: AgentBackendStorage,
  record: AgentBackendRecord,
): void {
  const next = sign(record),
    row = native.db
      .prepare("SELECT data FROM backend_revisions WHERE id=?")
      .get(record.lastReceiptId)!;
  const receipt = sign({
    ...(JSON.parse(String(row.data)) as BackendTransitionReceipt),
    afterSha256: next.sha256,
  });
  native.db
    .prepare("UPDATE backend_revisions SET data=?,sha256=? WHERE id=?")
    .run(JSON.stringify(next), next.sha256, next.id);
  native.db
    .prepare("UPDATE backend_revisions SET data=?,sha256=? WHERE id=?")
    .run(JSON.stringify(receipt), receipt.sha256, receipt.id);
  native.db
    .prepare("UPDATE backend_heads SET sha256=? WHERE revision_id=?")
    .run(next.sha256, next.id);
}
function records(native: AgentBackendStorage): AgentBackendRecord[] {
  return native.db
    .prepare(
      "SELECT data FROM backend_revisions WHERE kind!='transition' ORDER BY revision",
    )
    .all()
    .map((row) => JSON.parse(String(row.data)) as AgentBackendRecord);
}

test("genuine completed backend history rejects premature terminal receipts and remote-session mutation even after wrapper rehash", async (t) => {
  const { native, f } = await completed(t);
  const current = f.engine.inspectAgentBackendRequests(f.workspace.id)[0]!;
  const initial = records(native).find(
    (r) =>
      r.kind === "request" &&
      r.entityId === current.entityId &&
      r.revision === 1,
  )!;
  rollback(native, () => {
    assert.equal(initial.kind, "request");
    rewrite(native, {
      ...initial,
      ...(initial.kind === "request"
        ? {
            state: "completed",
            dispatch: current.dispatch,
            terminal: current.terminal,
          }
        : {}),
    } as AgentBackendRecord);
    assert.throws(() => validateAgentBackendDatabase(native.db));
  });
  rollback(native, () => {
    rewrite(native, { ...current, remoteSessionId: "foreign-session" });
    assert.throws(() => validateAgentBackendDatabase(native.db));
  });
  validateAgentBackendDatabase(native.db);
});

test("genuine first connection cannot be relinked to another authentic Run and Attempt by self-consistent native hashes", async (t) => {
  const { native, f } = await completed(t, "unsupported"),
    first = f.engine.inspectAgentBackendRequests(f.workspace.id)[0]!;
  const secondRun = await f.submit(
    "A second genuine Root-owned provider Attempt.",
  );
  assert.equal((await secondRun.done).state, "completed");
  const second = f.engine
    .inspectAgentBackendRequests(f.workspace.id)
    .find((r) => r.owner.runId === secondRun.runId)!;
  assert.notEqual(first.owner.attemptId, second.owner.attemptId);
  rollback(native, () => {
    for (const record of records(native)) {
      if (record.kind === "request" && record.entityId === first.entityId) {
        rewrite(native, { ...record, owner: second.owner });
        for (const rowId of [record.id, record.lastReceiptId])
          native.db
            .prepare(
              "UPDATE backend_revisions SET session_id=?,run_id=?,turn_id=?,attempt_id=?,owner_epoch=? WHERE id=?",
            )
            .run(
              second.owner.sessionId,
              second.owner.runId,
              second.owner.turnId,
              second.owner.attemptId,
              second.owner.ownerEpoch,
              rowId,
            );
      }
      if (
        record.kind === "connection" &&
        record.connectionId === first.connectionId
      )
        rewrite(native, {
          ...record,
          proof: sign({ ...record.proof, ownerSha256: second.owner.sha256 }),
        });
    }
    assert.throws(() => validateAgentBackendDatabase(native.db));
  });
  validateAgentBackendDatabase(native.db);
});

test("genuine native read receipts reject Tool output, Part identity and self-rehashed prepared fingerprint drift", async (t) => {
  const { native, f } = await completed(t),
    effect = f.engine.inspectAgentBackendEffects(f.workspace.id)[0]!;
  assert.ok(effect.completion);
  rollback(native, () => {
    const raw = native.db
        .prepare("SELECT data FROM tools WHERE id=?")
        .get(effect.completion!.toolCallId)!,
      tool = JSON.parse(String(raw.data));
    native.db
      .prepare("UPDATE tools SET data=? WHERE id=?")
      .run(
        JSON.stringify({ ...tool, output: "Different durable native output" }),
        tool.id,
      );
    assert.throws(() => validateAgentBackendDatabase(native.db));
  });
  rollback(native, () => {
    const parts = native.db
        .prepare("SELECT id,data FROM message_parts WHERE turn_id=?")
        .all(effect.owner.turnId),
      partRow = parts.find(
        (p) =>
          JSON.parse(String(p.data)).toolCallId ===
          effect.completion!.toolCallId,
      )!;
    const part = JSON.parse(String(partRow.data));
    native.db.prepare("UPDATE message_parts SET data=? WHERE id=?").run(
      JSON.stringify({
        ...part,
        providerCallId: "another-authentic-wire-id",
      }),
      String(partRow.id),
    );
    assert.throws(() => validateAgentBackendDatabase(native.db));
  });
  rollback(native, () => {
    for (const record of records(native))
      if (
        record.kind === "client-effect" &&
        record.entityId === effect.entityId &&
        record.completion
      )
        rewrite(native, {
          ...record,
          completion: sign({
            ...record.completion,
            preparedFingerprint: "f".repeat(64),
          }),
        });
    assert.throws(() => validateAgentBackendDatabase(native.db));
  });
  validateAgentBackendDatabase(native.db);
});

test("genuine closed connection proof and borrowed request head remain mandatory for terminal archive history", async (t) => {
  const { native, f } = await completed(t),
    connection = f.engine.inspectAgentBackendConnections(f.workspace.id)[0]!,
    request = f.engine.inspectAgentBackendRequests(f.workspace.id)[0]!;
  rollback(native, () => {
    assert.ok(connection.disposal);
    rewrite(native, {
      ...connection,
      state: "uncertain",
      disposal: sign({ ...connection.disposal!, cleanupConfirmed: false }),
      errorCode: "CLEANUP_UNCERTAIN",
    });
    assert.throws(() => validateAgentBackendDatabase(native.db));
  });
  rollback(native, () => {
    native.db
      .prepare(
        "UPDATE backend_heads SET revision_id=?,revision=?,sha256=? WHERE workspace_id=? AND kind='backend'",
      )
      .run(request.id, request.revision, request.sha256, f.workspace.id);
    assert.throws(() => validateAgentBackendDatabase(native.db));
  });
  validateAgentBackendDatabase(native.db);
});
