import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
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
  KNOWLEDGE_GENERATION_TABLES,
  hasKnowledgeGenerationBlocker,
  validateKnowledgeGenerationArchiveRow,
} from "./generation-store.js";
import { normalizeKnowledgeGenerationBudget } from "./generation-budget.js";
import { canonicalKnowledge, knowledgeHash, sha256 } from "./validation.js";
import type {
  CreateKnowledgeGeneration,
  KnowledgeGenerationCapture,
  KnowledgeGenerationAttemptCapture,
  KnowledgeGenerationRecord,
  KnowledgeGenerationRecoveryPreview,
  KnowledgeGenerationStoragePorts,
} from "./generation-types.js";
import type {
  KnowledgeGenerationPlan,
  KnowledgeHostBinding,
  KnowledgeStoragePorts,
} from "./types.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
function fixture(t: TestContext) {
  const root = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-native-knowledge-")),
    ),
    file = join(root, "native.sqlite");
  writeFileSync(join(root, "source.ts"), "export const fact = 1;\n");
  let db = new DatabaseSync(file);
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE workspaces(id TEXT PRIMARY KEY,root TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO workspaces VALUES(?,?)").run("workspace", root);
  db.exec(KNOWLEDGE_SCHEMA_SQL);
  db.exec(KNOWLEDGE_GENERATION_SCHEMA_SQL);
  const state = {
    now: Date.parse("2026-10-08T01:00:00.000Z"),
    bindingSuffix: "",
    freshChecks: 0,
    beforeFresh: undefined as (() => void) | undefined,
  };
  const binding = (): KnowledgeHostBinding => {
    const stat = lstatSync(root, { bigint: true });
    return {
      workspaceId: "workspace",
      root,
      rootDevice: stat.dev.toString(),
      rootInode: stat.ino.toString(),
      storageBindingSha256: sha256(state.bindingSuffix || file),
    };
  };
  const writeTx: KnowledgeGenerationStoragePorts["writeTx"] = (operation) => {
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
  let native: KnowledgeGenerationStorage;
  const knowledgePorts: KnowledgeStoragePorts = {
    writeTx,
    getWorkspace: (id) => ({ id, root }),
    checkHostBinding: () => binding(),
    assertTrustSourcesCurrent: () => {},
    assertSourcesCurrent: (bound, source) => {
      for (const pin of source.pins)
        if (pin.kind === "file") {
          const stat = lstatSync(join(bound.root, pin.path), { bigint: true });
          if (
            sha256(readFileSync(join(bound.root, pin.path), "utf8")) !==
              pin.sha256 ||
            stat.dev.toString() !== pin.device ||
            stat.ino.toString() !== pin.inode
          )
            throw new EngineError(
              "KNOWLEDGE_SOURCE_CHANGED",
              "Actual pinned source changed",
            );
        }
    },
    assertTargetCurrent: () => {
      if (existsSync(join(root, "MEMORY.md")))
        throw new EngineError(
          "KNOWLEDGE_TARGET_CHANGED",
          "Actual absent target was created",
        );
    },
    readGenerationEvidence: (plan, owner) => native.readEvidence(plan, owner),
    now: () => state.now,
  };
  let knowledge = new KnowledgeStorage(db, knowledgePorts);
  const ports: KnowledgeGenerationStoragePorts = {
    writeTx,
    getWorkspace: (id) => ({ id, root }),
    getPlan: (workspace, id) => knowledge.getGenerationPlan(workspace, id),
    checkBinding: () => binding(),
    assertPlanCurrent: (plan) => {
      state.freshChecks++;
      state.beforeFresh?.();
      knowledge.assertGenerationPlanCurrent(plan);
    },
    now: () => state.now,
  };
  native = new KnowledgeGenerationStorage(db, ports);
  knowledge.setTrust({
    workspaceId: "workspace",
    requestId: "trust",
    expectedRevision: 0,
    decision: "allow",
    binding: binding(),
    sources: [],
    expiresAt: null,
  });
  function plan(id = randomUUID()): KnowledgeGenerationPlan {
    const body = readFileSync(join(root, "source.ts"), "utf8"),
      stat = lstatSync(join(root, "source.ts"), { bigint: true });
    return knowledge.prepareGeneration({
      workspaceId: "workspace",
      requestId: id,
      binding: binding(),
      expectedTrustRevision: knowledge.getTrust("workspace")!.revision,
      source: {
        projection: "host-selected-text-v1",
        sha256: sha256(body),
        bytes: Buffer.byteLength(body),
        pins: [
          {
            kind: "file",
            path: "source.ts",
            sha256: sha256(body),
            bytes: Buffer.byteLength(body),
            device: stat.dev.toString(),
            inode: stat.ino.toString(),
          },
        ],
      },
      target: {
        kind: "workspace-file",
        path: "MEMORY.md",
        revision: 0,
        sha256: null,
        device: null,
        inode: null,
      },
      providerId: "native-fixture",
      modelId: "fixture-model",
      requestSha256: sha256(body + "extract-v1"),
      requestBytes: Buffer.byteLength(body + "extract-v1"),
      maxOutputBytes: 16384,
      expiresAt: new Date(state.now + 60000).toISOString(),
    });
  }
  function request(
    selected = plan(),
    overrides: Partial<CreateKnowledgeGeneration> = {},
  ): CreateKnowledgeGeneration {
    return {
      workspaceId: "workspace",
      planId: selected.id,
      requestId: randomUUID(),
      budget: normalizeKnowledgeGenerationBudget(),
      logicalRequestSha256: selected.requestSha256,
      logicalRequestBytes: selected.requestBytes,
      ...overrides,
    };
  }
  function admit(input = request()) {
    const created = native.create(input);
    assert.equal(created.kind, "created");
    if (created.kind !== "created")
      throw new Error("Expected an original owner");
    const id = randomUUID(),
      envelope = {
        owner: {
          kind: "host-generation",
          workspaceId: "workspace",
          generationId: created.record.id,
          attemptId: id,
        },
        modelId: "fixture-model",
        messages: [{ role: "user", content: "Authored bounded source" }],
        tools: [],
        includeMetadata: true,
      };
    const serialized = canonicalKnowledge(envelope),
      attempt = native.prepareAttempt(created.capture, {
        id,
        sha256: sha256(serialized),
        bytes: Buffer.byteLength(serialized),
      });
    return {
      owner: created.capture,
      attempt: attempt.capture,
      record: created.record,
      input,
    };
  }
  function complete(value = admit(), body = "Actual pending project note.") {
    native.dispatch(value.owner, value.attempt);
    native.observe(value.owner, value.attempt, {
      textDelta: body,
      textBytes: Buffer.byteLength(body),
      observationBytes: Buffer.byteLength(body),
      eventCount: 1,
    });
    native.observe(value.owner, value.attempt, {
      finishReason: "stop",
      observationBytes: 8,
      eventCount: 2,
    });
    native.observe(value.owner, value.attempt, {
      streamDone: true,
      observationBytes: 0,
      eventCount: 2,
    });
    native.settle(value.owner, value.attempt, {
      state: "completed",
      cleanup: { confirmed: true, method: "iterator-complete", reason: null },
      candidate: { state: "pending" },
    });
    return value;
  }
  function uncertain(value = admit()) {
    native.dispatch(value.owner, value.attempt);
    native.observe(value.owner, value.attempt, {
      textDelta: "Partial original output",
      observationBytes: 24,
      usage: {
        inputTokens: 7,
        outputTokens: 2,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
      eventCount: 1,
    });
    native.settle(value.owner, value.attempt, {
      state: "uncertain",
      errorCode: "CLEANUP_UNCERTAIN",
      cleanup: {
        confirmed: false,
        method: "iterator-return",
        reason: "Actual return did not finish",
      },
      candidate: { state: "withheld", reason: "CLEANUP_UNCERTAIN" },
    });
    return value;
  }
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get db() {
      return db;
    },
    get native() {
      return native;
    },
    get knowledge() {
      return knowledge;
    },
    root,
    file,
    state,
    binding,
    ports,
    writeTx,
    plan,
    request,
    admit,
    complete,
    uncertain,
    reopen() {
      db.close();
      db = new DatabaseSync(file);
      db.exec("PRAGMA foreign_keys=ON");
      knowledge = new KnowledgeStorage(db, knowledgePorts);
      native = new KnowledgeGenerationStorage(db, ports);
      return native;
    },
  };
}

test("four native STRICT tables have real workspace/plan/owner FK scope and no coding owners or schema claim", (t) => {
  const f = fixture(t),
    a = f.admit();
  const tables = f.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name);
  for (const name of KNOWLEDGE_GENERATION_TABLES) {
    assert.ok(tables.includes(name));
    assert.equal(
      f.db
        .prepare("PRAGMA table_list")
        .all()
        .find((row) => row.name === name)!.strict,
      1,
    );
  }
  for (const name of ["sessions", "runs", "summary_attempts"])
    assert.ok(!tables.includes(name));
  assert.equal(f.db.prepare("PRAGMA user_version").get()!.user_version, 0);
  assert.ok(f.db.prepare("PRAGMA foreign_key_check").all().length === 0);
  assert.equal(
    f.native.getAttempt("workspace", a.attempt.attemptId).generationId,
    a.owner.generationId,
  );
  assert.equal("runId" in a.record, false);
});
test("exact duplicate create and find remain observation-only across restart and source revocation", (t) => {
  const f = fixture(t),
    a = f.admit(),
    initial = f.native.getGeneration("workspace", a.owner.generationId);
  assert.equal(f.native.create(a.input).kind, "duplicate");
  assert.equal(f.native.findRequest(a.input)!.id, initial.id);
  f.native.failPrepared(a.owner, "KNOWLEDGE_GENERATION_CANCELLED");
  f.native.releaseAttempt(a.attempt);
  f.native.release(a.owner);
  writeFileSync(
    join(f.root, "source.ts"),
    "Changed source after original owner",
  );
  f.knowledge.setTrust({
    workspaceId: "workspace",
    requestId: "revoke",
    expectedRevision: 1,
    decision: "deny",
    binding: f.binding(),
    sources: [],
    expiresAt: null,
  });
  const reopened = f.reopen(),
    duplicate = reopened.create(a.input);
  assert.equal(duplicate.kind, "duplicate");
  assert.equal("capture" in duplicate, false);
  assert.equal(reopened.findRequest(a.input)!.state, "cancelled");
  assert.throws(
    () =>
      reopened.findRequest({
        ...a.input,
        logicalRequestSha256: sha256("other"),
      }),
    code("KNOWLEDGE_REQUEST_CONFLICT"),
  );
});
test("a used plan cannot acquire another producer under a new request ID", (t) => {
  const f = fixture(t),
    a = f.complete();
  assert.throws(
    () => f.native.create({ ...a.input, requestId: "second-request" }),
    code("KNOWLEDGE_GENERATION_PLAN_USED"),
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM knowledge_generations").get()!.n,
    1,
  );
});
test("caps, unknown fields, proxy/getter and malformed budget reject before owner admission", (t) => {
  const f = fixture(t),
    input = f.request();
  let reads = 0;
  const getter = Object.defineProperty({ ...input }, "requestId", {
    enumerable: true,
    get() {
      reads++;
      return "bad";
    },
  });
  for (const value of [
    getter,
    new Proxy(input, {}),
    { ...input, runId: "fake" },
    null,
  ])
    assert.throws(
      () => f.native.create(value as CreateKnowledgeGeneration),
      (error) => error instanceof EngineError,
    );
  assert.equal(reads, 0);
  for (const value of [
    null,
    [],
    { maxAttempts: 2 },
    { maxOutputBytes: 16385 },
    { maxDurationMs: 0 },
    { unrecognized: 1 },
  ])
    assert.throws(
      () => normalizeKnowledgeGenerationBudget(value as never),
      (error) => error instanceof EngineError,
    );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM knowledge_generations").get()!.n,
    0,
  );
});
test("only original live instance captures may dispatch and observe; copies, proxies, peers and released handles have no authority", (t) => {
  const f = fixture(t),
    a = f.admit(),
    peer = new KnowledgeGenerationStorage(f.db, f.ports);
  for (const owner of [{ ...a.owner }, new Proxy(a.owner, {})])
    assert.throws(
      () => f.native.dispatch(owner, a.attempt),
      code("KNOWLEDGE_GENERATION_HANDLE_INVALID"),
    );
  assert.throws(
    () => peer.dispatch(a.owner, a.attempt),
    code("KNOWLEDGE_GENERATION_HANDLE_INVALID"),
  );
  assert.throws(
    () => f.native.dispatch(a.owner, { ...a.attempt }),
    code("KNOWLEDGE_GENERATION_HANDLE_INVALID"),
  );
  f.native.failPrepared(a.owner, "KNOWLEDGE_GENERATION_CANCELLED");
  f.native.releaseAttempt(a.attempt);
  f.native.release(a.owner);
  assert.throws(
    () => f.native.dispatch(a.owner, a.attempt),
    code("KNOWLEDGE_GENERATION_HANDLE_INVALID"),
  );
});
test("dispatch intent and observations are one TX and observation before dispatch is rejected", (t) => {
  const f = fixture(t),
    a = f.admit();
  assert.throws(
    () =>
      f.native.observe(a.owner, a.attempt, {
        textDelta: "unowned",
        observationBytes: 7,
      }),
    code("KNOWLEDGE_GENERATION_STALE"),
  );
  f.db.exec(
    "CREATE TRIGGER reject_generation_update BEFORE UPDATE ON knowledge_generations WHEN NEW.state='dispatched' BEGIN SELECT RAISE(ABORT,'authored dispatch rollback'); END",
  );
  assert.throws(
    () => f.native.dispatch(a.owner, a.attempt),
    /authored dispatch rollback/,
  );
  assert.equal(
    f.native.getGeneration("workspace", a.owner.generationId).state,
    "prepared",
  );
  assert.equal(
    f.native.getAttempt("workspace", a.attempt.attemptId).dispatchedAt,
    null,
  );
  f.db.exec("DROP TRIGGER reject_generation_update");
  assert.equal(f.native.dispatch(a.owner, a.attempt).state, "dispatched");
});
test("plan mutation after capture rejects dispatch while preserving prepared original ownership", (t) => {
  const f = fixture(t),
    a = f.admit();
  writeFileSync(join(f.root, "source.ts"), "Changed actual pinned source");
  assert.throws(
    () => f.native.dispatch(a.owner, a.attempt),
    code("KNOWLEDGE_SOURCE_CHANGED"),
  );
  assert.equal(
    f.native.getAttempt("workspace", a.attempt.attemptId).dispatchedAt,
    null,
  );
  f.native.failPrepared(a.owner, "KNOWLEDGE_SOURCE_CHANGED");
  assert.equal(f.native.hasBlocker("workspace"), false);
});
test("authoritative output and cleanup survive source and target changes after actual dispatch; evidence fails fresh authority", (t) => {
  const f = fixture(t),
    a = f.admit(),
    plan = f.knowledge.getGenerationPlan("workspace", a.record.planId)!;
  f.native.dispatch(a.owner, a.attempt);
  writeFileSync(join(f.root, "source.ts"), "Source changed during producer");
  f.native.observe(a.owner, a.attempt, {
    textDelta: "Actual completed output",
    observationBytes: 23,
    eventCount: 1,
  });
  f.native.observe(a.owner, a.attempt, {
    finishReason: "stop",
    observationBytes: 1,
    eventCount: 2,
  });
  f.native.observe(a.owner, a.attempt, {
    streamDone: true,
    observationBytes: 0,
    eventCount: 2,
  });
  f.native.settle(a.owner, a.attempt, {
    state: "completed",
    cleanup: { confirmed: true, method: "iterator-complete", reason: null },
  });
  assert.equal(
    f.native.getGeneration("workspace", a.owner.generationId).state,
    "completed",
  );
  assert.throws(
    () => f.native.readEvidence(plan, a.owner.generationId),
    code("KNOWLEDGE_SOURCE_CHANGED"),
  );
  f.native.markCandidate("workspace", a.owner.generationId, {
    state: "withheld",
    reason: "KNOWLEDGE_SOURCE_CHANGED",
  });
  assert.equal(
    f.native.getAttempt("workspace", a.attempt.attemptId).output,
    "Actual completed output",
  );
});
test("finish stop alone and return.done cleanup do not create successful native output", (t) => {
  const f = fixture(t),
    a = f.admit();
  f.native.dispatch(a.owner, a.attempt);
  f.native.observe(a.owner, a.attempt, {
    textDelta: "Output",
    observationBytes: 6,
  });
  f.native.observe(a.owner, a.attempt, {
    finishReason: "stop",
    observationBytes: 1,
  });
  assert.throws(
    () =>
      f.native.settle(a.owner, a.attempt, {
        state: "completed",
        cleanup: { confirmed: true, method: "iterator-return", reason: null },
      }),
    code("KNOWLEDGE_GENERATION_INCOMPLETE"),
  );
  f.native.settle(a.owner, a.attempt, {
    state: "failed",
    errorCode: "KNOWLEDGE_PROTOCOL_ERROR",
    cleanup: { confirmed: true, method: "iterator-return", reason: null },
  });
  assert.throws(
    () =>
      f.native.readEvidence(
        f.knowledge.getGenerationPlan("workspace", a.record.planId)!,
        a.record.id,
      ),
    code("KNOWLEDGE_GENERATION_INCOMPLETE"),
  );
});
test("native completed output has exact immutable nullable usage and rejects every late callback", (t) => {
  const f = fixture(t),
    a = f.complete(),
    attempt = f.native.getAttempt("workspace", a.attempt.attemptId),
    record = f.native.getGeneration("workspace", a.record.id),
    plan = f.knowledge.getGenerationPlan("workspace", record.planId)!;
  assert.ok(
    Object.isFrozen(record) &&
      Object.isFrozen(attempt) &&
      Object.isFrozen(attempt.usage),
  );
  const evidence = f.native.readEvidence(plan, record.id);
  assert.equal(evidence.outputSha256, sha256(attempt.output));
  assert.deepEqual(evidence.usage, {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningTokens: null,
  });
  for (const action of [
    () =>
      f.native.observe(a.owner, a.attempt, {
        textDelta: "late",
        observationBytes: 4,
      }),
    () =>
      f.native.settle(a.owner, a.attempt, {
        state: "failed",
        cleanup: { confirmed: true, method: "iterator-return", reason: null },
      }),
    () => f.native.dispatch(a.owner, a.attempt),
  ])
    assert.throws(action, code("KNOWLEDGE_GENERATION_STALE"));
  assert.equal(
    f.native.getGeneration("workspace", record.id).sha256,
    record.sha256,
  );
});
test("actual charged overflow and retained prefix are separate; overflowing owner can never complete", (t) => {
  const f = fixture(t),
    input = f.request(undefined, {
      budget: normalizeKnowledgeGenerationBudget({ maxOutputBytes: 4 }),
    }),
    a = f.admit(input);
  f.native.dispatch(a.owner, a.attempt);
  f.native.observe(a.owner, a.attempt, {
    textDelta: "🙂",
    textBytes: 9,
    outputTruncated: true,
    observationBytes: 9,
    eventCount: 1,
  });
  const attempt = f.native.getAttempt("workspace", a.attempt.attemptId);
  assert.equal(attempt.outputBytes, 4);
  assert.equal(attempt.observedTextBytes, 9);
  assert.equal(attempt.outputTruncated, true);
  assert.throws(
    () =>
      f.native.observe(a.owner, a.attempt, {
        finishReason: "stop",
        observationBytes: 1,
      }),
    code("KNOWLEDGE_GENERATION_LIMIT"),
  );
  f.native.settle(a.owner, a.attempt, {
    state: "failed",
    errorCode: "KNOWLEDGE_GENERATION_OUTPUT_LIMIT",
    cleanup: { confirmed: true, method: "iterator-return", reason: null },
  });
  assert.equal(f.native.hasBlocker("workspace"), false);
});
test("event and observation caps retain the last finite charged observation then reject further callbacks", (t) => {
  const f = fixture(t),
    a = f.admit(
      f.request(undefined, {
        budget: normalizeKnowledgeGenerationBudget({
          maxObservationBytes: 1,
          maxEvents: 1,
        }),
      }),
    );
  f.native.dispatch(a.owner, a.attempt);
  f.native.observe(a.owner, a.attempt, { observationBytes: 2, eventCount: 1 });
  assert.equal(
    f.native.getAttempt("workspace", a.attempt.attemptId).observationBytes,
    2,
  );
  assert.throws(
    () =>
      f.native.observe(a.owner, a.attempt, {
        observationBytes: 0,
        eventCount: 2,
      }),
    code("KNOWLEDGE_GENERATION_LIMIT"),
  );
  f.native.settle(a.owner, a.attempt, {
    state: "failed",
    errorCode: "KNOWLEDGE_GENERATION_OBSERVATION_LIMIT",
    cleanup: { confirmed: true, method: "iterator-return", reason: null },
  });
});
test("cumulative usage and provider request identity never silently decrease or switch owners", (t) => {
  const f = fixture(t),
    a = f.admit();
  f.native.dispatch(a.owner, a.attempt);
  f.native.observe(a.owner, a.attempt, {
    observationBytes: 1,
    usage: {
      inputTokens: 7,
      outputTokens: 3,
      cachedInputTokens: 2,
      reasoningTokens: null,
    },
    providerRequestId: "provider-original",
    eventCount: 1,
  });
  for (const value of [
    {
      observationBytes: 1,
      usage: {
        inputTokens: 6,
        outputTokens: 3,
        cachedInputTokens: 2,
        reasoningTokens: null,
      },
    },
    { observationBytes: 1, providerRequestId: "provider-other" },
    { observationBytes: 1, eventCount: 3 },
  ])
    assert.throws(
      () => f.native.observe(a.owner, a.attempt, value),
      (error) => error instanceof EngineError,
    );
  assert.equal(f.native.getAttempt("workspace", a.attempt.attemptId).events, 1);
});
test("original deadline and budget hash survive await-equivalent clock advance and cannot be reset by preparing another attempt", (t) => {
  const f = fixture(t),
    a = f.admit(
      f.request(undefined, {
        budget: normalizeKnowledgeGenerationBudget({
          maxDurationMs: 50,
          providerRequestTimeoutMs: 50,
          inactivityTimeoutMs: 20,
          cleanupTimeoutMs: 10,
        }),
      }),
    );
  f.state.now += 51;
  assert.throws(
    () => f.native.dispatch(a.owner, a.attempt),
    code("KNOWLEDGE_GENERATION_DEADLINE"),
  );
  assert.throws(
    () =>
      f.native.prepareAttempt(a.owner, {
        id: randomUUID(),
        sha256: sha256("other"),
        bytes: 5,
      }),
    code("KNOWLEDGE_GENERATION_STALE"),
  );
  const record = f.native.getGeneration("workspace", a.record.id);
  assert.equal(record.deadline, a.record.deadline);
  assert.equal(record.budgetSha256, a.record.budgetSha256);
  f.native.failPrepared(a.owner, "KNOWLEDGE_GENERATION_DEADLINE");
});
test("partial unknown cleanup creates persisted blockers before startup and has exact output/usage", (t) => {
  const f = fixture(t),
    a = f.uncertain(),
    attempt = f.native.getAttempt("workspace", a.attempt.attemptId);
  assert.equal(attempt.cleanup!.confirmed, false);
  assert.equal(attempt.cleanup!.method, "iterator-return");
  assert.equal(attempt.output, "Partial original output");
  assert.equal(attempt.usage.inputTokens, 7);
  assert.equal(f.native.hasBlocker("workspace"), true);
  assert.equal(hasKnowledgeGenerationBlocker(f.db, "workspace"), true);
  assert.throws(
    () => f.native.create(f.request()),
    code("KNOWLEDGE_GENERATION_BLOCKED"),
  );
  assert.throws(
    () =>
      f.native.readEvidence(
        f.knowledge.getGenerationPlan("workspace", a.record.planId)!,
        a.record.id,
      ),
    code("KNOWLEDGE_GENERATION_INCOMPLETE"),
  );
});
test("active capture release durably settles uncertainty, revokes late authority, and leaves original cleanup unknown", (t) => {
  const f = fixture(t),
    a = f.admit();
  f.native.dispatch(a.owner, a.attempt);
  f.native.observe(a.owner, a.attempt, {
    textDelta: "Durable partial prefix",
    observationBytes: 22,
  });
  f.native.releaseAttempt(a.attempt);
  f.native.release(a.owner);
  assert.equal(
    f.native.getGeneration("workspace", a.record.id).state,
    "uncertain",
  );
  assert.equal(
    f.native.getAttempt("workspace", a.attempt.attemptId).cleanup!.confirmed,
    false,
  );
  assert.equal(f.native.hasBlocker("workspace"), true);
  assert.throws(
    () => f.native.observe(a.owner, a.attempt, { observationBytes: 0 }),
    code("KNOWLEDGE_GENERATION_HANDLE_INVALID"),
  );
});
test("settlement TX rollback leaves active blocker and release establishes durable same-process uncertainty", (t) => {
  const f = fixture(t),
    a = f.admit();
  f.native.dispatch(a.owner, a.attempt);
  f.db.exec(
    "CREATE TRIGGER reject_terminal BEFORE UPDATE ON knowledge_generations WHEN NEW.state='failed' BEGIN SELECT RAISE(ABORT,'authored terminal rollback'); END",
  );
  assert.throws(
    () =>
      f.native.settle(a.owner, a.attempt, {
        state: "failed",
        errorCode: "PROVIDER_FAILURE",
        cleanup: { confirmed: true, method: "iterator-return", reason: null },
      }),
    /authored terminal rollback/,
  );
  assert.equal(
    f.native.getGeneration("workspace", a.record.id).state,
    "dispatched",
  );
  assert.equal(
    f.native.getAttempt("workspace", a.attempt.attemptId).cleanup,
    null,
  );
  assert.equal(f.native.hasBlocker("workspace"), true);
  f.native.releaseAttempt(a.attempt);
  f.native.release(a.owner);
  assert.equal(
    f.native.getGeneration("workspace", a.record.id).state,
    "uncertain",
  );
});
for (const boundary of [
  "create",
  "prepare",
  "dispatch",
  "text",
  "finish",
] as const)
  test(`restart at actual native ${boundary} boundary never replays and preserves the dispatch frontier`, (t) => {
    const f = fixture(t),
      input = f.request(),
      made = f.native.create(input);
    assert.equal(made.kind, "created");
    if (made.kind !== "created") throw new Error("owner");
    let attempt: KnowledgeGenerationAttemptCapture | undefined;
    if (boundary !== "create") {
      attempt = f.native.prepareAttempt(made.capture, {
        id: randomUUID(),
        sha256: sha256("actual envelope"),
        bytes: 64,
      }).capture;
    }
    if (["dispatch", "text", "finish"].includes(boundary))
      f.native.dispatch(made.capture, attempt!);
    if (["text", "finish"].includes(boundary))
      f.native.observe(made.capture, attempt!, {
        textDelta: "Partial preserved",
        observationBytes: 17,
      });
    if (boundary === "finish")
      f.native.observe(made.capture, attempt!, {
        finishReason: "stop",
        observationBytes: 1,
      });
    const reopened = f.reopen(),
      summary = reopened.recoverInterruptedOwners(),
      intended = ["dispatch", "text", "finish"].includes(boundary),
      record = reopened.getGeneration("workspace", made.record.id);
    assert.equal(summary.recovered, 1);
    assert.equal(record.state, intended ? "uncertain" : "cancelled");
    assert.equal(reopened.hasBlocker("workspace"), intended);
    assert.equal(reopened.create(input).kind, "duplicate");
    assert.equal("capture" in reopened.create(input), false);
    assert.deepEqual(reopened.recoverInterruptedOwners(), {
      recovered: 0,
      cancelled: 0,
      uncertain: 0,
    });
    if (attempt) {
      const stored = reopened.getAttempt("workspace", attempt.attemptId);
      assert.equal(stored.cleanup!.confirmed, !intended);
      if (["text", "finish"].includes(boundary))
        assert.equal(stored.output, "Partial preserved");
    }
  });
