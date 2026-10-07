import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_LIMITS,
  EngineError,
  type JsonObject,
  type ProviderAttempt,
  type TurnRecord,
} from "@moodcode/contracts";
import { lifecycleContinuationDocumentKind } from "../lifecycle/continuation.js";
import { verificationControllerDocumentKind } from "../verification/controller.js";
import { verificationDocumentKind } from "../verification/plans.js";
import { SqliteStore } from "./index.js";

const stamp = () => new Date().toISOString();
const config = {
  providerId: "storage-authored",
  modelId: "storage-model",
  mode: "build" as const,
  limits: { ...DEFAULT_LIMITS },
};
const hasCode = (code: string) => (error: unknown) =>
  error instanceof EngineError && error.code === code;

// These native rows exercise SQLite scope/CAS only; they do not claim a real
// verification producer receipt or grant a provider execution capability.
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "moodcode-continuation-cas-"));
  const path = join(root, "engine.sqlite"),
    store = new SqliteStore(path);
  store.putWorkspace({
    id: "workspace",
    root,
    gitRoot: root,
    branch: null,
    createdAt: stamp(),
  });
  store.createSession({
    id: "session",
    workspaceId: "workspace",
    title: "Native CAS fixture",
    createdAt: stamp(),
  });
  const receipt = store.admit({
    sessionId: "session",
    requestId: "original",
    prompt: "Exercise native read and CAS",
    config,
  });
  const run = store.getRun(receipt.runId);
  store.commit(run.id, "run.started", {}, { run: { state: "running" } });
  const turn: TurnRecord = {
    schemaVersion: 2,
    id: "native-turn",
    sessionId: run.sessionId,
    runId: run.id,
    inputIds: [run.inputId],
    index: 0,
    state: "created",
    createdAt: stamp(),
  };
  store.putTurn(turn);
  const attempt: ProviderAttempt = {
    schemaVersion: 2,
    id: "native-attempt-0",
    sessionId: run.sessionId,
    runId: run.id,
    turnId: turn.id,
    index: 0,
    providerId: config.providerId,
    modelId: config.modelId,
    state: "prepared",
    createdAt: stamp(),
  };
  const controllerKind = verificationControllerDocumentKind(run.id),
    verificationKind = verificationDocumentKind(run.id),
    kind = lifecycleContinuationDocumentKind(run.id);
  const stateSha256 = "a".repeat(64);
  const verification = store.putSessionDocument(
    run.sessionId,
    verificationKind,
    0,
    { marker: "actual verification document" },
  );
  const controller = store.putSessionDocument(
    run.sessionId,
    controllerKind,
    0,
    { stateSha256, marker: "actual controller document" },
  );
  const pins = {
    controllerRevision: controller.revision,
    verificationRevision: verification.revision,
    controllerSha256: stateSha256,
  };
  const data: JsonObject = {
    runId: run.id,
    sessionId: run.sessionId,
    workspaceId: run.workspaceId,
    continuationsUsed: 1,
    marker: "original bounded control observation",
  };
  const journals = () => ({
    legacy: store.readEvents(run.sessionId, 0, 1000),
    native: store.readSessionEvents(run.sessionId, 0, 100),
  });
  const admit = (expectedRevision = 0, value = data, expected = pins) =>
    store.putActiveLifecycleContinuationDocument(
      run.id,
      kind,
      expectedRevision,
      value,
      expected,
    );
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    path,
    store,
    run,
    turn,
    attempt,
    controllerKind,
    verificationKind,
    kind,
    pins,
    data,
    journals,
    admit,
  };
}

test("latest native Attempt returns null without inventing an execution and selects the highest actual retry index", (t) => {
  const f = fixture(t);
  assert.equal(f.store.getLatestAttemptForTurn(f.turn.id), null);
  f.store.putAttempt(f.attempt);
  assert.deepEqual(f.store.getLatestAttemptForTurn(f.turn.id), f.attempt);
  const failed: ProviderAttempt = {
    ...f.attempt,
    state: "failed",
    completedAt: stamp(),
  };
  f.store.putAttempt(failed);
  const retry = f.store.putAttempt({
    ...f.attempt,
    id: "native-attempt-1",
    index: 1,
  });
  assert.deepEqual(f.store.getLatestAttemptForTurn(f.turn.id), retry);
});

for (const tamper of [
  "payload-session",
  "payload-run",
  "payload-turn",
  "sql-session",
  "sql-run",
] as const)
  test(`latest native Attempt rejects ${tamper} scope before returning a foreign observation`, (t) => {
    const f = fixture(t);
    f.store.putAttempt(f.attempt);
    const db = new DatabaseSync(f.path);
    try {
      if (tamper.startsWith("payload-")) {
        const key =
          tamper === "payload-session"
            ? "sessionId"
            : tamper === "payload-run"
              ? "runId"
              : "turnId";
        db.prepare("UPDATE provider_attempts SET data=? WHERE id=?").run(
          JSON.stringify({ ...f.attempt, [key]: "foreign-owner" }),
          f.attempt.id,
        );
      } else {
        db.exec("PRAGMA foreign_keys=OFF");
        db.prepare(
          `UPDATE provider_attempts SET ${tamper === "sql-session" ? "session_id" : "run_id"}=? WHERE id=?`,
        ).run("foreign-owner", f.attempt.id);
      }
      assert.throws(
        () => f.store.getLatestAttemptForTurn(f.turn.id),
        hasCode("RECORD_SCOPE_MISMATCH"),
      );
    } finally {
      db.close();
    }
  });

