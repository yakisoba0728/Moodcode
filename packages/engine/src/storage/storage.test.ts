import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import {
  DEFAULT_LIMITS, EngineError, type ApprovalRecord, type Checkpoint, type Message,
  type RunConfig, type SubmitInput, type ToolCallRecord, type Workspace,
} from '@moodcode/contracts';
import { SqliteStore } from './index.js';

const now = '2026-10-04T00:00:00.000Z';
const config: RunConfig = { providerId: 'scripted', modelId: 'local', mode: 'build', limits: { ...DEFAULT_LIMITS } };
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-storage-'));
  const dbPath = join(directory, 'engine.sqlite');
  const store = new SqliteStore(dbPath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const workspace: Workspace = { id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: now };
  store.putWorkspace(workspace);
  const session = store.createSession({ id: 'session', workspaceId: workspace.id, title: 'Session', createdAt: now });
  const input: SubmitInput = { sessionId: session.id, requestId: 'request', prompt: 'Do the work', config: structuredClone(config) };
  return { directory, dbPath, store, workspace, session, input };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  const controller = new AbortController();
  try {
    return await Promise.race([promise, delay(1_500, undefined, { signal: controller.signal }).then(() => { throw new Error('Event stream did not settle'); })]);
  } finally { controller.abort(); }
}

test('workspace deduplication, session ownership, and detached returned data', (t) => {
  const { store, workspace, session } = fixture(t);
  assert.equal(store.putWorkspace({ ...workspace, id: 'other-id', branch: 'new' }).id, workspace.id);
  assert.deepEqual(store.listWorkspaces(), [workspace]);
  assert.deepEqual(store.listSessions(workspace.id), [session]);
  assert.deepEqual(store.createSession({ ...session }), session);
  assert.throws(() => store.putWorkspace({ ...workspace, root: `${workspace.root}/other` }), code('RECORD_CONFLICT'));
  assert.throws(() => store.createSession({ ...session, title: 'conflict' }), code('RECORD_CONFLICT'));
  assert.throws(() => store.createSession({ ...session, id: 'bad', workspaceId: 'missing' }), code('WORKSPACE_NOT_FOUND'));
  assert.throws(() => store.getWorkspace('missing'), code('WORKSPACE_NOT_FOUND'));
  assert.throws(() => store.getSession('missing'), code('SESSION_NOT_FOUND'));
  const copy = store.getSession(session.id);
  copy.title = 'local mutation';
  assert.equal(store.getSession(session.id).title, 'Session');
  assert.deepEqual(store.getSnapshot(session.id), { session, messages: [], runs: [], tools: [], approvals: [], lastSeq: 0 });
});

test('admission durably creates input, run, user message and contiguous receipt; duplicates precede busy', (t) => {
  const { store, workspace, session, input } = fixture(t);
  const receipt = store.admit(input);
  assert.equal(receipt.admittedSeq, 1);
  assert.equal(receipt.duplicate, false);
  const snapshot = store.getSnapshot(session.id);
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0]?.state, 'created');
  assert.equal(snapshot.messages[0]?.role, 'user');
  assert.equal(snapshot.messages[0]?.content, input.prompt);
  assert.equal(snapshot.lastSeq, receipt.admittedSeq);
  assert.deepEqual(store.admit(structuredClone(input)), { ...receipt, duplicate: true });
  // Normalized JSON identity is independent of object property insertion order.
  const reordered: SubmitInput = {
    config: { limits: { ...config.limits }, mode: 'build', modelId: 'local', providerId: 'scripted' },
    prompt: input.prompt, requestId: input.requestId, sessionId: input.sessionId,
  };
  assert.deepEqual(store.admit(reordered), { ...receipt, duplicate: true });
  assert.throws(() => store.admit({ ...input, prompt: 'Changed' }), code('REQUEST_ID_CONFLICT'));
  assert.throws(() => store.admit({ ...input, config: { ...input.config, mode: 'plan' } }), code('REQUEST_ID_CONFLICT'));
  assert.throws(() => store.admit({ ...input, requestId: 'new' }), code('WORKSPACE_BUSY'));
  const otherSession = store.createSession({ ...session, id: 'second-session' });
  assert.throws(() => store.admit({ ...input, sessionId: otherSession.id }), code('WORKSPACE_BUSY'));
  assert.equal(store.getSnapshot(otherSession.id).lastSeq, 0);
  assert.deepEqual(store.getSnapshot(session.id), snapshot);

  const otherWorkspace = store.putWorkspace({ ...workspace, id: 'other-workspace', root: `${workspace.root}/other` });
  const independentSession = store.createSession({ ...session, id: 'independent', workspaceId: otherWorkspace.id });
  assert.equal(store.admit({ ...input, sessionId: independentSession.id }).admittedSeq, 1);
  store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
  store.commit(receipt.runId, 'run.completed', {}, { run: { state: 'completed' } });
  const next = store.admit({ ...input, requestId: 'new' });
  assert.equal(next.admittedSeq, 4);
  assert.deepEqual(store.admit(input), { ...receipt, duplicate: true });
  input.config.limits.maxTurns = 99;
  assert.equal(store.getRun(receipt.runId).config.limits.maxTurns, DEFAULT_LIMITS.maxTurns);
  assert.throws(() => store.getRun('missing'), code('RUN_NOT_FOUND'));
});

