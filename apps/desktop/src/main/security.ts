interface SenderFrame {
  readonly url: string;
  readonly detached?: boolean;
  isDestroyed(): boolean;
}

interface SenderWebContents {
  readonly mainFrame: SenderFrame;
  isDestroyed(): boolean;
}

export interface TrustedSenderEvent {
  readonly sender: SenderWebContents;
  readonly senderFrame: SenderFrame | null;
}

function forbidden(): never {
  throw Object.assign(new Error('The IPC sender is not the desktop renderer.'), { code: 'IPC_FORBIDDEN' });
}

/** Identity and the exact current frame URL are both required for every invoke. */
export function assertTrustedSender(
  event: TrustedSenderEvent,
  expectedWebContents: SenderWebContents,
  rendererURL: string,
): void {
  try {
    if (!rendererURL || event.sender !== expectedWebContents || expectedWebContents.isDestroyed()) forbidden();
    const frame = event.senderFrame;
    if (!frame || frame !== expectedWebContents.mainFrame || frame.isDestroyed() || frame.detached || frame.url !== rendererURL) forbidden();
  } catch {
    forbidden();
  }
}

interface NavigationEvent {
  preventDefault(): void;
  readonly url?: string;
  readonly isMainFrame?: boolean;
}

type NavigationListener = (event: NavigationEvent, legacyURL?: string) => void;

export interface NavigationWebContents {
  setWindowOpenHandler(handler: (details: unknown) => { action: 'deny' }): void;
  on(event: string, listener: NavigationListener): unknown;
  removeListener(event: string, listener: NavigationListener): unknown;
}

/** External links are browser links, with no shell-specific protocols or credentials. */
export function validateExternalURL(input: unknown): string {
  const invalid = (): never => {
    throw Object.assign(new Error('Only valid HTTP or HTTPS links can be opened.'), { code: 'INVALID_INPUT' });
  };
  if (typeof input !== 'string' || !input || input.trim() !== input || input.length > 4096 ||
      new TextEncoder().encode(input).byteLength > 4096 || /[\u0000-\u0020\u007f\\]/u.test(input) ||
      !/^https?:\/\//iu.test(input)) return invalid();
  const url = (() => { try { return new URL(input); } catch { return invalid(); } })();
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return invalid();
  return url.href;
}

/** Keep this window on its local renderer and deny new windows and subframes. */
export function installNavigationGuards(webContents: NavigationWebContents, rendererURL: string): () => void {
  const navigate: NavigationListener = (event, legacyURL) => {
    const url = event.url ?? legacyURL;
    if (url !== rendererURL || event.isMainFrame === false) event.preventDefault();
  };
  const frameNavigate: NavigationListener = (event) => {
    if (event.url !== rendererURL || event.isMainFrame !== true) event.preventDefault();
  };
  const deny: NavigationListener = (event) => event.preventDefault();
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', navigate);
  webContents.on('will-frame-navigate', frameNavigate);
  webContents.on('will-redirect', navigate);
  webContents.on('will-attach-webview', deny);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    webContents.removeListener('will-navigate', navigate);
    webContents.removeListener('will-frame-navigate', frameNavigate);
    webContents.removeListener('will-redirect', navigate);
    webContents.removeListener('will-attach-webview', deny);
  };
}
