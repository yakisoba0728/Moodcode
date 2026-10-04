import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JsonObject, RunConfig, RunConfigInput } from '@moodcode/contracts';
import type { ProviderAdapter } from '@moodcode/engine';
import { runHarness, type HarnessEngine } from './protocol.js';

export { runHarness } from './protocol.js';
export type { HarnessEngine, HarnessOptions, HarnessOutcome } from './protocol.js';

export type CliProvider = 'scripted' | 'openai-compatible' | 'openai-responses';
export interface CliOptions {
  dbPath: string;
  artifactDir: string;
  provider: CliProvider;
  baseURL?: string;
  modelId: string;
  userConfigPath?: string;
  workspaceConfigPath?: string;
  explicit: { provider: boolean; model: boolean; baseURL: boolean };
  help: boolean;
}

export const USAGE = `Moodcode JSONL engine harness
Usage: npm run harness -- [--db PATH] [--artifacts PATH]
       [--config PATH] [--workspace-config PATH]
       [--provider scripted|openai-compatible|openai-responses] [--base-url URL] [--model ID]

Defaults: scripted provider, local model, plan mode, .moodcode/engine.sqlite.
Priority: defaults < --config file < --workspace-config file < explicit CLI flags
< incoming run.submit config. Partial limits retain the lower-layer fields.
Remote providers require a base URL and model from CLI flags or configuration.
Configuration providers[id].apiKeyEnv names the environment variable containing
the key. Without that reference, use MOODCODE_API_KEY (or OPENAI_API_KEY).
API keys are never accepted as CLI arguments or configuration values.

stdin: {schemaVersion:1,commandId:"id",type:"workspace.open",payload:{path:"..."}}
stdout: {type:"result",schemaVersion:1,commandId:"id",ok:true,result:...}
events.subscribe starts {type:"event",subscriptionId:"id",event:...} records.
engine.getCapabilities with payload {} reports providers, tools and run defaults.
Replay uses payload {sessionId,afterSeq}; the subscription commandId identifies it.
EOF, SIGINT and SIGTERM close subscriptions and cancel active runs.
Diagnostics are written to stderr.
`;

class CliError extends Error { readonly code = 'INVALID_ARGUMENT'; }

