import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEFAULT_LIMITS } from '@moodcode/contracts';
import type { ApprovalPort, ToolContext, ToolDefinition } from '../../ports.js';
import { ScopedToolRuntime } from './index.js';
import { ToolPolicy } from '../../permission/policy.js';
import { DEFAULT_TOOL_DISCOVERY_POLICY, TOOL_DISCOVERY_LIMITS, validateToolDiscoveryPolicy } from './discovery.js';

const code = (expected: string) => (error: unknown) => { assert.equal((error as { code: string }).code, expected); return true; };
function tool(name: string, description = 'Search the local project', schema = { type: 'object' } as Record<string, unknown>): ToolDefinition & { prepares: number; executions: number } {
  const source = { name, description, inputSchema: schema as never, prepares: 0, executions: 0,
    async prepare(input: unknown) { source.prepares++; return { name, input: input as never, fingerprint: 'inner', requiresApproval: false, preview: { name } }; },
    async execute() { source.executions++; return { content: 'done' }; } };
  return source;
}
function context(): ToolContext { return { workspace: { id: 'w', root: '/workspace', gitRoot: '/workspace', branch: null, createdAt: new Date().toISOString() },
  sessionId: 's', runId: 'r', toolCallId: 'call', turnId: 'turn', attemptId: 'attempt', signal: new AbortController().signal,
  limits: { ...DEFAULT_LIMITS }, artifactDir: '/artifacts', recordCheckpoint() {} }; }
function observeClones(operation: (count: () => number) => void): void {
  const original = globalThis.structuredClone; let count = 0;
  globalThis.structuredClone = ((...args: Parameters<typeof structuredClone>) => { count++; return original(...args); }) as typeof structuredClone;
  try { operation(() => count); } finally { globalThis.structuredClone = original; }
}

