import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LIMITS, EngineError, type ApprovalRecord, type MessagePart, type ProviderAttempt, type ToolCallRecord, type TurnRecord } from '@moodcode/contracts';
import { SqliteStore } from './index.js';
import type { McpExecutionIdentity, McpExecutionSettlement } from './mcp-executions.js';
import { canonical } from '../recovery/snapshot.js';

// Authored local storage observations only. These fixtures do not execute a tool,
// contact a provider/peer, or claim that a running intent proves an external effect.
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const config = { providerId: 'review-provider', modelId: 'review-model', mode: 'build' as const, limits: { ...DEFAULT_LIMITS } };
function fixture(t: TestContext, native = true) {
  const store = new SqliteStore(':memory:');
  const db = (store as unknown as { db: DatabaseSync }).db;
  const createdAt = new Date().toISOString();
  store.putWorkspace({ id: 'review-workspace', root: '/tmp/moodcode-frontier-review', gitRoot: '/tmp/moodcode-frontier-review', branch: null, createdAt });
  for (const id of ['review-session', 'foreign-session']) store.createSession({ id, workspaceId: 'review-workspace', title: id, createdAt });
  const input = store.acceptInput({ sessionId: 'review-session', requestId: 'review-goal', prompt: 'Retain the original local execution intent.', config, delivery: 'queue' });
  const run = store.promoteInput(input.inputId).run;
  store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
  const turn: TurnRecord = { schemaVersion: 2, id: 'review-turn', sessionId: run.sessionId, runId: run.id, inputIds: [input.inputId], index: 0, state: 'created', createdAt };
  const attempt: ProviderAttempt = { schemaVersion: 2, id: 'review-attempt', sessionId: run.sessionId, runId: run.id, turnId: turn.id, index: 0,
    providerId: config.providerId, modelId: config.modelId, state: 'prepared', createdAt };
  if (native) {
    store.putTurn(turn); store.putTurn({ ...turn, state: 'streaming' }); store.putAttempt(attempt);
    store.createAttemptCleanup({ attemptId: attempt.id, sessionId: run.sessionId, workspaceId: run.workspaceId, runId: run.id, turnId: turn.id,
      providerId: attempt.providerId, modelId: attempt.modelId, requestProjection: 'engine-turn-request-v1', requestSha256: sha('authored logical request'), requestBytes: 96 });
    store.dispatchAttemptCleanup(attempt.id);
    store.putAttempt({ ...attempt, state: 'dispatched', dispatchedAt: createdAt });
    store.putAttemptUsage(attempt.id, { inputTokens: 12, outputTokens: 4 });
    store.settleAttemptCleanup(attempt.id, { outcome: 'confirmed', method: 'iterator-next-done', reason: 'natural-done' });
    store.putAttempt({ ...attempt, state: 'completed', dispatchedAt: createdAt, completedAt: createdAt });
    store.putTurn({ ...turn, state: 'awaiting_tools' });
  }
  function addTool(id: string, name = 'authored_unknown_tool', value = 'authored input', state: ToolCallRecord['state'] = 'running') {
    const tool: ToolCallRecord = { id, runId: run.id, sessionId: run.sessionId, name, input: { value }, state: 'requested' };
    store.commit(run.id, 'tool.requested', { toolCallId: id }, { tool });
    const part: MessagePart = { schemaVersion: 2, id: `${id}-part`, sessionId: run.sessionId, runId: run.id, turnId: turn.id,
      messageId: `${id}-message`, index: 0, revision: 0, state: 'open', createdAt, type: 'tool', toolCallId: id, providerCallId: `${id}-provider-call`, name, input: tool.input };
    if (native) store.putPart(part);
    store.commit(run.id, 'message.completed', { messageId: part.messageId }, { message: { id: part.messageId, sessionId: run.sessionId, runId: run.id,
      role: 'assistant', content: 'Authored tool observation.', createdAt, toolCalls: [{ id: part.providerCallId, name, input: tool.input }] } });
    if (state !== 'requested') store.commit(run.id, `tool.${state}`, { toolCallId: id }, { tool: { ...tool, state } });
    return { tool: { ...tool, state }, part };
  }
  function approvedMcp() {
    const added = addTool('review-mcp', 'mcp_review_remote');
    const approval: ApprovalRecord = { id: 'review-approval', sessionId: run.sessionId, runId: run.id, toolCallId: added.tool.id, toolName: added.tool.name,
      fingerprint: sha('authored outer approval'), preview: { serverId: 'review', remoteTool: 'remote', catalogueRevision: 1, arguments: added.tool.input }, status: 'pending', createdAt };
    store.commit(run.id, 'approval.requested', {}, { approval });
    store.commit(run.id, 'approval.resolved', {}, { approval: { ...approval, status: 'allowed', resolvedAt: createdAt } });
    const identity: McpExecutionIdentity = { toolCallId: added.tool.id, sessionId: run.sessionId, workspaceId: run.workspaceId, runId: run.id, turnId: turn.id,
      attemptId: attempt.id, providerId: config.providerId, modelId: config.modelId, toolName: added.tool.name, approvalId: approval.id, approvalFingerprint: approval.fingerprint,
      serverId: 'review', connectionId: 'authored-connection', catalogueRevision: 1, remoteTool: 'remote', protocolVersion: '2026-07-28', transportKind: 'http', logicalRpcId: 7,
      requestProjection: 'mcp-jsonrpc-tools-call-v1', requestSha256: sha('authored JSON-RPC request'), requestBytes: 114 };
    const terminal: McpExecutionSettlement = { outcome: 'response-terminal', reason: 'response', transportCleanupConfirmed: true,
      responseKind: 'tool-result', responseSha256: sha('authored correlated response'), responseBytes: 72, isError: false };
    store.createMcpExecution(identity);
    return { ...added, approval, identity, terminal };
  }
  function preserved() {
    return db.prepare('SELECT data FROM provider_attempts ORDER BY rowid').all().map(row => row.data)
      .concat(db.prepare('SELECT data FROM attempt_cleanup ORDER BY rowid').all().map(row => row.data))
      .concat(db.prepare('SELECT data FROM attempt_usage ORDER BY rowid').all().map(row => row.data));
  }
  function durableState() {
    const names = ['runs', 'tools', 'approvals', 'session_turns', 'provider_attempts', 'message_parts', 'mcp_executions', 'events', 'session_events', 'sessions', 'session_sequences', 'session_controls'];
    return names.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
  }
  t.after(() => store.close());
  return { store, db, run, turn, attempt, addTool, approvedMcp, preserved, durableState };
}

