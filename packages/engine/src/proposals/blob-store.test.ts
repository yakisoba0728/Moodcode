import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EngineError } from "@moodcode/contracts";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import {
  ProposalSourceCaptureHost,
  type PreparedProposalSourceCapture,
} from "./source-capture.js";
import {
  ProposalBlobStorage,
  validateProposalBlobDatabase,
} from "./blob-store.js";
import { PROPOSAL_SCHEMA_SQL, ProposalStorage } from "./store.js";
import type { ProposalBlobReference } from "./types.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
async function fixture(t: TestContext) {
  const root = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-proposal-blob-")),
    ),
    before = "original 한글😀\n",
    after = "pending changed 한글😀\n";
  writeFileSync(join(root, "a"), before);
  const stat = lstatSync(root, { bigint: true });
  const binding: KnowledgeHostBinding = {
    workspaceId: "native-blob-workspace",
    root,
    rootDevice: stat.dev.toString(),
    rootInode: stat.ino.toString(),
    storageBindingSha256: sha("primary"),
  };
  const db = new DatabaseSync(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON;CREATE TABLE workspaces(id TEXT PRIMARY KEY,root TEXT);",
  );
  db.prepare("INSERT INTO workspaces VALUES(?,?)").run(
    binding.workspaceId,
    root,
  );
  db.exec(PROPOSAL_SCHEMA_SQL);
  const tx = <T>(op: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = op();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const source = new ProposalSourceCaptureHost({ checkBinding: () => binding }),
    blobs = new ProposalBlobStorage(db),
    native = new ProposalStorage(db, {
      writeTx: tx,
      getWorkspace: () => ({ id: binding.workspaceId, root }),
      checkBinding: () => binding,
      readSourceCapture: (original) =>
        source.read(original as PreparedProposalSourceCapture),
      assertSourcesCurrent: (_native, original) =>
        source.assertFreshSync(original as PreparedProposalSourceCapture),
      blobs,
    });
  t.after(async () => {
    await source.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const begun = native.beginCapture({
    workspaceId: binding.workspaceId,
    requestId: randomUUID(),
    expectedHeadRevision: 0,
    operations: [
      { path: "a", expectedSha256: sha(before), after },
      { path: "absent", expectedSha256: null, after: "new file" },
    ],
  });
  assert.equal(begun.kind, "created");
  if (begun.kind !== "created") throw Error("actual new capture required");
  const capture = await source.capture(binding, [
      { path: "a", expectedSha256: sha(before), after },
      { path: "absent", expectedSha256: null, after: "new file" },
    ]),
    result = native.appendRevision(begun.capture, capture);
  source.release(capture);
  native.release(begun.capture);
  const ref = result.revision.files[0]!.before!;
  return {
    root,
    before,
    after,
    binding,
    db,
    tx,
    source,
    blobs,
    native,
    result,
    ref,
  };
}
test("actual native ProposalRevision materializes owner-bound BLOBs with bounded byte paging and full content hashes", async (t) => {
  const f = await fixture(t);
  f.tx(() => {
    const header = f.blobs.get(f.binding.workspaceId, f.ref.id)!;
    assert.equal(header.revisionId, f.result.revision.id);
    const first = f.blobs.read(f.ref, { limit: 3 });
    assert.deepEqual(
      Buffer.from(first.bytes),
      Buffer.from(f.before).subarray(0, 3),
    );
    assert.equal(first.nextOffset, 3);
    assert.equal(f.blobs.readText(f.ref), f.before);
    const rest = f.blobs.read(f.ref, { offset: 3 });
    assert.deepEqual(
      Buffer.concat([Buffer.from(first.bytes), Buffer.from(rest.bytes)]),
      Buffer.from(f.before),
    );
    assert.equal(rest.nextOffset, null);
  });
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM proposal_blobs").get()!.n,
    3,
  );
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), f.before);
  assert.throws(() => readFileSync(join(f.root, "absent")));
  validateProposalBlobDatabase(f.db, () => {});
});
test("runtime blob reads and writes require the actual primary transaction and original referenced native owner", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () => f.blobs.read(f.ref),
    code("PROPOSAL_TRANSACTION_REQUIRED"),
  );
  assert.throws(
    () => f.blobs.get(f.binding.workspaceId, f.ref.id),
    code("PROPOSAL_TRANSACTION_REQUIRED"),
  );
  f.tx(() => {
    assert.throws(
      () => f.blobs.read({ ...f.ref, role: "after" }),
      code("PROPOSAL_BLOB_SCOPE_MISMATCH"),
    );
    assert.throws(
      () => f.blobs.read({ ...f.ref, workspaceId: "different-workspace" }),
      code("PROPOSAL_BLOB_SCOPE_MISMATCH"),
    );
    assert.throws(
      () => f.blobs.read({ ...f.ref, operationIndex: 1 }),
      code("PROPOSAL_BLOB_SCOPE_MISMATCH"),
    );
  });
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM proposal_blobs").get()!.n,
    3,
  );
});
test("blob reference/options accessors and proxies are rejected without executing traps or reaching SQL body reads", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const value = Object.defineProperty({ ...f.ref }, "id", {
    enumerable: true,
    get() {
      calls++;
      return f.ref.id;
    },
  });
  assert.throws(() => f.blobs.read(value));
  const proxy = new Proxy(f.ref, {
    get() {
      calls++;
      throw Error("trap");
    },
    ownKeys() {
      calls++;
      throw Error("trap");
    },
    getPrototypeOf() {
      calls++;
      throw Error("trap");
    },
  });
  assert.throws(() => f.blobs.read(proxy));
  const options = Object.defineProperty({}, "offset", {
    enumerable: true,
    get() {
      calls++;
      return 0;
    },
  });
  assert.throws(() => f.blobs.read(f.ref, options));
  assert.equal(calls, 0);
});
test("actual negative BLOB corruption rejects before returning a page, including UTF-8 and full-content hash mismatch", async (t) => {
  const f = await fixture(t),
    body = Buffer.from(f.before);
  body[0] = 0x58;
  f.db
    .prepare("UPDATE proposal_blobs SET content=? WHERE id=?")
    .run(body, f.ref.id);
  f.tx(() =>
    assert.throws(
      () => f.blobs.read(f.ref, { limit: 1 }),
      code("PROPOSAL_BLOB_HASH_MISMATCH"),
    ),
  );
  assert.throws(
    () => validateProposalBlobDatabase(f.db, () => {}),
    code("PROPOSAL_BLOB_HASH_MISMATCH"),
  );
});
test("metadata-first oversized-header rejection loads zero content bodies", async (t) => {
  const f = await fixture(t);
  // The database validator streams by native blob ID. Select its actual first
  // producer-issued reference so unrelated valid blobs do not precede this
  // malformed metadata frontier when random UUID ordering changes.
  const first = f.db
    .prepare("SELECT id FROM proposal_blobs ORDER BY id LIMIT 1")
    .get();
  const target = f.result.revision.files
    .flatMap((file) => [file.before, file.after])
    .find(
      (ref): ref is ProposalBlobReference =>
        ref !== null && ref.id === first?.id,
    );
  assert.ok(
    target,
    "The first actual SQL blob must belong to the produced native revision",
  );
  f.db.exec("PRAGMA ignore_check_constraints=ON");
  f.db
    .prepare("UPDATE proposal_blobs SET data=? WHERE id=?")
    .run(" ".repeat(65537), target.id);
  let contentReads = 0;
  const original = f.db.prepare;
  t.mock.method(f.db, "prepare", (sql: string) => {
    if (/SELECT content FROM/u.test(sql)) contentReads++;
    return Reflect.apply(original, f.db, [sql]);
  });
  f.tx(() => assert.throws(() => f.blobs.read(target)));
  assert.equal(contentReads, 0);
  assert.throws(() => validateProposalBlobDatabase(f.db, () => {}));
  assert.equal(contentReads, 0);
});
test("self-consistent valid blob header cannot replace a different actual indexed revision reference", async (t) => {
  const f = await fixture(t);
  f.db
    .prepare("UPDATE proposal_blobs SET operation_index=1 WHERE id=?")
    .run(f.ref.id);
  f.tx(() =>
    assert.throws(
      () => f.blobs.read(f.ref),
      code("PROPOSAL_BLOB_SCOPE_MISMATCH"),
    ),
  );
  assert.throws(
    () => validateProposalBlobDatabase(f.db, () => {}),
    code("PROPOSAL_BLOB_SCOPE_MISMATCH"),
  );
});
