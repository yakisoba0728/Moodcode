import type { JsonObject } from "@moodcode/contracts";
import type { ChildBudget } from "../child-tasks/index.js";
import { knowledgeHash } from "../knowledge/validation.js";
import type { WorkflowSpec } from "./types.js";
import { workflowError, validateWorkflowStageResult } from "./spec.js";

export type WorkflowState = "pending" | "running" | "completed" | "failed" | "cancelled" | "uncertain" | "paused-import";
export type WorkflowStageStatus = "blocked" | "ready" | "dispatching" | "running" | "completed" | "failed" | "cancelled" | "uncertain";
export interface WorkflowOwnerProof {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly ownerEpoch: string;
  readonly runConfigSha256: string;
  readonly profile: { readonly id: string; readonly revision: string } | null;
  readonly sha256: string;
}
export interface WorkflowWorktreePin {
  readonly id: string;
  readonly workspaceId: string;
  readonly root: string;
  readonly baseRoot: string;
  readonly baseCommit: string;
  readonly fingerprint: string;
  readonly sha256: string;
}
export interface WorkflowChildAdmissionProof {
  readonly rootSessionId: string;
  readonly rootRunId: string;
  readonly parentRunId: string;
  readonly taskId: string;
  readonly taskFingerprint: string;
  readonly childSessionId: string;
  readonly childRunId: string;
  readonly childWorkspaceId: string;
  readonly worktreeId: string;
  readonly storageSha256: string;
  readonly requestId: string;
  readonly promptSha256: string;
  readonly tools: readonly string[];
  readonly allocation: ChildBudget;
  readonly sha256: string;
}
export interface WorkflowChildCompletionProof {
  readonly child: WorkflowChildAdmissionProof;
  readonly state: "completed" | "failed" | "cancelled" | "uncertain";
  readonly result: JsonObject | null;
  readonly outcomeSha256: string;
  readonly usage: Omit<ChildBudget, "durationMs">;
  readonly complete: boolean;
  readonly sha256: string;
}
export interface WorkflowStageState {
  readonly id: string;
  readonly revision: number;
  readonly stageId: string;
  readonly state: WorkflowStageStatus;
  readonly child: WorkflowChildAdmissionProof | null;
  readonly result: JsonObject | null;
  readonly resultSha256: string | null;
  readonly outcomeSha256: string | null;
  readonly requestId: string | null;
  readonly promptSha256: string | null;
  readonly selectedDependencies: readonly string[];
}
export interface WorkflowInstanceRevision {
  readonly id: string;
  readonly instanceId: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly specRevisionId: string;
  readonly specSha256: string;
  readonly owner: WorkflowOwnerProof;
  readonly parameters: JsonObject;
  readonly parametersSha256: string;
  readonly worktrees: Readonly<Record<string, WorkflowWorktreePin>>;
  readonly revision: number;
  readonly previousId: string | null;
  readonly state: WorkflowState;
  readonly stages: readonly WorkflowStageState[];
  readonly result: JsonObject | null;
  readonly lastReceiptId: string;
  readonly createdAt: string;
  readonly sha256: string;
}
export type WorkflowTransitionEvent =
  | { readonly operation: "prepare"; readonly stageId: string; readonly childRequestId: string; readonly promptSha256: string }
  | { readonly operation: "admit"; readonly stageId: string; readonly child: WorkflowChildAdmissionProof }
  | { readonly operation: "settle"; readonly stageId: string; readonly completion: WorkflowChildCompletionProof }
  | { readonly operation: "cancel" }
  | { readonly operation: "uncertain" }
  | { readonly operation: "pause-import" };

