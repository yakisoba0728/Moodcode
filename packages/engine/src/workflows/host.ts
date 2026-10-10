import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import type { ChildBudget } from "../child-tasks/index.js";
import { CHILD_BUDGET_KEYS } from "../child-tasks/journal.js";
import { knowledgeHash } from "../knowledge/validation.js";
import type {
  WorkflowSpecRevision,
  WorkflowOwnerProof,
  WorkflowWorktreePin,
} from "./store.js";
import type {
  WorkflowModelPin,
  WorkflowProfilePin,
  WorkflowSpec,
} from "./types.js";
import {
  validateWorkflowValue,
  workflowError,
  workflowIdentifier,
  workflowInteger,
  workflowJson,
  WORKFLOW_READ_TOOLS,
  validateNewWorkflowWorktreeSharing,
} from "./spec.js";

export function workflowHostRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    workflowError("INVALID_WORKFLOW_INPUT");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    required.some((key) => !Object.hasOwn(descriptors, key)) ||
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== "string" ||
        ![...required, ...optional].includes(key) ||
        !descriptors[key]!.enumerable ||
        !Object.hasOwn(descriptors[key]!, "value"),
    )
  )
    workflowError("INVALID_WORKFLOW_INPUT");
  return value as Record<string, unknown>;
}
function workflowSignal(value?: AbortSignal): boolean {
  if (value === undefined) return false;
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    !(value instanceof AbortSignal)
  )
    workflowError("INVALID_WORKFLOW_INPUT");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    [
      "aborted",
      "reason",
      "addEventListener",
      "removeEventListener",
      "throwIfAborted",
    ].some((key) => Object.hasOwn(descriptors, key))
  )
    workflowError("INVALID_WORKFLOW_INPUT");
  try {
    return Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      "aborted",
    )!.get!.call(value);
  } catch {
    workflowError("INVALID_WORKFLOW_INPUT");
  }
}
export function workflowAbort(signal?: AbortSignal): void {
  if (workflowSignal(signal))
    throw new EngineError("CANCELLED", "Workflow request was cancelled");
}
export interface WorkflowParentConfiguration {
  readonly profile: WorkflowProfilePin | null;
  readonly model: WorkflowModelPin;
  readonly tools: readonly string[];
  readonly remainingBudget: ChildBudget;
}
/** The root issues an original owner from its live coordinator, never caller-described Run IDs alone. */
export interface ActualWorkflowOwnerPort {
  capture(
    selection: {
      workspaceId: string;
      rootSessionId: string;
      parentRunId: string;
      worktrees: Readonly<Record<string, string>>;
    },
    signal?: AbortSignal,
  ): Promise<object>;
  read(original: object): WorkflowOwnerProof;
  assertCurrent(original: object, expected: WorkflowOwnerProof): void;
  /** Existing dispatched work may settle after parent cancellation; this permits no new dispatch. */
  assertSettling(original: object, expected: WorkflowOwnerProof): void;
  configuration(original: object): WorkflowParentConfiguration;
  worktree(original: object, worktreeId: string): WorkflowWorktreePin;
  assertWorktreeCurrent(original: object, expected: WorkflowWorktreePin): void;
  release(original: object): void;
}
export interface PreviewWorkflowStartInput {
  readonly workspaceId: string;
  readonly rootSessionId: string;
  readonly parentRunId: string;
  readonly workflowId: string;
  readonly expectedSpecRevision: number;
  readonly parameters: JsonObject;
  readonly stageWorktrees: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}
