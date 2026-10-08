import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { MoodcodeEngine } from "../engine.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { groupKind, caseKind } from "./groups.js";
import { signBatch } from "./validation.js";
import { batchFixture, batchCommand, batchUntil } from "./fixtures/batch.js";
async function ready(f: Awaited<ReturnType<typeof batchFixture>>) {
  f.approveChildren();
  const p = await f.engine.previewCodingAttemptGroup(f.input),
    g = f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "start",
      approved: true,
      preview: p,
    });
  return f.engine.runCodingAttemptGroup({
    workspaceId: f.workspace.id,
    groupId: g.groupId,
    requestId: "run",
    expectedRevision: g.revision,
    approved: true,
  });
}
async function merged(f: Awaited<ReturnType<typeof batchFixture>>) {
  const g = await ready(f),
    p = await f.engine.previewCodingAttemptSelection({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      caseId: "A",
      expectedRevision: g.revision,
    }),
    s = f.engine.selectCodingAttempt({
      workspaceId: f.workspace.id,
      requestId: "select",
      approved: true,
      preview: p,
    });
  f.releaseParent(s.cases[0]!.instanceId);
  await f.approveMerge();
  await f.finish();
  return f.engine.inspectBatchEvidence(f.workspace.id, g.groupId);
}

test("actual SQL group receipt failure after physical merge preserves unknown debt and never replays", async (t) => {
  const f = await batchFixture(t),
    g = await ready(f),
    p = await f.engine.previewCodingAttemptSelection({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      caseId: "A",
      expectedRevision: g.revision,
    }),
    s = f.engine.selectCodingAttempt({
      workspaceId: f.workspace.id,
      requestId: "select",
      approved: true,
      preview: p,
    }),
    db = new DatabaseSync(f.dbPath);
  db.exec(
    `CREATE TRIGGER batch_merge_receipt_fault BEFORE UPDATE ON session_documents WHEN NEW.kind='${groupKind(g.groupId)}' AND json_extract(NEW.data,'$.selection.state')='merged' BEGIN SELECT RAISE(ABORT,'actual batch receipt failure'); END;`,
  );
  f.releaseParent(s.cases[0]!.instanceId);
  await f.approveMerge();
  const run = await f.finish();
  assert.notEqual(run.state, "completed");
  assert.equal(readFileSync(join(f.root, "seed.txt"), "utf8"), "candidate A\n");
  assert.notEqual(
    f.engine.inspectBatchEvidence(f.workspace.id, g.groupId).selection?.state,
    "merged",
  );
  assert.equal(
    f.engine.inspectWorkflowEffect(
      f.workspace.id,
      s.cases[0]!.instanceId,
      "edit",
    )!.state,
    "merge-dispatching",
  );
  const before = f.children.length;
  await assert.rejects(
    f.engine.resumeVerifiedBatch({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      requestId: "retry",
      expectedRevision: f.engine.inspectBatchEvidence(f.workspace.id, g.groupId)
        .revision,
      approved: true,
    }),
  );
  assert.equal(f.children.length, before);
  db.exec("DROP TRIGGER batch_merge_receipt_fault");
  db.close();
});

test("fully rehashed native group/case corruption cannot manufacture a verified reviewer, replay pending work or borrowed choice", async (t) => {
  const f = await batchFixture(t),
    g = await ready(f);
  const document = f.engine.store.getSessionDocument(
      f.session.id,
      groupKind(g.groupId),
    )!,
    forged = signBatch({
      ...g,
      revision: g.revision + 1,
      previousSha256: g.sha256,
      cases: g.cases.map((c) => ({
        ...c,
        state: "pending" as const,
        receiptSha256: null,
        stage: 0,
      })),
    });
  f.engine.store.putSessionDocument(
    f.session.id,
    groupKind(g.groupId),
    document.revision,
    forged as never,
  );
  assert.throws(() => f.engine.inspectBatchEvidence(f.workspace.id, g.groupId));
  const db = new DatabaseSync(f.dbPath);
  db.prepare(
    "UPDATE session_documents SET revision=?,data=? WHERE session_id=? AND kind=?",
  ).run(g.revision, JSON.stringify(g), f.session.id, groupKind(g.groupId));
  const c = JSON.parse(
    String(
      db
        .prepare(
          "SELECT data FROM session_documents WHERE session_id=? AND kind=?",
        )
        .get(f.session.id, caseKind(g.groupId, "A"))!.data,
    ),
  );
  const tampered = signBatch({
    ...c,
    completion: { ...c.completion, state: "failed" },
  });
  db.prepare(
    "UPDATE session_documents SET data=? WHERE session_id=? AND kind=?",
  ).run(JSON.stringify(tampered), f.session.id, caseKind(g.groupId, "A"));
  assert.throws(() => f.engine.inspectBatchEvidence(f.workspace.id, g.groupId));
  db.close();
});

