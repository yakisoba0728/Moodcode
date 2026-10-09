import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  EngineError,
  type JsonObject,
  type RunReceipt,
  type Session,
  type Workspace,
} from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import { assertWorkspaceTrustSourcesCurrent } from "../workspace/trust.js";
import type {
  KnowledgeContextRequest,
  KnowledgeContextSourcePorts,
} from "./context-types.js";
import {
  KNOWLEDGE_CONTEXT_LIMITS,
  KnowledgeContextSource,
  knowledgeContextPolicy,
} from "./context-source.js";
import type { KnowledgeGenerationBudget } from "./generation-types.js";
import { knowledgeHash } from "./validation.js";

const KEY = "approved.memory";
const BODY = 'Exact quoted project facts "quotes", \\ paths, 한글😀.\n';
const errorCode =
  (expected?: string) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof EngineError);
    if (expected) assert.equal(error.code, expected);
    return true;
  };
type Ports = Omit<KnowledgeContextSourcePorts, "getWorkspace" | "readTx">;

async function fixture(
  t: TestContext,
  options: {
    body?: string;
    generationBudget?: Partial<KnowledgeGenerationBudget>;
  } = {},
) {
  const base = realpathSync(
    mkdtempSync(join(tmpdir(), "moodcode-knowledge-context-source-")),
  );
  const root = join(base, "repo"),
    dbPath = join(base, "engine.sqlite");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  writeFileSync(join(root, "AGENTS.md"), "Host approved instruction source.\n");
  writeFileSync(join(root, "source.ts"), "export const observedSource = 1;\n");
  let body = options.body ?? BODY,
    generationCalls = 0;
  const provider = {
    id: "knowledge-context-native-fixture",
    async *streamTurn() {
      yield {
        type: "text.delta" as const,
        delta: "Actual completed source message.",
      };
      yield { type: "finish" as const, reason: "stop" as const };
    },
    async *streamGeneration() {
      generationCalls++;
      yield { type: "text.delta" as const, delta: body };
      yield { type: "finish" as const, reason: "stop" as const };
    },
  };
  const engine = createEngine({
    dbPath,
    artifactDir: join(base, "artifacts"),
    providers: [provider],
    tools: [],
    knowledgeGeneration: true,
    knowledgePublication: true,
    defaults: {
      providerId: provider.id,
      modelId: "fixture-model",
      mode: "plan",
      limits: { maxTurns: 2, maxDurationMs: 15000 },
    },
  });
  t.after(async () => {
    await engine.close();
    if (process.env.MOODCODE_HOST_VALIDATION_PRESERVE_FIXTURES === "1")
      t.diagnostic(`Preserved native fixture: ${base}`);
    else rmSync(base, { recursive: true, force: true });
  });
  const command = async <T>(type: string, payload: JsonObject): Promise<T> => {
    const result = await engine.dispatch({
      schemaVersion: 1,
      commandId: randomUUID(),
      type,
      payload,
    });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result.result as unknown as T;
  };
  const workspace = await command<Workspace>("workspace.open", { path: root });
  const session = await command<Session>("session.create", {
    workspaceId: workspace.id,
  });
  const sourceRun = await command<RunReceipt>("run.submit", {
    sessionId: session.id,
    requestId: "source-completed",
    prompt: "Complete a real source task.",
  });
  assert.equal((await engine.waitForRun(sourceRun.runId)).state, "completed");
  await engine.waitForSession(session.id);
  const sourceMessage = engine.store
    .getSnapshot(session.id)
    .messages.find((message) => message.role === "assistant")!;
  const trust = await engine.setWorkspaceTrust({
    workspaceId: workspace.id,
    requestId: "approve-source-trust",
    expectedRevision: 0,
    decision: "allow",
    preview: engine.previewWorkspaceTrust(workspace.id, ["AGENTS.md"]),
  });
  const attemptOwners = new Map<string, string>();
  let publications = 0;
  async function publish(
    key = KEY,
    nextBody = options.body ?? BODY,
    expiresAt = new Date(Date.now() + 120000).toISOString(),
  ) {
    body = nextBody;
    const index = ++publications;
    const projection = engine.captureWorkspaceKnowledgeSources(workspace.id, [
      { kind: "file", path: "source.ts" },
      {
        kind: "message",
        sessionId: session.id,
        runId: sourceRun.runId,
        messageId: sourceMessage.id,
      },
    ]);
    const logical = engine.previewWorkspaceKnowledgeGeneration({
      providerId: provider.id,
      modelId: "fixture-model",
      projection,
    });
    const currentTrust = engine.workspaceKnowledge.getTrust(workspace.id)!;
    const plan = await engine.prepareWorkspaceKnowledgeGeneration({
      workspaceId: workspace.id,
      requestId: `source-plan-${index}`,
      expectedTrustRevision: currentTrust.revision,
      projection,
      target: engine.captureWorkspaceKnowledgeDocumentTarget(workspace.id, key),
      providerId: provider.id,
      modelId: "fixture-model",
      requestSha256: logical.requestSha256,
      requestBytes: logical.requestBytes,
      maxOutputBytes: 16384,
      expiresAt,
    });
    const generated = await engine.generateWorkspaceKnowledge({
      workspaceId: workspace.id,
      planId: plan.id,
      requestId: `source-generation-${index}`,
      projection,
      ...(options.generationBudget ? { budget: options.generationBudget } : {}),
    });
    assert.equal(
      generated.generation.state,
      "completed",
      JSON.stringify(generated),
    );
    assert.ok(generated.candidate && generated.attempt);
    attemptOwners.set(generated.attempt.id, generated.generation.id);
    const publication = await engine.publishWorkspaceKnowledge({
      workspaceId: workspace.id,
      requestId: `source-publication-${index}`,
      approved: true,
      preview: engine.previewWorkspaceKnowledgePublication({
        workspaceId: workspace.id,
        candidateId: generated.candidate.id,
      }),
    });
    return {
      ...publication,
      candidate: generated.candidate,
      generation: generated.generation,
      attempt: generated.attempt,
      plan,
    };
  }
  const published = await publish();
  const host = engine.store.createKnowledgeHostAdapter({
    checkHostBinding: (id) => engine.workspaceKnowledge.readHostBinding(id),
    readWorkspaceDocumentTarget: (binding, key) =>
      engine.captureWorkspaceKnowledgeDocumentTarget(binding.workspaceId, key),
  });
  const ports: Ports = {
    checkBinding: (id) => engine.workspaceKnowledge.readHostBinding(id),
    assertOwnerCurrent(id, owner) {
      const actual = engine.store.getSession(owner.sessionId);
      if (
        actual.workspaceId !== id ||
        owner.runId !== null ||
        owner.profile !== null
      )
        throw new EngineError(
          "KNOWLEDGE_CONTEXT_STALE",
          "Fixture requires its actual runless session owner",
        );
    },
    isPaused: (id) =>
      engine.workspaceKnowledge.getImportPause(id) !== undefined,
    getDocumentHead(id, key) {
      const document = engine.getWorkspaceKnowledgeDocument(id, key);
      return document
        ? (engine.getWorkspaceKnowledgePublication(id, document.publicationId)
            .head ?? undefined)
        : undefined;
    },
    getDocumentRevision: (id, revisionId) =>
      engine.getWorkspaceKnowledgeDocumentRevision(id, revisionId),
    getPublication: (id, publicationId) =>
      engine.getWorkspaceKnowledgePublicationRecord(id, publicationId),
    getReceipt: (id, requestId) =>
      engine.getWorkspaceKnowledgePublicationReceipt(id, requestId),
    getCandidate: (id, candidateId) =>
      engine.workspaceKnowledge.getCandidate(id, candidateId),
    getGeneration: (id, generationId) =>
      engine.getWorkspaceKnowledgeGeneration(id, generationId).generation,
    getAttempt(id, attemptId) {
      const ownerId = attemptOwners.get(attemptId);
      assert.ok(ownerId);
      const actual = engine.getWorkspaceKnowledgeGeneration(
        id,
        ownerId,
      ).attempt;
      assert.ok(actual);
      return actual;
    },
    getPlan: (id, planId) =>
      engine.workspaceKnowledge.getGenerationPlan(id, planId),
    getTrust: (id) => engine.workspaceKnowledge.getTrust(id),
    getTrustRevision: (id, revisionId) =>
      engine.workspaceKnowledge.getTrustRevision(id, revisionId),
    assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent,
    assertSourcesCurrent: (binding, manifest) =>
      host.assertSourcesCurrent(binding, manifest),
  };
  function source(overrides: Partial<Ports> = {}) {
    return engine.store.createKnowledgeContextSource({
      ...ports,
      ...overrides,
    });
  }
  function request(
    overrides: Partial<KnowledgeContextRequest> = {},
  ): KnowledgeContextRequest {
    return {
      workspace,
      owner: { sessionId: session.id, runId: null, profile: null },
      policy: { documentKeys: [KEY], slotBytes: 16384 },
      budget: {
        slotBytes: 16384,
        maxContextBytes: 65536,
        reservedBytes: 256,
        requiredMessagesBytes: 64,
        contextWindow: null,
        outputTokens: 1024,
      },
      signal: new AbortController().signal,
      ...overrides,
    };
  }
  function mutate<T>(operation: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(dbPath);
    try {
      return operation(db);
    } finally {
      db.close();
    }
  }
  return {
    engine,
    root,
    dbPath,
    workspace,
    session,
    trust,
    published,
    publish,
    ports,
    source,
    request,
    mutate,
    calls: () => generationCalls,
  };
}

