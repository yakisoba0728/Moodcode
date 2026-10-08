import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { batchFixture, patch, hash, until } from "./fixtures/batch.js";
test("actual independently approved disjoint file effects overlap and retain native per-member proofs", async (t) => {
  const f = await batchFixture(t);
  const opened = fs.open.bind(fs);
  const entered = new Set<string>();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  t.after(() => release());
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await opened(...args);
    if (
      typeof args[0] === "string" &&
      [join(f.root, "a.txt"), join(f.root, "b.txt")].includes(args[0]) &&
      typeof args[1] === "number" &&
      (args[1] & 2) === 2
    ) {
      const write = handle.write.bind(handle);
      handle.write = (async (...input: unknown[]) => {
        entered.add(String(args[0]));
        await gate;
        return Reflect.apply(write, handle, input);
      }) as typeof handle.write;
    }
    return handle;
  });
  const receipt = await f.submit();
  await until(
    () =>
      f.pending().length === 2 ||
      ["failed", "completed", "cancelled"].includes(
        f.engine.store.getRun(receipt.runId).state,
      ),
    "Both exact prepared members must request separate approvals",
  );
  assert.equal(
    f.pending().length,
    2,
    JSON.stringify(f.engine.store.getSnapshot(f.session.id)),
  );
  assert.equal(f.records()[0]!.mode, "parallel");
  f.approve();
  await until(
    () => entered.size === 2,
    "Both genuine writable file handles must enter before either write is released",
  );
  assert.equal(
    f.engine.store
      .getSnapshot(f.session.id)
      .tools.filter((c) => c.state === "running").length,
    2,
  );
  release();
  const run = await f.engine.coordinator.waitForRun(receipt.runId);
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "A");
  assert.equal(readFileSync(join(f.root, "b.txt"), "utf8"), "B");
  const r = f.records()[0]!;
  assert.equal(r.state, "completed");
  assert.ok(
    r.members.every(
      (m) =>
        m.cleanupConfirmed === true &&
        m.approvalId &&
        m.checkpointIds.length === 1,
    ),
  );
  assert.equal(r.budget.toolCalls, 2);
  assert.ok(r.lockEpoch);
});
test("same resource across different producers serializes exact prepared tuples and rejects changed preimage", async (t) => {
  const edit = {
    id: "edit",
    name: "edit_file",
    input: {
      path: "a.txt",
      expectedHash: hash("a"),
      oldString: "a",
      newString: "second",
    },
  };
  const f = await batchFixture(t, {
    calls: [patch("patch", "a.txt", "a", "first"), edit],
  });
  const receipt = await f.submit();
  await until(
    () =>
      f.pending().length === 2 ||
      ["failed", "completed", "cancelled"].includes(
        f.engine.store.getRun(receipt.runId).state,
      ),
    "Separate approval requests",
  );
  assert.equal(
    f.pending().length,
    2,
    JSON.stringify(f.engine.store.getSnapshot(f.session.id)),
  );
  f.approve();
  const run = await f.engine.coordinator.waitForRun(receipt.runId);
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "first");
  const r = f.records()[0]!;
  assert.equal(r.mode, "serial");
  assert.equal(r.members[0]!.state, "completed");
  assert.equal(r.members[1]!.state, "failed");
  assert.ok(r.members[0]!.endedAt! <= r.members[1]!.endedAt!);
  assert.equal(r.members[1]!.checkpointIds.length, 0);
});
test("native group admission rollback precedes every approval and physical effect", async (t) => {
  const f = await batchFixture(t);
  const db = new DatabaseSync(f.dbPath);
  db.exec(
    "CREATE TRIGGER fail_effect_batch BEFORE INSERT ON session_documents WHEN NEW.kind GLOB 'effect.batch.*' BEGIN SELECT RAISE(ABORT,'effect admission fault'); END",
  );
  db.close();
  const receipt = await f.submit();
  await f.engine.coordinator.waitForRun(receipt.runId);
  assert.equal(f.records().length, 0);
  assert.equal(f.pending().length, 0);
  assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "a");
  assert.equal(readFileSync(join(f.root, "b.txt"), "utf8"), "b");
});
test("late member approval after parent cancellation cannot dispatch", async (t) => {
  const f = await batchFixture(t);
  const receipt = await f.submit();
  await until(
    () =>
      f.pending().length === 2 ||
      ["failed", "completed", "cancelled"].includes(
        f.engine.store.getRun(receipt.runId).state,
      ),
    "Two pending approvals",
  );
  assert.equal(
    f.pending().length,
    2,
    JSON.stringify(f.engine.store.getSnapshot(f.session.id)),
  );
  const pending = f.pending();
  f.engine.coordinator.cancel(receipt.runId);
  for (const a of pending)
    assert.throws(() =>
      f.engine.approvals.decide(a.id, "allow", a.fingerprint),
    );
  await f.engine.coordinator.waitForRun(receipt.runId);
  assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "a");
  assert.equal(readFileSync(join(f.root, "b.txt"), "utf8"), "b");
  assert.ok(f.records()[0]!.members.every((m) => !m.startedAt));
});
test("physical patch before failed native checkpoint remains uncertain and blocks the next conflicting effect", async (t) => {
  const f = await batchFixture(t, {
    calls: [
      patch("first", "a.txt", "a", "A"),
      patch("conflict", "a.txt", "a", "second"),
    ],
  });
  const receipt = await f.submit();
  await until(() => f.pending().length === 2, "Both members prepared");
  const db = new DatabaseSync(f.dbPath);
  db.exec(
    "CREATE TRIGGER fail_patch_checkpoint BEFORE INSERT ON checkpoints BEGIN SELECT RAISE(ABORT,'checkpoint fault'); END",
  );
  db.close();
  f.approve();
  const run = await f.engine.coordinator.waitForRun(receipt.runId);
  assert.equal(run.error?.code, "CLEANUP_UNCERTAIN");
  assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "A");
  const r = f.records()[0]!;
  assert.equal(r.state, "uncertain");
  assert.equal(r.members[0]!.cleanupConfirmed, false);
  assert.equal(r.members[1]!.startedAt, null);
  assert.equal(f.engine.store.hasUncertainWorkspace(f.workspace.id), true);
  assert.throws(() =>
    f.engine.coordinator.submit({
      sessionId: f.session.id,
      requestId: "no-replay",
      prompt: "retry is not authorized",
      config: f.config,
    }),
  );
});
test("new files and renames use serial fallback while the approved source tuple stays exact", async (t) => {
  const f = await batchFixture(t, {
    calls: [
      {
        id: "create",
        name: "apply_patch",
        input: {
          changes: [{ path: "new.txt", expectedHash: null, content: "new" }],
        },
      },
      patch("edit", "b.txt", "b", "B"),
    ],
  });
  const receipt = await f.submit();
  await until(() => f.pending().length === 2, "Prepared fallback approvals");
  assert.equal(f.records()[0]!.mode, "serial");
  assert.ok(f.records()[0]!.fallback[0]!.includes("unproved-resource-serial"));
  f.approve();
  assert.equal(
    (await f.engine.coordinator.waitForRun(receipt.runId)).state,
    "completed",
  );
  assert.equal(readFileSync(join(f.root, "new.txt"), "utf8"), "new");
  const r = f.records()[0]!;
  assert.equal(r.members[0]!.claim, null);
  assert.ok(r.members[0]!.endedAt! <= r.members[1]!.startedAt!);
});
test("a denied member does not borrow a sibling approval or reserve another tool call", async (t) => {
  const f = await batchFixture(t);
  const receipt = await f.submit();
  await until(() => f.pending().length === 2, "Prepared approvals");
  const [first, second] = f.pending();
  f.engine.approvals.decide(first!.id, "deny", first!.fingerprint);
  f.engine.approvals.decide(second!.id, "allow", second!.fingerprint);
  await f.engine.coordinator.waitForRun(receipt.runId);
  const r = f.records()[0]!;
  assert.equal(r.state, "partial");
  assert.equal(r.budget.toolCalls, 2);
  assert.equal(
    r.members.find((m) => m.toolCallId === first!.toolCallId)!.state,
    "denied",
  );
  assert.equal(
    readFileSync(join(f.root, "a.txt"), "utf8"),
    first!.toolCallId === r.members[0]!.toolCallId ? "a" : "A",
  );
});
test("replaced or symlinked source cannot dispatch while an independent unchanged sibling remains usable", async (t) => {
  for (const mode of ["replace", "symlink"] as const) {
    await t.test(mode, async (st) => {
      const f = await batchFixture(st);
      const receipt = await f.submit();
      await until(
        () => f.pending().length === 2,
        "Prepared original physical pins",
      );
      await fs.rename(join(f.root, "a.txt"), join(f.root, "old-a.txt"));
      if (mode === "replace") await fs.writeFile(join(f.root, "a.txt"), "a");
      else await fs.symlink("old-a.txt", join(f.root, "a.txt"));
      f.approve();
      const run = await f.engine.coordinator.waitForRun(receipt.runId);
      assert.equal(run.state, "completed");
      const r = f.records()[0]!;
      assert.equal(r.members[0]!.startedAt, null);
      assert.equal(r.members[1]!.state, "completed");
      assert.equal(readFileSync(join(f.root, "b.txt"), "utf8"), "B");
    });
  }
});
test("cross-path rename stays serial and invalidates a later update of the old source", async (t) => {
  const f = await batchFixture(t, {
    calls: [
      {
        id: "move",
        name: "rename_file",
        input: {
          path: "a.txt",
          destination: "moved.txt",
          expectedHash: hash("a"),
        },
      },
      patch("old-source", "a.txt", "a", "later"),
    ],
  });
  const receipt = await f.submit();
  await until(
    () => f.pending().length === 2,
    "Rename and update both need exact approval",
  );
  assert.equal(f.records()[0]!.mode, "serial");
  f.approve();
  await f.engine.coordinator.waitForRun(receipt.runId);
  assert.equal(readFileSync(join(f.root, "moved.txt"), "utf8"), "a");
  await assert.rejects(fs.stat(join(f.root, "a.txt")));
  const r = f.records()[0]!;
  assert.equal(r.members[0]!.state, "completed");
  assert.equal(r.members[1]!.startedAt, null);
  assert.equal(r.members[1]!.state, "failed");
});
test("physical execution-lock inode loss quarantines real effects and prevents a later conflicting wave", async (t) => {
  const f = await batchFixture(t, {
    calls: [
      patch("a", "a.txt", "a", "A"),
      patch("b", "b.txt", "b", "B"),
      patch("later", "a.txt", "a", "later"),
    ],
  });
  const opened = fs.open.bind(fs);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let writes = 0;
  t.after(() => release());
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const h = await opened(...args);
    if (
      typeof args[0] === "string" &&
      [join(f.root, "a.txt"), join(f.root, "b.txt")].includes(args[0]) &&
      typeof args[1] === "number" &&
      (args[1] & 2) === 2
    ) {
      const write = h.write.bind(h);
      h.write = (async (...input: unknown[]) => {
        writes++;
        await gate;
        return Reflect.apply(write, h, input);
      }) as typeof h.write;
    }
    return h;
  });
  const receipt = await f.submit();
  await until(() => f.pending().length === 3, "Three native approvals");
  f.approve();
  await until(() => writes === 2, "Both real disjoint writes entered");
  const lock = Reflect.get(f.engine, "executionLockPath") as string;
  await fs.rename(lock, `${lock}.original`);
  new DatabaseSync(lock).close();
  release();
  const run = await f.engine.coordinator.waitForRun(receipt.runId);
  assert.equal(run.error?.code, "CLEANUP_UNCERTAIN");
  const r = f.records()[0]!;
  assert.equal(r.state, "uncertain");
  assert.equal(r.members[2]!.startedAt, null);
  assert.equal(writes, 2);
  assert.equal(f.engine.store.hasUncertainWorkspace(f.workspace.id), true);
});
test("bounded larger real native tool inputs retain resource DATA without lowering the original context cap", async (t) => {
  const before = "a".repeat(140000),
    after = "A" + before.slice(1);
  const f = await batchFixture(t, {
    calls: [
      patch("large", "a.txt", before, after),
      patch("independent", "b.txt", "b", "B"),
    ],
  });
  await fs.writeFile(join(f.root, "a.txt"), before);
  f.config.limits.maxContextBytes = 1048576;
  const receipt = await f.submit();
  await until(
    () =>
      f.pending().length === 2 ||
      ["failed", "completed"].includes(
        f.engine.store.getRun(receipt.runId).state,
      ),
    "Large actual source approval",
  );
  assert.equal(
    f.pending().length,
    2,
    JSON.stringify(f.engine.store.getRun(receipt.runId)),
  );
  f.approve();
  const run = await f.engine.coordinator.waitForRun(receipt.runId);
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.equal(f.records()[0]!.state, "completed");
  assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), after);
  assert.ok(Buffer.byteLength(JSON.stringify(f.records()[0])) < 131072);
});
test("actual member descriptor cleanup uncertainty keeps its file effect and blocks a later conflict", async (t) => {
  const f = await batchFixture(t, {
    calls: [
      patch("a", "a.txt", "a", "A"),
      patch("later", "a.txt", "a", "later"),
    ],
  });
  const opened = fs.open.bind(fs);
  let actualClosed = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const h = await opened(...args);
    if (
      args[0] === join(f.root, "a.txt") &&
      typeof args[1] === "number" &&
      (args[1] & 2) === 2
    ) {
      const close = h.close.bind(h);
      h.close = async () => {
        await close();
        actualClosed = h.fd === -1;
        throw new Error("Injected missing descriptor-close acknowledgement");
      };
    }
    return h;
  });
  const receipt = await f.submit();
  await until(
    () => f.pending().length === 2,
    "Original resource member approvals",
  );
  f.approve();
  const run = await f.engine.coordinator.waitForRun(receipt.runId);
  assert.equal(run.error?.code, "CLEANUP_UNCERTAIN");
  assert.equal(actualClosed, true);
  assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "A");
  const r = f.records()[0]!;
  assert.equal(r.state, "uncertain");
  assert.equal(r.members[0]!.cleanupConfirmed, false);
  assert.equal(r.members[1]!.startedAt, null);
});
test("missing final batch receipt after genuine Tool/Part/checkpoint completion remains a blocking native debt", async (t) => {
  const f = await batchFixture(t);
  const receipt = await f.submit();
  await until(() => f.pending().length === 2, "Prepared approvals");
  const db = new DatabaseSync(f.dbPath);
  db.exec(
    "CREATE TRIGGER fail_batch_final BEFORE UPDATE ON session_documents WHEN NEW.kind GLOB 'effect.batch.*' AND json_extract(NEW.data,'$.state')='completed' BEGIN SELECT RAISE(ABORT,'final batch receipt fault'); END",
  );
  db.close();
  f.approve();
  const run = await f.engine.coordinator.waitForRun(receipt.runId);
  assert.equal(run.error?.code, "CLEANUP_UNCERTAIN");
  const r = f.records()[0]!;
  assert.equal(r.state, "running");
  assert.ok(
    r.members.every(
      (m) => m.state === "completed" && m.cleanupConfirmed === true,
    ),
  );
  assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "A");
  assert.equal(readFileSync(join(f.root, "b.txt"), "utf8"), "B");
  assert.equal(f.engine.store.hasUncertainWorkspace(f.workspace.id), true);
  assert.throws(() =>
    f.engine.coordinator.submit({
      sessionId: f.session.id,
      requestId: "receipt-replay-forbidden",
      prompt: "No replay",
      config: f.config,
    }),
  );
  assert.equal(f.entries(), 1);
});
test("actual catalogue replacement during approval invalidates every prepared resource dispatch", async (t) => {
  const f = await batchFixture(t);
  const receipt = await f.submit();
  await until(() => f.pending().length === 2, "Original catalogue approvals");
  const tool = (await import("../tools/patch/index.js")).createPatchTool();
  f.engine.toolRuntime.register("new-host-catalogue", tool);
  f.approve();
  await f.engine.coordinator.waitForRun(receipt.runId);
  assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "a");
  assert.equal(readFileSync(join(f.root, "b.txt"), "utf8"), "b");
  assert.ok(f.records()[0]!.members.every((m) => !m.startedAt));
});
test("all member output is reserved before approval and a new actual child allocation makes prepared budgets stale", async (t) => {
  const f = await batchFixture(t);
  const receipt = await f.submit();
  await until(
    () => f.pending().length === 2,
    "Reserved original member approvals",
  );
  const remaining = f.engine.coordinator.getRemainingChildBudget(receipt.runId);
  assert.ok(remaining.outputBytes <= 4096);
  f.engine.coordinator.reserveChildRun(receipt.runId, {
    turns: 1,
    toolCalls: 1,
    outputBytes: 100,
    durationMs: 1000,
  });
  f.approve();
  await f.engine.coordinator.waitForRun(receipt.runId);
  assert.ok(f.records()[0]!.members.every((m) => !m.startedAt));
  assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "a");
  assert.equal(readFileSync(join(f.root, "b.txt"), "utf8"), "b");
});
test("custom producer scope cannot gain core resource authority and executes genuine file effects serially", async (t) => {
  const real = (await import("../tools/patch/index.js")).createPatchTool();
  const f = await batchFixture(t, {
    profileTools: ["apply_patch"],
    engineOptions: { tools: [real] },
  });
  const opened = fs.open.bind(fs);
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  t.after(() => release());
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const h = await opened(...args);
    if (
      typeof args[0] === "string" &&
      [join(f.root, "a.txt"), join(f.root, "b.txt")].includes(args[0]) &&
      typeof args[1] === "number" &&
      (args[1] & 2) === 2
    ) {
      const write = h.write.bind(h);
      h.write = (async (...input: unknown[]) => {
        order.push(String(args[0]));
        if (args[0] === join(f.root, "a.txt")) await gate;
        return Reflect.apply(write, h, input);
      }) as typeof h.write;
    }
    return h;
  });
  const receipt = await f.submit();
  await until(
    () => f.pending().length === 1,
    "First serial custom-source approval",
  );
  f.approve();
  await until(() => order.length === 1, "First actual custom write");
  assert.equal(f.pending().length, 0);
  assert.equal(f.records().length, 0);
  release();
  await until(
    () => f.pending().length === 1,
    "Next approval only after actual first effect settles",
  );
  f.approve();
  assert.equal(
    (await f.engine.coordinator.waitForRun(receipt.runId)).state,
    "completed",
  );
  assert.deepEqual(order, [join(f.root, "a.txt"), join(f.root, "b.txt")]);
  assert.equal(
    f.engine.store
      .readSessionEvents(f.session.id, 0, 100)
      .filter((e) => e.type === "effect.batch.serial_fallback").length,
    2,
  );
});
test("default-off uses the existing serial producer pipeline without native batch grants", async (t) => {
  const f = await batchFixture(t, { enabled: false });
  const receipt = await f.submit();
  await until(() => f.pending().length === 1, "Default-off first approval");
  f.approve();
  await until(() => f.pending().length === 1, "Default-off second approval");
  f.approve();
  assert.equal(
    (await f.engine.coordinator.waitForRun(receipt.runId)).state,
    "completed",
  );
  assert.equal(f.records().length, 0);
  assert.equal(
    f.engine.store
      .readSessionEvents(f.session.id, 0, 100)
      .filter((e) => e.type === "effect.batch.serial_fallback").length,
    0,
  );
});

