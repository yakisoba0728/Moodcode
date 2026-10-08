import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSubmitInput,
  normalizeEngineBudgets,
} from "@moodcode/contracts/validation";
import { narrowedResidentConfig } from "./resident-config.js";

const original = () =>
  normalizeSubmitInput({
    sessionId: "native-session",
    requestId: "native-input",
    prompt: "native",
    config: {
      providerId: "original",
      modelId: "original",
      mode: "build",
      budgets: normalizeEngineBudgets({}),
    },
  }).config;

test("resident scope permits only smaller lifetime allowances while retaining the original settings", () => {
  const baseline = original(),
    current = structuredClone(baseline);
  Object.assign(current.limits, {
    maxTurns: 1,
    maxToolCalls: 1,
    maxOutputBytes: 1024,
    maxDurationMs: 1000,
    toolTimeoutMs: 1000,
  });
  Object.assign(current.budgets!, { turnAllowance: 1, maxToolCallsPerTurn: 1 });
  assert.equal(narrowedResidentConfig(baseline, current), true);
  assert.deepEqual(baseline, original());
});

test("resident scope rejects every widened lifetime allowance", () => {
  const baseline = original();
  for (const key of [
    "maxTurns",
    "maxToolCalls",
    "maxOutputBytes",
    "maxDurationMs",
    "toolTimeoutMs",
  ] as const) {
    const current = structuredClone(baseline);
    current.limits[key]++;
    assert.equal(narrowedResidentConfig(baseline, current), false, key);
  }
  for (const key of ["turnAllowance", "maxToolCallsPerTurn"] as const) {
    const current = structuredClone(baseline);
    current.budgets![key]++;
    assert.equal(narrowedResidentConfig(baseline, current), false, key);
  }
});

test("resident scope cannot change provider, model, mode, profile revision or provider-attempt allocation", () => {
  const baseline = original();
  const changes = [
    { providerId: "other" },
    { modelId: "other" },
    { mode: "plan" as const },
    { agentProfileId: "other", agentProfileRevision: "other" },
  ];
  for (const change of changes)
    assert.equal(
      narrowedResidentConfig(baseline, { ...baseline, ...change }),
      false,
    );
  const current = structuredClone(baseline);
  current.budgets!.maxProviderAttempts++;
  assert.equal(narrowedResidentConfig(baseline, current), false);
});

test("resident scope rejects non-finite, zero and missing budget values", () => {
  const baseline = original();
  for (const value of [NaN, Infinity, 0, -1]) {
    const current = structuredClone(baseline);
    current.limits.maxDurationMs = value;
    assert.equal(narrowedResidentConfig(baseline, current), false);
  }
  assert.equal(
    narrowedResidentConfig(baseline, { ...baseline, budgets: undefined }),
    false,
  );
});
