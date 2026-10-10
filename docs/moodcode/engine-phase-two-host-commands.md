# Independent host commands

Moodcode can execute an explicitly approved command in an idle workspace without creating a Run, Turn, Attempt, Tool, legacy Approval, Checkpoint, or PTY identity. This lane is local host API only, requires `hostCommands: true`, and currently supports macOS, Linux, and FreeBSD. The existing Run-owned command tool keeps its native context and approval behavior.

## Public API and ownership

`previewHostCommand({ workspaceId, sessionId, command, cwd?, timeoutMs?, limits: { maxDurationMs, maxOutputBytes } })` returns an opaque Original handle. `readHostCommandPreview(handle)` returns its exact command, canonical cwd, timeout, platform, physical workspace/storage binding, cwd inode identity, policy version, and complete independent limits with a fingerprint.

`startHostCommand({ workspaceId, requestId, preview, fingerprint, approved, signal? })` requires that exact retained Original handle and fingerprint. `approved: false` records a durable deny and launches nothing. Approval commits a content-free manifest (path, SHA-256 and byte count per file, plus capture warnings) of the bounded before-effects snapshot and the independent owner before artifact creation or process launch; file contents are never persisted with the approval. Start resolves after genuine supervisor-ready PID admission commits; it can also return an unstarted cancelled terminal record. A failure after the approval commit rejects with `CLEANUP_UNCERTAIN`, leaves the job uncertain and quarantines the workspace. Duplicate request IDs with the same decision and fingerprint return existing history without launching again; a changed request conflicts. An old Engine, imported history, copied object, accessor, proxy, changed policy, or substituted physical root cannot provide a current Original approval.

`waitForHostCommand({workspaceId, jobId})` joins the actual retained execution. `cancelHostCommand(...)` aborts and joins that same owner. Engine close stops admission, signals every retained owner, and waits for physical cleanup and native settlement. An uncertain retained result makes close fail with `CLEANUP_UNCERTAIN`. Releasing a preview/output handle never releases the workspace lease.

The genuine `coordinator.withWorkspaceLease` promise spans preparation, snapshot, supervisor, output, physical closure, checkpoint, and terminal receipt. Live Runs, workspace maintenance/restore, another host command, and durable cleanup debt block admission. The shared physical command execution lock additionally prevents cross-owner physical execution.

## Policy and budgets

The existing `run_command` ToolPolicy is evaluated in build mode against the exact command and cwd. Every independent command still requires explicit host approval, including policy-allowed commands. Configured Run-only command preflight, role/resource policy, registry, or resource resolver is unsupported in this lane and fails before durable admission or physical effects; the neutral executor does not bypass it.

Limits are fixed in the approved preview: duration 1–300,000 ms and observed output 1–1,048,576 bytes. The command remains bounded to 16 KiB. Before/after workspace capture uses 128 files, 8 KiB per file, and 32 KiB of captured content; incomplete snapshots are identified. Timeout, host signal, Root close, and output-budget overflow abort the real supervisor and retain measured outcome/bytes. Output artifact retention remains independently bounded to the existing 1 MiB total capture and records exact truncation.

## Output and artifacts

`captureHostCommandOutput({workspaceId, jobId})` captures a genuine retained source as an opaque frozen handle. `readHostCommandOutput(handle, {cursor?})` returns advisory text pages bounded to 16 KiB raw text and 64 KiB encoded JSON, at most 64 fragments, with exact frozen-source cursor scope and UTF-8 codepoint offsets. The current ring retains 256 KiB and reports an explicit lost sequence range. Frozen pages stay stable as later output arrives; malformed source cursors and split-codepoint offsets are rejected. Invalid source UTF-8 is decoded as replacement text while sealed artifact byte evidence stays exact.

`readHostCommandArtifacts({workspaceId,jobId})` checks the actual retained owner, current physical root/storage binding, sealed stream SHA, inode/device, size and mtime. Same-byte inode substitution rejects a new observation. Previously frozen text remains advisory DATA and cannot confer execution or completion authority.

## Native evidence, restart, archive

DB23 adds STRICT/WITHOUT ROWID `host_command_revisions` and `host_command_heads`, workspace/session FKs, revision CAS, request dedupe, and one active host head per workspace. The actual schema catalogue is 139 entries, within the existing cap of 160; DB22 remains exactly 136. Session-only native approval, process and closed witnesses bind the full actual tuple independently of revision digests. The closed witness carries the completion with changed-file bodies replaced by their before/after hashes; the bodies stay only in the revision row. Older content-bearing approval and closed witnesses still validate. Native validation replays immutable preview/owner identity and transitions and rejects orphaned, rehashed PID/approval, incomplete or contradictory history.

Bounds are global: 128 jobs, 4,096 revisions, 256 KiB per signed revision and 32 MiB of revision DATA. Admission reserves four maximum-size future rows for an approved job (PID, checkpoint, terminal, import); a running job reserves three; each settled job reserves one import row. Native output reaching capacity stops chunk persistence with `outputJournalGap: true`, preserving physical draining, exact sealed stream evidence, terminal/recovery/import capacity and truthful closure. Hard resource limits are never widened.

Approval, PID, checkpoint or receipt SQL faults roll back their transaction. A failure after physical admission cleans the actual process, records uncertainty where possible and quarantines the workspace even when the process has disappeared. Interrupted approved/running owners become durable `uncertain` on restart, including with the feature disabled. There is no restart, reaccept or automatic command replay. `inspectHostCommands(workspaceId)` and `getHostCommand(workspaceId,jobId)` expose validated historical DATA by default; history cannot reconstruct live source, output or cancellation capabilities.

Export/import includes DB23 validation, bounded logical recovery hashing and exact genuine history. Import appends `paused-import`, preserves successful cleanup receipts, pauses sessions and retains prior uncertainty debt. Recovery inspection and verified primary backup cover the new tables. Physical marker acknowledgment does not silently erase independent native uncertainty.

## Verification

Focused source tests cover actual filesystem/PID/output/checkpoint with no invented execution rows, explicit deny/stale/copy/accessor/proxy rejection, duplicate and host/Run lease conflicts, cancellation/close, fixed duration/output budgets, policy unsupported status, approval/PID/checkpoint/receipt SQL faults, truthful uncertainty/reopen/import, frozen cursor and sealed inode drift, native PID/approval witness mutation, DB23 rollback/idempotency/catalogue, genuine recovery backups, nearly full native output history with archive/import reserve, and SIGKILL before approval commit, after approval commit, after PID admission and after native terminal receipt. Existing Run-owned command regression, migration, archive and recovery suites are retained.

## Remaining boundaries

This increment does not transfer a live foreground Run into a background owner, run concurrent workspace commands, restore a host checkpoint, deliver independent host output to a model inbox, or provide a new approval UI. A Run-aware policy adapter and explicit host uncertainty-resolution contract require separate owner semantics. Historical inspection and recovery acknowledgment never imply those capabilities.
