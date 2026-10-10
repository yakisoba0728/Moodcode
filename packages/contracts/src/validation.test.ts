import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LIMITS, EngineError } from './index.js';
import type { RunLimits } from './index.js';
import { normalizeRunConfig, normalizeSubmitInput, validateCommand } from './validation.js';

const submit = { sessionId: 'session-1', requestId: 'request-1', prompt: '  Explain this code.\n' };
const envelope = (type: string, payload: unknown) => ({ schemaVersion: 1, commandId: 'command-1', type, payload });

function rejects(action: () => unknown, code = 'INVALID_INPUT', path?: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, code);
    if (path) assert.equal(error.details?.path, path);
    return true;
  });
}

test('missing run config receives deterministic defaults without changing prompt whitespace', () => {
  const normalized = normalizeSubmitInput(submit);
  assert.deepEqual(normalized, {
    ...submit,
    config: { providerId: 'scripted', modelId: 'local', mode: 'plan', limits: { ...DEFAULT_LIMITS } },
  });
  assert.notEqual(normalized, submit);
  assert.notEqual(normalized.config.limits, DEFAULT_LIMITS);
  normalized.config.limits.maxTurns = 2;
  assert.equal(DEFAULT_LIMITS.maxTurns, 12);
  assert.equal(normalizeSubmitInput(submit).config.limits.maxTurns, 12);
});

test('partial configuration and budgets merge defaults into independent canonical copies', () => {
  const input = { ...submit, config: { providerId: 'fixture', modelId: 'model-2', mode: 'build', limits: { maxTurns: 3, maxDurationMs: 10 } } };
  const actual = normalizeSubmitInput(input);
  assert.deepEqual(actual.config, {
    providerId: 'fixture', modelId: 'model-2', mode: 'build',
    limits: { ...DEFAULT_LIMITS, maxTurns: 3, maxDurationMs: 10 },
  });
  input.config.limits.maxTurns = 9;
  assert.equal(actual.config.limits.maxTurns, 3);
  assert.deepEqual(normalizeSubmitInput(submit), normalizeSubmitInput({ ...submit, config: {} }));
  assert.deepEqual(normalizeSubmitInput(submit), normalizeSubmitInput({ ...submit, config: { limits: {} } }));
  const explicit = normalizeSubmitInput({ ...submit, config: {
    limits: { maxContextBytes: DEFAULT_LIMITS.maxContextBytes, maxTurns: DEFAULT_LIMITS.maxTurns },
    mode: 'plan', modelId: 'local', providerId: 'scripted',
  } });
  assert.equal(JSON.stringify(explicit), JSON.stringify(normalizeSubmitInput(submit)));
});

test('all supported command payloads validate and normalize', () => {
  const cases: [string, Record<string, unknown>, Record<string, unknown>?][] = [
    ['workspace.open', { path: '/tmp/project' }],
    ['session.create', { workspaceId: 'workspace-1' }],
    ['session.create', { workspaceId: 'workspace-1', title: '테스트' }],
    ['session.list', { workspaceId: 'workspace-1' }],
    ['session.getSnapshot', { sessionId: 'session-1' }],
    ['run.submit', submit, { ...normalizeSubmitInput(submit) }],
    ['run.cancel', { runId: 'run-1' }],
    ['approval.decide', { approvalId: 'approval-1', decision: 'allow', fingerprint: 'sha256-preview' }],
    ['approval.decide', { approvalId: 'approval-1', decision: 'deny', fingerprint: 'sha256-preview' }],
    ['review.getDiff', { runId: 'run-1' }],
    ['events.subscribe', { sessionId: 'session-1' }, { sessionId: 'session-1', afterSeq: 0 }],
    ['events.subscribe', { sessionId: 'session-1', afterSeq: 5 }],
  ];
  for (const [type, payload, normalized] of cases) {
    const actual = validateCommand(envelope(type, payload));
    assert.deepEqual(actual, envelope(type, normalized ?? payload));
    assert.notEqual(actual.payload, payload);
  }
});

test('unknown commands and schema versions produce explicit errors without input values', () => {
  rejects(() => validateCommand(envelope('unsupported', {})), 'UNKNOWN_COMMAND', 'command.type');
  for (const schemaVersion of [0, 2, '1', undefined, null, NaN]) {
    rejects(() => validateCommand({ ...envelope('session.list', { workspaceId: 'w' }), schemaVersion }), 'UNSUPPORTED_SCHEMA_VERSION', 'command.schemaVersion');
  }
});

