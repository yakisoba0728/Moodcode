import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeJobGroupsFromSnapshot as analyze,
  observedJobGroupsFromSnapshot as groups,
  sessionGroupsFromSnapshot as sessions,
} from "./job-groups.js";

test("unrelated Linux kernel PGID zero rows do not prevent exact PTY descendant observation", () => {
  assert.deepEqual(
    groups("2 0 0\n3 2 0\n10 1 10\n20 10 20\n21 20 20\n22 20 22\n", 20, 10),
    [20, 22],
  );
});
test("selected zero, init or current-owner groups cannot be signalled as owned descendants", () => {
  for (const pgid of [0, 1, 10])
    assert.equal(groups(`10 1 10\n20 10 20\n21 20 ${pgid}`, 20, 10), undefined);
  assert.equal(groups("10 1 10\n20 10 0", 20, 10), undefined);
});
test("unknown or foreign PTY leader and malformed global observations remain unconfirmed", () => {
  for (const rows of [
    "10 1 10",
    "10 1 10\n20 9 20",
    "10 1 10\n20 10 21",
    "10 1 10\n20 10 20\n2 0 -1",
    "10 1 10\n20 10 20\n2 0 0\n2 0 0",
    "10 1 10\n20 10 20\nbroken",
  ])
    assert.equal(groups(rows, 20, 10), undefined);
});
test("row and ancestry bounds reject oversized observations without granting a partial tree", () => {
  const rows = ["10 1 10", "20 10 20"];
  for (let i = 21; i <= 8212; i++) rows.push(`${i} 20 20`);
  assert.equal(groups(rows.join("\n"), 20, 10), undefined);
  assert.equal(groups("0".repeat(2_097_153), 20, 10), undefined);
});

test("snapshot rejection metadata distinguishes absent, foreign and malformed DATA without granting a partial tree", () => {
  const cases = [
    ["10 1 10", "PROCESS_SNAPSHOT_LEADER_ABSENT"],
    ["20 9 21", "PROCESS_SNAPSHOT_LEADER_OWNER_MISMATCH"],
    ["20 10 21", "PROCESS_SNAPSHOT_LEADER_GROUP_MISMATCH"],
    ["10 1 10\nprivate-output", "PROCESS_SNAPSHOT_INVALID_ROWS"],
    ["20 10 20\n2 0 0\n2 0 0", "PROCESS_SNAPSHOT_INVALID_ROWS"],
    ["20 10 20\n21 20 Infinity", "PROCESS_SNAPSHOT_INVALID_ROWS"],
    ["20 10 20\n21 20 -1", "PROCESS_SNAPSHOT_INVALID_ROWS"],
    ["20 10 20\n21 20 0", "PROCESS_SNAPSHOT_UNOWNED_GROUP"],
    ["20 10 20\n21 20 1", "PROCESS_SNAPSHOT_UNOWNED_GROUP"],
    ["20 10 20\n21 20 10", "PROCESS_SNAPSHOT_UNOWNED_GROUP"],
    ["20 10 20\n21 20 21\n10 21 99", "PROCESS_SNAPSHOT_CYCLE"],
  ] as const;
  for (const [rows, errorCode] of cases) {
    assert.deepEqual(analyze(rows, 20, 10), { groups: undefined, errorCode });
    assert.equal(groups(rows, 20, 10), undefined);
  }
  assert.deepEqual(analyze("2 0 0\n20 10 20\n21 20 21\n22 20 21", 20, 10), {
    groups: [20, 21],
  });
});

