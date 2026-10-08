import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import {
  ProposalApplyStorage,
  validateProposalApplyDatabase,
} from "./apply-store.js";
import type {
  PrepareProposalApply,
  ProposalApplyOwner,
} from "./apply-types.js";
import { applyFixture } from "./fixtures/apply.js";

function native(engine: Awaited<ReturnType<typeof applyFixture>>["engine"]) {
  const storage = Reflect.get(engine, "proposalApplies");
  assert.ok(storage instanceof ProposalApplyStorage);
  return storage;
}
function database(engine: Awaited<ReturnType<typeof applyFixture>>["engine"]) {
  const db = Reflect.get(engine.store, "db");
  assert.ok(db instanceof DatabaseSync);
  return db;
}
function input(owner: ProposalApplyOwner): PrepareProposalApply {
  return {
    workspaceId: owner.workspaceId,
    proposalId: owner.proposalId,
    revisionId: owner.revisionId,
    revisionSha256: owner.revisionSha256,
    sourceManifestSha256: owner.sourceManifestSha256,
    beforeHead: owner.beforeHead,
    binding: owner.binding,
    previewSha256: owner.previewSha256,
    expiresAt: owner.expiresAt,
    deadline: owner.deadline,
    requestId: owner.requestId,
    requestSha256: owner.requestSha256,
  };
}
function typed(code?: string) {
  return (error: unknown) =>
    error instanceof EngineError && (code === undefined || error.code === code);
}

test("malformed native apply request rejects hostile descriptors before any host approval callback", async (t) => {
  const f = await applyFixture(t),
    storage = native(f.engine),
    db = database(f.engine);
  let traps = 0,
    approvals = 0;
  t.mock.method(storage.ports, "readApprovedCapture", () => {
    approvals++;
    throw Error("must not read approval");
  });
  const getter = Object.defineProperty({}, "workspaceId", {
    enumerable: true,
    get() {
      traps++;
      throw Error("must not read getter");
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        traps++;
        throw Error("must not inspect proxy");
      },
      getOwnPropertyDescriptor() {
        traps++;
        throw Error("must not inspect proxy");
      },
    },
  );
  for (const value of [null, [], getter, proxy])
    assert.throws(
      () => storage.prepare({}, value as unknown as PrepareProposalApply),
      typed(),
    );
  assert.equal(traps, 0);
  assert.equal(approvals, 0);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM proposal_apply_owners").get()!.n,
    0,
  );
  f.assertNoCoding();
});

test("native exact historical request returns original receipt before current approval or physical freshness", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const result = await f.apply(await f.preview(), "native-exact-duplicate"),
    storage = native(f.engine);
  t.mock.method(storage.ports, "readApprovedCapture", () => {
    throw Error("must not reread approval");
  });
  t.mock.method(storage.ports, "checkBinding", () => {
    throw Error("must not refresh historical request");
  });
  t.mock.method(storage.ports, "assertCurrent", () => {
    throw Error("must not refresh historical request");
  });
  const duplicate = storage.prepare({}, input(result.owner));
  assert.equal(duplicate.kind, "duplicate");
  if (duplicate.kind !== "duplicate")
    throw Error("expected historical observation");
  assert.deepEqual(duplicate.history, {
    owner: result.owner,
    checkpoint: result.checkpoint,
    receipt: result.receipt,
  });
  assert.throws(
    () =>
      storage.findRequest({
        workspaceId: result.owner.workspaceId,
        requestId: result.owner.requestId,
        requestSha256: "a".repeat(64),
      }),
    typed("PROPOSAL_APPLY_REQUEST_CONFLICT"),
  );
  f.assertNoCoding();
});

test("copied native apply capture cannot dispatch while the original producer proceeds once", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const storage = native(f.engine),
    originalDispatch = storage.dispatch.bind(storage);
  let dispatches = 0;
  t.mock.method(storage, "dispatch", (capture: Parameters<ProposalApplyStorage['dispatch']>[0]) => {
    const before = storage.getOwner(capture.workspaceId, capture.ownerId);
    assert.equal(before?.state, "prepared");
    assert.throws(
      () => originalDispatch(Object.freeze({ ...capture })),
      typed("PROPOSAL_APPLY_CAPTURE_REQUIRED"),
    );
    assert.equal(
      storage.getOwner(capture.workspaceId, capture.ownerId)?.sha256,
      before?.sha256,
    );
    dispatches++;
    return originalDispatch(capture);
  });
  const result = await f.apply(await f.preview(), "original-capture");
  assert.equal(dispatches, 1);
  assert.equal(result.owner.state, "completed");
  assert.doesNotThrow(() => validateProposalApplyDatabase(database(f.engine)));
  f.assertNoCoding();
});

test("oversized actual native owner is rejected from metadata without selecting its body", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const result = await f.apply(await f.preview(), "metadata-cap"),
    storage = native(f.engine),
    db = database(f.engine);
  const originalData = db
    .prepare("SELECT data FROM proposal_apply_owners WHERE id=?")
    .get(result.owner.id)!.data;
  db.exec("PRAGMA ignore_check_constraints=ON");
  db.prepare("UPDATE proposal_apply_owners SET data=? WHERE id=?").run(
    "x".repeat(65537),
    result.owner.id,
  );
  const prepare = db.prepare.bind(db);
  let bodyReads = 0;
  t.mock.method(db, "prepare", (sql: string) => {
    if (/SELECT data FROM proposal_apply_owners/u.test(sql)) bodyReads++;
    return prepare(sql);
  });
  try {
    assert.throws(
      () => storage.getOwner(result.owner.workspaceId, result.owner.id),
      typed(),
    );
    assert.equal(bodyReads, 0);
  } finally {
    db.prepare("UPDATE proposal_apply_owners SET data=? WHERE id=?").run(
      originalData as string,
      result.owner.id,
    );
    db.exec("PRAGMA ignore_check_constraints=OFF");
  }
  f.assertNoCoding();
});
