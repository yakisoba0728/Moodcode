import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { assertWorkspaceTrustSourcesCurrent, captureWorkspaceTrustSources } from '../workspace/trust.js';
import { KnowledgeStorage, KNOWLEDGE_SCHEMA_SQL, writeKnowledgeImportPause } from './store.js';
import { KNOWLEDGE_LIMITS, KNOWLEDGE_STORAGE_TABLES, knowledgeHash, sha256, validateKnowledgeArchiveRow } from './validation.js';
import type { KnowledgeCandidate, KnowledgeGenerationEvidence, KnowledgeGenerationPlan, KnowledgeHostBinding, KnowledgeSourceManifest, KnowledgeStoragePorts, KnowledgeTarget, PrepareKnowledgeGeneration, SetWorkspaceTrust } from './types.js';

const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
const unknownUsage = { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null };
function fixture(t: TestContext, options: { ownerPort?: boolean } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-knowledge-'))), root = join(directory, 'workspace'), otherRoot = join(directory, 'other'), file = join(directory, 'knowledge.sqlite');
  mkdirSync(root); mkdirSync(otherRoot); writeFileSync(join(root, 'AGENTS.md'), 'Host-authored local instructions\n');
  let db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON; CREATE TABLE workspaces(id TEXT PRIMARY KEY)'); db.prepare('INSERT INTO workspaces VALUES(?)').run('workspace'); db.prepare('INSERT INTO workspaces VALUES(?)').run('other'); db.exec(KNOWLEDGE_SCHEMA_SQL);
  const databaseIdentity = lstatSync(file, { bigint: true }), storageBindingSha256 = sha256(`${file}:${databaseIdentity.dev}:${databaseIdentity.ino}`);
  const state = { now: Date.parse('2026-10-07T01:00:00.000Z'), sourceCurrent: true, targetCurrent: true, bindingSuffix: '', beforeSource: undefined as (() => void) | undefined, asyncSource: false, checkCount: 0 };
  const evidence = new Map<string, KnowledgeGenerationEvidence>();
  function binding(workspaceId = 'workspace'): KnowledgeHostBinding {
    const selected = workspaceId === 'workspace' ? root : workspaceId === 'other' ? otherRoot : (() => { throw new EngineError('WORKSPACE_NOT_FOUND', 'Authored fixture missing workspace'); })();
    const metadata = lstatSync(selected, { bigint: true });
    return { workspaceId, root: selected, rootDevice: metadata.dev.toString(), rootInode: metadata.ino.toString(), storageBindingSha256: state.bindingSuffix ? sha256(state.bindingSuffix) : storageBindingSha256 };
  }
  const ports: KnowledgeStoragePorts = {
    writeTx: operation => {
      if (db.isTransaction) return operation();
      db.exec('BEGIN IMMEDIATE');
      try { const result = operation(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    getWorkspace: id => ({ id, root: binding(id).root }), checkHostBinding: id => { state.checkCount++; return binding(id); },
    assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent,
    assertSourcesCurrent: (current, source) => {
      state.beforeSource?.();
      if (!state.sourceCurrent) throw new EngineError('KNOWLEDGE_SOURCE_CHANGED', 'Authored source was deleted or replaced');
      for (const pin of source.pins) if (pin.kind === 'file') {
        const currentFile = lstatSync(join(current.root, pin.path), { bigint: true }), text = readFileSync(join(current.root, pin.path), 'utf8');
        if (currentFile.dev.toString() !== pin.device || currentFile.ino.toString() !== pin.inode || sha256(text) !== pin.sha256) throw new EngineError('KNOWLEDGE_SOURCE_CHANGED', 'Authored exact file changed');
      }
      if (state.asyncSource) return Promise.resolve() as never;
    },
    assertTargetCurrent: () => { if (!state.targetCurrent) throw new EngineError('KNOWLEDGE_TARGET_CHANGED', 'Authored target CAS preimage changed'); },
    now: () => state.now,
    ...(options.ownerPort === false ? {} : { readGenerationEvidence: (_plan: KnowledgeGenerationPlan, id: string) => evidence.get(id) ?? (() => { throw new EngineError('KNOWLEDGE_GENERATION_OWNER_UNAVAILABLE', 'Native owner is not recorded'); })() }),
  };
  let store = new KnowledgeStorage(db, ports);
  const trustRequest = (overrides: Partial<SetWorkspaceTrust> = {}): SetWorkspaceTrust => ({ workspaceId: 'workspace', requestId: 'trust', expectedRevision: 0, decision: 'allow', binding: binding(), sources: captureWorkspaceTrustSources(binding(), ['AGENTS.md']), expiresAt: null, ...overrides });
  const source: KnowledgeSourceManifest = { projection: 'host-selected-text-v1', sha256: sha256('A completed, host-selected message.'), bytes: 35, pins: [{ kind: 'message', sessionId: 'source-session', runId: null, messageId: 'source-message', sha256: sha256('A completed, host-selected message.') }] };
  const target: KnowledgeTarget = { kind: 'workspace-document', key: 'project-memory', revision: 0, sha256: null };
  const planRequest = (overrides: Partial<PrepareKnowledgeGeneration> = {}): PrepareKnowledgeGeneration => ({ workspaceId: 'workspace', requestId: 'plan', binding: binding(), expectedTrustRevision: 1, source, target, providerId: 'fixture-provider', modelId: 'fixture-model', requestSha256: sha256('Exact authored tool-free request.'), requestBytes: 96, maxOutputBytes: 1_024, expiresAt: new Date(state.now + 60_000).toISOString(), ...overrides });
  const prepare = () => { store.setTrust(trustRequest()); return store.prepareGeneration(planRequest()); };
  function recordOwner(plan: KnowledgeGenerationPlan, body = 'Proposed project note from the authored native host owner.', ownerId = 'host-owner') {
    const value: KnowledgeGenerationEvidence = { ownerId, planId: plan.id, workspaceId: plan.workspaceId, bindingSha256: knowledgeHash(plan.binding), requestSha256: plan.requestSha256, providerId: plan.providerId, modelId: plan.modelId, outputSha256: sha256(body), outputBytes: Buffer.byteLength(body), toolCount: 0, completed: true, cleanupConfirmed: true, usage: { ...unknownUsage } }; evidence.set(ownerId, value); return value;
  }
  const append = () => { const plan = prepare(), owner = recordOwner(plan), handle = store.attachGenerationOwner(plan.workspaceId, plan.id, owner.ownerId), candidate = store.appendCandidate(handle, { requestId: 'candidate', body: 'Proposed project note from the authored native host owner.' }); return { plan, owner, handle, candidate }; };
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get db() { return db; }, get store() { return store; }, root, file, state, binding, ports, evidence, trustRequest, planRequest, prepare, recordOwner, append, reopen() { db.close(); db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON'); store = new KnowledgeStorage(db, ports); return store; } };
}

test('schema fragment installs only six workspace tables and makes no Session/Run or version claim', t => {
  const f = fixture(t), names = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  assert.deepEqual(names, [...KNOWLEDGE_STORAGE_TABLES, 'workspaces'].sort()); assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 0);
  const plan = f.prepare(); assert.equal(plan.state, 'pending'); assert.equal(plan.source.pins[0]!.kind, 'message'); assert.equal('runId' in plan, false); assert.equal('cleanupConfirmed' in plan, false);
});

test('trust CAS stores detached immutable exact source pins and historical revocations', t => {
  const f = fixture(t), input = structuredClone(f.trustRequest()), first = f.store.setTrust(input);
  (input.sources[0]! as { path: string }).path = 'caller-mutated.md';
  assert.equal(f.store.getTrust('workspace')!.sources[0]!.path, 'AGENTS.md'); assert.ok(Object.isFrozen(first) && Object.isFrozen(first.sources[0]));
  assert.throws(() => f.store.setTrust(f.trustRequest({ requestId: 'stale-cas' })), hasCode('KNOWLEDGE_REVISION_CONFLICT'));
  const denied = f.store.setTrust(f.trustRequest({ requestId: 'revoke', expectedRevision: 1, decision: 'deny', sources: [] }));
  assert.equal(denied.revision, 2); assert.equal(denied.previousId, first.id); assert.equal(f.store.getTrustRevision('workspace', first.id)!.decision, 'allow');
  assert.throws(() => f.store.assertTrusted('workspace', 1), hasCode('WORKSPACE_UNTRUSTED')); assert.throws(() => f.store.assertTrusted('workspace', 2), hasCode('WORKSPACE_UNTRUSTED'));
});

test('exact trust dedupe survives later revocation without restoring authority; input reuse conflicts', t => {
  const f = fixture(t), input = f.trustRequest(), first = f.store.setTrust(input);
  f.store.setTrust(f.trustRequest({ requestId: 'revoke', expectedRevision: 1, decision: 'deny', sources: [] }));
  assert.deepEqual(f.store.setTrust(input), first); assert.equal(f.store.getTrust('workspace')!.decision, 'deny');
  assert.throws(() => f.store.setTrust(f.trustRequest({ expiresAt: new Date(f.state.now + 60_000).toISOString() })), hasCode('KNOWLEDGE_REQUEST_CONFLICT'));
  assert.throws(() => f.store.prepareGeneration(f.planRequest({ requestId: 'trust' })), hasCode('KNOWLEDGE_REQUEST_CONFLICT'));
});

test('receipt write failure rolls back trust revision, head and dedupe together', t => {
  const f = fixture(t); f.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON knowledge_request_receipts BEGIN SELECT RAISE(ABORT,'authored receipt failure'); END");
  assert.throws(() => f.store.setTrust(f.trustRequest()), /authored receipt failure/); assert.equal(f.store.getTrust('workspace'), undefined);
  for (const table of ['workspace_trust_revisions', 'workspace_trust_heads', 'knowledge_request_receipts']) assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
});

test('generation plan pins exact host-selected source/target, request, budgets and current trust', t => {
  const f = fixture(t); f.store.setTrust(f.trustRequest()); const input = structuredClone(f.planRequest()), plan = f.store.prepareGeneration(input);
  (input.source.pins[0]! as { sha256: string }).sha256 = sha256('caller-mutation');
  assert.equal(plan.trustRevisionId, f.store.getTrust('workspace')!.id); assert.equal(plan.toolCount, 0); assert.equal(plan.source.pins[0]!.sha256, f.planRequest().source.pins[0]!.sha256);
  assert.deepEqual(f.store.prepareGeneration(f.planRequest()), plan); assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_generation_plans').get()!.n, 1);
  assert.throws(() => f.store.prepareGeneration(f.planRequest({ requestSha256: sha256('changed') })), hasCode('KNOWLEDGE_REQUEST_CONFLICT'));
});

test('untrusted workspace, expired grant and plan outliving its trust are rejected before plan write', t => {
  const f = fixture(t); assert.throws(() => f.store.prepareGeneration(f.planRequest()), hasCode('WORKSPACE_UNTRUSTED'));
  f.store.setTrust(f.trustRequest({ expiresAt: new Date(f.state.now + 10_000).toISOString() }));
  assert.throws(() => f.store.prepareGeneration(f.planRequest()), hasCode('INVALID_KNOWLEDGE'));
  f.state.now += 10_000; assert.throws(() => f.store.assertTrusted('workspace', 1), hasCode('KNOWLEDGE_EXPIRED'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_generation_plans').get()!.n, 0);
});

test('source deletion and target CAS changes are checked before generation and after owner capture', t => {
  const f = fixture(t); f.store.setTrust(f.trustRequest()); f.state.sourceCurrent = false;
  assert.throws(() => f.store.prepareGeneration(f.planRequest()), hasCode('KNOWLEDGE_SOURCE_CHANGED')); f.state.sourceCurrent = true; f.state.targetCurrent = false;
  assert.throws(() => f.store.prepareGeneration(f.planRequest()), hasCode('KNOWLEDGE_TARGET_CHANGED')); f.state.targetCurrent = true;
  const plan = f.store.prepareGeneration(f.planRequest()); f.recordOwner(plan); const handle = f.store.attachGenerationOwner('workspace', plan.id, 'host-owner'); f.state.sourceCurrent = false;
  assert.throws(() => f.store.appendCandidate(handle, { requestId: 'candidate', body: 'Proposed project note from the authored native host owner.' }), hasCode('KNOWLEDGE_SOURCE_CHANGED'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_candidates').get()!.n, 0);
});

test('actual repository file source bytes must remain pinned across host owner capture', t => {
  const f = fixture(t), filename = join(f.root, 'source.ts'); writeFileSync(filename, 'export const value = 1;\n'); const metadata = lstatSync(filename, { bigint: true }), body = readFileSync(filename, 'utf8');
  f.store.setTrust(f.trustRequest()); const source: KnowledgeSourceManifest = { projection: 'host-selected-text-v1', sha256: sha256(body), bytes: Buffer.byteLength(body), pins: [{ kind: 'file', path: 'source.ts', sha256: sha256(body), bytes: Buffer.byteLength(body), device: metadata.dev.toString(), inode: metadata.ino.toString() }] };
  const plan = f.store.prepareGeneration(f.planRequest({ source })); f.recordOwner(plan); writeFileSync(filename, 'export const value = 2;\n');
  assert.throws(() => f.store.attachGenerationOwner('workspace', plan.id, 'host-owner'), hasCode('KNOWLEDGE_SOURCE_CHANGED'));
});

test('missing native host owner integration cannot fabricate a completed candidate', t => {
  const f = fixture(t, { ownerPort: false }), plan = f.prepare();
  assert.throws(() => f.store.attachGenerationOwner('workspace', plan.id, 'fabricated-owner'), hasCode('KNOWLEDGE_GENERATION_OWNER_UNAVAILABLE'));
  assert.throws(() => f.store.appendCandidate({ planId: plan.id, ownerId: 'fabricated-owner' }, { requestId: 'candidate', body: 'Fabricated body' }), hasCode('KNOWLEDGE_GENERATION_HANDLE_INVALID'));
});

test('only the same live instance-owned opaque handle can append owner-provenance output', t => {
  const f = fixture(t), plan = f.prepare(); f.recordOwner(plan); const handle = f.store.attachGenerationOwner('workspace', plan.id, 'host-owner'), peer = new KnowledgeStorage(f.db, f.ports);
  const append = { requestId: 'candidate', body: 'Proposed project note from the authored native host owner.' };
  for (const forged of [{ ...handle }, new Proxy(handle, {})]) assert.throws(() => f.store.appendCandidate(forged, append), hasCode('KNOWLEDGE_GENERATION_HANDLE_INVALID'));
  assert.throws(() => peer.appendCandidate(handle, append), hasCode('KNOWLEDGE_GENERATION_HANDLE_INVALID'));
  f.store.releaseGenerationOwner(handle); assert.throws(() => f.store.appendCandidate(handle, append), hasCode('KNOWLEDGE_GENERATION_HANDLE_INVALID'));
});

for (const mismatch of ['owner', 'workspace', 'plan', 'binding', 'request', 'provider', 'model', 'tool', 'cleanup', 'complete', 'usage'] as const) test(`native host generation evidence rejects ${mismatch} mismatch`, t => {
  const f = fixture(t), plan = f.prepare(), original = f.recordOwner(plan), wrong = { ...original } as Record<string, unknown>;
  const changes: Record<typeof mismatch, Record<string, unknown>> = { owner: { ownerId: 'foreign-owner' }, workspace: { workspaceId: 'other' }, plan: { planId: 'other-plan' }, binding: { bindingSha256: sha256('other') }, request: { requestSha256: sha256('other') }, provider: { providerId: 'other' }, model: { modelId: 'other' }, tool: { toolCount: 1 }, cleanup: { cleanupConfirmed: false }, complete: { completed: false }, usage: { usage: { ...unknownUsage, inputTokens: 1, cachedInputTokens: 2 } } };
  f.evidence.set(original.ownerId, { ...wrong, ...changes[mismatch] } as unknown as KnowledgeGenerationEvidence);
  assert.throws(() => f.store.attachGenerationOwner('workspace', plan.id, original.ownerId)); assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_candidates').get()!.n, 0);
});

test('candidate is immutable pending data; unknown usage stays null and exact replay never duplicates output', t => {
  const f = fixture(t), result = f.append(), { candidate, handle } = result;
  assert.equal(candidate.state, 'pending'); assert.deepEqual(candidate.usage, unknownUsage); assert.equal(candidate.cleanupConfirmed, true); assert.ok(Object.isFrozen(candidate) && Object.isFrozen(candidate.source.pins[0]));
  assert.deepEqual(f.store.appendCandidate(handle, { requestId: 'candidate', body: candidate.body }), candidate);
  assert.throws(() => f.store.appendCandidate(handle, { requestId: 'candidate', body: candidate.body + 'changed' }), hasCode('KNOWLEDGE_REQUEST_CONFLICT'));
  assert.throws(() => f.store.appendCandidate(handle, { requestId: 'different-request', body: candidate.body }), hasCode('KNOWLEDGE_RECORD_CONFLICT'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_candidates').get()!.n, 1); assert.equal('publicationId' in candidate, false);
});

test('body replacement, caller-supplied provenance and changed native owner observations cannot append', t => {
  const f = fixture(t), plan = f.prepare(), owner = f.recordOwner(plan), handle = f.store.attachGenerationOwner('workspace', plan.id, owner.ownerId);
  assert.throws(() => f.store.appendCandidate(handle, { requestId: 'wrong-body', body: 'Different caller text' }), hasCode('KNOWLEDGE_GENERATION_BINDING_MISMATCH'));
  assert.throws(() => f.store.appendCandidate(handle, { requestId: 'extra-authority', body: 'test', usage: { inputTokens: 0 } } as never), hasCode('INVALID_KNOWLEDGE'));
  f.evidence.set(owner.ownerId, { ...owner, usage: { ...unknownUsage, inputTokens: 7 } });
  assert.throws(() => f.store.appendCandidate(handle, { requestId: 'changed-owner', body: 'Proposed project note from the authored native host owner.' }), hasCode('KNOWLEDGE_GENERATION_BINDING_MISMATCH'));
});

test('trust revoke and physical storage binding changes invalidate old handles without deleting evidence', t => {
  const f = fixture(t), { candidate, handle } = f.append(); f.store.setTrust(f.trustRequest({ requestId: 'revoke', expectedRevision: 1, decision: 'deny', sources: [] }));
  assert.equal(f.store.getCandidate('workspace', candidate.id)!.body, candidate.body);
  f.state.bindingSuffix = 'replacement-storage'; assert.throws(() => f.store.appendCandidate(handle, { requestId: 'candidate', body: candidate.body }), hasCode('KNOWLEDGE_BINDING_MISMATCH'));
});

test('plan expiry crossed inside a host freshness callback cannot create a late plan', t => {
  const f = fixture(t); f.store.setTrust(f.trustRequest()); const request = f.planRequest(); f.state.beforeSource = () => { f.state.now += 60_000; };
  assert.throws(() => f.store.prepareGeneration(request), hasCode('KNOWLEDGE_EXPIRED')); assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_generation_plans').get()!.n, 0);
});

test('asynchronous freshness port is rejected and the host transaction rolls back', t => {
  const f = fixture(t); f.store.setTrust(f.trustRequest()); f.state.asyncSource = true;
  assert.throws(() => f.store.prepareGeneration(f.planRequest()), hasCode('KNOWLEDGE_ASYNC_PORT')); assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_generation_plans').get()!.n, 0);
});

test('store refuses writes when the injected transaction does not own this connection', t => {
  const f = fixture(t), peer = new KnowledgeStorage(f.db, { ...f.ports, writeTx: operation => operation() });
  assert.throws(() => peer.setTrust(f.trustRequest()), hasCode('KNOWLEDGE_TRANSACTION_REQUIRED')); assert.equal(f.store.getTrust('workspace'), undefined);
});

test('restart preserves exact plans/candidates/receipts but grants no resumable opaque owner handle', t => {
  const f = fixture(t), { plan, candidate, handle } = f.append(), replacement = f.reopen();
  assert.deepEqual(replacement.getCandidate('workspace', candidate.id), candidate); assert.deepEqual(replacement.getGenerationPlan('workspace', plan.id), plan);
  assert.throws(() => replacement.appendCandidate(handle, { requestId: 'candidate', body: candidate.body }), hasCode('KNOWLEDGE_GENERATION_HANDLE_INVALID'));
  const reattached = replacement.attachGenerationOwner('workspace', plan.id, 'host-owner'); assert.deepEqual(replacement.appendCandidate(reattached, { requestId: 'candidate', body: candidate.body }), candidate);
});

test('candidate receipt failure rolls back the candidate and remains retryable under the same owner', t => {
  const f = fixture(t), plan = f.prepare(); f.recordOwner(plan); const handle = f.store.attachGenerationOwner('workspace', plan.id, 'host-owner');
  f.db.exec("CREATE TRIGGER reject_candidate_receipt BEFORE INSERT ON knowledge_request_receipts WHEN json_extract(NEW.data,'$.operation')='append-candidate' BEGIN SELECT RAISE(ABORT,'authored candidate receipt failure'); END");
  const input = { requestId: 'candidate', body: 'Proposed project note from the authored native host owner.' }; assert.throws(() => f.store.appendCandidate(handle, input), /authored candidate receipt failure/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_candidates').get()!.n, 0); f.db.exec('DROP TRIGGER reject_candidate_receipt'); assert.equal(f.store.appendCandidate(handle, input).state, 'pending');
});

test('archive row validation detects mutated hashes, scopes and active state without granting import authority', t => {
  const f = fixture(t), { candidate } = f.append(), row = validateKnowledgeArchiveRow({ table: 'knowledge_candidates', key: candidate.id, workspaceId: 'workspace', data: candidate });
  assert.throws(() => validateKnowledgeArchiveRow({ ...row, workspaceId: 'other' }), hasCode('KNOWLEDGE_SCOPE_MISMATCH'));
  assert.throws(() => validateKnowledgeArchiveRow({ ...row, data: { ...row.data, body: 'Modified imported text' } }), hasCode('KNOWLEDGE_HASH_MISMATCH'));
  assert.throws(() => validateKnowledgeArchiveRow({ ...row, data: { ...row.data, state: 'active' } }), hasCode('INVALID_KNOWLEDGE'));
  assert.throws(() => validateKnowledgeArchiveRow({ ...row, table: 'runs' }), hasCode('INVALID_KNOWLEDGE'));
});

test('import pause survives restart; records remain inspectable and new plans/owner captures are blocked', t => {
  const f = fixture(t), { candidate, plan } = f.append(), pause = writeKnowledgeImportPause(f.db, 'workspace', sha256('authored archive'), new Date(f.state.now).toISOString());
  assert.equal(f.db.prepare('SELECT data FROM knowledge_import_pauses WHERE id=?').get('workspace')!.data, JSON.stringify(pause)); assert.equal(pause.state, 'paused');
  const replacement = f.reopen(); assert.equal(replacement.isImportPaused('workspace'), true); assert.deepEqual(replacement.getCandidate('workspace', candidate.id), candidate);
  assert.throws(() => replacement.attachGenerationOwner('workspace', plan.id, 'host-owner'), hasCode('KNOWLEDGE_IMPORT_PAUSED'));
  assert.throws(() => replacement.prepareGeneration(f.planRequest({ requestId: 'after-import' })), hasCode('KNOWLEDGE_IMPORT_PAUSED'));
});

test('import pause participates in an existing import owner transaction without nested BEGIN or rebinding', t => {
  const f = fixture(t); f.prepare(); f.db.exec('BEGIN IMMEDIATE'); writeKnowledgeImportPause(f.db, 'workspace', sha256('archive'), new Date(f.state.now).toISOString()); assert.equal(f.store.isImportPaused('workspace'), true);
  f.db.exec('ROLLBACK'); assert.equal(f.store.isImportPaused('workspace'), false);
  assert.equal(f.store.getTrust('workspace')!.binding.storageBindingSha256, f.binding().storageBindingSha256);
});

test('input JSON rejects getters, proxies, cycles, sparse arrays, oversized sources, unknown usage and unsafe target paths', t => {
  const f = fixture(t), input = f.trustRequest(); let observed = 0;
  const getter = { ...input }; Object.defineProperty(getter, 'requestId', { get() { observed++; return 'side-effect'; }, enumerable: true });
  assert.throws(() => f.store.setTrust(getter), hasCode('INVALID_KNOWLEDGE')); assert.equal(observed, 0); assert.throws(() => f.store.setTrust(new Proxy(input, {})), hasCode('INVALID_KNOWLEDGE'));
  assert.throws(() => f.store.setTrust({ ...input, sources: new Array(2) }), hasCode('KNOWLEDGE_LIMIT'));
  const cycle: Record<string, unknown> = { ...input }; cycle.extra = cycle; assert.throws(() => f.store.setTrust(cycle as unknown as SetWorkspaceTrust), hasCode('INVALID_KNOWLEDGE'));
  f.store.setTrust(input); assert.throws(() => f.store.prepareGeneration(f.planRequest({ source: { ...f.planRequest().source, pins: Array.from({ length: 65 }, (_, index) => ({ kind: 'message' as const, sessionId: 's', runId: null, messageId: `${index}`, sha256: sha256('x') })) } })), hasCode('INVALID_KNOWLEDGE'));
  assert.throws(() => f.store.prepareGeneration(f.planRequest({ target: { kind: 'workspace-file', path: '../outside.md', revision: 0, sha256: null, device: null, inode: null } })), hasCode('INVALID_KNOWLEDGE_PATH'));
});

test('generation owner handle cap can only be reclaimed by releasing original live handles', t => {
  const f = fixture(t), plan = f.prepare(); f.recordOwner(plan); const handles = Array.from({ length: KNOWLEDGE_LIMITS.handles }, () => f.store.attachGenerationOwner('workspace', plan.id, 'host-owner'));
  assert.throws(() => f.store.attachGenerationOwner('workspace', plan.id, 'host-owner'), hasCode('KNOWLEDGE_LIMIT')); f.store.releaseGenerationOwner(handles[0]!); assert.ok(f.store.attachGenerationOwner('workspace', plan.id, 'host-owner'));
});

test('stored candidate body corruption is rejected when inspected after restart', t => {
  const f = fixture(t), { candidate } = f.append(), corrupted: KnowledgeCandidate = { ...candidate, body: 'Unhashed changed SQLite record' };
  f.db.prepare('UPDATE knowledge_candidates SET data=? WHERE id=?').run(JSON.stringify(corrupted), candidate.id); f.reopen(); assert.throws(() => f.store.getCandidate('workspace', candidate.id), hasCode('KNOWLEDGE_HASH_MISMATCH'));
});

test('16KiB output cap accepts exact native bytes and rejects larger output without a candidate effect', t => {
  const f = fixture(t); f.store.setTrust(f.trustRequest()); const plan = f.store.prepareGeneration(f.planRequest({ maxOutputBytes: KNOWLEDGE_LIMITS.bodyBytes })), body = 'x'.repeat(KNOWLEDGE_LIMITS.bodyBytes); f.recordOwner(plan, body);
  const handle = f.store.attachGenerationOwner('workspace', plan.id, 'host-owner'); assert.throws(() => f.store.appendCandidate(handle, { requestId: 'oversize', body: body + 'x' }), hasCode('KNOWLEDGE_LIMIT'));
  const candidate = f.store.appendCandidate(handle, { requestId: 'cap', body }); assert.equal(Buffer.byteLength(candidate.body), KNOWLEDGE_LIMITS.bodyBytes);
  assert.throws(() => f.store.prepareGeneration(f.planRequest({ requestId: 'invalid-output-cap', maxOutputBytes: KNOWLEDGE_LIMITS.bodyBytes + 1 })), hasCode('INVALID_KNOWLEDGE'));
});

test('target changes after owner attachment block append; another workspace cannot inspect or attach its records', t => {
  const f = fixture(t), plan = f.prepare(); f.recordOwner(plan); const handle = f.store.attachGenerationOwner('workspace', plan.id, 'host-owner'); f.state.targetCurrent = false;
  assert.throws(() => f.store.appendCandidate(handle, { requestId: 'candidate', body: 'Proposed project note from the authored native host owner.' }), hasCode('KNOWLEDGE_TARGET_CHANGED'));
  assert.equal(f.store.getGenerationPlan('other', plan.id), undefined); assert.throws(() => f.store.attachGenerationOwner('other', plan.id, 'host-owner'), hasCode('KNOWLEDGE_NOT_FOUND')); assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_candidates').get()!.n, 0);
});

test('trust capture changing during source checks aborts the whole transaction instead of publishing a stale plan', t => {
  const f = fixture(t); f.store.setTrust(f.trustRequest()); f.state.beforeSource = () => { f.state.beforeSource = undefined; f.store.setTrust(f.trustRequest({ requestId: 'reentrant-revoke', expectedRevision: 1, decision: 'deny', sources: [] })); };
  assert.throws(() => f.store.prepareGeneration(f.planRequest()), hasCode('WORKSPACE_UNTRUSTED')); assert.equal(f.db.prepare('SELECT count(*) AS n FROM knowledge_generation_plans').get()!.n, 0); assert.equal(f.store.getTrust('workspace')!.revision, 1);
});

test('undefined usage and malicious sparse-array properties never masquerade as nullable owner data', t => {
  const f = fixture(t), plan = f.prepare(), evidence = f.recordOwner(plan); f.evidence.set(evidence.ownerId, { ...evidence, usage: { ...unknownUsage, inputTokens: undefined } } as never);
  assert.throws(() => f.store.attachGenerationOwner('workspace', plan.id, evidence.ownerId), hasCode('INVALID_KNOWLEDGE'));
  const sparse: unknown[] = new Array(1); Object.defineProperty(sparse, 'unexpected', { value: 'not-an-index', enumerable: true }); assert.throws(() => f.store.setTrust({ ...f.trustRequest(), requestId: 'sparse', sources: sparse } as never), hasCode('KNOWLEDGE_LIMIT'));
});
