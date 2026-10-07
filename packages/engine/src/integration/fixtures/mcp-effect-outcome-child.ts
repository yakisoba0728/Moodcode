import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { createEngine } from '../../engine.js';
import { HttpMcpTransport, McpClient } from '../../mcp/index.js';
import type { ProviderAdapter } from '../../ports.js';
import { SqliteStore } from '../../storage/index.js';

// The loopback peer lives in the parent test process. SIGKILL therefore cannot
// be mistaken for confirmation that an already accepted remote effect stopped.
const [directory, url, phase] = process.argv.slice(2);
if (!directory || !url || !['dispatch-intent', 'peer-accepted'].includes(phase!)) throw new Error('Invalid private MCP crash phase');
SqliteStore.prototype.getSnapshot = () => { throw new Error('Private MCP crash worker forbids snapshots'); };
const repository = join(directory, 'repository'); mkdirSync(repository);
let runId = '', attempted = false;
const provider: ProviderAdapter = { id: 'mcp-crash-fixture', async *streamTurn() {
  appendFileSync(join(directory!, 'provider-calls.log'), 'provider-dispatch\n', { mode: 0o600 });
  yield { type: 'usage', inputTokens: 11, outputTokens: 4, cachedInputTokens: 2, reasoningOutputTokens: 1 };
  yield { type: 'text.delta', delta: 'Private precrash public text.' };
  yield { type: 'tool.call', call: { id: 'private-crash-call', name: 'mcp_crash_observe', input: { marker: 'private-crash-approved' } } };
  yield { type: 'finish', reason: 'tool_calls' };
} };
const engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [provider], tools: [],
  defaults: { providerId: provider.id, modelId: 'private-model', mode: 'build', limits: { maxContextBytes: 262144, maxOutputBytes: 32768, maxDurationMs: 60000, toolTimeoutMs: 60000 } } });
const now = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt: now });
engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Private remote crash', createdAt: now });
function stop() {
  if (attempted) return; attempted = true;
  process.send?.({ kind: 'stopped', phase, runId }); process.kill(process.pid, 'SIGSTOP');
}
if (phase === 'dispatch-intent') {
  const original = engine.store.dispatchMcpExecution.bind(engine.store);
  engine.store.dispatchMcpExecution = (id, boundary) => { const record = original(id, boundary); stop(); return record; };
} else process.on('message', message => { if ((message as { kind?: string }).kind === 'peer-accepted') stop(); });
const client = new McpClient({ id: 'crash', transport: new HttpMcpTransport({ url }), requestTimeoutMs: 60000 });
await engine.connectMcp(client);
runId = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'first', prompt: 'Private approved remote crash goal.', config: engine.getCapabilities().defaults }).runId;
let approval: ReturnType<typeof engine.store.listPendingRunApprovals>[number] | undefined;
for (let index = 0; index < 20000 && !approval; index++) { approval = engine.store.listPendingRunApprovals(runId)[0]; if (!approval) await tick(); }
if (!approval) throw new Error('Private worker never reached actual outer approval');
engine.approvals.decide(approval.id, 'allow', approval.fingerprint);
await engine.waitForRun(runId);
throw new Error('Private worker unexpectedly reached a terminal Run before its selected stop boundary');
