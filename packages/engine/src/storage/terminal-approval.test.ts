import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import {
  DEFAULT_LIMITS, EngineError,
  type ApprovalRecord, type Message, type RunState, type ToolCallRecord,
} from '@moodcode/contracts';
import { SqliteStore } from './index.js';

const createdAt = '2026-10-04T00:00:00.000Z';
const terminalStates = ['completed', 'cancelled', 'failed', 'interrupted'] as const;
type TerminalState = typeof terminalStates[number];
const hasCode = (code: string) => (error: unknown): boolean => error instanceof EngineError && error.code === code;

interface ActiveRun { runId: string; sessionId: string }
function activeRun(store: SqliteStore, directory: string, label: string): ActiveRun {
  const root = join(directory, label);
  mkdirSync(root, { mode: 0o700 });
  const workspace = store.putWorkspace({ id: `workspace-${label}`, root, gitRoot: root, branch: null, createdAt });
  const session = store.createSession({ id: `session-${label}`, workspaceId: workspace.id, title: label, createdAt });
  const { runId } = store.admit({
    sessionId: session.id, requestId: `request-${label}`, prompt: 'Exercise durable terminal approval cleanup',
    config: { providerId: 'scripted', modelId: 'local', mode: 'build', limits: { ...DEFAULT_LIMITS } },
  });
  store.commit(runId, 'run.started', {}, { run: { state: 'running' } });
  return { runId, sessionId: session.id };
}

function records(run: ActiveRun, label: string): { tool: ToolCallRecord; approval: ApprovalRecord } {
  const tool: ToolCallRecord = {
    id: `tool-${label}`, runId: run.runId, sessionId: run.sessionId, name: 'run_command',
    input: { command: `fixture ${label}; never executed` }, state: 'awaiting_approval',
  };
  const approval: ApprovalRecord = {
    id: `approval-${label}`, runId: run.runId, sessionId: run.sessionId,
    toolCallId: tool.id, toolName: tool.name, fingerprint: `fingerprint-${label}`,
    preview: { command: `fixture ${label}; never executed` }, status: 'pending', createdAt,
  };
  return { tool, approval };
}

function registerApproval(store: SqliteStore, run: ActiveRun, label: string): ApprovalRecord {
  const { tool, approval } = records(run, label);
  store.commit(run.runId, 'approval.requested', { approvalId: approval.id, toolCallId: tool.id }, { tool, approval });
  return approval;
}

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-terminal-approval-')));
  const dbPath = join(directory, 'engine.sqlite');
  const store = new SqliteStore(dbPath);
  const observers: DatabaseSync[] = [];
  t.after(async () => {
    for (const observer of observers) observer.close();
    await store.closeAsync();
    rmSync(directory, { recursive: true, force: true });
  });
  const run = activeRun(store, directory, 'primary');
  const pending = [1, 2, 3].map((index) => registerApproval(store, run, `pending-${index}`));
  const resolved = (['allowed', 'denied', 'expired'] as const).map((status) => {
    const approval = registerApproval(store, run, `resolved-${status}`);
    const resolvedApproval: ApprovalRecord = { ...approval, status, resolvedAt: createdAt };
    store.commit(run.runId, 'approval.resolved', { approvalId: approval.id, status }, { approval: resolvedApproval });
    return resolvedApproval;
  });
  const unrelated = activeRun(store, directory, 'unrelated');
  const unrelatedApprovals = [1, 2].map((index) => registerApproval(store, unrelated, `unrelated-${index}`));
  return { dbPath, store, observers, run, pending, resolved, unrelated, unrelatedApprovals };
}

function prepareTerminal(store: SqliteStore, run: ActiveRun, state: TerminalState): void {
  if (state === 'cancelled') store.commit(run.runId, 'run.cancelling', {}, { run: { state: 'cancelling' } });
}

function assertExpired(store: SqliteStore, original: ApprovalRecord): void {
  const expired = store.getApproval(original.id);
  assert.equal(expired.status, 'expired');
  assert.equal(typeof expired.resolvedAt, 'string');
  assert.ok(Number.isFinite(Date.parse(expired.resolvedAt!)));
  assert.deepEqual(expired, { ...original, status: 'expired', resolvedAt: expired.resolvedAt });
}

