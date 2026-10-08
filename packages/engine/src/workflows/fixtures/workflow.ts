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
import type {
  JsonObject,
  RunReceipt,
  Session,
  Workspace,
} from "@moodcode/contracts";
import { createEngine, type EngineOptions } from "../../engine.js";
import type {
  ProviderAdapter,
  ProviderEvent,
  TurnRequest,
} from "../../ports.js";
import type { ChildTaskRecord } from "../../child-tasks/index.js";
import type {
  WorkflowObjectSchema,
  WorkflowSpecInput,
  WorkflowStageSpec,
} from "../types.js";

export type WorkflowEngine = ReturnType<typeof createEngine>;
export function workflowGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitOrAbort(promise: Promise<void>, signal: AbortSignal) {
  let listener!: () => void;
  try {
    await Promise.race([
      promise,
      new Promise<void>((done) => {
        listener = done;
        signal.addEventListener("abort", listener, { once: true });
        if (signal.aborted) done();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}
export async function workflowUntil(
  check: () => boolean,
  detail: string,
  timeout = 10000,
) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < deadline, detail);
    await new Promise<void>((done) => setTimeout(done, 3));
  }
}
export async function workflowCommand<T>(
  engine: WorkflowEngine,
  type: string,
  payload: JsonObject,
): Promise<T> {
  const reply = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type,
    payload,
  });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.result as unknown as T;
}
export function workflowInvoke<T>(
  engine: WorkflowEngine,
  method: string,
  ...args: unknown[]
): T {
  const fn = Reflect.get(engine, method);
  assert.equal(
    typeof fn,
    "function",
    `Actual public Engine must expose ${method}`,
  );
  return Reflect.apply(fn, engine, args) as T;
}
export interface WorkflowFixtureOptions {
  engine?: Partial<EngineOptions>;
  workflows?: boolean;
  worktreeCount?: number;
  childResults?: readonly (JsonObject | string)[];
  profile?: boolean;
  childRead?: boolean;
}
export const workflowParameters: WorkflowObjectSchema = {
  type: "object",
  properties: { question: { type: "string", maxLength: 256 } },
  required: ["question"],
  additionalProperties: false,
};
export const workflowResult: WorkflowObjectSchema = {
  type: "object",
  properties: { observation: { type: "string", maxLength: 2048 } },
  required: ["observation"],
  additionalProperties: false,
};

