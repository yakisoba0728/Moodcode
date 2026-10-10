import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isTerminal } from '@moodcode/contracts';
import { normalizeVerificationObservation, classifyVerificationObservation } from './receipts.js';
import {
  VERIFICATION_LIMITS, normalizeVerificationSource, verificationDigest, verificationFail, verificationHash, verificationJson, verificationNumber, verificationPlain, verificationText, verificationTimestamp,
  type VerificationCheck, type VerificationCheckRegistration, type VerificationClock, type VerificationConsumedSettlementWriter, type VerificationIndexPage, type VerificationPlan, type VerificationPlanSelection, type VerificationReceipt, type VerificationSnapshot, type VerificationState, type VerificationStore,
} from './types.js';

const INDEX_KIND = 'verification.index';
const CHECK_KEYS = ['id', 'revision', 'workspaceId', 'command', 'cwd', 'profileId', 'profileRevision', 'sourceRevision', 'timeoutMs', 'maxOutputBytes', 'required'] as const;
const RECEIPT_KEYS = ['schemaVersion', 'id', 'sessionId', 'runId', 'workspaceId', 'planId', 'planSha256', 'checkId', 'registrationSha256', 'attempt', 'toolCallId', 'preparedFingerprint', 'sourceBefore', 'phase', 'status', 'createdAt', 'dispatchedAt', 'settledAt', 'observation', 'sourceStale', 'recovery', 'receiptSha256'];
const IMMUTABLE_RECEIPT_KEYS = ['schemaVersion', 'id', 'sessionId', 'runId', 'workspaceId', 'planId', 'planSha256', 'checkId', 'registrationSha256', 'attempt', 'toolCallId', 'preparedFingerprint', 'sourceBefore', 'createdAt', 'dispatchedAt'] as const;
export function verificationDocumentKind(runId: string): string { verificationText(runId); return 'verification.run.' + verificationHash(runId).slice(0, 40); }
export function latestRequiredReceipts(snapshot: VerificationState, plan: VerificationPlan, sameRun: (receipt: VerificationReceipt) => boolean): (VerificationReceipt | undefined)[] {
  return plan.checks.filter(check => check.required).map(check => snapshot.receipts.filter(receipt => sameRun(receipt) && receipt.checkId === check.id).at(-1));
}
function normalizeCheck(value: VerificationCheckRegistration): VerificationCheckRegistration {
  verificationPlain(value, CHECK_KEYS);
  for (const key of ['id', 'workspaceId', 'profileId', 'profileRevision', 'sourceRevision'] as const) verificationText(value[key]);
  verificationNumber(value.revision, Number.MAX_SAFE_INTEGER, 1); verificationNumber(value.timeoutMs, VERIFICATION_LIMITS.maxTimeoutMs, 1); verificationNumber(value.maxOutputBytes, VERIFICATION_LIMITS.maxOutputBytes, 1);
  if (typeof value.command !== 'string' || !value.command.trim() || value.command.includes('\0') || Buffer.byteLength(value.command) > VERIFICATION_LIMITS.maxCommandBytes) verificationFail('INVALID_VERIFICATION_DATA', 'Verification command must be exact bounded text');
  verificationText(value.cwd, 4096);
  if (!isAbsolute(value.cwd) || resolve(value.cwd) !== value.cwd || typeof value.required !== 'boolean') verificationFail('INVALID_VERIFICATION_DATA', 'Verification cwd must be canonical absolute text and required must be explicit');
  return { id: value.id, revision: value.revision, workspaceId: value.workspaceId, command: value.command, cwd: value.cwd, profileId: value.profileId, profileRevision: value.profileRevision, sourceRevision: value.sourceRevision, timeoutMs: value.timeoutMs, maxOutputBytes: value.maxOutputBytes, required: value.required };
}

