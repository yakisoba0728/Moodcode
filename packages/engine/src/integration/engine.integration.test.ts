import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, type ApprovalRecord, type CommandResult, type EngineEvent, type JsonObject, type ReviewDiff, type RunConfig, type RunReceipt, type Session, type SessionSnapshot, type Workspace } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { ScriptedProvider } from '../provider/index.js';
import { restoreCheckpoint } from '../review/index.js';
import { SqliteStore } from '../storage/index.js';

type Engine = ReturnType<typeof createEngine>;
const execFileAsync = promisify(execFile);
const config = (mode: 'plan' | 'build' = 'plan', modelId = 'local'): RunConfig => ({
  providerId: 'scripted', modelId, mode,
  limits: { ...DEFAULT_LIMITS, maxDurationMs: 20_000, toolTimeoutMs: 5_000 },
});
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const terminal = (event: EngineEvent): boolean => ['run.completed', 'run.cancelled', 'run.failed', 'run.interrupted'].includes(event.type);

async function command<T>(engine: Engine, type: string, payload: JsonObject): Promise<T> {
  const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload });
  assert.equal(result.ok, true, `${type}: ${JSON.stringify(result.error)}`);
  return result.result as unknown as T;
}

async function rejectedCommand(engine: Engine, type: string, payload: JsonObject): Promise<CommandResult> {
  const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload });
  assert.equal(result.ok, false, `${type} should have failed`);
  assert.ok(result.error?.code, 'failed commands expose a stable error code');
  return result;
}

async function snapshot(engine: Engine, sessionId: string): Promise<SessionSnapshot> {
  return command(engine, 'session.getSnapshot', { sessionId });
}

async function submit(engine: Engine, sessionId: string, requestId: string, runConfig = config(), prompt = 'Implement the requested change'): Promise<RunReceipt> {
  return command(engine, 'run.submit', { sessionId, requestId, prompt, config: runConfig as unknown as JsonObject });
}

async function waitForEvent(engine: Engine, sessionId: string, matches: (event: EngineEvent) => boolean, afterSeq = 0): Promise<EngineEvent> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error('event wait exceeded five seconds')), 5_000);
  try {
    for await (const event of engine.subscribe(sessionId, afterSeq, abort.signal)) {
      if (matches(event)) return event;
    }
    throw new Error('event subscription ended before the expected event');
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
}

async function replayThroughTerminal(engine: Engine, sessionId: string, afterSeq = 0): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  await waitForEvent(engine, sessionId, (event) => {
    events.push(event);
    return terminal(event);
  }, afterSeq);
  return events;
}

async function nextApproval(engine: Engine, sessionId: string, afterSeq = 0): Promise<{ event: EngineEvent; approval: ApprovalRecord }> {
  const event = await waitForEvent(engine, sessionId, (item) => item.type === 'approval.requested', afterSeq);
  const approval = (await snapshot(engine, sessionId)).approvals.find((item) => item.status === 'pending');
  assert.ok(approval, 'approval event and snapshot projection commit together');
  return { event, approval };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function eventually(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(10);
  }
  assert.fail(message);
}

