import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createEngine } from "../engine.js";
import type { ProviderAdapter } from "../ports.js";
import { checkDatabase } from "../recovery/snapshot.js";
import {
  exportEngineArchive,
  importEngineArchive,
  validateEngineArchive,
} from "../storage/archive.js";
import { DB_VERSION } from "../storage/migrations.js";
import {
  KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE,
  validateKnowledgeFileExecutionGuards,
} from "./file-execution-guards.js";
import {
  KNOWLEDGE_FILE_PUBLICATION_TABLES,
  validateKnowledgeFilePublicationArchiveRow,
  validateKnowledgeFilePublicationDatabase,
} from "./file-publication-store.js";
import type { KnowledgeFilePublicationReceipt } from "./file-publication-types.js";
import {
  BODY,
  TARGET,
  failure,
  filePublicationFixture,
} from "./fixtures/file-publication.js";
import { knowledgeHash } from "./validation.js";

const historicalTables = [
  ...KNOWLEDGE_FILE_PUBLICATION_TABLES,
  KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE,
  "knowledge_generations",
  "knowledge_generation_attempts",
  "knowledge_candidates",
];
function history(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(
      historicalTables.map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}
function logicalHash(db: DatabaseSync): string {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'",
    )
    .all()
    .map((row) => String(row.name));
  assert.ok(tables.includes(KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE));
  return checkDatabase(db, DB_VERSION, tables, () => {});
}

test("DB13 actual completed file archive retains historical evidence without producer or physical replay, and imported knowledge remains paused", async (t) => {
  const f = await filePublicationFixture(t),
    candidate = await f.candidate();
  const result = await f.publish(
      await f.preview(candidate),
      "archive-file-publish",
    ),
    original = f.engine.getWorkspaceKnowledgeFilePublication(
      f.workspace.id,
      result.publication.id,
    ),
    target = f.engine.getWorkspaceKnowledgeFileTarget(f.workspace.id, TARGET);
  assert.ok(original);
  assert.equal(original.state, "completed");
  assert.equal(readFileSync(join(f.root, TARGET), "utf8"), BODY);
  assert.ok(target?.observation.present);
  f.assertNoCoding();
  await f.engine.close();
  f.retireClosed();
  const before = history(f.dbPath),
    archive = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: join(f.base, "artifacts"),
      destination: join(f.base, "archive"),
    });
  const primary = archive.manifest.databases.find(
    (item) => item.role === "primary",
  )!;
  assert.equal(primary.schemaVersion, DB_VERSION);
  assert.ok(primary.schemaVersion >= 13);
  validateEngineArchive({ directory: archive.directory });
  const archived = new DatabaseSync(
    join(archive.directory, "data", primary.file),
    { readOnly: true },
  );
  try {
    assert.equal(logicalHash(archived), primary.logicalHash);
    assert.equal(
      archived
        .prepare(
          `SELECT count(*) AS count FROM ${KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE}`,
        )
        .get()?.count,
      1,
    );
  } finally {
    archived.close();
  }
  // This changes the real external workspace only after the original completed archive.
  // Import must retain historical postimage facts, not replay the write to repair it.
  unlinkSync(join(f.root, TARGET));
  const imported = await importEngineArchive({
    directory: archive.directory,
    destination: join(f.base, "imported"),
  });
  let generationCalls = 0,
    codingCalls = 0;
  const provider: ProviderAdapter = {
    id: candidate.providerId,
    async *streamTurn() {
      codingCalls++;
      throw new Error("Imported history cannot invoke coding");
    },
    streamGeneration() {
      generationCalls++;
      throw new Error("Imported history cannot replay generation");
    },
  };
  const current = createEngine({
    dbPath: imported.dbPath,
    artifactDir: imported.artifactDir,
    providers: [provider],
    knowledgeGeneration: true,
    knowledgeFilePublication: true,
  });
  try {
    assert.equal(imported.executionResumed, false);
    assert.equal(
      current.workspaceKnowledge.getImportPause(f.workspace.id)?.state,
      "paused",
    );
    assert.deepEqual(
      current.getWorkspaceKnowledgeFilePublication(f.workspace.id, original.id),
      original,
    );
    assert.deepEqual(
      current.getWorkspaceKnowledgeFilePublicationReceipt(
        f.workspace.id,
        original.requestId,
      ),
      result.receipt,
    );
    assert.deepEqual(
      current.getWorkspaceKnowledgeFileTarget(f.workspace.id, TARGET),
      target,
    );
    assert.deepEqual(history(imported.dbPath), before);
    await assert.rejects(
      current.previewWorkspaceKnowledgeFilePublication({
        workspaceId: f.workspace.id,
        candidateId: candidate.id,
      }),
      failure("KNOWLEDGE_BINDING_MISMATCH"),
    );
    const projection = current.captureWorkspaceKnowledgeSources(
        f.workspace.id,
        [{ kind: "file", path: "origin.ts" }],
      ),
      logical = current.previewWorkspaceKnowledgeGeneration({
        providerId: provider.id,
        modelId: "fixture-model",
        projection,
      });
    await assert.rejects(
      current.prepareWorkspaceKnowledgeGeneration({
        workspaceId: f.workspace.id,
        requestId: "import-must-not-generate",
        expectedTrustRevision: current.workspaceKnowledge.getTrust(
          f.workspace.id,
        )!.revision,
        projection,
        target: current.captureWorkspaceKnowledgeTarget(
          f.workspace.id,
          "import-blocked.md",
        ),
        providerId: provider.id,
        modelId: "fixture-model",
        requestSha256: logical.requestSha256,
        requestBytes: logical.requestBytes,
        maxOutputBytes: 1024,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      }),
      failure("KNOWLEDGE_IMPORT_PAUSED"),
    );
    assert.equal(existsSync(join(f.root, TARGET)), false);
    assert.equal(generationCalls, 0);
    assert.equal(codingCalls, 0);
    assert.equal(f.generations.length, 1);
  } finally {
    await current.close();
  }
});