test('envelopes reject non-JSON objects, malformed IDs, missing and unknown fields', () => {
  for (const value of [undefined, null, [], 'json text', 1, true, new Date(), new Map()]) {
    rejects(() => validateCommand(value));
  }
  const valid = envelope('session.list', { workspaceId: 'w' });
  rejects(() => validateCommand({ ...valid, apiKey: 'credential-should-never-appear' }));
  rejects(() => validateCommand({ ...valid, commandId: '' }));
  rejects(() => validateCommand({ ...valid, commandId: 5 }));
  rejects(() => validateCommand({ ...valid, commandId: 'x'.repeat(257) }));
  rejects(() => validateCommand({ ...valid, commandId: 'line\nbreak' }));
  rejects(() => validateCommand({ ...valid, type: null }));
  rejects(() => validateCommand({ ...valid, payload: undefined }));
  rejects(() => validateCommand({ ...valid, payload: [] }));
  rejects(() => validateCommand({ ...valid, payload: {} }));
  rejects(() => validateCommand({ ...valid, payload: { workspaceId: 'w', cursor: 'unsupported' } }));
  const nullPrototype = Object.assign(Object.create(null), valid);
  assert.deepEqual(validateCommand(nullPrototype), valid);
});

test('JSON data validation never executes getters or accepts symbols, inherited or hidden fields', () => {
  let accessed = false;
  const payload = Object.defineProperty({}, 'sessionId', { enumerable: true, get() { accessed = true; return 's'; } });
  rejects(() => normalizeSubmitInput({ ...submit, ...{ config: payload } }));
  rejects(() => normalizeSubmitInput(payload));
  assert.equal(accessed, false);
  rejects(() => normalizeSubmitInput(Object.create(submit)));
  rejects(() => normalizeSubmitInput(Object.defineProperty({ ...submit }, 'config', { value: {}, enumerable: false })));
  rejects(() => normalizeSubmitInput({ ...submit, [Symbol('secret')]: 'value' }));
  rejects(() => normalizeSubmitInput(JSON.parse('{"sessionId":"s","requestId":"r","prompt":"p","__proto__":{}}')));
});

test('non-JSON reflection failures use EngineError without exposing native exception messages', () => {
  const revocable = Proxy.revocable({ ...submit }, {});
  revocable.revoke();
  rejects(() => normalizeSubmitInput(revocable.proxy));
  const value = new Proxy({ ...submit }, { getPrototypeOf() { throw new Error('private-reflection-error-value'); } });
  assert.throws(() => normalizeSubmitInput(value), (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, 'INVALID_INPUT');
    assert.equal(error.message.includes('private-reflection-error-value'), false);
    return true;
  });
});

test('submission rejects missing, blank, wrong-type, oversized and non-JSON config fields', () => {
  for (const key of ['sessionId', 'requestId', 'prompt'] as const) {
    for (const value of [undefined, null, 42, [], {}, '', '   ', '\0']) {
      rejects(() => normalizeSubmitInput({ ...submit, [key]: value }), 'INVALID_INPUT', `payload.${key}`);
    }
  }
  for (const config of [null, [], true, 'scripted', undefined]) {
    rejects(() => normalizeSubmitInput({ ...submit, config }), 'INVALID_INPUT', 'payload.config');
  }
  for (const config of [{ apiKey: 'credential-should-never-appear' }, { providerId: '' }, { modelId: 42 }, { mode: 'auto' }, { limits: null }, { limits: [] }]) {
    rejects(() => normalizeSubmitInput({ ...submit, config }));
  }
  rejects(() => normalizeSubmitInput({ ...submit, attachment: {} }));
  rejects(() => normalizeSubmitInput({ ...submit, prompt: 'x'.repeat(131_073) }));
  rejects(() => normalizeSubmitInput({ ...submit, prompt: '가'.repeat(43_691) }));
  assert.equal(normalizeSubmitInput({ ...submit, prompt: 'x'.repeat(131_072) }).prompt.length, 131_072);
  assert.equal(normalizeSubmitInput({ ...submit, prompt: '가'.repeat(43_690) }).prompt.length, 43_690);
});