test("accepted selected result survives default-off restart as readonly history, dispatch resumes only exact pending input once", async (t) => {
  const f = await batchFixture(t),
    g = await merged(f);
  await batchCommand(f.engine, "session.pause", { sessionId: f.session.id });
  const target = f.engine.captureCodingBatchDeliveryTarget({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      config: f.run.config,
    }),
    r = f.engine.deliverCodingBatchResult({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      requestId: "result",
      expectedRevision: 0,
      approved: true,
      target,
    }),
    before = f.requests.length;
  await f.engine.close();
  const reopened = new MoodcodeEngine({
    ...f.configuration,
    codingBatches: false,
    configureChild: undefined,
  });
  t.after(() => reopened.close());
  assert.equal(
    reopened.inspectBatchEvidence(f.workspace.id, g.groupId).selection?.state,
    "merged",
  );
  assert.equal(f.requests.length, before);
  await assert.rejects(
    reopened.resumeVerifiedBatch({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      requestId: "resume",
      expectedRevision: g.revision,
      approved: true,
    }),
  );
  await batchCommand(reopened, "session.resume", { sessionId: f.session.id });
  await batchUntil(
    () => reopened.store.getInput(r.record.input.inputId).state === "promoted",
    "exact existing result consumed",
  );
  await batchUntil(
    () => f.requests.length === before + 1,
    "actual provider consumes promoted exact result",
  );
  assert.equal(f.requests.length, before + 1);
  assert.equal(
    reopened.store
      .listInputs(f.session.id)
      .inputs.filter((i) => i.requestId.startsWith("workflow-result:")).length,
    1,
  );
});

test("actual archive import is paused batch history without recreated Original actor, cases, approvals or merge", async (t) => {
  const f = await batchFixture(t),
    g = await merged(f);
  await batchCommand(f.engine, "session.pause", { sessionId: f.session.id });
  const target = f.engine.captureCodingBatchDeliveryTarget({
    workspaceId: f.workspace.id,
    groupId: g.groupId,
    config: f.run.config,
  });
  f.engine.deliverCodingBatchResult({
    workspaceId: f.workspace.id,
    groupId: g.groupId,
    requestId: "result",
    expectedRevision: 0,
    approved: true,
    target,
  });
  await f.engine.close();
  const archive = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "archive"),
      archiveDocumentBudgetMs: 30_000,
    }),
    imported = await importEngineArchive({
      directory: archive.directory,
      destination: join(f.base, "imported"),
      archiveDocumentBudgetMs: 30_000,
    }),
    before = f.requests.length,
    restored = new MoodcodeEngine({
      ...f.configuration,
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
      configureChild: undefined,
    });
  t.after(() => restored.close());
  const history = restored.inspectBatchEvidence(f.workspace.id, g.groupId);
  assert.equal(history.state, "paused-import");
  assert.equal(history.cases.filter((c) => c.state === "verified").length, 2);
  await assert.rejects(
    restored.resumeVerifiedBatch({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      requestId: "resume",
      expectedRevision: history.revision,
      approved: true,
    }),
  );
  assert.throws(() =>
    restored.captureCodingBatchDeliveryTarget({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      config: f.run.config,
    }),
  );
  assert.equal(f.requests.length, before);
});

test("current selected worktree bytes and registered native check revision are revalidated before preview/merge", async (t) => {
  const f = await batchFixture(t),
    g = await ready(f);
  writeFileSync(
    join(f.worktrees[0]!.root, "seed.txt"),
    "external candidate changed\n",
  );
  await assert.rejects(
    f.engine.previewCodingAttemptSelection({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      caseId: "A",
      expectedRevision: g.revision,
    }),
  );
  assert.equal(f.engine.store.listCheckpoints(f.parent.runId).length, 0);
  assert.equal(
    readFileSync(join(f.root, "seed.txt"), "utf8"),
    "batch baseline\n",
  );
});

test("actual reservation then group birth SQL fault leaves consumed capacity and cannot reserve Original preview twice", async (t) => {
  const f = await batchFixture(t),
    p = await f.engine.previewCodingAttemptGroup(f.input),
    db = new DatabaseSync(f.dbPath),
    before = f.engine.coordinator.getRemainingChildBudget(f.parent.runId);
  db.exec(
    `CREATE TRIGGER batch_birth_fault BEFORE INSERT ON session_documents WHEN NEW.kind='${groupKind(f.input.groupId)}' BEGIN SELECT RAISE(ABORT,'actual group SQL birth fault'); END;`,
  );
  assert.throws(() =>
    f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "birth",
      approved: true,
      preview: p,
    }),
  );
  const after = f.engine.coordinator.getRemainingChildBudget(f.parent.runId);
  assert.equal(before.turns - after.turns, 18);
  assert.equal(f.children.length, 0);
  db.exec("DROP TRIGGER batch_birth_fault");
  assert.throws(() =>
    f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "birth-retry",
      approved: true,
      preview: p,
    }),
  );
  assert.equal(
    f.engine.coordinator.getRemainingChildBudget(f.parent.runId).turns,
    after.turns,
  );
  db.close();
});