test("fixed actual member artifact shares remain bounded and mark truncation without hiding completed file effects", async (t) => {
  const f = await batchFixture(t);
  f.config.budgets = (
    await import("@moodcode/contracts/validation")
  ).normalizeEngineBudgets({ maxArtifactBytes: 32 });
  const receipt = await f.submit();
  await until(
    () => f.pending().length === 2,
    "Two exact fixed artifact allocations",
  );
  assert.equal(f.records()[0]!.budget.artifactBytes, 32);
  f.approve();
  await f.engine.coordinator.waitForRun(receipt.runId);
  const tools = f.engine.store.getSnapshot(f.session.id).tools;
  assert.equal(tools.length, 2);
  for (const tool of tools) {
    assert.equal(tool.state, "failed");
    const result = f.engine.store
      .getSnapshot(f.session.id)
      .messages.find(
        (m) =>
          m.toolCallId ===
          f
            .records()[0]!
            .members.find((member) => member.toolCallId === tool.id)!
            .providerCallId,
      )!.toolResult!;
    const refs = result.artifactRefs;
    assert.equal(refs.length, 1);
    assert.ok(refs[0]!.storedBytes <= 16);
    assert.equal(refs[0]!.complete, false);
    assert.ok(
      result.warnings.some((w) => w.includes("fixed member allocation")),
    );
  }
  const record = f.records()[0]!;
  assert.equal(record.state, "partial");
  assert.ok(
    record.members.every(
      (m) => m.cleanupConfirmed === true && m.checkpointIds.length === 1,
    ),
  );
  assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "A");
  assert.equal(readFileSync(join(f.root, "b.txt"), "utf8"), "B");
});
