import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, type EngineOptions } from './engine.js';
import { acquireExecutionLock } from './tools/command/execution-lock.js';

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
