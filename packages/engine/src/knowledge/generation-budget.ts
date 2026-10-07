import {
  identifier,
  immutableKnowledgeJson,
  integer,
  knowledgeError,
  knowledgeHash,
} from "./validation.js";
import type { KnowledgeGenerationBudget } from "./generation-types.js";

export const KNOWLEDGE_GENERATION_BUDGET_MAXIMUMS: KnowledgeGenerationBudget =
  Object.freeze({
    maxDurationMs: 90_000,
    providerRequestTimeoutMs: 60_000,
    inactivityTimeoutMs: 20_000,
    cleanupTimeoutMs: 1_000,
    maxOutputBytes: 16_384,
    maxObservationBytes: 65_536,
    maxEvents: 4_096,
    maxAttempts: 1,
  });
export const DEFAULT_KNOWLEDGE_GENERATION_BUDGET: KnowledgeGenerationBudget =
  Object.freeze({ ...KNOWLEDGE_GENERATION_BUDGET_MAXIMUMS });
export function normalizeKnowledgeGenerationBudget(
  input: Partial<KnowledgeGenerationBudget> = {},
): KnowledgeGenerationBudget {
  const value = immutableKnowledgeJson(input);
  if (!value || typeof value !== "object" || Array.isArray(value))
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION_BUDGET",
      "Host generation budget must be a plain data object",
    );
  for (const key of Object.keys(value))
    if (!Object.hasOwn(KNOWLEDGE_GENERATION_BUDGET_MAXIMUMS, key))
      knowledgeError(
        "INVALID_KNOWLEDGE_GENERATION_BUDGET",
        "Unknown host generation budget field",
      );
  const result = { ...DEFAULT_KNOWLEDGE_GENERATION_BUDGET, ...value };
  for (const key of Object.keys(result) as (keyof KnowledgeGenerationBudget)[])
    if (integer(result[key], KNOWLEDGE_GENERATION_BUDGET_MAXIMUMS[key]) < 1)
      knowledgeError(
        "INVALID_KNOWLEDGE_GENERATION_BUDGET",
        "Host generation budgets must be positive and bounded",
      );
  if (
    result.maxAttempts !== 1 ||
    result.providerRequestTimeoutMs > result.maxDurationMs ||
    result.inactivityTimeoutMs > result.providerRequestTimeoutMs ||
    result.cleanupTimeoutMs > result.maxDurationMs
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION_BUDGET",
      "Host generation supports one attempt within the original request and operation deadlines",
    );
  return Object.freeze(result);
}
export function knowledgeGenerationBudgetHash(
  budget: KnowledgeGenerationBudget,
): string {
  return knowledgeHash(normalizeKnowledgeGenerationBudget(budget));
}
export function knowledgeGenerationRemainingMs(
  deadline: number,
  now: number,
): number {
  integer(deadline, 8_640_000_000_000_000);
  integer(now, 8_640_000_000_000_000);
  return Math.max(0, deadline - now);
}
export function assertKnowledgeGenerationDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Host generation hash must be a lowercase SHA-256 digest",
    );
  return value as string;
}
export function knowledgeGenerationErrorCode(value: unknown): string {
  return identifier(value);
}
