import { REASONING_EFFORTS, type ReasoningEffort } from '@moodcode/contracts';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { DesktopProviderId, DesktopSettings, SaveDesktopSettings } from '../shared/protocol.js';
import { ANTHROPIC_REASONING_EFFORTS } from '../shared/protocol.js';
import type { PrivateAccountCredential } from './accounts.js';

const MAX_FILE_BYTES = 32_768;
const MAX_KEY_BYTES = 4_096;
const MAX_CIPHERTEXT_BYTES = 16_384;
const PROVIDERS: readonly DesktopProviderId[] = ['scripted', 'openai-compatible', 'openai-responses', 'anthropic', 'codex'];

export interface DesktopCodexAuth {
  available: boolean;
  state: NonNullable<DesktopSettings['codexAuthState']>;
  modelId?: string;
  models?: NonNullable<DesktopSettings['codexModels']>;
}

export interface CredentialStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export interface SettingsStoreOptions {
  directory: string;
  safeStorage: CredentialStorage;
  environment?: Readonly<Record<string, string | undefined>>;
  /** Sanitized metadata only. This store never reads Codex tokens. */
  codexAuth?: () => DesktopCodexAuth;
  /** Selected OAuth bearer, resolved in main before engine configuration. */
  accountCredential?: () => PrivateAccountCredential | undefined;
}

export interface DesktopEngineConfig {
  readonly providerId: DesktopProviderId;
  readonly modelId: string;
  readonly baseURL: string;
  readonly anthropicWorkspaceId?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly apiKey?: string;
  readonly codexCredential?: Readonly<{ accessToken: string; accountId: string; secrets: readonly string[] }>;
}

/** Only `view` may be returned through renderer IPC. engineConfig stays in main/utility. */
export interface ResolvedDesktopSettings {
  readonly view: DesktopSettings;
  readonly engineConfig: DesktopEngineConfig;
}

/** An opaque, immutable candidate; preparing it never changes persisted settings. */
export interface PreparedSettings extends ResolvedDesktopSettings {}

export class SettingsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
  }
}

interface StoredCredential {
  providerId: Exclude<DesktopProviderId, 'scripted' | 'codex'>;
  encryptedKey: string;
}
interface StoredSettings {
  schemaVersion: 1;
  providerId: DesktopProviderId;
  modelId: string;
  baseURL: string;
  anthropicWorkspaceId?: string;
  credential?: StoredCredential;
  reasoningEffort?: ReasoningEffort;
  credentialMode?: 'api-key' | 'chatgpt';
  accountId?: string;
}
interface Candidate {
  revision: number;
  document: StoredSettings;
  resolved: PreparedSettings;
}

function fail(code: string, message: string): never { throw new SettingsError(code, message); }
function invalid(field: string): never {
  fail('SETTINGS_INVALID', `Desktop settings ${field} is invalid.`);
}
function fsCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}

function dataObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object') invalid('input');
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) invalid('input');
    descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !fields.includes(key))) invalid('input');
  } catch { invalid('input'); }
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) invalid('input');
    result[key] = descriptor.value;
  }
  return result;
}

function provider(value: unknown): DesktopProviderId {
  if (typeof value !== 'string' || !PROVIDERS.includes(value as DesktopProviderId)) invalid('providerId');
  return value as DesktopProviderId;
}