test("DB13 actual file revoke archives a positive absent target and both exact historical receipts; guard rows participate in the database logical hash", async (t) => {
  const f = await filePublicationFixture(t),
    candidate = await f.candidate(),
    published = await f.publish(await f.preview(candidate), "archive-publish"),
    revoked = await f.revoke(
      await f.revokePreview(published.publication.id),
      "archive-revoke",
    ),
    owners = [published, revoked].map((value) =>
      f.engine.getWorkspaceKnowledgeFilePublication(
        f.workspace.id,
        value.publication.id,
      ),
    ),
    target = f.engine.getWorkspaceKnowledgeFileTarget(f.workspace.id, TARGET)!;
  assert.ok(target.revision > 0);
  assert.equal(target.observation.present, false);
  assert.equal(existsSync(join(f.root, TARGET)), false);
  f.assertNoCoding();
  await f.engine.close();
  f.retireClosed();
  const archive = await exportEngineArchive({
    dbPath: f.dbPath,
    artifactDir: join(f.base, "artifacts"),
    destination: join(f.base, "revoked-archive"),
  });
  validateEngineArchive({ directory: archive.directory });
  const imported = await importEngineArchive({
      directory: archive.directory,
      destination: join(f.base, "revoked-import"),
    }),
    current = createEngine({
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
      knowledgeFilePublication: true,
    });
  try {
    for (const [index, result] of [published, revoked].entries()) {
      assert.deepEqual(
        current.getWorkspaceKnowledgeFilePublication(
          f.workspace.id,
          result.publication.id,
        ),
        owners[index],
      );
      assert.deepEqual(
        current.getWorkspaceKnowledgeFilePublicationReceipt(
          f.workspace.id,
          owners[index]!.requestId,
        ),
        result.receipt,
      );
    }
    assert.deepEqual(
      current.getWorkspaceKnowledgeFileTarget(f.workspace.id, TARGET),
      target,
    );
    assert.equal(
      current.workspaceKnowledge.getImportPause(f.workspace.id)?.state,
      "paused",
    );
    assert.deepEqual(history(imported.dbPath), history(f.dbPath));
    assert.equal(existsSync(join(f.root, TARGET)), false);
    assert.equal(f.generations.length, 1);
  } finally {
    await current.close();
  }
  const db = new DatabaseSync(imported.dbPath);
  try {
    const before = logicalHash(db);
    assert.equal(
      db
        .prepare(
          `SELECT count(*) AS count FROM ${KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE}`,
        )
        .get()?.count,
      2,
    );
    // Negative corruption of an already produced clone only proves hash coverage.
    db.exec(`DELETE FROM ${KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE}`);
    assert.notEqual(logicalHash(db), before);
  } finally {
    db.close();
  }
});

