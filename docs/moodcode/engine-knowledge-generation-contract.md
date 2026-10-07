# MC2-03b: native host knowledge generation contract

This document preserves the initial MC2-03b design review from 2026-10-08, before native host generation was implemented. References to the “current” engine below describe that review snapshot. At that point MC2-03a provided workspace trust/source capture, pending plans, DB10 storage and archive import pause, and production `readGenerationEvidence` was absent. The review itself performed no provider request.

The subsequent implementation now supplies a real independent host owner, an optional typed provider capability, original bounded budgets, actual iterator cleanup, exact completed-output evidence, and explicit quarantine acknowledgment followed by a separate workspace resume. DB11 uses **four** native tables: `knowledge_generations`, `knowledge_generation_attempts` (including bounded nullable usage and cleanup), `knowledge_generation_recovery_acknowledgments`, and `knowledge_generation_workspace_barriers`. The six-table layout below is historical design guidance, not the installed schema. Actual code and verification scope are documented in [engine-phase-two-knowledge-generation.md](engine-phase-two-knowledge-generation.md). Candidates remain pending host review; publication, active knowledge projection, automatic replay and real-provider ENV validation are not established by these local fixtures.

## Existing boundaries that the implementation must preserve

| Current source | Observed contract and consequence |
| --- | --- |
| `ports.ts:77–79` | `TurnRequest.runId` is required; `ProviderAdapter.streamTurn` receives a coding Turn. A host operation must have a separate typed entrypoint. |
| `engine.ts:174` / `withInputMedia` | Run/session identity resolves actual image/document inputs. Its manual iterator forwards the underlying cleanup result; replacing it with a superficial async-generator wrapper can falsely establish cleanup. |
| `storage/summary-attempts.ts:7` | Summary records require actual session/run FKs and `completed-history` or `active-run-prefix` scope. Successful summary completion activates a context revision. A pending knowledge candidate has different ownership and publication semantics. |
| `context/summary-stream.ts:26` | Summary streaming requires `ContextRequest.budget`, shared Run output accounting and native summary settlement. Reusing it directly would manufacture a Run budget or change its meaning. |
| `config/budgets.ts:14` | `BudgetAccount` requires `RunConfig`; provider attempts belong to a logical Turn and summaries consume that Run's allowance. It cannot own this host operation. |
| `runner/turn-executor.ts:143` | Ordinary retry follows confirmed native cleanup, restricted HTTP failure and a frozen request. Its Turn/Attempt records and overflow summary recovery remain independent. |
| `runner/index.ts:359,368` | A workspace lease blocks Run admission and is aborted/drained by close. Recovery decision leases suppress automatic queued-work wakeup. Both can be reused without a synthetic Run. |
| `storage/index.ts:377` | Workspace uncertainty currently combines summary and ordinary execution blockers. Native host-generation blockers must be included durably before a lease releases. |
| `engine.ts:1005` | Pending knowledge preparation currently runs under a real workspace lease and checks the original source projection. It performs no model dispatch. |

The current source adapter admits explicitly selected messages from completed Runs and exact files. A source Run is provenance only: it may be null in the general manifest contract, and file-only selections need no Run or Session. The current message table always resolves an actual non-null completed Run pin. A generation's execution owner must never be substituted with one of those source Runs, a newly invented maintenance Run, a session document, a tool-call ID or a `SummaryAttempt` scope.

## Provider bridge with explicit capability

Keep existing `streamTurn(TurnRequest, signal)` and legacy adapter registration compatible. Add an optional host capability; lack of that method means `KNOWLEDGE_PROVIDER_UNSUPPORTED`, with zero provider invocation. Never cast a host request to `TurnRequest`, fill `runId` with the generation ID, or call the old method with an arbitrary Session.

```ts
interface HostGenerationOwner {
  readonly kind: 'host-generation';
  readonly workspaceId: string;
  readonly generationId: string;
  readonly attemptId: string;
}
interface HostGenerationPayload {
  readonly modelId: string;
  readonly messages: readonly { readonly role: 'system' | 'user'; readonly content: string }[];
  readonly tools: readonly [];             // exactly zero, including runtime validation
  readonly reasoningEffort?: ReasoningEffort;
  readonly includeMetadata: true;
}
interface HostGenerationRequest extends HostGenerationPayload {
  readonly owner: HostGenerationOwner;
  // No coding runId/sessionId/turnIndex/turnId or resolved media fields.
}
interface HostGenerationProviderPort {
  streamGeneration(request: HostGenerationRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
// ProviderAdapter gains streamGeneration? with this exact signature.
```

