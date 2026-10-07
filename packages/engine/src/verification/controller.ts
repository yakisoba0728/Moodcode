import { isTerminal, type JsonObject, type Run } from '@moodcode/contracts';
import type { SessionDocument } from '../session-state/index.js';
import type { VerificationPlanService } from './plans.js';
import { COMPLETION_REASONS, completionCandidate, completionDecision, evaluateVerificationCompletion, normalizeVerificationBoundary, normalizeVerificationControllerProfile,
  type CompletionCandidate, type CompletionDecision, type CompletionReason, type VerificationBoundary, type VerificationControllerProfile } from './completion.js';
import { VERIFICATION_LIMITS, normalizeVerificationSource, verificationDigest, verificationFail, verificationHash, verificationJson, verificationNumber, verificationPlain, verificationText, verificationTimestamp,
  type VerificationSnapshot, type VerificationSource, type VerificationStore } from './types.js';

export const VERIFICATION_CONTROLLER_LIMITS = Object.freeze({ maxDocumentBytes: 65_536, maxBoundaries: 64, maxMessageBytes: 8192 });
export interface VerificationRemainingBudget { turns: number; toolCalls: number; outputBytes: number; durationMs: number }
export type VerificationExecutionBlocker = 'verification_denied' | 'cleanup_uncertain' | 'verification_cancelled' | 'verification_unsupported' | 'check_stale';
export interface VerificationControllerPorts {
  observeSource(run: Run, signal: AbortSignal): Promise<VerificationSource>;
  readCurrentProfile(run: Run): VerificationControllerProfile | null;
  readRemainingBudget(run: Run): VerificationRemainingBudget;
  /** Actual bounded native tool/uncertainty state; model output is never a blocker observation. */
  readExecutionBlocker?(run: Run): VerificationExecutionBlocker | null;
  /** Host validates an actual latest completed Turn for stop, or its logical next-provider boundary. */
  assertBoundaryCurrent(run: Run, boundary: VerificationBoundary): void;
  /** Atomic active-Run + verification document revision + controller document CAS. */
  commitCurrent(runId: string, kind: string, expectedRevision: number, data: JsonObject, verificationRevision: number): SessionDocument;
}
export interface VerificationControllerInput { boundary: VerificationBoundary; source: VerificationSource; verificationRevision: number; planSha256: string | null }
export interface RepairStage {
  id: string; ordinal: number; boundaryId: string; inputSha256: string; signatureSha256: string;
  source: VerificationSource; planId: string | null; planSha256: string | null; verificationRevision: number;
  checkIds: string[]; reason: CompletionReason; createdAt: string; consumedByBoundaryId: string | null;
  executionAuthority: 'none';
}
export interface VerificationControllerResult {
  id: string; phase: VerificationBoundary['phase']; turnId: string | null; inputSha256: string; decisionSha256: string;
  action: 'proceed' | 'continue' | 'stop'; status: CompletionDecision['status']; taskVerified: boolean;
  reason: CompletionReason; stageId: string | null; repairOrdinal: number;
}
export interface VerificationControllerState {
  schemaVersion: 1; sessionId: string; runId: string; workspaceId: string; runConfigSha256: string;
  maxRepairs: number; repairsUsed: number; stages: RepairStage[]; boundaries: VerificationControllerResult[];
  completion: CompletionCandidate | null; result: VerificationControllerResult; stateSha256: string;
}
export interface VerificationControllerSnapshot extends VerificationControllerState { revision: number }
export function verificationControllerDocumentKind(runId: string): string { verificationText(runId); return 'verification.controller.' + verificationHash(runId).slice(0, 40); }
function normalizeBudget(value: VerificationRemainingBudget, run: Run): VerificationRemainingBudget {
  verificationPlain(value, ['turns', 'toolCalls', 'outputBytes', 'durationMs']);
  verificationNumber(value.turns, run.config.limits.maxTurns); verificationNumber(value.toolCalls, run.config.limits.maxToolCalls); verificationNumber(value.outputBytes, run.config.limits.maxOutputBytes); verificationNumber(value.durationMs, run.config.limits.maxDurationMs);
  return { turns: value.turns, toolCalls: value.toolCalls, outputBytes: value.outputBytes, durationMs: value.durationMs };
}
function controllerJson(value: unknown): JsonObject {
  const json = verificationJson(value); if (Buffer.byteLength(JSON.stringify(json)) > VERIFICATION_CONTROLLER_LIMITS.maxDocumentBytes) verificationFail('VERIFICATION_CONTROLLER_LIMIT', 'Verification controller document exceeds 64 KiB'); return json;
}
function normalizeState(value: unknown, run: Run): VerificationControllerState {
  const state = controllerJson(value) as unknown as VerificationControllerState;
  verificationPlain(state, ['schemaVersion', 'sessionId', 'runId', 'workspaceId', 'runConfigSha256', 'maxRepairs', 'repairsUsed', 'stages', 'boundaries', 'completion', 'result', 'stateSha256']);
  verificationDigest(state.stateSha256); verificationDigest(state.runConfigSha256); verificationNumber(state.maxRepairs, VERIFICATION_LIMITS.maxRepairs); verificationNumber(state.repairsUsed, VERIFICATION_LIMITS.maxRepairs);
  if (state.schemaVersion !== 1 || state.sessionId !== run.sessionId || state.runId !== run.id || state.workspaceId !== run.workspaceId || state.runConfigSha256 !== verificationHash(run.config) || !Array.isArray(state.stages) || state.stages.length > VERIFICATION_LIMITS.maxRepairs || !Array.isArray(state.boundaries) || state.boundaries.length > VERIFICATION_CONTROLLER_LIMITS.maxBoundaries) verificationFail('INVALID_VERIFICATION_CONTROLLER', 'Stored controller has invalid scope or bounded collections');
  const ids = new Set<string>(); let previousOrdinal = 0;
  for (const stage of state.stages) {
    verificationPlain(stage, ['id', 'ordinal', 'boundaryId', 'inputSha256', 'signatureSha256', 'source', 'planId', 'planSha256', 'verificationRevision', 'checkIds', 'reason', 'createdAt', 'consumedByBoundaryId', 'executionAuthority']);
    verificationText(stage.id); verificationText(stage.boundaryId); verificationDigest(stage.inputSha256); verificationDigest(stage.signatureSha256); normalizeVerificationSource(stage.source); verificationTimestamp(stage.createdAt); verificationNumber(stage.ordinal, VERIFICATION_LIMITS.maxRepairs, 1); verificationNumber(stage.verificationRevision);
    if (stage.planId !== null) verificationText(stage.planId); if (stage.planSha256 !== null) verificationDigest(stage.planSha256); if (stage.consumedByBoundaryId !== null) verificationText(stage.consumedByBoundaryId);
    if (!COMPLETION_REASONS.includes(stage.reason) || !Array.isArray(stage.checkIds) || stage.checkIds.length > VERIFICATION_LIMITS.maxChecks || new Set(stage.checkIds).size !== stage.checkIds.length || stage.executionAuthority !== 'none' || stage.ordinal <= previousOrdinal || stage.ordinal > state.repairsUsed || ids.has(stage.id)) verificationFail('INVALID_VERIFICATION_CONTROLLER', 'Stored repair stages cannot reset counters or carry execution authority');
    for (const id of stage.checkIds) verificationText(id); ids.add(stage.id); previousOrdinal = stage.ordinal;
  }
  const boundaries = new Set<string>();
  for (const result of state.boundaries) {
    verificationPlain(result, ['id', 'phase', 'turnId', 'inputSha256', 'decisionSha256', 'action', 'status', 'taskVerified', 'reason', 'stageId', 'repairOrdinal']);
    verificationText(result.id); verificationDigest(result.inputSha256); verificationDigest(result.decisionSha256); verificationNumber(result.repairOrdinal, VERIFICATION_LIMITS.maxRepairs);
    if (result.turnId !== null) verificationText(result.turnId);
    if (!COMPLETION_REASONS.includes(result.reason) || !['before-provider', 'stop'].includes(result.phase) || !['proceed', 'continue', 'stop'].includes(result.action) || !['verified', 'incomplete', 'blocked'].includes(result.status) || result.taskVerified !== (result.status === 'verified') || result.taskVerified && (result.phase !== 'stop' || result.action !== 'stop' || result.turnId === null) || result.stageId !== null && !ids.has(result.stageId) || boundaries.has(result.id)) verificationFail('INVALID_VERIFICATION_CONTROLLER', 'Stored controller boundary is inconsistent'); boundaries.add(result.id);
  }
  if (!state.boundaries.some(result => verificationHash(result) === verificationHash(state.result))) verificationFail('INVALID_VERIFICATION_CONTROLLER', 'Current controller result is outside its committed boundary set');
  if (state.completion) {
    verificationPlain(state.completion, ['schemaVersion', 'boundaryId', 'verificationRevision', 'source', 'profile', 'decision', 'authority', 'candidateSha256']);
    verificationText(state.completion.boundaryId); verificationNumber(state.completion.verificationRevision); normalizeVerificationSource(state.completion.source); normalizeVerificationControllerProfile(state.completion.profile); verificationDigest(state.completion.candidateSha256);
    const result = state.completion.decision;
    verificationPlain(result, ['schemaVersion', 'status', 'taskVerified', 'reason', 'planId', 'planSha256', 'sourceSha256', 'requiredChecks', 'executionAuthority', 'decisionSha256']);
    verificationDigest(result.sourceSha256); verificationDigest(result.decisionSha256); if (result.planId !== null) verificationText(result.planId); if (result.planSha256 !== null) verificationDigest(result.planSha256);
    if (state.completion.schemaVersion !== 1 || !boundaries.has(state.completion.boundaryId) || result.schemaVersion !== 1 || !COMPLETION_REASONS.includes(result.reason) || !['verified', 'incomplete', 'blocked'].includes(result.status) || result.taskVerified !== (result.status === 'verified') || !Array.isArray(result.requiredChecks) || result.requiredChecks.length > VERIFICATION_LIMITS.maxChecks) verificationFail('INVALID_VERIFICATION_CONTROLLER', 'Completion candidate has invalid descriptive fields');
    const checkIds = new Set<string>(); for (const check of result.requiredChecks) { verificationPlain(check, ['checkId', 'receiptId', 'status']); verificationText(check.checkId); if (check.receiptId !== null) verificationText(check.receiptId); if (checkIds.has(check.checkId) || !['pass', 'fail', 'skipped', 'unsupported', 'timeout', 'cancelled', 'uncertain', 'stale', 'missing', 'pending'].includes(check.status)) verificationFail('INVALID_VERIFICATION_CONTROLLER', 'Completion check summaries must be bounded and unambiguous'); checkIds.add(check.checkId); }
    const { candidateSha256, ...candidate } = state.completion, { decisionSha256, ...decision } = state.completion.decision;
    if (candidateSha256 !== verificationHash(candidate) || decisionSha256 !== verificationHash(decision) || state.completion.authority !== 'observation-only' || state.completion.decision.executionAuthority !== 'none') verificationFail('INVALID_VERIFICATION_CONTROLLER', 'Completion candidate digest or observation authority is invalid');
  }
  const { stateSha256, ...body } = state; if (stateSha256 !== verificationHash(body)) verificationFail('VERIFICATION_CONTROLLER_CHANGED', 'Stored controller digest no longer matches its content'); return state;
}
function signature(source: VerificationSource, snapshot: VerificationSnapshot | null): string {
  const plan = snapshot?.plans.at(-1);
  return verificationHash({ sourceSha256: source.sha256, checks: plan?.checks.filter(check => check.required).map(check => {
    const receipt = snapshot!.receipts.filter(item => item.planId === plan.id && item.checkId === check.id).at(-1), observation = receipt?.observation;
    return { checkId: check.id, registrationSha256: check.registrationSha256, status: receipt?.status ?? 'missing', phase: receipt?.phase ?? 'missing', exitCode: observation?.exitCode ?? null, signal: observation?.signal ?? null, reasonCode: observation?.reasonCode ?? null, cleanupConfirmed: observation?.cleanup.confirmed ?? null };
  }) ?? [] });
}

