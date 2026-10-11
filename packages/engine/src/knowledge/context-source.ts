import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { EngineError } from "@moodcode/contracts";
import {
  guardedWrite,
  type GuardedWriteOptions,
} from "../storage/transaction.js";
import type {
  KnowledgeContextBudget,
  KnowledgeContextDocumentManifest,
  KnowledgeContextOmission,
  KnowledgeContextPolicy,
  KnowledgeContextRequest,
  KnowledgeContextSourcePort,
  KnowledgeContextSourcePorts,
  PreparedKnowledgeContribution,
} from "./context-types.js";
import { readActiveKnowledgeImportActivation } from "./import-recovery-store.js";
import type { ImportedKnowledgeDocumentActivation } from "./import-recovery-types.js";
import {
  knowledgePublicationProvenance,
  readKnowledgePublicationHistory,
  type KnowledgePublicationHistory,
} from "./publication-history.js";
import {
  completedPublicationMismatch,
  validateKnowledgePublicationArchiveRow,
  workspaceDocumentHeadFor,
  workspaceDocumentHeadId,
} from "./publication-validation.js";
import type {
  KnowledgePublicationRecord,
  KnowledgePublicationReceipt,
  WorkspaceDocumentHead,
  WorkspaceDocumentRevision,
} from "./publication-types.js";
import type {
  KnowledgeHostBinding,
  KnowledgeTrustHead,
  TrustRevision,
} from "./types.js";
import {
  assertKnowledgeSignal,
  identifier,
  immutableKnowledgeJson,
  integer,
  KNOWLEDGE_LIMITS,
  knowledgeError as fail,
  knowledgeHash,
  knowledgeHostRecord,
  sameKnowledge as same,
  validateBinding,
  validateTrustRevision,
  validateKnowledgeArchiveRow,
} from "./validation.js";

