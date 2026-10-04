import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineError, REASONING_EFFORTS } from './index.js';
import { normalizeSubmitInput, validateCommand } from './validation.js';

const command = (type: string, payload: unknown) => ({ schemaVersion: 1, commandId: 'next-stage-command', type, payload });
const input = { sessionId: 'session', requestId: 'request', prompt: 'Local fixture' };
const rejects = (type: string, payload: unknown, expectedPath?: string) => assert.throws(() => validateCommand(command(type, payload)), (error: unknown) => {
  assert.ok(error instanceof EngineError);
  assert.equal(error.code, 'INVALID_INPUT');
  if (expectedPath) assert.equal(error.details?.path, expectedPath);
  return true;
});

test('reasoning effort survives canonical copying, defaults and explicit overrides for every supported level', () => {
  for (const reasoningEffort of REASONING_EFFORTS) {
    const normalized = normalizeSubmitInput({ ...input, config: { reasoningEffort } });
    assert.equal(normalized.config.reasoningEffort, reasoningEffort);
    const validated = validateCommand(command('run.submit', { ...input, config: { reasoningEffort } }));
    assert.equal((validated.payload.config as Record<string, unknown>).reasoningEffort, reasoningEffort);
  }
  const defaults = { providerId: 'codex', modelId: 'gpt-fixture', reasoningEffort: 'ultra' as const };
  assert.equal(normalizeSubmitInput(input, defaults).config.reasoningEffort, 'ultra');
  assert.equal(normalizeSubmitInput({ ...input, config: { reasoningEffort: 'none' } }, defaults).config.reasoningEffort, 'none');
  assert.equal(Object.hasOwn(normalizeSubmitInput(input).config, 'reasoningEffort'), false);
  for (const reasoningEffort of [undefined, null, 'ULTRA', 'future', '', 'high\n', 1, [], {}]) rejects('run.submit', { ...input, config: { reasoningEffort } }, 'payload.config.reasoningEffort');
  let accessed = false;
  const config = Object.defineProperty({}, 'reasoningEffort', { enumerable: true, get() { accessed = true; return 'ultra'; } });
  rejects('run.submit', { ...input, config }, 'payload.config');
  assert.equal(accessed, false);
});

test('file.list accepts bounded opaque continuations and rejects invalid page size and UTF-8 overflow', () => {
  const payload = { workspaceId: 'workspace', path: '', limit: 1000, continuation: 'é'.repeat(1024) };
  const validated = validateCommand(command('file.list', payload));
  assert.deepEqual(validated.payload, payload);
  validated.payload.limit = 1;
  assert.equal(payload.limit, 1000);
  assert.deepEqual(validateCommand(command('file.list', { workspaceId: 'workspace' })).payload, { workspaceId: 'workspace' });
  for (const limit of [undefined, null, 0, -1, 1.1, 1001, Number.MAX_SAFE_INTEGER, '1']) rejects('file.list', { workspaceId: 'workspace', limit }, 'payload.limit');
  for (const continuation of [undefined, null, '', '\0', '\n', 1, {}, 'x'.repeat(2049), 'é'.repeat(1025)]) rejects('file.list', { workspaceId: 'workspace', continuation }, 'payload.continuation');
  rejects('file.list', { workspaceId: 'workspace', limit: 2, unknown: true }, 'payload');
});

test('history and metrics commands preserve only isolated bounded session/cursor/page inputs', () => {
  const payload = { sessionId: 'session', beforeRunId: 'run-older', limit: 50 };
  assert.deepEqual(validateCommand(command('session.getHistory', payload)).payload, payload);
  assert.deepEqual(validateCommand(command('session.getMetrics', { sessionId: 'session' })).payload, { sessionId: 'session' });
  for (const limit of [undefined, 0, -1, 1.5, 51, null, '20']) rejects('session.getHistory', { sessionId: 'session', limit }, 'payload.limit');
  for (const beforeRunId of [undefined, null, '', 'x'.repeat(257), 'bad\n', {}]) rejects('session.getHistory', { sessionId: 'session', beforeRunId }, 'payload.beforeRunId');
  for (const type of ['session.getHistory', 'session.getMetrics']) {
    rejects(type, {}, 'payload.sessionId');
    rejects(type, { sessionId: 'session', apiKey: 'synthetic-secret' }, 'payload');
  }
  rejects('session.getMetrics', { sessionId: 'session', limit: 1 }, 'payload');
});
