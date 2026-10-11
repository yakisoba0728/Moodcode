import { types } from "node:util";
import { EngineError } from "@moodcode/contracts";
import {
  assertImportedDocumentChain,
  type KnowledgeImportDocumentProof,
} from "./import-document-proof.js";
import type {
  ImportedKnowledgeDocumentActivation,
  ImportedKnowledgeDocumentProof,
  KnowledgeImportFrontierView,
  KnowledgeImportRecoveryCommitResult,
  KnowledgeImportRecoveryDecision,
  KnowledgeImportRecoveryOperation,
  KnowledgeImportRecoveryPreview,
  PrepareKnowledgeImportRecoveryPreview,
} from "./import-recovery-types.js";
import { readKnowledgePublicationHistory } from "./publication-history.js";
import { publicationRow } from "./publication-validation.js";
import type {
  KnowledgeHostBinding,
  KnowledgeSourceManifest,
  TrustSourcePin,
} from "./types.js";
import {
  assertKnowledgeSignal,
  identifier,
  immutableKnowledgeJson,
  knowledgeHash,
  knowledgeHostRecord,
  sameKnowledge as same,
  samePhysicalRoot,
  stamp,
  validateBinding,
  validateCandidate,
  validateTrustRevision,
} from "./validation.js";

export interface KnowledgeImportRecoveryNativePort {
  getFrontier(workspaceId: string): KnowledgeImportFrontierView | undefined;
  getActivation(
    workspaceId: string,
    key: string,
  ): ImportedKnowledgeDocumentActivation | undefined;
  findRequest(
    workspaceId: string,
    requestId: string,
  ): KnowledgeImportRecoveryDecision | undefined;
  preview(
    input: PrepareKnowledgeImportRecoveryPreview,
  ): KnowledgeImportRecoveryPreview;
  commit(
    preview: KnowledgeImportRecoveryPreview,
    input: { requestId: string; approved: true; reason: string },
  ): KnowledgeImportRecoveryCommitResult;
  release(preview: KnowledgeImportRecoveryPreview): void;
}
export interface KnowledgeImportRecoveryServicePorts {
  readonly native: KnowledgeImportRecoveryNativePort;
  readonly readTx: <T>(operation: () => T) => T;
  readonly withWorkspaceLease: <T>(
    workspaceId: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  readonly checkBinding: (workspaceId: string) => KnowledgeHostBinding;
  readonly readActivationProof: (
    workspaceId: string,
    key: string,
  ) => KnowledgeImportDocumentProof | undefined;
  readonly assertTrustSourcesCurrent: (
    binding: KnowledgeHostBinding,
    sources: readonly TrustSourcePin[],
  ) => void;
  readonly assertSourcesCurrent: (
    binding: KnowledgeHostBinding,
    source: KnowledgeSourceManifest,
  ) => void;
  readonly assertNoExecutionUncertainty: (workspaceId: string) => void;
  readonly now?: () => number;
}
export interface WorkspaceKnowledgeImportRecoveryPreview {
  readonly schemaVersion: 1;
  readonly projection: "host-knowledge-import-recovery-preview-v1";
  readonly workspaceId: string;
  readonly operation: KnowledgeImportRecoveryOperation;
  readonly pins: KnowledgeImportRecoveryPreview;
  readonly document: {
    readonly key: string;
    readonly body: string;
    readonly bodySha256: string;
  } | null;
  readonly expiresAt: string;
  readonly sha256: string;
}
export interface WorkspaceKnowledgeImportRecoveryInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly approved: true;
  readonly preview: WorkspaceKnowledgeImportRecoveryPreview;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}
export type WorkspaceKnowledgeImportRecoveryResult =
  KnowledgeImportRecoveryCommitResult & { readonly duplicate: boolean };
interface Owned {
  readonly public: WorkspaceKnowledgeImportRecoveryPreview;
  readonly native: KnowledgeImportRecoveryPreview;
  readonly snapshot: string;
  used: boolean;
}
interface Commit {
  readonly state: Owned;
  readonly signal: AbortSignal;
  readonly leaseSignal: AbortSignal;
  readonly deadline: number;
}
const MAX_PREVIEWS = 128,
  MAX_OPERATIONS = 16,
  MAX_DURATION_MS = 5000;
