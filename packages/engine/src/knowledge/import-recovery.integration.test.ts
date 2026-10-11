import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
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
import { setTimeout as pause } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import {
  EngineError,
  type JsonObject,
  type RunReceipt,
  type Session,
  type Workspace,
} from "@moodcode/contracts";
import { createEngine, type EngineOptions } from "../engine.js";
import type { ProviderAdapter, ProviderEvent, TurnRequest } from "../ports.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import {
  acquireExecutionLock,
  inspectExecutionLock,
} from "../tools/command/execution-lock.js";
import type { PreparedKnowledgeContribution } from "./context-types.js";
import type { KnowledgeImportRecoveryCommitResult } from "./import-recovery-types.js";
import type { WorkspaceKnowledgeImportRecoveryPreview } from "./import-recovery-service.js";
import { knowledgeHash, sha256 } from "./validation.js";

type Engine = ReturnType<typeof createEngine>;
const KEY = "imported.project.memory";
const BODY =
  'import_recovery_actual_approved_knowledge: preserve "quotes", 한글😀 and exact native publication.\n';
const SOURCE = "export const selectedImportSource = 7;\n";
async function command<T>(
  engine: Engine,
  type: string,
  payload: JsonObject,
): Promise<T> {
  const reply = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type,
    payload,
  });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.result as unknown as T;
}
function rows(dbPath: string, tables: readonly string[]) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(
      tables.map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}
