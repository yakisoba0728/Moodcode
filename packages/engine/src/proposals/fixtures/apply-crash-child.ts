import assert from "node:assert/strict";
import { constants, readFileSync, renameSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEngine } from "../../engine.js";
import type { ProviderAdapter } from "../../ports.js";
import { PhysicalPatchProducer } from "../../tools/patch/physical.js";
import { inspectExecutionLock } from "../../tools/command/execution-lock.js";
import { ProposalApplyStorage } from "../apply-store.js";
import type {
  ApplyProposalResult,
  ProposalApplyPreview,
} from "../apply-service.js";
import type { ProposalApplyOwner } from "../apply-types.js";

const [dbPath, artifactDir, workspaceId, proposalId, boundary, readyPath] =
  process.argv.slice(2);
if (
  !dbPath ||
  !artifactDir ||
  !workspaceId ||
  !proposalId ||
  !readyPath ||
  ![
    "prepared",
    "reserved",
    "acquired",
    "dispatched",
    "written",
    "checkpointed",
    "released",
    "settled",
  ].includes(boundary ?? "")
)
  throw new Error("Exact original native apply crash arguments required");
const targetBoundary = boundary!;
const actualReadyPath = readyPath;
let engine: ReturnType<typeof createEngine>,
  db: DatabaseSync,
  hit = false;
function stopAt(actualBoundary: string) {
  if (targetBoundary !== actualBoundary || hit) return;
  const row = db
    .prepare("SELECT data FROM proposal_apply_owners WHERE request_id=?")
    .get("actual-apply-crash-request");
  assert.ok(row);
  const owner = JSON.parse(String(row.data)) as ProposalApplyOwner,
    checkpoint = db
      .prepare("SELECT data FROM proposal_apply_checkpoints WHERE owner_id=?")
      .get(owner.id),
    receipt = db
      .prepare("SELECT data FROM proposal_apply_receipts WHERE owner_id=?")
      .get(owner.id),
    guard = db
      .prepare(
        "SELECT data FROM proposal_apply_execution_guards WHERE owner_id=?",
      )
      .get(owner.id),
    lock = inspectExecutionLock(`${dbPath}.effects.sqlite`),
    root = engine.store.getWorkspace(workspaceId!).root;
  assert.equal(
    owner.state,
    ["prepared", "reserved", "acquired"].includes(actualBoundary)
      ? "prepared"
      : actualBoundary === "settled"
        ? "completed"
        : "dispatched",
  );
  if (actualBoundary === "reserved")
    assert.equal(lock.status, "not_initialized");
  if (
    ["acquired", "dispatched", "written", "checkpointed"].includes(
      actualBoundary,
    )
  )
    assert.equal(lock.status, "busy");
  if (["released", "settled"].includes(actualBoundary))
    assert.equal(lock.status, "available");
  if (["checkpointed", "released", "settled"].includes(actualBoundary))
    assert.ok(checkpoint);
  if (actualBoundary === "settled") assert.ok(receipt);
  else assert.equal(receipt, undefined);
  if (actualBoundary !== "prepared") assert.ok(guard);
  hit = true;
  const temporary = `${actualReadyPath}.tmp-${process.pid}`;
  writeFileSync(
    temporary,
    JSON.stringify({
      boundary: actualBoundary,
      pid: process.pid,
      owner,
      checkpoint: checkpoint ? JSON.parse(String(checkpoint.data)) : null,
      receipt: receipt ? JSON.parse(String(receipt.data)) : null,
      guard: guard ? JSON.parse(String(guard.data)) : null,
      lock,
      first: readFileSync(join(root, "first.ts"), "utf8"),
      second: readFileSync(join(root, "second.ts"), "utf8"),
    }),
  );
  renameSync(temporary, actualReadyPath);
  // The parent kills this exact stopped producer only after reading the atomic actual evidence.
  process.kill(process.pid, "SIGSTOP");
  throw new Error(
    "A stopped original producer must never be resumed by the fixture",
  );
}
const originalPrepare = ProposalApplyStorage.prototype.prepare;
ProposalApplyStorage.prototype.prepare = function (...args) {
  const result = originalPrepare.apply(this, args);
  if (result.kind === "created") stopAt("prepared");
  return result;
};
const originalClaim = ProposalApplyStorage.prototype.claim;
ProposalApplyStorage.prototype.claim = function (...args) {
  const result = originalClaim.apply(this, args);
  stopAt("reserved");
  return result;
};
const originalFresh = PhysicalPatchProducer.prototype.assertFresh;
PhysicalPatchProducer.prototype.assertFresh = async function (...args) {
  await originalFresh.apply(this, args);
  if (inspectExecutionLock(`${dbPath}.effects.sqlite`).status === "busy")
    stopAt("acquired");
};
const originalDispatch = ProposalApplyStorage.prototype.dispatch;
ProposalApplyStorage.prototype.dispatch = function (...args) {
  const result = originalDispatch.apply(this, args);
  stopAt("dispatched");
  return result;
};
const originalCheckpoint = ProposalApplyStorage.prototype.checkpoint;
ProposalApplyStorage.prototype.checkpoint = function (...args) {
  const result = originalCheckpoint.apply(this, args);
  stopAt("checkpointed");
  return result;
};
const originalSettle = ProposalApplyStorage.prototype.settle;
ProposalApplyStorage.prototype.settle = function (...args) {
  stopAt("released");
  const result = originalSettle.apply(this, args);
  stopAt("settled");
  return result;
};
const originalOpen = fs.open.bind(fs);
fs.open = async (...args: Parameters<typeof fs.open>) => {
  const handle = await originalOpen(...args);
  if (
    targetBoundary === "written" &&
    String(args[0]) === join(process.cwd(), "first.ts") &&
    typeof args[1] === "number" &&
    (args[1] & constants.O_RDWR) !== 0
  ) {
    const write = handle.write.bind(handle);
    handle.write = (async (...writeArgs: unknown[]) => {
      const result = await Reflect.apply(write, handle, writeArgs);
      stopAt("written");
      return result;
    }) as typeof handle.write;
  }
  return handle;
};
const provider: ProviderAdapter = {
  id: "proposal-apply-zero-provider",
  async *streamTurn() {
    throw new Error("A host apply crash must not call a provider");
  },
};
engine = createEngine({
  dbPath,
  artifactDir,
  providers: [provider],
  tools: [],
  proposals: true,
  proposalApply: true,
});
const actualDb = Reflect.get(engine.store, "db");
assert.ok(actualDb instanceof DatabaseSync);
db = actualDb;
const preview = (await engine.previewProposalApply({
  workspaceId,
  proposalId,
})) as ProposalApplyPreview;
(await engine.applyProposal({
  workspaceId,
  requestId: "actual-apply-crash-request",
  approved: true,
  preview,
})) as ApplyProposalResult;
throw new Error(
  `Actual native crash boundary ${targetBoundary} was not reached`,
);
