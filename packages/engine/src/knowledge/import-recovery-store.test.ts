import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EngineError } from "@moodcode/contracts";
import { SqliteStore } from "../storage/index.js";
import {
  KnowledgeImportRecoveryStorage,
  KNOWLEDGE_IMPORT_RECOVERY_TABLES,
  isKnowledgeImportPaused,
  readActiveKnowledgeImportActivation,
  validateKnowledgeImportRecoveryDatabase,
} from "./import-recovery-store.js";
import type { KnowledgeHostBinding } from "./types.js";
import type {
  KnowledgeImportRecoveryPreview,
  KnowledgeImportRecoveryStoragePorts,
} from "./import-recovery-types.js";
import { knowledgeHash, sha256 } from "./validation.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
function fixture(t: TestContext) {
  const root = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-native-import-")),
    ),
    dbPath = join(root, "native.sqlite");
  const store = new SqliteStore(dbPath),
    db = new DatabaseSync(dbPath);
  store.putWorkspace({
    id: "workspace",
    root,
    gitRoot: root,
    branch: null,
    createdAt: new Date().toISOString(),
  });
  const state = {
    now: Date.now(),
    bindingReads: 0,
    checks: 0,
    bindingSuffix: "",
    beforeCommit: undefined as
      ((p: KnowledgeImportRecoveryPreview) => void) | undefined,
  };
  const binding = (): KnowledgeHostBinding => {
    state.bindingReads++;
    const stat = lstatSync(root, { bigint: true });
    return {
      workspaceId: "workspace",
      root,
      rootDevice: String(stat.dev),
      rootInode: String(stat.ino),
      storageBindingSha256: sha256(dbPath + state.bindingSuffix),
    };
  };
  const writeTx: KnowledgeImportRecoveryStoragePorts["writeTx"] = (
    operation,
  ) => {
    if (db.isTransaction) return operation();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const ports: KnowledgeImportRecoveryStoragePorts = {
    writeTx,
    getWorkspace: (id) => ({ id, root }),
    checkBinding: () => binding(),
    assertCommitCurrent: (p) => {
      assert.equal(db.isTransaction, true);
      state.checks++;
      state.beforeCommit?.(p);
    },
    now: () => state.now,
  };
  const native = new KnowledgeImportRecoveryStorage(db, ports),
    originalBinding = binding();
  store.pauseImportedWorkspaceKnowledge(
    "workspace",
    sha256("actual-import-archive"),
  );
  const rawPause = JSON.parse(
    String(
      db
        .prepare("SELECT data FROM knowledge_import_pauses WHERE id=?")
        .get("workspace")!.data,
    ),
  );
  const request = {
    workspaceId: "workspace",
    importId: randomUUID(),
    archiveSha256: rawPause.archiveSha256,
    sourcePrimaryLogicalSha256: sha256("source-primary-logical"),
    sourceStorageBindingSha256: originalBinding.storageBindingSha256,
    originalBinding,
    pauseSha256: knowledgeHash(rawPause),
  };
  const frontier = native.seedImport(request);
  const preview = (operation: "resume" | "acknowledge" = "resume") =>
    native.preview({
      workspaceId: "workspace",
      operation,
      expiresAt: new Date(state.now + 30_000).toISOString(),
    });
  const historical = () =>
    String(
      db
        .prepare("SELECT data FROM knowledge_import_pauses WHERE id=?")
        .get("workspace")!.data,
    );
  const rows = () =>
    Object.fromEntries(
      KNOWLEDGE_IMPORT_RECOVERY_TABLES.map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
      ]),
    );
  t.after(async () => {
    db.close();
    await store.closeAsync();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    dbPath,
    store,
    db,
    state,
    ports,
    binding,
    native,
    request,
    frontier,
    preview,
    historical,
    rows,
  };
}

