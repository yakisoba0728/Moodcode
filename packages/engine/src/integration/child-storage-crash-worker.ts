import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { DEFAULT_LIMITS, EngineError, type RunReceipt, type Session, type Workspace } from '@moodcode/contracts';
import { createEngine, type EngineOptions, type MoodcodeEngine } from '../engine.js';
import type { ProviderAdapter, ProviderEvent } from '../ports.js';
import type { EngineChildRequest } from '../child-tasks/engine-host.js';
import type { ProviderRecoveryRequest } from '../recovery/provider-contract.js';
import { CHILD_STORAGE_CRASH_PHASES, fixtureDatabase, fixtureSnapshot, stoppedFixtureSnapshot, type ChildStorageCrashPhase, type ChildStorageCrashReady } from './child-storage-crash.fixture.js';

// A private process runs actual SQLite/engine/Git code and authored local
// iterators only. The test kills this process, never a command/model account.
const [suppliedDirectory, suppliedPhase] = process.argv.slice(2);
if (!suppliedDirectory || !(CHILD_STORAGE_CRASH_PHASES as readonly string[]).includes(suppliedPhase ?? '')) throw new Error('Invalid child storage crash fixture');
const directory = realpathSync(suppliedDirectory), phase = suppliedPhase as ChildStorageCrashPhase;
const repository = join(directory, 'repository'), dbPath = join(directory, 'engine.sqlite'), artifactDir = join(directory, 'artifacts');
const providerLog = join(directory, 'provider-calls.jsonl');
const preludePrompt = 'Synthetic historical uncertainty before child crash.';
const parentPrompt = 'Synthetic held root for child crash.';
const childPrompt = 'Synthetic bounded child for crash.';
const partialText = 'Authored durable child partial 🧩';
let root!: MoodcodeEngine, child: MoodcodeEngine | undefined, childClosed = false, stopped = false;
let session!: Session, parentRunId = '', request!: EngineChildRequest, historicalDecision!: ProviderRecoveryRequest;

