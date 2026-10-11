import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EngineError, type Workspace } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import { ScriptedProvider } from "../provider/scripted.js";
import { SqliteStore } from "../storage/index.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import {
  assertPhysicalKnowledgeRoot,
  assertWorkspaceTrustSourcesCurrent,
  captureWorkspaceTrustSources,
} from "../workspace/trust.js";
import type { KnowledgeImportDocumentProof } from "./import-document-proof.js";
import {
  KnowledgeImportRecoveryService,
  type KnowledgeImportRecoveryServicePorts,
  type WorkspaceKnowledgeImportRecoveryPreview,
} from "./import-recovery-service.js";
import type { KnowledgeHostBinding } from "./types.js";
import { immutableKnowledgeJson, knowledgeHash } from "./validation.js";

const KEY = "service.imported.memory";
const BODY = 'Actual native producer knowledge 한글😀 "quoted".\n';
const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Native positive evidence is produced, published, exported and imported through actual Engine/SQLite/FS APIs. */
async function fixture(t: TestContext) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-import-service-")),
    ),
    root = join(base, "workspace");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  writeFileSync(
    join(root, "AGENTS.md"),
    "Operator-reviewed physical instructions.\n",
  );
  writeFileSync(join(root, "source.ts"), "export const exactSource = 7;\n");
  const provider = new ScriptedProvider(
    [],
    [
      {
        events: [
          { type: "text.delta", delta: BODY },
          { type: "usage", inputTokens: 0, outputTokens: 3 },
          { type: "finish", reason: "stop" },
        ],
      },
    ],
  );
  const original = createEngine({
    dbPath: join(base, "original.sqlite"),
    artifactDir: join(base, "original-artifacts"),
    tools: [],
    providers: [provider],
    knowledgeGeneration: true,
    knowledgePublication: true,
    defaults: { providerId: provider.id, modelId: "actual-service-fixture" },
  });
  t.after(async () => {
    await original.close();
  });
  const reply = await original.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type: "workspace.open",
    payload: { path: root },
  });
  assert.equal(reply.ok, true);
  const workspace = reply.result as unknown as Workspace;
  const trust = await original.setWorkspaceTrust({
    workspaceId: workspace.id,
    requestId: "original-trust",
    expectedRevision: 0,
    decision: "allow",
    preview: original.previewWorkspaceTrust(workspace.id, ["AGENTS.md"]),
  });
  const source = original.captureWorkspaceKnowledgeSources(workspace.id, [
    { kind: "file", path: "source.ts" },
  ]);
  const request = original.previewWorkspaceKnowledgeGeneration({
    providerId: provider.id,
    modelId: "actual-service-fixture",
    projection: source,
  });
  const plan = await original.prepareWorkspaceKnowledgeGeneration({
    workspaceId: workspace.id,
    requestId: "original-plan",
    expectedTrustRevision: trust.revision,
    projection: source,
    target: original.captureWorkspaceKnowledgeDocumentTarget(workspace.id, KEY),
    providerId: provider.id,
    modelId: "actual-service-fixture",
    requestSha256: request.requestSha256,
    requestBytes: request.requestBytes,
    maxOutputBytes: 2048,
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });
  const generated = await original.generateWorkspaceKnowledge({
    workspaceId: workspace.id,
    planId: plan.id,
    requestId: "original-generation",
    projection: source,
  });
  assert.equal(generated.generation.state, "completed");
  assert.ok(generated.candidate);
  const published = await original.publishWorkspaceKnowledge({
    workspaceId: workspace.id,
    requestId: "original-publication",
    approved: true,
    preview: original.previewWorkspaceKnowledgePublication({
      workspaceId: workspace.id,
      candidateId: generated.candidate.id,
    }),
  });
  assert.equal(published.document.body, BODY);
  original.releaseWorkspaceKnowledgeSources(source);
  await original.close();
  const archive = await exportEngineArchive({
    dbPath: join(base, "original.sqlite"),
    artifactDir: join(base, "original-artifacts"),
    destination: join(base, "archive"),
  });
  const imported = await importEngineArchive({
    directory: archive.directory,
    destination: join(base, "clone"),
  });
  const store = new SqliteStore(imported.dbPath);
  const services = new Set<KnowledgeImportRecoveryService>();
  t.after(async () => {
    for (const service of services) await service.close();
    await store.closeAsync();
  });
  const identity = (path: string) => {
    const stat = lstatSync(path, { bigint: true });
    return {
      path: realpathSync(path),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
    };
  };
  const actualStorage = {
    database: identity(imported.dbPath),
    artifacts: identity(imported.artifactDir),
  };
  const binding = (): KnowledgeHostBinding => {
    if (
      knowledgeHash({
        database: identity(imported.dbPath),
        artifacts: identity(imported.artifactDir),
      }) !== knowledgeHash(actualStorage)
    )
      throw new EngineError(
        "KNOWLEDGE_BINDING_MISMATCH",
        "Actual storage owner changed",
      );
    const stat = lstatSync(root, { bigint: true }),
      bound = {
        workspaceId: workspace.id,
        root,
        rootDevice: stat.dev.toString(),
        rootInode: stat.ino.toString(),
        storageBindingSha256: knowledgeHash(actualStorage),
      };
    assertPhysicalKnowledgeRoot(bound);
    return bound;
  };
  const host = store.createKnowledgeHostAdapter({ checkHostBinding: binding });
  const knowledge = store.createKnowledgeStorage({
    checkHostBinding: binding,
    assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent,
    assertSourcesCurrent: (bound, manifest) =>
      host.assertSourcesCurrent(bound, manifest),
    assertTargetCurrent: (bound, target) =>
      host.assertTargetCurrent(bound, target),
  });
  const state = {
    now: Date.now(),
    leases: 0,
    sourceReads: 0,
    beforeLease: undefined as (() => Promise<void> | void) | undefined,
    beforeCommit: undefined as (() => void) | undefined,
    afterCommit: undefined as (() => void) | undefined,
    sourceHook: undefined as (() => void) | undefined,
    proofHook: undefined as
      | ((
          proof: KnowledgeImportDocumentProof | undefined,
        ) => KnowledgeImportDocumentProof | undefined)
      | undefined,
  };
  let service!: KnowledgeImportRecoveryService;
  const native = store.createKnowledgeImportRecoveryStorage({
    checkBinding: binding,
    assertCommitCurrent: (preview) => {
      state.beforeCommit?.();
      service.assertCommitCurrent(preview);
    },
    now: () => state.now,
  });
  const ports: KnowledgeImportRecoveryServicePorts = {
    native: {
      getFrontier: native.getFrontier.bind(native),
      getActivation: native.getActivation.bind(native),
      findRequest: native.findRequest.bind(native),
      preview: native.preview.bind(native),
      release: native.release.bind(native),
      commit: (preview, input) => {
        const result = native.commit(preview, input);
        state.afterCommit?.();
        return result;
      },
    },
    readTx: (operation) => store.readExecutionObservationEvidence(operation),
    checkBinding: binding,
    readActivationProof: (ws, key) => {
      const proof = store.readKnowledgeImportDocumentProof(ws, key);
      return state.proofHook ? state.proofHook(proof) : proof;
    },
    assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent,
    assertSourcesCurrent: (bound, manifest) => {
      state.sourceReads++;
      state.sourceHook?.();
      host.assertSourcesCurrent(bound, manifest);
    },
    assertNoExecutionUncertainty: (ws) => {
      assert.equal(ws, workspace.id);
      if (store.hasUncertainSummaries(ws) || store.hasUncertainExecution(ws))
        throw new EngineError(
          "CLEANUP_PENDING",
          "Actual native independent producer remains uncertain",
        );
    },
    withWorkspaceLease: async (ws, operation) => {
      assert.equal(ws, workspace.id);
      state.leases++;
      await state.beforeLease?.();
      return operation(new AbortController().signal);
    },
    now: () => state.now,
  };
  service = new KnowledgeImportRecoveryService(ports);
  services.add(service);
  const readDb = new DatabaseSync(imported.dbPath, { readOnly: true });
  t.after(() => readDb.close());
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const rows = () =>
    [
      "knowledge_import_recovery_decisions",
      "knowledge_import_document_activations",
      "knowledge_import_document_activation_heads",
    ].map(
      (table) =>
        readDb.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count,
    );
  const historicalRows = () =>
    [
      "knowledge_generations",
      "knowledge_generation_attempts",
      "knowledge_candidates",
      "knowledge_publications",
      "workspace_document_revisions",
      "workspace_document_heads",
    ].map((table) =>
      readDb.prepare(`SELECT id,data FROM ${table} ORDER BY id`).all(),
    );
  const retrust = (decision: "allow" | "deny" = "allow") =>
    knowledge.setTrust({
      workspaceId: workspace.id,
      requestId: randomUUID(),
      expectedRevision: knowledge.getTrust(workspace.id)!.revision,
      decision,
      binding: binding(),
      sources:
        decision === "allow"
          ? captureWorkspaceTrustSources(binding(), ["AGENTS.md"])
          : [],
      expiresAt: null,
    });
  const recover = async () => {
    await service.acknowledge(
      approved(service.previewAcknowledgment({ workspaceId: workspace.id })),
    );
    return service.resume(
      approved(service.previewResume({ workspaceId: workspace.id })),
    );
  };
  return {
    root,
    workspace,
    imported,
    store,
    provider,
    state,
    service,
    native,
    ports,
    services,
    binding,
    knowledge,
    host,
    rows,
    historicalRows,
    retrust,
    recover,
    preview: () =>
      service.previewActivation({
        workspaceId: workspace.id,
        documentKey: KEY,
      }),
  };
}
function approved(
  preview: WorkspaceKnowledgeImportRecoveryPreview,
  requestId: string = randomUUID(),
) {
  return {
    workspaceId: preview.workspaceId,
    requestId,
    approved: true as const,
    preview,
  };
}

