import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as tick } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { ContextRequest, ProviderAdapter, ProviderEvent, ToolDefinition, TurnRequest } from '../ports.js';
import { createEngine, type EngineOptions, type MoodcodeEngine } from '../engine.js';
import { SqliteStore } from '../storage/index.js';

// Scripted local requests and private Git/SQLite resources only. The plugin is
// an advertised schema, and every prepare/execute entry is forbidden by this fixture.
const coreNames = ['list_files', 'read_file', 'search_files', 'apply_patch', 'run_command', 'edit_file', 'rename_file', 'delete_file', 'glob_files', 'regex_search', 'todo_read', 'todo_write', 'ask_user', 'skill_list', 'skill_read', 'reference_read', 'read_artifact', 'format_file', 'lsp_format_file', 'merge_child_changes', 'delegate_task'];
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const shaText = (value: string) => createHash('sha256').update(value).digest('hex');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
type Program = (request: TurnRequest, signal: AbortSignal) => AsyncGenerator<ProviderEvent>;
interface FixtureOptions { knownWindow?: boolean; program?: Program }
interface BuildObservation { runId: string; reservedBytes: number; snapshotMessageCount: number; messagesBytes: number; planReservedBytes: number; planBytes: number }
interface Fixture {
  engine: MoodcodeEngine; db: DatabaseSync; requests: TurnRequest[]; targetRequests(): TurnRequest[];
  observations: BuildObservation[]; register(): void; observeBuild(hook?: (request: ContextRequest, index: number) => Promise<void>): void;
  wholeReads(): number; handlers(): number; submit(prompt?: string): { runId: string }; assertOriginal(): void;
}
async function fixture(t: TestContext, specification: FixtureOptions = {}): Promise<Fixture> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-eager-budget-integration-'))), repository = join(directory, 'repository');
  await mkdir(repository); await writeFile(join(repository, 'fixture.txt'), 'Private schema-budget fixture.\n');
  execFileSync('git', ['init', '-q', repository]); execFileSync('git', ['-C', repository, 'add', 'fixture.txt']);
  execFileSync('git', ['-C', repository, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'private authored fixture']);
  let phase: 'seed' | 'target' = 'seed', wholeReads = 0, handlers = 0, registered = false;
  const requests: TurnRequest[] = [], targetRequests: TurnRequest[] = [], observations: BuildObservation[] = [];
  const provider: ProviderAdapter = { id: 'private-eager-budget', async *streamTurn(request, signal): AsyncGenerator<ProviderEvent> {
    assert.ok(request.tools.length, 'The deliberately small complete-source summary cap rejects before any summary provider invocation');
    const observed = structuredClone(request); requests.push(observed); if (phase === 'target') targetRequests.push(observed);
    if (phase === 'target' && specification.program) { yield* specification.program(request, signal); return; }
    yield { type: 'usage', inputTokens: 7, outputTokens: 1 };
    yield { type: 'text.delta', delta: phase === 'seed' ? 'Private optional discussion was recorded.' : 'The private target completed.' };
    yield { type: 'finish', reason: 'stop' };
  } };
  const options: EngineOptions = { dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [provider],
    defaults: { providerId: provider.id, modelId: specification.knownWindow ? 'private-known-model' : 'private-unknown-model', mode: 'build',
      limits: { maxContextBytes: specification.knownWindow ? 65_536 : 32_768, maxDurationMs: 30_000 }, budgets: { maxSummaryBytes: 1024 } },
    ...(specification.knownWindow ? { outputTokenReserve: 1024, modelSpecs: [{ providerId: provider.id, modelId: 'private-known-model', contextWindow: 32_768,
      maxOutputTokens: 1024, modalities: ['text'], tools: true, reasoning: null, nativeReplay: null, source: { kind: 'fixture', observedAt: new Date().toISOString(), reference: 'authored-eager-budget-integration' } }] } : {}) };
  const previous = SqliteStore.prototype.getSnapshot;
  const trap = () => { wholeReads++; throw new Error('Eager budget integration forbids whole-session snapshots, including startup'); };
  SqliteStore.prototype.getSnapshot = trap;
  let engine: MoodcodeEngine;
  try { engine = createEngine(options); engine.store.getSnapshot = trap; } finally { SqliteStore.prototype.getSnapshot = previous; }
  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  t.after(async () => { try { await engine.close(); } finally { db.close(); await rm(directory, { recursive: true, force: true }); } });
  const createdAt = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Private eager catalogue budget', createdAt });
  assert.equal(engine.getCapabilities().tools.some(tool => tool.name === 'discover_tools'), false, 'The default route remains eager');
  assert.deepEqual(engine.toolRuntime.catalogue('engine').tools.map(tool => tool.name), coreNames);
  const config = engine.getCapabilities().defaults;
  const seed = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'seed', prompt: 'Owned optional history nonce: ' + 'h'.repeat(16_384), config });
  assert.equal((await engine.waitForRun(seed.runId)).state, 'completed'); phase = 'target';
  const history = () => db.prepare('SELECT data FROM messages WHERE run_id=? ORDER BY ordinal').all(seed.runId).map(row => shaText(String(row.data)));
  const original = history();
  const plugin: ToolDefinition = { name: 'growth_probe', description: 'Inert private schema reservation fixture.', effectClass: 'read',
    inputSchema: { type: 'object', properties: { payload: { type: 'string', description: 'x'.repeat(8192) } } },
    async prepare() { handlers++; throw new Error('The inert schema may not prepare'); }, async execute() { handlers++; throw new Error('The inert schema may not execute'); } };
  return { engine, db, requests, observations, targetRequests: () => targetRequests, wholeReads: () => wholeReads, handlers: () => handlers,
    register() { assert.equal(registered, false); engine.toolRuntime.register('eager-budget-plugin', plugin); engine.toolRuntime.setIncludedScopes('engine', ['eager-budget-plugin']); registered = true; },
    observeBuild(hook) { const build = engine.context.build.bind(engine.context); let index = 0;
      engine.context.build = async (request, summaryAttempted, prefixAttempted, forcePrefix) => {
        const ownIndex = index++; if (hook) await hook(request, ownIndex);
        const messages = await build(request, summaryAttempted, prefixAttempted, forcePrefix), diagnostics = engine.context.diagnostics('session'); assert.ok(diagnostics);
        observations.push({ runId: request.run!.id, reservedBytes: request.reservedBytes ?? 0, snapshotMessageCount: request.snapshot.messages.length,
          messagesBytes: bytes(messages), planReservedBytes: diagnostics.plan.reservations.envelopeBytes, planBytes: diagnostics.plan.bytes }); return messages;
      };
    },
    submit(prompt = 'Complete this short private target without executing tools.') { return engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'target', prompt, config }); },
    assertOriginal() { assert.deepEqual(history(), original); assert.equal(wholeReads, 0); assert.equal(handlers, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM summary_attempts').get()!.n, 0); assert.equal(db.prepare('SELECT count(*) AS n FROM mcp_executions').get()!.n, 0); },
  };
}
function assertContext(f: Fixture, runId: string, expectedTools: string[]) {
  const requests = f.targetRequests(), prepared = f.engine.store.readEvents('session', 0, 200).filter(event => event.runId === runId && event.type === 'context.prepared');
  assert.equal(prepared.length, requests.length);
  requests.forEach((request, index) => {
    const event = prepared[index]!, reserved = bytes({ messages: [], tools: request.tools }) - 2;
    assert.deepEqual(request.tools.map(tool => tool.name), expectedTools);
    assert.deepEqual(request.tools.filter(tool => coreNames.includes(tool.name)).map(tool => tool.name), coreNames);
    assert.equal(event.payload.reservedToolBytes, reserved); assert.equal(event.payload.toolCatalogueSha256, sha(request.tools));
    assert.deepEqual(event.payload.advertisedToolNames, expectedTools); assert.equal(typeof event.payload.registryRevision, 'number'); assert.equal(typeof event.payload.policyVersion, 'number');
    assert.equal(event.payload.bytes, bytes({ messages: request.messages, tools: request.tools })); assert.ok(Number(event.payload.bytes) <= Number(event.payload.limit));
  });
  const latest = requests.at(-1)!; assert.ok(latest);
  const diagnostics = f.engine.context.diagnostics('session'); assert.ok(diagnostics);
  assert.equal(diagnostics.plan.reservations.envelopeBytes, bytes({ messages: [], tools: latest.tools }) - 2);
  assert.equal(diagnostics.plan.bytes, bytes({ messages: latest.messages, tools: latest.tools }));
  assert.equal(diagnostics.plan.sha256, sha(latest.messages));
  assert.ok(diagnostics.plan.bytes <= diagnostics.plan.byteLimit);
  if (diagnostics.plan.tokenLimit !== null) assert.ok(bytes({ messages: latest.messages, tools: latest.tools }) + diagnostics.plan.reservations.outputTokens <= diagnostics.plan.tokenLimit,
    'The actual current schemas participate in the declared conservative model-window estimate');
  const revision = f.engine.store.getContextRevision(diagnostics.revisionId); assert.equal(revision.sha256, sha(latest.messages)); assert.equal(revision.runId, runId);
  f.assertOriginal();
}