function stop(): void {
  if (stopped) return;
  assert.ok(root && child && session && request && historicalDecision);
  stopped = true;
  const task = root.children.tasks.list(session.id).find(value => value.requestId === request.requestId);
  assert.ok(task);
  const childDbPath = join(artifactDir, 'children', task.id, 'engine.sqlite');
  const childSnapshot = childClosed ? stoppedFixtureSnapshot(childDbPath, join(directory, '.worker-closed-evidence')) : fixtureSnapshot(fixtureDatabase(child.store));
  const childSessionId = String(childSnapshot.sessions[0]!.id), childRunId = childSnapshot.runs[0]?.id;
  const ready: ChildStorageCrashReady = { phase, sessionId: session.id, parentRunId, taskId: task.id, worktreeId: task.worktreeId,
    childDbPath, childSessionId, ...(typeof childRunId === 'string' ? { childRunId } : {}), childClosed, request, historicalDecision,
    root: fixtureSnapshot(fixtureDatabase(root.store)), child: childSnapshot };
  const data = JSON.stringify(ready);
  assert.ok(Buffer.byteLength(data) < 524288, 'Fixture evidence IPC file stays bounded');
  const readyPath = join(directory, `${phase}.ready.json`);
  writeFileSync(readyPath, data, { mode: 0o600 });
  process.send?.({ phase, readyPath, sha256: createHash('sha256').update(data).digest('hex') });
  process.kill(process.pid, 'SIGSTOP');
}
function configureChild(engine: MoodcodeEngine): void {
  child = engine;
  const admit = engine.store.admit.bind(engine.store);
  engine.store.admit = input => {
    const result = admit(input);
    if (phase === 'child-run-admitted') stop();
    return result;
  };
  const part = engine.store.putPart.bind(engine.store);
  engine.store.putPart = value => {
    const result = part(value);
    if (phase === 'partial-observed' && result.type === 'text' && result.text === partialText && result.state === 'open') stop();
    return result;
  };
  const commit = engine.store.commit.bind(engine.store);
  engine.store.commit = (runId, type, payload, change) => {
    const result = commit(runId, type, payload, change);
    if (phase === 'child-terminal' && type === 'run.completed') stop();
    return result;
  };
  const close = engine.close.bind(engine);
  engine.close = async () => { await close(); childClosed = true; };
}
function installRootHooks(): void {
  const put = root.store.putSessionDocument.bind(root.store);
  root.store.putSessionDocument = (id, kind, revision, data) => {
    const result = put(id, kind, revision, data);
    if (id !== session.id) return result;
    if (kind.startsWith('child.storage.')) {
      const binding = data.binding as { phase?: string } | undefined;
      if (phase === 'root-prepared' && binding?.phase === 'prepared') stop();
      if (phase === 'root-admitted' && binding?.phase === 'admitted' && data.confirmedClose === undefined) stop();
      if (phase === 'root-close-proof' && data.confirmedClose !== undefined) stop();
    }
    if (phase === 'task-outcome' && kind === 'engine.child_tasks') {
      const tasks = data.tasks as unknown as { requestId: string; state: string }[];
      if (tasks.some(task => task.requestId === request.requestId && task.state === 'completed')) stop();
    }
    return result;
  };
}
async function hold(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<never>((_, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
let enterParent!: () => void;
const parentEntered = new Promise<void>(resolve => { enterParent = resolve; });
const provider: ProviderAdapter = { id: 'child-storage-crash-fixture', async *streamTurn(turn, signal): AsyncGenerator<ProviderEvent> {
  const prompt = turn.messages.findLast(message => message.role === 'user')?.content;
  const purpose = prompt === preludePrompt ? 'historical' : prompt === parentPrompt ? 'parent' : 'child';
  const serialized = JSON.stringify(turn);
  appendFileSync(providerLog, JSON.stringify({ purpose, runId: turn.runId, attemptId: turn.attemptId,
    requestSha256: createHash('sha256').update(serialized).digest('hex'), requestBytes: Buffer.byteLength(serialized) }) + '\n', { mode: 0o600 });
  yield { type: 'progress', providerRequestId: `scripted-${purpose}-request` };
  yield { type: 'usage', inputTokens: 23, outputTokens: 3, cachedInputTokens: 4, reasoningOutputTokens: 1 };
  if (purpose === 'historical') {
    yield { type: 'text.delta', delta: 'Existing historical partial outcome remains uncertain.' };
    throw new EngineError('PROVIDER_TRANSPORT_ERROR', 'Authored historical unknown provider outcome');
  }
  if (purpose === 'parent') { enterParent(); await hold(signal); return; }
  assert.ok(child && turn.sessionId);
  await child.importDocument(turn.sessionId, Buffer.from('%PDF-1.7\nAuthored child crash document bytes.\n'));
  yield { type: 'text.delta', delta: partialText };
  yield { type: 'finish', reason: 'stop' };
} };
const options: EngineOptions = { dbPath, artifactDir, providers: [provider], allowedToolNames: ['read_file'], configureChild,
  defaults: { providerId: provider.id, modelId: 'local-scripted', mode: 'build',
    limits: { ...DEFAULT_LIMITS, maxTurns: 8, maxToolCalls: 8, maxContextBytes: 262144, maxOutputBytes: 65536, maxDurationMs: 120000 },
    budgets: { providerRequestTimeoutMs: 90000, providerInactivityTimeoutMs: 90000, maxProviderAttempts: 2 } } };
async function command<T>(engine: MoodcodeEngine, type: string, payload: Record<string, string>): Promise<T> {
  const result = await engine.dispatch({ schemaVersion: 1, commandId: `fixture-${type}`, type, payload });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.result as unknown as T;
}
async function main(): Promise<void> {
  mkdirSync(repository);
  const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args]);
  git(['init', '--quiet', '--template=', repository]);
  writeFileSync(join(repository, 'authored.txt'), 'Authored local crash repository.\n');
  git(['-C', repository, 'add', 'authored.txt']);
  git(['-C', repository, '-c', 'user.name=Local Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Authored crash fixture']);
  root = createEngine(options);
  const workspace = await command<Workspace>(root, 'workspace.open', { path: repository });
  session = await command<Session>(root, 'session.create', { workspaceId: workspace.id });
  // Make a real pre-existing host decision so preservation checks do not merely
  // compare empty ledgers. This explicit setup is never repeated after the cut.
  const historical = await command<RunReceipt>(root, 'run.submit', { sessionId: session.id, requestId: 'historical', prompt: preludePrompt });
  assert.equal((await root.waitForRun(historical.runId)).state, 'failed');
  await root.waitForSession(session.id);
  const originalAttempt = fixtureSnapshot(fixtureDatabase(root.store)).provider_attempts.find(row => row.run_id === historical.runId)!;
  assert.equal(originalAttempt.state, 'uncertain');
  await root.close();
  root = createEngine(options);
  const preview = root.getProviderRecoveryPreview(session.id, String(originalAttempt.id));
  assert.equal(preview.status, 'eligible', JSON.stringify(preview));
  historicalDecision = { sessionId: session.id, attemptId: String(originalAttempt.id), requestId: 'explicit-historical-host-decision', fingerprint: preview.fingerprint!, acknowledged: true };
  assert.equal((await root.acknowledgeProviderRecovery(historicalDecision)).providerRetried, false);
  root.scheduler.resume(session.id);
  const worktree = await root.createWorktree(session.id, 'isolated-crash-worktree');
  const parent = await command<RunReceipt>(root, 'run.submit', { sessionId: session.id, requestId: 'held-parent', prompt: parentPrompt });
  parentRunId = parent.runId;
  await parentEntered;
  request = { sessionId: session.id, requestId: 'one-child-request', parentRunId, worktreeId: worktree.id, prompt: childPrompt,
    tools: ['read_file'], allocation: { turns: 2, toolCalls: 1, outputBytes: 4096, durationMs: 60000 } };
  installRootHooks();
  const task = await root.startChildTask(request);
  await root.children.tasks.wait(session.id, task.id);
  throw new Error(`Fixture failed to stop at ${phase}`);
}
await main();
