import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell, utilityProcess } from 'electron';
import { getCodexAuthStatus, getCodexModelCatalog } from '@moodcode/engine';
import { validateClipboardText } from '../shared/clipboard.js';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { CommandEnvelope, Workspace } from '@moodcode/contracts';
import { DesktopHost, HostError, type UtilityTransport } from './host.js';
import { DESKTOP_CHANNELS, type DesktopIpcResult } from './ipc-channels.js';
import { assertTrustedSender, installNavigationGuards, validateExternalURL } from './security.js';
import { SettingsStore, type CredentialStorage, type DesktopCodexAuth } from './settings.js';
import type { SaveDesktopSettings } from '../shared/protocol.js';
import { DesktopAccounts } from './accounts.js';
import { createAccountFixtureTransport } from './account-fixture.js';
import { createDesktopUpdates, type DesktopUpdates } from './updates.js';
import type { DesktopAccountAction } from '../shared/account-protocol.js';
import type { DesktopAppUpdateAction } from '../shared/update-protocol.js';

const bundleDirectory = dirname(fileURLToPath(import.meta.url));
const rendererPath = join(bundleDirectory, '../renderer/index.html');
const rendererURL = pathToFileURL(rendererPath).href;
const testLaunch = !app.isPackaged && (process.env.MOODCODE_DESKTOP_TEST === '1' || process.env.MOODCODE_DESKTOP_TEST_LAUNCH === '1');
const scenario = testLaunch && (process.env.MOODCODE_DESKTOP_TEST_SCENARIO === 'coding' || process.env.MOODCODE_DESKTOP_TEST_SCENARIO === 'slow' || process.env.MOODCODE_DESKTOP_TEST_SCENARIO === 'advanced' || process.env.MOODCODE_DESKTOP_TEST_SCENARIO === 'account')
  ? process.env.MOODCODE_DESKTOP_TEST_SCENARIO : undefined;

const override = process.env.MOODCODE_DESKTOP_USER_DATA;
if (override) {
  if (!isAbsolute(override) || override.length > 4096 || /[\u0000-\u001f]/.test(override)) throw new HostError('INVALID_USER_DATA', 'Desktop user data override must be an absolute directory path.');
  mkdirSync(override, { recursive: true, mode: 0o700 });
  app.setPath('userData', override);
}
app.setName('Moodcode');
let window: BrowserWindow | undefined;
let ownerId = randomUUID();
let host: DesktopHost | undefined;
let accounts: DesktopAccounts | undefined;
let updates: DesktopUpdates | undefined;
let refreshSettingsMetadata: (() => Promise<void>) | undefined;
let bindSelectedAccount: ((view: import('../shared/account-protocol.js').DesktopAccountView) => Promise<void>) | undefined;
let quitting = false;
let quitPending = false;

