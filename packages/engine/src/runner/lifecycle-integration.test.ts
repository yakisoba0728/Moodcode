import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import {
  DEFAULT_LIMITS, EngineError, isTerminal,
  type ApprovalRecord, type EngineEvent, type JsonObject, type RunLimits,
  type Session, type SubmitInput, type Workspace,
} from '@moodcode/contracts';
import type { CommitChange, ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { buildContext } from '../context/index.js';
import { ApprovalManager } from '../permission/index.js';
import { ScriptedProvider, type ScriptedTurn } from '../provider/index.js';
import { previewRestoreCheckpoint, restoreCheckpoint } from '../review/index.js';
import { SqliteStore } from '../storage/index.js';
import { createCommandTool } from '../tools/command/index.js';
import { assertExecutionLockAvailable } from '../tools/command/execution-lock.js';
import { createPatchTool } from '../tools/patch/index.js';
import { createReadTools } from '../tools/read/index.js';
import { openWorkspace } from '../workspace/index.js';
import { RunCoordinator } from './index.js';

const execFileAsync = promisify(execFile);
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
const stop: ProviderEvent = { type: 'finish', reason: 'stop' };
const toolFinish: ProviderEvent = { type: 'finish', reason: 'tool_calls' };
const patchCall = (id: string, path: string, before: string | null, after: string): ProviderEvent => ({
  type: 'tool.call', call: { id, name: 'apply_patch', input: { changes: [{ path, expectedHash: before === null ? null : hash(before), content: after }] } },
});
const commandCall = (id: string, code: string, timeoutMs = 5_000): ProviderEvent => ({
  type: 'tool.call', call: { id, name: 'run_command', input: { command: `${quote(process.execPath)} -e ${quote(code)}`, timeoutMs } },
});
const hasCode = (code: string) => (error: unknown): boolean => error instanceof EngineError && error.code === code;

/** Instrument only the commit boundary; migrations, transactions and projections stay real. */
class JournalStore extends SqliteStore {
  beforeCommit?: (runId: string, type: string) => void;
  afterCommit?: (event: EngineEvent) => void;
  override commit(runId: string, type: string, payload: JsonObject, change: CommitChange = {}): EngineEvent {
    this.beforeCommit?.(runId, type);
    const event = super.commit(runId, type, payload, change);
    this.afterCommit?.(event);
    return event;
  }
}

class RecordingProvider implements ProviderAdapter {
  readonly requests: TurnRequest[] = [];
  readonly signals: AbortSignal[] = [];
  private readonly scripted: ScriptedProvider;
  constructor(readonly id: string, turns: ScriptedTurn[]) { this.scripted = new ScriptedProvider(turns); }
  streamTurn(request: TurnRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this.requests.push(structuredClone(request)); this.signals.push(signal);
    return this.scripted.streamTurn(request, signal);
  }
}

function provider(id: string, turns: ProviderEvent[][]): RecordingProvider {
  return new RecordingProvider(id, turns.map((events) => ({ events })));
}

async function fixture(t: TestContext, providers: ProviderAdapter[], workspaceCount = 1) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-runner-life-')));
  const store = new JournalStore(join(root, 'engine.sqlite'));
  const approvals = new ApprovalManager(store);
  const executionLockPath = join(root, 'effects.sqlite');
  const tools = [...createReadTools(), createPatchTool(), createCommandTool()];
  const runner = new RunCoordinator({
    store, approvals, providers: new Map(providers.map((entry) => [entry.id, entry])), tools,
    artifactDir: join(root, 'artifacts'), executionLockPath, buildContext,
  });
  t.after(async () => {
    store.beforeCommit = undefined; store.afterCommit = undefined;
    try { await runner.close(); }
    finally { store.close(); await rm(root, { force: true, recursive: true }); }
  });
  const workspaces: Workspace[] = [];
  const sessions: Session[] = [];
  for (let index = 0; index < workspaceCount; index++) {
    const path = join(root, `workspace-${index}`);
    await mkdir(path); await execFileAsync('git', ['init', '--quiet', path]);
    await writeFile(join(path, 'target.txt'), `baseline-${index}\n`);
    const workspace = store.putWorkspace(await openWorkspace(path));
    workspaces.push(workspace);
    sessions.push(store.createSession({ id: randomUUID(), workspaceId: workspace.id, title: `Lifecycle ${index}`, createdAt: new Date().toISOString() }));
  }
  const input = (providerId = providers[0]!.id, session = sessions[0]!, limits: Partial<RunLimits> = {}, requestId = randomUUID()): SubmitInput => ({
    sessionId: session.id, requestId, prompt: 'Complete the lifecycle fixture',
    config: { providerId, modelId: 'local', mode: 'build', limits: { ...DEFAULT_LIMITS, maxDurationMs: 10_000, toolTimeoutMs: 5_000, ...limits } },
  });
  return { root, store, approvals, runner, tools, executionLockPath, workspaces, sessions, input };
}

