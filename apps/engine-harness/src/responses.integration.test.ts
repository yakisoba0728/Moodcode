import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIMITS, type CommandResult, type EngineCapabilities, type EngineEvent, type RunConfigInput, type SessionSnapshot } from '@moodcode/contracts';

const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './index.ts' : './index.js', import.meta.url));
const { retainBackendFixture } = await import(new URL(`../../../packages/engine/${import.meta.url.endsWith('.ts') ? 'src' : 'dist'}/agent-backends/fixtures/backend.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url).href) as typeof import('../../../packages/engine/src/agent-backends/fixtures/backend.js');
const keyEnv = 'MOODCODE_RESPONSES_CLI_FIXTURE_KEY';
const fixtureKey = 'responses-fixture-bearer-8462';
interface ResultRecord extends CommandResult { type: 'result' }
interface EventRecord { type: 'event'; subscriptionId: string; event: EngineEvent }
type ProtocolRecord = ResultRecord | EventRecord;

class Client {
  readonly process: ChildProcessWithoutNullStreams;
  readonly records: ProtocolRecord[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout = '';
  diagnostics = '';
  private buffer = '';
  private parseError: Error | undefined;
  private sequence = 0;

  constructor(args: readonly string[], environment: NodeJS.ProcessEnv = {}) {
    this.process = spawn(process.execPath, [...process.execArgv, entry, ...args], {
      stdio: 'pipe',
      env: { ...process.env, MOODCODE_API_KEY: '', OPENAI_API_KEY: '', [keyEnv]: fixtureKey, ...environment },
    });
    this.process.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.stdout += text;
      this.buffer += text;
      for (;;) {
        const end = this.buffer.indexOf('\n');
        if (end === -1) break;
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try { this.records.push(JSON.parse(line) as ProtocolRecord); }
        catch { this.parseError = new Error('CLI stdout contained a non-JSONL record'); }
      }
    });
    this.process.stderr.on('data', (chunk: Buffer) => { this.diagnostics += chunk.toString(); });
    this.process.stdin.on('error', () => {});
    this.exited = new Promise((resolve, reject) => {
      this.process.once('error', reject);
      this.process.once('close', (code, signal) => resolve({ code, signal }));
    });
  }

  async request<T>(type: string, payload: object): Promise<T> {
    const commandId = String(++this.sequence);
    this.process.stdin.write(JSON.stringify({ schemaVersion: 1, commandId, type, payload }) + '\n');
    await this.wait(() => this.records.some((record) => record.type === 'result' && record.commandId === commandId), `Missing ${type} result`);
    const record = this.records.find((item): item is ResultRecord => item.type === 'result' && item.commandId === commandId)!;
    assert.equal(record.ok, true, JSON.stringify(record.error));
    return record.result as T;
  }

  async wait(condition: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      if (this.parseError) throw this.parseError;
      if (Date.now() > deadline || this.process.exitCode !== null || this.process.signalCode !== null) {
        throw new Error(`${message}. ${this.diagnostics}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (this.parseError) throw this.parseError;
  }

  async completed(runId: string): Promise<void> {
    await this.wait(() => this.records.some((record) => record.type === 'event'
      && record.event.runId === runId && ['run.completed', 'run.failed', 'run.cancelled'].includes(record.event.type)), 'Missing terminal run event');
    const terminal = this.records.find((record): record is EventRecord => record.type === 'event'
      && record.event.runId === runId && ['run.completed', 'run.failed', 'run.cancelled'].includes(record.event.type))!;
    assert.equal(terminal.event.type, 'run.completed', JSON.stringify(terminal.event.payload));
  }

  async finish(): Promise<void> {
    this.process.stdin.end();
    const exited = await bounded(this.exited);
    assert.equal(exited.code, 0, this.diagnostics);
    assert.equal(exited.signal, null, this.diagnostics);
    if (this.parseError) throw this.parseError;
    assert.equal(this.buffer, '', 'CLI left an incomplete stdout record');
  }

  async kill(): Promise<void> {
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill('SIGKILL');
    await bounded(this.exited);
  }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('CLI subprocess deadline exceeded')), 12_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

