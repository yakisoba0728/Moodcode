import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  EngineError,
  type ApprovalRecord,
  type ToolCallRecord,
} from "@moodcode/contracts";
import type { ProviderAdapter, ToolContext } from "../ports.js";
import {
  ActualModelTurns,
  modelToolsFixture,
  untilModelTools,
} from "../teams/fixtures/model-tools.js";
import { WORKFLOW_MODEL_NAMES } from "../workflows/effects.js";
import { workflowResult } from "../workflows/fixtures/workflow.js";

type Lane = "team" | "workflow";
type Phase = "prepare" | "execute";
interface CapturedExecution {
  owner: {
    run: { id: string };
    terminal: boolean;
    activeTools: Map<string, ToolCallRecord>;
    turn: { id: string; attempt: { id: string } };
  };
  record: ToolCallRecord;
  approval?: { id: string; fingerprint: string };
}
interface Scenario {
  name: string;
  phase?: Phase;
  bindingError?: boolean;
}

const shared: Scenario[] = [
  { name: "unsupported-name" },
  { name: "replaced-owner" },
  { name: "terminal-owner" },
  { name: "replaced-active-tool" },
  { name: "native-turn-drift", phase: "prepare" },
  { name: "native-attempt-drift" },
  { name: "replaced-original-signal" },
  { name: "replaced-native-approval" },
];
const workflowGaps: Scenario[] = [
  { name: "copied-original" },
  { name: "original-context-proxy" },
  { name: "original-workspace-proxy", bindingError: true },
  { name: "original-signal-accessor", bindingError: true },
  { name: "wrong-phase" },
  { name: "inactive-original-prepare" },
];

function counts(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(
      [
        "team_messages",
        "team_mailbox_cursors",
        "team_operation_receipts",
        "team_deliveries",
        "workflow_revisions",
        "workflow_heads",
        "checkpoints",
      ].map((table) => [
        table,
        Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),
      ]),
    );
  } finally {
    db.close();
  }
}

function replace(target: object, key: string, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
  assert.ok(descriptor && Object.hasOwn(descriptor, "value"));
  Object.defineProperty(target, key, { ...descriptor, value });
  return () => Object.defineProperty(target, key, descriptor);
}

