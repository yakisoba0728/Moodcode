import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EngineError } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import type { ProviderAdapter, ProviderEvent } from "../ports.js";
import { checkDatabase } from "../recovery/snapshot.js";
import {
  exportEngineArchive,
  importEngineArchive,
  validateEngineArchive,
  type EngineArchiveResult,
} from "../storage/archive.js";
import { DB_VERSION } from "../storage/migrations.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { DIAGNOSTIC_EXECUTION_OBSERVATION_TABLES } from "./execution-observation-store.js";
import type {
  DiagnosticExecutionObservation,
  DiagnosticEffectEpoch,
  DiagnosticExecutionPage,
} from "./execution-observation-types.js";
import {
  digest,
  invoke,
  observationFixture,
  stop,
} from "./fixtures/execution-observation.js";

function rows(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(
      DIAGNOSTIC_EXECUTION_OBSERVATION_TABLES.map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}
async function produced(t: TestContext) {
  const f = await observationFixture(t, {
      script: async function* (request): AsyncGenerator<ProviderEvent> {
        if (request.turnIndex === 0) {
          yield {
            type: "tool.call",
            call: {
              id: "independent-archive-read",
              name: "read_file",
              input: { path: "source.ts" },
            },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else yield stop;
      },
    }),
    receipt = await f.submit(),
    run = await f.engine.waitForRun(receipt.runId);
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.equal(f.page(run.id).items.length, 1);
  const receipt2 = await f.submit(),
    run2 = await f.engine.waitForRun(receipt2.runId);
  assert.equal(run2.state, "completed");
  assert.equal(f.page(run2.id).items.length, 1);
  await f.engine.close();
  const archive = await exportEngineArchive({
    dbPath: f.dbPath,
    artifactDir: join(f.base, "artifacts"),
    destination: join(f.base, "archive"),
  });
  return { ...f, run, run2, archive };
}
/** Only a produced clone is corrupted; all file/database digests are then independently refreshed. */
function resign(
  archive: EngineArchiveResult,
  mutate: (db: DatabaseSync) => void,
) {
  const manifest = JSON.parse(
      readFileSync(join(archive.directory, "data", "manifest.json"), "utf8"),
    ) as EngineArchiveResult["manifest"],
    primary = manifest.databases.find((member) => member.role === "primary")!,
    path = join(archive.directory, "data", primary.file),
    db = new DatabaseSync(path);
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
  const bytes = readFileSync(path);
  primary.bytes = bytes.length;
  primary.sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(
    join(archive.directory, "data", "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}
function first(db: DatabaseSync) {
  const raw = db
    .prepare(
      "SELECT * FROM diagnostic_execution_observations ORDER BY ordinal LIMIT 1",
    )
    .get()!;
  return {
    raw,
    record: JSON.parse(String(raw.data)) as DiagnosticExecutionObservation,
  };
}
function rehash<T extends { sha256: string }>(value: T): T {
  const { sha256: ignored, ...body } = value;
  return { ...body, sha256: knowledgeHash(body) } as T;
}
const invalid = (error: unknown) =>
  error instanceof EngineError &&
  error.code === "ARCHIVE_EXECUTION_OBSERVATION_INVALID";

test("actual native observations survive current-schema archive/import exactly and imported paused history invokes no producer", async (t) => {
  const f = await produced(t),
    original = rows(f.dbPath),
    primary = f.archive.manifest.databases.find(
      (member) => member.role === "primary",
    )!;
  assert.equal(primary.schemaVersion, DB_VERSION);
  assert.ok(DB_VERSION >= 14);
  const validation = await validateEngineArchive({
    directory: f.archive.directory,
  });
  assert.equal(validation.manifestSha256, f.archive.manifestSha256);
  const imported = await importEngineArchive({
    directory: f.archive.directory,
    destination: join(f.base, "imported"),
  });
  assert.equal(imported.executionResumed, false);
  assert.equal(imported.manifest.recoveryAcknowledgmentsRebound, false);
  assert.equal(imported.sessionsPaused, 1);
  assert.deepEqual(rows(imported.dbPath), original);
  let producers = 0;
  const provider: ProviderAdapter = {
    id: "actual-execution-observation",
    async *streamTurn() {
      producers++;
      throw new Error("Historical observations cannot execute providers");
    },
  };
  const current = createEngine({
    dbPath: imported.dbPath,
    artifactDir: imported.artifactDir,
    providers: [provider],
    diagnosticObservations: true,
  });
  try {
    const page = invoke<DiagnosticExecutionPage>(
      current,
      "getExecutionObservations",
      { workspaceId: f.workspace.id, runId: f.run.id },
    );
    assert.deepEqual(
      page.items,
      original
        .diagnostic_execution_observations!.filter(
          (row) => row.run_id === f.run.id,
        )
        .map((row) => JSON.parse(String(row.data))),
    );
    assert.equal(current.store.getSessionControl(f.session.id).paused, true);
    assert.equal(
      current.workspaceKnowledge.isImportPaused(f.workspace.id),
      true,
    );
    assert.equal(producers, 0);
    assert.deepEqual(rows(imported.dbPath), original);
  } finally {
    await current.close();
  }
});
test("resigned diagnostic SQL metadata corruption cannot select another actual native Run", async (t) => {
  const f = await produced(t);
  resign(f.archive, (db) => {
    const { record } = first(db);
    db.prepare(
      "UPDATE diagnostic_execution_observations SET run_id=? WHERE id=?",
    ).run(f.run2.id, record.id);
  });
  assert.throws(
    () => validateEngineArchive({ directory: f.archive.directory }),
    invalid,
  );
});
test("resigned diagnostic owner body and SQL scope cannot rebind an existing foreign Run tuple", async (t) => {
  const f = await produced(t);
  resign(f.archive, (db) => {
    const { record } = first(db),
      changed = rehash({ ...record, runId: f.run2.id });
    db.prepare(
      "UPDATE diagnostic_execution_observations SET run_id=?,data=? WHERE id=?",
    ).run(f.run2.id, JSON.stringify(changed), record.id);
  });
  assert.throws(
    () => validateEngineArchive({ directory: f.archive.directory }),
    invalid,
  );
});
test("resigned native result digest cannot replace the actual durably completed tool output", async (t) => {
  const f = await produced(t);
  resign(f.archive, (db) => {
    const { record } = first(db),
      changed = rehash({
        ...record,
        resultSha256: digest("fabricated output"),
      });
    db.prepare(
      "UPDATE diagnostic_execution_observations SET data=? WHERE id=?",
    ).run(JSON.stringify(changed), record.id);
  });
  await assert.rejects(
    importEngineArchive({
      directory: f.archive.directory,
      destination: join(f.base, "reject-result"),
    }),
    invalid,
  );
  assert.equal(existsSync(join(f.base, "reject-result")), false);
});
test("resigned monotonic effect frontier cannot claim an unobserved physical producer dispatch", async (t) => {
  const f = await produced(t);
  resign(f.archive, (db) => {
    const value = JSON.parse(
        String(
          db.prepare("SELECT data FROM diagnostic_effect_epochs").get()!.data,
        ),
      ) as DiagnosticEffectEpoch,
      changed = rehash({ ...value, epoch: value.epoch + 1 });
    db.prepare(
      "UPDATE diagnostic_effect_epochs SET epoch=?,data=? WHERE workspace_id=?",
    ).run(changed.epoch, JSON.stringify(changed), changed.workspaceId);
  });
  assert.throws(
    () => validateEngineArchive({ directory: f.archive.directory }),
    invalid,
  );
});
test("resigned source snapshot coverage cannot preserve an invented hash as unknown coverage", async (t) => {
  const f = await produced(t);
  resign(f.archive, (db) => {
    const { record } = first(db),
      changed = rehash({
        ...record,
        sourceBefore: {
          ...record.sourceBefore,
          completeness: "unknown" as const,
        },
      });
    db.prepare(
      "UPDATE diagnostic_execution_observations SET data=? WHERE id=?",
    ).run(JSON.stringify(changed), record.id);
  });
  assert.throws(
    () => validateEngineArchive({ directory: f.archive.directory }),
    invalid,
  );
});
