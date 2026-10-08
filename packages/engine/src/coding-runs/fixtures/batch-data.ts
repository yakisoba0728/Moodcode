import type { CodingBatchInput } from "../types.js";

interface BatchIdentityData {
  readonly workspaceId: string;
  readonly rootSessionId: string;
  readonly parentRunId: string;
  readonly profileId: string;
  readonly profileRevision: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly worktreeIds: readonly [string, string, string, string];
}

/** Only definition DATA crosses this boundary; the fixture owns every native handle. */
export function batchInputData(identity: BatchIdentityData): CodingBatchInput {
  const resultSchema = {
      type: "object" as const,
      properties: { observation: { type: "string" as const, maxLength: 1024 } },
      required: ["observation"],
      additionalProperties: false as const,
    },
    reviewSchema = {
      type: "object" as const,
      properties: {
        observation: { type: "string" as const, maxLength: 1024 },
        score: { type: "integer" as const, minimum: 0, maximum: 100 },
      },
      required: ["observation", "score"],
      additionalProperties: false as const,
    },
    common = {
      profile: { id: identity.profileId, revision: identity.profileRevision },
      model: { providerId: identity.providerId, modelId: identity.modelId },
      allocation: {
        turns: 3,
        toolCalls: 2,
        outputBytes: 16384,
        durationMs: 10000,
      },
      join: "all" as const,
    };
  return {
    workspaceId: identity.workspaceId,
    rootSessionId: identity.rootSessionId,
    parentRunId: identity.parentRunId,
    groupId: "actual-group",
    limits: {
      concurrency: 2,
      maxDurationMs: 120000,
      maxSourceBytes: 1048576,
      maxEvidenceBytes: 262144,
      maxExportBytes: 1048576,
      maxTokens: 100000000,
      maxCostMicros: 1000000,
      costPerRequestMicros: 100,
    },
    cases: ["A", "B"].map((id, i) => ({
      id,
      sourcePaths: ["seed.txt"],
      stageWorktrees: {
        edit: identity.worktreeIds[i * 2]!,
        validate: identity.worktreeIds[i * 2]!,
        review: identity.worktreeIds[i * 2 + 1]!,
      },
      spec: {
        schemaVersion: 1,
        id: `batch-workflow-${id}`,
        description: `Actual independent coding problem ${id}.`,
        parameterSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
        resultSchema: reviewSchema,
        resultStageId: "review",
        stages: [
          {
            ...common,
            id: "edit",
            role: "editor",
            dependsOn: [],
            prompt: `BATCH_EDITOR ${id}: approved native edit seed.txt then strict JSON.`,
            tools: ["read_file", "apply_patch"],
            resultSchema,
          },
          {
            ...common,
            id: "validate",
            role: "validator",
            dependsOn: ["edit"],
            prompt: `BATCH_VALIDATOR ${id}: registered native verification then strict JSON.`,
            tools: ["read_file", "run_command", "verify_changes"],
            resultSchema,
            verification: {
              checkIds: [`batch-check-${id}`],
              sourcePaths: ["seed.txt"],
              maxRepairs: 0,
            },
          },
          {
            ...common,
            id: "review",
            role: "advisory-reviewer",
            dependsOn: ["validate"],
            prompt: `BATCH_REVIEWER ${id}: review quoted native predecessor result, score advisory only, strict JSON.`,
            tools: ["read_file"],
            resultSchema: reviewSchema,
          },
        ],
      },
    })),
  };
}
