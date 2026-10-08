import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { createEngine, type EngineOptions } from "../engine.js";
import {
  exportEngineArchive,
  importEngineArchive,
  validateEngineArchive,
  type EngineArchiveResult,
} from "../storage/archive.js";
import { DB_VERSION } from "../storage/migrations.js";
import { checkDatabase } from "../recovery/snapshot.js";
import { knowledgeHash } from "../knowledge/validation.js";
import type { WorkflowInstanceRevision } from "./reducer.js";
import {
  childStorageKind,
  type ChildStorageRecord,
} from "../child-tasks/storage-binding.js";
import {
  invoke,
  readDatabase,
  workflowArchiveFixture,
} from "./fixtures/archive-workflow.js";

async function complete(t: test.TestContext) {
  const f = await workflowArchiveFixture(t),
    started = await f.start(),
    admitted = await f.stage(started.created.record),
    completed = await f.settle(admitted.record);
  assert.equal(completed.record.state, "completed");
  assert.equal(completed.record.stages[0]!.state, "completed");
  const stageChild = completed.record.stages[0]!.child!;
  const childStorage = f.engine.store.getSessionDocument(
    f.session.id,
    childStorageKind(stageChild.taskId),
  )!.data as unknown as ChildStorageRecord;
  assert.equal(childStorage.confirmedClose?.bindingSha256, childStorage.sha256);
  const proofCopy = join(f.base, "closed-child-proof.sqlite");
  copyFileSync(childStorage.binding.physical.database.path, proofCopy);
  const childTools = readDatabase(proofCopy, (db) =>
    db.prepare("SELECT data FROM tools ORDER BY ordinal").all(),
  );
  assert.equal(childTools.length, 1);
  const read = JSON.parse(String(childTools[0]!.data)) as Record<
    string,
    unknown
  >;
  assert.equal(read.name, "read_file");
  assert.equal(read.state, "completed");
  assert.equal(
    readFileSync(join(f.worktree.root, "seed.txt"), "utf8"),
    "Actual committed workflow source.\n",
  );
  assert.equal(
    execFileSync("git", ["-C", f.worktree.root, "status", "--porcelain"], {
      encoding: "utf8",
    }),
    "",
  );
  f.parentRelease.resolve();
  await f.engine.waitForRun(started.parent.runId);
  await f.engine.close();
  const rows = readDatabase(f.dbPath, (db) =>
    db.prepare("SELECT * FROM workflow_revisions ORDER BY id").all(),
  );
  const archive = await exportEngineArchive({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
    destination: join(f.base, "archive"),
  });
  return { f, started, admitted, completed, rows, archive };
}
function resign(
  archive: EngineArchiveResult,
  mutate: (db: DatabaseSync) => void,
) {
  const manifestPath = join(archive.directory, "data/manifest.json"),
    manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as EngineArchiveResult["manifest"],
    primary = manifest.databases.find((item) => item.role === "primary")!,
    file = join(archive.directory, "data", primary.file),
    db = new DatabaseSync(file);
  try {
    mutate(db);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'",
      )
      .all()
      .map((row) => String(row.name));
    primary.logicalHash = checkDatabase(db, DB_VERSION, tables, () => {});
  } finally {
    db.close();
  }
  const bytes = readFileSync(file);
  primary.bytes = bytes.length;
  primary.sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

test("actual completed readonly workflow archives immutable native history and imports paused without restoring execution authority", async (t) => {
  const { f, completed, rows, archive } = await complete(t),
    before = f.providerEntries();
  const imported = await importEngineArchive({
    directory: archive.directory,
    destination: join(f.base, "imported"),
  });
  assert.equal(imported.schemaVersion, DB_VERSION);
  assert.equal(imported.executionResumed, false);
  assert.equal(imported.documentAuditCoverage, "complete");
  assert.ok(imported.childSessionsPaused > 0);
  for (const enabled of [false, true]) {
    const engine = createEngine({
      ...f.configuration,
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
      workflows: enabled,
    } as EngineOptions);
    f.engines.add(engine);
    const history = invoke<WorkflowInstanceRevision>(
      engine,
      "inspectWorkflow",
      f.workspace.id,
      completed.record.instanceId,
    );
    assert.equal(history.state, "paused-import");
    assert.equal(history.owner.sha256, completed.record.owner.sha256);
    assert.deepEqual(history.stages, completed.record.stages);
    const actual = readDatabase(imported.dbPath, (db) =>
      db.prepare("SELECT * FROM workflow_revisions ORDER BY id").all(),
    );
    for (const row of rows)
      assert.deepEqual(
        actual.find((item) => item.id === row.id),
        row,
      );
    await assert.rejects(
      async () =>
        invoke<Promise<unknown>>(engine, "startWorkflowStage", {
          workspaceId: f.workspace.id,
          instanceId: history.instanceId,
          stageId: "plan",
          requestId: "no-imported-wake",
          expectedRevision: history.revision,
          approved: true,
        }),
      (error) => error instanceof EngineError,
    );
    assert.equal(f.providerEntries(), before);
    await engine.close();
  }
});

test("re-signed archive with a transition pointing to a false immutable after hash is rejected before import destination creation", async (t) => {
  const { f, archive } = await complete(t);
  resign(archive, (db) => {
    const row = db
      .prepare(
        "SELECT * FROM workflow_revisions WHERE kind='transition' AND json_extract(data,'$.operation')='settle' ORDER BY id LIMIT 1",
      )
      .get();
    assert.ok(row);
    const record = JSON.parse(String(row.data)) as Record<string, unknown>;
    record.afterSha256 = "f".repeat(64);
    const { sha256: _old, ...body } = record;
    record.sha256 = knowledgeHash(body);
    db.prepare("UPDATE workflow_revisions SET sha256=?,data=? WHERE id=?").run(
      String(record.sha256),
      JSON.stringify(record),
      String(row.id),
    );
  });
  const invalid = (error: unknown) =>
    error instanceof EngineError && error.code === "ARCHIVE_WORKFLOW_INVALID";
  assert.throws(
    () => validateEngineArchive({ directory: archive.directory }),
    invalid,
  );
  const destination = join(f.base, "invalid-import");
  await assert.rejects(
    importEngineArchive({ directory: archive.directory, destination }),
    invalid,
  );
  assert.equal(existsSync(destination), false);
});
