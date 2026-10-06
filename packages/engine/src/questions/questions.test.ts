import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import { QuestionManager } from './index.js';
import { SessionTaskService } from '../session-state/index.js';

function fixture(t: test.TestContext) {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const createdAt = new Date().toISOString();
  store.putWorkspace({ id: 'workspace', root: process.cwd(), gitRoot: process.cwd(), branch: null, createdAt });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'questions', createdAt });
  const receipt = store.admit({ sessionId: 'session', requestId: 'question', prompt: 'fixture', config: { providerId: 'scripted', modelId: 'local', mode: 'plan', limits: { ...DEFAULT_LIMITS } } });
  store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
  store.commit(receipt.runId, 'tool.requested', {}, { tool: { id: 'tool', runId: receipt.runId, sessionId: 'session', name: 'ask_user', input: {}, state: 'running' } });
  const questions = new QuestionManager(store);
  t.after(() => questions.close());
  return { store, questions, owner: { sessionId: 'session', runId: receipt.runId, toolCallId: 'tool', spec: { prompt: 'Choose', options: [{ id: 'yes', label: 'Yes' }], allowFreeText: true } } };
}

test('question answer is durably bound, exact retry returns its decision, and invalid options do not resume', async t => {
  const f = fixture(t);
  const signal = new AbortController();
  const pending = f.questions.request(f.owner, signal.signal);
  const question = f.questions.list('session')[0]!;
  assert.throws(() => f.questions.answer('session', question.id, 1, { optionIds: ['unknown'] }));
  assert.equal(f.questions.list('session')[0]!.status, 'pending');
  const answer = { optionIds: ['yes'], text: 'continue' };
  const resolved = f.questions.answer('session', question.id, 1, answer);
  assert.deepEqual(await pending, resolved);
  assert.deepEqual(f.questions.answer('session', question.id, 1, answer), resolved);
  assert.throws(() => f.questions.answer('session', question.id, 1, { optionIds: [], text: 'different' }));
  const newManager = new QuestionManager(f.store);
  assert.equal(newManager.list('session')[0]!.status, 'answered');
});

test('cancellation and lost execution owner expire questions and reject stale answers', async t => {
  const f = fixture(t);
  const abort = new AbortController();
  const pending = f.questions.request(f.owner, abort.signal);
  const question = f.questions.list('session')[0]!;
  abort.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof EngineError && error.code === 'QUESTION_EXPIRED');
  assert.equal(f.questions.list('session')[0]!.status, 'expired');
  assert.throws(() => f.questions.answer('session', question.id, 1, { optionIds: ['yes'] }));
});

test('a fresh question manager cannot resume a persisted pending question from another lifetime', async t => {
  const f = fixture(t);
  const pending = f.questions.request(f.owner, new AbortController().signal);
  const question = f.questions.list('session')[0]!;
  const afterRestart = new QuestionManager(f.store);
  assert.throws(() => afterRestart.answer('session', question.id, 1, { optionIds: ['yes'] }));
  assert.equal(afterRestart.list('session')[0]!.status, 'expired');
  f.questions.close();
  await assert.rejects(pending);
});

test('session task revisions preserve independent planning state without adding inputs or runs', t => {
  const f = fixture(t);
  const tasks = new SessionTaskService(f.store);
  assert.deepEqual(tasks.get('session'), { revision: 0, tasks: [] });
  assert.equal(tasks.replace('session', 0, [{ id: 'one', title: 'Plan work', status: 'in_progress' }]).revision, 1);
  assert.throws(() => tasks.replace('session', 0, []), (error: unknown) => error instanceof EngineError && error.code === 'REVISION_CONFLICT');
  assert.equal(tasks.replace('session', 1, [{ id: 'one', title: 'Plan work', status: 'completed' }]).revision, 2);
  assert.equal(f.store.getSnapshot('session').runs.length, 1);
  assert.equal(f.store.listInputs('session').inputs.length, 1);
});
