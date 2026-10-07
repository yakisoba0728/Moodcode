import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import type { ApprovalRecord, JsonObject, RunReceipt, Session, Workspace } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';

async function fixture(t: test.TestContext, commandText: string, options: { profileTools?: string[]; input?: JsonObject; beforeProposal?: () => Promise<void> } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-verification-engine-'))), directory = join(base, 'repository'), source = join(directory, 'a.ts');
  await mkdir(directory); execFileSync('git', ['init', '--quiet', '--template=', directory]);
  await writeFile(source, 'const alpha = 1;\n');
  const requests: TurnRequest[] = [];
  const provider: ProviderAdapter = { id: 'verification-fixture', async *streamTurn(request): AsyncGenerator<ProviderEvent> {
    requests.push(structuredClone(request));
    if (request.turnIndex === 0) { await options.beforeProposal?.(); yield { type: 'tool.call', call: { id: 'check-proposal', name: 'verify_changes', input: options.input ?? { checkId: 'fixture-check' } } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { yield { type: 'text.delta', delta: 'Fixture ended. This text is not a verification receipt.' }; yield { type: 'finish', reason: 'stop' }; }
  } };
  const engine = createEngine({ dbPath: join(base, 'engine.sqlite'), artifactDir: join(base, 'artifacts'), verificationTools: true, providers: [provider], defaults: { providerId: provider.id, modelId: 'fixture', mode: 'build', limits: { maxTurns: 4, maxDurationMs: 15000 } }, agentProfiles: [{ id: 'verifier', description: 'Host fixture checks', instructions: 'Use the selected host check.', tools: options.profileTools ?? ['verify_changes', 'run_command'] }] });
  t.after(async () => { await engine.close(); await rm(base, { force: true, recursive: true }); });
  async function command<T>(type: string, payload: JsonObject): Promise<T> { const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload }); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.result as unknown as T; }
  const workspace = await command<Workspace>('workspace.open', { path: directory }), session = await command<Session>('session.create', { workspaceId: workspace.id }), profile = engine.profiles.list()[0]!;
  engine.registerVerificationCheck({ id: 'fixture-check', revision: 1, workspaceId: workspace.id, command: commandText, cwd: directory, profileId: profile.id, profileRevision: profile.revision, sourceRevision: 'host-fixture-v1', timeoutMs: 2000, maxOutputBytes: 8192, required: true });
  await engine.configureVerificationSession(session.id, 0, { checkIds: ['fixture-check'], sourcePaths: ['a.ts'], maxRepairs: 1 });
  const submit = () => command<RunReceipt>('run.submit', { sessionId: session.id, requestId: randomUUID(), prompt: 'Execute the host fixture check.', config: { agentProfileId: 'verifier' } });
  async function pendingApproval(runId: string): Promise<ApprovalRecord> { const deadline = Date.now() + 5000; for (;;) { const snapshot = engine.store.getSnapshot(session.id), pending = snapshot.approvals.find(value => value.runId === runId && value.status === 'pending'); if (pending) return pending; assert.ok(Date.now() < deadline, JSON.stringify(snapshot.tools)); await tick(); } }
  return { directory, source, engine, session, workspace, requests, command, submit, pendingApproval };
}

for (const [commandText, expected] of [
  ['printf verified > verification-effect.txt; printf output', 'pass'],
  ['printf verified > verification-effect.txt; exit 7', 'fail'],
  ["printf 'const alpha = 2;\\n' > a.ts; printf verified > verification-effect.txt", 'stale'],
] as const) test(`actual verify_changes publishes ${expected} from the exact approved command`, { timeout: 20000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, commandText), submitted = await f.submit(), pending = await f.pendingApproval(submitted.runId);
  assert.equal(existsSync(join(f.directory, 'verification-effect.txt')), false);
  assert.equal(pending.preview.command, commandText);
  await f.command('approval.decide', { approvalId: pending.id, fingerprint: pending.fingerprint, decision: 'allow' });
  const run = await f.engine.waitForRun(submitted.runId), snapshot = f.engine.store.getSnapshot(f.session.id), tool = snapshot.tools.find(value => value.name === 'verify_changes')!;
  assert.equal(tool.state, expected === 'pass' ? 'completed' : 'failed', JSON.stringify({ error: tool.error, output: tool.output, run }));
  assert.equal(readFileSync(join(f.directory, 'verification-effect.txt'), 'utf8'), 'verified');
  const state = f.engine.getVerificationState(f.session.id, run.id)!;
  assert.equal(state.receipts.length, 1); assert.equal(state.receipts[0]!.status, expected);
  const observation = state.receipts[0]!.observation!;
  assert.equal(observation.command, commandText); assert.equal(observation.cwd, f.directory); assert.equal(observation.toolCallId, tool.id);
  assert.equal(observation.cleanup.confirmed, true); assert.equal(observation.cleanup.scope, 'posix-process-group'); assert.match(observation.cleanup.evidenceSha256!, /^[a-f0-9]{64}$/);
  assert.ok(observation.executionCheckpointId); assert.ok(f.engine.store.listCheckpoints(run.id).some(value => value.id === observation.executionCheckpointId && value.toolCallId === tool.id));
  assert.equal(snapshot.approvals.length, 1); assert.equal(snapshot.tools.filter(value => value.name === 'run_command').length, 0);
  assert.equal(f.requests.length, 2); assert.ok(f.requests[1]!.messages.findLast(value => value.role === 'tool')?.content.includes(expected));
  state.receipts[0]!.status = 'uncertain'; assert.equal(f.engine.getVerificationState(f.session.id, run.id)!.receipts[0]!.status, expected);
});

