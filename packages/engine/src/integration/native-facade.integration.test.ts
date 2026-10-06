import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { CommandResult, InputReceipt, JsonObject, Session, SessionCommandResult, SessionSnapshot, Workspace } from '@moodcode/contracts';
import { createEngine, type EngineOptions } from '../engine.js';
import type { QuestionRecord } from '../questions/index.js';
import { ScriptedProvider } from '../provider/scripted.js';

async function fixture(t: test.TestContext, options: Partial<EngineOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-native-facade-')));
  const repository = join(root, 'repository');
  await mkdir(repository);
  execFileSync('git', ['init', '-q', repository]);
  await writeFile(join(repository, 'sample.txt'), 'fixture\n');
  const dbPath = join(root, 'engine.sqlite');
  let engine = createEngine({ ...options, dbPath });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const command = async <T>(type: string, payload: JsonObject, native = false): Promise<T> => {
    const envelope = { schemaVersion: native ? 2 : 1, commandId: randomUUID(), type, payload };
    const result = native ? await engine.dispatchSession(envelope) : await engine.dispatch(envelope);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.schemaVersion, native ? 2 : 1);
    return result.result as unknown as T;
  };
  const workspace = await command<Workspace>('workspace.open', { path: repository });
  const session = await command<Session>('session.create', { workspaceId: workspace.id });
  return { root, dbPath, session, workspace, command, get engine() { return engine; }, async reopen() { await engine.close(); engine = createEngine({ ...options, dbPath }); } };
}

test('native public inbox keeps pending inputs out of v1 transcript and promotes FIFO on explicit resume', async t => {
  const f = await fixture(t);
  await f.command('session.pause', { sessionId: f.session.id }, true);
  const payload: JsonObject = { sessionId: f.session.id, requestId: 'first', prompt: 'first request', delivery: 'queue' };
  const first = await f.command<InputReceipt>('input.accept', payload, true);
  const duplicate = await f.command<InputReceipt>('input.accept', payload, true);
  assert.equal(duplicate.inputId, first.inputId);
  assert.equal(duplicate.duplicate, true);
  await f.command('input.accept', { ...payload, requestId: 'second', prompt: 'second request' }, true);
  const paused = await f.command<SessionSnapshot>('session.getSnapshot', { sessionId: f.session.id });
  assert.deepEqual(paused.runs, []);
  assert.deepEqual(paused.messages, []);
  const before = f.engine.store.readSessionEvents(f.session.id, 0);
  assert.equal(before.filter(event => event.type === 'input.accepted').length, 2);
  assert.ok(before.filter(event => event.type === 'input.accepted').every(event => event.runId === undefined));
  await f.command('session.resume', { sessionId: f.session.id }, true);
  await f.engine.waitForSession(f.session.id);
  const completed = await f.command<SessionSnapshot>('session.getSnapshot', { sessionId: f.session.id });
  assert.deepEqual(completed.runs.map(run => [run.prompt, run.state]), [['first request', 'completed'], ['second request', 'completed']]);
  assert.equal(f.engine.store.listInputs(f.session.id).inputs.filter(input => input.state === 'promoted').length, 2);
  const turns = await f.command<{ turns: { id: string; contextRevisionId?: string }[] }>('run.getTurns', { runId: completed.runs[0]!.id }, true);
  assert.equal(turns.turns.length, 1);
  assert.ok(turns.turns[0]!.contextRevisionId);
  const parts = await f.command<{ parts: { type: string }[] }>('turn.getParts', { turnId: turns.turns[0]!.id }, true);
  assert.equal(parts.parts[0]!.type, 'text');
  const future = await f.engine.dispatchSession({ schemaVersion: 99, commandId: 'future', type: 'input.accept', payload });
  assert.equal(future.error?.code, 'UNSUPPORTED_SCHEMA_VERSION');
});

