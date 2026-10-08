import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../engine.js";
import { validateMediaDatabase } from "./native-validation.js";
import type { DatabaseSync } from "node:sqlite";
for (const mode of ["streaming", "published", "receipt", "settled"])
  test(
    "actual SIGKILL " +
      mode +
      " keeps native evidence, recovery control and no media/provider replay",
    async () => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "moodcode-media-crash-")),
      );
      mkdirSync(join(root, "repo"));
      execFileSync("git", ["init", "-q", join(root, "repo")]);
      let child: ReturnType<typeof spawn> | undefined;
      let engine: ReturnType<typeof createEngine> | undefined;
      try {
        const source = fileURLToPath(
            new URL("./fixtures/segment-crash.ts", import.meta.url),
          ),
          compiled = fileURLToPath(
            new URL("./fixtures/segment-crash.js", import.meta.url),
          );
        const fixture = existsSync(source) ? source : compiled;
        const loader = fileURLToPath(
          new URL(
            "../../../../node_modules/tsx/dist/loader.mjs",
            import.meta.url,
          ),
        );
        child = spawn(
          process.execPath,
          [
            ...(fixture.endsWith(".ts") ? ["--import", loader] : []),
            fixture,
            root,
            mode,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        child.stderr?.on("data", (d) => (output += d.toString()));
        const exit = new Promise<void>((resolve) =>
          child!.once("exit", () => resolve()),
        );
        const end = Date.now() + 8000;
        while (!existsSync(join(root, "ready.json"))) {
          if (child.exitCode !== null || Date.now() > end)
            throw new Error(
              "media child did not reach " + mode + ": " + output,
            );
          await new Promise((r) => setTimeout(r, 10));
        }
        const ready = JSON.parse(
          readFileSync(join(root, "ready.json"), "utf8"),
        ) as { sessionId: string; runId: string; stage: string; pid: number };
        assert.equal(ready.stage, mode);
        assert.ok(ready.pid > 0);
        child.kill("SIGKILL");
        await exit;
        let replay = 0;
        engine = createEngine({
          dbPath: join(root, "engine.sqlite"),
          artifactDir: join(root, "artifacts"),
          providers: [
            {
              id: "crash-audio",
              async *streamTurn() {
                replay++;
                yield { type: "finish", reason: "stop" };
              },
            },
          ],
        });
        const runs = engine.store.getSnapshot(ready.sessionId).runs;
        assert.equal(runs.length, 1);
        const run = runs[0]!;
        if (mode === "settled") assert.equal(run.state, "completed");
        else assert.equal(run.state, "interrupted");
        const turns = engine.store.listTurns(run.id),
          parts = turns.flatMap((t) => engine!.store.listParts(t.id)),
          media = parts.filter((p) => p.type === "media");
        assert.equal(
          media.length,
          mode === "receipt" || mode === "settled" ? 1 : 0,
        );
        if (mode === "receipt") {
          assert.equal(media[0]!.state, "interrupted");
          assert.equal(turns[0]!.state, "uncertain");
        }
        if (mode === "streaming") assert.equal(turns[0]!.state, "uncertain");
        assert.doesNotThrow(() =>
          validateMediaDatabase(
            Reflect.get(engine!.store, "db") as DatabaseSync,
          ),
        );
        await new Promise((r) => setTimeout(r, 25));
        assert.equal(replay, 0);
        assert.equal(
          engine.store.getSessionControl(ready.sessionId).paused,
          mode !== "settled",
        );
      } finally {
        child?.kill("SIGKILL");
        await engine?.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