Built-in providers should share a transport payload implementation after extracting it from `streamTurn`. The shared transport input type contains model/messages/tools/metadata and optional coding media fields, but no required Run owner. Coding `TurnRequest` still supplies the existing media/session contract; the host entrypoint validates ordinary detached JSON, rejects all media/replay/tool fields, and calls the transport implementation with its real host owner separately. Narrow `providerImages`, `providerDocuments` and replay helpers to the transport payload they actually consume, without weakening coding media ownership checks.

`ResponsesProvider`, `OpenAICompatibleProvider`, `AnthropicProvider` and `CodexProvider` currently encode transport payloads without using `request.runId`. Codex delegates to Responses after its existing fixed-origin credential boundary; that boundary remains unchanged, and validation must precede credential acquisition. `ScriptedProvider` currently indexes fixtures by `turnIndex`, so give its host entrypoint an explicitly indexed generation fixture or a separate fixture adapter rather than inventing a coding Turn.

`withInputMedia` must preserve the optional host capability. Its host path does not resolve media or read a source Run as an execution owner. Forward the real underlying iterable/iterator and its `return()` result. If host validation needs lazy initialization, use the same explicit iterator-forwarding discipline as the coding path. Engine must register the actual supported capability after wrapping; a third-party legacy-only adapter remains usable for coding and unavailable for host extraction.

The host runner may consume the existing event union, but must validate a separate tool-free protocol. Only `text.delta`, bounded `progress`, monotonic nullable `usage`, and one `finish(stop)` contribute to the result. Reasoning deltas, when the chosen provider emits them, are counted against a separate observation allowance and discarded; they are not candidate text or source truth. `tool.call`, media and non-stop finish terminate the operation without any tool/schema/effect dispatch. Native replay returned on finish is never persisted, forwarded to another request or incorporated into the candidate. Prefer an adapter capability that suppresses reasoning/replay transport output when supported; do not assume every existing adapter does so merely because tools are empty.

## Request identity and original generation budget

The logical request projection must be versioned, canonical and independent of generated owner IDs:

```ts
type GenerationLogicalRequest = {
  projection: 'host-knowledge-request-v1';
  providerId: string;
  extractorVersion: string;
  instructionSha256: string; // host-authored extractor instruction, never copied upstream
  payload: HostGenerationPayload;
};
```

Its canonical UTF-8 hash/bytes must equal the pending plan's `requestSha256`/`requestBytes`. Source body is the exact host-selected canonical projection, quoted as data. The host rebuilds and recounts the complete payload, including instructions, escaping and metadata, before accepting a previously prepared plan. A caller-supplied plan hash alone proves no provider request. Excluding operation/attempt IDs avoids a circular dependency with the existing store-generated plan ID. Each native attempt additionally pins the exact dispatch-envelope hash/bytes including its real owner. Provider-specific wire encoding remains a separate transport projection; do not describe the logical request hash as a hash of authentication headers or wire bytes.

Add an independent `KnowledgeGenerationBudget`, normalized before admission and persisted once on the native generation owner. It is never a `RunConfig`, `BudgetAccount`, resettable Turn allowance or inherited allowance from an old source Run. Suggested initial host ceilings:

| Budget | Initial ceiling / meaning |
| --- | --- |
| Source pins and source body | 64 pins / 262,144 UTF-8 bytes; existing source adapter and trust-file caps remain |
| Complete logical request | 262,144 UTF-8 bytes; a maximum-sized source may leave insufficient room for instructions and is rejected rather than rewritten |
| Candidate text / retained native text | 16,384 bytes; oversized or truncated native text never becomes a candidate |
| Other normalized observations | 65,536 bytes plus 4,096 events, including discarded reasoning/control data; absolute duration still caps empty progress floods |
| Provider attempts | 1 initially; an explicitly enabled later retry extension may allow at most 2 |
| Whole generation duration | 90,000ms from original admission, including source checks, serialization, retry backoff, cleanup and candidate settlement |
| Request / inactivity / cleanup wait | 60,000ms / 20,000ms / 1,000ms, each bounded by the remaining whole-operation deadline |
| Tools | Exactly 0; no discovery, approval, shell, MCP, schema or plugin dispatch |

