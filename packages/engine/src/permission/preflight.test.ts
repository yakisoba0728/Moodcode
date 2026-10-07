import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandPreflightRegistry, COMMAND_PREFLIGHT_LIMITS, type CommandPreflightAnalyzer, type CommandPreflightBinding, type CommandPreflightResult } from './preflight.js';

async function fixture(t: test.TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-preflight-'))), root = join(base, 'workspace'); await mkdir(root); await mkdir(join(root, 'src'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const binding: CommandPreflightBinding = { workspaceId: 'workspace', workspaceRoot: root, sessionId: 'session', runId: 'run', command: 'node --version', cwd: join(root, 'src'), preparedFingerprint: 'producer-fingerprint', policyRevision: 1, sourceRevision: 'registry-source-1' };
  return { base, root, binding };
}
function analyzer(analyze: CommandPreflightAnalyzer['analyze'], id = 'trusted-check'): CommandPreflightAnalyzer { return { id, revision: 1, sourceSha256: 'a'.repeat(64), analyze }; }
function allowed(): CommandPreflightResult { return { decision: 'allow', findings: [{ code: 'known-command', decision: 'allow', summary: 'Known command structure' }] }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('capture binds exact command/cwd/policy/source, persists command digest only and preserves approval', async t => {
  const { binding } = await fixture(t); const registry = new CommandPreflightRegistry(); let observed: unknown;
  registry.register(analyzer(async context => { observed = context.binding; assert.ok(Object.isFrozen(context.binding)); return allowed(); }));
  const request = await registry.capture(binding, 'trusted-check'); const receipt = await registry.run(request);
  assert.deepEqual(observed, binding); assert.equal(receipt.status, 'completed'); assert.equal(receipt.decision, 'allow'); assert.equal(receipt.osIsolation, false);
  assert.equal(receipt.analyzerSourceSha256, 'a'.repeat(64)); assert.equal(receipt.policyRevision, 1); assert.equal(receipt.sourceRevision, 'registry-source-1');
  assert.ok(!JSON.stringify(request).includes(binding.command)); assert.ok(!JSON.stringify(receipt).includes(binding.command));
  await registry.assertCurrent(receipt, structuredClone(binding));
  assert.equal(registry.decision(receipt, 'allow', false), 'allow'); assert.equal(registry.decision(receipt, 'ask', false), 'ask'); assert.equal(registry.decision(receipt, 'allow', true), 'ask'); assert.equal(registry.decision(receipt, 'deny', false), 'deny');
  await assert.rejects(registry.run(request), { code: 'COMMAND_PREFLIGHT_USED' });
});

test('deny and ask findings dominate contradictory analyzer aggregate', async t => {
  const { binding } = await fixture(t); const registry = new CommandPreflightRegistry();
  registry.register(analyzer(async () => ({ decision: 'allow', findings: [{ code: 'denied', decision: 'deny', summary: 'Host condition blocks command' }] })));
  const receipt = await registry.run(await registry.capture(binding, 'trusted-check')); assert.equal(receipt.decision, 'deny'); assert.equal(registry.decision(receipt, 'allow', false), 'deny');
  registry.register(analyzer(async () => ({ decision: 'allow', findings: [{ code: 'review', decision: 'ask', summary: 'Requires exact approval' }] }), 'ask'));
  assert.equal((await registry.run(await registry.capture(binding, 'ask'))).decision, 'ask');
});

test('changed command, cwd, owner, policy/source or prepared fingerprint invalidates receipt', async t => {
  const { root, binding } = await fixture(t); const registry = new CommandPreflightRegistry(); registry.register(analyzer(async () => allowed()));
  const receipt = await registry.run(await registry.capture(binding, 'trusted-check'));
  for (const changed of [{ command: `${binding.command} ` }, { cwd: root }, { workspaceId: 'other' }, { sessionId: 'other' }, { runId: 'other' }, { policyRevision: 2 }, { sourceRevision: 'source-2' }, { preparedFingerprint: 'other' }]) await assert.rejects(registry.assertCurrent(receipt, { ...binding, ...changed }), { code: 'COMMAND_PREFLIGHT_STALE' });
  await assert.rejects(registry.assertCurrent(structuredClone(receipt), binding), { code: 'COMMAND_PREFLIGHT_STALE' });
  assert.throws(() => registry.decision(structuredClone(receipt), 'allow', false), { code: 'INVALID_COMMAND_PREFLIGHT_RECEIPT' });
});

test('registry revision and analyzer removal invalidate captures and finished receipts', async t => {
  const { binding } = await fixture(t); const registry = new CommandPreflightRegistry(); const remove = registry.register(analyzer(async () => allowed()));
  const request = await registry.capture(binding, 'trusted-check'); registry.register(analyzer(async () => allowed(), 'other'));
  await assert.rejects(registry.run(request), { code: 'COMMAND_PREFLIGHT_STALE' });
  const receipt = await registry.run(await registry.capture(binding, 'trusted-check')); remove();
  await assert.rejects(registry.assertCurrent(receipt, binding), { code: 'COMMAND_PREFLIGHT_STALE' });
  await assert.rejects(registry.capture(binding, 'trusted-check'), { code: 'COMMAND_PREFLIGHT_UNAVAILABLE' });
  registry.register({ ...analyzer(async () => allowed()), revision: 2, sourceSha256: 'b'.repeat(64) });
  await assert.rejects(registry.assertCurrent(receipt, binding), { code: 'COMMAND_PREFLIGHT_STALE' });
});

test('registry mutation while analyzer is running rejects stale results', async t => {
  const { binding } = await fixture(t); const registry = new CommandPreflightRegistry(); const entered = deferred<void>(), output = deferred<CommandPreflightResult>();
  const remove = registry.register(analyzer(async () => { entered.resolve(); return output.promise; }));
  const request = await registry.capture(binding, 'trusted-check'); const pending = registry.run(request); await entered.promise; remove(); output.resolve(allowed());
  await assert.rejects(pending, { code: 'COMMAND_PREFLIGHT_STALE' });
});

test('analyzer errors and malformed/oversized results return bounded ask with no exception content', async t => {
  const { binding } = await fixture(t); const registry = new CommandPreflightRegistry();
  const cases: CommandPreflightAnalyzer['analyze'][] = [
    async () => { throw new Error('secret command and provider credential'); },
    async () => ({ decision: 'allow', findings: 'wrong' } as never),
    async () => ({ decision: 'allow', findings: [{ code: 'finding', decision: 'allow', summary: 'x'.repeat(1025) }] }),
    async () => ({ decision: 'allow', findings: Array.from({ length: 33 }, () => ({ code: 'finding', decision: 'allow', summary: 'bounded' })) }),
    async () => ({ decision: 'allow', findings: Array.from({ length: 16 }, () => ({ code: 'finding', decision: 'allow', summary: 'x'.repeat(1024) })) }),
    async () => ({ decision: 'allow', findings: [], arbitraryProcessCapability: true } as never),
  ];
  for (const [index, analyze] of cases.entries()) {
    const id = `case-${index}`; registry.register(analyzer(analyze, id)); const receipt = await registry.run(await registry.capture(binding, id));
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.reason, 'analyzer_failed'); assert.equal(receipt.decision, 'ask'); assert.deepEqual(receipt.findings, []); assert.ok(!JSON.stringify(receipt).includes('credential'));
    assert.equal(registry.decision(receipt, 'allow', false), 'ask');
  }
});

