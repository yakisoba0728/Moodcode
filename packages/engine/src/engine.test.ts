import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, type EngineOptions } from './engine.js';
import { acquireExecutionLock } from './tools/command/execution-lock.js';
import { createCommandEnvironment } from './tools/command/process-control.js';

async function fixture(options: Omit<EngineOptions, 'dbPath'> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'moodcode-facade-'));
  const engine = createEngine({ dbPath: join(root, 'state.sqlite'), tools: [], ...options });
  return { engine, dbPath: join(root, 'state.sqlite'), async cleanup() { await engine.close(); await rm(root, { recursive: true, force: true }); } };
}

test('capabilities describe local adapters and configured defaults without invoking a provider', async () => {
  let calls = 0;
  const f = await fixture({
    defaults: { providerId: 'configured', modelId: 'explicit-model', limits: { maxTurns: 3 } },
    providers: [{ id: 'configured', async *streamTurn() { calls++; throw new Error('metadata must not start a model'); } }],
  });
  try {
    const command = { schemaVersion: 1, commandId: 'capabilities', type: 'engine.getCapabilities', payload: {} };
    const reply = await f.engine.dispatch(command);
    assert.equal(reply.ok, true);
    const value = reply.result as { providerIds: string[]; tools: unknown[]; defaults: { providerId: string; modelId: string; limits: { maxTurns: number } }; runtime: { node: string } };
    assert.deepEqual(value.providerIds, ['configured', 'scripted']);
    assert.deepEqual(value.tools, []);
    assert.equal(value.defaults.providerId, 'configured');
    assert.equal(value.defaults.modelId, 'explicit-model');
    assert.equal(value.defaults.limits.maxTurns, 3);
    assert.equal(value.runtime.node, process.versions.node);
    value.defaults.limits.maxTurns = 999;
    const second = await f.engine.dispatch(command);
    assert.equal(((second.result as typeof value).defaults.limits.maxTurns), 3);
    assert.equal(calls, 0);
    assert.deepEqual(f.engine.store.listWorkspaces(), []);
    const invalid = await f.engine.dispatch({ ...command, payload: { apiKey: 'metadata-is-not-a-secret-store' } });
    assert.equal(invalid.error?.code, 'INVALID_INPUT');
  } finally { await f.cleanup(); }
});

test('engine defaults merge partial submit limits while explicit invalid values remain invalid', async () => {
  const f = await fixture({ defaults: { mode: 'build', limits: { maxTurns: 3, maxToolCalls: 4 } } });
  try {
    const root = f.dbPath.slice(0, f.dbPath.lastIndexOf('/'));
    f.engine.store.putWorkspace({ id: 'default-workspace', root, gitRoot: root, branch: null, createdAt: new Date().toISOString() });
    f.engine.store.createSession({ id: 'default-session', workspaceId: 'default-workspace', title: 'defaults', createdAt: new Date().toISOString() });
    const payload = { sessionId: 'default-session', requestId: 'default-request', prompt: 'local test', config: { limits: { maxToolCalls: 2 } } };
    const command = { schemaVersion: 1, commandId: 'defaults', type: 'run.submit', payload };
    const receipt = await f.engine.dispatch(command);
    assert.equal(receipt.ok, true);
    const runId = (receipt.result as { runId: string }).runId;
    const run = await f.engine.waitForRun(runId);
    assert.equal(run.state, 'completed');
    assert.equal(run.config.mode, 'build');
    assert.equal(run.config.limits.maxTurns, 3);
    assert.equal(run.config.limits.maxToolCalls, 2);
    const duplicate = await f.engine.dispatch(command);
    assert.equal((duplicate.result as { runId: string; duplicate: boolean }).runId, runId);
    assert.equal((duplicate.result as { duplicate: boolean }).duplicate, true);
    const invalid = await f.engine.dispatch({ ...command, payload: { ...payload, config: { mode: null } } });
    assert.equal(invalid.error?.code, 'INVALID_INPUT');
  } finally { await f.cleanup(); }
});

