import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as tick } from 'node:timers/promises';
import { EngineError } from '@moodcode/contracts';
import { CredentialBroker } from '../credentials/index.js';
import { McpClient } from './client.js';
import { HttpMcpTransport } from './http.js';
import { StdioMcpTransport } from './stdio.js';
import { encodeMessage, type JsonRpcMessage, type JsonRpcRequest, type McpTransport } from './protocol.js';
import type { McpToolCallObservation, McpToolCallObserver } from './execution-observation.js';

const endpoint = 'http://127.0.0.1:1/mcp';
const signal = () => new AbortController().signal;
const terminal = (request: JsonRpcRequest, extra: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: request.id, result: { resultType: 'complete', content: [{ type: 'text', text: 'authored fixture result' }], ...extra } });
const errorCode = (expected: string, effectsUncertain?: boolean) => (error: unknown) => {
  assert.ok(error instanceof EngineError); assert.equal(error.code, expected);
  if (effectsUncertain !== undefined) assert.equal(error.details?.effectsUncertain, effectsUncertain);
  return true;
};
function observe() { const events: McpToolCallObservation[] = []; return { events, observer: ((event) => events.push(event)) as McpToolCallObserver }; }
function settlement(events: readonly McpToolCallObservation[]) { const event = events.findLast(event => event.phase === 'settled'); assert.ok(event && event.phase === 'settled'); return event.settlement; }

async function http(t: test.TestContext, options: {
  tool?(request: JsonRpcRequest): Response | Promise<Response>;
  credential?: ConstructorParameters<typeof HttpMcpTransport>[0]['credential'];
  timeout?: number;
} = {}) {
  const requests: { message: JsonRpcRequest; body: string }[] = [];
  const transport = new HttpMcpTransport({ url: endpoint, credential: options.credential, fetch: (async (_url, init) => {
    const body = String(init?.body), request = JSON.parse(body) as JsonRpcRequest; requests.push({ message: request, body });
    let reply: unknown;
    if (request.method === 'server/discover') reply = { jsonrpc: '2.0', id: request.id, result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } } };
    else if (request.method === 'tools/list') reply = { jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'fixture', inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } }, annotations: { readOnlyHint: true } }] } };
    else if (request.method === 'tools/call') { if (options.tool) return options.tool(request); reply = terminal(request); }
    else throw new Error('Unexpected authored fixture request');
    return new Response(JSON.stringify(reply), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch });
  const client = new McpClient({ id: 'observed', transport, requestTimeoutMs: options.timeout ?? 1000 });
  t.after(() => client.close()); await client.connect(signal()); await client.listTools(signal());
  return { client, transport, requests, calls: () => requests.filter(value => value.message.method === 'tools/call') };
}

test('physical intent precedes HTTP dispatch and exact logical request/response hashes contain no credentials', async t => {
  const broker = new CredentialBroker({ async resolve() { return { bearerToken: 'authored-secret-marker', expiresAt: Date.now() + 60000 }; } });
  const fixture = await http(t, { credential: { broker, reference: { id: 'host:fixture', audience: endpoint } } });
  const trace = observe();
  const observer: McpToolCallObserver = event => { if (event.phase === 'dispatch-intent') { assert.equal(event.boundary, 'http-fetch'); assert.equal(fixture.calls().length, 0); } trace.observer(event); };
  const result = await fixture.client.callTool('fixture', { region: '서울', payload: 'raw arguments are not receipt metadata' }, fixture.client.revision, signal(), observer);
  assert.ok(Array.isArray(result.content)); assert.equal(result.content.length, 1); assert.deepEqual(trace.events.map(event => event.phase), ['prepared', 'dispatch-intent', 'settled']);
  const body = fixture.calls()[0]!.body, identity = trace.events[0]!.identity;
  assert.equal(identity.requestSha256, createHash('sha256').update(body).digest('hex')); assert.equal(identity.requestBytes, Buffer.byteLength(body));
  assert.equal(identity.logicalRpcId, fixture.calls()[0]!.message.id); assert.match(identity.connectionId, /^[0-9a-f-]{36}$/);
  const final = settlement(trace.events), response = JSON.stringify(terminal(fixture.calls()[0]!.message));
  assert.equal(final.outcome, 'response-terminal'); assert.equal(final.transportCleanupConfirmed, true);
  assert.equal(final.responseSha256, createHash('sha256').update(response).digest('hex')); assert.equal(final.responseBytes, Buffer.byteLength(response));
  assert.ok(!JSON.stringify(trace.events).includes('authored-secret-marker')); assert.ok(!JSON.stringify(trace.events).includes('raw arguments'));
});

