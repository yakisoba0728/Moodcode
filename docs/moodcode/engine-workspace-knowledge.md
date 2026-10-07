# Workspace trust and pending knowledge storage

This is the MC2-03a storage foundation. It provides host APIs, real SQLite records and a bounded real-file/native-message source adapter. DB10 installs the six tables; Engine host APIs, source/target checks, recovery and paused archive import are connected. Existing-file targets need an actual host revision adapter, and workspace-document storage is explicitly unsupported. MC2-03b provider extraction, MC2-03c acceptance/revocation/publication and MC2-03d active context projection remain pending. A candidate remains pending data, even when `assertCandidateCurrent` succeeds. Production native generation evidence is absent, so candidate append remains unavailable.

No Session or Run is invented for a host operation. `KnowledgeGenerationPlan` is a pending input/target capture, not a native generation outcome. A future native generation owner must have its own host operation identity and nullable source Run references. Existing `SummaryAttempt` scopes and successful context-memory activation retain their meaning.

## Records and owner boundaries

`KnowledgeHostBinding` contains the workspace ID, canonical physical root, root device/inode and the existing database/artifact owner fingerprint. Trust cannot move to another physical root or storage owner merely because the workspace ID or root spelling is unchanged.

`TrustRevision` appends an explicit host allow/deny decision with the exact previous revision, source pins, binding, optional expiry and immutable record hash. Each instruction source pins an exact relative path, UTF-8 content hash, byte count and device/inode. A deny revision carries no source grant. Reapproval creates a new revision; old generation plans fail rather than inheriting the new grant. The current head is updated with CAS in the same transaction as the immutable revision and dedupe receipt.

`KnowledgeGenerationPlan` pins the exact trust revision, bounded host-selected source manifest, target revision/preimage, provider/model/request hash and request/output byte caps. The source manifest has up to 64 explicit message/file pins; a message's source Run may be null. The host's source adapter must verify workspace membership, source message identity and settled Run frontier when a Run is present. It must hash a documented allowlisted message projection and the exact concatenated source text rather than opaque provider replay or credentials. File observations include physical identity and content hash. A target is either a workspace document or exact workspace file; revision zero denotes an absent preimage. A file target with an existing preimage also pins its device/inode. The host adapter owns current revision/hash verification; this module never writes the target.

`KnowledgeCandidate` records the exact completed native owner output, source/target/trust pins, provider/model/request identity, cleanup proof and four nullable token counts. Null means unknown, including cached/reasoning counters. Unknown values are never replaced with zero. The body is at most 16KiB, and its UTF-8 hash/byte count must equal the native owner evidence. One generation plan and one owner output can produce only one immutable candidate. The candidate cannot assert active instructions, a skill publication or an execution approval.

The body-only append API cannot accept caller-supplied usage or cleanup claims:

```ts
const plan = storage.prepareGeneration(exactHostInput);
// A future native host generation owner performs/settles its own bounded tool-free request.
const owner = storage.attachGenerationOwner(workspaceId, plan.id, nativeOwnerId);
try {
  const candidate = storage.appendCandidate(owner, { requestId, body: exactObservedOutput });
} finally {
  storage.releaseGenerationOwner(owner);
}
```

`attachGenerationOwner` requires the constructor's trusted `readGenerationEvidence(plan, ownerId)` port. The port must read the actual settled native host generation record and return the exact plan/workspace/binding/request/provider/model/output hashes and bytes, zero tools, confirmed completion/cleanup and usage. The store checks it on capture and again on append, rejecting changes. Without the port, owner attachment fails closed. Object identity belongs to that store instance: clones, proxies, cross-instance objects and released handles confer no authority. Restart retains evidence, but a new owner handle requires a new native-evidence check. The caller must release handles in `finally`; an instance retains at most 128 live handles.

This foundation does not call a provider, fabricate a completion or measure generation usage. The test generation-evidence port is an authored host fixture and is not evidence that the actual extractor/native cleanup implementation exists.

## SQLite installation and production ports

`knowledge/index.ts` exports `KnowledgeStorage`, `KNOWLEDGE_SCHEMA_SQL`, `KNOWLEDGE_STORAGE_TABLES`, `KNOWLEDGE_LIMITS`, `validateKnowledgeArchiveRow` and the public types. `knowledge/host.ts` exports `KnowledgeHostAdapter`, `KNOWLEDGE_HOST_LIMITS` and host source/port types. `workspace/trust.ts` exports the physical source helpers and `WorkspaceTrustService`.

The root store installs the SQL fragment through its authoritative migration. The fragment creates six tables without changing `user_version` or any existing schema:

