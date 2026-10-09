import { types } from "node:util";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import {
  identifier,
  immutableKnowledgeJson,
  knowledgeHash,
  stamp,
  validateBinding,
} from "../knowledge/validation.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import {
  PHYSICAL_PATCH_LIMITS,
  type PhysicalPatchProducer,
  type PhysicalPatchCapture,
  type PhysicalPatchResult,
} from "../tools/patch/physical.js";
import type {
  ProposalBlobReference,
  ProposalRevision,
  ProposalSelection,
  ProposalSet,
} from "./types.js";
import type { ProposalSourceManifest } from "./source-capture.js";
import type {
  PrepareProposalApply,
  PrepareProposalApplyResult,
  ProposalApplyCapture,
  ProposalApplyCheckpoint,
  ProposalApplyHistory,
  ProposalApplyOwner,
  ProposalApplyPins,
  ProposalPhysicalOutcome,
} from "./apply-types.js";

export interface ProposalApplyNativePort {
  findRequest(input: {
    workspaceId: string;
    requestId: string;
    requestSha256: string;
  }): ProposalApplyHistory | undefined;
  prepare(
    originalApproved: object,
    input: PrepareProposalApply,
  ): PrepareProposalApplyResult;
  claim(
    capture: ProposalApplyCapture,
    originalGuard: object,
  ): ProposalApplyOwner;
  dispatch(capture: ProposalApplyCapture): ProposalApplyOwner;
  checkpoint(
    capture: ProposalApplyCapture,
    originalPhysicalResult: object,
  ): ProposalApplyCheckpoint;
  settle(
    capture: ProposalApplyCapture,
    originalCleanup: object,
  ): ProposalApplyHistory;
  cancelPrepared(
    capture: ProposalApplyCapture,
    errorCode?: string,
  ): ProposalApplyOwner;
  uncertain(
    capture: ProposalApplyCapture,
    errorCode: string,
  ): ProposalApplyOwner;
  release(capture: ProposalApplyCapture): void;
  getHistory(
    workspaceId: string,
    ownerId: string,
  ): ProposalApplyHistory | undefined;
}
export interface ProposalApplyExecutionLease {
  readonly guard: object;
  /** Returns the original root-issued observation of descriptor and marker cleanup. */
  release(cleanupConfirmed: boolean): object;
}
export interface ProposalApplyServicePorts {
  readonly readTx: <T>(operation: () => T) => T;
  readonly getSelection: (
    workspaceId: string,
    proposalId: string,
  ) => ProposalSelection | undefined;
  readonly getRevision: (
    workspaceId: string,
    revisionId: string,
  ) => ProposalRevision | undefined;
  readonly readBlobText: (reference: ProposalBlobReference) => string;
  readonly checkBinding: (workspaceId: string) => KnowledgeHostBinding;
  readonly assertUnpaused: (workspaceId: string) => void;
  readonly assertIdleAndNoExecutionUncertainty: (workspaceId: string) => void;
  readonly assertSourcesCurrent: (
    binding: KnowledgeHostBinding,
    manifest: ProposalSourceManifest,
    signal: AbortSignal,
  ) => void;
  readonly withWorkspaceLease: <T>(
    workspaceId: string,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  readonly physical: Pick<
    PhysicalPatchProducer,
    | "prepare"
    | "read"
    | "assertFresh"
    | "apply"
    | "readResult"
    | "release"
    | "close"
  >;
  readonly acquireExecutionGuard: (
    capture: ProposalApplyCapture,
  ) => Promise<ProposalApplyExecutionLease>;
  readonly now?: () => number;
}
export interface ProposalApplyPreviewInput {
  readonly workspaceId: string;
  readonly proposalId: string;
  readonly revisionId?: string;
  readonly expiresAt?: string;
  readonly signal?: AbortSignal;
}
export interface ProposalApplyPreview {
  readonly projection: "host-proposal-apply-preview-v1";
  readonly authority: "explicit-host-approval";
  readonly workspaceId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly sourceManifestSha256: string;
  readonly beforeHead: ProposalSet;
  readonly binding: KnowledgeHostBinding;
  readonly physicalSourceSha256: string;
  readonly physicalPinsSha256: string;
  readonly preview: JsonObject;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly sha256: string;
}
export interface ApplyProposalInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly approved: boolean;
  readonly preview: ProposalApplyPreview;
  readonly signal?: AbortSignal;
}
export interface ApplyProposalResult extends ProposalApplyHistory {
  readonly duplicate: boolean;
}
interface PreviewState {
  readonly preview: ProposalApplyPreview;
  readonly selection: ProposalSelection;
  readonly physical: PhysicalPatchCapture;
  readonly signal: AbortSignal;
  readonly before: readonly (string | null)[];
  used: boolean;
  released: boolean;
  request?: PrepareProposalApply;
}
interface OperationState {
  readonly state: PreviewState;
  readonly request: PrepareProposalApply;
  readonly signal: AbortSignal;
  result?: PhysicalPatchResult;
}
function fail(code = "INVALID_PROPOSAL_APPLY"): never {
  throw new EngineError(
    code,
    "Proposal application requires its exact original approved preview and current native source",
  );
}
function plain(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, PropertyDescriptor> {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== "string" ||
        (!required.includes(key) && !optional.includes(key)),
    ) ||
    required.some((key) => !descriptors[key]) ||
    Object.values(descriptors).some(
      (d) => !d.enumerable || !Object.hasOwn(d, "value"),
    )
  )
    fail();
  return descriptors;
}
function actualSignal(value: unknown): asserts value is AbortSignal {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== AbortSignal.prototype
  )
    fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        !Object.hasOwn(
          descriptors[key as keyof typeof descriptors]!,
          "value",
        ) ||
        (typeof key === "string" &&
          [
            "aborted",
            "reason",
            "addEventListener",
            "removeEventListener",
          ].includes(key)),
    )
  )
    fail();
  try {
    // Probe the native brand only after rejecting caller-owned accessors.
    Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      "aborted",
    )!.get!.call(value);
  } catch {
    fail();
  }
}
function errorCode(error: unknown): string {
  return error instanceof EngineError ? error.code : "PROPOSAL_APPLY_FAILED";
}
function same(a: unknown, b: unknown): boolean {
  return knowledgeHash(a) === knowledgeHash(b);
}

