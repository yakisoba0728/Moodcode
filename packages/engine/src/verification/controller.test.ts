import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type JsonObject } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import { exportEngineArchive, importEngineArchive } from '../storage/archive.js';
import { ReviewJournal } from '../review/audit.js';
import { VerificationCheckRegistry, VerificationPlanService, verificationDocumentKind } from './plans.js';
import { VerificationReceiptService } from './receipts.js';
import { verificationHash, type VerificationObservation, type VerificationSource } from './types.js';
import { VerificationController, verificationContinuationMessage, verificationControllerDocumentKind, type VerificationControllerPorts, type VerificationExecutionBlocker, type VerificationRemainingBudget } from './controller.js';
import type { VerificationBoundary } from './completion.js';

const stamp = '2026-10-07T01:00:00.000Z';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
const stop = (id: string): VerificationBoundary => ({ id, phase: 'stop', turnId: id, providerTerminal: true, nativeTurnCompleted: true });
const before = (id: string): VerificationBoundary => ({ id, phase: 'before-provider', turnId: null, providerTerminal: false, nativeTurnCompleted: false });
function fixture(t: TestContext, maxRepairs = 2, withPlan = true) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-verification-controller-'))), dbPath = join(directory, 'engine.sqlite'), sourcePath = join(directory, 'source.ts');
  writeFileSync(sourcePath, 'source'); let store = new SqliteStore(dbPath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: stamp });
  for (const id of ['session', 'other-session']) store.createSession({ id, workspaceId: 'workspace', title: id, createdAt: stamp });
  const accepted = store.acceptInput({ sessionId: 'session', requestId: 'request', prompt: 'verify', config: { providerId: 'scripted', modelId: 'fixture', mode: 'build', limits: { ...DEFAULT_LIMITS } }, delivery: 'queue' });
  const run = store.promoteInput(accepted.inputId).run; store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
  const source = (): VerificationSource => ({ sha256: hash(readFileSync(sourcePath, 'utf8')), revision: 'selected-source-files-v1', checkpointId: 'source-checkpoint' });
  const registry = new VerificationCheckRegistry(), check = { id: 'tests', revision: 1, workspaceId: 'workspace', command: 'npm test', cwd: directory, profileId: 'verification', profileRevision: 'profile-1', sourceRevision: 'host-checks-1', timeoutMs: 1000, maxOutputBytes: 4096, required: true };
  registry.register(check); let plans = new VerificationPlanService(store, registry, () => stamp), receipts = new VerificationReceiptService(plans);
  if (withPlan) plans.create('session', run.id, 0, { checkIds: ['tests'], source: source(), maxRepairs });
  let budget: VerificationRemainingBudget = { turns: 4, toolCalls: 4, outputBytes: 4096, durationMs: 10000 }, blocker: VerificationExecutionBlocker | null = null, profile = { id: 'verification', revision: 'profile-1' }, observations = 0, publications = 0;
  let observationHook: ((ordinal: number) => void | Promise<void>) | null = null, commitHook: (() => void) | null = null, boundaryHook: (() => void) | null = null;
  const ports: VerificationControllerPorts = {
    observeSource: async () => { await observationHook?.(++observations); return source(); }, readCurrentProfile: () => profile, readRemainingBudget: () => budget, readExecutionBlocker: () => blocker,
    assertBoundaryCurrent: () => { boundaryHook?.(); },
    commitCurrent: (runId, kind, expectedRevision, data, revision) => { commitHook?.(); const saved = store.putActiveVerificationControllerDocument(runId, kind, expectedRevision, data, revision); publications++; return saved; },
  };
  let controller = new VerificationController(store, plans, ports, () => stamp), sequence = 0;
  const settle = (changes: Partial<VerificationObservation> = {}) => {
    const toolCallId = 'tool_' + ++sequence, receipt = receipts.begin('session', run.id, plans.get('session', run.id)!.revision, { checkId: 'tests', toolCallId, preparedFingerprint: hash(toolCallId), source: source() }).receipt;
    const dispatched = changes.disposition && changes.disposition !== 'executed' ? receipt : receipts.dispatch('session', run.id, plans.get('session', run.id)!.revision, receipt.id, source()).receipt;
    return receipts.settle('session', run.id, plans.get('session', run.id)!.revision, dispatched.id, { disposition: 'executed', command: check.command, cwd: check.cwd, profileId: check.profileId, profileRevision: check.profileRevision, toolCallId, preparedFingerprint: hash(toolCallId), sourceBefore: source(), sourceAfter: source(), executionCheckpointId: 'command-checkpoint', exitCode: 0, signal: null, started: true, cancelled: false, timedOut: false, cleanup: { confirmed: true, scope: 'posix-process-group', evidenceSha256: hash('cleanup') }, observedOutputBytes: 0, outputAccountingComplete: true, artifactRefs: [], executionComplete: true, reasonCode: null, ...changes });
  };
  const input = (boundary: VerificationBoundary) => ({ boundary, source: source(), verificationRevision: plans.get('session', run.id)?.revision ?? 0, planSha256: plans.get('session', run.id)?.plans.at(-1)?.planSha256 ?? null });
  const evaluate = (boundary: VerificationBoundary, expected = controller.get('session', run.id)?.revision ?? 0) => controller.evaluate('session', run.id, expected, input(boundary), new AbortController().signal);
  const newPlan = (text: string) => { writeFileSync(sourcePath, text); return plans.create('session', run.id, plans.get('session', run.id)!.revision, { checkIds: ['tests'], source: source(), maxRepairs }); };
  return { directory, dbPath, run, source, registry, settle, evaluate, input, newPlan, ports, get store() { return store; }, get controller() { return controller; }, get plans() { return plans; }, get publications() { return publications; }, set budget(value: VerificationRemainingBudget) { budget = value; }, set blocker(value: VerificationExecutionBlocker | null) { blocker = value; }, set observationHook(value: typeof observationHook) { observationHook = value; }, set commitHook(value: typeof commitHook) { commitHook = value; }, set boundaryHook(value: typeof boundaryHook) { boundaryHook = value; }, set profile(value: typeof profile) { profile = value; }, reopen() { store.close(); store = new SqliteStore(dbPath); plans = new VerificationPlanService(store, registry, () => stamp); receipts = new VerificationReceiptService(plans); controller = new VerificationController(store, plans, ports, () => stamp); } };
}

