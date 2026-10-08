import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import type { JsonObject, Session, Workspace } from "@moodcode/contracts";
import { createEngine, type EngineOptions } from "../../engine.js";
import { cooperativeGateOrAbort } from "../../test-fixtures/cooperative-gate.js";
import type { ProviderAdapter, ProviderEvent } from "../../ports.js";
import type { WorkflowInstanceRevision } from "../reducer.js";
import type { WorkflowRequestResult, WorkflowSpecRevision } from "../store.js";
import type { WorkflowSpecInput } from "../types.js";
export type WorkflowEngine = ReturnType<typeof createEngine>;
export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function invoke<T>(
  engine: WorkflowEngine,
  name: string,
  ...args: unknown[]
): T {
  const fn = Reflect.get(engine, name);
  assert.equal(
    typeof fn,
    "function",
    `Actual public Engine must expose ${name}`,
  );
  return Reflect.apply(fn, engine, args) as T;
}
export function readDatabase<T>(
  file: string,
  operation: (db: DatabaseSync) => T,
): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return operation(db);
  } finally {
    db.close();
  }
}
export function definition(providerId: string): WorkflowSpecInput {
  const resultSchema = {
    type: "object" as const,
    properties: { observation: { type: "string" as const, maxLength: 128 } },
    required: ["observation"],
    additionalProperties: false as const,
  };
  return {
    schemaVersion: 1,
    id: "archive-readonly",
    description: "Actual original workflow archive and crash boundary",
    parameterSchema: {
      type: "object",
      properties: { question: { type: "string", maxLength: 64 } },
      required: ["question"],
      additionalProperties: false,
    },
    resultSchema,
    resultStageId: "plan",
    stages: [
      {
        id: "plan",
        role: "planner",
        dependsOn: [],
        join: "all",
        prompt: "Observe the original bounded data and return JSON.",
        profile: null,
        model: { providerId, modelId: "fixture" },
        tools: ["read_file"],
        allocation: {
          turns: 2,
          toolCalls: 1,
          outputBytes: 4096,
          durationMs: 10000,
        },
        resultSchema,
      },
    ],
  };
}
export async function workflowArchiveFixture(t: TestContext) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-workflow-audit-")),
    ),
    repository = join(base, "repository"),
    dbPath = join(base, "engine.sqlite"),
    artifactDir = join(base, "artifacts");
  mkdirSync(repository);
  execFileSync("git", ["init", "--quiet", "--template=", repository]);
  writeFileSync(
    join(repository, "seed.txt"),
    "Actual committed workflow source.\n",
  );
  execFileSync("git", ["-C", repository, "add", "seed.txt"]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Workflow source",
  ]);
  const parentEntered = gate(),
    parentRelease = gate(),
    childRelease = gate(),
    children: WorkflowEngine[] = [],
    engines = new Set<WorkflowEngine>();
  let providerEntries = 0;
  const provider: ProviderAdapter = {
    id: "actual-workflow-provider",
    streamTurn(request, signal) {
      providerEntries++;
      const child = request.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.startsWith("[Moodcode workflow stage v1]"),
      );
      const original = (async function* (): AsyncGenerator<ProviderEvent> {
        if (child && request.turnIndex === 0) {
          yield {
            type: "tool.call",
            call: {
              id: "workflow-original-read",
              name: "read_file",
              input: { path: "seed.txt" },
            },
          };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "progress" };
        if (!child) parentEntered.resolve();
        await cooperativeGateOrAbort(
          child ? childRelease.promise : parentRelease.promise,
          signal,
        );
        if (!signal.aborted) {
          if (child)
            yield {
              type: "text.delta",
              delta: JSON.stringify({
                observation: "Read-only original child observation.",
              }),
            };
          yield { type: "finish", reason: "stop" };
        }
      })();
      return {
        [Symbol.asyncIterator]() {
          return {
            next: (value?: unknown) => original.next(value),
            return: (value?: unknown) => original.return(value as never),
          };
        },
      };
    },
  };
  const configuration = {
    dbPath,
    artifactDir,
    workflows: true,
    providers: [provider],
    configureChild(child: WorkflowEngine) {
      children.push(child);
    },
    defaults: {
      providerId: provider.id,
      modelId: "fixture",
      mode: "build" as const,
      limits: {
        maxTurns: 12,
        maxToolCalls: 12,
        maxDurationMs: 30000,
        maxOutputBytes: 65536,
      },
    },
  } as EngineOptions;
  const engine = createEngine(configuration);
  engines.add(engine);
  t.after(async () => {
    parentRelease.resolve();
    childRelease.resolve();
    try {
      for (const current of engines) await current.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  async function command<T>(type: string, payload: JsonObject): Promise<T> {
    const reply = await engine.dispatch({
      schemaVersion: 1,
      commandId: randomUUID(),
      type,
      payload,
    });
    assert.equal(reply.ok, true, JSON.stringify(reply.error));
    return reply.result as unknown as T;
  }
  const workspace = await command<Workspace>("workspace.open", {
      path: repository,
    }),
    session = await command<Session>("session.create", {
      workspaceId: workspace.id,
    }),
    worktree = await engine.createWorktree(
      session.id,
      "workflow-original-worktree",
    );
  async function start() {
    const registered = invoke<WorkflowRequestResult<WorkflowSpecRevision>>(
      engine,
      "registerWorkflow",
      {
        workspaceId: workspace.id,
        requestId: "workflow-original-register",
        expectedRevision: 0,
        spec: definition(provider.id),
      },
    );
    const parent = await command<{ runId: string }>("run.submit", {
      sessionId: session.id,
      requestId: "workflow-original-parent",
      prompt: "Actual original workflow parent",
    });
    await parentEntered.promise;
    const preview = await invoke<Promise<object>>(
      engine,
      "previewWorkflowStart",
      {
        workspaceId: workspace.id,
        rootSessionId: session.id,
        parentRunId: parent.runId,
        workflowId: registered.record.workflowId,
        expectedSpecRevision: registered.record.revision,
        parameters: { question: "Observe exact committed files." },
        stageWorktrees: { plan: worktree.id },
      },
    );
    const created = invoke<WorkflowRequestResult<WorkflowInstanceRevision>>(
      engine,
      "startWorkflow",
      {
        workspaceId: workspace.id,
        requestId: "workflow-original-start",
        approved: true,
        preview,
      },
    );
    return { registered, parent, created };
  }
  function inspect(instanceId: string) {
    return invoke<WorkflowInstanceRevision>(
      engine,
      "inspectWorkflow",
      workspace.id,
      instanceId,
    );
  }
  async function stage(instance: WorkflowInstanceRevision) {
    return invoke<Promise<WorkflowRequestResult<WorkflowInstanceRevision>>>(
      engine,
      "startWorkflowStage",
      {
        workspaceId: workspace.id,
        instanceId: instance.instanceId,
        stageId: "plan",
        requestId: "workflow-original-stage",
        expectedRevision: instance.revision,
        approved: true,
      },
    );
  }
  async function settle(instance: WorkflowInstanceRevision) {
    childRelease.resolve();
    return invoke<Promise<WorkflowRequestResult<WorkflowInstanceRevision>>>(
      engine,
      "observeWorkflowStage",
      {
        workspaceId: workspace.id,
        instanceId: instance.instanceId,
        stageId: "plan",
        requestId: "workflow-original-settle",
        expectedRevision: instance.revision,
      },
    );
  }
  return {
    base,
    repository,
    dbPath,
    artifactDir,
    workspace,
    session,
    worktree,
    engine,
    engines,
    configuration,
    children,
    parentRelease,
    childRelease,
    parentEntered,
    start,
    stage,
    settle,
    inspect,
    providerEntries: () => providerEntries,
  };
}
