import { EngineError, type JsonObject } from "@moodcode/contracts";
import {
  immutableKnowledgeJson as json,
  knowledgeHash,
} from "../knowledge/validation.js";
import {
  assertOnlyChanged,
  assertRevisionLink,
} from "../storage/revision-journal.js";
import type {
  AgentBackendSpec,
  AgentBackendTargetPin,
  AcpV1Id,
  AcpV1Message,
  AcpV1NegotiatedCapabilities,
} from "./types.js";
import type {
  BackendConnectionProof,
  BackendPeerObservationProof,
  BackendWriteProof,
  BackendDisposalProof,
} from "./process.js";
import type {
  BackendClientReadInput,
  BackendClientReadProof,
  BackendClientEffectInput,
  BackendClientPermissionProof,
} from "./client-effects.js";
import {
  assertBackendTransition,
  BACKEND_CONNECTION_STATES,
  BACKEND_EFFECT_STATES,
  BACKEND_REQUEST_STATES,
  SETTLED_EFFECT_STATES,
  SETTLED_REQUEST_STATES,
  type BackendJournalKind,
  type BackendConnectionState,
  type BackendRequestState,
  type BackendEffectState,
} from "./reducer.js";
import {
  AGENT_BACKEND_LIMITS,
  agentBackendSigned as signed,
  validateAgentBackendSpec,
} from "./validation.js";
import {
  ACP_EFFECT_LIMITS,
  ACP_V1_STOP_REASONS,
  validateAcpV1Message,
  encodeAcpV1Message,
  validateAcpV1Result,
  negotiateAcpV1Capabilities,
  validateAcpV1Request,
  validateAcpV1ReadTextFileParams,
  validateAcpV1WriteTextFileParams,
  validateAcpV1TerminalCreateParams,
  validateAcpV1PermissionParams,
} from "./protocol.js";
export interface BackendTurnProof {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly requestSha256: string;
  readonly configSha256: string;
  readonly catalogueSha256: string;
  readonly contextRevisionId: string | null;
  readonly rootBindingSha256: string;
  readonly ownerEpoch: string;
  readonly sha256: string;
}
export interface BackendTargetProof {
  readonly workspaceId: string;
  readonly backendId: string;
  readonly target: AgentBackendTargetPin;
  readonly launchSha256: string;
  readonly rootBindingSha256: string;
  readonly ownerEpoch: string;
  readonly capabilitiesManifest?: string;
  readonly sha256: string;
}
export interface BackendRevisionBase {
  readonly id: string;
  readonly kind: BackendJournalKind;
  readonly entityId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly previousId: string | null;
  readonly lastReceiptId: string;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface AgentBackendRevision extends BackendRevisionBase {
  readonly kind: "backend";
  readonly backendId: string;
  readonly enabled: boolean;
  readonly spec: AgentBackendSpec;
  readonly target: BackendTargetProof;
}
export interface BackendConnectionRevision extends BackendRevisionBase {
  readonly kind: "connection";
  readonly backendId: string;
  readonly backendRevisionId: string;
  readonly backendSha256: string;
  readonly connectionId: string;
  readonly proof: BackendConnectionProof;
  readonly state: BackendConnectionState;
  readonly receiveOrdinal: number;
  readonly writeOrdinal: number;
  readonly remoteSessionId: string | null;
  readonly observation: BackendPeerObservationProof | null;
  readonly disposal: BackendDisposalProof | null;
  readonly errorCode: string | null;
  readonly capabilities?: AcpV1NegotiatedCapabilities;
  readonly sessionLoad?: BackendSessionLoadRevision;
}
export interface BackendSessionLoadRevision {
  readonly state: "dispatching" | "loaded" | "uncertain";
  readonly message: AcpV1Message;
  readonly write: BackendWriteProof | null;
  readonly response: BackendPeerObservationProof | null;
  readonly replayHashes: readonly string[];
  readonly replayBytes: number;
}
export interface BackendRemoteRequest extends BackendRevisionBase {
  readonly kind: "request";
  readonly remoteRequestId: string;
  readonly connectionId: string;
  readonly epoch: string;
  readonly backendRevisionId: string;
  readonly owner: BackendTurnProof;
  readonly rpcId: AcpV1Id;
  readonly remoteSessionId: string;
  readonly state: BackendRequestState;
  readonly wireMessage: AcpV1Message;
  readonly wireSha256: string;
  readonly dispatch: BackendWriteProof | null;
  readonly terminal: BackendPeerObservationProof | null;
  readonly cancellation?: { message: AcpV1Message; write: BackendWriteProof };
  readonly errorCode: string | null;
}
export interface BackendClientEffectRevision extends BackendRevisionBase {
  readonly kind: "client-effect";
  readonly effectId: string;
  readonly remoteRequestId: string;
  readonly connectionId: string;
  readonly epoch: string;
  readonly owner: BackendTurnProof;
  readonly rpcId: AcpV1Id;
  readonly input: BackendClientReadInput | BackendClientEffectInput;
  readonly state: BackendEffectState;
  readonly frame: BackendPeerObservationProof;
  readonly completion: BackendClientReadProof | null;
  readonly permission?: BackendClientPermissionProof | null;
  readonly permissionDelivery?: BackendWriteProof | null;
  readonly executionFrame?: BackendPeerObservationProof;
  readonly controls?: readonly {
    frame: BackendPeerObservationProof;
    write: BackendWriteProof;
    message: AcpV1Message;
  }[];
  readonly delivery: BackendWriteProof | null;
  readonly errorCode: string | null;
}
export type AgentBackendRecord =
  | AgentBackendRevision
  | BackendConnectionRevision
  | BackendRemoteRequest
  | BackendClientEffectRevision;
export interface BackendTransitionReceipt {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: BackendJournalKind;
  readonly entityId: string;
  readonly operation: string;
  readonly beforeRevisionId: string | null;
  readonly afterRevisionId: string;
  readonly afterSha256: string;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly requestInput: JsonObject;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface BackendMutationInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
}
export const AGENT_BACKEND_STORAGE_LIMITS = Object.freeze({
  rowBytes: 65536,
  rows: 8192,
  bytes: 33554432,
  backends: 32,
  connections: 64,
  requests: 512,
  effects: 512,
  outputBytes: 24576,
  replayFrames: 128,
  replayBytes: 32768,
  terminalControls: 32,
  eventScan: 512,
  eventBytes: 65536,
});
interface SignedBackendRevisionInput<T extends AgentBackendRecord> {
  readonly kind: BackendJournalKind;
  readonly entityId: string;
  readonly workspaceId: string;
  readonly before: T | undefined;
  readonly body: Omit<T, keyof BackendRevisionBase>;
  readonly requestInput: BackendMutationInput;
  readonly revisionId: string;
  readonly receiptId: string;
  readonly operation: string;
  readonly createdAt: string;
}
interface SignedBackendRevisionPair<T extends AgentBackendRecord> {
  readonly record: T;
  readonly receipt: BackendTransitionReceipt;
}
export function fail(code = "BACKEND_DATABASE_INVALID"): never {
  throw new EngineError(
    code,
    "Backend journal or original runtime owner is stale or invalid",
  );
}
/** Callers select inputs and capture IDs/time; validation precedes receipt signing. */
export function prepareSignedBackendRevision<T extends AgentBackendRecord>(
  input: SignedBackendRevisionInput<T>,
): SignedBackendRevisionPair<T> {
  const {
    kind,
    entityId,
    workspaceId,
    before,
    body,
    requestInput,
    revisionId,
    receiptId,
    operation,
    createdAt,
  } = input;
  const record = signed({
    ...body,
    id: revisionId,
    kind,
    entityId,
    workspaceId,
    revision: (before?.revision ?? 0) + 1,
    previousId: before?.id ?? null,
    lastReceiptId: receiptId,
    createdAt,
  }) as unknown as T;
  validateBody(record);
  assertBackendTransition(
    kind,
    before ? state(before) : null,
    state(record),
    operation,
  );
  validateTransition(before, record, operation);
  const receipt = signed({
    id: receiptId,
    workspaceId,
    kind,
    entityId,
    operation,
    beforeRevisionId: before?.id ?? null,
    afterRevisionId: revisionId,
    afterSha256: record.sha256,
    requestId: requestInput.requestId,
    requestSha256: knowledgeHash(requestInput),
    requestInput: requestInput as unknown as JsonObject,
    createdAt,
  });
  return { record, receipt };
}
export function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function resultObject(message: AcpV1Message): JsonObject | undefined {
  return "result" in message && isObject(message.result)
    ? message.result
    : undefined;
}
/** Stop reasons compare as strings in the journal, unlike validateAcpV1Result. */
export function isStopReason(value: unknown): boolean {
  return (ACP_V1_STOP_REASONS as readonly string[]).includes(String(value));
}
export function digest<T extends { sha256: string }>(value: T): T {
  const copy = json(value),
    { sha256, ...body } = copy;
  if (sha(sha256) !== knowledgeHash(body)) fail();
  return copy;
}
export function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > AGENT_BACKEND_LIMITS.requestIdBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail("INVALID_BACKEND_INPUT");
  return value;
}
export function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail();
  return value;
}
export function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max)
    fail("BACKEND_LIMIT");
  return Number(value);
}
export function fields(input: unknown, keys: readonly string[]): void {
  if (
    !isObject(input) ||
    Object.keys(input).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(input, k))
  )
    fail();
}
export function state(value: AgentBackendRecord): string {
  return value.kind === "backend"
    ? value.enabled
      ? "enabled"
      : "disabled"
    : value.state;
}
export function ownerOf(value: AgentBackendRecord): BackendTurnProof | null {
  return value.kind === "request" || value.kind === "client-effect"
    ? value.owner
    : null;
}
export function recoverable(kind: string, value: unknown): boolean {
  return kind === "connection"
    ? ["launched", "initialized", "session-ready", "closing"].includes(
        value as string,
      )
    : kind === "request"
      ? ["prepared", "dispatching", "dispatched"].includes(value as string)
      : kind === "client-effect" && value === "prepared";
}
export function pausable(kind: string, value: unknown): boolean {
  return kind === "backend" || value !== "paused-import";
}
export function bodyOf<T extends AgentBackendRecord>(
  record: T,
): Omit<T, keyof BackendRevisionBase> {
  const {
    id: _id,
    kind: _kind,
    entityId: _entity,
    workspaceId: _ws,
    revision: _rev,
    previousId: _prev,
    lastReceiptId: _receipt,
    createdAt: _at,
    sha256: _sha,
    ...body
  } = record;
  return body as Omit<T, keyof BackendRevisionBase>;
}
function validateSessionLoadBody(r: BackendConnectionRevision): void {
  const load = r.sessionLoad;
  if (!load) return;
  fields(load, [
    "state",
    "message",
    "write",
    "response",
    "replayHashes",
    "replayBytes",
  ]);
  if (
    !["dispatching", "loaded", "uncertain"].includes(load.state) ||
    !Array.isArray(load.replayHashes) ||
    load.replayHashes.length > AGENT_BACKEND_STORAGE_LIMITS.replayFrames ||
    !Number.isSafeInteger(load.replayBytes) ||
    load.replayBytes < 0 ||
    load.replayBytes > AGENT_BACKEND_STORAGE_LIMITS.replayBytes
  )
    fail("BACKEND_LOAD_REPLAY_LIMIT");
  for (const hash of load.replayHashes) sha(hash);
  const message = validateAcpV1Message(load.message);
  if (
    !("method" in message) ||
    !("id" in message) ||
    message.method !== "session/load"
  )
    fail();
  const params = validateAcpV1Request("session/load", message.params);
  if (load.state === "loaded") {
    if (!load.write || !load.response || r.remoteSessionId !== params.sessionId)
      fail();
    digest(load.write);
    digest(load.response);
    if (
      load.write.workspaceId !== r.workspaceId ||
      load.write.backendId !== r.backendId ||
      !Number.isSafeInteger(load.write.writeOrdinal) ||
      load.write.writeOrdinal < 1 ||
      load.write.writtenBytes !==
        Buffer.byteLength(encodeAcpV1Message(message)) ||
      load.write.connectionId !== r.connectionId ||
      load.write.epoch !== r.proof.epoch ||
      load.write.frameSha256 !== knowledgeHash(message) ||
      load.response.workspaceId !== r.workspaceId ||
      load.response.connectionId !== r.connectionId ||
      load.response.epoch !== r.proof.epoch ||
      load.response.backendId !== r.backendId ||
      !Number.isSafeInteger(load.response.receiveOrdinal) ||
      load.response.receiveOrdinal < 1 ||
      load.response.receiveOrdinal > r.receiveOrdinal ||
      load.response.wireId !== message.id ||
      !("result" in load.response.message) ||
      load.response.frameSha256 !== knowledgeHash(load.response.message)
    )
      fail("BACKEND_REMOTE_SESSION_INVALID");
    validateAcpV1Result("session/load", load.response.message.result);
  } else if (
    load.write !== null ||
    load.response !== null ||
    r.remoteSessionId !== null
  )
    fail();
  if (!r.capabilities?.loadSession || r.capabilities.contextOwner !== "agent")
    fail("ACP_LOAD_UNSUPPORTED");
}
export function effectRpc(e: BackendClientEffectRevision): AcpV1Id {
  return (e.executionFrame?.wireId as AcpV1Id) ?? e.rpcId;
}
export function validateTerminalControl(
  e: BackendClientEffectRevision,
  control: {
    frame: BackendPeerObservationProof;
    write: BackendWriteProof;
    message: AcpV1Message;
  },
  session: string,
): void {
  digest(control.frame);
  digest(control.write);
  const wire = control.frame.message,
    message = control.message;
  if (
    !("method" in wire) ||
    !("id" in wire) ||
    (wire.method !== "terminal/output" &&
      wire.method !== "terminal/wait_for_exit" &&
      wire.method !== "terminal/kill" &&
      wire.method !== "terminal/release") ||
    !("id" in message) ||
    message.id !== wire.id ||
    !("result" in message) ||
    control.frame.connectionId !== e.connectionId ||
    control.frame.epoch !== e.epoch ||
    control.write.connectionId !== e.connectionId ||
    control.write.epoch !== e.epoch ||
    control.write.frameSha256 !== knowledgeHash(message)
  )
    fail("BACKEND_DELIVERY_INVALID");
  const p = validateAcpV1Request(wire.method, wire.params);
  if (
    p.terminalId !== `terminal:${e.effectId}` ||
    p.sessionId !== session ||
    (wire.method !== "terminal/output" && !e.completion?.cleanupConfirmed)
  )
    fail("BACKEND_TERMINAL_STALE");
  const data = e.completion?.result as JsonObject | null;
  if (
    wire.method === "terminal/wait_for_exit" &&
    knowledgeHash(message.result) !==
      knowledgeHash({
        exitCode: data?.exitCode ?? null,
        signal: data?.signal ?? null,
      })
  )
    fail("BACKEND_DELIVERY_INVALID");
  if (
    ["terminal/kill", "terminal/release"].includes(wire.method) &&
    knowledgeHash(message.result) !== knowledgeHash({})
  )
    fail("BACKEND_DELIVERY_INVALID");
}
export function validateEffectInput(
  message: AcpV1Message,
  input: BackendClientReadInput | BackendClientEffectInput,
  session: string,
): void {
  if (!("method" in message) || !("id" in message))
    fail("ACP_EFFECT_UNSUPPORTED");
  let method = message.method,
    params = message.params as JsonObject;
  if (method === "session/request_permission") {
    const request = validateAcpV1PermissionParams(params);
    method = request.toolCall.rawInput.method;
    params = request.toolCall.rawInput.params as unknown as JsonObject;
  }
  if (params?.sessionId !== session) fail("BACKEND_REMOTE_SESSION_INVALID");
  if (!("method" in input)) {
    const p = validateAcpV1ReadTextFileParams(params);
    if (
      method !== "fs/read_text_file" ||
      p.path !== input.path ||
      (p.line ?? undefined) !== input.line ||
      (p.limit ?? undefined) !== input.limit
    )
      fail("BACKEND_EFFECT_INPUT_INVALID");
  } else if (input.method === "fs/write_text_file") {
    const p = validateAcpV1WriteTextFileParams(params);
    if (
      method !== input.method ||
      p.path !== input.path ||
      p.content !== input.content
    )
      fail("BACKEND_EFFECT_INPUT_INVALID");
  } else {
    const p = validateAcpV1TerminalCreateParams(params);
    if (
      method !== input.method ||
      p.command !== input.command ||
      knowledgeHash(p.args ?? []) !== knowledgeHash(input.args) ||
      (p.cwd !== undefined && p.cwd !== input.cwd) ||
      (p.outputByteLimit ?? ACP_EFFECT_LIMITS.terminalOutputBytes) !==
        input.outputByteLimit
    )
      fail("BACKEND_EFFECT_INPUT_INVALID");
  }
}
export function validatePermissionResponse(
  e: BackendClientEffectRevision,
  p: BackendClientPermissionProof,
  message: AcpV1Message,
): void {
  const result =
    "id" in message && message.id === e.rpcId
      ? resultObject(message)
      : undefined;
  if (!result) fail("BACKEND_DELIVERY_INVALID");
  const request = validateAcpV1PermissionParams(
      (e.frame.message as { params: unknown }).params,
    ),
    outcome = result.outcome;
  if (!isObject(outcome)) fail("BACKEND_DELIVERY_INVALID");
  if (p.allowed) {
    if (
      outcome.outcome !== "selected" ||
      !request.options.some(
        (o) => o.kind === "allow_once" && o.optionId === outcome.optionId,
      )
    )
      fail("BACKEND_DELIVERY_INVALID");
  } else if (
    outcome.outcome !== "cancelled" &&
    !(
      outcome.outcome === "selected" &&
      request.options.some(
        (o) => o.kind === "reject_once" && o.optionId === outcome.optionId,
      )
    )
  )
    fail("BACKEND_DELIVERY_INVALID");
}
export function validateEffectResponse(
  e: BackendClientEffectRevision,
  message: AcpV1Message,
): void {
  if (!e.completion) fail("BACKEND_DELIVERY_INVALID");
  const p = e.completion;
  if (p.effectMethod) {
    if (p.state === "completed" && p.errorCode === null && p.cleanupConfirmed) {
      if (!("result" in message)) fail("BACKEND_DELIVERY_INVALID");
      if (
        p.effectMethod === "fs/write_text_file" &&
        knowledgeHash(message.result) !== knowledgeHash({})
      )
        fail("BACKEND_DELIVERY_INVALID");
      if (
        p.effectMethod === "terminal/create" &&
        resultObject(message)?.terminalId !== `terminal:${e.effectId}`
      )
        fail("BACKEND_DELIVERY_INVALID");
    } else if (!("error" in message)) fail("BACKEND_DELIVERY_INVALID");
  } else if (p.content !== null && p.errorCode === null) {
    const result = resultObject(message);
    if (!result || result.content !== p.content)
      fail("BACKEND_DELIVERY_INVALID");
  } else if (!("error" in message)) fail("BACKEND_DELIVERY_INVALID");
}
export function validateBody(r: AgentBackendRecord): void {
  digest(r);
  id(r.id);
  id(r.entityId);
  id(r.workspaceId);
  integer(r.revision);
  if (r.revision < 1) fail();
  if (r.previousId !== null) id(r.previousId);
  id(r.lastReceiptId);
  if (
    !Number.isFinite(Date.parse(r.createdAt)) ||
    new Date(r.createdAt).toISOString() !== r.createdAt
  )
    fail();
  const base = [
    "id",
    "kind",
    "entityId",
    "workspaceId",
    "revision",
    "previousId",
    "lastReceiptId",
    "createdAt",
    "sha256",
  ];
  if (r.kind === "backend") {
    fields(r, [...base, "backendId", "enabled", "spec", "target"]);
    const spec = validateAgentBackendSpec(r.spec);
    digest(r.target);
    if (
      r.backendId !== r.entityId ||
      spec.id !== r.backendId ||
      r.target.workspaceId !== r.workspaceId ||
      r.target.backendId !== r.backendId ||
      r.spec.target.workspaceId !== r.workspaceId ||
      knowledgeHash(r.target.target) !== knowledgeHash(spec.target) ||
      typeof r.enabled !== "boolean"
    )
      fail();
  } else if (r.kind === "connection") {
    fields(r, [
      ...base,
      "backendId",
      "backendRevisionId",
      "backendSha256",
      "connectionId",
      "proof",
      "state",
      "receiveOrdinal",
      "writeOrdinal",
      "remoteSessionId",
      "observation",
      "disposal",
      "errorCode",
      ...(r.capabilities ? ["capabilities"] : []),
      ...(r.sessionLoad ? ["sessionLoad"] : []),
    ]);
    digest(r.proof);
    if (r.capabilities) {
      digest(r.capabilities);
      const negotiated = negotiateAcpV1Capabilities(
        {
          protocolVersion: 1,
          agentCapabilities: { loadSession: r.capabilities.loadSession },
        },
        {
          ...(r.proof.clientCapabilities ?? {
            readTextFile: r.capabilities.readTextFile,
          }),
          contextOwner: r.capabilities.contextOwner,
          loadSession: r.capabilities.loadSession,
        },
      );
      if (knowledgeHash(negotiated) !== knowledgeHash(r.capabilities))
        fail("BACKEND_CAPABILITIES_INVALID");
    }
    for (const key of [
      "backendId",
      "backendRevisionId",
      "connectionId",
      "epoch",
      "birthNonce",
    ] as const)
      id(r.proof[key]);
    for (const key of ["backendSha256", "launchSha256", "ownerSha256"] as const)
      sha(r.proof[key]);
    if (
      r.connectionId !== r.entityId ||
      r.proof.connectionId !== r.connectionId ||
      r.proof.workspaceId !== r.workspaceId ||
      r.proof.backendId !== r.backendId ||
      r.proof.backendRevisionId !== r.backendRevisionId ||
      r.proof.backendSha256 !== r.backendSha256 ||
      !BACKEND_CONNECTION_STATES.includes(r.state) ||
      !Number.isSafeInteger(r.proof.processId) ||
      r.proof.processId < 1
    )
      fail();
    integer(r.receiveOrdinal);
    integer(r.writeOrdinal);
    if (r.observation) {
      digest(r.observation);
      validateAcpV1Message(r.observation.message);
      if (
        r.observation.connectionId !== r.connectionId ||
        r.observation.epoch !== r.proof.epoch ||
        r.observation.workspaceId !== r.workspaceId ||
        r.observation.receiveOrdinal !== r.receiveOrdinal ||
        r.observation.frameSha256 !== knowledgeHash(r.observation.message)
      )
        fail();
    }
    if (r.disposal) {
      digest(r.disposal);
      if (
        r.disposal.connectionId !== r.connectionId ||
        r.disposal.epoch !== r.proof.epoch ||
        r.disposal.workspaceId !== r.workspaceId ||
        r.disposal.processId !== r.proof.processId ||
        typeof r.disposal.cleanupConfirmed !== "boolean"
      )
        fail();
    }
    if (r.state === "closed" && r.disposal?.cleanupConfirmed !== true) fail();
    if (r.state === "session-ready" && r.remoteSessionId === null) fail();
    validateSessionLoadBody(r);
  } else if (r.kind === "request") {
    fields(r, [
      ...base,
      "remoteRequestId",
      "connectionId",
      "epoch",
      "backendRevisionId",
      "owner",
      "rpcId",
      "remoteSessionId",
      "state",
      "wireMessage",
      "wireSha256",
      "dispatch",
      "terminal",
      "errorCode",
      ...(r.cancellation ? ["cancellation"] : []),
    ]);
    digest(r.owner);
    const wire = validateAcpV1Message(r.wireMessage);
    if (
      !("method" in wire) ||
      wire.method !== "session/prompt" ||
      !("id" in wire) ||
      wire.id !== r.rpcId ||
      !wire.params ||
      wire.params.sessionId !== r.remoteSessionId
    )
      fail();
    if (
      r.remoteRequestId !== r.entityId ||
      r.owner.workspaceId !== r.workspaceId ||
      r.wireSha256 !== knowledgeHash(r.wireMessage) ||
      !BACKEND_REQUEST_STATES.includes(r.state)
    )
      fail();
    if (r.cancellation) {
      const cancel = validateAcpV1Message(r.cancellation.message);
      digest(r.cancellation.write);
      if (
        !("method" in cancel) ||
        "id" in cancel ||
        cancel.method !== "session/cancel" ||
        validateAcpV1Request("session/cancel", cancel.params).sessionId !==
          r.remoteSessionId ||
        r.cancellation.write.workspaceId !== r.workspaceId ||
        r.cancellation.write.connectionId !== r.connectionId ||
        r.cancellation.write.epoch !== r.epoch ||
        r.cancellation.write.frameSha256 !== knowledgeHash(cancel)
      )
        fail("BACKEND_REMOTE_SESSION_INVALID");
    }
    if (r.dispatch) {
      digest(r.dispatch);
      if (
        r.dispatch.workspaceId !== r.workspaceId ||
        r.dispatch.connectionId !== r.connectionId ||
        r.dispatch.epoch !== r.epoch ||
        r.dispatch.frameSha256 !== r.wireSha256
      )
        fail();
    }
    if (r.terminal) {
      digest(r.terminal);
      if (
        r.terminal.workspaceId !== r.workspaceId ||
        r.terminal.connectionId !== r.connectionId ||
        r.terminal.epoch !== r.epoch ||
        r.terminal.wireId !== r.rpcId ||
        r.terminal.frameSha256 !== knowledgeHash(r.terminal.message)
      )
        fail();
    }
    const settled = SETTLED_REQUEST_STATES.includes(r.state);
    if ((settled || r.state === "dispatched") && !r.dispatch) fail();
    if (settled) {
      if (!r.terminal) fail();
      const m = r.terminal.message;
      if (r.state === "failed") {
        if (!("error" in m)) fail();
      } else {
        const stopReason = resultObject(m)?.stopReason;
        if (
          !isStopReason(stopReason) ||
          (stopReason === "cancelled") !== (r.state === "cancelled")
        )
          fail();
      }
    }
  } else if (r.kind === "client-effect") {
    fields(r, [
      ...base,
      "effectId",
      "remoteRequestId",
      "connectionId",
      "epoch",
      "owner",
      "rpcId",
      "input",
      "state",
      "frame",
      "completion",
      "delivery",
      "errorCode",
      ...(Object.hasOwn(r, "permission")
        ? ["permission", "permissionDelivery"]
        : []),
      ...(r.executionFrame ? ["executionFrame"] : []),
      ...(r.controls ? ["controls"] : []),
    ]);
    digest(r.owner);
    digest(r.frame);
    const frame = validateAcpV1Message(r.frame.message);
    if (!("method" in frame) || !("id" in frame) || frame.id !== r.rpcId)
      fail();
    const sessionId = (frame.params as JsonObject)?.sessionId as string;
    validateEffectInput(frame, r.input, sessionId);
    if (r.executionFrame) {
      digest(r.executionFrame);
      if (!r.permission?.allowed || !("method" in r.executionFrame.message))
        fail();
      validateEffectInput(r.executionFrame.message, r.input, sessionId);
    }
    if (r.controls) {
      if (r.controls.length > AGENT_BACKEND_STORAGE_LIMITS.terminalControls)
        fail();
      const identities = new Set<string>();
      let released = false;
      for (const control of r.controls) {
        const key = knowledgeHash([
          typeof control.frame.wireId,
          control.frame.wireId,
        ]);
        if (identities.has(key) || released) fail("BACKEND_TERMINAL_STALE");
        identities.add(key);
        validateTerminalControl(r, control, sessionId);
        released =
          "method" in control.frame.message &&
          control.frame.message.method === "terminal/release";
      }
    }
    if (r.permission) {
      digest(r.permission);
      if (!r.permissionDelivery) fail();
      digest(r.permissionDelivery);
      if (
        r.permissionDelivery.workspaceId !== r.workspaceId ||
        r.permissionDelivery.connectionId !== r.connectionId ||
        r.permissionDelivery.epoch !== r.epoch
      )
        fail();
    }
    if (
      r.effectId !== r.entityId ||
      r.owner.workspaceId !== r.workspaceId ||
      r.frame.workspaceId !== r.workspaceId ||
      r.frame.connectionId !== r.connectionId ||
      r.frame.epoch !== r.epoch ||
      r.frame.wireId !== r.rpcId ||
      !BACKEND_EFFECT_STATES.includes(r.state)
    )
      fail();
    if (r.completion) {
      digest(r.completion);
      if (
        !["paused-import", "uncertain"].includes(r.state) &&
        r.completion.state !== r.state
      )
        fail();
    }
    if (SETTLED_EFFECT_STATES.includes(r.state) && !r.completion) fail();
    if (r.delivery) {
      digest(r.delivery);
      if (
        (!r.completion &&
          (!("method" in r.input) || r.input.method !== "terminal/create")) ||
        r.delivery.workspaceId !== r.workspaceId ||
        r.delivery.connectionId !== r.connectionId ||
        r.delivery.epoch !== r.epoch
      )
        fail();
    }
  } else fail();
}
/** Body keys each operation may change; operations missing here are rejected. */
const MUTABLE: ReadonlyMap<string, readonly string[]> = new Map([
  ["register", ["spec", "target", "enabled"]],
  ["disable", ["enabled"]],
  ["negotiate", ["capabilities"]],
  ["load-intent", ["sessionLoad"]],
  [
    "load-ready",
    [
      "sessionLoad",
      "state",
      "receiveOrdinal",
      "writeOrdinal",
      "observation",
      "remoteSessionId",
    ],
  ],
  ["observe", ["state", "receiveOrdinal", "remoteSessionId", "observation"]],
  ["dispose", ["state", "disposal", "errorCode"]],
  ["cancel-wire", ["cancellation"]],
  ["dispatch-intent", ["state"]],
  ["dispatch", ["state", "dispatch"]],
  ["settle", ["state", "terminal", "errorCode"]],
  ["bind-effect", ["executionFrame"]],
  ["terminal-control", ["controls"]],
  ["permission", ["permission", "permissionDelivery"]],
  ["settle-read", ["state", "completion", "errorCode", "delivery"]],
  ["delivery", ["delivery"]],
  ["effect-ack", ["delivery"]],
  ["uncertain", ["state", "errorCode"]],
  ["recover", ["state", "errorCode"]],
  ["pause-import", ["state", "errorCode"]],
]);
function mutableKeys(
  before: AgentBackendRecord,
  op: string,
): readonly string[] {
  if (op === "pause-import" && before.kind === "backend") return ["enabled"];
  const keys = MUTABLE.get(op) ?? fail("BACKEND_TRANSITION_INVALID");
  return before.kind === "connection" &&
    ((op === "observe" && before.sessionLoad) ||
      (op === "dispose" && before.sessionLoad?.state === "dispatching"))
    ? [...keys, "sessionLoad"]
    : keys;
}
export function validateTransition(
  before: AgentBackendRecord | undefined,
  after: AgentBackendRecord,
  op: string,
): void {
  if (!before) {
    if (
      (after.kind === "connection" &&
        (after.receiveOrdinal !== 0 ||
          after.writeOrdinal !== 0 ||
          after.remoteSessionId !== null ||
          after.observation !== null ||
          after.disposal !== null)) ||
      (after.kind === "request" &&
        (after.dispatch !== null || after.terminal !== null)) ||
      (after.kind === "client-effect" &&
        (after.completion !== null || after.delivery !== null))
    )
      fail();
    return;
  }
  assertRevisionLink(before, after, fail);
  assertOnlyChanged(
    bodyOf(before),
    bodyOf(after),
    mutableKeys(before, op),
    () => fail("BACKEND_TRANSITION_INVALID"),
  );
  if (
    op === "bind-effect" &&
    before.kind === "client-effect" &&
    after.kind === "client-effect" &&
    (before.executionFrame ||
      !after.executionFrame ||
      !after.permission?.allowed)
  )
    fail();
  if (
    op === "terminal-control" &&
    before.kind === "client-effect" &&
    after.kind === "client-effect" &&
    ((after.controls?.length ?? 0) !== (before.controls?.length ?? 0) + 1 ||
      knowledgeHash(after.controls?.slice(0, -1) ?? []) !==
        knowledgeHash(before.controls ?? []))
  )
    fail();
  if (
    op === "settle-read" &&
    before.kind === "client-effect" &&
    after.kind === "client-effect" &&
    knowledgeHash(before.delivery) !== knowledgeHash(after.delivery) &&
    !(
      before.permission?.allowed === false &&
      knowledgeHash(after.delivery) === knowledgeHash(before.permissionDelivery)
    )
  )
    fail();
  if (
    op === "permission" &&
    before.kind === "client-effect" &&
    after.kind === "client-effect" &&
    (before.permission || !after.permission || !after.permissionDelivery)
  )
    fail("BACKEND_TRANSITION_INVALID");
  if (
    op === "negotiate" &&
    before.kind === "connection" &&
    after.kind === "connection" &&
    (before.capabilities ||
      !after.capabilities ||
      !before.observation ||
      !("result" in before.observation.message) ||
      knowledgeHash(
        negotiateAcpV1Capabilities(before.observation.message.result, {
          ...(before.proof.clientCapabilities ?? {
            readTextFile: after.capabilities?.readTextFile ?? false,
          }),
          contextOwner: after.capabilities?.contextOwner ?? "engine",
          loadSession: after.capabilities?.loadSession ?? false,
        }),
      ) !== knowledgeHash(after.capabilities))
  )
    fail();
  if (before.kind === "connection" && after.kind === "connection") {
    if (
      op === "load-intent" &&
      (before.sessionLoad ||
        after.sessionLoad?.state !== "dispatching" ||
        after.sessionLoad.replayHashes.length !== 0 ||
        after.sessionLoad.replayBytes !== 0)
    )
      fail();
    if (
      op === "load-ready" &&
      (before.sessionLoad?.state !== "dispatching" ||
        after.sessionLoad?.state !== "loaded" ||
        knowledgeHash(before.sessionLoad.message) !==
          knowledgeHash(after.sessionLoad.message) ||
        knowledgeHash(before.sessionLoad.replayHashes) !==
          knowledgeHash(after.sessionLoad.replayHashes) ||
        before.sessionLoad.replayBytes !== after.sessionLoad.replayBytes ||
        after.receiveOrdinal !== before.receiveOrdinal + 1 ||
        after.writeOrdinal !== after.sessionLoad.write?.writeOrdinal ||
        after.sessionLoad.response?.sha256 !== after.observation?.sha256)
    )
      fail();
    if (op === "observe" && before.sessionLoad?.state === "dispatching") {
      if (
        after.sessionLoad?.state !== "dispatching" ||
        !after.observation ||
        after.sessionLoad.replayHashes.length !==
          before.sessionLoad.replayHashes.length + 1 ||
        knowledgeHash(after.sessionLoad.replayHashes.slice(0, -1)) !==
          knowledgeHash(before.sessionLoad.replayHashes) ||
        after.sessionLoad.replayHashes.at(-1) !==
          after.observation.frameSha256 ||
        after.sessionLoad.replayBytes !==
          before.sessionLoad.replayBytes +
            Buffer.byteLength(JSON.stringify(after.observation.message)) ||
        !("method" in after.observation.message) ||
        "id" in after.observation.message ||
        after.observation.message.method !== "session/update" ||
        after.observation.message.params?.sessionId !==
          (before.sessionLoad.message as { params: JsonObject }).params
            .sessionId ||
        knowledgeHash({
          ...before.sessionLoad,
          replayHashes: after.sessionLoad.replayHashes,
          replayBytes: after.sessionLoad.replayBytes,
        }) !== knowledgeHash(after.sessionLoad)
      )
        fail("BACKEND_RECEIVE_GAP");
    }
    if (
      op === "observe" &&
      before.sessionLoad?.state === "loaded" &&
      knowledgeHash(before.sessionLoad) !== knowledgeHash(after.sessionLoad)
    )
      fail();
    if (
      op === "dispose" &&
      before.sessionLoad?.state === "dispatching" &&
      knowledgeHash({ ...before.sessionLoad, state: "uncertain" }) !==
        knowledgeHash(after.sessionLoad)
    )
      fail();
  }
  if (
    op === "cancel-wire" &&
    before.kind === "request" &&
    after.kind === "request" &&
    (before.cancellation ||
      !after.cancellation ||
      after.cancellation.write.frameSha256 !==
        knowledgeHash(after.cancellation.message))
  )
    fail();
  if (
    (op === "disable" || op === "pause-import") &&
    after.kind === "backend" &&
    after.enabled
  )
    fail();
  if (
    op === "observe" &&
    before.kind === "connection" &&
    after.kind === "connection"
  ) {
    const message = after.observation?.message;
    if (after.state !== before.state) {
      if (!message || !("result" in message)) fail();
      if (after.state === "initialized")
        validateAcpV1Result("initialize", message.result);
      else if (after.state === "session-ready") {
        const result = validateAcpV1Result("session/new", message.result);
        if (result.sessionId !== after.remoteSessionId) fail();
      }
    }
    if (
      before.remoteSessionId !== null &&
      after.remoteSessionId !== before.remoteSessionId
    )
      fail();
  }
  if (
    op === "dispose" &&
    after.kind === "connection" &&
    (after.state === "closed") !==
      (after.disposal?.cleanupConfirmed === true &&
        before?.kind === "connection" &&
        before.sessionLoad?.state !== "dispatching")
  )
    fail();
  if (
    (op === "delivery" || op === "effect-ack") &&
    before.kind === "client-effect" &&
    after.kind === "client-effect" &&
    (before.delivery !== null || after.delivery === null)
  )
    fail();
  if (
    op === "observe" &&
    before.kind === "connection" &&
    after.kind === "connection" &&
    (after.receiveOrdinal !== before.receiveOrdinal + 1 ||
      after.observation === null)
  )
    fail();
  if (
    (op === "dispatch" && after.kind === "request" && !after.dispatch) ||
    (op === "settle" && after.kind === "request" && !after.terminal) ||
    (op === "settle-read" &&
      after.kind === "client-effect" &&
      !after.completion) ||
    (op === "delivery" && after.kind === "client-effect" && !after.delivery)
  )
    fail();
}