test("an individually rehashed file receipt cannot substitute a different actual target revision in the completed native graph", async (t) => {
  const f = await filePublicationFixture(t),
    candidate = await f.candidate(),
    published = await f.publish(await f.preview(candidate), "receipt-publish"),
    revoked = await f.revoke(
      await f.revokePreview(published.publication.id),
      "receipt-revoke",
    );
  await f.engine.close();
  f.retireClosed();
  const db = new DatabaseSync(f.dbPath);
  try {
    validateKnowledgeFilePublicationDatabase(db);
    const row = db
      .prepare(
        "SELECT data FROM knowledge_file_publication_receipts WHERE id=?",
      )
      .get(revoked.receipt.id)!;
    const original = JSON.parse(
        String(row.data),
      ) as KnowledgeFilePublicationReceipt,
      earlier = db
        .prepare(
          "SELECT target_revision_id FROM knowledge_file_publication_receipts WHERE id=?",
        )
        .get(published.receipt.id)!;
    assert.equal(typeof earlier.target_revision_id, "string");
    const { sha256: _old, ...body } = original,
      changed = {
        ...body,
        targetRevisionId: earlier.target_revision_id as string,
      },
      tampered = { ...changed, sha256: knowledgeHash(changed) };
    validateKnowledgeFilePublicationArchiveRow({
      table: "knowledge_file_publication_receipts",
      key: tampered.id,
      workspaceId: f.workspace.id,
      data: tampered,
    });
    db.prepare(
      "UPDATE knowledge_file_publication_receipts SET target_revision_id=?,data=? WHERE id=?",
    ).run(tampered.targetRevisionId, JSON.stringify(tampered), tampered.id);
    assert.throws(
      () => validateKnowledgeFilePublicationDatabase(db),
      failure("KNOWLEDGE_FILE_EVIDENCE_INVALID"),
    );
  } finally {
    db.close();
  }
  const destination = join(f.base, "invalid-receipt");
  await assert.rejects(
    exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: join(f.base, "artifacts"),
      destination,
    }),
    failure("ARCHIVE_KNOWLEDGE_INVALID"),
  );
  assert.equal(existsSync(destination), false);
  assert.equal(f.generations.length, 1);
});

test("self-consistent execution guard JSON cannot replace the actual owner's historical storage binding", async (t) => {
  const f = await filePublicationFixture(t),
    candidate = await f.candidate();
  await f.publish(await f.preview(candidate), "guard-binding");
  await f.engine.close();
  f.retireClosed();
  const db = new DatabaseSync(f.dbPath);
  try {
    validateKnowledgeFileExecutionGuards(db);
    const row = db
        .prepare(`SELECT id,data FROM ${KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE}`)
        .get()!,
      original = JSON.parse(String(row.data)) as {
        sha256: string;
        binding: Record<string, unknown>;
      };
    const { sha256: _old, ...body } = original,
      changed = {
        ...body,
        binding: { ...body.binding, storageBindingSha256: "a".repeat(64) },
      },
      tampered = { ...changed, sha256: knowledgeHash(changed) };
    db.prepare(
      `UPDATE ${KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE} SET data=? WHERE id=?`,
    ).run(JSON.stringify(tampered), String(row.id));
    assert.throws(
      () => validateKnowledgeFileExecutionGuards(db),
      failure("KNOWLEDGE_FILE_GUARD_INVALID"),
    );
  } finally {
    db.close();
  }
  const destination = join(f.base, "invalid-guard-binding");
  await assert.rejects(
    exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: join(f.base, "artifacts"),
      destination,
    }),
    failure("ARCHIVE_KNOWLEDGE_INVALID"),
  );
  assert.equal(existsSync(destination), false);
  assert.equal(f.generations.length, 1);
});