function importRows(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'knowledge_import_*' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    for (const table of tables) assert.match(table, /^[a-z_]+$/);
    return Object.fromEntries(
      tables.map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}
function api<T = unknown>(
  engine: Engine,
  method: string,
  ...args: unknown[]
): T {
  const actual = Reflect.get(engine, method);
  assert.equal(
    typeof actual,
    "function",
    `Actual Engine API ${method} must be integrated before this consumer can pass`,
  );
  return Reflect.apply(actual, engine, args) as T;
}
type ImportOperation =
  "Acknowledgment" | "Recovery" | "Activation" | "Deactivation";
function preview(
  engine: Engine,
  workspaceId: string,
  operation: ImportOperation,
  expiresAt?: string,
) {
  const value = api<WorkspaceKnowledgeImportRecoveryPreview>(
    engine,
    `previewWorkspaceKnowledgeImport${operation}`,
    {
      workspaceId,
      ...(operation === "Activation" || operation === "Deactivation"
        ? { documentKey: KEY }
        : {}),
      ...(expiresAt ? { expiresAt } : {}),
    },
  );
  assert.ok(value && typeof value === "object");
  assert.equal(Object.isFrozen(value), true);
  return value;
}
function decide(
  engine: Engine,
  workspaceId: string,
  operation: ImportOperation,
  captured: object,
  requestId: string = randomUUID(),
  signal?: AbortSignal,
) {
  const names = {
    Acknowledgment: "acknowledgeWorkspaceKnowledgeImport",
    Recovery: "resumeWorkspaceKnowledgeImport",
    Activation: "activateWorkspaceKnowledgeImport",
    Deactivation: "deactivateWorkspaceKnowledgeImport",
  } as const;
  return api<Promise<KnowledgeImportRecoveryCommitResult>>(
    engine,
    names[operation],
    {
      workspaceId,
      requestId,
      approved: true,
      preview: captured,
      ...(signal ? { signal } : {}),
    },
  );
}
const HISTORICAL_TABLES = [
  "knowledge_generation_plans",
  "knowledge_generations",
  "knowledge_generation_attempts",
  "knowledge_candidates",
  "knowledge_publications",
  "workspace_document_revisions",
  "workspace_document_heads",
  "knowledge_publication_receipts",
] as const;
const PRODUCTION_TABLES = ["tools", "approvals", "checkpoints"] as const;
function knowledge(
  engine: Engine,
  sessionId: string,
): Omit<PreparedKnowledgeContribution, "messages"> {
  const value = engine.context.diagnostics(sessionId)?.knowledgeContext;
  assert.ok(
    value,
    "Actual ContextService must expose its original knowledge capture",
  );
  return value;
}
async function fixture(
  t: TestContext,
  input: {
    uncertain?: boolean;
    contextBytes?: number;
    slotBytes?: number;
  } = {},
) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-knowledge-import-recovery-")),
    ),
    root = join(base, "workspace");
  const dbPath = join(base, "original.sqlite"),
    artifactDir = join(base, "original-artifacts");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  writeFileSync(
    join(root, "AGENTS.md"),
    "Fresh operator-selected instruction authority for this physical workspace.\n",
  );
  writeFileSync(join(root, "source.ts"), SOURCE);
  let seed = true,
    generationCalls = 0,
    seedCalls = 0,
    failedReturns = 0,
    uncertainNext = false;
  const requests: TurnRequest[] = [];
  const provider: ProviderAdapter = {
    id: "actual-import-recovery",
    streamTurn(request) {
      if (seed)
        return (async function* (): AsyncGenerator<ProviderEvent> {
          seedCalls++;
          yield {
            type: "text.delta",
            delta:
              "Actual completed source transcript owned by the original coding Run.",
          };
          yield { type: "finish", reason: "stop" };
        })();
      requests.push(structuredClone(request));
      return (async function* (): AsyncGenerator<ProviderEvent> {
        yield {
          type: "text.delta",
          delta: "Actual imported knowledge coding consumer completed.",
        };
        yield { type: "finish", reason: "stop" };
      })();
    },
    streamGeneration(request) {
      generationCalls++;
      assert.equal(request.owner.kind, "host-generation");
      assert.deepEqual(request.tools, []);
      if (!uncertainNext)
        return (async function* (): AsyncGenerator<ProviderEvent> {
          yield { type: "usage", inputTokens: 5, outputTokens: 3 };
          yield { type: "text.delta", delta: BODY };
          yield { type: "finish", reason: "stop" };
        })();
      let index = 0;
      const iterator: AsyncIterableIterator<ProviderEvent> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (index++ === 0)
            return {
              done: false,
              value: {
                type: "text.delta",
                delta: "Actual historical uncertain partial generation.",
              },
            };
          if (index === 2)
            return {
              done: false,
              value: { type: "usage", inputTokens: 0, outputTokens: 2 },
            };
          throw new EngineError(
            "IMPORT_GENERATION_FAILED",
            "Actual producer failed after output and cannot confirm iterator termination",
          );
        },
        async return() {
          failedReturns++;
          return {
            done: false,
            value: {
              type: "text.delta",
              delta: "Actual iterator still does not confirm termination.",
            },
          };
        },
      };
      return iterator;
    },
  };
  const options: EngineOptions = {
    dbPath,
    artifactDir,
    providers: [provider],
    tools: [],
    knowledgeGeneration: true,
    knowledgePublication: true,
    knowledgeContextPolicy: {
      documentKeys: [KEY],
      slotBytes: input.slotBytes ?? 4096,
    },
    defaults: {
      providerId: provider.id,
      modelId: "fixture",
      mode: "plan",
      limits: {
        maxTurns: 2,
        maxDurationMs: 10000,
        maxContextBytes: input.contextBytes ?? 32768,
      },
    },
  };
  const original = createEngine(options),
    engines = new Set([original]);
  t.after(async () => {
    for (const engine of engines)
      await engine.close().catch((error) => {
        assert.ok(
          error instanceof EngineError && error.code === "CLEANUP_UNCERTAIN",
          String(error),
        );
      });
    rmSync(base, { recursive: true, force: true });
  });
  const workspace = await command<Workspace>(original, "workspace.open", {
    path: root,
  });
  const sourceSession = await command<Session>(original, "session.create", {
    workspaceId: workspace.id,
  });
  const sourceReceipt = await command<RunReceipt>(original, "run.submit", {
    sessionId: sourceSession.id,
    requestId: "original-coding-source",
    prompt:
      "Provide the exact settled source selected by the operator for later host knowledge.",
  });
  assert.equal(
    (await original.waitForRun(sourceReceipt.runId)).state,
    "completed",
  );
  await original.waitForSession(sourceSession.id);
  seed = false;
  const sourceMessage = original.store
    .getSnapshot(sourceSession.id)
    .messages.find((message) => message.role === "assistant")!;
  assert.ok(sourceMessage);
  const trust = await original.setWorkspaceTrust({
    workspaceId: workspace.id,
    requestId: "original-trust",
    expectedRevision: 0,
    decision: "allow",
    preview: original.previewWorkspaceTrust(workspace.id, ["AGENTS.md"]),
  });
  async function generate(requestId: string) {
    const projection = original.captureWorkspaceKnowledgeSources(workspace.id, [
      { kind: "file", path: "source.ts" },
      {
        kind: "message",
        sessionId: sourceSession.id,
        runId: sourceReceipt.runId,
        messageId: sourceMessage.id,
      },
    ]);
    const built = original.previewWorkspaceKnowledgeGeneration({
      providerId: provider.id,
      modelId: "fixture",
      projection,
    });
    const plan = await original.prepareWorkspaceKnowledgeGeneration({
      workspaceId: workspace.id,
      requestId: `${requestId}-plan`,
      expectedTrustRevision: trust.revision,
      projection,
      target: original.captureWorkspaceKnowledgeDocumentTarget(
        workspace.id,
        KEY,
      ),
      providerId: provider.id,
      modelId: "fixture",
      requestSha256: built.requestSha256,
      requestBytes: built.requestBytes,
      maxOutputBytes: 4096,
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    });
    const generated = await original.generateWorkspaceKnowledge({
      workspaceId: workspace.id,
      planId: plan.id,
      requestId,
      projection,
    });
    original.releaseWorkspaceKnowledgeSources(projection);
    return { plan, ...generated };
  }
  const first = await generate("original-generation");
  assert.equal(first.generation.state, "completed");
  assert.ok(first.candidate);
  const publication = await original.publishWorkspaceKnowledge({
    workspaceId: workspace.id,
    requestId: "original-publication",
    approved: true,
    preview: original.previewWorkspaceKnowledgePublication({
      workspaceId: workspace.id,
      candidateId: first.candidate.id,
    }),
  });
  assert.equal(publication.document.body, BODY);
  let uncertain: Awaited<ReturnType<typeof generate>> | null = null;
  if (input.uncertain) {
    uncertainNext = true;
    uncertain = await generate("original-uncertain-generation");
    assert.equal(uncertain.generation.state, "uncertain");
    assert.equal(uncertain.attempt!.cleanup!.confirmed, false);
    assert.equal(uncertain.candidate, null);
  }
  const originalRows = rows(dbPath, HISTORICAL_TABLES);
  await original.close();
  const archive = await exportEngineArchive({
    dbPath,
    artifactDir,
    destination: join(base, "archive"),
  });
  const imported = await importEngineArchive({
    directory: archive.directory,
    destination: join(base, "imported"),
  });
  const importOptIn = { knowledgeImportRecovery: true };
  const currentOptions: EngineOptions = {
    ...options,
    ...importOptIn,
    dbPath: imported.dbPath,
    artifactDir: imported.artifactDir,
  };
  let engine = createEngine(currentOptions);
  engines.add(engine);
  async function consume(
    current = engine,
    prompt = "Exact current imported workspace goal 한글😀",
    config: JsonObject = {},
  ) {
    const session = await command<Session>(current, "session.create", {
      workspaceId: workspace.id,
    });
    const receipt = await command<RunReceipt>(current, "run.submit", {
      sessionId: session.id,
      requestId: randomUUID(),
      prompt,
      config,
    });
    const run = await current.waitForRun(receipt.runId);
    await current.waitForSession(session.id);
    return {
      session,
      run,
      request: requests.find((request) => request.runId === run.id),
      prompt,
    };
  }
  return {
    base,
    root,
    dbPath: imported.dbPath,
    imported,
    archive,
    workspace,
    sourceSession,
    sourceRunId: sourceReceipt.runId,
    first,
    publication,
    uncertain,
    originalRows,
    originalTrust: trust,
    engine,
    engines,
    currentOptions,
    requests,
    consume,
    counts: () => ({
      generationCalls,
      seedCalls,
      consumerCalls: requests.length,
      failedReturns,
    }),
    async reopen(extra: Partial<EngineOptions> = {}) {
      await engine.close();
      engine = createEngine({ ...currentOptions, ...extra });
      engines.add(engine);
      return engine;
    },
    async recover(current = engine) {
      const acknowledgment = preview(current, workspace.id, "Acknowledgment");
      await decide(
        current,
        workspace.id,
        "Acknowledgment",
        acknowledgment,
        "explicit-import-acknowledgment",
      );
      const resume = preview(current, workspace.id, "Recovery");
      await decide(
        current,
        workspace.id,
        "Recovery",
        resume,
        "explicit-import-resume",
      );
      return { acknowledgment, resume };
    },
    async retrust(current = engine) {
      const previous = current.workspaceKnowledge.getTrust(workspace.id)!;
      return current.setWorkspaceTrust({
        workspaceId: workspace.id,
        requestId: randomUUID(),
        expectedRevision: previous.revision,
        decision: "allow",
        preview: current.previewWorkspaceTrust(workspace.id, ["AGENTS.md"]),
      });
    },
    async generateCurrentUncertain(current = engine) {
      uncertainNext = true;
      const projection = current.captureWorkspaceKnowledgeSources(
        workspace.id,
        [
          { kind: "file", path: "source.ts" },
          {
            kind: "message",
            sessionId: sourceSession.id,
            runId: sourceReceipt.runId,
            messageId: sourceMessage.id,
          },
        ],
      );
      try {
        const built = current.previewWorkspaceKnowledgeGeneration({
          providerId: provider.id,
          modelId: "fixture",
          projection,
        });
        const currentTrust = current.workspaceKnowledge.getTrust(workspace.id)!;
        const plan = await current.prepareWorkspaceKnowledgeGeneration({
          workspaceId: workspace.id,
          requestId: "current-successor-plan",
          expectedTrustRevision: currentTrust.revision,
          projection,
          target: current.captureWorkspaceKnowledgeDocumentTarget(
            workspace.id,
            "current.successor.memory",
          ),
          providerId: provider.id,
          modelId: "fixture",
          requestSha256: built.requestSha256,
          requestBytes: built.requestBytes,
          maxOutputBytes: 4096,
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        });
        const generated = await current.generateWorkspaceKnowledge({
          workspaceId: workspace.id,
          planId: plan.id,
          requestId: "current-successor-generation",
          projection,
        });
        return { plan, ...generated };
      } finally {
        current.releaseWorkspaceKnowledgeSources(projection);
      }
    },
    assertHistory(current = engine) {
      const observed = current.getWorkspaceKnowledgeGeneration(
        workspace.id,
        first.generation.id,
      );
      assert.equal(observed.generation.sha256, first.generation.sha256);
      assert.equal(observed.attempt!.sha256, first.attempt!.sha256);
      assert.equal(observed.candidate!.sha256, first.candidate!.sha256);
      const published = current.getWorkspaceKnowledgePublication(
        workspace.id,
        publication.publication.id,
      );
      assert.equal(
        published.publication.sha256,
        publication.publication.sha256,
      );
      assert.equal(published.document!.sha256, publication.document.sha256);
      assert.equal(published.receipt!.sha256, publication.receipt.sha256);
      assert.deepEqual(rows(imported.dbPath, HISTORICAL_TABLES), originalRows);
    },
  };
}

