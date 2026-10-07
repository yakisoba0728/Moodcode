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
import type { KnowledgeGenerationAttempt, KnowledgeGenerationRecord } from './generation-types.js';
import type { KnowledgeCandidate } from './types.js';
import { sha256 } from './validation.js';

type Phase = 'create' | 'prepare' | 'dispatch' | 'finish' | 'settle' | 'candidate';
interface Boundary { phase: Phase; generation: KnowledgeGenerationRecord; attempt: KnowledgeGenerationAttempt | null; candidate: KnowledgeCandidate | null }
interface ActualCall { owner: { kind: 'host-generation'; workspaceId: string; generationId: string; attemptId: string }; sha256: string; bytes: number }
const phases: readonly Phase[] = ['create', 'prepare', 'dispatch', 'finish', 'settle', 'candidate'];
const OUTPUT = 'Native child output before crash.\n';
const KNOWN_USAGE = { inputTokens: 11, outputTokens: 5, cachedInputTokens: 3, reasoningTokens: 1 };
const UNKNOWN_USAGE = { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null };
const CODING_TABLES = ['sessions', 'runs', 'messages', 'tools', 'approvals', 'checkpoints', 'session_turns', 'provider_attempts', 'context_revisions', 'summary_attempts', 'summary_usage'] as const;
function readonlyDb<T>(path: string, operation: (db: DatabaseSync) => T): T { const db = new DatabaseSync(path, { readOnly: true }); try { return operation(db); } finally { db.close(); } }
function codingRows(path: string): Record<string, unknown[]> {
  return readonlyDb(path, db => Object.fromEntries(CODING_TABLES.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}
function calls(directory: string): ActualCall[] {
  const path = join(directory, 'generation-calls.jsonl'); return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as ActualCall) : [];
}
function nativeRows(dbPath: string) {
  return readonlyDb(dbPath, db => ({ generations: db.prepare('SELECT data FROM knowledge_generations ORDER BY id').all().map(row => JSON.parse(String(row.data)) as KnowledgeGenerationRecord),
    attempts: db.prepare('SELECT data FROM knowledge_generation_attempts ORDER BY id').all().map(row => JSON.parse(String(row.data)) as KnowledgeGenerationAttempt),
    candidates: db.prepare('SELECT data FROM knowledge_candidates ORDER BY id').all().map(row => JSON.parse(String(row.data)) as KnowledgeCandidate) }));
}
async function launch(t: TestContext, directory: string, phase: Phase) {
  const source = import.meta.url.endsWith('.ts'), childPath = fileURLToPath(new URL(`./fixtures/generation-crash-child.${source ? 'ts' : 'js'}`, import.meta.url));
  const loaderPath = fileURLToPath(new URL('../../../../node_modules/tsx/dist/loader.mjs', import.meta.url));
  const child = spawn(process.execPath, [...(source ? ['--import', loaderPath] : []), childPath, directory, phase], { cwd: directory, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr?.on('data', value => { stderr = (stderr + String(value)).slice(-16384); });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const deadline = Date.now() + 15000, readyPath = join(directory, 'crash-ready.json');
  while (!existsSync(readyPath)) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Actual child exited before ${phase}: ${stderr}`);
    assert.ok(Date.now() < deadline, `Actual child failed to commit ${phase}: ${stderr}`); await pause(15);
  }
  const ready = JSON.parse(readFileSync(readyPath, 'utf8')) as Boundary; assert.equal(ready.phase, phase);
  return { child, exited, ready };
}

async function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-generation-crash-'))), root = join(directory, 'repository'), dbPath = join(directory, 'engine.sqlite');
  mkdirSync(root); execFileSync('git', ['init', '--quiet', '--template=', root]);
  writeFileSync(join(root, 'AGENTS.md'), 'Host approved crash fixture instructions.\n'); writeFileSync(join(root, 'source.ts'), 'export const frozenSource = 1;\n');
  let codingCalls = 0, generationCalls = 0;
  const provider: ProviderAdapter = { id: 'generation-crash-fixture', async *streamTurn() { codingCalls++; yield { type: 'text.delta', delta: 'Actual settled coding source selected for crash generation.' }; yield { type: 'finish', reason: 'stop' }; },
    streamGeneration() { generationCalls++; throw new Error('Reopening or finishing must never replay a provider'); } };
  const options = { dbPath, artifactDir: join(directory, 'artifacts'), providers: [provider], knowledgeGeneration: true,
    defaults: { providerId: provider.id, modelId: 'fixture-model', mode: 'plan' as const, limits: { maxTurns: 3, maxDurationMs: 10000 } } };
  const original = createEngine(options), engines = new Set([original]);
  t.after(async () => { for (const engine of engines) await engine.close(); rmSync(directory, { recursive: true, force: true }); });
  const dispatch = async <T>(type: string, payload: JsonObject): Promise<T> => { const reply = await original.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload }); assert.equal(reply.ok, true, JSON.stringify(reply.error)); return reply.result as unknown as T; };
  const workspace = await dispatch<Workspace>('workspace.open', { path: root }), session = await dispatch<Session>('session.create', { workspaceId: workspace.id });
  const run = await dispatch<RunReceipt>('run.submit', { sessionId: session.id, requestId: 'settled-crash-source', prompt: 'Only source the later independent host operation.' });
  assert.equal((await original.waitForRun(run.runId)).state, 'completed'); await original.waitForSession(session.id);
  const message = original.store.getSnapshot(session.id).messages.find(value => value.role === 'assistant')!; assert.ok(message);
  const trust = await original.setWorkspaceTrust({ workspaceId: workspace.id, requestId: 'trust-crash-source', expectedRevision: 0, decision: 'allow', preview: original.previewWorkspaceTrust(workspace.id, ['AGENTS.md']) });
  const selection = [{ kind: 'file' as const, path: 'source.ts' }, { kind: 'message' as const, sessionId: session.id, messageId: message.id, runId: run.runId }];
  const projection = original.captureWorkspaceKnowledgeSources(workspace.id, selection), logical = original.previewWorkspaceKnowledgeGeneration({ providerId: provider.id, modelId: 'fixture-model', projection });
  const plan = await original.prepareWorkspaceKnowledgeGeneration({ workspaceId: workspace.id, requestId: 'crash-exact-plan', expectedTrustRevision: trust.revision, projection,
    target: original.captureWorkspaceKnowledgeTarget(workspace.id, 'MOODCODE_MEMORY.md'), providerId: provider.id, modelId: 'fixture-model', requestSha256: logical.requestSha256, requestBytes: logical.requestBytes,
    maxOutputBytes: 1024, expiresAt: new Date(Date.now() + 90000).toISOString() });
  const requestId = 'crash-actual-generation';
  writeFileSync(join(directory, 'crash-config.json'), JSON.stringify({ workspaceId: workspace.id, planId: plan.id, requestId, requestSha256: logical.requestSha256, requestBytes: logical.requestBytes, selection }), { mode: 0o600 });
  const before = codingRows(dbPath); await original.close();
  return { directory, root, dbPath, workspace, plan, requestId, before, selection,
    reopen() { const engine = createEngine(options); engines.add(engine); return engine; },
    assertNoReplay() { assert.equal(generationCalls, 0); assert.equal(codingCalls, 1); assert.deepEqual(codingRows(dbPath), before); assert.equal(existsSync(join(directory, 'unexpected-coding.log')), false); assert.equal(existsSync(join(root, 'MOODCODE_MEMORY.md')), false); },
  };
}

for (const phase of phases) test(`real Engine SIGKILL after native ${phase} preserves durable evidence and never automatically replays generation`, { skip: process.platform === 'win32', timeout: 25000 }, async t => {
  const f = await fixture(t), { child, exited, ready } = await launch(t, f.directory, phase);
  const expectedState = phase === 'create' || phase === 'prepare' ? 'prepared' : phase === 'dispatch' ? 'dispatched' : phase === 'finish' ? 'output-finished' : 'completed';
  assert.equal(ready.generation.state, expectedState); assert.equal(ready.generation.workspaceId, f.workspace.id); assert.equal(ready.generation.planId, f.plan.id); assert.equal(ready.generation.candidate.state, 'pending');
  const originalCalls = calls(f.directory); assert.equal(originalCalls.length, ['finish', 'settle', 'candidate'].includes(phase) ? 1 : 0);
  if (phase === 'create') assert.equal(ready.attempt, null);
  else { assert.ok(ready.attempt); assert.equal(ready.attempt.state, expectedState); assert.equal(ready.generation.attemptId, ready.attempt.id); }
  if (originalCalls.length) {
    assert.deepEqual(originalCalls[0]!.owner, { kind: 'host-generation', workspaceId: f.workspace.id, generationId: ready.generation.id, attemptId: ready.attempt!.id });
    assert.equal(originalCalls[0]!.sha256, ready.attempt!.exactDispatchSha256); assert.equal(originalCalls[0]!.bytes, ready.attempt!.exactDispatchBytes);
    assert.equal(ready.attempt!.output, OUTPUT); assert.deepEqual(ready.attempt!.usage, KNOWN_USAGE); assert.equal(ready.attempt!.finishReason, 'stop');
    assert.equal(ready.attempt!.streamDone, phase !== 'finish');
  } else if (ready.attempt) { assert.equal(ready.attempt.output, ''); assert.deepEqual(ready.attempt.usage, UNKNOWN_USAGE); assert.equal(ready.attempt.dispatchedAt !== null, phase === 'dispatch'); }
  assert.equal(ready.candidate !== null, phase === 'candidate');
  const committed = nativeRows(f.dbPath); assert.deepEqual(committed.generations, [ready.generation]); assert.deepEqual(committed.attempts, ready.attempt ? [ready.attempt] : []); assert.deepEqual(committed.candidates, ready.candidate ? [ready.candidate] : []);
  assert.deepEqual(codingRows(f.dbPath), f.before); child.kill('SIGKILL'); await exited; assert.equal(child.signalCode, 'SIGKILL');
  const restored = f.reopen(), result = restored.getWorkspaceKnowledgeGeneration(f.workspace.id, ready.generation.id);
  const recoveredState = expectedState === 'prepared' ? 'cancelled' : expectedState === 'completed' ? 'completed' : 'uncertain';
  assert.equal(result.generation.state, recoveredState); assert.equal(result.generation.id, ready.generation.id); assert.equal(result.generation.planId, f.plan.id); assert.equal(result.candidate, null);
  if (phase === 'create') assert.equal(result.attempt, null);
  else {
    assert.ok(result.attempt); assert.equal(result.attempt.id, ready.attempt!.id); assert.equal(result.attempt.state, recoveredState);
    assert.equal(result.attempt.output, ready.attempt!.output); assert.equal(result.attempt.outputSha256, ready.attempt!.outputSha256); assert.deepEqual(result.attempt.usage, ready.attempt!.usage);
    assert.equal(result.attempt.exactDispatchSha256, ready.attempt!.exactDispatchSha256); assert.equal(result.attempt.exactDispatchBytes, ready.attempt!.exactDispatchBytes);
    assert.equal(result.attempt.streamDone, ready.attempt!.streamDone); assert.equal(result.attempt.finishReason, ready.attempt!.finishReason);
    if (phase === 'prepare') { assert.equal(result.attempt.cleanup!.confirmed, true); assert.equal(result.attempt.cleanup!.method, 'not-dispatched'); }
    if (phase === 'dispatch' || phase === 'finish') { assert.equal(result.attempt.cleanup!.confirmed, false); assert.equal(result.executionBlocked, true); }
  }
  const fresh = restored.captureWorkspaceKnowledgeSources(f.workspace.id, f.selection);
  const duplicate = await restored.generateWorkspaceKnowledge({ workspaceId: f.workspace.id, planId: f.plan.id, requestId: f.requestId, projection: fresh });
  assert.equal(duplicate.generation.id, ready.generation.id); assert.equal(duplicate.generation.state, recoveredState); assert.equal(duplicate.candidate, null);
  if (recoveredState === 'completed') {
    assert.deepEqual(result.generation, ready.generation); assert.deepEqual(result.attempt, ready.attempt); assert.equal(result.generation.candidate.state, 'pending');
    const finishInput = { workspaceId: f.workspace.id, generationId: ready.generation.id, requestId: 'explicit-crash-output-finish' };
    const finished = await restored.finishWorkspaceKnowledgeCandidate(finishInput); assert.ok(finished.candidate); assert.equal(finished.generation.state, 'completed'); assert.equal(finished.generation.candidate.state, 'recorded');
    assert.equal(finished.candidate.body, OUTPUT); assert.equal(finished.candidate.bodySha256, sha256(OUTPUT)); assert.deepEqual(finished.candidate.usage, KNOWN_USAGE); assert.equal(finished.candidate.generationOwnerId, ready.generation.id);
    if (phase === 'candidate') assert.deepEqual(finished.candidate, ready.candidate, 'Existing indexed candidate is reused after the marker gap');
    const again = await restored.finishWorkspaceKnowledgeCandidate(finishInput); assert.deepEqual(again.candidate, finished.candidate);
    assert.equal(nativeRows(f.dbPath).candidates.length, 1); assert.deepEqual(finished.attempt, ready.attempt);
  } else {
    await assert.rejects(restored.finishWorkspaceKnowledgeCandidate({ workspaceId: f.workspace.id, generationId: ready.generation.id, requestId: 'incomplete-cannot-append' }), error => error instanceof EngineError);
    assert.equal(nativeRows(f.dbPath).candidates.length, 0);
  }
  assert.deepEqual(calls(f.directory), originalCalls); assert.equal(existsSync(join(f.directory, 'iterator-returns.log')), false); f.assertNoReplay();
});
