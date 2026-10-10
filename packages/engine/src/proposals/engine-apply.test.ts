import assert from "node:assert/strict";
import {
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PhysicalPatchProducer } from "../tools/patch/physical.js";
import {
  acquireExecutionLock,
  inspectExecutionLock,
} from "../tools/command/execution-lock.js";
import { ProposalApplyExecutionGuards } from "./execution-guards.js";
import { knowledgeHash } from "../knowledge/validation.js";
import type { ProposalSelection } from "./types.js";
import type { ProposalReadonlyDiff } from "./overlay.js";
import type {
  ApplyProposalResult,
  ProposalApplyPreview,
} from "./apply-service.js";
import {
  AFTER,
  APPLY_TABLES,
  BEFORE,
  CREATED,
  REMOVED,
  SECOND_AFTER,
  SECOND_BEFORE,
  api,
  applyFixture,
  failure,
  nativeRows,
  readDb,
  sha,
} from "./fixtures/apply.js";

test("actual approved whole ProposalSet creates native host checkpoint and receipt, applies all images once, and creates no coding owners", async (t) => {
  const f = await applyFixture(t),
    staged = await f.stage(),
    before = nativeRows(f.dbPath, ["proposal_revisions", "proposal_blobs"]);
  const preview = await f.preview();
  assert.equal(preview.revisionId, staged.revision.id);
  assert.equal(preview.beforeHead.sha256, staged.set.sha256);
  const { sha256, ...unsigned } = preview;
  assert.equal(sha256, knowledgeHash(unsigned));
  const result = await f.apply(preview, "exact-apply");
  assert.equal(result.duplicate, false);
  assert.equal(result.owner.state, "completed");
  assert.equal(result.owner.cleanupConfirmed, true);
  assert.ok(result.checkpoint);
  assert.ok(result.receipt);
  assert.equal(result.checkpoint.partial, false);
  assert.equal(result.checkpoint.complete, true);
  assert.equal(result.checkpoint.id, result.owner.id);
  assert.equal(result.receipt.checkpointSha256, result.checkpoint.sha256);
  assert.equal(result.receipt.beforeHead.sha256, staged.set.sha256);
  assert.equal(
    result.receipt.afterHead.headRevision,
    staged.set.headRevision + 1,
  );
  assert.deepEqual(f.userBytes(), {
    "first.ts": AFTER,
    "second.ts": SECOND_AFTER,
    "new/nested.ts": CREATED,
    "remove.txt": null,
    "untouched.txt": "Unrelated user bytes.\n",
  });
  assert.equal(
    inspectExecutionLock(`${f.dbPath}.effects.sqlite`).status,
    "available",
  );
  assert.deepEqual(
    nativeRows(f.dbPath, ["proposal_revisions", "proposal_blobs"]),
    before,
  );
  assert.deepEqual(f.history("exact-apply"), {
    owner: result.owner,
    checkpoint: result.checkpoint,
    receipt: result.receipt,
  });
  const head = api<ProposalSelection>(
    f.engine,
    "getProposalSet",
    f.workspace.id,
    staged.set.id,
  );
  assert.equal(head.set.sha256, result.receipt.afterHead.sha256);
  assert.equal(
    result.checkpoint.files.every(
      (file) => file.attempted && file.observationComplete,
    ),
    true,
  );
  const diff = await api<Promise<ProposalReadonlyDiff>>(
    f.engine,
    "getProposalDiff",
    { workspaceId: f.workspace.id, proposalId: staged.set.id },
  );
  assert.equal(diff.state, "captured-history");
  assert.equal(diff.proposalStatus, "applied");
  assert.equal(diff.files[0]!.before, BEFORE);
  assert.equal(diff.files[0]!.after, AFTER);
  f.assertNoCoding();
});

