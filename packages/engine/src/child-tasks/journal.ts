import type { ChildBudget, ChildTaskState } from "./index.js";

export const CHILD_BUDGET_KEYS = [
  "turns",
  "toolCalls",
  "outputBytes",
  "durationMs",
] as const;
export const CHILD_USAGE_KEYS = ["turns", "toolCalls", "outputBytes"] as const;
export const CHILD_BUDGET_MAX: Readonly<ChildBudget> = Object.freeze({
  turns: 10_000,
  toolCalls: 10_000,
  outputBytes: 16_777_216,
  durationMs: 3_600_000,
});
export const CHILD_TASK_STATES = [
  "starting",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "uncertain",
] as const;
export const CHILD_OUTCOME_STATES: readonly ChildTaskState[] = [
  "completed",
  "failed",
  "cancelled",
];
export const CHILD_TERMINAL_STATES: readonly ChildTaskState[] = [
  ...CHILD_OUTCOME_STATES,
  "uncertain",
];
export const CHILD_TASK_JOURNAL = Object.freeze({
  kind: "engine.child_tasks",
  maxTasks: 32,
  maxBytes: 240 * 1024,
});