These are proposed limits, not measured performance or guaranteed billing caps. Record the original budget digest, admitted timestamp and absolute deadline; clamp the deadline to plan/trust expiry. Retrying, restarting, input promotion or recovering must not extend them. Unknown model context/output token limits and provider token usage stay null. A token limit may be sent only through an explicit supported provider capability; local byte bounds do not prove a server billing limit. Observed-byte counters charge actual output before retention rejection. Known counters accumulate per dispatched attempt; a missing counter remains unknown rather than zero.

## Durable native records and migration

The original proposal was to install a new authoritative migration after DB10, without changing old summary schemas. These suggested six bounded STRICT tables were superseded by the four-table DB11 layout above; usage and cleanup are embedded in the attempt record:

| Table | Required ownership and bounded content |
| --- | --- |
| `knowledge_generations` | ID, workspace/plan composite FK, original binding/request/budget hashes, request ID dedupe, state/revision, admitted/deadline timestamps, original runtime epoch, candidate status/ID or withholding reason; immutable input pins, no Session/Run FK |
| `knowledge_generation_attempts` | ID, generation/workspace composite FK, attempt index, fixed logical request and exact dispatch-envelope hashes, provider/model, state/revision, bounded request/progress identity, finish reason and exact retained text/output digest |
| `knowledge_generation_usage` | Attempt/generation/workspace composite ownership; four nullable cumulative counters, revision and observation time; at most 4KiB |
| `knowledge_generation_cleanup` | Attempt/generation/workspace ownership; dispatched intent, outcome/method/reason, provider request ID, revision/timestamps, at most 4KiB |
| `knowledge_generation_recovery_acknowledgments` | Exact owner/attempt/cleanup/usage/budget/binding hashes, original boot frontier and host request dedupe; bounded audit receipt, no provider replay or recovered success |
| `knowledge_generation_workspace_recovery` | One workspace CAS barrier with `blocked`, `pending-resume` or `clear`, revision, exact acknowledged owner frontier and current recovery receipt; no fabricated archive marker |

Generation/attempt JSON should have a 64KiB ceiling, with at most 16KiB retained output and bounded metadata. Source text need not be duplicated in every status record: the immutable plan manifest and logical request/source digests pin it, while the host rechecks current exact sources before dispatch. No provider-native replay, credentials or raw authentication headers enter these records. One operation can reference multiple source Sessions/Runs only as bounded manifest provenance.

Use unique workspace/binding/request ID dedupe for the actual generation operation. Duplicate input returns its existing native state/candidate without invoking the provider again; a different request fingerprint conflicts. Attempt indices are unique per operation. FK/semantic validation must ensure candidate owner, plan, trust and workspace agree. The production `readGenerationEvidence(plan, ownerId)` port reads this exact native generation/settled attempt and confirmed cleanup, not caller metadata. It maps the provider's `reasoningOutputTokens` field to the candidate contract's `reasoningTokens` without inventing counts.

A native generation is `prepared → dispatched → streaming → completed | failed | cancelled | uncertain`; an attempt may additionally retain `output-finished` while cleanup is pending. Provider `finish(stop)` alone does not establish completion. The actual iterator must reach `next().done === true` or a failed/cancelled iteration must establish the underlying `return().done === true`. Missing, rejected, non-done or timed-out return is uncertain. Failure to commit authoritative settlement also preserves quarantine. Durable dispatch intent precedes calling the provider; a crash after intent is conservatively possibly dispatched even if no HTTP request was observed.

Keep provider completion and candidate creation distinct. After complete nonempty, untruncated output and confirmed cleanup, persist native completion with output hash/bytes/usage. Then use the existing instance-owned `KnowledgeStorage` generation handle to append the exact native body, rechecking current trust/source/target/import state. A changed source or target may leave a genuinely completed native output with `candidateStatus: withheld` and no candidate. Do not overwrite the provider outcome with a publication error or rerun the producer. A crash between completion and candidate append is inspected on restart; a separate explicit host finishing action may append the existing exact result after revalidation, without another provider request.

