import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type JsonObject, type RunConfig } from '@moodcode/contracts';
import { normalizeEngineBudgets } from '@moodcode/contracts/validation';
import type { ContextRequest, PreparedTool, ProviderAdapter, ProviderEvent, ToolDefinition, TurnRequest } from '../ports.js';
import { ApprovalManager } from '../permission/index.js';
import { SqliteStore } from '../storage/index.js';
import { ScopedToolRuntime } from '../tools/runtime/index.js';
import { RunCoordinator } from './index.js';

// Real temporary Coordinator/native store with authored synthetic adapters.
// Producer counters represent no filesystem/network/command effects or external API.
const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stop: ProviderEvent = { type: 'finish', reason: 'stop' };
function readSource(name = 'private_read') {
  const prepared = new WeakSet<PreparedTool>(), calls = { prepare: 0, execute: 0 };
  const tool: ToolDefinition = { name, description: 'An authored static observation.', effectClass: 'read',
    inputSchema: { type: 'object', properties: { marker: { type: 'string', enum: ['original'] } } },
    async prepare(input) { calls.prepare++; const handle = { name, input: input as JsonObject, fingerprint: `${name}:${JSON.stringify(input)}`, requiresApproval: false, preview: { marker: 'original' } }; prepared.add(handle); return handle; },
    async execute(handle) { assert.equal(prepared.has(handle), true, 'The registered producer receives its exact original prepared handle.'); prepared.delete(handle); calls.execute++; return { content: 'An authored read result.' }; },
  };
  return { tool, calls };
}
async function fixture(t: TestContext, provider: ProviderAdapter, tools: ToolDefinition[], options: { runtime?: ScopedToolRuntime; allowed?: string[] } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-g129-compat-'))), store = new SqliteStore(':memory:');
  const workspace = store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: new Date().toISOString() });
  const session = store.createSession({ id: 'session', workspaceId: workspace.id, title: 'Authored eager compatibility', createdAt: new Date().toISOString() });
  const config: RunConfig = { providerId: provider.id, modelId: 'private-model', mode: 'build', limits: { ...DEFAULT_LIMITS, maxDurationMs: 5000, maxTurns: 4 }, budgets: normalizeEngineBudgets({ maxProviderAttempts: 3, retryBaseDelayMs: 0 }) };
  const builds: { reservedBytes: number; messageBytes: number }[] = []; let wholeReads = 0, allowlistReads = 0;
  store.getSnapshot = () => { wholeReads++; throw new Error('Whole snapshot is outside this authored bounded fixture.'); };
  const coordinator = new RunCoordinator({ store, providers: new Map([[provider.id, provider]]), tools, approvals: new ApprovalManager(store), artifactDir: directory,
    contextSnapshot: () => store.readModelHistory(session.id, 128, config.limits.maxContextBytes).snapshot,
    async buildContext(request: ContextRequest) {
      const messages = request.snapshot.messages.map(({ role, content, toolCalls, toolCallId }) => ({ role, content, ...(toolCalls ? { toolCalls: structuredClone(toolCalls) } : {}), ...(toolCallId ? { toolCallId } : {}) }));
      builds.push({ reservedBytes: request.reservedBytes ?? 0, messageBytes: Buffer.byteLength(JSON.stringify(messages)) }); return messages;
    },
    ...(options.runtime ? { toolRuntime: options.runtime } : {}),
    ...(options.allowed ? { getAllowedTools: () => { allowlistReads++; return options.allowed; } } : {}),
  });
  t.after(async () => { await coordinator.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, coordinator, config, builds, wholeReads: () => wholeReads, allowlistReads: () => allowlistReads,
    submit: () => coordinator.submit({ sessionId: session.id, requestId: 'private-request', prompt: 'Original private goal.', config: structuredClone(config) }) };
}

