import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError, type JsonObject, type RunReceipt, type Session, type Workspace } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ProviderAdapter } from '../ports.js';
import type { HostGenerationRequest } from '../provider/generation.js';
import type { KnowledgeCandidate, KnowledgeTarget } from './types.js';
import type { WorkspaceDocumentRevision } from './publication-types.js';
import type { KnowledgePublicationRecord } from './publication-types.js';
import type { KnowledgePublicationPreview, WorkspaceKnowledgePublicationInput } from './publication-service.js';
import { sha256 } from './validation.js';

type Engine = ReturnType<typeof createEngine>;
type Preview = KnowledgePublicationPreview;
type Result = Awaited<ReturnType<Engine['publishWorkspaceKnowledge']>>;
type HistoricalResult = ReturnType<Engine['getWorkspaceKnowledgePublication']>;
type Decision = WorkspaceKnowledgePublicationInput;
interface HostApi {
  captureWorkspaceKnowledgeDocumentTarget(workspaceId: string, key: string): Extract<KnowledgeTarget, { kind: 'workspace-document' }>;
  previewWorkspaceKnowledgePublication(input: { workspaceId: string; candidateId: string; expiresAt?: string }): Preview;
  previewWorkspaceKnowledgeRevocation(input: { workspaceId: string; publicationId: string; expiresAt?: string }): Preview;
  publishWorkspaceKnowledge(input: Decision): Promise<Result>;
  revokeWorkspaceKnowledge(input: Decision): Promise<Result>;
  getWorkspaceKnowledgePublication(workspaceId: string, publicationId: string): HistoricalResult;
  getWorkspaceKnowledgeDocument(workspaceId: string, key: string): WorkspaceDocumentRevision | null;
  releaseWorkspaceKnowledgePublicationPreview(preview: Preview): void;
}
/** Bind only original public Engine methods; no product method/store row is replaced. */
function host(engine: Engine): HostApi {
  function invoke<T>(name: string, ...args: unknown[]): T { const method = Reflect.get(engine, name); assert.equal(typeof method, 'function', `Actual Engine must implement ${name}`); return Reflect.apply(method, engine, args) as T; }
  return {
    captureWorkspaceKnowledgeDocumentTarget: (workspaceId, key) => invoke('captureWorkspaceKnowledgeDocumentTarget', workspaceId, key),
    previewWorkspaceKnowledgePublication: input => invoke('previewWorkspaceKnowledgePublication', input),
    previewWorkspaceKnowledgeRevocation: input => invoke('previewWorkspaceKnowledgeRevocation', input),
    publishWorkspaceKnowledge: input => invoke('publishWorkspaceKnowledge', input),
    revokeWorkspaceKnowledge: input => invoke('revokeWorkspaceKnowledge', input),
    getWorkspaceKnowledgePublication: (workspaceId, publicationId) => invoke('getWorkspaceKnowledgePublication', workspaceId, publicationId),
    getWorkspaceKnowledgeDocument: (workspaceId, key) => invoke('getWorkspaceKnowledgeDocument', workspaceId, key),
    releaseWorkspaceKnowledgePublicationPreview: preview => invoke('releaseWorkspaceKnowledgePublicationPreview', preview),
  };
}
const errorCode = (code?: string) => (error: unknown): boolean => { assert.ok(error instanceof EngineError); if (code) assert.equal(error.code, code); return true; };
const CODING_TABLES = ['sessions', 'runs', 'messages', 'tools', 'approvals', 'checkpoints', 'session_turns', 'provider_attempts', 'context_revisions', 'summary_attempts', 'summary_usage'] as const;
function readDb<T>(path: string, operation: (db: DatabaseSync) => T): T { const db = new DatabaseSync(path, { readOnly: true }); try { return operation(db); } finally { db.close(); } }
function rows(path: string, tables: readonly string[]): Record<string, unknown[]> { return readDb(path, db => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))); }
function publicationTables(path: string): string[] { return readDb(path, db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'workspace_document_%' OR name LIKE 'knowledge_publication%') ORDER BY name").all().map(row => String(row.name))); }
function publicationRows(path: string) { return rows(path, publicationTables(path)); }
/** Observe only after original primary SQL succeeds; never manufacture a native owner/receipt. */
function afterActualCommit(t: TestContext, engine: Engine, requestId: string, state: KnowledgePublicationRecord['state'], observation: (record: KnowledgePublicationRecord) => void): () => number {
  const db = Reflect.get(engine.store, 'db') as DatabaseSync; assert.ok(db instanceof DatabaseSync);
  const original = db.exec, execute = original.bind(db); let observed = 0;
  db.exec = sql => { execute(sql); if (observed === 0 && sql.trim().toUpperCase() === 'COMMIT') {
    const row = db.prepare('SELECT data FROM knowledge_publications WHERE request_id=?').get(requestId);
    if (row) { const record = JSON.parse(String(row.data)) as KnowledgePublicationRecord; if (record.state === state) { observed++; observation(record); } }
  } };
  t.after(() => { db.exec = original; }); return () => observed;
}

async function fixture(t: TestContext, options: { publicationEnabled?: boolean } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-engine-publication-'))), root = join(directory, 'repository'), dbPath = join(directory, 'engine.sqlite'), artifactDir = join(directory, 'artifacts');
  mkdirSync(root); execFileSync('git', ['init', '--quiet', '--template=', root]);
  writeFileSync(join(root, 'AGENTS.md'), 'Operator approved native publication instructions.\n'); writeFileSync(join(root, 'source.ts'), 'export const publicationSource = 1;\n');
  let codingCalls = 0; const generations: HostGenerationRequest[] = []; let body = 'Exact first pending native document.\n';
  const provider: ProviderAdapter = { id: 'publication-fixture', async *streamTurn() { codingCalls++; yield { type: 'text.delta', delta: 'Actual completed coding source for native document knowledge.' }; yield { type: 'finish', reason: 'stop' }; },
    streamGeneration(request) { generations.push(request); return (async function* () { yield { type: 'usage' as const, inputTokens: 7, outputTokens: 3 }; yield { type: 'text.delta' as const, delta: body }; yield { type: 'finish' as const, reason: 'stop' as const }; })(); } };
  const optionsForEngine = { dbPath, artifactDir, providers: [provider], knowledgeGeneration: true,
    ...(options.publicationEnabled === false ? {} : { knowledgePublication: true }),
    defaults: { providerId: provider.id, modelId: 'fixture-model', mode: 'plan' as const, limits: { maxTurns: 3, maxDurationMs: 10000 } } };
  const engine = createEngine(optionsForEngine), engines = new Set([engine]), api = host(engine);
  t.after(async () => { for (const current of engines) await current.close(); rmSync(directory, { recursive: true, force: true }); });
  const command = async <T>(type: string, payload: JsonObject): Promise<T> => { const reply = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload }); assert.equal(reply.ok, true, JSON.stringify(reply.error)); return reply.result as unknown as T; };
  const workspace = await command<Workspace>('workspace.open', { path: root }), session = await command<Session>('session.create', { workspaceId: workspace.id });
  const run = await command<RunReceipt>('run.submit', { sessionId: session.id, requestId: 'settled-publication-source', prompt: 'Only provide the original source for independent host publication.' });
  assert.equal((await engine.waitForRun(run.runId)).state, 'completed'); await engine.waitForSession(session.id);
  const message = engine.store.getSnapshot(session.id).messages.find(value => value.role === 'assistant')!; assert.ok(message);
  const trust = await engine.setWorkspaceTrust({ workspaceId: workspace.id, requestId: 'trust-publication-source', expectedRevision: 0, decision: 'allow', preview: engine.previewWorkspaceTrust(workspace.id, ['AGENTS.md']) });
  let generationIndex = 0;
  async function candidate(current: Engine = engine, nextBody = body, key = 'project.memory', file = false): Promise<KnowledgeCandidate> {
    body = nextBody; const currentApi = host(current), index = ++generationIndex;
    const projection = current.captureWorkspaceKnowledgeSources(workspace.id, [{ kind: 'file', path: 'source.ts' }, { kind: 'message', sessionId: session.id, messageId: message.id, runId: run.runId }]);
    const logical = current.previewWorkspaceKnowledgeGeneration({ providerId: provider.id, modelId: 'fixture-model', projection });
    const target = file ? current.captureWorkspaceKnowledgeTarget(workspace.id, 'MOODCODE_MEMORY.md') : currentApi.captureWorkspaceKnowledgeDocumentTarget(workspace.id, key);
    const currentTrust = current.workspaceKnowledge.getTrust(workspace.id)!;
    const plan = await current.prepareWorkspaceKnowledgeGeneration({ workspaceId: workspace.id, requestId: `native-publication-plan-${index}`, expectedTrustRevision: currentTrust.revision, projection, target,
      providerId: provider.id, modelId: 'fixture-model', requestSha256: logical.requestSha256, requestBytes: logical.requestBytes, maxOutputBytes: 1024, expiresAt: new Date(Date.now() + 90000).toISOString() });
    const result = await current.generateWorkspaceKnowledge({ workspaceId: workspace.id, planId: plan.id, requestId: `native-publication-generation-${index}`, projection });
    assert.equal(result.generation.state, 'completed'); assert.ok(result.candidate); return result.candidate;
  }
  const first = await candidate(), codingBefore = rows(dbPath, CODING_TABLES);
  return { directory, root, dbPath, artifactDir, workspace, session, engine, api, trust, first, generations, candidate,
    publishInput(preview: Preview, requestId = 'approve-exact-first'): Decision { return { workspaceId: workspace.id, requestId, approved: true, preview }; },
    preview(captured: KnowledgeCandidate = first): Preview { return api.previewWorkspaceKnowledgePublication({ workspaceId: workspace.id, candidateId: captured.id }); },
    reopen(publicationEnabled = true) { const current = createEngine({ ...optionsForEngine, knowledgePublication: publicationEnabled }); engines.add(current); return { engine: current, api: host(current) }; },
    assertNoCodingEffects() { assert.equal(codingCalls, 1); assert.deepEqual(rows(dbPath, CODING_TABLES), codingBefore); assert.equal(existsSync(join(root, 'MOODCODE_MEMORY.md')), false); },
  };
}