test("actual archive/import preserves original generation/publication identities while historical getter and default paused context confer no active authority", async (t) => {
  const f = await fixture(t);
  f.assertHistory();
  assert.equal(f.imported.executionResumed, false);
  assert.equal(
    f.engine.workspaceKnowledge.isImportPaused(f.workspace.id),
    true,
  );
  assert.equal(
    f.engine.getWorkspaceKnowledgeDocument(f.workspace.id, KEY)!.body,
    BODY,
  );
  assert.equal(
    f.engine.store.getSessionControl(f.sourceSession.id).paused,
    true,
  );
  assert.deepEqual(f.counts(), {
    generationCalls: 1,
    seedCalls: 1,
    consumerCalls: 0,
    failedReturns: 0,
  });
  const beforeEffects = rows(f.dbPath, PRODUCTION_TABLES),
    result = await f.consume();
  assert.equal(result.run.state, "completed", JSON.stringify(result.run.error));
  assert.ok(result.request);
  assert.ok(
    !result.request.messages.some((message) => message.content.includes(BODY)),
  );
  assert.equal(
    knowledge(f.engine, result.session.id).omissions[0]!.reason,
    "paused",
  );
  assert.equal(knowledge(f.engine, result.session.id).documents.length, 0);
  assert.equal(result.request.messages.at(-1)!.content, result.prompt);
  assert.deepEqual(rows(f.dbPath, PRODUCTION_TABLES), beforeEffects);
  assert.deepEqual(f.counts(), {
    generationCalls: 1,
    seedCalls: 1,
    consumerCalls: 1,
    failedReturns: 0,
  });
  f.assertHistory();
});

