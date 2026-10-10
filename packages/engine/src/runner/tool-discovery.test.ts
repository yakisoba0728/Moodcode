import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEFAULT_LIMITS } from '@moodcode/contracts';
import type { ToolContext, ToolDefinition } from '../ports.js';
import { ScopedToolRuntime } from '../tools/runtime/index.js';
import { ToolPolicy } from '../permission/policy.js';
import { validateToolDiscoveryPolicy, type ToolDiscoveryPolicy } from '../tools/runtime/discovery.js';
import { DISCOVERY_TOOL_NAME, RunToolDiscovery, createToolDiscoveryTool } from './tool-discovery.js';

const code = (expected: string) => (error: unknown) => { assert.equal((error as { code: string }).code, expected); return true; };
const names = (run: RunToolDiscovery) => run.capture().catalogue.tools.map(tool => tool.name);
function context(toolCallId = 'discovery-call'): ToolContext { return {
  workspace: { id: 'workspace', root: '/workspace', gitRoot: '/workspace', branch: null, createdAt: new Date().toISOString() },
  sessionId: 'session', runId: 'run', turnId: 'turn', attemptId: 'attempt', toolCallId,
  signal: new AbortController().signal, limits: { ...DEFAULT_LIMITS }, artifactDir: '/artifacts', recordCheckpoint() {},
}; }
function source(name: string, description = 'Owned private fixture', schemaTextBytes = 8192): ToolDefinition { return {
  name, description, inputSchema: { type: 'object', properties: { payload: { type: 'string', description: 'x'.repeat(schemaTextBytes) } } }, effectClass: 'read',
  async prepare(input) { return { name, input: input as never, fingerprint: 'unused', requiresApproval: false, preview: {} }; },
  async execute() { throw new Error('No hidden producer may execute in these boundary fixtures'); },
}; }
function fixture(options: { policy?: Partial<ToolDiscoveryPolicy>; allowedNames?: string[]; mode?: 'plan' | 'build'; permission?: ToolPolicy; byteGap?: boolean } = {}) {
  const runtime = new ScopedToolRuntime({ policy: options.permission }); let run!: RunToolDiscovery; let stageCalls = 0;
  runtime.register('engine', source('read_file', 'Core fixture', 0));
  runtime.register('engine', source('private_alpha')); runtime.register('engine', source('private_beta'));
  const tool = createToolDiscoveryTool({ identity() { return run.identity(); }, stage(ctx, query, limit, expected) { stageCalls++; return run.stage(ctx.toolCallId, query, limit, expected); } });
  runtime.register('engine', tool);
  let maxSchemaBytes = options.policy?.maxSchemaBytes;
  if (options.byteGap) {
    const metadata = runtime.discoveryCatalogue('engine').tools.filter(tool => ['read_file', DISCOVERY_TOOL_NAME, 'private_alpha'].includes(tool.name));
    maxSchemaBytes = 2 + metadata.reduce((total, tool) => total + tool.definitionBytes, 0) + metadata.length - 1 - 1;
  }
  const policy = validateToolDiscoveryPolicy({ kind: 'bounded-tool-discovery', version: 1, ...options.policy, ...(maxSchemaBytes === undefined ? {} : { maxSchemaBytes }) });
  run = new RunToolDiscovery(runtime, policy, ['read_file'], options.mode ?? 'build', options.allowedNames);
  return { runtime, run, tool, policy, stageCalls: () => stageCalls };
}
function noClones(operation: () => void): void {
  const original = globalThis.structuredClone; let count = 0;
  globalThis.structuredClone = ((...args: Parameters<typeof structuredClone>) => { count++; return original(...args); }) as typeof structuredClone;
  try { operation(); assert.equal(count, 0); } finally { globalThis.structuredClone = original; }
}

