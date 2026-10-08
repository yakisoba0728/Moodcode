import type {
  EngineBudgets,
  JsonObject,
  JsonValue,
  RunConfig,
} from "@moodcode/contracts";

/** Serializable pins are observations; only ORIGINAL root-produced handles convey runtime authority. */
export interface AgentBackendTargetPin {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly workspaceBindingSha256: string;
  readonly capabilitiesSha256: string;
  readonly catalogueSha256: string;
  readonly profile: { readonly id: string; readonly revision: string } | null;
  readonly config: RunConfig & { budgets: EngineBudgets };
  readonly runConfigSha256: string;
  readonly tools: readonly string[];
  readonly allocation: {
    readonly maxTurns: number;
    readonly maxToolCalls: number;
    readonly maxOutputBytes: number;
    readonly maxDurationMs: number;
  };
}
export interface AgentBackendCredentialReference {
  readonly id: string;
  readonly audience: string;
}
export interface AgentBackendLaunch {
  readonly kind: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly sourceFiles: readonly string[];
  readonly envReferences: readonly {
    readonly name: string;
    readonly reference: AgentBackendCredentialReference;
  }[];
}
export interface AgentBackendSpecInput {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly description: string;
  readonly protocol: "acp";
  readonly protocolVersion: 1;
  readonly contextOwner: "engine";
  readonly launch: AgentBackendLaunch;
  readonly credentialReference: AgentBackendCredentialReference | null;
  readonly endpointAudience: string;
  readonly target: AgentBackendTargetPin;
}
export interface AgentBackendSpec extends AgentBackendSpecInput {
  readonly sha256: string;
}

/** ACP compatibility is pinned to v1; v2 has a different completion and client-effect contract. */
export type AcpV1Id = string | number;
export interface AcpV1Request<P = JsonObject> {
  readonly jsonrpc: "2.0";
  readonly id: AcpV1Id;
  readonly method: string;
  readonly params?: P;
}
export interface AcpV1Notification<P = JsonObject> {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: P;
}
export interface AcpV1Success<R = JsonValue> {
  readonly jsonrpc: "2.0";
  readonly id: AcpV1Id;
  readonly result: R;
}
export interface AcpV1Failure {
  readonly jsonrpc: "2.0";
  readonly id: AcpV1Id | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: JsonValue;
  };
}
export type AcpV1Response = AcpV1Success | AcpV1Failure;
export type AcpV1Message = AcpV1Request | AcpV1Notification | AcpV1Response;
export interface AcpV1ImplementationInfo {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
}
export interface AcpV1InitializeParams {
  readonly protocolVersion: 1;
  readonly clientCapabilities: {
    readonly fs: {
      readonly readTextFile: boolean;
      readonly writeTextFile: false;
    };
    readonly terminal: false;
  };
  readonly clientInfo?: AcpV1ImplementationInfo;
  readonly _meta?: JsonObject;
}
export interface AcpV1InitializeResult {
  readonly protocolVersion: 1;
  readonly agentCapabilities: {
    readonly loadSession?: boolean;
    readonly promptCapabilities?: {
      readonly image?: boolean;
      readonly audio?: boolean;
      readonly embeddedContext?: boolean;
    };
    readonly mcpCapabilities?: {
      readonly http?: boolean;
      readonly sse?: boolean;
    };
    readonly sessionCapabilities?: JsonObject;
    readonly _meta?: JsonObject;
  };
  readonly agentInfo?: AcpV1ImplementationInfo;
  readonly authMethods?: readonly {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly _meta?: JsonObject;
  }[];
  readonly _meta?: JsonObject;
}
export interface AcpV1NewSessionParams {
  readonly cwd: string;
  readonly mcpServers: readonly [];
  readonly _meta?: JsonObject;
}
export interface AcpV1NewSessionResult {
  readonly sessionId: string;
  readonly _meta?: JsonObject;
}
export interface AcpV1TextContent {
  readonly type: "text";
  readonly text: string;
  readonly annotations?: JsonObject;
  readonly _meta?: JsonObject;
}
export interface AcpV1PromptParams {
  readonly sessionId: string;
  readonly prompt: readonly AcpV1TextContent[];
  readonly _meta?: JsonObject;
}
export type AcpV1StopReason =
  "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
export interface AcpV1PromptResult {
  readonly stopReason: AcpV1StopReason;
  readonly _meta?: JsonObject;
}
export interface AcpV1CancelParams {
  readonly sessionId: string;
  readonly _meta?: JsonObject;
}
export interface AcpV1ReadTextFileParams {
  readonly sessionId: string;
  readonly path: string;
  readonly line?: number | null;
  readonly limit?: number | null;
  readonly _meta?: JsonObject;
}
export interface AcpV1ReadTextFileResult {
  readonly content: string;
  readonly _meta?: JsonObject;
}
export interface AcpV1SessionUpdate {
  readonly sessionId: string;
  readonly update: JsonObject & { readonly sessionUpdate: string };
  readonly _meta?: JsonObject;
}
/** This intersection records supported protocol features, not local execution permissions. */
export interface AcpV1NegotiatedCapabilities {
  readonly protocol: "acp";
  readonly protocolVersion: 1;
  readonly contextOwner: "engine";
  readonly text: true;
  readonly readTextFile: boolean;
  readonly writeTextFile: false;
  readonly terminal: false;
  readonly loadSession: false;
  readonly sha256: string;
}
