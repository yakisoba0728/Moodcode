import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { DEFAULT_LIMITS, type ApprovalRecord, type JsonObject, type ProviderToolCall, type RunConfig, type RunReceipt, type Session, type SessionSnapshot, type Workspace } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import { EXTRACTIVE_MEMORY_PREFIX } from '../context/index.js';
import type { ProviderAdapter, ProviderEvent, ToolContext, ToolDefinition, TurnRequest } from '../ports.js';
import { createReadTools } from '../tools/read/index.js';
import { createPatchTool } from '../tools/patch/index.js';
import { createCommandTool } from '../tools/command/index.js';

const exec = promisify(execFile);
type Engine = ReturnType<typeof createEngine>;

class LocalProvider implements ProviderAdapter {
  readonly id = 'budget-test';
  readonly requests: TurnRequest[] = [];
  constructor(private readonly turn: (request: TurnRequest) => ProviderEvent[]) {}
  async *streamTurn(request: TurnRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    assert.equal(signal.aborted, false);
    this.requests.push(structuredClone(request));
    for (const event of this.turn(request)) yield event;
  }
}

const calls = (...items: ProviderToolCall[]): ProviderEvent[] => [...items.map(call => ({ type: 'tool.call' as const, call })), { type: 'finish', reason: 'tool_calls' }];
const answer = (text = 'Finished.'): ProviderEvent[] => [{ type: 'text.delta', delta: text }, { type: 'finish', reason: 'stop' }];
const previousTool = (request: TurnRequest) => request.messages.findLast(message => message.role === 'tool')!;

async function command<T>(engine: Engine, type: string, payload: JsonObject): Promise<T> {
  const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload });
  assert.equal(result.ok, true, `${type}: ${JSON.stringify(result.error)}`);
  return result.result as unknown as T;
}

async function fixture(t: TestContext, provider: ProviderAdapter, entries: Record<string, string>, tools?: ToolDefinition[]) {
  const root = await mkdtemp(join(tmpdir(), 'moodcode-budget-integration-'));
  const repository = join(root, 'repository');
  await mkdir(repository);
  await exec('git', ['init', '--quiet', '--template=', repository]);
  for (const [name, content] of Object.entries(entries)) {
    await mkdir(dirname(join(repository, name)), { recursive: true });
    await writeFile(join(repository, name), content);
  }
  const engine = createEngine({ dbPath: join(root, 'engine.sqlite'), artifactDir: join(root, 'artifacts'), providers: [provider], ...(tools ? { tools } : {}) });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = await command<Workspace>(engine, 'workspace.open', { path: repository });
  const session = await command<Session>(engine, 'session.create', { workspaceId: workspace.id, title: 'Output budget integration' });
  async function submit(maxOutputBytes: number, mode: 'plan' | 'build' = 'plan') {
    const config: RunConfig = { providerId: provider.id, modelId: 'local', mode, reasoningEffort: 'ultra', limits: { ...DEFAULT_LIMITS, maxOutputBytes, maxDurationMs: 15_000, toolTimeoutMs: 5_000 } };
    const receipt = await command<RunReceipt>(engine, 'run.submit', { sessionId: session.id, requestId: randomUUID(), prompt: 'Inspect the repository, make the requested change and report the result.', config: config as unknown as JsonObject });
    return engine.waitForRun(receipt.runId);
  }
  const snapshot = () => command<SessionSnapshot>(engine, 'session.getSnapshot', { sessionId: session.id });
  return { root, repository, engine, session, workspace, submit, snapshot };
}

function observedTools(onExecute: (name: string, context: ToolContext) => void): ToolDefinition[] {
  return createReadTools().map(tool => ({ ...tool, async execute(prepared, context) { onExecute(tool.name, context); return tool.execute(prepared, context); } }));
}

