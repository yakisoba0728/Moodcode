# Parallel engine feature ownership

The user requested larger, finishable feature units on 2026-10-08. Each agent now owns a complete feature, including public Engine APIs, actual execution or consumption, native persistence and recovery, independent fixtures, focused type checks and regression tests. Root owns integration, aggregate verification, progress accounting and local commits.

The three managed worktrees start from `3584d6d` plus the frozen Run-owned command inbox implementation. They share dependencies but write separate source and build directories. No lane edits the primary checkout. A feature patch excludes that shared starting implementation; an isolated Git tree/index records the initial contents without changing the main index.

| Feature | Owner | Scope and completion evidence | Worktree |
| --- | --- | --- | --- |
| Independent host commands | `next_team_continuation` | Exact approval, physical command owner and workspace lease, real supervisor/output/checkpoint, cancellation and close, durable uncertainty, restart/import and crash tests. Owns DB23 migration integration. | `/Users/yakisoba0728/.codex/worktrees/engine-host-commands/Moodcode` |
| Approved Git commit receipts | `next_workflow_design` | MC2-13a–d: exact selection/HEAD/index/message/verification preview, actual commit, outcome and crash reconciliation, staged-change preservation, deny/stale/duplicate tests. | `/Users/yakisoba0728/.codex/worktrees/engine-approved-commits/Moodcode` |
| Effect-preserving conversation forks | `next_workflow_consumers` | MC2-14a–d: bounded original history and lineage, provider replay compatibility, actual new session/input consumption, new-effect approval, duplicate/crash/import tests. | `/Users/yakisoba0728/.codex/worktrees/engine-conversation-forks/Moodcode` |

Git and fork lanes use existing native storage contracts without allocating competing migration versions. Any limitation that prevents an actual consuming path is reported as unfinished. A schema or runtime interface alone does not satisfy a work item.

Each lane runs focused meaningful checks while implementing. Root reviews feature-only patches, resolves shared Engine/storage integration and runs one aggregate regression gate for the integrated source snapshot. Additional full runs require a new change, a failure or an unresolved concern. Future implementation continues in the isolated worktrees while Root verifies the current snapshot.

The overall goal remains active. This ownership change does not close work items, alter the original 80-item completion criteria or resolve environment debts. GUI, live account calls, external source copying, push and deployment remain outside this engine implementation goal.