test("actual native document yields complete immutable quoted provenance and exact serialization charge", async (t) => {
  const f = await fixture(t),
    source = f.source(),
    contribution = await source.prepare(f.request());
  assert.equal(contribution.complete, true);
  assert.equal(contribution.messages.length, 1);
  assert.equal(contribution.messages[0]!.role, "assistant");
  const content = contribution.messages[0]!.content;
  const data = JSON.parse(content.slice(content.indexOf("\n") + 1));
  assert.equal(data.authority, "read-only");
  assert.equal(data.workspaceId, f.workspace.id);
  assert.equal(data.policySha256, contribution.policySha256);
  assert.equal(data.documents[0].body, BODY);
  const manifest = contribution.documents[0]!;
  assert.equal(
    manifest.sourceManifestSha256,
    knowledgeHash(f.published.candidate.source),
  );
  assert.equal(manifest.sourceTextSha256, f.published.candidate.source.sha256);
  assert.notEqual(manifest.sourceManifestSha256, manifest.sourceTextSha256);
  assert.equal(manifest.candidateExpiresAt, f.published.candidate.expiresAt);
  assert.equal(manifest.planExpiresAt, f.published.plan.expiresAt);
  assert.deepEqual(data.documents[0], { ...manifest, body: BODY });
  assert.equal(JSON.stringify(contribution.documents).includes(BODY), false);
  assert.equal(
    contribution.reservations.contributedBytes,
    Buffer.byteLength(JSON.stringify(contribution.messages[0])) + 1,
  );
  assert.equal(contribution.inputEstimate.tokens, null);
  assert.equal(
    contribution.inputEstimate.utf8ByteUpperBound,
    contribution.reservations.contributedBytes,
  );
  assert.ok(
    Object.isFrozen(contribution) &&
      Object.isFrozen(contribution.documents[0]) &&
      Object.isFrozen(contribution.messages[0]),
  );
  await source.assertFresh(contribution, new AbortController().signal);
  source.release(contribution);
  assert.equal(f.calls(), 1);
});

