import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError, type JsonObject } from '@moodcode/contracts';
import type { ApprovalPort, ToolContext, ToolDefinition } from '../ports.js';
import { ScopedToolRuntime } from '../tools/runtime/index.js';
import { ToolPolicy } from '../permission/policy.js';
import { validateToolDiscoveryPolicy, type ToolDiscoveryPolicy } from '../tools/runtime/discovery.js';
import { createToolDiscoveryTool, DISCOVERY_TOOL_NAME, RunToolDiscovery, type ToolDiscoveryAction } from './tool-discovery.js';

// Independent authored local helper observations. These tests do not imply that
// the coordinator runs internal-state discovery calls concurrently.
const A = 'alpha_read', B = 'beta_read', C = 'gamma_read', CORE = 'core_read';
const code = (name: string) => (value: unknown) => value instanceof EngineError && value.code === name;
function context(id = 'discovery-one'): ToolContext {
  return { workspace: { id: 'selection-workspace', root: '/private/no-effects', gitRoot: '/private/no-effects', branch: null, createdAt: '2026-10-07T00:00:00Z' }, sessionId: 'selection-session', runId: 'selection-run', turnId: 'selection-turn', attemptId: 'selection-attempt', toolCallId: id, signal: new AbortController().signal, limits: { ...DEFAULT_LIMITS }, artifactDir: '/private/no-artifacts', recordCheckpoint() {} };
}
function fixture(options: { policy?: Partial<ToolDiscoveryPolicy>; permission?: ToolPolicy; allowed?: string[]; betaUnknown?: boolean; byteGap?: boolean; bytePairGap?: boolean } = {}) {
  const calls = { alpha: 0, beta: 0, gamma: 0, stage: 0 };
  const runtime = new ScopedToolRuntime({ policy: options.permission });
  function source(name: string, key?: 'alpha' | 'beta' | 'gamma'): ToolDefinition {
    const schema: JsonObject = { type: 'object', properties: { path: { type: 'string', description: name === B ? '정확한 경계🙂'.repeat(60) : 'local' } } };
    return { name, description: `Observe ${name} metadata`, inputSchema: schema, effectClass: name === B && options.betaUnknown ? 'unknown' : 'read',
      async prepare(input) { return { name, input: input as JsonObject, fingerprint: `private:${name}:${JSON.stringify(input)}`, requiresApproval: false, preview: { operation: name } }; },
      async execute() { if (key) calls[key]++; return { content: `observed:${name}` }; } };
  }
  runtime.register('engine', source(CORE));
  runtime.register('engine', source(A, 'alpha')); runtime.register('engine', source(B, 'beta')); runtime.register('engine', source(C, 'gamma'));
  let run!: RunToolDiscovery;
  const tool = createToolDiscoveryTool({ identity() { return run.identity(); }, stage(ctx, query, limit, expected, action) { calls.stage++; return run.stage(ctx.toolCallId, query, limit, expected, action); } });
  runtime.register('engine', tool);
  let maxSchemaBytes = options.policy?.maxSchemaBytes;
  if (options.byteGap || options.bytePairGap) {
    const metadata = runtime.discoveryCatalogue('engine').tools.filter(entry => [CORE, B, DISCOVERY_TOOL_NAME].includes(entry.name));
    maxSchemaBytes = 2 + metadata.reduce((sum, entry) => sum + entry.definitionBytes, 0) + metadata.length - 1 - (options.byteGap ? 1 : 0);
  }
  const policy = validateToolDiscoveryPolicy({ kind: 'bounded-tool-discovery', version: 1, maxSelectedTools: 1, ...options.policy, ...(maxSchemaBytes === undefined ? {} : { maxSchemaBytes }) });
  run = new RunToolDiscovery(runtime, policy, [CORE], 'build', options.allowed);
  const initial = run.capture();
  return { runtime, run, tool, calls, policy, initial };
}
const visible = (run: RunToolDiscovery) => run.capture().catalogue.tools.map(entry => entry.name);
function stage(run: RunToolDiscovery, id: string, query: string, action?: ToolDiscoveryAction) { return run.stage(id, query, 1, run.identity(), action); }
function selectA(run: RunToolDiscovery) { stage(run, 'initial-alpha', A); run.commit('initial-alpha'); return run.capture(); }
function noClones(operation: () => void) {
  const original = globalThis.structuredClone; let count = 0;
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => { count++; return original(value, options); }) as typeof structuredClone;
  try { operation(); assert.equal(count, 0); } finally { globalThis.structuredClone = original; }
}
const approvals = (status: 'allowed' | 'denied'): ApprovalPort => ({ async request(input) { return { ...input, id: `private-${status}`, status, createdAt: '2026-10-07T00:00:00Z' }; }, decide() { throw new Error('unused'); }, cancelRun() {} });

