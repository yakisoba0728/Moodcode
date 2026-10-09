import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { isTerminal, type CommandResult, type Session, type SessionSnapshot, type Workspace } from '@moodcode/contracts';
import { MainCredentialBroker, WorkerCredentialClient, CREDENTIAL_LIMITS, retainSecrets } from './credential-broker.js';
import { attachUtilityWorker, type UtilityPort } from './runtime.js';
import { DesktopHost, type UtilityTransport } from '../main/host.js';
import type { CodexCredential, WorkerCredentialRequest, WorkerPush, WorkerResponse } from './protocol.js';

const credential = (revision = 1): CodexCredential => ({ accessToken: `fixture-broker-access-${revision}`, accountId: 'fixture-broker-native-id', secrets: [`fixture-broker-refresh-${revision}`] });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function pair(resolve: (signal: AbortSignal) => Promise<CodexCredential>, valid = () => true) {
  const replies: unknown[] = [];
  const broker = new MainCredentialBroker({ resolve, valid, post: reply => { replies.push(reply); client.receive(structuredClone(reply)); } });
  const client = new WorkerCredentialClient(request => { broker.receive(structuredClone(request)); });
  return { broker, client, replies };
}

test('concurrent turns share one rotation; one cancellation does not abort the other and the next turn opens a new flight', async () => {
  const held = gate<CodexCredential>(); let calls = 0, rotating: AbortSignal | undefined;
  const p = pair(async signal => { calls++; rotating = signal; return calls === 1 ? held.promise : credential(2); });
  const first = new AbortController(), second = new AbortController();
  const cancelled = p.client.request(first.signal); const cancelledCheck = assert.rejects(cancelled, { code: 'PROVIDER_CANCELLED' });
  const continuing = p.client.request(second.signal); await delay(0); first.abort(); await cancelledCheck;
  assert.equal(calls, 1); assert.equal(rotating?.aborted, false);
  held.resolve(credential()); assert.equal((await continuing).accessToken, credential().accessToken);
  assert.equal((await p.client.request(second.signal)).accessToken, credential(2).accessToken); assert.equal(calls, 2);
  assert.equal(p.replies.filter((reply: any) => reply.ok).length, 2); p.client.close(); p.broker.close();
});

for (const boundary of ['last-cancel', 'close', 'account-change'] as const) test(`${boundary} cannot expose a late credential`, async () => {
  const held = gate<CodexCredential>(); let rotating: AbortSignal | undefined, valid = true;
  const p = pair(async signal => { rotating = signal; return held.promise; }, () => valid);
  const controller = new AbortController(), pending = p.client.request(controller.signal);
  const rejected = assert.rejects(pending, boundary === 'account-change' ? { code: 'ACCOUNT_REAUTH_REQUIRED' } : { code: 'PROVIDER_CANCELLED' });
  await delay(0);
  if (boundary === 'last-cancel') controller.abort();
  if (boundary === 'close') { p.client.close(); p.broker.close(); }
  if (boundary === 'account-change') valid = false;
  held.resolve(credential()); await rejected; await delay(0);
  if (boundary !== 'account-change') assert.equal(rotating?.aborted, true);
  assert.equal(p.replies.some((reply: any) => reply.ok === true), false); p.client.close(); p.broker.close();
});

test('private channel rejects unsafe replies, bounds waiters/history and times out without retry', async () => {
  const sent: WorkerCredentialRequest[] = [], client = new WorkerCredentialClient(request => sent.push(request), 20);
  const controller = new AbortController();
  const invalid = client.request(controller.signal), rejected = assert.rejects(invalid, { code: 'ACCOUNT_REAUTH_REQUIRED' });
  client.receive({ type: 'codex-credential-result', id: sent[0]!.id, ok: true, credential: { ...credential(), accessToken: 'fixture\r\ninjected' } }); await rejected;
  const pending = client.request(controller.signal); await assert.rejects(pending, { code: 'PROVIDER_CANCELLED' });
  assert.equal(sent.filter(value => value.type === 'codex-credential').length, 2); assert.equal(sent.at(-1)?.type, 'codex-credential-cancel');
  assert.throws(() => retainSecrets(Array.from({ length: CREDENTIAL_LIMITS.retainedSecrets }, (_, n) => `fixture-history-${n}`), credential()), { code: 'ACCOUNT_REAUTH_REQUIRED' });
  const held = gate<CodexCredential>(), p = pair(() => held.promise);
  const waits = Array.from({ length: CREDENTIAL_LIMITS.pending }, () => p.client.request(controller.signal));
  const results = Promise.allSettled(waits); await assert.rejects(p.client.request(controller.signal), { code: 'ACCOUNT_REAUTH_REQUIRED' });
  p.client.close(); p.broker.close(); held.resolve(credential()); assert.equal((await results).every(value => value.status === 'rejected'), true); client.close();
});