const ownedDeadlineReasons = new WeakSet<object>();
function deadlineReason(): EngineError {
  const error = new EngineError(
    "KNOWLEDGE_IMPORT_DEADLINE",
    "Original knowledge recovery operation deadline elapsed",
  );
  ownedDeadlineReasons.add(error);
  return error;
}
const RECOVERY_MESSAGE =
  "Knowledge import requires explicit approval of a current original bounded recovery preview";
function fail(code: string): never {
  throw new EngineError(code, RECOVERY_MESSAGE);
}
function guard(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts input is Record<string, unknown> {
  knowledgeHostRecord(
    input,
    required,
    optional,
    "INVALID_KNOWLEDGE_IMPORT_RECOVERY",
    RECOVERY_MESSAGE,
  );
}
function sync(value: unknown): void {
  if (value !== undefined) fail("KNOWLEDGE_IMPORT_ASYNC_PORT");
}
function actualSignal(value: unknown): asserts value is AbortSignal {
  assertKnowledgeSignal(
    value,
    "INVALID_KNOWLEDGE_IMPORT_RECOVERY",
    RECOVERY_MESSAGE,
  );
}
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    // A caller's arbitrary abort reason is never inspected as a protocol object.
    const reason: unknown = signal.reason;
    if (
      reason &&
      typeof reason === "object" &&
      ownedDeadlineReasons.has(reason)
    )
      throw reason;
    fail("KNOWLEDGE_IMPORT_CANCELLED");
  }
}

