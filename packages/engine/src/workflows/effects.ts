import { realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { normalizeAcceptInput } from "@moodcode/contracts/validation";
import {
  EngineError,
  type JsonObject,
  type Run,
  type RunConfigInput,
} from "@moodcode/contracts";
import type { MoodcodeEngine } from "../engine.js";
import type { EngineRuntime } from "../engine-runtime.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { readStableFile } from "../shared/fs.js";
import {
  describeQueueTarget,
  jobTargetChanged,
  type QueueTargetRuntime,
} from "../runner/queue-target.js";
import { runGit } from "../workspace/git.js";
import {
  childStorageKind,
  validateChildStorageRecord,
} from "../child-tasks/storage-binding.js";
import type {
  WorkflowService,
  ActualWorkflowChildObservationPort,
} from "./service.js";
import type { WorkflowSpec } from "./types.js";
import type { WorkflowInstanceRevision } from "./reducer.js";
import {
  workflowAbort,
  workflowHostRecord,
  type ActualWorkflowOwnerPort,
} from "./host.js";
import {
  readonlyWorkflowRole,
  workflowJson,
  workflowIdentifier,
} from "./spec.js";
import {
  effectFail,
  signEffect,
  formatWorkflowResult,
  type WorkflowFilePin,
  type WorkflowEffectRecord,
  type WorkflowDeliveryTargetProof,
  type WorkflowEffectStorage,
} from "./effects-records.js";
export function filePin(path: string): WorkflowFilePin {
  const stale = (): never => effectFail("WORKFLOW_SOURCE_STALE");
  try {
    const { stats, bytes, sha256 } = readStableFile(path, {
      maxBytes: 1048576,
      stable: ["size", "mtime", "ctime"],
      requireSingleLink: true,
      onChanged: stale,
      onLimit: () => effectFail("WORKFLOW_EFFECT_LIMIT"),
    });
    if (realpathSync(path) !== path) stale();
    return {
      path,
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      size: bytes,
      sha256,
    };
  } catch (error) {
    if (error instanceof EngineError) throw error;
    return stale();
  }
}
export function pinsCurrent(pins: readonly WorkflowFilePin[]): void {
  for (const pin of pins)
    if (knowledgeHash(filePin(pin.path)) !== knowledgeHash(pin))
      effectFail("WORKFLOW_SOURCE_STALE");
}
function effectPinsCurrent(effect: WorkflowEffectRecord): void {
  pinsCurrent(effect.files);
  pinsCurrent(effect.artifacts);
  if (effect.merge) pinsCurrent(effect.merge.parentFiles);
}
interface EffectOriginal {
  record: WorkflowEffectRecord | null;
  check: () => void;
}
interface TargetOriginal {
  proof: WorkflowDeliveryTargetProof;
  check: () => void;
}
/** One Root-constructed consumer owns all ORIGINAL child effect and delivery target handles. */
export class WorkflowEffects {
  private readonly effects = new Map<object, EffectOriginal>();
  private readonly targets = new Map<object, TargetOriginal>();
  private native!: WorkflowEffectStorage;
  private closed = false;
  batchPolicy?: {
    merge(record: WorkflowInstanceRevision, stageId: string): JsonObject | null;
    settled(record: WorkflowEffectRecord): void;
  };
  constructor(
    private readonly engine: Pick<
      EngineRuntime,
      "coordinator" | "scheduler" | "children" | "verificationChecks"
    > &
      QueueTargetRuntime &
      Pick<MoodcodeEngine, "getWorkflow">,
    private readonly knowledgeBinding: (
      workspaceId: string,
    ) => KnowledgeHostBinding,
    private readonly service: () => WorkflowService,
    private readonly owners: ActualWorkflowOwnerPort,
    private readonly children: ActualWorkflowChildObservationPort,
    private readonly core: boolean,
    private readonly enabled: boolean,
  ) {}
  install(native: WorkflowEffectStorage) {
    this.native = native;
    native.recover();
    native.validate();
  }
  assertCandidateFiles(workspaceId: string, instanceId: string): void {
    const { record, owner } = this.service().effectOwner(
      workspaceId,
      instanceId,
    );
    this.owners.assertSettling(owner.original, record.owner);
    for (const effect of this.effectRecords(record)) {
      this.owners.assertWorktreeCurrent(
        owner.original,
        record.worktrees[effect.stageId]!,
      );
      pinsCurrent(effect.files);
      pinsCurrent(effect.artifacts);
    }
  }
  assertMergeCandidate(
    workspaceId: string,
    instanceId: string,
    stageId: string,
  ) {
    return this.mergeSelection(
      this.service().effectOwner(workspaceId, instanceId).record,
      stageId,
    );
  }
  /** An observed editor with an observed validator on its worktree can still be merged. */
  mergePending(record: WorkflowInstanceRevision): boolean {
    const spec = this.specOf(record),
      state = (stageId: string) =>
        this.native.read(record.owner.sessionId, record.instanceId, stageId)
          ?.state;
    return spec.stages.some(
      (editor) =>
        editor.role === "editor" &&
        ["observed", "merge-dispatching"].includes(state(editor.id) ?? "") &&
        spec.stages.some(
          (validator) =>
            validator.role === "validator" &&
            validator.dependsOn.includes(editor.id) &&
            record.worktrees[validator.id]?.id ===
              record.worktrees[editor.id]?.id &&
            state(validator.id) === "observed",
        ),
    );
  }
  open() {
    if (this.closed) effectFail("WORKFLOW_CLOSED");
  }
  private specOf(record: WorkflowInstanceRevision): WorkflowSpec {
    return this.engine.getWorkflow(
      record.workspaceId,
      record.workflowId,
      record.specRevisionId,
    )!.spec;
  }
  issue<T>(map: Map<object, T>, value: T): object {
    this.open();
    if (map.size >= 64) effectFail("WORKFLOW_EFFECT_LIMIT");
    const original = Object.freeze(Object.create(null));
    map.set(original, value);
    return original;
  }
  /** @internal An effect ORIGINAL that the native store reads back through readEffect and assertEffect. */
  issueEffect(record: WorkflowEffectRecord | null, check: () => void): object {
    return this.issue(this.effects, { record, check });
  }
  publish(original: object, expectedRevision: number): WorkflowEffectRecord {
    return this.native.publish(original, expectedRevision);
  }
  assertSupported(original: object, spec: WorkflowSpec): void {
    if (spec.stages.every((s) => readonlyWorkflowRole(s.role))) return;
    if (!this.core) effectFail("WORKFLOW_EFFECT_UNSUPPORTED");
    const owner = this.owners.read(original),
      config = this.engine.store.getRun(owner.runId).config;
    if (config.mode !== "build") effectFail("WORKFLOW_EFFECT_PLAN_BLOCKED");
    for (const stage of spec.stages.filter((s) => s.role === "validator")) {
      if (
        !stage.verification ||
        !stage.tools.includes("verify_changes") ||
        !stage.tools.includes("run_command") ||
        !owner.profile
      )
        effectFail("WORKFLOW_VERIFICATION_UNSUPPORTED");
      for (const id of stage.verification.checkIds) {
        const check = this.engine.verificationChecks.capture(id);
        if (
          check.workspaceId !== owner.workspaceId ||
          check.profileId !== owner.profile.id ||
          check.profileRevision !== owner.profile.revision
        )
          effectFail("WORKFLOW_VERIFICATION_STALE");
      }
    }
    for (const stage of spec.stages.filter((s) => s.role === "editor"))
      if (
        !stage.tools.includes("apply_patch") ||
        !spec.stages.some(
          (s) => s.role === "validator" && s.dependsOn.includes(stage.id),
        )
      )
        effectFail("WORKFLOW_VALIDATOR_REQUIRED");
  }
  async captureChild(
    before: WorkflowInstanceRevision,
    stageId: string,
    originalCompletion: object,
  ): Promise<object> {
    this.open();
    const stage = this.specOf(before).stages.find((s) => s.id === stageId)!,
      none = () => this.issueEffect(null, () => {});
    if (readonlyWorkflowRole(stage.role)) return none();
    const completion = this.children.readCompletion(originalCompletion);
    if (completion.state !== "completed" || !completion.complete) return none();
    const evidence = this.children.readExecution(originalCompletion),
      pin = before.worktrees[stageId]!;
    if (
      evidence.run.state !== "completed" ||
      evidence.cleanups.some(
        (c) => c.state !== "confirmed" || !c.cleanupConfirmed,
      )
    )
      effectFail("WORKFLOW_CLEANUP_UNCERTAIN");
    if (evidence.snapshot.tools.some((t) => t.state !== "completed"))
      effectFail("WORKFLOW_CHILD_EFFECT_FAILED");
    const { owner } = this.service().effectOwner(
      before.workspaceId,
      before.instanceId,
    );
    this.owners.assertSettling(owner.original, before.owner);
    this.owners.assertWorktreeCurrent(owner.original, pin);
    let paths: string[];
    if (stage.role === "editor") {
      const git = await runGit(pin.root, [
          "diff",
          "--no-renames",
          "--name-only",
          "-z",
          pin.baseCommit,
          "--",
        ]),
        untracked = await runGit(pin.root, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ]),
        deleted = await runGit(pin.root, [
          "diff",
          "--no-renames",
          "--diff-filter=D",
          "--name-only",
          "-z",
          pin.baseCommit,
          "--",
        ]);
      if (git.code || untracked.code || deleted.code)
        effectFail("WORKFLOW_SOURCE_STALE");
      if (deleted.stdout.length) effectFail("WORKFLOW_CHILD_EFFECT_FAILED");
      paths = [
        ...new Set(
          Buffer.concat([git.stdout, untracked.stdout])
            .toString()
            .split("\0")
            .filter(Boolean),
        ),
      ];
      if (
        !paths.length ||
        paths.length > 32 ||
        !evidence.checkpoints.some((c) => c.kind === "patch" && !c.incomplete)
      )
        effectFail("WORKFLOW_EDITOR_NO_EFFECT");
    } else {
      paths = [...stage.verification!.sourcePaths];
      const v = evidence.verification;
      if (
        !v ||
        stage.verification!.checkIds.some(
          (id) =>
            !v.receipts.some(
              (r) =>
                r.checkId === id &&
                r.phase === "settled" &&
                r.status === "pass" &&
                r.observation?.cleanup.confirmed &&
                r.observation.executionComplete &&
                r.sourceStale === false,
            ),
        )
      )
        effectFail("WORKFLOW_VERIFICATION_FAILED");
    }
    const files = paths.sort().map((p) => {
      if (p.startsWith("/") || p.split("/").includes("..")) effectFail();
      return filePin(join(pin.root, p));
    });
    const storage = validateChildStorageRecord(
        this.engine.store.getSessionDocument(
          before.owner.sessionId,
          childStorageKind(completion.child.taskId),
        )!.data,
      ),
      artifacts: WorkflowFilePin[] = [];
    for (const receipt of evidence.verification?.receipts ?? [])
      for (const ref of receipt.observation?.artifactRefs ?? []) {
        const path = join(
          storage.binding.physical.artifacts.path,
          "managed",
          ref.id,
        );
        const content = filePin(join(path, "content"));
        if (
          content.sha256 !== ref.sha256 ||
          content.size !== ref.storedBytes ||
          !ref.complete
        )
          effectFail("WORKFLOW_ARTIFACT_STALE");
        artifacts.push(content, filePin(join(path, "manifest.json")));
      }
    const record = signEffect({
      version: 1 as const,
      instanceId: before.instanceId,
      workspaceId: before.workspaceId,
      sessionId: before.owner.sessionId,
      stageId,
      role: stage.role as "editor" | "validator",
      revision: 1,
      previousSha256: null,
      stageRevisionId: "pending",
      specSha256: before.specSha256,
      completion,
      evidence,
      files,
      artifacts,
      state: "observed" as const,
      merge: null,
    });
    return this.issueEffect(record, () => {
      this.owners.assertSettling(owner.original, before.owner);
      this.owners.assertWorktreeCurrent(owner.original, pin);
      pinsCurrent(files);
      pinsCurrent(artifacts);
      if (
        this.children.readCompletion(originalCompletion).sha256 !==
        completion.sha256
      )
        effectFail("WORKFLOW_CHILD_STALE");
    });
  }
  commitChild(original: object, settled: WorkflowInstanceRevision): void {
    const state = this.effects.get(original);
    if (!state) effectFail("WORKFLOW_ORIGINAL_REQUIRED");
    const { record } = state;
    if (!record) return;
    const stage = settled.stages.find((s) => s.stageId === record.stageId)!;
    state.record = signEffect({ ...record, stageRevisionId: stage.id });
    this.native.publish(original, 0);
  }
  readEffect(original: object): WorkflowEffectRecord {
    const entry = this.effects.get(original);
    if (!entry?.record) effectFail("WORKFLOW_ORIGINAL_REQUIRED");
    return structuredClone(entry.record);
  }
  assertEffect(original: object): void {
    const entry = this.effects.get(original);
    if (!entry?.record) effectFail("WORKFLOW_ORIGINAL_REQUIRED");
    entry.check();
  }
  release(original: object): void {
    this.effects.delete(original);
    this.targets.delete(original);
  }
  private effectRecords(
    record: WorkflowInstanceRevision,
  ): WorkflowEffectRecord[] {
    return this.specOf(record)
      .stages.filter((s) => !readonlyWorkflowRole(s.role))
      .map((s) => {
        const r = this.native.read(
          record.owner.sessionId,
          record.instanceId,
          s.id,
        );
        if (!r) effectFail("WORKFLOW_EFFECT_MISSING");
        return r;
      });
  }
  async mergeSelection(
    record: WorkflowInstanceRevision,
    stageId: string,
  ): Promise<{
    editor: WorkflowEffectRecord;
    validator: WorkflowEffectRecord;
    head: string;
  }> {
    const spec = this.specOf(record),
      definition = spec.stages.find((s) => s.id === stageId),
      editor = this.native.read(
        record.owner.sessionId,
        record.instanceId,
        stageId,
      );
    if (
      definition?.role !== "editor" ||
      !editor ||
      editor.state !== "observed" ||
      record.stages.find((s) => s.stageId === stageId)?.state !== "completed"
    )
      effectFail("WORKFLOW_MERGE_UNAVAILABLE");
    const validators = spec.stages.filter(
        (s) =>
          s.role === "validator" &&
          s.dependsOn.includes(stageId) &&
          record.worktrees[s.id]?.id === record.worktrees[stageId]?.id,
      ),
      validator = validators
        .map((s) =>
          this.native.read(record.owner.sessionId, record.instanceId, s.id),
        )
        .find((v) => v?.state === "observed");
    if (!validator) effectFail("WORKFLOW_VERIFICATION_REQUIRED");
    if (
      editor.files.some(
        (p) =>
          !validator.files.some(
            (v) => v.path === p.path && knowledgeHash(v) === knowledgeHash(p),
          ),
      )
    )
      effectFail("WORKFLOW_VERIFICATION_SOURCE_STALE");
    pinsCurrent(editor.files);
    pinsCurrent(validator.files);
    pinsCurrent(validator.artifacts);
    const validatorDef = spec.stages.find((s) => s.id === validator.stageId)!;
    for (const id of validatorDef.verification!.checkIds) {
      const current = this.engine.verificationChecks.capture(id),
        captured = validator.evidence
          .verification!.plans.flatMap((p) => p.checks)
          .find((c) => c.id === id),
        { registrationSha256, ...definition } = current;
      const mapped = {
        ...definition,
        workspaceId: validator.evidence.run.workspaceId,
        cwd: join(
          record.worktrees[validator.stageId]!.root,
          relative(
            this.engine.store.getWorkspace(record.workspaceId).root,
            current.cwd,
          ),
        ),
      };
      if (!captured) effectFail("WORKFLOW_VERIFICATION_STALE");
      const { registrationSha256: childRegistration, ...childDefinition } =
        captured;
      if (knowledgeHash(mapped) !== knowledgeHash(childDefinition))
        effectFail("WORKFLOW_VERIFICATION_STALE");
    }
    const git = await runGit(
      this.engine.store.getWorkspace(record.workspaceId).root,
      ["rev-parse", "HEAD"],
    );
    const head = git.stdout.toString().trim();
    if (git.code || head !== record.worktrees[stageId]!.baseCommit)
      effectFail("WORKFLOW_PARENT_HEAD_STALE");
    return { editor, validator, head };
  }
  captureTarget(input: {
    workspaceId: string;
    instanceId: string;
    config: RunConfigInput;
  }): object {
    return this.issue(this.targets, this.target(input));
  }
  target(input: {
    workspaceId: string;
    instanceId: string;
    config: RunConfigInput;
  }): TargetOriginal {
    workflowHostRecord(input, ["workspaceId", "instanceId", "config"]);
    this.open();
    const { record, owner } = this.service().effectOwner(
      input.workspaceId,
      input.instanceId,
    );
    this.owners.assertSettling(owner.original, record.owner);
    if (record.state !== "completed" || record.result === null)
      effectFail("WORKFLOW_RESULT_INCOMPLETE");
    const effects = this.effectRecords(record);
    for (const e of effects) if (e.merge) pinsCurrent(e.merge.parentFiles);
    if (
      effects.some(
        (e) => e.state !== (e.role === "editor" ? "merged" : "observed"),
      )
    )
      effectFail("WORKFLOW_MERGE_REQUIRED");
    const normalized = normalizeAcceptInput({
      sessionId: record.owner.sessionId,
      requestId: "workflow-target",
      prompt: "workflow-target",
      config: workflowJson(input.config),
      delivery: "queue",
    });
    normalized.config = this.engine.profiles.apply(
      record.owner.sessionId,
      normalized.config,
    );
    const target = describeQueueTarget(
        this.engine,
        this.knowledgeBinding,
        record.workspaceId,
        record.owner.sessionId,
        normalized.config,
        jobTargetChanged,
      ).pin,
      proof = signEffect({
        version: 1 as const,
        source: record,
        effects,
        target,
      });
    formatWorkflowResult(proof);
    const check = () => {
      const current = this.service().effectOwner(
        record.workspaceId,
        record.instanceId,
      );
      this.owners.assertSettling(owner.original, record.owner);
      if (
        current.record.sha256 !== record.sha256 ||
        knowledgeHash(this.effectRecords(current.record)) !==
          knowledgeHash(effects) ||
        knowledgeHash(
          describeQueueTarget(
            this.engine,
            this.knowledgeBinding,
            record.workspaceId,
            record.owner.sessionId,
            target.config,
            jobTargetChanged,
          ).pin,
        ) !== knowledgeHash(target)
      )
        effectFail("WORKFLOW_DELIVERY_STALE");
      for (const effect of effects) effectPinsCurrent(effect);
    };
    check();
    return { proof, check };
  }
  readTarget(original: object): WorkflowDeliveryTargetProof {
    const target = this.targets.get(original);
    if (!target) effectFail("WORKFLOW_ORIGINAL_REQUIRED");
    return structuredClone(target.proof);
  }
  assertTarget(original: object): void {
    const target = this.targets.get(original);
    if (!target) effectFail("WORKFLOW_ORIGINAL_REQUIRED");
    target.check();
  }
  accept(original: object, input: { requestId: string; prompt: string }) {
    this.assertTarget(original);
    const proof = this.readTarget(original),
      receipt = this.engine.store.acceptInput({
        sessionId: proof.target.sessionId,
        requestId: input.requestId,
        prompt: input.prompt,
        config: proof.target.config,
        delivery: "queue",
      });
    this.engine.store.publishAfterCommit(() => {
      void this.engine.scheduler.wake(proof.target.sessionId).catch(() => {});
    });
    return receipt;
  }
  deliver(input: {
    workspaceId: string;
    requestId: string;
    expectedRevision: 0;
    target: object;
    approved: boolean;
    signal?: AbortSignal;
  }) {
    workflowHostRecord(
      input,
      ["workspaceId", "requestId", "expectedRevision", "target", "approved"],
      ["signal"],
    );
    workflowAbort(input.signal);
    this.open();
    workflowIdentifier(input.requestId);
    if (input.expectedRevision !== 0 || input.approved !== true)
      effectFail("WORKFLOW_APPROVAL_REQUIRED");
    const proof = this.readTarget(input.target);
    if (input.workspaceId !== proof.source.workspaceId)
      effectFail("WORKFLOW_DELIVERY_STALE");
    return structuredClone(
      this.native.deliver(input.target, {
        workspaceId: input.workspaceId,
        instanceId: proof.source.instanceId,
        requestId: input.requestId,
        targetSha256: proof.sha256,
        expectedRevision: 0,
      }),
    );
  }
  beforeInput(inputId: string, requestId: string, run?: Run): void {
    const receipt = this.native.findInput(inputId, requestId);
    if (!receipt) return;
    if (!this.enabled) effectFail("WORKFLOWS_DISABLED");
    if (receipt.state !== "accepted") effectFail("WORKFLOW_IMPORT_PAUSED");
    const target = describeQueueTarget(
      this.engine,
      this.knowledgeBinding,
      receipt.workspaceId,
      receipt.sessionId,
      run?.config ?? receipt.target.config,
      jobTargetChanged,
    ).pin;
    if (knowledgeHash(target) !== knowledgeHash(receipt.target))
      effectFail("WORKFLOW_DELIVERY_STALE");
    for (const e of receipt.effects) {
      const current = this.native.read(
        receipt.sessionId,
        receipt.instanceId,
        e.stageId,
      );
      if (current?.sha256 !== e.sha256) effectFail("WORKFLOW_SOURCE_STALE");
      effectPinsCurrent(e);
    }
  }
  close(): void {
    this.closed = true;
    this.effects.clear();
    this.targets.clear();
  }
}
