import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine } from '../../engine.js';
import type { ProviderAdapter, ProviderEvent } from '../../ports.js';

// This child is an authored synthetic engine fixture. It never contacts a provider
// account or executes a command tool. The parent kills only this temporary owner.
const [directory, phase] = process.argv.slice(2);
if (!directory || !['prepared', 'dispatched', 'provider-complete'].includes(phase!)) throw new Error('Invalid summary crash fixture');
const repository = join(directory, 'repository'); mkdirSync(repository);
for (let index = 0; index < 20; index++) writeFileSync(join(repository, `observed-${index}.txt`), index === 0 ? 'SYNTHETIC_NONCE=0123456789abcdef0123456789abcdef\n' : 'Synthetic historical observation. '.repeat(60));
const calls = join(directory, 'provider-calls.log'); let runId = '', stopped = false;
function stop(id: string) {
  if (stopped) return; stopped = true;
  process.send?.({ phase, sessionId: 'session', runId, summaryAttemptId: id });
  process.kill(process.pid, 'SIGSTOP');
}
const provider: ProviderAdapter = { id: 'summary-crash', async *streamTurn(request): AsyncGenerator<ProviderEvent> {
  if (!request.tools.length) {
    appendFileSync(calls, 'summary\n', { mode: 0o600 });
    const source = request.messages.findLast(message => message.role === 'user')!.content;
    const nonce = (JSON.parse(source) as { messages: { content: string }[] }).messages.map(message => message.content.match(/SYNTHETIC_NONCE=([a-f0-9]{32})/u)?.[1]).find(Boolean) ?? null;
    yield { type: 'progress', providerRequestId: 'synthetic-crash-summary' };
    yield { type: 'usage', inputTokens: 13, outputTokens: 0, cachedInputTokens: 0 };
    yield { type: 'text.delta', delta: JSON.stringify({ historicalNonce: nonce, currentFileEvidence: false }) };
    yield { type: 'usage', inputTokens: 17, outputTokens: 2 };
    yield { type: 'finish', reason: 'stop' }; return;
  }
  appendFileSync(calls, 'main\n', { mode: 0o600 });
  yield { type: 'usage', inputTokens: 7, outputTokens: 2 };
  if (request.turnIndex === 20) { yield { type: 'text.delta', delta: 'Done.' }; yield { type: 'finish', reason: 'stop' }; return; }
  yield { type: 'tool.call', call: { id: `observed-${request.turnIndex}`, name: 'read_file', input: { path: `observed-${request.turnIndex}.txt` } } };
  yield { type: 'finish', reason: 'tool_calls', replayItems: [{ type: 'reasoning', encrypted_content: `synthetic-private-replay-${request.turnIndex}` }] };
} };
const engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [provider], allowedToolNames: ['read_file'],
  defaults: { providerId: provider.id, modelId: 'fixture-model', mode: 'plan', limits: { maxTurns: 32, maxToolCalls: 24, maxContextBytes: 16_384, maxOutputBytes: 1_048_576 }, budgets: { turnAllowance: 32, maxSummaryCalls: 32, maxSummaryBytes: 65_536 } },
  activePrefixPolicy: { kind: 'active-prefix-semantic', version: 1, maxSourceMessages: 12, maxSourceBytes: 12_000, maxOutputBytes: 2048, keepRecentTurns: 4, maxCoveredMessages: 512 },
});
const createdAt = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt }); engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Summary crash fixture', createdAt });
engine.store.getSnapshot = () => { throw new Error('Summary child forbids whole session snapshots'); };
const create = engine.store.createSummaryAttempt.bind(engine.store);
engine.store.createSummaryAttempt = value => { const result = create(value); if (phase === 'prepared') stop(result.id); return result; };
const dispatch = engine.store.dispatchSummaryAttempt.bind(engine.store);
engine.store.dispatchSummaryAttempt = id => { const result = dispatch(id); if (phase === 'dispatched') stop(id); return result; };
const completed = engine.store.markSummaryProviderCompleted.bind(engine.store);
engine.store.markSummaryProviderCompleted = id => { const result = completed(id); if (phase === 'provider-complete') stop(id); return result; };
runId = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'primary', prompt: 'Exact original crash goal.', config: engine.getCapabilities().defaults }).runId;
setInterval(() => { engine.store.getSession('session'); }, 1000);
