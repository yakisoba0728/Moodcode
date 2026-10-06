import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { EngineError, type CommandResult, type JsonObject, type RunReceipt, type Session, type SessionCommandResult, type SessionHistoryPage, type SessionMetrics, type Workspace } from '@moodcode/contracts';
import { validateCommand, validateSessionCommand } from '@moodcode/contracts/validation';
import type { ProviderAdapter, RestorePreview, RestoreResult } from '@moodcode/engine';
import { runHarness, type HarnessEngine } from './protocol.js';

const exec = promisify(execFile);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Result = (CommandResult | SessionCommandResult) & { type: 'result' };
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < end, 'JSONL public command must settle'); await new Promise(resolve => setTimeout(resolve, 2)); }
}
function transport(t: TestContext, engine: HarnessEngine) {
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
  const records: Result[] = []; let buffered = '';
  output.on('data', data => { buffered += data.toString(); for (;;) { const end = buffered.indexOf('\n'); if (end < 0) break; records.push(JSON.parse(buffered.slice(0, end)) as Result); buffered = buffered.slice(end + 1); } });
  const completed = runHarness(engine, { input, output, diagnostics });
  t.after(async () => { input.end(); await completed; });
  const send = async (schemaVersion: unknown, type: string, payload: JsonObject) => {
    const commandId = randomUUID(); input.write(JSON.stringify({ schemaVersion, commandId, type, payload }) + '\n');
    await until(() => records.some(record => record.commandId === commandId)); return records.find(record => record.commandId === commandId)!;
  };
  const request = async <T>(schemaVersion: 1 | 2, type: string, payload: JsonObject): Promise<T> => {
    const response = await send(schemaVersion, type, payload); assert.equal(response.ok, true, `${type}: ${JSON.stringify(response.error)}`); assert.equal(response.schemaVersion, schemaVersion); return response.result as unknown as T;
  };
  return { input, completed, send, request, records };
}

test('all 18 v1 public command envelopes pass the JSONL boundary and existing strict facade validation', async t => {
  const commands: { type: string; payload: JsonObject }[] = [
    { type: 'engine.getCapabilities', payload: {} },
    { type: 'workspace.open', payload: { path: '/fixture' } },
    { type: 'workspace.getStatus', payload: { workspaceId: 'workspace' } },
    { type: 'file.list', payload: { workspaceId: 'workspace', path: '', limit: 2 } },
    { type: 'file.read', payload: { workspaceId: 'workspace', path: 'file.txt' } },
    { type: 'session.create', payload: { workspaceId: 'workspace' } },
    { type: 'session.list', payload: { workspaceId: 'workspace' } },
    { type: 'session.getSnapshot', payload: { sessionId: 'session' } },
    { type: 'session.getHistory', payload: { sessionId: 'session', limit: 1 } },
    { type: 'session.getMetrics', payload: { sessionId: 'session' } },
    { type: 'run.submit', payload: { sessionId: 'session', requestId: 'request', prompt: 'fixture' } },
    { type: 'run.cancel', payload: { runId: 'run' } },
    { type: 'approval.decide', payload: { approvalId: 'approval', decision: 'allow', fingerprint: 'fingerprint' } },
    { type: 'review.getDiff', payload: { runId: 'run' } },
    { type: 'events.subscribe', payload: { sessionId: 'session', afterSeq: 3 } },
    { type: 'review.previewRestore', payload: { runId: 'run', checkpointId: 'checkpoint' } },
    { type: 'review.restore', payload: { runId: 'run', checkpointId: 'checkpoint', previewFingerprint: 'a'.repeat(64) } },
    { type: 'review.history', payload: { runId: 'run' } },
  ];
  let closed = 0; const calls: string[] = [];
  const engine: HarnessEngine = { async dispatch(value) { const command = validateCommand(value); calls.push(command.type); return { schemaVersion: 1, commandId: command.commandId, ok: true, result: { forwarded: command.type } }; }, async *subscribe() {}, close() { closed++; } };
  const f = transport(t, engine); assert.equal(commands.length, 18);
  for (const command of commands) assert.equal((await f.request<{ forwarded: string }>(1, command.type, command.payload)).forwarded, command.type);
  assert.deepEqual(calls, commands.map(command => command.type));
  // Transport admission must still leave detailed payload bounds to the
  // facade rather than silently accepting a formerly blocked command.
  for (const [type, payload] of [['file.list', { workspaceId: 'workspace', limit: 1001 }], ['session.getHistory', { sessionId: 'session', limit: 51 }], ['review.restore', { runId: 'run', checkpointId: 'checkpoint', previewFingerprint: 'invalid' }]] as const) {
    const response = await f.send(1, type, payload); assert.equal(response.ok, false); assert.equal(response.error!.code, 'INVALID_INPUT');
  }
  assert.equal(calls.length, 18); f.input.end(); assert.deepEqual(await f.completed, { exitCode: 0, reason: 'eof' }); assert.equal(closed, 1);
});