test('actual pending candidate and publication preview create no document, receipt or coding effect', async t => {
  const f = await fixture(t), before = publicationRows(f.dbPath), preview = f.preview();
  assert.equal(f.first.state, 'pending'); assert.equal(Object.isFrozen(preview), true); assert.equal(preview.workspaceId, f.workspace.id);
  assert.deepEqual(f.api.captureWorkspaceKnowledgeDocumentTarget(f.workspace.id, 'project.memory'), { kind: 'workspace-document', key: 'project.memory', revision: 0, sha256: null });
  assert.deepEqual(publicationRows(f.dbPath), before); assert.equal(f.generations.length, 1); f.assertNoCodingEffects();
});

test('actual workspace publication schema has four independent native tables and no synthetic coding owner', async t => {
  const f = await fixture(t), names = publicationTables(f.dbPath);
  assert.deepEqual(names, ['knowledge_publication_receipts', 'knowledge_publications', 'workspace_document_heads', 'workspace_document_revisions']);
  readDb(f.dbPath, db => { for (const name of names) { const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(row => String(row.name)); for (const forbidden of ['session_id', 'run_id', 'turn_id', 'attempt_id', 'tool_call_id', 'checkpoint_id']) assert.equal(columns.includes(forbidden), false); } });
  f.assertNoCodingEffects();
});

