import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import test from 'node:test';
import {
  DEFAULT_LIMITS, EngineError, SCHEMA_VERSION, isTerminal,
  type ApprovalRecord, type Checkpoint, type EngineEvent, type JsonObject,
  type Message, type Run, type RunLimits, type RunReceipt, type Session,
  type SessionSnapshot, type SubmitInput, type ToolCallRecord, type Workspace,
} from '@moodcode/contracts';
import type {
  ApprovalPort, ApprovalRequest, CommitChange, ContextBuilder, EngineStore,
  PreparedTool, ProviderAdapter, ProviderEvent, ToolContext, ToolDefinition,
  ToolResult, TurnRequest,
} from '../ports.js';
import { RunCoordinator } from './index.js';
import { normalizeEngineBudgets } from '@moodcode/contracts/validation';

const now = (): string => new Date().toISOString();
const copy = <T>(value: T): T => structuredClone(value);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await nextTick();
  }
}

/** Return copies as a durable store does, so mutations outside commit are visible as bugs. */
class FakeStore implements EngineStore {
  readonly workspace: Workspace = { id: 'workspace', root: '/fake/workspace', gitRoot: '/fake/workspace', branch: 'main', createdAt: now() };
  readonly session: Session = { id: 'session', workspaceId: 'workspace', title: 'Runner test', createdAt: now() };
  readonly runs = new Map<string, Run>();
  readonly messages = new Map<string, Message>();
  readonly toolRows = new Map<string, ToolCallRecord>();
  readonly approvalRows = new Map<string, ApprovalRecord>();
  readonly checkpoints = new Map<string, Checkpoint>();
  readonly events: EngineEvent[] = [];
  readonly commits: { event: EngineEvent; change: CommitChange }[] = [];
  private readonly receipts = new Map<string, { input: string; receipt: RunReceipt }>();
  private serial = 0;

  putWorkspace(workspace: Workspace): Workspace { return copy(workspace); }
  getWorkspace(id: string): Workspace {
    if (id !== this.workspace.id) throw new EngineError('WORKSPACE_NOT_FOUND', `Unknown workspace ${id}`);
    return copy(this.workspace);
  }
  listWorkspaces(): Workspace[] { return [copy(this.workspace)]; }
  createSession(session: Session): Session { return copy(session); }
  getSession(id: string): Session { assert.equal(id, this.session.id); return copy(this.session); }
  listSessions(workspaceId: string): Session[] { assert.equal(workspaceId, this.workspace.id); return [copy(this.session)]; }
  admit(input: SubmitInput): RunReceipt {
    const key = `${input.sessionId}/${input.requestId}`;
    const serialized = JSON.stringify(input);
    const existing = this.receipts.get(key);
    if (existing) {
      if (existing.input !== serialized) throw new EngineError('REQUEST_ID_CONFLICT', 'Request content changed');
      return { ...copy(existing.receipt), duplicate: true };
    }
    if ([...this.runs.values()].some((run) => !isTerminal(run.state))) throw new EngineError('WORKSPACE_BUSY', 'Workspace already has a run');
    const id = `run-${++this.serial}`;
    const run: Run = {
      id, inputId: `input-${this.serial}`, workspaceId: this.workspace.id,
      ...copy(input), state: 'created', createdAt: now(), updatedAt: now(),
    };
    this.runs.set(id, run);
    this.messages.set(run.inputId, {
      id: run.inputId, sessionId: run.sessionId, runId: id, role: 'user', content: run.prompt, createdAt: now(),
    });
    const event = this.commit(id, 'input.admitted', { inputId: run.inputId });
    const receipt = { runId: id, inputId: run.inputId, admittedSeq: event.seq, duplicate: false };
    this.receipts.set(key, { input: serialized, receipt });
    return copy(receipt);
  }
  getRun(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new EngineError('NOT_FOUND', `Unknown run ${id}`);
    return copy(run);
  }
  commit(runId: string, type: string, payload: JsonObject, change: CommitChange = {}): EngineEvent {
    const run = this.runs.get(runId);
    assert.ok(run, `Commit must refer to admitted run ${runId}`);
    if (change.run) Object.assign(run, copy(change.run), { updatedAt: now() });
    if (change.message) this.messages.set(change.message.id, copy(change.message));
    if (change.tool) this.toolRows.set(change.tool.id, copy(change.tool));
    if (change.approval) this.approvalRows.set(change.approval.id, copy(change.approval));
    if (change.checkpoint) this.checkpoints.set(change.checkpoint.id, copy(change.checkpoint));
    const event: EngineEvent = {
      schemaVersion: SCHEMA_VERSION, eventId: `event-${this.events.length + 1}`,
      sessionId: run.sessionId, runId, seq: this.events.length + 1,
      timestamp: now(), type, payload: copy(payload),
    };
    this.events.push(event);
    this.commits.push({ event: copy(event), change: copy(change) });
    return copy(event);
  }
  getSnapshot(sessionId: string): SessionSnapshot {
    assert.equal(sessionId, this.session.id);
    return {
      session: copy(this.session), runs: [...this.runs.values()].map(copy),
      messages: [...this.messages.values()].map(copy), tools: [...this.toolRows.values()].map(copy),
      approvals: [...this.approvalRows.values()].map(copy), lastSeq: this.events.length,
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
  getApproval(id: string): ApprovalRecord { const record = this.approvalRows.get(id); assert.ok(record); return copy(record); }
  listCheckpoints(runId: string): Checkpoint[] { return [...this.checkpoints.values()].filter((value) => value.runId === runId).map(copy); }
  recoverInterrupted(): Run[] { return []; }
  close(): void {}
  terminalCommits(runId: string) {
    return this.commits.filter(({ event, change }) => event.runId === runId && change.run?.state && isTerminal(change.run.state));
  }
}

/** Approval records are owned here; Run transitions must be committed by the runner. */
class FakeApprovals implements ApprovalPort {
  readonly requests: ApprovalRequest[] = [];
  readonly requestRunStates: Run['state'][] = [];
  readonly cancelledRuns: string[] = [];
  private readonly pending = new Map<string, {
    record: ApprovalRecord; resolve: (value: ApprovalRecord) => void;
    reject: (reason?: unknown) => void; detach: () => void;
  }>();
  constructor(private readonly store: FakeStore) {}
  request(input: ApprovalRequest, signal: AbortSignal): Promise<ApprovalRecord> {
    this.requests.push(copy(input));
    this.requestRunStates.push(this.store.getRun(input.runId).state);
    const record: ApprovalRecord = { id: `approval-${this.requests.length}`, ...copy(input), status: 'pending', createdAt: now() };
    this.store.commit(input.runId, 'approval.requested', { approvalId: record.id }, { approval: record });
    const waiter = deferred<ApprovalRecord>();
    const abort = () => this.expire(record.id);
    signal.addEventListener('abort', abort, { once: true });
    this.pending.set(record.id, { record, resolve: waiter.resolve, reject: waiter.reject, detach: () => signal.removeEventListener('abort', abort) });
    if (signal.aborted) this.expire(record.id);
    return waiter.promise;
  }
  decide(id: string, decision: 'allow' | 'deny', fingerprint: string): ApprovalRecord {
    const prior = this.store.getApproval(id);
    assert.equal(prior.fingerprint, fingerprint);
    if (prior.status !== 'pending') return prior;
    const record: ApprovalRecord = { ...prior, status: decision === 'allow' ? 'allowed' : 'denied', resolvedAt: now() };
    this.store.commit(record.runId, 'approval.decided', { approvalId: id, status: record.status }, { approval: record });
    const pending = this.pending.get(id);
    assert.ok(pending);
    pending.detach();
    this.pending.delete(id);
    pending.resolve(copy(record));
    return copy(record);
  }
  cancelRun(runId: string): void {
    this.cancelledRuns.push(runId);
    for (const [id, pending] of [...this.pending]) if (pending.record.runId === runId) this.expire(id);
  }
  private expire(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    const record: ApprovalRecord = { ...pending.record, status: 'expired', resolvedAt: now() };
    this.store.commit(record.runId, 'approval.expired', { approvalId: id }, { approval: record });
    pending.detach();
    this.pending.delete(id);
    pending.reject(new EngineError('ABORTED', 'Approval wait was cancelled'));
  }
}

type Stream = (request: TurnRequest, signal: AbortSignal) => AsyncIterable<ProviderEvent>;
class FakeProvider implements ProviderAdapter {
  readonly id = 'fake';
  readonly requests: TurnRequest[] = [];
  readonly signals: AbortSignal[] = [];
  constructor(private readonly stream: Stream) {}
  streamTurn(request: TurnRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this.requests.push(copy(request));
    this.signals.push(signal);
    return this.stream(request, signal);
  }
}

function scripted(turns: ProviderEvent[][]): FakeProvider {
  return new FakeProvider(async function* (request) {
    const events = turns[request.turnIndex];
    assert.ok(events, `Unexpected provider turn ${request.turnIndex}`);
    for (const event of events) yield copy(event);
  });
}

function tool(name: string, requiresApproval: boolean, execute: (prepared: PreparedTool, context: ToolContext) => Promise<ToolResult>, trace: string[] = []): ToolDefinition {
  return {
    name, description: `${name} fake tool`, inputSchema: { type: 'object' },
    async prepare(input, context) {
      assert.equal(context.signal.aborted, false);
      trace.push(`prepare:${name}`);
      return { name, input: copy(input) as PreparedTool['input'], fingerprint: `${name}:${JSON.stringify(input)}`, requiresApproval, preview: { tool: name } };
    },
    async execute(prepared, context) {
      trace.push(`execute:${name}`);
      return execute(prepared, context);
    },
  };
}

function fixture(provider: FakeProvider, tools: ToolDefinition[] = [], buildContext?: ContextBuilder) {
  const store = new FakeStore();
  const approvals = new FakeApprovals(store);
  const contextRequests: Parameters<ContextBuilder>[0][] = [];
  const runner = new RunCoordinator({
    store, providers: new Map([[provider.id, provider]]), tools, approvals, artifactDir: '/fake/artifacts',
    buildContext: async (request: Parameters<ContextBuilder>[0]) => {
      contextRequests.push({ ...request, workspace: copy(request.workspace), snapshot: copy(request.snapshot), config: copy(request.config) });
      assert.equal(request.signal.aborted, false);
      if (buildContext) return buildContext(request);
      return request.snapshot.messages.map(({ role, content, toolCalls, toolCallId, providerReplay }) => ({ role, content, toolCalls, toolCallId, ...(providerReplay ? { providerReplay } : {}) }));
    },
  });
  const input = (mode: 'plan' | 'build' = 'build', limits: Partial<RunLimits> = {}): SubmitInput => ({
    sessionId: store.session.id, requestId: 'request-1', prompt: 'Please test the runner',
    config: { providerId: provider.id, modelId: 'test-model', mode, limits: { ...DEFAULT_LIMITS, ...limits } },
  });
  return { store, approvals, runner, input, contextRequests };
}

const finish = { type: 'finish', reason: 'stop' } as const;
const call = (id: string, name: string): ProviderEvent => ({ type: 'tool.call', call: { id, name, input: {} } });
const finishTools = { type: 'finish', reason: 'tool_calls' } as const;

test('steer arriving during an awaited context rebuild reaches the first provider dispatch without consuming a turn', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  let builds = 0;
  const provider = scripted([[finish]]);
  const f = fixture(provider, [], async request => {
    if (++builds === 2) { entered.resolve(); await release.promise; }
    return request.snapshot.messages.map(({ role, content }) => ({ role, content }));
  });
  const pending = ['First steer before rebuilding'];
  let serial = 0;
  f.runner.setSessionHooks({ boundary(run) {
    const content = pending.shift(); if (!content) return false;
    const id = `steer-${++serial}`;
    f.store.messages.set(id, { id, sessionId: run.sessionId, runId: run.id, role: 'user', content, createdAt: now() });
    return true;
  }, settled() {}, workspaceIdle() {}, cancelled() {} });
  try {
    const receipt = f.runner.submit(f.input());
    await entered.promise;
    pending.push('Latest steer admitted while context was awaiting'); release.resolve();
    const run = await f.runner.waitForRun(receipt.runId);
    assert.equal(run.state, 'completed'); assert.equal(provider.requests.length, 1); assert.equal(builds, 3);
    assert.ok(provider.requests[0]!.messages.some(message => message.content === 'Latest steer admitted while context was awaiting'));
    assert.equal(f.runner.getRunUsage(run.id).turns, 1);
  } finally { release.resolve(); await f.runner.close(); }
});

test('continuous steer arrivals cannot create unbounded context rebuilds or a stale provider dispatch', async () => {
  const provider = scripted([[finish]]), f = fixture(provider);
  f.runner.setSessionHooks({ boundary() { return true; }, settled() {}, workspaceIdle() {}, cancelled() {} });
  try {
    const receipt = f.runner.submit(f.input()), run = await f.runner.waitForRun(receipt.runId);
    assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'STEER_CONTEXT_LIMIT');
    assert.equal(provider.requests.length, 0); assert.equal(f.contextRequests.length, 17);
    assert.equal(f.runner.getRunUsage(run.id).turns, 0);
  } finally { await f.runner.close(); }
});

