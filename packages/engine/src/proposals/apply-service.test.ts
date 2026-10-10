import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EngineError } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import {
  PhysicalPatchProducer,
  type PhysicalPatchChange,
} from "../tools/patch/physical.js";
import {
  acquireExecutionLock,
  assertExecutionLockAvailable,
  inspectExecutionLock,
  readExecutionLockReservation,
  reserveExecutionLock,
} from "../tools/command/execution-lock.js";
import { ProposalSourceCaptureHost } from "./source-capture.js";
import { ProposalBlobStorage } from "./blob-store.js";
import { PROPOSAL_SCHEMA_SQL, ProposalStorage } from "./store.js";
import {
  PROPOSAL_APPLY_SCHEMA_SQL,
  ProposalApplyStorage,
} from "./apply-store.js";
import {
  PROPOSAL_APPLY_GUARD_SCHEMA_SQL,
  ProposalApplyExecutionGuards,
} from "./execution-guards.js";
import {
  ProposalApplyService,
  type ProposalApplyExecutionLease,
  type ProposalApplyPreview,
  type ProposalApplyServicePorts,
} from "./apply-service.js";
import type {
  ProposalApplyCapture,
  ProposalApplyCleanup,
} from "./apply-types.js";
import type { ProposalSelection } from "./types.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;

