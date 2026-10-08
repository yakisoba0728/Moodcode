import { randomUUID } from "node:crypto";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import type { ProviderAdapter, ProviderEvent, TurnRequest } from "../ports.js";
import {
  BackendClientEffects,
  type BackendClientReadPort,
} from "./client-effects.js";
import type { BackendProcessPort } from "./process.js";
import type {
  AgentBackendRevision,
  AgentBackendStorage,
  BackendConnectionRevision,
  BackendRemoteRequest,
  ActualBackendTurnPort,
} from "./store.js";
import type {
  AcpV1Message,
  AcpV1Request,
  AcpV1Response,
  AcpV1StopReason,
} from "./types.js";
import {
  negotiateAcpV1Capabilities,
  validateAcpV1Request,
  validateAcpV1Result,
} from "./protocol.js";

export interface AgentBackendRemoteOptions {
  record: AgentBackendRevision;
  store: AgentBackendStorage;
  processes: BackendProcessPort;
  clientReads: BackendClientReadPort;
  turns: ActualBackendTurnPort;
  lifetime: AbortSignal;
}
function remoteFailure(value: unknown): EngineError {
  return value instanceof EngineError
    ? value
    : new EngineError(
        "ACP_REMOTE_ERROR",
        "The remote backend did not complete the current request",
      );
}

