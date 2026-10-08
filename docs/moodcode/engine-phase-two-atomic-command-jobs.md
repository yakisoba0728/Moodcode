# Atomic terminal delivery and native command observations

This increment connects two actual consumers: atomic delivery of an existing user-terminal completion to the native input queue, and observation of an approved `run_command` owned by its current Run. Both are enabled by the existing Root `jobs:true` option. Children keep jobs disabled. The engine uses its own TypeScript implementation and the existing command supervisor; no external agent code or prompts were copied.

## Atomic native queue delivery

The Root path of `deliverCommandJobResult` now puts the delivery intent, the actual native input, `input.accepted`, and the accepted receipt in one synchronous primary SQLite transaction. The producer checks the original settled target and its current workspace/profile/catalogue/configuration, then calls native input storage directly. It schedules publication and `InputScheduler.wake` only after this store's successful COMMIT. ROLLBACK discards those callbacks. A wake failure cannot reverse an already committed input.

Historical duplicate requests return the same native acceptance without creating another input or reconstructing an original target. A process killed after native input insertion but before COMMIT leaves no input, receipt, or event. A process killed after COMMIT but before wake leaves exactly one pending accepted input. Explicit restart resume consumes that input once. Delivery never appends a new event to an already terminal Run; its records and input event belong to the session. The legacy trusted consumer port without the atomic method still preserves its receipt gap as uncertain and never reaccepts that input.

## Observing the actual approved command

The built-in `run_command` producer receives a private command observer when jobs are enabled. Runner retains the original ToolContext in a WeakMap, checks its actual live Run/Turn/Attempt/Tool, current catalogue and exact allowed approval, and exposes bounded identity DATA only to that original context. Command preparation, native policy/preflight, budgets, checkpointing, cancellation, and physical ownership remain in the actual command execution path. `verify_changes` retains its original nested command execution without creating a separate command job.

The observer writes `starting` before fork, `running` only after the actual supervisor PID, and `settling` only after physical outcome, sealed output artifacts, and the actual command checkpoint exist. It reaches `completed`, `failed`, or `cancelled` only after native Tool and Part settlement. An interrupted Tool, lost outcome, or journal settlement failure preserves uncertainty. A settlement failure after the actual Tool/Part does not write a second tool result or continue the model loop as an ordinary recoverable error.

Command observation heads use the existing native CAS SessionDocument namespace `command.job.<hash>`. Immutable `command.job.source_admitted`, `command.job.process_admitted`, `command.job.closed_observed`, and `session.document.updated` events independently pin the source, physical PID, completion, and exact revision/body. Readers and archive validation check those anchors against the actual allowed approval, prepared command, Tool, Turn, Attempt, checkpoint and terminal Part. Rehashing a generic SessionDocument cannot invent a different source, PID, or completion. This reuses DB22 storage; schema version and catalogue remain unchanged.

Native proof admission is capped at 128 command observation documents, 64 KiB per document, and 8 MiB aggregate bodies, checked before reading JSON. Reaching this retained-history capacity rejects a new observed command before fork; restart does not reset that capacity. Automatic retention/pruning is not provided in this increment.

Each observed command has a Root epoch and actual source tuple. Native history survives restart, but runtime Originals, output snapshots, process ownership and source handles do not. Recovery makes interrupted observations uncertain and never respawns their command. Import pauses the history. Imported unknown cleanup still blocks workspace execution; a completed imported observation does not invent unknown cleanup.

## Host API and output bounds

`inspectOwnedCommandJobs(workspaceId, sessionId?)` and `getOwnedCommandJob(workspaceId, jobId)` read bounded native history even with jobs disabled. `captureOwnedCommandJobOutput({workspaceId,jobId})` returns an original frozen observation handle. `readOwnedCommandJobOutput(original,{afterSeq?,maxBytes?})` pages that snapshot, and `releaseOwnedCommandJobHandle(original)` releases observation only. The immutable page contains the source/snapshot digests, sequence bounds, raw observed bytes, decoded retained bytes and explicit loss gap.

Raw chunks are at most 16 KiB, the decoded ring is at most 256 KiB, and the pre-admission output queue is at most 64 KiB. Actual PID admission precedes publishing queued output. A page accepts 16–64 KiB and at most 64 whole events. Up to 32 snapshots and 16 MiB are retained per Root. Invalid UTF-8 decoding can increase retained text bytes relative to raw observed bytes; those counts remain distinct. There is no 8 KiB model output adapter in this increment.

Artifact descriptors bind the actual original fd, device/inode, size, timestamp, incremental raw SHA and truncation counters. Completion and each new output capture recheck the named file against its sealed descriptor. Replacement by equal bytes at a new inode invalidates a new capture. An already frozen original page remains the same detached DATA. The existing bounded command artifacts and checkpoint preserve partial output truth.

`cancelOwnedCommandJob({workspaceId,jobId,expectedRevision,requestId})` cancels the actual **owning Run** and joins its existing cleanup. It does not claim independent one-command cancellation. Request dedupe and revision checks prevent stale cancellation. Releasing an output handle leaves the Run and its workspace ownership intact.

## Verification and remaining scope

The independent fixtures cover actual exact approval/deny, native context copies/getters/proxies, pre-fork SQL rollback with zero spawn, bounded Unicode output and loss gaps, sealed artifact replacement, cancellation and physical PID cleanup, host close/reopen, native completion/PID tampering, final observation journal faults, Root SIGKILL, paused import, and before/after-COMMIT result delivery crashes. Native storage tests use explicitly trusted SQL DATA fixtures; separate integration tests exercise genuine runtime Originals and actual engine submission with registered profile snapshots. Final aggregate results and frozen source hashes are recorded in [the verification evidence](engine-phase-two-atomic-command-jobs-verification.json).

MC2-10a/b/c/d remain in progress. Independent idle-workspace host command approval/lease, explicit foreground-to-background ownership transfer, parent-terminal-independent lifetime, model handle selection/output adapter, completion inbox delivery for owned commands, broader EPERM/output backpressure coverage, and the remaining engine plan are still required. The original user-terminal watch remains readonly. The four existing environment debts remain unchanged and the overall goal stays active.
