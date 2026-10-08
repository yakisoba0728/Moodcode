import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import {
  childStorageKind,
  validateChildStorageRecord,
} from "../child-tasks/storage-binding.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { checkDatabase } from "../recovery/snapshot.js";
import {
  exportEngineArchive,
  importEngineArchive,
  validateEngineArchive,
  type EngineArchiveResult,
} from "../storage/archive.js";
import { DB_VERSION } from "../storage/migrations.js";
import { validateTeamChildInputRelations } from "./child-input-proof.js";
import { validateTeamDatabase } from "./store.js";
import type { TeamDeliveryReceipt, TeamMemberRevision } from "./types.js";
import { failure, readDatabase } from "./fixtures/engine-team.js";
import { nativeTeam } from "./fixtures/native-team.js";

const signed = <T extends { sha256: string }>(value: T): T => {
  const { sha256, ...body } = value;
  return { ...body, sha256: knowledgeHash(body) } as T;
};
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
type Fixture = Awaited<ReturnType<typeof nativeTeam>>;
function proof(f: Fixture, member: TeamMemberRevision): void {
  const record = validateChildStorageRecord(
    f.engine.store.getSessionDocument(
      f.session.id,
      childStorageKind(member.owner.childTaskId!),
    )!.data,
  );
  assert.equal(record.sha256, member.owner.childStorageSha256);
  readDatabase(f.dbPath, (primary) =>
    readDatabase(record.binding.physical.database.path, (child) => {
      validateTeamDatabase(primary);
      validateTeamChildInputRelations(primary, child, record, () => {});
    }),
  );
}
function nativeDb(f: Fixture): DatabaseSync {
  const db = Reflect.get(f.engine.store, "db");
  assert.ok(db instanceof DatabaseSync);
  return db;
}
function recordReceipt(db: DatabaseSync, receipt: TeamDeliveryReceipt): void {
  db.prepare("UPDATE team_delivery_receipts SET data=? WHERE id=?").run(
    JSON.stringify(receipt),
    receipt.id,
  );
}
async function delivered(t: Parameters<typeof nativeTeam>[0]) {
  const f = await nativeTeam(t),
    execution = await f.child();
  f.send(execution.member.memberId, execution.member.generation);
  const page = f.read(execution.member.memberId, execution.member.generation),
    result = f.engine.resumeChildTurn({
      workspaceId: f.workspace.id,
      requestId: "child-input-proof",
      approved: true,
      page,
      expectedCursorRevision: page.cursor.revision,
    });
  assert.ok(result.receipt);
  return { f, ...execution, result, receipt: result.receipt };
}

test("actual pending, subsequently promoted and subsequently cancelled child inputs preserve their original admitted receipt proof", async (t) => {
  const first = await delivered(t),
    { f, member, child, task, receipt } = first;
  assert.equal(child.store.getInput(receipt.input.inputId).state, "pending");
  proof(f, member);
  f.childReleases[0]!.resolve();
  assert.equal(
    (await f.engine.children.tasks.wait(f.session.id, task.id)).state,
    "completed",
  );
  const record = validateChildStorageRecord(
    f.engine.store.getSessionDocument(f.session.id, childStorageKind(task.id))!
      .data,
  );
  readDatabase(record.binding.physical.database.path, (db) => {
    const row = db
      .prepare("SELECT state,run_id FROM session_inputs WHERE id=?")
      .get(receipt.input.inputId)!;
    assert.equal(row.state, "promoted");
    assert.equal(row.run_id, member.owner.runId);
  });
  proof(f, member);
  const second = await f.child("cancelled-accept");
  f.send(
    second.member.memberId,
    second.member.generation,
    "Explicitly cancelled after original acceptance.",
    "cancel-after-accept",
  );
  const page = f.read(second.member.memberId, second.member.generation),
    accepted = f.engine.resumeChildTurn({
      workspaceId: f.workspace.id,
      requestId: "cancelled-child-input-proof",
      approved: true,
      page,
      expectedCursorRevision: page.cursor.revision,
    });
  assert.ok(accepted.receipt);
  const requests = structuredClone(f.requests),
    cancelled = second.child.store.cancelInput(accepted.receipt.input.inputId);
  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(f.requests, requests);
  proof(f, second.member);
  f.childReleases[1]!.resolve();
  await f.engine.children.tasks.wait(f.session.id, second.task.id);
  proof(f, second.member);
  assert.equal(
    f.engine.getTeamDelivery(f.workspace.id, accepted.record.id)?.receipt
      ?.sha256,
    accepted.receipt.sha256,
  );
});