test('prepared or durable-intent rejection cannot send an HTTP request', async t => {
  for (const phase of ['prepared', 'dispatch-intent'] as const) {
    const fixture = await http(t), trace = observe();
    const observer: McpToolCallObserver = event => { trace.observer(event); if (event.phase === phase) throw new EngineError('AUTHORED_JOURNAL_FAILURE', 'fixture failure'); };
    await assert.rejects(fixture.client.callTool('fixture', {}, fixture.client.revision, signal(), observer), errorCode(phase === 'prepared' ? 'AUTHORED_JOURNAL_FAILURE' : 'MCP_EXECUTION_RECORD_FAILED'));
    assert.equal(fixture.calls().length, 0);
    if (phase === 'dispatch-intent') { assert.equal(settlement(trace.events).outcome, 'not-dispatched'); assert.equal(settlement(trace.events).reason, 'journal-error'); }
  }
});

test('post-dispatch receipt failure cannot become an ordinary success', async t => {
  const fixture = await http(t), trace = observe();
  await assert.rejects(fixture.client.callTool('fixture', {}, fixture.client.revision, signal(), event => { trace.observer(event); if (event.phase === 'settled') throw new Error('fixture journal failure'); }), errorCode('MCP_EXECUTION_RECORD_FAILED', true));
  assert.equal(fixture.calls().length, 1); assert.equal(settlement(trace.events).outcome, 'response-terminal');
});

for (const phase of ['prepared', 'dispatch-intent', 'settled'] as const) test(`an asynchronous ${phase} observer is rejected without trusting unfinished durable work`, async t => {
  const fixture = await http(t);
  await assert.rejects(fixture.client.callTool('fixture', {}, fixture.client.revision, signal(), event => { if (event.phase === phase) return Promise.reject(new Error('authored asynchronous journal rejection')); }), errorCode(phase === 'prepared' ? 'MCP_EXECUTION_OBSERVER_ASYNC' : 'MCP_EXECUTION_RECORD_FAILED', phase === 'prepared' ? undefined : true));
  assert.equal(fixture.calls().length, phase === 'settled' ? 1 : 0);
});

test('ambiguous committed intent stays unsafe when a later no-send settlement is rejected', async t => {
  const fixture = await http(t); let durableIntent = false;
  await assert.rejects(fixture.client.callTool('fixture', {}, fixture.client.revision, signal(), event => {
    if (event.phase === 'dispatch-intent') { durableIntent = true; throw new Error('fixture failed after durable intent'); }
    if (event.phase === 'settled') { assert.equal(durableIntent, true); assert.equal(event.settlement.outcome, 'not-dispatched'); throw new EngineError('TRANSITION_INVALID', 'durable intent cannot be rewritten as no-send'); }
  }), error => { assert.ok(error instanceof EngineError); assert.equal(error.code, 'MCP_EXECUTION_RECORD_FAILED'); assert.equal(error.details?.effectsUncertain, true); assert.equal(error.details?.executionBlocked, true); return true; });
  assert.equal(fixture.calls().length, 0);
});

test('credential failure after preparation proves no physical request was sent', async t => {
  let deny = false;
  const broker = new CredentialBroker({ async resolve() { if (deny) throw new Error('secret host details'); return { bearerToken: 'fixture-token', expiresAt: Date.now() + 60000 }; } });
  const reference = { id: 'host:fixture', audience: endpoint };
  const fixture = await http(t, { credential: { broker, reference } }), trace = observe();
  deny = true; broker.clear(reference);
  await assert.rejects(fixture.client.callTool('fixture', {}, fixture.client.revision, signal(), trace.observer), errorCode('CREDENTIAL_HOST_FAILED', false));
  assert.equal(fixture.calls().length, 0); assert.deepEqual(trace.events.map(event => event.phase), ['prepared', 'settled']);
  assert.equal(settlement(trace.events).outcome, 'not-dispatched'); assert.ok(!JSON.stringify(trace.events).includes('secret host'));
});

