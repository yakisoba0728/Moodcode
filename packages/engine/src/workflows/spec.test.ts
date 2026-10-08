import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import { bindWorkflowRecipe, validateWorkflowRecipe } from "./recipes.js";
import {
  readWorkflowResult,
  validateWorkflowSchema,
  validateWorkflowSpec,
  validateWorkflowStageResult,
  validateWorkflowValue,
  workflowTopologicalOrder,
  WORKFLOW_LIMITS,
} from "./spec.js";
import type {
  WorkflowObjectSchema,
  WorkflowRecipeInput,
  WorkflowSchema,
  WorkflowSpecInput,
  WorkflowStageSpec,
} from "./types.js";

const empty: WorkflowObjectSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};
const resultSchema: WorkflowObjectSchema = {
  type: "object",
  properties: { observation: { type: "string", maxLength: 128 } },
  required: ["observation"],
  additionalProperties: false,
};
const parameters: WorkflowObjectSchema = {
  type: "object",
  properties: { question: { type: "string", maxLength: 64 } },
  required: ["question"],
  additionalProperties: false,
};
function stage(id = "plan", dependsOn: string[] = []): WorkflowStageSpec {
  return {
    id,
    role: "planner",
    dependsOn,
    join: "all",
    prompt: "Read the supplied data and return a JSON observation.",
    profile: null,
    model: { providerId: "scripted", modelId: "local" },
    tools: ["read_file"],
    allocation: { turns: 2, toolCalls: 1, outputBytes: 4096, durationMs: 5000 },
    resultSchema,
  };
}
function spec(stages: WorkflowStageSpec[] = [stage()]): WorkflowSpecInput {
  return {
    schemaVersion: 1,
    id: "observe",
    description: "Host-selected bounded advisory workflow",
    parameterSchema: parameters,
    resultSchema,
    stages,
    resultStageId: stages.at(-1)!.id,
  };
}
const code =
  (...expected: string[]) =>
  (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.ok(
      expected.includes(error.code),
      `Expected ${expected.join("|")}, received ${error.code}`,
    );
    return true;
  };

test("host workflow pins preserve explicit null profile, tool-free stages and router model IDs", () => {
  const input = spec([
    {
      ...stage(),
      tools: [],
      model: {
        providerId: "router/provider",
        modelId: "openai/gpt-host",
        reasoningEffort: "ultra",
      },
    },
  ]);
  const validated = validateWorkflowSpec(input);
  assert.equal(validated.stages[0]!.profile, null);
  assert.deepEqual(validated.stages[0]!.tools, []);
  assert.equal(validated.stages[0]!.model.modelId, "openai/gpt-host");
  assert.equal(validated.sha256.length, 64);
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.stages[0]!.model));
});

test("topological ordering and immutable digest remain stable across stage, dependency and tool ordering", () => {
  const left = stage("left"),
    right = stage("right"),
    final = {
      ...stage("final", ["right", "left"]),
      role: "advisory-reviewer" as const,
      tools: ["search_files", "read_file"],
    };
  const first = validateWorkflowSpec({
    ...spec([left, right, final]),
    resultStageId: "final",
  });
  const second = validateWorkflowSpec({
    ...spec([
      {
        ...final,
        dependsOn: ["left", "right"],
        tools: ["read_file", "search_files"],
      },
      right,
      left,
    ]),
    resultStageId: "final",
  });
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(workflowTopologicalOrder(first), ["left", "right", "final"]);
  assert.deepEqual(first.stages[2]!.dependsOn, ["left", "right"]);
});

test("registration digest rejects mutation and model/profile changes describe a separate definition", () => {
  const input = spec(),
    validated = validateWorkflowSpec(input);
  (input.stages[0] as unknown as { prompt: string }).prompt =
    "Changed host intent";
  assert.notEqual(validateWorkflowSpec(input).sha256, validated.sha256);
  assert.throws(
    () =>
      validateWorkflowSpec({
        ...validated,
        description: "Changed after revision pin",
      }),
    code("WORKFLOW_SPEC_STALE"),
  );
  assert.notEqual(
    validateWorkflowSpec(
      spec([
        { ...stage(), model: { providerId: "different", modelId: "local" } },
      ]),
    ).sha256,
    validated.sha256,
  );
  assert.notEqual(
    validateWorkflowSpec(
      spec([
        { ...stage(), profile: { id: "readonly", revision: "a".repeat(64) } },
      ]),
    ).sha256,
    validated.sha256,
  );
  assert.equal(Object.hasOwn(validated, "runId"), false);
  assert.equal(Object.hasOwn(validated, "approval"), false);
});

