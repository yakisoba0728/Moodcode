import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine } from '../../engine.js';
import type { ProviderAdapter, ToolDefinition } from '../../ports.js';

const [directory, phase] = process.argv.slice(2);
if (!directory || !['admission', 'promotion', 'prepared', 'dispatch', 'settlement-before', 'settlement-after'].includes(phase!)) throw new Error('Invalid native crash fixture');
const providerLog = join(directory, 'provider-calls.log'), effectsLog = join(directory, 'tool-effects.log');
let stopped = false, inputId = '';
function stop(): void {
  if (stopped) return; stopped = true;
  const input = engine.store.getInput(inputId);
  process.send?.({ phase, sessionId: 'native-session', inputId, ...(input.runId ? { runId: input.runId } : {}) });
  process.kill(process.pid, 'SIGSTOP');
}
const provider: ProviderAdapter = { id: 'crash-fixture', async *streamTurn(request) {
  appendFileSync(providerLog, 'call\n', { mode: 0o600 });
  if (phase === 'dispatch') stop();
  if (request.turnIndex === 0) {
    yield { type: 'tool.call', call: { id: 'fixture-provider-call', name: 'counter_fixture', input: {} } };
    yield { type: 'finish', reason: 'tool_calls' };
  } else { yield { type: 'text.delta', delta: 'durable reply' }; yield { type: 'finish', reason: 'stop' }; }
} };
const tool: ToolDefinition = { name: 'counter_fixture', description: 'Local fixture counter only', effectClass: 'write', inputSchema: { type: 'object' },
  async prepare() { return { name: 'counter_fixture', input: {}, fingerprint: 'fixture-counter', requiresApproval: false, preview: {} }; },
  async execute() { appendFileSync(effectsLog, 'effect\n', { mode: 0o600 }); return { content: 'fixture effect committed' }; } };
const engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), providers: [provider], tools: [tool], defaults: { providerId: provider.id, modelId: 'fixture', mode: 'build' }, toolPolicy: [{ tool: tool.name, decision: 'allow' }] });
const now = new Date().toISOString();
engine.store.putWorkspace({ id: 'native-workspace', root: directory, gitRoot: directory, branch: null, createdAt: now });
engine.store.createSession({ id: 'native-session', workspaceId: 'native-workspace', title: 'Native crash fixture', createdAt: now });
const promote = engine.store.promoteInput.bind(engine.store);
engine.store.promoteInput = (id, runId) => { const result = promote(id, runId); if (phase === 'promotion') stop(); return result; };
const attempt = engine.store.putAttempt.bind(engine.store);
engine.store.putAttempt = value => { const result = attempt(value); if (phase === 'prepared' && result.state === 'prepared') stop(); return result; };
const commit = engine.store.commit.bind(engine.store);
engine.store.commit = (runId, type, payload, change) => {
  if (phase === 'settlement-before' && type === 'run.completed') stop();
  const result = commit(runId, type, payload, change);
  if (phase === 'settlement-after' && type === 'run.completed') stop();
  return result;
};
const config = engine.getCapabilities().defaults;
inputId = engine.scheduler.accept({ sessionId: 'native-session', requestId: 'first', prompt: 'Exercise only the fixture counter', delivery: 'queue', config }).inputId;
if (phase === 'admission') stop();
// A second durable pending input checks that restart does not auto-continue the queue.
if (phase!.startsWith('settlement')) engine.scheduler.accept({ sessionId: 'native-session', requestId: 'later', prompt: 'Do not auto-run after restart', delivery: 'queue', config });
setInterval(() => { engine.store.getSession('native-session'); }, 1000);
