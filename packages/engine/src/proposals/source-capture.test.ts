import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import fsPromises, { link, symlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EngineError } from "@moodcode/contracts";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  ProposalSourceCaptureHost,
  type PreparedProposalSourceCapture,
  type ProposalSourceOperation,
} from "./source-capture.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
function fixture(t: TestContext) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-proposal-source-")),
    ),
    root = join(base, "workspace");
  mkdirSync(root);
  const stat = lstatSync(root, { bigint: true });
  const binding: KnowledgeHostBinding = Object.freeze({
    workspaceId: "actual-source-workspace",
    root,
    rootDevice: stat.dev.toString(),
    rootInode: stat.ino.toString(),
    storageBindingSha256: sha("actual-host-storage"),
  });
  const host = new ProposalSourceCaptureHost({ checkBinding: () => binding });
  t.after(async () => {
    await host.close();
    rmSync(base, { recursive: true, force: true });
  });
  return { base, root, binding, host };
}
test("actual selected UTF-8 descriptor preimages and absent parents are immutable observations with no filesystem effects", async (t) => {
  const f = fixture(t),
    before = "\ufeffline 한글😀\r\nlast\n";
  writeFileSync(join(f.root, "present.ts"), before);
  const capture = await f.host.capture(f.binding, [
    { path: "present.ts", expectedSha256: sha(before), after: "changed\n" },
    { path: "new/sub/file.ts", expectedSha256: null, after: "unapplied" },
  ]);
  const snapshot = f.host.read(capture);
  assert.equal(snapshot.operations[0]!.before, before);
  assert.equal(snapshot.operations[1]!.before, null);
  assert.equal(snapshot.manifest.fileCount, 2);
  assert.deepEqual(snapshot.manifest.files[1]!.missingParents, [
    "new",
    "new/sub",
  ]);
  assert.equal(
    snapshot.manifest.sha256,
    knowledgeHash({
      binding: f.binding,
      ...Object.fromEntries(
        Object.entries(snapshot.manifest).filter(([key]) => key !== "sha256"),
      ),
    }),
  );
  assert.throws(() => lstatSync(join(f.root, "new")));
  assert.equal(readFileSync(join(f.root, "present.ts"), "utf8"), before);
  assert.ok(Object.isFrozen(snapshot.operations[0]));
  f.host.assertFreshSync(capture);
  await f.host.assertStoredManifestCurrent(f.binding, snapshot.manifest);
  f.host.release(capture);
  assert.throws(
    () => f.host.read(capture),
    code("PROPOSAL_SOURCE_CAPTURE_INVALID"),
  );
  // Durable native metadata can be physically checked after releasing the ephemeral append capability.
  f.host.assertStoredManifestCurrentSync(f.binding, snapshot.manifest);
});

