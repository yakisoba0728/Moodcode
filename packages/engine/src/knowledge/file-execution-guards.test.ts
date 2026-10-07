import assert from "node:assert/strict";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EngineError } from "@moodcode/contracts";
import {
  acquireExecutionLock,
  assertExecutionLockAvailable,
  inspectExecutionLock,
  readExecutionLockReservation,
  reserveExecutionLock,
} from "../tools/command/execution-lock.js";
import {
  KNOWLEDGE_FILE_EXECUTION_GUARD_SCHEMA_SQL,
  KnowledgeFileExecutionGuards,
  validateKnowledgeFileExecutionGuards,
} from "./file-execution-guards.js";
import type { KnowledgeFilePublicationRecord } from "./file-publication-types.js";
import type { KnowledgeHostBinding } from "./types.js";
import { knowledgeHash } from "./validation.js";

const invalid = (error: unknown) =>
  error instanceof EngineError && error.code === "KNOWLEDGE_FILE_GUARD_INVALID";
/** Native guard/lock seam only. Authored prepared owner rows confer no producer/completion evidence. */
function fixture(t: TestContext) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-file-guards-")),
    ),
    root = join(base, "workspace");
  mkdirSync(root);
  const db = new DatabaseSync(join(base, "native.sqlite"));
  db.exec(
    `PRAGMA foreign_keys=ON; CREATE TABLE workspaces(id TEXT PRIMARY KEY); CREATE TABLE knowledge_file_publications(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),data TEXT NOT NULL,UNIQUE(workspace_id,id)); ${KNOWLEDGE_FILE_EXECUTION_GUARD_SCHEMA_SQL}`,
  );
  const physical = lstatSync(root, { bigint: true }),
    binding: KnowledgeHostBinding = {
      workspaceId: "workspace-a",
      root,
      rootDevice: physical.dev.toString(),
      rootInode: physical.ino.toString(),
      storageBindingSha256: knowledgeHash({
        database: join(base, "native.sqlite"),
      }),
    };
  let current = binding,
    ownerReads = 0;
  db.prepare("INSERT INTO workspaces VALUES(?)").run(binding.workspaceId);
  db.prepare("INSERT INTO workspaces VALUES(?)").run("workspace-b");
  const owner = {
    id: "original-publication",
    workspaceId: binding.workspaceId,
    binding,
    state: "prepared",
  };
  db.prepare("INSERT INTO knowledge_file_publications VALUES(?,?,?)").run(
    owner.id,
    owner.workspaceId,
    JSON.stringify(owner),
  );
  const guards = new KnowledgeFileExecutionGuards(db, {
    writeTx: (operation) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = operation();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    checkBinding: () => current,
    getOwner: (workspaceId, id) => {
      ownerReads++;
      const row = db
        .prepare(
          "SELECT data FROM knowledge_file_publications WHERE workspace_id=? AND id=?",
        )
        .get(workspaceId, id);
      if (!row)
        throw new EngineError("OWNER_MISSING", "Authored owner is absent");
      return JSON.parse(String(row.data)) as KnowledgeFilePublicationRecord;
    },
  });
  const lockPath = join(base, "effects.sqlite");
  assertExecutionLockAvailable(lockPath);
  t.after(() => {
    db.close();
    rmSync(base, { recursive: true, force: true });
  });
  const reserve = () => {
    const reservation = reserveExecutionLock(lockPath),
      marker = readExecutionLockReservation(reservation);
    guards.reserve(binding, owner.id, lockPath, marker);
    return { reservation, marker };
  };
  return {
    base,
    root,
    db,
    binding,
    owner,
    guards,
    lockPath,
    reserve,
    setBinding: (value: KnowledgeHostBinding) => {
      current = value;
    },
    resetReads: () => {
      ownerReads = 0;
    },
    reads: () => ownerReads,
    row: () =>
      JSON.parse(
        String(
          db
            .prepare(
              "SELECT data FROM knowledge_file_execution_guards WHERE id=?",
            )
            .get(owner.id)!.data,
        ),
      ) as Record<string, unknown>,
  };
}

