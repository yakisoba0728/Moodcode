import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type ArtifactReference } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import { ArtifactStore } from '../artifacts/store.js';
import { VerificationCheckRegistry, VerificationPlanService, verificationDocumentKind } from './plans.js';
import { VerificationReceiptService } from './receipts.js';
import { verificationHash, type VerificationObservation, type VerificationReceipt, type VerificationSource } from './types.js';

const stamp = '2026-10-07T01:00:00.000Z';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const source: VerificationSource = { sha256: hash('source'), revision: 'source-1', checkpointId: 'source-checkpoint' };
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
function fixture(t: TestContext, maxToolCalls = DEFAULT_LIMITS.maxToolCalls) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-verification-receipts-'))), dbPath = join(directory, 'engine.sqlite');
  let store = new SqliteStore(dbPath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: stamp }); store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Receipts', createdAt: stamp });
  const input = store.acceptInput({ sessionId: 'session', requestId: 'request', prompt: 'verify', config: { providerId: 'scripted', modelId: 'fixture', mode: 'build', limits: { ...DEFAULT_LIMITS, maxToolCalls } }, delivery: 'queue' });
  const run = store.promoteInput(input.inputId).run; store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
  const registry = new VerificationCheckRegistry();
  const check = { id: 'tests', revision: 1, workspaceId: 'workspace', command: 'npm test', cwd: directory, profileId: 'verification', profileRevision: 'profile-1', sourceRevision: 'host-checks-1', timeoutMs: 1000, maxOutputBytes: 4096, required: true };
  const unregister = registry.register(check);
  let plans = new VerificationPlanService(store, registry, () => stamp), receipts = new VerificationReceiptService(plans);
  plans.create('session', run.id, 0, { checkIds: ['tests'], source });
  const begin = (id = 'tool') => receipts.begin('session', run.id, plans.get('session', run.id)!.revision, { checkId: 'tests', toolCallId: id, preparedFingerprint: hash(id), source });
  const dispatch = (receipt: VerificationReceipt) => receipts.dispatch('session', run.id, plans.get('session', run.id)!.revision, receipt.id, source);
  const outcome = (receipt: VerificationReceipt, changes: Partial<VerificationObservation> = {}): VerificationObservation => ({ disposition: 'executed', command: check.command, cwd: check.cwd, profileId: check.profileId, profileRevision: check.profileRevision, toolCallId: receipt.toolCallId, preparedFingerprint: receipt.preparedFingerprint, sourceBefore: { ...receipt.sourceBefore }, sourceAfter: { ...receipt.sourceBefore }, executionCheckpointId: 'command-checkpoint', exitCode: 0, signal: null, started: true, cancelled: false, timedOut: false, cleanup: { confirmed: true, scope: 'posix-process-group', evidenceSha256: hash('actual-cleanup-record') }, observedOutputBytes: 0, outputAccountingComplete: true, artifactRefs: [], reasonCode: null, ...changes });
  const settle = (receipt: VerificationReceipt, changes: Partial<VerificationObservation> = {}) => receipts.settle('session', run.id, plans.get('session', run.id)!.revision, receipt.id, outcome(receipt, changes));
  return { directory, dbPath, run, registry, unregister, begin, dispatch, outcome, settle, get store() { return store; }, get plans() { return plans; }, get receipts() { return receipts; }, reopen() { store.close(); store = new SqliteStore(dbPath); plans = new VerificationPlanService(store, registry, () => stamp); receipts = new VerificationReceiptService(plans); } };
}

test('prepared, dispatched and observed result state persists with exact command/source/fingerprint/cleanup bindings', t => {
  const f = fixture(t), prepared = f.begin(); assert.equal(prepared.receipt.status, null); assert.equal(prepared.receipt.phase, 'prepared');
  const dispatched = f.dispatch(prepared.receipt); assert.equal(dispatched.receipt.phase, 'dispatched');
  const result = f.settle(dispatched.receipt); assert.equal(result.receipt.status, 'pass'); assert.equal(result.receipt.observation!.command, 'npm test'); assert.equal(result.receipt.observation!.sourceBefore.sha256, source.sha256); assert.equal(result.receipt.observation!.cleanup.evidenceSha256, hash('actual-cleanup-record'));
  const { receiptSha256, ...body } = result.receipt; assert.equal(receiptSha256, verificationHash(body));
  const state = f.plans.get('session', f.run.id)!; f.reopen(); assert.deepEqual(f.plans.get('session', f.run.id), state);
});

const variants: Array<[string, Partial<VerificationObservation>]> = [
  ['fail', { exitCode: 1 }], ['timeout', { exitCode: null, signal: 'SIGTERM', timedOut: true }], ['cancelled', { exitCode: null, signal: 'SIGTERM', cancelled: true }],
  ['uncertain', { cleanup: { confirmed: false, scope: 'posix-process-group', evidenceSha256: hash('uncertain-cleanup') } }],
  ['uncertain', { cleanup: { confirmed: true, scope: 'posix-process-group', evidenceSha256: null } }], ['uncertain', { sourceAfter: null }],
  ['stale', { sourceAfter: { ...source, sha256: hash('changed-source'), revision: 'source-2' } }],
];
for (const [status, changes] of variants) test(`actual persisted observation distinguishes ${status}: ${Object.keys(changes).join(',')}`, t => {
  const f = fixture(t), receipt = f.dispatch(f.begin().receipt).receipt, result = f.settle(receipt, changes);
  assert.equal(result.receipt.status, status); assert.deepEqual(result.receipt.observation, f.outcome(receipt, changes));
  assert.equal(f.plans.get('session', f.run.id)!.receipts[0]!.status, status);
});

for (const disposition of ['skipped', 'unsupported'] as const) test(`${disposition} stays distinct and has no claimed process dispatch`, t => {
  const f = fixture(t), receipt = f.begin().receipt;
  const result = f.settle(receipt, { disposition, exitCode: null, started: false, executionCheckpointId: null, cleanup: { confirmed: true, scope: 'not-dispatched', evidenceSha256: null }, reasonCode: disposition === 'skipped' ? 'HOST_SKIP' : 'PLATFORM_UNSUPPORTED' });
  assert.equal(result.receipt.status, disposition); assert.equal(result.receipt.dispatchedAt, null);
});

test('observed source-file change invalidates a successful exit without erasing the actual exit result', t => {
  const f = fixture(t), path = join(f.directory, 'source.ts'); writeFileSync(path, 'source');
  const receipt = f.dispatch(f.begin().receipt).receipt; writeFileSync(path, 'changed');
  const result = f.settle(receipt, { sourceAfter: { ...source, sha256: hash(readFileSync(path, 'utf8')), revision: 'source-2' } });
  assert.equal(result.receipt.status, 'stale'); assert.equal(result.receipt.observation!.exitCode, 0); assert.equal(result.receipt.sourceStale, true);
});

test('partial original log artifacts and unknown output accounting survive receipt persistence/reopen', async t => {
  const f = fixture(t), receipt = f.dispatch(f.begin().receipt).receipt;
  const artifacts = await ArtifactStore.open({ directory: join(f.directory, 'logs') });
  const stored = await artifacts.put({ identity: { sessionId: 'session', runId: f.run.id, toolCallId: receipt.toolCallId }, content: 'original diagnostic log', sourceComplete: false, outcome: 'completed' });
  const result = f.settle(receipt, { artifactRefs: [stored.reference], observedOutputBytes: null, outputAccountingComplete: false });
  assert.equal(result.receipt.status, 'pass'); assert.equal(result.receipt.observation!.artifactRefs[0]!.complete, false); assert.equal(result.receipt.observation!.observedOutputBytes, null);
  f.reopen(); const restored = f.plans.get('session', f.run.id)!.receipts[0]!;
  assert.deepEqual(restored.observation!.artifactRefs, [stored.reference]);
  const page = await artifacts.read(stored.reference.id, { identity: stored.reference.identity }); assert.equal(Buffer.from(page.bytes).toString('utf8'), 'original diagnostic log');
});

test('execution needs durable dispatch; exact command/profile/source/identity overrides never publish', t => {
  const f = fixture(t), receipt = f.begin().receipt, before = f.plans.get('session', f.run.id)!;
  assert.throws(() => f.settle(receipt), code('VERIFICATION_DISPATCH_REQUIRED'));
  const dispatched = f.dispatch(receipt).receipt, state = f.plans.get('session', f.run.id)!;
  for (const changes of [{ command: 'unapproved command' }, { cwd: tmpdir() }, { profileId: 'admin' }, { profileRevision: 'other' }, { toolCallId: 'other-tool' }, { preparedFingerprint: hash('other') }, { sourceBefore: { ...source, sha256: hash('other') } }]) assert.throws(() => f.settle(dispatched, changes), code('VERIFICATION_OBSERVATION_BINDING_MISMATCH'));
  assert.equal(before.receipts[0]!.phase, 'prepared'); assert.deepEqual(f.plans.get('session', f.run.id), state);
});

test('foreign log artifact ownership cannot be attached to a valid check', t => {
  const f = fixture(t), receipt = f.dispatch(f.begin().receipt).receipt;
  const artifact: ArtifactReference = { id: 'artifact_' + 'a'.repeat(32), identity: { sessionId: 'session', runId: 'foreign-run', toolCallId: receipt.toolCallId }, sha256: hash('log'), storedBytes: 3, observedBytes: 3, producerTruncatedBytes: 0, artifactTruncatedBytes: 0, complete: true, outcome: 'completed', createdAt: stamp, expiresAt: '2027-10-07T01:00:00.000Z' };
  assert.throws(() => f.settle(receipt, { artifactRefs: [artifact] }), code('VERIFICATION_ARTIFACT_BINDING_MISMATCH'));
  assert.equal(f.plans.get('session', f.run.id)!.receipts[0]!.phase, 'dispatched');
});

test('late receipt after Run terminal or cancelling is rejected without adding terminal Run events', t => {
  const f = fixture(t), receipt = f.dispatch(f.begin().receipt).receipt, before = f.plans.get('session', f.run.id)!;
  f.store.commit(f.run.id, 'run.cancelling', {}, { run: { state: 'cancelling' } });
  const events = f.store.readSessionEvents('session', 0, 100);
  assert.throws(() => f.settle(receipt), code('RUN_TERMINAL')); assert.deepEqual(f.plans.get('session', f.run.id), before); assert.deepEqual(f.store.readSessionEvents('session', 0, 100), events);
  f.store.commit(f.run.id, 'run.cancelled', {}, { run: { state: 'cancelled' } });
  assert.throws(() => f.settle(receipt), code('RUN_TERMINAL')); assert.deepEqual(f.plans.get('session', f.run.id), before);
});

test('Run becoming terminal immediately before publication is rejected by the actual atomic store guard', t => {
  const f = fixture(t), receipt = f.dispatch(f.begin().receipt).receipt, before = f.plans.get('session', f.run.id)!, events = f.store.readSessionEvents('session', 0, 100);
  const publish = f.store.putActiveRunDocument.bind(f.store);
  f.store.putActiveRunDocument = (runId, kind, revision, data) => { f.store.commit(runId, 'run.completed', {}, { run: { state: 'completed' } }); return publish(runId, kind, revision, data); };
  assert.throws(() => f.settle(receipt), code('RUN_TERMINAL')); assert.equal(f.store.getRun(f.run.id).state, 'completed'); assert.deepEqual(f.plans.get('session', f.run.id), before); assert.deepEqual(f.store.readSessionEvents('session', 0, 100), events);
});

test('CAS conflict preserves the pending receipt and never silently overwrites a concurrent document revision', t => {
  const f = fixture(t), receipt = f.dispatch(f.begin().receipt).receipt, publish = f.store.putActiveRunDocument.bind(f.store);
  f.store.putActiveRunDocument = (runId, kind, revision, data) => { const current = f.store.getSessionDocument('session', kind)!; f.store.putSessionDocument('session', kind, current.revision, current.data); return publish(runId, kind, revision, data); };
  assert.throws(() => f.settle(receipt), code('REVISION_CONFLICT')); assert.equal(f.plans.get('session', f.run.id)!.receipts[0]!.phase, 'dispatched');
});

for (const phase of ['prepared', 'dispatched'] as const) test(`restart converts unresolved ${phase} to uncertain without redispatch and rejects later physical results`, t => {
  const f = fixture(t); let pending = f.begin().receipt;
  if (phase === 'dispatched') pending = f.dispatch(pending).receipt;
  const before = f.plans.get('session', f.run.id)!; f.reopen();
  assert.deepEqual(f.plans.get('session', f.run.id), before);
  f.store.recoverInterrupted(); assert.equal(f.store.getRun(f.run.id).state, 'interrupted');
  const recovered = f.receipts.recoverPending('session', f.run.id, before.revision); assert.equal(recovered.receipts[0]!.status, 'uncertain'); assert.equal(recovered.receipts[0]!.observation, null); assert.equal(recovered.receipts[0]!.dispatchedAt, pending.dispatchedAt);
  const events = f.store.readSessionEvents('session', 0, 100);
  assert.deepEqual(f.receipts.recoverPending('session', f.run.id, recovered.revision), recovered); assert.deepEqual(f.store.readSessionEvents('session', 0, 100), events);
  assert.throws(() => f.receipts.settle('session', f.run.id, recovered.revision, pending.id, f.outcome(pending)), code('VERIFICATION_RECEIPT_TERMINAL'));
});

test('source change before preparation or dispatch never advances to execution intent', t => {
  const f = fixture(t), revision = f.plans.get('session', f.run.id)!.revision, changed = { ...source, sha256: hash('new') };
  assert.throws(() => f.receipts.begin('session', f.run.id, revision, { checkId: 'tests', toolCallId: 'tool', preparedFingerprint: hash('tool'), source: changed }), code('VERIFICATION_SOURCE_STALE'));
  const prepared = f.begin(); assert.throws(() => f.receipts.dispatch('session', f.run.id, prepared.revision, prepared.receipt.id, changed), code('VERIFICATION_SOURCE_STALE'));
  assert.equal(f.plans.get('session', f.run.id)!.receipts[0]!.phase, 'prepared');
});

test('administrative crash recovery cannot overwrite a live pending result or a user pause', t => {
  const f = fixture(t), pending = f.begin(), before = f.plans.get('session', f.run.id)!;
  assert.throws(() => f.receipts.recoverPending('session', f.run.id, pending.revision), code('VERIFICATION_RECOVERY_NOT_READY'));
  f.store.setSessionPaused('session', true, 'user');
  assert.throws(() => f.receipts.recoverPending('session', f.run.id, pending.revision), code('VERIFICATION_RECOVERY_NOT_READY'));
  assert.deepEqual(f.plans.get('session', f.run.id), before);
});

test('check executions cannot reuse consumed fingerprints and retries stay inside frozen allowance and Run ceiling', t => {
  const f = fixture(t, 2);
  for (let i = 0; i < 2; i++) { const receipt = f.dispatch(f.begin(`tool-${i}`).receipt).receipt; f.settle(receipt, { exitCode: 1 }); }
  assert.throws(() => f.begin('tool-0'), code('VERIFICATION_EXECUTION_CONFLICT'));
  assert.throws(() => f.begin('tool-extra'), code('VERIFICATION_ATTEMPT_LIMIT'));
  assert.equal(f.plans.get('session', f.run.id)!.receipts.length, 2);
});

