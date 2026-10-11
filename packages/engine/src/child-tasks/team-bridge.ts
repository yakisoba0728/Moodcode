import { types } from "node:util";
import {
  EngineError,
  isTerminal,
  type InputReceipt,
  type Run,
} from "@moodcode/contracts";
import { normalizeAcceptInput } from "@moodcode/contracts/validation";
import type { MoodcodeEngine } from "../engine.js";
import type { ChildTaskRecord } from "./index.js";
import {
  childStoragePhysicalIdentity,
  validateChildStorageRecord,
  type ChildStorageRecord,
} from "./storage-binding.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { sha256Hex } from "../shared/canonical.js";

export interface ChildTeamTarget {
  rootSessionId: string;
  rootRunId: string;
  parentRunId: string;
  childTaskId: string;
  childSessionId: string;
  childRunId: string;
  workspaceId: string;
  worktreeId: string;
  storageBindingSha256: string;
}
export interface ChildTeamInputEvidence extends ChildTeamTarget {
  requestId: string;
  promptSha256: string;
  inputSha256: string;
  inputId: string;
  admittedSeq: number;
  inputState: InputReceipt["state"];
  delivery: "steer" | "queue";
  duplicate: boolean;
}
export interface LiveChildTeamExecution {
  task: ChildTaskRecord;
  engine: MoodcodeEngine;
  sessionId: string;
  runId: string;
  closed: boolean;
  parentRun: Run;
  rootRun: Run;
  storageRecord: ChildStorageRecord;
  mirrorRecord: ChildStorageRecord;
  resident?: import("./resident.js").ResidentChild;
}
function stale(): never {
  throw new EngineError(
    "TEAM_CHILD_STALE",
    "Team input requires its actual live child and unchanged storage lineage",
  );
}
function originalJson(value: object): string {
  if (
    !value ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    stale();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") stale();
    const descriptor = descriptors[key]!;
    if (
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      !["string", "number", "boolean"].includes(typeof descriptor.value)
    )
      stale();
  }
  return JSON.stringify(value);
}

/** Admits a steer to an already owned Run. This port never calls a scheduler wake. */
export class ActualChildTeamBridge {
  private readonly targets = new WeakMap<ChildTeamTarget, string>();
  private readonly pending = new Map<ChildTeamTarget, ChildTeamInputEvidence>();
  private readonly admissions = new WeakMap<
    ChildTeamInputEvidence,
    { target: ChildTeamTarget; release(): void }
  >();
  private readonly receipts = new WeakMap<ChildTeamInputEvidence, string>();
  constructor(
    private readonly resolve: (
      rootSessionId: string,
      childTaskId: string,
    ) => LiveChildTeamExecution,
  ) {}

  private current(
    rootSessionId: string,
    childTaskId: string,
  ): { execution: LiveChildTeamExecution; target: ChildTeamTarget } {
    const execution = this.resolve(rootSessionId, childTaskId);
    const { task, engine } = execution;
    const run = engine.store.getRun(execution.runId);
    if (
      execution.closed ||
      task.state !== "running" ||
      task.sessionId !== rootSessionId ||
      task.id !== childTaskId ||
      task.childRunId !== run.id ||
      run.sessionId !== execution.sessionId ||
      (!execution.resident &&
        !["created", "running", "awaiting_approval"].includes(run.state)) ||
      isTerminal(execution.parentRun.state) ||
      execution.parentRun.state === "cancelling" ||
      isTerminal(execution.rootRun.state) ||
      execution.rootRun.state === "cancelling" ||
      engine.store.getSessionControl(run.sessionId).paused
    )
      stale();
    execution.resident?.assertCurrent();
    engine.coordinator.assertWorkspaceCleanupConfirmed(run.workspaceId);
    const record = validateChildStorageRecord(execution.storageRecord);
    const mirror = validateChildStorageRecord(execution.mirrorRecord);
    const { binding } = record;
    if (
      record.confirmedClose ||
      mirror.confirmedClose ||
      record.sha256 !== mirror.sha256 ||
      binding.phase !== "admitted" ||
      binding.lineage.sessionId !== rootSessionId ||
      binding.lineage.sourceRunId !== task.rootRunId ||
      binding.lineage.parentRunId !== task.parentRunId ||
      binding.lineage.taskId !== task.id ||
      binding.lineage.taskFingerprint !== task.fingerprint ||
      binding.child.sessionId !== run.sessionId ||
      binding.child.runId !== run.id ||
      binding.child.workspaceId !== run.workspaceId ||
      binding.worktree.id !== task.worktreeId ||
      binding.child.root !== engine.store.getWorkspace(run.workspaceId).root
    )
      stale();
    for (const name of ["database", "owner", "artifacts"] as const) {
      const original = binding.physical[name];
      const actual = childStoragePhysicalIdentity(
        original.path,
        name === "artifacts",
      );
      if (JSON.stringify(actual) !== JSON.stringify(original)) stale();
    }
    const actualRoot = childStoragePhysicalIdentity(
      binding.worktree.root,
      true,
    );
    if (
      actualRoot.dev !== binding.worktree.device ||
      actualRoot.ino !== binding.worktree.inode
    )
      stale();
    return {
      execution,
      target: {
        rootSessionId,
        rootRunId: task.rootRunId,
        parentRunId: task.parentRunId,
        childTaskId,
        childSessionId: run.sessionId,
        childRunId: run.id,
        workspaceId: run.workspaceId,
        worktreeId: task.worktreeId,
        storageBindingSha256: record.sha256,
      },
    };
  }

