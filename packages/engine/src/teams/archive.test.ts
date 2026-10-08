import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { nativeTeam } from "./fixtures/native-team.js";
import { failure, readDatabase } from "./fixtures/engine-team.js";
import type { TeamDeliveryReceipt } from "./types.js";
const sha = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
async function archiveFixture(t: Parameters<typeof nativeTeam>[0]) {
  const f = await nativeTeam(t),
    { member, task } = await f.child(),
    message = f.send(
      member.memberId,
      member.generation,
      "Actual immutable archived team message.",
    ),
    page = f.read(member.memberId, member.generation),
    delivery = f.engine.resumeChildTurn({
      workspaceId: f.workspace.id,
      requestId: "archive-native-delivery",
      approved: true,
      page,
      expectedCursorRevision: page.cursor.revision,
    });
  f.childRelease.resolve();
  await f.engine.children.tasks.wait(f.session.id, task.id);
  f.parentRelease.resolve();
  await f.engine.waitForRun(f.parent.runId);
  await f.engine.close();
  const rows = readDatabase(f.dbPath, (db) =>
      Object.fromEntries(
        [
          "team_state_revisions",
          "team_messages",
          "team_operation_receipts",
          "team_deliveries",
          "team_delivery_receipts",
        ].map((table) => [
          table,
          db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
        ]),
      ),
    ),
    archive = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "archive"),
    });
  return { f, member, message, delivery, rows, archive };
}
function resign(
  archive: EngineArchiveResult,
  mutate: (db: DatabaseSync) => void,
) {
  const manifestPath = join(archive.directory, "data", "manifest.json"),
    manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as EngineArchiveResult["manifest"],
    primary = manifest.databases.find((v) => v.role === "primary")!,
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
function signed<T extends { sha256: string }>(value: T): T {
  const { sha256, ...body } = value;
  return { ...body, sha256: knowledgeHash(body) } as T;
}
async function rejects(archive: EngineArchiveResult, destination: string) {
  const invalid = (error: unknown) =>
    error instanceof EngineError && error.code === "ARCHIVE_TEAM_INVALID";
  assert.throws(
    () => validateEngineArchive({ directory: archive.directory }),
    invalid,
  );
  await assert.rejects(
    importEngineArchive({ directory: archive.directory, destination }),
    invalid,
  );
  assert.equal(existsSync(destination), false);
}

test("actual DB18 team history survives audited child archive/import immutably while team head is paused and opt-in cannot rebind foreign live authority", async (t) => {
  const { f, member, delivery, rows, archive } = await archiveFixture(t),
    imported = await importEngineArchive({
      directory: archive.directory,
      destination: join(f.base, "imported"),
    }),
    calls = f.requests.length;
  assert.equal(imported.schemaVersion, DB_VERSION);
  assert.equal(imported.executionResumed, false);
  assert.equal(imported.documentAuditCoverage, "complete");
  assert.ok(imported.childSessionsPaused > 0);
  for (const enabled of [false, true]) {
    const engine = createEngine({
      ...f.configuration,
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
      teams: enabled,
    });
    f.engines.add(engine);
    assert.equal(
      engine.getTeam(f.workspace.id, f.created.record.id)?.status,
      "paused-import",
    );
    assert.deepEqual(
      engine.getTeamMember(
        f.workspace.id,
        f.created.record.id,
        member.memberId,
      ),
      member,
    );
    assert.deepEqual(
      engine.getTeamDelivery(f.workspace.id, delivery.record.id),
      { record: delivery.record, receipt: delivery.receipt },
    );
    const actual = readDatabase(imported.dbPath, (db) =>
      Object.fromEntries(
        Object.keys(rows).map((table) => [
          table,
          db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
        ]),
      ),
    );
    for (const [table, old] of Object.entries(rows)) {
      if (table === "team_state_revisions")
        for (const row of old)
          assert.deepEqual(
            actual[table]!.find((v) => v.id === row.id),
            row,
          );
      else assert.deepEqual(actual[table], old);
    }
    assert.throws(
      () =>
        engine.previewTeamMember({
          workspaceId: f.workspace.id,
          teamId: f.created.record.id,
          memberId: "no-imported-authority",
          expectedRevision: 0,
          role: "worker",
          permissions: {
            send: true,
            receive: true,
            claimTasks: true,
            manageTasks: false,
          },
          expiresAt: f.expiresAt,
          rootSessionId: f.session.id,
        }),
      failure(enabled ? "TEAM_INACTIVE" : "TEAMS_DISABLED"),
    );
    assert.throws(
      () =>
        engine.readAgentMailbox({
          workspaceId: f.workspace.id,
          teamId: f.created.record.id,
          memberId: member.memberId,
          generation: member.generation,
        }),
      failure(enabled ? "TEAM_OWNER_UNAVAILABLE" : "TEAMS_DISABLED"),
    );
    await engine.close();
    assert.equal(f.requests.length, calls);
  }
});

test("resigned archive rejects delivered receipt with recomputed hash but foreign native child input owner tuple", async (t) => {
  const { f, delivery, archive } = await archiveFixture(t);
  resign(archive, (db) => {
    const row = db
        .prepare("SELECT data FROM team_delivery_receipts WHERE id=?")
        .get(delivery.record.id)!,
      receipt = JSON.parse(String(row.data)) as TeamDeliveryReceipt,
      forged = signed({
        ...receipt,
        input: { ...receipt.input, runId: f.parent.runId },
      });
    db.prepare("UPDATE team_delivery_receipts SET data=? WHERE id=?").run(
      JSON.stringify(forged),
      receipt.id,
    );
  });
  await rejects(archive, join(f.base, "rejected-foreign-owner"));
});

test("resigned archive rejects message claimed cursor beyond actual admitted frontier despite a valid recomputed cursor hash", async (t) => {
  const { f, member, archive } = await archiveFixture(t);
  resign(archive, (db) => {
    const row = db
        .prepare(
          "SELECT data FROM team_mailbox_cursors WHERE team_id=? AND member_id=? AND generation=?",
        )
        .get(f.created.record.id, member.memberId, member.generation)!,
      cursor = JSON.parse(String(row.data)) as {
        admittedSeq: number;
        claimedSeq: number;
        sha256: string;
      },
      forged = signed({
        ...cursor,
        admittedSeq: cursor.admittedSeq + 1,
        claimedSeq: cursor.admittedSeq + 1,
      });
    db.prepare(
      "UPDATE team_mailbox_cursors SET admitted_seq=?,claimed_seq=?,data=? WHERE team_id=? AND member_id=? AND generation=?",
    ).run(
      forged.admittedSeq,
      forged.claimedSeq,
      JSON.stringify(forged),
      f.created.record.id,
      member.memberId,
      member.generation,
    );
  });
  await rejects(archive, join(f.base, "rejected-cursor"));
});

test("resigned archive rejects orphan native send receipt signed against another existing team record", async (t) => {
  const { f, message, archive } = await archiveFixture(t);
  resign(archive, (db) => {
    const row = db
        .prepare("SELECT data FROM team_operation_receipts WHERE id=?")
        .get(message.receipt.id)!,
      receipt = JSON.parse(String(row.data)) as {
        id: string;
        recordId: string;
        recordSha256: string;
        sha256: string;
      },
      forged = signed({
        ...receipt,
        recordId: f.coordinator.id,
        recordSha256: f.coordinator.sha256,
      });
    db.prepare(
      "UPDATE team_operation_receipts SET record_id=?,record_sha256=?,data=? WHERE id=?",
    ).run(
      forged.recordId,
      forged.recordSha256,
      JSON.stringify(forged),
      receipt.id,
    );
  });
  await rejects(archive, join(f.base, "rejected-send-relation"));
});
