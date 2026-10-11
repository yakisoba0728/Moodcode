import { EngineError, isTerminal, type ReasoningEffort, type Run } from '@moodcode/contracts';
import type { ProviderAdapter } from './ports.js';
import type { SqliteStore } from './storage/index.js';
import type { EngineRuntime } from './engine-runtime.js';
import type { EngineLifetime, EngineStorage } from './engine-kernel.js';
import type { EngineFeatures } from './engine-options.js';
import type { AgentProfiles } from './agents/index.js';
import type { RecoveryGate } from './recovery/gate.js';
import { validateHostGenerationRequest, type HostGenerationProviderPort } from './provider/generation.js';
import { acquireExecutionLock, assertExecutionLockAvailable, readExecutionLockReservation, reserveExecutionLock } from './tools/command/execution-lock.js';
import { WorkspaceTrustService, assertWorkspaceTrustSourcesCurrent } from './workspace/trust.js';
import type { KnowledgeStorage } from './knowledge/store.js';
import type { KnowledgeHostAdapter, KnowledgeSourceProjection, KnowledgeSourceSelection } from './knowledge/host.js';
import type { PrepareKnowledgeGeneration } from './knowledge/types.js';
import { knowledgeHash, validateGenerationInput } from './knowledge/validation.js';
import { buildKnowledgeGenerationRequest } from './knowledge/generation-request.js';
import { assertKnowledgeGenerationHostInput, KnowledgeGenerationService, type WorkspaceKnowledgeGenerationInput } from './knowledge/generation-service.js';
import type { KnowledgeGenerationStorage } from './knowledge/generation-store.js';
import type { KnowledgeGenerationRecoveryPreview } from './knowledge/generation-types.js';
import type { KnowledgePublicationStorage } from './knowledge/publication-store.js';
import { KnowledgePublicationService } from './knowledge/publication-service.js';
import { KnowledgeFilePublicationService } from './knowledge/file-publication-service.js';
import type { KnowledgeFilePublicationStorage } from './knowledge/file-publication-store.js';
import type { KnowledgeFileRecoveryPreview } from './knowledge/file-publication-types.js';
import { FileKnowledgePublicationHost } from './knowledge/file-publication-fs.js';
import type { KnowledgeFileExecutionGuards } from './knowledge/file-execution-guards.js';
import type { KnowledgeImportRecoveryStorage } from './knowledge/import-recovery-store.js';
import { KnowledgeImportRecoveryService } from './knowledge/import-recovery-service.js';
import type { KnowledgeContextPolicy } from './knowledge/context-types.js';

export interface ContextOwner { sessionId: string; runId: string | null; profile: unknown }

export type ProfileIdentity = (run: Run) => ReturnType<AgentProfiles['pinForRun']>;

/** Throws `code` unless a context capture still belongs to its workspace session, active Run and admitted profile. */
export function assertContextOwnerCurrent(store: SqliteStore, profileIdentity: ProfileIdentity, code: string, messages: readonly [string, string, string, string], workspaceId: string, owner: ContextOwner): void {
  const session = store.getSession(owner.sessionId);
  if (session.workspaceId !== workspaceId) throw new EngineError(code, messages[0]);
  if (owner.runId === null) {
    if (owner.profile !== null) throw new EngineError(code, messages[1]);
    return;
  }
  const run = store.getRun(owner.runId);
  if (run.sessionId !== session.id || run.workspaceId !== workspaceId || isTerminal(run.state) || run.state === 'cancelling') throw new EngineError(code, messages[2]);
  if (knowledgeHash(owner.profile) !== knowledgeHash(profileIdentity(run))) throw new EngineError(code, messages[3]);
}

export type FileRecoveryInput = { workspaceId: string; requestId: string; approved: true; preview: KnowledgeFileRecoveryPreview; reason: string };

