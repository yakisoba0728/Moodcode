import type { CommandEnvelope } from '@moodcode/contracts';
import { validateCommand } from '@moodcode/contracts/validation';
import { DESKTOP_CHANNELS } from '../main/ipc-channels.js';
import { validateExternalURL } from '../main/security.js';
import { validateRecoveryInput } from '../shared/recovery.js';
import { validateClipboardText } from '../shared/clipboard.js';
import { REASONING_EFFORTS } from '@moodcode/contracts';
import { validateAdvancedAction, type DesktopAdvancedAction } from '../shared/advanced.js';
import type { DesktopAccountAction } from '../shared/account-protocol.js';
import type { DesktopAppUpdateAction } from '../shared/update-protocol.js';
import type { DesktopApi, DesktopUpdate, HostStatus, SaveDesktopSettings } from '../shared/protocol.js';

type TransportListener = (event: unknown, payload: unknown) => void;
export interface DesktopTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: TransportListener): unknown;
  removeListener(channel: string, listener: TransportListener): unknown;
}

const encoder = new TextEncoder();

function invalid(): never {
  throw Object.assign(new Error('The desktop request is invalid.'), { code: 'INVALID_INPUT' });
}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const result: Record<string, unknown> = Object.create(null);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.includes(key)) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
      result[key] = descriptor.value;
    }
  } catch { invalid(); }
  return result;
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  if (value.length > maximum || encoder.encode(value).byteLength > maximum) invalid();
  return value;
}

function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

/** Validate without inserting defaults; the utility worker owns active settings. */
export function validateDesktopCommand(value: unknown): CommandEnvelope {
  const command = validateCommand(value);
  if (command.type === 'run.submit') {
    const original = value as CommandEnvelope;
    if (!Object.hasOwn(original.payload, 'config')) {
      delete command.payload.config;
    } else {
      const config = original.payload.config as Record<string, unknown>;
      const copied: Record<string, unknown> = {};
      for (const key of ['providerId', 'modelId', 'mode', 'limits', 'reasoningEffort']) {
        if (Object.hasOwn(config, key)) copied[key] = key === 'limits' ? { ...(config[key] as object) } : config[key];
      }
      command.payload.config = copied as CommandEnvelope['payload'];
    }
  }
  return command;
}

export function validateDesktopSettings(value: unknown): SaveDesktopSettings {
  const input = record(value, ['providerId', 'modelId', 'baseURL', 'apiKey', 'clearKey', 'reasoningEffort', 'credentialMode', 'accountId']);
  if (input.providerId !== 'scripted' && input.providerId !== 'openai-compatible' && input.providerId !== 'openai-responses' && input.providerId !== 'codex') invalid();
  const result: SaveDesktopSettings = {
    providerId: input.providerId,
    modelId: boundedString(input.modelId, 256, input.providerId === 'codex'),
    baseURL: boundedString(input.baseURL, 2048, input.providerId === 'scripted' || input.providerId === 'codex'),
  };
  if (result.modelId.trim() !== result.modelId) invalid();
  if (input.credentialMode !== undefined) {
    if (!['api-key','chatgpt'].includes(input.credentialMode as string)) invalid();
    result.credentialMode = input.credentialMode as 'api-key' | 'chatgpt';
  }
  if (input.accountId !== undefined) result.accountId = boundedString(input.accountId, 36);
  if (result.credentialMode === 'chatgpt' && (result.providerId !== 'openai-responses' || !result.accountId || input.apiKey !== undefined)
    || result.accountId && result.credentialMode !== 'chatgpt') invalid();
  if (Object.hasOwn(input, 'reasoningEffort')) {
    if (!REASONING_EFFORTS.includes(input.reasoningEffort as never) || !['codex', 'openai-responses'].includes(result.providerId)) invalid();
    result.reasoningEffort = input.reasoningEffort as import('@moodcode/contracts').ReasoningEffort;
  }
  if (result.providerId === 'scripted' || result.providerId === 'codex') {
    if (result.baseURL !== '' || Object.hasOwn(input, 'apiKey')) invalid();
  } else {
    validateExternalURL(result.baseURL);
    if (result.baseURL.includes('?') || result.baseURL.includes('#')) invalid();
  }
  if (Object.hasOwn(input, 'apiKey')) {
    result.apiKey = boundedString(input.apiKey, 4096);
    if (/\s/u.test(result.apiKey)) invalid();
  }
  if (Object.hasOwn(input, 'clearKey')) {
    if (typeof input.clearKey !== 'boolean') invalid();
    result.clearKey = input.clearKey;
  }
  if (result.clearKey && result.apiKey !== undefined) invalid();
  return result;
}

function optionalError(value: unknown): { code: string; message: string } {
  const error = record(value, ['code', 'message']);
  return Object.freeze({ code: boundedString(error.code, 64), message: boundedString(error.message, 1024) });
}

function updatePayload(value: unknown): DesktopUpdate {
  const input = record(value, ['subscriptionId', 'sessionId', 'lastSeq', 'error']);
  const update: DesktopUpdate = {
    subscriptionId: boundedString(input.subscriptionId, 256),
    sessionId: boundedString(input.sessionId, 256),
    lastSeq: sequence(input.lastSeq),
  };
  if (Object.hasOwn(input, 'error')) update.error = optionalError(input.error);
  return Object.freeze(update);
}

