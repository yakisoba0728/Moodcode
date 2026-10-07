import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import { VerificationCheckRegistry, VerificationPlanService } from './plans.js';
import { VerificationReceiptService } from './receipts.js';
import { verificationHash, type VerificationObservation, type VerificationSource } from './types.js';
import { completionDecision, evaluateVerificationCompletion, type VerificationCompletionInput } from './completion.js';

const stamp = '2026-10-07T01:00:00.000Z';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const source: VerificationSource = { sha256: hash('source'), revision: 'source-1', checkpointId: 'source-checkpoint' };
function fixture(t: TestContext, required = true) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-verification-completion-'))), store = new SqliteStore(join(directory, 'engine.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: stamp }); store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Completion', createdAt: stamp });
  const accepted = store.acceptInput({ sessionId: 'session', requestId: 'request', prompt: 'verify', config: { providerId: 'scripted', modelId: 'fixture', mode: 'build', limits: { ...DEFAULT_LIMITS } }, delivery: 'queue' }), run = store.promoteInput(accepted.inputId).run;
  store.commit(run.id, 'run.started', {}, { run: { state: 'running' } }); const registry = new VerificationCheckRegistry();
  const check = { id: 'tests', revision: 1, workspaceId: 'workspace', command: 'npm test', cwd: directory, profileId: 'verification', profileRevision: 'profile-1', sourceRevision: 'host-checks-1', timeoutMs: 1000, maxOutputBytes: 4096, required };
  registry.register(check); const plans = new VerificationPlanService(store, registry, () => stamp), receipts = new VerificationReceiptService(plans);
  plans.create('session', run.id, 0, { checkIds: ['tests'], source }); let sequence = 0;
  const begin = () => { const toolCallId = 'tool_' + ++sequence; return receipts.begin('session', run.id, plans.get('session', run.id)!.revision, { checkId: 'tests', toolCallId, preparedFingerprint: hash(toolCallId), source }).receipt; };
  const settle = (changes: Partial<VerificationObservation> = {}) => {
    const prepared = begin(), receipt = changes.disposition && changes.disposition !== 'executed' ? prepared : receipts.dispatch('session', run.id, plans.get('session', run.id)!.revision, prepared.id, source).receipt;
    return receipts.settle('session', run.id, plans.get('session', run.id)!.revision, receipt.id, { disposition: 'executed', command: check.command, cwd: check.cwd, profileId: check.profileId, profileRevision: check.profileRevision, toolCallId: receipt.toolCallId, preparedFingerprint: receipt.preparedFingerprint, sourceBefore: source, sourceAfter: source, executionCheckpointId: 'command-checkpoint', exitCode: 0, signal: null, started: true, cancelled: false, timedOut: false, cleanup: { confirmed: true, scope: 'posix-process-group', evidenceSha256: hash('actual-cleanup') }, observedOutputBytes: 0, outputAccountingComplete: true, artifactRefs: [], executionComplete: true, reasonCode: null, ...changes });
  };
  const input = (): VerificationCompletionInput => ({ sessionId: 'session', runId: run.id, workspaceId: 'workspace', runConfigSha256: verificationHash(run.config), source, snapshot: plans.get('session', run.id), profile: { id: 'verification', revision: 'profile-1' }, boundary: { id: 'completed-turn', phase: 'stop', turnId: 'completed-turn', providerTerminal: true, nativeTurnCompleted: true }, planCurrent: true });
  return { store, run, plans, begin, settle, input };
}

test('only matching current required checks and a completed provider/Turn boundary produce task verification', t => {
  const f = fixture(t); f.settle(); const verified = evaluateVerificationCompletion(f.input()); assert.equal(verified.status, 'verified'); assert.equal(verified.taskVerified, true); assert.equal(verified.executionAuthority, 'none'); assert.equal(f.store.getRun(f.run.id).state, 'running');
  const before = f.input(); before.boundary = { id: 'next-provider', phase: 'before-provider', turnId: null, providerTerminal: false, nativeTurnCompleted: false }; assert.equal(evaluateVerificationCompletion(before).reason, 'provider_not_terminal');
  const uncompleted = f.input(); uncompleted.boundary.nativeTurnCompleted = false; assert.equal(evaluateVerificationCompletion(uncompleted).reason, 'turn_not_completed');
});

test('missing plan/check and optional-only pass remain incomplete', t => {
  const f = fixture(t); const missing = f.input(); missing.snapshot = null; assert.equal(evaluateVerificationCompletion(missing).reason, 'plan_missing'); assert.equal(evaluateVerificationCompletion(f.input()).reason, 'check_missing');
  const optional = fixture(t, false); optional.settle(); assert.equal(evaluateVerificationCompletion(optional.input()).reason, 'no_required_checks');
});

test('actual pending verification prevents completion rather than creating a second check', t => {
  const f = fixture(t); f.begin(); const decision = evaluateVerificationCompletion(f.input()); assert.equal(decision.reason, 'verification_pending'); assert.equal(decision.status, 'blocked');
});

