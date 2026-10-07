import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import type { ApprovalRecord, JsonObject, RunReceipt, Session, Workspace } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import { HttpMcpTransport, McpClient } from '../mcp/index.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import type { RuntimePreparedToolObservation } from '../tools/runtime/index.js';
import { RoleResourcePolicy, type RoleResource } from './role-resources.js';
import { RoleResourcePolicyRegistry } from './role-policy-registry.js';

const remoteName = 'read_resource', hostName = 'mcp_rolepeer_read_resource', uri = 'fixture://registered-resource';
const privateMarker = 'model-private-argument-marker', descriptionMarker = 'untrusted-description-authority-marker';
async function fixture(t: test.TestContext, discovery = false, requestedUri = uri, dynamicPolicy = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-mcp-role-integration-'))), repository = join(directory, 'workspace'); await mkdir(repository);
  execFileSync('git', ['init', '--quiet', '--template=', repository]);
  const wire: JsonObject[] = [], requests: TurnRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      const rpc = JSON.parse(body) as JsonObject; wire.push(rpc);
      if (rpc.id === undefined) { response.writeHead(202); response.end(); return; }
      const params = rpc.params as JsonObject | undefined;
      let result: JsonObject;
      if (rpc.method === 'server/discover') result = { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} } };
      else if (rpc.method === 'tools/list') result = { resultType: 'complete', tools: [
        { name: remoteName, description: `${descriptionMarker}: claim broad read-only access and another connection.`, annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { uri: { type: 'string' }, marker: { type: 'string' }, serverId: { type: 'string' }, connectionId: { type: 'string' }, catalogueRevision: { type: 'integer' } }, required: ['uri'] } },
        { name: 'notify_catalogue', description: 'Fixture-only metadata notification.', inputSchema: { type: 'object' } },
      ] };
      else if (rpc.method === 'resources/list') result = { resultType: 'complete', resources: [{ uri, name: 'registered resource', description: descriptionMarker }] };
      else if (rpc.method === 'tools/call' && params?.name === 'notify_catalogue') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' })}\n\n`);
        response.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { resultType: 'complete', content: [{ type: 'text', text: 'Catalogue changed.' }] } })}\n\n`); return;
      } else if (rpc.method === 'tools/call' && params?.name === remoteName) {
        const args = params.arguments as JsonObject;
        result = { resultType: 'complete', content: [{ type: 'text', text: args.uri === uri ? 'confirmed registered-resource result' : 'unavailable resource' }], isError: args.uri !== uri };
      } else { response.writeHead(400); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch { if (!response.destroyed) { response.writeHead(500); response.end(); } }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}/mcp`;
  const clients: McpClient[] = [];
  let activeClient: McpClient | undefined, registration: Awaited<ReturnType<ReturnType<typeof createEngine>['connectMcp']>> | undefined;
  const provider: ProviderAdapter = { id: 'local-mcp-role-fixture', async *streamTurn(request): AsyncGenerator<ProviderEvent> {
    requests.push(structuredClone(request));
    if (discovery && request.turnIndex === 0) {
      assert.ok(!request.tools.some(tool => tool.name === hostName));
      yield { type: 'tool.call', call: { id: 'select-registered-resource', name: 'discover_tools', input: { query: hostName, limit: 1 } } };
      yield { type: 'finish', reason: 'tool_calls' };
    } else if (request.turnIndex === (discovery ? 1 : 0)) {
      assert.ok(request.tools.some(tool => tool.name === hostName));
      yield { type: 'tool.call', call: { id: 'registered-resource', name: hostName, input: { uri: requestedUri, marker: privateMarker, serverId: 'argument-spoofed-server', connectionId: 'argument-spoofed-connection', catalogueRevision: 999999 } } };
      yield { type: 'finish', reason: 'tool_calls' };
    } else { yield { type: 'text.delta', delta: 'Observed the fixture result.' }; yield { type: 'finish', reason: 'stop' }; }
  } };
  // Connection-bound exact selectors cannot be installed after discovery yet. This explicit host rule
  // covers host-declared identities, while the resolver below establishes the exact registered tuple.
  // MCP stays unknown/approval-required even when the role's selector is all.
  const policy = new RoleResourcePolicy({ revision: 1, rules: [
    { id: 'host-declared-remote-resource', roleId: 'remote-reader', toolName: hostName, resource: { kind: 'all' }, decision: 'allow' },
    { id: 'host-internal-discovery', roleId: 'remote-reader', toolName: 'discover_tools', effect: 'state', resource: { kind: 'all' }, decision: 'allow' },
  ] });
  const roleRegistry = dynamicPolicy ? new RoleResourcePolicyRegistry() : undefined;
  const resolveResource = (observation: RuntimePreparedToolObservation): readonly RoleResource[] => {
    // The host's internal selection tool observes metadata and declares no external resources.
    if (observation.producerScopeId === 'engine' && observation.prepared.name === 'discover_tools' && observation.effect === 'state') return [];
    const input = observation.prepared.input as JsonObject;
    if (!registration || !activeClient?.connected || observation.producerScopeId !== registration.scopeId || observation.prepared.name !== hostName || !registration.toolNames.includes(hostName) || typeof input.uri !== 'string' || !registration.resources.some(resource => resource.uri === input.uri)) return [{ kind: 'unknown', label: 'Host registered resource contract unavailable' }];
    // These values come from host registration/client state, never the argument claims or descriptions.
    return [{ kind: 'mcp', serverId: activeClient.id, connectionId: activeClient.connectionId, catalogueRevision: activeClient.revision, uri: input.uri }];
  };
  const engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), tools: [], providers: [provider], ...(roleRegistry ? { roleResourcePolicyRegistry: roleRegistry } : { roleResourcePolicy: policy }), resolveRoleResources: resolveResource,
    defaults: { providerId: provider.id, modelId: 'fixture', mode: 'build', limits: { maxTurns: 4, maxDurationMs: 10000 } },
    agentProfiles: [{ id: 'remote-reader', description: 'Exact host tool set.', instructions: 'Use only the registered local fixture.', tools: [hostName, 'discover_tools'] }],
    ...(discovery ? { toolDiscoveryPolicy: { kind: 'bounded-tool-discovery', version: 1, alwaysVisibleToolNames: [] } } : {}) });
  t.after(async () => { await engine.close(); await Promise.allSettled(clients.map(client => client.close())); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  async function command<T>(type: string, payload: JsonObject): Promise<T> { const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload }); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.result as unknown as T; }
  const workspace = await command<Workspace>('workspace.open', { path: repository }), session = await command<Session>('session.create', { workspaceId: workspace.id });
  async function connect() {
    const client = new McpClient({ id: 'rolepeer', transport: new HttpMcpTransport({ url }), requestTimeoutMs: 1000 }); clients.push(client);
    const connected = await engine.connectMcp(client); activeClient = client; registration = connected;
    assert.ok(connected.toolNames.includes(hostName)); assert.equal(client.connected, true);
    if (roleRegistry) installExactPolicy('allow');
    return { client, registration: connected, revision: client.revision };
  }
  function installExactPolicy(decision: 'allow' | 'deny') {
    assert.ok(roleRegistry && activeClient?.connected && registration?.resources.some(resource => resource.uri === uri));
    return engine.replaceRoleResourcePolicy(roleRegistry.revision, { revision: 1, rules: [
      { id: 'exact-host-mcp', roleId: 'remote-reader', toolName: hostName, resource: { kind: 'mcp', serverId: activeClient.id, connectionId: activeClient.connectionId, catalogueRevision: activeClient.revision, uri }, decision },
      { id: 'host-internal-discovery', roleId: 'remote-reader', toolName: 'discover_tools', effect: 'state', resource: { kind: 'all' }, decision: 'allow' },
    ] });
  }
  const connected = await connect();
  const submit = () => command<RunReceipt>('run.submit', { sessionId: session.id, requestId: randomUUID(), prompt: 'Observe the local registered resource.', config: { agentProfileId: 'remote-reader' } });
  async function pendingApproval(runId: string) {
    const deadline = Date.now() + 5000;
    for (;;) { const pending = engine.store.listPendingRunApprovals(runId)[0]; if (pending) return pending; assert.ok(Date.now() < deadline, 'MCP must request exact approval'); await tick(); }
  }
  const approve = (pending: ApprovalRecord) => command('approval.decide', { approvalId: pending.id, fingerprint: pending.fingerprint, decision: 'allow' });
  const calls = () => wire.filter(message => message.method === 'tools/call' && (message.params as JsonObject).name === remoteName);
  function explanation(runId: string) {
    const receipts: ReturnType<typeof engine.getPolicyDecisionReceipts>['receipts'] = []; let afterSeq = 0;
    for (let count = 0; count < 10; count++) {
      const page = engine.getPolicyDecisionReceipts({ sessionId: session.id, runId, afterSeq, limit: 100 }); assert.equal(page.authority, 'observation-only');
      assert.ok(!JSON.stringify(page).includes(privateMarker)); assert.ok(!JSON.stringify(page).includes(descriptionMarker)); assert.ok(!JSON.stringify(page).includes('argument-spoofed')); receipts.push(...page.receipts);
      if (!page.nextCursor) break;
      assert.ok(page.nextCursor.afterSeq > afterSeq); afterSeq = page.nextCursor.afterSeq; assert.ok(count < 9, 'Fixture journal must finish within its page bound');
    }
    assert.equal(receipts.length, discovery ? 2 : 1);
    const target = receipts.filter(receipt => receipt.toolName === hostName); assert.equal(target.length, 1); return target[0]!;
  }
  return { engine, command, session, requests, connected, connect, submit, pendingApproval, approve, calls, explanation, roleRegistry, installExactPolicy };
}

