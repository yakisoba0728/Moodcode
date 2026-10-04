import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_LIMITS, EngineError, SCHEMA_VERSION,
  type ApprovalRecord, type Checkpoint, type EngineEvent, type JsonObject,
  type Run, type RunReceipt, type Session, type SessionSnapshot, type SubmitInput,
  type Workspace,
} from '@moodcode/contracts';
import type { ApprovalRequest, CommitChange, EngineStore } from '../ports.js';
import { ApprovalManager } from './index.js';

const timestamp = '2026-10-04T00:00:00.000Z';
const copy = <T>(value: T): T => structuredClone(value);
const hasCode = (code: string) => (error: unknown): boolean => error instanceof EngineError && error.code === code;
const options = { timeout: 2_000 };

/** Copies model a durable store; notifications happen synchronously after commit. */
class FakeStore implements EngineStore {
  readonly workspace: Workspace = {
    id: 'workspace', root: '/fake/workspace', gitRoot: '/fake/workspace',
    branch: 'main', createdAt: timestamp,
  };
  readonly session: Session = { id: 'session', workspaceId: 'workspace', title: 'Approval tests', createdAt: timestamp };
  readonly runs = new Map<string, Run>();
  readonly approvals = new Map<string, ApprovalRecord>();
  readonly events: EngineEvent[] = [];
  readonly commits: { event: EngineEvent; change: CommitChange }[] = [];
  onCommit?: (event: EngineEvent) => void;
  private readonly failures = new Map<string, Error[]>();

  constructor() { this.addRun('run'); }

  addRun(id: string, state: Run['state'] = 'running'): Run {
    const run: Run = {
      id, inputId: `input-${id}`, sessionId: this.session.id,
      workspaceId: this.workspace.id, requestId: `request-${id}`, prompt: 'Approve a tool',
      config: { providerId: 'scripted', modelId: 'local', mode: 'build', limits: copy(DEFAULT_LIMITS) },
      state, createdAt: timestamp, updatedAt: timestamp,
    };
    this.runs.set(id, copy(run));
    return copy(run);
  }

  setRunState(runId: string, state: Run['state']): void {
    const run = this.getRun(runId);
    this.runs.set(runId, { ...run, state });
  }

  failNext(type: string, error: Error): void {
    const failures = this.failures.get(type) ?? [];
    failures.push(error);
    this.failures.set(type, failures);
  }

  seedApproval(input: ApprovalRequest, id: string, status: ApprovalRecord['status'] = 'pending'): ApprovalRecord {
    const record: ApprovalRecord = {
      id, ...copy(input), status, createdAt: timestamp,
      ...(status === 'pending' ? {} : { resolvedAt: timestamp }),
    };
    this.approvals.set(id, copy(record));
    return copy(record);
  }

  putWorkspace(workspace: Workspace): Workspace { return copy(workspace); }
  getWorkspace(id: string): Workspace { assert.equal(id, this.workspace.id); return copy(this.workspace); }
  listWorkspaces(): Workspace[] { return [copy(this.workspace)]; }
  createSession(session: Session): Session { return copy(session); }
  getSession(id: string): Session { assert.equal(id, this.session.id); return copy(this.session); }
  listSessions(workspaceId: string): Session[] { assert.equal(workspaceId, this.workspace.id); return [copy(this.session)]; }
  admit(_input: SubmitInput): RunReceipt { throw new Error('Admission is outside approval tests'); }

  getRun(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new EngineError('NOT_FOUND', `Unknown run ${id}`);
    return copy(run);
  }

  commit(runId: string, type: string, payload: JsonObject, change: CommitChange = {}): EngineEvent {
    const failure = this.failures.get(type)?.shift();
    if (failure) throw failure;
    const run = this.getRun(runId);
    if (change.run) this.runs.set(runId, { ...run, ...copy(change.run) });
    if (change.approval) {
      assert.equal(change.approval.runId, runId);
      assert.equal(change.approval.sessionId, run.sessionId);
      this.approvals.set(change.approval.id, copy(change.approval));
    }
    const event: EngineEvent = {
      schemaVersion: SCHEMA_VERSION, eventId: `event-${this.events.length + 1}`,
      sessionId: run.sessionId, runId, seq: this.events.length + 1,
      timestamp, type, payload: copy(payload),
    };
    this.events.push(copy(event));
    this.commits.push({ event: copy(event), change: copy(change) });
    this.onCommit?.(copy(event));
    return copy(event);
  }

