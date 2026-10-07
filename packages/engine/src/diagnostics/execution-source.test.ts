import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  linkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EngineError, type Workspace } from "@moodcode/contracts";
import {
  WorkspaceExecutionSource,
  type WorkspaceExecutionSourceOptions,
} from "./execution-source.js";

function fixture(
  t: TestContext,
  extra: Partial<WorkspaceExecutionSourceOptions> = {},
) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-execution-source-")),
    ),
    root = join(base, "repository");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  const original = lstatSync(root, { bigint: true });
  const workspace: Workspace = Object.freeze({
    id: randomUUID(),
    root,
    gitRoot: root,
    branch: null,
    createdAt: new Date().toISOString(),
  });
  const source = new WorkspaceExecutionSource({
    checkWorkspaceBinding(value) {
      assert.equal(value.id, workspace.id);
      assert.equal(value.root, root);
      const current = lstatSync(root, { bigint: true });
      assert.equal(current.dev, original.dev);
      assert.equal(current.ino, original.ino);
    },
    ...extra,
  });
  t.after(async () => {
    await source.close();
    rmSync(base, { recursive: true, force: true });
  });
  return {
    base,
    root,
    workspace,
    source,
    signal: new AbortController().signal,
  };
}
function error(code: string) {
  return (value: unknown) => {
    assert.ok(value instanceof EngineError);
    assert.equal(value.code, code);
    return true;
  };
}

test("physical full source includes ignored, binary, nested and Unicode files, discloses no private body, and retains original immutable handles", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(f.root, "ignored.txt"), "private ignored body\n");
  mkdirSync(join(f.root, "nested"));
  writeFileSync(
    join(f.root, "nested", "한글😀.bin"),
    Buffer.from([0, 255, 1, 2]),
  );
  const first = await f.source.capture(f.workspace, f.signal),
    next = await f.source.capture(f.workspace, f.signal);
  assert.equal(first.metadata.completeness, "full");
  assert.equal(first.metadata.fileCount, 3);
  assert.match(first.metadata.sha256!, /^[a-f0-9]{64}$/u);
  assert.equal(next.metadata.sha256, first.metadata.sha256);
  assert.equal(Object.isFrozen(first.capture), true);
  assert.equal(Object.isFrozen(first.metadata), true);
  assert.equal(f.source.getSnapshot(first.capture), first.metadata);
  assert.equal(
    JSON.stringify(first.metadata).includes("private ignored body"),
    false,
  );
  assert.throws(
    () => f.source.getSnapshot({ ...first.capture }),
    error("EXECUTION_SOURCE_CAPTURE_INVALID"),
  );
  await f.source.assertFresh(first.capture, f.signal);
  writeFileSync(
    join(f.root, "ignored.txt"),
    "a real external ignored source change\n",
  );
  await assert.rejects(
    f.source.assertFresh(first.capture, f.signal),
    error("EXECUTION_SOURCE_STALE"),
  );
  const changed = await f.source.capture(f.workspace, f.signal);
  assert.equal(changed.metadata.completeness, "full");
  assert.notEqual(changed.metadata.sha256, first.metadata.sha256);
  f.source.release(first.capture);
  assert.throws(
    () => f.source.getSnapshot(first.capture),
    error("EXECUTION_SOURCE_CAPTURE_INVALID"),
  );
});

test("actual Git HEAD and branch are sampled rather than trusted from the Workspace DTO", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "source.ts"), "export const value = 1;\n");
  execFileSync("git", ["-C", f.root, "add", "source.ts"]);
  execFileSync("git", [
    "-C",
    f.root,
    "-c",
    "user.name=Source fixture",
    "-c",
    "user.email=source@invalid",
    "commit",
    "--quiet",
    "-m",
    "actual source",
  ]);
  const first = await f.source.capture(f.workspace, f.signal);
  assert.equal(first.metadata.completeness, "full");
  execFileSync("git", [
    "-C",
    f.root,
    "checkout",
    "--quiet",
    "-b",
    "actual-other-branch",
  ]);
  const changed = await f.source.capture(f.workspace, f.signal);
  assert.equal(changed.metadata.completeness, "full");
  assert.notEqual(changed.metadata.sha256, first.metadata.sha256);
  await assert.rejects(
    f.source.assertFresh(first.capture, f.signal),
    error("EXECUTION_SOURCE_STALE"),
  );
});

