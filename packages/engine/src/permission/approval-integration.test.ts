import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import {
  DEFAULT_LIMITS, EngineError, type ApprovalRecord, type EngineEvent, type JsonObject,
  type Run, type Session, type ToolCallRecord, type Workspace,
} from '@moodcode/contracts';
import type { ApprovalRequest } from '../ports.js';
import { SqliteStore } from '../storage/index.js';
import { ApprovalManager } from './index.js';

const options = { timeout: 10_000 };
const hasCode = (code: string) => (error: unknown): boolean => error instanceof EngineError && error.code === code;

interface ProcessExit { code: number | null; signal: NodeJS.Signals | null }
interface Environment {
  directory: string;
  dbPath: string;
  children: { child: ChildProcess; exited: Promise<ProcessExit> }[];
  open(): SqliteStore;
}

function environment(t: TestContext): Environment {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-approval-sqlite-'));
  const dbPath = join(directory, 'engine.sqlite');
  const stores: SqliteStore[] = [];
  const children: Environment['children'] = [];
  t.after(async () => {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.allSettled(children.map(({ exited }) => exited));
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory, dbPath, children,
    open() { const store = new SqliteStore(dbPath); stores.push(store); return store; },
  };
}

interface Scope { workspace: Workspace; session: Session; run: Run }

function admit(store: SqliteStore, env: Environment, label = 'first'): Scope {
  const root = join(env.directory, label);
  mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  const workspace = store.putWorkspace({ id: randomUUID(), root, gitRoot: root, branch: null, createdAt: now });
  const session = store.createSession({ id: randomUUID(), workspaceId: workspace.id, title: label, createdAt: now });
  const receipt = store.admit({
    sessionId: session.id, requestId: randomUUID(), prompt: 'Approval lifecycle integration',
    config: { providerId: 'scripted', modelId: 'local', mode: 'build', limits: { ...DEFAULT_LIMITS } },
  });
  assert.equal(store.getRun(receipt.runId).state, 'created');
  store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
  return { workspace, session, run: store.getRun(receipt.runId) };
}

function toolRequest(store: SqliteStore, scope: Scope, preview: JsonObject = { command: 'fixture; no process is launched' }): ApprovalRequest {
  const tool: ToolCallRecord = {
    id: randomUUID(), runId: scope.run.id, sessionId: scope.session.id, name: 'run_command',
    input: structuredClone(preview), state: 'requested',
  };
  store.commit(scope.run.id, 'tool.requested', { toolCallId: tool.id }, { tool });
  store.commit(scope.run.id, 'tool.awaiting_approval', { toolCallId: tool.id }, { tool: { ...tool, state: 'awaiting_approval' } });
  if (store.getRun(scope.run.id).state === 'running') {
    store.commit(scope.run.id, 'run.awaiting_approval', { toolCallId: tool.id }, { run: { state: 'awaiting_approval' } });
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({
    workspaceRoot: scope.workspace.root, runId: scope.run.id, toolCallId: tool.id, input: tool.input,
  })).digest('hex');
  return {
    sessionId: scope.session.id, runId: scope.run.id, toolCallId: tool.id,
    toolName: tool.name, fingerprint, preview: structuredClone(preview),
  };
}

function approval(store: SqliteStore, request: ApprovalRequest): ApprovalRecord {
  const record = store.getSnapshot(request.sessionId).approvals.find(item =>
    item.runId === request.runId && item.toolCallId === request.toolCallId);
  assert.ok(record);
  return record;
}

function journal(store: SqliteStore, sessionId: string): EngineEvent[] {
  const snapshot = store.getSnapshot(sessionId);
  const events = store.readEvents(sessionId, 0, 1_024);
  assert.equal(events.length, snapshot.lastSeq);
  assert.deepEqual(events.map(event => event.seq), Array.from({ length: snapshot.lastSeq }, (_, index) => index + 1));
  return events;
}

test('SQLite subscriber immediately decides an already committed approval and replays the resolution', options, async (t) => {
  const env = environment(t);
  const store = env.open();
  const scope = admit(store, env);
  const input = toolRequest(store, scope);
  const manager = new ApprovalManager(store);
  const subscriberAbort = new AbortController();
  const cursor = store.getSnapshot(scope.session.id).lastSeq;
  const stream = store.subscribe(scope.session.id, cursor, subscriberAbort.signal)[Symbol.asyncIterator]();
  const decisionFromSubscriber = (async () => {
    const event = await stream.next();
    assert.equal(event.done, false);
    assert.equal(event.value?.type, 'approval.requested');
    const id = event.value?.payload.approvalId;
    assert.equal(typeof id, 'string');
    const pending = store.getApproval(id as string);
    assert.equal(pending.status, 'pending');
    assert.equal(store.getSnapshot(scope.session.id).lastSeq, event.value?.seq);
    // The async subscriber resumes after commit; its handler makes the decision synchronously.
    const result = manager.decide(pending.id, 'allow', pending.fingerprint);
    const resolved = await stream.next();
    assert.equal(resolved.value?.type, 'approval.resolved');
    assert.equal(resolved.value?.seq, (event.value?.seq ?? 0) + 1);
    subscriberAbort.abort();
    await stream.return?.();
    return result;
  })();
  const waiting = manager.request(input, new AbortController().signal);
  assert.deepEqual(await waiting, await decisionFromSubscriber);
  assert.equal(store.getRun(scope.run.id).state, 'awaiting_approval');
  const replay = store.readEvents(scope.session.id, cursor);
  assert.deepEqual(replay.map(event => event.type), ['approval.requested', 'approval.resolved']);
  journal(store, scope.session.id);
  store.close();
  const reopened = env.open();
  assert.equal(reopened.getApproval(approval(reopened, input).id).status, 'allowed');
  assert.deepEqual(reopened.readEvents(scope.session.id, cursor), replay);
});

for (const decision of ['allow', 'deny'] as const) {
  test(`SQLite ${decision} decisions survive reopen and duplicate delivery cannot overwrite them`, options, async (t) => {
    const env = environment(t);
    const store = env.open();
    const scope = admit(store, env);
    const input = toolRequest(store, scope);
    const manager = new ApprovalManager(store);
    const waiting = manager.request(input, new AbortController().signal);
    const pending = approval(store, input);
    const first = manager.decide(pending.id, decision, pending.fingerprint);
    assert.deepEqual(await waiting, first);
    assert.equal(first.status, decision === 'allow' ? 'allowed' : 'denied');
    const seq = store.getSnapshot(scope.session.id).lastSeq;
    store.close();
    const reopened = env.open();
    const successor = new ApprovalManager(reopened);
    assert.deepEqual(successor.decide(first.id, decision, first.fingerprint), first);
    assert.throws(() => successor.decide(first.id, decision === 'allow' ? 'deny' : 'allow', first.fingerprint), hasCode('APPROVAL_CONFLICT'));
    assert.throws(() => successor.decide(first.id, decision, 'wrong-prepared-action'), hasCode('APPROVAL_FINGERPRINT_MISMATCH'));
    await assert.rejects(successor.request(input, new AbortController().signal), hasCode('APPROVAL_STALE'));
    assert.equal(reopened.getSnapshot(scope.session.id).lastSeq, seq);
    assert.deepEqual(reopened.getApproval(first.id), first);
    assert.equal(journal(reopened, scope.session.id).filter(event => event.type === 'approval.resolved').length, 1);
  });
}

for (const order of ['abort-first', 'allow-first'] as const) {
  test(`SQLite abort/decide ordering retains the first durable outcome: ${order}`, options, async (t) => {
    const env = environment(t);
    const store = env.open();
    const scope = admit(store, env);
    const input = toolRequest(store, scope);
    const manager = new ApprovalManager(store);
    const signal = new AbortController();
    const waiting = manager.request(input, signal.signal);
    const pending = approval(store, input);
    let executions = 0;
    const consumer = waiting.then(record => {
      if (record.status === 'allowed' && !signal.signal.aborted) executions++;
    }, () => {});
    if (order === 'abort-first') {
      const rejected = assert.rejects(waiting, hasCode('APPROVAL_CANCELLED'));
      signal.abort();
      assert.throws(() => manager.decide(pending.id, 'allow', pending.fingerprint), hasCode('APPROVAL_EXPIRED'));
      await rejected;
    } else {
      manager.decide(pending.id, 'allow', pending.fingerprint);
      signal.abort();
      assert.equal((await waiting).status, 'allowed');
    }
    await consumer;
    assert.equal(executions, 0);
    const state = order === 'abort-first' ? 'expired' : 'allowed';
    assert.equal(store.getApproval(pending.id).status, state);
    const events = journal(store, scope.session.id).filter(event => event.type.startsWith('approval.'));
    assert.deepEqual(events.map(event => event.type), ['approval.requested', order === 'abort-first' ? 'approval.expired' : 'approval.resolved']);
    store.close();
    const reopened = env.open();
    assert.equal(reopened.getApproval(pending.id).status, state);
    assert.deepEqual(reopened.readEvents(scope.session.id, 0, 1_024), journal(reopened, scope.session.id));
  });
}

test('SQLite refuses cross workspace/run/tool and name bindings without creating approval events', options, async (t) => {
  const env = environment(t);
  const store = env.open();
  const first = admit(store, env, 'one');
  const second = admit(store, env, 'two');
  const input = toolRequest(store, first);
  const other = toolRequest(store, second);
  const manager = new ApprovalManager(store);
  const firstSeq = store.getSnapshot(first.session.id).lastSeq;
  const secondSeq = store.getSnapshot(second.session.id).lastSeq;
  await assert.rejects(manager.request({ ...input, sessionId: second.session.id }, new AbortController().signal), hasCode('APPROVAL_REQUEST_CONFLICT'));
  await assert.rejects(manager.request({ ...input, toolCallId: other.toolCallId }, new AbortController().signal), hasCode('RECORD_SCOPE_MISMATCH'));
  await assert.rejects(manager.request({ ...other, runId: first.run.id }, new AbortController().signal), hasCode('APPROVAL_REQUEST_CONFLICT'));
  await assert.rejects(manager.request({ ...input, toolName: 'apply_patch' }, new AbortController().signal), hasCode('RECORD_SCOPE_MISMATCH'));
  await assert.rejects(manager.request({ ...input, toolCallId: randomUUID() }, new AbortController().signal), hasCode('TOOL_NOT_FOUND'));
  assert.equal(store.getSnapshot(first.session.id).lastSeq, firstSeq);
  assert.equal(store.getSnapshot(second.session.id).lastSeq, secondSeq);
  assert.deepEqual(store.getSnapshot(first.session.id).approvals, []);
  assert.deepEqual(store.getSnapshot(second.session.id).approvals, []);
  // Rolled-back request commits also remove their transient waiters.
  const waiting = manager.request(input, new AbortController().signal);
  const pending = approval(store, input);
  manager.decide(pending.id, 'allow', input.fingerprint);
  assert.equal((await waiting).status, 'allowed');
  journal(store, first.session.id);
});

test('a fingerprint from another workspace, Run, or tool cannot authorize a SQLite approval', options, async (t) => {
  const env = environment(t);
  const store = env.open();
  const first = admit(store, env, 'one');
  const second = admit(store, env, 'two');
  const inputs = [toolRequest(store, first), toolRequest(store, first), toolRequest(store, second)];
  const manager = new ApprovalManager(store);
  const waits = inputs.map(input => manager.request(input, new AbortController().signal));
  const records = inputs.map(input => approval(store, input));
  const seqs = [store.getSnapshot(first.session.id).lastSeq, store.getSnapshot(second.session.id).lastSeq];
  for (const record of records) {
    for (const other of records) {
      if (record.id === other.id) continue;
      assert.throws(() => manager.decide(record.id, 'allow', other.fingerprint), hasCode('APPROVAL_FINGERPRINT_MISMATCH'));
      assert.equal(store.getApproval(record.id).status, 'pending');
    }
  }
  assert.deepEqual([store.getSnapshot(first.session.id).lastSeq, store.getSnapshot(second.session.id).lastSeq], seqs);
  for (const record of records) manager.decide(record.id, 'deny', record.fingerprint);
  assert.ok((await Promise.all(waits)).every(record => record.status === 'denied'));
  assert.ok([...journal(store, first.session.id), ...journal(store, second.session.id)].every(event => event.type !== 'tool.started'));
});

test('private preview and control values remain in the intended preview but are absent from approval errors', options, async (t) => {
  const env = environment(t);
  const store = env.open();
  const scope = admit(store, env);
  const privateValue = 'SYNTHETIC_APPROVAL_SECRET\n\u001b[31mprivate\0value';
  const preview: JsonObject = { command: privateValue, context: { token: privateValue }, cwd: '.' };
  const input = toolRequest(store, scope, preview);
  const manager = new ApprovalManager(store);
  const signal = new AbortController();
  const waiting = manager.request(input, signal.signal);
  const pending = approval(store, input);
  const cleanError = (code: string) => (error: unknown): boolean => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, code);
    const output = `${error.name} ${error.message} ${error.stack ?? ''} ${JSON.stringify(error.details)}`;
    assert.equal(output.includes('SYNTHETIC_APPROVAL_SECRET'), false);
    assert.equal(output.includes('\u001b'), false);
    assert.equal(output.includes('\0'), false);
    return true;
  };
  assert.deepEqual(pending.preview, preview);
  assert.deepEqual(journal(store, scope.session.id).find(event => event.type === 'approval.requested')?.payload.preview, preview);
  assert.throws(() => manager.decide(pending.id, 'allow', privateValue), cleanError('APPROVAL_FINGERPRINT_MISMATCH'));
  await assert.rejects(manager.request({ ...input, preview: { command: `${privateValue}-different` } }, new AbortController().signal), cleanError('APPROVAL_REQUEST_CONFLICT'));
  assert.throws(() => manager.decide(privateValue, 'allow', privateValue), cleanError('APPROVAL_NOT_FOUND'));
  const rejected = assert.rejects(waiting, cleanError('APPROVAL_CANCELLED'));
  signal.abort(new Error(privateValue));
  await rejected;
  assert.throws(() => manager.decide(pending.id, 'allow', input.fingerprint), cleanError('APPROVAL_EXPIRED'));
  assert.deepEqual(store.getApproval(pending.id).preview, preview);
});

