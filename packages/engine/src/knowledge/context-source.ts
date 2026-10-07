import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { EngineError } from "@moodcode/contracts";
import type {
  KnowledgeContextBudget,
  KnowledgeContextDocumentManifest,
  KnowledgeContextOmission,
  KnowledgeContextOwner,
  KnowledgeContextPolicy,
  KnowledgeContextRequest,
  KnowledgeContextSourcePort,
  KnowledgeContextSourcePorts,
  PreparedKnowledgeContribution,
} from "./context-types.js";
import type {
  KnowledgeGenerationAttempt,
  KnowledgeGenerationRecord,
} from "./generation-types.js";
import { validateKnowledgeGenerationArchiveRow } from "./generation-store.js";
import {
  validateKnowledgePublicationArchiveRow,
  workspaceDocumentHeadId,
} from "./publication-store.js";
import type {
  KnowledgePublicationRecord,
  KnowledgePublicationReceipt,
  WorkspaceDocumentHead,
  WorkspaceDocumentRevision,
} from "./publication-types.js";
import {
  identifier,
  immutableKnowledgeJson,
  integer,
  knowledgeError,
  knowledgeHash,
  validateBinding,
  validateCandidate,
  validateGenerationPlan,
  validateTrustRevision,
  validateKnowledgeArchiveRow,
} from "./validation.js";