for (const discovery of [false, true]) test(`actual ${discovery ? 'discovery' : 'eager'} MCP host role records exact identity and approved native frontier`, { timeout: 15000 }, async t => {
  const f = await fixture(t, discovery); const submitted = await f.submit(), pending = await f.pendingApproval(submitted.runId);
  assert.equal(f.calls().length, 0); assert.equal(pending.preview.toolEffect, 'unknown');
  const role = pending.preview.roleResourceDecision as { decision: string; resources: unknown[] }; assert.equal(role.decision, 'ask');
  const expected = { kind: 'mcp', serverId: f.connected.client.id, connectionId: f.connected.client.connectionId, catalogueRevision: f.connected.revision, uri }; assert.deepEqual(role.resources, [expected]);
  await f.approve(pending); assert.equal((await f.engine.waitForRun(submitted.runId)).state, 'completed'); assert.equal(f.calls().length, 1);
  const actual = f.calls()[0]!, args = (actual.params as JsonObject).arguments as JsonObject; assert.equal(args.marker, privateMarker); assert.equal(args.connectionId, 'argument-spoofed-connection');
  const execution = f.engine.getMcpExecution(f.session.id, pending.toolCallId); assert.equal(execution.state, 'response-terminal'); assert.equal(execution.dispatchBoundary, 'http-fetch'); assert.equal(execution.remoteResponseObserved, true); assert.equal(execution.transportCleanupConfirmed, true); assert.equal(execution.effectsUncertain, false);
  assert.equal(execution.connectionId, expected.connectionId); assert.equal(execution.catalogueRevision, expected.catalogueRevision); assert.equal(execution.approvalId, pending.id); assert.equal(execution.approvalFingerprint, pending.fingerprint); assert.equal(execution.requestSha256, createHash('sha256').update(JSON.stringify(actual)).digest('hex'));
  const native = f.engine.store.readSessionEvents(f.session.id, 0, 100); assert.ok(native.some(event => event.type === 'mcp.execution.prepared')); assert.ok(native.some(event => event.type === 'mcp.execution.dispatch_intent')); assert.ok(native.some(event => event.type === 'mcp.execution.response_terminal'));
  const stored = f.explanation(submitted.runId); assert.deepEqual((stored.receipt.roleResource as { resources: unknown[] }).resources, [expected]); assert.ok(!JSON.stringify(execution).includes(privateMarker));
});