test('terminal commit durably expires approval before its terminal event and late decisions end the wait', options, async (t) => {
  const env = environment(t);
  const store = env.open();
  const scope = admit(store, env);
  const input = toolRequest(store, scope);
  const manager = new ApprovalManager(store);
  const waiting = manager.request(input, new AbortController().signal);
  const pending = approval(store, input);
  const cursor = store.getSnapshot(scope.session.id).lastSeq;
  // The store transaction owns expiration even if an actor terminates before cleanup.
  const terminal = store.commit(scope.run.id, 'run.failed', {}, { run: { state: 'failed' } });
  const durable = store.getApproval(pending.id);
  assert.equal(durable.status, 'expired');
  assert.equal(typeof durable.resolvedAt, 'string');
  const terminalSeq = store.getSnapshot(scope.session.id).lastSeq;
  const boundary = store.readEvents(scope.session.id, cursor);
  assert.deepEqual(boundary.map(event => event.type), ['approval.expired', 'run.failed']);
  assert.equal(boundary[0]?.payload.approvalId, pending.id);
  assert.equal(boundary[0]?.seq, terminal.seq - 1);
  assert.equal(boundary[1]?.seq, terminal.seq);
  assert.equal(terminalSeq, terminal.seq);
  const rejected = assert.rejects(waiting, hasCode('APPROVAL_EXPIRED'));
  // An invalid delivery still observes the saved expiration and releases the memory wait.
  assert.throws(() => manager.decide(pending.id, 'allow', 'wrong-fingerprint'), hasCode('APPROVAL_FINGERPRINT_MISMATCH'));
  assert.throws(() => manager.decide(pending.id, 'allow', input.fingerprint), hasCode('APPROVAL_EXPIRED'));
  assert.throws(() => manager.decide(pending.id, 'deny', input.fingerprint), hasCode('APPROVAL_EXPIRED'));
  await rejected;
  assert.deepEqual(store.getApproval(pending.id), durable);
  assert.equal(store.getSnapshot(scope.session.id).lastSeq, terminalSeq);
  assert.throws(() => store.commit(scope.run.id, 'approval.expired', {}, { approval: durable }), hasCode('RUN_TERMINAL'));
  store.close();
  const reopened = env.open();
  // Expiration is already durable before startup recovery performs other tool cleanup.
  assert.deepEqual(reopened.getApproval(pending.id), durable);
  assert.deepEqual(reopened.recoverInterrupted(), []);
  assert.equal(reopened.getRun(scope.run.id).state, 'failed');
  assert.deepEqual(reopened.getApproval(pending.id), durable);
  assert.throws(() => new ApprovalManager(reopened).decide(pending.id, 'allow', input.fingerprint), hasCode('APPROVAL_EXPIRED'));
  const events = journal(reopened, scope.session.id);
  assert.equal(events.filter(event => event.type === 'approval.expired').length, 1);
  assert.equal(events.filter(event => event.type === 'run.failed').length, 1);
  assert.ok(events.every(event => !['tool.started', 'approval.resolved'].includes(event.type)));
});

