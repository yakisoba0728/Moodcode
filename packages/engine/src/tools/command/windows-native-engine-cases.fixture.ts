import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EngineError, type ApprovalRecord, type RunConfig, type RunReceipt } from '@moodcode/contracts';
import { createEngine } from '../../engine.js';
import { jobCommand, jobFixture, jobInvoke } from '../../jobs/fixtures/job.js';
import type { OwnedCommandJobRecord } from '../../jobs/owned-command-records.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../../ports.js';
import { inspectExecutionLock } from './execution-lock.js';
import { assertGone, treeDirectory, treePids, until, windowsCommand } from './windows-native-test-helpers.fixture.js';

async function runFixture(t: TestContext, mode: string) {
  const f = await jobFixture(t, { createTerminal: false }), directory = treeDirectory(f.root);
  const calls: TurnRequest[] = [];
  const provider: ProviderAdapter = {
    id: f.config.providerId,
    async *streamTurn(request): AsyncIterable<ProviderEvent> {
      calls.push(request);
      if (calls.length === 1) {
        yield { type: 'tool.call', call: { id: 'windows-native-command', name: 'run_command',
          input: { command: windowsCommand(mode, directory), timeoutMs: 10_000 } } };
        yield { type: 'finish', reason: 'tool_calls' };
      } else yield { type: 'finish', reason: 'stop' };
    },
  };
  (Reflect.get(f.engine, 'runtimeProviders') as Map<string, ProviderAdapter>).set(provider.id, provider);
  f.engine.profiles.register({ id: 'windows-native-command-profile', description: 'Actual native Windows command',
    instructions: 'Execute only the command approved by the current native approval', tools: ['run_command'] });
  const config: RunConfig = { ...f.config, agentProfileId: 'windows-native-command-profile', mode: 'build',
    limits: { ...f.config.limits, maxTurns: 2, maxToolCalls: 1, toolTimeoutMs: 10_000, maxOutputBytes: 65_536 },
    budgets: { ...f.config.budgets!, turnAllowance: 2, maxProviderAttempts: 1 } };
  const receipt = await jobCommand<RunReceipt>(f.engine, 'run.submit', {
    sessionId: f.session.id, requestId: randomUUID(), prompt: 'Execute the actual Windows native command', config: JSON.parse(JSON.stringify(config)),
  });
  let approval: ApprovalRecord | undefined;
  await until(() => {
    const state = f.engine.store.getRun(receipt.runId).state;
    assert.ok(!['failed', 'cancelled', 'completed', 'interrupted'].includes(state), `Run ended before approval: ${state}`);
    approval = f.engine.store.getSnapshot(f.session.id).approvals.find(row => row.runId === receipt.runId && row.status === 'pending');
    return approval !== undefined;
  }, 'Actual run_command did not request native approval');
  assert.ok(approval);
  const jobs = () => jobInvoke<OwnedCommandJobRecord[]>(f.engine, 'inspectOwnedCommandJobs', f.workspace.id, f.session.id);
  return { ...f, directory, calls, receipt, approval, jobs };
}