## Host ports and actual call sequence

Use a separate instance-owned runtime generation capture (WeakMap/object identity plus persisted runtime epoch and state/CAS fences). The completed native record supplies the already existing `KnowledgeStorage` evidence port. Copied handles, a different process/store instance, terminal owners and late callbacks cannot append observations or alter a completed output.

```ts
interface NativeKnowledgeGenerationPort {
  createGeneration(input: ExactPlanRequestAndOriginalBudget): NativeGenerationCapture;
  prepareGenerationAttempt(owner: NativeGenerationCapture): NativeAttemptCapture;
  dispatchGenerationAttempt(owner: NativeGenerationCapture, attempt: NativeAttemptCapture): void;
  observeGenerationAttempt(owner: NativeGenerationCapture, attempt: NativeAttemptCapture, value: BoundedObservation): void;
  settleGenerationAttempt(owner: NativeGenerationCapture, attempt: NativeAttemptCapture, value: NativeCleanupSettlement): void;
  completeGeneration(owner: NativeGenerationCapture, attempt: NativeAttemptCapture): CompletedNativeGeneration;
  failGeneration(owner: NativeGenerationCapture, failure: NativeGenerationFailure): void;
  readGenerationEvidence(plan: KnowledgeGenerationPlan, ownerId: string): KnowledgeGenerationEvidence;
  hasKnowledgeGenerationBlocker(workspaceId: string): boolean;
  recoverKnowledgeGenerationOwners(): BoundedStartupReport;
}
```

These names are proposed new types/ports, not currently implemented APIs. Every native mutation belongs to the actual store transaction. An initial Engine host command should:

1. Require explicit host opt-in, registered provider capability/model and normalized original budget. Acquire `withWorkspaceLease(workspaceId, operation)` synchronously before any dispatch microtask.
2. Check import/recovery barriers and actual trust. Validate the original source projection and actual target preimage. Rebuild the host-authored logical payload and reject a stale or mismatched pending plan.
3. Create the real native generation owner/attempt and original deadline. Capture detached immutable request data; combine lease, caller, original deadline and inactivity signals.
4. Recheck freshness/binding after any await and immediately before durable dispatch intent. Call `streamGeneration` with the real host owner; no coding Run, summary, tools or active ContextPlan is created.
5. Observe bounded events, output and usage under the live native owner. On every failure/cancellation, abort and close the actual iterator, preserve observed output/usage and commit authoritative cleanup/terminal state. Ignore late callbacks by runtime identity and terminal CAS.
6. On confirmed complete output, persist native completion and append its exact pending candidate using the existing opaque evidence boundary. Release both captures and the workspace lease only after settlement. Engine close aborts and waits for this same promise; no detached provider workflow survives the owner.

Whole-generation state must be durable before the lease releases, because `workspaceIdle` may drain accepted inputs afterward. Add the new persisted blocker to `hasUncertainWorkspace`, direct admission/promotion and resume checks. A source Run's old budget or pause is not the host generation owner. The existing file-version port remains absent by default, and workspace-document targets remain unsupported until actual workspace storage exists.

## Retry, crash and explicit recovery

Start with one attempt. A later retry extension can retry only a configured transient HTTP rejection, with no text/usage/reasoning/finish observation, confirmed native cleanup, no cancellation, remaining original time/attempt allowance and fresh exact sources. It uses the identical logical payload/source/trust/target capture and a new native attempt envelope. Backoff consumes the original deadline. Context overflow never invokes semantic-memory compaction or rewrites the source; a smaller source requires a new explicit host plan. Never retry an uncertain dispatch, partially observed output or crash.

At startup, a prepared attempt with no durable dispatch intent can settle interrupted/no-dispatch. A dispatched, streaming or output-finished owner without authoritative completion becomes uncertain and blocks the workspace. Expiry, a restart or absence of an in-memory iterator is not cleanup proof. Retain known usage and bounded partial text; do not create a candidate from it. Archive validation/import must include the new tables and relationships, preserve old owner/binding hashes and keep imported work paused. Managed child databases need the same bounded validation; no provider or projection automatically resumes after import.

