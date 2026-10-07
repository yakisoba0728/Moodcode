import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { EngineError, type JsonObject, type MessagePart, type ProviderAttempt, type ToolCallRecord, type TurnRecord } from '@moodcode/contracts';
import { createEngine, type EngineOptions, type MoodcodeEngine } from '../engine.js';
import type { ProviderAdapter, TurnRequest } from '../ports.js';
import { canonical } from '../recovery/snapshot.js';
import { exportEngineArchive, importEngineArchive } from '../storage/archive.js';
import { SqliteStore } from '../storage/index.js';

const phases = ['proposal-only', 'requested', 'awaiting-approval', 'running-intent', 'execute-entered', 'mcp-response-terminal', 'mcp-not-dispatched'] as const;
type Phase = typeof phases[number];
const unsafe = (phase: Phase) => phase === 'running-intent' || phase === 'execute-entered';
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
function rows<T>(db: DatabaseSync, table: string, runId: string): T[] {
  // These are authored fixture observations, not production bounded-proof reads.
  return db.prepare(`SELECT data FROM ${table} WHERE run_id=? ORDER BY rowid LIMIT 64`).all(runId).map(row => JSON.parse(String(row.data)) as T);
}
function construct(options: EngineOptions, observed: () => void): MoodcodeEngine {
  const previous = SqliteStore.prototype.getSnapshot;
  const trap = () => { observed(); throw new Error('Whole snapshots are forbidden in tool frontier recovery'); };
  SqliteStore.prototype.getSnapshot = trap;
  try { const engine = createEngine(options); engine.store.getSnapshot = trap; return engine; }
  finally { SqliteStore.prototype.getSnapshot = previous; }
}
interface Stopped { runId: string; toolCallId: string }
async function crash(t: TestContext, phase: Phase) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-tool-recovery-frontier-'))), dbPath = join(directory, 'engine.sqlite'), artifactDir = join(directory, 'artifacts');
  let remoteCalls = 0;
  const peer = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk; const rpc = JSON.parse(body) as JsonObject;
      let result: JsonObject;
      if (rpc.method === 'server/discover') result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } };
      else if (rpc.method === 'tools/list') result = { tools: [{ name: 'observe', description: 'Private loopback terminal observation.', inputSchema: { type: 'object' } }] };
      else if (rpc.method === 'tools/call') { remoteCalls++; result = { content: [{ type: 'text', text: 'Private correlated terminal observation.' }] }; }
      else { response.writeHead(202); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch { if (!response.destroyed) { response.writeHead(500); response.end(); } }
  });
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(peer.address() as { port: number }).port}/mcp`;
  const sourceWorker = fileURLToPath(new URL('./fixtures/tool-recovery-frontier-child.ts', import.meta.url)), compiledWorker = fileURLToPath(new URL('./fixtures/tool-recovery-frontier-child.js', import.meta.url));
  const worker = process.env.MOODCODE_TOOL_FRONTIER_WORKER ?? (import.meta.url.endsWith('.ts') ? sourceWorker : compiledWorker);
  const child = spawn(process.execPath, [...(worker.endsWith('.ts') ? ['--import', 'tsx'] : []), worker, directory, phase, url], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '', exited = false, engine: MoodcodeEngine | undefined; child.stderr?.on('data', data => { stderr += String(data).slice(0, 4096); });
  const exit = new Promise<void>(resolve => child.once('exit', () => { exited = true; resolve(); }));
  t.after(async () => { if (!exited) child.kill('SIGKILL'); await exit; await engine?.close(); peer.closeAllConnections(); await new Promise<void>(resolve => peer.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const selected = await new Promise<Stopped>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Private frontier timed out: ${phase}; ${stderr}`)), 10000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Private frontier worker exited early: ${phase}; ${stderr}`)); });
    child.on('message', message => { if ((message as { kind?: string }).kind === 'stopped') { clearTimeout(timer); resolve(message as Stopped); } });
  });
  child.kill('SIGKILL'); await exit;
  const reader = new DatabaseSync(dbPath, { readOnly: true }); t.after(() => reader.close());
  const before = {
    tools: rows<ToolCallRecord>(reader, 'tools', selected.runId), parts: rows<MessagePart>(reader, 'message_parts', selected.runId),
    attempts: rows<ProviderAttempt>(reader, 'provider_attempts', selected.runId), turns: rows<TurnRecord>(reader, 'session_turns', selected.runId),
    cleanup: rows(reader, 'attempt_cleanup', selected.runId), usage: rows(reader, 'attempt_usage', selected.runId), messages: rows(reader, 'messages', selected.runId),
    approvals: rows<JsonObject>(reader, 'approvals', selected.runId), inputs: rows(reader, 'session_inputs', selected.runId), mcp: rows<JsonObject>(reader, 'mcp_executions', selected.runId),
  };
  assert.equal(before.turns[0]?.state, 'awaiting_tools'); assert.equal(before.attempts[0]?.state, 'completed');
  assert.equal(readFileSync(join(directory, 'provider-calls.log'), 'utf8').trim(), 'provider-dispatch');
  assert.equal(existsSync(join(directory, 'callback-entry.log')), phase === 'execute-entered');
  if (phase === 'proposal-only') assert.deepEqual(before.tools, []);
  else assert.equal(before.tools[0]?.state, phase === 'requested' ? 'requested' : phase === 'awaiting-approval' ? 'awaiting_approval' : 'running');
  if (phase.startsWith('mcp-')) { assert.equal(before.mcp.length, 1); assert.equal(before.mcp[0]!.state, phase.slice(4)); assert.equal(before.mcp[0]!.transportCleanupConfirmed, true); }
  else assert.deepEqual(before.mcp, []);
  assert.equal(remoteCalls, phase === 'mcp-response-terminal' ? 1 : 0);
  let snapshots = 0, callbacks = 0; const modelRequests: TurnRequest[] = [];
  const provider: ProviderAdapter = { id: 'private-frontier', async *streamTurn(request) { modelRequests.push(structuredClone(request)); yield { type: 'text.delta', delta: 'Explicit private successor.' }; yield { type: 'finish', reason: 'stop' }; } };
  const options: EngineOptions = { dbPath, artifactDir, providers: [provider], tools: [], defaults: { providerId: provider.id, modelId: 'private-model', mode: 'build', limits: { maxContextBytes: 262144 } } };
  engine = construct(options, () => snapshots++);
  return { directory, dbPath, artifactDir, reader, selected, before, options, modelRequests, remoteCalls: () => remoteCalls, snapshots: () => snapshots, callbacks: () => callbacks,
    get engine() { return engine!; }, async restart() { await engine!.close(); engine = construct(options, () => snapshots++); },
    async maintenance() { return engine!.coordinator.withWorkspaceLease('workspace', async () => { callbacks++; return 'private maintenance observation'; }); },
  };
}
function assertOriginal(f: Awaited<ReturnType<typeof crash>>, phase: Phase) {
  const { engine, selected, before, reader } = f;
  assert.deepEqual(rows(reader, 'messages', selected.runId), before.messages);
  assert.deepEqual(rows(reader, 'provider_attempts', selected.runId), before.attempts);
  assert.deepEqual(rows(reader, 'attempt_cleanup', selected.runId), before.cleanup);
  assert.deepEqual(rows(reader, 'attempt_usage', selected.runId), before.usage);
  assert.deepEqual(rows(reader, 'session_inputs', selected.runId), before.inputs);
  assert.deepEqual(rows(reader, 'mcp_executions', selected.runId), before.mcp);
  const attempt = engine.store.getAttempt(before.attempts[0]!.id); assert.equal(attempt.providerRequestId, 'private-frontier-model-request');
  const cleanup = engine.store.getAttemptCleanup(attempt.id); assert.equal(cleanup.state, 'confirmed'); assert.equal(cleanup.method, 'iterator-next-done');
  const usage = rows<{ usage: unknown }>(reader, 'attempt_usage', selected.runId)[0]!;
  assert.deepEqual(usage.usage, { inputTokens: 11, outputTokens: 4, cachedInputTokens: 2, reasoningOutputTokens: 1 });
  const parts = engine.store.listParts(before.turns[0]!.id);
  for (const original of before.parts) {
    const part = parts.find(item => item.id === original.id); assert.ok(part);
    if (original.type === 'text' || original.type === 'reasoning') { assert.ok(part.type === 'text' || part.type === 'reasoning'); assert.equal(part.text, original.text); }
    if (original.type === 'tool') { assert.equal(part.type, 'tool'); if (part.type !== 'tool') assert.fail('Original proposal changed type'); assert.equal(part.providerCallId, original.providerCallId); assert.equal(part.toolCallId, original.toolCallId); assert.equal(part.name, original.name); assert.deepEqual(part.input, original.input); assert.equal(part.result, undefined); }
    assert.equal(part.state, 'interrupted');
  }
  if (phase === 'awaiting-approval') { assert.equal(before.approvals[0]!.status, 'pending'); assert.equal(engine.store.getApproval(String(before.approvals[0]!.id)).status, 'expired'); }
  else assert.deepEqual(rows(reader, 'approvals', selected.runId), before.approvals);
  if (unsafe(phase)) { assert.equal(before.approvals[0]!.status, 'allowed'); assert.equal(engine.store.getApproval(String(before.approvals[0]!.id)).fingerprint, before.approvals[0]!.fingerprint); }
  assert.equal(engine.store.getRun(selected.runId).state, 'interrupted'); assert.equal(engine.store.getSessionControl('session').reason, 'recovery_required'); assert.equal(f.snapshots(), 0);
}
function exactRetry(f: Awaited<ReturnType<typeof crash>>) {
  const run = f.engine.store.getRun(f.selected.runId), before = f.modelRequests.length;
  const receipt = f.engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'first', prompt: run.prompt, config: run.config });
  assert.equal(receipt.runId, run.id); assert.equal(f.modelRequests.length, before);
  assert.throws(() => f.engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'first', prompt: 'Changed private exact request.', config: run.config }), code('REQUEST_ID_CONFLICT'));
}
async function assertBlocked(f: Awaited<ReturnType<typeof crash>>) {
  assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), true);
  assert.throws(() => f.engine.scheduler.submitLegacy({ sessionId: 'other-session', requestId: 'explicit-next', prompt: 'Private explicit successor.', config: f.engine.getCapabilities().defaults }), code('CLEANUP_PENDING'));
  assert.throws(() => f.engine.scheduler.resume('session'), code('CLEANUP_PENDING'));
  await assert.rejects(f.maintenance(), code('CLEANUP_PENDING')); assert.equal(f.callbacks(), 0);
  const receipt = f.engine.scheduler.accept({ sessionId: 'queued-session', requestId: 'queued-next', prompt: 'Private queued successor.', config: f.engine.getCapabilities().defaults, delivery: 'queue' });
  await f.engine.waitForSession('queued-session').catch(() => {});
  assert.equal(f.engine.store.getInput(receipt.inputId).state, 'pending'); assert.equal(f.engine.store.getInput(receipt.inputId).runId, undefined);
  assert.equal(f.engine.store.getSessionControl('queued-session').reason, 'recovery_required'); assert.equal(f.modelRequests.length, 0);
  return receipt.inputId;
}
for (const phase of phases) test(`actual native frontier ${phase} survives SIGKILL without confusing proposal, start intent and observed outcome`, { timeout: 30000, skip: process.platform === 'win32' }, async t => {
  const f = await crash(t, phase); assertOriginal(f, phase); exactRetry(f);
  const turn = f.engine.store.getTurn(f.before.turns[0]!.id);
  assert.equal(turn.state, unsafe(phase) ? 'uncertain' : 'interrupted');
  if (unsafe(phase)) assert.equal(turn.uncertainty?.kind, 'tool_effect'); else assert.equal(turn.uncertainty, undefined);
  assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), unsafe(phase));
  if (unsafe(phase)) {
    const native = f.engine.store.readSessionEvents('session', 0, 100).filter(event => event.type === 'tool.recovery_frontier');
    const legacy = f.engine.store.readEvents('session', 0, 100).filter(event => event.type === 'tool.recovery_frontier');
    assert.equal(native.length, 1); assert.equal(legacy.length, 1);
    assert.deepEqual(native[0]!.payload, legacy[0]!.payload);
    const frontier = native[0]!.payload.frontier; assert.ok(frontier && typeof frontier === 'object' && !Array.isArray(frontier));
    assert.equal(frontier.runId, f.selected.runId); assert.equal(frontier.toolCallId, f.selected.toolCallId); assert.equal(frontier.turnId, turn.id); assert.equal(frontier.attemptId, f.before.attempts[0]!.id);
    assert.equal(frontier.originalToolState, 'running'); assert.equal(frontier.effectOutcome, 'unknown'); assert.equal(frontier.callbackEntry, 'unverified', 'Stored intent does not fabricate the private fixture callback-entry observation');
    const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
    assert.equal(frontier.toolRecordSha256, digest(f.before.tools[0])); assert.equal(frontier.turnRecordSha256, digest(f.before.turns[0])); assert.equal(frontier.attemptRecordSha256, digest(f.before.attempts[0]));
    const pendingInputId = await assertBlocked(f);
    const afterFirst = rows(f.reader, 'session_turns', f.selected.runId), originalEvents = f.engine.store.readEvents('session', 0, 100), originalNative = f.engine.store.readSessionEvents('session', 0, 100);
    await f.restart(); assertOriginal(f, phase); exactRetry(f); assert.deepEqual(rows(f.reader, 'session_turns', f.selected.runId), afterFirst);
    assert.deepEqual(f.engine.store.readEvents('session', 0, 100), originalEvents); assert.deepEqual(f.engine.store.readSessionEvents('session', 0, 100), originalNative);
    assert.equal(f.engine.store.hasUncertainWorkspace('workspace'), true); assert.equal(f.modelRequests.length, 0);
    await f.engine.close();
    const archived = await exportEngineArchive({ dbPath: f.dbPath, artifactDir: f.artifactDir, destination: join(f.directory, 'archive') });
    const imported = await importEngineArchive({ directory: archived.directory, destination: join(f.directory, 'imported') });
    const restored = construct({ ...f.options, dbPath: imported.dbPath, artifactDir: imported.artifactDir }, () => assert.fail('Imported tool recovery cannot use whole snapshots'));
    try {
      assert.equal(restored.store.hasUncertainWorkspace('workspace'), true); assert.equal(restored.store.getTurn(turn.id).uncertainty?.kind, 'tool_effect');
      assert.throws(() => restored.scheduler.resume('session'), code('CLEANUP_PENDING')); assert.equal(restored.store.getSessionControl('session').paused, true);
      const originalRun = restored.store.getRun(f.selected.runId);
      const duplicate = restored.scheduler.submitLegacy({ sessionId: 'session', requestId: 'first', prompt: originalRun.prompt, config: originalRun.config });
      assert.equal(duplicate.runId, originalRun.id); assert.equal(restored.store.getInput(pendingInputId).state, 'pending'); assert.equal(restored.store.getInput(pendingInputId).runId, undefined);
      assert.throws(() => restored.scheduler.submitLegacy({ sessionId: 'other-session', requestId: 'imported-explicit-next', prompt: 'Private imported successor.', config: restored.getCapabilities().defaults }), code('CLEANUP_PENDING'));
      assert.equal(f.modelRequests.length, 0);
      const db = new DatabaseSync(imported.dbPath, { readOnly: true });
      try {
        const unchanged = [['messages', 'messages'], ['provider_attempts', 'attempts'], ['attempt_cleanup', 'cleanup'], ['attempt_usage', 'usage'], ['session_inputs', 'inputs'], ['approvals', 'approvals']] as const;
        for (const [table, original] of unchanged) assert.deepEqual(rows(db, table, f.selected.runId), f.before[original]);
      }
      finally { db.close(); }
    } finally { await restored.close(); }
  } else {
    assert.equal(f.engine.store.readSessionEvents('session', 0, 100).some(event => event.type === 'tool.recovery_frontier'), false);
    assert.equal(await f.maintenance(), 'private maintenance observation'); assert.equal(f.callbacks(), 1);
    f.engine.scheduler.resume('session');
    const next = f.engine.scheduler.submitLegacy({ sessionId: 'other-session', requestId: 'explicit-next', prompt: 'Private explicit successor.', config: f.engine.getCapabilities().defaults });
    assert.equal((await f.engine.waitForRun(next.runId)).state, 'completed'); assert.equal(f.modelRequests.length, 1);
  }
  assert.equal(Number(f.reader.prepare('SELECT count(*) AS n FROM provider_recovery_acknowledgments').get()!.n), 0);
  assert.equal(Number(f.reader.prepare('SELECT count(*) AS n FROM summary_recovery_acknowledgments').get()!.n), 0);
  assert.equal(f.remoteCalls(), phase === 'mcp-response-terminal' ? 1 : 0); assert.equal(f.snapshots(), 0);
  t.diagnostic(JSON.stringify({ phase, callbackEntered: phase === 'execute-entered', externalEffectProof: false, originalExactRetryReplayed: false, workspaceBlocked: unsafe(phase), modelCallsAfterRestart: f.modelRequests.length, remoteCalls: f.remoteCalls(), automaticAcknowledgments: 0, wholeSnapshots: f.snapshots() }));
});