test('Run capture retains core/discovery and exact reservation/hash through an unchanged boundary', () => {
  const { run } = fixture(); assert.throws(() => run.identity(), code('TOOL_DISCOVERY_STALE'));
  const initial = run.capture(); assert.deepEqual(initial.catalogue.tools.map(tool => tool.name), ['read_file', DISCOVERY_TOOL_NAME]);
  assert.equal(initial.reservedBytes, Buffer.byteLength(JSON.stringify({ messages: [], tools: initial.catalogue.tools })) - 2);
  assert.equal(initial.toolCatalogueSha256, createHash('sha256').update(JSON.stringify(initial.catalogue.tools)).digest('hex'));
  noClones(() => assert.strictEqual(run.capture(), initial));
});
test('staged result alone does not expose a handler; commit becomes visible only in a new capture', () => {
  const { runtime, run } = fixture(), initial = run.capture();
  const result = run.stage('call', 'private_alpha', 1, run.identity());
  assert.equal(JSON.parse(result.content).activation, 'next-model-boundary');
  assert.strictEqual(run.capture(), initial); assert.throws(() => runtime.resolve(initial.catalogue, 'private_alpha'), code('TOOL_NOT_FOUND'));
  run.commit('call');
  assert.throws(() => runtime.resolve(initial.catalogue, 'private_alpha'), code('TOOL_NOT_FOUND'));
  const next = run.capture(); assert.notStrictEqual(next, initial); assert.deepEqual(next.catalogue.tools.map(tool => tool.name), ['read_file', 'private_alpha', DISCOVERY_TOOL_NAME]);
  assert.equal(runtime.resolve(next.catalogue, 'private_alpha').name, 'private_alpha');
  const repeated = run.stage('another', 'private_alpha', 1, run.identity()); assert.equal(JSON.parse(repeated.content).matches[0].alreadyVisible, true);
});
test('discard leaves no activation and frees pending count reserved by another tool call', () => {
  const { run } = fixture({ policy: { maxSelectedTools: 1 } }); const initial = run.capture();
  noClones(() => {
    run.stage('a', 'private_alpha', 1, run.identity());
    assert.throws(() => run.stage('b', 'private_beta', 1, run.identity()), code('TOOL_DISCOVERY_LIMIT'));
    run.discard('a'); run.stage('b', 'private_beta', 1, run.identity());
    assert.strictEqual(run.capture(), initial);
  });
  run.commit('a'); assert.strictEqual(run.capture(), initial);
  run.commit('b'); assert.deepEqual(names(run), ['read_file', 'private_beta', DISCOVERY_TOOL_NAME]);
});
test('pending and committed selection union enforces count before clone without dropping existing selection', () => {
  const { run } = fixture({ policy: { maxSelectedTools: 1 } }); run.capture();
  run.stage('a', 'private_alpha', 1, run.identity()); run.commit('a'); const selected = run.capture();
  noClones(() => {
    assert.throws(() => run.stage('b', 'private_beta', 1, run.identity()), code('TOOL_DISCOVERY_LIMIT'));
    run.stage('same', 'private_alpha', 1, run.identity()); assert.strictEqual(run.capture(), selected);
  });
  run.discard('same'); run.commit('b'); assert.strictEqual(run.capture(), selected);
});
test('schema byte cap is checked on selection before clone and failed selection never activates', () => {
  const { run } = fixture({ byteGap: true }); const initial = run.capture();
  noClones(() => assert.throws(() => run.stage('too-large', 'private_alpha', 1, run.identity()), code('TOOL_DISCOVERY_LIMIT')));
  run.commit('too-large'); assert.strictEqual(run.capture(), initial); assert.deepEqual(names(run), ['read_file', DISCOVERY_TOOL_NAME]);
});
test('explicit zero selected policy retains core but rejects new selection before schema clone', () => {
  const { run } = fixture({ policy: { maxSelectedTools: 0 } }); run.capture();
  noClones(() => {
    assert.throws(() => run.stage('blocked', 'private_alpha', 1, run.identity()), code('TOOL_DISCOVERY_LIMIT'));
    const result = run.stage('core', 'read_file', 1, run.identity()); assert.equal(JSON.parse(result.content).matches[0].alreadyVisible, true);
  });
  run.commit('core'); assert.deepEqual(names(run), ['read_file', DISCOVERY_TOOL_NAME]);
});
test('registry changes clear committed and pending selections rather than carrying them into fresh source', () => {
  const { runtime, run } = fixture(); run.capture(); run.stage('selected', 'private_alpha', 1, run.identity()); run.commit('selected');
  const old = run.capture(); run.stage('pending', 'private_beta', 1, run.identity());
  runtime.register('plugin', source('new_read')); assert.throws(() => run.assertCurrent(), code('TOOL_DISCOVERY_STALE'));
  const fresh = run.capture(); assert.notEqual(old.catalogue.revision, fresh.catalogue.revision); assert.deepEqual(fresh.catalogue.tools.map(tool => tool.name), ['read_file', DISCOVERY_TOOL_NAME]);
  run.commit('pending'); assert.strictEqual(run.capture(), fresh);
  assert.throws(() => runtime.resolve(old.catalogue, 'private_alpha'), code('TOOL_CATALOGUE_STALE'));
});
test('source change between stage and commit discards staged output and refreshes from allowed policy', () => {
  const permission = new ToolPolicy(), { run } = fixture({ permission }); run.capture();
  const original = run.identity(); run.stage('a', 'private_alpha', 1, original);
  permission.replace([{ tool: 'private_alpha', decision: 'deny' }]); run.commit('a');
  assert.deepEqual(names(run), ['read_file', DISCOVERY_TOOL_NAME]);
  const result = run.stage('new', 'private_alpha', 1, run.identity()); assert.deepEqual(JSON.parse(result.content).matches, []);
  assert.throws(() => run.stage('old', 'private_beta', 1, original), code('TOOL_DISCOVERY_STALE'));
});
test('separate Run state and exact host allowlist never inherit another Run selection or reveal denied names', () => {
  const { runtime, run, policy } = fixture(); run.capture(); run.stage('a', 'private_alpha', 1, run.identity()); run.commit('a'); run.capture();
  const independent = new RunToolDiscovery(runtime, policy, ['read_file'], 'build'); assert.deepEqual(names(independent), ['read_file', DISCOVERY_TOOL_NAME]);
  const limited = new RunToolDiscovery(runtime, policy, ['read_file'], 'build', ['read_file', DISCOVERY_TOOL_NAME]); limited.capture();
  const result = limited.stage('limited', 'private', 4, limited.identity()); assert.deepEqual(JSON.parse(result.content).matches, []);
  assert.ok(!result.content.includes('private_alpha')); assert.ok(!result.content.includes('private_beta'));
});
test('bounded search result uses metadata and valid UTF8 description prefix without schema source', () => {
  const { runtime, run } = fixture(); runtime.register('engine', source('unicode_target', '가'.repeat(300))); run.capture();
  const result = run.stage('unicode', 'unicode_target', 1, run.identity()), payload = JSON.parse(result.content), match = payload.matches[0];
  assert.equal(match.descriptionTruncated, true); assert.equal(Buffer.byteLength(match.description), 510); assert.ok(!match.description.includes('\ufffd'));
  assert.match(match.schemaSha256, /^[a-f0-9]{64}$/); assert.match(match.definitionSha256, /^[a-f0-9]{64}$/);
  assert.ok(!result.content.includes('inputSchema')); assert.ok(!result.content.includes('x'.repeat(1000)));
  assert.ok(Buffer.byteLength(result.content) < 32 * 1024);
});
test('discovery factory original handle is one-use and failed staging cannot replay it', async () => {
  const { run, tool, stageCalls } = fixture({ policy: { maxSelectedTools: 0 } }); run.capture(); const ctx = context();
  const prepared = await tool.prepare({ query: 'private_alpha' }, ctx);
  await assert.rejects(tool.execute(structuredClone(prepared), ctx), code('INVALID_PREPARED_TOOL')); assert.equal(stageCalls(), 0);
  await assert.rejects(tool.execute(prepared, ctx), code('TOOL_DISCOVERY_LIMIT')); assert.equal(stageCalls(), 1);
  await assert.rejects(tool.execute(prepared, ctx), code('INVALID_PREPARED_TOOL')); assert.equal(stageCalls(), 1);
  assert.deepEqual(names(run), ['read_file', DISCOVERY_TOOL_NAME]);
});
test('scoped discovery prepared identity cannot cross Run/session/workspace/turn/attempt/tool-call boundaries', async () => {
  const { runtime, run, stageCalls } = fixture(); const capture = run.capture(), tool = runtime.resolve(capture.catalogue, DISCOVERY_TOOL_NAME), ctx = context();
  const variants = [{ ...ctx, runId: 'other-run' }, { ...ctx, sessionId: 'other-session' }, { ...ctx, workspace: { ...ctx.workspace, id: 'other-workspace' } },
    { ...ctx, turnId: 'other-turn' }, { ...ctx, attemptId: 'other-attempt' }, { ...ctx, toolCallId: 'other-call' }];
  for (const changed of variants) {
    const prepared = await tool.prepare({ query: 'private_alpha' }, ctx);
    await assert.rejects(tool.execute(prepared, changed), code('TOOL_APPROVAL_STALE'));
  }
  assert.equal(stageCalls(), 0); assert.deepEqual(names(run), ['read_file', DISCOVERY_TOOL_NAME]);
});
test('cancelled or tampered scoped handle executes no staging, while successful result still needs saved-result commit', async () => {
  const { runtime, run, stageCalls } = fixture(); const initial = run.capture(), tool = runtime.resolve(initial.catalogue, DISCOVERY_TOOL_NAME), ctx = context();
  const cancelled = await tool.prepare({ query: 'private_alpha' }, ctx), abort = new AbortController(); abort.abort();
  await assert.rejects(tool.execute(cancelled, { ...ctx, signal: abort.signal }), code('CANCELLED'));
  const tampered = await tool.prepare({ query: 'private_alpha' }, ctx); tampered.input = { query: 'private_beta', limit: 1 };
  await assert.rejects(tool.execute(tampered, ctx), code('TOOL_APPROVAL_STALE')); assert.equal(stageCalls(), 0);
  const prepared = await tool.prepare({ query: 'private_alpha', limit: 1 }, ctx), result = await tool.execute(prepared, ctx);
  assert.equal(result.structuredResult?.outcome, 'completed'); assert.equal(stageCalls(), 1); assert.strictEqual(run.capture(), initial);
  await assert.rejects(tool.execute(prepared, ctx), code('INVALID_PREPARED_TOOL'));
  run.commit(ctx.toolCallId); assert.ok(names(run).includes('private_alpha'));
});
test('prepared source version cannot survive registry mutation and malformed queries never stage', async () => {
  const { runtime, run, tool, stageCalls } = fixture(); run.capture(); const ctx = context();
  const prepared = await tool.prepare({ query: 'private_alpha' }, ctx); runtime.register('another_scope', source('new_tool')); run.capture();
  await assert.rejects(tool.execute(prepared, ctx), code('TOOL_DISCOVERY_STALE')); assert.equal(stageCalls(), 1);
  for (const value of [{ query: '' }, { query: 'read_file', unexpected: true }, { query: '가'.repeat(86) }, { query: 'read_file', limit: 9 }]) {
    await assert.rejects(tool.prepare(value, ctx), code('INVALID_TOOL_DISCOVERY_QUERY'));
  }
  assert.equal(stageCalls(), 1); assert.deepEqual(names(run), ['read_file', DISCOVERY_TOOL_NAME]);
});
