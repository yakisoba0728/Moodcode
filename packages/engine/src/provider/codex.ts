import { EngineError } from '@moodcode/contracts';
import { createCodexCredentialReader, type CodexAuthOptions } from '../auth/codex.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { positiveLimit } from './helpers.js';
import { ResponsesProvider, type ResponsesProviderOptions } from './responses.js';

// Existing Codex ChatGPT credentials are scoped to this native Codex route.
// They are not the new Sign in with ChatGPT direct-API grant.
const BASE_URL = 'https://chatgpt.com/backend-api/codex';
const ENDPOINT = BASE_URL + '/responses';
const USER_AGENT = 'Moodcode/0.1.0';

export interface CodexProviderOptions extends Pick<ResponsesProviderOptions,
  'fetch' | 'timeoutMs' | 'maxFrameBytes' | 'maxResponseBytes' | 'maxRequestBytes' |
  'maxToolArgumentBytes' | 'maxToolCalls' | 'maxOutputItems'> {
  /** Main-process file source; never exposed in auth status or engine events. */
  codexHome?: CodexAuthOptions['codexHome'];
  /** Epoch milliseconds; deterministic local auth fixtures only. */
  now?: CodexAuthOptions['now'];
}

function invalidConfiguration(): never {
  throw new EngineError('PROVIDER_INVALID_CONFIG', 'Codex provider configuration is invalid.');
}

/** A native model turn using local Codex auth; the Moodcode runner owns tools. */
export class CodexProvider implements ProviderAdapter {
  readonly id = 'codex';
  readonly replayProtocol = 'codex-responses';
  #reader: ReturnType<typeof createCodexCredentialReader>;
  #fetch: typeof globalThis.fetch;
  #options: Pick<CodexProviderOptions, 'timeoutMs' | 'maxFrameBytes' | 'maxResponseBytes' | 'maxRequestBytes' | 'maxToolArgumentBytes' | 'maxToolCalls' | 'maxOutputItems'>;
  #requestBytes: number;

  constructor(options: CodexProviderOptions = {}) {
    // No configurable destination, header injection or alternate credential.
    for (const forbidden of ['baseURL', 'endpoint', 'apiKey', 'id', 'headers', 'redactionSecrets', 'streamProfile']) {
      if (Object.hasOwn(options, forbidden)) invalidConfiguration();
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function') invalidConfiguration();
    this.#requestBytes = positiveLimit(options.maxRequestBytes, 2_097_152);
    this.#options = {
      timeoutMs: options.timeoutMs, maxFrameBytes: options.maxFrameBytes, maxResponseBytes: options.maxResponseBytes,
      maxRequestBytes: options.maxRequestBytes, maxToolArgumentBytes: options.maxToolArgumentBytes,
      maxToolCalls: options.maxToolCalls, maxOutputItems: options.maxOutputItems,
    };
    // Validate transport limits immediately without reading or caching auth.
    new ResponsesProvider({ ...this.#options, id: this.id, baseURL: BASE_URL, fetch: this.#fetch });
    this.#reader = createCodexCredentialReader({ codexHome: options.codexHome, now: options.now });
  }

  async *streamTurn(request: TurnRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const provider = await this.#reader.use(signal, credential => {
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
        headers.set('Authorization', `Bearer ${credential.accessToken}`);
        headers.set('ChatGPT-Account-ID', credential.accountId);
        headers.set('originator', 'moodcode');
        headers.set('User-Agent', USER_AGENT);
        // Only the fixed OpenAI origin receives credentials; redirects are denied.
        return this.#fetch(ENDPOINT, { ...init, headers, body: serialized, redirect: 'error' });
      };
      return new ResponsesProvider({
        ...this.#options, id: this.id, baseURL: BASE_URL, fetch: transport,
        redactionSecrets: credential.secrets, streamProfile: 'codex',
      });
    });
    yield* provider.streamTurn(request, signal);
  }
}

export function createCodexProvider(options: CodexProviderOptions = {}): CodexProvider {
  return new CodexProvider(options);
}
