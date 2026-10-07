import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { EngineError, type JsonObject, type Run, type RunReceipt, type Session, type Workspace } from '@moodcode/contracts';
import { createEngine, type EngineOptions } from '../engine.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import type { KnowledgeContextPolicy, PreparedKnowledgeContribution } from '../knowledge/context-types.js';
import type { KnowledgeCandidate } from '../knowledge/types.js';
import type { LifecycleHookRegistration } from '../lifecycle/index.js';
import { exportEngineArchive, importEngineArchive } from '../storage/archive.js';
import { sha256 } from '../knowledge/validation.js';

type Engine = ReturnType<typeof createEngine>;
const MARKER = 'knowledge_marker_exact_host_approved';
const BODY = `${MARKER}: preserve exact "quotes", \\ paths, 한글😀.\n`;
const SECOND_BODY = 'knowledge_marker_second_postimage: exact new approved document.\n';
const KEY = 'project.memory';
const HOST_TABLES = ['workspace_trust_revisions', 'workspace_trust_heads', 'knowledge_generation_plans', 'knowledge_generations', 'knowledge_generation_attempts', 'knowledge_candidates', 'knowledge_publications', 'workspace_document_revisions', 'workspace_document_heads', 'knowledge_publication_receipts'] as const;
function readDb<T>(path: string, read: (db: DatabaseSync) => T): T { const db = new DatabaseSync(path, { readOnly: true }); try { return read(db); } finally { db.close(); } }
function hostRows(path: string) { return readDb(path, db => Object.fromEntries(HOST_TABLES.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))); }
function count(path: string, table: string) { return readDb(path, db => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)); }
async function command<T>(engine: Engine, type: string, payload: JsonObject): Promise<T> { const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload }); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.result as unknown as T; }
function evidence(request: TurnRequest, marker = MARKER) { return request.messages.filter(message => message.content.includes(marker)); }
function diagnostics(engine: Engine, sessionId: string): Omit<PreparedKnowledgeContribution, 'messages'> {
  const diagnostic = engine.context.diagnostics(sessionId)!.knowledgeContext; assert.ok(diagnostic, 'Actual ContextService must expose its original source observation'); return diagnostic;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function waitOrAbort(release: ReturnType<typeof deferred>, signal: AbortSignal) {
  let abort!: () => void;
  const cancelled = new Promise<void>(yes => { abort = yes; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
  try { await Promise.race([release.promise, cancelled]); } finally { signal.removeEventListener('abort', abort); }
}
interface FixtureOptions {
  enabled?: boolean; published?: boolean; slotBytes?: number; limit?: number; policy?: KnowledgeContextPolicy;
  expiryMs?: number; generationDurationMs?: number; publicationDurationMs?: number; repository?: boolean;
  stream?: (request: TurnRequest, signal: AbortSignal) => AsyncIterable<ProviderEvent>;
  beforeModel?: (engine: Engine, runId: string) => void | Promise<void>;
}
async function fixture(t: TestContext, input: FixtureOptions = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-active-knowledge-'))), root = join(base, 'repo'), dbPath = join(base, 'engine.sqlite'), artifactDir = join(base, 'artifacts');
  mkdirSync(root); execFileSync('git', ['init', '--quiet', '--template=', root]);
  writeFileSync(join(root, 'AGENTS.md'), 'Explicit approved instructions for independent workspace knowledge.\n');
  writeFileSync(join(root, 'source.ts'), 'export const selectedSource = 1;\n'); writeFileSync(join(root, 'navigation.ts'), 'repository_optional_marker\n');
  let seed = true, seedCalls = 0, generationCalls = 0, generationBody = BODY;
  const requests: TurnRequest[] = [];
  const provider: ProviderAdapter = { id: 'active-knowledge-fixture', streamTurn(request, signal) {
    if (seed) return (async function* () { seedCalls++; yield { type: 'text.delta' as const, delta: 'Original completed coding source for later host-derived knowledge.' }; yield { type: 'finish' as const, reason: 'stop' as const }; })();
    requests.push(structuredClone(request));
    return input.stream?.(request, signal) ?? (async function* () { yield { type: 'text.delta' as const, delta: 'Actual coding consumer completed.' }; yield { type: 'finish' as const, reason: 'stop' as const }; })();
  }, streamGeneration() { generationCalls++; return (async function* () { yield { type: 'usage' as const, inputTokens: 6, outputTokens: 4 }; yield { type: 'text.delta' as const, delta: generationBody }; yield { type: 'finish' as const, reason: 'stop' as const }; })(); } };
  const profile = { id: 'review', description: 'Approved fixture review profile', instructions: 'Keep current user input exact.', tools: [] };
  const common: EngineOptions = { dbPath, artifactDir, providers: [provider], tools: [], agentProfiles: [profile], knowledgeGeneration: true, knowledgePublication: true,
    defaults: { providerId: provider.id, modelId: 'fixture-model', mode: 'plan', limits: { maxTurns: 4, maxDurationMs: 15000, maxContextBytes: input.limit ?? 65536 }, budgets: { maxProviderAttempts: 3, retryBaseDelayMs: 0 } } };
  const original = createEngine(common), engines = new Set([original]);
  t.after(async () => { for (const engine of engines) await engine.close(); rmSync(base, { recursive: true, force: true }); });
  const workspace = await command<Workspace>(original, 'workspace.open', { path: root }), sourceSession = await command<Session>(original, 'session.create', { workspaceId: workspace.id });
  const submitted = await command<RunReceipt>(original, 'run.submit', { sessionId: sourceSession.id, requestId: 'actual-settled-knowledge-source', prompt: 'Provide original source for a separately approved workspace operation.' });
  assert.equal((await original.waitForRun(submitted.runId)).state, 'completed'); await original.waitForSession(sourceSession.id);
  const sourceMessage = original.store.getSnapshot(sourceSession.id).messages.find(message => message.role === 'assistant')!; assert.ok(sourceMessage);
  const trust = await original.setWorkspaceTrust({ workspaceId: workspace.id, requestId: 'allow-original-source', expectedRevision: 0, decision: 'allow', preview: original.previewWorkspaceTrust(workspace.id, ['AGENTS.md']) });
  let generationIndex = 0;
  async function candidate(engine: Engine, body = BODY): Promise<KnowledgeCandidate> {
    generationBody = body; const index = ++generationIndex;
    const projection = engine.captureWorkspaceKnowledgeSources(workspace.id, [{ kind: 'file', path: 'source.ts' }, { kind: 'message', sessionId: sourceSession.id, runId: submitted.runId, messageId: sourceMessage.id }]);
    const logical = engine.previewWorkspaceKnowledgeGeneration({ providerId: provider.id, modelId: 'fixture-model', projection });
    const currentTrust = engine.workspaceKnowledge.getTrust(workspace.id)!;
    const plan = await engine.prepareWorkspaceKnowledgeGeneration({ workspaceId: workspace.id, requestId: `active-plan-${index}`, expectedTrustRevision: currentTrust.revision, projection,
      target: engine.captureWorkspaceKnowledgeDocumentTarget(workspace.id, KEY), providerId: provider.id, modelId: 'fixture-model', requestSha256: logical.requestSha256, requestBytes: logical.requestBytes,
      maxOutputBytes: 4096, expiresAt: new Date(Date.now() + (input.expiryMs ?? 120000)).toISOString() });
    const generated = await engine.generateWorkspaceKnowledge({ workspaceId: workspace.id, planId: plan.id, requestId: `active-generation-${index}`, projection,
      ...(input.generationDurationMs ? { budget: { maxDurationMs: input.generationDurationMs, providerRequestTimeoutMs: Math.min(200, input.generationDurationMs), inactivityTimeoutMs: Math.min(150, input.generationDurationMs), cleanupTimeoutMs: Math.min(25, input.generationDurationMs) } } : {}) });
    assert.equal(generated.generation.state, 'completed'); assert.ok(generated.candidate); return generated.candidate;
  }
  async function publish(engine: Engine, selected: KnowledgeCandidate, requestId = 'approve-active-first') { return engine.publishWorkspaceKnowledge({ workspaceId: workspace.id, requestId, approved: true,
    preview: engine.previewWorkspaceKnowledgePublication({ workspaceId: workspace.id, candidateId: selected.id,
      ...(input.publicationDurationMs ? { expiresAt: new Date(Date.now() + input.publicationDurationMs).toISOString() } : {}) }) }); }
  const first = await candidate(original), publication = input.published === false ? null : await publish(original, first); await original.close(); seed = false;
  let active!: Engine;
  const hook: LifecycleHookRegistration = { id: 'active-knowledge-physical-boundary', revision: 1, stages: ['before-model'], timeoutMs: 1000, failurePolicy: 'stop', callback: async invocation => { await input.beforeModel?.(active, invocation.identity.runId); return { kind: 'observe' }; } };
  const policy: KnowledgeContextPolicy = input.policy ?? { documentKeys: [KEY], slotBytes: input.slotBytes ?? 16384 };
  const consumerOptions: EngineOptions = { ...common, ...(input.enabled === false ? {} : { knowledgeContextPolicy: policy }), ...(input.beforeModel ? { lifecycleHooks: [hook] } : {}),
    ...(input.repository ? { repositoryContextPolicy: { query: { kind: 'symbols', paths: ['navigation.ts'] }, slotBytes: 8192,
      exactRanges: [{ path: 'navigation.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 26 } } }] } } : {}) };
  active = createEngine(consumerOptions); engines.add(active);
  async function consume(engine = active, prompt = 'Exact required current goal 한글😀', config: JsonObject = {}) {
    const session = await command<Session>(engine, 'session.create', { workspaceId: workspace.id });
    const receipt = await command<RunReceipt>(engine, 'run.submit', { sessionId: session.id, requestId: randomUUID(), prompt, config });
    const run = await engine.waitForRun(receipt.runId); await engine.waitForSession(session.id); return { session, run, request: requests.find(request => request.runId === run.id) };
  }
  return { base, root, dbPath, artifactDir, original, engine: active, engines, common, consumerOptions, workspace, sourceSession, sourceRunId: submitted.runId, trust, first, publication, requests, policy, provider, candidate, publish, consume,
    reopen(options: Partial<EngineOptions> = {}) { active = createEngine({ ...consumerOptions, ...options }); engines.add(active); return active; },
    counts: () => ({ seedCalls, generationCalls }),
    assertNoExtraHostEffects(before: ReturnType<typeof hostRows>) { assert.deepEqual(hostRows(dbPath), before); assert.equal(count(dbPath, 'tools'), 0); assert.equal(count(dbPath, 'approvals'), 0); assert.equal(count(dbPath, 'checkpoints'), 0); assert.equal(count(dbPath, 'summary_attempts'), 0); assert.equal(count(dbPath, 'summary_usage'), 0); assert.equal(seedCalls, 1); },
  };
}

test('actual independently published postimage is consumed once by native coding Attempt with persisted exact context provenance', async t => {
  const f = await fixture(t), before = hostRows(f.dbPath), result = await f.consume(); assert.equal(result.run.state, 'completed', JSON.stringify(result.run.error)); assert.ok(result.request);
  const messages = evidence(result.request); assert.equal(messages.length, 1); assert.equal(messages[0]!.role, 'assistant'); assert.ok(messages[0]!.content.includes(JSON.stringify(BODY)));
  assert.equal(result.request.tools.length, 0); assert.equal(result.request.messages.at(-1)!.content, result.run.prompt);
  const attempt = f.engine.store.getAttempt(result.request.attemptId!); assert.equal(attempt.runId, result.run.id); assert.equal(attempt.sessionId, result.session.id); assert.equal(attempt.state, 'completed'); assert.ok(attempt.contextRevisionId);
  const revision = f.engine.store.getContextRevision(attempt.contextRevisionId); assert.equal(revision.text, JSON.stringify(result.request.messages)); assert.equal(revision.sha256, sha256(revision.text));
  const observation = diagnostics(f.engine, result.session.id), manifest = observation.documents[0]!; assert.equal(observation.documents.length, 1); assert.equal(observation.inputEstimate.tokens, null);
  assert.equal(manifest.documentRevisionId, f.publication!.document.id); assert.equal(manifest.documentRevision, 1); assert.equal(manifest.publicationId, f.publication!.publication.id); assert.equal(manifest.receiptId, f.publication!.receipt.id);
  assert.equal(manifest.candidateId, f.first.id); assert.equal(manifest.bodySha256, f.first.bodySha256); assert.equal(manifest.generationId, f.first.generationOwnerId); assert.ok(revision.sourceIds.some(id => id.includes('knowledge')));
  assert.equal(JSON.stringify(observation).includes(MARKER), false, 'Inspectors retain provenance rather than active body');
  const cleanup = f.engine.store.getAttemptCleanup(attempt.id); assert.equal(cleanup.contextRevisionId, revision.id); assert.equal(cleanup.requestSha256, sha256(JSON.stringify(result.request))); assert.equal(cleanup.requestBytes, Buffer.byteLength(JSON.stringify(result.request)));
  const plan = f.engine.context.diagnostics(result.session.id)!.plan; assert.equal(plan.reservations.knowledgeBytes, Buffer.byteLength(JSON.stringify(messages[0])) + 1); assert.equal(plan.bytes, Buffer.byteLength(JSON.stringify(result.request.messages)) + plan.reservations.envelopeBytes);
  assert.deepEqual(f.counts(), { seedCalls: 1, generationCalls: 1 }); f.assertNoExtraHostEffects(before);
});

for (const inactive of ['default-off', 'pending-candidate', 'wrong-key', 'profile-mismatch'] as const) test(`actual ${inactive} grants no active knowledge body and creates no host producer/effect`, async t => {
  const f = await fixture(t, { enabled: inactive !== 'default-off', published: inactive !== 'pending-candidate',
    ...(inactive === 'wrong-key' ? { policy: { documentKeys: ['never-published.memory'], slotBytes: 16384 } } : {}),
    ...(inactive === 'profile-mismatch' ? { policy: { documentKeys: [KEY], slotBytes: 16384, profiles: [{ id: 'review', revision: 'a'.repeat(64) }] } } : {}) });
  const before = hostRows(f.dbPath), result = await f.consume(); assert.equal(result.run.state, 'completed', JSON.stringify(result.run.error)); assert.ok(result.request); assert.equal(evidence(result.request).length, 0);
  if (inactive === 'default-off') assert.equal(f.engine.context.diagnostics(result.session.id)!.knowledgeContext, undefined);
  else assert.equal(diagnostics(f.engine, result.session.id).omissions[0]!.reason, inactive === 'profile-mismatch' ? 'profile-not-selected' : 'missing');
  f.assertNoExtraHostEffects(before); assert.equal(f.counts().generationCalls, 1);
});

test('actual existing native document update consumes current postimage once and historical getters do not reactivate old body', async t => {
  const f = await fixture(t), next = await f.candidate(f.engine, SECOND_BODY), updated = await f.publish(f.engine, next, 'approve-context-postimage-update'), before = hostRows(f.dbPath), result = await f.consume();
  assert.equal(result.run.state, 'completed'); assert.ok(result.request); assert.equal(evidence(result.request).length, 0); assert.equal(evidence(result.request, 'knowledge_marker_second_postimage').length, 1);
  assert.equal(diagnostics(f.engine, result.session.id).documents[0]!.documentRevision, 2); assert.equal(diagnostics(f.engine, result.session.id).documents[0]!.documentRevisionId, updated.document.id);
  assert.equal(f.engine.getWorkspaceKnowledgePublication(f.workspace.id, f.publication!.publication.id).document!.body, BODY); assert.equal(f.engine.workspaceKnowledge.getCandidate(f.workspace.id, f.first.id)!.state, 'pending');
  f.assertNoExtraHostEffects(before); assert.equal(f.counts().generationCalls, 2);
});

for (const mutation of ['revoke', 'source-edit', 'source-delete', 'trust-file', 'trust-deny', 'import-pause'] as const) test(`actual ${mutation} before context planning omits active authority while preserving historical records`, async t => {
  const f = await fixture(t);
  if (mutation === 'revoke') await f.engine.revokeWorkspaceKnowledge({ workspaceId: f.workspace.id, requestId: 'revoke-before-active-context', approved: true, preview: f.engine.previewWorkspaceKnowledgeRevocation({ workspaceId: f.workspace.id, publicationId: f.publication!.publication.id }) });
  if (mutation === 'source-edit') writeFileSync(join(f.root, 'source.ts'), 'export const selectedSource = 2;\n');
  if (mutation === 'source-delete') unlinkSync(join(f.root, 'source.ts'));
  if (mutation === 'trust-file') writeFileSync(join(f.root, 'AGENTS.md'), 'Changed instructions were not approved.\n');
  if (mutation === 'trust-deny') await f.engine.setWorkspaceTrust({ workspaceId: f.workspace.id, requestId: 'deny-active-context', expectedRevision: f.trust.revision, decision: 'deny' });
  if (mutation === 'import-pause') f.engine.store.pauseImportedWorkspaceKnowledge(f.workspace.id, 'a'.repeat(64));
  const before = hostRows(f.dbPath), result = await f.consume(); assert.equal(result.run.state, 'completed', JSON.stringify(result.run.error)); assert.ok(result.request); assert.equal(evidence(result.request).length, 0);
  const omission = diagnostics(f.engine, result.session.id).omissions[0]!; assert.equal(omission.reason, mutation === 'revoke' ? 'revoked' : mutation.startsWith('source') ? 'stale' : mutation === 'import-pause' ? 'paused' : 'untrusted');
  assert.equal(f.engine.getWorkspaceKnowledgePublication(f.workspace.id, f.publication!.publication.id).document!.body, BODY); f.assertNoExtraHostEffects(before); assert.equal(f.counts().generationCalls, 1);
});

for (const mutation of ['source-edit', 'source-delete', 'trust-file', 'import-pause'] as const) test(`actual ${mutation} after original ContextPlan capture blocks native provider dispatch without rewriting frozen messages`, async t => {
  let capturedText = '', captures = 0;
  const f = await fixture(t, { beforeModel(engine, runId) { captures++; const run = engine.store.getRun(runId); capturedText = engine.store.getLatestContextRevision(run.sessionId)!.text;
    if (mutation === 'source-edit') writeFileSync(join(engine.store.getWorkspace(run.workspaceId).root, 'source.ts'), 'export const selectedSource = 9;\n');
    if (mutation === 'source-delete') unlinkSync(join(engine.store.getWorkspace(run.workspaceId).root, 'source.ts'));
    if (mutation === 'trust-file') writeFileSync(join(engine.store.getWorkspace(run.workspaceId).root, 'AGENTS.md'), 'Changed after frozen context.\n');
    if (mutation === 'import-pause') engine.store.pauseImportedWorkspaceKnowledge(run.workspaceId, 'b'.repeat(64));
  } });
  const result = await f.consume(); assert.equal(captures, 1); assert.equal(result.run.state, 'failed', JSON.stringify(result.run.error)); assert.equal(f.requests.length, 0); assert.ok(result.run.error?.code.startsWith('KNOWLEDGE_'));
  const revision = f.engine.store.getLatestContextRevision(result.session.id)!; assert.equal(revision.text, capturedText); assert.ok(capturedText.includes(MARKER));
  const attempts = readDb(f.dbPath, db => db.prepare('SELECT id FROM provider_attempts WHERE run_id=?').all(result.run.id)); assert.equal(attempts.length, 0, 'Run owner rejects stale captured context before allocating any provider intent');
  assert.equal(f.counts().generationCalls, 1);
});

test('actual same-Turn retry rechecks physical knowledge source after confirmed producer cleanup and never dispatches stale frozen input', async t => {
  let returned = 0, root = '';
  const f = await fixture(t, { stream() { const iterator: AsyncIterableIterator<ProviderEvent> = { [Symbol.asyncIterator]() { return iterator; }, async next() { throw new EngineError('PROVIDER_HTTP_ERROR', 'Actual retry boundary fixture', { status: 429, retryAfterMs: 0 }); }, async return() { returned++; writeFileSync(join(root, 'source.ts'), 'export const selectedSource = 7;\n'); return { done: true, value: undefined }; } }; return iterator; } }); root = f.root;
  const result = await f.consume(); assert.equal(result.run.state, 'failed'); assert.equal(f.requests.length, 1); assert.equal(returned, 1); assert.equal(evidence(f.requests[0]!).length, 1);
  const attempts = readDb(f.dbPath, db => db.prepare('SELECT id FROM provider_attempts WHERE run_id=? ORDER BY attempt_index').all(result.run.id)); assert.equal(attempts.length, 2);
  const first = f.engine.store.getAttempt(String(attempts[0]!.id)), denied = f.engine.store.getAttempt(String(attempts[1]!.id)); assert.equal(first.turnId, denied.turnId); assert.equal(first.contextRevisionId, denied.contextRevisionId); assert.equal(denied.dispatchedAt, undefined);
  assert.equal(f.engine.store.getAttemptCleanup(first.id).state, 'confirmed'); assert.equal(f.engine.store.getAttemptCleanup(denied.id).state, 'not-dispatched'); assert.equal(f.counts().generationCalls, 1);
});

test('actual steer accepted after frozen context capture cannot authorize stale knowledge or rewrite its original provider input', async t => {
  let steerId = '', capturedText = '';
  const f = await fixture(t, { beforeModel(engine, runId) {
    const run = engine.store.getRun(runId); capturedText = engine.store.getLatestContextRevision(run.sessionId)!.text;
    engine.scheduler.pause(run.sessionId);
    steerId = engine.scheduler.accept({ sessionId: run.sessionId, requestId: 'actual-post-capture-steer', prompt: 'Original newly accepted steer remains exact.', delivery: 'steer', config: run.config }).inputId;
    writeFileSync(join(engine.store.getWorkspace(run.workspaceId).root, 'source.ts'), 'export const selectedSource = 11;\n');
  } });
  const result = await f.consume(); assert.equal(result.run.state, 'failed', JSON.stringify(result.run.error)); assert.equal(f.requests.length, 0); assert.ok(result.run.error?.code.startsWith('KNOWLEDGE_'));
  assert.equal(f.engine.store.getLatestContextRevision(result.session.id)!.text, capturedText); assert.ok(capturedText.includes(MARKER)); assert.equal(capturedText.includes('Original newly accepted steer remains exact.'), false);
  const originalSteer = f.engine.store.getInput(steerId); assert.equal(originalSteer.prompt, 'Original newly accepted steer remains exact.'); assert.equal(originalSteer.state, 'pending');
  assert.equal(count(f.dbPath, 'provider_attempts'), 1, 'Only the original completed source Run dispatched an Attempt'); assert.equal(f.counts().generationCalls, 1);
});

test('actual required current exchange survives a tiny knowledge slot with explicit whole-document omission', async t => {
  const f = await fixture(t, { slotBytes: 32, limit: 2048 }), before = hostRows(f.dbPath), prompt = 'Current input must stay exact "quoted" 한글😀.', result = await f.consume(f.engine, prompt);
  assert.equal(result.run.state, 'completed', JSON.stringify(result.run.error)); assert.ok(result.request); assert.equal(result.request.messages.at(-1)!.content, prompt); assert.equal(evidence(result.request).length, 0);
  assert.equal(diagnostics(f.engine, result.session.id).omissions[0]!.reason, 'context-budget'); assert.ok(Buffer.byteLength(JSON.stringify({ messages: result.request.messages, tools: result.request.tools })) <= 2048); f.assertNoExtraHostEffects(before);
});

test('actual repository and knowledge entries share complete native context reservation without double spending', async t => {
  const f = await fixture(t, { repository: true, limit: 65536 }), result = await f.consume(); assert.equal(result.run.state, 'completed', JSON.stringify(result.run.error)); assert.ok(result.request);
  assert.equal(evidence(result.request).length, 1); const repository = result.request.messages.filter(message => message.content.includes('repository_optional_marker')); assert.equal(repository.length, 1);
  const plan = f.engine.context.diagnostics(result.session.id)!.plan; assert.equal(plan.reservations.repositoryBytes, Buffer.byteLength(JSON.stringify(repository[0])) + 1); assert.equal(plan.reservations.knowledgeBytes, Buffer.byteLength(JSON.stringify(evidence(result.request)[0])) + 1);
  assert.equal(plan.bytes, Buffer.byteLength(JSON.stringify(result.request.messages)) + plan.reservations.envelopeBytes); assert.ok(plan.bytes <= plan.byteLimit); assert.equal(result.request.messages.at(-1)!.content, result.run.prompt);
});

test('actual same physical storage restart consumes approved native document without generation or publication replay', async t => {
  const f = await fixture(t), before = hostRows(f.dbPath); await f.engine.close(); const restored = f.reopen(), result = await f.consume(restored);
  assert.equal(result.run.state, 'completed', JSON.stringify(result.run.error)); assert.ok(result.request); assert.equal(evidence(result.request).length, 1); assert.equal(diagnostics(restored, result.session.id).documents[0]!.publicationId, f.publication!.publication.id);
  f.assertNoExtraHostEffects(before); assert.deepEqual(f.counts(), { seedCalls: 1, generationCalls: 1 });
});

test('actual caller policy array mutation cannot alter normalized host-selected document keys', async t => {
  const input = { documentKeys: [KEY], slotBytes: 16384 }, f = await fixture(t, { policy: input }); input.documentKeys[0] = 'unapproved.memory'; input.slotBytes = 1;
  const result = await f.consume(); assert.equal(result.run.state, 'completed'); assert.ok(result.request); assert.equal(evidence(result.request).length, 1); assert.equal(diagnostics(f.engine, result.session.id).documents[0]!.documentKey, KEY);
});

test('actual candidate expiry omits approved data after its original deadline without altering historical publication', async t => {
  const f = await fixture(t, { expiryMs: 1000 });
  await pause(Math.max(0, Date.parse(f.first.expiresAt) - Date.now() + 2));
  const before = hostRows(f.dbPath), result = await f.consume(); assert.equal(result.run.state, 'completed', JSON.stringify(result.run.error)); assert.ok(result.request);
  assert.equal(evidence(result.request).length, 0); assert.equal(diagnostics(f.engine, result.session.id).omissions[0]!.reason, 'expired');
  assert.equal(f.engine.getWorkspaceKnowledgePublication(f.workspace.id, f.publication!.publication.id).document!.body, BODY); f.assertNoExtraHostEffects(before);
});

test('actual historical generation and approval operation deadlines remain historical after close and reopen', async t => {
  const f = await fixture(t, { generationDurationMs: 250, publicationDurationMs: 400 }), generation = f.engine.getWorkspaceKnowledgeGeneration(f.workspace.id, f.first.generationOwnerId).generation;
  await f.engine.close(); await pause(Math.max(0, Math.max(generation.deadline, Date.parse(f.publication!.publication.expiresAt)) - Date.now() + 2));
  const before = hostRows(f.dbPath), reopened = f.reopen(), result = await f.consume(reopened); assert.equal(result.run.state, 'completed', JSON.stringify(result.run.error)); assert.ok(result.request);
  assert.equal(evidence(result.request).length, 1); assert.ok(Date.now() >= generation.deadline); assert.ok(Date.now() >= Date.parse(f.publication!.publication.expiresAt)); assert.ok(Date.now() < Date.parse(f.first.expiresAt));
  f.assertNoExtraHostEffects(before); assert.equal(f.counts().generationCalls, 1);
});

test('actual exact persisted agent profile selection grants data only to its host-selected immutable revision', async t => {
  const f = await fixture(t), profile = f.engine.profiles.list().find(profile => profile.id === 'review')!; assert.ok(profile);
  await f.engine.close(); const engine = f.reopen({ knowledgeContextPolicy: { documentKeys: [KEY], slotBytes: 16384, profiles: [{ id: profile.id, revision: profile.revision }] } });
  const outside = await f.consume(engine); assert.equal(outside.run.state, 'completed'); assert.ok(outside.request); assert.equal(evidence(outside.request).length, 0); assert.equal(diagnostics(engine, outside.session.id).omissions[0]!.reason, 'profile-not-selected');
  const before = hostRows(f.dbPath), selected = await f.consume(engine, 'Actual immutable review owner.', { agentProfileId: 'review' }); assert.equal(selected.run.state, 'completed'); assert.ok(selected.request); assert.equal(evidence(selected.request).length, 1);
  assert.equal(selected.run.config.agentProfileRevision, profile.revision); assert.deepEqual(diagnostics(engine, selected.session.id).owner.profile, { id: profile.id, revision: profile.revision }); f.assertNoExtraHostEffects(before);
});

test('actual archive relocation preserves historical publication yet imported workspace has no active context authority', async t => {
  const f = await fixture(t); await f.engine.close(); const archive = await exportEngineArchive({ dbPath: f.dbPath, artifactDir: f.artifactDir, destination: join(f.base, 'archive') });
  const imported = await importEngineArchive({ directory: archive.directory, destination: join(f.base, 'imported') });
  const engine = f.reopen({ dbPath: imported.dbPath, artifactDir: imported.artifactDir }), before = hostRows(imported.dbPath);
  assert.equal(engine.getWorkspaceKnowledgePublication(f.workspace.id, f.publication!.publication.id).document!.body, BODY); assert.equal(engine.workspaceKnowledge.getImportPause(f.workspace.id)!.state, 'paused');
  const result = await f.consume(engine); assert.equal(result.run.state, 'completed', JSON.stringify(result.run.error)); assert.ok(result.request); assert.equal(evidence(result.request).length, 0); assert.equal(diagnostics(engine, result.session.id).omissions[0]!.reason, 'paused');
  assert.deepEqual(hostRows(imported.dbPath), before); assert.equal(count(imported.dbPath, 'tools'), 0); assert.deepEqual(f.counts(), { seedCalls: 1, generationCalls: 1 });
});

test('actual small joint repository and knowledge budget preserves required input and omits whole optional document', async t => {
  const f = await fixture(t, { repository: true, limit: 2048 }), prompt = 'Actual required small exchange 한글😀.', result = await f.consume(f.engine, prompt);
  assert.equal(result.run.state, 'completed', JSON.stringify(result.run.error)); assert.ok(result.request); assert.equal(result.request.messages.at(-1)!.content, prompt); assert.equal(evidence(result.request).length, 0);
  const plan = f.engine.context.diagnostics(result.session.id)!.plan; assert.ok(plan.bytes <= 2048); assert.equal(plan.bytes, Buffer.byteLength(JSON.stringify(result.request.messages)) + plan.reservations.envelopeBytes); assert.equal(plan.reservations.knowledgeBytes ?? 0, 0); assert.equal(diagnostics(f.engine, result.session.id).omissions[0]!.reason, 'context-budget');
});

test('actual isolated child does not inherit parent host knowledge selector or original active body', { timeout: 15000 }, async t => {
  const parentEntered = deferred(), release = deferred(), childEntered = deferred(); t.after(release.resolve);
  let engine!: Engine, childRequest: TurnRequest | undefined, childObservation: unknown = 'not observed';
  const f = await fixture(t, { stream(request, signal) { return (async function* () {
    if (request.messages.some(message => message.content === 'Actual held knowledge parent.')) { parentEntered.resolve(); yield { type: 'progress' as const }; await waitOrAbort(release, signal); }
    else if (request.messages.some(message => message.content === 'Actual isolated knowledge child.')) {
      childRequest = structuredClone(request);
      const executions = Reflect.get(engine.children, 'executions') as Map<string, { engine: Engine; sessionId: string }>;
      const child = [...executions.values()].find(item => item.sessionId === request.sessionId); assert.ok(child, 'Actual child execution owns its real Engine before provider dispatch');
      childObservation = child.engine.context.diagnostics(child.sessionId)!.knowledgeContext; childEntered.resolve();
    }
    yield { type: 'text.delta' as const, delta: 'Actual isolated consumer result.' }; yield { type: 'finish' as const, reason: 'stop' as const };
  })(); } }); engine = f.engine;
  execFileSync('git', ['-C', f.root, 'add', 'AGENTS.md', 'source.ts', 'navigation.ts']); execFileSync('git', ['-C', f.root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Actual independent worktree fixture']);
  const session = await command<Session>(engine, 'session.create', { workspaceId: f.workspace.id }), worktree = await engine.createWorktree(session.id, 'prepare');
  const parent = await command<RunReceipt>(engine, 'run.submit', { sessionId: session.id, requestId: 'knowledge-parent', prompt: 'Actual held knowledge parent.' });
  await Promise.race([parentEntered.promise, engine.waitForRun(parent.runId).then(run => assert.fail(`Parent ended before actual child admission: ${run.state}/${run.error?.code}`))]);
  const child = await engine.startChildTask({ sessionId: session.id, requestId: 'knowledge-child', parentRunId: parent.runId, worktreeId: worktree.id, prompt: 'Actual isolated knowledge child.', tools: [], allocation: { turns: 1, toolCalls: 1, outputBytes: 4096, durationMs: 5000 } });
  const outcome = await engine.children.tasks.wait(session.id, child.id); assert.equal(outcome.state, 'completed', JSON.stringify(outcome)); await childEntered.promise;
  assert.ok(childRequest); assert.equal(evidence(childRequest).length, 0); assert.equal(childObservation, undefined, 'Child ContextService has no inherited knowledge source even if child storage has no documents');
  assert.equal(evidence(f.requests.find(request => request.runId === parent.runId)!).length, 1); release.resolve(); assert.equal((await engine.waitForRun(parent.runId)).state, 'completed'); await engine.waitForSession(session.id); assert.equal(f.counts().generationCalls, 1);
});

for (const invalid of ['getter', 'proxy', 'sparse', 'unknown', 'over-keys', 'over-slot'] as const) test(`actual Engine ${invalid} knowledge policy fails before creating storage or running executable properties`, t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-invalid-knowledge-policy-'))); t.after(() => rmSync(base, { recursive: true, force: true }));
  let reads = 0, policy: unknown = { documentKeys: [KEY], slotBytes: 4096 };
  if (invalid === 'getter') policy = Object.defineProperty({ slotBytes: 4096 }, 'documentKeys', { enumerable: true, get() { reads++; return [KEY]; } });
  if (invalid === 'proxy') policy = new Proxy(policy as object, { get() { reads++; throw new Error('Proxy must not execute'); }, ownKeys() { reads++; throw new Error('Proxy must not execute'); }, getPrototypeOf() { reads++; throw new Error('Proxy must not execute'); } });
  if (invalid === 'sparse') policy = { documentKeys: [KEY, , 'another.memory'], slotBytes: 4096 };
  if (invalid === 'unknown') policy = { documentKeys: [KEY], slotBytes: 4096, autoApprove: true };
  if (invalid === 'over-keys') policy = { documentKeys: ['a', 'b', 'c', 'd', 'e'], slotBytes: 4096 };
  if (invalid === 'over-slot') policy = { documentKeys: [KEY], slotBytes: 16385 };
  assert.throws(() => Reflect.apply(createEngine, undefined, [{ dbPath: join(base, 'engine.sqlite'), artifactDir: join(base, 'artifacts'), knowledgeContextPolicy: policy }]), error => error instanceof EngineError);
  assert.equal(reads, 0); assert.equal(existsSync(join(base, 'engine.sqlite')), false); assert.equal(existsSync(join(base, 'artifacts')), false);
});