for (const decision of ['deny', 'source-stale'] as const) test(`verification ${decision} consumes no command effect`, { timeout: 15000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, 'printf verified > verification-effect.txt'), submitted = await f.submit(), pending = await f.pendingApproval(submitted.runId);
  if (decision === 'source-stale') await writeFile(f.source, 'const alpha = 9;\n');
  await f.command('approval.decide', { approvalId: pending.id, fingerprint: pending.fingerprint, decision: decision === 'deny' ? 'deny' : 'allow' });
  await f.engine.waitForRun(submitted.runId);
  assert.equal(existsSync(join(f.directory, 'verification-effect.txt')), false);
  assert.equal(f.engine.getVerificationState(f.session.id, submitted.runId)!.receipts.length, 0);
  const call = f.engine.store.getSnapshot(f.session.id).tools.find(value => value.name === 'verify_changes')!;
  assert.equal(call.state, decision === 'deny' ? 'denied' : 'failed');
});

test('verification cannot use a run_command omitted by the persisted profile', { timeout: 10000 }, async t => {
  const f = await fixture(t, 'printf forbidden > verification-effect.txt', { profileTools: ['verify_changes'] }), submitted = await f.submit();
  await f.engine.waitForRun(submitted.runId);
  assert.equal(existsSync(join(f.directory, 'verification-effect.txt')), false);
  assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 0);
  assert.equal(f.engine.store.getSnapshot(f.session.id).tools[0]!.state, 'failed');
});

test('model command overrides never replace the host registered check', { timeout: 10000 }, async t => {
  const f = await fixture(t, 'printf registered > verification-effect.txt', { input: { checkId: 'fixture-check', command: 'printf override > verification-effect.txt' } }), submitted = await f.submit();
  await f.engine.waitForRun(submitted.runId);
  assert.equal(existsSync(join(f.directory, 'verification-effect.txt')), false); assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 0);
});

test('host verification configuration CAS remains idle-only during exact approval', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'printf verified > verification-effect.txt'), submitted = await f.submit(), pending = await f.pendingApproval(submitted.runId);
  await assert.rejects(f.engine.configureVerificationSession(f.session.id, 1, { checkIds: ['fixture-check'], sourcePaths: ['a.ts'], maxRepairs: 0 }), (error: unknown) => (error as { code: string }).code === 'WORKSPACE_BUSY');
  assert.equal(f.engine.getVerificationConfiguration(f.session.id)!.revision, 1);
  await f.command('approval.decide', { approvalId: pending.id, fingerprint: pending.fingerprint, decision: 'deny' }); await f.engine.waitForRun(submitted.runId);
});

test('first physical verification plan captures changes made before the model proposes its check', { timeout: 15000, skip: process.platform === 'win32' }, async t => {
  let source = '';
  const f = await fixture(t, 'printf verified > verification-effect.txt', { beforeProposal: async () => { await writeFile(source, 'const alpha = 3;\n'); } }); source = f.source;
  const submitted = await f.submit(), pending = await f.pendingApproval(submitted.runId);
  await f.command('approval.decide', { approvalId: pending.id, fingerprint: pending.fingerprint, decision: 'allow' }); await f.engine.waitForRun(submitted.runId);
  const state = f.engine.getVerificationState(f.session.id, submitted.runId)!;
  assert.equal(state.plans.length, 1); assert.equal(state.receipts[0]!.status, 'pass');
});

test('native user cancellation preserves consumed verification intent for explicit uncertainty recovery', { timeout: 15000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, 'printf started > verification-effect.txt; sleep 5'), submitted = await f.submit(), pending = await f.pendingApproval(submitted.runId);
  await f.command('approval.decide', { approvalId: pending.id, fingerprint: pending.fingerprint, decision: 'allow' });
  const deadline = Date.now() + 5000;
  while (!existsSync(join(f.directory, 'verification-effect.txt'))) { assert.ok(Date.now() < deadline, 'Actual command must start'); await tick(); }
  await f.command('run.cancel', { runId: submitted.runId }); const run = await f.engine.waitForRun(submitted.runId);
  assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN');
  const pendingState = f.engine.getVerificationState(f.session.id, run.id)!;
  assert.equal(pendingState.receipts.length, 1); assert.equal(pendingState.receipts[0]!.phase, 'dispatched'); assert.equal(pendingState.receipts[0]!.status, null);
  const recovered = f.engine.verificationReceipts.recoverPending(f.session.id, run.id, pendingState.revision);
  assert.equal(recovered.receipts[0]!.status, 'uncertain'); assert.equal(recovered.receipts[0]!.observation, null);
  assert.equal(readFileSync(join(f.directory, 'verification-effect.txt'), 'utf8'), 'started');
});

test('default core catalogue and host verification opt-in remain explicit', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-verification-default-'))), engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts') });
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(engine.getCapabilities().tools.length, 21); assert.equal(engine.getCapabilities().tools.some(value => value.name === 'verify_changes'), false);
  assert.throws(() => engine.registerVerificationCheck({} as never), (error: unknown) => (error as { code: string }).code === 'VERIFICATION_UNSUPPORTED');
  assert.throws(() => createEngine({ dbPath: join(directory, 'custom.sqlite'), verificationTools: true, tools: [] }), (error: unknown) => (error as { code: string }).code === 'INVALID_VERIFICATION_CONFIG');
  assert.equal(existsSync(join(directory, 'custom.sqlite')), false);
});