test("explicit original import acknowledgment and separate resume grant no activation, preserve old unknown cleanup, and never replay producers", async (t) => {
  const f = await fixture(t, { uncertain: true });
  assert.ok(f.uncertain);
  const importedUnknown = f.engine.getWorkspaceKnowledgeGeneration(
    f.workspace.id,
    f.uncertain.generation.id,
  );
  assert.equal(
    importedUnknown.generation.sha256,
    f.uncertain.generation.sha256,
  );
  assert.equal(importedUnknown.attempt!.sha256, f.uncertain.attempt!.sha256);
  assert.equal(importedUnknown.attempt!.cleanup!.confirmed, false);
  const counts = f.counts();
  assert.deepEqual(counts, {
    generationCalls: 2,
    seedCalls: 1,
    consumerCalls: 0,
    failedReturns: 1,
  });
  const acknowledgment = preview(f.engine, f.workspace.id, "Acknowledgment");
  const beforeCopy = importRows(f.dbPath);
  await assert.rejects(
    decide(
      f.engine,
      f.workspace.id,
      "Acknowledgment",
      structuredClone(acknowledgment),
    ),
    EngineError,
  );
  assert.deepEqual(importRows(f.dbPath), beforeCopy);
  await decide(
    f.engine,
    f.workspace.id,
    "Acknowledgment",
    acknowledgment,
    "actual-import-ack",
  );
  assert.equal(
    f.engine.store.getSessionControl(f.sourceSession.id).paused,
    true,
  );
  assert.equal(
    f.engine.workspaceKnowledge.isImportPaused(f.workspace.id),
    true,
  );
  assert.deepEqual(f.counts(), counts);
  f.assertHistory();
  const resume = preview(f.engine, f.workspace.id, "Recovery");
  await decide(
    f.engine,
    f.workspace.id,
    "Recovery",
    resume,
    "actual-import-resume",
  );
  assert.equal(
    f.engine.store.getSessionControl(f.sourceSession.id).paused,
    true,
  );
  assert.deepEqual(f.counts(), counts);
  f.assertHistory();
  const currentUnknown = f.engine.getWorkspaceKnowledgeGeneration(
    f.workspace.id,
    f.uncertain.generation.id,
  );
  assert.equal(currentUnknown.generation.state, "uncertain");
  assert.equal(currentUnknown.attempt!.cleanup!.confirmed, false);
  assert.equal(currentUnknown.candidate, null);
  const currentTrust = await f.retrust();
  assert.notEqual(
    currentTrust.binding.storageBindingSha256,
    f.originalTrust.binding.storageBindingSha256,
  );
  assert.equal(currentTrust.revision, f.originalTrust.revision + 1);
  const result = await f.consume();
  assert.equal(result.run.state, "completed", JSON.stringify(result.run.error));
  assert.ok(result.request);
  assert.ok(
    !result.request.messages.some((message) => message.content.includes(BODY)),
  );
  assert.equal(knowledge(f.engine, result.session.id).documents.length, 0);
  assert.equal(f.counts().generationCalls, 2);
  assert.equal(f.counts().failedReturns, 1);
  f.assertHistory();
});