/** Real native ProposalStorage/ApplyStorage and original FS producer; lease is a service-unit port. */
async function fixture(t: TestContext) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-apply-service-")),
    ),
    root = join(base, "workspace");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(root);
  const before = "actual before 한글😀\n",
    after = "actual applied 한글😀\n";
  writeFileSync(join(root, "a"), before);
  const db = new DatabaseSync(join(base, "primary.sqlite"));
  db.exec(
    "PRAGMA foreign_keys=ON;CREATE TABLE workspaces(id TEXT PRIMARY KEY,root TEXT);",
  );
  const rootStat = lstatSync(root, { bigint: true }),
    dbStat = lstatSync(join(base, "primary.sqlite"), { bigint: true });
  const binding: KnowledgeHostBinding = {
    workspaceId: "actual-apply-workspace",
    root,
    rootDevice: rootStat.dev.toString(),
    rootInode: rootStat.ino.toString(),
    storageBindingSha256: knowledgeHash({
      path: join(base, "primary.sqlite"),
      device: dbStat.dev.toString(),
      inode: dbStat.ino.toString(),
    }),
  };
  db.prepare("INSERT INTO workspaces VALUES(?,?)").run(
    binding.workspaceId,
    root,
  );
  db.exec(PROPOSAL_SCHEMA_SQL);
  db.exec(PROPOSAL_APPLY_SCHEMA_SQL);
  db.exec(PROPOSAL_APPLY_GUARD_SCHEMA_SQL);
  const tx = <T>(operation: () => T): T => {
    if (db.isTransaction) return operation();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const source = new ProposalSourceCaptureHost({ checkBinding: () => binding }),
    blobs = new ProposalBlobStorage(db);
  const proposals = new ProposalStorage(db, {
    writeTx: tx,
    getWorkspace: () => ({ id: binding.workspaceId, root }),
    checkBinding: () => binding,
    readSourceCapture: (original) => source.read(original),
    assertSourcesCurrent: (_native, original) =>
      source.assertFreshSync(original as { readonly id: string }),
    blobs,
  });
  let selection: ProposalSelection | undefined;
  async function stage(
    changes: readonly PhysicalPatchChange[] = [
      { path: "a", expectedHash: sha(before), content: after },
    ],
  ) {
    const operations = changes.map((change) => ({
      path: change.path,
      expectedSha256: change.expectedHash,
      after: change.content,
    }));
    const begun = proposals.beginCapture({
      workspaceId: binding.workspaceId,
      requestId: randomUUID(),
      expectedHeadRevision: selection?.set.headRevision ?? 0,
      ...(selection ? { proposalId: selection.set.id } : {}),
      operations,
    });
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") throw Error("actual capture required");
    const capture = await source.capture(binding, operations);
    try {
      const result = proposals.appendRevision(begun.capture, capture);
      selection = { set: result.set, revision: result.revision };
      return selection;
    } finally {
      source.release(capture);
      proposals.release(begun.capture);
    }
  }
  let service!: ProposalApplyService, nowValue: number | undefined;
  const cleanup = new WeakMap<
    object,
    { capture: ProposalApplyCapture; proof: ProposalApplyCleanup }
  >();
  const native = new ProposalApplyStorage(db, {
    writeTx: tx,
    checkBinding: () => binding,
    getRevision: (ws, id) => proposals.getRevision(ws, id),
    getHead: (ws, id) => proposals.getSet(ws, id),
    readApprovedCapture: (original, input) =>
      service.readApprovedCapture(original, input),
    assertCurrent: (original, capture, phase) =>
      service.assertCurrent(original, capture, phase),
    readPhysicalResult: (capture, result) =>
      service.assertPhysicalResult(capture, result),
    readExecutionGuard: (capture, original) => {
      const guard = guards.readOriginal(original);
      assert.equal(guard.ownerId, capture.ownerId);
      return guard;
    },
    getExecutionGuard: (ws, id) => guards.get(ws, id),
    assertCleanup: (capture, original) => {
      const observed = cleanup.get(original);
      if (!observed || observed.capture !== capture)
        throw new EngineError(
          "PROPOSAL_APPLY_CLEANUP_INVALID",
          "original cleanup required",
        );
      return observed.proof;
    },
    now: () => nowValue ?? Date.now(),
  });
  const guards = new ProposalApplyExecutionGuards(db, {
    writeTx: tx,
    checkBinding: () => binding,
    getOwner: (ws, id) => {
      const owner = native.getOwner(ws, id);
      assert.ok(owner);
      return owner;
    },
  });
  const lockPath = join(base, "effects.sqlite");
  assertExecutionLockAvailable(lockPath);
  const physical = new PhysicalPatchProducer();
  let prepareCalls = 0,
    applyCalls = 0,
    leaseCalls = 0,
    acquireCalls = 0;
  let afterAcquire: undefined | (() => void),
    afterCheckpoint: undefined | (() => void),
    rejectCheckpoint = false,
    gateLease: undefined | (() => Promise<void>);
  let lastCapture: ProposalApplyCapture | undefined,
    lastResult: object | undefined;
  const leases: ProposalApplyExecutionLease[] = [];
  const ports: ProposalApplyServicePorts = {
    readTx: tx,
    getSelection: (ws, id) => proposals.getSelection(ws, id),
    getRevision: (ws, id) => proposals.getRevision(ws, id),
    readBlobText: (ref) => blobs.readText(ref),
    checkBinding: () => binding,
    assertUnpaused: () => {},
    assertIdleAndNoExecutionUncertainty: () =>
      assertExecutionLockAvailable(lockPath),
    assertSourcesCurrent: (actual, manifest, signal) =>
      source.assertStoredManifestCurrentSync(actual, manifest, signal),
    withWorkspaceLease: async (_ws, signal, operation) => {
      leaseCalls++;
      await gateLease?.();
      return operation(signal);
    },
    physical: {
      prepare: (...args) => {
        prepareCalls++;
        return physical.prepare(...args);
      },
      read: (original) => physical.read(original),
      assertFresh: (...args) => physical.assertFresh(...args),
      apply: async (...args) => {
        applyCalls++;
        const result = await physical.apply(...args);
        lastResult = result;
        return result;
      },
      readResult: (original) => physical.readResult(original),
      release: (original) => physical.release(original),
      close: () => physical.close(),
    },
    acquireExecutionGuard: async (capture) => {
      acquireCalls++;
      lastCapture = capture;
      const owner = native.getOwner(capture.workspaceId, capture.ownerId);
      assert.ok(owner);
      assertExecutionLockAvailable(lockPath);
      const reservation = reserveExecutionLock(lockPath),
        original = native.claim(capture, () =>
          guards.reserve(
            owner.binding,
            owner.id,
            lockPath,
            readExecutionLockReservation(reservation),
          ),
        );
      const lock = acquireExecutionLock(lockPath, reservation);
      afterAcquire?.();
      let released = false;
      const lease = {
        guard: original,
        release: (confirmed: boolean) => {
          assert.equal(released, false);
          released = true;
          const actual = confirmed
            ? service.readCurrentPhysicalOutcome(capture).cleanupConfirmed
            : false;
          lock.release(actual);
          const token = Object.freeze({});
          cleanup.set(token, {
            capture,
            proof: {
              confirmed: actual,
              guardSha256: guards.readOriginal(original).sha256,
            },
          });
          return token;
        },
      };
      leases.push(lease);
      return lease;
    },
  };
  const checkpoint = native.checkpoint.bind(native);
  const facade = {
    findRequest: native.findRequest.bind(native),
    prepare: native.prepare.bind(native),
    claim: native.claim.bind(native),
    dispatch: native.dispatch.bind(native),
    checkpoint: (capture: ProposalApplyCapture, result: object) => {
      if (rejectCheckpoint)
        throw new EngineError(
          "TEST_CHECKPOINT_FAILURE",
          "actual durable checkpoint boundary rejected",
        );
      const value = checkpoint(capture, result);
      afterCheckpoint?.();
      return value;
    },
    settle: native.settle.bind(native),
    cancelPrepared: native.cancelPrepared.bind(native),
    uncertain: native.uncertain.bind(native),
    release: native.release.bind(native),
    getHistory: native.getHistory.bind(native),
  };
  service = new ProposalApplyService(facade, {
    ...ports,
    now: () => nowValue ?? Date.now(),
  });
  t.after(async () => {
    await service.close();
    await source.close();
    db.close();
    if (process.env.MOODCODE_HOST_VALIDATION_PRESERVE_FIXTURES === "1")
      t.diagnostic(`Preserved native fixture: ${base}`);
    else rmSync(base, { recursive: true, force: true });
  });
  const rowCount = (table: string) =>
    Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count);
  return {
    base,
    root,
    binding,
    before,
    after,
    db,
    source,
    proposals,
    native,
    service,
    physical,
    ports,
    stage,
    lockPath,
    rowCount,
    counters: () => ({ prepareCalls, applyCalls, leaseCalls, acquireCalls }),
    lastOriginals: () => ({ capture: lastCapture, result: lastResult }),
    setNow: (value: number) => {
      nowValue = value;
    },
    setAfterAcquire: (callback: () => void) => {
      afterAcquire = callback;
    },
    setAfterCheckpoint: (callback: () => void) => {
      afterCheckpoint = callback;
    },
    setRejectCheckpoint: () => {
      rejectCheckpoint = true;
    },
    setLeaseGate: (callback: () => Promise<void>) => {
      gateLease = callback;
    },
  };
}

