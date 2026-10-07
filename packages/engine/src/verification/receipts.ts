import { randomUUID } from 'node:crypto';
import { validateArtifactReference } from '@moodcode/contracts/validation';
import type { VerificationPlanService } from './plans.js';
import {
  VERIFICATION_LIMITS, normalizeVerificationSource, verificationDigest, verificationFail, verificationHash, verificationJson, verificationNumber, verificationPlain, verificationText,
  type VerificationBegin, type VerificationObservation, type VerificationReceipt, type VerificationReceiptResult, type VerificationSnapshot, type VerificationSource, type VerificationState, type VerificationStatus,
} from './types.js';

const OBSERVATION_KEYS = ['disposition', 'command', 'cwd', 'profileId', 'profileRevision', 'toolCallId', 'preparedFingerprint', 'sourceBefore', 'sourceAfter', 'executionCheckpointId', 'exitCode', 'signal', 'started', 'cancelled', 'timedOut', 'cleanup', 'observedOutputBytes', 'outputAccountingComplete', 'artifactRefs', 'reasonCode', 'executionComplete'];
function hashReceipt(value: Omit<VerificationReceipt, 'receiptSha256'>): VerificationReceipt { return { ...value, receiptSha256: verificationHash(value) }; }
function current(snapshot: VerificationSnapshot, id: string): VerificationReceipt {
  verificationText(id); const receipt = snapshot.receipts.find(value => value.id === id);
  if (!receipt) return verificationFail('VERIFICATION_RECEIPT_NOT_FOUND', 'Verification receipt does not belong to this Run');
  return receipt;
}
export function normalizeVerificationObservation(value: VerificationObservation, receipt: VerificationReceipt, snapshot: VerificationState): VerificationObservation {
  verificationPlain(value, OBSERVATION_KEYS);
  const copy = verificationJson(value) as unknown as VerificationObservation;
  const plan = snapshot.plans.find(value => value.id === receipt.planId)!, check = plan.checks.find(value => value.id === receipt.checkId)!;
  if (!['executed', 'skipped', 'unsupported'].includes(copy.disposition) || copy.command !== check.command || copy.cwd !== check.cwd || copy.profileId !== check.profileId || copy.profileRevision !== check.profileRevision || copy.toolCallId !== receipt.toolCallId || copy.preparedFingerprint !== receipt.preparedFingerprint || verificationHash(normalizeVerificationSource(copy.sourceBefore)) !== verificationHash(receipt.sourceBefore)) verificationFail('VERIFICATION_OBSERVATION_BINDING_MISMATCH', 'Verification outcome differs from its exact prepared check');
  if (copy.sourceAfter !== null) normalizeVerificationSource(copy.sourceAfter);
  if (copy.executionCheckpointId !== null) verificationText(copy.executionCheckpointId);
  if (copy.exitCode !== null && (typeof copy.exitCode !== 'number' || !Number.isSafeInteger(copy.exitCode) || copy.exitCode < -2_147_483_648 || copy.exitCode > 2_147_483_647)) verificationFail('INVALID_VERIFICATION_OBSERVATION', 'Observed exit code is invalid');
  if (copy.signal !== null && (typeof copy.signal !== 'string' || !/^SIG[A-Z0-9]{1,24}$/u.test(copy.signal))) verificationFail('INVALID_VERIFICATION_OBSERVATION', 'Observed process signal is invalid');
  if ([copy.started, copy.cancelled, copy.timedOut, copy.outputAccountingComplete].some(value => typeof value !== 'boolean') || copy.cancelled && copy.timedOut) verificationFail('INVALID_VERIFICATION_OBSERVATION', 'Execution flags must be unambiguous boolean observations');
  if (copy.executionComplete !== undefined && typeof copy.executionComplete !== 'boolean') verificationFail('INVALID_VERIFICATION_OBSERVATION', 'Execution completeness must be an actual boolean observation');
  verificationPlain(copy.cleanup, ['confirmed', 'scope', 'evidenceSha256']);
  if (copy.cleanup.confirmed !== null && typeof copy.cleanup.confirmed !== 'boolean' || !['posix-process-group', 'windows-job', 'not-dispatched', 'unknown'].includes(copy.cleanup.scope)) verificationFail('INVALID_VERIFICATION_OBSERVATION', 'Cleanup evidence has invalid scope or confirmation');
  if (copy.cleanup.evidenceSha256 !== null) verificationDigest(copy.cleanup.evidenceSha256);
  if (copy.observedOutputBytes !== null) verificationNumber(copy.observedOutputBytes);
  if (copy.reasonCode !== null && (typeof copy.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,95}$/u.test(copy.reasonCode))) verificationFail('INVALID_VERIFICATION_OBSERVATION', 'Verification reason must be a bounded code');
  if (!Array.isArray(copy.artifactRefs) || copy.artifactRefs.length > 4) verificationFail('VERIFICATION_ARTIFACT_LIMIT', 'Verification keeps at most four immutable log artifacts');
  const ids = new Set<string>();
  copy.artifactRefs = copy.artifactRefs.map(value => {
    const artifact = validateArtifactReference(value);
    if (ids.has(artifact.id) || artifact.identity.sessionId !== receipt.sessionId || artifact.identity.runId !== receipt.runId || artifact.identity.toolCallId !== receipt.toolCallId) verificationFail('VERIFICATION_ARTIFACT_BINDING_MISMATCH', 'Verification log artifact belongs to another execution');
    ids.add(artifact.id); return artifact;
  });
  if (copy.disposition !== 'executed' && (copy.started || copy.exitCode !== null || copy.signal !== null || copy.cancelled || copy.timedOut || copy.executionCheckpointId !== null || copy.artifactRefs.length > 0 || copy.cleanup.scope !== 'not-dispatched' || copy.cleanup.confirmed !== true)) verificationFail('INVALID_VERIFICATION_OBSERVATION', 'Skipped or unsupported checks cannot claim dispatched process effects');
  if (copy.started && (receipt.dispatchedAt === null || copy.cleanup.scope === 'not-dispatched')) verificationFail('VERIFICATION_DISPATCH_REQUIRED', 'Process outcomes require a durable verification dispatch boundary');
  if (!copy.started && (copy.exitCode !== null || copy.signal !== null)) verificationFail('INVALID_VERIFICATION_OBSERVATION', 'An unstarted check cannot provide a process exit');
  return copy;
}
export function classifyVerificationObservation(observation: VerificationObservation): { status: VerificationStatus; stale: boolean | null } {
  const stale = observation.sourceAfter === null ? null : observation.sourceBefore.sha256 !== observation.sourceAfter.sha256 || observation.sourceBefore.revision !== observation.sourceAfter.revision;
  if (observation.disposition === 'skipped' || observation.disposition === 'unsupported') return { status: observation.disposition, stale };
  if (observation.executionComplete === false) return { status: 'uncertain', stale };
  if (observation.cleanup.confirmed !== true || observation.started && (observation.cleanup.evidenceSha256 === null || !['posix-process-group', 'windows-job'].includes(observation.cleanup.scope))) return { status: 'uncertain', stale };
  if (observation.cancelled) return { status: 'cancelled', stale };
  if (observation.timedOut) return { status: 'timeout', stale };
  if (!observation.started || observation.sourceAfter === null || observation.exitCode === null && observation.signal === null) return { status: 'uncertain', stale };
  if (stale) return { status: 'stale', stale };
  return { status: observation.exitCode === 0 && observation.signal === null ? 'pass' : 'fail', stale };
}