test('replace at capacity stages exact new noncore set and keeps the advertised current batch until a new capture', () => {
  const { run, runtime } = fixture(); const current = selectA(run);
  noClones(() => {
    const result = stage(run, 'replace-beta', B, 'replace');
    assert.equal(JSON.parse(result.content).selectionMode, 'replace');
    assert.deepEqual(JSON.parse(result.content).matches.map((entry: { name: string }) => entry.name), [B]);
    assert.strictEqual(run.capture(), current);
    assert.throws(() => runtime.resolve(current.catalogue, B), code('TOOL_NOT_FOUND'));
  });
  run.commit('replace-beta');
  assert.throws(() => runtime.resolve(current.catalogue, B), code('TOOL_NOT_FOUND'));
  const next = run.capture(); assert.deepEqual(visible(run), [CORE, B, DISCOVERY_TOOL_NAME]);
  assert.throws(() => runtime.resolve(next.catalogue, A), code('TOOL_NOT_FOUND'));
  assert.equal(next.reservedBytes, Buffer.byteLength(JSON.stringify({ messages: [], tools: next.catalogue.tools })) - 2);
  assert.equal(next.toolCatalogueSha256, createHash('sha256').update(JSON.stringify(next.catalogue.tools)).digest('hex'));
});

test('omitted/default add remains capacity bounded and explicit add does not silently replace', () => {
  const { run } = fixture(); const current = selectA(run);
  noClones(() => {
    assert.throws(() => stage(run, 'default-beta', B), code('TOOL_DISCOVERY_LIMIT'));
    assert.throws(() => stage(run, 'add-beta', B, 'add'), code('TOOL_DISCOVERY_LIMIT'));
    assert.equal(Object.hasOwn(JSON.parse(stage(run, 'add-alpha', A, 'add').content), 'selectionMode'), false);
  });
  run.commit('default-beta'); run.commit('add-beta'); run.discard('add-alpha');
  assert.strictEqual(run.capture(), current); assert.deepEqual(visible(run), [CORE, A, DISCOVERY_TOOL_NAME]);
});

test('no-match and core-only replacements clear selected tools while preserving configured always-visible definitions', () => {
  for (const query of ['missing_private_tool', CORE]) {
    const { run } = fixture(); selectA(run);
    stage(run, 'clear', query, 'replace'); run.commit('clear');
    assert.deepEqual(visible(run), [CORE, DISCOVERY_TOOL_NAME]);
  }
  const { run } = fixture({ policy: { alwaysVisibleToolNames: [CORE, A] } });
  stage(run, 'beta', B); run.commit('beta');
  stage(run, 'clear', 'missing_private_tool', 'replace'); run.commit('clear');
  assert.deepEqual(visible(run), [CORE, A, DISCOVERY_TOOL_NAME]);
});

test('discarded replacement never releases the old committed selection or its reservation', () => {
  const { run } = fixture(); const current = selectA(run);
  stage(run, 'discard-beta', B, 'replace'); run.discard('discard-beta'); run.commit('discard-beta');
  assert.strictEqual(run.capture(), current);
  stage(run, 'discard-clear', 'missing', 'replace'); run.discard('discard-clear'); run.commit('discard-clear');
  assert.deepEqual(visible(run), [CORE, A, DISCOVERY_TOOL_NAME]);
});