test('timeout aborts callback signal and does not turn eventual callback completion into allowance', async t => {
  const { binding } = await fixture(t); const registry = new CommandPreflightRegistry(); const output = deferred<CommandPreflightResult>(); let signal: AbortSignal | undefined;
  registry.register(analyzer(async context => { signal = context.signal; return output.promise; }));
  const receipt = await registry.run(await registry.capture(binding, 'trusted-check'), { deadlineMs: 5 });
  assert.equal(receipt.status, 'timed_out'); assert.equal(receipt.reason, 'analyzer_timeout'); assert.equal(receipt.decision, 'ask'); assert.equal(signal?.aborted, true);
  output.resolve(allowed()); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(receipt.decision, 'ask'); assert.equal(registry.decision(receipt, 'allow', false), 'ask');
});

test('caller cancellation before analysis avoids callback, and running cancellation signals it', async t => {
  const { binding } = await fixture(t); const registry = new CommandPreflightRegistry(); let calls = 0; const entered = deferred<void>(), output = deferred<CommandPreflightResult>(); let signal: AbortSignal | undefined;
  registry.register(analyzer(async context => { calls++; signal = context.signal; entered.resolve(); return output.promise; }));
  const request = await registry.capture(binding, 'trusted-check'); const aborted = new AbortController(); aborted.abort();
  const first = await registry.run(request, { signal: aborted.signal }); assert.equal(first.status, 'cancelled'); assert.equal(calls, 0);
  await assert.rejects(registry.capture(binding, 'trusted-check', aborted.signal), { code: 'CANCELLED' });
  const live = new AbortController(); const pending = registry.run(await registry.capture(binding, 'trusted-check'), { signal: live.signal }); await entered.promise; live.abort();
  const second = await pending; assert.equal(second.status, 'cancelled'); assert.equal(second.decision, 'ask'); assert.equal(signal?.aborted, true); output.resolve(allowed());
});