test('standalone run config normalizes like a submit config and keeps payload.config errors', () => {
  const defaults = { providerId: 'fixture', mode: 'build' as const, limits: { maxTurns: 4 } };
  for (const config of [{}, { modelId: 'model-2', limits: { maxDurationMs: 10 } }]) {
    assert.deepEqual(normalizeRunConfig(config), normalizeSubmitInput({ ...submit, config }).config);
    assert.deepEqual(normalizeRunConfig(config, defaults), normalizeSubmitInput({ ...submit, config }, defaults).config);
  }
  for (const config of [null, [], true, 'scripted', undefined]) rejects(() => normalizeRunConfig(config), 'INVALID_INPUT', 'payload.config');
  rejects(() => normalizeRunConfig({ mode: 'auto' }), 'INVALID_INPUT', 'payload.config.mode');
  rejects(() => normalizeRunConfig({ limits: { maxTurns: 0 } }), 'INVALID_INPUT', 'payload.config.limits.maxTurns');
});

test('every budget requires a positive bounded safe integer', () => {
  const keys = Object.keys(DEFAULT_LIMITS) as (keyof RunLimits)[];
  for (const key of keys) {
    for (const value of [undefined, null, 0, -1, 1.5, NaN, Infinity, '10', Number.MAX_SAFE_INTEGER]) {
      rejects(() => normalizeSubmitInput({ ...submit, config: { limits: { [key]: value } } }), 'INVALID_INPUT', `payload.config.limits.${key}`);
    }
    assert.equal(normalizeSubmitInput({ ...submit, config: { limits: { [key]: 1 } } }).config.limits[key], 1);
  }
  rejects(() => normalizeSubmitInput({ ...submit, config: { limits: { maxTokens: 10 } } }));
  const maximums: RunLimits = {
    maxTurns: 128, maxToolCalls: 1_024, maxDurationMs: 3_600_000, toolTimeoutMs: 600_000,
    maxOutputBytes: 1_048_576, maxContextBytes: 4_194_304,
  };
  assert.deepEqual(normalizeSubmitInput({ ...submit, config: { limits: maximums } }).config.limits, maximums);
  for (const key of keys) {
    rejects(() => normalizeSubmitInput({ ...submit, config: { limits: { [key]: maximums[key] + 1 } } }), 'INVALID_INPUT', `payload.config.limits.${key}`);
  }
});

test('command-specific fields validate exact types and sequence bounds', () => {
  for (const [type, payload] of [
    ['workspace.open', { path: '/tmp/\0project' }],
    ['workspace.open', { path: 'x'.repeat(4_097) }],
    ['session.create', { workspaceId: 'w', title: '' }],
    ['session.create', { workspaceId: 'w', title: undefined }],
    ['approval.decide', { approvalId: 'a', decision: 'yes', fingerprint: 'hash' }],
    ['approval.decide', { approvalId: 'a', decision: 'allow', fingerprint: null }],
    ['approval.decide', { approvalId: 'a', decision: 'allow', fingerprint: 'x'.repeat(513) }],
    ['run.cancel', { runId: 'r', timeout: 10 }],
  ] as const) rejects(() => validateCommand(envelope(type, payload)));
  for (const afterSeq of [-1, 1.5, NaN, Infinity, '0', undefined, Number.MAX_SAFE_INTEGER + 1]) {
    rejects(() => validateCommand(envelope('events.subscribe', { sessionId: 's', afterSeq })));
  }
  const max = validateCommand(envelope('events.subscribe', { sessionId: 's', afterSeq: Number.MAX_SAFE_INTEGER }));
  assert.equal(max.payload.afterSeq, Number.MAX_SAFE_INTEGER);
});

test('unsupported credential fields and invalid field values never leak through errors', () => {
  const secret = 'private-value-sentinel-123';
  const cases = [
    () => normalizeSubmitInput({ ...submit, apiKey: secret }),
    () => normalizeSubmitInput({ ...submit, config: { apiKey: secret } }),
    () => normalizeSubmitInput({ ...submit, config: { limits: { maxTurns: secret } } }),
    () => validateCommand(envelope(secret, {})),
    () => validateCommand(envelope('approval.decide', { approvalId: 'a', decision: secret, fingerprint: 'hash' })),
  ];
  for (const action of cases) {
    assert.throws(action, (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.equal(`${error.message} ${JSON.stringify(error.details)}`.includes(secret), false);
      return true;
    });
  }
});