async function event(store: SqliteStore, sessionId: string, predicate: (item: EngineEvent) => boolean): Promise<EngineEvent> {
  const signal = AbortSignal.timeout(5_000);
  for await (const item of store.subscribe(sessionId, 0, signal)) if (predicate(item)) return item;
  throw new Error('Lifecycle event did not arrive');
}

async function approval(f: Awaited<ReturnType<typeof fixture>>, runId: string): Promise<ApprovalRecord> {
  const run = f.store.getRun(runId);
  await event(f.store, run.sessionId, (item) => item.runId === runId && item.type === 'approval.requested');
  const pending = f.store.getSnapshot(run.sessionId).approvals.find((item) => item.runId === runId && item.status === 'pending');
  assert.ok(pending); return pending;
}

function allow(f: Awaited<ReturnType<typeof fixture>>, record: ApprovalRecord): void {
  f.approvals.decide(record.id, 'allow', record.fingerprint);
}

function terminal(store: SqliteStore, runId: string): EngineEvent {
  const run = store.getRun(runId);
  const events = store.readEvents(run.sessionId, 0, 1_024).filter((item) => item.runId === runId);
  const terminals = events.filter((item) => ['run.completed', 'run.cancelled', 'run.failed', 'run.interrupted'].includes(item.type));
  assert.equal(terminals.length, 1, 'A run has exactly one terminal event');
  assert.equal(terminals[0]!.type, `run.${run.state}`);
  assert.equal(terminals[0]!.seq, events.at(-1)!.seq, 'No run records commit after terminal');
  const snapshot = store.getSnapshot(run.sessionId);
  assert.ok(snapshot.tools.filter((item) => item.runId === runId).every((item) => ['completed', 'failed', 'denied', 'interrupted'].includes(item.state)));
  assert.ok(snapshot.approvals.filter((item) => item.runId === runId).every((item) => item.status !== 'pending'));
  for (const checkpoint of store.listCheckpoints(runId)) {
    const changed = events.find((item) => item.type === 'workspace.changed' && item.payload.checkpointId === checkpoint.id);
    assert.ok(changed); assert.ok(changed.seq < terminals[0]!.seq);
    assert.ok(snapshot.tools.some((item) => item.id === checkpoint.toolCallId && item.runId === runId));
  }
  return terminals[0]!;
}

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

async function pidAt(path: string): Promise<number> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (await exists(path)) {
      const pid = Number(await readFile(path, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    }
    await delay(10);
  }
  throw new Error('Actual command never wrote its PID');
}

