import { readOwnedCommandJob } from "../jobs/owned-command-records.js";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import {
  EngineError,
  type JsonObject,
  type Workspace,
} from "@moodcode/contracts";
import {
  immutableKnowledgeJson as json,
  knowledgeHash,
} from "../knowledge/validation.js";
import { sha256Hex } from "../shared/canonical.js";
import { readBoundedBody } from "../storage/evidence-read.js";
import {
  assertOnlyChanged,
  assertRevisionLink,
  createRevisionJournal,
  type RevisionJournal,
  type RevisionJournalProfile,
} from "../storage/revision-journal.js";
import type { TurnRequest } from "../ports.js";
import type {
  AgentBackendSpec,
  AgentBackendSpecInput,
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
import {
  clientEffectToolName,
  clientReadToolInput,
  terminalCommandLine,
  workspaceLocalPath,
  type BackendClientReadInput,
  type BackendClientReadProof,
  type BackendClientEffectInput,
  type BackendClientPermissionProof,
} from "./client-effects.js";
import {
  assertBackendTransition,
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
export interface ActualBackendTurnPort {
  readOwner(original: object): BackendTurnProof;
  readCurrentInput?(original: object): {
    readonly prompt: string;
    readonly instructions: readonly string[];
  };
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
  readClientPermission?(original: object): BackendClientPermissionProof;
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
export interface PrepareBackendSessionLoadInput extends BackendMutationInput {
  readonly connectionId: string;
  readonly message: AcpV1Message;
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
  readonly input: BackendClientReadInput | BackendClientEffectInput;
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
function fail(code = "BACKEND_DATABASE_INVALID"): never {
  throw new EngineError(
    code,
    "Backend journal or original runtime owner is stale or invalid",
  );
}
/** Callers select inputs and capture IDs/time; validation precedes receipt signing. */
function prepareSignedBackendRevision<T extends AgentBackendRecord>(
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
function digest<T extends { sha256: string }>(value: T): T {
  const copy = json(value),
    { sha256, ...body } = copy;
  if (sha(sha256) !== knowledgeHash(body)) fail();
  return copy;
}
/** A terminal control that outgrows its effect revision is a backend capacity failure. */
function terminalCapacity<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof EngineError && error.code === "KNOWLEDGE_LIMIT")
      fail("BACKEND_LIMIT");
    throw error;
  }
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > AGENT_BACKEND_LIMITS.requestIdBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail("INVALID_BACKEND_INPUT");
  return value;
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail();
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
function recoverable(kind: string, value: unknown): boolean {
  return kind === "connection"
    ? ["launched", "initialized", "session-ready", "closing"].includes(
        value as string,
      )
    : kind === "request"
      ? ["prepared", "dispatching", "dispatched"].includes(value as string)
      : kind === "client-effect" && value === "prepared";
}
function pausable(kind: string, value: unknown): boolean {
  return kind === "backend" || value !== "paused-import";
}
/** Upper bound of a receipt plus the state fields an administrative revision changes. */
const ADMINISTRATIVE_REVISION_BYTES = 4096;
/** Rows and bytes that recover and a later pause-import still need once `next` heads its entity. */
function administrativeReserve(
  db: DatabaseSync,
  next: AgentBackendRecord,
): { rows: number; bytes: number } {
  let rows = 0,
    bytes = 0;
  const add = (kind: string, value: unknown, n: number, size: number) => {
    const writes =
      Number(recoverable(kind, value)) + Number(pausable(kind, value));
    rows += 2 * writes * n;
    bytes += writes * (size + n * ADMINISTRATIVE_REVISION_BYTES);
  };
  for (const g of db
    .prepare(
      "SELECT h.kind,json_extract(r.data,'$.state') state,count(*) n,coalesce(sum(length(CAST(r.data AS BLOB))),0) bytes FROM backend_heads h JOIN backend_revisions r ON r.id=h.revision_id WHERE NOT (h.workspace_id=? AND h.kind=? AND h.entity_id=?) GROUP BY 1,2",
    )
    .all(next.workspaceId, next.kind, next.entityId))
    add(String(g.kind), g.state, Number(g.n), Number(g.bytes));
  add(next.kind, state(next), 1, Buffer.byteLength(JSON.stringify(next)));
  return { rows, bytes };
}
/** Wall-clock time clamped to the newest head, because the validator orders revisions by createdAt. */
function backendClock(db: DatabaseSync, now: number): string {
  const at = new Date(integer(now, 8640000000000000)).toISOString(),
    last = db
      .prepare(
        "SELECT max(json_extract(r.data,'$.createdAt')) at FROM backend_heads h JOIN backend_revisions r ON r.id=h.revision_id",
      )
      .get()?.at;
  return typeof last === "string" && last > at ? last : at;
}
/** Index columns of a revision row; the receipt row of a backend revision has no session. */
function revisionColumns(r: AgentBackendRecord, receipt: boolean) {
  const o = ownerOf(r);
  return {
    session_id:
      o?.sessionId ??
      (!receipt && r.kind === "backend" ? r.spec.target.sessionId : null),
    run_id: o?.runId ?? null,
    turn_id: o?.turnId ?? null,
    attempt_id: o?.attemptId ?? null,
    tool_id:
      r.kind === "client-effect" ? (r.completion?.toolCallId ?? null) : null,
    connection_id: r.kind === "backend" ? null : r.connectionId,
    owner_epoch: o?.ownerEpoch ?? null,
  };
}
const BACKEND_JOURNAL: RevisionJournalProfile<
  BackendJournalKind,
  AgentBackendRecord
> = {
  revisions: "backend_revisions",
  heads: "backend_heads",
  columns: [
    "session_id",
    "run_id",
    "turn_id",
    "attempt_id",
    "tool_id",
    "connection_id",
    "owner_epoch",
  ],
  limits: {
    rowBytes: AGENT_BACKEND_STORAGE_LIMITS.rowBytes,
    rows: AGENT_BACKEND_STORAGE_LIMITS.rows,
    bytes: AGENT_BACKEND_STORAGE_LIMITS.bytes,
    kinds: {
      backend: AGENT_BACKEND_STORAGE_LIMITS.backends,
      connection: AGENT_BACKEND_STORAGE_LIMITS.connections,
      request: AGENT_BACKEND_STORAGE_LIMITS.requests,
      "client-effect": AGENT_BACKEND_STORAGE_LIMITS.effects,
    },
  },
  index: revisionColumns,
  scope(kind, entityId, operation) {
    const record = `${kind}:${entityId}:${operation}`;
    return { record, receipt: `receipt:${record}` };
  },
  receiptPrevious: () => null,
  identifier: id,
  sealed: digest,
  verify(record, db) {
    validateBody(record);
    validateOwnerSql(db, record);
  },
  fail,
  codes: {
    limit: "BACKEND_LIMIT",
    revisionConflict: "BACKEND_REVISION_CONFLICT",
    requestConflict: "BACKEND_REQUEST_CONFLICT",
  },
};
type BackendJournal = RevisionJournal<
  BackendJournalKind,
  AgentBackendRecord,
  BackendTransitionReceipt
>;
function backendJournal(db: DatabaseSync): BackendJournal {
  return createRevisionJournal<
    BackendJournalKind,
    AgentBackendRecord,
    BackendTransitionReceipt
  >(db, BACKEND_JOURNAL);
}
/** Native SQLite owns history; all live execution authorization remains in ORIGINAL Root producers. */
export class AgentBackendStorage {
  private readonly journal: BackendJournal;
  constructor(
    readonly db: DatabaseSync,
    private readonly ports: AgentBackendStoragePorts,
  ) {
    this.journal = backendJournal(db);
  }
  private time(): string {
    return backendClock(this.db, this.ports.now?.() ?? Date.now());
  }
  private get<T extends AgentBackendRecord>(
    ws: string,
    kind: BackendJournalKind,
    eid: string,
    revisionId?: string,
  ): T | undefined {
    if (!revisionId) return this.journal.head<T>(ws, kind, eid);
    const r = this.journal.read<T>(ws, revisionId, kind);
    if (r.entityId !== eid) fail();
    return r;
  }
  getBackend(
    ws: string,
    backendId: string,
    revisionId?: string,
  ): AgentBackendRevision | undefined {
    return this.get(ws, "backend", backendId, revisionId);
  }
  private getConnection(
    ws: string,
    connectionId: string,
    revisionId?: string,
  ): BackendConnectionRevision | undefined {
    return this.get(ws, "connection", connectionId, revisionId);
  }
  getRequest(
    ws: string,
    remoteRequestId: string,
    revisionId?: string,
  ): BackendRemoteRequest | undefined {
    return this.get(ws, "request", remoteRequestId, revisionId);
  }
  /** Historical rows are evidence; only the fresh Original target grants dispatch. */
  assertSessionLoadSource(
    spec: AgentBackendSpec,
    target: BackendTargetProof,
  ): void {
    const source = validateSessionLoadSourceSql(this.db, spec, target);
    if (!source) return;
    const m = spec.sessionLoad!;
    if (
      source.connection.proof.ownerSha256 !== source.request.owner.sha256 ||
      source.request.owner.ownerEpoch !== target.ownerEpoch ||
      source.request.owner.rootBindingSha256 !== target.rootBindingSha256 ||
      source.backend.target.launchSha256 !== target.launchSha256 ||
      this.getBackend(target.workspaceId, m.sourceBackendId)?.id !==
        m.sourceBackendRevisionId ||
      this.getRequest(target.workspaceId, m.sourceRequestId)?.id !==
        m.sourceRequestRevisionId ||
      this.getConnection(target.workspaceId, m.sourceConnectionId)?.id !==
        m.sourceConnectionRevisionId
    )
      fail("BACKEND_LOAD_SOURCE_INVALID");
  }
  private getClientEffect(
    ws: string,
    effectId: string,
  ): BackendClientEffectRevision | undefined {
    return this.journal.head(ws, "client-effect", effectId);
  }
  inspectBackends(ws: string): AgentBackendRevision[] {
    return this.journal.list(
      ws,
      "backend",
      AGENT_BACKEND_STORAGE_LIMITS.backends,
    );
  }
  inspectConnections(ws: string): BackendConnectionRevision[] {
    return this.journal.list(
      ws,
      "connection",
      AGENT_BACKEND_STORAGE_LIMITS.connections,
    );
  }
  inspectRequests(ws: string): BackendRemoteRequest[] {
    return this.journal.list(
      ws,
      "request",
      AGENT_BACKEND_STORAGE_LIMITS.requests,
    );
  }
  inspectClientEffects(ws: string): BackendClientEffectRevision[] {
    return this.journal.list(
      ws,
      "client-effect",
      AGENT_BACKEND_STORAGE_LIMITS.effects,
    );
  }
  private duplicate<T extends AgentBackendRecord>(
    ws: string,
    kind: BackendJournalKind,
    eid: string,
    op: string,
    input: BackendMutationInput,
  ): BackendRequestResult<T> | undefined {
    const pair = this.journal.replay<T>(ws, kind, eid, op, input);
    return pair && json({ ...pair, duplicate: true });
  }
  /** Builds the next revision and its receipt under every journal bound, without writing them. */
  private admit<T extends AgentBackendRecord>(
    kind: BackendJournalKind,
    eid: string,
    op: string,
    input: BackendMutationInput,
    before: T | undefined,
    body: Omit<T, keyof BackendRevisionBase>,
  ): BackendRequestResult<T> {
    const pair = this.journal.admit<T>({
      kind,
      before,
      expectedRevision: input.expectedRevision,
      build: (revisionId, receiptId) =>
        prepareSignedBackendRevision<T>({
          kind,
          entityId: eid,
          workspaceId: input.workspaceId,
          before,
          body,
          requestInput: input,
          revisionId,
          receiptId,
          operation: op,
          createdAt: this.time(),
        }),
      reserve: (record) => administrativeReserve(this.db, record),
    });
    return json({ ...pair, duplicate: false });
  }
  private append<T extends AgentBackendRecord>(
    kind: BackendJournalKind,
    eid: string,
    op: string,
    input: BackendMutationInput,
    before: T | undefined,
    body: Omit<T, keyof BackendRevisionBase>,
  ): BackendRequestResult<T> {
    const admitted = this.admit(kind, eid, op, input, before, body);
    this.journal.write(admitted, before);
    return admitted;
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
      if (before.sessionLoad?.state === "dispatching") {
        const message = p.message;
        if (
          x.state !== "initialized" ||
          x.remoteSessionId !== null ||
          !("method" in message) ||
          "id" in message ||
          message.method !== "session/update" ||
          message.params?.sessionId !==
            (before.sessionLoad.message as { params: JsonObject }).params
              .sessionId
        )
          fail("ACP_LOAD_EFFECT_UNSUPPORTED");
        const hashes = [...before.sessionLoad.replayHashes, p.frameSha256];
        const bytes =
          before.sessionLoad.replayBytes +
          Buffer.byteLength(JSON.stringify(message));
        if (hashes.length > 128 || bytes > 32768)
          fail("BACKEND_LOAD_REPLAY_LIMIT");
        return this.append("connection", x.connectionId, "observe", x, before, {
          ...bodyOf(before),
          receiveOrdinal: p.receiveOrdinal,
          observation: p,
          sessionLoad: {
            ...before.sessionLoad,
            replayHashes: hashes,
            replayBytes: bytes,
          },
        });
      }
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
  prepareSessionLoad(
    originalTurn: object,
    input: PrepareBackendSessionLoadInput,
  ): BackendRequestResult<BackendConnectionRevision> {
    const x = this.input(input, ["connectionId", "message"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendConnectionRevision>(
        x.workspaceId,
        "connection",
        x.connectionId,
        "load-intent",
        x,
      );
      if (d) return d;
      const before = this.required(
        this.getConnection(x.workspaceId, x.connectionId),
      );
      const b = this.required(this.getBackend(x.workspaceId, before.backendId));
      const owner = this.owner(originalTurn);
      const message = validateAcpV1Message(x.message);
      if (
        !b.enabled ||
        !b.spec.sessionLoad ||
        b.spec.contextOwner !== "agent" ||
        before.state !== "initialized" ||
        before.sessionLoad ||
        before.capabilities?.loadSession !== true ||
        before.capabilities.contextOwner !== "agent" ||
        owner.sha256 !== before.proof.ownerSha256 ||
        !("method" in message) ||
        !("id" in message) ||
        message.method !== "session/load"
      )
        fail("ACP_LOAD_UNSUPPORTED");
      const params = validateAcpV1Request("session/load", message.params);
      if (
        params.sessionId !== b.spec.sessionLoad.remoteSessionId ||
        params.cwd !== b.spec.launch.cwd
      )
        fail("BACKEND_LOAD_SOURCE_INVALID");
      this.assertSessionLoadSource(b.spec, b.target);
      return this.append(
        "connection",
        x.connectionId,
        "load-intent",
        x,
        before,
        {
          ...bodyOf(before),
          sessionLoad: {
            state: "dispatching",
            message,
            write: null,
            response: null,
            replayHashes: [],
            replayBytes: 0,
          },
        },
      );
    });
  }
  recordLoadedSession(
    originalFrame: object,
    originalWrite: object,
    input: DisposeBackendConnectionInput,
  ): BackendRequestResult<BackendConnectionRevision> {
    const x = this.input(input, ["connectionId"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendConnectionRevision>(
        x.workspaceId,
        "connection",
        x.connectionId,
        "load-ready",
        x,
      );
      if (d) return d;
      const before = this.required(
        this.getConnection(x.workspaceId, x.connectionId),
      );
      const load = before.sessionLoad;
      const frame = this.frame(originalFrame, before),
        write = digest(this.ports.readWrite(originalWrite));
      if (
        before.state !== "initialized" ||
        load?.state !== "dispatching" ||
        !("id" in load.message) ||
        !("result" in frame.message) ||
        frame.wireId !== load.message.id ||
        frame.receiveOrdinal !== before.receiveOrdinal + 1 ||
        write.workspaceId !== x.workspaceId ||
        write.connectionId !== before.connectionId ||
        write.epoch !== before.proof.epoch ||
        write.backendId !== before.backendId ||
        !Number.isSafeInteger(write.writeOrdinal) ||
        write.writeOrdinal < 1 ||
        write.writtenBytes !==
          Buffer.byteLength(encodeAcpV1Message(load.message)) ||
        write.frameSha256 !== knowledgeHash(load.message)
      )
        fail("BACKEND_REMOTE_SESSION_INVALID");
      validateAcpV1Result("session/load", frame.message.result);
      return this.append(
        "connection",
        x.connectionId,
        "load-ready",
        x,
        before,
        {
          ...bodyOf(before),
          state: "session-ready",
          remoteSessionId: (load.message as { params: JsonObject }).params
            .sessionId as string,
          receiveOrdinal: frame.receiveOrdinal,
          writeOrdinal: write.writeOrdinal,
          observation: frame,
          sessionLoad: { ...load, state: "loaded", write, response: frame },
        },
      );
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
      const owner = this.owner(originalTurn);
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
        p = this.owner(originalTurn);
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
  negotiateCapabilities(
    originalTurn: object,
    originalFrame: object,
    input: DisposeBackendConnectionInput,
  ): BackendRequestResult<BackendConnectionRevision> {
    const x = this.input(input, ["connectionId"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendConnectionRevision>(
        x.workspaceId,
        "connection",
        x.connectionId,
        "negotiate",
        x,
      );
      if (d) return d;
      const before = this.required(
        this.getConnection(x.workspaceId, x.connectionId),
      );
      if (before.state !== "initialized" || before.capabilities)
        fail("BACKEND_CONNECTION_STALE");
      const owner = this.owner(originalTurn);
      if (owner.sha256 !== before.proof.ownerSha256)
        fail("BACKEND_OWNER_INVALID");
      const frame = this.frame(originalFrame, before);
      if (
        frame.sha256 !== before.observation?.sha256 ||
        !("result" in frame.message)
      )
        fail("BACKEND_FRAME_NOT_RECORDED");
      const request = originalTurn as TurnRequest;
      const effects = before.proof.executionMode === "engine-client-effects";
      const b = this.required(this.getBackend(x.workspaceId, before.backendId));
      const capabilities = negotiateAcpV1Capabilities(frame.message.result, {
        readTextFile: request.tools.some((t) => t.name === "read_file"),
        writeTextFile:
          effects && request.tools.some((t) => t.name === "apply_patch"),
        terminal:
          effects &&
          before.proof.clientCapabilities?.terminal === true &&
          request.tools.some((t) => t.name === "run_command"),
        contextOwner: b.spec.contextOwner,
        loadSession: b.spec.sessionLoad !== undefined,
      });
      if (b.spec.sessionLoad && !capabilities.loadSession)
        fail("ACP_LOAD_UNSUPPORTED");
      return this.append("connection", x.connectionId, "negotiate", x, before, {
        ...bodyOf(before),
        capabilities,
      });
    });
  }
  recordRequestCancel(
    originalWrite: object,
    input: MutateBackendRequestInput & { message: AcpV1Message },
  ): BackendRequestResult<BackendRemoteRequest> {
    const x = this.input(input, ["remoteRequestId", "message"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendRemoteRequest>(
        x.workspaceId,
        "request",
        x.remoteRequestId,
        "cancel-wire",
        x,
      );
      if (d) return d;
      const before = this.required(
        this.getRequest(x.workspaceId, x.remoteRequestId),
      );
      if (
        before.cancellation ||
        ["completed", "failed", "cancelled", "paused-import"].includes(
          before.state,
        )
      )
        fail("BACKEND_REQUEST_STALE");
      const message = validateAcpV1Message(x.message);
      if (
        !("method" in message) ||
        message.method !== "session/cancel" ||
        (
          validateAcpV1Request(message.method, message.params) as {
            sessionId: string;
          }
        ).sessionId !== before.remoteSessionId
      )
        fail("BACKEND_REMOTE_SESSION_INVALID");
      const write = digest(this.ports.readWrite(originalWrite));
      this.writeMatches(
        write,
        before.connectionId,
        before.epoch,
        x.workspaceId,
        knowledgeHash(message),
      );
      return this.append(
        "request",
        x.remoteRequestId,
        "cancel-wire",
        x,
        before,
        { ...bodyOf(before), cancellation: { message, write } },
      );
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
      const owner = this.owner(originalTurn);
      if (owner.sha256 !== r.owner.sha256) fail("BACKEND_OWNER_INVALID");
      const c = this.liveConnection(r),
        frame = this.frame(originalFrame, c);
      if (c.observation?.sha256 !== frame.sha256)
        fail("BACKEND_FRAME_NOT_RECORDED");
      validateEffectInput(frame.message, x.input, r.remoteSessionId);
      if (
        "method" in x.input &&
        (c.proof.executionMode !== "engine-client-effects" ||
          (x.input.method === "fs/write_text_file"
            ? c.capabilities?.writeTextFile !== true
            : c.capabilities?.terminal !== true))
      )
        fail("ACP_EFFECT_UNSUPPORTED");
      if (!("method" in frame.message) || !("id" in frame.message))
        fail("ACP_EFFECT_UNSUPPORTED");
      id(x.input.callId);
      for (const old of this.inspectClientEffects(x.workspaceId))
        if (
          old.connectionId === r.connectionId &&
          old.epoch === r.epoch &&
          (old.rpcId === frame.message.id ||
            old.executionFrame?.wireId === frame.message.id)
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
          ...("method" in x.input
            ? { permission: null, permissionDelivery: null }
            : {}),
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
          ...(before.permission?.allowed === false
            ? { delivery: before.permissionDelivery }
            : {}),
        },
      );
    });
  }
  bindApprovedClientEffect(
    originalTurn: object,
    originalFrame: object,
    input: MutateBackendClientEffectInput & { input: BackendClientEffectInput },
  ): BackendRequestResult<BackendClientEffectRevision> {
    const x = this.input(input, ["effectId", "input"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendClientEffectRevision>(
        x.workspaceId,
        "client-effect",
        x.effectId,
        "bind-effect",
        x,
      );
      if (d) return d;
      const before = this.required(
        this.getClientEffect(x.workspaceId, x.effectId),
      );
      if (
        before.state !== "prepared" ||
        !before.permission?.allowed ||
        !before.permissionDelivery ||
        before.executionFrame
      )
        fail("BACKEND_EFFECT_STALE");
      const owner = this.owner(originalTurn);
      if (owner.sha256 !== before.owner.sha256) fail("BACKEND_OWNER_INVALID");
      const request = this.required(
          this.getRequest(x.workspaceId, before.remoteRequestId),
        ),
        connection = this.liveConnection(request),
        frame = this.frame(originalFrame, connection);
      if (
        connection.observation?.sha256 !== frame.sha256 ||
        !("method" in frame.message) ||
        frame.message.method === "session/request_permission"
      )
        fail("BACKEND_EFFECT_STALE");
      validateEffectInput(frame.message, x.input, request.remoteSessionId);
      if (knowledgeHash(x.input) !== knowledgeHash(before.input))
        fail("BACKEND_EFFECT_INPUT_INVALID");
      for (const other of this.inspectClientEffects(x.workspaceId))
        if (
          other.effectId !== before.effectId &&
          other.connectionId === before.connectionId &&
          other.epoch === before.epoch &&
          (other.rpcId === frame.wireId ||
            other.executionFrame?.wireId === frame.wireId)
        )
          fail("BACKEND_EFFECT_ALREADY_BOUND");
      return this.append(
        "client-effect",
        x.effectId,
        "bind-effect",
        x,
        before,
        { ...bodyOf(before), executionFrame: frame },
      );
    });
  }
  recordTerminalControl(
    originalTurn: object,
    originalFrame: object,
    originalWrite: object,
    input: DeliverBackendClientEffectInput,
  ): BackendRequestResult<BackendClientEffectRevision> {
    const x = this.input(input, ["effectId", "message"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendClientEffectRevision>(
        x.workspaceId,
        "client-effect",
        x.effectId,
        "terminal-control",
        x,
      );
      if (d) return d;
      const { before, body } = this.terminalControl(
        originalTurn,
        originalFrame,
        originalWrite,
        x,
      );
      return terminalCapacity(() =>
        this.append(
          "client-effect",
          x.effectId,
          "terminal-control",
          x,
          before,
          body,
        ),
      );
    });
  }
  /** Dry run of recordTerminalControl, so a reply the journal cannot hold is never written. */
  assertTerminalControl(
    originalTurn: object,
    originalFrame: object,
    input: DeliverBackendClientEffectInput,
  ): void {
    const x = this.input(input, ["effectId", "message"]);
    const { before, body } = this.terminalControl(
      originalTurn,
      originalFrame,
      null,
      x,
    );
    terminalCapacity(() =>
      this.admit(
        "client-effect",
        x.effectId,
        "terminal-control",
        x,
        before,
        body,
      ),
    );
  }
  /** Checks a terminal control and builds its body; before the write, a maximal-ordinal stand-in bounds the row. */
  private terminalControl(
    originalTurn: object,
    originalFrame: object,
    originalWrite: object | null,
    x: DeliverBackendClientEffectInput,
  ): {
    before: BackendClientEffectRevision;
    body: Omit<BackendClientEffectRevision, keyof BackendRevisionBase>;
  } {
    const before = this.required(
      this.getClientEffect(x.workspaceId, x.effectId),
    );
    if (
      !("method" in before.input) ||
      before.input.method !== "terminal/create" ||
      (before.completion && !before.completion.cleanupConfirmed)
    )
      fail("BACKEND_TERMINAL_STALE");
    if ((before.controls?.length ?? 0) >= 32) fail("BACKEND_LIMIT");
    if (this.owner(originalTurn).sha256 !== before.owner.sha256)
      fail("BACKEND_OWNER_INVALID");
    const parent = this.required(
        this.getRequest(x.workspaceId, before.remoteRequestId),
      ),
      connection = this.liveConnection(parent),
      frame = this.frame(originalFrame, connection);
    if (frame.receiveOrdinal > connection.receiveOrdinal)
      fail("BACKEND_FRAME_NOT_RECORDED");
    const write = originalWrite
      ? digest(this.ports.readWrite(originalWrite))
      : signed<Omit<BackendWriteProof, "sha256">>({
          workspaceId: x.workspaceId,
          backendId: connection.backendId,
          connectionId: before.connectionId,
          epoch: before.epoch,
          writeOrdinal: Number.MAX_SAFE_INTEGER,
          frameSha256: knowledgeHash(x.message),
          writtenBytes: Number.MAX_SAFE_INTEGER,
        });
    this.writeMatches(
      write,
      before.connectionId,
      before.epoch,
      x.workspaceId,
      knowledgeHash(x.message),
    );
    validateTerminalControl(
      before,
      { frame, write, message: x.message },
      parent.remoteSessionId,
    );
    validateTerminalOutputSql(this.db, before, {
      frame,
      write,
      message: x.message,
    });
    if (before.controls?.some((c) => c.frame.wireId === frame.wireId))
      fail("BACKEND_EFFECT_ALREADY_BOUND");
    return {
      before,
      body: {
        ...bodyOf(before),
        controls: [
          ...(before.controls ?? []),
          { frame, write, message: x.message },
        ],
      },
    };
  }
  markClientEffectUncertain(
    input: MutateBackendClientEffectInput & { errorCode: string },
  ): BackendRequestResult<BackendClientEffectRevision> {
    const x = this.input(input, ["effectId", "errorCode"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendClientEffectRevision>(
        x.workspaceId,
        "client-effect",
        x.effectId,
        "uncertain",
        x,
      );
      if (d) return d;
      const before = this.required(
        this.getClientEffect(x.workspaceId, x.effectId),
      );
      return this.append("client-effect", x.effectId, "uncertain", x, before, {
        ...bodyOf(before),
        state: "uncertain",
        errorCode: id(x.errorCode),
      });
    });
  }
  recordClientPermission(
    originalPermission: object,
    originalWrite: object,
    input: MutateBackendClientEffectInput & { message: AcpV1Message },
  ): BackendRequestResult<BackendClientEffectRevision> {
    const x = this.input(input, ["effectId", "message"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendClientEffectRevision>(
        x.workspaceId,
        "client-effect",
        x.effectId,
        "permission",
        x,
      );
      if (d) return d;
      const before = this.required(
        this.getClientEffect(x.workspaceId, x.effectId),
      );
      if (
        before.state !== "prepared" ||
        before.permission ||
        !("method" in before.frame.message) ||
        before.frame.message.method !== "session/request_permission" ||
        !this.ports.readClientPermission
      )
        fail("BACKEND_EFFECT_STALE");
      const permission = digest(
        this.ports.readClientPermission(originalPermission),
      );
      validatePermissionSql(this.db, before, permission);
      const write = digest(this.ports.readWrite(originalWrite));
      this.writeMatches(
        write,
        before.connectionId,
        before.epoch,
        x.workspaceId,
        knowledgeHash(x.message),
      );
      validatePermissionResponse(before, permission, x.message);
      return this.append("client-effect", x.effectId, "permission", x, before, {
        ...bodyOf(before),
        permission,
        permissionDelivery: write,
      });
    });
  }
  recordClientAcknowledgement(
    originalWrite: object,
    input: DeliverBackendClientEffectInput,
  ): BackendRequestResult<BackendClientEffectRevision> {
    const x = this.input(input, ["effectId", "message"]);
    return this.ports.writeTx(() => {
      const d = this.duplicate<BackendClientEffectRevision>(
        x.workspaceId,
        "client-effect",
        x.effectId,
        "effect-ack",
        x,
      );
      if (d) return d;
      const before = this.required(
        this.getClientEffect(x.workspaceId, x.effectId),
      );
      if (
        before.state !== "prepared" ||
        before.delivery ||
        !("method" in before.input) ||
        before.input.method !== "terminal/create"
      )
        fail("BACKEND_EFFECT_STALE");
      const rows = nativePayloads(
        this.db,
        before.owner,
        "backend.client_effect_dispatched",
      );
      if (!rows.some((p) => p.providerToolCallId === before.input.callId))
        fail("BACKEND_EFFECT_STALE");
      const message = x.message;
      if (
        !("id" in message) ||
        message.id !== effectRpc(before) ||
        !("result" in message) ||
        !message.result ||
        typeof message.result !== "object" ||
        Array.isArray(message.result) ||
        message.result.terminalId !== `terminal:${before.effectId}`
      )
        fail("BACKEND_DELIVERY_INVALID");
      const write = digest(this.ports.readWrite(originalWrite));
      this.writeMatches(
        write,
        before.connectionId,
        before.epoch,
        x.workspaceId,
        knowledgeHash(message),
      );
      return this.append("client-effect", x.effectId, "effect-ack", x, before, {
        ...bodyOf(before),
        delivery: write,
      });
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
      if (!("id" in x.message) || x.message.id !== effectRpc(before))
        fail("BACKEND_DELIVERY_INVALID");
      validateEffectResponse(before, x.message);
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
        state:
          p.cleanupConfirmed && before.sessionLoad?.state !== "dispatching"
            ? "closed"
            : "uncertain",
        disposal: p,
        ...(before.sessionLoad?.state === "dispatching"
          ? {
              sessionLoad: {
                ...before.sessionLoad,
                state: "uncertain" as const,
              },
            }
          : {}),
        errorCode:
          before.sessionLoad?.state === "dispatching"
            ? "BACKEND_LOAD_UNCERTAIN"
            : p.cleanupConfirmed
              ? null
              : "CLEANUP_UNCERTAIN",
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
  private owner(original: object): BackendTurnProof {
    const p = digest(this.ports.readOwner(original));
    sync(this.ports.assertOwnerCurrent(original, p, "dispatch"));
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
function readPrimary(
  db: DatabaseSync,
  table:
    | "runs"
    | "checkpoints"
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
function validateSessionLoadSourceSql(
  db: DatabaseSync,
  spec: AgentBackendSpec,
  target: BackendTargetProof,
):
  | {
      backend: AgentBackendRevision;
      request: BackendRemoteRequest;
      connection: BackendConnectionRevision;
    }
  | undefined {
  const load = spec.sessionLoad;
  if (!load) return;
  function revision<T extends AgentBackendRecord>(
    rid: string,
    kind: BackendJournalKind,
  ): T {
    const h = db
      .prepare(
        "SELECT workspace_id,kind,sha256,length(CAST(data AS BLOB)) bytes FROM backend_revisions WHERE id=?",
      )
      .get(id(rid));
    if (
      !h ||
      h.workspace_id !== spec.target.workspaceId ||
      h.kind !== kind ||
      Number(h.bytes) > AGENT_BACKEND_STORAGE_LIMITS.rowBytes
    )
      fail("BACKEND_LOAD_SOURCE_INVALID");
    const invalid = () => fail("BACKEND_LOAD_SOURCE_INVALID");
    const raw =
      readBoundedBody(
        db,
        { table: "backend_revisions", where: "id=?", params: [rid] },
        Number(h.bytes),
        invalid,
      ) ?? invalid();
    const r = json(JSON.parse(raw)) as unknown as T;
    validateBody(r);
    validateOwnerSql(db, r);
    if (
      r.id !== rid ||
      r.sha256 !== h.sha256 ||
      r.workspaceId !== spec.target.workspaceId
    )
      fail("BACKEND_LOAD_SOURCE_INVALID");
    return r;
  }
  const backend = revision<AgentBackendRevision>(
      load.sourceBackendRevisionId,
      "backend",
    ),
    request = revision<BackendRemoteRequest>(
      load.sourceRequestRevisionId,
      "request",
    ),
    connection = revision<BackendConnectionRevision>(
      load.sourceConnectionRevisionId,
      "connection",
    );
  const run = readPrimary(db, "runs", request.owner.runId);
  const header = db
    .prepare("SELECT workspace_id,session_id,state FROM runs WHERE id=?")
    .get(request.owner.runId);
  const oldConfig = {
    ...spec.target.config,
    providerId: backend.spec.target.config.providerId,
  };
  if (
    backend.backendId !== load.sourceBackendId ||
    !backend.enabled ||
    backend.spec.contextOwner !== "engine" ||
    backend.spec.sessionLoad ||
    request.remoteRequestId !== load.sourceRequestId ||
    request.sha256 !== load.sourceRequestSha256 ||
    request.state !== "completed" ||
    connection.connectionId !== load.sourceConnectionId ||
    connection.sha256 !== load.sourceConnectionSha256 ||
    connection.state !== "closed" ||
    connection.disposal?.cleanupConfirmed !== true ||
    request.backendRevisionId !== backend.id ||
    connection.backendRevisionId !== backend.id ||
    request.connectionId !== connection.connectionId ||
    request.epoch !== connection.proof.epoch ||
    request.owner.sha256 !== connection.proof.ownerSha256 ||
    request.remoteSessionId !== load.remoteSessionId ||
    connection.remoteSessionId !== load.remoteSessionId ||
    backend.spec.target.sessionId !== spec.target.sessionId ||
    request.owner.sessionId !== spec.target.sessionId ||
    backend.spec.launch.cwd !== spec.launch.cwd ||
    knowledgeHash(backend.spec.launch) !== knowledgeHash(spec.launch) ||
    knowledgeHash(backend.spec.credentialReference) !==
      knowledgeHash(spec.credentialReference) ||
    backend.spec.endpointAudience !== spec.endpointAudience ||
    knowledgeHash(backend.spec.target.config) !== knowledgeHash(oldConfig) ||
    knowledgeHash(backend.spec.target.profile) !==
      knowledgeHash(spec.target.profile) ||
    backend.spec.target.workspaceBindingSha256 !==
      spec.target.workspaceBindingSha256 ||
    backend.spec.target.catalogueSha256 !== spec.target.catalogueSha256 ||
    knowledgeHash(backend.spec.target.tools) !==
      knowledgeHash(spec.target.tools) ||
    !header ||
    header.state !== "completed" ||
    run.state !== header.state ||
    header.workspace_id !== spec.target.workspaceId ||
    header.session_id !== spec.target.sessionId
  )
    fail("BACKEND_LOAD_SOURCE_INVALID");
  function manifest(value: string | undefined): JsonObject {
    if (typeof value !== "string" || Buffer.byteLength(value) > 32768)
      fail("BACKEND_LOAD_SOURCE_INVALID");
    return json(JSON.parse(value)) as JsonObject;
  }
  const old = manifest(backend.target.capabilitiesManifest),
    current = manifest(target.capabilitiesManifest);
  if (
    knowledgeHash(old) !== backend.spec.target.capabilitiesSha256 ||
    knowledgeHash(current) !== spec.target.capabilitiesSha256 ||
    !Array.isArray(old.providerIds) ||
    !Array.isArray(current.providerIds) ||
    knowledgeHash({ ...current, providerIds: old.providerIds }) !==
      knowledgeHash(old) ||
    knowledgeHash(current.providerIds) !==
      knowledgeHash([...new Set([...old.providerIds, `acp:${spec.id}`])].sort())
  )
    fail("BACKEND_LOAD_SOURCE_INVALID");
  return { backend, request, connection };
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
    load.replayHashes.length > 128 ||
    !Number.isSafeInteger(load.replayBytes) ||
    load.replayBytes < 0 ||
    load.replayBytes > 32768
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
    sha(p[key]);
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
function effectRpc(e: BackendClientEffectRevision): AcpV1Id {
  return (e.executionFrame?.wireId as AcpV1Id) ?? e.rpcId;
}
function validateTerminalOutputSql(
  db: DatabaseSync,
  e: BackendClientEffectRevision,
  control: {
    frame: BackendPeerObservationProof;
    write: BackendWriteProof;
    message: AcpV1Message;
  },
): void {
  const wire = control.frame.message;
  if (!("method" in wire) || wire.method !== "terminal/output") return;
  const message = control.message;
  if (
    !("result" in message) ||
    !message.result ||
    typeof message.result !== "object" ||
    Array.isArray(message.result)
  )
    fail("BACKEND_DELIVERY_INVALID");
  const result = message.result;
  const body = { output: result.output, truncated: result.truncated };
  const completion = e.completion,
    data = completion?.result;
  const noProcess =
    completion?.state === "failed" &&
    completion.effectMethod === "terminal/create" &&
    completion.cleanupConfirmed === true &&
    completion.content === null &&
    completion.checkpoint === null &&
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    data.status === "cancelled" &&
    data.started === false &&
    data.cancelled === true &&
    data.timedOut === false &&
    data.cleanupConfirmed === true &&
    data.exitCode === null &&
    data.signal === null;
  if (noProcess) {
    const jobId = `command-${knowledgeHash({ runId: completion.runId, toolCallId: completion.toolCallId }).slice(0, 32)}`;
    if (
      result.exitStatus !== undefined ||
      readOwnedCommandJob(db, completion.workspaceId, jobId) ||
      db
        .prepare(
          "SELECT 1 FROM checkpoints WHERE run_id=? AND tool_call_id=? LIMIT 1",
        )
        .get(completion.runId, completion.toolCallId) ||
      [
        "command.job.source_admitted",
        "command.job.process_admitted",
        "command.job.closed_observed",
      ].some((type) =>
        nativePayloads(db, e.owner, type).some(
          (value) => value.jobId === jobId,
        ),
      )
    )
      fail("BACKEND_EFFECT_COMPLETION_INVALID");
  }
  if (
    !nativePayloads(db, e.owner, "backend.terminal_output_observed").some(
      (value) =>
        value.providerToolCallId === e.input.callId &&
        knowledgeHash(value.output) === knowledgeHash(body) &&
        (noProcess
          ? value.toolCallId === completion.toolCallId &&
            value.noProcessCompletionSha256 === completion.sha256 &&
            knowledgeHash(body) ===
              knowledgeHash({ output: "", truncated: false })
          : value.noProcessCompletionSha256 === undefined),
    )
  )
    fail("BACKEND_DELIVERY_INVALID");
  if (result.exitStatus !== undefined) {
    const data = e.completion?.result as JsonObject | null;
    if (
      !e.completion ||
      knowledgeHash(result.exitStatus) !==
        knowledgeHash({
          exitCode: data?.exitCode ?? null,
          signal: data?.signal ?? null,
        })
    )
      fail("BACKEND_DELIVERY_INVALID");
  }
}
function validateTerminalControl(
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
    ![
      "terminal/output",
      "terminal/wait_for_exit",
      "terminal/kill",
      "terminal/release",
    ].includes(wire.method) ||
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
  const p = validateAcpV1Request(wire.method, wire.params) as {
    terminalId: string;
    sessionId: string;
  };
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
function validateEffectInput(
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
      (p.outputByteLimit ?? 16384) !== input.outputByteLimit
    )
      fail("BACKEND_EFFECT_INPUT_INVALID");
  }
}
interface SessionEvent {
  readonly header: Record<string, SQLOutputValue>;
  readonly event: { readonly payload?: JsonObject };
}
/** Bounded `session_events` rows of one type matching `where`, read one body at a time. */
function* sessionEvents(
  db: DatabaseSync,
  type: string,
  where: string,
  params: readonly SQLInputValue[],
): Generator<SessionEvent> {
  const headers = db
    .prepare(
      `SELECT session_id,seq,run_id,turn_id,attempt_id,length(CAST(data AS BLOB)) bytes FROM session_events WHERE type=? AND ${where} LIMIT 513`,
    )
    .all(type, ...params);
  if (headers.length > 512) fail("BACKEND_LIMIT");
  for (const header of headers) {
    if (Number(header.bytes) > 65536) fail("BACKEND_LIMIT");
    const raw =
      readBoundedBody(
        db,
        {
          table: "session_events",
          where: "session_id=? AND seq=?",
          params: [header.session_id!, header.seq!],
        },
        Number(header.bytes),
        fail,
      ) ?? fail();
    yield { header, event: JSON.parse(raw) };
  }
}
function ownerEvents(
  db: DatabaseSync,
  owner: BackendTurnProof,
  type: string,
): Generator<SessionEvent> {
  return sessionEvents(
    db,
    type,
    "session_id=? AND run_id=? AND turn_id=? AND attempt_id=?",
    [owner.sessionId, owner.runId, owner.turnId, owner.attemptId],
  );
}
function some<T>(items: Iterable<T>, match: (item: T) => boolean): boolean {
  for (const item of items) if (match(item)) return true;
  return false;
}
function nativePayloads(
  db: DatabaseSync,
  owner: BackendTurnProof,
  type: string,
): JsonObject[] {
  return Array.from(
    ownerEvents(db, owner, type),
    (e) => e.event.payload as JsonObject,
  );
}
function validatePermissionSql(
  db: DatabaseSync,
  e: BackendClientEffectRevision,
  p: BackendClientPermissionProof,
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
  if (
    p.providerToolCallId !== e.input.callId ||
    !nativePayloads(db, e.owner, "backend.client_permission").some(
      (value) => knowledgeHash(value.permission) === knowledgeHash(p),
    )
  )
    fail("BACKEND_PERMISSION_INVALID");
  if (
    !nativePayloads(db, e.owner, "backend.client_effect_proposed").some(
      (value) =>
        value.toolCallId === p.toolCallId &&
        value.providerToolCallId === e.input.callId &&
        knowledgeHash(value.input) === knowledgeHash(e.input),
    )
  )
    fail("BACKEND_PERMISSION_INVALID");
  const tool = readPrimary(db, "tools", p.toolCallId);
  if (
    tool.name !== clientEffectToolName(e.input) ||
    tool.sessionId !== p.sessionId ||
    tool.runId !== p.runId ||
    knowledgeHash(tool.input) !== p.inputSha256
  )
    fail("BACKEND_PERMISSION_INVALID");
  if (p.allowed) {
    if (!p.approvalId || !p.preparedFingerprint)
      fail("BACKEND_PERMISSION_INVALID");
    const approval = readPrimary(db, "approvals", p.approvalId);
    if (
      approval.status !== "allowed" ||
      approval.toolCallId !== p.toolCallId ||
      approval.fingerprint !== p.preparedFingerprint ||
      approval.runId !== p.runId ||
      approval.sessionId !== p.sessionId ||
      approval.toolName !== tool.name
    )
      fail("BACKEND_PERMISSION_INVALID");
  }
}
function validatePermissionResponse(
  e: BackendClientEffectRevision,
  p: BackendClientPermissionProof,
  message: AcpV1Message,
): void {
  if (
    !("id" in message) ||
    message.id !== e.rpcId ||
    !("result" in message) ||
    !message.result ||
    typeof message.result !== "object" ||
    Array.isArray(message.result)
  )
    fail("BACKEND_DELIVERY_INVALID");
  const request = validateAcpV1PermissionParams(
      (e.frame.message as { params: unknown }).params,
    ),
    outcome = message.result.outcome;
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome))
    fail("BACKEND_DELIVERY_INVALID");
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
function validateEffectResponse(
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
        (!message.result ||
          typeof message.result !== "object" ||
          Array.isArray(message.result) ||
          message.result.terminalId !== `terminal:${e.effectId}`)
      )
        fail("BACKEND_DELIVERY_INVALID");
    } else if (!("error" in message)) fail("BACKEND_DELIVERY_INVALID");
  } else if (p.content !== null && p.errorCode === null) {
    if (
      !("result" in message) ||
      !message.result ||
      typeof message.result !== "object" ||
      Array.isArray(message.result) ||
      message.result.content !== p.content
    )
      fail("BACKEND_DELIVERY_INVALID");
  } else if (!("error" in message)) fail("BACKEND_DELIVERY_INVALID");
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
    tool.name !== clientEffectToolName(e.input) ||
    tool.sessionId !== p.sessionId ||
    tool.runId !== p.runId ||
    tool.state !== p.state ||
    knowledgeHash(tool.input) !== p.inputSha256 ||
    sha256Hex(typeof tool.output === "string" ? tool.output : "") !==
      p.outputSha256 ||
    Buffer.byteLength(typeof tool.output === "string" ? tool.output : "") !==
      p.outputBytes
  )
    fail("BACKEND_EFFECT_INVALID");
  const workspace = readPrimary(db, "workspaces", p.workspaceId);
  if (typeof workspace.root !== "string") fail("BACKEND_EFFECT_INPUT_INVALID");
  const toolInput = tool.input as JsonObject;
  if ("method" in e.input) {
    if (
      !nativePayloads(db, e.owner, "backend.client_effect_proposed").some(
        (value) =>
          value.toolCallId === p.toolCallId &&
          value.providerToolCallId === e.input.callId &&
          knowledgeHash(value.input) === knowledgeHash(e.input),
      )
    )
      fail("BACKEND_EFFECT_INPUT_INVALID");
    if (p.effectMethod !== e.input.method) fail("BACKEND_EFFECT_INPUT_INVALID");
    if (e.input.method === "fs/write_text_file") {
      const local = workspaceLocalPath(workspace.root, e.input.path);
      const changes = toolInput.changes;
      if (
        local === undefined ||
        !Array.isArray(changes) ||
        changes.length !== 1 ||
        !changes[0] ||
        typeof changes[0] !== "object" ||
        Array.isArray(changes[0]) ||
        changes[0].path !== local ||
        changes[0].content !== e.input.content
      )
        fail("BACKEND_EFFECT_INPUT_INVALID");
    } else {
      if (
        toolInput.command !==
          terminalCommandLine(e.input.command, e.input.args) ||
        toolInput.cwd !== e.input.cwd
      )
        fail("BACKEND_EFFECT_INPUT_INVALID");
    }
    if (
      clientEffectToolName(e.input) === "run_command" &&
      p.result &&
      typeof p.result === "object" &&
      !Array.isArray(p.result) &&
      p.result.started === true
    ) {
      const job = readOwnedCommandJob(
        db,
        p.workspaceId,
        `command-${knowledgeHash({ runId: p.runId, toolCallId: p.toolCallId }).slice(0, 32)}`,
      );
      if (
        !job?.completion ||
        job.source.toolCallId !== p.toolCallId ||
        job.source.runId !== p.runId ||
        job.completion.checkpoint.id !== p.checkpoint?.id
      )
        fail("BACKEND_EFFECT_CHECKPOINT_INVALID");
      for (const key of [
        "exitCode",
        "signal",
        "cancelled",
        "timedOut",
        "cleanupConfirmed",
        "started",
      ] as const)
        if (
          knowledgeHash(job.completion.outcome[key]) !==
          knowledgeHash(p.result[key])
        )
          fail("BACKEND_EFFECT_COMPLETION_INVALID");
    }
    const completionEvents = nativePayloads(
      db,
      e.owner,
      "backend.client_effect_closed",
    );
    if (
      !completionEvents.some(
        (value) => knowledgeHash(value.completion) === knowledgeHash(p),
      )
    )
      fail("BACKEND_EFFECT_COMPLETION_INVALID");
    const effectMethod = e.input.method;
    if (
      p.state === "completed" ||
      (p.result &&
        typeof p.result === "object" &&
        !Array.isArray(p.result) &&
        p.result.checkpointId)
    ) {
      const checkpoints = db
        .prepare(
          "SELECT id,length(CAST(data AS BLOB)) bytes FROM checkpoints WHERE run_id=? LIMIT 129",
        )
        .all(p.runId);
      if (checkpoints.length > 128) fail("BACKEND_LIMIT");
      const cpId =
        p.checkpoint?.id ??
        (p.result && typeof p.result === "object" && !Array.isArray(p.result)
          ? p.result.checkpointId
          : null);
      if (
        !cpId ||
        !checkpoints.some((h) => {
          const cp = readPrimary(db, "checkpoints", String(h.id), 8388608);
          return (
            cp.id === cpId &&
            cp.runId === p.runId &&
            cp.toolCallId === p.toolCallId &&
            (!p.checkpoint || knowledgeHash(cp) === p.checkpoint.sha256) &&
            cp.kind ===
              (effectMethod === "terminal/create" ? "command" : "patch")
          );
        })
      )
        fail("BACKEND_EFFECT_CHECKPOINT_INVALID");
    }
  } else {
    const localPath = workspaceLocalPath(workspace.root, e.input.path);
    if (
      localPath === undefined ||
      knowledgeHash(tool.input) !==
        knowledgeHash(
          clientReadToolInput(localPath, e.input.line, e.input.limit),
        )
    )
      fail("BACKEND_EFFECT_INPUT_INVALID");
  }
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
        part.name === clientEffectToolName(e.input) &&
        ["completed", "failed", "interrupted"].includes(String(part.state))
      );
    })
  )
    fail("BACKEND_EFFECT_PART_INVALID");
  if (p.preparedFingerprint !== null) {
    if (
      !some(
        ownerEvents(db, e.owner, "tool.prepared"),
        ({ event }) =>
          event.payload?.toolCallId === p.toolCallId &&
          event.payload?.providerToolCallId === p.providerToolCallId &&
          event.payload?.toolName === clientEffectToolName(e.input) &&
          event.payload?.inputSha256 === p.inputSha256 &&
          event.payload?.preparedFingerprint === p.preparedFingerprint,
      )
    )
      fail("BACKEND_EFFECT_FINGERPRINT_INVALID");
    const approvals = db
      .prepare("SELECT id FROM approvals WHERE tool_call_id=? LIMIT 17")
      .all(p.toolCallId);
    if (approvals.length > 16) fail("BACKEND_LIMIT");
    if (
      (approvals.length || "method" in e.input) &&
      !approvals.some((a) => {
        const approval = readPrimary(db, "approvals", String(a.id));
        return (
          approval.status === "allowed" &&
          approval.toolCallId === p.toolCallId &&
          approval.fingerprint === p.preparedFingerprint &&
          approval.sessionId === p.sessionId &&
          approval.runId === p.runId &&
          approval.toolName === clientEffectToolName(e.input)
        );
      }) &&
      (p.state === "completed" ||
        ("method" in e.input &&
          p.checkpoint !== undefined &&
          p.checkpoint !== null))
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
    if (r.cancellation) {
      const cancel = validateAcpV1Message(r.cancellation.message);
      digest(r.cancellation.write);
      if (
        !("method" in cancel) ||
        "id" in cancel ||
        cancel.method !== "session/cancel" ||
        (
          validateAcpV1Request(cancel.method, cancel.params) as {
            sessionId: string;
          }
        ).sessionId !== r.remoteSessionId ||
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
      if (r.controls.length > 32) fail();
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
function validateOwnerSql(db: DatabaseSync, r: AgentBackendRecord): void {
  if (r.kind === "backend") {
    const s = readPrimary(db, "sessions", r.spec.target.sessionId);
    if (s.workspaceId !== r.workspaceId) fail();
    validateSessionLoadSourceSql(db, r.spec, r.target);
    return;
  }
  if (r.kind === "connection") {
    const anchor = some(
      sessionEvents(
        db,
        "backend.launch_reserved",
        "json_extract(data,'$.payload.ownerSha256')=? AND json_extract(data,'$.payload.launchSha256')=?",
        [r.proof.ownerSha256, r.proof.launchSha256],
      ),
      ({ header, event }) =>
        event.payload?.backendId === r.backendId &&
        event.payload?.backendRevisionId === r.backendRevisionId &&
        event.payload?.ownerSha256 === r.proof.ownerSha256 &&
        event.payload?.launchSha256 === r.proof.launchSha256 &&
        event.payload?.turnId === header.turn_id &&
        event.payload?.attemptId === header.attempt_id,
    );
    if (!anchor) fail("BACKEND_CONNECTION_OWNER_INVALID");
    const hasAdmission = some(
      sessionEvents(
        db,
        "backend.connection_admitted",
        "json_extract(data,'$.payload.connectionId')=? AND json_extract(data,'$.payload.ownerSha256')=?",
        [r.connectionId, r.proof.ownerSha256],
      ),
      ({ event: { payload: p } }) =>
        !!p &&
        p.connectionId === r.connectionId &&
        p.epoch === r.proof.epoch &&
        p.processId === r.proof.processId &&
        p.birthNonce === r.proof.birthNonce &&
        p.ownerSha256 === r.proof.ownerSha256 &&
        p.backendRevisionId === r.backendRevisionId &&
        p.backendId === r.backendId &&
        p.backendSha256 === r.backendSha256 &&
        p.launchSha256 === r.proof.launchSha256 &&
        knowledgeHash(p.clientCapabilities ?? null) ===
          knowledgeHash(r.proof.clientCapabilities ?? null) &&
        (p.executionMode ?? null) === (r.proof.executionMode ?? null),
    );
    if (!hasAdmission) fail("BACKEND_CONNECTION_OWNER_INVALID");
  }
  if (r.kind === "request" || r.kind === "client-effect") {
    validateTurnSql(db, r.owner);
    if (r.kind === "client-effect") {
      if (r.permission) validatePermissionSql(db, r, r.permission);
      if (r.completion) validateClientEffectSql(db, r, r.completion);
    }
  }
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
export function validateAgentBackendDatabase(
  db: DatabaseSync,
  options: { check?: () => void } = {},
): void {
  const journal = backendJournal(db),
    graph = journal.scan(options.check),
    records = graph.records;
  for (const r of records.values()) {
    const t = journal.receiptOf(r, graph);
    if (r.kind === "client-effect" && r.controls)
      for (const control of r.controls)
        validateTerminalOutputSql(db, r, control);
    if (
      t.operation === "bind-effect" &&
      r.kind === "client-effect" &&
      (!r.executionFrame ||
        r.executionFrame.frameSha256 !==
          knowledgeHash(r.executionFrame.message))
    )
      fail();
    if (t.operation === "effect-ack" && r.kind === "client-effect") {
      const message = validateAcpV1Message(t.requestInput.message);
      if (
        !("method" in r.input) ||
        r.input.method !== "terminal/create" ||
        !r.delivery ||
        !nativePayloads(db, r.owner, "backend.client_effect_dispatched").some(
          (value) => value.providerToolCallId === r.input.callId,
        ) ||
        !("result" in message) ||
        !message.result ||
        typeof message.result !== "object" ||
        Array.isArray(message.result) ||
        message.result.terminalId !== `terminal:${r.effectId}` ||
        r.delivery.frameSha256 !== knowledgeHash(message)
      )
        fail();
    }
    if (t.operation === "delivery" && r.kind === "client-effect") {
      const message = validateAcpV1Message(t.requestInput.message);
      if (
        !("id" in message) ||
        message.id !== effectRpc(r) ||
        r.delivery?.frameSha256 !== knowledgeHash(message)
      )
        fail();
      validateEffectResponse(r, message);
    }
    if (t.operation === "permission" && r.kind === "client-effect") {
      if (!r.permission || !r.permissionDelivery) fail();
      const message = validateAcpV1Message(t.requestInput.message);
      validatePermissionSql(db, r, r.permission);
      validatePermissionResponse(r, r.permission, message);
      if (r.permissionDelivery.frameSha256 !== knowledgeHash(message)) fail();
    }
    const before = journal.previousOf(r, graph);
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
      if (b.spec.sessionLoad) {
        if (
          r.capabilities &&
          (r.capabilities.contextOwner !== "agent" ||
            !r.capabilities.loadSession)
        )
          fail("ACP_LOAD_UNSUPPORTED");
        if (r.sessionLoad) {
          const m = r.sessionLoad.message;
          if (
            !("method" in m) ||
            m.params?.sessionId !== b.spec.sessionLoad.remoteSessionId ||
            m.params?.cwd !== b.spec.launch.cwd
          )
            fail("BACKEND_LOAD_SOURCE_INVALID");
        }
        if (
          r.remoteSessionId !== null &&
          (r.sessionLoad?.state !== "loaded" ||
            r.remoteSessionId !== b.spec.sessionLoad.remoteSessionId)
        )
          fail("BACKEND_REMOTE_SESSION_INVALID");
      } else if (
        r.sessionLoad ||
        (r.capabilities && r.capabilities.contextOwner !== "engine")
      )
        fail("BACKEND_LOAD_SOURCE_INVALID");
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
  }
  journal.assertHeads(graph);
}
function appendAdministrative(
  journal: BackendJournal,
  before: AgentBackendRecord,
  operation: "recover" | "pause-import",
  at: string,
  archiveSha?: string,
): void {
  const input = {
    workspaceId: before.workspaceId,
    requestId:
      operation === "recover"
        ? `recover:${before.id}`
        : `import:${archiveSha}:${before.id}`,
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
  journal.append({
    kind: before.kind,
    before,
    expectedRevision: before.revision,
    build: (revisionId, receiptId) =>
      prepareSignedBackendRevision({
        kind: before.kind,
        entityId: before.entityId,
        workspaceId: before.workspaceId,
        before,
        body: body as Omit<AgentBackendRecord, keyof BackendRevisionBase>,
        requestInput: input,
        revisionId,
        receiptId,
        operation,
        createdAt: at,
      }),
  });
}
export function recoverAgentBackends(
  db: DatabaseSync,
  at = backendClock(db, Date.now()),
): number {
  validateAgentBackendDatabase(db);
  const journal = backendJournal(db),
    records = journal.current().filter((r) => recoverable(r.kind, state(r)));
  for (const r of records) appendAdministrative(journal, r, "recover", at);
  return records.length;
}
export function markImportedAgentBackendsPaused(
  db: DatabaseSync,
  archiveSha: string,
  workspaceId?: string,
): void {
  sha(archiveSha);
  validateAgentBackendDatabase(db);
  const at = backendClock(db, Date.now()),
    journal = backendJournal(db);
  for (const r of journal.current(workspaceId))
    if (pausable(r.kind, state(r)))
      appendAdministrative(journal, r, "pause-import", at, archiveSha);
}
export function hasAgentBackendBlocker(
  db: DatabaseSync,
  workspaceId: string,
): boolean {
  return backendJournal(db)
    .current(workspaceId)
    .some(
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