export class EngineKnowledge {
  readonly filePublications: KnowledgeFilePublicationStorage;
  readonly fileGuards: KnowledgeFileExecutionGuards;
  readonly fileHost: FileKnowledgePublicationHost;
  readonly host: KnowledgeHostAdapter;
  readonly records: KnowledgeStorage;
  readonly generations: KnowledgeGenerationStorage;
  readonly publications: KnowledgePublicationStorage;
  readonly imports: KnowledgeImportRecoveryStorage;
  readonly trust: WorkspaceTrustService;
  readonly generationService: KnowledgeGenerationService;
  readonly publicationService: KnowledgePublicationService;
  readonly filePublicationService: KnowledgeFilePublicationService;
  readonly importService: KnowledgeImportRecoveryService;
  private readonly fileRecoveryPreviews = new WeakMap<KnowledgeFileRecoveryPreview, string>();
  private readonly recoveryPreviews = new WeakMap<KnowledgeGenerationRecoveryPreview, string>();
  private readonly liveRecoveryPreviews = new Map<string, KnowledgeGenerationRecoveryPreview>();

  constructor(private readonly store: SqliteStore, private readonly storage: EngineStorage, private readonly gate: RecoveryGate, private readonly lifetime: EngineLifetime,
    private readonly enabled: EngineFeatures, private readonly engine: Pick<EngineRuntime, 'coordinator'>, private readonly providers: () => ReadonlyMap<string, ProviderAdapter>) {
    const knowledgeBinding = storage.knowledgeBinding, executionLockPath = storage.executionLockPath;
    this.filePublications = store.createKnowledgeFilePublicationStorage({ checkBinding: knowledgeBinding,
      getCandidate: (workspaceId, candidateId) => this.records.getCandidate(workspaceId, candidateId),
      assertCommitCurrent: (record, phase) => this.filePublicationService.assertCommitCurrent(record, phase),
      beforeRecoveryDecision: (workspaceId, operation) => {
        if (operation === 'acknowledge') this.fileGuards.reconcile(workspaceId, executionLockPath);
        gate.assertIdle();
        if (operation === 'resume') gate.assertCertain('knowledgeFileResume', workspaceId);
      } });
    this.fileGuards = store.createKnowledgeFileExecutionGuards({ checkBinding: knowledgeBinding,
      getOwner: (workspaceId, id) => { const owner = this.filePublications.getOwner(workspaceId, id); if (!owner) throw new EngineError('KNOWLEDGE_FILE_NOT_FOUND', 'Physical publication owner does not exist in this workspace'); return owner; } });
    this.fileHost = new FileKnowledgePublicationHost({ checkBinding: knowledgeBinding,
      readTargetRevision: (binding, path) => this.filePublications.getCurrentTarget(binding.workspaceId, path)?.revision ?? 0,
      acquireExecutionGuard: (binding, publicationId) => {
        // A busy lock found here leaves no guard row, so the owner settles as cancelled, not uncertain.
        assertExecutionLockAvailable(executionLockPath);
        const reservation = reserveExecutionLock(executionLockPath);
        this.fileGuards.reserve(binding, publicationId, executionLockPath, readExecutionLockReservation(reservation));
        try { return acquireExecutionLock(executionLockPath, reservation); }
        catch { throw new EngineError('KNOWLEDGE_FILE_CLEANUP_UNCERTAIN', 'File execution marker may stay committed after a failed lock acquisition'); }
      } });
    this.host = store.createKnowledgeHostAdapter({ checkHostBinding: knowledgeBinding,
      ...(enabled.knowledgeFilePublication ? { readFileTargetRevision: (binding: ReturnType<typeof knowledgeBinding>, path: string) =>
        this.filePublications.captureTarget(binding, this.fileHost.observeTargetSync(binding, path)).revision } : {}),
      readWorkspaceDocumentTarget: (binding, key) => this.publications.captureDocumentTarget(binding.workspaceId, key) });
    this.records = store.createKnowledgeStorage({ checkHostBinding: knowledgeBinding, assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent,
      assertSourcesCurrent: (binding, source) => this.host.assertSourcesCurrent(binding, source), assertTargetCurrent: (binding, target) => this.host.assertTargetCurrent(binding, target),
      readGenerationEvidence: (plan, ownerId) => this.generations.readEvidence(plan, ownerId) });
    this.generations = store.createKnowledgeGenerationStorage({ checkBinding: knowledgeBinding,
      getPlan: (workspaceId, planId) => this.records.getGenerationPlan(workspaceId, planId),
      assertPlanCurrent: plan => this.records.assertGenerationPlanCurrent(plan) });
    this.publications = store.createKnowledgePublicationStorage({ checkBinding: knowledgeBinding,
      getCandidate: (workspaceId, candidateId) => this.records.getCandidate(workspaceId, candidateId),
      assertCommitCurrent: record => this.publicationService.assertCommitCurrent(record) });
    this.imports = store.createKnowledgeImportRecoveryStorage({ checkBinding: knowledgeBinding,
      assertCommitCurrent: preview => this.importService.assertCommitCurrent(preview) });
    this.trust = new WorkspaceTrustService(this.records);
    this.generationService = new KnowledgeGenerationService({ native: this.generations, knowledge: this.records, host: this.host,
      provider: id => this.generationProvider(id), assertPlanCurrent: plan => this.records.assertGenerationPlanCurrent(plan),
      withLease: (workspaceId, operation) => this.engine.coordinator.withHostGenerationLease(workspaceId, operation) });
    this.publicationService = new KnowledgePublicationService({ native: this.publications,
      getCandidate: (workspaceId, candidateId) => this.records.getCandidate(workspaceId, candidateId),
      getPlan: (workspaceId, planId) => this.records.getGenerationPlan(workspaceId, planId),
      getGeneration: (workspaceId, generationId) => this.generations.getGeneration(workspaceId, generationId),
      getAttempt: (workspaceId, attemptId) => this.generations.getAttempt(workspaceId, attemptId),
      getTrust: workspaceId => this.records.getTrust(workspaceId),
      getTrustRevision: (workspaceId, revisionId) => this.records.getTrustRevision(workspaceId, revisionId),
      checkBinding: knowledgeBinding, assertUnpaused: workspaceId => this.records.assertUnpaused(workspaceId),
      assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent,
      assertSourcesCurrent: (binding, source) => this.host.assertSourcesCurrent(binding, source),
      withLease: (workspaceId, operation) => this.engine.coordinator.withWorkspaceLease(workspaceId, operation) });
    this.filePublicationService = new KnowledgeFilePublicationService({ native: this.filePublications, host: this.fileHost,
      getCandidate: (workspaceId, id) => this.records.getCandidate(workspaceId, id),
      getPlan: (workspaceId, id) => this.records.getGenerationPlan(workspaceId, id),
      getGeneration: (workspaceId, id) => this.generations.getGeneration(workspaceId, id),
      getAttempt: (workspaceId, id) => this.generations.getAttempt(workspaceId, id),
      getTrust: workspaceId => this.records.getTrust(workspaceId),
      getTrustRevision: (workspaceId, id) => this.records.getTrustRevision(workspaceId, id),
      checkBinding: knowledgeBinding, assertUnpaused: workspaceId => this.records.assertUnpaused(workspaceId),
      assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent,
      assertSourcesCurrent: (binding, source) => this.host.assertSourcesCurrent(binding, source),
      signal: lifetime.signal, withLease: (workspaceId, operation) => this.engine.coordinator.withHostFilePublicationLease(workspaceId, operation) });
    this.importService = new KnowledgeImportRecoveryService({ native: this.imports,
      readTx: operation => store.readExecutionObservationEvidence(operation), checkBinding: knowledgeBinding,
      readActivationProof: (workspaceId, key) => store.readKnowledgeImportDocumentProof(workspaceId, key),
      assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent,
      assertSourcesCurrent: (binding, source) => this.host.assertSourcesCurrent(binding, source),
      assertNoExecutionUncertainty: workspaceId => {
        gate.assertIdle();
        gate.assertCertain('knowledgeImportActivation', workspaceId);
        if (this.imports.getFrontier(workspaceId)?.head.state === 'resumed') gate.assertCertain('knowledgeImportSuccessors', workspaceId);
      },
      withWorkspaceLease: (workspaceId, operation) => gate.lease(workspaceId, signal => {
        gate.assertOpen(signal, 'Engine closed during import recovery');
        gate.assertIdle();
        return operation(signal);
      }),
    });
  }