test('journal insertion failure rolls back projection, messages and sequence on a real connection', (t) => {
  const { store, dbPath, session, input } = fixture(t);
  const receipt = store.admit(input);
  const observer = new DatabaseSync(dbPath);
  t.after(() => observer.close());
  observer.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON events WHEN NEW.type='inject.failure' BEGIN SELECT RAISE(ABORT,'injected journal failure'); END");
  const before = store.getSnapshot(session.id);
  const message: Message = { id: 'response', sessionId: session.id, runId: receipt.runId, role: 'assistant', content: 'partial', createdAt: now };
  assert.throws(() => store.commit(receipt.runId, 'inject.failure', {}, { run: { state: 'running' }, message }), /injected journal failure/);
  assert.deepEqual(store.getSnapshot(session.id), before);
  assert.equal(observer.prepare('SELECT state FROM runs WHERE id=?').get(receipt.runId)?.state, 'created');
  assert.equal(observer.prepare('SELECT count(*) AS count FROM messages').get()?.count, 1);
  const started = store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' }, message });
  assert.equal(started.seq, 2);
  assert.equal(observer.prepare('SELECT state FROM runs WHERE id=?').get(receipt.runId)?.state, 'running');
  assert.equal(observer.prepare('SELECT max(seq) AS seq FROM events').get()?.seq, 2);
  assert.equal(store.getSnapshot(session.id).messages[1]?.content, 'partial');
});

test('snapshot remains at one database revision when another connection commits during its reads', async (t) => {
  const { store, dbPath, session, input } = fixture(t);
  const { runId } = store.admit(input);
  const observer = new DatabaseSync(dbPath);
  t.after(() => observer.close());
  const updated = { ...store.getRun(runId), state: 'running', updatedAt: now };
  const originalGetSession = store.getSession.bind(store);
  let committed = false;
  store.getSession = (sessionId) => {
    const result = originalGetSession(sessionId); // This first SELECT fixes the read transaction revision.
    if (!committed) {
      committed = true;
      const event = { schemaVersion: 1, eventId: 'external-test-event', sessionId, runId, seq: 2, timestamp: now, type: 'run.started', payload: {} };
      observer.exec('BEGIN IMMEDIATE');
      observer.prepare('UPDATE runs SET state=?,data=? WHERE id=?').run('running', JSON.stringify(updated), runId);
      observer.prepare('UPDATE sessions SET last_seq=2 WHERE id=?').run(sessionId);
      observer.prepare('INSERT INTO events(session_id,seq,event_id,run_id,type,data) VALUES(?,?,?,?,?,?)').run(sessionId, 2, event.eventId, runId, event.type, JSON.stringify(event));
      observer.exec('COMMIT');
    }
    return result;
  };
  const snapshot = store.getSnapshot(session.id);
  assert.equal(committed, true);
  assert.equal(snapshot.lastSeq, 1);
  assert.equal(snapshot.runs[0]?.state, 'created');
  const newer = store.getSnapshot(session.id);
  assert.equal(newer.lastSeq, 2);
  assert.equal(newer.runs[0]?.state, 'running');
  const controller = new AbortController();
  const replay = store.subscribe(session.id, snapshot.lastSeq, controller.signal)[Symbol.asyncIterator]();
  assert.equal((await bounded(replay.next())).value?.type, 'run.started');
  controller.abort();
  assert.equal((await bounded(replay.next())).done, true);
});

