import { types } from 'node:util';
import { EngineError } from '@moodcode/contracts';
import { readKnowledgePublicationHistory } from './publication-history.js';
import type { KnowledgeGenerationAttempt, KnowledgeGenerationRecord } from './generation-types.js';
import { validateKnowledgePublicationArchiveRow } from './publication-store.js';
import type {
  KnowledgePublicationCapture, KnowledgePublicationCommitResult, KnowledgePublicationRecord,
  KnowledgePublicationTable, PrepareKnowledgePublication, PrepareKnowledgePublicationResult,
  WorkspaceDocumentHead, WorkspaceDocumentRevision,
} from './publication-types.js';
import type { KnowledgeCandidate, KnowledgeGenerationPlan, KnowledgeHostBinding, KnowledgeSourceManifest, TrustRevision, TrustSourcePin } from './types.js';
import { identifier, immutableKnowledgeJson, knowledgeHash, sha256, stamp, validateBinding, validateTrustRevision } from './validation.js';

export interface KnowledgePublicationNativePort {
  findRequest(input: PrepareKnowledgePublication): KnowledgePublicationRecord | undefined;
  prepare(input: PrepareKnowledgePublication): PrepareKnowledgePublicationResult;
  commit(capture: KnowledgePublicationCapture): KnowledgePublicationCommitResult;
  cancel(capture: KnowledgePublicationCapture, errorCode?: string): KnowledgePublicationRecord;
  release(capture: KnowledgePublicationCapture): void;
  getPublication(workspaceId: string, publicationId: string): KnowledgePublicationRecord | undefined;
  getDocumentHead(workspaceId: string, documentKey: string): WorkspaceDocumentHead | undefined;
  getDocumentRevision(workspaceId: string, revisionId: string): WorkspaceDocumentRevision | undefined;
  /** Returns the original receipt/document/head observation, never an activation or freshness grant. */
  getCommitted(workspaceId: string, publicationId: string): KnowledgePublicationCommitResult;
}
export interface KnowledgePublicationServicePorts {
  readonly native: KnowledgePublicationNativePort;
  readonly getCandidate: (workspaceId: string, candidateId: string) => KnowledgeCandidate | undefined;
  readonly getPlan: (workspaceId: string, planId: string) => KnowledgeGenerationPlan | undefined;
  readonly getGeneration: (workspaceId: string, generationId: string) => KnowledgeGenerationRecord;
  readonly getAttempt: (workspaceId: string, attemptId: string) => KnowledgeGenerationAttempt;
  readonly getTrust: (workspaceId: string) => TrustRevision | undefined;
  readonly getTrustRevision: (workspaceId: string, revisionId: string) => TrustRevision | undefined;
  readonly checkBinding: (workspaceId: string) => KnowledgeHostBinding;
  readonly assertUnpaused: (workspaceId: string) => void;
  readonly assertTrustSourcesCurrent: (binding: KnowledgeHostBinding, sources: readonly TrustSourcePin[]) => void;
  readonly assertSourcesCurrent: (binding: KnowledgeHostBinding, source: KnowledgeSourceManifest) => void;
  readonly withLease: <T>(workspaceId: string, operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  readonly now?: () => number;
}
interface Historical {
  readonly candidate: KnowledgeCandidate;
  readonly plan: KnowledgeGenerationPlan;
  readonly generation: KnowledgeGenerationRecord;
  readonly attempt: KnowledgeGenerationAttempt;
  readonly trust: TrustRevision;
}
type ApprovalPins = Omit<PrepareKnowledgePublication, 'requestId'>;
export interface KnowledgePublicationPreview extends Historical {
  readonly projection: 'host-knowledge-publication-preview-v1';
  readonly operation: 'publish' | 'revoke';
  readonly workspaceId: string;
  readonly document: { readonly head: WorkspaceDocumentHead | null; readonly revision: WorkspaceDocumentRevision | null };
  readonly existingPublication: KnowledgePublicationRecord | null;
  readonly diff: { readonly before: string; readonly after: string; readonly beforeSha256: string | null; readonly afterSha256: string; readonly beforeBytes: number; readonly afterBytes: number };
  readonly pins: ApprovalPins;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly sha256: string;
}
export interface WorkspaceKnowledgePublicationPreviewInput { readonly workspaceId: string; readonly candidateId: string; readonly expiresAt?: string }
export interface WorkspaceKnowledgeRevocationPreviewInput { readonly workspaceId: string; readonly publicationId: string; readonly expiresAt?: string }
export interface WorkspaceKnowledgePublicationInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly approved: true;
  readonly preview: KnowledgePublicationPreview;
  readonly signal?: AbortSignal;
  readonly budget?: { readonly maxDurationMs?: number };
}
export interface WorkspaceKnowledgePublicationResult extends KnowledgePublicationCommitResult { readonly duplicate: boolean }
type PreviewState = { readonly preview: KnowledgePublicationPreview; used: boolean; requestId?: string };
type CommitState = { readonly state: PreviewState; readonly request: PrepareKnowledgePublication; readonly deadline: number; readonly signal?: AbortSignal; readonly leaseSignal: AbortSignal };
const MAX_PREVIEWS = 128, MAX_OPERATIONS = 32, MAX_PREVIEW_BYTES = 262_144, MAX_PREVIEW_MS = 300_000;
function fail(code: string, message: string): never { throw new EngineError(code, message); }
function same(left: unknown, right: unknown): boolean { return knowledgeHash(left) === knowledgeHash(right); }
function sync(value: unknown): void { if (value !== undefined) fail('KNOWLEDGE_ASYNC_PORT', 'Publication currentness ports must complete synchronously'); }
/** Descriptor checks run before reading any host input; proxy/accessor traps are never invoked. */
function hostInput(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    fail('INVALID_KNOWLEDGE_PUBLICATION', 'Publication input must be plain data');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (required.some(key => !Object.hasOwn(descriptors, key)) || keys.some(key => typeof key !== 'string' ||
    (!required.includes(key) && !optional.includes(key)) || !descriptors[key]!.enumerable || !Object.hasOwn(descriptors[key]!, 'value')))
    fail('INVALID_KNOWLEDGE_PUBLICATION', 'Publication input fields contain unsupported values');
}
function publicationRow<T>(table: KnowledgePublicationTable, value: unknown): T {
  const data = immutableKnowledgeJson(value) as unknown as { id: string; workspaceId: string };
  return validateKnowledgePublicationArchiveRow({ table, key: data.id, workspaceId: data.workspaceId, data }).data as T;
}
function actualSignal(value: unknown): asserts value is AbortSignal {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !(value instanceof AbortSignal) || Object.getPrototypeOf(value) !== AbortSignal.prototype)
    fail('INVALID_KNOWLEDGE_PUBLICATION', 'Publication signal must be an actual unmodified AbortSignal');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => !Object.hasOwn(descriptors[key as keyof typeof descriptors]!, 'value') ||
      typeof key === 'string' && ['aborted', 'reason', 'addEventListener', 'removeEventListener'].includes(key)))
    fail('INVALID_KNOWLEDGE_PUBLICATION', 'Publication signal cannot override native cancellation observations');
}
function abort(signal?: AbortSignal): void { if (signal?.aborted) fail('KNOWLEDGE_PUBLICATION_CANCELLED', 'Publication was cancelled before its commit'); }

