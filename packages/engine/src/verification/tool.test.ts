import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError } from '@moodcode/contracts';
import type { ApprovalPort, ApprovalRequest, ToolContext, ToolDefinition } from '../ports.js';
import { SqliteStore } from '../storage/index.js';
import { ArtifactStore } from '../artifacts/store.js';
import { createCommandTool } from '../tools/command/index.js';
import { ScopedToolRuntime, ToolPolicy, type ScopedToolRuntimeOptions } from '../tools/runtime/index.js';
import { CommandPreflightRegistry } from '../permission/preflight.js';
import { RoleResourcePolicy } from '../permission/role-resources.js';
import { VerificationCheckRegistry, VerificationPlanService } from './plans.js';
import { VerificationReceiptService } from './receipts.js';
import { createVerificationTool, type VerificationToolHost } from './tool.js';

const stamp = '2026-10-07T01:00:00.000Z';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const command = (source: string) => `${quote(process.execPath)} -e ${quote(source)}`;
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
interface Options { source?: string; timeoutMs?: number; outputBytes?: number; mode?: 'plan' | 'build'; runtimeOptions?: ScopedToolRuntimeOptions; wrapCommand?: (tool: ToolDefinition) => ToolDefinition; checks?: string[] }
async function fixture(t: TestContext, options: Options = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-verification-tool-'))), root = join(base, 'workspace'), rawDir = join(base, 'raw');
  await mkdir(root); await mkdir(rawDir); await writeFile(join(root, 'source.txt'), 'source-one');
  execFileSync('git', ['init', '--quiet', root]);
  const store = new SqliteStore(join(base, 'engine.sqlite')); t.after(async () => { store.close(); await rm(base, { recursive: true, force: true }); });
  const workspace = store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt: stamp });
  store.createSession({ id: 'session', workspaceId: workspace.id, title: 'Actual verification', createdAt: stamp });
  const input = store.acceptInput({ sessionId: 'session', requestId: 'request', prompt: 'verify', delivery: 'queue', config: { providerId: 'scripted', modelId: 'fixture', mode: options.mode ?? 'build', agentProfileId: 'builder', agentProfileRevision: 'profile-1', limits: { ...DEFAULT_LIMITS, toolTimeoutMs: 5000 } } });
  const run = store.promoteInput(input.inputId).run; store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
  const registry = new VerificationCheckRegistry();
  const ids = options.checks ?? ['tests'];
  const sourceText = options.source ?? "require('fs').appendFileSync('effect.txt','once\\n');process.stdout.write('original output\\n');process.stderr.write('original diagnostic\\n')";
  const checks = ids.map(id => ({ id, revision: 1, workspaceId: workspace.id, command: command(sourceText), cwd: root, profileId: 'builder', profileRevision: 'profile-1', sourceRevision: 'check-definitions-1', timeoutMs: options.timeoutMs ?? 2000, maxOutputBytes: options.outputBytes ?? 4096, required: true }));
  const removers = checks.map(check => registry.register(check));
  const plans = new VerificationPlanService(store, registry), receipts = new VerificationReceiptService(plans);
  const artifacts = await ArtifactStore.open({ directory: join(base, 'managed') });
  const runtime = new ScopedToolRuntime({ artifacts, ...options.runtimeOptions });
  const core = createCommandTool(); runtime.register('engine', options.wrapCommand?.(core) ?? core, { exactApproval: true });
  let sourceCalls = 0, artifactCalls = 0, published = 0;
  const source = async () => { const digest = sha(await readFile(join(root, 'source.txt'))); return { sha256: digest, revision: digest, checkpointId: null }; };
  const host: VerificationToolHost = { plans, receipts, getRun: id => store.getRun(id), commandRuntime: runtime,
    captureCatalogue: () => runtime.catalogue('engine', 'build', ['run_command', 'verify_changes'], { id: 'builder', revision: 'profile-1' }),
    async sourceObservation(_context, signal) { assert.equal(signal.aborted, false); sourceCalls++; return source(); }, artifacts: () => { artifactCalls++; return artifacts; } };
  const tool = createVerificationTool(host); runtime.register('engine', tool, { exactApproval: true });
  plans.create('session', run.id, 0, { checkIds: ids, source: await source() });
  const context = (id = 'call', signal = new AbortController().signal): ToolContext => {
    store.commit(run.id, 'tool.requested', {}, { tool: { id, runId: run.id, sessionId: 'session', name: 'verify_changes', input: { checkId: ids[0]! }, state: 'running' } });
    return { workspace, sessionId: 'session', runId: run.id, toolCallId: id, signal, limits: { ...run.config.limits }, artifactDir: rawDir,
      recordCheckpoint(checkpoint) { store.commit(run.id, 'workspace.changed', { checkpointId: checkpoint.id }, { checkpoint }); published++; } };
  };
  const approvals: ApprovalRequest[] = [];
  const approve = (status: 'allowed' | 'denied' = 'allowed', wrongFingerprint = false): ApprovalPort => ({
    async request(value) { approvals.push(structuredClone(value)); return { ...value, id: 'approval', status, fingerprint: wrongFingerprint ? sha('other') : value.fingerprint, createdAt: stamp }; },
    decide() { throw new Error('unused'); }, cancelRun() {},
  });
  const outer = () => runtime.resolve(host.captureCatalogue(contextPreview()), 'verify_changes');
  const contextPreview = (): ToolContext => ({ workspace, sessionId: 'session', runId: run.id, toolCallId: 'unused', signal: new AbortController().signal, limits: { ...run.config.limits }, artifactDir: rawDir, recordCheckpoint() {} });
  const lastReceipt = () => plans.get('session', run.id)!.receipts.at(-1)!;
  return { base, root, rawDir, store, run, checks, removers, registry, plans, receipts, artifacts, runtime, host, tool, context, approve, approvals, outer, lastReceipt, source,
    get sourceCalls() { return sourceCalls; }, get artifactCalls() { return artifactCalls; }, get published() { return published; } };
}