/** Trusted host definitions only. Check IDs never contain model-supplied command overrides. */
export class VerificationCheckRegistry {
  private readonly entries = new Map<string, VerificationCheck>();
  private current = 0;
  get revision(): number { return this.current; }
  register(value: VerificationCheckRegistration): () => void {
    const selected = normalizeCheck(value);
    if (this.entries.has(selected.id)) verificationFail('VERIFICATION_CHECK_CONFLICT', 'Verification check ID is already registered');
    if (this.entries.size >= VERIFICATION_LIMITS.maxRegistrations) verificationFail('VERIFICATION_REGISTRY_LIMIT', 'Verification registry is full');
    verificationNumber(this.current + 1, Number.MAX_SAFE_INTEGER, 1);
    const entry = Object.freeze({ ...selected, registrationSha256: verificationHash(selected) });
    this.entries.set(entry.id, entry); this.current++;
    return () => { if (this.entries.get(entry.id) === entry) { verificationNumber(this.current + 1, Number.MAX_SAFE_INTEGER, 1); this.entries.delete(entry.id); this.current++; } };
  }
  capture(id: string): VerificationCheck {
    verificationText(id); const entry = this.entries.get(id);
    if (!entry) return verificationFail('VERIFICATION_CHECK_NOT_FOUND', 'Requested host verification check is not registered');
    return structuredClone(entry);
  }
  assertCurrent(check: VerificationCheck): void {
    const current = this.entries.get(check.id);
    if (!current || current.registrationSha256 !== check.registrationSha256) verificationFail('VERIFICATION_CHECK_STALE', 'Pinned verification registration is no longer current');
  }
}

