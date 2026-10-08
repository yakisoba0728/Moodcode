import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import {
  JOB_LIMITS,
  type JobOutputCursor,
  type JobOutputSnapshot,
} from "./types.js";
import { readJobOutput } from "./output.js";
import {
  jobJson,
  signJobData,
  validateJobOutputCursor,
  validateJobOutputPage,
  validateJobOutputSnapshot,
  validateJobOwnerProof,
  validateTerminalClosedOutcomeProof,
  validateTerminalJobSourceProof,
  validateTerminalObservationProof,
} from "./validation.js";

const fail =
  (...codes: string[]) =>
  (error: unknown) =>
    error instanceof EngineError && codes.includes(error.code);
const source = () =>
  signJobData({
    terminalId: "terminal",
    workspaceId: "workspace",
    sessionId: "session",
    serviceEpoch: "service",
    entryBirthNonce: "birth",
    journalBindingSha256: "1".repeat(64),
    launchSha256: "2".repeat(64),
    createdAt: "2026-10-08T00:00:00.000Z",
    authority: "current-physical" as const,
  });
const request = { jobId: "job", jobRevisionId: "initial-attach" };
function snapshot(
  values: string[],
  first = 1,
  lostBytes = 0,
): JobOutputSnapshot {
  const output = values.map((data, index) => ({
      seq: first + index,
      data,
      bytes: Buffer.byteLength(data),
    })),
    retainedBytes = output.reduce((sum, event) => sum + event.bytes, 0);
  return validateJobOutputSnapshot(
    signJobData(
      {
        version: 1 as const,
        source: source(),
        throughSeq: first + output.length - 1,
        oldestSeq: first,
        observedBytes: retainedBytes + lostBytes,
        retainedBytes,
        output,
      },
      JOB_LIMITS.snapshotBytes,
    ),
  );
}
function cursor(
  value: JobOutputSnapshot,
  eventSeq: number,
  byteOffset = 0,
): JobOutputCursor {
  return signJobData({
    version: 1 as const,
    ...request,
    sourceSha256: value.source.sha256,
    snapshotSha256: value.sha256,
    throughSeq: value.throughSeq,
    eventSeq,
    byteOffset,
  });
}

test("exact owner/source checksums describe DATA without accepting restored history or execution/actor fields", () => {
  const s = validateTerminalJobSourceProof(source());
  const owner = validateJobOwnerProof(
    signJobData({
      workspaceId: s.workspaceId,
      sessionId: s.sessionId,
      rootBindingSha256: "3".repeat(64),
      ownerEpoch: "4".repeat(64),
      sourceSha256: s.sha256,
    }),
  );
  assert.equal(owner.sourceSha256, s.sha256);
  for (const extra of [
    { authority: "restored-history" },
    { executable: "/bin/sh" },
    { env: {} },
    { actor: "other" },
    { ownerSha256: owner.sha256 },
  ])
    assert.throws(
      () => validateTerminalJobSourceProof(signJobData({ ...s, ...extra })),
      fail("INVALID_JOB"),
    );
  assert.throws(
    () => validateTerminalJobSourceProof({ ...s, entryBirthNonce: "changed" }),
    fail("JOB_HASH_MISMATCH"),
  );
});

test("ordinary JSON validation rejects getters, proxies, serializers, hidden fields, sparse arrays and invalid numbers without traps", () => {
  let traps = 0;
  const getter = Object.defineProperty({}, "source", {
      enumerable: true,
      get() {
        traps++;
        throw Error();
      },
    }),
    proxy = new Proxy(
      {},
      {
        ownKeys() {
          traps++;
          throw Error();
        },
        getPrototypeOf() {
          traps++;
          throw Error();
        },
      },
    ),
    toJSON = {
      toJSON() {
        traps++;
        throw Error();
      },
    },
    hidden = Object.defineProperty({}, "hidden", { value: true }),
    sparse = new Array(2);
  for (const value of [
    getter,
    proxy,
    toJSON,
    hidden,
    sparse,
    { nested: getter },
    { nested: proxy },
    [toJSON],
    NaN,
    Infinity,
    undefined,
    new Date(),
    { symbol: Symbol() },
    { text: "\ud800" },
  ])
    assert.throws(() => jobJson(value), fail("INVALID_JOB"));
  assert.equal(traps, 0);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => jobJson(cycle), fail("INVALID_JOB"));
  let nested: unknown = null;
  for (let i = 0; i < JOB_LIMITS.depth + 1; i++) nested = { nested };
  assert.throws(() => jobJson(nested), fail("JOB_LIMIT"));
  assert.throws(
    () => jobJson("x".repeat(JOB_LIMITS.metadataBytes)),
    fail("JOB_LIMIT"),
  );
});

