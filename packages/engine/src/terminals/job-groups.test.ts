import assert from "node:assert/strict";
import test from "node:test";
import { observedJobGroupsFromSnapshot as groups } from "./job-groups.js";

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
