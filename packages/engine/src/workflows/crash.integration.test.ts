import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { createEngine, type EngineOptions } from "../engine.js";
import type { ProviderAdapter } from "../ports.js";
import type { ChildTaskRecord } from "../child-tasks/index.js";
import type { ChildStorageRecord } from "../child-tasks/storage-binding.js";
import type { WorkflowInstanceRevision } from "./reducer.js";
import {
  invoke,
  readDatabase,
  workflowArchiveFixture,
} from "./fixtures/archive-workflow.js";

const here = dirname(fileURLToPath(import.meta.url)),
  loader = resolve(here, "../../../../node_modules/tsx/dist/loader.mjs"),
  childPath = join(
    here,
    `fixtures/crash-child${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
  );
type Row = Record<string, unknown>;
interface Evidence {
  readonly boundary: string;
  readonly pid: number;
  readonly instance: WorkflowInstanceRevision;
  readonly parent: { readonly runId: string };
  readonly task: ChildTaskRecord | null;
  readonly childStorage: ChildStorageRecord | null;
  readonly childRun: Row | null;
  readonly childTools: Row[];
  readonly childMirror: ChildStorageRecord | null;
  readonly revisions: Row[];
  readonly providerEntries: number;
}
function codingRows(file: string) {
  return readDatabase(file, (db) =>
    Object.fromEntries(
      [
        "inputs",
        "session_inputs",
        "runs",
        "provider_attempts",
        "tools",
        "checkpoints",
      ].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
      ]),
    ),
  );
}
function codingCounts(file: string) {
  return readDatabase(file, (db) =>
    Object.fromEntries(
      [
        "sessions",
        "inputs",
        "session_inputs",
        "runs",
        "provider_attempts",
        "tools",
        "checkpoints",
      ].map((table) => [
        table,
        db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
      ]),
    ),
  );
}
function fileIdentity(file: string) {
  const stat = statSync(file, { bigint: true });
  return {
    dev: stat.dev,
    ino: stat.ino,
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  };
}

for (const boundary of [
  "dispatch-intent",
  "child-admitted",
  "child-completed",
  "stage-settled",
] as const)
  test(
    `actual SIGKILL after original workflow ${boundary} preserves immutable history without replay, model dispatch or child lock cleanup`,
    { skip: process.platform === "win32", timeout: 25000 },
    async (t) => {
      const f = await workflowArchiveFixture(t);
      await f.engine.close();
      const readyPath = join(f.base, "workflow-atomic-ready.json"),
        processChild = spawn(
          process.execPath,
          [
            "--import",
            loader,
            childPath,
            f.dbPath,
            f.artifactDir,
            f.workspace.id,
            f.session.id,
            f.worktree.id,
            boundary,
            readyPath,
          ],
          { cwd: f.repository, stdio: ["ignore", "pipe", "pipe"] },
        );
      let output = "",
        exited = false;
      const collect = (bytes: Buffer) => {
        output = (output + bytes.toString("utf8")).slice(-32768);
      };
      processChild.stdout.on("data", collect);
      processChild.stderr.on("data", collect);
      const exit = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((done, reject) => {
        processChild.once("error", reject);
        processChild.once("exit", (code, signal) => {
          exited = true;
          done({ code, signal });
        });
      });
      t.after(async () => {
        if (!exited) processChild.kill("SIGKILL");
        await exit;
      });
      const deadline = Date.now() + 12000;
      while (!existsSync(readyPath)) {
        assert.equal(exited, false, output);
        assert.ok(
          Date.now() < deadline,
          "No original durable workflow boundary: " + output,
        );
        await new Promise((done) => setTimeout(done, 10));
      }
      const proof = JSON.parse(readFileSync(readyPath, "utf8")) as Evidence;
      assert.equal(proof.pid, processChild.pid);
      assert.equal(proof.boundary, boundary);
      assert.ok(proof.providerEntries >= 1);
      assert.equal(proof.instance.owner.runId, proof.parent.runId);
      assert.equal(proof.instance.owner.sessionId, f.session.id);
      assert.equal(
        proof.instance.stages[0]!.state,
        boundary === "stage-settled"
          ? "completed"
          : boundary === "child-completed"
            ? "running"
            : "dispatching",
      );
      const receipts = proof.revisions
        .filter((row) => row.kind === "transition")
        .map((row) => JSON.parse(String(row.data)) as Row);
      assert.equal(
        receipts.some((row) => row.operation === "prepare"),
        true,
      );
      assert.equal(
        receipts.some((row) => row.operation === "admit"),
        boundary === "child-completed" || boundary === "stage-settled",
      );
      assert.equal(
        receipts.some((row) => row.operation === "settle"),
        boundary === "stage-settled",
      );
      if (boundary === "dispatch-intent") {
        assert.equal(proof.task, null);
        assert.equal(proof.childStorage, null);
      } else {
        assert.ok(proof.task && proof.childStorage && proof.childRun);
        assert.equal(proof.childStorage.binding.phase, "admitted");
        assert.equal(proof.childMirror?.sha256, proof.childStorage.sha256);
        assert.deepEqual(
          proof.childMirror?.binding,
          proof.childStorage.binding,
        );
        assert.equal(
          proof.childStorage.binding.child.runId,
          proof.task.childRunId,
        );
        assert.equal(proof.childRun.id, proof.task.childRunId);
        assert.equal(
          proof.childStorage.binding.lineage.parentRunId,
          proof.instance.owner.runId,
        );
        assert.equal(proof.childStorage.binding.worktree.id, f.worktree.id);
        if (boundary === "child-admitted") {
          assert.equal(proof.instance.stages[0]!.child, null);
          assert.equal(proof.task.state, "running");
        } else {
          assert.equal(proof.task.state, "completed");
          assert.equal(proof.childRun.state, "completed");
          assert.equal(
            proof.childStorage.confirmedClose?.bindingSha256,
            proof.childStorage.sha256,
          );
          assert.equal(
            proof.instance.stages[0]!.child!.storageSha256,
            proof.childStorage.sha256,
          );
          assert.equal(proof.childTools.length, 1);
          const tool = JSON.parse(String(proof.childTools[0]!.data)) as Row;
          assert.equal(tool.name, "read_file");
          assert.equal(tool.state, "completed");
        }
      }
      if (boundary === "stage-settled") {
        assert.equal(proof.instance.state, "completed");
        assert.deepEqual(proof.instance.result, {
          observation: "Actual readonly crash child completed.",
        });
        assert.equal(
          receipts.find((row) => row.operation === "settle")?.afterSha256,
          proof.instance.sha256,
        );
      }
      processChild.kill("SIGKILL");
      assert.deepEqual(await exit, { code: null, signal: "SIGKILL" });
      const beforeCounts = codingCounts(f.dbPath),
        childFile = proof.childStorage?.binding.physical.database.path,
        childRows = childFile ? codingRows(childFile) : null,
        ownerFile = proof.childStorage?.binding.physical.owner.path,
        ownerIdentity = ownerFile ? fileIdentity(ownerFile) : null;
      let calls = 0;
      const provider: ProviderAdapter = {
        id: "actual-workflow-provider",
        async *streamTurn() {
          calls++;
          yield { type: "finish", reason: "stop" };
        },
      };
      const reopened = createEngine({
        ...f.configuration,
        workflows: false,
        providers: [provider],
      } as EngineOptions);
      f.engines.add(reopened);
      const history = invoke<WorkflowInstanceRevision>(
        reopened,
        "inspectWorkflow",
        f.workspace.id,
        proof.instance.instanceId,
      );
      assert.ok(history);
      assert.equal(
        history.state,
        boundary === "stage-settled" ? "completed" : "uncertain",
      );
      assert.deepEqual(history.owner, proof.instance.owner);
      assert.deepEqual(history.parameters, proof.instance.parameters);
      assert.deepEqual(history.worktrees, proof.instance.worktrees);
      assert.deepEqual(
        history.stages[0]!.child,
        proof.instance.stages[0]!.child,
      );
      const actualRows = readDatabase(f.dbPath, (db) =>
        db.prepare("SELECT * FROM workflow_revisions ORDER BY id").all(),
      );
      for (const row of proof.revisions)
        assert.deepEqual(
          { ...actualRows.find((item) => item.id === row.id) },
          row,
        );
      assert.equal(calls, 0);
      assert.deepEqual(codingCounts(f.dbPath), beforeCounts);
      if (childFile) assert.deepEqual(codingRows(childFile), childRows);
      if (ownerFile) assert.deepEqual(fileIdentity(ownerFile), ownerIdentity);
      await assert.rejects(
        async () =>
          invoke<Promise<unknown>>(reopened, "startWorkflowStage", {
            workspaceId: f.workspace.id,
            instanceId: history.instanceId,
            stageId: "plan",
            requestId: "no-crash-replay",
            expectedRevision: history.revision,
            approved: true,
          }),
        (error) => error instanceof EngineError,
      );
      await reopened.close();
      assert.equal(calls, 0);
      assert.deepEqual(codingCounts(f.dbPath), beforeCounts);
      if (childFile) assert.deepEqual(codingRows(childFile), childRows);
      if (ownerFile) assert.deepEqual(fileIdentity(ownerFile), ownerIdentity);
    },
  );
