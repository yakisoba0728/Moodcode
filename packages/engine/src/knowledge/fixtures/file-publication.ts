import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import {
  EngineError,
  type JsonObject,
  type Workspace,
} from "@moodcode/contracts";
import { createEngine } from "../../engine.js";
import type { ProviderAdapter, ProviderEvent } from "../../ports.js";
import type { HostGenerationRequest } from "../../provider/generation.js";
import type { KnowledgeCandidate } from "../types.js";
import type {
  KnowledgeFilePublicationPreview,
  WorkspaceKnowledgeFilePublicationResult,
} from "../file-publication-service.js";
import { sha256 } from "../validation.js";

type Engine = ReturnType<typeof createEngine>;
export const BODY =
  "Independently generated exact approved file knowledge. 한글😀\n";
export const BODY2 = "Second exact approved physical file revision.\n";
export const TARGET = ".moodcode/skills/generated/SKILL.md";
const forbiddenTables = [
  "sessions",
  "runs",
  "messages",
  "tools",
  "approvals",
  "checkpoints",
  "session_turns",
  "provider_attempts",
  "summary_attempts",
];
export function invoke<T>(
  engine: Engine,
  method: string,
  ...args: unknown[]
): T {
  const implementation = Reflect.get(engine, method);
  assert.equal(
    typeof implementation,
    "function",
    `Actual Engine must expose ${method}`,
  );
  return Reflect.apply(implementation, engine, args) as T;
}
export function failure(expected?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof EngineError);
    if (expected) assert.equal(error.code, expected);
    return true;
  };
}
function tableRows(
  dbPath: string,
  tables = forbiddenTables,
): Record<string, unknown[]> {
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
export type FilePreview = KnowledgeFilePublicationPreview;
export type FilePublicationResult = WorkspaceKnowledgeFilePublicationResult;
export async function filePublicationFixture(t: TestContext, enabled = true) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-file-publication-engine-")),
    ),
    root = join(base, "repository"),
    dbPath = join(base, "engine.sqlite"),
    artifactDir = join(base, "artifacts");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  writeFileSync(
    join(root, "AGENTS.md"),
    "Original approved independent file publication instructions.\n",
  );
  writeFileSync(join(root, "origin.ts"), "export const actualOrigin = 1;\n");
  let body = BODY,
    codingCalls = 0,
    sequence = 0;
  const generations: HostGenerationRequest[] = [];
  const provider: ProviderAdapter = {
    id: "file-publication-native-fixture",
    async *streamTurn(): AsyncGenerator<ProviderEvent> {
      codingCalls++;
      throw new Error("File publication has no coding producer");
    },
    streamGeneration(request) {
      generations.push(request);
      return (async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: "usage", inputTokens: 0, outputTokens: 4 };
        yield { type: "text.delta", delta: body };
        yield { type: "finish", reason: "stop" };
      })();
    },
  };
  const options = {
    dbPath,
    artifactDir,
    providers: [provider],
    knowledgeGeneration: true,
    knowledgeFilePublication: enabled,
    defaults: { providerId: provider.id, modelId: "fixture-model" },
  };
  const engine = createEngine(options),
    engines = new Set([engine]);
  t.after(async () => {
    for (const current of engines) await current.close();
    rmSync(base, { recursive: true, force: true });
  });
  const reply = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type: "workspace.open",
    payload: { path: root },
  });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  const workspace = reply.result as unknown as Workspace;
  await engine.setWorkspaceTrust({
    workspaceId: workspace.id,
    requestId: "file-trust",
    expectedRevision: 0,
    decision: "allow",
    preview: engine.previewWorkspaceTrust(workspace.id, ["AGENTS.md"]),
  });
  async function candidate(
    path = TARGET,
    nextBody = BODY,
    current = engine,
    sourcePath = "origin.ts",
  ) {
    body = nextBody;
    const index = ++sequence;
    const projection = current.captureWorkspaceKnowledgeSources(workspace.id, [
        { kind: "file", path: sourcePath },
      ]),
      logical = current.previewWorkspaceKnowledgeGeneration({
        providerId: provider.id,
        modelId: "fixture-model",
        projection,
      });
    const target = current.captureWorkspaceKnowledgeTarget(workspace.id, path),
      trust = current.workspaceKnowledge.getTrust(workspace.id)!;
    const plan = await current.prepareWorkspaceKnowledgeGeneration({
      workspaceId: workspace.id,
      requestId: `file-plan-${index}`,
      expectedTrustRevision: trust.revision,
      projection,
      target,
      providerId: provider.id,
      modelId: "fixture-model",
      requestSha256: logical.requestSha256,
      requestBytes: logical.requestBytes,
      maxOutputBytes: 16384,
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    });
    const generated = await current.generateWorkspaceKnowledge({
      workspaceId: workspace.id,
      planId: plan.id,
      requestId: `file-generation-${index}`,
      projection,
    });
    assert.equal(generated.generation.state, "completed");
    assert.ok(generated.candidate);
    assert.equal(generated.candidate.body, nextBody);
    return generated.candidate;
  }
  const before = tableRows(dbPath);
  const preview = (
    value: KnowledgeCandidate,
    current = engine,
    expiresAt?: string,
  ) =>
    invoke<Promise<FilePreview>>(
      current,
      "previewWorkspaceKnowledgeFilePublication",
      {
        workspaceId: workspace.id,
        candidateId: value.id,
        ...(expiresAt ? { expiresAt } : {}),
      },
    );
  const revokePreview = (publicationId: string, current = engine) =>
    invoke<Promise<FilePreview>>(
      current,
      "previewWorkspaceKnowledgeFileRevocation",
      { workspaceId: workspace.id, publicationId },
    );
  const publish = (
    value: FilePreview,
    requestId: string = randomUUID(),
    current = engine,
    signal?: AbortSignal,
  ) =>
    invoke<Promise<FilePublicationResult>>(
      current,
      "publishWorkspaceKnowledgeFile",
      {
        workspaceId: workspace.id,
        requestId,
        approved: true,
        preview: value,
        ...(signal ? { signal } : {}),
      },
    );
  const revoke = (
    value: FilePreview,
    requestId: string = randomUUID(),
    current = engine,
  ) =>
    invoke<Promise<FilePublicationResult>>(
      current,
      "revokeWorkspaceKnowledgeFile",
      { workspaceId: workspace.id, requestId, approved: true, preview: value },
    );
  return {
    base,
    root,
    retireClosed(current = engine) {
      const nativeDatabase = Reflect.get(current.store, "db");
      assert.ok(nativeDatabase instanceof DatabaseSync);
      assert.equal(
        nativeDatabase.isOpen,
        false,
        "Only an actually closed native Engine may leave cleanup ownership",
      );
      engines.delete(current);
    },
    dbPath,
    engine,
    workspace,
    generations,
    candidate,
    preview,
    revokePreview,
    publish,
    revoke,
    reopen() {
      const current = createEngine(options);
      engines.add(current);
      return current;
    },
    assertNoCoding() {
      assert.equal(codingCalls, 0);
      assert.deepEqual(tableRows(dbPath), before);
    },
  };
}
