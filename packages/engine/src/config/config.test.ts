import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type RunLimits } from '@moodcode/contracts';
import { loadConfig, type LoadConfigOptions } from './index.js';

const secret = 'MOODCODE_CONFIG_SECRET_SENTINEL';
type ConfigSource = 'options' | 'user' | 'workspace';

async function fixture(t: TestContext): Promise<string> {
  // macOS /var is a symlink; ordinary fixtures use the canonical /private/var path.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-config-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function jsonFile(root: string, name: string, value: unknown): Promise<string> {
  const path = join(root, name);
  await writeFile(path, JSON.stringify(value));
  return path;
}

function configError(code: string, source: ConfigSource, forbidden: readonly string[] = [], field?: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof EngineError, 'Configuration failures must use the engine error contract');
    assert.equal(error.code, code);
    assert.equal(error.details?.source, source);
    if (field !== undefined) assert.equal(error.details?.field, field);
    assert.ok(Object.keys(error.details ?? {}).every((key) => key === 'source' || key === 'field'));
    assert.equal(error.cause, undefined, 'Native errors must not be attached as causes');
    const publicError = JSON.stringify({ name: error.name, code: error.code, message: error.message, details: error.details });
    for (const value of forbidden) assert.ok(!publicError.includes(value), 'An error must not echo configuration values, names, or paths');
    return true;
  };
}

function uncheckedOptions(value: unknown): LoadConfigOptions {
  return value as LoadConfigOptions;
}

test('loadConfig returns isolated, deeply frozen defaults without explicit paths', async () => {
  const first = await loadConfig();
  const second = await loadConfig({});
  assert.deepEqual(first.runConfig, { providerId: 'scripted', modelId: 'local', mode: 'plan', limits: DEFAULT_LIMITS });
  assert.equal(Object.getPrototypeOf(first.providers), null);
  assert.deepEqual(Object.keys(first.providers), []);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.runConfig));
  assert.ok(Object.isFrozen(first.runConfig.limits));
  assert.ok(Object.isFrozen(first.providers));
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.runConfig.limits, second.runConfig.limits);
  assert.equal(Reflect.set(first.runConfig.limits, 'maxTurns', 99), false);
  assert.equal(first.runConfig.limits.maxTurns, DEFAULT_LIMITS.maxTurns);
});

test('loadConfig treats missing explicit files and a valid empty object as defaults', async (t) => {
  const root = await fixture(t);
  const missing = await loadConfig({ userConfigPath: join(root, 'missing.json'), workspaceConfigPath: join(root, 'missing-parent', 'workspace.json') });
  const emptyPath = await jsonFile(root, 'empty-object.json', {});
  const empty = await loadConfig({ userConfigPath: emptyPath });
  assert.deepEqual(missing.runConfig, empty.runConfig);
  assert.deepEqual(empty.runConfig.limits, DEFAULT_LIMITS);
  assert.deepEqual(Object.keys(missing.providers), []);
});