test('facade returns correlated versioned errors and does not echo unsupported credential values', async () => {
  const f = await fixture();
  try {
    const secret = 'private-key-not-a-command-field';
    const result = await f.engine.dispatch({ schemaVersion: 1, commandId: 'bad-input', type: 'run.submit', payload: { apiKey: secret } });
    assert.equal(result.ok, false);
    assert.equal(result.commandId, 'bad-input');
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.error?.code, 'INVALID_INPUT');
    assert(!JSON.stringify(result).includes(secret));
    const unknown = await f.engine.dispatch({ schemaVersion: 1, commandId: 'unknown', type: 'arbitrary.invoke', payload: {} });
    assert.equal(unknown.error?.code, 'UNKNOWN_COMMAND');
    assert.equal(unknown.commandId, 'unknown');
  } finally { await f.cleanup(); }
});

test('facade rejects accessor-based envelope without executing the accessor or rejecting its promise', async () => {
  const f = await fixture();
  try {
    let reads = 0;
    const value = { schemaVersion: 1, type: 'session.list', payload: { workspaceId: 'missing' } };
    Object.defineProperty(value, 'commandId', { enumerable: true, get() { reads++; throw new Error('private-accessor-value'); } });
    const result = await f.engine.dispatch(value);
    assert.equal(result.ok, false);
    assert.equal(reads, 0);
    assert.equal(result.commandId, '');
    assert(!JSON.stringify(result).includes('private-accessor-value'));
  } finally { await f.cleanup(); }
});

test('facade result boundary contains throwing object traps', async () => {
  const f = await fixture();
  try {
    const value = new Proxy({}, { getPrototypeOf() { throw new Error('private-proxy-context'); }, getOwnPropertyDescriptor() { throw new Error('private-proxy-context'); } });
    const result = await f.engine.dispatch(value);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'INVALID_INPUT');
    assert(!JSON.stringify(result).includes('private-proxy-context'));
  } finally { await f.cleanup(); }
});

test('invalid correlation IDs are not copied back after command validation fails', async () => {
  const f = await fixture();
  try {
    for (const commandId of ['', '   ', 'line\nbreak', 'nul\0id', 'del\u007f', 'x'.repeat(257), '가'.repeat(100)]) {
      const result = await f.engine.dispatch({ schemaVersion: 1, commandId, type: 'engine.getCapabilities', payload: {} });
      assert.equal(result.ok, false);
      assert.equal(result.commandId, '');
    }
    const commandId = '상관-ID-한글';
    const result = await f.engine.dispatch({ schemaVersion: 1, commandId, type: 'engine.getCapabilities', payload: { unexpected: true } });
    assert.equal(result.commandId, commandId);
  } finally { await f.cleanup(); }
});

test('facade close is idempotent and rejects further commands and invalid subscription cursors', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.engine.subscribe('missing', -1), { code: 'INVALID_CURSOR' });
    assert.throws(() => f.engine.subscribe('missing', Number.NaN), { code: 'INVALID_CURSOR' });
    await Promise.all([f.engine.close(), f.engine.close()]);
    const result = await f.engine.dispatch({ schemaVersion: 1, commandId: 'closed', type: 'session.list', payload: { workspaceId: 'anything' } });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ENGINE_CLOSED');
    assert.throws(() => f.engine.subscribe('anything', 0), { code: 'ENGINE_CLOSED' });
  } finally { await f.cleanup(); }
});

test('facade reopening waits for an active command supervisor lock and permits confirmed cleanup', async () => {
  const f = await fixture();
  let lock: ReturnType<typeof acquireExecutionLock> | undefined;
  try {
    lock = acquireExecutionLock(`${f.dbPath}.effects.sqlite`);
    await f.engine.close();
    assert.throws(() => createEngine({ dbPath: f.dbPath, tools: [] }), { code: 'CLEANUP_PENDING' });
    lock.release(true);
    const reopened = createEngine({ dbPath: f.dbPath, tools: [] });
    await reopened.close();
  } finally { lock?.release(true); await f.cleanup(); }
});

test('facade preserves an uncertain effect marker after its owner releases the OS lock', async () => {
  const f = await fixture();
  let lock: ReturnType<typeof acquireExecutionLock> | undefined;
  try {
    lock = acquireExecutionLock(`${f.dbPath}.effects.sqlite`);
    lock.release(false);
    await f.engine.close();
    assert.throws(() => createEngine({ dbPath: f.dbPath, tools: [] }), { code: 'COMMAND_CLEANUP_UNCERTAIN' });
    assert.throws(() => createEngine({ dbPath: f.dbPath, tools: [] }), { code: 'COMMAND_CLEANUP_UNCERTAIN' });
  } finally { lock?.release(false); await f.cleanup(); }
});

