import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError, type JsonObject } from '@moodcode/contracts';
import type { ApprovalPort, ToolContext, ToolDefinition, ToolEffectClass } from '../../ports.js';
import { ScopedToolRuntime } from './index.js';
import { ToolPolicy } from '../../permission/policy.js';
import { discoveryCatalogueSignature, TOOL_DISCOVERY_LIMITS, validateDiscoveryQuery, validateToolDiscoveryPolicy } from './discovery.js';

// Authored in-memory fixtures: registration, selection and exact approval only.
// No external transport, file effects, copied upstream tests or stored authority.
function error(code: string): (value: unknown) => boolean {
  return value => value instanceof EngineError && value.code === code;
}
function fixture(name: string, effect: ToolEffectClass = 'read', description = 'Searchable local observation', schema: JsonObject = { type: 'object', properties: { path: { type: 'string' } } }): { tool: ToolDefinition; calls: { prepare: number; execute: number } } {
  const calls = { prepare: 0, execute: 0 };
  const tool: ToolDefinition = {
    name, description, inputSchema: schema, effectClass: effect,
    async prepare(input) { calls.prepare++; return { name, input: input as JsonObject, fingerprint: `fixture:${JSON.stringify(input)}`, requiresApproval: false, preview: { operation: name } }; },
    async execute() { calls.execute++; return { content: `observed:${name}` }; },
  };
  return { tool, calls };
}
function context(id = 'call-one'): ToolContext {
  return { workspace: { id: 'workspace-review', root: '/authored/no-effects', gitRoot: '/authored/no-effects', branch: null, createdAt: '2026-10-07T00:00:00Z' }, sessionId: 'session-review', runId: 'run-review', toolCallId: id, turnId: 'turn-review', attemptId: 'attempt-review', signal: new AbortController().signal, limits: { ...DEFAULT_LIMITS }, artifactDir: '/authored/no-artifacts', recordCheckpoint() {} };
}
function approval(status: 'allowed' | 'denied'): ApprovalPort {
  return { async request(input) { return { ...input, id: `approval-${status}`, status, createdAt: '2026-10-07T00:00:00Z' }; }, decide() { throw new Error('unused'); }, cancelRun() {} };
}
function clones<T>(operation: () => T): { result: T; count: number } {
  const original = globalThis.structuredClone;
  let count = 0;
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => { count++; return original(value, options); }) as typeof structuredClone;
  try { return { result: operation(), count }; } finally { globalThis.structuredClone = original; }
}
function names(catalogue: { tools: readonly { name: string }[] }): string[] { return catalogue.tools.map(tool => tool.name); }
function exactBytes(catalogue: { tools: readonly { definitionBytes: number }[] }): number { return 2 + catalogue.tools.reduce((sum, entry) => sum + entry.definitionBytes, 0) + Math.max(0, catalogue.tools.length - 1); }

test('configured denial, plan mode and immutable profile narrow discovery before names or descriptions escape', () => {
  const policy = new ToolPolicy([{ tool: 'secret_remote', decision: 'deny' }]);
  const runtime = new ScopedToolRuntime({ policy });
  for (const [name, effect] of [['read_note', 'read'], ['state_note', 'state'], ['write_note', 'write'], ['secret_remote', 'unknown']] as const) runtime.register('engine', fixture(name, effect, `${name} private-description`).tool);
  const profile = ['read_note', 'secret_remote'];
  const restricted = runtime.discoveryCatalogue('engine', 'build', profile);
  profile.push('write_note');
  assert.deepEqual(names(restricted), ['read_note']);
  assert.deepEqual(runtime.searchDiscovery(restricted, 'secret'), []);
  assert.equal(JSON.stringify(restricted).includes('secret_remote'), false);
  assert.deepEqual(names(runtime.discoveryCatalogue('engine', 'plan')), ['read_note', 'state_note']);
  assert.deepEqual(names(runtime.discoveryCatalogue('engine', 'build', [])), []);
});

