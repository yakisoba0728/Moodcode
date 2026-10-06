import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ProviderAdapter, ToolDefinition } from '../ports.js';
import { SqliteStore } from './index.js';

type Phase = 'admission' | 'promotion' | 'prepared' | 'dispatch' | 'settlement-before' | 'settlement-after';
interface Ready { phase: Phase; sessionId: string; inputId: string; runId?: string }
const count = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0;
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
async function launch(t: TestContext, directory: string, phase: Phase) {
  const source = import.meta.url.endsWith('.ts'), path = fileURLToPath(new URL(`./fixtures/native-crash-child.${source ? 'ts' : 'js'}`, import.meta.url));
  const child = spawn(process.execPath, [...(source ? ['--import', 'tsx'] : []), path, directory, phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = ''; child.stderr?.on('data', value => { diagnostics = (diagnostics + String(value)).slice(-8192); });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const ready = await new Promise<Ready>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Native fixture did not reach ${phase}: ${diagnostics}`)), 12_000);
    child.once('message', message => { clearTimeout(timer); resolve(message as Ready); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Native fixture exited before ${phase}: ${diagnostics}`)); });
  });
  assert.equal(ready.phase, phase); assert.equal(ready.sessionId, 'native-session');
  return { child, ready, exited };
}

for (const phase of ['admission', 'promotion', 'prepared', 'dispatch', 'settlement-before', 'settlement-after'] as const) {
  test(`SIGKILL at native ${phase} preserves identity/recovery and performs zero automatic dispatch/effects after reopen`, { skip: process.platform === 'win32' }, async t => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), `moodcode-native-crash-${phase}-`))), dbPath = join(directory, 'engine.sqlite');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const { child, ready, exited } = await launch(t, directory, phase);
    assert.throws(() => new SqliteStore(dbPath), code('DB_LOCKED'), 'The stopped owner retains its actual SQLite lease');
    child.kill('SIGKILL'); await exited;
    const before = new SqliteStore(dbPath);
    const originalInput = before.getInput(ready.inputId), originalLegacy = before.readEvents(ready.sessionId, 0, 1024), originalNative = before.readSessionEvents(ready.sessionId, 0);
    const originalTurns = ready.runId ? before.listTurns(ready.runId) : [], originalTools = before.getSnapshot(ready.sessionId).tools;
    assert.equal(originalInput.state, phase === 'admission' ? 'pending' : 'promoted');
    if (phase === 'admission') assert.deepEqual(before.getSnapshot(ready.sessionId).runs, []);
    if (phase === 'prepared') assert.equal(originalNative.at(-1)?.type, 'provider.attempt.prepared');
    if (phase === 'dispatch') assert.equal(originalNative.at(-1)?.type, 'provider.attempt.dispatched');
    if (phase.startsWith('settlement')) {
      assert.equal(originalTurns.length, 2); assert.ok(originalTurns.every(turn => turn.state === 'completed'));
      assert.equal(before.getRun(ready.runId!).state, phase === 'settlement-after' ? 'completed' : 'running');
    }
    before.close();
    const providerPath = join(directory, 'provider-calls.log'), effectPath = join(directory, 'tool-effects.log'), providerCount = count(providerPath), effectCount = count(effectPath);
    assert.equal(providerCount, phase.startsWith('settlement') ? 2 : phase === 'dispatch' ? 1 : 0);
    assert.equal(effectCount, phase.startsWith('settlement') ? 1 : 0, JSON.stringify(originalTools));
    const provider: ProviderAdapter = { id: 'crash-fixture', async *streamTurn() { appendFileSync(providerPath, 'UNEXPECTED\n'); yield { type: 'finish', reason: 'stop' }; } };
    const tool: ToolDefinition = { name: 'counter_fixture', description: 'fixture', effectClass: 'write', inputSchema: { type: 'object' },
      async prepare() { return { name: 'counter_fixture', input: {}, fingerprint: 'fixture-counter', requiresApproval: false, preview: {} }; },
      async execute() { appendFileSync(effectPath, 'UNEXPECTED\n'); return { content: 'unexpected' }; } };
    const engine = createEngine({ dbPath, providers: [provider], tools: [tool], defaults: { providerId: provider.id, modelId: 'fixture', mode: 'build' }, toolPolicy: [{ tool: tool.name, decision: 'allow' }] });
    t.after(() => engine.close());
    for (let index = 0; index < 5; index++) await tick();
    await engine.waitForSession(ready.sessionId);
    assert.equal(count(providerPath), providerCount); assert.equal(count(effectPath), effectCount);
    assert.equal(engine.store.getInput(ready.inputId).id, originalInput.id);
    assert.deepEqual(engine.store.readEvents(ready.sessionId, 0, 1024).slice(0, originalLegacy.length), originalLegacy);
    assert.deepEqual(engine.store.readSessionEvents(ready.sessionId, 0).slice(0, originalNative.length), originalNative);
    if (ready.runId && phase !== 'settlement-after') {
      assert.equal(engine.store.getRun(ready.runId).state, 'interrupted');
      assert.equal(engine.store.getSessionControl(ready.sessionId).paused, true);
      assert.equal(engine.store.getSessionControl(ready.sessionId).reason, 'recovery_required');
    }
    if (phase === 'prepared' || phase === 'dispatch') {
      const turn = engine.store.getTurn(originalTurns[0]!.id);
      assert.equal(turn.state, phase === 'dispatch' ? 'uncertain' : 'interrupted');
      const event = originalNative.find(event => event.type === `provider.attempt.${phase === 'prepared' ? 'prepared' : 'dispatched'}`)!;
      assert.equal(engine.store.getAttempt(event.attemptId!).state, phase === 'dispatch' ? 'uncertain' : 'interrupted');
    }
    if (phase.startsWith('settlement')) {
      assert.deepEqual(engine.store.listTurns(ready.runId!), originalTurns, 'Settled Turns cannot be rewritten or redispatched');
      assert.equal(engine.store.pendingInputs(ready.sessionId)[0]?.requestId, 'later');
    }
    await engine.close();
    const successor = new SqliteStore(dbPath); successor.close();
  });
}