test("a real current successor uncertainty requires its own recovery while the unchanged imported foreign owner remains resolved", async (t) => {
  const f = await fixture(t, { uncertain: true });
  assert.ok(f.uncertain);
  await f.recover();
  const trust = await f.retrust();
  const oldOwner = f.engine.getWorkspaceKnowledgeGeneration(
    f.workspace.id,
    f.uncertain.generation.id,
  );
  const successor = await f.generateCurrentUncertain();
  assert.equal(successor.generation.state, "uncertain");
  const successorAttempt = successor.attempt;
  assert.ok(successorAttempt);
  assert.equal(successorAttempt.cleanup!.confirmed, false);
  assert.equal(successor.candidate, null);
  assert.deepEqual(successor.generation.binding, trust.binding);
  assert.notEqual(
    successor.generation.binding.storageBindingSha256,
    oldOwner.generation.binding.storageBindingSha256,
  );
  const counts = f.counts();
  assert.deepEqual(counts, {
    generationCalls: 3,
    seedCalls: 1,
    consumerCalls: 0,
    failedReturns: 2,
  });
  assert.throws(
    () => preview(f.engine, f.workspace.id, "Activation"),
    (error) => error instanceof EngineError && error.code === "CLEANUP_PENDING",
  );
  const captured = f.engine.getWorkspaceKnowledgeRecoveryPreview(
    f.workspace.id,
  );
  assert.deepEqual(
    captured.generations.map((owner) => owner.id),
    [successor.generation.id],
  );
  assert.deepEqual(
    captured.attempts.map((attempt) => attempt.id),
    [successorAttempt.id],
  );
  assert.deepEqual(captured.binding, trust.binding);
  const acknowledgment = await f.engine.acknowledgeWorkspaceKnowledgeRecovery({
    preview: captured,
    requestId: "ack-current-successor-only",
    reason:
      "Operator explicitly acknowledged only this current-storage successor uncertainty.",
    acknowledged: true,
  });
  assert.equal(acknowledgment.barrier.state, "pending-resume");
  assert.deepEqual(acknowledgment.acknowledgment.generations, [
    { id: successor.generation.id, sha256: successor.generation.sha256 },
  ]);
  const resumed = await f.engine.resumeWorkspaceKnowledge({
    workspaceId: f.workspace.id,
    requestId: "resume-current-successor-only",
    expectedRevision: acknowledgment.barrier.revision,
    expectedFrontierSha256: acknowledgment.barrier.frontierSha256,
  });
  assert.equal(resumed.barrier.state, "clear");
  assert.throws(
    () => f.engine.getWorkspaceKnowledgeRecoveryPreview(f.workspace.id),
    (error) =>
      error instanceof EngineError &&
      error.code === "KNOWLEDGE_GENERATION_RECOVERY_EMPTY",
  );
  assert.deepEqual(f.counts(), counts);
  for (const expected of [oldOwner, successor]) {
    const observed = f.engine.getWorkspaceKnowledgeGeneration(
      f.workspace.id,
      expected.generation.id,
    );
    assert.equal(observed.generation.sha256, expected.generation.sha256);
    assert.equal(observed.generation.state, "uncertain");
    assert.equal(observed.attempt!.sha256, expected.attempt!.sha256);
    assert.equal(observed.attempt!.cleanup!.confirmed, false);
    assert.equal(observed.candidate, null);
  }
  assert.equal(
    f.engine.getWorkspaceKnowledgeGeneration(
      f.workspace.id,
      f.first.generation.id,
    ).generation.sha256,
    f.first.generation.sha256,
  );
  const publication = f.engine.getWorkspaceKnowledgePublication(
    f.workspace.id,
    f.publication.publication.id,
  );
  assert.equal(
    publication.publication.sha256,
    f.publication.publication.sha256,
  );
  assert.equal(publication.document!.sha256, f.publication.document.sha256);
  assert.equal(publication.receipt!.sha256, f.publication.receipt.sha256);
  await decide(
    f.engine,
    f.workspace.id,
    "Activation",
    preview(f.engine, f.workspace.id, "Activation"),
    "activate-after-successor-recovery",
  );
  assert.deepEqual(f.counts(), counts);
  const consumer = await f.consume();
  assert.equal(
    consumer.run.state,
    "completed",
    JSON.stringify(consumer.run.error),
  );
  assert.ok(consumer.request);
  assert.equal(
    knowledge(f.engine, consumer.session.id).documents[0]!.documentSha256,
    f.publication.document.sha256,
  );
  assert.equal(f.counts().generationCalls, 3);
  assert.equal(f.counts().failedReturns, 2);
});

