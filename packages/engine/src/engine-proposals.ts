import { EngineError, type Run } from '@moodcode/contracts';
import type { SqliteStore } from './storage/index.js';
import type { EngineRuntime } from './engine-runtime.js';
import type { EngineLifetime, EngineStorage } from './engine-kernel.js';
import type { EngineFeatures } from './engine-options.js';
import { assertContextOwnerCurrent, type ProfileIdentity } from './engine-knowledge.js';
import type { RecoveryGate } from './recovery/gate.js';
import type { KnowledgeStorage } from './knowledge/store.js';
import { plainRecord } from './shared/data.js';
import { acquireExecutionLock, assertExecutionLockAvailable, readExecutionLockReservation, reserveExecutionLock } from './tools/command/execution-lock.js';
import { PhysicalPatchProducer } from './tools/patch/physical.js';
import { ProposalSourceCaptureHost } from './proposals/source-capture.js';
import { ProposalHostService, type CreateProposalSetInput } from './proposals/host.js';
import { ProposalOverlayContextSource, type ProposalContextPolicy } from './proposals/overlay.js';
import type { ProposalStorage } from './proposals/store.js';
import type { ProposalApplyStorage } from './proposals/apply-store.js';
import type { ProposalApplyCapture, ProposalApplyCleanup, ProposalApplyRecoveryPreview } from './proposals/apply-types.js';
import type { ProposalApplyExecutionGuards } from './proposals/execution-guards.js';
import { ProposalApplyService } from './proposals/apply-service.js';

type ProposalApplyRecoveryInput = { readonly workspaceId: string; readonly requestId: string; readonly preview: ProposalApplyRecoveryPreview; readonly reason: string };

/** Pending proposal sets, their read-only context overlay and exact-approved physical application for one engine. */
export class EngineProposals {
  readonly source: ProposalSourceCaptureHost;
  readonly records: ProposalStorage;
  readonly service: ProposalHostService;
  readonly applies: ProposalApplyStorage;
  readonly applyGuards: ProposalApplyExecutionGuards;
  readonly applyService: ProposalApplyService;
  readonly overlay: ProposalOverlayContextSource;
  private readonly applyCleanups = new WeakMap<object, { capture: ProposalApplyCapture; proof: ProposalApplyCleanup }>();
  private readonly recoveryPreviews = new WeakMap<object, string>();

