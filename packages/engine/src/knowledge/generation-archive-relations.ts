import type { DatabaseSync } from "node:sqlite";
import {
  createKnowledgeGraphReader,
  KNOWLEDGE_PRODUCER_COLUMNS,
  type KnowledgeGraphFault,
} from "./archive-graph.js";
import {
  attemptBelongsTo,
  candidateMatchesOutput,
  KNOWLEDGE_GENERATION_COLUMNS,
  KNOWLEDGE_GENERATION_TABLES,
  validateKnowledgeGenerationArchiveRow,
} from "./generation-validation.js";
import type {
  KnowledgeGenerationAttempt,
  KnowledgeGenerationRecord,
  KnowledgeGenerationTable,
} from "./generation-types.js";
import type {
  KnowledgeCandidate,
  KnowledgeGenerationPlan,
  TrustRevision,
} from "./types.js";
import {
  knowledgeError,
  knowledgeHash,
  sameKnowledge as equal,
  validateKnowledgeArchiveRow,
} from "./validation.js";

type Table =
  | KnowledgeGenerationTable
  | "knowledge_generation_plans"
  | "knowledge_candidates"
  | "workspace_trust_revisions";
const COLUMNS: Readonly<Record<Table, Readonly<Record<string, string>>>> =
  Object.freeze({
    ...KNOWLEDGE_GENERATION_COLUMNS,
    ...KNOWLEDGE_PRODUCER_COLUMNS,
  });
const FAULTS: Readonly<Record<KnowledgeGraphFault, string>> = {
  bound: "Stored knowledge row exceeds its byte bound before body loading",
  changed: "Stored knowledge row changed or exceeds its bounded metadata",
  json: "Stored knowledge row is not JSON",
  columns: "Indexed knowledge columns disagree with their validated JSON body",
  multiple: "An exact knowledge relation resolves to multiple records",
  missing: "Native generation references a missing exact knowledge record",
};
function invalid(message: string): never {
  return knowledgeError("KNOWLEDGE_GENERATION_RELATION_INVALID", message);
}

/** Validates historical producer relations inside the caller's stable read transaction, issuing no host capability.
 * `check` enforces cancellation, deadline and whole-database limits; bodies are bounded and relations streamed. */