test("actual explicit false approval rejects before native owner, shared lock or filesystem producer", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const preview = await f.preview(),
    bytes = f.userBytes(),
    rows = nativeRows(f.dbPath, APPLY_TABLES);
  let producer = 0;
  const original = PhysicalPatchProducer.prototype.apply;
  t.mock.method(
    PhysicalPatchProducer.prototype,
    "apply",
    function (
      this: PhysicalPatchProducer,
      ...args: Parameters<typeof original>
    ) {
      producer++;
      return original.apply(this, args);
    },
  );
  await assert.rejects(
    api<Promise<ApplyProposalResult>>(f.engine, "applyProposal", {
      workspaceId: f.workspace.id,
      requestId: "denied",
      approved: false,
      preview,
    }),
    failure("PROPOSAL_APPLY_APPROVAL_REQUIRED"),
  );
  assert.equal(producer, 0);
  assert.deepEqual(nativeRows(f.dbPath, APPLY_TABLES), rows);
  assert.deepEqual(f.userBytes(), bytes);
  f.assertNoCoding();
});

test("copied, proxy, foreign and released approvals grant no native effects or getter execution", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const preview = await f.preview(),
    bytes = f.userBytes();
  let traps = 0;
  await assert.rejects(
    f.apply(structuredClone(preview), "copy"),
    failure("PROPOSAL_APPLY_PREVIEW_INVALID"),
  );
  const proxy = new Proxy(preview, {
    get() {
      traps++;
      throw new Error("Proxy trap must not run");
    },
    ownKeys() {
      traps++;
      throw new Error("Proxy enumeration must not run");
    },
  });
  await assert.rejects(
    f.apply(proxy, "proxy"),
    failure("PROPOSAL_APPLY_PREVIEW_INVALID"),
  );
  assert.equal(traps, 0);
  const hostile = Object.defineProperty(
    { workspaceId: f.workspace.id, requestId: "getter", approved: true },
    "preview",
    {
      enumerable: true,
      get() {
        traps++;
        return preview;
      },
    },
  );
  await assert.rejects(
    api<Promise<ApplyProposalResult>>(f.engine, "applyProposal", hostile),
    failure(),
  );
  assert.equal(traps, 0);
  await assert.rejects(
    api<Promise<ApplyProposalResult>>(f.engine, "applyProposal", {
      workspaceId: "foreign-workspace",
      requestId: "foreign",
      approved: true,
      preview,
    }),
    failure("PROPOSAL_APPLY_PREVIEW_INVALID"),
  );
  api<void>(f.engine, "releaseProposalApplyPreview", preview);
  await assert.rejects(
    f.apply(preview, "released"),
    failure("PROPOSAL_APPLY_PREVIEW_USED", "PROPOSAL_APPLY_PREVIEW_INVALID"),
  );
  assert.equal(
    readDb(
      f.dbPath,
      (db) =>
        db.prepare("SELECT count(*) AS n FROM proposal_apply_owners").get()!.n,
    ),
    0,
  );
  assert.deepEqual(f.userBytes(), bytes);
  f.assertNoCoding();
});

test("exact original request returns immutable historical receipt after external edit without physical replay; new request cannot reuse approval", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const preview = await f.preview(),
    result = await f.apply(preview, "duplicate");
  const rows = nativeRows(f.dbPath, APPLY_TABLES);
  writeFileSync(
    join(f.root, "first.ts"),
    "External post-publication user edit.\n",
  );
  let producer = 0;
  const original = PhysicalPatchProducer.prototype.apply;
  t.mock.method(
    PhysicalPatchProducer.prototype,
    "apply",
    function (
      this: PhysicalPatchProducer,
      ...args: Parameters<typeof original>
    ) {
      producer++;
      return original.apply(this, args);
    },
  );
  const duplicate = await f.apply(preview, "duplicate");
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.owner, result.owner);
  assert.deepEqual(duplicate.receipt, result.receipt);
  await assert.rejects(
    f.apply(preview, "new-request"),
    failure("PROPOSAL_APPLY_PREVIEW_USED"),
  );
  assert.equal(producer, 0);
  assert.deepEqual(nativeRows(f.dbPath, APPLY_TABLES), rows);
  assert.equal(
    readFileSync(join(f.root, "first.ts"), "utf8"),
    "External post-publication user edit.\n",
  );
  f.assertNoCoding();
});