test('default coding loop can persist session tasks, await a durable question and expose its result artifact', async t => {
  const provider = new ScriptedProvider([
    { events: [{ type: 'tool.call', call: { id: 'tasks', name: 'todo_write', input: { expectedRevision: 0, tasks: [{ id: 'work', title: 'Verify question', status: 'in_progress' }] } } }, { type: 'finish', reason: 'tool_calls' }] },
    { events: [{ type: 'tool.call', call: { id: 'question', name: 'ask_user', input: { prompt: 'Continue?', options: [{ id: 'yes', label: 'Continue' }], allowFreeText: false } } }, { type: 'finish', reason: 'tool_calls' }] },
    { events: [{ type: 'text.delta', delta: 'Question answered.' }, { type: 'finish', reason: 'stop' }] },
  ]);
  const f = await fixture(t, { providers: [provider] });
  const receipt = await f.command<InputReceipt>('input.accept', { sessionId: f.session.id, requestId: 'questions', prompt: 'Manage work and ask', delivery: 'queue', config: { mode: 'plan' } }, true);
  let question: QuestionRecord | undefined;
  for (let index = 0; index < 200 && !question; index++) { question = f.engine.questions.list(f.session.id).find(question => question.status === 'pending'); if (!question) await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(question, 'coding loop must expose a live, durable question');
  await f.command('question.answer', { sessionId: f.session.id, questionId: question.id, version: question.version, answer: { optionIds: ['yes'] } }, true);
  await f.engine.waitForSession(f.session.id);
  const runId = f.engine.store.getInput(receipt.inputId).runId!;
  assert.equal(f.engine.store.getRun(runId).state, 'completed');
  assert.equal(f.engine.tasks.get(f.session.id).revision, 1);
  assert.equal(provider.callCount, 3);
  assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 0);
  const allEvents = f.engine.store.readEvents(f.session.id, 0, 1000);
  const results = allEvents.filter(event => event.type === 'tool.completed');
  assert.ok(results.length, JSON.stringify(allEvents.filter(event => event.type.startsWith('tool.'))));
  const structured = results[0]!.payload.structuredResult as unknown as { artifactRefs: { id: string; identity: JsonObject }[] };
  assert.equal(structured.artifactRefs.length, 1);
  const artifact = structured.artifactRefs[0]!;
  const page = await f.command<{ encoding: string; content: string }>('artifact.get', { artifactId: artifact.id, ...artifact.identity, limit: 64 }, true);
  assert.equal(page.encoding, 'base64');
  assert.ok(Buffer.from(page.content, 'base64').length <= 64);
  const wrong = await f.engine.dispatchSession({ schemaVersion: 2, commandId: 'wrong-owner', type: 'artifact.get', payload: { artifactId: artifact.id, ...artifact.identity, toolCallId: 'other' } });
  assert.equal(wrong.ok, false);
});

test('pending input survives reopen and requires explicit resume; session cursor cannot be moved', async t => {
  const f = await fixture(t);
  await f.command('session.pause', { sessionId: f.session.id }, true);
  const receipt = await f.command<InputReceipt>('input.accept', { sessionId: f.session.id, requestId: 'persist', prompt: 'persist queued', delivery: 'queue' }, true);
  await f.reopen();
  assert.equal(f.engine.store.getInput(receipt.inputId).state, 'pending');
  assert.equal(f.engine.store.getSnapshot(f.session.id).runs.length, 0);
  const other = await f.command<Session>('session.create', { workspaceId: f.workspace.id });
  const mismatch = await f.engine.dispatchSession({ schemaVersion: 2, commandId: 'cursor', type: 'input.list', payload: { sessionId: other.id, cursor: { sessionId: f.session.id, afterSeq: 0 } } });
  assert.equal(mismatch.ok, false);
  await f.command('session.resume', { sessionId: f.session.id }, true);
  await f.engine.waitForSession(f.session.id);
  assert.equal(f.engine.store.getInput(receipt.inputId).state, 'promoted');
  assert.equal(f.engine.store.getSnapshot(f.session.id).runs[0]!.state, 'completed');
});