function configFields(input: Record<string, unknown>): Pick<StoredSettings, 'providerId' | 'modelId' | 'baseURL' | 'anthropicWorkspaceId' | 'reasoningEffort' | 'credentialMode' | 'accountId'> {
  const providerId = provider(input.providerId);
  if (typeof input.modelId !== 'string' || input.modelId.length === 0 || input.modelId.trim() !== input.modelId
    || Buffer.byteLength(input.modelId) > 512 || /[\u0000-\u001f\u007f]/u.test(input.modelId)) invalid('modelId');
  if (typeof input.baseURL !== 'string' || Buffer.byteLength(input.baseURL) > 2_048
    || input.baseURL.trim() !== input.baseURL || /[\u0000-\u0020\u007f]/u.test(input.baseURL)) invalid('baseURL');
  if (providerId === 'scripted' || providerId === 'codex') {
    if (input.baseURL !== '') invalid('baseURL');
  } else {
    let url: URL;
    try { url = new URL(input.baseURL); } catch { invalid('baseURL'); }
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || input.baseURL.includes('?') || input.baseURL.includes('#')) invalid('baseURL');
  }
  const effort = input.reasoningEffort;
  if (Object.hasOwn(input, 'reasoningEffort') && (effort === undefined || !REASONING_EFFORTS.includes(effort as ReasoningEffort) || !['codex', 'openai-responses', 'anthropic'].includes(providerId)
    || providerId === 'anthropic' && !ANTHROPIC_REASONING_EFFORTS.includes(effort as typeof ANTHROPIC_REASONING_EFFORTS[number]))) invalid('reasoningEffort');
  const workspace = input.anthropicWorkspaceId;
  if (Object.hasOwn(input, 'anthropicWorkspaceId') && (providerId !== 'anthropic' || typeof workspace !== 'string' || !/^wrkspc_[A-Za-z0-9]{1,128}$/u.test(workspace))) invalid('anthropicWorkspaceId');
  const mode = input.credentialMode;
  if (mode !== undefined && mode !== 'api-key' && mode !== 'chatgpt') invalid('credentialMode');
  if (mode === 'chatgpt') {
    if (providerId !== 'codex' || typeof input.accountId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(input.accountId)) invalid('accountId');
  } else if (mode === 'api-key' && providerId === 'codex') invalid('credentialMode');
  else if (input.accountId !== undefined) invalid('accountId');
  return { providerId, modelId: input.modelId, baseURL: input.baseURL, ...(effort === undefined ? {} : { reasoningEffort: effort as ReasoningEffort }),
    ...(workspace === undefined ? {} : { anthropicWorkspaceId: workspace as string }),
    ...(mode === undefined ? {} : { credentialMode: mode }), ...(mode === 'chatgpt' ? { accountId: input.accountId as string } : {}) };
}

function key(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.trim() !== value
    || Buffer.byteLength(value) > MAX_KEY_BYTES || /[\u0000-\u0020\u007f]/u.test(value)) invalid('credential');
  return value;
}

function parseDocument(value: unknown): StoredSettings {
  const input = dataObject(value, ['schemaVersion', 'providerId', 'modelId', 'baseURL', 'anthropicWorkspaceId', 'credential', 'reasoningEffort', 'credentialMode', 'accountId']);
  if (input.schemaVersion !== 1) invalid('schemaVersion');
  // Old SIWC selections must reauthenticate through the native Codex account lane.
  // Reading the selection never rewrites it or discards its retained API key.
  if (input.providerId === 'openai-responses' && input.credentialMode === 'chatgpt') {
    if (typeof input.baseURL !== 'string' || !['https://api.openai.com/v1', 'https://api.openai.com/v1/'].includes(input.baseURL)) invalid('baseURL');
    input.providerId = 'codex'; input.baseURL = '';
  } else if (input.providerId === 'codex' && input.credentialMode === 'api-key') delete input.credentialMode;
  const result: StoredSettings = { schemaVersion: 1, ...configFields(input) };
  if (Object.hasOwn(input, 'credential')) {
    const credential = dataObject(input.credential, ['providerId', 'encryptedKey']);
    const credentialProvider = provider(credential.providerId);
    if (credentialProvider === 'scripted' || credentialProvider === 'codex') invalid('credential');
    if (typeof credential.encryptedKey !== 'string' || !credential.encryptedKey.length
      || credential.encryptedKey.length > Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(credential.encryptedKey)) invalid('credential');
    const bytes = Buffer.from(credential.encryptedKey, 'base64');
    if (!bytes.length || bytes.length > MAX_CIPHERTEXT_BYTES || bytes.toString('base64') !== credential.encryptedKey) invalid('credential');
    result.credential = { providerId: credentialProvider, encryptedKey: credential.encryptedKey };
  }
  return result;
}

function freezeResolved(view: DesktopSettings, engineConfig: DesktopEngineConfig): ResolvedDesktopSettings {
  // Accidental JSON serialization of a candidate cannot expose its private key.
  const result = { view: Object.freeze({ ...view }) } as ResolvedDesktopSettings;
  Object.defineProperty(result, 'engineConfig', { value: Object.freeze({ ...engineConfig }), enumerable: false });
  return Object.freeze(result);
}

function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

