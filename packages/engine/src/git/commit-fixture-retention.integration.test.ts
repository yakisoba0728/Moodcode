import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MoodcodeEngine } from "../engine.js";
import { commitFixture } from "./fixtures/commit.js";
import { retainCrashFixture } from "./fixtures/crash-retention.js";

for (const rejectClose of [false, true])
  test(
    `crash retention preserves raw SQLite and child output with ${rejectClose ? "native close and report failures" : "fulfilled owned closes"}`,
    { timeout: 10000 },
    async (t) => {
      const base = await realpath(
          await mkdtemp(join(tmpdir(), "moodcode-crash-retention-")),
        ),
        dbPath = join(base, "engine.sqlite"),
        artifactDir = join(base, "artifacts"),
        engine = new MoodcodeEngine({ dbPath, artifactDir, tools: [] });
      t.after(async () => {
        await engine.close();
        t.diagnostic(`Retained raw SQLite/child-output fixture: ${base}`);
      });
      engine.store.putWorkspace({
        id: "retained-workspace",
        root: base,
        gitRoot: base,
        branch: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      engine.store.createSession({
        id: "retained-session",
        workspaceId: "retained-workspace",
        title: "Retain original rows",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const probe = new DatabaseSync(dbPath, { readOnly: true });
      t.after(() => {
        if (probe.isOpen) probe.close();
      });
      const original = String(
          probe
            .prepare("SELECT data FROM sessions WHERE id='retained-session'")
            .get()!.data,
        ),
        child = spawn(
          process.execPath,
          ["-e", "process.stdout.write('Original child output\\n')"],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
      let stdout = "",
        stderr = "",
        joined = false;
      child.stdout.on("data", (bytes: Buffer) => {
        stdout = (stdout + bytes.toString()).slice(-8192);
      });
      child.stderr.on("data", (bytes: Buffer) => {
        stderr = (stderr + bytes.toString()).slice(-8192);
      });
      const closed = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          joined = true;
          if (code === 0) resolve();
          else reject(new Error(`Original child failed: ${code}, ${stderr}`));
        });
      });
      const childJoined = new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
      t.after(async () => {
        if (!joined) child.kill("SIGKILL");
        await childJoined;
      });
      await closed;
      await mkdir(artifactDir, { recursive: true });
      const outputPath = join(artifactDir, "original-child.stdout");
      await writeFile(outputPath, stdout);
      if (rejectClose) await mkdir(join(base, "crash-retention.json"));
      const diagnostics: string[] = [],
        retained = retainCrashFixture({
          base,
          dbPath,
          boundary: "owned-close",
          stderr,
          settleChild: () => closed,
          closeEngine: async () => {
            await engine.close();
            probe.close();
            if (rejectClose) probe.close();
          },
          diagnostic: (message) => {
            diagnostics.push(message);
          },
        });
      if (rejectClose) {
        await assert.rejects(retained, { code: "ERR_INVALID_STATE" });
        assert.ok(
          diagnostics.some((message) =>
            message.startsWith("Crash retention report failed:"),
          ),
        );
      } else {
        await retained;
        const report = JSON.parse(
          readFileSync(join(base, "crash-retention.json"), "utf8"),
        );
        assert.deepEqual(report.observations, {
          childJoined: true,
          engineClosed: true,
        });
        assert.equal(report.cleanupAuthority, "unavailable-after-owner-crash");
      }
      assert.equal(joined, true);
      assert.equal(stdout, "Original child output\n");
      assert.equal(readFileSync(outputPath, "utf8"), "Original child output\n");
      const after = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(
          String(
            after
              .prepare("SELECT data FROM sessions WHERE id='retained-session'")
              .get()!.data,
          ),
          original,
        );
        for (const table of ["runs", "tools", "provider_attempts"])
          assert.equal(
            Number(after.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),
            0,
          );
      } finally {
        after.close();
      }
      assert.ok(
        diagnostics.some(
          (message) => message === `Retained original crash fixture: ${base}`,
        ),
      );
    },
  );