for (const lane of ["team", "workflow"] as const) {
  test(
    `actual ${lane} tool rejects changed Original ownership before native effects and retains a positive control`,
    { timeout: 30000 },
    async (t) => {
      const childTurns = new ActualModelTurns();
      let childDispatches = 0;
      const f = await modelToolsFixture(t, {
          engine: {
            workflows: true,
            configureChild(child) {
              const providers = Reflect.get(child, "runtimeProviders") as Map<
                string,
                ProviderAdapter
              >;
              providers.set("actual-model-team-provider", {
                id: "actual-model-team-provider",
                streamTurn(request, signal) {
                  childDispatches++;
                  return childTurns.stream(request, signal);
                },
              });
            },
          },
          allowedTools: [
            "send_agent_message",
            "read_file",
            ...WORKFLOW_MODEL_NAMES,
          ],
        }),
        worktree =
          lane === "workflow"
            ? await f.engine.createWorktree(
                f.session.id,
                "original-workflow-owner",
              )
            : undefined,
        parent = await f.startParent(),
        coordinator = f.engine.coordinator,
        method =
          lane === "team"
            ? "assertTeamToolContext"
            : "assertWorkflowToolContext",
        original = coordinator[method].bind(coordinator),
        nativeCatalogue = coordinator.captureToolCatalogue.bind(coordinator),
        captures = Reflect.get(coordinator, "teamToolContexts") as WeakMap<
          ToolContext,
          CapturedExecution
        >,
        owners = Reflect.get(coordinator, "owners") as Map<string, object>;
      t.after(() => childTurns.stop());
      let instanceId = "";
      if (lane === "team") {
        const team = f.createTeam(),
          actor = f.join(team.id, "coordinator");
        f.join(team.id, "target", "worker");
        f.engine.bindTeamModelTools({
          rootSessionId: f.session.id,
          teamId: team.id,
          memberId: actor.memberId,
          generation: actor.generation,
          recipientAliases: ["target"],
        });
      } else {
        const run = f.engine.store.getRun(parent.runId),
          profile = f.engine.profiles
            .list()
            .find((profile) => profile.id === "model-team-owner")!,
          registered = f.engine.registerWorkflow({
            workspaceId: f.workspace.id,
            requestId: "register-original-workflow-owner",
            expectedRevision: 0,
            spec: {
              schemaVersion: 1,
              id: "original-workflow-owner",
              description: "Actual readonly native context proof.",
              parameterSchema: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false,
              },
              resultSchema: workflowResult,
              stages: [
                {
                  id: "plan",
                  role: "planner",
                  dependsOn: [],
                  join: "all",
                  prompt: "Observe current committed files as readonly data.",
                  profile: { id: profile.id, revision: profile.revision },
                  model: {
                    providerId: run.config.providerId,
                    modelId: run.config.modelId,
                  },
                  tools: ["read_file"],
                  allocation: {
                    turns: 3,
                    toolCalls: 2,
                    outputBytes: 16384,
                    durationMs: 10000,
                  },
                  resultSchema: workflowResult,
                },
              ],
              resultStageId: "plan",
            },
          }),
          preview = await f.engine.previewWorkflowStart({
            workspaceId: f.workspace.id,
            rootSessionId: f.session.id,
            parentRunId: parent.runId,
            workflowId: registered.record.workflowId,
            expectedSpecRevision: registered.record.revision,
            parameters: {},
            stageWorktrees: { plan: worktree!.id },
          });
        instanceId = f.engine.startWorkflow({
          workspaceId: f.workspace.id,
          requestId: "start-original-workflow-owner",
          approved: true,
          preview,
        }).record.instanceId;
        f.engine.bindWorkflowModelTools({
          workspaceId: f.workspace.id,
          instanceId,
        });
      }

      let scenario: Scenario | undefined,
        prepareContext: ToolContext | undefined,
        injections = 0,
        catalogueReads = 0,
        traps = 0;
      coordinator.captureToolCatalogue = (context) => {
        catalogueReads++;
        return nativeCatalogue(context);
      };
      coordinator[method] = (context, phase) => {
        if (phase === "prepare") prepareContext = context;
        if (!scenario || phase !== (scenario.phase ?? "execute"))
          return original(context, phase);
        const capture = captures.get(context)!;
        assert.ok(capture, "The actual Tool operation owns this exact context");
        assert.equal(context.runId, parent.runId);
        assert.equal(
          f.engine.store.getTurn(context.turnId!).runId,
          parent.runId,
        );
        assert.equal(
          f.engine.store.getAttempt(context.attemptId!).turnId,
          context.turnId,
        );
        injections++;
        const restores: (() => void)[] = [];
        let selected = context,
          selectedPhase = phase;
        const trap = () => {
          traps++;
          throw new Error("Original owner trap must not execute");
        };
        const reads = catalogueReads;
        try {
          switch (scenario.name) {
            case "unsupported-name":
              restores.push(
                replace(capture.record, "name", "unsupported-original-tool"),
                replace(
                  capture.owner,
                  "run",
                  new Proxy(capture.owner.run, { get: trap }),
                ),
              );
              break;
            case "replaced-owner":
              owners.set(parent.runId, {});
              restores.push(() => {
                owners.set(parent.runId, capture.owner);
              });
              break;
            case "terminal-owner":
              restores.push(replace(capture.owner, "terminal", true));
              break;
            case "replaced-active-tool":
              capture.owner.activeTools.set(capture.record.id, {
                ...capture.record,
              });
              restores.push(() => {
                capture.owner.activeTools.set(
                  capture.record.id,
                  capture.record,
                );
              });
              break;
            case "native-turn-drift":
              restores.push(
                replace(capture.owner.turn, "id", "replaced-native-turn"),
              );
              break;
            case "native-attempt-drift":
              restores.push(
                replace(
                  capture.owner.turn.attempt,
                  "id",
                  "replaced-native-attempt",
                ),
              );
              break;
            case "replaced-original-signal":
              restores.push(
                replace(context, "signal", new AbortController().signal),
              );
              break;
            case "replaced-native-approval": {
              const approval = f.engine.store.getApproval(capture.approval!.id),
                db = new DatabaseSync(f.dbPath),
                saved = db
                  .prepare("SELECT data FROM approvals WHERE id=?")
                  .get(approval.id)!;
              assert.equal(approval.status, "allowed");
              db.prepare("UPDATE approvals SET data=? WHERE id=?").run(
                JSON.stringify({
                  ...approval,
                  fingerprint: "replaced-native-fingerprint",
                }),
                approval.id,
              );
              restores.push(() => {
                db.prepare("UPDATE approvals SET data=? WHERE id=?").run(
                  saved.data!,
                  approval.id,
                );
                db.close();
              });
              break;
            }
            case "copied-original":
              selected = { ...context };
              break;
            case "original-context-proxy":
              selected = new Proxy(context, {
                get: trap,
                ownKeys: trap,
                getPrototypeOf: trap,
              });
              break;
            case "original-workspace-proxy":
              restores.push(
                replace(
                  context,
                  "workspace",
                  new Proxy(context.workspace, {
                    get: trap,
                    ownKeys: trap,
                    getPrototypeOf: trap,
                  }),
                ),
              );
              break;
            case "original-signal-accessor": {
              const descriptor = Object.getOwnPropertyDescriptor(
                context,
                "signal",
              )!;
              Object.defineProperty(context, "signal", {
                enumerable: true,
                configurable: true,
                get: trap,
              });
              restores.push(() =>
                Object.defineProperty(context, "signal", descriptor),
              );
              break;
            }
            case "wrong-phase":
              selectedPhase = "prepare";
              break;
            case "inactive-original-prepare":
              assert.ok(prepareContext);
              selected = prepareContext;
              selectedPhase = "prepare";
              break;
            default:
              assert.fail(`Unhandled native scenario ${scenario.name}`);
          }
          try {
            original(selected, selectedPhase);
            assert.fail(
              "The changed Original must fail before the native effect",
            );
          } catch (error) {
            assert.ok(error instanceof EngineError);
            assert.equal(
              error.code,
              scenario.bindingError
                ? "TEAM_MODEL_OWNER_STALE"
                : scenario.name === "replaced-native-approval"
                  ? `${lane.toUpperCase()}_MODEL_APPROVAL_REQUIRED`
                  : `${lane.toUpperCase()}_MODEL_OWNER_STALE`,
            );
            assert.equal(
              catalogueReads - reads,
              scenario.name === "replaced-native-approval" ? 1 : 0,
            );
            throw error;
          }
        } finally {
          for (const restore of restores.reverse()) restore();
        }
      };

      const scenarios =
          lane === "workflow" ? [...shared, ...workflowGaps] : shared,
        toolName =
          lane === "team" ? "send_agent_message" : "request_workflow_stage";
      function release(index: number, requestId: string) {
        f.rootTurns.release(index, [
          {
            id: requestId,
            name: toolName,
            input:
              lane === "team"
                ? {
                    requestId,
                    recipient: "target",
                    text: "Original native ownership is required.",
                  }
                : {
                    requestId,
                    stageId: "plan",
                    expectedRevision: f.engine.inspectWorkflow(
                      f.workspace.id,
                      instanceId,
                    )!.revision,
                  },
          },
        ]);
      }
      for (let index = 0; index < scenarios.length; index++) {
        scenario = scenarios[index]!;
        const before = counts(f.dbPath),
          previousInjections = injections;
        release(index, `${lane}-${scenario.name}`);
        let approval: ApprovalRecord | undefined;
        if (scenario.phase !== "prepare") {
          approval = await f.pendingApproval();
          await f.decide(approval);
        }
        await f.rootTurns.entered(index + 1);
        assert.equal(injections, previousInjections + 1, scenario.name);
        assert.deepEqual(counts(f.dbPath), before, scenario.name);
        assert.equal(f.engine.children.tasks.list(f.session.id).length, 0);
        assert.equal(childDispatches, 0);
        assert.equal(traps, 0);
        const record = f.engine.store.getSnapshot(f.session.id).tools.at(-1)!;
        assert.equal(record.state, "failed", scenario.name);
        const code = scenario.bindingError
          ? "TEAM_MODEL_OWNER_STALE"
          : scenario.name === "replaced-native-approval"
            ? `${lane.toUpperCase()}_MODEL_APPROVAL_REQUIRED`
            : `${lane.toUpperCase()}_MODEL_OWNER_STALE`;
        assert.match(record.output ?? record.error ?? "", new RegExp(code));
        if (approval)
          assert.equal(
            f.engine.store.getApproval(approval.id).status,
            "allowed",
          );
      }
      scenario = undefined;
      const before = counts(f.dbPath);
      release(scenarios.length, `${lane}-positive-original`);
      const approval = await f.pendingApproval();
      await f.decide(approval);
      await f.rootTurns.entered(scenarios.length + 1);
      const record = f.engine.store.getToolCall(approval.toolCallId);
      assert.equal(
        record.state,
        "completed",
        record.output ?? record.error ?? "Original Tool must complete",
      );
      if (lane === "team") {
        assert.equal(counts(f.dbPath).team_messages, before.team_messages! + 1);
        assert.equal(childDispatches, 0);
      } else {
        await untilModelTools(
          () => childDispatches === 1,
          "The valid Original must dispatch one real private child",
        );
        assert.equal(f.engine.children.tasks.list(f.session.id).length, 1);
        assert.ok(
          counts(f.dbPath).workflow_revisions! > before.workflow_revisions!,
        );
      }
      f.rootTurns.release(scenarios.length + 1);
      assert.equal(
        (await f.engine.waitForRun(parent.runId)).state,
        "completed",
      );
      t.diagnostic(
        JSON.stringify({
          lane,
          rejectedNativeOperations: injections,
          positiveNativeOperations: 1,
          traps,
          childDispatches,
        }),
      );
    },
  );
}
