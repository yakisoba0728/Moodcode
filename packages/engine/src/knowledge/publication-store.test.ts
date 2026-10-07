import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import { KnowledgeStorage, KNOWLEDGE_SCHEMA_SQL } from "./store.js";
import {
  KnowledgeGenerationStorage,
  KNOWLEDGE_GENERATION_SCHEMA_SQL,
} from "./generation-store.js";
import { normalizeKnowledgeGenerationBudget } from "./generation-budget.js";
import {
  KnowledgePublicationStorage,
  KNOWLEDGE_PUBLICATION_SCHEMA_SQL,
  KNOWLEDGE_PUBLICATION_TABLES,
  validateKnowledgePublicationArchiveRow,
} from "./publication-store.js";
import { knowledgeHash, sha256 } from "./validation.js";
import type {
  KnowledgeCandidate,
  KnowledgeGenerationPlan,
  KnowledgeHostBinding,
  KnowledgeStoragePorts,
} from "./types.js";
import type {
  KnowledgePublicationRecord,
  KnowledgePublicationStoragePorts,
  PrepareKnowledgePublication,
} from "./publication-types.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
function fixture(t: TestContext) {
  const root = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-native-publication-")),
    ),
    file = join(root, "native.sqlite");
  writeFileSync(join(root, "source.ts"), "export const source = 1;\n");
  let db = new DatabaseSync(file);
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE workspaces(id TEXT PRIMARY KEY,root TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO workspaces VALUES(?,?)").run("workspace", root);
  db.exec(KNOWLEDGE_SCHEMA_SQL);
  db.exec(KNOWLEDGE_GENERATION_SCHEMA_SQL);
  db.exec(KNOWLEDGE_PUBLICATION_SCHEMA_SQL);
  const state = {
    now: Date.parse("2026-10-08T02:00:00.000Z"),
    bindingSuffix: "",
    currentChecks: 0,
    candidateReads: 0,
    bindingReads: 0,
    asyncCurrent: false,
    beforeCurrent: undefined as
      ((record: KnowledgePublicationRecord) => void) | undefined,
  };
  function binding(): KnowledgeHostBinding {
    state.bindingReads++;
    const metadata = lstatSync(root, { bigint: true });
    return {
      workspaceId: "workspace",
      root,
      rootDevice: metadata.dev.toString(),
      rootInode: metadata.ino.toString(),
      storageBindingSha256: sha256(state.bindingSuffix || file),
    };
  }
  const writeTx: KnowledgePublicationStoragePorts["writeTx"] = (operation) => {
    if (db.isTransaction) return operation();
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  let native!: KnowledgeGenerationStorage;
  let publications!: KnowledgePublicationStorage;
  let knowledge!: KnowledgeStorage;
  const knowledgePorts: KnowledgeStoragePorts = {
    writeTx,
    getWorkspace: (id) => ({ id, root }),
    checkHostBinding: () => binding(),
    assertTrustSourcesCurrent: () => {},
    assertSourcesCurrent: (current, source) => {
      for (const pin of source.pins)
        if (pin.kind === "file") {
          const metadata = lstatSync(join(current.root, pin.path), {
            bigint: true,
          });
          if (
            sha256(readFileSync(join(current.root, pin.path), "utf8")) !==
              pin.sha256 ||
            metadata.dev.toString() !== pin.device ||
            metadata.ino.toString() !== pin.inode
          )
            throw new EngineError(
              "KNOWLEDGE_SOURCE_CHANGED",
              "Actual selected source changed",
            );
        }
    },
    assertTargetCurrent: (_binding, target) => {
      if (target.kind !== "workspace-document")
        throw new EngineError(
          "KNOWLEDGE_PUBLICATION_TARGET_UNSUPPORTED",
          "Actual fixture supports SQL documents",
        );
      const current = publications.captureDocumentTarget(
        "workspace",
        target.key,
      );
      if (
        current.revision !== target.revision ||
        current.sha256 !== target.sha256
      )
        throw new EngineError(
          "KNOWLEDGE_TARGET_CHANGED",
          "Actual SQL document preimage changed",
        );
    },
    readGenerationEvidence: (plan, owner) => native.readEvidence(plan, owner),
    now: () => state.now,
  };
  const publicationPorts: KnowledgePublicationStoragePorts = {
    writeTx,
    getWorkspace: (id) => ({ id, root }),
    checkBinding: () => binding(),
    getCandidate: (workspace, id) => {
      state.candidateReads++;
      return knowledge.getCandidate(workspace, id);
    },
    assertCommitCurrent: (record) => {
      state.currentChecks++;
      state.beforeCurrent?.(record);
      if (knowledge.getImportPause(record.workspaceId))
        throw new EngineError(
          "KNOWLEDGE_IMPORT_PAUSED",
          "Imported records are read only",
        );
      const candidate = knowledge.getCandidate(
        record.workspaceId,
        record.provenance.candidateId,
      )!;
      const plan = knowledge.getGenerationPlan(
        record.workspaceId,
        record.provenance.planId,
      )!;
      const generation = native.getGeneration(
          record.workspaceId,
          record.provenance.generationId,
        ),
        attempt = native.getAttempt(
          record.workspaceId,
          record.provenance.attemptId,
        ),
        trust = knowledge.getTrustRevision(
          record.workspaceId,
          record.provenance.trustRevisionId,
        )!;
      if (
        candidate.sha256 !== record.provenance.candidateSha256 ||
        plan.sha256 !== record.provenance.planSha256 ||
        generation.sha256 !== record.provenance.generationSha256 ||
        attempt.sha256 !== record.provenance.attemptSha256 ||
        trust.sha256 !== record.provenance.trustRevisionSha256 ||
        generation.state !== "completed" ||
        attempt.state !== "completed" ||
        attempt.output !== candidate.body ||
        !attempt.cleanup?.confirmed
      )
        throw new EngineError(
          "KNOWLEDGE_PUBLICATION_PROVENANCE_CHANGED",
          "Original historical completed producer changed",
        );
      if (record.operation === "publish") {
        knowledge.assertTrusted(record.workspaceId, candidate.trustRevision);
        knowledgePorts.assertSourcesCurrent(
          candidate.binding,
          candidate.source,
        );
        if (Date.parse(candidate.expiresAt) <= state.now)
          throw new EngineError("KNOWLEDGE_EXPIRED", "Candidate expired");
      }
      if (state.asyncCurrent) return Promise.resolve() as never;
    },
    now: () => state.now,
  };
  function connect() {
    knowledge = new KnowledgeStorage(db, knowledgePorts);
    native = new KnowledgeGenerationStorage(db, {
      writeTx,
      getWorkspace: (id) => ({ id, root }),
      checkBinding: () => binding(),
      getPlan: (workspace, id) => knowledge.getGenerationPlan(workspace, id),
      assertPlanCurrent: (plan) => knowledge.assertGenerationPlanCurrent(plan),
      now: () => state.now,
    });
    publications = new KnowledgePublicationStorage(db, publicationPorts);
  }
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
  function candidate(
    key = "project-memory",
    body = "Exact proposed project fact.\n",
  ): KnowledgeCandidate {
    const source = readFileSync(join(root, "source.ts"), "utf8"),
      metadata = lstatSync(join(root, "source.ts"), { bigint: true });
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
            device: metadata.dev.toString(),
            inode: metadata.ino.toString(),
          },
        ],
      },
      target: publications.captureDocumentTarget("workspace", key),
      providerId: "fixture-provider",
      modelId: "fixture-model",
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
    assert.equal(admitted.kind, "created");
    if (admitted.kind !== "created")
      throw new Error("Actual generation needed");
    const attempt = native.prepareAttempt(admitted.capture, {
      id: randomUUID(),
      sha256: sha256("Original host envelope"),
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
  ): PrepareKnowledgePublication {
    const generation = native.getGeneration(
        "workspace",
        selected.generationOwnerId,
      ),
      attempt = native.getAttempt("workspace", generation.attemptId!),
      plan = knowledge.getGenerationPlan("workspace", selected.planId)!,
      trust = knowledge.getTrustRevision(
        "workspace",
        selected.trustRevisionId,
      )!,
      head = publications.getDocumentHead(
        "workspace",
        selected.target.kind === "workspace-document"
          ? selected.target.key
          : "",
      );
    return {
      workspaceId: "workspace",
      requestId,
      operation: "publish",
      binding: selected.binding,
      documentKey:
        selected.target.kind === "workspace-document"
          ? selected.target.key
          : "",
      expectedHeadRevision: selected.target.revision,
      expectedHeadSha256: selected.target.sha256,
      expectedHeadRevisionId: head?.revisionId ?? null,
      provenance: {
        candidateId: selected.id,
        candidateSha256: selected.sha256,
        generationId: generation.id,
        generationSha256: generation.sha256,
        attemptId: attempt.id,
        attemptSha256: attempt.sha256,
        planId: plan.id,
        planSha256: plan.sha256,
        trustRevisionId: trust.id,
        trustRevisionSha256: trust.sha256,
      },
      existingPublicationId: null,
      existingPublicationSha256: null,
      bodySha256: selected.bodySha256,
      expiresAt: new Date(state.now + 30000).toISOString(),
    };
  }
  function prepare(request = input()) {
    const result = publications.prepare(request);
    assert.equal(result.kind, "created");
    if (result.kind !== "created")
      throw new Error("Original publication needed");
    return { ...result, input: request };
  }
  function publish(request = input()) {
    const prepared = prepare(request),
      result = publications.commit(prepared.capture);
    return { ...prepared, result };
  }
  function revokeInput(id: string): PrepareKnowledgePublication {
    const publication = publications.getPublication("workspace", id),
      head = publications.getDocumentHead(
        "workspace",
        publication.documentKey,
      )!;
    return {
      workspaceId: "workspace",
      requestId: randomUUID(),
      operation: "revoke",
      binding: publication.binding,
      documentKey: publication.documentKey,
      expectedHeadRevision: head.revision,
      expectedHeadSha256: head.bodySha256,
      expectedHeadRevisionId: head.revisionId,
      provenance: publication.provenance,
      existingPublicationId: publication.id,
      existingPublicationSha256: publication.sha256,
      bodySha256: sha256(""),
      expiresAt: new Date(state.now + 30000).toISOString(),
    };
  }
  function counts() {
    return Object.fromEntries(
      KNOWLEDGE_PUBLICATION_TABLES.map((table) => [
        table,
        Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n),
      ]),
    );
  }
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get db() {
      return db;
    },
    get publications() {
      return publications;
    },
    get knowledge() {
      return knowledge;
    },
    get native() {
      return native;
    },
    root,
    file,
    state,
    binding,
    publicationPorts,
    candidate,
    input,
    prepare,
    publish,
    revokeInput,
    counts,
    reopen() {
      db.close();
      db = new DatabaseSync(file);
      db.exec("PRAGMA foreign_keys=ON");
      connect();
      return publications;
    },
  };
}

