import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIMITS } from '@moodcode/contracts';
import type { PreparedTool, ToolContext, ToolDefinition, ToolResult } from '../ports.js';
import { ScopedToolRuntime } from '../tools/runtime/index.js';
import { ToolPolicy } from '../permission/policy.js';
import { validateToolDiscoveryPolicy, type ToolDiscoveryPolicy } from '../tools/runtime/discovery.js';
import { DISCOVERY_TOOL_NAME, RunToolDiscovery, createToolDiscoveryTool } from './tool-discovery.js';

type Action = 'add' | 'replace';
const code = (expected: string) => (error: unknown) => { assert.equal((error as { code: string }).code, expected); return true; };
function context(toolCallId = 'selection-call'): ToolContext { return {
  workspace: { id: 'workspace', root: '/workspace', gitRoot: '/workspace', branch: null, createdAt: new Date().toISOString() },
  sessionId: 'session', runId: 'run', turnId: 'turn', attemptId: 'attempt', toolCallId,
  signal: new AbortController().signal, limits: { ...DEFAULT_LIMITS }, artifactDir: '/artifacts', recordCheckpoint() {},
}; }
function source(name: string, schemaBytes: number, calls: Map<string, number>): ToolDefinition { return {
  name, description: 'Local selection fixture', effectClass: 'read',
  inputSchema: { type: 'object', properties: { input: { type: 'string', description: 'x'.repeat(schemaBytes) } } },
  async prepare(input) { return { name, input: input as never, fingerprint: 'fixture', requiresApproval: false, preview: {} }; },
  async execute() { calls.set(name, (calls.get(name) ?? 0) + 1); return { content: name + ' local observation' }; },
}; }
function fixture(options: { policy?: Partial<ToolDiscoveryPolicy>; permission?: ToolPolicy; byteGap?: boolean } = {}) {
  const runtime = new ScopedToolRuntime({ policy: options.permission }), calls = new Map<string, number>(); let run!: RunToolDiscovery;
  runtime.register('engine', source('read_file', 0, calls)); runtime.register('engine', source('stable_extra', 0, calls));
  runtime.register('engine', source('choice_alpha', 64, calls)); runtime.register('engine', source('choice_beta', 8192, calls));
  runtime.register('engine', source('bundle_one', 16, calls)); runtime.register('engine', source('bundle_two', 16, calls));
  const tool = createToolDiscoveryTool({ identity() { return run.identity(); },
    stage(ctx, query, limit, expected, action?: Action) { return run.stage(ctx.toolCallId, query, limit, expected, action); } });
  runtime.register('engine', tool);
  let maxSchemaBytes = options.policy?.maxSchemaBytes;
  if (options.byteGap) {
    const metadata = runtime.discoveryCatalogue('engine').tools.filter(tool => ['read_file', DISCOVERY_TOOL_NAME, 'choice_beta'].includes(tool.name));
    maxSchemaBytes = 2 + metadata.reduce((total, tool) => total + tool.definitionBytes, 0) + metadata.length - 2;
  }
  const policy = validateToolDiscoveryPolicy({ kind: 'bounded-tool-discovery', version: 1, maxSelectedTools: 1,
    ...options.policy, ...(maxSchemaBytes === undefined ? {} : { maxSchemaBytes }) });
  run = new RunToolDiscovery(runtime, policy, ['read_file'], 'build');
  return { runtime, run, tool, calls };
}
const names = (run: RunToolDiscovery) => run.capture().catalogue.tools.map(tool => tool.name);
function selectA(run: RunToolDiscovery): void { run.capture(); run.stage('initial-a', 'choice_alpha', 1, run.identity()); run.commit('initial-a'); run.capture(); }
function noClones(operation: () => void): void {
  const original = globalThis.structuredClone; let count = 0;
  globalThis.structuredClone = ((...args: Parameters<typeof structuredClone>) => { count++; return original(...args); }) as typeof structuredClone;
  try { operation(); assert.equal(count, 0); } finally { globalThis.structuredClone = original; }
}
async function executeSelection(f: ReturnType<typeof fixture>, input: Record<string, unknown>, ctx = context()): Promise<ToolResult> {
  const handler = f.runtime.resolve(f.run.capture().catalogue, DISCOVERY_TOOL_NAME);
  return handler.execute(await handler.prepare(input, ctx), ctx);
}