test('metadata and literal search clone no schema and contain only bounded public descriptor facts', () => {
  const runtime = new ScopedToolRuntime();
  const schema: JsonObject = { type: 'object', properties: { path: { type: 'string', description: '이미지'.repeat(1200) } } };
  runtime.register('engine', fixture('read_literal', 'read', 'literal [a-z]+ search', schema).tool);
  const observed = clones(() => {
    const catalogue = runtime.discoveryCatalogue('engine');
    const results = runtime.searchDiscovery(catalogue, '[a-z]+');
    return { catalogue, results };
  });
  assert.equal(observed.count, 0);
  const metadata = observed.result.results[0]!;
  assert.deepEqual(Object.keys(metadata).sort(), ['definitionBytes', 'definitionSha256', 'description', 'name', 'schemaBytes', 'schemaSha256']);
  assert.equal(metadata.schemaBytes, Buffer.byteLength(JSON.stringify(schema)));
  assert.match(metadata.schemaSha256, /^[a-f0-9]{64}$/);
  assert.match(metadata.definitionSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(observed.result.catalogue).includes('inputSchema'), false);
  const materialized = runtime.materializeDiscovery(observed.result.catalogue, ['read_literal'], { maxTools: 1, maxBytes: exactBytes(observed.result.catalogue) });
  assert.equal(Buffer.byteLength(JSON.stringify(materialized.tools)), exactBytes(observed.result.catalogue));
});

test('aggregate UTF8 bytes and count fail before cloning any selected or hidden schema', () => {
  const runtime = new ScopedToolRuntime();
  runtime.register('engine', fixture('first', 'read', '정확한 설명'.repeat(150)).tool);
  runtime.register('engine', fixture('second', 'read', '🙂'.repeat(300)).tool);
  runtime.register('engine', fixture('hidden', 'read', 'hidden schema', { type: 'object', description: 'large'.repeat(7000) }).tool);
  const catalogue = runtime.discoveryCatalogue('engine', 'build', ['first', 'second']);
  const bytes = exactBytes(catalogue);
  const failure = clones(() => {
    assert.throws(() => runtime.materializeDiscovery(catalogue, ['first', 'second'], { maxTools: 2, maxBytes: bytes - 1 }), error('TOOL_DISCOVERY_LIMIT'));
    assert.throws(() => runtime.materializeDiscovery(catalogue, ['first', 'second'], { maxTools: 1, maxBytes: bytes }), error('TOOL_DISCOVERY_LIMIT'));
  });
  assert.equal(failure.count, 0);
  const success = clones(() => runtime.materializeDiscovery(catalogue, ['first', 'second'], { maxTools: 2, maxBytes: bytes }));
  assert.equal(success.count, 2);
  assert.equal(Buffer.byteLength(JSON.stringify(success.result.tools)), bytes);
  assert.ok(JSON.stringify(success.result.tools).length < bytes);
});

test('zero materialization budgets do not turn into defaults and empty tools still cost two JSON bytes', () => {
  const runtime = new ScopedToolRuntime(); runtime.register('engine', fixture('only').tool);
  const catalogue = runtime.discoveryCatalogue('engine');
  const observed = clones(() => {
    assert.deepEqual(runtime.materializeDiscovery(catalogue, [], { maxTools: 0, maxBytes: 2 }).tools, []);
    for (const maxBytes of [0, 1]) assert.throws(() => runtime.materializeDiscovery(catalogue, [], { maxTools: 0, maxBytes }), error('TOOL_DISCOVERY_LIMIT'));
    assert.throws(() => runtime.materializeDiscovery(catalogue, ['only'], { maxTools: 0, maxBytes: 1000 }), error('TOOL_DISCOVERY_LIMIT'));
  });
  assert.equal(observed.count, 0);
});

