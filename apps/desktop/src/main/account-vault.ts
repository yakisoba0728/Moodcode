import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { CredentialStorage } from './settings.js';
import { AccountError, accountFail } from './account-auth.js';

const MAX_BYTES = 1_048_576;
function digest(bytes: Buffer | null): string | null { return bytes && createHash('sha256').update(bytes).digest('hex'); }
function missing(error: unknown): boolean { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
export function secureStorageAvailable(storage: CredentialStorage): boolean {
  try { return storage.isEncryptionAvailable() && !['basic_text', 'basic', 'plaintext', 'plain_text', 'unknown', 'none'].includes(storage.getSelectedStorageBackend?.() ?? 'available'); }
  catch { return false; }
}

/** One app-owned encrypted file; an exclusive lease serializes rotating credentials across processes. */
export class AccountVault {
  readonly #directory: string;
  readonly #path: string;
  #digest: string | null = null;
  constructor(directory: string, readonly storage: CredentialStorage) {
    this.#directory = resolve(directory); this.#path = join(this.#directory, 'accounts.enc.json');
  }
  available(): boolean { return secureStorageAvailable(this.storage); }
  async #directoryExists(): Promise<boolean> {
    try {
      const info = await lstat(this.#directory);
      if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
        accountFail('ACCOUNT_FILE_UNSAFE', 'Account storage must be a private regular directory.');
      }
      return true;
    } catch (error) { if (missing(error)) return false; if (error instanceof AccountError) throw error; accountFail('ACCOUNT_STORAGE_FAILED', 'Account storage could not be opened.'); }
  }
  async #readBytes(): Promise<Buffer | null> {
    if (!await this.#directoryExists()) return null;
    let handle;
    try {
      const initial = await lstat(this.#path);
      if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size > MAX_BYTES
        || (process.platform !== 'win32' && (initial.mode & 0o077) !== 0)) accountFail('ACCOUNT_FILE_UNSAFE', 'Account storage must be a private regular file.');
      handle = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== initial.ino || opened.dev !== initial.dev) accountFail('ACCOUNT_FILE_CHANGED', 'Account storage changed. Reopen Moodcode.');
      const bytes = Buffer.alloc(MAX_BYTES + 1); let count = 0;
      while (count < bytes.length) { const result = await handle.read(bytes, count, bytes.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
      const final = await handle.stat();
      if (count > MAX_BYTES || count !== final.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs || !await this.#directoryExists()) {
        accountFail('ACCOUNT_FILE_CHANGED', 'Account storage changed. Reopen Moodcode.');
      }
      return bytes.subarray(0, count);
    } catch (error) { if (missing(error)) return null; if (error instanceof AccountError) throw error; return accountFail('ACCOUNT_STORAGE_FAILED', 'Account storage could not be read.'); }
    finally { await handle?.close(); }
  }
  async load(): Promise<unknown | undefined> {
    const bytes = await this.#readBytes(); this.#digest = digest(bytes);
    if (!bytes) return undefined;
    if (!this.available()) accountFail('ACCOUNT_SECURE_STORAGE_REQUIRED', 'Unlock the operating system credential storage before using accounts.');
    try {
      const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (envelope.schemaVersion !== 1 || Object.keys(envelope).some(field => !['schemaVersion', 'encrypted'].includes(field))
        || typeof envelope.encrypted !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(envelope.encrypted)) throw new Error();
      const encrypted = Buffer.from(envelope.encrypted, 'base64');
      if (encrypted.toString('base64') !== envelope.encrypted || encrypted.length > MAX_BYTES) throw new Error();
      return JSON.parse(this.storage.decryptString(encrypted));
    } catch { accountFail('ACCOUNT_DECRYPT_FAILED', 'Saved accounts could not be unlocked. Restore credential storage before retrying.'); }
  }
  async pendingRefresh(): Promise<string | undefined> {
    const path = join(this.#directory, 'refresh.pending.json');
    let handle;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 256
        || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) accountFail('ACCOUNT_FILE_UNSAFE', 'The account refresh marker is invalid.');
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const bytes = Buffer.alloc(257), result = await handle.read(bytes, 0, bytes.length, 0);
      const opened = await handle.stat();
      if (opened.ino !== info.ino || opened.dev !== info.dev || result.bytesRead !== info.size) throw new Error();
      const record = JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8'));
      if (record.schemaVersion !== 1 || typeof record.accountId !== 'string' || !/^[a-f0-9-]{36}$/u.test(record.accountId)
        || Object.keys(record).some(key => !['schemaVersion', 'accountId'].includes(key))) throw new Error();
      return record.accountId;
    } catch (error) { if (missing(error)) return undefined; if (error instanceof AccountError) throw error; return accountFail('ACCOUNT_FILE_UNSAFE', 'The account refresh marker is invalid.'); }
    finally { await handle?.close(); }
  }
  async beginRefresh(accountId: string): Promise<void> {
    if (await this.pendingRefresh()) accountFail('ACCOUNT_REAUTH_REQUIRED', 'An earlier token renewal did not confirm persistence. Sign in again.');
    const handle = await open(join(this.#directory, 'refresh.pending.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, accountId })); await handle.sync(); } finally { await handle.close(); }
  }
  async finishRefresh(accountId: string): Promise<void> {
    const pending = await this.pendingRefresh();
    if (pending === accountId) await unlink(join(this.#directory, 'refresh.pending.json'));
  }
  async lease<T>(operation: () => Promise<T>): Promise<T> {
    if (!await this.#directoryExists()) await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    if (!await this.#directoryExists()) accountFail('ACCOUNT_STORAGE_FAILED', 'Account storage could not be created.');
    const path = join(this.#directory, '.accounts.lock');
    let lock;
    try { lock = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { accountFail('ACCOUNT_STORAGE_BUSY', 'Another account operation is using this storage. Close other Moodcode instances before retrying.'); }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync();
      if (digest(await this.#readBytes()) !== this.#digest) accountFail('ACCOUNT_FILE_CHANGED', 'Saved accounts changed in another instance. Reopen Moodcode.');
      return await operation();
    } finally { await lock.close(); await unlink(path).catch(() => undefined); }
  }
  async save(value: unknown): Promise<void> {
    if (!this.available()) accountFail('ACCOUNT_SECURE_STORAGE_REQUIRED', 'Unlock the operating system credential storage before saving accounts.');
    let temporary: string | undefined;
    try {
      const plain = JSON.stringify(value);
      if (Buffer.byteLength(plain) > 524_288) accountFail('ACCOUNT_STORAGE_LIMIT', 'The saved account limit was reached.');
      const encrypted = this.storage.encryptString(plain);
      if (!Buffer.isBuffer(encrypted) || encrypted.length > 700_000) throw new Error();
      const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, encrypted: encrypted.toString('base64') })}\n`);
      if (digest(await this.#readBytes()) !== this.#digest) accountFail('ACCOUNT_FILE_CHANGED', 'Saved accounts changed in another instance. Reopen Moodcode.');
      temporary = join(this.#directory, `.accounts-${randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      if (!await this.#directoryExists() || digest(await this.#readBytes()) !== this.#digest) accountFail('ACCOUNT_FILE_CHANGED', 'Saved accounts changed before they could be saved.');
      await rename(temporary, this.#path); temporary = undefined; this.#digest = digest(bytes);
      let directory;
      try { directory = await open(this.#directory, constants.O_RDONLY | constants.O_NOFOLLOW); await directory.sync(); }
      catch { /* Rename committed the new encrypted record; some filesystems cannot sync directory handles. */ }
      finally { await directory?.close(); }
    } catch (error) { if (error instanceof AccountError) throw error; accountFail('ACCOUNT_STORAGE_FAILED', 'Accounts could not be saved. Previous credentials remain available.'); }
    finally { if (temporary) await unlink(temporary).catch(() => undefined); }
  }
}