test("whole documents preserve host-selected order and never promote missing omissions on retry", async (t) => {
  const f = await fixture(t);
  await f.publish("second.memory", "Second complete body.");
  const source = f.source(),
    contribution = await source.prepare(
      f.request({
        policy: {
          documentKeys: ["second.memory", "missing.memory", KEY],
          slotBytes: 16384,
        },
      }),
    );
  assert.deepEqual(
    contribution.documents.map((doc) => doc.documentKey),
    ["second.memory", KEY],
  );
  assert.deepEqual(contribution.omissions, [
    { documentKey: "missing.memory", reason: "missing" },
  ]);
  const originalMessages = JSON.stringify(contribution.messages);
  await f.publish(
    "missing.memory",
    "Newly approved body must await a new context capture.",
  );
  await source.assertFresh(contribution, new AbortController().signal);
  assert.equal(JSON.stringify(contribution.messages), originalMessages);
  source.release(contribution);
});

test("exact total reservation and known-window output reserve enforce whole-message byte boundary", async (t) => {
  const f = await fixture(t),
    source = f.source(),
    original = await source.prepare(f.request());
  const bytes = original.reservations.contributedBytes;
  source.release(original);
  // Changing budget does not change the serialized policy/provenance message.
  const exact = await source.prepare(
    f.request({
      budget: {
        slotBytes: 16384,
        maxContextBytes: bytes + 320,
        reservedBytes: 256,
        requiredMessagesBytes: 64,
        contextWindow: bytes + 1344,
        outputTokens: 1024,
      },
    }),
  );
  assert.equal(exact.documents.length, 1);
  assert.equal(exact.reservations.availableBytes, bytes);
  source.release(exact);
  const short = await source.prepare(
    f.request({
      budget: {
        slotBytes: 16384,
        maxContextBytes: bytes + 319,
        reservedBytes: 256,
        requiredMessagesBytes: 64,
        contextWindow: null,
        outputTokens: 1024,
      },
    }),
  );
  assert.equal(short.messages.length, 0);
  assert.deepEqual(short.omissions, [
    { documentKey: KEY, reason: "context-budget" },
  ]);
  source.release(short);
  await assert.rejects(
    source.prepare(
      f.request({
        budget: {
          slotBytes: 16384,
          maxContextBytes: 319,
          reservedBytes: 256,
          requiredMessagesBytes: 64,
          contextWindow: null,
          outputTokens: 1024,
        },
      }),
    ),
    errorCode("KNOWLEDGE_CONTEXT_BUDGET"),
  );
});