/** Native idle host operation. No ToolContext, Run, provider call or model approval authority. */
export class ProposalApplyService {
  readonly #previews = new WeakMap<object, PreviewState>();
  readonly #retained = new Set<PreviewState>();
  readonly #operations = new WeakMap<object, OperationState>();
  readonly #approved = new WeakMap<object, OperationState>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #close = new AbortController();
  #previewReservations = 0;
  constructor(
    readonly native: ProposalApplyNativePort,
    readonly ports: ProposalApplyServicePorts,
    readonly hostSignal: AbortSignal = new AbortController().signal,
  ) {}
  private open(signal?: AbortSignal): void {
    if (this.#close.signal.aborted || this.hostSignal.aborted)
      fail("PROPOSAL_APPLY_CLOSED");
    if (signal?.aborted) fail("CANCELLED");
  }
  private own<T>(operation: () => Promise<T>): Promise<T> {
    let task: Promise<T>;
    try {
      this.open();
      if (this.#pending.size >= 32) fail("PROPOSAL_APPLY_CAPACITY");
      task = operation();
    } catch (error) {
      return Promise.reject(error);
    }
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task)).catch(() => {});
    return task;
  }
  preview(input: ProposalApplyPreviewInput): Promise<ProposalApplyPreview> {
    return this.own(() => this.preparePreview(input));
  }
  private async preparePreview(
    input: ProposalApplyPreviewInput,
  ): Promise<ProposalApplyPreview> {
    const fields = plain(
      input,
      ["workspaceId", "proposalId"],
      ["revisionId", "expiresAt", "signal"],
    );
    const workspaceId = identifier(fields.workspaceId!.value),
      proposalId = identifier(fields.proposalId!.value);
    const revisionId =
      fields.revisionId?.value === undefined
        ? undefined
        : identifier(fields.revisionId.value);
    const caller = fields.signal?.value;
    if (caller !== undefined) actualSignal(caller);
    this.open(caller);
    const signal = AbortSignal.any([
      this.#close.signal,
      this.hostSignal,
      ...(caller ? [caller] : []),
    ]);
    const now = this.ports.now?.() ?? Date.now(),
      expiresAt =
        fields.expiresAt?.value === undefined
          ? new Date(now + 60_000).toISOString()
          : stamp(fields.expiresAt.value);
    if (Date.parse(expiresAt) <= now || Date.parse(expiresAt) > now + 90_000)
      fail("PROPOSAL_APPLY_PREVIEW_EXPIRED");
    if (this.#retained.size + this.#previewReservations >= 128)
      fail("PROPOSAL_APPLY_CAPACITY");
    this.#previewReservations++;
    let physical: PhysicalPatchCapture | undefined;
    try {
      const selected = this.ports.readTx(() => {
        this.ports.assertUnpaused(workspaceId);
        this.ports.assertIdleAndNoExecutionUncertainty(workspaceId);
        const selection = this.ports.getSelection(workspaceId, proposalId);
        if (!selection) fail("PROPOSAL_APPLY_NOT_PENDING");
        if (revisionId !== undefined && selection.revision.id !== revisionId)
          fail("PROPOSAL_APPLY_STALE");
        const binding = validateBinding(this.ports.checkBinding(workspaceId));
        if (!same(binding, selection.revision.binding))
          fail("PROPOSAL_APPLY_BINDING_CHANGED");
        const revision = selection.revision;
        // The application lane is narrower than the authoring lane. Reject before blob reads or producer entry.
        if (
          revision.files.length > PHYSICAL_PATCH_LIMITS.files ||
          revision.totalBytes > PHYSICAL_PATCH_LIMITS.combinedBytes ||
          revision.files.some(
            (file) =>
              (file.before?.bytes ?? 0) > PHYSICAL_PATCH_LIMITS.fileBytes ||
              (file.after?.bytes ?? 0) > PHYSICAL_PATCH_LIMITS.fileBytes,
          )
        )
          fail("PROPOSAL_APPLY_UNSUPPORTED");
        this.ports.assertSourcesCurrent(
          binding,
          revision.sourceManifest,
          signal,
        );
        this.open(signal);
        const before = revision.files.map((file) =>
          file.before ? this.ports.readBlobText(file.before) : null,
        );
        const changes = revision.files.map((file, index) => ({
          path: file.path,
          expectedHash: file.before?.sha256 ?? null,
          content: file.after ? this.ports.readBlobText(file.after) : null,
        }));
        return { selection, binding, before, changes };
      });
      const {
        workspaceId: physicalWorkspaceId,
        root,
        rootDevice,
        rootInode,
      } = selected.binding;
      physical = await this.ports.physical.prepare(
        { workspaceId: physicalWorkspaceId, root, rootDevice, rootInode },
        selected.changes,
        signal,
      );
      this.open(signal);
      const observed = this.ports.physical.read(physical);
      const body = {
        projection: "host-proposal-apply-preview-v1" as const,
        authority: "explicit-host-approval" as const,
        workspaceId,
        proposalId,
        revisionId: selected.selection.revision.id,
        revisionSha256: selected.selection.revision.sha256,
        sourceManifestSha256: selected.selection.revision.sourceManifestSha256,
        beforeHead: selected.selection.set,
        binding: selected.binding,
        physicalSourceSha256: observed.sourceSha256,
        physicalPinsSha256: observed.physicalPinsSha256,
        preview: observed.preview,
        createdAt: new Date(now).toISOString(),
        expiresAt,
      };
      const preview = immutableKnowledgeJson({
        ...body,
        sha256: knowledgeHash(body),
      });
      const state: PreviewState = {
        preview,
        selection: selected.selection,
        physical,
        signal,
        before: selected.before,
        used: false,
        released: false,
      };
      this.assertStateCurrent(state, signal);
      this.#previews.set(preview, state);
      this.#retained.add(state);
      physical = undefined;
      return preview;
    } finally {
      this.#previewReservations--;
      if (physical) this.ports.physical.release(physical);
    }
  }
  apply(input: ApplyProposalInput): Promise<ApplyProposalResult> {
    return this.own(() => this.applyOriginal(input));
  }
  private async applyOriginal(
    input: ApplyProposalInput,
  ): Promise<ApplyProposalResult> {
    const fields = plain(
      input,
      ["workspaceId", "requestId", "approved", "preview"],
      ["signal"],
    );
    const workspaceId = identifier(fields.workspaceId!.value),
      requestId = identifier(fields.requestId!.value);
    if (fields.approved!.value !== true)
      fail("PROPOSAL_APPLY_APPROVAL_REQUIRED");
    const original = fields.preview!.value;
    if (!original || typeof original !== "object" || types.isProxy(original))
      fail("PROPOSAL_APPLY_PREVIEW_INVALID");
    const state = this.#previews.get(original);
    if (!state || state.preview.workspaceId !== workspaceId)
      fail("PROPOSAL_APPLY_PREVIEW_INVALID");
    const caller = fields.signal?.value;
    if (caller !== undefined) actualSignal(caller);
    this.open(caller);
    const signal = AbortSignal.any([
      this.#close.signal,
      this.hostSignal,
      state.signal,
      ...(caller ? [caller] : []),
    ]);
    const preview = state.preview;
    const pins: ProposalApplyPins = {
      workspaceId,
      proposalId: preview.proposalId,
      revisionId: preview.revisionId,
      revisionSha256: preview.revisionSha256,
      sourceManifestSha256: preview.sourceManifestSha256,
      beforeHead: preview.beforeHead,
      binding: preview.binding,
      previewSha256: preview.sha256,
      expiresAt: preview.expiresAt,
      deadline: Date.parse(preview.expiresAt),
    };
    const body = { ...pins, requestId };
    const request: PrepareProposalApply = immutableKnowledgeJson({
      ...body,
      requestSha256: knowledgeHash(body),
    });
    if (state.request && !same(state.request, request))
      fail("PROPOSAL_APPLY_PREVIEW_USED");
    // Original identity is required, but an exact historical observation grants no new effect authority.
    const duplicate = this.ports.readTx(() =>
      this.native.findRequest({
        workspaceId,
        requestId,
        requestSha256: request.requestSha256,
      }),
    );
    if (duplicate) return { ...duplicate, duplicate: true };
    if (state.used || state.released) fail("PROPOSAL_APPLY_PREVIEW_USED");
    state.used = true;
    state.request = request;
    const operation: OperationState = { state, request, signal };
    const approved = Object.freeze({});
    this.#approved.set(approved, operation);
    let capture: ProposalApplyCapture | undefined,
      guard: ProposalApplyExecutionLease | undefined,
      dispatched = false,
      checkpointed = false,
      released = false;
    try {
      return await this.ports.withWorkspaceLease(
        workspaceId,
        signal,
        async (leaseSignal) => {
          const current = AbortSignal.any([signal, leaseSignal]);
          const activeOperation: OperationState = {
            ...operation,
            signal: current,
          };
          this.#approved.set(approved, activeOperation);
          this.assertStateCurrent(state, current);
          await this.ports.physical.assertFresh(state.physical, current);
          this.assertStateCurrent(state, current);
          const prepared = this.native.prepare(approved, request);
          if (prepared.kind === "duplicate")
            return { ...prepared.history, duplicate: true };
          capture = prepared.capture;
          this.#operations.set(capture, activeOperation);
          const result = await this.ports.physical.apply(state.physical, {
            signal: current,
            beforeEffect: async () => {
              this.assertStateCurrent(state, current);
              // Root reserves SQL intent and claims it before acquisition. It owns the original cleanup token.
              guard = await this.ports.acquireExecutionGuard(capture!);
              await this.ports.physical.assertFresh(state.physical, current);
              this.assertStateCurrent(state, current);
              this.native.dispatch(capture!);
              dispatched = true;
            },
          });
          activeOperation.result = result;
          operation.result = result;
          this.native.checkpoint(capture, result);
          checkpointed = true;
          const outcome = this.assertPhysicalResult(capture, result);
          const cleanup = guard!.release(outcome.cleanupConfirmed);
          released = true;
          // A post-effect abort cannot erase the original accounted checkpoint or cleanup receipt.
          const history = this.native.settle(capture, cleanup);
          return { ...history, duplicate: false };
        },
      );
    } catch (error) {
      if (capture) {
        try {
          if (dispatched || guard || checkpointed)
            this.native.uncertain(capture, errorCode(error));
          else this.native.cancelPrepared(capture, errorCode(error));
        } catch {
          /* The actual native active owner remains a startup blocker; no success is fabricated. */
        }
        // Without a stored checkpoint or original producer result no cleanup=true proof exists.
        if (guard && !released) {
          try {
            guard.release(false);
          } catch {
            /* Retain the real marker on unconfirmed cleanup. */
          }
        }
      }
      throw error;
    } finally {
      if (capture) this.native.release(capture);
      state.released = true;
      this.#retained.delete(state);
      this.ports.physical.release(state.physical);
      this.#approved.delete(approved);
    }
  }
  releasePreview(preview: ProposalApplyPreview): void {
    const state = this.#previews.get(preview);
    if (!state) fail("PROPOSAL_APPLY_PREVIEW_INVALID");
    state.released = true;
    this.#retained.delete(state);
    this.ports.physical.release(state.physical);
  }
  private assertStateCurrent(state: PreviewState, signal: AbortSignal): void {
    this.open(signal);
    if (state.released) fail("PROPOSAL_APPLY_PREVIEW_INVALID");
    if (
      (this.ports.now?.() ?? Date.now()) >= Date.parse(state.preview.expiresAt)
    )
      fail("PROPOSAL_APPLY_PREVIEW_EXPIRED");
    const check = () => {
      this.ports.assertUnpaused(state.preview.workspaceId);
      const binding = validateBinding(
        this.ports.checkBinding(state.preview.workspaceId),
      );
      if (!same(binding, state.preview.binding))
        fail("PROPOSAL_APPLY_BINDING_CHANGED");
      const selected = this.ports.getSelection(
        state.preview.workspaceId,
        state.preview.proposalId,
      );
      if (
        !selected ||
        selected.set.sha256 !== state.preview.beforeHead.sha256 ||
        selected.revision.sha256 !== state.preview.revisionSha256
      )
        fail("PROPOSAL_APPLY_STALE");
      this.ports.assertSourcesCurrent(
        binding,
        selected.revision.sourceManifest,
        signal,
      );
      this.open(signal);
      if (
        !same(this.ports.checkBinding(state.preview.workspaceId), binding) ||
        this.ports.getSelection(
          state.preview.workspaceId,
          state.preview.proposalId,
        )?.set.sha256 !== state.preview.beforeHead.sha256
      )
        fail("PROPOSAL_APPLY_STALE");
      if (
        (this.ports.now?.() ?? Date.now()) >=
        Date.parse(state.preview.expiresAt)
      )
        fail("PROPOSAL_APPLY_PREVIEW_EXPIRED");
    };
    this.ports.readTx(check);
  }
  readApprovedCapture(
    original: object,
    input: PrepareProposalApply,
  ): ProposalApplyPins {
    const operation = this.#approved.get(original);
    if (!operation || !same(operation.request, input))
      fail("PROPOSAL_APPLY_PREVIEW_INVALID");
    this.assertStateCurrent(operation.state, operation.signal);
    const { requestId: _id, requestSha256: _sha, ...pins } = operation.request;
    return pins;
  }
  assertCurrent(
    original: object,
    capture: ProposalApplyCapture,
    phase: "prepare" | "dispatch",
  ): void {
    const operation = this.#approved.get(original);
    if (
      !operation ||
      capture.workspaceId !== operation.request.workspaceId ||
      (phase === "dispatch" && this.#operations.get(capture) !== operation)
    )
      fail("PROPOSAL_APPLY_PREVIEW_INVALID");
    this.assertStateCurrent(operation.state, operation.signal);
  }
  assertPhysicalResult(
    capture: ProposalApplyCapture,
    originalResult: object,
  ): ProposalPhysicalOutcome {
    const operation = this.#operations.get(capture);
    if (!operation || operation.result !== originalResult)
      fail("PROPOSAL_APPLY_RESULT_INVALID");
    const actual = this.ports.physical.readResult(originalResult),
      files = operation.state.selection.revision.files;
    if (
      !Number.isSafeInteger(actual.attemptedFileCount) ||
      actual.attemptedFileCount < 0 ||
      actual.attemptedFileCount > files.length ||
      actual.files.some(
        (row) => !files.some((file) => file.path === row.path),
      ) ||
      new Set(actual.files.map((row) => row.path)).size !== actual.files.length
    )
      fail("PROPOSAL_APPLY_RESULT_INVALID");
    return {
      files: files.map((file, index) => {
        const observed = actual.files.find((row) => row.path === file.path),
          before = operation.state.before[index]!;
        if (
          observed &&
          (observed.before !== before ||
            observed.beforeHash !== (file.before?.sha256 ?? null) ||
            observed.attempted !== index < actual.attemptedFileCount)
        )
          fail("PROPOSAL_APPLY_RESULT_INVALID");
        return {
          path: file.path,
          attempted: index < actual.attemptedFileCount,
          mayHaveChanged: observed?.mayHaveChanged ?? false,
          before,
          beforeSha256: file.before?.sha256 ?? null,
          after: observed?.after ?? null,
          afterSha256: observed?.afterHash ?? null,
          observationComplete: observed?.observationComplete ?? false,
        };
      }),
      createdParentCount: actual.createdParentCount,
      createdParents: actual.createdParents,
      createdParentsComplete: actual.createdParentsComplete,
      cleanupConfirmed: actual.cleanupConfirmed,
      errorCode: actual.errorCode,
      warnings: actual.warnings,
    };
  }
  readCurrentPhysicalOutcome(
    capture: ProposalApplyCapture,
  ): ProposalPhysicalOutcome {
    const operation = this.#operations.get(capture);
    if (!operation?.result) fail("PROPOSAL_APPLY_RESULT_INVALID");
    return this.assertPhysicalResult(capture, operation.result);
  }
  async close(): Promise<void> {
    this.#close.abort();
    await Promise.allSettled([...this.#pending]);
    for (const state of this.#retained) {
      state.released = true;
      this.ports.physical.release(state.physical);
    }
    this.#retained.clear();
    await this.ports.physical.close();
  }
}