test("explicit native resume preserves original history and activates only an exact freshly trusted document; original duplicate skips freshness and lease", async (t) => {
  const f = await fixture(t),
    historical = f.historicalRows();
  await f.recover();
  assert.deepEqual(f.rows(), [2, 0, 0]);
  assert.throws(f.preview, (error) => error instanceof EngineError);
  const trust = f.retrust(),
    preview = f.preview();
  assert.equal(preview.document!.body, BODY);
  assert.equal(preview.pins.documentProof!.currentTrustId, trust.id);
  assert.ok(Object.isFrozen(preview));
  assert.ok(Object.isFrozen(preview.pins));
  assert.ok(Object.isFrozen(preview.pins.documentProof));
  const input = approved(preview),
    result = await f.service.activate(input);
  assert.equal(result.duplicate, false);
  assert.equal(result.activation!.state, "active");
  assert.equal(result.activation!.proof.currentTrustSha256, trust.sha256);
  assert.notDeepEqual(
    result.activation!.binding,
    result.activation!.proof.originalBinding,
  );
  assert.deepEqual(f.rows(), [3, 1, 1]);
  assert.deepEqual(f.historicalRows(), historical);
  writeFileSync(
    join(f.root, "source.ts"),
    "export const changedAfterActivation = 8;\n",
  );
  f.retrust("deny");
  f.state.now += 120000;
  const leases = f.state.leases,
    sourceReads = f.state.sourceReads,
    duplicate = await f.service.activate(input);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.decision, result.decision);
  assert.deepEqual(duplicate.activation, result.activation);
  assert.equal(f.state.leases, leases);
  assert.equal(f.state.sourceReads, sourceReads);
  assert.deepEqual(f.rows(), [3, 1, 1]);
  await assert.rejects(
    f.service.activate(approved(preview)),
    code("KNOWLEDGE_IMPORT_PREVIEW_USED"),
  );
  assert.equal(f.provider.generationCallCount, 1);
  assert.equal(f.provider.callCount, 0);
});