function recoveryFailure(error: unknown) { return error instanceof EngineError && (error.code.startsWith('TOOL_RECOVERY_') || error.code.startsWith('MCP_EXECUTION_') || error.code === 'RECOVERY_EVIDENCE_LIMIT'); }

test('read-like names and a completed checkpoint do not prove that the original running tool settled', t => {
  const f = fixture(t), tool = f.addTool('read-like', 'read_file').tool, before = f.preserved();
  const originalTurn = f.store.getTurn(f.turn.id), originalAttempt = f.store.getAttempt(f.attempt.id), originalPart = f.store.listParts(f.turn.id)[0]!;
  f.store.commit(f.run.id, 'checkpoint.created', {}, { checkpoint: { id: 'review-checkpoint', runId: f.run.id, toolCallId: tool.id, kind: 'command',
    createdAt: new Date().toISOString(), files: [], warnings: [], incomplete: false } });
  f.store.recoverInterrupted();
  assert.equal(f.store.getTurn(f.turn.id).state, 'uncertain');
  assert.equal(f.store.getTurn(f.turn.id).uncertainty?.kind, 'tool_effect');
  assert.equal(f.store.hasUncertainWorkspace(f.run.workspaceId), true);
  assert.deepEqual(f.preserved(), before);
  assert.equal(f.store.getToolCall(tool.id).output, undefined);
  const frontier = f.store.readSessionEvents(f.run.sessionId, 0).find(event => event.type === 'tool.recovery_frontier')?.payload.frontier;
  assert.ok(frontier && typeof frontier === 'object' && !Array.isArray(frontier));
  assert.equal(frontier.originalToolState, 'running');
  assert.equal(frontier.toolRecordSha256, sha(canonical(tool)));
  assert.equal(frontier.turnRecordSha256, sha(canonical(originalTurn)));
  assert.equal(frontier.attemptRecordSha256, sha(canonical(originalAttempt)));
  assert.equal(frontier.proposalSha256, sha(canonical(Object.fromEntries(Object.entries(originalPart).filter(([key]) => !['state', 'revision', 'completedAt', 'result'].includes(key))))));
  assert.equal(frontier.effectOutcome, 'unknown'); assert.equal(frontier.callbackEntry, 'unverified');
});

