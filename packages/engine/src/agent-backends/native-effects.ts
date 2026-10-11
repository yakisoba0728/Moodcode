import { createHash, randomUUID } from "node:crypto";
import {
  EngineError,
  type JsonObject,
  type JsonValue,
} from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import type { TurnRequest } from "../ports.js";
import {
  backendReadResponse,
  type BackendClientEffectInput,
  type BackendClientReadInput,
  type BackendClientReadProof,
  type BackendEffectPorts,
} from "./client-effects.js";
import type {
  BackendClientEffectRevision,
  DeliverBackendClientEffectInput,
} from "./store.js";
import type { AcpV1Request, AcpV1Response } from "./types.js";
import {
  validateAcpV1PermissionParams,
  validateAcpV1TerminalCreateParams,
  validateAcpV1WriteTextFileParams,
  validateAcpV1Request,
} from "./protocol.js";

interface Entry {
  handle: object;
  record: BackendClientEffectRevision;
  input: BackendClientEffectInput;
  permissionKey: string;
  permission: boolean;
  dispatched: boolean;
  settled: boolean;
  released: boolean;
  completion?: BackendClientReadProof;
  settling?: Promise<BackendClientReadProof>;
}
export interface BackendNativeEffectScope {
  originalTurn: TurnRequest;
  originalConnection: object;
  workspaceId: string;
  remoteRequestId: string;
  remoteSessionId: string;
  cwd: string;
  signal: AbortSignal;
}
/** One Attempt only. Neither serialized terminal IDs nor old native receipts can recreate these handles. */
export class BackendNativeEffects {
  private readonly entries = new Map<string, Entry>();
  private controls = 0;
  constructor(
    private readonly options: BackendEffectPorts,
    private readonly scope: BackendNativeEffectScope,
  ) {}
  private async send(response: AcpV1Response): Promise<object> {
    return this.options.processes.write(
      this.scope.originalConnection,
      response,
      this.scope.signal,
    );
  }
  private base(entry: Pick<Entry, "record">, requestId: string = randomUUID()) {
    return {
      workspaceId: this.scope.workspaceId,
      requestId,
      expectedRevision: entry.record.revision,
      effectId: entry.record.effectId,
    };
  }
  /** Sends the reply, then records it against the entry's current revision. */
  private async respond(
    entry: Pick<Entry, "record">,
    response: AcpV1Response,
    record: (
      receipt: object,
      input: DeliverBackendClientEffectInput,
    ) => { record: BackendClientEffectRevision },
    requestId?: string,
  ): Promise<void> {
    const receipt = await this.send(response);
    try {
      entry.record = record(receipt, {
        ...this.base(entry, requestId),
        message: response,
      }).record;
    } finally {
      this.options.processes.releaseWrite(receipt);
    }
  }
  private identity(method: string, params: unknown): string {
    return knowledgeHash({ method, params });
  }
  private input(message: AcpV1Request): BackendClientEffectInput {
    const callId = `acp:${knowledgeHash([this.scope.remoteRequestId, typeof message.id, message.id])}`;
    if (message.method === "fs/write_text_file") {
      const p = validateAcpV1WriteTextFileParams(message.params);
      this.session(p.sessionId);
      return {
        callId,
        method: message.method,
        path: p.path,
        content: p.content,
      };
    }
    const p = validateAcpV1TerminalCreateParams(message.params);
    this.session(p.sessionId);
    return {
      callId,
      method: "terminal/create",
      command: p.command,
      args: p.args ?? [],
      cwd: p.cwd ?? this.scope.cwd,
      outputByteLimit: p.outputByteLimit ?? 16384,
    };
  }
  private session(id: string): void {
    if (id !== this.scope.remoteSessionId)
      throw new EngineError(
        "BACKEND_REMOTE_SESSION_INVALID",
        "The effect belongs to another remote session",
      );
  }
  private async prepare(
    frame: object,
    message: AcpV1Request,
    permission: boolean,
  ): Promise<Entry> {
    if (this.entries.size >= 16)
      throw new EngineError(
        "BACKEND_EFFECT_LIMIT",
        "The Attempt client effect bound was reached",
      );
    const effect = permission
      ? validateAcpV1PermissionParams(message.params).toolCall.rawInput
      : message;
    const canonical = {
      ...message,
      method: effect.method,
      params: effect.params,
    } as AcpV1Request;
    const input = this.input(canonical),
      effectId = randomUUID();
    const record = this.options.store.prepareClientRead(
      this.scope.originalTurn,
      frame,
      {
        workspaceId: this.scope.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 0,
        effectId,
        remoteRequestId: this.scope.remoteRequestId,
        input,
      },
    ).record;
    let handle: object;
    try {
      handle = await this.options.clientReads.prepareEffect(
        this.scope.originalTurn,
        input,
        this.scope.signal,
      );
    } catch (error) {
      this.options.store.markClientEffectUncertain({
        workspaceId: this.scope.workspaceId,
        requestId: randomUUID(),
        expectedRevision: record.revision,
        effectId,
        errorCode:
          error instanceof EngineError
            ? error.code
            : "BACKEND_CLIENT_EFFECT_FAILED",
      });
      throw error;
    }
    const entry: Entry = {
      handle,
      record,
      input,
      permissionKey: this.identity(canonical.method, canonical.params),
      permission,
      dispatched: false,
      settled: false,
      released: false,
    };
    this.entries.set(effectId, entry);
    return entry;
  }
  private settle(entry: Entry): Promise<BackendClientReadProof> {
    return (entry.settling ??= (async () => {
      if (entry.completion) return entry.completion;
      const original = await this.options.clientReads.waitEffect(entry.handle);
      try {
        const proof = this.options.clientReads.readCompletion(original);
        entry.record = this.options.store.settleClientRead(
          original,
          this.base(entry),
        ).record;
        entry.completion = proof;
        entry.settled = true;
        return proof;
      } finally {
        this.options.clientReads.releaseCompletion(original);
      }
    })());
  }
  /** Same-Attempt native tool receipts settle before any remote read response. */
  async read(originalFrame: object): Promise<void> {
    const frame = this.options.processes.readPeerObservation(originalFrame);
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
    if (params.sessionId !== this.scope.remoteSessionId)
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
      this.scope.originalTurn,
      originalFrame,
      {
        workspaceId: this.scope.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 0,
        effectId,
        remoteRequestId: this.scope.remoteRequestId,
        input: read,
      },
    );
    if (prepared.duplicate)
      throw new EngineError(
        "BACKEND_EFFECT_ALREADY_BOUND",
        "A historical client read cannot be replayed",
      );
    const entry = { record: prepared.record };
    let completion: object | undefined;
    try {
      completion = await this.options.clientReads.executeRead(
        this.scope.originalTurn,
        read,
        this.scope.signal,
      );
      const proof = this.options.clientReads.readCompletion(completion);
      entry.record = this.options.store.settleClientRead(
        completion,
        this.base(entry),
      ).record;
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
      await this.respond(entry, response, (receipt, input) =>
        this.options.store.recordClientDelivery(receipt, input),
      );
    } finally {
      if (completion) this.options.clientReads.releaseCompletion(completion);
    }
  }
  async handle(originalFrame: object, message: AcpV1Request): Promise<void> {
    if (++this.controls > 64)
      throw new EngineError(
        "BACKEND_EFFECT_LIMIT",
        "The Attempt client RPC bound was reached",
      );
    if (message.method === "session/request_permission")
      await this.permission(originalFrame, message);
    else if (
      message.method === "fs/write_text_file" ||
      message.method === "terminal/create"
    )
      await this.effect(originalFrame, message);
    else await this.terminalControl(originalFrame, message);
  }
  private async permission(
    originalFrame: object,
    message: AcpV1Request,
  ): Promise<void> {
    const params = validateAcpV1PermissionParams(message.params);
    this.session(params.sessionId);
    if (!params.options.some((option) => option.kind === "allow_once")) {
      const receipt = await this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { outcome: { outcome: "cancelled" } },
      });
      this.options.processes.releaseWrite(receipt);
      return;
    }
    const entry = await this.prepare(originalFrame, message, true),
      proof = this.options.clientReads.readPermission(entry.handle);
    const option = params.options.find(
      (option) =>
        option.kind === (proof.allowed ? "allow_once" : "reject_once"),
    );
    const response: AcpV1Response = {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        outcome: option
          ? { outcome: "selected", optionId: option.optionId }
          : { outcome: "cancelled" },
      },
    };
    await this.respond(entry, response, (receipt, input) =>
      this.options.store.recordClientPermission(entry.handle, receipt, input),
    );
    if (!proof.allowed) {
      await this.settle(entry);
      this.options.clientReads.releaseEffect(entry.handle);
      entry.released = true;
    }
  }
  private async effect(
    originalFrame: object,
    message: AcpV1Request,
  ): Promise<void> {
    const input = this.input(message),
      key = this.identity(message.method, message.params);
    const permitted = [...this.entries.values()].find(
      (e) =>
        e.permission && !e.dispatched && !e.released && e.permissionKey === key,
    );
    if (
      !permitted &&
      [...this.entries.values()].some(
        (e) => e.permission && !e.dispatched && !e.released,
      )
    )
      throw new EngineError(
        "ACP_PERMISSION_STALE",
        "The wire effect changed after its precise approval",
      );
    const entry =
      permitted ?? (await this.prepare(originalFrame, message, false));
    if (entry.permission) {
      // The RPC response identity changes; the native effect remains bound to its original permission frame.
      entry.record = this.options.store.bindApprovedClientEffect(
        this.scope.originalTurn,
        originalFrame,
        {
          ...this.base(entry),
          input: { ...input, callId: entry.input.callId },
        },
      ).record;
    }
    const proof = this.options.clientReads.readPermission(entry.handle);
    if (!proof.allowed) {
      const completion = await this.settle(entry);
      await this.deliver(entry, message.id, completion);
      return;
    }
    await this.options.clientReads.dispatchEffect(entry.handle);
    entry.dispatched = true;
    if (message.method === "terminal/create")
      await this.respond(
        entry,
        {
          jsonrpc: "2.0",
          id: message.id,
          result: { terminalId: `terminal:${entry.record.effectId}` },
        },
        (receipt, input) =>
          this.options.store.recordClientAcknowledgement(receipt, input),
      );
    else {
      const completion = await this.settle(entry);
      await this.deliver(entry, message.id, completion);
    }
  }
  private async terminalControl(
    originalFrame: object,
    message: AcpV1Request,
  ): Promise<void> {
    const p = validateAcpV1Request(message.method, message.params) as {
      sessionId: string;
      terminalId: string;
    };
    this.session(p.sessionId);
    const id = p.terminalId.startsWith("terminal:")
      ? p.terminalId.slice(9)
      : "";
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.released ||
      !entry.dispatched ||
      entry.input.method !== "terminal/create"
    )
      throw new EngineError(
        "BACKEND_TERMINAL_STALE",
        "Only an original current terminal may be observed or cancelled",
      );
    let result: JsonValue = {};
    if (message.method === "terminal/output") {
      result = this.options.clientReads.readTerminalOutput(entry.handle);
      if (
        entry.completion?.result &&
        typeof entry.completion.result === "object" &&
        !Array.isArray(entry.completion.result) &&
        entry.completion.result.started !== false
      ) {
        const data = entry.completion.result;
        result = {
          ...(result as JsonObject),
          exitStatus: {
            exitCode: data.exitCode ?? null,
            signal: data.signal ?? null,
          },
        };
      }
    } else {
      if (
        message.method === "terminal/kill" ||
        message.method === "terminal/release"
      )
        this.options.clientReads.cancelEffect(entry.handle);
      const completion = await this.settle(entry),
        data = completion.result as JsonObject | null;
      if (!completion.cleanupConfirmed)
        throw new EngineError(
          "CLEANUP_UNCERTAIN",
          "The native command group did not confirm cleanup",
        );
      if (message.method === "terminal/wait_for_exit")
        result = {
          exitCode: data?.exitCode ?? null,
          signal: data?.signal ?? null,
        };
    }
    const response: AcpV1Response = { jsonrpc: "2.0", id: message.id, result };
    const requestId = randomUUID();
    this.options.store.assertTerminalControl(
      this.scope.originalTurn,
      originalFrame,
      { ...this.base(entry, requestId), message: response },
    );
    await this.respond(
      entry,
      response,
      (receipt, input) =>
        this.options.store.recordTerminalControl(
          this.scope.originalTurn,
          originalFrame,
          receipt,
          input,
        ),
      requestId,
    );
    if (message.method === "terminal/release") {
      this.options.clientReads.releaseEffect(entry.handle);
      entry.released = true;
    }
  }
  private async deliver(
    entry: Entry,
    id: string | number,
    proof: BackendClientReadProof,
  ): Promise<void> {
    const response: AcpV1Response =
      proof.state === "completed" &&
      proof.errorCode === null &&
      proof.cleanupConfirmed
        ? { jsonrpc: "2.0", id, result: {} }
        : {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32001,
              message: proof.errorCode ?? "Native effect failed",
            },
          };
    await this.respond(entry, response, (receipt, input) =>
      this.options.store.recordClientDelivery(receipt, input),
    );
    this.options.clientReads.releaseEffect(entry.handle);
    entry.released = true;
  }
  async complete(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (!entry.dispatched && !entry.settled)
        throw new EngineError(
          "BACKEND_EFFECT_UNSETTLED",
          "An approved precise effect was not consumed",
        );
      if (!entry.settled) await this.settle(entry);
    }
  }
  async close(): Promise<void> {
    let failure: unknown;
    for (const entry of this.entries.values()) {
      if (entry.released) continue;
      this.options.clientReads.cancelEffect(entry.handle);
      try {
        if (!entry.settled) await this.settle(entry);
      } catch (error) {
        try {
          this.options.store.markClientEffectUncertain({
            ...this.base(entry),
            errorCode: "CLEANUP_UNCERTAIN",
          });
        } catch {}
        failure = error;
      } finally {
        this.options.clientReads.releaseEffect(entry.handle);
        entry.released = true;
      }
    }
    if (failure)
      throw new EngineError(
        "CLEANUP_UNCERTAIN",
        "Client effects could not settle durably",
      );
  }
}
