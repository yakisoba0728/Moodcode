import { resolve } from 'node:path';
import { DEFAULT_ENGINE_BUDGETS, DEFAULT_LIMITS, EngineError, type EngineBudgets, type RunConfig, type RunLimits } from '@moodcode/contracts';
import { normalizeRunConfig } from '@moodcode/contracts/validation';
import { providerURLAllowed } from '../provider/helpers.js';
import { readBoundedTextFile, type BoundedReadFailure } from '../shared/fs.js';

const MAX_CONFIG_BYTES = 65_536;
const MAX_PROVIDERS = 64;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const RUN_FIELDS = ['providerId', 'modelId', 'mode', 'limits', 'reasoningEffort', 'budgets'] as const;
const LIMIT_FIELDS = Object.keys(DEFAULT_LIMITS) as readonly (keyof RunLimits)[];
type Source = 'options' | 'user' | 'workspace';
const BUDGET_FIELDS = Object.keys(DEFAULT_ENGINE_BUDGETS) as readonly (keyof EngineBudgets)[];

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

const READ_FAILURES: Readonly<Record<BoundedReadFailure, readonly [code: string, message: string]>> = {
  type: ['CONFIG_FILE_TYPE', 'Configuration must be a regular file without symbolic links or non-directory parents.'],
  limit: ['CONFIG_FILE_LIMIT', 'Configuration file must not exceed 65536 bytes.'],
  opened: ['CONFIG_FILE_TYPE', 'Configuration file changed while it was being opened.'],
  changed: ['CONFIG_IO', 'Configuration file changed while it was being read.'],
  encoding: ['CONFIG_JSON', 'Configuration must contain valid UTF-8 JSON.'],
  io: ['CONFIG_IO', 'Configuration file could not be read.'],
};

async function readLayer(path: string, source: Source, signal: AbortSignal | undefined): Promise<Layer | undefined> {
  const text = await readBoundedTextFile(path, MAX_CONFIG_BYTES, {
    check: () => cancelled(signal, source),
    onFailure: reason => failure(READ_FAILURES[reason][0], source, READ_FAILURES[reason][1]),
    verifyParents: true,
  });
  cancelled(signal, source);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { failure('CONFIG_JSON', source, 'Configuration must contain valid JSON.'); }
  cancelled(signal, source);
  return validateLayer(parsed, source);
}

function configPath(value: unknown, field: 'userConfigPath' | 'workspaceConfigPath'): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4_096
    || Buffer.byteLength(value, 'utf8') > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid('options', field, 'must be a bounded explicit path');
  }
  return resolve(value);
}

/** Layers defaults < user < workspace without env lookup; a provider entry replaces the lower one whole, so a redirected baseURL never inherits apiKeyEnv. */
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