  getSnapshot(sessionId: string): SessionSnapshot {
    assert.equal(sessionId, this.session.id);
    return {
      session: copy(this.session), runs: [...this.runs.values()].map(copy),
      messages: [], tools: [], approvals: [...this.approvals.values()].map(copy),
      lastSeq: this.events.length,
    };
  }

  readEvents(sessionId: string, afterSeq: number, limit = 100): EngineEvent[] {
    return this.events.filter((event) => event.sessionId === sessionId && event.seq > afterSeq).slice(0, limit).map(copy);
  }

  async *subscribe(sessionId: string, afterSeq: number, signal?: AbortSignal): AsyncIterable<EngineEvent> {
    for (const event of this.readEvents(sessionId, afterSeq)) {
      if (signal?.aborted) return;
      yield event;
    }
  }

  getApproval(id: string): ApprovalRecord {
    const record = this.approvals.get(id);
    if (!record) throw new EngineError('NOT_FOUND', `Unknown approval ${id}`);
    return copy(record);
  }

  listCheckpoints(_runId: string): Checkpoint[] { return []; }
  recoverInterrupted(): Run[] { return []; }
  close(): void {}
}

function input(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    sessionId: 'session', runId: 'run', toolCallId: 'tool', toolName: 'run_command',
    fingerprint: 'sha256:exact-command-cwd', preview: { command: 'npm test', cwd: '.' },
    ...copy(overrides),
  };
}

function fixture() {
  const store = new FakeStore();
  return { store, manager: new ApprovalManager(store), signal: new AbortController() };
}

function pending(store: FakeStore, runId = 'run', toolCallId = 'tool'): ApprovalRecord {
  const record = [...store.approvals.values()].find((value) => value.runId === runId && value.toolCallId === toolCallId && value.status === 'pending');
  assert.ok(record, `Expected pending approval for ${runId}/${toolCallId}`);
  return copy(record);
}

function eventTypes(store: FakeStore): string[] { return store.events.map((event) => event.type); }
function assertRunOwnership(store: FakeStore): void { assert.ok(store.commits.every(({ change }) => change.run === undefined)); }

test('request durably records pending approval and an event before a matching decision resolves', options, async () => {
  const { store, manager, signal } = fixture();
  const waiting = manager.request(input(), signal.signal);
  const record = pending(store);
  assert.deepEqual(eventTypes(store), ['approval.requested']);
  assert.equal(record.fingerprint, input().fingerprint);
  assert.deepEqual(record.preview, input().preview);
  assert.equal(record.resolvedAt, undefined);
  let settled = false;
  void waiting.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  const decided = manager.decide(record.id, 'allow', record.fingerprint);
  assert.deepEqual(await waiting, decided);
  assert.equal(decided.status, 'allowed');
  assert.equal(typeof decided.resolvedAt, 'string');
  assert.deepEqual(store.getApproval(record.id), decided);
  assert.deepEqual(eventTypes(store), ['approval.requested', 'approval.resolved']);
  assert.equal(store.getRun('run').state, 'running');
  assertRunOwnership(store);
});

test('allow and deny retransmissions remain idempotent after the run terminates', options, async (t) => {
  for (const decision of ['allow', 'deny'] as const) {
    await t.test(decision, async () => {
      const { store, manager, signal } = fixture();
      const waiting = manager.request(input(), signal.signal);
      const record = pending(store);
      const first = manager.decide(record.id, decision, record.fingerprint);
      assert.equal((await waiting).status, decision === 'allow' ? 'allowed' : 'denied');
      const eventCount = store.events.length;
      store.setRunState('run', 'completed');
      assert.deepEqual(manager.decide(record.id, decision, record.fingerprint), first);
      assert.equal(store.events.length, eventCount);
      signal.abort();
      assert.equal(store.getApproval(record.id).status, first.status);
      assert.equal(store.events.length, eventCount);
      assertRunOwnership(store);
    });
  }
});