test('actual publication default-off still allows native document capture but rejects preview/approval with zero effect', async t => {
  const f = await fixture(t, { publicationEnabled: false }), before = publicationRows(f.dbPath);
  assert.equal(f.api.captureWorkspaceKnowledgeDocumentTarget(f.workspace.id, 'project.memory').revision, 0);
  assert.throws(() => f.preview(), errorCode('KNOWLEDGE_PUBLICATION_DISABLED'));
  await assert.rejects(Reflect.apply(f.api.publishWorkspaceKnowledge, f.api, [{ workspaceId: f.workspace.id, requestId: 'disabled-approval', approved: true, preview: { workspaceId: f.workspace.id } }]), errorCode('KNOWLEDGE_PUBLICATION_DISABLED'));
  assert.deepEqual(publicationRows(f.dbPath), before); f.assertNoCodingEffects();
});

test('actual exact host approval publishes one document version/body and retains immutable candidate/native generation evidence', async t => {
  const f = await fixture(t), preview = f.preview(), nativeBefore = rows(f.dbPath, ['knowledge_generations', 'knowledge_generation_attempts', 'knowledge_candidates']);
  const result = await f.api.publishWorkspaceKnowledge(f.publishInput(preview));
  assert.equal(result.publication.state, 'completed'); assert.equal(result.publication.workspaceId, f.workspace.id); assert.equal(result.publication.provenance.candidateId, f.first.id);
  assert.ok(result.document && result.receipt); assert.equal(result.document.body, f.first.body); assert.equal(result.document.bodySha256, f.first.bodySha256); assert.equal(result.document.revision, 1); assert.equal(result.document.status, 'active');
  assert.deepEqual(f.api.captureWorkspaceKnowledgeDocumentTarget(f.workspace.id, 'project.memory'), { kind: 'workspace-document', key: 'project.memory', revision: 1, sha256: f.first.bodySha256 });
  assert.equal(result.duplicate, false); assert.deepEqual(rows(f.dbPath, ['knowledge_generations', 'knowledge_generation_attempts', 'knowledge_candidates']), nativeBefore);
  assert.equal(f.generations.length, 1); f.assertNoCodingEffects();
});

