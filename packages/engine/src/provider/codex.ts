import { providerSegments } from '../media/segment-provider.js';
import { EngineError } from '@moodcode/contracts';
import { createCodexCredentialReader, type CodexAuthOptions, type CodexCredentialReader } from '../auth/codex.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { positiveLimit } from './helpers.js';
import { ResponsesProvider, type ResponsesProviderOptions } from './responses.js';
import { providerImages } from '../media/provider.js';
import { providerDocuments } from '../documents/provider.js';
import { hostGenerationTransportRequest, validateHostGenerationRequest, type HostGenerationRequest, type ProviderTransportRequest } from './generation.js';

// Codex OAuth credentials use this fixed native route.
const BASE_URL = 'https://chatgpt.com/backend-api/codex';
const ENDPOINT = BASE_URL + '/responses';
const USER_AGENT = 'Moodcode/0.1.0';

export interface CodexProviderOptions extends Pick<ResponsesProviderOptions,
  'fetch' | 'timeoutMs' | 'cleanupTimeoutMs' | 'maxFrameBytes' | 'maxResponseBytes' | 'maxRequestBytes' |
  'maxToolArgumentBytes' | 'maxToolCalls' | 'maxOutputItems'> {
  /** Main-process file source; never exposed in auth status or engine events. */
  codexHome?: CodexAuthOptions['codexHome'];
  /** Epoch milliseconds; deterministic local auth fixtures only. */
  now?: CodexAuthOptions['now'];
  /** Trusted host credential source, kept outside renderer and persisted events. */
  credentialReader?: CodexCredentialReader;
}

function invalidConfiguration(): never {
  throw new EngineError('PROVIDER_INVALID_CONFIG', 'Codex provider configuration is invalid.');
}

/** A native model turn using Codex auth; the Moodcode runner owns tools. */
export class CodexProvider implements ProviderAdapter {
  readonly id = 'codex';
  readonly replayProtocol = 'codex-responses';
  readonly inputModalities = Object.freeze(['text', 'image'] as const);
  readonly inputFileTypes = Object.freeze([] as const);
  #reader: ReturnType<typeof createCodexCredentialReader>;
  #fetch: typeof globalThis.fetch;
  #options: Pick<CodexProviderOptions, 'timeoutMs' | 'cleanupTimeoutMs' | 'maxFrameBytes' | 'maxResponseBytes' | 'maxRequestBytes' | 'maxToolArgumentBytes' | 'maxToolCalls' | 'maxOutputItems'>;
  #requestBytes: number;

  constructor(options: CodexProviderOptions = {}) {
    // Destination and authentication headers remain fixed for every source.
    for (const forbidden of ['baseURL', 'endpoint', 'apiKey', 'id', 'headers', 'redactionSecrets', 'streamProfile', 'pdfModelIds', 'inputFileTypes']) {
      if (Object.hasOwn(options, forbidden)) invalidConfiguration();
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function') invalidConfiguration();
    this.#requestBytes = positiveLimit(options.maxRequestBytes, 2_097_152);
    this.#options = {
      timeoutMs: options.timeoutMs, cleanupTimeoutMs: options.cleanupTimeoutMs, maxFrameBytes: options.maxFrameBytes, maxResponseBytes: options.maxResponseBytes,
      maxRequestBytes: options.maxRequestBytes, maxToolArgumentBytes: options.maxToolArgumentBytes,
      maxToolCalls: options.maxToolCalls, maxOutputItems: options.maxOutputItems,
    };
    // Validate transport limits immediately without reading or caching auth.
    new ResponsesProvider({ ...this.#options, id: this.id, baseURL: BASE_URL, fetch: this.#fetch });
    if (options.credentialReader !== undefined && (typeof options.credentialReader?.use !== 'function'
      || options.codexHome !== undefined || options.now !== undefined)) invalidConfiguration();
    this.#reader = options.credentialReader ?? createCodexCredentialReader({ codexHome: options.codexHome, now: options.now });
  }

  streamTurn(request: TurnRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    return this.#stream(request, signal, provider => provider.streamTurn(request, signal));
  }

  streamGeneration(request: HostGenerationRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const snapshot = validateHostGenerationRequest(request);
    return this.#stream(hostGenerationTransportRequest(snapshot), signal, provider => provider.streamGeneration(snapshot, signal));
  }

  async *#stream(request: ProviderTransportRequest, signal: AbortSignal, delegate: (provider: ResponsesProvider) => AsyncIterable<ProviderEvent>): AsyncGenerator<ProviderEvent> {
    if (signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.');
    // Invalid media must fail before any host credential source is consulted.
    providerDocuments(request, false, signal);
    providerImages(request, true, signal);
    providerSegments(request, () => false, signal);
    const provider = await this.#reader.use(signal, credential => {
      if (typeof credential?.accessToken !== 'string' || !/^[\x21-\x7e]{1,32768}$/.test(credential.accessToken)
        || typeof credential.accountId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(credential.accountId)
        || !Array.isArray(credential.secrets) || credential.secrets.length > 16
        || credential.secrets.some(secret => typeof secret !== 'string' || !/^[\x21-\x7e]{1,65536}$/.test(secret))) invalidConfiguration();
      if (signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.');
      const accessToken = credential.accessToken, accountId = credential.accountId;
      const secrets = [...new Set([accessToken, accountId, ...credential.secrets])];
      const transport: typeof fetch = async (url, init) => {
        if (String(url) !== ENDPOINT || init?.method !== 'POST' || typeof init.body !== 'string' || init.redirect !== 'error') invalidConfiguration();
        // The delegate has already bounded and encoded the full native history.
        const body: unknown = JSON.parse(init.body);
        if (body === null || typeof body !== 'object' || Array.isArray(body)) invalidConfiguration();
        const payload = body as Record<string, unknown>;
        if (!Array.isArray(payload.input) || payload.store !== false || payload.stream !== true) invalidConfiguration();
        payload.input = payload.input.map(item => {
          if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            const native = item as Record<string, unknown>;
            if (native.role === 'system') return { ...native, role: 'developer' };
          }
          return item;
        });
        payload.instructions = '';
        const serialized = JSON.stringify(payload);
        if (Buffer.byteLength(serialized, 'utf8') > this.#requestBytes) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider request exceeds the byte limit.');
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${accessToken}`);
        headers.set('ChatGPT-Account-ID', accountId);
        headers.set('originator', 'moodcode');
        headers.set('User-Agent', USER_AGENT);
        // Only the fixed OpenAI origin receives credentials; redirects are denied.
        return this.#fetch(ENDPOINT, { ...init, headers, body: serialized, redirect: 'error' });
      };
      return new ResponsesProvider({
        ...this.#options, id: this.id, baseURL: BASE_URL, fetch: transport,
        redactionSecrets: secrets, streamProfile: 'codex',
      });
    });
    yield* delegate(provider);
  }
}

export function createCodexProvider(options: CodexProviderOptions = {}): CodexProvider {
  return new CodexProvider(options);
}