test("native seed/resume preserves raw paused history and resume does not activate a document", (t) => {
  const f = fixture(t),
    raw = f.historical();
  assert.equal(isKnowledgeImportPaused(f.db, "workspace"), true);
  const preview = f.preview(),
    result = f.native.commit(preview, {
      requestId: "resume",
      approved: true,
      reason: "host explicit resume",
    });
  assert.equal(result.decision.operation, "resume");
  assert.equal(result.activation, null);
  assert.equal(result.frontier.head.state, "resumed");
  assert.equal(f.historical(), raw);
  assert.equal(isKnowledgeImportPaused(f.db, "workspace"), false);
  assert.equal(
    readActiveKnowledgeImportActivation(f.db, "workspace", "missing"),
    undefined,
  );
  assert.equal(f.state.checks, 1);
  assert.equal(
    f.native.getResumeDecision("workspace")!.sha256,
    result.decision.sha256,
  );
  validateKnowledgeImportRecoveryDatabase(f.db);
});
test("a backwards clock step between native decisions keeps their timestamps ordered", (t) => {
  const f = fixture(t),
    acknowledged = f.native.commit(f.preview("acknowledge"), {
      requestId: "acknowledge",
      approved: true,
      reason: "host acknowledged imported uncertainty",
    });
  f.state.now -= 60_000;
  const resumed = f.native.commit(f.preview(), {
    requestId: "resume",
    approved: true,
    reason: "host explicit resume",
  });
  assert.equal(resumed.decision.createdAt, acknowledged.decision.createdAt);
  assert.equal(isKnowledgeImportPaused(f.db, "workspace"), false);
  validateKnowledgeImportRecoveryDatabase(f.db);
});
test("activation rejects when a backwards clock step floors its commit time at or past the proof expiry", (t) => {
  const f = fixture(t),
    resumed = f.native.commit(f.preview(), {
      requestId: "resume",
      approved: true,
      reason: "host explicit resume",
    });
  f.state.now -= 60_000;
  const p = f.native.preview({
      workspaceId: "workspace",
      operation: "activate",
      documentProof: {
        documentKey: "document",
        headRevision: 1,
        headSha256: sha256("head"),
        documentRevisionId: "document-revision",
        documentSha256: sha256("document"),
        publicationId: "publication",
        publicationSha256: sha256("publication"),
        receiptId: "receipt",
        receiptSha256: sha256("receipt"),
        provenanceSha256: sha256("provenance"),
        sourceManifestSha256: sha256("source-manifest"),
        originalBinding: f.binding(),
        currentTrustId: "trust",
        currentTrustRevision: 1,
        currentTrustSha256: sha256("trust"),
        expiresAt: resumed.decision.createdAt,
      },
      expiresAt: new Date(f.state.now + 30_000).toISOString(),
    }),
    before = f.rows();
  assert.throws(
    () =>
      f.native.commit(p, {
        requestId: "activate",
        approved: true,
        reason: "host explicit activation",
      }),
    code("KNOWLEDGE_IMPORT_RECOVERY_EXPIRED"),
  );
  assert.deepEqual(f.rows(), before);
  assert.equal(
    readActiveKnowledgeImportActivation(f.db, "workspace", "document"),
    undefined,
  );
  validateKnowledgeImportRecoveryDatabase(f.db);
});
test("exact historical duplicate remains observable after release/expiry/binding change without another approval callback", (t) => {
  const f = fixture(t),
    p = f.preview(),
    input = {
      requestId: "same-request",
      approved: true as const,
      reason: "approved once",
    };
  const first = f.native.commit(p, input);
  f.native.release(p);
  f.state.now += 100_000;
  f.state.bindingSuffix = "new-storage";
  const checks = f.state.checks,
    reads = f.state.bindingReads;
  assert.deepEqual(f.native.commit({ ...p }, input).decision, first.decision);
  assert.equal(f.state.checks, checks);
  assert.equal(f.state.bindingReads, reads);
  assert.throws(
    () => f.native.commit(p, { ...input, reason: "different approval" }),
    code("KNOWLEDGE_IMPORT_RECOVERY_REQUEST_CONFLICT"),
  );
  assert.equal(f.state.checks, checks);
});
test("copied/foreign/released original previews never authorize a new native decision", (t) => {
  const f = fixture(t),
    p = f.preview(),
    before = f.rows(),
    input = {
      requestId: "resume",
      approved: true as const,
      reason: "approved",
    };
  assert.throws(
    () => f.native.commit({ ...p }, input),
    code("KNOWLEDGE_IMPORT_RECOVERY_CAPTURE_INVALID"),
  );
  const foreign = new KnowledgeImportRecoveryStorage(f.db, f.ports);
  assert.throws(
    () => foreign.commit(p, input),
    code("KNOWLEDGE_IMPORT_RECOVERY_CAPTURE_INVALID"),
  );
  f.native.release(p);
  assert.throws(
    () => f.native.commit(p, input),
    code("KNOWLEDGE_IMPORT_RECOVERY_CAPTURE_INVALID"),
  );
  assert.deepEqual(f.rows(), before);
  assert.equal(f.state.checks, 0);
});
test("concurrent original previews CAS the exact native frontier and losing preview writes nothing", (t) => {
  const f = fixture(t),
    first = f.preview(),
    second = f.preview();
  f.native.commit(first, {
    requestId: "first",
    approved: true,
    reason: "approved",
  });
  const before = f.rows();
  assert.throws(
    () =>
      f.native.commit(second, {
        requestId: "second",
        approved: true,
        reason: "approved",
      }),
    code("KNOWLEDGE_IMPORT_RECOVERY_STALE"),
  );
  assert.deepEqual(f.rows(), before);
  assert.equal(f.state.checks, 1);
});
test("approval callback rollback preserves original pause/head and emits no partial receipt", (t) => {
  const f = fixture(t),
    p = f.preview(),
    before = f.rows();
  f.state.beforeCommit = () => {
    throw new EngineError("ACTUAL_HOST_PROOF_CHANGED", "Host source changed");
  };
  assert.throws(
    () =>
      f.native.commit(p, {
        requestId: "blocked",
        approved: true,
        reason: "approved",
      }),
    code("ACTUAL_HOST_PROOF_CHANGED"),
  );
  assert.deepEqual(f.rows(), before);
  assert.equal(isKnowledgeImportPaused(f.db, "workspace"), true);
  f.state.beforeCommit = undefined;
  assert.equal(
    f.native.commit(p, {
      requestId: "blocked",
      approved: true,
      reason: "approved",
    }).decision.operation,
    "resume",
  );
});
test("SQL failure after native decision insertion atomically rolls receipt/head back", (t) => {
  const f = fixture(t),
    p = f.preview(),
    before = f.rows();
  f.db.exec(
    "CREATE TRIGGER reject_import_head BEFORE UPDATE ON knowledge_import_frontier_heads BEGIN SELECT RAISE(ABORT,'reject actual head'); END",
  );
  assert.throws(() =>
    f.native.commit(p, {
      requestId: "rollback",
      approved: true,
      reason: "approved",
    }),
  );
  assert.deepEqual(f.rows(), before);
  f.db.exec("DROP TRIGGER reject_import_head");
  assert.equal(
    f.native.commit(p, {
      requestId: "rollback",
      approved: true,
      reason: "approved",
    }).frontier.head.state,
    "resumed",
  );
});
test("clock expiration during synchronous host proof rejects before any native receipt", (t) => {
  const f = fixture(t),
    p = f.preview(),
    before = f.rows();
  f.state.beforeCommit = () => {
    f.state.now = Date.parse(p.expiresAt);
  };
  assert.throws(
    () =>
      f.native.commit(p, {
        requestId: "expired",
        approved: true,
        reason: "approved",
      }),
    code("KNOWLEDGE_IMPORT_RECOVERY_EXPIRED"),
  );
  assert.deepEqual(f.rows(), before);
});
test("reimport appends fresh lineage and invalidates previous resume without modifying its receipt", (t) => {
  const f = fixture(t),
    p = f.preview(),
    first = f.native.commit(p, {
      requestId: "old-resume",
      approved: true,
      reason: "approved",
    });
  const old = f.native.findRequest("workspace", "old-resume");
  const second = f.native.seedImport({ ...f.request, importId: randomUUID() });
  assert.notEqual(second.id, f.frontier.id);
  assert.equal(isKnowledgeImportPaused(f.db, "workspace"), true);
  assert.equal(f.native.getResumeDecision("workspace"), undefined);
  assert.deepEqual(f.native.findRequest("workspace", "old-resume"), old);
  assert.deepEqual(
    f.native.commit(p, {
      requestId: "old-resume",
      approved: true,
      reason: "approved",
    }).decision,
    first.decision,
  );
  validateKnowledgeImportRecoveryDatabase(f.db);
});
test("same import identity deduplicates without physical root access and conflicting lineage rejects", (t) => {
  const f = fixture(t),
    reads = f.state.bindingReads;
  assert.deepEqual(f.native.seedImport(f.request), f.frontier);
  assert.equal(f.state.bindingReads, reads);
  assert.throws(
    () =>
      f.native.seedImport({
        ...f.request,
        sourcePrimaryLogicalSha256: sha256("other"),
      }),
    code("KNOWLEDGE_IMPORT_RECOVERY_REQUEST_CONFLICT"),
  );
  const missing = new KnowledgeImportRecoveryStorage(f.db, {
    ...f.ports,
    checkBinding: () => {
      throw new Error("Missing physical root");
    },
  });
  assert.ok(
    missing.seedImport({
      ...f.request,
      importId: randomUUID(),
      originalBinding: null,
    }),
  );
  assert.equal(f.state.bindingReads, reads);
});
test("native hostile inputs reject proxy/accessor traps before physical/graph callbacks", (t) => {
  const f = fixture(t);
  let traps = 0,
    getters = 0;
  const input = {
    workspaceId: "workspace",
    operation: "resume" as const,
    expiresAt: new Date(f.state.now + 30_000).toISOString(),
  };
  const reads = f.state.bindingReads;
  assert.throws(() =>
    f.native.preview(
      new Proxy(input, {
        getOwnPropertyDescriptor() {
          traps++;
          throw new Error("Proxy metadata");
        },
      }),
    ),
  );
  Object.defineProperty(input, "operation", {
    enumerable: true,
    get() {
      getters++;
      throw new Error("Input getter");
    },
  });
  assert.throws(() => f.native.preview(input));
  assert.equal(traps, 0);
  assert.equal(getters, 0);
  assert.equal(f.state.bindingReads, reads);
  assert.equal(f.state.checks, 0);
});
test("oversized native row metadata rejects before allocating its body or invoking approval checks", (t) => {
  const f = fixture(t);
  f.db.exec("PRAGMA ignore_check_constraints=ON");
  f.db
    .prepare("UPDATE knowledge_import_frontiers SET data=? WHERE id=?")
    .run("x".repeat(65_537), f.frontier.id);
  assert.throws(
    () => f.native.getFrontier("workspace"),
    code("KNOWLEDGE_IMPORT_RECOVERY_READ_LIMIT"),
  );
  assert.equal(f.state.checks, 0);
});
test("reopen restores historical resume only and never revives original approval captures", (t) => {
  const f = fixture(t),
    p = f.preview(),
    decision = f.native.commit(p, {
      requestId: "resume",
      approved: true,
      reason: "approved",
    }).decision;
  const reopened = new KnowledgeImportRecoveryStorage(f.db, f.ports);
  assert.equal(
    reopened.getResumeDecision("workspace")!.sha256,
    decision.sha256,
  );
  assert.throws(
    () =>
      reopened.commit(p, {
        requestId: "new-request",
        approved: true,
        reason: "approved",
      }),
    code("KNOWLEDGE_IMPORT_RECOVERY_CAPTURE_INVALID"),
  );
  assert.equal(f.state.checks, 1);
});