test('large composed descriptions hit the shared metadata cap without schema copies; a narrow profile still fits', () => {
  const runtime = new ScopedToolRuntime();
  for (let index = 0; index < 65; index++) runtime.register('engine', fixture(`candidate_${index}`, 'read', 'x'.repeat(8192)).tool);
  const observed = clones(() => {
    assert.throws(() => runtime.discoveryCatalogue('engine'), error('TOOL_DISCOVERY_LIMIT'));
    const narrow = runtime.discoveryCatalogue('engine', 'build', ['candidate_64']);
    assert.deepEqual(names(narrow), ['candidate_64']);
    assert.ok(Buffer.byteLength(JSON.stringify(narrow)) < TOOL_DISCOVERY_LIMITS.maxMetadataBytes);
  });
  assert.equal(observed.count, 0);
});

test('candidate array hard bound is inspected before malformed metadata values are touched', () => {
  let touched = 0;
  const candidates = Array.from({ length: TOOL_DISCOVERY_LIMITS.maxCandidates + 1 }, () => ({ get name() { touched++; return 'never'; } }));
  assert.throws(() => discoveryCatalogueSignature({ scopeId: 'engine', revision: 1, policyVersion: 1, mode: 'build', tools: candidates }), error('TOOL_DISCOVERY_STALE'));
  assert.equal(touched, 0);
  // Legal tiny candidates reach the metadata cap before 4096 in actual catalogues.
  // This separate descriptor test proves the array cap, not a 4096-schema runtime claim.
});

test('query caps use UTF8 and never coerce values or run caller accessors', () => {
  assert.equal(validateDiscoveryQuery('🙂'.repeat(64), 8).query.length, 128);
  let touched = 0;
  const coercion = { toString() { touched++; return 'query'; } };
  for (const query of ['🙂'.repeat(65), '', '  ', 'line\nfeed', 'tab\tvalue', coercion]) assert.throws(() => validateDiscoveryQuery(query, 4), error('INVALID_TOOL_DISCOVERY_QUERY'));
  for (const limit of [0, 9, 1.5, Infinity, coercion]) assert.throws(() => validateDiscoveryQuery('query', limit), error('INVALID_TOOL_DISCOVERY_QUERY'));
  assert.equal(touched, 0);
});

test('policy validation detaches visible names and respects independent selected, visible and schema hard caps', () => {
  const list = ['read_note'];
  const normalized = validateToolDiscoveryPolicy({ kind: 'bounded-tool-discovery', version: 1, alwaysVisibleToolNames: list, maxSelectedTools: 0 });
  list.push('write_note');
  assert.deepEqual(normalized.alwaysVisibleToolNames, ['read_note']);
  assert.equal(normalized.maxSelectedTools, 0);
  assert.equal(normalized.maxSchemaBytes, 131072);
  for (const extra of [{ maxSelectedTools: 33 }, { maxSchemaBytes: 0 }, { maxSchemaBytes: 1048577 }, { alwaysVisibleToolNames: Array.from({ length: 257 }, (_, index) => `tool_${index}`) }]) assert.throws(() => validateToolDiscoveryPolicy({ kind: 'bounded-tool-discovery', version: 1, ...extra }), error('INVALID_TOOL_DISCOVERY_POLICY'));
  let traps = 0;
  const proxy = new Proxy({}, { get() { traps++; throw new Error('trap'); }, ownKeys() { traps++; throw new Error('trap'); } });
  assert.throws(() => validateToolDiscoveryPolicy(proxy), error('INVALID_TOOL_DISCOVERY_POLICY'));
  assert.equal(traps, 0);
});

test('metadata handles cannot be copied, edited or given getter fields to recover authority', () => {
  const runtime = new ScopedToolRuntime(); runtime.register('engine', fixture('only').tool);
  const original = runtime.discoveryCatalogue('engine');
  assert.throws(() => runtime.assertDiscoveryCurrent(structuredClone(original)), error('TOOL_DISCOVERY_STALE'));
  let traps = 0;
  const proxy = new Proxy(original, { get() { traps++; throw new Error('trap'); }, ownKeys() { traps++; throw new Error('trap'); } });
  assert.throws(() => runtime.assertDiscoveryCurrent(proxy), error('TOOL_DISCOVERY_STALE'));
  assert.equal(traps, 0);
  Object.defineProperty(original.tools[0]!, 'description', { enumerable: true, get() { traps++; return 'changed'; } });
  assert.throws(() => runtime.assertDiscoveryCurrent(original), error('TOOL_DISCOVERY_STALE'));
  assert.equal(traps, 0);
  const changed = runtime.discoveryCatalogue('engine'); changed.tools[0]!.schemaBytes++;
  assert.throws(() => runtime.materializeDiscovery(changed, ['only'], { maxTools: 1, maxBytes: 10000 }), error('TOOL_DISCOVERY_STALE'));
});

