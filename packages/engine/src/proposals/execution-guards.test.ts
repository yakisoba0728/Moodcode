import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  readProposalApplyGuard,
  validateProposalApplyGuard,
  type ProposalApplyGuardChecks,
} from "./execution-guards.js";
import { proposalChecks } from "./validation.js";

const binding = {
  workspaceId: "ws",
  root: "/repo",
  rootDevice: "1",
  rootInode: "2",
  storageBindingSha256: "a".repeat(64),
};
function guard(lock: object = { path: "/lock", device: "1", inode: "2" }) {
  const marker = {
    ownerPid: 1,
    groupPid: null,
    active: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const body = {
    id: "owner",
    workspaceId: "ws",
    ownerId: "owner",
    binding,
    lock,
    marker,
  };
  return { ...body, sha256: knowledgeHash(body) };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
const fail = (reported = "CALLER_INVALID"): never => {
  throw new EngineError(reported, reported);
};
const caller: ProposalApplyGuardChecks = {
  ...proposalChecks({
    fail,
    limitCode: "CALLER_LIMIT",
    hashCode: "CALLER_HASH",
    rowCode: "CALLER_ROW",
    maxBytes: 65_536,
    maxNodes: 4_096,
    maxDepth: 16,
    maxItems: 128,
  }),
  fail,
};

test("the guard validator applies the whole rule set with the guard code by default", () => {
  assert.equal(validateProposalApplyGuard(guard()).ownerId, "owner");
  for (const value of [
    guard({ path: "/lock", device: "1".repeat(33), inode: "2" }),
    guard({ path: "/lo\0ck", device: "1", inode: "2" }),
    guard({ path: 1, device: "1", inode: "2" }),
    { ...guard(), ownerId: "" },
    { ...guard(), sha256: "b".repeat(64) },
  ])
    assert.throws(
      () => validateProposalApplyGuard(value),
      code("PROPOSAL_APPLY_GUARD_INVALID"),
    );
});

test("guard callers keep their own shape, digest and row codes", (t) => {
  assert.throws(
    () => validateProposalApplyGuard({ ...guard(), extra: 1 }, caller),
    code("CALLER_INVALID"),
  );
  assert.throws(
    () =>
      validateProposalApplyGuard(
        { ...guard(), sha256: "b".repeat(64) },
        caller,
      ),
    code("CALLER_HASH"),
  );
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE proposal_apply_execution_guards (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, data TEXT NOT NULL)",
  );
  const insert = db.prepare(
    "INSERT INTO proposal_apply_execution_guards(id,workspace_id,data) VALUES(?,?,?)",
  );
  insert.run("owner", "ws", JSON.stringify(guard()));
  insert.run("broken", "ws", "{");
  insert.run("moved", "other", JSON.stringify(guard()));
  assert.equal(
    readProposalApplyGuard(db, "ws", "owner")?.sha256,
    guard().sha256,
  );
  assert.equal(readProposalApplyGuard(db, "ws", "absent"), undefined);
  assert.throws(
    () => readProposalApplyGuard(db, "ws", "broken"),
    code("PROPOSAL_APPLY_GUARD_INVALID"),
  );
  assert.throws(
    () => readProposalApplyGuard(db, "ws", "broken", caller),
    code("CALLER_ROW"),
  );
  assert.throws(
    () => readProposalApplyGuard(db, "other", "moved", caller),
    code("CALLER_INVALID"),
  );
});