for (const [flag, message] of [
  ['lifecycleContinuation', 'Lifecycle continuation requires an explicit host boolean'],
  ['verificationTools', 'Verification tool exposure must be an explicit boolean'],
  ['knowledgeGeneration', 'Knowledge generation requires an explicit host boolean'],
  ['knowledgePublication', 'Knowledge publication requires an explicit host boolean'],
  ['knowledgeFilePublication', 'Knowledge file publication requires an explicit host boolean'],
  ['knowledgeImportRecovery', 'knowledgeImportRecovery must be an explicit boolean'],
  ['proposals', 'proposals must be an explicit boolean'],
  ['teams', 'teams must be an explicit boolean'],
  ['teamModelTools', 'teamModelTools must be an explicit boolean'],
  ['commandJobModelTools', 'commandJobModelTools must be an explicit boolean'],
  ['residentTeams', 'residentTeams requires explicit boolean'],
  ['workflows', 'workflows must be an explicit boolean'],
  ['codingBatches', 'codingBatches must be explicit boolean'],
  ['schedules', 'schedules must be an explicit boolean'],
  ['agentBackends', 'agentBackends requires an explicit root host boolean'],
  ['agentBackendClientEffects', 'ACP client effects require explicit host opt-in'],
  ['jobs', 'jobs requires an explicit root host boolean'],
  ['codeMode', 'codeMode requires an explicit boolean'],
  ['effectBatches', 'effectBatches requires an explicit boolean'],
  ['conversationForks', 'conversationForks must be an explicit boolean'],
  ['proposalApply', 'proposalApply must be an explicit boolean'],
  ['diagnosticObservations', 'Execution observations require an explicit host boolean'],
  ['osSandbox', 'osSandbox must be an explicit boolean'],
  ['commandLifetimes', 'commandLifetimes requires an explicit host boolean'],
  ['hostCommands', 'hostCommands must be an explicit boolean'],
  ['allowUnknownMediaTokenCost', 'Media token cost policy must be a boolean'],
  ['allowUnknownDocumentTokenCost', 'Document token cost policy must be a boolean'],
  ['repositoryContextTools', 'Repository tool exposure must be an explicit boolean'],
] as const) test(`constructor ${flag} preserves exact invalid error and property reads`, () => {
  let reads = 0;
  const options = { dbPath: ':memory:' };
  Object.defineProperty(options, flag, { enumerable: true, get() { reads++; return 'invalid'; } });
  assert.throws(() => createEngine(options), { code: 'INVALID_CONFIG', message });
  assert.equal(reads, flag === 'osSandbox' ? 3 : 2);
});

test('constructor registers valid credentialEnvNames for child environments and rejects any invalid list whole', async () => {
  const message = 'credentialEnvNames must list at most 256 environment variable names';
  for (const value of ['ENGINE_TEST_PARTIAL_KEY', ['ENGINE_TEST_PARTIAL_KEY', '1INVALID'], ['ENGINE_TEST_PARTIAL_KEY', 'KEY=VALUE'], ['ENGINE_TEST_PARTIAL_KEY', 7], new Array(1), Array(257).fill('ENGINE_TEST_PARTIAL_KEY')])
    assert.throws(() => createEngine({ dbPath: ':memory:', credentialEnvNames: value } as unknown as EngineOptions), { code: 'INVALID_CONFIG', message });
  assert.deepEqual(createCommandEnvironment({ ENGINE_TEST_PARTIAL_KEY: 'fake' }), { ENGINE_TEST_PARTIAL_KEY: 'fake' });
  const f = await fixture({ credentialEnvNames: ['ENGINE_TEST_HOST_KEY'] });
  try { assert.deepEqual(createCommandEnvironment({ PATH: '/bin', ENGINE_TEST_HOST_KEY: 'fake' }), { PATH: '/bin' }); }
  finally { await f.cleanup(); }
});

