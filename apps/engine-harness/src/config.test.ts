import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIMITS, type CommandEnvelope, type RunConfig, type RunConfigInput } from '@moodcode/contracts';
import type { HarnessEngine } from './protocol.js';
import { parseArguments, resolveApiKey, resolveCliConfig, withSubmitDefaults } from './index.js';

const fixtureKey = 'fixture-only-layered-key';
const fixtureEnvironmentName = 'MOODCODE_FIXTURE_LAYERED_KEY';
const config = (overrides: Partial<RunConfig> = {}): RunConfig => ({
  providerId: 'scripted', modelId: 'local', mode: 'plan', limits: { ...DEFAULT_LIMITS }, ...overrides,
});
const loaded = (runConfig = config(), providers: Readonly<Record<string, { baseURL?: string; apiKeyEnv?: string }>> = {}) => ({ runConfig, providers });
const submit = (id: string, extra: Record<string, unknown> = {}): CommandEnvelope => ({
  schemaVersion: 1, commandId: id, type: 'run.submit',
  payload: { sessionId: 'session', requestId: `request-${id}`, prompt: 'fixture', ...extra } as CommandEnvelope['payload'],
});

function fakeEngine() {
  const dispatched: CommandEnvelope[] = [];
  const subscribed: unknown[][] = [];
  let closed = 0;
  const engine: HarnessEngine = {
    async dispatch(command) {
      dispatched.push(command);
      return { schemaVersion: 1, commandId: command.commandId, ok: true, result: command.payload };
    },
    async *subscribe(sessionId, afterSeq, signal) { subscribed.push([sessionId, afterSeq, signal]); },
    close() { closed++; },
  };
  return { engine, dispatched, subscribed, get closed() { return closed; } };
}

test('CLI parsing retains local defaults and records which options were explicit', () => {
  const options = parseArguments([], '/tmp/moodcode-config-fixture');
  assert.equal(options.provider, 'scripted');
  assert.equal(options.modelId, 'local');
  assert.equal(options.help, false);
  assert.equal(options.dbPath, '/tmp/moodcode-config-fixture/.moodcode/engine.sqlite');
  assert.equal(options.artifactDir, '/tmp/moodcode-config-fixture/.moodcode/artifacts');
  assert.equal(options.userConfigPath, undefined);
  assert.equal(options.workspaceConfigPath, undefined);
  assert.deepEqual(options.explicit, { provider: false, model: false, baseURL: false });
});

test('config paths are explicit and resolved relative to the supplied CLI cwd', () => {
  const options = parseArguments(['--config=user.json', '--workspace-config', 'workspace/config.json'], '/tmp/moodcode-config-fixture');
  assert.equal(options.userConfigPath, '/tmp/moodcode-config-fixture/user.json');
  assert.equal(options.workspaceConfigPath, '/tmp/moodcode-config-fixture/workspace/config.json');
  assert.deepEqual(options.explicit, { provider: false, model: false, baseURL: false });
  assert.equal(parseArguments(['--config', '/explicit/user.json'], '/different').userConfigPath, '/explicit/user.json');
});

test('native Responses accepts provider/model/base flags using both CLI value forms', () => {
  const options = parseArguments(['--provider=openai-responses', '--model', 'fixture-model', '--base-url=http://127.0.0.1:3210/v1']);
  assert.equal(options.provider, 'openai-responses');
  assert.equal(options.modelId, 'fixture-model');
  assert.equal(options.baseURL, 'http://127.0.0.1:3210/v1');
  assert.deepEqual(options.explicit, { provider: true, model: true, baseURL: true });
});

test('individual CLI flags retain independent explicit markers', () => {
  assert.deepEqual(parseArguments(['--model', 'fixture']).explicit, { provider: false, model: true, baseURL: false });
  assert.deepEqual(parseArguments(['--base-url', 'http://127.0.0.1:3210/v1']).explicit, { provider: false, model: false, baseURL: true });
  assert.deepEqual(parseArguments(['--provider', 'scripted']).explicit, { provider: true, model: false, baseURL: false });
});

test('missing and repeated config options fail without echoing arbitrary values', () => {
  for (const args of [
    ['--config'], ['--workspace-config', '--model', 'fixture'],
    ['--config', 'one.json', '--config', fixtureKey],
    ['--workspace-config=one.json', `--workspace-config=${fixtureKey}`],
  ]) {
    assert.throws(() => parseArguments(args), (error: Error) => !error.message.includes(fixtureKey));
  }
});