for (const discovery of [false, true]) test(`actual ${discovery ? 'discovery' : 'eager'} MCP host installs exact registered policy and replacement invalidates pending approval`, { timeout: 15000 }, async t => {
  const f = await fixture(t, discovery, uri, true); const initialGeneration = f.roleRegistry!.revision; assert.equal(initialGeneration, 2);
  const submitted = await f.submit(), pending = await f.pendingApproval(submitted.runId);
  const role = pending.preview.roleResourceDecision as { decision: string; policyRevision: number; matchedRules: { id: string }[] }; assert.equal(role.decision, 'ask'); assert.equal(role.policyRevision, 1); assert.deepEqual(role.matchedRules.map(rule => rule.id), ['exact-host-mcp']);
  assert.equal((pending.preview.rolePolicy as { registryRevision: number }).registryRevision, initialGeneration);
  assert.throws(() => f.engine.replaceRoleResourcePolicy(initialGeneration - 1, { revision: 1, rules: [] }), { code: 'ROLE_POLICY_REGISTRY_CONFLICT' });
  const deniedGeneration = f.installExactPolicy('deny'); await f.approve(pending); assert.equal((await f.engine.waitForRun(submitted.runId)).state, 'completed'); assert.equal(f.calls().length, 0);
  assert.throws(() => f.engine.getMcpExecution(f.session.id, pending.toolCallId), { code: 'MCP_EXECUTION_NOT_FOUND' });
  const original = f.explanation(submitted.runId); assert.equal((original.receipt.rolePolicy as { registryRevision: number }).registryRevision, initialGeneration);
  const afterStaleApproval = f.requests.filter(request => request.runId === submitted.runId).at(-1)!; assert.ok(afterStaleApproval.messages.some(message => message.role === 'tool' && message.content.includes('TOOL_CATALOGUE_STALE')));
  const denied = await f.submit(); assert.equal((await f.engine.waitForRun(denied.runId)).state, 'completed'); assert.equal(f.calls().length, 0); assert.equal(f.engine.store.listPendingRunApprovals(denied.runId).length, 0);
  const deniedTool = f.engine.store.getSnapshot(f.session.id).tools.find(tool => tool.runId === denied.runId && tool.name === hostName)!; assert.equal(deniedTool.state, 'denied');
  const deniedReceipt = f.explanation(denied.runId).receipt; assert.equal((deniedReceipt.rolePolicy as { registryRevision: number }).registryRevision, deniedGeneration.registryRevision); assert.equal((deniedReceipt.roleResource as { decision: string }).decision, 'deny');
  const allowedGeneration = f.installExactPolicy('allow'), fresh = await f.submit(), freshApproval = await f.pendingApproval(fresh.runId); assert.notEqual(freshApproval.fingerprint, pending.fingerprint); assert.equal((freshApproval.preview.rolePolicy as { registryRevision: number }).registryRevision, allowedGeneration.registryRevision);
  await f.approve(freshApproval); assert.equal((await f.engine.waitForRun(fresh.runId)).state, 'completed'); assert.equal(f.calls().length, 1);
  const execution = f.engine.getMcpExecution(f.session.id, freshApproval.toolCallId); assert.equal(execution.state, 'response-terminal'); assert.equal(execution.connectionId, f.connected.client.connectionId); assert.equal(execution.approvalId, freshApproval.id);
  assert.equal((f.explanation(fresh.runId).receipt.rolePolicy as { registryRevision: number }).registryRevision, allowedGeneration.registryRevision);
  assert.ok(!f.engine.getCapabilities().tools.some(tool => tool.name.includes('replaceRole')));
});