test("exact host storage exclusions ignore own bytes while ordinary sibling files and exclusion physical directories stay source-bound", async (t) => {
  const f = fixture(t),
    directory = join(f.root, "native-artifacts"),
    database = join(f.root, "native.sqlite");
  mkdirSync(directory);
  writeFileSync(database, "database-before");
  writeFileSync(join(directory, "native.json"), "native-before");
  writeFileSync(join(f.root, "user.ts"), "user-before");
  const source = new WorkspaceExecutionSource({
    checkWorkspaceBinding: () => {},
    excludedPaths: [
      { path: directory, kind: "directory" },
      { path: database, kind: "file" },
      { path: `${database}-wal`, kind: "file" },
    ],
  });
  t.after(() => source.close());
  const first = await source.capture(f.workspace, f.signal);
  assert.equal(first.metadata.completeness, "full");
  assert.equal(first.metadata.fileCount, 1);
  writeFileSync(database, "database-after-with-a-different-size");
  writeFileSync(`${database}-wal`, "actual engine WAL creation");
  writeFileSync(join(directory, "native.json"), "actual changed bookkeeping");
  const same = await source.capture(f.workspace, f.signal);
  assert.equal(same.metadata.completeness, "full");
  assert.equal(same.metadata.sha256, first.metadata.sha256);
  writeFileSync(join(f.root, "user.ts"), "actual different user source");
  await assert.rejects(
    source.assertFresh(first.capture, f.signal),
    error("EXECUTION_SOURCE_STALE"),
  );
  rmSync(directory, { recursive: true });
  symlinkSync(f.base, directory);
  const unsafe = await source.capture(f.workspace, f.signal);
  assert.equal(unsafe.metadata.completeness, "unknown");
  assert.equal(unsafe.metadata.sha256, null);
});

test("byte, file, entry and depth ceilings return unknown rather than a partial source identity", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "one.txt"), "one");
  writeFileSync(join(f.root, "two.txt"), "two");
  for (const limits of [
    { files: 1 },
    { fileBytes: 1 },
    { bytes: 1 },
    { entries: 1 },
  ]) {
    const source = new WorkspaceExecutionSource({
      checkWorkspaceBinding: () => {},
      limits,
    });
    const observed = await source.capture(f.workspace, f.signal);
    assert.equal(observed.metadata.completeness, "unknown");
    assert.equal(observed.metadata.sha256, null);
    await assert.rejects(
      source.assertFresh(observed.capture, f.signal),
      error("EXECUTION_SOURCE_UNKNOWN"),
    );
    await source.close();
  }
  mkdirSync(join(f.root, "a", "b"), { recursive: true });
  writeFileSync(join(f.root, "a", "b", "deep.txt"), "deep");
  const source = new WorkspaceExecutionSource({
    checkWorkspaceBinding: () => {},
    limits: { depth: 1 },
  });
  t.after(() => source.close());
  assert.equal(
    (await source.capture(f.workspace, f.signal)).metadata.completeness,
    "unknown",
  );
});

test("symlink and hardlinked sources remain unknown without following an outside file", async (t) => {
  const f = fixture(t),
    outside = join(f.base, "outside.txt");
  writeFileSync(outside, "private outside data that may never be selected");
  symlinkSync(outside, join(f.root, "source.txt"));
  const linked = await f.source.capture(f.workspace, f.signal);
  assert.equal(linked.metadata.completeness, "unknown");
  assert.equal(linked.metadata.sha256, null);
  rmSync(join(f.root, "source.txt"));
  linkSync(outside, join(f.root, "source.txt"));
  const hardlinked = await f.source.capture(f.workspace, f.signal);
  assert.equal(hardlinked.metadata.completeness, "unknown");
  assert.equal(hardlinked.metadata.sha256, null);
  assert.equal(
    readFileSync(outside, "utf8"),
    "private outside data that may never be selected",
  );
});

