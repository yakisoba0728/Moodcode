import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { EngineError, type EngineBudgets, type RunConfig, type RunLimits } from '@moodcode/contracts';
import { normalizeRunConfig } from '@moodcode/contracts/validation';
import { providerURLAllowed } from '../provider/helpers.js';

const MAX_CONFIG_BYTES = 65_536;
const MAX_PROVIDERS = 64;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const RUN_FIELDS = ['providerId', 'modelId', 'mode', 'limits', 'reasoningEffort', 'budgets'] as const;
const LIMIT_FIELDS: readonly (keyof RunLimits)[] = [
  'maxTurns', 'maxToolCalls', 'maxDurationMs', 'toolTimeoutMs', 'maxOutputBytes', 'maxContextBytes',
];
type Source = 'options' | 'user' | 'workspace';
const BUDGET_FIELDS: readonly (keyof EngineBudgets)[] = [
  'turnAllowance', 'maxToolCallsPerTurn', 'maxPendingInputs', 'maxPendingBytes', 'maxSteerBatch',
  'maxReadConcurrency', 'maxProviderAttempts', 'providerRequestTimeoutMs', 'providerInactivityTimeoutMs',
  'retryBaseDelayMs', 'maxSummaryCalls', 'maxSummaryBytes', 'maxArtifactBytes', 'maxProducerBytes',
];

export interface LoadConfigOptions {
  userConfigPath?: string;
  workspaceConfigPath?: string;
  signal?: AbortSignal;
}

/** Provider metadata contains references only; this service never resolves credentials. */
export interface ConfigProviderMetadata {
  readonly baseURL?: string;
  readonly apiKeyEnv?: string;
}

export interface ConfigFile {
  providerId?: string;
  modelId?: string;
  mode?: RunConfig['mode'];
  limits?: Partial<RunLimits>;
  reasoningEffort?: RunConfig['reasoningEffort'];
  budgets?: Partial<EngineBudgets>;
  providers?: Record<string, ConfigProviderMetadata>;
}

export type ResolvedRunConfig = Readonly<Omit<RunConfig, 'limits'>> & { readonly limits: Readonly<RunLimits> };
export interface ResolvedConfig {
  readonly runConfig: ResolvedRunConfig;
  readonly providers: Readonly<Record<string, ConfigProviderMetadata>>;
}

interface Layer {
  runConfig: Partial<Omit<RunConfig, 'limits' | 'budgets'>> & { limits?: Partial<RunLimits>; budgets?: Partial<EngineBudgets> };
  providers: Record<string, ConfigProviderMetadata>;
}

function failure(code: string, source: Source, message: string, field?: string): never {
  throw new EngineError(code, message, field === undefined ? { source } : { source, field });
}

function invalid(source: Source, field: string, rule: string): never {
  failure('CONFIG_INVALID', source, `Configuration ${field} ${rule}.`, field);
}

function cancelled(signal: AbortSignal | undefined, source: Source): void {
  if (signal !== undefined && signalAborted.call(signal)) failure('CANCELLED', source, 'Configuration loading was cancelled.');
}

function dataObject(value: unknown, source: Source, field: string, allowed?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object') invalid(source, field, 'must be a JSON object');
  let prototype: unknown;
  let array: boolean;
  let keys: (string | symbol)[];
  let descriptors: PropertyDescriptorMap;
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    invalid(source, field, 'must be inspectable data');
  }
  if (array || (prototype !== Object.prototype && prototype !== null)) invalid(source, field, 'must be a plain JSON object');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || (allowed !== undefined && !allowed.includes(key))) {
      invalid(source, field, 'contains an unsupported field');
    }
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid(source, field, 'must contain JSON data properties');
    result[key] = descriptor.value;
  }
  return result;
}

function validateRun(value: unknown, source: Source): RunConfig {
  try {
    return normalizeRunConfig(value);
  } catch (error) {
    // Forward a known schema path, never the offending value or a native exception.
    const path = error instanceof EngineError ? error.details?.path : undefined;
    const field = typeof path === 'string' && path.startsWith('payload.config.') ? path.slice('payload.config.'.length) : 'runConfig';
    const known: readonly string[] = [...RUN_FIELDS, ...LIMIT_FIELDS.map((key) => `limits.${key}`), ...BUDGET_FIELDS.map((key) => `budgets.${key}`)];
    invalid(source, known.includes(field) ? field : 'runConfig', 'does not match the supported run configuration');
  }
}