test('v2 diagnostics remains opt-in with distinct wrong-schema, unknown and engine-disabled results', async t => {
  const calls: string[] = [];
  const engine: HarnessEngine = {
    async dispatch(command) { calls.push(`v1:${command.type}`); return { schemaVersion: 1, commandId: command.commandId, ok: true, result: {} }; },
    async dispatchSession(value) { const command = validateSessionCommand(value, { enabledCommands: ['session.getDiagnostics'] }); calls.push(`v2:${command.type}`); return { schemaVersion: 2, commandId: command.commandId, ok: true, result: command.payload }; },
    async *subscribe() {}, close() {},
  };
  const f = transport(t, engine);
  assert.deepEqual(await f.request(2, 'session.getDiagnostics', { sessionId: 'session' }), { sessionId: 'session' });
  for (const [version, type, expected] of [[2, 'input.accept', 'COMMAND_UNAVAILABLE'], [2, 'file.read', 'UNSUPPORTED_SCHEMA_VERSION'], [1, 'session.getDiagnostics', 'UNKNOWN_COMMAND'], [2, 'unknown.command', 'UNKNOWN_COMMAND'], [1, 'unknown.command', 'UNKNOWN_COMMAND'], [3, 'file.read', 'UNSUPPORTED_SCHEMA_VERSION'], [0, 'engine.getCapabilities', 'UNSUPPORTED_SCHEMA_VERSION'], ['1', 'engine.getCapabilities', 'UNSUPPORTED_SCHEMA_VERSION']] as const) {
    const response = await f.send(version, type, { sessionId: 'session' }); assert.equal(response.ok, false); assert.equal(response.error!.code, expected);
  }
  const invalid = await f.send(2, 'session.getDiagnostics', { sessionId: 'session', additional: true }); assert.equal(invalid.error!.code, 'INVALID_INPUT');
  assert.deepEqual(calls, ['v2:session.getDiagnostics']);
  const unavailable = transport(t, { dispatch: engine.dispatch, subscribe: engine.subscribe, close() {} });
  assert.equal((await unavailable.send(2, 'session.getDiagnostics', { sessionId: 'session' })).error!.code, 'COMMAND_UNAVAILABLE');
});