test('registered source and search-result mutation do not change captured schemas, descriptions or handlers', async () => {
  const runtime = new ScopedToolRuntime();
  const source = fixture('stable'); runtime.register('engine', source.tool);
  const catalogue = runtime.discoveryCatalogue('engine');
  const initial = structuredClone(catalogue.tools[0]);
  source.tool.description = 'changed source'; source.tool.inputSchema.extra = 'changed source';
  source.tool.execute = async () => { throw new Error('replacement must not run'); };
  const result = runtime.searchDiscovery(catalogue, 'stable')[0]!; result.description = 'changed result'; result.definitionBytes = 2;
  runtime.assertDiscoveryCurrent(catalogue);
  assert.deepEqual(catalogue.tools[0], initial);
  const selected = runtime.materializeDiscovery(catalogue, ['stable'], { maxTools: 1, maxBytes: exactBytes(catalogue) });
  assert.equal(selected.tools[0]!.inputSchema.extra, undefined);
  const delegated = runtime.resolve(selected, 'stable');
  const prepared = await delegated.prepare({ path: 'original' }, context());
  const outcome = await runtime.executeApproved(prepared, context(), approval('allowed'));
  assert.equal(outcome.content, 'observed:stable');
  assert.deepEqual(source.calls, { prepare: 1, execute: 1 });
});

test('policy revision, MCP scope disconnect and re-registration invalidate old handles and prepared calls', async () => {
  const runtime = new ScopedToolRuntime(); runtime.register('engine', fixture('local').tool);
  const remote = fixture('remote', 'unknown'); runtime.register('mcp_review', remote.tool);
  runtime.setIncludedScopes('engine', ['mcp_review']);
  const discovery = runtime.discoveryCatalogue('engine');
  const selected = runtime.materializeDiscovery(discovery, ['remote'], { maxTools: 1, maxBytes: 10000 });
  const prepared = await runtime.resolve(selected, 'remote').prepare({}, context());
  runtime.clearScope('mcp_review');
  assert.throws(() => runtime.searchDiscovery(discovery, 'remote'), error('TOOL_DISCOVERY_STALE'));
  await assert.rejects(runtime.executeApproved(prepared, context(), approval('allowed')), error('TOOL_CATALOGUE_STALE'));
  assert.equal(remote.calls.execute, 0);
  runtime.register('mcp_review', remote.tool);
  assert.throws(() => runtime.materializeDiscovery(discovery, ['remote'], { maxTools: 1, maxBytes: 10000 }), error('TOOL_DISCOVERY_STALE'));
  const current = runtime.discoveryCatalogue('engine');
  runtime.policy.replace([{ tool: 'remote', decision: 'deny' }]);
  assert.throws(() => runtime.assertDiscoveryCurrent(current), error('TOOL_DISCOVERY_STALE'));
  assert.deepEqual(names(runtime.discoveryCatalogue('engine')), ['local']);
});

