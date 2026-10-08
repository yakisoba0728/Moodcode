# Run-owned command result inbox

This increment adds an actual native queue consumer for terminal Run-owned command observations. It builds on the [command observation contract](engine-phase-two-atomic-command-jobs.md). Independent host commands and foreground/background ownership transfer remain separate implementation work.

## Host API

With `jobs:true`, `captureOwnedCommandJobDeliveryTarget({workspaceId, jobId, config})` captures a new private Original from the current Root and a genuine settled command source. `readOwnedCommandJobDeliveryTarget(original)` returns bounded signed DATA. `deliverOwnedCommandJobResult({workspaceId, requestId, expectedRevision:0, target:original, approved:true, signal?})` returns the durable delivery result. `releaseOwnedCommandJobDeliveryHandle(original)` releases the observation target.

`getOwnedCommandJobDelivery(workspaceId, deliveryId)` and `inspectOwnedCommandJobDeliveries(workspaceId, sessionId?)` read the bounded history even when execution is disabled. Read history does not mint an Original or launch a command.

The source must be terminal with confirmed physical cleanup. Actual completed, nonzero-exit failed and timed-out cancelled commands have independent integration coverage. Unknown cleanup, an observation failure, a settling source, imported history, another Root epoch and stale physical artifacts cannot produce an active target. The actual source Run must also be terminal.

The target pins an independently normalized configuration, budget, profile registration, provider capabilities, catalogue and physical workspace. The consuming Run retains ordinary fresh tool approvals; the source command's approval grants it no effect authority. A released or copied handle cannot replace the genuine Original.

## Actual atomic admission

One primary transaction stores the native input, `input.accepted`, full signed delivery receipt, immutable input link and independent `command.job.result_admitted` birth anchor. The latter preserves the complete original receipt across later head revisions. The receipt binds the exact settled command snapshot, target, prompt, stable input request and native accepted input tuple. Publication and scheduler wake run only after COMMIT.

Historical native duplicates return the existing accepted input without another acceptance, wake or Original reconstruction. A process crash before COMMIT leaves no input or receipt; a crash after COMMIT preserves exactly one input. Normal restart can explicitly resume that accepted input with the feature enabled. Import pauses the delivery and source histories, preserving their original birth evidence and preventing provider replay. No event is appended to the terminal source Run.

Promotion and every actual provider dispatch validate the native input, immutable link/birth receipt, source approval/Tool/Part/checkpoint and current profile/catalogue/physical workspace. Input metadata, prompt, full configuration, promoted Run identity and optional media must agree with the original accepted tuple. Actual boundary tests reject changed configuration, result prompt and source Run identity before another provider entry.

Ordinary inputs with no command delivery link or admission anchor take two metadata lookups and return before delivery-cap scans or receipt JSON parsing. This is a bounded query-path observation, not a measured asymptotic or end-to-end latency claim.

## Bounded result and native history

The result is a whole quoted advisory prompt capped at 32 KiB. It identifies the command source, terminal state/outcome, compact checkpoint, raw observation digests and sealed artifact byte/truncation metadata. It explicitly carries `executionAuthority:false`. Raw command text, command cwd and absolute artifact paths are omitted; known sealed paths are redacted from error text. Output paging remains a separate host observation API.

Proofs and delivery documents are capped at 128 KiB; immutable admission anchors at 192 KiB. One workspace retains at most 128 delivery documents and 128 immutable input links, with a 16 MiB aggregate document cap. Reaching a bound rejects new admission. Restart does not silently prune history. Existing command observation limits remain 128 documents, 64 KiB per document and 8 MiB aggregate.

This increment uses existing native SessionDocuments and independent events. The primary schema stays DB22. Native validation rejects rehashed receipt/input contradictions, altered terminal source Run headers or bodies, removed links, input ID/request aliases and inserted media. SQL failures roll back the complete admission tuple.

The source observation path now uses its documented 64 KiB record/preparation limit consistently. A real approved 11,264-byte command is observed and delivered without changing its execution budget; a 16,385-byte command is rejected by command admission before approval, fork or checkpoint effects.

## Verification and remaining scope

Focused tests cover the actual three terminal outcomes, profile and artifact drift, source/target Original lifetime, rollback, both COMMIT crash boundaries, restart/import, metadata caps and the actual provider dispatch boundary. The final frozen aggregate evidence is recorded in [the verification file](engine-phase-two-owned-command-inbox-verification.json).

MC2-10a–d remain in progress for independent host-command ownership, foreground/background transfer, parent-terminal-independent lifetime, model output tools and remaining platform/EPERM/backpressure cases. This increment does not close the overall engine goal or the four environment debts.