test("fresh trust plus explicit original imported document activation reaches a native coding Attempt with exact ContextRevision and no historical reissue", async (t) => {
  const f = await fixture(t);
  await f.recover();
  assert.throws(
    () => preview(f.engine, f.workspace.id, "Activation"),
    EngineError,
  );
  const trust = await f.retrust();
  const captured = preview(f.engine, f.workspace.id, "Activation");
  const before = f.counts(),
    beforeEffects = rows(f.dbPath, PRODUCTION_TABLES);
  const activated = await decide(
    f.engine,
    f.workspace.id,
    "Activation",
    captured,
    "actual-import-activate",
  );
  assert.equal(activated.activation!.state, "active");
  assert.equal(activated.activation!.proof.currentTrustId, trust.id);
  assert.equal(activated.activation!.proof.currentTrustSha256, trust.sha256);
  assert.deepEqual(
    activated.activation!.proof.originalBinding,
    f.first.candidate!.binding,
  );
  assert.deepEqual(activated.activation!.binding, trust.binding);
  const nativeBeforeDuplicate = importRows(f.dbPath);
  const duplicate = await decide(
    f.engine,
    f.workspace.id,
    "Activation",
    captured,
    "actual-import-activate",
  );
  assert.equal(duplicate.decision.sha256, activated.decision.sha256);
  assert.equal(duplicate.activation!.sha256, activated.activation!.sha256);
  assert.deepEqual(importRows(f.dbPath), nativeBeforeDuplicate);
  await assert.rejects(
    decide(
      f.engine,
      f.workspace.id,
      "Activation",
      captured,
      "reuse-consumed-preview",
    ),
    EngineError,
  );
  const nativeProof = f.engine.store.readKnowledgeImportDocumentProof(
    f.workspace.id,
    KEY,
  )!;
  assert.equal(nativeProof.history.candidate.sha256, f.first.candidate!.sha256);
  assert.equal(nativeProof.document.sha256, f.publication.document.sha256);
  assert.equal(nativeProof.currentTrust!.id, trust.id);
  assert.deepEqual(f.counts(), before);
  f.assertHistory();
  assert.deepEqual(rows(f.dbPath, PRODUCTION_TABLES), beforeEffects);
  const result = await f.consume();
  assert.equal(result.run.state, "completed", JSON.stringify(result.run.error));
  assert.ok(result.request);
  assert.equal(
    result.request.messages.filter((message) =>
      message.content.includes("import_recovery_actual_approved_knowledge"),
    ).length,
    1,
  );
  assert.equal(result.request.messages.at(-1)!.content, result.prompt);
  const actual = knowledge(f.engine, result.session.id),
    document = actual.documents[0]!;
  assert.equal(actual.documents.length, 1);
  assert.equal(document.documentRevisionId, f.publication.document.id);
  assert.equal(document.documentSha256, f.publication.document.sha256);
  assert.equal(document.candidateId, f.first.candidate!.id);
  assert.equal(document.generationId, f.first.generation.id);
  assert.equal(document.attemptId, f.first.attempt!.id);
  assert.equal(
    document.sourceManifestSha256,
    knowledgeHash(f.first.plan.source),
  );
  assert.equal(document.sourceTextSha256, f.first.plan.source.sha256);
  assert.equal(document.trustRevisionId, trust.id);
  assert.equal(document.trustRevisionSha256, trust.sha256);
  assert.equal(
    document.importActivation!.activationId,
    activated.activation!.id,
  );
  assert.equal(
    document.importActivation!.activationSha256,
    activated.activation!.sha256,
  );
  assert.equal(
    document.importActivation!.frontierSha256,
    activated.frontier.frontier.sha256,
  );
  assert.equal(
    document.importActivation!.originalBindingSha256,
    knowledgeHash(f.first.candidate!.binding),
  );
  assert.equal(
    document.importActivation!.currentBindingSha256,
    knowledgeHash(trust.binding),
  );
  const attempt = f.engine.store.getAttempt(result.request.attemptId!);
  assert.ok(attempt.contextRevisionId);
  const revision = f.engine.store.getContextRevision(attempt.contextRevisionId);
  assert.equal(revision.text, JSON.stringify(result.request.messages));
  assert.equal(revision.sha256, sha256(revision.text));
  assert.ok(
    revision.sourceIds.includes(
      `knowledge-import-activation:${activated.activation!.id}:${activated.activation!.sha256}`,
    ),
  );
  assert.ok(
    revision.sourceIds.includes(
      `knowledge-import-frontier:${activated.frontier.frontier.id}:${activated.frontier.frontier.sha256}`,
    ),
  );
  assert.ok(
    revision.sourceIds.includes(
      `knowledge-import-resume:${activated.activation!.resumeDecisionSha256}`,
    ),
  );
  assert.ok(
    revision.sourceIds.includes(
      `knowledge-import-original-binding:${knowledgeHash(f.first.candidate!.binding)}`,
    ),
  );
  const cleanup = f.engine.store.getAttemptCleanup(attempt.id);
  assert.equal(cleanup.contextRevisionId, revision.id);
  assert.equal(cleanup.requestSha256, sha256(JSON.stringify(result.request)));
  const plan = f.engine.context.diagnostics(result.session.id)!.plan;
  assert.equal(
    plan.bytes,
    Buffer.byteLength(JSON.stringify(result.request.messages)) +
      plan.reservations.envelopeBytes,
  );
  assert.equal(
    plan.reservations.knowledgeBytes,
    actual.reservations.contributedBytes,
  );
  assert.ok(plan.bytes <= result.run.config.limits.maxContextBytes);
  assert.equal(actual.bindingSha256, knowledgeHash(trust.binding));
  f.assertHistory();
  assert.equal(f.counts().generationCalls, 1);
  assert.equal(f.counts().seedCalls, 1);
});

test("an original activation capture cannot be copied, reflected through getters, pre-cancelled, or consumed after trust/source changes", async (t) => {
  const f = await fixture(t);
  await f.recover();
  await f.retrust();
  const copyCapture = preview(f.engine, f.workspace.id, "Activation");
  let getterCalls = 0;
  const before = importRows(f.dbPath),
    counts = f.counts();
  await assert.rejects(
    decide(
      f.engine,
      f.workspace.id,
      "Activation",
      structuredClone(copyCapture),
    ),
    EngineError,
  );
  const hostile = Object.defineProperty(
    {
      workspaceId: f.workspace.id,
      requestId: "hostile-activation",
      approved: true,
    },
    "preview",
    {
      enumerable: true,
      get() {
        getterCalls++;
        return copyCapture;
      },
    },
  );
  await assert.rejects(
    api<Promise<unknown>>(
      f.engine,
      "activateWorkspaceKnowledgeImport",
      hostile,
    ),
    EngineError,
  );
  const cancelled = new AbortController();
  cancelled.abort(
    new EngineError("HOST_CANCELLED", "Operator cancelled before activation"),
  );
  await assert.rejects(
    decide(
      f.engine,
      f.workspace.id,
      "Activation",
      copyCapture,
      "pre-cancelled",
      cancelled.signal,
    ),
    EngineError,
  );
  assert.equal(getterCalls, 0);
  assert.deepEqual(importRows(f.dbPath), before);
  assert.deepEqual(f.counts(), counts);
  const sourceCapture = preview(f.engine, f.workspace.id, "Activation");
  writeFileSync(
    join(f.root, "source.ts"),
    "export const selectedImportSource = 8;\n",
  );
  await assert.rejects(
    decide(
      f.engine,
      f.workspace.id,
      "Activation",
      sourceCapture,
      "source-stale",
    ),
    EngineError,
  );
  assert.deepEqual(importRows(f.dbPath), before);
  assert.deepEqual(f.counts(), counts);
  f.assertHistory();
});