function providerMetadata(value: unknown, source: Source): ConfigProviderMetadata {
  const input = dataObject(value, source, 'providers', ['baseURL', 'apiKeyEnv']);
  const result: { baseURL?: string; apiKeyEnv?: string } = {};
  let url: URL | undefined;
  if (Object.hasOwn(input, 'baseURL')) {
    const value = input.baseURL;
    if (typeof value !== 'string' || value.length === 0 || value.length > 2_048
      || Buffer.byteLength(value, 'utf8') > 2_048 || value.trim() !== value || /[\u0000-\u0020\u007f]/u.test(value)) {
      invalid(source, 'providers.baseURL', 'must be a bounded HTTP or HTTPS URL');
    }
    try { url = new URL(value); } catch { invalid(source, 'providers.baseURL', 'must be an HTTP or HTTPS URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
      invalid(source, 'providers.baseURL', 'must use HTTP or HTTPS without authentication, query, or fragment');
    }
    result.baseURL = value;
  }
  if (Object.hasOwn(input, 'apiKeyEnv')) {
    if (typeof input.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(input.apiKeyEnv)) {
      invalid(source, 'providers.apiKeyEnv', 'must name a credential environment variable');
    }
    result.apiKeyEnv = input.apiKeyEnv;
  }
  if (url && result.apiKeyEnv !== undefined && !providerURLAllowed(url, true)) {
    invalid(source, 'providers.baseURL', 'must use HTTPS or loopback HTTP when apiKeyEnv is set');
  }
  return result;
}

function validateLayer(value: unknown, source: Source): Layer {
  const input = dataObject(value, source, 'config', [...RUN_FIELDS, 'providers']);
  const runInput: Record<string, unknown> = {};
  for (const field of RUN_FIELDS) if (Object.hasOwn(input, field)) runInput[field] = input[field];
  const normalized = validateRun(runInput, source);
  const runConfig: Layer['runConfig'] = {};
  if (Object.hasOwn(runInput, 'providerId')) runConfig.providerId = normalized.providerId;
  if (Object.hasOwn(runInput, 'modelId')) runConfig.modelId = normalized.modelId;
  if (Object.hasOwn(runInput, 'mode')) runConfig.mode = normalized.mode;
  if (Object.hasOwn(runInput, 'reasoningEffort')) runConfig.reasoningEffort = normalized.reasoningEffort;
  if (Object.hasOwn(runInput, 'limits')) {
    const limits = runInput.limits as Record<string, number>;
    runConfig.limits = {};
    for (const key of LIMIT_FIELDS) if (Object.hasOwn(limits, key)) runConfig.limits[key] = normalized.limits[key];
  }
  if (Object.hasOwn(runInput, 'budgets')) {
    const budgets = runInput.budgets as Record<string, number>;
    runConfig.budgets = {};
    for (const key of BUDGET_FIELDS) if (Object.hasOwn(budgets, key)) runConfig.budgets[key] = normalized.budgets![key];
  }
  const providers: Record<string, ConfigProviderMetadata> = Object.create(null);
  if (Object.hasOwn(input, 'providers')) {
    const entries = dataObject(input.providers, source, 'providers');
    if (Object.keys(entries).length > MAX_PROVIDERS) invalid(source, 'providers', 'must not exceed 64 provider entries');
    for (const [id, metadata] of Object.entries(entries)) {
      try { validateRun({ providerId: id }, source); }
      catch { invalid(source, 'providers', 'must use valid provider identifiers'); }
      providers[id] = providerMetadata(metadata, source);
    }
  }
  return { runConfig, providers };
}

function fsCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** Check every path component without following symlink directory aliases. */
async function parentsExist(path: string, source: Source, signal: AbortSignal | undefined): Promise<boolean> {
  const root = parse(path).root;
  let current = root;
  const segments = relative(root, dirname(path)).split(sep).filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    cancelled(signal, source);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      cancelled(signal, source);
      if (fsCode(error) === 'ENOENT') return false;
      if (fsCode(error) === 'ENOTDIR') failure('CONFIG_FILE_TYPE', source, 'Configuration path must contain regular directories.');
      throw error;
    }
    cancelled(signal, source);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      failure('CONFIG_FILE_TYPE', source, 'Configuration path must not contain symbolic links or non-directory parents.');
    }
  }
  return true;
}