  constructor(private readonly store: SqliteStore, storage: EngineStorage, private readonly gate: RecoveryGate, private readonly lifetime: EngineLifetime,
    private readonly enabled: EngineFeatures, engine: Pick<EngineRuntime, 'coordinator'>, knowledge: KnowledgeStorage, profileIdentity: ProfileIdentity) {
    const knowledgeBinding = storage.knowledgeBinding, executionLockPath = storage.executionLockPath;
    this.source = new ProposalSourceCaptureHost({ checkBinding: knowledgeBinding });
    this.records = store.createProposalStorage({ checkBinding: knowledgeBinding,
      readSourceCapture: original => this.source.read(original),
      assertSourcesCurrent: (native, original) => this.service.assertCommitCurrent(native, original) });
    this.service = new ProposalHostService(this.records, this.source,
      operation => store.readExecutionObservationEvidence(operation), reference => store.readProposalBlobText(reference),
      lifetime.signal);
    this.applies = store.createProposalApplyStorage({ checkBinding: knowledgeBinding,
      getRevision: (workspaceId, id) => this.records.getRevision(workspaceId, id),
      getHead: (workspaceId, id) => this.records.getSet(workspaceId, id),
      readApprovedCapture: (original, input) => this.applyService.readApprovedCapture(original, input),
      assertCurrent: (original, capture, phase) => this.applyService.assertCurrent(original, capture, phase),
      readPhysicalResult: (capture, original) => this.applyService.assertPhysicalResult(capture, original),
      readExecutionGuard: (capture, original) => { const guard = this.applyGuards.readOriginal(original);
        if (guard.ownerId !== capture.ownerId || guard.workspaceId !== capture.workspaceId) throw new EngineError('PROPOSAL_APPLY_GUARD_INVALID', 'Execution guard belongs to another original apply owner'); return guard; },
      getExecutionGuard: (workspaceId, ownerId) => this.applyGuards.get(workspaceId, ownerId),
      assertCleanup: (capture, original) => { const cleanup = this.applyCleanups.get(original);
        if (!cleanup || cleanup.capture !== capture) throw new EngineError('PROPOSAL_APPLY_CLEANUP_INVALID', 'Cleanup requires its original apply owner and actual lock release'); return cleanup.proof; },
      beforeRecoveryDecision: (workspaceId, operation) => {
        if (operation === 'acknowledge') this.applyGuards.reconcile(workspaceId, executionLockPath);
        gate.assertIdle();
        if (operation === 'resume') gate.assertCertain('proposalApplyResume', workspaceId);
      } });
    this.applyGuards = store.createProposalApplyExecutionGuards({ checkBinding: knowledgeBinding,
      getOwner: (workspaceId, id) => { const owner = this.applies.getOwner(workspaceId, id);
        if (!owner) throw new EngineError('PROPOSAL_APPLY_NOT_FOUND', 'Native proposal apply owner is absent'); return owner; } });
    this.applyService = new ProposalApplyService(this.applies, {
      readTx: operation => store.readExecutionObservationEvidence(operation), checkBinding: knowledgeBinding,
      getSelection: (workspaceId, id) => this.records.getSelection(workspaceId, id),
      readBlobText: reference => store.readProposalBlobText(reference),
      assertUnpaused: workspaceId => knowledge.assertUnpaused(workspaceId),
      assertIdleAndNoExecutionUncertainty: workspaceId => { engine.coordinator.assertWorkspaceCleanupConfirmed(workspaceId); gate.assertIdle(); },
      assertSourcesCurrent: (binding, manifest, signal) => this.source.assertStoredManifestCurrentSync(binding, manifest, signal),
      withWorkspaceLease: (workspaceId, signal, operation) => engine.coordinator.withHostProposalApplyLease(workspaceId,
        lease => operation(AbortSignal.any([signal, lease, lifetime.signal]))),
      physical: new PhysicalPatchProducer(),
      acquireExecutionGuard: async capture => {
        const owner = this.applies.getOwner(capture.workspaceId, capture.ownerId);
        if (!owner) throw new EngineError('PROPOSAL_APPLY_NOT_FOUND', 'Native proposal apply owner is absent');
        // A busy lock found here leaves no guard row, so the owner settles as cancelled, not uncertain.
        assertExecutionLockAvailable(executionLockPath);
        const reservation = reserveExecutionLock(executionLockPath);
        const originalGuard = this.applies.claim(capture, () =>
          this.applyGuards.reserve(owner.binding, owner.id, executionLockPath, readExecutionLockReservation(reservation)));
        let lock;
        try { lock = acquireExecutionLock(executionLockPath, reservation); }
        catch (error) { this.applies.uncertain(capture, error instanceof EngineError ? error.code : 'PROPOSAL_APPLY_LOCK_FAILED'); throw error; }
        let released = false;
        return { guard: originalGuard, release: cleanupConfirmed => {
          if (released) throw new EngineError('PROPOSAL_APPLY_CLEANUP_INVALID', 'Original execution lease was already released'); released = true;
          let confirmed = false;
          if (cleanupConfirmed) confirmed = this.applyService.readCurrentPhysicalOutcome(capture).cleanupConfirmed;
          lock.release(confirmed);
          if (confirmed) gate.assertIdle();
          const guard = this.applyGuards.readOriginal(originalGuard), original = Object.freeze({ id: owner.id });
          this.applyCleanups.set(original, { capture, proof: { confirmed, guardSha256: guard.sha256 } }); return original;
        } };
      },
    }, lifetime.signal);
    this.overlay = new ProposalOverlayContextSource({ checkBinding: knowledgeBinding,
      readTx: operation => store.readExecutionObservationEvidence(operation),
      getSet: (workspaceId, id) => this.records.getSet(workspaceId, id),
      getSelection: (workspaceId, id) => this.records.getSelection(workspaceId, id),
      readBlobText: reference => store.readProposalBlobText(reference),
      assertSourcesCurrent: (binding, manifest, signal) => this.source.assertStoredManifestCurrent(binding, manifest, signal),
      assertOwnerCurrent: (workspaceId, owner) => assertContextOwnerCurrent(store, profileIdentity, 'PROPOSAL_CONTEXT_STALE', [
        'Proposal context belongs to another workspace', 'Profile selection requires its original Run',
        'Proposal context requires its original active Run', 'Proposal context profile differs from its admitted configuration',
      ], workspaceId, owner) });
  }