export function validateKnowledgeGenerationDatabase(
  db: DatabaseSync,
  check: () => void,
): void {
  const { headers, read, one, exact } = createKnowledgeGraphReader<Table>(
    db,
    check,
    {
      columns: COLUMNS,
      validate: (row) =>
        (KNOWLEDGE_GENERATION_TABLES.includes(
          row.table as KnowledgeGenerationTable,
        )
          ? validateKnowledgeGenerationArchiveRow(row)
          : validateKnowledgeArchiveRow(row)
        ).data,
      invalid: (fault) => invalid(FAULTS[fault]),
    },
  );
  function planFor(g: KnowledgeGenerationRecord): KnowledgeGenerationPlan {
    const plan = exact<KnowledgeGenerationPlan>(
      "knowledge_generation_plans",
      g.workspaceId,
      g.planId,
    );
    const trust = exact<TrustRevision>(
      "workspace_trust_revisions",
      g.workspaceId,
      plan.trustRevisionId,
    );
    if (
      plan.sha256 !== g.planSha256 ||
      plan.providerId !== g.providerId ||
      plan.modelId !== g.modelId ||
      plan.requestSha256 !== g.logicalRequestSha256 ||
      plan.requestBytes !== g.logicalRequestBytes ||
      !equal(plan.binding, g.binding) ||
      g.budget.maxOutputBytes > plan.maxOutputBytes ||
      g.deadline > Date.parse(plan.expiresAt) ||
      Date.parse(g.createdAt) < Date.parse(plan.createdAt) ||
      Date.parse(g.createdAt) >= Date.parse(plan.expiresAt) ||
      trust.decision !== "allow" ||
      trust.revision !== plan.expectedTrustRevision ||
      !equal(trust.binding, plan.binding)
    )
      invalid(
        "Native generation differs from its original exact plan or historical trust revision",
      );
    if (
      knowledgeHash({
        workspaceId: g.workspaceId,
        planId: g.planId,
        requestId: g.requestId,
        budget: g.budget,
        logicalRequestSha256: g.logicalRequestSha256,
        logicalRequestBytes: g.logicalRequestBytes,
      }) !== g.createSha256
    )
      invalid(
        "Native generation creation hash does not describe its stored original input",
      );
    return plan;
  }
  function pair(
    g: KnowledgeGenerationRecord,
    a: KnowledgeGenerationAttempt | undefined,
  ): void {
    if (!a) {
      if (
        g.attemptId !== null ||
        !["prepared", "failed", "cancelled"].includes(g.state)
      )
        invalid("Dispatched native generation has no original exact attempt");
      return;
    }
    if (
      a.id !== g.attemptId ||
      a.workspaceId !== g.workspaceId ||
      !attemptBelongsTo(g, a) ||
      a.errorCode !== g.errorCode ||
      Date.parse(a.createdAt) < Date.parse(g.createdAt) ||
      Date.parse(a.updatedAt) > Date.parse(g.updatedAt) ||
      (a.dispatchedAt !== null &&
        Date.parse(a.dispatchedAt) > Date.parse(a.updatedAt)) ||
      a.outputBytes > g.budget.maxOutputBytes
    )
      invalid(
        "Native generation and attempt ownership, state or retained output budget disagree",
      );
    if (
      (a.dispatchedAt === null || a.state === "dispatched") &&
      (a.outputBytes !== 0 ||
        a.observedTextBytes !== 0 ||
        a.outputTruncated ||
        a.observationBytes !== 0 ||
        a.events !== 0 ||
        Object.values(a.usage).some((value) => value !== null) ||
        a.providerRequestId !== null ||
        a.finishReason !== null ||
        a.streamDone)
    )
      invalid(
        "Native attempt cannot observe provider output before its original durable dispatch",
      );
    if (
      a.dispatchedAt === null &&
      a.cleanup !== null &&
      a.cleanup.method !== "not-dispatched"
    )
      invalid("Undispatched native attempt cannot claim iterator cleanup");
    // Failed/uncertain outcomes keep their last real overflow; only completed output must have stayed in budget.
    if (
      g.state === "completed" &&
      (a.observedTextBytes > g.budget.maxOutputBytes ||
        a.observationBytes > g.budget.maxObservationBytes ||
        a.events > g.budget.maxEvents ||
        Date.parse(a.updatedAt) >= g.deadline)
    )
      invalid(
        "Completed native output exceeded its original deadline or observation budget",
      );
  }
  function candidateFor(
    g: KnowledgeGenerationRecord,
    a: KnowledgeGenerationAttempt | undefined,
    plan: KnowledgeGenerationPlan,
  ): void {
    const candidate = one<KnowledgeCandidate>(
      "knowledge_candidates",
      "workspace_id=? AND generation_owner_id=?",
      [g.workspaceId, g.id],
    );
    if (
      g.candidate.state === "recorded" &&
      (!candidate || candidate.id !== g.candidate.candidateId)
    )
      invalid(
        "Recorded native candidate ID is not the exact actual owner candidate",
      );
    if (!candidate) return;
    if (
      g.state !== "completed" ||
      !a ||
      !candidateMatchesOutput(candidate, g, a) ||
      candidate.generationOwnerId !== g.id ||
      !equal(candidate.binding, plan.binding) ||
      candidate.trustRevisionId !== plan.trustRevisionId ||
      candidate.trustRevision !== plan.expectedTrustRevision ||
      !equal(candidate.source, plan.source) ||
      !equal(candidate.target, plan.target) ||
      candidate.providerId !== g.providerId ||
      candidate.modelId !== g.modelId ||
      candidate.body !== a.output ||
      !equal(candidate.usage, a.usage) ||
      candidate.expiresAt !== plan.expiresAt ||
      Date.parse(candidate.createdAt) < Date.parse(a.updatedAt)
    )
      invalid(
        "Knowledge candidate is not the exact completed native owner output and provenance",
      );
    // Append and marker commit separately: a crash may leave an exact candidate under a pending/withheld marker; never promote it.
  }

  for (const header of headers("knowledge_generations", "ORDER BY id")) {
    const generation = read<KnowledgeGenerationRecord>(
      "knowledge_generations",
      header,
    );
    const plan = planFor(generation);
    const attempt = one<KnowledgeGenerationAttempt>(
      "knowledge_generation_attempts",
      "workspace_id=? AND generation_id=?",
      [generation.workspaceId, generation.id],
    );
    pair(generation, attempt);
    candidateFor(generation, attempt, plan);
  }
  // Reject orphan attempts even when an archive author disabled foreign keys; each lookup is a bounded primary-key read.
  for (const header of headers(
    "knowledge_generation_attempts",
    "ORDER BY id",
  )) {
    const attempt = read<KnowledgeGenerationAttempt>(
      "knowledge_generation_attempts",
      header,
    );
    pair(
      exact<KnowledgeGenerationRecord>(
        "knowledge_generations",
        attempt.workspaceId,
        attempt.generationId,
      ),
      attempt,
    );
  }
  for (const table of [
    "knowledge_generation_recovery_acknowledgments",
    "knowledge_generation_workspace_barriers",
  ] as const)
    for (const header of headers(table, "ORDER BY id")) read(table, header);
  check();
}
