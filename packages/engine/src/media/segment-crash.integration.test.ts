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

function childJoin(child: ReturnType<typeof spawn>): Promise<void> {
  let exited = false, closed = false;
  const joined = new Promise<void>((resolve, reject) => {
    const check = () => { if (exited && closed) resolve(); };
    child.once("exit", () => { exited = true; check(); });
    child.once("close", () => { closed = true; check(); });
    child.once("error", reject);
  });
  void joined.catch(() => {});
  return joined;
}

async function stopAndJoin(child: ReturnType<typeof spawn>, joined: Promise<void>, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([joined, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Original media child exit/close join timed out.")), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function cleanupFixture(root: string, child: ReturnType<typeof spawn> | undefined, joined: Promise<void> | undefined,
  engine: { close(): Promise<void> } | undefined, passed: boolean, timeoutMs = 2_000): Promise<unknown[]> {
  const failures: unknown[] = [];
  if (child && joined) try { await stopAndJoin(child, joined, timeoutMs); } catch (error) { failures.push(error); }
  else if (child) failures.push(new Error("Original media child join was not captured."));
  try { await engine?.close(); } catch (error) { failures.push(error); }
  if (passed && failures.length === 0) rmSync(root, { recursive: true, force: true });
  else console.error("Original media fixture root retained:", root);
  return failures;
}

test("failure cleanup joins the original child exit and close before engine cleanup and retains evidence", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moodcode-media-crash-cleanup-")));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  const joined = childJoin(child);
  let exited = false, closed = false, engineClosed = false;
  child.once("exit", () => { exited = true; });
  child.once("close", () => { closed = true; });
  const closeFailure = new Error("Synthetic engine cleanup failure");
  const failures = await cleanupFixture(root, child, joined, { async close() {
    engineClosed = true;
    assert.equal(exited, true); assert.equal(closed, true);
    assert.ok(existsSync(root), "Original root must exist while cleanup owners settle.");
    throw closeFailure;
  } }, false);
  assert.equal(engineClosed, true);
  assert.deepEqual(failures, [closeFailure]);
  assert.ok(existsSync(root), "Failed Original must be retained after joined cleanup.");
});

test("unconfirmed exit/close observation retains the Original and still attempts engine cleanup", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moodcode-media-crash-unconfirmed-")));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  const actualJoin = childJoin(child);
  let engineClosed = false;
  // Deliberately missing observation is a comparison, not native join evidence.
  const failures = await cleanupFixture(root, child, new Promise<void>(() => {}), { async close() { engineClosed = true; } }, true, 10);
  assert.equal(engineClosed, true); assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /exit\/close join timed out/u);
  assert.ok(existsSync(root), "Unconfirmed Original must not be deleted.");
  await stopAndJoin(child, actualJoin);
});

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
      let joined: Promise<void> | undefined;
      let engine: ReturnType<typeof createEngine> | undefined;
      let passed = false, failed = false;
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
        joined = childJoin(child);
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
        await stopAndJoin(child, joined);
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
        passed = true;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        const failures = await cleanupFixture(root, child, joined, engine, passed);
        if (!failed && failures.length) throw new AggregateError(failures, "Media fixture cleanup failed; original root retained.");
      }
    },
  );