test('key, token and unknown CLI arguments do not expose attempted credential values', () => {
  for (const name of ['--api-key', '--api_key', '--apiKey', '--key', '--token', '--authorization']) {
    for (const args of [[name, fixtureKey], [`${name}=${fixtureKey}`]]) {
      assert.throws(() => parseArguments(args), (error: Error) => /API keys/.test(error.message) && !error.message.includes(fixtureKey));
    }
  }
  assert.throws(() => parseArguments([`--unknown-${fixtureKey}=${fixtureKey}`]), (error: Error) => !error.message.includes(fixtureKey));
});

test('base URL validation rejects credential, query and fragment values without echoing them', () => {
  for (const baseURL of [
    `https://user:${fixtureKey}@example.test/v1`,
    `https://example.test/v1?api_key=${fixtureKey}`,
    `https://example.test/v1#${fixtureKey}`,
    `file:///${fixtureKey}`,
  ]) {
    assert.throws(() => parseArguments(['--base-url', baseURL]), (error: Error) => !error.message.includes(fixtureKey));
  }
});

test('absent CLI provider/model flags preserve resolved file config instead of local parse defaults', () => {
  const runConfig = config({ providerId: 'openai-responses', modelId: 'workspace-model', mode: 'build', limits: { ...DEFAULT_LIMITS, maxTurns: 4, maxToolCalls: 7 } });
  const resolved = resolveCliConfig(parseArguments(['--config', 'user.json', '--workspace-config', 'workspace.json']), loaded(runConfig, {
    'openai-responses': { baseURL: 'http://127.0.0.1:3210/v1', apiKeyEnv: fixtureEnvironmentName },
  }));
  assert.deepEqual(resolved.runConfig, runConfig);
  assert.equal(resolved.provider, 'openai-responses');
  assert.equal(resolved.baseURL, 'http://127.0.0.1:3210/v1');
  assert.equal(resolved.apiKeyEnv, fixtureEnvironmentName);
  assert.ok(!JSON.stringify(resolved).includes(fixtureKey));
});

test('explicit CLI model and base URL override files while mode, limits and key reference remain', () => {
  const limits = { ...DEFAULT_LIMITS, maxTurns: 6, maxOutputBytes: 4_096 };
  const resolved = resolveCliConfig(parseArguments(['--model', 'cli-model', '--base-url', 'http://127.0.0.1:3211/v1']), loaded(config({ providerId: 'openai-compatible', modelId: 'file-model', mode: 'build', limits }), {
    'openai-compatible': { baseURL: 'http://127.0.0.1:3210/v1', apiKeyEnv: fixtureEnvironmentName },
  }));
  assert.deepEqual(resolved.runConfig, { providerId: 'openai-compatible', modelId: 'cli-model', mode: 'build', limits });
  assert.equal(resolved.provider, 'openai-compatible');
  assert.equal(resolved.baseURL, 'http://127.0.0.1:3211/v1');
  assert.equal(resolved.apiKeyEnv, fixtureEnvironmentName);
});

test('an explicit local model overrides a file model even though it equals the parse default', () => {
  const resolved = resolveCliConfig(parseArguments(['--model', 'local']), loaded(config({ modelId: 'file-model' })));
  assert.equal(resolved.runConfig.modelId, 'local');
  assert.equal(resolved.provider, 'scripted');
});

test('explicit CLI provider selects its own metadata rather than the file-selected provider metadata', () => {
  const resolved = resolveCliConfig(parseArguments(['--config', 'fixture.json', '--provider', 'openai-compatible', '--model', 'cli-model']), loaded(config({ providerId: 'openai-responses', modelId: 'responses-model', mode: 'build' }), {
    'openai-compatible': { baseURL: 'http://127.0.0.1:3210/chat-v1', apiKeyEnv: 'MOODCODE_CHAT_FIXTURE_KEY' },
    'openai-responses': { baseURL: 'http://127.0.0.1:3211/responses-v1', apiKeyEnv: 'MOODCODE_RESPONSES_FIXTURE_KEY' },
  }));
  assert.equal(resolved.provider, 'openai-compatible');
  assert.equal(resolved.runConfig.providerId, 'openai-compatible');
  assert.equal(resolved.runConfig.modelId, 'cli-model');
  assert.equal(resolved.runConfig.mode, 'build');
  assert.equal(resolved.baseURL, 'http://127.0.0.1:3210/chat-v1');
  assert.equal(resolved.apiKeyEnv, 'MOODCODE_CHAT_FIXTURE_KEY');
});

test('explicit scripted selection clears remote metadata and keeps the resolved mode and limits', () => {
  const resolved = resolveCliConfig(parseArguments(['--provider', 'scripted']), loaded(config({ providerId: 'openai-responses', modelId: 'file-model', mode: 'build' }), {
    'openai-responses': { baseURL: 'http://127.0.0.1:3210/v1', apiKeyEnv: fixtureEnvironmentName },
  }));
  assert.equal(resolved.provider, 'scripted');
  assert.equal(resolved.runConfig.providerId, 'scripted');
  assert.equal(resolved.runConfig.mode, 'build');
  assert.deepEqual(resolved.runConfig.limits, DEFAULT_LIMITS);
  assert.equal(resolved.apiKeyEnv, undefined);
  assert.equal(resolved.baseURL, undefined);
});

