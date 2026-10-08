import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { WorkflowInstanceRevision } from "../reducer.js";
import { effectsSpecData } from "./effects-data.js";
import { WORKFLOW_MODEL_NAMES } from "../effects.js";
export const EFFECT_BEFORE = "before workflow\n",
  EFFECT_AFTER = "editor-approved change\n";
export const effectHash = (v: string) =>
  createHash("sha256").update(v).digest("hex");
export async function effectsUntil(
  check: () => boolean,
  detail: string,
  timeout = 15000,
) {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, detail);
    await new Promise((r) => setTimeout(r, 5));
  }
}
export async function effectsCommand<T>(
  engine: MoodcodeEngine,
  type: string,
  payload: JsonObject,
): Promise<T> {
  const result = ["session.pause", "session.resume"].includes(type)
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
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.result as unknown as T;
}
function gate() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((yes) => (resolve = yes)),
    resolve: () => resolve(),
  };
}
async function abortable(promise: Promise<void>, signal: AbortSignal) {
  let abort!: () => void;
  try {
    await Promise.race([
      promise,
      new Promise<void>((done) => {
        abort = done;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) done();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
export async function workflowEffectsFixture(
  t: Pick<TestContext, "after">,
  options: {
    failedCheck?: boolean;
    manual?: boolean;
    automaticDelivery?: boolean;
    dbRoot?: string;
  } = {},
) {
  const base =
      options.dbRoot ??
      realpathSync(mkdtempSync(join(tmpdir(), "moodcode-workflow-effects-"))),
    root = join(base, "repository"),
    dbPath = join(base, "engine.sqlite"),
    artifactDir = join(base, "artifacts");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "seed.txt"), EFFECT_BEFORE);
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
    proceed = gate(),
    requests: TurnRequest[] = [],
    children: MoodcodeEngine[] = [],
    events: string[] = [];
  let sourceSession = "";
  let instanceId = "";
  let engine!: MoodcodeEngine;
  const provider: ProviderAdapter = {
    id: "workflow-effects-fixture",
    async *streamTurn(request, signal): AsyncIterable<ProviderEvent> {
      requests.push(structuredClone(request));
      const user =
        request.messages.findLast((m) => m.role === "user")?.content ?? "";
      if (user.startsWith("[Moodcode workflow result DATA v1]")) {
        events.push("parent-input");
        yield {
          type: "text.delta",
          delta: "Parent consumed the verified effect result.",
        };
        yield { type: "finish", reason: "stop" };
        return;
      }
      if (request.sessionId === sourceSession) {
        if (request.turnIndex === 0) {
          entered.resolve();
          yield { type: "progress" };
          await abortable(proceed.promise, signal);
        }
        if (signal.aborted) return;
        if (options.manual) {
          yield { type: "progress" };
          await abortable(new Promise<void>(() => {}), signal);
          return;
        }
        const record = engine.inspectWorkflow(workspace.id, instanceId)!;
        const calls = [
          ["request_workflow_stage", "edit"],
          ["observe_workflow_stage", "edit"],
          ["request_workflow_stage", "validate"],
          ["observe_workflow_stage", "validate"],
          ["merge_workflow_stage", "edit"],
          ["deliver_workflow_result", ""],
        ];
        const call =
          options.automaticDelivery === false && request.turnIndex >= 5
            ? undefined
            : calls[request.turnIndex];
        if (call) {
          events.push(call[0]!);
          yield {
            type: "tool.call",
            call: {
              id: `actual-parent-stage-${request.turnIndex}`,
              name: call[0]!,
              input: {
                requestId: `model-${request.turnIndex}`,
                ...(call[1]
                  ? { stageId: call[1], expectedRevision: record.revision }
                  : {}),
              },
            },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "text.delta", delta: "Workflow effects settled." };
          yield { type: "finish", reason: "stop" };
        }
        return;
      }
      const validator = user.includes("ACTUAL_VALIDATOR");
      const child = children.find((c) => {
        try {
          return c.store.getRun(request.runId).id === request.runId;
        } catch {
          return false;
        }
      });
      assert.ok(child, "original private child Engine");
      if (request.turnIndex === 0) {
        yield {
          type: "tool.call",
          call: {
            id: validator ? "actual-validator-check" : "actual-editor-patch",
            name: validator ? "verify_changes" : "apply_patch",
            input: validator
              ? { checkId: "actual-required-check" }
              : {
                  changes: [
                    {
                      path: "seed.txt",
                      expectedHash: effectHash(EFFECT_BEFORE),
                      content: EFFECT_AFTER,
                    },
                  ],
                },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield {
          type: "text.delta",
          delta: JSON.stringify({
            observation: validator
              ? "native verification completed"
              : "isolated editor effect completed",
          }),
        };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  const config = {
    providerId: provider.id,
    modelId: "fixture",
    mode: "build" as const,
    agentProfileId: "actual-workflow-effects",
    limits: {
      maxTurns: 32,
      maxToolCalls: 32,
      maxDurationMs: 60000,
      toolTimeoutMs: 8000,
      maxOutputBytes: 524288,
      maxContextBytes: 262144,
    },
    budgets: {
      turnAllowance: 32,
      maxProviderAttempts: 16,
      maxToolCallsPerTurn: 8,
      maxPendingInputs: 16,
      maxPendingBytes: 524288,
      maxArtifactBytes: 1048576,
      maxProducerBytes: 2097152,
      providerRequestTimeoutMs: 60000,
      providerInactivityTimeoutMs: 30000,
    },
  };
  const configuration = {
    dbPath,
    artifactDir,
    providers: [provider],
    workflows: true,
    verificationTools: true,
    agentProfiles: [
      {
        id: "actual-workflow-effects",
        description: "Actual bounded workflow effects.",
        instructions:
          "Only registered workflow stages. All effects require approval.",
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
  t.after(async () => {
    proceed.resolve();
    await engine.close();
    if (!options.dbRoot) rmSync(base, { recursive: true, force: true });
  });
  const workspace = await effectsCommand<Workspace>(engine, "workspace.open", {
      path: root,
    }),
    session = await effectsCommand<Session>(engine, "session.create", {
      workspaceId: workspace.id,
      title: "Actual workflow effects",
    });
  sourceSession = session.id;
  const worktree = await engine.createWorktree(
    session.id,
    "workflow-effect-worktree",
  );
  const profile = engine.profiles
    .list()
    .find((p) => p.id === "actual-workflow-effects")!;
  const command = `'${process.execPath.replaceAll("'", "'\\''")}' -e 'require("node:assert/strict").equal(require("node:fs").readFileSync("seed.txt","utf8"),${JSON.stringify(EFFECT_AFTER)});${options.failedCheck ? "process.exit(7)" : 'console.log("actual check passed")'}'`;
  engine.registerVerificationCheck({
    id: "actual-required-check",
    revision: 1,
    workspaceId: workspace.id,
    command,
    cwd: root,
    profileId: profile.id,
    profileRevision: profile.revision,
    sourceRevision: "bounded-selected-files-v1",
    timeoutMs: 3000,
    maxOutputBytes: 16384,
    required: true,
  });
  const parent = await effectsCommand<RunReceipt>(engine, "run.submit", {
    sessionId: session.id,
    requestId: "actual-source-parent",
    prompt: "ACTUAL_ROOT",
    config: { agentProfileId: profile.id },
  });
  await entered.promise;
  const run = engine.store.getRun(parent.runId);
  const spec = effectsSpecData({
    profileId: profile.id,
    profileRevision: profile.revision,
    providerId: run.config.providerId,
    modelId: run.config.modelId,
  });
  const registered = engine.registerWorkflow({
      workspaceId: workspace.id,
      requestId: "register-effect-workflow",
      expectedRevision: 0,
      spec,
    }),
    preview = await engine.previewWorkflowStart({
      workspaceId: workspace.id,
      rootSessionId: session.id,
      parentRunId: parent.runId,
      workflowId: spec.id,
      expectedSpecRevision: registered.record.revision,
      parameters: {},
      stageWorktrees: { edit: worktree.id, validate: worktree.id },
    }),
    started = engine.startWorkflow({
      workspaceId: workspace.id,
      requestId: "start-effect-workflow",
      approved: true,
      preview,
    });
  instanceId = started.record.instanceId;
  const binding = engine.bindWorkflowModelTools({
    workspaceId: workspace.id,
    instanceId,
  });
  const record = () => engine.inspectWorkflow(workspace.id, instanceId)!;
  async function pendingParent(name: string) {
    await effectsUntil(
      () =>
        engine.store
          .getSnapshot(session.id)
          .approvals.some((a) => a.status === "pending" && a.toolName === name),
      `No parent approval ${name}: ${JSON.stringify(engine.store.getRun(parent.runId))}`,
    );
    return engine.store
      .getSnapshot(session.id)
      .approvals.find((a) => a.status === "pending" && a.toolName === name)!;
  }
  async function approveParent(
    name: string,
    decision: "allow" | "deny" = "allow",
  ) {
    const a = await pendingParent(name);
    engine.approvals.decide(a.id, decision, a.fingerprint);
    return a;
  }
  async function approveChild(
    name: string,
    decision: "allow" | "deny" = "allow",
  ) {
    let selected:
      | {
          task: string;
          approval: ReturnType<MoodcodeEngine["children"]["approvals"]>[number];
        }
      | undefined;
    await effectsUntil(
      () => {
        for (const task of engine.children.tasks.list(session.id)) {
          const a = engine.children
            .approvals(session.id, task.id)
            .find((a) => a.status === "pending" && a.toolName === name);
          if (a) {
            selected = { task: task.id, approval: a };
            return true;
          }
        }
        return false;
      },
      `No child approval ${name}: ${JSON.stringify(engine.children.tasks.list(session.id))}`,
    );
    const s = selected!;
    engine.children.decide(
      session.id,
      s.task,
      s.approval.id,
      s.approval.fingerprint,
      decision,
    );
    return s.approval;
  }
  async function throughValidation() {
    proceed.resolve();
    await approveParent("request_workflow_stage");
    await approveChild("apply_patch");
    await approveParent("request_workflow_stage");
    await approveChild("verify_changes");
    if (options.failedCheck)
      await effectsUntil(
        () => isTerminal(engine.store.getRun(parent.runId).state),
        "Rejected validator source did not stop",
      );
    else
      await effectsUntil(
        () =>
          record().stages.find((s) => s.stageId === "validate")!.state !==
            "running" &&
          record().stages.find((s) => s.stageId === "validate")!.state !==
            "dispatching",
        "Validator did not join",
      );
    return record();
  }
  async function throughMerge() {
    await throughValidation();
    await approveParent("merge_workflow_stage");
    await effectsUntil(() => {
      try {
        return (
          engine.inspectWorkflowEffect(workspace.id, instanceId, "edit")
            ?.state === "merged"
        );
      } catch {
        return false;
      }
    }, "Merge receipt did not settle");
    if (options.automaticDelivery === false)
      await effectsUntil(() => sourceTerminal(), "Source parent did not stop");
  }
  const sourceTerminal = () =>
    isTerminal(engine.store.getRun(parent.runId).state);
  return {
    base,
    root,
    dbPath,
    artifactDir,
    configuration,
    engine,
    workspace,
    session,
    parent,
    worktree,
    children,
    requests,
    events,
    record,
    spec,
    binding,
    proceed,
    pendingParent,
    approveParent,
    approveChild,
    throughValidation,
    throughMerge,
    sourceBytes: () => readFileSync(join(root, "seed.txt"), "utf8"),
    childBytes: () => readFileSync(join(worktree.root, "seed.txt"), "utf8"),
    sourceTerminal,
  };
}