for (const boundary of ["source", "head"] as const)
  test(`original ${boundary} changed after preview rejects before host owner and physical dispatch`, async (t) => {
    const f = await applyFixture(t);
    await f.stage();
    const preview = await f.preview();
    if (boundary === "source")
      writeFileSync(join(f.root, "first.ts"), "External source replacement.\n");
    else
      await f.stage({
        expectedRevision: 1,
        changes: [
          {
            path: "first.ts",
            expectedHash: sha(BEFORE),
            content: "Different selected revision.\n",
          },
        ],
      });
    const bytes = f.userBytes();
    let producer = 0;
    const original = PhysicalPatchProducer.prototype.apply;
    t.mock.method(
      PhysicalPatchProducer.prototype,
      "apply",
      function (
        this: PhysicalPatchProducer,
        ...args: Parameters<typeof original>
      ) {
        producer++;
        return original.apply(this, args);
      },
    );
    await assert.rejects(f.apply(preview, "stale"), failure());
    assert.equal(producer, 0);
    assert.deepEqual(f.userBytes(), bytes);
    assert.equal(
      readDb(
        f.dbPath,
        (db) =>
          db.prepare("SELECT count(*) AS n FROM proposal_apply_owners").get()!
            .n,
      ),
      0,
    );
    f.assertNoCoding();
  });

test("physical workspace root replacement invalidates original approval without writing replacement root", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const preview = await f.preview(),
    old = join(f.base, "original-root");
  renameSync(f.root, old);
  mkdirSync(f.root);
  writeFileSync(join(f.root, "first.ts"), BEFORE);
  await assert.rejects(f.apply(preview, "root-changed"), failure());
  assert.equal(readFileSync(join(f.root, "first.ts"), "utf8"), BEFORE);
  assert.equal(readFileSync(join(old, "first.ts"), "utf8"), BEFORE);
  assert.equal(existsSync(join(f.root, "new")), false);
  f.assertNoCoding();
});

test("preaborted original apply and preview allocate no native apply owner or effect guard", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const preview = await f.preview(),
    abort = new AbortController();
  abort.abort();
  await assert.rejects(
    f.apply(preview, "aborted", f.engine, abort.signal),
    failure("CANCELLED", "RUN_CANCELLED"),
  );
  await assert.rejects(
    f.preview("actual-apply-set", f.engine, abort.signal),
    failure("CANCELLED", "RUN_CANCELLED"),
  );
  assert.deepEqual(
    nativeRows(f.dbPath, APPLY_TABLES),
    Object.fromEntries(APPLY_TABLES.map((table) => [table, []])),
  );
  assert.equal(f.userBytes()["first.ts"], BEFORE);
  f.assertNoCoding();
});

test("application rejects a real stored 33-file proposal before any physical preparation, owner or lock intent", async (t) => {
  const f = await applyFixture(t),
    changes = Array.from({ length: 33 }, (_, i) => ({
      path: `oversized/${i}.ts`,
      expectedHash: null,
      content: `export const actual_${i}=1;\n`,
    }));
  await f.stage({ changes });
  let prepares = 0;
  const original = PhysicalPatchProducer.prototype.prepare;
  t.mock.method(
    PhysicalPatchProducer.prototype,
    "prepare",
    function (
      this: PhysicalPatchProducer,
      ...args: Parameters<typeof original>
    ) {
      prepares++;
      return original.apply(this, args);
    },
  );
  await assert.rejects(f.preview(), failure("PROPOSAL_APPLY_UNSUPPORTED"));
  assert.equal(prepares, 0);
  assert.equal(existsSync(join(f.root, "oversized")), false);
  assert.deepEqual(
    nativeRows(f.dbPath, APPLY_TABLES),
    Object.fromEntries(APPLY_TABLES.map((table) => [table, []])),
  );
  f.assertNoCoding();
});

