export const WORKTREE_STATES = [
  "creating",
  "booting",
  "ready",
  "failed",
  "cleaning",
  "removed",
  "uncertain",
] as const;
export const WORKTREE_JOURNAL = Object.freeze({
  kind: "engine.worktrees",
  maxRecords: 128,
  maxBytes: 200 * 1024,
});
