import {
  EngineError,
  type InputReceipt,
  type JsonObject,
} from "@moodcode/contracts";
import type { DatabaseSync } from "node:sqlite";
import { knowledgeHash } from "../knowledge/validation.js";
import { workflowJson } from "./spec.js";
import {
  childStorageKind,
  validateChildStorageRecord,
} from "../child-tasks/storage-binding.js";
import type {
  WorkflowInstanceRevision,
  WorkflowChildCompletionProof,
} from "./reducer.js";
import type { WorkflowChildEvidence } from "./effect-evidence.js";
import type { ScheduleTargetPin } from "../schedules/types.js";
const EFFECT_PREFIX = "workflow.effect.";
const DELIVERY_PREFIX = "workflow.delivery.";
export const effectKind = (instanceId: string, stageId: string) =>
  EFFECT_PREFIX + knowledgeHash([instanceId, stageId]).slice(0, 40);
const deliveryKind = (instanceId: string) =>
  DELIVERY_PREFIX + knowledgeHash(instanceId).slice(0, 40);
export function effectFail(code = "WORKFLOW_EFFECT_INVALID"): never {
  throw new EngineError(
    code,
    "Workflow effects require exact actual child, native verification, approved merge and current parent input evidence",
  );
}
export function signEffect<T extends object>(body: T): T & { sha256: string } {
  const copy = { ...body } as T & { sha256?: string };
  delete copy.sha256;
  return workflowJson({ ...copy, sha256: knowledgeHash(copy) });
}
export interface WorkflowFilePin {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly sha256: string;
}
export interface WorkflowEffectRecord {
  readonly version: 1;
  readonly instanceId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly stageId: string;
  readonly role: "editor" | "validator";
  readonly revision: number;
  readonly previousSha256: string | null;
  readonly stageRevisionId: string;
  readonly specSha256: string;
  readonly completion: WorkflowChildCompletionProof;
  readonly evidence: WorkflowChildEvidence;
  readonly files: readonly WorkflowFilePin[];
  readonly artifacts: readonly WorkflowFilePin[];
  readonly state:
    "observed" | "merge-dispatching" | "merged" | "uncertain" | "paused-import";
  readonly merge: null | {
    readonly toolCallId: string;
    readonly runId: string;
    readonly turnId: string;
    readonly attemptId: string;
    readonly preparedFingerprint: string;
    readonly approvalId: string;
    readonly validatorSha256: string;
    readonly checkpointIds: readonly string[];
    readonly parentFiles: readonly WorkflowFilePin[];
  };
  readonly sha256: string;
}
export interface WorkflowDeliveryRecord {
  readonly version: 1;
  readonly instanceId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly source: WorkflowInstanceRevision;
  readonly effects: readonly WorkflowEffectRecord[];
  readonly target: ScheduleTargetPin;
  readonly prompt: string;
  readonly inputRequestId: string;
  readonly requestId: string;
  readonly input: InputReceipt;
  readonly state: "accepted" | "paused-import";
  readonly sha256: string;
}
function body(db: DatabaseSync, sessionId: string, kind: string): unknown {
  const row = db
    .prepare(
      "SELECT revision,length(CAST(data AS BLOB)) bytes FROM session_documents WHERE session_id=? AND kind=?",
    )
    .get(sessionId, kind);
  if (!row) return null;
  if (Number(row.bytes) > 131072) effectFail("WORKFLOW_EFFECT_LIMIT");
  return JSON.parse(
    String(
      db
        .prepare(
          "SELECT data FROM session_documents WHERE session_id=? AND kind=? AND revision=?",
        )
        .get(sessionId, kind, row.revision!)!.data,
    ),
  );
}
function signed(value: unknown): Record<string, unknown> {
  const data = workflowJson(value) as Record<string, unknown>;
  if (!data || typeof data !== "object" || Array.isArray(data)) effectFail();
  const { sha256, ...rest } = data;
  if (sha256 !== knowledgeHash(rest)) effectFail();
  return data;
}
function anchor(
  db: DatabaseSync,
  sessionId: string,
  type: string,
  sha: string,
  record: unknown,
): void {
  const rows = db
    .prepare(
      "SELECT seq,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND type=? AND json_extract(data,'$.payload.record.sha256')=? LIMIT 3",
    )
    .all(sessionId, type, sha);
  if (rows.length !== 1 || Number(rows[0]!.bytes) > 262144) effectFail();
  const event = JSON.parse(
    String(
      db
        .prepare("SELECT data FROM session_events WHERE session_id=? AND seq=?")
        .get(sessionId, rows[0]!.seq!)!.data,
    ),
  );
  if (knowledgeHash(event.payload.record) !== knowledgeHash(record))
    effectFail();
}
function nativeRevision(
  db: DatabaseSync,
  id: string,
  workspaceId: string,
  kind: string,
): Record<string, unknown> {
  const head = db
    .prepare(
      "SELECT workspace_id,kind,sha256,length(CAST(data AS BLOB)) bytes FROM workflow_revisions WHERE id=?",
    )
    .get(id);
  if (
    !head ||
    head.workspace_id !== workspaceId ||
    head.kind !== kind ||
    Number(head.bytes) > 131072
  )
    effectFail();
  const data = signed(
    JSON.parse(
      String(
        db.prepare("SELECT data FROM workflow_revisions WHERE id=?").get(id)!
          .data,
      ),
    ),
  );
  if (data.sha256 !== head.sha256) effectFail();
  return data;
}
export function readWorkflowEffect(
  db: DatabaseSync,
  sessionId: string,
  instanceId: string,
  stageId: string,
): WorkflowEffectRecord | null {
  const value = body(db, sessionId, effectKind(instanceId, stageId));
  if (!value) return null;
  const r = signed(value) as unknown as WorkflowEffectRecord;
  if (
    r.version !== 1 ||
    r.sessionId !== sessionId ||
    r.instanceId !== instanceId ||
    r.stageId !== stageId ||
    !["editor", "validator"].includes(r.role) ||
    ![
      "observed",
      "merge-dispatching",
      "merged",
      "uncertain",
      "paused-import",
    ].includes(r.state)
  )
    effectFail();
  const stage = nativeRevision(db, r.stageRevisionId, r.workspaceId, "stage"),
    owner = stage.owner as WorkflowInstanceRevision["owner"],
    state = stage.stage as WorkflowInstanceRevision["stages"][number];
  if (
    stage.instanceId !== instanceId ||
    owner.sessionId !== sessionId ||
    state.stageId !== stageId ||
    state.state !== "completed" ||
    knowledgeHash(state.child) !== knowledgeHash(r.completion.child) ||
    state.outcomeSha256 !== r.completion.outcomeSha256 ||
    knowledgeHash(state.result) !== knowledgeHash(r.completion.result)
  )
    effectFail();
  const storageValue = body(
    db,
    sessionId,
    childStorageKind(r.completion.child.taskId),
  );
  if (!storageValue) effectFail();
  const storage = validateChildStorageRecord(storageValue),
    child = r.completion.child;
  if (
    !storage.confirmedClose ||
    storage.sha256 !== child.storageSha256 ||
    storage.binding.child.runId !== child.childRunId ||
    storage.binding.child.sessionId !== child.childSessionId ||
    storage.binding.lineage.taskId !== child.taskId ||
    storage.binding.lineage.parentRunId !== owner.runId ||
    storage.binding.lineage.taskFingerprint !== child.taskFingerprint
  )
    effectFail();
  const taskDoc = body(db, sessionId, "engine.child_tasks") as {
    tasks?: Record<string, unknown>[];
  } | null;
  const task = taskDoc?.tasks?.find((t) => t.id === child.taskId);
  if (
    !task ||
    task.state !== "completed" ||
    task.childRunId !== child.childRunId ||
    task.fingerprint !== child.taskFingerprint
  )
    effectFail();
  const instanceHead = db
    .prepare(
      "SELECT revision_id FROM workflow_heads WHERE workspace_id=? AND kind='instance' AND entity_id=?",
    )
    .get(r.workspaceId, r.instanceId);
  if (!instanceHead) effectFail();
  const instance = nativeRevision(
    db,
    String(instanceHead.revision_id),
    r.workspaceId,
    "instance",
  ) as unknown as WorkflowInstanceRevision;
  const definition = nativeRevision(
      db,
      instance.specRevisionId,
      r.workspaceId,
      "spec",
    ).spec as import("./types.js").WorkflowSpec,
    selected = definition.stages.find((s) => s.id === r.stageId);
  if (
    instance.owner.sha256 !== owner.sha256 ||
    r.specSha256 !== instance.specSha256 ||
    !selected ||
    selected.role !== r.role ||
    r.evidence.run.workspaceId !== child.childWorkspaceId ||
    r.files.length < 1 ||
    r.files.length > 32 ||
    r.artifacts.length > 32
  )
    effectFail();
  const header = db
    .prepare(
      "SELECT revision FROM session_documents WHERE session_id=? AND kind=?",
    )
    .get(sessionId, effectKind(instanceId, stageId));
  if (header?.revision !== r.revision) effectFail();
  if (
    r.role === "editor" &&
    !r.evidence.checkpoints.some(
      (c) =>
        c.kind === "patch" &&
        !c.incomplete &&
        c.runId === child.childRunId &&
        r.evidence.snapshot.tools.some(
          (t) => t.id === c.toolCallId && t.name === "apply_patch",
        ),
    )
  )
    effectFail();
  if (
    r.role === "validator" &&
    (!selected.verification ||
      selected.verification.checkIds.some(
        (id) =>
          !r.evidence.verification?.receipts.some(
            (receipt) =>
              receipt.checkId === id &&
              receipt.status === "pass" &&
              receipt.sourceStale === false,
          ),
      ))
  )
    effectFail("WORKFLOW_VERIFICATION_FAILED");
  signed(r.evidence);
  signed(r.completion);
  if (
    r.evidence.run.id !== r.completion.child.childRunId ||
    r.evidence.run.sessionId !== r.completion.child.childSessionId ||
    r.evidence.snapshot.session.id !== r.evidence.run.sessionId ||
    r.evidence.snapshot.session.workspaceId !==
      r.completion.child.childWorkspaceId
  )
    effectFail();
  if (
    r.completion.state !== "completed" ||
    !r.completion.complete ||
    r.evidence.run.state !== "completed" ||
    r.evidence.cleanups.some(
      (c) => c.state !== "confirmed" || !c.cleanupConfirmed,
    ) ||
    r.evidence.attempts.some((a) => a.state !== "completed")
  )
    effectFail();
  if (
    r.evidence.turns.length !== r.completion.usage.turns ||
    r.evidence.snapshot.tools.length !== r.completion.usage.toolCalls ||
    r.completion.usage.turns > child.allocation.turns ||
    r.completion.usage.toolCalls > child.allocation.toolCalls ||
    r.completion.usage.outputBytes > child.allocation.outputBytes
  )
    effectFail();
  for (const turn of r.evidence.turns) {
    if (
      turn.runId !== child.childRunId ||
      turn.sessionId !== child.childSessionId ||
      turn.state !== "completed"
    )
      effectFail();
  }
  for (const tool of r.evidence.snapshot.tools) {
    const part = r.evidence.parts.find(
      (p) => p.type === "tool" && p.toolCallId === tool.id,
    );
    if (
      tool.runId !== child.childRunId ||
      tool.sessionId !== child.childSessionId ||
      !child.tools.includes(tool.name) ||
      tool.state !== "completed" ||
      !part ||
      part.state !== "completed" ||
      part.runId !== r.evidence.run.id ||
      !r.evidence.turns.some((t) => t.id === part.turnId)
    )
      effectFail();
  }
  for (const check of r.evidence.verification?.receipts ?? []) {
    const tool = r.evidence.snapshot.tools.find(
      (t) => t.id === check.toolCallId,
    );
    if (
      check.phase !== "settled" ||
      check.status !== "pass" ||
      !check.observation?.cleanup.confirmed ||
      !check.observation.executionComplete ||
      !tool ||
      tool.name !== "verify_changes"
    )
      effectFail("WORKFLOW_VERIFICATION_FAILED");
  }
  anchor(db, sessionId, "workflow.effect.recorded", r.sha256, r);
  if (r.state === "merged") {
    if (!r.merge || r.merge.runId !== owner.runId) effectFail();
    const tool = db
      .prepare("SELECT run_id,state,data FROM tools WHERE id=?")
      .get(r.merge.toolCallId);
    if (!tool || tool.run_id !== r.merge.runId || tool.state !== "completed")
      effectFail();
    const native = JSON.parse(String(tool.data));
    if (
      native.name !== "merge_workflow_stage" ||
      native.runId !== r.merge.runId ||
      native.sessionId !== r.sessionId ||
      native.input.stageId !== r.stageId
    )
      effectFail();
    const approval = db
      .prepare("SELECT data FROM approvals WHERE id=?")
      .get(r.merge.approvalId);
    if (!approval) effectFail();
    const a = JSON.parse(String(approval.data));
    if (
      a.status !== "allowed" ||
      a.fingerprint !== r.merge.preparedFingerprint ||
      a.toolCallId !== native.id
    )
      effectFail();
    const parts = db
      .prepare(
        "SELECT length(CAST(data AS BLOB)) bytes,data FROM message_parts WHERE turn_id=? AND json_extract(data,'$.toolCallId')=? LIMIT 3",
      )
      .all(r.merge.turnId, r.merge.toolCallId);
    if (parts.length !== 1 || Number(parts[0]!.bytes) > 65536) effectFail();
    const part = JSON.parse(String(parts[0]!.data));
    if (
      part.type !== "tool" ||
      part.runId !== r.merge.runId ||
      part.turnId !== r.merge.turnId ||
      part.state !== "completed"
    )
      effectFail();
    if (!r.merge.checkpointIds.length || !r.merge.parentFiles.length)
      effectFail();
    for (const id of r.merge.checkpointIds) {
      const cp = db.prepare("SELECT data FROM checkpoints WHERE id=?").get(id);
      if (!cp) effectFail();
      const c = JSON.parse(String(cp.data));
      if (
        c.runId !== r.merge.runId ||
        c.toolCallId !== r.merge.toolCallId ||
        c.incomplete
      )
        effectFail();
      const root = JSON.parse(
        String(
          db
            .prepare("SELECT data FROM workspaces WHERE id=?")
            .get(r.workspaceId)!.data,
        ),
      ).root;
      for (const f of c.files)
        if (
          f.afterHash === null ||
          !r.merge.parentFiles.some(
            (p) => p.path === root + "/" + f.path && p.sha256 === f.afterHash,
          )
        )
          effectFail();
    }
  }
  return r;
}
export function readWorkflowDelivery(
  db: DatabaseSync,
  sessionId: string,
  instanceId: string,
): WorkflowDeliveryRecord | null {
  const value = body(db, sessionId, deliveryKind(instanceId));
  if (!value) return null;
  const r = signed(value) as unknown as WorkflowDeliveryRecord;
  if (
    r.version !== 1 ||
    r.sessionId !== sessionId ||
    r.instanceId !== instanceId ||
    !["accepted", "paused-import"].includes(r.state) ||
    r.source.state !== "completed"
  )
    effectFail();
  anchor(db, sessionId, "workflow.result.admitted", r.sha256, r);
  const source = nativeRevision(db, r.source.id, r.workspaceId, "instance");
  if (
    knowledgeHash(source) !== knowledgeHash(r.source) ||
    r.source.owner.sessionId !== sessionId ||
    r.target.sessionId !== sessionId ||
    r.target.workspaceId !== r.workspaceId ||
    r.prompt !==
      formatWorkflowResult({
        version: 1,
        source: r.source,
        effects: r.effects,
        target: r.target,
        sha256: "",
      })
  )
    effectFail();
  for (const effect of r.effects) {
    const current = readWorkflowEffect(
      db,
      sessionId,
      instanceId,
      effect.stageId,
    );
    if (
      !current ||
      (current.state !== "paused-import" && current.sha256 !== effect.sha256) ||
      (effect.role === "editor" && effect.state !== "merged")
    )
      effectFail();
  }
  const row = db
    .prepare("SELECT data FROM session_inputs WHERE id=?")
    .get(r.input.inputId);
  if (!row) effectFail();
  const input = JSON.parse(String(row.data));
  if (
    input.sessionId !== r.sessionId ||
    input.requestId !== r.inputRequestId ||
    input.prompt !== r.prompt ||
    knowledgeHash(input.config) !== knowledgeHash(r.target.config) ||
    input.admittedSeq !== r.input.admittedSeq
  )
    effectFail();
  const admitted = db
    .prepare(
      "SELECT data FROM session_events WHERE session_id=? AND seq=? AND type='input.accepted'",
    )
    .get(r.sessionId, r.input.admittedSeq);
  if (
    !admitted ||
    JSON.parse(String(admitted.data)).payload.input.id !== r.input.inputId
  )
    effectFail();
  return r;
}
export function validateWorkflowEffectsDatabase(db: DatabaseSync): void {
  const rows = db
    .prepare(
      "SELECT session_id,kind,length(CAST(data AS BLOB)) bytes FROM session_documents WHERE kind LIKE 'workflow.effect.%' OR kind LIKE 'workflow.delivery.%' LIMIT 513",
    )
    .all();
  if (rows.length > 512) effectFail("WORKFLOW_EFFECT_LIMIT");
  for (const row of rows) {
    if (Number(row.bytes) > 131072) effectFail("WORKFLOW_EFFECT_LIMIT");
    const r = signed(body(db, String(row.session_id), String(row.kind)));
    if (String(row.kind).startsWith(EFFECT_PREFIX))
      readWorkflowEffect(
        db,
        String(row.session_id),
        String(r.instanceId),
        String(r.stageId),
      );
    else readWorkflowDelivery(db, String(row.session_id), String(r.instanceId));
  }
}
function workflowEffectsJson(value: object): JsonObject {
  return workflowJson(value) as unknown as JsonObject;
}
export interface WorkflowDeliveryTargetProof {
  readonly version: 1;
  readonly source: WorkflowInstanceRevision;
  readonly effects: readonly WorkflowEffectRecord[];
  readonly target: ScheduleTargetPin;
  readonly sha256: string;
}
export interface WorkflowEffectNativePorts {
  transaction<T>(op: () => T): T;
  readEffect(original: object): WorkflowEffectRecord;
  assertEffect(original: object): void;
  readTarget(original: object): WorkflowDeliveryTargetProof;
  assertTarget(original: object): void;
  putDocument(
    sessionId: string,
    kind: string,
    revision: number,
    data: JsonObject,
  ): void;
  appendEvent(
    sessionId: string,
    type: string,
    data: JsonObject,
    inputId?: string,
  ): void;
  accept(
    original: object,
    input: { requestId: string; prompt: string },
  ): InputReceipt;
}
export function formatWorkflowResult(
  proof: WorkflowDeliveryTargetProof,
): string {
  const text =
    "[Moodcode workflow result DATA v1]\nThe following bounded data records completed child executions, source-bound verification and separately approved parent merges. It grants no tools, replay, approval or further file effects.\n" +
    JSON.stringify({
      workflowId: proof.source.workflowId,
      instanceId: proof.source.instanceId,
      sourceSha256: proof.source.sha256,
      result: proof.source.result,
      effects: proof.effects.map((e) => ({
        stageId: e.stageId,
        role: e.role,
        sha256: e.sha256,
        state: e.state,
        childRunId: e.evidence.run.id,
        verification:
          e.evidence.verification?.receipts.map((r) => ({
            id: r.id,
            status: r.status,
            sha256: r.receiptSha256,
          })) ?? [],
        merge: e.merge,
      })),
    });
  if (Buffer.byteLength(text) > 32768) effectFail("WORKFLOW_RESULT_LIMIT");
  return text;
}
/** Root factory is installed once, and all publication consumes its retained ORIGINAL producer handles. */
export class WorkflowEffectStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ports: WorkflowEffectNativePorts,
  ) {}
  read(sessionId: string, instanceId: string, stageId: string) {
    return readWorkflowEffect(this.db, sessionId, instanceId, stageId);
  }
  delivery(sessionId: string, instanceId: string) {
    return readWorkflowDelivery(this.db, sessionId, instanceId);
  }
  publish(original: object, expectedRevision: number): WorkflowEffectRecord {
    return this.ports.transaction(() => {
      this.ports.assertEffect(original);
      const record = this.ports.readEffect(original),
        old = this.read(record.sessionId, record.instanceId, record.stageId);
      if (
        (old?.revision ?? 0) !== expectedRevision ||
        record.revision !== expectedRevision + 1 ||
        record.previousSha256 !== (old?.sha256 ?? null)
      )
        effectFail("WORKFLOW_EFFECT_STALE");
      const count = Number(
        this.db
          .prepare(
            "SELECT count(*) n FROM session_documents WHERE kind LIKE 'workflow.effect.%' OR kind LIKE 'workflow.delivery.%'",
          )
          .get()!.n,
      );
      if (!old && count >= 512) effectFail("WORKFLOW_EFFECT_LIMIT");
      this.ports.putDocument(
        record.sessionId,
        effectKind(record.instanceId, record.stageId),
        expectedRevision,
        workflowEffectsJson(record),
      );
      this.ports.appendEvent(record.sessionId, "workflow.effect.recorded", {
        record: workflowEffectsJson(record),
      });
      return this.read(record.sessionId, record.instanceId, record.stageId)!;
    });
  }
  deliver(
    original: object,
    input: {
      workspaceId: string;
      instanceId: string;
      requestId: string;
      targetSha256: string;
      expectedRevision: 0;
    },
  ): { record: WorkflowDeliveryRecord; duplicate: boolean } {
    return this.ports.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT session_id,kind,length(CAST(data AS BLOB)) bytes FROM session_documents WHERE kind=? LIMIT 3",
        )
        .all(deliveryKind(input.instanceId));
      if (rows.length > 1) effectFail();
      if (rows.length) {
        const prior = this.delivery(
          String(rows[0]!.session_id),
          input.instanceId,
        )!;
        if (
          prior.state !== "accepted" ||
          prior.workspaceId !== input.workspaceId ||
          prior.requestId !== input.requestId ||
          knowledgeHash({
            version: 1,
            source: prior.source,
            effects: prior.effects,
            target: prior.target,
          }) !== input.targetSha256
        )
          effectFail("WORKFLOW_REQUEST_CONFLICT");
        return { record: prior, duplicate: true };
      }
      this.ports.assertTarget(original);
      const proof = this.ports.readTarget(original);
      if (
        proof.sha256 !== input.targetSha256 ||
        proof.source.workspaceId !== input.workspaceId ||
        proof.source.instanceId !== input.instanceId ||
        proof.source.state !== "completed"
      )
        effectFail("WORKFLOW_DELIVERY_STALE");
      for (const editor of proof.effects.filter((e) => e.role === "editor"))
        if (editor.state !== "merged") effectFail("WORKFLOW_MERGE_REQUIRED");
      const requestId = `workflow-result:${proof.source.instanceId}:${knowledgeHash({ source: proof.source.sha256, effects: proof.effects.map((e) => e.sha256) })}`;
      const prompt = formatWorkflowResult(proof),
        accepted = this.ports.accept(original, { requestId, prompt });
      if (
        accepted.duplicate ||
        accepted.state !== "pending" ||
        accepted.runId !== undefined
      )
        effectFail("WORKFLOW_DELIVERY_CONFLICT");
      const record = signEffect({
        version: 1 as const,
        instanceId: input.instanceId,
        workspaceId: input.workspaceId,
        sessionId: proof.target.sessionId,
        source: proof.source,
        effects: proof.effects,
        target: proof.target,
        prompt,
        inputRequestId: requestId,
        requestId: input.requestId,
        input: accepted,
        state: "accepted" as const,
      });
      this.ports.putDocument(
        record.sessionId,
        deliveryKind(record.instanceId),
        0,
        workflowEffectsJson(record),
      );
      this.ports.appendEvent(
        record.sessionId,
        "workflow.result.admitted",
        { record: workflowEffectsJson(record) },
        record.input.inputId,
      );
      return {
        record: this.delivery(record.sessionId, record.instanceId)!,
        duplicate: false,
      };
    });
  }
  findInput(inputId: string, requestId: string): WorkflowDeliveryRecord | null {
    const rows = this.db
      .prepare(
        "SELECT session_id,data FROM session_events WHERE type='workflow.result.admitted' AND input_id=? LIMIT 3",
      )
      .all(inputId);
    if (rows.length > 1) effectFail();
    if (rows.length) {
      const event = JSON.parse(String(rows[0]!.data)),
        r = event.payload.record;
      return this.delivery(String(rows[0]!.session_id), String(r.instanceId));
    }
    if (requestId.startsWith("workflow-result:"))
      effectFail("WORKFLOW_DELIVERY_MISSING");
    return null;
  }
  validate() {
    validateWorkflowEffectsDatabase(this.db);
  }
  recover(): void {
    this.ports.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT session_id,kind FROM session_documents WHERE kind LIKE 'workflow.effect.%' LIMIT 513",
        )
        .all();
      if (rows.length > 512) effectFail("WORKFLOW_EFFECT_LIMIT");
      for (const row of rows) {
        const value = signed(
          body(this.db, String(row.session_id), String(row.kind)),
        ) as unknown as WorkflowEffectRecord;
        if (value.state !== "merge-dispatching") continue;
        const next = signEffect({
          ...value,
          state: "uncertain" as const,
          revision: value.revision + 1,
          previousSha256: value.sha256,
        });
        this.ports.putDocument(
          next.sessionId,
          String(row.kind),
          value.revision,
          workflowEffectsJson(next),
        );
        this.ports.appendEvent(next.sessionId, "workflow.effect.recorded", {
          record: workflowEffectsJson(next),
        });
      }
    });
  }
}
export function pauseImportedWorkflowEffects(
  db: DatabaseSync,
  workspaceId: string,
  ports: Pick<WorkflowEffectNativePorts, "putDocument" | "appendEvent">,
): void {
  const rows = db
    .prepare(
      "SELECT d.session_id,d.kind FROM session_documents d JOIN sessions s ON s.id=d.session_id WHERE s.workspace_id=? AND (d.kind LIKE 'workflow.effect.%' OR d.kind LIKE 'workflow.delivery.%') LIMIT 513",
    )
    .all(workspaceId);
  if (rows.length > 512) effectFail("WORKFLOW_EFFECT_LIMIT");
  for (const row of rows) {
    const data = signed(body(db, String(row.session_id), String(row.kind)));
    if (data.state === "paused-import") continue;
    const effect = String(row.kind).startsWith(EFFECT_PREFIX),
      next = signEffect({
        ...data,
        state: "paused-import",
        ...(effect
          ? { revision: Number(data.revision) + 1, previousSha256: data.sha256 }
          : {}),
      });
    const header = db
      .prepare(
        "SELECT revision FROM session_documents WHERE session_id=? AND kind=?",
      )
      .get(row.session_id!, row.kind!)!;
    ports.putDocument(
      String(row.session_id),
      String(row.kind),
      Number(header.revision),
      next as JsonObject,
    );
    ports.appendEvent(
      String(row.session_id),
      effect ? "workflow.effect.recorded" : "workflow.result.admitted",
      { record: next as JsonObject },
      effect
        ? undefined
        : String((data.input as unknown as InputReceipt).inputId),
    );
  }
}

export function hasWorkflowEffectUncertainty(
  db: DatabaseSync,
  workspaceId: string,
): boolean {
  return !!db
    .prepare(
      "SELECT 1 FROM session_documents d JOIN sessions s ON s.id=d.session_id WHERE s.workspace_id=? AND d.kind LIKE 'workflow.effect.%' AND (json_extract(d.data,'$.state') IN ('uncertain','merge-dispatching') OR json_extract(d.data,'$.state')='paused-import' AND json_extract(d.data,'$.merge') IS NOT NULL AND json_array_length(json_extract(d.data,'$.merge.checkpointIds'))=0) LIMIT 1",
    )
    .get(workspaceId);
}