test('actual source engine exposes file/history/metrics and checkpoint restoration through JSONL', { timeout: 15000 }, async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-jsonl-public-'))), root = join(temporary, 'repository');
  let finish: () => Promise<void> = async () => {};
  t.after(async () => { await finish(); await rm(temporary, { recursive: true, force: true }); });
  await mkdir(root); await exec('git', ['init', '--quiet', '--template=', '--initial-branch=main', root]); await writeFile(join(root, 'file.txt'), 'before\n');
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Moodcode Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '--quiet', '-m', 'JSONL fixture']);
  // Use the current source engine in source-mode focused runs without pulling
  // its files into the harness TypeScript project's emitted root directory.
  const module = import.meta.url.endsWith('.ts') ? new URL('../../../packages/engine/src/engine.ts', import.meta.url).href : '@moodcode/engine';
  const { createEngine } = await import(module) as Pick<typeof import('@moodcode/engine'), 'createEngine'>;
  const provider: ProviderAdapter = { id: 'jsonl-fixture', async *streamTurn(request) {
    yield { type: 'usage', inputTokens: 10, outputTokens: 2 };
    if (request.turnIndex === 0) { yield { type: 'tool.call', call: { id: 'patch', name: 'apply_patch', input: { changes: [{ path: 'file.txt', expectedHash: hash('before\n'), content: 'after\n' }] } } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { yield { type: 'text.delta', delta: 'Verified.' }; yield { type: 'finish', reason: 'stop' }; }
  } };
  const engine = createEngine({ dbPath: join(temporary, 'engine.sqlite'), artifactDir: join(temporary, 'artifacts'), providers: [provider], defaults: { providerId: provider.id, modelId: 'fixture', mode: 'build' } });
  const f = transport(t, engine);
  finish = async () => { f.input.end(); await f.completed; await engine.close(); };
  const workspace = await f.request<Workspace>(1, 'workspace.open', { path: root }), session = await f.request<Session>(1, 'session.create', { workspaceId: workspace.id });
  assert.equal((await f.request<{ clean: boolean }>(1, 'workspace.getStatus', { workspaceId: workspace.id })).clean, true);
  assert.deepEqual((await f.request<{ entries: { path: string }[] }>(1, 'file.list', { workspaceId: workspace.id })).entries.map(entry => entry.path), ['file.txt']);
  assert.equal((await f.request<{ content: string }>(1, 'file.read', { workspaceId: workspace.id, path: 'file.txt' })).content, 'before\n');
  const receipt = await f.request<RunReceipt>(1, 'run.submit', { sessionId: session.id, requestId: 'patch', prompt: 'Apply the local fixture change.' });
  await until(() => engine.store.getSnapshot(session.id).approvals.some(approval => approval.status === 'pending'));
  const approval = engine.store.getSnapshot(session.id).approvals.find(approval => approval.status === 'pending')!;
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'before\n');
  await f.request(1, 'approval.decide', { approvalId: approval.id, fingerprint: approval.fingerprint, decision: 'allow' });
  assert.equal((await engine.waitForRun(receipt.runId)).state, 'completed');
  const history = await f.request<SessionHistoryPage>(1, 'session.getHistory', { sessionId: session.id, limit: 1 }); assert.equal(history.snapshot.runs[0]!.id, receipt.runId); assert.equal(history.hasMore, false);
  const metrics = await f.request<SessionMetrics>(1, 'session.getMetrics', { sessionId: session.id }); assert.equal(metrics.inputTokens, 20); assert.equal(metrics.outputTokens, 4); assert.equal(metrics.observedUsageEvents, 2);
  const native = await f.request<{ metrics: { scope: { sessionId: string }; turns: { total: number }; checkpoints: { total: number } } }>(2, 'session.getDiagnostics', { sessionId: session.id });
  assert.equal(native.metrics.scope.sessionId, session.id); assert.equal(native.metrics.turns.total, 2); assert.equal(native.metrics.checkpoints.total, 1);
  const checkpoint = engine.store.listCheckpoints(receipt.runId)[0]!;
  const preview = await f.request<RestorePreview>(1, 'review.previewRestore', { runId: receipt.runId, checkpointId: checkpoint.id }); assert.equal(preview.canRestore, true); assert.equal(preview.files[0]!.currentHash, hash('after\n'));
  assert.deepEqual(await f.request(1, 'review.history', { runId: receipt.runId }), { runId: receipt.runId, operations: [] });
  const invalid = await f.send(1, 'review.restore', { runId: receipt.runId, checkpointId: checkpoint.id, previewFingerprint: 'invalid' }); assert.equal(invalid.error!.code, 'INVALID_INPUT'); assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'after\n');
  const restored = await f.request<RestoreResult>(1, 'review.restore', { runId: receipt.runId, checkpointId: checkpoint.id, previewFingerprint: preview.fingerprint }); assert.deepEqual(restored.restored, ['file.txt']); assert.equal(restored.effectsUncertain, false);
  const audit = await f.request<{ operations: { state: string }[] }>(1, 'review.history', { runId: receipt.runId }); assert.equal(audit.operations.length, 1); assert.equal(audit.operations[0]!.state, 'completed');
  assert.equal((await f.request<{ content: string }>(1, 'file.read', { workspaceId: workspace.id, path: 'file.txt' })).content, 'before\n');
  assert.equal((await f.send(2, 'file.read', { workspaceId: workspace.id, path: 'file.txt' })).error!.code, 'UNSUPPORTED_SCHEMA_VERSION');
  assert.equal((await f.send(3, 'session.getDiagnostics', { sessionId: session.id })).error!.code, 'UNSUPPORTED_SCHEMA_VERSION');
  f.input.end(); assert.deepEqual(await f.completed, { reason: 'eof', exitCode: 0 });
  await assert.rejects(engine.watchWorkspace(workspace.id), error => error instanceof EngineError && error.code === 'ENGINE_CLOSED');
});