test("original preview applies native artifacts once, records original cleanup, and historical duplicate ignores a later disk edit", async (t) => {
  const f = await fixture(t),
    selection = await f.stage(),
    preview = await f.service.preview({
      workspaceId: f.binding.workspaceId,
      proposalId: selection.set.id,
    });
  const request = {
    workspaceId: f.binding.workspaceId,
    requestId: randomUUID(),
    approved: true,
    preview,
    signal: Object.assign(new AbortController().signal, {
      hostObservation: "safe data",
      [Symbol("hostObservation")]: "safe symbol data",
    }),
  };
  const result = await f.service.apply(request);
  assert.equal(result.duplicate, false);
  assert.equal(result.owner.state, "completed");
  assert.equal(result.receipt?.cleanupConfirmed, true);
  assert.equal(result.receipt?.afterHead.status, "applied");
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), f.after);
  assert.equal(inspectExecutionLock(f.lockPath).status, "available");
  writeFileSync(join(f.root, "a"), "later external edit");
  const counters = f.counters(),
    rows = f.rowCount("proposal_apply_owners");
  const duplicate = await f.service.apply(request);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.receipt?.sha256, result.receipt?.sha256);
  assert.deepEqual(f.counters(), counters);
  assert.equal(f.rowCount("proposal_apply_owners"), rows);
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), "later external edit");
  await assert.rejects(
    f.service.apply({ ...request, requestId: randomUUID() }),
    code("PROPOSAL_APPLY_PREVIEW_USED"),
  );
});