test('explicit turn allowance stops continuation while the Run absolute limit remains larger', async () => {
  const provider = scripted([[call('c1', 'read_file'), finishTools], [finish]]);
  const { runner, input } = fixture(provider, [tool('read_file', false, async () => ({ content: 'observation' }))]);
  try {
    const request = input('build', { maxTurns: 4 });
    request.config.budgets = normalizeEngineBudgets({ turnAllowance: 1 });
    const receipt = runner.submit(request);
    const run = await runner.waitForRun(receipt.runId);
    assert.equal(run.state, 'failed');
    assert.equal(run.error?.code, 'TURN_ALLOWANCE');
    assert.equal(provider.requests.length, 1);
  } finally { await runner.close(); }
});

test('per-turn tool allowance refuses an entire oversized batch before any tool effect', async () => {
  const provider = scripted([[call('c1', 'read_file'), call('c2', 'read_file'), finishTools], [finish]]);
  let executions = 0;
  const { runner, input, store } = fixture(provider, [tool('read_file', false, async () => { executions++; return { content: 'observation' }; })]);
  try {
    const request = input('build', { maxToolCalls: 9 });
    request.config.budgets = normalizeEngineBudgets({ maxToolCallsPerTurn: 1 });
    const receipt = runner.submit(request);
    const run = await runner.waitForRun(receipt.runId);
    assert.equal(run.error?.code, 'TURN_TOOL_LIMIT');
    assert.equal(executions, 0);
    assert.equal(store.toolRows.size, 0);
  } finally { await runner.close(); }
});

test('duplicate admission reuses both an active and completed run without calling the provider twice', { timeout: 5_000 }, async () => {
  const release = deferred<void>();
  const provider = new FakeProvider(async function* () { await release.promise; yield { type: 'text.delta', delta: 'done' }; yield finish; });
  const { runner, input, store, contextRequests } = fixture(provider);
  try {
    const first = runner.submit(input());
    const duplicate = runner.submit(input());
    assert.deepEqual(duplicate, { ...first, duplicate: true });
    await until(() => provider.requests.length === 1, 'first provider call');
    release.resolve();
    assert.equal((await runner.waitForRun(first.runId)).state, 'completed');
    assert.deepEqual(runner.submit(input()), { ...first, duplicate: true });
    assert.equal(provider.requests.length, 1);
    assert.equal(contextRequests.length, 1);
    assert.equal(store.getSnapshot(store.session.id).messages.filter((message) => message.role === 'user').length, 1);
    assert.equal(store.terminalCommits(first.runId).length, 1);
  } finally { release.resolve(); await runner.close(); }
});

test('streamed text is committed before completion and usage survives alongside the final assistant message', { timeout: 5_000 }, async () => {
  const release = deferred<void>();
  const provider = new FakeProvider(async function* () {
    yield { type: 'text.delta', delta: 'first ' };
    await release.promise;
    yield { type: 'text.delta', delta: 'second' };
    yield { type: 'usage', inputTokens: 7, outputTokens: 3 };
    yield finish;
  });
  const { runner, store, input } = fixture(provider);
  try {
    const receipt = runner.submit(input());
    await until(() => store.events.some((event) => event.type === 'message.delta'), 'committed delta');
    assert.equal(store.terminalCommits(receipt.runId).length, 0);
    assert.ok(JSON.stringify(store.events.find((event) => event.type === 'message.delta')?.payload).includes('first '));
    release.resolve();
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'completed');
    const messages = store.getSnapshot(store.session.id).messages.filter((message) => message.role === 'assistant');
    assert.equal(messages.map((message) => message.content).join(''), 'first second');
    assert.ok(store.events.some((event) => event.type.includes('usage') && JSON.stringify(event.payload).includes('7') && JSON.stringify(event.payload).includes('3')));
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { release.resolve(); await runner.close(); }
});

test('complete tool calls execute in order, approval sees a committed waiting state, and checkpoints commit with workspace events', { timeout: 5_000 }, async () => {
  const trace: string[] = [];
  const provider = scripted([[call('read-id', 'read_file'), call('patch-id', 'apply_patch'), finishTools], [{ type: 'text.delta', delta: 'verified' }, finish]]);
  const read = tool('read_file', false, async () => { trace.push('read:done'); return { content: 'file contents' }; }, trace);
  let patchContext: ToolContext | undefined;
  let fixtureStore: FakeStore;
  const patch = tool('apply_patch', true, async (_prepared, context) => {
    assert.equal(fixtureStore.getRun(context.runId).state, 'running');
    patchContext = context;
    context.recordCheckpoint({
      id: 'checkpoint-1', runId: context.runId, toolCallId: context.toolCallId, kind: 'patch', createdAt: now(),
      files: [{ path: 'hello.txt', before: 'old', after: 'new', beforeHash: 'before-hash', afterHash: 'after-hash' }], warnings: [],
    });
    return { content: 'patch applied' };
  }, trace);
  const { runner, store, approvals, input } = fixture(provider, [read, patch]);
  fixtureStore = store;
  try {
    const receipt = runner.submit(input());
    await until(() => approvals.requests.length === 1, 'patch approval');
    assert.deepEqual(trace, ['prepare:read_file', 'execute:read_file', 'read:done', 'prepare:apply_patch']);
    assert.deepEqual(approvals.requestRunStates, ['awaiting_approval']);
    assert.equal(provider.requests.length, 1);
    const approval = [...store.approvalRows.values()][0]!;
    approvals.decide(approval.id, 'allow', approval.fingerprint);
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'completed');
    assert.deepEqual(trace, ['prepare:read_file', 'execute:read_file', 'read:done', 'prepare:apply_patch', 'execute:apply_patch']);
    assert.ok(patchContext);
    const secondTurn = provider.requests[1]!;
    assert.equal(secondTurn.modelId, 'test-model');
    assert.deepEqual(secondTurn.tools.map((value) => value.name), ['read_file', 'apply_patch']);
    const assistant = secondTurn.messages.find((message) => message.role === 'assistant' && message.toolCalls);
    assert.deepEqual(assistant?.toolCalls?.map((value) => value.id), ['read-id', 'patch-id']);
    const results = secondTurn.messages.filter((message) => message.role === 'tool');
    assert.deepEqual(results.map((message) => message.toolCallId), ['read-id', 'patch-id']);
    assert.ok(results[0]!.content.includes('file contents'));
    assert.ok(results[1]!.content.includes('patch applied'));
    assert.equal([...store.toolRows.values()].filter((value) => value.state === 'completed').length, 2);
    const checkpointCommit = store.commits.find(({ change }) => change.checkpoint?.id === 'checkpoint-1');
    assert.equal(checkpointCommit?.event.type, 'workspace.changed');
    assert.equal(store.listCheckpoints(receipt.runId).length, 1);
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { await runner.close(); }
});

test('denied approval is returned as a tool result without executing the prepared effect', { timeout: 5_000 }, async () => {
  let executions = 0;
  const provider = scripted([[call('command-id', 'run_command'), finishTools], [finish]]);
  const command = tool('run_command', true, async () => { executions++; return { content: 'should not happen' }; });
  const { runner, input, approvals, store } = fixture(provider, [command]);
  try {
    const receipt = runner.submit(input());
    await until(() => approvals.requests.length === 1, 'command approval');
    const approval = [...store.approvalRows.values()][0]!;
    approvals.decide(approval.id, 'deny', approval.fingerprint);
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'completed');
    assert.equal(executions, 0);
    assert.equal([...store.toolRows.values()][0]?.state, 'denied');
    assert.ok(provider.requests[1]?.messages.some((message) => message.role === 'tool' && message.toolCallId === 'command-id' && message.content.length > 0));
  } finally { await runner.close(); }
});