interface Paths { root: string; workspace: string; db: string; artifacts: string; clients: Set<Client>; cleanup(): Promise<void> }
async function workspace(t: TestContext): Promise<Paths> {
  // loadConfig intentionally refuses symlink parents; macOS /var aliases /private/var.
  const root = await realpath(await mkdtemp(join(process.env.MOODCODE_HARNESS_FIXTURE_ROOT ?? tmpdir(), 'moodcode-responses-cli-')));
  const clients = new Set<Client>();
  const cleanup = async () => {
    const settled = await Promise.allSettled([...clients].map(value => value.kill()));
    const failure = settled.find(result => result.status === 'rejected');
    await retainBackendFixture(t, root, new Set(), { originalAfterHookObserved: false,
      ...(failure?.status === 'rejected' ? { ownerExitError: { error: failure.reason } } : {}) });
  };
  t.after(cleanup);
  const path = join(root, 'workspace');
  execFileSync('git', ['init', '-q', path], { stdio: 'pipe' });
  return { root, workspace: path, db: join(root, 'engine.sqlite'), artifacts: join(root, 'artifacts'), clients, cleanup };
}

function client(t: TestContext, paths: Paths, args: readonly string[], environment?: NodeJS.ProcessEnv): Client {
  const value = new Client(['--db', paths.db, '--artifacts', paths.artifacts, ...args], environment);
  paths.clients.add(value);
  return value;
}

async function config(paths: Paths, name: string, value: object): Promise<string> {
  const path = join(paths.root, name);
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

async function openSession(value: Client, path: string): Promise<string> {
  const opened = await value.request<{ id: string }>('workspace.open', { path });
  const session = await value.request<{ id: string }>('session.create', { workspaceId: opened.id, title: 'Responses CLI fixture' });
  await value.request('events.subscribe', { sessionId: session.id, afterSeq: 0 });
  return session.id;
}

interface HttpRequest { method: string | undefined; url: string | undefined; authorization: string | undefined; body: { model?: string; stream?: boolean; store?: boolean; input?: unknown[]; tools?: unknown[] } }
async function responsesFixture(t: TestContext, deltas: readonly string[] = ['native ', 'Responses fixture']): Promise<{ baseURL: string; requests: HttpRequest[] }> {
  const requests: HttpRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: HttpRequest['body'];
      try { body = JSON.parse(Buffer.concat(chunks).toString()) as HttpRequest['body']; }
      catch { response.writeHead(400).end(); return; }
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      responseText(response, deltas);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, requests };
}

