import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { EngineError, type ApprovalRecord, type JsonObject, type Run } from '@moodcode/contracts';
import { CredentialBroker } from '../credentials/index.js';
import { createEngine, type EngineOptions, type MoodcodeEngine } from '../engine.js';
import { HttpMcpTransport, McpClient } from '../mcp/index.js';
import type { ProviderAdapter, TurnRequest } from '../ports.js';
import { exportEngineArchive, importEngineArchive } from '../storage/archive.js';
import { SqliteStore } from '../storage/index.js';

// These peers, databases and effects are authored private loopback fixtures. The
// accepted marker is written by the actual HTTP peer; a transport intent alone
// is never described as evidence that the peer accepted or performed an effect.
const originalGoal = 'Execute the explicitly approved private loopback observation.';
const textBeforeTool = 'Public partial text before the remote tool.';
const reasoningBeforeTool = 'Public reasoning before the remote tool.';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(predicate: () => boolean, label: string) { for (let index = 0; index < 20_000; index++) { if (predicate()) return; await tick(); } assert.fail(`Fixture boundary did not arrive: ${label}`); }
type ResultMode = 'held' | 'success' | 'is-error' | 'rpc-error' | 'input-required' | 'wrong-id' | 'malformed';
interface FixtureOptions { result?: ResultMode; requestTimeoutMs?: number; auth?: boolean }
interface RemoteRecord extends JsonObject { toolCallId: string; state: string }
interface Fixture {
  directory: string; dbPath: string; artifactDir: string; engine: MoodcodeEngine; options: EngineOptions; client: McpClient; reader: DatabaseSync;
  runId: string; done: Promise<Run>; accepted: Promise<void>; peerSettled: Promise<void>; main: TurnRequest[]; captured: JsonObject[];
  peerCalls(): number; peerActive(): boolean; peerReplies(): number; fullReads(): number; release(): void; rejectAuth(): void;
  pendingOperations(): { pending: number; transportActive: number };
  approval(): Promise<ApprovalRecord>; approve(): Promise<ApprovalRecord>; records(): RemoteRecord[]; original(): unknown; reopen(): Promise<void>;
}
function construct(options: EngineOptions, onRead: () => void) {
  const original = SqliteStore.prototype.getSnapshot;
  const trap = () => { onRead(); throw new Error('MCP outcome tests forbid whole session snapshots, including restart'); };
  SqliteStore.prototype.getSnapshot = trap;
  try { const engine = createEngine(options); engine.store.getSnapshot = trap; return engine; }
  finally { SqliteStore.prototype.getSnapshot = original; }
}
async function fixture(t: TestContext, specification: FixtureOptions = {}): Promise<Fixture> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-mcp-outcome-review-'))), repository = join(directory, 'repository'), dbPath = join(directory, 'engine.sqlite'), artifactDir = join(directory, 'artifacts');
  await mkdir(repository); await writeFile(join(repository, 'fixture.txt'), 'Private fixture source.\n');
  const accepted = deferred(), settled = deferred(), release = deferred(); let active = false, calls = 0, replies = 0, reads = 0, rejectAuth = false;
  const captured: JsonObject[] = [], main: TurnRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk; const rpc = JSON.parse(raw) as JsonObject; captured.push(rpc);
      let result: JsonObject;
      if (rpc.method === 'server/discover') result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } };
      else if (rpc.method === 'tools/list') result = { tools: [{ name: 'observe', description: 'Private loopback fixture only.', inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] }, annotations: { readOnlyHint: true } }] };
      else if (rpc.method === 'tools/call') {
        calls++; active = true; appendFileSync(join(directory, 'peer-effects.log'), 'accepted-private-effect\n', { mode: 0o600 }); accepted.resolve();
        if (specification.result === undefined || specification.result === 'held') await release.promise;
        active = false; appendFileSync(join(directory, 'peer-effects.log'), 'settled-private-effect\n'); settled.resolve(); replies++;
        if (response.destroyed) return;
        if (specification.result === 'rpc-error') { send(response, { jsonrpc: '2.0', id: rpc.id!, error: { code: -32603, message: 'Private terminal operation error.' } }); return; }
        if (specification.result === 'wrong-id') { send(response, { jsonrpc: '2.0', id: Number(rpc.id) + 100, result: { content: [{ type: 'text', text: 'Foreign identity.' }] } }); return; }
        if (specification.result === 'malformed') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{invalid'); return; }
        if (specification.result === 'input-required') result = { resultType: 'input_required', content: [] };
        else result = { content: [{ type: 'text', text: specification.result === 'is-error' ? 'Known private tool failure.' : 'Known private tool observation.' }], ...(specification.result === 'is-error' ? { isError: true } : {}) };
      } else { response.writeHead(202); response.end(); return; }
      send(response, { jsonrpc: '2.0', id: rpc.id!, result });
    } catch { if (!response.destroyed) { response.writeHead(500); response.end(); } }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const broker = new CredentialBroker({ async resolve() { if (rejectAuth) throw new Error('Private host deliberately rejected the call credential.'); return { bearerToken: 'private-fixture-token', expiresAt: Date.now() + 60_000 }; } });
  const credential = { broker, reference: { id: 'host:private-fixture', audience: url } };
  const transport = new HttpMcpTransport({ url, ...(specification.auth ? { credential } : {}) });
  const client = new McpClient({ id: 'review', transport, requestTimeoutMs: specification.requestTimeoutMs ?? 2000 });
  const provider: ProviderAdapter = { id: 'mcp-outcome-fixture', async *streamTurn(request) {
    main.push(structuredClone(request));
    const goal = request.messages.findLast(message => message.role === 'user')?.content;
    if (goal === originalGoal && request.turnIndex === 0) {
      yield { type: 'progress', providerRequestId: 'private-model-request' };
      yield { type: 'usage', inputTokens: 11, outputTokens: 4, cachedInputTokens: 2, reasoningOutputTokens: 1 };
      yield { type: 'text.delta', delta: textBeforeTool }; yield { type: 'reasoning.delta', delta: reasoningBeforeTool };
      yield { type: 'tool.call', call: { id: 'private-provider-call', name: 'mcp_review_observe', input: { marker: 'exact-approved-marker' } } }; yield { type: 'finish', reason: 'tool_calls' };
    } else { yield { type: 'text.delta', delta: 'Explicit private subsequent completion.' }; yield { type: 'finish', reason: 'stop' }; }
  } };
  const options: EngineOptions = { dbPath, artifactDir, providers: [provider], tools: [], defaults: { providerId: provider.id, modelId: 'private-model', mode: 'build', limits: { maxDurationMs: 10_000, toolTimeoutMs: 5000, maxContextBytes: 262_144, maxOutputBytes: 32_768 } } };
  let engine = construct(options, () => reads++); const reader = new DatabaseSync(dbPath, { readOnly: true });
  const createdAt = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt });
  for (const id of ['session', 'queued-session', 'other-session']) engine.store.createSession({ id, workspaceId: 'workspace', title: id, createdAt });
  await engine.connectMcp(client);
  let f!: Fixture;
  const original = () => {
    const tables = ['messages', 'message_parts', 'provider_attempts', 'attempt_cleanup', 'attempt_usage', 'tools', 'approvals'];
    return Object.fromEntries(tables.map(table => [table, reader.prepare(`SELECT data FROM ${table} WHERE run_id=? ORDER BY rowid LIMIT 64`).all(f.runId).map(row => JSON.parse(String(row.data)))]));
  };
  const receipt = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'first', prompt: originalGoal, config: engine.getCapabilities().defaults });
  f = { directory, dbPath, artifactDir, engine, options, client, reader, runId: receipt.runId, done: engine.waitForRun(receipt.runId), accepted: accepted.promise, peerSettled: settled.promise, main, captured,
    peerCalls: () => calls, peerActive: () => active, peerReplies: () => replies, fullReads: () => reads, release: release.resolve,
    pendingOperations() { return { pending: (client as unknown as { pending: Map<number, unknown> }).pending.size, transportActive: (transport as unknown as { active: Map<number, unknown> }).active.size }; },
    rejectAuth() { rejectAuth = true; broker.clear(); },
    async approval() { await until(() => f.engine.store.listPendingRunApprovals(f.runId).length > 0, 'actual outer approval'); return f.engine.store.listPendingRunApprovals(f.runId)[0]!; },
    async approve() { const approval = await f.approval(); assert.equal(approval.toolName, 'mcp_review_observe'); assert.equal(approval.status, 'pending'); return f.engine.approvals.decide(approval.id, 'allow', approval.fingerprint); },
    records() { return reader.prepare('SELECT data FROM mcp_executions WHERE run_id=? ORDER BY rowid LIMIT 8').all(f.runId).map(row => JSON.parse(String(row.data)) as RemoteRecord); }, original,
    async reopen() { await f.engine.close(); f.engine = construct(options, () => reads++); await tick(); },
  };
  t.after(async () => { release.resolve(); try { await f.engine.close(); await client.close(); } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); reader.close(); await rm(directory, { recursive: true, force: true }); } });
  return f;
}
function send(response: ServerResponse, data: JsonObject) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); }
function assertOriginal(f: Fixture, allowed: ApprovalRecord) {
  const turn = f.engine.store.listTurns(f.runId)[0]!; const attempt = f.engine.store.getAttempt(f.main[0]!.attemptId!); const cleanup = f.engine.store.getAttemptCleanup(attempt.id);
  assert.equal(attempt.state, 'completed'); assert.equal(attempt.providerRequestId, 'private-model-request'); assert.equal(cleanup.state, 'confirmed'); assert.equal(cleanup.method, 'iterator-next-done');
  assert.equal(f.engine.store.getApproval(allowed.id).status, 'allowed'); assert.equal(f.engine.store.getApproval(allowed.id).fingerprint, allowed.fingerprint);
  const parts = f.engine.store.listParts(turn.id), text = parts.find(part => part.type === 'text'), reasoning = parts.find(part => part.type === 'reasoning'), proposal = parts.find(part => part.type === 'tool');
  assert.ok(text?.type === 'text'); assert.equal(text.text, textBeforeTool); assert.ok(reasoning?.type === 'reasoning'); assert.equal(reasoning.text, reasoningBeforeTool);
  assert.ok(proposal?.type === 'tool'); assert.equal(proposal.providerCallId, 'private-provider-call'); assert.deepEqual(proposal.input, { marker: 'exact-approved-marker' });
  const usage = JSON.parse(String(f.reader.prepare('SELECT data FROM attempt_usage WHERE attempt_id=?').get(attempt.id)!.data)) as { usage: unknown };
  assert.deepEqual(usage.usage, { inputTokens: 11, outputTokens: 4, cachedInputTokens: 2, reasoningOutputTokens: 1 }); assert.equal(f.fullReads(), 0);
  return proposal;
}
async function assertBlocked(f: Fixture) {
  assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), true);
  assert.throws(() => f.engine.scheduler.submitLegacy({ sessionId: 'other-session', requestId: 'explicit-next', prompt: 'Explicit private successor.', config: f.engine.getCapabilities().defaults }), code('CLEANUP_PENDING'));
  assert.throws(() => f.engine.scheduler.resume('session'), code('CLEANUP_PENDING'));
  const queued = f.engine.scheduler.accept({ sessionId: 'queued-session', requestId: 'queued-next', prompt: 'Queued private successor.', config: f.engine.getCapabilities().defaults, delivery: 'queue' });
  await f.engine.waitForSession('queued-session').catch(() => {});
  assert.equal(f.engine.store.getInput(queued.inputId).state, 'pending'); assert.equal(f.engine.store.getInput(queued.inputId).runId, undefined);
  assert.equal(f.engine.store.getSessionControl('queued-session').reason, 'recovery_required'); assert.equal(f.main.length, 1);
}
function assertForeignHostOwner(f: Fixture, toolCallId: string) {
  const database = (f.engine.store as unknown as { db: DatabaseSync }).db, previous = database.prepare; let targetBodies = 0;
  database.prepare = sql => {
    const statement = Reflect.apply(previous, database, [sql]) as ReturnType<DatabaseSync['prepare']>;
    if (/^SELECT data FROM mcp_executions\s/u.test(sql)) { const get = statement.get; statement.get = (...values) => { targetBodies++; return Reflect.apply(get, statement, values) as ReturnType<typeof statement.get>; }; }
    return statement;
  };
  try { assert.throws(() => f.engine.getMcpExecution('other-session', toolCallId), code('MCP_EXECUTION_BINDING_MISMATCH')); assert.equal(targetBodies, 0, 'Foreign host selection is rejected before the target receipt JSON body is selected'); }
  finally { database.prepare = previous; }
}
for (const failure of ['timeout', 'disconnect', 'cancel'] as const) test(`actual accepted MCP ${failure} retains unknown remote outcome and blocks model, Run and queue dispatch`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, { requestTimeoutMs: failure === 'timeout' ? 100 : 2000 }), allowed = await f.approve(); await f.accepted;
  assert.equal(f.peerCalls(), 1); assert.equal(f.peerActive(), true);
  if (failure === 'disconnect') await f.engine.disconnectMcp(f.client.id); else if (failure === 'cancel') f.engine.coordinator.cancel(f.runId);
  const run = await f.done; assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(f.peerActive(), true); assert.equal(f.main.length, 1);
  const record = f.records()[0]!; assert.equal(f.records().length, 1); assert.equal(record.state, 'uncertain'); assert.equal(record.requestProjection, 'mcp-jsonrpc-tools-call-v1');
  const actualRpc = f.captured.find(rpc => rpc.method === 'tools/call')!; assert.equal(record.requestSha256, hash(JSON.stringify(actualRpc))); assert.equal(record.requestBytes, Buffer.byteLength(JSON.stringify(actualRpc))); assert.equal(record.logicalRpcId, actualRpc.id);
  assert.equal(record.approvalId, allowed.id); assert.equal(record.approvalFingerprint, allowed.fingerprint);
  assert.throws(() => f.engine.store.getMcpExecution(record.toolCallId, 'other-session'), code('MCP_EXECUTION_BINDING_MISMATCH'));
  assert.deepEqual(f.engine.getMcpExecution('session', record.toolCallId), record);
  assertForeignHostOwner(f, record.toolCallId);
  const proposal = assertOriginal(f, allowed); assert.equal(proposal.result, undefined); assert.equal(proposal.state, 'interrupted');
  const turn = f.engine.store.listTurns(f.runId)[0]!; assert.equal(turn.state, 'uncertain'); assert.equal(turn.uncertainty?.kind, 'tool_effect');
  assert.deepEqual(f.pendingOperations(), { pending: 0, transportActive: 0 }, 'Local callbacks have settled without claiming that the observed peer effect stopped');
  const mirrorType = 'mcp.execution.uncertain';
  assert.equal(f.engine.store.readEvents('session', 0, 100).filter(event => event.type === mirrorType).length, 1);
  assert.equal(f.engine.store.readSessionEvents('session', 0, 100).filter(event => event.type === mirrorType).length, 1);
  await assertBlocked(f); const before = f.original(), receiptBefore = f.records(); f.release(); await f.peerSettled; await tick();
  assert.deepEqual(f.original(), before); assert.deepEqual(f.records(), receiptBefore); assert.equal(f.main.length, 1); assert.equal(f.peerCalls(), 1);
  assert.deepEqual(readFileSync(join(f.directory, 'peer-effects.log'), 'utf8').trim().split('\n'), ['accepted-private-effect', 'settled-private-effect']);
  t.diagnostic(JSON.stringify({ failure, peerAccepted: true, peerActiveAtRunTerminal: true, providerTurns: f.main.length, state: run.state, remoteState: record.state, wholeSnapshots: f.fullReads(), lateReplyActivated: false }));
});
for (const result of ['success', 'is-error', 'rpc-error'] as const) test(`valid correlated ${result} is a server-declared terminal outcome and permits ordinary adaptation`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, { result }), allowed = await f.approve(); const run = await f.done;
  assert.equal(run.state, 'completed'); assert.equal(f.peerCalls(), 1); assert.equal(f.main.length, 2); assert.equal(f.peerActive(), false);
  const record = f.records()[0]!; assert.equal(record.state, 'response-terminal'); assert.equal(record.responseKind, result === 'rpc-error' ? 'jsonrpc-error' : 'tool-result');
  assert.deepEqual(f.engine.getMcpExecution('session', record.toolCallId), record);
  assertForeignHostOwner(f, record.toolCallId);
  assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), false); assertOriginal(f, allowed);
  assert.deepEqual(f.pendingOperations(), { pending: 0, transportActive: 0 });
  assert.ok(f.main[1]!.messages.some(message => message.role === 'tool')); assert.equal(JSON.stringify(record).includes('private-fixture-token'), false);
});
for (const result of ['input-required', 'wrong-id', 'malformed'] as const) test(`post-dispatch ${result} lacks a usable exact terminal outcome and remains uncertain`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, { result }), allowed = await f.approve(), run = await f.done;
  assert.equal(f.peerCalls(), 1); assert.equal(f.peerActive(), false); assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(f.main.length, 1); assert.equal(f.records()[0]!.state, 'uncertain');
  assertOriginal(f, allowed); await assertBlocked(f);
});
test('cancel before outer approval performs no remote dispatch and does not forge an uncertain receipt', { timeout: 30_000 }, async t => {
  const f = await fixture(t); await f.approval(); f.engine.coordinator.cancel(f.runId); const run = await f.done;
  assert.equal(run.state, 'cancelled'); assert.equal(f.peerCalls(), 0); assert.deepEqual(f.records(), []); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), false);
  const next = f.engine.scheduler.submitLegacy({ sessionId: 'other-session', requestId: 'safe-next', prompt: 'Explicit safe private successor.', config: f.engine.getCapabilities().defaults }); assert.equal((await f.engine.waitForRun(next.runId)).state, 'completed');
});
test('credential failure after approval occurs before HTTP dispatch and preserves known absence of a remote call', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { auth: true }); await f.approval(); f.rejectAuth(); const allowed = await f.approve(), run = await f.done;
  assert.equal(f.peerCalls(), 0); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), false); assert.equal(run.state, 'completed');
  const records = f.records(); assert.ok(records.length === 0 || records.length === 1 && records[0]!.state === 'not-dispatched'); assertOriginal(f, allowed); assert.equal(JSON.stringify(records).includes('private-fixture-token'), false);
});
test('catalogue invalidation between approval preparation and execution sends no stale remote call', { timeout: 30_000 }, async t => {
  const f = await fixture(t); const approval = await f.approval(); await f.engine.disconnectMcp(f.client.id); f.engine.approvals.decide(approval.id, 'allow', approval.fingerprint); const run = await f.done;
  assert.equal(f.peerCalls(), 0); assert.equal(run.state, 'completed'); assert.ok(f.records().every(record => record.state === 'not-dispatched')); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), false);
});
test('engine close after peer acceptance preserves durable uncertainty instead of confirming remote cancellation', { timeout: 30_000 }, async t => {
  const f = await fixture(t), allowed = await f.approve(); await f.accepted; assert.equal(f.peerActive(), true); await f.engine.close();
  assert.equal(f.peerActive(), true); assert.equal(f.main.length, 1); assert.equal(f.records()[0]!.state, 'uncertain'); f.release(); await f.peerSettled;
  const recordBefore = f.records(), originalBefore = f.original(); await f.reopen(); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), true); assert.equal(f.main.length, 1);
  assert.deepEqual(f.records(), recordBefore); assert.deepEqual(f.original(), originalBefore); assertOriginal(f, allowed); await assertBlocked(f);
});
test('terminal response journal failure cannot publish a normal tool result or release remote quarantine', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { result: 'success' }); const original = f.engine.store.settleMcpExecution.bind(f.engine.store); let failed = false;
  f.engine.store.settleMcpExecution = (id, settlement) => { if (!failed && settlement.outcome === 'response-terminal') { failed = true; throw new EngineError('FIXTURE_MCP_JOURNAL_FAILURE', 'Private injected terminal journal failure.'); } return original(id, settlement); };
  const allowed = await f.approve(), run = await f.done; assert.equal(failed, true); assert.equal(f.peerCalls(), 1); assert.equal(f.main.length, 1); assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN');
  assert.ok(['uncertain', 'dispatch-intent'].includes(f.records()[0]!.state)); const proposal = assertOriginal(f, allowed); assert.equal(proposal.result, undefined); await assertBlocked(f);
});
test('a committed dispatch intent followed by observer rejection sends no request and cannot continue the model loop', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { result: 'success' }), dispatch = f.engine.store.dispatchMcpExecution.bind(f.engine.store); let injected = false;
  f.engine.store.dispatchMcpExecution = (id, boundary) => { const record = dispatch(id, boundary); injected = true; throw new EngineError('FIXTURE_MCP_INTENT_CALLBACK_FAILURE', `Private callback rejected after committed ${record.state}.`); };
  const allowed = await f.approve(), run = await f.done, receipt = f.records()[0]!;
  t.diagnostic(JSON.stringify({ injected, peerCalls: f.peerCalls(), providerTurns: f.main.length, runState: run.state, runError: run.error ?? null, receiptState: receipt.state, workspaceBlocked: f.engine.store.hasUncertainWorkspace('workspace') }));
  assert.equal(injected, true); assert.equal(f.peerCalls(), 0, 'A committed intent is not a claim of actual HTTP dispatch or peer acceptance');
  assert.equal(receipt.state, 'dispatch-intent'); assert.equal(f.main.length, 1); assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); assertOriginal(f, allowed); await assertBlocked(f);
});
for (const journal of ['events', 'session_events'] as const) test(`terminal MCP ${journal} audit failure rolls back receipt and both mirrors before any model adaptation`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, { result: 'success' }), database = (f.engine.store as unknown as { db: DatabaseSync }).db, prepare = database.prepare.bind(database); let injected = false;
  database.prepare = sql => {
    const statement = prepare(sql);
    if (new RegExp(`^INSERT INTO ${journal}\\(`, 'u').test(sql)) {
      const run = statement.run.bind(statement);
      statement.run = (...values) => { if (!injected && values.some(value => typeof value === 'string' && value.includes('mcp.execution.response_terminal'))) { injected = true; throw new EngineError('FIXTURE_MCP_AUDIT_FAILURE', 'Private injected receipt audit failure.'); } return Reflect.apply(run, statement, values) as ReturnType<typeof statement.run>; };
    }
    return statement;
  };
  const allowed = await f.approve(), run = await f.done; assert.equal(injected, true); assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(f.peerCalls(), 1); assert.equal(f.main.length, 1);
  assert.equal(f.records()[0]!.state, 'dispatch-intent'); assert.equal(f.engine.store.readEvents('session', 0, 100).filter(event => event.type === 'mcp.execution.response_terminal').length, 0);
  assert.equal(f.engine.store.readSessionEvents('session', 0, 100).filter(event => event.type === 'mcp.execution.response_terminal').length, 0);
  const proposal = assertOriginal(f, allowed); assert.equal(proposal.result, undefined); await assertBlocked(f);
});
test('restart and archive import preserve exact unresolved remote owner and never grant recovery or execution authority', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { requestTimeoutMs: 100 }), allowed = await f.approve(); await f.accepted; await f.done; f.release(); await f.peerSettled; await f.engine.waitForSession('session').catch(() => {});
  const originalBefore = f.original(), receiptBefore = f.records(); await f.reopen(); assert.deepEqual(f.original(), originalBefore); assert.deepEqual(f.records(), receiptBefore); await assertBlocked(f); assertOriginal(f, allowed);
  assert.throws(() => f.engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'first', prompt: 'Mutated private exact request.', config: f.engine.getCapabilities().defaults }), code('REQUEST_ID_CONFLICT'));
  const exact = f.engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'first', prompt: originalGoal, config: f.engine.getCapabilities().defaults }); assert.equal(exact.runId, f.runId); assert.equal(f.main.length, 1); assert.equal(f.peerCalls(), 1);
  await f.engine.close(); const archive = await exportEngineArchive({ dbPath: f.dbPath, artifactDir: f.artifactDir, destination: join(f.directory, 'archive') });
  const imported = await importEngineArchive({ directory: archive.directory, destination: join(f.directory, 'imported') }), copied = new DatabaseSync(imported.dbPath, { readOnly: true });
  try {
    assert.deepEqual(copied.prepare('SELECT data FROM mcp_executions WHERE run_id=? ORDER BY rowid').all(f.runId).map(row => JSON.parse(String(row.data))), receiptBefore);
    assert.equal(Number(copied.prepare('SELECT count(*) AS n FROM summary_recovery_acknowledgments').get()!.n), 0); assert.equal(Number(copied.prepare('SELECT count(*) AS n FROM provider_recovery_acknowledgments').get()!.n), 0);
    assert.equal(copied.prepare("SELECT paused FROM session_controls WHERE session_id='session'").get()!.paused, 1);
  } finally { copied.close(); }
  const restored = construct({ ...f.options, dbPath: imported.dbPath, artifactDir: imported.artifactDir }, () => assert.fail('Imported recovery cannot read full snapshot'));
  try { assert.equal(restored.store.hasUncertainWorkspace('workspace'), true); assert.throws(() => restored.scheduler.resume('session'), code('CLEANUP_PENDING')); assert.equal(f.main.length, 1); } finally { await restored.close(); }
});

