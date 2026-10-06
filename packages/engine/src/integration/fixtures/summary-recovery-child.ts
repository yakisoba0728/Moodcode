import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EngineError } from '@moodcode/contracts';
import { createEngine } from '../../engine.js';
import type { ProviderAdapter, ProviderEvent } from '../../ports.js';

// Authored synthetic fixture. Only the parent-owned temporary process is stopped;
// no provider account, command tool, production database or remote API is used.
const [directory, phase] = process.argv.slice(2);
if (!directory || !['before-commit', 'after-commit'].includes(phase!)) throw new Error('Invalid summary recovery crash fixture');
const repository = join(directory, 'repository'); mkdirSync(repository);
const calls = join(directory, 'provider-calls.log'); let oldRunId = '';
const provider: ProviderAdapter = { id: 'summary-recovery-crash', streamTurn(request) {
  if (request.tools.length) return (async function* (): AsyncGenerator<ProviderEvent> {
    appendFileSync(calls, 'main\n', { mode: 0o600 }); yield { type: 'usage', inputTokens: 7, outputTokens: 2 };
    yield { type: 'text.delta', delta: request.runId === oldRunId ? 'SYNTHETIC_NONCE=0123456789abcdef0123456789abcdef\n' + 'Synthetic historical discussion. '.repeat(285) : 'Explicit new fixture work.' };
    yield { type: 'finish', reason: 'stop' };
  })();
  let index = 0;
  return { [Symbol.asyncIterator]() { return { async next(): Promise<IteratorResult<ProviderEvent>> {
    if (index++ === 0) { appendFileSync(calls, 'summary\n', { mode: 0o600 }); return { done: false, value: { type: 'usage', inputTokens: 9 } }; }
    if (index === 2) return { done: false, value: { type: 'text.delta', delta: 'Synthetic partial recovery observation.' } };
    throw new EngineError('PROVIDER_TRANSPORT_ERROR', 'Synthetic unknown cleanup');
  } }; } };
} };
const options = { dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [provider], allowedToolNames: ['read_file'],
  defaults: { providerId: provider.id, modelId: 'fixture-model', mode: 'plan' as const, limits: { maxContextBytes: 16_384, maxOutputBytes: 1_048_576 }, budgets: { maxSummaryCalls: 32, maxSummaryBytes: 65_536 } } };
let engine = createEngine(options); const now = new Date().toISOString();
engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt: now }); engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Recovery crash', createdAt: now });
engine.store.getSnapshot = () => { throw new Error('Summary recovery child forbids whole snapshots'); };
oldRunId = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'historical', prompt: 'Exact historical child goal.', config: engine.getCapabilities().defaults }).runId;
if ((await engine.waitForRun(oldRunId)).state !== 'completed') throw new Error('Historical child Run failed');
const runId = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'primary', prompt: 'Keep the current original recovery constraint authoritative. '.repeat(145), config: engine.getCapabilities().defaults }).runId;
if ((await engine.waitForRun(runId)).error?.code !== 'CLEANUP_UNCERTAIN') throw new Error('Child did not produce actual summary uncertainty');
await engine.waitForSession('session');
const summaryAttemptId = engine.listSummaryAttempts('session', { runId, limit: 1 }).attempts[0]!.id;
await engine.close(); engine = createEngine(options); engine.store.getSnapshot = () => { throw new Error('Restarted child forbids whole snapshots'); };
const preview = engine.getSummaryRecoveryPreview('session', summaryAttemptId);
if (preview.status !== 'eligible' || !preview.fingerprint) throw new Error('Restarted synthetic summary is not eligible');
const request = { sessionId: 'session', summaryAttemptId, requestId: 'crash-host-decision', fingerprint: preview.fingerprint, acknowledged: true as const };
let stopped = false;
function stop() {
  if (stopped) return; stopped = true;
  process.send?.({ phase, sessionId: 'session', runId, summaryAttemptId, request }); process.kill(process.pid, 'SIGSTOP');
}
if (phase === 'before-commit') {
  // Intercept only this fixture connection's real COMMIT, after an ACK row is
  // visible to its writer. A SIGKILL here exercises SQLite rollback of ledger
  // and both journals, rather than stopping before the transaction begins.
  const database = (engine.store as unknown as { db: DatabaseSync }).db, exec = database.exec.bind(database);
  database.exec = sql => {
    if (/^\s*COMMIT\s*;?\s*$/iu.test(sql) && database.isTransaction && Number(database.prepare('SELECT count(*) AS count FROM summary_recovery_acknowledgments').get()!.count) === 1) stop();
    return exec(sql);
  };
}
await engine.acknowledgeSummaryRecovery(request);
if (phase === 'after-commit') stop();
setInterval(() => { engine.store.getSession('session'); }, 1000);