export interface WorkflowStartPreview {
  readonly schemaVersion: 1;
  readonly projection: "workflow-start-preview-v1";
  readonly id: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly specRevisionId: string;
  readonly specRevision: number;
  readonly specSha256: string;
  readonly owner: WorkflowOwnerProof;
  readonly parameters: JsonObject;
  readonly worktrees: Readonly<Record<string, WorkflowWorktreePin>>;
  readonly readonlyStages: boolean;
  readonly automaticParentDelivery: false;
  readonly sha256: string;
}
export interface OwnedWorkflowPreview {
  readonly preview: WorkflowStartPreview;
  readonly originalOwner: object;
  readonly spec: WorkflowSpec;
  readonly selection: PreviewWorkflowStartInput;
  usedRequestId: string | null;
  released: boolean;
}
export interface WorkflowHostPorts {
  readonly owner: ActualWorkflowOwnerPort;
  assertEffectsSupported(original: object, spec: WorkflowSpec): void;
  getWorkflow(
    workspaceId: string,
    workflowId: string,
    revisionId?: string,
  ): WorkflowSpecRevision | undefined;
}

/** Original previews observe an immutable spec and actual pre-created worktrees; approval is a separate action. */
export class WorkflowHost {
  private readonly originals = new WeakMap<object, OwnedWorkflowPreview>();
  private readonly retained = new Set<OwnedWorkflowPreview>();
  private closed = false;
  constructor(readonly ports: WorkflowHostPorts) {}
  private open(): void {
    if (this.closed) workflowError("WORKFLOW_CLOSED");
  }
  assertConfiguration(
    original: object,
    owner: WorkflowOwnerProof,
    spec: WorkflowSpec,
    stages = spec.stages,
    reserved = false,
  ): WorkflowParentConfiguration {
    this.ports.owner.assertCurrent(original, owner);
    const configuration = workflowJson(
      this.ports.owner.configuration(original),
    );
    if (knowledgeHash(configuration.profile) !== knowledgeHash(owner.profile))
      workflowError("WORKFLOW_OWNER_STALE");
    this.ports.assertEffectsSupported(original, spec);
    const allocation: ChildBudget = {
      turns: 0,
      toolCalls: 0,
      outputBytes: 0,
      durationMs: 0,
    };
    for (const stage of stages) {
      const readonly = ["planner", "advisory-reviewer"].includes(stage.role);
      const allowed = readonly
        ? WORKFLOW_READ_TOOLS
        : stage.role === "editor"
          ? [...WORKFLOW_READ_TOOLS, "apply_patch"]
          : [...WORKFLOW_READ_TOOLS, "run_command", "verify_changes"];
      if (
        knowledgeHash(stage.profile) !== knowledgeHash(configuration.profile) ||
        knowledgeHash(stage.model) !== knowledgeHash(configuration.model)
      )
        workflowError("WORKFLOW_PROFILE_MODEL_UNSUPPORTED");
      if (
        stage.tools.length > 8 ||
        stage.tools.some(
          (name) =>
            !allowed.includes(name) || !configuration.tools.includes(name),
        )
      )
        workflowError("WORKFLOW_STAGE_TOOL_ESCALATION");
      // Native child pools reserve all four dimensions, including duration, across siblings.
      for (const key of CHILD_BUDGET_KEYS)
        allocation[key] += stage.allocation[key];
    }
    for (const key of CHILD_BUDGET_KEYS)
      if (!reserved && allocation[key] > configuration.remainingBudget[key])
        workflowError("WORKFLOW_BUDGET_EXCEEDED");
    return configuration;
  }
  async previewStart(
    input: PreviewWorkflowStartInput,
  ): Promise<WorkflowStartPreview> {
    this.open();
    workflowHostRecord(
      input,
      [
        "workspaceId",
        "rootSessionId",
        "parentRunId",
        "workflowId",
        "expectedSpecRevision",
        "parameters",
        "stageWorktrees",
      ],
      ["signal"],
    );
    workflowAbort(input.signal);
    const { signal, ...data } = input,
      selection = workflowJson(data);
    for (const id of [
      selection.workspaceId,
      selection.rootSessionId,
      selection.parentRunId,
      selection.workflowId,
    ])
      workflowIdentifier(id);
    workflowInteger(selection.expectedSpecRevision, Number.MAX_SAFE_INTEGER, 1);
    const registration = this.ports.getWorkflow(
      selection.workspaceId,
      selection.workflowId,
    );
    if (
      !registration ||
      registration.revision !== selection.expectedSpecRevision
    )
      workflowError("WORKFLOW_SPEC_STALE");
    const spec = registration.spec,
      parameters = validateWorkflowValue(
        spec.parameterSchema,
        selection.parameters,
      ) as JsonObject;
    if (
      Object.keys(selection.stageWorktrees).length !== spec.stages.length ||
      spec.stages.some(
        (stage) => !Object.hasOwn(selection.stageWorktrees, stage.id),
      )
    )
      workflowError("WORKFLOW_WORKTREE_SELECTION_INVALID");
    validateNewWorkflowWorktreeSharing(spec, selection.stageWorktrees);
    for (const id of Object.values(selection.stageWorktrees))
      workflowIdentifier(id);
    if (this.retained.size >= 32) workflowError("WORKFLOW_LIMIT");
    const originalOwner = await this.ports.owner.capture(
      {
        workspaceId: selection.workspaceId,
        rootSessionId: selection.rootSessionId,
        parentRunId: selection.parentRunId,
        worktrees: selection.stageWorktrees,
      },
      signal,
    );
    try {
      workflowAbort(signal);
      this.open();
      const owner = workflowJson(this.ports.owner.read(originalOwner));
      if (
        owner.workspaceId !== selection.workspaceId ||
        owner.sessionId !== selection.rootSessionId ||
        owner.runId !== selection.parentRunId
      )
        workflowError("WORKFLOW_OWNER_STALE");
      this.assertConfiguration(originalOwner, owner, spec);
      const worktrees: Record<string, WorkflowWorktreePin> = {};
      for (const stage of spec.stages) {
        const pin = workflowJson(
          this.ports.owner.worktree(
            originalOwner,
            selection.stageWorktrees[stage.id]!,
          ),
        );
        this.ports.owner.assertWorktreeCurrent(originalOwner, pin);
        worktrees[stage.id] = pin;
      }
      const current = this.ports.getWorkflow(
        selection.workspaceId,
        selection.workflowId,
      );
      if (
        !current ||
        current.id !== registration.id ||
        current.sha256 !== registration.sha256
      )
        workflowError("WORKFLOW_SPEC_STALE");
      const content = workflowJson({
        schemaVersion: 1 as const,
        projection: "workflow-start-preview-v1" as const,
        id: randomUUID(),
        workspaceId: selection.workspaceId,
        workflowId: selection.workflowId,
        specRevisionId: registration.id,
        specRevision: registration.revision,
        specSha256: spec.sha256,
        owner,
        parameters,
        worktrees,
        readonlyStages: spec.stages.every((stage) =>
          ["planner", "advisory-reviewer"].includes(stage.role),
        ),
        automaticParentDelivery: false as const,
      });
      const preview = workflowJson({
          ...content,
          sha256: knowledgeHash(content),
        }),
        state: OwnedWorkflowPreview = {
          preview,
          originalOwner,
          spec,
          selection: { ...selection, parameters },
          usedRequestId: null,
          released: false,
        };
      this.originals.set(preview, state);
      this.retained.add(state);
      return preview;
    } catch (error) {
      this.ports.owner.release(originalOwner);
      throw error;
    }
  }
  read(original: WorkflowStartPreview): OwnedWorkflowPreview {
    if (!original || types.isProxy(original))
      workflowError("WORKFLOW_PREVIEW_STALE");
    const state = this.originals.get(original);
    if (!state || state.released) workflowError("WORKFLOW_PREVIEW_STALE");
    this.open();
    return state;
  }
  release(original: WorkflowStartPreview): void {
    if (!original || types.isProxy(original)) return;
    const state = this.originals.get(original);
    if (!state || state.released) return;
    state.released = true;
    this.retained.delete(state);
    this.ports.owner.release(state.originalOwner);
  }
  /** Consumed ownership transfers to the service and must remain available for observed child settlement. */
  transfer(state: OwnedWorkflowPreview): void {
    this.retained.delete(state);
    state.released = true;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.retained) {
      state.released = true;
      this.ports.owner.release(state.originalOwner);
    }
    this.retained.clear();
  }
}