test('message, tool, approval and checkpoint records are journaled and retain their identity', (t) => {
  const { store, session, input } = fixture(t);
  const { runId } = store.admit(input);
  store.commit(runId, 'run.started', {}, { run: { state: 'running' } });
  const message: Message = { id: 'response', sessionId: session.id, runId, role: 'assistant', content: 'A', createdAt: now };
  store.commit(runId, 'message.delta', { delta: 'A' }, { message });
  store.commit(runId, 'message.delta', { delta: 'B' }, { message: { ...message, content: 'AB' } });
  const tool: ToolCallRecord = { id: 'tool', runId, sessionId: session.id, name: 'apply_patch', input: { path: 'a.txt' }, state: 'requested' };
  store.commit(runId, 'tool.requested', { toolCallId: tool.id }, { tool });
  const approval: ApprovalRecord = { id: 'approval', runId, sessionId: session.id, toolCallId: tool.id, toolName: tool.name, fingerprint: 'hash', preview: { path: 'a.txt' }, status: 'pending', createdAt: now };
  store.commit(runId, 'approval.requested', { approvalId: approval.id }, { run: { state: 'awaiting_approval' }, tool: { ...tool, state: 'awaiting_approval' }, approval });
  const allowed: ApprovalRecord = { ...approval, status: 'allowed', resolvedAt: now };
  store.commit(runId, 'approval.resolved', {}, { approval: allowed });
  store.commit(runId, 'tool.started', {}, { run: { state: 'running' }, tool: { ...tool, state: 'running' } });
  const checkpoint: Checkpoint = { id: 'checkpoint', runId, toolCallId: tool.id, kind: 'patch', createdAt: now, files: [{ path: 'a.txt', before: 'old', after: 'new', beforeHash: 'old-hash', afterHash: 'new-hash' }], warnings: ['external edits cannot be attributed'] };
  store.commit(runId, 'checkpoint.recorded', { checkpointId: checkpoint.id }, { checkpoint });
  store.commit(runId, 'tool.completed', {}, { tool: { ...tool, state: 'completed', output: 'done' } });
  const before = store.getSnapshot(session.id);
  assert.equal(before.messages.length, 2);
  assert.equal(before.messages[1]?.content, 'AB');
  assert.equal(before.tools[0]?.state, 'completed');
  assert.deepEqual(store.getApproval(approval.id), allowed);
  assert.deepEqual(store.listCheckpoints(runId), [checkpoint]);
  assert.throws(() => store.commit(runId, 'message.delta', {}, { message: { ...message, sessionId: 'other' } }), code('RECORD_SCOPE_MISMATCH'));
  assert.throws(() => store.commit(runId, 'message.delta', {}, { message: { ...message, role: 'tool' } }), code('RECORD_CONFLICT'));
  assert.throws(() => store.commit(runId, 'tool.changed', {}, { tool: { ...tool, input: { path: 'other.txt' } } }), code('RECORD_CONFLICT'));
  assert.throws(() => store.commit(runId, 'tool.started', {}, { tool: { ...tool, state: 'running' } }), code('RECORD_CONFLICT'));
  assert.throws(() => store.commit(runId, 'approval.changed', {}, { approval: { ...allowed, fingerprint: 'other' } }), code('RECORD_CONFLICT'));
  assert.throws(() => store.commit(runId, 'approval.changed', {}, { approval: { ...allowed, status: 'denied' } }), code('RECORD_CONFLICT'));
  assert.throws(() => store.commit(runId, 'checkpoint.recorded', {}, { checkpoint: { ...checkpoint, warnings: [] } }), code('RECORD_CONFLICT'));
  assert.throws(() => store.getApproval('missing'), code('APPROVAL_NOT_FOUND'));
  assert.deepEqual(store.getSnapshot(session.id), before);
  const readCheckpoint = store.listCheckpoints(runId)[0]!;
  readCheckpoint.files[0]!.after = 'caller mutation';
  assert.equal(store.listCheckpoints(runId)[0]?.files[0]?.after, 'new');
});

