import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
  mkdir,
  writeFile,
  readFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { SqliteStore } from "../storage/index.js";
import { openWorkspace } from "../workspace/index.js";
import { WorktreeManager } from "./index.js";
const signal = () => new AbortController().signal;
const code = (expected: string) => (e: unknown) => {
  assert.equal((e as { code: string }).code, expected);
  return true;
};
async function fixture(t: test.TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "moodcode-worktrees-")),
  );
  const repo = join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
  execFileSync("git", [
    "-C",
    repo,
    "config",
    "user.email",
    "fixture@example.invalid",
  ]);
  await writeFile(join(repo, "a"), "base");
  execFileSync("git", ["-C", repo, "add", "a"]);
  execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "fixture base"]);
  const store = new SqliteStore(join(root, "state.sqlite"));
  const workspace = await openWorkspace(repo);
  store.putWorkspace(workspace);
  const session = store.createSession({
    id: "s",
    workspaceId: workspace.id,
    title: "fixture",
    createdAt: new Date().toISOString(),
  });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const directory = join(root, "managed");
  const manager = new WorktreeManager({ directory, documents: store });
  return { root, repo, workspace, session, store, manager, directory };
}
test("real Git detached worktree create records creating/boot/ready and preserves parent dirty edits", async (t) => {
  const { manager, repo, workspace, store, session, directory } =
    await fixture(t);
  await writeFile(join(repo, "a"), "parent user edit");
  let bootState = "";
  const bootManager = new WorktreeManager({
    directory,
    documents: store,
    async boot(record) {
      bootState = record.state;
      assert.equal(await readFile(join(record.root, "a"), "utf8"), "base");
    },
  });
  const input = { sessionId: session.id, requestId: "create-1", workspace };
  const result = await bootManager.create(input, signal());
  assert.equal(result.state, "ready");
  assert.equal(bootState, "booting");
  assert.equal(await readFile(join(repo, "a"), "utf8"), "parent user edit");
  assert.equal((await manager.create(input, signal())).id, result.id);
  assert.equal(
    spawnSync("git", [
      "-C",
      result.root,
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]).status,
    1,
  );
});
test("worktree identity survives manager restart and clean cleanup is idempotent", async (t) => {
  const { manager, workspace, session, directory, store } = await fixture(t);
  const record = await manager.create(
    { sessionId: session.id, requestId: "create", workspace },
    signal(),
  );
  const restarted = new WorktreeManager({ directory, documents: store });
  assert.equal(
    (await restarted.verify(restarted.get(session.id, record.id), signal()))
      .root,
    record.root,
  );
  const removed = await restarted.cleanup(session.id, record.id, signal());
  assert.equal(removed.state, "removed");
  await assert.rejects(access(record.root));
  assert.equal(
    (await restarted.cleanup(session.id, record.id, signal())).state,
    "removed",
  );
});
test("dirty/untracked/ignored files and moved history are preserved during cleanup", async (t) => {
  const { manager, workspace, session } = await fixture(t);
  const record = await manager.create(
    { sessionId: session.id, requestId: "create", workspace },
    signal(),
  );
  await writeFile(join(record.root, "user"), "keep");
  await assert.rejects(
    manager.cleanup(session.id, record.id, signal()),
    code("WORKTREE_DIRTY"),
  );
  assert.equal(await readFile(join(record.root, "user"), "utf8"), "keep");
  execFileSync("git", ["-C", record.root, "add", "user"]);
  execFileSync("git", [
    "-C",
    record.root,
    "commit",
    "--quiet",
    "-m",
    "user commit",
  ]);
  await assert.rejects(
    manager.cleanup(session.id, record.id, signal()),
    code("WORKTREE_HISTORY_CHANGED"),
  );
  assert.equal(await readFile(join(record.root, "user"), "utf8"), "keep");
});
test("failed boot keeps prepared Git worktree and records failure distinctly from readiness", async (t) => {
  const { workspace, session, directory, store } = await fixture(t);
  const manager = new WorktreeManager({
    directory,
    documents: store,
    async boot() {
      throw new Error("private fixture diagnostic");
    },
  });
  await assert.rejects(
    manager.create(
      { sessionId: session.id, requestId: "create", workspace },
      signal(),
    ),
    code("WORKTREE_BOOT_FAILED"),
  );
  const record = manager.list(session.id)[0]!;
  assert.equal(record.state, "failed");
  assert.equal(await readFile(join(record.root, "a"), "utf8"), "base");
  assert.ok(!JSON.stringify(record).includes("private fixture"));
  await manager.cleanup(session.id, record.id, signal());
});
test("durable interrupted preparation becomes uncertain without automatic Git replay", async (t) => {
  const { manager, workspace, session, store } = await fixture(t);
  const record = await manager.create(
    { sessionId: session.id, requestId: "create", workspace },
    signal(),
  );
  const saved = store.getSessionDocument(session.id, "engine.worktrees")!;
  const data = saved.data;
  (data.records as unknown as { state: string }[])[0]!.state = "booting";
  store.putSessionDocument(
    session.id,
    "engine.worktrees",
    saved.revision,
    data,
  );
  const recovered = manager.recover(session.id);
  assert.equal(recovered[0]?.state, "uncertain");
  assert.equal(
    (
      await manager.create(
        { sessionId: session.id, requestId: "create", workspace },
        signal(),
      )
    ).state,
    "uncertain",
  );
  assert.equal(await readFile(join(record.root, "a"), "utf8"), "base");
});
test("invalid refs, conflicting duplicate request and inside-parent managed path fail without user effects", async (t) => {
  const { manager, workspace, session, store, repo } = await fixture(t);
  await assert.rejects(
    manager.create(
      {
        sessionId: session.id,
        requestId: "bad",
        workspace,
        reference: "--force",
      },
      signal(),
    ),
    code("INVALID_WORKTREE_REFERENCE"),
  );
  const record = await manager.create(
    { sessionId: session.id, requestId: "same", workspace },
    signal(),
  );
  await assert.rejects(
    manager.create(
      {
        sessionId: session.id,
        requestId: "same",
        workspace,
        reference: record.baseCommit,
      },
      signal(),
    ),
    code("WORKTREE_REQUEST_CONFLICT"),
  );
  const inside = new WorktreeManager({
    directory: join(repo, "managed"),
    documents: store,
  });
  await assert.rejects(
    inside.create(
      { sessionId: session.id, requestId: "inside", workspace },
      signal(),
    ),
    code("UNSAFE_WORKTREE_PATH"),
  );
  assert.equal(await readFile(join(repo, "a"), "utf8"), "base");
});
test("worktree boot cancellation and timeout preserve files and an uncertain durable state", async (t) => {
  const { workspace, session, directory, store } = await fixture(t);
  let entered!: () => void;
  let settle!: () => void;
  let bootSignal!: AbortSignal;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const manager = new WorktreeManager({
    directory,
    documents: store,
    async boot(_, signal) {
      bootSignal = signal;
      entered();
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
    },
  });
  const controller = new AbortController();
  const pending = manager.create(
    { sessionId: session.id, requestId: "cancel", workspace },
    controller.signal,
  );
  await entry;
  controller.abort();
  await assert.rejects(pending, code("CANCELLED"));
  assert.equal(bootSignal.aborted, true);
  assert.equal(manager.list(session.id)[0]?.state, "uncertain");
  settle();
  await manager.close();
  const timed = new WorktreeManager({
    directory,
    documents: store,
    bootTimeoutMs: 10,
    async boot(_, signal) {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  });
  await assert.rejects(
    timed.create(
      { sessionId: session.id, requestId: "timeout", workspace },
      signal(),
    ),
    code("WORKTREE_BOOT_TIMEOUT"),
  );
  assert.equal(timed.list(session.id).at(-1)?.state, "uncertain");
  await timed.close();
});
test("a caller cannot substitute the owned worktree base identity during verification", async (t) => {
  const { manager, workspace, session } = await fixture(t);
  const record = await manager.create(
    { sessionId: session.id, requestId: "create", workspace },
    signal(),
  );
  await assert.rejects(
    manager.verify({ ...record, baseRoot: "/unrelated" }, signal()),
    code("WORKTREE_OWNER_MISMATCH"),
  );
});
test("concurrent identical worktree requests record one Git preparation and one stable identity", async (t) => {
  const { manager, workspace, session } = await fixture(t);
  const input = { sessionId: session.id, requestId: "same", workspace };
  const [first, second] = await Promise.all([
    manager.create(input, signal()),
    manager.create(input, signal()),
  ]);
  assert.equal(first.id, second.id);
  assert.equal(manager.list(session.id).length, 1);
  assert.equal(manager.get(session.id, first.id).state, "ready");
});