/** Records host-owned execution observations. No method invokes a process or grants tool approval. */
export class VerificationReceiptService {
  constructor(private readonly plans: VerificationPlanService) {}
  private snapshot(sessionId: string, runId: string, expectedRevision: number): VerificationSnapshot {
    verificationNumber(expectedRevision); const snapshot = this.plans.get(sessionId, runId);
    if (!snapshot) return verificationFail('VERIFICATION_PLAN_NOT_FOUND', 'No verification plan exists for this Run');
    if (snapshot.revision !== expectedRevision) verificationFail('REVISION_CONFLICT', 'Verification receipt document changed');
    return snapshot;
  }
  /** Read-only eligibility check before displaying an execution approval. */
  assertCanBegin(sessionId: string, runId: string, expectedRevision: number, value: VerificationBegin): VerificationSnapshot {
    verificationPlain(value, ['checkId', 'toolCallId', 'preparedFingerprint', 'source']);
    verificationText(value.checkId); verificationText(value.toolCallId); verificationDigest(value.preparedFingerprint); const source = normalizeVerificationSource(value.source);
    const snapshot = this.snapshot(sessionId, runId, expectedRevision); this.plans.assertCurrent(snapshot);
    const plan = snapshot.plans.at(-1)!, index = plan.checks.findIndex(check => check.id === value.checkId);
    if (index < 0) return verificationFail('VERIFICATION_CHECK_NOT_IN_PLAN', 'Check ID is outside the captured verification plan');
    if (verificationHash(source) !== verificationHash(plan.source)) verificationFail('VERIFICATION_SOURCE_STALE', 'Source changed before check preparation');
    if (snapshot.receipts.some(receipt => receipt.status === 'uncertain')) verificationFail('VERIFICATION_RECOVERY_REQUIRED', 'Uncertain verification effects require separate host reconciliation');
    if (snapshot.receipts.some(receipt => receipt.phase !== 'settled')) verificationFail('VERIFICATION_CHECK_PENDING', 'Only one verification execution can be pending for this Run');
    if (snapshot.receipts.some(receipt => receipt.toolCallId === value.toolCallId || receipt.preparedFingerprint === value.preparedFingerprint)) verificationFail('VERIFICATION_EXECUTION_CONFLICT', 'Verification cannot reuse a prepared execution identity');
    for (const prior of plan.checks.slice(0, index)) if (!snapshot.receipts.some(receipt => receipt.planId === plan.id && receipt.checkId === prior.id && receipt.phase === 'settled')) verificationFail('VERIFICATION_CHECK_ORDER', 'Earlier planned checks must have an observed outcome first');
    const previous = snapshot.receipts.filter(receipt => receipt.planId === plan.id && receipt.checkId === value.checkId);
    if (previous.length >= 1 + plan.maxRepairs || snapshot.receipts.length >= VERIFICATION_LIMITS.maxReceipts || snapshot.receipts.length >= plan.budget.maxExecutions) verificationFail('VERIFICATION_ATTEMPT_LIMIT', 'Verification execution allowance is exhausted');
    return snapshot;
  }
  begin(sessionId: string, runId: string, expectedRevision: number, value: VerificationBegin): VerificationReceiptResult {
    const snapshot = this.assertCanBegin(sessionId, runId, expectedRevision, value), plan = snapshot.plans.at(-1)!;
    const index = plan.checks.findIndex(check => check.id === value.checkId), source = normalizeVerificationSource(value.source);
    const previous = snapshot.receipts.filter(receipt => receipt.planId === plan.id && receipt.checkId === value.checkId);
    const receipt = hashReceipt({ schemaVersion: 1, id: 'verification_receipt_' + randomUUID().replaceAll('-', ''), sessionId, runId, workspaceId: snapshot.workspaceId, planId: plan.id, planSha256: plan.planSha256, checkId: value.checkId, registrationSha256: plan.checks[index]!.registrationSha256, attempt: previous.length + 1, toolCallId: value.toolCallId, preparedFingerprint: value.preparedFingerprint, sourceBefore: source, phase: 'prepared', status: null, createdAt: this.plans.now(), dispatchedAt: null, settledAt: null, observation: null, sourceStale: null, recovery: 'none' });
    const saved = this.plans.writeReceipts(snapshot, [...snapshot.receipts, receipt]);
    return { revision: saved.revision, receipt };
  }
  /** A consumed producer capability returned no owned outcome. Never reads error protocol fields. */
  markUncertain(sessionId: string, runId: string, expectedRevision: number, receiptId: string): VerificationReceiptResult {
    const snapshot = this.snapshot(sessionId, runId, expectedRevision), old = current(snapshot, receiptId);
    if (old.phase === 'settled') verificationFail('VERIFICATION_RECEIPT_TERMINAL', 'Verification receipt is already terminal');
    const { receiptSha256: _omitted, ...body } = old;
    const receipt = hashReceipt({ ...body, phase: 'settled', status: 'uncertain', settledAt: this.plans.now(), observation: null, sourceStale: null, recovery: 'producer-without-outcome' });
    const saved = this.plans.writeReceipts(snapshot, snapshot.receipts.map(value => value.id === old.id ? receipt : value));
    return { revision: saved.revision, receipt };
  }
  dispatch(sessionId: string, runId: string, expectedRevision: number, receiptId: string, currentSource: VerificationSource): VerificationReceiptResult {
    const source = normalizeVerificationSource(currentSource), snapshot = this.snapshot(sessionId, runId, expectedRevision); this.plans.assertCurrent(snapshot);
    const old = current(snapshot, receiptId);
    if (old.phase !== 'prepared') verificationFail('VERIFICATION_RECEIPT_PHASE', 'Verification dispatch requires a newly prepared record');
    if (verificationHash(source) !== verificationHash(old.sourceBefore)) verificationFail('VERIFICATION_SOURCE_STALE', 'Source changed immediately before verification dispatch');
    const { receiptSha256: _omitted, ...body } = old;
    const receipt = hashReceipt({ ...body, phase: 'dispatched', dispatchedAt: this.plans.now() });
    const saved = this.plans.writeReceipts(snapshot, snapshot.receipts.map(value => value.id === old.id ? receipt : value));
    return { revision: saved.revision, receipt };
  }
  settle(sessionId: string, runId: string, expectedRevision: number, receiptId: string, value: VerificationObservation): VerificationReceiptResult {
    const snapshot = this.snapshot(sessionId, runId, expectedRevision), old = current(snapshot, receiptId);
    if (old.phase === 'settled') verificationFail('VERIFICATION_RECEIPT_TERMINAL', 'Verification receipt already has a durable terminal observation');
    const observation = normalizeVerificationObservation(value, old, snapshot), { status, stale } = classifyVerificationObservation(observation);
    const { receiptSha256: _omitted, ...body } = old;
    const receipt = hashReceipt({ ...body, phase: 'settled', status, settledAt: this.plans.now(), observation, sourceStale: stale });
    const saved = this.plans.writeReceipts(snapshot, snapshot.receipts.map(value => value.id === old.id ? receipt : value));
    return { revision: saved.revision, receipt };
  }
  /** Administrative evidence conversion; it neither proves cleanup nor dispatches an old check. */
  recoverPending(sessionId: string, runId: string, expectedRevision: number): VerificationSnapshot {
    const snapshot = this.snapshot(sessionId, runId, expectedRevision);
    if (!snapshot.receipts.some(receipt => receipt.phase !== 'settled')) return snapshot;
    const stamp = this.plans.now();
    const receipts = snapshot.receipts.map(old => {
      if (old.phase === 'settled') return old;
      const { receiptSha256: _omitted, ...body } = old;
      return hashReceipt({ ...body, phase: 'settled', status: 'uncertain', settledAt: stamp, sourceStale: null, recovery: 'restart-without-outcome' });
    });
    return this.plans.writeReceipts(snapshot, receipts, true);
  }
}