test('actual used approval duplicate remains historical after target/source change and cannot grant another request', async t => {
  const f = await fixture(t), preview = f.preview(), input = f.publishInput(preview), first = await f.api.publishWorkspaceKnowledge(input), before = publicationRows(f.dbPath);
  writeFileSync(join(f.root, 'source.ts'), 'export const publicationSource = 2;\n');
  const duplicate = await f.api.publishWorkspaceKnowledge(input), observed = f.api.getWorkspaceKnowledgePublication(f.workspace.id, first.publication.id);
  assert.deepEqual(duplicate.publication, first.publication); assert.deepEqual(duplicate.document, first.document); assert.deepEqual(duplicate.receipt, first.receipt); assert.equal(duplicate.duplicate, true);
  assert.deepEqual(observed.publication, first.publication); assert.deepEqual(observed.document, first.document); assert.deepEqual(observed.receipt, first.receipt);
  await assert.rejects(f.api.publishWorkspaceKnowledge(f.publishInput(preview, 'reuse-consumed-approval')), errorCode());
  assert.deepEqual(publicationRows(f.dbPath), before); assert.equal(f.generations.length, 1); f.assertNoCodingEffects();
});

for (const mutation of ['copy', 'structured-clone', 'foreign', 'getters', 'proxy', 'extra-body', 'released', 'false-approval'] as const) test(`actual ${mutation} approval cannot create a native publication owner/effect`, async t => {
  const f = await fixture(t), before = publicationRows(f.dbPath), preview = f.preview(); let reads = 0, decision: unknown = f.publishInput(preview);
  if (mutation === 'copy') decision = f.publishInput({ ...preview });
  if (mutation === 'structured-clone') decision = f.publishInput(structuredClone(preview));
  if (mutation === 'foreign') { const other = await fixture(t); decision = f.publishInput(other.preview()); }
  if (mutation === 'getters') decision = Object.defineProperty(f.publishInput(preview), 'preview', { enumerable: true, get() { reads++; return preview; } });
  if (mutation === 'proxy') decision = new Proxy(f.publishInput(preview), { ownKeys() { reads++; throw new Error('Proxy must not execute'); }, get() { reads++; throw new Error('Proxy must not execute'); }, getPrototypeOf() { reads++; throw new Error('Proxy must not execute'); } });
  if (mutation === 'extra-body') decision = { ...f.publishInput(preview), body: 'Caller must not replace exact candidate body' };
  if (mutation === 'released') f.api.releaseWorkspaceKnowledgePublicationPreview(preview);
  if (mutation === 'false-approval') decision = { ...f.publishInput(preview), approved: false };
  await assert.rejects(Promise.resolve().then(() => Reflect.apply(f.api.publishWorkspaceKnowledge, f.api, [decision])), errorCode());
  assert.equal(reads, 0); assert.deepEqual(publicationRows(f.dbPath), before); assert.equal(f.generations.length, 1); f.assertNoCodingEffects();
});