for (const state of terminalStates) {
  test(`${state} commit expires all pending approvals before its returned terminal event`, (t) => {
    const { store, run, pending, resolved, unrelated, unrelatedApprovals } = fixture(t);
    prepareTerminal(store, run, state);
    const before = store.getSnapshot(run.sessionId);
    const unrelatedBefore = store.getSnapshot(unrelated.sessionId);
    const incoming = records(run, 'inside-terminal-commit');
    const event = store.commit(run.runId, `run.${state}`, { state, marker: 'terminal payload' }, {
      run: { state }, tool: incoming.tool, approval: incoming.approval,
    });
    const allPending = [...pending, incoming.approval];
    const committed = store.readEvents(run.sessionId, before.lastSeq, 1_024);
    assert.deepEqual(committed.map((item) => item.type), [
      ...allPending.map(() => 'approval.expired'), `run.${state}`,
    ]);
    assert.deepEqual(committed.map((item) => item.seq), allPending.map((_, index) => before.lastSeq + index + 1).concat(before.lastSeq + allPending.length + 1));
    assert.deepEqual(committed.slice(0, -1).map((item) => item.payload.approvalId).sort(), allPending.map((approval) => approval.id).sort());
    for (const expiry of committed.slice(0, -1)) {
      assert.equal(expiry.runId, run.runId);
      assert.equal(expiry.sessionId, run.sessionId);
      assert.equal(expiry.payload.reason, 'run_terminal');
    }
    assert.deepEqual(committed.at(-1), event);
    assert.equal(event.type, `run.${state}`);
    assert.equal(event.seq, before.lastSeq + allPending.length + 1);
    assert.equal(store.getRun(run.runId).state, state);
    for (const approval of allPending) assertExpired(store, approval);
    for (const approval of resolved) assert.deepEqual(store.getApproval(approval.id), approval);
    for (const approval of unrelatedApprovals) assert.deepEqual(store.getApproval(approval.id), approval);
    assert.deepEqual(store.getSnapshot(unrelated.sessionId), unrelatedBefore);
    const snapshot = store.getSnapshot(run.sessionId);
    assert.equal(snapshot.lastSeq, event.seq);
    assert.equal(snapshot.approvals.filter((approval) => approval.status === 'pending').length, 0);
    assert.equal(store.readEvents(run.sessionId, 0, 1_024).filter((item) => item.type === `run.${state}`).length, 1);

    const lateMessage: Message = {
      id: 'late-message', sessionId: run.sessionId, runId: run.runId,
      role: 'assistant', content: 'Must not be committed', createdAt,
    };
    assert.throws(() => store.commit(run.runId, 'message.delta', { delta: lateMessage.content }, { message: lateMessage }), hasCode('RUN_TERMINAL'));
    assert.throws(() => store.commit(run.runId, `run.${state}`, { state }, { run: { state } }), hasCode('RUN_TERMINAL'));
    for (const approval of allPending) {
      assert.throws(() => store.commit(run.runId, 'approval.resolved', { approvalId: approval.id, status: 'allowed' }, {
        approval: { ...approval, status: 'allowed', resolvedAt: createdAt },
      }), hasCode('RUN_TERMINAL'));
    }
    assert.deepEqual(store.getSnapshot(run.sessionId), snapshot);
    assert.deepEqual(store.readEvents(run.sessionId, before.lastSeq, 1_024), committed);
    assert.deepEqual(store.getSnapshot(unrelated.sessionId), unrelatedBefore);
  });
}

for (const failure of ['terminal-insert', 'second-expiry-insert'] as const) {
  test(`${failure} failure rolls back Run, approval records, inserted entities, events and sequence`, (t) => {
    const { dbPath, store, observers, run, pending, resolved, unrelated } = fixture(t);
    const before = store.getSnapshot(run.sessionId);
    const unrelatedBefore = store.getSnapshot(unrelated.sessionId);
    const beforeEvents = store.readEvents(run.sessionId, 0, 1_024);
    const observer = new DatabaseSync(dbPath);
    observers.push(observer);
    if (failure === 'terminal-insert') {
      observer.exec("CREATE TRIGGER terminal_approval_fault BEFORE INSERT ON events WHEN NEW.type='run.completed' BEGIN SELECT RAISE(ABORT,'injected terminal INSERT failure'); END");
    } else {
      // Fail after one expiry has already been inserted in this same transaction.
      observer.exec(`CREATE TRIGGER terminal_approval_fault BEFORE INSERT ON events
        WHEN NEW.type='approval.expired' AND EXISTS (
          SELECT 1 FROM events WHERE session_id=NEW.session_id AND seq>${before.lastSeq} AND type='approval.expired'
        ) BEGIN SELECT RAISE(ABORT,'injected second expiry INSERT failure'); END`);
    }
    const incoming = records(run, 'rollback-terminal-change');
    const change = { run: { state: 'completed' as RunState }, tool: incoming.tool, approval: incoming.approval };
    assert.throws(() => store.commit(run.runId, 'run.completed', { state: 'completed' }, change), /injected .* INSERT failure/);
    assert.deepEqual(store.getSnapshot(run.sessionId), before);
    assert.deepEqual(store.readEvents(run.sessionId, 0, 1_024), beforeEvents);
    assert.deepEqual(store.getSnapshot(unrelated.sessionId), unrelatedBefore);
    assert.throws(() => store.getApproval(incoming.approval.id), hasCode('APPROVAL_NOT_FOUND'));
    for (const approval of pending) assert.deepEqual(store.getApproval(approval.id), approval);
    for (const approval of resolved) assert.deepEqual(store.getApproval(approval.id), approval);
    assert.equal(observer.prepare('SELECT state FROM runs WHERE id=?').get(run.runId)?.state, 'running');
    assert.equal(observer.prepare('SELECT last_seq FROM sessions WHERE id=?').get(run.sessionId)?.last_seq, before.lastSeq);
    assert.equal(observer.prepare('SELECT COUNT(*) AS n FROM tools WHERE id=?').get(incoming.tool.id)?.n, 0);
    assert.equal(observer.prepare('SELECT COUNT(*) AS n FROM approvals WHERE id=?').get(incoming.approval.id)?.n, 0);

    observer.exec('DROP TRIGGER terminal_approval_fault');
    const terminal = store.commit(run.runId, 'run.completed', { state: 'completed' }, change);
    assert.equal(terminal.seq, before.lastSeq + pending.length + 2);
    const committed = store.readEvents(run.sessionId, before.lastSeq, 1_024);
    assert.deepEqual(committed.map((item) => item.seq), Array.from({ length: pending.length + 2 }, (_, index) => before.lastSeq + index + 1));
    assert.equal(committed.at(-1)?.eventId, terminal.eventId);
    assert.equal(committed.at(-1)?.type, 'run.completed');
    for (const approval of [...pending, incoming.approval]) assertExpired(store, approval);
    assert.equal(store.integrityCheck().ok, true);
    assert.deepEqual(store.getSnapshot(unrelated.sessionId), unrelatedBefore);
  });
}