test('actual remaining tool budget bounds a large read as valid JSON while preserving a final answer and exact context metrics', { timeout: 15_000 }, async t => {
  const budgets: { name: string; bytes: number }[] = [];
  const provider = new LocalProvider(request => {
    if (request.turnIndex === 0) return [{ type: 'text.delta', delta: 'Inspecting.\n' }, ...calls({ id: 'list', name: 'list_files', input: {} })];
    if (request.turnIndex === 1) {
      const listed = JSON.parse(previousTool(request).content) as JsonObject;
      assert.deepEqual(listed.files, ['app.py', 'notes.py']);
      return calls({ id: 'read', name: 'read_file', input: { path: 'notes.py' } });
    }
    const read = JSON.parse(previousTool(request).content) as JsonObject;
    assert.equal(read.truncated, true);
    assert.equal(read.hasMore, true);
    assert.equal(typeof read.continuation, 'string');
    assert.ok((read.content as string).length > 0);
    assert.ok(!(read.content as string).includes('\uFFFD'));
    return answer('I inspected the available portion and can continue from the supplied cursor.');
  });
  const f = await fixture(t, provider, {
    'app.py': 'answer = 1\n', 'notes.py': '한국어🙂 observation\n'.repeat(3000),
    '.venv/lib/python3.14/site-packages/dependency.py': 'dependency should not be listed\n',
  }, observedTools((name, context) => budgets.push({ name, bytes: context.limits.maxOutputBytes })));
  const run = await f.submit(4096);
  assert.equal(run.state, 'completed', JSON.stringify(run.error));
  const snapshot = await f.snapshot();
  const toolMessages = snapshot.messages.filter(message => message.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.equal(budgets[0]!.bytes, 3072 - Buffer.byteLength('Inspecting.\n'));
  assert.equal(budgets[1]!.bytes, budgets[0]!.bytes - Buffer.byteLength(toolMessages[0]!.content));
  assert.ok(Buffer.byteLength(toolMessages[1]!.content) <= budgets[1]!.bytes);
  assert.ok(snapshot.messages.filter(message => message.role !== 'user').reduce((total, message) => total + Buffer.byteLength(message.content), 0) <= 4096);
  assert.match(snapshot.messages.at(-1)!.content, /supplied cursor/);
  const events = f.engine.store.readEvents(f.session.id, 0, 1000);
  const prepared = events.filter(event => event.type === 'context.prepared');
  assert.equal(prepared.length, provider.requests.length);
  for (let index = 0; index < provider.requests.length; index++) {
    const request = provider.requests[index]!;
    assert.equal(request.reasoningEffort, 'ultra');
    assert.deepEqual(prepared[index]!.payload, {
      turnIndex: request.turnIndex, bytes: Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools })),
      limit: run.config.limits.maxContextBytes,
      summaryIncluded: request.messages.some(message => message.role === 'assistant' && message.content.startsWith(EXTRACTIVE_MEMORY_PREFIX)),
    });
  }
  assert.deepEqual(f.engine.store.getMetrics(f.session.id).context, prepared.at(-1)!.payload);
});

test('a normalized identical readonly call returns a clear error without actual re-execution, and a narrower request still works', async t => {
  const executions: string[] = [];
  const provider = new LocalProvider(request => {
    if (request.turnIndex === 0) return calls({ id: 'first', name: 'read_file', input: { path: './app.py' } });
    if (request.turnIndex === 1) return calls({ id: 'repeat', name: 'read_file', input: { path: 'app.py', startLine: 1 } });
    if (request.turnIndex === 2) {
      const result = JSON.parse(previousTool(request).content) as { error: { code: string; message: string } };
      assert.equal(result.error.code, 'REPEATED_READ_TOOL_CALL');
      assert.match(result.error.message, /continuation.*different line range/);
      return calls({ id: 'narrower', name: 'read_file', input: { path: 'app.py', startLine: 2, endLine: 2 } });
    }
    assert.equal(JSON.parse(previousTool(request).content).content, 'second = 2\n');
    return answer('Used a narrower range after the duplicate read was rejected.');
  });
  const f = await fixture(t, provider, { 'app.py': 'first = 1\nsecond = 2\n' }, observedTools(name => executions.push(name)));
  assert.equal((await f.submit(8192)).state, 'completed');
  assert.deepEqual(executions, ['read_file', 'read_file']);
  const snapshot = await f.snapshot();
  assert.deepEqual(snapshot.tools.map(tool => tool.state), ['completed', 'failed', 'completed']);
  assert.ok(snapshot.tools[1]!.output!.includes('REPEATED_READ_TOOL_CALL'));
});