test('actual approved registered command produces a source-bound receipt, published checkpoint and immutable original logs', async t => {
  const f = await fixture(t), context = f.context(), outer = f.outer(), prepared = await outer.prepare({ checkId: 'tests' }, context);
  assert.equal(prepared.requiresApproval, true); assert.equal(f.artifactCalls, 0); assert.equal(f.published, 0); assert.deepEqual(prepared.input, { checkId: 'tests' });
  assert.equal(prepared.preview.command, f.checks[0]!.command); assert.equal(prepared.preview.cwd, f.root);
  const result = await f.runtime.executeApproved(prepared, context, f.approve());
  assert.equal(result.isError, false, result.content);
  assert.equal(f.approvals.length, 1); assert.equal(f.approvals[0]!.fingerprint, prepared.fingerprint); assert.equal(f.approvals[0]!.toolName, 'verify_changes');
  assert.equal(await readFile(join(f.root, 'effect.txt'), 'utf8'), 'once\n'); assert.equal(f.published, 1);
  const receipt = f.lastReceipt(); assert.equal(receipt.status, 'pass'); assert.equal(receipt.phase, 'settled'); assert.equal(receipt.observation!.exitCode, 0); assert.equal(receipt.observation!.cleanup.scope, 'posix-process-group'); assert.match(receipt.observation!.cleanup.evidenceSha256!, /^[a-f0-9]{64}$/u);
  assert.equal(f.store.listCheckpoints(f.run.id)[0]!.id, receipt.observation!.executionCheckpointId); assert.equal(receipt.observation!.artifactRefs.length, 3);
  const log = await f.artifacts.read(receipt.observation!.artifactRefs[0]!.id, { identity: receipt.observation!.artifactRefs[0]!.identity }); assert.equal(Buffer.from(log.bytes).toString('utf8'), 'original output\n');
  const stderr = await f.artifacts.read(receipt.observation!.artifactRefs[1]!.id); assert.equal(Buffer.from(stderr.bytes).toString('utf8'), 'original diagnostic\n');
  assert.equal((result.data as { verification: { status: string } }).verification.status, 'pass'); assert.match(result.content, /original output/u);
  const header = JSON.parse(result.content.split('\n')[0]!); assert.equal(header.verification.status, 'pass'); assert.equal(header.verification.receiptId, receipt.id); assert.equal(header.verification.checkId, 'tests'); assert.equal(header.verification.persistence, 'saved'); assert.equal(header.verification.sourceStale, false); assert.ok(header.read_artifact.length >= 2);
  await assert.rejects(f.runtime.executeApproved(prepared, context, f.approve()), code('INVALID_PREPARED_TOOL')); assert.equal(await readFile(join(f.root, 'effect.txt'), 'utf8'), 'once\n');
});

