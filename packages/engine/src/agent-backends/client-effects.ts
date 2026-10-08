import { createHash, randomUUID } from "node:crypto";
import { EngineError, type JsonValue } from "@moodcode/contracts";
import type { TurnRequest } from "../ports.js";
import type { BackendProcessPort } from "./process.js";
import type { AgentBackendStorage } from "./store.js";
import type { AcpV1Response } from "./types.js";
import { validateAcpV1Request } from "./protocol.js";

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

export interface BackendClientEffectOptions {
  store: AgentBackendStorage;
  processes: BackendProcessPort;
  clientReads: BackendClientReadPort;
}
export interface ExecuteBackendClientReadInput {
  originalTurn: TurnRequest;
  originalFrame: object;
  originalConnection: object;
  workspaceId: string;
  remoteRequestId: string;
  remoteSessionId: string;
  signal: AbortSignal;
}

/** Same-Attempt native tool receipts settle before any remote read response. */
export class BackendClientEffects {
  constructor(private readonly options: BackendClientEffectOptions) {}
  async read(input: ExecuteBackendClientReadInput): Promise<void> {
    const frame = this.options.processes.readPeerObservation(
      input.originalFrame,
    );
    const message = frame.message;
    if (
      !("method" in message) ||
      !("id" in message) ||
      message.method !== "fs/read_text_file"
    )
      throw new EngineError(
        "ACP_EFFECT_UNSUPPORTED",
        "The backend requested an unsupported client effect",
      );
    const params = validateAcpV1Request("fs/read_text_file", message.params);
    if (params.sessionId !== input.remoteSessionId)
      throw new EngineError(
        "BACKEND_REMOTE_SESSION_INVALID",
        "The client read belongs to another remote session",
      );
    const effectId = randomUUID();
    const callId = `acp:${createHash("sha256")
      .update(
        JSON.stringify([
          frame.connectionId,
          frame.epoch,
          frame.receiveOrdinal,
          typeof message.id,
          message.id,
        ]),
      )
      .digest("hex")}`;
    const read: BackendClientReadInput = {
      callId,
      path: params.path,
      ...(params.line == null ? {} : { line: params.line }),
      ...(params.limit == null ? {} : { limit: params.limit }),
    };
    const prepared = this.options.store.prepareClientRead(
      input.originalTurn,
      input.originalFrame,
      {
        workspaceId: input.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 0,
        effectId,
        remoteRequestId: input.remoteRequestId,
        input: read,
      },
    );
    if (prepared.duplicate)
      throw new EngineError(
        "BACKEND_EFFECT_ALREADY_BOUND",
        "A historical client read cannot be replayed",
      );
    let completion: object | undefined;
    try {
      completion = await this.options.clientReads.executeRead(
        input.originalTurn,
        read,
        input.signal,
      );
      const proof = this.options.clientReads.readCompletion(completion);
      const settled = this.options.store.settleClientRead(completion, {
        workspaceId: input.workspaceId,
        requestId: randomUUID(),
        expectedRevision: prepared.record.revision,
        effectId,
      });
      let response: AcpV1Response;
      try {
        response = {
          jsonrpc: "2.0",
          id: message.id,
          result: backendReadResponse(proof) as unknown as JsonValue,
        };
      } catch {
        response = {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32001,
            message: proof.errorCode ?? "Native client read failed",
          },
        };
      }
      const write = await this.options.processes.write(
        input.originalConnection,
        response,
        input.signal,
      );
      try {
        this.options.store.recordClientDelivery(write, {
          workspaceId: input.workspaceId,
          requestId: randomUUID(),
          expectedRevision: settled.record.revision,
          effectId,
          message: response,
        });
      } finally {
        this.options.processes.releaseWrite(write);
      }
    } finally {
      if (completion) this.options.clientReads.releaseCompletion(completion);
    }
  }
}