for (const order of ['decision-first', 'terminal-first'] as const) {
  test(`approval and terminal actors retain the first committed decision: ${order}`, options, async (t) => {
    const env = environment(t);
    const store = env.open();
    const scope = admit(store, env);
    const input = toolRequest(store, scope);
    const manager = new ApprovalManager(store);
    const waiting = manager.request(input, new AbortController().signal);
    const pending = approval(store, input);
    const cursor = store.getSnapshot(scope.session.id).lastSeq;
    let effects = 0;
    const consumer = waiting.then(record => {
      if (record.status === 'allowed' && store.getRun(scope.run.id).state === 'running') effects++;
    }, () => {});
    if (order === 'decision-first') {
      manager.decide(pending.id, 'allow', input.fingerprint);
      store.commit(scope.run.id, 'run.failed', {}, { run: { state: 'failed' } });
      manager.cancelRun(scope.run.id);
      assert.equal((await waiting).status, 'allowed');
      assert.equal(store.getApproval(pending.id).status, 'allowed');
      assert.deepEqual(store.readEvents(scope.session.id, cursor).map(event => event.type), ['approval.resolved', 'run.failed']);
      assert.equal(manager.decide(pending.id, 'allow', input.fingerprint).status, 'allowed');
    } else {
      const rejected = assert.rejects(waiting, hasCode('APPROVAL_EXPIRED'));
      store.commit(scope.run.id, 'run.failed', {}, { run: { state: 'failed' } });
      assert.throws(() => manager.decide(pending.id, 'allow', input.fingerprint), hasCode('APPROVAL_EXPIRED'));
      await rejected;
      assert.deepEqual(store.readEvents(scope.session.id, cursor).map(event => event.type), ['approval.expired', 'run.failed']);
    }
    await consumer;
    assert.equal(effects, 0);
    const beforeRecovery = journal(store, scope.session.id);
    assert.deepEqual(store.recoverInterrupted(), []);
    const afterRecovery = journal(store, scope.session.id);
    assert.equal(afterRecovery.filter(event => event.type === 'approval.expired').length, order === 'terminal-first' ? 1 : 0);
    assert.equal(afterRecovery.filter(event => event.type === 'approval.resolved').length, order === 'decision-first' ? 1 : 0);
    assert.equal(afterRecovery.filter(event => event.type === 'run.failed').length, 1);
    assert.deepEqual(afterRecovery.filter(event => event.type.startsWith('approval.')), beforeRecovery.filter(event => event.type.startsWith('approval.')));
  });
}

