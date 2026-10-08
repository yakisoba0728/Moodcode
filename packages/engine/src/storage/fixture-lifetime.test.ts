import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { sqliteFixtureDirectory } from "./fixtures/sqlite-directory.js";

test("fixture lifetime closes actual observer and reopened storage handles before removing the directory", async (t) => {
  const f = sqliteFixtureDirectory(t, "moodcode-storage-lifetime-"),
    first = f.openStore();
  const workspace = {
    id: "workspace",
    root: f.directory,
    gitRoot: f.directory,
    branch: null,
    createdAt: new Date().toISOString(),
  };
  first.putWorkspace(workspace);
  first.createSession({
    id: "session",
    workspaceId: workspace.id,
    title: "Actual native handle lifetime",
    createdAt: workspace.createdAt,
  });
  const observer = f.openDatabase();
  assert.equal(
    observer.prepare("SELECT count(*) AS count FROM sessions").get()?.count,
    1,
  );
  first.close();
  const reopened = f.openStore(),
    laterObserver = f.openDatabase();
  assert.equal(reopened.getSession("session").id, "session");
  assert.equal(
    laterObserver.prepare("SELECT count(*) AS count FROM workspaces").get()
      ?.count,
    1,
  );
  assert.equal(observer.isOpen, true);
  assert.equal(laterObserver.isOpen, true);
  await f.cleanup();
  assert.equal(observer.isOpen, false);
  assert.equal(laterObserver.isOpen, false);
  for (const store of [first, reopened])
    assert.throws(
      () => store.getSession("session"),
      (error) => error instanceof EngineError && error.code === "STORE_CLOSED",
    );
  assert.equal(existsSync(f.directory), false);
  await f.cleanup();
  assert.throws(() => f.openStore(), /already removed/);
  assert.throws(() => f.openDatabase(), /already removed/);
});

test("an actual connection close failure propagates its original error and preserves SQLite evidence until genuine closure", async (t) => {
  const f = sqliteFixtureDirectory(t, "moodcode-storage-close-failure-"),
    store = f.openStore(),
    observer = f.openDatabase(),
    other = f.openDatabase();
  const original = new Error("Injected native observer close fault");
  const logicalHash = () =>
    createHash("sha256")
      .update(
        JSON.stringify(
          observer
            .prepare("SELECT name,type,sql FROM sqlite_schema ORDER BY name")
            .all(),
        ),
      )
      .digest("hex");
  const before = logicalHash();
  const fault = t.mock.method(observer, "close", () => {
    throw original;
  });
  await assert.rejects(
    f.cleanup(),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 1 &&
      error.errors[0] === original,
  );
  assert.equal(
    observer.isOpen,
    true,
    "A failed close is not recorded as physical release",
  );
  assert.equal(
    other.isOpen,
    false,
    "Failure of one handle does not prevent release of the other owned connections",
  );
  assert.throws(
    () => store.listWorkspaces(),
    (error) => error instanceof EngineError && error.code === "STORE_CLOSED",
  );
  assert.equal(existsSync(f.directory), true);
  assert.equal(
    logicalHash(),
    before,
    "Native schema is preserved while ordinary SQLite close may checkpoint its WAL",
  );
  fault.mock.restore();
  await f.cleanup();
  assert.equal(observer.isOpen, false);
  assert.equal(existsSync(f.directory), false);
});
