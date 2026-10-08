import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import {
  isTerminal,
  type JsonObject,
  type Workspace,
  type Session,
  type RunReceipt,
} from "@moodcode/contracts";
import { MoodcodeEngine } from "../../engine.js";
import type {
  ProviderAdapter,
  ProviderEvent,
  TurnRequest,
} from "../../ports.js";
import { WORKFLOW_MODEL_NAMES } from "../../workflows/effects.js";
import type { CodingBatchInput } from "../types.js";
export const BEFORE = "batch baseline\n";
export const batchHash = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export async function batchCommand<T>(
  engine: MoodcodeEngine,
  type: string,
  payload: JsonObject,
): Promise<T> {
  const r = ["session.pause", "session.resume"].includes(type)
    ? await engine.dispatchSession({
        schemaVersion: 2,
        commandId: randomUUID(),
        type,
        payload,
      })
    : await engine.dispatch({
        schemaVersion: 1,
        commandId: randomUUID(),
        type,
        payload,
      });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  return r.result as T;
}
export async function batchUntil(
  check: () => boolean,
  detail: string,
  ms = 20000,
) {
  const end = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < end, detail);
    await new Promise((r) => setTimeout(r, 5));
  }
}
function gate() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((r) => (resolve = r)),
    resolve: () => resolve(),
  };
}
async function wait(p: Promise<void>, signal: AbortSignal) {
  let abort!: () => void;
  try {
    await Promise.race([
      p,
      new Promise<void>((r) => {
        abort = r;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) r();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
export async function batchFixture(
  t: Pick<TestContext, "after">,
  options: {
    failedCase?: string;
    dbRoot?: string;
    holdChild?: boolean;
    unknownCleanup?: boolean;
    unknownUsage?: boolean;
    codingBatches?: boolean;
  } = {},
) {
  const base =
      options.dbRoot ??
      realpathSync(mkdtempSync(join(tmpdir(), "moodcode-coding-batch-"))),
    root = join(base, "repository");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "seed.txt"), BEFORE);
  writeFileSync(join(root, "unrelated.txt"), "unchanged\n");
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--quiet",
    "-m",
    "baseline",
  ]);
  const entered = gate(),
    merge = gate(),
    childRelease = gate(),
    requests: TurnRequest[] = [],
    children: MoodcodeEngine[] = [];
  let sourceSession = "",
    selectedInstance = "",
    engine!: MoodcodeEngine;
  const provider: ProviderAdapter = {
    id: "coding-batch-fixture",
    async *streamTurn(request, signal): AsyncIterable<ProviderEvent> {
      requests.push(structuredClone(request));
      if (options.unknownUsage) yield { type: "usage" };
      else yield { type: "usage", inputTokens: 30, outputTokens: 20 };
      const user =
        request.messages.findLast((m) => m.role === "user")?.content ?? "";
      if (user.startsWith("[Moodcode workflow result DATA v1]")) {
        yield {
          type: "text.delta",
          delta: "Actual selected batch result consumed.",
        };
        yield { type: "finish", reason: "stop" };
        return;
      }
      if (request.sessionId === sourceSession) {
        if (request.turnIndex === 0) {
          entered.resolve();
          yield { type: "progress" };
          await wait(merge.promise, signal);
          if (signal.aborted) return;
          const record = engine.inspectWorkflow(
            workspace.id,
            selectedInstance,
          )!;
          yield {
            type: "tool.call",
            call: {
              id: "actual-batch-selected-merge",
              name: "merge_workflow_stage",
              input: {
                stageId: "edit",
                requestId: "batch-merge",
                expectedRevision: record.revision,
              },
            },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "text.delta", delta: "Actual batch selection merged." };
          yield { type: "finish", reason: "stop" };
        }
        return;
      }
      const match = user.match(/BATCH_(EDITOR|VALIDATOR|REVIEWER) ([AB])/);
      assert.ok(match, user);
      const role = match[1],
        id = match[2]!;
      if (options.holdChild && role === "EDITOR" && request.turnIndex === 0) {
        yield { type: "progress" };
        if (options.unknownCleanup) await childRelease.promise;
        else await wait(childRelease.promise, signal);
        if (signal.aborted) return;
      }
      if (role === "REVIEWER") {
        yield {
          type: "text.delta",
          delta: JSON.stringify({
            observation: `Native check for ${id} reviewed; advisory only.`,
            score: id === "A" ? 90 : 80,
          }),
        };
        yield { type: "finish", reason: "stop" };
        return;
      }
      if (request.turnIndex === 0) {
        yield {
          type: "tool.call",
          call: {
            id: `actual-${role}-${id}`,
            name: role === "EDITOR" ? "apply_patch" : "verify_changes",
            input:
              role === "EDITOR"
                ? {
                    changes: [
                      {
                        path: "seed.txt",
                        expectedHash: batchHash(BEFORE),
                        content: `candidate ${id}\n`,
                      },
                    ],
                  }
                : { checkId: `batch-check-${id}` },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield {
          type: "text.delta",
          delta: JSON.stringify({ observation: `Actual ${role} ${id}.` }),
        };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  if (options.unknownCleanup) {
    const stream = provider.streamTurn.bind(provider);
    provider.streamTurn = (request, signal) => {
      const iterator = stream(request, signal)[Symbol.asyncIterator]();
      if (request.sessionId === sourceSession)
        return { [Symbol.asyncIterator]: () => iterator };
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => iterator.next(),
          return: async () => ({
            done: false as const,
            value: { type: "progress" as const },
          }),
        }),
      };
    };
  }
  const config = {
    providerId: provider.id,
    modelId: "fixture",
    mode: "build" as const,
    agentProfileId: "actual-coding-batch",
    limits: {
      maxTurns: 64,
      maxToolCalls: 64,
      maxDurationMs: 180000,
      toolTimeoutMs: 10000,
      maxOutputBytes: 1048576,
      maxContextBytes: 65536,
    },
    budgets: {
      turnAllowance: 64,
      maxProviderAttempts: 16,
      maxToolCallsPerTurn: 8,
      maxPendingInputs: 16,
      maxPendingBytes: 524288,
      maxArtifactBytes: 1048576,
      maxProducerBytes: 2097152,
      providerRequestTimeoutMs: 180000,
      providerInactivityTimeoutMs: 60000,
    },
  };
  const configuration = {
    dbPath: join(base, "engine.sqlite"),
    artifactDir: join(base, "artifacts"),
    providers: [provider],
    workflows: true,
    codingBatches: options.codingBatches !== false,
    verificationTools: true,
    agentProfiles: [
      {
        id: "actual-coding-batch",
        description: "Actual isolated native coding batch.",
        instructions: "Effects always require native approval; review is DATA.",
        tools: [
          ...WORKFLOW_MODEL_NAMES,
          "read_file",
          "apply_patch",
          "run_command",
          "verify_changes",
          "merge_child_changes",
        ],
      },
    ],
    configureChild: (child: MoodcodeEngine) => {
      children.push(child);
    },
    defaults: config,
  };
  engine = new MoodcodeEngine(configuration);
  const workspace = await batchCommand<Workspace>(engine, "workspace.open", {
      path: root,
    }),
    session = await batchCommand<Session>(engine, "session.create", {
      workspaceId: workspace.id,
      title: "Actual coding batch",
    });
  sourceSession = session.id;
  const worktrees: Awaited<ReturnType<MoodcodeEngine["createWorktree"]>>[] = [];
  for (const id of ["A-edit", "A-review", "B-edit", "B-review"])
    worktrees.push(await engine.createWorktree(session.id, `batch-${id}`));
  const profile = engine.profiles
    .list()
    .find((p) => p.id === "actual-coding-batch")!;
  for (const id of ["A", "B"])
    engine.registerVerificationCheck({
      id: `batch-check-${id}`,
      revision: 1,
      workspaceId: workspace.id,
      command: `'${process.execPath.replaceAll("'", "'\\''")}' -e 'require("node:assert/strict").equal(require("node:fs").readFileSync("seed.txt","utf8"),${JSON.stringify(`candidate ${id}\n`)});${options.failedCase === id ? "process.exit(7)" : 'console.log("actual verified")'}'`,
      cwd: root,
      profileId: profile.id,
      profileRevision: profile.revision,
      sourceRevision: "bounded-selected-files-v1",
      timeoutMs: 3000,
      maxOutputBytes: 16384,
      required: true,
    });
  const parent = await batchCommand<RunReceipt>(engine, "run.submit", {
    sessionId: session.id,
    requestId: "actual-batch-parent",
    prompt: "ACTUAL_BATCH_ROOT",
    config: { agentProfileId: profile.id },
  });
  await entered.promise;
  const run = engine.store.getRun(parent.runId),
    resultSchema = {
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
      profile: { id: profile.id, revision: profile.revision },
      model: { providerId: provider.id, modelId: "fixture" },
      allocation: {
        turns: 3,
        toolCalls: 2,
        outputBytes: 16384,
        durationMs: 10000,
      },
      join: "all" as const,
    };
  const input: CodingBatchInput = {
    workspaceId: workspace.id,
    rootSessionId: session.id,
    parentRunId: parent.runId,
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
        edit: worktrees[i * 2]!.id,
        validate: worktrees[i * 2]!.id,
        review: worktrees[i * 2 + 1]!.id,
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
  let pump: ReturnType<typeof setInterval> | undefined;
  const approveChildren = () => {
    pump = setInterval(() => {
      for (const child of children) {
        try {
          for (const w of child.store.listWorkspaces())
            for (const s of child.store.listSessions(w.id))
              for (const a of child.store
                .getSnapshot(s.id)
                .approvals.filter((a) => a.status === "pending"))
                child.approvals.decide(a.id, "allow", a.fingerprint);
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "STORE_CLOSED"
          ))
            throw error;
        }
      }
    }, 5);
  };
  t.after(async () => {
    clearInterval(pump);
    merge.resolve();
    childRelease.resolve();
    await engine.close().catch((e) => {
      if (!options.unknownCleanup) throw e;
      assert.ok(
        e instanceof Error &&
          "code" in e &&
          ["CLEANUP_UNCERTAIN", "CLEANUP_PENDING"].includes(String(e.code)),
        String(e),
      );
    });
    if (!options.dbRoot) rmSync(base, { recursive: true, force: true });
  });
  return {
    engine,
    base,
    root,
    dbPath: configuration.dbPath,
    artifactDir: configuration.artifactDir,
    workspace,
    session,
    parent,
    run,
    config,
    configuration,
    input,
    worktrees,
    profile,
    children,
    requests,
    approveChildren,
    releaseChildren: childRelease.resolve,
    releaseParent: (instanceId: string) => {
      selectedInstance = instanceId;
      merge.resolve();
    },
    async approveMerge(decision: "allow" | "deny" = "allow") {
      await batchUntil(
        () =>
          engine.store
            .getSnapshot(session.id)
            .approvals.some(
              (a) =>
                a.status === "pending" && a.toolName === "merge_workflow_stage",
            ),
        "real native merge approval",
      );
      const a = engine.store
        .getSnapshot(session.id)
        .approvals.find(
          (a) =>
            a.status === "pending" && a.toolName === "merge_workflow_stage",
        )!;
      return engine.approvals.decide(a.id, decision, a.fingerprint);
    },
    async finish() {
      await batchUntil(
        () => isTerminal(engine.store.getRun(parent.runId).state),
        "actual parent terminal",
      );
      return engine.store.getRun(parent.runId);
    },
  };
}