export function initialWorkflowStages(spec: WorkflowSpec): Omit<WorkflowStageState, "id" | "revision">[] {
  return spec.stages.map(stage => ({ stageId: stage.id, state: stage.dependsOn.length ? "blocked" : "ready", child: null, result: null, resultSha256: null, outcomeSha256: null, requestId: null, promptSha256: null, selectedDependencies: [] }));
}
/** Only explicit host events transition state. No transition restarts or dispatches a child. */
export function reduceWorkflow(spec: WorkflowSpec, before: WorkflowInstanceRevision, event: WorkflowTransitionEvent): { state: WorkflowState; stages: WorkflowStageState[]; result: JsonObject | null } {
  if (["completed", "failed", "cancelled", "uncertain", "paused-import"].includes(before.state)) workflowError("WORKFLOW_TERMINAL");
  const stages = structuredClone(before.stages) as WorkflowStageState[];
  if (event.operation === "cancel" || event.operation === "uncertain" || event.operation === "pause-import") return { state: event.operation === "pause-import" ? "paused-import" : event.operation === "cancel" ? "cancelled" : "uncertain", stages, result: null };
  const index = stages.findIndex(stage => stage.stageId === event.stageId), stage = stages[index], definition = spec.stages.find(stage => stage.id === event.stageId);
  if (!stage || !definition) workflowError("WORKFLOW_STAGE_MISSING");
  let next: WorkflowStageState;
  if (event.operation === "prepare") {
    if (stage.state !== "ready") workflowError("WORKFLOW_STAGE_STALE");
    const selected = [...stage.selectedDependencies];
    if (selected.some(id => !definition.dependsOn.includes(id) || stages.find(stage => stage.stageId === id)?.state !== "completed") || new Set(selected).size !== selected.length) workflowError("WORKFLOW_JOIN_PENDING");
    if (definition.join === "all" ? selected.length !== definition.dependsOn.length : selected.length !== (definition.dependsOn.length ? 1 : 0)) workflowError("WORKFLOW_JOIN_PENDING");
    next = { ...stage, state: "dispatching", requestId: event.childRequestId, promptSha256: event.promptSha256, selectedDependencies: definition.join === "any" ? selected.slice(0, 1) : selected };
  } else if (event.operation === "admit") {
    if (stage.state !== "dispatching" || event.child.requestId !== stage.requestId || event.child.promptSha256 !== stage.promptSha256) workflowError("WORKFLOW_STAGE_STALE");
    next = { ...stage, state: "running", child: event.child };
  } else {
    const proof = event.completion;
    if (stage.state !== "running" || !stage.child || stage.child.sha256 !== proof.child.sha256) workflowError("WORKFLOW_CHILD_STALE");
    if (proof.state === "completed" && (!proof.complete || proof.result === null)) workflowError("WORKFLOW_RESULT_INCOMPLETE");
    const result = proof.state === "completed" ? validateWorkflowStageResult(spec, stage.stageId, proof.result).value : null;
    next = { ...stage, state: proof.state, result, resultSha256: result === null ? null : knowledgeHash(result), outcomeSha256: proof.outcomeSha256 };
  }
  stages[index] = next;
  for (let position = 0; position < stages.length; position++) {
    const item = stages[position]!;
    if (item.state !== "blocked") continue;
    const def = spec.stages.find(stage => stage.id === item.stageId)!;
    const dependencies = def.dependsOn.map(id => stages.find(stage => stage.stageId === id)!);
    const completed = dependencies.filter(stage => stage.state === "completed");
    if (def.join === "all" ? completed.length === dependencies.length : completed.length > 0) stages[position] = { ...item, state: "ready", selectedDependencies: (def.join === "any" ? completed.slice(0,1) : completed).map(stage => stage.stageId) };
  }
  const resultStage = stages.find(stage => stage.stageId === spec.resultStageId)!;
  const state: WorkflowState = stages.some(stage => stage.state === "uncertain") ? "uncertain" : resultStage.state === "completed" && stages.every(stage => !["dispatching", "running"].includes(stage.state)) ? "completed" : stages.some(stage => stage.state === "failed") && !stages.some(stage => ["ready", "dispatching", "running"].includes(stage.state)) ? "failed" : stages.some(stage => stage.state === "cancelled") && !stages.some(stage => ["ready", "dispatching", "running"].includes(stage.state)) ? "cancelled" : "running";
  return { state, stages, result: state === "completed" ? resultStage.result : null };
}