test('loadConfig merges defaults, user, and workspace fields including partial limits and provider metadata', async (t) => {
  const root = await fixture(t);
  const userPath = await jsonFile(root, 'user.json', {
    providerId: 'custom', modelId: 'user-model', mode: 'build',
    limits: { maxTurns: 5, maxToolCalls: 9, maxOutputBytes: 1_024 },
    providers: { custom: { baseURL: 'https://user.example.test/v1', apiKeyEnv: 'USER_API_TOKEN' }, other: { baseURL: 'http://localhost:8080/v1' } },
  });
  const workspacePath = await jsonFile(root, 'workspace.json', {
    modelId: 'workspace-model', limits: { maxTurns: 7, toolTimeoutMs: 4_000 },
    providers: { custom: { baseURL: 'https://workspace.example.test/v2' }, workspace: { apiKeyEnv: '_WORKSPACE_TOKEN2' } },
  });
  const beforeUser = await readFile(userPath, 'utf8');
  const beforeWorkspace = await readFile(workspacePath, 'utf8');
  const result = await loadConfig({ userConfigPath: userPath, workspaceConfigPath: workspacePath });
  assert.deepEqual(result.runConfig, {
    providerId: 'custom', modelId: 'workspace-model', mode: 'build',
    limits: { ...DEFAULT_LIMITS, maxTurns: 7, maxToolCalls: 9, maxOutputBytes: 1_024, toolTimeoutMs: 4_000 },
  });
  assert.deepEqual({ ...result.providers }, {
    custom: { baseURL: 'https://workspace.example.test/v2', apiKeyEnv: 'USER_API_TOKEN' },
    other: { baseURL: 'http://localhost:8080/v1' }, workspace: { apiKeyEnv: '_WORKSPACE_TOKEN2' },
  });
  assert.equal(Object.getPrototypeOf(result.providers), null);
  assert.ok(Object.values(result.providers).every(Object.isFrozen));
  assert.equal(await readFile(userPath, 'utf8'), beforeUser);
  assert.equal(await readFile(workspacePath, 'utf8'), beforeWorkspace);
});

test('loadConfig preserves special provider IDs in a null-prototype map without prototype pollution', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'special-providers.json');
  await writeFile(path, '{"providers":{"__proto__":{"apiKeyEnv":"PROTO_TOKEN"},"constructor":{"baseURL":"https://example.test/v1"}}}');
  const result = await loadConfig({ userConfigPath: path });
  assert.equal(Object.getPrototypeOf(result.providers), null);
  assert.ok(Object.hasOwn(result.providers, '__proto__'));
  assert.deepEqual(result.providers['__proto__'], { apiKeyEnv: 'PROTO_TOKEN' });
  assert.deepEqual(result.providers['constructor'], { baseURL: 'https://example.test/v1' });
  assert.equal(Object.hasOwn(Object.prototype, 'apiKeyEnv'), false);
});

test('loadConfig validates invalid lower-layer run and provider values even when workspace overrides them', async (t) => {
  const root = await fixture(t);
  const workspacePath = await jsonFile(root, 'workspace.json', { mode: 'plan', providers: { custom: { baseURL: 'https://example.test/v1' } } });
  const invalidRunPath = await jsonFile(root, `${secret}-run.json`, { mode: secret });
  await assert.rejects(loadConfig({ userConfigPath: invalidRunPath, workspaceConfigPath: workspacePath }),
    configError('CONFIG_INVALID', 'user', [secret, invalidRunPath], 'mode'));
  const invalidProviderPath = await jsonFile(root, `${secret}-provider.json`, { providers: { custom: { baseURL: `https://user:${secret}@example.test/v1` } } });
  await assert.rejects(loadConfig({ userConfigPath: invalidProviderPath, workspaceConfigPath: workspacePath }),
    configError('CONFIG_INVALID', 'user', [secret, invalidProviderPath], 'providers.baseURL'));
});

test('loadConfig accepts exact supported budget ceilings and rejects each exceeded ceiling', async (t) => {
  const root = await fixture(t);
  const ceilings: RunLimits = { maxTurns: 128, maxToolCalls: 1_024, maxDurationMs: 3_600_000, toolTimeoutMs: 600_000, maxOutputBytes: 1_048_576, maxContextBytes: 4_194_304 };
  const path = await jsonFile(root, 'limits.json', { limits: ceilings });
  assert.deepEqual((await loadConfig({ userConfigPath: path })).runConfig.limits, ceilings);
  for (const key of Object.keys(ceilings) as (keyof RunLimits)[]) {
    await writeFile(path, JSON.stringify({ limits: { [key]: ceilings[key] + 1 } }));
    await assert.rejects(loadConfig({ userConfigPath: path }), configError('CONFIG_INVALID', 'user', [path], `limits.${key}`));
  }
  for (const value of [0, -1, 1.5, '12', null]) {
    await writeFile(path, JSON.stringify({ limits: { maxTurns: value } }));
    await assert.rejects(loadConfig({ userConfigPath: path }), configError('CONFIG_INVALID', 'user', [path], 'limits.maxTurns'));
  }
});