test("JSON escaping is charged before selection and a valid large native document is wholly omitted", async (t) => {
  const f = await fixture(t, { body: '"'.repeat(6000) }),
    source = f.source(),
    contribution = await source.prepare(f.request());
  assert.equal(f.published.document.body.length, 6000);
  assert.equal(contribution.messages.length, 0);
  assert.equal(contribution.documents.length, 0);
  assert.deepEqual(contribution.omissions, [
    { documentKey: KEY, reason: "context-budget" },
  ]);
  source.release(contribution);
});

for (const mutation of [
  "source",
  "trust",
  "deny",
  "pause",
  "revoke",
  "expiry",
] as const)
  test(`actual ${mutation} produces bounded omission and invalidates an included original capture`, async (t) => {
    const f = await fixture(t);
    let now = Date.now();
    const source = f.source({ now: () => now }),
      original = await source.prepare(f.request());
    assert.equal(original.documents.length, 1);
    if (mutation === "source")
      writeFileSync(
        join(f.root, "source.ts"),
        "export const observedSource = 2;\n",
      );
    if (mutation === "trust")
      writeFileSync(
        join(f.root, "AGENTS.md"),
        "Changed instruction source was not approved.\n",
      );
    if (mutation === "deny")
      await f.engine.setWorkspaceTrust({
        workspaceId: f.workspace.id,
        requestId: "deny-context",
        expectedRevision: f.trust.revision,
        decision: "deny",
      });
    if (mutation === "pause")
      f.engine.store.pauseImportedWorkspaceKnowledge(
        f.workspace.id,
        "a".repeat(64),
      );
    if (mutation === "revoke")
      await f.engine.revokeWorkspaceKnowledge({
        workspaceId: f.workspace.id,
        requestId: "revoke-context",
        approved: true,
        preview: f.engine.previewWorkspaceKnowledgeRevocation({
          workspaceId: f.workspace.id,
          publicationId: f.published.publication.id,
        }),
      });
    if (mutation === "expiry") now = Date.parse(f.published.plan.expiresAt);
    await assert.rejects(
      source.assertFresh(original, new AbortController().signal),
      errorCode("KNOWLEDGE_CONTEXT_STALE"),
    );
    const empty = await source.prepare(f.request());
    assert.equal(empty.messages.length, 0);
    const reason =
      mutation === "source"
        ? "stale"
        : mutation === "trust" || mutation === "deny"
          ? "untrusted"
          : mutation === "pause"
            ? "paused"
            : mutation === "revoke"
              ? "revoked"
              : "expired";
    assert.deepEqual(empty.omissions, [{ documentKey: KEY, reason }]);
    await source.assertFresh(empty, new AbortController().signal);
    source.release(empty);
    source.release(original);
    assert.equal(f.calls(), 1);
  });

