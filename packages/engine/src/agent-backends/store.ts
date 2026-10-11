import type { DatabaseSync } from "node:sqlite";
import {
  EngineError,
  type JsonObject,
  type Workspace,
} from "@moodcode/contracts";
import {
  immutableKnowledgeJson as json,
  knowledgeHash,
} from "../knowledge/validation.js";
import type { TurnRequest } from "../ports.js";
import type {
  AgentBackendSpec,
  AgentBackendSpecInput,
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
  BackendClientEffectInput,
  BackendClientPermissionProof,
} from "./client-effects.js";
import {
  SETTLED_REQUEST_STATES,
  type BackendJournalKind,
  type BackendRequestState,
} from "./reducer.js";
import {
  agentBackendSigned as signed,
  validateAgentBackendSpec,
} from "./validation.js";
import {
  validateAcpV1Message,
  encodeAcpV1Message,
  validateAcpV1Result,
  negotiateAcpV1Capabilities,
  validateAcpV1Request,
} from "./protocol.js";
import {
  AGENT_BACKEND_STORAGE_LIMITS,
  fail,
  prepareSignedBackendRevision,
  isObject,
  resultObject,
  isStopReason,
  digest,
  id,
  integer,
  fields,
  state,
  recoverable,
  pausable,
  bodyOf,
  effectRpc,
  validateTerminalControl,
  validateEffectInput,
  validatePermissionResponse,
  validateEffectResponse,
  type BackendTurnProof,
  type BackendTargetProof,
  type BackendRevisionBase,
  type AgentBackendRevision,
  type BackendConnectionRevision,
  type BackendRemoteRequest,
  type BackendClientEffectRevision,
  type AgentBackendRecord,
  type BackendTransitionReceipt,
  type BackendMutationInput,
} from "./journal.js";
import {
  backendClock,
  backendJournal,
  validateSessionLoadSourceSql,
  validateTurnSql,
  validateTerminalOutputSql,
  nativePayloads,
  validatePermissionSql,
  validateClientEffectSql,
  recoverAgentBackends,
  type BackendJournal,
} from "./store-evidence.js";
export type {
  BackendTurnProof,
  BackendTargetProof,
  AgentBackendRevision,
  BackendConnectionRevision,
  BackendSessionLoadRevision,
  BackendRemoteRequest,
  BackendClientEffectRevision,
  AgentBackendRecord,
  BackendTransitionReceipt,
  BackendMutationInput,
} from "./journal.js";
export { AGENT_BACKEND_STORAGE_LIMITS } from "./journal.js";
export {
  validateAgentBackendDatabase,
  recoverAgentBackends,
  markImportedAgentBackendsPaused,
  hasAgentBackendBlocker,
} from "./store-evidence.js";
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
export interface PrepareBackendSessionLoadInput extends BackendMutationInput {
  readonly connectionId: string;
  readonly message: AcpV1Message;
}
type RecordOf<K extends BackendJournalKind> = Extract<
  AgentBackendRecord,
  { kind: K }