for (const mutation of ['source', 'trust-file', 'trust-revoke', 'root-replacement'] as const) test(`actual ${mutation} change after approval preview blocks new publication without clobber`, async t => {
  const f = await fixture(t), preview = f.preview(), before = publicationRows(f.dbPath);
  if (mutation === 'source') writeFileSync(join(f.root, 'source.ts'), 'export const publicationSource = 2;\n');
  if (mutation === 'trust-file') writeFileSync(join(f.root, 'AGENTS.md'), 'Changed instructions were never approved.\n');
  if (mutation === 'trust-revoke') await f.engine.setWorkspaceTrust({ workspaceId: f.workspace.id, requestId: 'deny-before-publication', expectedRevision: f.trust.revision, decision: 'deny' });
  if (mutation === 'root-replacement') { renameSync(f.root, join(f.directory, 'displaced-root')); mkdirSync(f.root); writeFileSync(join(f.root, 'AGENTS.md'), 'Operator approved native publication instructions.\n'); writeFileSync(join(f.root, 'source.ts'), 'export const publicationSource = 1;\n'); }
  await assert.rejects(f.api.publishWorkspaceKnowledge(f.publishInput(preview)), errorCode());
  assert.deepEqual(publicationRows(f.dbPath), before); assert.equal(f.generations.length, 1); f.assertNoCodingEffects();
});

test('actual new candidate updates existing native document by exact positive revision and old preimage becomes stale', async t => {
  const f = await fixture(t), first = await f.api.publishWorkspaceKnowledge(f.publishInput(f.preview())), second = await f.candidate(f.engine, 'Exact approved second version.\n');
  assert.deepEqual(second.target, { kind: 'workspace-document', key: 'project.memory', revision: 1, sha256: f.first.bodySha256 });
  const result = await f.api.publishWorkspaceKnowledge(f.publishInput(f.preview(second), 'approve-second-version'));
  assert.ok(result.document); assert.equal(result.document.revision, 2); assert.equal(result.document.body, second.body); assert.equal(result.document.bodySha256, second.bodySha256);
  assert.equal(result.document.previousRevisionId, first.document!.id); assert.deepEqual(f.api.getWorkspaceKnowledgeDocument(f.workspace.id, 'project.memory'), result.document);
  assert.equal(f.engine.workspaceKnowledge.getCandidate(f.workspace.id, f.first.id)!.body, f.first.body);
  assert.deepEqual(f.api.getWorkspaceKnowledgePublication(f.workspace.id, first.publication.id).document, first.document, 'Historical publication reads its own version rather than the current head');
  assert.throws(() => f.preview(f.first), errorCode()); assert.equal(f.generations.length, 2); f.assertNoCodingEffects();
});

test('actual historical publication remains readable with publication opt-in disabled after Engine restart', async t => {
  const f = await fixture(t), result = await f.api.publishWorkspaceKnowledge(f.publishInput(f.preview())), before = publicationRows(f.dbPath); await f.engine.close(); const restored = f.reopen(false);
  const observed = restored.api.getWorkspaceKnowledgePublication(f.workspace.id, result.publication.id);
  assert.deepEqual(observed.publication, result.publication); assert.deepEqual(observed.document, result.document); assert.deepEqual(observed.receipt, result.receipt);
  assert.deepEqual(restored.api.getWorkspaceKnowledgeDocument(f.workspace.id, 'project.memory'), result.document); assert.deepEqual(publicationRows(f.dbPath), before); f.assertNoCodingEffects();
});

