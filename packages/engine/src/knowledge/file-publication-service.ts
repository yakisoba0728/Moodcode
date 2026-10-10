import { types } from "node:util";
import { EngineError } from "@moodcode/contracts";
import type {
  FileKnowledgePublicationHost,
  FileKnowledgeTargetCapture,
  FileKnowledgePublicationApplyResult,
} from "./file-publication-fs.js";
import type {
  CompleteKnowledgeFilePublication,
  FilePhysicalObservation,
  KnowledgeFilePublicationCapture,
  KnowledgeFilePublicationCommitResult,
  KnowledgeFilePublicationRecord,
  KnowledgeFileTarget,
  PrepareKnowledgeFilePublication,
  PrepareKnowledgeFilePublicationResult,
  UncertainKnowledgeFilePublication,
} from "./file-publication-types.js";
import {
  filePublicationJson,
  sameFileHead,
} from "./file-publication-validation.js";
import {
  readKnowledgePublicationHistory,
  type KnowledgePublicationHistory,
  type KnowledgePublicationHistoryPorts,
} from "./publication-history.js";
import type { KnowledgePublicationProvenance } from "./publication-types.js";
import type {
  KnowledgeHostBinding,
  KnowledgeSourceManifest,
  TrustRevision,
  TrustSourcePin,
} from "./types.js";
import {
  identifier,
  immutableKnowledgeJson,
  knowledgeHash,
  sha256,
  stamp,
  validateBinding,
  validateTrustRevision,
} from "./validation.js";

export interface KnowledgeFilePublicationNativePort {
  captureTarget(
    binding: KnowledgeHostBinding,
    observation: FilePhysicalObservation,
  ): KnowledgeFileTarget;
  getCurrentTarget(
    workspaceId: string,
    path: string,
  ): KnowledgeFileTarget | undefined;
  findRequest(
    input: PrepareKnowledgeFilePublication,
  ): KnowledgeFilePublicationRecord | undefined;
  prepare(
    input: PrepareKnowledgeFilePublication,
  ): PrepareKnowledgeFilePublicationResult;
  dispatch(
    capture: KnowledgeFilePublicationCapture,
  ): KnowledgeFilePublicationRecord;
  complete(
    capture: KnowledgeFilePublicationCapture,
    input: CompleteKnowledgeFilePublication,
  ): KnowledgeFilePublicationCommitResult;
  uncertain(
    capture: KnowledgeFilePublicationCapture,
    input: UncertainKnowledgeFilePublication,
  ): KnowledgeFilePublicationRecord;
  cancel(
    capture: KnowledgeFilePublicationCapture,
    errorCode?: string,
  ): KnowledgeFilePublicationRecord;
  release(capture: KnowledgeFilePublicationCapture): void;
  getOwner(
    workspaceId: string,
    publicationId: string,
  ): KnowledgeFilePublicationRecord | undefined;
  getCommitted(
    workspaceId: string,
    publicationId: string,
  ): KnowledgeFilePublicationCommitResult;
}
export interface KnowledgeFilePublicationServicePorts extends KnowledgePublicationHistoryPorts {
  readonly native: KnowledgeFilePublicationNativePort;
  readonly host: Pick<
    FileKnowledgePublicationHost,
    | "captureTarget"
    | "assertFresh"
    | "releaseCapture"
    | "apply"
    | "observeTargetSync"
  >;
  readonly getTrust: (workspaceId: string) => TrustRevision | undefined;
  readonly checkBinding: (workspaceId: string) => KnowledgeHostBinding;
  readonly assertUnpaused: (workspaceId: string) => void;
  readonly assertTrustSourcesCurrent: (
    binding: KnowledgeHostBinding,
    sources: readonly TrustSourcePin[],
  ) => void;
  readonly assertSourcesCurrent: (
    binding: KnowledgeHostBinding,
    source: KnowledgeSourceManifest,
  ) => void;
  readonly withLease: <T>(
    workspaceId: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}
type ApprovalPins = Omit<
  PrepareKnowledgeFilePublication,
  "requestId" | "deadline"
>;
export interface KnowledgeFilePublicationPreview extends KnowledgePublicationHistory {
  readonly projection: "host-knowledge-file-publication-preview-v1";
  readonly operation: "publish" | "revoke";
  readonly workspaceId: string;
  readonly target: KnowledgeFileTarget;
  readonly existingPublication: KnowledgeFilePublicationRecord | null;
  readonly diff: {
    readonly before: string;
    readonly after: string;
    readonly beforeSha256: string | null;
    readonly afterSha256: string | null;
    readonly beforeBytes: number;
    readonly afterBytes: number;
  };
  readonly pins: ApprovalPins;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly sha256: string;
}
export interface WorkspaceKnowledgeFilePublicationPreviewInput {
  readonly workspaceId: string;
  readonly candidateId: string;
  readonly expiresAt?: string;
}
export interface WorkspaceKnowledgeFileRevocationPreviewInput {
  readonly workspaceId: string;
  readonly publicationId: string;
  readonly expiresAt?: string;
}
export interface WorkspaceKnowledgeFilePublicationInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly approved: true;
  readonly preview: KnowledgeFilePublicationPreview;
  readonly signal?: AbortSignal;
  readonly budget?: { readonly maxDurationMs?: number };
}
export interface WorkspaceKnowledgeFilePublicationResult extends KnowledgeFilePublicationCommitResult {
  readonly duplicate: boolean;
}
interface PreviewState {
  readonly preview: KnowledgeFilePublicationPreview;
  readonly physical: FileKnowledgeTargetCapture;
  used: boolean;
  request?: PrepareKnowledgeFilePublication;
  budgetSha256?: string;
}
interface OperationState {
  readonly state: PreviewState;
  readonly request: PrepareKnowledgeFilePublication;
  readonly signal: AbortSignal;
  dispatched: boolean;
  outcome?: FileKnowledgePublicationApplyResult;
}
const MAX_PREVIEWS = 128,
  MAX_OPERATIONS = 32,
  MAX_PREVIEW_BYTES = 262144,
  MAX_PREVIEW_MS = 300000;
