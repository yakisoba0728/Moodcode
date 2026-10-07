import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as tick } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { EngineError, type RunConfig } from '@moodcode/contracts';
import { createEngine, type EngineOptions, type MoodcodeEngine } from '../engine.js';
import type { ProviderAdapter, ProviderEvent, ToolDefinition, TurnRequest } from '../ports.js';
import { SqliteStore } from '../storage/index.js';

const core = ['list_files', 'read_file', 'search_files', 'apply_patch', 'run_command', 'edit_file', 'rename_file', 'delete_file', 'glob_files', 'regex_search', 'todo_read', 'todo_write', 'ask_user', 'skill_list', 'skill_read', 'reference_read', 'read_artifact', 'format_file', 'lsp_format_file', 'merge_child_changes', 'delegate_task'];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const reservation = (request: TurnRequest) => bytes({ messages: [], tools: request.tools }) - 2;
const code = (expected: string) => (value: unknown) => value instanceof EngineError && value.code === expected;
type Program = (request: TurnRequest, signal: AbortSignal) => AsyncGenerator<ProviderEvent>;
const finish: Program = async function* (): AsyncGenerator<ProviderEvent> { yield { type: 'usage', inputTokens: 7, outputTokens: 1 }; yield { type: 'text.delta', delta: 'The authored eager boundary completed.' }; yield { type: 'finish', reason: 'stop' }; };
interface Fixture {
  engine: MoodcodeEngine; db: DatabaseSync; requests: TurnRequest[]; catalogueIdentities: Map<string, { registryRevision: number; policyVersion: number }>; directory: string; builds: { runId: string; reservedBytes: number | undefined }[];
  fullReads(): number; summaries(): number; prepares(name: string): number;
  submit(requestId?: string, prompt?: string): { runId: string; requestId: string; prompt: string; config: RunConfig };
  seed(): Promise<{ runId: string; original: unknown[] }>;
  add(name: string, schemaBytes?: number, execute?: () => Promise<void> | void): () => void;
}
async function fixture(t: TestContext, program: Program = finish, knownWindow = false): Promise<Fixture> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-eager-boundary-'))), root = join(directory, 'repository'); await mkdir(root); await writeFile(join(root, 'fixture.txt'), 'Authored eager context boundary.\n');
  const requests: TurnRequest[] = [], builds: Fixture['builds'] = [], prepares = new Map<string, number>(), catalogueIdentities: Fixture['catalogueIdentities'] = new Map(); let fullReads = 0, summaryCalls = 0;
  const provider: ProviderAdapter = { id: 'private-eager-boundary', async *streamTurn(request, signal): AsyncGenerator<ProviderEvent> {
    if (!request.tools.length) { summaryCalls++; assert.fail('The explicitly small summary-source cap must fail before provider entry'); }
    requests.push(structuredClone(request)); catalogueIdentities.set(request.attemptId!, { registryRevision: engine.toolRuntime.revision, policyVersion: engine.toolRuntime.policy.version }); if (request.messages.findLast(message => message.role === 'user')?.content.startsWith('Owned optional history: ')) yield* finish(request, signal); else yield* program(request, signal);
  } };
  const options: EngineOptions = {
    dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [provider],
    defaults: { providerId: provider.id, modelId: 'private-model', mode: 'build', limits: { maxContextBytes: knownWindow ? 65_536 : 32_768, maxDurationMs: 20_000, maxTurns: 5 }, budgets: { maxSummaryBytes: 1024, retryBaseDelayMs: 1 } },
    ...(knownWindow ? { outputTokenReserve: 1024, modelSpecs: [{ providerId: provider.id, modelId: 'private-model', contextWindow: 32_768, maxOutputTokens: 4096, modalities: ['text'] as const, tools: true, reasoning: false, nativeReplay: false, source: { kind: 'fixture' as const, observedAt: new Date().toISOString(), reference: 'authored-conservative-window' } }] } : {}),
  };
  const previous = SqliteStore.prototype.getSnapshot, trap = () => { fullReads++; throw new Error('Authored eager boundary forbids whole-session snapshots'); }; SqliteStore.prototype.getSnapshot = trap;
  let engine: MoodcodeEngine;
  try { engine = createEngine(options); engine.store.getSnapshot = trap; } finally { SqliteStore.prototype.getSnapshot = previous; }
  const db = new DatabaseSync(options.dbPath, { readOnly: true }), createdAt = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt }); engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Authored eager boundary', createdAt });
  const build = engine.context.build.bind(engine.context);
  engine.context.build = async (...args) => { builds.push({ runId: args[0].run!.id, reservedBytes: args[0].reservedBytes }); return build(...args); };
  const f: Fixture = {
    engine, db, requests, builds, catalogueIdentities, directory, fullReads: () => fullReads, summaries: () => summaryCalls, prepares: name => prepares.get(name) ?? 0,
    submit(requestId = 'target', prompt = 'Complete the short authored target.') { const config = engine.getCapabilities().defaults; const receipt = engine.scheduler.submitLegacy({ sessionId: 'session', requestId, prompt, config }); return { runId: receipt.runId, requestId, prompt, config }; },
    async seed() { const receipt = f.submit('seed', 'Owned optional history: ' + 'h'.repeat(16_384)); assert.equal((await engine.waitForRun(receipt.runId)).state, 'completed'); return { runId: receipt.runId, original: db.prepare('SELECT data FROM messages WHERE run_id=? ORDER BY ordinal').all(receipt.runId) }; },
    add(name, schemaBytes = 0, execute) {
      const tool: ToolDefinition = { name, effectClass: 'read', description: 'Authored inert catalogue boundary probe.', inputSchema: { type: 'object', description: 'x'.repeat(schemaBytes), properties: {} },
        async prepare() { prepares.set(name, (prepares.get(name) ?? 0) + 1); return { name, input: {}, fingerprint: 'private-' + name, preview: {}, requiresApproval: false }; },
        async execute() { if (!execute) assert.fail('A schema-only probe must never execute'); await execute!(); return { content: 'Owned completed read observation.' }; } };
      return engine.toolRuntime.register('engine', tool);
    },
  };
  t.after(async () => { await engine.close(); db.close(); await rm(directory, { recursive: true, force: true }); }); return f;
}
function audit(f: Fixture, runId: string, knownWindow = false) {
  const requests = f.requests.filter(request => request.runId === runId), events = f.engine.store.readEvents('session', 0, 200).filter(event => event.runId === runId && event.type === 'context.prepared');
  assert.equal(events.length, new Set(requests.map(request => request.turnIndex)).size);
  for (const request of requests) {
    const event = events.find(value => value.payload.turnIndex === request.turnIndex)!; assert.ok(event);
    assert.deepEqual(event.payload.advertisedToolNames, request.tools.map(tool => tool.name)); assert.equal(event.payload.toolCatalogueSha256, digest(request.tools)); assert.equal(event.payload.reservedToolBytes, reservation(request)); assert.equal(event.payload.bytes, bytes({ messages: request.messages, tools: request.tools }));
    const identity = f.catalogueIdentities.get(request.attemptId!)!; assert.equal(event.payload.registryRevision, identity.registryRevision); assert.equal(event.payload.policyVersion, identity.policyVersion); assert.ok(request.messages.some(message => message.role === 'user' && message.content === f.engine.store.getRun(runId).prompt));
    assert.equal(request.tools.some(tool => tool.name === 'discover_tools'), false); assert.deepEqual(request.tools.filter(tool => core.includes(tool.name)).map(tool => tool.name), core);
    assert.ok(bytes({ messages: request.messages, tools: request.tools }) <= (knownWindow ? 32_768 - 1024 : 32_768));
    const proof = f.engine.store.getAttemptCleanup(request.attemptId!); assert.equal(proof.state, 'confirmed'); assert.equal(proof.requestSha256, digest(request));
  }
  assert.equal(f.fullReads(), 0); assert.equal(f.summaries(), 0);
}
function originalInputs(f: Fixture, runId: string) { return f.db.prepare('SELECT data FROM messages WHERE run_id=? AND json_extract(data,\'$.role\')=\'user\' ORDER BY ordinal').all(runId); }