function statusPayload(value: unknown): HostStatus {
  const input = record(value, ['state', 'generation', 'error']);
  if (input.state !== 'starting' && input.state !== 'ready' && input.state !== 'failed' && input.state !== 'stopped') invalid();
  const status: HostStatus = { state: input.state, generation: sequence(input.generation) };
  if (Object.hasOwn(input, 'error')) status.error = optionalError(input.error);
  return Object.freeze(status);
}

async function invoke<T>(transport: DesktopTransport, channel: string, ...args: unknown[]): Promise<T> {
  let response: unknown;
  try { response = await transport.invoke(channel, ...args); }
  catch { throw Object.assign(new Error('The desktop host connection failed.'), { code: 'IPC_TRANSPORT_FAILED' }); }
  let envelope: Record<string, unknown>;
  try {
    envelope = record(response, ['ok', 'value', 'error']);
  } catch {
    throw Object.assign(new Error('The desktop host returned an invalid response.'), { code: 'IPC_INVALID_RESPONSE' });
  }
  if (envelope.ok === true && Object.hasOwn(envelope, 'value') && !Object.hasOwn(envelope, 'error')) return envelope.value as T;
  let hostError: { code: string; message: string } | undefined;
  try {
    if (envelope.ok === false && !Object.hasOwn(envelope, 'value')) {
      hostError = optionalError(envelope.error);
    }
  } catch { /* Reject malformed host errors without copying their contents. */ }
  if (hostError) throw Object.assign(new Error(hostError.message), { code: hostError.code });
  throw Object.assign(new Error('The desktop host returned an invalid response.'), { code: 'IPC_INVALID_RESPONSE' });
}

/** Only typed methods cross contextBridge; Electron event objects stay isolated. */
export function createDesktopApi(transport: DesktopTransport): DesktopApi {
  const listen = <T>(channel: string, parse: (value: unknown) => T, listener: (value: T) => void): (() => void) => {
    if (typeof listener !== 'function') invalid();
    let disposed = false;
    const wrapper: TransportListener = (_event, payload) => {
      if (disposed) return;
      let value: T;
      try { value = parse(payload); } catch { return; }
      // A renderer callback must not interrupt delivery to other subscriptions.
      try { listener(value); } catch { /* The listener belongs to the renderer. */ }
    };
    transport.on(channel, wrapper);
    return () => {
      if (disposed) return;
      disposed = true;
      transport.removeListener(channel, wrapper);
    };
  };
  return Object.freeze({
    getBootstrap: () => invoke(transport, DESKTOP_CHANNELS.bootstrap),
    command: async (command: CommandEnvelope) => invoke(transport, DESKTOP_CHANNELS.command, validateDesktopCommand(command)),
    getAdvancedSnapshot: async (sessionId: string) => invoke(transport, DESKTOP_CHANNELS.advancedSnapshot, boundedString(sessionId, 128)),
    advanced: async (input: DesktopAdvancedAction) => invoke(transport, DESKTOP_CHANNELS.advanced, validateAdvancedAction(input)),
    getAccounts: () => invoke(transport, DESKTOP_CHANNELS.accounts),
    accountAction: async (input: DesktopAccountAction) => {
      const value = record(input, ['action','accountId']);
      if (!['sign-in','select','refresh','sign-out','forget','cancel'].includes(value.action as string)) invalid();
      if (value.accountId !== undefined) boundedString(value.accountId, 36);
      return invoke(transport, DESKTOP_CHANNELS.accountAction, value);
    },
    getAppUpdate: () => invoke(transport, DESKTOP_CHANNELS.appUpdate),
    appUpdateAction: async (input: DesktopAppUpdateAction) => {
      const value = record(input, ['action','version','acknowledged']);
      if (!['check','download','cancel','install'].includes(value.action as string)) invalid();
      if (value.version !== undefined) boundedString(value.version, 64);
      if (value.acknowledged !== undefined && value.acknowledged !== true) invalid();
      return invoke(transport, DESKTOP_CHANNELS.appUpdateAction, value);
    },
    chooseWorkspace: () => invoke(transport, DESKTOP_CHANNELS.chooseWorkspace),
    subscribe: async (sessionId: string, afterSeq: number) => invoke(transport, DESKTOP_CHANNELS.subscribe, boundedString(sessionId, 256), sequence(afterSeq)),
    unsubscribe: async (subscriptionId: string) => invoke(transport, DESKTOP_CHANNELS.unsubscribe, boundedString(subscriptionId, 256)),
    onUpdate: (listener: (update: DesktopUpdate) => void) => listen(DESKTOP_CHANNELS.update, updatePayload, listener),
    onHostState: (listener: (status: HostStatus) => void) => listen(DESKTOP_CHANNELS.hostState, statusPayload, listener),
    saveSettings: async (input: SaveDesktopSettings) => invoke(transport, DESKTOP_CHANNELS.saveSettings, validateDesktopSettings(input)),
    retryEngine: () => invoke(transport, DESKTOP_CHANNELS.retryEngine),
    getRecoveryStatus: () => invoke(transport, DESKTOP_CHANNELS.diagnostics),
    recoverEngine: input => invoke(transport, DESKTOP_CHANNELS.recover, validateRecoveryInput(input)),
    backupDatabase: () => invoke(transport, DESKTOP_CHANNELS.backup),
    openExternal: async (url: string) => invoke(transport, DESKTOP_CHANNELS.openExternal, validateExternalURL(url)),
    copyText: async (text: string) => invoke(transport, DESKTOP_CHANNELS.copyText, validateClipboardText(text)),
  } satisfies DesktopApi);
}
