import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import { backendFixture } from "./fixtures/backend.js";
import {
  AgentBackendStorage,
  validateAgentBackendDatabase,
  markImportedAgentBackendsPaused,
  type AgentBackendStoragePorts,
} from "./store.js";

const code = (name: string) => (error: unknown) =>
  error instanceof EngineError && error.code === name;
/** Actual Root-produced target, native SQLite and current launch/config proof; no synthetic execution receipts. */
async function actual(t: test.TestContext) {
  const f = await backendFixture(t),
    captured = f.target(),
    spec = f.spec(captured.pin),
    original = captured.original;
  const rootNative = Reflect.get(
    f.engine,
    "backendRecords",
  ) as AgentBackendStorage;
  const rootPorts = Reflect.get(
    rootNative,
    "ports",
  ) as AgentBackendStoragePorts;
  let captures = 0;
  const native = new AgentBackendStorage(rootNative.db, {
    ...rootPorts,
    readTarget(value) {
      captures++;
      return rootPorts.readTarget(value);
    },
  });
  const input = {
    workspaceId: f.workspace.id,
    requestId: "register",
    expectedRevision: 0,
    spec,
  };
  const registered = native.registerBackend(original, input);
  return {
    f,
    native,
    original,
    registered,
    input,
    spec,
    captures: () => captures,
  };
}
function rollback(native: AgentBackendStorage, run: () => void) {
  native.db.exec("SAVEPOINT backend_native_probe");
  try {
    run();
  } finally {
    native.db.exec("ROLLBACK TO backend_native_probe");
    native.db.exec("RELEASE backend_native_probe");
  }
}

test("native backend journals enforce STRICT, immutable revision relations, FKs and bounded WITHOUT ROWID storage", async (t) => {
  const { native, registered } = await actual(t);
  for (const table of ["backend_revisions", "backend_heads"]) {
    const schema = String(
      native.db
        .prepare("SELECT sql FROM sqlite_schema WHERE name=?")
        .get(table)!.sql,
    );
    assert.match(schema, /STRICT/i);
    assert.match(schema, /WITHOUT ROWID/i);
    assert.throws(
      () => native.db.prepare(`SELECT rowid FROM ${table}`).get(),
      /no such column/,
    );
  }
  for (const [sql, arg] of [
    ["UPDATE backend_revisions SET revision=? WHERE id=?", "not-an-integer"],
    ["UPDATE backend_revisions SET revision=? WHERE id=?", 0],
    [
      "UPDATE backend_revisions SET workspace_id=? WHERE id=?",
      "missing-workspace",
    ],
    ["UPDATE backend_revisions SET attempt_id=? WHERE id=?", "missing-attempt"],
    ["UPDATE backend_revisions SET tool_id=? WHERE id=?", "missing-tool"],
    ["UPDATE backend_revisions SET data=? WHERE id=?", "x".repeat(65537)],
  ] as const)
    rollback(native, () =>
      assert.throws(
        () => native.db.prepare(sql).run(arg, registered.record.id),
        /constraint|cannot store/i,
      ),
    );
  validateAgentBackendDatabase(native.db);
});

test("native backend dedupe precedes original producer reads and keeps immutable history separate from current CAS", async (t) => {
  const a = await actual(t);
  assert.equal(a.captures(), 1);
  const duplicate = a.native.registerBackend(Object.freeze({}), a.input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.id, a.registered.record.id);
  assert.equal(a.captures(), 1);
  assert.throws(
    () =>
      a.native.registerBackend(a.original, {
        ...a.input,
        spec: { ...a.spec, description: "changed input" },
      }),
    code("BACKEND_REQUEST_CONFLICT"),
  );
  assert.equal(a.captures(), 1);
  const disabled = a.native.disableBackend({
    workspaceId: a.f.workspace.id,
    backendId: a.spec.id,
    requestId: "disable",
    expectedRevision: 1,
  });
  assert.equal(disabled.record.enabled, false);
  assert.throws(
    () =>
      a.native.disableBackend({
        workspaceId: a.f.workspace.id,
        backendId: a.spec.id,
        requestId: "stale-disable",
        expectedRevision: 1,
      }),
    code("BACKEND_REVISION_CONFLICT"),
  );
  const historical = a.native.registerBackend({}, a.input);
  assert.equal(historical.record.enabled, true);
  assert.equal(
    a.native.getBackend(a.f.workspace.id, a.spec.id)!.enabled,
    false,
  );
  validateAgentBackendDatabase(a.native.db);
});