  /** The read-only context projection of host-selected pending proposals. */
  context(policy: ProposalContextPolicy, profileIdentity: ProfileIdentity) {
    return { source: this.overlay, policy, getProfile: (run: Run) => profileIdentity(run) ?? undefined };
  }

  create(input: CreateProposalSetInput) {
    return this.lifetime.rejecting(() => {
      this.lifetime.assertEnabled(this.enabled.proposals, 'PROPOSALS_DISABLED', 'Creating pending proposals requires explicit host opt-in');
      return this.service.create(input);
    });
  }
  previewApply(input: Parameters<ProposalApplyService['preview']>[0]) {
    return this.lifetime.rejecting(() => { this.assertApplyEnabled(); return this.applyService.preview(input); });
  }
  apply(input: Parameters<ProposalApplyService['apply']>[0]) {
    return this.lifetime.rejecting(() => { this.assertApplyEnabled(); return this.applyService.apply(input); });
  }
  getApply(workspaceId: string, ownerId: string) {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => this.applies.getHistory(workspaceId, ownerId));
  }
  getApplyRequest(workspaceId: string, requestId: string) {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => this.applies.getRequest(workspaceId, requestId));
  }
  previewApplyRecovery(workspaceId: string): ProposalApplyRecoveryPreview {
    this.assertApplyEnabled();
    const preview = this.store.readExecutionObservationEvidence(() => this.applies.previewRecovery(workspaceId));
    this.recoveryPreviews.set(preview, workspaceId); return preview;
  }
  private assertApplyEnabled(): void { this.lifetime.assertEnabled(this.enabled.proposalApply, 'PROPOSAL_APPLY_DISABLED', 'Applying proposals requires separate explicit host opt-in'); }
  applyRecoveryDecision(operation: 'acknowledge' | 'resume', input: ProposalApplyRecoveryInput) {
    return this.lifetime.rejecting(() => {
      this.assertApplyEnabled();
      const { workspaceId, requestId, preview, reason } = plainRecord(input, ['workspaceId', 'requestId', 'preview', 'reason'], [], () => {
        throw new EngineError('INVALID_PROPOSAL_APPLY_RECOVERY', 'Recovery requires original bounded host data');
      }) as typeof input;
      if (this.recoveryPreviews.get(preview) !== workspaceId || typeof reason !== 'string' || !reason.trim()
        || Buffer.byteLength(reason, 'utf8') > 512 || Buffer.from(reason, 'utf8').toString('utf8') !== reason) throw new EngineError('INVALID_PROPOSAL_APPLY_RECOVERY', 'Recovery requires its original preview and bounded explicit reason');
      return this.gate.decide(workspaceId, { closed: 'Engine closed during proposal recovery' }, () => operation === 'acknowledge'
        ? this.applies.acknowledge(preview, { requestId, reason, approved: true }) : this.applies.resume(preview, { requestId, reason, approved: true }));
    });
  }
  get(workspaceId: string, proposalId: string) {
    this.lifetime.assertOpen();
    return this.service.get(workspaceId, proposalId);
  }
  list(input: Parameters<ProposalHostService['list']>[0]) {
    this.lifetime.assertOpen();
    return this.service.list(input);
  }
  diff(input: Parameters<ProposalHostService['diff']>[0]) {
    return this.lifetime.rejecting(() => {
      this.lifetime.assertOpen();
      return this.service.diff(input);
    });
  }
}
