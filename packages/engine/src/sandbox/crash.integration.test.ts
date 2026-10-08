import { assertExecutionLockAvailable } from "../tools/command/execution-lock.js";
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixture, until } from "./fixtures/engine.js";
import { groupExists } from "../tools/command/process-control.js";
const loader =
  "/Users/yakisoba0728/Documents/GitHub/Moodcode/node_modules/tsx/dist/loader.mjs";
for (const mode of ["command", "mcp"] as const)
  test(
    `actual Root SIGKILL ${mode} kills constrained descendants and native recovery never replays`,
    { skip: process.platform !== "darwin", timeout: 45000 },
    async (t) => {
      const f = await fixture(t);
      const script = join(f.root, "crash-" + mode + ".mjs");
      writeFileSync(
        script,
        mode === "command"
          ? `import{writeFileSync}from'node:fs';import{spawn}from'node:child_process';writeFileSync('crash-once','actual');const descendant=spawn(${JSON.stringify(process.execPath)},['-e','setInterval(()=>{},20)'],{stdio:'ignore'});writeFileSync('crash-descendant.pid',String(descendant.pid));setInterval(()=>{},20);`
          : `import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result=r.method==='server/discover'?{resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{},resources:{}}}:r.method==='tools/list'?{resultType:'complete',tools:[]}:{resultType:'complete',resources:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});setInterval(()=>{},20);`,
      );
      const lockPath = Reflect.get(f.engine, "executionLockPath") as string;
      await f.engine.close();
      const source = fileURLToPath(
          new URL("./fixtures/crash.ts", import.meta.url),
        ),
        compiled = fileURLToPath(
          new URL("./fixtures/crash.js", import.meta.url),
        ),
        worker = spawn(
          process.execPath,
          [
            ...(existsSync(compiled) ? [] : ["--import", loader]),
            existsSync(compiled) ? compiled : source,
            JSON.stringify({
              dbPath: f.dbPath,
              artifactDir: f.artifactDir,
              root: f.root,
              workspaceId: f.workspace.id,
              sessionId: f.session.id,
              config: f.config,
              mode,
              script,
            }),
          ],
          { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
        );
      t.after(() => {
        try {
          worker.kill("SIGKILL");
        } catch {}
      });
      let stdout = "",
        stderr = "";
      worker.stdout.on("data", (b) => (stdout += b.toString()));
      worker.stderr.on("data", (b) => (stderr += b.toString()));
      await until(
        () => stdout.includes("\n"),
        `actual ${mode} readiness: ${stderr}`,
        20000,
      );
      const ready = JSON.parse(stdout.trim().split("\n")[0]!) as {
        pid: number;
        id: string;
      };
      assert.equal(groupExists(ready.pid), true);
      let descendantPid: number | undefined;
      if (mode === "command") {
        await until(
          () => existsSync(join(f.root, "crash-descendant.pid")),
          "actual descendant startup",
        );
        descendantPid = Number(
          readFileSync(join(f.root, "crash-descendant.pid"), "utf8"),
        );
      }
      const closed = once(worker, "close");
      worker.kill("SIGKILL");
      await closed;
      await until(
        () => !groupExists(ready.pid),
        "actual sandbox descendants survived Root SIGKILL",
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
        "actual supervisor effect lock remains owned",
        8000,
      );
      if (descendantPid) assert.throws(() => process.kill(descendantPid!, 0));
      await f.reopen();
      const recovered = f.engine
        .observeEnforcement(f.workspace.id)
        .find((r) => r.id === ready.id)!;
      assert.equal(recovered.state, "uncertain");
      assert.equal(recovered.completion, null);
      assert.equal(f.engine.getSandboxCapability(), undefined);
      assert.equal(f.calls.length, 0);
      if (mode === "command")
        assert.equal(
          readFileSync(join(f.root, "crash-once"), "utf8"),
          "actual",
        );
    },
  );