for (const variant of ['denied', 'wrong-fingerprint'] as const) test(`exact outer approval ${variant} prevents all command and receipt effects`, async t => {
  const f = await fixture(t), context = f.context(), prepared = await f.outer().prepare({ checkId: 'tests' }, context);
  await assert.rejects(f.runtime.executeApproved(prepared, context, f.approve(variant === 'denied' ? 'denied' : 'allowed', variant === 'wrong-fingerprint')), code('TOOL_APPROVAL_DENIED'));
  assert.equal(await exists(join(f.root, 'effect.txt')), false); assert.equal(f.plans.get('session', f.run.id)!.receipts.length, 0); assert.equal(f.published, 0);
});

test('model command/cwd/profile/source overrides and accessor/proxy input are rejected without reflection effects', async t => {
  const f = await fixture(t), context = f.context(); let touches = 0;
  for (const field of ['command', 'cwd', 'profileId', 'source', 'paths', 'receipt']) await assert.rejects(f.tool.prepare({ checkId: 'tests', [field]: 'untrusted' }, context), code('INVALID_VERIFICATION_DATA'));
  await assert.rejects(f.tool.prepare({ get checkId() { touches++; return 'tests'; } }, context), code('INVALID_VERIFICATION_DATA'));
  await assert.rejects(f.tool.prepare(new Proxy({}, { ownKeys() { touches++; return []; } }), context), code('INVALID_VERIFICATION_DATA'));
  assert.equal(touches, 0); assert.equal(await exists(join(f.root, 'effect.txt')), false);
});

test('original prepared identity, exact preview and owner binding cannot be cloned, altered or reused', async t => {
  const f = await fixture(t), context = f.context(), prepared = await f.tool.prepare({ checkId: 'tests' }, context);
  await assert.rejects(f.tool.execute(structuredClone(prepared), context), code('INVALID_PREPARED_TOOL'));
  prepared.preview.command = command("require('fs').writeFileSync('effect.txt','override')");
  await assert.rejects(f.tool.execute(prepared, context), code('VERIFICATION_APPROVAL_STALE'));
  await assert.rejects(f.tool.execute(prepared, context), code('INVALID_PREPARED_TOOL'));
  const second = f.context('second'), owner = await f.tool.prepare({ checkId: 'tests' }, second);
  await assert.rejects(f.tool.execute(owner, { ...second, toolCallId: 'foreign' }), code('VERIFICATION_APPROVAL_STALE'));
  assert.equal(await exists(join(f.root, 'effect.txt')), false); assert.equal(f.plans.get('session', f.run.id)!.receipts.length, 0);
});