function validatePlan(plan: VerificationPlan): void {
  verificationPlain(plan, ['schemaVersion', 'id', 'revision', 'sessionId', 'runId', 'workspaceId', 'workspaceRoot', 'createdAt', 'source', 'runConfigSha256', 'registryRevision', 'checks', 'maxRepairs', 'budget', 'executionAuthority', 'planSha256']);
  for (const value of [plan.id, plan.sessionId, plan.runId, plan.workspaceId]) verificationText(value);
  verificationText(plan.workspaceRoot, 4096); verificationTimestamp(plan.createdAt); normalizeVerificationSource(plan.source); verificationDigest(plan.runConfigSha256); verificationDigest(plan.planSha256);
  verificationNumber(plan.revision, VERIFICATION_LIMITS.maxPlans, 1); verificationNumber(plan.registryRevision); verificationNumber(plan.maxRepairs, VERIFICATION_LIMITS.maxRepairs);
  if (plan.schemaVersion !== 1 || plan.executionAuthority !== 'none' || !isAbsolute(plan.workspaceRoot) || resolve(plan.workspaceRoot) !== plan.workspaceRoot || !Array.isArray(plan.checks) || plan.checks.length < 1 || plan.checks.length > VERIFICATION_LIMITS.maxChecks) verificationFail('INVALID_VERIFICATION_STATE', 'Stored verification plan has invalid schema or bounds');
  const ids = new Set<string>();
  for (const check of plan.checks) {
    verificationPlain(check, [...CHECK_KEYS, 'registrationSha256']);
    const { registrationSha256, ...definition } = check;
    const normalized = normalizeCheck(definition); verificationDigest(registrationSha256);
    const rel = relative(plan.workspaceRoot, check.cwd);
    if (ids.has(check.id) || check.workspaceId !== plan.workspaceId || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || registrationSha256 !== verificationHash(normalized)) verificationFail('INVALID_VERIFICATION_STATE', 'Stored check has an invalid exact registration or workspace scope');
    ids.add(check.id);
  }
  verificationPlain(plan.budget, ['maxExecutions', 'maxDurationMs', 'maxOutputBytes', 'allocation']);
  verificationNumber(plan.budget.maxExecutions, VERIFICATION_LIMITS.maxReceipts, 1); verificationNumber(plan.budget.maxDurationMs, Number.MAX_SAFE_INTEGER, 1); verificationNumber(plan.budget.maxOutputBytes, Number.MAX_SAFE_INTEGER, 1);
  if (plan.budget.allocation !== 'run-ceiling-only-not-reservation') verificationFail('INVALID_VERIFICATION_STATE', 'Verification plan cannot claim a runtime reservation');
  const { planSha256, ...body } = plan;
  if (verificationHash(body) !== planSha256) verificationFail('VERIFICATION_PLAN_CHANGED', 'Verification plan digest no longer matches its frozen content');
}
function validateReceipt(receipt: VerificationReceipt, state: VerificationState): void {
  verificationPlain(receipt, RECEIPT_KEYS);
  for (const value of [receipt.id, receipt.sessionId, receipt.runId, receipt.workspaceId, receipt.planId, receipt.checkId, receipt.toolCallId]) verificationText(value);
  for (const value of [receipt.planSha256, receipt.registrationSha256, receipt.preparedFingerprint, receipt.receiptSha256]) verificationDigest(value);
  verificationNumber(receipt.attempt, VERIFICATION_LIMITS.maxRepairs + 1, 1); normalizeVerificationSource(receipt.sourceBefore); verificationTimestamp(receipt.createdAt);
  if (receipt.dispatchedAt !== null) verificationTimestamp(receipt.dispatchedAt);
  if (receipt.settledAt !== null) verificationTimestamp(receipt.settledAt);
  const plan = state.plans.find(value => value.id === receipt.planId), check = plan?.checks.find(value => value.id === receipt.checkId);
  if (receipt.schemaVersion !== 1 || receipt.sessionId !== state.sessionId || receipt.runId !== state.runId || receipt.workspaceId !== state.workspaceId || !plan || !check || receipt.planSha256 !== plan.planSha256 || receipt.registrationSha256 !== check.registrationSha256 || verificationHash(receipt.sourceBefore) !== verificationHash(plan.source) || !['prepared', 'dispatched', 'settled'].includes(receipt.phase) || !['none', 'restart-without-outcome', 'producer-without-outcome'].includes(receipt.recovery)) verificationFail('VERIFICATION_RECEIPT_BINDING_MISMATCH', 'Stored verification receipt has invalid ownership or binding');
  if (receipt.phase === 'settled') {
    if (!receipt.settledAt || !['pass', 'fail', 'skipped', 'unsupported', 'timeout', 'cancelled', 'uncertain', 'stale'].includes(receipt.status ?? '') || receipt.sourceStale !== null && typeof receipt.sourceStale !== 'boolean' || receipt.recovery === 'none' && receipt.observation === null || receipt.recovery !== 'none' && receipt.status !== 'uncertain') verificationFail('INVALID_VERIFICATION_STATE', 'Settled verification receipt needs its truthful observation');
  } else if (receipt.status !== null || receipt.settledAt !== null || receipt.observation !== null || receipt.sourceStale !== null || receipt.recovery !== 'none' || (receipt.phase === 'dispatched') !== (receipt.dispatchedAt !== null)) verificationFail('INVALID_VERIFICATION_STATE', 'Pending verification receipt cannot claim an outcome');
  if (receipt.observation !== null) {
    const observation = normalizeVerificationObservation(receipt.observation, receipt, state), result = classifyVerificationObservation(observation);
    if (result.status !== receipt.status || result.stale !== receipt.sourceStale) verificationFail('INVALID_VERIFICATION_STATE', 'Stored verification status disagrees with its bound observation');
  }
  if (receipt.dispatchedAt !== null && receipt.dispatchedAt < receipt.createdAt || receipt.settledAt !== null && receipt.settledAt < (receipt.dispatchedAt ?? receipt.createdAt)) verificationFail('INVALID_VERIFICATION_STATE', 'Verification receipt timestamps must preserve lifecycle order');
  const { receiptSha256, ...body } = receipt;
  if (receiptSha256 !== verificationHash(body)) verificationFail('VERIFICATION_RECEIPT_CHANGED', 'Verification receipt digest no longer matches its content');
}
function normalizeState(value: unknown, sessionId: string, runId: string, workspaceId: string): VerificationState {
  const state = verificationJson(value) as unknown as VerificationState;
  verificationPlain(state, ['schemaVersion', 'sessionId', 'runId', 'workspaceId', 'plans', 'receipts']);
  if (state.schemaVersion !== 1 || state.sessionId !== sessionId || state.runId !== runId || state.workspaceId !== workspaceId || !Array.isArray(state.plans) || state.plans.length < 1 || state.plans.length > VERIFICATION_LIMITS.maxPlans || !Array.isArray(state.receipts) || state.receipts.length > VERIFICATION_LIMITS.maxReceipts) verificationFail('VERIFICATION_SCOPE_MISMATCH', 'Verification state has invalid scope or record bounds');
  const ids = new Set<string>();
  for (let i = 0; i < state.plans.length; i++) {
    const plan = state.plans[i]!; validatePlan(plan);
    if (plan.sessionId !== sessionId || plan.runId !== runId || plan.workspaceId !== workspaceId || plan.revision !== i + 1 || ids.has(plan.id)) verificationFail('VERIFICATION_SCOPE_MISMATCH', 'Verification plans have invalid scope or order');
    ids.add(plan.id);
  }
  ids.clear(); const tools = new Set<string>(), fingerprints = new Set<string>();
  for (const receipt of state.receipts) {
    validateReceipt(receipt, state);
    if (ids.has(receipt.id) || tools.has(receipt.toolCallId) || fingerprints.has(receipt.preparedFingerprint)) verificationFail('INVALID_VERIFICATION_STATE', 'Verification receipts cannot reuse an execution identity');
    ids.add(receipt.id); tools.add(receipt.toolCallId); fingerprints.add(receipt.preparedFingerprint);
  }
  return state;
}