test('replacement UTF8 budget failure clones no schema and leaves the previously selected catalogue unchanged', () => {
  const { run } = fixture({ byteGap: true }); const current = selectA(run);
  noClones(() => assert.throws(() => stage(run, 'oversized-beta', B, 'replace'), code('TOOL_DISCOVERY_LIMIT')));
  run.commit('oversized-beta'); assert.strictEqual(run.capture(), current);
  assert.deepEqual(visible(run), [CORE, A, DISCOVERY_TOOL_NAME]);
});

test('replacement with too many permitted matches cannot publish a partial subset', () => {
  const { run } = fixture(); const current = selectA(run);
  noClones(() => assert.throws(() => run.stage('all', 'read', 8, run.identity(), 'replace'), code('TOOL_DISCOVERY_LIMIT')));
  run.commit('all'); assert.strictEqual(run.capture(), current);
});

test('pending clear cannot lend an uncommitted free slot to add, even when the clear is later discarded', () => {
  const { run } = fixture(); selectA(run);
  stage(run, 'clear', 'missing', 'replace');
  assert.throws(() => stage(run, 'beta', B, 'add'), code('TOOL_DISCOVERY_LIMIT'));
  run.discard('clear'); run.commit('beta');
  assert.deepEqual(visible(run), [CORE, A, DISCOVERY_TOOL_NAME]);
});

test('pending replace B also reserves against an add A that was already visible before replacement', () => {
  const { run } = fixture(); selectA(run);
  stage(run, 'replace-beta', B, 'replace');
  assert.throws(() => stage(run, 'add-alpha', A, 'add'), code('TOOL_DISCOVERY_LIMIT'));
  run.commit('replace-beta'); run.commit('add-alpha');
  assert.deepEqual(visible(run), [CORE, B, DISCOVERY_TOOL_NAME]);
});

test('pending add B prevents an incompatible replacement A instead of depending on completion order', () => {
  const { run } = fixture(); stage(run, 'add-beta', B, 'add');
  assert.throws(() => stage(run, 'replace-alpha', A, 'replace'), code('TOOL_DISCOVERY_LIMIT'));
  run.commit('replace-alpha'); run.commit('add-beta');
  assert.deepEqual(visible(run), [CORE, B, DISCOVERY_TOOL_NAME]);
});

for (const order of [['replace-beta', 'replace-gamma'], ['replace-gamma', 'replace-beta']] as const) test(`trusted pending replacements remain bounded in either commit order: ${order.join(' then ')}`, () => {
  const { run } = fixture(); selectA(run);
  stage(run, 'replace-beta', B, 'replace'); stage(run, 'replace-gamma', C, 'replace');
  run.commit(order[0]); assert.equal(visible(run).length, 3);
  run.commit(order[1]); assert.deepEqual(visible(run), [CORE, order[1] === 'replace-beta' ? B : C, DISCOVERY_TOOL_NAME]);
});

for (const order of [['replace-beta', 'add-gamma'], ['add-gamma', 'replace-beta']] as const) test(`compatible pending add/replace never exceed two slots in either commit order: ${order.join(' then ')}`, () => {
  const { run } = fixture({ policy: { maxSelectedTools: 2 } }); selectA(run);
  stage(run, 'replace-beta', B, 'replace'); stage(run, 'add-gamma', C, 'add');
  run.commit(order[0]); assert.ok(visible(run).length <= 4);
  run.commit(order[1]); assert.deepEqual(visible(run), order[1] === 'replace-beta' ? [CORE, B, DISCOVERY_TOOL_NAME] : [CORE, B, C, DISCOVERY_TOOL_NAME]);
});