test('pre-abort, stale catalogue and header validation never assert dispatch', async t => {
  const fixture = await http(t), trace = observe(), controller = new AbortController(); controller.abort();
  await assert.rejects(fixture.client.callTool('fixture', {}, fixture.client.revision, controller.signal, trace.observer), errorCode('MCP_CANCELLED'));
  await assert.rejects(fixture.client.callTool('fixture', {}, fixture.client.revision - 1, signal(), trace.observer), errorCode('MCP_CATALOGUE_STALE'));
  await assert.rejects(fixture.client.callTool('fixture', { region: 1 }, fixture.client.revision, signal(), trace.observer), errorCode('MCP_INVALID_TOOL_ARGUMENT'));
  assert.equal(trace.events.length, 0); assert.equal(fixture.calls().length, 0);
});

test('abort while host credentials are pending stays not-dispatched without future fetch', async t => {
  let held = false, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const broker = new CredentialBroker({ async resolve() { if (held) { entered(); return await new Promise<never>(() => {}); } return { bearerToken: 'fixture-token', expiresAt: Date.now() + 60000 }; } });
  const reference = { id: 'host:fixture', audience: endpoint }, fixture = await http(t, { credential: { broker, reference } });
  held = true; broker.clear(reference); const trace = observe(), controller = new AbortController();
  const pending = fixture.client.callTool('fixture', {}, fixture.client.revision, controller.signal, trace.observer); void pending.catch(() => {});
  await enteredPromise; controller.abort(); await assert.rejects(pending, errorCode('MCP_CANCELLED', false));
  assert.equal(settlement(trace.events).outcome, 'not-dispatched'); assert.equal(fixture.calls().length, 0);
});

for (const [name, reply, expected] of [
  ['malformed tool content', (r: JsonRpcRequest) => ({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: 42 }] } }), 'MCP_INVALID_TOOL_RESULT'],
  ['unsupported input-required', (r: JsonRpcRequest) => ({ jsonrpc: '2.0', id: r.id, result: { resultType: 'input_required', inputRequests: {} } }), 'MCP_INPUT_REQUIRED_UNSUPPORTED'],
  ['wrong response ID', (_r: JsonRpcRequest) => ({ jsonrpc: '2.0', id: 999, result: { content: [] } }), 'MCP_RESPONSE_ID_MISMATCH'],
  ['oversized response', (r: JsonRpcRequest) => terminal(r, { large: 'x'.repeat(1048576) }), 'MCP_MESSAGE_LIMIT'],
] as const) test(`after dispatch ${name} preserves unknown effects`, async t => {
  const fixture = await http(t, { tool: request => new Response(JSON.stringify(reply(request)), { headers: { 'Content-Type': 'application/json' } }) }), trace = observe();
  await assert.rejects(fixture.client.callTool('fixture', {}, fixture.client.revision, signal(), trace.observer), errorCode(expected, true));
  assert.equal(fixture.calls().length, 1); assert.equal(settlement(trace.events).outcome, 'uncertain'); assert.equal(settlement(trace.events).reason, 'invalid-response');
});

test('valid isError tool results and correlated JSON-RPC errors are known terminal observations', async t => {
  for (const rpcError of [false, true]) {
    const fixture = await http(t, { tool: request => new Response(JSON.stringify(rpcError ? { jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'authored operation error' } } : terminal(request, { isError: true })), { headers: { 'Content-Type': 'application/json' } }) }), trace = observe();
    const pending = fixture.client.callTool('fixture', {}, fixture.client.revision, signal(), trace.observer);
    if (rpcError) await assert.rejects(pending, errorCode('MCP_REMOTE_ERROR')); else assert.equal((await pending).isError, true);
    const final = settlement(trace.events); assert.equal(final.outcome, 'response-terminal'); assert.equal(final.responseKind, rpcError ? 'jsonrpc-error' : 'tool-result'); assert.equal(final.transportCleanupConfirmed, true);
  }
});