for (const cleanup of ['cancel-run', 'abort'] as const) {
  test(`terminal expiry followed by ${cleanup} releases live waiters without another expiry commit`, options, async (t) => {
    const env = environment(t);
    const store = env.open();
    const scope = admit(store, env);
    const input = toolRequest(store, scope);
    const manager = new ApprovalManager(store);
    const signal = new AbortController();
    const waiting = manager.request(input, signal.signal);
    const pending = approval(store, input);
    const rejected = assert.rejects(waiting, hasCode('APPROVAL_CANCELLED'));
    store.commit(scope.run.id, 'run.failed', {}, { run: { state: 'failed' } });
    assert.equal(store.getApproval(pending.id).status, 'expired');
    const seq = store.getSnapshot(scope.session.id).lastSeq;
    if (cleanup === 'cancel-run') manager.cancelRun(scope.run.id);
    else signal.abort();
    await rejected;
    manager.cancelRun(scope.run.id);
    signal.abort();
    assert.equal(store.getSnapshot(scope.session.id).lastSeq, seq);
    assert.throws(() => manager.decide(pending.id, 'allow', input.fingerprint), hasCode('APPROVAL_EXPIRED'));
    assert.equal(journal(store, scope.session.id).filter(event => event.type === 'approval.expired').length, 1);
  });
}