test(
  "actual verification checkpoint rejection retains native uncertainty and performs one command",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const register = MoodcodeEngine.prototype.registerVerificationCheck;
    let base!: string;
    t.mock.method(
      MoodcodeEngine.prototype,
      "registerVerificationCheck",
      function (this: MoodcodeEngine, check: Parameters<typeof register>[0]) {
        const result = register.call(this, check);
        base = check.cwd.slice(0, -"/repository".length);
        const db = new DatabaseSync(join(base, "engine.sqlite"));
        try {
          db.exec(
            "CREATE TRIGGER authored_checkpoint_rejection BEFORE INSERT ON checkpoints BEGIN SELECT RAISE(ABORT,'authored native checkpoint rejection'); END",
          );
        } finally {
          db.close();
        }
        return result;
      },
    );
    await assert.rejects(commitFixture(t), /CLEANUP_UNCERTAIN/);
    const path = join(base, "engine.sqlite"),
      before = new DatabaseSync(path, { readOnly: true });
    const rows = (db: DatabaseSync, table: string) =>
      db
        .prepare(`SELECT data FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) => String(row.data));
    let original: Record<string, string[]>;
    try {
      original = Object.fromEntries(
        [
          "runs",
          "provider_attempts",
          "attempt_cleanup",
          "tools",
          "session_documents",
          "session_events",
        ].map((table) => [table, rows(before, table)]),
      );
      assert.equal(JSON.parse(original.runs![0]!).state, "failed");
      assert.equal(
        JSON.parse(original.runs![0]!).error.code,
        "CLEANUP_UNCERTAIN",
      );
      assert.equal(original.tools!.length, 1);
      assert.equal(JSON.parse(original.tools![0]!).state, "interrupted");
      assert.equal(original.provider_attempts!.length, 1);
      assert.equal(
        JSON.parse(original.attempt_cleanup![0]!).cleanupConfirmed,
        true,
      );
      const receipts = original
        .session_documents!.map((raw) => JSON.parse(raw))
        .find((row) => Array.isArray(row.receipts))!.receipts;
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].status, "uncertain");
      assert.equal(receipts[0].observation, null);
      assert.equal(
        Number(before.prepare("SELECT count(*) n FROM checkpoints").get()!.n),
        0,
      );
    } finally {
      before.close();
    }
    const artifactDir = join(base, "artifacts"),
      commands = () =>
        readdirSync(artifactDir, { withFileTypes: true }).filter(
          (entry) => entry.isDirectory() && entry.name.startsWith("command-"),
        );
    assert.equal(commands().length, 1);
    const stdout = join(artifactDir, commands()[0]!.name, "stdout.log");
    const actualOutput = readFileSync(stdout, "utf8");
    assert.equal(actualOutput, "actual-verification");
    const failure = JSON.parse(
      readFileSync(join(base, "preparation-failure.json"), "utf8"),
    );
    assert.equal(failure.jobsEnabled, false);
    assert.deepEqual(
      failure.native.tools,
      original.tools!.map((raw) => JSON.parse(raw)),
    );
    t.after(() => {
      assert.ok(existsSync(path));
      const after = new DatabaseSync(path, { readOnly: true });
      try {
        for (const [table, expected] of Object.entries(original))
          assert.deepEqual(rows(after, table), expected);
      } finally {
        after.close();
      }
      assert.equal(commands().length, 1);
      assert.equal(readFileSync(stdout, "utf8"), actualOutput);
      for (const phase of ["before-close", "after-close"]) {
        const retained = JSON.parse(
          readFileSync(join(base, `${phase}.json`), "utf8"),
        );
        assert.equal(
          retained.nativeRecordsSha256,
          createHash("sha256")
            .update(JSON.stringify(retained.native))
            .digest("hex"),
        );
        assert.deepEqual(
          retained.native.runs,
          original.runs!.map((raw) => JSON.parse(raw)),
        );
      }
      t.diagnostic(`Retained authored native checkpoint rejection: ${base}`);
    });
  },
);
