import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, relative } from "node:path";
import { types } from "node:util";
import { normalizeAcceptInput } from "@moodcode/contracts/validation";
import {
  EngineError,
  type JsonObject,
  type Run,
  type RunConfigInput,
  type ToolCallRecord,
} from "@moodcode/contracts";
import type { MoodcodeEngine } from "../engine.js";
import type {
  ToolContext,
  ToolDefinition,
  PreparedTool,
  ToolResult,
} from "../ports.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { describeEngineQueueTarget } from "../jobs/queue-target.js";
import { runGit } from "../workspace/git.js";
import { createChildMergeTool } from "../child-tasks/merge.js";
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
  workflowJson,
  workflowIdentifier,
  WORKFLOW_READ_TOOLS,
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
export const WORKFLOW_MODEL_NAMES = [
  "request_workflow_stage",
  "observe_workflow_stage",
  "merge_workflow_stage",
  "deliver_workflow_result",
] as const;
function filePin(path: string): WorkflowFilePin {
  let fd: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size > 1048576n ||
      realpathSync(path) !== path
    )
      effectFail("WORKFLOW_SOURCE_STALE");
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const start = fstatSync(fd, { bigint: true }),
      hash = createHash("sha256"),
      chunk = Buffer.alloc(16384);
    let size = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      size += n;
      if (size > 1048576) effectFail("WORKFLOW_EFFECT_LIMIT");
      hash.update(chunk.subarray(0, n));
    }
    const after = fstatSync(fd, { bigint: true }),
      current = lstatSync(path, { bigint: true });
    if (
      start.dev !== before.dev ||
      start.ino !== before.ino ||
      start.dev !== after.dev ||
      start.ino !== after.ino ||
      start.size !== after.size ||
      start.mtimeNs !== after.mtimeNs ||
      start.ctimeNs !== after.ctimeNs ||
      current.dev !== after.dev ||
      current.ino !== after.ino ||
      current.mtimeNs !== after.mtimeNs ||
      current.ctimeNs !== after.ctimeNs ||
      realpathSync(path) !== path
    )
      effectFail("WORKFLOW_SOURCE_STALE");
    return {
      path,
      device: after.dev.toString(),
      inode: after.ino.toString(),
      size,
      sha256: hash.digest("hex"),
    };
  } catch (error) {
    if (error instanceof EngineError) throw error;
    return effectFail("WORKFLOW_SOURCE_STALE");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function pinsCurrent(pins: readonly WorkflowFilePin[]): void {
  for (const pin of pins)
    if (knowledgeHash(filePin(pin.path)) !== knowledgeHash(pin))
      effectFail("WORKFLOW_SOURCE_STALE");
}
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
interface EffectOriginal {
  record: WorkflowEffectRecord;
  check: () => void;
}
interface TargetOriginal {
  proof: WorkflowDeliveryTargetProof;
  check: () => void;
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
/** One Root-constructed consumer owns all ORIGINAL child/effect/model/target handles. */
export class WorkflowEffects {
  private readonly effects = new Map<object, EffectOriginal>();
  private readonly targets = new Map<object, TargetOriginal>();
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
  private native!: WorkflowEffectStorage;

batchPolicy?: {
    merge(
      record: WorkflowInstanceRevision,
      stageId: string,
      phase: "prepare" | "execute",
    ): JsonObject | null;
    settled(record: WorkflowEffectRecord): void;
  };
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
    const spec = this.engine.getWorkflow(
        record.workspaceId,
        record.workflowId,
        record.specRevisionId,
      )!.spec,
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
private closed = false;
  private readonly merge: ToolDefinition;
  constructor(
    private readonly engine: MoodcodeEngine,
    private readonly binding: (workspaceId: string) => KnowledgeHostBinding,
    private readonly service: () => WorkflowService,
    private readonly owners: ActualWorkflowOwnerPort,
    private readonly children: ActualWorkflowChildObservationPort,
    private readonly core: boolean,
    private readonly enabled: boolean,
  ) {
    this.merge = createChildMergeTool(
      engine.children.tasks,
      engine.children.worktrees,
    );
  }
  install(native: WorkflowEffectStorage) {
    this.native = native;
    native.recover();
    native.validate();
  }
  private open() {
    if (this.closed) effectFail("WORKFLOW_CLOSED");
  }
  private issue<T>(map: Map<object, T>, value: T): object {
    this.open();
    if (map.size >= 64) effectFail("WORKFLOW_EFFECT_LIMIT");
    const original = Object.freeze(Object.create(null));
    map.set(original, value);
    return original;
  }
  assertSupported(original: object, spec: WorkflowSpec): void {
    if (!spec.stages.some((s) => ["editor", "validator"].includes(s.role)))
      return;
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
    const spec = this.engine.getWorkflow(
        before.workspaceId,
        before.workflowId,
        before.specRevisionId,
      )!.spec,
      stage = spec.stages.find((s) => s.id === stageId)!;
    if (!["editor", "validator"].includes(stage.role))
      return this.issue(this.effects, {
        record: null as unknown as WorkflowEffectRecord,
        check: () => {},
      });
    const completion = this.children.readCompletion(originalCompletion);
    if (completion.state !== "completed" || !completion.complete)
      return this.issue(this.effects, {
        record: null as unknown as WorkflowEffectRecord,
        check: () => {},
      });
    if (!this.children.readExecution)
      effectFail("WORKFLOW_CHILD_EVIDENCE_UNAVAILABLE");
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
      const git = await runGit(
          pin.root,
          ["diff", "--no-renames", "--name-only", "-z", pin.baseCommit, "--"],
          { signal: new AbortController().signal },
        ),
        untracked = await runGit(
          pin.root,
          ["ls-files", "--others", "--exclude-standard", "-z"],
          { signal: new AbortController().signal },
        ),
        deleted = await runGit(
          pin.root,
          [
            "diff",
            "--no-renames",
            "--diff-filter=D",
            "--name-only",
            "-z",
            pin.baseCommit,
            "--",
          ],
          { signal: new AbortController().signal },
        );
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
    if (Buffer.byteLength(JSON.stringify(record)) > 131072)
      effectFail("WORKFLOW_EFFECT_LIMIT");
    return this.issue(this.effects, {
      record,
      check: () => {
        this.owners.assertSettling(owner.original, before.owner);
        this.owners.assertWorktreeCurrent(owner.original, pin);
        pinsCurrent(files);
        pinsCurrent(artifacts);
        if (
          this.children.readCompletion(originalCompletion).sha256 !==
          completion.sha256
        )
          effectFail("WORKFLOW_CHILD_STALE");
      },
    });
  }
  commitChild(original: object, settled: WorkflowInstanceRevision): void {
    const state = this.effects.get(original);
    if (!state) effectFail("WORKFLOW_ORIGINAL_REQUIRED");
    if (!state.record) return;
    state.record = signEffect({
      ...state.record,
      stageRevisionId: settled.stages.find(
        (s) => s.stageId === state.record.stageId,
      )!.id,
    });
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
    const b = this.bindings.get(original);
    if (b) {
      b.released = true;
      if (this.byRun.get(b.runId) === original) this.byRun.delete(b.runId);
      this.bindings.delete(original);
    }
  }
  bind(input: { workspaceId: string; instanceId: string }): object {
    workflowHostRecord(input, ["workspaceId", "instanceId"]);
    this.open();
    const { record, owner } = this.service().effectOwner(
      input.workspaceId,
      input.instanceId,
    );
    this.owners.assertCurrent(owner.original, record.owner);
    if (this.byRun.has(record.owner.runId))
      effectFail("WORKFLOW_MODEL_ALREADY_BOUND");
    const original = this.issue(this.bindings, {
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
  private actor(
    context: ToolContext,
    phase: "prepare" | "execute",
    original?: object,
  ): { original: object; binding: Binding; record: WorkflowInstanceRevision } {
    this.open();
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
  private effectRecords(
    record: WorkflowInstanceRevision,
  ): WorkflowEffectRecord[] {
    const spec = this.engine.getWorkflow(
      record.workspaceId,
      record.workflowId,
      record.specRevisionId,
    )!.spec;
    return spec.stages
      .filter((s) => ["editor", "validator"].includes(s.role))
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
  private async mergeSelection(
    record: WorkflowInstanceRevision,
    stageId: string,
  ): Promise<{
    editor: WorkflowEffectRecord;
    validator: WorkflowEffectRecord;
    head: string;
  }> {
    const spec = this.engine.getWorkflow(
        record.workspaceId,
        record.workflowId,
        record.specRevisionId,
      )!.spec,
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
      { signal: new AbortController().signal },
    );
    const head = git.stdout.toString().trim();
    if (git.code || head !== record.worktrees[stageId]!.baseCommit)
      effectFail("WORKFLOW_PARENT_HEAD_STALE");
    return { editor, validator, head };
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
    return WORKFLOW_MODEL_NAMES.map((name): ToolDefinition => ({
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
        required:
          name === "deliver_workflow_result"
            ? ["requestId"]
            : ["stageId", "requestId", "expectedRevision"],
      } as JsonObject,
      prepare: async (input, context) => {
        const a = this.actor(context, "prepare");
        workflowHostRecord(
          input,
          name === "deliver_workflow_result"
            ? ["requestId"]
            : ["stageId", "requestId", "expectedRevision"],
        );
        const data = workflowJson(input) as JsonObject;
        workflowIdentifier(data.requestId);
        if (name !== "deliver_workflow_result") {
          workflowIdentifier(data.stageId);
          if (data.expectedRevision !== a.record.revision)
            effectFail("WORKFLOW_STAGE_STALE");
        }
        if (name === "merge_workflow_stage") {
          const batchSelection =
            this.batchPolicy?.merge(
              a.record,
              String(data.stageId),
              "prepare",
            ) ?? null;
          const selection = await this.mergeSelection(
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
          const preview = {
            ...inner.preview,
            workflow: {
              instanceId: a.record.instanceId,
              stageId: data.stageId!,
              revision: a.record.revision,
              sourceSha256: selection.editor.sha256,
              verificationSha256: selection.validator.sha256,
              head: selection.head,
              ...(batchSelection ? { codingSelection: batchSelection } : {}),
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
              tuple: this.tuple(context),
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
            tuple: this.tuple(context),
            used: false,
            batchSelection,
          });
          return prepared;
        }
        const target =
          name === "deliver_workflow_result"
            ? this.target({
                workspaceId: a.record.workspaceId,
                instanceId: a.record.instanceId,
                config: this.engine.store.getRun(a.record.owner.runId).config,
              }).proof
            : undefined;
        const preview = {
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
            tuple: this.tuple(context),
          }),
          requiresApproval: name !== "observe_workflow_stage",
          preview,
        };
        requests.set(prepared, {
          binding: a.original,
          tuple: this.tuple(context),
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
          const target = this.captureTarget({
            workspaceId: a.record.workspaceId,
            instanceId: a.record.instanceId,
            config: this.engine.store.getRun(a.record.owner.runId).config,
          });
          try {
            if (this.readTarget(target).sha256 !== p.targetSha256)
              effectFail("WORKFLOW_DELIVERY_STALE");
            const r = this.deliver({
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
            this.release(target);
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
    }));
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
      this.batchPolicy?.merge(a.record, p.editor.stageId, "execute") ?? null;
    if (
      knowledgeHash(currentBatchSelection) !== knowledgeHash(p.batchSelection)
    )
      effectFail("CODING_SELECTION_STALE");
const now = await this.mergeSelection(a.record, p.editor.stageId);
    if (
      now.editor.sha256 !== p.editor.sha256 ||
      now.validator.sha256 !== p.validator.sha256 ||
      now.head !== p.head
    )
      effectFail("WORKFLOW_SOURCE_STALE");
    mergeBound(p.inner, now.editor, a.record.worktrees[p.editor.stageId]!.root);
    this.actor(context, "execute", p.binding);
    const approval = this.engine.coordinator.getWorkflowToolApproval(context);
    const intent = signEffect({
      ...p.editor,
      revision: p.editor.revision + 1,
      previousSha256: p.editor.sha256,
      state: "merge-dispatching" as const,
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
    const original = this.issue(this.effects, {
      record: intent,
      check: () => {
        this.actor(context, "execute", p.binding);
        pinsCurrent(p.editor.files);
        pinsCurrent(p.validator.artifacts);
      },
    });
    try {
      this.native.publish(original, p.editor.revision);
    } finally {
      this.release(original);
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
    const record = signEffect({
      ...p.record,
      state: "uncertain" as const,
      revision: p.record.revision + 1,
      previousSha256: p.record.sha256,
    });
    const o = this.issue(this.effects, { record, check: () => {} });
    try {
      this.native.publish(o, p.expectedRevision);
    } finally {
      this.release(o);
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
    const record = signEffect({
        ...p.record,
        state: "merged" as const,
        revision: p.record.revision + 1,
        previousSha256: p.record.sha256,
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
      o = this.issue(this.effects, {
        record,
        check: () => {
          if (this.engine.store.getToolCall(tool.id).state !== "completed")
            effectFail();
        },
      });
    try {
      this.engine.store.withWorkflowEffectsTransaction(() => {
        this.native.publish(o, p.expectedRevision);
        this.batchPolicy?.settled(record);
      });
      this.pendingMerge.delete(tool.id);
      this.service().reclaim(record.instanceId);
    } finally {
      this.release(o);
    }
  }
  captureTarget(input: {
    workspaceId: string;
    instanceId: string;
    config: RunConfigInput;
  }): object {
    return this.issue(this.targets, this.target(input));
  }
  private target(input: {
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
    const target = describeEngineQueueTarget(
        this.engine,
        this.binding,
        record.workspaceId,
        record.owner.sessionId,
        normalized.config,
      ),
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
          describeEngineQueueTarget(
            this.engine,
            this.binding,
            record.workspaceId,
            record.owner.sessionId,
            target.config,
          ),
        ) !== knowledgeHash(target)
      )
        effectFail("WORKFLOW_DELIVERY_STALE");
      for (const effect of effects) {
        pinsCurrent(effect.files);
        pinsCurrent(effect.artifacts);
        if (effect.merge) pinsCurrent(effect.merge.parentFiles);
      }
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
    const target = describeEngineQueueTarget(
      this.engine,
      this.binding,
      receipt.workspaceId,
      receipt.sessionId,
      run?.config ?? receipt.target.config,
    );
    if (knowledgeHash(target) !== knowledgeHash(receipt.target))
      effectFail("WORKFLOW_DELIVERY_STALE");
    for (const e of receipt.effects) {
      const current = this.native.read(
        receipt.sessionId,
        receipt.instanceId,
        e.stageId,
      );
      if (current?.sha256 !== e.sha256) effectFail("WORKFLOW_SOURCE_STALE");
      pinsCurrent(e.files);
      pinsCurrent(e.artifacts);
      if (e.merge) pinsCurrent(e.merge.parentFiles);
    }
  }
  close(): void {
    this.closed = true;
    this.effects.clear();
    this.targets.clear();
    this.bindings.clear();
    this.byRun.clear();
    this.pendingMerge.clear();
  }
}