test('fingerprint mismatch cannot decide pending approval or bypass saved-decision checks', options, async () => {
  const { store, manager, signal } = fixture();
  const waiting = manager.request(input(), signal.signal);
  const record = pending(store);
  assert.throws(() => manager.decide(record.id, 'allow', `${record.fingerprint}-changed`), hasCode('APPROVAL_FINGERPRINT_MISMATCH'));
  assert.equal(store.getApproval(record.id).status, 'pending');
  assert.deepEqual(eventTypes(store), ['approval.requested']);
  manager.decide(record.id, 'allow', record.fingerprint);
  await waiting;
  assert.throws(() => manager.decide(record.id, 'allow', 'other-action'), hasCode('APPROVAL_FINGERPRINT_MISMATCH'));
  assert.equal(store.events.length, 2);
});

test('opposite decision retransmissions fail without overwriting the first decision', options, async (t) => {
  for (const first of ['allow', 'deny'] as const) {
    await t.test(first, async () => {
      const { store, manager, signal } = fixture();
      const waiting = manager.request(input(), signal.signal);
      const record = pending(store);
      const saved = manager.decide(record.id, first, record.fingerprint);
      await waiting;
      assert.throws(() => manager.decide(record.id, first === 'allow' ? 'deny' : 'allow', record.fingerprint), hasCode('APPROVAL_CONFLICT'));
      assert.deepEqual(store.getApproval(record.id), saved);
      assert.equal(store.events.length, 2);
    });
  }
});

test('an already aborted signal creates no durable approval or event', options, async () => {
  const { store, manager, signal } = fixture();
  signal.abort();
  await assert.rejects(manager.request(input(), signal.signal), hasCode('APPROVAL_CANCELLED'));
  assert.equal(store.approvals.size, 0);
  assert.equal(store.events.length, 0);
});

test('abort expires a pending request once and rejects any later decision', options, async () => {
  const { store, manager, signal } = fixture();
  const waiting = manager.request(input(), signal.signal);
  const record = pending(store);
  const rejected = assert.rejects(waiting, hasCode('APPROVAL_CANCELLED'));
  signal.abort();
  await rejected;
  assert.equal(store.getApproval(record.id).status, 'expired');
  assert.equal(typeof store.getApproval(record.id).resolvedAt, 'string');
  assert.throws(() => manager.decide(record.id, 'allow', record.fingerprint), hasCode('APPROVAL_EXPIRED'));
  manager.cancelRun('run');
  signal.abort();
  assert.deepEqual(eventTypes(store), ['approval.requested', 'approval.expired']);
  assert.equal(store.getRun('run').state, 'running');
  assertRunOwnership(store);
});

test('equivalent pending requests deduplicate durable rows while keeping separate wait promises', options, async () => {
  const { store, manager, signal } = fixture();
  const otherSignal = new AbortController();
  const first = manager.request(input({ preview: {
    command: 'npm test', cwd: '.', metadata: { label: 'Tests', files: [{ path: 'test.ts', hash: 'one' }] },
  } }), signal.signal);
  const second = manager.request(input({ preview: {
    metadata: { files: [{ hash: 'one', path: 'test.ts' }], label: 'Tests' }, cwd: '.', command: 'npm test',
  } }), otherSignal.signal);
  assert.notEqual(first, second);
  assert.equal(store.approvals.size, 1);
  assert.deepEqual(eventTypes(store), ['approval.requested']);
  const record = pending(store);
  const saved = manager.decide(record.id, 'allow', record.fingerprint);
  assert.deepEqual(await first, saved);
  assert.deepEqual(await second, saved);
  const count = store.events.length;
  signal.abort();
  otherSignal.abort();
  assert.equal(store.events.length, count);
});

test('aborting one duplicate waiter expires the approval and rejects every waiter', options, async () => {
  const { store, manager, signal } = fixture();
  const otherSignal = new AbortController();
  const first = manager.request(input(), signal.signal);
  const second = manager.request(input(), otherSignal.signal);
  const record = pending(store);
  const rejected = Promise.all([
    assert.rejects(first, hasCode('APPROVAL_CANCELLED')),
    assert.rejects(second, hasCode('APPROVAL_CANCELLED')),
  ]);
  otherSignal.abort();
  await rejected;
  signal.abort();
  assert.equal(store.getApproval(record.id).status, 'expired');
  assert.deepEqual(eventTypes(store), ['approval.requested', 'approval.expired']);
});