for (const first of ['replace-beta', 'add-gamma'] as const) test(`pending reservation enforces aggregate UTF8 bytes even when each operation fits alone: ${first}`, () => {
  const { run } = fixture({ policy: { maxSelectedTools: 2 }, bytePairGap: true }); selectA(run);
  if (first === 'replace-beta') {
    stage(run, first, B, 'replace');
    noClones(() => assert.throws(() => stage(run, 'add-gamma', C, 'add'), code('TOOL_DISCOVERY_LIMIT')));
    run.commit('add-gamma'); run.commit(first);
    assert.deepEqual(visible(run), [CORE, B, DISCOVERY_TOOL_NAME]);
  } else {
    stage(run, first, C, 'add');
    noClones(() => assert.throws(() => stage(run, 'replace-beta', B, 'replace'), code('TOOL_DISCOVERY_LIMIT')));
    run.commit('replace-beta'); run.commit(first);
    assert.deepEqual(visible(run), [CORE, A, C, DISCOVERY_TOOL_NAME]);
  }
});

test('source/policy mutation discards a pending replacement and clears prior selections before fresh capture', () => {
  const permission = new ToolPolicy(); const { run, runtime } = fixture({ permission }); selectA(run);
  const old = run.capture(); stage(run, 'pending-beta', B, 'replace');
  permission.replace([{ tool: B, decision: 'deny' }]); run.commit('pending-beta');
  assert.deepEqual(visible(run), [CORE, DISCOVERY_TOOL_NAME]);
  assert.throws(() => runtime.resolve(old.catalogue, A), code('TOOL_CATALOGUE_STALE'));
  const result = stage(run, 'blocked-beta', B, 'replace'); assert.deepEqual(JSON.parse(result.content).matches, []);
  run.commit('blocked-beta'); assert.deepEqual(visible(run), [CORE, DISCOVERY_TOOL_NAME]);
});

test('profile-excluded replacement is an empty permitted set and never discloses forbidden metadata', () => {
  const { run } = fixture({ allowed: [CORE, A, DISCOVERY_TOOL_NAME] }); selectA(run);
  const result = stage(run, 'replace-beta', B, 'replace');
  assert.deepEqual(JSON.parse(result.content).matches, []);
  assert.equal(result.content.includes(`Observe ${B} metadata`), false);
  run.commit('replace-beta'); assert.deepEqual(visible(run), [CORE, DISCOVERY_TOOL_NAME]);
});

test('strict action input rejects getter, proxy, coercion, sparse/unknown fields and invalid explicit optional values without traps', async () => {
  const { tool, calls } = fixture(); let traps = 0;
  const proxy = new Proxy({}, { get() { traps++; throw new Error('trap'); }, ownKeys() { traps++; throw new Error('trap'); }, getPrototypeOf() { traps++; throw new Error('trap'); } });
  const getter = Object.defineProperty({ query: A }, 'action', { enumerable: true, get() { traps++; return 'replace'; } });
  const coercion = { toString() { traps++; return 'replace'; }, valueOf() { traps++; return 'replace'; } };
  const unknown = Object.defineProperty({ query: A }, 'unknown', { value: 'hidden' });
  const symbol = { query: A, [Symbol('hidden')]: 'extra' };
  for (const value of [proxy, getter, unknown, symbol, [], Object.create({ query: A }), { query: A, action: coercion }, { query: A, action: null }, { query: A, action: undefined }, { query: A, action: 'REPLACE' }, { query: A, action: 'release' }, { query: A, limit: undefined }, { query: A, limit: null }, { query: A, extra: true }]) await assert.rejects(tool.prepare(value, context()), code('INVALID_TOOL_DISCOVERY_QUERY'));
  assert.equal(traps, 0); assert.equal(calls.stage, 0);
});