test('a generic HTTP rejection after fetch entry remains effect-uncertain', async t => {
  const fixture = await http(t, { tool() { throw new Error('secret transport description'); } }), trace = observe();
  await assert.rejects(fixture.client.callTool('fixture', {}, fixture.client.revision, signal(), trace.observer), errorCode('MCP_HTTP_FAILED', true));
  assert.equal(settlement(trace.events).reason, 'transport-error'); assert.equal(settlement(trace.events).outcome, 'uncertain'); assert.ok(!JSON.stringify(trace.events).includes('secret transport'));
});

test('plain reader cancellation failure preserves a terminal response but denies local cleanup proof', async t => {
  const fixture = await http(t, { tool: request => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('data: ' + JSON.stringify(terminal(request)) + '\n\n')); }, cancel() { throw new Error('authored reader cancellation rejection'); } }), { headers: { 'Content-Type': 'text/event-stream' } }) }), trace = observe();
  await assert.rejects(fixture.client.callTool('fixture', {}, fixture.client.revision, signal(), trace.observer), error => { assert.ok(error instanceof EngineError); assert.equal(error.code, 'MCP_TRANSPORT_CLEANUP_UNCERTAIN'); assert.equal(error.details?.effectsUncertain, false); assert.equal(error.details?.cleanupUncertain, true); return true; });
  const final = settlement(trace.events); assert.equal(final.outcome, 'uncertain'); assert.equal(final.reason, 'cleanup-error'); assert.equal(final.responseKind, 'tool-result'); assert.equal(final.transportCleanupConfirmed, false);
});

test('a plain body cancellation rejection cannot claim cleanup after an unsupported response type', async t => {
  const fixture = await http(t, { tool: () => new Response(new ReadableStream<Uint8Array>({ cancel() { throw new Error('authored body cancellation failed'); } }), { headers: { 'Content-Type': 'text/plain' } }) }), trace = observe();
  await assert.rejects(fixture.client.callTool('fixture', {}, fixture.client.revision, signal(), trace.observer), error => { assert.ok(error instanceof EngineError); assert.equal(error.details?.effectsUncertain, true); assert.equal(error.details?.cleanupUncertain, true); return true; });
  assert.equal(settlement(trace.events).outcome, 'uncertain'); assert.equal(settlement(trace.events).transportCleanupConfirmed, false);
});

test('a plain reader release exception does not overwrite unconfirmed cleanup with a generic transport error', async t => {
  let release: (() => void) | undefined;
  const fixture = await http(t, { tool: request => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('data: ' + JSON.stringify(terminal(request)) + '\n\n')); } });
    const getReader = body.getReader.bind(body);
    Object.defineProperty(body, 'getReader', { value: () => { const reader = getReader(); release = reader.releaseLock.bind(reader); reader.releaseLock = () => { throw new Error('authored release failed'); }; return reader; } });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  } }), trace = observe();
  t.after(() => release?.());
  await assert.rejects(fixture.client.callTool('fixture', {}, fixture.client.revision, signal(), trace.observer), error => { assert.ok(error instanceof EngineError); assert.equal(error.details?.effectsUncertain, false); assert.equal(error.details?.cleanupUncertain, true); return true; });
  assert.equal(settlement(trace.events).responseKind, 'tool-result'); assert.equal(settlement(trace.events).transportCleanupConfirmed, false);
});

test('a locked HTTP body cannot be acquired or advertised as locally cleaned', async t => {
  let ownedReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const fixture = await http(t, { tool: request => { const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(JSON.stringify(terminal(request)))); } }); const response = new Response(body, { headers: { 'Content-Type': 'application/json' } }); ownedReader = response.body!.getReader(); return response; } }), trace = observe();
  t.after(async () => { await ownedReader?.cancel(); ownedReader?.releaseLock(); });
  await assert.rejects(fixture.client.callTool('fixture', {}, fixture.client.revision, signal(), trace.observer), error => { assert.ok(error instanceof EngineError); assert.equal(error.details?.effectsUncertain, true); assert.equal(error.details?.cleanupUncertain, true); return true; });
  assert.equal(settlement(trace.events).responseKind, undefined); assert.equal(settlement(trace.events).transportCleanupConfirmed, false);
});