test('requested intent is not execution and terminal interrupted history is not backfilled on later startup', t => {
  const f = fixture(t); f.addTool('never-started', 'authored_unknown_tool', 'authored input', 'requested');
  f.store.recoverInterrupted();
  assert.equal(f.store.getTurn(f.turn.id).state, 'interrupted');
  assert.equal(f.store.hasUncertainWorkspace(f.run.workspaceId), false);
  const before = f.durableState(); f.store.recoverInterrupted(); assert.deepEqual(f.durableState(), before);
});

test('genuine legacy-only running intent produces unchecked coverage without synthesizing native execution', t => {
  const f = fixture(t, false); f.addTool('legacy-running'); f.store.recoverInterrupted();
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM session_turns').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM provider_attempts').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM mcp_executions').get()!.n, 0);
  assert.equal(f.store.getToolCall('legacy-running').state, 'interrupted');
  const events = f.store.readEvents(f.run.sessionId, 0);
  assert.equal(events.filter(event => event.type === 'tool.recovery_frontier.unchecked').length, 1);
});

test('safe MCP receipts are exact, preserve original outcomes, and do not fabricate a tool result', t => {
  for (const outcome of ['response-terminal', 'not-dispatched'] as const) {
    const f = fixture(t), mcp = f.approvedMcp(), preserved = f.preserved();
    if (outcome === 'response-terminal') { f.store.dispatchMcpExecution(mcp.tool.id, 'http-fetch'); f.store.settleMcpExecution(mcp.tool.id, mcp.terminal); }
    else f.store.settleMcpExecution(mcp.tool.id, { outcome, reason: 'cancel', transportCleanupConfirmed: true });
    const receipt = f.store.getMcpExecution(mcp.tool.id); f.store.recoverInterrupted();
    assert.equal(f.store.getTurn(f.turn.id).state, 'interrupted');
    assert.equal(f.store.hasUncertainWorkspace(f.run.workspaceId), false);
    assert.deepEqual(f.store.getMcpExecution(mcp.tool.id), receipt); assert.deepEqual(f.preserved(), preserved);
    assert.equal(f.store.getToolCall(mcp.tool.id).output, undefined);
    assert.equal(f.store.listParts(f.turn.id).find(part => part.id === mcp.part.id)?.state, 'interrupted');
  }
});

test('response metadata with failed local cleanup does not exempt a running tool', t => {
  const f = fixture(t), mcp = f.approvedMcp(); f.store.dispatchMcpExecution(mcp.tool.id, 'http-fetch');
  f.store.settleMcpExecution(mcp.tool.id, { ...mcp.terminal, outcome: 'uncertain', reason: 'cleanup-error', transportCleanupConfirmed: false });
  f.store.recoverInterrupted(); assert.equal(f.store.getTurn(f.turn.id).uncertainty?.kind, 'tool_effect');
  assert.equal(f.store.hasUncertainWorkspace(f.run.workspaceId), true);
});

test('safe-looking receipt metadata cannot waive changed proposal or outer approval pins', t => {
  for (const target of ['proposal', 'approval', 'receipt-owner'] as const) {
    const f = fixture(t), mcp = f.approvedMcp(); f.store.dispatchMcpExecution(mcp.tool.id, 'http-fetch'); f.store.settleMcpExecution(mcp.tool.id, mcp.terminal);
    if (target === 'proposal') f.db.prepare("UPDATE message_parts SET data=json_set(data,'$.input.value','changed') WHERE id=?").run(mcp.part.id);
    if (target === 'approval') f.db.prepare("UPDATE approvals SET data=json_set(data,'$.preview.arguments.value','changed') WHERE id=?").run(mcp.approval.id);
    if (target === 'receipt-owner') f.db.prepare("UPDATE mcp_executions SET session_id='foreign-session' WHERE tool_call_id=?").run(mcp.tool.id);
    const before = f.durableState(); assert.throws(() => f.store.recoverInterrupted(), recoveryFailure);
    assert.deepEqual(f.durableState(), before, 'A failed exemption must roll back all recovery rewrites and both journals');
  }
});

test('missing, duplicate and foreign native proposal owners fail without guessing a Turn binding', t => {
  for (const target of ['missing', 'duplicate', 'foreign', 'input'] as const) {
    const f = fixture(t), added = f.addTool('bad-proposal');
    if (target === 'missing') f.db.prepare('DELETE FROM message_parts WHERE id=?').run(added.part.id);
    if (target === 'duplicate') f.store.putPart({ ...added.part, id: 'second-proposal', messageId: 'second-message', index: 0 });
    if (target === 'foreign') f.db.prepare("UPDATE message_parts SET session_id='foreign-session',data=json_set(data,'$.sessionId','foreign-session') WHERE id=?").run(added.part.id);
    if (target === 'input') f.db.prepare("UPDATE message_parts SET data=json_set(data,'$.input.value','changed') WHERE id=?").run(added.part.id);
    const before = f.durableState(); assert.throws(() => f.store.recoverInterrupted(), recoveryFailure); assert.deepEqual(f.durableState(), before);
  }
});