test('tiny output budgets keep generated read errors parseable and leave answer space', async t => {
  const provider = new LocalProvider(request => request.turnIndex < 2
    ? calls({ id: `read-${request.turnIndex}`, name: 'read_file', input: { path: 'app.py' } })
    : answer('Budget is small.'));
  const f = await fixture(t, provider, { 'app.py': 'answer = 1\n' });
  const run = await f.submit(64);
  assert.equal(run.state, 'completed', JSON.stringify(run.error));
  const snapshot = await f.snapshot();
  for (const message of snapshot.messages.filter(message => message.role === 'tool')) assert.doesNotThrow(() => JSON.parse(message.content));
  assert.equal(snapshot.messages.at(-1)!.content, 'Budget is small.');
  assert.ok(snapshot.messages.filter(message => message.role !== 'user').reduce((total, message) => total + Buffer.byteLength(message.content), 0) <= 64);
});

test('approved coding loop can reread the same file after effects and still finish under a small shared output budget', { skip: process.platform === 'win32', timeout: 15_000 }, async t => {
  const before = 'answer = 1\n';
  const after = 'answer = 2\n';
  let readExecutions = 0;
  const provider = new LocalProvider(request => {
    switch (request.turnIndex) {
      case 0: return calls({ id: 'before', name: 'read_file', input: { path: 'app.py' } });
      case 1: {
        const read = JSON.parse(previousTool(request).content) as { sha256: string; content: string };
        assert.equal(read.content, before);
        return calls({ id: 'patch', name: 'apply_patch', input: { changes: [{ path: 'app.py', expectedHash: read.sha256, content: after }] } });
      }
      case 2: return calls({ id: 'after', name: 'read_file', input: { path: './app.py' } });
      case 3: {
        const read = JSON.parse(previousTool(request).content) as { content: string };
        assert.equal(read.content, after);
        return calls({ id: 'check', name: 'run_command', input: { command: "printf 'checked\\n'" } });
      }
      default: assert.match(previousTool(request).content, /checked/); return answer('Updated app.py and checked the result.');
    }
  });
  const f = await fixture(t, provider, { 'app.py': before, '.venv/lib/python3.14/library.py': 'excluded\n' }, [
    ...observedTools(name => { if (name === 'read_file') readExecutions++; }), createPatchTool(), createCommandTool(),
  ]);
  const stop = new AbortController();
  t.after(() => stop.abort());
  const approvals = (async () => {
    for await (const event of f.engine.subscribe(f.session.id, 0, stop.signal)) {
      if (event.type === 'approval.requested') {
        const approval = f.engine.store.getSnapshot(f.session.id).approvals.find(record => record.status === 'pending') as ApprovalRecord;
        assert.ok(approval);
        await command(f.engine, 'approval.decide', { approvalId: approval.id, fingerprint: approval.fingerprint, decision: 'allow' });
      }
      if (event.type === 'run.completed' || event.type === 'run.failed') return;
    }
  })();
  const [run] = await Promise.all([f.submit(8192, 'build'), approvals]);
  assert.equal(run.state, 'completed', JSON.stringify(run.error));
  assert.equal(readExecutions, 2);
  assert.equal(await readFile(join(f.repository, 'app.py'), 'utf8'), after);
  const snapshot = await f.snapshot();
  assert.deepEqual(snapshot.tools.map(tool => tool.state), ['completed', 'completed', 'completed', 'completed']);
  assert.equal(snapshot.approvals.filter(approval => approval.status === 'allowed').length, 2);
  assert.equal(f.engine.store.listCheckpoints(run.id).length, 2);
  assert.equal(createHash('sha256').update(after).digest('hex'), JSON.parse(snapshot.tools[2]!.output!).sha256);
  assert.ok(snapshot.messages.filter(message => message.role !== 'user').reduce((total, message) => total + Buffer.byteLength(message.content), 0) <= 8192);
});
