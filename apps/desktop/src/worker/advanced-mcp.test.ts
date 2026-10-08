import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createEngine, ScriptedProvider, McpClient, HttpMcpTransport } from '@moodcode/engine';
import { EngineError, type JsonObject, type JsonValue, type Session, type Workspace } from '@moodcode/contracts';
import { AdvancedService, ADVANCED_LIMITS } from './advanced.js';
import { UtilityWorker } from './core.js';
import type { DesktopAdvancedPreview, DesktopAdvancedActionType } from '../shared/advanced.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until<T>(operation: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) { const value = await operation(); if (ready(value)) return value; await delay(10); }
  throw new Error('Native MCP fixture did not reach its expected state.');
}
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-advanced-mcp-'));
  execFileSync('git', ['init', '-q', directory]);
  const engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [new ScriptedProvider()] });
  const advanced = new AdvancedService(engine);
  let expectedCloseError: string | undefined;
  t.after(async () => { try { if (expectedCloseError) await assert.rejects(advanced.close(), code(expectedCloseError)); else await advanced.close(); } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); } });
  const command = async <T>(type: string, payload: JsonObject): Promise<T> => {
    const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.result as T;
  };
  const workspace = await command<Workspace>('workspace.open', { path: directory });
  const session = await command<Session>('session.create', { workspaceId: workspace.id });
  const action = <T = JsonValue>(type: DesktopAdvancedActionType, payload: JsonObject = {}, owner = 'window') => advanced.action(owner, { sessionId: session.id, type, payload }) as Promise<T>;
  return { directory, engine, advanced, session, action, expectCloseError(value: string) { expectedCloseError = value; } };
}