test("four STRICT workspace-only publication tables preserve real candidate/generation scope with no coding owners", (t) => {
  const f = fixture(t),
    p = f.prepare(),
    tables = f.db.prepare("PRAGMA table_list").all();
  for (const table of KNOWLEDGE_PUBLICATION_TABLES)
    assert.equal(tables.find((row) => row.name === table)!.strict, 1);
  for (const table of ["sessions", "runs", "tools", "summary_attempts"])
    assert.ok(!tables.some((row) => row.name === table));
  assert.equal(f.db.prepare("PRAGMA user_version").get()!.user_version, 0);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(p.record.state, "prepared");
  assert.equal(f.state.currentChecks, 0);
  assert.equal(
    f.publications.captureDocumentTarget("workspace", "project-memory")
      .revision,
    0,
  );
});
test("one primary transaction applies exact revision/head/completed owner/receipt and immutable historical observations", (t) => {
  const f = fixture(t),
    p = f.publish(),
    before = f.counts();
  assert.equal(p.result.publication.state, "completed");
  assert.equal(p.result.document.revision, 1);
  assert.equal(p.result.document.previousRevisionId, null);
  assert.equal(p.result.document.body, p.record.body);
  assert.equal(p.result.head.revisionId, p.result.document.id);
  assert.equal(p.result.receipt.publicationId, p.record.id);
  assert.equal(
    f.publications.getCurrentDocument("workspace", "project-memory")!.sha256,
    p.result.document.sha256,
  );
  assert.equal(
    f.publications.getReceipt("workspace", p.input.requestId)!.id,
    p.result.receipt.id,
  );
  assert.deepEqual(
    f.publications.getCommitted("workspace", p.record.id),
    p.result,
  );
  assert.ok(
    Object.isFrozen(p.result) &&
      Object.isFrozen(p.result.document) &&
      Object.isFrozen(p.result.document.provenance),
  );
  assert.equal(f.state.currentChecks, 1);
  assert.deepEqual(before, {
    knowledge_publications: 1,
    workspace_document_revisions: 1,
    workspace_document_heads: 1,
    knowledge_publication_receipts: 1,
  });
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
});
test("exact prepared duplicates never issue another live capture; conflicting request IDs fail before effects", (t) => {
  const f = fixture(t),
    request = f.input(),
    first = f.prepare(request),
    duplicate = f.publications.prepare(request);
  assert.equal(duplicate.kind, "duplicate");
  assert.equal("capture" in duplicate, false);
  assert.equal(duplicate.record.id, first.record.id);
  assert.equal(f.state.currentChecks, 0);
  assert.throws(
    () =>
      f.publications.prepare({
        ...request,
        expiresAt: new Date(f.state.now + 40000).toISOString(),
      }),
    code("KNOWLEDGE_REQUEST_CONFLICT"),
  );
  assert.equal(f.counts().knowledge_publications, 1);
});

