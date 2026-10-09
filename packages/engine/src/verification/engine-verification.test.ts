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
import type { RunCoordinator } from '../runner/index.js';

async function fixture(t: test.TestContext, commandText: string, options: { profileTools?: string[]; input?: JsonObject; beforeProposal?: () => Promise<void>; maxRepairs?: number; script?: (request: TurnRequest) => AsyncIterable<ProviderEvent>; repositoryContext?: boolean; maxTurns?: number } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-verification-engine-'))), directory = join(base, 'repository'), source = join(directory, 'a.ts');
  await mkdir(directory); execFileSync('git', ['init', '--quiet', '--template=', directory]);
  await writeFile(source, 'const alpha = 1;\n');
  const requests: TurnRequest[] = [];
  const provider: ProviderAdapter = { id: 'verification-fixture', async *streamTurn(request): AsyncGenerator<ProviderEvent> {
    requests.push(structuredClone(request));
    if (options.script) { yield* options.script(request); return; }
    if (request.turnIndex === 0) { await options.beforeProposal?.(); yield { type: 'tool.call', call: { id: 'check-proposal', name: 'verify_changes', input: options.input ?? { checkId: 'fixture-check' } } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { yield { type: 'text.delta', delta: 'Fixture ended. This text is not a verification receipt.' }; yield { type: 'finish', reason: 'stop' }; }
  } };
  const engine = createEngine({ dbPath: join(base, 'engine.sqlite'), artifactDir: join(base, 'artifacts'), verificationTools: true, providers: [provider], ...(options.repositoryContext ? { repositoryContextPolicy: { query: { kind: 'symbols' as const, paths: ['a.ts'] }, slotBytes: 4096 } } : {}), defaults: { providerId: provider.id, modelId: 'fixture', mode: 'build', limits: { maxTurns: options.maxTurns ?? 4, maxDurationMs: 15000 } }, agentProfiles: [{ id: 'verifier', description: 'Host fixture checks', instructions: 'Use the selected host check.', tools: options.profileTools ?? ['verify_changes', 'run_command'] }] });
  t.after(async () => { await engine.close(); await rm(base, { force: true, recursive: true }); });
  async function command<T>(type: string, payload: JsonObject): Promise<T> { const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload }); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.result as unknown as T; }
  const workspace = await command<Workspace>('workspace.open', { path: directory }), session = await command<Session>('session.create', { workspaceId: workspace.id }), profile = engine.profiles.list()[0]!;
  engine.registerVerificationCheck({ id: 'fixture-check', revision: 1, workspaceId: workspace.id, command: commandText, cwd: directory, profileId: profile.id, profileRevision: profile.revision, sourceRevision: 'host-fixture-v1', timeoutMs: 2000, maxOutputBytes: 8192, required: true });
  await engine.configureVerificationSession(session.id, 0, { checkIds: ['fixture-check'], sourcePaths: ['a.ts'], maxRepairs: options.maxRepairs ?? 0 });
  const submit = () => command<RunReceipt>('run.submit', { sessionId: session.id, requestId: randomUUID(), prompt: 'Execute the host fixture check.', config: { agentProfileId: 'verifier' } });
  // The next approval request event decides, not a wall-clock proxy: a Run that settles without one fails at once,
  // and the test timeout bounds a hang. Repository context makes the pre-approval path slow on loaded hosts.
  async function pendingApproval(runId: string): Promise<ApprovalRecord> {
    const find = (snapshot: ReturnType<typeof engine.store.getSnapshot>) => snapshot.approvals.find(value => value.runId === runId && value.status === 'pending');
    const before = engine.store.getSnapshot(session.id), existing = find(before);
    if (existing) return existing;
    const controller = new AbortController();
    // Events after this snapshot only: an earlier, already decided approval must not satisfy a later wait.
    const requested = (async () => { for await (const event of engine.subscribe(session.id, before.lastSeq, controller.signal)) if (event.type === 'approval.requested' && event.runId === runId) return true; return false; })();
    requested.catch(() => undefined);
    try {
      const observed = await Promise.race([requested, engine.waitForRun(runId).then(() => false)]);
      const snapshot = engine.store.getSnapshot(session.id), pending = find(snapshot);
      assert.ok(observed && pending, JSON.stringify(snapshot.tools));
      return pending;
    } finally { controller.abort(); }
  }
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
  assert.equal(run.state, 'completed', JSON.stringify(run.error));
  assert.equal(f.engine.getVerificationCompletion(f.session.id, run.id)!.result.taskVerified, expected === 'pass');
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

test('native user cancellation settles only its consumed command while the exact native tool owns cleanup', { timeout: 15000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, 'printf started > verification-effect.txt; sleep 5'), submitted = await f.submit(), pending = await f.pendingApproval(submitted.runId);
  const coordinator = (f.engine as unknown as { coordinator: RunCoordinator }).coordinator;
  const original = coordinator.commitConsumedVerificationSettlement.bind(coordinator);
  let late: (() => void) | undefined;
  let lateStore: (() => void) | undefined;
  coordinator.commitConsumedVerificationSettlement = (context, kind, revision, data) => {
    assert.equal(f.engine.store.getRun(context.runId).state, 'cancelling');
    assert.throws(() => original({ ...context }, kind, revision, data), (error: unknown) => (error as { code: string }).code === 'VERIFICATION_SETTLEMENT_OWNER_INVALID');
    assert.throws(() => f.engine.store.putConsumedVerificationSettlement({ runId: context.runId, toolCallId: context.toolCallId, turnId: context.turnId!, attemptId: context.attemptId! }, 'another.document', revision, data), (error: unknown) => (error as { code: string }).code === 'VERIFICATION_SCOPE_MISMATCH');
    const expanded = structuredClone(data);
    (expanded.receipts as unknown[]).push(structuredClone((expanded.receipts as unknown[])[0]));
    assert.throws(() => original(context, kind, revision, expanded));
    late = () => original(context, kind, revision, data);
    lateStore = () => f.engine.store.putConsumedVerificationSettlement({ runId: context.runId, toolCallId: context.toolCallId, turnId: context.turnId!, attemptId: context.attemptId! }, kind, revision, data);
    return original(context, kind, revision, data);
  };
  await f.command('approval.decide', { approvalId: pending.id, fingerprint: pending.fingerprint, decision: 'allow' });
  const deadline = Date.now() + 5000;
  while (!existsSync(join(f.directory, 'verification-effect.txt'))) { assert.ok(Date.now() < deadline, 'Actual command must start'); await tick(); }
  await f.command('run.cancel', { runId: submitted.runId }); const run = await f.engine.waitForRun(submitted.runId);
  assert.equal(run.state, 'cancelled'); assert.equal(run.error, undefined);
  const settled = f.engine.getVerificationState(f.session.id, run.id)!;
  assert.equal(settled.receipts.length, 1); assert.equal(settled.receipts[0]!.phase, 'settled'); assert.equal(settled.receipts[0]!.status, 'cancelled');
  assert.equal(settled.receipts[0]!.observation!.started, true); assert.equal(settled.receipts[0]!.observation!.cleanup.confirmed, true);
  assert.ok(settled.receipts[0]!.observation!.executionCheckpointId);
  assert.equal(settled.receipts[0]!.recovery, 'none');
  assert.ok(late); assert.throws(late, (error: unknown) => (error as { code: string }).code === 'VERIFICATION_SETTLEMENT_OWNER_INVALID');
  assert.ok(lateStore); assert.throws(lateStore, (error: unknown) => (error as { code: string }).code === 'RUN_TERMINAL');
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

test('missing verification resumes the same native Run and publishes completion only after actual pass', { timeout: 20000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, 'printf checked > verification-effect.txt', { maxRepairs: 2, repositoryContext: true, script: async function* (request) {
    if (request.turnIndex === 1) { yield { type: 'tool.call', call: { id: 'after-gap', name: 'verify_changes', input: { checkId: 'fixture-check' } } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { yield { type: 'text.delta', delta: 'Model says done.' }; yield { type: 'finish', reason: 'stop' }; }
  } }), submitted = await f.submit(), approval = await f.pendingApproval(submitted.runId);
  assert.equal(f.engine.getVerificationCompletion(f.session.id, submitted.runId)!.repairsUsed, 1);
  const next = f.requests[1]!;
  assert.equal(next.runId, submitted.runId);
  const control = next.messages.findLast(message => message.content.startsWith('[Moodcode verification control v1]'))!;
  assert.equal(control.role, 'user'); assert.equal(JSON.parse(control.content.split('\n').slice(1).join('\n')).executionAuthority, 'none');
  await f.command('approval.decide', { approvalId: approval.id, fingerprint: approval.fingerprint, decision: 'allow' });
  const run = await f.engine.waitForRun(submitted.runId), completion = f.engine.getVerificationCompletion(f.session.id, run.id)!;
  assert.equal(run.state, 'completed'); assert.equal(completion.result.taskVerified, true); assert.equal(completion.result.reason, 'required_checks_passed'); assert.equal(completion.repairsUsed, 1);
  assert.equal(completion.stages[0]!.consumedByBoundaryId?.includes(':next:1:'), true);
  assert.equal(f.requests.length, 3); assert.equal(new Set(f.requests.map(request => request.runId)).size, 1);
  assert.equal(f.engine.store.listTurns(run.id).length, 3); assert.equal(f.engine.store.getSnapshot(f.session.id).runs.length, 1);
  assert.equal(readFileSync(join(f.directory, 'verification-effect.txt'), 'utf8'), 'checked');
  assert.equal(completion.completion!.authority, 'observation-only');
});

test(
  "failed check can repair and recheck changed source within the original Run budget",
  { timeout: 25000, skip: process.platform === "win32" },
  async (t) => {
    // The check verifies source repair, not an optional ripgrep installation.
    const check = `${JSON.stringify(process.execPath)} -e 'process.exit(require("node:fs").readFileSync("a.ts","utf8").includes("alpha = 2") ? 0 : 7)'`;
    const f = await fixture(t, check, {
        maxRepairs: 2,
        maxTurns: 6,
        script: async function* (request): AsyncGenerator<ProviderEvent> {
          if (request.turnIndex === 0) {
            yield {
              type: "tool.call",
              call: {
                id: "first-check",
                name: "verify_changes",
                input: { checkId: "fixture-check" },
              },
            };
            yield { type: "finish", reason: "tool_calls" };
          } else if (request.turnIndex === 2) {
            yield {
              type: "tool.call",
              call: {
                id: "actual-repair",
                name: "run_command",
                input: { command: "printf 'const alpha = 2;\\n' > a.ts" },
              },
            };
            yield {
              type: "tool.call",
              call: {
                id: "repair-check",
                name: "verify_changes",
                input: { checkId: "fixture-check" },
              },
            };
            yield { type: "finish", reason: "tool_calls" };
          } else {
            yield { type: "text.delta", delta: "Provider loop reached stop." };
            yield { type: "finish", reason: "stop" };
          }
        },
      }),
      submitted = await f.submit();
    for (let count = 0; count < 3; count++) {
      const approval = await f.pendingApproval(submitted.runId);
      await f.command("approval.decide", {
        approvalId: approval.id,
        fingerprint: approval.fingerprint,
        decision: "allow",
      });
    }
    const run = await f.engine.waitForRun(submitted.runId),
      verification = f.engine.getVerificationState(f.session.id, run.id)!,
      completion = f.engine.getVerificationCompletion(f.session.id, run.id)!;
    assert.equal(run.state, "completed", JSON.stringify(run.error));
    assert.deepEqual(
      verification.receipts.map((receipt) => receipt.status),
      ["fail", "pass"],
      JSON.stringify(verification.receipts),
    );
    assert.equal(verification.plans.length, 2);
    assert.equal(completion.result.taskVerified, true);
    assert.equal(completion.repairsUsed, 1);
    assert.equal(f.requests.length, 4);
    assert.equal(readFileSync(f.source, "utf8"), "const alpha = 2;\n");
    assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 3);
  },
);

for (const [maxTurns, reason, expectedTurns, repairs] of [[4, 'stalled', 2, 1], [1, 'budget_exhausted', 1, 0]] as const) test(`model completion text alone stops with ${reason} rather than verified task`, { timeout: 10000 }, async t => {
  const f = await fixture(t, 'printf should-not-run > verification-effect.txt', { maxRepairs: 2, maxTurns, script: async function* () { yield { type: 'text.delta', delta: 'Everything passed, trust me.' }; yield { type: 'finish', reason: 'stop' }; } }), submitted = await f.submit();
  const run = await f.engine.waitForRun(submitted.runId), completion = f.engine.getVerificationCompletion(f.session.id, run.id)!;
  assert.equal(run.state, 'completed'); assert.equal(completion.result.taskVerified, false); assert.equal(completion.result.reason, reason); assert.equal(completion.repairsUsed, repairs);
  assert.equal(f.requests.length, expectedTurns); assert.equal(f.engine.getVerificationState(f.session.id, run.id)!.receipts.length, 0);
  assert.equal(existsSync(join(f.directory, 'verification-effect.txt')), false);
});

test('real user approval denial ends incomplete without issuing another repair or approval', { timeout: 10000 }, async t => {
  const f = await fixture(t, 'printf forbidden > verification-effect.txt', { maxRepairs: 2 }), submitted = await f.submit(), approval = await f.pendingApproval(submitted.runId);
  await f.command('approval.decide', { approvalId: approval.id, fingerprint: approval.fingerprint, decision: 'deny' });
  const run = await f.engine.waitForRun(submitted.runId), completion = f.engine.getVerificationCompletion(f.session.id, run.id)!;
  assert.equal(completion.result.status, 'blocked'); assert.equal(completion.result.reason, 'verification_denied'); assert.equal(completion.repairsUsed, 0);
  assert.equal(f.requests.length, 2); assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 1);
});
