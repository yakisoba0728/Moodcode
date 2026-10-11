import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { types } from "node:util";
import {
  EngineError,
  type JsonObject,
  type Run,
  type Workspace,
} from "@moodcode/contracts";
import { profilePin } from "../agents/index.js";
import type {
  ChildExecution,
  ChildExecutionView,
  EngineChildRequest,
} from "../child-tasks/engine-host.js";
import type { ChildRunHandle, ChildTaskRecord } from "../child-tasks/index.js";
import { CHILD_OUTCOME_STATES } from "../child-tasks/journal.js";
import {
  CHILD_STORAGE_MIRROR_KIND,
  childRequestFingerprint,
  validateChildStorageRecord,
} from "../child-tasks/storage-binding.js";
import type { MoodcodeEngine } from "../engine.js";
import type { EngineRuntime } from "../engine-runtime.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { sha256Hex } from "../shared/canonical.js";
import { parseJsonOr } from "../shared/data.js";
import { stableStat } from "../shared/fs.js";
import { raceAbort } from "../shared/runtime.js";
import type { ToolCatalogue } from "../tools/runtime/index.js";
import { assertPhysicalKnowledgeRoot } from "../workspace/trust.js";
import { runGit } from "../workspace/git.js";
import type { ManagedWorktree } from "../worktrees/index.js";
import type { WorkflowChildEvidence } from "./effect-evidence.js";
import type {
  ActualWorkflowOwnerPort,
  WorkflowParentConfiguration,
} from "./host.js";
import { workflowAbort, workflowHostRecord } from "./host.js";
import type {
  WorkflowChildAdmissionProof,
  WorkflowChildCompletionProof,
  WorkflowOwnerProof,
  WorkflowWorktreePin,
} from "./reducer.js";
import type { ActualWorkflowChildObservationPort } from "./service.js";
import {
  workflowError,
  workflowIdentifier,
  workflowJson,
  WORKFLOW_ROLE_TOOLS,
} from "./spec.js";
import type { WorkflowStageSpec } from "./types.js";

const STAGE_TOOLS = [...new Set(Object.values(WORKFLOW_ROLE_TOOLS).flat())];

interface PhysicalFile {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly text: string;
}
interface CapturedWorktree {
  readonly record: ManagedWorktree;
  readonly pin: WorkflowWorktreePin;
  readonly gitDir: string;
  readonly gitDevice: string;
  readonly gitInode: string;
  readonly marker: PhysicalFile;
  readonly head: PhysicalFile;
}
interface CapturedOwner {
  readonly run: Run;
  readonly proof: WorkflowOwnerProof;
  readonly binding: KnowledgeHostBinding;
  readonly catalogue: ToolCatalogue;
  readonly tools: readonly string[];
  readonly worktrees: ReadonlyMap<string, CapturedWorktree>;
}