test('same run/tool requests with changed fingerprint, tool name, or preview conflict', options, async (t) => {
  const cases: { name: string; change: Partial<ApprovalRequest> }[] = [
    { name: 'fingerprint', change: { fingerprint: 'sha256:other-command' } },
    { name: 'tool name', change: { toolName: 'apply_patch' } },
    { name: 'preview', change: { preview: { command: 'npm run deploy', cwd: '.' } } },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const { store, manager, signal } = fixture();
      const waiting = manager.request(input(), signal.signal);
      const record = pending(store);
      await assert.rejects(manager.request(input(item.change), new AbortController().signal), hasCode('APPROVAL_REQUEST_CONFLICT'));
      assert.equal(store.approvals.size, 1);
      assert.deepEqual(eventTypes(store), ['approval.requested']);
      manager.decide(record.id, 'allow', record.fingerprint);
      assert.equal((await waiting).status, 'allowed');
    });
  }
});

test('resolved tool requests cannot reuse an earlier approval', options, async (t) => {
  for (const decision of ['allow', 'deny'] as const) {
    await t.test(decision, async () => {
      const { store, manager, signal } = fixture();
      const waiting = manager.request(input(), signal.signal);
      const record = pending(store);
      manager.decide(record.id, decision, record.fingerprint);
      await waiting;
      await assert.rejects(manager.request(input(), new AbortController().signal), hasCode('APPROVAL_STALE'));
      assert.equal(store.approvals.size, 1);
      assert.equal(store.events.length, 2);
    });
  }
});

test('new approvals are rejected for cancelling and terminal runs', options, async (t) => {
  const states: Run['state'][] = ['cancelling', 'completed', 'cancelled', 'failed', 'interrupted'];
  for (const state of states) {
    await t.test(state, async () => {
      const { store, manager, signal } = fixture();
      store.setRunState('run', state);
      await assert.rejects(manager.request(input(), signal.signal), hasCode('APPROVAL_RUN_INACTIVE'));
      assert.equal(store.approvals.size, 0);
      assert.equal(store.events.length, 0);
      assert.equal(store.getRun('run').state, state);
    });
  }
});

test('request works while the runner owns awaiting_approval state', options, async () => {
  const { store, manager, signal } = fixture();
  store.setRunState('run', 'awaiting_approval');
  const waiting = manager.request(input(), signal.signal);
  const record = pending(store);
  manager.decide(record.id, 'deny', record.fingerprint);
  assert.equal((await waiting).status, 'denied');
  assert.equal(store.getRun('run').state, 'awaiting_approval');
  assertRunOwnership(store);
});

test('a synchronous decision during pending commit notification is not lost', options, async () => {
  const { store, manager, signal } = fixture();
  store.onCommit = (event) => {
    if (event.type !== 'approval.requested') return;
    const record = pending(store);
    assert.equal(store.events.at(-1)?.type, 'approval.requested');
    manager.decide(record.id, 'allow', record.fingerprint);
  };
  const approved = await manager.request(input(), signal.signal);
  assert.equal(approved.status, 'allowed');
  assert.deepEqual(eventTypes(store), ['approval.requested', 'approval.resolved']);
});

test('a synchronous abort during pending commit notification expires the committed record', options, async () => {
  const { store, manager, signal } = fixture();
  store.onCommit = (event) => { if (event.type === 'approval.requested') signal.abort(); };
  await assert.rejects(manager.request(input(), signal.signal), hasCode('APPROVAL_CANCELLED'));
  assert.equal([...store.approvals.values()][0]?.status, 'expired');
  assert.deepEqual(eventTypes(store), ['approval.requested', 'approval.expired']);
});