test("terminal final state and cleanup evidence cannot claim a live or uncertain source completed", () => {
  const active = {
    sourceSha256: source().sha256,
    state: "running" as const,
    outputSeq: 0,
    oldestSeq: 1,
    observedBytes: 0,
    retainedBytes: 0,
    cleanupConfirmed: null,
    exitCode: null,
    reason: null,
    updatedAt: "2026-10-08T00:00:00.000Z",
  };
  assert.ok(validateTerminalObservationProof(signJobData(active)));
  assert.throws(
    () =>
      validateTerminalObservationProof(
        signJobData({ ...active, cleanupConfirmed: true }),
      ),
    fail("INVALID_JOB"),
  );
  const complete = {
    sourceSha256: source().sha256,
    state: "completed" as const,
    exitCode: 0,
    cancelled: false,
    timedOut: false,
    cleanupConfirmed: true,
    reason: null,
    closedAt: "2026-10-08T00:00:00.000Z",
  };
  assert.ok(validateTerminalClosedOutcomeProof(signJobData(complete)));
  for (const change of [
    { cleanupConfirmed: false },
    { cancelled: true },
    { exitCode: null },
    { state: "running" },
    { state: "cancelled" },
  ])
    assert.throws(
      () =>
        validateTerminalClosedOutcomeProof(
          signJobData({ ...complete, ...change }),
        ),
      fail("INVALID_JOB"),
    );
  assert.ok(
    validateTerminalClosedOutcomeProof(
      signJobData({ ...complete, state: "uncertain", cleanupConfirmed: false }),
    ),
  );
});

test("full retained 256KiB snapshot is immutable, bounded and survives DATA copies without inventing a source handle", () => {
  const s = snapshot(Array.from({ length: 16 }, () => "한".repeat(5461) + "x"));
  assert.equal(s.retainedBytes, JOB_LIMITS.retainedBytes);
  assert.ok(
    Object.isFrozen(s) &&
      Object.isFrozen(s.output) &&
      Object.isFrozen(s.source),
  );
  assert.equal(
    validateJobOutputSnapshot(JSON.parse(JSON.stringify(s))).sha256,
    s.sha256,
  );
  assert.throws(
    () => snapshot(["x".repeat(JOB_LIMITS.eventBytes + 1)]),
    fail("INVALID_JOB"),
  );
  assert.throws(
    () =>
      snapshot(
        Array.from({ length: 17 }, () => "x".repeat(JOB_LIMITS.eventBytes)),
      ),
    fail("INVALID_JOB"),
  );
});

test("snapshot rejects noncontiguous, false byte counts, empty events and unretained suffixes even after a new checksum", () => {
  const s = snapshot(["one", "two"]);
  for (const change of [
    { output: [{ ...s.output[0]!, seq: 2 }, s.output[1]!] },
    { retainedBytes: 5 },
    { observedBytes: 0 },
    { throughSeq: 3 },
    { output: [{ seq: 1, data: "", bytes: 0 }, s.output[1]!] },
    { output: [{ ...s.output[0]!, bytes: 4 }, s.output[1]!] },
  ])
    assert.throws(
      () =>
        validateJobOutputSnapshot(
          signJobData({ ...s, ...change }, JOB_LIMITS.snapshotBytes),
        ),
      fail("INVALID_JOB"),
    );
});

