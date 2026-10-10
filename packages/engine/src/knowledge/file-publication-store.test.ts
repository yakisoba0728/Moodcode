import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EngineError } from "@moodcode/contracts";
import { KnowledgeStorage, KNOWLEDGE_SCHEMA_SQL } from "./store.js";
import {
  KnowledgeGenerationStorage,
  KNOWLEDGE_GENERATION_SCHEMA_SQL,
} from "./generation-store.js";
import { normalizeKnowledgeGenerationBudget } from "./generation-budget.js";
import {
  KnowledgeFilePublicationStorage,
  KNOWLEDGE_FILE_PUBLICATION_SCHEMA_SQL,
  hasKnowledgeFilePublicationBlocker,
  validateKnowledgeFilePublicationDatabase,
} from "./file-publication-store.js";
import { knowledgeHash, sha256 } from "./validation.js";
import type {
  KnowledgeCandidate,
  KnowledgeHostBinding,
  KnowledgeStoragePorts,
} from "./types.js";
import type {
  FilePhysicalObservation,
  KnowledgeFilePublicationStoragePorts,
  KnowledgeFilePublicationRecord,
  PrepareKnowledgeFilePublication,
} from "./file-publication-types.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
function fixture(t: TestContext) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-file-native-")),
    ),
    root = join(base, "workspace"),
    file = join(base, "native.sqlite");
  mkdirSync(root);
  let db = new DatabaseSync(file);
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE workspaces(id TEXT PRIMARY KEY,root TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO workspaces VALUES(?,?)").run("workspace", root);
  db.exec(KNOWLEDGE_SCHEMA_SQL);
  db.exec(KNOWLEDGE_GENERATION_SCHEMA_SQL);
  db.exec(
    "CREATE UNIQUE INDEX candidate_identity ON knowledge_candidates(workspace_id,id)",
  );
  db.exec(KNOWLEDGE_FILE_PUBLICATION_SCHEMA_SQL);
  writeFileSync(join(root, "source.ts"), "export const fact=1;\n");
  const state = {
    now: Date.parse("2026-10-08T04:00:00.000Z"),
    bindingReads: 0,
    currentChecks: 0,
    recoveryChecks: 0,
    bindingSuffix: "",
    beforeCurrent: undefined as
      | ((
          r: KnowledgeFilePublicationRecord,
          phase: "dispatch" | "complete",
        ) => void)
      | undefined,
    beforeRecovery: undefined as (() => void) | undefined,
  };
  const binding = (): KnowledgeHostBinding => {
    state.bindingReads++;
    const m = lstatSync(root, { bigint: true });
    return {
      workspaceId: "workspace",
      root,
      rootDevice: String(m.dev),
      rootInode: String(m.ino),
      storageBindingSha256: sha256(file + state.bindingSuffix),
    };
  };
  const writeTx: KnowledgeFilePublicationStoragePorts["writeTx"] = (op) => {
    if (db.isTransaction) return op();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = op();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const observe = (path = "MEMORY.md"): FilePhysicalObservation => {
    const rootStat = lstatSync(root, { bigint: true }),
      present = existsSync(join(root, path)),
      stat = present ? lstatSync(join(root, path), { bigint: true }) : null,
      body = present ? readFileSync(join(root, path), "utf8") : null;
    return {
      binding: binding(),
      path,
      present,
      sha256: body === null ? null : sha256(body),
      bytes: body === null ? 0 : Buffer.byteLength(body),
      device: stat ? String(stat.dev) : null,
      inode: stat ? String(stat.ino) : null,
      mode: stat ? Number(stat.mode) : null,
      mtimeNs: stat ? String(stat.mtimeNs) : null,
      ctimeNs: stat ? String(stat.ctimeNs) : null,
      parentPins: [
        {
          path: ".",
          device: String(rootStat.dev),
          inode: String(rootStat.ino),
          mode: Number(rootStat.mode),
          mtimeNs: String(rootStat.mtimeNs),
          ctimeNs: String(rootStat.ctimeNs),
        },
      ],
      missingParents: [],
    };
  };
  let native!: KnowledgeGenerationStorage,
    store!: KnowledgeFilePublicationStorage,
    knowledge!: KnowledgeStorage;
  const knowledgePorts: KnowledgeStoragePorts = {
    writeTx,
    getWorkspace: (id) => ({ id, root }),
    checkHostBinding: () => binding(),
    assertTrustSourcesCurrent: () => {},
    assertSourcesCurrent: (_binding, source) => {
      for (const pin of source.pins)
        if (
          pin.kind === "file" &&
          sha256(readFileSync(join(root, pin.path), "utf8")) !== pin.sha256
        )
          throw new EngineError(
            "KNOWLEDGE_SOURCE_CHANGED",
            "Actual source changed",
          );
    },
    assertTargetCurrent: (_binding, target) => {
      if (target.kind !== "workspace-file")
        throw new Error("Actual file target expected");
      const observed = observe(target.path),
        current = store.captureTarget(binding(), observed);
      if (
        current.revision !== target.revision ||
        observed.sha256 !== target.sha256
      )
        throw new EngineError(
          "KNOWLEDGE_TARGET_CHANGED",
          "Actual target changed",
        );
    },
    readGenerationEvidence: (plan, owner) => native.readEvidence(plan, owner),
    now: () => state.now,
  };
  const ports: KnowledgeFilePublicationStoragePorts = {
    writeTx,
    getWorkspace: (id) => ({ id, root }),
    checkBinding: () => binding(),
    getCandidate: (ws, id) => knowledge.getCandidate(ws, id),
    assertCommitCurrent: (record, phase) => {
      state.currentChecks++;
      state.beforeCurrent?.(record, phase);
    },
    beforeRecoveryDecision: () => {
      state.recoveryChecks++;
      state.beforeRecovery?.();
    },
    now: () => state.now,
  };
  const connect = () => {
    knowledge = new KnowledgeStorage(db, knowledgePorts);
    native = new KnowledgeGenerationStorage(db, {
      writeTx,
      getWorkspace: (id) => ({ id, root }),
      getPlan: (ws, id) => knowledge.getGenerationPlan(ws, id),
      checkBinding: () => binding(),
      assertPlanCurrent: (p) => knowledge.assertGenerationPlanCurrent(p),
      now: () => state.now,
    });
    store = new KnowledgeFilePublicationStorage(db, ports);
  };
  connect();
  knowledge.setTrust({
    workspaceId: "workspace",
    requestId: "trust",
    expectedRevision: 0,
    decision: "allow",
    binding: binding(),
    sources: [],
    expiresAt: null,
  });
  function candidate(body = "Approved project fact.\n"): KnowledgeCandidate {
    const target = store.captureTarget(binding(), observe()),
      source = readFileSync(join(root, "source.ts"), "utf8"),
      m = lstatSync(join(root, "source.ts"), { bigint: true });
    const plan = knowledge.prepareGeneration({
      workspaceId: "workspace",
      requestId: randomUUID(),
      binding: binding(),
      expectedTrustRevision: knowledge.getTrust("workspace")!.revision,
      source: {
        projection: "host-selected-text-v1",
        sha256: sha256(source),
        bytes: Buffer.byteLength(source),
        pins: [
          {
            kind: "file",
            path: "source.ts",
            sha256: sha256(source),
            bytes: Buffer.byteLength(source),
            device: String(m.dev),
            inode: String(m.ino),
          },
        ],
      },
      target: {
        kind: "workspace-file",
        path: "MEMORY.md",
        revision: target.revision,
        sha256: target.observation.sha256,
        device: target.observation.device,
        inode: target.observation.inode,
      },
      providerId: "scripted-owner",
      modelId: "authored",
      requestSha256: sha256(source + body),
      requestBytes: Buffer.byteLength(source + body),
      maxOutputBytes: 16384,
      expiresAt: new Date(state.now + 60000).toISOString(),
    });
    const admitted = native.create({
      workspaceId: "workspace",
      planId: plan.id,
      requestId: randomUUID(),
      budget: normalizeKnowledgeGenerationBudget(),
      logicalRequestSha256: plan.requestSha256,
      logicalRequestBytes: plan.requestBytes,
    });
    if (admitted.kind !== "created")
      throw new Error("Actual original generation required");
    const attempt = native.prepareAttempt(admitted.capture, {
      id: randomUUID(),
      sha256: sha256("actual tools-free authored envelope"),
      bytes: 64,
    });
    native.dispatch(admitted.capture, attempt.capture);
    native.observe(admitted.capture, attempt.capture, {
      textDelta: body,
      observationBytes: Buffer.byteLength(body),
      eventCount: 1,
    });
    native.observe(admitted.capture, attempt.capture, {
      finishReason: "stop",
      observationBytes: 1,
      eventCount: 2,
    });
    native.observe(admitted.capture, attempt.capture, {
      streamDone: true,
      observationBytes: 0,
      eventCount: 2,
    });
    native.settle(admitted.capture, attempt.capture, {
      state: "completed",
      cleanup: { confirmed: true, method: "iterator-complete", reason: null },
    });
    const handle = knowledge.attachGenerationOwner(
        "workspace",
        plan.id,
        admitted.record.id,
      ),
      result = knowledge.appendCandidate(handle, {
        requestId: randomUUID(),
        body,
      });
    knowledge.releaseGenerationOwner(handle);
    native.markCandidate("workspace", admitted.record.id, {
      state: "recorded",
      candidateId: result.id,
    });
    native.releaseAttempt(attempt.capture);
    native.release(admitted.capture);
    return result;
  }
  function input(
    selected = candidate(),
    requestId = randomUUID(),
  ): PrepareKnowledgeFilePublication {
    const gen = native.getGeneration("workspace", selected.generationOwnerId),
      attempt = native.getAttempt("workspace", gen.attemptId!),
      plan = knowledge.getGenerationPlan("workspace", selected.planId)!,
      trust = knowledge.getTrustRevision(
        "workspace",
        selected.trustRevisionId,
      )!,
      target = store.captureTarget(binding(), observe());
    return {
      workspaceId: "workspace",
      requestId,
      operation: "publish",
      binding: binding(),
      path: "MEMORY.md",
      expectedTarget: target,
      provenance: {
        candidateId: selected.id,
        candidateSha256: selected.sha256,
        generationId: gen.id,
        generationSha256: gen.sha256,
        attemptId: attempt.id,
        attemptSha256: attempt.sha256,
        planId: plan.id,
        planSha256: plan.sha256,
        trustRevisionId: trust.id,
        trustRevisionSha256: trust.sha256,
      },
      existingPublicationId: null,
      existingPublicationSha256: null,
      body: selected.body,
      bodySha256: selected.bodySha256,
      beforeContent: target.observation.present
        ? readFileSync(join(root, "MEMORY.md"), "utf8")
        : null,
      expiresAt: new Date(state.now + 30000).toISOString(),
      deadline: state.now + 30000,
    };
  }
  const prepare = (request = input()) => {
    const result = store.prepare(request);
    assert.equal(result.kind, "created");
    if (result.kind !== "created") throw new Error("Original owner required");
    return { ...result, request };
  };
  const apply = (prepared = prepare()) => {
    store.dispatch(prepared.capture);
    writeFileSync(join(root, "MEMORY.md"), prepared.request.body!);
    return {
      ...prepared,
      result: store.complete(prepared.capture, {
        after: observe(),
        checkpoint: {
          createdParents: [],
          createdFiles: [".moodcode-tmp", "MEMORY.md"],
          removedFiles: [".moodcode-tmp"],
          replacedFiles: [],
          partial: false,
        },
        cleanup: { confirmed: true, reason: null },
      }),
    };
  };
  const reopen = () => {
    db.close();
    db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys=ON");
    connect();
  };
  t.after(() => {
    db.close();
    rmSync(base, { recursive: true, force: true });
  });
  return {
    root,
    binding,
    observe,
    state,
    input,
    prepare,
    apply,
    candidate,
    reopen,
    writeTx,
    get db() {
      return db;
    },
    get store() {
      return store;
    },
    get knowledge() {
      return knowledge;
    },
  };
}

test("physical heads preserve stable observations and positive absent ABA tombstones", (t) => {
  const f = fixture(t);
  const absent = f.store.captureTarget(f.binding(), f.observe());
  assert.equal(absent.revision, 0);
  assert.equal(f.store.getCurrentTarget("workspace", "MEMORY.md"), undefined);
  writeFileSync(join(f.root, "MEMORY.md"), "one");
  const first = f.store.captureTarget(f.binding(), f.observe());
  assert.equal(first.revision, 1);
  assert.deepEqual(f.store.captureTarget(f.binding(), f.observe()), first);
  writeFileSync(join(f.root, "MEMORY.md"), "two");
  assert.equal(f.store.captureTarget(f.binding(), f.observe()).revision, 2);
  unlinkSync(join(f.root, "MEMORY.md"));
  const tombstone = f.store.captureTarget(f.binding(), f.observe());
  assert.equal(tombstone.revision, 3);
  assert.equal(tombstone.observation.present, false);
  assert.deepEqual(f.store.captureTarget(f.binding(), f.observe()), tombstone);
  validateKnowledgeFilePublicationDatabase(f.db);
});
test("original owner dispatch and atomic immutable checkpoint/receipt/head are exact", (t) => {
  const f = fixture(t),
    published = f.apply();
  assert.equal(published.result.publication.state, "completed");
  assert.equal(published.result.target.revision, 1);
  assert.equal(published.result.checkpoint.effects.partial, false);
  assert.deepEqual(published.result.checkpoint.effects.createdFiles, [
    ".moodcode-tmp",
    "MEMORY.md",
  ]);
  assert.equal(
    published.result.receipt.requestSha256,
    knowledgeHash(published.request),
  );
  assert.deepEqual(
    f.store.getCommitted("workspace", published.record.id),
    published.result,
  );
  assert.equal(f.store.hasBlocker("workspace"), false);
  validateKnowledgeFilePublicationDatabase(f.db);
  f.store.release(published.capture);
});
test("exact request duplicate is historical observation and never issues another capture", (t) => {
  const f = fixture(t),
    prepared = f.prepare(),
    before = f.state.currentChecks;
  const duplicate = f.store.prepare(prepared.request);
  assert.equal(duplicate.kind, "duplicate");
  assert.equal("capture" in duplicate, false);
  assert.equal(f.state.currentChecks, before);
  assert.throws(
    () =>
      f.store.prepare({
        ...prepared.request,
        body: "different",
        bodySha256: sha256("different"),
      }),
    code("KNOWLEDGE_FILE_REQUEST_CONFLICT"),
  );
  f.store.cancel(prepared.capture);
  const later = f.store.prepare(prepared.request);
  assert.equal(later.kind, "duplicate");
  assert.equal(later.record.state, "cancelled");
});
test("copied and foreign runtime captures never dispatch", (t) => {
  const f = fixture(t),
    p = f.prepare();
  assert.throws(
    () => f.store.dispatch({ ...p.capture }),
    code("KNOWLEDGE_FILE_CAPTURE_INVALID"),
  );
  f.reopen();
  assert.throws(
    () => f.store.dispatch(p.capture),
    code("KNOWLEDGE_FILE_CAPTURE_INVALID"),
  );
  assert.deepEqual(f.store.recoverInterruptedOwners(), {
    cancelled: 1,
    uncertain: 0,
  });
  assert.equal(f.store.hasBlocker("workspace"), false);
});
test("malformed getter/proxy/null prepare has no binding or candidate callbacks", (t) => {
  const f = fixture(t),
    input = f.input(),
    before = f.state.bindingReads;
  let calls = 0;
  const getter = Object.defineProperty({ ...input }, "body", {
    get() {
      calls++;
      return input.body;
    },
    enumerable: true,
  });
  for (const invalid of [getter, new Proxy(input, {}), null])
    assert.throws(
      () => f.store.prepare(invalid as never),
      (e) => e instanceof EngineError,
    );
  assert.equal(calls, 0);
  assert.equal(f.state.bindingReads, before);
  assert.equal(f.store.listPublications("workspace").items.length, 0);
});
test("Windows aliases of Git metadata and dependencies are rejected before binding", (t) => {
  const f = fixture(t),
    input = f.input(),
    before = f.state.bindingReads;
  for (const path of [".git./hooks/pre-commit", "GIT~1/hooks/pre-commit", "NODE_M~1/x.js", "notes."])
    assert.throws(
      () => f.store.prepare({ ...input, path }),
      (e) => e instanceof EngineError && e.code === "INVALID_KNOWLEDGE_FILE_PATH",
    );
  assert.equal(f.state.bindingReads, before);
  assert.equal(f.store.listPublications("workspace").items.length, 0);
});
test("preimage mutation rejects stale target before intent and currentness callback", (t) => {
  const f = fixture(t),
    p = f.prepare();
  writeFileSync(join(f.root, "MEMORY.md"), "outside");
  f.store.captureTarget(f.binding(), f.observe());
  assert.throws(
    () => f.store.dispatch(p.capture),
    code("KNOWLEDGE_FILE_TARGET_STALE"),
  );
  assert.equal(f.state.currentChecks, 0);
  assert.equal(f.store.getOwner("workspace", p.record.id)!.state, "prepared");
  f.store.cancel(p.capture);
});
test("completion without original dispatched intent cannot create receipt", (t) => {
  const f = fixture(t),
    p = f.prepare();
  writeFileSync(join(f.root, "MEMORY.md"), p.request.body!);
  assert.throws(
    () =>
      f.store.complete(p.capture, {
        after: f.observe(),
        checkpoint: {
          createdParents: [],
          createdFiles: ["MEMORY.md"],
          removedFiles: [],
          replacedFiles: [],
          partial: false,
        },
        cleanup: { confirmed: true, reason: null },
      }),
    code("KNOWLEDGE_FILE_COMPLETION_INVALID"),
  );
  assert.equal(f.store.getReceipt("workspace", p.request.requestId), undefined);
});
test("native receipt remains exact after unrelated later physical target observation", (t) => {
  const f = fixture(t),
    p = f.apply();
  writeFileSync(join(f.root, "MEMORY.md"), "edited later");
  assert.equal(f.store.captureTarget(f.binding(), f.observe()).revision, 2);
  assert.deepEqual(f.store.getCommitted("workspace", p.record.id), p.result);
  assert.equal(f.store.prepare(p.request).kind, "duplicate");
  validateKnowledgeFilePublicationDatabase(f.db);
});
test("receipt insert failure rolls back head checkpoint and completion together", (t) => {
  const f = fixture(t),
    p = f.prepare();
  f.store.dispatch(p.capture);
  writeFileSync(join(f.root, "MEMORY.md"), p.request.body!);
  f.db.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON knowledge_file_publication_receipts BEGIN SELECT RAISE(ABORT,'receipt failed'); END",
  );
  assert.throws(
    () =>
      f.store.complete(p.capture, {
        after: f.observe(),
        checkpoint: {
          createdParents: [],
          createdFiles: ["MEMORY.md"],
          removedFiles: [],
          replacedFiles: [],
          partial: false,
        },
        cleanup: { confirmed: true, reason: null },
      }),
    /receipt failed/u,
  );
  assert.equal(f.store.getCurrentTarget("workspace", "MEMORY.md"), undefined);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM knowledge_file_checkpoints").get()!
      .n,
    0,
  );
  assert.equal(f.store.getOwner("workspace", p.record.id)!.state, "dispatched");
  f.store.release(p.capture);
  assert.equal(f.store.getOwner("workspace", p.record.id)!.state, "uncertain");
  assert.equal(hasKnowledgeFilePublicationBlocker(f.db, "workspace"), true);
  validateKnowledgeFilePublicationDatabase(f.db);
});
test("reopen retains dispatched uncertainty and does not apply target", (t) => {
  const f = fixture(t),
    p = f.prepare();
  f.store.dispatch(p.capture);
  f.reopen();
  assert.deepEqual(f.store.recoverInterruptedOwners(), {
    cancelled: 0,
    uncertain: 1,
  });
  assert.equal(existsSync(join(f.root, "MEMORY.md")), false);
  assert.equal(
    f.store.getOwner("workspace", p.record.id)!.cleanupConfirmed,
    false,
  );
  assert.equal(f.store.hasBlocker("workspace"), true);
  validateKnowledgeFilePublicationDatabase(f.db);
});
test("startup claimed-lock prepared owner preserves uncertainty instead of false no-effect cancellation", (t) => {
  const f = fixture(t),
    p = f.prepare();
  f.reopen();
  assert.deepEqual(f.store.recoverInterruptedOwners([p.record.id]), {
    cancelled: 0,
    uncertain: 1,
  });
  const owner = f.store.getOwner("workspace", p.record.id)!;
  assert.equal(owner.dispatchedAt, null);
  assert.equal(owner.state, "uncertain");
  assert.equal(owner.cleanupConfirmed, false);
  assert.equal(f.store.hasBlocker("workspace"), true);
});
test("explicit original ACK and separate resume retain immutable uncertainty and no replay", (t) => {
  const f = fixture(t),
    p = f.prepare();
  f.store.dispatch(p.capture);
  f.store.uncertain(p.capture, {
    errorCode: "ACTUAL_UNCONFIRMED",
    cleanupConfirmed: false,
  });
  const raw = f.store.getOwner("workspace", p.record.id)!,
    preview = f.store.previewRecovery("workspace");
  assert.throws(
    () =>
      f.store.acknowledge({
        workspaceId: "workspace",
        requestId: "ack",
        approved: true,
        preview: { ...preview },
        reason: "observed cleanup",
      }),
    code("KNOWLEDGE_FILE_RECOVERY_PREVIEW_INVALID"),
  );
  const ack = f.store.acknowledge({
    workspaceId: "workspace",
    requestId: "ack",
    approved: true,
    preview,
    reason: "observed cleanup",
  });
  assert.equal(f.state.recoveryChecks, 1);
  assert.equal(f.store.hasBlocker("workspace"), true);
  assert.deepEqual(f.store.getOwner("workspace", p.record.id), raw);
  const resumePreview = f.store.previewRecovery("workspace");
  assert.equal(resumePreview.owners.length, 0);
  f.store.resume({
    workspaceId: "workspace",
    requestId: "resume",
    approved: true,
    preview: resumePreview,
    reason: "resume separately",
  });
  assert.equal(f.store.hasBlocker("workspace"), false);
  assert.deepEqual(f.store.getOwner("workspace", p.record.id), raw);
  assert.deepEqual(ack.ownerHashes, [{ id: raw.id, sha256: raw.sha256 }]);
  assert.equal(existsSync(join(f.root, "MEMORY.md")), false);
  validateKnowledgeFilePublicationDatabase(f.db);
});
test("recovery validation failure never invokes external marker reconciliation", (t) => {
  const f = fixture(t),
    p = f.prepare();
  f.store.uncertain(p.capture, {
    errorCode: "UNCERTAIN",
    cleanupConfirmed: false,
  });
  const preview = f.store.previewRecovery("workspace");
  f.store.uncertain(p.capture, { errorCode: "UNCERTAIN" });
  f.state.bindingSuffix = "new";
  assert.throws(
    () =>
      f.store.acknowledge({
        workspaceId: "workspace",
        requestId: "ack",
        approved: true,
        preview,
        reason: "host approval",
      }),
    code("KNOWLEDGE_BINDING_MISMATCH"),
  );
  assert.equal(f.state.recoveryChecks, 0);
});
test("original dispatch deadline expiry never resets and terminal prepared is cancelable", (t) => {
  const f = fixture(t),
    p = f.prepare();
  f.state.now = p.request.deadline;
  assert.throws(
    () => f.store.dispatch(p.capture),
    code("KNOWLEDGE_FILE_EXPIRED"),
  );
  assert.equal(f.state.currentChecks, 0);
  assert.equal(f.store.cancel(p.capture).state, "cancelled");
  assert.equal(f.store.hasBlocker("workspace"), false);
});
test("same primary transaction target observation works and outer rollback restores head", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "MEMORY.md"), "preexisting");
  f.db.exec("BEGIN IMMEDIATE");
  assert.equal(f.store.captureTarget(f.binding(), f.observe()).revision, 1);
  f.db.exec("ROLLBACK");
  assert.equal(f.store.getCurrentTarget("workspace", "MEMORY.md"), undefined);
  assert.equal(f.store.captureTarget(f.binding(), f.observe()).revision, 1);
});
test("bounded paging rejects foreign cursor and whole row exceeding caller reservation", (t) => {
  const f = fixture(t),
    p = f.prepare();
  assert.throws(
    () => f.store.listPublications("workspace", { after: "not-owned" }),
    code("KNOWLEDGE_FILE_PAGE_CURSOR"),
  );
  assert.throws(
    () => f.store.listPublications("workspace", { maxBytes: 128 }),
    code("KNOWLEDGE_FILE_PAGE_LIMIT"),
  );
  assert.equal(
    f.store.listPublications("workspace", { limit: 1 }).items[0]!.id,
    p.record.id,
  );
});