test("copied, foreign, hostile, released, false-approved and preaborted inputs create zero native owners or lock intents", async (t) => {
  const f = await fixture(t),
    selection = await f.stage(),
    preview = await f.service.preview({
      workspaceId: f.binding.workspaceId,
      proposalId: selection.set.id,
    });
  const request = {
    workspaceId: f.binding.workspaceId,
    requestId: randomUUID(),
    approved: true,
    preview,
  };
  let traps = 0;
  const hostile = Object.defineProperty({}, "workspaceId", {
    enumerable: true,
    get() {
      traps++;
      return f.binding.workspaceId;
    },
  });
  await assert.rejects(f.service.apply(hostile as typeof request));
  const proxy = new Proxy(request, {
    ownKeys() {
      traps++;
      return Reflect.ownKeys(request);
    },
    get() {
      traps++;
      return null;
    },
  });
  await assert.rejects(f.service.apply(proxy));
  await assert.rejects(
    f.service.apply({ ...request, preview: structuredClone(preview) }),
    code("PROPOSAL_APPLY_PREVIEW_INVALID"),
  );
  await assert.rejects(
    f.service.apply({
      ...request,
      preview: new Proxy(preview, {
        get() {
          traps++;
          return null;
        },
      }),
    }),
    code("PROPOSAL_APPLY_PREVIEW_INVALID"),
  );
  await assert.rejects(
    f.service.apply({ ...request, approved: false }),
    code("PROPOSAL_APPLY_APPROVAL_REQUIRED"),
  );
  await assert.rejects(
    f.service.apply({ ...request, signal: AbortSignal.abort() }),
    code("CANCELLED"),
  );
  f.service.releasePreview(preview);
  await assert.rejects(
    f.service.apply(request),
    code("PROPOSAL_APPLY_PREVIEW_USED"),
  );
  assert.equal(traps, 0);
  assert.equal(f.rowCount("proposal_apply_owners"), 0);
  assert.equal(f.rowCount("proposal_apply_execution_guards"), 0);
  assert.equal(f.counters().leaseCalls, 0);
  assert.equal(f.counters().applyCalls, 0);
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), f.before);
});

test("native signal descriptors are rejected before preview or approved apply ports", async (t) => {
  const f = await fixture(t),
    selection = await f.stage(),
    previewInput = {
      workspaceId: f.binding.workspaceId,
      proposalId: selection.set.id,
      signal: new AbortController().signal,
    },
    preview = await f.service.preview(previewInput),
    counters = f.counters();
  let traps = 0,
    portCalls = 0;
  for (const port of [f.service.ports, f.service.native])
    for (const [key, operation] of Object.entries(port))
      if (typeof operation === "function")
        Reflect.set(port, key, (...args: unknown[]) => {
          portCalls++;
          return Reflect.apply(operation, port, args);
        });
  const accessor = (key: PropertyKey) => {
    const controller = new AbortController();
    if (key !== "aborted") controller.abort();
    return Object.defineProperty(controller.signal, key, {
      get() {
        traps++;
        throw Error("signal getter must not execute");
      },
    });
  };
  const override = (key: string) =>
    Object.defineProperty(AbortSignal.abort(), key, {
      value: () => {
        traps++;
        throw Error("signal override must not execute");
      },
    });
  const inheritedAccessor = (key: PropertyKey) => {
    const controller = new AbortController();
    if (key !== "aborted") controller.abort();
    const prototype = Object.defineProperty(
      Object.create(AbortSignal.prototype),
      key,
      {
        get() {
          traps++;
          throw Error("inherited signal getter must not execute");
        },
      },
    );
    return Object.setPrototypeOf(controller.signal, prototype);
  };
  const invalid = [
    ["own aborted accessor", accessor("aborted")],
    ["own reason accessor", accessor("reason")],
    ["own addEventListener", override("addEventListener")],
    ["own removeEventListener", override("removeEventListener")],
    ["other own accessor", accessor("hostObservation")],
    ["own symbol accessor", accessor(Symbol("hostObservation"))],
    ["prototype without native brand", Object.create(AbortSignal.prototype)],
    ["inherited aborted accessor", inheritedAccessor("aborted")],
    ["inherited reason accessor", inheritedAccessor("reason")],
    [
      "inherited addEventListener accessor",
      inheritedAccessor("addEventListener"),
    ],
    [
      "inherited removeEventListener accessor",
      inheritedAccessor("removeEventListener"),
    ],
    ["other inherited accessor", inheritedAccessor("hostObservation")],
    ["inherited symbol accessor", inheritedAccessor(Symbol("hostObservation"))],
    [
      "custom native prototype without overrides",
      Object.setPrototypeOf(
        AbortSignal.abort(),
        Object.create(AbortSignal.prototype),
      ),
    ],
  ] as const;
  for (const [label, signal] of invalid) {
    await t.test(`${label} / preview`, async () => {
      await assert.rejects(
        f.service.preview({ ...previewInput, signal }),
        code("INVALID_PROPOSAL_APPLY"),
      );
    });
    await t.test(`${label} / approved apply`, async () => {
      await assert.rejects(
        f.service.apply({
          workspaceId: f.binding.workspaceId,
          requestId: randomUUID(),
          approved: true,
          preview,
          signal,
        }),
        code("INVALID_PROPOSAL_APPLY"),
      );
    });
  }
  assert.equal(traps, 0);
  assert.equal(portCalls, 0);
  assert.deepEqual(f.counters(), counters);
  assert.equal(f.rowCount("proposal_apply_owners"), 0);
  assert.equal(f.rowCount("proposal_apply_execution_guards"), 0);
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), f.before);
  assert.equal(inspectExecutionLock(f.lockPath).status, "not_initialized");
  await assert.rejects(
    f.service.preview({ ...previewInput, signal: AbortSignal.abort() }),
    code("CANCELLED"),
  );
  await assert.rejects(
    f.service.apply({
      workspaceId: f.binding.workspaceId,
      requestId: randomUUID(),
      approved: true,
      preview,
      signal: AbortSignal.abort(),
    }),
    code("CANCELLED"),
  );
  assert.equal(portCalls, 0);
  assert.deepEqual(f.counters(), counters);
  f.service.releasePreview(preview);
});