test("copied, foreign, released, mismatched and hostile input/signal capabilities invoke zero traps and no SQL decision", async (t) => {
  const f = await fixture(t),
    preview = f.service.previewAcknowledgment({ workspaceId: f.workspace.id });
  const foreign = new KnowledgeImportRecoveryService(f.ports);
  f.services.add(foreign);
  let traps = 0;
  const proxy = new Proxy(preview, {
    get() {
      traps++;
      throw new Error("trap");
    },
    getOwnPropertyDescriptor() {
      traps++;
      throw new Error("trap");
    },
  });
  const accessor = Object.defineProperty({ ...approved(preview) }, "approved", {
    enumerable: true,
    get() {
      traps++;
      return true;
    },
  });
  const badReason = Object.defineProperty({}, "text", {
    enumerable: true,
    get() {
      traps++;
      return "reason";
    },
  });
  const signal = new AbortController().signal;
  Object.defineProperty(signal, "aborted", {
    get() {
      traps++;
      return false;
    },
  });
  const symbolSignal = new AbortController().signal;
  Object.defineProperty(symbolSignal, Symbol("untrusted"), {
    get() {
      traps++;
      return false;
    },
  });
  const hostileReason = new AbortController();
  hostileReason.abort(
    new Proxy(
      {},
      {
        getPrototypeOf() {
          traps++;
          throw new Error("Abort reason proxy");
        },
        get() {
          traps++;
          throw new Error("Abort reason proxy");
        },
      },
    ),
  );
  await assert.rejects(
    f.service.acknowledge({
      ...approved(preview),
      signal: hostileReason.signal,
    }),
    code("KNOWLEDGE_IMPORT_CANCELLED"),
  );
  await assert.rejects(
    f.service.acknowledge({
      ...approved(preview),
      signal: Object.create(AbortSignal.prototype) as AbortSignal,
    }),
    code("INVALID_KNOWLEDGE_IMPORT_RECOVERY"),
  );
  for (const value of [
    approved({ ...preview }),
    { ...approved(preview), preview: proxy },
    accessor,
    { ...approved(preview), reason: badReason },
    { ...approved(preview), approved: false },
    { ...approved(preview), signal },
    { ...approved(preview), signal: symbolSignal },
    { ...approved(preview), reason: "x".repeat(1025) },
    { ...approved(preview), reason: "unsafe\ncontrol" },
  ])
    await assert.rejects(
      f.service.acknowledge(
        value as Parameters<KnowledgeImportRecoveryService["acknowledge"]>[0],
      ),
      (error) => error instanceof EngineError,
    );
  await assert.rejects(
    foreign.acknowledge(approved(preview)),
    code("KNOWLEDGE_IMPORT_PREVIEW_INVALID"),
  );
  await assert.rejects(
    f.service.resume(approved(preview)),
    code("KNOWLEDGE_IMPORT_PREVIEW_INVALID"),
  );
  f.service.releasePreview(preview);
  await assert.rejects(
    f.service.acknowledge(approved(preview)),
    code("KNOWLEDGE_IMPORT_PREVIEW_INVALID"),
  );
  assert.equal(traps, 0);
  assert.equal(f.state.leases, 0);
  assert.deepEqual(f.rows(), [0, 0, 0]);
});