| Table | Record and indexed ownership |
| --- | --- |
| `workspace_trust_revisions` | append-only trust revision; unique workspace/revision |
| `workspace_trust_heads` | one CAS head per workspace; references that workspace's revision |
| `knowledge_generation_plans` | pending-only immutable plan; references its workspace's trust revision |
| `knowledge_candidates` | immutable pending body/provenance; references its workspace's plan/trust; unique plan/owner output |
| `knowledge_request_receipts` | exact operation/input fingerprint; unique workspace/binding/request ID |
| `knowledge_import_pauses` | persistent inspect-only import barrier per workspace |

All tables have `id`, `workspace_id`, `data`; their JSON rows are bounded by SQLite CHECK constraints. Head/pause IDs equal workspace IDs. Workspace deletion cascades records. Composite FKs prevent a plan or candidate referencing another workspace. A future native generation table must add its own authoritative owner/reference validation; a string owner ID is not independently sufficient proof.

Construct the service with the actual store's connection and transaction owner:

```ts
new KnowledgeStorage(db, {
  writeTx: operation => authoritativeWriteTransaction(operation),
  getWorkspace: workspaceId => getWorkspace(workspaceId),
  checkHostBinding: workspaceId => verifyPhysicalRootAndStorageOwner(workspaceId),
  assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent,
  assertSourcesCurrent: verifyExactCurrentSourceManifest,
  assertTargetCurrent: verifyCurrentTargetRevisionAndPreimage,
  // Deliberately absent until the actual native host generation owner is implemented:
  // readGenerationEvidence: (plan, ownerId) => readSettledNativeGenerationEvidence(plan, ownerId),
});
```

Every freshness callback is synchronous and must return void, so source validation, trust CAS, candidate insertion and receipt remain in one database transaction without an await. The connection must be in that transaction before the operation runs. An async freshness callback is rejected. The production ports must themselves be read-only; their filesystem observations do not promise isolation against an independent filesystem writer. Root and source checks run again after host callbacks, and expiry is checked before commit.

The `WorkspaceTrustService` obtains its binding from the store, previews host-selected paths and only accepts its own original preview object. Exact paths, canonical physical roots and every path component are checked. Symlinks, hardlinks, missing/unreadable files, nonregular files, invalid UTF-8/NULs and oversized inputs are rejected. An open descriptor is checked against the final physical path and before/after metadata. No source file is rewritten. Source text is neither persisted in the trust record nor elevated by discovery alone. Existing nested instruction loading is unchanged until the root wires a trust-aware projection.

## Actual source and target host adapter

`KnowledgeHostAdapter(db, {readTx, getWorkspace, checkHostBinding, readFileTargetRevision?})` receives the actual store connection through a root-owned factory. This does not expose the private connection as a product API. A new source capture opens the injected read transaction; freshness validation already inside a knowledge write transaction reads that same transaction directly, avoiding nested `BEGIN`.

```ts
const projection = host.captureSources({
  workspaceId,
  selection: [
    { kind: 'message', sessionId: sourceSessionId, messageId: sourceMessageId },
    { kind: 'file', path: 'packages/example/src/index.ts' },
  ],
}, signal);
try {
  host.assertProjectionFresh(projection, signal);
  const target = host.captureFileTarget(workspaceId, 'new-project-memory.md');
  // The storage instance's freshness ports call this same adapter.
  storage.prepareGeneration({ ...exactHostInput, binding: projection.binding, source: projection.manifest, target });
} finally {
  host.releaseProjection(projection);
}
```

Selectors contain identity/path only, never caller-authored hashes or replacement text. The adapter joins actual `messages`, `runs` and `sessions` rows and checks both SQLite owner columns and allowlisted JSON owner fields. It admits only a selected Run with state `completed`; running, failed, cancelled and interrupted sources are rejected in this initial slice. It does not infer a completed state for an entire Session. A nullable/omitted selector Run expectation resolves to the message's actual non-null Run owner in the current schema. The returned manifest pins that real owner; changing its pin to null fails freshness verification.

The exact source body is canonical JSON of selection-ordered entries with lexically sorted object keys:

```ts
type Entry =
  | { kind: 'message'; id: string; sessionId: string; runId: string; role: 'user' | 'assistant' | 'tool'; content: string }
  | { kind: 'file'; path: string; content: string };
```

The message pin hash is SHA-256 of its canonical `Entry`; the file pin hash is SHA-256 of its raw UTF-8 content. The manifest hash and `bodySha256` hash the exact canonical entries array, and manifest bytes / `bodyBytes` count its complete UTF-8 serialization, including escaping and metadata. No oversized source is silently truncated. Media-bearing selected messages are explicitly unsupported. Provider replay, tool schemas/inputs, credential/config fields and auxiliary metadata are absent from the allowlist. Visible source text remains host-selected data and can itself contain sensitive content; field exclusion is not an automatic secret detector.