export function parseArguments(args: readonly string[], cwd = process.cwd()): CliOptions {
  const values = new Map<string, string>();
  let help = false;
  const allowed = new Set(['--db', '--artifacts', '--provider', '--base-url', '--model', '--config', '--workspace-config']);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--help' || argument === '-h') { help = true; continue; }
    // Do not echo unknown argument values: an attempted CLI key must not reach diagnostics.
    if (/^--(?:api[-_]?key|key|token|authorization)(?:=|$)/i.test(argument)) throw new CliError('API keys must be supplied through MOODCODE_API_KEY or OPENAI_API_KEY');
    const equal = argument.indexOf('=');
    const name = equal === -1 ? argument : argument.slice(0, equal);
    if (!allowed.has(name)) throw new CliError('Unknown CLI option; use --help');
    if (values.has(name)) throw new CliError('CLI options may only be specified once');
    const value = equal === -1 ? args[++index] : argument.slice(equal + 1);
    if (!value || value.startsWith('--')) throw new CliError('CLI option requires a value');
    values.set(name, value);
  }
  const provider = values.get('--provider') ?? 'scripted';
  if (provider !== 'scripted' && provider !== 'openai-compatible' && provider !== 'openai-responses') throw new CliError('provider must be scripted, openai-compatible or openai-responses');
  const baseURL = values.get('--base-url');
  const modelId = values.get('--model') ?? (provider === 'scripted' ? 'local' : '');
  if (!help && provider !== 'scripted' && !values.has('--config') && !values.has('--workspace-config') && (!baseURL || !modelId)) throw new CliError('Remote provider requires --base-url and --model or explicit configuration paths');
  if (baseURL) {
    let url: URL;
    try { url = new URL(baseURL); } catch { throw new CliError('base-url must be a valid HTTP or HTTPS URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new CliError('base-url must use HTTP or HTTPS without credentials, query or fragment');
  }
  if (modelId.length > 256) throw new CliError('model ID must be at most 256 characters');
  return {
    dbPath: values.get('--db') === ':memory:' ? ':memory:' : resolve(cwd, values.get('--db') ?? '.moodcode/engine.sqlite'),
    artifactDir: resolve(cwd, values.get('--artifacts') ?? '.moodcode/artifacts'),
    provider, baseURL, modelId, help,
    ...(values.has('--config') ? { userConfigPath: resolve(cwd, values.get('--config')!) } : {}),
    ...(values.has('--workspace-config') ? { workspaceConfigPath: resolve(cwd, values.get('--workspace-config')!) } : {}),
    explicit: { provider: values.has('--provider'), model: values.has('--model'), baseURL: values.has('--base-url') },
  };
}

export interface LoadedCliConfig {
  readonly runConfig: Readonly<Omit<RunConfig, 'limits'>> & { readonly limits: Readonly<RunConfig['limits']> };
  readonly providers: Readonly<Record<string, { readonly baseURL?: string; readonly apiKeyEnv?: string }>>;
}
export interface ResolvedCliConfig {
  runConfig: RunConfig;
  provider: CliProvider;
  baseURL?: string;
  apiKeyEnv?: string;
}
const PROVIDERS = new Set<string>(['scripted', 'openai-compatible', 'openai-responses']);

/** loadConfig owns file merging; only explicitly supplied CLI fields override it. */
export function resolveCliConfig(options: CliOptions, loaded: LoadedCliConfig): ResolvedCliConfig {
  const provider = options.explicit.provider ? options.provider : loaded.runConfig.providerId;
  if (!PROVIDERS.has(provider) || Object.keys(loaded.providers).some((id) => !PROVIDERS.has(id))) throw new CliError('Harness supports only scripted, openai-compatible and openai-responses provider IDs');
  const modelId = options.explicit.model ? options.modelId : loaded.runConfig.modelId;
  const metadata = loaded.providers[provider];
  const baseURL = options.explicit.baseURL ? options.baseURL : metadata?.baseURL;
  if (provider !== 'scripted' && (!baseURL || !modelId.trim())) throw new CliError('Remote provider requires a base URL and model from CLI or configuration');
  return {
    runConfig: { ...loaded.runConfig, providerId: provider, modelId, limits: { ...loaded.runConfig.limits } },
    provider: provider as CliProvider,
    baseURL,
    apiKeyEnv: metadata?.apiKeyEnv,
  };
}

/** Resolve only a configured reference, or the two legacy names when no reference exists. */
export function resolveApiKey(metadata: { apiKeyEnv?: string } | undefined, environment: Readonly<Record<string, string | undefined>>): string {
  if (metadata?.apiKeyEnv !== undefined) {
    if (typeof metadata.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(metadata.apiKeyEnv)) throw new CliError('Configured provider credential environment variable name is invalid');
    const key = Object.hasOwn(environment, metadata.apiKeyEnv) ? environment[metadata.apiKeyEnv] : undefined;
    if (typeof key !== 'string' || !key) throw new CliError('Configured provider credential environment variable is not set');
    return key;
  }
  const moodcodeKey = environment.MOODCODE_API_KEY;
  if (typeof moodcodeKey === 'string' && moodcodeKey) return moodcodeKey;
  const key = environment.OPENAI_API_KEY;
  if (typeof key !== 'string' || !key) throw new CliError('Set MOODCODE_API_KEY or OPENAI_API_KEY for a remote provider');
  return key;
}

/** CLI provider selection supplies missing submit config fields without changing request IDs. */
export function withSubmitDefaults(engine: HarnessEngine, providerId: string, modelId: string): HarnessEngine;
export function withSubmitDefaults(engine: HarnessEngine, defaults: RunConfigInput): HarnessEngine;
export function withSubmitDefaults(engine: HarnessEngine, providerOrDefaults: string | RunConfigInput, modelId?: string): HarnessEngine {
  const defaults = typeof providerOrDefaults === 'string' ? { providerId: providerOrDefaults, modelId: modelId! } : providerOrDefaults;
  return {
    dispatch(command) {
      if (command.type !== 'run.submit') return engine.dispatch(command);
      const config = command.payload.config;
      // Invalid config must remain invalid so facade validation can report it.
      if (Object.hasOwn(command.payload, 'config') && config === undefined) return engine.dispatch(command);
      if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) return engine.dispatch(command);
      const selected = config ?? {};
      const merged = { ...defaults, ...(defaults.limits ? { limits: { ...defaults.limits } } : {}), ...selected } as JsonObject;
      if (Object.hasOwn(selected, 'limits') && selected.limits && typeof selected.limits === 'object' && !Array.isArray(selected.limits)) merged.limits = { ...defaults.limits, ...selected.limits };
      return engine.dispatch({ ...command, payload: { ...command.payload, config: merged } });
    },
    subscribe: (sessionId, afterSeq, signal) => engine.subscribe(sessionId, afterSeq, signal),
    close: () => engine.close(),
  };
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const secrets: string[] = [];
  let engine: HarnessEngine | undefined;
  try {
    const options = parseArguments(args);
    if (options.help) { process.stdout.write(USAGE); return 0; }
    // Lazy loading leaves --help and transport tests independent of engine startup.
    const { createEngine, loadConfig, ScriptedProvider, OpenAICompatibleProvider, ResponsesProvider } = await import('@moodcode/engine');
    const loaded = await loadConfig({ userConfigPath: options.userConfigPath, workspaceConfigPath: options.workspaceConfigPath });
    const resolved = resolveCliConfig(options, loaded);
    const providers: ProviderAdapter[] = [new ScriptedProvider()];
    const remoteIds = new Set(Object.keys(loaded.providers).filter((id) => id !== 'scripted'));
    if (resolved.provider !== 'scripted') remoteIds.add(resolved.provider);
    for (const id of remoteIds) {
      let adapter: ProviderAdapter | undefined;
      const metadata = id === resolved.provider ? { baseURL: resolved.baseURL, apiKeyEnv: resolved.apiKeyEnv } : loaded.providers[id];
      const getAdapter = (): ProviderAdapter => {
        if (adapter) return adapter;
        if (!metadata?.baseURL) throw new CliError('Configured remote provider requires a base URL');
        const apiKey = resolveApiKey(metadata, process.env);
        secrets.push(apiKey);
        const input = { baseURL: metadata.baseURL, apiKey };
        adapter = id === 'openai-responses' ? new ResponsesProvider(input) : new OpenAICompatibleProvider(input);
        return adapter;
      };
      // Selected provider errors are reported at startup. Other configured known
      // providers are initialized only if an incoming run chooses them.
      if (id === resolved.provider) providers.push(getAdapter());
      else providers.push({ id, streamTurn: (request, signal) => getAdapter().streamTurn(request, signal) });
    }
    if (options.dbPath !== ':memory:') await mkdir(dirname(options.dbPath), { recursive: true, mode: 0o700 });
    await mkdir(options.artifactDir, { recursive: true, mode: 0o700 });
    const created: HarnessEngine = createEngine({ dbPath: options.dbPath, artifactDir: options.artifactDir, providers, defaults: resolved.runConfig });
    engine = created;
    const result = await runHarness(created, { input: process.stdin, output: process.stdout, diagnostics: process.stderr, signals: process, secrets });
    return result.exitCode;
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Harness startup failed';
    for (const secret of secrets) message = message.split(secret).join('[REDACTED]');
    process.stderr.write(`[moodcode harness] ${message.slice(0, 2_048)}\n`);
    if (engine) { try { await engine.close(); } catch { /* Startup error already reported. */ } }
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const exitCode = await main();
  process.exitCode = exitCode;
  // Failed bounded cleanup must still terminate if a broken adapter retained handles.
  if (exitCode !== 0) process.exit(exitCode);
}