test("durable activated imported knowledge survives restart without carrying ephemeral previews or replaying generation", async (t) => {
  const f = await fixture(t);
  await f.recover();
  await f.retrust();
  const original = preview(f.engine, f.workspace.id, "Activation");
  await decide(
    f.engine,
    f.workspace.id,
    "Activation",
    original,
    "activation-before-restart",
  );
  const released = preview(f.engine, f.workspace.id, "Deactivation");
  const before = importRows(f.dbPath),
    counts = f.counts();
  const current = await f.reopen({ knowledgeImportRecovery: false });
  await assert.rejects(
    decide(
      current,
      f.workspace.id,
      "Deactivation",
      released,
      "old-instance-preview",
    ),
    EngineError,
  );
  assert.deepEqual(importRows(f.dbPath), before);
  assert.deepEqual(f.counts(), counts);
  const result = await f.consume(current);
  assert.equal(result.run.state, "completed", JSON.stringify(result.run.error));
  assert.ok(result.request);
  assert.equal(
    result.request.messages.filter((message) =>
      message.content.includes("import_recovery_actual_approved_knowledge"),
    ).length,
    1,
  );
  assert.equal(
    knowledge(current, result.session.id).documents[0]!.documentSha256,
    f.publication.document.sha256,
  );
  f.assertHistory(current);
  assert.equal(f.counts().generationCalls, 1);
});

test("host import mutation is disabled by default while imported native history remains independently readable", async (t) => {
  const f = await fixture(t);
  const before = importRows(f.dbPath),
    counts = f.counts();
  const current = await f.reopen({ knowledgeImportRecovery: undefined });
  f.assertHistory(current);
  assert.throws(
    () => preview(current, f.workspace.id, "Acknowledgment"),
    EngineError,
  );
  assert.throws(
    () => preview(current, f.workspace.id, "Recovery"),
    EngineError,
  );
  assert.throws(
    () => preview(current, f.workspace.id, "Activation"),
    EngineError,
  );
  assert.deepEqual(importRows(f.dbPath), before);
  assert.deepEqual(f.counts(), counts);
});

test("matching path and file bytes in a replacement physical workspace cannot silently rebind original imported knowledge", async (t) => {
  const f = await fixture(t);
  const before = importRows(f.dbPath),
    counts = f.counts();
  const captured = preview(f.engine, f.workspace.id, "Acknowledgment");
  renameSync(f.root, `${f.root}-original`);
  mkdirSync(f.root);
  writeFileSync(
    join(f.root, "AGENTS.md"),
    "Fresh operator-selected instruction authority for this physical workspace.\n",
  );
  writeFileSync(join(f.root, "source.ts"), SOURCE);
  execFileSync("git", ["init", "--quiet", "--template=", f.root]);
  await assert.rejects(
    decide(
      f.engine,
      f.workspace.id,
      "Acknowledgment",
      captured,
      "physical-root-replaced",
    ),
    EngineError,
  );
  assert.throws(
    () => preview(f.engine, f.workspace.id, "Acknowledgment"),
    EngineError,
  );
  assert.deepEqual(importRows(f.dbPath), before);
  assert.deepEqual(f.counts(), counts);
  f.assertHistory();
});

test("import acknowledgment rejects an independently held actual execution lock without clearing its owner or publishing recovery authority", async (t) => {
  const f = await fixture(t),
    captured = preview(f.engine, f.workspace.id, "Acknowledgment");
  const before = importRows(f.dbPath),
    counts = f.counts(),
    effectPath = `${f.dbPath}.effects.sqlite`;
  const originalLock = acquireExecutionLock(effectPath);
  try {
    assert.equal(inspectExecutionLock(effectPath).status, "busy");
    await assert.rejects(
      decide(
        f.engine,
        f.workspace.id,
        "Acknowledgment",
        captured,
        "foreign-live-lock",
      ),
      EngineError,
    );
    assert.equal(inspectExecutionLock(effectPath).status, "busy");
    assert.deepEqual(importRows(f.dbPath), before);
    assert.deepEqual(f.counts(), counts);
  } finally {
    originalLock.release(true);
  }
  const available = inspectExecutionLock(effectPath);
  assert.equal(available.status, "available");
  assert.equal(available.marker!.ownerPid, process.pid);
  assert.equal(available.marker!.active, false);
  f.assertHistory();
});

test("activated imported knowledge shares the actual Context budget and whole-document omission preserves the required current exchange", async (t) => {
  const f = await fixture(t);
  await f.recover();
  await f.retrust();
  const prompt = "Exact required imported workspace objective 한글😀. ".repeat(
    32,
  );
  const baseline = await f.consume(f.engine, prompt);
  assert.equal(baseline.run.state, "completed");
  assert.ok(baseline.request);
  assert.equal(knowledge(f.engine, baseline.session.id).documents.length, 0);
  const base = f.engine.context.diagnostics(baseline.session.id)!.plan;
  await decide(
    f.engine,
    f.workspace.id,
    "Activation",
    preview(f.engine, f.workspace.id, "Activation"),
    "activate-before-small-budget",
  );
  const included = await f.consume(f.engine, prompt);
  assert.equal(included.run.state, "completed");
  assert.ok(included.request);
  const contribution = knowledge(f.engine, included.session.id);
  assert.equal(contribution.documents.length, 1);
  const maxContextBytes =
    base.bytes + Math.floor(contribution.reservations.contributedBytes / 2);
  assert.ok(maxContextBytes >= 1024);
  const omitted = await f.consume(f.engine, prompt, {
    limits: { maxContextBytes },
  });
  assert.equal(
    omitted.run.state,
    "completed",
    JSON.stringify(omitted.run.error),
  );
  assert.ok(omitted.request);
  assert.equal(omitted.request.messages.at(-1)!.content, prompt);
  assert.ok(
    !omitted.request.messages.some((message) =>
      message.content.includes("import_recovery_actual_approved_knowledge"),
    ),
  );
  assert.equal(knowledge(f.engine, omitted.session.id).documents.length, 0);
  assert.equal(
    knowledge(f.engine, omitted.session.id).omissions[0]!.reason,
    "context-budget",
  );
  const plan = f.engine.context.diagnostics(omitted.session.id)!.plan;
  assert.equal(plan.reservations.knowledgeBytes ?? 0, 0);
  assert.equal(
    plan.bytes,
    Buffer.byteLength(JSON.stringify(omitted.request.messages)) +
      plan.reservations.envelopeBytes,
  );
  assert.ok(plan.bytes <= maxContextBytes);
  assert.equal(f.counts().generationCalls, 1);
  f.assertHistory();
});

