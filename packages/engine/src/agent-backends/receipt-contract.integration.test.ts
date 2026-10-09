import assert from "node:assert/strict";
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  exportEngineArchive,
  validateEngineArchive,
} from "../storage/archive.js";
import { backendFixture, backendUntil } from "./fixtures/backend.js";
import { validateAgentBackendSpec } from "./validation.js";
import {
  AgentBackendStorage,
  markImportedAgentBackendsPaused,
  recoverAgentBackends,
  validateAgentBackendDatabase,
  type AgentBackendRecord,
  type AgentBackendStoragePorts,
  type BackendTransitionReceipt,
} from "./store.js";

const at = "2030-01-02T03:04:05.000Z";
const uuid = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}` as ReturnType<
    typeof crypto.randomUUID
  >;
function captured<T>(
  t: test.TestContext,
  ids: readonly ReturnType<typeof crypto.randomUUID>[],
  operation: () => T,
): T {
  let index = 0;
  const mock = t.mock.method(crypto, "randomUUID", () => {
    assert.ok(index < ids.length, "Only the captured append IDs are consumed");
    return ids[index++]!;
  });
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  try {
    const result = operation();
    assert.equal(index, ids.length);
    return result;
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
    t.mock.timers.reset();
  }
}
// Independent canonical SHA oracle: no writer signing or preparation helper.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function signed<T extends object>(value: T): T & { sha256: string } {
  return { ...value, sha256: hash(value) };
}
function readRows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM backend_revisions ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}
function assertPair(
  path: string,
  record: AgentBackendRecord,
  operation: string,
  input: BackendTransitionReceipt["requestInput"],
): void {
  const receipt = signed({
    id: record.lastReceiptId,
    workspaceId: record.workspaceId,
    kind: record.kind,
    entityId: record.entityId,
    operation,
    beforeRevisionId: record.previousId,
    afterRevisionId: record.id,
    afterSha256: record.sha256,
    requestId: input.requestId,
    requestSha256: hash(input),
    requestInput: input,
    createdAt: record.createdAt,
  });
  const owner =
    record.kind === "request" || record.kind === "client-effect"
      ? record.owner
      : null;
  const columns = {
    workspace_id: record.workspaceId,
    entity_id: record.entityId,
    revision: record.revision,
    run_id: owner?.runId ?? null,
    turn_id: owner?.turnId ?? null,
    attempt_id: owner?.attemptId ?? null,
    tool_id:
      record.kind === "client-effect"
        ? (record.completion?.toolCallId ?? null)
        : null,
    connection_id: record.kind === "backend" ? null : record.connectionId,
    owner_epoch: owner?.ownerEpoch ?? null,
    request_id: input.requestId,
    request_sha256: hash(input),
  };
  const scope = `${record.kind}:${record.entityId}:${operation}`;
  const rows = readRows(path);
  assert.deepEqual(
    rows.find((row) => row.id === record.id),
    {
      ...columns,
      id: record.id,
      kind: record.kind,
      previous_id: record.previousId,
      session_id:
        owner?.sessionId ??
        (record.kind === "backend" ? record.spec.target.sessionId : null),
      request_scope: scope,
      sha256: record.sha256,
      data: JSON.stringify(record),
    },
  );
  assert.deepEqual(
    rows.find((row) => row.id === receipt.id),
    {
      ...columns,
      id: receipt.id,
      kind: "transition",
      previous_id: null,
      session_id: owner?.sessionId ?? null,
      request_scope: `receipt:${scope}`,
      sha256: receipt.sha256,
      data: JSON.stringify(receipt),
    },
  );
}
async function assertArchive(
  dbPath: string,
  artifactDir: string,
  destination: string,
) {
  const archive = await exportEngineArchive({
    dbPath,
    artifactDir,
    destination,
  });
  assert.equal(
    validateEngineArchive({ directory: archive.directory }).manifestSha256,
    archive.manifestSha256,
  );
}

test("live backend SQL pairs bind fixed IDs, canonical hashes and immutable requests independently of the writer", async (t) => {
  const f = await backendFixture(t);
  const target = f.target();
  const rootNative = Reflect.get(
    f.engine,
    "backendRecords",
  ) as AgentBackendStorage;
  const rootPorts = Reflect.get(
    rootNative,
    "ports",
  ) as AgentBackendStoragePorts;
  const proof = rootPorts.readTarget(target.original);
  let reads = 0;
  const native = new AgentBackendStorage(rootNative.db, {
    ...rootPorts,
    readTarget(original) {
      reads++;
      return rootPorts.readTarget(original);
    },
  });
  const input = {
    workspaceId: f.workspace.id,
    requestId: "contract-register",
    expectedRevision: 0,
    spec: f.spec(target.pin),
  };
  const registered = captured(t, [uuid(1), uuid(2)], () =>
    native.registerBackend(target.original, input),
  );
  const expected = signed({
    backendId: f.backendId,
    enabled: true,
    spec: validateAgentBackendSpec(input.spec),
    target: proof,
    id: uuid(1),
    kind: "backend" as const,
    entityId: f.backendId,
    workspaceId: f.workspace.id,
    revision: 1,
    previousId: null,
    lastReceiptId: uuid(2),
    createdAt: at,
  });
  assertPair(
    f.dbPath,
    expected,
    "register",
    input as unknown as BackendTransitionReceipt["requestInput"],
  );
  assert.deepEqual(registered.record, expected);
  assert.equal(Object.isFrozen(registered.record), true);
  assert.equal(Object.isFrozen(registered.receipt.requestInput.spec), true);
  Object.assign(input.spec, {
    description: "Caller mutation after the append",
  });
  assert.equal(
    registered.receipt.requestInput.spec &&
      (registered.receipt.requestInput.spec as Record<string, unknown>)
        .description,
    "Actual ACP v1 native read peer",
  );
  const disableInput = {
    workspaceId: f.workspace.id,
    backendId: f.backendId,
    requestId: "contract-disable",
    expectedRevision: 1,
  };
  captured(t, [uuid(3), uuid(4)], () => native.disableBackend(disableInput));
  const { sha256: _sha, ...body } = expected;
  assertPair(
    f.dbPath,
    signed({
      ...body,
      enabled: false,
      id: uuid(3),
      revision: 2,
      previousId: uuid(1),
      lastReceiptId: uuid(4),
    }),
    "disable",
    disableInput,
  );
  const duplicate = native.registerBackend(
    {},
    registered.receipt.requestInput as unknown as typeof input,
  );
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.id, uuid(1));
  assert.equal(reads, 1);
  assert.equal(readRows(f.dbPath).length, 4);
  validateAgentBackendDatabase(native.db);
  await f.engine.close();
  await assertArchive(
    f.dbPath,
    f.artifactDir,
    join(f.base, "contract-live-archive"),
  );
});

test("administrative SQL pairs preserve authentic unknown ownership, history and archive binding without Original replay", async (t) => {
  const f = await backendFixture(t, { mode: "hold" });
  f.register();
  const submitted = await f.submit();
  await backendUntil(
    () =>
      f.engine.inspectAgentBackendRequests(f.workspace.id)[0]?.state ===
      "dispatched",
    "The genuine Original request did not reach dispatched",
  );
  const snapshotPath = join(f.base, "held-history.sqlite");
  await f.engine.backup(snapshotPath);
  await f.engine.close();
  assert.equal((await submitted.done).state, "cancelled");
  const logs = f.logs();
  const review = new DatabaseSync(`${f.dbPath}.review.sqlite`, {
    readOnly: true,
  });
  try {
    await backup(review, `${snapshotPath}.review.sqlite`);
  } finally {
    review.close();
  }
  const db = new DatabaseSync(snapshotPath);
  db.exec("PRAGMA foreign_keys=ON");
  const originalRows = readRows(snapshotPath);
  const heads = () =>
    db
      .prepare(
        "SELECT r.data FROM backend_heads h JOIN backend_revisions r ON r.id=h.revision_id ORDER BY h.kind,h.entity_id",
      )
      .all()
      .map((row) => JSON.parse(String(row.data)) as AgentBackendRecord);
  const before = heads();
  try {
    db.exec("BEGIN");
    assert.equal(
      captured(t, [uuid(11), uuid(12), uuid(13), uuid(14)], () =>
        recoverAgentBackends(db, at),
      ),
      2,
    );
    db.exec("COMMIT");
    const recovered = heads();
    for (const [index, old] of before
      .filter((record) => record.kind !== "backend")
      .entries()) {
      const { sha256: _sha, ...body } = old;
      const expected = signed({
        ...body,
        id: uuid(11 + index * 2),
        revision: old.revision + 1,
        previousId: old.id,
        lastReceiptId: uuid(12 + index * 2),
        createdAt: at,
        state: "uncertain",
        errorCode: "BACKEND_OWNER_LOST",
      }) as AgentBackendRecord;
      assertPair(snapshotPath, expected, "recover", {
        workspaceId: old.workspaceId,
        requestId: `recover:${old.id}`,
        expectedRevision: old.revision,
      });
      assert.deepEqual(
        recovered.find((record) => record.kind === old.kind),
        expected,
      );
    }
    validateAgentBackendDatabase(db);
    const archiveSha = "a".repeat(64);
    db.exec("BEGIN");
    captured(
      t,
      [uuid(21), uuid(22), uuid(23), uuid(24), uuid(25), uuid(26)],
      () => markImportedAgentBackendsPaused(db, archiveSha, f.workspace.id),
    );
    db.exec("COMMIT");
    const paused = heads();
    for (const [index, old] of recovered.entries()) {
      const { sha256: _sha, ...body } = old;
      const expected = signed({
        ...body,
        ...(old.kind === "backend"
          ? { enabled: false }
          : { state: "paused-import", errorCode: "BACKEND_IMPORTED" }),
        id: uuid(21 + index * 2),
        revision: old.revision + 1,
        previousId: old.id,
        lastReceiptId: uuid(22 + index * 2),
        createdAt: at,
      }) as AgentBackendRecord;
      assertPair(snapshotPath, expected, "pause-import", {
        workspaceId: old.workspaceId,
        requestId: `import:${archiveSha}:${old.id}`,
        expectedRevision: old.revision,
        archiveSha256: archiveSha,
      });
      assert.deepEqual(
        paused.find((record) => record.kind === old.kind),
        expected,
      );
    }
    const currentRows = readRows(snapshotPath);
    for (const row of originalRows)
      assert.deepEqual(
        currentRows.find((current) => current.id === row.id),
        row,
      );
    assert.equal(currentRows.length, originalRows.length + 10);
    assert.equal(recoverAgentBackends(db, at), 0);
    validateAgentBackendDatabase(db);
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
  await assertArchive(
    snapshotPath,
    f.artifactDir,
    join(f.base, "contract-administrative-archive"),
  );
  assert.deepEqual(f.logs(), logs);
  assert.equal(logs.filter((row) => row.type === "started").length, 1);
  assert.equal(
    logs.filter((row) => row.message?.method === "session/prompt").length,
    1,
  );
});