test("a document expiring during its final source I/O is omitted and cannot pass freshness", async (t) => {
  const f = await fixture(t);
  let now = Date.now(),
    expireDuringRead = false;
  const source = f.source({
    now: () => now,
    assertSourcesCurrent(binding, manifest) {
      f.ports.assertSourcesCurrent(binding, manifest);
      if (expireDuringRead) now = Date.parse(f.published.plan.expiresAt);
    },
  });
  const original = await source.prepare(f.request());
  expireDuringRead = true;
  await assert.rejects(
    source.assertFresh(original, new AbortController().signal),
    errorCode("KNOWLEDGE_CONTEXT_STALE"),
  );
  now = Date.now();
  const empty = await source.prepare(f.request());
  assert.deepEqual(empty.omissions, [{ documentKey: KEY, reason: "expired" }]);
  source.release(original);
  source.release(empty);
});

test("the first document expiring during the second source read is swept after all host I/O", async (t) => {
  const f = await fixture(t),
    second = await f.publish(
      "second.memory",
      "Second later-lived document.",
      new Date(Date.now() + 240000).toISOString(),
    );
  let now = Date.now(),
    reads = 0,
    expire = false;
  const source = f.source({
    now: () => now,
    assertSourcesCurrent(binding, manifest) {
      f.ports.assertSourcesCurrent(binding, manifest);
      reads++;
      if (expire && reads % 2 === 0)
        now = Date.parse(f.published.plan.expiresAt);
    },
  });
  const request = f.request({
    policy: { documentKeys: [KEY, "second.memory"], slotBytes: 16384 },
  });
  const original = await source.prepare(request);
  assert.equal(original.documents.length, 2);
  expire = true;
  await assert.rejects(
    source.assertFresh(original, new AbortController().signal),
    errorCode("KNOWLEDGE_CONTEXT_STALE"),
  );
  now = Date.now();
  reads = 0;
  const next = await source.prepare(request);
  assert.deepEqual(
    next.documents.map((document) => document.documentRevisionId),
    [second.document.id],
  );
  assert.deepEqual(next.omissions, [{ documentKey: KEY, reason: "expired" }]);
  source.release(original);
  source.release(next);
});

test("completed producer and publication operation deadlines do not expire valid approved context", async (t) => {
  const f = await fixture(t),
    now = Math.max(
      f.published.generation.deadline + 1,
      Date.parse(f.published.publication.expiresAt) + 1,
    );
  assert.ok(now < Date.parse(f.published.candidate.expiresAt));
  const source = f.source({ now: () => now }),
    contribution = await source.prepare(f.request());
  assert.equal(contribution.documents.length, 1);
  await source.assertFresh(contribution, new AbortController().signal);
  source.release(contribution);
});

test("profile mismatch omits without losing original owner or promoting a new profile", async (t) => {
  const f = await fixture(t),
    source = f.source(),
    contribution = await source.prepare(
      f.request({
        policy: {
          documentKeys: [KEY],
          slotBytes: 16384,
          profiles: [{ id: "review", revision: "host-approved-revision" }],
        },
      }),
    );
  assert.deepEqual(contribution.omissions, [
    { documentKey: KEY, reason: "profile-not-selected" },
  ]);
  await source.assertFresh(contribution, new AbortController().signal);
  source.release(contribution);
  await assert.rejects(
    source.prepare(
      f.request({
        owner: {
          sessionId: f.session.id,
          runId: null,
          profile: { id: "review", revision: "host-approved-revision" },
        },
      }),
    ),
    errorCode("KNOWLEDGE_CONTEXT_STALE"),
  );
});

test("original capture identity, release, foreign source and both cancellation signals are enforced", async (t) => {
  const f = await fixture(t),
    source = f.source(),
    controller = new AbortController();
  const contribution = await source.prepare(
    f.request({ signal: controller.signal }),
  );
  await assert.rejects(
    source.assertFresh(
      structuredClone(contribution),
      new AbortController().signal,
    ),
    errorCode("KNOWLEDGE_CONTEXT_CAPTURE_INVALID"),
  );
  await assert.rejects(
    f.source().assertFresh(contribution, new AbortController().signal),
    errorCode("KNOWLEDGE_CONTEXT_CAPTURE_INVALID"),
  );
  const next = new AbortController();
  next.abort();
  await assert.rejects(
    source.assertFresh(contribution, next.signal),
    errorCode("KNOWLEDGE_CONTEXT_CANCELLED"),
  );
  controller.abort();
  await assert.rejects(
    source.assertFresh(contribution, new AbortController().signal),
    errorCode("KNOWLEDGE_CONTEXT_CANCELLED"),
  );
  source.release(contribution);
  assert.throws(
    () => source.release(contribution),
    errorCode("KNOWLEDGE_CONTEXT_CAPTURE_INVALID"),
  );
  await assert.rejects(
    source.prepare(f.request({ signal: next.signal })),
    errorCode("KNOWLEDGE_CONTEXT_CANCELLED"),
  );
});