test('config resolution does not mutate frozen file config, provider metadata or CLI options', () => {
  const runConfig = Object.freeze({ ...config({ providerId: 'openai-responses', modelId: 'file-model' }), limits: Object.freeze({ ...DEFAULT_LIMITS }) });
  const providers = Object.freeze({ 'openai-responses': Object.freeze({ baseURL: 'http://127.0.0.1:3210/v1', apiKeyEnv: fixtureEnvironmentName }) });
  const options = Object.freeze(parseArguments(['--model', 'cli-model']));
  const resolved = resolveCliConfig(options, loaded(runConfig, providers));
  assert.equal(resolved.runConfig.modelId, 'cli-model');
  assert.equal(runConfig.modelId, 'file-model');
  assert.equal(options.modelId, 'cli-model');
  assert.deepEqual(providers, { 'openai-responses': { baseURL: 'http://127.0.0.1:3210/v1', apiKeyEnv: fixtureEnvironmentName } });
});

test('unsupported file provider IDs fail with a bounded generic CLI diagnostic', () => {
  assert.throws(() => resolveCliConfig(parseArguments([]), loaded(config({ providerId: fixtureKey }))), (error: Error) => error.message.length <= 2_048 && !error.message.includes(fixtureKey));
});

test('unknown configured provider metadata is rejected even when another provider is selected', () => {
  assert.throws(() => resolveCliConfig(parseArguments([]), loaded(config(), {
    [fixtureKey]: { baseURL: 'http://127.0.0.1:3210/v1', apiKeyEnv: fixtureEnvironmentName },
  })), (error: Error) => error.message.length <= 2_048 && !error.message.includes(fixtureKey) && !error.message.includes(fixtureEnvironmentName));
});

test('invalid credential environment names are rejected without reading environment values', () => {
  const environment = new Proxy({} as Readonly<Record<string, string | undefined>>, {
    get() { assert.fail('An invalid environment name must not trigger lookup'); },
  });
  for (const apiKeyEnv of ['', '1INVALID', `KEY=${fixtureKey}`, 'INVALID-KEY', 'A'.repeat(129)]) {
    assert.throws(() => resolveApiKey({ apiKeyEnv }, environment), (error: Error) => error.message.length <= 2_048 && !error.message.includes(fixtureKey));
  }
});

test('named credential environment selection is exclusive and does not read fallback properties', () => {
  const environment: Readonly<Record<string, string | undefined>> = {
    [fixtureEnvironmentName]: fixtureKey,
    get MOODCODE_API_KEY(): string { throw new Error('Fallback was inspected'); },
    get OPENAI_API_KEY(): string { throw new Error('Fallback was inspected'); },
  };
  assert.equal(resolveApiKey({ apiKeyEnv: fixtureEnvironmentName }, environment), fixtureKey);
});

test('an absent or empty named key fails even when conventional fallback keys are present', () => {
  for (const value of [undefined, '']) {
    assert.throws(() => resolveApiKey({ apiKeyEnv: fixtureEnvironmentName }, {
      [fixtureEnvironmentName]: value, MOODCODE_API_KEY: fixtureKey, OPENAI_API_KEY: 'fixture-only-fallback',
    }), (error: Error) => !error.message.includes(fixtureKey) && !error.message.includes(fixtureEnvironmentName));
  }
});

test('conventional credential fallback uses Moodcode before OpenAI only without a named key', () => {
  assert.equal(resolveApiKey(undefined, { MOODCODE_API_KEY: 'fixture-only-primary', OPENAI_API_KEY: 'fixture-only-secondary' }), 'fixture-only-primary');
  assert.equal(resolveApiKey({}, { MOODCODE_API_KEY: '', OPENAI_API_KEY: 'fixture-only-secondary' }), 'fixture-only-secondary');
  assert.equal(resolveApiKey({}, { OPENAI_API_KEY: 'fixture-only-secondary' }), 'fixture-only-secondary');
  assert.throws(() => resolveApiKey(undefined, {}));
});

test('legacy withSubmitDefaults provider/model signature remains compatible', async () => {
  const f = fakeEngine();
  const wrapped = withSubmitDefaults(f.engine, 'openai-compatible', 'legacy-model');
  await wrapped.dispatch(submit('absent'));
  await wrapped.dispatch(submit('explicit', { config: { modelId: 'incoming-model', mode: 'build' } }));
  assert.deepEqual(f.dispatched[0]?.payload.config, { providerId: 'openai-compatible', modelId: 'legacy-model' });
  assert.deepEqual(f.dispatched[1]?.payload.config, { providerId: 'openai-compatible', modelId: 'incoming-model', mode: 'build' });
});

