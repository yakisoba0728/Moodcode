import type {
  JsonObject,
  JsonValue,
  ReasoningEffort,
} from "@moodcode/contracts";
import type { ChildBudget } from "../child-tasks/index.js";

export type WorkflowScalar = string | number | boolean | null;
export type WorkflowSchema =
  | {
      readonly type: "object";
      readonly properties: Readonly<Record<string, WorkflowSchema>>;
      readonly required: readonly string[];
      readonly additionalProperties: false;
    }
  | {
      readonly type: "array";
      readonly items: WorkflowSchema;
      readonly maxItems: number;
      readonly minItems?: number;
    }
  | {
      readonly type: "string";
      readonly maxLength: number;
      readonly minLength?: number;
      readonly enum?: readonly string[];
    }
  | {
      readonly type: "number" | "integer";
      readonly minimum?: number;
      readonly maximum?: number;
      readonly enum?: readonly number[];
    }
  | { readonly type: "boolean"; readonly enum?: readonly boolean[] }
  | { readonly type: "null" };
export type WorkflowObjectSchema = Extract<WorkflowSchema, { type: "object" }>;
export type WorkflowRole =
  "planner" | "editor" | "validator" | "advisory-reviewer";
export interface WorkflowProfilePin {
  readonly id: string;
  readonly revision: string;
}
export interface WorkflowModelPin {
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningEffort?: ReasoningEffort;
}
/** Role names label advisory data flow; they do not switch a policy profile or grant tools. */
export interface WorkflowStageSpec {
  readonly id: string;
  readonly role: WorkflowRole;
  readonly dependsOn: readonly string[];
  readonly join: "all" | "any";
  readonly prompt: string;
  readonly profile: WorkflowProfilePin | null;
  readonly model: WorkflowModelPin;
  readonly tools: readonly string[];
  readonly allocation: ChildBudget;
  readonly resultSchema: WorkflowObjectSchema;
  /** Host-registered checks only; the validator inherits the actual parent profile/model. */
  readonly verification?: {
    readonly checkIds: readonly string[];
    readonly sourcePaths: readonly string[];
    readonly maxRepairs: 0;
  };
}
export interface WorkflowSpecInput {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly description: string;
  readonly parameterSchema: WorkflowObjectSchema;
  readonly resultSchema: WorkflowObjectSchema;
  readonly stages: readonly WorkflowStageSpec[];
  readonly resultStageId: string;
}
export interface WorkflowSpec extends WorkflowSpecInput {
  readonly sha256: string;
}
export interface WorkflowRegistrationInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly spec: WorkflowSpecInput | WorkflowSpec;
}
/** Immutable, advisory DATA only; this is not evidence of child execution or verification. */
export interface WorkflowStageResult {
  readonly stageId: string;
  readonly authority: "advisory-data";
  readonly value: JsonObject;
  readonly sha256: string;
}
export type WorkflowRecipeBinding =
  | { readonly source: "input"; readonly key: string }
  | { readonly source: "literal"; readonly value: JsonValue };
export interface WorkflowRecipeInput {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly description: string;
  readonly workflowId: string;
  readonly workflowSha256: string;
  readonly inputSchema: WorkflowObjectSchema;
  readonly parameterBindings: Readonly<Record<string, WorkflowRecipeBinding>>;
}
export interface WorkflowRecipe extends WorkflowRecipeInput {
  readonly sha256: string;
}
export interface WorkflowRecipeResult {
  readonly recipeId: string;
  readonly recipeSha256: string;
  readonly workflowId: string;
  readonly workflowSha256: string;
  readonly authority: "advisory-data";
  readonly parameters: JsonObject;
  readonly parametersSha256: string;
  readonly sha256: string;
}
