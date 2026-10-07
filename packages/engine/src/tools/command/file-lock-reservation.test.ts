import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EngineError } from "@moodcode/contracts";
import {
  acquireExecutionLock,
  assertExecutionLockAvailable,
  inspectExecutionLock,
  readExecutionLockReservation,
  reconcileStoppedExecutionLock,
  reserveExecutionLock,
} from "./execution-lock.js";

const failure = (code: string) => (error: unknown) =>
  error instanceof EngineError && error.code === code;
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "moodcode-file-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "effects.sqlite");
}
test("original marker reservation is immutable, unique and produces no lock database before acquire", (t) => {
  const path = fixture(t),
    one = reserveExecutionLock(path),
    two = reserveExecutionLock(path);
  assert.notEqual(one.id, two.id);
  assert.equal(Object.isFrozen(readExecutionLockReservation(one)), true);
  assert.equal(inspectExecutionLock(path).status, "not_initialized");
  assert.throws(
    () => acquireExecutionLock(path, structuredClone(one)),
    failure("COMMAND_EXECUTION_RESERVATION_INVALID"),
  );
  assert.equal(inspectExecutionLock(path).status, "not_initialized");
});
test("actual acquired marker exactly preserves original reserved identity and consumed reservation cannot reacquire", (t) => {
  const path = fixture(t),
    original = reserveExecutionLock(path),
    expected = readExecutionLockReservation(original),
    lock = acquireExecutionLock(path, original);
  assert.equal(inspectExecutionLock(path).status, "busy");
  lock.release(false);
  const marker = inspectExecutionLock(path);
  assert.equal(marker.status, "uncertain");
  if (marker.status === "uncertain") assert.deepEqual(marker.marker, expected);
  assert.throws(
    () => acquireExecutionLock(path, original),
    failure("COMMAND_EXECUTION_RESERVATION_INVALID"),
  );
  assert.throws(
    () => reconcileStoppedExecutionLock(path, expected),
    failure("COMMAND_EFFECTS_OWNER_ALIVE"),
  );
  assert.equal(inspectExecutionLock(path).status, "uncertain");
});
test("original reservation rejects another physical lock path before creating it", (t) => {
  const path = fixture(t),
    reservation = reserveExecutionLock(path),
    other = `${path}.other`;
  assert.throws(
    () => acquireExecutionLock(other, reservation),
    failure("COMMAND_EXECUTION_RESERVATION_INVALID"),
  );
  assert.equal(inspectExecutionLock(other).status, "not_initialized");
});
test("recovery metadata rejects getters and proxies before reading or changing the physical lock", (t) => {
  const path = fixture(t);
  let traps = 0;
  const value = {
    ownerPid: process.pid,
    groupPid: null,
    active: true,
    updatedAt: new Date().toISOString(),
  };
  const accessor = {
    ...value,
    get ownerPid() {
      traps++;
      return process.pid;
    },
  };
  const proxy = new Proxy(value, {
    get() {
      traps++;
      throw new Error("Proxy executed");
    },
    ownKeys() {
      traps++;
      throw new Error("Proxy keys executed");
    },
  });
  for (const input of [accessor, proxy])
    assert.throws(
      () => reconcileStoppedExecutionLock(path, input),
      failure("COMMAND_EFFECTS_RECOVERY_INVALID"),
    );
  assert.equal(traps, 0);
  assert.equal(inspectExecutionLock(path).status, "not_initialized");
});
test("explicit recovery clears exact marker of actual terminated file worker and retains foreign marker", async (t) => {
  const path = fixture(t),
    module = new URL(
      import.meta.url.endsWith(".ts")
        ? "./execution-lock.ts"
        : "./execution-lock.js",
      import.meta.url,
    ).href;
  const loader = fileURLToPath(
    new URL("../../../../../node_modules/tsx/dist/loader.mjs", import.meta.url),
  );
  const script = `import { reserveExecutionLock, readExecutionLockReservation, acquireExecutionLock } from ${JSON.stringify(module)}; const r=reserveExecutionLock(${JSON.stringify(path)}); const marker=readExecutionLockReservation(r); acquireExecutionLock(${JSON.stringify(path)},r); process.stdout.write(JSON.stringify(marker)+'\\n'); setInterval(()=>{},1000);`;
  const child = spawn(
    process.execPath,
    ["--import", loader, "--input-type=module", "-e", script],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  let output = "",
    errors = "";
  child.stderr.on("data", (value) => {
    errors += String(value);
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (value) => {
      output += String(value);
      if (output.includes("\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", () => {
      if (!output.includes("\n"))
        reject(new Error(errors || "Worker did not acquire lock"));
    });
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
  t.after(() => clearTimeout(timeout));
  await ready;
  const exited = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  child.kill("SIGKILL");
  await exited;
  const marker = JSON.parse(output.trim());
  assert.equal(inspectExecutionLock(path).status, "uncertain");
  assert.throws(
    () =>
      reconcileStoppedExecutionLock(path, {
        ...marker,
        updatedAt: new Date(0).toISOString(),
      }),
    failure("COMMAND_EFFECTS_RECOVERY_STALE"),
  );
  assert.equal(inspectExecutionLock(path).status, "uncertain");
  reconcileStoppedExecutionLock(path, marker);
  assert.equal(inspectExecutionLock(path).status, "available");
  assertExecutionLockAvailable(path);
});