/** A bounded ordinary Git metadata observation, suitable for native transaction freshness checks. */
function physicalFile(path: string): PhysicalFile {
  let descriptor: number | undefined;
  try {
    const first = lstatSync(path, { bigint: true });
    if (
      !first.isFile() ||
      first.isSymbolicLink() ||
      first.nlink !== 1n ||
      first.size > 4096n ||
      realpathSync(path) !== path
    )
      workflowError("WORKFLOW_WORKTREE_STALE");
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = fstatSync(descriptor, { bigint: true }),
      bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (!read) break;
      length += read;
    }
    const after = fstatSync(descriptor, { bigint: true }),
      current = lstatSync(path, { bigint: true }),
      body = bytes.subarray(0, length),
      text = body.toString("utf8");
    if (
      length > 4096 ||
      BigInt(length) !== after.size ||
      !Buffer.from(text).equals(body) ||
      text.includes("\0") ||
      current.isSymbolicLink() ||
      !stableStat(first, before) ||
      !stableStat(before, after, ["size", "ctime", "mtime"]) ||
      !stableStat(after, current, ["size", "ctime", "mtime"]) ||
      realpathSync(path) !== path
    )
      workflowError("WORKFLOW_WORKTREE_STALE");
    return Object.freeze({
      path,
      device: after.dev.toString(),
      inode: after.ino.toString(),
      text,
    });
  } catch {
    return workflowError("WORKFLOW_WORKTREE_STALE");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Originals exist only for this root engine lifetime and one actual admitted parent Run. */
export class EngineWorkflowOwners implements ActualWorkflowOwnerPort {
  private readonly originals = new WeakMap<object, CapturedOwner>();
  private readonly retained = new Set<object>();
  private readonly epoch = randomUUID();
  constructor(
    private readonly engine: Pick<
      EngineRuntime,
      | "store"
      | "coordinator"
      | "profiles"
      | "toolRuntime"
      | "children"
      | "getCapabilities"
    >,
    private readonly checkBinding: (
      workspaceId: string,
    ) => KnowledgeHostBinding,
  ) {}
  private original(value: object): CapturedOwner {
    if (!value || typeof value !== "object" || types.isProxy(value))
      workflowError("WORKFLOW_OWNER_STALE");
    const owner = this.originals.get(value);
    if (!owner) workflowError("WORKFLOW_OWNER_STALE");
    return owner;
  }
  private binding(owner: CapturedOwner): void {
    const current = this.checkBinding(owner.proof.workspaceId);
    assertPhysicalKnowledgeRoot(current);
    if (knowledgeHash(current) !== knowledgeHash(owner.binding))
      workflowError("WORKFLOW_OWNER_STALE");
  }
  private profile(run: Run) {
    return this.engine.profiles.pinForRun(run.sessionId, run.config);
  }
  private run(owner: CapturedOwner, dispatch: boolean): Run {
    this.binding(owner);
    const current = dispatch
        ? this.engine.coordinator.getOwnedActiveRun(owner.run.id)
        : this.engine.store.getRun(owner.run.id),
      session = this.engine.store.getSession(owner.run.sessionId);
    if (
      current.sessionId !== owner.run.sessionId ||
      current.workspaceId !== owner.run.workspaceId ||
      session.workspaceId !== owner.run.workspaceId ||
      knowledgeHash(current.config) !== owner.proof.runConfigSha256 ||
      current.prompt !== owner.run.prompt ||
      knowledgeHash(this.profile(current)) !==
        knowledgeHash(owner.proof.profile)
    )
      workflowError("WORKFLOW_OWNER_STALE");
    this.engine.coordinator.assertWorkspaceCleanupConfirmed(
      owner.run.workspaceId,
    );
    if (dispatch) {
      if (
        this.engine.coordinator.activeRun(current.sessionId)?.id !==
          current.id ||
        this.engine.store.getSessionControl(current.sessionId).paused
      )
        workflowError("WORKFLOW_OWNER_STALE");
      workflowAbort(
        this.engine.coordinator.getRunCancellationSignal(current.id),
      );
      this.engine.toolRuntime.assertCatalogueCurrent(owner.catalogue);
    } else {
      this.engine.coordinator.getRunUsage(current.id);
      if (["interrupted", "cleanup_uncertain"].includes(current.state))
        workflowError("WORKFLOW_OWNER_STALE");
    }
    return current;
  }
  async capture(
    selection: {
      workspaceId: string;
      rootSessionId: string;
      parentRunId: string;
      worktrees: Readonly<Record<string, string>>;
    },
    signal?: AbortSignal,
  ): Promise<object> {
    workflowHostRecord(selection, [
      "workspaceId",
      "rootSessionId",
      "parentRunId",
      "worktrees",
    ]);
    workflowAbort(signal);
    const data = workflowJson(selection);
    for (const value of [
      data.workspaceId,
      data.rootSessionId,
      data.parentRunId,
    ])
      workflowIdentifier(value);
    if (this.retained.size >= 32) workflowError("WORKFLOW_LIMIT");
    const run = this.engine.coordinator.getOwnedActiveRun(data.parentRunId),
      binding = workflowJson(this.checkBinding(data.workspaceId));
    assertPhysicalKnowledgeRoot(binding);
    if (
      run.sessionId !== data.rootSessionId ||
      run.workspaceId !== data.workspaceId ||
      this.engine.store.getSession(run.sessionId).workspaceId !==
        run.workspaceId
    )
      workflowError("WORKFLOW_OWNER_STALE");
    const resolved = this.engine.profiles.forRun(run.sessionId, run.config),
      profile = profilePin(resolved),
      catalogue = this.engine.toolRuntime.catalogue(
        "engine",
        run.config.mode,
        resolved?.tools,
        profile ?? undefined,
      ),
      exposed = new Set(
        this.engine.getCapabilities().tools.map((tool) => tool.name),
      );
    const tools = STAGE_TOOLS.filter(
      (name) =>
        exposed.has(name) && catalogue.tools.some((tool) => tool.name === name),
    );
    const fields: Omit<WorkflowOwnerProof, "sha256"> = {
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      runId: run.id,
      ownerEpoch: knowledgeHash({ epoch: this.epoch, runId: run.id, binding }),
      runConfigSha256: knowledgeHash(run.config),
      profile,
    };
    const proof = workflowJson({ ...fields, sha256: knowledgeHash(fields) }),
      worktrees = new Map<string, CapturedWorktree>();
    const ids = Object.values(data.worktrees);
    if (!ids.length || ids.length > 8)
      workflowError("WORKFLOW_WORKTREE_SELECTION_INVALID");
    const owner: CapturedOwner = {
      run: workflowJson(run),
      proof,
      binding,
      catalogue,
      tools: Object.freeze(tools),
      worktrees,
    };
    this.run(owner, true);
    const operationSignal = signal
      ? AbortSignal.any([
          signal,
          this.engine.coordinator.getRunCancellationSignal(run.id),
        ])
      : this.engine.coordinator.getRunCancellationSignal(run.id);
    for (const id of new Set(ids)) {
      workflowIdentifier(id);
      workflowAbort(operationSignal);
      const record = this.engine.children.worktrees.get(run.sessionId, id);
      if (
        record.sessionId !== run.sessionId ||
        record.workspaceId !== run.workspaceId ||
        record.baseRoot !== binding.root ||
        record.state !== "ready" ||
        record.ownerId ||
        record.relocation
      )
        workflowError("WORKFLOW_WORKTREE_SELECTION_INVALID");
      await this.engine.children.worktrees.verify(record, operationSignal);
      const git = await runGit(
        record.root,
        ["rev-parse", "--absolute-git-dir"],
        { signal: operationSignal },
      );
      if (git.code !== 0) workflowError("WORKFLOW_WORKTREE_STALE");
      const gitDir = realpathSync(git.stdout.toString().trim()),
        stat = lstatSync(gitDir, { bigint: true }),
        marker = physicalFile(join(record.root, ".git")),
        head = physicalFile(join(gitDir, "HEAD"));
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        head.text.trim() !== record.baseCommit ||
        !/^[a-f0-9]{40,64}$/.test(record.baseCommit)
      )
        workflowError("WORKFLOW_WORKTREE_STALE");
      const pinFields = {
        id,
        workspaceId: record.workspaceId,
        root: record.root,
        baseRoot: record.baseRoot,
        baseCommit: record.baseCommit,
        fingerprint: record.fingerprint,
      };
      worktrees.set(id, {
        record: workflowJson(record),
        pin: workflowJson({ ...pinFields, sha256: knowledgeHash(pinFields) }),
        gitDir,
        gitDevice: stat.dev.toString(),
        gitInode: stat.ino.toString(),
        marker,
        head,
      });
    }
    this.run(owner, true);
    const original = Object.freeze({});
    this.originals.set(original, owner);
    this.retained.add(original);
    try {
      for (const entry of worktrees.values())
        this.assertWorktreeCurrent(original, entry.pin);
      return original;
    } catch (error) {
      this.release(original);
      throw error;
    }
  }
  read(original: object): WorkflowOwnerProof {
    return workflowJson(this.original(original).proof);
  }
  private assertOwner(
    original: object,
    expected: WorkflowOwnerProof,
    dispatch: boolean,
  ): void {
    const owner = this.original(original);
    if (knowledgeHash(expected) !== knowledgeHash(owner.proof))
      workflowError("WORKFLOW_OWNER_STALE");
    this.run(owner, dispatch);
  }
  assertCurrent(original: object, expected: WorkflowOwnerProof): void {
    this.assertOwner(original, expected, true);
  }
  assertSettling(original: object, expected: WorkflowOwnerProof): void {
    this.assertOwner(original, expected, false);
  }
  configuration(original: object): WorkflowParentConfiguration {
    const owner = this.original(original),
      run = this.run(owner, true);
    return workflowJson({
      profile: owner.proof.profile,
      model: {
        providerId: run.config.providerId,
        modelId: run.config.modelId,
        ...(run.config.reasoningEffort
          ? { reasoningEffort: run.config.reasoningEffort }
          : {}),
      },
      tools: owner.tools,
      remainingBudget: this.engine.coordinator.getRemainingChildBudget(run.id),
    });
  }
  worktree(original: object, id: string): WorkflowWorktreePin {
    const entry = this.original(original).worktrees.get(id);
    if (!entry) workflowError("WORKFLOW_WORKTREE_SELECTION_INVALID");
    return workflowJson(entry.pin);
  }
  assertWorktreeCurrent(original: object, expected: WorkflowWorktreePin): void {
    const owner = this.original(original),
      entry = owner.worktrees.get(expected.id);
    if (!entry || knowledgeHash(expected) !== knowledgeHash(entry.pin))
      workflowError("WORKFLOW_WORKTREE_STALE");
    this.binding(owner);
    try {
      const current = this.engine.children.worktrees.get(
          owner.run.sessionId,
          expected.id,
        ),
        stat = lstatSync(current.root, { bigint: true }),
        git = lstatSync(entry.gitDir, { bigint: true });
      if (
        current.state !== "ready" ||
        current.relocation ||
        [
          "id",
          "sessionId",
          "workspaceId",
          "root",
          "baseRoot",
          "baseCommit",
          "fingerprint",
          "requestId",
          "reference",
          "device",
          "inode",
        ].some(
          (key) =>
            current[key as keyof ManagedWorktree] !==
            entry.record[key as keyof ManagedWorktree],
        ) ||
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        realpathSync(current.root) !== current.root ||
        stat.dev.toString() !== entry.record.device ||
        stat.ino.toString() !== entry.record.inode ||
        !git.isDirectory() ||
        git.isSymbolicLink() ||
        realpathSync(entry.gitDir) !== entry.gitDir ||
        git.dev.toString() !== entry.gitDevice ||
        git.ino.toString() !== entry.gitInode ||
        knowledgeHash(physicalFile(entry.marker.path)) !==
          knowledgeHash(entry.marker) ||
        knowledgeHash(physicalFile(entry.head.path)) !==
          knowledgeHash(entry.head)
      )
        workflowError("WORKFLOW_WORKTREE_STALE");
    } catch {
      workflowError("WORKFLOW_WORKTREE_STALE");
    }
  }
  release(original: object): void {
    this.originals.delete(original);
    this.retained.delete(original);
  }
}

