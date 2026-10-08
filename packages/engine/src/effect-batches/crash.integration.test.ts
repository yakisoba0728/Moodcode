import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createEngine } from "../engine.js";
import { until } from "./fixtures/batch.js";
const phases = [
  "prepared",
  "before-write",
  "after-write",
  "peer-completed",
  "completed",
] as const;
for (const { phase, pausePublication } of [
  ...phases.map((phase) => ({ phase, pausePublication: false })),
  { phase: "after-write" as const, pausePublication: true },
])
  test(
    `actual Root SIGKILL ${phase}${pausePublication ? " after partial private readiness publication" : ""} preserves physical/native effect debt and dispatches no replay`,
    { skip: process.platform === "win32", timeout: 20000 },
    async (t) => {
      const dir = realpathSync(
        mkdtempSync(join(tmpdir(), "moodcode-effect-kill-")),
      );
      const child = spawn(
        process.execPath,
        [
          ...(import.meta.url.endsWith(".ts")
            ? [
                "--import",
                fileURLToPath(
                  new URL(
                    "../../../../node_modules/tsx/dist/loader.mjs",
                    import.meta.url,
                  ),
                ),
              ]
            : []),
          fileURLToPath(
            new URL(
              import.meta.url.endsWith(".ts")
                ? "./fixtures/crash.ts"
                : "./fixtures/crash.js",
              import.meta.url,
            ),
          ),
          dir,
          phase,
          ...(pausePublication ? ["pause-publication"] : []),
        ],
        {
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            TEMP: process.env.TEMP,
          },
        },
      );
      let stderr = "";
      child.stderr!.on(
        "data",
        (b) => (stderr = (stderr + String(b)).slice(-8192)),
      );
      let publicationPaused = false;
      child.on("message", (message) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "ready-publication-paused" &&
          "pid" in message &&
          message.pid === child.pid
        )
          publicationPaused = true;
      });
      let exited = false;
      let verified = false;
      const done = new Promise<void>((resolve) =>
        child.on("exit", () => {
          exited = true;
          resolve();
        }),
      );
      t.after(async () => {
        if (!exited) child.kill("SIGKILL");
        await done;
        if (verified) rmSync(dir, { recursive: true, force: true });
        else {
          writeFileSync(join(dir, "worker.stderr.log"), stderr, {
            mode: 0o600,
          });
          const readyPath = join(dir, "ready.json");
          if (existsSync(readyPath))
            writeFileSync(
              join(dir, "ready-observed.raw"),
              readFileSync(readyPath),
              { mode: 0o600 },
            );
          t.diagnostic(`Retained failed native crash fixture: ${dir}`);
        }
      });
      if (pausePublication) {
        await until(
          () => publicationPaused || exited,
          `Original private readiness publication missing: ${stderr}`,
        );
        assert.equal(exited, false, stderr);
        await until(
          () =>
            exited ||
            execFileSync("/bin/ps", ["-o", "stat=", "-p", String(child.pid)], {
              encoding: "utf8",
              timeout: 1000,
              maxBuffer: 4096,
            })
              .trim()
              .startsWith("T"),
          "Original child did not stop during private readiness publication",
        );
        assert.equal(exited, false, stderr);
        assert.equal(existsSync(join(dir, "ready.json")), false);
        const partial = readFileSync(join(dir, "ready.json.tmp"), "utf8");
        assert.ok(partial.length > 0);
        assert.throws(() => JSON.parse(partial), SyntaxError);
        assert.equal(child.kill("SIGCONT"), true);
      }
      await until(
        () => existsSync(join(dir, "ready.json")) || exited,
        `actual ${phase} boundary missing: ${stderr}`,
      );
      assert.equal(exited, false, stderr);
      const ready = JSON.parse(readFileSync(join(dir, "ready.json"), "utf8"));
      assert.equal(existsSync(join(dir, "ready.json.tmp")), false);
      assert.equal(ready.pid, child.pid);
      child.kill("SIGKILL");
      await done;
      let entries = 0;
      const engine = createEngine({
        dbPath: ready.dbPath,
        artifactDir: ready.artifactDir,
        providers: [
          {
            id: "effect-fixture",
            async *streamTurn() {
              entries++;
              throw new Error("No automatic replay");
            },
          },
        ],
      });
      t.after(() => engine.close());
      const r = engine.inspectEffectBatches(
        ready.workspaceId,
        ready.sessionId,
      )[0]!;
      assert.equal(r.state, phase === "completed" ? "completed" : "uncertain");
      assert.equal(entries, 0);
      assert.equal(
        engine.store.getSessionControl(ready.sessionId).paused,
        true,
      );
      assert.equal(
        readFileSync(join(dir, "repo", "a.txt"), "utf8"),
        ["after-write", "peer-completed", "completed"].includes(phase)
          ? "A"
          : "a",
      );
      if (phase === "peer-completed") {
        assert.equal(r.members[0]!.state, "completed");
        assert.equal(r.members[1]!.state, "uncertain");
        assert.equal(readFileSync(join(dir, "repo", "b.txt"), "utf8"), "b");
      }
      if (phase !== "completed")
        assert.equal(
          engine.store.hasUncertainWorkspace(ready.workspaceId),
          true,
        );
      await engine.close();
      const second = createEngine({
        dbPath: ready.dbPath,
        artifactDir: ready.artifactDir,
      });
      t.after(() => second.close());
      assert.equal(
        second.getEffectBatch(ready.sessionId, r.id)!.revision,
        r.revision,
      );
      await second.close();
      verified = true;
    },
  );