test("request snapshot resists later host mutation and validates malformed executable input before ports", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const source = f.source({
    checkBinding(id) {
      reads++;
      return f.ports.checkBinding(id);
    },
  });
  const request = f.request(),
    policy = { documentKeys: [KEY], slotBytes: 16384 };
  const contribution = await source.prepare({ ...request, policy });
  policy.documentKeys[0] = "changed.memory";
  policy.slotBytes = 1;
  await source.assertFresh(contribution, new AbortController().signal);
  assert.equal(contribution.documents[0]!.documentKey, KEY);
  source.release(contribution);
  reads = 0;
  let executable = 0;
  const invalid = [
    Object.defineProperty({ ...request }, "policy", {
      enumerable: true,
      get() {
        executable++;
        return policy;
      },
    }),
    new Proxy(request, {
      get() {
        executable++;
        throw new Error("must not run");
      },
      ownKeys() {
        executable++;
        throw new Error("must not run");
      },
    }),
    { ...request, budget: { ...request.budget, maxContextBytes: -1 } },
    { ...request, owner: { ...request.owner, replay: true } },
    { ...request, unknown: true },
  ];
  for (const value of invalid)
    await assert.rejects(
      Reflect.apply(source.prepare, source, [value]),
      errorCode(),
    );
  const fakeSignal = Object.create(AbortSignal.prototype);
  Object.defineProperty(fakeSignal, "aborted", {
    get() {
      executable++;
      return false;
    },
  });
  await assert.rejects(
    source.prepare({ ...request, signal: fakeSignal }),
    errorCode("INVALID_KNOWLEDGE_CONTEXT"),
  );
  assert.equal(executable, 0);
  assert.equal(reads, 0);
});

test("native signal brand and descriptors reject before context preparation or freshness ports", async (t) => {
  const f = await fixture(t);
  let portCalls = 0,
    traps = 0;
  const counted = Object.fromEntries(
    Object.entries(f.ports).map(([key, operation]) => [
      key,
      (...args: unknown[]) => {
        portCalls++;
        return Reflect.apply(operation, undefined, args);
      },
    ]),
  ) as Ports;
  const source = f.source(counted),
    original = await source.prepare(
      f.request({
        signal: Object.assign(new AbortController().signal, {
          hostObservation: "safe data",
          [Symbol("hostObservation")]: "safe symbol data",
        }),
      }),
    );
  assert.equal(original.documents[0]!.documentKey, KEY);
  portCalls = 0;
  const accessor = (key: PropertyKey) => {
    const controller = new AbortController();
    if (key === "hostObservation" || typeof key === "symbol")
      controller.abort();
    return Object.defineProperty(controller.signal, key, {
      get() {
        traps++;
        throw Error("signal getter must not execute");
      },
    });
  };
  const override = (key: string) =>
    Object.defineProperty(new AbortController().signal, key, {
      value: () => {
        traps++;
        throw Error("signal override must not execute");
      },
    });
  const invalid = [
    ["own aborted accessor", accessor("aborted")],
    ["own reason accessor", accessor("reason")],
    ["own addEventListener", override("addEventListener")],
    ["own removeEventListener", override("removeEventListener")],
    ["other own accessor", accessor("hostObservation")],
    ["own symbol accessor", accessor(Symbol("hostObservation"))],
    ["prototype without native brand", Object.create(AbortSignal.prototype)],
  ] as const;
  for (const [label, signal] of invalid) {
    await t.test(`${label} / prepare`, async () => {
      await assert.rejects(
        source.prepare(f.request({ signal })),
        errorCode("INVALID_KNOWLEDGE_CONTEXT"),
      );
    });
    await t.test(`${label} / assertFresh`, async () => {
      await assert.rejects(
        source.assertFresh(original, signal),
        errorCode("INVALID_KNOWLEDGE_CONTEXT"),
      );
    });
  }
  assert.equal(traps, 0);
  assert.equal(portCalls, 0);
  assert.equal(f.calls(), 1);
  await assert.rejects(
    source.prepare(f.request({ signal: AbortSignal.abort() })),
    errorCode("KNOWLEDGE_CONTEXT_CANCELLED"),
  );
  await assert.rejects(
    source.assertFresh(original, AbortSignal.abort()),
    errorCode("KNOWLEDGE_CONTEXT_CANCELLED"),
  );
  assert.equal(portCalls, 0);
  await source.assertFresh(original, new AbortController().signal);
  source.release(original);
});

