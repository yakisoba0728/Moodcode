import type { EngineCapabilities, Workspace } from '@moodcode/contracts';
import type { DesktopProviderId, DesktopUpdate } from '../shared/protocol.js';

/** Only the main process sends this private configuration to the utility process. */
export interface WorkerEngineConfig {
  providerId: DesktopProviderId;
  modelId: string;
  baseURL: string;
  anthropicWorkspaceId?: string;
  apiKey?: string;
  codexCredential?: { readonly accessToken: string; readonly accountId: string; readonly secrets: readonly string[] };
  reasoningEffort?: import('@moodcode/contracts').ReasoningEffort;
}
export interface WorkerStartPayload {
  dbPath: string;
  artifactDir: string;
  config: WorkerEngineConfig;
  testScenario?: 'coding' | 'slow' | 'advanced' | 'account';
}
export interface WorkerBootstrap {
  workspaces: Workspace[];
  capabilities: EngineCapabilities;
}
export interface WorkerRequest {
  id: string;
  type: 'start' | 'bootstrap' | 'command' | 'advanced' | 'advancedSnapshot' | 'subscribe' | 'unsubscribe' | 'dropOwner' | 'assertIdle' | 'diagnostics' | 'recover' | 'backup' | 'close';
  payload?: unknown;
}
export type WorkerResponse =
  | { id: string; ok: true; result?: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };
export interface WorkerPush { type: 'update'; ownerId: string; update: DesktopUpdate }