/** Explicit host approval of exact tools-free output; this service creates no Run, provider or tool owner. */
export class KnowledgePublicationService {
  readonly #ports: KnowledgePublicationServicePorts;
  readonly #previews = new WeakMap<object, PreviewState>();
  readonly #active = new Set<object>();
  readonly #commits = new Map<string, CommitState>();
  #reserved = 0;
  constructor(ports: KnowledgePublicationServicePorts) { this.#ports = Object.freeze({ ...ports }); }
  private now(): number {
    const value = this.#ports.now?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) fail('INVALID_KNOWLEDGE_PUBLICATION', 'Publication clock is invalid');
    return value;
  }
  private historical(workspaceId: string, candidateId: string): Historical {
    return readKnowledgePublicationHistory(this.#ports, workspaceId, candidateId);
  }
  private document(workspaceId: string, key: string): KnowledgePublicationPreview['document'] {
    const raw = this.#ports.native.getDocumentHead(workspaceId, key);
    if (!raw) return Object.freeze({ head: null, revision: null });
    const head = publicationRow<WorkspaceDocumentHead>('workspace_document_heads', raw);
    const revision = publicationRow<WorkspaceDocumentRevision>('workspace_document_revisions', this.#ports.native.getDocumentRevision(workspaceId, head.revisionId));
    if (head.workspaceId !== workspaceId || head.documentKey !== key || revision.workspaceId !== workspaceId || revision.documentKey !== key || revision.id !== head.revisionId ||
        revision.revision !== head.revision || revision.publicationId !== head.publicationId || revision.bodySha256 !== head.bodySha256 || revision.status !== head.status)
      fail('KNOWLEDGE_PUBLICATION_EVIDENCE_INVALID', 'Document head does not reference its exact immutable revision');
    return Object.freeze({ head, revision });
  }
  private issue(operation: 'publish' | 'revoke', historical: Historical, existingPublication: KnowledgePublicationRecord | null, requestedExpiry?: string): KnowledgePublicationPreview {
    if (this.#active.size >= MAX_PREVIEWS) fail('KNOWLEDGE_PUBLICATION_LIMIT', 'Release old publication previews before capturing more');
    const now = this.now(), candidate = historical.candidate;
    if (candidate.target.kind !== 'workspace-document') fail('KNOWLEDGE_PUBLICATION_TARGET_UNSUPPORTED', 'This publication lane supports SQL workspace documents');
    const document = this.document(candidate.workspaceId, candidate.target.key);
    if (operation === 'publish' && (candidate.target.revision !== (document.head?.revision ?? 0) || candidate.target.sha256 !== (document.head?.bodySha256 ?? null)))
      fail('KNOWLEDGE_PUBLICATION_STALE', 'Candidate target preimage differs from the current document head');
    if (operation === 'revoke' && (!existingPublication || existingPublication.state !== 'completed' || existingPublication.operation !== 'publish' ||
        document.head?.status !== 'active' || document.head.publicationId !== existingPublication.id || document.head.revisionId !== existingPublication.documentRevisionId ||
        existingPublication.workspaceId !== candidate.workspaceId || existingPublication.documentKey !== candidate.target.key || existingPublication.body !== candidate.body ||
        existingPublication.bodySha256 !== candidate.bodySha256))
      fail('KNOWLEDGE_PUBLICATION_STALE', 'Revocation requires the exact currently active publication and head');
    const requested = requestedExpiry === undefined ? now + 60_000 : Date.parse(stamp(requestedExpiry));
    if (requested <= now || requested > now + MAX_PREVIEW_MS) fail('KNOWLEDGE_PUBLICATION_EXPIRED', 'Publication preview expiry must be within its original bounded approval window');
    const expires = operation === 'publish' ? Math.min(requested, Date.parse(candidate.expiresAt), historical.trust.expiresAt ? Date.parse(historical.trust.expiresAt) : Infinity) : requested;
    if (expires <= now) fail('KNOWLEDGE_PUBLICATION_EXPIRED', 'Publication candidate or approval expired');
    const body = operation === 'publish' ? candidate.body : '', before = document.revision?.body ?? '';
    const pins: ApprovalPins = Object.freeze({ workspaceId: candidate.workspaceId, operation, binding: candidate.binding, documentKey: candidate.target.key,
      expectedHeadRevision: document.head?.revision ?? 0, expectedHeadSha256: document.head?.bodySha256 ?? null, expectedHeadRevisionId: document.head?.revisionId ?? null,
      provenance: Object.freeze({ candidateId: candidate.id, candidateSha256: candidate.sha256, generationId: historical.generation.id, generationSha256: historical.generation.sha256,
        attemptId: historical.attempt.id, attemptSha256: historical.attempt.sha256, planId: historical.plan.id, planSha256: historical.plan.sha256,
        trustRevisionId: historical.trust.id, trustRevisionSha256: historical.trust.sha256 }),
      existingPublicationId: existingPublication?.id ?? null, existingPublicationSha256: existingPublication?.sha256 ?? null,
      bodySha256: sha256(body), expiresAt: new Date(expires).toISOString() });
    const base = { projection: 'host-knowledge-publication-preview-v1' as const, operation, workspaceId: candidate.workspaceId, ...historical, document, existingPublication,
      diff: Object.freeze({ before, after: body, beforeSha256: document.head?.bodySha256 ?? null, afterSha256: pins.bodySha256, beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(body) }),
      pins, createdAt: new Date(now).toISOString(), expiresAt: pins.expiresAt };
    if (Buffer.byteLength(JSON.stringify(base)) > MAX_PREVIEW_BYTES) fail('KNOWLEDGE_PUBLICATION_LIMIT', 'Complete approval preview exceeds its bound');
    const preview = Object.freeze({ ...base, sha256: knowledgeHash(base) });
    this.current(preview); this.#previews.set(preview, { preview, used: false }); this.#active.add(preview); return preview;
  }
  previewPublish(input: WorkspaceKnowledgePublicationPreviewInput): KnowledgePublicationPreview {
    hostInput(input, ['workspaceId', 'candidateId'], ['expiresAt']); const value = immutableKnowledgeJson(input);
    const workspaceId = identifier(value.workspaceId), candidateId = identifier(value.candidateId);
    return this.issue('publish', this.historical(workspaceId, candidateId), null, value.expiresAt as string | undefined);
  }
  previewRevoke(input: WorkspaceKnowledgeRevocationPreviewInput): KnowledgePublicationPreview {
    hostInput(input, ['workspaceId', 'publicationId'], ['expiresAt']); const value = immutableKnowledgeJson(input);
    const workspaceId = identifier(value.workspaceId), publicationId = identifier(value.publicationId);
    const publication = publicationRow<KnowledgePublicationRecord>('knowledge_publications', this.#ports.native.getPublication(workspaceId, publicationId));
    const historical = this.historical(workspaceId, publication.provenance.candidateId);
    if (!same(publication.provenance, this.provenance(historical))) fail('KNOWLEDGE_PUBLICATION_EVIDENCE_INVALID', 'Active publication does not reference the exact historical producer');
    return this.issue('revoke', historical, publication, value.expiresAt as string | undefined);
  }
  private provenance(history: Historical): ApprovalPins['provenance'] {
    return { candidateId: history.candidate.id, candidateSha256: history.candidate.sha256, generationId: history.generation.id, generationSha256: history.generation.sha256,
      attemptId: history.attempt.id, attemptSha256: history.attempt.sha256, planId: history.plan.id, planSha256: history.plan.sha256,
      trustRevisionId: history.trust.id, trustRevisionSha256: history.trust.sha256 };
  }
  private current(preview: KnowledgePublicationPreview): void {
    sync(this.#ports.assertUnpaused(preview.workspaceId));
    if (!same(validateBinding(this.#ports.checkBinding(preview.workspaceId)), preview.pins.binding)) fail('KNOWLEDGE_BINDING_MISMATCH', 'Publication workspace binding changed');
    if (this.now() >= Date.parse(preview.expiresAt)) fail('KNOWLEDGE_PUBLICATION_EXPIRED', 'Original publication approval expired');
    const history = this.historical(preview.workspaceId, preview.candidate.id);
    if (!same(this.provenance(history), preview.pins.provenance)) fail('KNOWLEDGE_PUBLICATION_STALE', 'Original publication candidate or native producer changed');
    const document = this.document(preview.workspaceId, preview.pins.documentKey);
    if (!same(document, preview.document)) fail('KNOWLEDGE_PUBLICATION_STALE', 'Exact publication document head changed after approval');
    if (preview.operation === 'publish') {
      const trust = validateTrustRevision(this.#ports.getTrust(preview.workspaceId));
      if (trust.decision !== 'allow' || trust.sha256 !== preview.trust.sha256 || trust.expiresAt !== null && this.now() >= Date.parse(trust.expiresAt))
        fail('WORKSPACE_UNTRUSTED', 'Publication requires its exact current approved trust revision');
      sync(this.#ports.assertTrustSourcesCurrent(preview.pins.binding, trust.sources));
      sync(this.#ports.assertSourcesCurrent(preview.pins.binding, preview.candidate.source));
      if (validateTrustRevision(this.#ports.getTrust(preview.workspaceId)).sha256 !== trust.sha256) fail('WORKSPACE_UNTRUSTED', 'Trust changed during publication source validation');
    } else {
      const publication = publicationRow<KnowledgePublicationRecord>('knowledge_publications', this.#ports.native.getPublication(preview.workspaceId, preview.pins.existingPublicationId!));
      if (publication.sha256 !== preview.pins.existingPublicationSha256 || document.head?.status !== 'active' || document.head.publicationId !== publication.id)
        fail('KNOWLEDGE_PUBLICATION_STALE', 'Revocation original active publication changed');
      // Revocation only removes authority. Current source staleness or a newer deny trust
      // cannot block removal; the exact historical cleanup/owner and live head still must match.
    }
    sync(this.#ports.assertUnpaused(preview.workspaceId));
    if (!same(validateBinding(this.#ports.checkBinding(preview.workspaceId)), preview.pins.binding) || !same(this.document(preview.workspaceId, preview.pins.documentKey), preview.document))
      fail('KNOWLEDGE_PUBLICATION_STALE', 'Publication binding or document changed during currentness validation');
    if (this.now() >= Date.parse(preview.expiresAt)) fail('KNOWLEDGE_PUBLICATION_EXPIRED', 'Original publication approval expired during validation');
  }
  /** Native commit calls this synchronously in its actual SQL transaction, before document CAS. */
  assertCommitCurrent(value: KnowledgePublicationRecord): void {
    const record = publicationRow<KnowledgePublicationRecord>('knowledge_publications', value), context = this.#commits.get(record.id);
    if (!context || record.state !== 'prepared' || record.requestSha256 !== knowledgeHash(context.request) ||
        !same(record.provenance, context.state.preview.pins.provenance) || record.body !== context.state.preview.diff.after)
      fail('KNOWLEDGE_PUBLICATION_PREVIEW_INVALID', 'Native commit has no original approved service preview');
    abort(context.signal); abort(context.leaseSignal);
    if (this.now() >= context.deadline) fail('KNOWLEDGE_PUBLICATION_DEADLINE', 'Original publication operation budget expired');
    this.current(context.state.preview);
    abort(context.signal); abort(context.leaseSignal);
    if (this.now() >= context.deadline) fail('KNOWLEDGE_PUBLICATION_DEADLINE', 'Original publication operation budget expired during currentness validation');
  }
  private owned(preview: unknown): PreviewState {
    if (!preview || typeof preview !== 'object' || types.isProxy(preview) || !this.#active.has(preview))
      fail('KNOWLEDGE_PUBLICATION_PREVIEW_INVALID', 'Publication preview is foreign, copied, released or never issued');
    return this.#previews.get(preview) ?? fail('KNOWLEDGE_PUBLICATION_PREVIEW_INVALID', 'Publication preview has no host owner');
  }
  releasePreview(preview: KnowledgePublicationPreview): void { this.owned(preview); this.#active.delete(preview); this.#previews.delete(preview); }
  publish(input: WorkspaceKnowledgePublicationInput): Promise<WorkspaceKnowledgePublicationResult> { return this.apply('publish', input); }
  revoke(input: WorkspaceKnowledgePublicationInput): Promise<WorkspaceKnowledgePublicationResult> { return this.apply('revoke', input); }
  private async apply(operation: 'publish' | 'revoke', input: WorkspaceKnowledgePublicationInput): Promise<WorkspaceKnowledgePublicationResult> {
    hostInput(input, ['workspaceId', 'requestId', 'approved', 'preview'], ['signal', 'budget']);
    const state = this.owned(input.preview);
    const ordinary = immutableKnowledgeJson({ workspaceId: input.workspaceId, requestId: input.requestId, approved: input.approved, ...(Object.hasOwn(input, 'budget') ? { budget: input.budget } : {}) });
    const workspaceId = identifier(ordinary.workspaceId), requestId = identifier(ordinary.requestId), signal = input.signal;
    if (ordinary.approved !== true || workspaceId !== state.preview.workspaceId || operation !== state.preview.operation)
      fail('KNOWLEDGE_PUBLICATION_PREVIEW_INVALID', 'Publication requires explicit approval of the original exact workspace operation');
    if (signal !== undefined) actualSignal(signal);
    let maxDurationMs = 5_000;
    if (ordinary.budget !== undefined) {
      hostInput(ordinary.budget, [], ['maxDurationMs']);
      const duration = (ordinary.budget as { maxDurationMs?: unknown }).maxDurationMs;
      if (duration !== undefined) {
        if (!Number.isSafeInteger(duration) || (duration as number) < 1 || (duration as number) > 30_000) fail('KNOWLEDGE_PUBLICATION_LIMIT', 'Publication duration must be 1 through 30000 milliseconds');
        maxDurationMs = duration as number;
      }
    }
    const request = immutableKnowledgeJson({ ...state.preview.pins, requestId }) as PrepareKnowledgePublication;
    const prior = this.#ports.native.findRequest(request);
    if (prior) {
      const duplicate = publicationRow<KnowledgePublicationRecord>('knowledge_publications', prior);
      if (duplicate.state !== 'completed') fail('KNOWLEDGE_PUBLICATION_NOT_COMPLETED', 'Original publication request is not a completed historical receipt');
      return Object.freeze({ ...this.#ports.native.getCommitted(workspaceId, duplicate.id), duplicate: true });
    }
    if (state.used) fail('KNOWLEDGE_PUBLICATION_PREVIEW_USED', 'An approved preview cannot authorize another publication request');
    abort(signal);
    if (this.#reserved >= MAX_OPERATIONS) fail('KNOWLEDGE_PUBLICATION_LIMIT', 'Too many publication operations are pending');
    state.used = true; state.requestId = requestId; this.#reserved++;
    const deadline = Math.min(this.now() + maxDurationMs, Date.parse(state.preview.expiresAt));
    const controller = new AbortController();
    const callerAbort = () => controller.abort(new EngineError('KNOWLEDGE_PUBLICATION_CANCELLED', 'Publication was cancelled before its commit'));
    signal?.addEventListener('abort', callerAbort, { once: true }); if (signal?.aborted) callerAbort();
    const timer = setTimeout(() => controller.abort(new EngineError('KNOWLEDGE_PUBLICATION_DEADLINE', 'Original publication operation budget expired')),
      Math.max(0, deadline - this.now()));
    let aborted!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      aborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', aborted, { once: true }); if (controller.signal.aborted) aborted();
    });
    let capture: KnowledgePublicationCapture | undefined, committed: KnowledgePublicationCommitResult | undefined;
    try {
      const leased = this.#ports.withLease(workspaceId, async leaseSignal => {
        actualSignal(leaseSignal);
        abort(controller.signal); abort(leaseSignal);
        if (this.now() >= deadline) fail('KNOWLEDGE_PUBLICATION_DEADLINE', 'Original publication operation budget expired before lease entry');
        this.current(state.preview);
        abort(controller.signal); abort(leaseSignal);
        if (this.now() >= deadline) fail('KNOWLEDGE_PUBLICATION_DEADLINE', 'Original publication operation budget expired before preparation');
        const prepared = this.#ports.native.prepare(request);
        if (prepared.kind === 'duplicate') {
          if (prepared.record.state !== 'completed') fail('KNOWLEDGE_PUBLICATION_NOT_COMPLETED', 'Concurrent duplicate did not commit an observed document');
          return Object.freeze({ ...this.#ports.native.getCommitted(workspaceId, prepared.record.id), duplicate: true });
        }
        capture = prepared.capture;
        this.#commits.set(prepared.record.id, { state, request, deadline, signal: controller.signal, leaseSignal });
        committed = this.#ports.native.commit(capture);
        // A caller cancellation after the native transaction cannot erase its actual receipt.
        return Object.freeze({ ...committed, duplicate: false });
      });
      return await Promise.race([leased, interrupted]);
    } catch (error) {
      if (committed) return Object.freeze({ ...committed, duplicate: false });
      const observed = this.#ports.native.findRequest(request);
      if (observed?.state === 'completed') return Object.freeze({ ...this.#ports.native.getCommitted(workspaceId, observed.id), duplicate: true });
      if (capture) try { this.#ports.native.cancel(capture, error instanceof EngineError ? error.code : 'KNOWLEDGE_PUBLICATION_FAILED'); } catch { /* release() retries the cancel and reports its own failure. */ }
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', callerAbort); controller.signal.removeEventListener('abort', aborted);
      this.#reserved--;
      if (capture) {
        this.#commits.delete(capture.publicationId);
        try { this.#ports.native.release(capture); } catch (error) { if (!committed) throw error; }
      }
    }
  }
}