test('explicit replace succeeds at cap1 but activates only after saved-result commit and next capture', async () => {
  const f = fixture(); selectA(f.run); const batch = f.run.capture(), ctx = context('replace-b');
  const result = await executeSelection(f, { query: 'choice_beta', limit: 1, action: 'replace' }, ctx);
  assert.equal(JSON.parse(result.content).selectionMode, 'replace'); assert.equal(JSON.parse(result.content).activation, 'next-model-boundary');
  assert.strictEqual(f.run.capture(), batch); assert.throws(() => f.runtime.resolve(batch.catalogue, 'choice_beta'), code('TOOL_NOT_FOUND'));
  f.run.commit(ctx.toolCallId); assert.throws(() => f.runtime.resolve(batch.catalogue, 'choice_beta'), code('TOOL_NOT_FOUND'));
  assert.equal(f.runtime.resolve(batch.catalogue, 'choice_alpha').name, 'choice_alpha');
  const next = f.run.capture(); assert.deepEqual(next.catalogue.tools.map(tool => tool.name), ['read_file', 'choice_beta', DISCOVERY_TOOL_NAME]);
  assert.throws(() => f.runtime.resolve(next.catalogue, 'choice_alpha'), code('TOOL_NOT_FOUND'));
  const bContext = context('selected-b-execution'), handler = f.runtime.resolve(next.catalogue, 'choice_beta');
  const observed = await handler.execute(await handler.prepare({}, bContext), bContext); assert.equal(observed.content, 'choice_beta local observation');
  assert.equal(f.calls.get('choice_beta'), 1); assert.equal(f.calls.get('choice_alpha') ?? 0, 0);
});
test('omitted action is add and preserves old capacity failure rather than silently replacing', async () => {
  const f = fixture(); selectA(f.run); const before = f.run.capture();
  await assert.rejects(executeSelection(f, { query: 'choice_beta', limit: 1 }), code('TOOL_DISCOVERY_LIMIT'));
  await assert.rejects(executeSelection(f, { query: 'choice_beta', limit: 1, action: 'add' }), code('TOOL_DISCOVERY_LIMIT'));
  f.run.commit('selection-call'); assert.strictEqual(f.run.capture(), before); assert.ok(names(f.run).includes('choice_alpha')); assert.ok(!names(f.run).includes('choice_beta'));
  assert.equal(f.calls.size, 0);
});
test('no-match replace clears noncore choice after commit and releases capacity for later default add', async () => {
  const f = fixture(); selectA(f.run); const previous = f.run.capture(), ctx = context('clear');
  const result = await executeSelection(f, { query: 'no_such_tool', action: 'replace' }, ctx);
  assert.deepEqual(JSON.parse(result.content).matches, []); assert.strictEqual(f.run.capture(), previous);
  f.run.commit(ctx.toolCallId); assert.deepEqual(names(f.run), ['read_file', DISCOVERY_TOOL_NAME]);
  const added = await executeSelection(f, { query: 'choice_beta', limit: 1 }, context('add-b'));
  assert.equal(JSON.parse(added.content).selectionMode, undefined); f.run.commit('add-b'); assert.ok(names(f.run).includes('choice_beta')); assert.ok(!names(f.run).includes('choice_alpha'));
});
test('replace preserves configured always-visible/core/discovery and core-only query clears only noncore', async () => {
  const f = fixture({ policy: { alwaysVisibleToolNames: ['read_file', 'stable_extra'] } }); selectA(f.run);
  await executeSelection(f, { query: 'choice_beta', action: 'replace', limit: 1 }, context('replace')); f.run.commit('replace');
  assert.deepEqual(names(f.run), ['read_file', 'stable_extra', 'choice_beta', DISCOVERY_TOOL_NAME]);
  const coreResult = await executeSelection(f, { query: 'read_file', action: 'replace', limit: 1 }, context('core'));
  assert.equal(JSON.parse(coreResult.content).matches[0].alreadyVisible, true); f.run.commit('core');
  assert.deepEqual(names(f.run), ['read_file', 'stable_extra', DISCOVERY_TOOL_NAME]);
});
test('replace selected count is computed on new matches rather than union with old choice, before clone', () => {
  const f = fixture(); selectA(f.run); const original = f.run.capture();
  noClones(() => f.run.stage('replace', 'choice_beta', 1, f.run.identity(), 'replace'));
  assert.strictEqual(f.run.capture(), original); f.run.commit('replace'); assert.deepEqual(names(f.run), ['read_file', 'choice_beta', DISCOVERY_TOOL_NAME]);
  const selected = f.run.capture();
  noClones(() => assert.throws(() => f.run.stage('too-many', 'bundle_', 2, f.run.identity(), 'replace'), code('TOOL_DISCOVERY_LIMIT')));
  f.run.commit('too-many'); assert.strictEqual(f.run.capture(), selected); assert.equal(f.calls.size, 0);
});
test('replace schema-byte failure rolls back selection and pending activation before any schema clone', () => {
  const f = fixture({ byteGap: true }); selectA(f.run); const selected = f.run.capture();
  noClones(() => assert.throws(() => f.run.stage('too-large', 'choice_beta', 1, f.run.identity(), 'replace'), code('TOOL_DISCOVERY_LIMIT')));
  f.run.commit('too-large'); assert.strictEqual(f.run.capture(), selected); assert.deepEqual(names(f.run), ['read_file', 'choice_alpha', DISCOVERY_TOOL_NAME]);
});
test('discarded successful replace and discarded no-match replace leave prior choice unchanged', () => {
  const f = fixture(); selectA(f.run); const selected = f.run.capture();
  f.run.stage('discard-b', 'choice_beta', 1, f.run.identity(), 'replace'); f.run.discard('discard-b'); f.run.commit('discard-b'); assert.strictEqual(f.run.capture(), selected);
  f.run.stage('discard-clear', 'no_such_tool', 1, f.run.identity(), 'replace'); f.run.discard('discard-clear'); f.run.commit('discard-clear'); assert.strictEqual(f.run.capture(), selected);
  assert.deepEqual(names(f.run), ['read_file', 'choice_alpha', DISCOVERY_TOOL_NAME]);
});
test('cancelled scoped replace cannot stage or change already selected choice', async () => {
  const f = fixture(); selectA(f.run); const selected = f.run.capture(), ctx = context('cancel');
  const handler = f.runtime.resolve(selected.catalogue, DISCOVERY_TOOL_NAME), prepared = await handler.prepare({ query: 'choice_beta', action: 'replace' }, ctx);
  const abort = new AbortController(); abort.abort(); await assert.rejects(handler.execute(prepared, { ...ctx, signal: abort.signal }), code('CANCELLED'));
  f.run.commit(ctx.toolCallId); assert.strictEqual(f.run.capture(), selected); assert.equal(f.calls.size, 0);
});
test('wrong prepared source identity rejects replace without changing the still-current selected choice', () => {
  const f = fixture(); selectA(f.run); const selected = f.run.capture(), identity = f.run.identity();
  noClones(() => assert.throws(() => f.run.stage('stale', 'choice_beta', 1, { ...identity, registryRevision: identity.registryRevision + 1 }, 'replace'), code('TOOL_DISCOVERY_STALE')));
  f.run.commit('stale'); assert.strictEqual(f.run.capture(), selected); assert.ok(names(f.run).includes('choice_alpha'));
});
test('source mutation clears prior source selections as G27 and never activates old staged replacement', () => {
  const f = fixture(); selectA(f.run); f.run.stage('old-b', 'choice_beta', 1, f.run.identity(), 'replace');
  f.runtime.register('plugin', source('new_registry_tool', 0, f.calls));
  f.run.commit('old-b'); assert.deepEqual(names(f.run), ['read_file', DISCOVERY_TOOL_NAME]);
  f.run.commit('old-b'); assert.deepEqual(names(f.run), ['read_file', DISCOVERY_TOOL_NAME]);
});
test('replace respects profile/deny narrowing and no permitted match cannot reveal or select denied choice', () => {
  const permission = new ToolPolicy([{ tool: 'choice_beta', decision: 'deny' }]), f = fixture({ permission }); selectA(f.run);
  const result = f.run.stage('denied', 'choice_beta', 1, f.run.identity(), 'replace');
  assert.deepEqual(JSON.parse(result.content).matches, []); f.run.commit('denied');
  assert.deepEqual(names(f.run), ['read_file', DISCOVERY_TOOL_NAME]);
  const narrow = new RunToolDiscovery(f.runtime, validateToolDiscoveryPolicy({ kind: 'bounded-tool-discovery', version: 1, maxSelectedTools: 1 }), ['read_file'], 'build', ['read_file', DISCOVERY_TOOL_NAME]);
  narrow.capture(); const observed = narrow.stage('narrow', 'choice_alpha', 1, narrow.identity(), 'replace');
  assert.deepEqual(JSON.parse(observed.content).matches, []); narrow.commit('narrow');
  assert.deepEqual(names(narrow), ['read_file', DISCOVERY_TOOL_NAME]);
});
test('explicit action is fingerprint-bound while omitted action preserves the previous prepared shape', async () => {
  const f = fixture(); f.run.capture(); const ctx = context();
  const omitted = await f.tool.prepare({ query: 'choice_beta', limit: 1 }, ctx);
  const add = await f.tool.prepare({ query: 'choice_beta', limit: 1, action: 'add' }, ctx);
  const replace = await f.tool.prepare({ query: 'choice_beta', limit: 1, action: 'replace' }, ctx);
  assert.notEqual(add.fingerprint, replace.fingerprint);
  assert.equal(Object.hasOwn(omitted.input as object, 'action'), false);
  assert.equal((add.input as { action: string }).action, 'add'); assert.equal(replace.preview.action, 'replace');
  const actionSchema = (f.tool.inputSchema.properties as { action: { enum: string[] } }).action; assert.deepEqual(actionSchema.enum, ['add', 'replace']);
});
test('replace handles remain one-use and changing an outer add request into replace stages nothing', async () => {
  const f = fixture(); selectA(f.run); const selected = f.run.capture(), ctx = context();
  const handler = f.runtime.resolve(selected.catalogue, DISCOVERY_TOOL_NAME), prepared = await handler.prepare({ query: 'choice_beta', action: 'replace' }, ctx);
  await assert.rejects(handler.execute(structuredClone(prepared), ctx), code('INVALID_PREPARED_TOOL')); assert.strictEqual(f.run.capture(), selected);
  await handler.execute(prepared, ctx); await assert.rejects(handler.execute(prepared, ctx), code('INVALID_PREPARED_TOOL'));
  f.run.discard(ctx.toolCallId); f.run.commit(ctx.toolCallId); assert.strictEqual(f.run.capture(), selected);
  const add: PreparedTool = await handler.prepare({ query: 'choice_beta', action: 'add' }, ctx); add.input = { query: 'choice_beta', limit: 4, action: 'replace' };
  await assert.rejects(handler.execute(add, ctx), code('TOOL_APPROVAL_STALE')); f.run.commit(ctx.toolCallId); assert.strictEqual(f.run.capture(), selected);
});
test('invalid action JSON values are rejected before staged mutation and preserve selection', async () => {
  const f = fixture(); selectA(f.run); const selected = f.run.capture();
  for (const action of ['', 'remove', 'REPLACE', undefined, null, 1, true, {}, []]) {
    await assert.rejects(f.tool.prepare({ query: 'choice_beta', action }, context()), code('INVALID_TOOL_DISCOVERY_QUERY'));
  }
  f.run.commit('selection-call'); assert.strictEqual(f.run.capture(), selected); assert.equal(f.calls.size, 0);
});
test('uncommitted no-match replacement cannot release old capacity for a pending add', () => {
  const f = fixture(); selectA(f.run); const selected = f.run.capture();
  noClones(() => {
    f.run.stage('not-saved-clear', 'no_such_tool', 1, f.run.identity(), 'replace');
    assert.throws(() => f.run.stage('premature-add', 'choice_beta', 1, f.run.identity(), 'add'), code('TOOL_DISCOVERY_LIMIT'));
  });
  f.run.discard('not-saved-clear'); f.run.commit('premature-add'); assert.strictEqual(f.run.capture(), selected);
  f.run.stage('saved-clear', 'no_such_tool', 1, f.run.identity(), 'replace'); f.run.commit('saved-clear'); f.run.capture();
  f.run.stage('permitted-add', 'choice_beta', 1, f.run.identity(), 'add'); f.run.commit('permitted-add');
  assert.deepEqual(names(f.run), ['read_file', 'choice_beta', DISCOVERY_TOOL_NAME]);
});
test('action parser rejects proxies, getter and hidden field without calling caller traps or mutating selection', async () => {
  const f = fixture(); selectA(f.run); const selected = f.run.capture(); let traps = 0;
  const proxy = new Proxy({ query: 'choice_beta', action: 'replace' }, { get() { traps++; throw new Error('unexpected get'); }, ownKeys() { traps++; throw new Error('unexpected keys'); }, getPrototypeOf() { traps++; throw new Error('unexpected prototype'); } });
  await assert.rejects(f.tool.prepare(proxy, context()), code('INVALID_TOOL_DISCOVERY_QUERY'));
  await assert.rejects(f.tool.prepare({ query: 'choice_beta', get action() { traps++; return 'replace'; } }, context()), code('INVALID_TOOL_DISCOVERY_QUERY'));
  const hidden = { query: 'choice_beta' }; Object.defineProperty(hidden, 'action', { value: 'replace' });
  await assert.rejects(f.tool.prepare(hidden, context()), code('INVALID_TOOL_DISCOVERY_QUERY'));
  assert.equal(traps, 0); f.run.commit('selection-call'); assert.strictEqual(f.run.capture(), selected); assert.equal(f.calls.size, 0);
});
