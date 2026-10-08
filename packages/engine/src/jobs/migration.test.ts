import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DATABASE_MIGRATIONS,
  databaseVersion,
  migrateDatabase,
} from "../storage/migrations.js";
import {
  databaseContents,
  restoreFrozenDatabase,
} from "../storage/fixtures/v1-fixture.js";
import { V1_DATABASE_FIXTURE } from "../storage/fixtures/v1-database.js";
import { JOB_TABLES } from "./schema.js";
import { validateJobDatabase } from "./store.js";
import {
  exportEngineArchive,
  importEngineArchive,
  validateEngineArchive,
} from "../storage/archive.js";
import { createEngine } from "../engine.js";
import { jobFixture, jobInvoke } from "./fixtures/job.js";
import type { CommandJob, JobRequestResult } from "./store.js";
import { signJobData } from "./validation.js";

test("DB21 to DB22 creates exactly two STRICT job journals, preserves legacy/native history and is idempotent", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "moodcode-job-migration-")),
    path = join(directory, "engine.sqlite");
  restoreFrozenDatabase(path, V1_DATABASE_FIXTURE.primary, directory);
  const db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec("PRAGMA foreign_keys=ON");
  migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 21));
  assert.equal(databaseVersion(db), 21);
  const before = databaseContents(db),
    schemaBefore = db
      .prepare(
        "SELECT name,type FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
      )
      .all();
  assert.equal(schemaBefore.length, 134);
  const failing = [
    ...DATABASE_MIGRATIONS.slice(0, 21),
    {
      version: 22,
      name: "intentional-job-migration-rollback",
      apply(database: DatabaseSync) {
        DATABASE_MIGRATIONS[21]!.apply(database);
        throw new Error("DB22 rollback");
      },
    },
  ];
  assert.throws(() => migrateDatabase(db, failing), /DB22 rollback/);
  assert.deepEqual(databaseContents(db), before);
  assert.equal(databaseVersion(db), 21);
  assert.equal(db.isTransaction, false);
  migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 22));
  assert.equal(databaseVersion(db), 22);
  const after = databaseContents(db);
  assert.deepEqual(
    after.tables.filter(
      (table) =>
        !JOB_TABLES.includes(String(table.name) as (typeof JOB_TABLES)[number]),
    ),
    before.tables,
  );
  const schemaAfter = db
    .prepare(
      "SELECT name,type FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
    )
    .all();
  assert.equal(schemaAfter.length, 136);
  assert.ok(schemaAfter.length <= 160);
  assert.deepEqual(
    schemaAfter
      .filter((row) => !schemaBefore.some((old) => old.name === row.name))
      .map((row) => row.name),
    ["job_heads", "job_revisions"],
  );
  for (const table of JOB_TABLES) {
    const sql = String(
      db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(table)!.sql,
    );
    assert.match(sql, /STRICT/);
    assert.match(sql, /WITHOUT ROWID/);
    assert.throws(
      () => db.prepare(`SELECT rowid FROM ${table}`).get(),
      /no such column/,
    );
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0);
  }
  const fks = db.prepare("PRAGMA foreign_key_list(job_revisions)").all();
  for (const [from, table] of [
    ["workspace_id", "workspaces"],
    ["session_id", "sessions"],
    ["input_id", "session_inputs"],
    ["previous_id", "job_revisions"],
  ])
    assert.ok(fks.some((row) => row.from === from && row.table === table));
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  validateJobDatabase(db);
  migrateDatabase(db);
  assert.deepEqual(databaseContents(db), after);
});

