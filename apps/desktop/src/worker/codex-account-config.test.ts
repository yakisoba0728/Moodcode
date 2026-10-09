import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { CodexProvider, type EngineOptions, type MoodcodeEngine } from '@moodcode/engine';
import { UtilityWorker } from './core.js';

const credential = { accessToken: 'fixture-worker-codex-access', accountId: 'fixture-worker-native-account', secrets: ['fixture-worker-refresh', 'fixture-worker-id-token'] };
const valid = { providerId: 'codex', modelId: 'fixture-codex-model', baseURL: '', codexCredential: credential };
const start = (config: unknown) => ({ id: randomUUID(), type: 'start', payload: { dbPath: ':memory:', artifactDir: resolve('fixture-artifacts'), config } });
const fakeEngine = () => ({ store: { listWorkspaces: () => [] }, dispatch: async () => ({ ok: true, result: {} }), async *subscribe() {}, close: async () => {} }) as unknown as MoodcodeEngine;

test('app account credentials select the native Codex adapter without local auth reads', async t => {
  const original = globalThis.fetch;
  const calls: { url: string; authorization: string | null; account: string | null }[] = [];
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), authorization: headers.get('authorization'), account: headers.get('chatgpt-account-id') });
    return new Response('data: {"type":"response.created","response":{"id":"fixture-response","status":"in_progress"}}\n\ndata: {"type":"response.completed","response":{"id":"fixture-response","status":"completed","output":[]}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  t.after(() => { globalThis.fetch = original; });
  let created: EngineOptions | undefined;
  const worker = new UtilityWorker({ emit() {}, createEngine(options) { created = options; return fakeEngine(); } });
  t.after(() => worker.close());
  assert.equal((await worker.handle(start(valid))).ok, true);
  const provider = created?.providers?.[0];
  assert.ok(provider instanceof CodexProvider);
  const events = [];
  for await (const event of provider.streamTurn({ runId: 'fixture-run', turnIndex: 0, modelId: valid.modelId, messages: [{ role: 'user', content: 'fixture' }], tools: [] }, new AbortController().signal)) events.push(event);
  assert.deepEqual(calls, [{ url: 'https://chatgpt.com/backend-api/codex/responses', authorization: `Bearer ${credential.accessToken}`, account: credential.accountId }]);
  for (const secret of [credential.accessToken, credential.accountId, ...credential.secrets]) assert.ok(!JSON.stringify(events).includes(secret));
});

test('worker rejects account credentials on other providers, unsafe headers and metadata before engine creation', async () => {
  let creates = 0;
  for (const config of [
    { ...valid, providerId: 'openai-responses', baseURL: 'https://api.openai.com/v1', apiKey: 'fixture-api-key' },
    { ...valid, providerId: 'scripted' },
    { ...valid, baseURL: 'https://example.test' },
    { ...valid, apiKey: 'fixture-api-key' },
    { ...valid, codexCredential: { ...credential, accessToken: credential.accessToken + '\r\nx-injected: yes' } },
    { ...valid, codexCredential: { ...credential, accountId: '' } },
    { ...valid, codexCredential: { ...credential, secrets: [''] } },
    { ...valid, codexCredential: { ...credential, endpoint: 'https://example.test' } },
    { ...valid, modelId: credential.secrets[0] },
  ]) {
    const worker = new UtilityWorker({ emit() {}, createEngine() { creates++; throw new Error('Unexpected engine creation'); } });
    const response = await worker.handle(start(config));
    assert.equal(response.ok, false);
    for (const secret of [credential.accessToken, credential.accountId, ...credential.secrets]) assert.ok(!JSON.stringify(response).includes(secret));
    await worker.close();
  }
  assert.equal(creates, 0);
});

test('worker removes account identity and every OAuth token from engine failures', async t => {
  const secrets = [credential.accessToken, credential.accountId, ...credential.secrets];
  const worker = new UtilityWorker({ emit() {}, createEngine() { throw new EngineError('FIXTURE_ERROR', secrets.join(' ')); } });
  t.after(() => worker.close());
  const response = await worker.handle(start(valid));
  assert.equal(response.ok, false);
  if (response.ok) assert.fail('Expected a fixture error');
  assert.equal(response.error.code, 'FIXTURE_ERROR');
  for (const secret of secrets) assert.ok(!JSON.stringify(response).includes(secret));
});