test('discovery policy preserves omitted versus empty core selection and bounds explicit host limits', () => {
  assert.deepEqual(validateToolDiscoveryPolicy(), DEFAULT_TOOL_DISCOVERY_POLICY);
  const names = ['read_file'];
  const resolved = validateToolDiscoveryPolicy({ kind: 'bounded-tool-discovery', version: 1, alwaysVisibleToolNames: names, maxSelectedTools: 0, maxSchemaBytes: 1024 });
  names.push('run_command'); assert.deepEqual(resolved.alwaysVisibleToolNames, ['read_file']); assert.ok(Object.isFrozen(resolved.alwaysVisibleToolNames));
  assert.deepEqual(validateToolDiscoveryPolicy({ kind: 'bounded-tool-discovery', version: 1, alwaysVisibleToolNames: [] }).alwaysVisibleToolNames, []);
  for (const value of [{ kind: 'bounded-tool-discovery', version: 2 }, { kind: 'bounded-tool-discovery', version: 1, maxSelectedTools: 33 },
    { kind: 'bounded-tool-discovery', version: 1, maxSchemaBytes: TOOL_DISCOVERY_LIMITS.maxSchemaBytes + 1 },
    { kind: 'bounded-tool-discovery', version: 1, alwaysVisibleToolNames: ['*'] }, { kind: 'bounded-tool-discovery', version: 1, alwaysVisibleToolNames: ['a', 'a'] },
    { kind: 'bounded-tool-discovery', version: 1, unknown: true }]) assert.throws(() => validateToolDiscoveryPolicy(value), code('INVALID_TOOL_DISCOVERY_POLICY'));
});
test('policy proxy, accessors, hidden keys and sparse/custom arrays are rejected without executing them', () => {
  let traps = 0;
  const proxy = new Proxy({}, { get() { traps++; throw new Error(); }, ownKeys() { traps++; throw new Error(); }, getPrototypeOf() { traps++; throw new Error(); } });
  assert.throws(() => validateToolDiscoveryPolicy(proxy), code('INVALID_TOOL_DISCOVERY_POLICY'));
  const arrayProxy = new Proxy(['a'], { get() { traps++; throw new Error(); }, ownKeys() { traps++; throw new Error(); } });
  assert.throws(() => validateToolDiscoveryPolicy({ kind: 'bounded-tool-discovery', version: 1, alwaysVisibleToolNames: arrayProxy }), code('INVALID_TOOL_DISCOVERY_POLICY'));
  const getter = { kind: 'bounded-tool-discovery', version: 1, get maxSelectedTools() { traps++; return 8; } };
  assert.throws(() => validateToolDiscoveryPolicy(getter), code('INVALID_TOOL_DISCOVERY_POLICY'));
  const hidden = { kind: 'bounded-tool-discovery', version: 1 }; Object.defineProperty(hidden, 'extra', { value: 1 });
  assert.throws(() => validateToolDiscoveryPolicy(hidden), code('INVALID_TOOL_DISCOVERY_POLICY'));
  for (const names of [new Array(1), Object.assign(['a'], { toJSON() { traps++; return ['a']; } }), Object.assign(['a'], { extra: true })]) {
    assert.throws(() => validateToolDiscoveryPolicy({ kind: 'bounded-tool-discovery', version: 1, alwaysVisibleToolNames: names }), code('INVALID_TOOL_DISCOVERY_POLICY'));
  }
  assert.equal(traps, 0);
});
test('metadata discovery and deterministic literal search clone no schemas or execute handlers', () => {
  const runtime = new ScopedToolRuntime(), sources = [tool('read_file'), tool('project_search'), tool('search'), tool('alpha', 'Search project metadata')];
  for (const source of sources) runtime.register('engine', source, { effect: 'read' });
  observeClones(count => {
    const captured = runtime.discoveryCatalogue('engine');
    assert.equal(count(), 0); assert.ok(!JSON.stringify(captured).includes('inputSchema'));
    assert.deepEqual(runtime.searchDiscovery(captured, ' SEARCH ', 8).map(item => item.name), ['search', 'project_search', 'alpha', 'read_file']);
    assert.deepEqual(runtime.searchDiscovery(captured, '.*'), []);
    assert.equal(count(), 0); runtime.assertDiscoveryCurrent(captured);
    const result = runtime.searchDiscovery(captured, 'read'); result[0]!.description = 'mutated result';
    assert.equal(runtime.searchDiscovery(captured, 'read')[0]?.description, sources[0]?.description);
  });
  assert.ok(sources.every(source => source.prepares === 0 && source.executions === 0));
});
test('query UTF8, empty queries, control characters and result limits are validated', () => {
  const runtime = new ScopedToolRuntime(); runtime.register('engine', tool('read_file')); const captured = runtime.discoveryCatalogue('engine');
  assert.deepEqual(runtime.searchDiscovery(captured, '가'.repeat(85)), []);
  for (const query of ['', '   ', 'x\n', '가'.repeat(86)]) assert.throws(() => runtime.searchDiscovery(captured, query), code('INVALID_TOOL_DISCOVERY_QUERY'));
  for (const limit of [0, 9, NaN, 1.5]) assert.throws(() => runtime.searchDiscovery(captured, 'read', limit), code('INVALID_TOOL_DISCOVERY_QUERY'));
});
test('canonical schema hashes ignore key order while bytes equal actual UTF8 descriptor and tool array', () => {
  const runtime = new ScopedToolRuntime();
  runtime.register('one', tool('read_file', '한글😀', { type: 'object', properties: { path: { description: '값😀', type: 'string' } } }));
  runtime.register('two', tool('read_file', '한글😀', { properties: { path: { type: 'string', description: '값😀' } }, type: 'object' }));
  const first = runtime.discoveryCatalogue('one'), second = runtime.discoveryCatalogue('two');
  assert.equal(first.tools[0]?.schemaSha256, second.tools[0]?.schemaSha256); assert.equal(first.tools[0]?.definitionSha256, second.tools[0]?.definitionSha256);
  const metadata = first.tools[0]!, visible = runtime.materializeDiscovery(first, ['read_file'], { maxTools: 1, maxBytes: metadata.definitionBytes + 2 });
  assert.equal(Buffer.byteLength(JSON.stringify(visible.tools)), metadata.definitionBytes + 2);
  assert.equal(Buffer.byteLength(JSON.stringify(visible.tools[0]?.inputSchema)), metadata.schemaBytes);
  assert.match(metadata.definitionSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(metadata.schemaSha256, createHash('sha256').update(JSON.stringify({ type: 'array' })).digest('hex'));
});
test('source descriptor edits cannot change owned metadata or eager/materialized schemas', () => {
  const runtime = new ScopedToolRuntime(), source = tool('read_file', 'original', { type: 'object', properties: { path: { type: 'string' } } });
  runtime.register('engine', source);
  const captured = runtime.discoveryCatalogue('engine'), metadata = { ...captured.tools[0]! };
  source.description = 'changed'; source.inputSchema.type = 'array';
  assert.deepEqual(runtime.discoveryCatalogue('engine').tools[0], metadata);
  const visible = runtime.materializeDiscovery(captured, ['read_file'], { maxTools: 1, maxBytes: 65536 });
  assert.equal(visible.tools[0]?.description, 'original'); assert.equal(visible.tools[0]?.inputSchema.type, 'object');
  assert.equal(runtime.catalogue('engine').tools[0]?.inputSchema.type, 'object');
  visible.tools[0]!.inputSchema.type = 'array'; assert.throws(() => runtime.resolve(visible, 'read_file'), code('TOOL_CATALOGUE_STALE'));
});
test('JSON escaping preserves valid registered descriptions without an invented per-definition byte cap', () => {
  const runtime = new ScopedToolRuntime(); runtime.register('engine', tool('large', '\u0000'.repeat(8192), { type: 'object', description: 'x'.repeat(60000) }));
  const captured = runtime.discoveryCatalogue('engine'), metadata = captured.tools[0]!;
  assert.ok(metadata.definitionBytes > 80 * 1024);
  const visible = runtime.materializeDiscovery(captured, ['large'], { maxTools: 1, maxBytes: metadata.definitionBytes + 2 });
  assert.equal(Buffer.byteLength(JSON.stringify(visible.tools)), metadata.definitionBytes + 2);
});
test('count and exact array byte failures reject before schema cloning, including empty array overhead', () => {
  const runtime = new ScopedToolRuntime(); runtime.register('engine', tool('a', '😀'.repeat(40))); runtime.register('engine', tool('b'));
  const captured = runtime.discoveryCatalogue('engine'), arrayBytes = 3 + captured.tools.reduce((sum, item) => sum + item.definitionBytes, 0);
  observeClones(count => {
    assert.throws(() => runtime.materializeDiscovery(captured, ['a', 'b'], { maxTools: 1, maxBytes: arrayBytes }), code('TOOL_DISCOVERY_LIMIT'));
    assert.throws(() => runtime.materializeDiscovery(captured, ['a', 'b'], { maxTools: 2, maxBytes: arrayBytes - 1 }), code('TOOL_DISCOVERY_LIMIT'));
    assert.throws(() => runtime.materializeDiscovery(captured, [], { maxTools: 0, maxBytes: 1 }), code('TOOL_DISCOVERY_LIMIT'));
    assert.equal(count(), 0);
    const visible = runtime.materializeDiscovery(captured, ['a', 'b'], { maxTools: 2, maxBytes: arrayBytes });
    assert.equal(count(), 2); assert.equal(Buffer.byteLength(JSON.stringify(visible.tools)), arrayBytes);
    assert.deepEqual(runtime.materializeDiscovery(captured, [], { maxTools: 0, maxBytes: 2 }).tools, []);
  });
});
test('metadata cap rejects a composed candidate catalogue without copying large schemas', () => {
  const runtime = new ScopedToolRuntime();
  for (let index = 0; index < 64; index++) runtime.register('engine', tool('large_' + index, 'x'.repeat(8192), { type: 'object', description: 'x'.repeat(16000) }));
  observeClones(count => { assert.throws(() => runtime.discoveryCatalogue('engine'), code('TOOL_DISCOVERY_LIMIT')); assert.equal(count(), 0); });
  assert.equal(runtime.discoveryCatalogue('engine', 'build', ['large_0']).tools.length, 1);
});
test('host profile and configured deny omit candidate metadata and reject hidden resolution before prepare', () => {
  const runtime = new ScopedToolRuntime({ policy: new ToolPolicy([{ tool: 'secret_read', decision: 'deny' }]) });
  const allowed = tool('read_file'), hidden = tool('other_read'), denied = tool('secret_read');
  for (const source of [allowed, hidden, denied]) runtime.register('engine', source, { effect: 'read' });
  const names = ['read_file'], captured = runtime.discoveryCatalogue('engine', 'build', names); names.push('other_read');
  assert.deepEqual(captured.tools.map(item => item.name), ['read_file']); assert.ok(!JSON.stringify(captured).includes('secret_read'));
  assert.deepEqual(runtime.searchDiscovery(captured, 'other'), []);
  assert.throws(() => runtime.materializeDiscovery(captured, ['other_read'], { maxTools: 1, maxBytes: 65536 }), code('TOOL_NOT_FOUND'));
  const visible = runtime.materializeDiscovery(captured, ['read_file'], { maxTools: 1, maxBytes: 65536 });
  assert.throws(() => runtime.resolve(visible, 'other_read'), code('TOOL_NOT_FOUND')); assert.equal(hidden.prepares, 0); assert.equal(denied.prepares, 0);
  assert.deepEqual(runtime.discoveryCatalogue('engine', 'build', []).tools, []);
});
test('plan excludes write/unknown candidates and materialization preserves matching effect approval', async () => {
  const runtime = new ScopedToolRuntime(), read = tool('read_file'), write = tool('edit_file'), unknown = tool('unknown_tool');
  for (const source of [read, write, unknown]) runtime.register('engine', source);
  assert.deepEqual(runtime.discoveryCatalogue('engine', 'plan').tools.map(item => item.name), ['read_file']);
  const captured = runtime.discoveryCatalogue('engine'), visible = runtime.materializeDiscovery(captured, ['unknown_tool'], { maxTools: 1, maxBytes: 65536 }), ctx = context();
  const prepared = await runtime.resolve(visible, 'unknown_tool').prepare({}, ctx); assert.equal(prepared.requiresApproval, true);
  const approvals: ApprovalPort = { async request(input) { return { id: 'approval', ...input, fingerprint: 'wrong', status: 'allowed', createdAt: new Date().toISOString() }; }, decide() { throw new Error('unused'); }, cancelRun() {} };
  await assert.rejects(runtime.executeApproved(prepared, ctx, approvals), code('TOOL_APPROVAL_DENIED')); assert.equal(unknown.executions, 0);
});
test('discovery handles reject copied, mutated and accessor metadata without invoking observers', () => {
  const runtime = new ScopedToolRuntime(); runtime.register('engine', tool('read_file'));
  const captured = runtime.discoveryCatalogue('engine'); assert.throws(() => runtime.assertDiscoveryCurrent(structuredClone(captured)), code('TOOL_DISCOVERY_STALE'));
  captured.tools[0]!.schemaSha256 = '0'.repeat(64); assert.throws(() => runtime.searchDiscovery(captured, 'read'), code('TOOL_DISCOVERY_STALE'));
  let observed = 0; const other = runtime.discoveryCatalogue('engine'); Object.defineProperty(other.tools[0], 'name', { enumerable: true, get() { observed++; return 'read_file'; } });
  assert.throws(() => runtime.assertDiscoveryCurrent(other), code('TOOL_DISCOVERY_STALE')); assert.equal(observed, 0);
  const proxy = new Proxy(runtime.discoveryCatalogue('engine'), { get() { observed++; throw new Error(); } });
  assert.throws(() => runtime.assertDiscoveryCurrent(proxy), code('TOOL_DISCOVERY_STALE')); assert.equal(observed, 0);
});
test('registry, scope composition and policy changes invalidate captured discovery and selected execution', async () => {
  const policy = new ToolPolicy(), runtime = new ScopedToolRuntime({ policy }); runtime.register('engine', tool('read_file')); runtime.register('plugin', tool('external_read'), { effect: 'read' });
  const initial = runtime.discoveryCatalogue('engine'); runtime.setIncludedScopes('engine', ['plugin']); assert.throws(() => runtime.assertDiscoveryCurrent(initial), code('TOOL_DISCOVERY_STALE'));
  const captured = runtime.discoveryCatalogue('engine'), visible = runtime.materializeDiscovery(captured, ['external_read'], { maxTools: 1, maxBytes: 65536 });
  const delegated = runtime.resolve(visible, 'external_read'), prepared = await delegated.prepare({}, context());
  policy.replace([{ tool: 'external_read', decision: 'deny' }]); assert.throws(() => runtime.searchDiscovery(captured, 'external'), code('TOOL_DISCOVERY_STALE'));
  await assert.rejects(delegated.execute(prepared, context()), code('TOOL_CATALOGUE_STALE'));
  const latest = runtime.discoveryCatalogue('engine'); runtime.clearScope('plugin'); assert.throws(() => runtime.assertDiscoveryCurrent(latest), code('TOOL_DISCOVERY_STALE'));
});
test('materialization strict limits and name arrays cannot invoke caller conversion or clone schemas', () => {
  const runtime = new ScopedToolRuntime(); runtime.register('engine', tool('read_file')); const captured = runtime.discoveryCatalogue('engine'); let calls = 0;
  const selected = new Proxy(['read_file'], { get() { calls++; throw new Error(); } });
  observeClones(count => {
    assert.throws(() => runtime.materializeDiscovery(captured, selected, { maxTools: 1, maxBytes: 65536 }), code('TOOL_DISCOVERY_LIMIT'));
    assert.throws(() => runtime.materializeDiscovery(captured, ['read_file', 'read_file'], { maxTools: 2, maxBytes: 65536 }), code('TOOL_DISCOVERY_LIMIT'));
    assert.throws(() => runtime.materializeDiscovery(captured, ['read_file'], { maxTools: 1, get maxBytes() { calls++; return 65536; } }), code('TOOL_DISCOVERY_LIMIT'));
    assert.equal(count(), 0); assert.equal(calls, 0);
  });
});
