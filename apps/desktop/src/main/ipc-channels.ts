/** This closed list is the entire renderer-to-main transport. */
export const DESKTOP_CHANNELS = Object.freeze({
  bootstrap: 'moodcode:bootstrap',
  command: 'moodcode:command',
  chooseWorkspace: 'moodcode:choose-workspace',
  subscribe: 'moodcode:subscribe',
  unsubscribe: 'moodcode:unsubscribe',
  saveSettings: 'moodcode:save-settings',
  retryEngine: 'moodcode:retry-engine',
  openExternal: 'moodcode:open-external',
  copyText: 'moodcode:copy-text',
  diagnostics: 'moodcode:diagnostics',
  recover: 'moodcode:recover',
  backup: 'moodcode:backup',
  update: 'moodcode:update',
  hostState: 'moodcode:host-state',
} as const);

/** Main uses a private envelope because Electron does not preserve Error.code. */
export type DesktopIpcResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };
