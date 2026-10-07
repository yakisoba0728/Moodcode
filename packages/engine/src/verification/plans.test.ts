import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type JsonObject } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import { exportEngineArchive, importEngineArchive } from '../storage/archive.js';
import { ReviewJournal } from '../review/audit.js';
import { VerificationCheckRegistry, VerificationPlanService, verificationDocumentKind } from './plans.js';
import { VerificationReceiptService } from './receipts.js';
import { VERIFICATION_LIMITS, type VerificationPlanSelection, type VerificationStore } from './types.js';

const stamp = '2026-10-07T01:00:00.000Z';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const source = { sha256: hash('source'), revision: 'source-1', checkpointId: 'checkpoint-source' };
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-verification-plans-'))), dbPath = join(directory, 'engine.sqlite'), artifactDir = join(directory, 'artifacts'); mkdirSync(artifactDir);
  let store = new SqliteStore(dbPath);
  const extras: SqliteStore[] = [];
  t.after(() => { for (const extra of extras) extra.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  new ReviewJournal(dbPath + '.review.sqlite').close();
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: stamp }); store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Verification', createdAt: stamp });
  store.createSession({ id: 'other-session', workspaceId: 'workspace', title: 'Other', createdAt: stamp });
  const config = { providerId: 'scripted', modelId: 'fixture', mode: 'build' as const, limits: { ...DEFAULT_LIMITS } };
  const accept = (requestId: string) => store.promoteInput(store.acceptInput({ sessionId: 'session', requestId, prompt: 'verify', config, delivery: 'queue' }).inputId).run;
  const run = accept('first'); store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
  const registry = new VerificationCheckRegistry();
  const check = (id = 'typecheck') => ({ id, revision: 1, workspaceId: 'workspace', command: `npm run ${id}`, cwd: directory, profileId: 'verification', profileRevision: 'profile-1', sourceRevision: 'host-checks-1', timeoutMs: 1000, maxOutputBytes: 4096, required: true });
  registry.register(check()); registry.register(check('tests'));
  let plans = new VerificationPlanService(store, registry, () => stamp);
  return { directory, dbPath, artifactDir, run, registry, check, accept, attachStore: (extra: SqliteStore) => extras.push(extra), get store() { return store; }, get plans() { return plans; }, reopen() { store.close(); store = new SqliteStore(dbPath); plans = new VerificationPlanService(store, registry, () => stamp); }, selection: () => ({ checkIds: ['typecheck'], source: { ...source }, maxRepairs: 2 }) };
}

test('host-registered checks form detached immutable per-Run plans and a bounded metadata index', t => {
  const f = fixture(t), selection = f.selection();
  const saved = f.plans.create('session', f.run.id, 0, selection);
  selection.source.sha256 = hash('mutated');
  assert.equal(saved.revision, 1); assert.equal(saved.plans[0]!.source.sha256, source.sha256); assert.equal(saved.plans[0]!.executionAuthority, 'none'); assert.equal(saved.plans[0]!.checks[0]!.command, 'npm run typecheck'); assert.equal(saved.plans[0]!.checks[0]!.profileId, 'verification');
  assert.equal(saved.plans[0]!.budget.allocation, 'run-ceiling-only-not-reservation'); assert.equal(saved.plans[0]!.budget.maxExecutions, 3);
  assert.ok(verificationDocumentKind(f.run.id).length <= 64);
  const index = f.plans.list('session'); assert.deepEqual(index.runIds, [f.run.id]); assert.equal(index.receiptAuthority, false);
  const read = f.plans.get('session', f.run.id)!; read.plans[0]!.checks[0]!.command = 'changed';
  assert.equal(f.plans.get('session', f.run.id)!.plans[0]!.checks[0]!.command, 'npm run typecheck');
});

test('plans and exact host definitions survive SQLite close/reopen without commands or provider effects', t => {
  const f = fixture(t), before = f.plans.create('session', f.run.id, 0, f.selection());
  f.store.getSnapshot = () => { throw new Error('Full session inspection prohibited'); };
  assert.deepEqual(f.plans.get('session', f.run.id), before);
  f.reopen(); assert.deepEqual(f.plans.get('session', f.run.id), before); f.plans.assertCurrent(before);
});

test('CAS, foreign session and terminal/cancelling Run rejection preserve authoritative plans', t => {
  const f = fixture(t), saved = f.plans.create('session', f.run.id, 0, f.selection()), events = f.store.readSessionEvents('session', 0, 100);
  assert.throws(() => f.plans.create('session', f.run.id, 0, { ...f.selection(), source: { ...source, sha256: hash('new') } }), code('REVISION_CONFLICT'));
  assert.throws(() => f.plans.get('other-session', f.run.id), code('VERIFICATION_SCOPE_MISMATCH'));
  f.store.commit(f.run.id, 'run.completed', {}, { run: { state: 'completed' } });
  assert.throws(() => f.plans.create('session', f.run.id, saved.revision, { ...f.selection(), source: { ...source, sha256: hash('new') } }), code('RUN_TERMINAL'));
  assert.deepEqual(f.plans.get('session', f.run.id), saved); assert.deepEqual(f.store.readSessionEvents('session', 0, 100), events);
});

test('only check IDs can be selected; raw command/profile expansion, outside cwd and unknown registration fail', t => {
  const f = fixture(t);
  const expanded = { ...f.selection(), command: 'unapproved command', profileId: 'administrator' } as unknown as VerificationPlanSelection;
  assert.throws(() => f.plans.create('session', f.run.id, 0, expanded), code('INVALID_VERIFICATION_DATA'));
  assert.throws(() => f.plans.create('session', f.run.id, 0, { ...f.selection(), checkIds: ['not-registered'] }), code('VERIFICATION_CHECK_NOT_FOUND'));
  f.registry.register({ ...f.check('outside'), cwd: tmpdir() });
  assert.throws(() => f.plans.create('session', f.run.id, 0, { ...f.selection(), checkIds: ['outside'] }), code('INVALID_VERIFICATION_STATE'));
  assert.equal(f.plans.get('session', f.run.id), null); assert.deepEqual(f.plans.list('session').runIds, []);
});

test('definition mutation is detached and changed registry/root/config invalidate dispatch capture', t => {
  const f = fixture(t), definition = f.check('lint'), unregister = f.registry.register(definition);
  definition.command = 'changed';
  const saved = f.plans.create('session', f.run.id, 0, { ...f.selection(), checkIds: ['lint'] });
  assert.equal(saved.plans[0]!.checks[0]!.command, 'npm run lint');
  unregister(); f.registry.register({ ...f.check('lint'), revision: 2 });
  assert.throws(() => f.plans.assertCurrent(saved), code('VERIFICATION_CHECK_STALE'));
  f.store.commit(f.run.id, 'run.completed', {}, { run: { state: 'completed' } });
  const second = f.accept('root-change'), capture = f.plans.create('session', second.id, 0, f.selection());
  const getWorkspace = f.store.getWorkspace.bind(f.store); f.store.getWorkspace = id => ({ ...getWorkspace(id), root: join(f.directory, 'other-root') });
  assert.throws(() => f.plans.assertCurrent(capture), code('VERIFICATION_PLAN_STALE'));
  f.store.getWorkspace = getWorkspace;
  const getRun = f.store.getRun.bind(f.store); f.store.getRun = id => { const current = getRun(id); return { ...current, config: { ...current.config, modelId: 'changed-config' } }; };
  assert.throws(() => f.plans.assertCurrent(capture), code('VERIFICATION_PLAN_STALE'));
});

test('bounded plan revisions preserve older source evidence and reject automatic unbounded planning', t => {
  const f = fixture(t); let saved = f.plans.create('session', f.run.id, 0, f.selection());
  const unchanged = f.plans.create('session', f.run.id, saved.revision, f.selection()); assert.deepEqual(unchanged, saved);
  for (let i = 1; i < VERIFICATION_LIMITS.maxPlans; i++) saved = f.plans.create('session', f.run.id, saved.revision, { ...f.selection(), source: { ...source, sha256: hash(`source-${i}`), revision: `revision-${i}` } });
  assert.equal(saved.plans.length, 3); assert.equal(saved.plans[0]!.source.sha256, source.sha256);
  assert.throws(() => f.plans.create('session', f.run.id, saved.revision, { ...f.selection(), source: { ...source, sha256: hash('extra') } }), code('VERIFICATION_PLAN_LIMIT'));
});

test('new source plans cannot reset a smaller captured Run repair or execution allowance', t => {
  const f = fixture(t), initial = f.plans.create('session', f.run.id, 0, { ...f.selection(), maxRepairs: 0 });
  assert.throws(() => f.plans.create('session', f.run.id, initial.revision, { ...f.selection(), source: { ...source, sha256: hash('new') } }), code('VERIFICATION_REPAIR_ALLOWANCE_CHANGED'));
  assert.throws(() => f.plans.create('session', f.run.id, initial.revision, { checkIds: ['typecheck'], source: { ...source, sha256: hash('new') } }), code('VERIFICATION_PLAN_LIMIT'));
  assert.equal(f.plans.get('session', f.run.id)!.plans[0]!.budget.maxExecutions, 1);
});

test('index paging is bounded discovery metadata and a failed record CAS never makes its reservation authoritative', t => {
  const f = fixture(t), first = f.plans.create('session', f.run.id, 0, f.selection());
  f.store.commit(f.run.id, 'run.completed', {}, { run: { state: 'completed' } });
  const second = f.accept('second');
  const backing: VerificationStore = { getSession: id => f.store.getSession(id), getRun: id => f.store.getRun(id), getWorkspace: id => f.store.getWorkspace(id), getSessionControl: id => f.store.getSessionControl(id), getSessionDocument: (id, kind) => f.store.getSessionDocument(id, kind), putSessionDocument: (id, kind, rev, data) => f.store.putSessionDocument(id, kind, rev, data), putActiveRunDocument() { throw new EngineError('REVISION_CONFLICT', 'Injected publication failure'); } };
  assert.throws(() => new VerificationPlanService(backing, f.registry, () => stamp).create('session', second.id, 0, f.selection()), code('REVISION_CONFLICT'));
  const page = f.plans.list('session', undefined, 1); assert.deepEqual(page.runIds, [f.run.id]); assert.equal(page.nextCursor, f.run.id);
  assert.deepEqual(f.plans.list('session', page.nextCursor!, 1).runIds, [second.id]); assert.equal(f.plans.get('session', second.id), null); assert.deepEqual(f.plans.get('session', f.run.id), first);
  assert.throws(() => f.plans.list('session', 'foreign'), code('INVALID_VERIFICATION_CURSOR'));
});

test('malformed stored binding or altered check content is rejected on subsequent reads', t => {
  const f = fixture(t), saved = f.plans.create('session', f.run.id, 0, f.selection());
  const { revision, ...body } = saved; body.plans[0]!.checks[0]!.command = 'changed without updating registration';
  f.store.putSessionDocument('session', verificationDocumentKind(f.run.id), revision, body as unknown as JsonObject);
  assert.throws(() => f.plans.get('session', f.run.id), code('INVALID_VERIFICATION_STATE'));
});

test('explicit terminal discovery pruning frees bounded index capacity without deleting authoritative plans', t => {
  const f = fixture(t), saved = f.plans.create('session', f.run.id, 0, f.selection()), index = f.plans.list('session');
  assert.throws(() => f.plans.forgetIndexEntry('session', f.run.id, index.revision), code('VERIFICATION_INDEX_RUN_ACTIVE'));
  f.store.commit(f.run.id, 'run.completed', {}, { run: { state: 'completed' } });
  assert.throws(() => f.plans.forgetIndexEntry('session', f.run.id, 0), code('REVISION_CONFLICT'));
  assert.deepEqual(f.plans.forgetIndexEntry('session', f.run.id, index.revision).runIds, []); assert.deepEqual(f.plans.get('session', f.run.id), saved);
});

test('whole archive preserves per-Run plans and unresolved checks without silently resuming imported execution', async t => {
  const f = fixture(t), plan = f.plans.create('session', f.run.id, 0, f.selection());
  const receipts = new VerificationReceiptService(f.plans), pending = receipts.begin('session', f.run.id, plan.revision, { checkId: 'typecheck', toolCallId: 'tool', preparedFingerprint: hash('prepared'), source });
  const before = f.plans.get('session', f.run.id)!; f.store.close();
  const archive = await exportEngineArchive({ dbPath: f.dbPath, artifactDir: f.artifactDir, destination: join(f.directory, 'archive') });
  const imported = await importEngineArchive({ directory: archive.directory, destination: join(f.directory, 'imported') });
  const restored = new SqliteStore(imported.dbPath); f.attachStore(restored);
  const plans = new VerificationPlanService(restored, f.registry, () => stamp), service = new VerificationReceiptService(plans);
  assert.deepEqual(plans.get('session', f.run.id), before); assert.equal(imported.executionResumed, false); assert.equal(restored.getSessionControl('session').reason, 'recovery_required');
  assert.throws(() => service.dispatch('session', f.run.id, pending.revision, pending.receipt.id, source), code('VERIFICATION_RECOVERY_REQUIRED'));
  const uncertain = service.recoverPending('session', f.run.id, pending.revision); assert.equal(uncertain.receipts[0]!.status, 'uncertain'); assert.equal(uncertain.receipts[0]!.recovery, 'restart-without-outcome');
});