test('run requests have final precedence over full defaults, with per-field limits merging', async () => {
  const f = fakeEngine();
  const defaults: RunConfig = config({ providerId: 'openai-responses', modelId: 'cli-model', mode: 'plan', limits: { ...DEFAULT_LIMITS, maxTurns: 6, maxToolCalls: 9 } });
  const incoming = { providerId: 'scripted', modelId: 'incoming-model', mode: 'build', limits: { maxTurns: 2, maxOutputBytes: 4_096 } };
  const wrapped = withSubmitDefaults(f.engine, defaults);
  const command = submit('incoming', { config: incoming });
  await wrapped.dispatch(command);
  assert.deepEqual(f.dispatched[0]?.payload.config, {
    ...incoming, limits: { ...DEFAULT_LIMITS, maxToolCalls: 9, maxTurns: 2, maxOutputBytes: 4_096 },
  });
  assert.equal(command.commandId, 'incoming');
  assert.equal(f.dispatched[0]?.payload.requestId, 'request-incoming');
  assert.deepEqual(incoming.limits, { maxTurns: 2, maxOutputBytes: 4_096 });
  assert.equal(defaults.modelId, 'cli-model');
  assert.equal(defaults.limits.maxTurns, 6);
});

test('full and partial submit defaults fill absent fields without inventing missing limit fields', async () => {
  const f = fakeEngine();
  const partial: RunConfigInput = { providerId: 'openai-responses', modelId: 'fixture', limits: { maxTurns: 4 } };
  const wrapped = withSubmitDefaults(f.engine, partial);
  await wrapped.dispatch(submit('absent'));
  await wrapped.dispatch(submit('empty', { config: {} }));
  assert.deepEqual(f.dispatched[0]?.payload.config, partial);
  assert.deepEqual(f.dispatched[1]?.payload.config, partial);
});

test('invalid explicit submit config values remain invalid for facade validation', async () => {
  const f = fakeEngine();
  const wrapped = withSubmitDefaults(f.engine, config());
  for (const value of [null, 'invalid-config', 7, [], true]) {
    const command = submit(String(f.dispatched.length), { config: value });
    await wrapped.dispatch(command);
    assert.strictEqual(f.dispatched.at(-1)?.payload.config, value);
  }
});

test('invalid explicit provider/model/mode/limits fields are not repaired by defaults', async () => {
  const f = fakeEngine();
  const wrapped = withSubmitDefaults(f.engine, config());
  for (const field of ['providerId', 'modelId', 'mode'] as const) {
    for (const value of [null, '', 0, false]) {
      await wrapped.dispatch(submit(`${field}-${f.dispatched.length}`, { config: { [field]: value } }));
      const actual = f.dispatched.at(-1)?.payload.config as Record<string, unknown>;
      assert.strictEqual(actual[field], value);
    }
  }
  for (const value of [null, 'invalid-limits', 0, [], false]) {
    await wrapped.dispatch(submit(`limits-${f.dispatched.length}`, { config: { limits: value } }));
    const actual = f.dispatched.at(-1)?.payload.config as Record<string, unknown>;
    assert.strictEqual(actual.limits, value);
  }
});

test('unknown run config and limits fields remain visible to schema validation', async () => {
  const f = fakeEngine();
  const wrapped = withSubmitDefaults(f.engine, config());
  await wrapped.dispatch(submit('unsupported', { config: { unsupportedConfig: fixtureKey, limits: { unsupportedLimit: fixtureKey } } }));
  const actual = f.dispatched[0]?.payload.config as Record<string, unknown>;
  assert.equal(actual.unsupportedConfig, fixtureKey);
  assert.equal((actual.limits as Record<string, unknown>).unsupportedLimit, fixtureKey);
});

test('default injection delegates non-submit commands, subscriptions and close unchanged', async () => {
  const f = fakeEngine();
  const wrapped = withSubmitDefaults(f.engine, config());
  const command: CommandEnvelope = { schemaVersion: 1, commandId: 'capabilities', type: 'engine.getCapabilities', payload: {} };
  const controller = new AbortController();
  await wrapped.dispatch(command);
  for await (const _event of wrapped.subscribe('session', 8, controller.signal)) { assert.fail('Fake reader should not produce events'); }
  await wrapped.close();
  assert.strictEqual(f.dispatched[0], command);
  assert.deepEqual(f.subscribed, [['session', 8, controller.signal]]);
  assert.equal(f.closed, 1);
});