/** Pure delta validation, also consumed by the primary store transaction's independent owner guard. */
export function validateConsumedVerificationSettlement(before: unknown, next: unknown, owner: { sessionId: string; runId: string; toolCallId: string }): void {
  verificationPlain(owner, ['sessionId', 'runId', 'toolCallId']); verificationText(owner.sessionId); verificationText(owner.runId); verificationText(owner.toolCallId);
  const previousData = verificationJson(before); verificationText(previousData.workspaceId);
  const previous = normalizeState(previousData, owner.sessionId, owner.runId, previousData.workspaceId), candidate = normalizeState(next, owner.sessionId, owner.runId, previous.workspaceId);
  if (verificationHash(previous.plans) !== verificationHash(candidate.plans) || previous.receipts.length !== candidate.receipts.length) verificationFail('INVALID_CONSUMED_VERIFICATION_SETTLEMENT', 'Consumed settlement cannot change plans or receipt counts');
  let changed = 0;
  for (let index = 0; index < previous.receipts.length; index++) {
    const old = previous.receipts[index]!, replacement = candidate.receipts[index]!;
    if (verificationHash(old) === verificationHash(replacement)) continue;
    if (++changed !== 1 || old.toolCallId !== owner.toolCallId || old.phase !== 'dispatched' || replacement.phase !== 'settled' || replacement.recovery !== 'none' || replacement.observation === null || IMMUTABLE_RECEIPT_KEYS.some(key => verificationHash(old[key]) !== verificationHash(replacement[key]))) verificationFail('INVALID_CONSUMED_VERIFICATION_SETTLEMENT', 'Only the existing dispatched execution may publish its bound observation');
  }
  if (changed !== 1) verificationFail('INVALID_CONSUMED_VERIFICATION_SETTLEMENT', 'Consumed settlement must change exactly one existing dispatched receipt');
}