test("same-epoch prepare race returns only the first original capability and the outer duplicate has no capture", (t) => {
  const f = fixture(t),
    request = f.input();
  let original: ReturnType<KnowledgePublicationStorage["prepare"]> | undefined;
  let entered = false;
  const raced = new KnowledgePublicationStorage(f.db, {
    ...f.publicationPorts,
    writeTx: (operation) => {
      if (!entered) {
        entered = true;
        original = raced.prepare(request);
      }
      return f.publicationPorts.writeTx(operation);
    },
  });
  const duplicate = raced.prepare(request);
  assert.equal(original!.kind, "created");
  assert.equal(duplicate.kind, "duplicate");
  assert.equal("capture" in duplicate, false);
  assert.equal(duplicate.record.id, original!.record.id);
  assert.equal(f.counts().knowledge_publications, 1);
  if (original!.kind === "created")
    assert.equal(raced.commit(original!.capture).document.revision, 1);
  assert.equal(f.counts().workspace_document_revisions, 1);
});
test("historical receipt duplicate survives source mutation, trust denial, expiry and newer revocation without reapplying", (t) => {
  const f = fixture(t),
    p = f.publish(),
    revoke = f.publish(f.revokeInput(p.record.id));
  writeFileSync(join(f.root, "source.ts"), "Changed source");
  f.knowledge.setTrust({
    workspaceId: "workspace",
    requestId: "deny",
    expectedRevision: 1,
    decision: "deny",
    binding: f.binding(),
    sources: [],
    expiresAt: null,
  });
  f.state.now += 60000;
  const before = f.counts(),
    checks = f.state.currentChecks,
    result = f.publications.prepare(p.input);
  assert.equal(result.kind, "duplicate");
  assert.equal(result.record.id, p.record.id);
  assert.deepEqual(
    f.publications.getCommitted("workspace", p.record.id),
    p.result,
  );
  assert.equal(
    f.publications.getDocumentHead("workspace", "project-memory")!.revision,
    revoke.result.document.revision,
  );
  assert.deepEqual(f.counts(), before);
  assert.equal(f.state.currentChecks, checks);
});
test("hostile malformed approval input executes no callback or native write", (t) => {
  const f = fixture(t),
    request = f.input(),
    before = f.counts(),
    reads = f.state.candidateReads,
    bindings = f.state.bindingReads;
  let getters = 0;
  const accessor = Object.defineProperty({ ...request }, "provenance", {
    enumerable: true,
    get() {
      getters++;
      return request.provenance;
    },
  });
  for (const value of [
    null,
    [],
    new Proxy(request, {}),
    accessor,
    { ...request, tools: ["write"] },
    { ...request, expectedHeadRevision: 1 },
  ])
    assert.throws(
      () => f.publications.prepare(value as PrepareKnowledgePublication),
      (error) => error instanceof EngineError,
    );
  assert.equal(getters, 0);
  assert.equal(f.state.candidateReads, reads);
  assert.equal(f.state.bindingReads, bindings);
  assert.equal(f.state.currentChecks, 0);
  assert.deepEqual(f.counts(), before);
});
test("copied, proxied, peer-instance, foreign and released preview owners cannot approve documents", (t) => {
  const f = fixture(t),
    p = f.prepare(),
    peer = new KnowledgePublicationStorage(f.db, f.publicationPorts);
  for (const capture of [{ ...p.capture }, new Proxy(p.capture, {})])
    assert.throws(
      () => f.publications.commit(capture),
      code("KNOWLEDGE_PUBLICATION_HANDLE_INVALID"),
    );
  assert.throws(
    () => peer.commit(p.capture),
    code("KNOWLEDGE_PUBLICATION_HANDLE_INVALID"),
  );
  f.publications.cancel(p.capture);
  f.publications.release(p.capture);
  assert.throws(
    () => f.publications.commit(p.capture),
    code("KNOWLEDGE_PUBLICATION_HANDLE_INVALID"),
  );
  assert.equal(f.counts().workspace_document_revisions, 0);
});
test("detached original pins cannot be rewritten by the caller after prepare", (t) => {
  const f = fixture(t),
    request = structuredClone(f.input()),
    p = f.prepare(request);
  (request.provenance as { candidateSha256: string }).candidateSha256 =
    sha256("changed");
  (request as { documentKey: string }).documentKey = "caller-changed-key";
  const result = f.publications.commit(p.capture);
  assert.equal(result.document.documentKey, "project-memory");
  assert.equal(result.document.bodySha256, p.record.bodySha256);
  assert.notEqual(
    result.publication.provenance.candidateSha256,
    request.provenance.candidateSha256,
  );
});
test("source staleness after prepare preserves pending owner but rejects approval atomically", (t) => {
  const f = fixture(t),
    p = f.prepare();
  writeFileSync(
    join(f.root, "source.ts"),
    "Actual source changed after preview",
  );
  assert.throws(
    () => f.publications.commit(p.capture),
    code("KNOWLEDGE_SOURCE_CHANGED"),
  );
  assert.equal(
    f.publications.getPublication("workspace", p.record.id).state,
    "prepared",
  );
  assert.equal(f.counts().workspace_document_revisions, 0);
  f.publications.cancel(p.capture, "KNOWLEDGE_SOURCE_CHANGED");
  assert.equal(
    f.publications.getPublication("workspace", p.record.id).state,
    "cancelled",
  );
});
test("trust denial after original preview rejects publish while revoke remains a host historical decision", (t) => {
  const f = fixture(t),
    p = f.publish(),
    replacement = f.prepare(f.input(f.candidate())),
    revoke = f.prepare(f.revokeInput(p.record.id));
  f.knowledge.setTrust({
    workspaceId: "workspace",
    requestId: "revoke-trust",
    expectedRevision: 1,
    decision: "deny",
    binding: f.binding(),
    sources: [],
    expiresAt: null,
  });
  assert.throws(
    () => f.publications.commit(replacement.capture),
    code("WORKSPACE_UNTRUSTED"),
  );
  writeFileSync(join(f.root, "source.ts"), "Stale original source");
  const result = f.publications.commit(revoke.capture);
  assert.equal(result.document.status, "revoked");
  assert.equal(result.document.body, "");
  assert.equal(result.document.bodySha256, sha256(""));
  assert.equal(result.document.revision, 2);
  assert.equal(
    f.publications.captureDocumentTarget("workspace", "project-memory")
      .revision,
    2,
  );
  assert.equal(
    f.publications.captureDocumentTarget("workspace", "project-memory").sha256,
    sha256(""),
  );
});
test("two actual approval owners race on exact same preimage and only one native document effect occurs", (t) => {
  const f = fixture(t),
    candidate = f.candidate(),
    first = f.prepare(f.input(candidate)),
    second = f.prepare(f.input(candidate));
  f.publications.commit(first.capture);
  assert.throws(
    () => f.publications.commit(second.capture),
    code("KNOWLEDGE_DOCUMENT_REVISION_CONFLICT"),
  );
  assert.equal(f.counts().workspace_document_revisions, 1);
  assert.equal(f.counts().knowledge_publication_receipts, 1);
  assert.equal(
    f.publications.getPublication("workspace", second.record.id).state,
    "prepared",
  );
  f.publications.release(second.capture);
  assert.equal(
    f.publications.getPublication("workspace", second.record.id).state,
    "cancelled",
  );
});
test("revocation prevents revision-zero ABA and new candidate can target positive revoked preimage", (t) => {
  const f = fixture(t),
    selected = f.candidate(),
    old = f.prepare(f.input(selected)),
    published = f.publish(f.input(selected)),
    revoked = f.publish(f.revokeInput(published.record.id));
  assert.equal(revoked.result.document.revision, 2);
  assert.throws(
    () => f.publications.commit(old.capture),
    code("KNOWLEDGE_DOCUMENT_REVISION_CONFLICT"),
  );
  const replacement = f.publish(
    f.input(f.candidate("project-memory", "A newly approved current fact.")),
  );
  assert.equal(replacement.result.document.revision, 3);
  assert.equal(
    replacement.result.document.previousRevisionId,
    revoked.result.document.id,
  );
  assert.equal(replacement.result.document.status, "active");
  assert.equal(
    f.publications.getCommitted("workspace", published.record.id).head.revision,
    1,
  );
});
for (const failure of ["revision", "head", "owner", "receipt"] as const)
  test(`SQL failure at ${failure} rolls back document history/head/owner/receipt as one atomic approval`, (t) => {
    const f = fixture(t),
      p = f.prepare();
    const table = {
        revision: "workspace_document_revisions",
        head: "workspace_document_heads",
        owner: "knowledge_publications",
        receipt: "knowledge_publication_receipts",
      }[failure],
      event = failure === "owner" ? "UPDATE" : "INSERT";
    f.db.exec(
      `CREATE TRIGGER reject_approval BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT,'authored approval rollback'); END`,
    );
    assert.throws(
      () => f.publications.commit(p.capture),
      /authored approval rollback/,
    );
    assert.equal(
      f.publications.getPublication("workspace", p.record.id).state,
      "prepared",
    );
    assert.equal(f.counts().workspace_document_revisions, 0);
    assert.equal(f.counts().workspace_document_heads, 0);
    assert.equal(f.counts().knowledge_publication_receipts, 0);
    f.db.exec("DROP TRIGGER reject_approval");
    assert.equal(f.publications.commit(p.capture).document.revision, 1);
  });
