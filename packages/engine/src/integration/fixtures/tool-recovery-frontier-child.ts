import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { createEngine } from '../../engine.js';
import { CredentialBroker } from '../../credentials/index.js';
import { HttpMcpTransport, McpClient } from '../../mcp/index.js';
import type { ProviderAdapter, ToolDefinition } from '../../ports.js';
import { SqliteStore } from '../../storage/index.js';

// A local callback-entry marker proves only entry into this authored callback.
// Neither tool.running nor this marker is evidence of any remote effect.
const [directory, phase, url] = process.argv.slice(2);
const phases = ['proposal-only', 'requested', 'awaiting-approval', 'running-intent', 'execute-entered', 'mcp-response-terminal', 'mcp-not-dispatched'];
if (!directory || !phases.includes(phase!)) throw new Error('Invalid private tool frontier phase');
SqliteStore.prototype.getSnapshot = () => { throw new Error('Tool frontier worker forbids whole snapshots'); };
const repository = join(directory, 'repository'); mkdirSync(repository);
const remote = phase!.startsWith('mcp-'), toolName = remote ? 'mcp_frontier_observe' : 'private_legacy_tool';
let runId = '', stopped = false;
function stop(toolCallId: string) {
  if (stopped) return; stopped = true;
  process.send?.({ kind: 'stopped', phase, runId, toolCallId }); process.kill(process.pid, 'SIGSTOP');
}
const provider: ProviderAdapter = { id: 'private-frontier', async *streamTurn() {
  appendFileSync(join(directory!, 'provider-calls.log'), 'provider-dispatch\n', { mode: 0o600 });
  yield { type: 'progress', providerRequestId: 'private-frontier-model-request' };
  yield { type: 'usage', inputTokens: 11, outputTokens: 4, cachedInputTokens: 2, reasoningOutputTokens: 1 };
  yield { type: 'text.delta', delta: 'Private generic proposal text.' };
  yield { type: 'reasoning.delta', delta: 'Private generic proposal reasoning.' };
  yield { type: 'tool.call', call: { id: 'fixture-provider-call', name: toolName, input: { nonce: 'private-owned-frontier' } } };
  yield { type: 'finish', reason: 'tool_calls' };
} };
const tool: ToolDefinition = {
  name: toolName, description: 'Private host callback fixture; no external operation is performed.', effectClass: 'unknown', inputSchema: { type: 'object' },
  async prepare(input) { return { name: toolName, input: input as { nonce: string }, requiresApproval: true, fingerprint: 'a'.repeat(64), preview: { scope: 'private-host-callback' } }; },
  async execute(_prepared, context) {
    appendFileSync(join(directory!, 'callback-entry.log'), 'actual-callback-entered\n', { mode: 0o600 });
    stop(context.toolCallId); return await new Promise<never>(() => {});
  },
};
const engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [provider], tools: remote ? [] : [tool],
  defaults: { providerId: provider.id, modelId: 'private-model', mode: 'build', limits: { maxContextBytes: 262144, maxOutputBytes: 32768, maxDurationMs: 60000, toolTimeoutMs: 60000 } } });
const now = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt: now });
for (const id of ['session', 'other-session', 'queued-session']) engine.store.createSession({ id, workspaceId: 'workspace', title: id, createdAt: now });
const commit = engine.store.commit.bind(engine.store);
engine.store.commit = (id, type, payload, changes) => {
  const event = commit(id, type, payload, changes);
  if (phase === 'requested' && type === 'tool.requested' || phase === 'running-intent' && type === 'tool.running') stop(String(payload.toolCallId));
  return event;
};
const putTurn = engine.store.putTurn.bind(engine.store);
engine.store.putTurn = turn => {
  const stored = putTurn(turn);
  if (phase === 'proposal-only' && turn.state === 'awaiting_tools') {
    const proposal = engine.store.listParts(turn.id).find(part => part.type === 'tool');
    if (!proposal || proposal.type !== 'tool') throw new Error('Native proposal was not persisted');
    stop(proposal.toolCallId);
  }
  return stored;
};
let rejectCredential = false;
if (remote) {
  if (!url) throw new Error('Private MCP frontier needs its loopback peer');
  const broker = new CredentialBroker({ async resolve() { if (rejectCredential) throw new Error('Private predispatch credential rejection'); return { bearerToken: 'private-frontier-token', expiresAt: Date.now() + 60000 }; } });
  const client = new McpClient({ id: 'frontier', transport: new HttpMcpTransport({ url, ...(phase === 'mcp-not-dispatched' ? { credential: { broker, reference: { id: 'host:private-frontier', audience: url } } } : {}) }), requestTimeoutMs: 5000 });
  await engine.connectMcp(client);
  const settle = engine.store.settleMcpExecution.bind(engine.store);
  engine.store.settleMcpExecution = (id, observation) => { const receipt = settle(id, observation); if (phase === `mcp-${receipt.state}`) stop(id); return receipt; };
  if (phase === 'mcp-not-dispatched') { rejectCredential = true; broker.clear(); }
}
runId = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'first', prompt: 'Explicit private generic callback goal.', config: engine.getCapabilities().defaults }).runId;
let approval: ReturnType<typeof engine.store.listPendingRunApprovals>[number] | undefined;
for (let index = 0; index < 20000 && !approval; index++) { approval = engine.store.listPendingRunApprovals(runId)[0]; if (!approval) await tick(); }
if (!approval) throw new Error('Private approval frontier was not reached');
if (phase === 'awaiting-approval') stop(approval.toolCallId);
engine.approvals.decide(approval.id, 'allow', approval.fingerprint);
await engine.waitForRun(runId); throw new Error('Unexpected completion before private frontier stop');