async function fixture(t: TestContext, providers?: ProviderAdapter[]) {
  const root = await mkdtemp(join(tmpdir(), 'moodcode-integration-'));
  const repository = join(root, 'repository');
  await mkdir(repository);
  await execFileAsync('git', ['init', '--quiet', repository]);
  await writeFile(join(repository, 'target.txt'), 'baseline\n');
  await writeFile(join(repository, 'untouched.txt'), 'original\n');
  await execFileAsync('git', ['-C', repository, 'add', '.']);
  await execFileAsync('git', ['-C', repository, '-c', 'user.name=Moodcode Integration', '-c', 'user.email=integration@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture']);
  const dbPath = join(root, 'engine.sqlite');
  const artifactDir = join(root, 'artifacts');
  let engine = createEngine({ dbPath, artifactDir, providers });
  t.after(async () => {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await command<Workspace>(engine, 'workspace.open', { path: repository });
  const session = await command<Session>(engine, 'session.create', { workspaceId: workspace.id, title: 'Integration test' });
  return {
    root, repository, dbPath, artifactDir, workspace, session,
    get engine() { return engine; },
    async reopen(nextProviders?: ProviderAdapter[]) {
      await engine.close();
      engine = createEngine({ dbPath, artifactDir, providers: nextProviders });
      return engine;
    },
  };
}

class RecordingScriptedProvider implements ProviderAdapter {
  readonly id = 'scripted';
  readonly requests: TurnRequest[] = [];
  private readonly scripted: ScriptedProvider;
  constructor(events: ProviderEvent[][]) {
    this.scripted = new ScriptedProvider(events.map((turn) => ({ events: turn })));
  }
  streamTurn(request: TurnRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this.requests.push(structuredClone(request));
    return this.scripted.streamTurn(request, signal);
  }
}

class CancellableProvider implements ProviderAdapter {
  readonly id = 'scripted';
  calls = 0;
  aborts = 0;
  private announceStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.announceStarted = resolve; });
  async *streamTurn(request: TurnRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this.calls++;
    this.announceStarted();
    yield { type: 'text.delta', delta: 'Started' };
    if (request.modelId === 'finish') {
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    await new Promise<never>((_resolve, reject) => {
      const onAbort = () => { this.aborts++; reject(signal.reason ?? new Error('aborted')); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

test('durable admission deduplicates before workspace busy, rejects conflicts, and cancel releases the lease', { timeout: 15_000 }, async (t) => {
  const provider = new CancellableProvider();
  const f = await fixture(t, [provider]);
  const secondSession = await command<Session>(f.engine, 'session.create', { workspaceId: f.workspace.id, title: 'Other session' });
  const receipt = await submit(f.engine, f.session.id, 'same-request');
  await provider.started;
  const duplicate = await submit(f.engine, f.session.id, 'same-request');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.runId, receipt.runId);
  assert.equal(duplicate.inputId, receipt.inputId);
  assert.equal(duplicate.admittedSeq, receipt.admittedSeq);
  const conflict = await rejectedCommand(f.engine, 'run.submit', { sessionId: f.session.id, requestId: 'same-request', prompt: 'Different input', config: config() as unknown as JsonObject });
  assert.equal(conflict.error?.code, 'REQUEST_ID_CONFLICT');
  const busy = await rejectedCommand(f.engine, 'run.submit', { sessionId: secondSession.id, requestId: 'new-request', prompt: 'Another input', config: config() as unknown as JsonObject });
  assert.equal(busy.error?.code, 'WORKSPACE_BUSY');
  assert.equal((await snapshot(f.engine, secondSession.id)).runs.length, 0, 'busy requests are never durably admitted');
  await command(f.engine, 'run.cancel', { runId: receipt.runId });
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'cancelled');
  assert.equal(provider.calls, 1, 'request redelivery does not repeat the provider turn');
  assert.equal(provider.aborts, 1, 'cancel reaches the running provider');
  const finalSnapshot = await snapshot(f.engine, f.session.id);
  assert.equal(finalSnapshot.runs.length, 1);
  assert.equal(finalSnapshot.messages.filter((message) => message.role === 'user').length, 1);
  const events = await replayThroughTerminal(f.engine, f.session.id);
  assert.equal(events.filter(terminal).length, 1);
  assert.ok(events.some((event) => event.type === 'run.cancelling'));
  const released = await submit(f.engine, secondSession.id, 'after-cancel', config('plan', 'finish'));
  assert.equal((await f.engine.waitForRun(released.runId)).state, 'completed');
});

test('snapshot-to-subscription handoff replays committed events and completed requests survive reopening', { timeout: 15_000 }, async (t) => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const provider: ProviderAdapter = {
    id: 'scripted',
    async *streamTurn() {
      calls++;
      yield { type: 'text.delta', delta: 'before ' };
      await released;
      yield { type: 'text.delta', delta: 'after handoff' };
      yield { type: 'finish', reason: 'stop' };
    },
  };
  t.after(() => release());
  const f = await fixture(t, [provider]);
  const receipt = await submit(f.engine, f.session.id, 'persistent-request');
  await waitForEvent(f.engine, f.session.id, (event) => event.type === 'run.started');
  const before = await snapshot(f.engine, f.session.id);
  release();
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed');
  const later = await replayThroughTerminal(f.engine, f.session.id, before.lastSeq);
  assert.ok(later.length > 0);
  assert.equal(later[0]?.seq, before.lastSeq + 1);
  assert.ok(later.every((event, index) => event.seq === before.lastSeq + index + 1));
  const full = await replayThroughTerminal(f.engine, f.session.id);
  assert.ok(full.every((event, index) => event.seq === index + 1));
  assert.equal(new Set(full.map((event) => event.eventId)).size, full.length);
  const completed = await snapshot(f.engine, f.session.id);
  assert.equal(full.at(-1)?.seq, completed.lastSeq);
  assert.match(completed.messages.filter((message) => message.role === 'assistant').map((message) => message.content).join(''), /before after handoff/);
  let reopenedCalls = 0;
  const reopenedRequests: TurnRequest[] = [];
  await f.reopen([{ id: 'scripted', async *streamTurn(request) { reopenedCalls++; reopenedRequests.push(structuredClone(request)); yield { type: 'text.delta', delta: 'Prior context preserved' }; yield { type: 'finish', reason: 'stop' }; } }]);
  const restored = await snapshot(f.engine, f.session.id);
  assert.deepEqual(restored.messages, completed.messages);
  assert.deepEqual(restored.runs, completed.runs);
  assert.equal(restored.lastSeq, completed.lastSeq);
  const duplicate = await submit(f.engine, f.session.id, 'persistent-request');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.runId, receipt.runId);
  assert.equal(reopenedCalls, 0);
  assert.equal(calls, 1);
  const replayed = await replayThroughTerminal(f.engine, f.session.id);
  assert.deepEqual(replayed, full);
  const followup = await submit(f.engine, f.session.id, 'next-run', config(), 'Continue the prior conversation');
  assert.equal((await f.engine.waitForRun(followup.runId)).state, 'completed');
  assert.equal(reopenedCalls, 1);
  assert.ok(reopenedRequests[0]?.messages.some((message) => message.role === 'assistant' && message.content.includes('before after handoff')), 'reopened sessions supply prior responses to the next provider turn');
  assert.equal(reopenedRequests[0]?.messages.findLast((message) => message.role === 'user')?.content, 'Continue the prior conversation');
});

test('read → patch approval → command approval → response records only the run changes and retains existing edits', { timeout: 20_000 }, async (t) => {
  const before = 'baseline\nuser edit\n';
  const after = `${before}agent addition\n`;
  const commandCode = `const fs=require('node:fs');if(fs.readFileSync('target.txt','utf8')!==${JSON.stringify(after)})process.exit(7);fs.writeFileSync('verification.txt','verified\\n');process.stdout.write('verification passed\\n')`;
  const commandText = `${shellQuote(process.execPath)} -e ${shellQuote(commandCode)}`;
  const provider = new RecordingScriptedProvider([
    [{ type: 'tool.call', call: { id: 'read-1', name: 'read_file', input: { path: 'target.txt' } } }, { type: 'finish', reason: 'tool_calls' }],
    [{ type: 'tool.call', call: { id: 'patch-1', name: 'apply_patch', input: { changes: [{ path: 'target.txt', expectedHash: hash(before), content: after }] } } }, { type: 'finish', reason: 'tool_calls' }],
    [{ type: 'tool.call', call: { id: 'command-1', name: 'run_command', input: { command: commandText, timeoutMs: 3_000 } } }, { type: 'finish', reason: 'tool_calls' }],
    [{ type: 'text.delta', delta: 'Change implemented and verified.' }, { type: 'finish', reason: 'stop' }],
  ]);
  const f = await fixture(t, [provider]);
  await writeFile(join(f.repository, 'target.txt'), before);
  await writeFile(join(f.repository, 'untouched.txt'), 'unrelated user draft\n');
  const receipt = await submit(f.engine, f.session.id, 'coding-flow', config('build'));
  const patch = await nextApproval(f.engine, f.session.id);
  assert.equal(patch.approval.toolName, 'apply_patch');
  assert.equal(await readFile(join(f.repository, 'target.txt'), 'utf8'), before, 'preparation cannot mutate files');
  assert.equal((await snapshot(f.engine, f.session.id)).runs[0]?.state, 'awaiting_approval');
  await rejectedCommand(f.engine, 'approval.decide', { approvalId: patch.approval.id, decision: 'allow', fingerprint: 'different-action' });
  assert.equal(await readFile(join(f.repository, 'target.txt'), 'utf8'), before);
  await command(f.engine, 'approval.decide', { approvalId: patch.approval.id, decision: 'allow', fingerprint: patch.approval.fingerprint });
  const processApproval = await nextApproval(f.engine, f.session.id, patch.event.seq);
  assert.equal(processApproval.approval.toolName, 'run_command');
  assert.equal(await readFile(join(f.repository, 'target.txt'), 'utf8'), after);
  assert.equal(await exists(join(f.repository, 'verification.txt')), false, 'command cannot run before approval');
  await command(f.engine, 'approval.decide', { approvalId: processApproval.approval.id, decision: 'allow', fingerprint: processApproval.approval.fingerprint });
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed');
  assert.equal(await readFile(join(f.repository, 'verification.txt'), 'utf8'), 'verified\n');
  assert.equal(await readFile(join(f.repository, 'untouched.txt'), 'utf8'), 'unrelated user draft\n');
  const finalSnapshot = await snapshot(f.engine, f.session.id);
  assert.equal(finalSnapshot.tools.length, 3);
  assert.ok(finalSnapshot.tools.every((tool) => tool.state === 'completed'));
  assert.ok(finalSnapshot.approvals.every((approval) => approval.status === 'allowed'));
  assert.equal(provider.requests.length, 4);
  assert.ok(provider.requests[1]?.messages.some((message) => message.role === 'tool' && message.toolCallId === 'read-1' && message.content.includes('user edit')));
  assert.ok(provider.requests[3]?.messages.some((message) => message.role === 'tool' && message.toolCallId === 'command-1' && message.content.includes('verification passed')));
  const diff = await command<ReviewDiff>(f.engine, 'review.getDiff', { runId: receipt.runId });
  assert.deepEqual(diff.files.map((file) => file.path).sort(), ['target.txt', 'verification.txt']);
  const changedFile = diff.files.find((file) => file.path === 'target.txt');
  assert.equal(changedFile?.before, before, 'run preimage includes already existing user edits');
  assert.equal(changedFile?.after, after);
  assert.equal(changedFile?.beforeHash, hash(before));
  assert.equal(changedFile?.afterHash, hash(after));
  assert.ok(diff.checkpoints.some((checkpoint) => checkpoint.kind === 'patch'));
  assert.ok(diff.checkpoints.some((checkpoint) => checkpoint.kind === 'command'));
  assert.ok(finalSnapshot.messages.some((message) => message.role === 'assistant' && message.content.includes('implemented and verified')));
  const duplicate = await submit(f.engine, f.session.id, 'coding-flow', config('build'));
  assert.equal(duplicate.duplicate, true);
  assert.equal(provider.requests.length, 4, 'completed tool effects are not repeated on redelivery');
  await f.engine.close();
  const persistedStore = new SqliteStore(f.dbPath);
  try {
    const commandCheckpoint = diff.checkpoints.find((checkpoint) => checkpoint.kind === 'command');
    const patchCheckpoint = diff.checkpoints.find((checkpoint) => checkpoint.kind === 'patch');
    assert.ok(commandCheckpoint && patchCheckpoint);
    const commandRestore = await restoreCheckpoint(persistedStore, f.workspace, commandCheckpoint.id);
    assert.deepEqual(commandRestore.conflicts, []);
    assert.deepEqual(commandRestore.failed, []);
    assert.deepEqual(commandRestore.restored, ['verification.txt']);
    assert.equal(await exists(join(f.repository, 'verification.txt')), false);
    const patchRestore = await restoreCheckpoint(persistedStore, f.workspace, patchCheckpoint.id);
    assert.deepEqual(patchRestore.conflicts, []);
    assert.deepEqual(patchRestore.failed, []);
    assert.deepEqual(patchRestore.restored, ['target.txt']);
    assert.equal(await readFile(join(f.repository, 'target.txt'), 'utf8'), before, 'restore returns to the user-edited preimage, rather than the Git base');
    assert.equal(await readFile(join(f.repository, 'untouched.txt'), 'utf8'), 'unrelated user draft\n');
  } finally {
    persistedStore.close();
  }
});

test('denied patch becomes a tool result and never modifies the workspace', { timeout: 15_000 }, async (t) => {
  const provider = new RecordingScriptedProvider([
    [{ type: 'tool.call', call: { id: 'denied-patch', name: 'apply_patch', input: { changes: [{ path: 'target.txt', expectedHash: hash('baseline\n'), content: 'should not be written\n' }] } } }, { type: 'finish', reason: 'tool_calls' }],
    [{ type: 'text.delta', delta: 'The user denied the change.' }, { type: 'finish', reason: 'stop' }],
  ]);
  const f = await fixture(t, [provider]);
  const receipt = await submit(f.engine, f.session.id, 'deny', config('build'));
  const { approval } = await nextApproval(f.engine, f.session.id);
  await command(f.engine, 'approval.decide', { approvalId: approval.id, decision: 'deny', fingerprint: approval.fingerprint });
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed');
  assert.equal(await readFile(join(f.repository, 'target.txt'), 'utf8'), 'baseline\n');
  const finalSnapshot = await snapshot(f.engine, f.session.id);
  assert.equal(finalSnapshot.approvals[0]?.status, 'denied');
  assert.equal(finalSnapshot.tools[0]?.state, 'denied');
  assert.ok(provider.requests[1]?.messages.some((message) => message.role === 'tool' && message.toolCallId === 'denied-patch'));
  const diff = await command<ReviewDiff>(f.engine, 'review.getDiff', { runId: receipt.runId });
  assert.equal(diff.files.length, 0);
  await rejectedCommand(f.engine, 'approval.decide', { approvalId: approval.id, decision: 'allow', fingerprint: approval.fingerprint });
});

test('external edits made while approval is pending invalidate patch execution without overwriting the edit', { timeout: 15_000 }, async (t) => {
  const provider = new RecordingScriptedProvider([
    [{ type: 'tool.call', call: { id: 'stale-patch', name: 'apply_patch', input: { changes: [{ path: 'target.txt', expectedHash: hash('baseline\n'), content: 'stale generated content\n' }] } } }, { type: 'finish', reason: 'tool_calls' }],
    [{ type: 'text.delta', delta: 'The source changed; I did not overwrite it.' }, { type: 'finish', reason: 'stop' }],
  ]);
  const f = await fixture(t, [provider]);
  const receipt = await submit(f.engine, f.session.id, 'stale', config('build'));
  const { approval } = await nextApproval(f.engine, f.session.id);
  await writeFile(join(f.repository, 'target.txt'), 'external user edit\n');
  await command(f.engine, 'approval.decide', { approvalId: approval.id, decision: 'allow', fingerprint: approval.fingerprint });
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed');
  assert.equal(await readFile(join(f.repository, 'target.txt'), 'utf8'), 'external user edit\n');
  const finalSnapshot = await snapshot(f.engine, f.session.id);
  assert.equal(finalSnapshot.tools[0]?.state, 'failed');
  assert.ok(provider.requests[1]?.messages.some((message) => message.role === 'tool' && message.toolCallId === 'stale-patch'));
  assert.equal((await command<ReviewDiff>(f.engine, 'review.getDiff', { runId: receipt.runId })).files.length, 0, 'external changes are not attributed to a failed patch');
});

test('cancel during approval expires the grant and a late allow cannot launch a command', { timeout: 15_000 }, async (t) => {
  const commandText = `${shellQuote(process.execPath)} -e ${shellQuote("require('node:fs').writeFileSync('forbidden.txt','effect')")}`;
  const provider = new RecordingScriptedProvider([
    [{ type: 'tool.call', call: { id: 'cancel-command', name: 'run_command', input: { command: commandText } } }, { type: 'finish', reason: 'tool_calls' }],
    [{ type: 'finish', reason: 'stop' }],
  ]);
  const f = await fixture(t, [provider]);
  const receipt = await submit(f.engine, f.session.id, 'approval-cancel', config('build'));
  const { approval } = await nextApproval(f.engine, f.session.id);
  await command(f.engine, 'run.cancel', { runId: receipt.runId });
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'cancelled');
  assert.equal((await snapshot(f.engine, f.session.id)).approvals[0]?.status, 'expired');
  await rejectedCommand(f.engine, 'approval.decide', { approvalId: approval.id, decision: 'allow', fingerprint: approval.fingerprint });
  assert.equal(await exists(join(f.repository, 'forbidden.txt')), false);
  assert.equal(provider.requests.length, 1);
  const events = await replayThroughTerminal(f.engine, f.session.id);
  assert.equal(events.filter(terminal).length, 1);
});

test('cancel of an approved running command stops the real process before confirming cancelled', { timeout: 15_000 }, async (t) => {
  const commandCode = "require('node:fs').writeFileSync('running.pid',String(process.pid));setInterval(()=>{},1000)";
  const commandText = `${shellQuote(process.execPath)} -e ${shellQuote(commandCode)}`;
  const provider = new RecordingScriptedProvider([
    [{ type: 'tool.call', call: { id: 'running-command', name: 'run_command', input: { command: commandText, timeoutMs: 5_000 } } }, { type: 'finish', reason: 'tool_calls' }],
    [{ type: 'finish', reason: 'stop' }],
  ]);
  const f = await fixture(t, [provider]);
  const receipt = await submit(f.engine, f.session.id, 'process-cancel', config('build'));
  const { approval } = await nextApproval(f.engine, f.session.id);
  await command(f.engine, 'approval.decide', { approvalId: approval.id, decision: 'allow', fingerprint: approval.fingerprint });
  const pidPath = join(f.repository, 'running.pid');
  await eventually(() => exists(pidPath), 'approved command never started');
  const pid = Number(await readFile(pidPath, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  process.kill(pid, 0);
  await command(f.engine, 'run.cancel', { runId: receipt.runId });
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'cancelled');
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH', 'cancelled is published only after the actual child is gone');
  assert.equal(provider.requests.length, 1, 'cancel does not ask the provider for another turn');
  const events = await replayThroughTerminal(f.engine, f.session.id);
  assert.equal(events.filter(terminal).length, 1);
});

test('process loss during pending approval recovers interrupted history without executing an uncertain command', { timeout: 25_000 }, async (t) => {
  const f = await fixture(t);
  await f.engine.close();
  const sourceMode = import.meta.url.endsWith('.ts');
  const enginePath = join(dirname(fileURLToPath(import.meta.url)), '..', sourceMode ? 'engine.ts' : 'engine.js');
  const childPath = join(f.root, 'crash-child.mjs');
  const commandText = `${shellQuote(process.execPath)} -e ${shellQuote("require('node:fs').writeFileSync('unapproved.txt','effect')")}`;
  await writeFile(childPath, `
import { createEngine } from ${JSON.stringify(pathToFileURL(enginePath).href)};
const provider = {
  id: 'scripted',
  async *streamTurn() {
    yield {type:'tool.call',call:{id:'crash-command',name:'run_command',input:{command:${JSON.stringify(commandText)}}}};
    yield {type:'finish',reason:'tool_calls'};
  }
};
const engine=createEngine({dbPath:${JSON.stringify(f.dbPath)},artifactDir:${JSON.stringify(f.artifactDir)},providers:[provider]});
const result=await engine.dispatch({schemaVersion:1,commandId:'crash-submit',type:'run.submit',payload:{sessionId:${JSON.stringify(f.session.id)},requestId:'crash-request',prompt:'Implement the requested change',config:${JSON.stringify(config('build'))}}});
if(!result.ok)throw new Error(JSON.stringify(result));
for await(const event of engine.subscribe(${JSON.stringify(f.session.id)},0)){
  if(event.type==='approval.requested'){
    console.log(JSON.stringify({ready:true,runId:result.result.runId}));
    setInterval(()=>{},1000);
    break;
  }
}
`);
  const child = spawn(process.execPath, [...(sourceMode ? ['--import', 'tsx'] : []), childPath], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const ready = await new Promise<{ runId: string }>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`crash fixture never became ready: ${stderr}`)); }, 8_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`crash fixture exited early (${code}): ${stderr}`)); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const line = stdout.split('\n').find((item) => item.startsWith('{'));
      if (line) {
        try { const data = JSON.parse(line); if (data.ready === true) { clearTimeout(timeout); resolve(data); } } catch { /* Wait for a complete JSON line. */ }
      }
    });
  });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  let resumedCalls = 0;
  await f.reopen([{ id: 'scripted', async *streamTurn() { resumedCalls++; yield { type: 'text.delta', delta: 'New explicit run only' }; yield { type: 'finish', reason: 'stop' }; } }]);
  const recovered = await snapshot(f.engine, f.session.id);
  assert.equal(recovered.runs.find((run) => run.id === ready.runId)?.state, 'interrupted');
  assert.equal(recovered.approvals[0]?.status, 'expired');
  assert.equal(recovered.tools[0]?.state, 'interrupted');
  assert.equal(await exists(join(f.repository, 'unapproved.txt')), false);
  assert.equal(resumedCalls, 0, 'recovery does not automatically repeat provider/tool execution');
  const duplicate = await submit(f.engine, f.session.id, 'crash-request', config('build'));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.runId, ready.runId);
  assert.equal(resumedCalls, 0);
  const events = await replayThroughTerminal(f.engine, f.session.id);
  assert.equal(events.filter(terminal).length, 1);
  assert.equal(events.at(-1)?.type, 'run.interrupted');
  const followup = await submit(f.engine, f.session.id, 'explicit-followup');
  assert.equal((await f.engine.waitForRun(followup.runId)).state, 'completed');
  assert.equal(resumedCalls, 1);
});