test('a committed allow wins over abort reentry during its notification', options, async () => {
  const { store, manager, signal } = fixture();
  const waiting = manager.request(input(), signal.signal);
  const record = pending(store);
  store.onCommit = (event) => { if (event.type === 'approval.resolved') signal.abort(); };
  const decided = manager.decide(record.id, 'allow', record.fingerprint);
  assert.equal(signal.signal.aborted, true);
  assert.deepEqual(await waiting, decided);
  assert.equal(store.getApproval(record.id).status, 'allowed');
  assert.deepEqual(eventTypes(store), ['approval.requested', 'approval.resolved']);
});

test('a committed expiration wins over a late allow during its notification', options, async () => {
  const { store, manager, signal } = fixture();
  const waiting = manager.request(input(), signal.signal);
  const record = pending(store);
  store.onCommit = (event) => {
    if (event.type === 'approval.expired') assert.throws(() => manager.decide(record.id, 'allow', record.fingerprint), hasCode('APPROVAL_EXPIRED'));
  };
  const rejected = assert.rejects(waiting, hasCode('APPROVAL_CANCELLED'));
  signal.abort();
  await rejected;
  assert.equal(store.getApproval(record.id).status, 'expired');
  assert.deepEqual(eventTypes(store), ['approval.requested', 'approval.expired']);
});

test('failed pending commit leaves no durable row or phantom waiter and permits a fresh request', options, async () => {
  const { store, manager, signal } = fixture();
  const failure = new Error('pending commit failed');
  store.failNext('approval.requested', failure);
  await assert.rejects(manager.request(input(), signal.signal), (error: unknown) => error === failure);
  assert.equal(store.approvals.size, 0);
  assert.equal(store.events.length, 0);
  signal.abort();
  assert.equal(store.events.length, 0);
  const waiting = manager.request(input(), new AbortController().signal);
  const record = pending(store);
  manager.decide(record.id, 'allow', record.fingerprint);
  assert.equal((await waiting).status, 'allowed');
  assert.deepEqual(eventTypes(store), ['approval.requested', 'approval.resolved']);
});

test('failed decision commit keeps the approval pending until a successful retry', options, async () => {
  const { store, manager, signal } = fixture();
  const waiting = manager.request(input(), signal.signal);
  const record = pending(store);
  const failure = new Error('decision commit failed');
  store.failNext('approval.resolved', failure);
  assert.throws(() => manager.decide(record.id, 'allow', record.fingerprint), (error: unknown) => error === failure);
  assert.equal(store.getApproval(record.id).status, 'pending');
  assert.deepEqual(eventTypes(store), ['approval.requested']);
  let settled = false;
  void waiting.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  manager.decide(record.id, 'allow', record.fingerprint);
  assert.equal((await waiting).status, 'allowed');
  assert.deepEqual(eventTypes(store), ['approval.requested', 'approval.resolved']);
});

test('failed abort expiration rejects with storage error and orphan recovery cannot allow the action', options, async () => {
  const { store, manager, signal } = fixture();
  const waiting = manager.request(input(), signal.signal);
  const otherSignal = new AbortController();
  const otherWaiting = manager.request(input(), otherSignal.signal);
  const record = pending(store);
  const failure = new Error('expiration commit failed');
  store.failNext('approval.expired', failure);
  const rejected = Promise.all([
    assert.rejects(waiting, (error: unknown) => error === failure),
    assert.rejects(otherWaiting, (error: unknown) => error === failure),
  ]);
  signal.abort();
  await rejected;
  assert.equal(store.getApproval(record.id).status, 'pending');
  assert.deepEqual(eventTypes(store), ['approval.requested']);
  assert.throws(() => manager.decide(record.id, 'allow', record.fingerprint), hasCode('APPROVAL_EXPIRED'));
  assert.equal(store.getApproval(record.id).status, 'expired');
  otherSignal.abort();
  assert.deepEqual(eventTypes(store), ['approval.requested', 'approval.expired']);
});