test('current pass publishes task verification independently of the still-running original Run', async t => {
  const f = fixture(t); f.settle(); const decision = await f.evaluate(stop('terminal-turn'));
  assert.equal(decision.result.taskVerified, true); assert.equal(decision.result.action, 'stop'); assert.equal(decision.completion!.authority, 'observation-only'); assert.equal(f.store.getRun(f.run.id).state, 'running'); assert.equal(verificationContinuationMessage(decision), null);
  f.reopen(); assert.deepEqual(f.controller.get('session', f.run.id), decision); assert.equal(f.publications, 1);
});

test('failed check schedules one bounded DATA continuation, and before-provider consumes it without allocating another repair', async t => {
  const f = fixture(t); f.settle({ exitCode: 1 }); const scheduled = await f.evaluate(stop('turn-1')), message = JSON.parse(verificationContinuationMessage(scheduled)!);
  assert.equal(scheduled.result.action, 'continue'); assert.equal(scheduled.repairsUsed, 1); assert.equal(message.executionAuthority, 'none'); assert.equal(message.checkIds[0], 'tests'); assert.equal('command' in message, false); assert.equal('approval' in message, false);
  const consumed = await f.evaluate(before('provider-boundary-2')); assert.equal(consumed.repairsUsed, 1); assert.equal(consumed.result.action, 'proceed'); assert.equal(consumed.stages[0]!.consumedByBoundaryId, 'provider-boundary-2'); assert.equal(verificationContinuationMessage(consumed), null);
  assert.equal(f.store.getSnapshot('session').runs.length, 1); assert.equal(f.store.getSnapshot('session').tools.length, 0);
});