test('source changed while approval waited blocks actual execution before durable intent', async t => {
  const f = await fixture(t), context = f.context(), prepared = await f.tool.prepare({ checkId: 'tests' }, context);
  await writeFile(join(f.root, 'source.txt'), 'changed');
  await assert.rejects(f.tool.execute(prepared, context), code('VERIFICATION_SOURCE_STALE')); assert.equal(f.plans.get('session', f.run.id)!.receipts.length, 0); assert.equal(await exists(join(f.root, 'effect.txt')), false);
});

test('actual command changing selected source is stale while its successful exit and original output remain available', async t => {
  const f = await fixture(t, { source: "require('fs').writeFileSync('source.txt','changed by check');process.stdout.write('exit zero')" }), context = f.context();
  const result = await f.tool.execute(await f.tool.prepare({ checkId: 'tests' }, context), context), receipt = f.lastReceipt();
  assert.equal(receipt.status, 'stale'); assert.equal(receipt.sourceStale, true); assert.equal(receipt.observation!.exitCode, 0); assert.equal(result.isError, true); assert.match(result.content, /exit zero/u);
  assert.equal(JSON.parse(result.content.split('\n')[0]!).verification.status, 'stale');
});

test('actual nonzero exit is a model-visible failing receipt without dropping original diagnostics', async t => {
  const f = await fixture(t, { source: "process.stderr.write('real failing assertion');process.exit(7)" }), context = f.context();
  const result = await f.tool.execute(await f.tool.prepare({ checkId: 'tests' }, context), context);
  assert.equal(f.lastReceipt().status, 'fail'); assert.equal(f.lastReceipt().observation!.exitCode, 7); assert.equal(JSON.parse(result.content.split('\n')[0]!).verification.status, 'fail'); assert.match(result.content, /real failing assertion/u);
});

test('one call executes one planned check and check order is validated before displaying approval', async t => {
  const f = await fixture(t, { checks: ['first', 'second'] });
  await assert.rejects(f.tool.prepare({ checkId: 'second' }, f.context('out-of-order')), code('VERIFICATION_CHECK_ORDER'));
  const first = f.context('first'); await f.tool.execute(await f.tool.prepare({ checkId: 'first' }, first), first); assert.equal(await readFile(join(f.root, 'effect.txt'), 'utf8'), 'once\n');
  const second = f.context('second'); await f.tool.execute(await f.tool.prepare({ checkId: 'second' }, second), second); assert.equal(await readFile(join(f.root, 'effect.txt'), 'utf8'), 'once\nonce\n');
  assert.deepEqual(f.plans.get('session', f.run.id)!.receipts.map(value => value.checkId), ['first', 'second']);
});

test('registered command timeout is bounded and is observed as timeout with real process cleanup', async t => {
  const f = await fixture(t, { timeoutMs: 120, source: "process.stdout.write('started timeout');setInterval(()=>{},1000)" }), context = f.context();
  const prepared = await f.tool.prepare({ checkId: 'tests' }, context); assert.equal(prepared.preview.timeoutMs, 120);
  const result = await f.tool.execute(prepared, context), receipt = f.lastReceipt();
  assert.equal(receipt.status, 'timeout'); assert.equal(receipt.observation!.timedOut, true); assert.equal(receipt.observation!.cleanup.confirmed, true); assert.equal(result.isError, true); assert.match(result.content, /started timeout/u);
});

test('cancel preserves actual outcome and observes source after using an independent bounded signal', async t => {
  const f = await fixture(t, { source: "require('fs').writeFileSync('started','yes');process.stdout.write('started cancel');setInterval(()=>{},1000)" }), abort = new AbortController(), context = f.context('cancel', abort.signal);
  const prepared = await f.tool.prepare({ checkId: 'tests' }, context), running = f.tool.execute(prepared, context);
  for (let i = 0; i < 100 && !await exists(join(f.root, 'started')); i++) await new Promise(done => setTimeout(done, 10));
  assert.equal(await exists(join(f.root, 'started')), true); abort.abort();
  const result = await running, receipt = f.lastReceipt(); assert.equal(receipt.status, 'cancelled'); assert.equal(receipt.observation!.cancelled, true); assert.equal(receipt.observation!.cleanup.confirmed, true); assert.notEqual(receipt.observation!.sourceAfter, null); assert.match(result.content, /started cancel/u);
});