test('a fresh source plan preserves history and never resets the total coding Run execution cap', t => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) f.settle(f.dispatch(f.begin(`old-tool-${i}`).receipt).receipt, { exitCode: 1 });
  const changed = { ...source, sha256: hash('repair-source'), revision: 'repair-source-2' }, previous = f.plans.get('session', f.run.id)!;
  const plan = f.plans.create('session', f.run.id, previous.revision, { checkIds: ['tests'], source: changed });
  assert.equal(plan.plans.length, 2); assert.equal(plan.receipts.length, 2); assert.equal(plan.plans[1]!.budget.maxExecutions, 3);
  const prepared = f.receipts.begin('session', f.run.id, plan.revision, { checkId: 'tests', toolCallId: 'new-tool', preparedFingerprint: hash('new-tool'), source: changed });
  const dispatched = f.receipts.dispatch('session', f.run.id, prepared.revision, prepared.receipt.id, changed);
  const settled = f.receipts.settle('session', f.run.id, dispatched.revision, dispatched.receipt.id, f.outcome(dispatched.receipt));
  assert.equal(settled.receipt.status, 'pass');
  assert.throws(() => f.receipts.begin('session', f.run.id, settled.revision, { checkId: 'tests', toolCallId: 'extra-tool', preparedFingerprint: hash('extra-tool'), source: changed }), code('VERIFICATION_ATTEMPT_LIMIT'));
});

test('uncertain cleanup blocks new executions and changing registration cannot erase a real observed result', t => {
  const f = fixture(t), receipt = f.dispatch(f.begin().receipt).receipt;
  f.unregister(); f.registry.register({ id: 'tests', revision: 2, workspaceId: 'workspace', command: 'npm test', cwd: f.directory, profileId: 'verification', profileRevision: 'profile-2', sourceRevision: 'host-checks-2', timeoutMs: 1000, maxOutputBytes: 4096, required: true });
  const result = f.settle(receipt, { cleanup: { confirmed: false, scope: 'posix-process-group', evidenceSha256: hash('unknown-cleanup') } });
  assert.equal(result.receipt.status, 'uncertain');
  assert.throws(() => f.begin('another-tool'), code('VERIFICATION_CHECK_STALE'));
  const unchanged = fixture(t), second = unchanged.dispatch(unchanged.begin().receipt).receipt;
  unchanged.settle(second, { cleanup: { confirmed: false, scope: 'posix-process-group', evidenceSha256: hash('unknown') } });
  assert.throws(() => unchanged.begin('another-tool'), code('VERIFICATION_RECOVERY_REQUIRED'));
});

test('invalid contradictory flags, already settled receipts and nested getter/proxy observations fail without publication', t => {
  const f = fixture(t), receipt = f.dispatch(f.begin().receipt).receipt;
  assert.throws(() => f.settle(receipt, { cancelled: true, timedOut: true }), code('INVALID_VERIFICATION_OBSERVATION'));
  let touches = 0; const hostile = f.outcome(receipt);
  Object.defineProperty(hostile.cleanup, 'confirmed', { enumerable: true, get() { touches++; throw new Error('Cleanup getter'); } });
  assert.throws(() => f.receipts.settle('session', f.run.id, f.plans.get('session', f.run.id)!.revision, receipt.id, hostile), code('INVALID_VERIFICATION_DATA')); assert.equal(touches, 0);
  const proxied = f.outcome(receipt); proxied.sourceAfter = new Proxy(source, { getPrototypeOf() { touches++; throw new Error('Proxy reflection'); } });
  assert.throws(() => f.receipts.settle('session', f.run.id, f.plans.get('session', f.run.id)!.revision, receipt.id, proxied), code('INVALID_VERIFICATION_DATA')); assert.equal(touches, 0);
  const result = f.settle(receipt); assert.throws(() => f.receipts.settle('session', f.run.id, result.revision, receipt.id, f.outcome(receipt, { exitCode: 1 })), code('VERIFICATION_RECEIPT_TERMINAL'));
});