test("mutable approval input is detached before the pending original lease and cannot replace request, operation or reason", async (t) => {
  const f = await fixture(t),
    wait = gate();
  f.state.beforeLease = () => wait.promise;
  const input = {
    ...approved(
      f.service.previewAcknowledgment({ workspaceId: f.workspace.id }),
      "original-request",
    ),
    reason: "Original explicit host acknowledgment",
  };
  const pending = f.service.acknowledge(input);
  input.requestId = "changed-request";
  input.workspaceId = "foreign-workspace";
  input.reason = "Changed reason";
  wait.resolve();
  const result = await pending;
  assert.equal(result.decision.requestId, "original-request");
  assert.equal(result.decision.workspaceId, f.workspace.id);
  assert.equal(result.decision.reason, "Original explicit host acknowledgment");
  assert.deepEqual(f.rows(), [1, 0, 0]);
});

test("actual source, trust, storage binding and original expiry changes during the pending lease have zero activation effects", async (t) => {
  for (const change of ["source", "trust", "storage", "expiry"] as const) {
    const f = await fixture(t);
    await f.recover();
    f.retrust();
    const preview = f.preview(),
      wait = gate();
    f.state.beforeLease = () => wait.promise;
    const pending = f.service.activate(approved(preview));
    void pending.catch(() => {});
    if (change === "source")
      writeFileSync(
        join(f.root, "source.ts"),
        "export const externallyEdited = 8;\n",
      );
    if (change === "trust") f.retrust("deny");
    if (change === "storage") {
      renameSync(f.imported.artifactDir, f.imported.artifactDir + "-old");
      mkdirSync(f.imported.artifactDir);
    }
    if (change === "expiry") f.state.now = Date.parse(preview.expiresAt);
    wait.resolve();
    await assert.rejects(pending, (error) => error instanceof EngineError);
    assert.deepEqual(f.rows(), [2, 0, 0]);
    assert.equal(f.native.getActivation(f.workspace.id, KEY), undefined);
    assert.equal(f.provider.generationCallCount, 1);
  }
});

