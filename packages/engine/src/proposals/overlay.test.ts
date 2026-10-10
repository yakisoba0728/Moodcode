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
import { EngineError, type Workspace } from "@moodcode/contracts";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { ProposalSourceCaptureHost } from "./source-capture.js";
import { ProposalBlobStorage } from "./blob-store.js";
import {
  PROPOSAL_SCHEMA_SQL,
  ProposalStorage,
  pauseImportedProposals,
} from "./store.js";
import {
  buildProposalDiff,
  PROPOSAL_OVERLAY_PREFIX,
  ProposalOverlayContextSource,
  proposalContextPolicy,
  proposalContributionSourceIds,
  type ProposalContextRequest,
  type ProposalDiffOptions,
  type ProposalOverlayContextSourcePorts,
} from "./overlay.js";
import type { ProposalBlobReference, ProposalSelection } from "./types.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
async function fixture(t: TestContext) {
  const root = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-proposal-overlay-")),
    ),
    before = "original physical 한글😀\n";
  writeFileSync(join(root, "a"), before);
  const stat = lstatSync(root, { bigint: true });
  const binding: KnowledgeHostBinding = {
    workspaceId: "actual-overlay-workspace",
    root,
    rootDevice: stat.dev.toString(),
    rootInode: stat.ino.toString(),
    storageBindingSha256: sha("primary"),
  };
  const workspace: Workspace = {
    id: binding.workspaceId,
    root,
    gitRoot: root,
    branch: null,
    createdAt: new Date().toISOString(),
  };
  const db = new DatabaseSync(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON;CREATE TABLE workspaces(id TEXT PRIMARY KEY,root TEXT);",
  );
  db.prepare("INSERT INTO workspaces VALUES(?,?)").run(
    binding.workspaceId,
    root,
  );
  db.exec(PROPOSAL_SCHEMA_SQL);
  const tx = <T>(op: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = op();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  let physical = new ProposalSourceCaptureHost({ checkBinding: () => binding });
  const physicals = new Set([physical]);
  const blobs = new ProposalBlobStorage(db),
    native = new ProposalStorage(db, {
      writeTx: tx,
      getWorkspace: () => ({ id: binding.workspaceId, root }),
      checkBinding: () => binding,
      readSourceCapture: (original) => physical.read(original),
      assertSourcesCurrent: (_native, original) =>
        physical.assertFreshSync(original as { id: string }),
      blobs,
    });
  let blobReads = 0;
  const ports: ProposalOverlayContextSourcePorts = {
    readTx: tx,
    checkBinding: () => binding,
    assertOwnerCurrent: () => {},
    getSet: (ws, id) => native.getSet(ws, id),
    getSelection: (ws, id) => native.getSelection(ws, id),
    readBlobText: (ref) => {
      blobReads++;
      return blobs.readText(ref);
    },
    assertSourcesCurrent: (actual, manifest, signal) =>
      physical.assertStoredManifestCurrent(actual, manifest, signal),
  };
  const source = new ProposalOverlayContextSource(ports),
    sources = new Set([source]);
  t.after(async () => {
    for (const s of sources) await s.close();
    for (const p of physicals) await p.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  let selection!: ProposalSelection;
  async function stage(after = 'pending "quoted" unapplied 한글😀\n') {
    const operations = [{ path: "a", expectedSha256: sha(before), after }],
      begun = native.beginCapture({
        workspaceId: binding.workspaceId,
        requestId: randomUUID(),
        ...(selection ? { proposalId: selection.set.id } : {}),
        expectedHeadRevision: selection?.set.headRevision ?? 0,
        operations,
      });
    assert.equal(begun.kind, "created");
    if (begun.kind !== "created") throw Error("actual producer required");
    const capture = await physical.capture(binding, operations);
    const result = native.appendRevision(begun.capture, capture);
    physical.release(capture);
    native.release(begun.capture);
    selection = { set: result.set, revision: result.revision };
    return selection;
  }
  await stage();
  const request = (
    patch: Partial<ProposalContextRequest> = {},
  ): ProposalContextRequest => ({
    workspace,
    owner: { sessionId: "host-context-fixture", runId: null, profile: null },
    policy: { proposalIds: [selection.set.id], slotBytes: 32768 },
    budget: {
      slotBytes: 32768,
      maxContextBytes: 65536,
      reservedBytes: 64,
      requiredMessagesBytes: 512,
      contextWindow: null,
      outputTokens: 128,
    },
    signal: new AbortController().signal,
    ...patch,
  });
  return {
    root,
    before,
    binding,
    workspace,
    db,
    tx,
    physical,
    blobs,
    native,
    ports,
    source,
    sources,
    stage,
    request,
    get selection() {
      return selection;
    },
    get blobReads() {
      return blobReads;
    },
    restartPhysical() {
      physical = new ProposalSourceCaptureHost({ checkBinding: () => binding });
      physicals.add(physical);
      return physical;
    },
  };
}
test("actual native selected BLOBs become one complete quoted pending overlay and retain physical tool baseline", async (t) => {
  const f = await fixture(t),
    original = await f.source.prepare(f.request());
  assert.equal(original.messages.length, 1);
  const message = original.messages[0]!;
  assert.equal(message.role, "assistant");
  assert.ok(message.content.startsWith(PROPOSAL_OVERLAY_PREFIX));
  const data = JSON.parse(
    message.content.slice(PROPOSAL_OVERLAY_PREFIX.length),
  );
  assert.equal(data.authority, "read-only");
  assert.equal(data.state, "pending-unapplied");
  assert.equal(data.proposals[0].files[0].before, f.before);
  assert.equal(
    data.proposals[0].files[0].after,
    'pending "quoted" unapplied 한글😀\n',
  );
  assert.equal(
    original.reservations.contributedBytes,
    Buffer.byteLength(JSON.stringify(message)) + 1,
  );
  assert.equal(
    original.proposals[0]!.revisionSha256,
    f.selection.revision.sha256,
  );
  assert.ok(
    proposalContributionSourceIds(original).includes(
      `proposal-source:${f.selection.revision.sourceManifestSha256}`,
    ),
  );
  assert.ok(
    proposalContributionSourceIds(original).some((id) =>
      id.includes(f.selection.revision.files[0]!.after!.headerSha256),
    ),
  );
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), f.before);
  await f.source.assertFresh(original, new AbortController().signal);
  assert.throws(
    () => f.source.assertFresh({ ...original }, new AbortController().signal),
    code("PROPOSAL_CONTEXT_CAPTURE_INVALID"),
  );
  f.source.release(original);
  assert.throws(
    () => f.source.assertFresh(original, new AbortController().signal),
    code("PROPOSAL_CONTEXT_CAPTURE_INVALID"),
  );
});
test("actual native head CAS invalidates captured overlay without upgrading it; explicit rebuild selects the new revision", async (t) => {
  const f = await fixture(t),
    original = await f.source.prepare(f.request()),
    message = original.messages[0]!.content;
  await f.stage("new exact unapplied revision");
  await assert.rejects(
    f.source.assertFresh(original, new AbortController().signal),
    code("PROPOSAL_CONTEXT_STALE"),
  );
  assert.equal(original.messages[0]!.content, message);
  const rebuilt = await f.source.prepare(f.request());
  assert.ok(
    rebuilt.messages[0]!.content.includes("new exact unapplied revision"),
  );
  assert.notEqual(
    rebuilt.proposals[0]!.revisionId,
    original.proposals[0]!.revisionId,
  );
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), f.before);
});
test("physical edits stale captured overlay and are omitted on rebuild while immutable readonly diff remains available", async (t) => {
  const f = await fixture(t),
    original = await f.source.prepare(f.request());
  writeFileSync(join(f.root, "a"), "actual external edit");
  await assert.rejects(
    f.source.assertFresh(original, new AbortController().signal),
    code("PROPOSAL_SOURCE_STALE"),
  );
  const rebuilt = await f.source.prepare(f.request());
  assert.equal(rebuilt.messages.length, 0);
  assert.deepEqual(rebuilt.omissions, [
    { proposalId: f.selection.set.id, reason: "stale" },
  ]);
  const diff = f.tx(() =>
    buildProposalDiff(f.selection.revision, (ref) => f.blobs.readText(ref), {
      sourceFreshness: "stale",
    }),
  );
  assert.equal(diff.sourceFreshness, "stale");
  assert.equal(diff.state, "captured-history");
  assert.equal(diff.proposalStatus, "unknown");
  assert.equal(diff.files[0]!.before, f.before);
  assert.equal(diff.files[0]!.after, 'pending "quoted" unapplied 한글😀\n');
  assert.equal(diff.bytes, Buffer.byteLength(JSON.stringify(diff)));
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), "actual external edit");
});
test("readonly captured history reports supplied current status without changing pending context authority or artifact bytes", async (t) => {
  const f = await fixture(t),
    contribution = await f.source.prepare(f.request());
  assert.equal(contribution.state, "pending-unapplied");
  for (const proposalStatus of [
    "pending",
    "cancelled",
    "paused-import",
    "applied",
    "partial",
    "uncertain",
  ] as const) {
    const diff = f.tx(() =>
      buildProposalDiff(f.selection.revision, (ref) => f.blobs.readText(ref), {
        proposalStatus,
      }),
    );
    assert.equal(diff.state, "captured-history");
    assert.equal(diff.proposalStatus, proposalStatus);
    assert.equal(diff.files[0]!.before, f.before);
    assert.equal(diff.files[0]!.after, 'pending "quoted" unapplied 한글😀\n');
    assert.equal(diff.bytes, Buffer.byteLength(JSON.stringify(diff)));
  }
  let reads = 0;
  assert.throws(() =>
    buildProposalDiff(
      f.selection.revision,
      () => {
        reads++;
        return "";
      },
      { proposalStatus: "completed" as never },
    ),
  );
  assert.equal(reads, 0);
  assert.equal(contribution.state, "pending-unapplied");
});
test("shared required/repository/knowledge reservations and exact quoted-byte expansion permit only whole fitting proposals", async (t) => {
  const f = await fixture(t),
    large = await f.source.prepare(f.request()),
    charge = large.reservations.contributedBytes;
  const tiny = f.request();
  const reads = f.blobReads;
  const omitted = await f.source.prepare({
    ...tiny,
    budget: {
      ...tiny.budget,
      maxContextBytes:
        charge -
        1 +
        tiny.budget.reservedBytes +
        tiny.budget.requiredMessagesBytes,
    },
  });
  assert.equal(omitted.messages.length, 0);
  assert.equal(omitted.omissions[0]!.reason, "context-budget");
  assert.equal(omitted.reservations.availableBytes, charge - 1);
  const zero = await f.source.prepare({
    ...tiny,
    budget: {
      ...tiny.budget,
      maxContextBytes:
        tiny.budget.reservedBytes + tiny.budget.requiredMessagesBytes,
    },
  });
  assert.equal(zero.reservations.availableBytes, 0);
  assert.equal(zero.messages.length, 0);
  assert.equal(f.blobReads, reads + 2); // Only the near-fit exact escaping check loaded two bounded bodies; zero allowance did not.
  const exact = await f.source.prepare({
    ...tiny,
    budget: {
      ...tiny.budget,
      maxContextBytes:
        charge + tiny.budget.reservedBytes + tiny.budget.requiredMessagesBytes,
      contextWindow:
        charge +
        tiny.budget.reservedBytes +
        tiny.budget.requiredMessagesBytes +
        tiny.budget.outputTokens,
    },
  });
  assert.equal(exact.messages.length, 1);
  assert.equal(exact.reservations.contributedBytes, charge);
});
test("profile selection, missing and imported paused native heads omit whole data without loading bodies", async (t) => {
  const f = await fixture(t),
    request = f.request(),
    reads = f.blobReads;
  const profile = await f.source.prepare({
    ...request,
    policy: {
      ...request.policy,
      profiles: [{ id: "verified-profile", revision: "1" }],
    },
  });
  assert.equal(profile.omissions[0]!.reason, "profile-not-selected");
  assert.equal(f.blobReads, reads);
  const missing = await f.source.prepare({
    ...request,
    policy: { ...request.policy, proposalIds: ["missing"] },
  });
  assert.equal(missing.omissions[0]!.reason, "missing");
  f.tx(() =>
    pauseImportedProposals(f.db, f.binding.workspaceId, sha("actual-archive")),
  );
  const paused = await f.source.prepare(request);
  assert.equal(paused.omissions[0]!.reason, "paused");
  assert.equal(paused.messages.length, 0);
  assert.equal(f.blobReads, reads);
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), f.before);
});
test("durable native revision rehydrates a new original overlay after append source handle release and physical-reader restart", async (t) => {
  const f = await fixture(t);
  await f.physical.close();
  f.restartPhysical();
  const fresh = new ProposalOverlayContextSource(f.ports);
  f.sources.add(fresh);
  const original = await fresh.prepare(f.request());
  assert.equal(original.messages.length, 1);
  assert.equal(original.proposals[0]!.revisionId, f.selection.revision.id);
  await fresh.assertFresh(original, new AbortController().signal);
  const old = await f.source.prepare(f.request());
  assert.throws(
    () => fresh.assertFresh(old, new AbortController().signal),
    code("PROPOSAL_CONTEXT_CAPTURE_INVALID"),
  );
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), f.before);
});
test("hostile requests/policies and copied captures execute no getters and cannot select authority", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const request = f.request();
  const hostile = Object.defineProperty({ ...request }, "owner", {
    enumerable: true,
    get() {
      calls++;
      return request.owner;
    },
  });
  assert.throws(() => f.source.prepare(hostile));
  const proxy = new Proxy(request, {
    get() {
      calls++;
      throw Error("trap");
    },
    ownKeys() {
      calls++;
      throw Error("trap");
    },
    getPrototypeOf() {
      calls++;
      throw Error("trap");
    },
  });
  assert.throws(() => f.source.prepare(proxy));
  assert.equal(calls, 0);
  assert.throws(() =>
    proposalContextPolicy({
      proposalIds: [f.selection.set.id, f.selection.set.id],
      slotBytes: 32768,
    }),
  );
  assert.throws(() =>
    proposalContextPolicy({
      proposalIds: [f.selection.set.id],
      slotBytes: 32769,
    }),
  );
  assert.throws(() =>
    proposalContextPolicy({ proposalIds: new Array(1), slotBytes: 1 }),
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => f.source.prepare({ ...request, signal: controller.signal }),
    code("PROPOSAL_CONTEXT_CANCELLED"),
  );
});
test("readonly diff pages omit oversized whole files before body reads and never invent partial content", async (t) => {
  const f = await fixture(t);
  await f.stage("x".repeat(4096));
  let reads = 0;
  const diff = f.tx(() =>
    buildProposalDiff(
      f.selection.revision,
      (ref) => {
        reads++;
        return f.blobs.readText(ref);
      },
      { maxBytes: 1024, sourceFreshness: "current" },
    ),
  );
  assert.equal(reads, 0);
  assert.equal(diff.files.length, 0);
  assert.deepEqual(diff.omissions, [{ path: "a", reason: "page-budget" }]);
  assert.equal(diff.next, null);
  assert.ok(diff.bytes <= 1024);
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), f.before);
});
test("readonly diff pages end before an omission that would exceed the byte budget", async (t) => {
  const f = await fixture(t);
  const operations = [
    { path: "a", expectedSha256: sha(f.before), after: "a".repeat(3000) },
    ...Array.from({ length: 20 }, (_, index) => ({
      path: `omitted-${String(index).padStart(2, "0")}`,
      expectedSha256: null,
      after: "b".repeat(2000),
    })),
  ];
  const begun = f.native.beginCapture({
    workspaceId: f.binding.workspaceId,
    requestId: randomUUID(),
    expectedHeadRevision: 0,
    operations,
  });
  assert.equal(begun.kind, "created");
  if (begun.kind !== "created") throw Error("actual producer required");
  const capture = await f.physical.capture(f.binding, operations);
  const { revision } = f.native.appendRevision(begun.capture, capture);
  f.physical.release(capture);
  f.native.release(begun.capture);
  const page = (options: ProposalDiffOptions) =>
    f.tx(() =>
      buildProposalDiff(revision, (ref) => f.blobs.readText(ref), options),
    );
  assert.equal(revision.files[0]!.path, "a");
  const maxBytes = page({ limit: 1 }).bytes + 164,
    seen: string[] = [];
  let after: number | null = 0;
  while (after !== null) {
    const diff = page({ after, maxBytes });
    assert.ok(diff.bytes <= maxBytes);
    const count = diff.files.length + diff.omissions.length;
    assert.ok(count > 0);
    if (after === 0) {
      assert.equal(diff.files[0]?.path, "a");
      assert.ok(diff.omissions.length < 20);
    }
    seen.push(
      ...diff.files.map((file) => file.path),
      ...diff.omissions.map((omission) => omission.path),
    );
    if (diff.next !== null) assert.equal(diff.next, after + count);
    after = diff.next;
  }
  assert.deepEqual(
    seen.sort(),
    revision.files.map((file) => file.path),
  );
});
test("close joins an original trusted source observation and late completion issues no overlay capture", async (t) => {
  const f = await fixture(t);
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (ready = r)),
    gate = new Promise<void>((r) => (release = r));
  const source = new ProposalOverlayContextSource({
    ...f.ports,
    async assertSourcesCurrent(binding, manifest, signal) {
      await f.ports.assertSourcesCurrent(binding, manifest, signal);
      ready();
      await gate;
    },
  });
  f.sources.add(source);
  const pending = source.prepare(f.request()),
    rejection = assert.rejects(pending, code("PROPOSAL_CONTEXT_CANCELLED"));
  await started;
  let joined = false;
  const closing = source.close().then(() => (joined = true));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(joined, false);
  release();
  await rejection;
  await closing;
  assert.equal(joined, true);
  assert.equal(readFileSync(join(f.root, "a"), "utf8"), f.before);
});
