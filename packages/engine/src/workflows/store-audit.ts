import { knowledgeHash } from "../knowledge/validation.js";
import { sha256Hex } from "../shared/canonical.js";
import {
  CHILD_OUTCOME_STATES,
  forcedWorkflowState,
  initialWorkflowStages,
  reduceWorkflow,
  type WorkflowChildCompletionProof,
  type WorkflowInstanceRevision,
  type WorkflowStageState,
  type WorkflowTransitionEvent,
  type WorkflowWorktreePin,
} from "./reducer.js";
import {
  WORKFLOW_LIMITS,
  WORKFLOW_STAGE_KEYS,
  workflowError,
  workflowIdentifier,
} from "./spec.js";
import type {
  WorkflowSpecRevision,
  WorkflowStorage,
  WorkflowTransitionReceipt,
} from "./store.js";

/** Exact own keys, or WORKFLOW_DATABASE_INVALID. */
export function fields(value: object, required: readonly string[]): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key))
  )
    workflowError("WORKFLOW_DATABASE_INVALID");
}
export function taskOutcomeSha(task: Record<string, unknown>): string {
  return knowledgeHash(
    task.outcome ?? { state: task.state, errorCode: task.errorCode ?? null },
  );
}
/** The worktree id each stage selected. */
export function worktreeIds(
  pins: Readonly<Record<string, WorkflowWorktreePin>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(pins).map(([id, pin]) => [id, pin.id]),
  );
}
function stageData(
  stage: WorkflowStageState,
): Omit<WorkflowStageState, "id" | "revision"> {
  const { id: _id, revision: _revision, ...data } = stage;
  return data;
}
function replay(
  storage: WorkflowStorage,
  after: WorkflowSpecRevision | WorkflowInstanceRevision,
): void {
  const receipt = storage.receipt(after),
    request = receipt.requestInput;
  if (
    request.requestId !== receipt.requestId ||
    (request.workspaceId !== after.workspaceId &&
      receipt.operation !== "pause-import" &&
      !String(receipt.requestId).startsWith("recover:"))
  )
    workflowError("WORKFLOW_DATABASE_INVALID");
  if ("spec" in after) {
    if (
      receipt.operation !== "register" ||
      receipt.instanceId !== null ||
      receipt.stageId !== null ||
      request.expectedRevision !== after.revision - 1 ||
      knowledgeHash(request.spec) !== knowledgeHash(after.spec)
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    fields(request, ["workspaceId", "requestId", "expectedRevision", "spec"]);
    return;
  }
  const spec = storage.spec(after).spec;
  if (after.previousId === null) {
    fields(request, [
      "workspaceId",
      "requestId",
      "workflowId",
      "expectedSpecRevision",
      "parameters",
      "worktrees",
      "ownerSha256",
    ]);
    if (
      receipt.operation !== "create" ||
      after.revision !== 1 ||
      after.state !== "pending" ||
      after.result !== null ||
      request.workflowId !== after.workflowId ||
      request.ownerSha256 !== after.owner.sha256 ||
      request.expectedSpecRevision !== storage.spec(after).revision ||
      knowledgeHash(request.parameters) !== knowledgeHash(after.parameters) ||
      knowledgeHash(request.worktrees) !==
        knowledgeHash(worktreeIds(after.worktrees)) ||
      knowledgeHash(after.stages.map(stageData)) !==
        knowledgeHash(initialWorkflowStages(spec)) ||
      after.stages.some((stage) => stage.revision !== 1)
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    return;
  }
  const before = storage.revision(
    after.previousId,
    after.workspaceId,
    "instance",
  ) as WorkflowInstanceRevision;
  for (const key of [
    "instanceId",
    "workspaceId",
    "workflowId",
    "specRevisionId",
    "specSha256",
    "owner",
    "parameters",
    "parametersSha256",
    "worktrees",
  ] as const)
    if (knowledgeHash(after[key]) !== knowledgeHash(before[key]))
      workflowError("WORKFLOW_DATABASE_INVALID");
  let reduced: ReturnType<typeof reduceWorkflow>;
  const internal =
    receipt.operation === "pause-import" ||
    (receipt.operation === "uncertain" && Object.hasOwn(request, "revision"));
  if (internal) {
    fields(request, ["operation", "instanceId", "revision", "requestId"]);
    if (
      request.operation !== receipt.operation ||
      request.instanceId !== after.instanceId ||
      request.revision !== before.revision ||
      receipt.stageId !== null ||
      (receipt.operation === "uncertain" &&
        (!["pending", "running"].includes(before.state) ||
          receipt.requestId !== `recover:${before.id}`))
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    reduced = forcedWorkflowState(before, receipt.operation);
  } else {
    const stageId = receipt.stageId,
      stage = after.stages.find((stage) => stage.stageId === stageId);
    if (
      request.operation !== receipt.operation ||
      request.instanceId !== after.instanceId ||
      request.expectedRevision !== before.revision ||
      request.stageId !== (stageId ?? undefined)
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    let event: WorkflowTransitionEvent;
    if (receipt.operation === "prepare") {
      fields(request, [
        ...WORKFLOW_STAGE_KEYS,
        "prompt",
        "childRequestId",
        "operation",
      ]);
      if (
        typeof request.prompt !== "string" ||
        !request.prompt ||
        Buffer.byteLength(request.prompt) > WORKFLOW_LIMITS.promptBytes
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
      event = {
        operation: "prepare",
        stageId: stageId!,
        childRequestId: workflowIdentifier(request.childRequestId),
        promptSha256: sha256Hex(request.prompt),
      };
    } else if (receipt.operation === "admit") {
      fields(request, [...WORKFLOW_STAGE_KEYS, "operation"]);
      if (!stage?.child) workflowError("WORKFLOW_DATABASE_INVALID");
      event = { operation: "admit", stageId: stageId!, child: stage.child };
    } else if (receipt.operation === "settle") {
      fields(request, [...WORKFLOW_STAGE_KEYS, "operation"]);
      if (
        !stage?.child ||
        !(CHILD_OUTCOME_STATES as readonly string[]).includes(stage.state) ||
        !stage.outcomeSha256
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
      const { task, storage: child } = storage.childSQL(after, stage.child);
      if (
        task.state !== stage.state ||
        stage.outcomeSha256 !== taskOutcomeSha(task) ||
        (stage.state !== "uncertain" && !child.confirmedClose)
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
      event = {
        operation: "settle",
        stageId: stageId!,
        completion: {
          child: stage.child,
          state: stage.state as WorkflowChildCompletionProof["state"],
          result: stage.result,
          outcomeSha256: stage.outcomeSha256,
          complete: stage.state === "completed",
          usage: { turns: 0, toolCalls: 0, outputBytes: 0 },
          sha256: "",
        },
      };
    } else if (
      receipt.operation === "cancel" ||
      receipt.operation === "fail" ||
      receipt.operation === "uncertain"
    ) {
      fields(request, [
        "workspaceId",
        "instanceId",
        "requestId",
        "expectedRevision",
        "operation",
      ]);
      if (stageId !== null) workflowError("WORKFLOW_DATABASE_INVALID");
      event = { operation: receipt.operation };
    } else return workflowError("WORKFLOW_DATABASE_INVALID");
    reduced = reduceWorkflow(spec, before, event);
  }
  if (
    after.revision !== before.revision + 1 ||
    knowledgeHash({
      state: after.state,
      result: after.result,
      stages: after.stages.map(stageData),
    }) !== knowledgeHash({ ...reduced, stages: reduced.stages.map(stageData) })
  )
    workflowError("WORKFLOW_DATABASE_INVALID");
  for (const stage of after.stages) {
    const prior = before.stages.find((item) => item.stageId === stage.stageId)!,
      expected = reduced.stages.find((item) => item.stageId === stage.stageId)!;
    const changed =
      knowledgeHash(stageData(prior)) !== knowledgeHash(stageData(expected));
    if (
      changed
        ? stage.id === prior.id || stage.revision !== prior.revision + 1
        : stage.id !== prior.id || stage.revision !== prior.revision
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
  }
}
/** Replays every revision against its receipt and checks the revision graph and heads. */
export function validateWorkflowStorage(
  storage: WorkflowStorage,
  check: () => void = () => {},
): void {
  const referencedStages = new Set<string>(),
    stageRows: string[] = [],
    verifiedHeads = new Set<string>();
  /** The database does not change during validation, so each head is verified once. */
  const verifyHead = (
    workspaceId: string,
    kind: "spec" | "instance" | "stage",
    entityId: string,
  ): boolean => {
    const key = [workspaceId, kind, entityId].join("\0");
    if (verifiedHeads.has(key)) return true;
    if (!storage.head(workspaceId, kind, entityId)) return false;
    verifiedHeads.add(key);
    return true;
  };
  storage.assertJournalSize();
  for (const row of storage.db
    .prepare(
      "SELECT id,workspace_id FROM workflow_revisions ORDER BY workspace_id,id LIMIT 4097",
    )
    .all()) {
    check();
    const native = storage.row(String(row.id), String(row.workspace_id))!,
      body = storage.decode(native);
    if (native.previous_id !== null) {
      const predecessor = storage.row(native.previous_id, native.workspace_id);
      if (
        !predecessor ||
        predecessor.kind !== native.kind ||
        predecessor.entity_id !== native.entity_id ||
        predecessor.revision + 1 !== native.revision
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
    }
    if (native.kind === "instance") {
      storage.checkInstance(body as WorkflowInstanceRevision);
      for (const stage of (body as WorkflowInstanceRevision).stages)
        referencedStages.add(stage.id);
    }
    if (native.kind === "stage") stageRows.push(native.id);
    if (native.kind === "instance" || native.kind === "spec")
      replay(storage, body as WorkflowInstanceRevision | WorkflowSpecRevision);
    if (
      native.kind !== "transition" &&
      !verifyHead(native.workspace_id, native.kind, native.entity_id)
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    if (native.previous_id === null && native.revision !== 1)
      workflowError("WORKFLOW_DATABASE_INVALID");
    if (native.kind === "transition") {
      const receipt = body as WorkflowTransitionReceipt,
        after = storage.revision(receipt.afterRevisionId, receipt.workspaceId);
      if (
        after.sha256 !== receipt.afterSha256 ||
        (after as WorkflowInstanceRevision | WorkflowSpecRevision)
          .lastReceiptId !== receipt.id ||
        receipt.beforeRevisionId !==
          (after as WorkflowInstanceRevision | WorkflowSpecRevision)
            .previousId ||
        native.entity_id !==
          ("instanceId" in after
            ? after.instanceId
            : `spec:${(after as WorkflowSpecRevision).workflowId}`) ||
        native.previous_id !==
          (receipt.beforeRevisionId
            ? (
                storage.revision(
                  receipt.beforeRevisionId,
                  receipt.workspaceId,
                ) as WorkflowInstanceRevision | WorkflowSpecRevision
              ).lastReceiptId
            : null)
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
    }
  }
  if (stageRows.some((id) => !referencedStages.has(id)))
    workflowError("WORKFLOW_DATABASE_INVALID");
  for (const row of storage.db
    .prepare(
      "SELECT workspace_id,kind,entity_id FROM workflow_heads LIMIT 4097",
    )
    .all()) {
    check();
    verifyHead(
      String(row.workspace_id),
      row.kind as "spec" | "instance" | "stage",
      String(row.entity_id),
    );
  }
}
