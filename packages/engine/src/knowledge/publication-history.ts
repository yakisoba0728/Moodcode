import { EngineError } from "@moodcode/contracts";
import { validateKnowledgeGenerationArchiveRow } from "./generation-store.js";
import type {
  KnowledgeGenerationAttempt,
  KnowledgeGenerationRecord,
} from "./generation-types.js";
import type {
  KnowledgeCandidate,
  KnowledgeGenerationPlan,
  TrustRevision,
} from "./types.js";
import {
  immutableKnowledgeJson,
  knowledgeHash,
  validateCandidate,
  validateGenerationPlan,
  validateTrustRevision,
} from "./validation.js";

export interface KnowledgePublicationHistoryPorts {
  readonly getCandidate: (
    workspaceId: string,
    candidateId: string,
  ) => KnowledgeCandidate | undefined;
  readonly getPlan: (
    workspaceId: string,
    planId: string,
  ) => KnowledgeGenerationPlan | undefined;
  readonly getGeneration: (
    workspaceId: string,
    generationId: string,
  ) => KnowledgeGenerationRecord;
  readonly getAttempt: (
    workspaceId: string,
    attemptId: string,
  ) => KnowledgeGenerationAttempt;
  readonly getTrustRevision: (
    workspaceId: string,
    revisionId: string,
  ) => TrustRevision | undefined;
}
export interface KnowledgePublicationHistory {
  readonly candidate: KnowledgeCandidate;
  readonly plan: KnowledgeGenerationPlan;
  readonly generation: KnowledgeGenerationRecord;
  readonly attempt: KnowledgeGenerationAttempt;
  readonly trust: TrustRevision;
}
function fail(code: string, message: string): never {
  throw new EngineError(code, message);
}
function same(left: unknown, right: unknown): boolean {
  return knowledgeHash(left) === knowledgeHash(right);
}

/** Historical output is evidence, not a current source/target/trust permission. */
export function readKnowledgePublicationHistory(
  ports: KnowledgePublicationHistoryPorts,
  workspaceId: string,
  candidateId: string,
): KnowledgePublicationHistory {
  const candidate = validateCandidate(
    ports.getCandidate(workspaceId, candidateId),
  );
  const plan = validateGenerationPlan(
    ports.getPlan(workspaceId, candidate.planId),
  );
  const original = immutableKnowledgeJson(
    ports.getGeneration(workspaceId, candidate.generationOwnerId),
  );
  const generation = validateKnowledgeGenerationArchiveRow({
    table: "knowledge_generations",
    key: candidate.generationOwnerId,
    workspaceId,
    data: original,
  }).data as KnowledgeGenerationRecord;
  if (generation.attemptId === null)
    fail(
      "KNOWLEDGE_PUBLICATION_EVIDENCE_INVALID",
      "Publication requires the actual completed native attempt",
    );
  const attempt = validateKnowledgeGenerationArchiveRow({
    table: "knowledge_generation_attempts",
    key: generation.attemptId,
    workspaceId,
    data: ports.getAttempt(workspaceId, generation.attemptId),
  }).data as KnowledgeGenerationAttempt;
  const trust = validateTrustRevision(
    ports.getTrustRevision(workspaceId, candidate.trustRevisionId),
  );
  if (
    candidate.workspaceId !== workspaceId ||
    plan.workspaceId !== workspaceId ||
    generation.state !== "completed" ||
    attempt.state !== "completed" ||
    attempt.generationId !== generation.id ||
    attempt.planId !== plan.id ||
    generation.planId !== plan.id ||
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
    candidate.requestSha256 !== plan.requestSha256 ||
    generation.logicalRequestSha256 !== plan.requestSha256 ||
    generation.logicalRequestBytes !== plan.requestBytes ||
    candidate.providerId !== plan.providerId ||
    candidate.modelId !== plan.modelId ||
    generation.providerId !== plan.providerId ||
    generation.modelId !== plan.modelId ||
    !same(candidate.binding, plan.binding) ||
    !same(generation.binding, candidate.binding) ||
    !same(candidate.source, plan.source) ||
    !same(candidate.target, plan.target) ||
    trust.workspaceId !== workspaceId ||
    trust.decision !== "allow" ||
    trust.id !== plan.trustRevisionId ||
    trust.revision !== plan.expectedTrustRevision ||
    candidate.trustRevisionId !== trust.id ||
    candidate.trustRevision !== trust.revision ||
    !same(trust.binding, candidate.binding) ||
    generation.candidate.state !== "recorded" ||
    generation.candidate.candidateId !== candidate.id
  )
    fail(
      "KNOWLEDGE_PUBLICATION_EVIDENCE_INVALID",
      "Candidate does not describe the exact historical completed producer and cleanup",
    );
  return Object.freeze({ candidate, plan, generation, attempt, trust });
}