test('selection exposes only selected handlers and an unknown tool still requires exact outer approval', async () => {
  const runtime = new ScopedToolRuntime(); const selected = fixture('selected', 'unknown'), hidden = fixture('hidden', 'unknown');
  runtime.register('engine', selected.tool); runtime.register('engine', hidden.tool);
  const discovery = runtime.discoveryCatalogue('engine');
  assert.deepEqual(runtime.searchDiscovery(discovery, 'hidden').map(item => item.name), ['hidden']);
  const catalogue = runtime.materializeDiscovery(discovery, ['selected'], { maxTools: 1, maxBytes: 10000 });
  assert.throws(() => runtime.resolve(catalogue, 'hidden'), error('TOOL_NOT_FOUND'));
  const handler = runtime.resolve(catalogue, 'selected');
  const denied = await handler.prepare({}, context('denied'));
  assert.equal(denied.requiresApproval, true);
  assert.notEqual(denied.fingerprint, 'fixture:{}');
  await assert.rejects(runtime.executeApproved(denied, context('denied'), approval('denied')), error('TOOL_APPROVAL_DENIED'));
  assert.equal(selected.calls.execute, 0);
  const permitted = await handler.prepare({}, context('allowed'));
  assert.equal((await runtime.executeApproved(permitted, context('allowed'), approval('allowed'))).content, 'observed:selected');
  await assert.rejects(runtime.executeApproved(permitted, context('allowed'), approval('allowed')), error('INVALID_PREPARED_TOOL'));
  assert.equal(selected.calls.execute, 1); assert.deepEqual(hidden.calls, { prepare: 0, execute: 0 });
});

test('materialized and prepared identities remain local, exact and single-use across fresh catalogues', async () => {
  const runtime = new ScopedToolRuntime(); const source = fixture('single', 'unknown'); runtime.register('engine', source.tool);
  const discovery = runtime.discoveryCatalogue('engine');
  const catalogue = runtime.materializeDiscovery(discovery, ['single'], { maxTools: 1, maxBytes: 10000 });
  assert.throws(() => runtime.resolve(structuredClone(catalogue), 'single'), error('TOOL_CATALOGUE_STALE'));
  const prepared = await runtime.resolve(catalogue, 'single').prepare({}, context('original'));
  await assert.rejects(runtime.executeApproved(prepared, context('different'), approval('allowed')), error('TOOL_APPROVAL_STALE'));
  assert.equal(source.calls.execute, 0);
  const otherRuntime = new ScopedToolRuntime(); otherRuntime.register('engine', source.tool);
  await assert.rejects(otherRuntime.executeApproved(prepared, context('original'), approval('allowed')), error('INVALID_PREPARED_TOOL'));
  const fresh = runtime.materializeDiscovery(discovery, ['single'], { maxTools: 1, maxBytes: 10000 });
  const freshPrepared = await runtime.resolve(fresh, 'single').prepare({}, context('fresh'));
  assert.notEqual(freshPrepared.fingerprint, prepared.fingerprint);
  assert.equal((await runtime.executeApproved(freshPrepared, context('fresh'), approval('allowed'))).content, 'observed:single');
});

test('resource-specific denial is enforced after selection when the actual prepared path becomes known', async () => {
  const runtime = new ScopedToolRuntime({ policy: new ToolPolicy([{ tool: 'read_note', resource: 'path:blocked/**', decision: 'deny' }]) });
  const source = fixture('read_note'); runtime.register('engine', source.tool);
  const discovery = runtime.discoveryCatalogue('engine'); assert.deepEqual(names(discovery), ['read_note']);
  const catalogue = runtime.materializeDiscovery(discovery, ['read_note'], { maxTools: 1, maxBytes: 10000 });
  const handler = runtime.resolve(catalogue, 'read_note');
  await assert.rejects(handler.prepare({ path: 'blocked/note' }, context()), error('TOOL_POLICY_DENIED'));
  assert.equal(source.calls.execute, 0);
  const prepared = await handler.prepare({ path: 'allowed/note' }, context());
  assert.equal((await runtime.executeApproved(prepared, context(), approval('allowed'))).content, 'observed:read_note');
});

test('invalid names and materialization options reject without caller getter or proxy execution', () => {
  const runtime = new ScopedToolRuntime(); runtime.register('engine', fixture('only').tool); const discovery = runtime.discoveryCatalogue('engine');
  let touched = 0;
  const supplied = Object.defineProperty({}, 'maxBytes', { enumerable: true, get() { touched++; return 1000; } });
  assert.throws(() => runtime.materializeDiscovery(discovery, ['only'], supplied as { maxTools: number; maxBytes: number }), error('TOOL_DISCOVERY_LIMIT'));
  const sparse = new Array<string>(1);
  const getter = Object.defineProperty(['only'], '0', { enumerable: true, get() { touched++; return 'only'; } });
  for (const value of [sparse, getter, ['only', 'only'], ['not allowed']]) assert.throws(() => runtime.materializeDiscovery(discovery, value, { maxTools: 2, maxBytes: 10000 }), error('TOOL_DISCOVERY_LIMIT'));
  assert.throws(() => runtime.materializeDiscovery(discovery, ['missing'], { maxTools: 2, maxBytes: 10000 }), error('TOOL_NOT_FOUND'));
  assert.equal(touched, 0);
});