test('a new manager expires durable pending on decide instead of reconstructing approval authority', options, async () => {
  const store = new FakeStore();
  const record = store.seedApproval(input(), 'orphan');
  const manager = new ApprovalManager(store);
  assert.throws(() => manager.decide(record.id, 'allow', record.fingerprint), hasCode('APPROVAL_EXPIRED'));
  assert.equal(store.getApproval(record.id).status, 'expired');
  assert.deepEqual(eventTypes(store), ['approval.expired']);
  assert.throws(() => manager.decide(record.id, 'allow', record.fingerprint), hasCode('APPROVAL_EXPIRED'));
  assert.equal(store.events.length, 1);
  assertRunOwnership(store);
});

test('a new manager expires a matching orphan request and does not create a replacement', options, async () => {
  const store = new FakeStore();
  const record = store.seedApproval(input(), 'orphan');
  const manager = new ApprovalManager(store);
  await assert.rejects(manager.request(input(), new AbortController().signal), hasCode('APPROVAL_EXPIRED'));
  assert.equal(store.approvals.size, 1);
  assert.equal(store.getApproval(record.id).status, 'expired');
  assert.deepEqual(eventTypes(store), ['approval.expired']);
});

test('failed orphan expiration preserves pending and rejects without granting approval', options, async () => {
  const store = new FakeStore();
  const record = store.seedApproval(input(), 'orphan');
  const manager = new ApprovalManager(store);
  const failure = new Error('recovery expiration failed');
  store.failNext('approval.expired', failure);
  assert.throws(() => manager.decide(record.id, 'allow', record.fingerprint), (error: unknown) => error === failure);
  assert.equal(store.getApproval(record.id).status, 'pending');
  assert.equal(store.events.length, 0);
  assert.throws(() => manager.decide(record.id, 'allow', record.fingerprint), hasCode('APPROVAL_EXPIRED'));
  assert.equal(store.getApproval(record.id).status, 'expired');
  assert.deepEqual(eventTypes(store), ['approval.expired']);
});

test('cancelRun expires live and orphan pending only for its run and preserves decisions', options, async () => {
  const { store, manager, signal } = fixture();
  store.addRun('other-run');
  const otherSignal = new AbortController();
  const first = manager.request(input(), signal.signal);
  const second = manager.request(input({ toolCallId: 'second-tool' }), signal.signal);
  const other = manager.request(input({ runId: 'other-run' }), otherSignal.signal);
  const firstRecord = pending(store);
  const secondRecord = pending(store, 'run', 'second-tool');
  const otherRecord = pending(store, 'other-run');
  const orphan = store.seedApproval(input({ toolCallId: 'orphan-tool' }), 'orphan');
  const allowed = store.seedApproval(input({ toolCallId: 'allowed-tool' }), 'allowed', 'allowed');
  const denied = store.seedApproval(input({ toolCallId: 'denied-tool' }), 'denied', 'denied');
  const alreadyExpired = store.seedApproval(input({ toolCallId: 'expired-tool' }), 'expired', 'expired');
  const rejected = Promise.all([
    assert.rejects(first, hasCode('APPROVAL_CANCELLED')),
    assert.rejects(second, hasCode('APPROVAL_CANCELLED')),
  ]);
  manager.cancelRun('run');
  await rejected;
  for (const id of [firstRecord.id, secondRecord.id, orphan.id]) assert.equal(store.getApproval(id).status, 'expired');
  assert.deepEqual(store.getApproval(allowed.id), allowed);
  assert.deepEqual(store.getApproval(denied.id), denied);
  assert.deepEqual(store.getApproval(alreadyExpired.id), alreadyExpired);
  assert.equal(store.getApproval(otherRecord.id).status, 'pending');
  assert.equal(store.events.filter((event) => event.type === 'approval.expired').length, 3);
  manager.cancelRun('run');
  signal.abort();
  assert.equal(store.events.filter((event) => event.type === 'approval.expired').length, 3);
  manager.decide(otherRecord.id, 'allow', otherRecord.fingerprint);
  assert.equal((await other).status, 'allowed');
  assertRunOwnership(store);
});