for (const mutation of ["deactivate", "source-delete", "trust-deny"] as const)
  test(`actual activated imported document loses context authority after ${mutation} without changing producer history`, async (t) => {
    const f = await fixture(t);
    await f.recover();
    await f.retrust();
    await decide(
      f.engine,
      f.workspace.id,
      "Activation",
      preview(f.engine, f.workspace.id, "Activation"),
      "activate-before-mutation",
    );
    const before = f.counts();
    if (mutation === "deactivate")
      await decide(
        f.engine,
        f.workspace.id,
        "Deactivation",
        preview(f.engine, f.workspace.id, "Deactivation"),
        "actual-deactivate",
      );
    else if (mutation === "source-delete")
      unlinkSync(join(f.root, "source.ts"));
    else {
      const trust = f.engine.workspaceKnowledge.getTrust(f.workspace.id)!;
      await f.engine.setWorkspaceTrust({
        workspaceId: f.workspace.id,
        requestId: "current-trust-deny",
        expectedRevision: trust.revision,
        decision: "deny",
      });
    }
    const result = await f.consume();
    assert.equal(
      result.run.state,
      "completed",
      JSON.stringify(result.run.error),
    );
    assert.ok(result.request);
    assert.ok(
      !result.request.messages.some((message) =>
        message.content.includes("import_recovery_actual_approved_knowledge"),
      ),
    );
    assert.equal(knowledge(f.engine, result.session.id).documents.length, 0);
    assert.equal(f.counts().generationCalls, before.generationCalls);
    if (mutation !== "deactivate") {
      const reduced = await decide(
        f.engine,
        f.workspace.id,
        "Deactivation",
        preview(f.engine, f.workspace.id, "Deactivation"),
        "deactivate-after-authority-loss",
      );
      assert.equal(reduced.activation!.state, "inactive");
      assert.equal(f.counts().generationCalls, before.generationCalls);
    }
    f.assertHistory();
  });

test("original import activation deadline and explicit released preview remain effect-free on expiration", async (t) => {
  const f = await fixture(t);
  await f.recover();
  await f.retrust();
  const expiresAt = new Date(Date.now() + 500).toISOString(),
    expired = preview(f.engine, f.workspace.id, "Activation", expiresAt);
  const released = preview(f.engine, f.workspace.id, "Activation");
  api(f.engine, "releaseWorkspaceKnowledgeImportPreview", released);
  const before = importRows(f.dbPath),
    counts = f.counts();
  await assert.rejects(
    decide(
      f.engine,
      f.workspace.id,
      "Activation",
      released,
      "released-preview",
    ),
    EngineError,
  );
  await pause(Math.max(0, Date.parse(expiresAt) - Date.now()) + 15);
  await assert.rejects(
    decide(f.engine, f.workspace.id, "Activation", expired, "expired-preview"),
    EngineError,
  );
  assert.deepEqual(importRows(f.dbPath), before);
  assert.deepEqual(f.counts(), counts);
  f.assertHistory();

  const previousTrust = f.engine.workspaceKnowledge.getTrust(f.workspace.id)!;
  const trustExpiresAt = new Date(Date.now() + 1000).toISOString();
  await f.engine.setWorkspaceTrust({
    workspaceId: f.workspace.id,
    requestId: "short-lived-current-import-trust",
    expectedRevision: previousTrust.revision,
    decision: "allow",
    preview: f.engine.previewWorkspaceTrust(f.workspace.id, ["AGENTS.md"]),
    expiresAt: trustExpiresAt,
  });
  const active = await decide(
    f.engine,
    f.workspace.id,
    "Activation",
    preview(f.engine, f.workspace.id, "Activation"),
    "activate-with-current-trust-expiry",
  );
  assert.equal(active.activation!.proof.expiresAt, trustExpiresAt);
  const first = await f.consume();
  assert.equal(first.run.state, "completed");
  assert.equal(knowledge(f.engine, first.session.id).documents.length, 1);
  await pause(Math.max(0, Date.parse(trustExpiresAt) - Date.now()) + 15);
  const expiredResult = await f.consume();
  assert.equal(expiredResult.run.state, "completed");
  assert.ok(expiredResult.request);
  assert.ok(
    !expiredResult.request.messages.some((message) =>
      message.content.includes("import_recovery_actual_approved_knowledge"),
    ),
  );
  assert.equal(
    knowledge(f.engine, expiredResult.session.id).documents.length,
    0,
  );
  assert.equal(
    knowledge(f.engine, expiredResult.session.id).omissions[0]!.reason,
    "expired",
  );
  assert.equal(f.counts().generationCalls, counts.generationCalls);
  f.assertHistory();
});