/** One fresh remote session per native Attempt keeps the Engine's supplied context authoritative. */
export class AgentBackendRemote implements ProviderAdapter {
  readonly id: string;
  readonly inputModalities = ["text"] as const;
  readonly retryableHttpStatuses: readonly number[] = [];
  private readonly effects: BackendClientEffects;
  constructor(private readonly options: AgentBackendRemoteOptions) {
    this.id = `acp:${options.record.backendId}`;
    this.effects = new BackendClientEffects(options);
  }
  streamTurn(
    originalTurn: TurnRequest,
    inputSignal: AbortSignal,
  ): AsyncIterableIterator<ProviderEvent> {
    const cleanup = { started: false, confirmed: false, durable: true };
    const original = this.iterate(originalTurn, inputSignal, cleanup);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async (...args: [] | [undefined]) => {
        cleanup.started = true;
        return original.next(...args);
      },
      return: async () => {
        const result = await original.return(undefined);
        if (cleanup.started && (!cleanup.confirmed || !cleanup.durable))
          throw new EngineError(
            "CLEANUP_UNCERTAIN",
            "The owned backend did not confirm durable process cleanup",
          );
        return result;
      },
    };
  }
  private async *iterate(
    originalTurn: TurnRequest,
    inputSignal: AbortSignal,
    cleanupState: { started: boolean; confirmed: boolean; durable: boolean },
  ): AsyncGenerator<ProviderEvent> {
    const signal = AbortSignal.any([inputSignal, this.options.lifetime]);
    const { store, processes, record } = this.options;
    const workspaceId = record.workspaceId;
    let process: object | undefined;
    let connection: BackendConnectionRevision | undefined;
    let request: BackendRemoteRequest | undefined;
    let terminal: object | undefined;
    let frames: AsyncIterator<object> | undefined;
    let remoteSessionId: string | undefined;
    let disposal: object | undefined;
    let settled = false;
    const observe = (
      original: object,
      state: "initialized" | "session-ready" | "observe",
      session: string | null,
    ): void => {
      if (!connection)
        throw new EngineError(
          "BACKEND_CONNECTION_STALE",
          "The native connection has not been admitted",
        );
      connection = store.recordPeerObservation(original, {
        workspaceId,
        requestId: randomUUID(),
        expectedRevision: connection.revision,
        connectionId: connection.connectionId,
        state,
        remoteSessionId: session,
      }).record;
    };
    const next = async (): Promise<object> => {
      const item = await frames!.next();
      if (item.done)
        throw new EngineError(
          "BACKEND_DISCONNECTED",
          "Remote EOF is not prompt completion",
        );
      return item.value;
    };
    const write = async (message: AcpV1Message): Promise<object> =>
      processes.write(process!, message, signal);
    const handshake = async (
      method: "initialize" | "session/new",
      params: JsonObject,
    ): Promise<{ original: object; response: AcpV1Response }> => {
      const id = randomUUID();
      validateAcpV1Request(method, params);
      const written = await write({ jsonrpc: "2.0", id, method, params });
      processes.releaseWrite(written);
      const original = await next();
      const response = processes.readPeerObservation(original).message;
      if (
        "method" in response ||
        response.id !== id ||
        !("result" in response)
      ) {
        processes.releasePeerObservation(original);
        throw new EngineError(
          "ACP_HANDSHAKE_FAILED",
          "The backend handshake did not return its exact successful response",
        );
      }
      validateAcpV1Result(method, response.result);
      return { original, response };
    };
    try {
      if (signal.aborted) throw signal.reason;
      const current = store.getBackend(workspaceId, record.backendId);
      if (!current || current.id !== record.id || !current.enabled)
        throw new EngineError(
          "BACKEND_DISABLED",
          "The registered backend is disabled or stale",
        );
      // Root authenticates the original request before this adapter reads it.
      const owner = this.options.turns.readOwner(originalTurn);
      this.options.turns.assertOwnerCurrent(originalTurn, owner, "dispatch");
      // Text-only ACP prompts cannot silently omit native images or documents.
      if (
        originalTurn.resolvedImages?.length ||
        originalTurn.resolvedDocuments?.length ||
        originalTurn.messages.some(
          (message) => message.attachments?.length || message.documents?.length,
        )
      )
        throw new EngineError(
          "ACP_CONTENT_UNSUPPORTED",
          "The backend currently supports text context only",
        );
      const prompt = [
        {
          type: "text" as const,
          text: JSON.stringify({
            contextOwner: "engine",
            messages: originalTurn.messages,
          }),
        },
      ];
      validateAcpV1Request("session/prompt", { sessionId: "pending", prompt });
      process = await processes.launch(
        originalTurn,
        record.spec,
        record.id,
        signal,
      );
      const proof = processes.readConnection(process);
      connection = store.openConnection(process, {
        workspaceId,
        requestId: randomUUID(),
        expectedRevision: 0,
        backendId: record.backendId,
        connectionId: proof.connectionId,
      }).record;
      frames = processes.frames(process, signal)[Symbol.asyncIterator]();
      const readTextFile = originalTurn.tools.some(
        (tool) => tool.name === "read_file",
      );
      const initialized = await handshake("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "moodcode", version: "0.1.0" },
      });
      try {
        negotiateAcpV1Capabilities(
          "result" in initialized.response ? initialized.response.result : null,
          { readTextFile },
        );
        observe(initialized.original, "initialized", null);
      } finally {
        processes.releasePeerObservation(initialized.original);
      }
      const created = await handshake("session/new", {
        cwd: record.spec.launch.cwd,
        mcpServers: [],
      });
      try {
        const result = validateAcpV1Result(
          "session/new",
          "result" in created.response ? created.response.result : null,
        );
        remoteSessionId = result.sessionId;
        observe(created.original, "session-ready", remoteSessionId);
      } finally {
        processes.releasePeerObservation(created.original);
      }
      const remoteRequestId = randomUUID(),
        rpcId = randomUUID();
      const message: AcpV1Request = {
        jsonrpc: "2.0",
        id: rpcId,
        method: "session/prompt",
        params: { sessionId: remoteSessionId, prompt },
      };
      validateAcpV1Request("session/prompt", message.params);
      request = store.prepareRequest(originalTurn, process, {
        workspaceId,
        requestId: randomUUID(),
        expectedRevision: 0,
        remoteRequestId,
        connectionId: connection.connectionId,
        rpcId,
        remoteSessionId,
        message,
      }).record;
      request = store.dispatchRequest(originalTurn, {
        workspaceId,
        requestId: randomUUID(),
        expectedRevision: request.revision,
        remoteRequestId,
      }).record;
      const sent = await write(message);
      try {
        request = store.markRequestDispatched(sent, {
          workspaceId,
          requestId: randomUUID(),
          expectedRevision: request.revision,
          remoteRequestId,
        }).record;
      } finally {
        processes.releaseWrite(sent);
      }
      yield { type: "progress", providerRequestId: remoteRequestId };
      let stopReason: AcpV1StopReason | undefined;
      while (!terminal) {
        const original = await next();
        const frame = processes.readPeerObservation(original);
        const wire = frame.message;
        let retain = false;
        try {
          observe(original, "observe", remoteSessionId);
          if ("method" in wire) {
            if ("id" in wire) {
              if (wire.method === "fs/read_text_file" && readTextFile) {
                await this.effects.read({
                  originalTurn,
                  originalFrame: original,
                  originalConnection: process,
                  workspaceId,
                  remoteRequestId,
                  remoteSessionId,
                  signal,
                });
              } else {
                const unsupported = await write({
                  jsonrpc: "2.0",
                  id: wire.id,
                  error: {
                    code: -32601,
                    message: "Client capability unsupported",
                  },
                });
                processes.releaseWrite(unsupported);
              }
              yield { type: "progress" };
            } else if (wire.method === "session/update") {
              const update = validateAcpV1Request(
                "session/update",
                wire.params,
              );
              if (update.sessionId !== remoteSessionId)
                throw new EngineError(
                  "BACKEND_REMOTE_SESSION_INVALID",
                  "The backend update belongs to another session",
                );
              if (
                ["agent_message_chunk", "agent_thought_chunk"].includes(
                  update.update.sessionUpdate,
                )
              ) {
                const content = update.update.content;
                if (
                  !content ||
                  typeof content !== "object" ||
                  Array.isArray(content) ||
                  content.type !== "text" ||
                  typeof content.text !== "string"
                )
                  throw new EngineError(
                    "ACP_CONTENT_UNSUPPORTED",
                    "The backend emitted unsupported content",
                  );
                yield {
                  type:
                    update.update.sessionUpdate === "agent_message_chunk"
                      ? "text.delta"
                      : "reasoning.delta",
                  delta: content.text,
                };
              } else yield { type: "progress" };
            } else
              throw new EngineError(
                "ACP_METHOD_UNSUPPORTED",
                "The backend emitted an unsupported notification",
              );
          } else {
            if (wire.id !== rpcId)
              throw new EngineError(
                "BACKEND_REQUEST_STALE",
                "The backend response belongs to another prompt",
              );
            if ("result" in wire)
              stopReason = validateAcpV1Result(
                "session/prompt",
                wire.result,
              ).stopReason;
            else if (!("error" in wire))
              throw new EngineError(
                "BACKEND_TERMINAL_INVALID",
                "The backend prompt has no final result",
              );
            terminal = original;
            retain = true;
          }
        } finally {
          if (!retain) processes.releasePeerObservation(original);
        }
      }
      // A v1 final alone does not establish actual backend process cleanup.
      disposal = await processes.dispose(process);
      const cleanup = processes.readDisposal(disposal);
      connection = store.disposeConnection(disposal, {
        workspaceId,
        requestId: randomUUID(),
        expectedRevision: connection.revision,
        connectionId: connection.connectionId,
      }).record;
      if (!cleanup.cleanupConfirmed)
        throw new EngineError(
          "CLEANUP_UNCERTAIN",
          "The remote backend process group is not confirmed stopped",
        );
      request = store.settleRequest(terminal, {
        workspaceId,
        requestId: randomUUID(),
        expectedRevision: request.revision,
        remoteRequestId,
      }).record;
      settled = true;
      if (request.state === "failed")
        throw new EngineError(
          "ACP_REMOTE_ERROR",
          "The remote backend returned an error",
        );
      if (stopReason === "cancelled")
        throw new EngineError(
          "CANCELLED",
          "The remote backend cancelled its prompt",
        );
      if (stopReason === "max_turn_requests")
        throw new EngineError(
          "TOOL_CALL_LIMIT",
          "The remote backend stopped at its request limit",
        );
      if (stopReason === "refusal")
        throw new EngineError(
          "ACP_REFUSAL",
          "The remote backend refused its prompt",
        );
      yield {
        type: "finish",
        reason: stopReason === "max_tokens" ? "length" : "stop",
      };
    } catch (error) {
      if (remoteFailure(error).code === "CLEANUP_UNCERTAIN")
        cleanupState.durable = false;
      if (
        request &&
        !settled &&
        ["prepared", "dispatching", "dispatched"].includes(request.state)
      ) {
        try {
          request = store.markRequestUncertain({
            workspaceId,
            requestId: randomUUID(),
            expectedRevision: request.revision,
            remoteRequestId: request.remoteRequestId,
            errorCode: remoteFailure(error).code,
          }).record;
        } catch {
          cleanupState.durable = false;
          throw new EngineError(
            "CLEANUP_UNCERTAIN",
            "The remote prompt outcome could not be durably recorded",
          );
        }
      }
      throw remoteFailure(error);
    } finally {
      if (process) {
        // A launch can precede a failed native admission transaction. Physical
        // disposal cannot replace the missing durable connection receipt.
        if (!connection) cleanupState.durable = false;
        disposal ??= await processes.dispose(process);
        try {
          if (connection && !["closed", "uncertain"].includes(connection.state))
            connection = store.disposeConnection(disposal, {
              workspaceId,
              requestId: randomUUID(),
              expectedRevision: connection.revision,
              connectionId: connection.connectionId,
            }).record;
          if (!processes.readDisposal(disposal).cleanupConfirmed)
            throw new EngineError(
              "CLEANUP_UNCERTAIN",
              "Owned backend process cleanup remains uncertain",
            );
        } finally {
          processes.releaseDisposal(disposal);
        }
      }
      if (
        request &&
        !settled &&
        ["prepared", "dispatching", "dispatched"].includes(request.state)
      ) {
        try {
          request = store.markRequestUncertain({
            workspaceId,
            requestId: randomUUID(),
            expectedRevision: request.revision,
            remoteRequestId: request.remoteRequestId,
            errorCode: "PROVIDER_STREAM_CLOSED",
          }).record;
        } catch {
          cleanupState.durable = false;
          throw new EngineError(
            "CLEANUP_UNCERTAIN",
            "The interrupted remote prompt outcome could not be durably recorded",
          );
        }
      }
      if (terminal) processes.releasePeerObservation(terminal);
      await frames?.return?.();
      cleanupState.confirmed = cleanupState.durable;
    }
  }
}
