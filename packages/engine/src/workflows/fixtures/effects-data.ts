import type { WorkflowSpecInput } from "../types.js";

interface EffectsIdentityData {
  readonly profileId: string;
  readonly profileRevision: string;
  readonly providerId: string;
  readonly modelId: string;
}

/** Captured identity DATA defines stages; registration and effects stay in the fixture. */
export function effectsSpecData(
  identity: EffectsIdentityData,
  sourcePath = "seed.txt",
): WorkflowSpecInput {
  const resultSchema = {
    type: "object" as const,
    properties: { observation: { type: "string" as const, maxLength: 2048 } },
    required: ["observation"],
    additionalProperties: false as const,
  };
  const allocation = {
    turns: 4,
    toolCalls: 2,
    outputBytes: 16384,
    durationMs: 10000,
  };
  const common = {
    profile: { id: identity.profileId, revision: identity.profileRevision },
    model: { providerId: identity.providerId, modelId: identity.modelId },
    allocation,
    resultSchema,
    join: "all" as const,
  };
  return {
    schemaVersion: 1,
    id: "actual-effect-workflow",
    description: "Actual editor and native validator before parent merge.",
    parameterSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    resultSchema,
    stages: [
      {
        ...common,
        id: "edit",
        role: "editor",
        dependsOn: [],
        prompt:
          `ACTUAL_EDITOR: change ${sourcePath} through the native approved patch and then return strict JSON.`,
        tools: ["read_file", "apply_patch"],
      },
      {
        ...common,
        id: "validate",
        role: "validator",
        dependsOn: ["edit"],
        prompt:
          "ACTUAL_VALIDATOR: invoke the registered verify_changes check and return strict JSON.",
        tools: ["read_file", "run_command", "verify_changes"],
        verification: {
          checkIds: ["actual-required-check"],
          sourcePaths: [sourcePath],
          maxRepairs: 0,
        },
      },
    ],
    resultStageId: "validate",
  };
}
