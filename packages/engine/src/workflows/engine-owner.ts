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
import { join } from "node:path";
import { types } from "node:util";
import type { Run } from "@moodcode/contracts";
import type { MoodcodeEngine } from "../engine.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import type { ToolCatalogue } from "../tools/runtime/index.js";
import { assertPhysicalKnowledgeRoot } from "../workspace/trust.js";
import { runGit } from "../workspace/git.js";
import type { ManagedWorktree } from "../worktrees/index.js";
import type {
  ActualWorkflowOwnerPort,
  WorkflowParentConfiguration,
} from "./host.js";
import { workflowAbort, workflowHostRecord } from "./host.js";
import type { WorkflowOwnerProof, WorkflowWorktreePin } from "./reducer.js";
import {
  workflowError,
  workflowIdentifier,
  workflowJson,
  WORKFLOW_READ_TOOLS,
} from "./spec.js";

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
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.dev !== first.dev ||
      before.ino !== first.ino ||
      before.size !== after.size ||
      before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs ||
      current.dev !== after.dev ||
      current.ino !== after.ino ||
      current.size !== after.size ||
      current.ctimeNs !== after.ctimeNs ||
      current.mtimeNs !== after.mtimeNs ||
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
    private readonly engine: MoodcodeEngine,
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
    const profile = this.engine.profiles.forRun(run.sessionId, run.config);
    return profile ? { id: profile.id, revision: profile.revision } : null;
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
    const profile = this.profile(run),
      catalogue = this.engine.toolRuntime.catalogue(
        "engine",
        run.config.mode,
        this.engine.profiles.forRun(run.sessionId, run.config)?.tools,
        profile ?? undefined,
      ),
      exposed = new Set(
        this.engine.getCapabilities().tools.map((tool) => tool.name),
      );
    const tools = [
      ...WORKFLOW_READ_TOOLS,
      "apply_patch",
      "run_command",
      "verify_changes",
    ].filter(
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
  assertCurrent(original: object, expected: WorkflowOwnerProof): void {
    const owner = this.original(original);
    if (knowledgeHash(expected) !== knowledgeHash(owner.proof))
      workflowError("WORKFLOW_OWNER_STALE");
    this.run(owner, true);
  }
  assertSettling(original: object, expected: WorkflowOwnerProof): void {
    const owner = this.original(original);
    if (knowledgeHash(expected) !== knowledgeHash(owner.proof))
      workflowError("WORKFLOW_OWNER_STALE");
    this.run(owner, false);
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