for (const phase of ['dispatch-intent', 'peer-accepted'] as const) test(`actual SIGKILL at ${phase} retains remote receipt and exact retry cannot resume or resend it`, { timeout: 30_000, skip: process.platform === 'win32' }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-mcp-effect-crash-review-'))), accepted = deferred(), release = deferred(); let peerCalls = 0, active = false;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk; const rpc = JSON.parse(raw) as JsonObject;
    let result: JsonObject;
    if (rpc.method === 'server/discover') result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } };
    else if (rpc.method === 'tools/list') result = { tools: [{ name: 'observe', description: 'Private parent-owned peer.', inputSchema: { type: 'object' } }] };
    else if (rpc.method === 'tools/call') {
      peerCalls++; active = true; appendFileSync(join(directory, 'peer-effects.log'), 'accepted-private-effect\n', { mode: 0o600 }); accepted.resolve();
      await release.promise; active = false; appendFileSync(join(directory, 'peer-effects.log'), 'settled-private-effect\n'); if (response.destroyed) return;
      result = { content: [{ type: 'text', text: 'Private delayed terminal observation.' }] };
    } else { response.writeHead(202); response.end(); return; }
    send(response, { jsonrpc: '2.0', id: rpc.id!, result });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const workerTs = fileURLToPath(new URL('./fixtures/mcp-effect-outcome-child.ts', import.meta.url)), workerJs = fileURLToPath(new URL('./fixtures/mcp-effect-outcome-child.js', import.meta.url));
  const workerPath = process.env.MOODCODE_MCP_OUTCOME_CRASH_WORKER ?? (import.meta.url.endsWith('.ts') ? workerTs : workerJs);
  const child = spawn(process.execPath, [...(workerPath.endsWith('.ts') ? ['--import', 'tsx'] : []), workerPath, directory, url, phase], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '', exited = false; child.stderr?.on('data', data => { stderr += String(data).slice(0, 4096); });
  const exit = new Promise<void>(resolve => child.once('exit', () => { exited = true; resolve(); }));
  let restarted: MoodcodeEngine | undefined;
  t.after(async () => { if (!exited) child.kill('SIGKILL'); await exit; release.resolve(); await restarted?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const stopped = new Promise<{ runId: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Private crash phase timed out: ${stderr}`)), 10000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Private worker exited before boundary: ${stderr}`)); });
    child.on('message', message => { if ((message as { kind?: string }).kind === 'stopped') { clearTimeout(timer); resolve(message as { runId: string }); } });
  });
  if (phase === 'peer-accepted') { await Promise.race([accepted.promise, exit.then(() => assert.fail(`Worker ended before peer acceptance: ${stderr}`))]); assert.equal(active, true); child.send({ kind: 'peer-accepted' }); }
  const selected = await stopped; assert.equal(peerCalls, phase === 'peer-accepted' ? 1 : 0);
  child.kill('SIGKILL'); await exit;
  const reader = new DatabaseSync(join(directory, 'engine.sqlite'), { readOnly: true });
  const before = JSON.parse(String(reader.prepare('SELECT data FROM mcp_executions WHERE run_id=?').get(selected.runId)!.data)) as RemoteRecord;
  assert.equal(before.state, 'dispatch-intent'); assert.equal(before.dispatchBoundary, 'http-fetch'); assert.equal(readFileSync(join(directory, 'provider-calls.log'), 'utf8').trim(), 'provider-dispatch');
  let newProviderCalls = 0, wholeSnapshots = 0; const provider: ProviderAdapter = { id: 'mcp-crash-fixture', async *streamTurn() { newProviderCalls++; yield { type: 'text.delta', delta: 'Unexpected private restart dispatch.' }; yield { type: 'finish', reason: 'stop' }; } };
  restarted = construct({ dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [provider], tools: [], defaults: { providerId: provider.id, modelId: 'private-model', mode: 'build' } }, () => wholeSnapshots++);
  try {
    const run = restarted.store.getRun(selected.runId), records = reader.prepare('SELECT data FROM mcp_executions WHERE run_id=?').all(selected.runId).map(row => JSON.parse(String(row.data)) as RemoteRecord);
    assert.equal(run.state, 'interrupted'); assert.equal(records.length, 1); assert.equal(records[0]!.state, 'uncertain'); assert.equal(records[0]!.requestSha256, before.requestSha256); assert.equal(records[0]!.approvalId, before.approvalId);
    assert.equal(restarted.store.getAttempt(String(records[0]!.attemptId)).state, 'completed'); assert.equal(restarted.store.getAttemptCleanup(String(records[0]!.attemptId)).state, 'confirmed');
    assert.equal(restarted.store.getTurn(String(records[0]!.turnId)).uncertainty?.kind, 'tool_effect'); assert.equal(restarted.store.getSessionControl('session').reason, 'recovery_required'); assert.equal(restarted.store.hasUncertainWorkspace('workspace'), true);
    const exact = restarted.scheduler.submitLegacy({ sessionId: 'session', requestId: 'first', prompt: run.prompt, config: run.config }); assert.equal(exact.runId, selected.runId);
    assert.equal(newProviderCalls, 0); assert.equal(peerCalls, phase === 'peer-accepted' ? 1 : 0); assert.equal(wholeSnapshots, 0);
    assert.equal(Number(reader.prepare('SELECT count(*) AS n FROM provider_recovery_acknowledgments').get()!.n), 0); assert.equal(Number(reader.prepare('SELECT count(*) AS n FROM summary_recovery_acknowledgments').get()!.n), 0);
    if (phase === 'peer-accepted') assert.equal(active, true, 'Killing the engine did not claim the parent-owned remote peer had stopped');
    t.diagnostic(JSON.stringify({ phase, peerAccepted: phase === 'peer-accepted', peerCalls, providerCallsBeforeCrash: 1, providerCallsAfterRestart: newProviderCalls, state: records[0]!.state, executionResumed: false, autoAcknowledgments: 0, wholeSnapshots }));
  } finally { reader.close(); }
});