/** A main-process settings transaction. Encrypted credentials are bound to one provider ID. */
export class SettingsStore {
  readonly #directory: string;
  readonly #path: string;
  readonly #storage: CredentialStorage;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #codexAuth: (() => DesktopCodexAuth) | undefined;
  readonly #accountCredential: (() => PrivateAccountCredential | undefined) | undefined;
  readonly #candidates = new WeakMap<PreparedSettings, Candidate>();
  #document: StoredSettings = { schemaVersion: 1, providerId: 'scripted', modelId: 'local', baseURL: '' };
  #view: DesktopSettings;
  #revision = 0;
  #loaded = false;
  #diskDigest: string | null = null;
  #operation: Promise<unknown> = Promise.resolve();

  constructor(options: SettingsStoreOptions) {
    if (typeof options.directory !== 'string' || !options.directory.length || options.directory.length > 4_096
      || /[\u0000-\u001f\u007f]/u.test(options.directory)) invalid('directory');
    this.#directory = resolve(options.directory);
    this.#path = join(this.#directory, 'settings.json');
    this.#storage = options.safeStorage;
    this.#environment = options.environment ?? process.env;
    this.#codexAuth = options.codexAuth;
    this.#accountCredential = options.accountCredential;
    this.#view = this.#makeView(this.#document, 'none');
  }

