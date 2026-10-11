import { isAbsolute, relative, sep } from "node:path";
import { EngineError, type JsonValue } from "@moodcode/contracts";
import type { TurnRequest } from "../ports.js";
import type { BackendProcessPort } from "./process.js";
import type { AgentBackendStorage } from "./store.js";

/** Root produces these receipts from its actual Runner tool pipeline. */
export interface BackendClientReadProof {
  workspaceId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  attemptId: string;
  toolCallId: string;
  providerToolCallId: string;
  preparedFingerprint: string | null;
  state: "completed" | "failed" | "denied" | "interrupted";
  inputSha256: string;
  outputSha256: string;
  outputBytes: number;
  content: string | null;
  errorCode: string | null;
  cleanupConfirmed: boolean;
  sha256: string;
  effectMethod?: "fs/write_text_file" | "terminal/create";
  result?: JsonValue | null;
  checkpoint?: { id: string; sha256: string } | null;
}

export interface BackendClientReadInput {
  callId: string;
  path: string;
  line?: number;
  limit?: number;
}

/** The request must be the original object issued by the native TurnExecutor. */
export interface BackendClientReadPort {
  executeRead(
    originalDispatchedRequest: TurnRequest,
    input: BackendClientReadInput,
    signal: AbortSignal,
  ): Promise<object>;
  readCompletion(original: object): BackendClientReadProof;
  releaseCompletion(original: object): void;
}

export interface BackendReadResponse {
  content: string;
}

/** A paged or failed native read cannot be represented as a successful ACP read. */
export function backendReadResponse(
  proof: BackendClientReadProof,
): BackendReadResponse {
  if (
    proof.state !== "completed" ||
    proof.cleanupConfirmed !== true ||
    typeof proof.content !== "string" ||
    proof.errorCode !== null
  ) {
    throw new EngineError(
      proof.errorCode ?? "BACKEND_CLIENT_READ_FAILED",
      "The native client read did not produce a complete result",
    );
  }
  if (
    !Number.isSafeInteger(proof.outputBytes) ||
    proof.outputBytes < 0 ||
    Buffer.byteLength(proof.content) > proof.outputBytes
  ) {
    throw new EngineError(
      "BACKEND_CLIENT_READ_FAILED",
      "The native client read output does not match its receipt",
    );
  }
  return { content: proof.content };
}

export type BackendClientEffectInput =
  | {
      callId: string;
      method: "fs/write_text_file";
      path: string;
      content: string;
    }
  | {
      callId: string;
      method: "terminal/create";
      command: string;
      args: readonly string[];
      cwd: string;
      outputByteLimit: number;
    };

export function clientEffectToolName(
  input: BackendClientReadInput | BackendClientEffectInput,
): "read_file" | "apply_patch" | "run_command" {
  return !("method" in input)
    ? "read_file"
    : input.method === "fs/write_text_file"
      ? "apply_patch"
      : "run_command";
}

/** The workspace-relative POSIX path, or undefined when `path` is not inside `root`. */
export function workspaceLocalPath(
  root: string,
  path: string,
): string | undefined {
  const local = relative(root, path).split(sep).join("/");
  return !local ||
    local === ".." ||
    local.startsWith("../") ||
    isAbsolute(local)
    ? undefined
    : local;
}

/** The run_command line: the bare command, or every word single-quoted when there are arguments. */
export function terminalCommandLine(
  command: string,
  args: readonly string[],
): string {
  const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
  return args.length ? [command, ...args].map(quote).join(" ") : command;
}

export function clientReadToolInput(
  local: string,
  line: number | undefined,
  limit: number | undefined,
): { path: string; startLine: number; endLine?: number } {
  const startLine = line ?? 1;
  return limit === undefined
    ? { path: local, startLine }
    : { path: local, startLine, endLine: startLine + limit - 1 };
}

export interface BackendClientPermissionProof {
  workspaceId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  attemptId: string;
  toolCallId: string;
  providerToolCallId: string;
  inputSha256: string;
  preparedFingerprint: string | null;
  approvalId: string | null;
  allowed: boolean;
  sha256: string;
}
export interface BackendNativeClientEffectPort extends BackendClientReadPort {
  prepareEffect(
    original: TurnRequest,
    input: BackendClientEffectInput,
    signal: AbortSignal,
  ): Promise<object>;
  readPermission(original: object): BackendClientPermissionProof;
  readTerminalOutput(original: object): JsonValue;
  dispatchEffect(original: object): Promise<void>;
  waitEffect(original: object): Promise<object>;
  cancelEffect(original: object): void;
  releaseEffect(original: object): void;
}
export interface BackendEffectPorts {
  store: AgentBackendStorage;
  processes: BackendProcessPort;
  clientReads: BackendNativeClientEffectPort;
}