test("policy rejects sparse, duplicated, oversized or executable selection before evaluation", () => {
  let calls = 0;
  const invalid = [
    null,
    [],
    { documentKeys: [], slotBytes: 1 },
    { documentKeys: [KEY, KEY], slotBytes: 1 },
    { documentKeys: ["a", "b", "c", "d", "e"], slotBytes: 1 },
    { documentKeys: [KEY, , "b"], slotBytes: 1 },
    { documentKeys: [KEY], slotBytes: 16385 },
    { documentKeys: [KEY], slotBytes: 1, grant: true },
    Object.defineProperty({ slotBytes: 1 }, "documentKeys", {
      enumerable: true,
      get() {
        calls++;
        return [KEY];
      },
    }),
    new Proxy(
      {},
      {
        getPrototypeOf() {
          calls++;
          throw new Error("must not execute");
        },
        ownKeys() {
          calls++;
          throw new Error("must not execute");
        },
      },
    ),
  ];
  for (const value of invalid)
    assert.throws(() => knowledgeContextPolicy(value), errorCode());
  assert.equal(calls, 0);
  assert.ok(
    Object.isFrozen(
      knowledgeContextPolicy({ documentKeys: [KEY], slotBytes: 4096 })
        .documentKeys,
    ),
  );
});

test("a trusted source callback cannot return asynchronous or invalid observations", async (t) => {
  const f = await fixture(t);
  const source = f.source({
    assertSourcesCurrent: (() =>
      Promise.resolve()) as unknown as Ports["assertSourcesCurrent"],
  });
  await assert.rejects(
    source.prepare(f.request()),
    errorCode("KNOWLEDGE_CONTEXT_PORT_INVALID"),
  );
  const corrupt = f.source({
    getCandidate(id, candidateId) {
      return {
        ...f.ports.getCandidate(id, candidateId)!,
        body: "Reconstructed instead of actual native body.",
      };
    },
  });
  await assert.rejects(corrupt.prepare(f.request()), errorCode());
});

test("a detached or multiply entered transaction never grants an original contribution", async (t) => {
  const f = await fixture(t),
    db = new DatabaseSync(f.dbPath);
  t.after(() => db.close());
  const ports = { ...f.ports, getWorkspace: () => f.workspace };
  const detached = new KnowledgeContextSource(db, {
    ...ports,
    readTx: (operation) => operation(),
  });
  await assert.rejects(
    detached.prepare(f.request()),
    errorCode("KNOWLEDGE_CONTEXT_TRANSACTION_REQUIRED"),
  );
  const doubled = new KnowledgeContextSource(db, {
    ...ports,
    readTx: (operation) => {
      db.exec("BEGIN");
      try {
        operation();
        return operation();
      } finally {
        db.exec("ROLLBACK");
      }
    },
  });
  await assert.rejects(
    doubled.prepare(f.request()),
    errorCode("KNOWLEDGE_CONTEXT_TRANSACTION_REQUIRED"),
  );
});