test("resigned root receipts cannot name absent input, wrong actual request hash or another actual child input", async (t) => {
  const { f, member, child, receipt } = await delivered(t),
    db = nativeDb(f);
  proof(f, member);
  const other = child.store
    .listInputs(member.owner.sessionId)
    .inputs.find((input) => input.id !== receipt.input.inputId)!;
  assert.ok(other);
  const variants = [
    { ...receipt.input, inputId: "absent-native-child-input" },
    { ...receipt.input, inputSha256: "a".repeat(64) },
    { ...receipt.input, inputId: other.id, admittedSeq: other.admittedSeq },
  ];
  for (const input of variants) {
    recordReceipt(db, signed({ ...receipt, input }));
    try {
      assert.throws(() => proof(f, member), failure());
    } finally {
      recordReceipt(db, receipt);
    }
  }
  const childDb = Reflect.get(child.store, "db");
  assert.ok(childDb instanceof DatabaseSync);
  const original = childDb
    .prepare("SELECT data FROM session_inputs WHERE id=?")
    .get(receipt.input.inputId)!;
  const body = JSON.parse(String(original.data));
  childDb
    .prepare("UPDATE session_inputs SET data=? WHERE id=?")
    .run(
      JSON.stringify({
        ...body,
        prompt: body.prompt + " Wrong captured text.",
      }),
      receipt.input.inputId,
    );
  try {
    assert.throws(() => proof(f, member), failure());
  } finally {
    childDb
      .prepare("UPDATE session_inputs SET data=? WHERE id=?")
      .run(original.data!, receipt.input.inputId);
  }
  proof(f, member);
});

test("native task claim receipt actor must remain the exact original task membership owner", async (t) => {
  const f = await nativeTeam(t),
    { member } = await f.child(),
    task = f.engine.putTeamTask({
      workspaceId: f.workspace.id,
      teamId: f.created.record.id,
      memberId: f.coordinator.memberId,
      generation: f.coordinator.generation,
      taskId: "exact-task-owner",
      requestId: "exact-task-owner",
      expectedRevision: 0,
      title: "Actual native task",
      description: "Board data only.",
      dependencies: [],
      expiresAt: f.expiresAt,
    }),
    claimed = f.engine.claimTeamTask({
      workspaceId: f.workspace.id,
      teamId: f.created.record.id,
      memberId: member.memberId,
      generation: member.generation,
      taskId: task.record.taskId,
      requestId: "exact-task-owner-claim",
      expectedRevision: task.record.revision,
    }),
    db = nativeDb(f);
  validateTeamDatabase(db);
  const forged = signed({
    ...claimed.receipt,
    actorId: f.coordinator.memberId,
    actorGeneration: f.coordinator.generation,
  });
  db.prepare(
    "UPDATE team_operation_receipts SET actor_id=?,actor_generation=?,data=? WHERE id=?",
  ).run(
    forged.actorId,
    forged.actorGeneration,
    JSON.stringify(forged),
    forged.id,
  );
  try {
    assert.throws(() => validateTeamDatabase(db), failure());
  } finally {
    db.prepare(
      "UPDATE team_operation_receipts SET actor_id=?,actor_generation=?,data=? WHERE id=?",
    ).run(
      claimed.receipt.actorId,
      claimed.receipt.actorGeneration,
      JSON.stringify(claimed.receipt),
      claimed.receipt.id,
    );
  }
  validateTeamDatabase(db);
});

function resignReceipt(
  archive: EngineArchiveResult,
  receipt: TeamDeliveryReceipt,
): void {
  const file = join(archive.directory, "data", "manifest.json"),
    manifest = JSON.parse(
      readFileSync(file, "utf8"),
    ) as EngineArchiveResult["manifest"],
    primary = manifest.databases.find((row) => row.role === "primary")!,
    path = join(archive.directory, "data", primary.file),
    db = new DatabaseSync(path);
  try {
    recordReceipt(
      db,
      signed({
        ...receipt,
        input: { ...receipt.input, inputSha256: "b".repeat(64) },
      }),
    );
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
  primary.sha256 = sha(bytes);
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
}
test("actual audited archive rejects a resigned child input proof before importing destination state", async (t) => {
  const { f, task, receipt } = await delivered(t);
  f.childReleases[0]!.resolve();
  await f.engine.children.tasks.wait(f.session.id, task.id);
  f.parentRelease.resolve();
  await f.engine.waitForRun(f.parent.runId);
  await f.engine.close();
  const archive = await exportEngineArchive({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
    destination: join(f.base, "child-input-proof-archive"),
  });
  assert.doesNotThrow(() =>
    validateEngineArchive({ directory: archive.directory }),
  );
  resignReceipt(archive, receipt);
  const invalid = (error: unknown) =>
    error instanceof EngineError && error.code === "ARCHIVE_TEAM_INVALID";
  assert.throws(
    () => validateEngineArchive({ directory: archive.directory }),
    invalid,
  );
  const destination = join(f.base, "rejected-child-input-proof");
  await assert.rejects(
    importEngineArchive({ directory: archive.directory, destination }),
    invalid,
  );
  assert.equal(existsSync(destination), false);
});