test('cancelRun reports a commit failure while continuing expiration of other requests', options, async () => {
  const { store, manager, signal } = fixture();
  const first = manager.request(input(), signal.signal);
  const second = manager.request(input({ toolCallId: 'second-tool' }), new AbortController().signal);
  const firstRecord = pending(store);
  const secondRecord = pending(store, 'run', 'second-tool');
  const failure = new Error('first cancellation commit failed');
  store.failNext('approval.expired', failure);
  const rejected = Promise.all([
    assert.rejects(first, (error: unknown) => error === failure),
    assert.rejects(second, hasCode('APPROVAL_CANCELLED')),
  ]);
  assert.throws(() => manager.cancelRun('run'), (error: unknown) => error === failure);
  await rejected;
  assert.equal(store.getApproval(firstRecord.id).status, 'pending');
  assert.equal(store.getApproval(secondRecord.id).status, 'expired');
  assert.equal(store.events.filter((event) => event.type === 'approval.expired').length, 1);
  assert.throws(() => manager.decide(firstRecord.id, 'allow', firstRecord.fingerprint), hasCode('APPROVAL_EXPIRED'));
  assert.equal(store.getApproval(firstRecord.id).status, 'expired');
  assert.equal(store.events.filter((event) => event.type === 'approval.expired').length, 2);
  assertRunOwnership(store);
});

test('same fingerprint on different tool calls cannot share an approval', options, async () => {
  const { store, manager, signal } = fixture();
  const first = manager.request(input(), signal.signal);
  const second = manager.request(input({ toolCallId: 'another-tool' }), new AbortController().signal);
  const firstRecord = pending(store);
  const secondRecord = pending(store, 'run', 'another-tool');
  assert.notEqual(firstRecord.id, secondRecord.id);
  assert.equal(store.approvals.size, 2);
  manager.decide(firstRecord.id, 'allow', firstRecord.fingerprint);
  assert.equal((await first).status, 'allowed');
  assert.equal(store.getApproval(secondRecord.id).status, 'pending');
  manager.decide(secondRecord.id, 'deny', secondRecord.fingerprint);
  assert.equal((await second).status, 'denied');
});

test('pending approval expires if its Run becomes cancelling or terminal before the decision', options, async (t) => {
  const states: Run['state'][] = ['cancelling', 'completed', 'cancelled', 'failed', 'interrupted'];
  for (const state of states) {
    await t.test(state, async () => {
      const { store, manager, signal } = fixture();
      const waiting = manager.request(input(), signal.signal);
      const record = pending(store);
      store.setRunState('run', state);
      const rejected = assert.rejects(waiting, hasCode('APPROVAL_EXPIRED'));
      assert.throws(() => manager.decide(record.id, 'allow', record.fingerprint), hasCode('APPROVAL_EXPIRED'));
      await rejected;
      assert.equal(store.getApproval(record.id).status, 'expired');
      assert.equal(store.getRun('run').state, state);
      assert.deepEqual(eventTypes(store), ['approval.requested', 'approval.expired']);
      assertRunOwnership(store);
    });
  }
});

test('durable request changes cannot be authorized by an older memory waiter', options, async (t) => {
  const changes: { name: string; change: Partial<ApprovalRecord> }[] = [
    { name: 'fingerprint', change: { fingerprint: 'sha256:replacement-action' } },
    { name: 'tool name', change: { toolName: 'apply_patch' } },
    { name: 'preview', change: { preview: { command: 'npm run deploy', cwd: '.' } } },
  ];
  for (const item of changes) {
    await t.test(item.name, async () => {
      const { store, manager, signal } = fixture();
      const waiting = manager.request(input(), signal.signal);
      const record = pending(store);
      const changed: ApprovalRecord = { ...record, ...copy(item.change) };
      store.approvals.set(record.id, changed);
      const rejected = assert.rejects(waiting, hasCode('APPROVAL_EXPIRED'));
      assert.throws(() => manager.decide(record.id, 'allow', changed.fingerprint), hasCode('APPROVAL_EXPIRED'));
      await rejected;
      assert.equal(store.getApproval(record.id).status, 'expired');
      assert.deepEqual(eventTypes(store), ['approval.requested', 'approval.expired']);
    });
  }
});