test('fresh receipts with the same source/check/outcome stall instead of resetting the repair allowance', async t => {
  const f = fixture(t); f.settle({ exitCode: 1 }); await f.evaluate(stop('turn-1')); await f.evaluate(before('provider-2')); f.settle({ exitCode: 1 });
  const stalled = await f.evaluate(stop('turn-2')); assert.equal(stalled.result.reason, 'stalled'); assert.equal(stalled.result.action, 'stop'); assert.equal(stalled.repairsUsed, 1); assert.equal(stalled.stages.length, 1);
});

test('source/plan changes and SQLite restart never reset the original Run repair count', async t => {
  const f = fixture(t); f.settle({ exitCode: 1 }); await f.evaluate(stop('turn-1')); await f.evaluate(before('provider-2')); f.newPlan('changed-source-2'); f.settle({ exitCode: 2 });
  const second = await f.evaluate(stop('turn-2')); assert.equal(second.repairsUsed, 2); assert.equal(second.result.action, 'continue'); await f.evaluate(before('provider-3')); f.reopen();
  f.newPlan('changed-source-3'); f.settle({ exitCode: 3 }); const exhausted = await f.evaluate(stop('turn-3')); assert.equal(exhausted.result.reason, 'repair_limit'); assert.equal(exhausted.result.action, 'stop'); assert.equal(exhausted.repairsUsed, 2); assert.equal(exhausted.stages.length, 2);
});

test('frozen zero repair allowance and original depleted Run budgets cannot create a continuation', async t => {
  const zero = fixture(t, 0); assert.equal((await zero.evaluate(stop('zero'))).result.reason, 'repair_limit');
  const depleted = fixture(t); depleted.budget = { turns: 0, toolCalls: 4, outputBytes: 4096, durationMs: 10000 }; const decision = await depleted.evaluate(stop('depleted')); assert.equal(decision.result.reason, 'budget_exhausted'); assert.equal(decision.stages.length, 0);
});

test('outer native approval denial with zero receipts is blocked without requesting the same approval again', async t => {
  const f = fixture(t); f.blocker = 'verification_denied'; assert.equal(f.plans.get('session', f.run.id)!.receipts.length, 0);
  const decision = await f.evaluate(stop('denied')); assert.equal(decision.result.reason, 'verification_denied'); assert.equal(decision.result.status, 'blocked'); assert.equal(decision.repairsUsed, 0); assert.equal(verificationContinuationMessage(decision), null);
});

for (const [reason, changes] of [
  ['cleanup_uncertain', { cleanup: { confirmed: false, scope: 'posix-process-group', evidenceSha256: hash('uncertain') } }],
  ['verification_cancelled', { cancelled: true, exitCode: null, signal: 'SIGTERM' }],
  ['verification_unsupported', { disposition: 'unsupported', exitCode: null, started: false, executionCheckpointId: null, cleanup: { confirmed: true, scope: 'not-dispatched', evidenceSha256: null }, reasonCode: 'PLATFORM_UNSUPPORTED' }],
  ['verification_denied', { exitCode: 1, reasonCode: 'ROLE_RESOURCE_DENIED' }],
] as Array<[string, Partial<VerificationObservation>]>) test(`${reason} does not issue repair authorization`, async t => {
  const f = fixture(t); f.settle(changes); const decision = await f.evaluate(stop(reason)); assert.equal(decision.result.reason, reason); assert.equal(decision.result.status, 'blocked'); assert.equal(decision.stages.length, 0);
});

test('boundary CAS is idempotent while changed inputs and stale new-boundary revisions are rejected', async t => {
  const f = fixture(t); const first = await f.evaluate(stop('turn')); const same = await f.evaluate(stop('turn'), 0); assert.deepEqual(same, first); assert.equal(f.publications, 1);
  await assert.rejects(f.evaluate(before('new-boundary'), 0), code('REVISION_CONFLICT'));
  f.newPlan('changed'); await assert.rejects(f.evaluate(stop('turn')), code('VERIFICATION_CONTROLLER_BOUNDARY_CONFLICT')); assert.equal(f.publications, 1);
});