test("schemas accept the exact bounded subset and preserve nested required fields, enums and numeric constraints", () => {
  const schema: WorkflowObjectSchema = {
    type: "object",
    properties: {
      text: {
        type: "string",
        minLength: 1,
        maxLength: 2,
        enum: ["😀😀", "ok"],
      },
      count: { type: "integer", minimum: 0, maximum: 2, enum: [0, 2] },
      score: { type: "number", minimum: 0, maximum: 1 },
      done: { type: "boolean", enum: [true] },
      nil: { type: "null" },
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: { value: { type: "string", maxLength: 2 } },
          required: ["value"],
          additionalProperties: false,
        },
        minItems: 1,
        maxItems: 2,
      },
    },
    required: ["text", "count", "done", "nil", "rows"],
    additionalProperties: false,
  };
  const valid = {
    text: "😀😀",
    count: 2,
    score: 0.5,
    done: true,
    nil: null,
    rows: [{ value: "x" }],
  };
  assert.deepEqual(validateWorkflowValue(schema, valid), valid);
  for (const invalid of [
    { ...valid, text: "😀😀😀" },
    { ...valid, count: 1 },
    { ...valid, count: "2" },
    { ...valid, score: 2 },
    { ...valid, done: false },
    { ...valid, nil: "null" },
    { ...valid, rows: [] },
    { ...valid, rows: [{ value: "x", grant: true }] },
    { ...valid, extra: "authority" },
  ])
    assert.throws(
      () => validateWorkflowValue(schema, invalid),
      code("WORKFLOW_SCHEMA_MISMATCH"),
    );
});

test("unsupported JSON Schema keywords and permissive object schemas are rejected at every level", () => {
  for (const keyword of [
    "$ref",
    "$defs",
    "oneOf",
    "anyOf",
    "allOf",
    "pattern",
    "format",
    "default",
    "patternProperties",
    "unevaluatedProperties",
  ])
    assert.throws(
      () =>
        validateWorkflowSchema({
          type: "string",
          maxLength: 64,
          [keyword]: keyword === "$ref" ? "#/hidden" : {},
        }),
      code("INVALID_WORKFLOW_SPEC"),
    );
  for (const schema of [
    { type: "object", properties: {}, required: [] },
    { ...empty, additionalProperties: true },
    { ...empty, required: ["missing"] },
    { ...empty, required: ["one", "one"] },
    { type: ["string", "null"], maxLength: 64 },
    { type: "string" },
    { type: "array", items: { type: "boolean" } },
  ])
    assert.throws(
      () => validateWorkflowSchema(schema),
      code("INVALID_WORKFLOW_SPEC", "WORKFLOW_LIMIT"),
    );
});

test("getters, proxies, serializers, prototype fields, sparse data and cycles are never evaluated", () => {
  let traps = 0;
  const getter = {
    ...spec(),
    get stages() {
      traps++;
      return [stage()];
    },
  };
  const proxy = new Proxy(spec(), {
    ownKeys() {
      traps++;
      return [];
    },
    getPrototypeOf() {
      traps++;
      return Object.prototype;
    },
    get() {
      traps++;
      return null;
    },
  });
  const serializer = {
    ...spec(),
    toJSON() {
      traps++;
      return spec();
    },
  };
  const sparse = spec();
  (sparse as unknown as { stages: unknown[] }).stages = new Array(1);
  const cycle: Record<string, unknown> = { ...spec() };
  cycle.stages = cycle;
  for (const malformed of [
    getter,
    proxy,
    serializer,
    sparse,
    cycle,
    Object.assign(Object.create({ authority: true }), spec()),
    JSON.parse('{"__proto__":{"grant":true}}'),
  ])
    assert.throws(
      () => validateWorkflowSpec(malformed),
      code("INVALID_WORKFLOW_SPEC", "WORKFLOW_LIMIT"),
    );
  assert.equal(traps, 0);
  for (const key of ["__proto__", "constructor", "prototype"])
    assert.throws(
      () =>
        validateWorkflowSchema({
          type: "object",
          properties: JSON.parse(`{"${key}":{"type":"boolean"}}`),
          required: [],
          additionalProperties: false,
        }),
      code("INVALID_WORKFLOW_SPEC"),
    );
});

