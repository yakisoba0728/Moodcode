import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { knowledgeHash } from "../knowledge/validation.js";
import { validateProposalApplyDatabase } from "./apply-store.js";
import { validateProposalDatabase } from "./store.js";
import { applyFixture, SECOND_AFTER, SECOND_BEFORE } from "./fixtures/apply.js";

function actualDb(
  engine: Awaited<ReturnType<typeof applyFixture>>["engine"],
): DatabaseSync {
  const db = Reflect.get(engine.store, "db");
  assert.ok(db instanceof DatabaseSync);
  return db;
}
function signed<T extends { readonly sha256: string }>(record: T): T {
  const { sha256, ...body } = record;
  return { ...body, sha256: knowledgeHash(body) } as T;
}

test("actual completed apply graph validates, but removing declared terminal checkpoint and receipt must reject", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const result = await f.apply(await f.preview(), "missing-terminal-proof"),
    db = actualDb(f.engine);
  assert.ok(result.checkpoint);
  assert.ok(result.receipt);
  assert.doesNotThrow(() => validateProposalApplyDatabase(db));
  db.prepare("DELETE FROM proposal_apply_receipts WHERE id=?").run(
    result.owner.id,
  );
  db.prepare("DELETE FROM proposal_apply_checkpoints WHERE id=?").run(
    result.owner.id,
  );
  // Authored negative corruption only. The positive owner/result came from the original native producer.
  assert.throws(() => validateProposalApplyDatabase(db));
  f.assertNoCoding();
});

test("actual completed receipt cannot substitute a self-consistent different original approval head", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const result = await f.apply(await f.preview(), "receipt-before-head"),
    db = actualDb(f.engine);
  assert.ok(result.receipt);
  assert.doesNotThrow(() => validateProposalApplyDatabase(db));
  const beforeHead = signed({
    ...result.receipt.beforeHead,
    updatedAt: new Date(
      Date.parse(result.receipt.beforeHead.updatedAt) + 1,
    ).toISOString(),
  });
  const receipt = signed({ ...result.receipt, beforeHead });
  db.prepare("UPDATE proposal_apply_receipts SET data=? WHERE id=?").run(
    JSON.stringify(receipt),
    result.owner.id,
  );
  assert.throws(() => validateProposalApplyDatabase(db));
  f.assertNoCoding();
});

test("actual partial effect blobs remain valid but an extra self-consistent orphan effect blob must reject", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const preview = await f.preview(),
    open = fs.open.bind(fs);
  let originalWriteObserved = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (
      String(args[0]) === join(f.root, "second.ts") &&
      typeof args[1] === "number" &&
      (args[1] & constants.O_RDWR) !== 0
    ) {
      const write = handle.write.bind(handle);
      t.mock.method(handle, "write", async (...writeArgs: unknown[]) => {
        const observed = await Reflect.apply(write, handle, writeArgs);
        originalWriteObserved = true;
        return observed;
      });
      t.mock.method(handle, "truncate", async () => {
        assert.equal(originalWriteObserved, true);
        throw new Error("Owned syscall failure after original write");
      });
    }
    return handle;
  });
  const result = await f.apply(preview, "orphan-effect-blob"),
    db = actualDb(f.engine);
  assert.equal(result.owner.state, "partial");
  assert.ok(result.checkpoint);
  assert.equal(
    result.checkpoint.files[1]!.after?.sha256,
    createTextHash(
      SECOND_AFTER + SECOND_BEFORE.slice(Buffer.byteLength(SECOND_AFTER)),
    ),
  );
  assert.doesNotThrow(() => validateProposalDatabase(db));
  assert.doesNotThrow(() => validateProposalApplyDatabase(db));
  const original = db
    .prepare("SELECT * FROM proposal_effect_blobs ORDER BY id LIMIT 1")
    .get();
  assert.ok(original);
  const header = JSON.parse(String(original.data));
  header.id = randomUUID();
  const { headerSha256, ...body } = header;
  header.headerSha256 = knowledgeHash(body);
  db.prepare(
    "INSERT INTO proposal_effect_blobs(id,workspace_id,owner_id,checkpoint_id,file_index,sha256,bytes,header_sha256,data,content) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    header.id,
    original.workspace_id!,
    original.owner_id!,
    original.checkpoint_id!,
    original.file_index!,
    original.sha256!,
    original.bytes!,
    header.headerSha256,
    JSON.stringify(header),
    original.content!,
  );
  assert.throws(() => validateProposalApplyDatabase(db));
  f.assertNoCoding();
});