async function nativeFixture(t: TestContext, unauthorized = false) {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-codex-broker-native-')), repository = join(directory, 'repository');
  await mkdir(repository); execFileSync('git', ['init', '-q', repository]);
  const native = globalThis.fetch, requests: string[] = [], privateMessages: unknown[] = [], publicMessages: unknown[] = [];
  const server = createServer((request, response) => {
    requests.push(request.headers.authorization ?? ''); request.resume();
    response.writeHead(unauthorized ? 401 : 200, { 'content-type': unauthorized ? 'application/json' : 'text/event-stream' });
    const id = `fixture-message-${requests.length}`, responseId = `fixture-response-${requests.length}`;
    const message = { id, type: 'message', status: 'completed', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'fixture completed' }] };
    const events = [
      { type: 'response.created', response: { id: responseId, status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: id, output_index: 0, content_index: 0, delta: 'fixture completed' },
      { type: 'response.output_text.done', item_id: id, output_index: 0, content_index: 0, text: 'fixture completed' },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: responseId, status: 'completed', output: [message], usage: { input_tokens: 3, output_tokens: 2 } } },
    ];
    response.end(unauthorized ? JSON.stringify({ error: { message: `${credential(2).accessToken} ${credential(2).secrets[0]}` } })
      : events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  globalThis.fetch = (input, init) => { assert.equal(String(input), 'https://chatgpt.com/backend-api/codex/responses'); return native(`http://127.0.0.1:${address.port}/responses`, init); };
  const parent = new EventEmitter(), lifecycle = new EventEmitter() as EventEmitter & { exit(code?: number): void };
  lifecycle.exit = code => { parent.emit('exit', code ?? 0); };
  class Port extends EventEmitter implements UtilityPort {
    postMessage(message: WorkerResponse | WorkerPush | WorkerCredentialRequest): void {
      if ('type' in message && message.type.startsWith('codex-credential')) privateMessages.push(message); else publicMessages.push(message);
      queueMicrotask(() => parent.emit('message', structuredClone(message)));
    }
  }
  const port = new Port(), runtime = attachUtilityWorker(port, lifecycle);
  const transport: UtilityTransport = {
    postMessage(message) { if (message.type === 'codex-credential-result') privateMessages.push(message); queueMicrotask(() => port.emit('message', { data: structuredClone(message) })); },
    onMessage(listener) { parent.on('message', listener); return () => { parent.off('message', listener); }; },
    onExit(listener) { parent.on('exit', listener); return () => { parent.off('exit', listener); }; },
  };
  const accountId = randomUUID(), view = { providerId: 'codex' as const, modelId: 'fixture-broker-model', baseURL: '', credentialMode: 'chatgpt' as const,
    accountId, keyConfigured: true, keySource: 'chatgpt' as const, credentialStorage: 'available' as const };
  let revision = 2, resolutions = 0;
  const host = new DesktopHost({ spawn: () => transport, settings: { getView: () => view, load: async () => ({ view, engineConfig: { providerId: 'codex', modelId: view.modelId, baseURL: '', codexCredential: credential() } }), prepare() { throw new Error('Unexpected save'); }, commit() { throw new Error('Unexpected save'); } },
    dbPath: join(directory, 'state.sqlite'), artifactDir: join(directory, 'artifacts'), platform: process.platform, version: 'fixture',
    resolveCodexCredential: async (selected, model, signal) => { assert.equal(selected, accountId); assert.equal(model, view.modelId); assert.equal(signal.aborted, false); resolutions++; return credential(revision); } });
  t.after(async () => { try { await host.close(); await runtime.shutdown(); } finally { globalThis.fetch = native; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
  assert.equal((await host.initialize()).state, 'ready');
  async function command<T>(type: string, payload: Record<string, unknown>): Promise<T> {
    const result = await host.command({ schemaVersion: 1, commandId: randomUUID(), type, payload } as any) as CommandResult;
    assert.equal(result.ok, true, JSON.stringify(result)); return result.result as T;
  }
  const workspace = await command<Workspace>('workspace.open', { path: repository }), session = await command<Session>('session.create', { workspaceId: workspace.id });
  async function submit() {
    const receipt = await command<{ runId: string }>('run.submit', { sessionId: session.id, requestId: randomUUID(), prompt: 'fixture native request', config: { mode: 'plan' } });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const snapshot = await command<SessionSnapshot>('session.getSnapshot', { sessionId: session.id });
      const run = snapshot.runs.find(run => run.id === receipt.runId); if (run && isTerminal(run.state)) return { run, snapshot }; await delay(10);
    }
    assert.fail('Native fixture Run did not settle.');
  }
  return { host, directory, requests, privateMessages, publicMessages, submit, advance: () => { revision++; }, resolutions: () => resolutions };
}

test('actual SQLite worker requests fresh Main credentials on each native HTTP turn without restarting or journaling secrets', async t => {
  const f = await nativeFixture(t);
  assert.equal((await f.submit()).run.state, 'completed'); f.advance(); const next = await f.submit(); assert.equal(next.run.state, 'completed');
  assert.deepEqual(f.requests, [`Bearer ${credential(2).accessToken}`, `Bearer ${credential(3).accessToken}`]); assert.equal(f.resolutions(), 2);
  assert.equal(f.host.getStatus().generation, 1); assert.equal(f.privateMessages.filter((message: any) => message.type === 'codex-credential-result' && message.ok).length, 2);
  for (const secret of [credential().accessToken, credential(2).accessToken, credential(3).accessToken, credential(2).secrets[0]!, credential().accountId]) {
    assert.ok(!JSON.stringify(f.publicMessages).includes(secret)); assert.ok(!JSON.stringify(next.snapshot).includes(secret));
  }
  await f.host.close(); const original = await readFile(join(f.directory, 'state.sqlite'));
  assert.equal(original.includes(Buffer.from(credential(2).accessToken)), false); assert.equal(original.includes(Buffer.from(credential(3).accessToken)), false);
});

test('actual native HTTP401 is redacted and never causes credential/request replay', async t => {
  const f = await nativeFixture(t, true), result = await f.submit(); assert.equal(result.run.state, 'failed');
  assert.equal(f.requests.length, 1); assert.equal(f.resolutions(), 1);
  for (const secret of [credential(2).accessToken, ...credential(2).secrets]) assert.ok(!JSON.stringify(result.snapshot).includes(secret));
});
