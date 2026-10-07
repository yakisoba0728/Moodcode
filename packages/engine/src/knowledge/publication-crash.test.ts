import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { EngineError, type JsonObject, type RunReceipt, type Session, type Workspace } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ProviderAdapter } from '../ports.js';
import type { KnowledgePublicationRecord, KnowledgePublicationReceipt, WorkspaceDocumentHead, WorkspaceDocumentRevision } from './publication-types.js';
import type { KnowledgeGenerationRecord } from './generation-types.js';
import type { KnowledgeCandidate } from './types.js';
import { exportEngineArchive, validateEngineArchive } from '../storage/archive.js';
import { sha256 } from './validation.js';

type Phase = 'prepared' | 'before-commit' | 'after-commit';
type Operation = 'publish' | 'revoke';
interface Snapshot {
  knowledge_publications: KnowledgePublicationRecord[];
  workspace_document_revisions: WorkspaceDocumentRevision[];
  workspace_document_heads: WorkspaceDocumentHead[];
  knowledge_publication_receipts: KnowledgePublicationReceipt[];
}
interface Boundary { phase: Phase; operation: Operation; record: KnowledgePublicationRecord; insideTransaction: boolean; frame: Snapshot; committed: Snapshot }
const TABLES = ['knowledge_publications', 'workspace_document_revisions', 'workspace_document_heads', 'knowledge_publication_receipts'] as const;
const CODING_TABLES = ['sessions', 'runs', 'messages', 'tools', 'approvals', 'checkpoints', 'session_turns', 'provider_attempts', 'context_revisions', 'summary_attempts', 'summary_usage'] as const;
const BODY = 'Exact generated body for crash-safe native document publication.\n';
function readonlyDb<T>(path: string, operation: (db: DatabaseSync) => T): T { const db = new DatabaseSync(path, { readOnly: true }); try { return operation(db); } finally { db.close(); } }
function snapshot(path: string): Snapshot { return readonlyDb(path, db => Object.fromEntries(TABLES.map(table => [table, db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(String(row.data)))])) as unknown as Snapshot); }
function codingRows(path: string): Record<string, unknown[]> { return readonlyDb(path, db => Object.fromEntries(CODING_TABLES.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))); }