test("8KiB pages split 16KiB events at exact UTF-8 codepoints and reconstruct text once", () => {
  const text = "🙂한글".repeat(1300),
    s = snapshot([text]),
    parts: string[] = [];
  let current: JobOutputCursor | undefined,
    pages = 0;
  for (;;) {
    const page = readJobOutput(s, {
      ...request,
      ...(current ? { cursor: current } : {}),
    });
    assert.ok(
      page.rawBytes <= JOB_LIMITS.pageRawBytes &&
        Buffer.byteLength(JSON.stringify(page)) <= JOB_LIMITS.pageEncodedBytes,
    );
    assert.equal(page.gap, null);
    const data = page.fragments.map((f) => f.data).join("");
    assert.equal(data.includes("\ufffd"), false);
    parts.push(data);
    current = page.nextCursor;
    pages++;
    if (!page.hasMore) break;
  }
  assert.equal(parts.join(""), text);
  assert.equal(pages, 2);
  assert.deepEqual([current.eventSeq, current.byteOffset], [2, 0]);
  assert.equal(readJobOutput(s, { ...request, cursor: current }).rawBytes, 0);
});

test("maximum control-character escaping remains under the encoded page bound", () => {
  const s = snapshot(["\0".repeat(JOB_LIMITS.eventBytes)]),
    page = readJobOutput(s, request);
  assert.equal(page.rawBytes, JOB_LIMITS.pageRawBytes);
  assert.ok(
    Buffer.byteLength(JSON.stringify(page)) <= JOB_LIMITS.pageEncodedBytes,
  );
  assert.equal(page.nextCursor.byteOffset, JOB_LIMITS.pageRawBytes);
});

test("fragment limit stops on exact event boundaries and fixed small byte limit always advances valid Unicode", () => {
  const s = snapshot(Array.from({ length: 100 }, () => "🙂")),
    page = readJobOutput(s, { ...request, maxFragments: 64 });
  assert.equal(page.fragments.length, 64);
  assert.equal(page.nextCursor.eventSeq, 65);
  assert.equal(page.hasMore, true);
  const small = readJobOutput(s, { ...request, maxBytes: 4 });
  assert.equal(small.rawBytes, 4);
  assert.equal(small.nextCursor.eventSeq, 2);
  assert.throws(
    () => readJobOutput(s, { ...request, maxBytes: 3 }),
    fail("INVALID_JOB_OUTPUT_LIMIT"),
  );
  assert.throws(
    () => readJobOutput(s, { ...request, maxFragments: 0 }),
    fail("INVALID_JOB_OUTPUT_LIMIT"),
  );
});

test("retention loss is an explicit exact range including partial cursor offset; no tail-only fallback", () => {
  const s = snapshot(["five", "six"], 5, 100),
    page = readJobOutput(s, { ...request, cursor: cursor(s, 2, 3) });
  assert.deepEqual(
    { ...page.gap },
    { fromSeq: 2, fromByteOffset: 3, toSeq: 4, oldestSeq: 5 },
  );
  assert.equal(page.fragments[0]!.seq, 5);
  assert.equal(page.fragments.map((f) => f.data).join(""), "fivesix");
  const empty = snapshot([], 7, 100),
    missing = readJobOutput(empty, request);
  assert.deepEqual(
    { ...missing.gap },
    { fromSeq: 1, fromByteOffset: 0, toSeq: 6, oldestSeq: 7 },
  );
  assert.equal(missing.hasMore, false);
  assert.equal(missing.nextCursor.eventSeq, 7);
});

test("foreign job/revision/source/snapshot/future cursors reject instead of clamping or resetting", () => {
  const s = snapshot(["🙂text"]),
    c = cursor(s, 1);
  for (const change of [
    { jobId: "other" },
    { jobRevisionId: "new-head" },
    { sourceSha256: "a".repeat(64) },
    { snapshotSha256: "b".repeat(64) },
    { throughSeq: 2 },
  ])
    assert.throws(
      () =>
        readJobOutput(s, {
          ...request,
          cursor: signJobData({ ...c, ...change }),
        }),
      fail("JOB_OUTPUT_CURSOR_STALE"),
    );
  assert.throws(
    () => readJobOutput(s, { ...request, cursor: cursor(s, 1, 1) }),
    fail("INVALID_JOB_OUTPUT_CURSOR"),
  );
  assert.throws(
    () =>
      readJobOutput(s, {
        ...request,
        cursor: cursor(s, 1, Buffer.byteLength(s.output[0]!.data)),
      }),
    fail("INVALID_JOB_OUTPUT_CURSOR"),
  );
  assert.throws(
    () => validateJobOutputCursor(cursor(s, 3)),
    fail("INVALID_JOB"),
  );
  assert.throws(
    () => validateJobOutputCursor(cursor(s, 2, 1)),
    fail("INVALID_JOB"),
  );
});