function assertGone(pid: number): void {
  assert.throws(() => process.kill(pid, 0), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH');
}

test('maintenance serializes actual approved patch restoration while another workspace run remains cancellable', { timeout: 15_000 }, async (t) => {
  const writer = provider('maintenance-writer', [[patchCall('write', 'target.txt', 'baseline-0\n', 'changed-before-restore\n'), toolFinish], [stop]]);
  const waiting = provider('maintenance-waiting', [[patchCall('waiting', 'target.txt', 'baseline-1\n', 'must-not-change\n'), toolFinish], [stop]]);
  const reader = provider('maintenance-reader', [[{ type: 'tool.call', call: { id: 'read-restored', name: 'read_file', input: { path: 'target.txt' } } }, toolFinish], [stop]]);
  const f = await fixture(t, [writer, waiting, reader], 2);
  const submitted = f.input(writer.id);
  const receipt = f.runner.submit(submitted);
  allow(f, await approval(f, receipt.runId));
  assert.equal((await f.runner.waitForRun(receipt.runId)).state, 'completed');
  terminal(f.store, receipt.runId);
  const checkpoint = f.store.listCheckpoints(receipt.runId)[0]!;
  assert.equal(checkpoint.files[0]!.before, 'baseline-0\n');
  let release!: () => void;
  const proceed = new Promise<void>((resolve) => { release = resolve; });
  let ready!: () => void;
  const previewReady = new Promise<void>((resolve) => { ready = resolve; });
  let leaseSignal: AbortSignal | undefined;
  const lease = f.runner.withWorkspaceLease(f.workspaces[0]!.id, async (signal) => {
    leaseSignal = signal;
    const preview = await previewRestoreCheckpoint(f.store, f.workspaces[0]!, checkpoint.id, { executionLockPath: f.executionLockPath, signal });
    assert.equal(preview.canRestore, true);
    ready();
    await proceed;
    return restoreCheckpoint(f.store, f.workspaces[0]!, checkpoint.id, { executionLockPath: f.executionLockPath, previewFingerprint: preview.fingerprint, signal });
  });
  try {
    assert.equal(leaseSignal, undefined, 'Reservation precedes callback execution');
    const blocked = f.input(reader.id);
    assert.throws(() => f.runner.submit(blocked), hasCode('WORKSPACE_BUSY'));
    assert.equal(f.store.getSnapshot(blocked.sessionId).runs.length, 1, 'Blocked input has no durable run');
    assert.deepEqual(f.runner.submit(submitted), { ...receipt, duplicate: true });
    assert.throws(() => f.runner.submit({ ...submitted, prompt: 'changed duplicate' }), hasCode('REQUEST_ID_CONFLICT'));
    await previewReady;
    const other = f.runner.submit(f.input(waiting.id, f.sessions[1]));
    const pending = await approval(f, other.runId);
    assert.equal(f.runner.cancel(other.runId).state, 'cancelling');
    assert.equal((await f.runner.waitForRun(other.runId)).state, 'cancelled');
    assert.equal(f.store.getApproval(pending.id).status, 'expired');
    assert.equal(leaseSignal!.aborted, false, 'Run cancellation does not abort maintenance');
    assert.equal(await readFile(join(f.workspaces[1]!.root, 'target.txt'), 'utf8'), 'baseline-1\n');
    terminal(f.store, other.runId);
    release();
    const restored = await lease;
    assert.deepEqual(restored.restored, ['target.txt']);
    assert.deepEqual(restored.failed, []);
    assert.equal(restored.effectsUncertain, false);
    assert.equal(restored.executionBlocked, false);
    assert.equal(restored.observations[0]!.currentHash, hash('baseline-0\n'));
    assert.equal(await readFile(join(f.workspaces[0]!.root, 'target.txt'), 'utf8'), 'baseline-0\n');
    assertExecutionLockAvailable(f.executionLockPath);
    const after = f.runner.submit(f.input(reader.id));
    assert.equal((await f.runner.waitForRun(after.runId)).state, 'completed');
    assert.ok(f.store.getSnapshot(f.sessions[0]!.id).messages.some((message) => message.runId === after.runId && message.role === 'tool' && message.content.includes('baseline-0')));
    terminal(f.store, after.runId);
  } finally { release(); await lease.catch(() => {}); }
});

test('real workspace owners isolate approvals, deduplicate before busy, and release only the cancelled lease', { timeout: 15_000 }, async (t) => {
  const a = provider('a', [[patchCall('shared-provider-id', 'target.txt', 'baseline-0\n', 'changed-a\n'), toolFinish], [stop]]);
  const b = provider('b', [[patchCall('shared-provider-id', 'target.txt', 'baseline-1\n', 'changed-b\n'), toolFinish], [stop]]);
  const reader = provider('reader', [[{ type: 'tool.call', call: { id: 'shared-provider-id', name: 'read_file', input: { path: 'target.txt' } } }, toolFinish], [stop]]);
  const f = await fixture(t, [a, b, reader], 2);
  const sameWorkspaceSession = f.store.createSession({ id: randomUUID(), workspaceId: f.workspaces[0]!.id, title: 'Same workspace', createdAt: new Date().toISOString() });
  const inputA = f.input('a', f.sessions[0]);
  const receiptA = f.runner.submit(inputA);
  const receiptB = f.runner.submit(f.input('b', f.sessions[1]));
  const [approvalA, approvalB] = await Promise.all([approval(f, receiptA.runId), approval(f, receiptB.runId)]);
  assert.equal(f.store.getRun(receiptA.runId).state, 'awaiting_approval');
  assert.equal(f.store.getRun(receiptB.runId).state, 'awaiting_approval');
  assert.deepEqual(f.runner.submit(inputA), { ...receiptA, duplicate: true });
  assert.throws(() => f.runner.submit({ ...inputA, prompt: 'Changed input with same ID' }), hasCode('REQUEST_ID_CONFLICT'));
  assert.throws(() => f.runner.submit(f.input('reader', sameWorkspaceSession)), hasCode('WORKSPACE_BUSY'));
  assert.equal(f.store.getSnapshot(sameWorkspaceSession.id).runs.length, 0);
  assert.equal(a.requests.length, 1); assert.equal(b.requests.length, 1);

  f.runner.cancel(receiptA.runId);
  assert.equal((await f.runner.waitForRun(receiptA.runId)).state, 'cancelled');
  assert.equal(f.store.getApproval(approvalA.id).status, 'expired');
  assert.equal(f.store.getApproval(approvalB.id).status, 'pending');
  assert.equal(b.signals[0]!.aborted, false);
  const readReceipt = f.runner.submit(f.input('reader', sameWorkspaceSession));
  assert.equal((await f.runner.waitForRun(readReceipt.runId)).state, 'completed');
  assert.ok(reader.requests[1]!.messages.some((item) => item.role === 'tool' && item.content.includes('baseline-0')));
  assert.equal(f.store.getRun(receiptB.runId).state, 'awaiting_approval');
  allow(f, approvalB);
  assert.equal((await f.runner.waitForRun(receiptB.runId)).state, 'completed');
  assert.equal(await readFile(join(f.workspaces[0]!.root, 'target.txt'), 'utf8'), 'baseline-0\n');
  assert.equal(await readFile(join(f.workspaces[1]!.root, 'target.txt'), 'utf8'), 'changed-b\n');
  assert.equal(f.store.listCheckpoints(receiptA.runId).length, 0);
  assert.equal(f.store.listCheckpoints(receiptB.runId).length, 1);
  terminal(f.store, receiptA.runId); terminal(f.store, receiptB.runId); terminal(f.store, readReceipt.runId);
  const toolRows = f.sessions.flatMap((session) => f.store.getSnapshot(session.id).tools).concat(f.store.getSnapshot(sameWorkspaceSession.id).tools);
  assert.equal(new Set(toolRows.map((item) => item.id)).size, toolRows.length);
});

test('approval commit and allow racing synchronous cancellation never execute an approved patch', { timeout: 15_000 }, async (t) => {
  for (const boundary of ['approval.requested', 'approval.resolved'] as const) {
    await t.test(boundary, async (t) => {
      const p = provider('approval-race', [[patchCall('effect', 'target.txt', 'baseline-0\n', 'forbidden\n'), toolFinish], [stop]]);
      const f = await fixture(t, [p]);
      let waitingState: string | undefined;
      f.store.afterCommit = (item) => {
        if (item.type === 'approval.requested') waitingState = f.store.getRun(item.runId).state;
        if (item.type === boundary) { f.store.afterCommit = undefined; f.runner.cancel(item.runId); }
      };
      const receipt = f.runner.submit(f.input());
      if (boundary === 'approval.resolved') allow(f, await approval(f, receipt.runId));
      assert.equal((await f.runner.waitForRun(receipt.runId)).state, 'cancelled');
      assert.equal(waitingState, 'awaiting_approval');
      const decision = f.store.getSnapshot(f.sessions[0]!.id).approvals[0]!;
      assert.equal(decision.status, boundary === 'approval.requested' ? 'expired' : 'allowed');
      if (decision.status === 'expired') assert.throws(() => f.approvals.decide(decision.id, 'allow', decision.fingerprint), hasCode('APPROVAL_EXPIRED'));
      assert.equal(await readFile(join(f.workspaces[0]!.root, 'target.txt'), 'utf8'), 'baseline-0\n');
      assert.equal(f.store.listCheckpoints(receipt.runId).length, 0);
      assert.equal(p.requests.length, 1);
      assert.ok(!f.store.readEvents(f.sessions[0]!.id, 0).some((item) => item.type === 'tool.running'));
      terminal(f.store, receipt.runId);
    });
  }
});

test('cancel after the first actual patch checkpoint forbids the second complete call and retains observed effects', { timeout: 10_000 }, async (t) => {
  const p = provider('sequential-cancel', [[
    patchCall('first', 'first.txt', null, 'first effect\n'),
    patchCall('second', 'second.txt', null, 'forbidden second effect\n'), toolFinish,
  ], [stop]]);
  const f = await fixture(t, [p]);
  f.store.afterCommit = (item) => {
    if (item.type === 'workspace.changed') { f.store.afterCommit = undefined; f.runner.cancel(item.runId); }
  };
  const receipt = f.runner.submit(f.input());
  allow(f, await approval(f, receipt.runId));
  assert.equal((await f.runner.waitForRun(receipt.runId)).state, 'cancelled');
  assert.equal(await readFile(join(f.workspaces[0]!.root, 'first.txt'), 'utf8'), 'first effect\n');
  assert.equal(await exists(join(f.workspaces[0]!.root, 'second.txt')), false);
  const snapshot = f.store.getSnapshot(f.sessions[0]!.id);
  assert.equal(snapshot.tools.length, 1); assert.equal(snapshot.approvals.length, 1);
  const checkpoint = f.store.listCheckpoints(receipt.runId)[0]!;
  assert.deepEqual(checkpoint.files.map((file) => file.path), ['first.txt']);
  assert.equal(checkpoint.files[0]!.before, null); assert.equal(checkpoint.files[0]!.after, 'first effect\n');
  assert.equal(p.requests.length, 1); terminal(f.store, receipt.runId);
  assertExecutionLockAvailable(f.executionLockPath);
});

test('actual patch effects with a missing durable checkpoint fail closed during both normal execution and abort', { timeout: 15_000 }, async (t) => {
  for (const cancelAtFailure of [false, true]) {
    await t.test(`cancel=${cancelAtFailure}`, async (t) => {
      const p = provider('checkpoint-gap', [[patchCall('gap', 'effect.txt', null, 'effect persisted\n'), toolFinish], [stop]]);
      const f = await fixture(t, [p]);
      f.store.beforeCommit = (runId, type) => {
        if (type !== 'workspace.changed') return;
        f.store.beforeCommit = undefined;
        if (cancelAtFailure) f.runner.cancel(runId);
        throw new EngineError('FIXTURE_JOURNAL_FAILURE', 'Injected checkpoint transaction failure');
      };
      const input = f.input();
      const receipt = f.runner.submit(input);
      allow(f, await approval(f, receipt.runId));
      const final = await f.runner.waitForRun(receipt.runId);
      assert.equal(final.state, 'failed'); assert.equal(final.error?.code, 'CLEANUP_UNCERTAIN');
      assert.equal(await readFile(join(f.workspaces[0]!.root, 'effect.txt'), 'utf8'), 'effect persisted\n');
      assert.equal(f.store.listCheckpoints(receipt.runId).length, 0);
      assert.equal(p.requests.length, 1, 'A persistence gap must never continue the agent loop');
      assert.throws(() => assertExecutionLockAvailable(f.executionLockPath), hasCode('COMMAND_CLEANUP_UNCERTAIN'));
      assert.throws(() => f.runner.submit(f.input()), hasCode('CLEANUP_PENDING'));
      assert.deepEqual(f.runner.submit(input), { ...receipt, duplicate: true });
      terminal(f.store, receipt.runId);
    });
  }
});

test('duration budget stops a real command before failed terminal and preserves its checkpoint', { timeout: 15_000, skip: process.platform === 'win32' }, async (t) => {
  const code = "const fs=require('node:fs');fs.writeFileSync('started.pid',String(process.pid));fs.writeFileSync('effect.txt','command started\\n');setInterval(()=>{},1000)";
  const p = provider('duration', [[commandCall('command', code), toolFinish], [stop]]);
  const f = await fixture(t, [p]);
  const receipt = f.runner.submit(f.input(undefined, undefined, { maxDurationMs: 900 }));
  allow(f, await approval(f, receipt.runId));
  const pid = await pidAt(join(f.workspaces[0]!.root, 'started.pid'));
  const final = await f.runner.waitForRun(receipt.runId);
  assert.equal(final.state, 'failed'); assert.equal(final.error?.code, 'RUN_TIME_LIMIT');
  assertGone(pid);
  const checkpoint = f.store.listCheckpoints(receipt.runId)[0]!;
  assert.ok(checkpoint); assert.equal(checkpoint.kind, 'command');
  assert.equal(checkpoint.files.find((file) => file.path === 'effect.txt')?.after, 'command started\n');
  assert.equal(p.requests.length, 1); terminal(f.store, receipt.runId);
  assertExecutionLockAvailable(f.executionLockPath);
});

test('run output exhaustion after a real command keeps bounded content, artifacts and its committed checkpoint', { timeout: 15_000, skip: process.platform === 'win32' }, async (t) => {
  const code = "const fs=require('node:fs');fs.writeFileSync('effect.txt','output effect\\n');process.stdout.write('가'.repeat(2000))";
  const p = provider('output', [[{ type: 'text.delta', delta: 'p'.repeat(200) }, commandCall('command', code), toolFinish], [stop]]);
  const f = await fixture(t, [p]);
  const receipt = f.runner.submit(f.input(undefined, undefined, { maxOutputBytes: 512 }));
  allow(f, await approval(f, receipt.runId));
  const final = await f.runner.waitForRun(receipt.runId);
  assert.equal(final.state, 'failed'); assert.equal(final.error?.code, 'OUTPUT_LIMIT');
  assert.equal(p.requests.length, 1);
  const snapshot = f.store.getSnapshot(f.sessions[0]!.id);
  assert.ok(snapshot.messages.filter((item) => item.role !== 'user').reduce((sum, item) => sum + Buffer.byteLength(item.content), 0) <= 512);
  const result = f.store.readEvents(f.sessions[0]!.id, 0).find((item) => item.type === 'tool.failed')!;
  assert.equal(result.payload.truncated, true); assert.equal(result.payload.cleanupConfirmed, true);
  assert.ok(Array.isArray(result.payload.artifacts));
  for (const artifact of result.payload.artifacts) {
    assert.ok(artifact && typeof artifact === 'object' && !Array.isArray(artifact));
    assert.equal(typeof artifact.path, 'string');
    const bytes = await readFile(artifact.path as string);
    assert.equal(bytes.length, artifact.bytes);
  }
  assert.equal(f.store.listCheckpoints(receipt.runId)[0]!.files.find((file) => file.path === 'effect.txt')?.after, 'output effect\n');
  terminal(f.store, receipt.runId); assertExecutionLockAvailable(f.executionLockPath);
});

test('context exhaustion after a real patch and read result retains the patch and forbids another provider turn', { timeout: 10_000 }, async (t) => {
  const p = provider('context', [[
    patchCall('patch', 'effect.txt', null, 'context effect\n'),
    { type: 'tool.call', call: { id: 'read', name: 'read_file', input: { path: 'large.txt' } } }, toolFinish,
  ], [stop]]);
  const f = await fixture(t, [p]);
  await writeFile(join(f.workspaces[0]!.root, 'large.txt'), 'large content '.repeat(700));
  const schemas = f.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const catalogBytes = Buffer.byteLength(JSON.stringify({ messages: [], tools: schemas })) - 2;
  const receipt = f.runner.submit(f.input(undefined, undefined, { maxContextBytes: catalogBytes + 1_024 }));
  allow(f, await approval(f, receipt.runId));
  const final = await f.runner.waitForRun(receipt.runId);
  assert.equal(final.state, 'failed'); assert.equal(final.error?.code, 'CONTEXT_LIMIT');
  assert.equal(p.requests.length, 1);
  assert.equal(await readFile(join(f.workspaces[0]!.root, 'effect.txt'), 'utf8'), 'context effect\n');
  const snapshot = f.store.getSnapshot(f.sessions[0]!.id);
  assert.deepEqual(snapshot.tools.map((item) => item.state), ['completed', 'completed']);
  assert.equal(snapshot.messages.filter((item) => item.role === 'tool').length, 2);
  assert.equal(f.store.listCheckpoints(receipt.runId).length, 1);
  terminal(f.store, receipt.runId); assertExecutionLockAvailable(f.executionLockPath);
});

test('close waits for an actual command cleanup and expires another workspace approval before returning', { timeout: 15_000, skip: process.platform === 'win32' }, async (t) => {
  const code = "const fs=require('node:fs');fs.writeFileSync('started.pid',String(process.pid));fs.writeFileSync('effect.txt','close effect\\n');setInterval(()=>{},1000)";
  const command = provider('closing-command', [[commandCall('command', code), toolFinish], [stop]]);
  const patch = provider('closing-patch', [[patchCall('patch', 'target.txt', 'baseline-1\n', 'forbidden\n'), toolFinish], [stop]]);
  const f = await fixture(t, [command, patch], 2);
  const commandReceipt = f.runner.submit(f.input(command.id, f.sessions[0]));
  const patchReceipt = f.runner.submit(f.input(patch.id, f.sessions[1]));
  const [commandApproval, patchApproval] = await Promise.all([approval(f, commandReceipt.runId), approval(f, patchReceipt.runId)]);
  allow(f, commandApproval);
  const pid = await pidAt(join(f.workspaces[0]!.root, 'started.pid'));
  let resolved = false;
  const closing = f.runner.close().then(() => { resolved = true; });
  assert.equal(resolved, false);
  assert.equal(f.store.getRun(commandReceipt.runId).state, 'cancelling');
  assert.ok(!isTerminal(f.store.getRun(commandReceipt.runId).state));
  assert.equal(f.store.getApproval(patchApproval.id).status, 'expired');
  await closing;
  assert.equal(resolved, true); assertGone(pid);
  assert.equal(f.store.getRun(commandReceipt.runId).state, 'cancelled');
  assert.equal(f.store.getRun(patchReceipt.runId).state, 'cancelled');
  assert.equal(await readFile(join(f.workspaces[1]!.root, 'target.txt'), 'utf8'), 'baseline-1\n');
  assert.equal(f.store.listCheckpoints(commandReceipt.runId)[0]!.files.find((file) => file.path === 'effect.txt')?.after, 'close effect\n');
  assert.equal(f.store.listCheckpoints(patchReceipt.runId).length, 0);
  terminal(f.store, commandReceipt.runId); terminal(f.store, patchReceipt.runId);
  assertExecutionLockAvailable(f.executionLockPath);
  assert.throws(() => f.runner.submit(f.input()), hasCode('ENGINE_CLOSED'));
});

test('completed provider replay commits with the assistant and survives real context and SQLite reopen', { timeout: 10_000 }, async (t) => {
  const items: JsonObject[] = [
    { id: 'reasoning-native', type: 'reasoning', summary: [], encrypted_content: 'opaque-private-native-state' },
    { id: 'call-native', type: 'function_call', call_id: 'native-read', name: 'read_file', arguments: '{"path":"target.txt"}', status: 'completed' },
  ];
  const finalItems: JsonObject[] = [{ id: 'final-native', type: 'reasoning', summary: [], encrypted_content: 'opaque-final-native-state' }];
  const p = provider('native-replay-fixture', [
    [
      { type: 'text.delta', delta: 'Checking the file.' },
      { type: 'tool.call', call: { id: 'native-read', name: 'read_file', input: { path: 'target.txt' } } },
      { type: 'finish', reason: 'tool_calls', replayItems: items },
    ],
    [{ type: 'text.delta', delta: 'Finished.' }, { type: 'finish', reason: 'stop', replayItems: finalItems }],
  ]);
  const f = await fixture(t, [p]);
  const projectionBoundaries: string[] = [];
  f.store.afterCommit = (item) => {
    if (item.type !== 'message.delta' && item.type !== 'message.completed') return;
    const assistant = f.store.getSnapshot(item.sessionId).messages.find((message) => message.id === item.payload.messageId)!;
    if (item.type === 'message.delta') assert.equal(assistant.providerReplay, undefined, 'Native replay is absent from partial projections');
    else {
      assert.equal(assistant.providerReplay?.providerId, p.id);
      projectionBoundaries.push(item.type);
    }
  };
  const receipt = f.runner.submit(f.input());
  assert.equal((await f.runner.waitForRun(receipt.runId)).state, 'completed');
  assert.equal(projectionBoundaries.length, 2);
  const snapshot = f.store.getSnapshot(f.sessions[0]!.id);
  const assistants = snapshot.messages.filter((message) => message.role === 'assistant');
  assert.deepEqual(assistants.map((message) => message.providerReplay), [
    { providerId: p.id, items }, { providerId: p.id, items: finalItems },
  ]);
  const nextAssistant = p.requests[1]!.messages.find((message) => message.role === 'assistant' && message.toolCalls);
  assert.deepEqual(nextAssistant?.providerReplay, { providerId: p.id, items });
  assert.ok(p.requests[1]!.messages.some((message) => message.role === 'tool' && message.toolCallId === 'native-read'));
  const events = f.store.readEvents(f.sessions[0]!.id, 0, 1_024);
  assert.ok(!JSON.stringify(events).includes('opaque-private-native-state'));
  assert.ok(!JSON.stringify(events).includes('opaque-final-native-state'));
  assert.equal(assistants[0]!.content, 'Checking the file.');
  const replayInCopy = assistants[0]!.providerReplay!;
  replayInCopy.items[0]!.encrypted_content = 'mutated snapshot copy';
  assert.equal(f.store.getSnapshot(f.sessions[0]!.id).messages.find((message) => message.id === assistants[0]!.id)!.providerReplay!.items[0]!.encrypted_content, 'opaque-private-native-state');
  terminal(f.store, receipt.runId);

  f.store.afterCommit = undefined;
  await f.runner.close(); f.store.close();
  const reopenedStore = new SqliteStore(join(f.root, 'engine.sqlite'));
  const reopenedProvider = provider(p.id, [[stop]]);
  const reopenedRunner = new RunCoordinator({
    store: reopenedStore, approvals: new ApprovalManager(reopenedStore), providers: new Map([[p.id, reopenedProvider]]),
    tools: f.tools, artifactDir: join(f.root, 'artifacts'), executionLockPath: f.executionLockPath, buildContext,
  });
  try {
    assert.deepEqual(reopenedStore.recoverInterrupted(), []);
    const restored = reopenedStore.getSnapshot(f.sessions[0]!.id);
    assert.deepEqual(restored.messages.filter((message) => message.role === 'assistant').map((message) => message.providerReplay), [
      { providerId: p.id, items }, { providerId: p.id, items: finalItems },
    ]);
    const followup = reopenedRunner.submit(f.input());
    assert.equal((await reopenedRunner.waitForRun(followup.runId)).state, 'completed');
    const replayMessages = reopenedProvider.requests[0]!.messages.filter((message) => message.providerReplay);
    assert.deepEqual(replayMessages.map((message) => message.providerReplay), [
      { providerId: p.id, items }, { providerId: p.id, items: finalItems },
    ]);
    terminal(reopenedStore, followup.runId);
  } finally { await reopenedRunner.close(); reopenedStore.close(); }
});

test('oversized replay after complete calls keeps committed text but no native metadata or actual tool effects', { timeout: 10_000 }, async (t) => {
  const p = provider('oversized-replay', [[
    { type: 'text.delta', delta: 'Partial visible answer.' },
    patchCall('unexecuted', 'forbidden.txt', null, 'forbidden effect\n'),
    { type: 'finish', reason: 'tool_calls', replayItems: [{ type: 'reasoning', encrypted_content: `private-replay-value-${'x'.repeat(DEFAULT_LIMITS.maxContextBytes)}` }] },
  ], [stop]]);
  const f = await fixture(t, [p]);
  const catalog = f.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const reserve = Buffer.byteLength(JSON.stringify({ messages: [], tools: catalog })) - 2;
  const receipt = f.runner.submit(f.input(undefined, undefined, { maxContextBytes: reserve + 512 }));
  const final = await f.runner.waitForRun(receipt.runId);
  assert.equal(final.state, 'failed'); assert.equal(final.error?.code, 'CONTEXT_LIMIT');
  assert.equal(p.requests.length, 1);
  const snapshot = f.store.getSnapshot(f.sessions[0]!.id);
  assert.deepEqual(snapshot.messages.filter((message) => message.role === 'assistant').map((message) => message.content), ['Partial visible answer.']);
  assert.ok(snapshot.messages.every((message) => message.providerReplay === undefined));
  assert.equal(snapshot.tools.length, 0); assert.equal(snapshot.approvals.length, 0);
  assert.equal(f.store.listCheckpoints(receipt.runId).length, 0);
  assert.equal(await exists(join(f.workspaces[0]!.root, 'forbidden.txt')), false);
  assert.ok(!JSON.stringify(snapshot).includes('private-replay-value'));
  assert.ok(!JSON.stringify(f.store.readEvents(f.sessions[0]!.id, 0, 1_024)).includes('private-replay-value'));
  terminal(f.store, receipt.runId); assertExecutionLockAvailable(f.executionLockPath);
});
