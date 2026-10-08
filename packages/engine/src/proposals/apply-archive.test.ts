import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import { checkDatabase } from "../recovery/snapshot.js";
import { DB_VERSION } from "../storage/migrations.js";
import {
  exportEngineArchive,
  importEngineArchive,
  validateEngineArchive,
  type EngineArchiveResult,
} from "../storage/archive.js";
import { knowledgeHash } from "../knowledge/validation.js";
import type {
  ProposalApplyCheckpoint,
  ProposalApplyGuard,
  ProposalApplyHistory,
  ProposalApplyReceipt,
} from "./apply-types.js";
import type { ProposalSelection } from "./types.js";
import {
  AFTER,
  api,
  applyFixture,
  failure,
  nativeRows,
  sha,
} from "./fixtures/apply.js";

type Fixture = Awaited<ReturnType<typeof applyFixture>>;
function signed<T extends { readonly sha256: string }>(record: T): T {
  const { sha256, ...body } = record;
  return { ...body, sha256: knowledgeHash(body) } as T;
}
async function archiveFixture(t: Parameters<typeof applyFixture>[0]) {
  const f = await applyFixture(t),
    created = await f.stage(),
    preview = await f.preview(),
    result = await f.apply(preview, "archive-applied");
  const foreign = await f.stage({
    proposalId: "foreign-captured-set",
    changes: [
      {
        path: "untouched.txt",
        expectedHash: sha("Unrelated user bytes.\n"),
        content: "Foreign staged native body.\n",
      },
    ],
  });
  const rows = nativeRows(f.dbPath, [
    "proposal_apply_owners",
    "proposal_apply_checkpoints",
    "proposal_apply_receipts",
    "proposal_apply_execution_guards",
    "proposal_revisions",
    "proposal_blobs",
  ]);
  await f.engine.close();
  const archive = await exportEngineArchive({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
    destination: join(f.base, "archive"),
  });
  return { f, created, foreign, result, rows, archive };
}
function resign(
  archive: EngineArchiveResult,
  mutate: (db: DatabaseSync) => void,
) {
  const manifestPath = join(archive.directory, "data", "manifest.json"),
    manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as EngineArchiveResult["manifest"],
    primary = manifest.databases.find((member) => member.role === "primary")!,
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
  primary.sha256 = sha(bytes);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
async function rejectsArchive(f: Fixture, archive: EngineArchiveResult) {
  const destination = join(f.base, "rejected"),
    bytes = f.userBytes(),
    invalid = (error: unknown) =>
      error instanceof EngineError && error.code === "ARCHIVE_DATABASE_INVALID";
  assert.throws(
    () => validateEngineArchive({ directory: archive.directory }),
    invalid,
  );
  await assert.rejects(
    importEngineArchive({ directory: archive.directory, destination }),
    invalid,
  );
  assert.equal(existsSync(destination), false);
  assert.deepEqual(f.userBytes(), bytes);
  f.assertNoCoding();
}

test("actual completed host apply checkpoint, receipt and source blobs survive archive while imported head is paused and performs no file effects", async (t) => {
  const { f, created, result, rows, archive } = await archiveFixture(t);
  const imported = await importEngineArchive({
    directory: archive.directory,
    destination: join(f.base, "imported"),
  });
  assert.equal(imported.executionResumed, false);
  const before = f.userBytes();
  const reopened = createEngine({
    ...f.options,
    dbPath: imported.dbPath,
    artifactDir: imported.artifactDir,
    proposalApply: false,
  });
  f.engines.add(reopened);
  const history = api<ProposalApplyHistory>(
    reopened,
    "getProposalApply",
    f.workspace.id,
    result.owner.id,
  );
  assert.deepEqual(history, {
    owner: result.owner,
    checkpoint: result.checkpoint,
    receipt: result.receipt,
  });
  assert.deepEqual(
    nativeRows(imported.dbPath, [
      "proposal_apply_owners",
      "proposal_apply_checkpoints",
      "proposal_apply_receipts",
      "proposal_apply_execution_guards",
      "proposal_revisions",
      "proposal_blobs",
    ]),
    rows,
  );
  const selection = api<ProposalSelection>(
    reopened,
    "getProposalSet",
    f.workspace.id,
    created.set.id,
  );
  assert.equal(selection.set.status, "paused-import");
  assert.equal(selection.revision.sha256, created.revision.sha256);
  await assert.rejects(
    api<Promise<unknown>>(reopened, "previewProposalApply", {
      workspaceId: f.workspace.id,
      proposalId: created.set.id,
    }),
    failure(),
  );
  await reopened.close();
  const enabled = createEngine({
    ...f.options,
    dbPath: imported.dbPath,
    artifactDir: imported.artifactDir,
  });
  f.engines.add(enabled);
  await assert.rejects(
    api<Promise<unknown>>(enabled, "previewProposalApply", {
      workspaceId: f.workspace.id,
      proposalId: created.set.id,
    }),
    failure(),
  );
  assert.deepEqual(f.userBytes(), before);
  assert.equal(f.userBytes()["first.ts"], AFTER);
  f.assertNoCoding();
});

test("a resigned archive cannot promote a receipt with a forged checkpoint relationship", async (t) => {
  const { f, result, archive } = await archiveFixture(t);
  resign(archive, (db) => {
    const receipt = signed({
      ...result.receipt!,
      checkpointSha256: "a".repeat(64),
    }) as ProposalApplyReceipt;
    db.prepare("UPDATE proposal_apply_receipts SET data=? WHERE id=?").run(
      JSON.stringify(receipt),
      receipt.id,
    );
  });
  await rejectsArchive(f, archive);
});

test("a resigned archive cannot use an actual foreign revision blob as an apply checkpoint preimage", async (t) => {
  const { f, foreign, result, archive } = await archiveFixture(t),
    ref = foreign.revision.files[0]!.before;
  assert.ok(ref);
  resign(archive, (db) => {
    const files = result.checkpoint!.files.map((file, i) =>
        i === 0 ? { ...file, before: ref } : file,
      ),
      checkpoint = signed({
        ...result.checkpoint!,
        files,
      }) as ProposalApplyCheckpoint;
    db.prepare("UPDATE proposal_apply_checkpoints SET data=? WHERE id=?").run(
      JSON.stringify(checkpoint),
      checkpoint.id,
    );
  });
  await rejectsArchive(f, archive);
});

test("a resigned archive cannot reinterpret an original execution guard as another native apply owner", async (t) => {
  const { f, foreign, result, archive } = await archiveFixture(t);
  resign(archive, (db) => {
    const original = JSON.parse(
      String(
        db
          .prepare(
            "SELECT data FROM proposal_apply_execution_guards WHERE owner_id=?",
          )
          .get(result.owner.id)!.data,
      ),
    ) as ProposalApplyGuard;
    const changed = signed({ ...original, ownerId: foreign.revision.id });
    db.prepare(
      "UPDATE proposal_apply_execution_guards SET data=? WHERE id=?",
    ).run(JSON.stringify(changed), original.id);
  });
  await rejectsArchive(f, archive);
});

test("a resigned oversized apply owner fails archive validation before importer copies bytes or allocates an Engine producer", async (t) => {
  const { f, result, archive } = await archiveFixture(t);
  resign(archive, (db) => {
    const row = JSON.parse(
      String(
        db
          .prepare("SELECT data FROM proposal_apply_owners WHERE id=?")
          .get(result.owner.id)!.data,
      ),
    );
    row.requestId = "x".repeat(257);
    const changed = signed(row);
    db.prepare(
      "UPDATE proposal_apply_owners SET request_id=?,data=? WHERE id=?",
    ).run(changed.requestId, JSON.stringify(changed), result.owner.id);
  });
  await rejectsArchive(f, archive);
});