test('plan mode refuses an approval-requiring tool without asking for approval or executing it', { timeout: 5_000 }, async () => {
  let executions = 0;
  const provider = scripted([[call('patch-id', 'apply_patch'), finishTools], [finish]]);
  const patch = tool('apply_patch', true, async () => { executions++; return { content: 'should not happen' }; });
  const { runner, input, approvals, store } = fixture(provider, [patch]);
  try {
    const receipt = runner.submit(input('plan'));
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'completed');
    assert.equal(executions, 0);
    assert.equal(approvals.requests.length, 0);
    assert.ok(provider.requests[1]?.messages.some((message) => message.role === 'tool' && message.toolCallId === 'patch-id' && message.content.length > 0));
    assert.ok(['denied', 'failed'].includes([...store.toolRows.values()][0]?.state ?? ''));
  } finally { await runner.close(); }
});

test('unknown tools and preparation errors remain tool results and never execute an effect', { timeout: 5_000 }, async () => {
  let executions = 0;
  const invalid = tool('invalid_input', false, async () => { executions++; return { content: 'unexpected' }; });
  invalid.prepare = async () => { throw new EngineError('INVALID_INPUT', 'Input is invalid'); };
  const provider = scripted([[call('unknown-id', 'missing_tool'), call('invalid-id', 'invalid_input'), finishTools], [finish]]);
  const { runner, input, store } = fixture(provider, [invalid]);
  try {
    const receipt = runner.submit(input());
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'completed');
    assert.equal(executions, 0);
    assert.deepEqual(provider.requests[1]?.messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId), ['unknown-id', 'invalid-id']);
    assert.equal([...store.toolRows.values()].filter((value) => value.state === 'failed').length, 2);
  } finally { await runner.close(); }
});

test('tool-call and turn budgets prevent additional effects or provider turns', { timeout: 5_000 }, async (t) => {
  await t.test('tool-call budget', async () => {
    const executed: string[] = [];
    const read = tool('read_file', false, async (_prepared, context) => { executed.push(context.toolCallId); return { content: 'read' }; });
    const provider = scripted([[call('one', 'read_file'), call('two', 'read_file'), finishTools], [finish]]);
    const { runner, input, store } = fixture(provider, [read]);
    try {
      const receipt = runner.submit(input('build', { maxToolCalls: 1 }));
      const final = await runner.waitForRun(receipt.runId);
      assert.equal(final.state, 'failed');
      assert.ok(final.error);
      assert.ok(executed.length <= 1);
      assert.ok(!executed.includes('two'));
      assert.equal(provider.requests.length, 1);
      assert.equal(store.terminalCommits(receipt.runId).length, 1);
    } finally { await runner.close(); }
  });
  await t.test('turn budget', async () => {
    const read = tool('read_file', false, async () => ({ content: 'read' }));
    const provider = scripted([[call('one', 'read_file'), finishTools], [finish]]);
    const { runner, input, store, contextRequests } = fixture(provider, [read]);
    try {
      const receipt = runner.submit(input('build', { maxTurns: 1 }));
      assert.equal((await runner.waitForRun(receipt.runId)).state, 'failed');
      assert.equal(provider.requests.length, 1);
      assert.equal(contextRequests.length, 1);
      assert.equal(store.terminalCommits(receipt.runId).length, 1);
    } finally { await runner.close(); }
  });
});

test('output budget counts UTF-8 bytes and preserves only bounded committed text', { timeout: 5_000 }, async () => {
  const provider = scripted([[{ type: 'text.delta', delta: '가나다' }, finish]]);
  const { runner, input, store } = fixture(provider);
  try {
    const receipt = runner.submit(input('build', { maxOutputBytes: 5 }));
    const final = await runner.waitForRun(receipt.runId);
    assert.equal(final.state, 'failed');
    assert.ok(final.error);
    const content = store.getSnapshot(store.session.id).messages.filter((message) => message.role === 'assistant').map((message) => message.content).join('');
    assert.ok(Buffer.byteLength(content, 'utf8') <= 5);
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { await runner.close(); }
});

test('provider length and missing finish are failures while earlier text remains recorded', { timeout: 5_000 }, async (t) => {
  for (const reason of ['length', 'missing'] as const) {
    await t.test(reason, async () => {
      const events: ProviderEvent[] = [{ type: 'text.delta', delta: 'partial answer' }];
      if (reason === 'length') events.push({ type: 'finish', reason: 'length' });
      const provider = scripted([events]);
      const { runner, input, store } = fixture(provider);
      try {
        const receipt = runner.submit(input());
        const final = await runner.waitForRun(receipt.runId);
        assert.equal(final.state, 'failed');
        assert.ok(final.error);
        assert.ok(store.getSnapshot(store.session.id).messages.some((message) => message.role === 'assistant' && message.content.includes('partial answer')));
        assert.equal(store.terminalCommits(receipt.runId).length, 1);
      } finally { await runner.close(); }
    });
  }
});

test('cancellation discards late provider events and commits exactly one terminal state', { timeout: 5_000 }, async () => {
  const release = deferred<void>();
  const provider = new FakeProvider(async function* () {
    yield { type: 'text.delta', delta: 'before cancel' };
    await release.promise;
    yield { type: 'text.delta', delta: 'late result must disappear' };
    yield finish;
  });
  const { runner, input, store, approvals } = fixture(provider);
  try {
    const receipt = runner.submit(input());
    await until(() => store.events.some((event) => event.type === 'message.delta'), 'initial provider delta');
    const cancellation = runner.cancel(receipt.runId);
    assert.equal(cancellation.runId, receipt.runId);
    assert.ok(['cancelling', 'cancelled'].includes(cancellation.state));
    assert.equal(provider.signals[0]?.aborted, true);
    release.resolve();
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'cancelled');
    assert.ok(!JSON.stringify(store.getSnapshot(store.session.id)).includes('late result must disappear'));
    assert.ok(!JSON.stringify(store.events).includes('late result must disappear'));
    assert.equal(provider.requests.length, 1);
    assert.ok(approvals.cancelledRuns.includes(receipt.runId));
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
    assert.equal(runner.cancel(receipt.runId).state, 'cancelled');
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'cancelled');
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { release.resolve(); await runner.close(); }
});

test('cancelling an approval wait expires the pending approval and performs no tool effect', { timeout: 5_000 }, async () => {
  let executions = 0;
  const provider = scripted([[call('command-id', 'run_command'), finishTools], [finish]]);
  const command = tool('run_command', true, async () => { executions++; return { content: 'unexpected' }; });
  const { runner, input, store, approvals } = fixture(provider, [command]);
  try {
    const receipt = runner.submit(input());
    await until(() => approvals.requests.length === 1, 'pending approval');
    runner.cancel(receipt.runId);
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'cancelled');
    assert.equal(executions, 0);
    assert.equal(provider.requests.length, 1);
    assert.equal([...store.approvalRows.values()][0]?.status, 'expired');
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { await runner.close(); }
});

test('run duration aborts the provider and finishes as a failure despite a late successful result', { timeout: 5_000 }, async () => {
  const release = deferred<void>();
  const provider = new FakeProvider(async function* () { await release.promise; yield { type: 'text.delta', delta: 'too late' }; yield finish; });
  const { runner, input, store } = fixture(provider);
  try {
    const receipt = runner.submit(input('build', { maxDurationMs: 20 }));
    await until(() => provider.signals[0]?.aborted === true, 'duration abort');
    release.resolve();
    const final = await runner.waitForRun(receipt.runId);
    assert.equal(final.state, 'failed');
    assert.ok(final.error);
    assert.ok(!JSON.stringify(store.events).includes('too late'));
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { release.resolve(); await runner.close(); }
});

test('tool timeout aborts execution without retrying a late tool effect', { timeout: 5_000 }, async () => {
  const release = deferred<void>();
  let executions = 0;
  let signal: AbortSignal | undefined;
  const slow = tool('slow_read', false, async (_prepared, context) => {
    executions++;
    signal = context.signal;
    await release.promise;
    return { content: 'late tool output' };
  });
  const provider = scripted([[call('slow-id', 'slow_read'), finishTools], [finish]]);
  const { runner, input, store } = fixture(provider, [slow]);
  try {
    const receipt = runner.submit(input('build', { toolTimeoutMs: 20 }));
    await until(() => signal?.aborted === true, 'tool timeout abort');
    release.resolve();
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'failed');
    assert.equal(executions, 1);
    assert.equal(provider.requests.length, 1);
    assert.ok(!JSON.stringify(store.events).includes('late tool output'));
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { release.resolve(); await runner.close(); }
});

test('close cancels an owned run and waits for cleanup before returning', { timeout: 5_000 }, async () => {
  const release = deferred<void>();
  const provider = new FakeProvider(async function* () { await release.promise; yield finish; });
  const { runner, input, store } = fixture(provider);
  try {
    const receipt = runner.submit(input());
    await until(() => provider.requests.length === 1, 'provider start');
    let closed = false;
    const closing = runner.close().then(() => { closed = true; });
    await until(() => provider.signals[0]?.aborted === true, 'close abort');
    assert.equal(closed, false);
    assert.equal(store.terminalCommits(receipt.runId).length, 0);
    release.resolve();
    await closing;
    assert.equal(store.getRun(receipt.runId).state, 'cancelled');
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'cancelled');
    assert.throws(() => runner.submit({ ...input(), requestId: 'after-close' }));
  } finally { release.resolve(); await runner.close(); }
});