test('actual checkpoint publication failure produces uncertain identity without replaying an observed process effect', async t => {
  const f = await fixture(t), context = f.context(); context.recordCheckpoint = () => { throw new Error('primary DB unavailable'); };
  const prepared = await f.tool.prepare({ checkId: 'tests' }, context);
  await assert.rejects(f.tool.execute(prepared, context), code('CLEANUP_UNCERTAIN')); const receipt = f.lastReceipt();
  assert.equal(receipt.status, 'uncertain'); assert.equal(receipt.observation, null); assert.equal(receipt.recovery, 'producer-without-outcome'); assert.equal(await readFile(join(f.root, 'effect.txt'), 'utf8'), 'once\n');
  await assert.rejects(f.tool.execute(prepared, context), code('INVALID_PREPARED_TOOL')); assert.equal(await readFile(join(f.root, 'effect.txt'), 'utf8'), 'once\n');
});

test('physical log settlement failure preserves exit and cleanup but cannot publish a passing receipt', async t => {
  const f = await fixture(t), context = f.context(); f.host.artifacts = () => { throw new Error('artifact unavailable'); };
  const result = await f.tool.execute(await f.tool.prepare({ checkId: 'tests' }, context), context), receipt = f.lastReceipt();
  assert.equal(receipt.status, 'uncertain'); assert.equal(receipt.observation!.exitCode, 0); assert.equal(receipt.observation!.cleanup.confirmed, true); assert.equal(receipt.observation!.executionComplete, false); assert.equal((result.data as { effectsUncertain: boolean }).effectsUncertain, true); assert.match(result.content, /original output/u);
});

test('arbitrary error.details never becomes execution proof and producer outcome loss is uncertain', async t => {
  let touches = 0;
  const f = await fixture(t, { wrapCommand: core => ({ ...core, async execute(prepared, context) { await core.execute(prepared, context); const error = new EngineError('FAKE_TERMINAL', 'fake'); Object.defineProperty(error, 'details', { get() { touches++; return { exitCode: 0, cleanupConfirmed: true }; } }); throw error; } }) });
  const context = f.context(); await assert.rejects(f.tool.execute(await f.tool.prepare({ checkId: 'tests' }, context), context), code('CLEANUP_UNCERTAIN'));
  assert.equal(touches, 0); assert.equal(f.lastReceipt().status, 'uncertain'); assert.equal(f.lastReceipt().observation, null); assert.equal(await readFile(join(f.root, 'effect.txt'), 'utf8'), 'once\n');
});

test('late observed result cannot mutate a terminal Run, leaving durable pending identity for explicit recovery', async t => {
  const f = await fixture(t), context = f.context(), publish = context.recordCheckpoint;
  context.recordCheckpoint = checkpoint => { publish(checkpoint); f.store.commit(f.run.id, 'run.completed', {}, { run: { state: 'completed' } }); };
  const result = await f.tool.execute(await f.tool.prepare({ checkId: 'tests' }, context), context), state = f.plans.get('session', f.run.id)!;
  assert.equal(state.receipts[0]!.phase, 'dispatched'); assert.equal(state.receipts[0]!.status, null); assert.equal((result.data as { exitCode: number }).exitCode, 0); assert.equal((result.data as { verification: { persistence: string } }).verification.persistence, 'pending');
  f.receipts.recoverPending('session', f.run.id, state.revision); assert.equal(f.lastReceipt().status, 'uncertain'); assert.equal(await readFile(join(f.root, 'effect.txt'), 'utf8'), 'once\n');
});