test("native backend head CAS and record receipts roll back atomically on a real SQLite head failure", async (t) => {
  const a = await actual(t),
    before = a.native.db
      .prepare("SELECT count(*) n FROM backend_revisions")
      .get()!.n;
  a.native.db.exec(
    "CREATE TEMP TRIGGER backend_head_failure BEFORE UPDATE ON backend_heads BEGIN SELECT RAISE(ABORT,'actual backend head failure'); END",
  );
  try {
    assert.throws(
      () =>
        a.native.disableBackend({
          workspaceId: a.f.workspace.id,
          backendId: a.spec.id,
          requestId: "disabled-after-failure",
          expectedRevision: 1,
        }),
      /actual backend head failure/,
    );
    assert.equal(
      a.native.db.prepare("SELECT count(*) n FROM backend_revisions").get()!.n,
      before,
    );
    assert.equal(
      a.native.getBackend(a.f.workspace.id, a.spec.id)!.enabled,
      true,
    );
  } finally {
    a.native.db.exec("DROP TRIGGER backend_head_failure");
  }
  const retry = a.native.disableBackend({
    workspaceId: a.f.workspace.id,
    backendId: a.spec.id,
    requestId: "disabled-after-failure",
    expectedRevision: 1,
  });
  assert.equal(retry.duplicate, false);
  assert.equal(retry.record.enabled, false);
  validateAgentBackendDatabase(a.native.db);
});

test("native backend graph rejects valid older-head rewind and fully rehashed disable semantics", async (t) => {
  const a = await actual(t),
    disabled = a.native.disableBackend({
      workspaceId: a.f.workspace.id,
      backendId: a.spec.id,
      requestId: "disable",
      expectedRevision: 1,
    });
  rollback(a.native, () => {
    a.native.db
      .prepare(
        "UPDATE backend_heads SET revision_id=?,revision=?,sha256=? WHERE workspace_id=? AND kind='backend' AND entity_id=?",
      )
      .run(
        a.registered.record.id,
        1,
        a.registered.record.sha256,
        a.f.workspace.id,
        a.spec.id,
      );
    assert.throws(() => validateAgentBackendDatabase(a.native.db));
  });
  rollback(a.native, () => {
    const { sha256: _sha, ...record } = disabled.record,
      forgedBody = { ...record, enabled: true },
      forged = { ...forgedBody, sha256: knowledgeHash(forgedBody) };
    const { sha256: _receiptsha, ...receipt } = disabled.receipt,
      receiptBody = { ...receipt, afterSha256: forged.sha256 },
      forgedReceipt = { ...receiptBody, sha256: knowledgeHash(receiptBody) };
    a.native.db
      .prepare("UPDATE backend_revisions SET data=?,sha256=? WHERE id=?")
      .run(JSON.stringify(forged), forged.sha256, forged.id);
    a.native.db
      .prepare("UPDATE backend_revisions SET data=?,sha256=? WHERE id=?")
      .run(
        JSON.stringify(forgedReceipt),
        forgedReceipt.sha256,
        forgedReceipt.id,
      );
    a.native.db
      .prepare("UPDATE backend_heads SET sha256=? WHERE revision_id=?")
      .run(forged.sha256, forged.id);
    assert.throws(() => validateAgentBackendDatabase(a.native.db));
  });
  validateAgentBackendDatabase(a.native.db);
});

test("native archive registration append is disabled, workspace scoped, and preserves original history without caps", async (t) => {
  const a = await actual(t),
    originalData = a.native.db
      .prepare("SELECT data FROM backend_revisions WHERE id=?")
      .get(a.registered.record.id)!.data;
  rollback(a.native, () => {
    markImportedAgentBackendsPaused(
      a.native.db,
      "a".repeat(64),
      "missing-workspace",
    );
    assert.equal(a.native.getBackend(a.f.workspace.id, a.spec.id)!.revision, 1);
  });
  markImportedAgentBackendsPaused(
    a.native.db,
    "a".repeat(64),
    a.f.workspace.id,
  );
  assert.equal(
    a.native.getBackend(a.f.workspace.id, a.spec.id)!.enabled,
    false,
  );
  assert.equal(
    a.native.db
      .prepare("SELECT data FROM backend_revisions WHERE id=?")
      .get(a.registered.record.id)!.data,
    originalData,
  );
  validateAgentBackendDatabase(a.native.db);
});

test("native backend exported input seam never executes getters or proxy traps", async (t) => {
  const a = await actual(t);
  let traps = 0;
  const getter = Object.defineProperty({}, "workspaceId", {
    enumerable: true,
    get() {
      traps++;
      return a.f.workspace.id;
    },
  });
  const proxy = new Proxy(
    { ...a.input },
    {
      get() {
        traps++;
        throw new Error("get trap");
      },
      ownKeys() {
        traps++;
        throw new Error("ownKeys trap");
      },
      getOwnPropertyDescriptor() {
        traps++;
        throw new Error("descriptor trap");
      },
    },
  );
  assert.throws(() =>
    a.native.registerBackend(a.original, getter as typeof a.input),
  );
  assert.throws(() => a.native.registerBackend(a.original, proxy));
  assert.equal(traps, 0);
  assert.equal(a.captures(), 1);
  validateAgentBackendDatabase(a.native.db);
});