test("combined original and desired images above real 4MiB cap remain staged but cannot be chunked into effects", async (t) => {
  const f = await applyFixture(t),
    body = "x".repeat(800_000),
    changes = [] as {
      path: string;
      expectedHash: string | null;
      content: string | null;
    }[];
  for (let i = 0; i < 3; i++) {
    const path = `large${i}.txt`;
    writeFileSync(join(f.root, path), body);
    changes.push({
      path,
      expectedHash: sha(body),
      content: "y".repeat(800_000),
    });
  }
  const staged = await f.stage({ changes });
  assert.ok(staged.revision.totalBytes > 4 * 1024 * 1024);
  await assert.rejects(f.preview(), failure("PROPOSAL_APPLY_UNSUPPORTED"));
  for (const change of changes)
    assert.equal(readFileSync(join(f.root, change.path), "utf8"), body);
  assert.equal(
    readDb(
      f.dbPath,
      (db) =>
        db.prepare("SELECT count(*) AS n FROM proposal_apply_owners").get()!.n,
    ),
    0,
  );
  f.assertNoCoding();
});

test("real second target write followed by truncate failure preserves exact partial postimages and later untouched files in native checkpoint", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const preview = await f.preview(),
    open = fs.open.bind(fs);
  let wrote = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (
      String(args[0]) === join(f.root, "second.ts") &&
      typeof args[1] === "number" &&
      (args[1] & constants.O_RDWR) !== 0
    ) {
      const write = handle.write.bind(handle);
      t.mock.method(handle, "write", async (...writeArgs: unknown[]) => {
        const result = await Reflect.apply(write, handle, writeArgs);
        wrote = true;
        return result;
      });
      t.mock.method(handle, "truncate", async () => {
        assert.equal(wrote, true);
        throw new Error("Actual partial truncate failure after original write");
      });
    }
    return handle;
  });
  const result = await f.apply(preview, "partial");
  assert.equal(wrote, true);
  assert.equal(result.owner.state, "partial");
  assert.equal(result.owner.cleanupConfirmed, true);
  assert.ok(result.checkpoint);
  assert.ok(result.receipt);
  assert.equal(result.checkpoint.partial, true);
  assert.equal(result.checkpoint.complete, true);
  const diff = await api<Promise<ProposalReadonlyDiff>>(
    f.engine,
    "getProposalDiff",
    { workspaceId: f.workspace.id, proposalId: "actual-apply-set" },
  );
  assert.equal(diff.state, "captured-history");
  assert.equal(diff.proposalStatus, "partial");
  assert.equal(diff.files[1]!.after, SECOND_AFTER);
  const partial =
    SECOND_AFTER + SECOND_BEFORE.slice(Buffer.byteLength(SECOND_AFTER));
  assert.equal(readFileSync(join(f.root, "second.ts"), "utf8"), partial);
  assert.equal(f.userBytes()["first.ts"], AFTER);
  assert.equal(f.userBytes()["new/nested.ts"], null);
  assert.equal(f.userBytes()["remove.txt"], REMOVED);
  assert.deepEqual(
    result.checkpoint.files.map((file) => file.attempted),
    [true, true, false, false],
  );
  assert.equal(
    result.checkpoint.files.every((file) => file.observationComplete),
    true,
  );
  const second = result.checkpoint.files[1]!;
  assert.ok(second.after);
  assert.equal(second.after.sha256, sha(partial));
  assert.ok("ownerId" in second.after);
  assert.equal(second.after.ownerId, result.owner.id);
  assert.equal(
    readDb(
      f.dbPath,
      (db) =>
        db
          .prepare("SELECT content FROM proposal_effect_blobs WHERE id=?")
          .get(second.after!.id)!.content instanceof Uint8Array,
    ),
    true,
  );
  assert.equal(
    inspectExecutionLock(`${f.dbPath}.effects.sqlite`).status,
    "available",
  );
  f.assertNoCoding();
});