async function readLayer(path: string, source: Source, signal: AbortSignal | undefined): Promise<Layer | undefined> {
  cancelled(signal, source);
  let existed = false;
  try {
    if (!await parentsExist(path, source, signal)) return undefined;
    const initial = await lstat(path);
    existed = true;
    cancelled(signal, source);
    if (initial.isSymbolicLink() || !initial.isFile()) failure('CONFIG_FILE_TYPE', source, 'Configuration must be a regular file without symbolic links.');
    if (initial.size > MAX_CONFIG_BYTES) failure('CONFIG_FILE_LIMIT', source, 'Configuration file must not exceed 65536 bytes.');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let text: string;
    try {
      cancelled(signal, source);
      const opened = await handle.stat();
      cancelled(signal, source);
      if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino) {
        failure('CONFIG_FILE_TYPE', source, 'Configuration file changed while it was being opened.');
      }
      if (opened.size > MAX_CONFIG_BYTES) failure('CONFIG_FILE_LIMIT', source, 'Configuration file must not exceed 65536 bytes.');
      if (!await parentsExist(path, source, signal)) failure('CONFIG_IO', source, 'Configuration path changed while it was being opened.');
      const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      let count = 0;
      while (count < bytes.length) {
        cancelled(signal, source);
        const part = await handle.read(bytes, count, bytes.length - count, count);
        cancelled(signal, source);
        if (part.bytesRead === 0) break;
        count += part.bytesRead;
      }
      if (count > MAX_CONFIG_BYTES) failure('CONFIG_FILE_LIMIT', source, 'Configuration file must not exceed 65536 bytes.');
      const final = await handle.stat();
      cancelled(signal, source);
      if (final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) {
        failure('CONFIG_IO', source, 'Configuration file changed while it was being read.');
      }
      if (!await parentsExist(path, source, signal)) failure('CONFIG_IO', source, 'Configuration path changed while it was being read.');
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)); }
      catch { failure('CONFIG_JSON', source, 'Configuration must contain valid UTF-8 JSON.'); }
    } finally {
      await handle.close();
    }
    cancelled(signal, source);
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { failure('CONFIG_JSON', source, 'Configuration must contain valid JSON.'); }
    cancelled(signal, source);
    return validateLayer(parsed, source);
  } catch (error) {
    cancelled(signal, source);
    if (error instanceof EngineError) throw error;
    if (fsCode(error) === 'ENOENT' && !existed) return undefined;
    if (fsCode(error) === 'ELOOP' || fsCode(error) === 'ENOTDIR') failure('CONFIG_FILE_TYPE', source, 'Configuration path must not contain symbolic links or non-directory parents.');
    failure('CONFIG_IO', source, 'Configuration file could not be read.');
  }
}

function configPath(value: unknown, field: 'userConfigPath' | 'workspaceConfigPath'): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4_096
    || Buffer.byteLength(value, 'utf8') > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid('options', field, 'must be a bounded explicit path');
  }
  return resolve(value);
}

/**
 * Load defaults < user file < workspace file, without environment lookup or side effects.
 * A provider entry replaces the lower layer's entry whole, so a redirected baseURL never inherits apiKeyEnv.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const input = dataObject(options, 'options', 'options', ['userConfigPath', 'workspaceConfigPath', 'signal']);
  let signal: AbortSignal | undefined;
  if (input.signal !== undefined) {
    try {
      if (!(input.signal instanceof AbortSignal)) invalid('options', 'signal', 'must be an AbortSignal');
      if (typeof signalAborted.call(input.signal) !== 'boolean') invalid('options', 'signal', 'must be an AbortSignal');
    } catch { invalid('options', 'signal', 'must be an AbortSignal'); }
    signal = input.signal as AbortSignal;
  }
  const userPath = configPath(input.userConfigPath, 'userConfigPath');
  const workspacePath = configPath(input.workspaceConfigPath, 'workspaceConfigPath');
  cancelled(signal, 'options');
  let runConfig = validateRun({}, 'options');
  const providers: Record<string, ConfigProviderMetadata> = Object.create(null);
  for (const [source, path] of [['user', userPath], ['workspace', workspacePath]] as const) {
    cancelled(signal, source);
    if (path === undefined) continue;
    const layer = await readLayer(path, source, signal);
    cancelled(signal, source);
    if (!layer) continue;
    runConfig = validateRun({
      ...runConfig, ...layer.runConfig, limits: { ...runConfig.limits, ...layer.runConfig.limits },
      ...(runConfig.budgets === undefined && layer.runConfig.budgets === undefined ? {} : { budgets: { ...runConfig.budgets, ...layer.runConfig.budgets } }),
    }, source);
    for (const [id, metadata] of Object.entries(layer.providers)) providers[id] = metadata;
    if (Object.keys(providers).length > MAX_PROVIDERS) invalid(source, 'providers', 'must not exceed 64 resolved provider entries');
  }
  cancelled(signal, 'options');
  for (const metadata of Object.values(providers)) Object.freeze(metadata);
  Object.freeze(providers);
  Object.freeze(runConfig.limits);
  if (runConfig.budgets) Object.freeze(runConfig.budgets);
  Object.freeze(runConfig);
  return Object.freeze({ runConfig, providers });
}