test('same-Turn HTTP retry receives the original eager tools and messages after an adapter mutates its own first-attempt request', async t => {
  const observation = readSource(), hostSchema = structuredClone(observation.tool.inputSchema), requests: TurnRequest[] = [];
  const provider: ProviderAdapter = { id: 'authored-retry', async *streamTurn(request): AsyncGenerator<ProviderEvent> {
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      request.tools[0]!.name = 'adapter_mutated_name'; request.tools[0]!.inputSchema.type = 'array'; request.messages[0]!.content = 'Adapter changed its received goal.';
      throw new EngineError('PROVIDER_HTTP_ERROR', 'Authored pre-output HTTP retry.', { status: 429, retryAfterMs: 0 });
    }
    yield stop;
  } };
  const f = await fixture(t, provider, [observation.tool]), receipt = f.submit(), run = await f.coordinator.waitForRun(receipt.runId);
  assert.equal(run.state, 'completed'); assert.equal(requests.length, 2); assert.equal(f.builds.length, 1);
  assert.deepEqual(observation.tool.inputSchema, hostSchema); assert.equal(observation.calls.execute, 0); assert.equal(f.wholeReads(), 0);
  const first = requests[0]!, second = requests[1]!;
  t.diagnostic(JSON.stringify({ observation: 'authored-same-turn-retry', providerRequests: requests.length, contextBuilds: f.builds.length,
    wholeSnapshotReads: f.wholeReads(), producerCalls: observation.calls.execute, hostSchemaSha256: sha(observation.tool.inputSchema),
    requests: requests.map(request => ({ turnId: request.turnId, attemptId: request.attemptId, toolsSha256: sha(request.tools), messagesSha256: sha(request.messages),
      requestSha256: sha(request), recordedRequestSha256: f.store.getAttemptCleanup(request.attemptId!, 'session').requestSha256,
      names: request.tools.map(tool => tool.name), schemaTypes: request.tools.map(tool => tool.inputSchema.type) })) }));
  assert.deepEqual(second.tools, first.tools, 'HTTP retry cannot reuse adapter-mutated tool descriptors instead of the original captured schemas.');
  assert.deepEqual(second.messages, first.messages, 'HTTP retry cannot reuse adapter-mutated history instead of the original request.');
  assert.notEqual(first.attemptId, second.attemptId); assert.equal(first.turnId, second.turnId);
  for (const request of requests) {
    const cleanup = f.store.getAttemptCleanup(request.attemptId!, 'session');
    assert.equal(cleanup.requestSha256, sha(request)); assert.equal(cleanup.requestBytes, Buffer.byteLength(JSON.stringify(request))); assert.equal(cleanup.state, 'confirmed');
  }
  const audit = f.store.readEvents('session', 0, 256).find(event => event.type === 'context.prepared')!;
  assert.equal(audit.payload.toolCatalogueSha256, sha(first.tools));
  assert.equal(audit.payload.reservedToolBytes, Buffer.byteLength(JSON.stringify({ messages: [], tools: first.tools })) - 2);
});

test('a runtime-free Coordinator keeps static allowlist, original prepared handles and read/state execution compatibility', async t => {
  const read = readSource(), state = readSource('private_state'), hidden = readSource('hidden_read'), requests: TurnRequest[] = [];
  state.tool.effectClass = 'state';
  const allowed = [read.tool.name, state.tool.name];
  const provider: ProviderAdapter = { id: 'authored-static', async *streamTurn(request): AsyncGenerator<ProviderEvent> {
    requests.push(structuredClone(request));
    if (!request.turnIndex) {
      yield { type: 'tool.call', call: { id: 'forced-hidden', name: hidden.tool.name, input: {} } };
      yield { type: 'tool.call', call: { id: 'read-original', name: read.tool.name, input: { marker: 'original' } } };
      yield { type: 'tool.call', call: { id: 'state-original', name: state.tool.name, input: { marker: 'original' } } };
      yield { type: 'finish', reason: 'tool_calls' };
    } else { yield { type: 'text.delta', delta: 'Completed static observations.' }; yield stop; }
  } };
  const f = await fixture(t, provider, [read.tool, state.tool, hidden.tool], { allowed }), receipt = f.submit(), run = await f.coordinator.waitForRun(receipt.runId);
  assert.equal(run.state, 'completed'); assert.equal(requests.length, 2); assert.equal(f.builds.length, 2); assert.equal(f.allowlistReads(), 1);
  assert.equal(read.calls.execute, 1); assert.equal(state.calls.execute, 1); assert.equal(hidden.calls.prepare, 0); assert.equal(hidden.calls.execute, 0);
  for (const request of requests) assert.deepEqual(request.tools.map(tool => tool.name), allowed);
  assert.ok(requests[1]!.messages.some(message => message.role === 'tool' && message.content.includes('TOOL_NOT_ALLOWED')));
  assert.equal(f.store.hasUncertainWorkspace('workspace'), false); assert.equal(f.wholeReads(), 0);
});