>;
export interface BackendRequestResult<T extends AgentBackendRecord> {
  readonly record: T;
  readonly receipt: BackendTransitionReceipt;
  readonly duplicate: boolean;
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
function sync(value: unknown): void {
  if (value !== undefined) {
    void Promise.resolve(value).catch(() => {});
    fail("BACKEND_ORIGINAL_REQUIRED");
  }
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
  private head<K extends BackendJournalKind>(
    ws: string,
    kind: K,
    eid: string,
  ): RecordOf<K> {
    const record = this.journal.head<RecordOf<K>>(ws, kind, eid);
    if (!record) fail("BACKEND_NOT_FOUND");
    return record;
  }
  /** Checks input before the transaction; inside it an identical earlier request replays before `run` reads anything. */
  private mutate<K extends BackendJournalKind, I extends BackendMutationInput>(
    kind: K,
    op: string,
    raw: I,
    extra: readonly string[],
    entityOf: (x: I) => string,
    run: (
      x: I,
      commit: (
        before: RecordOf<K> | undefined,
        body: Omit<RecordOf<K>, keyof BackendRevisionBase>,
      ) => BackendRequestResult<RecordOf<K>>,
    ) => BackendRequestResult<RecordOf<K>>,
  ): BackendRequestResult<RecordOf<K>> {
    const x = this.input(raw, extra),
      eid = entityOf(x);
    return this.ports.writeTx(
      () =>
        this.duplicate<RecordOf<K>>(x.workspaceId, kind, eid, op, x) ??
        run(x, (before, body) => this.append(kind, eid, op, x, before, body)),
    );
  }
  registerBackend(
    originalTarget: object,
    input: RegisterAgentBackendInput,
  ): BackendRequestResult<AgentBackendRevision> {
    let spec!: AgentBackendSpec;
    return this.mutate(
      "backend",
      "register",
      input,
      ["spec"],
      (x) => (spec = validateAgentBackendSpec(x.spec)).id,
      (x, commit) => {
        const ws = x.workspaceId,
          eid = spec.id;
        this.ports.getWorkspace(ws);
        const proof = digest(this.ports.readTarget(originalTarget));
        if (
          proof.workspaceId !== ws ||
          proof.backendId !== eid ||
          knowledgeHash(proof.target) !== knowledgeHash(spec.target)
        )
          fail("BACKEND_TARGET_STALE");
        sync(this.ports.assertTargetCurrent(originalTarget, proof, spec));
        return commit(this.getBackend(ws, eid), {
          backendId: eid,
          enabled: true,
          spec,
          target: proof,
        });
      },
    );
  }
  disableBackend(
    input: DisableAgentBackendInput,
  ): BackendRequestResult<AgentBackendRevision> {
    return this.mutate(
      "backend",
      "disable",
      input,
      ["backendId"],
      (x) => x.backendId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "backend", x.backendId);
        return commit(before, {
          backendId: before.backendId,
          enabled: false,
          spec: before.spec,
          target: before.target,
        });
      },
    );
  }
  openConnection(
    originalProcess: object,
    input: OpenBackendConnectionInput,
  ): BackendRequestResult<BackendConnectionRevision> {
    return this.mutate(
      "connection",
      "open",
      input,
      ["backendId", "connectionId"],
      (x) => x.connectionId,
      (x, commit) => {
        const b = this.head(x.workspaceId, "backend", x.backendId);
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
        return commit(this.getConnection(x.workspaceId, x.connectionId), {
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
        });
      },
    );
  }
  recordPeerObservation(
    originalFrame: object,
    input: ObserveBackendConnectionInput,
  ): BackendRequestResult<BackendConnectionRevision> {
    return this.mutate(
      "connection",
      "observe",
      input,
      ["connectionId", "state", "remoteSessionId"],
      (x) => x.connectionId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "connection", x.connectionId),
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
          if (
            hashes.length > AGENT_BACKEND_STORAGE_LIMITS.replayFrames ||
            bytes > AGENT_BACKEND_STORAGE_LIMITS.replayBytes
          )
            fail("BACKEND_LOAD_REPLAY_LIMIT");
          return commit(before, {
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
          resultObject(p.message)?.protocolVersion !== 1
        )
          fail("ACP_VERSION_UNSUPPORTED");
        if (
          x.state === "session-ready" &&
          resultObject(p.message)?.sessionId !== x.remoteSessionId
        )
          fail("BACKEND_REMOTE_SESSION_INVALID");
        if (
          (next !== "session-ready" && x.remoteSessionId !== null) ||
          (before.remoteSessionId !== null &&
            x.remoteSessionId !== before.remoteSessionId)
        )
          fail("BACKEND_REMOTE_SESSION_INVALID");
        return commit(before, {
          ...bodyOf(before),
          state: next,
          receiveOrdinal: p.receiveOrdinal,
          remoteSessionId: x.remoteSessionId,
          observation: p,
        });
      },
    );
  }
  prepareSessionLoad(
    originalTurn: object,
    input: PrepareBackendSessionLoadInput,
  ): BackendRequestResult<BackendConnectionRevision> {
    return this.mutate(
      "connection",
      "load-intent",
      input,
      ["connectionId", "message"],
      (x) => x.connectionId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "connection", x.connectionId);
        const b = this.head(x.workspaceId, "backend", before.backendId);
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
        return commit(before, {
          ...bodyOf(before),
          sessionLoad: {
            state: "dispatching",
            message,
            write: null,
            response: null,
            replayHashes: [],
            replayBytes: 0,
          },
        });
      },
    );
  }
  recordLoadedSession(
    originalFrame: object,
    originalWrite: object,
    input: DisposeBackendConnectionInput,
  ): BackendRequestResult<BackendConnectionRevision> {
    return this.mutate(
      "connection",
      "load-ready",
      input,
      ["connectionId"],
      (x) => x.connectionId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "connection", x.connectionId);
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
        return commit(before, {
          ...bodyOf(before),
          state: "session-ready",
          remoteSessionId: (load.message as { params: JsonObject }).params
            .sessionId as string,
          receiveOrdinal: frame.receiveOrdinal,
          writeOrdinal: write.writeOrdinal,
          observation: frame,
          sessionLoad: { ...load, state: "loaded", write, response: frame },
        });
      },
    );
  }
  prepareRequest(
    originalTurn: object,
    originalConnection: object,
    input: PrepareBackendRequestInput,
  ): BackendRequestResult<BackendRemoteRequest> {
    return this.mutate(
      "request",
      "prepare",
      input,
      [
        "remoteRequestId",
        "connectionId",
        "rpcId",
        "remoteSessionId",
        "message",
      ],
      (x) => x.remoteRequestId,
      (x, commit) => {
        const c = this.head(x.workspaceId, "connection", x.connectionId);
        const b = this.head(x.workspaceId, "backend", c.backendId);
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
        return commit(this.getRequest(x.workspaceId, x.remoteRequestId), {
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
        });
      },
    );
  }
  dispatchRequest(
    originalTurn: object,
    input: MutateBackendRequestInput,
  ): BackendRequestResult<BackendRemoteRequest> {
    return this.mutate(
      "request",
      "dispatch-intent",
      input,
      ["remoteRequestId"],
      (x) => x.remoteRequestId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "request", x.remoteRequestId),
          p = this.owner(originalTurn);
        if (p.sha256 !== before.owner.sha256) fail("BACKEND_OWNER_INVALID");
        this.liveConnection(before);
        return commit(before, { ...bodyOf(before), state: "dispatching" });
      },
    );
  }
  markRequestDispatched(
    originalWrite: object,
    input: MutateBackendRequestInput,
  ): BackendRequestResult<BackendRemoteRequest> {
    return this.mutate(
      "request",
      "dispatch",
      input,
      ["remoteRequestId"],
      (x) => x.remoteRequestId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "request", x.remoteRequestId),
          p = digest(this.ports.readWrite(originalWrite));
        this.writeMatches(p, before, x.workspaceId, before.wireSha256);
        return commit(before, {
          ...bodyOf(before),
          state: "dispatched",
          dispatch: p,
        });
      },
    );
  }
  negotiateCapabilities(
    originalTurn: object,
    originalFrame: object,
    input: DisposeBackendConnectionInput,
  ): BackendRequestResult<BackendConnectionRevision> {
    return this.mutate(
      "connection",
      "negotiate",
      input,
      ["connectionId"],
      (x) => x.connectionId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "connection", x.connectionId);
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
        const b = this.head(x.workspaceId, "backend", before.backendId);
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
        return commit(before, { ...bodyOf(before), capabilities });
      },
    );
  }
  recordRequestCancel(
    originalWrite: object,
    input: MutateBackendRequestInput & { message: AcpV1Message },
  ): BackendRequestResult<BackendRemoteRequest> {
    return this.mutate(
      "request",
      "cancel-wire",
      input,
      ["remoteRequestId", "message"],
      (x) => x.remoteRequestId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "request", x.remoteRequestId);
        if (
          before.cancellation ||
          before.state === "paused-import" ||
          SETTLED_REQUEST_STATES.includes(before.state)
        )
          fail("BACKEND_REQUEST_STALE");
        const message = validateAcpV1Message(x.message);
        if (
          !("method" in message) ||
          message.method !== "session/cancel" ||
          validateAcpV1Request("session/cancel", message.params).sessionId !==
            before.remoteSessionId
        )
          fail("BACKEND_REMOTE_SESSION_INVALID");
        const write = digest(this.ports.readWrite(originalWrite));
        this.writeMatches(write, before, x.workspaceId, knowledgeHash(message));
        return commit(before, {
          ...bodyOf(before),
          cancellation: { message, write },
        });
      },
    );
  }
  prepareClientRead(
    originalTurn: object,
    originalFrame: object,
    input: PrepareBackendClientReadInput,
  ): BackendRequestResult<BackendClientEffectRevision> {
    return this.mutate(
      "client-effect",
      "prepare-read",
      input,
      ["effectId", "remoteRequestId", "input"],
      (x) => x.effectId,
      (x, commit) => {
        const r = this.head(x.workspaceId, "request", x.remoteRequestId);
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
        for (const old of this.effectsOnConnection(r))
          if (
            old.epoch === r.epoch &&
            (old.rpcId === frame.message.id ||
              old.executionFrame?.wireId === frame.message.id)
          )
            fail("BACKEND_EFFECT_ALREADY_BOUND");
        return commit(this.getClientEffect(x.workspaceId, x.effectId), {
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
        });
      },
    );
  }
  settleClientRead(
    originalCompletion: object,
    input: MutateBackendClientEffectInput,
  ): BackendRequestResult<BackendClientEffectRevision> {
    return this.mutate(
      "client-effect",
      "settle-read",
      input,
      ["effectId"],
      (x) => x.effectId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "client-effect", x.effectId),
          p = digest(this.ports.readClientEffect(originalCompletion));
        validateClientEffectSql(this.db, before, p);
        return commit(before, {
          ...bodyOf(before),
          state: p.state,
          completion: p,
          errorCode: p.errorCode,
          ...(before.permission?.allowed === false
            ? { delivery: before.permissionDelivery }
            : {}),
        });
      },
    );
  }
  bindApprovedClientEffect(
    originalTurn: object,
    originalFrame: object,
    input: MutateBackendClientEffectInput & { input: BackendClientEffectInput },
  ): BackendRequestResult<BackendClientEffectRevision> {
    return this.mutate(
      "client-effect",
      "bind-effect",
      input,
      ["effectId", "input"],
      (x) => x.effectId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "client-effect", x.effectId);
        if (
          before.state !== "prepared" ||
          !before.permission?.allowed ||
          !before.permissionDelivery ||
          before.executionFrame
        )
          fail("BACKEND_EFFECT_STALE");
        const owner = this.owner(originalTurn);
        if (owner.sha256 !== before.owner.sha256) fail("BACKEND_OWNER_INVALID");
        const request = this.head(
            x.workspaceId,
            "request",
            before.remoteRequestId,
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
        for (const other of this.effectsOnConnection(before))
          if (
            other.effectId !== before.effectId &&
            other.epoch === before.epoch &&
            (other.rpcId === frame.wireId ||
              other.executionFrame?.wireId === frame.wireId)
          )
            fail("BACKEND_EFFECT_ALREADY_BOUND");
        return commit(before, { ...bodyOf(before), executionFrame: frame });
      },
    );
  }
  recordTerminalControl(
    originalTurn: object,
    originalFrame: object,
    originalWrite: object,
    input: DeliverBackendClientEffectInput,
  ): BackendRequestResult<BackendClientEffectRevision> {
    return this.mutate(
      "client-effect",
      "terminal-control",
      input,
      ["effectId", "message"],
      (x) => x.effectId,
      (x, commit) => {
        const { before, body } = this.terminalControl(
          originalTurn,
          originalFrame,
          originalWrite,
          x,
        );
        return terminalCapacity(() => commit(before, body));
      },
    );
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
    const before = this.head(x.workspaceId, "client-effect", x.effectId);
    if (
      !("method" in before.input) ||
      before.input.method !== "terminal/create" ||
      (before.completion && !before.completion.cleanupConfirmed)
    )
      fail("BACKEND_TERMINAL_STALE");
    if (
      (before.controls?.length ?? 0) >=
      AGENT_BACKEND_STORAGE_LIMITS.terminalControls
    )
      fail("BACKEND_LIMIT");
    if (this.owner(originalTurn).sha256 !== before.owner.sha256)
      fail("BACKEND_OWNER_INVALID");
    const parent = this.head(x.workspaceId, "request", before.remoteRequestId),
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
    this.writeMatches(write, before, x.workspaceId, knowledgeHash(x.message));
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
    return this.mutate(
      "client-effect",
      "uncertain",
      input,
      ["effectId", "errorCode"],
      (x) => x.effectId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "client-effect", x.effectId);
        return commit(before, {
          ...bodyOf(before),
          state: "uncertain",
          errorCode: id(x.errorCode),
        });
      },
    );
  }
  recordClientPermission(
    originalPermission: object,
    originalWrite: object,
    input: MutateBackendClientEffectInput & { message: AcpV1Message },
  ): BackendRequestResult<BackendClientEffectRevision> {
    return this.mutate(
      "client-effect",
      "permission",
      input,
      ["effectId", "message"],
      (x) => x.effectId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "client-effect", x.effectId);
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
          before,
          x.workspaceId,
          knowledgeHash(x.message),
        );
        validatePermissionResponse(before, permission, x.message);
        return commit(before, {
          ...bodyOf(before),
          permission,
          permissionDelivery: write,
        });
      },
    );
  }
  recordClientAcknowledgement(
    originalWrite: object,
    input: DeliverBackendClientEffectInput,
  ): BackendRequestResult<BackendClientEffectRevision> {
    return this.mutate(
      "client-effect",
      "effect-ack",
      input,
      ["effectId", "message"],
      (x) => x.effectId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "client-effect", x.effectId);
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
          resultObject(message)?.terminalId !== `terminal:${before.effectId}`
        )
          fail("BACKEND_DELIVERY_INVALID");
        const write = digest(this.ports.readWrite(originalWrite));
        this.writeMatches(write, before, x.workspaceId, knowledgeHash(message));
        return commit(before, { ...bodyOf(before), delivery: write });
      },
    );
  }
  recordClientDelivery(
    originalWrite: object,
    input: DeliverBackendClientEffectInput,
  ): BackendRequestResult<BackendClientEffectRevision> {
    return this.mutate(
      "client-effect",
      "delivery",
      input,
      ["effectId", "message"],
      (x) => x.effectId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "client-effect", x.effectId);
        if (before.state === "prepared" || before.delivery)
          fail("BACKEND_EFFECT_STALE");
        const p = digest(this.ports.readWrite(originalWrite));
        this.writeMatches(p, before, x.workspaceId, knowledgeHash(x.message));
        if (!("id" in x.message) || x.message.id !== effectRpc(before))
          fail("BACKEND_DELIVERY_INVALID");
        validateEffectResponse(before, x.message);
        return commit(before, { ...bodyOf(before), delivery: p });
      },
    );
  }
  settleRequest(
    originalFrame: object,
    input: MutateBackendRequestInput,
  ): BackendRequestResult<BackendRemoteRequest> {
    return this.mutate(
      "request",
      "settle",
      input,
      ["remoteRequestId"],
      (x) => x.remoteRequestId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "request", x.remoteRequestId),
          c = this.head(x.workspaceId, "connection", before.connectionId),
          p = this.frame(originalFrame, c);
        if (c.observation?.sha256 !== p.sha256 || p.wireId !== before.rpcId)
          fail("BACKEND_REQUEST_STALE");
        let next: BackendRequestState = "failed";
        if ("result" in p.message) {
          const result = p.message.result;
          if (!isObject(result) || !isStopReason(result.stopReason))
            fail("BACKEND_TERMINAL_INVALID");
          next = result.stopReason === "cancelled" ? "cancelled" : "completed";
        } else if (!("error" in p.message)) fail("BACKEND_TERMINAL_INVALID");
        if (c.disposal?.cleanupConfirmed !== true) fail("CLEANUP_UNCERTAIN");
        if (
          this.effectsOnConnection(before).some(
            (e) =>
              e.remoteRequestId === before.remoteRequestId &&
              (e.state === "prepared" || e.delivery === null),
          )
        )
          fail("BACKEND_EFFECT_UNSETTLED");
        return commit(before, {
          ...bodyOf(before),
          state: next,
          terminal: p,
          errorCode: next === "failed" ? "ACP_REMOTE_ERROR" : null,
        });
      },
    );
  }
  disposeConnection(
    originalDisposal: object,
    input: DisposeBackendConnectionInput,
  ): BackendRequestResult<BackendConnectionRevision> {
    return this.mutate(
      "connection",
      "dispose",
      input,
      ["connectionId"],
      (x) => x.connectionId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "connection", x.connectionId),
          p = digest(this.ports.readDisposal(originalDisposal));
        if (
          p.workspaceId !== x.workspaceId ||
          p.connectionId !== before.connectionId ||
          p.epoch !== before.proof.epoch ||
          p.processId !== before.proof.processId
        )
          fail("BACKEND_DISPOSAL_INVALID");
        return commit(before, {
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
      },
    );
  }
  markRequestUncertain(
    input: MutateBackendRequestInput & { readonly errorCode: string },
  ): BackendRequestResult<BackendRemoteRequest> {
    return this.mutate(
      "request",
      "uncertain",
      input,
      ["remoteRequestId", "errorCode"],
      (x) => x.remoteRequestId,
      (x, commit) => {
        const before = this.head(x.workspaceId, "request", x.remoteRequestId);
        return commit(before, {
          ...bodyOf(before),
          state: "uncertain",
          errorCode: id(x.errorCode),
        });
      },
    );
  }
  private effectsOnConnection(on: {
    readonly workspaceId: string;
    readonly connectionId: string;
  }): BackendClientEffectRevision[] {
    const max = AGENT_BACKEND_STORAGE_LIMITS.effects,
      ids = this.db
        .prepare(
          "SELECT h.entity_id FROM backend_heads h JOIN backend_revisions r ON r.id=h.revision_id WHERE h.workspace_id=? AND h.kind='client-effect' AND r.connection_id=? ORDER BY h.entity_id LIMIT ?",
        )
        .all(on.workspaceId, on.connectionId, max + 1);
    if (ids.length > max) fail("BACKEND_LIMIT");
    return ids.map((h) =>
      this.getClientEffect(on.workspaceId, String(h.entity_id))!,
    );
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
    const c = this.head(r.workspaceId, "connection", r.connectionId);
    const b = this.head(r.workspaceId, "backend", c.backendId);
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
    on: { readonly connectionId: string; readonly epoch: string },
    ws: string,
    frameSha?: string,
  ): void {
    if (
      p.workspaceId !== ws ||
      p.connectionId !== on.connectionId ||
      p.epoch !== on.epoch ||
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
