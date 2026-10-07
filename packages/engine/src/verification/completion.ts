import { classifyVerificationObservation, normalizeVerificationObservation } from './receipts.js';
import { VERIFICATION_LIMITS, normalizeVerificationSource, verificationDigest, verificationFail, verificationHash, verificationJson, verificationNumber, verificationPlain, verificationText,
  type VerificationSnapshot, type VerificationSource, type VerificationStatus } from './types.js';

export interface VerificationControllerProfile { id: string; revision: string }
export interface VerificationBoundary {
  id: string; phase: 'before-provider' | 'stop'; turnId: string | null;
  providerTerminal: boolean; nativeTurnCompleted: boolean;
}
export type CompletionReason = 'required_checks_passed' | 'provider_not_terminal' | 'turn_not_completed' | 'plan_missing' | 'no_required_checks' | 'source_stale' | 'profile_stale' | 'check_stale' | 'invalid_evidence' | 'check_missing' | 'check_failed' | 'verification_pending' | 'cleanup_uncertain' | 'verification_cancelled' | 'verification_unsupported' | 'verification_denied' | 'repair_limit' | 'stalled' | 'budget_exhausted' | 'controller_limit';
export const COMPLETION_REASONS: readonly CompletionReason[] = Object.freeze(['required_checks_passed', 'provider_not_terminal', 'turn_not_completed', 'plan_missing', 'no_required_checks', 'source_stale', 'profile_stale', 'check_stale', 'invalid_evidence', 'check_missing', 'check_failed', 'verification_pending', 'cleanup_uncertain', 'verification_cancelled', 'verification_unsupported', 'verification_denied', 'repair_limit', 'stalled', 'budget_exhausted', 'controller_limit']);
export interface CompletionDecision {
  schemaVersion: 1; status: 'verified' | 'incomplete' | 'blocked'; taskVerified: boolean; reason: CompletionReason;
  planId: string | null; planSha256: string | null; sourceSha256: string;
  requiredChecks: Array<{ checkId: string; receiptId: string | null; status: VerificationStatus | 'missing' | 'pending' }>;
  executionAuthority: 'none'; decisionSha256: string;
}
export interface VerificationCompletionInput {
  sessionId: string; runId: string; workspaceId: string; runConfigSha256: string;
  source: VerificationSource; snapshot: VerificationSnapshot | null; profile: VerificationControllerProfile | null;
  boundary: VerificationBoundary; planCurrent: boolean;
}
export interface CompletionCandidate {
  schemaVersion: 1; boundaryId: string; verificationRevision: number; source: VerificationSource;
  profile: VerificationControllerProfile | null; decision: CompletionDecision;
  authority: 'observation-only'; candidateSha256: string;
}
export function normalizeVerificationBoundary(value: VerificationBoundary): VerificationBoundary {
  verificationPlain(value, ['id', 'phase', 'turnId', 'providerTerminal', 'nativeTurnCompleted']); verificationText(value.id);
  if (value.turnId !== null) verificationText(value.turnId);
  if (!['before-provider', 'stop'].includes(value.phase) || typeof value.providerTerminal !== 'boolean' || typeof value.nativeTurnCompleted !== 'boolean') verificationFail('INVALID_VERIFICATION_DATA', 'Invalid verification boundary');
  return { id: value.id, phase: value.phase, turnId: value.turnId, providerTerminal: value.providerTerminal, nativeTurnCompleted: value.nativeTurnCompleted };
}
export function normalizeVerificationControllerProfile(value: VerificationControllerProfile | null): VerificationControllerProfile | null {
  if (value === null) return null; verificationPlain(value, ['id', 'revision']); verificationText(value.id); verificationText(value.revision); return { id: value.id, revision: value.revision };
}
export function completionDecision(body: Omit<CompletionDecision, 'decisionSha256'>): CompletionDecision {
  const normalized = { ...body }; delete (normalized as Partial<CompletionDecision>).decisionSha256;
  return { ...normalized, decisionSha256: verificationHash(normalized) };
}
const DENIED = new Set(['TOOL_APPROVAL_DENIED', 'ROLE_RESOURCE_DENIED', 'TOOL_POLICY_DENIED', 'VERIFICATION_APPROVAL_DENIED', 'COMMAND_PREFLIGHT_DENIED']);