test("close joins an original successful pending FileHandle write through cancellation before physical descriptor cleanup", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const preview = await f.preview();
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (ready = r)),
    gate = new Promise<void>((r) => (release = r)),
    open = fs.open.bind(fs);
  let closed = false,
    held = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (
      String(args[0]) === join(f.root, "first.ts") &&
      typeof args[1] === "number" &&
      (args[1] & constants.O_RDWR) !== 0
    ) {
      const write = handle.write.bind(handle),
        close = handle.close.bind(handle);
      t.mock.method(handle, "write", async (...writeArgs: unknown[]) => {
        const result = await Reflect.apply(write, handle, writeArgs);
        if (!held) {
          held = true;
          ready();
          await gate;
        }
        return result;
      });
      t.mock.method(handle, "close", async () => {
        await close();
        closed = true;
      });
    }
    return handle;
  });
  const applying = f.apply(preview, "close-held");
  void applying.catch(() => {});
  await started;
  let closeFinished = false;
  const closing = f.engine.close().finally(() => (closeFinished = true));
  void closing.catch(() => {});
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(closeFinished, false);
    assert.equal(closed, false);
  } finally {
    release();
  }
  const result = await applying;
  assert.ok(result.checkpoint);
  assert.equal(result.checkpoint.producerCleanupConfirmed, true);
  await closing;
  assert.equal(closed, true);
  assert.equal(result.owner.state, "partial");
  assert.equal(result.owner.cleanupConfirmed, true);
  assert.equal(
    inspectExecutionLock(`${f.dbPath}.effects.sqlite`).status,
    "available",
  );
  f.assertNoCoding();
});

test("native checkpoint SQL failure retains original physical effects and uncertain owner, never silently releasing marker or replaying", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const preview = await f.preview(),
    db = Reflect.get(f.engine.store, "db");
  assert.ok(db instanceof DatabaseSync);
  const prepare = db.prepare.bind(db);
  t.mock.method(db, "prepare", (sql: string) => {
    if (sql.includes("INSERT INTO proposal_apply_checkpoints"))
      throw new Error("Actual checkpoint SQL failure");
    return prepare(sql);
  });
  f.allowUncertainClose();
  await assert.rejects(f.apply(preview, "checkpoint-failed"));
  const history = f.history("checkpoint-failed");
  assert.ok(history);
  assert.equal(history.owner.state, "uncertain");
  assert.equal(history.owner.cleanupConfirmed, false);
  assert.equal(history.checkpoint, null);
  assert.equal(history.receipt, null);
  assert.equal(f.userBytes()["first.ts"], AFTER);
  assert.equal(f.userBytes()["new/nested.ts"], CREATED);
  const lock = inspectExecutionLock(`${f.dbPath}.effects.sqlite`);
  assert.equal(lock.status, "uncertain");
  assert.ok("marker" in lock);
  assert.equal(lock.marker.active, true);
  assert.equal(lock.marker.ownerPid, process.pid);
  assert.deepEqual(
    lock.marker,
    readDb(
      f.dbPath,
      (db) =>
        JSON.parse(
          String(
            db
              .prepare(
                "SELECT data FROM proposal_apply_execution_guards WHERE owner_id=?",
              )
              .get(history.owner.id)!.data,
          ),
        ).marker,
    ),
  );
  f.assertNoCoding();
});

test("same physical restart preserves completed receipt but discards old opaque approval without effect replay", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const preview = await f.preview(),
    result = await f.apply(preview, "restart-completed"),
    rows = nativeRows(f.dbPath, APPLY_TABLES),
    bytes = f.userBytes();
  await f.engine.close();
  const reopened = f.reopen();
  assert.deepEqual(f.history("restart-completed", reopened), {
    owner: result.owner,
    checkpoint: result.checkpoint,
    receipt: result.receipt,
  });
  await assert.rejects(
    f.apply(preview, "restart-old", reopened),
    failure("PROPOSAL_APPLY_PREVIEW_INVALID"),
  );
  assert.deepEqual(nativeRows(f.dbPath, APPLY_TABLES), rows);
  assert.deepEqual(f.userBytes(), bytes);
  f.assertNoCoding();
});

test("proposalApply default off still exposes original native readonly proposal history without effect admission", async (t) => {
  const f = await applyFixture(t, false),
    staged = await f.stage(),
    bytes = f.userBytes();
  assert.equal(
    api<ProposalSelection>(
      f.engine,
      "getProposalSet",
      f.workspace.id,
      staged.set.id,
    ).revision.sha256,
    staged.revision.sha256,
  );
  await assert.rejects(f.preview(), failure());
  assert.deepEqual(f.userBytes(), bytes);
  assert.equal(f.history("never"), undefined);
  f.assertNoCoding();
});