test("latest native Attempt rejects oversized body using metadata before parsing the corrupt payload", (t) => {
  const f = fixture(t);
  f.store.putAttempt(f.attempt);
  const db = new DatabaseSync(f.path);
  try {
    const oversized = JSON.stringify({
      ...f.attempt,
      marker: "x".repeat(8_388_609),
    });
    db.prepare("UPDATE provider_attempts SET data=? WHERE id=?").run(
      oversized,
      f.attempt.id,
    );
    let oversizedParses = 0;
    const parse = JSON.parse;
    t.mock.method(JSON, "parse", (body: string, ...rest: unknown[]) => {
      if (body.length > 8_388_608) oversizedParses++;
      return Reflect.apply(parse, JSON, [body, ...rest]);
    });
    assert.throws(
      () => f.store.getLatestAttemptForTurn(f.turn.id),
      hasCode("EVIDENCE_READ_LIMIT"),
    );
    assert.equal(oversizedParses, 0);
  } finally {
    db.close();
  }
});

test("continuation admission atomically pins both native ledger revisions and detaches its saved payload", (t) => {
  const f = fixture(t),
    saved = f.admit();
  f.data.marker = "caller mutation";
  assert.equal(saved.revision, 1);
  assert.equal(
    f.store.getSessionDocument(f.run.sessionId, f.kind)!.data.marker,
    "original bounded control observation",
  );
  assert.equal(f.journals().native.at(-1)!.type, "session.document.updated");
});

for (const changed of [
  "controller-revision",
  "verification-revision",
  "controller-sha",
  "run-scope",
] as const)
  test(`continuation ${changed} mismatch writes no document or journal cursor`, (t) => {
    const f = fixture(t),
      before = f.journals();
    const pins = { ...f.pins },
      data = { ...f.data };
    if (changed === "controller-revision") pins.controllerRevision++;
    if (changed === "verification-revision") pins.verificationRevision++;
    if (changed === "controller-sha") pins.controllerSha256 = "b".repeat(64);
    if (changed === "run-scope") data.runId = "foreign-owner";
    assert.throws(
      () => f.admit(0, data, pins),
      hasCode("LIFECYCLE_CONTINUATION_STALE"),
    );
    assert.equal(f.store.getSessionDocument(f.run.sessionId, f.kind), null);
    assert.deepEqual(f.journals(), before);
  });

test("changes to actual controller or verification ledgers reject captured admission pins without a partial document", (t) => {
  const f = fixture(t);
  f.store.putSessionDocument(f.run.sessionId, f.controllerKind, 1, {
    stateSha256: "b".repeat(64),
  });
  f.store.putSessionDocument(f.run.sessionId, f.verificationKind, 1, {
    marker: "new verification observation",
  });
  const before = f.journals();
  assert.throws(() => f.admit(), hasCode("LIFECYCLE_CONTINUATION_STALE"));
  assert.equal(f.store.getSessionDocument(f.run.sessionId, f.kind), null);
  assert.deepEqual(f.journals(), before);
});

for (const state of ["cancelling", "completed", "failed", "cancelled"] as const)
  test(`continuation ${state} Run cannot write an admission observation`, (t) => {
    const f = fixture(t);
    if (state === "cancelling" || state === "cancelled")
      f.store.commit(
        f.run.id,
        "run.cancelling",
        {},
        { run: { state: "cancelling" } },
      );
    if (state !== "cancelling")
      f.store.commit(f.run.id, `run.${state}`, {}, { run: { state } });
    const before = f.journals();
    assert.throws(() => f.admit(), hasCode("RUN_TERMINAL"));
    assert.equal(f.store.getSessionDocument(f.run.sessionId, f.kind), null);
    assert.deepEqual(f.journals(), before);
  });

test("same original Run cannot consume CAS zero twice or update a consumed continuation into a second admission", (t) => {
  const f = fixture(t),
    saved = f.admit(),
    before = f.journals();
  const controller = f.store.getSessionDocument(
    f.run.sessionId,
    f.controllerKind,
  );
  const verification = f.store.getSessionDocument(
    f.run.sessionId,
    f.verificationKind,
  );
  assert.throws(
    () => f.admit(),
    (error: unknown) =>
      error instanceof EngineError &&
      ["REVISION_CONFLICT", "LIFECYCLE_CONTINUATION_LIMIT"].includes(
        error.code,
      ),
  );
  assert.throws(
    () =>
      f.admit(saved.revision, { ...f.data, marker: "second native admission" }),
    hasCode("LIFECYCLE_CONTINUATION_LIMIT"),
  );
  assert.deepEqual(f.store.getSessionDocument(f.run.sessionId, f.kind), saved);
  assert.deepEqual(
    f.store.getSessionDocument(f.run.sessionId, f.controllerKind),
    controller,
  );
  assert.deepEqual(
    f.store.getSessionDocument(f.run.sessionId, f.verificationKind),
    verification,
  );
  assert.deepEqual(f.journals(), before);
});

test("native journal failure rolls back the continuation document and leaves CAS zero reusable", (t) => {
  const f = fixture(t),
    before = f.journals(),
    db = new DatabaseSync(f.path);
  try {
    db.exec(
      "CREATE TRIGGER fail_continuation_observation BEFORE INSERT ON session_events WHEN NEW.type='session.document.updated' BEGIN SELECT RAISE(ABORT,'authored continuation TX rollback'); END",
    );
    assert.throws(() => f.admit(), /authored continuation TX rollback/);
    assert.equal(f.store.getSessionDocument(f.run.sessionId, f.kind), null);
    assert.deepEqual(f.journals(), before);
    db.exec("DROP TRIGGER fail_continuation_observation");
    assert.equal(f.admit().revision, 1);
  } finally {
    db.close();
  }
});