test("actual indexed head corruption is rejected despite a still-valid body signature", (t) => {
  const f = fixture(t);
  f.db
    .prepare(
      "UPDATE knowledge_import_frontier_heads SET revision=revision+1 WHERE id=?",
    )
    .run("workspace");
  assert.throws(
    () => f.native.getFrontier("workspace"),
    code("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT"),
  );
  assert.throws(
    () => validateKnowledgeImportRecoveryDatabase(f.db),
    code("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT"),
  );
  assert.equal(f.state.checks, 0);
});
test("bounded malformed native JSON has a typed error and grants no resume", (t) => {
  const f = fixture(t);
  f.db
    .prepare("UPDATE knowledge_import_frontiers SET data=? WHERE id=?")
    .run('{"bad":', f.frontier.id);
  assert.throws(
    () => f.native.getFrontier("workspace"),
    code("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT"),
  );
  assert.equal(f.state.checks, 0);
});
test("original preview capacity is bounded and release provides capacity without a decision or authority transfer", (t) => {
  const f = fixture(t),
    owners = Array.from({ length: 128 }, () => f.preview());
  const before = f.rows();
  assert.throws(() => f.preview(), code("KNOWLEDGE_IMPORT_RECOVERY_LIMIT"));
  f.native.release(owners[0]!);
  const replacement = f.preview();
  assert.deepEqual(f.rows(), before);
  assert.equal(f.state.checks, 0);
  assert.throws(
    () =>
      f.native.commit(owners[0]!, {
        requestId: "released",
        approved: true,
        reason: "approved",
      }),
    code("KNOWLEDGE_IMPORT_RECOVERY_CAPTURE_INVALID"),
  );
  for (const owner of owners.slice(1)) f.native.release(owner);
  f.native.release(replacement);
});
test("an async trusted proof callback cannot escape the primary transaction or append a decision", (t) => {
  const f = fixture(t),
    native = new KnowledgeImportRecoveryStorage(f.db, {
      ...f.ports,
      assertCommitCurrent: (() =>
        Promise.resolve()) as unknown as KnowledgeImportRecoveryStoragePorts["assertCommitCurrent"],
    });
  const p = native.preview({
      workspaceId: "workspace",
      operation: "resume",
      expiresAt: new Date(f.state.now + 30_000).toISOString(),
    }),
    before = f.rows();
  assert.throws(
    () =>
      native.commit(p, {
        requestId: "async",
        approved: true,
        reason: "approved",
      }),
    code("INVALID_KNOWLEDGE_IMPORT_RECOVERY_PORTS"),
  );
  assert.deepEqual(f.rows(), before);
  native.release(p);
});