test('bounded source-after failure yields uncertain without discarding successful owned command output', async t => {
  const f = await fixture(t), context = f.context(); const observe = f.host.sourceObservation; let calls = 0;
  f.host.sourceObservation = (ctx, signal) => ++calls === 4 ? new Promise(() => {}) : observe(ctx, signal);
  const result = await f.tool.execute(await f.tool.prepare({ checkId: 'tests' }, context), context);
  assert.equal(f.lastReceipt().status, 'uncertain'); assert.equal(f.lastReceipt().observation!.sourceAfter, null); assert.equal(f.lastReceipt().observation!.exitCode, 0); assert.match(result.content, /original output/u);
});

test('current command denial, changed profile and changed host registration prevent preparation or execution', async t => {
  const policy = new ToolPolicy([{ tool: 'run_command', decision: 'deny' }]), f = await fixture(t, { runtimeOptions: { policy } });
  await assert.rejects(f.tool.prepare({ checkId: 'tests' }, f.context()), code('VERIFICATION_PROFILE_DENIED')); assert.equal(await exists(join(f.root, 'effect.txt')), false);
  const second = await fixture(t), context = second.context(), prepared = await second.tool.prepare({ checkId: 'tests' }, context);
  second.host.captureCatalogue = () => second.runtime.catalogue('engine', 'build', ['verify_changes'], { id: 'builder', revision: 'profile-2' });
  await assert.rejects(second.tool.execute(prepared, context), code('VERIFICATION_PROFILE_DENIED'));
  const third = await fixture(t), ctx = third.context(), captured = await third.tool.prepare({ checkId: 'tests' }, ctx); third.removers[0]!();
  await assert.rejects(third.tool.execute(captured, ctx), code('VERIFICATION_CHECK_STALE')); assert.equal(await exists(join(third.root, 'effect.txt')), false);
});

test('exact physical cwd replacement with an out-of-workspace symlink invalidates approval', async t => {
  const f = await fixture(t), subdir = join(f.root, 'subdir'); await mkdir(subdir); f.removers[0]!(); f.registry.register({ ...f.checks[0]!, cwd: subdir, revision: 2 });
  f.plans.create('session', f.run.id, f.plans.get('session', f.run.id)!.revision, { checkIds: ['tests'], source: await f.source() });
  const context = f.context(), prepared = await f.tool.prepare({ checkId: 'tests' }, context); await rm(subdir, { recursive: true }); await symlink(f.base, subdir);
  await assert.rejects(f.tool.execute(prepared, context), code('VERIFICATION_CWD_STALE')); assert.equal(f.plans.get('session', f.run.id)!.receipts.length, 0);
});

test('original command role ask and host preflight receipt survive the outer exact approval preview', async t => {
  const preflight = new CommandPreflightRegistry();
  preflight.register({ id: 'command-check', revision: 1, sourceSha256: sha('host-analyzer'), async analyze() { return { decision: 'ask', findings: [{ code: 'review', decision: 'ask', summary: 'Exact command review required' }] }; } });
  const roles = new RoleResourcePolicy({ revision: 1, rules: [] });
  const f = await fixture(t, { runtimeOptions: { roleResources: roles, resolveRoleResources: () => [{ kind: 'unknown', label: 'command scope' }], commandPreflight: { registry: preflight, selectAnalyzer: observed => observed.prepared.name === 'run_command' ? 'command-check' : undefined, resolveSourceRevision: () => 'actual-source' } } });
  const context = f.context(), prepared = await f.tool.prepare({ checkId: 'tests' }, context);
  assert.equal((prepared.preview.commandPreflight as { decision: string }).decision, 'ask'); assert.equal((prepared.preview.roleResourceDecision as { decision: string }).decision, 'ask'); assert.equal(prepared.requiresApproval, true);
  const result = await f.tool.execute(prepared, context); assert.equal((result.data as { verification: { status: string } }).verification.status, 'pass');
});