  /** The read-only context source over current approved documents selected by a host policy. */
  context(policy: KnowledgeContextPolicy, profileIdentity: ProfileIdentity) {
    return {
      policy,
      getProfile: (run: Run) => profileIdentity(run) ?? undefined,
      source: this.store.createKnowledgeContextSource({
        checkBinding: this.storage.knowledgeBinding,
        assertOwnerCurrent: (workspaceId, owner) => assertContextOwnerCurrent(this.store, profileIdentity, 'KNOWLEDGE_CONTEXT_STALE', [
          'Knowledge context session belongs to another workspace', 'Profile selection requires its admitted Run owner',
          'Knowledge context requires its original active Run and session', 'Knowledge context profile differs from its admitted host configuration',
        ], workspaceId, owner),
        isPaused: workspaceId => this.records.isImportPaused(workspaceId),
        getDocumentHead: (workspaceId, key) => this.publications.getDocumentHead(workspaceId, key),
        getDocumentRevision: (workspaceId, id) => this.publications.getDocumentRevision(workspaceId, id),
        getPublication: (workspaceId, id) => this.publications.getPublication(workspaceId, id),
        getReceipt: (workspaceId, requestId) => this.publications.getReceipt(workspaceId, requestId),
        getCandidate: (workspaceId, id) => this.records.getCandidate(workspaceId, id),
        getGeneration: (workspaceId, id) => this.generations.getGeneration(workspaceId, id),
        getAttempt: (workspaceId, id) => this.generations.getAttempt(workspaceId, id),
        getPlan: (workspaceId, id) => this.records.getGenerationPlan(workspaceId, id),
        getTrust: workspaceId => this.records.getTrust(workspaceId),
        getTrustRevision: (workspaceId, id) => this.records.getTrustRevision(workspaceId, id),
        assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent,
        assertSourcesCurrent: (binding, source) => this.host.assertSourcesCurrent(binding, source),
      }),
    };
  }