test('a provider error preserves its committed partial response and emits one failed terminal', { timeout: 5_000 }, async () => {
  const provider = new FakeProvider(async function* () {
    yield { type: 'text.delta', delta: 'response before transport failure' };
    throw new Error('Fixture transport lost');
  });
  const { runner, input, store } = fixture(provider);
  try {
    const receipt = runner.submit(input());
    const final = await runner.waitForRun(receipt.runId);
    assert.equal(final.state, 'failed');
    assert.equal(final.error?.code, 'PROVIDER_ERROR');
    assert.ok(final.error.message.length > 0);
    assert.ok(store.getSnapshot(store.session.id).messages.some((message) => message.role === 'assistant' && message.content.includes('response before transport failure')));
    assert.equal(provider.requests.length, 1);
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { await runner.close(); }
});

test('context budget rejects oversized built context before calling the provider', { timeout: 5_000 }, async () => {
  const provider = scripted([[finish]]);
  const { runner, input, store, contextRequests } = fixture(provider, [], async () => [{ role: 'system', content: 'x'.repeat(256) }]);
  try {
    const receipt = runner.submit(input('build', { maxContextBytes: 16 }));
    const final = await runner.waitForRun(receipt.runId);
    assert.equal(final.state, 'failed');
    assert.ok(final.error);
    assert.equal(contextRequests.length, 1);
    assert.equal(provider.requests.length, 0);
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { await runner.close(); }
});

test('oversized tool output is bounded in storage and exhausts the output budget', { timeout: 5_000 }, async () => {
  const read = tool('large_read', false, async () => ({ content: '가'.repeat(100) }));
  const provider = scripted([[call('large-id', 'large_read'), finishTools], [finish]]);
  const { runner, input, store } = fixture(provider, [read]);
  try {
    const receipt = runner.submit(input('build', { maxOutputBytes: 64 }));
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'failed');
    for (const record of store.toolRows.values()) assert.ok(Buffer.byteLength(record.output ?? '', 'utf8') <= 64);
    for (const message of store.messages.values()) if (message.role === 'tool') assert.ok(Buffer.byteLength(message.content, 'utf8') <= 64);
    assert.equal(provider.requests.length, 1);
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { await runner.close(); }
});

test('unconfirmed cleanup fails cancellation and rejects checkpoints after the terminal state', { timeout: 5_000 }, async () => {
  const release = deferred<void>();
  let executionContext: ToolContext | undefined;
  let finishedExecute = false;
  const slow = tool('ignores_abort', false, async (_prepared, context) => {
    executionContext = context;
    await release.promise;
    finishedExecute = true;
    return { content: 'late output after cleanup deadline' };
  });
  const provider = scripted([[call('slow-id', 'ignores_abort'), finishTools], [finish]]);
  const { runner, input, store } = fixture(provider, [slow]);
  try {
    const receipt = runner.submit(input());
    await until(() => executionContext !== undefined, 'tool execution');
    runner.cancel(receipt.runId);
    assert.equal(executionContext!.signal.aborted, true);
    const final = await runner.waitForRun(receipt.runId);
    assert.equal(final.state, 'failed');
    assert.equal(final.error?.code, 'CLEANUP_UNCERTAIN');
    assert.equal(finishedExecute, false);
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
    const checkpoint: Checkpoint = {
      id: 'late-checkpoint', runId: receipt.runId, toolCallId: 'slow-id', kind: 'command', createdAt: now(), files: [], warnings: [],
    };
    assert.throws(() => executionContext!.recordCheckpoint(checkpoint));
    assert.equal(store.listCheckpoints(receipt.runId).length, 0);
    const eventCount = store.events.length;
    release.resolve();
    await until(() => finishedExecute, 'late execute settlement');
    await nextTick();
    assert.equal(store.events.length, eventCount);
    assert.ok(!JSON.stringify(store.events).includes('late output after cleanup deadline'));
    assert.equal(store.getRun(receipt.runId).state, 'failed');
    assert.equal(provider.requests.length, 1);
  } finally { release.resolve(); await runner.close(); }
});

test('a tool reporting cleanup uncertainty cannot become a successful cancellation', { timeout: 5_000 }, async (t) => {
  const outcomes: JsonObject[] = [{ cleanupConfirmed: false }, { cleanupUncertain: true }];
  for (const data of outcomes) {
    await t.test(JSON.stringify(data), async () => {
      const release = deferred<void>();
      let executionContext: ToolContext | undefined;
      const uncertain = tool('uncertain_cleanup', false, async (_prepared, context) => {
        executionContext = context;
        await release.promise;
        return { content: 'cleanup could not be verified', isError: true, data };
      });
      const provider = scripted([[call('uncertain-id', 'uncertain_cleanup'), finishTools], [finish]]);
      const { runner, input, store } = fixture(provider, [uncertain]);
      try {
        const receipt = runner.submit(input());
        await until(() => executionContext !== undefined, 'uncertain tool execution');
        runner.cancel(receipt.runId);
        release.resolve();
        const final = await runner.waitForRun(receipt.runId);
        assert.equal(final.state, 'failed');
        assert.equal(final.error?.code, 'CLEANUP_UNCERTAIN');
        assert.equal(provider.requests.length, 1);
        assert.equal(store.terminalCommits(receipt.runId).length, 1);
      } finally { release.resolve(); await runner.close(); }
    });
  }
});

test('repeated or mismatched complete tool-call IDs cannot execute duplicate effects', { timeout: 5_000 }, async (t) => {
  for (const secondName of ['first_tool', 'other_tool']) {
    await t.test(`same turn: ${secondName}`, async () => {
      const executed: string[] = [];
      const first = tool('first_tool', false, async () => { executed.push('first'); return { content: 'one result' }; });
      const other = tool('other_tool', false, async () => { executed.push('other'); return { content: 'another result' }; });
      const provider = scripted([[call('duplicate-id', 'first_tool'), call('duplicate-id', secondName), finishTools], [finish]]);
      const { runner, input, store } = fixture(provider, [first, other]);
      try {
        const receipt = runner.submit(input());
        assert.equal((await runner.waitForRun(receipt.runId)).state, 'failed');
        assert.ok(executed.length <= 1);
        assert.ok(!executed.includes('other'));
        assert.equal(provider.requests.length, 1);
        assert.equal(store.terminalCommits(receipt.runId).length, 1);
      } finally { await runner.close(); }
    });
  }
  await t.test('ID reused in a later turn', async () => {
    let executions = 0;
    const first = tool('first_tool', false, async () => { executions++; return { content: 'one result' }; });
    const provider = scripted([[call('duplicate-id', 'first_tool'), finishTools], [call('duplicate-id', 'first_tool'), finishTools], [finish]]);
    const { runner, input, store } = fixture(provider, [first]);
    try {
      const receipt = runner.submit(input());
      assert.equal((await runner.waitForRun(receipt.runId)).state, 'failed');
      assert.equal(executions, 1);
      assert.equal(provider.requests.length, 2);
      assert.equal(store.terminalCommits(receipt.runId).length, 1);
    } finally { await runner.close(); }
  });
});

test('mismatched and expired approval records never authorize an effect', { timeout: 5_000 }, async (t) => {
  for (const outcome of ['mismatched fingerprint', 'mismatched tool ID', 'expired'] as const) {
    await t.test(outcome, async () => {
      let executions = 0;
      const command = tool('approved_effect', true, async () => { executions++; return { content: 'must not execute' }; });
      const provider = scripted([[call('effect-id', 'approved_effect'), finishTools], [finish]]);
      const { runner, input, approvals, store } = fixture(provider, [command]);
      approvals.request = async (request) => {
        const record: ApprovalRecord = {
          ...request, id: 'fixture-approval', status: outcome === 'expired' ? 'expired' : 'allowed', createdAt: now(),
          fingerprint: outcome === 'mismatched fingerprint' ? 'different-fingerprint' : request.fingerprint,
          toolCallId: outcome === 'mismatched tool ID' ? 'different-tool-call' : request.toolCallId,
        };
        store.commit(request.runId, 'approval.fixture', { approvalId: record.id }, { approval: record });
        return copy(record);
      };
      try {
        const receipt = runner.submit(input());
        const final = await runner.waitForRun(receipt.runId);
        assert.ok(isTerminal(final.state));
        assert.equal(executions, 0);
        assert.ok(![...store.toolRows.values()].some((record) => record.state === 'completed'));
        assert.equal(store.terminalCommits(receipt.runId).length, 1);
      } finally { await runner.close(); }
    });
  }
});

test('an executing tool may record its observed checkpoint during abort cleanup before cancellation becomes terminal', { timeout: 5_000 }, async () => {
  const release = deferred<void>();
  let executionContext: ToolContext | undefined;
  const observed = tool('observed_command', false, async (_prepared, context) => {
    executionContext = context;
    await release.promise;
    assert.equal(context.signal.aborted, true);
    context.recordCheckpoint({
      id: 'cleanup-checkpoint', runId: context.runId, toolCallId: context.toolCallId, kind: 'command', createdAt: now(),
      files: [], warnings: ['Command was cancelled; observed files may be incomplete'], incomplete: true,
    });
    return { content: 'confirmed stopped', data: { cleanupConfirmed: true } };
  });
  const provider = scripted([[call('observed-id', 'observed_command'), finishTools], [finish]]);
  const { runner, input, store } = fixture(provider, [observed]);
  try {
    const receipt = runner.submit(input());
    await until(() => executionContext !== undefined, 'observed tool execution');
    runner.cancel(receipt.runId);
    assert.equal(store.terminalCommits(receipt.runId).length, 0);
    release.resolve();
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'cancelled');
    const checkpoint = store.listCheckpoints(receipt.runId)[0];
    assert.equal(checkpoint?.id, 'cleanup-checkpoint');
    assert.equal(checkpoint?.incomplete, true);
    const checkpointCommit = store.commits.find(({ change }) => change.checkpoint?.id === 'cleanup-checkpoint');
    assert.equal(checkpointCommit?.event.type, 'workspace.changed');
    assert.ok(checkpointCommit!.event.seq < store.terminalCommits(receipt.runId)[0]!.event.seq);
    assert.equal(provider.requests.length, 1);
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { release.resolve(); await runner.close(); }
});

test('cleanup uncertainty quarantines new workspace requests while preserving duplicate and conflict identity', { timeout: 5_000 }, async () => {
  let executions = 0;
  const unsafe = tool('unsafe_cleanup', false, async () => {
    executions++;
    return { content: 'cleanup unavailable', isError: true, data: { cleanupUncertain: true } };
  });
  const provider = scripted([[call('unsafe-id', 'unsafe_cleanup'), finishTools], [finish]]);
  const { runner, input, store } = fixture(provider, [unsafe]);
  try {
    const submitted = input();
    const receipt = runner.submit(submitted);
    const final = await runner.waitForRun(receipt.runId);
    assert.equal(final.state, 'failed');
    assert.equal(final.error?.code, 'CLEANUP_UNCERTAIN');
    const eventCount = store.events.length;
    assert.deepEqual(runner.submit(submitted), { ...receipt, duplicate: true });
    assert.throws(() => runner.submit({ ...submitted, prompt: 'changed input' }), (error: unknown) => error instanceof EngineError && error.code === 'REQUEST_ID_CONFLICT');
    assert.throws(() => runner.submit({ ...submitted, requestId: 'fresh-request' }), (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_PENDING');
    assert.equal(store.runs.size, 1);
    assert.equal(store.events.length, eventCount);
    assert.equal(executions, 1);
    assert.equal(provider.requests.length, 1);
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { await runner.close(); }
});

test('confirmed successful cleanup allows subsequent workspace runs with fresh durable tool IDs', { timeout: 5_000 }, async () => {
  let executions = 0;
  const safe = tool('safe_cleanup', false, async () => {
    executions++;
    return { content: 'cleanup confirmed', data: { cleanupConfirmed: true } };
  });
  const provider = scripted([[call('reused-provider-id', 'safe_cleanup'), finishTools], [finish]]);
  const { runner, input, store } = fixture(provider, [safe]);
  try {
    const first = runner.submit(input());
    assert.equal((await runner.waitForRun(first.runId)).state, 'completed');
    const second = runner.submit({ ...input(), requestId: 'request-2' });
    assert.equal(second.duplicate, false);
    assert.notEqual(second.runId, first.runId);
    assert.equal((await runner.waitForRun(second.runId)).state, 'completed');
    assert.equal(executions, 2);
    assert.equal(provider.requests.length, 4);
    assert.equal(store.toolRows.size, 2);
    assert.ok([...store.toolRows.values()].every((record) => record.state === 'completed'));
    assert.equal(store.terminalCommits(first.runId).length, 1);
    assert.equal(store.terminalCommits(second.runId).length, 1);
  } finally { await runner.close(); }
});

test('a fatal error during execution interrupts the tool record before the run becomes terminal', { timeout: 5_000 }, async () => {
  const unsafe = tool('fatal_execute', false, async () => { throw new EngineError('CLEANUP_UNCERTAIN', 'Execution cleanup failed'); });
  const provider = scripted([[call('fatal-id', 'fatal_execute'), finishTools], [finish]]);
  const { runner, input, store } = fixture(provider, [unsafe]);
  try {
    const receipt = runner.submit(input());
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'failed');
    const record = [...store.toolRows.values()][0]!;
    assert.equal(record.state, 'interrupted');
    const toolInterrupted = store.commits.find(({ change }) => change.tool?.id === record.id && change.tool.state === 'interrupted');
    assert.ok(toolInterrupted);
    assert.ok(toolInterrupted.event.seq < store.terminalCommits(receipt.runId)[0]!.event.seq);
    assert.ok(![...store.toolRows.values()].some((value) => value.state === 'running'));
    assert.equal(provider.requests.length, 1);
  } finally { await runner.close(); }
});

test('cancellation before the first execution microtask performs no provider or tool operation', { timeout: 5_000 }, async () => {
  const trace: string[] = [];
  const effect = tool('immediate_effect', false, async () => ({ content: 'unexpected effect' }), trace);
  const provider = scripted([[call('effect-id', 'immediate_effect'), finishTools], [finish]]);
  const { runner, input, store, approvals, contextRequests } = fixture(provider, [effect]);
  try {
    const receipt = runner.submit(input());
    assert.equal(runner.cancel(receipt.runId).state, 'cancelling');
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'cancelled');
    assert.equal(provider.requests.length, 0);
    assert.equal(contextRequests.length, 0);
    assert.equal(approvals.requests.length, 0);
    assert.equal(store.toolRows.size, 0);
    assert.deepEqual(trace, []);
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
    assert.ok(!store.events.some((event) => event.type === 'run.started'));
  } finally { await runner.close(); }
});

test('approved execution receives the original prepared handle used for private WeakMap bindings', { timeout: 5_000 }, async () => {
  const bindings = new WeakMap<PreparedTool, string>();
  let handle: PreparedTool | undefined;
  let executions = 0;
  const opaque = tool('opaque_handle', true, async (prepared) => {
    assert.equal(prepared, handle);
    assert.equal(bindings.get(prepared), 'private preimage');
    executions++;
    return { content: 'opaque effect complete' };
  });
  opaque.prepare = async (input) => {
    handle = { name: opaque.name, input: input as PreparedTool['input'], fingerprint: 'opaque-fingerprint', requiresApproval: true, preview: { target: 'fixture' } };
    bindings.set(handle, 'private preimage');
    return handle;
  };
  const provider = scripted([[call('opaque-id', opaque.name), finishTools], [finish]]);
  const { runner, input, store, approvals } = fixture(provider, [opaque]);
  try {
    const receipt = runner.submit(input());
    await until(() => approvals.requests.length === 1, 'opaque handle approval');
    const approval = [...store.approvalRows.values()][0]!;
    approvals.decide(approval.id, 'allow', approval.fingerprint);
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'completed');
    assert.equal(executions, 1);
    assert.equal([...store.toolRows.values()][0]?.state, 'completed');
  } finally { await runner.close(); }
});

test('prepared input mutated during approval cannot execute using the previously approved metadata', { timeout: 5_000 }, async () => {
  let handle: PreparedTool | undefined;
  let executions = 0;
  const mutable = tool('mutable_preparation', true, async () => { executions++; return { content: 'unexpected effect' }; });
  mutable.prepare = async () => {
    handle = { name: mutable.name, input: { target: 'original' }, fingerprint: 'unchanged-fingerprint', requiresApproval: true, preview: { target: 'original' } };
    return handle;
  };
  const provider = scripted([[call('mutable-id', mutable.name), finishTools], [finish]]);
  const { runner, input, store, approvals } = fixture(provider, [mutable]);
  try {
    const receipt = runner.submit(input());
    await until(() => approvals.requests.length === 1, 'mutable input approval');
    const approval = [...store.approvalRows.values()][0]!;
    handle!.input = { target: 'different target' };
    approvals.decide(approval.id, 'allow', approval.fingerprint);
    const final = await runner.waitForRun(receipt.runId);
    assert.ok(isTerminal(final.state));
    assert.equal(executions, 0);
    assert.ok(![...store.toolRows.values()].some((record) => record.state === 'completed'));
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { await runner.close(); }
});

test('context builder receives exact schema reservation so old history is trimmed before the first provider call', { timeout: 5_000 }, async () => {
  const read = tool('fixture_read', false, async () => ({ content: 'unused' }));
  const provider = scripted([[finish]]);
  const reservations: number[] = [];
  const { runner, input, store } = fixture(provider, [read], async (request) => {
    assert.equal(typeof request.reservedBytes, 'number');
    const reserve = request.reservedBytes!;
    reservations.push(reserve);
    const messages = request.snapshot.messages.map(({ role, content }) => ({ role, content }));
    const available = request.config.limits.maxContextBytes - reserve;
    while (messages.length > 1 && Buffer.byteLength(JSON.stringify(messages), 'utf8') > available) messages.shift();
    assert.ok(Buffer.byteLength(JSON.stringify(messages), 'utf8') <= available);
    return messages;
  });
  store.messages.set('old-user', { id: 'old-user', sessionId: store.session.id, runId: 'older-run', role: 'user', content: 'old oversized history '.repeat(200), createdAt: now() });
  store.messages.set('old-assistant', { id: 'old-assistant', sessionId: store.session.id, runId: 'older-run', role: 'assistant', content: 'old assistant history '.repeat(200), createdAt: now() });
  try {
    const submitted = input('build', { maxContextBytes: 256 });
    const receipt = runner.submit(submitted);
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'completed');
    assert.equal(provider.requests.length, 1);
    const request = provider.requests[0]!;
    const exactReservation = Buffer.byteLength(JSON.stringify({ messages: [], tools: request.tools }), 'utf8') - 2;
    assert.deepEqual(reservations, [exactReservation]);
    assert.deepEqual(request.messages, [{ role: 'user', content: submitted.prompt }]);
    assert.ok(Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools }), 'utf8') <= submitted.config.limits.maxContextBytes);
    assert.ok(store.messages.has('old-user'), 'Trimming context must not delete stored history');
    assert.ok(store.messages.has('old-assistant'));
  } finally { await runner.close(); }
});