test("unknown, duplicate and cyclic dependencies fail before any workflow can be admitted", () => {
  assert.throws(
    () => validateWorkflowSpec(spec([stage("one"), stage("one")])),
    code("WORKFLOW_DUPLICATE_STAGE"),
  );
  assert.throws(
    () => validateWorkflowSpec(spec([stage("one", ["missing"])])),
    code("WORKFLOW_UNKNOWN_DEPENDENCY"),
  );
  assert.throws(
    () => validateWorkflowSpec(spec([stage("one", ["one"])])),
    code("WORKFLOW_CYCLE"),
  );
  assert.throws(
    () =>
      validateWorkflowSpec(
        spec([stage("one", ["two"]), stage("two", ["one"])]),
      ),
    code("WORKFLOW_CYCLE"),
  );
  assert.throws(
    () =>
      validateWorkflowSpec(spec([stage("one"), stage("two", ["one", "one"])])),
    code("WORKFLOW_LIMIT"),
  );
});

test("workflow dependency depth is a four-stage longest path independent of runtime child nesting depth", () => {
  const four = [
    stage("one"),
    stage("two", ["one"]),
    stage("three", ["two"]),
    stage("four", ["three"]),
  ];
  assert.deepEqual(workflowTopologicalOrder(validateWorkflowSpec(spec(four))), [
    "one",
    "two",
    "three",
    "four",
  ]);
  assert.throws(
    () => validateWorkflowSpec(spec([...four, stage("five", ["four"])])),
    code("WORKFLOW_DEPTH_LIMIT"),
  );
  const eight = Array.from({ length: 8 }, (_, index) =>
    stage(`parallel-${index}`),
  );
  assert.equal(validateWorkflowSpec(spec(eight)).stages.length, 8);
  assert.throws(
    () => validateWorkflowSpec(spec([...eight, stage("overflow")])),
    code("WORKFLOW_LIMIT"),
  );
});

test("schema shape, text, enum, tool and whole definition byte bounds are enforced", () => {
  assert.throws(
    () =>
      validateWorkflowSchema({
        ...empty,
        properties: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [
            `key-${index}`,
            { type: "boolean" },
          ]),
        ),
      }),
    code("WORKFLOW_LIMIT"),
  );
  assert.throws(
    () =>
      validateWorkflowSchema({
        type: "string",
        maxLength: 64,
        enum: Array.from({ length: 17 }, (_, index) => `${index}`),
      }),
    code("INVALID_WORKFLOW_SPEC"),
  );
  assert.throws(
    () =>
      validateWorkflowSchema({
        type: "string",
        maxLength: WORKFLOW_LIMITS.stringLength + 1,
      }),
    code("WORKFLOW_LIMIT"),
  );
  let deeplyNested: WorkflowSchema = { type: "boolean" };
  for (let index = 0; index < 6; index++)
    deeplyNested = { type: "array", maxItems: 1, items: deeplyNested };
  assert.throws(
    () => validateWorkflowSchema(deeplyNested),
    code("WORKFLOW_LIMIT"),
  );
  assert.throws(
    () =>
      validateWorkflowSpec(spec([{ ...stage(), prompt: "x".repeat(32769) }])),
    code("WORKFLOW_LIMIT"),
  );
  const huge = [stage("first"), stage("second")].map((item) => ({
    ...item,
    prompt: "x".repeat(32768),
  }));
  assert.throws(() => validateWorkflowSpec(spec(huge)), code("WORKFLOW_LIMIT"));
  assert.throws(
    () =>
      validateWorkflowSpec(
        spec([
          {
            ...stage(),
            role: "editor",
            tools: Array.from({ length: 65 }, (_, index) => `tool_${index}`),
          },
        ]),
      ),
    code("WORKFLOW_LIMIT"),
  );
});

