import type {
  CommandEnvelope,
  CommandResult,
  EngineCapabilities,
  Workspace,
} from "@moodcode/contracts";

export type DesktopProviderId =
  "scripted" | "openai-compatible" | "openai-responses" | "codex";
export interface HostStatus {
  state: "starting" | "ready" | "failed" | "stopped";
  generation: number;
  error?: { code: string; message: string };
}
/** Credentials are held by the main/utility processes; this view never returns a key. */
export interface DesktopSettings {
  providerId: DesktopProviderId;
  modelId: string;
  baseURL: string;
  keyConfigured: boolean;
  keySource: "environment" | "stored" | "codex" | "none";
  credentialStorage: "available" | "unavailable";
  codexAuthState?: "available" | "missing" | "expired" | "unreadable";
  codexModelId?: string;
}
export interface SaveDesktopSettings {
  providerId: DesktopProviderId;
  modelId: string;
  baseURL: string;
  apiKey?: string;
  clearKey?: boolean;
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
export interface DesktopApi {
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
}
declare global {
  interface Window {
    moodcode?: DesktopApi;
  }
}
