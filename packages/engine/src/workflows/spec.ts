import {
  EngineError,
  REASONING_EFFORTS,
  type JsonObject,
  type JsonValue,
} from "@moodcode/contracts";
import {
  immutableKnowledgeJson,
  knowledgeHash,
} from "../knowledge/validation.js";
import type { ChildBudget } from "../child-tasks/index.js";
import type {
  WorkflowModelPin,
  WorkflowObjectSchema,
  WorkflowProfilePin,
  WorkflowSchema,
  WorkflowSpec,
  WorkflowStageResult,
  WorkflowStageSpec,
} from "./types.js";

export const WORKFLOW_LIMITS = Object.freeze({
  rowBytes: 65536,
  stages: 8,
  dependencyPath: 4,
  schemaDepth: 4,
  schemaNodes: 512,
  properties: 64,
  arrayItems: 64,
  enumItems: 16,
  stringLength: 16384,
  promptBytes: 32768,
  tools: 64,
});
export const WORKFLOW_READ_TOOLS = Object.freeze([
  "glob_files",
  "list_files",
  "read_file",
  "regex_search",
  "search_files",
]);
export function workflowError(code = "INVALID_WORKFLOW_SPEC"): never {
  throw new EngineError(
    code,
    "Workflows require bounded immutable schemas, an acyclic stage graph and explicit host execution pins",
  );
}
/** Descriptor-safe immutable JSON. No getter, proxy, coercion or custom serializer is evaluated. */
export function workflowJson<T>(input: T): T {
  try {
    return immutableKnowledgeJson(input);
  } catch (error) {
    return workflowError(
      error instanceof EngineError && error.code === "KNOWLEDGE_LIMIT"
        ? "WORKFLOW_LIMIT"
        : "INVALID_WORKFLOW_SPEC",
    );
  }
}
export function workflowObject(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const value = workflowJson(input);
  if (!value || typeof value !== "object" || Array.isArray(value))
    workflowError();
  const record = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    workflowError();
  return record;
}
export function workflowIdentifier(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(input))
    workflowError();
  return input;
}
function externalIdentifier(input: unknown): string {
  if (
    typeof input !== "string" ||
    !input ||
    Buffer.byteLength(input) > 256 ||
    /[\u0000-\u001f\u007f]/u.test(input) ||
    Buffer.from(input).toString("utf8") !== input
  )
    workflowError();
  return input;
}
export function workflowInteger(
  input: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
  minimum = 0,
): number {
  if (
    !Number.isSafeInteger(input) ||
    (input as number) < minimum ||
    (input as number) > maximum
  )
    workflowError("WORKFLOW_LIMIT");
  return input as number;
}
export function workflowSha(input: unknown): string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input))
    workflowError();
  return input;
}
function field(input: unknown): string {
  const key = workflowIdentifier(input);
  if (["__proto__", "constructor", "prototype"].includes(key)) workflowError();
  return key;
}
function text(input: unknown, maximum: number): string {
  if (
    typeof input !== "string" ||
    input.includes("\0") ||
    Buffer.byteLength(input) > maximum ||
    Buffer.from(input).toString("utf8") !== input
  )
    workflowError("WORKFLOW_LIMIT");
  return input;
}
function stringArray(input: unknown, maximum: number): string[] {
  if (
    !Array.isArray(input) ||
    input.length > maximum ||
    new Set(input).size !== input.length
  )
    workflowError("WORKFLOW_LIMIT");
  return input.map(workflowIdentifier).sort();
}
export function validateWorkflowSchema(input: unknown): WorkflowSchema {
  input = workflowJson(input);
  let nodes = 0;
  function visit(value: unknown, depth: number): WorkflowSchema {
    if (
      ++nodes > WORKFLOW_LIMITS.schemaNodes ||
      depth > WORKFLOW_LIMITS.schemaDepth
    )
      workflowError("WORKFLOW_LIMIT");
    if (!value || typeof value !== "object" || Array.isArray(value))
      workflowError();
    const kind = (value as Record<string, unknown>).type;
    switch (kind) {
      case "object": {
        const schema = workflowObject(value, [
          "type",
          "properties",
          "required",
          "additionalProperties",
        ]);
        if (
          schema.additionalProperties !== false ||
          !schema.properties ||
          typeof schema.properties !== "object" ||
          Array.isArray(schema.properties)
        )
          workflowError();
        const entries = Object.entries(schema.properties);
        if (entries.length > WORKFLOW_LIMITS.properties)
          workflowError("WORKFLOW_LIMIT");
        const properties: Record<string, WorkflowSchema> = {};
        for (const [key, child] of entries.sort(([a], [b]) =>
          a.localeCompare(b, "en"),
        ))
          properties[field(key)] = visit(child, depth + 1);
        const required = stringArray(
          schema.required,
          WORKFLOW_LIMITS.properties,
        );
        if (required.some((key) => !Object.hasOwn(properties, key)))
          workflowError();
        return {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        };
      }
      case "array": {
        const schema = workflowObject(
          value,
          ["type", "items", "maxItems"],
          ["minItems"],
        );
        const maxItems = workflowInteger(
            schema.maxItems,
            WORKFLOW_LIMITS.arrayItems,
          ),
          minItems =
            schema.minItems === undefined
              ? 0
              : workflowInteger(schema.minItems, maxItems);
        return {
          type: "array",
          items: visit(schema.items, depth + 1),
          maxItems,
          ...(schema.minItems === undefined ? {} : { minItems }),
        };
      }
      case "string": {
        const schema = workflowObject(
          value,
          ["type", "maxLength"],
          ["minLength", "enum"],
        );
        const maxLength = workflowInteger(
            schema.maxLength,
            WORKFLOW_LIMITS.stringLength,
          ),
          minLength =
            schema.minLength === undefined
              ? 0
              : workflowInteger(schema.minLength, maxLength);
        const enumeration = schema.enum;
        if (enumeration !== undefined) {
          if (
            !Array.isArray(enumeration) ||
            enumeration.length < 1 ||
            enumeration.length > WORKFLOW_LIMITS.enumItems ||
            new Set(enumeration).size !== enumeration.length ||
            enumeration.some(
              (item) =>
                typeof item !== "string" ||
                Array.from(item).length < minLength ||
                Array.from(item).length > maxLength,
            )
          )
            workflowError();
        }
        return {
          type: "string",
          maxLength,
          ...(schema.minLength === undefined ? {} : { minLength }),
          ...(enumeration === undefined
            ? {}
            : { enum: enumeration as string[] }),
        };
      }
      case "integer":
      case "number": {
        const schema = workflowObject(
          value,
          ["type"],
          ["minimum", "maximum", "enum"],
        );
        for (const bound of [schema.minimum, schema.maximum])
          if (
            bound !== undefined &&
            (typeof bound !== "number" ||
              !Number.isFinite(bound) ||
              (kind === "integer" && !Number.isSafeInteger(bound)))
          )
            workflowError();
        if (
          schema.minimum !== undefined &&
          schema.maximum !== undefined &&
          Number(schema.minimum) > Number(schema.maximum)
        )
          workflowError();
        const enumeration = schema.enum;
        if (
          enumeration !== undefined &&
          (!Array.isArray(enumeration) ||
            enumeration.length < 1 ||
            enumeration.length > WORKFLOW_LIMITS.enumItems ||
            new Set(enumeration).size !== enumeration.length ||
            enumeration.some(
              (item) =>
                typeof item !== "number" ||
                !Number.isFinite(item) ||
                (kind === "integer" && !Number.isSafeInteger(item)) ||
                (schema.minimum !== undefined &&
                  item < Number(schema.minimum)) ||
                (schema.maximum !== undefined && item > Number(schema.maximum)),
            ))
        )
          workflowError();
        return {
          type: kind,
          ...(schema.minimum === undefined
            ? {}
            : { minimum: Number(schema.minimum) }),
          ...(schema.maximum === undefined
            ? {}
            : { maximum: Number(schema.maximum) }),
          ...(enumeration === undefined
            ? {}
            : { enum: enumeration as number[] }),
        };
      }
      case "boolean": {
        const schema = workflowObject(value, ["type"], ["enum"]),
          enumeration = schema.enum;
        if (
          enumeration !== undefined &&
          (!Array.isArray(enumeration) ||
            enumeration.length < 1 ||
            enumeration.length > 2 ||
            new Set(enumeration).size !== enumeration.length ||
            enumeration.some((item) => typeof item !== "boolean"))
        )
          workflowError();
        return {
          type: "boolean",
          ...(enumeration === undefined
            ? {}
            : { enum: enumeration as boolean[] }),
        };
      }
      case "null":
        workflowObject(value, ["type"]);
        return { type: "null" };
      default:
        return workflowError();
    }
  }
  return workflowJson(visit(input, 0));
}
export function validateWorkflowObjectSchema(
  input: unknown,
): WorkflowObjectSchema {
  const schema = validateWorkflowSchema(input);
  if (schema.type !== "object") workflowError();
  return schema;
}
export function validateWorkflowValue(
  schemaInput: WorkflowSchema,
  input: unknown,
): JsonValue {
  const schema = validateWorkflowSchema(schemaInput),
    value = workflowJson(input);
  function visit(current: WorkflowSchema, value: unknown): void {
    switch (current.type) {
      case "object": {
        if (!value || typeof value !== "object" || Array.isArray(value))
          workflowError("WORKFLOW_SCHEMA_MISMATCH");
        const record = value as Record<string, unknown>;
        if (
          Object.keys(record).some(
            (key) => !Object.hasOwn(current.properties, key),
          ) ||
          current.required.some((key) => !Object.hasOwn(record, key))
        )
          workflowError("WORKFLOW_SCHEMA_MISMATCH");
        for (const [key, child] of Object.entries(current.properties))
          if (Object.hasOwn(record, key)) visit(child, record[key]);
        break;
      }
      case "array":
        if (
          !Array.isArray(value) ||
          value.length < (current.minItems ?? 0) ||
          value.length > current.maxItems
        )
          workflowError("WORKFLOW_SCHEMA_MISMATCH");
        else for (const child of value) visit(current.items, child);
        break;
      case "string":
        if (
          typeof value !== "string" ||
          Array.from(value).length < (current.minLength ?? 0) ||
          Array.from(value).length > current.maxLength ||
          (current.enum !== undefined && !current.enum.includes(value))
        )
          workflowError("WORKFLOW_SCHEMA_MISMATCH");
        break;
      case "integer":
      case "number":
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          (current.type === "integer" && !Number.isSafeInteger(value)) ||
          (current.minimum !== undefined && value < current.minimum) ||
          (current.maximum !== undefined && value > current.maximum) ||
          (current.enum !== undefined && !current.enum.includes(value))
        )
          workflowError("WORKFLOW_SCHEMA_MISMATCH");
        break;
      case "boolean":
        if (
          typeof value !== "boolean" ||
          (current.enum !== undefined && !current.enum.includes(value))
        )
          workflowError("WORKFLOW_SCHEMA_MISMATCH");
        break;
      case "null":
        if (value !== null) workflowError("WORKFLOW_SCHEMA_MISMATCH");
        break;
    }
  }
  visit(schema, value);
  return value as JsonValue;
}
function stage(input: unknown): WorkflowStageSpec {
  const value = workflowObject(input, [
    "id",
    "role",
    "dependsOn",
    "join",
    "prompt",
    "profile",
    "model",
    "tools",
    "allocation",
    "resultSchema",
  ]);
  if (
    !["planner", "editor", "validator", "advisory-reviewer"].includes(
      value.role as string,
    ) ||
    !["all", "any"].includes(value.join as string)
  )
    workflowError();
  const profile =
    value.profile === null
      ? null
      : workflowObject(value.profile, ["id", "revision"]);
  const model = workflowObject(
    value.model,
    ["providerId", "modelId"],
    ["reasoningEffort"],
  );
  if (
    model.reasoningEffort !== undefined &&
    !REASONING_EFFORTS.includes(model.reasoningEffort as never)
  )
    workflowError();
  const allocation = workflowObject(value.allocation, [
    "turns",
    "toolCalls",
    "outputBytes",
    "durationMs",
  ]);
  for (const key of [
    "turns",
    "toolCalls",
    "outputBytes",
    "durationMs",
  ] as const)
    workflowInteger(
      allocation[key],
      key === "durationMs" ? 3600000 : key === "outputBytes" ? 16777216 : 10000,
      1,
    );
  const tools = stringArray(value.tools, WORKFLOW_LIMITS.tools);
  if (
    ["planner", "advisory-reviewer"].includes(value.role as string) &&
    tools.some((name) => !WORKFLOW_READ_TOOLS.includes(name))
  )
    workflowError("WORKFLOW_ROLE_TOOL_MISMATCH");
  return workflowJson({
    id: workflowIdentifier(value.id),
    role: value.role,
    dependsOn: stringArray(value.dependsOn, WORKFLOW_LIMITS.stages),
    join: value.join,
    prompt: text(value.prompt, WORKFLOW_LIMITS.promptBytes),
    profile:
      profile === null
        ? null
        : {
            id: workflowIdentifier(profile.id),
            revision: workflowSha(profile.revision),
          },
    model: {
      providerId: externalIdentifier(model.providerId),
      modelId: externalIdentifier(model.modelId),
      ...(model.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: model.reasoningEffort }),
    },
    tools,
    allocation,
    resultSchema: validateWorkflowObjectSchema(value.resultSchema),
  }) as unknown as WorkflowStageSpec;
}
function topological(
  stages: readonly WorkflowStageSpec[],
): WorkflowStageSpec[] {
  const byId = new Map(stages.map((item) => [item.id, item]));
  if (byId.size !== stages.length) workflowError("WORKFLOW_DUPLICATE_STAGE");
  for (const item of stages)
    if (item.dependsOn.some((id) => !byId.has(id)))
      workflowError("WORKFLOW_UNKNOWN_DEPENDENCY");
  const pending = new Map(
      stages.map((item) => [item.id, new Set(item.dependsOn)]),
    ),
    result: WorkflowStageSpec[] = [],
    depths = new Map<string, number>();
  while (pending.size) {
    const ready = [...pending]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id)
      .sort();
    if (!ready.length) workflowError("WORKFLOW_CYCLE");
    for (const id of ready) {
      const item = byId.get(id)!;
      const depth =
        1 +
        Math.max(
          0,
          ...item.dependsOn.map((dependency) => depths.get(dependency)!),
        );
      if (depth > WORKFLOW_LIMITS.dependencyPath)
        workflowError("WORKFLOW_DEPTH_LIMIT");
      depths.set(id, depth);
      result.push(item);
      pending.delete(id);
      for (const dependencies of pending.values()) dependencies.delete(id);
    }
  }
  return result;
}
/** Canonical stage order and dependency/tool sets make equivalent host registrations stable. */
export function validateWorkflowSpec(input: unknown): WorkflowSpec {
  const value = workflowObject(
    input,
    [
      "schemaVersion",
      "id",
      "description",
      "parameterSchema",
      "resultSchema",
      "stages",
      "resultStageId",
    ],
    ["sha256"],
  );
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.stages) ||
    !value.stages.length ||
    value.stages.length > WORKFLOW_LIMITS.stages
  )
    workflowError("WORKFLOW_LIMIT");
  const stages = topological(value.stages.map(stage)),
    resultStageId = workflowIdentifier(value.resultStageId),
    final = stages.find((item) => item.id === resultStageId);
  if (!final) workflowError("WORKFLOW_UNKNOWN_RESULT_STAGE");
  const resultSchema = validateWorkflowObjectSchema(value.resultSchema);
  if (knowledgeHash(resultSchema) !== knowledgeHash(final.resultSchema))
    workflowError("WORKFLOW_RESULT_SCHEMA_MISMATCH");
  const definition = workflowJson({
    schemaVersion: 1 as const,
    id: workflowIdentifier(value.id),
    description: text(value.description, 4096),
    parameterSchema: validateWorkflowObjectSchema(value.parameterSchema),
    resultSchema,
    stages,
    resultStageId,
  });
  const sha256 = knowledgeHash(definition);
  if (value.sha256 !== undefined && workflowSha(value.sha256) !== sha256)
    workflowError("WORKFLOW_SPEC_STALE");
  return workflowJson({ ...definition, sha256 });
}
export function workflowTopologicalOrder(
  input: WorkflowSpec,
): readonly string[] {
  return validateWorkflowSpec(input).stages.map((item) => item.id);
}
export function validateWorkflowStageResult(
  input: WorkflowSpec,
  stageId: string,
  value: unknown,
): WorkflowStageResult {
  const spec = validateWorkflowSpec(input),
    selected = spec.stages.find(
      (item) => item.id === workflowIdentifier(stageId),
    );
  if (!selected) workflowError("WORKFLOW_UNKNOWN_STAGE");
  const result = {
    stageId: selected.id,
    authority: "advisory-data" as const,
    value: validateWorkflowValue(selected.resultSchema, value) as JsonObject,
  };
  return workflowJson({ ...result, sha256: knowledgeHash(result) });
}
export function readWorkflowResult(
  input: WorkflowSpec,
  results: Readonly<Record<string, JsonObject>>,
): JsonObject {
  const spec = validateWorkflowSpec(input),
    data = workflowJson(results);
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !Object.hasOwn(data, spec.resultStageId)
  )
    workflowError("WORKFLOW_RESULT_MISSING");
  if (
    Object.keys(data).some(
      (id) => !spec.stages.some((stage) => stage.id === id),
    )
  )
    workflowError("WORKFLOW_UNKNOWN_STAGE");
  return validateWorkflowValue(
    spec.resultSchema,
    data[spec.resultStageId],
  ) as JsonObject;
}