test("async or throwing validation ports never commit partial documents", (t) => {
  const f = fixture(t),
    p = f.prepare();
  f.state.asyncCurrent = true;
  assert.throws(
    () => f.publications.commit(p.capture),
    code("KNOWLEDGE_ASYNC_PORT"),
  );
  f.state.asyncCurrent = false;
  f.state.beforeCurrent = () => {
    throw new EngineError(
      "HOST_CHECK_FAILED",
      "Actual synchronous check failed",
    );
  };
  assert.throws(
    () => f.publications.commit(p.capture),
    code("HOST_CHECK_FAILED"),
  );
  assert.equal(f.counts().workspace_document_revisions, 0);
  assert.equal(f.counts().knowledge_publication_receipts, 0);
});
test("approval expiry and changed physical/database binding reject effects without resetting the original deadline", (t) => {
  const f = fixture(t),
    p = f.prepare();
  f.state.bindingSuffix = "another-store";
  assert.throws(
    () => f.publications.commit(p.capture),
    code("KNOWLEDGE_BINDING_MISMATCH"),
  );
  f.state.bindingSuffix = "";
  f.state.now = Date.parse(p.record.expiresAt);
  assert.throws(
    () => f.publications.commit(p.capture),
    code("KNOWLEDGE_PUBLICATION_EXPIRED"),
  );
  assert.equal(
    f.publications.getPublication("workspace", p.record.id).expiresAt,
    p.record.expiresAt,
  );
  assert.equal(f.counts().workspace_document_revisions, 0);
});
test("cancellation and capture release record no application and every late approval remains fenced", (t) => {
  const f = fixture(t),
    p = f.prepare();
  f.publications.cancel(p.capture);
  assert.throws(
    () => f.publications.commit(p.capture),
    code("KNOWLEDGE_PUBLICATION_STALE"),
  );
  f.publications.release(p.capture);
  const other = f.prepare(f.input());
  f.publications.release(other.capture);
  assert.equal(
    f.publications.getPublication("workspace", other.record.id).state,
    "cancelled",
  );
  assert.equal(f.counts().workspace_document_revisions, 0);
  assert.equal(f.publications.prepare(p.input).kind, "duplicate");
});
test("restart cancels prepared original owner without autoapply, new capability or target reset", (t) => {
  const f = fixture(t),
    p = f.prepare(),
    reopened = f.reopen();
  assert.deepEqual(reopened.recoverInterruptedOwners(), { cancelled: 1 });
  assert.equal(
    reopened.getPublication("workspace", p.record.id).state,
    "cancelled",
  );
  assert.equal(reopened.prepare(p.input).kind, "duplicate");
  assert.equal("capture" in reopened.prepare(p.input), false);
  assert.deepEqual(reopened.recoverInterruptedOwners(), { cancelled: 0 });
  assert.equal(f.counts().workspace_document_revisions, 0);
  assert.equal(f.state.currentChecks, 0);
});
test("completed durable publication survives restart with exact receipt and historical target without original generation fresh target", (t) => {
  const f = fixture(t),
    p = f.publish();
  f.publications.release(p.capture);
  f.reopen();
  assert.deepEqual(f.publications.recoverInterruptedOwners(), { cancelled: 0 });
  assert.deepEqual(
    f.publications.getCommitted("workspace", p.record.id),
    p.result,
  );
  assert.equal(f.publications.prepare(p.input).kind, "duplicate");
  const plan = f.knowledge.getGenerationPlan(
    "workspace",
    p.record.provenance.planId,
  )!;
  assert.throws(
    () => f.native.readEvidence(plan, p.record.provenance.generationId),
    code("KNOWLEDGE_TARGET_CHANGED"),
  );
  assert.equal(
    f.publications.getCurrentDocument("workspace", "project-memory")!.body,
    p.result.document.body,
  );
});
test("runtime getters and pages reject oversized rows before returning raw body data", (t) => {
  const f = fixture(t),
    p = f.publish();
  f.db.exec("PRAGMA ignore_check_constraints=ON");
  f.db
    .prepare("UPDATE knowledge_publications SET data=? WHERE id=?")
    .run("x".repeat(65537), p.record.id);
  assert.throws(
    () => f.publications.getPublication("workspace", p.record.id),
    code("KNOWLEDGE_PUBLICATION_LIMIT"),
  );
  assert.throws(
    () => f.publications.listPublications("workspace"),
    code("KNOWLEDGE_PUBLICATION_LIMIT"),
  );
  f.db
    .prepare("UPDATE knowledge_publications SET data=? WHERE id=?")
    .run(JSON.stringify(p.result.publication), p.record.id);
  f.db.exec("PRAGMA ignore_check_constraints=OFF");
  assert.equal(
    f.publications.getPublication("workspace", p.record.id).state,
    "completed",
  );
});
test("historical lists are bounded, immutable, workspace/key scoped and use exact keyset continuation", (t) => {
  const f = fixture(t),
    a = f.publish(),
    b = f.publish(f.revokeInput(a.record.id)),
    first = f.publications.listDocumentRevisions(
      "workspace",
      "project-memory",
      { limit: 1, maxBytes: 10000 },
    );
  assert.equal(first.items.length, 1);
  assert.ok(first.next);
  const next = f.publications.listDocumentRevisions(
    "workspace",
    "project-memory",
    { after: first.next!, limit: 1 },
  );
  assert.equal(next.items.length, 1);
  assert.notEqual(first.items[0]!.id, next.items[0]!.id);
  assert.deepEqual(
    new Set([...first.items, ...next.items].map((item) => item.id)),
    new Set([a.result.document.id, b.result.document.id]),
  );
  assert.equal(
    f.publications.listDocumentRevisions("workspace", "other-key").items.length,
    0,
  );
  assert.equal(
    f.publications.listPublications("other-workspace").items.length,
    0,
  );
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.items));
  assert.throws(
    () => f.publications.listPublications("workspace", { maxBytes: 1 }),
    code("KNOWLEDGE_PUBLICATION_LIMIT"),
  );
});
test("native archive validators reject impossible body/revoke/history/state/fingerprint contradictions", (t) => {
  const f = fixture(t),
    p = f.publish(),
    publication = p.result.publication,
    document = p.result.document;
  const row = {
    table: "knowledge_publications",
    key: publication.id,
    workspaceId: "workspace",
    data: publication,
  };
  assert.deepEqual(validateKnowledgePublicationArchiveRow(row), row);
  function rehash<T extends { sha256: string }>(value: T) {
    const { sha256: _old, ...body } = value;
    return { ...body, sha256: knowledgeHash(body) };
  }
  for (const data of [
    rehash({ ...publication, body: "fake candidate" }),
    rehash({ ...publication, errorCode: "impossible" }),
    rehash({ ...publication, documentRevisionId: null }),
  ])
    assert.throws(
      () => validateKnowledgePublicationArchiveRow({ ...row, data }),
      (error) => error instanceof EngineError,
    );
  assert.throws(
    () =>
      validateKnowledgePublicationArchiveRow({
        table: "workspace_document_revisions",
        key: document.id,
        workspaceId: "workspace",
        data: rehash({ ...document, status: "revoked" }),
      }),
    (error) => error instanceof EngineError,
  );
  assert.throws(
    () =>
      validateKnowledgePublicationArchiveRow({
        ...row,
        workspaceId: "another",
      }),
    code("KNOWLEDGE_SCOPE_MISMATCH"),
  );
  assert.throws(
    () => validateKnowledgePublicationArchiveRow(null),
    code("INVALID_KNOWLEDGE_PUBLICATION"),
  );
});