test("concurrent original approvals for the same native head cannot create two owners or dispatch a second physical producer", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const first = await f.preview(),
    second = await f.preview(),
    untouched = await f.preview();
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (ready = r)),
    gate = new Promise<void>((r) => (release = r));
  const open = fs.open.bind(fs);
  let held = false,
    producerCalls = 0;
  const apply = PhysicalPatchProducer.prototype.apply;
  t.mock.method(
    PhysicalPatchProducer.prototype,
    "apply",
    function (this: PhysicalPatchProducer, ...args: Parameters<typeof apply>) {
      producerCalls++;
      return apply.apply(this, args);
    },
  );
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (
      String(args[0]) === join(f.root, "first.ts") &&
      typeof args[1] === "number" &&
      (args[1] & constants.O_RDWR) !== 0
    ) {
      const write = handle.write.bind(handle);
      t.mock.method(handle, "write", async (...writeArgs: unknown[]) => {
        const result = await Reflect.apply(write, handle, writeArgs);
        if (!held) {
          held = true;
          ready();
          await gate;
        }
        return result;
      });
    }
    return handle;
  });
  const applying = f.apply(first, "first-concurrent");
  void applying.catch(() => {});
  await started;
  try {
    await assert.rejects(
      f.apply(second, "second-concurrent"),
      failure("CLEANUP_PENDING", "WORKSPACE_BUSY"),
    );
    assert.equal(f.history("second-concurrent"), undefined);
    assert.equal(producerCalls, 1);
    assert.equal(
      readDb(
        f.dbPath,
        (db) =>
          db.prepare("SELECT count(*) AS n FROM proposal_apply_owners").get()!
            .n,
      ),
      1,
    );
  } finally {
    release();
  }
  const result = await applying;
  assert.equal(result.owner.state, "completed");
  await assert.rejects(
    f.apply(untouched, "third-stale"),
    failure("PROPOSAL_APPLY_STALE"),
  );
  assert.equal(producerCalls, 1);
  assert.equal(f.history("third-stale"), undefined);
  assert.equal(f.userBytes()["first.ts"], AFTER);
  f.assertNoCoding();
});

test("a failed acknowledgment of an original FileHandle close preserves its first postimage and blocks later effects without manufacturing cleanup success", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const preview = await f.preview(),
    open = fs.open.bind(fs);
  let actuallyClosed = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (
      String(args[0]) === join(f.root, "first.ts") &&
      typeof args[1] === "number" &&
      (args[1] & constants.O_RDWR) !== 0
    ) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, "close", async () => {
        await close();
        actuallyClosed = true;
        throw new Error(
          "Original close succeeded physically but completion acknowledgment failed",
        );
      });
    }
    return handle;
  });
  f.allowUncertainClose();
  const result = await f.apply(preview, "unknown-close");
  assert.equal(actuallyClosed, true);
  assert.equal(result.owner.state, "uncertain");
  assert.equal(result.owner.cleanupConfirmed, false);
  assert.ok(result.checkpoint);
  assert.ok(result.receipt);
  assert.equal(result.checkpoint.producerCleanupConfirmed, false);
  assert.equal(result.receipt.cleanupConfirmed, false);
  assert.equal(result.receipt.state, "uncertain");
  assert.equal(f.userBytes()["first.ts"], AFTER);
  assert.equal(f.userBytes()["new/nested.ts"], null);
  assert.equal(f.userBytes()["second.ts"], SECOND_BEFORE);
  assert.equal(f.userBytes()["remove.txt"], REMOVED);
  assert.deepEqual(
    result.checkpoint.files.map((file) => file.attempted),
    [true, false, false, false],
  );
  assert.equal(f.engine.store.hasUncertainWorkspace(f.workspace.id), true);
  const lock = inspectExecutionLock(`${f.dbPath}.effects.sqlite`);
  assert.equal(lock.status, "uncertain");
  assert.ok("marker" in lock);
  assert.equal(lock.marker.active, true);
  await assert.rejects(
    f.preview(),
    failure("CLEANUP_PENDING", "PROPOSAL_APPLY_NOT_PENDING"),
  );
  f.assertNoCoding();
});

