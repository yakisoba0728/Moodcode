import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEngine } from "../../engine.js";
import { inspectExecutionLock } from "../../tools/command/execution-lock.js";
import type { ProviderAdapter } from "../../ports.js";
import { FileKnowledgePublicationHost } from "../file-publication-fs.js";
import type { KnowledgeFilePublicationRecord } from "../file-publication-types.js";

const [dbPath, artifactDir, workspaceId, candidateId, boundary, targetPath] =
  process.argv.slice(2);
if (
  !dbPath ||
  !artifactDir ||
  !workspaceId ||
  !candidateId ||
  !targetPath ||
  !["prepared", "acquired", "dispatched", "applied", "completed"].includes(
    boundary ?? "",
  )
)
  throw new Error("Exact actual native fixture arguments required");
const provider: ProviderAdapter = {
  id: "file-publication-native-fixture",
  async *streamTurn() {
    throw new Error("Crash publication must never call coding producer");
  },
  async *streamGeneration() {
    throw new Error("Crash publication must never rerun native generation");
  },
};
const originalApply = FileKnowledgePublicationHost.prototype.apply;
if (boundary === "acquired")
  FileKnowledgePublicationHost.prototype.apply = async function (
    capture,
    input,
  ) {
    return originalApply.call(this, capture, {
      ...input,
      beforeEffect: () => {
        const markerPath = Reflect.get(engine, "executionLockPath");
        assert.equal(typeof markerPath, "string");
        const lock = inspectExecutionLock(markerPath as string);
        assert.equal(lock.status, "busy");
        const guard = db
          .prepare(
            "SELECT marker_owner_pid FROM knowledge_file_execution_guards WHERE publication_id=?",
          )
          .get(input.publicationId);
        assert.ok(guard);
        assert.equal(guard.marker_owner_pid, process.pid);
        process.stdout.write(`actual-acquired:${input.publicationId}\n`);
        process.kill(process.pid, "SIGKILL");
      },
    });
  };
if (boundary === "applied")
  FileKnowledgePublicationHost.prototype.apply = async function (
    capture,
    input,
  ) {
    const result = await originalApply.call(this, capture, input);
    assert.equal(result.state, "applied");
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.checkpoint.partial, false);
    process.stdout.write(`actual-applied:${input.publicationId}\n`);
    process.kill(process.pid, "SIGKILL");
    return result;
  };
const engine = createEngine({
  dbPath,
  artifactDir,
  providers: [provider],
  knowledgeGeneration: true,
  knowledgeFilePublication: true,
});
const db = Reflect.get(engine.store, "db");
assert.ok(db instanceof DatabaseSync);
const originalExec = db.exec,
  execute = originalExec.bind(db);
if (boundary !== "applied" && boundary !== "acquired")
  db.exec = (sql) => {
    execute(sql);
    if (sql.trim().toUpperCase() !== "COMMIT") return;
    const row = db
      .prepare(
        "SELECT data FROM knowledge_file_publications WHERE request_id=?",
      )
      .get("actual-file-crash-request");
    if (!row) return;
    const record = JSON.parse(
      String(row.data),
    ) as KnowledgeFilePublicationRecord;
    if (record.state !== boundary) return;
    if (boundary === "completed") {
      const workspace = engine.store.getWorkspace(workspaceId);
      assert.equal(
        readFileSync(join(workspace.root, targetPath), "utf8"),
        record.body,
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS n FROM knowledge_file_publication_receipts WHERE publication_id=?",
          )
          .get(record.id)!.n,
        1,
      );
    }
    process.stdout.write(`actual-${record.state}:${record.id}\n`);
    process.kill(process.pid, "SIGKILL");
  };
try {
  const preview = await engine.previewWorkspaceKnowledgeFilePublication({
    workspaceId,
    candidateId,
  });
  await engine.publishWorkspaceKnowledgeFile({
    workspaceId,
    requestId: "actual-file-crash-request",
    approved: true,
    preview,
  });
  throw new Error("Actual native crash boundary was not observed");
} finally {
  FileKnowledgePublicationHost.prototype.apply = originalApply;
  db.exec = originalExec;
  await engine.close();
}
