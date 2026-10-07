# Verification controller and task completion

`verification/controller.ts` owns durable per-Run repair accounting and descriptive completion candidates. `verification/completion.ts` interprets the current host-owned plan and execution receipts. These services never create a Run or provider Attempt, execute a command, grant approval, or infer successful checks from model text.

## Host integration contract

Construct `VerificationController(store, plans, ports, clock?)`. Call `evaluate(sessionId, runId, expectedControllerRevision, input, signal)` at existing coordinator boundaries. The input contains the exact current source observation, verification document revision, last plan hash, and boundary:

```ts
interface VerificationControllerInput {
  source: VerificationSource;
  verificationRevision: number;
  planSha256: string | null;
  boundary: {
    id: string;
    phase: 'before-provider' | 'stop';
    turnId: string | null;
    providerTerminal: boolean;
    nativeTurnCompleted: boolean;
  };
}
```

For a stop boundary, use the actual completed Turn ID. `assertBoundaryCurrent` re-reads the owning Run's latest native Turn, provider Attempt and cleanup state. A before-provider boundary uses the coordinator's logical Run/loop/stage identity issued before the next Turn is created, then rechecks that same captured boundary at each Attempt dispatch. These IDs describe existing coordinator state rather than fabricated provider records.

The required ports are:

| Port | Contract |
| --- | --- |
| `observeSource(run, signal)` | Bounded observation of the host-selected repository source and original checkpoint references. Return `{sha256, revision, checkpointId}`; respect the original Run cancellation. |
| `readCurrentProfile(run)` | Current persisted host profile `{id, revision}`, or `null`; no model-supplied profile authority. |
| `readRemainingBudget(run)` | Remaining original Run `{turns, toolCalls, outputBytes, durationMs}`. Each field is a nonnegative integer bounded by that Run's original limit. Controller stages never replenish it. |
| `readExecutionBlocker(run)` | Bounded actual native verification tool / registration / uncertainty observation. Return `verification_denied`, `cleanup_uncertain`, `verification_cancelled`, `verification_unsupported`, `check_stale`, or `null`. The product host supplies this port; fixtures without native execution rows may omit it. |
| `assertBoundaryCurrent(run, boundary)` | Synchronous validation of the actual coordinator/native boundary immediately before and after source observation. |
| `commitCurrent(runId, kind, revision, data, verificationRevision)` | One primary SQLite transaction checking an active, non-cancelling Run, exact controller scope, expected verification document revision, and controller CAS. The root implementation is `SqliteStore.putActiveVerificationControllerDocument`. |

An outer `verify_changes` approval denial can leave zero verification receipts. The actual native denied Tool row therefore supplies a blocker. Known policy failure codes are an exact host allowlist; arbitrary error text and ordinary tool failures are not verification blockers. The blocker is included in the boundary input hash and checked again after awaited observations.

## Completion evidence and continuations

Only a terminal provider boundary with an actual completed native Turn can publish `taskVerified: true`. Every required check must have a current matching plan, registration, profile, source, and receipt. Successful exit evidence requires confirmed process cleanup, its original evidence hash, complete owned execution, and unchanged source/checkpoint identity. Pending, uncertain, cancelled, denied, and required unsupported/skipped verification remains blocked. A model's completion statement has no evidentiary role.

`CompletionCandidate` has `authority: 'observation-only'`; decisions and repair stages carry `executionAuthority: 'none'`. Legacy `Run.state === 'completed'` remains a lifecycle state. The controller does not change it or reinterpret historical completed Runs as verified tasks.

Missing, failed, or source-stale required checks may issue a bounded repair stage. Root consumes `verificationContinuationMessage(snapshot)` as a required user-role JSON DATA context slot before the next provider dispatch within the same Run. This message contains stage/check IDs, failure reason, and source hash, and contains no command, raw output, approval, or executable capability. The existing context freshness/hash/token accounting and ordinary exact tool approval remain responsible for the subsequent turn and any check execution.