test('loadConfig rejects unknown fields and malformed nested shapes using fixed redacted paths', async (t) => {
  const root = await fixture(t);
  const path = join(root, `${secret}-shape.json`);
  const cases: { value: unknown; field: string }[] = [
    { value: { [secret]: secret }, field: 'config' },
    { value: { apiKey: secret }, field: 'config' },
    { value: { limits: { [secret]: secret } }, field: 'limits' },
    { value: { limits: [] }, field: 'limits' },
    { value: { providers: { [secret]: { apiKey: secret } } }, field: 'providers' },
    { value: { providers: { custom: { [secret]: secret } } }, field: 'providers' },
    { value: { providers: [] }, field: 'providers' },
    { value: { providers: { custom: null } }, field: 'providers' },
    { value: [], field: 'config' },
    { value: null, field: 'config' },
  ];
  for (const { value, field } of cases) {
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(loadConfig({ userConfigPath: path }), configError('CONFIG_INVALID', 'user', [secret, path], field));
  }
});

test('loadConfig bounds provider entries in each layer and in the merged result', async (t) => {
  const root = await fixture(t);
  const entries = (start: number, count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`provider-${start + index}`, {}]));
  const userPath = await jsonFile(root, 'user-providers.json', { providers: entries(0, 32) });
  const workspacePath = await jsonFile(root, 'workspace-providers.json', { providers: entries(32, 32) });
  assert.equal(Object.keys((await loadConfig({ userConfigPath: userPath, workspaceConfigPath: workspacePath })).providers).length, 64);
  await writeFile(workspacePath, JSON.stringify({ providers: entries(32, 33) }));
  await assert.rejects(loadConfig({ userConfigPath: userPath, workspaceConfigPath: workspacePath }),
    configError('CONFIG_INVALID', 'workspace', [workspacePath], 'providers'));
  await writeFile(userPath, JSON.stringify({ providers: entries(0, 65) }));
  await assert.rejects(loadConfig({ userConfigPath: userPath }), configError('CONFIG_INVALID', 'user', [userPath], 'providers'));
});

test('loadConfig accepts exactly 65536 UTF-8 bytes and rejects the next byte', async (t) => {
  const root = await fixture(t);
  const providers = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`provider-${index}`, { baseURL: `https://example.test/${'한'.repeat(500)}` }]));
  const json = JSON.stringify({ providers });
  const bytes = Buffer.byteLength(json, 'utf8');
  assert.ok(bytes > json.length);
  assert.ok(bytes < 65_536);
  const exact = json + ' '.repeat(65_536 - bytes);
  assert.equal(Buffer.byteLength(exact, 'utf8'), 65_536);
  const path = join(root, `${secret}-bounded.json`);
  await writeFile(path, exact);
  assert.equal(Object.keys((await loadConfig({ userConfigPath: path })).providers).length, 32);
  await writeFile(path, exact + ' ');
  await assert.rejects(loadConfig({ userConfigPath: path }), configError('CONFIG_FILE_LIMIT', 'user', [secret, path]));
});

test('loadConfig rejects empty, malformed JSON, and malformed UTF-8 without copying input into errors', async (t) => {
  const root = await fixture(t);
  const path = join(root, `${secret}-broken.json`);
  for (const contents of ['', '   ', `{"modelId":"${secret}",`, Buffer.concat([Buffer.from(`{"modelId":"${secret}`), Buffer.from([0xc3, 0x28]), Buffer.from('"}')])]) {
    await writeFile(path, contents);
    await assert.rejects(loadConfig({ workspaceConfigPath: path }), configError('CONFIG_JSON', 'workspace', [secret, path]));
  }
});

