# ACP v1 bounded session load

This increment implements the `load` clause of the original MC2-09 family contract. It retains the existing initialize/new/prompt/native permission/client effects/cancel lanes. The supported load lane is explicit local stdio, ACP v1, a completed engine-owned source session, and a fresh host-selected backend alias. It uses the existing DB23 backend revision/head tables; there is no migration.

ACP v1 advertises loading with `agentCapabilities.loadSession: true`. A load request names the remote session, absolute cwd, and MCP server list. Historical `session/update` notifications precede the matching load response. Moodcode supports the empty-result subset with optional advisory `_meta`; mode/configuration switching and additional MCP servers are rejected. [Official ACP v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup).

## Selecting a load

The host calls the existing public `captureAgentBackendTarget` with `contextOwner: "agent"` and a `sessionLoad` manifest, reads its target description, and passes the Original capture to `registerAgentBackend`. The manifest contains the source backend ID/revision, source request ID/revision/SHA, source connection ID/revision/SHA, and actual remote session ID. The new backend ID must be distinct. Its `acp:<alias>` provider ID is placed in the new native input configuration before acceptance. Existing accepted inputs keep their original provider and registration.

Native source validation requires the genuine source request to be completed, its source Run to be completed in both the SQL header and body, the connection to be closed with confirmed disposal, matching workspace/session/connection epoch and owner, and the immutable source registration. Runtime admission also requires the source heads to match the selected revisions, the current physical Root binding and original Root epoch, unchanged executable/source file pins and launch, and exact profile/model/catalogue/tools/budgets/audience. The source registration must be engine-owned; recursive load chains are outside this subset.

The new alias necessarily changes the provider catalogue. Root captures the complete bounded capability image as a JSON string so nested tool schemas do not widen the existing journal JSON depth limit. Native validation recomputes both capability SHAs and permits exactly the source provider list plus the new alias; every other capability field must match. Changes to other providers or capabilities require a different reviewed selection, rather than silently replacing the accepted binding.

Each load alias admits one physical provider Attempt. A later dispatch through an already consumed alias fails before physical launch. History and reopened registrations do not recreate live Original captures. A fresh Root cannot use the old Root epoch to issue a load grant.

## Actual wire and context ownership

The real Root-owned process initializes, then native storage commits a `load-intent` before the load wire message is written. Missing/false/unknown load capability fails without `session/load`, replacement `session/new`, or prompt fallback. The adapter accepts at most 128 historical notifications and 32 KiB of encoded history. Every notification must be a schema-valid `session/update` for the exact selected remote session. Permission, filesystem and terminal RPCs during loading are rejected before native effects.

Native immutable connection revisions preserve receive order, frame SHAs, byte bounds, replay count, the precise load message, Original physical write receipt, matching successful response, and their connection/epoch. The loaded receipt independently verifies the encoded message's full byte count, positive write ordinal, matching response ID, and CAS transition. Repeated historical text is recorded as observation DATA, never replayed into current provider deltas, approvals, Tool calls, or Parts. A duplicate load ACK cannot complete the subsequent prompt.

After successful load, the prompt explicitly says `contextOwner: "agent"`. Root authenticates the Original provider request and reads the current native Run prompt directly. Only that new user input and actual current system instructions are sent; earlier native user/assistant history is not duplicated. The existing same-Attempt broker executes current read/effect requests with its native owner, approval and budget checks. Remote history and permission descriptions supply no grant.

Cancellation retains the actual load write and response handles. Since a load response does not return a new session ID, process cancellation verifies its private acknowledged load-write message instead of fabricating a `session/new` result. The prompt cancellation rules remain unchanged. [Official ACP v1 prompt lifecycle](https://agentclientprotocol.com/protocol/v1/prompt-turn).

## Failure, restart and import

An interrupted load remains remote-state `uncertain` even when actual local process cleanup is confirmed. ACK, EOF and physical disposal are different facts. No load, prompt or session creation is retried automatically. SQL failure before the load-intent commit sends no load message. SQL/CAS/wire gaps preserve their durable evidence and existing quarantine behavior.

Actual Root SIGKILL after three committed historical notifications was tested: the original supervisor removes the peer group and releases the physical cleanup lease; reopened native history is uncertain, its response/disposal is absent, and no ACP provider or live authority is reconstituted. The test waits for the real lease to become idle and does not infer remote completion from process absence. Completed loaded archives preserve immutable source/replay/write/response evidence but append paused imported heads. Import/reopen consumes no remote prompt.

Supported evidence is local account-free POSIX stdio. HTTP/reconnect, ACP v2, authenticated/live-account backends, arbitrary remote session IDs, mode/configuration negotiation, recursive agent-owned source chains and unlimited histories are not claimed. Existing separately deferred E5-13/E5-08 and environment scopes are unchanged.

## Verification

Final source inventory: `/tmp/moodcode-acp-session-load-source-freeze-v2.json`, SHA `ada026d97218090da0c92301291016b16cc59f06e936ee6573a50c09896a3cba`. It contains 16 files, including unchanged `host.ts` as a consumer dependency. Version 2 changes only the native SIGKILL fixture's portable compiled/source loader selection from version 1; production SHAs are identical.

* Native/source focused verification: **26/26**, including eight actual new load cases, twelve existing protocol cases and six existing native store cases. `/tmp/moodcode-acp-load-native-adjacent-final-source.log`.
* The portable SIGKILL fixture correction: **1/1**. `/tmp/moodcode-acp-load-crash-portable-final-source.log`.
* Independent actual lifecycle verification: **8/8**, plus existing actual adjacent **28/28**. The preserved A lifecycle manifest identifies its exact source bytes and logs.
* Independent public protocol/spec verification: **9/9**. The preserved C protocol manifest identifies its exact source bytes and log.
* Focused ES2024 strict/noUncheckedIndexedAccess check: exit **0**. `/tmp/moodcode-acp-load-native-final-type.log`.

The genuine native graph cases also reject self-rehashed replay erasure, foreign session identity, missing physical load write, zero written bytes and zero write ordinal. Earlier red snapshots are retained and are not credited as final passes. Parent-owned aggregate build, compiled suite, broad source suite and final completion accounting are separate from these focused results.

Root [local aggregate verification](engine-phase-two-acp-session-load-integration-verification.json) passed: build exit 0; complete compiled suite 4,701 total / 4,699 pass / 0 fail / two existing Windows-native skips; backend source 107/107; local media 26/26; scripted coding 3/3. All 914 frozen inputs and the 16-file feature source manifest remained exact. The corrected legacy validation expectation and initial relative-loader invocation failures are preserved separately. Hosted CI and final original80/20 completion accounting remain pending.