for (const knownWindow of [false, true]) test('eager async registry growth replans optional prior context using its exact ' + (knownWindow ? 'known conservative window' : 'byte reservation'), async t => {
  const f = await fixture(t, finish, knownWindow), seed = await f.seed(), build = f.engine.context.build.bind(f.engine.context); let changed = false;
  f.engine.context.build = async (...args) => { const messages = await build(...args); if (!changed) { changed = true; await tick(); f.add('growth_probe', 8192); } return messages; };
  const receipt = f.submit(), run = await f.engine.waitForRun(receipt.runId); assert.equal(run.state, 'completed'); assert.equal(changed, true);
  const requests = f.requests.filter(request => request.runId === receipt.runId); assert.equal(requests.length, 1); assert.ok(requests[0]!.tools.some(tool => tool.name === 'growth_probe'));
  assert.deepEqual(f.db.prepare('SELECT data FROM messages WHERE run_id=? ORDER BY ordinal').all(seed.runId), seed.original);
  const diagnostics = f.engine.context.diagnostics('session')!; assert.equal(diagnostics.plan.reservations.envelopeBytes, reservation(requests[0]!)); assert.ok(diagnostics.plan.omittedMessageCount >= 1); audit(f, receipt.runId, knownWindow);
});
test('policy change after an awaited eager plan is narrowed before dispatch and cannot prepare the denied handler', async t => {
  let effects = 0;
  const f = await fixture(t, async function* (request): AsyncGenerator<ProviderEvent> {
    if (!request.turnIndex) { yield { type: 'tool.call', call: { id: 'denied-proposal', name: 'policy_probe', input: {} } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes('TOOL_NOT_FOUND'))); yield* finish(request, new AbortController().signal); }
  }); f.add('policy_probe', 0, () => { effects++; }); const build = f.engine.context.build.bind(f.engine.context); let changed = false;
  f.engine.context.build = async (...args) => { const messages = await build(...args); if (!changed) { changed = true; await tick(); f.engine.toolRuntime.policy.replace([{ tool: 'policy_probe', decision: 'deny' }]); } return messages; };
  const receipt = f.submit(); assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed'); assert.equal(effects, 0); assert.equal(f.prepares('policy_probe'), 0); assert.equal(f.requests.length, 2); assert.ok(f.requests.every(request => !request.tools.some(tool => tool.name === 'policy_probe'))); assert.equal(f.engine.store.listPendingRunApprovals(receipt.runId).length, 0); audit(f, receipt.runId);
});
test('steers arriving during eager rebuilds are promoted before the actual catalogue dispatch cutoff', async t => {
  const f = await fixture(t), build = f.engine.context.build.bind(f.engine.context); const accepted: string[] = []; let changed = false;
  f.engine.context.build = async (...args) => {
    const messages = await build(...args), request = args[0]; await tick();
    if (accepted.length < 2) { const text = accepted.length ? 'Latest owned steer.' : 'First owned steer.'; const receipt = f.engine.scheduler.accept({ sessionId: 'session', requestId: 'steer-' + accepted.length, prompt: text, config: request.config, delivery: 'steer' }); accepted.push(receipt.inputId); }
    if (!changed) { changed = true; f.add('steer_schema_probe', 8192); } return messages;
  };
  const receipt = f.submit('target', 'Keep the original owned goal.'), run = await f.engine.waitForRun(receipt.runId); assert.equal(run.state, 'completed'); assert.equal(f.requests.length, 1);
  const input = f.requests[0]!; assert.ok(input.messages.some(message => message.role === 'user' && message.content === receipt.prompt)); assert.equal(input.messages.findLast(message => message.role === 'user')?.content, 'Latest owned steer.');
  assert.deepEqual(accepted.map(id => f.engine.store.getInput(id).state), ['promoted', 'promoted']); assert.ok(accepted.every(id => f.engine.store.getInput(id).runId === receipt.runId));
  assert.equal(originalInputs(f, receipt.runId).length, 3); assert.deepEqual(f.engine.store.listRunInputIds(receipt.runId), [f.engine.store.getRun(receipt.runId).inputId, ...accepted]); audit(f, receipt.runId);
});
test('eager regular-turn schema growth reserves the next catalogue while preserving the just-completed exchange', async t => {
  let effects = 0; let f!: Fixture;
  f = await fixture(t, async function* (request): AsyncGenerator<ProviderEvent> {
    if (request.turnIndex === 0) { yield { type: 'tool.call', call: { id: 'growth-read', name: 'growth_read', input: {} } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { assert.ok(request.messages.some(message => message.role === 'tool' && message.toolCallId === 'growth-read' && message.content.includes('Owned completed read observation.'))); yield* finish(request, new AbortController().signal); }
  }); f.add('growth_read', 0, () => { effects++; f.add('later_schema', 8192); }); const seed = await f.seed();
  const before = f.requests.length, receipt = f.submit(); assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed'); assert.equal(effects, 1, 'Only the target explicitly executes its own authored read');
  const requests = f.requests.slice(before); assert.equal(requests.length, 2); assert.ok(requests[1]!.tools.some(tool => tool.name === 'later_schema')); assert.deepEqual(f.db.prepare('SELECT data FROM messages WHERE run_id=? ORDER BY ordinal').all(seed.runId), seed.original); audit(f, receipt.runId);
});
test('a stable eager registry permits several regular turns without catalogue object-identity churn', async t => {
  let effects = 0;
  const f = await fixture(t, async function* (request): AsyncGenerator<ProviderEvent> {
    if (request.turnIndex < 2) { yield { type: 'tool.call', call: { id: 'stable-' + request.turnIndex, name: 'stable_probe', input: {} } }; yield { type: 'finish', reason: 'tool_calls' }; } else yield* finish(request, new AbortController().signal);
  }); f.add('stable_probe', 0, () => { effects++; }); const receipt = f.submit(); assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed'); assert.equal(f.requests.length, 3); assert.equal(effects, 1, 'The existing repeat-read cache preserves one physical callback for identical owned read input'); assert.equal(f.prepares('stable_probe'), 2); assert.ok(f.builds.length <= 4); assert.equal(new Set(f.requests.map(request => digest(request.tools))).size, 1); audit(f, receipt.runId);
});
test('sixteen asynchronous eager catalogue changes stop within the bounded plan allowance without provider entry', async t => {
  const f = await fixture(t), build = f.engine.context.build.bind(f.engine.context); let changes = 0, remove: (() => void) | undefined;
  f.engine.context.build = async (...args) => { const messages = await build(...args); await tick(); remove?.(); remove = f.add('churn_probe', ++changes); return messages; };
  const receipt = f.submit(), run = await f.engine.waitForRun(receipt.runId); assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'TOOL_CATALOGUE_STALE'); assert.ok(changes >= 16 && changes <= 32); assert.equal(f.requests.length, 0); assert.equal(f.engine.store.listTurns(receipt.runId).length, 0); assert.equal(originalInputs(f, receipt.runId).length, 1); assert.equal(f.fullReads(), 0); assert.equal(f.summaries(), 0);
});
test('cancellation after an asynchronous eager plan prevents all provider and tool dispatch', async t => {
  const f = await fixture(t), build = f.engine.context.build.bind(f.engine.context); let cancelled = false;
  f.engine.context.build = async (...args) => { const messages = await build(...args); await tick(); if (!cancelled) { cancelled = true; f.add('cancel_probe', 8192); f.engine.coordinator.cancel(args[0].run!.id); } return messages; };
  const receipt = f.submit(), run = await f.engine.waitForRun(receipt.runId); assert.equal(run.state, 'cancelled'); assert.equal(cancelled, true); assert.equal(f.requests.length, 0); assert.equal(f.engine.store.listTurns(receipt.runId).length, 0); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), false); assert.equal(originalInputs(f, receipt.runId).length, 1); assert.equal(f.fullReads(), 0);
});
test('an HTTP retry isolates adapter-local nested mutations and preserves eager catalogue and cleanup proof', async t => {
  let attempts = 0;
  const f = await fixture(t, async function* (request, signal): AsyncGenerator<ProviderEvent> { if (++attempts === 1) { request.tools[0]!.inputSchema.type = 'array'; request.tools[0]!.description = 'Authored adapter-local schema mutation.'; request.messages[0]!.content = 'Authored adapter-local text mutation.'; throw new EngineError('PROVIDER_HTTP_ERROR', 'Authored HTTP retry control.', { status: 503 }); } yield* finish(request, signal); }); f.add('retry_probe', 128);
  const receipt = f.submit(); assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed'); assert.equal(f.requests.length, 2); assert.equal(new Set(f.requests.map(request => digest(request.tools))).size, 1); assert.deepEqual(f.requests[1]!.messages, f.requests[0]!.messages); assert.equal(new Set(f.requests.map(request => request.turnId)).size, 1); assert.equal(new Set(f.requests.map(request => request.attemptId)).size, 2);
  const first = f.requests[0]!, cleanup = f.engine.store.getAttemptCleanup(first.attemptId!); assert.equal(cleanup.method, 'iterator-return-done'); assert.equal(cleanup.errorCode, 'PROVIDER_HTTP_ERROR'); assert.equal(f.engine.store.getAttempt(first.attemptId!).state, 'failed'); audit(f, receipt.runId);
});
test('a registry change during overflow recovery cannot retry eager old schemas using a new handler capture', async t => {
  let oldEffects = 0, newEffects = 0, recoveries = 0;
  const f = await fixture(t, async function* (): AsyncGenerator<ProviderEvent> { throw new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'Authored overflow requests context recovery.'); }); const remove = f.add('overflow_probe', 128, () => { oldEffects++; });
  // This authored host hook changes registry metadata only; it does not publish
  // semantic memory or create any cleanup evidence on behalf of the provider.
  f.engine.context.recoverOverflow = async () => { recoveries++; remove(); f.add('overflow_probe', 256, () => { newEffects++; }); };
  const receipt = f.submit(), run = await f.engine.waitForRun(receipt.runId); assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'TOOL_CATALOGUE_STALE'); assert.equal(recoveries, 1); assert.equal(f.requests.length, 1); assert.equal(oldEffects + newEffects, 0);
  const first = f.requests[0]!, cleanup = f.engine.store.getAttemptCleanup(first.attemptId!); assert.equal(cleanup.state, 'confirmed'); assert.equal(cleanup.method, 'iterator-return-done'); assert.equal(cleanup.errorCode, 'PROVIDER_CONTEXT_OVERFLOW'); assert.equal(cleanup.requestSha256, digest(first)); assert.equal(f.engine.store.getAttempt(first.attemptId!).state, 'failed'); assert.equal(f.engine.store.listTurns(receipt.runId)[0]!.state, 'failed'); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), false); assert.equal(f.fullReads(), 0);
});