test('concurrent controllers at one boundary publish exactly one CAS record and allocation', async t => {
  const f = fixture(t); let waiting = 0, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.observationHook = async ordinal => { if (ordinal >= 3) { if (++waiting === 2) release(); await gate; } };
  const second = new VerificationController(f.store, f.plans, f.ports, () => stamp), input = f.input(stop('same-boundary'));
  const results = await Promise.allSettled([f.controller.evaluate('session', f.run.id, 0, input, new AbortController().signal), second.evaluate('session', f.run.id, 0, input, new AbortController().signal)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.filter(result => result.status === 'rejected' && result.reason instanceof EngineError && result.reason.code === 'REVISION_CONFLICT').length, 1);
  const current = f.controller.get('session', f.run.id)!; assert.equal(current.revision, 1); assert.equal(current.stages.length, 1); assert.equal(current.repairsUsed, 1); assert.equal(f.publications, 1);
});

test('re-reading an old boundary after stage consumption returns a consistent observation without replaying control data', async t => {
  const f = fixture(t); await f.evaluate(stop('turn')); const consumed = await f.evaluate(before('provider')); const old = await f.evaluate(stop('turn'), 0), { revision: _revision, stateSha256, ...body } = old;
  assert.equal(old.result.id, 'turn'); assert.equal(stateSha256, verificationHash(body)); assert.equal(verificationContinuationMessage(old), null); assert.deepEqual(f.controller.get('session', f.run.id), consumed); assert.equal(f.publications, 2);
});

test('physical source, current profile, and native denial changes during observation publish nothing', async t => {
  for (const mutation of ['source', 'profile', 'denial'] as const) {
    const f = fixture(t); f.observationHook = ordinal => { if (ordinal === 2) { if (mutation === 'source') writeFileSync(join(f.directory, 'source.ts'), 'changed'); else if (mutation === 'profile') f.profile = { id: 'verification', revision: 'new-profile' }; else f.blocker = 'verification_denied'; } };
    await assert.rejects(f.evaluate(stop(mutation)), code('VERIFICATION_CONTROLLER_SOURCE_STALE')); assert.equal(f.controller.get('session', f.run.id), null); assert.equal(f.publications, 0);
  }
});

test('atomic publication rejects receipt CAS changes and terminal writes after asynchronous observation', async t => {
  const changed = fixture(t); changed.commitHook = () => { changed.settle(); changed.commitHook = null; }; await assert.rejects(changed.evaluate(stop('changed')), code('VERIFICATION_CONTROLLER_SOURCE_STALE')); assert.equal(changed.controller.get('session', changed.run.id), null);
  const terminal = fixture(t); terminal.observationHook = ordinal => { if (ordinal === 2) terminal.store.commit(terminal.run.id, 'run.completed', {}, { run: { state: 'completed' } }); };
  await assert.rejects(terminal.evaluate(stop('late')), code('RUN_TERMINAL')); assert.equal(terminal.controller.get('session', terminal.run.id), null);
});

test('a continuation source change before its next-provider boundary rejects consumption and preserves stage evidence', async t => {
  const f = fixture(t); const issued = await f.evaluate(stop('turn')); f.newPlan('changed-before-next-provider'); await assert.rejects(f.evaluate(before('provider')), code('VERIFICATION_CONTROLLER_STAGE_STALE')); assert.deepEqual(f.controller.get('session', f.run.id), issued);
});

test('accessors, proxies, malformed budgets, cancellation and foreign scope cannot publish a controller record', async t => {
  const f = fixture(t); let invoked = 0; const input = f.input(stop('invalid')); Object.defineProperty(input, 'source', { enumerable: true, get: () => { invoked++; return f.source(); } });
  await assert.rejects(f.controller.evaluate('session', f.run.id, 0, input, new AbortController().signal), code('INVALID_VERIFICATION_DATA')); assert.equal(invoked, 0);
  await assert.rejects(f.controller.evaluate('session', f.run.id, 0, new Proxy(f.input(stop('proxy')), {}), new AbortController().signal), code('INVALID_VERIFICATION_DATA'));
  f.budget = { turns: -1, toolCalls: 4, outputBytes: 4096, durationMs: 10000 }; await assert.rejects(f.evaluate(stop('budget')), code('INVALID_VERIFICATION_DATA'));
  const abort = new AbortController(); abort.abort(); await assert.rejects(f.controller.evaluate('session', f.run.id, 0, f.input(stop('cancel')), abort.signal), code('CANCELLED'));
  await assert.rejects(f.controller.evaluate('other-session', f.run.id, 0, f.input(stop('scope')), new AbortController().signal), code('VERIFICATION_SCOPE_MISMATCH')); assert.equal(f.publications, 0);
});

test('controller document and logical boundary history are bounded and corrupted durable counters do not reset', async t => {
  const f = fixture(t, 0);
  for (let ordinal = 0; ordinal < 64; ordinal++) await f.evaluate(before('boundary-' + ordinal));
  const bounded = f.controller.get('session', f.run.id)!; assert.equal(bounded.boundaries.length, 64); assert.equal(bounded.result.reason, 'controller_limit'); assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 65536);
  await assert.rejects(f.evaluate(before('overflow')), code('INVALID_VERIFICATION_CONTROLLER'));
  const { revision, ...state } = bounded; const damaged = { ...state, repairsUsed: 999 };
  f.store.putSessionDocument('session', verificationControllerDocumentKind(f.run.id), revision, damaged as unknown as JsonObject); assert.throws(() => f.controller.get('session', f.run.id), code('INVALID_VERIFICATION_DATA'));
});

