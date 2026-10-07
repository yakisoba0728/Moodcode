import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
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
import type { JsonObject, Workspace } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import type { ProviderAdapter } from "../ports.js";
import {
  exportEngineArchive,
  importEngineArchive,
  validateEngineArchive,
} from "../storage/archive.js";
import { DB_VERSION } from "../storage/migrations.js";
import { validateKnowledgePublicationDatabase } from "./publication-archive-relations.js";
import { knowledgeHash } from "./validation.js";

async function fixture(t: TestContext) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-publication-archive-")),
    ),
    root = join(base, "repo"),
    dbPath = join(base, "engine.sqlite"),
    artifactDir = join(base, "artifacts");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  writeFileSync(join(root, "AGENTS.md"), "Host approved project memory.\n");
  writeFileSync(join(root, "source.ts"), "export const evidence = 1;\n");
  let calls = 0,
    coding = 0,
    body = "First exact native document.\n";
  const provider: ProviderAdapter = {
    id: "publication-archive-fixture",
    async *streamTurn() {
      coding++;
      throw new Error("Independent publication cannot invoke a coding turn");
    },
    streamGeneration() {
      calls++;
      return (async function* () {
        yield { type: "text.delta", delta: body } as const;
        yield { type: "usage", inputTokens: 8, outputTokens: 4 } as const;
        yield { type: "finish", reason: "stop" } as const;
      })();
    },
  };
  const options = {
    dbPath,
    artifactDir,
    providers: [provider],
    knowledgeGeneration: true,
    knowledgePublication: true,
  };
  const engine = createEngine(options),
    engines = new Set([engine]);
  t.after(async () => {
    for (const current of engines) await current.close().catch(() => {});
    rmSync(base, { recursive: true, force: true });
  });
  const response = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type: "workspace.open",
    payload: { path: root } as JsonObject,
  });
  assert.equal(response.ok, true);
  const workspace = response.result as unknown as Workspace;
  const trust = await engine.setWorkspaceTrust({
    workspaceId: workspace.id,
    requestId: "trust",
    expectedRevision: 0,
    decision: "allow",
    preview: engine.previewWorkspaceTrust(workspace.id, ["AGENTS.md"]),
  });
  let index = 0;
  async function publish(text = body) {
    body = text;
    const n = ++index,
      projection = engine.captureWorkspaceKnowledgeSources(workspace.id, [
        { kind: "file", path: "source.ts" },
      ]);
    const request = engine.previewWorkspaceKnowledgeGeneration({
      providerId: provider.id,
      modelId: "local",
      projection,
    });
    const plan = await engine.prepareWorkspaceKnowledgeGeneration({
      workspaceId: workspace.id,
      requestId: `plan-${n}`,
      expectedTrustRevision: trust.revision,
      projection,
      target: engine.captureWorkspaceKnowledgeDocumentTarget(
        workspace.id,
        "project.memory",
      ),
      providerId: provider.id,
      modelId: "local",
      requestSha256: request.requestSha256,
      requestBytes: request.requestBytes,
      maxOutputBytes: 1024,
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    });
    const generated = await engine.generateWorkspaceKnowledge({
      workspaceId: workspace.id,
      planId: plan.id,
      requestId: `generation-${n}`,
      projection,
    });
    assert.ok(generated.candidate);
    const preview = engine.previewWorkspaceKnowledgePublication({
      workspaceId: workspace.id,
      candidateId: generated.candidate.id,
    });
    return engine.publishWorkspaceKnowledge({
      workspaceId: workspace.id,
      requestId: `publish-${n}`,
      approved: true,
      preview,
    });
  }
  const first = await publish();
  return {
    base,
    root,
    dbPath,
    artifactDir,
    workspace,
    engine,
    engines,
    provider,
    first,
    publish,
    calls: () => calls,
    coding: () => coding,
  };
}