test('source checkpoint, registration currentness and profile revision are independently required', t => {
  const f = fixture(t); f.settle(); const changed = f.input(); changed.source = { ...source, checkpointId: 'new-checkpoint' }; assert.equal(evaluateVerificationCompletion(changed).reason, 'source_stale');
  const staleCheck = f.input(); staleCheck.planCurrent = false; assert.equal(evaluateVerificationCompletion(staleCheck).reason, 'check_stale');
  const changedProfile = f.input(); changedProfile.profile!.revision = 'different'; assert.equal(evaluateVerificationCompletion(changedProfile).reason, 'profile_stale');
});

test('fresh exit zero with changed source or incomplete cleanup does not prove task success', t => {
  const stale = fixture(t); stale.settle({ sourceAfter: { ...source, sha256: hash('changed') } }); assert.equal(evaluateVerificationCompletion(stale.input()).reason, 'source_stale');
  const uncertain = fixture(t); uncertain.settle({ cleanup: { confirmed: true, scope: 'posix-process-group', evidenceSha256: null } }); assert.equal(evaluateVerificationCompletion(uncertain.input()).reason, 'cleanup_uncertain');
  const incomplete = fixture(t); incomplete.settle({ executionComplete: false }); assert.equal(evaluateVerificationCompletion(incomplete.input()).status, 'blocked');
});

test('latest required check outcome supersedes an older pass and an explicit new pass can supersede ordinary failure', t => {
  const f = fixture(t); f.settle(); f.settle({ exitCode: 1 }); assert.equal(evaluateVerificationCompletion(f.input()).reason, 'check_failed'); f.settle(); assert.equal(evaluateVerificationCompletion(f.input()).taskVerified, true);
});

test('required unsupported/skipped and host-observed policy denial never silently count as repaired', t => {
  for (const disposition of ['unsupported', 'skipped'] as const) { const f = fixture(t); f.settle({ disposition, started: false, exitCode: null, executionCheckpointId: null, cleanup: { confirmed: true, scope: 'not-dispatched', evidenceSha256: null } }); assert.equal(evaluateVerificationCompletion(f.input()).reason, 'verification_unsupported'); }
  const denied = fixture(t); denied.settle({ exitCode: 1, reasonCode: 'TOOL_APPROVAL_DENIED' }); assert.equal(evaluateVerificationCompletion(denied.input()).reason, 'verification_denied');
});

test('digest mutations, scope changes and bounded malformed evidence cannot be interpreted as current pass', t => {
  const f = fixture(t); f.settle(); const mutation = f.input(); mutation.snapshot!.receipts[0]!.status = 'fail'; assert.equal(evaluateVerificationCompletion(mutation).reason, 'invalid_evidence');
  const scope = f.input(); scope.workspaceId = 'other-workspace'; assert.equal(evaluateVerificationCompletion(scope).reason, 'invalid_evidence');
  const cap = f.input(); cap.snapshot!.receipts = Array.from({ length: 49 }, () => cap.snapshot!.receipts[0]!); assert.equal(evaluateVerificationCompletion(cap).reason, 'invalid_evidence');
  const duplicate = f.input(); duplicate.snapshot!.receipts.push(duplicate.snapshot!.receipts[0]!); assert.equal(evaluateVerificationCompletion(duplicate).reason, 'invalid_evidence');
  const malformed = f.input(); malformed.snapshot!.plans[0] = null as never; assert.equal(evaluateVerificationCompletion(malformed).reason, 'invalid_evidence');
});

test('a source change cannot turn actual cancellation or denial into a source-stale repair opportunity', t => {
  for (const changes of [{ cancelled: true, exitCode: null, signal: 'SIGTERM' }, { exitCode: 1, reasonCode: 'ROLE_RESOURCE_DENIED' }] as Partial<VerificationObservation>[]) {
    const f = fixture(t); f.settle(changes); const input = f.input(); input.source = { ...source, sha256: hash('changed') }; assert.equal(evaluateVerificationCompletion(input).status, 'blocked');
  }
});

test('bounded protocol inspection rejects accessors and proxies before calling them', t => {
  const f = fixture(t); let called = 0; const input = f.input(); Object.defineProperty(input, 'source', { enumerable: true, get: () => { called++; return source; } });
  assert.throws(() => evaluateVerificationCompletion(input), error => error instanceof EngineError && error.code === 'INVALID_VERIFICATION_DATA'); assert.equal(called, 0);
  const proxy = f.input(); proxy.snapshot = new Proxy(proxy.snapshot!, {}); assert.throws(() => evaluateVerificationCompletion(proxy), error => error instanceof EngineError && error.code === 'INVALID_VERIFICATION_DATA');
});

test('changing an observation decision recomputes its digest without carrying the old digest into hashed input', t => {
  const f = fixture(t); const first = evaluateVerificationCompletion(f.input()), changed = completionDecision({ ...first, reason: 'budget_exhausted' }), { decisionSha256, ...body } = changed;
  assert.notEqual(changed.decisionSha256, first.decisionSha256); assert.equal(decisionSha256, verificationHash(body));
});