test("source edited after original preview is rejected before native intent or producer apply", async (t) => {
  const f = await fixture(t),
    selection = await f.stage(),
    preview = await f.service.preview({
      workspaceId: f.binding.workspaceId,
      proposalId: selection.set.id,
    });
  writeFileSync(join(f.root, "a"), "host external edit");
  await assert.rejects(
    f.service.apply({
      workspaceId: f.binding.workspaceId,
      requestId: randomUUID(),
      approved: true,
      preview,
    }),
  );
  assert.equal(f.rowCount("proposal_apply_owners"), 0);
  assert.equal(f.rowCount("proposal_apply_execution_guards"), 0);
  assert.equal(f.counters().applyCalls, 0);
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), "host external edit");
});

test("a valid staged 33-file proposal is apply-unsupported before any physical prepare or native intent", async (t) => {
  const f = await fixture(t),
    selection = await f.stage(
      Array.from({ length: 33 }, (_, index) => ({
        path: `fresh-${index}`,
        expectedHash: null as string | null,
        content: "whole pending body",
      })),
    );
  await assert.rejects(
    f.service.preview({
      workspaceId: f.binding.workspaceId,
      proposalId: selection.set.id,
    }),
    code("PROPOSAL_APPLY_UNSUPPORTED"),
  );
  assert.equal(f.counters().prepareCalls, 0);
  assert.equal(f.rowCount("proposal_apply_owners"), 0);
  assert.equal(f.rowCount("proposal_apply_execution_guards"), 0);
});

test("source changes after actual lock acquisition preserve a guard-bearing uncertain owner and external edit with zero dispatch", async (t) => {
  const f = await fixture(t),
    selection = await f.stage(),
    preview = await f.service.preview({
      workspaceId: f.binding.workspaceId,
      proposalId: selection.set.id,
    });
  const request = {
    workspaceId: f.binding.workspaceId,
    requestId: randomUUID(),
    approved: true,
    preview,
  };
  f.setAfterAcquire(() =>
    writeFileSync(join(f.root, "a"), "external edit after acquired lock"),
  );
  await assert.rejects(f.service.apply(request));
  const owner = f.native.getRequest(f.binding.workspaceId, request.requestId)!;
  assert.equal(owner.owner.state, "uncertain");
  assert.equal(owner.owner.dispatchedAt, null);
  assert.equal(owner.owner.cleanupConfirmed, false);
  assert.equal(owner.checkpoint, null);
  assert.equal(owner.receipt, null);
  assert.equal(f.rowCount("proposal_apply_execution_guards"), 1);
  assert.equal(inspectExecutionLock(f.lockPath).status, "uncertain");
  assert.equal(
    readFileSync(join(f.root, "a"), "utf8"),
    "external edit after acquired lock",
  );
  const calls = f.counters();
  const duplicate = await f.service.apply(request);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.owner.sha256, owner.owner.sha256);
  assert.deepEqual(f.counters(), calls);
});

