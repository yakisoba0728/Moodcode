# Host knowledge request and stream boundary

`knowledge/generation-request.ts` builds a descriptive immutable request from an exact `KnowledgeSourceProjection`. `buildKnowledgeGenerationRequest({ providerId, modelId, source, reasoningEffort? })` returns `payload`, `logical`, `requestSha256`, and `requestBytes`. The SHA-256 and byte count cover `canonicalKnowledge(logical)`, including provider/model selection, extractor version, the original instruction hash, all messages, escaping, and the empty tools list. The complete logical request ceiling is 262144 UTF-8 bytes. Nothing is truncated to fit it.

The original extraction instruction is authored in this repository. The user message contains the complete canonical source body as a quoted JSON string called `sourceBody`. Ordered file/message pins, hashes, bytes, and the allowlisted selected content must match. Provider replay, tool inputs, media, and auxiliary message metadata are excluded by the host source projection. Source instructions remain quoted evidence. Request construction does not authenticate a live source handle: Engine must check its original `KnowledgeHostAdapter` capture and current plan, bind the actual host generation/attempt owner, hash the complete dispatch envelope, and commit dispatch intent through native storage.

`knowledge/generation-stream.ts` exports:

```ts
streamKnowledgeGeneration({
  provider: HostGenerationProviderPort,
  request: HostGenerationRequest,
  signal: AbortSignal,
  budget: KnowledgeGenerationBudget,
  deadline: number,
  onDispatch: () => void,
  onObservation: (observation: KnowledgeGenerationObservation) => void,
  onSettlement: (settlement: KnowledgeGenerationSettlement) => void,
}): Promise<KnowledgeGenerationStreamOutcome>
```

The three callbacks are synchronous trusted host ports. `onDispatch` must durably commit the instance-owned native dispatch intent before adapter entry. Observation and settlement callbacks commit through the original native generation/attempt captures. The module emits data; copied callback records or returned outcomes cannot acquire owner authority. There is one adapter call and no retry, coding Run, SummaryJob, tool execution, or fallback to `streamTurn`.

Each observation carries its incremental `observationBytes` and cumulative actual provider `eventCount`. Text observations carry `textBytes` for the whole received UTF-8 delta and `textDelta` for the retained prefix. `outputTruncated: true` marks discarded output. Storage keeps retained output bytes separately from charged observed text bytes. The stream charges before retaining and never retains more than the admitted output ceiling, at most 16384 bytes. Retention preserves complete Unicode code points; candidate text containing NUL or unpaired surrogates is rejected. Reasoning is charged and discarded. Opaque finish replay is inspected within the bounded plain-data protocol, charged, and discarded without becoming evidence or context. Malformed or oversized opaque data is rejected before retaining its contents.

Provider usage counters remain nullable when unknown. Later nulls do not erase already observed values. Known counters must be safe nonnegative integers, monotonic, and consistent with known cached-input/reasoning subsets. A stable bounded provider request ID is observational provenance. Tools, media, unsupported finish reasons, repeated finish, or content after finish fail the attempt. There is no estimated billing or authority derived from model text.

A `finish` with reason `stop` is an output boundary. A separate `streamDone: true` observation records a real `iterator.next()` result with `done: true`; it does not increase the provider event count. Successful completed output requires both, nonempty untruncated text, confirmed cleanup, and the original operation deadline. Failure/cancellation closes the real underlying iterator at most once. Missing, rejected, non-done, malformed, or timed-out `return()` remains uncertain. An adapter's explicit `CLEANUP_UNCERTAIN` cannot be erased by a later closed generator returning `done: true`.

Duration, request, inactivity, and cleanup deadlines are bounded by the original admitted deadline. Progress does not renew the request budget. Cleanup time starts before invoking the underlying return method. The executor cannot preempt synchronous trusted host/adapter code, but observed late completion cannot restore deadline authority. After cancellation or expiration it checks the boundary before another producer call. Late pending `next` or `return` results cannot emit observations or change an already settled result.

Invalid inputs before dispatch reject without entering the adapter. An admitted attempt returns a single observed completed/failed/cancelled/uncertain settlement. Observation persistence failure withholds candidate evidence. Settlement callback failure rejects with `KNOWLEDGE_SETTLEMENT_FAILED`, so Engine must preserve quarantine if durable settlement cannot be confirmed. Engine releases its workspace lease only after this awaited settlement path, and independently authenticates native current records, source/target/trust freshness, original deadline, and candidate publication authority.

Validation: 50 focused tests pass from TypeScript source and emitted JavaScript. Builder tests use actual temporary files and SQLite completed message sources; stream tests include the actual independent `ScriptedProvider` generation lane and strict custom producers that expose invocation/cleanup counts. They cover source/request tampering, complete-request JSON expansion, charged partial overflow, nullable usage, finish before real done, rejected/stalled return, native cleanup uncertainty, getters/proxies, abort/deadline races, callback commit failure, and zero retry. These module tests do not prove Engine's native ownership, workspace lease, recovery, candidate attachment, archive/import, or external provider behavior; those are separate integration lanes.