test('physical cwd/workspace replacement makes capture stale before dispatch', async t => {
  const { base, root, binding } = await fixture(t); const registry = new CommandPreflightRegistry(); registry.register(analyzer(async () => allowed()));
  const request = await registry.capture(binding, 'trusted-check'); await rename(binding.cwd, join(root, 'old-src')); await mkdir(binding.cwd);
  await assert.rejects(registry.run(request), { code: 'COMMAND_PREFLIGHT_STALE' });
  const receipt = await registry.run(await registry.capture(binding, 'trusted-check')); await rename(root, join(base, 'moved')); await mkdir(root); await mkdir(join(root, 'src'));
  await assert.rejects(registry.assertCurrent(receipt, binding), { code: 'COMMAND_PREFLIGHT_STALE' });
});

test('outside cwd, symlink cwd and malformed exact bindings fail closed', async t => {
  const { base, root, binding } = await fixture(t); await mkdir(join(base, 'outside')); await symlink(join(root, 'src'), join(root, 'link'));
  const registry = new CommandPreflightRegistry(); registry.register(analyzer(async () => allowed()));
  for (const cwd of [join(base, 'outside'), join(root, 'link')]) await assert.rejects(registry.capture({ ...binding, cwd }, 'trusted-check'), { code: 'COMMAND_PREFLIGHT_PATH_CHANGED' });
  for (const changed of [{ command: ' ' }, { command: 'nul\0command' }, { command: 'x'.repeat(COMMAND_PREFLIGHT_LIMITS.maxCommandBytes + 1) }, { policyRevision: 0 }, { cwd: './src' }, { workspaceRoot: `${root}/..` }, { sourceRevision: '' }]) await assert.rejects(registry.capture({ ...binding, ...changed }, 'trusted-check'));
  await assert.rejects(registry.run({} as never), { code: 'INVALID_COMMAND_PREFLIGHT_REQUEST' });
  for (const deadlineMs of [0, 1.5, COMMAND_PREFLIGHT_LIMITS.maxDeadlineMs + 1]) await assert.rejects(registry.run(await registry.capture(binding, 'trusted-check'), { deadlineMs }), { code: 'INVALID_COMMAND_PREFLIGHT' });
  assert.throws(() => registry.register({ ...analyzer(async () => allowed()), sourceSha256: 'incorrect' }), { code: 'INVALID_COMMAND_PREFLIGHT' });
  assert.throws(() => registry.register(analyzer(async () => allowed())), { code: 'COMMAND_PREFLIGHT_CONFLICT' });
});