/** Frozen per-Run plans and bounded receipt state use existing session document CAS. */
export class VerificationPlanService {
  constructor(private readonly store: VerificationStore, readonly registry: VerificationCheckRegistry, private readonly clock: VerificationClock = () => new Date().toISOString()) {}
  private owner(sessionId: string, runId: string, active = false) {
    verificationText(sessionId); verificationText(runId);
    const session = this.store.getSession(sessionId), run = this.store.getRun(runId);
    if (run.sessionId !== session.id || run.workspaceId !== session.workspaceId) verificationFail('VERIFICATION_SCOPE_MISMATCH', 'Verification Run belongs to another session');
    if (active && (isTerminal(run.state) || run.state === 'cancelling')) verificationFail('RUN_TERMINAL', 'Verification mutation requires an active Run');
    return { run, workspace: this.store.getWorkspace(run.workspaceId) };
  }
  now(): string { const value = this.clock(); verificationTimestamp(value); return value; }
  get(sessionId: string, runId: string): VerificationSnapshot | null {
    const { run } = this.owner(sessionId, runId);
    const document = this.store.getSessionDocument(sessionId, verificationDocumentKind(runId));
    if (!document) return null;
    verificationNumber(document.revision, Number.MAX_SAFE_INTEGER, 1);
    return { ...normalizeState(document.data, sessionId, runId, run.workspaceId), revision: document.revision };
  }
  assertCurrent(snapshot: VerificationSnapshot): void {
    const { run, workspace } = this.owner(snapshot.sessionId, snapshot.runId, true);
    const control = this.store.getSessionControl(snapshot.sessionId);
    if (control.paused && control.reason === 'recovery_required') verificationFail('VERIFICATION_RECOVERY_REQUIRED', 'Verification cannot resume an imported or recovery-paused execution');
    const plan = snapshot.plans.at(-1)!;
    if (plan.workspaceRoot !== workspace.root || plan.runConfigSha256 !== verificationHash(run.config)) verificationFail('VERIFICATION_PLAN_STALE', 'Verification root or Run configuration changed after capture');
    for (const check of plan.checks) this.registry.assertCurrent(check);
  }
  /** Restart/import annotations do not replace live execution outcomes. */
  assertRecoveryPermitted(snapshot: VerificationSnapshot): void {
    const { run } = this.owner(snapshot.sessionId, snapshot.runId), control = this.store.getSessionControl(snapshot.sessionId);
    if (!isTerminal(run.state) && !(control.paused && control.reason === 'recovery_required')) verificationFail('VERIFICATION_RECOVERY_NOT_READY', 'Live verification must settle before administrative recovery');
  }
  create(sessionId: string, runId: string, expectedRevision: number, selection: VerificationPlanSelection): VerificationSnapshot {
    verificationNumber(expectedRevision); verificationPlain(selection, ['checkIds', 'source', 'maxRepairs']);
    const normalized = verificationJson(selection) as unknown as VerificationPlanSelection;
    if (!Array.isArray(normalized.checkIds) || normalized.checkIds.length < 1 || normalized.checkIds.length > VERIFICATION_LIMITS.maxChecks || new Set(normalized.checkIds).size !== normalized.checkIds.length) verificationFail('INVALID_VERIFICATION_PLAN', 'Verification checks must be a bounded distinct selection');
    const source = normalizeVerificationSource(normalized.source);
    if (normalized.maxRepairs !== undefined) verificationNumber(normalized.maxRepairs, VERIFICATION_LIMITS.maxRepairs);
    const { run, workspace } = this.owner(sessionId, runId, true), previous = this.get(sessionId, runId);
    if ((previous?.revision ?? 0) !== expectedRevision) verificationFail('REVISION_CONFLICT', 'Verification plan document changed');
    if (previous?.receipts.some(value => value.phase !== 'settled')) verificationFail('VERIFICATION_CHECK_PENDING', 'A pending verification check must settle or recover before a new plan');
    const first = previous?.plans[0], maxRepairs = normalized.maxRepairs ?? first?.maxRepairs ?? VERIFICATION_LIMITS.maxRepairs;
    if (first && maxRepairs !== first.maxRepairs) verificationFail('VERIFICATION_REPAIR_ALLOWANCE_CHANGED', 'A new plan cannot reset the frozen Run repair allowance');
    const checks = normalized.checkIds.map(id => this.registry.capture(id));
    const last = previous?.plans.at(-1);
    if (last && verificationHash({ checks: last.checks, source: last.source, maxRepairs: last.maxRepairs, root: last.workspaceRoot, config: last.runConfigSha256 }) === verificationHash({ checks, source, maxRepairs, root: workspace.root, config: verificationHash(run.config) })) return previous!;
    if ((previous?.plans.length ?? 0) >= Math.min(VERIFICATION_LIMITS.maxPlans, 1 + maxRepairs)) verificationFail('VERIFICATION_PLAN_LIMIT', 'Verification plan revision allowance is exhausted');
    const plan: VerificationPlan = {
      schemaVersion: 1, id: 'verification_plan_' + randomUUID().replaceAll('-', ''), revision: (previous?.plans.length ?? 0) + 1,
      sessionId, runId, workspaceId: run.workspaceId, workspaceRoot: workspace.root, createdAt: this.now(), source, runConfigSha256: verificationHash(run.config), registryRevision: this.registry.revision, checks, maxRepairs,
      budget: { maxExecutions: Math.min(first?.budget.maxExecutions ?? Number.MAX_SAFE_INTEGER, run.config.limits.maxToolCalls, checks.length * (1 + maxRepairs)), maxDurationMs: first?.budget.maxDurationMs ?? run.config.limits.maxDurationMs, maxOutputBytes: first?.budget.maxOutputBytes ?? run.config.limits.maxOutputBytes, allocation: 'run-ceiling-only-not-reservation' }, executionAuthority: 'none', planSha256: '',
    };
    const { planSha256: _omitted, ...body } = plan; plan.planSha256 = verificationHash(body);
    const next: VerificationState = { schemaVersion: 1, sessionId, runId, workspaceId: run.workspaceId, plans: [...previous?.plans ?? [], plan], receipts: previous?.receipts ?? [] };
    const data = verificationJson(next); normalizeState(data, sessionId, runId, run.workspaceId);
    this.reserveIndex(sessionId, runId);
    const saved = this.store.putActiveRunDocument(runId, verificationDocumentKind(runId), expectedRevision, data);
    return { ...next, revision: saved.revision };
  }
  /** @internal Receipt module bridge; it preserves immutable plans and previously settled records. */
  writeReceipts(snapshot: VerificationSnapshot, receipts: VerificationReceipt[], recovery = false): VerificationSnapshot {
    const current = this.get(snapshot.sessionId, snapshot.runId);
    if (!current || current.revision !== snapshot.revision || verificationHash(current.plans) !== verificationHash(snapshot.plans)) verificationFail('REVISION_CONFLICT', 'Verification receipt source document changed');
    const normalized = verificationJson({ receipts });
    if (!Array.isArray(normalized.receipts)) verificationFail('INVALID_VERIFICATION_STATE', 'Verification receipts must be a bounded array');
    receipts = normalized.receipts as unknown as VerificationReceipt[];
    if (recovery) this.assertRecoveryPermitted(current);
    for (const old of current.receipts) {
      const next = receipts.find(value => value.id === old.id);
      if (!next || old.phase === 'settled' && verificationHash(old) !== verificationHash(next)) verificationFail('VERIFICATION_RECEIPT_TERMINAL', 'Settled verification receipts are immutable');
      for (const field of ['schemaVersion', 'id', 'sessionId', 'runId', 'workspaceId', 'planId', 'planSha256', 'checkId', 'registrationSha256', 'attempt', 'toolCallId', 'preparedFingerprint', 'sourceBefore', 'createdAt'] as const) if (verificationHash(old[field]) !== verificationHash(next[field])) verificationFail('VERIFICATION_RECEIPT_BINDING_MISMATCH', 'Captured verification receipt identity cannot change');
      if (old.phase === 'dispatched' && next.phase === 'prepared' || old.dispatchedAt !== null && next.dispatchedAt !== old.dispatchedAt) verificationFail('VERIFICATION_RECEIPT_PHASE', 'Verification dispatch evidence cannot regress');
      if (recovery && old.phase !== 'settled' && (next.phase !== 'settled' || next.status !== 'uncertain' || next.observation !== null || next.sourceStale !== null || next.recovery !== 'restart-without-outcome')) verificationFail('INVALID_VERIFICATION_RECOVERY', 'Recovery only converts unresolved records to uncertain');
    }
    if (recovery && receipts.length !== current.receipts.length) verificationFail('INVALID_VERIFICATION_RECOVERY', 'Recovery cannot add execution identities');
    const { revision, ...state } = current;
    const next = normalizeState({ ...state, receipts }, state.sessionId, state.runId, state.workspaceId), data = verificationJson(next);
    const saved = recovery ? this.store.putSessionDocument(state.sessionId, verificationDocumentKind(state.runId), revision, data) : this.store.putActiveRunDocument(state.runId, verificationDocumentKind(state.runId), revision, data);
    return { ...next, revision: saved.revision };
  }
  /** @internal The live execution owner supplies a separately authenticated consumed-settlement writer. */
  writeConsumedReceipt(snapshot: VerificationSnapshot, receipt: VerificationReceipt, writer: VerificationConsumedSettlementWriter): VerificationSnapshot {
    const current = this.get(snapshot.sessionId, snapshot.runId);
    if (!current || current.revision !== snapshot.revision || verificationHash(current.plans) !== verificationHash(snapshot.plans)) verificationFail('REVISION_CONFLICT', 'Consumed verification source document changed');
    const { run } = this.owner(snapshot.sessionId, snapshot.runId);
    if (isTerminal(run.state)) verificationFail('RUN_TERMINAL', 'A terminal Run cannot accept a consumed verification observation');
    if (typeof writer !== 'function') verificationFail('INVALID_CONSUMED_VERIFICATION_SETTLEMENT', 'Consumed verification requires the captured host writer');
    const { revision, ...before } = current, data = verificationJson({ ...before, receipts: current.receipts.map(old => old.id === receipt.id ? receipt : old) });
    validateConsumedVerificationSettlement(before, data, { sessionId: before.sessionId, runId: before.runId, toolCallId: receipt.toolCallId });
    const next = normalizeState(data, before.sessionId, before.runId, before.workspaceId), saved = writer(verificationDocumentKind(before.runId), revision, data);
    if (saved.revision !== revision + 1 || verificationHash(saved.data) !== verificationHash(data)) verificationFail('INVALID_CONSUMED_VERIFICATION_SETTLEMENT', 'Consumed writer did not return the exact committed document');
    return { ...next, revision: saved.revision };
  }
  private readIndex(sessionId: string): { revision: number; runIds: string[] } {
    this.store.getSession(sessionId); const document = this.store.getSessionDocument(sessionId, INDEX_KIND);
    if (!document) return { revision: 0, runIds: [] };
    const data = verificationJson(document.data); verificationPlain(data, ['schemaVersion', 'runIds']);
    verificationNumber(document.revision, Number.MAX_SAFE_INTEGER, 1);
    if (data.schemaVersion !== 1 || !Array.isArray(data.runIds) || data.runIds.length > VERIFICATION_LIMITS.maxIndexRuns || new Set(data.runIds).size !== data.runIds.length) verificationFail('INVALID_VERIFICATION_INDEX', 'Verification discovery index is invalid');
    for (const id of data.runIds) verificationText(id);
    return { revision: document.revision, runIds: data.runIds as string[] };
  }
  private reserveIndex(sessionId: string, runId: string): void {
    const index = this.readIndex(sessionId); if (index.runIds.includes(runId)) return;
    if (index.runIds.length >= VERIFICATION_LIMITS.maxIndexRuns) verificationFail('VERIFICATION_INDEX_LIMIT', 'Verification discovery index is full');
    this.store.putSessionDocument(sessionId, INDEX_KIND, index.revision, { schemaVersion: 1, runIds: [...index.runIds, runId] });
  }
  list(sessionId: string, afterRunId?: string, limit = 20): VerificationIndexPage {
    verificationNumber(limit, 32, 1); const index = this.readIndex(sessionId);
    let position = 0;
    if (afterRunId !== undefined) { verificationText(afterRunId); position = index.runIds.indexOf(afterRunId) + 1; if (position === 0) verificationFail('INVALID_VERIFICATION_CURSOR', 'Verification cursor does not belong to the session index'); }
    const runIds = index.runIds.slice(position, position + limit);
    return { revision: index.revision, runIds, nextCursor: position + runIds.length < index.runIds.length ? runIds.at(-1)! : null, coverage: 'bounded-discovery-index-only', receiptAuthority: false };
  }
  /** Metadata pruning keeps the authoritative per-Run document addressable by Run ID. */
  forgetIndexEntry(sessionId: string, runId: string, expectedRevision: number): VerificationIndexPage {
    verificationNumber(expectedRevision); const { run } = this.owner(sessionId, runId);
    if (!isTerminal(run.state)) verificationFail('VERIFICATION_INDEX_RUN_ACTIVE', 'Only terminal Run discovery metadata can be pruned');
    const index = this.readIndex(sessionId);
    if (index.revision !== expectedRevision) verificationFail('REVISION_CONFLICT', 'Verification discovery index changed');
    if (!index.runIds.includes(runId)) return this.list(sessionId);
    this.store.putSessionDocument(sessionId, INDEX_KIND, expectedRevision, { schemaVersion: 1, runIds: index.runIds.filter(id => id !== runId) });
    return this.list(sessionId);
  }
}