for (const knownWindow of [false, true]) test(`eager async schema growth rebuilds ${knownWindow ? 'the known conservative model-window' : 'the byte-cap'} plan before dispatch`, async t => {
  const f = await fixture(t, { knownWindow }); f.observeBuild(async (_request, index) => { if (!index) { await tick(); f.register(); } });
  const receipt = f.submit(), run = await f.engine.waitForRun(receipt.runId);
  assert.equal(run.state, 'completed'); assert.equal(f.targetRequests().length, 1); assert.ok(f.observations.length >= 2, 'A registry change during the actual build causes a fresh bounded rebuild');
  assert.ok(f.observations.at(-1)!.reservedBytes > f.observations[0]!.reservedBytes);
  const plan = f.engine.context.diagnostics('session')!.plan; assert.ok(plan.omittedMessageCount >= 1); assertContext(f, receipt.runId, [...coreNames, 'growth_probe']);
  assert.equal(f.engine.store.listTurns(receipt.runId).length, 1); assert.equal(f.db.prepare('SELECT count(*) AS n FROM provider_attempts WHERE run_id=?').get(receipt.runId)!.n, 1);
});
for (const knownWindow of [false, true]) test(`eager pre-registered schema naturally projects optional history within ${knownWindow ? 'the model window' : 'the byte hard cap'}`, async t => {
  const f = await fixture(t, { knownWindow }); f.register(); f.observeBuild(); const receipt = f.submit();
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed'); assert.equal(f.targetRequests().length, 1); assert.equal(f.observations.length, 1);
  assert.ok(f.engine.context.diagnostics('session')!.plan.omittedMessageCount >= 1); assertContext(f, receipt.runId, [...coreNames, 'growth_probe']);
});
test('unchanged eager core catalogue retains fitting optional history with one context build', async t => {
  const f = await fixture(t); f.observeBuild(); const receipt = f.submit();
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed'); assert.equal(f.targetRequests().length, 1); assert.equal(f.observations.length, 1);
  assert.equal(f.engine.context.diagnostics('session')!.plan.omittedMessageCount, 0); assertContext(f, receipt.runId, coreNames);
});
test('completed ordinary tool-turn boundary refreshes eager schemas and history without invoking the plugin', async t => {
  const f = await fixture(t, { program: async function* (request): AsyncGenerator<ProviderEvent> {
    if (!request.turnIndex) { yield { type: 'usage', inputTokens: 9, outputTokens: 2 }; yield { type: 'tool.call', call: { id: 'private-unknown-call', name: 'fixture_unknown_no_handler', input: {} } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { yield { type: 'text.delta', delta: 'Private completion after the observed unavailable proposal.' }; yield { type: 'finish', reason: 'stop' }; }
  } });
  const putTurn = f.engine.store.putTurn.bind(f.engine.store); let registered = false;
  f.engine.store.putTurn = turn => { const result = putTurn(turn); if (turn.index === 0 && turn.state === 'completed' && !registered) { registered = true; f.register(); } return result; };
  f.observeBuild(); const receipt = f.submit(); assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed');
  const requests = f.targetRequests(); assert.equal(requests.length, 2); assert.deepEqual(requests[0]!.tools.map(tool => tool.name), coreNames);
  assert.deepEqual(requests[1]!.tools.map(tool => tool.name), [...coreNames, 'growth_probe']);
  assert.ok(requests[1]!.messages.some(message => message.role === 'tool' && message.content.includes('TOOL_NOT_FOUND')));
  const events = f.engine.store.readEvents('session', 0, 200).filter(event => event.runId === receipt.runId && event.type === 'context.prepared'); assert.equal(events.length, 2);
  requests.forEach((request, index) => { assert.equal(events[index]!.payload.reservedToolBytes, bytes({ messages: [], tools: request.tools }) - 2); assert.equal(events[index]!.payload.toolCatalogueSha256, sha(request.tools)); assert.equal(events[index]!.payload.bytes, bytes({ messages: request.messages, tools: request.tools })); });
  assert.ok(f.observations.at(-1)!.reservedBytes > f.observations[0]!.reservedBytes);
  assert.equal(f.engine.context.diagnostics('session')!.plan.reservations.envelopeBytes, bytes({ messages: [], tools: requests[1]!.tools }) - 2);
  assert.equal(f.engine.store.listTurns(receipt.runId).length, 2); f.assertOriginal();
});
test('a genuinely oversized mandatory current input still stops before a known-window dispatch', async t => {
  const f = await fixture(t, { knownWindow: true }); f.observeBuild(); const receipt = f.submit('Mandatory private current input: ' + 'm'.repeat(32_768));
  const run = await f.engine.waitForRun(receipt.runId); assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'CONTEXT_TOKEN_LIMIT');
  assert.equal(f.targetRequests().length, 0); assert.equal(f.engine.store.listTurns(receipt.runId).length, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM provider_attempts WHERE run_id=?').get(receipt.runId)!.n, 0); f.assertOriginal();
});
test('cancel during an eager build with changed schemas creates no provider attempt or automatic continuation', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); f.observeBuild(async (_request, index) => { if (!index) { f.register(); entered.resolve(); await release.promise; } });
  const receipt = f.submit(); await entered.promise; f.engine.coordinator.cancel(receipt.runId); release.resolve();
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'cancelled'); await tick();
  assert.equal(f.targetRequests().length, 0); assert.equal(f.engine.store.listTurns(receipt.runId).length, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM provider_attempts WHERE run_id=?').get(receipt.runId)!.n, 0); f.assertOriginal();
});
