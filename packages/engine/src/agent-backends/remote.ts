import { platform } from "node:os";
import { BackendNativeEffects } from "./native-effects.js";
import { randomUUID } from "node:crypto";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import type { ProviderAdapter, ProviderEvent, TurnRequest } from "../ports.js";
import {
  BackendClientEffects,
  type BackendNativeClientEffectPort,
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
  clientReads: BackendNativeClientEffectPort;
  turns: ActualBackendTurnPort;
  lifetime: AbortSignal;
  clientEffectsEnabled?: boolean;
  terminalEffectsEnabled?: boolean;
}
function remoteFailure(value: unknown): EngineError {
  return value instanceof EngineError
    ? value
    : new EngineError(
        "ACP_REMOTE_ERROR",
        "The remote backend did not complete the current request",
      );
}

/** One fresh physical connection per native Attempt; explicit load bindings keep prior agent context separate from Engine context. */
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
    const protocolAbort = new AbortController();
    const signal = AbortSignal.any([
      inputSignal,
      this.options.lifetime,
      protocolAbort.signal,
    ]);
    const pendingControls = new Set<Promise<void>>();
    const { store, processes, record } = this.options;
    const workspaceId = record.workspaceId;
    let process: object | undefined;
    let connection: BackendConnectionRevision | undefined;
    let request: BackendRemoteRequest | undefined;
    let terminal: object | undefined;
    let frames: AsyncIterator<object> | undefined;
    let remoteSessionId: string | undefined;
    let originalSession: object | undefined;
    let originalSessionWrite: object | undefined;
    let disposal: object | undefined;
    let settled = false;
    let nativeEffects: BackendNativeEffects | undefined;
    let capabilities:
      import("./types.js").AcpV1NegotiatedCapabilities | undefined;
    let cancelSent = false;
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
      const currentInput =
        record.spec.contextOwner === "agent"
          ? this.options.turns.readCurrentInput?.(originalTurn)
          : undefined;
      if (record.spec.contextOwner === "agent" && !currentInput)
        throw new EngineError(
          "ACP_CONTEXT_OWNER_UNSUPPORTED",
          "Agent-owned context requires the original native current input producer",
        );
      const prompt = [
        {
          type: "text" as const,
          text: JSON.stringify(
            record.spec.contextOwner === "agent"
              ? {
                  contextOwner: "agent",
                  source: record.spec.sessionLoad,
                  instructions: currentInput!.instructions,
                  messages: [{ role: "user", content: currentInput!.prompt }],
                }
              : {
                  contextOwner: "engine",
                  messages: originalTurn.messages,
                },
          ),
        },
      ];
      validateAcpV1Request("session/prompt", { sessionId: "pending", prompt });
      process = await processes.launch(
        originalTurn,
        record.spec,
        record.id,
        this.options.lifetime,
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
      const writeTextFile =
        this.options.clientEffectsEnabled === true &&
        originalTurn.tools.some((tool) => tool.name === "apply_patch");
      const terminalSupport =
        this.options.terminalEffectsEnabled === true &&
        platform() !== "win32" &&
        originalTurn.tools.some((tool) => tool.name === "run_command");
      const initialized = await handshake("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile, writeTextFile },
          terminal: terminalSupport,
        },
        clientInfo: { name: "moodcode", version: "0.1.0" },
      });
      try {
        capabilities = negotiateAcpV1Capabilities(
          "result" in initialized.response ? initialized.response.result : null,
          {
            readTextFile,
            writeTextFile,
            terminal: terminalSupport,
            loadSession: record.spec.contextOwner === "agent",
            contextOwner: record.spec.contextOwner,
          },
        );
        observe(initialized.original, "initialized", null);
        connection = store.negotiateCapabilities(
          originalTurn,
          initialized.original,
          {
            workspaceId,
            requestId: randomUUID(),
            expectedRevision: connection.revision,
            connectionId: connection.connectionId,
          },
        ).record;
      } finally {
        processes.releasePeerObservation(initialized.original);
      }
      if (record.spec.contextOwner === "agent") {
        if (!record.spec.sessionLoad || !capabilities.loadSession)
          throw new EngineError(
            "ACP_LOAD_UNSUPPORTED",
            "The exact backend did not negotiate session loading",
          );
        remoteSessionId = record.spec.sessionLoad.remoteSessionId;
        const loadMessage: AcpV1Request = {
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "session/load",
          params: {
            sessionId: remoteSessionId,
            cwd: record.spec.launch.cwd,
            mcpServers: [],
          },
        };
        validateAcpV1Request("session/load", loadMessage.params);
        connection = store.prepareSessionLoad(originalTurn, {
          workspaceId,
          requestId: randomUUID(),
          expectedRevision: connection.revision,
          connectionId: connection.connectionId,
          message: loadMessage,
        }).record;
        originalSessionWrite = await write(loadMessage);
        let replayFrames = 0,
          replayBytes = 0;
        while (!originalSession) {
          const original = await next();
          const wire = processes.readPeerObservation(original).message;
          let retain = false;
          try {
            if ("method" in wire) {
              if ("id" in wire || wire.method !== "session/update")
                throw new EngineError(
                  "ACP_LOAD_EFFECT_UNSUPPORTED",
                  "Loading only accepts historical session updates",
                );
              const update = validateAcpV1Request(
                "session/update",
                wire.params,
              );
              if (update.sessionId !== remoteSessionId)
                throw new EngineError(
                  "BACKEND_REMOTE_SESSION_INVALID",
                  "Loaded history belongs to another session",
                );
              replayBytes += Buffer.byteLength(JSON.stringify(wire));
              if (++replayFrames > 128 || replayBytes > 32768)
                throw new EngineError(
                  "AGENT_BACKEND_LIMIT",
                  "Loaded history exceeds its finite replay bound",
                );
              observe(original, "initialized", null);
            } else {
              if (wire.id !== loadMessage.id || !("result" in wire))
                throw new EngineError(
                  "ACP_HANDSHAKE_FAILED",
                  "The load did not return its exact successful response",
                );
              validateAcpV1Result("session/load", wire.result);
              connection = store.recordLoadedSession(
                original,
                originalSessionWrite,
                {
                  workspaceId,
                  requestId: randomUUID(),
                  expectedRevision: connection.revision,
                  connectionId: connection.connectionId,
                },
              ).record;
              originalSession = original;
              retain = true;
            }
          } finally {
            if (!retain) processes.releasePeerObservation(original);
          }
        }
      } else {
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
          originalSession = created.original;
        } finally {
          if (!originalSession)
            processes.releasePeerObservation(created.original);
        }
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
      nativeEffects = new BackendNativeEffects(this.options, {
        originalTurn,
        originalConnection: process,
        workspaceId,
        remoteRequestId,
        remoteSessionId,
        cwd: record.spec.launch.cwd,
        signal,
      });
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
              } else if (
                (wire.method === "fs/write_text_file" &&
                  capabilities?.writeTextFile) ||
                (wire.method.startsWith("terminal/") &&
                  capabilities?.terminal) ||
                (wire.method === "session/request_permission" &&
                  (capabilities?.writeTextFile || capabilities?.terminal))
              ) {
                try {
                  if (wire.method === "terminal/wait_for_exit") {
                    retain = true;
                    const active = nativeEffects
                      .handle(original, wire)
                      .catch((error) => {
                        protocolAbort.abort(error);
                      })
                      .finally(() => {
                        processes.releasePeerObservation(original);
                        pendingControls.delete(active);
                      });
                    pendingControls.add(active);
                  } else await nativeEffects.handle(original, wire);
                } catch (error) {
                  if (
                    signal.aborted &&
                    wire.method === "session/request_permission"
                  ) {
                    try {
                      const cancelled = await processes.writeCancellation(
                        process,
                        originalSession!,
                        {
                          jsonrpc: "2.0",
                          id: wire.id,
                          result: { outcome: { outcome: "cancelled" } },
                        },
                        AbortSignal.timeout(250),
                        original,
                        originalSessionWrite,
                      );
                      processes.releaseWrite(cancelled);
                    } catch {}
                  }
                  throw error;
                }
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
      await Promise.all(pendingControls);
      if (protocolAbort.signal.aborted) throw protocolAbort.signal.reason;
      await nativeEffects.complete();
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
      let clientCloseFailure: unknown;
      if (
        process &&
        remoteSessionId &&
        (originalSession || originalSessionWrite) &&
        !settled &&
        !cancelSent
      ) {
        cancelSent = true;
        try {
          const message = {
            jsonrpc: "2.0" as const,
            method: "session/cancel",
            params: { sessionId: remoteSessionId },
          };
          const original = await processes.writeCancellation(
            process,
            originalSession ?? originalSessionWrite!,
            message,
            AbortSignal.timeout(250),
            undefined,
            originalSessionWrite,
          );
          try {
            if (request)
              request = store.recordRequestCancel(original, {
                workspaceId,
                requestId: randomUUID(),
                expectedRevision: request.revision,
                remoteRequestId: request.remoteRequestId,
                message,
              }).record;
          } finally {
            processes.releaseWrite(original);
          }
        } catch {}
      }
      try {
        await nativeEffects?.close();
        await Promise.all(pendingControls);
      } catch (error) {
        clientCloseFailure = error;
        cleanupState.durable = false;
      }
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
      if (originalSession) processes.releasePeerObservation(originalSession);
      if (originalSessionWrite) processes.releaseWrite(originalSessionWrite);
      await frames?.return?.();
      cleanupState.confirmed = cleanupState.durable;
      if (clientCloseFailure) throw clientCloseFailure;
    }
  }
}
