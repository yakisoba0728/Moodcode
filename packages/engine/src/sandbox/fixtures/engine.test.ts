import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fixture } from "./engine.js";

const noEffects = { osSandbox: false, hostCommands: false, jobs: false };
function context(passed: boolean | undefined, error: Error | null = null) {
  const hooks: (() => void | Promise<void>)[] = [];
  const diagnostics: string[] = [];
  const value = {
    passed,
    error,
    diagnostic(message: string) {
      diagnostics.push(message);
    },
    after(hook: () => void | Promise<void>) {
      hooks.push(hook);
    },
  };
  return {
    value,
    testContext: value as unknown as TestContext,
    diagnostics,
    async teardown() {
      assert.equal(hooks.length, 1);
      await hooks[0]!();
    },
  };
}

function assertRetained(
  f: Awaited<ReturnType<typeof fixture>>,
  t: TestContext,
  phases = ["before-close", "after-close"],
) {
  assert.equal(readFileSync(join(f.root, "seed"), "utf8"), "workspace");
  assert.equal(readFileSync(join(f.outside, "secret"), "utf8"), "outside");
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try {
    for (const [table, id] of [
      ["workspaces", f.workspace.id],
      ["sessions", f.session.id],
    ] as const)
      assert.equal(
        JSON.parse(
          String(
            db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id)!.data,
          ),
        ).id,
        id,
      );
  } finally {
    db.close();
  }
  for (const phase of phases) {
    const evidence = JSON.parse(
      readFileSync(join(f.base, `${phase}.json`), "utf8"),
    );
    assert.equal(evidence.phase, phase);
    assert.equal(evidence.dbPath, f.dbPath);
    assert.equal(evidence.retainedEvidencePath, f.base);
    assert.equal(evidence.observations.nativeCleanupConfirmed, null);
    assert.equal(
      evidence.nativeRecordsSha256,
      createHash("sha256")
        .update(JSON.stringify(evidence.native))
        .digest("hex"),
    );
    assert.equal(
      evidence.source.sha256,
      createHash("sha256")
        .update(readFileSync(evidence.source.path))
        .digest("hex"),
    );
  }
  t.diagnostic(`Retained regression original: ${f.base}`);
}

test("passing, disabled, empty Engine fixture retains originals without cleanup authority", async (t) => {
  const c = context(true);
  const f = await fixture(c.testContext, noEffects);
  assert.equal(f.calls.length, 0);
  await c.teardown();
  assert.equal(existsSync(f.base), true);
  assertRetained(f, t);
});

test("failed no-effect Engine fixture retains native originals and snapshots", async (t) => {
  const c = context(false, new Error("authored test failure"));
  const f = await fixture(c.testContext, noEffects);
  await c.teardown();
  assertRetained(f, t);
  const evidence = JSON.parse(
    readFileSync(join(f.base, "after-close.json"), "utf8"),
  );
  assert.ok(evidence.retentionReasons.includes("test-failed"));
  assert.equal(evidence.observations.engineCloseFulfilled, 1);
});

test("unknown test outcome retains a no-effect Engine fixture", async (t) => {
  const c = context(undefined);
  const f = await fixture(c.testContext, noEffects);
  await c.teardown();
  assertRetained(f, t);
  const evidence = JSON.parse(
    readFileSync(join(f.base, "after-close.json"), "utf8"),
  );
  assert.ok(
    evidence.retentionReasons.includes("test-outcome-unknown-or-failed"),
  );
});

test("fulfilled close does not authorize deleting an enabled sandbox fixture", async (t) => {
  const c = context(true);
  const f = await fixture(c.testContext, { ...noEffects, osSandbox: true });
  assert.equal(f.calls.length, 0);
  await c.teardown();
  assertRetained(f, t);
  const evidence = JSON.parse(
    readFileSync(join(f.base, "after-close.json"), "utf8"),
  );
  assert.ok(evidence.retentionReasons.includes("native-cleanup-not-proven"));
  assert.equal(evidence.observations.engineCloseFulfilled, 1);
});

test("failed evidence capture retains native originals after close", async (t) => {
  const c = context(true);
  const f = await fixture(c.testContext, noEffects);
  // Refuse only the evidence file write; leave the original SQLite untouched.
  mkdirSync(join(f.base, "before-close.json"));
  await c.teardown();
  assertRetained(f, t, ["after-close"]);
  const evidence = JSON.parse(
    readFileSync(join(f.base, "after-close.json"), "utf8"),
  );
  assert.ok(
    evidence.retentionReasons.includes("native-evidence-capture-failed"),
  );
  assert.ok(
    c.diagnostics.some((message) =>
      message.includes("Native evidence capture failed (before-close)"),
    ),
  );
  assert.equal(evidence.observations.engineCloseFulfilled, 1);
});

test("close failure retains originals and survives a throwing diagnostic", async (t) => {
  const c = context(true);
  const f = await fixture(c.testContext, noEffects);
  // Close the actual no-effect Engine before faulting its owned close port.
  // This exercises propagation without launching or signaling any process.
  const close = f.engine.close.bind(f.engine);
  await close();
  const original = new Error("authored close failure " + "🙂".repeat(4096));
  f.engine.close = async () => {
    throw original;
  };
  c.value.diagnostic = (message: string) => {
    c.diagnostics.push(message);
    throw new Error("authored reporting failure");
  };
  await assert.rejects(c.teardown(), (error) => error === original);
  assertRetained(f, t);
  assert.ok(
    c.diagnostics.some((message) =>
      message.includes("Original Engine close failed"),
    ),
  );
  assert.ok(
    c.diagnostics.every((message) => Buffer.byteLength(message) <= 2048),
  );
  const evidence = JSON.parse(
    readFileSync(join(f.base, "after-close.json"), "utf8"),
  );
  assert.ok(evidence.retentionReasons.includes("engine-close-failed"));
  assert.equal(evidence.observations.engineCloseFailed, true);
  assert.equal(evidence.observations.engineCloseFulfilled, 0);
});
