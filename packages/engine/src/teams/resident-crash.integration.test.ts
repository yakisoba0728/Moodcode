import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createEngine } from "../engine.js";
import { failure } from "./fixtures/engine-team.js";
import type { ProviderAdapter } from "../ports.js";
const here = dirname(fileURLToPath(import.meta.url)),
  fixture = join(
    here,
    `fixtures/resident-crash-child${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
  ),
  loader = resolve(here, "../../../../node_modules/tsx/dist/loader.mjs");
for (const boundary of [
  "dispatched",
  "input-accepted",
  "ack",
  "child-completed",
  "board-committed",
])
  test(
    `actual SIGKILL resident ${boundary} retains durable child/admission/ACK history but never rebinds or replays`,
    { skip: process.platform === "win32", timeout: 15000 },
    async (t) => {
      const base = mkdtempSync(join(tmpdir(), "moodcode-resident-parent-")),
        ready = join(base, "ready.json");
      const child = spawn(process.execPath, ["--import", loader, fixture], {
        cwd: here,
        env: {
          ...process.env,
          NODE_TEST_CONTEXT: undefined,
          MOODCODE_RESIDENT_READY: ready,
          MOODCODE_RESIDENT_BOUNDARY: boundary,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "",
        exited = false;
      child.stdout.on("data", (b) => (output += b));
      child.stderr.on("data", (b) => (output += b));
      const closed = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => {
          exited = true;
          resolve();
        });
      });
      let sourceBase = "";
      t.after(async () => {
        if (!exited) child.kill("SIGKILL");
        await closed;
        if (sourceBase) rmSync(sourceBase, { recursive: true, force: true });
        rmSync(base, { recursive: true, force: true });
      });
      const end = Date.now() + 10000;
      while (!existsSync(ready)) {
        assert.equal(exited, false, output);
        assert.ok(Date.now() < end, output);
        await new Promise((r) => setTimeout(r, 5));
      }
      const proof = JSON.parse(readFileSync(ready, "utf8"));
      sourceBase = proof.base;
      assert.equal(proof.pid, child.pid);
      child.kill("SIGKILL");
      await closed;
      const inspect = (file: string, sql: string) => {
        const d = new DatabaseSync(file, { readOnly: true });
        try {
          return d.prepare(sql).all();
        } finally {
          d.close();
        }
      };
      const rootBefore = inspect(
          proof.dbPath,
          "SELECT * FROM team_delivery_receipts ORDER BY id",
        ),
        childFile = proof.storage.binding.physical.database.path,
        inputs = inspect(childFile, "SELECT * FROM session_inputs ORDER BY id"),
        runs = inspect(childFile, "SELECT * FROM runs ORDER BY id");
      assert.equal(
        rootBefore.length,
        boundary === "ack" ||
          boundary === "child-completed" ||
          boundary === "board-committed"
          ? 1
          : 0,
      );
      assert.equal(runs.length, boundary === "dispatched" ? 1 : 2);
      assert.equal(inputs.length, boundary === "dispatched" ? 1 : 2);
      let providers = 0;
      const provider: ProviderAdapter = {
        id: "actual-native-team-fixture",
        async *streamTurn() {
          providers++;
          yield { type: "finish", reason: "stop" };
        },
      };
      const engine = createEngine({
        dbPath: proof.dbPath,
        artifactDir: proof.artifactDir,
        providers: [provider],
        teams: true,
        teamModelTools: true,
        residentTeams: true,
      });
      t.after(() => engine.close());
      const record = engine.inspectResidentChildTask(
        proof.sessionId,
        proof.taskId,
      )!;
      assert.equal(record.state, "uncertain");
      assert.equal(
        engine.children.tasks.get(proof.sessionId, proof.taskId).state,
        "uncertain",
      );
      assert.throws(
        () => engine.children.describeTeamOwner(proof.sessionId, proof.taskId),
        failure("TEAM_OWNER_UNAVAILABLE"),
      );
      assert.deepEqual(
        inspect(childFile, "SELECT * FROM session_inputs ORDER BY id"),
        inputs,
      );
      assert.deepEqual(
        inspect(
          proof.dbPath,
          "SELECT * FROM team_delivery_receipts ORDER BY id",
        ),
        rootBefore,
      );

      if (boundary === "board-committed") {
        assert.equal(
          engine.getTeamTask(proof.workspaceId, proof.teamId, "crash-board")
            ?.state,
          "claimed",
        );
        assert.equal(
          inspect(
            proof.dbPath,
            "SELECT json_extract(data,'$.state') state FROM session_documents WHERE kind GLOB 'team.workflow.*'",
          )[0]?.state,
          "submitted",
        );
        const nativeTool = inspect(
          childFile,
          "SELECT state FROM tools WHERE json_extract(data,'$.name')='submit_team_task'",
        )[0];
        assert.equal(
          nativeTool?.state,
          "running",
          "board result was durable before genuine native Tool completion",
        );
      }
      assert.equal(providers, 0);
      await engine.close();
    },
  );