test('a tool turn rebuilds context once from its committed assistant and tool transcript before the next provider call', { timeout: 5_000 }, async () => {
  const read = tool('rebuild_read', false, async () => ({ content: 'committed read result' }));
  const provider = scripted([[{ type: 'text.delta', delta: 'checking the file' }, call('rebuild-id', read.name), finishTools], [{ type: 'text.delta', delta: 'final answer' }, finish]]);
  const { runner, input, store, contextRequests } = fixture(provider, [read]);
  try {
    const receipt = runner.submit(input());
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'completed');
    assert.equal(contextRequests.length, 2);
    assert.equal(provider.requests.length, 2);
    const initial = contextRequests[0]!;
    const rebuilt = contextRequests[1]!;
    assert.equal(initial.snapshot.messages.length, 1);
    assert.ok(rebuilt.snapshot.lastSeq > initial.snapshot.lastSeq);
    assert.equal(rebuilt.snapshot.tools[0]?.state, 'completed');
    assert.equal(rebuilt.reservedBytes, initial.reservedBytes);
    const nextMessages = provider.requests[1]!.messages;
    assert.deepEqual(nextMessages.map((message) => message.role), ['user', 'assistant', 'tool']);
    assert.equal(nextMessages[1]!.content, 'checking the file');
    assert.deepEqual(nextMessages[1]!.toolCalls, [{ id: 'rebuild-id', name: read.name, input: {} }]);
    assert.equal(nextMessages[2]!.toolCallId, 'rebuild-id');
    assert.equal(nextMessages[2]!.content, 'committed read result');
    assert.deepEqual(nextMessages, rebuilt.snapshot.messages.map(({ role, content, toolCalls, toolCallId }) => ({ role, content, toolCalls, toolCallId })));
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { await runner.close(); }
});