let authMetadata: DesktopCodexAuth = { available: false, state: 'missing' };
/** The adapter exposes auth metadata only; the provider reads tokens in utility. */
async function refreshCodexAuth(): Promise<void> {
  if (scenario) { authMetadata = { available: false, state: 'missing' }; return; }
  try {
    const [value, models] = await Promise.all([getCodexAuthStatus(), getCodexModelCatalog()]);
    if (!value || typeof value !== 'object') { authMetadata = { available: false, state: 'unreadable' }; return; }
    const status = value as { available?: boolean; state?: string; modelId?: string };
    const state = status.state === 'ready' || status.state === 'available' ? 'available'
      : status.state === 'missing' || status.state === 'expired' || status.state === 'unreadable' ? status.state : 'unreadable';
    authMetadata = { available: state === 'available', state, models, ...(typeof status.modelId === 'string' ? { modelId: status.modelId } : {}) };
  } catch { authMetadata = { available: false, state: 'unreadable' }; }
}
function spawnWorker(): UtilityTransport {
  const child = utilityProcess.fork(join(bundleDirectory, 'engine-worker.js'), [], {
    serviceName: 'Moodcode Engine', stdio: 'pipe',
    // The utility provider resolves Codex authentication itself; API credentials
    // travel only in the private start RPC.
  });
  // Drain diagnostics without forwarding potentially sensitive provider output.
  child.stdout?.resume();
  child.stderr?.resume();
  return {
    diagnosticSource: 'original-electron-utility',
    postMessage: request => child.postMessage(request),
    onMessage: listener => { child.on('message', listener); return () => { child.off('message', listener); }; },
    onExit: listener => { child.on('exit', listener); return () => { child.off('exit', listener); }; },
  };
}
function publicFailure(error: unknown): { code: string; message: string } {
  const value = error as { code?: unknown; message?: unknown } | undefined;
  const code = typeof value?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ? value.code : 'DESKTOP_OPERATION_FAILED';
  // Owned layers return sanitized HostError/SettingsError messages. Unknown
  // native exceptions can include paths or credentials and are replaced.
  const message = code !== 'DESKTOP_OPERATION_FAILED' && typeof value?.message === 'string' ? value.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1024) : 'The desktop operation could not be completed.';
  return { code, message };
}
function handle(channel: string, action: (args: unknown[], owner: string) => Promise<unknown>): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<DesktopIpcResult> => {
    try {
      if (!window) throw new HostError('IPC_FORBIDDEN', 'The desktop window is unavailable.');
      assertTrustedSender(event, window.webContents, rendererURL);
      return { ok: true, value: await action(args, ownerId) };
    } catch (error) { return { ok: false, error: publicFailure(error) }; }
  });
}
function requireHost(): DesktopHost {
  if (!host) throw new HostError('HOST_NOT_READY', 'Desktop engine is starting.');
  return host;
}
function installIpc(): void {
  handle(DESKTOP_CHANNELS.bootstrap, async () => { await refreshSettingsMetadata?.(); return requireHost().getBootstrap(); });
  handle(DESKTOP_CHANNELS.command, async args => requireHost().command(args[0] as CommandEnvelope));
  handle(DESKTOP_CHANNELS.advanced, async (args, owner) => requireHost().advanced(owner, args[0] as import('../shared/advanced.js').DesktopAdvancedAction));
  handle(DESKTOP_CHANNELS.advancedSnapshot, async args => requireHost().getAdvancedSnapshot(args[0] as string));
  handle(DESKTOP_CHANNELS.accounts, async () => accounts!.getView());
  handle(DESKTOP_CHANNELS.accountAction, async (args, owner) => {
    const input = args[0] as DesktopAccountAction;
    if (input?.action === 'cancel') return accounts!.action(input, owner);
    return requireHost().accountTransition(async () => {
      if (!window || owner !== ownerId) throw new HostError('WINDOW_RELOADED', 'The window changed before the account operation began.');
      const view = await accounts!.action(input, owner);
      if (!window || owner !== ownerId) throw new HostError('WINDOW_RELOADED', 'The window changed before the account binding was saved.');
      if (input.action === 'sign-in' || input.action === 'select') await bindSelectedAccount?.(view);
      return accounts!.getView();
    }, () => { if (!window || owner !== ownerId) throw new HostError('WINDOW_RELOADED', 'The window changed before the account operation began.'); });
  });
  handle(DESKTOP_CHANNELS.appUpdate, async () => updates!.getView());
  handle(DESKTOP_CHANNELS.appUpdateAction, async args => updates!.action(args[0] as DesktopAppUpdateAction));
  handle(DESKTOP_CHANNELS.subscribe, async (args, owner) => requireHost().subscribe(owner, args[0] as string, args[1] as number));
  handle(DESKTOP_CHANNELS.unsubscribe, async (args, owner) => requireHost().unsubscribe(owner, args[0] as string));
  handle(DESKTOP_CHANNELS.saveSettings, async args => requireHost().saveSettings(args[0] as SaveDesktopSettings));
  handle(DESKTOP_CHANNELS.retryEngine, async () => requireHost().retryEngine());
  handle(DESKTOP_CHANNELS.diagnostics, async () => requireHost().getRecoveryStatus());
  handle(DESKTOP_CHANNELS.recover, async args => requireHost().recoverEngine(args[0] as { fingerprint: string; acknowledged: true }));
  handle(DESKTOP_CHANNELS.backup, async (_args, owner) => {
    const chosen = await dialog.showSaveDialog(window!, { title: '대화 데이터베이스 백업', defaultPath: 'moodcode-backup.sqlite', filters: [{ name: 'SQLite database', extensions: ['sqlite'] }] });
    if (chosen.canceled || !chosen.filePath) return { cancelled: true };
    if (!window || owner !== ownerId) throw new HostError('WINDOW_RELOADED', 'The window changed while selecting the backup location.');
    return { cancelled: false, ...await requireHost().backupDatabase(chosen.filePath) };
  });
  handle(DESKTOP_CHANNELS.openExternal, async args => { await shell.openExternal(validateExternalURL(args[0])); });
  handle(DESKTOP_CHANNELS.copyText, async args => { await clipboard.writeText(validateClipboardText(args[0])); });
  handle(DESKTOP_CHANNELS.chooseWorkspace, async (_args, owner) => {
    const selected = testLaunch && process.env.MOODCODE_DESKTOP_TEST_WORKSPACE
      ? process.env.MOODCODE_DESKTOP_TEST_WORKSPACE
      : (await dialog.showOpenDialog(window!, { title: 'Open a workspace', properties: ['openDirectory'] })).filePaths[0];
    if (!selected) return null;
    if (!window || owner !== ownerId) throw new HostError('WINDOW_RELOADED', 'The desktop window changed while selecting a folder.');
    const result = await requireHost().command({ schemaVersion: 1, commandId: randomUUID(), type: 'workspace.open', payload: { path: selected } });
    if (!result.ok) throw new HostError(result.error?.code ?? 'WORKSPACE_OPEN_FAILED', result.error?.message ?? 'The workspace could not be opened.');
    return result.result as unknown as Workspace;
  });
}
function createWindow(): void {
  if (window && !window.isDestroyed()) { window.focus(); return; }
  ownerId = randomUUID();
  const created = new BrowserWindow({
    title: 'Moodcode', width: 1320, height: 900, minWidth: 820, minHeight: 600,
    backgroundColor: '#13161d', show: false,
    webPreferences: { preload: join(bundleDirectory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  window = created;
  let windowOwner = ownerId;
  const removeGuards = installNavigationGuards(created.webContents, rendererURL);
  created.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  created.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
    if (!mainFrame) return;
    const previous = windowOwner;
    windowOwner = randomUUID();
    if (window === created) ownerId = windowOwner;
    void host?.dropOwner(previous).catch(() => {});
    accounts?.cancelOwner(previous);
  });
  created.once('ready-to-show', () => created.show());
  created.on('closed', () => {
    removeGuards();
    const previous = windowOwner;
    if (window === created) window = undefined;
    void host?.dropOwner(previous).catch(() => {});
    accounts?.cancelOwner(previous);
  });
  void created.loadFile(rendererPath).catch(() => {
    dialog.showErrorBox('Moodcode renderer unavailable', 'The desktop renderer could not be loaded. Rebuild the desktop application and reopen it.');
  });
}

app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  if (quitPending) return;
  quitPending = true;
  void (async () => {
    try {
      await accounts?.close();
      await host?.close();
      quitting = true;
      app.quit();
    } catch {
      dialog.showErrorBox('Moodcode cleanup pending', 'The engine has not confirmed cleanup. Moodcode remains open so running processes and database cleanup can finish; try quitting again.');
    } finally { quitPending = false; }
  })();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (app.isReady()) createWindow(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit());

void app.whenReady().then(async () => {
  const userData = realpathSync(app.getPath('userData'));
  const credentialStorage: CredentialStorage = {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: value => safeStorage.encryptString(value),
    decryptString: value => safeStorage.decryptString(value),
    ...(process.platform === 'linux' ? { getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend() } : {}),
  };
  const accountTransport = scenario === 'account' ? await createAccountFixtureTransport() : { openExternal: (url: string) => shell.openExternal(url) };
  accounts = new DesktopAccounts({ directory: join(userData, 'accounts'), safeStorage: credentialStorage, ...accountTransport });
  const settingsStore = new SettingsStore({ directory: userData, safeStorage: credentialStorage, environment: scenario ? {} : process.env, codexAuth: () => authMetadata, accountCredential: () => accounts!.getCredential() });
  refreshSettingsMetadata = async () => {
    const selected = settingsStore.getView();
    if (selected.providerId === 'codex' && selected.credentialMode !== 'chatgpt') await refreshCodexAuth();
    settingsStore.refreshView();
  };
  const settings = {
    load: async () => {
      if ((!scenario || scenario === 'account') && settingsStore.getView().credentialMode === 'chatgpt') await accounts!.resolveCredential();
      try { return await settingsStore.load(); }
      catch (error) {
        const provider = settingsStore.getView().providerId;
        if ((!scenario || scenario === 'account') && provider === 'codex' && settingsStore.getView().credentialMode === 'chatgpt') { await accounts!.resolveCredential(); return settingsStore.load(); }
        if (!scenario && provider === 'codex') { await refreshCodexAuth(); return settingsStore.load(); }
        throw error;
      }
    },
    prepare: async (input: SaveDesktopSettings) => {
      if (!scenario && input.providerId === 'codex' && input.credentialMode !== 'chatgpt') await refreshCodexAuth();
      if ((!scenario || scenario === 'account') && input.credentialMode === 'chatgpt') await accounts!.resolveCredential();
      return settingsStore.prepare(input);
    },
    commit: settingsStore.commit.bind(settingsStore),
    getView: settingsStore.getView.bind(settingsStore),
  };
  bindSelectedAccount = async view => {
    const selected = view.accounts.find(account => account.id === view.activeAccountId);
    if (!selected?.sharing || !view.activeAccountId) return;
    const credential = await accounts!.resolveCredential();
    if (!credential?.models.length) throw new HostError('ACCOUNT_MODEL_REQUIRED', 'The selected account did not offer a Codex model.');
    const previous = settingsStore.getView();
    const modelId = credential.models.find(model => model.id === previous.modelId)?.id ?? credential.models[0]!.id;
    const prepared = await settingsStore.prepare({ providerId: 'codex', baseURL: '', modelId,
      ...(previous.providerId === 'codex' && previous.modelId === modelId && previous.reasoningEffort ? { reasoningEffort: previous.reasoningEffort } : {}),
      credentialMode: 'chatgpt', accountId: view.activeAccountId });
    await settingsStore.commit(prepared);
  };
  host = new DesktopHost({
    spawn: spawnWorker, settings, dbPath: join(userData, 'engine.sqlite'), artifactDir: join(userData, 'artifacts'),
    platform: process.platform, version: app.getVersion(), ...(scenario ? { testScenario: scenario } : {}),
    resolveCodexCredential: async (accountId, modelId, signal) => {
      const credential = await accounts!.resolveCredential(signal, accountId);
      if (!credential || credential.accountId !== accountId || !credential.models.some(model => model.id === modelId)) throw new HostError('ACCOUNT_REAUTH_REQUIRED', 'The selected Codex account or model is unavailable.');
      return { accessToken: credential.apiKey, accountId: credential.chatgptAccountId, secrets: [...credential.secrets] };
    },
    onUtilityClose: diagnostics => { app.emit('moodcode:utility-close', diagnostics); },
    onStatus: status => { if (window && !window.isDestroyed()) window.webContents.send(DESKTOP_CHANNELS.hostState, status); },
    onUpdate: (owner, update) => { if (owner === ownerId && window && !window.isDestroyed()) window.webContents.send(DESKTOP_CHANNELS.update, update); },
  });
  updates = await createDesktopUpdates({ currentVersion: app.getVersion(), isPackaged: app.isPackaged, closeEngine: async () => { await accounts?.close(); await requireHost().closeForUpdate(); } });
  installIpc();
  createWindow();
  await host.initialize();
}).catch(() => {
  dialog.showErrorBox('Moodcode could not start', 'Desktop initialization failed. Reopen Moodcode after checking its installed files.');
  app.quit();
});