test("actual opaque reservation binds real SQL guard and current physical lock; live PID cannot be reconciled", (t) => {
  const f = fixture(t),
    original = f.reserve();
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM knowledge_file_execution_guards")
      .get()!.n,
    1,
  );
  validateKnowledgeFileExecutionGuards(f.db);
  const lock = acquireExecutionLock(f.lockPath, original.reservation);
  lock.release(false);
  const before = inspectExecutionLock(f.lockPath);
  assert.equal(before.status, "uncertain");
  assert.deepEqual(f.guards.matching(f.lockPath)!.marker, original.marker);
  assert.equal(f.guards.matching(f.lockPath, "workspace-b"), undefined);
  assert.throws(
    () => f.guards.reconcile(f.binding.workspaceId, f.lockPath),
    (error) =>
      error instanceof EngineError &&
      error.code === "COMMAND_EFFECTS_OWNER_ALIVE",
  );
  assert.deepEqual(inspectExecutionLock(f.lockPath), before);
  assert.throws(
    () => acquireExecutionLock(f.lockPath, { ...original.reservation }),
    (error) =>
      error instanceof EngineError &&
      error.code === "COMMAND_EXECUTION_RESERVATION_INVALID",
  );
});

test("later actual marker and replaced physical lock are not matched to a historical native guard", (t) => {
  const f = fixture(t),
    original = f.reserve(),
    first = acquireExecutionLock(f.lockPath, original.reservation);
  first.release(true);
  const later = reserveExecutionLock(f.lockPath),
    second = acquireExecutionLock(f.lockPath, later);
  second.release(false);
  const actual = inspectExecutionLock(f.lockPath);
  assert.equal(actual.status, "uncertain");
  assert.equal(f.guards.matching(f.lockPath), undefined);
  assert.throws(
    () => f.guards.reconcile(f.binding.workspaceId, f.lockPath),
    invalid,
  );
  assert.deepEqual(inspectExecutionLock(f.lockPath), actual);
  copyFileSync(f.lockPath, join(f.base, "replacement.sqlite"));
  renameSync(f.lockPath, join(f.base, "old-effects.sqlite"));
  renameSync(join(f.base, "replacement.sqlite"), f.lockPath);
  assert.equal(f.guards.matching(f.lockPath), undefined);
  assert.throws(
    () => f.guards.reconcile(f.binding.workspaceId, f.lockPath),
    invalid,
  );
  assert.equal(inspectExecutionLock(f.lockPath).status, "uncertain");
});

test("current binding and actual owner state/binding remain mandatory during runtime matching", (t) => {
  const f = fixture(t),
    original = f.reserve();
  acquireExecutionLock(f.lockPath, original.reservation).release(false);
  const before = inspectExecutionLock(f.lockPath);
  f.setBinding({ ...f.binding, storageBindingSha256: "f".repeat(64) });
  assert.throws(() => f.guards.matching(f.lockPath), invalid);
  assert.deepEqual(inspectExecutionLock(f.lockPath), before);
  f.setBinding(f.binding);
  f.db
    .prepare(
      "UPDATE knowledge_file_publications SET data=json_set(data,'$.state','completed') WHERE id=?",
    )
    .run(f.owner.id);
  assert.throws(() => f.guards.matching(f.lockPath), invalid);
  assert.deepEqual(inspectExecutionLock(f.lockPath), before);
  f.db
    .prepare(
      "UPDATE knowledge_file_publications SET data=json_set(data,'$.state','prepared','$.binding.storageBindingSha256',?) WHERE id=?",
    )
    .run("e".repeat(64), f.owner.id);
  assert.throws(() => validateKnowledgeFileExecutionGuards(f.db), invalid);
  assert.throws(() => f.guards.matching(f.lockPath), invalid);
});

test("runtime and archive reject authored SQL header workspace corruption before reconciling another scope", (t) => {
  const f = fixture(t),
    original = f.reserve();
  acquireExecutionLock(f.lockPath, original.reservation).release(false);
  const before = inspectExecutionLock(f.lockPath);
  f.db.exec("PRAGMA foreign_keys=OFF");
  f.db
    .prepare(
      "UPDATE knowledge_file_execution_guards SET workspace_id=? WHERE id=?",
    )
    .run("workspace-b", f.owner.id);
  assert.throws(() => f.guards.matching(f.lockPath, "workspace-b"), invalid);
  assert.throws(() => f.guards.reconcile("workspace-b", f.lockPath), invalid);
  assert.throws(() => validateKnowledgeFileExecutionGuards(f.db), invalid);
  assert.deepEqual(inspectExecutionLock(f.lockPath), before);
});