test('constructor undefined guards short circuit and retain interleaved dependency error priority', () => {
  const stop = new Error('trusted host stop'), options = { dbPath: ':memory:' };
  let reads = 0;
  Object.defineProperty(options, 'lifecycleContinuation', { get() { return ++reads === 1 ? undefined : 'invalid'; } });
  Object.defineProperty(options, 'roleResourcePolicyRegistry', { get() { throw stop; } });
  assert.throws(() => createEngine(options), error => error === stop); assert.equal(reads, 1);
  for (const [values, code, message] of [
    [{ residentTeams: true, teams: false, workflows: 'invalid' }, 'INVALID_CONFIG', 'Resident teams require teams and team model tools'],
    [{ codingBatches: true, workflows: false, schedules: 'invalid' }, 'CODING_BATCH_UNSUPPORTED', 'Coding batches require core workflow and verification tools'],
    [{ agentBackendClientEffects: true, agentBackends: false, jobs: 'invalid' }, 'INVALID_CONFIG', 'ACP effects require agentBackends opt-in'],
    [{ teamModelTools: true, teams: false, proposalApply: 'invalid' }, 'INVALID_CONFIG', 'Model team tools require explicit host teams'],
    [{ verificationTools: true, tools: [], osSandbox: 'invalid' }, 'INVALID_VERIFICATION_CONFIG', 'Verification requires the engine-owned command producer and core registrations'],
    [{ commandLifetimes: true, jobs: false, hostCommands: 'invalid' }, 'INVALID_CONFIG', 'commandLifetimes requires jobs and hostCommands'],
  ] as const) assert.throws(() => createEngine({ dbPath: ':memory:', ...values } as unknown as EngineOptions), { code, message });
});

test('import wrappers synchronously return the concrete factory Promise and track both settlements', async () => {
  const f = await fixture(), pending = Reflect.get(f.engine, 'pendingImages') as Set<Promise<unknown>>;
  const calls = [
    { field: 'images', invoke: (signal?: AbortSignal) => f.engine.importImage('fixture', new Uint8Array(), 'image/png', signal) },
    { field: 'documents', invoke: (signal?: AbortSignal) => f.engine.importDocument('fixture', new Uint8Array(), signal) },
    { field: 'segments', invoke: (signal?: AbortSignal) => f.engine.importMedia('fixture', new Uint8Array(), 'audio/wav', [], signal) },
  ];
  try {
    for (const call of calls) {
      const store = Reflect.get(f.engine, call.field) as { import: (...args: unknown[]) => Promise<unknown> }, original = store.import;
      try {
        for (const reject of [false, true]) {
          let settle!: (value: unknown) => void, entered = false;
          const operation = new Promise<unknown>((resolve, no) => { settle = reject ? no : resolve; });
          const controller = new AbortController();
          store.import = (...args) => { entered = true; const signal = args.at(-1) as AbortSignal; assert.equal(signal.aborted, false); return operation; };
          const result = call.invoke(controller.signal);
          assert.equal(entered, true); assert.equal(result, operation); assert.equal(pending.has(operation), true);
          const settled = Promise.allSettled([result]); settle(reject ? new Error('import rejected') : { id: 'imported' });
          assert.equal((await settled)[0]!.status, reject ? 'rejected' : 'fulfilled'); assert.equal(pending.has(operation), false);
        }
        const marker = new Error('synchronous factory failure'); store.import = () => { throw marker; };
        assert.throws(() => call.invoke(), error => error === marker); assert.equal(pending.size, 0);
      } finally { store.import = original; }
    }
    const caller = new AbortController(), host = Reflect.get(f.engine, 'hostResources') as AbortController;
    caller.abort('caller abort'); host.abort('host abort');
    for (const call of calls) {
      const store = Reflect.get(f.engine, call.field) as { import: (...args: unknown[]) => Promise<unknown> }, original = store.import;
      try {
        store.import = (...args) => { assert.equal((args.at(-1) as AbortSignal).reason, 'caller abort'); return Promise.resolve({ id: 'aborted' }); };
        await call.invoke(caller.signal);
        store.import = (...args) => { assert.equal(args.at(-1), host.signal); return Promise.resolve({ id: 'host' }); };
        await call.invoke();
      } finally { store.import = original; }
    }
    await f.engine.close();
    for (const call of calls) {
      const store = Reflect.get(f.engine, call.field) as { import: (...args: unknown[]) => Promise<unknown> }, original = store.import;
      try {
        store.import = () => { assert.fail('closed imports must not invoke the factory'); };
        await assert.rejects(call.invoke(), { code: 'ENGINE_CLOSED', message: 'Engine is closing' });
      } finally { store.import = original; }
    }
  } finally { await f.cleanup(); }
});