test('an already aborted duplicate request does not cancel the existing live request', options, async () => {
  const { store, manager, signal } = fixture();
  const waiting = manager.request(input(), signal.signal);
  const record = pending(store);
  const duplicateSignal = new AbortController();
  duplicateSignal.abort();
  await assert.rejects(manager.request(input(), duplicateSignal.signal), hasCode('APPROVAL_CANCELLED'));
  assert.equal(store.getApproval(record.id).status, 'pending');
  assert.deepEqual(eventTypes(store), ['approval.requested']);
  manager.decide(record.id, 'allow', record.fingerprint);
  assert.equal((await waiting).status, 'allowed');
});

test('a synchronous duplicate request during pending commit notification joins the live approval', options, async () => {
  const { store, manager, signal } = fixture();
  let duplicate: Promise<ApprovalRecord> | undefined;
  store.onCommit = (event) => {
    if (event.type === 'approval.requested') duplicate = manager.request(input(), new AbortController().signal);
  };
  const waiting = manager.request(input(), signal.signal);
  assert.ok(duplicate);
  const record = pending(store);
  manager.decide(record.id, 'deny', record.fingerprint);
  assert.equal((await waiting).status, 'denied');
  assert.equal((await duplicate).status, 'denied');
  assert.equal(store.approvals.size, 1);
  assert.deepEqual(eventTypes(store), ['approval.requested', 'approval.resolved']);
});

test('cancelRun during pending commit notification expires the committed request', options, async () => {
  const { store, manager, signal } = fixture();
  store.onCommit = (event) => { if (event.type === 'approval.requested') manager.cancelRun('run'); };
  await assert.rejects(manager.request(input(), signal.signal), hasCode('APPROVAL_CANCELLED'));
  assert.equal([...store.approvals.values()][0]?.status, 'expired');
  assert.deepEqual(eventTypes(store), ['approval.requested', 'approval.expired']);
  assertRunOwnership(store);
});

test('mutating caller input cannot change the prepared fingerprint or durable preview', options, async () => {
  const { store, manager, signal } = fixture();
  const request = input();
  const expected = copy(request);
  const waiting = manager.request(request, signal.signal);
  const record = pending(store);
  request.fingerprint = 'sha256:mutated-after-request';
  request.preview.command = 'npm run deploy';
  assert.equal(store.getApproval(record.id).fingerprint, expected.fingerprint);
  assert.deepEqual(store.getApproval(record.id).preview, expected.preview);
  assert.throws(() => manager.decide(record.id, 'allow', request.fingerprint), hasCode('APPROVAL_FINGERPRINT_MISMATCH'));
  manager.decide(record.id, 'allow', expected.fingerprint);
  assert.equal((await waiting).fingerprint, expected.fingerprint);
});

test('returned decisions and each waiter result are independent copies of durable state', options, async () => {
  const { store, manager, signal } = fixture();
  const first = manager.request(input(), signal.signal);
  const second = manager.request(input(), new AbortController().signal);
  const record = pending(store);
  const returned = manager.decide(record.id, 'allow', record.fingerprint);
  const firstResult = await first;
  const secondResult = await second;
  returned.preview.command = 'changed-return';
  firstResult.preview.command = 'changed-first-waiter';
  firstResult.fingerprint = 'changed-first-fingerprint';
  assert.deepEqual(secondResult.preview, record.preview);
  assert.equal(secondResult.fingerprint, record.fingerprint);
  assert.deepEqual(store.getApproval(record.id).preview, record.preview);
  assert.equal(store.getApproval(record.id).fingerprint, record.fingerprint);
  assert.deepEqual(manager.decide(record.id, 'allow', record.fingerprint), store.getApproval(record.id));
  assert.equal(store.events.length, 2);
});

test('extra structurally typed input fields cannot override the generated record identity or lifecycle', options, async () => {
  const { store, manager, signal } = fixture();
  const request = {
    ...input(), id: 'caller-chosen-id', status: 'allowed',
    createdAt: 'caller-chosen-time', resolvedAt: 'caller-chosen-resolution',
  };
  const waiting = manager.request(request, signal.signal);
  const record = pending(store);
  assert.notEqual(record.id, request.id);
  assert.notEqual(record.createdAt, request.createdAt);
  assert.equal(record.status, 'pending');
  assert.equal(record.resolvedAt, undefined);
  manager.decide(record.id, 'allow', record.fingerprint);
  assert.equal((await waiting).status, 'allowed');
});