Generation source files have their separate 128KiB cap; instruction trust sources retain their 32KiB cap. Source content and its serialized body share the 256KiB total ceiling, with at most 64 pins. Message/Run/session serialized records have a 1MiB preflight cap before JSON1 extracts their allowlisted fields. The implementation does not claim a bound on SQLite's physical I/O for those metadata length checks. The final body is read-only evidence; preparing it sends nothing to a provider and creates no native generation result, tool call or file effect.

Captured projection objects are instance-owned and immutable, with at most 128 live captures. Their original cancellation signal remains binding even if a different signal is later supplied. Copies, proxies, foreign-instance and released captures fail freshness authority checks. Persistence uses their manifest, not the opaque process-local handle; restarting must read the exact sources again.

Absent workspace-file targets are verified by inspecting their exact canonical parent components and actual absence: revision zero, null hash and null physical identity. A file created after capture fails its absent-target check. Existing targets need the optional `readFileTargetRevision` port backed by an actual host version owner; no version 1 is invented from file existence. With that port, current revision/hash/device/inode are compared, and file bytes are rechecked after the version observation. The initial engine integration may omit this port and explicitly reject existing-file targets. `workspace-document` targets always fail with `KNOWLEDGE_WORKSPACE_DOCUMENT_UNSUPPORTED`; session blobs and synthetic Runs do not provide a substitute.

## Bounds, replay and archives

Initial bounds are 32 instruction files with 32KiB each, 64 selected source pins, a 256KiB source/request ceiling, a 16KiB candidate body, 32 rows per page and a 1MiB page response. Hashed durable records leave 4KiB of the 64KiB row cap for the archive envelope. Pages query at most 33 bounded rows. `bytes` counts the serialized items array; summaries omit the body but retain its hash. Cursors are exact existing IDs scoped to that workspace and table. These are bounded keyset pages, not a locked multi-page snapshot: callers refresh after concurrent inserts and archive export must use its own stable database snapshot.

Request IDs dedupe an operation's exact normalized input and current binding. Reusing an ID for different input or another operation fails. A byte-for-byte replay may return its historical pending record after later trust revocation; it does not restore the trust head or make the candidate current. Consumers must call `assertTrusted` / `assertCandidateCurrent` at their actual authority boundary. Reads remain historical inspection and never execute a candidate.

`exportRows(table, workspaceId, options)` returns bounded validated archive rows. `validateKnowledgeArchiveRow` verifies the exact table/key/workspace, bounded shape, pending state and immutable body/record hashes. It validates one historical row; the authoritative archive importer must also check whole-database relationships, head/predecessor continuity, plan/candidate provenance equality, dedupe receipt targets and any future native generation references in its stable import transaction. It must not silently recompute hashes or rebind old physical identities.

`markImportPaused(workspaceId, archiveSha256)` can join the root import owner's existing transaction. The import owner must call it for every imported workspace with these records even when the archive did not previously have a pause marker. It preserves old trust/candidate bindings and grants no automatic resume. Paused records remain inspectable; trust assertions, new generation plans, owner attachment, candidate append and freshness fail closed. This module deliberately provides no method that clears the pause or automatically resumes extraction/publication. Explicit recovery and publication approval are follow-up MC2-03c/d work.

## Verification and remaining integration

Source tests use real temporary SQLite databases and real canonical filesystem roots:

```sh
node --import tsx --test packages/engine/src/knowledge/store.test.ts packages/engine/src/knowledge/host.test.ts packages/engine/src/workspace/trust.test.ts
```

The initial 62 cases cover CAS and atomic receipt rollback, dedupe, restarts, old/foreign/copied handles, exact native owner evidence, unknown usage, completion/cleanup/tool-count checks, exact candidate body/hash caps, trust revocation/expiry/stale capture, actual source-file changes, target preimage changes, import pause, bounded page ownership, archive corruption, executable JSON rejection, physical root replacement, symlink/hardlink rejection and UTF-8 limits.

The additional 24 host-adapter cases use an actual `SqliteStore` transcript and real files: completed/foreign/nullable source ownership, native payload/column mismatch, opaque field exclusion, media rejection, deleted/changed sources, cancellation, process-local captures, separate file caps, serialized escape overhead, bounded complete message reads, missing/actual target versions, absent-file races and same-transaction pending-plan preparation. Together these 86 source tests pass with no real provider request or target-file write.

Before marking MC2-03a complete, root must install and expose the actual workspace-scoped store/host APIs and exercise them through Engine, connect this source/target adapter, and include these tables in authoritative archive validation/import pause. Existing-file version ownership and workspace-document targets remain explicit additional storage work. MC2-03b needs its distinct native host generation record, dispatch/cleanup owner, tools-free protocol, bounded completed-source selection and shared host usage/deadline accounting. MC2-03c needs exact candidate/hash/target approval, publication CAS/dedupe and revoke. MC2-03d needs trust/source/expiry-aware active context projection and explicit import recovery. These follow-ups cannot reuse a session blob or manufacture a Run to fit existing summary/artifact ports.