test('rehashed malformed stored candidate fields still fail semantic validation and remain observation-only', async t => {
  const f = fixture(t); f.settle(); const valid = await f.evaluate(stop('turn')), { revision, stateSha256: _stateSha, ...body } = valid;
  const completion = structuredClone(body.completion!); completion.decision.requiredChecks[0]!.status = 'model_says_pass' as never;
  const { decisionSha256: _decisionSha, ...decision } = completion.decision; completion.decision.decisionSha256 = verificationHash(decision);
  const { candidateSha256: _candidateSha, ...candidate } = completion; completion.candidateSha256 = verificationHash(candidate);
  const malformed = { ...body, completion }; f.store.putSessionDocument('session', verificationControllerDocumentKind(f.run.id), revision, { ...malformed, stateSha256: verificationHash(malformed) } as unknown as JsonObject);
  assert.throws(() => f.controller.get('session', f.run.id), code('INVALID_VERIFICATION_CONTROLLER'));
});

test('archive/import preserves repair evidence and recovery pause prevents automatic stage replay', { timeout: 30000 }, async t => {
  const f = fixture(t); f.settle({ exitCode: 1 }); const issued = await f.evaluate(stop('turn-1'));
  new ReviewJournal(f.dbPath + '.review.sqlite').close(); const artifacts = join(f.directory, 'artifacts'); mkdirSync(artifacts); f.store.close();
  const archive = await exportEngineArchive({ dbPath: f.dbPath, artifactDir: artifacts, destination: join(f.directory, 'archive') });
  const imported = await importEngineArchive({ directory: archive.directory, destination: join(f.directory, 'imported') }); assert.equal(imported.executionResumed, false);
  const restored = new SqliteStore(imported.dbPath); t.after(() => restored.close()); const plans = new VerificationPlanService(restored, f.registry, () => stamp), controller = new VerificationController(restored, plans, { ...f.ports, commitCurrent: (runId, kind, revision, data, sourceRevision) => restored.putActiveVerificationControllerDocument(runId, kind, revision, data, sourceRevision) });
  assert.deepEqual(controller.get('session', f.run.id), issued); assert.equal(restored.getSessionControl('session').paused, true);
  await assert.rejects(controller.evaluate('session', f.run.id, issued.revision, { boundary: before('imported-provider'), source: f.source(), verificationRevision: plans.get('session', f.run.id)!.revision, planSha256: plans.get('session', f.run.id)!.plans.at(-1)!.planSha256 }, new AbortController().signal), code('VERIFICATION_RECOVERY_REQUIRED'));
  assert.deepEqual(controller.get('session', f.run.id), issued); assert.equal(restored.getSnapshot('session').runs.length, 1); assert.equal(restored.getSnapshot('session').tools.length, 0);
});
