import type { RunConfig } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";

// Only the private resident/native-Run guard may authorize this comparison.
// The immutable original kernel policy and every non-budget setting stay fixed.
export function narrowedResidentConfig(
  original: RunConfig,
  current: RunConfig,
): boolean {
  const limits = [
    "maxTurns",
    "maxToolCalls",
    "maxOutputBytes",
    "maxDurationMs",
    "toolTimeoutMs",
  ] as const;
  const budgets = ["turnAllowance", "maxToolCallsPerTurn"] as const;
  if (!original.budgets || !current.budgets) return false;
  for (const key of limits) {
    if (
      !Number.isFinite(current.limits[key]) ||
      current.limits[key] < 1 ||
      current.limits[key] > original.limits[key]
    )
      return false;
  }
  for (const key of budgets) {
    if (
      !Number.isFinite(current.budgets[key]) ||
      current.budgets[key] < 1 ||
      current.budgets[key] > original.budgets[key]
    )
      return false;
  }
  const restored = {
    ...current,
    limits: {
      ...current.limits,
      ...Object.fromEntries(limits.map((key) => [key, original.limits[key]])),
    },
    budgets: {
      ...current.budgets,
      ...Object.fromEntries(
        budgets.map((key) => [key, original.budgets![key]]),
      ),
    },
  };
  return knowledgeHash(restored) === knowledgeHash(original);
}