export function registerWindowsEngineCases(register: (name: string, execute: (t: TestContext) => void | Promise<void>) => void): void {
  register('real Windows Engine denies mismatched or rejected approval before creating native effects', async t => {
    const f = await runFixture(t, 'tree-hold');
    assert.deepEqual(f.jobs(), []);
    assert.throws(() => f.engine.approvals.decide(f.approval.id, 'allow', 'mismatched-native-fingerprint'), EngineError);
    assert.equal(existsSync(join(f.directory, 'effects.log')), false);
    f.engine.approvals.decide(f.approval.id, 'deny', f.approval.fingerprint);
    await f.engine.waitForRun(f.receipt.runId);
    assert.deepEqual(f.jobs(), []);
    assert.equal(f.engine.store.getToolCall(f.approval.toolCallId).state, 'denied');
    assert.equal(existsSync(join(f.directory, 'effects.log')), false);
  });

  register('real Windows Engine approval binds Run/Turn/Attempt/Tool/Job and preserves bounded sealed output', async t => {
    const f = await runFixture(t, 'overflow');
    assert.equal(f.engine.getCapabilities().runtime.commandExecution, 'windows-job-object');
    f.engine.approvals.decide(f.approval.id, 'allow', f.approval.fingerprint);
    assert.equal((await f.engine.waitForRun(f.receipt.runId)).state, 'completed');
    const records = f.jobs();
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.state, 'completed');
    assert.equal(record.source.runId, f.receipt.runId);
    assert.equal(record.source.toolCallId, f.approval.toolCallId);
    assert.equal(record.source.approvalId, f.approval.id);
    assert.equal(record.source.approvalFingerprint, f.approval.fingerprint);
    assert.equal(f.engine.store.getTurn(record.source.turnId).runId, f.receipt.runId);
    assert.equal(f.engine.store.getAttempt(record.source.attemptId).turnId, record.source.turnId);
    assert.equal(f.engine.store.getToolCall(record.source.toolCallId).state, 'completed');
    const completion = record.completion!;
    assert.ok(completion);
    assert.equal(completion.outcome.cleanupConfirmed, true);
    assert.equal(completion.outcome.exitCode, 0);
    assert.equal(completion.stdout.observedBytes, 1_000_000);
    assert.equal(completion.stderr.observedBytes, 1_000_000);
    assert.equal(completion.stdout.artifactBytes + completion.stderr.artifactBytes, 1_048_576);
    assert.ok(completion.stdout.truncated || completion.stderr.truncated);
    for (const artifact of [completion.stdout, completion.stderr]) {
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
      assert.equal(readFileSync(artifact.path).length, artifact.artifactBytes);
    }
    assert.equal(completion.checkpoint.runId, f.receipt.runId);
    assert.equal(completion.checkpoint.toolCallId, f.approval.toolCallId);
    assert.equal(f.calls.length, 2);
  });

  register('real Windows owned-command cancellation joins its source Run and removes detached descendants', async t => {
    const f = await runFixture(t, 'tree-hold');
    f.engine.approvals.decide(f.approval.id, 'allow', f.approval.fingerprint);
    await until(() => treePids(f.directory).length === 3 && f.jobs().some(row => row.state === 'running'), 'Approved engine tree did not become running');
    const record = f.jobs()[0]!, pids = treePids(f.directory);
    await assert.rejects(async () => jobInvoke<Promise<unknown>>(f.engine, 'cancelOwnedCommandJob', {
      workspaceId: f.workspace.id, jobId: record.jobId, expectedRevision: record.revision + 1, requestId: randomUUID(),
    }), EngineError);
    const current = f.jobs()[0]!;
    await jobInvoke<Promise<unknown>>(f.engine, 'cancelOwnedCommandJob', {
      workspaceId: f.workspace.id, jobId: current.jobId, expectedRevision: current.revision, requestId: randomUUID(),
    });
    await f.engine.waitForRun(f.receipt.runId);
    const final = f.jobs()[0]!;
    assert.equal(final.state, 'cancelled');
    assert.equal(final.completion?.outcome.cleanupConfirmed, true);
    await assertGone(pids);
  });

  register('real Windows engine SIGKILL kills its native tree and restart retains unknown effects without replay', async t => {
    let owner: ReturnType<typeof fork> | undefined, ended: Promise<void> | undefined;
    t.after(async () => { if (owner && owner.exitCode === null) owner.kill('SIGKILL'); await ended; });
    const f = await jobFixture(t, { createTerminal: false, engine: { hostCommands: true } });
    await f.engine.close();
    const directory = treeDirectory(f.root), options = join(f.base, 'native-engine-crash.json');
    writeFileSync(options, JSON.stringify({ dbPath: f.dbPath, artifactDir: f.artifactDir,
      workspaceId: f.workspace.id, sessionId: f.session.id, directory }));
    owner = fork(fileURLToPath(new URL('./windows-native-engine-owner.fixture.js', import.meta.url)), [options], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [],
    });
    let diagnostics = '';
    owner.stderr?.on('data', bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-8192); });
    ended = new Promise<void>((yes, no) => { owner!.once('exit', () => yes()); owner!.once('error', no); });
    const ready = await new Promise<{ type: string; ownerPid: number; jobId: string; pids: number[] }>((yes, no) => {
      const timer = setTimeout(() => no(new Error(`Real Windows engine admission missing: ${diagnostics}`)), 10_000);
      owner!.once('message', packet => { clearTimeout(timer); yes(packet as { type: string; ownerPid: number; jobId: string; pids: number[] }); });
      owner!.once('exit', () => { clearTimeout(timer); no(new Error(`Engine exited before native admission: ${diagnostics}`)); });
      owner!.once('error', error => { clearTimeout(timer); no(error); });
    });
    assert.equal(ready.type, 'running');
    assert.equal(ready.ownerPid, owner.pid);
    owner.kill('SIGKILL');
    await ended;
    await assertGone(ready.pids);
    const marker = inspectExecutionLock(f.dbPath + '.effects.sqlite');
    assert.equal(marker.status, 'uncertain', 'Owner crash releases SQLite locking but must preserve the active effect marker');
    assert.ok(marker.marker);
    assert.equal(marker.marker.ownerPid, ready.ownerPid);
    assert.equal(marker.marker.active, true);
    const before = readFileSync(join(directory, 'effects.log'), 'utf8');
    assert.equal(before.trim().split('\n').length, 1);
    for (let attempt = 0; attempt < 2; attempt++) {
      const reopened = createEngine({ ...f.configuration, hostCommands: false });
      f.engines.add(reopened);
      const records = reopened.inspectHostCommands(f.workspace.id);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.jobId, ready.jobId);
      assert.equal(records[0]!.state, 'uncertain');
      assert.throws(() => reopened.coordinator.assertWorkspaceCleanupConfirmed(f.workspace.id),
        (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_PENDING');
      assert.equal(reopened.store.getSnapshot(f.session.id).runs.length, 0);
      await new Promise(yes => setTimeout(yes, 100));
      assert.equal(readFileSync(join(directory, 'effects.log'), 'utf8'), before);
      await reopened.close();
    }
    assert.equal(f.providerCalls.length, 0);
    assert.equal(inspectExecutionLock(f.dbPath + '.effects.sqlite').status, 'uncertain');
  });
}