test('captured source metadata and exact binding survive caller mutation', async t => {
  const { binding } = await fixture(t); const registry = new CommandPreflightRegistry(); let seen = '';
  const installed = analyzer(async context => { seen = context.binding.command; return allowed(); }); registry.register(installed);
  installed.sourceSha256 = 'b'.repeat(64); const pending = registry.capture(binding, 'trusted-check'); binding.command = 'changed'; const request = await pending;
  const receipt = await registry.run(request); assert.equal(seen, 'node --version'); assert.equal(receipt.analyzerSourceSha256, 'a'.repeat(64)); assert.ok(Object.isFrozen(receipt)); assert.ok(Object.isFrozen(receipt.findings));
  assert.throws(() => { (receipt.findings as unknown[]).push({}); }, TypeError);
});

test('concurrent run of one captured request dispatches exactly one analyzer', async t => {
  const { binding } = await fixture(t); const registry = new CommandPreflightRegistry(); let calls = 0;
  registry.register(analyzer(async () => { calls++; return allowed(); })); const request = await registry.capture(binding, 'trusted-check');
  const outcomes = await Promise.allSettled([registry.run(request), registry.run(request)]);
  assert.equal(calls, 1); assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(item => item.status === 'rejected') as PromiseRejectedResult; assert.equal(rejected.reason.code, 'COMMAND_PREFLIGHT_USED');
});

test('timed out callbacks occupy bounded host capacity until they actually settle', async t => {
  const { binding } = await fixture(t); const registry = new CommandPreflightRegistry(); const output = deferred<CommandPreflightResult>();
  registry.register(analyzer(async () => output.promise));
  for (let index = 0; index < COMMAND_PREFLIGHT_LIMITS.maxRunningAnalyzers; index++) assert.equal((await registry.run(await registry.capture(binding, 'trusted-check'), { deadlineMs: 1 })).status, 'timed_out');
  assert.equal(registry.runningAnalyzers, COMMAND_PREFLIGHT_LIMITS.maxRunningAnalyzers);
  const blocked = await registry.capture(binding, 'trusted-check'); await assert.rejects(registry.run(blocked), { code: 'COMMAND_PREFLIGHT_RUNNING_LIMIT' });
  output.resolve(allowed()); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(registry.runningAnalyzers, 0);
  assert.equal((await registry.run(blocked)).status, 'completed'); assert.equal(registry.runningAnalyzers, 0);
});

test('analyzer results and bindings reject getters/proxies/sparse findings without invoking caller traps', async t => {
  const { binding } = await fixture(t); let calls = 0; const registry = new CommandPreflightRegistry();
  const getter = { findings: [] }; Object.defineProperty(getter, 'decision', { enumerable: true, get() { calls++; return 'allow'; } });
  const proxy = new Proxy({}, { get() { calls++; return 'allow'; }, getPrototypeOf() { calls++; return Object.prototype; }, ownKeys() { calls++; return []; } });
  const findings = [{ code: 'a', decision: 'allow', summary: 'a' }]; Object.defineProperty(findings, '0', { enumerable: true, get() { calls++; return { code: 'a', decision: 'allow', summary: 'a' }; } });
  // A nested proxy reaches the record validator directly, without Promise's own thenable assimilation.
  for (const [index, output] of [getter, { decision: 'allow', findings: [proxy] }, { decision: 'allow', findings }, { decision: 'allow', findings: new Array(1) }, { decision: 'allow', findings: new Proxy([], { get() { calls++; return 0; } }) }].entries()) {
    const id = `unsafe-${index}`; registry.register(analyzer(async () => output as never, id)); const receipt = await registry.run(await registry.capture(binding, id)); assert.equal(receipt.status, 'failed'); assert.equal(receipt.decision, 'ask');
  }
  const input = { ...binding }; Object.defineProperty(input, 'command', { enumerable: true, get() { calls++; return 'node --version'; } }); await assert.rejects(registry.capture(input, 'unsafe-0'), { code: 'INVALID_COMMAND_PREFLIGHT' });
  assert.equal(calls, 0);
});