test("concurrent capture reservations enforce the bound without evicting an earlier live capability", async (t) => {
  const f = fixture(t),
    held: PreparedProposalSourceCapture[] = [];
  for (let index = 0; index < 255; index++)
    held.push(
      await f.host.capture(f.binding, [
        { path: `absent-${index}`, expectedSha256: null, after: "pending" },
      ]),
    );
  const admitted = f.host.capture(f.binding, [
    { path: "last", expectedSha256: null, after: "pending" },
  ]);
  assert.throws(
    () =>
      f.host.capture(f.binding, [
        { path: "over-cap", expectedSha256: null, after: "pending" },
      ]),
    code("PROPOSAL_SOURCE_LIMIT"),
  );
  held.push(await admitted);
  f.host.assertFreshSync(held[0]!);
  assert.equal(f.host.read(held[0]!).operations[0]!.path, "absent-0");
  f.host.release(held.pop()!);
  const replacement = await f.host.capture(f.binding, [
    { path: "replacement", expectedSha256: null, after: "pending" },
  ]);
  f.host.release(replacement);
  for (const original of held) f.host.release(original);
});
test("external edits reject original fresh checks while captured before/after remain exact historical bytes", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "a"), "old");
  const original = await f.host.capture(f.binding, [
      { path: "a", expectedSha256: sha("old"), after: "new" },
    ]),
    snapshot = f.host.read(original);
  assert.throws(
    () => f.host.read({ ...original }),
    code("PROPOSAL_SOURCE_CAPTURE_INVALID"),
  );
  writeFileSync(join(f.root, "a"), "external");
  assert.throws(
    () => f.host.assertFreshSync(original),
    code("PROPOSAL_SOURCE_STALE"),
  );
  await assert.rejects(
    f.host.assertStoredManifestCurrent(f.binding, snapshot.manifest),
    code("PROPOSAL_SOURCE_STALE"),
  );
  assert.deepEqual(snapshot.operations, [
    { path: "a", before: "old", after: "new" },
  ]);
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), "external");
});
test("new parent and physical root movement invalidate exact absent preimages and root identities", async (t) => {
  const f = fixture(t),
    capture = await f.host.capture(f.binding, [
      { path: "absent/a", expectedSha256: null, after: "new" },
    ]);
  mkdirSync(join(f.root, "absent"));
  assert.throws(
    () => f.host.assertFreshSync(capture),
    code("PROPOSAL_SOURCE_STALE"),
  );
  renameSync(f.root, join(f.base, "old-root"));
  mkdirSync(f.root);
  assert.throws(
    () => f.host.assertFreshSync(capture),
    code("PROPOSAL_SOURCE_BINDING_CHANGED"),
  );
});
test("actual symlink, parent symlink, hardlink, binary and oversized preimages never issue a source capability", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "original"), "actual");
  await symlink("original", join(f.root, "alias"));
  await assert.rejects(
    f.host.capture(f.binding, [
      { path: "alias", expectedSha256: sha("actual"), after: "new" },
    ]),
    code("PROPOSAL_SOURCE_UNSAFE"),
  );
  mkdirSync(join(f.root, "real"));
  writeFileSync(join(f.root, "real", "a"), "actual");
  await symlink("real", join(f.root, "parent"));
  await assert.rejects(
    f.host.capture(f.binding, [
      { path: "parent/a", expectedSha256: sha("actual"), after: "new" },
    ]),
    code("PROPOSAL_SOURCE_UNSAFE"),
  );
  await link(join(f.root, "original"), join(f.root, "hard"));
  await assert.rejects(
    f.host.capture(f.binding, [
      { path: "original", expectedSha256: sha("actual"), after: "new" },
    ]),
    code("PROPOSAL_SOURCE_UNSAFE"),
  );
  writeFileSync(join(f.root, "binary"), Buffer.from([0xc0, 0xaf]));
  await assert.rejects(
    f.host.capture(f.binding, [
      { path: "binary", expectedSha256: sha("unused"), after: "new" },
    ]),
    code("PROPOSAL_SOURCE_UNSAFE"),
  );
  writeFileSync(join(f.root, "large"), "a".repeat(1_048_577));
  await assert.rejects(
    f.host.capture(f.binding, [
      { path: "large", expectedSha256: sha("unused"), after: "new" },
    ]),
    code("PROPOSAL_SOURCE_UNSAFE"),
  );
});
test("hostile getters, proxies, sparse operations, path conflicts and malformed UTF-8 reject before observations", (t) => {
  const f = fixture(t);
  let calls = 0;
  const hostile = Object.defineProperty(
    { expectedSha256: null, after: "new" },
    "path",
    {
      enumerable: true,
      get() {
        calls++;
        return "a";
      },
    },
  );
  assert.throws(() =>
    f.host.capture(f.binding, [hostile as ProposalSourceOperation]),
  );
  const proxy = new Proxy(
    { path: "a", expectedSha256: null, after: "new" },
    {
      get() {
        calls++;
        throw Error("trap");
      },
      getPrototypeOf() {
        calls++;
        throw Error("trap");
      },
      ownKeys() {
        calls++;
        throw Error("trap");
      },
    },
  );
  assert.throws(() => f.host.capture(f.binding, [proxy]));
  assert.equal(calls, 0);
  assert.throws(() =>
    f.host.capture(f.binding, new Array(1) as ProposalSourceOperation[]),
  );
  assert.throws(() =>
    f.host.capture(f.binding, [
      { path: "a", expectedSha256: null, after: "x" },
      { path: "A", expectedSha256: null, after: "y" },
    ]),
  );
  assert.throws(() =>
    f.host.capture(f.binding, [
      { path: "a", expectedSha256: null, after: "\ud800" },
    ]),
  );
  assert.throws(() =>
    f.host.capture(f.binding, [
      { path: "a", expectedSha256: null, after: "x" },
      { path: "a/b", expectedSha256: null, after: "y" },
    ]),
  );
});
test("wrong expected hash and aggregate before/after budget reject without modifying original files", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "a"), "old");
  await assert.rejects(
    f.host.capture(f.binding, [
      { path: "a", expectedSha256: sha("wrong"), after: "new" },
    ]),
    code("PROPOSAL_SOURCE_PREIMAGE_MISMATCH"),
  );
  const body = "a".repeat(524_288),
    after = "b".repeat(524_289),
    operations: ProposalSourceOperation[] = [];
  for (let i = 0; i < 8; i++) {
    writeFileSync(join(f.root, `file${i}`), body);
    operations.push({ path: `file${i}`, expectedSha256: sha(body), after });
  }
  await assert.rejects(
    f.host.capture(f.binding, operations),
    code("PROPOSAL_SOURCE_LIMIT"),
  );
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), "old");
  assert.equal(readFileSync(join(f.root, "file7"), "utf8"), body);
});
test("cancellation and close join the original actual opened descriptor before settling", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "a"), "actual");
  const originalOpen = fsPromises.open;
  let release!: () => void, ready!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    opened = new Promise<void>((r) => (ready = r));
  let handle: Awaited<ReturnType<typeof originalOpen>> | undefined;
  const mocked = t.mock.method(
    fsPromises,
    "open",
    async (...args: Parameters<typeof originalOpen>) => {
      handle = await originalOpen(...args);
      ready();
      await gate;
      return handle;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  const pending = f.host.capture(f.binding, [
    { path: "a", expectedSha256: sha("actual"), after: "new" },
  ]);
  const rejected = assert.rejects(pending, code("PROPOSAL_SOURCE_CANCELLED"));
  await opened;
  let closed = false;
  const closing = f.host.close().then(() => (closed = true));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, false);
  assert.equal((await handle!.stat()).size, 6);
  release();
  await rejected;
  await closing;
  await assert.rejects(handle!.stat());
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), "actual");
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      f.host.capture(
        f.binding,
        [{ path: "missing", expectedSha256: null, after: "new" }],
        controller.signal,
      ),
    code("PROPOSAL_SOURCE_CANCELLED"),
  );
});
