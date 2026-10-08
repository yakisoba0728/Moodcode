# Parallel engine feature ownership

The user requested larger, finishable feature units on 2026-10-08. Each agent owns one feature from Engine API through actual execution/consumption, native persistence/recovery, and meaningful integration tests. Root integrates feature-only patches, verifies one frozen aggregate, accounts for completion and makes local commits. Separate managed worktrees prevent build/source interference.

## Integrated feature batch

| Feature | Owner | Completed implementation | Evidence |
| --- | --- | --- | --- |
| Independent host commands | `next_team_continuation` | Exact host approval, actual supervisor/physical workspace lease, output/artifacts/checkpoint, cancellation/close, durable uncertainty, DB23 migration and crash/import tests. MC2-10 remains partial for foreground transfer and model consumption. | `engine-phase-two-host-commands.md`, `engine-phase-two-host-commands-verification.json` |
| Approved Git commit receipts | `next_workflow_design` | MC2-13a–d: exact selection/HEAD/index/message/genuine verification preview, actual commit preserving staging, cleanup, readonly reconcile, stale/cancel/crash/import tests. | `engine-phase-two-git-commit.md`, `engine-phase-two-git-commit-verification.json` |
| Effect-preserving conversation forks | `next_workflow_consumers` | MC2-14a–d: bounded original history/lineage and replay compatibility, actual new session/input/provider and child context, readonly first Run/new effect approval/worktree, crash/duplicate/import tests. | `engine-phase-two-conversation-forks.md`, `engine-phase-two-conversation-forks-verification.json` |

Root's joint fixture runs all three together with genuine verification and native approval, physical PID/cleanup, Git/index assertions and actual scripted provider consumption. Aggregate evidence is recorded in `engine-phase-two-parallel-features-verification.json`. The first aggregate exposed a compiled crash-fixture extension error and outdated DB23/SQL-query test expectations; those were corrected and independently rerun. The whole compiled gate passed; a later direct-source fork crash-fixture extension error was separately corrected and passed both compiled/source crash tests before the final broader source/fixture gates. All runtime sources remained unchanged. Per-lane checks alone do not close work items.

## Integrated command/PR/workflow feature units

These feature worktrees started from `c2c9814` plus the integrated three-feature source snapshot. Each lane records its baseline tree/SHA and emits only its own feature delta. Root's later test compatibility corrections do not change the runtime source baseline.

| Feature | Owner | End-to-end scope | Worktree |
| --- | --- | --- | --- |
| Command model consumption and host inbox | `next_team_continuation` | Original-approved PTY/Run-owned/host aliases → actual readonly Tool/Part output → settled independent host result → exact consuming approval → atomic input/receipt/link/birth → promotion/provider/restart/import tests. | `/Users/yakisoba0728/.codex/worktrees/engine-command-consumers/Moodcode` |
| PR SHA-bound feedback | `next_workflow_design` | Actual GitHub GET adapter and independent HTTP fixtures → SHA-bound native snapshots/check/review policy → stable dedupe/cursor/gap → exact-approved atomic queue/provider consumption → original source/verification/repair-budget and crash/import tests. | `/Users/yakisoba0728/.codex/worktrees/engine-pr-feedback/Moodcode` |
| Effectful editor/validator workflow | `next_workflow_consumers` | Actual budgeted editor/validator child and worktree → native Tool/Part/checkpoint/verification → genuine approved merge → stage/join CAS → parent inbox → failure/cancel/source/cleanup/crash/import tests. | `/Users/yakisoba0728/.codex/worktrees/engine-workflow-effects/Moodcode` |

No lane edits the primary checkout or another lane's worktree. Shared API/storage changes are resolved by Root at integration. Each agent completes focused meaningful tests; Root performs final typecheck, whole compiled regression, broader direct source regression and coding fixtures against recorded source hashes. Source-only harness corrections receive focused checks in both execution forms and a fresh broader source gate; evidence records the differing fixture hash and unchanged runtime sources. A subsequent aggregate run requires a change, failure or unresolved concern.