test("checkpoint SQL failure retains actual written bytes and uncertain marker without fabricated checkpoint or cleanup", async (t) => {
  const f = await fixture(t),
    selection = await f.stage(),
    preview = await f.service.preview({
      workspaceId: f.binding.workspaceId,
      proposalId: selection.set.id,
    });
  f.setRejectCheckpoint();
  const request = {
    workspaceId: f.binding.workspaceId,
    requestId: randomUUID(),
    approved: true,
    preview,
  };
  await assert.rejects(
    f.service.apply(request),
    code("TEST_CHECKPOINT_FAILURE"),
  );
  const history = f.native.getRequest(
    f.binding.workspaceId,
    request.requestId,
  )!;
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), f.after);
  assert.equal(history.owner.state, "uncertain");
  assert.equal(history.owner.cleanupConfirmed, false);
  assert.equal(history.checkpoint, null);
  assert.equal(history.receipt, null);
  assert.ok(history.owner.dispatchedAt);
  assert.equal(inspectExecutionLock(f.lockPath).status, "uncertain");
});

test("cancellation after actual durable checkpoint preserves observed completed receipt and confirmed original release", async (t) => {
  const f = await fixture(t),
    selection = await f.stage(),
    preview = await f.service.preview({
      workspaceId: f.binding.workspaceId,
      proposalId: selection.set.id,
    }),
    controller = new AbortController();
  f.setAfterCheckpoint(() => controller.abort());
  const result = await f.service.apply({
    workspaceId: f.binding.workspaceId,
    requestId: randomUUID(),
    approved: true,
    preview,
    signal: controller.signal,
  });
  assert.equal(controller.signal.aborted, true);
  assert.equal(result.owner.state, "completed");
  assert.equal(result.receipt?.cleanupConfirmed, true);
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), f.after);
  assert.equal(inspectExecutionLock(f.lockPath).status, "available");
  const originals = f.lastOriginals();
  assert.ok(originals.capture);
  assert.ok(originals.result);
  let traps = 0;
  assert.throws(
    () =>
      f.service.assertPhysicalResult(
        { ...originals.capture! },
        originals.result!,
      ),
    code("PROPOSAL_APPLY_RESULT_INVALID"),
  );
  assert.throws(
    () =>
      f.service.assertPhysicalResult(
        originals.capture!,
        structuredClone(originals.result!),
      ),
    code("PROPOSAL_APPLY_RESULT_INVALID"),
  );
  const proxy = new Proxy(originals.result!, {
    get() {
      traps++;
      return null;
    },
  });
  assert.throws(
    () => f.service.assertPhysicalResult(originals.capture!, proxy),
    code("PROPOSAL_APPLY_RESULT_INVALID"),
  );
  assert.equal(traps, 0);
});

test("close aborts and joins the original pending lease before releasing preview captures, with zero native intent", async (t) => {
  const f = await fixture(t),
    selection = await f.stage(),
    preview = await f.service.preview({
      workspaceId: f.binding.workspaceId,
      proposalId: selection.set.id,
    });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.setLeaseGate(() => {
    enter();
    return gate;
  });
  const pending = f.service.apply({
    workspaceId: f.binding.workspaceId,
    requestId: randomUUID(),
    approved: true,
    preview,
  });
  void pending.catch(() => {});
  await entered;
  let closed = false;
  const close = f.service.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.equal(f.rowCount("proposal_apply_owners"), 0);
  release();
  await assert.rejects(pending, code("PROPOSAL_APPLY_CLOSED"));
  await close;
  assert.equal(closed, true);
  assert.equal(f.rowCount("proposal_apply_execution_guards"), 0);
  assert.equal(f.counters().applyCalls, 0);
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), f.before);
});

test("an expired original preview and a replaced native head both reject before native owner or guard creation", async (t) => {
  const f = await fixture(t),
    selection = await f.stage(),
    preview = await f.service.preview({
      workspaceId: f.binding.workspaceId,
      proposalId: selection.set.id,
    });
  const request = {
    workspaceId: f.binding.workspaceId,
    requestId: randomUUID(),
    approved: true,
    preview,
  };
  f.setNow(Date.parse(preview.expiresAt));
  await assert.rejects(
    f.service.apply(request),
    code("PROPOSAL_APPLY_PREVIEW_EXPIRED"),
  );
  assert.equal(f.rowCount("proposal_apply_owners"), 0);
  assert.equal(f.rowCount("proposal_apply_execution_guards"), 0);
  f.setNow(Date.now());
  const current = await f.service.preview({
    workspaceId: f.binding.workspaceId,
    proposalId: selection.set.id,
  });
  await f.stage([
    {
      path: "a",
      expectedHash: sha(f.before),
      content: "new authored native revision",
    },
  ]);
  await assert.rejects(
    f.service.apply({ ...request, requestId: randomUUID(), preview: current }),
    code("PROPOSAL_APPLY_STALE"),
  );
  assert.equal(f.rowCount("proposal_apply_owners"), 0);
  assert.equal(f.counters().applyCalls, 0);
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), f.before);
});

