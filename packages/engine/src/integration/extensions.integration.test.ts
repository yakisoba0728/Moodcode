import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createEngine, type EngineOptions } from '../engine.js';
import { McpClient, StdioMcpTransport } from '../mcp/index.js';
import { ScriptedProvider } from '../provider/scripted.js';
import { EngineError } from '@moodcode/contracts';

async function fixture(t: test.TestContext, options: Partial<EngineOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-host-extensions-'))), repository = join(root, 'repository');
  await mkdir(repository); execFileSync('git', ['init', '-q', repository]); await writeFile(join(repository, 'file.txt'), 'fixture\n');
  const engine = createEngine({ ...options, dbPath: join(root, 'engine.sqlite') }); t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = await engine.dispatch({ schemaVersion: 1, commandId: 'open', type: 'workspace.open', payload: { path: repository } }); assert.equal(workspace.ok, true);
  const result = await engine.dispatch({ schemaVersion: 1, commandId: 'session', type: 'session.create', payload: { workspaceId: (workspace.result as { id: string }).id } }); assert.equal(result.ok, true);
  return { engine, sessionId: (result.result as { id: string }).id };
}
async function until(condition: () => boolean) { const deadline = Date.now() + 5000; while (!condition()) { assert.ok(Date.now() < deadline, 'extension condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } }

test('host MCP registration is advertised to the real loop and executes only after matching approval', async t => {
  const provider = new ScriptedProvider([{ events: [{ type: 'tool.call', call: { id: 'echo-call', name: 'mcp_local_echo', input: { message: 'fixture' } } }, { type: 'finish', reason: 'tool_calls' }] }, { events: [{ type: 'text.delta', delta: 'Complete' }, { type: 'finish', reason: 'stop' }] }]);
  const f = await fixture(t, { providers: [provider] });
  const sourceMode = import.meta.url.endsWith('.ts'); const server = fileURLToPath(new URL(`../mcp/fixtures/server.${sourceMode ? 'ts' : 'js'}`, import.meta.url));
  const client = new McpClient({ id: 'local', transport: new StdioMcpTransport({ command: process.execPath, args: [...(sourceMode ? ['--import', 'tsx'] : []), server], cwd: process.cwd() }) });
  const connection = await f.engine.connectMcp(client); assert.ok(connection.toolNames.includes('mcp_local_echo')); assert.ok(f.engine.getCapabilities().tools.some(tool => tool.name === 'mcp_local_echo'));
  const receipt = f.engine.coordinator.submit({ sessionId: f.sessionId, requestId: 'mcp', prompt: 'Use the local fixture', config: { ...f.engine.getCapabilities().defaults, mode: 'build' } });
  await until(() => f.engine.store.getSnapshot(f.sessionId).approvals.some(approval => approval.status === 'pending'));
  const approval = f.engine.store.getSnapshot(f.sessionId).approvals[0]!; assert.equal(approval.toolName, 'mcp_local_echo');
  const answer = await f.engine.dispatch({ schemaVersion: 1, commandId: 'approve', type: 'approval.decide', payload: { approvalId: approval.id, fingerprint: approval.fingerprint, decision: 'allow' } }); assert.equal(answer.ok, true);
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, 'completed'); assert.equal(f.engine.store.getSnapshot(f.sessionId).tools[0]!.state, 'completed');
  await f.engine.disconnectMcp('local'); assert.equal(client.connected, false); assert.ok(!f.engine.getCapabilities().tools.some(tool => tool.name.startsWith('mcp_local_')));
});

test('engine profile filters advertised and executable handlers while preserving Build mode', async t => {
  let calls = 0;
  const f = await fixture(t, { agentProfiles: [{ id: 'review', description: 'Read only', instructions: 'Use observed files.', tools: ['read_file'], turnAllowance: 2 }], providers: [{ id: 'fixture', async *streamTurn(request) {
    calls++; assert.deepEqual(request.tools.map(tool => tool.name), ['read_file']); assert.ok(request.messages.some(message => message.role === 'system' && message.content === 'Use observed files.'));
    if (request.turnIndex === 0) yield { type: 'tool.call', call: { id: 'excluded', name: 'run_command', input: { command: 'exit 0' } } };
    yield { type: 'finish', reason: request.turnIndex === 0 ? 'tool_calls' : 'stop' };
  } }] });
  const result = await f.engine.dispatchSession({ schemaVersion: 2, commandId: 'profile', type: 'input.accept', payload: { sessionId: f.sessionId, requestId: 'profile', prompt: 'Review current files', delivery: 'queue', config: { providerId: 'fixture', modelId: 'fixture', mode: 'build', agentProfileId: 'review' } } }); assert.equal(result.ok, true);
  await f.engine.waitForSession(f.sessionId); const snapshot = f.engine.store.getSnapshot(f.sessionId);
  assert.equal(snapshot.runs[0]!.state, 'completed'); assert.equal(snapshot.runs[0]!.config.mode, 'build'); assert.equal(snapshot.tools[0]!.state, 'denied'); assert.equal(snapshot.approvals.length, 0); assert.equal(calls, 2);
});

test('real context overflow recovery activates semantic memory and retries once within the same durable Turn', async t => {
  let normalCalls = 0, summaryCalls = 0;
  const f = await fixture(t, { defaults: { providerId: 'fixture', modelId: 'fixture' }, providers: [{ id: 'fixture', async *streamTurn(request) {
    if (!request.tools.length) { summaryCalls++; yield { type: 'text.delta', delta: 'Historical goal: preserve the requested behavior. Initial checks are complete; continue remaining work.' }; yield { type: 'usage', inputTokens: 12, outputTokens: 8 }; yield { type: 'finish', reason: 'stop' }; return; }
    normalCalls++;
    if (normalCalls === 2) throw new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'Fixture context rejection');
    if (normalCalls === 3) { assert.ok(request.messages.some(message => message.content.startsWith('[Moodcode semantic memory v1]'))); assert.equal(request.messages.findLast(message => message.role === 'user')!.content, 'Continue remaining work'); }
    yield { type: 'text.delta', delta: 'Verified fixture observations.' }; yield { type: 'finish', reason: 'stop' };
  } }] });
  for (const [index, prompt] of ['Preserve the requested behavior', 'Continue remaining work'].entries()) {
    const result = await f.engine.dispatchSession({ schemaVersion: 2, commandId: `memory-${index}`, type: 'input.accept', payload: { sessionId: f.sessionId, requestId: `memory-${index}`, prompt, delivery: 'queue' } }); assert.equal(result.ok, true);
    await f.engine.waitForSession(f.sessionId);
  }
  const snapshot = f.engine.store.getSnapshot(f.sessionId); assert.deepEqual(snapshot.runs.map(run => run.state), ['completed', 'completed']);
  const turns = f.engine.store.listTurns(snapshot.runs[1]!.id); assert.equal(turns.length, 1); assert.equal(turns[0]!.state, 'completed');
  const attempts = f.engine.store.readSessionEvents(f.sessionId, 0, 100).filter(event => event.runId === snapshot.runs[1]!.id && event.type === 'provider.attempt.dispatched');
  assert.equal(attempts.length, 2); assert.equal(normalCalls, 3); assert.equal(summaryCalls, 1); assert.ok(f.engine.context.memory.active(f.sessionId));
  assert.equal(snapshot.messages.filter(message => message.role === 'user').length, 2, 'summary requests never become new user transcript entries');
});