/** Actual Git, private admitted child engines, original provider iterators and native SQL only. */
export async function workflowFixture(
  t: TestContext,
  options: WorkflowFixtureOptions = {},
) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-workflow-consumer-")),
    ),
    root = join(base, "repository"),
    dbPath = join(base, "engine.sqlite"),
    artifactDir = join(base, "artifacts");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  writeFileSync(join(root, "seed.txt"), "Actual committed workflow source.\n");
  execFileSync("git", ["-C", root, "add", "seed.txt"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Actual workflow baseline",
  ]);
  const parentEntered = workflowGate(),
    parentRelease = workflowGate(),
    children: WorkflowEngine[] = [],
    tasks: ChildTaskRecord[] = [],
    childEntered: ReturnType<typeof workflowGate>[] = [],
    childRelease: ReturnType<typeof workflowGate>[] = [],
    requests: TurnRequest[] = [];
  let returns = 0;
  const provider: ProviderAdapter = {
    id: "actual-workflow-provider",
    streamTurn(request, signal) {
      requests.push(structuredClone(request));
      const parent = request.messages.some(
        (message) =>
          message.role === "user" &&
          message.content === "actual-workflow-parent",
      );
      let index = -1;
      if (!parent) {
        index = children.findIndex((child) => {
          try {
            return child.store.getRun(request.runId).id === request.runId;
          } catch {
            return false;
          }
        });
        assert.ok(
          index >= 0,
          "Provider belongs to an original privately admitted child",
        );
        const task = tasks[index]!;
        assert.equal(
          engine.children.tasks.get(session.id, task.id).state,
          "running",
        );
        assert.equal(
          engine.children.tasks.get(session.id, task.id).childRunId,
          request.runId,
        );
        childEntered[index]!.resolve();
      }
      const original = (async function* (): AsyncGenerator<ProviderEvent> {
        if (parent) {
          parentEntered.resolve();
          yield { type: "progress" };
          await waitOrAbort(parentRelease.promise, signal);
          if (!signal.aborted) yield { type: "finish", reason: "stop" };
          return;
        }
        if (options.childRead && request.turnIndex === 0) {
          yield {
            type: "tool.call",
            call: {
              id: `actual-stage-read-${index}`,
              name: "read_file",
              input: { path: "seed.txt" },
            },
          };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "progress" };
        await waitOrAbort(childRelease[index]!.promise, signal);
        if (!signal.aborted) {
          const result = options.childResults?.[index] ?? {
            observation: `Actual readonly child ${index} completed.`,
          };
          yield {
            type: "text.delta",
            delta: typeof result === "string" ? result : JSON.stringify(result),
          };
          yield { type: "finish", reason: "stop" };
        }
      })();
      return {
        [Symbol.asyncIterator]() {
          return {
            next: (value?: unknown) => original.next(value),
            return: async (value?: unknown) => {
              returns++;
              assert.ok(original.return);
              return original.return(value as never);
            },
          };
        },
      };
    },
  };
  const configuration: EngineOptions = {
    ...options.engine,
    ...({ workflows: options.workflows !== false } as Partial<EngineOptions>),
    dbPath,
    artifactDir,
    providers: [provider],
    agentProfiles: options.profile
      ? [
          {
            id: "actual-workflow-profile",
            description: "Explicit actual readonly workflow profile.",
            instructions: "Workflow results are advisory data.",
            tools: ["read_file", "list_files", "apply_patch"],
          },
        ]
      : [],
    configureChild(child, task) {
      children.push(child);
      tasks.push(structuredClone(task));
      childEntered.push(workflowGate());
      childRelease.push(workflowGate());
      options.engine?.configureChild?.(child, task);
    },
    defaults: {
      providerId: provider.id,
      modelId: "fixture",
      mode: "build",
      limits: {
        maxTurns: 20,
        maxToolCalls: 24,
        maxDurationMs: 60000,
        maxOutputBytes: 262144,
      },
      budgets: {
        turnAllowance: 20,
        maxProviderAttempts: 3,
        retryBaseDelayMs: 0,
      },
    },
  };
  const engine = createEngine(configuration),
    engines = new Set([engine]);
  t.after(async () => {
    parentRelease.resolve();
    for (const release of childRelease) release.resolve();
    try {
      for (const current of engines) await current.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  const workspace = await workflowCommand<Workspace>(engine, "workspace.open", {
      path: root,
    }),
    session = await workflowCommand<Session>(engine, "session.create", {
      workspaceId: workspace.id,
    });
  const worktrees: Awaited<ReturnType<WorkflowEngine["createWorktree"]>>[] = [];
  for (let index = 0; index < (options.worktreeCount ?? 2); index++)
    worktrees.push(
      await engine.createWorktree(
        session.id,
        `actual-workflow-worktree-${index}`,
      ),
    );
  let parent: RunReceipt | undefined;
  async function startParent(config: JsonObject = {}) {
    if (!parent)
      parent = await workflowCommand<RunReceipt>(engine, "run.submit", {
        sessionId: session.id,
        requestId: "actual-workflow-parent-request",
        prompt: "actual-workflow-parent",
        config: {
          ...(options.profile
            ? { agentProfileId: "actual-workflow-profile" }
            : {}),
          ...config,
        },
      });
    await parentEntered.promise;
    return parent;
  }
  async function spec(
    stages: Partial<WorkflowStageSpec>[] = [{ id: "plan" }],
    workflowId = "actual-workflow",
  ): Promise<WorkflowSpecInput> {
    const parent = await startParent(),
      run = engine.store.getRun(parent.runId),
      profile = engine.profiles.forRun(session.id, run.config);
    return {
      schemaVersion: 1,
      id: workflowId,
      description:
        "Actual inherited-model readonly stages, no automatic merge or parent input.",
      parameterSchema: workflowParameters,
      resultSchema: workflowResult,
      stages: stages.map((override, index) => ({
        id: `stage-${index}`,
        role: "planner",
        dependsOn: [],
        join: "all",
        prompt: `Observe current committed files in actual readonly stage ${index}; return the strict JSON result.`,
        profile: profile
          ? { id: profile.id, revision: profile.revision }
          : null,
        model: {
          providerId: run.config.providerId,
          modelId: run.config.modelId,
          ...(run.config.reasoningEffort
            ? { reasoningEffort: run.config.reasoningEffort }
            : {}),
        },
        tools: ["read_file"],
        allocation: {
          turns: 3,
          toolCalls: 2,
          outputBytes: 16384,
          durationMs: 10000,
        },
        resultSchema: workflowResult,
        ...override,
      })),
      resultStageId: stages.at(-1)?.id ?? `stage-${stages.length - 1}`,
    };
  }
  function counts() {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return Object.fromEntries(
        [
          "sessions",
          "runs",
          "inputs",
          "session_inputs",
          "provider_attempts",
          "session_turns",
          "tools",
          "checkpoints",
          "workflow_revisions",
          "workflow_heads",
        ].map((table) => [
          table,
          db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
        ]),
      );
    } finally {
      db.close();
    }
  }
  function stageWorktrees(spec: WorkflowSpecInput) {
    return Object.fromEntries(
      spec.stages.map((stage, index) => {
        assert.ok(worktrees[index]);
        return [stage.id, worktrees[index]!.id];
      }),
    );
  }
  async function waitChild(index = 0) {
    await workflowUntil(
      () => !!childEntered[index],
      `Actual child ${index} was configured`,
    );
    await childEntered[index]!.promise;
    return {
      child: children[index]!,
      task: engine.children.tasks.get(session.id, tasks[index]!.id),
      release: childRelease[index]!,
      worktree: worktrees.find((item) => item.id === tasks[index]!.worktreeId)!,
    };
  }
  return {
    base,
    root,
    dbPath,
    artifactDir,
    configuration,
    engine,
    engines,
    workspace,
    session,
    worktrees,
    parentEntered,
    parentRelease,
    children,
    tasks,
    childEntered,
    childRelease,
    requests,
    startParent,
    spec,
    counts,
    stageWorktrees,
    waitChild,
    getReturns: () => returns,
  };
}
