import type { AppUpdater, UpdateCheckResult } from 'electron-updater';
import type { DesktopAppUpdate, DesktopAppUpdateAction } from '../shared/update-protocol.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export class UpdateError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'UpdateError'; }
}
interface UpdateOptions {
  currentVersion: string;
  enabled: boolean;
  reason?: string;
  /** Must reject unless original utility close ACKs and successful exits are confirmed. */
  closeEngine(): Promise<void>;
  onChange?(view: DesktopAppUpdate): void;
}
type Updater = Pick<AppUpdater, 'autoDownload' | 'autoInstallOnAppQuit' | 'autoRunAppAfterInstall' | 'allowDowngrade' | 'allowPrerelease' | 'disableWebInstaller'
  | 'logger' | 'channel' | 'on' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall'>;
function version(value: unknown): value is string { return typeof value === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value) && value.length <= 64; }
function newer(candidate: string, current: string): boolean {
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) { if (a[index]! !== b[index]!) return a[index]! > b[index]!; }
  return false;
}

/** Explicit download and exact-version installation. Quit and automatic downgrade are disabled. */
export class DesktopUpdates {
  #view: DesktopAppUpdate;
  #result?: UpdateCheckResult;
  #operation?: Promise<DesktopAppUpdate>;
  #cancelled = false;
  constructor(readonly updater: Updater | undefined, readonly options: UpdateOptions) {
    this.#view = { state: updater && options.enabled ? 'idle' : 'disabled', currentVersion: options.currentVersion, channel: 'stable',
      ...(!updater || !options.enabled ? { reason: options.reason ?? 'Updates are enabled in configured release packages.' } : {}) };
    if (!updater) return;
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false; updater.autoRunAppAfterInstall = false;
    updater.channel = 'latest'; updater.allowDowngrade = false; updater.allowPrerelease = false; updater.disableWebInstaller = true;
    updater.logger = null;
    updater.on('download-progress', progress => {
      if (this.#view.state === 'downloading' && !this.#cancelled && Number.isFinite(progress.percent)) this.#set({ progress: Math.max(0, Math.min(100, progress.percent)) });
    });
    // The library emits raw error strings that can contain URLs. Only bounded app-owned errors leave main.
    updater.on('error', () => {
      if (this.#view.state === 'installing') this.#set({ state: 'failed', error: { code: 'UPDATE_INSTALL_FAILED', message: 'Update installation did not confirm success. Reopen the application and check its version before retrying.' } });
    });
  }
  getView(): DesktopAppUpdate { return structuredClone(this.#view); }
  #set(value: Partial<DesktopAppUpdate>): void { this.#view = { ...this.#view, ...value }; this.options.onChange?.(this.getView()); }
  #fail(code: string, message: string): never { throw new UpdateError(code, message); }
  action(input: DesktopAppUpdateAction): Promise<DesktopAppUpdate> {
    if (!input || typeof input !== 'object') return Promise.reject(new UpdateError('UPDATE_INPUT_INVALID', 'The update action is invalid.'));
    const fields = Object.getOwnPropertyDescriptors(input);
    if ((Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      || Reflect.ownKeys(input).some(field => typeof field !== 'string' || !['action', 'version', 'acknowledged'].includes(field))
      || Object.values(fields).some(field => !field.enumerable || !('value' in field))
      || typeof fields.action?.value !== 'string' || !['check', 'download', 'cancel', 'install'].includes(fields.action.value)
      || (fields.version && !version(fields.version.value)) || (fields.acknowledged && fields.acknowledged.value !== true)) {
      return Promise.reject(new UpdateError('UPDATE_INPUT_INVALID', 'The update action is invalid.'));
    }
    if (this.#view.state === 'disabled' || !this.updater) return Promise.reject(new UpdateError('UPDATE_DISABLED', this.#view.reason ?? 'Updates are unavailable.'));
    if (input.action === 'cancel') {
      if (!['checking', 'downloading'].includes(this.#view.state)) return Promise.resolve(this.getView());
      this.#cancelled = true; this.#result?.cancellationToken?.cancel();
      return Promise.resolve(this.getView());
    }
    if (this.#operation) return Promise.reject(new UpdateError('UPDATE_BUSY', 'An update operation is already running.'));
    const operation = this.#perform(input).finally(() => { if (this.#operation === operation) this.#operation = undefined; this.#cancelled = false; });
    this.#operation = operation; return operation;
  }
  async #perform(input: DesktopAppUpdateAction): Promise<DesktopAppUpdate> {
    const updater = this.updater!;
    try {
      if (input.action === 'check') {
        this.#cancelled = false; this.#result = undefined;
        this.#set({ state: 'checking', version: undefined, progress: undefined, error: undefined });
        const result = await updater.checkForUpdates();
        if (this.#cancelled) { result?.cancellationToken?.cancel(); this.#set({ state: 'idle' }); return this.getView(); }
        if (!result || !version(result.updateInfo.version)) this.#fail('UPDATE_METADATA_INVALID', 'The update server returned invalid version metadata.');
        const available = result.isUpdateAvailable && newer(result.updateInfo.version, this.options.currentVersion);
        if (available && !result.cancellationToken) this.#fail('UPDATE_METADATA_INVALID', 'The update could not create a cancellable download.');
        this.#result = result;
        this.#set({ state: available ? 'available' : 'idle', ...(available ? { version: result.updateInfo.version } : {}) });
      } else if (input.action === 'download') {
        if (this.#view.state !== 'available' || !this.#result || input.version !== this.#view.version) this.#fail('UPDATE_STALE', 'Check the available version again before downloading.');
        this.#cancelled = false; this.#set({ state: 'downloading', progress: 0, error: undefined });
        await updater.downloadUpdate(this.#result.cancellationToken);
        this.#set({ state: this.#cancelled ? 'idle' : 'downloaded', version: this.#cancelled ? undefined : this.#view.version, progress: this.#cancelled ? undefined : 100 });
      } else if (input.action === 'install') {
        if (this.#view.state !== 'downloaded' || input.acknowledged !== true || input.version !== this.#view.version) {
          this.#fail('UPDATE_APPROVAL_REQUIRED', 'Approve the exact downloaded version before installing.');
        }
        try { await this.options.closeEngine(); }
        catch { this.#fail('UPDATE_CLEANUP_PENDING', 'The engine has not confirmed cleanup. The downloaded update remains ready for retry.'); }
        this.#set({ state: 'installing', error: undefined });
        updater.quitAndInstall(false, false);
      }
      return this.getView();
    } catch (error) {
      if (this.#cancelled) { this.#result = undefined; this.#set({ state: 'idle', version: undefined, progress: undefined }); return this.getView(); }
      const safe = error instanceof UpdateError ? error : new UpdateError('UPDATE_FAILED', 'The update failed. Retry the check or download; the installed application is unchanged.');
      this.#set({ ...(safe.code === 'UPDATE_CLEANUP_PENDING' ? { state: 'downloaded' as const } : safe.code === 'UPDATE_APPROVAL_REQUIRED' || safe.code === 'UPDATE_STALE' ? {} : { state: 'failed' as const }),
        error: { code: safe.code, message: safe.message }, progress: undefined });
      throw safe;
    }
  }
}

export async function createDesktopUpdates(options: Omit<UpdateOptions, 'enabled'> & { isPackaged: boolean }): Promise<DesktopUpdates> {
  let enabled = false;
  try {
    const bytes = await readFile(fileURLToPath(new URL('./release-policy.json', import.meta.url)), 'utf8');
    if (bytes.length < 4_096) {
      const policy = JSON.parse(bytes);
      enabled = options.isPackaged && policy.schemaVersion === 1 && policy.profile === 'release' && policy.channel === 'stable'
        && policy.provider === 'github' && policy.owner === 'yakisoba0728' && policy.repo === 'Moodcode';
    }
  } catch { /* Development and incomplete release packages leave updates disabled. */ }
  if (!enabled) return new DesktopUpdates(undefined, { ...options, enabled: false, reason: 'Unsigned development packages do not install updates. Use a configured release package.' });
  const module = await import('electron-updater');
  const updater = (module.default as unknown as { autoUpdater: AppUpdater }).autoUpdater;
  return new DesktopUpdates(updater, { ...options, enabled });
}