test('canonical schema hashes survive property insertion order while exact wire sizes remain truthful', () => {
  const first = new ScopedToolRuntime(), second = new ScopedToolRuntime();
  first.register('engine', fixture('same', 'read', 'same', { type: 'object', properties: { b: { type: 'string' }, a: { type: 'number' } } }).tool);
  second.register('engine', fixture('same', 'read', 'same', { properties: { a: { type: 'number' }, b: { type: 'string' } }, type: 'object' }).tool);
  const one = first.discoveryCatalogue('engine'), two = second.discoveryCatalogue('engine');
  assert.equal(one.tools[0]!.schemaSha256, two.tools[0]!.schemaSha256);
  assert.equal(one.tools[0]!.definitionSha256, two.tools[0]!.definitionSha256);
  const materialized = first.materializeDiscovery(one, ['same'], { maxTools: 1, maxBytes: exactBytes(one) });
  const ordered = '{"properties":{"a":{"type":"number"},"b":{"type":"string"}},"type":"object"}';
  assert.equal(one.tools[0]!.schemaSha256, createHash('sha256').update(ordered).digest('hex'));
  assert.equal(one.tools[0]!.definitionBytes, Buffer.byteLength(JSON.stringify(materialized.tools[0])));
});

test('disconnect during asynchronous preparation rejects the accepted descriptor before any execution', async () => {
  const runtime = new ScopedToolRuntime(); const source = fixture('remote_read');
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { resume = resolve; });
  const original = source.tool.prepare;
  source.tool.prepare = async (...args) => { enter(); await held; return original(...args); };
  runtime.register('mcp_review', source.tool); runtime.setIncludedScopes('engine', ['mcp_review']);
  const discovery = runtime.discoveryCatalogue('engine');
  const selected = runtime.materializeDiscovery(discovery, ['remote_read'], { maxTools: 1, maxBytes: 10000 });
  const preparing = runtime.resolve(selected, 'remote_read').prepare({}, context());
  const rejected = assert.rejects(preparing, error('TOOL_CATALOGUE_STALE'));
  await entered; runtime.clearScope('mcp_review'); resume(); await rejected;
  assert.deepEqual(source.calls, { prepare: 1, execute: 0 });
});

test('disconnect during matching approval wait cannot grant an old selected handler execution authority', async () => {
  const runtime = new ScopedToolRuntime(); const source = fixture('remote_action', 'unknown');
  runtime.register('mcp_review', source.tool); runtime.setIncludedScopes('engine', ['mcp_review']);
  const discovery = runtime.discoveryCatalogue('engine');
  const selected = runtime.materializeDiscovery(discovery, ['remote_action'], { maxTools: 1, maxBytes: 10000 });
  const prepared = await runtime.resolve(selected, 'remote_action').prepare({}, context());
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { resume = resolve; });
  const heldApprovals: ApprovalPort = { ...approval('allowed'), async request(input) { enter(); await held; return { ...input, id: 'matching-old-approval', status: 'allowed', createdAt: '2026-10-07T00:00:00Z' }; } };
  const executing = runtime.executeApproved(prepared, context(), heldApprovals);
  const rejected = assert.rejects(executing, error('TOOL_CATALOGUE_STALE'));
  await entered; runtime.clearScope('mcp_review'); resume(); await rejected;
  assert.equal(source.calls.execute, 0);
  assert.throws(() => runtime.assertDiscoveryCurrent(discovery), error('TOOL_DISCOVERY_STALE'));
});