  getView(): DesktopSettings { return structuredClone(this.#view); }
  refreshView(): DesktopSettings { this.#view = this.#makeView(this.#document, this.#view.keySource); return this.getView(); }

  load(): Promise<ResolvedDesktopSettings> {
    return this.#exclusive(() => this.#load());
  }

  prepare(input: SaveDesktopSettings): Promise<PreparedSettings> {
    return this.#exclusive(async () => {
      if (!this.#loaded) await this.#load();
      const fields = dataObject(input, ['providerId', 'modelId', 'baseURL', 'anthropicWorkspaceId', 'apiKey', 'clearKey', 'reasoningEffort', 'credentialMode', 'accountId']);
      if (fields.providerId === 'codex' && (fields.modelId === '' || fields.modelId === undefined)) {
        fields.modelId = fields.credentialMode === 'chatgpt' ? this.#account()?.models[0]?.id : this.#auth().modelId;
        if (!fields.modelId) fail('SETTINGS_CODEX_MODEL_REQUIRED', 'The Codex provider requires an explicit model identifier.');
      }
      const config = configFields(fields);
      const knownModel = this.#auth().models?.find(model => model.id === config.modelId);
      if (config.providerId === 'codex' && config.credentialMode !== 'chatgpt' && config.reasoningEffort && knownModel && !knownModel.reasoningEfforts.includes(config.reasoningEffort)) invalid('reasoningEffort');
      if (fields.clearKey !== undefined && typeof fields.clearKey !== 'boolean') invalid('clearKey');
      if (fields.apiKey !== undefined && fields.clearKey === true) invalid('credential');
      const document: StoredSettings = { schemaVersion: 1, ...config };
      if (fields.clearKey !== true && this.#document.credential) document.credential = { ...this.#document.credential };
      if (fields.apiKey !== undefined) {
        if (config.providerId === 'scripted' || config.providerId === 'codex' || config.credentialMode === 'chatgpt') invalid('credential');
        const plainKey = key(fields.apiKey);
        if (!this.#storageAvailable()) fail('SETTINGS_CREDENTIAL_STORAGE_UNAVAILABLE', 'Secure credential storage is unavailable. Use a credential environment variable.');
        let encrypted: Buffer;
        try { encrypted = this.#storage.encryptString(plainKey); }
        catch { fail('SETTINGS_CREDENTIAL_ENCRYPT_FAILED', 'The credential could not be encrypted.'); }
        if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_CIPHERTEXT_BYTES) {
          fail('SETTINGS_CREDENTIAL_ENCRYPT_FAILED', 'The credential could not be encrypted.');
        }
        document.credential = { providerId: config.providerId, encryptedKey: encrypted.toString('base64') };
      }
      const resolved = this.#resolve(document);
      this.#candidates.set(resolved, { revision: this.#revision, document, resolved });
      return resolved;
    });
  }

  commit(prepared: PreparedSettings): Promise<ResolvedDesktopSettings> {
    return this.#exclusive(async () => {
      const candidate = this.#candidates.get(prepared);
      if (!candidate || candidate.revision !== this.#revision) {
        fail('SETTINGS_STALE', 'The prepared settings are stale or belong to another store.');
      }
      let temporary: string | undefined;
      try {
        await this.#ensureDirectory();
        const current = await this.#read();
        if ((current === null ? null : digest(current)) !== this.#diskDigest) {
          fail('SETTINGS_CHANGED', 'The settings file changed before the update could be committed.');
        }
        const bytes = Buffer.from(`${JSON.stringify(candidate.document)}\n`);
        if (bytes.length > MAX_FILE_BYTES) fail('SETTINGS_FILE_LIMIT', 'The settings file exceeds its size limit.');
        temporary = join(this.#directory, `.settings-${randomUUID()}.tmp`);
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          await handle.chmod(0o600);
          await handle.writeFile(bytes);
          await handle.sync();
        } finally { await handle.close(); }
        await this.#checkDirectory();
        const beforeRename = await this.#read();
        if ((beforeRename === null ? null : digest(beforeRename)) !== this.#diskDigest) {
          fail('SETTINGS_CHANGED', 'The settings file changed before the update could be committed.');
        }
        await rename(temporary, this.#path);
        temporary = undefined;
        // Rename is the commit point. Best-effort directory sync cannot turn it into a failed transaction.
        await this.#syncDirectory();
        this.#document = candidate.document;
        this.#diskDigest = digest(bytes);
        this.#view = { ...candidate.resolved.view };
        this.#revision += 1;
        this.#loaded = true;
        this.#candidates.delete(prepared);
        return candidate.resolved;
      } catch (error) {
        if (error instanceof SettingsError) throw error;
        fail('SETTINGS_WRITE_FAILED', 'Desktop settings could not be saved. The previous settings were retained.');
      } finally {
        if (temporary !== undefined) await unlink(temporary).catch(() => undefined);
      }
    });
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#operation.then(operation, operation);
    this.#operation = next.then(() => undefined, () => undefined);
    return next;
  }

  async #load(): Promise<ResolvedDesktopSettings> {
    const bytes = await this.#read();
    let document: StoredSettings;
    if (bytes === null) {
      const auth = this.#auth();
      if (auth.available) {
        if (!auth.modelId) fail('SETTINGS_CODEX_MODEL_REQUIRED', 'The Codex provider requires an explicit model identifier.');
        document = { schemaVersion: 1, ...configFields({ providerId: 'codex', modelId: auth.modelId, baseURL: '' }) };
      } else document = { schemaVersion: 1, providerId: 'scripted', modelId: 'local', baseURL: '' };
    }
    else {
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { fail('SETTINGS_JSON', 'Desktop settings must contain valid UTF-8 JSON.'); }
      document = parseDocument(parsed);
    }
    this.#document = document;
    this.#diskDigest = bytes === null ? null : digest(bytes);
    this.#revision += 1;
    this.#loaded = true;
    // Keep selected-provider metadata available for the recovery UI if key resolution fails.
    this.#view = this.#makeView(document, 'none');
    const resolved = this.#resolve(document);
    this.#view = { ...resolved.view };
    return resolved;
  }

  #storageAvailable(): boolean {
    try {
      if (!this.#storage.isEncryptionAvailable()) return false;
      const backend = this.#storage.getSelectedStorageBackend?.();
      return backend === undefined || !['basic_text', 'basic', 'plaintext', 'plain_text', 'unknown', 'none'].includes(backend);
    } catch { return false; }
  }

  #makeView(document: StoredSettings, keySource: DesktopSettings['keySource']): DesktopSettings {
    const view: DesktopSettings = {
      providerId: document.providerId, modelId: document.modelId, baseURL: document.baseURL,
      ...(document.anthropicWorkspaceId ? { anthropicWorkspaceId: document.anthropicWorkspaceId } : {}),
      keyConfigured: keySource !== 'none', keySource,
      credentialStorage: this.#storageAvailable() ? 'available' : 'unavailable',
      ...(document.reasoningEffort ? { reasoningEffort: document.reasoningEffort } : {}),
      ...(document.credentialMode ? { credentialMode: document.credentialMode } : {}),
      ...(document.accountId ? { accountId: document.accountId } : {}),
    };
    if (document.providerId === 'codex' && document.credentialMode === 'chatgpt') {
      const available = keySource === 'chatgpt' && this.#account()?.accountId === document.accountId;
      view.keyConfigured = available; view.keySource = available ? 'chatgpt' : 'none';
      view.codexAuthState = available ? 'available' : 'missing';
    } else if (this.#codexAuth || document.providerId === 'codex') {
      const auth = this.#auth();
      view.codexAuthState = auth.state;
      if (auth.modelId) view.codexModelId = auth.modelId;
      if (auth.models) view.codexModels = structuredClone(auth.models);
    }
    return view;
  }

  #auth(): DesktopCodexAuth {
    try {
      const auth = this.#codexAuth?.();
      if (!auth) return { available: false, state: 'missing' };
      if (!['available', 'missing', 'expired', 'unreadable'].includes(auth.state)) return { available: false, state: 'unreadable' };
      if (auth.available !== (auth.state === 'available')) return { available: false, state: 'unreadable' };
      const validModel = typeof auth.modelId === 'string' && auth.modelId.length > 0 && auth.modelId.trim() === auth.modelId
        && Buffer.byteLength(auth.modelId) <= 512 && !/[\u0000-\u001f\u007f]/u.test(auth.modelId);
      return { available: auth.available, state: auth.state, ...(validModel ? { modelId: auth.modelId } : {}), ...(auth.models ? { models: auth.models } : {}) };
    } catch { return { available: false, state: 'unreadable' }; }
  }

