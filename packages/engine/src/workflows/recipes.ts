import { type JsonObject } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  validateWorkflowObjectSchema,
  validateWorkflowSpec,
  validateWorkflowValue,
  workflowError,
  workflowIdentifier,
  workflowJson,
  workflowObject,
  workflowSha,
} from "./spec.js";
import type {
  WorkflowRecipe,
  WorkflowRecipeBinding,
  WorkflowRecipeResult,
  WorkflowSpec,
} from "./types.js";

/** Recipes bind bounded user DATA to parameters of one exact registered definition.
 * They cannot replace stage prompts, profile/model/tool pins, allocations or approval.
 */
export function validateWorkflowRecipe(
  input: unknown,
  workflowInput: WorkflowSpec,
): WorkflowRecipe {
  const spec = validateWorkflowSpec(workflowInput);
  const value = workflowObject(
    input,
    [
      "schemaVersion",
      "id",
      "description",
      "workflowId",
      "workflowSha256",
      "inputSchema",
      "parameterBindings",
    ],
    ["sha256"],
  );
  if (
    value.schemaVersion !== 1 ||
    workflowIdentifier(value.workflowId) !== spec.id ||
    workflowSha(value.workflowSha256) !== spec.sha256
  )
    workflowError("WORKFLOW_RECIPE_STALE");
  if (
    typeof value.description !== "string" ||
    value.description.includes("\0") ||
    Buffer.byteLength(value.description) > 4096
  )
    workflowError("WORKFLOW_LIMIT");
  const inputSchema = validateWorkflowObjectSchema(value.inputSchema);
  if (
    !value.parameterBindings ||
    typeof value.parameterBindings !== "object" ||
    Array.isArray(value.parameterBindings)
  )
    workflowError("INVALID_WORKFLOW_RECIPE");
  const parameterBindings: Record<string, WorkflowRecipeBinding> = {};
  const entries = Object.entries(value.parameterBindings);
  if (
    entries.length > 64 ||
    spec.parameterSchema.required.some(
      (key) => !Object.hasOwn(value.parameterBindings as object, key),
    )
  )
    workflowError("INVALID_WORKFLOW_RECIPE");
  for (const [key, original] of entries.sort(([a], [b]) =>
    a.localeCompare(b, "en"),
  )) {
    if (!Object.hasOwn(spec.parameterSchema.properties, key))
      workflowError("INVALID_WORKFLOW_RECIPE");
    const binding = workflowJson(original);
    if (!binding || typeof binding !== "object" || Array.isArray(binding))
      workflowError("INVALID_WORKFLOW_RECIPE");
    const source = (binding as Record<string, unknown>).source;
    if (source === "input") {
      const selected = workflowObject(binding, ["source", "key"]),
        inputKey = workflowIdentifier(selected.key);
      if (!Object.hasOwn(inputSchema.properties, inputKey))
        workflowError("INVALID_WORKFLOW_RECIPE");
      // Exact schema identity makes every admitted input valid for its target.
      if (
        knowledgeHash(inputSchema.properties[inputKey]) !==
          knowledgeHash(spec.parameterSchema.properties[key]) ||
        (spec.parameterSchema.required.includes(key) &&
          !inputSchema.required.includes(inputKey))
      )
        workflowError("WORKFLOW_RECIPE_SCHEMA_MISMATCH");
      parameterBindings[key] = { source: "input", key: inputKey };
    } else if (source === "literal") {
      const selected = workflowObject(binding, ["source", "value"]);
      parameterBindings[key] = {
        source: "literal",
        value: validateWorkflowValue(
          spec.parameterSchema.properties[key]!,
          selected.value,
        ),
      };
    } else workflowError("INVALID_WORKFLOW_RECIPE");
  }
  const definition = workflowJson({
    schemaVersion: 1 as const,
    id: workflowIdentifier(value.id),
    description: value.description,
    workflowId: spec.id,
    workflowSha256: spec.sha256,
    inputSchema,
    parameterBindings,
  });
  const sha256 = knowledgeHash(definition);
  if (value.sha256 !== undefined && workflowSha(value.sha256) !== sha256)
    workflowError("WORKFLOW_RECIPE_STALE");
  return workflowJson({ ...definition, sha256 });
}
export function bindWorkflowRecipe(
  input: WorkflowRecipe,
  workflowInput: WorkflowSpec,
  parametersInput: unknown,
): WorkflowRecipeResult {
  const spec = validateWorkflowSpec(workflowInput),
    recipe = validateWorkflowRecipe(input, spec);
  const values = validateWorkflowValue(
    recipe.inputSchema,
    parametersInput,
  ) as JsonObject;
  const parameters: JsonObject = {};
  for (const [key, binding] of Object.entries(recipe.parameterBindings)) {
    if (binding.source === "literal") parameters[key] = binding.value;
    else if (Object.hasOwn(values, binding.key))
      parameters[key] = values[binding.key]!;
  }
  const admitted = validateWorkflowValue(
    spec.parameterSchema,
    parameters,
  ) as JsonObject;
  const result = {
    recipeId: recipe.id,
    recipeSha256: recipe.sha256,
    workflowId: spec.id,
    workflowSha256: spec.sha256,
    authority: "advisory-data" as const,
    parameters: admitted,
    parametersSha256: knowledgeHash(admitted),
  };
  return workflowJson({ ...result, sha256: knowledgeHash(result) });
}
