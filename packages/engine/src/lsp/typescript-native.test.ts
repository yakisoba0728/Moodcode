import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Workspace } from "@moodcode/contracts";
import { StdioLspConnection } from "./stdio.js";
import {
  createTypeScriptNativeLspFactory,
  type TypeScriptNativeLspOptions,
} from "./typescript-native.js";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const executable = join(
  repositoryRoot,
  "node_modules",
  "@typescript",
  `typescript-${process.platform}-${process.arch}`,
  "lib",
  process.platform === "win32" ? "tsc.exe" : "tsc",
);
const signal = () => new AbortController().signal;
const code = (expected: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, expected);
  return true;
};
async function fixture(t: test.TestContext): Promise<Workspace> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "moodcode-native-factory-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    id: "native-factory-negative",
    root,
    gitRoot: root,
    branch: null,
    createdAt: new Date().toISOString(),
  };
}
function observeProducer(t: test.TestContext) {
  const original = StdioLspConnection.open;
  let calls = 0;
  StdioLspConnection.open = async (options) => {
    calls++;
    return original.call(StdioLspConnection, options);
  };
  t.after(() => {
    StdioLspConnection.open = original;
  });
  return () => calls;
}

test("native factory rejects host getters, proxies, extra argv, relative paths and arbitrary versions without invoking a producer", async (t) => {
  const producers = observeProducer(t);
  let traps = 0;
  const accessor = {
    get executable() {
      traps++;
      return executable;
    },
    expectedVersion: "7.0.2",
  };
  const proxy = new Proxy(
    { executable, expectedVersion: "7.0.2" },
    {
      get() {
        traps++;
        throw new Error("Proxy get must not run");
      },
      ownKeys() {
        traps++;
        throw new Error("Proxy ownKeys must not run");
      },
    },
  );
  for (const input of [
    accessor,
    proxy,
    { executable, expectedVersion: "7.0.2", args: ["--arbitrary"] },
    { executable: "relative/tsc", expectedVersion: "7.0.2" },
    { executable, expectedVersion: "6.0.0" },
  ]) {
    assert.throws(
      () =>
        createTypeScriptNativeLspFactory(input as TypeScriptNativeLspOptions),
      code("INVALID_LSP_CONFIG"),
    );
  }
  assert.equal(traps, 0);
  assert.equal(producers(), 0);
});

test("native factory rejects actual missing executable and a noncanonical symlink before stdio creation", async (t) => {
  const scope = await fixture(t),
    producers = observeProducer(t);
  const missing = createTypeScriptNativeLspFactory({
    executable: join(scope.root, "missing"),
    expectedVersion: "7.0.2",
  });
  await assert.rejects(missing(scope, signal()), code("INVALID_LSP_CONFIG"));
  const target = await realpath(process.execPath),
    link = join(scope.root, "linked-executable");
  await symlink(target, link);
  const linked = createTypeScriptNativeLspFactory({
    executable: link,
    expectedVersion: "7.0.2",
  });
  await assert.rejects(linked(scope, signal()), code("INVALID_LSP_CONFIG"));
  assert.equal(producers(), 0);
});

test("original Node executable reports an actual incompatible version without a stdio producer", async (t) => {
  const scope = await fixture(t),
    producers = observeProducer(t);
  const nodeExecutable = await realpath(process.execPath);
  const factory = createTypeScriptNativeLspFactory({
    executable: nodeExecutable,
    expectedVersion: "7.0.2",
  });
  await assert.rejects(factory(scope, signal()), code("LSP_VERSION_MISMATCH"));
  assert.equal(producers(), 0);
});

test(
  "original physical executable identity is retained and replacement is rejected before a second actual native spawn",
  { timeout: 10_000, skip: process.platform === "win32" },
  async (t) => {
    if (!existsSync(executable)) {
      t.skip("Pinned native TS7 executable is not installed on this platform");
      return;
    }
    const scope = await fixture(t),
      producers = observeProducer(t);
    const target = await realpath(executable),
      shim = join(scope.root, "native-wrapper");
    const script = `#!/bin/sh\nexec '${target.replaceAll("'", "'\\''")}' "$@"\n`;
    await writeFile(shim, script);
    await chmod(shim, 0o755);
    const factory = createTypeScriptNativeLspFactory({
      executable: shim,
      expectedVersion: "7.0.2",
    });
    const connection = await factory(scope, signal());
    const child = Reflect.get(
      connection,
      "child",
    ) as ChildProcessWithoutNullStreams;
    try {
      assert.equal(producers(), 1);
      await connection.close();
      assert.throws(
        () => process.kill(child.pid!, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      );
      const replacement = join(scope.root, "replacement-wrapper");
      await writeFile(replacement, script);
      await chmod(replacement, 0o755);
      await rename(replacement, shim);
      await assert.rejects(
        factory(scope, signal()),
        code("LSP_EXECUTABLE_CHANGED"),
      );
      assert.equal(
        producers(),
        1,
        "No second Stdio creation follows the changed compiler identity",
      );
    } finally {
      await connection.close().catch(() => {});
    }
  },
);

test("pre-aborted native startup rejects before version probe or actual stdio creation", async (t) => {
  const scope = await fixture(t),
    producers = observeProducer(t);
  const controller = new AbortController();
  controller.abort();
  // Even a nonexistent executable would fail differently if physical/version work began.
  const factory = createTypeScriptNativeLspFactory({
    executable: join(scope.root, "must-not-start"),
    expectedVersion: "7.0.2",
  });
  await assert.rejects(factory(scope, controller.signal), code("CANCELLED"));
  assert.equal(producers(), 0);
});