test('actual simultaneous publication requests share the workspace lease and permit only one native effect', async t => {
  const f = await fixture(t), second = await f.candidate(f.engine, 'Independent racing native candidate.\n'), a = f.preview(), b = f.preview(second);
  const results = await Promise.allSettled([f.api.publishWorkspaceKnowledge(f.publishInput(a, 'race-a')), f.api.publishWorkspaceKnowledge(f.publishInput(b, 'race-b'))]);
  const completed = results.filter((value): value is PromiseFulfilledResult<Result> => value.status === 'fulfilled' && value.value.publication.state === 'completed');
  assert.equal(completed.length, 1); const rejected = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected');
  assert.equal(rejected.length, 1); assert.ok(rejected[0]!.reason instanceof EngineError); assert.equal(rejected[0]!.reason.code, 'WORKSPACE_BUSY');
  const durable = readDb(f.dbPath, db => db.prepare('SELECT state FROM knowledge_publications').all()); assert.deepEqual(durable.map(row => row.state), ['completed']);
  assert.equal(f.api.captureWorkspaceKnowledgeDocumentTarget(f.workspace.id, 'project.memory').revision, 1); assert.equal(f.generations.length, 2); f.assertNoCodingEffects();
});

test('actual competing original approvals pin the same head and the later commit fails exact target staleness without clobber', async t => {
  const f = await fixture(t), second = await f.candidate(f.engine, 'A separate approved candidate for the same native preimage.\n'), a = f.preview(), b = f.preview(second);
  assert.equal(a.pins.expectedHeadRevision, 0); assert.equal(b.pins.expectedHeadRevision, 0);
  const winner = await f.api.publishWorkspaceKnowledge(f.publishInput(a, 'head-cas-winner')), before = publicationRows(f.dbPath);
  await assert.rejects(f.api.publishWorkspaceKnowledge(f.publishInput(b, 'head-cas-loser')), errorCode('KNOWLEDGE_PUBLICATION_STALE'));
  assert.deepEqual(publicationRows(f.dbPath), before); assert.deepEqual(f.api.getWorkspaceKnowledgeDocument(f.workspace.id, 'project.memory'), winner.document);
  assert.equal(f.api.captureWorkspaceKnowledgeDocumentTarget(f.workspace.id, 'project.memory').revision, 1); assert.equal(f.generations.length, 2); f.assertNoCodingEffects();
});

test('actual logical revoke advances revision and empty SHA while allowing stale original source/current denied trust', async t => {
  const f = await fixture(t), original = await f.api.publishWorkspaceKnowledge(f.publishInput(f.preview()));
  writeFileSync(join(f.root, 'source.ts'), 'export const publicationSource = 2;\n');
  await f.engine.setWorkspaceTrust({ workspaceId: f.workspace.id, requestId: 'deny-before-revoke', expectedRevision: f.trust.revision, decision: 'deny' });
  const preview = f.api.previewWorkspaceKnowledgeRevocation({ workspaceId: f.workspace.id, publicationId: original.publication.id }), input = f.publishInput(preview, 'revoke-exact-active'), revoked = await f.api.revokeWorkspaceKnowledge(input);
  assert.equal(revoked.publication.state, 'completed'); assert.ok(revoked.document && revoked.receipt); assert.equal(revoked.document.revision, 2); assert.equal(revoked.document.body, ''); assert.equal(revoked.document.bodySha256, sha256('')); assert.equal(revoked.document.status, 'revoked');
  assert.deepEqual(f.api.captureWorkspaceKnowledgeDocumentTarget(f.workspace.id, 'project.memory'), { kind: 'workspace-document', key: 'project.memory', revision: 2, sha256: sha256('') });
  const before = publicationRows(f.dbPath), duplicate = await f.api.revokeWorkspaceKnowledge(input); assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.document, revoked.document); assert.deepEqual(publicationRows(f.dbPath), before);
  assert.deepEqual(f.api.getWorkspaceKnowledgePublication(f.workspace.id, original.publication.id).publication, original.publication); assert.deepEqual(f.api.getWorkspaceKnowledgePublication(f.workspace.id, original.publication.id).document, original.document);
  assert.equal(f.generations.length, 1); f.assertNoCodingEffects();
});

test('actual stale revocation preview cannot clear a newer approved document revision', async t => {
  const f = await fixture(t), first = await f.api.publishWorkspaceKnowledge(f.publishInput(f.preview())), revoke = f.api.previewWorkspaceKnowledgeRevocation({ workspaceId: f.workspace.id, publicationId: first.publication.id });
  const next = await f.candidate(f.engine, 'Newer publication must survive older revoke.\n'), published = await f.api.publishWorkspaceKnowledge(f.publishInput(f.preview(next), 'publish-newer-before-revoke')), before = publicationRows(f.dbPath);
  await assert.rejects(f.api.revokeWorkspaceKnowledge(f.publishInput(revoke, 'stale-revoke')), errorCode());
  assert.deepEqual(publicationRows(f.dbPath), before); assert.equal(f.api.captureWorkspaceKnowledgeDocumentTarget(f.workspace.id, 'project.memory').revision, 2); assert.equal(published.document!.body, next.body); f.assertNoCodingEffects();
});

