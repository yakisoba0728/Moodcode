import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { EngineError, type Workspace } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import type { ProviderAdapter } from "../ports.js";
import {
  exportEngineArchive,
  importEngineArchive,
  validateEngineArchive,
} from "../storage/archive.js";
import {
  acquireExecutionLock,
  inspectExecutionLock,
} from "../tools/command/execution-lock.js";
import type {
  KnowledgeGenerationAttempt,
  KnowledgeGenerationRecord,
} from "./generation-types.js";
import type { KnowledgeImportFrontier } from "./import-recovery-types.js";
import { knowledgeHash } from "./validation.js";

type Phase = "prepared" | "streaming";
interface Boundary {
  phase: Phase;
  generation: KnowledgeGenerationRecord;
  attempt: KnowledgeGenerationAttempt;
}
function rows(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = (table: string) =>
      db
        .prepare(`SELECT data FROM ${table} ORDER BY id`)
        .all()
        .map(
          (value) => JSON.parse(String(value.data)) as Record<string, unknown>,
        );
    return {
      generations: row("knowledge_generations"),
      attempts: row("knowledge_generation_attempts"),
      candidates: row("knowledge_candidates"),
      barriers: row("knowledge_generation_workspace_barriers"),
      frontiers: row("knowledge_import_frontiers"),
      decisions: row("knowledge_import_recovery_decisions"),
      production: [
        "runs",
        "tools",
        "provider_attempts",
        "checkpoints",
        "knowledge_file_publications",
      ].map(
        (table) =>
          db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count,
      ),
    };
  } finally {
    db.close();
  }
}
async function fixture(t: TestContext, phase: Phase) {
  const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-import-interrupted-")),
    ),
    root = join(directory, "workspace"),
    dbPath = join(directory, "source.sqlite"),
    artifactDir = join(directory, "source-artifacts");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  writeFileSync(
    join(root, "AGENTS.md"),
    "Reviewed interrupted-import instructions.\n",
  );
  writeFileSync(join(root, "source.ts"), "export const selected = 7;\n");
  let replay = 0;
  const provider: ProviderAdapter = {
    id: "import-interrupted-fixture",
    async *streamTurn() {
      replay++;
      throw new Error("No coding replay allowed");
    },
    streamGeneration() {
      replay++;
      throw new Error("No host generation replay allowed");
    },
  };
  const options = {
    providers: [provider],
    tools: [],
    knowledgeGeneration: true,
    knowledgeImportRecovery: true,
    defaults: { providerId: provider.id, modelId: "interrupted-model" },
  };
  const original = createEngine({ ...options, dbPath, artifactDir }),
    engines = new Set([original]);
  t.after(async () => {
    for (const engine of engines) await engine.close();
    rmSync(directory, { recursive: true, force: true });
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
  const selection = [{ kind: "file" as const, path: "source.ts" }],
    projection = original.captureWorkspaceKnowledgeSources(
      workspace.id,
      selection,
    ),
    preview = original.previewWorkspaceKnowledgeGeneration({
      providerId: provider.id,
      modelId: "interrupted-model",
      projection,
    });
  const plan = await original.prepareWorkspaceKnowledgeGeneration({
    workspaceId: workspace.id,
    requestId: "original-plan",
    expectedTrustRevision: trust.revision,
    projection,
    target: original.captureWorkspaceKnowledgeTarget(workspace.id, "MEMORY.md"),
    providerId: provider.id,
    modelId: "interrupted-model",
    requestSha256: preview.requestSha256,
    requestBytes: preview.requestBytes,
    maxOutputBytes: 1024,
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });
  original.releaseWorkspaceKnowledgeSources(projection);
  await original.close();
  writeFileSync(
    join(directory, "interrupted-config.json"),
    JSON.stringify({
      workspaceId: workspace.id,
      planId: plan.id,
      requestId: "interrupted-original",
      requestSha256: preview.requestSha256,
      requestBytes: preview.requestBytes,
      selection,
    }),
  );
  const source = import.meta.url.endsWith(".ts"),
    childPath = fileURLToPath(
      new URL(
        `./fixtures/import-interrupted-child.${source ? "ts" : "js"}`,
        import.meta.url,
      ),
    ),
    loader = fileURLToPath(
      new URL("../../../../node_modules/tsx/dist/loader.mjs", import.meta.url),
    );
  const child = spawn(
    process.execPath,
    [...(source ? ["--import", loader] : []), childPath, directory, phase],
    { cwd: directory, stdio: ["ignore", "ignore", "pipe"] },
  );
  let errors = "";
  child.stderr?.on("data", (value) => {
    errors = (errors + String(value)).slice(-16384);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("close", () => resolve());
    child.once("error", reject);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  });
  const readyPath = join(directory, "interrupted-ready.json"),
    deadline = Date.now() + 15000;
  while (!existsSync(readyPath)) {
    assert.equal(child.exitCode, null, errors);
    assert.equal(child.signalCode, null, errors);
    assert.ok(
      Date.now() < deadline,
      errors || "Original native boundary was not reached",
    );
    await pause(10);
  }
  const boundary = JSON.parse(readFileSync(readyPath, "utf8")) as Boundary;
  assert.equal(boundary.phase, phase);
  child.kill("SIGKILL");
  await exited;
  assert.equal(child.signalCode, "SIGKILL");
  const actualCallsPath = join(directory, "actual-provider-calls.jsonl"),
    calls = existsSync(actualCallsPath)
      ? readFileSync(actualCallsPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(
            (value) =>
              JSON.parse(value) as {
                owner: { generationId: string; attemptId: string };
                sha256: string;
                bytes: number;
              },
          )
      : [];
  assert.equal(calls.length, phase === "prepared" ? 0 : 1);
  assert.deepEqual(rows(dbPath).generations, [boundary.generation]);
  assert.deepEqual(rows(dbPath).attempts, [boundary.attempt]);
  // This is the dead original database. Opening Engine here would invalidate the importer-before-frontier assertion.
  const archive = await exportEngineArchive({
    dbPath,
    artifactDir,
    destination: join(directory, "archive"),
  });
  validateEngineArchive({ directory: archive.directory });
  assert.deepEqual(rows(dbPath).generations, [boundary.generation]);
  assert.deepEqual(rows(dbPath).attempts, [boundary.attempt]);
  const imported = await importEngineArchive({
    directory: archive.directory,
    destination: join(directory, "clone"),
  });
  const importedRows = rows(imported.dbPath),
    engine = createEngine({
      ...options,
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
    });
  engines.add(engine);
  return {
    root,
    directory,
    workspace,
    boundary,
    calls,
    archive,
    imported,
    dbPath,
    importedRows,
    engine,
    replay: () => replay,
    reopen() {
      const current = createEngine({
        ...options,
        dbPath: imported.dbPath,
        artifactDir: imported.artifactDir,
      });
      engines.add(current);
      return current;
    },
    assertNoReplay() {
      assert.equal(replay, 0);
      assert.equal(existsSync(join(root, "MEMORY.md")), false);
      assert.equal(existsSync(join(directory, "unexpected-coding.log")), false);
      assert.equal(
        existsSync(join(directory, "unexpected-cleanup.log")),
        false,
      );
      const afterCalls = existsSync(actualCallsPath)
        ? readFileSync(actualCallsPath, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean).length
        : 0;
      assert.equal(afterCalls, calls.length);
    },
  };
}

for (const phase of ["prepared", "streaming"] as const)
  test(
    `actual SIGKILL at host generation ${phase} imports interrupted owner BEFORE frontier pins and explicit recovery never replays producer`,
    { skip: process.platform === "win32", timeout: 25000 },
    async (t) => {
      const f = await fixture(t, phase),
        { engine, workspace, boundary, importedRows } = f;
      assert.equal(boundary.generation.state, phase);
      assert.equal(boundary.attempt.state, phase);
      assert.equal(boundary.attempt.streamDone, false);
      assert.equal(boundary.attempt.cleanup, null);
      if (phase === "streaming") {
        assert.equal(f.calls[0]!.owner.generationId, boundary.generation.id);
        assert.equal(f.calls[0]!.owner.attemptId, boundary.attempt.id);
        assert.equal(f.calls[0]!.sha256, boundary.attempt.exactDispatchSha256);
        assert.equal(f.calls[0]!.bytes, boundary.attempt.exactDispatchBytes);
        assert.ok(boundary.attempt.outputBytes > 0);
      }
      const before = engine.getWorkspaceKnowledgeGeneration(
          workspace.id,
          boundary.generation.id,
        ),
        state = phase === "prepared" ? "cancelled" : "uncertain";
      assert.equal(before.generation.state, state);
      assert.equal(before.attempt!.state, state);
      assert.equal(before.candidate, null);
      assert.equal(before.generation.id, boundary.generation.id);
      assert.equal(before.attempt!.output, boundary.attempt.output);
      assert.equal(before.attempt!.outputSha256, boundary.attempt.outputSha256);
      assert.deepEqual(before.attempt!.usage, boundary.attempt.usage);
      assert.equal(before.attempt!.cleanup!.confirmed, phase === "prepared");
      assert.equal(
        before.attempt!.cleanup!.method,
        phase === "prepared" ? "not-dispatched" : "unknown",
      );
      assert.deepEqual(importedRows.generations, [before.generation]);
      assert.deepEqual(importedRows.attempts, [before.attempt]);
      assert.deepEqual(importedRows.candidates, []);
      assert.deepEqual(importedRows.production, [0, 0, 0, 0, 0]);
      const frontier = importedRows
        .frontiers[0] as unknown as KnowledgeImportFrontier;
      assert.equal(
        frontier.sourcePrimaryLogicalSha256,
        f.archive.manifest.databases.find(
          (database) => database.role === "primary",
        )!.logicalHash,
      );
      assert.equal(frontier.archiveSha256, f.archive.manifestSha256);
      assert.equal(frontier.originalBinding!.root, f.root);
      if (phase === "streaming")
        assert.ok(
          frontier.uncertainties.some(
            (pin) =>
              pin.kind === "generation" &&
              pin.id === before.generation.id &&
              pin.sha256 === before.generation.sha256,
          ),
        );
      else assert.deepEqual(frontier.uncertainties, []);
      const ack = engine.previewWorkspaceKnowledgeImportAcknowledgment({
        workspaceId: workspace.id,
      });
      await engine.acknowledgeWorkspaceKnowledgeImport({
        workspaceId: workspace.id,
        requestId: "explicit-import-ack",
        approved: true,
        preview: ack,
      });
      const resume = engine.previewWorkspaceKnowledgeImportRecovery({
        workspaceId: workspace.id,
      });
      if (phase === "streaming") {
        const lockPath = `${f.imported.dbPath}.effects.sqlite`,
          foreign = acquireExecutionLock(lockPath);
        try {
          const marker = inspectExecutionLock(lockPath),
            markerBytes = readFileSync(lockPath),
            decisions = rows(f.imported.dbPath).decisions;
          await assert.rejects(
            engine.resumeWorkspaceKnowledgeImport({
              workspaceId: workspace.id,
              requestId: "foreign-marker-denied",
              approved: true,
              preview: resume,
            }),
            (error) => error instanceof EngineError,
          );
          assert.deepEqual(inspectExecutionLock(lockPath), marker);
          assert.deepEqual(readFileSync(lockPath), markerBytes);
          assert.deepEqual(rows(f.imported.dbPath).decisions, decisions);
        } finally {
          foreign.release(true);
        }
      }
      const original =
        phase === "streaming"
          ? engine.previewWorkspaceKnowledgeImportRecovery({
              workspaceId: workspace.id,
            })
          : resume;
      const recovered = await engine.resumeWorkspaceKnowledgeImport({
        workspaceId: workspace.id,
        requestId: "explicit-import-resume",
        approved: true,
        preview: original,
      });
      assert.equal(recovered.frontier.head.state, "resumed");
      assert.equal(recovered.decision.frontierSha256, frontier.sha256);
      const after = engine.getWorkspaceKnowledgeGeneration(
        workspace.id,
        boundary.generation.id,
      );
      assert.deepEqual(after.generation, before.generation);
      assert.deepEqual(after.attempt, before.attempt);
      assert.equal(after.candidate, null);
      assert.equal(after.executionBlocked, false);
      const stable = rows(f.imported.dbPath);
      assert.deepEqual(stable.generations, importedRows.generations);
      assert.deepEqual(stable.attempts, importedRows.attempts);
      assert.deepEqual(stable.barriers, importedRows.barriers);
      assert.deepEqual(stable.candidates, []);
      assert.deepEqual(stable.production, importedRows.production);
      assert.equal(knowledgeHash(frontier), knowledgeHash(stable.frontiers[0]));
      assert.equal(stable.decisions.length, 2);
      assert.deepEqual(rows(f.dbPath).generations, [boundary.generation]);
      assert.deepEqual(rows(f.dbPath).attempts, [boundary.attempt]);
      const archiveAfter = validateEngineArchive({
        directory: f.archive.directory,
      });
      assert.equal(archiveAfter.manifestSha256, f.archive.manifestSha256);
      assert.equal(
        archiveAfter.manifest.databases.find(
          (database) => database.role === "primary",
        )!.logicalHash,
        frontier.sourcePrimaryLogicalSha256,
      );
      f.assertNoReplay();
      await engine.close();
      const reopened = f.reopen(),
        history = reopened.getWorkspaceKnowledgeGeneration(
          workspace.id,
          boundary.generation.id,
        );
      assert.deepEqual(history.generation, before.generation);
      assert.deepEqual(history.attempt, before.attempt);
      assert.equal(history.candidate, null);
      assert.equal(history.executionBlocked, false);
      f.assertNoReplay();
    },
  );