test(
  "actual completed user PTY job archive includes native history and imports paused without restoring an observer or waking a provider",
  { skip: !["darwin", "linux", "freebsd"].includes(process.platform) },
  async (t) => {
    const f = await jobFixture(t),
      attached = f.attach();
    await f.finish();
    const settled = jobInvoke<JobRequestResult<CommandJob>>(
      f.engine,
      "settleTerminalJob",
      attached.original,
      {
        workspaceId: f.workspace.id,
        jobId: attached.result.record.jobId,
        requestId: "archive-settle",
        expectedRevision: 1,
      },
    );
    assert.equal(settled.record.state, "completed");
    assert.equal(settled.record.outcome!.cleanupConfirmed, true);
    const originalRows = f.rows("job_revisions");
    assert.equal(f.providerCalls.length, 0);
    await f.engine.close();
    const archive = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "job-native-archive"),
    });
    assert.equal(
      archive.manifest.databases.find((row) => row.role === "primary")!
        .schemaVersion,
      22,
    );
    const verified = validateEngineArchive({ directory: archive.directory });
    assert.equal(verified.manifestSha256, archive.manifestSha256);
    const imported = await importEngineArchive({
      directory: archive.directory,
      destination: join(f.base, "job-native-import"),
    });
    assert.equal(imported.executionResumed, false);
    assert.equal(imported.schemaVersion, 22);
    const db = new DatabaseSync(imported.dbPath, { readOnly: true });
    try {
      validateJobDatabase(db);
      const rows = db.prepare("SELECT * FROM job_revisions").all();
      for (const row of originalRows)
        assert.deepEqual(
          rows.find((current) => current.id === row.id),
          row,
        );
      assert.equal(
        db.prepare("SELECT count(*) n FROM session_inputs").get()!.n,
        0,
      );
    } finally {
      db.close();
    }
    const engine = createEngine({
      ...f.configuration,
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
      jobs: false,
    });
    f.engines.add(engine);
    const historical = jobInvoke<CommandJob>(
      engine,
      "getCommandJob",
      f.workspace.id,
      settled.record.jobId,
    );
    assert.equal(historical.state, "paused-import");
    assert.deepEqual(
      JSON.parse(JSON.stringify(historical.outcome)),
      settled.record.outcome,
    );
    assert.equal(engine.store.getSessionControl(f.session.id).paused, true);
    assert.equal(engine.store.hasUncertainWorkspace(f.workspace.id), false);
    await engine.waitForSession(f.session.id);
    assert.equal(f.providerCalls.length, 0);
    assert.throws(() =>
      jobInvoke(engine, "captureTerminalJob", {
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        terminalId: f.terminal!.id,
      }),
    );
    assert.equal(engine.store.getSnapshot(f.session.id).runs.length, 0);
    const corrupt = new DatabaseSync(f.dbPath);
    try {
      const old = settled.record,
        forged = signJobData({
          ...old,
          outcome: signJobData({
            ...old.outcome!,
            reason: "changed_without_original_close",
          }),
        });
      const receipt = JSON.parse(
        String(
          corrupt
            .prepare("SELECT data FROM job_revisions WHERE id=?")
            .get(old.lastReceiptId)!.data,
        ),
      );
      const changedReceipt = signJobData({
        ...receipt,
        afterSha256: forged.sha256,
      });
      corrupt
        .prepare("UPDATE job_revisions SET data=?,sha256=? WHERE id=?")
        .run(JSON.stringify(forged), forged.sha256, old.id);
      corrupt
        .prepare("UPDATE job_revisions SET data=?,sha256=? WHERE id=?")
        .run(
          JSON.stringify(changedReceipt),
          changedReceipt.sha256,
          changedReceipt.id,
        );
      corrupt
        .prepare("UPDATE job_heads SET sha256=? WHERE revision_id=?")
        .run(forged.sha256, old.id);
    } finally {
      corrupt.close();
    }
    await assert.rejects(
      exportEngineArchive({
        dbPath: f.dbPath,
        artifactDir: f.artifactDir,
        destination: join(f.base, "forged-job-archive"),
      }),
      (error) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "ARCHIVE_JOB_INVALID",
    );
    assert.equal(f.providerCalls.length, 0);
  },
);