test('loadConfig rejects URL credentials, queries, fragments, unsupported protocols, and malformed URLs safely', async (t) => {
  const root = await fixture(t);
  const path = join(root, `${secret}-urls.json`);
  for (const baseURL of [
    `https://${secret}@example.test/v1`, `https://user:${secret}@example.test/v1`,
    `https://example.test/v1?token=${secret}`, `https://example.test/v1#${secret}`,
    `ftp://example.test/${secret}`, `javascript:${secret}`, secret, ' https://example.test/v1',
  ]) {
    await writeFile(path, JSON.stringify({ providers: { [secret]: { baseURL } } }));
    await assert.rejects(loadConfig({ userConfigPath: path }), configError('CONFIG_INVALID', 'user', [secret, path], 'providers.baseURL'));
  }
});

test('loadConfig validates environment name references at exact identifier boundaries', async (t) => {
  const root = await fixture(t);
  const path = await jsonFile(root, 'envname.json', { providers: { custom: { apiKeyEnv: '_' + 'A'.repeat(127) } } });
  assert.equal((await loadConfig({ userConfigPath: path })).providers['custom']?.apiKeyEnv?.length, 128);
  for (const apiKeyEnv of [`1${secret}`, `${secret}-KEY`, `${secret} KEY`, `${secret}\n`, 'A'.repeat(129), '', null]) {
    await writeFile(path, JSON.stringify({ providers: { custom: { apiKeyEnv } } }));
    await assert.rejects(loadConfig({ userConfigPath: path }), configError('CONFIG_INVALID', 'user', [secret, path], 'providers.apiKeyEnv'));
  }
});

test('loadConfig retains only environment references without reading or changing their values', async (t) => {
  const root = await fixture(t);
  const reference = 'MOODCODE_CONFIG_TEST_API_TOKEN';
  const path = await jsonFile(root, 'env-reference.json', { providers: { custom: { apiKeyEnv: reference } } });
  const original = process.env;
  let reads = 0;
  let writes = 0;
  process.env = new Proxy(original, {
    get(target, key) { if (key === reference) { reads += 1; return secret; } return Reflect.get(target, key); },
    set(target, key, value) { if (key === reference) { writes += 1; return true; } return Reflect.set(target, key, value); },
    deleteProperty(target, key) { if (key === reference) { writes += 1; return true; } return Reflect.deleteProperty(target, key); },
  });
  let serialized: string;
  try {
    const result = await loadConfig({ userConfigPath: path });
    assert.equal(result.providers['custom']?.apiKeyEnv, reference);
    serialized = JSON.stringify(result);
  } finally {
    process.env = original;
  }
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.ok(!serialized.includes(secret));
  assert.strictEqual(process.env, original);
});