The original 80-item goal and four environment debts remain active. Schemas, tool interfaces or type checks without actual consumers never satisfy completion. GUI, live account calls, copied external source, push and deployment remain outside this engine goal.


## Resident/sandbox/coding complete feature integration

| Feature | Owner | Actual completion boundary | Worktree |
| --- | --- | --- | --- |
| Resident team lifecycle (MC2-06c/d) | `next_team_continuation` | One engine-owned child survives its first terminal Run; actual mailbox inputs create later native Runs and ACKs; worker claim/work/submit and coordinator review use current native actors and exact approvals. Shared parent lifetime budgets, profile/catalogue pins, TTL/cancel/close, SQL/crash/import and no automatic actor revival are verified. | `/Users/yakisoba0728/.codex/worktrees/engine-resident-teams/Moodcode` |
| OS sandbox (MC2-17a–d) | `next_workflow_design` | Actual supported OS enforcement for command effects, independent host commands, child commands and read-only stdio MCP. Canonical filesystem/network policy, Original grants, new approval for widening, genuine PID/group/cleanup and native crash/import receipts. Unsupported platforms and producers reject before execution; no unsandboxed fallback. | `/Users/yakisoba0728/.codex/worktrees/engine-os-sandbox/Moodcode` |
| Coding attempt groups/headless batches (MC2-20a–d) | `next_workflow_consumers` | Two actual isolated editor/validator/reviewer candidates, fair parent budget reservation, bounded concurrency and strict native success evidence; Original selection plus genuinely approved merge; partial failures/cancel, exact source/runtime/export verification, SQL/crash/import and no candidate or merge replay. | `/Users/yakisoba0728/.codex/worktrees/engine-coding-batches/Moodcode` |

The first two worktrees use `aebd896` as their recorded baseline. Coding batches also seed the frozen workflow-effects patch so the complete workflow consumer can be reused immediately; its feature delta excludes that seed. Root keeps the integrated branch stable during aggregate tests. Agents run focused tests in parallel and deliver frozen feature-only patches, supporting source hashes and actual lifecycle evidence. Root integrates complete functionality, fixes shared-path incompatibilities and performs one fresh aggregate gate justified by each integration change. No agent is assigned only interfaces, only types or an unconsumed service.


## Current complete feature owners

The next three lanes start from `34c7c4a` in separate worktrees while Root verifies the preceding frozen aggregate. Each retains API → actual consumer → persistence/recovery → focused actual verification ownership.

| Feature | Owner | Actual completion boundary | Worktree |
| --- | --- | --- | --- |
| Foreground/background command lifetime (MC2-10a/b/d) | `next_team_continuation` | One actual supervisor/group PID through foreground/background transfer; native-approved model/host entry, bounded stdin/EOF/output, original reservations, cancel/close/receipt faults, SIGKILL/restart/import without PID-only reclaim. | `/Users/yakisoba0728/.codex/worktrees/engine-command-lifetimes/Moodcode` |
| ACP permission/write/terminal effects (MC2-09c/d) | `next_workflow_design` | Exact current session/Attempt/connection permission, native-approved file writes and terminal effects, wire delivery/cancel/late/duplicate failures, real process cleanup and paused restart/import; original readonly mode preserved. | `/Users/yakisoba0728/.codex/worktrees/engine-acp-effects/Moodcode` |
| Prepared-resource effect batches (MC2-18a–d) | `next_workflow_consumers` | Original current Turn/file identity and approval, up-front native budgets, disjoint existing-file update overlap, conflict serial fallback, per-member native Tool/Part/checkpoint/partial uncertainty, receipt fault and restart/import. Unknown command/MCP/create/delete/rename stay serial. | `/Users/yakisoba0728/.codex/worktrees/engine-effect-batches/Moodcode` |

No interface-only milestone closes a work item. Root accepts one frozen feature patch per lane, resolves shared source once and runs the combined final gates. The count changes only after those gates pass.
