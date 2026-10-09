import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, default as test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { createEngine } from "../engine.js";
import { backendFixture, backendUntil } from "./fixtures/backend.js";

const execute = promisify(execFile);
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const childMode = process.env.MOODCODE_BACKEND_RETENTION_CHILD;
const modes = ["success", "failure", "close-error", "unknown", "manifest-error"];

if (childMode) {
  let base: string;
  const databases: DatabaseSync[] = [];
  after(() => {
    writeFileSync(process.env.MOODCODE_BACKEND_RETENTION_OBSERVATION!, JSON.stringify({ base, handlesClosed: databases.map(db => !db.isOpen) }) + "\n");
  });
  test("actual owned backend fixture child", async t => {
    assert.ok(modes.includes(childMode));
    // The existing crash fixture also supplies only a lifecycle after callback.
    const lifecycle = childMode === "unknown" ? { after: t.after.bind(t) } as TestContext : t;
    const f = await backendFixture(lifecycle, { mode: childMode === "success" ? "read" : "hold" });
    base = f.base;
    databases.push(Reflect.get(f.engine.store, "db") as DatabaseSync);
    f.register();
    const submitted = await f.submit();
    if (childMode === "success") assert.equal((await submitted.done).state, "completed");
    else await backendUntil(() => f.engine.inspectAgentBackendRequests(f.workspace.id)[0]?.state === "dispatched", "Actual Original did not dispatch");
    if (childMode === "close-error") {
      const other = createEngine({ ...f.configuration, dbPath: join(f.base, "second.sqlite"), artifactDir: join(f.base, "second-artifacts") });
      f.engines.add(other);
      databases.push(Reflect.get(other.store, "db") as DatabaseSync);
      const close = f.engine.close.bind(f.engine);
      f.engine.close = async () => { await close(); throw new Error("fixture-close-marker"); };
    }
    if (childMode === "manifest-error") mkdirSync(join(f.base, "fixture-retention.json"));
    if (["failure", "manifest-error"].includes(childMode)) throw new Error("fixture-body-marker");
  });
} else {
  for (const mode of modes) test(`backend Original survives ${mode} after native test cleanup`, async t => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "moodcode-backend-evidence-")));
    const observation = join(parent, "child-observation.json");
    const { NODE_TEST_CONTEXT: _context, ...childEnv } = process.env;
    let stdout = "", stderr = "", exitCode: string | number = 0;
    try {
      ({ stdout, stderr } = await execute(process.execPath, ["--test", "--test-timeout=30000", fileURLToPath(import.meta.url)], {
        env: { ...childEnv, MOODCODE_BACKEND_RETENTION_CHILD: mode, MOODCODE_BACKEND_RETENTION_OBSERVATION: observation, MOODCODE_CI_BACKEND_FIXTURE_ROOT: parent },
        maxBuffer: 2_097_152,
      }));
    } catch (error) {
      const result = error as { stdout: string; stderr: string; code: string | number };
      ({ stdout, stderr, code: exitCode } = result);
    }
    assert.equal(exitCode, ["success", "unknown"].includes(mode) ? 0 : 1, stdout + stderr);
    if (mode === "close-error") assert.match(stdout + stderr, /fixture-close-marker/);
    if (["failure", "manifest-error"].includes(mode)) assert.match(stdout + stderr, /fixture-body-marker/);
    const observed = JSON.parse(readFileSync(observation, "utf8")) as { base: string; handlesClosed: boolean[] };
    assert.deepEqual(observed.handlesClosed, mode === "close-error" ? [true, true] : [true]);
    assert.ok(existsSync(observed.base));
    const primary = join(observed.base, "engine.sqlite"), before = sha(readFileSync(primary));
    assert.equal(readFileSync(primary).subarray(0, 16).toString(), "SQLite format 3\0");
    const peer = readFileSync(join(observed.base, "peer.log"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.equal(peer.filter(row => row.type === "started").length, 1);
    assert.equal(peer.filter(row => row.message?.method === "session/prompt").length, 1);
    const retention = join(observed.base, "fixture-retention.json");
    if (mode === "manifest-error") {
      assert.equal(lstatSync(retention).isDirectory(), true);
      assert.match(stdout + stderr, /"manifestWritten":false/);
    } else {
      const record = JSON.parse(readFileSync(retention, "utf8"));
      assert.equal(record.outcome, mode);
      assert.equal(record.nativeCleanupConfirmed, null);
      assert.equal(record.databaseRemoved, false);
      assert.equal(record.ownedEngines, mode === "close-error" ? 2 : 1);
      assert.equal(record.closeFailures, mode === "close-error" ? 1 : 0);
      assert.equal(record.closedEngines, 1);
    }
    const { preserveBackendFixtureEvidence, BACKEND_FIXTURE_EVIDENCE_LIMITS } = await import(new URL("../../../../.github/scripts/engine-ci.mjs", import.meta.url).href);
    const destination = process.env.MOODCODE_CI_BACKEND_FIXTURE_REPORT_DIR ?? parent;
    const delivered = await preserveBackendFixtureEvidence(parent, destination);
    assert.equal(delivered.fullFixtureCopy, false);
    assert.equal(delivered.nativeCleanupConfirmed, null);
    assert.equal(delivered.status, mode === "manifest-error" ? "incomplete-selected-diagnostics" : "preserved-selected-diagnostics");
    const copied = delivered.fixtures[0];
    assert.equal(sha(readFileSync(join(copied.copy, "engine.sqlite"))), before);
    assert.equal(sha(readFileSync(primary)), before);
    assert.ok(existsSync(observed.base));
    writeFileSync(join(delivered.destination, "child-observation.json"), readFileSync(observation), { flag: "wx" });
    if (mode === "unknown") {
      writeFileSync(join(observed.base, "00-prefix.sqlite"), "", { flag: "wx" });
      const partial = await preserveBackendFixtureEvidence(parent, destination, { ...BACKEND_FIXTURE_EVIDENCE_LIMITS, fileBytes: 1 });
      assert.equal(partial.status, "incomplete-selected-diagnostics");
      assert.equal(partial.failure, "BACKEND_EVIDENCE_BYTE_OR_FILE_LIMIT");
      assert.equal(partial.files, 1);
      assert.ok(existsSync(join(partial.destination, "manifest.json")));
      assert.equal(sha(readFileSync(primary)), before);
      assert.ok(existsSync(observed.base));
      symlinkSync(observed.base, join(parent, "moodcode-backend-consumer-symlink"), "dir");
      writeFileSync(join(parent, "moodcode-backend-consumer-ordinary"), "refused", { flag: "wx" });
      const refused = await preserveBackendFixtureEvidence(parent, destination);
      assert.equal(refused.status, "incomplete-selected-diagnostics");
      assert.equal(refused.failure, "BACKEND_EVIDENCE_UNSUPPORTED_ROOT");
      assert.equal(refused.nativeCleanupConfirmed, null);
      assert.equal(refused.fixtures.length, 1);
      assert.deepEqual(refused.refusedRoots.map((root: { original: string }) => root.original).sort(), [join(parent, "moodcode-backend-consumer-ordinary"), join(parent, "moodcode-backend-consumer-symlink")]);
      assert.ok(existsSync(join(refused.destination, "manifest.json")));
      assert.equal(sha(readFileSync(primary)), before);
      assert.ok(existsSync(observed.base));
    }
    t.diagnostic(JSON.stringify({ original: observed.base, selectedDiagnostics: delivered.destination, fullFixtureCopy: false, nativeCleanupConfirmed: null }));
  });
}
