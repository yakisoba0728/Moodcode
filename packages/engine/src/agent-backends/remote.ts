import { BackendNativeEffects } from "./native-effects.js";
import { randomUUID } from "node:crypto";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import type { ProviderAdapter, ProviderEvent, TurnRequest } from "../ports.js";
import type { AgentBackendHostOptions } from "./host.js";
import type { BackendConnectionProof } from "./process.js";
import type {
  AgentBackendRevision,
  BackendConnectionRevision,
  BackendRemoteRequest,
} from "./store.js";
import type {
  AcpV1InitializeResult,
  AcpV1Message,
  AcpV1NegotiatedCapabilities,
  AcpV1NewSessionResult,
  AcpV1Request,
  AcpV1StopReason,
} from "./types.js";
import {
  negotiateAcpV1Capabilities,
  validateAcpV1Request,
  validateAcpV1Result,
} from "./protocol.js";

export interface AgentBackendRemoteOptions extends Omit<
  AgentBackendHostOptions,
  "lifetime"
> {
  record: AgentBackendRevision;
  lifetime: AbortSignal;
}
interface CleanupState {
  started: boolean;
  confirmed: boolean;
  durable: boolean;
}
interface HandshakeResults {
  initialize: AcpV1InitializeResult;
  "session/new": AcpV1NewSessionResult;
}
type ClientCapabilities = NonNullable<
  BackendConnectionProof["clientCapabilities"]
>;
type TextPrompt = { type: "text"; text: string }[];
const STOP_FAILURES: Partial<Record<AcpV1StopReason, [string, string]>> = {
  cancelled: ["CANCELLED", "The remote backend cancelled its prompt"],
  max_turn_requests: [
    "TOOL_CALL_LIMIT",
    "The remote backend stopped at its request limit",
  ],
  refusal: ["ACP_REFUSAL", "The remote backend refused its prompt"],
};
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
  constructor(private readonly options: AgentBackendRemoteOptions) {
    this.id = `acp:${options.record.backendId}`;
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
    cleanupState: CleanupState,
  ): AsyncGenerator<ProviderEvent> {
    const attempt = new RemoteAttempt(
      this.options,
      originalTurn,
      inputSignal,
      cleanupState,
    );
    try {
      const prompt = attempt.buildPrompt();
      await attempt.initialize(await attempt.admit());
      await attempt.establishSession();
      yield {
        type: "progress",
        providerRequestId: await attempt.dispatchPrompt(prompt),
      };
      while (!attempt.terminal) {
        const event = await attempt.handleFrame(await attempt.next());
        if (event) yield event;
      }
      yield await attempt.settle();
    } catch (error) {
      const failure = remoteFailure(error);
      if (failure.code === "CLEANUP_UNCERTAIN") cleanupState.durable = false;
      attempt.markUncertain(
        failure.code,
        "The remote prompt outcome could not be durably recorded",
      );
      throw failure;
    } finally {
      await attempt.cleanup();
    }
  }
}

