import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { lifetimeFixture } from "./fixtures/command-lifetime.js";
import { jobUntil } from "./fixtures/job.js";
import { createEngine } from "../engine.js";
import { inspectExecutionLock } from "../tools/command/execution-lock.js";
const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 20000,
};
for (const boundary of ["transfer", "input-ack"] as const)
  test(
    `actual Root SIGKILL after ${boundary} preserves one native spawn, guardian cleanup and no owner reconstruction/replay`,
    posix,
    async (t) => {
      const f = await lifetimeFixture(t);
      await f.engine.close();
      const script = join(f.base, "crash-lifetime.mjs"),
        ready = join(f.base, "ready.json");
      const engineUrl = new URL(
        import.meta.url.endsWith(".ts") ? "../engine.ts" : "../engine.js",
        import.meta.url,
      ).href;
      const command = f.engine.readCommandLifetimePreview;
      void command;
      const quoted = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
      const peerCommand = `exec ${quoted(process.execPath)} ${quoted(join(f.root, "lifetime.mjs"))}`;
      writeFileSync(
        script,
        `import{writeFileSync,renameSync}from'node:fs';import{createEngine}from${JSON.stringify(engineUrl)};const engine=createEngine({dbPath:${JSON.stringify(f.dbPath)},artifactDir:${JSON.stringify(f.configuration.artifactDir)},jobs:true,hostCommands:true,commandLifetimes:true});const preview=await engine.previewCommandLifetime({workspaceId:${JSON.stringify(f.workspace.id)},sessionId:${JSON.stringify(f.session.id)},command:${JSON.stringify(peerCommand)},mode:'foreground',limits:{maxDurationMs:10000,maxOutputBytes:65536}});const start=await engine.startCommandLifetime({workspaceId:${JSON.stringify(f.workspace.id)},requestId:'actual-crash-${boundary}',preview,fingerprint:engine.readCommandLifetimePreview(preview).fingerprint,approved:true});const transfer=engine.previewCommandLifetimeTransfer({workspaceId:start.workspaceId,jobId:start.jobId,mode:'background'});engine.transferCommandLifetime({workspaceId:start.workspaceId,requestId:'actual-transfer',preview:transfer,fingerprint:engine.readCommandLifetimeTransfer(transfer).fingerprint,approved:true});${boundary === "input-ack" ? `const input=engine.previewCommandLifetimeInput({workspaceId:start.workspaceId,jobId:start.jobId,data:'ACTUAL_CRASH_ONCE\\n'});await engine.writeCommandLifetimeInput({workspaceId:start.workspaceId,requestId:'actual-input',preview:input,fingerprint:engine.readCommandLifetimeInputPreview(input).fingerprint,approved:true});` : ""}writeFileSync(${JSON.stringify(ready + ".tmp")},JSON.stringify({rootPid:process.pid,jobId:start.jobId,physical:start.physical}));renameSync(${JSON.stringify(ready + ".tmp")},${JSON.stringify(ready)});process.kill(process.pid,'SIGSTOP');`,
      );
      const loader = fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "../../../../node_modules/tsx/dist/loader.mjs"
            : "../../../../node_modules/tsx/dist/loader.mjs",
          import.meta.url,
        ),
      );
      const child = spawn(process.execPath, ["--import", loader, script], {
        cwd: f.root,
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let errors = "";
      child.stderr.on("data", (b) => (errors += String(b)));
      t.after(() => {
        try {
          child.kill("SIGCONT");
          child.kill("SIGKILL");
        } catch {}
      });
      await jobUntil(() => {
        assert.equal(child.exitCode, null, errors);
        return existsSync(ready);
      }, "Actual child atomic ready absent");
      const original = JSON.parse(readFileSync(ready, "utf8")) as {
        rootPid: number;
        jobId: string;
        physical: { groupPid: number; supervisorPid: number; epoch: string };
      };
      assert.equal(original.rootPid, child.pid);
      process.kill(original.physical.groupPid, 0);
      const closed = new Promise<void>((yes) =>
        child.once("close", () => yes()),
      );
      child.kill("SIGKILL");
      await closed;
      await jobUntil(() => {
        try {
          process.kill(original.physical.groupPid, 0);
          return false;
        } catch (e) {
          return (e as NodeJS.ErrnoException).code === "ESRCH";
        }
      }, "Actual guardian did not clean the group after Root SIGKILL");
      await jobUntil(
        () =>
          inspectExecutionLock(f.dbPath + ".effects.sqlite").status ===
          "available",
        "Actual supervisor has not released its original effects lock",
      );
      const reopened = createEngine({
        ...f.configuration,
        commandLifetimes: true,
      });
      f.engines.add(reopened);
      const records = reopened.inspectCommandLifetimes(f.workspace.id);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.state, "uncertain");
      assert.deepEqual(
        structuredClone(records[0]!.physical),
        original.physical,
      );
      assert.equal(records[0]!.stdinSeq, boundary === "input-ack" ? 1 : 0);
      assert.throws(
        () =>
          reopened.previewCommandLifetimeTransfer({
            workspaceId: f.workspace.id,
            jobId: original.jobId,
            mode: "foreground",
          }),
        { code: "COMMAND_LIFETIME_OWNER_UNAVAILABLE" },
      );
      assert.throws(
        () => reopened.coordinator.assertWorkspaceAvailable(f.workspace.id),
        { code: "CLEANUP_PENDING" },
      );
      const db = new DatabaseSync(f.dbPath, { readOnly: true });
      try {
        assert.equal(
          db
            .prepare(
              "SELECT count(*) n FROM session_events WHERE type='host.command.process'",
            )
            .get()!.n,
          1,
        );
        assert.equal(db.prepare("SELECT count(*) n FROM runs").get()!.n, 0);
      } finally {
        db.close();
      }
      assert.equal(f.providerCalls.length, 0);
    },
  );