test('invalid transitions and late terminal results never change journal or projection', (t) => {
  const { store, input, session } = fixture(t);
  const { runId } = store.admit(input);
  assert.throws(() => store.commit(runId, 'run.completed', {}, { run: { state: 'completed' } }), code('INVALID_RUN_TRANSITION'));
  assert.throws(() => store.commit(runId, 'run.completed', {}), code('INVALID_TERMINAL_EVENT'));
  store.commit(runId, 'run.started', {}, { run: { state: 'running' } });
  assert.throws(() => store.commit(runId, 'message.delta', {}, { run: { state: 'completed' } }), code('INVALID_TERMINAL_EVENT'));
  store.commit(runId, 'run.cancelling', {}, { run: { state: 'cancelling' } });
  assert.throws(() => store.commit(runId, 'run.completed', {}, { run: { state: 'completed' } }), code('INVALID_RUN_TRANSITION'));
  store.commit(runId, 'run.cancelled', {}, { run: { state: 'cancelled' } });
  const snapshot = store.getSnapshot(session.id);
  assert.throws(() => store.commit(runId, 'run.completed', {}, { run: { state: 'completed' } }), code('RUN_TERMINAL'));
  assert.throws(() => store.commit(runId, 'message.delta', { delta: 'late' }), code('RUN_TERMINAL'));
  assert.throws(() => store.commit(runId, 'run.cancelled', {}, { run: { state: 'cancelled' } }), code('RUN_TERMINAL'));
  assert.deepEqual(store.getSnapshot(session.id), snapshot);
  assert.deepEqual(store.readEvents(session.id, 0).map(event => event.seq), [1, 2, 3, 4]);
  assert.equal(store.readEvents(session.id, 0).filter(event => event.type === 'run.cancelled').length, 1);
});

test('snapshot cursor replay covers commits before subscribe and slow consumers across multiple pages', async (t) => {
  const { store, input, session } = fixture(t);
  const { runId } = store.admit(input);
  const snapshot = store.getSnapshot(session.id);
  const controller = new AbortController();
  const stream = store.subscribe(session.id, snapshot.lastSeq, controller.signal)[Symbol.asyncIterator]();
  store.commit(runId, 'run.started', {}, { run: { state: 'running' } });
  const first = await bounded(stream.next());
  assert.equal(first.value?.seq, 2);
  for (let i = 0; i < 270; i++) store.commit(runId, 'message.delta', { delta: String(i) });
  const seen = [first.value!.seq];
  for (let i = 0; i < 270; i++) seen.push((await bounded(stream.next())).value!.seq);
  assert.deepEqual(seen, Array.from({ length: 271 }, (_, i) => i + 2));
  const waiting = stream.next();
  controller.abort();
  assert.equal((await bounded(waiting)).done, true);
  assert.equal(store.getSnapshot(session.id).lastSeq, 272);
  assert.equal(store.readEvents(session.id, 128, 128).length, 128);
  assert.equal(store.readEvents(session.id, 256, 128).length, 16);
  assert.equal(store.readEvents(session.id, 272).length, 0);
});