export const KNOWLEDGE_CONTEXT_LIMITS = Object.freeze({
  documentKeys: 4,
  slotBytes: 16_384,
  profiles: 16,
  requestBytes: 16_384,
  handles: 256,
  rowBytes: KNOWLEDGE_LIMITS.rowBytes,
  readBytes: 1_048_576,
});
const BUDGET_FIELDS = [
  "slotBytes",
  "maxContextBytes",
  "reservedBytes",
  "requiredMessagesBytes",
  "contextWindow",
  "outputTokens",
] as const;
type SnapshotRequest = Omit<KnowledgeContextRequest, "signal">;
type Selected = { manifest: KnowledgeContextDocumentManifest; body: string };
type State = {
  request: SnapshotRequest;
  signal: AbortSignal;
  bindingSha256: string;
  documents: readonly KnowledgeContextDocumentManifest[];
};
type Preflight = (table: string, id: string) => boolean;
type ActiveDocument = {
  document: WorkspaceDocumentRevision;
  imported: ImportedKnowledgeDocumentActivation | undefined;
};
type PublishedEvidence = {
  publication: KnowledgePublicationRecord;
  receipt: KnowledgePublicationReceipt;
  history: KnowledgePublicationHistory;
};
const SOURCE_STALE_CODES = new Set([
  "KNOWLEDGE_SOURCE_CHANGED",
  "KNOWLEDGE_SOURCE_UNAVAILABLE",
  "KNOWLEDGE_SOURCE_SCOPE_MISMATCH",
  "KNOWLEDGE_SOURCE_UNSETTLED",
  "KNOWLEDGE_SOURCE_MEDIA_UNSUPPORTED",
  "KNOWLEDGE_LIMIT",
]);
function invalidContext(message: string): never {
  return fail("INVALID_KNOWLEDGE_CONTEXT", message);
}
function invalidEvidence(message: string): never {
  return fail("KNOWLEDGE_CONTEXT_EVIDENCE_INVALID", message);
}
function invalidPort(message: string): never {
  return fail("KNOWLEDGE_CONTEXT_PORT_INVALID", message);
}
function staleContext(message: string): never {
  return fail("KNOWLEDGE_CONTEXT_STALE", message);
}
function fields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  knowledgeHostRecord(
    value,
    required,
    optional,
    "INVALID_KNOWLEDGE_CONTEXT",
    "Knowledge context requires plain host data",
    "Knowledge context fields contain unsupported executable or opaque input",
  );
}
function sync(value: unknown): void {
  if (value !== undefined)
    invalidPort(
      "Knowledge context ports must complete synchronously in their primary read transaction",
    );
}
function signal(value: unknown): asserts value is AbortSignal {
  assertKnowledgeSignal(
    value,
    "INVALID_KNOWLEDGE_CONTEXT",
    "Knowledge context requires an actual native AbortSignal",
    "Cancellation signal cannot replace native observations",
  );
}
const READ: GuardedWriteOptions = {
  join: false,
  innerAsyncCheck: true,
  required: () =>
    fail(
      "KNOWLEDGE_CONTEXT_TRANSACTION_REQUIRED",
      "Knowledge context must observe one stable primary database read transaction",
    ),
  async: () =>
    invalidPort(
      "Knowledge context cannot cross an await inside its read transaction",
    ),
  detached: () =>
    fail(
      "KNOWLEDGE_CONTEXT_TRANSACTION_REQUIRED",
      "Knowledge context read transaction did not complete synchronously",
    ),
};
function check(value: AbortSignal): void {
  if (value.aborted)
    fail(
      "KNOWLEDGE_CONTEXT_CANCELLED",
      "Knowledge context preparation or dispatch was cancelled",
    );
}
export function knowledgeContextPolicy(input: unknown): KnowledgeContextPolicy {
  const p = immutableKnowledgeJson(input);
  fields(p, ["documentKeys", "slotBytes"], ["profiles"]);
  if (
    !Array.isArray(p.documentKeys) ||
    !p.documentKeys.length ||
    p.documentKeys.length > KNOWLEDGE_CONTEXT_LIMITS.documentKeys
  )
    invalidContext(
      "Knowledge context needs one to four exact host document keys",
    );
  const keys = p.documentKeys.map(identifier);
  if (new Set(keys).size !== keys.length)
    invalidContext("Host document selection cannot repeat a key");
  if (!integer(p.slotBytes, KNOWLEDGE_CONTEXT_LIMITS.slotBytes))
    invalidContext("Host knowledge slot must be positive and bounded");
  if (p.profiles !== undefined) {
    if (
      !Array.isArray(p.profiles) ||
      p.profiles.length > KNOWLEDGE_CONTEXT_LIMITS.profiles
    )
      invalidContext("Knowledge profile allowlist is too large");
    const seen = new Set<string>();
    for (const profile of p.profiles) {
      fields(profile, ["id", "revision"]);
      identifier(profile.id);
      identifier(profile.revision);
      const key = knowledgeHash(profile);
      if (seen.has(key))
        invalidContext(
          "Knowledge profile allowlist cannot repeat exact identities",
        );
      seen.add(key);
    }
  }
  return immutableKnowledgeJson(p) as unknown as KnowledgeContextPolicy;
}
function budget(input: unknown): KnowledgeContextBudget {
  const r = immutableKnowledgeJson(input);
  fields(r, BUDGET_FIELDS);
  integer(r.slotBytes, KNOWLEDGE_CONTEXT_LIMITS.slotBytes);
  for (const key of [
    "maxContextBytes",
    "reservedBytes",
    "requiredMessagesBytes",
    "outputTokens",
  ] as const)
    integer(r[key], 100_000_000);
  if (r.contextWindow !== null && integer(r.contextWindow, 100_000_000) < 1)
    invalidContext("Known model context window must be positive");
  if (Number(r.maxContextBytes) < 2 || Number(r.requiredMessagesBytes) < 2)
    invalidContext(
      "Knowledge reservation must preserve an actual complete base transcript",
    );
  return r as unknown as KnowledgeContextBudget;
}
function snapshot(input: KnowledgeContextRequest): {
  request: SnapshotRequest;
  signal: AbortSignal;
} {
  fields(input, ["workspace", "policy", "budget", "owner", "signal"]);
  signal(input.signal);
  check(input.signal);
  const value = immutableKnowledgeJson({
    workspace: input.workspace,
    policy: input.policy,
    budget: input.budget,
    owner: input.owner,
  });
  if (
    Buffer.byteLength(JSON.stringify(value)) >
    KNOWLEDGE_CONTEXT_LIMITS.requestBytes
  )
    invalidContext(
      "Knowledge context request exceeds its bounded host snapshot",
    );
  const workspace = value.workspace;
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace))
    invalidContext(
      "Knowledge context workspace must be an actual host data object",
    );
  identifier(workspace.id);
  if (
    typeof workspace.root !== "string" ||
    !isAbsolute(workspace.root) ||
    Buffer.byteLength(workspace.root) > 4096
  )
    invalidContext("Knowledge context needs the exact actual workspace root");
  fields(value.owner, ["sessionId", "runId", "profile"]);
  identifier(value.owner.sessionId);
  if (value.owner.runId !== null) identifier(value.owner.runId);
  if (value.owner.profile !== null) {
    fields(value.owner.profile, ["id", "revision"]);
    identifier(value.owner.profile.id);
    identifier(value.owner.profile.revision);
  }
  return {
    request: immutableKnowledgeJson({
      ...value,
      policy: knowledgeContextPolicy(value.policy),
      budget: budget(value.budget),
    }),
    signal: input.signal,
  };
}
function message(
  selected: readonly Selected[],
  workspaceId: string,
  policySha256: string,
): {
  role: "assistant";
  content: string;
} {
  return {
    role: "assistant",
    content:
      "Approved workspace knowledge (quoted supplemental data):\n" +
      JSON.stringify({
        schemaVersion: 1,
        projection: "host-approved-workspace-knowledge-v1",
        authority: "read-only",
        workspaceId,
        policySha256,
        documents: selected.map(({ manifest, body }) => ({
          ...manifest,
          body,
        })),
      }),
  };
}
function contributionBytes(
  selected: readonly Selected[],
  workspaceId: string,
  policySha256: string,
): number {
  return selected.length
    ? Buffer.byteLength(
        JSON.stringify(message(selected, workspaceId, policySha256)),
      ) + 1
    : 0;
}

