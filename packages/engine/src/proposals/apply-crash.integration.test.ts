import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectExecutionLock } from "../tools/command/execution-lock.js";
import type {
  ProposalApplyOwner,
  ProposalApplyCheckpoint,
  ProposalApplyGuard,
  ProposalApplyReceipt,
  ProposalApplyHistory,
} from "./apply-types.js";
import {
  AFTER,
  BEFORE,
  CREATED,
  SECOND_AFTER,
  SECOND_BEFORE,
  api,
  applyFixture,
  nativeRows,
  readDb,
} from "./fixtures/apply.js";

const here = dirname(fileURLToPath(import.meta.url)),
  loader = resolve(here, "../../../../node_modules/tsx/dist/loader.mjs"),
  childPath = join(
    here,
    `fixtures/apply-crash-child${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
  );
interface Evidence {
  boundary: string;
  pid: number;
  owner: ProposalApplyOwner;
  checkpoint: ProposalApplyCheckpoint | null;
  receipt: ProposalApplyReceipt | null;
  guard: ProposalApplyGuard | null;
  lock: { status: string };
  first: string;
  second: string;
}
for (const boundary of [
  "prepared",
  "reserved",
  "acquired",
  "dispatched",
  "written",
  "checkpointed",
  "released",
  "settled",
] as const)
  test(
    `actual SIGKILL after original apply ${boundary} preserves exact frontier and never replays filesystem producer`,
    { skip: process.platform === "win32" },
    async (t) => {
      const f = await applyFixture(t);
      await f.stage();
      const immutable = nativeRows(f.dbPath, [
        "proposal_revisions",
        "proposal_blobs",
      ]);
      await f.engine.close();
      const readyPath = join(f.base, "atomic-ready.json"),
        child = spawn(
          process.execPath,
          [
            "--import",
            loader,
            childPath,
            f.dbPath,
            f.artifactDir,
            f.workspace.id,
            "actual-apply-set",
            boundary,
            readyPath,
          ],
          { cwd: f.root, stdio: ["ignore", "pipe", "pipe"] },
        );
      let errors = "",
        output = "",
        exited = false;
      child.stderr.on("data", (bytes) => (errors += String(bytes)));
      child.stdout.on("data", (bytes) => (output += String(bytes)));
      const exit = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((done, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          exited = true;
          done({ code, signal });
        });
      });
      t.after(() => {
        if (!exited) child.kill("SIGKILL");
      });
      const deadline = Date.now() + 12_000;
      try {
        while (!existsSync(readyPath)) {
          assert.equal(exited, false, errors + output);
          assert.ok(
            Date.now() < deadline,
            "No actual boundary proof before fixture deadline: " +
              errors +
              output,
          );
          await new Promise((r) => setTimeout(r, 10));
        }
      } catch (error) {
        child.kill("SIGKILL");
        await exit;
        throw error;
      }
      const evidence = JSON.parse(readFileSync(readyPath, "utf8")) as Evidence;
      assert.equal(evidence.boundary, boundary);
      assert.equal(evidence.pid, child.pid);
      assert.equal(child.kill("SIGKILL"), true);
      const outcome = await exit;
      assert.equal(outcome.signal, "SIGKILL", errors + output);
      assert.throws(
        () => process.kill(evidence.pid, 0),
        (error) =>
          error instanceof Error && "code" in error && error.code === "ESRCH",
      );
      const beforeReopen = readDb(f.dbPath, (db) =>
        JSON.parse(
          String(
            db
              .prepare("SELECT data FROM proposal_apply_owners WHERE id=?")
              .get(evidence.owner.id)!.data,
          ),
        ),
      ) as ProposalApplyOwner;
      assert.equal(beforeReopen.sha256, evidence.owner.sha256);
      const reopened = f.reopen(),
        history = api<ProposalApplyHistory>(
          reopened,
          "getProposalApply",
          f.workspace.id,
          evidence.owner.id,
        );
      assert.equal(
        history.owner.state,
        boundary === "prepared"
          ? "cancelled"
          : boundary === "settled"
            ? "completed"
            : "uncertain",
      );
      assert.deepEqual(history.checkpoint, evidence.checkpoint);
      assert.deepEqual(history.receipt, evidence.receipt);
      assert.deepEqual(
        nativeRows(f.dbPath, ["proposal_revisions", "proposal_blobs"]),
        immutable,
      );
      if (["prepared", "reserved", "acquired", "dispatched"].includes(boundary))
        assert.deepEqual(
          [
            f.userBytes()["first.ts"],
            f.userBytes()["second.ts"],
            f.userBytes()["new/nested.ts"],
          ],
          [BEFORE, SECOND_BEFORE, null],
        );
      else if (boundary === "written") {
        assert.notEqual(f.userBytes()["first.ts"], BEFORE);
        assert.equal(f.userBytes()["first.ts"], evidence.first);
        assert.equal(f.userBytes()["second.ts"], SECOND_BEFORE);
        assert.equal(f.userBytes()["new/nested.ts"], null);
      } else
        assert.deepEqual(
          [
            f.userBytes()["first.ts"],
            f.userBytes()["second.ts"],
            f.userBytes()["new/nested.ts"],
          ],
          [AFTER, SECOND_AFTER, CREATED],
        );
      if (boundary === "prepared" || boundary === "settled") {
        assert.equal(
          reopened.store.hasUncertainWorkspace(f.workspace.id),
          false,
        );
        f.assertNoCoding();
        return;
      }
      assert.equal(history.owner.cleanupConfirmed, false);
      assert.equal(reopened.store.hasUncertainWorkspace(f.workspace.id), true);
      const raw = nativeRows(f.dbPath, [
        "proposal_apply_owners",
        "proposal_apply_checkpoints",
        "proposal_apply_receipts",
        "proposal_apply_execution_guards",
      ]);
      const bytes = f.userBytes(),
        recovery = f.recovery(reopened);
      assert.ok(recovery.owners.some((owner) => owner.id === history.owner.id));
      const ack = await f.acknowledge(recovery, reopened, `ack-${boundary}`);
      assert.equal(ack.operation, "acknowledge");
      assert.equal(reopened.store.hasUncertainWorkspace(f.workspace.id), true);
      assert.equal(
        inspectExecutionLock(`${f.dbPath}.effects.sqlite`).status,
        boundary === "reserved" ? "not_initialized" : "available",
      );
      const resumed = await f.resume(
        f.recovery(reopened),
        reopened,
        `resume-${boundary}`,
      );
      assert.equal(resumed.operation, "resume");
      assert.equal(reopened.store.hasUncertainWorkspace(f.workspace.id), false);
      assert.deepEqual(
        nativeRows(f.dbPath, [
          "proposal_apply_owners",
          "proposal_apply_checkpoints",
          "proposal_apply_receipts",
          "proposal_apply_execution_guards",
        ]),
        raw,
      );
      assert.deepEqual(f.userBytes(), bytes);
      f.assertNoCoding();
    },
  );