test('actual original publication preview loses authority across Engine close/restart without changing document or replaying generation', async t => {
  const f = await fixture(t), preview = f.preview(), before = publicationRows(f.dbPath); await f.engine.close(); const restored = f.reopen();
  await assert.rejects(restored.api.publishWorkspaceKnowledge(f.publishInput(preview, 'old-runtime-approval')), errorCode());
  assert.deepEqual(publicationRows(f.dbPath), before); assert.equal(f.generations.length, 1); f.assertNoCodingEffects();
});

test('actual caller cancellation before publication has zero document effect and cannot change the immutable pending candidate', async t => {
  const f = await fixture(t), preview = f.preview(), before = publicationRows(f.dbPath), abort = new AbortController(); abort.abort();
  await assert.rejects(f.api.publishWorkspaceKnowledge({ ...f.publishInput(preview), signal: abort.signal }), errorCode());
  assert.deepEqual(publicationRows(f.dbPath), before); assert.equal(f.engine.workspaceKnowledge.getCandidate(f.workspace.id, f.first.id)!.state, 'pending'); assert.equal(f.generations.length, 1); f.assertNoCodingEffects();
});

test('actual cancellation after native prepare preserves cancelled owner and cannot publish or retry the consumed approval', async t => {
  const f = await fixture(t), abort = new AbortController(), preview = f.preview(), requestId = 'cancel-after-actual-prepare';
  const observed = afterActualCommit(t, f.engine, requestId, 'prepared', () => abort.abort());
  await assert.rejects(f.api.publishWorkspaceKnowledge({ ...f.publishInput(preview, requestId), signal: abort.signal }), errorCode('KNOWLEDGE_PUBLICATION_CANCELLED'));
  assert.equal(observed(), 1); assert.equal(f.api.captureWorkspaceKnowledgeDocumentTarget(f.workspace.id, 'project.memory').revision, 0);
  const record = readDb(f.dbPath, db => JSON.parse(String(db.prepare('SELECT data FROM knowledge_publications WHERE request_id=?').get(requestId)!.data)) as KnowledgePublicationRecord);
  assert.equal(record.state, 'cancelled'); assert.equal(record.documentRevisionId, null);
  const before = publicationRows(f.dbPath);
  await assert.rejects(f.api.publishWorkspaceKnowledge(f.publishInput(preview, requestId)), errorCode('KNOWLEDGE_PUBLICATION_NOT_COMPLETED'));
  await assert.rejects(f.api.publishWorkspaceKnowledge(f.publishInput(preview, 'cancelled-owner-new-request')), errorCode('KNOWLEDGE_PUBLICATION_PREVIEW_USED'));
  assert.deepEqual(publicationRows(f.dbPath), before); assert.equal(f.generations.length, 1); f.assertNoCodingEffects();
});

test('actual caller cancellation after successful native COMMIT cannot erase completed document or exact receipt', async t => {
  const f = await fixture(t), abort = new AbortController(), preview = f.preview(), requestId = 'cancel-after-observed-commit';
  const observed = afterActualCommit(t, f.engine, requestId, 'completed', () => abort.abort());
  const result = await f.api.publishWorkspaceKnowledge({ ...f.publishInput(preview, requestId), signal: abort.signal });
  assert.equal(observed(), 1); assert.equal(abort.signal.aborted, true); assert.equal(result.publication.state, 'completed'); assert.equal(result.document.body, f.first.body); assert.equal(result.receipt.requestId, requestId);
  const before = publicationRows(f.dbPath), duplicate = await f.api.publishWorkspaceKnowledge({ ...f.publishInput(preview, requestId), signal: abort.signal });
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.receipt, result.receipt); assert.deepEqual(publicationRows(f.dbPath), before); f.assertNoCodingEffects();
});