test("frozen snapshot and its cursor stay usable after independent DATA containing newer bytes is captured", () => {
  const s = snapshot(["old🙂text"]),
    first = readJobOutput(s, { ...request, maxBytes: 4 }),
    later = snapshot(["old🙂text", "new"]);
  const tail = readJobOutput(s, { ...request, cursor: first.nextCursor });
  assert.equal(
    first.fragments.map((f) => f.data).join("") +
      tail.fragments.map((f) => f.data).join(""),
    "old🙂text",
  );
  assert.throws(
    () => readJobOutput(later, { ...request, cursor: first.nextCursor }),
    fail("JOB_OUTPUT_CURSOR_STALE"),
  );
});

test("output page validators reject altered scope, count, gap and cursor continuations despite a valid new checksum", () => {
  const page = readJobOutput(snapshot(["text"]), request);
  for (const change of [
    { rawBytes: 3 },
    { hasMore: true },
    { sourceSha256: "a".repeat(64) },
    {
      nextCursor: signJobData({
        ...page.nextCursor,
        eventSeq: 1,
        byteOffset: 2,
      }),
    },
    { gap: { fromSeq: 1, fromByteOffset: 0, toSeq: 1, oldestSeq: 2 } },
    { fragments: [{ ...page.fragments[0]!, bytes: 5 }] },
  ])
    assert.throws(
      () =>
        validateJobOutputPage(
          signJobData({ ...page, ...change }, JOB_LIMITS.pageEncodedBytes),
        ),
      fail("INVALID_JOB", "JOB_OUTPUT_CURSOR_STALE"),
    );
});

test("exact empty history returns canonical EOF and rejects unsupported read grant fields without property traps", () => {
  const s = snapshot([]),
    page = readJobOutput(s, request);
  assert.equal(page.rawBytes, 0);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor.eventSeq, 1);
  assert.equal(page.nextCursor.byteOffset, 0);
  let traps = 0;
  const value = Object.defineProperty({ ...request }, "maxBytes", {
    enumerable: true,
    get() {
      traps++;
      return 8192;
    },
  });
  assert.throws(() => readJobOutput(s, value), fail("INVALID_JOB"));
  assert.equal(traps, 0);
  assert.throws(
    () => readJobOutput(s, { ...request, authority: "user" } as never),
    fail("INVALID_JOB"),
  );
});

test("confirmed physical cleanup remains separate from an uncertain terminal journal result", () => {
  const observation = signJobData({
    sourceSha256: source().sha256,
    state: "uncertain" as const,
    outputSeq: 1,
    oldestSeq: 1,
    observedBytes: 4,
    retainedBytes: 4,
    cleanupConfirmed: true,
    exitCode: 0,
    reason: "journal_failed",
    updatedAt: "2026-10-08T00:00:00.000Z",
  });
  assert.equal(
    validateTerminalObservationProof(observation).state,
    "uncertain",
  );
  const closed = signJobData({
    sourceSha256: source().sha256,
    state: "uncertain" as const,
    exitCode: 0,
    cancelled: false,
    timedOut: false,
    cleanupConfirmed: true,
    reason: "journal_failed",
    closedAt: "2026-10-08T00:00:00.000Z",
  });
  assert.equal(validateTerminalClosedOutcomeProof(closed).state, "uncertain");
  assert.throws(
    () =>
      validateTerminalObservationProof(
        signJobData({ ...observation, outputSeq: 100 }),
      ),
    fail("INVALID_JOB"),
  );
  assert.throws(() => snapshot(["retained"], 5), fail("INVALID_JOB"));
  const page = readJobOutput(snapshot(["text"]), request);
  assert.throws(
    () =>
      validateJobOutputPage(
        signJobData(
          {
            ...page,
            fragments: [],
            rawBytes: 0,
            nextCursor: signJobData({
              ...page.nextCursor,
              eventSeq: 1,
              byteOffset: 0,
            }),
            hasMore: true,
          },
          JOB_LIMITS.pageEncodedBytes,
        ),
      ),
    fail("INVALID_JOB"),
  );
});