test('legacy DELETE best-effort peer termination does not hide an owned response body cleanup failure', async () => {
  const transport = new HttpMcpTransport({ url: endpoint, protocolVersion: '2025-11-25', fetch: (async (_url, init) => {
    if (init?.method === 'DELETE') return new Response(new ReadableStream<Uint8Array>({ cancel() { throw new Error('authored DELETE body cleanup failed'); } }));
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    if (request.id === undefined) return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-11-25', capabilities: {} } }), { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'authored-session' } });
  }) as typeof fetch });
  const client = new McpClient({ id: 'legacy-cleanup', transport, protocolVersion: '2025-11-25' }); await client.connect(signal());
  await assert.rejects(client.close(), errorCode('MCP_TRANSPORT_CLEANUP_UNCERTAIN'));
});

function custom(options: { tool(request: JsonRpcRequest, emit: (message: JsonRpcMessage) => void): Promise<void>; cancel?(): Promise<void>; close?(): Promise<void>; claimHook?: boolean }): McpTransport {
  let receive!: (message: JsonRpcMessage) => void;
  return { kind: 'http', ...(options.claimHook ? { dispatchBoundary: 'before-send-v1' as const } : {}), async start(callback) { receive = callback; }, async send(message) {
    if (!('method' in message)) return;
    if (message.method === 'server/discover') receive({ jsonrpc: '2.0', id: message.id!, result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } } });
    else if (message.method === 'tools/list') receive({ jsonrpc: '2.0', id: message.id!, result: { tools: [{ name: 'fixture', inputSchema: { type: 'object' } }] } });
    else if (message.method === 'tools/call') await options.tool(message, receive);
  }, async cancel() { await options.cancel?.(); }, async close() { await options.close?.(); } };
}
async function customClient(t: test.TestContext, transport: McpTransport, timeout = 1000) { const client = new McpClient({ id: 'custom', transport, requestTimeoutMs: timeout }); t.after(() => client.close().catch(error => { assert.equal(error.code, 'MCP_TRANSPORT_CLEANUP_UNCERTAIN'); })); await client.connect(signal()); await client.listTools(signal()); return client; }

test('legacy and falsely claimed hook transports use conservative API-entry intent', async t => {
  for (const claimHook of [false, true]) {
    const client = await customClient(t, custom({ claimHook, async tool() { throw new EngineError('AUTHORED_SEND_REJECTION', 'fixture API rejection'); } })), trace = observe();
    await assert.rejects(client.callTool('fixture', {}, client.revision, signal(), trace.observer), errorCode('AUTHORED_SEND_REJECTION', true));
    const event = trace.events.find(event => event.phase === 'dispatch-intent'); assert.ok(event && event.phase === 'dispatch-intent'); assert.equal(event.boundary, 'legacy-api-entry'); assert.equal(settlement(trace.events).outcome, 'uncertain');
  }
});

test('late correlated responses cannot overwrite the first uncertain settlement or settle a later call', async t => {
  let emitLate!: () => void, calls = 0;
  const client = await customClient(t, custom({ async tool(request, emit) { calls++; if (calls === 1) emitLate = () => emit(terminal(request) as JsonRpcMessage); else emit(terminal(request) as JsonRpcMessage); } }), 10), trace = observe();
  await assert.rejects(client.callTool('fixture', {}, client.revision, signal(), trace.observer), errorCode('MCP_REQUEST_TIMEOUT', true));
  emitLate(); await tick(); assert.equal(trace.events.filter(event => event.phase === 'settled').length, 1); assert.equal(settlement(trace.events).outcome, 'uncertain');
  const fresh = observe(); await client.callTool('fixture', {}, client.revision, signal(), fresh.observer); assert.notEqual(fresh.events[0]!.identity.logicalRpcId, trace.events[0]!.identity.logicalRpcId); assert.equal(calls, 2);
});