test('oversized original running input is rejected before a tools body crosses the SQL boundary', t => {
  const f = fixture(t), added = f.addTool('oversized');
  f.db.prepare("UPDATE tools SET data=json_set(data,'$.input.value',?) WHERE id=?").run('x'.repeat(1_048_577), added.tool.id);
  const prepare = f.db.prepare.bind(f.db); let returnedToolBytes = 0;
  f.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (/\bFROM tools\b/u.test(sql) && /(?:\bdata\b|\.data\b)/u.test(sql) && !/length\(/u.test(sql)) {
      const originalAll = statement.all.bind(statement), originalGet = statement.get.bind(statement);
      const count = (row: Record<string, unknown> | undefined) => { if (typeof row?.data === 'string') returnedToolBytes += Buffer.byteLength(row.data); };
      statement.all = ((...args: Parameters<typeof statement.all>) => { const rows = originalAll(...args); rows.forEach(count); return rows; }) as typeof statement.all;
      statement.get = ((...args: Parameters<typeof statement.get>) => { const row = originalGet(...args); count(row); return row; }) as typeof statement.get;
    }
    return statement;
  }) as typeof f.db.prepare;
  try { assert.throws(() => f.store.recoverInterrupted(), recoveryFailure); assert.equal(returnedToolBytes, 0); }
  finally { f.db.prepare = prepare; }
  assert.equal(f.store.getToolCall(added.tool.id).state, 'running'); assert.equal(f.store.getTurn(f.turn.id).state, 'awaiting_tools');
});

test('distinct bounded running inputs share one aggregate proof budget and rollback at exhaustion', t => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++) f.addTool(`bounded-${i}`, 'authored_unknown_tool', `${i}:` + 'b'.repeat(700_000));
  const before = f.durableState(); assert.throws(() => f.store.recoverInterrupted(), recoveryFailure); assert.deepEqual(f.durableState(), before);
});

test('candidate count cap rejects before selecting original running bodies', t => {
  const f = fixture(t), count = 1025;
  const insert = f.db.prepare('INSERT INTO tools(id,session_id,run_id,state,data) VALUES(?,?,?,?,?)');
  for (let i = 0; i < count; i++) {
    const record: ToolCallRecord = { id: `count-${i}`, sessionId: f.run.sessionId, runId: f.run.id, state: 'running', name: 'authored_unknown_tool', input: { value: i } };
    insert.run(record.id, record.sessionId, record.runId, record.state, JSON.stringify(record));
  }
  const prepare = f.db.prepare.bind(f.db); let bodyQueries = 0;
  f.db.prepare = ((sql: string) => { if (/SELECT data FROM tools/u.test(sql)) bodyQueries++; return prepare(sql); }) as typeof f.db.prepare;
  try { assert.throws(() => f.store.recoverInterrupted(), error => error instanceof EngineError && error.code === 'TOOL_RECOVERY_FRONTIER_LIMIT'); }
  finally { f.db.prepare = prepare; }
  assert.equal(bodyQueries, 0); assert.equal(f.db.prepare("SELECT count(*) AS n FROM tools WHERE state='running'").get()!.n, count);
  assert.equal(f.store.getTurn(f.turn.id).state, 'awaiting_tools');
});

test('original ordinals above JavaScript safe integer precision retain exact numeric chronology', t => {
  const f = fixture(t), first = f.addTool('ordinal-first'), second = f.addTool('ordinal-second');
  const start = 9_007_199_254_740_993n;
  f.db.prepare('UPDATE tools SET ordinal=? WHERE id=?').run(start, first.tool.id);
  f.db.prepare('UPDATE tools SET ordinal=? WHERE id=?').run(start + 1n, second.tool.id);
  f.store.recoverInterrupted();
  const frontiers = f.store.readSessionEvents(f.run.sessionId, 0).filter(event => event.type === 'tool.recovery_frontier').map(event => event.payload.frontier);
  assert.equal(frontiers.length, 2);
  for (const [index, frontier] of frontiers.entries()) {
    assert.ok(frontier && typeof frontier === 'object' && !Array.isArray(frontier));
    assert.equal(frontier.toolCallId, index === 0 ? first.tool.id : second.tool.id);
    assert.equal(frontier.originalToolOrdinal, (start + BigInt(index)).toString());
  }
});