/** CAS controller owns descriptive stages/candidates only. Root alone consumes control data at an existing Run boundary. */
export class VerificationController {
  constructor(private readonly store: VerificationStore, private readonly plans: VerificationPlanService, private readonly ports: VerificationControllerPorts, private readonly clock: () => string = () => new Date().toISOString()) {}
  private owner(sessionId: string, runId: string, active = false): Run {
    verificationText(sessionId); verificationText(runId); const run = this.store.getRun(runId);
    if (run.sessionId !== sessionId) verificationFail('VERIFICATION_SCOPE_MISMATCH', 'Controller belongs to the owning Run session');
    if (active) { if (isTerminal(run.state) || run.state === 'cancelling') verificationFail('RUN_TERMINAL', 'Stopped Runs cannot publish controller decisions'); const control = this.store.getSessionControl(sessionId); if (control.paused) verificationFail(control.reason === 'recovery_required' ? 'VERIFICATION_RECOVERY_REQUIRED' : 'VERIFICATION_CONTROLLER_PAUSED', 'Paused sessions cannot dispatch a verification continuation'); }
    return run;
  }
  get(sessionId: string, runId: string): VerificationControllerSnapshot | null {
    const run = this.owner(sessionId, runId), document = this.store.getSessionDocument(sessionId, verificationControllerDocumentKind(runId));
    if (!document) return null; verificationNumber(document.revision, Number.MAX_SAFE_INTEGER, 1); return { ...normalizeState(document.data, run), revision: document.revision };
  }
  async evaluate(sessionId: string, runId: string, expectedRevision: number, value: VerificationControllerInput, signal: AbortSignal): Promise<VerificationControllerSnapshot> {
    verificationNumber(expectedRevision); verificationPlain(value, ['boundary', 'source', 'verificationRevision', 'planSha256']);
    const input = { boundary: normalizeVerificationBoundary(value.boundary), source: normalizeVerificationSource(value.source), verificationRevision: value.verificationRevision, planSha256: value.planSha256 }; verificationNumber(input.verificationRevision); if (input.planSha256 !== null) verificationDigest(input.planSha256);
    const active = () => { if (signal.aborted) verificationFail('CANCELLED', 'Controller observation was cancelled'); return this.owner(sessionId, runId, true); };
    const run = active(); this.ports.assertBoundaryCurrent(run, input.boundary);
    const read = () => {
      const currentRun = active(), snapshot = this.plans.get(sessionId, runId), profile = normalizeVerificationControllerProfile(this.ports.readCurrentProfile(currentRun)), budget = normalizeBudget(this.ports.readRemainingBudget(currentRun), currentRun);
      const blocker = this.ports.readExecutionBlocker?.(currentRun) ?? null;
      if (blocker !== null && !['verification_denied', 'cleanup_uncertain', 'verification_cancelled', 'verification_unsupported', 'check_stale'].includes(blocker)) verificationFail('INVALID_VERIFICATION_DATA', 'Controller blocker must be a known host observation');
      if (verificationHash(currentRun.config) !== verificationHash(run.config) || (snapshot?.revision ?? 0) !== input.verificationRevision || (snapshot?.plans.at(-1)?.planSha256 ?? null) !== input.planSha256) verificationFail('VERIFICATION_CONTROLLER_SOURCE_STALE', 'Controller plan or Run configuration changed at this boundary');
      let planCurrent = true; if (snapshot) { try { this.plans.assertCurrent(snapshot); } catch { planCurrent = false; } }
      return { run: currentRun, snapshot, profile, budget, planCurrent, blocker };
    };
    const first = read(), source = normalizeVerificationSource(await this.ports.observeSource(run, signal)); active();
    if (verificationHash(source) !== verificationHash(input.source)) verificationFail('VERIFICATION_CONTROLLER_SOURCE_STALE', 'Host source changed before controller evaluation');
    const observed = read(); if (verificationHash(first.profile) !== verificationHash(observed.profile) || first.blocker !== observed.blocker || first.planCurrent !== observed.planCurrent) verificationFail('VERIFICATION_CONTROLLER_SOURCE_STALE', 'Host profile, check or execution blocker changed during controller observation');
    const current = this.get(sessionId, runId), inputSha256 = verificationHash({ input, profile: observed.profile, blocker: observed.blocker, runConfigSha256: verificationHash(run.config), snapshotSha256: verificationHash(observed.snapshot) }), existing = current?.boundaries.find(item => item.id === input.boundary.id);
    if (existing && existing.inputSha256 !== inputSha256) verificationFail('VERIFICATION_CONTROLLER_BOUNDARY_CONFLICT', 'The same logical boundary cannot change its verification inputs');
    if (!existing && (current?.revision ?? 0) !== expectedRevision) verificationFail('REVISION_CONFLICT', 'Verification controller CAS changed');
    let decision = evaluateVerificationCompletion({ sessionId, runId, workspaceId: run.workspaceId, runConfigSha256: verificationHash(run.config), source, snapshot: observed.snapshot, profile: observed.profile, boundary: input.boundary, planCurrent: observed.planCurrent });
    if (observed.blocker) decision = completionDecision({ ...decision, status: 'blocked', taskVerified: false, reason: observed.blocker });
    const firstPlan = observed.snapshot?.plans[0], lastPlan = observed.snapshot?.plans.at(-1), maxRepairs = Math.min(current?.maxRepairs ?? VERIFICATION_LIMITS.maxRepairs, firstPlan?.maxRepairs ?? 0), stages = structuredClone(current?.stages ?? []);
    let repairsUsed = Math.max(current?.repairsUsed ?? 0, stages.at(-1)?.ordinal ?? 0, (lastPlan?.revision ?? 1) - 1), stageId: string | null = null, action: VerificationControllerResult['action'] = input.boundary.phase === 'before-provider' ? 'proceed' : 'stop';
    const insufficient = (budget: VerificationRemainingBudget) => Object.values(budget).some(amount => amount <= 0) || !!firstPlan && (observed.snapshot?.receipts.length ?? 0) >= firstPlan.budget.maxExecutions;
    if (!existing) {
      if ((current?.boundaries.length ?? 0) >= VERIFICATION_CONTROLLER_LIMITS.maxBoundaries - 1) decision = completionDecision({ ...decision, status: 'blocked', taskVerified: false, reason: 'controller_limit' });
      if (input.boundary.phase === 'before-provider') {
        const pending = stages.find(stage => stage.consumedByBoundaryId === null);
        if (pending) { if (verificationHash(pending.source) !== verificationHash(source) || pending.planSha256 !== input.planSha256 || pending.verificationRevision !== input.verificationRevision) verificationFail('VERIFICATION_CONTROLLER_STAGE_STALE', 'Unconsumed continuation no longer matches current source or plan'); pending.consumedByBoundaryId = input.boundary.id; stageId = pending.id; }
        if (decision.status === 'blocked') action = 'stop'; else if (Object.values(observed.budget).some(amount => amount <= 0)) { decision = completionDecision({ ...decision, status: 'incomplete', taskVerified: false, reason: 'budget_exhausted' }); action = 'stop'; }
      } else if (decision.status === 'incomplete' && ['plan_missing', 'source_stale', 'check_missing', 'check_failed'].includes(decision.reason) && input.boundary.providerTerminal && input.boundary.nativeTurnCompleted) {
        const stalled = stages.some(stage => stage.signatureSha256 === signature(source, observed.snapshot));
        if (stalled) decision = completionDecision({ ...decision, reason: 'stalled' });
        else if (repairsUsed >= maxRepairs) decision = completionDecision({ ...decision, reason: 'repair_limit' });
        else if (insufficient(observed.budget)) decision = completionDecision({ ...decision, reason: 'budget_exhausted' });
        else {
          repairsUsed++; const createdAt = this.clock(); verificationTimestamp(createdAt); stageId = 'repair_stage_' + verificationHash({ runId, boundaryId: input.boundary.id, ordinal: repairsUsed }).slice(0, 40);
          stages.push({ id: stageId, ordinal: repairsUsed, boundaryId: input.boundary.id, inputSha256, signatureSha256: signature(source, observed.snapshot), source, planId: lastPlan?.id ?? null, planSha256: input.planSha256, verificationRevision: input.verificationRevision, checkIds: lastPlan?.checks.filter(check => check.required).map(check => check.id) ?? [], reason: decision.reason, createdAt, consumedByBoundaryId: null, executionAuthority: 'none' }); action = 'continue';
        }
      }
    }
    const sourceAfter = normalizeVerificationSource(await this.ports.observeSource(run, signal)); const after = read();
    if (verificationHash(sourceAfter) !== verificationHash(source) || verificationHash(after.profile) !== verificationHash(observed.profile) || after.planCurrent !== observed.planCurrent || after.blocker !== observed.blocker) verificationFail('VERIFICATION_CONTROLLER_SOURCE_STALE', 'Source, profile or check changed before controller publication');
    this.ports.assertBoundaryCurrent(active(), input.boundary);
    if (existing) {
      if (existing.action === 'continue' && insufficient(after.budget)) verificationFail('VERIFICATION_CONTROLLER_BUDGET_EXHAUSTED', 'Original Run budget no longer permits continuation');
      const { revision, stateSha256: _savedSha, ...savedBody } = current!, body = { ...savedBody, result: structuredClone(existing) };
      return { ...body, stateSha256: verificationHash(body), revision };
    }
    if (action === 'continue' && insufficient(after.budget)) { stages.pop(); repairsUsed--; stageId = null; action = 'stop'; decision = completionDecision({ ...decision, reason: 'budget_exhausted' }); }
    const result: VerificationControllerResult = { id: input.boundary.id, phase: input.boundary.phase, turnId: input.boundary.turnId, inputSha256, decisionSha256: decision.decisionSha256, action, status: decision.status, taskVerified: decision.taskVerified, reason: decision.reason, stageId, repairOrdinal: repairsUsed };
    const body = { schemaVersion: 1 as const, sessionId, runId, workspaceId: run.workspaceId, runConfigSha256: verificationHash(run.config), maxRepairs, repairsUsed, stages, boundaries: [...current?.boundaries ?? [], result], completion: completionCandidate(input.boundary, source, after.snapshot, after.profile, decision), result }, state = { ...body, stateSha256: verificationHash(body) };
    const json = controllerJson(state); normalizeState(json, run); const saved = this.ports.commitCurrent(runId, verificationControllerDocumentKind(runId), current?.revision ?? 0, json, input.verificationRevision);
    return { ...state, revision: saved.revision };
  }
}

/** Bounded control DATA. Includes IDs/status only; no raw command, approval or executable capability. */
export function verificationContinuationMessage(snapshot: VerificationControllerSnapshot): string | null {
  if (snapshot.result.action !== 'continue' || !snapshot.result.stageId) return null; const stage = snapshot.stages.find(item => item.id === snapshot.result.stageId);
  if (!stage || stage.consumedByBoundaryId !== null) return null;
  const message = JSON.stringify({ kind: 'verification-continuation', version: 1, stageId: stage.id, repairOrdinal: stage.ordinal, reason: stage.reason, checkIds: stage.checkIds, sourceSha256: stage.source.sha256, executionAuthority: 'none', instruction: 'Continue the existing task within its original budget. Use the configured verification check IDs after addressing the observed verification gap. Normal tool permission and exact approval still apply.' });
  if (Buffer.byteLength(message) > VERIFICATION_CONTROLLER_LIMITS.maxMessageBytes) verificationFail('VERIFICATION_CONTROLLER_LIMIT', 'Continuation control data exceeds its bound'); return message;
}