function stageVerification(
  root: MoodcodeEngine,
  verification: NonNullable<WorkflowStageSpec["verification"]>,
) {
  return (child: MoodcodeEngine, sessionId: string, workspace: Workspace) => {
    for (const id of verification.checkIds) {
      const check = root.verificationChecks.capture(id);
      const rootWorkspace = root.store.getWorkspace(check.workspaceId),
        cwdRelative = relative(rootWorkspace.root, check.cwd);
      if (
        cwdRelative === ".." ||
        cwdRelative.startsWith(`..${sep}`) ||
        isAbsolute(cwdRelative)
      )
        throw new EngineError(
          "WORKFLOW_VERIFICATION_STALE",
          "Verification working directory escapes the actual parent workspace",
        );
      const { registrationSha256, ...definition } = check;
      child.registerVerificationCheck({
        ...definition,
        workspaceId: workspace.id,
        cwd: join(workspace.root, cwdRelative),
      });
    }
    return child.configureVerificationSession(sessionId, 0, {
      checkIds: [...verification.checkIds],
      sourcePaths: [...verification.sourcePaths],
      maxRepairs: 0,
    });
  };
}

/** Native evidence of a settled stage Run, read before its child engine closes. */
function stageEvidence(
  engine: MoodcodeEngine,
  sessionId: string,
  run: Run,
): WorkflowChildEvidence {
  const snapshot = engine.store.getSnapshot(sessionId),
    turns = engine.store.listTurns(run.id),
    attempts = turns
      .map((turn) => engine.store.getLatestAttemptForTurn(turn.id))
      .filter((value): value is NonNullable<typeof value> => !!value),
    parts = turns.flatMap((turn) => engine.store.listParts(turn.id)),
    cleanups = attempts
      .map((a) => engine.store.getAttemptCleanup(a.id, sessionId))
      .filter((value): value is NonNullable<typeof value> => !!value),
    verification = engine.getVerificationState(sessionId, run.id);
  const attemptUsages = attempts
    .map((a) => engine.store.getAttemptUsage(a.id))
    .filter((v): v is NonNullable<typeof v> => !!v);
  const body = {
    version: 1 as const,
    run: structuredClone(run),
    snapshot,
    turns,
    attempts,
    parts,
    cleanups,
    verification,
    checkpoints: engine.store.listCheckpoints(run.id),
    attemptUsages,
  };
  return workflowJson({ ...body, sha256: knowledgeHash(body) });
}