for (const runtimeEnabled of [false, true]) test(`${runtimeEnabled ? 'owned runtime' : 'runtime-free'} empty eager catalogue stays stable without rebuild churn`, async t => {
  const requests: TurnRequest[] = [], runtime = runtimeEnabled ? new ScopedToolRuntime() : undefined; let captures = 0;
  if (runtime) { const capture = runtime.catalogue.bind(runtime); runtime.catalogue = (...args) => { captures++; return capture(...args); }; }
  const provider: ProviderAdapter = { id: 'authored-empty', async *streamTurn(request): AsyncGenerator<ProviderEvent> { requests.push(structuredClone(request)); yield stop; } };
  const f = await fixture(t, provider, [], { runtime }), receipt = f.submit(), run = await f.coordinator.waitForRun(receipt.runId);
  assert.equal(run.state, 'completed'); assert.equal(requests.length, 1); assert.deepEqual(requests[0]!.tools, []);
  assert.equal(f.builds.length, 1); assert.equal(f.wholeReads(), 0); assert.equal(captures, runtimeEnabled ? 1 : 0);
  const expected = Buffer.byteLength(JSON.stringify({ messages: [], tools: [] })) - 2;
  assert.equal(f.builds[0]!.reservedBytes, expected);
  const audit = f.store.readEvents('session', 0, 256).find(event => event.type === 'context.prepared')!;
  assert.equal(audit.payload.reservedToolBytes, expected); assert.equal(audit.payload.toolCatalogueSha256, sha([])); assert.deepEqual(audit.payload.advertisedToolNames, []);
  assert.equal(f.store.listTurns(receipt.runId).length, 1); assert.equal(f.store.getAttempt(requests[0]!.attemptId!).state, 'completed'); assert.equal(f.store.hasUncertainWorkspace('workspace'), false);
});

for (const runtimeEnabled of [false, true]) test(`adapter mutation cannot alter ${runtimeEnabled ? 'runtime capture' : 'static host'} schemas, exact handler or next logical request`, async t => {
  const observation = readSource(), hostSchema = structuredClone(observation.tool.inputSchema), requests: TurnRequest[] = [];
  const runtime = runtimeEnabled ? new ScopedToolRuntime() : undefined; let captures = 0;
  if (runtime) {
    runtime.register('engine', observation.tool); const capture = runtime.catalogue.bind(runtime);
    runtime.catalogue = (...args) => { captures++; return capture(...args); };
  }
  const provider: ProviderAdapter = { id: 'authored-detached', async *streamTurn(request): AsyncGenerator<ProviderEvent> {
    requests.push(structuredClone(request));
    if (!request.turnIndex) {
      request.tools[0]!.name = 'adapter_only_name'; request.tools[0]!.inputSchema.type = 'array'; request.messages[0]!.content = 'Adapter-local replacement goal.';
      yield { type: 'tool.call', call: { id: 'original-handler', name: observation.tool.name, input: { marker: 'original' } } }; yield { type: 'finish', reason: 'tool_calls' };
    } else yield stop;
  } };
  const f = await fixture(t, provider, [observation.tool], { runtime }), receipt = f.submit(), run = await f.coordinator.waitForRun(receipt.runId);
  assert.equal(run.state, 'completed'); assert.equal(observation.calls.prepare, 1); assert.equal(observation.calls.execute, 1);
  assert.equal(requests.length, 2); assert.equal(f.builds.length, 2); assert.equal(captures, runtimeEnabled ? 1 : 0);
  assert.deepEqual(observation.tool.inputSchema, hostSchema); assert.deepEqual(requests[1]!.tools, requests[0]!.tools);
  assert.equal(requests[1]!.messages[0]!.content, 'Original private goal.'); assert.notEqual(requests[0]!.turnId, requests[1]!.turnId);
  const audits = f.store.readEvents('session', 0, 256).filter(event => event.type === 'context.prepared'); assert.equal(audits.length, 2);
  for (let index = 0; index < audits.length; index++) {
    const request = requests[index]!, audit = audits[index]!;
    assert.equal(audit.payload.toolCatalogueSha256, sha(request.tools)); assert.equal(audit.payload.reservedToolBytes, f.builds[index]!.reservedBytes);
    assert.equal(audit.payload.bytes, Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools })));
    const cleanup = f.store.getAttemptCleanup(request.attemptId!, 'session'); assert.equal(cleanup.requestSha256, sha(request)); assert.equal(cleanup.state, 'confirmed');
  }
  assert.equal(f.wholeReads(), 0); assert.equal(f.store.hasUncertainWorkspace('workspace'), false);
});