function responseText(response: ServerResponse, deltas: readonly string[]): void {
  let sequence = 0;
  const responseId = 'resp_cli_fixture';
  const itemId = 'msg_cli_fixture';
  const text = deltas.join('');
  const emit = (event: object) => response.write(`data: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
  emit({ type: 'response.created', response: { id: responseId, status: 'in_progress' } });
  emit({ type: 'response.in_progress', response: { id: responseId, status: 'in_progress' } });
  emit({ type: 'response.output_item.added', output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
  emit({ type: 'response.content_part.added', output_index: 0, item_id: itemId, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  for (const delta of deltas) emit({ type: 'response.output_text.delta', output_index: 0, item_id: itemId, content_index: 0, delta });
  emit({ type: 'response.output_text.done', output_index: 0, item_id: itemId, content_index: 0, text });
  const part = { type: 'output_text', text, annotations: [] };
  emit({ type: 'response.content_part.done', output_index: 0, item_id: itemId, content_index: 0, part });
  const item = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [part] };
  emit({ type: 'response.output_item.done', output_index: 0, item });
  emit({ type: 'response.completed', response: { id: responseId, status: 'completed', output: [item], usage: { input_tokens: 17, output_tokens: 6 } } });
  response.end();
}

function assertRequest(request: HttpRequest | undefined, model: string, prompt: string, key = fixtureKey): void {
  assert.ok(request, 'Fixture received no provider request');
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/v1/responses');
  assert.equal(request.authorization, `Bearer ${key}`);
  assert.equal(request.body.model, model);
  assert.equal(request.body.stream, true);
  assert.equal(request.body.store, false);
  assert.ok(Array.isArray(request.body.input));
  assert.ok(request.body.input.some((item) => item !== null && typeof item === 'object'
    && 'role' in item && item.role === 'user' && 'content' in item && item.content === prompt), 'Responses input must contain the submitted user message');
  assert.ok(Array.isArray(request.body.tools));
  assert.ok(request.body.tools.length > 0);
  for (const tool of request.body.tools) {
    assert.ok(tool !== null && typeof tool === 'object');
    assert.equal('type' in tool && tool.type, 'function');
    assert.equal('name' in tool && typeof tool.name, 'string');
    assert.equal('parameters' in tool && typeof tool.parameters, 'object');
    assert.equal('strict' in tool && tool.strict, false);
  }
}

function assertPublicRedacted(value: Client, secret: string): void {
  assert.equal(value.stdout.includes(secret), false, 'Credential appeared in public JSONL');
  assert.equal(value.diagnostics.includes(secret), false, 'Credential appeared in stderr');
  assert.equal(JSON.stringify(value.records).includes(secret), false, 'Credential appeared in public result/event records');
}

async function assertDatabaseRedacted(db: string, secret: string, requireWal = false): Promise<void> {
  const database = await readFile(db);
  assert.ok(database.length > 0);
  assert.equal(database.includes(Buffer.from(secret)), false, 'Credential reached durable SQLite records');
  const wal = await readFile(`${db}-wal`).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  });
  if (requireWal) assert.ok(wal.length > 0, 'Live journal writes must be inspected before WAL cleanup');
  assert.equal(wal.includes(Buffer.from(secret)), false, 'Credential reached SQLite WAL');
}

test('CLI file-only Responses selection uses named env auth, preserves defaults and redacts reflected credentials durably', { timeout: 25_000 }, async (t) => {
  const paths = await workspace(t);
  const fixture = await responsesFixture(t, ['credential=', fixtureKey.slice(0, 11), fixtureKey.slice(11), ' complete']);
  const limits = { ...DEFAULT_LIMITS, maxTurns: 4, maxToolCalls: 8, maxDurationMs: 20_000, toolTimeoutMs: 3_000, maxOutputBytes: 8_192, maxContextBytes: 32_768 };
  const userConfigPath = await config(paths, 'user.json', {
    providerId: 'openai-responses', modelId: 'file-responses-model', mode: 'build', limits,
    providers: { 'openai-responses': { baseURL: fixture.baseURL, apiKeyEnv: keyEnv } },
  });
  const value = client(t, paths, ['--config', userConfigPath]);
  const capabilities = await value.request<EngineCapabilities>('engine.getCapabilities', {});
  assert.ok(capabilities.providerIds.includes('openai-responses'));
  assert.ok(capabilities.providerIds.includes('scripted'));
  assert.deepEqual(capabilities.defaults, { providerId: 'openai-responses', modelId: 'file-responses-model', mode: 'build', limits });
  assert.deepEqual(capabilities.modes, ['plan', 'build']);
  assert.ok(capabilities.tools.some((tool) => tool.name === 'run_command'));
  const sessionId = await openSession(value, paths.workspace);
  const receipt = await value.request<{ runId: string }>('run.submit', { sessionId, requestId: 'file-responses-request', prompt: 'Return fixture text' });
  await value.completed(receipt.runId);
  assert.equal(fixture.requests.length, 1);
  assertRequest(fixture.requests[0], 'file-responses-model', 'Return fixture text');
  const snapshot = await value.request<SessionSnapshot>('session.getSnapshot', { sessionId });
  assert.deepEqual(snapshot.runs[0]?.config, capabilities.defaults);
  assert.ok(snapshot.messages.some((message) => message.role === 'assistant' && message.content === 'credential=[REDACTED] complete'));
  await assertDatabaseRedacted(paths.db, fixtureKey, true);
  assertPublicRedacted(value, fixtureKey);
  await value.finish();
  assertPublicRedacted(value, fixtureKey);
  await assertDatabaseRedacted(paths.db, fixtureKey);

  const reopened = client(t, paths, []);
  const persisted = await reopened.request<SessionSnapshot>('session.getSnapshot', { sessionId });
  assert.deepEqual(persisted.messages, snapshot.messages);
  assert.deepEqual(persisted.runs, snapshot.runs);
  await reopened.request('events.subscribe', { sessionId, afterSeq: 0 });
  await reopened.wait(() => reopened.records.some((record) => record.type === 'event' && record.event.seq === snapshot.lastSeq), 'Missing persisted Responses event replay');
  assertPublicRedacted(reopened, fixtureKey);
  assert.equal(fixture.requests.length, 1, 'Reopening must not call the provider again');
  await reopened.finish();
  assertPublicRedacted(reopened, fixtureKey);
});

test('CLI workspace config overrides user fields and merges provider env references and partial limits', { timeout: 25_000 }, async (t) => {
  const paths = await workspace(t);
  const userFixture = await responsesFixture(t);
  const workspaceFixture = await responsesFixture(t, ['workspace fixture']);
  const userConfigPath = await config(paths, 'user.json', {
    providerId: 'openai-responses', modelId: 'user-model', mode: 'plan', limits: { maxTurns: 7, maxToolCalls: 11 },
    providers: { 'openai-responses': { baseURL: userFixture.baseURL, apiKeyEnv: keyEnv } },
  });
  const workspaceConfigPath = await config(paths, 'workspace.json', {
    modelId: 'workspace-model', mode: 'build', limits: { maxToolCalls: 6, maxOutputBytes: 4_096 },
    providers: { 'openai-responses': { baseURL: workspaceFixture.baseURL } },
  });
  const value = client(t, paths, ['--config', userConfigPath, '--workspace-config', workspaceConfigPath]);
  const sessionId = await openSession(value, paths.workspace);
  const receipt = await value.request<{ runId: string }>('run.submit', { sessionId, requestId: 'workspace-config-request', prompt: 'Select workspace fixture' });
  await value.completed(receipt.runId);
  assert.equal(userFixture.requests.length, 0);
  assert.equal(workspaceFixture.requests.length, 1);
  assertRequest(workspaceFixture.requests[0], 'workspace-model', 'Select workspace fixture');
  const snapshot = await value.request<SessionSnapshot>('session.getSnapshot', { sessionId });
  assert.deepEqual(snapshot.runs[0]?.config, {
    providerId: 'openai-responses', modelId: 'workspace-model', mode: 'build',
    limits: { ...DEFAULT_LIMITS, maxTurns: 7, maxToolCalls: 6, maxOutputBytes: 4_096 },
  });
  assertPublicRedacted(value, fixtureKey);
  await value.finish();
  assertPublicRedacted(value, fixtureKey);
});

test('CLI explicit provider, model and base URL override both files and contact only the selected Responses endpoint', { timeout: 25_000 }, async (t) => {
  const paths = await workspace(t);
  const userFixture = await responsesFixture(t);
  const workspaceFixture = await responsesFixture(t);
  const cliFixture = await responsesFixture(t, ['CLI endpoint fixture']);
  const userConfigPath = await config(paths, 'user.json', {
    providerId: 'openai-compatible', modelId: 'user-model', mode: 'plan',
    providers: {
      'openai-compatible': { baseURL: userFixture.baseURL, apiKeyEnv: keyEnv },
      'openai-responses': { baseURL: userFixture.baseURL, apiKeyEnv: keyEnv },
    },
  });
  const workspaceConfigPath = await config(paths, 'workspace.json', {
    modelId: 'workspace-model', mode: 'build', limits: { maxTurns: 5 },
    providers: {
      'openai-compatible': { baseURL: workspaceFixture.baseURL },
      'openai-responses': { baseURL: workspaceFixture.baseURL },
    },
  });
  const value = client(t, paths, ['--config', userConfigPath, '--workspace-config', workspaceConfigPath,
    '--provider', 'openai-responses', '--model', 'cli-model', '--base-url', cliFixture.baseURL]);
  const sessionId = await openSession(value, paths.workspace);
  const receipt = await value.request<{ runId: string }>('run.submit', { sessionId, requestId: 'cli-priority-request', prompt: 'Select CLI fixture' });
  await value.completed(receipt.runId);
  assert.equal(userFixture.requests.length, 0);
  assert.equal(workspaceFixture.requests.length, 0);
  assert.equal(cliFixture.requests.length, 1);
  assertRequest(cliFixture.requests[0], 'cli-model', 'Select CLI fixture');
  const snapshot = await value.request<SessionSnapshot>('session.getSnapshot', { sessionId });
  assert.deepEqual(snapshot.runs[0]?.config, { providerId: 'openai-responses', modelId: 'cli-model', mode: 'build', limits: { ...DEFAULT_LIMITS, maxTurns: 5 } });
  assertPublicRedacted(value, fixtureKey);
  await value.finish();
  assertPublicRedacted(value, fixtureKey);
});

test('CLI incoming run.submit config overrides provider, model, mode and individual limits', { timeout: 25_000 }, async (t) => {
  const paths = await workspace(t);
  const fixture = await responsesFixture(t);
  const userConfigPath = await config(paths, 'user.json', {
    providerId: 'openai-responses', modelId: 'file-model', mode: 'build', limits: { maxTurns: 8, maxToolCalls: 9, maxOutputBytes: 8_192 },
    providers: { 'openai-responses': { baseURL: fixture.baseURL, apiKeyEnv: keyEnv } },
  });
  const value = client(t, paths, ['--config', userConfigPath, '--model', 'cli-model']);
  const sessionId = await openSession(value, paths.workspace);
  const incomingNative: RunConfigInput = { modelId: 'incoming-native-model', mode: 'plan', limits: { maxTurns: 2 } };
  const native = await value.request<{ runId: string }>('run.submit', { sessionId, requestId: 'incoming-native-request', prompt: 'Select incoming native model', config: incomingNative });
  await value.completed(native.runId);
  assertRequest(fixture.requests[0], 'incoming-native-model', 'Select incoming native model');
  const incomingScripted: RunConfigInput = { providerId: 'scripted', modelId: 'incoming-local-model', mode: 'plan', limits: { maxToolCalls: 3 } };
  const scripted = await value.request<{ runId: string }>('run.submit', { sessionId, requestId: 'incoming-scripted-request', prompt: 'Select incoming scripted provider', config: incomingScripted });
  await value.completed(scripted.runId);
  assert.equal(fixture.requests.length, 1, 'Scripted override must not contact the remote fixture');
  const snapshot = await value.request<SessionSnapshot>('session.getSnapshot', { sessionId });
  assert.deepEqual(snapshot.runs.find((run) => run.id === native.runId)?.config, {
    providerId: 'openai-responses', modelId: 'incoming-native-model', mode: 'plan',
    limits: { ...DEFAULT_LIMITS, maxTurns: 2, maxToolCalls: 9, maxOutputBytes: 8_192 },
  });
  assert.deepEqual(snapshot.runs.find((run) => run.id === scripted.runId)?.config, {
    providerId: 'scripted', modelId: 'incoming-local-model', mode: 'plan',
    limits: { ...DEFAULT_LIMITS, maxTurns: 8, maxToolCalls: 3, maxOutputBytes: 8_192 },
  });
  assertPublicRedacted(value, fixtureKey);
  await value.finish();
  assertPublicRedacted(value, fixtureKey);
});

test('CLI incoming override activates a configured Responses provider lazily from scripted defaults', { timeout: 25_000 }, async (t) => {
  const paths = await workspace(t);
  const lazyKey = 'lazy-responses-fixture-key-6031';
  const lazyEnv = 'MOODCODE_RESPONSES_CLI_LAZY_KEY';
  const fixture = await responsesFixture(t, ['lazy credential=', lazyKey.slice(0, 12), lazyKey.slice(12), ' activated']);
  const userConfigPath = await config(paths, 'lazy-provider.json', {
    providerId: 'scripted', modelId: 'local', mode: 'plan', limits: { maxTurns: 5, maxToolCalls: 7 },
    providers: { 'openai-responses': { baseURL: fixture.baseURL, apiKeyEnv: lazyEnv } },
  });
  const value = client(t, paths, ['--config', userConfigPath], { [lazyEnv]: lazyKey });
  const capabilities = await value.request<EngineCapabilities>('engine.getCapabilities', {});
  assert.deepEqual(capabilities.providerIds, ['openai-responses', 'scripted']);
  assert.equal(capabilities.defaults.providerId, 'scripted');
  assert.equal(capabilities.defaults.modelId, 'local');
  assert.equal(fixture.requests.length, 0, 'Startup and capability queries must not contact the configured remote');
  const sessionId = await openSession(value, paths.workspace);
  const scripted = await value.request<{ runId: string }>('run.submit', { sessionId, requestId: 'lazy-initial-scripted', prompt: 'Remain on local scripted defaults' });
  await value.completed(scripted.runId);
  assert.equal(fixture.requests.length, 0, 'Default scripted runs must not contact the configured remote');
  const prompt = 'Activate the configured Responses fixture';
  const native = await value.request<{ runId: string }>('run.submit', {
    sessionId, requestId: 'lazy-incoming-responses', prompt,
    config: { providerId: 'openai-responses', modelId: 'lazy-incoming-model', mode: 'build', limits: { maxToolCalls: 3 } },
  });
  await value.completed(native.runId);
  assert.equal(fixture.requests.length, 1);
  assertRequest(fixture.requests[0], 'lazy-incoming-model', prompt, lazyKey);
  const snapshot = await value.request<SessionSnapshot>('session.getSnapshot', { sessionId });
  assert.deepEqual(snapshot.runs.find((run) => run.id === native.runId)?.config, {
    providerId: 'openai-responses', modelId: 'lazy-incoming-model', mode: 'build',
    limits: { ...DEFAULT_LIMITS, maxTurns: 5, maxToolCalls: 3 },
  });
  assert.ok(snapshot.messages.some((message) => message.runId === native.runId && message.role === 'assistant'
    && message.content === 'lazy credential=[REDACTED] activated'));
  await assertDatabaseRedacted(paths.db, lazyKey, true);
  assertPublicRedacted(value, lazyKey);
  await value.finish();
  assertPublicRedacted(value, lazyKey);
  await assertDatabaseRedacted(paths.db, lazyKey);
});

test('CLI rejects API key arguments and unknown argument values without echoing supplied secrets', { timeout: 25_000 }, async (t) => {
  const paths = await workspace(t);
  const argumentKey = 'argument-fixture-secret-5917';
  for (const args of [
    ['--api-key', argumentKey], ['--api_key=' + argumentKey], ['--token=' + argumentKey], ['--custom-option=' + argumentKey],
  ]) {
    const value = client(t, paths, args);
    const exited = await bounded(value.exited);
    assert.equal(exited.code, 1);
    assert.equal(exited.signal, null);
    assert.equal(value.stdout, '');
    assert.match(value.diagnostics, /API keys|Unknown CLI option/);
    assertPublicRedacted(value, argumentKey);
    assertPublicRedacted(value, fixtureKey);
  }
});

test('CLI named credential env is exclusive and missing values fail before provider transport', { timeout: 25_000 }, async (t) => {
  const paths = await workspace(t);
  const fixture = await responsesFixture(t);
  const missingEnv = 'MOODCODE_RESPONSES_CLI_MISSING_KEY';
  const fallbackKey = 'fallback-fixture-bearer-2183';
  const userConfigPath = await config(paths, 'missing-key.json', {
    providerId: 'openai-responses', modelId: 'fixture-model',
    providers: { 'openai-responses': { baseURL: fixture.baseURL, apiKeyEnv: missingEnv } },
  });
  const value = client(t, paths, ['--config', userConfigPath], {
    [missingEnv]: '', MOODCODE_API_KEY: fallbackKey, OPENAI_API_KEY: fallbackKey,
  });
  const exited = await bounded(value.exited);
  assert.equal(exited.code, 1, value.diagnostics);
  assert.equal(exited.signal, null);
  assert.equal(fixture.requests.length, 0);
  assert.equal(value.stdout, '');
  assert.match(value.diagnostics, /environment|credential|API key|keyEnv|MOODCODE_RESPONSES_CLI_MISSING_KEY/i);
  assertPublicRedacted(value, fallbackKey);
  assertPublicRedacted(value, fixtureKey);

  const unknownConfigPath = await config(paths, 'unknown-provider.json', {
    providerId: 'unknown-fixture-provider', modelId: 'fixture-model',
    providers: { 'unknown-fixture-provider': { baseURL: fixture.baseURL, apiKeyEnv: keyEnv } },
  });
  const unknown = client(t, paths, ['--config', unknownConfigPath]);
  const unknownExit = await bounded(unknown.exited);
  assert.equal(unknownExit.code, 1, unknown.diagnostics);
  assert.equal(unknownExit.signal, null);
  assert.equal(fixture.requests.length, 0);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.diagnostics, /provider/i);
  assertPublicRedacted(unknown, fixtureKey);
  await paths.cleanup();
  assert.equal((await readFile(userConfigPath, 'utf8')).includes(missingEnv), true, 'Actual startup failure retains original configuration evidence');
  const retained = JSON.parse(await readFile(join(paths.root, 'fixture-retention.json'), 'utf8'));
  assert.equal(retained.databaseRemoved, false); assert.equal(retained.nativeCleanupConfirmed, null);
  assert.equal(retained.originalAfterHookObserved, false);
  assert.equal(value.process.exitCode, 1); assert.equal(unknown.process.exitCode, 1); assert.equal(fixture.requests.length, 0);
});
