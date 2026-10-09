import type {
  CommandEnvelope,
  CommandResult,
  EngineCapabilities,
  Workspace,
  ReasoningEffort,
} from "@moodcode/contracts";
import type { JsonValue } from '@moodcode/contracts';
import type { DesktopAdvancedAction, DesktopAdvancedSnapshot } from './advanced.js';
import type { DesktopAccountAction, DesktopAccountView } from './account-protocol.js';
import type { DesktopAppUpdate, DesktopAppUpdateAction } from './update-protocol.js';

export type DesktopProviderId =
  "scripted" | "openai-compatible" | "openai-responses" | "anthropic" | "codex";
export const ANTHROPIC_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export interface HostStatus {
  state: "starting" | "ready" | "failed" | "stopped";
  generation: number;
  error?: { code: string; message: string };
}
/** Credentials are held by the main/utility processes; this view never returns a key. */
export interface DesktopSettings {
  credentialMode?: 'api-key' | 'chatgpt';
  accountId?: string;
  providerId: DesktopProviderId;
  modelId: string;
  baseURL: string;
  anthropicWorkspaceId?: string;
  keyConfigured: boolean;
  keySource: "environment" | "stored" | "codex" | "chatgpt" | "none";
  credentialStorage: "available" | "unavailable";
  codexAuthState?: "available" | "missing" | "expired" | "unreadable";
  codexModelId?: string;
  codexModels?: { id: string; displayName: string; reasoningEfforts: ReasoningEffort[]; defaultEffort?: ReasoningEffort }[];
  reasoningEffort?: ReasoningEffort;
}
export interface SaveDesktopSettings {
  credentialMode?: 'api-key' | 'chatgpt';
  accountId?: string;
  providerId: DesktopProviderId;
  modelId: string;
  baseURL: string;
  anthropicWorkspaceId?: string;
  apiKey?: string;
  clearKey?: boolean;
  reasoningEffort?: ReasoningEffort;
}
export interface DesktopBootstrap {
  host: HostStatus;
  platform: string;
  version: string;
  workspaces: Workspace[];
  capabilities?: EngineCapabilities;
  settings: DesktopSettings;
}
/** A bounded invalidation: consumers read a committed snapshot, rather than cache raw tokens. */
export interface DesktopUpdate {
  subscriptionId: string;
  sessionId: string;
  lastSeq: number;
  error?: { code: string; message: string };
}
export interface DesktopRecoveryStatus {
  schemaVersion: 1; state: "clear" | "recoverable" | "blocked"; fingerprint: string | null; blockers: string[];
  marker: { active: boolean; owner: "absent" | "alive" | "unknown"; group: "absent" | "alive" | "unknown" | "not_recorded" } | null;
  pendingRestoreCount: number; resolvedRestoreCount: number; activeRunCount?: number;
}
export interface DesktopRecoveryResult { recoveryId: string; restoredAcknowledgments: number; effectMarkerCleared: boolean; backupVerified: true }
export interface DesktopApi {
  getAdvancedSnapshot?(sessionId: string): Promise<DesktopAdvancedSnapshot>;
  advanced?(input: DesktopAdvancedAction): Promise<JsonValue>;
  getAccounts?(): Promise<DesktopAccountView>;
  accountAction?(input: DesktopAccountAction): Promise<DesktopAccountView>;
  getAppUpdate?(): Promise<DesktopAppUpdate>;
  appUpdateAction?(input: DesktopAppUpdateAction): Promise<DesktopAppUpdate>;
  getBootstrap(): Promise<DesktopBootstrap>;
  command(command: CommandEnvelope): Promise<CommandResult>;
  chooseWorkspace(): Promise<Workspace | null>;
  subscribe(sessionId: string, afterSeq: number): Promise<string>;
  unsubscribe(subscriptionId: string): Promise<void>;
  onUpdate(listener: (update: DesktopUpdate) => void): () => void;
  onHostState(listener: (status: HostStatus) => void): () => void;
  saveSettings(input: SaveDesktopSettings): Promise<DesktopSettings>;
  retryEngine(): Promise<HostStatus>;
  openExternal(url: string): Promise<void>;
  copyText?(text: string): Promise<void>;
  getRecoveryStatus?(): Promise<DesktopRecoveryStatus>;
  recoverEngine?(input: { fingerprint: string; acknowledged: true }): Promise<DesktopRecoveryResult>;
  backupDatabase?(): Promise<{ cancelled: boolean; bytes?: number }>;
}
declare global {
  interface Window {
    moodcode?: DesktopApi;
  }
}