test("the actual native transaction revalidates after its callback changes physical source; no activation row or head commits", async (t) => {
  const f = await fixture(t);
  await f.recover();
  f.retrust();
  const preview = f.preview();
  f.state.beforeCommit = () => unlinkSync(join(f.root, "source.ts"));
  await assert.rejects(
    f.service.activate(approved(preview)),
    (error) => error instanceof EngineError,
  );
  assert.deepEqual(f.rows(), [2, 0, 0]);
  assert.equal(f.native.getActivation(f.workspace.id, KEY), undefined);
});

test("activation expires during actual physical source checking rather than using the earlier sampled clock", async (t) => {
  const f = await fixture(t);
  await f.recover();
  f.retrust();
  const raw = f.store.readKnowledgeImportDocumentProof(f.workspace.id, KEY)!;
  f.state.sourceHook = () => {
    f.state.now = Date.parse(raw.history.plan.expiresAt);
  };
  assert.throws(f.preview, code("KNOWLEDGE_IMPORT_EXPIRED"));
  assert.deepEqual(f.rows(), [2, 0, 0]);
});

test("nested native proof accessors and proxies are rejected without traps, source reads or activation effects", async (t) => {
  const f = await fixture(t);
  await f.recover();
  f.retrust();
  const raw = f.store.readKnowledgeImportDocumentProof(f.workspace.id, KEY)!;
  let traps = 0;
  const before = f.state.sourceReads;
  const getter = (value: object, key: string) =>
    Object.defineProperty({ ...value }, key, {
      enumerable: true,
      get() {
        traps++;
        throw new Error("Native protocol getter");
      },
    });
  for (const key of ["head", "document", "publication", "receipt"] as const) {
    f.state.proofHook = () => ({ ...raw, [key]: getter(raw[key], "id") });
    assert.throws(f.preview, (error) => error instanceof EngineError);
  }
  f.state.proofHook = () => ({
    ...raw,
    history: {
      ...raw.history,
      candidate: getter(
        raw.history.candidate,
        "id",
      ) as typeof raw.history.candidate,
    },
  });
  assert.throws(f.preview, (error) => error instanceof EngineError);
  f.state.proofHook = () => ({
    ...raw,
    history: {
      ...raw.history,
      candidate: new Proxy(raw.history.candidate, {
        get() {
          traps++;
          throw new Error("Native proxy");
        },
        getOwnPropertyDescriptor() {
          traps++;
          throw new Error("Native proxy");
        },
      }),
    },
  });
  assert.throws(f.preview, (error) => error instanceof EngineError);
  f.state.proofHook = () => ({
    ...raw,
    currentTrust: getter(raw.currentTrust!, "id") as typeof raw.currentTrust,
  });
  assert.throws(f.preview, (error) => error instanceof EngineError);
  assert.equal(traps, 0);
  assert.equal(f.state.sourceReads, before);
  assert.deepEqual(f.rows(), [2, 0, 0]);
});

