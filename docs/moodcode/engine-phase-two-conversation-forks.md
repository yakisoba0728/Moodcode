# MC2-14 — Effect-preserving conversation forks

This lane creates a real Session, queued native input, Run, and provider request from an explicitly approved frozen conversation. It preserves prior filesystem effects and records their provenance. A conversation fork is a new semantic branch; it does not rewind a repository, retry an old command, transfer an old approval, or resume a provider Attempt.

## Host flow

Enable `conversationForks: true` when constructing `MoodcodeEngine`; the default is off and child engines do not inherit the host capability.

```ts
const original = await engine.captureForkPreview({
  sourceSessionId,
  throughRunId, // optional whole completed Run boundary
  prompt: "Review the previous result and propose the next change.",
  disposition: "exact-replay", // explicit 'semantic' drops opaque replay
});
const preview = engine.readForkPreview(original);
const result = engine.forkConversationView({
  preview: original,
  requestId: "host-selected-fork-request",
  approved: true,
  approvalFingerprint: preview.sha256,
});
engine.releaseForkPreview(original);
```

The Original preview binds the complete manifest, prompt, normalized budgets/configuration, target readonly profile and catalogue, provider capabilities, physical source/target workspace, optional managed worktree, and parent lineage. Copies, released handles, getters, stale source journals, expired previews, cancelled signals, changed profile/catalogue, unavailable workspaces, and unresolved execution cleanup cannot admit input. Approval is an explicit host decision over that exact preview; it is not a blanket model tool grant.

Materialization creates the new Session, applies the real readonly profile, accepts one native queued input, writes the signed lineage document, and appends independent immutable materialization evidence in one primary SQLite transaction. Wake occurs only after COMMIT. Duplicate request history returns an immutable copy and never reconstructs a live handle or reaccepts input. The source terminal Run receives no new execution event.

## Actual context and effects

The first fork Run uses the reserved `moodcode-conversation-fork-readonly` profile in plan mode: `read_file`, `list_files`, `search_files`, `glob_files`, and `regex_search`. This profile is checked at real promotion and provider dispatch. A later explicit build Run uses the existing normal tools and approval pipeline; a new command requires a new genuine approval.

`ContextService` reserves the frozen history before selecting ordinary context. Native source IDs and hashes become context source identifiers; selected source SQL Runs, Tools, Parts, Approvals and Checkpoints are not copied into the target execution tables. Completed tool exchanges remain whole when replay-compatible. Opaque replay requires the same provider, model and replay protocol. An explicitly approved semantic branch instead supplies quoted assistant DATA and no opaque replay or old live tool-call structure. Media/file grant transfer is unsupported in this lane.

The context includes source and target roots, managed worktree/base commit when selected, the fact that previous effects belong to the source root, and the fact that the filesystem was not rewound. Choosing an earlier conversation boundary retains later actual filesystem effects and marks later Run identities in the manifest.

Bounded manifests include at most the last 16 whole eligible Runs, 64 messages, 512 native pins, 128 KiB source DATA and 64 KiB rendered history. Complete records are capped at 256 KiB, retained preview handles at 32, and lineage depth at eight. Native body size/cardinality is checked before loading history. The fixed actual Run limits and provider model context/output reservation still apply; excess history is rejected rather than silently increasing budgets or dropping a tool pair.

A different physical target requires an explicitly pre-created, ready, unclaimed managed worktree verified by the existing worktree manager. This API does not create a worktree or revert source changes. The ordinary same-workspace path keeps the current filesystem unchanged.

Actual child creation can receive bounded quoted lineage DATA through the root-owned child path. It is pinned to the genuine live parent Run and actual child allocation, carries no opaque replay or inherited approval, and is checked again before the child provider dispatch. Imported/reopened child DATA has no reconstructed Original parent grant.

## Restart, import and uncertainty

A process crash before materialization COMMIT leaves no fork Session/input/receipt; after COMMIT it leaves one durable accepted input and lineage. Reopen does not auto-wake or replay a command. Explicit resume still requires the feature opt-in and current source/target/runtime pins.

`exportConversationForkHistory(sessionId)` and Original `captureForkImportPreview` / exact-approved `importConversationForkHistory` support target-only paused history in a fresh database and a different physical workspace. Signed birth manifests preserve original source IDs and hashes; imported history reads do not require donor source rows. No donor Input, Run, Tool, approval or process is fabricated. Imported DATA has no activation capability and rejects provider dispatch. A target-only import without actual source execution rows cannot become a new active fork. Full Engine archive/import also pauses forks; an explicitly approved semantic fork from independently available eligible actual source history remains a separate operation.

Native alias/hash corruption, missing immutable evidence, changed first-input acceptance, nonterminal source execution, unresolved cleanup and opaque mismatch fail closed. Reader completion or a copied DTO never proves source execution cleanup. Readonly lineage history is available without enabling dispatch.

## Verification

The feature suite exercises 21 actual Engine/Git/SQLite/provider cases: prior command effects, exact approval, new approval for a subsequent write, earlier cutoff, opaque compatibility, native tampering, source/cleanup denial, bounded context, late profile drift, child lifetime/budget, worktree selection, transaction rollback, fork-of-fork, paused relocated import, restart and SIGKILL on both sides of COMMIT. Real commands run only in temporary local fixture repositories and their process groups are joined.

The adjacent focused regression suite passed with the feature suite: 69 tests, zero failures or skips. Final feature-only source/type/format evidence is recorded in `engine-phase-two-conversation-forks-verification.json`. Whole repository integration gates are owned by the parent integration task and are not claimed here. This lane introduces no schema migration and its isolated baseline used DB22. The integrated independent-host-command lane advances the shared primary database to DB23; final whole-engine evidence is recorded in `engine-phase-two-parallel-features-verification.json`.
