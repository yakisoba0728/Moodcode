import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
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

test("rollback journals are fingerprinted and a nonempty primary journal is refused before open", async t => {
  const path = await fixture(t, "CREATE TABLE messages(data TEXT);");
  await writeFile(path + "-journal", "hot-rollback-evidence");
  await writeFile(path + ".effects.sqlite-journal", "effects-rollback-evidence");
  const report = await inspect(path);
  assert.equal(report.status, "refused_before_open");
  assert.equal(report.refusalCode, "nonempty_rollback_journal_requires_recovery_not_immutable_read");
  assert.equal(report.admission.opened, false);
  assert.equal(report.filesUnchanged, true);
  assert.equal(report.filesBefore.journal.bytes, Buffer.byteLength("hot-rollback-evidence"));
  assert.equal(report.filesBefore.effectsJournal.bytes, Buffer.byteLength("effects-rollback-evidence"));
  await writeFile(path + "-journal", "");
  const measured = await inspect(path);
  assert.equal(measured.status, "measured_unchanged");
  assert.equal(measured.admission.rollbackJournalAbsentOrEmpty, true);
  assert.equal(measured.filesUnchanged, true);
});

test("fingerprint enforces its byte bound when a file grows after the initial stat", async t => {
  const path = await fixture(t, "CREATE TABLE messages(data TEXT);");
  const growing = path + ".growing";
  await writeFile(growing, "x");
  const helper = fileURLToPath(new URL("./inspect-history-storage-cost.py", import.meta.url));
  const program = `
import importlib.util,sys,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('history_cost',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
module.LIMITS['maxFileBytes']=4
original_open=module.os.open
def grow_before_open(path,flags):
    with open(path,'ab') as stream: stream.write(b'12345678')
    return original_open(path,flags)
module.os.open=grow_before_open
try: module.fingerprint(Path(sys.argv[2]),time.monotonic()+2)
except module.Refusal as error: print(str(error))
`;
  const { stdout } = await execute("python3", ["-B", "-c", program, helper, growing]);
  assert.equal(stdout.trim(), "file_byte_bound_during_read");
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

test("an ordinary table cannot impersonate eponymous dbstat and expose stored values", async t => {
  const path = await fixture(t, `CREATE TABLE DBSTAT(name TEXT,pagetype TEXT,pgsize INTEGER,payload INTEGER,unused INTEGER);
    INSERT INTO DBSTAT VALUES('private-object-identity','private-history',4096,99,99);`);
  const report = await inspect(path);
  assert.equal(report.refusalCode, "dbstat_schema_name_shadow");
  assert.equal(report.filesUnchanged, true);
  assert.equal(report.dbstat, undefined);
  for (const secret of ["private-object-identity", "private-history"])
    assert.equal(JSON.stringify(report).includes(secret), false);
});

test("context revision samples bound first/last numeric groups and exclude malformed optional JSON", async t => {
  let sql = "CREATE TABLE context_revisions(revision INTEGER,data TEXT); CREATE TABLE session_events(type TEXT,data TEXT);";
  for (let revision = 1; revision <= 20; revision++) {
    const context = JSON.stringify({ revision, text: `private-snapshot-${revision}` });
    const event = JSON.stringify({ payload: { context: { revision, text: `private-snapshot-${revision}` } } });
    sql += `INSERT INTO context_revisions VALUES(${revision},'${context}'); INSERT INTO session_events VALUES('context.revision.recorded','${event}');`;
  }
  sql += "INSERT INTO session_events VALUES('context.revision.recorded','private-malformed-json');";
  const report = await inspect(await fixture(t, sql));
  assert.equal(report.status, "measured_unchanged");
  for (const table of ["context_revisions", "session_events"]) {
    const sampled = report.contextRevisionSamples.tables[table];
    assert.equal(sampled.totalRevisionGroups, 20);
    assert.equal(sampled.groupableRows, 20);
    assert.equal(sampled.truncated, true);
    assert.equal(sampled.groups.length, 16);
    assert.equal(sampled.groups[0].revision, 1);
    assert.equal(sampled.groups.at(-1).revision, 20);
  }
  assert.equal(JSON.stringify(report).includes("private-snapshot"), false);
  assert.equal(JSON.stringify(report).includes("private-malformed-json"), false);
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