function availableBytes(
  budget: KnowledgeContextBudget,
  policy: KnowledgeContextPolicy,
): number {
  const remaining = Math.min(
    budget.maxContextBytes -
      budget.reservedBytes -
      budget.requiredMessagesBytes,
    budget.contextWindow === null
      ? Infinity
      : budget.contextWindow -
          budget.outputTokens -
          budget.reservedBytes -
          budget.requiredMessagesBytes,
  );
  if (remaining < 0)
    fail(
      "KNOWLEDGE_CONTEXT_BUDGET",
      "Required context and output/envelope reservation already exceed the shared context cap",
    );
  return Math.min(policy.slotBytes, budget.slotBytes, remaining);
}
/** True when the source port rejects with a stale-source code; any other failure propagates. */
function staleBy(assert: () => unknown, cancel: AbortSignal): boolean {
  try {
    sync(assert());
    check(cancel);
    return false;
  } catch (error) {
    if (error instanceof EngineError && SOURCE_STALE_CODES.has(error.code))
      return true;
    throw error;
  }
}
function manifestFor(
  key: string,
  { document, imported }: ActiveDocument,
  { publication, receipt, history }: PublishedEvidence,
  trust: TrustRevision,
  binding: KnowledgeHostBinding,
): KnowledgeContextDocumentManifest {
  const { candidate, generation, attempt, plan } = history;
  return {
    documentKey: key,
    documentRevisionId: document.id,
    documentRevision: document.revision,
    documentSha256: document.sha256,
    bodySha256: document.bodySha256,
    publicationId: publication.id,
    publicationSha256: publication.sha256,
    receiptId: receipt.id,
    receiptSha256: receipt.sha256,
    candidateId: candidate.id,
    candidateSha256: candidate.sha256,
    generationId: generation.id,
    generationSha256: generation.sha256,
    attemptId: attempt.id,
    attemptSha256: attempt.sha256,
    planId: plan.id,
    planSha256: plan.sha256,
    trustRevisionId: trust.id,
    trustRevisionSha256: trust.sha256,
    sourceManifestSha256: knowledgeHash(candidate.source),
    sourceTextSha256: candidate.source.sha256,
    sourcePinCount: candidate.source.pins.length,
    candidateExpiresAt: candidate.expiresAt,
    planExpiresAt: plan.expiresAt,
    trustExpiresAt: trust.expiresAt,
    ...(imported
      ? {
          importActivation: {
            activationId: imported.id,
            activationSha256: imported.sha256,
            frontierId: imported.frontierId,
            frontierSha256: imported.frontierSha256,
            resumeDecisionSha256: imported.resumeDecisionSha256,
            originalBindingSha256: knowledgeHash(document.binding),
            currentBindingSha256: knowledgeHash(binding),
            expiresAt: imported.proof.expiresAt!,
          },
        }
      : {}),
  };
}
function manifestExpired(
  manifest: KnowledgeContextDocumentManifest,
  now: number,
): boolean {
  return (
    Date.parse(manifest.candidateExpiresAt) <= now ||
    Date.parse(manifest.planExpiresAt) <= now ||
    (manifest.trustExpiresAt !== null &&
      Date.parse(manifest.trustExpiresAt) <= now) ||
    (manifest.importActivation !== undefined &&
      Date.parse(manifest.importActivation.expiresAt) <= now)
  );
}