test('a tool-reported timeout stores the failed result and ends the run before another provider turn', { timeout: 5_000 }, async () => {
  let executions = 0;
  const timed = tool('early_timeout', false, async () => {
    executions++;
    return { content: 'partial output before timeout', data: { timedOut: true, cleanupConfirmed: true, cleanupUncertain: false } };
  });
  const provider = scripted([[call('timed-id', timed.name), finishTools], [finish]]);
  const { runner, input, store, contextRequests } = fixture(provider, [timed]);
  try {
    const receipt = runner.submit(input());
    const final = await runner.waitForRun(receipt.runId);
    assert.equal(final.state, 'failed');
    assert.equal(final.error?.code, 'TOOL_TIMEOUT');
    assert.equal(executions, 1);
    assert.equal(provider.requests.length, 1);
    assert.equal(contextRequests.length, 1);
    const record = [...store.toolRows.values()][0]!;
    assert.equal(record.state, 'failed');
    assert.equal(record.output, 'partial output before timeout');
    const resultMessage = [...store.messages.values()].find((message) => message.role === 'tool');
    assert.equal(resultMessage?.toolCallId, 'timed-id');
    assert.equal(resultMessage?.content, record.output);
    const resultCommit = store.commits.find(({ event }) => event.type === 'tool.failed');
    assert.equal(resultCommit?.event.payload.timedOut, true);
    assert.equal(resultCommit?.event.payload.cleanupConfirmed, true);
    assert.equal(resultCommit?.event.payload.cleanupUncertain, false);
    assert.ok(resultCommit!.event.seq < store.terminalCommits(receipt.runId)[0]!.event.seq);
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { await runner.close(); }
});

test('normal finish stores provider-bound replay separately from deltas and snapshots the original nested objects before provider mutation', { timeout: 5_000 }, async () => {
  const items: JsonObject[] = [
    { type: 'reasoning', opaque: 'fixture encrypted replay', nested: { flags: [true, false, null], id: 'original-id' } },
    { type: 'message', parts: [{ text: 'original replay body' }], count: 2 },
  ];
  const expected = copy(items);
  let executions = 0;
  const read = tool('replay_read', false, async () => { executions++; return { content: 'replay read result' }; });
  const provider = new FakeProvider(async function* (request) {
    if (request.turnIndex === 0) {
      yield { type: 'text.delta', delta: 'visible answer' };
      yield call('replay-call-id', read.name);
      yield { type: 'finish', reason: 'tool_calls', replayItems: items };
      (items[0]!.nested as JsonObject).id = 'provider-mutated-id';
      items[1]!.parts = [{ text: 'provider-mutated-body' }];
      items.push({ type: 'unexpected added item' });
    } else {
      yield { type: 'text.delta', delta: 'complete' };
      yield finish;
    }
  });
  const { runner, input, store, contextRequests } = fixture(provider, [read]);
  try {
    const receipt = runner.submit(input());
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'completed');
    assert.equal(executions, 1);
    const assistant = [...store.messages.values()].find((message) => message.role === 'assistant' && message.toolCalls?.length);
    assert.deepEqual(assistant?.providerReplay, { providerId: provider.id, items: expected });
    assert.deepEqual(provider.requests[1]!.messages.find((message) => message.role === 'assistant')?.providerReplay, { providerId: provider.id, items: expected });
    assert.deepEqual(contextRequests[1]!.snapshot.messages.find((message) => message.role === 'assistant')?.providerReplay, { providerId: provider.id, items: expected });
    const deltaCommits = store.commits.filter(({ event }) => event.type === 'message.delta');
    assert.ok(deltaCommits.length > 0);
    for (const { event, change } of deltaCommits) {
      assert.equal(event.payload.providerReplay, undefined);
      assert.equal(event.payload.replayItems, undefined);
      assert.equal(change.message?.providerReplay, undefined);
    }
    assert.ok(!JSON.stringify(store.getSnapshot(store.session.id)).includes('provider-mutated'));
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { await runner.close(); }
});

test('unsafe replay metadata fails with fixed errors before persistence or tool effects', { timeout: 5_000 }, async (t) => {
  let getterReads = 0;
  let proxyReads = 0;
  const accessor = Object.defineProperty({}, 'privateValue', { enumerable: true, get() { getterReads++; return 'unsafe-replay-secret'; } });
  const cycle: Record<string, unknown> = { type: 'reasoning' };
  cycle.self = cycle;
  const proxy = new Proxy({}, {
    get() { proxyReads++; throw new Error('unsafe-replay-secret'); },
    ownKeys() { proxyReads++; throw new Error('unsafe-replay-secret'); },
    getPrototypeOf() { proxyReads++; throw new Error('unsafe-replay-secret'); },
  });
  let deep: Record<string, unknown> = { value: 'unsafe-replay-secret' };
  for (let index = 0; index < 66; index++) deep = { nested: deep };
  const symbolKey = { type: 'reasoning', [Symbol('unsafe-replay-secret')]: 'hidden' };
  const hiddenFunction = Object.defineProperty({ type: 'reasoning' }, 'hiddenMethod', { value: () => 'unsafe-replay-secret' });
  class ReplayClass { readonly type = 'reasoning'; }
  const cases: { name: string; items: unknown }[] = [
    { name: 'function', items: [{ privateValue: () => 'unsafe-replay-secret' }] },
    { name: 'accessor', items: [accessor] },
    { name: 'cyclic object', items: [cycle] },
    { name: 'undefined value', items: [{ privateValue: undefined }] },
    { name: 'NaN', items: [{ privateValue: Number.NaN }] },
    { name: 'Infinity', items: [{ privateValue: Number.POSITIVE_INFINITY }] },
    { name: 'negative Infinity', items: [{ privateValue: Number.NEGATIVE_INFINITY }] },
    { name: 'bigint', items: [{ privateValue: 1n }] },
    { name: 'proxy', items: [proxy] },
    { name: 'symbol value', items: [{ privateValue: Symbol('unsafe-replay-secret') }] },
    { name: 'symbol key', items: [symbolKey] },
    { name: 'nonenumerable function', items: [hiddenFunction] },
    { name: 'class instance', items: [new ReplayClass()] },
    { name: 'Date value', items: [{ privateValue: new Date() }] },
    { name: 'deep nesting', items: [deep] },
    { name: 'array item', items: [['unsafe-replay-secret']] },
    { name: 'null item', items: [null] },
    { name: 'wrong items shape', items: { privateValue: 'unsafe-replay-secret' } },
    { name: 'null items', items: null },
  ];
  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async () => {
      let executions = 0;
      const effect = tool('unsafe_replay_effect', false, async () => { executions++; return { content: 'unexpected effect' }; });
      const provider = new FakeProvider(async function* () {
        yield { type: 'text.delta', delta: 'committed visible prefix' };
        yield call('unsafe-replay-call', effect.name);
        yield { type: 'finish', reason: 'tool_calls', replayItems: fixtureCase.items } as ProviderEvent;
      });
      const { runner, input, store } = fixture(provider, [effect]);
      try {
        const receipt = runner.submit(input());
        const final = await runner.waitForRun(receipt.runId);
        assert.equal(final.state, 'failed');
        assert.equal(final.error?.code, 'INVALID_PROVIDER_REPLAY');
        assert.ok(!final.error.message.includes('unsafe-replay-secret'));
        assert.equal(executions, 0);
        assert.equal(store.toolRows.size, 0);
        assert.equal(provider.requests.length, 1);
        assert.ok(!store.events.some((event) => event.type === 'message.completed'));
        assert.ok([...store.messages.values()].every((message) => message.providerReplay === undefined));
        assert.ok([...store.messages.values()].some((message) => message.content === 'committed visible prefix'));
        assert.ok(!JSON.stringify(store.events).includes('unsafe-replay-secret'));
        assert.equal(store.terminalCommits(receipt.runId).length, 1);
      } finally { await runner.close(); }
    });
  }
  assert.equal(getterReads, 0, 'Replay accessors must never be invoked');
  assert.equal(proxyReads, 0, 'Replay proxies must be rejected without invoking their traps');
});

test('replay exceeding the context budget fails before metadata persistence and tool effects', { timeout: 5_000 }, async () => {
  let executions = 0;
  const effect = tool('large_replay_effect', false, async () => { executions++; return { content: 'unexpected effect' }; });
  const provider = new FakeProvider(async function* () {
    yield call('large-replay-call', effect.name);
    yield { type: 'finish', reason: 'tool_calls', replayItems: [{ type: 'reasoning', opaque: 'x'.repeat(4_096) }] };
  });
  const { runner, input, store } = fixture(provider, [effect]);
  try {
    const receipt = runner.submit(input('build', { maxContextBytes: 512 }));
    const final = await runner.waitForRun(receipt.runId);
    assert.equal(final.state, 'failed');
    assert.equal(final.error?.code, 'CONTEXT_LIMIT');
    assert.equal(executions, 0);
    assert.equal(store.toolRows.size, 0);
    assert.equal(provider.requests.length, 1);
    assert.ok(!store.events.some((event) => event.type === 'message.completed'));
    assert.ok([...store.messages.values()].every((message) => message.providerReplay === undefined));
  } finally { await runner.close(); }
});