test('loadConfig treats shell and JavaScript-looking model IDs as literal data', async (t) => {
  const root = await fixture(t);
  const marker = join(root, 'literal-marker');
  const modelId = `$(touch ${JSON.stringify(marker)}); globalThis.MOODCODE_CONFIG_LITERAL_EVALUATED=true`;
  assert.ok(Buffer.byteLength(modelId, 'utf8') <= 256);
  const path = await jsonFile(root, 'literal.json', { modelId });
  const result = await loadConfig({ userConfigPath: path });
  assert.equal(result.runConfig.modelId, modelId);
  assert.equal(Reflect.has(globalThis, 'MOODCODE_CONFIG_LITERAL_EVALUATED'), false);
  await assert.rejects(access(marker), (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
});

test('loadConfig rejects direct file symlinks, symlink parents, directories, and non-directory parents', async (t) => {
  const root = await fixture(t);
  const actualPath = await jsonFile(root, 'actual.json', {});
  const directLink = join(root, 'direct-link.json');
  await symlink(actualPath, directLink);
  await assert.rejects(loadConfig({ userConfigPath: directLink }), configError('CONFIG_FILE_TYPE', 'user', [directLink]));
  const actualDir = join(root, 'actual-dir');
  await mkdir(actualDir);
  await jsonFile(actualDir, 'config.json', {});
  const directoryLink = join(root, 'directory-link');
  await symlink(actualDir, directoryLink, 'dir');
  const indirectPath = join(directoryLink, 'config.json');
  await assert.rejects(loadConfig({ workspaceConfigPath: indirectPath }), configError('CONFIG_FILE_TYPE', 'workspace', [indirectPath]));
  await assert.rejects(loadConfig({ userConfigPath: actualDir }), configError('CONFIG_FILE_TYPE', 'user', [actualDir]));
  const invalidParentPath = join(actualPath, 'config.json');
  await assert.rejects(loadConfig({ userConfigPath: invalidParentPath }), configError('CONFIG_FILE_TYPE', 'user', [invalidParentPath]));
});

test('loadConfig rejects a FIFO without waiting for a writer', { timeout: 2_000 }, async (t) => {
  if (process.platform === 'win32') { t.skip('FIFO fixture is unavailable on Windows'); return; }
  const root = await fixture(t);
  const path = join(root, 'config-fifo');
  const result = spawnSync('mkfifo', [path], { encoding: 'utf8' });
  if (result.error || result.status !== 0) { t.skip('mkfifo fixture is unavailable'); return; }
  await assert.rejects(loadConfig({ userConfigPath: path }), configError('CONFIG_FILE_TYPE', 'user', [path]));
});

test('loadConfig translates native I/O errors without exposing paths or native messages', async (t) => {
  const root = await fixture(t);
  const path = join(root, secret + 'x'.repeat(500));
  await assert.rejects(loadConfig({ userConfigPath: path }), configError('CONFIG_IO', 'user', [secret, path, 'ENAMETOOLONG']));
});

test('loadConfig supports explicit relative paths without searching additional config locations', async (t) => {
  const root = await fixture(t);
  const path = await jsonFile(root, 'relative.json', { modelId: 'relative-model' });
  const result = await loadConfig({ userConfigPath: relative(process.cwd(), path) });
  assert.equal(result.runConfig.modelId, 'relative-model');
});

test('loadConfig rejects invalid options and unsafe paths with options-scoped safe errors', async () => {
  for (const options of [null, [], { [secret]: secret }, { userConfigPath: '' }, { workspaceConfigPath: `${secret}\0` }, { userConfigPath: secret.repeat(200) }]) {
    await assert.rejects(loadConfig(uncheckedOptions(options)), configError('CONFIG_INVALID', 'options', [secret]));
  }
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  await assert.rejects(loadConfig(uncheckedOptions(proxy)), configError('CONFIG_INVALID', 'options', [secret], 'options'));
});

test('loadConfig rejects unbranded and revoked signals without leaking native exceptions', async () => {
  const { proxy, revoke } = Proxy.revocable(new AbortController().signal, {});
  revoke();
  for (const signal of [null, {}, Object.create(AbortSignal.prototype), proxy]) {
    await assert.rejects(loadConfig(uncheckedOptions({ signal })), configError('CONFIG_INVALID', 'options', [secret], 'signal'));
  }
});

test('loadConfig ignores a valid signal own aborted accessor and uses its native state', async (t) => {
  const root = await fixture(t);
  const path = await jsonFile(root, 'valid-signal.json', { modelId: 'signal-model' });
  const signal = new AbortController().signal;
  let accessorReads = 0;
  Object.defineProperty(signal, 'aborted', { get() { accessorReads += 1; throw new Error(secret); } });
  assert.equal((await loadConfig({ userConfigPath: path, signal })).runConfig.modelId, 'signal-model');
  assert.equal(accessorReads, 0);
});

test('loadConfig honors cancellation before work and after a filesystem await', async (t) => {
  const root = await fixture(t);
  const path = await jsonFile(root, 'cancel.json', { modelId: 'cancel-model' });
  const before = new AbortController();
  before.abort();
  await assert.rejects(loadConfig({ userConfigPath: path, signal: before.signal }), configError('CANCELLED', 'options', [path]));
  const during = new AbortController();
  const loading = loadConfig({ userConfigPath: path, signal: during.signal });
  during.abort();
  await assert.rejects(loading, configError('CANCELLED', 'user', [path]));
});
