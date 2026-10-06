import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { providerHttpError, providerHttpFailure, providerRemoteError, publicError } from './helpers.js';
import { replayCompatible } from './replay.js';

test('bound replay permits one model/protocol, falls back on changes and rejects future or partial bindings', () => {
  const message = { role: 'assistant' as const, content: 'answer', providerReplay: { providerId: 'fixture', items: [], modelId: 'm1', protocol: 'responses', version: 1 } };
  assert.equal(replayCompatible(message, 'fixture', 'm1', 'responses'), true);
  assert.equal(replayCompatible(message, 'fixture', 'm2', 'responses'), false);
  assert.equal(replayCompatible(message, 'fixture', 'm1', 'other'), false);
  assert.equal(replayCompatible({ ...message, providerReplay: { providerId: 'fixture', items: [] } }, 'fixture', 'm1', 'responses'), true);
  for (const replay of [{ ...message.providerReplay, version: 2 }, { ...message.providerReplay, modelId: undefined }]) assert.throws(() => replayCompatible({ ...message, providerReplay: replay }, 'fixture', 'm1', 'responses'), (error: unknown) => error instanceof EngineError && error.code === 'PROVIDER_INVALID_REPLAY');
});

test('Retry-After survives as a bounded number without exposing response bodies or arbitrary header content', () => {
  const response = new Response('credential', { status: 429, headers: { 'retry-after': '0.025' } });
  assert.deepEqual(publicError(providerHttpError(response)).details, { status: 429, retryAfterMs: 25 });
  assert.equal(providerHttpError(new Response('', { status: 503, headers: { 'retry-after': '1000000' } })).details?.retryAfterMs, 60_000);
  assert.deepEqual(providerHttpError(new Response('', { status: 503, headers: { 'retry-after': 'private-token' } })).details, { status: 503 });
});
test('explicit HTTP or SSE context overflow has a fixed code and bounded private rejection-body inspection', async () => {
  const result = await providerHttpFailure(new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'private-server-value' } }), { status: 400 }), new AbortController().signal);
  assert.equal(result.code, 'PROVIDER_CONTEXT_OVERFLOW'); assert.equal(JSON.stringify(result).includes('private-server-value'), false);
  assert.equal(publicError(providerRemoteError({ code: 'context_window_exceeded', message: 'private' })).code, 'PROVIDER_CONTEXT_OVERFLOW');
  const unknown = await providerHttpFailure(new Response(JSON.stringify({ error: { code: 'unknown', message: 'private' } }), { status: 400 }), new AbortController().signal);
  assert.equal(unknown.code, 'PROVIDER_HTTP_ERROR');
  const large = await providerHttpFailure(new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'x'.repeat(8192) } }), { status: 400 }), new AbortController().signal);
  assert.equal(large.code, 'PROVIDER_HTTP_ERROR');
});