export function workflowChildObservationPort(
  children: ChildExecutionView,
  owners: ActualWorkflowOwnerPort,
): ActualWorkflowChildObservationPort {
  interface OriginalChild {
    owner: object;
    request: EngineChildRequest;
    execution: ChildExecution;
    proof: WorkflowChildAdmissionProof;
  }
  const originals = new WeakMap<object, OriginalChild>();
  const completions = new WeakMap<
    object,
    { child: OriginalChild; proof: WorkflowChildCompletionProof }
  >();
  function fail(): never {
    throw new EngineError(
      "WORKFLOW_CHILD_STALE",
      "Workflow requires its original admitted child execution",
    );
  }
  const observeWait = async <T>(
    pending: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    workflowAbort(signal);
    if (!signal) return pending;
    return raceAbort(
      pending,
      signal,
      () => new EngineError("CANCELLED", "Workflow observation was cancelled"),
    );
  };
  const verify = (child: OriginalChild): ChildTaskRecord => {
    const { request, execution, proof } = child;
    const task = children.tasks.get(request.sessionId, proof.taskId);
    const admission = children.admission(request.sessionId, request.requestId);
    if (
      !admission ||
      admission.fingerprint !== childRequestFingerprint(request) ||
      children.execution(task.id) !== execution ||
      !execution.storageRecord
    )
      fail();
    const record = children.rootStorageRecord(request.sessionId, task.id);
    if (
      !record ||
      record.sha256 !== execution.storageRecord.sha256 ||
      record.sha256 !== proof.storageSha256 ||
      !children.sameStorageHost(record) ||
      task.fingerprint !== proof.taskFingerprint ||
      task.childRunId !== proof.childRunId ||
      task.parentRunId !== proof.parentRunId ||
      task.rootRunId !== proof.rootRunId ||
      task.requestId !== proof.requestId ||
      task.worktreeId !== proof.worktreeId ||
      knowledgeHash(task.toolNames) !== knowledgeHash(proof.tools) ||
      knowledgeHash(task.budget) !== knowledgeHash(proof.allocation) ||
      record.binding.child.sessionId !== execution.sessionId ||
      record.binding.child.runId !== execution.runId ||
      record.binding.child.workspaceId !== proof.childWorkspaceId ||
      execution.admittedRun.prompt !== request.prompt ||
      sha256Hex(execution.admittedRun.prompt) !== proof.promptSha256
    )
      fail();
    const parent = owners.read(child.owner);
    owners.assertSettling(child.owner, parent);
    owners.assertWorktreeCurrent(
      child.owner,
      owners.worktree(child.owner, proof.worktreeId),
    );
    if (
      parent.sessionId !== proof.rootSessionId ||
      parent.runId !== proof.parentRunId
    )
      fail();
    if (!execution.closed) {
      const mirror = execution.engine.store.getSessionDocument(
        execution.sessionId,
        CHILD_STORAGE_MIRROR_KIND,
      );
      const run = execution.engine.store.getRun(execution.runId);
      if (
        !mirror ||
        validateChildStorageRecord(mirror.data).sha256 !==
          proof.storageSha256 ||
        knowledgeHash(run.config) !==
          knowledgeHash(execution.admittedRun.config) ||
        run.prompt !== request.prompt
      )
        fail();
    } else if (!record.confirmedClose && task.state !== "uncertain") fail();
    return task;
  };
  return {
    start: async (originalOwner, value, signal, stage) => {
      workflowAbort(signal);
      const owner = owners.read(originalOwner);
      owners.assertCurrent(originalOwner, owner);
      const request = structuredClone(value);
      if (
        request.sessionId !== owner.sessionId ||
        request.parentRunId !== owner.runId ||
        request.parentTaskId !== undefined
      )
        fail();
      owners.assertWorktreeCurrent(
        originalOwner,
        owners.worktree(originalOwner, request.worktreeId),
      );
      const configuration = owners.configuration(originalOwner);
      const staged = stage ? structuredClone(stage) : undefined;
      children.stage(request.sessionId, request.requestId, {
        guard: () => {
          workflowAbort(signal);
          owners.assertCurrent(originalOwner, owner);
          owners.assertWorktreeCurrent(
            originalOwner,
            owners.worktree(originalOwner, request.worktreeId),
          );
        },
        ...(staged?.verification
          ? { prepare: stageVerification(children.root, staged.verification) }
          : {}),
        ...(staged ? { settle: stageEvidence } : {}),
      });
      let task: ChildTaskRecord;
      try {
        const starting = await children.start(request, signal);
        const admission = children.admission(
          request.sessionId,
          request.requestId,
        );
        if (
          !admission ||
          admission.fingerprint !== childRequestFingerprint(request)
        )
          fail();
        await observeWait(
          Promise.race([
            admission.confirmed,
            children.tasks.wait(request.sessionId, starting.id).then(() => {
              throw new EngineError(
                "WORKFLOW_DISPATCH_UNCERTAIN",
                "Original child did not confirm provider admission",
              );
            }),
          ]),
          signal,
        );
        task = children.tasks.get(request.sessionId, starting.id);
      } finally {
        children.unstage(request.sessionId, request.requestId);
      }
      const execution = children.execution(task.id);
      if (
        !execution?.storageRecord ||
        !task.childRunId ||
        task.childRunId !== execution.runId ||
        execution.admittedRun.config.providerId !==
          configuration.model.providerId ||
        execution.admittedRun.config.modelId !== configuration.model.modelId ||
        execution.admittedRun.config.reasoningEffort !==
          configuration.model.reasoningEffort
      )
        fail();
      const fields: Omit<WorkflowChildAdmissionProof, "sha256"> = {
        rootSessionId: task.sessionId,
        rootRunId: task.rootRunId,
        parentRunId: task.parentRunId,
        taskId: task.id,
        taskFingerprint: task.fingerprint,
        childSessionId: execution.sessionId,
        childRunId: execution.runId,
        childWorkspaceId: execution.admittedRun.workspaceId,
        worktreeId: task.worktreeId,
        storageSha256: execution.storageRecord.sha256,
        requestId: task.requestId,
        promptSha256: sha256Hex(execution.admittedRun.prompt),
        tools: [...task.toolNames],
        allocation: structuredClone(task.budget),
      };
      const child: OriginalChild = {
        owner: originalOwner,
        request,
        execution,
        proof: { ...fields, sha256: knowledgeHash(fields) },
      };
      verify(child);
      const original = Object.freeze({});
      originals.set(original, child);
      return original;
    },
    readAdmission: (original) => {
      const child = originals.get(original);
      if (!child) fail();
      verify(child);
      return structuredClone(child.proof);
    },
    observe: async (originalOwner, originalChild, signal) => {
      workflowAbort(signal);
      const child = originals.get(originalChild);
      if (!child || child.owner !== originalOwner) fail();
      verify(child);
      let actual: Awaited<ReturnType<ChildRunHandle["wait"]>> | undefined;
      try {
        actual = await observeWait(child.execution.wait(), signal);
      } catch {
        workflowAbort(signal);
        // The actual journal below must independently record the unconfirmed outcome.
      }
      const settled = await observeWait(
        children.tasks.wait(child.request.sessionId, child.proof.taskId),
        signal,
      );
      workflowAbort(signal);
      verify(child);
      let state: WorkflowChildCompletionProof["state"];
      let result: JsonObject | null = null;
      let complete = false;
      const measured = child.execution.engine.coordinator.getRunUsage(
        child.execution.runId,
      );
      if (settled.state === "uncertain") state = "uncertain";
      else {
        const outcome = settled.outcome;
        if (
          !actual ||
          !outcome ||
          !child.execution.closed ||
          !CHILD_OUTCOME_STATES.includes(settled.state) ||
          actual.state !== outcome.state ||
          knowledgeHash(actual.usage) !== knowledgeHash(outcome.usage) ||
          knowledgeHash(measured) !== knowledgeHash(actual.usage)
        )
          fail();
        const limit = Math.min(settled.budget.outputBytes, 4096);
        if (
          Buffer.byteLength(actual.content) <= limit &&
          actual.content !== outcome.content
        )
          fail();
        const truncated =
          Buffer.byteLength(actual.content) > limit ||
          outcome.truncated === true;
        state = outcome.state;
        if (state === "completed") {
          if (truncated)
            throw new EngineError(
              "WORKFLOW_RESULT_INCOMPLETE",
              "Workflow results require complete child output",
            );
          const data = workflowJson(
            parseJsonOr(actual.content, () => {
              throw new EngineError(
                "WORKFLOW_RESULT_INVALID",
                "Workflow child output must be a JSON object",
              );
            }),
          );
          if (!data || typeof data !== "object" || Array.isArray(data))
            throw new EngineError(
              "WORKFLOW_RESULT_INVALID",
              "Workflow child result must be an object",
            );
          result = data as JsonObject;
          complete = true;
        }
      }
      const fields: Omit<WorkflowChildCompletionProof, "sha256"> = {
        child: structuredClone(child.proof),
        state,
        result,
        complete,
        outcomeSha256: knowledgeHash(
          settled.outcome ?? {
            state: settled.state,
            errorCode: settled.errorCode ?? null,
          },
        ),
        usage: { ...measured },
      };
      const original = Object.freeze({});
      completions.set(original, {
        child,
        proof: { ...fields, sha256: knowledgeHash(fields) },
      });
      return original;
    },
    readExecution: (original) => {
      const completion = completions.get(original);
      if (!completion) fail();
      verify(completion.child);
      const evidence = completion.child.execution.evidence as
        WorkflowChildEvidence | undefined;
      if (!evidence || evidence.run.id !== completion.proof.child.childRunId)
        fail();
      return structuredClone(evidence);
    },
    readCompletion: (original) => {
      const completion = completions.get(original);
      if (!completion) fail();
      const task = verify(completion.child);
      if (
        knowledgeHash(
          task.outcome ?? {
            state: task.state,
            errorCode: task.errorCode ?? null,
          },
        ) !== completion.proof.outcomeSha256
      )
        fail();
      return structuredClone(completion.proof);
    },
    release: (original) => {
      originals.delete(original);
      completions.delete(original);
    },
  };
}