/** Tools-free host recovery; source/trust reads do not manufacture a new producer or historical receipt. */
export class KnowledgeImportRecoveryService {
  readonly #ports: KnowledgeImportRecoveryServicePorts;
  readonly #previews = new WeakMap<object, Owned>();
  readonly #active = new Set<object>();
  readonly #commits = new WeakMap<KnowledgeImportRecoveryPreview, Commit>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #close = new AbortController();
  #reserved = 0;
  constructor(ports: KnowledgeImportRecoveryServicePorts) {
    this.#ports = Object.freeze({ ...ports });
  }
  private now(): number {
    const now = this.#ports.now?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000)
      fail("INVALID_KNOWLEDGE_IMPORT_RECOVERY");
    return now;
  }
  private proof(
    workspaceId: string,
    key: string,
    binding: KnowledgeHostBinding,
  ): {
    proof: ImportedKnowledgeDocumentProof;
    document: NonNullable<WorkspaceKnowledgeImportRecoveryPreview["document"]>;
  } {
    const raw = this.#ports.readActivationProof(workspaceId, key);
    if (!raw) fail("KNOWLEDGE_IMPORT_DOCUMENT_UNAVAILABLE");
    guard(raw, [
      "head",
      "document",
      "publication",
      "receipt",
      "history",
      "currentTrust",
    ]);
    guard(raw.history, ["candidate", "plan", "generation", "attempt", "trust"]);
    const candidate = validateCandidate(raw.history.candidate);
    const history = readKnowledgePublicationHistory(
      {
        getCandidate: () => raw.history.candidate,
        getPlan: () => raw.history.plan,
        getGeneration: () => raw.history.generation,
        getAttempt: () => raw.history.attempt,
        getTrustRevision: () => raw.history.trust,
      },
      workspaceId,
      candidate.id,
    );
    const head = publicationRow<typeof raw.head>(
        "workspace_document_heads",
        raw.head,
        workspaceId,
      ),
      document = publicationRow<typeof raw.document>(
        "workspace_document_revisions",
        raw.document,
        workspaceId,
      ),
      publication = publicationRow<typeof raw.publication>(
        "knowledge_publications",
        raw.publication,
        workspaceId,
      ),
      receipt = publicationRow<typeof raw.receipt>(
        "knowledge_publication_receipts",
        raw.receipt,
        workspaceId,
      );
    assertImportedDocumentChain(
      { head, document, publication, receipt, history },
      key,
      () => fail("KNOWLEDGE_IMPORT_EVIDENCE_INVALID"),
    );
    if (!samePhysicalRoot(document.binding, binding))
      fail("KNOWLEDGE_IMPORT_RELOCATION_UNSUPPORTED");
    const trust = validateTrustRevision(raw.currentTrust);
    if (
      !same(trust.binding, binding) ||
      trust.workspaceId !== workspaceId ||
      trust.decision !== "allow"
    )
      fail("KNOWLEDGE_IMPORT_TRUST_DENIED");
    sync(this.#ports.assertTrustSourcesCurrent(binding, trust.sources));
    sync(this.#ports.assertSourcesCurrent(binding, history.candidate.source));
    if (!same(validateBinding(this.#ports.checkBinding(workspaceId)), binding))
      fail("KNOWLEDGE_BINDING_MISMATCH");
    const expiry = Math.min(
      Date.parse(history.candidate.expiresAt),
      Date.parse(history.plan.expiresAt),
      history.trust.expiresAt ? Date.parse(history.trust.expiresAt) : Infinity,
      trust.expiresAt ? Date.parse(trust.expiresAt) : Infinity,
    );
    if (this.now() >= expiry) fail("KNOWLEDGE_IMPORT_EXPIRED");
    return {
      proof: immutableKnowledgeJson({
        documentKey: key,
        headRevision: head.revision,
        headSha256: head.sha256,
        documentRevisionId: document.id,
        documentSha256: document.sha256,
        publicationId: publication.id,
        publicationSha256: publication.sha256,
        receiptId: receipt.id,
        receiptSha256: receipt.sha256,
        provenanceSha256: knowledgeHash(publication.provenance),
        sourceManifestSha256: knowledgeHash(history.candidate.source),
        originalBinding: document.binding,
        currentTrustId: trust.id,
        currentTrustRevision: trust.revision,
        currentTrustSha256: trust.sha256,
        expiresAt: new Date(expiry).toISOString(),
      }),
      document: immutableKnowledgeJson({
        key,
        body: document.body,
        bodySha256: document.bodySha256,
      }),
    };
  }
  private issue(
    operation: KnowledgeImportRecoveryOperation,
    input: { workspaceId: string; documentKey?: string; expiresAt?: string },
  ): WorkspaceKnowledgeImportRecoveryPreview {
    guard(input, ["workspaceId"], ["documentKey", "expiresAt"]);
    const request = immutableKnowledgeJson(input),
      workspaceId = identifier(request.workspaceId);
    if (this.#close.signal.aborted) fail("KNOWLEDGE_IMPORT_CLOSED");
    if (this.#active.size >= MAX_PREVIEWS) fail("KNOWLEDGE_IMPORT_LIMIT");
    return this.#ports.readTx(() => {
      const now = this.now(),
        requested =
          request.expiresAt === undefined
            ? now + 60000
            : Date.parse(stamp(request.expiresAt));
      if (
        !Number.isSafeInteger(requested) ||
        requested <= now ||
        requested > now + 90000
      )
        fail("KNOWLEDGE_IMPORT_EXPIRED");
      const binding = validateBinding(this.#ports.checkBinding(workspaceId));
      let proof: ImportedKnowledgeDocumentProof | undefined,
        document: WorkspaceKnowledgeImportRecoveryPreview["document"] = null;
      if (operation === "activate") {
        const observed = this.proof(
          workspaceId,
          identifier(request.documentKey),
          binding,
        );
        proof = observed.proof;
        document = observed.document;
      } else if (operation === "deactivate") {
        const actual = this.#ports.native.getActivation(
          workspaceId,
          identifier(request.documentKey),
        );
        const active = actual ? immutableKnowledgeJson(actual) : undefined;
        if (!active || active.state !== "active")
          fail("KNOWLEDGE_IMPORT_ACTIVATION_UNAVAILABLE");
        // These are the original activation's historical pins; revocation does
        // not treat the old trust/expiry as a fresh authority grant.
        proof = immutableKnowledgeJson(active.proof);
      } else if (request.documentKey !== undefined)
        fail("INVALID_KNOWLEDGE_IMPORT_RECOVERY");
      if (operation === "resume" || operation === "activate")
        sync(this.#ports.assertNoExecutionUncertainty(workspaceId));
      const expiresAt = new Date(
        Math.min(
          requested,
          operation === "activate" && proof?.expiresAt
            ? Date.parse(proof.expiresAt)
            : Infinity,
        ),
      ).toISOString();
      const native = this.#ports.native.preview({
        workspaceId,
        operation,
        ...(proof ? { documentProof: proof } : {}),
        expiresAt,
      });
      try {
        const body = immutableKnowledgeJson({
          schemaVersion: 1 as const,
          projection: "host-knowledge-import-recovery-preview-v1" as const,
          workspaceId,
          operation,
          pins: native,
          document,
          expiresAt,
        });
        const preview = immutableKnowledgeJson({
          ...body,
          sha256: knowledgeHash(body),
        });
        this.#previews.set(preview, {
          public: preview,
          native,
          snapshot: knowledgeHash(preview),
          used: false,
        });
        this.#active.add(preview);
        return preview;
      } catch (error) {
        this.#ports.native.release(native);
        throw error;
      }
    });
  }
  previewResume(input: { workspaceId: string; expiresAt?: string }) {
    return this.issue("resume", input);
  }
  previewAcknowledgment(input: { workspaceId: string; expiresAt?: string }) {
    return this.issue("acknowledge", input);
  }
  previewActivation(input: {
    workspaceId: string;
    documentKey: string;
    expiresAt?: string;
  }) {
    return this.issue("activate", input);
  }
  previewDeactivation(input: {
    workspaceId: string;
    documentKey: string;
    expiresAt?: string;
  }) {
    return this.issue("deactivate", input);
  }
  private owned(preview: unknown): Owned {
    if (
      !preview ||
      typeof preview !== "object" ||
      types.isProxy(preview) ||
      !this.#active.has(preview)
    )
      fail("KNOWLEDGE_IMPORT_PREVIEW_INVALID");
    const state = this.#previews.get(preview);
    if (!state || knowledgeHash(preview) !== state.snapshot)
      fail("KNOWLEDGE_IMPORT_PREVIEW_INVALID");
    return state;
  }
  /** Fences a commit: apply() calls it before native commit, and native commit calls it again inside its write transaction. Requires the private original native preview registered in #commits. */
  assertCommitCurrent(preview: KnowledgeImportRecoveryPreview): void {
    const commit = this.#commits.get(preview);
    if (!commit || commit.state.native !== preview)
      fail("KNOWLEDGE_IMPORT_PREVIEW_INVALID");
    this.owned(commit.state.public);
    abort(commit.signal);
    abort(commit.leaseSignal);
    abort(this.#close.signal);
    if (this.now() >= Date.parse(preview.expiresAt))
      fail("KNOWLEDGE_IMPORT_EXPIRED");
    if (this.now() >= commit.deadline) fail("KNOWLEDGE_IMPORT_DEADLINE");
    const binding = validateBinding(
      this.#ports.checkBinding(preview.workspaceId),
    );
    if (!same(binding, preview.binding)) fail("KNOWLEDGE_BINDING_MISMATCH");
    if (preview.operation === "activate") {
      if (!preview.documentProof) fail("KNOWLEDGE_IMPORT_EVIDENCE_INVALID");
      const current = this.proof(
        preview.workspaceId,
        preview.documentProof.documentKey,
        binding,
      );
      if (!same(current.proof, preview.documentProof))
        fail("KNOWLEDGE_IMPORT_EVIDENCE_INVALID");
    }
    if (preview.operation === "resume" || preview.operation === "activate")
      sync(this.#ports.assertNoExecutionUncertainty(preview.workspaceId));
    abort(commit.signal);
    abort(commit.leaseSignal);
    abort(this.#close.signal);
    if (this.now() >= Date.parse(preview.expiresAt))
      fail("KNOWLEDGE_IMPORT_EXPIRED");
    if (this.now() >= commit.deadline) fail("KNOWLEDGE_IMPORT_DEADLINE");
  }
  resume(input: WorkspaceKnowledgeImportRecoveryInput) {
    return this.apply("resume", input);
  }
  acknowledge(input: WorkspaceKnowledgeImportRecoveryInput) {
    return this.apply("acknowledge", input);
  }
  activate(input: WorkspaceKnowledgeImportRecoveryInput) {
    return this.apply("activate", input);
  }
  deactivate(input: WorkspaceKnowledgeImportRecoveryInput) {
    return this.apply("deactivate", input);
  }
  private apply(
    operation: KnowledgeImportRecoveryOperation,
    input: WorkspaceKnowledgeImportRecoveryInput,
  ): Promise<WorkspaceKnowledgeImportRecoveryResult> {
    try {
      guard(
        input,
        ["workspaceId", "requestId", "approved", "preview"],
        ["reason", "signal"],
      );
      const state = this.owned(input.preview),
        request = immutableKnowledgeJson({
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          approved: input.approved,
          reason: input.reason ?? `host-approved-import-${operation}`,
        });
      identifier(request.workspaceId);
      identifier(request.requestId);
      if (
        request.approved !== true ||
        request.workspaceId !== state.public.workspaceId ||
        operation !== state.public.operation ||
        typeof request.reason !== "string" ||
        !request.reason.trim() ||
        Buffer.byteLength(request.reason) > 1024 ||
        /[\u0000-\u001f\u007f]/u.test(request.reason)
      )
        fail("KNOWLEDGE_IMPORT_PREVIEW_INVALID");
      const signal = input.signal;
      if (signal !== undefined) actualSignal(signal);
      const nativeInput = {
        requestId: request.requestId,
        approved: true as const,
        reason: request.reason,
      };
      const sameRequest = (decision?: KnowledgeImportRecoveryDecision) =>
        decision?.previewSha256 === state.native.sha256 &&
        decision.operation === operation &&
        decision.reason === request.reason;
      const committed = (duplicate: boolean) =>
        Object.freeze({
          ...this.#ports.native.commit(state.native, nativeInput),
          duplicate,
        });
      const prior = this.#ports.native.findRequest(
        request.workspaceId,
        request.requestId,
      );
      if (prior) {
        if (!sameRequest(prior)) fail("KNOWLEDGE_IMPORT_REQUEST_CONFLICT");
        return Promise.resolve(committed(true));
      }
      if (state.used) fail("KNOWLEDGE_IMPORT_PREVIEW_USED");
      if (this.#close.signal.aborted) fail("KNOWLEDGE_IMPORT_CLOSED");
      abort(signal);
      if (this.now() >= Date.parse(state.public.expiresAt))
        fail("KNOWLEDGE_IMPORT_EXPIRED");
      if (this.#reserved >= MAX_OPERATIONS) fail("KNOWLEDGE_IMPORT_LIMIT");
      state.used = true;
      this.#reserved++;
      const controller = new AbortController(),
        linked = AbortSignal.any([
          controller.signal,
          this.#close.signal,
          ...(signal ? [signal] : []),
        ]);
      const deadline = Math.min(
        this.now() + MAX_DURATION_MS,
        Date.parse(state.public.expiresAt),
      );
      const timer = setTimeout(
        () => controller.abort(deadlineReason()),
        Math.max(0, deadline - this.now()),
      );
      const task = Promise.resolve()
        .then(() =>
          this.#ports.withWorkspaceLease(
            request.workspaceId,
            async (leaseSignal) => {
              actualSignal(leaseSignal);
              abort(linked);
              abort(leaseSignal);
              this.#commits.set(state.native, {
                state,
                signal: linked,
                leaseSignal,
                deadline,
              });
              try {
                this.assertCommitCurrent(state.native);
                // Cancellation after this original commit cannot erase an observed receipt.
                return committed(false);
              } finally {
                this.#commits.delete(state.native);
              }
            },
          ),
        )
        .finally(() => {
          clearTimeout(timer);
          this.#reserved--;
        });
      this.#pending.add(task);
      void task.finally(() => this.#pending.delete(task)).catch(() => {});
      let interrupted!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        interrupted = () => {
          try {
            abort(linked);
          } catch (error) {
            reject(error);
          }
        };
        linked.addEventListener("abort", interrupted, { once: true });
        if (linked.aborted) interrupted();
      });
      // The caller gets a bounded rejection, while close/capacity still join the original lease task.
      return Promise.race([task, cancelled])
        .catch((error) => {
          const observed = this.#ports.native.findRequest(
            request.workspaceId,
            request.requestId,
          );
          if (sameRequest(observed)) return committed(false);
          throw error;
        })
        .finally(() => linked.removeEventListener("abort", interrupted));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  releasePreview(preview: WorkspaceKnowledgeImportRecoveryPreview): void {
    const state = this.owned(preview);
    if (this.#commits.has(state.native)) fail("KNOWLEDGE_IMPORT_BUSY");
    this.#ports.native.release(state.native);
    this.#active.delete(preview);
    this.#previews.delete(preview);
  }
  async close(): Promise<void> {
    this.#close.abort();
    await Promise.allSettled([...this.#pending]);
    for (const preview of [...this.#active])
      this.releasePreview(preview as WorkspaceKnowledgeImportRecoveryPreview);
  }
}