test("DB12 archive preserves actual publication/update/revoke history and receipts while import stays paused", async (t) => {
  const f = await fixture(t),
    second = await f.publish("Second exact native document.\n");
  const revoked = await f.engine.revokeWorkspaceKnowledge({
    workspaceId: f.workspace.id,
    requestId: "revoke-second",
    approved: true,
    preview: f.engine.previewWorkspaceKnowledgeRevocation({
      workspaceId: f.workspace.id,
      publicationId: second.publication.id,
    }),
  });
  assert.equal(revoked.document.revision, 3);
  assert.equal(revoked.document.status, "revoked");
  assert.equal(revoked.document.body, "");
  await f.engine.close();
  const archive = await exportEngineArchive({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
    destination: join(f.base, "archive"),
  });
  assert.equal(
    archive.manifest.databases.find((item) => item.role === "primary")!
      .schemaVersion,
    DB_VERSION,
  );
  validateEngineArchive({ directory: archive.directory });
  const imported = await importEngineArchive({
    directory: archive.directory,
    destination: join(f.base, "imported"),
  });
  const current = createEngine({
    dbPath: imported.dbPath,
    artifactDir: imported.artifactDir,
    providers: [f.provider],
    knowledgePublication: true,
  });
  f.engines.add(current);
  for (const committed of [f.first, second, revoked]) {
    const observed = current.getWorkspaceKnowledgePublication(
      f.workspace.id,
      committed.publication.id,
    );
    assert.equal(observed.publication.sha256, committed.publication.sha256);
    assert.equal(observed.document!.sha256, committed.document.sha256);
    assert.equal(observed.receipt!.sha256, committed.receipt.sha256);
    assert.equal(
      current.getWorkspaceKnowledgePublicationReceipt(
        f.workspace.id,
        committed.publication.requestId,
      )!.sha256,
      committed.receipt.sha256,
    );
  }
  assert.equal(
    current.getWorkspaceKnowledgeDocument(f.workspace.id, "project.memory")!
      .sha256,
    revoked.document.sha256,
  );
  assert.equal(
    current.listWorkspaceKnowledgePublications(f.workspace.id).items.length,
    3,
  );
  assert.equal(
    current.listWorkspaceKnowledgeDocumentRevisions(
      f.workspace.id,
      "project.memory",
    ).items.length,
    3,
  );
  assert.equal(
    current.workspaceKnowledge.getImportPause(f.workspace.id)!.state,
    "paused",
  );
  assert.throws(() =>
    current.previewWorkspaceKnowledgePublication({
      workspaceId: f.workspace.id,
      candidateId: f.first.publication.provenance.candidateId,
    }),
  );
  assert.equal(imported.executionResumed, false);
  assert.equal(f.calls(), 2);
  assert.equal(f.coding(), 0);
  assert.equal(existsSync(join(f.root, "project.memory")), false);
});

test("archive refuses an individually rehashed receipt that contradicts its actual publication", async (t) => {
  const f = await fixture(t);
  await f.engine.close();
  const db = new DatabaseSync(f.dbPath);
  try {
    const { sha256: _old, ...body } = f.first.receipt,
      changed = { ...body, requestSha256: "a".repeat(64) },
      receipt = { ...changed, sha256: knowledgeHash(changed) };
    db.prepare(
      "UPDATE knowledge_publication_receipts SET data=? WHERE id=?",
    ).run(JSON.stringify(receipt), receipt.id);
  } finally {
    db.close();
  }
  const destination = join(f.base, "invalid-receipt");
  await assert.rejects(
    exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination,
    }),
    { code: "ARCHIVE_KNOWLEDGE_INVALID" },
  );
  assert.equal(existsSync(destination), false);
  assert.equal(f.calls(), 1);
});

test("archive refuses a valid historical head substituted for the actual newer document revision", async (t) => {
  const f = await fixture(t);
  await f.publish("Newer exact native document.\n");
  await f.engine.close();
  const db = new DatabaseSync(f.dbPath);
  try {
    const head = f.first.head;
    db.prepare(
      "UPDATE workspace_document_heads SET revision=?,revision_id=?,publication_id=?,status=?,data=? WHERE id=?",
    ).run(
      head.revision,
      head.revisionId,
      head.publicationId,
      head.status,
      JSON.stringify(head),
      head.id,
    );
  } finally {
    db.close();
  }
  await assert.rejects(
    exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "regressed-head"),
    }),
    { code: "ARCHIVE_KNOWLEDGE_INVALID" },
  );
  assert.equal(f.calls(), 2);
});

test("publication graph rejects oversized rows before returning their body to JavaScript", async (t) => {
  const f = await fixture(t);
  await f.engine.close();
  const db = new DatabaseSync(f.dbPath);
  t.after(() => db.close());
  db.exec("PRAGMA ignore_check_constraints=ON");
  db.prepare("UPDATE knowledge_publications SET data=? WHERE id=?").run(
    "x".repeat(100000),
    f.first.publication.id,
  );
  let bodyQueries = 0;
  const original = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    if (/THEN data END AS data FROM knowledge_publications/u.test(sql))
      bodyQueries++;
    return original(sql);
  }) as typeof db.prepare;
  assert.throws(() => validateKnowledgePublicationDatabase(db, () => {}), {
    code: "KNOWLEDGE_PUBLICATION_RELATION_INVALID",
  });
  assert.equal(bodyQueries, 0);
});

test("publication archive validation preserves its caller cancellation instead of normalizing it as graph corruption", async (t) => {
  const f = await fixture(t);
  await f.engine.close();
  const db = new DatabaseSync(f.dbPath);
  t.after(() => db.close());
  const original = new Error("Exact caller cancellation");
  assert.throws(
    () =>
      validateKnowledgePublicationDatabase(db, () => {
        throw original;
      }),
    (error) => error === original,
  );
});
