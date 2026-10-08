import { assertExecutionLockAvailable } from "../tools/command/execution-lock.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, until } from "./fixtures/engine.js";
import { groupExists } from "../tools/command/process-control.js";
test(
  "actual Root SIGKILL joins restricted runtime and native command group, restart is uncertain and never replays",
  { skip: process.platform !== "darwin", timeout: 45000 },
  async (t) => {
    const f = await fixture(t, { jobs: true });
    const lockPath = Reflect.get(f.engine, "executionLockPath") as string;
    await f.engine.close();
    const compiled = new URL("./fixtures/crash.js", import.meta.url),
      source = new URL("./fixtures/crash.ts", import.meta.url);
    const child = spawn(
      process.execPath,
      [
        ...(existsSync(compiled)
          ? []
          : [
              "--import",
              "/Users/yakisoba0728/Documents/GitHub/Moodcode/node_modules/tsx/dist/loader.mjs",
            ]),
        fileURLToPath(existsSync(compiled) ? compiled : source),
        JSON.stringify({
          dbPath: f.dbPath,
          artifactDir: f.artifactDir,
          root: f.root,
          workspaceId: f.workspace.id,
          sessionId: f.session.id,
          config: f.config,
        }),
      ],
      { stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd() },
    );
    t.after(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    await until(() => stdout.includes("\n"), stderr, 15000);
    const ready = JSON.parse(stdout.trim().split("\n")[0]!);
    assert.equal(groupExists(ready.runtimePid), true);
    assert.equal(groupExists(ready.commandPid), true);
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
    await until(
      () => !groupExists(ready.runtimePid) && !groupExists(ready.commandPid),
      "actual code-mode groups survived Root SIGKILL",
      8000,
    );
    await until(
      () => {
        try {
          assertExecutionLockAvailable(lockPath);
          return true;
        } catch {
          return false;
        }
      },
      "actual command supervisor lease remains",
      8000,
    );
    const count = f.requests.length;
    await f.reopen();
    const row = f.engine.getCodeMode(f.workspace.id, ready.id)!;
    assert.equal(row.state, "uncertain");
    assert.equal(row.outcome, null);
    assert.equal(f.requests.length, count);
    assert.equal(f.engine.store.getRun(ready.runId).state, "interrupted");
    assert.equal(readFileSync(join(f.root, "crash-effect"), "utf8"), "once");
    assert.throws(
      () =>
        f.engine.previewCodeModeGrant({
          workspaceId: f.workspace.id,
          sessionId: f.session.id,
          config: f.config,
        }),
      { code: "CODE_MODE_RUNTIME_REQUIRED" },
    );
  },
);
