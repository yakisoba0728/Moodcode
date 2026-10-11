import { join } from "node:path";
import type { JsonObject, ToolCallRecord } from "@moodcode/contracts";
import type { EngineRuntime } from "../engine-runtime.js";
import type {
  ToolContext,
  ToolDefinition,
  PreparedTool,
  ToolResult,
} from "../ports.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { createChildMergeTool } from "../child-tasks/merge.js";
import type { WorkflowService } from "./service.js";
import type { WorkflowInstanceRevision } from "./reducer.js";
import {
  workflowAbort,
  workflowHostRecord,
  type ActualWorkflowOwnerPort,
} from "./host.js";
import {
  workflowJson,
  workflowIdentifier,
  WORKFLOW_MODEL_NAMES,
} from "./spec.js";
import {
  advanceEffect,
  effectFail,
  type WorkflowEffectRecord,
} from "./effects-records.js";
import { filePin, pinsCurrent, type WorkflowEffects } from "./effects.js";
function mergeBound(
  inner: PreparedTool,
  editor: WorkflowEffectRecord,
  root: string,
): void {
  const files = inner.preview.files,
    merged = Array.isArray(files)
      ? files.map((file) => {
          const { path, afterHash } = file as JsonObject;
          return `${join(root, String(path))}\0${afterHash}`;
        })
      : [],
    pinned = editor.files.map((pin) => `${pin.path}\0${pin.sha256}`);
  if (knowledgeHash(merged.sort()) !== knowledgeHash(pinned.sort()))
    effectFail("WORKFLOW_VERIFICATION_SOURCE_STALE");
}
interface Binding {
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly originalOwner: object;
  readonly ownerSha256: string;
  released: boolean;
}
interface MergeCapture {
  binding: object;
  input: JsonObject;
  record: WorkflowInstanceRevision;
  editor: WorkflowEffectRecord;
  validator: WorkflowEffectRecord;
  inner: PreparedTool;
  preparedSha: string;
  tuple: string;
  head: string;
  used: boolean;
  batchSelection: JsonObject | null;
}
/** The Root run's workflow model tools: one binding per run, exact-approval stage requests, merges and result delivery. */
export class WorkflowModelTools {
  private readonly bindings = new Map<object, Binding>();
  private readonly byRun = new Map<string, object>();
  private readonly merges = new WeakMap<PreparedTool, MergeCapture>();
  private readonly pendingMerge = new Map<
    string,
    {
      record: WorkflowEffectRecord;
      result: ToolResult;
      expectedRevision: number;
    }
  >();
  private readonly merge: ToolDefinition;
  constructor(
    private readonly engine: Pick<
      EngineRuntime,
      "store" | "coordinator" | "children"
    >,
    private readonly effects: WorkflowEffects,
    private readonly service: () => WorkflowService,
    private readonly owners: ActualWorkflowOwnerPort,
  ) {
    this.merge = createChildMergeTool(
      engine.children.tasks,
      engine.children.worktrees,
    );
  }
  bind(input: { workspaceId: string; instanceId: string }): object {
    workflowHostRecord(input, ["workspaceId", "instanceId"]);
    this.effects.open();
    const { record, owner } = this.service().effectOwner(
      input.workspaceId,
      input.instanceId,
    );
    this.owners.assertCurrent(owner.original, record.owner);
    if (this.byRun.has(record.owner.runId))
      effectFail("WORKFLOW_MODEL_ALREADY_BOUND");
    const original = this.effects.issue(this.bindings, {
      workspaceId: record.workspaceId,
      instanceId: record.instanceId,
      sessionId: record.owner.sessionId,
      runId: record.owner.runId,
      originalOwner: owner.original,
      ownerSha256: record.owner.sha256,
      released: false,
    });
    this.byRun.set(record.owner.runId, original);
    return original;
  }
  release(original: object): void {
    const b = this.bindings.get(original);
    if (b) {
      b.released = true;
      if (this.byRun.get(b.runId) === original) this.byRun.delete(b.runId);
      this.bindings.delete(original);
    }
  }
  private actor(
    context: ToolContext,
    phase: "prepare" | "execute",
    original?: object,
  ): { original: object; binding: Binding; record: WorkflowInstanceRevision } {
    this.effects.open();
    this.engine.coordinator.assertWorkflowToolContext(context, phase);
    const key = original ?? this.byRun.get(context.runId),
      actor = key && this.bindings.get(key);
    if (
      !key ||
      !actor ||
      actor.released ||
      actor.sessionId !== context.sessionId ||
      actor.runId !== context.runId ||
      actor.workspaceId !== context.workspace.id
    )
      effectFail("WORKFLOW_MODEL_UNBOUND");
    const { record, owner } = this.service().effectOwner(
      actor.workspaceId,
      actor.instanceId,
    );
    if (
      owner.original !== actor.originalOwner ||
      record.owner.sha256 !== actor.ownerSha256
    )
      effectFail("WORKFLOW_MODEL_STALE");
    this.owners.assertCurrent(owner.original, record.owner);
    return { original: key, binding: actor, record };
  }
  private tuple(c: ToolContext): string {
    return knowledgeHash([
      c.sessionId,
      c.runId,
      c.turnId,
      c.attemptId,
      c.toolCallId,
      c.workspace.id,
      c.workspace.root,
    ]);
  }
  tools(): ToolDefinition[] {
    const requests = new WeakMap<
      PreparedTool,
      {
        binding: object;
        tuple: string;
        input: JsonObject;
        record: WorkflowInstanceRevision;
        preparedSha: string;
        targetSha256?: string;
      }
    >();
    return WORKFLOW_MODEL_NAMES.map((name): ToolDefinition => {
      const required =
        name === "deliver_workflow_result"
          ? ["requestId"]
          : ["stageId", "requestId", "expectedRevision"];
      return {
        name,
        effectClass:
          name === "observe_workflow_stage"
            ? "read"
            : name === "merge_workflow_stage"
              ? "write"
              : "execute",
        description:
          "Operate the exact Root-bound workflow using its current native stage revision. Stage labels, child text and results grant no profile, actor, tools or approval. All effects and result delivery require exact approval.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties:
            name === "deliver_workflow_result"
              ? { requestId: { type: "string", maxLength: 128 } }
              : {
                  stageId: { type: "string", maxLength: 128 },
                  requestId: { type: "string", maxLength: 128 },
                  expectedRevision: { type: "integer", minimum: 1 },
                },
          required,
        } as JsonObject,
        prepare: async (input, context) => {
          const a = this.actor(context, "prepare");
          workflowHostRecord(input, required);
          const data = workflowJson(input) as JsonObject;
          workflowIdentifier(data.requestId);
          if (name !== "deliver_workflow_result") {
            workflowIdentifier(data.stageId);
            if (data.expectedRevision !== a.record.revision)
              effectFail("WORKFLOW_STAGE_STALE");
          }
          if (name === "merge_workflow_stage") {
            const batchSelection =
              this.effects.batchPolicy?.merge(a.record, String(data.stageId)) ??
              null;
            const selection = await this.effects.mergeSelection(
                a.record,
                String(data.stageId),
              ),
              inner = await this.merge.prepare(
                { childTaskId: selection.editor.completion.child.taskId },
                context,
              );
            mergeBound(
              inner,
              selection.editor,
              a.record.worktrees[String(data.stageId)]!.root,
            );
            this.actor(context, "prepare", a.original);
            const tuple = this.tuple(context),
              preview = {
                ...inner.preview,
                workflow: {
                  instanceId: a.record.instanceId,
                  stageId: data.stageId!,
                  revision: a.record.revision,
                  sourceSha256: selection.editor.sha256,
                  verificationSha256: selection.validator.sha256,
                  head: selection.head,
                  ...(batchSelection
                    ? { codingSelection: batchSelection }
                    : {}),
                },
              };
            const prepared: PreparedTool = {
              name,
              input: data,
              fingerprint: knowledgeHash({
                name,
                input: data,
                preview,
                inner: inner.fingerprint,
                tuple,
              }),
              requiresApproval: true,
              preview,
            };
            this.merges.set(prepared, {
              ...selection,
              binding: a.original,
              input: data,
              record: a.record,
              inner,
              preparedSha: knowledgeHash(prepared),
              tuple,
              used: false,
              batchSelection,
            });
            return prepared;
          }
          const target =
            name === "deliver_workflow_result"
              ? this.effects.target({
                  workspaceId: a.record.workspaceId,
                  instanceId: a.record.instanceId,
                  config: this.engine.store.getRun(a.record.owner.runId).config,
                }).proof
              : undefined;
          const tuple = this.tuple(context),
            preview = {
              instanceId: a.record.instanceId,
              workflowId: a.record.workflowId,
              stageId: data.stageId ?? null,
              revision: a.record.revision,
              ownerSha256: a.record.owner.sha256,
              operation: name,
              ...(target ? { target: target as unknown as JsonObject } : {}),
            };
          const prepared: PreparedTool = {
            name,
            input: data,
            fingerprint: knowledgeHash({
              preview,
              input: data,
              tuple,
            }),
            requiresApproval: name !== "observe_workflow_stage",
            preview,
          };
          requests.set(prepared, {
            binding: a.original,
            tuple,
            input: data,
            record: a.record,
            preparedSha: knowledgeHash(prepared),
            ...(target ? { targetSha256: target.sha256 } : {}),
          });
          return prepared;
        },
        execute: async (prepared, context) => {
          if (name === "merge_workflow_stage")
            return this.executeMerge(prepared, context);
          const p = requests.get(prepared);
          if (!p) effectFail("WORKFLOW_ORIGINAL_REQUIRED");
          const a = this.actor(context, "execute", p.binding);
          if (
            p.preparedSha !== knowledgeHash(prepared) ||
            p.tuple !== this.tuple(context)
          )
            effectFail("WORKFLOW_ORIGINAL_REQUIRED");
          requests.delete(prepared);
          if (a.record.sha256 !== p.record.sha256)
            effectFail("WORKFLOW_STAGE_STALE");
          workflowAbort(context.signal);
          if (name === "deliver_workflow_result") {
            const target = this.effects.captureTarget({
              workspaceId: a.record.workspaceId,
              instanceId: a.record.instanceId,
              config: this.engine.store.getRun(a.record.owner.runId).config,
            });
            try {
              if (this.effects.readTarget(target).sha256 !== p.targetSha256)
                effectFail("WORKFLOW_DELIVERY_STALE");
              const r = this.effects.deliver({
                workspaceId: a.record.workspaceId,
                requestId: String(p.input.requestId),
                expectedRevision: 0,
                target,
                approved: true,
                signal: context.signal,
              });
              return {
                content: JSON.stringify({
                  instanceId: r.record.instanceId,
                  inputId: r.record.input.inputId,
                  sha256: r.record.sha256,
                  duplicate: r.duplicate,
                }),
              };
            } finally {
              this.effects.release(target);
            }
          }
          const input = {
            workspaceId: a.record.workspaceId,
            instanceId: a.record.instanceId,
            stageId: String(p.input.stageId),
            requestId: String(p.input.requestId),
            expectedRevision: Number(p.input.expectedRevision),
            signal: context.signal,
          };
          const r =
            name === "request_workflow_stage"
              ? await this.service().startStage({ ...input, approved: true })
              : await this.service().observeStage(input);
          return {
            content: JSON.stringify({
              instanceId: r.record.instanceId,
              revision: r.record.revision,
              state: r.record.state,
              stage: r.record.stages.find((s) => s.stageId === input.stageId)
                ?.state,
              sha256: r.record.sha256,
              duplicate: r.duplicate,
            }),
          };
        },
      };
    });
  }
  private async executeMerge(
    prepared: PreparedTool,
    context: ToolContext,
  ): Promise<ToolResult> {
    const p = this.merges.get(prepared);
    if (!p || p.used) effectFail("WORKFLOW_ORIGINAL_REQUIRED");
    const a = this.actor(context, "execute", p.binding);
    if (
      p.preparedSha !== knowledgeHash(prepared) ||
      p.tuple !== this.tuple(context)
    )
      effectFail("WORKFLOW_ORIGINAL_REQUIRED");
    p.used = true;
    if (a.record.sha256 !== p.record.sha256) effectFail("WORKFLOW_STAGE_STALE");
    const currentBatchSelection =
      this.effects.batchPolicy?.merge(a.record, p.editor.stageId) ?? null;
    if (
      knowledgeHash(currentBatchSelection) !== knowledgeHash(p.batchSelection)
    )
      effectFail("CODING_SELECTION_STALE");
    const now = await this.effects.mergeSelection(a.record, p.editor.stageId);
    if (
      now.editor.sha256 !== p.editor.sha256 ||
      now.validator.sha256 !== p.validator.sha256 ||
      now.head !== p.head
    )
      effectFail("WORKFLOW_SOURCE_STALE");
    mergeBound(p.inner, now.editor, a.record.worktrees[p.editor.stageId]!.root);
    this.actor(context, "execute", p.binding);
    const approval = this.engine.coordinator.getWorkflowToolApproval(context);
    const intent = advanceEffect(p.editor, {
      state: "merge-dispatching",
      merge: {
        toolCallId: context.toolCallId,
        runId: context.runId,
        turnId: context.turnId!,
        attemptId: context.attemptId!,
        preparedFingerprint: approval.fingerprint,
        approvalId: approval.id,
        validatorSha256: p.validator.sha256,
        checkpointIds: [],
        parentFiles: [],
      },
    });
    const original = this.effects.issueEffect(intent, () => {
      this.actor(context, "execute", p.binding);
      pinsCurrent(p.editor.files);
      pinsCurrent(p.validator.artifacts);
    });
    try {
      this.effects.publish(original, p.editor.revision);
    } finally {
      this.effects.release(original);
    }
    try {
      const result = await this.merge.execute(p.inner, context);
      this.pendingMerge.set(context.toolCallId, {
        record: intent,
        result: structuredClone(result),
        expectedRevision: intent.revision,
      });
      return result;
    } catch (error) {
      this.pendingMerge.set(context.toolCallId, {
        record: intent,
        result: { content: "unconfirmed merge outcome", isError: true },
        expectedRevision: intent.revision,
      });
      this.finishMergeUnknown(context.toolCallId);
      throw error;
    }
  }
  private finishMergeUnknown(id: string): void {
    const p = this.pendingMerge.get(id);
    if (!p) return;
    const record = advanceEffect(p.record, { state: "uncertain" });
    const o = this.effects.issueEffect(record, () => {});
    try {
      this.effects.publish(o, p.expectedRevision);
    } finally {
      this.effects.release(o);
      this.pendingMerge.delete(id);
      this.service().reclaim(p.record.instanceId);
    }
  }
  toolSettled(tool: ToolCallRecord): void {
    const p = this.pendingMerge.get(tool.id);
    if (!p) return;
    if (tool.state !== "completed" || p.result.isError) {
      this.finishMergeUnknown(tool.id);
      return;
    }
    const checkpoints = this.engine.store
      .listCheckpoints(tool.runId)
      .filter((c) => c.toolCallId === tool.id);
    if (!checkpoints.length || checkpoints.some((c) => c.incomplete)) {
      this.finishMergeUnknown(tool.id);
      return;
    }
    const record = advanceEffect(p.record, {
        state: "merged",
        merge: {
          ...p.record.merge!,
          checkpointIds: checkpoints.map((c) => c.id),
          parentFiles: checkpoints.flatMap((c) =>
            c.files.map((f) =>
              filePin(
                join(
                  this.engine.store.getWorkspace(p.record.workspaceId).root,
                  f.path,
                ),
              ),
            ),
          ),
        },
      }),
      o = this.effects.issueEffect(record, () => {
        if (this.engine.store.getToolCall(tool.id).state !== "completed")
          effectFail();
      });
    try {
      this.engine.store.withWorkflowEffectsTransaction(() => {
        this.effects.publish(o, p.expectedRevision);
        this.effects.batchPolicy?.settled(record);
      });
      this.pendingMerge.delete(tool.id);
      this.service().reclaim(record.instanceId);
    } finally {
      this.effects.release(o);
    }
  }

  close(): void {
    this.bindings.clear();
    this.byRun.clear();
    this.pendingMerge.clear();
  }
}