  capture(rootSessionId: string, childTaskId: string): ChildTeamTarget {
    const target = this.current(rootSessionId, childTaskId).target;
    this.targets.set(target, originalJson(target));
    return target;
  }

  readTarget(target: ChildTeamTarget): Readonly<ChildTeamTarget> {
    const captured = this.targets.get(target);
    if (captured === undefined || captured !== originalJson(target)) stale();
    return JSON.parse(captured) as ChildTeamTarget;
  }

  assertCurrent(target: ChildTeamTarget): void {
    const captured = JSON.stringify(this.readTarget(target));
    if (
      JSON.stringify(
        this.current(target.rootSessionId, target.childTaskId).target,
      ) !== captured
    )
      stale();
  }

  /** Checked before a delivery is dispatched, so a rejection here leaves no uncertain input. */
  assertAdmissible(target: ChildTeamTarget): void {
    this.assertCurrent(target);
    this.resolve(
      target.rootSessionId,
      target.childTaskId,
    ).resident?.assertAdmissible();
  }

  accept(
    target: ChildTeamTarget,
    input: { requestId: string; prompt: string },
  ): ChildTeamInputEvidence {
    const exactInput = JSON.parse(originalJson(input)) as {
      requestId: string;
      prompt: string;
    };
    if (
      Object.keys(exactInput).length !== 2 ||
      typeof exactInput.requestId !== "string" ||
      typeof exactInput.prompt !== "string"
    )
      stale();
    const original = this.targets.get(target);
    if (original === undefined || original !== originalJson(target)) stale();
    const current = this.current(target.rootSessionId, target.childTaskId);
    if (JSON.stringify(current.target) !== original) stale();
    if (current.execution.resident) {
      const admitted = current.execution.resident.accept(exactInput);
      const evidence: ChildTeamInputEvidence = {
        ...target,
        childRunId: admitted.run.id,
        requestId: exactInput.requestId,
        promptSha256: sha256Hex(exactInput.prompt),
        inputSha256: admitted.inputSha256,
        inputId: admitted.input.id,
        admittedSeq: admitted.admittedSeq,
        inputState: admitted.input.state,
        delivery: "queue",
        duplicate: false,
      };
      this.receipts.set(evidence, originalJson(evidence));
      this.admissions.set(evidence, { target, release: admitted.release });
      this.pending.set(target, evidence);
      return evidence;
    }
    const run = current.execution.engine.store.getRun(target.childRunId);
    const normalized = normalizeAcceptInput({
      sessionId: target.childSessionId,
      requestId: exactInput.requestId,
      prompt: exactInput.prompt,
      delivery: "steer",
      config: run.config,
    });
    // Only the existing child scheduler's synchronous model boundary can promote this input.
    const receipt = current.execution.engine.store.acceptInput(normalized);
    const record = current.execution.engine.store.getInput(receipt.inputId);
    if (
      record.id !== receipt.inputId ||
      record.sessionId !== target.childSessionId ||
      record.workspaceId !== target.workspaceId ||
      record.requestId !== exactInput.requestId ||
      record.admittedSeq !== receipt.admittedSeq ||
      record.state !== receipt.state ||
      record.state === "cancelled" ||
      record.delivery !== "steer" ||
      record.prompt !== exactInput.prompt ||
      JSON.stringify(record.config) !== JSON.stringify(run.config) ||
      (record.state === "promoted" && record.runId !== target.childRunId)
    )
      stale();
    const evidence: ChildTeamInputEvidence = {
      ...target,
      requestId: exactInput.requestId,
      promptSha256: sha256Hex(exactInput.prompt),
      inputSha256: knowledgeHash(normalized),
      inputId: receipt.inputId,
      admittedSeq: receipt.admittedSeq,
      inputState: receipt.state,
      delivery: "steer",
      duplicate: receipt.duplicate,
    };
    this.receipts.set(evidence, originalJson(evidence));
    return evidence;
  }

  readReceipt(
    original: ChildTeamInputEvidence,
  ): Readonly<ChildTeamInputEvidence> {
    const captured = this.receipts.get(original);
    if (captured === undefined || captured !== originalJson(original)) stale();
    return JSON.parse(captured) as ChildTeamInputEvidence;
  }

  readAccepted(target: ChildTeamTarget, original: ChildTeamInputEvidence) {
    const capturedTarget = this.readTarget(target);
    const captured = this.readReceipt(original);
    for (const key of Object.keys(capturedTarget) as (keyof ChildTeamTarget)[])
      if (
        !(key === "childRunId" && captured.delivery === "queue") &&
        captured[key] !== capturedTarget[key]
      )
        stale();
    if (captured.inputState === "cancelled") stale();
    return {
      childSessionId: captured.childSessionId,
      childRunId: captured.childRunId,
      inputId: captured.inputId,
      admittedSeq: captured.admittedSeq,
      requestId: captured.requestId,
      promptSha256: captured.promptSha256,
      inputSha256: captured.inputSha256,
      delivery: captured.delivery,
      state: captured.inputState as "pending" | "promoted",
    };
  }

  confirm(target: ChildTeamTarget, accepted: ChildTeamInputEvidence): void {
    this.readAccepted(target, accepted);
    const admission = this.admissions.get(accepted);
    if (admission) {
      if (admission.target !== target) stale();
      admission.release();
      this.admissions.delete(accepted);
      this.pending.delete(target);
    }
  }
  release(target: ChildTeamTarget): void {
    if (this.pending.has(target)) {
      this.pending.delete(target);
      try {
        this.resolve(
          target.rootSessionId,
          target.childTaskId,
        ).resident?.abandon();
      } catch {}
    }
    this.targets.delete(target);
  }
}
