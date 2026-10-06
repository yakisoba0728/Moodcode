import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createEngine, type ProviderAdapter } from '@moodcode/engine';
import { runHarness } from './protocol.js';

test('real JSONL engine preserves queue, steer, approval cancellation, explicit resume and workspace fairness', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-native-jsonl-'))); execFileSync('git', ['init', '-q', root]);
  const provider: ProviderAdapter = { id: 'fixture', async *streamTurn(request) {
    const prompt = request.messages.findLast(message => message.role === 'user')?.content;
    if (request.turnIndex === 0 && prompt === 'approval request') {
      yield { type: 'tool.call', call: { id: 'blocked-command', name: 'run_command', input: { command: 'exit 0' } } }; yield { type: 'finish', reason: 'tool_calls' };
    } else { yield { type: 'text.delta', delta: `Finished ${prompt}` }; yield { type: 'finish', reason: 'stop' }; }
  } };
  const engine = createEngine({ dbPath: join(root, 'engine.sqlite'), providers: [provider], defaults: { providerId: 'fixture', modelId: 'fixture', mode: 'build' } });
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough(), signals = new EventEmitter();
  const records: Record<string, any>[] = []; let buffered = '';
  output.on('data', data => { buffered += data.toString(); const lines = buffered.split('\n'); buffered = lines.pop()!; for (const line of lines) if (line) records.push(JSON.parse(line)); });
  const completed = runHarness(engine, { input, output, diagnostics, signals });
  t.after(async () => { input.end(); await completed; await engine.close(); await rm(root, { recursive: true, force: true }); });
  const until = async (condition: () => boolean) => { const deadline = Date.now() + 5000; while (!condition()) { assert.ok(Date.now() < deadline, 'JSONL condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } };
  let counter = 0;
  const send = async <T>(schemaVersion: 1 | 2, type: string, payload: object): Promise<T> => {
    const commandId = `native-${counter++}`; input.write(JSON.stringify({ schemaVersion, commandId, type, payload }) + '\n');
    await until(() => records.some(record => record.commandId === commandId)); const result = records.find(record => record.commandId === commandId)!;
    assert.equal(result.schemaVersion, schemaVersion); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.result as T;
  };
  const workspace = await send<{ id: string }>(1, 'workspace.open', { path: root });
  const a = await send<{ id: string }>(1, 'session.create', { workspaceId: workspace.id });
  const b = await send<{ id: string }>(1, 'session.create', { workspaceId: workspace.id });
  await send(2, 'session.events', { sessionId: a.id });
  const first = await send<{ inputId: string }>(2, 'input.accept', { sessionId: a.id, requestId: 'approval', prompt: 'approval request', delivery: 'queue' });
  await until(() => engine.store.getSnapshot(a.id).approvals.some(approval => approval.status === 'pending'));
  const runId = engine.store.getInput(first.inputId).runId!;
  const steer = await send<{ inputId: string }>(2, 'input.accept', { sessionId: a.id, requestId: 'steer', prompt: 'additional instruction', delivery: 'steer' });
  const queued = await send<{ inputId: string }>(2, 'input.accept', { sessionId: a.id, requestId: 'queued', prompt: 'queue later', delivery: 'queue' });
  await send(2, 'input.accept', { sessionId: b.id, requestId: 'other', prompt: 'other session', delivery: 'queue' });
  assert.equal(engine.store.getInput(steer.inputId).state, 'pending'); assert.equal(engine.store.getSnapshot(b.id).runs.length, 0);
  await send(1, 'run.cancel', { runId }); await engine.waitForRun(runId); await engine.waitForSession(b.id);
  assert.equal(engine.store.getSessionControl(a.id).paused, true); assert.equal(engine.store.getInput(queued.inputId).state, 'pending');
  assert.equal(engine.store.getSnapshot(a.id).approvals[0]!.status, 'expired'); assert.equal(engine.store.getSnapshot(b.id).runs[0]!.state, 'completed');
  await send(2, 'session.resume', { sessionId: a.id }); await engine.waitForSession(a.id);
  assert.deepEqual(engine.store.getSnapshot(a.id).runs.map(run => run.state), ['cancelled', 'completed', 'completed']);
  await until(() => records.some(record => record.type === 'event' && record.event?.stream === 'session-v2' && record.event.type === 'input.promoted' && record.event.inputId === queued.inputId));
  const stream = records.filter(record => record.type === 'event').map(record => record.event); assert.ok(stream.every(record => record.schemaVersion === 2 && record.stream === 'session-v2'));
  assert.deepEqual(stream.map(record => record.seq), [...new Set(stream.map(record => record.seq))].sort((a, b) => a - b));
});