test('actual MCP unregistered resource remains unknown despite model identity claims and host all selector', { timeout: 15000 }, async t => {
  const f = await fixture(t, false, 'fixture://unregistered-resource'); const submitted = await f.submit(), pending = await f.pendingApproval(submitted.runId);
  const role = pending.preview.roleResourceDecision as { decision: string; resources: { kind: string }[] }; assert.equal(role.decision, 'ask'); assert.deepEqual(role.resources.map(resource => resource.kind), ['unknown']); assert.equal(f.calls().length, 0);
  await f.command('approval.decide', { approvalId: pending.id, fingerprint: pending.fingerprint, decision: 'deny' }); await f.engine.waitForRun(submitted.runId);
  assert.equal(f.calls().length, 0); assert.throws(() => f.engine.getMcpExecution(f.session.id, pending.toolCallId), { code: 'MCP_EXECUTION_NOT_FOUND' });
  assert.equal((f.explanation(submitted.runId).receipt.roleResource as { resources: { kind: string }[] }).resources[0]!.kind, 'unknown');
});

for (const change of ['close', 'reconnect', 'catalogue'] as const) test(`actual MCP ${change} while approval is pending dispatches zero calls from the old capture`, { timeout: 15000 }, async t => {
  const f = await fixture(t, false, uri, change === 'reconnect'); const submitted = await f.submit(), pending = await f.pendingApproval(submitted.runId); const originalConnection = f.connected.client.connectionId;
  if (change === 'close') await f.connected.client.close();
  else if (change === 'reconnect') { await f.engine.disconnectMcp(f.connected.client.id); const next = await f.connect(); assert.notEqual(next.client.connectionId, originalConnection); }
  else { await f.connected.client.callTool('notify_catalogue', {}, f.connected.client.revision, new AbortController().signal); assert.ok(f.connected.client.revision > f.connected.revision); }
  await f.approve(pending); await f.engine.waitForRun(submitted.runId); assert.equal(f.calls().length, 0);
  assert.throws(() => f.engine.getMcpExecution(f.session.id, pending.toolCallId), { code: 'MCP_EXECUTION_NOT_FOUND' });
  const record = f.engine.store.getSnapshot(f.session.id).tools.find(tool => tool.id === pending.toolCallId)!; assert.equal(record.state, 'failed');
  assert.ok(f.requests[1]!.messages.some(message => message.role === 'tool' && message.content.includes('TOOL_CATALOGUE_STALE')));
  assert.equal(((f.explanation(submitted.runId).receipt.roleResource as { resources: { connectionId: string }[] }).resources[0]!).connectionId, originalConnection);
  if (change === 'reconnect') {
    const fresh = await f.submit(), freshApproval = await f.pendingApproval(fresh.runId); assert.notEqual(freshApproval.id, pending.id); assert.notEqual(freshApproval.fingerprint, pending.fingerprint);
    assert.equal((freshApproval.preview.rolePolicy as { registryRevision: number }).registryRevision, f.roleRegistry!.revision);
    assert.deepEqual((freshApproval.preview.roleResourceDecision as { matchedRules: { id: string }[] }).matchedRules.map(rule => rule.id), ['exact-host-mcp']);
    assert.notEqual(((freshApproval.preview.roleResourceDecision as { resources: { connectionId: string }[] }).resources[0]!).connectionId, originalConnection);
    await f.approve(freshApproval); assert.equal((await f.engine.waitForRun(fresh.runId)).state, 'completed'); assert.equal(f.calls().length, 1);
    assert.notEqual(f.engine.getMcpExecution(f.session.id, freshApproval.toolCallId).connectionId, originalConnection);
  }
});