function fail(code: string, message: string): never {
  throw new EngineError(code, message);
}
function same(a: unknown, b: unknown): boolean {
  return knowledgeHash(a) === knowledgeHash(b);
}
function hostInput(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail(
      "INVALID_KNOWLEDGE_FILE_PUBLICATION",
      "File publication input must be plain data",
    );
  const fields = Object.getOwnPropertyDescriptors(value);
  if (
    required.some((key) => !Object.hasOwn(fields, key)) ||
    Reflect.ownKeys(fields).some(
      (key) =>
        typeof key !== "string" ||
        (!required.includes(key) && !optional.includes(key)) ||
        !fields[key]!.enumerable ||
        !Object.hasOwn(fields[key]!, "value"),
    )
  )
    fail(
      "INVALID_KNOWLEDGE_FILE_PUBLICATION",
      "File publication rejects unknown fields, accessors and symbols",
    );
}
function sync(result: unknown): void {
  if (result !== undefined)
    fail(
      "KNOWLEDGE_ASYNC_PORT",
      "File approval currentness ports must complete synchronously",
    );
}
function signal(value: unknown): asserts value is AbortSignal {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    !(value instanceof AbortSignal) ||
    Object.getPrototypeOf(value) !== AbortSignal.prototype
  )
    fail(
      "INVALID_KNOWLEDGE_FILE_PUBLICATION",
      "Cancellation requires an actual unmodified AbortSignal",
    );
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      !Object.hasOwn(descriptor, "value") ||
      (typeof key === "string" &&
        [
          "aborted",
          "reason",
          "addEventListener",
          "removeEventListener",
        ].includes(key))
    )
      fail(
        "INVALID_KNOWLEDGE_FILE_PUBLICATION",
        "Cancellation cannot override native signal observations",
      );
  }
}
function abort(value: AbortSignal): void {
  if (value.aborted)
    fail("KNOWLEDGE_FILE_CANCELLED", "File publication was cancelled");
}
function errorCode(value: unknown): string {
  return value instanceof EngineError
    ? value.code
    : "KNOWLEDGE_FILE_PUBLICATION_FAILED";
}
function provenance(
  history: KnowledgePublicationHistory,
): KnowledgePublicationProvenance {
  return {
    candidateId: history.candidate.id,
    candidateSha256: history.candidate.sha256,
    generationId: history.generation.id,
    generationSha256: history.generation.sha256,
    attemptId: history.attempt.id,
    attemptSha256: history.attempt.sha256,
    planId: history.plan.id,
    planSha256: history.plan.sha256,
    trustRevisionId: history.trust.id,
    trustRevisionSha256: history.trust.sha256,
  };
}

