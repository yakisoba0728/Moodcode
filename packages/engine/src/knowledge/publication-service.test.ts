import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { ScriptedProvider } from '../provider/scripted.js';
import { assertPhysicalKnowledgeRoot, assertWorkspaceTrustSourcesCurrent, captureWorkspaceTrustSources } from '../workspace/trust.js';
import { KnowledgeStorage, KNOWLEDGE_SCHEMA_SQL } from './store.js';
import { KnowledgeHostAdapter } from './host.js';
import { KnowledgeGenerationStorage, KNOWLEDGE_GENERATION_SCHEMA_SQL } from './generation-store.js';
import { KnowledgeGenerationService } from './generation-service.js';
import { KnowledgePublicationStorage, KNOWLEDGE_PUBLICATION_SCHEMA_SQL } from './publication-store.js';
import { KnowledgePublicationService, type KnowledgePublicationPreview, type KnowledgePublicationServicePorts } from './publication-service.js';
import type { KnowledgeCandidate, KnowledgeHostBinding } from './types.js';
import { sha256 } from './validation.js';

const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: TestContext, options: { markerFailure?: boolean; fileTarget?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-publication-service-'))), root = join(base, 'repository');
  mkdirSync(root); execFileSync('git', ['init', '--quiet', '--template=', root]);
  writeFileSync(join(root, 'AGENTS.md'), 'Host reviewed project instructions.\n'); writeFileSync(join(root, 'source.ts'), 'export const selected = 1;\n');
  const dbPath = join(base, 'native.sqlite'), db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE workspaces(id TEXT PRIMARY KEY,root TEXT NOT NULL)'); db.prepare('INSERT INTO workspaces VALUES(?,?)').run('workspace', root);
  db.exec(KNOWLEDGE_SCHEMA_SQL + KNOWLEDGE_GENERATION_SCHEMA_SQL + KNOWLEDGE_PUBLICATION_SCHEMA_SQL);
  t.after(() => { db.close(); rmSync(base, { recursive: true, force: true }); });
  const state = { leaseCalls: 0, sourceChecks: 0, now: Date.now(), bindingSuffix: '', beforeLease: undefined as (() => Promise<void> | void) | undefined,
    beforeCommit: undefined as (() => void) | undefined, afterCommit: undefined as (() => void) | undefined, sourceHook: undefined as (() => void) | undefined };
  const binding = (): KnowledgeHostBinding => {
    const stat = lstatSync(root, { bigint: true });
    return { workspaceId: 'workspace', root, rootDevice: stat.dev.toString(), rootInode: stat.ino.toString(), storageBindingSha256: sha256(dbPath + state.bindingSuffix) };
  };
  const workspace = (id: string) => { assert.equal(id, 'workspace'); return { id, root }; };
  const tx = <T>(operation: () => T): T => {
    if (db.isTransaction) return operation(); db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  let native: KnowledgeGenerationStorage, publications: KnowledgePublicationStorage, service: KnowledgePublicationService;
  const host = new KnowledgeHostAdapter(db, { readTx: tx, getWorkspace: workspace, checkHostBinding: () => binding(), readWorkspaceDocumentTarget: (_bound, key) => publications.captureDocumentTarget('workspace', key) });
  const knowledge = new KnowledgeStorage(db, { writeTx: tx, getWorkspace: workspace, checkHostBinding: () => binding(), assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent,
    assertSourcesCurrent: (bound, source) => host.assertSourcesCurrent(bound, source), assertTargetCurrent: (bound, target) => host.assertTargetCurrent(bound, target),
    readGenerationEvidence: (plan, owner) => native.readEvidence(plan, owner) });
  native = new KnowledgeGenerationStorage(db, { writeTx: tx, getWorkspace: workspace, getPlan: (ws, id) => knowledge.getGenerationPlan(ws, id), checkBinding: () => binding(), assertPlanCurrent: plan => knowledge.assertGenerationPlanCurrent(plan) });
  publications = new KnowledgePublicationStorage(db, { writeTx: tx, getWorkspace: workspace, checkBinding: () => binding(), getCandidate: (ws, id) => knowledge.getCandidate(ws, id),
    assertCommitCurrent: record => { state.beforeCommit?.(); service.assertCommitCurrent(record); }, now: () => state.now });
  const originalCommit = publications.commit.bind(publications);
  // The seam observes the actual returned native commit; it cannot manufacture a positive row.
  const nativePort = { findRequest: publications.findRequest.bind(publications), prepare: publications.prepare.bind(publications),
    commit: (capture: Parameters<KnowledgePublicationStorage['commit']>[0]) => { const result = originalCommit(capture); state.afterCommit?.(); return result; },
    cancel: publications.cancel.bind(publications), release: publications.release.bind(publications), getPublication: publications.getPublication.bind(publications),
    getDocumentHead: publications.getDocumentHead.bind(publications), getDocumentRevision: publications.getDocumentRevision.bind(publications), getCommitted: publications.getCommitted.bind(publications) };
  const ports: KnowledgePublicationServicePorts = { native: nativePort, getCandidate: (ws, id) => knowledge.getCandidate(ws, id), getPlan: (ws, id) => knowledge.getGenerationPlan(ws, id),
    getGeneration: native.getGeneration.bind(native), getAttempt: native.getAttempt.bind(native), getTrust: ws => knowledge.getTrust(ws), getTrustRevision: (ws, id) => knowledge.getTrustRevision(ws, id),
    checkBinding: () => { const bound = binding(); assertPhysicalKnowledgeRoot(bound); return bound; }, assertUnpaused: ws => knowledge.assertUnpaused(ws),
    assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent, assertSourcesCurrent: (bound, source) => { state.sourceChecks++; state.sourceHook?.(); host.assertSourcesCurrent(bound, source); },
    withLease: async (_ws, operation) => { state.leaseCalls++; await state.beforeLease?.(); return operation(new AbortController().signal); }, now: () => state.now };
  service = new KnowledgePublicationService(ports);
  knowledge.setTrust({ workspaceId: 'workspace', requestId: 'allow', expectedRevision: 0, decision: 'allow', binding: binding(), sources: captureWorkspaceTrustSources(binding(), ['AGENTS.md']), expiresAt: null });
  const provider = new ScriptedProvider([], Array.from({ length: 12 }, (_, index) => ({ events: [{ type: 'text.delta' as const, delta: `Actual native project note ${index + 1}.\n` }, { type: 'usage' as const, inputTokens: 7, outputTokens: 3 }, { type: 'finish' as const, reason: 'stop' as const }] })));
  const generation = new KnowledgeGenerationService({ native, knowledge, host, provider: () => provider, assertPlanCurrent: plan => knowledge.assertGenerationPlanCurrent(plan), withLease: async (_ws, operation) => operation(new AbortController().signal) });
  if (options.markerFailure) db.exec(`CREATE TRIGGER fail_marker BEFORE UPDATE ON knowledge_generations WHEN json_extract(NEW.data,'$.candidate.state')='recorded' BEGIN SELECT RAISE(ABORT,'Actual marker failure'); END;`);
  async function candidate(file = false): Promise<KnowledgeCandidate> {
    const projection = host.captureSources({ workspaceId: 'workspace', selection: [{ kind: 'file', path: 'source.ts' }] }), modelId = 'fixture-model';
    const built = (await import('./generation-request.js')).buildKnowledgeGenerationRequest({ providerId: provider.id, modelId, source: projection });
    const plan = knowledge.prepareGeneration({ workspaceId: 'workspace', requestId: randomUUID(), binding: binding(), expectedTrustRevision: knowledge.getTrust('workspace')!.revision,
      source: projection.manifest, target: file ? host.captureFileTarget('workspace', 'MEMORY.md') : publications.captureDocumentTarget('workspace', 'project-memory'), providerId: provider.id, modelId,
      requestSha256: built.requestSha256, requestBytes: built.requestBytes, maxOutputBytes: 1024, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const result = await generation.generate({ workspaceId: 'workspace', planId: plan.id, requestId: randomUUID(), projection });
    assert.equal(result.generation.state, 'completed'); host.releaseProjection(projection);
    return knowledge.getCandidateByGeneration('workspace', result.generation.id)!;
  }
  const first = await candidate(options.fileTarget);
  return { db, root, state, service, ports, native, publications, knowledge, provider, candidate, first, binding,
    preview: () => service.previewPublish({ workspaceId: 'workspace', candidateId: first.id }),
    counts: () => ['knowledge_publications', 'workspace_document_revisions', 'workspace_document_heads', 'knowledge_publication_receipts'].map(table => db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count) };
}
function approved(preview: KnowledgePublicationPreview, requestId: string = randomUUID()) { return { workspaceId: 'workspace', requestId, approved: true as const, preview }; }

test('original frozen full preview commits exact document and same request observes history before changed-head/source freshness or lease', async t => {
  const f = await fixture(t), preview = f.preview(), input = approved(preview);
  assert.ok(Object.isFrozen(preview)); assert.ok(Object.isFrozen(preview.candidate)); assert.ok(Object.isFrozen(preview.document)); assert.ok(Object.isFrozen(preview.pins.provenance));
  assert.equal(preview.diff.before, ''); assert.equal(preview.diff.after, f.first.body);
  const result = await f.service.publish(input); assert.equal(result.document.body, f.first.body); assert.equal(result.document.revision, 1); assert.equal(result.duplicate, false);
  writeFileSync(join(f.root, 'source.ts'), 'export const changed = 2;\n'); const calls = f.state.leaseCalls;
  const duplicate = await f.service.publish(input); assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.receipt, result.receipt); assert.equal(f.state.leaseCalls, calls);
  assert.deepEqual(f.counts(), [1, 1, 1, 1]); assert.equal(f.provider.generationCallCount, 1); assert.equal(f.provider.callCount, 0);
  await assert.rejects(f.service.publish(approved(preview)), code('KNOWLEDGE_PUBLICATION_PREVIEW_USED'));
});

test('copy/foreign/released/false operation approval and hostile top/nested getters or proxies produce zero SQL effects and traps', async t => {
  const f = await fixture(t), preview = f.preview(), other = new KnowledgePublicationService(f.ports); let traps = 0;
  const cloned = { ...preview }, proxy = new Proxy(preview, { get() { traps++; throw new Error('trap'); }, getOwnPropertyDescriptor() { traps++; throw new Error('trap'); } });
  const input = approved(preview), accessor = { ...input }; Object.defineProperty(accessor, 'approved', { enumerable: true, get() { traps++; return true; } });
  const budget = Object.defineProperty({}, 'maxDurationMs', { enumerable: true, get() { traps++; return 5000; } });
  const budgetProxy = new Proxy({}, { get() { traps++; throw new Error('trap'); }, ownKeys() { traps++; throw new Error('trap'); } });
  for (const value of [approved(cloned), approved(proxy), accessor, { ...input, budget }, { ...input, budget: budgetProxy }, { ...input, approved: false }])
    await assert.rejects(f.service.publish(value as Parameters<KnowledgePublicationService['publish']>[0]), error => error instanceof EngineError);
  await assert.rejects(other.publish(input), code('KNOWLEDGE_PUBLICATION_PREVIEW_INVALID'));
  await assert.rejects(f.service.revoke(input), code('KNOWLEDGE_PUBLICATION_PREVIEW_INVALID'));
  f.service.releasePreview(preview); await assert.rejects(f.service.publish(input), code('KNOWLEDGE_PUBLICATION_PREVIEW_INVALID'));
  assert.equal(traps, 0); assert.equal(f.state.leaseCalls, 0); assert.deepEqual(f.counts(), [0, 0, 0, 0]);
});

test('ordinary mutable input and budget are detached synchronously before deferred lease entry', async t => {
  const f = await fixture(t), wait = gate(); f.state.beforeLease = () => wait.promise;
  const input = { ...approved(f.preview(), 'original-request'), budget: { maxDurationMs: 5000 } }, pending = f.service.publish(input);
  input.requestId = 'changed-request'; input.workspaceId = 'changed-workspace'; input.budget.maxDurationMs = 0; wait.resolve();
  const result = await pending; assert.equal(result.receipt.requestId, 'original-request'); assert.equal(result.document.workspaceId, 'workspace'); assert.deepEqual(f.counts(), [1, 1, 1, 1]);
});

test('actual signals with overridden accessors and proxy signals are rejected before cancellation traps or native effects', async t => {
  const f = await fixture(t), preview = f.preview(); let traps = 0;
  const overridden = new AbortController().signal;
  Object.defineProperty(overridden, 'aborted', { get() { traps++; return false; } });
  const proxy = new Proxy(new AbortController().signal, { get() { traps++; throw new Error('trap'); }, getPrototypeOf() { traps++; throw new Error('trap'); } });
  const shadowed = Object.defineProperty(new AbortController().signal, 'throwIfAborted', { value: () => undefined });
  for (const signal of [overridden, proxy, Object.create(AbortSignal.prototype) as AbortSignal, shadowed]) await assert.rejects(f.service.publish({ ...approved(preview), signal }), code('INVALID_KNOWLEDGE_PUBLICATION'));
  assert.equal(traps, 0); assert.deepEqual(f.counts(), [0, 0, 0, 0]); assert.equal(f.state.leaseCalls, 0);
});

test('source/trust/binding/document changes while lease is pending are revalidated before any publication intent', async t => {
  for (const mode of ['source', 'trust', 'binding'] as const) {
    const f = await fixture(t), wait = gate(); f.state.beforeLease = () => wait.promise;
    const pending = f.service.publish(approved(f.preview())); void pending.catch(() => {});
    if (mode === 'source') writeFileSync(join(f.root, 'source.ts'), 'export const changed = 3;\n');
    if (mode === 'trust') f.knowledge.setTrust({ workspaceId: 'workspace', requestId: 'deny', expectedRevision: 1, decision: 'deny', binding: f.binding(), sources: [], expiresAt: null });
    if (mode === 'binding') f.state.bindingSuffix = 'relocated';
    wait.resolve(); await assert.rejects(pending, error => error instanceof EngineError); assert.deepEqual(f.counts(), [0, 0, 0, 0]);
  }
});

test('actual native callback sees current source again inside commit TX and cancels prepared owner on changed source', async t => {
  const f = await fixture(t), preview = f.preview(); f.state.beforeCommit = () => writeFileSync(join(f.root, 'source.ts'), 'export const changedAtCommit = 4;\n');
  await assert.rejects(f.service.publish(approved(preview)), code('KNOWLEDGE_SOURCE_CHANGED'));
  assert.deepEqual(f.counts(), [1, 0, 0, 0]); const record = JSON.parse(f.db.prepare('SELECT data FROM knowledge_publications').get()!.data as string) as { state: string; errorCode: string };
  assert.equal(record.state, 'cancelled'); assert.equal(record.errorCode, 'KNOWLEDGE_SOURCE_CHANGED');
});

test('abort before lease completion returns promptly and late callback cannot create durable intent', async t => {
  const f = await fixture(t), wait = gate(), abort = new AbortController(); f.state.beforeLease = () => wait.promise;
  const pending = f.service.publish({ ...approved(f.preview()), signal: abort.signal }); abort.abort();
  await assert.rejects(pending, code('KNOWLEDGE_PUBLICATION_CANCELLED')); assert.deepEqual(f.counts(), [0, 0, 0, 0]);
  wait.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(f.counts(), [0, 0, 0, 0]);
});

test('original operation duration bounds a stalled lease and late callback without renewing preview expiry', async t => {
  const f = await fixture(t), wait = gate(), preview = f.preview(); f.state.beforeLease = () => wait.promise;
  await assert.rejects(f.service.publish({ ...approved(preview), budget: { maxDurationMs: 5 } }), code('KNOWLEDGE_PUBLICATION_DEADLINE'));
  assert.deepEqual(f.counts(), [0, 0, 0, 0]); wait.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(f.counts(), [0, 0, 0, 0]);
  assert.equal(preview.expiresAt, preview.pins.expiresAt); await assert.rejects(f.service.publish(approved(preview)), code('KNOWLEDGE_PUBLICATION_PREVIEW_USED'));
});

test('abort observed after real native SQL COMMIT preserves the original applied receipt', async t => {
  const f = await fixture(t), abort = new AbortController(); f.state.afterCommit = () => abort.abort();
  const result = await f.service.publish({ ...approved(f.preview()), signal: abort.signal });
  assert.equal(result.publication.state, 'completed'); assert.equal(result.document.body, f.first.body); assert.deepEqual(f.counts(), [1, 1, 1, 1]);
});

test('actual update increments document revision, stale original preview fails, revoke permits newer trust denial and stale selected source', async t => {
  const f = await fixture(t), first = await f.service.publish(approved(f.preview()));
  const candidate = await f.candidate(), preview = f.service.previewPublish({ workspaceId: 'workspace', candidateId: candidate.id });
  assert.equal(preview.diff.before, first.document.body); assert.equal(preview.pins.expectedHeadRevision, 1);
  const update = await f.service.publish(approved(preview)); assert.equal(update.document.revision, 2); assert.equal(update.document.previousRevisionId, first.document.id);
  const revoke = f.service.previewRevoke({ workspaceId: 'workspace', publicationId: update.publication.id });
  writeFileSync(join(f.root, 'source.ts'), 'export const historicalSource = 5;\n');
  f.knowledge.setTrust({ workspaceId: 'workspace', requestId: 'deny-after-publish', expectedRevision: 1, decision: 'deny', binding: f.binding(), sources: [], expiresAt: null });
  const result = await f.service.revoke(approved(revoke)); assert.equal(result.document.revision, 3); assert.equal(result.document.status, 'revoked'); assert.equal(result.document.body, ''); assert.equal(result.document.bodySha256, sha256(''));
  assert.equal(f.publications.captureDocumentTarget('workspace', 'project-memory').revision, 3);
  assert.equal(f.provider.generationCallCount, 2); assert.equal(f.provider.callCount, 0);
});

test('actual competing publication invalidates another original head preview and revoked head never restores revision zero', async t => {
  const f = await fixture(t), second = await f.candidate(), stale = f.preview(), current = f.service.previewPublish({ workspaceId: 'workspace', candidateId: second.id });
  const published = await f.service.publish(approved(current)); await assert.rejects(f.service.publish(approved(stale)), code('KNOWLEDGE_PUBLICATION_STALE'));
  const revoke = f.service.previewRevoke({ workspaceId: 'workspace', publicationId: published.publication.id });
  await f.service.revoke(approved(revoke)); await assert.rejects(f.service.revoke(approved(revoke)), code('KNOWLEDGE_PUBLICATION_PREVIEW_USED'));
  assert.equal(f.publications.captureDocumentTarget('workspace', 'project-memory').revision, 2);
  assert.deepEqual(f.counts(), [2, 2, 1, 2]);
});

test('file-target publication remains typed unsupported and creates no document or publication records', async t => {
  const f = await fixture(t, { fileTarget: true }); assert.throws(() => f.preview(), code('KNOWLEDGE_PUBLICATION_TARGET_UNSUPPORTED')); assert.deepEqual(f.counts(), [0, 0, 0, 0]);
});

test('actual completed output with withheld append-marker failure requires explicit native marker finishing before publication admission', async t => {
  const f = await fixture(t, { markerFailure: true });
  const generation = f.native.getGeneration('workspace', f.first.generationOwnerId); assert.equal(generation.state, 'completed'); assert.equal(generation.candidate.state, 'withheld');
  assert.throws(() => f.preview(), code('KNOWLEDGE_PUBLICATION_EVIDENCE_INVALID')); assert.deepEqual(f.counts(), [0, 0, 0, 0]);
});

test('source-current port cannot silently mutate selected source between exact body and final validation', async t => {
  const f = await fixture(t), preview = f.preview(); f.state.sourceHook = () => writeFileSync(join(f.root, 'source.ts'), 'export const changedInsidePort = 6;\n');
  await assert.rejects(f.service.publish(approved(preview)), code('KNOWLEDGE_SOURCE_CHANGED')); assert.deepEqual(f.counts(), [0, 0, 0, 0]);
});

test('a failed cancel keeps the original commit error and failed releases free the slot without hiding a receipt', async t => {
  const f = await fixture(t), native = f.ports.native, { cancel, release } = native;
  t.after(() => { native.cancel = cancel; native.release = release; });
  f.state.beforeCommit = () => { throw new EngineError('FIXTURE_COMMIT_FAILED', 'Commit failed'); };
  native.cancel = () => { throw new Error('Cancel failed'); };
  await assert.rejects(f.service.publish(approved(f.preview())), code('FIXTURE_COMMIT_FAILED'));
  assert.equal((JSON.parse(f.db.prepare('SELECT data FROM knowledge_publications').get()!.data as string) as { state: string }).state, 'cancelled');
  native.cancel = cancel; native.release = () => { throw new Error('Release failed'); };
  for (let index = 0; index < 33; index++) await assert.rejects(f.service.publish(approved(f.preview())), /Release failed/);
  f.state.beforeCommit = undefined;
  assert.equal((await f.service.publish(approved(f.preview()))).publication.state, 'completed');
});
