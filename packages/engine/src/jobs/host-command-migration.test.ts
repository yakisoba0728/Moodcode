import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DATABASE_MIGRATIONS,
  databaseVersion,
  migrateDatabase,
} from "../storage/migrations.js";
import { databaseContents } from "../storage/fixtures/v1-fixture.js";
import { checkDatabase, RECOVERY_LIMITS } from "../recovery/snapshot.js";
import {
  HOST_COMMAND_TABLES,
  validateHostCommandDatabase,
} from "./host-command-records.js";

test("DB22 to DB23 independent host journals migrate atomically, preserve exact history and stay within the real catalogue cap", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 22));
  const before = databaseContents(db),
    oldTables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'",
      )
      .all()
      .map((r) => String(r.name));
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
      )
      .get()!.n,
    136,
  );
  const historicalHash = checkDatabase(db, 22, oldTables, () => {});
  const failing = [
    ...DATABASE_MIGRATIONS.slice(0, 22),
    {
      version: 23,
      name: "actual-host-migration-rollback",
      apply(database: DatabaseSync) {
        DATABASE_MIGRATIONS[22]!.apply(database);
        throw Error("DB23 rollback");
      },
    },
  ];
  assert.throws(() => migrateDatabase(db, failing), /DB23 rollback/);
  assert.deepEqual(databaseContents(db), before);
  assert.equal(databaseVersion(db), 22);
  assert.equal(db.isTransaction, false);
  assert.equal(
    checkDatabase(db, 22, oldTables, () => {}),
    historicalHash,
  );
  migrateDatabase(db);
  assert.equal(databaseVersion(db), 23);
  const after = databaseContents(db);
  assert.deepEqual(
    after.tables.filter(
      (r) =>
        !HOST_COMMAND_TABLES.includes(
          String(r.name) as (typeof HOST_COMMAND_TABLES)[number],
        ),
    ),
    before.tables,
  );
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'",
    )
    .all()
    .map((r) => String(r.name));
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
      )
      .get()!.n,
    139,
  );
  assert.ok(139 <= RECOVERY_LIMITS.maxSchemaEntries);
  for (const name of HOST_COMMAND_TABLES) {
    const sql = String(
      db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql,
    );
    assert.match(sql, /STRICT/);
    assert.match(sql, /WITHOUT ROWID/);
    assert.equal(db.prepare(`SELECT count(*) n FROM ${name}`).get()!.n, 0);
  }
  assert.match(
    checkDatabase(db, 23, tables, () => {}),
    /^[a-f0-9]{64}$/,
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  validateHostCommandDatabase(db);
  migrateDatabase(db);
  assert.deepEqual(databaseContents(db), after);
});