test("recovery ack preserves immutable uncertain records and nullable usage; explicit second resume is mandatory", (t) => {
  const f = fixture(t),
    a = f.uncertain(),
    before = f.native.getGeneration("workspace", a.record.id),
    attempt = f.native.getAttempt("workspace", a.attempt.attemptId),
    preview = f.native.getRecoveryPreview("workspace");
  for (const value of [{ ...preview }, new Proxy(preview, {})])
    assert.throws(
      () =>
        f.native.acknowledgeRecovery(value, {
          requestId: "ack",
          reason: "Host inspected original native evidence",
        }),
      code("KNOWLEDGE_GENERATION_HANDLE_INVALID"),
    );
  const ack = f.native.acknowledgeRecovery(preview, {
    requestId: "ack",
    reason: "Host inspected original native evidence",
  });
  assert.equal(ack.barrier.state, "pending-resume");
  assert.equal(f.native.hasBlocker("workspace"), true);
  assert.deepEqual(f.native.getGeneration("workspace", a.record.id), before);
  assert.deepEqual(
    f.native.getAttempt("workspace", a.attempt.attemptId),
    attempt,
  );
  assert.equal(
    f.native.acknowledgeRecovery(preview, {
      requestId: "ack",
      reason: "Host inspected original native evidence",
    }).acknowledgment.id,
    ack.acknowledgment.id,
  );
  assert.throws(
    () =>
      f.native.acknowledgeRecovery(preview, {
        requestId: "ack",
        reason: "Different decision",
      }),
    code("KNOWLEDGE_REQUEST_CONFLICT"),
  );
  const input = {
      workspaceId: "workspace",
      requestId: "resume",
      expectedRevision: ack.barrier.revision,
      expectedFrontierSha256: ack.barrier.frontierSha256,
    },
    resumed = f.native.resumeWorkspace(input);
  assert.equal(resumed.barrier.state, "clear");
  assert.equal(f.native.hasBlocker("workspace"), false);
  assert.equal(
    f.native.resumeWorkspace(input).acknowledgment.id,
    resumed.acknowledgment.id,
  );
  assert.equal(
    f.native.getGeneration("workspace", a.record.id).state,
    "uncertain",
  );
  assert.equal(
    f.native.getAttempt("workspace", a.attempt.attemptId).cleanup!.confirmed,
    false,
  );
});
test("acknowledged uncertain history never fills the bounded recovery frontier", (t) => {
  const f = fixture(t);
  for (let index = 0; index < 129; index++) {
    const a = f.uncertain();
    f.native.releaseAttempt(a.attempt);
    f.native.release(a.owner);
    const preview = f.native.getRecoveryPreview("workspace"),
      ack = f.native.acknowledgeRecovery(preview, {
        requestId: `ack-${index}`,
        reason: "Host inspected original native evidence",
      });
    f.native.releaseRecoveryPreview(preview);
    f.native.resumeWorkspace({
      workspaceId: "workspace",
      requestId: `resume-${index}`,
      expectedRevision: ack.barrier.revision,
      expectedFrontierSha256: ack.barrier.frontierSha256,
    });
  }
  assert.equal(f.native.hasBlocker("workspace"), false);
  assert.equal(hasKnowledgeGenerationBlocker(f.db, "workspace"), false);
  const open = f.uncertain();
  assert.equal(hasKnowledgeGenerationBlocker(f.db, "workspace"), true);
  assert.deepEqual(
    f.native.getRecoveryPreview("workspace").generations.map((g) => g.id),
    [open.record.id],
  );
});
test("reissuing a recovery preview replaces the workspace's previous one instead of exhausting the capture limit", (t) => {
  const f = fixture(t);
  f.uncertain();
  let previous = f.native.getRecoveryPreview("workspace");
  for (let index = 0; index < 129; index++) {
    const preview = f.native.getRecoveryPreview("workspace");
    assert.throws(
      () =>
        f.native.acknowledgeRecovery(previous, {
          requestId: `replaced-${index}`,
          reason: "Host inspected original native evidence",
        }),
      code("KNOWLEDGE_GENERATION_HANDLE_INVALID"),
    );
    assert.throws(
      () => f.native.releaseRecoveryPreview(previous),
      code("KNOWLEDGE_GENERATION_HANDLE_INVALID"),
    );
    previous = preview;
  }
  assert.equal(
    f.native.acknowledgeRecovery(previous, {
      requestId: "ack",
      reason: "Host inspected original native evidence",
    }).barrier.state,
    "pending-resume",
  );
});
test("tampered acknowledgment fails closed instead of hiding its uncertain generation", (t) => {
  const f = fixture(t),
    a = f.uncertain();
  f.native.releaseAttempt(a.attempt);
  f.native.release(a.owner);
  const preview = f.native.getRecoveryPreview("workspace"),
    { acknowledgment, barrier } = f.native.acknowledgeRecovery(preview, {
      requestId: "ack",
      reason: "Host inspected original native evidence",
    });
  f.native.releaseRecoveryPreview(preview);
  f.native.resumeWorkspace({
    workspaceId: "workspace",
    requestId: "resume",
    expectedRevision: barrier.revision,
    expectedFrontierSha256: barrier.frontierSha256,
  });
  assert.equal(hasKnowledgeGenerationBlocker(f.db, "workspace"), false);
  f.db
    .prepare(
      "UPDATE knowledge_generation_recovery_acknowledgments SET data=? WHERE id=?",
    )
    .run(
      JSON.stringify({ ...acknowledgment, reason: "Rewritten inspection" }),
      acknowledgment.id,
    );
  assert.throws(
    () => hasKnowledgeGenerationBlocker(f.db, "workspace"),
    code("KNOWLEDGE_HASH_MISMATCH"),
  );
  assert.throws(
    () => f.native.getRecoveryPreview("workspace"),
    code("KNOWLEDGE_HASH_MISMATCH"),
  );
});
test("recovery decisions reject changed preview/barrier/current binding and current source deletion cannot rewrite evidence", (t) => {
  const f = fixture(t),
    a = f.uncertain(),
    preview = f.native.getRecoveryPreview("workspace");
  writeFileSync(
    join(f.root, "source.ts"),
    "Deleted/replaced original generation source",
  );
  const ack = f.native.acknowledgeRecovery(preview, {
    requestId: "ack",
    reason: "Acknowledgment does not claim source freshness or cleanup",
  });
  assert.throws(
    () =>
      f.native.resumeWorkspace({
        workspaceId: "workspace",
        requestId: "stale-resume",
        expectedRevision: preview.barrierRevision,
        expectedFrontierSha256: preview.frontierSha256,
      }),
    code("KNOWLEDGE_GENERATION_STALE"),
  );
  f.state.bindingSuffix = "another-store";
  assert.throws(
    () => f.native.findRequest(a.input),
    code("KNOWLEDGE_BINDING_MISMATCH"),
  );
  assert.throws(
    () =>
      f.native.acknowledgeRecovery(preview, {
        requestId: "other",
        reason: "Host decision",
      }),
    code("KNOWLEDGE_BINDING_MISMATCH"),
  );
  f.state.bindingSuffix = "";
  assert.equal(
    f.native.resumeWorkspace({
      workspaceId: "workspace",
      requestId: "resume",
      expectedRevision: ack.barrier.revision,
      expectedFrontierSha256: ack.barrier.frontierSha256,
    }).barrier.state,
    "clear",
  );
});
test("recovery ACK transaction failure rolls back receipt and barrier without rewriting original producer", (t) => {
  const f = fixture(t),
    a = f.uncertain(),
    preview = f.native.getRecoveryPreview("workspace"),
    barrier = f.native.getBarrier("workspace")!;
  f.db.exec(
    "CREATE TRIGGER reject_ack BEFORE INSERT ON knowledge_generation_recovery_acknowledgments BEGIN SELECT RAISE(ABORT,'authored ack rollback'); END",
  );
  assert.throws(
    () =>
      f.native.acknowledgeRecovery(preview, {
        requestId: "ack",
        reason: "Host inspection",
      }),
    /authored ack rollback/,
  );
  assert.equal(f.native.getBarrier("workspace")!.sha256, barrier.sha256);
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM knowledge_generation_recovery_acknowledgments",
      )
      .get()!.n,
    0,
  );
  assert.equal(
    f.native.getGeneration("workspace", a.record.id).state,
    "uncertain",
  );
});
test("completed native output remains readable and can append exact candidate after restart without new producer", (t) => {
  const f = fixture(t),
    a = f.complete(),
    before = f.native.getGeneration("workspace", a.record.id);
  f.native.releaseAttempt(a.attempt);
  f.native.release(a.owner);
  f.reopen();
  assert.deepEqual(f.native.recoverInterruptedOwners(), {
    recovered: 0,
    cancelled: 0,
    uncertain: 0,
  });
  assert.equal(
    f.native.getGeneration("workspace", a.record.id).sha256,
    before.sha256,
  );
  const handle = f.knowledge.attachGenerationOwner(
      "workspace",
      a.record.planId,
      a.record.id,
    ),
    candidate = f.knowledge.appendCandidate(handle, {
      requestId: "actual-candidate",
      body: f.native.getAttempt("workspace", a.attempt.attemptId).output,
    });
  f.knowledge.releaseGenerationOwner(handle);
  const marked = f.native.markCandidate("workspace", a.record.id, {
    state: "recorded",
    candidateId: candidate.id,
  });
  assert.equal(marked.candidate.candidateId, candidate.id);
  assert.equal(
    f.native.markCandidate("workspace", a.record.id, {
      state: "recorded",
      candidateId: candidate.id,
    }).sha256,
    marked.sha256,
  );
  assert.throws(
    () =>
      f.native.markCandidate("workspace", a.record.id, {
        state: "withheld",
        reason: "erase",
      }),
    code("KNOWLEDGE_RECORD_CONFLICT"),
  );
});
test("native marker rejects missing or another real owner candidate ID and never grants producer authority", (t) => {
  const f = fixture(t),
    a = f.complete();
  assert.throws(
    () =>
      f.native.markCandidate("workspace", a.record.id, {
        state: "recorded",
        candidateId: "missing",
      }),
    code("KNOWLEDGE_RECORD_CONFLICT"),
  );
  const other = f.complete(f.admit(f.request())),
    handle = f.knowledge.attachGenerationOwner(
      "workspace",
      other.record.planId,
      other.record.id,
    ),
    candidate = f.knowledge.appendCandidate(handle, {
      requestId: "other-candidate",
      body: f.native.getAttempt("workspace", other.attempt.attemptId).output,
    });
  f.knowledge.releaseGenerationOwner(handle);
  assert.throws(
    () =>
      f.native.markCandidate("workspace", a.record.id, {
        state: "recorded",
        candidateId: candidate.id,
      }),
    code("KNOWLEDGE_RECORD_CONFLICT"),
  );
});
test("bounded archive validation rejects omitted normalized budget fields and impossible completed errors", (t) => {
  const f = fixture(t),
    a = f.complete(),
    record = f.native.getGeneration("workspace", a.record.id);
  const row = {
    table: "knowledge_generations",
    key: record.id,
    workspaceId: "workspace",
    data: record,
  };
  assert.deepEqual(validateKnowledgeGenerationArchiveRow(row), row);
  function rehash(value: KnowledgeGenerationRecord) {
    const { sha256: _old, ...body } = value;
    return { ...body, sha256: knowledgeHash(body) };
  }
  for (const data of [
    rehash({ ...record, budget: {} as never }),
    rehash({ ...record, errorCode: "impossible" }),
    rehash({ ...record, deadline: record.deadline + 90000 }),
  ])
    assert.throws(
      () => validateKnowledgeGenerationArchiveRow({ ...row, data }),
      (error) => error instanceof EngineError,
    );
  assert.throws(
    () =>
      validateKnowledgeGenerationArchiveRow({ ...row, workspaceId: "foreign" }),
    code("KNOWLEDGE_SCOPE_MISMATCH"),
  );
  assert.throws(
    () => validateKnowledgeGenerationArchiveRow(null),
    code("INVALID_KNOWLEDGE_GENERATION"),
  );
});
test("bounded pages are scoped detached immutable observations with exact keyset continuation", (t) => {
  const f = fixture(t),
    a = f.complete(),
    b = f.complete(f.admit(f.request())),
    page = f.native.listGenerations("workspace", { limit: 1, maxBytes: 10000 });
  assert.equal(page.items.length, 1);
  assert.ok(page.next);
  const next = f.native.listGenerations("workspace", {
    after: page.next!,
    limit: 1,
  });
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0]!.id, page.items[0]!.id);
  assert.ok([a.record.id, b.record.id].includes(next.items[0]!.id));
  assert.ok(
    Object.isFrozen(page) &&
      Object.isFrozen(page.items) &&
      Object.isFrozen(page.items[0]!),
  );
  assert.throws(
    () => f.native.listGenerations("workspace", { maxBytes: 1 }),
    code("KNOWLEDGE_GENERATION_LIMIT"),
  );
  assert.throws(
    () => f.native.getGeneration("foreign", a.record.id),
    code("KNOWLEDGE_NOT_FOUND"),
  );
});
