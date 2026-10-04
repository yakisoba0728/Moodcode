import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { CommandResult, EngineCapabilities, JsonObject, RunReceipt, Session, SessionHistoryPage, SessionMetrics, SessionSnapshot, Workspace } from '@moodcode/contracts';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { createEngine } from '../engine.js';

const exec = promisify(execFile);
type Engine = ReturnType<typeof createEngine>;
async function command<T>(engine: Engine, type: string, payload: JsonObject): Promise<T> {
  const response = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload });
  assert.equal(response.ok, true, `${type}: ${JSON.stringify(response.error)}`);
  return response.result as unknown as T;
}
async function failure(engine: Engine, type: string, payload: JsonObject, code: string): Promise<CommandResult> {
  const response = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload });
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, code);
  return response;
}

test('engine facade forwards directory continuations and persists effort/history/metrics defaults across SQLite reopen', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'moodcode-next-stage-facade-'));
  const repository = join(root, 'repository');
  await mkdir(repository);
  await exec('git', ['init', '--quiet', '--template=', repository]);
  await writeFile(join(repository, '.gitignore'), 'ignored/\n');
  for (const name of ['src', '.venv', 'ignored']) {
    await mkdir(join(repository, name));
    await writeFile(join(repository, name, 'app.py'), 'answer = 1\n');
  }
  for (const name of ['a.txt', 'b.txt']) await writeFile(join(repository, name), 'text\n');
  const requests: TurnRequest[] = [];
  const provider: ProviderAdapter = {
    id: 'next-stage-local',
    async *streamTurn(request): AsyncGenerator<ProviderEvent> {
      requests.push(structuredClone(request));
      yield { type: 'text.delta', delta: `Reply ${requests.length}` };
      yield { type: 'usage', inputTokens: 0, outputTokens: 0 };
      yield { type: 'finish', reason: 'stop', replayItems: [{ type: 'reasoning', encrypted_content: `opaque-${requests.length}` }] };
    },
  };
  const options = { dbPath: join(root, 'engine.sqlite'), artifactDir: join(root, 'artifacts'), providers: [provider], defaults: { providerId: provider.id, modelId: 'gpt-local-fixture', reasoningEffort: 'ultra' as const } };
  let engine = createEngine(options);
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = await command<Workspace>(engine, 'workspace.open', { path: repository });
  const capabilities = await command<EngineCapabilities>(engine, 'engine.getCapabilities', {});
  assert.deepEqual(capabilities.features, { historyPaging: true, sessionMetrics: true });
  assert.equal(capabilities.defaults.reasoningEffort, 'ultra');
  const entries: string[] = [];
  let continuation: string | undefined;
  let firstCursor: string | undefined;
  for (let page = 0; page < 6; page++) {
    const listing = await command<{ entries: { path: string }[]; continuation?: string }>(engine, 'file.list', { workspaceId: workspace.id, limit: 1, ...(continuation ? { continuation } : {}) });
    assert.equal(listing.entries.length, 1);
    entries.push(listing.entries[0]!.path);
    continuation = listing.continuation;
    firstCursor ??= continuation;
    if (!continuation) break;
  }
  assert.deepEqual(entries, ['src', '.gitignore', 'a.txt', 'b.txt']);
  await failure(engine, 'file.list', { workspaceId: workspace.id, limit: 1001 }, 'INVALID_INPUT');
  await failure(engine, 'file.list', { workspaceId: workspace.id, limit: 1, continuation: 'forged' }, 'INVALID_CONTINUATION');
  await failure(engine, 'file.list', { workspaceId: workspace.id, path: 'src', limit: 1, continuation: firstCursor! }, 'INVALID_CONTINUATION');
  await writeFile(join(repository, 'a.txt'), 'changed\n');
  await failure(engine, 'file.list', { workspaceId: workspace.id, limit: 1, continuation: firstCursor! }, 'STALE_CONTINUATION');

  const session = await command<Session>(engine, 'session.create', { workspaceId: workspace.id });
  const payload = { sessionId: session.id, requestId: 'durable-first', prompt: 'Read the local fixture.' };
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    const receipt = await command<RunReceipt>(engine, 'run.submit', index ? { ...payload, requestId: `followup-${index}` } : payload);
    ids.push(receipt.runId);
    const run = await engine.waitForRun(receipt.runId);
    assert.equal(run.state, 'completed');
    assert.equal(run.config.reasoningEffort, 'ultra');
    assert.equal(requests[index]!.reasoningEffort, 'ultra');
  }
  const latest = await command<SessionHistoryPage>(engine, 'session.getHistory', { sessionId: session.id, limit: 2 });
  assert.deepEqual(latest.snapshot.runs.map(run => run.id), ids.slice(-2));
  assert.equal(latest.hasMore, true);
  assert.ok(latest.snapshot.messages.every(message => !Object.hasOwn(message, 'providerReplay')));
  const metrics = await command<SessionMetrics>(engine, 'session.getMetrics', { sessionId: session.id });
  assert.equal(metrics.inputTokens, 0);
  assert.equal(metrics.outputTokens, 0);
  assert.equal(metrics.observedUsageEvents, 3);
  assert.equal(metrics.context!.bytes, Buffer.byteLength(JSON.stringify({ messages: requests[2]!.messages, tools: requests[2]!.tools })));
  const full = await command<SessionSnapshot>(engine, 'session.getSnapshot', { sessionId: session.id });
  assert.equal(full.messages.filter(message => message.providerReplay).length, 3);
  await engine.close();
  engine = createEngine(options);
  const duplicate = await command<RunReceipt>(engine, 'run.submit', payload);
  assert.equal(duplicate.runId, ids[0]);
  assert.equal(duplicate.duplicate, true);
  assert.equal(requests.length, 3);
  assert.deepEqual(await command(engine, 'session.getMetrics', { sessionId: session.id }), metrics);
  const older = await command<SessionHistoryPage>(engine, 'session.getHistory', { sessionId: session.id, beforeRunId: latest.beforeRunId!, limit: 2 });
  assert.deepEqual(older.snapshot.runs.map(run => run.id), ids.slice(0, 1));
  assert.equal(older.hasMore, false);
});