test("indexed marker corruption and oversized guard body are rejected by runtime and archive without reading owner payloads", (t) => {
  const f = fixture(t),
    original = f.reserve();
  acquireExecutionLock(f.lockPath, original.reservation).release(false);
  f.resetReads();
  f.db
    .prepare(
      "UPDATE knowledge_file_execution_guards SET marker_updated_at=? WHERE id=?",
    )
    .run("2000-01-01T00:00:00.000Z", f.owner.id);
  assert.equal(f.guards.matching(f.lockPath), undefined);
  assert.throws(() => validateKnowledgeFileExecutionGuards(f.db), invalid);
  assert.equal(f.reads(), 0);
  f.db
    .prepare(
      "UPDATE knowledge_file_execution_guards SET marker_updated_at=? WHERE id=?",
    )
    .run(original.marker.updatedAt, f.owner.id);
  f.db.exec("PRAGMA ignore_check_constraints=ON");
  f.db
    .prepare("UPDATE knowledge_file_execution_guards SET data=? WHERE id=?")
    .run("x".repeat(4097), f.owner.id);
  assert.throws(() => f.guards.matching(f.lockPath), invalid);
  assert.throws(() => validateKnowledgeFileExecutionGuards(f.db), invalid);
  assert.equal(f.reads(), 0);
  assert.equal(inspectExecutionLock(f.lockPath).status, "uncertain");
});

test("failed native current-binding guard reservation rolls back its real SQL transaction", (t) => {
  const f = fixture(t);
  f.setBinding({ ...f.binding, storageBindingSha256: "d".repeat(64) });
  const original = reserveExecutionLock(f.lockPath);
  assert.throws(
    () =>
      f.guards.reserve(
        f.binding,
        f.owner.id,
        f.lockPath,
        readExecutionLockReservation(original),
      ),
    invalid,
  );
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM knowledge_file_execution_guards")
      .get()!.n,
    0,
  );
  assert.equal(f.db.isTransaction, false);
  assert.notEqual(inspectExecutionLock(f.lockPath).status, "uncertain");
});

test("guard reservation rejects accessor/proxy metadata before callbacks or hashing with zero traps and zero native rows", (t) => {
  const f = fixture(t),
    reservation = reserveExecutionLock(f.lockPath),
    marker = readExecutionLockReservation(reservation);
  let traps = 0;
  const hostile = { ...marker };
  Object.defineProperty(hostile, "updatedAt", {
    enumerable: true,
    get() {
      traps++;
      return marker.updatedAt;
    },
  });
  f.resetReads();
  assert.throws(
    () => f.guards.reserve(f.binding, f.owner.id, f.lockPath, hostile),
    (error) => error instanceof EngineError,
  );
  assert.equal(traps, 0);
  assert.equal(f.reads(), 0);
  const proxy = new Proxy(marker, {
    get() {
      traps++;
      throw Error("proxy getter must not run");
    },
    ownKeys() {
      traps++;
      throw Error("proxy enumeration must not run");
    },
  });
  assert.throws(
    () => f.guards.reserve(f.binding, f.owner.id, f.lockPath, proxy),
    (error) => error instanceof EngineError,
  );
  assert.equal(traps, 0);
  assert.equal(f.reads(), 0);
  const binding = { ...f.binding };
  Object.defineProperty(binding, "workspaceId", {
    enumerable: true,
    get() {
      traps++;
      return f.binding.workspaceId;
    },
  });
  assert.throws(
    () => f.guards.reserve(binding, f.owner.id, f.lockPath, marker),
    (error) => error instanceof EngineError,
  );
  assert.equal(traps, 0);
  assert.equal(f.reads(), 0);
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM knowledge_file_execution_guards")
      .get()!.n,
    0,
  );
  assert.equal(f.db.isTransaction, false);
});