/** Read-only, whole-document context capture over actual primary-store DTOs and host source pins. */
export class KnowledgeContextSource implements KnowledgeContextSourcePort {
  readonly #db: DatabaseSync;
  readonly #ports: KnowledgeContextSourcePorts;
  readonly #states = new Map<object, State>();
  constructor(db: DatabaseSync, ports: KnowledgeContextSourcePorts) {
    for (const key of [
      "readTx",
      "getWorkspace",
      "checkBinding",
      "assertOwnerCurrent",
      "isPaused",
      "getDocumentHead",
      "getDocumentRevision",
      "getPublication",
      "getReceipt",
      "getCandidate",
      "getGeneration",
      "getAttempt",
      "getPlan",
      "getTrust",
      "getTrustRevision",
      "assertTrustSourcesCurrent",
      "assertSourcesCurrent",
    ] as const)
      if (!ports || typeof ports[key] !== "function")
        invalidPort(
          "Knowledge context requires actual synchronous primary store and source ports",
        );
    if (ports.now !== undefined && typeof ports.now !== "function")
      invalidPort("Knowledge context clock must be callable");
    this.#db = db;
    this.#ports = Object.freeze({ ...ports });
    Object.freeze(this);
  }
  private read<T>(operation: () => T): T {
    return guardedWrite(
      this.#db,
      { writeTx: (run) => this.#ports.readTx(run) },
      operation,
      READ,
    );
  }
  private now(): number {
    const value = this.#ports.now?.() ?? Date.now();
    integer(value, 8_640_000_000_000_000);
    return value;
  }
  private preflightReader(workspaceId: string): Preflight {
    let readBytes = 0;
    return (table, id) => {
      const row = this.#db
        .prepare(
          `SELECT length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE id=? ${table === "workspaces" ? "" : "AND workspace_id=?"}`,
        )
        .get(...(table === "workspaces" ? [id] : [id, workspaceId])) as
        { bytes: number } | undefined;
      if (!row) return false;
      if (
        !Number.isSafeInteger(row.bytes) ||
        row.bytes < 1 ||
        row.bytes > KNOWLEDGE_CONTEXT_LIMITS.rowBytes ||
        readBytes + row.bytes > KNOWLEDGE_CONTEXT_LIMITS.readBytes
      )
        invalidPort(
          "Selected native knowledge rows exceed metadata-checked read bounds",
        );
      readBytes += row.bytes;
      return true;
    };
  }
  private readActiveDocument(
    workspaceId: string,
    key: string,
    binding: KnowledgeHostBinding,
    preflight: Preflight,
  ): ActiveDocument | "missing" | "revoked" | "stale" {
    const headExists = preflight(
      "workspace_document_heads",
      workspaceDocumentHeadId(workspaceId, key),
    );
    const rawHead = this.#ports.getDocumentHead(workspaceId, key);
    if (!rawHead) {
      if (headExists)
        invalidEvidence("Actual document head getter omitted a persisted row");
      return "missing";
    }
    if (!headExists)
      invalidEvidence("Document head getter is not an actual persisted DTO");
    const head = validateKnowledgePublicationArchiveRow({
      table: "workspace_document_heads",
      key: rawHead.id,
      workspaceId,
      data: rawHead,
    }).data as WorkspaceDocumentHead;
    if (head.documentKey !== key)
      invalidEvidence("Current head belongs to another selected key");
    if (!preflight("workspace_document_revisions", head.revisionId))
      invalidEvidence("Actual current document revision is missing");
    const document = validateKnowledgePublicationArchiveRow({
      table: "workspace_document_revisions",
      key: head.revisionId,
      workspaceId,
      data: this.#ports.getDocumentRevision(workspaceId, head.revisionId),
    }).data as WorkspaceDocumentRevision;
    if (!same(head, workspaceDocumentHeadFor(document)))
      invalidEvidence("Actual current postimage document and head disagree");
    if (head.status === "revoked") return "revoked";
    if (same(document.binding, binding))
      return { document, imported: undefined };
    const imported = readActiveKnowledgeImportActivation(
      this.#db,
      workspaceId,
      key,
      (table, id) => {
        preflight(table, id);
      },
    );
    if (
      !imported ||
      !same(imported.binding, binding) ||
      imported.proof.documentRevisionId !== document.id ||
      imported.proof.documentSha256 !== document.sha256 ||
      imported.proof.headRevision !== head.revision ||
      imported.proof.headSha256 !== head.sha256 ||
      imported.proof.documentKey !== key ||
      !same(imported.proof.originalBinding, document.binding)
    )
      return "stale";
    return { document, imported };
  }
  private readPublishedEvidence(
    workspaceId: string,
    key: string,
    document: WorkspaceDocumentRevision,
    preflight: Preflight,
  ): PublishedEvidence {
    if (!preflight("knowledge_publications", document.publicationId))
      invalidEvidence("Active document has no actual publication owner");
    const publication = validateKnowledgePublicationArchiveRow({
      table: "knowledge_publications",
      key: document.publicationId,
      workspaceId,
      data: this.#ports.getPublication(workspaceId, document.publicationId),
    }).data as KnowledgePublicationRecord;
    const receiptHeader = this.#db
      .prepare(
        "SELECT id,length(CAST(data AS BLOB)) AS bytes FROM knowledge_publication_receipts WHERE workspace_id=? AND request_id=?",
      )
      .get(workspaceId, publication.requestId) as
      { id: string; bytes: number } | undefined;
    if (
      !receiptHeader ||
      !preflight("knowledge_publication_receipts", receiptHeader.id)
    )
      invalidEvidence("Active publication has no actual exact receipt");
    const receipt = validateKnowledgePublicationArchiveRow({
      table: "knowledge_publication_receipts",
      key: receiptHeader.id,
      workspaceId,
      data: this.#ports.getReceipt(workspaceId, publication.requestId),
    }).data as KnowledgePublicationReceipt;
    const p = publication.provenance;
    const missing = (): never =>
      invalidEvidence(
        "Published knowledge has missing original native provenance",
      );
    if (
      !preflight("knowledge_candidates", p.candidateId) ||
      !preflight("knowledge_generation_plans", p.planId) ||
      !preflight("knowledge_generations", p.generationId) ||
      !preflight("knowledge_generation_attempts", p.attemptId) ||
      !preflight("workspace_trust_revisions", p.trustRevisionId)
    )
      missing();
    // Each port runs only for the provenance id preflighted above.
    const pinned =
      <T>(id: string, get: (workspaceId: string, id: string) => T) =>
      (workspaceId: string, requested: string): T =>
        requested === id ? get(workspaceId, requested) : missing();
    const history = readKnowledgePublicationHistory(
      {
        getCandidate: pinned(p.candidateId, (w, i) =>
          this.#ports.getCandidate(w, i),
        ),
        getPlan: pinned(p.planId, (w, i) => this.#ports.getPlan(w, i)),
        getGeneration: pinned(p.generationId, (w, i) =>
          this.#ports.getGeneration(w, i),
        ),
        getAttempt: pinned(p.attemptId, (w, i) => this.#ports.getAttempt(w, i)),
        getTrustRevision: pinned(p.trustRevisionId, (w, i) =>
          this.#ports.getTrustRevision(w, i),
        ),
      },
      workspaceId,
      p.candidateId,
      "KNOWLEDGE_CONTEXT_EVIDENCE_INVALID",
    );
    const { candidate, plan } = history;
    if (
      publication.state !== "completed" ||
      publication.operation !== "publish" ||
      completedPublicationMismatch(publication, document, receipt) ||
      !same(p, knowledgePublicationProvenance(history)) ||
      candidate.body !== document.body ||
      candidate.bodySha256 !== document.bodySha256 ||
      candidate.target.kind !== "workspace-document" ||
      candidate.target.key !== key ||
      candidate.target.revision !== publication.expectedHeadRevision ||
      candidate.target.sha256 !== publication.expectedHeadSha256 ||
      candidate.expiresAt !== plan.expiresAt ||
      !same(candidate.binding, document.binding)
    )
      invalidEvidence(
        "Selected data does not describe its exact approved postimage and historical completed producer",
      );
    return { publication, receipt, history };
  }
  private readCurrentTrust(
    workspaceId: string,
    preflight: Preflight,
  ): TrustRevision | undefined {
    const header = this.#db
      .prepare(
        "SELECT id,revision,revision_id,length(CAST(data AS BLOB)) AS bytes FROM workspace_trust_heads WHERE workspace_id=?",
      )
      .get(workspaceId) as
      | { id: string; revision: number; revision_id: string; bytes: number }
      | undefined;
    if (header) {
      preflight("workspace_trust_heads", header.id);
      // getTrust follows the head's revisionId, so validate the head before the port reads that revision.
      const row = this.#db
        .prepare(
          "SELECT data FROM workspace_trust_heads WHERE id=? AND workspace_id=?",
        )
        .get(header.id, workspaceId)!;
      let data: unknown;
      try {
        data = JSON.parse(String(row.data));
      } catch {
        invalidEvidence("Current trust head contains malformed bounded JSON");
      }
      const head = validateKnowledgeArchiveRow({
        table: "workspace_trust_heads",
        key: header.id,
        workspaceId,
        data,
      }).data as KnowledgeTrustHead;
      if (
        head.revisionId !== header.revision_id ||
        head.revision !== header.revision ||
        head.workspaceId !== workspaceId
      )
        invalidEvidence(
          "Current trust head JSON and indexed revision disagree",
        );
      if (!preflight("workspace_trust_revisions", head.revisionId))
        invalidEvidence("Current trust revision is missing");
    }
    const raw = this.#ports.getTrust(workspaceId);
    if (!raw) {
      if (header)
        invalidEvidence(
          "Actual current trust getter omitted its persisted head",
        );
      return undefined;
    }
    if (!header)
      invalidEvidence(
        "Trust getter does not describe a persisted current head",
      );
    const trust = validateTrustRevision(raw);
    if (trust.workspaceId !== workspaceId)
      invalidEvidence("Current trust belongs to another workspace");
    return trust;
  }
  private observe(
    request: SnapshotRequest,
    cancel: AbortSignal,
    only?: ReadonlySet<string>,
  ): {
    bindingSha256: string;
    selected: Selected[];
    omissions: KnowledgeContextOmission[];
    availableBytes: number;
  } {
    return this.read(() => {
      const workspaceId = request.workspace.id,
        preflight = this.preflightReader(workspaceId);
      check(cancel);
      if (!preflight("workspaces", workspaceId))
        fail(
          "KNOWLEDGE_CONTEXT_SCOPE_INVALID",
          "Knowledge context workspace is not persisted on this primary connection",
        );
      const workspace = immutableKnowledgeJson(
          this.#ports.getWorkspace(workspaceId),
        ),
        binding = validateBinding(this.#ports.checkBinding(workspaceId));
      if (
        workspace.id !== workspaceId ||
        workspace.root !== request.workspace.root ||
        binding.workspaceId !== workspaceId ||
        binding.root !== workspace.root
      )
        fail(
          "KNOWLEDGE_CONTEXT_SCOPE_INVALID",
          "Knowledge context does not match its actual workspace and physical root",
        );
      sync(this.#ports.assertOwnerCurrent(workspaceId, request.owner));
      check(cancel);
      preflight("knowledge_import_pauses", workspaceId);
      const paused = this.#ports.isPaused(workspaceId);
      if (typeof paused !== "boolean")
        invalidPort("Knowledge pause getter must return an actual boolean");
      const available = availableBytes(request.budget, request.policy),
        policySha256 = knowledgeHash(request.policy);
      const selected: Selected[] = [],
        omissions: KnowledgeContextOmission[] = [];
      const allowed =
        request.policy.profiles === undefined ||
        (request.owner.profile !== null &&
          request.policy.profiles.some((p) => same(p, request.owner.profile)));
      const omission = (
        documentKey: string,
        reason: KnowledgeContextOmission["reason"],
      ) => {
        omissions.push({ documentKey, reason });
      };
      for (const key of request.policy.documentKeys) {
        if (only && !only.has(key)) continue;
        check(cancel);
        if (!allowed) {
          omission(key, "profile-not-selected");
          continue;
        }
        if (paused) {
          omission(key, "paused");
          continue;
        }
        const active = this.readActiveDocument(
          workspaceId,
          key,
          binding,
          preflight,
        );
        if (typeof active === "string") {
          omission(key, active);
          continue;
        }
        const { document, imported } = active;
        const evidence = this.readPublishedEvidence(
          workspaceId,
          key,
          document,
          preflight,
        );
        const { candidate, plan, trust: originalTrust } = evidence.history;
        const now = this.now();
        if (
          (imported &&
            (imported.proof.expiresAt === null ||
              Date.parse(imported.proof.expiresAt) <= now)) ||
          Date.parse(candidate.expiresAt) <= now ||
          Date.parse(plan.expiresAt) <= now ||
          (originalTrust.expiresAt !== null &&
            Date.parse(originalTrust.expiresAt) <= now)
        ) {
          omission(key, "expired");
          continue;
        }
        const currentTrust = this.readCurrentTrust(workspaceId, preflight);
        if (
          !currentTrust ||
          currentTrust.decision !== "allow" ||
          !same(currentTrust.binding, binding) ||
          (imported
            ? currentTrust.id !== imported.proof.currentTrustId ||
              currentTrust.revision !== imported.proof.currentTrustRevision ||
              currentTrust.sha256 !== imported.proof.currentTrustSha256
            : currentTrust.sha256 !== originalTrust.sha256)
        ) {
          omission(key, "untrusted");
          continue;
        }
        if (
          staleBy(
            () =>
              this.#ports.assertTrustSourcesCurrent(
                binding,
                currentTrust.sources,
              ),
            cancel,
          )
        ) {
          omission(key, "untrusted");
          continue;
        }
        if (
          staleBy(
            () => this.#ports.assertSourcesCurrent(binding, candidate.source),
            cancel,
          )
        ) {
          omission(key, "stale");
          continue;
        }
        const after = validateBinding(this.#ports.checkBinding(workspaceId));
        sync(this.#ports.assertOwnerCurrent(workspaceId, request.owner));
        if (!same(after, binding))
          staleContext("Physical binding changed during source validation");
        const afterTrust = validateTrustRevision(
          this.#ports.getTrust(workspaceId),
        );
        if (afterTrust.sha256 !== currentTrust.sha256)
          staleContext(
            "Trust changed inside the primary knowledge observation",
          );
        const { publication, receipt } = evidence;
        if (
          imported &&
          (imported.proof.publicationId !== publication.id ||
            imported.proof.publicationSha256 !== publication.sha256 ||
            imported.proof.receiptId !== receipt.id ||
            imported.proof.receiptSha256 !== receipt.sha256 ||
            imported.proof.provenanceSha256 !==
              knowledgeHash(publication.provenance) ||
            imported.proof.sourceManifestSha256 !==
              knowledgeHash(candidate.source))
        ) {
          omission(key, "stale");
          continue;
        }
        const next = {
          manifest: manifestFor(key, active, evidence, currentTrust, binding),
          body: document.body,
        };
        if (
          !only &&
          contributionBytes([...selected, next], workspaceId, policySha256) >
            available
        ) {
          omission(key, "context-budget");
          continue;
        }
        selected.push(next);
      }
      check(cancel);
      sync(this.#ports.assertOwnerCurrent(workspaceId, request.owner));
      if (
        !same(validateBinding(this.#ports.checkBinding(workspaceId)), binding)
      )
        staleContext(
          "Knowledge physical binding changed before capture completed",
        );
      // Earlier documents may expire while later sources are read; recheck all after host I/O.
      const finalNow = this.now();
      for (let index = selected.length - 1; index >= 0; index--) {
        const manifest = selected[index]!.manifest;
        if (manifestExpired(manifest, finalNow)) {
          omission(manifest.documentKey, "expired");
          selected.splice(index, 1);
        }
      }
      omissions.sort(
        (left, right) =>
          request.policy.documentKeys.indexOf(left.documentKey) -
          request.policy.documentKeys.indexOf(right.documentKey),
      );
      return {
        bindingSha256: knowledgeHash(binding),
        selected,
        omissions,
        availableBytes: available,
      };
    });
  }
  async prepare(
    input: KnowledgeContextRequest,
  ): Promise<PreparedKnowledgeContribution> {
    const captured = snapshot(input);
    if (this.#states.size >= KNOWLEDGE_CONTEXT_LIMITS.handles)
      fail(
        "KNOWLEDGE_CONTEXT_LIMIT",
        "Knowledge context original capture limit reached",
      );
    const observed = this.observe(captured.request, captured.signal);
    check(captured.signal);
    const policySha256 = knowledgeHash(captured.request.policy),
      messages = observed.selected.length
        ? [
            message(
              observed.selected,
              captured.request.workspace.id,
              policySha256,
            ),
          ]
        : [],
      bytes = contributionBytes(
        observed.selected,
        captured.request.workspace.id,
        policySha256,
      ),
      body = {
        schemaVersion: 1 as const,
        authority: "read-only" as const,
        trust: "host-approved-data" as const,
        coverage: "host-selected-document-keys" as const,
        workspaceId: captured.request.workspace.id,
        owner: captured.request.owner,
        policySha256,
        bindingSha256: observed.bindingSha256,
        documents: observed.selected.map((s) => s.manifest),
        omissions: observed.omissions,
        complete: observed.omissions.length === 0,
        messages,
        reservations: {
          envelopeBytes: captured.request.budget.reservedBytes,
          outputTokens: captured.request.budget.outputTokens,
          slotBytes: Math.min(
            captured.request.policy.slotBytes,
            captured.request.budget.slotBytes,
          ),
          availableBytes: observed.availableBytes,
          contributedBytes: bytes,
        },
        inputEstimate: {
          tokens: null,
          utf8ByteUpperBound: bytes,
          estimated: true as const,
          source: "utf8-byte-upper-bound" as const,
          contextWindow: captured.request.budget.contextWindow,
        },
      };
    const result = immutableKnowledgeJson({ ...body, id: knowledgeHash(body) });
    this.#states.set(result, {
      request: captured.request,
      signal: captured.signal,
      bindingSha256: observed.bindingSha256,
      documents: result.documents,
    });
    return result;
  }
  private owned(contribution: PreparedKnowledgeContribution): State {
    if (
      !contribution ||
      typeof contribution !== "object" ||
      types.isProxy(contribution) ||
      !this.#states.has(contribution)
    )
      fail(
        "KNOWLEDGE_CONTEXT_CAPTURE_INVALID",
        "Knowledge contribution is copied, foreign, released or never issued",
      );
    return this.#states.get(contribution)!;
  }
  async assertFresh(
    contribution: PreparedKnowledgeContribution,
    cancel: AbortSignal,
  ): Promise<void> {
    const state = this.owned(contribution);
    signal(cancel);
    check(cancel);
    check(state.signal);
    const observed = this.observe(
      state.request,
      cancel,
      new Set(state.documents.map((d) => d.documentKey)),
    );
    check(cancel);
    check(state.signal);
    this.owned(contribution);
    if (
      observed.bindingSha256 !== state.bindingSha256 ||
      !same(
        observed.selected.map((s) => s.manifest),
        state.documents,
      ) ||
      observed.omissions.length
    )
      staleContext(
        "Included approved knowledge or its exact postimage/current sources changed before dispatch",
      );
  }
  release(contribution: PreparedKnowledgeContribution): void {
    this.owned(contribution);
    this.#states.delete(contribution);
  }
}