test('an already dispatched valid response survives catalogue invalidation while a new old-catalogue call is rejected', async t => {
  const client = await customClient(t, custom({ async tool(request, emit) { emit({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); emit(terminal(request) as JsonRpcMessage); } })), trace = observe(), revision = client.revision;
  await client.callTool('fixture', {}, revision, signal(), trace.observer);
  assert.equal(settlement(trace.events).outcome, 'response-terminal'); assert.equal(trace.events[0]!.identity.catalogueRevision, revision);
  await assert.rejects(client.callTool('fixture', {}, revision, signal(), trace.observer), errorCode('MCP_CATALOGUE_STALE'));
  assert.equal(trace.events.filter(event => event.phase === 'dispatch-intent').length, 1);
});

test('bounded response cleanup cannot claim completion of a noncooperating send', async t => {
  const client = await customClient(t, custom({ async tool(request, emit) { emit(terminal(request) as JsonRpcMessage); await new Promise<never>(() => {}); } })), trace = observe();
  const start = Date.now();
  await assert.rejects(client.callTool('fixture', {}, client.revision, signal(), trace.observer), errorCode('MCP_TRANSPORT_CLEANUP_UNCERTAIN', false));
  assert.ok(Date.now() - start < 1500); assert.equal(settlement(trace.events).responseKind, 'tool-result'); assert.equal(settlement(trace.events).transportCleanupConfirmed, false);
});

test('completed peer responses still occupy the request cap until their local sends are settled', async t => {
  let calls = 0;
  const client = await customClient(t, custom({ async tool(request, emit) { calls++; emit(terminal(request) as JsonRpcMessage); await new Promise<never>(() => {}); } }));
  const pending = Array.from({ length: 32 }, () => client.callTool('fixture', {}, client.revision, signal()).catch(error => { assert.ok(error instanceof EngineError); assert.equal(error.details?.cleanupUncertain, true); }));
  const extra = observe(); await assert.rejects(client.callTool('fixture', {}, client.revision, signal(), extra.observer), errorCode('MCP_PENDING_LIMIT'));
  assert.equal(calls, 32); assert.equal(extra.events.length, 0); await Promise.all(pending);
});

test('a rejected cancellation is not a confirmed local cleanup receipt', async t => {
  const client = await customClient(t, custom({ async tool() {}, async cancel() { throw new Error('authored cancellation failed'); } }), 10), trace = observe();
  await assert.rejects(client.callTool('fixture', {}, client.revision, signal(), trace.observer), error => { assert.ok(error instanceof EngineError); assert.equal(error.details?.effectsUncertain, true); assert.equal(error.details?.cleanupUncertain, true); return true; });
  assert.equal(settlement(trace.events).transportCleanupConfirmed, false);
});

test('close joins request observers and a plain close rejection remains cleanup-uncertain', async t => {
  let entered!: () => void; const entry = new Promise<void>(resolve => { entered = resolve; });
  const client = await customClient(t, custom({ async tool() { entered(); }, async close() { throw new Error('authored close failed'); } })), trace = observe();
  const pending = client.callTool('fixture', {}, client.revision, signal(), trace.observer); void pending.catch(() => {}); await entry;
  await assert.rejects(client.close(), errorCode('MCP_TRANSPORT_CLEANUP_UNCERTAIN')); await assert.rejects(pending, errorCode('MCP_DISCONNECTED', true));
  assert.equal(trace.events.filter(event => event.phase === 'settled').length, 1);
});

test('actual stdio uses the write boundary and an observer rejection writes no tools/call', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-mcp-observation-')));
  const compiled = fileURLToPath(new URL('./fixtures/server.js', import.meta.url)), path = existsSync(compiled) ? compiled : fileURLToPath(new URL('./fixtures/server.ts', import.meta.url));
  const transport = new StdioMcpTransport({ command: process.execPath, args: [path], cwd: directory }), client = new McpClient({ id: 'stdio-observed', transport });
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); }); await client.connect(signal()); await client.listTools(signal());
  const trace = observe(); await client.callTool('echo', { text: 'stdio fixture' }, client.revision, signal(), trace.observer);
  const intent = trace.events.find(event => event.phase === 'dispatch-intent'); assert.ok(intent && intent.phase === 'dispatch-intent'); assert.equal(intent.boundary, 'stdio-write'); assert.equal(settlement(trace.events).outcome, 'response-terminal');
  const written: number[] = [], originalWrite = (transport as unknown as { child: { stdin: { write: (...args: unknown[]) => boolean } } }).child.stdin.write;
  const stdin = (transport as unknown as { child: { stdin: { write: (...args: unknown[]) => boolean } } }).child.stdin;
  stdin.write = function (...args: unknown[]) { written.push(Buffer.byteLength(String(args[0]))); return originalWrite.apply(this, args); };
  await assert.rejects(client.callTool('echo', {}, client.revision, signal(), event => { if (event.phase === 'dispatch-intent') throw new Error('authored write-intent rejection'); }), errorCode('MCP_EXECUTION_RECORD_FAILED'));
  assert.equal(written.length, 0); stdin.write = originalWrite;
});