test('explicit selection action is bound to prepared input, preview and semantic fingerprint', async () => {
  const { tool } = fixture();
  const add = await tool.prepare({ query: A, limit: 1, action: 'add' }, context());
  const replace = await tool.prepare({ query: A, limit: 1, action: 'replace' }, context());
  assert.notEqual(add.fingerprint, replace.fingerprint);
  assert.notDeepEqual(add.preview, replace.preview);
  assert.deepEqual(add.input, { query: A, limit: 1, action: 'add' });
  assert.deepEqual(replace.input, { query: A, limit: 1, action: 'replace' });
  const omitted = await tool.prepare({ query: A, limit: 1 }, context());
  assert.equal(Object.hasOwn(omitted.input as object, 'action'), false);
  assert.equal(Object.hasOwn(omitted.preview, 'action'), false);
});

test('action mutation, cancellation and copied handles stage nothing; an original handle is one-use and still needs commit', async () => {
  const { runtime, run, calls } = fixture(); const current = selectA(run);
  const tool = runtime.resolve(current.catalogue, DISCOVERY_TOOL_NAME);
  const tampered = await tool.prepare({ query: B, limit: 1, action: 'replace' }, context('tamper'));
  tampered.input = { query: B, limit: 1, action: 'add' };
  await assert.rejects(tool.execute(tampered, context('tamper')), code('TOOL_APPROVAL_STALE'));
  const copied = await tool.prepare({ query: B, limit: 1, action: 'replace' }, context('copied'));
  await assert.rejects(tool.execute(structuredClone(copied), context('copied')), code('INVALID_PREPARED_TOOL'));
  const cancelled = await tool.prepare({ query: B, limit: 1, action: 'replace' }, context('cancelled'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tool.execute(cancelled, { ...context('cancelled'), signal: controller.signal }), code('CANCELLED'));
  assert.equal(calls.stage, 0); assert.strictEqual(run.capture(), current);
  const ctx = context('successful');
  const successful = await tool.prepare({ query: B, limit: 1, action: 'replace' }, ctx);
  await tool.execute(successful, ctx); assert.equal(calls.stage, 1); assert.strictEqual(run.capture(), current);
  await assert.rejects(tool.execute(successful, ctx), code('INVALID_PREPARED_TOOL'));
  run.commit(ctx.toolCallId); assert.deepEqual(visible(run), [CORE, B, DISCOVERY_TOOL_NAME]);
});

test('failed add consumes the original factory handle and never turns into a replacement on replay', async () => {
  const { tool, run, calls } = fixture(); selectA(run); const ctx = context();
  const prepared = await tool.prepare({ query: B, limit: 1 }, ctx);
  await assert.rejects(tool.execute(prepared, ctx), code('TOOL_DISCOVERY_LIMIT'));
  await assert.rejects(tool.execute(prepared, ctx), code('INVALID_PREPARED_TOOL'));
  run.commit(ctx.toolCallId); assert.equal(calls.stage, 1); assert.deepEqual(visible(run), [CORE, A, DISCOVERY_TOOL_NAME]);
});

test('replacement never grants unknown-effect approval or changes logical repeated-read identity', async () => {
  const { runtime, run, calls } = fixture({ betaUnknown: true }); const before = selectA(run);
  const first = await runtime.resolve(before.catalogue, A).prepare({ path: 'same' }, context('first-read'));
  const repeatedIdentity = runtime.repeatIdentity(first);
  stage(run, 'replace-beta', B, 'replace'); run.commit('replace-beta'); const beta = run.capture();
  const betaPrepared = await runtime.resolve(beta.catalogue, B).prepare({}, context('unknown'));
  assert.equal(betaPrepared.requiresApproval, true);
  await assert.rejects(runtime.executeApproved(betaPrepared, context('unknown'), approvals('denied')), code('TOOL_APPROVAL_DENIED'));
  assert.equal(calls.beta, 0);
  stage(run, 'restore-alpha', A, 'replace'); run.commit('restore-alpha');
  const restored = await runtime.resolve(run.capture().catalogue, A).prepare({ path: 'same' }, context('second-read'));
  assert.equal(runtime.repeatIdentity(restored), repeatedIdentity);
  assert.notEqual(first.fingerprint, restored.fingerprint);
  assert.equal(calls.alpha, 0);
});