test('an unsuccessful or unfinished provider turn cannot persist replay metadata or execute complete tool calls', { timeout: 5_000 }, async (t) => {
  const cases = [
    { name: 'length', code: 'PROVIDER_LENGTH' },
    { name: 'error after finish', code: 'PROVIDER_ERROR' },
    { name: 'missing finish', code: 'PROVIDER_PROTOCOL_ERROR' },
    { name: 'mismatched finish reason', code: 'PROVIDER_PROTOCOL_ERROR' },
    { name: 'content after finish', code: 'PROVIDER_PROTOCOL_ERROR' },
  ] as const;
  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async () => {
      let executions = 0;
      const effect = tool('unfinished_replay_effect', false, async () => { executions++; return { content: 'unexpected effect' }; });
      const items: JsonObject[] = [{ type: 'reasoning', opaque: 'unfinished replay value' }];
      const provider = new FakeProvider(async function* () {
        yield { type: 'text.delta', delta: 'partial answer', replayItems: items } as ProviderEvent;
        yield call('unfinished-call', effect.name);
        if (fixtureCase.name === 'missing finish') return;
        yield { type: 'finish', reason: fixtureCase.name === 'length' ? 'length' : fixtureCase.name === 'mismatched finish reason' ? 'stop' : 'tool_calls', replayItems: items };
        if (fixtureCase.name === 'error after finish') throw new Error('Fixture transport failed after finish');
        if (fixtureCase.name === 'content after finish') yield { type: 'text.delta', delta: 'late invalid content' };
      });
      const { runner, input, store } = fixture(provider, [effect]);
      try {
        const receipt = runner.submit(input());
        const final = await runner.waitForRun(receipt.runId);
        assert.equal(final.state, 'failed');
        assert.equal(final.error?.code, fixtureCase.code);
        assert.equal(executions, 0);
        assert.equal(store.toolRows.size, 0);
        assert.equal(provider.requests.length, 1);
        assert.ok(!store.events.some((event) => event.type === 'message.completed'));
        assert.ok([...store.messages.values()].every((message) => message.providerReplay === undefined));
        assert.ok(!JSON.stringify(store.events).includes('unfinished replay value'));
        assert.equal(store.terminalCommits(receipt.runId).length, 1);
      } finally { await runner.close(); }
    });
  }
});

test('runtime incomplete finish reason rejects replay and complete tool calls before their effects', { timeout: 5_000 }, async () => {
  let executions = 0;
  const effect = tool('incomplete_finish_effect', false, async () => { executions++; return { content: 'unexpected effect' }; });
  const provider = new FakeProvider(async function* () {
    yield { type: 'text.delta', delta: 'visible incomplete response' };
    yield call('incomplete-finish-call', effect.name);
    yield { type: 'finish', reason: 'incomplete', replayItems: [{ type: 'reasoning', opaque: 'incomplete opaque replay' }] } as unknown as ProviderEvent;
  });
  const { runner, input, store } = fixture(provider, [effect]);
  try {
    const receipt = runner.submit(input());
    const final = await runner.waitForRun(receipt.runId);
    assert.equal(final.state, 'failed');
    assert.equal(final.error?.code, 'PROVIDER_PROTOCOL_ERROR');
    assert.equal(executions, 0);
    assert.equal(store.toolRows.size, 0);
    assert.equal(provider.requests.length, 1);
    assert.ok(!store.events.some((event) => event.type === 'message.completed'));
    assert.ok([...store.messages.values()].every((message) => message.providerReplay === undefined));
    assert.ok(!JSON.stringify(store.getSnapshot(store.session.id)).includes('incomplete opaque replay'));
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { await runner.close(); }
});

test('cancellation after a valid finish but before iterator completion retains only partial visible text', { timeout: 5_000 }, async () => {
  const release = deferred<void>();
  let waitingAfterFinish = false;
  let executions = 0;
  const effect = tool('cancel_after_finish_effect', false, async () => { executions++; return { content: 'unexpected effect' }; });
  const provider = new FakeProvider(async function* () {
    yield { type: 'text.delta', delta: 'visible text before finish cancellation' };
    yield call('cancel-after-finish-call', effect.name);
    yield { type: 'finish', reason: 'tool_calls', replayItems: [{ type: 'reasoning', opaque: 'cancelled opaque replay' }] };
    waitingAfterFinish = true;
    await release.promise;
  });
  const { runner, input, store } = fixture(provider, [effect]);
  try {
    const receipt = runner.submit(input());
    await until(() => waitingAfterFinish, 'provider waiting after finish');
    assert.ok(!store.events.some((event) => event.type === 'message.completed'));
    assert.equal(store.terminalCommits(receipt.runId).length, 0);
    runner.cancel(receipt.runId);
    release.resolve();
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'cancelled');
    assert.equal(provider.signals[0]?.aborted, true);
    assert.equal(executions, 0);
    assert.equal(store.toolRows.size, 0);
    assert.equal(provider.requests.length, 1);
    const assistant = [...store.messages.values()].filter((message) => message.role === 'assistant');
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0]?.content, 'visible text before finish cancellation');
    assert.equal(assistant[0]?.providerReplay, undefined);
    assert.equal(assistant[0]?.toolCalls, undefined);
    assert.ok(!store.events.some((event) => event.type === 'message.completed'));
    assert.ok(!JSON.stringify(store.events).includes('cancelled opaque replay'));
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { release.resolve(); await runner.close(); }
});

test('finish replayItems accessor is rejected without invoking the getter or committing metadata', { timeout: 5_000 }, async () => {
  let getterReads = 0;
  let executions = 0;
  const effect = tool('finish_accessor_effect', false, async () => { executions++; return { content: 'unexpected effect' }; });
  const provider = new FakeProvider(async function* () {
    yield { type: 'text.delta', delta: 'visible text before unsafe finish' };
    yield call('finish-accessor-call', effect.name);
    const event = Object.defineProperty({ type: 'finish', reason: 'tool_calls' }, 'replayItems', {
      enumerable: true,
      get() { getterReads++; return [{ type: 'reasoning', opaque: 'finish getter opaque replay' }]; },
    });
    yield event as ProviderEvent;
  });
  const { runner, input, store } = fixture(provider, [effect]);
  try {
    const receipt = runner.submit(input());
    const final = await runner.waitForRun(receipt.runId);
    assert.equal(final.state, 'failed');
    assert.equal(final.error?.code, 'INVALID_PROVIDER_REPLAY');
    assert.equal(getterReads, 0);
    assert.equal(executions, 0);
    assert.equal(store.toolRows.size, 0);
    assert.ok(!store.events.some((event) => event.type === 'message.completed'));
    assert.ok([...store.messages.values()].every((message) => message.providerReplay === undefined));
    assert.ok(!JSON.stringify(store.events).includes('finish getter opaque replay'));
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { await runner.close(); }
});

test('maintenance lease registers before its callback and preserves duplicate and conflict precedence while blocking new runs', { timeout: 5_000 }, async () => {
  const release = deferred<void>();
  const provider = scripted([[finish]]);
  const { runner, input, store } = fixture(provider);
  let entered = false;
  try {
    const receipt = runner.submit(input());
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'completed');
    const lease = runner.withWorkspaceLease(store.workspace.id, async (signal) => {
      entered = true;
      assert.equal(signal.aborted, false);
      await release.promise;
      return 42;
    });
    assert.equal(entered, false);
    assert.throws(() => runner.submit({ ...input(), requestId: 'blocked-new-request' }), (error: unknown) => error instanceof EngineError && error.code === 'WORKSPACE_BUSY');
    assert.deepEqual(runner.submit(input()), { ...receipt, duplicate: true });
    assert.throws(() => runner.submit({ ...input(), prompt: 'changed request' }), (error: unknown) => error instanceof EngineError && error.code === 'REQUEST_ID_CONFLICT');
    await assert.rejects(async () => runner.withWorkspaceLease(store.workspace.id, async () => 'unexpected second lease'), (error: unknown) => error instanceof EngineError && error.code === 'WORKSPACE_BUSY');
    await until(() => entered, 'maintenance callback');
    release.resolve();
    assert.equal(await lease, 42);
    const next = runner.submit({ ...input(), requestId: 'after-lease' });
    assert.equal((await runner.waitForRun(next.runId)).state, 'completed');
    assert.equal(provider.requests.length, 2);
  } finally { release.resolve(); await runner.close(); }
});

test('maintenance lease checks workspace existence and active persisted runs before starting its operation', { timeout: 5_000 }, async () => {
  let callbacks = 0;
  const provider = scripted([[finish]]);
  const { runner, input, store } = fixture(provider);
  try {
    await assert.rejects(async () => runner.withWorkspaceLease('unknown-workspace', async () => { callbacks++; }), (error: unknown) => error instanceof EngineError && error.code === 'WORKSPACE_NOT_FOUND');
    const persisted = store.admit(input());
    await assert.rejects(async () => runner.withWorkspaceLease(store.workspace.id, async () => { callbacks++; }), (error: unknown) => error instanceof EngineError && error.code === 'WORKSPACE_BUSY');
    assert.equal(callbacks, 0);
    assert.equal(provider.requests.length, 0);
    store.commit(persisted.runId, 'run.cancelled', {}, { run: { state: 'cancelled' } });
    assert.equal(await runner.withWorkspaceLease(store.workspace.id, async () => { callbacks++; return 'released persisted run'; }), 'released persisted run');
    assert.equal(callbacks, 1);
  } finally { await runner.close(); }
});

test('close before the lease microtask skips its operation and blocks subsequent admission with one close promise', { timeout: 5_000 }, async () => {
  let callbacks = 0;
  const provider = scripted([[finish]]);
  const { runner, input, store } = fixture(provider);
  const lease = runner.withWorkspaceLease(store.workspace.id, async () => { callbacks++; return 'unexpected'; });
  const observed = lease.then(() => undefined, (error: unknown) => error);
  const closing = runner.close();
  assert.strictEqual(runner.close(), closing);
  assert.throws(() => runner.submit(input()), (error: unknown) => error instanceof EngineError && error.code === 'ENGINE_CLOSED');
  await assert.rejects(async () => runner.withWorkspaceLease(store.workspace.id, async () => 'unexpected new lease'), (error: unknown) => error instanceof EngineError && error.code === 'ENGINE_CLOSED');
  await closing;
  const error = await observed;
  assert.ok(error instanceof EngineError);
  assert.equal(error.code, 'ENGINE_CLOSED');
  assert.equal(callbacks, 0);
  assert.equal(provider.requests.length, 0);
  assert.equal(store.runs.size, 0);
  assert.strictEqual(runner.close(), closing);
});

