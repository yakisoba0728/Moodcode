# Parallel engine feature ownership

The user requested larger, finishable feature units on 2026-10-08. Each agent owns one feature from Engine API through actual execution/consumption, native persistence/recovery, and meaningful integration tests. Root integrates feature-only patches, verifies one frozen aggregate, accounts for completion and makes local commits. Separate managed worktrees prevent build/source interference.

## Integrated feature batch

| Feature | Owner | Completed implementation | Evidence |
| --- | --- | --- | --- |
| Independent host commands | `next_team_continuation` | Exact host approval, actual supervisor/physical workspace lease, output/artifacts/checkpoint, cancellation/close, durable uncertainty, DB23 migration and crash/import tests. MC2-10 remains partial for foreground transfer and model consumption. | `engine-phase-two-host-commands.md`, `engine-phase-two-host-commands-verification.json` |
| Approved Git commit receipts | `next_workflow_design` | MC2-13a–d: exact selection/HEAD/index/message/genuine verification preview, actual commit preserving staging, cleanup, readonly reconcile, stale/cancel/crash/import tests. | `engine-phase-two-git-commit.md`, `engine-phase-two-git-commit-verification.json` |
| Effect-preserving conversation forks | `next_workflow_consumers` | MC2-14a–d: bounded original history/lineage and replay compatibility, actual new session/input/provider and child context, readonly first Run/new effect approval/worktree, crash/duplicate/import tests. | `engine-phase-two-conversation-forks.md`, `engine-phase-two-conversation-forks-verification.json` |

Root's joint fixture runs all three together with genuine verification and native approval, physical PID/cleanup, Git/index assertions and actual scripted provider consumption. Aggregate evidence is recorded in `engine-phase-two-parallel-features-verification.json`. The first aggregate exposed a compiled crash-fixture extension error and outdated DB23/SQL-query test expectations; those were corrected and independently rerun. The whole compiled gate passed; a later direct-source fork crash-fixture extension error was separately corrected and passed both compiled/source crash tests before the final broader source/fixture gates. All runtime sources remained unchanged. Per-lane checks alone do not close work items.

## Current larger feature units

The next worktrees start from `c2c9814` plus the integrated three-feature source snapshot. Each lane records its baseline tree/SHA and emits only its own feature delta. Root's later test compatibility corrections do not change the runtime source baseline.

| Feature | Owner | End-to-end scope | Worktree |
| --- | --- | --- | --- |
| Command model consumption and host inbox | `next_team_continuation` | Original-approved PTY/Run-owned/host aliases → actual readonly Tool/Part output → settled independent host result → exact consuming approval → atomic input/receipt/link/birth → promotion/provider/restart/import tests. | `/Users/yakisoba0728/.codex/worktrees/engine-command-consumers/Moodcode` |
| PR SHA-bound feedback | `next_workflow_design` | Actual GitHub GET adapter and independent HTTP fixtures → SHA-bound native snapshots/check/review policy → stable dedupe/cursor/gap → exact-approved atomic queue/provider consumption → original source/verification/repair-budget and crash/import tests. | `/Users/yakisoba0728/.codex/worktrees/engine-pr-feedback/Moodcode` |
| Effectful editor/validator workflow | `next_workflow_consumers` | Actual budgeted editor/validator child and worktree → native Tool/Part/checkpoint/verification → genuine approved merge → stage/join CAS → parent inbox → failure/cancel/source/cleanup/crash/import tests. | `/Users/yakisoba0728/.codex/worktrees/engine-workflow-effects/Moodcode` |

No lane edits the primary checkout or another lane's worktree. Shared API/storage changes are resolved by Root at integration. Each agent completes focused meaningful tests; Root performs final typecheck, whole compiled regression, broader direct source regression and coding fixtures against recorded source hashes. Source-only harness corrections receive focused checks in both execution forms and a fresh broader source gate; evidence records the differing fixture hash and unchanged runtime sources. A subsequent aggregate run requires a change, failure or unresolved concern.

The original 80-item goal and four environment debts remain active. Schemas, tool interfaces or type checks without actual consumers never satisfy completion. GUI, live account calls, copied external source, push and deployment remain outside this engine goal.
