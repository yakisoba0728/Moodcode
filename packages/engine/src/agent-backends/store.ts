import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { relative, isAbsolute, sep } from "node:path";
import {
  EngineError,
  type JsonObject,
  type Workspace,
} from "@moodcode/contracts";
import {
  immutableKnowledgeJson,
  knowledgeHash,
} from "../knowledge/validation.js";
import type {
  AgentBackendSpec,
  AgentBackendSpecInput,
  AgentBackendTargetPin,
  AcpV1Id,
  AcpV1Message,
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
} from "./client-effects.js";
import {
  assertBackendTransition,
  type BackendJournalKind,
  type BackendConnectionState,
  type BackendRequestState,
  type BackendEffectState,
} from "./reducer.js";
import { validateAgentBackendSpec } from "./validation.js";
import {
  validateAcpV1Message,
  validateAcpV1Result,
  validateAcpV1ReadTextFileParams,
} from "./protocol.js";
export type {
  BackendConnectionProof,
  BackendPeerObservationProof,
  BackendWriteProof,
  BackendDisposalProof,
} from "./process.js";
export type { BackendClientReadProof } from "./client-effects.js";
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
  readonly sha256: string;
}
export interface ActualBackendTurnPort {
  readOwner(original: object): BackendTurnProof;
  assertOwnerCurrent(
    original: object,
    proof: BackendTurnProof,
    phase: "dispatch" | "observe",
  ): void;
}
export interface AgentBackendStoragePorts extends ActualBackendTurnPort {
  writeTx<T>(operation: () => T): T;
  getWorkspace(workspaceId: string): Workspace;
  readTarget(original: object): BackendTargetProof;
  assertTargetCurrent(
    original: object,
    proof: BackendTargetProof,
    spec: AgentBackendSpec,
  ): void;
  readConnection(original: object): BackendConnectionProof;
  assertConnectionCurrent(original: object): void;
  readPeerObservation(original: object): BackendPeerObservationProof;
  readWrite(original: object): BackendWriteProof;
  readClientEffect(original: object): BackendClientReadProof;
  readDisposal(original: object): BackendDisposalProof;
  readonly now?: () => number;
}
interface BackendRevisionBase {
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
  readonly input: BackendClientReadInput;
  readonly state: BackendEffectState;
  readonly frame: BackendPeerObservationProof;
  readonly completion: BackendClientReadProof | null;
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
export interface BackendRequestResult<T extends AgentBackendRecord> {
  readonly record: T;
  readonly receipt: BackendTransitionReceipt;
  readonly duplicate: boolean;
}
export interface BackendMutationInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
}
export interface RegisterAgentBackendInput extends BackendMutationInput {
  readonly spec: AgentBackendSpecInput;
}
export interface DisableAgentBackendInput extends BackendMutationInput {
  readonly backendId: string;
}
export interface OpenBackendConnectionInput extends BackendMutationInput {
  readonly backendId: string;
  readonly connectionId: string;
}
export interface PrepareBackendRequestInput extends BackendMutationInput {
  readonly remoteRequestId: string;
  readonly connectionId: string;
  readonly rpcId: AcpV1Id;
  readonly remoteSessionId: string;
  readonly message: AcpV1Message;
}
export interface MutateBackendRequestInput extends BackendMutationInput {
  readonly remoteRequestId: string;
}
export interface ObserveBackendConnectionInput extends BackendMutationInput {
  readonly connectionId: string;
  readonly state: "initialized" | "session-ready" | "observe";
  readonly remoteSessionId: string | null;
}
export interface PrepareBackendClientReadInput extends BackendMutationInput {
  readonly effectId: string;
  readonly remoteRequestId: string;
  readonly input: BackendClientReadInput;
}
export interface MutateBackendClientEffectInput extends BackendMutationInput {
  readonly effectId: string;
}
export interface DeliverBackendClientEffectInput extends MutateBackendClientEffectInput {
  readonly message: AcpV1Message;
}
export interface DisposeBackendConnectionInput extends BackendMutationInput {
  readonly connectionId: string;
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
});
type Kind = BackendJournalKind | "transition";
type Body = AgentBackendRecord | BackendTransitionReceipt;
interface Row {
  id: string;
  workspace_id: string;
  kind: Kind;
  entity_id: string;
  revision: number;
  previous_id: string | null;
  session_id: string | null;
  run_id: string | null;
  turn_id: string | null;
  attempt_id: string | null;
  tool_id: string | null;
  connection_id: string | null;
  owner_epoch: string | null;
  request_scope: string;
  request_id: string;
  request_sha256: string;
  sha256: string;
  bytes: number;
  data: string;
}
function fail(code = "BACKEND_DATABASE_INVALID"): never {
  throw new EngineError(
    code,
    "Backend journal or original runtime owner is stale or invalid",
  );
}
function json<T>(value: T): T {
  return immutableKnowledgeJson(value);
}
function signed<T extends object>(value: T): T & { sha256: string } {
  const { sha256: _old, ...body } = value as T & { sha256?: string };
  return json({ ...body, sha256: knowledgeHash(body) }) as T & {
    sha256: string;
  };
}
function digest<T extends { sha256: string }>(value: T): T {
  const copy = json(value),
    { sha256, ...body } = copy;
  if (!/^[a-f0-9]{64}$/.test(sha256) || knowledgeHash(body) !== sha256) fail();
  return copy;
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail("INVALID_BACKEND_INPUT");
  return value;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max)
    fail("BACKEND_LIMIT");
  return Number(value);
}
function fields(input: unknown, keys: readonly string[]): void {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(input, k))
  )
    fail();
}
function sync(value: unknown): void {
  if (value !== undefined) {
    void Promise.resolve(value).catch(() => {});
    fail("BACKEND_ORIGINAL_REQUIRED");
  }
}
function state(value: AgentBackendRecord): string {
  return value.kind === "backend"
    ? value.enabled
      ? "enabled"
      : "disabled"
    : value.state;
}
function ownerOf(value: AgentBackendRecord): BackendTurnProof | null {
  return value.kind === "request" || value.kind === "client-effect"
    ? value.owner
    : null;
}
function entity(value: AgentBackendRecord): string {
  return value.entityId;
}
/** Native SQLite owns history; all live execution authorization remains in ORIGINAL Root producers. */
export class AgentBackendStorage {
  constructor(
    readonly db: DatabaseSync,
    private readonly ports: AgentBackendStoragePorts,
  ) {}
  private time(): string {
    return new Date(
      integer(this.ports.now?.() ?? Date.now(), 8640000000000000),
    ).toISOString();
  }
  private row(ws: string, rid: string): Row | undefined {
    const h = this.db
      .prepare(
        "SELECT id,workspace_id,kind,entity_id,revision,previous_id,session_id,run_id,turn_id,attempt_id,tool_id,connection_id,owner_epoch,request_scope,request_id,request_sha256,sha256,length(CAST(data AS BLOB)) bytes FROM backend_revisions WHERE workspace_id=? AND id=?",
      )
      .get(id(ws), id(rid)) as unknown as Row | undefined;
    if (!h) return;
    if (integer(h.bytes) > AGENT_BACKEND_STORAGE_LIMITS.rowBytes)
      fail("BACKEND_LIMIT");
    const b = this.db
      .prepare(
        "SELECT data FROM backend_revisions WHERE workspace_id=? AND id=? AND length(CAST(data AS BLOB))=?",
      )
      .get(ws, rid, h.bytes);
    if (!b) fail();
    return { ...h, data: String(b.data) };
  }
  private read<T extends Body>(ws: string, rid: string, kind?: Kind): T {
    const row = this.row(ws, rid);
    if (!row || (kind && row.kind !== kind)) fail();
    const b = digest(JSON.parse(row.data) as Body);
    if (
      b.id !== row.id ||
      b.workspaceId !== row.workspace_id ||
      (b.kind !== row.kind && row.kind !== "transition") ||
      b.entityId !== row.entity_id ||
      b.sha256 !== row.sha256
    )
      fail();
    if (row.kind !== "transition") {
      const r = b as AgentBackendRecord;
      if (r.revision !== row.revision || r.previousId !== row.previous_id)
        fail();
      validateBody(r);
      validateOwnerSql(this.db, r);
    } else {
      const r = b as BackendTransitionReceipt;
      if (
        r.requestId !== row.request_id ||
        r.requestSha256 !== row.request_sha256 ||
        knowledgeHash(r.requestInput) !== r.requestSha256
      )
        fail();
    }
    return b as T;
  }
  private head<T extends AgentBackendRecord>(
    ws: string,
    kind: BackendJournalKind,
    eid: string,
  ): T | undefined {
    const h = this.db
      .prepare(
        "SELECT revision_id,revision,sha256 FROM backend_heads WHERE workspace_id=? AND kind=? AND entity_id=?",
      )
      .get(id(ws), kind, id(eid));
    if (!h) return;
    const r = this.read<T>(ws, String(h.revision_id), kind);
    if (
      r.entityId !== eid ||
      r.revision !== h.revision ||
      r.sha256 !== h.sha256
    )
      fail();
    const max = this.db
      .prepare(
        "SELECT max(revision) revision FROM backend_revisions WHERE workspace_id=? AND kind=? AND entity_id=?",
      )
      .get(ws, kind, eid);
    if (max?.revision !== r.revision) fail();
    return r;
  }
  getBackend(
    ws: string,
    backendId: string,
    revisionId?: string,
  ): AgentBackendRevision | undefined {
    if (revisionId) {
      const r = this.read<AgentBackendRevision>(ws, id(revisionId), "backend");
      if (r.backendId !== backendId) fail();
      return r;
    }
    return this.head(ws, "backend", backendId);
  }
  getConnection(
    ws: string,
    connectionId: string,
  ): BackendConnectionRevision | undefined {
    return this.head(ws, "connection", connectionId);
  }
  getRequest(
    ws: string,
    remoteRequestId: string,
  ): BackendRemoteRequest | undefined {
    return this.head(ws, "request", remoteRequestId);
  }
  getClientEffect(
    ws: string,
    effectId: string,
  ): BackendClientEffectRevision | undefined {
    return this.head(ws, "client-effect", effectId);
  }
  private list<T extends AgentBackendRecord>(
    ws: string,
    kind: BackendJournalKind,
    max: number,
  ): T[] {
    const hs = this.db
      .prepare(
        "SELECT entity_id FROM backend_heads WHERE workspace_id=? AND kind=? ORDER BY entity_id LIMIT ?",
      )
      .all(id(ws), kind, max + 1);
    if (hs.length > max) fail("BACKEND_LIMIT");
    return hs.map((h) => this.head<T>(ws, kind, String(h.entity_id))!);
  }
  inspectBackends(ws: string): AgentBackendRevision[] {
    return this.list(ws, "backend", AGENT_BACKEND_STORAGE_LIMITS.backends);
  }
  inspectConnections(ws: string): BackendConnectionRevision[] {
    return this.list(
      ws,
      "connection",
      AGENT_BACKEND_STORAGE_LIMITS.connections,
    );
  }
  inspectRequests(ws: string): BackendRemoteRequest[] {
    return this.list(ws, "request", AGENT_BACKEND_STORAGE_LIMITS.requests);
  }
  inspectClientEffects(ws: string): BackendClientEffectRevision[] {
    return this.list(ws, "client-effect", AGENT_BACKEND_STORAGE_LIMITS.effects);
  }
  private duplicate<T extends AgentBackendRecord>(
    ws: string,
    kind: BackendJournalKind,
    eid: string,
    op: string,
    input: object,
  ): BackendRequestResult<T> | undefined {
    const x = input as BackendMutationInput,
      scope = `${kind}:${eid}:${op}`;
    const h = this.db
      .prepare(
        "SELECT id,request_sha256 FROM backend_revisions WHERE workspace_id=? AND kind='transition' AND request_scope=? AND request_id=?",
      )
      .get(ws, `receipt:${scope}`, id(x.requestId));
    if (!h) return;
    if (h.request_sha256 !== knowledgeHash(input))
      fail("BACKEND_REQUEST_CONFLICT");
    const receipt = this.read<BackendTransitionReceipt>(
      ws,
      String(h.id),
      "transition",
    );
    return json({
      record: this.read<T>(ws, receipt.afterRevisionId, kind),
      receipt,
      duplicate: true,
    });
  }
  private append<T extends AgentBackendRecord>(
    kind: BackendJournalKind,
    eid: string,
    op: string,
    input: BackendMutationInput,
    before: T | undefined,
    body: Omit<T, keyof BackendRevisionBase>,
  ): BackendRequestResult<T> {
    if ((before?.revision ?? 0) !== integer(input.expectedRevision))
      fail("BACKEND_REVISION_CONFLICT");
    const max =
      kind === "backend"
        ? AGENT_BACKEND_STORAGE_LIMITS.backends
        : kind === "connection"
          ? AGENT_BACKEND_STORAGE_LIMITS.connections
          : kind === "request"
            ? AGENT_BACKEND_STORAGE_LIMITS.requests
            : AGENT_BACKEND_STORAGE_LIMITS.effects;
    if (
      !before &&
      Number(
        this.db
          .prepare("SELECT count(*) n FROM backend_heads WHERE kind=?")
          .get(kind)?.n,
      ) >= max
    )
      fail("BACKEND_LIMIT");
    const total = this.db
      .prepare(
        "SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes FROM backend_revisions",
      )
      .get()!;
    if (Number(total.n) + 2 > AGENT_BACKEND_STORAGE_LIMITS.rows)
      fail("BACKEND_LIMIT");
    const rid = randomUUID(),
      receiptId = randomUUID(),
      at = this.time();
    const record = signed({
      ...body,
      id: rid,
      kind,
      entityId: eid,
      workspaceId: input.workspaceId,
      revision: (before?.revision ?? 0) + 1,
      previousId: before?.id ?? null,
      lastReceiptId: receiptId,
      createdAt: at,
    }) as unknown as T;
    validateBody(record);
    assertBackendTransition(
      kind,
      before ? state(before) : null,
      state(record),
      op,
    );
    validateTransition(before, record, op);
    const receipt = signed({
      id: receiptId,
      workspaceId: input.workspaceId,
      kind,
      entityId: eid,
      operation: op,
      beforeRevisionId: before?.id ?? null,
      afterRevisionId: rid,
      afterSha256: record.sha256,
      requestId: input.requestId,
      requestSha256: knowledgeHash(input),
      requestInput: input as unknown as JsonObject,
      createdAt: at,
    });
    if (
      Number(total.bytes) +
        Buffer.byteLength(JSON.stringify(record)) +
        Buffer.byteLength(JSON.stringify(receipt)) >
      AGENT_BACKEND_STORAGE_LIMITS.bytes
    )
      fail("BACKEND_LIMIT");
    const owner = ownerOf(record),
      scope = `${kind}:${eid}:${op}`,
      connectionId =
        kind === "connection"
          ? eid
          : kind === "request" || kind === "client-effect"
            ? (record as BackendRemoteRequest).connectionId
            : null;
    const toolId =
      kind === "client-effect"
        ? ((record as BackendClientEffectRevision).completion?.toolCallId ??
          null)
        : null;
    const insert = this.db.prepare(
      "INSERT INTO backend_revisions(id,workspace_id,kind,entity_id,revision,previous_id,session_id,run_id,turn_id,attempt_id,tool_id,connection_id,owner_epoch,request_scope,request_id,request_sha256,sha256,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    insert.run(
      rid,
      input.workspaceId,
      kind,
      eid,
      record.revision,
      record.previousId,
      owner?.sessionId ??
        (kind === "backend"
          ? (record as AgentBackendRevision).spec.target.sessionId
          : null),
      owner?.runId ?? null,
      owner?.turnId ?? null,
      owner?.attemptId ?? null,
      toolId,
      connectionId,
      owner?.ownerEpoch ?? null,
      scope,
      input.requestId,
      receipt.requestSha256,
      record.sha256,
      JSON.stringify(record),
    );
    insert.run(
      receiptId,
      input.workspaceId,
      "transition",
      eid,
      record.revision,
      null,
      owner?.sessionId ?? null,
      owner?.runId ?? null,
      owner?.turnId ?? null,
      owner?.attemptId ?? null,
      toolId,
      connectionId,
      owner?.ownerEpoch ?? null,
      `receipt:${scope}`,
      input.requestId,
      receipt.requestSha256,
      receipt.sha256,
      JSON.stringify(receipt),
    );
    if (before) {
      const result = this.db
        .prepare(
          "UPDATE backend_heads SET revision_id=?,revision=?,sha256=? WHERE workspace_id=? AND kind=? AND entity_id=? AND revision_id=? AND revision=? AND sha256=?",
        )
        .run(
          rid,
          record.revision,
          record.sha256,
          input.workspaceId,
          kind,
          eid,
          before.id,
          before.revision,
          before.sha256,
        );
      if (result.changes !== 1) fail("BACKEND_REVISION_CONFLICT");
    } else
      this.db
        .prepare(
          "INSERT INTO backend_heads(workspace_id,kind,entity_id,revision_id,revision,sha256) VALUES(?,?,?,?,?,?)",
        )
        .run(input.workspaceId, kind, eid, rid, record.revision, record.sha256);
    return json({ record, receipt, duplicate: false });
  }
  private input<T extends BackendMutationInput>(
    input: T,
    extra: readonly string[],
  ): T {
    const v = json(input);
    fields(v, ["workspaceId", "requestId", "expectedRevision", ...extra]);
    id(v.workspaceId);
    id(v.requestId);
    integer(v.expectedRevision);
    return v;
  }
  private required<T>(value: T | undefined): T {
    if (!value) fail("BACKEND_NOT_FOUND");
    return value;
  }
  registerBackend(
    originalTarget: object,
    input: RegisterAgentBackendInput,
  ): BackendRequestResult<AgentBackendRevision> {
    const x = this.input(input, ["spec"]),
      spec = validateAgentBackendSpec(x.spec),
      ws = x.workspaceId,
      eid = spec.id;
    return this.ports.writeTx(() => {
      const d = this.duplicate<AgentBackendRevision>(
        ws,
        "backend",
        eid,
        "register",
        x,
      );
      if (d) return d;
      this.ports.getWorkspace(ws);
      const proof = digest(this.ports.readTarget(originalTarget));
      if (
        proof.workspaceId !== ws ||
        proof.backendId !== eid ||
        knowledgeHash(proof.target) !== knowledgeHash(spec.target)
      )
        fail("BACKEND_TARGET_STALE");
      sync(this.ports.assertTargetCurrent(originalTarget, proof, spec));
      return this.append(
        "backend",
        eid,
        "register",
        x,
        this.getBackend(ws, eid),
        { backendId: eid, enabled: true, spec, target: proof },
      );
    });
  }
  disableBackend(
    input: DisableAgentBackendInput,
  ): BackendRequestResult<AgentBackendRevision> {
    const x = this.input(input, ["backendId"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<AgentBackendRevision>(
        x.workspaceId,
        "backend",
        x.backendId,
        "disable",
        x,
      );
      if (d) return d;
      const before = this.required(this.getBackend(x.workspaceId, x.backendId));
      return this.append("backend", x.backendId, "disable", x, before, {
        backendId: before.backendId,
        enabled: false,
        spec: before.spec,
        target: before.target,
      });
    });
  }
  openConnection(
    originalProcess: object,
    input: OpenBackendConnectionInput,
  ): BackendRequestResult<BackendConnectionRevision> {
    const x = this.input(input, ["backendId", "connectionId"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendConnectionRevision>(
        x.workspaceId,
        "connection",
        x.connectionId,
        "open",
        x,
      );
      if (d) return d;
      const b = this.required(this.getBackend(x.workspaceId, x.backendId));
      if (!b.enabled) fail("BACKEND_DISABLED");
      const p = digest(this.ports.readConnection(originalProcess));
      sync(this.ports.assertConnectionCurrent(originalProcess));
      if (
        p.workspaceId !== x.workspaceId ||
        p.backendId !== b.backendId ||
        p.backendRevisionId !== b.id ||
        p.backendSha256 !== b.spec.sha256 ||
        p.connectionId !== x.connectionId ||
        p.launchSha256 !== b.target.launchSha256
      )
        fail("BACKEND_CONNECTION_STALE");
      return this.append(
        "connection",
        x.connectionId,
        "open",
        x,
        this.getConnection(x.workspaceId, x.connectionId),
        {
          backendId: b.backendId,
          backendRevisionId: b.id,
          backendSha256: b.spec.sha256,
          connectionId: x.connectionId,
          proof: p,
          state: "launched",
          receiveOrdinal: 0,
          writeOrdinal: 0,
          remoteSessionId: null,
          observation: null,
          disposal: null,
          errorCode: null,
        },
      );
    });
  }
  recordPeerObservation(
    originalFrame: object,
    input: ObserveBackendConnectionInput,
  ): BackendRequestResult<BackendConnectionRevision> {
    const x = this.input(input, ["connectionId", "state", "remoteSessionId"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendConnectionRevision>(
        x.workspaceId,
        "connection",
        x.connectionId,
        "observe",
        x,
      );
      if (d) return d;
      const before = this.required(
          this.getConnection(x.workspaceId, x.connectionId),
        ),
        p = this.frame(originalFrame, before);
      if (p.receiveOrdinal !== before.receiveOrdinal + 1)
        fail("BACKEND_RECEIVE_GAP");
      const next = x.state === "observe" ? before.state : x.state;
      if (
        x.state === "initialized" &&
        (!("result" in p.message) ||
          !p.message.result ||
          typeof p.message.result !== "object" ||
          Array.isArray(p.message.result) ||
          (p.message.result as JsonObject).protocolVersion !== 1)
      )
        fail("ACP_VERSION_UNSUPPORTED");
      if (
        x.state === "session-ready" &&
        (!("result" in p.message) ||
          !p.message.result ||
          typeof p.message.result !== "object" ||
          Array.isArray(p.message.result) ||
          (p.message.result as JsonObject).sessionId !== x.remoteSessionId)
      )
        fail("BACKEND_REMOTE_SESSION_INVALID");
      if (
        (next !== "session-ready" && x.remoteSessionId !== null) ||
        (before.remoteSessionId !== null &&
          x.remoteSessionId !== before.remoteSessionId)
      )
        fail("BACKEND_REMOTE_SESSION_INVALID");
      return this.append("connection", x.connectionId, "observe", x, before, {
        ...bodyOf(before),
        state: next,
        receiveOrdinal: p.receiveOrdinal,
        remoteSessionId: x.remoteSessionId,
        observation: p,
      });
    });
  }
  prepareRequest(
    originalTurn: object,
    originalConnection: object,
    input: PrepareBackendRequestInput,
  ): BackendRequestResult<BackendRemoteRequest> {
    const x = this.input(input, [
      "remoteRequestId",
      "connectionId",
      "rpcId",
      "remoteSessionId",
      "message",
    ]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendRemoteRequest>(
        x.workspaceId,
        "request",
        x.remoteRequestId,
        "prepare",
        x,
      );
      if (d) return d;
      const c = this.required(
        this.getConnection(x.workspaceId, x.connectionId),
      );
      const b = this.required(this.getBackend(x.workspaceId, c.backendId));
      if (
        !b.enabled ||
        c.state !== "session-ready" ||
        c.remoteSessionId !== x.remoteSessionId
      )
        fail("BACKEND_CONNECTION_STALE");
      const cp = digest(this.ports.readConnection(originalConnection));
      sync(this.ports.assertConnectionCurrent(originalConnection));
      if (cp.sha256 !== c.proof.sha256) fail("BACKEND_CONNECTION_STALE");
      const owner = this.owner(originalTurn, "dispatch");
      if (
        owner.workspaceId !== x.workspaceId ||
        owner.sessionId !== b.spec.target.sessionId ||
        owner.configSha256 !== b.spec.target.runConfigSha256 ||
        owner.catalogueSha256 !== b.spec.target.catalogueSha256 ||
        owner.providerId !== `acp:${b.backendId}` ||
        owner.sha256 !== c.proof.ownerSha256
      )
        fail("BACKEND_OWNER_INVALID");
      const m = x.message;
      if (
        !("method" in m) ||
        m.method !== "session/prompt" ||
        !("id" in m) ||
        m.id !== x.rpcId ||
        !m.params ||
        m.params.sessionId !== x.remoteSessionId
      )
        fail("BACKEND_REQUEST_INVALID");
      if (
        this.db
          .prepare(
            "SELECT id FROM backend_revisions WHERE workspace_id=? AND kind='request' AND connection_id=? AND attempt_id=? LIMIT 1",
          )
          .get(x.workspaceId, c.connectionId, owner.attemptId)
      )
        fail("BACKEND_ATTEMPT_ALREADY_BOUND");
      return this.append(
        "request",
        x.remoteRequestId,
        "prepare",
        x,
        this.getRequest(x.workspaceId, x.remoteRequestId),
        {
          remoteRequestId: x.remoteRequestId,
          connectionId: c.connectionId,
          epoch: c.proof.epoch,
          backendRevisionId: c.backendRevisionId,
          owner,
          rpcId: x.rpcId,
          remoteSessionId: x.remoteSessionId,
          state: "prepared",
          wireMessage: m,
          wireSha256: knowledgeHash(m),
          dispatch: null,
          terminal: null,
          errorCode: null,
        },
      );
    });
  }
  dispatchRequest(
    originalTurn: object,
    input: MutateBackendRequestInput,
  ): BackendRequestResult<BackendRemoteRequest> {
    const x = this.input(input, ["remoteRequestId"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendRemoteRequest>(
        x.workspaceId,
        "request",
        x.remoteRequestId,
        "dispatch-intent",
        x,
      );
      if (d) return d;
      const before = this.required(
          this.getRequest(x.workspaceId, x.remoteRequestId),
        ),
        p = this.owner(originalTurn, "dispatch");
      if (p.sha256 !== before.owner.sha256) fail("BACKEND_OWNER_INVALID");
      this.liveConnection(before);
      return this.append(
        "request",
        x.remoteRequestId,
        "dispatch-intent",
        x,
        before,
        { ...bodyOf(before), state: "dispatching" },
      );
    });
  }
  markRequestDispatched(
    originalWrite: object,
    input: MutateBackendRequestInput,
  ): BackendRequestResult<BackendRemoteRequest> {
    const x = this.input(input, ["remoteRequestId"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendRemoteRequest>(
        x.workspaceId,
        "request",
        x.remoteRequestId,
        "dispatch",
        x,
      );
      if (d) return d;
      const before = this.required(
          this.getRequest(x.workspaceId, x.remoteRequestId),
        ),
        p = digest(this.ports.readWrite(originalWrite));
      this.writeMatches(
        p,
        before.connectionId,
        before.epoch,
        x.workspaceId,
        before.wireSha256,
      );
      return this.append("request", x.remoteRequestId, "dispatch", x, before, {
        ...bodyOf(before),
        state: "dispatched",
        dispatch: p,
      });
    });
  }
  prepareClientRead(
    originalTurn: object,
    originalFrame: object,
    input: PrepareBackendClientReadInput,
  ): BackendRequestResult<BackendClientEffectRevision> {
    const x = this.input(input, ["effectId", "remoteRequestId", "input"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendClientEffectRevision>(
        x.workspaceId,
        "client-effect",
        x.effectId,
        "prepare-read",
        x,
      );
      if (d) return d;
      const r = this.required(
        this.getRequest(x.workspaceId, x.remoteRequestId),
      );
      if (r.state !== "dispatched") fail("BACKEND_REQUEST_STALE");
      const owner = this.owner(originalTurn, "dispatch");
      if (owner.sha256 !== r.owner.sha256) fail("BACKEND_OWNER_INVALID");
      const c = this.liveConnection(r),
        frame = this.frame(originalFrame, c);
      if (c.observation?.sha256 !== frame.sha256)
        fail("BACKEND_FRAME_NOT_RECORDED");
      if (
        !("method" in frame.message) ||
        frame.message.method !== "fs/read_text_file" ||
        !("id" in frame.message) ||
        !frame.message.params ||
        frame.message.params.sessionId !== r.remoteSessionId
      )
        fail("ACP_EFFECT_UNSUPPORTED");
      const params = frame.message.params;
      if (
        params.path !== x.input.path ||
        (params.line ?? undefined) !== x.input.line ||
        (params.limit ?? undefined) !== x.input.limit
      )
        fail("BACKEND_EFFECT_INPUT_INVALID");
      id(x.input.callId);
      for (const old of this.inspectClientEffects(x.workspaceId))
        if (
          old.connectionId === r.connectionId &&
          old.epoch === r.epoch &&
          old.rpcId === frame.message.id
        )
          fail("BACKEND_EFFECT_ALREADY_BOUND");
      return this.append(
        "client-effect",
        x.effectId,
        "prepare-read",
        x,
        this.getClientEffect(x.workspaceId, x.effectId),
        {
          effectId: x.effectId,
          remoteRequestId: r.remoteRequestId,
          connectionId: r.connectionId,
          epoch: r.epoch,
          owner,
          rpcId: frame.message.id,
          input: x.input,
          state: "prepared",
          frame,
          completion: null,
          delivery: null,
          errorCode: null,
        },
      );
    });
  }
  settleClientRead(
    originalCompletion: object,
    input: MutateBackendClientEffectInput,
  ): BackendRequestResult<BackendClientEffectRevision> {
    const x = this.input(input, ["effectId"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendClientEffectRevision>(
        x.workspaceId,
        "client-effect",
        x.effectId,
        "settle-read",
        x,
      );
      if (d) return d;
      const before = this.required(
          this.getClientEffect(x.workspaceId, x.effectId),
        ),
        p = digest(this.ports.readClientEffect(originalCompletion));
      validateClientEffectSql(this.db, before, p);
      return this.append(
        "client-effect",
        x.effectId,
        "settle-read",
        x,
        before,
        {
          ...bodyOf(before),
          state: p.state,
          completion: p,
          errorCode: p.errorCode,
        },
      );
    });
  }
  recordClientDelivery(
    originalWrite: object,
    input: DeliverBackendClientEffectInput,
  ): BackendRequestResult<BackendClientEffectRevision> {
    const x = this.input(input, ["effectId", "message"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendClientEffectRevision>(
        x.workspaceId,
        "client-effect",
        x.effectId,
        "delivery",
        x,
      );
      if (d) return d;
      const before = this.required(
        this.getClientEffect(x.workspaceId, x.effectId),
      );
      if (before.state === "prepared" || before.delivery)
        fail("BACKEND_EFFECT_STALE");
      const p = digest(this.ports.readWrite(originalWrite));
      this.writeMatches(
        p,
        before.connectionId,
        before.epoch,
        x.workspaceId,
        knowledgeHash(x.message),
      );
      if (!("id" in x.message) || x.message.id !== before.rpcId)
        fail("BACKEND_DELIVERY_INVALID");
      if (
        before.completion?.content !== null &&
        before.completion?.errorCode === null
      ) {
        if (
          !("result" in x.message) ||
          !x.message.result ||
          typeof x.message.result !== "object" ||
          Array.isArray(x.message.result) ||
          (x.message.result as JsonObject).content !== before.completion.content
        )
          fail("BACKEND_DELIVERY_INVALID");
      } else if (!("error" in x.message)) fail("BACKEND_DELIVERY_INVALID");
      return this.append("client-effect", x.effectId, "delivery", x, before, {
        ...bodyOf(before),
        delivery: p,
      });
    });
  }
  settleRequest(
    originalFrame: object,
    input: MutateBackendRequestInput,
  ): BackendRequestResult<BackendRemoteRequest> {
    const x = this.input(input, ["remoteRequestId"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendRemoteRequest>(
        x.workspaceId,
        "request",
        x.remoteRequestId,
        "settle",
        x,
      );
      if (d) return d;
      const before = this.required(
          this.getRequest(x.workspaceId, x.remoteRequestId),
        ),
        c = this.required(
          this.getConnection(x.workspaceId, before.connectionId),
        ),
        p = this.frame(originalFrame, c);
      if (c.observation?.sha256 !== p.sha256 || p.wireId !== before.rpcId)
        fail("BACKEND_REQUEST_STALE");
      let next: BackendRequestState = "failed";
      if ("result" in p.message) {
        const result = p.message.result;
        if (
          !result ||
          typeof result !== "object" ||
          Array.isArray(result) ||
          ![
            "end_turn",
            "max_tokens",
            "max_turn_requests",
            "refusal",
            "cancelled",
          ].includes(String((result as JsonObject).stopReason))
        )
          fail("BACKEND_TERMINAL_INVALID");
        next =
          (result as JsonObject).stopReason === "cancelled"
            ? "cancelled"
            : "completed";
      } else if (!("error" in p.message)) fail("BACKEND_TERMINAL_INVALID");
      if (c.disposal?.cleanupConfirmed !== true) fail("CLEANUP_UNCERTAIN");
      if (
        this.inspectClientEffects(x.workspaceId).some(
          (e) =>
            e.remoteRequestId === before.remoteRequestId &&
            (e.state === "prepared" || e.delivery === null),
        )
      )
        fail("BACKEND_EFFECT_UNSETTLED");
      return this.append("request", x.remoteRequestId, "settle", x, before, {
        ...bodyOf(before),
        state: next,
        terminal: p,
        errorCode: next === "failed" ? "ACP_REMOTE_ERROR" : null,
      });
    });
  }
  disposeConnection(
    originalDisposal: object,
    input: DisposeBackendConnectionInput,
  ): BackendRequestResult<BackendConnectionRevision> {
    const x = this.input(input, ["connectionId"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendConnectionRevision>(
        x.workspaceId,
        "connection",
        x.connectionId,
        "dispose",
        x,
      );
      if (d) return d;
      const before = this.required(
          this.getConnection(x.workspaceId, x.connectionId),
        ),
        p = digest(this.ports.readDisposal(originalDisposal));
      if (
        p.workspaceId !== x.workspaceId ||
        p.connectionId !== before.connectionId ||
        p.epoch !== before.proof.epoch ||
        p.processId !== before.proof.processId
      )
        fail("BACKEND_DISPOSAL_INVALID");
      return this.append("connection", x.connectionId, "dispose", x, before, {
        ...bodyOf(before),
        state: p.cleanupConfirmed ? "closed" : "uncertain",
        disposal: p,
        errorCode: p.cleanupConfirmed ? null : "CLEANUP_UNCERTAIN",
      });
    });
  }
  markRequestUncertain(
    input: MutateBackendRequestInput & { readonly errorCode: string },
  ): BackendRequestResult<BackendRemoteRequest> {
    const x = this.input(input, ["remoteRequestId", "errorCode"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendRemoteRequest>(
        x.workspaceId,
        "request",
        x.remoteRequestId,
        "uncertain",
        x,
      );
      if (d) return d;
      const before = this.required(
        this.getRequest(x.workspaceId, x.remoteRequestId),
      );
      return this.append("request", x.remoteRequestId, "uncertain", x, before, {
        ...bodyOf(before),
        state: "uncertain",
        errorCode: id(x.errorCode),
      });
    });
  }
  private owner(
    original: object,
    phase: "dispatch" | "observe",
  ): BackendTurnProof {
    const p = digest(this.ports.readOwner(original));
    sync(this.ports.assertOwnerCurrent(original, p, phase));
    validateTurnSql(this.db, p);
    return p;
  }
  private frame(
    original: object,
    c: BackendConnectionRevision,
  ): BackendPeerObservationProof {
    const p = digest(this.ports.readPeerObservation(original));
    if (
      p.workspaceId !== c.workspaceId ||
      p.backendId !== c.backendId ||
      p.connectionId !== c.connectionId ||
      p.epoch !== c.proof.epoch ||
      p.frameSha256 !== knowledgeHash(p.message)
    )
      fail("BACKEND_FRAME_INVALID");
    integer(p.receiveOrdinal);
    if (p.receiveOrdinal < 1) fail();
    return p;
  }
  private liveConnection(r: BackendRemoteRequest): BackendConnectionRevision {
    const c = this.required(this.getConnection(r.workspaceId, r.connectionId));
    const b = this.required(this.getBackend(r.workspaceId, c.backendId));
    if (
      c.state !== "session-ready" ||
      c.proof.epoch !== r.epoch ||
      !b.enabled ||
      b.id !== r.backendRevisionId
    )
      fail("BACKEND_CONNECTION_STALE");
    return c;
  }
  private writeMatches(
    p: BackendWriteProof,
    connectionId: string,
    epoch: string,
    ws: string,
    frameSha?: string,
  ): void {
    if (
      p.workspaceId !== ws ||
      p.connectionId !== connectionId ||
      p.epoch !== epoch ||
      (frameSha && p.frameSha256 !== frameSha)
    )
      fail("BACKEND_WRITE_INVALID");
    integer(p.writeOrdinal);
    integer(p.writtenBytes);
    if (p.writeOrdinal < 1 || p.writtenBytes < 1) fail();
  }
  hasUncertain(workspaceId: string): boolean {
    return hasAgentBackendBlocker(this.db, workspaceId);
  }
  recoverInterrupted(): number {
    return this.ports.writeTx(() => recoverAgentBackends(this.db, this.time()));
  }
}
function bodyOf<T extends AgentBackendRecord>(
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
function rawSha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function readPrimary(
  db: DatabaseSync,
  table:
    | "runs"
    | "workspaces"
    | "sessions"
    | "session_turns"
    | "provider_attempts"
    | "tools"
    | "message_parts"
    | "approvals",
  key: string,
  maxBytes = 262144,
): Record<string, unknown> {
  const header = db
    .prepare(`SELECT length(CAST(data AS BLOB)) bytes FROM ${table} WHERE id=?`)
    .get(id(key));
  if (!header || Number(header.bytes) > maxBytes) fail();
  const body = db
    .prepare(
      `SELECT data FROM ${table} WHERE id=? AND length(CAST(data AS BLOB))=?`,
    )
    .get(key, Number(header.bytes));
  if (!body) fail();
  const result = JSON.parse(String(body.data));
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    result.id !== key
  )
    fail();
  return result;
}
function validateTurnSql(db: DatabaseSync, p: BackendTurnProof): void {
  digest(p);
  for (const key of [
    "workspaceId",
    "sessionId",
    "runId",
    "turnId",
    "attemptId",
    "providerId",
    "modelId",
    "ownerEpoch",
  ] as const)
    id(p[key]);
  for (const key of [
    "requestSha256",
    "configSha256",
    "catalogueSha256",
    "rootBindingSha256",
  ] as const)
    if (!/^[a-f0-9]{64}$/.test(p[key])) fail();
  const session = readPrimary(db, "sessions", p.sessionId),
    run = readPrimary(db, "runs", p.runId),
    turn = readPrimary(db, "session_turns", p.turnId),
    attempt = readPrimary(db, "provider_attempts", p.attemptId);
  if (
    session.workspaceId !== p.workspaceId ||
    run.workspaceId !== p.workspaceId ||
    run.sessionId !== p.sessionId ||
    turn.sessionId !== p.sessionId ||
    turn.runId !== p.runId ||
    attempt.sessionId !== p.sessionId ||
    attempt.runId !== p.runId ||
    attempt.turnId !== p.turnId ||
    knowledgeHash(run.config) !== p.configSha256
  )
    fail("BACKEND_OWNER_INVALID");
  const cleanup = db
    .prepare(
      "SELECT workspace_id,session_id,run_id,turn_id,provider_id,model_id,context_revision_id,request_sha256 FROM attempt_cleanup WHERE attempt_id=?",
    )
    .get(p.attemptId);
  if (
    !cleanup ||
    cleanup.workspace_id !== p.workspaceId ||
    cleanup.session_id !== p.sessionId ||
    cleanup.run_id !== p.runId ||
    cleanup.turn_id !== p.turnId ||
    cleanup.provider_id !== p.providerId ||
    cleanup.model_id !== p.modelId ||
    cleanup.context_revision_id !== p.contextRevisionId ||
    cleanup.request_sha256 !== p.requestSha256
  )
    fail("BACKEND_OWNER_INVALID");
}
function validateClientEffectSql(
  db: DatabaseSync,
  e: BackendClientEffectRevision,
  p: BackendClientReadProof,
): void {
  digest(p);
  for (const key of [
    "workspaceId",
    "sessionId",
    "runId",
    "turnId",
    "attemptId",
  ] as const)
    if (p[key] !== e.owner[key]) fail("BACKEND_EFFECT_OWNER_INVALID");
  const run = readPrimary(db, "runs", e.owner.runId);
  const runConfig = run.config as { limits: { maxOutputBytes: number } };
  const outputBudget = integer(runConfig.limits.maxOutputBytes);
  if (
    p.providerToolCallId !== e.input.callId ||
    !["completed", "failed", "denied", "interrupted"].includes(p.state) ||
    typeof p.cleanupConfirmed !== "boolean" ||
    !Number.isSafeInteger(p.outputBytes) ||
    p.outputBytes < 0 ||
    p.outputBytes > outputBudget ||
    (p.content !== null &&
      Buffer.byteLength(p.content) > AGENT_BACKEND_STORAGE_LIMITS.outputBytes)
  )
    fail("BACKEND_EFFECT_INVALID");
  const tool = readPrimary(db, "tools", p.toolCallId, outputBudget * 6 + 65536);
  if (
    tool.name !== "read_file" ||
    tool.sessionId !== p.sessionId ||
    tool.runId !== p.runId ||
    tool.state !== p.state ||
    knowledgeHash(tool.input) !== p.inputSha256 ||
    rawSha(typeof tool.output === "string" ? tool.output : "") !==
      p.outputSha256 ||
    Buffer.byteLength(typeof tool.output === "string" ? tool.output : "") !==
      p.outputBytes
  )
    fail("BACKEND_EFFECT_INVALID");
  const workspace = readPrimary(db, "workspaces", p.workspaceId);
  if (typeof workspace.root !== "string" || !isAbsolute(e.input.path))
    fail("BACKEND_EFFECT_INPUT_INVALID");
  const localPath = relative(workspace.root, e.input.path).split(sep).join("/");
  if (
    !localPath ||
    localPath === ".." ||
    localPath.startsWith("../") ||
    isAbsolute(localPath)
  )
    fail("BACKEND_EFFECT_INPUT_INVALID");
  const startLine = e.input.line ?? 1,
    endLine =
      e.input.limit === undefined ? undefined : startLine + e.input.limit - 1;
  const expectedInput = {
    path: localPath,
    startLine,
    ...(endLine === undefined ? {} : { endLine }),
  };
  if (knowledgeHash(tool.input) !== knowledgeHash(expectedInput))
    fail("BACKEND_EFFECT_INPUT_INVALID");
  const parts = db
    .prepare(
      "SELECT id FROM message_parts WHERE turn_id=? AND run_id=? AND session_id=? LIMIT 257",
    )
    .all(p.turnId, p.runId, p.sessionId);
  if (parts.length > 256) fail("BACKEND_LIMIT");
  if (
    !parts.some((r) => {
      const part = readPrimary(db, "message_parts", String(r.id));
      return (
        part.type === "tool" &&
        part.toolCallId === p.toolCallId &&
        part.providerCallId === p.providerToolCallId &&
        part.name === "read_file" &&
        ["completed", "failed", "interrupted"].includes(String(part.state))
      );
    })
  )
    fail("BACKEND_EFFECT_PART_INVALID");
  if (p.preparedFingerprint !== null) {
    const policyHeaders = db
      .prepare(
        "SELECT seq,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND run_id=? AND turn_id=? AND attempt_id=? AND type='tool.prepared' LIMIT 513",
      )
      .all(p.sessionId, p.runId, p.turnId, p.attemptId);
    if (policyHeaders.length > 512) fail("BACKEND_LIMIT");
    const hasPrepared = policyHeaders.some((h) => {
      if (Number(h.bytes) > 65536) fail("BACKEND_LIMIT");
      const raw = db
        .prepare(
          "SELECT data FROM session_events WHERE session_id=? AND seq=? AND length(CAST(data AS BLOB))=?",
        )
        .get(p.sessionId, Number(h.seq), Number(h.bytes));
      if (!raw) fail();
      const event = JSON.parse(String(raw.data));
      return (
        event.payload?.toolCallId === p.toolCallId &&
        event.payload?.providerToolCallId === p.providerToolCallId &&
        event.payload?.toolName === "read_file" &&
        event.payload?.inputSha256 === p.inputSha256 &&
        event.payload?.preparedFingerprint === p.preparedFingerprint
      );
    });
    if (!hasPrepared) fail("BACKEND_EFFECT_FINGERPRINT_INVALID");
    const approvals = db
      .prepare("SELECT id FROM approvals WHERE tool_call_id=? LIMIT 17")
      .all(p.toolCallId);
    if (approvals.length > 16) fail("BACKEND_LIMIT");
    if (
      approvals.length &&
      !approvals.some((a) => {
        const approval = readPrimary(db, "approvals", String(a.id));
        return (
          approval.status === "allowed" &&
          approval.fingerprint === p.preparedFingerprint &&
          approval.sessionId === p.sessionId &&
          approval.runId === p.runId &&
          approval.toolName === "read_file"
        );
      }) &&
      p.state === "completed"
    )
      fail("BACKEND_EFFECT_APPROVAL_INVALID");
  }
  if (
    p.content !== null &&
    (p.state !== "completed" || !p.cleanupConfirmed || p.errorCode !== null)
  )
    fail("BACKEND_EFFECT_INVALID");
}
function validateBody(r: AgentBackendRecord): void {
  digest(r);
  id(r.id);
  id(r.entityId);
  id(r.workspaceId);
  integer(r.revision);
  if (r.revision < 1) fail();
  if (r.previousId !== null) id(r.previousId);
  id(r.lastReceiptId);
  if (new Date(r.createdAt).toISOString() !== r.createdAt) fail();
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
    ]);
    digest(r.proof);
    for (const key of [
      "backendId",
      "backendRevisionId",
      "connectionId",
      "epoch",
      "birthNonce",
    ] as const)
      id(r.proof[key]);
    for (const key of ["backendSha256", "launchSha256", "ownerSha256"] as const)
      if (!/^[a-f0-9]{64}$/.test(r.proof[key])) fail();
    if (
      r.connectionId !== r.entityId ||
      r.proof.connectionId !== r.connectionId ||
      r.proof.workspaceId !== r.workspaceId ||
      r.proof.backendId !== r.backendId ||
      r.proof.backendRevisionId !== r.backendRevisionId ||
      r.proof.backendSha256 !== r.backendSha256 ||
      ![
        "launched",
        "initialized",
        "session-ready",
        "closing",
        "closed",
        "uncertain",
        "paused-import",
      ].includes(r.state) ||
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
      ![
        "prepared",
        "dispatching",
        "dispatched",
        "completed",
        "failed",
        "cancelled",
        "uncertain",
        "paused-import",
      ].includes(r.state)
    )
      fail();
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
    if (
      ["dispatched", "completed", "failed", "cancelled"].includes(r.state) &&
      !r.dispatch
    )
      fail();
    if (["completed", "failed", "cancelled"].includes(r.state)) {
      if (!r.terminal) fail();
      const m = r.terminal.message;
      if (r.state === "failed") {
        if (!("error" in m)) fail();
      } else if (
        !("result" in m) ||
        !m.result ||
        typeof m.result !== "object" ||
        Array.isArray(m.result) ||
        ![
          "end_turn",
          "max_tokens",
          "max_turn_requests",
          "refusal",
          "cancelled",
        ].includes(String((m.result as JsonObject).stopReason)) ||
        ((m.result as JsonObject).stopReason === "cancelled") !==
          (r.state === "cancelled")
      )
        fail();
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
    ]);
    digest(r.owner);
    digest(r.frame);
    const frame = validateAcpV1Message(r.frame.message);
    if (
      !("method" in frame) ||
      frame.method !== "fs/read_text_file" ||
      !("id" in frame) ||
      frame.id !== r.rpcId
    )
      fail();
    const params = validateAcpV1ReadTextFileParams(frame.params);
    if (
      params.path !== r.input.path ||
      (params.line ?? undefined) !== r.input.line ||
      (params.limit ?? undefined) !== r.input.limit
    )
      fail();
    if (
      r.effectId !== r.entityId ||
      r.owner.workspaceId !== r.workspaceId ||
      r.frame.workspaceId !== r.workspaceId ||
      r.frame.connectionId !== r.connectionId ||
      r.frame.epoch !== r.epoch ||
      r.frame.wireId !== r.rpcId ||
      ![
        "prepared",
        "completed",
        "failed",
        "denied",
        "interrupted",
        "uncertain",
        "paused-import",
      ].includes(r.state)
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
    if (
      ["completed", "failed", "denied", "interrupted"].includes(r.state) &&
      !r.completion
    )
      fail();
    if (r.delivery) {
      digest(r.delivery);
      if (
        !r.completion ||
        r.delivery.workspaceId !== r.workspaceId ||
        r.delivery.connectionId !== r.connectionId ||
        r.delivery.epoch !== r.epoch
      )
        fail();
    }
  } else fail();
}
function validateOwnerSql(db: DatabaseSync, r: AgentBackendRecord): void {
  if (r.kind === "backend") {
    const s = readPrimary(db, "sessions", r.spec.target.sessionId);
    if (s.workspaceId !== r.workspaceId) fail();
    return;
  }
  if (r.kind === "connection") {
    const headers = db
      .prepare(
        "SELECT session_id,seq,run_id,turn_id,attempt_id,length(CAST(data AS BLOB)) bytes FROM session_events WHERE type='backend.launch_reserved' LIMIT 513",
      )
      .all();
    if (headers.length > 512) fail("BACKEND_LIMIT");
    const anchor = headers.some((h) => {
      if (Number(h.bytes) > 65536) fail("BACKEND_LIMIT");
      const raw = db
        .prepare(
          "SELECT data FROM session_events WHERE session_id=? AND seq=? AND length(CAST(data AS BLOB))=?",
        )
        .get(String(h.session_id), Number(h.seq), Number(h.bytes));
      if (!raw) fail();
      const event = JSON.parse(String(raw.data));
      return (
        event.payload?.backendId === r.backendId &&
        event.payload?.backendRevisionId === r.backendRevisionId &&
        event.payload?.ownerSha256 === r.proof.ownerSha256 &&
        event.payload?.launchSha256 === r.proof.launchSha256 &&
        event.payload?.turnId === h.turn_id &&
        event.payload?.attemptId === h.attempt_id
      );
    });
    if (!anchor) fail("BACKEND_CONNECTION_OWNER_INVALID");
    const admissions = db
      .prepare(
        "SELECT session_id,seq,run_id,turn_id,attempt_id,length(CAST(data AS BLOB)) bytes FROM session_events WHERE type='backend.connection_admitted' LIMIT 513",
      )
      .all();
    if (admissions.length > 512) fail("BACKEND_LIMIT");
    const hasAdmission = admissions.some((h) => {
      if (Number(h.bytes) > 65536) fail("BACKEND_LIMIT");
      const raw = db
        .prepare(
          "SELECT data FROM session_events WHERE session_id=? AND seq=? AND length(CAST(data AS BLOB))=?",
        )
        .get(String(h.session_id), Number(h.seq), Number(h.bytes));
      if (!raw) fail();
      const event = JSON.parse(String(raw.data)),
        p = event.payload;
      if (!p) return false;
      return (
        p.connectionId === r.connectionId &&
        p.epoch === r.proof.epoch &&
        p.processId === r.proof.processId &&
        p.birthNonce === r.proof.birthNonce &&
        p.ownerSha256 === r.proof.ownerSha256 &&
        p.backendRevisionId === r.backendRevisionId &&
        p.backendId === r.backendId &&
        p.backendSha256 === r.backendSha256 &&
        p.launchSha256 === r.proof.launchSha256
      );
    });
    if (!hasAdmission) fail("BACKEND_CONNECTION_OWNER_INVALID");
  }
  if (r.kind === "request" || r.kind === "client-effect") {
    validateTurnSql(db, r.owner);
    if (r.kind === "client-effect" && r.completion)
      validateClientEffectSql(db, r, r.completion);
  }
}
function validateTransition(
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
  if (
    before.kind !== after.kind ||
    before.entityId !== after.entityId ||
    before.workspaceId !== after.workspaceId ||
    before.revision + 1 !== after.revision ||
    after.previousId !== before.id
  )
    fail();
  const left = bodyOf(before) as Record<string, unknown>,
    right = bodyOf(after) as Record<string, unknown>;
  const mutable =
    op === "register"
      ? ["spec", "target", "enabled"]
      : op === "disable" || (op === "pause-import" && before.kind === "backend")
        ? ["enabled"]
        : op === "observe"
          ? ["state", "receiveOrdinal", "remoteSessionId", "observation"]
          : op === "dispose"
            ? ["state", "disposal", "errorCode"]
            : op === "dispatch-intent"
              ? ["state"]
              : op === "dispatch"
                ? ["state", "dispatch"]
                : op === "settle"
                  ? ["state", "terminal", "errorCode"]
                  : op === "settle-read"
                    ? ["state", "completion", "errorCode"]
                    : op === "delivery"
                      ? ["delivery"]
                      : ["state", "errorCode"];
  for (const key of Object.keys(left))
    if (
      !mutable.includes(key) &&
      knowledgeHash(left[key]) !== knowledgeHash(right[key])
    )
      fail("BACKEND_TRANSITION_INVALID");
  if (op === "disable" && after.kind === "backend" && after.enabled) fail();
  if (op === "pause-import" && after.kind === "backend" && after.enabled)
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
        const result = validateAcpV1Result("session/new", message.result) as {
          sessionId: string;
        };
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
    (after.state === "closed") !== (after.disposal?.cleanupConfirmed === true)
  )
    fail();
  if (
    op === "delivery" &&
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
export function validateAgentBackendDatabase(
  db: DatabaseSync,
  options: { check?: () => void } = {},
): void {
  const total = db
    .prepare(
      "SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes FROM backend_revisions",
    )
    .get()!;
  if (
    Number(total.n) > AGENT_BACKEND_STORAGE_LIMITS.rows ||
    Number(total.bytes) > AGENT_BACKEND_STORAGE_LIMITS.bytes
  )
    fail("BACKEND_LIMIT");
  const heads = db
    .prepare(
      "SELECT workspace_id,kind,entity_id,revision_id,revision,sha256 FROM backend_heads LIMIT 1185",
    )
    .all();
  if (heads.length > 1184) fail("BACKEND_LIMIT");
  for (const k of [
    "backend",
    "connection",
    "request",
    "client-effect",
  ] as const) {
    const max = k === "backend" ? 32 : k === "connection" ? 64 : 512;
    if (heads.filter((h) => h.kind === k).length > max) fail("BACKEND_LIMIT");
  }
  const rows = db
    .prepare(
      "SELECT id,workspace_id,kind,entity_id,revision,previous_id,session_id,run_id,turn_id,attempt_id,tool_id,connection_id,owner_epoch,request_scope,request_id,request_sha256,sha256,length(CAST(data AS BLOB)) bytes FROM backend_revisions ORDER BY kind,workspace_id,entity_id,revision",
    )
    .all() as unknown as Row[];
  const records = new Map<string, AgentBackendRecord>(),
    receipts = new Map<string, BackendTransitionReceipt>();
  for (const h of rows) {
    options.check?.();
    if (integer(h.bytes) > 65536) fail("BACKEND_LIMIT");
    const raw = db
      .prepare(
        "SELECT data FROM backend_revisions WHERE id=? AND length(CAST(data AS BLOB))=?",
      )
      .get(h.id, h.bytes);
    if (!raw) fail();
    const b = digest(JSON.parse(String(raw.data)) as Body);
    if (
      b.id !== h.id ||
      b.workspaceId !== h.workspace_id ||
      b.entityId !== h.entity_id ||
      b.sha256 !== h.sha256
    )
      fail();
    if (h.kind === "transition") {
      const t = b as BackendTransitionReceipt;
      fields(t, [
        "id",
        "workspaceId",
        "kind",
        "entityId",
        "operation",
        "beforeRevisionId",
        "afterRevisionId",
        "afterSha256",
        "requestId",
        "requestSha256",
        "requestInput",
        "createdAt",
        "sha256",
      ]);
      if (
        t.requestId !== h.request_id ||
        t.requestSha256 !== h.request_sha256 ||
        knowledgeHash(t.requestInput) !== t.requestSha256
      )
        fail();
      receipts.set(h.id, t);
    } else {
      const r = b as AgentBackendRecord;
      if (
        r.kind !== h.kind ||
        r.revision !== h.revision ||
        r.previousId !== h.previous_id
      )
        fail();
      validateBody(r);
      validateOwnerSql(db, r);
      const o = ownerOf(r);
      if (
        h.session_id !==
          (o?.sessionId ??
            (r.kind === "backend" ? r.spec.target.sessionId : null)) ||
        h.run_id !== (o?.runId ?? null) ||
        h.turn_id !== (o?.turnId ?? null) ||
        h.attempt_id !== (o?.attemptId ?? null) ||
        h.tool_id !==
          (r.kind === "client-effect"
            ? (r.completion?.toolCallId ?? null)
            : null) ||
        h.connection_id !==
          (r.kind === "connection"
            ? r.connectionId
            : r.kind === "request" || r.kind === "client-effect"
              ? r.connectionId
              : null) ||
        h.owner_epoch !== (o?.ownerEpoch ?? null)
      )
        fail();
      records.set(h.id, r);
    }
  }
  const headers = new Map(rows.map((h) => [h.id, h]));
  const maxima = new Map<string, AgentBackendRecord>();
  for (const r of records.values()) {
    const t = receipts.get(r.lastReceiptId);
    if (
      !t ||
      t.afterRevisionId !== r.id ||
      t.afterSha256 !== r.sha256 ||
      t.workspaceId !== r.workspaceId ||
      t.kind !== r.kind ||
      t.entityId !== r.entityId ||
      t.beforeRevisionId !== r.previousId ||
      t.createdAt !== r.createdAt
    )
      fail();
    const header = headers.get(r.id)!,
      receiptHeader = headers.get(t.id)!;
    const scope = `${r.kind}:${r.entityId}:${t.operation}`;
    if (
      header.request_scope !== scope ||
      receiptHeader.request_scope !== `receipt:${scope}` ||
      header.request_id !== t.requestId ||
      header.request_sha256 !== t.requestSha256 ||
      receiptHeader.revision !== r.revision ||
      receiptHeader.previous_id !== null ||
      t.requestInput.workspaceId !== r.workspaceId ||
      t.requestInput.requestId !== t.requestId ||
      t.requestInput.expectedRevision !== r.revision - 1
    )
      fail();
    const expectedOwner = ownerOf(r);
    if (
      receiptHeader.session_id !== (expectedOwner?.sessionId ?? null) ||
      receiptHeader.run_id !== (expectedOwner?.runId ?? null) ||
      receiptHeader.turn_id !== (expectedOwner?.turnId ?? null) ||
      receiptHeader.attempt_id !== (expectedOwner?.attemptId ?? null) ||
      receiptHeader.tool_id !== header.tool_id ||
      receiptHeader.connection_id !== header.connection_id ||
      receiptHeader.owner_epoch !== header.owner_epoch
    )
      fail();
    if (t.operation === "delivery" && r.kind === "client-effect") {
      const message = validateAcpV1Message(t.requestInput.message);
      if (
        !("id" in message) ||
        message.id !== r.rpcId ||
        r.delivery?.frameSha256 !== knowledgeHash(message)
      )
        fail();
      if (r.completion?.content !== null && r.completion?.errorCode === null) {
        if (
          !("result" in message) ||
          !message.result ||
          typeof message.result !== "object" ||
          Array.isArray(message.result) ||
          (message.result as JsonObject).content !== r.completion.content
        )
          fail();
      } else if (!("error" in message)) fail();
    }
    const before = r.previousId ? records.get(r.previousId) : undefined;
    if ((r.previousId && !before) || (!before && r.revision !== 1)) fail();
    assertBackendTransition(
      r.kind,
      before ? state(before) : null,
      state(r),
      t.operation,
    );
    validateTransition(before, r, t.operation);
    if (r.kind === "connection") {
      const b = records.get(r.backendRevisionId);
      if (
        !b ||
        b.kind !== "backend" ||
        b.workspaceId !== r.workspaceId ||
        b.backendId !== r.backendId ||
        b.spec.sha256 !== r.backendSha256 ||
        b.target.launchSha256 !== r.proof.launchSha256
      )
        fail();
    }
    if (r.kind === "request" || r.kind === "client-effect") {
      const c = [...records.values()].find(
        (v) =>
          v.kind === "connection" &&
          v.connectionId === r.connectionId &&
          v.workspaceId === r.workspaceId &&
          v.proof.epoch === r.epoch,
      );
      if (
        !c ||
        c.kind !== "connection" ||
        c.proof.ownerSha256 !== r.owner.sha256
      )
        fail("BACKEND_OWNER_INVALID");
      if (
        r.kind === "request" &&
        ["completed", "failed", "cancelled"].includes(r.state)
      ) {
        const closed = [...records.values()].find(
          (v) =>
            v.kind === "connection" &&
            v.workspaceId === r.workspaceId &&
            v.connectionId === r.connectionId &&
            v.proof.epoch === r.epoch &&
            v.state === "closed" &&
            v.disposal?.cleanupConfirmed === true &&
            v.createdAt <= r.createdAt,
        );
        if (!closed) fail("BACKEND_TERMINAL_INVALID");
        for (const effect of records.values())
          if (
            effect.kind === "client-effect" &&
            effect.workspaceId === r.workspaceId &&
            effect.remoteRequestId === r.remoteRequestId &&
            effect.createdAt <= r.createdAt
          ) {
            const settled = [...records.values()].find(
              (v) =>
                v.kind === "client-effect" &&
                v.entityId === effect.entityId &&
                v.workspaceId === effect.workspaceId &&
                v.delivery !== null &&
                v.completion !== null &&
                v.createdAt <= r.createdAt,
            );
            if (!settled) fail("BACKEND_EFFECT_UNSETTLED");
          }
      }
      if (r.kind === "client-effect") {
        const parent = [...records.values()].find(
          (v) =>
            v.kind === "request" &&
            v.remoteRequestId === r.remoteRequestId &&
            v.workspaceId === r.workspaceId &&
            v.owner.sha256 === r.owner.sha256 &&
            v.connectionId === r.connectionId &&
            v.epoch === r.epoch,
        );
        if (!parent) fail();
      }
    }
    const key = `${r.workspaceId}\0${r.kind}\0${r.entityId}`,
      old = maxima.get(key);
    if (!old || old.revision < r.revision) maxima.set(key, r);
  }
  if (receipts.size !== records.size || heads.length !== maxima.size) fail();
  for (const h of heads) {
    const r = maxima.get(`${h.workspace_id}\0${h.kind}\0${h.entity_id}`);
    if (
      !r ||
      h.revision_id !== r.id ||
      h.revision !== r.revision ||
      h.sha256 !== r.sha256
    )
      fail();
  }
}
function appendAdministrative(
  db: DatabaseSync,
  before: AgentBackendRecord,
  operation: "recover" | "pause-import",
  at: string,
  archiveSha?: string,
): void {
  const budget = db
    .prepare(
      "SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes FROM backend_revisions",
    )
    .get()!;
  if (Number(budget.n) + 2 > AGENT_BACKEND_STORAGE_LIMITS.rows)
    fail("BACKEND_LIMIT");
  const requestId =
      operation === "recover"
        ? `recover:${before.id}`
        : `import:${archiveSha}:${before.id}`,
    input = {
      workspaceId: before.workspaceId,
      requestId,
      expectedRevision: before.revision,
      ...(archiveSha ? { archiveSha256: archiveSha } : {}),
    };
  const body = bodyOf(before) as Record<string, unknown>;
  if (before.kind === "backend") body.enabled = false;
  else {
    body.state = operation === "recover" ? "uncertain" : "paused-import";
    body.errorCode =
      operation === "recover" ? "BACKEND_OWNER_LOST" : "BACKEND_IMPORTED";
  }
  const rid = randomUUID(),
    tid = randomUUID(),
    after = signed({
      ...body,
      id: rid,
      kind: before.kind,
      entityId: before.entityId,
      workspaceId: before.workspaceId,
      revision: before.revision + 1,
      previousId: before.id,
      lastReceiptId: tid,
      createdAt: at,
    }) as unknown as AgentBackendRecord;
  validateBody(after);
  assertBackendTransition(after.kind, state(before), state(after), operation);
  validateTransition(before, after, operation);
  const receipt = signed({
    id: tid,
    workspaceId: before.workspaceId,
    kind: before.kind,
    entityId: before.entityId,
    operation,
    beforeRevisionId: before.id,
    afterRevisionId: rid,
    afterSha256: after.sha256,
    requestId,
    requestSha256: knowledgeHash(input),
    requestInput: input,
    createdAt: at,
  });
  if (
    Number(budget.bytes) +
      Buffer.byteLength(JSON.stringify(after)) +
      Buffer.byteLength(JSON.stringify(receipt)) >
    AGENT_BACKEND_STORAGE_LIMITS.bytes
  )
    fail("BACKEND_LIMIT");
  const o = ownerOf(after),
    cid =
      after.kind === "connection"
        ? after.connectionId
        : after.kind === "request" || after.kind === "client-effect"
          ? after.connectionId
          : null,
    tool =
      after.kind === "client-effect"
        ? (after.completion?.toolCallId ?? null)
        : null,
    scope = `${before.kind}:${before.entityId}:${operation}`;
  const insert = db.prepare(
    "INSERT INTO backend_revisions(id,workspace_id,kind,entity_id,revision,previous_id,session_id,run_id,turn_id,attempt_id,tool_id,connection_id,owner_epoch,request_scope,request_id,request_sha256,sha256,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  insert.run(
    rid,
    after.workspaceId,
    after.kind,
    after.entityId,
    after.revision,
    after.previousId,
    o?.sessionId ??
      (after.kind === "backend" ? after.spec.target.sessionId : null),
    o?.runId ?? null,
    o?.turnId ?? null,
    o?.attemptId ?? null,
    tool,
    cid,
    o?.ownerEpoch ?? null,
    scope,
    requestId,
    receipt.requestSha256,
    after.sha256,
    JSON.stringify(after),
  );
  insert.run(
    tid,
    after.workspaceId,
    "transition",
    after.entityId,
    after.revision,
    null,
    o?.sessionId ?? null,
    o?.runId ?? null,
    o?.turnId ?? null,
    o?.attemptId ?? null,
    tool,
    cid,
    o?.ownerEpoch ?? null,
    `receipt:${scope}`,
    requestId,
    receipt.requestSha256,
    receipt.sha256,
    JSON.stringify(receipt),
  );
  const cas = db
    .prepare(
      "UPDATE backend_heads SET revision_id=?,revision=?,sha256=? WHERE workspace_id=? AND kind=? AND entity_id=? AND revision_id=? AND revision=? AND sha256=?",
    )
    .run(
      rid,
      after.revision,
      after.sha256,
      after.workspaceId,
      after.kind,
      after.entityId,
      before.id,
      before.revision,
      before.sha256,
    );
  if (cas.changes !== 1) fail("BACKEND_REVISION_CONFLICT");
}
function currentBodies(
  db: DatabaseSync,
  workspaceId?: string,
): AgentBackendRecord[] {
  const hs = db
    .prepare(
      `SELECT h.revision_id,length(CAST(r.data AS BLOB)) bytes FROM backend_heads h JOIN backend_revisions r ON r.id=h.revision_id ${workspaceId ? "WHERE h.workspace_id=?" : ""} LIMIT 1185`,
    )
    .all(...(workspaceId ? [id(workspaceId)] : []));
  if (hs.length > 1184) fail("BACKEND_LIMIT");
  return hs.map((h) => {
    if (Number(h.bytes) > 65536) fail("BACKEND_LIMIT");
    const r = db
      .prepare(
        "SELECT data FROM backend_revisions WHERE id=? AND length(CAST(data AS BLOB))=?",
      )
      .get(String(h.revision_id), Number(h.bytes));
    if (!r) fail();
    return digest(JSON.parse(String(r.data)) as AgentBackendRecord);
  });
}
export function recoverAgentBackends(
  db: DatabaseSync,
  at = new Date().toISOString(),
): number {
  validateAgentBackendDatabase(db);
  const records = currentBodies(db).filter((r) =>
    r.kind === "connection"
      ? ["launched", "initialized", "session-ready", "closing"].includes(
          r.state,
        )
      : r.kind === "request"
        ? ["prepared", "dispatching", "dispatched"].includes(r.state)
        : r.kind === "client-effect"
          ? r.state === "prepared"
          : false,
  );
  for (const r of records) appendAdministrative(db, r, "recover", at);
  return records.length;
}
export function markImportedAgentBackendsPaused(
  db: DatabaseSync,
  archiveSha: string,
  workspaceId?: string,
): void {
  if (!/^[a-f0-9]{64}$/.test(archiveSha)) fail();
  validateAgentBackendDatabase(db);
  for (const r of currentBodies(db, workspaceId))
    appendAdministrative(
      db,
      r,
      "pause-import",
      new Date().toISOString(),
      archiveSha,
    );
}
export function hasAgentBackendBlocker(
  db: DatabaseSync,
  workspaceId: string,
): boolean {
  return currentBodies(db, workspaceId).some(
    (r) =>
      r.kind !== "backend" &&
      (r.state === "uncertain" ||
        (r.state === "paused-import" &&
          (r.kind === "connection"
            ? r.disposal?.cleanupConfirmed !== true
            : r.kind === "request"
              ? r.terminal === null
              : r.completion === null ||
                r.completion.cleanupConfirmed !== true ||
                r.delivery === null))),
  );
}
