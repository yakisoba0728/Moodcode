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
import { EngineError, type ApprovalRecord, type JsonObject, type ProviderToolCall, type RunConfig } from '@moodcode/contracts';
import { createEngine, type EngineOptions, type MoodcodeEngine } from '../engine.js';
import { HttpMcpTransport, McpClient } from '../mcp/index.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { SqliteStore } from '../storage/index.js';

const alpha = 'mcp_selection_alpha', beta = 'mcp_selection_beta';
const core = ['list_files', 'read_file', 'search_files', 'apply_patch', 'run_command', 'edit_file', 'rename_file', 'delete_file', 'glob_files', 'regex_search', 'todo_read', 'todo_write', 'ask_user', 'skill_list', 'skill_read', 'reference_read', 'read_artifact', 'format_file', 'lsp_format_file', 'merge_child_changes', 'delegate_task'];
const names = (request: TurnRequest) => request.tools.filter(tool => tool.name.startsWith('mcp_')).map(tool => tool.name);
const code = (expected: string) => (value: unknown) => value instanceof EngineError && value.code === expected;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function poll(check: () => boolean, label: string) { const deadline = Date.now() + 5000; while (!check()) { assert.ok(Date.now() < deadline, `Private boundary not reached: ${label}`); await tick(); } }
type Program = (request: TurnRequest, signal: AbortSignal) => AsyncGenerator<ProviderEvent>;
const discover = (id: string, query: string, action?: 'add' | 'replace', extra: JsonObject = {}): ProviderToolCall => ({ id, name: 'discover_tools', input: { query, limit: 1, ...(action === undefined ? {} : { action }), ...extra } });
const call = (id: string, name: string): ProviderToolCall => ({ id, name, input: { marker: id } });
function sequence(turns: readonly (readonly ProviderToolCall[])[]): Program {
  return async function* (request): AsyncGenerator<ProviderEvent> {
    if (request.messages.findLast(message => message.role === 'user')?.content === 'Fresh private goal.') { yield { type: 'text.delta', delta: 'A fresh Run has no previous discovery selection.' }; yield { type: 'finish', reason: 'stop' }; return; }
    const proposals = turns[request.turnIndex];
    if (proposals) { yield { type: 'usage', inputTokens: 5, outputTokens: 1 }; for (const proposal of proposals) yield { type: 'tool.call', call: proposal }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { yield { type: 'text.delta', delta: 'Private selection observation completed.' }; yield { type: 'finish', reason: 'stop' }; }
  };
}
interface Specification { program: Program; held?: boolean; schemaBytes?: number; profile?: EngineOptions['agentProfiles']; git?: boolean }
interface Fixture {
  engine: MoodcodeEngine; options: EngineOptions; db: DatabaseSync; requests: TurnRequest[]; rpc: JsonObject[]; directory: string;
  accepted: Promise<void>; release(): void; calls(): number; fullReads(): number;
  submit(requestId?: string, prompt?: string, config?: Partial<RunConfig>): { runId: string; requestId: string; prompt: string; config: RunConfig };
  approval(runId: string): Promise<ApprovalRecord>; drive(runId: string, expected: readonly string[]): Promise<ApprovalRecord[]>; reopen(): Promise<void>;
}
function boundedEngine(options: EngineOptions, observe: () => void) {
  const previous = SqliteStore.prototype.getSnapshot, trap = () => { observe(); throw new Error('Selection review forbids whole-session snapshots, including startup'); };
  SqliteStore.prototype.getSnapshot = trap;
  try { const engine = createEngine(options); engine.store.getSnapshot = trap; return engine; } finally { SqliteStore.prototype.getSnapshot = previous; }
}
async function fixture(t: TestContext, specification: Specification): Promise<Fixture> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-selection-review-'))), root = join(directory, 'repository'); await mkdir(root); await writeFile(join(root, 'fixture.txt'), 'Private selection fixture.\n');
  if (specification.git) { execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'add', 'fixture.txt']); execFileSync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'private fixture']); }
  const requests: TurnRequest[] = [], rpc: JsonObject[] = [], accepted = gate(), release = gate(); let peerCalls = 0, fullReads = 0;
  const server = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk; const message = JSON.parse(text) as JsonObject; rpc.push(message); let result: JsonObject;
      if (message.method === 'server/discover') result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } };
      else if (message.method === 'tools/list') result = { tools: ['alpha', 'beta', 'oversized'].map(name => ({ name, description: `Exact private ${name} handler.`, inputSchema: { type: 'object', properties: { marker: { type: 'string', ...(name === 'oversized' ? { description: 'λ'.repeat(9000) } : {}) } }, required: ['marker'] } })) };
      else if (message.method === 'tools/call') { peerCalls++; accepted.resolve(); if (specification.held) await release.promise; result = { content: [{ type: 'text', text: `Terminal private ${String((message.params as JsonObject).name)} observation.` }] }; }
      else { response.writeHead(202); response.end(); return; }
      if (!response.destroyed) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); }
    } catch { if (!response.destroyed) { response.writeHead(500); response.end(); } }
  });
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
  const adapter: ProviderAdapter = { id: 'private-selection', async *streamTurn(request, signal) { requests.push(structuredClone(request)); yield* specification.program(request, signal); } };
  const options: EngineOptions = { dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [adapter], toolDiscoveryPolicy: { kind: 'bounded-tool-discovery', version: 1, maxSelectedTools: 1, ...(specification.schemaBytes === undefined ? {} : { maxSchemaBytes: specification.schemaBytes }) }, defaults: { providerId: adapter.id, modelId: 'private-model', mode: 'build', limits: { maxDurationMs: 10_000, maxTurns: 10 } }, ...(specification.profile ? { agentProfiles: specification.profile } : {}) };
  let engine = boundedEngine(options, () => fullReads++); const db = new DatabaseSync(options.dbPath, { readOnly: true }), now = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt: now }); for (const id of ['session', 'queued']) engine.store.createSession({ id, workspaceId: 'workspace', title: id, createdAt: now });
  const client = new McpClient({ id: 'selection', requestTimeoutMs: specification.held ? 100 : 2000, transport: new HttpMcpTransport({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp` }) }); await engine.connectMcp(client);
  let f!: Fixture;
  f = { engine, options, db, requests, rpc, directory, accepted: accepted.promise, release: release.resolve, calls: () => peerCalls, fullReads: () => fullReads,
    submit(requestId = 'first', prompt = 'Observe exact private tool selection.', overrides = {}) { const config = f.engine.profiles.apply('session', { ...f.engine.getCapabilities().defaults, ...overrides }); const receipt = f.engine.scheduler.submitLegacy({ sessionId: 'session', requestId, prompt, config }); return { runId: receipt.runId, requestId, prompt, config }; },
    async approval(runId) { await poll(() => { const pending = f.engine.store.listPendingRunApprovals(runId); if (pending.length) return true; const run = f.engine.store.getRun(runId); assert.ok(!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state), `Run ended before fixture approval: ${JSON.stringify(run.error ?? run.state)}`); return false; }, 'allowed outer approval'); return f.engine.store.listPendingRunApprovals(runId)[0]!; },
    async drive(runId, expected) { const approvals: ApprovalRecord[] = []; let completed = false; const done = f.engine.waitForRun(runId).then(value => { completed = true; return value; });
      while (!completed) { const pending = f.engine.store.listPendingRunApprovals(runId)[0]; if (pending) { assert.equal(pending.toolName, expected[approvals.length], 'Only explicitly named private approvals may be granted'); approvals.push(f.engine.approvals.decide(pending.id, 'allow', pending.fingerprint)); } await tick(); }
      assert.equal((await done).state, 'completed'); assert.equal(approvals.length, expected.length); return approvals; },
    async reopen() { await f.engine.close(); engine = boundedEngine(options, () => fullReads++); f.engine = engine; await tick(); },
  };
  t.after(async () => { release.resolve(); try { await f.engine.close(); await client.close(); } finally { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); db.close(); await rm(directory, { recursive: true, force: true }); } });
  return f;
}
function reservations(f: Fixture, runId: string) {
  const events = f.engine.store.readEvents('session', 0, 200).filter(event => event.runId === runId && event.type === 'context.prepared'), requests = f.requests.filter(request => request.runId === runId); assert.equal(events.length, new Set(requests.map(request => request.turnIndex)).size);
  requests.forEach(request => { const event = events.find(value => value.payload.turnIndex === request.turnIndex)!; assert.ok(event); assert.deepEqual(event.payload.advertisedToolNames, request.tools.map(tool => tool.name)); assert.equal(event.payload.toolCatalogueSha256, digest(request.tools)); assert.equal(event.payload.reservedToolBytes, Buffer.byteLength(JSON.stringify({ messages: [], tools: request.tools })) - 2); assert.deepEqual(request.tools.filter(tool => core.includes(tool.name)).map(tool => tool.name), core); });
}
const resultFor = (request: TurnRequest, id: string) => request.messages.find(message => message.role === 'tool' && message.toolCallId === id)?.content ?? '';
function originalRows(f: Fixture, runId: string) { return Object.fromEntries(['messages', 'message_parts', 'tools', 'approvals', 'provider_attempts', 'attempt_usage', 'attempt_cleanup', 'mcp_executions'].map(table => [table, f.db.prepare(`SELECT data FROM ${table} WHERE run_id=? ORDER BY rowid`).all(runId)])); }

test('capacity-one replacement executes exact approved A then B, while the old A is hidden at the next model boundary', async t => {
  const f = await fixture(t, { program: sequence([[discover('select-a', 'alpha')], [call('execute-a', alpha)], [discover('replace-b', 'beta', 'replace')], [call('old-a', alpha), call('execute-b', beta)]]) }), receipt = f.submit(), approvals = await f.drive(receipt.runId, [alpha, beta]);
  assert.deepEqual(f.requests.map(names), [[], [alpha], [alpha], [beta], [beta]]); assert.equal(f.calls(), 2); assert.ok(resultFor(f.requests[4]!, 'old-a').includes('TOOL_NOT_FOUND')); assert.ok(resultFor(f.requests[3]!, 'replace-b').includes('"selectionMode":"replace"'));
  const receipts = f.db.prepare('SELECT data FROM mcp_executions WHERE run_id=? ORDER BY rowid').all(receipt.runId).map(row => JSON.parse(String(row.data))); const sent = f.rpc.filter(value => value.method === 'tools/call'); assert.equal(receipts.length, 2);
  receipts.forEach((record, index) => { assert.equal(record.state, 'response-terminal'); assert.equal(record.approvalId, approvals[index]!.id); assert.equal(record.approvalFingerprint, approvals[index]!.fingerprint); assert.equal(record.requestSha256, digest(sent[index])); }); reservations(f, receipt.runId); assert.equal(f.fullReads(), 0);
});
test('omitted action retains add semantics and capacity failure preserves the previous exact selection', async t => {
  const f = await fixture(t, { program: sequence([[discover('select-a', 'alpha')], [discover('add-b', 'beta')]]) }), receipt = f.submit(); await f.drive(receipt.runId, []);
  assert.deepEqual(f.requests.map(names), [[], [alpha], [alpha]]); assert.ok(resultFor(f.requests[2]!, 'add-b').includes('TOOL_DISCOVERY_LIMIT')); assert.equal(resultFor(f.requests[1]!, 'select-a').includes('selectionMode'), false); assert.equal(f.calls(), 0); reservations(f, receipt.runId);
});
test('a no-match replacement clears only the deferred set and keeps core and discovery authority', async t => {
  const f = await fixture(t, { program: sequence([[discover('select-a', 'alpha')], [discover('clear', 'no-matching-private-name', 'replace')], [call('cleared-a', alpha)]]) }), receipt = f.submit(); await f.drive(receipt.runId, []);
  assert.deepEqual(f.requests.map(names), [[], [alpha], [], []]); assert.ok(f.requests.every(request => request.tools.some(tool => tool.name === 'discover_tools'))); assert.ok(resultFor(f.requests[3]!, 'cleared-a').includes('TOOL_NOT_FOUND')); assert.equal(f.calls(), 0); reservations(f, receipt.runId);
});
test('same-provider-batch replacement keeps the prior catalogue and cannot execute newly selected B', async t => {
  const f = await fixture(t, { program: sequence([[discover('select-a', 'alpha')], [discover('replace-b', 'beta', 'replace'), call('same-turn-a', alpha), call('same-turn-b', beta)]]) }), receipt = f.submit(), approvals = await f.drive(receipt.runId, [alpha]);
  assert.deepEqual(f.requests.map(names), [[], [alpha], [beta]]); assert.ok(resultFor(f.requests[2]!, 'same-turn-b').includes('TOOL_NOT_FOUND')); assert.equal(f.calls(), 1); assert.equal(f.engine.store.listPendingRunApprovals(receipt.runId).length, 0);
  const execution = JSON.parse(String(f.db.prepare('SELECT data FROM mcp_executions WHERE run_id=?').get(receipt.runId)!.data)); assert.equal(execution.toolName, alpha); assert.equal(execution.state, 'response-terminal'); assert.equal(execution.approvalFingerprint, approvals[0]!.fingerprint); reservations(f, receipt.runId);
});
for (const invalid of ['utf8-schema', 'oversized-query', 'unknown-action'] as const) test(`failed ${invalid} replacement cannot publish a new selection`, async t => {
  const replacement = invalid === 'utf8-schema' ? discover('invalid', 'oversized', 'replace') : invalid === 'oversized-query' ? discover('invalid', 'λ'.repeat(200), 'replace') : discover('invalid', 'beta', 'replace', { action: 'unrecognized' });
  const f = await fixture(t, { schemaBytes: 20_000, program: sequence([[discover('select-a', 'alpha')], [replacement]]) }), receipt = f.submit(); await f.drive(receipt.runId, []);
  assert.deepEqual(f.requests.map(names), [[], [alpha], [alpha]]); assert.ok(resultFor(f.requests[2]!, 'invalid').includes(invalid === 'utf8-schema' ? 'TOOL_DISCOVERY_LIMIT' : 'INVALID_TOOL_DISCOVERY_QUERY')); assert.equal(f.calls(), 0); reservations(f, receipt.runId);
});
test('native result persistence failure cannot activate a replacement candidate', async t => {
  const f = await fixture(t, { program: sequence([[discover('select-a', 'alpha')], [discover('replace-b', 'beta', 'replace')]]) }), putPart = f.engine.store.putPart.bind(f.engine.store); let injected = false;
  f.engine.store.putPart = part => { if (!injected && part.type === 'tool' && part.name === 'discover_tools' && (part.input as JsonObject).action === 'replace' && part.result !== undefined) { injected = true; throw new EngineError('FIXTURE_NATIVE_RESULT_FAILURE', 'Private native Part rejection.'); } return putPart(part); };
  const receipt = f.submit(); await f.engine.waitForRun(receipt.runId); assert.equal(injected, true); assert.equal(f.calls(), 0); for (const request of f.requests.slice(2)) assert.equal(names(request).includes(beta), false); assert.equal(f.engine.store.listPendingRunApprovals(receipt.runId).length, 0);
});
test('policy change after result persistence invalidates replacement descriptor pins before activation', async t => {
  const f = await fixture(t, { program: sequence([[discover('select-a', 'alpha')], [discover('replace-b', 'beta', 'replace')]]) }), putPart = f.engine.store.putPart.bind(f.engine.store); let changed = false;
  f.engine.store.putPart = part => { const result = putPart(part); if (!changed && part.type === 'tool' && part.name === 'discover_tools' && (part.input as JsonObject).action === 'replace' && part.result !== undefined) { changed = true; f.engine.toolRuntime.policy.replace([{ tool: beta, decision: 'deny' }]); } return result; };
  const receipt = f.submit(); await f.drive(receipt.runId, []); assert.equal(changed, true); assert.deepEqual(f.requests.map(names), [[], [alpha], []]); assert.equal(f.calls(), 0); reservations(f, receipt.runId);
});
test('cancel while replacement result is being saved cannot dispatch the next model or a remote handler', async t => {
  const f = await fixture(t, { program: sequence([[discover('select-a', 'alpha')], [discover('replace-b', 'beta', 'replace')]]) }), putPart = f.engine.store.putPart.bind(f.engine.store); let cancelled = false;
  f.engine.store.putPart = part => { const result = putPart(part); if (!cancelled && part.type === 'tool' && part.name === 'discover_tools' && (part.input as JsonObject).action === 'replace' && part.result !== undefined) { cancelled = true; f.engine.coordinator.cancel(part.runId); } return result; };
  const receipt = f.submit(), run = await f.engine.waitForRun(receipt.runId); assert.equal(cancelled, true); assert.equal(run.state, 'cancelled'); assert.equal(f.requests.length, 2); assert.equal(f.calls(), 0); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), false);
});
test('an accepted selected B timeout retains its unknown receipt and blocks fresh and queued execution', async t => {
  const f = await fixture(t, { held: true, program: sequence([[discover('select-a', 'alpha')], [discover('replace-b', 'beta', 'replace')], [call('timeout-b', beta)]]) }), receipt = f.submit(), approval = await f.approval(receipt.runId); assert.equal(approval.toolName, beta); f.engine.approvals.decide(approval.id, 'allow', approval.fingerprint); await f.accepted;
  const run = await f.engine.waitForRun(receipt.runId); assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(f.requests.length, 3); assert.equal(f.calls(), 1); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), true);
  const record = JSON.parse(String(f.db.prepare('SELECT data FROM mcp_executions WHERE run_id=?').get(receipt.runId)!.data)); assert.equal(record.state, 'uncertain'); assert.equal(record.approvalFingerprint, approval.fingerprint); assert.throws(() => f.submit('blocked'), code('CLEANUP_PENDING'));
  const queued = f.engine.scheduler.accept({ sessionId: 'queued', requestId: 'waiting', prompt: 'Private pending goal.', config: f.engine.getCapabilities().defaults, delivery: 'queue' }); await f.engine.waitForSession('queued').catch(() => {}); assert.equal(f.engine.store.getInput(queued.inputId).state, 'pending'); assert.equal(f.engine.store.getInput(queued.inputId).runId, undefined);
  const before = originalRows(f, receipt.runId); f.release(); await tick(); await f.reopen(); assert.deepEqual(originalRows(f, receipt.runId), before); assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), true); assert.equal(f.requests.length, 3); assert.equal(f.calls(), 1); assert.equal(f.fullReads(), 0);
});
test('exact retry and restart preserve completed replacement history without inheriting or replaying the selected set', async t => {
  const f = await fixture(t, { program: sequence([[discover('select-a', 'alpha')], [discover('replace-b', 'beta', 'replace')], [call('terminal-b', beta)]]) }), receipt = f.submit(); await f.drive(receipt.runId, [beta]); const before = originalRows(f, receipt.runId); assert.equal(f.requests.length, 4);
  await f.reopen(); const duplicate = f.engine.scheduler.submitLegacy({ sessionId: 'session', requestId: receipt.requestId, prompt: receipt.prompt, config: receipt.config }); assert.equal(duplicate.runId, receipt.runId); await tick(); assert.equal(f.requests.length, 4); assert.equal(f.calls(), 1);
  const fresh = f.submit('fresh', 'Fresh private goal.'); await f.drive(fresh.runId, []); assert.deepEqual(names(f.requests[4]!), []); assert.deepEqual(originalRows(f, receipt.runId), before); assert.equal(f.calls(), 1); assert.equal(f.fullReads(), 0);
});
test('a real retryable provider attempt preserves the selected B catalogue and durable cleanup before the exact approved RPC', async t => {
  let attempts = 0;
  const ordinary = sequence([[discover('select-a', 'alpha')], [discover('replace-b', 'beta', 'replace')], [call('retry-b', beta)]]);
  const f = await fixture(t, { program: async function* (request, signal): AsyncGenerator<ProviderEvent> { if (request.turnIndex === 2 && ++attempts === 1) throw new EngineError('PROVIDER_HTTP_ERROR', 'Private observed retryable response.', { status: 503, retryAfterMs: 0 }); yield* ordinary(request, signal); } }), receipt = f.submit(); await f.drive(receipt.runId, [beta]);
  assert.equal(attempts, 2); assert.equal(f.requests.length, 5); assert.deepEqual(names(f.requests[2]!), [beta]); assert.deepEqual(f.requests[3]!.tools, f.requests[2]!.tools); assert.notEqual(f.requests[3]!.attemptId, f.requests[2]!.attemptId);
  const firstAttemptId = f.requests[2]!.attemptId!, first = f.engine.store.getAttempt(firstAttemptId), cleanup = f.engine.store.getAttemptCleanup(firstAttemptId); assert.equal(first.state, 'failed'); assert.equal(cleanup.state, 'confirmed'); assert.equal(cleanup.method, 'iterator-return-done'); assert.equal(cleanup.errorCode, 'PROVIDER_HTTP_ERROR'); assert.equal(cleanup.requestSha256, digest(f.requests[2]));
  assert.equal(f.engine.store.getAttempt(f.requests[3]!.attemptId!).state, 'completed'); assert.equal(f.calls(), 1); reservations(f, receipt.runId); assert.equal(f.fullReads(), 0);
});
test('a confined child replacement cannot select or reveal either parent-only MCP handler', async t => {
  const entered = gate(), releaseParent = gate(); let parentId = '';
  const f = await fixture(t, { git: true, profile: [{ id: 'parent-profile', description: 'Parent exact scope.', instructions: 'Use the private permitted tools.', tools: ['read_file', 'discover_tools', alpha, beta] }], program: async function* (request, signal): AsyncGenerator<ProviderEvent> {
    if (request.runId === parentId) { if (!request.turnIndex) { entered.resolve(); yield { type: 'progress' }; let abort!: () => void; const cancelled = new Promise<void>(yes => { abort = yes; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }); try { await Promise.race([releaseParent.promise, cancelled]); } finally { signal.removeEventListener('abort', abort); } } yield { type: 'text.delta', delta: 'Private parent observation.' }; yield { type: 'finish', reason: 'stop' }; }
    else { assert.deepEqual(request.tools.map(tool => tool.name), ['read_file', 'discover_tools']); if (!request.turnIndex) { yield { type: 'tool.call', call: discover('child-replace', 'beta', 'replace') }; yield { type: 'finish', reason: 'tool_calls' }; } else { assert.equal(resultFor(request, 'child-replace').includes(beta), false); assert.equal(resultFor(request, 'child-replace').includes(alpha), false); assert.ok(resultFor(request, 'child-replace').includes('"selectionMode":"replace"')); yield { type: 'text.delta', delta: 'Only the child-owned scope was available.' }; yield { type: 'finish', reason: 'stop' }; } }
  } });
  t.after(releaseParent.resolve); const worktree = await f.engine.createWorktree('session', 'prepare-child'), parent = f.submit('parent', 'Held private parent.', { agentProfileId: 'parent-profile' }); parentId = parent.runId; await entered.promise;
  const task = await f.engine.startChildTask({ sessionId: 'session', requestId: 'confined-replace', parentRunId: parentId, worktreeId: worktree.id, prompt: 'Replace only within the explicitly assigned child scope.', tools: ['read_file', 'discover_tools'], allocation: { turns: 2, toolCalls: 1, outputBytes: 4096, durationMs: 5000 } }); assert.equal((await f.engine.children.tasks.wait('session', task.id)).state, 'completed');
  const childRequests = f.requests.filter(request => request.runId !== parentId); assert.equal(childRequests.length, 2); assert.deepEqual(childRequests.map(names), [[], []]); assert.equal(f.calls(), 0);
  await assert.rejects(f.engine.startChildTask({ sessionId: 'session', requestId: 'parent-connection', parentRunId: parentId, worktreeId: worktree.id, prompt: 'Unsupported direct connection inheritance.', tools: [beta], allocation: { turns: 1, toolCalls: 1, outputBytes: 1024, durationMs: 1000 } }), code('CHILD_TOOL_UNAVAILABLE'));
  releaseParent.resolve(); assert.equal((await f.engine.waitForRun(parentId)).state, 'completed'); assert.equal(f.fullReads(), 0);
});