Recovery is an audit decision followed by explicit workspace resume, not replay. The preview hashes native owner/attempt/cleanup/usage/budget/retained-output records, stored source/target manifest and physical binding, with a bounded original boot high-water frontier. Current source/target status is reported separately; deleted or changed source bytes are never reconstructed from old model text. The decision owns `withRecoveryDecisionLease`, exact fingerprint/CAS and request dedupe. It records that an unknown provider outcome was acknowledged; it cannot change uncertain cleanup into confirmed cleanup, declare a successful output or activate a candidate.

Acknowledging one exact generation moves its workspace barrier to `pending-resume` only when every selected native blocker is accounted for; independent command/tool/MCP/provider/summary quarantines remain. The acknowledgement does not wake queued inputs. A separate explicit resume command rechecks the current acknowledged frontier/binding and absence of independent blockers before clearing that workspace barrier. Existing paused Sessions require their own normal explicit resume; no Session is created just to hold a host pause. Both receipts state `providerRetried: false`, `executionResumed: false` for the acknowledgement, and `candidateCreated: false` / `publicationActivated: false`. The later resume enables new work only and never replays the old generation.

Until the bounded recovery/explicit-resume implementation exists, uncertain native generations must remain blocked; an implementation must not claim a recoverable 03b lane merely because it can store an uncertainty flag.

## Minimal files and verification obligations

| Scope | Proposed change |
| --- | --- |
| New knowledge files | `generation-types.ts`, `generation-budget.ts`, `generation-store.ts`, `generation-stream.ts`, `generation-service.ts`, `generation-recovery.ts` and focused tests |
| `ports.ts` / provider files | Optional `streamGeneration` plus owner-free transport payload type; built-in explicit bridge and Scripted generation fixtures; legacy unsupported behavior |
| Media/document helper type signatures | Accept only the common transport fields they consume; existing Run/session media resolution unchanged |
| `engine.ts` | Preserve host capability through `withInputMedia`; default-off generation option; real host operation/cancel/close APIs and provider map; inject authoritative generation evidence into `KnowledgeStorage` |
| `storage/index.ts` | Actual native store factories/methods, startup sweep, bounded read/CAS, workspace blocker inclusion and recovery ports |
| `storage/migrations.ts`, archive/evidence catalogue | New authoritative version/tables, bounded semantic validation and import pause; no summary scope or Session document changes |
| `runner/index.ts` | Existing host lease and recovery decision lease can be reused. Change only if the explicit workspace resume/barrier integration needs a new host method; do not route through TurnExecutor. |
| Root exports / documentation | Advertise only the actual implemented host capability and its opt-in boundary; keep default coding tool count unchanged |

Required local scripted/source/dist fixtures are real evidence once implemented: native workspace/source pin preparation; provider invocation/cleanup counts; no Run/Session/summary/tool artifact creation; exact body and nullable usage; finish-before-done and return forwarding; cancellation during next/cleanup/backoff; provider throws and late results; request mutation/frozen retry; reasoning/media/tool protocol rejection; observed-versus-retained byte caps; candidate withheld on source/trust/target changes; generation/receipt rollback; restart/crash at every dispatch/completion/append boundary; default-off/legacy unsupported; import pause; durable workspace quarantine/acknowledge/pending-resume with no replay; close awaiting the actual host promise. Execute focused source and compiled tests, then the authoritative typecheck/eval/full suite. Existing passing gates do not validate this proposed new execution lane.

Per built-in provider, mocked transport tests must assert request shape and the explicit host owner, tools absent/empty, credential/redaction boundaries, event normalization and actual iterator/body cleanup. Add compile-time fixtures showing that `HostGenerationRequest` cannot be passed to a coding request and that a legacy adapter need not implement the new capability. Review Anthropic reasoning behavior and Responses/Codex finish replay explicitly instead of relying on an assumed text-only event stream.

A real provider/environment lane remains owed after implementation: the host must explicitly select a supported provider/model and approved source corpus under local configuration, make a bounded opt-in generation request, inspect actual usage and cleanup, and verify that only a pending candidate appears. Scripted/mocked tests prove protocol and owner behavior, not real model quality, live token accounting or production credential compatibility. This design review reads no credential files, calls no actual provider, copies no upstream prompt/source and changes no product file.