test("metadata row cap rejects a real oversized candidate before invoking the legacy getter", async (t) => {
  const f = await fixture(t);
  let candidateReads = 0;
  const source = f.source({
    getCandidate(id, candidateId) {
      candidateReads++;
      return f.ports.getCandidate(id, candidateId);
    },
  });
  const original = f.mutate((db) =>
    String(
      db
        .prepare("SELECT data FROM knowledge_candidates WHERE id=?")
        .get(f.published.candidate.id)!.data,
    ),
  );
  f.mutate((db) => {
    db.exec("PRAGMA ignore_check_constraints=ON");
    db.prepare("UPDATE knowledge_candidates SET data=? WHERE id=?").run(
      " ".repeat(65537),
      f.published.candidate.id,
    );
  });
  try {
    await assert.rejects(
      source.prepare(f.request()),
      errorCode("KNOWLEDGE_CONTEXT_PORT_INVALID"),
    );
    assert.equal(candidateReads, 0);
  } finally {
    f.mutate((db) =>
      db
        .prepare("UPDATE knowledge_candidates SET data=? WHERE id=?")
        .run(original, f.published.candidate.id),
    );
  }
});

test("bounded trust head JSON pointer must match actual SQL index before any legacy trust revision read", async (t) => {
  const f = await fixture(t);
  let trustReads = 0;
  const source = f.source({
    getTrust(id) {
      trustReads++;
      return f.ports.getTrust(id);
    },
  });
  const original = f.mutate((db) =>
    String(
      db
        .prepare("SELECT data FROM workspace_trust_heads WHERE workspace_id=?")
        .get(f.workspace.id)!.data,
    ),
  );
  const tampered = {
    ...JSON.parse(original),
    revisionId: "un-preflighted-revision",
  };
  f.mutate((db) =>
    db
      .prepare("UPDATE workspace_trust_heads SET data=? WHERE workspace_id=?")
      .run(JSON.stringify(tampered), f.workspace.id),
  );
  try {
    await assert.rejects(
      source.prepare(f.request()),
      errorCode("KNOWLEDGE_CONTEXT_EVIDENCE_INVALID"),
    );
    assert.equal(trustReads, 0);
  } finally {
    f.mutate((db) =>
      db
        .prepare("UPDATE workspace_trust_heads SET data=? WHERE workspace_id=?")
        .run(original, f.workspace.id),
    );
  }
});

test("null workspace is rejected with a typed error before any trusted source port runs", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const source = f.source({
    checkBinding(id) {
      reads++;
      return f.ports.checkBinding(id);
    },
    assertOwnerCurrent(id, owner) {
      reads++;
      return f.ports.assertOwnerCurrent(id, owner);
    },
  });
  await assert.rejects(
    Reflect.apply(source.prepare, source, [
      { ...f.request(), workspace: null },
    ]),
    errorCode("INVALID_KNOWLEDGE_CONTEXT"),
  );
  assert.equal(reads, 0);
  assert.equal(f.calls(), 1);
});

test("malformed bounded native trust-head JSON fails with a typed error before legacy trust reads", async (t) => {
  const f = await fixture(t);
  let trustReads = 0;
  const source = f.source({
    getTrust(id) {
      trustReads++;
      return f.ports.getTrust(id);
    },
  });
  const original = f.mutate((db) =>
    String(
      db
        .prepare("SELECT data FROM workspace_trust_heads WHERE workspace_id=?")
        .get(f.workspace.id)!.data,
    ),
  );
  f.mutate((db) =>
    db
      .prepare("UPDATE workspace_trust_heads SET data=? WHERE workspace_id=?")
      .run("{", f.workspace.id),
  );
  try {
    await assert.rejects(
      source.prepare(f.request()),
      errorCode("KNOWLEDGE_CONTEXT_EVIDENCE_INVALID"),
    );
    assert.equal(trustReads, 0);
    assert.equal(f.calls(), 1);
  } finally {
    f.mutate((db) =>
      db
        .prepare("UPDATE workspace_trust_heads SET data=? WHERE workspace_id=?")
        .run(original, f.workspace.id),
    );
  }
});

test("capture cap bounds cached plus replacement headroom and release permits a new capture", async (t) => {
  const f = await fixture(t),
    source = f.source();
  const request = f.request({
    policy: { documentKeys: ["missing.memory"], slotBytes: 16 },
  });
  const captures = [];
  for (let i = 0; i < KNOWLEDGE_CONTEXT_LIMITS.handles; i++)
    captures.push(await source.prepare(request));
  await assert.rejects(
    source.prepare(request),
    errorCode("KNOWLEDGE_CONTEXT_LIMIT"),
  );
  source.release(captures.pop()!);
  const replacement = await source.prepare(request);
  for (const capture of captures) source.release(capture);
  source.release(replacement);
});