test('commit precisely between empty read and await does not lose the wakeup', async (t) => {
  const { store, input, session } = fixture(t);
  const { runId } = store.admit(input);
  const actualRead = store.readEvents.bind(store);
  let injected = false;
  store.readEvents = (sessionId, afterSeq, limit) => {
    const events = actualRead(sessionId, afterSeq, limit);
    if (!injected && events.length === 0) {
      injected = true;
      store.commit(runId, 'run.started', {}, { run: { state: 'running' } });
    }
    return events;
  };
  const controller = new AbortController();
  const stream = store.subscribe(session.id, 1, controller.signal)[Symbol.asyncIterator]();
  assert.equal((await bounded(stream.next())).value?.seq, 2);
  assert.equal(injected, true);
  controller.abort();
  assert.equal((await bounded(stream.next())).done, true);
});

test('independent subscribers wake after commit; abort and store close settle idle reads', async (t) => {
  const { store, input, session } = fixture(t);
  const { runId } = store.admit(input);
  const controller = new AbortController();
  const left = store.subscribe(session.id, 1, controller.signal)[Symbol.asyncIterator]();
  const right = store.subscribe(session.id, 1)[Symbol.asyncIterator]();
  const leftNext = left.next();
  const rightNext = right.next();
  const committed = store.commit(runId, 'run.started', {}, { run: { state: 'running' } });
  assert.deepEqual((await bounded(leftNext)).value, committed);
  assert.deepEqual((await bounded(rightNext)).value, committed);
  const leftIdle = left.next();
  const rightIdle = right.next();
  controller.abort();
  assert.equal((await bounded(leftIdle)).done, true);
  store.close();
  assert.equal((await bounded(rightIdle)).done, true);
  store.close();
  assert.throws(() => store.getRun(runId), code('STORE_CLOSED'));
});

test('invalid cursors and page sizes fail explicitly; empty session replay is valid', async (t) => {
  const { store, session } = fixture(t);
  for (const bad of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.readEvents(session.id, bad), code('INVALID_CURSOR'));
    await assert.rejects(store.subscribe(session.id, bad)[Symbol.asyncIterator]().next(), code('INVALID_CURSOR'));
  }
  for (const bad of [0, 1.5, 1_025]) assert.throws(() => store.readEvents(session.id, 0, bad), code('INVALID_PAGE_SIZE'));
  assert.throws(() => store.readEvents('missing', 0), code('SESSION_NOT_FOUND'));
  assert.deepEqual(store.readEvents(session.id, 0), []);
  const signal = AbortSignal.abort();
  assert.equal((await store.subscribe(session.id, 0, signal)[Symbol.asyncIterator]().next()).done, true);
});

test('recovery persists interrupted tools, expired approvals and run terminal in journal and preserves checkpoints', (t) => {
  const { store, dbPath, input, session } = fixture(t);
  const { runId } = store.admit(input);
  store.commit(runId, 'run.started', {}, { run: { state: 'running' } });
  const tool: ToolCallRecord = { id: 'tool', runId, sessionId: session.id, name: 'run_command', input: { command: 'never execute again' }, state: 'requested' };
  const approval: ApprovalRecord = { id: 'approval', runId, sessionId: session.id, toolCallId: tool.id, toolName: tool.name, fingerprint: 'hash', preview: {}, status: 'pending', createdAt: now };
  const checkpoint: Checkpoint = { id: 'checkpoint', runId, toolCallId: tool.id, kind: 'command', createdAt: now, files: [], warnings: ['execution outcome unknown'], incomplete: true };
  store.commit(runId, 'approval.requested', {}, { run: { state: 'awaiting_approval' }, tool: { ...tool, state: 'awaiting_approval' }, approval, checkpoint });
  const oldSeq = store.getSnapshot(session.id).lastSeq;
  store.close();
  const reopened = new SqliteStore(dbPath);
  t.after(() => reopened.close());
  assert.equal(reopened.getRun(runId).state, 'awaiting_approval');
  const recovered = reopened.recoverInterrupted();
  assert.equal(recovered[0]?.state, 'interrupted');
  assert.equal(recovered[0]?.error?.code, 'ENGINE_INTERRUPTED');
  const snapshot = reopened.getSnapshot(session.id);
  assert.equal(snapshot.tools[0]?.state, 'interrupted');
  assert.equal(snapshot.approvals[0]?.status, 'expired');
  assert.deepEqual(reopened.listCheckpoints(runId), [checkpoint]);
  assert.equal(snapshot.lastSeq, oldSeq + 3);
  assert.deepEqual(reopened.readEvents(session.id, oldSeq).map(event => event.type), ['tool.interrupted', 'approval.expired', 'run.interrupted']);
  assert.deepEqual(reopened.recoverInterrupted(), []);
  assert.deepEqual(reopened.getSnapshot(session.id), snapshot);
});