/** Original operator approval controls one actual host file owner; no coding/tool owner is invented. */
export class KnowledgeFilePublicationService {
  readonly #ports: KnowledgeFilePublicationServicePorts;
  readonly #previews = new WeakMap<object, PreviewState>();
  readonly #active = new Set<object>();
  readonly #operations = new Map<string, OperationState>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #abort = new AbortController();
  #reserved = 0;
  #closing = false;
  #close?: Promise<void>;
  constructor(ports: KnowledgeFilePublicationServicePorts) {
    this.#ports = Object.freeze({ ...ports });
  }
  private now(): number {
    const value = this.#ports.now?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000)
      fail(
        "INVALID_KNOWLEDGE_FILE_PUBLICATION",
        "File publication clock is invalid",
      );
    return value;
  }
  private own<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing)
      return Promise.reject(
        new EngineError("ENGINE_CLOSED", "File publication service is closing"),
      );
    const pending = Promise.resolve().then(operation);
    this.#pending.add(pending);
    pending.finally(() => this.#pending.delete(pending)).catch(() => {});
    return pending;
  }
  private metadata(preview: KnowledgeFilePublicationPreview): void {
    sync(this.#ports.assertUnpaused(preview.workspaceId));
    if (
      !same(
        validateBinding(this.#ports.checkBinding(preview.workspaceId)),
        preview.pins.binding,
      )
    )
      fail("KNOWLEDGE_BINDING_MISMATCH", "File publication binding changed");
    if (this.now() >= Date.parse(preview.expiresAt))
      fail("KNOWLEDGE_FILE_EXPIRED", "Original file approval expired");
    const historical = readKnowledgePublicationHistory(
      this.#ports,
      preview.workspaceId,
      preview.candidate.id,
    );
    if (!same(provenance(historical), preview.pins.provenance))
      fail(
        "KNOWLEDGE_FILE_STALE",
        "File publication historical output changed",
      );
    if (preview.operation === "publish") {
      const trust = validateTrustRevision(
        this.#ports.getTrust(preview.workspaceId),
      );
      if (
        trust.decision !== "allow" ||
        !same(trust, preview.trust) ||
        (trust.expiresAt !== null && this.now() >= Date.parse(trust.expiresAt))
      )
        fail(
          "WORKSPACE_UNTRUSTED",
          "File publication requires its original current trust revision",
        );
      sync(
        this.#ports.assertTrustSourcesCurrent(
          preview.pins.binding,
          trust.sources,
        ),
      );
      sync(
        this.#ports.assertSourcesCurrent(
          preview.pins.binding,
          preview.candidate.source,
        ),
      );
      if (this.now() >= Date.parse(preview.candidate.expiresAt))
        fail("KNOWLEDGE_FILE_EXPIRED", "Original file candidate expired");
    } else {
      const original = preview.existingPublication,
        current =
          original &&
          this.#ports.native.getOwner(preview.workspaceId, original.id);
      if (
        !original ||
        !current ||
        current.state !== "completed" ||
        current.operation !== "publish" ||
        !same(current, original)
      )
        fail(
          "KNOWLEDGE_FILE_STALE",
          "Revocation requires its exact completed publication",
        );
    }
  }
  private async issue(
    operation: "publish" | "revoke",
    historical: KnowledgePublicationHistory,
    existing: KnowledgeFilePublicationRecord | null,
    expiry?: string,
  ): Promise<KnowledgeFilePublicationPreview> {
    if (this.#active.size >= MAX_PREVIEWS)
      fail("KNOWLEDGE_FILE_LIMIT", "Release old file publication previews");
    const candidate = historical.candidate;
    if (candidate.target.kind !== "workspace-file")
      fail(
        "KNOWLEDGE_FILE_TARGET_UNSUPPORTED",
        "File publication requires an original workspace-file candidate",
      );
    const originalSignal = AbortSignal.any([
      this.#abort.signal,
      ...(this.#ports.signal ? [this.#ports.signal] : []),
    ]);
    abort(originalSignal);
    const physical = await this.#ports.host.captureTarget(
      candidate.binding,
      candidate.target.path,
      originalSignal,
    );
    try {
      abort(originalSignal);
      const target = this.#ports.native.captureTarget(
        candidate.binding,
        physical.observation,
      );
      if (
        target.revision !== physical.revision ||
        target.path !== candidate.target.path ||
        target.workspaceId !== candidate.workspaceId ||
        !sameFileHead(target.observation, physical.observation)
      )
        fail(
          "KNOWLEDGE_FILE_STALE",
          "File observation and native target revision disagree",
        );
      if (
        operation === "publish" &&
        (candidate.target.revision !== target.revision ||
          candidate.target.sha256 !== target.observation.sha256 ||
          candidate.target.device !== target.observation.device ||
          candidate.target.inode !== target.observation.inode)
      )
        fail("KNOWLEDGE_FILE_STALE", "File candidate target preimage changed");
      if (
        operation === "revoke" &&
        (!existing ||
          existing.operation !== "publish" ||
          existing.state !== "completed" ||
          existing.path !== target.path ||
          !same(existing.provenance, provenance(historical)) ||
          existing.bodySha256 !== target.observation.sha256 ||
          existing.targetRevisionId !== target.observationId)
      )
        fail(
          "KNOWLEDGE_FILE_STALE",
          "File revoke requires the exact published physical postimage",
        );
      const now = this.now(),
        requested =
          expiry === undefined ? now + 60000 : Date.parse(stamp(expiry));
      if (requested <= now || requested > now + MAX_PREVIEW_MS)
        fail(
          "KNOWLEDGE_FILE_EXPIRED",
          "File approval expiry exceeds its original window",
        );
      const expires =
        operation === "publish"
          ? Math.min(
              requested,
              Date.parse(candidate.expiresAt),
              historical.trust.expiresAt
                ? Date.parse(historical.trust.expiresAt)
                : Infinity,
            )
          : requested;
      if (expires <= now)
        fail("KNOWLEDGE_FILE_EXPIRED", "File candidate or trust expired");
      const body = operation === "publish" ? candidate.body : null;
      if (body !== null && Buffer.byteLength(body) > 16384)
        fail(
          "KNOWLEDGE_FILE_LIMIT",
          "Whole file publication body exceeds 16KiB",
        );
      const pins: ApprovalPins = immutableKnowledgeJson({
        workspaceId: candidate.workspaceId,
        operation,
        binding: candidate.binding,
        path: candidate.target.path,
        expectedTarget: target,
        provenance: provenance(historical),
        existingPublicationId: existing?.id ?? null,
        existingPublicationSha256: existing?.sha256 ?? null,
        body,
        bodySha256: body === null ? null : sha256(body),
        beforeContent: physical.beforeContent,
        expiresAt: new Date(expires).toISOString(),
      });
      const base = {
        projection: "host-knowledge-file-publication-preview-v1" as const,
        operation,
        workspaceId: candidate.workspaceId,
        ...historical,
        target,
        existingPublication: existing,
        diff: {
          before: physical.beforeContent ?? "",
          after: body ?? "",
          beforeSha256: target.observation.sha256,
          afterSha256: pins.bodySha256,
          beforeBytes: Buffer.byteLength(physical.beforeContent ?? ""),
          afterBytes: Buffer.byteLength(body ?? ""),
        },
        pins,
        createdAt: new Date(now).toISOString(),
        expiresAt: pins.expiresAt,
      };
      if (Buffer.byteLength(JSON.stringify(base)) > MAX_PREVIEW_BYTES)
        fail(
          "KNOWLEDGE_FILE_LIMIT",
          "Whole original approval preview exceeds its bound",
        );
      const preview = filePublicationJson(
        { ...base, sha256: knowledgeHash(base) },
        MAX_PREVIEW_BYTES,
      );
      this.metadata(preview);
      await this.#ports.host.assertFresh(physical.capture, originalSignal);
      this.metadata(preview);
      abort(originalSignal);
      if (this.#active.size >= MAX_PREVIEWS)
        fail(
          "KNOWLEDGE_FILE_LIMIT",
          "Concurrent original file preview cap reached",
        );
      this.#previews.set(preview, { preview, physical, used: false });
      this.#active.add(preview);
      return preview;
    } catch (error) {
      this.#ports.host.releaseCapture(physical.capture);
      throw error;
    }
  }
  previewPublish(
    input: WorkspaceKnowledgeFilePublicationPreviewInput,
  ): Promise<KnowledgeFilePublicationPreview> {
    return this.own(async () => {
      hostInput(input, ["workspaceId", "candidateId"], ["expiresAt"]);
      const value = immutableKnowledgeJson(input);
      return this.issue(
        "publish",
        readKnowledgePublicationHistory(
          this.#ports,
          identifier(value.workspaceId),
          identifier(value.candidateId),
        ),
        null,
        value.expiresAt,
      );
    });
  }
  previewRevoke(
    input: WorkspaceKnowledgeFileRevocationPreviewInput,
  ): Promise<KnowledgeFilePublicationPreview> {
    return this.own(async () => {
      hostInput(input, ["workspaceId", "publicationId"], ["expiresAt"]);
      const value = immutableKnowledgeJson(input),
        workspaceId = identifier(value.workspaceId),
        publication = this.#ports.native.getOwner(
          workspaceId,
          identifier(value.publicationId),
        );
      if (!publication)
        fail(
          "KNOWLEDGE_FILE_NOT_FOUND",
          "Original file publication was not found",
        );
      return this.issue(
        "revoke",
        readKnowledgePublicationHistory(
          this.#ports,
          workspaceId,
          publication.provenance.candidateId,
        ),
        publication,
        value.expiresAt,
      );
    });
  }
  private owned(preview: unknown): PreviewState {
    if (
      !preview ||
      typeof preview !== "object" ||
      types.isProxy(preview) ||
      !this.#active.has(preview)
    )
      fail(
        "KNOWLEDGE_FILE_PREVIEW_INVALID",
        "File preview is copied, foreign, released or never issued",
      );
    return (
      this.#previews.get(preview) ??
      fail(
        "KNOWLEDGE_FILE_PREVIEW_INVALID",
        "File preview has no original owner",
      )
    );
  }
  releasePreview(preview: KnowledgeFilePublicationPreview): void {
    const state = this.owned(preview);
    if ([...this.#operations.values()].some((item) => item.state === state))
      fail(
        "KNOWLEDGE_FILE_BUSY",
        "Cannot release an executing original file preview",
      );
    this.#ports.host.releaseCapture(state.physical.capture);
    this.#active.delete(preview);
    this.#previews.delete(preview);
  }
  /** Called synchronously by the actual native transaction; no arbitrary record acquires permission. */
  assertCommitCurrent(
    record: KnowledgeFilePublicationRecord,
    phase: "dispatch" | "complete",
  ): void {
    const owner = this.#operations.get(record.id);
    if (
      !owner ||
      record.workspaceId !== owner.request.workspaceId ||
      record.requestId !== owner.request.requestId ||
      Object.keys(owner.request).some(
        (key) =>
          !same(
            record[key as keyof PrepareKnowledgeFilePublication],
            owner.request[key as keyof PrepareKnowledgeFilePublication],
          ),
      )
    )
      fail(
        "KNOWLEDGE_FILE_PREVIEW_INVALID",
        "Native file owner has no original approved capture",
      );
    this.metadata(owner.state.preview);
    if (phase === "dispatch") {
      abort(owner.signal);
      if (this.now() >= owner.request.deadline)
        fail(
          "KNOWLEDGE_FILE_DEADLINE",
          "Original file publication deadline expired",
        );
    }
    const target = this.#ports.native.getCurrentTarget(
      record.workspaceId,
      record.path,
    );
    if (!same(target ?? record.expectedTarget, record.expectedTarget))
      fail(
        "KNOWLEDGE_FILE_STALE",
        "Native file target changed during original publication",
      );
    const expected =
        phase === "dispatch"
          ? owner.state.physical.observation
          : owner.outcome?.after,
      matches = phase === "dispatch" ? same : sameFileHead;
    if (
      !expected ||
      !matches(
        this.#ports.host.observeTargetSync(record.binding, record.path),
        expected,
      )
    )
      fail(
        "KNOWLEDGE_FILE_STALE",
        "Physical file does not match the exact execution boundary",
      );
    if (
      phase === "complete" &&
      (!owner.dispatched ||
        owner.outcome?.state !== "applied" ||
        !owner.outcome.cleanupConfirmed ||
        owner.outcome.checkpoint.partial)
    )
      fail(
        "KNOWLEDGE_FILE_EVIDENCE_INVALID",
        "Native completion requires actual applied outcome and closed handles",
      );
  }
  publish(
    input: WorkspaceKnowledgeFilePublicationInput,
  ): Promise<WorkspaceKnowledgeFilePublicationResult> {
    return this.own(() => this.apply("publish", input));
  }
  revoke(
    input: WorkspaceKnowledgeFilePublicationInput,
  ): Promise<WorkspaceKnowledgeFilePublicationResult> {
    return this.own(() => this.apply("revoke", input));
  }
  private async apply(
    operation: "publish" | "revoke",
    input: WorkspaceKnowledgeFilePublicationInput,
  ): Promise<WorkspaceKnowledgeFilePublicationResult> {
    hostInput(
      input,
      ["workspaceId", "requestId", "approved", "preview"],
      ["signal", "budget"],
    );
    const state = this.owned(input.preview);
    const workspaceId = identifier(input.workspaceId),
      requestId = identifier(input.requestId);
    if (
      input.approved !== true ||
      workspaceId !== state.preview.workspaceId ||
      operation !== state.preview.operation
    )
      fail(
        "KNOWLEDGE_FILE_PREVIEW_INVALID",
        "File effect requires original exact operator approval",
      );
    if (input.signal !== undefined) signal(input.signal);
    const budget = immutableKnowledgeJson(input.budget ?? {});
    hostInput(budget, [], ["maxDurationMs"]);
    const maxDurationMs = budget.maxDurationMs ?? 5000;
    if (
      !Number.isSafeInteger(maxDurationMs) ||
      maxDurationMs < 1 ||
      maxDurationMs > 30000
    )
      fail(
        "KNOWLEDGE_FILE_LIMIT",
        "File operation duration must be 1..30000ms",
      );
    const budgetSha256 = knowledgeHash({ maxDurationMs });
    if (
      state.request &&
      (state.request.requestId !== requestId ||
        state.budgetSha256 !== budgetSha256)
    )
      fail(
        "KNOWLEDGE_FILE_PREVIEW_USED",
        "An original file approval cannot authorize another request or budget",
      );
    const request: PrepareKnowledgeFilePublication =
      state.request ??
      immutableKnowledgeJson({
        ...state.preview.pins,
        requestId,
        deadline: Math.min(
          this.now() + maxDurationMs,
          Date.parse(state.preview.expiresAt),
        ),
      });
    const prior = this.#ports.native.findRequest(request);
    if (prior) {
      if (prior.state !== "completed")
        fail(
          "KNOWLEDGE_FILE_NOT_COMPLETED",
          "An earlier file intent cannot be automatically retried",
        );
      return Object.freeze({
        ...this.#ports.native.getCommitted(workspaceId, prior.id),
        duplicate: true,
      });
    }
    if (state.used)
      fail(
        "KNOWLEDGE_FILE_PREVIEW_USED",
        "Original file preview was already consumed",
      );
    const combined = AbortSignal.any([
      this.#abort.signal,
      ...(this.#ports.signal ? [this.#ports.signal] : []),
      ...(input.signal ? [input.signal] : []),
    ]);
    abort(combined);
    if (this.#reserved >= MAX_OPERATIONS)
      fail(
        "KNOWLEDGE_FILE_LIMIT",
        "Too many original file effects are pending",
      );
    state.used = true;
    state.request = request;
    state.budgetSha256 = budgetSha256;
    this.#reserved++;
    const timeout = new AbortController(),
      timer = setTimeout(
        () =>
          timeout.abort(
            new EngineError(
              "KNOWLEDGE_FILE_DEADLINE",
              "Original file deadline expired",
            ),
          ),
        Math.max(0, request.deadline - this.now()),
      );
    let capture: KnowledgeFilePublicationCapture | undefined,
      owner: OperationState | undefined,
      completed: KnowledgeFilePublicationCommitResult | undefined;
    try {
      return await this.#ports.withLease(workspaceId, async (leaseSignal) => {
        signal(leaseSignal);
        const executionSignal = AbortSignal.any([
          combined,
          timeout.signal,
          leaseSignal,
        ]);
        abort(executionSignal);
        this.metadata(state.preview);
        await this.#ports.host.assertFresh(
          state.physical.capture,
          executionSignal,
        );
        this.metadata(state.preview);
        abort(executionSignal);
        if (this.now() >= request.deadline)
          fail(
            "KNOWLEDGE_FILE_DEADLINE",
            "Original file deadline expired before intent",
          );
        const prepared = this.#ports.native.prepare(request);
        if (prepared.kind === "duplicate") {
          if (prepared.record.state !== "completed")
            fail(
              "KNOWLEDGE_FILE_NOT_COMPLETED",
              "Concurrent original file intent is not a receipt",
            );
          return Object.freeze({
            ...this.#ports.native.getCommitted(workspaceId, prepared.record.id),
            duplicate: true,
          });
        }
        capture = prepared.capture;
        owner = { state, request, signal: executionSignal, dispatched: false };
        this.#operations.set(prepared.record.id, owner);
        const outcome = await this.#ports.host.apply(state.physical.capture, {
          operation,
          body: request.body ?? "",
          publicationId: prepared.record.id,
          signal: executionSignal,
          deadline: request.deadline,
          beforeEffect: () => {
            this.assertCommitCurrent(prepared.record, "dispatch");
            this.#ports.native.dispatch(capture!);
            owner!.dispatched = true;
          },
        });
        owner.outcome = outcome;
        if (
          outcome.state !== "applied" ||
          !outcome.after ||
          !outcome.cleanupConfirmed ||
          outcome.checkpoint.partial
        ) {
          this.#ports.native.uncertain(capture, {
            after: outcome.after,
            checkpoint: outcome.checkpoint,
            cleanupConfirmed: outcome.cleanupConfirmed,
            errorCode: outcome.errorCode ?? "KNOWLEDGE_FILE_EFFECT_UNCERTAIN",
          });
          fail(
            "KNOWLEDGE_FILE_EFFECT_UNCERTAIN",
            "File effect or cleanup did not establish an exact completed publication",
          );
        }
        completed = this.#ports.native.complete(capture, {
          after: outcome.after,
          checkpoint: outcome.checkpoint,
          cleanup: { confirmed: true, reason: null },
        });
        return Object.freeze({ ...completed, duplicate: false });
      });
    } catch (error) {
      if (completed) return Object.freeze({ ...completed, duplicate: false });
      const prior = this.#ports.native.findRequest(request);
      if (prior?.state === "completed")
        return Object.freeze({
          ...this.#ports.native.getCommitted(workspaceId, prior.id),
          duplicate: true,
        });
      if (
        capture &&
        prior &&
        !["cancelled", "uncertain"].includes(prior.state)
      ) {
        if (
          owner?.dispatched ||
          prior.state === "dispatched" ||
          errorCode(error) === "KNOWLEDGE_FILE_CLEANUP_UNCERTAIN"
        )
          this.#ports.native.uncertain(capture, {
            ...(owner?.outcome
              ? {
                  after: owner.outcome.after,
                  checkpoint: owner.outcome.checkpoint,
                  cleanupConfirmed: owner.outcome.cleanupConfirmed,
                }
              : {}),
            errorCode: errorCode(error),
          });
        else this.#ports.native.cancel(capture, errorCode(error));
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.#reserved--;
      if (capture) {
        this.#operations.delete(capture.publicationId);
        try {
          this.#ports.native.release(capture);
        } catch (error) {
          // A completed owner has no cleanup left; its receipt outranks the release failure.
          if (!completed) throw error;
        }
      }
    }
  }
  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closing = true;
    this.#abort.abort(
      new EngineError("ENGINE_CLOSED", "File publication service is closing"),
    );
    return (this.#close = (async () => {
      await Promise.allSettled([...this.#pending]);
      for (const preview of [...this.#active])
        this.releasePreview(preview as KnowledgeFilePublicationPreview);
    })());
  }
}
