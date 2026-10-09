import assert from "node:assert/strict";
import test from "node:test";
import { terminalCleanupLabel } from "./terminal-status.js";

test("explicit native cleanup booleans retain their established labels", () => {
  assert.equal(terminalCleanupLabel(true), "확인됨");
  assert.equal(terminalCleanupLabel(false), "미확정");
});

test("restart null and missing cleanup remain unknown independently of saved terminal state", () => {
  for (const state of ["interrupted", "closed", "failed", "starting", "running"])
    for (const record of [{ state, cleanupConfirmed: null }, { state }])
      assert.equal(terminalCleanupLabel(record.cleanupConfirmed), "미확정", state);
});

test("unrecognized cleanup values cannot create native confirmation or a running label", () => {
  for (const value of ["true", "false", 1, 0, {}, []])
    assert.equal(terminalCleanupLabel(value), "미확정");
});