test("all role specs require explicit pins and advisory roles cannot request effect tools", () => {
  for (const role of [
    "planner",
    "editor",
    "validator",
    "advisory-reviewer",
  ] as const)
    assert.equal(
      validateWorkflowSpec(spec([{ ...stage(), role }])).stages[0]!.role,
      role,
    );
  assert.throws(
    () => validateWorkflowSpec(spec([{ ...stage(), tools: ["apply_patch"] }])),
    code("WORKFLOW_ROLE_TOOL_MISMATCH"),
  );
  assert.throws(
    () =>
      validateWorkflowSpec(
        spec([
          { ...stage(), role: "advisory-reviewer", tools: ["run_command"] },
        ]),
      ),
    code("WORKFLOW_ROLE_TOOL_MISMATCH"),
  );
  assert.equal(
    validateWorkflowSpec(
      spec([{ ...stage(), role: "editor", tools: ["apply_patch"] }]),
    ).stages[0]!.tools[0],
    "apply_patch",
  );
  for (const field of ["profile", "model", "tools", "allocation"] as const) {
    const missing = { ...stage() };
    delete (missing as unknown as Record<string, unknown>)[field];
    assert.throws(
      () => validateWorkflowSpec(spec([missing])),
      code("INVALID_WORKFLOW_SPEC"),
    );
  }
  for (const invalid of [
    { ...stage(), profile: { id: "profile", revision: "fake-revision" } },
    {
      ...stage(),
      model: {
        providerId: "scripted",
        modelId: "local",
        reasoningEffort: "automatic",
      },
    },
    { ...stage(), allocation: { ...stage().allocation, turns: 0 } },
    { ...stage(), tools: ["read_file", "read_file"] },
  ])
    assert.throws(
      () => validateWorkflowSpec(spec([invalid as WorkflowStageSpec])),
      code("INVALID_WORKFLOW_SPEC", "WORKFLOW_LIMIT"),
    );
});

test("selected result stage and its exact object schema must agree with the workflow result contract", () => {
  assert.throws(
    () => validateWorkflowSpec({ ...spec(), resultStageId: "missing" }),
    code("WORKFLOW_UNKNOWN_RESULT_STAGE"),
  );
  assert.throws(
    () => validateWorkflowSpec({ ...spec(), resultSchema: empty }),
    code("WORKFLOW_RESULT_SCHEMA_MISMATCH"),
  );
  assert.throws(
    () =>
      validateWorkflowSpec({
        ...spec(),
        parameterSchema: { type: "string", maxLength: 2 },
      }),
    code("INVALID_WORKFLOW_SPEC"),
  );
  const workflow = validateWorkflowSpec(spec()),
    value = { observation: "Observed files; no effect authority." };
  const result = validateWorkflowStageResult(workflow, "plan", value);
  assert.equal(result.authority, "advisory-data");
  assert.deepEqual(result.value, value);
  const { sha256, ...body } = result;
  assert.equal(sha256, knowledgeHash(body));
  assert.deepEqual(readWorkflowResult(workflow, { plan: value }), value);
  assert.throws(
    () => readWorkflowResult(workflow, {}),
    code("WORKFLOW_RESULT_MISSING"),
  );
  assert.throws(
    () => readWorkflowResult(workflow, { plan: value, invented: value }),
    code("WORKFLOW_UNKNOWN_STAGE"),
  );
  assert.throws(
    () =>
      validateWorkflowStageResult(workflow, "plan", {
        ...value,
        approval: true,
      }),
    code("WORKFLOW_SCHEMA_MISMATCH"),
  );
});

test("admitted parameter and result data reject hidden properties, coercion and invalid UTF-8", () => {
  for (const invalid of [
    { question: 1 },
    {},
    { question: "x", toolNames: ["apply_patch"] },
    { question: "\ud800" },
    { question: "x".repeat(65) },
  ])
    assert.throws(
      () => validateWorkflowValue(parameters, invalid),
      code("WORKFLOW_SCHEMA_MISMATCH", "WORKFLOW_LIMIT"),
    );
  assert.throws(
    () => validateWorkflowValue({ type: "integer" }, Infinity),
    code("INVALID_WORKFLOW_SPEC"),
  );
  assert.throws(
    () =>
      validateWorkflowValue({ type: "integer" }, Number.MAX_SAFE_INTEGER + 1),
    code("WORKFLOW_SCHEMA_MISMATCH"),
  );
});