async function launch(t: TestContext, directory: string, phase: Phase, operation: Operation) {
  const source = import.meta.url.endsWith('.ts'), childPath = fileURLToPath(new URL(`./fixtures/publication-crash-child.${source ? 'ts' : 'js'}`, import.meta.url));
  const loader = fileURLToPath(new URL('../../../../node_modules/tsx/dist/loader.mjs', import.meta.url));
  const child = spawn(process.execPath, [...(source ? ['--import', loader] : []), childPath, directory, phase, operation], { cwd: directory, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-16384); });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const deadline = Date.now() + 15000, readyPath = join(directory, 'publication-crash-ready.json');
  while (!existsSync(readyPath)) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Actual child exited before ${operation}/${phase}: ${stderr}`);
    assert.ok(Date.now() < deadline, `Actual SQL boundary was not observed: ${stderr}`); await pause(15);
  }
  const ready = JSON.parse(readFileSync(readyPath, 'utf8')) as Boundary;
  assert.equal(ready.phase, phase); assert.equal(ready.operation, operation);
  return { child, exited, ready };
}

async function fixture(t: TestContext, operation: Operation) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-publication-crash-'))), root = join(directory, 'repository'), dbPath = join(directory, 'engine.sqlite');
  mkdirSync(root); execFileSync('git', ['init', '--quiet', '--template=', root]);
  writeFileSync(join(root, 'AGENTS.md'), 'Approved instructions for original native publication.\n'); writeFileSync(join(root, 'source.ts'), 'export const crashSource = 1;\n');
  let codingCalls = 0, generationCalls = 0;
  const provider: ProviderAdapter = { id: 'publication-crash-fixture', async *streamTurn() { codingCalls++; yield { type: 'text.delta', delta: 'Actual completed coding source for native publication crash fixture.' }; yield { type: 'finish', reason: 'stop' }; },
    async *streamGeneration() { generationCalls++; yield { type: 'usage', inputTokens: 5, outputTokens: 3 }; yield { type: 'text.delta', delta: BODY }; yield { type: 'finish', reason: 'stop' }; } };
  const options = { dbPath, artifactDir: join(directory, 'artifacts'), providers: [provider], knowledgeGeneration: true, knowledgePublication: true,
    defaults: { providerId: provider.id, modelId: 'fixture-model', mode: 'plan' as const, limits: { maxTurns: 3, maxDurationMs: 10000 } } };
  const original = createEngine(options), engines = new Set([original]);
  t.after(async () => { for (const engine of engines) await engine.close(); rmSync(directory, { recursive: true, force: true }); });
  const dispatch = async <T>(type: string, payload: JsonObject): Promise<T> => { const reply = await original.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload }); assert.equal(reply.ok, true, JSON.stringify(reply.error)); return reply.result as unknown as T; };
  const workspace = await dispatch<Workspace>('workspace.open', { path: root }), session = await dispatch<Session>('session.create', { workspaceId: workspace.id });
  const run = await dispatch<RunReceipt>('run.submit', { sessionId: session.id, requestId: 'actual-publication-crash-source', prompt: 'Provide original source for a separate approved host operation.' });
  assert.equal((await original.waitForRun(run.runId)).state, 'completed'); await original.waitForSession(session.id);
  const message = original.store.getSnapshot(session.id).messages.find(value => value.role === 'assistant')!; assert.ok(message);
  const trust = await original.setWorkspaceTrust({ workspaceId: workspace.id, requestId: 'actual-publication-crash-trust', expectedRevision: 0, decision: 'allow', preview: original.previewWorkspaceTrust(workspace.id, ['AGENTS.md']) });
  const projection = original.captureWorkspaceKnowledgeSources(workspace.id, [{ kind: 'file', path: 'source.ts' }, { kind: 'message', sessionId: session.id, messageId: message.id, runId: run.runId }]);
  const logical = original.previewWorkspaceKnowledgeGeneration({ providerId: provider.id, modelId: 'fixture-model', projection });
  const target = original.captureWorkspaceKnowledgeDocumentTarget(workspace.id, 'project.memory');
  const plan = await original.prepareWorkspaceKnowledgeGeneration({ workspaceId: workspace.id, requestId: 'actual-crash-generation-plan', expectedTrustRevision: trust.revision, projection, target,
    providerId: provider.id, modelId: 'fixture-model', requestSha256: logical.requestSha256, requestBytes: logical.requestBytes, maxOutputBytes: 1024, expiresAt: new Date(Date.now() + 90000).toISOString() });
  const generated = await original.generateWorkspaceKnowledge({ workspaceId: workspace.id, planId: plan.id, requestId: 'actual-crash-generated-body', projection });
  assert.equal(generated.generation.state, 'completed'); assert.ok(generated.candidate); assert.equal(generated.candidate.body, BODY);
  let originalPublicationId: string | null = null;
  if (operation === 'revoke') {
    const published = await original.publishWorkspaceKnowledge({ workspaceId: workspace.id, requestId: 'actual-active-before-revoke-crash', approved: true,
      preview: original.previewWorkspaceKnowledgePublication({ workspaceId: workspace.id, candidateId: generated.candidate.id }) });
    originalPublicationId = published.publication.id; assert.equal(published.document.revision, 1);
  }
  const requestId = `actual-crash-${operation}`, before = snapshot(dbPath), codingBefore = codingRows(dbPath);
  writeFileSync(join(directory, 'publication-crash-config.json'), JSON.stringify({ workspaceId: workspace.id, candidateId: generated.candidate.id, originalPublicationId, requestId }), { mode: 0o600 });
  await original.close();
  return { directory, root, dbPath, workspace, candidate: generated.candidate, requestId, before, codingBefore,
    reopen() { const engine = createEngine({ ...options, knowledgePublication: false }); engines.add(engine); return engine; },
    assertNoReplay() { assert.equal(codingCalls, 1); assert.equal(generationCalls, 1); assert.deepEqual(codingRows(dbPath), codingBefore); assert.equal(existsSync(join(directory, 'unexpected-provider.log')), false); assert.equal(existsSync(join(root, 'MOODCODE_MEMORY.md')), false); },
  };
}

for (const operation of ['publish', 'revoke'] as const) for (const phase of ['prepared', 'before-commit', 'after-commit'] as const)
test(`real SIGKILL ${operation}/${phase} preserves atomic native document history and does not reapply on restart`, { skip: process.platform === 'win32', timeout: 25000 }, async t => {
  const f = await fixture(t, operation), { child, exited, ready } = await launch(t, f.directory, phase, operation);
  assert.equal(ready.record.workspaceId, f.workspace.id); assert.equal(ready.record.requestId, f.requestId); assert.equal(ready.record.operation, operation); assert.equal(ready.record.provenance.candidateId, f.candidate.id);
  assert.equal(ready.record.state, phase === 'prepared' ? 'prepared' : 'completed'); assert.equal(ready.insideTransaction, phase === 'before-commit');
  assert.deepEqual(snapshot(f.dbPath), ready.committed, 'Separate primary reader observes only real committed rows');
  const prepared = ready.committed.knowledge_publications.find(row => row.id === ready.record.id)!;
  assert.equal(prepared.state, phase === 'after-commit' ? 'completed' : 'prepared');
  const initialRevision = operation === 'publish' ? 0 : 1, committed = phase === 'after-commit';
  assert.equal(ready.committed.workspace_document_revisions.length, initialRevision + Number(committed));
  assert.equal(ready.committed.knowledge_publication_receipts.filter(row => row.requestId === f.requestId).length, Number(committed));
  if (phase === 'before-commit') {
    assert.equal(ready.frame.workspace_document_revisions.length, initialRevision + 1);
    assert.equal(ready.frame.knowledge_publication_receipts.filter(row => row.requestId === f.requestId).length, 1);
    assert.deepEqual(ready.committed.workspace_document_heads, f.before.workspace_document_heads, 'Uncommitted head must not escape SQL transaction');
  }
  assert.deepEqual(codingRows(f.dbPath), f.codingBefore); child.kill('SIGKILL'); await exited; assert.equal(child.signalCode, 'SIGKILL');
  const restored = f.reopen(), result = restored.getWorkspaceKnowledgePublication(f.workspace.id, ready.record.id), after = snapshot(f.dbPath);
  assert.equal(result.publication.state, committed ? 'completed' : 'cancelled'); assert.equal(result.publication.id, ready.record.id);
  assert.equal(result.publication.requestSha256, ready.record.requestSha256); assert.deepEqual(result.publication.provenance, ready.record.provenance);
  if (committed) {
    assert.ok(result.document && result.head && result.receipt); assert.deepEqual(result.publication, ready.record);
    assert.equal(result.document.revision, initialRevision + 1); assert.equal(result.document.body, operation === 'publish' ? BODY : '');
    assert.equal(result.document.bodySha256, sha256(operation === 'publish' ? BODY : '')); assert.equal(result.document.status, operation === 'publish' ? 'active' : 'revoked');
    assert.deepEqual(result.document, restored.getWorkspaceKnowledgeDocument(f.workspace.id, 'project.memory'));
    assert.deepEqual(after, ready.committed, 'Observed successful COMMIT survives restart without new writes');
  } else {
    assert.equal(result.document, null); assert.equal(result.head, null); assert.equal(result.receipt, null);
    assert.deepEqual(after.workspace_document_revisions, f.before.workspace_document_revisions); assert.deepEqual(after.workspace_document_heads, f.before.workspace_document_heads); assert.deepEqual(after.knowledge_publication_receipts, f.before.knowledge_publication_receipts);
  }
  assert.equal(after.knowledge_publications.length, f.before.knowledge_publications.length + 1);
  assert.equal(after.workspace_document_revisions.length, initialRevision + Number(committed));
  assert.equal(after.knowledge_publication_receipts.filter(row => row.requestId === f.requestId).length, Number(committed));
  const observedAgain = restored.getWorkspaceKnowledgePublication(f.workspace.id, ready.record.id); assert.deepEqual(observedAgain, result);
  assert.deepEqual(snapshot(f.dbPath), after); f.assertNoReplay();
});

test('real append-before-marker SIGKILL requires explicit candidate finishing before approval and leaves publication provenance stable', { skip: process.platform === 'win32', timeout: 25000 }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-publication-marker-gap-'))), root = join(directory, 'repository'), dbPath = join(directory, 'engine.sqlite'), artifactDir = join(directory, 'artifacts');
  mkdirSync(root); execFileSync('git', ['init', '--quiet', '--template=', root]);
  writeFileSync(join(root, 'AGENTS.md'), 'Approved native publication marker recovery.\n'); writeFileSync(join(root, 'source.ts'), 'export const selectedMarkerSource = 1;\n');
  let providerCalls = 0;
  const provider: ProviderAdapter = { id: 'generation-crash-fixture', async *streamTurn() { providerCalls++; throw new Error('Independent marker recovery must not create a coding turn'); },
    streamGeneration() { providerCalls++; throw new Error('Candidate finishing or publication must not replay generation'); } };
  const options = { dbPath, artifactDir, providers: [provider], knowledgeGeneration: true, knowledgePublication: true,
    defaults: { providerId: provider.id, modelId: 'fixture-model', mode: 'plan' as const, limits: { maxTurns: 3, maxDurationMs: 10000 } } };
  const original = createEngine(options), engines = new Set([original]);
  t.after(async () => { for (const engine of engines) await engine.close(); rmSync(directory, { recursive: true, force: true }); });
  const opened = await original.dispatch({ schemaVersion: 1, commandId: randomUUID(), type: 'workspace.open', payload: { path: root } }); assert.equal(opened.ok, true);
  const workspace = opened.result as unknown as Workspace;
  const trust = await original.setWorkspaceTrust({ workspaceId: workspace.id, requestId: 'approve-marker-trust', expectedRevision: 0, decision: 'allow', preview: original.previewWorkspaceTrust(workspace.id, ['AGENTS.md']) });
  const selection = [{ kind: 'file' as const, path: 'source.ts' }], projection = original.captureWorkspaceKnowledgeSources(workspace.id, selection);
  const logical = original.previewWorkspaceKnowledgeGeneration({ providerId: provider.id, modelId: 'fixture-model', projection });
  const plan = await original.prepareWorkspaceKnowledgeGeneration({ workspaceId: workspace.id, requestId: 'marker-gap-plan', expectedTrustRevision: trust.revision, projection,
    target: original.captureWorkspaceKnowledgeDocumentTarget(workspace.id, 'project.memory'), providerId: provider.id, modelId: 'fixture-model', requestSha256: logical.requestSha256, requestBytes: logical.requestBytes,
    maxOutputBytes: 1024, expiresAt: new Date(Date.now() + 120000).toISOString() });
  writeFileSync(join(directory, 'crash-config.json'), JSON.stringify({ workspaceId: workspace.id, planId: plan.id, requestId: 'actual-marker-gap-generation', requestSha256: logical.requestSha256, requestBytes: logical.requestBytes, selection }), { mode: 0o600 });
  const codingBefore = codingRows(dbPath); await original.close();
  // Reuse the original generation SQL boundary fixture without changing it or inventing native rows.
  const source = import.meta.url.endsWith('.ts'), childPath = fileURLToPath(new URL(`./fixtures/generation-crash-child.${source ? 'ts' : 'js'}`, import.meta.url));
  const loader = fileURLToPath(new URL('../../../../node_modules/tsx/dist/loader.mjs', import.meta.url));
  const child = spawn(process.execPath, [...(source ? ['--import', loader] : []), childPath, directory, 'candidate'], { cwd: directory, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-16384); }); const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const deadline = Date.now() + 15000, readyPath = join(directory, 'crash-ready.json');
  while (!existsSync(readyPath)) { assert.equal(child.exitCode, null, stderr); assert.equal(child.signalCode, null, stderr); assert.ok(Date.now() < deadline, stderr); await pause(15); }
  const ready = JSON.parse(readFileSync(readyPath, 'utf8')) as { generation: KnowledgeGenerationRecord; candidate: KnowledgeCandidate };
  assert.equal(ready.generation.state, 'completed'); assert.equal(ready.generation.candidate.state, 'pending'); assert.ok(ready.candidate);
  child.kill('SIGKILL'); await exited; assert.equal(child.signalCode, 'SIGKILL');
  const restored = createEngine(options); engines.add(restored);
  const gap = restored.getWorkspaceKnowledgeGeneration(workspace.id, ready.generation.id), nativeBefore = snapshot(dbPath), callsBefore = readFileSync(join(directory, 'generation-calls.jsonl'), 'utf8');
  assert.equal(gap.generation.candidate.state, 'pending'); assert.equal(gap.candidate, null); assert.deepEqual(restored.workspaceKnowledge.getCandidate(workspace.id, ready.candidate.id), ready.candidate);
  assert.throws(() => restored.previewWorkspaceKnowledgePublication({ workspaceId: workspace.id, candidateId: ready.candidate.id }), error => error instanceof EngineError && error.code === 'KNOWLEDGE_PUBLICATION_EVIDENCE_INVALID');
  assert.deepEqual(snapshot(dbPath), nativeBefore, 'Crash-gap inbox candidate must not acquire a publication owner or document');
  const finished = await restored.finishWorkspaceKnowledgeCandidate({ workspaceId: workspace.id, generationId: ready.generation.id, requestId: 'explicit-original-marker-finish' });
  assert.equal(finished.generation.candidate.state, 'recorded'); assert.deepEqual(finished.candidate, ready.candidate); assert.equal(providerCalls, 0);
  const published = await restored.publishWorkspaceKnowledge({ workspaceId: workspace.id, requestId: 'approved-after-original-marker', approved: true,
    preview: restored.previewWorkspaceKnowledgePublication({ workspaceId: workspace.id, candidateId: ready.candidate.id }) });
  assert.equal(published.publication.state, 'completed'); assert.equal(published.document.body, ready.candidate.body); assert.equal(published.publication.provenance.generationSha256, finished.generation.sha256);
  const repeated = await restored.finishWorkspaceKnowledgeCandidate({ workspaceId: workspace.id, generationId: ready.generation.id, requestId: 'repeat-finish-after-actual-publication' });
  assert.deepEqual(repeated.generation, finished.generation, 'Publication postimage must not change an already recorded generation marker/hash'); assert.deepEqual(repeated.candidate, ready.candidate);
  const revoked = await restored.revokeWorkspaceKnowledge({ workspaceId: workspace.id, requestId: 'revoke-stable-marker-publication', approved: true,
    preview: restored.previewWorkspaceKnowledgeRevocation({ workspaceId: workspace.id, publicationId: published.publication.id }) });
  assert.equal(revoked.document.status, 'revoked'); assert.equal(revoked.document.revision, 2); assert.equal(revoked.document.body, '');
  assert.equal(readFileSync(join(directory, 'generation-calls.jsonl'), 'utf8'), callsBefore); assert.equal(providerCalls, 0); assert.deepEqual(codingRows(dbPath), codingBefore);
  assert.equal(existsSync(join(directory, 'unexpected-coding.log')), false); await restored.close();
  const archive = await exportEngineArchive({ dbPath, artifactDir, destination: join(directory, 'stable-marker-archive') });
  assert.ok(validateEngineArchive({ directory: archive.directory })); assert.equal(providerCalls, 0);
});