test('existing terminal Turn uncertainty is retained and another terminal Turn cannot be rewritten to cover running intent', t => {
  for (const state of ['uncertain', 'interrupted'] as const) {
    const f = fixture(t); f.addTool('terminal-owner');
    const turn = f.store.getTurn(f.turn.id);
    const settled: TurnRecord = { ...turn, state, completedAt: new Date().toISOString(), ...(state === 'uncertain' ? { uncertainty: { kind: 'tool_effect' as const,
      message: 'Authored independent original outcome uncertainty.', requiresRecovery: true as const } } : {}) };
    f.store.putTurn(settled);
    if (state === 'interrupted') {
      const before = f.durableState(); assert.throws(() => f.store.recoverInterrupted(), recoveryFailure); assert.deepEqual(f.durableState(), before);
    } else {
      f.store.recoverInterrupted(); assert.deepEqual(f.store.getTurn(turn.id), settled); assert.equal(f.store.hasUncertainWorkspace(f.run.workspaceId), true);
      assert.equal(f.store.readSessionEvents(f.run.sessionId, 0).filter(event => event.type === 'tool.recovery_frontier').length, 0);
    }
  }
});

test('oversized proposal and context owner scalars stay behind bounded SQL metadata projections', t => {
  for (const target of ['proposal-message-owner', 'context-payload-owner'] as const) {
    const f = fixture(t), added = f.addTool('scalar-bound');
    const oversized = 'o'.repeat(9 * 1_048_576);
    if (target === 'proposal-message-owner') f.db.prepare('UPDATE message_parts SET message_id=? WHERE id=?').run(oversized, added.part.id);
    else {
      f.store.putContextRevision({ schemaVersion: 2, id: 'review-context', sessionId: f.run.sessionId, runId: f.run.id, turnId: f.turn.id,
        revision: 1, kind: 'baseline', sourceIds: [], text: 'Authored bounded context.', sha256: sha('Authored bounded context.'), createdAt: new Date().toISOString() });
      f.db.prepare("UPDATE provider_attempts SET data=json_set(data,'$.contextRevisionId','review-context') WHERE id=?").run(f.attempt.id);
      f.db.prepare("UPDATE context_revisions SET data=json_set(data,'$.id',?) WHERE id='review-context'").run(oversized);
    }
    const prepare = f.db.prepare.bind(f.db); let largeReturnedBytes = 0;
    const count = (row: Record<string, unknown> | undefined) => {
      if (!row) return;
      for (const value of Object.values(row)) if (typeof value === 'string' && Buffer.byteLength(value) > 1_048_576) largeReturnedBytes += Buffer.byteLength(value);
    };
    f.db.prepare = ((sql: string) => {
      const statement = prepare(sql), originalGet = statement.get.bind(statement), originalAll = statement.all.bind(statement);
      statement.get = ((...args: Parameters<typeof statement.get>) => { const row = originalGet(...args); count(row); return row; }) as typeof statement.get;
      statement.all = ((...args: Parameters<typeof statement.all>) => { const rows = originalAll(...args); rows.forEach(count); return rows; }) as typeof statement.all;
      return statement;
    }) as typeof f.db.prepare;
    try {
      assert.throws(() => f.store.recoverInterrupted(), recoveryFailure);
      assert.equal(largeReturnedBytes, 0, `${target} must reject without returning its 9 MiB scalar to JavaScript`);
    } finally { f.db.prepare = prepare; }
    assert.equal(f.store.getToolCall(added.tool.id).state, 'running');
    assert.equal(f.store.getTurn(f.turn.id).state, 'awaiting_tools');
  }
});

test('native and legacy audit failures roll back the frontier, original tool, and control together', t => {
  for (const journal of ['events', 'session_events'] as const) {
    const f = fixture(t); f.addTool('journal-bound'); const before = f.durableState();
    f.db.exec(`CREATE TEMP TRIGGER reject_frontier_audit BEFORE INSERT ON ${journal} WHEN NEW.type='tool.recovery_frontier' BEGIN SELECT RAISE(ABORT,'authored recovery audit failure'); END`);
    assert.throws(() => f.store.recoverInterrupted()); assert.deepEqual(f.durableState(), before);
    f.db.exec('DROP TRIGGER reject_frontier_audit'); f.store.recoverInterrupted();
    assert.equal(f.store.hasUncertainWorkspace(f.run.workspaceId), true);
  }
});
