import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandResult, EngineEvent, SessionSnapshot } from '@moodcode/contracts';

const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './index.ts' : './index.js', import.meta.url));
const { retainBackendFixture } = await import(new URL(`../../../packages/engine/${import.meta.url.endsWith('.ts') ? 'src' : 'dist'}/agent-backends/fixtures/backend.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url).href) as typeof import('../../../packages/engine/src/agent-backends/fixtures/backend.js');
interface ResultRecord extends CommandResult { type: 'result' }
interface EventRecord { type: 'event'; subscriptionId: string; event: EngineEvent }
type Record = ResultRecord | EventRecord;

class Client {
  readonly process: ChildProcessWithoutNullStreams;
  readonly records: Record[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  diagnostics = '';
  private sequence = 0;
  private buffer = '';

  constructor(args: string[]) {
    this.process = spawn(process.execPath, [...process.execArgv, entry, ...args], {
      stdio: 'pipe', env: { ...process.env, MOODCODE_API_KEY: 'fixture-only-key', OPENAI_API_KEY: '' },
    });
    this.process.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      for (;;) {
        const end = this.buffer.indexOf('\n');
        if (end === -1) break;
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        this.records.push(JSON.parse(line) as Record);
      }
    });
    this.process.stderr.on('data', (chunk: Buffer) => { this.diagnostics += chunk.toString(); });
    // A forced crash may race a pending write during test cleanup.
    this.process.stdin.on('error', () => {});
    this.exited = new Promise((resolve, reject) => {
      this.process.once('error', reject);
      this.process.once('close', (code, signal) => resolve({ code, signal }));
    });
  }

  async request<T>(type: string, payload: object): Promise<T> {
    const id = String(++this.sequence);
    this.process.stdin.write(JSON.stringify({ schemaVersion: 1, commandId: id, type, payload }) + '\n');
    await waitFor(() => this.records.some((record) => record.type === 'result' && record.commandId === id), () => `Missing ${type} result. ${this.diagnostics}`, this.process);
    const result = this.records.find((record): record is ResultRecord => record.type === 'result' && record.commandId === id)!;
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result.result as T;
  }

  async finish(): Promise<void> {
    this.process.stdin.end();
    const result = await bounded(this.exited, 12_000);
    assert.equal(result.code, 0, this.diagnostics);
    assert.equal(result.signal, null, this.diagnostics);
  }

  async kill(): Promise<void> {
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill('SIGKILL');
    await bounded(this.exited, 12_000);
  }
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Subprocess deadline exceeded')), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}

async function waitFor(condition: () => boolean, error: () => string = () => 'Condition timed out', child?: ChildProcessWithoutNullStreams): Promise<void> {
  const limit = Date.now() + 8_000;
  while (!condition()) {
    if (Date.now() > limit || (child && (child.exitCode !== null || child.signalCode !== null))) throw new Error(error());
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function workspace(t: TestContext) {
  const root = await mkdtemp(join(process.env.MOODCODE_HARNESS_FIXTURE_ROOT ?? tmpdir(), 'moodcode-harness-test-'));
  const clients = new Set<Client>();
  const cleanup = async () => {
    const settled = await Promise.allSettled([...clients].map(value => value.kill()));
    const failure = settled.find(result => result.status === 'rejected');
    // Native child exit does not reconstruct its missing Engine after hook.
    await retainBackendFixture(t, root, new Set(), { originalAfterHookObserved: false,
      ...(failure?.status === 'rejected' ? { ownerExitError: { error: failure.reason } } : {}) });
  };
  t.after(cleanup);
  const path = join(root, 'workspace');
  execFileSync('git', ['init', '-q', path], { stdio: 'pipe' });
  return { root, path, db: join(root, 'engine.sqlite'), artifacts: join(root, 'artifacts'), clients, cleanup };
}

function client(t: TestContext, paths: Awaited<ReturnType<typeof workspace>>, args: string[] = []): Client {
  const value = new Client(['--db', paths.db, '--artifacts', paths.artifacts, ...args]);
  paths.clients.add(value);
  return value;
}

async function openSession(value: Client, path: string): Promise<string> {
  const opened = await value.request<{ id: string }>('workspace.open', { path });
  const session = await value.request<{ id: string }>('session.create', { workspaceId: opened.id, title: 'Protocol fixture' });
  await value.request('events.subscribe', { sessionId: session.id, afterSeq: 0 });
  return session.id;
}

function terminal(value: Client, runId: string, type: string): boolean {
  return value.records.some((record) => record.type === 'event' && record.event.runId === runId && record.event.type === type);
}

async function httpFixture(t: TestContext, respond: (response: ServerResponse, requestIndex: number) => void): Promise<{ baseURL: string; requests: () => number }> {
  let requests = 0;
  const server: Server = createServer((request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer fixture-only-key');
    request.resume();
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    respond(response, requests++);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, requests: () => requests };
}

function sse(response: ServerResponse, delta: object, finish: string | null = null): void {
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}

test('CLI scripted run persists across EOF/restart and afterSeq replays committed records', { timeout: 20_000 }, async (t) => {
  const paths = await workspace(t);
  const first = client(t, paths);
  const sessionId = await openSession(first, paths.path);
  const receipt = await first.request<{ runId: string }>('run.submit', { sessionId, requestId: 'persistent-request', prompt: 'harness fixture' });
  await waitFor(() => terminal(first, receipt.runId, 'run.completed'), () => first.diagnostics, first.process);
  const snapshot = await first.request<SessionSnapshot>('session.getSnapshot', { sessionId });
  assert.equal(snapshot.runs[0]?.state, 'completed');
  assert.ok(snapshot.messages.some((message) => message.role === 'assistant' && message.content.includes('harness fixture')));
  await first.finish();

  const second = client(t, paths);
  const reopened = await second.request<SessionSnapshot>('session.getSnapshot', { sessionId });
  assert.deepEqual(reopened.messages, snapshot.messages);
  const duplicate = await second.request<{ runId: string; duplicate: boolean }>('run.submit', { sessionId, requestId: 'persistent-request', prompt: 'harness fixture' });
  assert.equal(duplicate.runId, receipt.runId);
  assert.equal(duplicate.duplicate, true);
  const cursor = reopened.lastSeq - 1;
  await second.request('events.subscribe', { sessionId, afterSeq: cursor });
  await waitFor(() => second.records.some((record) => record.type === 'event'));
  const events = second.records.filter((record): record is EventRecord => record.type === 'event');
  assert.deepEqual(events.map((record) => record.event.seq), [reopened.lastSeq]);
  await second.finish();
});

test('CLI receives run.cancel while a local provider stream is still open', { timeout: 20_000 }, async (t) => {
  const paths = await workspace(t);
  const fixture = await httpFixture(t, (response) => sse(response, { content: 'pending' }));
  const value = client(t, paths, ['--provider', 'openai-compatible', '--base-url', fixture.baseURL, '--model', 'fixture']);
  const sessionId = await openSession(value, paths.path);
  const receipt = await value.request<{ runId: string }>('run.submit', { sessionId, requestId: 'cancel-request', prompt: 'hold fixture stream' });
  await waitFor(() => fixture.requests() === 1, () => value.diagnostics, value.process);
  await value.request('run.cancel', { runId: receipt.runId });
  await waitFor(() => terminal(value, receipt.runId, 'run.cancelled'), () => value.diagnostics, value.process);
  const snapshot = await value.request<SessionSnapshot>('session.getSnapshot', { sessionId });
  assert.equal(snapshot.runs[0]?.state, 'cancelled');
  await value.finish();
});

for (const method of ['eof', 'SIGTERM', 'SIGKILL'] as const) {
  test(`CLI ${method} cleanup/recovery preserves the run without replaying provider effects`, { timeout: 20_000 }, async (t) => {
    const paths = await workspace(t);
    const fixture = await httpFixture(t, (response) => sse(response, { content: 'pending' }));
    const first = client(t, paths, ['--provider', 'openai-compatible', '--base-url', fixture.baseURL, '--model', 'fixture']);
    const sessionId = await openSession(first, paths.path);
    const receipt = await first.request<{ runId: string }>('run.submit', { sessionId, requestId: 'recovery-request', prompt: 'hold fixture stream' });
    await waitFor(() => fixture.requests() === 1, () => first.diagnostics, first.process);
    if (method === 'eof') await first.finish();
    else {
      first.process.kill(method);
      const result = await bounded(first.exited, 12_000);
      if (method === 'SIGTERM') { assert.equal(result.code, 0, first.diagnostics); assert.equal(result.signal, null); }
      else assert.equal(result.signal, 'SIGKILL');
    }
    const second = client(t, paths);
    const snapshot = await second.request<SessionSnapshot>('session.getSnapshot', { sessionId });
    assert.equal(snapshot.runs.find((run) => run.id === receipt.runId)?.state, method === 'SIGKILL' ? 'interrupted' : 'cancelled');
    assert.equal(fixture.requests(), 1);
    await second.finish();
    if (method === 'SIGKILL') {
      await paths.cleanup();
      assert.ok((await readFile(paths.db)).length > 0, 'Actual interrupted Original database survives teardown');
      const retained = JSON.parse(await readFile(join(paths.root, 'fixture-retention.json'), 'utf8'));
      assert.equal(retained.databaseRemoved, false); assert.equal(retained.nativeCleanupConfirmed, null);
      assert.equal(retained.originalAfterHookObserved, false);
      assert.equal(first.process.signalCode, 'SIGKILL'); assert.equal(second.process.exitCode, 0);
      assert.equal(fixture.requests(), 1, 'Retention never replays the original provider effect');
    }
  });
}

test('CLI receives approval.decide during a build run and returns the actual patch diff', { timeout: 20_000 }, async (t) => {
  const paths = await workspace(t);
  const fixture = await httpFixture(t, (response, index) => {
    if (index === 0) {
      sse(response, { tool_calls: [{ index: 0, id: 'fixture-patch', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ changes: [{ path: 'approved.txt', expectedHash: null, content: 'fixture approved\n' }] }) } }] });
      sse(response, {}, 'tool_calls');
    } else { sse(response, { content: 'fixture completed' }); sse(response, {}, 'stop'); }
    response.end('data: [DONE]\n\n');
  });
  const value = client(t, paths, ['--provider', 'openai-compatible', '--base-url', fixture.baseURL, '--model', 'fixture']);
  const sessionId = await openSession(value, paths.path);
  const receipt = await value.request<{ runId: string }>('run.submit', { sessionId, requestId: 'approval-request', prompt: 'apply fixture patch', config: { mode: 'build' } });
  await waitFor(() => value.records.some((record) => record.type === 'event' && record.event.type === 'approval.requested'), () => value.diagnostics, value.process);
  const pending = await value.request<SessionSnapshot>('session.getSnapshot', { sessionId });
  const approval = pending.approvals.find((item) => item.status === 'pending');
  assert.ok(approval);
  await assert.rejects(readFile(join(paths.path, 'approved.txt')));
  await value.request('approval.decide', { approvalId: approval.id, decision: 'allow', fingerprint: approval.fingerprint });
  await waitFor(() => terminal(value, receipt.runId, 'run.completed'), () => value.diagnostics, value.process);
  const completed = await value.request<SessionSnapshot>('session.getSnapshot', { sessionId });
  const patch = completed.tools.find((tool) => tool.name === 'apply_patch');
  assert.equal(patch?.state, 'completed', JSON.stringify(patch));
  assert.equal(await readFile(join(paths.path, 'approved.txt'), 'utf8'), 'fixture approved\n');
  const diff = await value.request<{ files: { path: string; before: string | null; after: string | null }[] }>('review.getDiff', { runId: receipt.runId });
  assert.deepEqual(diff.files.map(({ path, before, after }) => ({ path, before, after })), [{ path: 'approved.txt', before: null, after: 'fixture approved\n' }]);
  assert.equal(fixture.requests(), 2);
  assert.ok(!value.diagnostics.includes('fixture-only-key'));
  await value.finish();
});