test("a real source edit inside final host binding validation cannot become a full capture", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "source.txt"), "before");
  let checks = 0;
  const source = new WorkspaceExecutionSource({
    checkWorkspaceBinding() {
      if (++checks === 2)
        writeFileSync(
          join(f.root, "source.txt"),
          "actual changed after the reads",
        );
    },
  });
  t.after(() => source.close());
  const observed = await source.capture(f.workspace, f.signal);
  assert.equal(checks, 2);
  assert.equal(observed.metadata.completeness, "unknown");
  assert.equal(observed.metadata.sha256, null);
});

test("original cancellation and close join owned producer reads before rejecting; request timeout is unknown", async (t) => {
  const f = fixture(t);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    f.source.capture(f.workspace, cancelled.signal),
    error("CANCELLED"),
  );
  const abort = new AbortController(),
    actual = f.source.capture(f.workspace, abort.signal);
  abort.abort();
  await assert.rejects(actual, error("CANCELLED"));
  await f.source.join();
  const source = new WorkspaceExecutionSource({
    checkWorkspaceBinding: () => {},
    limits: { durationMs: 1 },
  });
  const bounded = await source.capture(f.workspace, f.signal);
  assert.equal(bounded.metadata.completeness, "unknown");
  assert.equal(bounded.metadata.sha256, null);
  await source.close();
  const original = f.source.capture(f.workspace, f.signal),
    close = f.source.close();
  await assert.rejects(original, error("CANCELLED"));
  await close;
  await assert.rejects(
    f.source.capture(f.workspace, f.signal),
    error("CANCELLED"),
  );
});

test("capture capacity reserves original concurrent work and released or foreign handles confer no observation identity", async (t) => {
  const f = fixture(t);
  const pending = Array.from({ length: 8 }, () =>
    f.source.capture(f.workspace, f.signal),
  );
  await assert.rejects(
    f.source.capture(f.workspace, f.signal),
    error("EXECUTION_SOURCE_CAPACITY"),
  );
  const captured = await Promise.all(pending);
  const foreign = new WorkspaceExecutionSource({
    checkWorkspaceBinding: () => {},
  });
  t.after(() => foreign.close());
  assert.throws(
    () => foreign.getSnapshot(captured[0]!.capture),
    error("EXECUTION_SOURCE_CAPTURE_INVALID"),
  );
  await f.source.close();
  assert.throws(
    () => f.source.getSnapshot(captured[0]!.capture),
    error("EXECUTION_SOURCE_CAPTURE_INVALID"),
  );
});

test("malformed host options, workspace accessors/proxies and nested exclusion accessors invoke no traps", async (t) => {
  const f = fixture(t);
  let traps = 0;
  const accessor = Object.defineProperty({}, "checkWorkspaceBinding", {
    get() {
      traps++;
      return () => {};
    },
  });
  assert.throws(
    () =>
      new WorkspaceExecutionSource(accessor as WorkspaceExecutionSourceOptions),
    error("INVALID_EXECUTION_SOURCE"),
  );
  const proxy = new Proxy(f.workspace, {
    ownKeys() {
      traps++;
      return [];
    },
    get() {
      traps++;
      return "trap";
    },
  });
  assert.throws(
    () => f.source.capture(proxy, f.signal),
    error("INVALID_EXECUTION_SOURCE"),
  );
  const nested = [
    { path: join(f.root, "native.sqlite"), kind: "file" as const },
  ];
  Object.defineProperty(nested, 0, {
    get() {
      traps++;
      return {};
    },
  });
  assert.throws(
    () =>
      new WorkspaceExecutionSource({
        checkWorkspaceBinding: () => {},
        excludedPaths: nested,
      }),
    error("INVALID_EXECUTION_SOURCE"),
  );
  assert.throws(
    () =>
      new WorkspaceExecutionSource({
        checkWorkspaceBinding: () => {},
        limits: { files: 1025 },
      }),
    error("INVALID_EXECUTION_SOURCE_LIMIT"),
  );
  assert.equal(traps, 0);
});

