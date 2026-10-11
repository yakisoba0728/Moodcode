import type { RunConfig } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";

// Only the private resident/native-Run guard may authorize this comparison; every non-budget setting stays fixed.
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
  const widened = <K extends string>(
    from: Readonly<Record<K, number>>,
    to: Readonly<Record<K, number>>,
    keys: readonly K[],
  ) =>
    keys.some(
      (key) => !Number.isFinite(to[key]) || to[key] < 1 || to[key] > from[key],
    );
  if (
    widened(original.limits, current.limits, limits) ||
    widened(original.budgets, current.budgets, budgets)
  )
    return false;
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