  #account(): PrivateAccountCredential | undefined {
    try { return this.#accountCredential?.(); } catch { return undefined; }
  }

  #resolve(document: StoredSettings): ResolvedDesktopSettings {
    const engineConfig: { providerId: DesktopProviderId; modelId: string; baseURL: string; anthropicWorkspaceId?: string; apiKey?: string; reasoningEffort?: ReasoningEffort; codexCredential?: DesktopEngineConfig['codexCredential'] } = {
      providerId: document.providerId, modelId: document.modelId, baseURL: document.baseURL,
      ...(document.anthropicWorkspaceId ? { anthropicWorkspaceId: document.anthropicWorkspaceId } : {}),
      ...(document.reasoningEffort ? { reasoningEffort: document.reasoningEffort } : {}),
    };
    let source: DesktopSettings['keySource'] = 'none';
    if (document.providerId === 'codex') {
      if (document.credentialMode === 'chatgpt') {
        const account = this.#account();
        if (!account || account.accountId !== document.accountId || account.baseURL !== 'https://chatgpt.com/backend-api/codex'
          || typeof account.apiKey !== 'string' || !/^[\u0021-\u007e]{1,16384}$/u.test(account.apiKey)
          || typeof account.chatgptAccountId !== 'string' || !/^[\u0021-\u007e]{1,256}$/u.test(account.chatgptAccountId)
          || !Array.isArray(account.secrets) || account.secrets.length > 16 || account.secrets.some(secret => typeof secret !== 'string' || !/^[\u0021-\u007e]{1,65536}$/u.test(secret))) {
          fail('SETTINGS_ACCOUNT_AUTH_REQUIRED', 'The selected ChatGPT account is unavailable. Sign in again with Codex or select local Codex authentication.');
        }
        if (!account.models.some(model => model.id === document.modelId)) fail('SETTINGS_ACCOUNT_MODEL_REQUIRED', 'Choose a model offered by the selected ChatGPT account.');
        const secrets = Object.freeze([...new Set([account.apiKey, account.chatgptAccountId, ...account.secrets])]);
        if (secrets.length > 16) fail('SETTINGS_ACCOUNT_AUTH_REQUIRED', 'The selected ChatGPT credential is invalid. Sign in again with Codex.');
        if (secrets.some(secret => secret && document.modelId.includes(secret))) invalid('modelId');
        engineConfig.codexCredential = Object.freeze({ accessToken: account.apiKey, accountId: account.chatgptAccountId, secrets });
        return freezeResolved(this.#makeView(document, 'chatgpt'), engineConfig);
      }
      if (!this.#auth().available) fail('SETTINGS_CODEX_AUTH_REQUIRED', 'Codex authentication is unavailable. Sign in to Codex and retry, or explicitly select another provider.');
      source = 'codex';
    } else if (document.providerId !== 'scripted') {
      const environmentKey = this.#environment.MOODCODE_API_KEY || (document.providerId === 'anthropic' ? this.#environment.ANTHROPIC_API_KEY : this.#environment.OPENAI_API_KEY);
      if (environmentKey) {
        try { engineConfig.apiKey = key(environmentKey); }
        catch { fail('SETTINGS_ENVIRONMENT_CREDENTIAL_INVALID', 'The configured credential environment variable is invalid.'); }
        source = 'environment';
      } else if (document.credential?.providerId === document.providerId) {
        if (!this.#storageAvailable()) fail('SETTINGS_CREDENTIAL_STORAGE_UNAVAILABLE', 'Secure credential storage is unavailable. Use a credential environment variable.');
        try { engineConfig.apiKey = key(this.#storage.decryptString(Buffer.from(document.credential.encryptedKey, 'base64'))); }
        catch { fail('SETTINGS_CREDENTIAL_DECRYPT_FAILED', 'The stored credential could not be decrypted. Enter a new credential or use a credential environment variable.'); }
        source = 'stored';
      } else {
        fail('SETTINGS_KEY_REQUIRED', `The selected provider requires its own credential. Enter a credential or set MOODCODE_API_KEY or ${document.providerId === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}.`);
      }
    }
    if (engineConfig.apiKey && document.anthropicWorkspaceId?.includes(engineConfig.apiKey)) invalid('anthropicWorkspaceId');
    return freezeResolved(this.#makeView(document, source), engineConfig);
  }

  async #checkDirectory(): Promise<boolean> {
    try {
      const info = await lstat(this.#directory);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('SETTINGS_FILE_TYPE', 'The settings directory must be a regular directory without a symbolic link.');
      return true;
    } catch (error) {
      if (error instanceof SettingsError) throw error;
      if (fsCode(error) === 'ENOENT') return false;
      fail('SETTINGS_READ_FAILED', 'The settings directory could not be read.');
    }
  }

  async #ensureDirectory(): Promise<void> {
    if (!await this.#checkDirectory()) await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    if (!await this.#checkDirectory()) fail('SETTINGS_WRITE_FAILED', 'The settings directory could not be created.');
    await chmod(this.#directory, 0o700);
  }

  async #read(): Promise<Buffer | null> {
    if (!await this.#checkDirectory()) return null;
    let handle;
    try {
      const initial = await lstat(this.#path);
      if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) {
        fail('SETTINGS_FILE_TYPE', 'Desktop settings must be a regular file without symbolic or hard links.');
      }
      if (initial.size > MAX_FILE_BYTES) fail('SETTINGS_FILE_LIMIT', 'The settings file exceeds its size limit.');
      if (process.platform !== 'win32' && (initial.mode & 0o077) !== 0) {
        fail('SETTINGS_FILE_PERMISSIONS', 'Desktop settings must be accessible only by their owner.');
      }
      handle = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== initial.ino || opened.dev !== initial.dev) {
        fail('SETTINGS_FILE_TYPE', 'The settings file changed while it was being opened.');
      }
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      let count = 0;
      while (count < bytes.length) {
        const part = await handle.read(bytes, count, bytes.length - count, count);
        if (!part.bytesRead) break;
        count += part.bytesRead;
      }
      if (count > MAX_FILE_BYTES) fail('SETTINGS_FILE_LIMIT', 'The settings file exceeds its size limit.');
      const final = await handle.stat();
      if (opened.size !== final.size || opened.mtimeMs !== final.mtimeMs || opened.ctimeMs !== final.ctimeMs || final.size !== count) {
        fail('SETTINGS_CHANGED', 'The settings file changed while it was being read.');
      }
      if (!await this.#checkDirectory()) fail('SETTINGS_CHANGED', 'The settings directory changed while it was being read.');
      return bytes.subarray(0, count);
    } catch (error) {
      if (error instanceof SettingsError) throw error;
      if (fsCode(error) === 'ENOENT') return null;
      if (['ELOOP', 'ENOTDIR'].includes(fsCode(error) ?? '')) fail('SETTINGS_FILE_TYPE', 'Desktop settings must not use symbolic links or non-directory paths.');
      return fail('SETTINGS_READ_FAILED', 'Desktop settings could not be read.');
    } finally { await handle?.close(); }
  }

  async #syncDirectory(): Promise<void> {
    let directory;
    try {
      directory = await open(this.#directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      await directory.sync();
    } catch { /* Some filesystems do not support syncing directory handles. */ }
    finally { await directory?.close().catch(() => undefined); }
  }
}