interface Ready {
  sessionId: string; runId: string; toolCallId: string;
  approvalId: string; fingerprint: string; lastSeq: number;
}

async function launch(env: Environment, marker: string, control = false): Promise<{
  child: ChildProcess; exited: Promise<ProcessExit>; ready: Ready;
}> {
  const source = import.meta.url.endsWith('.ts');
  const path = fileURLToPath(new URL(`./fixtures/approval-child.${source ? 'ts' : 'js'}`, import.meta.url));
  const child = spawn(process.execPath, [
    ...(source ? ['--import', 'tsx'] : []), path, env.dbPath, marker, ...(control ? ['allow-control'] : []),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<ProcessExit>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  env.children.push({ child, exited });
  let diagnostics = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { diagnostics = `${diagnostics}${chunk}`.slice(-16_384); });
  const ready = await new Promise<Ready>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Approval fixture readiness timed out: ${diagnostics}`)), 8_000);
    const fail = (error: Error) => { clearTimeout(timer); reject(error); };
    child.once('error', fail);
    child.once('close', (code, signal) => fail(new Error(`Approval fixture exited before readiness (${code ?? signal}): ${diagnostics}`)));
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      const lineEnd = output.indexOf('\n');
      if (lineEnd < 0) return;
      try {
        const parsed = JSON.parse(output.slice(0, lineEnd)) as Ready;
        for (const key of ['sessionId', 'runId', 'toolCallId', 'approvalId', 'fingerprint'] as const) assert.equal(typeof parsed[key], 'string');
        assert.ok(Number.isSafeInteger(parsed.lastSeq) && parsed.lastSeq > 0);
        clearTimeout(timer);
        resolve(parsed);
      } catch (error) { fail(error instanceof Error ? error : new Error('Invalid fixture readiness')); }
    });
  });
  return { child, exited, ready };
}

test('crash fixture positive control writes its marker only after a durable allow', { timeout: 15_000 }, async (t) => {
  const env = environment(t);
  const marker = join(env.directory, 'effect.txt');
  const { exited, ready } = await launch(env, marker, true);
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(readFileSync(marker, 'utf8'), 'executed');
  const store = env.open();
  assert.equal(store.getApproval(ready.approvalId).status, 'allowed');
  assert.equal(store.getRun(ready.runId).state, 'completed');
  assert.equal(store.getSnapshot(ready.sessionId).tools.find(tool => tool.id === ready.toolCallId)?.state, 'completed');
  const events = journal(store, ready.sessionId);
  assert.equal(events.filter(event => event.type === 'approval.resolved').length, 1);
  assert.equal(events.filter(event => event.type === 'tool.started').length, 1);
  assert.ok(events.findIndex(event => event.type === 'approval.resolved') < events.findIndex(event => event.type === 'tool.started'));
});

for (const recoveryOrder of ['startup-first', 'approval-first'] as const) {
test(`SIGKILL pending approval cannot reconstruct authorization: ${recoveryOrder}`, { timeout: 15_000 }, async (t) => {
  const env = environment(t);
  const marker = join(env.directory, 'effect.txt');
  const { child, exited, ready } = await launch(env, marker);
  assert.equal(existsSync(marker), false);
  let unexpectedOwner: SqliteStore | undefined;
  try {
    assert.throws(() => { unexpectedOwner = new SqliteStore(env.dbPath); }, hasCode('DB_LOCKED'));
  } finally { unexpectedOwner?.close(); }
  assert.equal(child.kill('SIGKILL'), true);
  assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
  const store = env.open();
  assert.equal(store.getApproval(ready.approvalId).status, 'pending');
  assert.equal(store.getSnapshot(ready.sessionId).lastSeq, ready.lastSeq);
  const pendingEvents = journal(store, ready.sessionId);
  assert.equal(pendingEvents.at(-1)?.type, 'approval.requested');
  assert.equal(pendingEvents.filter(event => event.type === 'tool.started').length, 0);
  if (recoveryOrder === 'approval-first') {
    // Even a caller that constructs the manager before startup recovery gets no authority.
    assert.throws(() => new ApprovalManager(store).decide(ready.approvalId, 'allow', ready.fingerprint), hasCode('APPROVAL_EXPIRED'));
    assert.equal(store.getApproval(ready.approvalId).status, 'expired');
    assert.equal(store.getRun(ready.runId).state, 'awaiting_approval');
    assert.equal(existsSync(marker), false);
  }
  const recovered = store.recoverInterrupted();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.id, ready.runId);
  assert.equal(recovered[0]?.state, 'interrupted');
  const record = store.getApproval(ready.approvalId);
  assert.equal(record.status, 'expired');
  assert.equal(typeof record.resolvedAt, 'string');
  assert.equal(store.getSnapshot(ready.sessionId).tools.find(tool => tool.id === ready.toolCallId)?.state, 'interrupted');
  const manager = new ApprovalManager(store);
  assert.throws(() => manager.decide(ready.approvalId, 'allow', ready.fingerprint), hasCode('APPROVAL_EXPIRED'));
  const run = store.getRun(ready.runId);
  const duplicate = store.admit({ sessionId: run.sessionId, requestId: run.requestId, prompt: run.prompt, config: run.config });
  assert.equal(duplicate.runId, run.id);
  assert.equal(duplicate.duplicate, true);
  const after = store.getSnapshot(ready.sessionId);
  await assert.rejects(manager.request({
    sessionId: ready.sessionId, runId: ready.runId, toolCallId: ready.toolCallId,
    toolName: record.toolName, fingerprint: ready.fingerprint, preview: record.preview,
  }, new AbortController().signal), hasCode('APPROVAL_RUN_INACTIVE'));
  assert.deepEqual(store.recoverInterrupted(), []);
  assert.equal(store.getSnapshot(ready.sessionId).lastSeq, after.lastSeq);
  const events = journal(store, ready.sessionId);
  assert.equal(events.filter(event => event.type === 'approval.expired').length, 1);
  assert.equal(events.filter(event => event.type === 'run.interrupted').length, 1);
  assert.ok(events.every(event => !['approval.resolved', 'tool.started', 'tool.completed'].includes(event.type)));
  assert.equal(existsSync(marker), false);
  store.close();
  const reopened = env.open();
  assert.equal(reopened.getApproval(ready.approvalId).status, 'expired');
  assert.throws(() => new ApprovalManager(reopened).decide(ready.approvalId, 'allow', ready.fingerprint), hasCode('APPROVAL_EXPIRED'));
  assert.equal(existsSync(marker), false);
});
}