test('changed host preflight source rejects before durable intent and a fresh exact approval is required', async t => {
  const preflight = new CommandPreflightRegistry(); let observedSource = 'physical-source-1';
  preflight.register({ id: 'command-check', revision: 1, sourceSha256: sha('host-analyzer'), async analyze() { return { decision: 'ask', findings: [] }; } });
  const f = await fixture(t, { runtimeOptions: { commandPreflight: { registry: preflight, selectAnalyzer: observed => observed.prepared.name === 'run_command' ? 'command-check' : undefined, resolveSourceRevision: () => observedSource } } });
  const context = f.context(), prepared = await f.outer().prepare({ checkId: 'tests' }, context); observedSource = 'physical-source-2';
  await assert.rejects(f.runtime.executeApproved(prepared, context, f.approve()), code('COMMAND_PREFLIGHT_STALE'));
  assert.equal(f.plans.get('session', f.run.id)!.receipts.length, 0); assert.equal(await exists(join(f.root, 'effect.txt')), false);
  const next = f.context('fresh-call'), fresh = await f.outer().prepare({ checkId: 'tests' }, next); assert.notEqual(fresh.fingerprint, prepared.fingerprint);
  await f.runtime.executeApproved(fresh, next, f.approve()); assert.equal(f.approvals.length, 2); assert.equal(f.lastReceipt().status, 'pass'); assert.equal(await readFile(join(f.root, 'effect.txt'), 'utf8'), 'once\n');
});

test('exact command resource denial and plan-mode ownership cannot be bypassed by the verification tool name', async t => {
  const f = await fixture(t); f.runtime.policy.replace([{ tool: 'run_command', resource: `command:${f.checks[0]!.command}`, decision: 'deny' }]);
  await assert.rejects(f.tool.prepare({ checkId: 'tests' }, f.context()), code('TOOL_POLICY_DENIED')); assert.equal(f.plans.get('session', f.run.id)!.receipts.length, 0);
  const plan = await fixture(t, { mode: 'plan' }); await assert.rejects(plan.tool.prepare({ checkId: 'tests' }, plan.context()), code('PLAN_MODE_WRITE_BLOCKED')); assert.equal(await exists(join(plan.root, 'effect.txt')), false);
});

test('owned cleanup-uncertain fault remains uncertain even when the physical command returned exit zero', async t => {
  const f = await fixture(t, { wrapCommand: core => ({ ...core, async execute(prepared, context) { const result = await core.execute(prepared, context); return { ...result, isError: true, data: { ...(result.data as object), cleanupConfirmed: false } }; } }) }), context = f.context();
  const result = await f.tool.execute(await f.tool.prepare({ checkId: 'tests' }, context), context), receipt = f.lastReceipt();
  assert.equal(receipt.status, 'uncertain'); assert.equal(receipt.observation!.cleanup.confirmed, false); assert.equal(receipt.observation!.exitCode, 0); assert.equal((result.data as { cleanupConfirmed: boolean }).cleanupConfirmed, false); assert.equal(await readFile(join(f.root, 'effect.txt'), 'utf8'), 'once\n');
});

test('check output bound narrows nested command without consuming a second Run tool budget', async t => {
  const f = await fixture(t, { outputBytes: 300, source: "process.stdout.write('x'.repeat(3000))" }), context = f.context();
  const result = await f.tool.execute(await f.tool.prepare({ checkId: 'tests' }, context), context), receipt = f.lastReceipt();
  assert.ok(Buffer.byteLength(result.content) <= 300); assert.equal(receipt.observation!.observedOutputBytes, 3000); assert.equal(receipt.observation!.outputAccountingComplete, true);
  const original = await f.artifacts.read(receipt.observation!.artifactRefs[0]!.id); assert.equal(original.reference.storedBytes, 3000); assert.equal(original.reference.complete, true);
  assert.equal(f.store.getRun(f.run.id).config.limits.maxOutputBytes, DEFAULT_LIMITS.maxOutputBytes);
});
