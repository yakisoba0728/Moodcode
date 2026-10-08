import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createEngine } from "../engine.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { assertExecutionLockAvailable } from "../tools/command/execution-lock.js";
import { groupExists, cleanupGroup } from "../tools/command/process-control.js";
import { backendUntil } from "./fixtures/backend.js";
interface Ready {
  type: "ready";
  base: string;
  root: string;
  dbPath: string;
  artifactDir: string;
  logPath: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  peerPid: number;
  commandPid: number | null;
  commandGroupPid: number | null;
}
for (const mode of ["terminal-hold", "direct-write"])
  test(
    `actual SIGKILL at ${mode === "terminal-hold" ? "running terminal after ACK" : "write after actual Part/checkpoint before effect receipt"} preserves native unknown and paused import without replay`,
    { timeout: 25000 },
    async (t) => {
      const compiled = new URL("./fixtures/crash-effects.js", import.meta.url),
        source = new URL("./fixtures/crash-effects.ts", import.meta.url);
      const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
      const child = fork(existsSync(compiled) ? compiled : source, [mode], {
        env,
        execArgv: existsSync(compiled)
          ? []
          : [
              "--import",
              "/Users/yakisoba0728/Documents/GitHub/Moodcode/node_modules/tsx/dist/loader.mjs",
            ],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let ready: Ready | undefined,
        stderr = "";
      child.stderr?.on(
        "data",
        (bytes: Buffer) => (stderr = (stderr + bytes.toString()).slice(-8192)),
      );
      const engines = new Set<ReturnType<typeof createEngine>>();
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
        if (ready) {
          for (const pid of [ready.peerPid, ready.commandGroupPid])
            if (pid && groupExists(pid)) await cleanupGroup(pid);
          for (const engine of engines) await engine.close();
          rmSync(ready.base, { recursive: true, force: true });
        }
      });
      ready = await new Promise<Ready>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`actual fixture timeout ${stderr}`)),
          12000,
        );
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`fixture exited ${code}/${signal}: ${stderr}`));
        });
        child.on("message", (value) => {
          const packet = value as Ready | { type: "failed"; message: string };
          clearTimeout(timer);
          if (packet.type === "ready") resolve(packet);
          else reject(new Error(packet.message));
        });
      });
      const logs = readFileSync(ready.logPath, "utf8");
      assert.equal(groupExists(ready.peerPid), true);
      if (ready.commandPid) {
        assert.ok(
          Number.isSafeInteger(ready.commandPid) && ready.commandPid > 0,
        );
        assert.ok(
          Number.isSafeInteger(ready.commandGroupPid) &&
            ready.commandGroupPid! > 0,
        );
        assert.doesNotThrow(() => process.kill(ready!.commandPid!, 0));
        assert.equal(groupExists(ready.commandGroupPid!), true);
      }
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      await backendUntil(
        () =>
          !groupExists(ready!.peerPid) &&
          (!ready!.commandGroupPid || !groupExists(ready!.commandGroupPid)),
        "actual original peer/command groups not cleaned",
        8000,
      );
      if (ready.commandPid) {
        await backendUntil(
          () => {
            try {
              process.kill(ready!.commandPid!, 0);
              return false;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === "ESRCH";
            }
          },
          "actual command PID was not cleaned",
          8000,
        );
      }
      if (ready.commandPid)
        await backendUntil(
          () => {
            try {
              assertExecutionLockAvailable(`${ready!.dbPath}.effects.sqlite`);
              return true;
            } catch {
              return false;
            }
          },
          "native command effect lock not released",
          8000,
        );
      const engine = createEngine({
        dbPath: ready.dbPath,
        artifactDir: ready.artifactDir,
        providers: [],
      });
      engines.add(engine);
      const effects = engine.inspectAgentBackendEffects(ready.workspaceId);
      if (ready.commandGroupPid)
        assert.equal(
          engine.inspectOwnedCommandJobs(ready.workspaceId)[0]?.groupPid,
          ready.commandGroupPid,
        );
      assert.equal(effects.length, 1);
      assert.equal(effects[0]?.state, "uncertain");
      assert.equal(effects[0]?.completion, null);
      assert.equal(
        engine.inspectAgentBackendRequests(ready.workspaceId)[0]?.state,
        "uncertain",
      );
      assert.equal(
        engine
          .getCapabilities()
          .providerIds.some((id) => id.startsWith("acp:")),
        false,
      );
      assert.equal(engine.store.getSnapshot(ready.sessionId).tools.length, 1);
      if (mode === "direct-write") {
        assert.equal(
          readFileSync(join(ready.root, "effect.txt"), "utf8"),
          "Approved exact native ACP write.\n",
        );
        assert.equal(engine.store.listCheckpoints(ready.runId).length, 1);
      }
      await engine.close();
      const archive = await exportEngineArchive({
          dbPath: ready.dbPath,
          artifactDir: ready.artifactDir,
          destination: join(ready.base, "crash-export"),
        }),
        imported = await importEngineArchive({
          directory: archive.directory,
          destination: join(ready.base, "crash-import"),
        });
      const restored = createEngine({
        dbPath: imported.dbPath,
        artifactDir: imported.artifactDir,
        providers: [],
      });
      engines.add(restored);
      assert.equal(
        restored.inspectAgentBackendEffects(ready.workspaceId)[0]?.state,
        "paused-import",
      );
      assert.equal(
        restored.inspectAgentBackendEffects(ready.workspaceId)[0]?.completion,
        null,
      );
      assert.equal(
        restored.store.getSessionControl(ready.sessionId).paused,
        true,
      );
      await restored.waitForSession(ready.sessionId);
      assert.equal(readFileSync(ready.logPath, "utf8"), logs);
      assert.equal(restored.store.getSnapshot(ready.sessionId).tools.length, 1);
    },
  );
