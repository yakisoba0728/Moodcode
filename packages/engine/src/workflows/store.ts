import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { JsonObject, Workspace } from "@moodcode/contracts";
import type { WorkflowSpec, WorkflowSpecInput } from "./types.js";
import {
  knowledgeHash,
  immutableKnowledgeJson,
} from "../knowledge/validation.js";
import {
  childStorageKind,
  validateChildStorageRecord,
} from "../child-tasks/storage-binding.js";
import {
  validateWorkflowSpec,
  validateWorkflowValue,
  validateWorkflowStageResult,
  workflowError,
  workflowIdentifier,
  workflowInteger,
  workflowObject,
  workflowSha,
  validateNewWorkflowWorktreeSharing,
  validateWorkflowWorktreeSharing,
} from "./spec.js";
import {
  initialWorkflowStages,
  reduceWorkflow,
  type WorkflowStageState,
  type WorkflowTransitionEvent,
} from "./reducer.js";
import type {
  WorkflowChildAdmissionProof,
  WorkflowChildCompletionProof,
  WorkflowInstanceRevision,
  WorkflowOwnerProof,
  WorkflowWorktreePin,
} from "./reducer.js";
export type {
  WorkflowChildAdmissionProof,
  WorkflowChildCompletionProof,
  WorkflowInstanceRevision,
  WorkflowOwnerProof,
  WorkflowWorktreePin,
} from "./reducer.js";
export interface WorkflowSpecRevision {
  readonly id: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly revision: number;
  readonly previousId: string | null;
  readonly spec: WorkflowSpec;
  readonly createdAt: string;
  readonly lastReceiptId: string;
  readonly sha256: string;
}
export interface WorkflowTransitionReceipt {
  readonly id: string;
  readonly workspaceId: string;
  readonly instanceId: string | null;
  readonly workflowId: string;
  readonly operation:
    | "register"
    | "create"
    | "prepare"
    | "admit"
    | "settle"
    | "cancel"
    | "fail"
    | "uncertain"
    | "pause-import";
  readonly stageId: string | null;
  readonly beforeRevisionId: string | null;
  readonly afterRevisionId: string;
  readonly afterSha256: string;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly requestInput: JsonObject;
  readonly ownerSha256: string | null;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface WorkflowRequestResult<T> {
  readonly record: T;
  readonly receipt: WorkflowTransitionReceipt;
  readonly duplicate: boolean;
}
export interface RegisterWorkflowInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly spec: WorkflowSpecInput;
}
export interface CreateWorkflowInstanceInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly workflowId: string;
  readonly expectedSpecRevision: number;
  readonly parameters: JsonObject;
  readonly worktrees: Readonly<Record<string, string>>;
  readonly ownerSha256: string;
}
export interface WorkflowStageMutationInput {
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly stageId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
}
export interface PrepareWorkflowStageInput extends WorkflowStageMutationInput {
  readonly childRequestId: string;
  readonly prompt: string;
}
export interface WorkflowControlInput {
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly operation: "cancel" | "uncertain" | "fail";
}
export interface WorkflowStoragePorts {
  writeTx<T>(operation: () => T): T;
  getWorkspace(workspaceId: string): Workspace;
  readOwner(original: object): WorkflowOwnerProof;
  assertOwnerCurrent(original: object, expected: WorkflowOwnerProof): void;
  assertOwnerSettling(original: object, expected: WorkflowOwnerProof): void;
  readWorktree(originalOwner: object, worktreeId: string): WorkflowWorktreePin;
  assertWorktreeCurrent(
    originalOwner: object,
    expected: WorkflowWorktreePin,
  ): void;
  readChildAdmission(original: object): WorkflowChildAdmissionProof;
  readChildCompletion(original: object): WorkflowChildCompletionProof;
  readonly now?: () => number;
}

export const WORKFLOW_STORAGE_LIMITS = Object.freeze({
  rowBytes: 131072,
  parametersBytes: 32768,
  resultBytes: 4096,
  instances: 32,
  specifications: 32,
  rows: 4096,
  bytes: 16777216,
});
/** Upper bound of a receipt plus the fields forcePause changes in an instance or stage revision. */
const FORCE_PAUSE_ROW_BYTES = 4096;
type Kind = "spec" | "instance" | "stage" | "transition";
interface StageRevision {
  id: string;
  workspaceId: string;
  instanceId: string;
  workflowId: string;
  owner: WorkflowOwnerProof;
  revision: number;
  previousId: string | null;
  stage: WorkflowStageState;
  createdAt: string;
  sha256: string;
}
type RecordBody =
  | WorkflowSpecRevision
  | WorkflowInstanceRevision
  | StageRevision
  | WorkflowTransitionReceipt;