test('terminal commit expires pending approvals before terminal event and later recovery only cleans unresolved tools', (t) => {
  const { store, input, session } = fixture(t);
  const { runId } = store.admit(input);
  store.commit(runId, 'run.started', {}, { run: { state: 'running' } });
  const tool: ToolCallRecord = { id: 'orphan', runId, sessionId: session.id, name: 'run_command', input: {}, state: 'requested' };
  const approval: ApprovalRecord = { id: 'orphan-approval', runId, sessionId: session.id, toolCallId: tool.id, toolName: tool.name, fingerprint: 'hash', preview: {}, status: 'pending', createdAt: now };
  store.commit(runId, 'approval.requested', {}, { tool, approval });
  const beforeTerminal = store.getSnapshot(session.id).lastSeq;
  const terminal = store.commit(runId, 'run.failed', { error: 'failed elsewhere' }, { run: { state: 'failed' } });
  assert.equal(store.getApproval(approval.id).status, 'expired');
  assert.equal(typeof store.getApproval(approval.id).resolvedAt, 'string');
  assert.deepEqual(store.readEvents(session.id, beforeTerminal).map(event => event.type), ['approval.expired', 'run.failed']);
  assert.equal(terminal.seq, beforeTerminal + 2);
  const expired = store.getApproval(approval.id);
  assert.deepEqual(store.recoverInterrupted(), []);
  assert.equal(store.getRun(runId).state, 'failed');
  assert.equal(store.getApproval(approval.id).status, 'expired');
  assert.equal(store.getSnapshot(session.id).tools[0]?.state, 'interrupted');
  assert.deepEqual(store.getApproval(approval.id), expired);
  assert.equal(store.readEvents(session.id, beforeTerminal).filter(event => event.type === 'approval.expired').length, 1);
  assert.equal(store.readEvents(session.id, 0).filter(event => event.type.startsWith('run.') && ['run.failed', 'run.interrupted'].includes(event.type)).length, 1);
});

test('future database schema is rejected before mutation and failed open releases ownership', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-future-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'engine.sqlite');
  const database = new DatabaseSync(dbPath);
  database.exec('CREATE TABLE future_schema(id INTEGER); PRAGMA user_version=99');
  database.close();
  const before = readFileSync(dbPath);
  assert.throws(() => new SqliteStore(dbPath), code('DB_VERSION_UNSUPPORTED'));
  assert.deepEqual(readFileSync(dbPath), before);
  assert.throws(() => new SqliteStore(dbPath), code('DB_VERSION_UNSUPPORTED'));
  const repaired = new DatabaseSync(dbPath);
  repaired.exec('DROP TABLE future_schema; PRAGMA user_version=0');
  repaired.close();
  const store = new SqliteStore(dbPath);
  t.after(() => store.close());
  assert.deepEqual(store.listWorkspaces(), []);
});

test('an in-memory store implements the same API and owns independent records', () => {
  const left = new SqliteStore(':memory:');
  const right = new SqliteStore(':memory:');
  try {
    left.putWorkspace({ id: 'w', root: '/memory', gitRoot: '/memory', branch: null, createdAt: now });
    assert.equal(left.listWorkspaces().length, 1);
    assert.deepEqual(right.listWorkspaces(), []);
  } finally { left.close(); right.close(); }
});