test("a busy effects lock at approval cancels the owner without guard or quarantine, and the revision is never replayed", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const preview = await f.preview(),
    held = acquireExecutionLock(`${f.dbPath}.effects.sqlite`);
  try {
    await assert.rejects(
      f.apply(preview, "busy-lock"),
      failure("COMMAND_EFFECTS_BUSY"),
    );
  } finally {
    held.release(true);
  }
  const history = f.history("busy-lock");
  assert.ok(history);
  assert.equal(history.owner.state, "cancelled");
  assert.equal(history.owner.cleanupConfirmed, true);
  assert.equal(history.owner.errorCode, "COMMAND_EFFECTS_BUSY");
  assert.deepEqual(nativeRows(f.dbPath, ["proposal_apply_execution_guards"]), {
    proposal_apply_execution_guards: [],
  });
  assert.equal(f.engine.store.hasUncertainWorkspace(f.workspace.id), false);
  assert.equal(f.userBytes()["first.ts"], BEFORE);
  await assert.rejects(f.apply(await f.preview(), "busy-retry"), (error) => {
    failure("PROPOSAL_APPLY_REVISION_USED")(error);
    assert.match((error as Error).message, /append a new revision/);
    return true;
  });
  f.assertNoCoding();
});

test("a failure after the guard is reserved inside claim rolls back the guard and cancels the owner", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const preview = await f.preview(),
    readOriginal = ProposalApplyExecutionGuards.prototype.readOriginal;
  let calls = 0;
  t.mock.method(
    ProposalApplyExecutionGuards.prototype,
    "readOriginal",
    function (this: ProposalApplyExecutionGuards, original: object) {
      if (calls++ === 0)
        throw new Error("Claim validation failed after reservation");
      return readOriginal.call(this, original);
    },
  );
  await assert.rejects(f.apply(preview, "claim-failed"));
  assert.equal(calls, 1);
  const history = f.history("claim-failed");
  assert.ok(history);
  assert.equal(history.owner.state, "cancelled");
  assert.equal(history.owner.guardSha256, null);
  assert.deepEqual(nativeRows(f.dbPath, ["proposal_apply_execution_guards"]), {
    proposal_apply_execution_guards: [],
  });
  assert.equal(f.engine.store.hasUncertainWorkspace(f.workspace.id), false);
  assert.equal(f.userBytes()["first.ts"], BEFORE);
  f.assertNoCoding();
});

test("recovery acknowledgment reports a busy effects lock as retriable busy, not a guard mismatch", async (t) => {
  const f = await applyFixture(t);
  await f.stage();
  const preview = await f.preview(),
    db = Reflect.get(f.engine.store, "db");
  assert.ok(db instanceof DatabaseSync);
  const prepare = db.prepare.bind(db),
    failing = t.mock.method(db, "prepare", (sql: string) => {
      if (sql.includes("INSERT INTO proposal_apply_checkpoints"))
        throw new Error("Actual checkpoint SQL failure");
      return prepare(sql);
    });
  f.allowUncertainClose();
  await assert.rejects(f.apply(preview, "checkpoint-failed"));
  failing.mock.restore();
  const lockPath = `${f.dbPath}.effects.sqlite`,
    recovery = f.recovery();
  assert.equal(inspectExecutionLock(lockPath).status, "uncertain");
  const holder = new DatabaseSync(lockPath, { timeout: 0 });
  try {
    holder.exec("BEGIN EXCLUSIVE");
    assert.equal(inspectExecutionLock(lockPath).status, "busy");
    await assert.rejects(
      f.acknowledge(recovery),
      failure("COMMAND_EFFECTS_BUSY"),
    );
  } finally {
    holder.close();
  }
  assert.equal(f.engine.store.hasUncertainWorkspace(f.workspace.id), true);
});