export const KNOWLEDGE_CONTEXT_LIMITS = Object.freeze({
  documentKeys: 4,
  slotBytes: 16_384,
  profiles: 16,
  requestBytes: 16_384,
  handles: 256,
  rowBytes: 65_536,
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
const SOURCE_STALE_CODES = new Set([
  "KNOWLEDGE_SOURCE_CHANGED",
  "KNOWLEDGE_SOURCE_UNAVAILABLE",
  "KNOWLEDGE_SOURCE_SCOPE_MISMATCH",
  "KNOWLEDGE_SOURCE_UNSETTLED",
  "KNOWLEDGE_SOURCE_MEDIA_UNSUPPORTED",
]);
function fail(code: string, message: string): never {
  return knowledgeError(code, message);
}
function same(left: unknown, right: unknown): boolean {
  return knowledgeHash(left) === knowledgeHash(right);
}
function fields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail(
      "INVALID_KNOWLEDGE_CONTEXT",
      "Knowledge context requires plain host data",
    );
  const d = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(d);
  if (
    required.some((k) => !Object.hasOwn(d, k)) ||
    keys.some(
      (k) =>
        typeof k !== "string" ||
        (!required.includes(k) && !optional.includes(k)) ||
        !d[k as string]!.enumerable ||
        !Object.hasOwn(d[k as string]!, "value"),
    )
  )
    fail(
      "INVALID_KNOWLEDGE_CONTEXT",
      "Knowledge context fields contain unsupported executable or opaque input",
    );
}
function sync(value: unknown): void {
  if (value !== undefined)
    fail(
      "KNOWLEDGE_CONTEXT_PORT_INVALID",
      "Knowledge context ports must complete synchronously in their primary read transaction",
    );
}
function signal(value: unknown): asserts value is AbortSignal {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    !(value instanceof AbortSignal) ||
    Object.getPrototypeOf(value) !== AbortSignal.prototype
  )
    fail(
      "INVALID_KNOWLEDGE_CONTEXT",
      "Knowledge context requires an actual native AbortSignal",
    );
  const d = Object.getOwnPropertyDescriptors(value);
  for (const key of [
    "aborted",
    "reason",
    "addEventListener",
    "removeEventListener",
  ])
    if (Object.hasOwn(d, key))
      fail(
        "INVALID_KNOWLEDGE_CONTEXT",
        "Cancellation signal cannot replace native observations",
      );
}
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
    fail(
      "INVALID_KNOWLEDGE_CONTEXT",
      "Knowledge context needs one to four exact host document keys",
    );
  const keys = p.documentKeys.map(identifier);
  if (new Set(keys).size !== keys.length)
    fail(
      "INVALID_KNOWLEDGE_CONTEXT",
      "Host document selection cannot repeat a key",
    );
  if (!integer(p.slotBytes, KNOWLEDGE_CONTEXT_LIMITS.slotBytes))
    fail(
      "INVALID_KNOWLEDGE_CONTEXT",
      "Host knowledge slot must be positive and bounded",
    );
  if (p.profiles !== undefined) {
    if (
      !Array.isArray(p.profiles) ||
      p.profiles.length > KNOWLEDGE_CONTEXT_LIMITS.profiles
    )
      fail(
        "INVALID_KNOWLEDGE_CONTEXT",
        "Knowledge profile allowlist is too large",
      );
    const seen = new Set<string>();
    for (const profile of p.profiles) {
      fields(profile, ["id", "revision"]);
      identifier(profile.id);
      identifier(profile.revision);
      const key = knowledgeHash(profile);
      if (seen.has(key))
        fail(
          "INVALID_KNOWLEDGE_CONTEXT",
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
    fail(
      "INVALID_KNOWLEDGE_CONTEXT",
      "Known model context window must be positive",
    );
  if (Number(r.maxContextBytes) < 2 || Number(r.requiredMessagesBytes) < 2)
    fail(
      "INVALID_KNOWLEDGE_CONTEXT",
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
    fail(
      "INVALID_KNOWLEDGE_CONTEXT",
      "Knowledge context request exceeds its bounded host snapshot",
    );
  const workspace = value.workspace;
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace))
    fail(
      "INVALID_KNOWLEDGE_CONTEXT",
      "Knowledge context workspace must be an actual host data object",
    );
  identifier(workspace.id);
  if (
    typeof workspace.root !== "string" ||
    !isAbsolute(workspace.root) ||
    Buffer.byteLength(workspace.root) > 4096
  )
    fail(
      "INVALID_KNOWLEDGE_CONTEXT",
      "Knowledge context needs the exact actual workspace root",
    );
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

/** Read-only, whole-document context capture over actual primary-store DTOs and host source pins. */
export class KnowledgeContextSource implements KnowledgeContextSourcePort {
  readonly #db: DatabaseSync;
  readonly #ports: KnowledgeContextSourcePorts;
  readonly #states = new WeakMap<object, State>();
  readonly #active = new Set<object>();
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
        fail(
          "KNOWLEDGE_CONTEXT_PORT_INVALID",
          "Knowledge context requires actual synchronous primary store and source ports",
        );
    if (ports.now !== undefined && typeof ports.now !== "function")
      fail(
        "KNOWLEDGE_CONTEXT_PORT_INVALID",
        "Knowledge context clock must be callable",
      );
    this.#db = db;
    this.#ports = Object.freeze({ ...ports });
    Object.freeze(this);
  }
  private read<T>(operation: () => T): T {
    let entered = false;
    const result = this.#ports.readTx(() => {
      if (entered || !this.#db.isTransaction)
        fail(
          "KNOWLEDGE_CONTEXT_TRANSACTION_REQUIRED",
          "Knowledge context must observe one stable primary database read transaction",
        );
      entered = true;
      const value = operation();
      if (value && typeof value === "object" && "then" in value)
        fail(
          "KNOWLEDGE_CONTEXT_PORT_INVALID",
          "Knowledge context cannot cross an await inside its read transaction",
        );
      return value;
    });
    if (!entered || (result && typeof result === "object" && "then" in result))
      fail(
        "KNOWLEDGE_CONTEXT_TRANSACTION_REQUIRED",
        "Knowledge context read transaction did not complete synchronously",
      );
    return result;
  }
  private now(): number {
    const value = this.#ports.now?.() ?? Date.now();
    integer(value, 8_640_000_000_000_000);
    return value;
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
      let readBytes = 0;
      const workspaceId = request.workspace.id;
      const preflight = (table: string, id: string): boolean => {
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
          fail(
            "KNOWLEDGE_CONTEXT_PORT_INVALID",
            "Selected native knowledge rows exceed metadata-checked read bounds",
          );
        readBytes += row.bytes;
        return true;
      };
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
        fail(
          "KNOWLEDGE_CONTEXT_PORT_INVALID",
          "Knowledge pause getter must return an actual boolean",
        );
      const b = request.budget,
        remaining = Math.min(
          b.maxContextBytes - b.reservedBytes - b.requiredMessagesBytes,
          b.contextWindow === null
            ? Infinity
            : b.contextWindow -
                b.outputTokens -
                b.reservedBytes -
                b.requiredMessagesBytes,
        );
      if (remaining < 0)
        fail(
          "KNOWLEDGE_CONTEXT_BUDGET",
          "Required context and output/envelope reservation already exceed the shared context cap",
        );
      const availableBytes = Math.min(
        request.policy.slotBytes,
        b.slotBytes,
        remaining,
      );
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
        const headExists = preflight(
          "workspace_document_heads",
          workspaceDocumentHeadId(workspaceId, key),
        );
        const rawHead = this.#ports.getDocumentHead(workspaceId, key);
        if (!rawHead) {
          if (headExists)
            fail(
              "KNOWLEDGE_CONTEXT_EVIDENCE_INVALID",
              "Actual document head getter omitted a persisted row",
            );
          omission(key, "missing");
          continue;
        }
        if (!headExists)
          fail(
            "KNOWLEDGE_CONTEXT_EVIDENCE_INVALID",
            "Document head getter is not an actual persisted DTO",
          );
        const head = validateKnowledgePublicationArchiveRow({
          table: "workspace_document_heads",
          key: rawHead.id,
          workspaceId,
          data: rawHead,
        }).data as WorkspaceDocumentHead;
        if (head.documentKey !== key)
          fail(
            "KNOWLEDGE_CONTEXT_EVIDENCE_INVALID",
            "Current head belongs to another selected key",
          );
        if (!preflight("workspace_document_revisions", head.revisionId))
          fail(
            "KNOWLEDGE_CONTEXT_EVIDENCE_INVALID",
            "Actual current document revision is missing",
          );
        const rawDocument = this.#ports.getDocumentRevision(
          workspaceId,
          head.revisionId,
        );
        const document = validateKnowledgePublicationArchiveRow({
          table: "workspace_document_revisions",
          key: head.revisionId,
          workspaceId,
          data: rawDocument,
        }).data as WorkspaceDocumentRevision;
        if (
          document.documentKey !== key ||
          document.id !== head.revisionId ||
          document.revision !== head.revision ||
          document.publicationId !== head.publicationId ||
          document.status !== head.status ||
          document.bodySha256 !== head.bodySha256 ||
          head.updatedAt !== document.createdAt
        )
          fail(
            "KNOWLEDGE_CONTEXT_EVIDENCE_INVALID",
            "Actual current postimage document and head disagree",
          );
        if (head.status === "revoked") {
          omission(key, "revoked");
          continue;
        }
        if (!same(document.binding, binding)) {
          omission(key, "stale");
          continue;
        }
        if (!preflight("knowledge_publications", document.publicationId))
          fail(
            "KNOWLEDGE_CONTEXT_EVIDENCE_INVALID",
            "Active document has no actual publication owner",
          );
        const rawPublication = this.#ports.getPublication(
          workspaceId,
          document.publicationId,
        );
        const publication = validateKnowledgePublicationArchiveRow({
          table: "knowledge_publications",
          key: document.publicationId,
          workspaceId,
          data: rawPublication,
        }).data as KnowledgePublicationRecord;
        const rawReceiptHeader = this.#db
          .prepare(
            "SELECT id,length(CAST(data AS BLOB)) AS bytes FROM knowledge_publication_receipts WHERE workspace_id=? AND request_id=?",
          )
          .get(workspaceId, publication.requestId) as
          { id: string; bytes: number } | undefined;
        if (
          !rawReceiptHeader ||
          !preflight("knowledge_publication_receipts", rawReceiptHeader.id)
        )
          fail(
            "KNOWLEDGE_CONTEXT_EVIDENCE_INVALID",
            "Active publication has no actual exact receipt",
          );
        const receipt = validateKnowledgePublicationArchiveRow({
          table: "knowledge_publication_receipts",
          key: rawReceiptHeader.id,
          workspaceId,
          data: this.#ports.getReceipt(workspaceId, publication.requestId),
        }).data as KnowledgePublicationReceipt;
        const p = publication.provenance;
        if (
          !preflight("knowledge_candidates", p.candidateId) ||
          !preflight("knowledge_generation_plans", p.planId) ||
          !preflight("knowledge_generations", p.generationId) ||
          !preflight("knowledge_generation_attempts", p.attemptId) ||
          !preflight("workspace_trust_revisions", p.trustRevisionId)
        )
          fail(
            "KNOWLEDGE_CONTEXT_EVIDENCE_INVALID",
            "Published knowledge has missing original native provenance",
          );
        const candidate = validateCandidate(
            this.#ports.getCandidate(workspaceId, p.candidateId),
          ),
          plan = validateGenerationPlan(
            this.#ports.getPlan(workspaceId, p.planId),
          );
        const generation = validateKnowledgeGenerationArchiveRow({
          table: "knowledge_generations",
          key: p.generationId,
          workspaceId,
          data: this.#ports.getGeneration(workspaceId, p.generationId),
        }).data as KnowledgeGenerationRecord;
        const attempt = validateKnowledgeGenerationArchiveRow({
          table: "knowledge_generation_attempts",
          key: p.attemptId,
          workspaceId,
          data: this.#ports.getAttempt(workspaceId, p.attemptId),
        }).data as KnowledgeGenerationAttempt;
        const originalTrust = validateTrustRevision(
          this.#ports.getTrustRevision(workspaceId, p.trustRevisionId),
        );
        if (
          publication.state !== "completed" ||
          publication.operation !== "publish" ||
          publication.documentRevisionId !== document.id ||
          publication.documentKey !== key ||
          publication.body !== document.body ||
          publication.bodySha256 !== document.bodySha256 ||
          publication.expectedHeadRevision + 1 !== document.revision ||
          publication.expectedHeadRevisionId !== document.previousRevisionId ||
          publication.updatedAt !== document.createdAt ||
          Date.parse(publication.updatedAt) >=
            Date.parse(publication.expiresAt) ||
          !same(publication.binding, binding) ||
          !same(publication.provenance, document.provenance) ||
          receipt.publicationId !== publication.id ||
          receipt.documentRevisionId !== document.id ||
          receipt.requestId !== publication.requestId ||
          receipt.requestSha256 !== publication.requestSha256 ||
          receipt.operation !== "publish" ||
          receipt.createdAt !== document.createdAt ||
          candidate.workspaceId !== workspaceId ||
          candidate.id !== p.candidateId ||
          candidate.sha256 !== p.candidateSha256 ||
          candidate.generationOwnerId !== p.generationId ||
          candidate.planId !== p.planId ||
          candidate.trustRevisionId !== p.trustRevisionId ||
          candidate.body !== document.body ||
          candidate.bodySha256 !== document.bodySha256 ||
          candidate.target.kind !== "workspace-document" ||
          candidate.target.key !== key ||
          candidate.target.revision !== publication.expectedHeadRevision ||
          candidate.target.sha256 !== publication.expectedHeadSha256 ||
          plan.workspaceId !== workspaceId ||
          plan.id !== p.planId ||
          plan.sha256 !== p.planSha256 ||
          generation.sha256 !== p.generationSha256 ||
          attempt.sha256 !== p.attemptSha256 ||
          originalTrust.sha256 !== p.trustRevisionSha256 ||
          generation.state !== "completed" ||
          attempt.state !== "completed" ||
          generation.attemptId !== attempt.id ||
          attempt.generationId !== generation.id ||
          generation.planId !== plan.id ||
          attempt.planId !== plan.id ||
          generation.planSha256 !== plan.sha256 ||
          attempt.runtimeEpoch !== generation.runtimeEpoch ||
          generation.errorCode !== null ||
          attempt.errorCode !== null ||
          !attempt.streamDone ||
          attempt.finishReason !== "stop" ||
          attempt.cleanup?.confirmed !== true ||
          attempt.cleanup.method !== "iterator-complete" ||
          attempt.outputTruncated ||
          attempt.output !== candidate.body ||
          attempt.outputSha256 !== candidate.bodySha256 ||
          !same(attempt.usage, candidate.usage) ||
          attempt.outputBytes > generation.budget.maxOutputBytes ||
          attempt.observedTextBytes > generation.budget.maxOutputBytes ||
          attempt.observationBytes > generation.budget.maxObservationBytes ||
          attempt.events > generation.budget.maxEvents ||
          Date.parse(attempt.updatedAt) >= generation.deadline ||
          generation.candidate.state !== "recorded" ||
          generation.candidate.candidateId !== candidate.id ||
          candidate.requestSha256 !== plan.requestSha256 ||
          generation.logicalRequestSha256 !== plan.requestSha256 ||
          generation.logicalRequestBytes !== plan.requestBytes ||
          candidate.providerId !== plan.providerId ||
          candidate.modelId !== plan.modelId ||
          generation.providerId !== plan.providerId ||
          generation.modelId !== plan.modelId ||
          !same(candidate.source, plan.source) ||
          !same(candidate.target, plan.target) ||
          candidate.expiresAt !== plan.expiresAt ||
          originalTrust.workspaceId !== workspaceId ||
          originalTrust.decision !== "allow" ||
          originalTrust.id !== plan.trustRevisionId ||
          originalTrust.revision !== plan.expectedTrustRevision ||
          candidate.trustRevision !== originalTrust.revision ||
          ![
            candidate.binding,
            plan.binding,
            generation.binding,
            originalTrust.binding,
          ].every((v) => same(v, binding))
        )
          fail(
            "KNOWLEDGE_CONTEXT_EVIDENCE_INVALID",
            "Selected data does not describe its exact approved postimage and historical completed producer",
          );
        const now = this.now();
        if (
          Date.parse(candidate.expiresAt) <= now ||
          Date.parse(plan.expiresAt) <= now ||
          (originalTrust.expiresAt !== null &&
            Date.parse(originalTrust.expiresAt) <= now)
        ) {
          omission(key, "expired");
          continue;
        }
        const currentHeader = this.#db
          .prepare(
            "SELECT id,revision,revision_id,length(CAST(data AS BLOB)) AS bytes FROM workspace_trust_heads WHERE workspace_id=?",
          )
          .get(workspaceId) as
          | { id: string; revision: number; revision_id: string; bytes: number }
          | undefined;
        if (currentHeader) {
          preflight("workspace_trust_heads", currentHeader.id);
          // The legacy getter follows the JSON pointer, so validate it before
          // preflighting that revision and allowing the getter to read its body.
          const headRow = this.#db
            .prepare(
              "SELECT data FROM workspace_trust_heads WHERE id=? AND workspace_id=?",
            )
            .get(currentHeader.id, workspaceId)!;
          let headData: unknown;
          try {
            headData = JSON.parse(String(headRow.data));
          } catch {
            fail(
              "KNOWLEDGE_CONTEXT_EVIDENCE_INVALID",
              "Current trust head contains malformed bounded JSON",
            );
          }
          const trustHead = validateKnowledgeArchiveRow({
            table: "workspace_trust_heads",
            key: currentHeader.id,
            workspaceId,
            data: headData,
          }).data as {
            workspaceId: string;
            revision: number;
            revisionId: string;
          };
          if (
            trustHead.revisionId !== currentHeader.revision_id ||
            trustHead.revision !== currentHeader.revision ||
            trustHead.workspaceId !== workspaceId
          )
            fail(
              "KNOWLEDGE_CONTEXT_EVIDENCE_INVALID",
              "Current trust head JSON and indexed revision disagree",
            );
          if (!preflight("workspace_trust_revisions", trustHead.revisionId))
            fail(
              "KNOWLEDGE_CONTEXT_EVIDENCE_INVALID",
              "Current trust revision is missing",
            );
        }
        const currentRaw = this.#ports.getTrust(workspaceId);
        if (!currentRaw) {
          if (currentHeader)
            fail(
              "KNOWLEDGE_CONTEXT_EVIDENCE_INVALID",
              "Actual current trust getter omitted its persisted head",
            );
          omission(key, "untrusted");
          continue;
        }
        if (!currentHeader)
          fail(
            "KNOWLEDGE_CONTEXT_EVIDENCE_INVALID",
            "Trust getter does not describe a persisted current head",
          );
        const currentTrust = validateTrustRevision(currentRaw);
        if (currentTrust.workspaceId !== workspaceId)
          fail(
            "KNOWLEDGE_CONTEXT_EVIDENCE_INVALID",
            "Current trust belongs to another workspace",
          );
        if (
          currentTrust.decision !== "allow" ||
          currentTrust.sha256 !== originalTrust.sha256
        ) {
          omission(key, "untrusted");
          continue;
        }
        try {
          sync(
            this.#ports.assertTrustSourcesCurrent(
              binding,
              currentTrust.sources,
            ),
          );
          check(cancel);
        } catch (error) {
          if (
            error instanceof EngineError &&
            SOURCE_STALE_CODES.has(error.code)
          ) {
            omission(key, "untrusted");
            continue;
          }
          throw error;
        }
        try {
          sync(this.#ports.assertSourcesCurrent(binding, candidate.source));
          check(cancel);
        } catch (error) {
          if (
            error instanceof EngineError &&
            SOURCE_STALE_CODES.has(error.code)
          ) {
            omission(key, "stale");
            continue;
          }
          throw error;
        }
        const after = validateBinding(this.#ports.checkBinding(workspaceId));
        sync(this.#ports.assertOwnerCurrent(workspaceId, request.owner));
        if (!same(after, binding))
          fail(
            "KNOWLEDGE_CONTEXT_STALE",
            "Physical binding changed during source validation",
          );
        const afterTrust = validateTrustRevision(
          this.#ports.getTrust(workspaceId),
        );
        if (afterTrust.sha256 !== currentTrust.sha256)
          fail(
            "KNOWLEDGE_CONTEXT_STALE",
            "Trust changed inside the primary knowledge observation",
          );
        const manifest: KnowledgeContextDocumentManifest = {
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
          trustRevisionId: currentTrust.id,
          trustRevisionSha256: currentTrust.sha256,
          sourceManifestSha256: knowledgeHash(candidate.source),
          sourceTextSha256: candidate.source.sha256,
          sourcePinCount: candidate.source.pins.length,
          candidateExpiresAt: candidate.expiresAt,
          planExpiresAt: plan.expiresAt,
          trustExpiresAt: currentTrust.expiresAt,
        };
        const next = { manifest, body: document.body };
        if (
          !only &&
          contributionBytes(
            [...selected, next],
            workspaceId,
            knowledgeHash(request.policy),
          ) > availableBytes
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
        fail(
          "KNOWLEDGE_CONTEXT_STALE",
          "Knowledge physical binding changed before capture completed",
        );
      // Earlier documents may expire while a later selected source is read.
      // Evaluate the whole captured set after all synchronous host I/O.
      const finalNow = this.now();
      for (let index = selected.length - 1; index >= 0; index--) {
        const manifest = selected[index]!.manifest;
        if (
          Date.parse(manifest.candidateExpiresAt) <= finalNow ||
          Date.parse(manifest.planExpiresAt) <= finalNow ||
          (manifest.trustExpiresAt !== null &&
            Date.parse(manifest.trustExpiresAt) <= finalNow)
        ) {
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
        availableBytes,
      };
    });
  }
  async prepare(
    input: KnowledgeContextRequest,
  ): Promise<PreparedKnowledgeContribution> {
    const captured = snapshot(input);
    if (this.#active.size >= KNOWLEDGE_CONTEXT_LIMITS.handles)
      fail(
        "KNOWLEDGE_CONTEXT_LIMIT",
        "Knowledge context original capture limit reached",
      );
    const observed = this.observe(captured.request, captured.signal);
    check(captured.signal);
    const docs = observed.selected.map((s) => s.manifest),
      bytes = contributionBytes(
        observed.selected,
        captured.request.workspace.id,
        knowledgeHash(captured.request.policy),
      ),
      body = {
        schemaVersion: 1 as const,
        authority: "read-only" as const,
        trust: "host-approved-data" as const,
        coverage: "host-selected-document-keys" as const,
        workspaceId: captured.request.workspace.id,
        owner: captured.request.owner,
        policySha256: knowledgeHash(captured.request.policy),
        bindingSha256: observed.bindingSha256,
        documents: docs,
        omissions: observed.omissions,
        complete: observed.omissions.length === 0,
        messages: observed.selected.length
          ? [
              message(
                observed.selected,
                captured.request.workspace.id,
                knowledgeHash(captured.request.policy),
              ),
            ]
          : [],
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
    this.#active.add(result);
    return result;
  }
  private owned(contribution: PreparedKnowledgeContribution): State {
    if (
      !contribution ||
      typeof contribution !== "object" ||
      types.isProxy(contribution) ||
      !this.#active.has(contribution)
    )
      fail(
        "KNOWLEDGE_CONTEXT_CAPTURE_INVALID",
        "Knowledge contribution is copied, foreign, released or never issued",
      );
    return (
      this.#states.get(contribution) ??
      fail(
        "KNOWLEDGE_CONTEXT_CAPTURE_INVALID",
        "Knowledge contribution has no original host capture",
      )
    );
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
      fail(
        "KNOWLEDGE_CONTEXT_STALE",
        "Included approved knowledge or its exact postimage/current sources changed before dispatch",
      );
  }
  release(contribution: PreparedKnowledgeContribution): void {
    this.owned(contribution);
    this.#active.delete(contribution);
    this.#states.delete(contribution);
  }
}