test("native revoke has its own durable owner and positive absent receipt with exact historical producer", (t) => {
  const f = fixture(t),
    published = f.apply(),
    target = f.store.getCurrentTarget("workspace", "MEMORY.md")!;
  const request: PrepareKnowledgeFilePublication = {
    ...published.request,
    requestId: randomUUID(),
    operation: "revoke",
    expectedTarget: target,
    existingPublicationId: published.result.publication.id,
    existingPublicationSha256: published.result.publication.sha256,
    body: null,
    bodySha256: null,
    beforeContent: readFileSync(join(f.root, "MEMORY.md"), "utf8"),
  };
  const revoked = f.prepare(request);
  f.store.dispatch(revoked.capture);
  unlinkSync(join(f.root, "MEMORY.md"));
  const result = f.store.complete(revoked.capture, {
    after: f.observe(),
    checkpoint: {
      createdParents: [],
      createdFiles: [],
      removedFiles: ["MEMORY.md"],
      replacedFiles: [],
      partial: false,
    },
    cleanup: { confirmed: true, reason: null },
  });
  assert.equal(result.target.revision, 2);
  assert.equal(result.target.observation.present, false);
  assert.equal(result.target.observation.sha256, null);
  assert.equal(result.checkpoint.afterContent, null);
  assert.equal(
    f.store.getCommitted("workspace", published.record.id).publication.state,
    "completed",
  );
  validateKnowledgeFilePublicationDatabase(f.db);
});
test("same-body external revision cannot masquerade as original active publication for revoke", (t) => {
  const f = fixture(t),
    published = f.apply();
  writeFileSync(join(f.root, "MEMORY.md"), published.request.body!);
  const target = f.store.captureTarget(f.binding(), f.observe());
  assert.equal(target.revision, 2);
  const request: PrepareKnowledgeFilePublication = {
    ...published.request,
    requestId: randomUUID(),
    operation: "revoke",
    expectedTarget: target,
    existingPublicationId: published.result.publication.id,
    existingPublicationSha256: published.result.publication.sha256,
    body: null,
    bodySha256: null,
    beforeContent: published.request.body,
  };
  assert.throws(
    () => f.store.prepare(request),
    code("KNOWLEDGE_FILE_TARGET_STALE"),
  );
  assert.equal(f.store.listPublications("workspace").items.length, 1);
});
test("double dispatch cannot reset original intent or deadline", (t) => {
  const f = fixture(t),
    p = f.prepare();
  const dispatched = f.store.dispatch(p.capture);
  f.state.now += 1;
  assert.throws(
    () => f.store.dispatch(p.capture),
    code("KNOWLEDGE_FILE_DISPATCH_INVALID"),
  );
  assert.deepEqual(f.store.getOwner("workspace", p.record.id), dispatched);
  assert.equal(f.state.currentChecks, 1);
});
test("currentness callback changing binding cancels dispatch transaction before any intent", (t) => {
  const f = fixture(t),
    p = f.prepare();
  f.state.beforeCurrent = () => {
    f.state.bindingSuffix = "changed";
  };
  assert.throws(
    () => f.store.dispatch(p.capture),
    code("KNOWLEDGE_BINDING_MISMATCH"),
  );
  assert.equal(f.store.getOwner("workspace", p.record.id)!.state, "prepared");
  assert.equal(f.store.getReceipt("workspace", p.request.requestId), undefined);
});
test("expiry during original currentness callback is rechecked before dispatch write", (t) => {
  const f = fixture(t),
    p = f.prepare();
  f.state.beforeCurrent = () => {
    f.state.now = p.request.deadline;
  };
  assert.throws(
    () => f.store.dispatch(p.capture),
    code("KNOWLEDGE_FILE_EXPIRED"),
  );
  assert.equal(f.store.getOwner("workspace", p.record.id)!.dispatchedAt, null);
});
test("uncertain actual checkpoint preserves partial effects and cannot grant a completed receipt", (t) => {
  const f = fixture(t),
    p = f.prepare();
  f.store.dispatch(p.capture);
  writeFileSync(join(f.root, "MEMORY.md"), "partial");
  const after = f.observe(),
    partial = {
      createdParents: [],
      createdFiles: [".owned-tmp", "MEMORY.md"],
      removedFiles: [],
      replacedFiles: [],
      partial: true,
    };
  const owner = f.store.uncertain(p.capture, {
    after,
    checkpoint: partial,
    cleanupConfirmed: false,
    errorCode: "ACTUAL_EFFECT_UNCERTAIN",
  });
  assert.equal(owner.state, "uncertain");
  assert.equal(
    f.store.getCheckpoint("workspace", owner.checkpointId!)!.after!.sha256,
    sha256("partial"),
  );
  assert.equal(
    f.store.getCheckpoint("workspace", owner.checkpointId!)!.effects.partial,
    true,
  );
  assert.throws(
    () => f.store.getCommitted("workspace", owner.id),
    code("KNOWLEDGE_FILE_NOT_COMPLETED"),
  );
  assert.equal(f.store.getCurrentTarget("workspace", "MEMORY.md"), undefined);
  validateKnowledgeFilePublicationDatabase(f.db);
});
test("external recovery marker callback failure rolls back acknowledgment and native barrier", (t) => {
  const f = fixture(t),
    p = f.prepare();
  f.store.uncertain(p.capture, {
    errorCode: "UNCERTAIN",
    cleanupConfirmed: false,
  });
  const preview = f.store.previewRecovery("workspace"),
    barrier = f.db
      .prepare("SELECT data FROM knowledge_file_workspace_barriers")
      .get()!.data;
  f.state.beforeRecovery = () => {
    throw new EngineError("ACTUAL_MARKER_BUSY", "Owner remains active");
  };
  assert.throws(
    () =>
      f.store.acknowledge({
        workspaceId: "workspace",
        requestId: "ack",
        approved: true,
        preview,
        reason: "host decided",
      }),
    code("ACTUAL_MARKER_BUSY"),
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) AS n FROM knowledge_file_recovery_acknowledgments",
      )
      .get()!.n,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT data FROM knowledge_file_workspace_barriers").get()!
      .data,
    barrier,
  );
  assert.equal(f.store.hasBlocker("workspace"), true);
});
test("resume original stale acknowledgment preview cannot skip the separate pending-resume frontier", (t) => {
  const f = fixture(t),
    p = f.prepare();
  f.store.uncertain(p.capture, {
    errorCode: "UNCERTAIN",
    cleanupConfirmed: false,
  });
  const preview = f.store.previewRecovery("workspace"),
    input = {
      workspaceId: "workspace",
      requestId: "ack",
      approved: true as const,
      preview,
      reason: "host decision",
    };
  const ack = f.store.acknowledge(input);
  assert.deepEqual(f.store.acknowledge(input), ack);
  assert.throws(
    () => f.store.resume({ ...input, requestId: "resume" }),
    code("KNOWLEDGE_FILE_RECOVERY_STALE"),
  );
  assert.equal(f.store.hasBlocker("workspace"), true);
  assert.equal(f.state.recoveryChecks, 1);
});
test("oversized native owner is rejected from metadata before loading JSON body", (t) => {
  const f = fixture(t),
    p = f.prepare();
  f.db.exec("PRAGMA ignore_check_constraints=ON");
  f.db
    .prepare("UPDATE knowledge_file_publications SET data=? WHERE id=?")
    .run(" ".repeat(1048577), p.record.id);
  const prepare = f.db.prepare.bind(f.db);
  let bodyReads = 0;
  Object.defineProperty(f.db, "prepare", {
    value: (sql: string) => {
      if (sql.startsWith("SELECT * FROM knowledge_file_publications"))
        bodyReads++;
      return prepare(sql);
    },
    configurable: true,
  });
  assert.throws(
    () => f.store.getOwner("workspace", p.record.id),
    code("KNOWLEDGE_FILE_READ_LIMIT"),
  );
  assert.equal(bodyReads, 0);
});
test("malformed bounded owner JSON fails with typed error during historical read and startup", (t) => {
  const f = fixture(t),
    p = f.prepare();
  f.db
    .prepare("UPDATE knowledge_file_publications SET data=? WHERE id=?")
    .run("{invalid}", p.record.id);
  assert.throws(
    () => f.store.getOwner("workspace", p.record.id),
    code("KNOWLEDGE_FILE_RECORD_INVALID"),
  );
  f.reopen();
  assert.throws(
    () => f.store.recoverInterruptedOwners(),
    code("KNOWLEDGE_FILE_RECORD_INVALID"),
  );
});
test("archive semantic check rejects rewritten producer fingerprint even with valid row and request hashes", (t) => {
  const f = fixture(t),
    p = f.apply(),
    { sha256: ignored, ...original } = p.result.publication;
  const provenance = {
      ...original.provenance,
      generationSha256: sha256("different producer"),
    },
    body = {
      ...original,
      provenance,
      requestSha256: knowledgeHash({ ...p.request, provenance }),
    };
  const changed = { ...body, sha256: knowledgeHash(body) };
  f.db
    .prepare("UPDATE knowledge_file_publications SET data=? WHERE id=?")
    .run(JSON.stringify(changed), changed.id);
  assert.throws(
    () => validateKnowledgeFilePublicationDatabase(f.db),
    code("KNOWLEDGE_FILE_EVIDENCE_INVALID"),
  );
});