test("a valid staged five MiB proposal is metadata-rejected before physical preparation or any effects", async (t) => {
  const f = await fixture(t),
    selection = await f.stage(
      Array.from({ length: 5 }, (_, index) => ({
        path: `large-${index}`,
        expectedHash: null,
        content: "x".repeat(1_048_576),
      })),
    );
  assert.equal(selection.revision.totalBytes, 5_242_880);
  await assert.rejects(
    f.service.preview({
      workspaceId: f.binding.workspaceId,
      proposalId: selection.set.id,
    }),
    code("PROPOSAL_APPLY_UNSUPPORTED"),
  );
  assert.equal(f.counters().prepareCalls, 0);
  assert.equal(f.rowCount("proposal_apply_owners"), 0);
  assert.equal(f.rowCount("proposal_apply_execution_guards"), 0);
});

test("an approval with under ten seconds of preview validity is cancelled before any guard or lock intent", async (t) => {
  const f = await fixture(t),
    selection = await f.stage(),
    preview = await f.service.preview({
      workspaceId: f.binding.workspaceId,
      proposalId: selection.set.id,
    });
  const request = {
    workspaceId: f.binding.workspaceId,
    requestId: randomUUID(),
    approved: true,
    preview,
  };
  f.setNow(Date.parse(preview.expiresAt) - 5_000);
  await assert.rejects(
    f.service.apply(request),
    code("PROPOSAL_APPLY_PREVIEW_EXPIRED"),
  );
  const history = f.native.getRequest(
    f.binding.workspaceId,
    request.requestId,
  )!;
  assert.equal(history.owner.state, "cancelled");
  assert.equal(history.owner.cleanupConfirmed, true);
  assert.equal(f.counters().acquireCalls, 0);
  assert.equal(f.rowCount("proposal_apply_execution_guards"), 0);
  assert.notEqual(inspectExecutionLock(f.lockPath).status, "uncertain");
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), f.before);
});

test("expired unused previews are reclaimed so preview capacity recovers", async (t) => {
  const f = await fixture(t),
    selection = await f.stage(),
    input = {
      workspaceId: f.binding.workspaceId,
      proposalId: selection.set.id,
    };
  const previews = [];
  for (let index = 0; index < 128; index++)
    previews.push(await f.service.preview(input));
  await assert.rejects(
    f.service.preview(input),
    code("PROPOSAL_APPLY_CAPACITY"),
  );
  f.setNow(Date.parse(previews.at(-1)!.expiresAt));
  await f.service.preview(input);
  const apply = (preview: ProposalApplyPreview) =>
    f.service.apply({
      workspaceId: f.binding.workspaceId,
      requestId: randomUUID(),
      approved: true,
      preview,
    });
  await assert.rejects(
    apply(previews[0]!),
    code("PROPOSAL_APPLY_PREVIEW_EXPIRED"),
  );
  await assert.rejects(
    apply(previews[0]!),
    code("PROPOSAL_APPLY_PREVIEW_USED"),
  );
  f.service.releasePreview(previews[1]!);
  await assert.rejects(
    apply(previews[1]!),
    code("PROPOSAL_APPLY_PREVIEW_USED"),
  );
  assert.equal(f.rowCount("proposal_apply_owners"), 0);
});

test("win32 hosts are refused at preview before physical preparation or any owner", async (t) => {
  const f = await fixture(t),
    selection = await f.stage(),
    platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  let pending: Promise<unknown>;
  try {
    pending = f.service.preview({
      workspaceId: f.binding.workspaceId,
      proposalId: selection.set.id,
    });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
  await assert.rejects(pending, code("PROPOSAL_APPLY_UNSUPPORTED"));
  assert.equal(f.counters().prepareCalls, 0);
  assert.equal(f.rowCount("proposal_apply_owners"), 0);
});