An unavailable registration before the first plan produces `check_stale` with no stage. Without a captured first plan, the controller does not invent a default repair allowance. At stop, an existing source-stale plan is interpreted before any new plan is created; a subsequent actual check preparation owns a needed new plan capture.

Before-provider evaluation consumes the unconsumed stage through CAS only if its source, plan hash, and verification revision still match. This consumes no additional repair slot. Source changes before that boundary reject the stale stage. After consumption, ordinary subsequent model edits may change source; a later stop decision independently observes the new source and plan.

## Bounds, restart, and concurrency

The controller document is limited to 64 KiB, 64 logical boundary records, two repair stages, and 8 KiB per continuation message. The existing verification plan/receipt contracts permit at most three plans, two repairs, sixteen checks per plan, and forty-eight receipts. First-plan `maxRepairs` and execution ceilings remain frozen for the original Run. Controller `repairsUsed` takes the maximum of its durable counter, previously issued stage ordinals, and the plan revision floor, so changing source or plans and reopening SQLite cannot reset it.

Unchanged source bytes plus the same required check definition and observed result conservatively stops as `stalled`. New receipt IDs or plan IDs alone do not count as progress. Depleted original Run budgets, exhausted first-plan execution allowance, and repair ceilings stop without dispatching another provider. Time spent in a trusted source callback is charged by the host's existing Run timer; this service provides no independent process or CPU isolation.

Identical inputs at an already committed boundary are idempotent. Different inputs at that boundary conflict. Competing publications cannot allocate two stages because verification revision and controller publication share one SQLite CAS transaction. Both source observations and current profile/check/blocker validation must agree before publication. Physical source observation is a freshness check, not a lock on external filesystem writers; subsequent dispatch keeps its own source/permission checks.

`get` is read-only. Archive/import preserves stages, counters, and candidates as observations. Recovery-paused sessions reject continuation evaluation and never replay stages automatically. Terminal and cancelling Runs reject new candidates and repairs. Rehashed malformed records still undergo bounded semantic validation; getters, proxies, accessors, arbitrary statuses, and execution-authority fields are rejected.

## Validation scope

`controller.test.ts` and `completion.test.ts` use actual SQLite stores, actual registered check plans, and the receipt services. They cover pass/current-source completion, fail/missing continuations, no command authority, same-outcome stalling, durable restart ceilings, original depleted budgets, receipt-free native denial blockers, uncertain/cancelled/unsupported checks, concurrent CAS, source/profile/blocker changes across awaited observation, receipt revision changes at atomic publication, terminal late writes, stale stage consumption, malformed/accessor/proxy inputs, boundary/document caps, corrupted candidates, and archive/import recovery pause.

These service tests do not dispatch provider requests or operating-system verification commands. Root-owned actual Engine/coordinator integration tests establish consumption of the service result at native provider boundaries and normal approved verification command execution. Completion of this module alone does not establish the full verification engine feature.

`controller-integration-races.test.ts` adds eight actual Engine cases using temporary SQLite stores, Git repositories, physical source files, the existing native coordinator, and locally authored provider adapters. They verify initial host scope capture before dispatch; same-Turn HTTP retry with detached original messages/tool schemas; naturally decreasing duration and an already-reserved final logical turn without resetting the original tool allowance; actual `read_file` exhausting the tool ceiling; host source changes after continuation consumption with and without repository context; source changes before a retry dispatch with native no-dispatch cleanup; steers promoted during required-slot context construction; and late steers entering a subsequent genuine Turn rather than the frozen attempt. No fixture fabricates Run, Turn, or provider Attempt records.

The race lane intentionally dispatches no verification command or approval. It observes zero verification effects and retains the issued repair stage when a source change blocks the continuation. Repository context rejects with `REPOSITORY_CONTEXT_STALE`; without that context slot, replay of the same consumed verification boundary with changed source rejects with `VERIFICATION_CONTROLLER_BOUNDARY_CONFLICT`. Real approved command/cleanup completion is covered by the separate root-owned native verification integration suite.