test("snapshot input, byte, row and tree limits retain their exact inclusive boundaries", () => {
  for (const [pid, ownerPid] of [
    [1, 10],
    [20, 1],
    [Number.NaN, 10],
    [20, Number.MAX_SAFE_INTEGER + 1],
  ])
    assert.deepEqual(analyze("20 10 20", pid!, ownerPid!), {
      groups: undefined,
      errorCode: "PROCESS_SNAPSHOT_INVALID_INPUT",
    });
  assert.deepEqual(analyze(null as unknown as string, 20, 10), {
    groups: undefined,
    errorCode: "PROCESS_SNAPSHOT_INVALID_INPUT",
  });

  const byteBoundary = "20 10 20".padEnd(2_097_152, " ");
  assert.deepEqual(analyze(byteBoundary, 20, 10), { groups: [20] });
  assert.deepEqual(analyze(byteBoundary + " ", 20, 10), {
    groups: undefined,
    errorCode: "PROCESS_SNAPSHOT_BYTE_LIMIT",
  });
  // The bound measures UTF-8 bytes, not JavaScript UTF-16 string length.
  assert.deepEqual(analyze("한".repeat(699_051), 20, 10), {
    groups: undefined,
    errorCode: "PROCESS_SNAPSHOT_BYTE_LIMIT",
  });

  const rowBoundary = ["20 10 20"];
  for (let child = 100; rowBoundary.length < 65_536; child++)
    rowBoundary.push(`${child} 0 0`);
  assert.deepEqual(analyze(rowBoundary.join("\n"), 20, 10), { groups: [20] });
  assert.deepEqual(analyze(rowBoundary.join("\n") + "\n99999 0 0", 20, 10), {
    groups: undefined,
    errorCode: "PROCESS_SNAPSHOT_ROW_LIMIT",
  });

  const treeBoundary = ["20 10 20"];
  for (let child = 21; treeBoundary.length < 8192; child++)
    treeBoundary.push(`${child} 20 20`);
  assert.deepEqual(analyze(treeBoundary.join("\n"), 20, 10), { groups: [20] });
  assert.deepEqual(analyze(treeBoundary.join("\n") + "\n99999 20 20", 20, 10), {
    groups: undefined,
    errorCode: "PROCESS_SNAPSHOT_TREE_LIMIT",
  });
});

test("snapshot rejection precedence stays input then global rows then leader then ancestry", () => {
  assert.equal(
    analyze("0".repeat(2_097_153), 1, 1).errorCode,
    "PROCESS_SNAPSHOT_BYTE_LIMIT",
  );
  assert.equal(
    analyze("broken", 1, 1).errorCode,
    "PROCESS_SNAPSHOT_INVALID_INPUT",
  );
  assert.equal(analyze("", 20, 10).errorCode, "PROCESS_SNAPSHOT_INVALID_ROWS");
  assert.equal(
    analyze("20 9 99\nbroken", 20, 10).errorCode,
    "PROCESS_SNAPSHOT_INVALID_ROWS",
  );
  assert.equal(
    analyze("20 9 99\n21 20 0", 20, 10).errorCode,
    "PROCESS_SNAPSHOT_LEADER_OWNER_MISMATCH",
  );
  assert.equal(
    analyze("20 10 99\n21 20 0", 20, 10).errorCode,
    "PROCESS_SNAPSHOT_LEADER_GROUP_MISMATCH",
  );
  assert.equal(
    analyze("20 10 20\n21 20 0\n10 21 99", 20, 10).errorCode,
    "PROCESS_SNAPSHOT_UNOWNED_GROUP",
  );
});

test("an exited leader's session yields every remaining member group and nothing else", () => {
  assert.deepEqual(
    sessions("2 0 0\n10 10 10\n21 21 20\n22 21 20\n23 23 20\n30 30 30\n", 20, 10),
    [21, 23],
  );
  assert.deepEqual(sessions("2 0 0\n10 10 10\n30 30 30", 20, 10), []);
});
test("a live process holding the exited leader pid ends the session instead of selecting a reused one", () => {
  assert.deepEqual(sessions("10 10 10\n20 20 20\n21 21 20", 20, 10), []);
});
test("missing session ids, malformed rows and unowned session groups stay unconfirmed", () => {
  for (const rows of [
    "10 10\n21 21",
    "",
    "10 10 10\n21 21 20 4",
    "10 10 10\n21 x 20",
    "10 10 10\n21 21 -1",
    "10 10 10\n10 10 10",
    "10 10 10\n21 0 20",
    "10 10 10\n21 1 20",
    "10 10 10\n21 10 20",
  ])
    assert.equal(sessions(rows, 20, 10), undefined);
  assert.equal(sessions("10 10 10", 1, 10), undefined);
  assert.equal(sessions("0".repeat(2_097_153), 20, 10), undefined);
});