test("correlated historical graph disagreement and physical root relocation cannot create a recovery proof", async (t) => {
  const f = await fixture(t);
  await f.recover();
  f.retrust();
  const raw = f.store.readKnowledgeImportDocumentProof(f.workspace.id, KEY)!;
  const { sha256: _old, ...receiptBody } = raw.receipt;
  const changedBody = { ...receiptBody, publicationId: randomUUID() };
  f.state.proofHook = () => ({
    ...raw,
    receipt: immutableKnowledgeJson({
      ...changedBody,
      sha256: knowledgeHash(changedBody),
    }),
  });
  assert.throws(f.preview, code("KNOWLEDGE_IMPORT_EVIDENCE_INVALID"));
  assert.deepEqual(f.rows(), [2, 0, 0]);
  f.state.proofHook = undefined;
  renameSync(f.root, f.root + "-original");
  mkdirSync(f.root);
  writeFileSync(
    join(f.root, "AGENTS.md"),
    "Operator-reviewed physical instructions.\n",
  );
  writeFileSync(join(f.root, "source.ts"), "export const exactSource = 7;\n");
  assert.throws(f.preview, code("KNOWLEDGE_IMPORT_RELOCATION_UNSUPPORTED"));
  assert.deepEqual(f.rows(), [2, 0, 0]);
});

test("deactivation reduces authority after current trust denial and selected-source deletion while preserving original history", async (t) => {
  const f = await fixture(t);
  await f.recover();
  f.retrust();
  const original = f.historicalRows();
  const activated = await f.service.activate(approved(f.preview()));
  unlinkSync(join(f.root, "source.ts"));
  f.retrust("deny");
  f.state.now = Date.parse(activated.activation!.proof.expiresAt!) + 1;
  const reads = f.state.sourceReads,
    preview = f.service.previewDeactivation({
      workspaceId: f.workspace.id,
      documentKey: KEY,
    });
  assert.equal(preview.document, null);
  assert.equal(
    preview.pins.documentProof!.currentTrustId,
    activated.activation!.proof.currentTrustId,
  );
  const input = approved(preview),
    result = await f.service.deactivate(input);
  assert.equal(result.activation!.state, "inactive");
  assert.equal(result.activation!.revision, activated.activation!.revision + 1);
  assert.equal(result.activation!.previousId, activated.activation!.id);
  assert.equal(f.state.sourceReads, reads);
  assert.deepEqual(f.historicalRows(), original);
  const duplicate = await f.service.deactivate(input);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.activation, result.activation);
  assert.deepEqual(f.rows(), [4, 2, 1]);
});