function recipe(workflow = validateWorkflowSpec(spec())): WorkflowRecipeInput {
  return {
    schemaVersion: 1,
    id: "ask-files",
    description: "Exact pinned parameter binding",
    workflowId: workflow.id,
    workflowSha256: workflow.sha256,
    inputSchema: {
      type: "object",
      properties: { ask: parameters.properties.question! },
      required: ["ask"],
      additionalProperties: false,
    },
    parameterBindings: { question: { source: "input", key: "ask" } },
  };
}
test("recipes bind exact pinned workflow parameters as advisory data without changing execution pins", () => {
  const workflow = validateWorkflowSpec(spec()),
    validated = validateWorkflowRecipe(recipe(workflow), workflow);
  const output = bindWorkflowRecipe(validated, workflow, {
    ask: "Describe current files.",
  });
  assert.deepEqual(output.parameters, { question: "Describe current files." });
  assert.equal(output.authority, "advisory-data");
  assert.equal(output.workflowSha256, workflow.sha256);
  assert.equal(output.parametersSha256, knowledgeHash(output.parameters));
  assert.equal(Object.hasOwn(output, "tools"), false);
  assert.equal(Object.hasOwn(output, "runId"), false);
  assert.equal(Object.hasOwn(output, "approval"), false);
  assert.ok(Object.isFrozen(output.parameters));
  const literal = validateWorkflowRecipe(
    {
      ...recipe(workflow),
      inputSchema: empty,
      parameterBindings: {
        question: { source: "literal", value: "Host pinned question" },
      },
    },
    workflow,
  );
  assert.deepEqual(bindWorkflowRecipe(literal, workflow, {}).parameters, {
    question: "Host pinned question",
  });
});

test("recipes reject unknown sources, missing or extra targets, incompatible input schemas and invalid literals", () => {
  const workflow = validateWorkflowSpec(spec()),
    valid = recipe(workflow);
  for (const parameterBindings of [
    {},
    { question: { source: "input", key: "missing" } },
    { question: { source: "stage-result", stageId: "plan" } },
    {
      question: { source: "input", key: "ask" },
      tools: { source: "literal", value: ["apply_patch"] },
    },
    { question: { source: "literal", value: false } },
  ])
    assert.throws(
      () => validateWorkflowRecipe({ ...valid, parameterBindings }, workflow),
      code("INVALID_WORKFLOW_RECIPE", "WORKFLOW_SCHEMA_MISMATCH"),
    );
  assert.throws(
    () =>
      validateWorkflowRecipe(
        { ...valid, inputSchema: { ...valid.inputSchema, required: [] } },
        workflow,
      ),
    code("WORKFLOW_RECIPE_SCHEMA_MISMATCH"),
  );
  assert.throws(
    () =>
      validateWorkflowRecipe(
        {
          ...valid,
          inputSchema: {
            ...valid.inputSchema,
            properties: { ask: { type: "string", maxLength: 128 } },
          },
        },
        workflow,
      ),
    code("WORKFLOW_RECIPE_SCHEMA_MISMATCH"),
  );
});

test("recipe request and workflow revisions cannot silently change after pinning", () => {
  const workflow = validateWorkflowSpec(spec()),
    validated = validateWorkflowRecipe(recipe(workflow), workflow);
  assert.throws(
    () =>
      validateWorkflowRecipe(
        { ...validated, description: "Changed after approval" },
        workflow,
      ),
    code("WORKFLOW_RECIPE_STALE"),
  );
  assert.throws(
    () =>
      validateWorkflowRecipe(
        { ...recipe(workflow), workflowSha256: "f".repeat(64) },
        workflow,
      ),
    code("WORKFLOW_RECIPE_STALE"),
  );
  const changedWorkflow = validateWorkflowSpec({
    ...spec(),
    description: "New workflow revision",
  });
  assert.throws(
    () => bindWorkflowRecipe(validated, changedWorkflow, { ask: "x" }),
    code("WORKFLOW_RECIPE_STALE"),
  );
  assert.throws(
    () =>
      bindWorkflowRecipe(validated, workflow, {
        ask: "x",
        model: "escalation",
      }),
    code("WORKFLOW_SCHEMA_MISMATCH"),
  );
});

test("recipe optional input bindings preserve parameter optionality and remain descriptor-safe", () => {
  const workflow = validateWorkflowSpec({
    ...spec(),
    parameterSchema: { ...parameters, required: [] },
  });
  const valid = validateWorkflowRecipe(
    {
      ...recipe(workflow),
      inputSchema: { ...recipe(workflow).inputSchema, required: [] },
    },
    workflow,
  );
  assert.deepEqual(bindWorkflowRecipe(valid, workflow, {}).parameters, {});
  let invoked = 0;
  const accessor = {
    get ask() {
      invoked++;
      return "injected";
    },
  };
  assert.throws(
    () => bindWorkflowRecipe(valid, workflow, accessor),
    code("INVALID_WORKFLOW_SPEC"),
  );
  assert.equal(invoked, 0);
});
