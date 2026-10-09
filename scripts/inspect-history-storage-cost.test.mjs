import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { inspectHistoryStorage, parseHistoryStorageArgs, runHistoryStorageCli } from "./inspect-history-storage-cost.mjs";

const execute = promisify(execFile);
async function fixture(t, sql) {
  const root = await mkdtemp(join(tmpdir(), "moodcode-history-cost-test-")), path = join(root, "engine.sqlite");
  t.after(() => rm(root, { recursive: true, force: true }));
  await execute("python3", ["-c", "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.close()", path, sql]);
  return path;
}
const inspect = database => inspectHistoryStorage({ database, closedSnapshot: true, timeoutMs: 10000 });

test("closed fixture reports all table/column/page totals without stored values or file mutation", async t => {
  const path = await fixture(t, `
    PRAGMA journal_mode=WAL;
    CREATE TABLE session_events(seq INTEGER PRIMARY KEY,type TEXT,data TEXT);
    CREATE INDEX event_type ON session_events(type);
    INSERT INTO session_events VALUES(1,'private-event-name','sensitive-history');
    INSERT INTO session_events VALUES(2,'private-event-name','한');
    CREATE TABLE session_documents(kind TEXT,data TEXT);
    INSERT INTO session_documents VALUES('private-document-kind','private-document-body');
    CREATE TABLE other_history(id TEXT,data BLOB);
    INSERT INTO other_history VALUES('private-record-id',X'000102');
    CREATE TABLE empty_history(data TEXT);
  `);
  await writeFile(path + "-shm", "ephemeral-shm-evidence");
  await writeFile(path + ".effects.sqlite", "ephemeral-effects-evidence");
  const report = await inspect(path);
  assert.equal(report.status, "measured_unchanged");
  assert.equal(report.filesUnchanged, true);
  assert.deepEqual(report.filesBefore, report.filesAfter);
  assert.equal(report.admission.uriMode, "ro");
  assert.equal(report.admission.immutable, true);
  const events = report.tables.find(row => row.table === "session_events");
  assert.equal(events.rows, 2);
  assert.equal(events.dataBytes, Buffer.byteLength("sensitive-history한"));
  assert.equal(events.serializedColumnBytes.seq, 2);
  assert.equal(report.tables.find(row => row.table === "empty_history").logicalBytes, 0);
  assert.equal(report.tables.find(row => row.table === "other_history").dataBytes, 3);
  assert.equal(report.categories.find(row => row.table === "session_events").groups[0].rows, 2);
  for (const secret of ["private-event-name", "sensitive-history", "private-document-kind", "private-document-body", "private-record-id"])
    assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(report.dbstat.createdVirtualTable, false);
  if (report.dbstat.status === "measured") {
    assert.ok(events.physicalIncludingIndexes.pages >= 2);
    assert.ok(report.dbstat.objects.some(row => row.object === "event_type" && row.table === "session_events"));
    assert.equal(report.dbstat.allocatedBytes + report.dbstat.freelistBytes + report.dbstat.unattributedBytes,
      report.sqlite.page_size * report.sqlite.page_count);
    assert.equal(report.sqlite.page_size * report.sqlite.page_count, (await readFile(path)).length);
  } else assert.equal(report.dbstat.sqliteErrorCode, "SQLITE_ERROR");
});

test("nonempty WAL is refused before SQLite open and all file fingerprints remain unchanged", async t => {
  const path = await fixture(t, "CREATE TABLE messages(data TEXT); INSERT INTO messages VALUES('private-history');");
  await writeFile(path + "-wal", "uncheckpointed-wal-evidence");
  const report = await inspect(path);
  assert.equal(report.status, "refused_before_open");
  assert.equal(report.refusalCode, "nonempty_wal_requires_snapshot_not_immutable_read");
  assert.equal(report.admission.opened, false);
  assert.equal(report.filesUnchanged, true);
  assert.equal(report.tables, undefined);
});

test("missing evidence is not created; empty WAL may be inspected immutably", async t => {
  const path = await fixture(t, "CREATE TABLE messages(data TEXT);");
  const missing = await inspect(path + ".absent");
  assert.equal(missing.refusalCode, "primary_missing");
  assert.equal(missing.filesUnchanged, true);
  assert.ok(Object.values(missing.filesBefore).every(file => file.exists === false));
  await writeFile(path + "-wal", "");
  const measured = await inspect(path);
  assert.equal(measured.status, "measured_unchanged");
  assert.equal(measured.filesBefore.wal.bytes, 0);
  assert.equal(measured.filesUnchanged, true);
});

test("symlinks are refused without SQLite opening", async t => {
  const path = await fixture(t, "CREATE TABLE messages(data TEXT);");
  await symlink(path, path + ".link");
  const report = await inspect(path + ".link");
  assert.equal(report.refusalCode, "non_regular_file");
  assert.equal(report.admission.opened, false);
});

test("unusual schema identifiers are refused without exposing stored contents", async t => {
  const path = await fixture(t, `CREATE TABLE "sensitive history"(data TEXT); INSERT INTO "sensitive history" VALUES('private-history');`);
  const report = await inspect(path);
  assert.equal(report.refusalCode, "unsupported_schema_identifier");
  assert.equal(report.filesUnchanged, true);
  assert.equal(JSON.stringify(report).includes("private-history"), false);
});

test("CLI requires an explicit closed snapshot and finite bounds", async () => {
  assert.throws(() => parseHistoryStorageArgs(["--database", "/tmp/example.sqlite"]));
  assert.throws(() => parseHistoryStorageArgs(["--database", "/tmp/example.sqlite", "--closed-snapshot", "--timeout-ms", "60001"]));
  assert.throws(() => parseHistoryStorageArgs(["--database", "/tmp/example.sqlite", "--closed-snapshot", "--closed-snapshot"]));
  await assert.rejects(() => inspectHistoryStorage({ database: "/tmp/example.sqlite", timeoutMs: 1000 }));
  let output = "";
  assert.equal(await runHistoryStorageCli(["--help"], value => output += value), 0);
  assert.match(output, /immutable=1/);
});
