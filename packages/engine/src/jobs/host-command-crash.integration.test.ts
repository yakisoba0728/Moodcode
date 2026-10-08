import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import { inspectExecutionLock } from "../tools/command/execution-lock.js";
import { jobFixture, jobUntil } from "./fixtures/job.js";
const quote = (x: string) => `'${x.replaceAll("'", "'\\''")}'`;
const loader = fileURLToPath(
  new URL("../../../../node_modules/tsx/dist/loader.mjs", import.meta.url),
);
const sourceTest = import.meta.url.endsWith(".ts");
for (const phase of ["before-approval-commit", "approved", "running", "closed"])
  test(
    `actual SIGKILL at ${phase} preserves native independent command truth without source replay`,
    {
      skip: !["darwin", "linux", "freebsd"].includes(process.platform),
      timeout: 25000,
    },
    async (t) => {
      const f = await jobFixture(t, {
        createTerminal: false,
        engine: { hostCommands: true },
      });
      await f.engine.close();
      const marker = join(f.root, "crash-host.pid"),
        script = join(f.root, "crash-host.mjs"),
        ready = join(f.base, "ready.json");
      writeFileSync(
        script,
        `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},String(process.pid));process.stdout.write('ACTUAL_CRASH_HOST\\n');${phase === "closed" ? "setTimeout(()=>process.exit(0),30);" : "setInterval(()=>{},100);"}`,
      );
      const options = join(f.base, "options.json");
      writeFileSync(
        options,
        JSON.stringify({
          dbPath: f.dbPath,
          artifactDir: f.artifactDir,
          workspaceId: f.workspace.id,
          sessionId: f.session.id,
          command: `${quote(process.execPath)} ${quote(script)}`,
          phase,
          ready,
        }),
      );
      const child = fork(
        fileURLToPath(
          new URL(
            `./fixtures/crash-host-command.${sourceTest ? "ts" : "js"}`,
            import.meta.url,
          ),
        ),
        [options],
        {
          execArgv: sourceTest ? ["--import", loader] : [],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
      const gone = new Promise<void>((resolve, reject) => {
        child.once("exit", () => resolve());
        child.once("error", reject);
      });
      t.after(async () => {
        child.kill("SIGCONT");
        child.kill("SIGKILL");
        await gone;
      });
      await jobUntil(
        () => existsSync(ready),
        `Actual crash boundary ${phase} missing: ${stderr}`,
      );
      assert.equal(JSON.parse(readFileSync(ready, "utf8")).phase, phase);
      child.kill("SIGKILL");
      await gone;
      if (existsSync(marker)) {
        const pid = Number(readFileSync(marker, "utf8"));
        await jobUntil(() => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (e) {
            return (e as NodeJS.ErrnoException).code === "ESRCH";
          }
        }, "Actual parent-loss command was not cleaned");
      } else assert.notEqual(phase, "closed");
      await jobUntil(() => {
        const lock = inspectExecutionLock(f.dbPath + ".effects.sqlite");
        return lock.status === "not_initialized" || lock.status === "available";
      }, "Actual parent-loss supervisor has not released the physical execution lock");
      const reopened = createEngine({
        ...f.configuration,
        hostCommands: false,
      });
      f.engines.add(reopened);
      const records = reopened.inspectHostCommands(f.workspace.id);
      if (phase === "before-approval-commit") {
        assert.deepEqual(records, []);
        assert.equal(existsSync(marker), false);
      } else if (phase === "closed") {
        assert.equal(records.length, 1);
        assert.equal(records[0]!.state, "completed");
        assert.equal(records[0]!.completion?.outcome.cleanupConfirmed, true);
      } else {
        assert.equal(records.length, 1);
        assert.equal(records[0]!.state, "uncertain");
        assert.throws(
          () =>
            reopened.coordinator.assertWorkspaceCleanupConfirmed(
              f.workspace.id,
            ),
          (e: unknown) =>
            e instanceof EngineError && e.code === "CLEANUP_PENDING",
        );
        if (phase === "approved") assert.equal(existsSync(marker), false);
      }
      assert.equal(reopened.store.getSnapshot(f.session.id).runs.length, 0);
      assert.equal(f.providerCalls.length, 0);
      assert.throws(() =>
        reopened.captureHostCommandOutput({
          workspaceId: f.workspace.id,
          jobId: records[0]?.jobId ?? "missing",
        }),
      );
    },
  );