test('actual physical source change after durable prepare is rechecked at native commit and creates no document', async t => {
  const f = await fixture(t), preview = f.preview(), requestId = 'source-after-native-prepare';
  const observed = afterActualCommit(t, f.engine, requestId, 'prepared', () => writeFileSync(join(f.root, 'source.ts'), 'export const publicationSource = 9;\n'));
  await assert.rejects(f.api.publishWorkspaceKnowledge(f.publishInput(preview, requestId)), errorCode());
  assert.equal(observed(), 1); assert.equal(f.api.captureWorkspaceKnowledgeDocumentTarget(f.workspace.id, 'project.memory').revision, 0);
  const record = readDb(f.dbPath, db => JSON.parse(String(db.prepare('SELECT data FROM knowledge_publications WHERE request_id=?').get(requestId)!.data)) as KnowledgePublicationRecord);
  assert.equal(record.state, 'cancelled'); assert.equal(record.documentRevisionId, null);
  assert.equal(readDb(f.dbPath, db => db.prepare('SELECT COUNT(*) AS n FROM knowledge_publication_receipts').get()!.n), 0); f.assertNoCodingEffects();
});

test('actual approval operation reflection cannot turn publish permission into revoke or revoke permission into publish', async t => {
  const f = await fixture(t), publish = f.preview(), before = publicationRows(f.dbPath);
  await assert.rejects(f.api.revokeWorkspaceKnowledge(f.publishInput(publish, 'reflected-publish')), errorCode('KNOWLEDGE_PUBLICATION_PREVIEW_INVALID'));
  assert.deepEqual(publicationRows(f.dbPath), before);
  const original = await f.api.publishWorkspaceKnowledge(f.publishInput(publish)), revoke = f.api.previewWorkspaceKnowledgeRevocation({ workspaceId: f.workspace.id, publicationId: original.publication.id }), active = publicationRows(f.dbPath);
  await assert.rejects(f.api.publishWorkspaceKnowledge(f.publishInput(revoke, 'reflected-revoke')), errorCode('KNOWLEDGE_PUBLICATION_PREVIEW_INVALID'));
  assert.deepEqual(publicationRows(f.dbPath), active); assert.equal(f.api.captureWorkspaceKnowledgeDocumentTarget(f.workspace.id, 'project.memory').revision, 1); f.assertNoCodingEffects();
});

test('actual revoked positive revision permits a new exact candidate and never resets target to absent revision zero', async t => {
  const f = await fixture(t), first = await f.api.publishWorkspaceKnowledge(f.publishInput(f.preview()));
  const revoked = await f.api.revokeWorkspaceKnowledge(f.publishInput(f.api.previewWorkspaceKnowledgeRevocation({ workspaceId: f.workspace.id, publicationId: first.publication.id }), 'revoke-before-new-generation'));
  const next = await f.candidate(f.engine, 'Approved native document after logical revocation.\n');
  assert.deepEqual(next.target, { kind: 'workspace-document', key: 'project.memory', revision: 2, sha256: sha256('') });
  const restored = await f.api.publishWorkspaceKnowledge(f.publishInput(f.preview(next), 'publish-after-logical-revoke'));
  assert.equal(restored.document.revision, 3); assert.equal(restored.document.previousRevisionId, revoked.document.id); assert.equal(restored.document.body, next.body); assert.equal(restored.document.status, 'active');
  assert.deepEqual(f.api.getWorkspaceKnowledgePublication(f.workspace.id, revoked.publication.id).document, revoked.document); assert.equal(f.generations.length, 2); f.assertNoCodingEffects();
});

test('actual file-target candidate remains pending and publication is explicitly unsupported without filesystem changes', async t => {
  const f = await fixture(t), file = await f.candidate(f.engine, 'File proposal must stay pending.\n', 'ignored', true), before = publicationRows(f.dbPath);
  assert.throws(() => f.preview(file), errorCode()); assert.deepEqual(publicationRows(f.dbPath), before); assert.equal(existsSync(join(f.root, 'MOODCODE_MEMORY.md')), false); assert.equal(f.generations.length, 2); f.assertNoCodingEffects();
});
