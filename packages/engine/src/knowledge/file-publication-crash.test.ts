import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  BODY,
  filePublicationFixture,
  invoke,
} from "./fixtures/file-publication.js";
import type {
  KnowledgeFilePublicationRecord,
  KnowledgeFilePublicationReceipt,
} from "./file-publication-types.js";

const here = dirname(fileURLToPath(import.meta.url));
// The source loader path is explicit, irrespective of the child's actual cwd.
const loader = resolve(here, "../../../../node_modules/tsx/dist/loader.mjs");
const childPath = join(
  here,
  `fixtures/file-publication-crash-child${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
);
for (const boundary of [
  "prepared",
  "acquired",
  "dispatched",
  "applied",
  "completed",
] as const)
  test(
    `actual SIGKILL after original file publication ${boundary} boundary preserves native state without effect replay`,
    { skip: process.platform === "win32" },
    async (t) => {
      const f = await filePublicationFixture(t),
        candidate = await f.candidate("MEMORY.md");
      await f.engine.close();
      const child = spawn(
        process.execPath,
        [
          "--import",
          loader,
          childPath,
          f.dbPath,
          join(f.base, "artifacts"),
          f.workspace.id,
          candidate.id,
          boundary,
          "MEMORY.md",
        ],
        { cwd: f.root, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "",
        errors = "";
      child.stdout.on("data", (bytes) => {
        output += String(bytes);
      });
      child.stderr.on("data", (bytes) => {
        errors += String(bytes);
      });
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      const outcome = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolveDone, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolveDone({ code, signal }));
      });
      clearTimeout(timer);
      assert.equal(outcome.signal, "SIGKILL", errors);
      assert.ok(output.includes(`actual-${boundary}:`), errors + output);
      assert.throws(
        () => process.kill(child.pid!, 0),
        (error) =>
          error instanceof Error && "code" in error && error.code === "ESRCH",
      );
      const db = new DatabaseSync(f.dbPath, { readOnly: true });
      let original: KnowledgeFilePublicationRecord;
      try {
        const row = db
          .prepare(
            "SELECT data FROM knowledge_file_publications WHERE request_id=?",
          )
          .get("actual-file-crash-request");
        assert.ok(row);
        original = JSON.parse(
          String(row.data),
        ) as KnowledgeFilePublicationRecord;
        assert.equal(
          original.state,
          boundary === "applied"
            ? "dispatched"
            : boundary === "acquired"
              ? "prepared"
              : boundary,
        );
      } finally {
        db.close();
      }
      const reopened = f.reopen(),
        recovered = invoke<KnowledgeFilePublicationRecord>(
          reopened,
          "getWorkspaceKnowledgeFilePublication",
          f.workspace.id,
          original.id,
        );
      assert.equal(
        recovered.state,
        boundary === "prepared"
          ? "cancelled"
          : boundary === "completed"
            ? "completed"
            : "uncertain",
      );
      if (
        boundary === "prepared" ||
        boundary === "acquired" ||
        boundary === "dispatched"
      )
        assert.equal(existsSync(join(f.root, "MEMORY.md")), false);
      else assert.equal(readFileSync(join(f.root, "MEMORY.md"), "utf8"), BODY);
      const receipt = invoke<KnowledgeFilePublicationReceipt | undefined>(
        reopened,
        "getWorkspaceKnowledgeFilePublicationReceipt",
        f.workspace.id,
        "actual-file-crash-request",
      );
      if (boundary === "completed") {
        assert.ok(receipt);
        assert.equal(receipt.publicationId, recovered.id);
        assert.equal(
          reopened.captureWorkspaceKnowledgeTarget(f.workspace.id, "MEMORY.md")
            .revision,
          1,
        );
      } else assert.equal(receipt, undefined);
      if (
        boundary === "acquired" ||
        boundary === "dispatched" ||
        boundary === "applied"
      )
        assert.equal(
          reopened.store.hasUncertainWorkspace(f.workspace.id),
          true,
        );
      assert.equal(f.generations.length, 1);
      f.assertNoCoding();
    },
  );