test('unconfirmed plain stdio cleanup rejects transport and client close with one retained cleanup outcome', async () => {
  const outcomes: { exitCode: number | null; cleanupConfirmed: boolean; started: boolean }[] = [];
  const transport = new StdioMcpTransport({ command: process.execPath, cwd: process.cwd(), observer: { beforeStart() {}, started() {}, closed(outcome) { outcomes.push(outcome); } } });
  let ended = 0, destroyed = 0;
  const signals: NodeJS.Signals[] = [];
  // This authored no-PID child never confirms exit; it does not reproduce an OS termination denial.
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdin: { end() { ended++; }, destroy() { destroyed++; } },
    stdout: { destroy() { destroyed++; } },
    stderr: { destroy() { destroyed++; } },
    kill(signal: NodeJS.Signals) { signals.push(signal); return false; },
  });
  (transport as unknown as { child: typeof child }).child = child;
  let firstError: unknown;
  const uncertain = (error: unknown) => { assert.ok(error instanceof EngineError); assert.equal(error.code, 'MCP_TRANSPORT_CLEANUP_UNCERTAIN'); assert.equal(error.details?.cleanupUncertain, true); assert.equal(error.details?.transportCleanupConfirmed, false); firstError ??= error; return true; };
  await assert.rejects(transport.close(), uncertain);
  await assert.rejects(transport.close(), error => { uncertain(error); assert.equal(error, firstError); return true; });
  const client = new McpClient({ id: 'stdio-cleanup-fixture', transport });
  await assert.rejects(client.close(), uncertain);
  assert.deepEqual(outcomes, [{ exitCode: null, cleanupConfirmed: false, started: false }]);
  assert.equal(ended, 1); assert.equal(destroyed, 3); assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.listenerCount('exit'), 0);
});

test('an overridden builtin send cannot retain physical no-send authority from its constructor', async t => {
  let receive!: (message: JsonRpcMessage) => void;
  class OverriddenTransport extends HttpMcpTransport {
    async start(callback: (message: JsonRpcMessage) => void) { receive = callback; }
    async send(message: JsonRpcMessage) {
      if (!('method' in message)) return;
      if (message.method === 'server/discover') receive({ jsonrpc: '2.0', id: message.id!, result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } } });
      else if (message.method === 'tools/list') receive({ jsonrpc: '2.0', id: message.id!, result: { tools: [{ name: 'fixture', inputSchema: { type: 'object' } }] } });
      else throw new EngineError('AUTHORED_OVERRIDE_REJECTION', 'custom implementation did not send');
    }
    async cancel() {} async close() {}
  }
  const client = await customClient(t, new OverriddenTransport({ url: endpoint })), trace = observe();
  await assert.rejects(client.callTool('fixture', {}, client.revision, signal(), trace.observer), errorCode('AUTHORED_OVERRIDE_REJECTION', true));
  const intent = trace.events.find(event => event.phase === 'dispatch-intent'); assert.ok(intent && intent.phase === 'dispatch-intent'); assert.equal(intent.boundary, 'legacy-api-entry');
});