async function serverFixture(t: TestContext, holdInitialize = false) {
  const gate = deferred(), seventeenth = deferred();
  let held = holdInitialize, initializations = 0, resourcePages = 0;
  let resources: JsonObject[] = [];
  const respond = (response: ServerResponse, id: number, result: unknown) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string; params?: { cursor?: string } };
      if (message.id === undefined) { response.writeHead(204); response.end(); return; }
      if (message.method === 'initialize') {
        initializations++; if (initializations === ADVANCED_LIMITS.connections + 1) seventeenth.resolve();
        if (held) await gate.promise;
        respond(response, message.id, { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} } });
      } else if (message.method === 'tools/list') respond(response, message.id, { tools: [{ name: 'echo', description: 'Native test tool', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] });
      else if (message.method === 'resources/list') {
        resourcePages++; const page = Number(message.params?.cursor ?? 0), start = page * 32;
        respond(response, message.id, { resources: resources.slice(start, start + 32), ...(start + 32 < resources.length ? { nextCursor: String(page + 1) } : {}) });
      } else respond(response, message.id, {});
    })().catch(() => { response.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { gate.resolve(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}/mcp`, seventeenth: seventeenth.promise,
    get initializations() { return initializations; }, get resourcePages() { return resourcePages; },
    release() { held = false; gate.resolve(); }, setResources(value: JsonObject[]) { resources = value; } };
}
function catalogue(bytes: number): JsonObject[] {
  const resources = Array.from({ length: 256 }, (_, index) => ({ uri: `fixture://resource/${index}`, name: `resource${index}`, description: '' }));
  const padding = bytes - Buffer.byteLength(JSON.stringify(resources)), each = Math.floor(padding / resources.length);
  for (const resource of resources) resource.description = 'x'.repeat(each);
  resources[0]!.description += 'x'.repeat(padding % resources.length);
  assert.equal(Buffer.byteLength(JSON.stringify(resources)), bytes); return resources;
}

test('desktop MCP reservations bound concurrent native connections and reject a pending duplicate before dispatch', async t => {
  const f = await fixture(t), server = await serverFixture(t, true);
  const previews = await Promise.all(Array.from({ length: ADVANCED_LIMITS.connections + 1 }, (_, index) => f.action<DesktopAdvancedPreview>('mcp.preview', { id: `pending${index}`, transport: 'http', url: server.url, protocolVersion: '2025-11-25' })));
  const pending = previews.slice(0, ADVANCED_LIMITS.connections).map(preview => f.action('mcp.connect', { handleId: preview.handleId, approved: true }));
  try {
    await until(() => server.initializations, value => value === ADVANCED_LIMITS.connections);
    const overflow = f.action('mcp.connect', { handleId: previews.at(-1)!.handleId, approved: true });
    pending.push(overflow);
    const outcome = await Promise.race([overflow.then(() => 'accepted', error => error instanceof EngineError ? error.code : 'unknown'), server.seventeenth.then(() => 'native-overflow')]);
    assert.equal(outcome, 'DESKTOP_CONNECTION_LIMIT');
    const duplicate = await f.action<DesktopAdvancedPreview>('mcp.preview', { id: 'pending0', transport: 'http', url: server.url, protocolVersion: '2025-11-25' });
    await assert.rejects(f.action('mcp.connect', { handleId: duplicate.handleId, approved: true }), code('DESKTOP_CONNECTION_LIMIT'));
  } finally { server.release(); await Promise.allSettled(pending); }
  assert.equal(server.initializations, ADVANCED_LIMITS.connections);
  assert.equal(((await f.advanced.snapshot(f.session.id)).mcp as JsonValue[]).length, ADVANCED_LIMITS.connections);
});

for (const [label, bytes] of [['resource catalogue', ADVANCED_LIMITS.responseBytes + 4096], ['complete response envelope', ADVANCED_LIMITS.responseBytes - 32]] as const) {
  test(`oversized MCP ${label} rolls back native registration and permits exact-ID reconnect`, async t => {
    const f = await fixture(t), server = await serverFixture(t);
    server.setResources(catalogue(bytes));
    const preview = await f.action<DesktopAdvancedPreview>('mcp.preview', { id: 'oversized', transport: 'http', url: server.url, protocolVersion: '2025-11-25' });
    await assert.rejects(f.action('mcp.connect', { handleId: preview.handleId, approved: true }), code('DESKTOP_RESPONSE_LIMIT'));
    assert.equal(server.resourcePages, 8, 'all 256 native-valid resources must be discovered before desktop projection fails');
    assert.equal(((await f.advanced.snapshot(f.session.id)).mcp as JsonValue[]).length, 0);
    assert.ok(f.engine.getCapabilities().tools.every(tool => tool.name !== 'mcp_oversized_echo'));
    server.setResources([]);
    const retry = await f.action<DesktopAdvancedPreview>('mcp.preview', { id: 'oversized', transport: 'http', url: server.url, protocolVersion: '2025-11-25' });
    const connected = await f.action<JsonObject>('mcp.connect', { handleId: retry.handleId, approved: true });
    assert.equal(connected.connected, true);
    await f.action('mcp.disconnect', { id: 'oversized' });
  });
}

test('native duplicate connection failure never compensates by disconnecting an external registration', async t => {
  const f = await fixture(t), server = await serverFixture(t);
  await f.engine.connectMcp(new McpClient({ id: 'external', protocolVersion: '2025-11-25', transport: new HttpMcpTransport({ url: server.url, protocolVersion: '2025-11-25' }) }));
  const preview = await f.action<DesktopAdvancedPreview>('mcp.preview', { id: 'external', transport: 'http', url: server.url, protocolVersion: '2025-11-25' });
  await assert.rejects(f.action('mcp.connect', { handleId: preview.handleId, approved: true }), code('MCP_ALREADY_CONNECTED'));
  assert.ok(f.engine.getCapabilities().tools.some(tool => tool.name === 'mcp_external_echo'));
  assert.equal(server.initializations, 1);
  assert.equal(((await f.advanced.snapshot(f.session.id)).mcp as JsonValue[]).length, 0);
  await f.engine.disconnectMcp('external');
});

test('owner reload and service close abort pending native MCP connection and release its reservation', async t => {
  const f = await fixture(t), server = await serverFixture(t, true);
  const preview = await f.action<DesktopAdvancedPreview>('mcp.preview', { id: 'reload', transport: 'http', url: server.url, protocolVersion: '2025-11-25' });
  const pending = f.action('mcp.connect', { handleId: preview.handleId, approved: true });
  const rejected = assert.rejects(pending, code('MCP_CANCELLED'));
  await until(() => server.initializations, value => value === 1);
  await f.advanced.dropOwner('window'); await rejected;
  assert.equal(((await f.advanced.snapshot(f.session.id)).mcp as JsonValue[]).length, 0);
  server.release();
  const retry = await f.action<DesktopAdvancedPreview>('mcp.preview', { id: 'reload', transport: 'http', url: server.url, protocolVersion: '2025-11-25' }, 'reloaded');
  await f.action('mcp.connect', { handleId: retry.handleId, approved: true }, 'reloaded');
  await f.action('mcp.disconnect', { id: 'reload' }, 'reloaded');
  const held = await serverFixture(t, true);
  const closePreview = await f.action<DesktopAdvancedPreview>('mcp.preview', { id: 'closing', transport: 'http', url: held.url, protocolVersion: '2025-11-25' }, 'reloaded');
  const closing = f.action('mcp.connect', { handleId: closePreview.handleId, approved: true }, 'reloaded');
  const closingRejected = assert.rejects(closing, code('MCP_CANCELLED'));
  await until(() => held.initializations, value => value === 1);
  await f.advanced.close(); await closingRejected;
  assert.equal(((await f.advanced.snapshot(f.session.id)).mcp as JsonValue[]).length, 0);
});

test('unconfirmed MCP rollback retains its slot and retries only its original client after an external same-ID reconnect', async t => {
  const f = await fixture(t), server = await serverFixture(t);
  server.setResources(catalogue(ADVANCED_LIMITS.responseBytes + 4096));
  let originalClient: McpClient | undefined, localCloseCalls = 0, nativeDisconnectCalls = 0;
  const connect = f.engine.connectMcp.bind(f.engine), disconnect = f.engine.disconnectMcp.bind(f.engine);
  f.engine.connectMcp = async (client, signal) => {
    const registration = await connect(client, signal);
    if (client.id === 'uncertain' && !originalClient) {
      originalClient = client;
      const close = client.close.bind(client);
      client.close = async () => {
        localCloseCalls++; await close();
        if (localCloseCalls === 1) throw new EngineError('MCP_TRANSPORT_CLEANUP_UNCERTAIN', 'Controlled lost local cleanup confirmation.', { cleanupUncertain: true });
      };
    }
    return registration;
  };
  f.engine.disconnectMcp = async id => { nativeDisconnectCalls++; await disconnect(id); };
  const preview = await f.action<DesktopAdvancedPreview>('mcp.preview', { id: 'uncertain', transport: 'http', url: server.url, protocolVersion: '2025-11-25' });
  await assert.rejects(f.action('mcp.connect', { handleId: preview.handleId, approved: true }), error => {
    assert.ok(error instanceof EngineError); assert.equal(error.code, 'DESKTOP_MCP_CLEANUP_UNCERTAIN');
    assert.equal(error.details?.operationErrorCode, 'DESKTOP_RESPONSE_LIMIT');
    assert.deepEqual(error.details?.cleanupErrorCodes, ['MCP_TRANSPORT_CLEANUP_UNCERTAIN']); return true;
  });
  f.expectCloseError('DESKTOP_MCP_CLEANUP_UNCERTAIN');
  assert.equal(nativeDisconnectCalls, 1); assert.equal(localCloseCalls, 2);
  const view = (await f.advanced.snapshot(f.session.id)).mcp as JsonObject[];
  assert.equal(view.length, 1); assert.equal(view[0]!.state, 'cleanup-uncertain');
  assert.ok(f.engine.getCapabilities().tools.every(tool => tool.name !== 'mcp_uncertain_echo'));
  server.setResources([]);
  await f.engine.connectMcp(new McpClient({ id: 'uncertain', protocolVersion: '2025-11-25', transport: new HttpMcpTransport({ url: server.url, protocolVersion: '2025-11-25' }) }));
  const retry = await f.action<DesktopAdvancedPreview>('mcp.preview', { id: 'uncertain', transport: 'http', url: server.url, protocolVersion: '2025-11-25' });
  await assert.rejects(f.action('mcp.connect', { handleId: retry.handleId, approved: true }), code('DESKTOP_CONNECTION_LIMIT'));
  await assert.rejects(f.action('mcp.disconnect', { id: 'uncertain' }), code('DESKTOP_MCP_CLEANUP_UNCERTAIN'));
  assert.equal(nativeDisconnectCalls, 1); assert.equal(localCloseCalls, 3);
  assert.ok(f.engine.getCapabilities().tools.some(tool => tool.name === 'mcp_uncertain_echo'));
  const held = await serverFixture(t, true);
  const previews = await Promise.all(Array.from({ length: ADVANCED_LIMITS.connections }, (_, index) => f.action<DesktopAdvancedPreview>('mcp.preview', { id: `held${index}`, transport: 'http', url: held.url, protocolVersion: '2025-11-25' })));
  const pending = previews.slice(0, -1).map(value => f.action('mcp.connect', { handleId: value.handleId, approved: true }));
  const settled = Promise.allSettled(pending);
  await until(() => held.initializations, count => count === ADVANCED_LIMITS.connections - 1);
  await assert.rejects(f.action('mcp.connect', { handleId: previews.at(-1)!.handleId, approved: true }), code('DESKTOP_CONNECTION_LIMIT'));
  await assert.rejects(f.advanced.close(), code('DESKTOP_MCP_CLEANUP_UNCERTAIN'));
  assert.equal((await settled).filter(value => value.status === 'rejected' && code('MCP_CANCELLED')(value.reason)).length, ADVANCED_LIMITS.connections - 1);
  assert.equal(nativeDisconnectCalls, 1); assert.equal(localCloseCalls, 4);
  assert.ok(f.engine.getCapabilities().tools.some(tool => tool.name === 'mcp_uncertain_echo'));
  assert.equal(((await f.advanced.snapshot(f.session.id)).mcp as JsonObject[]).length, 1);
});

test('utility close aborts a tracked native MCP connection without deadlock and closes its actual engine', async t => {
  const f = await fixture(t), server = await serverFixture(t, true);
  const worker = new UtilityWorker({ emit() {}, createEngine: () => f.engine });
  const bootstrap = await worker.handle({ id: 'start', type: 'start', payload: { dbPath: join(f.directory, 'engine.sqlite'), artifactDir: join(f.directory, 'artifacts'), config: { providerId: 'scripted', modelId: 'echo', baseURL: '' } } });
  assert.equal(bootstrap.ok, true, JSON.stringify(bootstrap));
  const invoke = (type: DesktopAdvancedActionType, payload: JsonObject) => worker.handle({ id: randomUUID(), type: 'advanced', payload: { ownerId: 'window', input: { sessionId: f.session.id, type, payload } } });
  const response = await invoke('mcp.preview', { id: 'worker-close', transport: 'http', url: server.url, protocolVersion: '2025-11-25' });
  assert.equal(response.ok, true); const preview = (response as { result: DesktopAdvancedPreview }).result;
  const pending = invoke('mcp.connect', { handleId: preview.handleId, approved: true });
  await until(() => server.initializations, value => value === 1);
  await worker.close();
  const rejected = await pending;
  assert.equal(rejected.ok, false); assert.equal(!rejected.ok && rejected.error.code, 'MCP_CANCELLED');
  assert.throws(() => f.engine.integrityCheck(), code('ENGINE_CLOSED'));
});

test('service close joins an in-flight native disconnect and surfaces its later cleanup failure', async t => {
  const f = await fixture(t), server = await serverFixture(t);
  const started = deferred(), gate = deferred(); let localCloseCalls = 0;
  const connect = f.engine.connectMcp.bind(f.engine);
  f.engine.connectMcp = async (client, signal) => {
    const registration = await connect(client, signal), close = client.close.bind(client);
    client.close = async () => {
      localCloseCalls++; started.resolve(); await gate.promise; await close();
      if (localCloseCalls === 1) throw new EngineError('MCP_TRANSPORT_CLEANUP_UNCERTAIN', 'Controlled late cleanup failure.', { cleanupUncertain: true });
    };
    return registration;
  };
  const preview = await f.action<DesktopAdvancedPreview>('mcp.preview', { id: 'disconnecting', transport: 'http', url: server.url, protocolVersion: '2025-11-25' });
  await f.action('mcp.connect', { handleId: preview.handleId, approved: true });
  f.expectCloseError('DESKTOP_MCP_CLEANUP_UNCERTAIN');
  const disconnect = f.action('mcp.disconnect', { id: 'disconnecting' });
  const rejected = assert.rejects(disconnect, code('DESKTOP_MCP_CLEANUP_UNCERTAIN'));
  await started.promise;
  let closeSettled = false;
  const closing = f.advanced.close();
  const closeRejected = assert.rejects(closing, code('DESKTOP_MCP_CLEANUP_UNCERTAIN'));
  void closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
  try { await delay(10); assert.equal(closeSettled, false); }
  finally { gate.resolve(); }
  await rejected; await closeRejected;
  assert.equal(((await f.advanced.snapshot(f.session.id)).mcp as JsonObject[])[0]!.state, 'cleanup-uncertain');
});
