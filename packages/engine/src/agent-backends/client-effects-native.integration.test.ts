import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createEngine } from "../engine.js";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import {
  validateAgentBackendDatabase,
  type AgentBackendStorage,
} from "./store.js";
import { approvedEffect, decideEffect } from "./fixtures/effects.js";
import { backendUntil } from "./fixtures/backend.js";
function nativeDb(f: Awaited<ReturnType<typeof approvedEffect>>): DatabaseSync {
  return Reflect.get(f.engine.store, "db") as DatabaseSync;
}
test("native client effect intent SQL failure admits no tool approval, file write, command or checkpoint", async (t) => {
  const f = await approvedEffect(t, "direct-write");
  const db = nativeDb(f);
  db.exec(
    "CREATE TEMP TRIGGER effect_intent_fault BEFORE INSERT ON backend_revisions WHEN NEW.kind='client-effect' BEGIN SELECT RAISE(ABORT,'actual intent fault');END",
  );
  await f.done;
  assert.equal(existsSync(join(f.root, "effect.txt")), false);
  assert.equal(f.engine.store.getSnapshot(f.session.id).tools.length, 0);
  assert.equal(f.engine.store.listCheckpoints(f.runId).length, 0);
  assert.equal(f.engine.inspectAgentBackendEffects(f.workspace.id).length, 0);
  db.exec("DROP TRIGGER effect_intent_fault");
});
test("native dispatch source anchor SQL failure after exact approval causes zero physical effect", async (t) => {
  const f = await approvedEffect(t, "direct-write");
  const db = nativeDb(f);
  db.exec(
    "CREATE TEMP TRIGGER effect_dispatch_fault BEFORE INSERT ON session_events WHEN NEW.type='backend.client_effect_dispatched' BEGIN SELECT RAISE(ABORT,'actual dispatch fault');END",
  );
  await decideEffect(f);
  await f.done;
  assert.equal(existsSync(join(f.root, "effect.txt")), false);
  assert.equal(f.engine.store.listCheckpoints(f.runId).length, 0);
  db.exec("DROP TRIGGER effect_dispatch_fault");
});
test("actual physical write followed by persistent receipt SQL fault remains uncertain and is never replayed on reopen", async (t) => {
  const f = await approvedEffect(t, "direct-write");
  const db = nativeDb(f);
  db.exec(
    "CREATE TEMP TRIGGER effect_receipt_fault BEFORE INSERT ON backend_revisions WHEN NEW.kind='client-effect' AND json_extract(NEW.data,'$.state')='completed' BEGIN SELECT RAISE(ABORT,'actual receipt fault');END",
  );
  await decideEffect(f);
  await f.done;
  assert.equal(
    readFileSync(join(f.root, "effect.txt"), "utf8"),
    "Approved exact native ACP write.\n",
  );
  assert.equal(f.engine.store.listCheckpoints(f.runId).length, 1);
  assert.equal(f.engine.store.getSnapshot(f.session.id).tools.length, 1);
  db.exec("DROP TRIGGER effect_receipt_fault");
  await f.engine.close();
  const e = createEngine({
    ...f.configuration,
    agentBackends: false,
    agentBackendClientEffects: false,
  });
  f.engines.add(e);
  assert.equal(
    e.inspectAgentBackendEffects(f.workspace.id)[0]?.state,
    "uncertain",
  );
  assert.equal(e.store.getSnapshot(f.session.id).tools.length, 1);
  assert.equal(
    e.getCapabilities().providerIds.some((id) => id.startsWith("acp:")),
    false,
  );
  assert.equal(
    readFileSync(join(f.root, "effect.txt"), "utf8"),
    "Approved exact native ACP write.\n",
  );
});
test("actual backend replacement while native approval waits cannot dispatch the prepared write", async (t) => {
  const f = await approvedEffect(t, "direct-write");
  await backendUntil(
    () =>
      f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some((a) => a.status === "pending"),
    "approval missing",
  );
  const current = f.engine.getAgentBackend(f.workspace.id, f.backendId)!;
  f.engine.disableAgentBackend({
    workspaceId: f.workspace.id,
    requestId: "disable-waiting",
    expectedRevision: current.revision,
    backendId: f.backendId,
  });
  await decideEffect(f);
  await f.done;
  assert.equal(existsSync(join(f.root, "effect.txt")), false);
  assert.equal(f.engine.store.listCheckpoints(f.runId).length, 0);
});
test("rehashed native effect result cannot replace the genuine same-Attempt completion/checkpoint source anchor", async (t) => {
  const f = await approvedEffect(t, "direct-write");
  await decideEffect(f);
  assert.equal((await f.done).state, "completed");
  const db = nativeDb(f),
    head = db
      .prepare(
        "SELECT revision_id FROM backend_heads WHERE kind='client-effect'",
      )
      .get()!;
  const row = db
    .prepare("SELECT data FROM backend_revisions WHERE id=?")
    .get(String(head.revision_id))!;
  const body = JSON.parse(String(row.data));
  body.completion.result.checkpointId = "forged-checkpoint";
  delete body.completion.sha256;
  body.completion.sha256 = knowledgeHash(body.completion);
  delete body.sha256;
  body.sha256 = knowledgeHash(body);
  db.exec("SAVEPOINT native_effect_drift");
  try {
    db.prepare("UPDATE backend_revisions SET data=?,sha256=? WHERE id=?").run(
      JSON.stringify(body),
      body.sha256,
      String(head.revision_id),
    );
    db.prepare(
      "UPDATE backend_heads SET sha256=? WHERE kind='client-effect'",
    ).run(body.sha256);
    assert.throws(() => validateAgentBackendDatabase(db));
    assert.throws(() => f.engine.inspectAgentBackendEffects(f.workspace.id));
  } finally {
    db.exec("ROLLBACK TO native_effect_drift;RELEASE native_effect_drift");
  }
  validateAgentBackendDatabase(db);
});
test("completed actual client write imports disabled and paused with native approval/Part/checkpoint/delivery preserved", async (t) => {
  const f = await approvedEffect(t, "permission-write");
  await decideEffect(f);
  assert.equal((await f.done).state, "completed");
  await f.engine.close();
  const archive = await exportEngineArchive({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
    destination: join(f.base, "effect-export"),
  });
  const imported = await importEngineArchive({
    directory: archive.directory,
    destination: join(f.base, "effect-import"),
  });
  const e = createEngine({
    ...f.configuration,
    dbPath: imported.dbPath,
    artifactDir: imported.artifactDir,
    agentBackends: false,
    agentBackendClientEffects: false,
  });
  f.engines.add(e);
  const effect = e.inspectAgentBackendEffects(f.workspace.id)[0]!;
  assert.equal(effect.state, "paused-import");
  assert.equal(effect.completion?.state, "completed");
  assert.ok(effect.permissionDelivery);
  assert.ok(effect.delivery);
  assert.equal(e.getAgentBackend(f.workspace.id, f.backendId)?.enabled, false);
  assert.equal(e.store.getSnapshot(f.session.id).tools.length, 1);
  assert.equal(e.store.listCheckpoints(f.runId).length, 1);
  assert.equal(e.store.getSessionControl(f.session.id).paused, true);
  await e.waitForSession(f.session.id);
  assert.equal(
    f.logs().filter((v) => v.message?.method === "session/prompt").length,
    1,
  );
});

test("actual failed terminal retains its allowed native approval and rejects historical approval drift", async (t) => {
  const f = await approvedEffect(t, "terminal-fail");
  const approved = await decideEffect(f);
  assert.equal((await f.done).state, "completed");
  const effect = f.engine.inspectAgentBackendEffects(f.workspace.id)[0]!;
  assert.equal(effect.state, "failed");
  assert.ok(effect.completion?.checkpoint);
  const db = nativeDb(f),
    row = db.prepare("SELECT data FROM approvals WHERE id=?").get(approved.id)!;
  const body = JSON.parse(String(row.data));
  body.status = "denied";
  db.exec("SAVEPOINT failed_approval_drift");
  try {
    db.prepare("UPDATE approvals SET data=?,status='denied' WHERE id=?").run(
      JSON.stringify(body),
      approved.id,
    );
    assert.throws(() => validateAgentBackendDatabase(db));
    assert.throws(() => f.engine.inspectAgentBackendEffects(f.workspace.id));
  } finally {
    db.exec("ROLLBACK TO failed_approval_drift;RELEASE failed_approval_drift");
  }
  validateAgentBackendDatabase(db);
});