test("pre-abort and original queued-operation cancellation reject before commit, while close joins the late original lease callback", async (t) => {
  const f = await fixture(t),
    preview = f.service.previewAcknowledgment({ workspaceId: f.workspace.id });
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(
    f.service.acknowledge({ ...approved(preview), signal: pre.signal }),
    code("KNOWLEDGE_IMPORT_CANCELLED"),
  );
  assert.equal(f.state.leases, 0);
  assert.deepEqual(f.rows(), [0, 0, 0]);
  const wait = gate(),
    abort = new AbortController();
  f.state.beforeLease = () => wait.promise;
  const pending = f.service.acknowledge({
    ...approved(preview),
    signal: abort.signal,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  await assert.rejects(pending, code("KNOWLEDGE_IMPORT_CANCELLED"));
  assert.deepEqual(f.rows(), [0, 0, 0]);
  let settled = false;
  const closing = f.service.close().then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  wait.resolve();
  await closing;
  assert.deepEqual(f.rows(), [0, 0, 0]);
  await assert.rejects(
    f.service.acknowledge(approved(preview)),
    code("KNOWLEDGE_IMPORT_PREVIEW_INVALID"),
  );
});

test("abort observed after actual native COMMIT preserves the original decision, and callback-free forged native pins have no authority", async (t) => {
  const f = await fixture(t),
    preview = f.service.previewAcknowledgment({ workspaceId: f.workspace.id }),
    abort = new AbortController();
  assert.throws(
    () => f.service.assertCommitCurrent(preview.pins),
    code("KNOWLEDGE_IMPORT_PREVIEW_INVALID"),
  );
  assert.throws(
    () => f.service.assertCommitCurrent({ ...preview.pins }),
    code("KNOWLEDGE_IMPORT_PREVIEW_INVALID"),
  );
  f.state.afterCommit = () => abort.abort();
  const result = await f.service.acknowledge({
    ...approved(preview),
    signal: abort.signal,
  });
  assert.equal(result.decision.operation, "acknowledge");
  assert.equal(result.frontier.head.state, "acknowledged");
  assert.deepEqual(f.rows(), [1, 0, 0]);
});

test("the original operation clock and timer reject before SQL commit without extending preview or reusing a late lease", async (t) => {
  const f = await fixture(t),
    first = f.service.previewAcknowledgment({ workspaceId: f.workspace.id });
  f.state.beforeCommit = () => {
    f.state.now += 5000;
  };
  await assert.rejects(
    f.service.acknowledge(approved(first)),
    code("KNOWLEDGE_IMPORT_DEADLINE"),
  );
  assert.deepEqual(f.rows(), [0, 0, 0]);
  f.state.beforeCommit = undefined;
  const preview = f.service.previewAcknowledgment({
      workspaceId: f.workspace.id,
      expiresAt: new Date(f.state.now + 30).toISOString(),
    }),
    wait = gate();
  f.state.beforeLease = () => wait.promise;
  await assert.rejects(
    f.service.acknowledge(approved(preview)),
    code("KNOWLEDGE_IMPORT_DEADLINE"),
  );
  assert.deepEqual(f.rows(), [0, 0, 0]);
  wait.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.rows(), [0, 0, 0]);
  await assert.rejects(
    f.service.acknowledge(approved(preview)),
    code("KNOWLEDGE_IMPORT_PREVIEW_USED"),
  );
});

test("original preview and pending operation capacities are bounded without evicting existing approval owners", async (t) => {
  const f = await fixture(t),
    originals = Array.from({ length: 128 }, () =>
      f.service.previewAcknowledgment({ workspaceId: f.workspace.id }),
    );
  assert.throws(
    () => f.service.previewAcknowledgment({ workspaceId: f.workspace.id }),
    code("KNOWLEDGE_IMPORT_LIMIT"),
  );
  f.service.releasePreview(originals.pop()!);
  const replacement = f.service.previewAcknowledgment({
    workspaceId: f.workspace.id,
  });
  const wait = gate();
  f.state.beforeLease = () => wait.promise;
  const abort = new AbortController();
  const pending = originals
    .slice(0, 16)
    .map((preview) =>
      f.service.acknowledge({ ...approved(preview), signal: abort.signal }),
    );
  for (const task of pending) void task.catch(() => {});
  await assert.rejects(
    f.service.acknowledge(approved(replacement)),
    code("KNOWLEDGE_IMPORT_LIMIT"),
  );
  abort.abort();
  for (const task of pending)
    await assert.rejects(task, code("KNOWLEDGE_IMPORT_CANCELLED"));
  wait.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.rows(), [0, 0, 0]);
  for (const preview of originals) f.service.releasePreview(preview);
  f.service.releasePreview(replacement);
});