/** Pure interpretation of host-observed evidence. Does not approve a tool, dispatch a check or publish success. */
export function evaluateVerificationCompletion(value: VerificationCompletionInput): CompletionDecision {
  verificationPlain(value, ['sessionId', 'runId', 'workspaceId', 'runConfigSha256', 'source', 'snapshot', 'profile', 'boundary', 'planCurrent']);
  for (const id of [value.sessionId, value.runId, value.workspaceId]) verificationText(id); verificationDigest(value.runConfigSha256);
  const source = normalizeVerificationSource(value.source), boundary = normalizeVerificationBoundary(value.boundary), profile = normalizeVerificationControllerProfile(value.profile);
  if (typeof value.planCurrent !== 'boolean') verificationFail('INVALID_VERIFICATION_DATA', 'Invalid verification currentness');
  const snapshot = value.snapshot === null ? null : verificationJson(value.snapshot) as unknown as VerificationSnapshot, plan = Array.isArray(snapshot?.plans) ? snapshot.plans.at(-1) ?? null : null;
  const requiredChecks: CompletionDecision['requiredChecks'] = [];
  const result = (status: CompletionDecision['status'], reason: CompletionReason) => completionDecision({ schemaVersion: 1, status, taskVerified: status === 'verified', reason, planId: plan?.id ?? null, planSha256: plan?.planSha256 ?? null, sourceSha256: source.sha256, requiredChecks, executionAuthority: 'none' });
  if (!snapshot) return result('incomplete', 'plan_missing');
  verificationPlain(snapshot, ['schemaVersion', 'sessionId', 'runId', 'workspaceId', 'plans', 'receipts', 'revision']);
  if (snapshot.schemaVersion !== 1 || snapshot.sessionId !== value.sessionId || snapshot.runId !== value.runId || snapshot.workspaceId !== value.workspaceId || !Array.isArray(snapshot.plans) || snapshot.plans.length > VERIFICATION_LIMITS.maxPlans || !Array.isArray(snapshot.receipts) || snapshot.receipts.length > VERIFICATION_LIMITS.maxReceipts) return result('blocked', 'invalid_evidence');
  if (!plan) return snapshot.receipts.length ? result('blocked', 'invalid_evidence') : result('incomplete', 'plan_missing');
  verificationNumber(snapshot.revision, Number.MAX_SAFE_INTEGER, 1);
  const plans = new Map<string, typeof plan>();
  for (const item of snapshot.plans) {
    verificationPlain(item, ['schemaVersion', 'id', 'revision', 'sessionId', 'runId', 'workspaceId', 'workspaceRoot', 'createdAt', 'source', 'runConfigSha256', 'registryRevision', 'checks', 'maxRepairs', 'budget', 'executionAuthority', 'planSha256']);
    verificationText(item.id); normalizeVerificationSource(item.source); verificationDigest(item.runConfigSha256); verificationNumber(item.revision, VERIFICATION_LIMITS.maxPlans, 1); verificationNumber(item.maxRepairs, VERIFICATION_LIMITS.maxRepairs);
    const { planSha256, ...body } = item;
    if (item.schemaVersion !== 1 || plans.has(item.id) || item.runId !== value.runId || item.sessionId !== value.sessionId || item.workspaceId !== value.workspaceId || item.executionAuthority !== 'none' || planSha256 !== verificationHash(body) || !Array.isArray(item.checks) || item.checks.length > VERIFICATION_LIMITS.maxChecks) return result('blocked', 'invalid_evidence');
    plans.set(item.id, item); const checkIds = new Set<string>();
    for (const check of item.checks) {
      verificationPlain(check, ['id', 'revision', 'workspaceId', 'command', 'cwd', 'profileId', 'profileRevision', 'sourceRevision', 'timeoutMs', 'maxOutputBytes', 'required', 'registrationSha256']);
      verificationText(check.id); verificationText(check.profileId); verificationText(check.profileRevision); const { registrationSha256, ...definition } = check;
      if (typeof check.required !== 'boolean' || check.workspaceId !== value.workspaceId || checkIds.has(check.id) || registrationSha256 !== verificationHash(definition)) return result('blocked', 'invalid_evidence'); checkIds.add(check.id);
    }
  }
  const receiptIds = new Set<string>();
  for (const receipt of snapshot.receipts) {
    verificationPlain(receipt, ['schemaVersion', 'id', 'sessionId', 'runId', 'workspaceId', 'planId', 'planSha256', 'checkId', 'registrationSha256', 'attempt', 'toolCallId', 'preparedFingerprint', 'sourceBefore', 'phase', 'status', 'createdAt', 'dispatchedAt', 'settledAt', 'observation', 'sourceStale', 'recovery', 'receiptSha256']);
    verificationText(receipt.id); normalizeVerificationSource(receipt.sourceBefore);
    const { receiptSha256, ...body } = receipt, ownPlan = plans.get(receipt.planId), check = ownPlan?.checks.find(item => item.id === receipt.checkId);
    if (receipt.schemaVersion !== 1 || receiptIds.has(receipt.id) || !['prepared', 'dispatched', 'settled'].includes(receipt.phase) || receipt.runId !== value.runId || receipt.sessionId !== value.sessionId || receipt.workspaceId !== value.workspaceId || receiptSha256 !== verificationHash(body) || !check || receipt.planSha256 !== ownPlan!.planSha256 || receipt.registrationSha256 !== check.registrationSha256) return result('blocked', 'invalid_evidence'); receiptIds.add(receipt.id);
    if (receipt.phase !== 'settled') return result('blocked', 'verification_pending');
    if (receipt.status === 'uncertain' || receipt.recovery !== 'none') return result('blocked', 'cleanup_uncertain');
    if (!receipt.observation) return result('blocked', 'invalid_evidence');
    const observation = normalizeVerificationObservation(receipt.observation, receipt, snapshot), classified = classifyVerificationObservation(observation);
    if (classified.status !== receipt.status || classified.stale !== receipt.sourceStale) return result('blocked', 'invalid_evidence');
  }
  const required = plan.checks.filter(check => check.required);
  for (const check of required) { const receipt = snapshot.receipts.filter(item => item.planId === plan.id && item.checkId === check.id).at(-1); requiredChecks.push({ checkId: check.id, receiptId: receipt?.id ?? null, status: receipt?.status ?? 'missing' }); }
  if (!value.planCurrent || plan.runConfigSha256 !== value.runConfigSha256) return result('blocked', 'check_stale');
  if (!profile || plan.checks.some(check => check.profileId !== profile.id || check.profileRevision !== profile.revision)) return result('blocked', 'profile_stale');
  const latest = plan.checks.flatMap(check => { const receipt = snapshot.receipts.filter(item => item.planId === plan.id && item.checkId === check.id).at(-1); return receipt ? [receipt] : []; });
  if (latest.some(receipt => DENIED.has(receipt.observation!.reasonCode ?? ''))) return result('blocked', 'verification_denied');
  if (latest.some(receipt => receipt.status === 'cancelled')) return result('blocked', 'verification_cancelled');
  if (latest.some(receipt => receipt.status === 'unsupported' || receipt.status === 'skipped' && plan.checks.find(check => check.id === receipt.checkId)!.required)) return result('blocked', 'verification_unsupported');
  if (verificationHash(plan.source) !== verificationHash(source)) return result('incomplete', 'source_stale');
  if (!required.length) return result('incomplete', 'no_required_checks');
  if (requiredChecks.some(check => check.status === 'missing')) return result('incomplete', 'check_missing');
  if (requiredChecks.some(check => check.status === 'stale')) return result('incomplete', 'source_stale');
  if (requiredChecks.some(check => check.status !== 'pass')) return result('incomplete', 'check_failed');
  for (const check of required) {
    const receipt = latest.find(item => item.checkId === check.id)!, observation = receipt.observation!;
    if (receipt.sourceStale !== false || verificationHash(receipt.sourceBefore) !== verificationHash(source) || !observation.sourceAfter || verificationHash(observation.sourceAfter) !== verificationHash(source)) return result('incomplete', 'source_stale');
    if (observation.cleanup.confirmed !== true || !observation.cleanup.evidenceSha256 || observation.executionComplete === false || !observation.started || observation.exitCode !== 0 || observation.signal !== null) return result('blocked', 'cleanup_uncertain');
  }
  if (boundary.phase !== 'stop' || !boundary.providerTerminal) return result('incomplete', 'provider_not_terminal');
  if (!boundary.nativeTurnCompleted || !boundary.turnId) return result('incomplete', 'turn_not_completed');
  return result('verified', 'required_checks_passed');
}

/** Descriptive candidate is stored atomically with controller counters by VerificationController. */
export function completionCandidate(boundary: VerificationBoundary, source: VerificationSource, snapshot: VerificationSnapshot | null, profile: VerificationControllerProfile | null, decision: CompletionDecision): CompletionCandidate {
  const body = { schemaVersion: 1 as const, boundaryId: boundary.id, verificationRevision: snapshot?.revision ?? 0, source: { ...source }, profile: profile ? { ...profile } : null, decision, authority: 'observation-only' as const };
  return { ...body, candidateSha256: verificationHash(body) };
}