test("self-consistent terminal graph cannot claim completed when an observed postimage differs from the original desired image", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const result = await f.apply(await f.preview(), "completed-postimage"),
    db = actualDb(f.engine);
  assert.ok(result.checkpoint);
  assert.ok(result.receipt);
  assert.ok(result.checkpoint.files[0]!.after);
  assert.doesNotThrow(() => validateProposalApplyDatabase(db));
  const checkpoint = signed({
    ...result.checkpoint,
    files: result.checkpoint.files.map((file, index) =>
      index === 0 ? { ...file, after: null } : file,
    ),
  });
  const owner = signed({
    ...result.owner,
    checkpointSha256: checkpoint.sha256,
  });
  const afterHead = signed({
    ...result.receipt.afterHead,
    applySettlement: {
      ...result.receipt.afterHead.applySettlement!,
      ownerSha256: owner.sha256,
      checkpointSha256: checkpoint.sha256,
    },
  });
  const receipt = signed({
    ...result.receipt,
    checkpointSha256: checkpoint.sha256,
    afterHead,
  });
  db.prepare("UPDATE proposal_apply_checkpoints SET data=? WHERE id=?").run(
    JSON.stringify(checkpoint),
    owner.id,
  );
  db.prepare("UPDATE proposal_apply_owners SET data=? WHERE id=?").run(
    JSON.stringify(owner),
    owner.id,
  );
  db.prepare("UPDATE proposal_apply_receipts SET data=? WHERE id=?").run(
    JSON.stringify(receipt),
    owner.id,
  );
  db.prepare("UPDATE proposal_heads SET data=? WHERE id=?").run(
    JSON.stringify(afterHead),
    owner.proposalId,
  );
  assert.throws(() => validateProposalApplyDatabase(db));
  f.assertNoCoding();
});

function createTextHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("current terminal head must resolve its exact actual settlement owner, not an orphan hash-consistent tuple", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const result = await f.apply(await f.preview(), "head-settlement-owner"),
    db = actualDb(f.engine);
  assert.ok(result.receipt);
  assert.doesNotThrow(() => validateProposalApplyDatabase(db));
  const foreignId = randomUUID(),
    head = signed({
      ...result.receipt.afterHead,
      applySettlement: {
        ...result.receipt.afterHead.applySettlement!,
        ownerId: foreignId,
        checkpointId: foreignId,
        receiptId: foreignId,
      },
    });
  db.prepare("UPDATE proposal_heads SET data=? WHERE id=?").run(
    JSON.stringify(head),
    result.owner.proposalId,
  );
  assert.doesNotThrow(() => validateProposalDatabase(db));
  assert.throws(() => validateProposalApplyDatabase(db));
  f.assertNoCoding();
});

test("apply validation rejects a current head whose revision column disagrees with its sealed body", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const result = await f.apply(await f.preview(), "head-column-mismatch"),
    db = actualDb(f.engine);
  assert.doesNotThrow(() => validateProposalApplyDatabase(db));
  db.prepare("UPDATE proposal_heads SET revision=revision+1 WHERE id=?").run(
    result.owner.proposalId,
  );
  assert.throws(() => validateProposalApplyDatabase(db), {
    code: "PROPOSAL_APPLY_SCOPE_MISMATCH",
  });
  f.assertNoCoding();
});
