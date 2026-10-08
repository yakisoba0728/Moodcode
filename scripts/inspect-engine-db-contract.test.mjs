import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  assertDatabaseContractEqual,
  inspectDatabaseCatalogue,
  parseDatabaseContractArgs,
  runDatabaseContractCli,
} from "./inspect-engine-db-contract.mjs";

const migrations = [{ version: 1, name: "fixture-initial" }];
function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(
    "CREATE TABLE entries(id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; CREATE INDEX entry_values ON entries(value); PRAGMA user_version=1",
  );
  return database;
}

test("catalogue includes actual constraints and indexes while excluding stored data", () => {
  const database = fixture();
  try {
    const before = inspectDatabaseCatalogue(database, migrations);
    assert.equal(before.version, 1);
    assert.equal(
      before.objects.find((x) => x.name === "entry_values").sql,
      "CREATE INDEX entry_values ON entries(value)",
    );
    assert.equal(
      before.objects.find((x) => x.name === "entries").sql,
      "CREATE TABLE entries(id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
    );
    database
      .prepare("INSERT INTO entries VALUES (?,?)")
      .run("secret-id", "private-record");
    assert.deepEqual(inspectDatabaseCatalogue(database, migrations), before);
    assert.ok(!JSON.stringify(before).includes("private-record"));
    assertDatabaseContractEqual(before, structuredClone(before));
    database.exec("DROP INDEX entry_values");
    assert.throws(
      () =>
        assertDatabaseContractEqual(
          inspectDatabaseCatalogue(database, migrations),
          before,
        ),
      /contract changed/,
    );
    const corrupt = structuredClone(before);
    corrupt.objects[0].name = "edited";
    assert.throws(
      () => assertDatabaseContractEqual(before, corrupt),
      /contract changed/,
    );
  } finally {
    database.close();
  }
});

test("migration metadata and version mismatches refuse a compatibility claim", () => {
  const database = fixture();
  try {
    assert.throws(() =>
      inspectDatabaseCatalogue(database, [{ version: 2, name: "gap" }]),
    );
    assert.throws(() => inspectDatabaseCatalogue(database, []));
    database.exec("PRAGMA user_version=2");
    assert.throws(() => inspectDatabaseCatalogue(database, migrations));
  } finally {
    database.close();
  }
});

test("invalid or duplicate CLI options and help avoid engine loading", async () => {
  for (const args of [
    ["--live"],
    ["--runtime", "other"],
    ["--report"],
    ["--runtime", "source", "--runtime", "compiled"],
    ["--report", "a\0b"],
  ])
    assert.throws(() => parseDatabaseContractArgs(args));
  assert.deepEqual(parseDatabaseContractArgs([]), { runtime: "compiled" });
  let text = "";
  assert.equal(
    await runDatabaseContractCli(["--help"], (value) => {
      text += value;
    }),
    0,
  );
  assert.match(text, /fresh in-memory DB/);
  assert.equal(
    await runDatabaseContractCli(["--runtime", "invalid"], () => {}),
    2,
  );
});