interface NativeRow {
  id: string;
  workspace_id: string;
  kind: Kind;
  entity_id: string;
  revision: number;
  previous_id: string | null;
  root_session_id: string | null;
  root_run_id: string | null;
  owner_sha256: string | null;
  request_scope: string;
  request_id: string;
  request_sha256: string;
  sha256: string;
  data: string;
  bytes: number;
}
const rawHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function json<T>(value: T, cap: number = WORKFLOW_STORAGE_LIMITS.rowBytes): T {
  const result = immutableKnowledgeJson(value);
  if (Buffer.byteLength(JSON.stringify(result)) > cap)
    workflowError("WORKFLOW_LIMIT");
  return result;
}
function signed<T extends object>(body: T): T & { sha256: string } {
  const { sha256: _old, ...fields } = body as T & { sha256?: string };
  return json({ ...fields, sha256: knowledgeHash(fields) }) as T & {
    sha256: string;
  };
}
function verifyDigest<T extends { sha256: string }>(value: T): T {
  const data = json(value),
    { sha256, ...body } = data;
  if (workflowSha(sha256) !== knowledgeHash(body))
    workflowError("WORKFLOW_DATABASE_INVALID");
  return data;
}
function fields(value: object, required: readonly string[]): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key))
  )
    workflowError("WORKFLOW_DATABASE_INVALID");
}
function date(value: unknown): void {
  if (
    typeof value !== "string" ||
    value.length > 32 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    workflowError("WORKFLOW_DATABASE_INVALID");
}
function stageData(
  stage: WorkflowStageState,
): Omit<WorkflowStageState, "id" | "revision"> {
  const { id: _id, revision: _revision, ...data } = stage;
  return data;
}
function syncVoid(value: unknown): void {
  if (value !== undefined) {
    void Promise.resolve(value).catch(() => {});
    workflowError("WORKFLOW_OWNER_INVALID");
  }
}
function ownerProof(value: WorkflowOwnerProof): WorkflowOwnerProof {
  const proof = verifyDigest(value);
  workflowObject(proof, [
    "workspaceId",
    "sessionId",
    "runId",
    "ownerEpoch",
    "runConfigSha256",
    "profile",
    "sha256",
  ]);
  for (const key of [
    "workspaceId",
    "sessionId",
    "runId",
    "ownerEpoch",
  ] as const)
    workflowIdentifier(proof[key]);
  workflowSha(proof.runConfigSha256);
  if (proof.profile !== null) {
    workflowObject(proof.profile, ["id", "revision"]);
    workflowIdentifier(proof.profile.id);
    workflowSha(proof.profile.revision);
  }
  return proof;
}
function worktreeProof(value: WorkflowWorktreePin): WorkflowWorktreePin {
  const proof = verifyDigest(value);
  workflowObject(proof, [
    "id",
    "workspaceId",
    "root",
    "baseRoot",
    "baseCommit",
    "fingerprint",
    "sha256",
  ]);
  for (const key of ["id", "workspaceId", "baseCommit"] as const)
    workflowIdentifier(proof[key]);
  for (const path of [proof.root, proof.baseRoot])
    if (
      typeof path !== "string" ||
      Buffer.byteLength(path) > 8192 ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      !isAbsolute(path) ||
      resolve(path) !== path
    )
      workflowError("WORKFLOW_WORKTREE_STALE");
  workflowSha(proof.fingerprint);
  return proof;
}
function childProof(
  value: WorkflowChildAdmissionProof,
): WorkflowChildAdmissionProof {
  const proof = verifyDigest(value);
  workflowObject(proof, [
    "rootSessionId",
    "rootRunId",
    "parentRunId",
    "taskId",
    "taskFingerprint",
    "childSessionId",
    "childRunId",
    "childWorkspaceId",
    "worktreeId",
    "storageSha256",
    "requestId",
    "promptSha256",
    "tools",
    "allocation",
    "sha256",
  ]);
  for (const key of [
    "rootSessionId",
    "rootRunId",
    "parentRunId",
    "taskId",
    "childSessionId",
    "childRunId",
    "childWorkspaceId",
    "worktreeId",
    "requestId",
  ] as const)
    workflowIdentifier(proof[key]);
  for (const key of [
    "taskFingerprint",
    "storageSha256",
    "promptSha256",
  ] as const)
    workflowSha(proof[key]);
  if (
    !Array.isArray(proof.tools) ||
    proof.tools.length > 64 ||
    new Set(proof.tools).size !== proof.tools.length
  )
    workflowError("WORKFLOW_CHILD_INVALID");
  for (const name of proof.tools) workflowIdentifier(name);
  workflowObject(proof.allocation, [
    "turns",
    "toolCalls",
    "outputBytes",
    "durationMs",
  ]);
  for (const cap of Object.values(proof.allocation))
    workflowInteger(cap, 16777216, 1);
  return proof;
}

/** All writes use the real primary transaction. Producer callbacks authenticate ORIGINAL handles. */
export class WorkflowStorage {
  constructor(
    readonly db: DatabaseSync,
    private readonly ports: WorkflowStoragePorts,
  ) {}
  private now(): string {
    return new Date(this.ports.now?.() ?? Date.now()).toISOString();
  }
  private ownerSQL(owner: WorkflowOwnerProof): void {
    ownerProof(owner);
    const row = this.db
      .prepare(
        "SELECT session_id,workspace_id,length(CAST(data AS BLOB)) AS bytes FROM runs WHERE id=?",
      )
      .get(owner.runId);
    if (
      !row ||
      row.session_id !== owner.sessionId ||
      row.workspace_id !== owner.workspaceId ||
      Number(row.bytes) > 262144
    )
      workflowError("WORKFLOW_OWNER_INVALID");
    const raw = this.db
      .prepare(
        "SELECT data FROM runs WHERE id=? AND session_id=? AND workspace_id=? AND length(CAST(data AS BLOB))=?",
      )
      .get(owner.runId, owner.sessionId, owner.workspaceId, Number(row.bytes));
    if (!raw) workflowError("WORKFLOW_OWNER_INVALID");
    const run = JSON.parse(String(raw.data)) as {
      id: string;
      sessionId: string;
      workspaceId: string;
      config: { agentProfileId?: string; agentProfileRevision?: string };
    };
    if (
      run.id !== owner.runId ||
      run.sessionId !== owner.sessionId ||
      run.workspaceId !== owner.workspaceId ||
      knowledgeHash(run.config) !== owner.runConfigSha256 ||
      knowledgeHash(owner.profile) !==
        knowledgeHash(
          run.config.agentProfileId
            ? {
                id: run.config.agentProfileId,
                revision: run.config.agentProfileRevision,
              }
            : null,
        )
    )
      workflowError("WORKFLOW_OWNER_INVALID");
    const session = this.db
      .prepare("SELECT workspace_id FROM sessions WHERE id=?")
      .get(owner.sessionId);
    if (!session || session.workspace_id !== owner.workspaceId)
      workflowError("WORKFLOW_OWNER_INVALID");
  }
  private assertOwner(
    original: object,
    expected: WorkflowOwnerProof,
    settling = false,
  ): void {
    const actual = ownerProof(this.ports.readOwner(original));
    if (actual.sha256 !== expected.sha256)
      workflowError("WORKFLOW_OWNER_STALE");
    this.ownerSQL(expected);
    syncVoid(
      settling
        ? this.ports.assertOwnerSettling(original, expected)
        : this.ports.assertOwnerCurrent(original, expected),
    );
  }
  private decode(row: NativeRow): RecordBody {
    if (
      !row ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes > WORKFLOW_STORAGE_LIMITS.rowBytes ||
      row.bytes < 2
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    const value = verifyDigest(JSON.parse(row.data) as RecordBody),
      body = value as unknown as Record<string, unknown>;
    const keys: Record<Kind, string[]> = {
      spec: [
        "id",
        "workspaceId",
        "workflowId",
        "revision",
        "previousId",
        "spec",
        "createdAt",
        "lastReceiptId",
        "sha256",
      ],
      instance: [
        "id",
        "instanceId",
        "workspaceId",
        "workflowId",
        "specRevisionId",
        "specSha256",
        "owner",
        "parameters",
        "parametersSha256",
        "worktrees",
        "revision",
        "previousId",
        "state",
        "stages",
        "result",
        "lastReceiptId",
        "createdAt",
        "sha256",
      ],
      stage: [
        "id",
        "workspaceId",
        "instanceId",
        "workflowId",
        "owner",
        "revision",
        "previousId",
        "stage",
        "createdAt",
        "sha256",
      ],
      transition: [
        "id",
        "workspaceId",
        "instanceId",
        "workflowId",
        "operation",
        "stageId",
        "beforeRevisionId",
        "afterRevisionId",
        "afterSha256",
        "requestId",
        "requestSha256",
        "requestInput",
        "ownerSha256",
        "createdAt",
        "sha256",
      ],
    };
    if (!keys[row.kind]) workflowError("WORKFLOW_DATABASE_INVALID");
    fields(value, keys[row.kind]);
    for (const name of ["id", "workspaceId", "workflowId"] as const)
      workflowIdentifier(body[name]);
    date(body.createdAt);
    if (row.kind !== "transition") {
      workflowInteger(body.revision, Number.MAX_SAFE_INTEGER, 1);
      if (body.previousId !== null) workflowIdentifier(body.previousId);
    }
    if (row.kind === "transition") {
      const receipt = value as WorkflowTransitionReceipt;
      if (
        ![
          "register",
          "create",
          "prepare",
          "admit",
          "settle",
          "cancel",
          "fail",
          "uncertain",
          "pause-import",
        ].includes(receipt.operation) ||
        knowledgeHash(json(receipt.requestInput)) !== receipt.requestSha256
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
    }
    const revision =
      row.kind === "transition"
        ? Number(
            this.db
              .prepare("SELECT revision FROM workflow_revisions WHERE id=?")
              .get((value as WorkflowTransitionReceipt).afterRevisionId)
              ?.revision,
          )
        : Number(body.revision);
    if (
      body.id !== row.id ||
      body.workspaceId !== row.workspace_id ||
      value.sha256 !== row.sha256 ||
      revision !== row.revision ||
      (row.kind !== "transition" &&
        (body.previousId ?? null) !== row.previous_id)
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    if (row.kind === "spec") {
      const spec = value as WorkflowSpecRevision;
      if (
        row.request_scope !== `register:${spec.workflowId}` ||
        row.entity_id !== spec.workflowId ||
        validateWorkflowSpec(spec.spec).sha256 !== spec.spec.sha256 ||
        spec.workflowId !== spec.spec.id ||
        row.root_run_id !== null ||
        row.root_session_id !== null ||
        row.owner_sha256 !== null
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
    } else if (row.kind === "instance" || row.kind === "stage") {
      const owner = ownerProof(body.owner as WorkflowOwnerProof);
      if (
        owner.workspaceId !== row.workspace_id ||
        owner.sessionId !== row.root_session_id ||
        owner.runId !== row.root_run_id ||
        owner.sha256 !== row.owner_sha256
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
      this.ownerSQL(owner);
      if (
        (row.kind === "instance" &&
          row.request_scope !==
            ((value as WorkflowInstanceRevision).revision === 1
              ? `create:${body.workflowId}`
              : `instance:${body.instanceId}`)) ||
        (row.kind === "stage" &&
          row.request_scope !==
            `stage:${body.instanceId}:${(value as StageRevision).stage.stageId}`)
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
      if (
        (row.kind === "instance" &&
          row.entity_id !== (value as WorkflowInstanceRevision).instanceId) ||
        (row.kind === "stage" &&
          row.entity_id !==
            `${(value as StageRevision).instanceId}:${(value as StageRevision).stage.stageId}`)
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
    } else {
      const receipt = value as WorkflowTransitionReceipt;
      if (
        row.request_scope !== `receipt:${row.entity_id}` ||
        receipt.ownerSha256 !== row.owner_sha256 ||
        receipt.requestId !== row.request_id ||
        receipt.requestSha256 !== row.request_sha256
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
    }
    return value;
  }
  private row(id: string, workspaceId: string): NativeRow | undefined {
    const header = this.db
      .prepare(
        "SELECT id,workspace_id,kind,entity_id,revision,previous_id,root_session_id,root_run_id,owner_sha256,request_scope,request_id,request_sha256,sha256,length(CAST(data AS BLOB)) AS bytes FROM workflow_revisions WHERE id=? AND workspace_id=?",
      )
      .get(id, workspaceId) as unknown as NativeRow | undefined;
    if (!header) return;
    if (Number(header.bytes) > WORKFLOW_STORAGE_LIMITS.rowBytes)
      workflowError("WORKFLOW_DATABASE_INVALID");
    const raw = this.db
      .prepare(
        "SELECT data FROM workflow_revisions WHERE id=? AND workspace_id=? AND length(CAST(data AS BLOB))=?",
      )
      .get(id, workspaceId, Number(header.bytes));
    if (!raw) workflowError("WORKFLOW_DATABASE_INVALID");
    return { ...header, data: String(raw.data) };
  }
  private revision(id: string, workspaceId: string, kind?: Kind): RecordBody {
    const row = this.row(
      workflowIdentifier(id),
      workflowIdentifier(workspaceId),
    );
    if (!row || (kind !== undefined && row.kind !== kind))
      workflowError("WORKFLOW_DATABASE_INVALID");
    return this.decode(row);
  }
  private head<T extends RecordBody>(
    workspaceId: string,
    kind: "spec" | "instance" | "stage",
    entityId: string,
  ): T | undefined {
    const head = this.db
      .prepare(
        "SELECT revision_id,revision,sha256 FROM workflow_heads WHERE workspace_id=? AND kind=? AND entity_id=?",
      )
      .get(workflowIdentifier(workspaceId), kind, workflowIdentifier(entityId));
    if (!head) return;
    const value = this.revision(
      String(head.revision_id),
      workspaceId,
      kind,
    ) as T;
    const latest = this.db
      .prepare(
        "SELECT max(revision) AS revision FROM workflow_revisions WHERE workspace_id=? AND kind=? AND entity_id=?",
      )
      .get(workspaceId, kind, entityId);
    if (
      this.row(String(head.revision_id), workspaceId)?.entity_id !== entityId ||
      head.sha256 !== value.sha256 ||
      head.revision !== (value as unknown as { revision: number }).revision ||
      head.revision !== latest?.revision
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    return value;
  }
  private receipt(
    record: WorkflowSpecRevision | WorkflowInstanceRevision,
  ): WorkflowTransitionReceipt {
    const receipt = this.revision(
      record.lastReceiptId,
      record.workspaceId,
      "transition",
    ) as WorkflowTransitionReceipt;
    const row = this.row(record.id, record.workspaceId)!,
      receiptRow = this.row(receipt.id, record.workspaceId)!;
    if (
      receiptRow.root_session_id !== row.root_session_id ||
      receiptRow.root_run_id !== row.root_run_id ||
      receiptRow.owner_sha256 !== row.owner_sha256
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    if (
      receipt.afterRevisionId !== record.id ||
      receipt.afterSha256 !== record.sha256 ||
      row.request_id !== receipt.requestId ||
      row.request_sha256 !== receipt.requestSha256 ||
      receipt.workflowId !== record.workflowId ||
      receipt.instanceId !==
        ("instanceId" in record ? record.instanceId : null) ||
      receipt.ownerSha256 !== ("owner" in record ? record.owner.sha256 : null)
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    return receipt;
  }
  private duplicate<T extends WorkflowSpecRevision | WorkflowInstanceRevision>(
    workspaceId: string,
    scope: string,
    requestId: string,
    digest: string,
  ): WorkflowRequestResult<T> | undefined {
    const row = this.db
      .prepare(
        "SELECT id,request_sha256 FROM workflow_revisions WHERE workspace_id=? AND request_scope=? AND request_id=?",
      )
      .get(workspaceId, scope, requestId);
    if (!row) return;
    if (row.request_sha256 !== digest)
      workflowError("WORKFLOW_REQUEST_CONFLICT");
    const record = this.revision(String(row.id), workspaceId) as T;
    return { record, receipt: this.receipt(record), duplicate: true };
  }
  private insert(
    kind: Kind,
    entity: string,
    value: RecordBody,
    owner: WorkflowOwnerProof | null,
    scope: string,
    requestId: string,
    requestSha: string,
    revision: number,
    previousId: string | null,
  ): void {
    const body = json(value),
      { workspaceId, id, sha256 } = body;
    const sizes = this.db
      .prepare(
        "SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM workflow_revisions",
      )
      .get()!;
    if (
      Number(sizes.count) >= WORKFLOW_STORAGE_LIMITS.rows ||
      Number(sizes.bytes) + Buffer.byteLength(JSON.stringify(body)) >
        WORKFLOW_STORAGE_LIMITS.bytes
    )
      workflowError("WORKFLOW_LIMIT");
    this.db
      .prepare(
        "INSERT INTO workflow_revisions(id,workspace_id,kind,entity_id,revision,previous_id,root_session_id,root_run_id,owner_sha256,request_scope,request_id,request_sha256,sha256,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        kind,
        entity,
        revision,
        previousId,
        owner?.sessionId ?? null,
        owner?.runId ?? null,
        owner?.sha256 ?? null,
        scope,
        requestId,
        requestSha,
        sha256,
        JSON.stringify(body),
      );
  }
  /** Normal writes keep room for recoverInterrupted and a later pauseImported to force-pause every instance. */
  private assertHeadroom(): void {
    const total = this.db
      .prepare(
        "SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM workflow_revisions",
      )
      .get()!;
    let rows = Number(total.count),
      bytes = Number(total.bytes);
    for (const head of this.db
      .prepare(
        "SELECT json_extract(r.data,'$.state') AS state,length(CAST(r.data AS BLOB)) AS bytes,count(j.key) AS live,coalesce(sum(length(CAST(s.data AS BLOB))),0) AS liveBytes FROM workflow_heads h JOIN workflow_revisions r ON r.id=h.revision_id LEFT JOIN json_each(r.data,'$.stages') j ON json_extract(j.value,'$.state') IN ('dispatching','running') LEFT JOIN workflow_revisions s ON s.id=json_extract(j.value,'$.id') WHERE h.kind='instance' GROUP BY h.workspace_id,h.entity_id",
      )
      .all()) {
      const size = Number(head.bytes),
        live = Number(head.live);
      if (head.state === "pending" || head.state === "running") {
        rows += 2 + live;
        bytes +=
          size + Number(head.liveBytes) + (2 + live) * FORCE_PAUSE_ROW_BYTES;
      }
      if (head.state !== "paused-import") {
        rows += 2;
        bytes += size + 2 * FORCE_PAUSE_ROW_BYTES;
      }
    }
    if (
      rows > WORKFLOW_STORAGE_LIMITS.rows ||
      bytes > WORKFLOW_STORAGE_LIMITS.bytes
    )
      workflowError("WORKFLOW_LIMIT");
  }
  private moveHead(
    workspaceId: string,
    kind: "spec" | "instance" | "stage",
    entity: string,
    next: { id: string; revision: number; sha256: string },
    prior?: { id: string; revision: number; sha256: string },
  ): void {
    if (!prior)
      this.db
        .prepare(
          "INSERT INTO workflow_heads(workspace_id,kind,entity_id,revision_id,revision,sha256) VALUES(?,?,?,?,?,?)",
        )
        .run(workspaceId, kind, entity, next.id, next.revision, next.sha256);
    else if (
      this.db
        .prepare(
          "UPDATE workflow_heads SET revision_id=?,revision=?,sha256=? WHERE workspace_id=? AND kind=? AND entity_id=? AND revision_id=? AND revision=? AND sha256=?",
        )
        .run(
          next.id,
          next.revision,
          next.sha256,
          workspaceId,
          kind,
          entity,
          prior.id,
          prior.revision,
          prior.sha256,
        ).changes !== 1
    )
      workflowError("WORKFLOW_STALE");
  }
  private appendReceipt(
    record: WorkflowSpecRevision | WorkflowInstanceRevision,
    before: WorkflowSpecRevision | WorkflowInstanceRevision | undefined,
    operation: WorkflowTransitionReceipt["operation"],
    stageId: string | null,
    requestId: string,
    requestSha: string,
    requestInput: JsonObject,
  ): WorkflowTransitionReceipt {
    const owner = "owner" in record ? record.owner : null;
    const receipt = signed({
      id: record.lastReceiptId,
      workspaceId: record.workspaceId,
      instanceId: "instanceId" in record ? record.instanceId : null,
      workflowId: record.workflowId,
      operation,
      stageId,
      beforeRevisionId: before?.id ?? null,
      afterRevisionId: record.id,
      afterSha256: record.sha256,
      requestId,
      requestSha256: requestSha,
      requestInput,
      ownerSha256: owner?.sha256 ?? null,
      createdAt: record.createdAt,
    });
    const entity =
      "instanceId" in record ? record.instanceId : `spec:${record.workflowId}`;
    this.insert(
      "transition",
      entity,
      receipt,
      owner,
      `receipt:${entity}`,
      requestId,
      requestSha,
      record.revision,
      before?.lastReceiptId ?? null,
    );
    return receipt;
  }
  registerWorkflow(
    input: RegisterWorkflowInput,
  ): WorkflowRequestResult<WorkflowSpecRevision> {
    const r = workflowObject(input, [
        "workspaceId",
        "requestId",
        "expectedRevision",
        "spec",
      ]),
      workspaceId = workflowIdentifier(r.workspaceId),
      requestId = workflowIdentifier(r.requestId),
      spec = validateWorkflowSpec(r.spec),
      revision = workflowInteger(r.expectedRevision),
      digest = knowledgeHash({ ...r, spec }),
      scope = `register:${spec.id}`;
    const duplicate = this.duplicate<WorkflowSpecRevision>(
      workspaceId,
      scope,
      requestId,
      digest,
    );
    if (duplicate) return duplicate;
    return this.ports.writeTx(() => {
      const again = this.duplicate<WorkflowSpecRevision>(
        workspaceId,
        scope,
        requestId,
        digest,
      );
      if (again) return again;
      if (this.ports.getWorkspace(workspaceId).id !== workspaceId)
        workflowError("WORKFLOW_OWNER_INVALID");
      const prior = this.getWorkflow(workspaceId, spec.id);
      if ((prior?.revision ?? 0) !== revision) workflowError("WORKFLOW_STALE");
      if (
        !prior &&
        Number(
          this.db
            .prepare(
              "SELECT count(*) AS n FROM workflow_heads WHERE workspace_id=? AND kind='spec'",
            )
            .get(workspaceId)!.n,
        ) >= WORKFLOW_STORAGE_LIMITS.specifications
      )
        workflowError("WORKFLOW_LIMIT");
      const record = signed({
        id: randomUUID(),
        workspaceId,
        workflowId: spec.id,
        revision: revision + 1,
        previousId: prior?.id ?? null,
        spec,
        lastReceiptId: randomUUID(),
        createdAt: this.now(),
      });
      this.insert(
        "spec",
        spec.id,
        record,
        null,
        scope,
        requestId,
        digest,
        record.revision,
        record.previousId,
      );
      const receipt = this.appendReceipt(
        record,
        prior,
        "register",
        null,
        requestId,
        digest,
        json({ ...r, spec }) as unknown as JsonObject,
      );
      this.moveHead(workspaceId, "spec", spec.id, record, prior);
      this.assertHeadroom();
      return { record, receipt, duplicate: false };
    });
  }
  getWorkflow(
    workspaceId: string,
    workflowId: string,
    revisionId?: string,
  ): WorkflowSpecRevision | undefined {
    if (revisionId === undefined)
      return this.head(workspaceId, "spec", workflowId);
    const record = this.revision(
      revisionId,
      workspaceId,
      "spec",
    ) as WorkflowSpecRevision;
    if (record.workflowId !== workflowId)
      workflowError("WORKFLOW_DATABASE_INVALID");
    return record;
  }
  getInstance(
    workspaceId: string,
    instanceId: string,
  ): WorkflowInstanceRevision | undefined {
    const instance = this.head<WorkflowInstanceRevision>(
      workspaceId,
      "instance",
      instanceId,
    );
    if (instance) this.checkInstance(instance);
    return instance;
  }
  inspectWorkflow(
    workspaceId: string,
    instanceId: string,
  ): WorkflowInstanceRevision | undefined {
    return this.getInstance(workspaceId, instanceId);
  }
  createInstance(
    original: object,
    input: CreateWorkflowInstanceInput,
  ): WorkflowRequestResult<WorkflowInstanceRevision> {
    const r = workflowObject(input, [
        "workspaceId",
        "requestId",
        "workflowId",
        "expectedSpecRevision",
        "parameters",
        "worktrees",
        "ownerSha256",
      ]),
      workspaceId = workflowIdentifier(r.workspaceId),
      workflowId = workflowIdentifier(r.workflowId),
      requestId = workflowIdentifier(r.requestId),
      digest = knowledgeHash(r),
      scope = `create:${workflowId}`;
    workflowSha(r.ownerSha256);
    workflowInteger(r.expectedSpecRevision);
    const duplicate = this.duplicate<WorkflowInstanceRevision>(
      workspaceId,
      scope,
      requestId,
      digest,
    );
    if (duplicate) return duplicate;
    return this.ports.writeTx(() => {
      const again = this.duplicate<WorkflowInstanceRevision>(
        workspaceId,
        scope,
        requestId,
        digest,
      );
      if (again) return again;
      const spec = this.getWorkflow(workspaceId, workflowId);
      if (!spec || spec.revision !== r.expectedSpecRevision)
        workflowError("WORKFLOW_SPEC_STALE");
      const owner = ownerProof(this.ports.readOwner(original));
      if (owner.workspaceId !== workspaceId || owner.sha256 !== r.ownerSha256)
        workflowError("WORKFLOW_OWNER_STALE");
      this.assertOwner(original, owner);
      const parameters = json(
          validateWorkflowValue(
            spec.spec.parameterSchema,
            r.parameters,
          ) as JsonObject,
          WORKFLOW_STORAGE_LIMITS.parametersBytes,
        ),
        selected = workflowObject(
          r.worktrees,
          spec.spec.stages.map((stage) => stage.id),
        ),
        worktrees: Record<string, WorkflowWorktreePin> = {};
      for (const stage of spec.spec.stages) {
        const pin = worktreeProof(
          this.ports.readWorktree(
            original,
            workflowIdentifier(selected[stage.id]),
          ),
        );
        if (pin.workspaceId !== workspaceId)
          workflowError("WORKFLOW_WORKTREE_STALE");
        syncVoid(this.ports.assertWorktreeCurrent(original, pin));
        worktrees[stage.id] = pin;
      }
      validateNewWorkflowWorktreeSharing(spec.spec,Object.fromEntries(Object.entries(worktrees).map(([id,pin])=>[id,pin.id])));
      if (
        Number(
          this.db
            .prepare(
              "SELECT count(*) AS n FROM workflow_heads WHERE workspace_id=? AND kind='instance'",
            )
            .get(workspaceId)!.n,
        ) >= WORKFLOW_STORAGE_LIMITS.instances
      )
        workflowError("WORKFLOW_LIMIT");
      const instanceId = randomUUID(),
        createdAt = this.now(),
        stages = initialWorkflowStages(spec.spec).map((stage) => ({
          ...stage,
          id: randomUUID(),
          revision: 1,
        }));
      const record = signed({
        id: randomUUID(),
        instanceId,
        workspaceId,
        workflowId,
        specRevisionId: spec.id,
        specSha256: spec.spec.sha256,
        owner,
        parameters,
        parametersSha256: knowledgeHash(parameters),
        worktrees,
        revision: 1,
        previousId: null,
        state: "pending" as const,
        stages,
        result: null,
        lastReceiptId: randomUUID(),
        createdAt,
      });
      this.insert(
        "instance",
        instanceId,
        record,
        owner,
        scope,
        requestId,
        digest,
        1,
        null,
      );
      for (const stage of stages)
        this.appendStage(record, stage, undefined, requestId, digest);
      const receipt = this.appendReceipt(
        record,
        undefined,
        "create",
        null,
        requestId,
        digest,
        r as JsonObject,
      );
      this.moveHead(workspaceId, "instance", instanceId, record);
      this.assertHeadroom();
      return { record, receipt, duplicate: false };
    });
  }
  private appendStage(
    instance: WorkflowInstanceRevision,
    stage: WorkflowStageState,
    prior: WorkflowStageState | undefined,
    requestId: string,
    requestSha: string,
  ): void {
    const record = signed({
      id: stage.id,
      workspaceId: instance.workspaceId,
      instanceId: instance.instanceId,
      workflowId: instance.workflowId,
      owner: instance.owner,
      revision: stage.revision,
      previousId: prior?.id ?? null,
      stage,
      createdAt: instance.createdAt,
    });
    const entity = `${instance.instanceId}:${stage.stageId}`,
      old = prior
        ? (this.revision(
            prior.id,
            instance.workspaceId,
            "stage",
          ) as StageRevision)
        : undefined;
    this.insert(
      "stage",
      entity,
      record,
      instance.owner,
      `stage:${entity}`,
      requestId,
      requestSha,
      stage.revision,
      record.previousId,
    );
    this.moveHead(instance.workspaceId, "stage", entity, record, old);
  }
  private spec(instance: WorkflowInstanceRevision): WorkflowSpecRevision {
    const spec = this.revision(
      instance.specRevisionId,
      instance.workspaceId,
      "spec",
    ) as WorkflowSpecRevision;
    if (
      spec.workflowId !== instance.workflowId ||
      spec.spec.sha256 !== instance.specSha256
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    return spec;
  }
  private checkInstance(instance: WorkflowInstanceRevision): void {
    const spec = this.spec(instance).spec;
    if (
      !Array.isArray(instance.stages) ||
      instance.stages.length !== spec.stages.length ||
      new Set(instance.stages.map((stage) => stage.stageId)).size !==
        spec.stages.length ||
      knowledgeHash(
        validateWorkflowValue(spec.parameterSchema, instance.parameters),
      ) !== instance.parametersSha256
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    if (
      ![
        "pending",
        "running",
        "completed",
        "failed",
        "cancelled",
        "uncertain",
        "paused-import",
      ].includes(instance.state)
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    workflowSha(instance.specSha256);
    workflowSha(instance.parametersSha256);
    json(instance.parameters, WORKFLOW_STORAGE_LIMITS.parametersBytes);
    fields(
      instance.worktrees,
      spec.stages.map((stage) => stage.id),
    );
    const ids = new Set<string>();
    for (const pin of Object.values(instance.worktrees)) {
      worktreeProof(pin);
      if (pin.workspaceId !== instance.workspaceId)
        workflowError("WORKFLOW_DATABASE_INVALID");
      ids.add(pin.id);
    }
    validateWorkflowWorktreeSharing(spec,Object.fromEntries(Object.entries(instance.worktrees).map(([id,pin])=>[id,pin.id])));
    for (const stage of instance.stages) {
      const definition = spec.stages.find((def) => def.id === stage.stageId);
      if (!definition) workflowError("WORKFLOW_DATABASE_INVALID");
      fields(stage, [
        "id",
        "revision",
        "stageId",
        "state",
        "child",
        "result",
        "resultSha256",
        "outcomeSha256",
        "requestId",
        "promptSha256",
        "selectedDependencies",
      ]);
      workflowIdentifier(stage.id);
      workflowInteger(stage.revision, Number.MAX_SAFE_INTEGER, 1);
      if (
        ![
          "blocked",
          "ready",
          "dispatching",
          "running",
          "completed",
          "failed",
          "cancelled",
          "uncertain",
        ].includes(stage.state) ||
        !Array.isArray(stage.selectedDependencies) ||
        new Set(stage.selectedDependencies).size !==
          stage.selectedDependencies.length ||
        stage.selectedDependencies.some(
          (id: string) => !definition.dependsOn.includes(id),
        )
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
      for (const id of stage.selectedDependencies) workflowIdentifier(id);
      if (stage.requestId !== null) workflowIdentifier(stage.requestId);
      if (stage.promptSha256 !== null) workflowSha(stage.promptSha256);
      if (stage.outcomeSha256 !== null) workflowSha(stage.outcomeSha256);
      if (
        (["blocked", "ready"].includes(stage.state) &&
          (stage.child !== null ||
            stage.requestId !== null ||
            stage.promptSha256 !== null)) ||
        ([
          "dispatching",
          "running",
          "completed",
          "failed",
          "cancelled",
        ].includes(stage.state) &&
          (stage.requestId === null || stage.promptSha256 === null)) ||
        (["running", "completed", "failed", "cancelled"].includes(
          stage.state,
        ) &&
          stage.child === null)
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
      const record = this.revision(
        stage.id,
        instance.workspaceId,
        "stage",
      ) as StageRevision;
      if (
        record.instanceId !== instance.instanceId ||
        record.workflowId !== instance.workflowId ||
        record.owner.sha256 !== instance.owner.sha256 ||
        knowledgeHash(record.stage) !== knowledgeHash(stage) ||
        record.revision !== stage.revision
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
      if (stage.child !== null) {
        const proof = childProof(stage.child),
          pin = instance.worktrees[stage.stageId]!;
        if (
          proof.rootSessionId !== instance.owner.sessionId ||
          proof.rootRunId !== instance.owner.runId ||
          proof.parentRunId !== instance.owner.runId ||
          proof.worktreeId !== pin.id ||
          proof.requestId !== stage.requestId ||
          proof.promptSha256 !== stage.promptSha256 ||
          knowledgeHash(proof.tools) !== knowledgeHash(definition.tools) ||
          knowledgeHash(proof.allocation) !==
            knowledgeHash(definition.allocation)
        )
          workflowError("WORKFLOW_DATABASE_INVALID");
        const { task, storage } = this.childSQL(instance, proof);
        if (stage.state === "completed") {
          const outcome = task.outcome as
            | { content?: unknown; truncated?: boolean; usage?: unknown }
            | undefined;
          if (
            task.state !== "completed" ||
            !storage.confirmedClose ||
            !outcome ||
            typeof outcome.content !== "string" ||
            Buffer.byteLength(outcome.content) >
              WORKFLOW_STORAGE_LIMITS.resultBytes ||
            outcome.truncated ||
            stage.outcomeSha256 !== knowledgeHash(outcome) ||
            stage.result === null ||
            stage.resultSha256 !== knowledgeHash(stage.result) ||
            knowledgeHash(JSON.parse(outcome.content)) !==
              knowledgeHash(stage.result)
          )
            workflowError("WORKFLOW_DATABASE_INVALID");
          json(stage.result, WORKFLOW_STORAGE_LIMITS.resultBytes);
          validateWorkflowStageResult(spec, stage.stageId, stage.result);
        } else if (stage.result !== null || stage.resultSha256 !== null)
          workflowError("WORKFLOW_DATABASE_INVALID");
      } else if (stage.result !== null || stage.resultSha256 !== null)
        workflowError("WORKFLOW_DATABASE_INVALID");
    }
    if (
      instance.state === "completed" &&
      knowledgeHash(instance.result) !==
        knowledgeHash(
          instance.stages.find((stage) => stage.stageId === spec.resultStageId)
            ?.result,
        )
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    if (
      !["completed", "paused-import"].includes(instance.state) &&
      instance.result !== null
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    this.receipt(instance);
  }
  private childSQL(
    instance: WorkflowInstanceRevision,
    proof: WorkflowChildAdmissionProof,
  ): {
    task: Record<string, unknown>;
    storage: ReturnType<typeof validateChildStorageRecord>;
  } {
    const storageHeader = this.db
      .prepare(
        "SELECT length(CAST(data AS BLOB)) AS bytes FROM session_documents WHERE session_id=? AND kind=?",
      )
      .get(instance.owner.sessionId, childStorageKind(proof.taskId));
    if (!storageHeader || Number(storageHeader.bytes) > 32768)
      workflowError("WORKFLOW_CHILD_INVALID");
    const storage = validateChildStorageRecord(
      JSON.parse(
        String(
          this.db
            .prepare(
              "SELECT data FROM session_documents WHERE session_id=? AND kind=? AND length(CAST(data AS BLOB))=?",
            )
            .get(
              instance.owner.sessionId,
              childStorageKind(proof.taskId),
              Number(storageHeader.bytes),
            )!.data,
        ),
      ),
    );
    if (
      storage.sha256 !== proof.storageSha256 ||
      storage.binding.lineage.taskFingerprint !== proof.taskFingerprint ||
      storage.binding.lineage.taskId !== proof.taskId ||
      storage.binding.lineage.parentRunId !== instance.owner.runId ||
      storage.binding.lineage.sourceRunId !== instance.owner.runId ||
      storage.binding.lineage.sessionId !== instance.owner.sessionId ||
      storage.binding.child.runId !== proof.childRunId ||
      storage.binding.child.sessionId !== proof.childSessionId ||
      storage.binding.child.workspaceId !== proof.childWorkspaceId ||
      storage.binding.worktree.id !== proof.worktreeId ||
      storage.binding.phase !== "admitted" ||
      storage.binding.lineage.taskRequestId !== proof.requestId ||
      storage.binding.worktree.workspaceId !== instance.workspaceId ||
      !Object.values(instance.worktrees).some(
        (pin) =>
          pin.id === proof.worktreeId &&
          pin.root === storage.binding.worktree.root &&
          pin.baseRoot === storage.binding.worktree.baseRoot &&
          pin.baseCommit === storage.binding.worktree.baseCommit &&
          pin.fingerprint === storage.binding.worktree.fingerprint,
      )
    )
      workflowError("WORKFLOW_CHILD_INVALID");
    const header = this.db
      .prepare(
        "SELECT length(CAST(data AS BLOB)) AS bytes FROM session_documents WHERE session_id=? AND kind='engine.child_tasks'",
      )
      .get(instance.owner.sessionId);
    if (!header || Number(header.bytes) > 262144)
      workflowError("WORKFLOW_CHILD_INVALID");
    const journal = JSON.parse(
      String(
        this.db
          .prepare(
            "SELECT data FROM session_documents WHERE session_id=? AND kind='engine.child_tasks' AND length(CAST(data AS BLOB))=?",
          )
          .get(instance.owner.sessionId, Number(header.bytes))!.data,
      ),
    ) as { schemaVersion: number; tasks: Record<string, unknown>[] };
    if (
      journal.schemaVersion !== 1 ||
      !Array.isArray(journal.tasks) ||
      journal.tasks.length > 32
    )
      workflowError("WORKFLOW_CHILD_INVALID");
    const task = journal.tasks.find((task) => task.id === proof.taskId);
    if (
      !task ||
      task.rootRunId !== instance.owner.runId ||
      task.parentRunId !== instance.owner.runId ||
      task.sessionId !== instance.owner.sessionId ||
      task.childRunId !== proof.childRunId ||
      task.worktreeId !== proof.worktreeId ||
      task.fingerprint !== proof.taskFingerprint ||
      task.requestId !== proof.requestId ||
      knowledgeHash(task.toolNames) !== knowledgeHash(proof.tools) ||
      knowledgeHash(task.budget) !== knowledgeHash(proof.allocation)
    )
      workflowError("WORKFLOW_CHILD_INVALID");
    return { task, storage };
  }
  private mutate(
    original: object | null,
    input: WorkflowStageMutationInput | WorkflowControlInput,
    operation: WorkflowTransitionReceipt["operation"],
    eventFactory: (before: WorkflowInstanceRevision) => WorkflowTransitionEvent,
    settling = false,
    atCurrent = false,
  ): WorkflowRequestResult<WorkflowInstanceRevision> {
    const safeInput = json(input);
    const allowed =
      "stageId" in safeInput
        ? [
            "workspaceId",
            "instanceId",
            "stageId",
            "requestId",
            "expectedRevision",
          ]
        : [
            "workspaceId",
            "instanceId",
            "requestId",
            "expectedRevision",
            "operation",
          ];
    const extras = "prompt" in safeInput ? ["prompt", "childRequestId"] : [];
    const data = workflowObject(safeInput, allowed, extras),
      workspaceId = workflowIdentifier(data.workspaceId),
      instanceId = workflowIdentifier(data.instanceId),
      requestId = workflowIdentifier(data.requestId),
      scope = `instance:${instanceId}`;
    let requestInput = { ...data, operation } as JsonObject,
      digest = knowledgeHash(requestInput);
    const expectedRevision = workflowInteger(data.expectedRevision);
    const duplicate = this.duplicate<WorkflowInstanceRevision>(
      workspaceId,
      scope,
      requestId,
      digest,
    );
    if (duplicate) return duplicate;
    return this.ports.writeTx(() => {
      const again = this.duplicate<WorkflowInstanceRevision>(
        workspaceId,
        scope,
        requestId,
        digest,
      );
      if (again) return again;
      if (
        this.db
          .prepare(
            "SELECT 1 FROM workflow_revisions WHERE workspace_id=? AND request_scope=? AND request_id=?",
          )
          .get(workspaceId, `receipt:${instanceId}`, requestId)
      )
        workflowError("WORKFLOW_REQUEST_CONFLICT");
      const before = this.getInstance(workspaceId, instanceId);
      if (
        !before ||
        (atCurrent
          ? before.revision < expectedRevision
          : before.revision !== expectedRevision)
      )
        workflowError("WORKFLOW_STALE");
      if (before.revision !== expectedRevision) {
        requestInput = { ...requestInput, expectedRevision: before.revision };
        digest = knowledgeHash(requestInput);
      }
      if (original !== null) this.assertOwner(original, before.owner, settling);
      const event = eventFactory(before),
        spec = this.spec(before).spec;
      const reduced = reduceWorkflow(spec, before, event),
        createdAt = this.now(),
        stages = reduced.stages.map((stage) => {
          const prior = before.stages.find(
            (prior) => prior.stageId === stage.stageId,
          )!;
          return knowledgeHash(stage) === knowledgeHash(prior)
            ? stage
            : { ...stage, id: randomUUID(), revision: prior.revision + 1 };
        });
      const record = signed({
        ...before,
        ...reduced,
        stages,
        id: randomUUID(),
        revision: before.revision + 1,
        previousId: before.id,
        lastReceiptId: randomUUID(),
        createdAt,
      });
      this.insert(
        "instance",
        instanceId,
        record,
        before.owner,
        scope,
        requestId,
        digest,
        record.revision,
        before.id,
      );
      for (const stage of stages) {
        const prior = before.stages.find(
          (old) => old.stageId === stage.stageId,
        )!;
        if (stage.id !== prior.id)
          this.appendStage(record, stage, prior, requestId, digest);
      }
      const receipt = this.appendReceipt(
        record,
        before,
        event.operation,
        "stageId" in event ? event.stageId : null,
        requestId,
        digest,
        requestInput,
      );
      this.moveHead(workspaceId, "instance", instanceId, record, before);
      this.assertHeadroom();
      return { record, receipt, duplicate: false };
    });
  }
  prepareStage(
    original: object,
    input: PrepareWorkflowStageInput,
  ): WorkflowRequestResult<WorkflowInstanceRevision> {
    input = workflowObject(input, [
      "workspaceId",
      "instanceId",
      "stageId",
      "requestId",
      "expectedRevision",
      "childRequestId",
      "prompt",
    ]) as unknown as PrepareWorkflowStageInput;
    if (
      typeof input.prompt !== "string" ||
      !input.prompt ||
      Buffer.byteLength(input.prompt) > 32768 ||
      Buffer.from(input.prompt).toString("utf8") !== input.prompt
    )
      workflowError("WORKFLOW_LIMIT");
    workflowIdentifier(input.childRequestId);
    return this.mutate(original, input, "prepare", (before) => {
      const pin = before.worktrees[input.stageId];
      if (!pin) workflowError("WORKFLOW_WORKTREE_STALE");
      syncVoid(this.ports.assertWorktreeCurrent(original, pin));
      return {
        operation: "prepare",
        stageId: input.stageId,
        childRequestId: input.childRequestId,
        promptSha256: rawHash(input.prompt),
      };
    });
  }
  /** Commits at the current revision, never below expectedRevision; the reducer rejects a stage no longer dispatching this child. */
  admitStage(
    original: object,
    originalChild: object,
    input: WorkflowStageMutationInput,
  ): WorkflowRequestResult<WorkflowInstanceRevision> {
    return this.mutate(
      original,
      input,
      "admit",
      (before) => {
        const proof = childProof(this.ports.readChildAdmission(originalChild)),
          definition = this.spec(before).spec.stages.find(
            (stage) => stage.id === input.stageId,
          ),
          stage = before.stages.find(
            (stage) => stage.stageId === input.stageId,
          ),
          pin = before.worktrees[input.stageId];
        if (
          !definition ||
          !stage ||
          !pin ||
          proof.rootRunId !== before.owner.runId ||
          proof.rootSessionId !== before.owner.sessionId ||
          proof.parentRunId !== before.owner.runId ||
          proof.worktreeId !== pin.id ||
          proof.requestId !== stage.requestId ||
          proof.promptSha256 !== stage.promptSha256 ||
          knowledgeHash(proof.tools) !== knowledgeHash(definition.tools) ||
          knowledgeHash(proof.allocation) !==
            knowledgeHash(definition.allocation)
        )
          workflowError("WORKFLOW_CHILD_INVALID");
        this.childSQL(before, proof);
        return { operation: "admit", stageId: input.stageId, child: proof };
      },
      true,
      true,
    );
  }
  settleStage(
    original: object,
    originalCompletion: object,
    input: WorkflowStageMutationInput,
  ): WorkflowRequestResult<WorkflowInstanceRevision> {
    return this.mutate(
      original,
      input,
      "settle",
      (before) => {
        const proof = verifyDigest(
          this.ports.readChildCompletion(originalCompletion),
        );
        fields(proof, [
          "child",
          "state",
          "result",
          "outcomeSha256",
          "usage",
          "complete",
          "sha256",
        ]);
        childProof(proof.child);
        workflowSha(proof.outcomeSha256);
        if (
          !["completed", "failed", "cancelled", "uncertain"].includes(
            proof.state,
          ) ||
          typeof proof.complete !== "boolean"
        )
          workflowError("WORKFLOW_CHILD_INVALID");
        fields(proof.usage, ["turns", "toolCalls", "outputBytes"]);
        for (const key of ["turns", "toolCalls", "outputBytes"] as const)
          workflowInteger(proof.usage[key], proof.child.allocation[key]);
        const { task, storage } = this.childSQL(before, proof.child);
        if (
          task.state !== proof.state ||
          (proof.state !== "uncertain" &&
            (!storage.confirmedClose ||
              knowledgeHash(
                task.outcome ?? {
                  state: task.state,
                  errorCode: task.errorCode ?? null,
                },
              ) !== proof.outcomeSha256))
        )
          workflowError("WORKFLOW_CHILD_INVALID");
        if (proof.state === "completed") {
          const outcome = task.outcome as {
            content: string;
            truncated?: boolean;
            usage: unknown;
          };
          if (
            !proof.complete ||
            outcome.truncated ||
            knowledgeHash(outcome.usage) !== knowledgeHash(proof.usage) ||
            knowledgeHash(JSON.parse(outcome.content)) !==
              knowledgeHash(proof.result)
          )
            workflowError("WORKFLOW_RESULT_INCOMPLETE");
          json(proof.result, WORKFLOW_STORAGE_LIMITS.resultBytes);
        }
        return {
          operation: "settle",
          stageId: input.stageId,
          completion: proof,
        };
      },
      true,
    );
  }
  control(
    original: object,
    input: WorkflowControlInput,
  ): WorkflowRequestResult<WorkflowInstanceRevision> {
    return this.mutate(
      original,
      json(input),
      json(input).operation,
      () => ({ operation: json(input).operation }),
      true,
    );
  }
  private forcePause(
    before: WorkflowInstanceRevision,
    operation: "pause-import" | "uncertain",
    requestId: string,
  ): void {
    const digest = knowledgeHash({
        operation,
        instanceId: before.instanceId,
        revision: before.revision,
        requestId,
      }),
      stages = before.stages.map((stage) =>
        operation === "uncertain" &&
        ["dispatching", "running"].includes(stage.state)
          ? {
              ...stage,
              id: randomUUID(),
              revision: stage.revision + 1,
              state: "uncertain" as const,
            }
          : stage,
      );
    const record = signed({
      ...before,
      id: randomUUID(),
      revision: before.revision + 1,
      previousId: before.id,
      state:
        operation === "pause-import"
          ? ("paused-import" as const)
          : ("uncertain" as const),
      stages,
      lastReceiptId: randomUUID(),
      createdAt: this.now(),
    });
    this.insert(
      "instance",
      before.instanceId,
      record,
      before.owner,
      `instance:${before.instanceId}`,
      requestId,
      digest,
      record.revision,
      before.id,
    );
    for (const stage of stages) {
      const prior = before.stages.find((old) => old.stageId === stage.stageId)!;
      if (stage.id !== prior.id)
        this.appendStage(record, stage, prior, requestId, digest);
    }
    this.appendReceipt(record, before, operation, null, requestId, digest, {
      operation,
      instanceId: before.instanceId,
      revision: before.revision,
      requestId,
    });
    this.moveHead(
      before.workspaceId,
      "instance",
      before.instanceId,
      record,
      before,
    );
  }
  recoverInterrupted(): void {
    this.ports.writeTx(() => {
      for (const before of this.instances())
        if (["pending", "running"].includes(before.state))
          this.forcePause(before, "uncertain", `recover:${before.id}`);
    });
  }
  private instances(workspaceId?: string): WorkflowInstanceRevision[] {
    const rows = this.db
      .prepare(
        `SELECT workspace_id,entity_id FROM workflow_heads WHERE kind='instance'${workspaceId === undefined ? "" : " AND workspace_id=?"} ORDER BY workspace_id,entity_id LIMIT 1025`,
      )
      .all(...(workspaceId === undefined ? [] : [workspaceId]));
    if (rows.length > 1024) workflowError("WORKFLOW_LIMIT");
    return rows.map((row) =>
      this.getInstance(String(row.workspace_id), String(row.entity_id))!,
    );
  }
  private replay(after: WorkflowSpecRevision | WorkflowInstanceRevision): void {
    const receipt = this.receipt(after),
      request = receipt.requestInput;
    if (
      request.requestId !== receipt.requestId ||
      (request.workspaceId !== after.workspaceId &&
        receipt.operation !== "pause-import" &&
        !String(receipt.requestId).startsWith("recover:"))
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    if ("spec" in after) {
      if (
        receipt.operation !== "register" ||
        receipt.instanceId !== null ||
        receipt.stageId !== null ||
        request.expectedRevision !== after.revision - 1 ||
        knowledgeHash(request.spec) !== knowledgeHash(after.spec)
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
      fields(request, ["workspaceId", "requestId", "expectedRevision", "spec"]);
      return;
    }
    const spec = this.spec(after).spec;
    if (after.previousId === null) {
      fields(request, [
        "workspaceId",
        "requestId",
        "workflowId",
        "expectedSpecRevision",
        "parameters",
        "worktrees",
        "ownerSha256",
      ]);
      if (
        receipt.operation !== "create" ||
        after.revision !== 1 ||
        after.state !== "pending" ||
        after.result !== null ||
        request.workflowId !== after.workflowId ||
        request.ownerSha256 !== after.owner.sha256 ||
        request.expectedSpecRevision !== this.spec(after).revision ||
        knowledgeHash(request.parameters) !== knowledgeHash(after.parameters) ||
        knowledgeHash(request.worktrees) !==
          knowledgeHash(
            Object.fromEntries(
              Object.entries(after.worktrees).map(([id, pin]) => [id, pin.id]),
            ),
          ) ||
        knowledgeHash(after.stages.map(stageData)) !==
          knowledgeHash(initialWorkflowStages(spec)) ||
        after.stages.some((stage) => stage.revision !== 1)
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
      return;
    }
    const before = this.revision(
      after.previousId,
      after.workspaceId,
      "instance",
    ) as WorkflowInstanceRevision;
    for (const key of [
      "instanceId",
      "workspaceId",
      "workflowId",
      "specRevisionId",
      "specSha256",
      "owner",
      "parameters",
      "parametersSha256",
      "worktrees",
    ] as const)
      if (knowledgeHash(after[key]) !== knowledgeHash(before[key]))
        workflowError("WORKFLOW_DATABASE_INVALID");
    let reduced: ReturnType<typeof reduceWorkflow>;
    const internal =
      receipt.operation === "pause-import" ||
      (receipt.operation === "uncertain" && Object.hasOwn(request, "revision"));
    if (internal) {
      fields(request, ["operation", "instanceId", "revision", "requestId"]);
      if (
        request.operation !== receipt.operation ||
        request.instanceId !== after.instanceId ||
        request.revision !== before.revision ||
        receipt.stageId !== null ||
        (receipt.operation === "uncertain" &&
          (!["pending", "running"].includes(before.state) ||
            receipt.requestId !== `recover:${before.id}`))
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
      reduced = {
        state:
          receipt.operation === "pause-import" ? "paused-import" : "uncertain",
        result: before.result,
        stages: before.stages.map((stage) =>
          receipt.operation === "uncertain" &&
          ["dispatching", "running"].includes(stage.state)
            ? { ...stage, state: "uncertain" }
            : stage,
        ),
      };
    } else {
      const stageId = receipt.stageId,
        stage = after.stages.find((stage) => stage.stageId === stageId);
      if (
        request.operation !== receipt.operation ||
        request.instanceId !== after.instanceId ||
        request.expectedRevision !== before.revision ||
        request.stageId !== (stageId ?? undefined)
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
      let event: WorkflowTransitionEvent;
      if (receipt.operation === "prepare") {
        fields(request, [
          "workspaceId",
          "instanceId",
          "stageId",
          "requestId",
          "expectedRevision",
          "prompt",
          "childRequestId",
          "operation",
        ]);
        if (
          typeof request.prompt !== "string" ||
          !request.prompt ||
          Buffer.byteLength(request.prompt) > 32768
        )
          workflowError("WORKFLOW_DATABASE_INVALID");
        event = {
          operation: "prepare",
          stageId: stageId!,
          childRequestId: workflowIdentifier(request.childRequestId),
          promptSha256: rawHash(request.prompt),
        };
      } else if (receipt.operation === "admit") {
        fields(request, [
          "workspaceId",
          "instanceId",
          "stageId",
          "requestId",
          "expectedRevision",
          "operation",
        ]);
        if (!stage?.child) workflowError("WORKFLOW_DATABASE_INVALID");
        event = { operation: "admit", stageId: stageId!, child: stage.child };
      } else if (receipt.operation === "settle") {
        fields(request, [
          "workspaceId",
          "instanceId",
          "stageId",
          "requestId",
          "expectedRevision",
          "operation",
        ]);
        if (
          !stage?.child ||
          !["completed", "failed", "cancelled", "uncertain"].includes(
            stage.state,
          ) ||
          !stage.outcomeSha256
        )
          workflowError("WORKFLOW_DATABASE_INVALID");
        const { task, storage } = this.childSQL(after, stage.child);
        if (
          task.state !== stage.state ||
          stage.outcomeSha256 !==
            knowledgeHash(
              task.outcome ?? {
                state: task.state,
                errorCode: task.errorCode ?? null,
              },
            ) ||
          (stage.state !== "uncertain" && !storage.confirmedClose)
        )
          workflowError("WORKFLOW_DATABASE_INVALID");
        event = {
          operation: "settle",
          stageId: stageId!,
          completion: {
            child: stage.child,
            state: stage.state as WorkflowChildCompletionProof["state"],
            result: stage.result,
            outcomeSha256: stage.outcomeSha256,
            complete: stage.state === "completed",
            usage: { turns: 0, toolCalls: 0, outputBytes: 0 },
            sha256: "",
          },
        };
      } else if (
        receipt.operation === "cancel" ||
        receipt.operation === "fail" ||
        receipt.operation === "uncertain"
      ) {
        fields(request, [
          "workspaceId",
          "instanceId",
          "requestId",
          "expectedRevision",
          "operation",
        ]);
        if (stageId !== null) workflowError("WORKFLOW_DATABASE_INVALID");
        event = { operation: receipt.operation };
      } else return workflowError("WORKFLOW_DATABASE_INVALID");
      reduced = reduceWorkflow(spec, before, event);
    }
    if (
      after.revision !== before.revision + 1 ||
      knowledgeHash({
        state: after.state,
        result: after.result,
        stages: after.stages.map(stageData),
      }) !==
        knowledgeHash({ ...reduced, stages: reduced.stages.map(stageData) })
    )
      workflowError("WORKFLOW_DATABASE_INVALID");
    for (const stage of after.stages) {
      const prior = before.stages.find(
          (item) => item.stageId === stage.stageId,
        )!,
        expected = reduced.stages.find(
          (item) => item.stageId === stage.stageId,
        )!;
      const changed =
        knowledgeHash(stageData(prior)) !== knowledgeHash(stageData(expected));
      if (
        changed
          ? stage.id === prior.id || stage.revision !== prior.revision + 1
          : stage.id !== prior.id || stage.revision !== prior.revision
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
    }
  }
  validate(check: () => void = () => {}): void {
    const referencedStages = new Set<string>(),
      stageRows: string[] = [];
    const sizes = this.db
      .prepare(
        "SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM workflow_revisions",
      )
      .get()!;
    if (
      Number(sizes.count) > WORKFLOW_STORAGE_LIMITS.rows ||
      Number(sizes.bytes) > WORKFLOW_STORAGE_LIMITS.bytes
    )
      workflowError("WORKFLOW_LIMIT");
    for (const row of this.db
      .prepare(
        "SELECT id,workspace_id FROM workflow_revisions ORDER BY workspace_id,id LIMIT 4097",
      )
      .all()) {
      check();
      const native = this.row(String(row.id), String(row.workspace_id))!,
        body = this.decode(native);
      if (native.previous_id !== null) {
        const predecessor = this.row(native.previous_id, native.workspace_id);
        if (
          !predecessor ||
          predecessor.kind !== native.kind ||
          predecessor.entity_id !== native.entity_id ||
          predecessor.revision + 1 !== native.revision
        )
          workflowError("WORKFLOW_DATABASE_INVALID");
      }
      if (native.kind === "instance") {
        this.checkInstance(body as WorkflowInstanceRevision);
        for (const stage of (body as WorkflowInstanceRevision).stages)
          referencedStages.add(stage.id);
      }
      if (native.kind === "stage") stageRows.push(native.id);
      if (native.kind === "instance" || native.kind === "spec")
        this.replay(body as WorkflowInstanceRevision | WorkflowSpecRevision);
      if (
        native.kind !== "transition" &&
        !this.head(native.workspace_id, native.kind, native.entity_id)
      )
        workflowError("WORKFLOW_DATABASE_INVALID");
      if (native.previous_id === null && native.revision !== 1)
        workflowError("WORKFLOW_DATABASE_INVALID");
      if (native.kind === "transition") {
        const receipt = body as WorkflowTransitionReceipt,
          after = this.revision(receipt.afterRevisionId, receipt.workspaceId);
        if (
          after.sha256 !== receipt.afterSha256 ||
          (after as WorkflowInstanceRevision | WorkflowSpecRevision)
            .lastReceiptId !== receipt.id ||
          receipt.beforeRevisionId !==
            (after as WorkflowInstanceRevision | WorkflowSpecRevision)
              .previousId ||
          native.entity_id !==
            ("instanceId" in after
              ? after.instanceId
              : `spec:${(after as WorkflowSpecRevision).workflowId}`) ||
          native.previous_id !==
            (receipt.beforeRevisionId
              ? (
                  this.revision(
                    receipt.beforeRevisionId,
                    receipt.workspaceId,
                  ) as WorkflowInstanceRevision | WorkflowSpecRevision
                ).lastReceiptId
              : null)
        )
          workflowError("WORKFLOW_DATABASE_INVALID");
      }
    }
    if (stageRows.some((id) => !referencedStages.has(id)))
      workflowError("WORKFLOW_DATABASE_INVALID");
    for (const row of this.db
      .prepare(
        "SELECT workspace_id,kind,entity_id FROM workflow_heads LIMIT 4097",
      )
      .all()) {
      check();
      this.head(
        String(row.workspace_id),
        row.kind as "spec" | "instance" | "stage",
        String(row.entity_id),
      );
    }
  }
  pauseImported(archiveSha: string, workspaceId?: string): void {
    workflowSha(archiveSha);
    if (workspaceId !== undefined) workflowIdentifier(workspaceId);
    for (const before of this.instances(workspaceId))
      if (before.state !== "paused-import")
        this.forcePause(
          before,
          "pause-import",
          `archive:${archiveSha.slice(0, 32)}:${before.id}`,
        );
  }
}

function historicalStorage(db: DatabaseSync): WorkflowStorage {
  const denied = (): never => workflowError("WORKFLOW_OWNER_STALE");
  return new WorkflowStorage(db, {
    writeTx: (operation) => operation(),
    getWorkspace: denied,
    readOwner: denied,
    assertOwnerCurrent: denied,
    assertOwnerSettling: denied,
    readWorktree: denied,
    assertWorktreeCurrent: denied,
    readChildAdmission: denied,
    readChildCompletion: denied,
  });
}
export function validateWorkflowDatabase(
  db: DatabaseSync,
  options: { check?: () => void } = {},
): void {
  historicalStorage(db).validate(options.check);
}
/** Pure typed primary metadata only: importing never opens old child paths or grants execution. */
export function markImportedWorkflowsPaused(
  db: DatabaseSync,
  archiveSha: string,
  workspaceId?: string,
): void {
  historicalStorage(db).pauseImported(archiveSha, workspaceId);
}