  /** Releases the recovery previews still held for the host; close calls this after its services settle. */
  releaseRecoveryPreviews(): void {
    for (const preview of this.liveRecoveryPreviews.values()) this.generations.releaseRecoveryPreview(preview);
    this.liveRecoveryPreviews.clear();
  }

  previewTrust(workspaceId: string, paths: readonly string[]) {
    this.lifetime.assertOpen();
    return this.trust.preview(workspaceId, paths);
  }

  setTrust(input: Parameters<WorkspaceTrustService['set']>[0]) {
    if (this.lifetime.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    this.store.getWorkspace(input.workspaceId);
    return this.engine.coordinator.withWorkspaceLease(input.workspaceId, async signal => { if (signal.aborted) throw signal.reason; return this.trust.set(input); });
  }

  private assertImportRecoveryEnabled(): void { this.lifetime.assertEnabled(this.enabled.knowledgeImportRecovery, 'KNOWLEDGE_IMPORT_RECOVERY_DISABLED', 'Imported knowledge recovery requires explicit host opt-in'); }
  previewImportAcknowledgment(input: Parameters<KnowledgeImportRecoveryService['previewAcknowledgment']>[0]) {
    this.assertImportRecoveryEnabled(); return this.importService.previewAcknowledgment(input);
  }
  previewImportRecovery(input: Parameters<KnowledgeImportRecoveryService['previewResume']>[0]) {
    this.assertImportRecoveryEnabled(); return this.importService.previewResume(input);
  }
  previewImportActivation(input: Parameters<KnowledgeImportRecoveryService['previewActivation']>[0]) {
    this.assertImportRecoveryEnabled(); return this.importService.previewActivation(input);
  }
  previewImportDeactivation(input: Parameters<KnowledgeImportRecoveryService['previewDeactivation']>[0]) {
    this.assertImportRecoveryEnabled(); return this.importService.previewDeactivation(input);
  }
  acknowledgeImport(input: Parameters<KnowledgeImportRecoveryService['acknowledge']>[0]) {
    return this.lifetime.rejecting(() => { this.assertImportRecoveryEnabled(); return this.importService.acknowledge(input); });
  }
  resumeImport(input: Parameters<KnowledgeImportRecoveryService['resume']>[0]) {
    return this.lifetime.rejecting(() => { this.assertImportRecoveryEnabled(); return this.importService.resume(input); });
  }
  activateImport(input: Parameters<KnowledgeImportRecoveryService['activate']>[0]) {
    return this.lifetime.rejecting(() => { this.assertImportRecoveryEnabled(); return this.importService.activate(input); });
  }
  deactivateImport(input: Parameters<KnowledgeImportRecoveryService['deactivate']>[0]) {
    return this.lifetime.rejecting(() => { this.assertImportRecoveryEnabled(); return this.importService.deactivate(input); });
  }
  getImportFrontier(workspaceId: string) {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => this.imports.getFrontier(workspaceId));
  }
  getImportActivation(workspaceId: string, documentKey: string) {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => this.imports.getActivation(workspaceId, documentKey));
  }

  captureSources(workspaceId: string, selection: readonly KnowledgeSourceSelection[]) {
    this.lifetime.assertOpen();
    return this.host.captureSources({ workspaceId, selection });
  }

  releaseSources(projection: KnowledgeSourceProjection): void {
    this.host.releaseProjection(projection);
  }

  previewGeneration(input: { providerId: string; modelId: string; projection: KnowledgeSourceProjection; reasoningEffort?: ReasoningEffort }) {
    this.lifetime.assertOpen();
    assertKnowledgeGenerationHostInput(input, ['providerId', 'modelId', 'projection'], ['reasoningEffort']);
    this.generationProvider(input.providerId);
    this.host.assertProjectionFresh(input.projection);
    const request = buildKnowledgeGenerationRequest({ providerId: input.providerId, modelId: input.modelId, source: input.projection,
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }) });
    // Store-issued generation and attempt UUIDs have this exact width; check the full envelope before native admission.
    validateHostGenerationRequest({ ...request.payload, owner: { kind: 'host-generation', workspaceId: input.projection.workspaceId,
      generationId: '00000000-0000-0000-0000-000000000000', attemptId: '00000000-0000-0000-0000-000000000000' } });
    return request;
  }

  private generationProvider(providerId: string): ProviderAdapter & HostGenerationProviderPort {
    if (!this.enabled.knowledgeGeneration) throw new EngineError('KNOWLEDGE_GENERATION_DISABLED', 'Host knowledge extraction requires explicit opt-in');
    const provider = this.providers().get(providerId);
    if (!provider || typeof provider.streamGeneration !== 'function') throw new EngineError('KNOWLEDGE_PROVIDER_UNSUPPORTED', 'Provider does not support an independently owned tools-free generation');
    return provider as ProviderAdapter & HostGenerationProviderPort;
  }

  prepareGeneration(input: Omit<PrepareKnowledgeGeneration, 'binding' | 'source'> & { projection: KnowledgeSourceProjection }) {
    return this.lifetime.rejecting(() => {
      this.lifetime.assertOpen();
      assertKnowledgeGenerationHostInput(input, ['workspaceId', 'requestId', 'expectedTrustRevision', 'target', 'providerId', 'modelId', 'requestSha256', 'requestBytes', 'maxOutputBytes', 'expiresAt', 'projection']);
      const { projection, ...description } = input;
      this.host.assertProjectionFresh(projection);
      const plan = validateGenerationInput({ ...description, binding: projection.binding, source: projection.manifest });
      if (plan.workspaceId !== projection.workspaceId) throw new EngineError('KNOWLEDGE_BINDING_MISMATCH', 'Pending generation and original source projection must share the workspace');
      return this.engine.coordinator.withWorkspaceLease(plan.workspaceId, async signal => {
        if (signal.aborted) throw signal.reason;
        this.host.assertProjectionFresh(projection);
        return this.records.prepareGeneration(plan);
      });
    });
  }

  captureTarget(workspaceId: string, path: string) {
    this.lifetime.assertOpen();
    return this.host.captureFileTarget(workspaceId, path);
  }
  captureDocumentTarget(workspaceId: string, key: string) {
    this.lifetime.assertOpen();
    return this.host.captureDocumentTarget(workspaceId, key);
  }

  private assertPublicationEnabled(): void { this.lifetime.assertEnabled(this.enabled.knowledgePublication, 'KNOWLEDGE_PUBLICATION_DISABLED', 'Workspace publication requires explicit host opt-in'); }
  private assertFilePublicationEnabled(): void { this.lifetime.assertEnabled(this.enabled.knowledgeFilePublication, 'KNOWLEDGE_FILE_PUBLICATION_DISABLED', 'Physical knowledge publication requires explicit host opt-in'); }
  previewFilePublication(input: Parameters<KnowledgeFilePublicationService['previewPublish']>[0]) {
    return this.lifetime.rejecting(() => { this.assertFilePublicationEnabled(); return this.filePublicationService.previewPublish(input); });
  }
  previewFileRevocation(input: Parameters<KnowledgeFilePublicationService['previewRevoke']>[0]) {
    return this.lifetime.rejecting(() => { this.assertFilePublicationEnabled(); return this.filePublicationService.previewRevoke(input); });
  }
  publishFile(input: Parameters<KnowledgeFilePublicationService['publish']>[0]) {
    return this.lifetime.rejecting(() => { this.assertFilePublicationEnabled(); return this.filePublicationService.publish(input); });
  }
  revokeFile(input: Parameters<KnowledgeFilePublicationService['revoke']>[0]) {
    return this.lifetime.rejecting(() => { this.assertFilePublicationEnabled(); return this.filePublicationService.revoke(input); });
  }
  getFilePublication(workspaceId: string, id: string) { this.lifetime.assertOpen(); return this.filePublications.getOwner(workspaceId, id); }
  getFilePublicationReceipt(workspaceId: string, requestId: string) { this.lifetime.assertOpen(); return this.filePublications.getReceipt(workspaceId, requestId); }
  getFileTarget(workspaceId: string, path: string) { this.lifetime.assertOpen(); return this.filePublications.getCurrentTarget(workspaceId, path); }
  previewFileRecovery(workspaceId: string) {
    this.assertFilePublicationEnabled();
    const preview = this.filePublications.previewRecovery(workspaceId); this.fileRecoveryPreviews.set(preview, workspaceId); return preview;
  }
  fileRecoveryDecision(operation: 'acknowledge' | 'resume', input: FileRecoveryInput) {
    return this.lifetime.rejecting(() => {
      this.assertFilePublicationEnabled(); assertKnowledgeGenerationHostInput(input, ['workspaceId','requestId','approved','preview','reason']);
      const prepared = Object.freeze({ ...input }), workspaceId = this.fileRecoveryPreviews.get(prepared.preview);
      if (!workspaceId || workspaceId !== prepared.workspaceId || prepared.approved !== true) throw new EngineError('KNOWLEDGE_FILE_RECOVERY_PREVIEW_INVALID', 'Physical recovery requires the original host preview and explicit approval');
      return this.gate.decide(workspaceId, { hold: true }, () => operation === 'acknowledge' ? this.filePublications.acknowledge(prepared) : this.filePublications.resume(prepared));
    });
  }
  listFilePublications(workspaceId: string, options?: Parameters<KnowledgeFilePublicationStorage['listPublications']>[1]) { this.lifetime.assertOpen(); return this.filePublications.listPublications(workspaceId, options); }

  previewPublication(input: Parameters<KnowledgePublicationService['previewPublish']>[0]) {
    this.assertPublicationEnabled();
    return this.publicationService.previewPublish(input);
  }
  previewRevocation(input: Parameters<KnowledgePublicationService['previewRevoke']>[0]) {
    this.assertPublicationEnabled();
    return this.publicationService.previewRevoke(input);
  }
  publish(input: Parameters<KnowledgePublicationService['publish']>[0]) {
    return this.lifetime.rejecting(() => { this.assertPublicationEnabled(); return this.publicationService.publish(input); });
  }
  revoke(input: Parameters<KnowledgePublicationService['revoke']>[0]) {
    return this.lifetime.rejecting(() => { this.assertPublicationEnabled(); return this.publicationService.revoke(input); });
  }
  getPublication(workspaceId: string, publicationId: string) {
    this.lifetime.assertOpen();
    const publication = this.publications.getPublication(workspaceId, publicationId);
    if (!publication) throw new EngineError('KNOWLEDGE_PUBLICATION_NOT_FOUND', 'Publication does not exist in this workspace');
    if (publication.state === 'completed') {
      const committed = this.publications.getCommitted(workspaceId, publicationId);
      if (!committed) throw new EngineError('KNOWLEDGE_PUBLICATION_CONFLICT', 'Completed publication has no original committed receipt');
      return { ...committed, duplicate: true as const };
    }
    return { publication, document: null, head: null, receipt: null, duplicate: true as const };
  }

  getPublicationRecord(workspaceId: string, publicationId: string) {
    this.lifetime.assertOpen();
    return this.publications.getPublication(workspaceId, publicationId);
  }
  getDocument(workspaceId: string, key: string) {
    this.lifetime.assertOpen();
    return this.publications.getCurrentDocument(workspaceId, key);
  }
  getDocumentRevision(workspaceId: string, revisionId: string) {
    this.lifetime.assertOpen();
    return this.publications.getDocumentRevision(workspaceId, revisionId);
  }
  getPublicationReceipt(workspaceId: string, requestId: string) {
    this.lifetime.assertOpen();
    return this.publications.getReceipt(workspaceId, requestId);
  }
  listPublications(workspaceId: string, options: Parameters<KnowledgePublicationStorage['listPublications']>[1]) {
    this.lifetime.assertOpen();
    return this.publications.listPublications(workspaceId, options);
  }
  listDocumentRevisions(workspaceId: string, key: string, options: Parameters<KnowledgePublicationStorage['listDocumentRevisions']>[2]) {
    this.lifetime.assertOpen();
    return this.publications.listDocumentRevisions(workspaceId, key, options);
  }

  generate(input: WorkspaceKnowledgeGenerationInput) {
    return this.lifetime.rejecting(() => {
      this.lifetime.assertOpen();
      return this.generationService.generate(input);
    });
  }

  getGeneration(workspaceId: string, generationId: string) {
    this.lifetime.assertOpen();
    return this.generationService.get(workspaceId, generationId);
  }

  finishCandidate(input: { workspaceId: string; generationId: string; requestId: string }) {
    return this.lifetime.rejecting(() => {
      this.lifetime.assertEnabled(this.enabled.knowledgeGeneration, 'KNOWLEDGE_GENERATION_DISABLED', 'Host knowledge extraction requires explicit opt-in');
      return this.generationService.finish(input);
    });
  }

  cancelGeneration(workspaceId: string, generationId: string) {
    this.lifetime.assertOpen();
    return this.generationService.cancel(workspaceId, generationId);
  }

  recoveryPreview(workspaceId: string) {
    this.lifetime.assertOpen();
    const preview = this.generations.getRecoveryPreview(workspaceId);
    this.recoveryPreviews.set(preview, workspaceId);
    this.liveRecoveryPreviews.set(workspaceId, preview);
    return preview;
  }

  acknowledgeRecovery(input: { preview: KnowledgeGenerationRecoveryPreview; requestId: string; reason: string; acknowledged: true }) {
    return this.lifetime.rejecting(() => {
      this.lifetime.assertOpen();
      assertKnowledgeGenerationHostInput(input, ['preview', 'requestId', 'reason', 'acknowledged']);
      const { preview, requestId, reason, acknowledged } = input;
      const workspaceId = this.recoveryPreviews.get(preview);
      if (!workspaceId || acknowledged !== true) throw new EngineError('KNOWLEDGE_RECOVERY_PREVIEW_INVALID', 'Recovery requires the original host preview and explicit acknowledgment');
      return this.gate.decide(workspaceId, { idle: true, hold: true }, () => this.generations.acknowledgeRecovery(preview, { requestId, reason }));
    });
  }

  resume(input: { workspaceId: string; requestId: string; expectedRevision: number; expectedFrontierSha256: string }) {
    return this.lifetime.rejecting(() => {
      this.lifetime.assertOpen();
      assertKnowledgeGenerationHostInput(input, ['workspaceId', 'requestId', 'expectedRevision', 'expectedFrontierSha256']);
      const prepared = Object.freeze({ ...input });
      return this.gate.decide(prepared.workspaceId, { idle: true, hold: true }, () => {
        this.gate.assertCertain('knowledgeGenerationResume', prepared.workspaceId);
        return this.generations.resumeWorkspace(prepared);
      });
    });
  }
}