class RemoteAttempt {
  private readonly protocolAbort = new AbortController();
  private readonly signal: AbortSignal;
  private readonly pendingControls = new Set<Promise<void>>();
  private readonly workspaceId: string;
  private process: object | undefined;
  private connection: BackendConnectionRevision | undefined;
  private request: BackendRemoteRequest | undefined;
  terminal: object | undefined;
  private frames: AsyncIterator<object> | undefined;
  private remoteSessionId: string | undefined;
  private originalSession: object | undefined;
  private originalSessionWrite: object | undefined;
  private disposal: object | undefined;
  private settled = false;
  private nativeEffects: BackendNativeEffects | undefined;
  private capabilities: AcpV1NegotiatedCapabilities | undefined;
  private rpcId: string | undefined;
  private stopReason: AcpV1StopReason | undefined;
  constructor(
    private readonly options: AgentBackendRemoteOptions,
    private readonly originalTurn: TurnRequest,
    inputSignal: AbortSignal,
    private readonly cleanupState: CleanupState,
  ) {
    this.signal = AbortSignal.any([
      inputSignal,
      options.lifetime,
      this.protocolAbort.signal,
    ]);
    this.workspaceId = options.record.workspaceId;
  }
  private onConnection() {
    return {
      workspaceId: this.workspaceId,
      requestId: randomUUID(),
      expectedRevision: this.connection!.revision,
      connectionId: this.connection!.connectionId,
    };
  }
  private onRequest() {
    return {
      workspaceId: this.workspaceId,
      requestId: randomUUID(),
      expectedRevision: this.request!.revision,
      remoteRequestId: this.request!.remoteRequestId,
    };
  }
  private observe(
    original: object,
    state: "initialized" | "session-ready" | "observe",
    session: string | null,
  ): void {
    if (!this.connection)
      throw new EngineError(
        "BACKEND_CONNECTION_STALE",
        "The native connection has not been admitted",
      );
    this.connection = this.options.store.recordPeerObservation(original, {
      ...this.onConnection(),
      state,
      remoteSessionId: session,
    }).record;
  }
  async next(): Promise<object> {
    const item = await this.frames!.next();
    if (item.done)
      throw new EngineError(
        "BACKEND_DISCONNECTED",
        "Remote EOF is not prompt completion",
      );
    return item.value;
  }
  private async write(message: AcpV1Message): Promise<object> {
    return this.options.processes.write(this.process!, message, this.signal);
  }
  private async handshake<M extends keyof HandshakeResults>(
    method: M,
    params: JsonObject,
  ): Promise<{ original: object; result: HandshakeResults[M] }> {
    const { processes } = this.options;
    const id = randomUUID();
    validateAcpV1Request(method, params);
    const written = await this.write({ jsonrpc: "2.0", id, method, params });
    processes.releaseWrite(written);
    const original = await this.next();
    const response = processes.readPeerObservation(original).message;
    if ("method" in response || response.id !== id || !("result" in response)) {
      processes.releasePeerObservation(original);
      throw new EngineError(
        "ACP_HANDSHAKE_FAILED",
        "The backend handshake did not return its exact successful response",
      );
    }
    const result = validateAcpV1Result(method, response.result);
    return { original, result: result as HandshakeResults[M] };
  }
  buildPrompt(): TextPrompt {
    const { store, turns, record } = this.options;
    const originalTurn = this.originalTurn;
    if (this.signal.aborted) throw this.signal.reason;
    const current = store.getBackend(this.workspaceId, record.backendId);
    if (!current || current.id !== record.id || !current.enabled)
      throw new EngineError(
        "BACKEND_DISABLED",
        "The registered backend is disabled or stale",
      );
    // Root authenticates the original request before this adapter reads it.
    const owner = turns.readOwner(originalTurn);
    turns.assertOwnerCurrent(originalTurn, owner, "dispatch");
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
        ? turns.readCurrentInput?.(originalTurn)
        : undefined;
    if (record.spec.contextOwner === "agent" && !currentInput)
      throw new EngineError(
        "ACP_CONTEXT_OWNER_UNSUPPORTED",
        "Agent-owned context requires the original native current input producer",
      );
    const prompt: TextPrompt = [
      {
        type: "text",
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
    return prompt;
  }
  /** Returns the client capabilities pinned by the launch. */
  async admit(): Promise<ClientCapabilities> {
    const { store, processes, record } = this.options;
    this.process = await processes.launch(
      this.originalTurn,
      record.spec,
      record.id,
      this.options.lifetime,
    );
    const proof = processes.readConnection(this.process);
    this.connection = store.openConnection(this.process, {
      workspaceId: this.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 0,
      backendId: record.backendId,
      connectionId: proof.connectionId,
    }).record;
    this.frames = processes
      .frames(this.process, this.signal)
      [Symbol.asyncIterator]();
    if (!proof.clientCapabilities)
      throw new EngineError(
        "BACKEND_CAPABILITIES_INVALID",
        "The owned connection did not pin its client capabilities",
      );
    return proof.clientCapabilities;
  }
  async initialize(client: ClientCapabilities): Promise<void> {
    const { store, processes, record } = this.options;
    const initialized = await this.handshake("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: client.readTextFile,
          writeTextFile: client.writeTextFile,
        },
        terminal: client.terminal,
      },
      clientInfo: { name: "moodcode", version: "0.1.0" },
    });
    try {
      this.capabilities = negotiateAcpV1Capabilities(initialized.result, {
        ...client,
        loadSession: record.spec.contextOwner === "agent",
        contextOwner: record.spec.contextOwner,
      });
      this.observe(initialized.original, "initialized", null);
      this.connection = store.negotiateCapabilities(
        this.originalTurn,
        initialized.original,
        this.onConnection(),
      ).record;
    } finally {
      processes.releasePeerObservation(initialized.original);
    }
  }
  async establishSession(): Promise<void> {
    const { store, processes, record } = this.options;
    if (record.spec.contextOwner !== "agent") {
      const created = await this.handshake("session/new", {
        cwd: record.spec.launch.cwd,
        mcpServers: [],
      });
      try {
        this.remoteSessionId = created.result.sessionId;
        this.observe(created.original, "session-ready", this.remoteSessionId);
        this.originalSession = created.original;
      } finally {
        if (!this.originalSession)
          processes.releasePeerObservation(created.original);
      }
      return;
    }
    if (!record.spec.sessionLoad || !this.capabilities?.loadSession)
      throw new EngineError(
        "ACP_LOAD_UNSUPPORTED",
        "The exact backend did not negotiate session loading",
      );
    const remoteSessionId = record.spec.sessionLoad.remoteSessionId;
    this.remoteSessionId = remoteSessionId;
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
    this.connection = store.prepareSessionLoad(this.originalTurn, {
      ...this.onConnection(),
      message: loadMessage,
    }).record;
    const sessionWrite = await this.write(loadMessage);
    this.originalSessionWrite = sessionWrite;
    let replayFrames = 0,
      replayBytes = 0;
    while (!this.originalSession) {
      const original = await this.next();
      const wire = processes.readPeerObservation(original).message;
      let retain = false;
      try {
        if ("method" in wire) {
          if ("id" in wire || wire.method !== "session/update")
            throw new EngineError(
              "ACP_LOAD_EFFECT_UNSUPPORTED",
              "Loading only accepts historical session updates",
            );
          const update = validateAcpV1Request("session/update", wire.params);
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
          this.observe(original, "initialized", null);
        } else {
          if (wire.id !== loadMessage.id || !("result" in wire))
            throw new EngineError(
              "ACP_HANDSHAKE_FAILED",
              "The load did not return its exact successful response",
            );
          validateAcpV1Result("session/load", wire.result);
          this.connection = store.recordLoadedSession(
            original,
            sessionWrite,
            this.onConnection(),
          ).record;
          this.originalSession = original;
          retain = true;
        }
      } finally {
        if (!retain) processes.releasePeerObservation(original);
      }
    }
  }
  async dispatchPrompt(prompt: TextPrompt): Promise<string> {
    const { store, processes, record } = this.options;
    const remoteSessionId = this.remoteSessionId!;
    const remoteRequestId = randomUUID(),
      rpcId = randomUUID();
    const message: AcpV1Request = {
      jsonrpc: "2.0",
      id: rpcId,
      method: "session/prompt",
      params: { sessionId: remoteSessionId, prompt },
    };
    validateAcpV1Request("session/prompt", message.params);
    this.rpcId = rpcId;
    this.request = store.prepareRequest(this.originalTurn, this.process!, {
      workspaceId: this.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 0,
      remoteRequestId,
      connectionId: this.connection!.connectionId,
      rpcId,
      remoteSessionId,
      message,
    }).record;
    this.request = store.dispatchRequest(
      this.originalTurn,
      this.onRequest(),
    ).record;
    const sent = await this.write(message);
    try {
      this.request = store.markRequestDispatched(sent, this.onRequest()).record;
    } finally {
      processes.releaseWrite(sent);
    }
    this.nativeEffects = new BackendNativeEffects(this.options, {
      originalTurn: this.originalTurn,
      originalConnection: this.process!,
      workspaceId: this.workspaceId,
      remoteRequestId,
      remoteSessionId,
      cwd: record.spec.launch.cwd,
      signal: this.signal,
    });
    return remoteRequestId;
  }
  async handleFrame(original: object): Promise<ProviderEvent | undefined> {
    const { processes } = this.options;
    const nativeEffects = this.nativeEffects!;
    const capabilities = this.capabilities;
    const wire = processes.readPeerObservation(original).message;
    let retain = false;
    try {
      this.observe(original, "observe", this.remoteSessionId!);
      if ("method" in wire) {
        if ("id" in wire) {
          if (
            wire.method === "fs/read_text_file" &&
            capabilities?.readTextFile
          ) {
            await nativeEffects.read(original);
          } else if (
            (wire.method === "fs/write_text_file" &&
              capabilities?.writeTextFile) ||
            (wire.method.startsWith("terminal/") && capabilities?.terminal) ||
            (wire.method === "session/request_permission" &&
              (capabilities?.writeTextFile || capabilities?.terminal))
          ) {
            try {
              if (wire.method === "terminal/wait_for_exit") {
                retain = true;
                const active = nativeEffects
                  .handle(original, wire)
                  .catch((error) => {
                    this.protocolAbort.abort(error);
                  })
                  .finally(() => {
                    processes.releasePeerObservation(original);
                    this.pendingControls.delete(active);
                  });
                this.pendingControls.add(active);
              } else await nativeEffects.handle(original, wire);
            } catch (error) {
              if (
                this.signal.aborted &&
                wire.method === "session/request_permission"
              ) {
                try {
                  const cancelled = await processes.writeCancellation(
                    this.process!,
                    this.originalSession!,
                    {
                      jsonrpc: "2.0",
                      id: wire.id,
                      result: { outcome: { outcome: "cancelled" } },
                    },
                    AbortSignal.timeout(250),
                    original,
                    this.originalSessionWrite,
                  );
                  processes.releaseWrite(cancelled);
                } catch {}
              }
              throw error;
            }
          } else {
            const unsupported = await this.write({
              jsonrpc: "2.0",
              id: wire.id,
              error: {
                code: -32601,
                message: "Client capability unsupported",
              },
            });
            processes.releaseWrite(unsupported);
          }
          return { type: "progress" };
        }
        if (wire.method !== "session/update")
          throw new EngineError(
            "ACP_METHOD_UNSUPPORTED",
            "The backend emitted an unsupported notification",
          );
        const update = validateAcpV1Request("session/update", wire.params);
        if (update.sessionId !== this.remoteSessionId)
          throw new EngineError(
            "BACKEND_REMOTE_SESSION_INVALID",
            "The backend update belongs to another session",
          );
        if (
          !["agent_message_chunk", "agent_thought_chunk"].includes(
            update.update.sessionUpdate,
          )
        )
          return { type: "progress" };
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
        return {
          type:
            update.update.sessionUpdate === "agent_message_chunk"
              ? "text.delta"
              : "reasoning.delta",
          delta: content.text,
        };
      }
      if (wire.id !== this.rpcId)
        throw new EngineError(
          "BACKEND_REQUEST_STALE",
          "The backend response belongs to another prompt",
        );
      if ("result" in wire)
        this.stopReason = validateAcpV1Result(
          "session/prompt",
          wire.result,
        ).stopReason;
      else if (!("error" in wire))
        throw new EngineError(
          "BACKEND_TERMINAL_INVALID",
          "The backend prompt has no final result",
        );
      this.terminal = original;
      retain = true;
      return undefined;
    } finally {
      if (!retain) processes.releasePeerObservation(original);
    }
  }
  async settle(): Promise<ProviderEvent> {
    const { store, processes } = this.options;
    await Promise.all(this.pendingControls);
    if (this.protocolAbort.signal.aborted)
      throw this.protocolAbort.signal.reason;
    await this.nativeEffects!.complete();
    // A v1 final alone does not establish actual backend process cleanup.
    const disposal = await processes.dispose(this.process!);
    this.disposal = disposal;
    const cleanup = processes.readDisposal(disposal);
    this.connection = store.disposeConnection(
      disposal,
      this.onConnection(),
    ).record;
    if (!cleanup.cleanupConfirmed)
      throw new EngineError(
        "CLEANUP_UNCERTAIN",
        "The remote backend process group is not confirmed stopped",
      );
    const request = store.settleRequest(
      this.terminal!,
      this.onRequest(),
    ).record;
    this.request = request;
    this.settled = true;
    if (request.state === "failed")
      throw new EngineError(
        "ACP_REMOTE_ERROR",
        "The remote backend returned an error",
      );
    const stop = this.stopReason && STOP_FAILURES[this.stopReason];
    if (stop) throw new EngineError(stop[0], stop[1]);
    return {
      type: "finish",
      reason: this.stopReason === "max_tokens" ? "length" : "stop",
    };
  }
  markUncertain(errorCode: string, message: string): void {
    if (
      !this.request ||
      this.settled ||
      !["prepared", "dispatching", "dispatched"].includes(this.request.state)
    )
      return;
    try {
      this.request = this.options.store.markRequestUncertain({
        ...this.onRequest(),
        errorCode,
      }).record;
    } catch {
      this.cleanupState.durable = false;
      throw new EngineError("CLEANUP_UNCERTAIN", message);
    }
  }
  async cleanup(): Promise<void> {
    const { store, processes } = this.options;
    let clientCloseFailure: unknown;
    if (
      this.process &&
      this.remoteSessionId &&
      (this.originalSession || this.originalSessionWrite) &&
      !this.settled
    ) {
      try {
        const message = {
          jsonrpc: "2.0" as const,
          method: "session/cancel",
          params: { sessionId: this.remoteSessionId },
        };
        const original = await processes.writeCancellation(
          this.process,
          this.originalSession ?? this.originalSessionWrite!,
          message,
          AbortSignal.timeout(250),
          undefined,
          this.originalSessionWrite,
        );
        try {
          if (this.request)
            this.request = store.recordRequestCancel(original, {
              ...this.onRequest(),
              message,
            }).record;
        } finally {
          processes.releaseWrite(original);
        }
      } catch {}
    }
    try {
      await this.nativeEffects?.close();
      await Promise.all(this.pendingControls);
    } catch (error) {
      clientCloseFailure = error;
      this.cleanupState.durable = false;
    }
    if (this.process) {
      // A launch can precede a failed native admission transaction. Physical
      // disposal cannot replace the missing durable connection receipt.
      if (!this.connection) this.cleanupState.durable = false;
      const disposal = (this.disposal ??= await processes.dispose(
        this.process,
      ));
      try {
        if (
          this.connection &&
          !["closed", "uncertain"].includes(this.connection.state)
        )
          this.connection = store.disposeConnection(
            disposal,
            this.onConnection(),
          ).record;
        if (!processes.readDisposal(disposal).cleanupConfirmed)
          throw new EngineError(
            "CLEANUP_UNCERTAIN",
            "Owned backend process cleanup remains uncertain",
          );
      } finally {
        processes.releaseDisposal(disposal);
      }
    }
    this.markUncertain(
      "PROVIDER_STREAM_CLOSED",
      "The interrupted remote prompt outcome could not be durably recorded",
    );
    if (this.terminal) processes.releasePeerObservation(this.terminal);
    if (this.originalSession)
      processes.releasePeerObservation(this.originalSession);
    if (this.originalSessionWrite)
      processes.releaseWrite(this.originalSessionWrite);
    await this.frames?.return?.();
    this.cleanupState.confirmed = this.cleanupState.durable;
    if (clientCloseFailure) throw clientCloseFailure;
  }
}