test("requested path coverage excludes Git metadata and exact host storage aliases without reading or observing any producer", async (t) => {
  const f = fixture(t),
    directory = join(f.root, "owned-artifacts"),
    database = join(f.root, "owned.sqlite");
  let bindingCalls = 0;
  const source = new WorkspaceExecutionSource({
    checkWorkspaceBinding() {
      bindingCalls++;
      throw new Error("No binding callbacks during path scope decisions");
    },
    excludedPaths: [
      { path: directory, kind: "directory" },
      { path: database, kind: "file" },
      { path: `${database}-wal`, kind: "file" },
      { path: join(f.base, "outside-owned"), kind: "directory" },
    ],
  });
  t.after(() => source.close());
  for (const path of [
    "source.ts",
    "./source.ts",
    "src//file.ts",
    "owned-artifacts-sibling/file.ts",
    "owned.sqlite-source",
    "한글😀.txt",
  ]) {
    assert.equal(source.coversWorkspacePath(f.workspace, path), true, path);
  }
  for (const path of [
    ".git",
    ".git/index",
    "./.git/objects/ab",
    "nested/.Git/private",
    "nested//.GIT//private",
    "owned-artifacts",
    "./owned-artifacts/file.json",
    "OWNED-ARTIFACTS/record",
    "owned.sqlite",
    "./OWNED.SQLITE",
    "owned.sqlite-wal",
    "owned.sqlite/child",
    ".",
    "",
    "../source.ts",
    "src/../source.ts",
    join(f.root, "source.ts"),
    "C:\\source.ts",
    "src\\file.ts",
    "src\nfile.ts",
  ]) {
    assert.equal(source.coversWorkspacePath(f.workspace, path), false, path);
  }
  assert.equal(
    source.coversWorkspacePath(f.workspace, ".", true),
    false,
    "A recursive root scan contains actual excluded engine storage",
  );
  assert.equal(source.coversWorkspacePath(f.workspace, "src", true), true);
  const scoped = new WorkspaceExecutionSource({
    checkWorkspaceBinding() {
      bindingCalls++;
    },
    excludedPaths: [
      { path: join(f.root, "src", "private", "native.sqlite"), kind: "file" },
    ],
  });
  t.after(() => scoped.close());
  assert.equal(scoped.coversWorkspacePath(f.workspace, "src", true), false);
  assert.equal(
    scoped.coversWorkspacePath(f.workspace, "src//private", true),
    false,
  );
  assert.equal(scoped.coversWorkspacePath(f.workspace, "SRC", true), false);
  assert.equal(scoped.coversWorkspacePath(f.workspace, "src/user.ts"), true);
  const outside = new WorkspaceExecutionSource({
    checkWorkspaceBinding() {
      bindingCalls++;
    },
    excludedPaths: [{ path: join(f.base, "outside-owned"), kind: "directory" }],
  });
  t.after(() => outside.close());
  assert.equal(outside.coversWorkspacePath(f.workspace, ".", true), true);
  assert.equal(bindingCalls, 0);
});

test("requested path scope rejects malformed owner and path values without getters, proxy traps or physical freshness calls", async (t) => {
  const f = fixture(t);
  let traps = 0;
  const accessor = { ...f.workspace };
  Object.defineProperty(accessor, "root", {
    get() {
      traps++;
      throw new Error("Getter is not a source capability");
    },
  });
  const proxy = new Proxy(f.workspace, {
    get() {
      traps++;
      throw new Error("Proxy");
    },
    ownKeys() {
      traps++;
      throw new Error("Proxy");
    },
  });
  assert.equal(f.source.coversWorkspacePath(accessor, "source.ts"), false);
  assert.equal(f.source.coversWorkspacePath(proxy, "source.ts"), false);
  assert.equal(f.source.coversWorkspacePath(f.workspace, {} as string), false);
  assert.equal(
    f.source.coversWorkspacePath(
      f.workspace,
      "source.ts",
      "recursive" as unknown as boolean,
    ),
    false,
  );
  assert.equal(
    f.source.coversWorkspacePath(f.workspace, "x".repeat(4097)),
    false,
  );
  assert.equal(traps, 0);
});
