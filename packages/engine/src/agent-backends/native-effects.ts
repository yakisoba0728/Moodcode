import { randomUUID } from "node:crypto";
import {
  EngineError,
  type JsonObject,
  type JsonValue,
} from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import type { TurnRequest } from "../ports.js";
import type {
  BackendClientEffectInput,
  BackendClientReadProof,
  BackendNativeClientEffectPort,
} from "./client-effects.js";
import type { BackendProcessPort } from "./process.js";
import type {
  AgentBackendStorage,
  BackendClientEffectRevision,
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
export interface BackendNativeEffectsOptions {
  store: AgentBackendStorage;
  processes: BackendProcessPort;
  clientReads: BackendNativeClientEffectPort;
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
    private readonly options: BackendNativeEffectsOptions,
    private readonly scope: BackendNativeEffectScope,
  ) {}
  private async send(
    response: AcpV1Response,
    signal = this.scope.signal,
  ): Promise<object> {
    return this.options.processes.write(
      this.scope.originalConnection,
      response,
      signal,
    );
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
        entry.record = this.options.store.settleClientRead(original, {
          workspaceId: this.scope.workspaceId,
          requestId: randomUUID(),
          expectedRevision: entry.record.revision,
          effectId: entry.record.effectId,
        }).record;
        entry.completion = proof;
        entry.settled = true;
        return proof;
      } finally {
        this.options.clientReads.releaseCompletion(original);
      }
    })());
  }
  async handle(originalFrame: object, message: AcpV1Request): Promise<void> {
    if (++this.controls > 64)
      throw new EngineError(
        "BACKEND_EFFECT_LIMIT",
        "The Attempt client RPC bound was reached",
      );
    if (message.method === "session/request_permission") {
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
      const receipt = await this.send(response);
      try {
        entry.record = this.options.store.recordClientPermission(
          entry.handle,
          receipt,
          {
            workspaceId: this.scope.workspaceId,
            requestId: randomUUID(),
            expectedRevision: entry.record.revision,
            effectId: entry.record.effectId,
            message: response,
          },
        ).record;
      } finally {
        this.options.processes.releaseWrite(receipt);
      }
      if (!proof.allowed) {
        await this.settle(entry);
        this.options.clientReads.releaseEffect(entry.handle);
        entry.released = true;
      }
      return;
    }
    if (
      message.method === "fs/write_text_file" ||
      message.method === "terminal/create"
    ) {
      const input = this.input(message),
        key = this.identity(message.method, message.params);
      let entry = [...this.entries.values()].find(
        (e) =>
          e.permission &&
          !e.dispatched &&
          !e.released &&
          e.permissionKey === key,
      );
      if (
        !entry &&
        [...this.entries.values()].some(
          (e) => e.permission && !e.dispatched && !e.released,
        )
      )
        throw new EngineError(
          "ACP_PERMISSION_STALE",
          "The wire effect changed after its precise approval",
        );
      if (!entry) entry = await this.prepare(originalFrame, message, false);
      if (entry.permission) {
        // The RPC response identity changes; the native effect remains bound to its original permission frame.
        entry.record = this.options.store.bindApprovedClientEffect(
          this.scope.originalTurn,
          originalFrame,
          {
            workspaceId: this.scope.workspaceId,
            requestId: randomUUID(),
            expectedRevision: entry.record.revision,
            effectId: entry.record.effectId,
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
      if (message.method === "terminal/create") {
        const response: AcpV1Response = {
          jsonrpc: "2.0",
          id: message.id,
          result: { terminalId: `terminal:${entry.record.effectId}` },
        };
        const receipt = await this.send(response);
        try {
          entry.record = this.options.store.recordClientAcknowledgement(
            receipt,
            {
              workspaceId: this.scope.workspaceId,
              requestId: randomUUID(),
              expectedRevision: entry.record.revision,
              effectId: entry.record.effectId,
              message: response,
            },
          ).record;
        } finally {
          this.options.processes.releaseWrite(receipt);
        }
      } else {
        const completion = await this.settle(entry);
        await this.deliver(entry, message.id, completion);
      }
      return;
    }
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
    const receipt = await this.send(response);
    try {
      entry.record = this.options.store.recordTerminalControl(
        this.scope.originalTurn,
        originalFrame,
        receipt,
        {
          workspaceId: this.scope.workspaceId,
          requestId: randomUUID(),
          expectedRevision: entry.record.revision,
          effectId: entry.record.effectId,
          message: response,
        },
      ).record;
    } finally {
      this.options.processes.releaseWrite(receipt);
    }
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
    const receipt = await this.send(response);
    try {
      entry.record = this.options.store.recordClientDelivery(receipt, {
        workspaceId: this.scope.workspaceId,
        requestId: randomUUID(),
        expectedRevision: entry.record.revision,
        effectId: entry.record.effectId,
        message: response,
      }).record;
    } finally {
      this.options.processes.releaseWrite(receipt);
    }
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
            workspaceId: this.scope.workspaceId,
            requestId: randomUUID(),
            expectedRevision: entry.record.revision,
            effectId: entry.record.effectId,
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