test('close aborts a started lease synchronously but awaits cleanup beyond the run grace and preserves its safe return value', { timeout: 5_000 }, async () => {
  const release = deferred<void>();
  const result = { cancelled: true, cleanupConfirmed: true, observedChanges: ['fixture observation'] };
  const provider = scripted([[finish]]);
  const { runner, input, store } = fixture(provider);
  let signal: AbortSignal | undefined;
  let reentrantClose: Promise<void> | undefined;
  let leaseSettled = false;
  let closeSettled = false;
  const lease = runner.withWorkspaceLease(store.workspace.id, async (leaseSignal) => {
    signal = leaseSignal;
    leaseSignal.addEventListener('abort', () => { reentrantClose = runner.close(); }, { once: true });
    await release.promise;
    assert.equal(leaseSignal.aborted, true);
    return result;
  });
  void lease.then(() => { leaseSettled = true; }, () => { leaseSettled = true; });
  try {
    await until(() => signal !== undefined, 'started maintenance lease');
    assert.throws(() => runner.submit(input()), (error: unknown) => error instanceof EngineError && error.code === 'WORKSPACE_BUSY');
    const closing = runner.close();
    void closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
    assert.equal(signal!.aborted, true);
    assert.ok(signal!.reason instanceof EngineError);
    assert.equal(signal!.reason.code, 'ENGINE_CLOSED');
    assert.strictEqual(reentrantClose, closing);
    assert.strictEqual(runner.close(), closing);
    assert.throws(() => runner.submit(input()), (error: unknown) => error instanceof EngineError && error.code === 'ENGINE_CLOSED');
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    assert.equal(leaseSettled, false);
    assert.equal(closeSettled, false);
    release.resolve();
    assert.strictEqual(await lease, result);
    await closing;
    assert.equal(leaseSettled, true);
    assert.equal(closeSettled, true);
    assert.equal(provider.requests.length, 0);
  } finally { release.resolve(); await runner.close(); }
});

test('a safe thrown maintenance error releases its lease without quarantining the workspace', { timeout: 5_000 }, async () => {
  const expected = new Error('Fixture safe failure');
  const provider = scripted([[finish]]);
  const { runner, input, store } = fixture(provider);
  try {
    await assert.rejects(async () => runner.withWorkspaceLease(store.workspace.id, async () => { throw expected; }), (error: unknown) => error === expected);
    assert.equal(await runner.withWorkspaceLease(store.workspace.id, async () => 'reacquired'), 'reacquired');
    const receipt = runner.submit(input());
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'completed');
    assert.equal(provider.requests.length, 1);
  } finally { await runner.close(); }
});

test('returned and thrown maintenance uncertainty quarantine new effects while retaining durable request identity', { timeout: 5_000 }, async (t) => {
  const fixtures: { name: string; value: unknown }[] = [
    { name: 'cleanupConfirmed=false', value: { cleanupConfirmed: false } },
    { name: 'cleanupUncertain=true', value: { cleanupUncertain: true } },
    { name: 'effectsUncertain=true', value: { effectsUncertain: true } },
    { name: 'executionBlocked=true', value: { executionBlocked: true } },
    ...['CLEANUP_UNCERTAIN', 'PROCESS_CLEANUP_FAILED', 'COMMAND_CLEANUP_UNCERTAIN', 'COMMAND_EFFECTS_LOCK_FAILED', 'PATCH_CHECKPOINT_FAILED'].map((code) => ({ name: code, value: new EngineError(code, 'Fixture unsafe maintenance outcome') })),
  ];
  for (const fixtureCase of fixtures) {
    for (const thrown of [false, true]) {
      await t.test(`${thrown ? 'throw' : 'return'} ${fixtureCase.name}`, async () => {
        const provider = scripted([[finish]]);
        const { runner, input, store } = fixture(provider);
        try {
          const receipt = runner.submit(input());
          assert.equal((await runner.waitForRun(receipt.runId)).state, 'completed');
          await assert.rejects(async () => runner.withWorkspaceLease(store.workspace.id, async () => {
            if (thrown) throw fixtureCase.value;
            return fixtureCase.value;
          }), (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_UNCERTAIN');
          await assert.rejects(async () => runner.withWorkspaceLease(store.workspace.id, async () => 'unexpected lease'), (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_PENDING');
          assert.throws(() => runner.submit({ ...input(), requestId: 'new-after-uncertainty' }), (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_PENDING');
          assert.deepEqual(runner.submit(input()), { ...receipt, duplicate: true });
          assert.throws(() => runner.submit({ ...input(), prompt: 'changed duplicate' }), (error: unknown) => error instanceof EngineError && error.code === 'REQUEST_ID_CONFLICT');
          assert.equal(store.runs.size, 1);
          assert.equal(provider.requests.length, 1);
        } finally {
          await runner.close().catch((error: unknown) => { assert.ok(error instanceof EngineError && error.code === 'CLEANUP_UNCERTAIN'); });
        }
      });
    }
  }
});

test('close and the lease caller both reject when a running maintenance callback settles with uncertain cleanup', { timeout: 5_000 }, async (t) => {
  for (const thrown of [false, true]) {
    await t.test(thrown ? 'unsafe thrown error' : 'unsafe returned result', async () => {
      const release = deferred<void>();
      const provider = scripted([[finish]]);
      const { runner, store } = fixture(provider);
      let signal: AbortSignal | undefined;
      const lease = runner.withWorkspaceLease(store.workspace.id, async (leaseSignal) => {
        signal = leaseSignal;
        await release.promise;
        if (thrown) throw new EngineError('PROCESS_CLEANUP_FAILED', 'Fixture cleanup failed');
        return { effectsUncertain: true };
      });
      const leaseRejected = assert.rejects(lease, (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_UNCERTAIN');
      await until(() => signal !== undefined, 'uncertain maintenance callback');
      const closing = runner.close();
      const closeRejected = assert.rejects(closing, (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_UNCERTAIN');
      assert.equal(signal!.aborted, true);
      release.resolve();
      await Promise.all([leaseRejected, closeRejected]);
      assert.strictEqual(runner.close(), closing);
    });
  }
});

test('safe cancellation thrown by a started lease remains its caller error while close resolves after settlement', { timeout: 5_000 }, async () => {
  const release = deferred<void>();
  const expected = new EngineError('CANCELLED', 'Fixture maintenance cancelled safely');
  const provider = scripted([[finish]]);
  const { runner, store } = fixture(provider);
  let signal: AbortSignal | undefined;
  const lease = runner.withWorkspaceLease(store.workspace.id, async (leaseSignal) => {
    signal = leaseSignal;
    await release.promise;
    throw expected;
  });
  const callerRejected = assert.rejects(lease, (error: unknown) => error === expected);
  await until(() => signal !== undefined, 'safely cancelled maintenance callback');
  const closing = runner.close();
  assert.equal(signal!.aborted, true);
  release.resolve();
  await callerRejected;
  await closing;
  assert.strictEqual(runner.close(), closing);
  assert.equal(provider.requests.length, 0);
});

test('generic maintenance results preserve safe cyclic identity and still detect unsafe flags nested through a cycle', { timeout: 5_000 }, async (t) => {
  await t.test('safe cyclic result', async () => {
    const result: { observed: string; data?: unknown; details?: unknown } = { observed: 'fixture observation' };
    result.data = result;
    result.details = { data: result };
    const provider = scripted([[finish]]);
    const { runner, input, store } = fixture(provider);
    try {
      assert.strictEqual(await runner.withWorkspaceLease(store.workspace.id, async () => result), result);
      const receipt = runner.submit(input());
      assert.equal((await runner.waitForRun(receipt.runId)).state, 'completed');
    } finally { await runner.close(); }
  });
  await t.test('nested unsafe cyclic result', async () => {
    const result: { data?: unknown; details?: unknown } = {};
    result.data = result;
    result.details = { data: result, executionBlocked: true };
    const provider = scripted([[finish]]);
    const { runner, input, store } = fixture(provider);
    try {
      await assert.rejects(async () => runner.withWorkspaceLease(store.workspace.id, async () => result), (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_UNCERTAIN');
      assert.throws(() => runner.submit(input()), (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_PENDING');
      assert.equal(provider.requests.length, 0);
    } finally {
      await runner.close().catch((error: unknown) => { assert.ok(error instanceof EngineError && error.code === 'CLEANUP_UNCERTAIN'); });
    }
  });
});

test('explicit workspace quarantine validates identity, is idempotent, and preserves completed request history without new effects', { timeout: 5_000 }, async () => {
  const provider = scripted([[{ type: 'text.delta', delta: 'stored completed reply' }, finish]]);
  const { runner, input, store } = fixture(provider);
  let maintenanceCallbacks = 0;
  try {
    assert.throws(() => runner.quarantineWorkspace('unknown-workspace'), (error: unknown) => error instanceof EngineError && error.code === 'WORKSPACE_NOT_FOUND');
    assert.equal(await runner.withWorkspaceLease(store.workspace.id, async () => 'valid workspace unaffected'), 'valid workspace unaffected');
    const receipt = runner.submit(input());
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'completed');
    const snapshot = store.getSnapshot(store.session.id);
    const history = store.readEvents(store.session.id, 0);
    assert.equal(runner.quarantineWorkspace(store.workspace.id), undefined);
    assert.equal(runner.quarantineWorkspace(store.workspace.id), undefined);
    assert.deepEqual(runner.submit(input()), { ...receipt, duplicate: true });
    const copiedReceipt = runner.submit(input());
    copiedReceipt.runId = 'caller-mutated-receipt';
    assert.deepEqual(runner.submit(input()), { ...receipt, duplicate: true });
    assert.throws(() => runner.submit({ ...input(), prompt: 'changed completed request' }), (error: unknown) => error instanceof EngineError && error.code === 'REQUEST_ID_CONFLICT');
    assert.throws(() => runner.submit({ ...input(), requestId: 'new-after-explicit-quarantine' }), (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_PENDING');
    await assert.rejects(async () => runner.withWorkspaceLease(store.workspace.id, async () => { maintenanceCallbacks++; }), (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_PENDING');
    assert.equal(maintenanceCallbacks, 0);
    assert.equal(provider.requests.length, 1);
    assert.equal(store.runs.size, 1);
    assert.deepEqual(store.getSnapshot(store.session.id), snapshot);
    assert.deepEqual(store.readEvents(store.session.id, 0), history);
    assert.ok(snapshot.messages.some((message) => message.role === 'user' && message.content === input().prompt));
    assert.ok(snapshot.messages.some((message) => message.role === 'assistant' && message.content === 'stored completed reply'));
    assert.equal((await runner.waitForRun(receipt.runId)).state, 'completed');
    assert.equal(store.terminalCommits(receipt.runId).length, 1);
  } finally { await runner.close(); }
});
