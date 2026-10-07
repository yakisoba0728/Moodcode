import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as tick } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { EngineError, type ApprovalRecord, type JsonObject, type RunConfig } from '@moodcode/contracts';
import { createEngine, type EngineOptions, type MoodcodeEngine } from '../engine.js';
import { HttpMcpTransport, McpClient } from '../mcp/index.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { SqliteStore } from '../storage/index.js';

// These are private loopback schemas and scripted logical requests. No provider
// account, installation, remote service or recovery acknowledgment is involved.
const target = 'mcp_many_observe_07';
const hidden = 'mcp_many_observe_08';
const coreNames = ['list_files', 'read_file', 'search_files', 'apply_patch', 'run_command', 'edit_file', 'rename_file', 'delete_file', 'glob_files', 'regex_search', 'todo_read', 'todo_write', 'ask_user', 'skill_list', 'skill_read', 'reference_read', 'read_artifact', 'format_file', 'lsp_format_file', 'merge_child_changes', 'delegate_task'];
const schemas = Array.from({ length: 40 }, (_, index) => ({ name: `observe_${String(index).padStart(2, '0')}`, description: `Private fixture observation ${String(index).padStart(2, '0')}.`, inputSchema: { type: 'object', properties: { marker: { type: 'string', description: 'x'.repeat(8192) } }, required: ['marker'] }, annotations: { readOnlyHint: true } }));
const policy: NonNullable<EngineOptions['toolDiscoveryPolicy']> = { kind: 'bounded-tool-discovery', version: 1 };
const code = (expected: string) => (value: unknown) => value instanceof EngineError && value.code === expected;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(check: () => boolean, label: string) { const deadline = Date.now() + 5000; while (!check()) { assert.ok(Date.now() < deadline, `Missing private boundary: ${label}`); await tick(); } }
type Program = (request: TurnRequest, signal: AbortSignal) => AsyncGenerator<ProviderEvent>;
interface FixtureOptions { eager?: boolean; program?: Program; profiles?: EngineOptions['agentProfiles']; policyRules?: EngineOptions['toolPolicy']; held?: boolean; requestTimeoutMs?: number; discoveryPolicy?: EngineOptions['toolDiscoveryPolicy']; git?: boolean }
interface Fixture {
  engine: MoodcodeEngine; options: EngineOptions; db: DatabaseSync; repository: string; directory: string;
  requests: TurnRequest[]; configurations: { reservedBytes: number; byteLimit: number }[]; actualRpc: JsonObject[];
  accepted: Promise<void>; release(): void; peerCalls(): number; wholeReads(): number;
  submit(prompt?: string, requestId?: string, config?: Partial<RunConfig>): { runId: string; requestId: string; prompt: string; config: RunConfig };
  approval(runId: string): Promise<ApprovalRecord>; approve(runId: string): Promise<ApprovalRecord>;
  reopen(): Promise<void>;
}
async function* normalProgram(request: TurnRequest, _signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
  if (request.turnIndex === 0) { yield { type: 'usage', inputTokens: 7, outputTokens: 1 }; yield { type: 'tool.call', call: { id: 'discover-owned', name: 'discover_tools', input: { query: 'observe_07', limit: 1 } } }; yield { type: 'finish', reason: 'tool_calls' }; }
  else if (request.turnIndex === 1) { yield { type: 'tool.call', call: { id: 'remote-owned', name: target, input: { marker: 'exact-private-observation' } } }; yield { type: 'finish', reason: 'tool_calls' }; }
  else { yield { type: 'text.delta', delta: 'The explicitly approved private observation completed.' }; yield { type: 'finish', reason: 'stop' }; }
}
function construct(options: EngineOptions, onRead: () => void) {
  const previous = SqliteStore.prototype.getSnapshot;
  const trap = () => { onRead(); throw new Error('Discovery integration forbids whole-session snapshots, including restart'); };
  SqliteStore.prototype.getSnapshot = trap;
  try { const engine = createEngine(options); engine.store.getSnapshot = trap; return engine; }
  finally { SqliteStore.prototype.getSnapshot = previous; }
}
async function fixture(t: TestContext, specification: FixtureOptions = {}): Promise<Fixture> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-tool-discovery-integration-'))), repository = join(directory, 'repository');
  await mkdir(repository); await writeFile(join(repository, 'fixture.txt'), 'Private local fixture.\n');
  if (specification.git) { execFileSync('git', ['init', '-q', repository]); execFileSync('git', ['-C', repository, 'add', 'fixture.txt']); execFileSync('git', ['-C', repository, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'private fixture']); }
  const accepted = deferred(), release = deferred(), actualRpc: JsonObject[] = [], requests: TurnRequest[] = [], configurations: Fixture['configurations'] = [];
  let calls = 0, wholeReads = 0;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk; const rpc = JSON.parse(raw) as JsonObject; actualRpc.push(rpc);
      let result: JsonObject;
      if (rpc.method === 'server/discover') result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } };
      else if (rpc.method === 'tools/list') result = { tools: schemas };
      else if (rpc.method === 'tools/call') { calls++; accepted.resolve(); if (specification.held) await release.promise; result = { content: [{ type: 'text', text: 'Exact private observed result.' }] }; }
      else { response.writeHead(202); response.end(); return; }
      if (!response.destroyed) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })); }
    } catch { if (!response.destroyed) { response.writeHead(500); response.end(); } }
  });
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
  const provider: ProviderAdapter = { id: 'private-discovery', async *streamTurn(request, signal) { requests.push(structuredClone(request)); yield* (specification.program ?? normalProgram)(request, signal); } };
  const options: EngineOptions = { dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [provider], defaults: { providerId: provider.id, modelId: 'private-model', mode: 'build', limits: { maxDurationMs: 10_000, maxTurns: 8, maxOutputBytes: 65_536 } }, ...(specification.eager ? {} : { toolDiscoveryPolicy: specification.discoveryPolicy ?? policy }), ...(specification.profiles ? { agentProfiles: specification.profiles } : {}), ...(specification.policyRules ? { toolPolicy: specification.policyRules } : {}) };
  let engine = construct(options, () => wholeReads++);
  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  const now = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt: now });
  for (const id of ['session', 'other-session']) engine.store.createSession({ id, workspaceId: 'workspace', title: id, createdAt: now });
  const client = new McpClient({ id: 'many', requestTimeoutMs: specification.requestTimeoutMs ?? 2000, transport: new HttpMcpTransport({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp` }) });
  await engine.connectMcp(client);
  const observe = () => { const build = engine.context.build.bind(engine.context); engine.context.build = request => { configurations.push({ reservedBytes: request.reservedBytes ?? 0, byteLimit: request.config.limits.maxContextBytes }); return build(request); }; };
  observe();
  let f!: Fixture;
  f = { engine, options, db, repository, directory, requests, configurations, actualRpc, accepted: accepted.promise, release: release.resolve, peerCalls: () => calls, wholeReads: () => wholeReads,
    submit(prompt = 'Discover and execute one exact private observation.', requestId = 'first', override = {}) { const config = f.engine.profiles.apply('session', { ...f.engine.getCapabilities().defaults, ...override }); const receipt = f.engine.scheduler.submitLegacy({ sessionId: 'session', requestId, prompt, config }); return { runId: receipt.runId, requestId, prompt, config }; },
    async approval(runId) { await until(() => { const pending = f.engine.store.listPendingRunApprovals(runId); if (pending.length) return true; const run = f.engine.store.getRun(runId); assert.ok(!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state), `Run ended before outer approval: ${JSON.stringify(run.error ?? { state: run.state })}`); return false; }, 'exact outer MCP approval'); const approval = f.engine.store.listPendingRunApprovals(runId)[0]!; assert.equal(approval.toolName, target); return approval; },
    async approve(runId) { const approval = await f.approval(runId); return f.engine.approvals.decide(approval.id, 'allow', approval.fingerprint); },
    async reopen() { await f.engine.close(); engine = construct(options, () => wholeReads++); f.engine = engine; observe(); await tick(); },
  };
  t.after(async () => { release.resolve(); try { await f.engine.close(); await client.close(); } finally { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); db.close(); await rm(directory, { recursive: true, force: true }); } });
  return f;
}
function assertCore(request: TurnRequest) { assert.deepEqual(request.tools.filter(tool => coreNames.includes(tool.name)).map(tool => tool.name), coreNames); }
function discoveryText(request: TurnRequest) { return request.messages.find(message => message.role === 'tool' && message.toolCallId === 'discover-owned')?.content ?? ''; }
function assertReservations(f: Fixture, runId: string) {
  const prepared = f.engine.store.readEvents('session', 0, 200).filter(event => event.runId === runId && event.type === 'context.prepared');
  const requests = f.requests.filter(request => request.runId === runId); assert.equal(prepared.length, requests.length);
  requests.forEach((request, index) => {
    const event = prepared[index]!, reserved = Buffer.byteLength(JSON.stringify({ messages: [], tools: request.tools })) - 2;
    assert.equal(event.payload.reservedToolBytes, reserved); assert.deepEqual(event.payload.advertisedToolNames, request.tools.map(tool => tool.name));
    assert.equal(event.payload.toolCatalogueSha256, sha(request.tools)); assert.equal(typeof event.payload.registryRevision, 'number'); assert.equal(typeof event.payload.policyVersion, 'number');
    assert.equal(event.payload.bytes, Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools }))); assert.ok(Number(event.payload.bytes) <= 262_144);
  });
}

test('default eager large catalogue preserves the established pre-provider CONTEXT_LIMIT boundary', async t => {
  const f = await fixture(t, { eager: true }), receipt = f.submit(), run = await f.engine.waitForRun(receipt.runId);
  assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'CONTEXT_LIMIT'); assert.equal(f.requests.length, 0); assert.equal(f.peerCalls(), 0);
  assert.equal(f.engine.getCapabilities().tools.length, coreNames.length + schemas.length); assert.equal(f.engine.getCapabilities().tools.some(tool => tool.name === 'discover_tools'), false);
  assert.ok(f.configurations[0]!.reservedBytes > f.configurations[0]!.byteLimit); assert.equal(f.wholeReads(), 0);
});
test('forty large registered MCP tools discover one exact schema at the next boundary and retain all core tools and real approval', async t => {
  const f = await fixture(t), receipt = f.submit(), allowed = await f.approve(receipt.runId), run = await f.engine.waitForRun(receipt.runId);
  assert.equal(run.state, 'completed'); assert.equal(f.requests.length, 3); assert.equal(f.peerCalls(), 1);
  assertCore(f.requests[0]!); assert.equal(f.requests[0]!.tools.length, 22); assert.equal(f.requests[0]!.tools.some(tool => tool.name.startsWith('mcp_')), false);
  for (const request of f.requests.slice(1)) { assertCore(request); assert.equal(request.tools.length, 23); assert.deepEqual(request.tools.filter(tool => tool.name.startsWith('mcp_')).map(tool => tool.name), [target]); }
  assert.ok(discoveryText(f.requests[1]!).includes(target)); assert.equal(discoveryText(f.requests[1]!).includes('x'.repeat(1024)), false, 'Search output is bounded metadata rather than the large schema body');
  const selected = f.requests[1]!.tools.find(tool => tool.name === target)!; assert.deepEqual(selected.inputSchema, schemas[7]!.inputSchema);
  const remote = f.actualRpc.filter(rpc => rpc.method === 'tools/call'); assert.equal(remote.length, 1); const params = remote[0]!.params as JsonObject;
  assert.equal(params.name, 'observe_07'); assert.deepEqual(params.arguments, { marker: 'exact-private-observation' }); assert.deepEqual(Object.keys(params).sort(), ['_meta', 'arguments', 'name']);
  assert.deepEqual(params._meta, { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'Moodcode', version: '0.1.0' }, 'io.modelcontextprotocol/clientCapabilities': {} });
  const receiptRow = f.db.prepare('SELECT data FROM mcp_executions WHERE run_id=?').get(receipt.runId)!; const execution = JSON.parse(String(receiptRow.data));
  assert.equal(execution.state, 'response-terminal'); assert.equal(execution.approvalId, allowed.id); assert.equal(execution.approvalFingerprint, allowed.fingerprint); assert.equal(execution.requestSha256, sha(remote[0]));
  assert.equal(f.engine.store.getApproval(allowed.id).status, 'allowed'); assertReservations(f, receipt.runId); assert.equal(f.wholeReads(), 0);
  const discovery = f.db.prepare("SELECT data FROM tools WHERE run_id=? AND json_extract(data,'$.name')='discover_tools'").get(receipt.runId)!;
  assert.equal(JSON.parse(String(discovery.data)).state, 'completed'); assert.equal(f.db.prepare('SELECT count(*) AS n FROM tools WHERE run_id=?').get(receipt.runId)!.n, 2);
  t.diagnostic(JSON.stringify({ registeredRemote: 40, initialVisible: 22, selectedVisible: 23, providerCalls: 3, peerCalls: 1, reservedToolBytes: f.requests.map(request => Buffer.byteLength(JSON.stringify({messages: [], tools: request.tools})) - 2), logicalRequestBytes: f.requests.map(request => Buffer.byteLength(JSON.stringify(request))), wholeSnapshots: f.wholeReads(), tokenSavingsMeasured: false, physicalIO: null }));
});
test('a forced unselected tool proposal never prepares approval or dispatches the registered remote handler', async t => {
  const f = await fixture(t, { program: async function* (request): AsyncGenerator<ProviderEvent> { if (!request.turnIndex) { yield { type: 'tool.call', call: { id: 'forced-hidden', name: hidden, input: { marker: 'not-selected' } } }; yield { type: 'finish', reason: 'tool_calls' }; } else { yield { type: 'text.delta', delta: 'Observed the unavailable proposal.' }; yield { type: 'finish', reason: 'stop' }; } } }), receipt = f.submit(), run = await f.engine.waitForRun(receipt.runId);
  assert.equal(run.state, 'completed'); assert.equal(f.peerCalls(), 0); assert.equal(f.requests.length, 2); assert.equal(f.engine.store.listPendingRunApprovals(receipt.runId).length, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM mcp_executions WHERE run_id=?').get(receipt.runId)!.n, 0);
  assert.ok(f.requests[1]!.messages.some(message => message.role === 'tool' && message.content.includes('TOOL_NOT_FOUND'))); assertReservations(f, receipt.runId);
});
test('discovery cannot grant an unselected call proposed in the same provider turn before its safe boundary', async t => {
  const f = await fixture(t, { program: async function* (request): AsyncGenerator<ProviderEvent> { if (!request.turnIndex) { yield { type: 'tool.call', call: { id: 'discover-owned', name: 'discover_tools', input: { query: 'observe_07', limit: 1 } } }; yield { type: 'tool.call', call: { id: 'same-turn-hidden', name: target, input: { marker: 'not-yet-selected' } } }; yield { type: 'finish', reason: 'tool_calls' }; } else { yield { type: 'text.delta', delta: 'Observed the next model boundary.' }; yield { type: 'finish', reason: 'stop' }; } } }), receipt = f.submit(), run = await f.engine.waitForRun(receipt.runId);
  assert.equal(run.state, 'completed'); assert.equal(f.requests.length, 2); assert.equal(f.peerCalls(), 0); assert.equal(f.engine.store.listPendingRunApprovals(receipt.runId).length, 0);
  assert.equal(f.requests[0]!.tools.some(tool => tool.name === target), false); assert.equal(f.requests[1]!.tools.some(tool => tool.name === target), true);
  assert.ok(f.requests[1]!.messages.some(message => message.role === 'tool' && message.toolCallId === 'same-turn-hidden' && message.content.includes('TOOL_NOT_FOUND'))); assertReservations(f, receipt.runId);
});
test('opting in cannot add discovery authority to a profile that permits only one core read tool', async t => {
  const f = await fixture(t, { profiles: [{ id: 'read-only-profile', description: 'Exact host names.', instructions: 'Read within the exact host profile.', tools: ['read_file'] }], program: async function* (request): AsyncGenerator<ProviderEvent> { if (!request.turnIndex) { yield { type: 'tool.call', call: { id: 'forced-discovery', name: 'discover_tools', input: { query: 'observe_07', limit: 1 } } }; yield { type: 'finish', reason: 'tool_calls' }; } else { yield { type: 'text.delta', delta: 'Discovery remained outside the profile.' }; yield { type: 'finish', reason: 'stop' }; } } }), receipt = f.submit(undefined, undefined, { agentProfileId: 'read-only-profile' }), run = await f.engine.waitForRun(receipt.runId);
  assert.equal(run.state, 'completed'); for (const request of f.requests) assert.deepEqual(request.tools.map(tool => tool.name), ['read_file']); assert.equal(f.peerCalls(), 0);
  assert.ok(f.requests[1]!.messages.some(message => message.role === 'tool' && message.content.includes('TOOL_NOT_ALLOWED'))); assert.equal(f.engine.store.listPendingRunApprovals(receipt.runId).length, 0); assertReservations(f, receipt.runId);
});
for (const boundary of ['profile', 'policy'] as const) test(`discovery and forced proposals cannot reveal or execute a ${boundary}-excluded exact tool`, async t => {
  const f = await fixture(t, { ...(boundary === 'profile' ? { profiles: [{ id: 'restricted', description: 'Private subset.', instructions: 'Use the private subset.', tools: ['read_file', 'discover_tools'] }] } : { policyRules: [{ tool: target, decision: 'deny' }] }) }), receipt = f.submit(undefined, undefined, boundary === 'profile' ? { agentProfileId: 'restricted' } : {}), run = await f.engine.waitForRun(receipt.runId);
  assert.equal(run.state, 'completed'); assert.equal(f.peerCalls(), 0); assert.equal(f.requests.length, 3); assert.equal(f.engine.store.listPendingRunApprovals(receipt.runId).length, 0);
  assert.equal(discoveryText(f.requests[1]!).includes(target), false); assert.equal(JSON.stringify(f.requests[1]!.tools).includes(target), false);
  if (boundary === 'profile') for (const request of f.requests) assert.deepEqual(request.tools.map(tool => tool.name), ['read_file', 'discover_tools']);
  assert.ok(f.requests[2]!.messages.some(message => message.role === 'tool' && /TOOL_NOT_ALLOWED|TOOL_NOT_FOUND/u.test(message.content))); assertReservations(f, receipt.runId);
});
test('cancellation before approval preserves selected proposal and known absence of remote execution', async t => {
  const f = await fixture(t), receipt = f.submit(); await f.approval(receipt.runId); f.engine.coordinator.cancel(receipt.runId); const run = await f.engine.waitForRun(receipt.runId);
  assert.equal(run.state, 'cancelled'); assert.equal(f.peerCalls(), 0); assert.equal(f.requests.length, 2); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM mcp_executions WHERE run_id=?').get(receipt.runId)!.n, 0);
  const turn = f.engine.store.listTurns(receipt.runId)[1]!; const proposal = f.engine.store.listParts(turn.id).find(part => part.type === 'tool'); assert.ok(proposal?.type === 'tool'); assert.equal(proposal.name, target); assert.deepEqual(proposal.input, { marker: 'exact-private-observation' }); assert.equal(proposal.result, undefined);
});
test('discovery consumes the ordinary tool-call allowance before a selected remote call can request approval', async t => {
  const f = await fixture(t), receipt = f.submit(undefined, undefined, { limits: { ...f.engine.getCapabilities().defaults.limits, maxToolCalls: 1 } }), run = await f.engine.waitForRun(receipt.runId);
  assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'TOOL_CALL_LIMIT'); assert.equal(f.requests.length, 2); assert.equal(f.peerCalls(), 0);
  assert.equal(f.engine.store.listPendingRunApprovals(receipt.runId).length, 0); const discovery = f.db.prepare("SELECT data FROM tools WHERE run_id=? AND json_extract(data,'$.name')='discover_tools'").get(receipt.runId)!; assert.equal(JSON.parse(String(discovery.data)).state, 'completed');
});
test('a policy change while a selected request awaits approval invalidates its captured authority without remote dispatch', async t => {
  const f = await fixture(t), receipt = f.submit(), approval = await f.approval(receipt.runId); f.engine.toolRuntime.policy.replace([{ tool: target, decision: 'deny' }]); f.engine.approvals.decide(approval.id, 'allow', approval.fingerprint);
  const run = await f.engine.waitForRun(receipt.runId); assert.equal(run.state, 'completed'); assert.equal(f.requests.length, 3); assert.equal(f.peerCalls(), 0); assert.equal(f.engine.store.getApproval(approval.id).status, 'allowed');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM mcp_executions WHERE run_id=?').get(receipt.runId)!.n, 0); assert.equal(f.requests[2]!.tools.some(tool => tool.name === target), false); assertReservations(f, receipt.runId);
});
test('selected MCP timeout after the observed peer call remains uncertain and stops model continuation and queued dispatch', async t => {
  const f = await fixture(t, { held: true, requestTimeoutMs: 100 }), receipt = f.submit(), allowed = await f.approve(receipt.runId); await f.accepted; const run = await f.engine.waitForRun(receipt.runId);
  assert.equal(f.peerCalls(), 1); assert.equal(f.requests.length, 2); assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), true);
  assert.equal(f.engine.store.getApproval(allowed.id).status, 'allowed'); assert.equal(f.engine.store.listTurns(receipt.runId)[1]!.uncertainty?.kind, 'tool_effect');
  const record = JSON.parse(String(f.db.prepare('SELECT data FROM mcp_executions WHERE run_id=?').get(receipt.runId)!.data)); assert.equal(record.state, 'uncertain');
  assert.throws(() => f.submit('Fresh explicit successor.', 'blocked-next'), code('CLEANUP_PENDING'));
  const queued = f.engine.scheduler.accept({ sessionId: 'other-session', requestId: 'queued-next', prompt: 'Pending private goal.', config: f.engine.getCapabilities().defaults, delivery: 'queue' });
  await f.engine.waitForSession('other-session').catch(() => {}); assert.equal(f.engine.store.getInput(queued.inputId).state, 'pending'); assert.equal(f.engine.store.getInput(queued.inputId).runId, undefined);
  const before = String(f.db.prepare('SELECT data FROM mcp_executions WHERE run_id=?').get(receipt.runId)!.data); f.release(); await tick(); await f.reopen(); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), true); assert.equal(String(f.db.prepare('SELECT data FROM mcp_executions WHERE run_id=?').get(receipt.runId)!.data), before); assert.equal(f.requests.length, 2); assert.equal(f.peerCalls(), 1); assert.equal(f.wholeReads(), 0);
});
test('completed discovery selection is Run-local and exact retry or restart cannot replay the old tool', async t => {
  const f = await fixture(t, { program: async function* (request, signal): AsyncGenerator<ProviderEvent> { if (request.messages.findLast(message => message.role === 'user')?.content === 'Fresh private successor.') { assert.equal(request.tools.some(tool => tool.name.startsWith('mcp_')), false); yield { type: 'text.delta', delta: 'Explicit fresh completion.' }; yield { type: 'finish', reason: 'stop' }; } else yield* normalProgram(request, signal); } }), receipt = f.submit(); await f.approve(receipt.runId); assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed');
  const original = ['messages', 'message_parts', 'provider_attempts', 'attempt_cleanup', 'attempt_usage', 'tools', 'approvals', 'mcp_executions'].map(table => f.db.prepare(`SELECT data FROM ${table} WHERE run_id=? ORDER BY rowid`).all(receipt.runId));
  await f.reopen(); const exact = f.engine.scheduler.submitLegacy({ sessionId: 'session', requestId: receipt.requestId, prompt: receipt.prompt, config: receipt.config }); assert.equal(exact.runId, receipt.runId); await tick(); assert.equal(f.requests.length, 3); assert.equal(f.peerCalls(), 1);
  const fresh = f.submit('Fresh private successor.', 'fresh'); assert.equal((await f.engine.waitForRun(fresh.runId)).state, 'completed'); assert.equal(f.requests.length, 4); assert.equal(f.peerCalls(), 1);
  assert.deepEqual(['messages', 'message_parts', 'provider_attempts', 'attempt_cleanup', 'attempt_usage', 'tools', 'approvals', 'mcp_executions'].map(table => f.db.prepare(`SELECT data FROM ${table} WHERE run_id=? ORDER BY rowid`).all(receipt.runId)), original); assert.equal(f.wholeReads(), 0);
});
test('registry growth clears the old selection and replans exact schema reservation before the next provider dispatch', async t => {
  const f = await fixture(t, { program: async function* (request): AsyncGenerator<ProviderEvent> { if (!request.tools.some(tool => tool.name === target)) { yield { type: 'tool.call', call: { id: `search-${request.turnIndex}`, name: 'discover_tools', input: { query: 'observe_07', limit: 1 } } }; yield { type: 'finish', reason: 'tool_calls' }; } else if (!request.messages.some(message => message.role === 'tool' && message.content.includes('Exact private observed result.'))) { yield { type: 'tool.call', call: { id: `selected-${request.turnIndex}`, name: target, input: { marker: 'exact-private-observation' } } }; yield { type: 'finish', reason: 'tool_calls' }; } else { yield { type: 'text.delta', delta: 'Completed after exact source rebuild.' }; yield { type: 'finish', reason: 'stop' }; } } });
  const build = f.engine.context.build.bind(f.engine.context); let builds = 0, grew = false;
  f.engine.context.build = async request => { if (++builds === 2) { await f.engine.plugins.activate({ id: 'growth', async activate() { return { tools: [{ name: 'private_growth_tool', description: 'A new private deferred source.', inputSchema: { type: 'object', description: 'z'.repeat(12_288) }, effectClass: 'read', async prepare() { return { name: 'private_growth_tool', input: {}, preview: {}, fingerprint: 'private-growth', requiresApproval: false }; }, async execute() { assert.fail('Registry growth must not execute the deferred handler'); } }] }; } }, request.signal!); f.engine.toolRuntime.setIncludedScopes('engine', ['mcp_many', 'plugin_growth']); grew = true; } return build(request); };
  const receipt = f.submit(); await f.approve(receipt.runId); assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed'); assert.equal(grew, true); assert.equal(f.peerCalls(), 1);
  assert.ok(f.requests.length >= 3); assert.equal(f.requests[1]!.tools.some(tool => tool.name === target), false, 'A registration change clears selected descriptor pins before a new model boundary');
  for (const request of f.requests) assert.equal(request.tools.some(tool => tool.name === 'private_growth_tool'), false); assertReservations(f, receipt.runId); assert.equal(f.wholeReads(), 0);
});
test('a registry change during controlled overflow context rebuilding cannot retry old schemas with a new handler', async t => {
  let requestsInTurn = 0, recovered = 0, oldHandler = 0, newHandler = 0;
  const probeName = 'private_overflow_probe';
  const f = await fixture(t, { discoveryPolicy: { ...policy, alwaysVisibleToolNames: [probeName] }, program: async function* (request): AsyncGenerator<ProviderEvent> {
    if (!request.turnIndex && ++requestsInTurn === 1) { assert.deepEqual((request.tools.find(tool => tool.name === probeName)!.inputSchema.properties as JsonObject).marker, { type: 'string', enum: ['old'] }); throw new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'Private provider requested bounded context recovery.'); }
    if (!request.turnIndex) { yield { type: 'tool.call', call: { id: 'retry-probe', name: probeName, input: { marker: 'old' } } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { yield { type: 'text.delta', delta: 'Private retry completion.' }; yield { type: 'finish', reason: 'stop' }; }
  } });
  const plugin = (marker: 'old' | 'new') => ({ id: 'overflowprobe', async activate() { return { tools: [{ name: probeName, description: `Private ${marker} probe.`, effectClass: 'read' as const, inputSchema: { type: 'object', properties: { marker: { type: 'string', enum: [marker] } } }, async prepare() { return { name: probeName, input: { marker }, preview: {}, fingerprint: `probe-${marker}`, requiresApproval: false }; }, async execute() { if (marker === 'old') oldHandler++; else newHandler++; return { content: `Private ${marker} read observation.` }; } }] }; } });
  await f.engine.activatePlugin(plugin('old'));
  // This is an authored host context-recovery hook. It publishes no semantic
  // summary, no checkpoint and no cleanup proof; actual provider cleanup is
  // still observed and recorded by the real TurnExecutor before this hook.
  f.engine.context.recoverOverflow = async () => { recovered++; await f.engine.deactivatePlugin('overflowprobe'); await f.engine.activatePlugin(plugin('new')); };
  const receipt = f.submit(), run = await f.engine.waitForRun(receipt.runId);
  assert.equal(recovered, 1); assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'TOOL_DISCOVERY_STALE'); assert.equal(f.requests.length, 1); assert.equal(oldHandler, 0); assert.equal(newHandler, 0); assert.equal(f.peerCalls(), 0);
  const first = f.requests[0]!, cleanup = f.engine.store.getAttemptCleanup(first.attemptId!); assert.equal(cleanup.state, 'confirmed'); assert.equal(cleanup.method, 'iterator-return-done'); assert.equal(cleanup.errorCode, 'PROVIDER_CONTEXT_OVERFLOW');
  assert.equal(f.engine.store.getAttempt(first.attemptId!).state, 'failed'); assert.equal(f.engine.store.listTurns(receipt.runId)[0]!.state, 'failed'); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), false); assert.equal(f.wholeReads(), 0);
});
test('an explicitly restricted child can discover only its own core scope and inherits no parent MCP connection', async t => {
  const parentEntered = deferred(), releaseParent = deferred(); let parentRunId = '';
  const f = await fixture(t, { git: true, profiles: [{ id: 'parent-scope', description: 'Parent includes one exact remote name.', instructions: 'Use the private allowed subset.', tools: ['read_file', 'discover_tools', target] }], program: async function* (request, signal): AsyncGenerator<ProviderEvent> {
    if (request.runId === parentRunId) { if (!request.turnIndex) { parentEntered.resolve(); yield { type: 'progress' }; let abort!: () => void; const cancelled = new Promise<void>(yes => { abort = yes; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }); try { await Promise.race([releaseParent.promise, cancelled]); } finally { signal.removeEventListener('abort', abort); } } yield { type: 'text.delta', delta: 'Private parent completion.' }; yield { type: 'finish', reason: 'stop' }; }
    else { assert.deepEqual(request.tools.map(tool => tool.name), ['read_file', 'discover_tools']); if (!request.turnIndex) { yield { type: 'tool.call', call: { id: 'child-discover', name: 'discover_tools', input: { query: 'observe_07', limit: 1 } } }; yield { type: 'finish', reason: 'tool_calls' }; } else { const text = request.messages.find(message => message.role === 'tool' && message.toolCallId === 'child-discover')?.content ?? ''; assert.equal(text.includes(target), false); yield { type: 'text.delta', delta: 'Only the child-owned core scope was observed.' }; yield { type: 'finish', reason: 'stop' }; } }
  } });
  t.after(releaseParent.resolve);
  const worktree = await f.engine.createWorktree('session', 'prepare-private-child'), parent = f.submit('Held private parent.', 'parent', { agentProfileId: 'parent-scope' }); parentRunId = parent.runId; await parentEntered.promise;
  const task = await f.engine.startChildTask({ sessionId: 'session', requestId: 'restricted-child', parentRunId, worktreeId: worktree.id, prompt: 'Search only the explicitly assigned child scope.', tools: ['read_file', 'discover_tools'], allocation: { turns: 2, toolCalls: 1, outputBytes: 4096, durationMs: 5000 } });
  const outcome = await f.engine.children.tasks.wait('session', task.id); assert.equal(outcome.state, 'completed'); assert.equal(f.peerCalls(), 0);
  const childRequests = f.requests.filter(request => request.runId !== parentRunId); assert.equal(childRequests.length, 2); assert.equal(childRequests.some(request => request.tools.some(tool => tool.name.startsWith('mcp_'))), false);
  await assert.rejects(f.engine.startChildTask({ sessionId: 'session', requestId: 'unsupported-parent-connection', parentRunId, worktreeId: worktree.id, prompt: 'Unsupported explicit connection inheritance.', tools: [target], allocation: { turns: 1, toolCalls: 1, outputBytes: 1024, durationMs: 1000 } }), code('CHILD_TOOL_UNAVAILABLE'));
  releaseParent.resolve(); assert.equal((await f.engine.waitForRun(parentRunId)).state, 'completed'); assert.equal(f.wholeReads(), 0);
});
