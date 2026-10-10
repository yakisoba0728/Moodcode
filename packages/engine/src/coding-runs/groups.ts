import type { DatabaseSync } from "node:sqlite";
import type { JsonObject } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import { workflowJson } from "../workflows/spec.js";
import { readWorkflowEffect } from "../workflows/effects-records.js";
import type { CodingAttemptGroup, BatchCaseReceipt } from "./types.js";
import { NATIVE_RECORD_BYTES, batchFail, signBatch } from "./validation.js";
export const groupKind = (id: string) =>
  "coding.group." + knowledgeHash(id).slice(0, 40);
export const caseKind = (group: string, id: string) =>
  "coding.case." + knowledgeHash([group, id]).slice(0, 40);
interface NativePorts {
  transaction<T>(op: () => T): T;
  put(session: string, kind: string, rev: number, data: JsonObject): void;
  event(session: string, type: string, data: JsonObject): void;
}
function body(db: DatabaseSync, session: string, kind: string): unknown {
  const row = db
    .prepare(
      "SELECT revision,length(CAST(data AS BLOB)) bytes FROM session_documents WHERE session_id=? AND kind=?",
    )
    .get(session, kind);
  if (!row) return null;
  if (Number(row.bytes) > NATIVE_RECORD_BYTES)
    batchFail("CODING_EVIDENCE_LIMIT");
  return JSON.parse(
    String(
      db
        .prepare(
          "SELECT data FROM session_documents WHERE session_id=? AND kind=?",
        )
        .get(session, kind)!.data,
    ),
  );
}
function signed<T>(value: unknown): T {
  const v = workflowJson(value) as Record<string, unknown>;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    typeof v.sha256 !== "string"
  )
    batchFail();
  const { sha256, ...rest } = v;
  if (sha256 !== knowledgeHash(rest)) batchFail();
  return v as T;
}
function anchor(
  db: DatabaseSync,
  session: string,
  kind: string,
  record: { sha256: string },
): void {
  const rows = db
    .prepare(
      "SELECT data,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND type=? AND json_extract(data,'$.payload.record.sha256')=? LIMIT 3",
    )
    .all(session, kind, record.sha256);
  if (
    rows.length !== 1 ||
    Number(rows[0]!.bytes) > 524288 ||
    knowledgeHash(JSON.parse(String(rows[0]!.data)).payload.record) !==
      knowledgeHash(record)
  )
    batchFail("CODING_NATIVE_ANCHOR_INVALID");
}
function effectAncestor(
  db: DatabaseSync,
  session: string,
  current: NonNullable<ReturnType<typeof readWorkflowEffect>>,
  wanted: string,
): void {
  const identity = (r: typeof current) =>
    knowledgeHash({
      workspaceId: r.workspaceId,
      sessionId: r.sessionId,
      instanceId: r.instanceId,
      stageId: r.stageId,
      stageRevisionId: r.stageRevisionId,
      specSha256: r.specSha256,
      role: r.role,
      completion: r.completion,
      evidence: r.evidence,
      files: r.files,
      artifacts: r.artifacts,
    });
  for (let depth = 0; depth < 8; depth++) {
    if (current.sha256 === wanted) {
      if (current.state !== "observed")
        batchFail("CODING_EFFECT_LINEAGE_INVALID");
      return;
    }
    if (!current.previousSha256) batchFail("CODING_EFFECT_LINEAGE_INVALID");
    const rows = db
      .prepare(
        "SELECT data,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND type='workflow.effect.recorded' AND json_extract(data,'$.payload.record.sha256')=? LIMIT 3",
      )
      .all(session, current.previousSha256);
    if (rows.length !== 1 || Number(rows[0]!.bytes) > NATIVE_RECORD_BYTES)
      batchFail("CODING_EFFECT_LINEAGE_INVALID");
    const prior = signed<typeof current>(
      JSON.parse(String(rows[0]!.data)).payload.record,
    );
    if (
      prior.revision + 1 !== current.revision ||
      identity(prior) !== identity(current)
    )
      batchFail("CODING_EFFECT_LINEAGE_INVALID");
    current = prior;
  }
  batchFail("CODING_EFFECT_LINEAGE_INVALID");
}
export function readBatchCase(
  db: DatabaseSync,
  session: string,
  groupId: string,
  caseId: string,
): BatchCaseReceipt | null {
  const v = body(db, session, caseKind(groupId, caseId));
  if (!v) return null;
  const r = signed<BatchCaseReceipt>(v);
  if (
    r.version !== 1 ||
    r.sessionId !== session ||
    r.groupId !== groupId ||
    r.caseId !== caseId ||
    r.instance.owner.sessionId !== session ||
    r.instance.state !== "completed" ||
    r.reviewer.run.state !== "completed" ||
    r.completion.state !== "completed" ||
    !r.completion.complete ||
    r.completion.child.childRunId !== r.reviewer.run.id ||
    r.reviewer.cleanups.some(
      (c) => c.state !== "confirmed" || !c.cleanupConfirmed,
    ) ||
    r.reviewer.snapshot.tools.some(
      (t) =>
        t.state !== "completed" || !r.completion.child.tools.includes(t.name),
    ) ||
    r.reviewer.attempts.some((a) => a.state !== "completed")
  )
    batchFail("CODING_REVIEWER_INVALID");
  const row = db
    .prepare(
      "SELECT data FROM workflow_revisions WHERE id=? AND workspace_id=? AND kind='instance'",
    )
    .get(r.instance.id, r.workspaceId);
  if (
    !row ||
    knowledgeHash(JSON.parse(String(row.data))) !== knowledgeHash(r.instance)
  )
    batchFail("CODING_INSTANCE_INVALID");
  const stage = r.instance.stages.find((s) => s.stageId === "review");
  if (
    !stage?.child ||
    stage.child.sha256 !== r.completion.child.sha256 ||
    stage.outcomeSha256 !== r.completion.outcomeSha256 ||
    r.reviewer.turns.some((t) => t.runId !== r.reviewer.run.id) ||
    r.reviewer.parts.some((p) => p.runId !== r.reviewer.run.id)
  )
    batchFail("CODING_REVIEWER_INVALID");
  const e = readWorkflowEffect(db, session, r.instance.instanceId, "edit"),
    check = readWorkflowEffect(db, session, r.instance.instanceId, "validate");
  if (!e || !check) batchFail("CODING_VERIFICATION_INVALID");
  effectAncestor(db, session, e, r.editorSha256);
  effectAncestor(db, session, check, r.validatorSha256);
  anchor(db, session, "coding.case.verified", r);
  return r;
}
export function readBatchGroup(
  db: DatabaseSync,
  session: string,
  id: string,
): CodingAttemptGroup | null {
  const v = body(db, session, groupKind(id));
  if (!v) return null;
  const r = signed<CodingAttemptGroup>(v);
  if (
    r.version !== 1 ||
    r.groupId !== id ||
    r.sessionId !== session ||
    r.preview.input.rootSessionId !== session ||
    r.preview.input.parentRunId !== r.parentRunId ||
    r.preview.input.workspaceId !== r.workspaceId ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 1 ||
    r.cases.length !== r.preview.input.cases.length ||
    r.cases.length > 4 ||
    ![
      "running",
      "ready",
      "completed",
      "cancelled",
      "uncertain",
      "paused-import",
    ].includes(r.state)
  )
    batchFail();
  signed(r.preview);
  const row = db
    .prepare(
      "SELECT revision FROM session_documents WHERE session_id=? AND kind=?",
    )
    .get(session, groupKind(id));
  if (Number(row?.revision) !== r.revision) batchFail();
  const parent = db
    .prepare("SELECT data FROM runs WHERE id=?")
    .get(r.parentRunId);
  if (!parent || JSON.parse(String(parent.data)).sessionId !== session)
    batchFail();
  for (const c of r.cases) {
    if (
      ![
        "pending",
        "running",
        "verified",
        "failed",
        "skipped",
        "cancelled",
        "uncertain",
      ].includes(c.state) ||
      !r.preview.input.cases.some((i) => i.id === c.id)
    )
      batchFail();
    const w = db
      .prepare(
        "SELECT data FROM workflow_heads h JOIN workflow_revisions r ON r.id=h.revision_id WHERE h.workspace_id=? AND h.kind='instance' AND h.entity_id=?",
      )
      .get(r.workspaceId, c.instanceId);
    if (!w || JSON.parse(String(w.data)).owner.runId !== r.parentRunId)
      batchFail();
    const workflow = JSON.parse(String(w.data));
    if (
      ["pending", "skipped"].includes(c.state) &&
      workflow.stages.some(
        (s: { child: unknown; state: string }) =>
          s.child !== null || !["ready", "blocked"].includes(s.state),
      )
    )
      batchFail("CODING_CASE_REPLAY_INVALID");
    if (c.state === "verified") {
      const receipt = readBatchCase(db, session, id, c.id);
      if (!receipt || receipt.sha256 !== c.receiptSha256) batchFail();
    }
  }
  if (
    r.usage.reservedTokens !== r.preview.reservedTokens ||
    r.usage.chargedCostMicros > r.preview.input.limits.maxCostMicros ||
    r.usage.requests < 0 ||
    !Number.isSafeInteger(r.usage.requests)
  )
    batchFail("CODING_BUDGET_INVALID");
  if (r.selection) {
    signed(r.selection);
    const c = r.cases.find((c) => c.id === r.selection!.caseId);
    if (
      !c ||
      c.state !== "verified" ||
      c.receiptSha256 !== r.selection.caseSha256
    )
      batchFail("CODING_SELECTION_INVALID");
    if (r.selection.state === "merged") {
      const e = readWorkflowEffect(db, session, c.instanceId, "edit");
      if (
        !e ||
        !["merged", "paused-import"].includes(e.state) ||
        (e.sha256 !== r.selection.mergeSha256 && e.state !== "paused-import")
      )
        batchFail("CODING_SELECTION_INVALID");
    }
  }
  if (r.state === "completed" && r.selection?.state !== "merged") batchFail();
  anchor(db, session, "coding.group.recorded", r);
  return r;
}
export function validateCodingBatchDatabase(db: DatabaseSync): void {
  if (
    !db
      .prepare("SELECT name FROM sqlite_schema WHERE name='session_documents'")
      .get()
  )
    return;
  const rows = db
    .prepare(
      "SELECT session_id,kind,length(CAST(data AS BLOB)) bytes FROM session_documents WHERE kind LIKE 'coding.group.%' OR kind LIKE 'coding.case.%' LIMIT 257",
    )
    .all();
  if (rows.length > 256) batchFail("CODING_BATCH_LIMIT");
  for (const row of rows) {
    if (Number(row.bytes) > NATIVE_RECORD_BYTES) batchFail();
    const value = JSON.parse(
      String(
        db
          .prepare(
            "SELECT data FROM session_documents WHERE session_id=? AND kind=?",
          )
          .get(row.session_id!, row.kind!)!.data,
      ),
    );
    if (String(row.kind).startsWith("coding.group."))
      readBatchGroup(db, String(row.session_id), String(value.groupId));
    else
      readBatchCase(
        db,
        String(row.session_id),
        String(value.groupId),
        String(value.caseId),
      );
  }
}
export class CodingBatchStorage {
  constructor(
    readonly db: DatabaseSync,
    readonly ports: NativePorts,
  ) {}
  read(session: string, id: string) {
    return readBatchGroup(this.db, session, id);
  }
  case(session: string, group: string, id: string) {
    return readBatchCase(this.db, session, group, id);
  }
  put(record: CodingAttemptGroup, expected: number): void {
    this.ports.transaction(() => {
      if (
        expected === 0 &&
        Number(
          this.db
            .prepare(
              "SELECT count(*) n FROM session_documents WHERE kind LIKE 'coding.group.%' OR kind LIKE 'coding.case.%'",
            )
            .get()!.n,
        ) >= 256
      )
        batchFail("CODING_BATCH_LIMIT");
      this.ports.put(
        record.sessionId,
        groupKind(record.groupId),
        expected,
        record as unknown as JsonObject,
      );
      this.ports.event(record.sessionId, "coding.group.recorded", {
        record: record as unknown as JsonObject,
      });
      readBatchGroup(this.db, record.sessionId, record.groupId);
    });
  }
  putCase(record: BatchCaseReceipt): void {
    this.ports.transaction(() => {
      if (
        Number(
          this.db
            .prepare(
              "SELECT count(*) n FROM session_documents WHERE kind LIKE 'coding.group.%' OR kind LIKE 'coding.case.%'",
            )
            .get()!.n,
        ) >= 256
      )
        batchFail("CODING_BATCH_LIMIT");
      this.ports.put(
        record.sessionId,
        caseKind(record.groupId, record.caseId),
        0,
        record as unknown as JsonObject,
      );
      this.ports.event(record.sessionId, "coding.case.verified", {
        record: record as unknown as JsonObject,
      });
      readBatchCase(this.db, record.sessionId, record.groupId, record.caseId);
    });
  }
  list(workspace: string): CodingAttemptGroup[] {
    return this.db
      .prepare(
        "SELECT d.session_id,d.data FROM session_documents d JOIN sessions s ON s.id=d.session_id WHERE s.workspace_id=? AND d.kind LIKE 'coding.group.%' LIMIT 33",
      )
      .all(workspace)
      .map((row) => {
        const data = JSON.parse(String(row.data));
        return this.read(String(row.session_id), data.groupId)!;
      });
  }
  sessions(): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT session_id FROM session_documents WHERE kind LIKE 'coding.group.%' LIMIT 257",
      )
      .all();
    if (rows.length > 256) batchFail("CODING_BATCH_LIMIT");
    return rows.map((row) => String(row.session_id));
  }
  recover(): void {
    for (const row of this.db
      .prepare(
        "SELECT session_id,data FROM session_documents WHERE kind LIKE 'coding.group.%' LIMIT 257",
      )
      .all()) {
      const prior = this.read(
        String(row.session_id),
        JSON.parse(String(row.data)).groupId,
      )!;
      if (prior.state === "running" || prior.selection?.state === "selected") {
        this.put(
          signBatch({
            ...prior,
            revision: prior.revision + 1,
            previousSha256: prior.sha256,
            state: "uncertain" as const,
            cases: prior.cases.map((c) =>
              c.state === "running" ? { ...c, state: "uncertain" as const } : c,
            ),
            selection: prior.selection
              ? signBatch({ ...prior.selection, state: "uncertain" as const })
              : null,
          }),
          prior.revision,
        );
      }
    }
  }
  pauseImport(workspace: string): void {
    for (const prior of this.list(workspace)) {
      this.put(
        signBatch({
          ...prior,
          revision: prior.revision + 1,
          previousSha256: prior.sha256,
          state: "paused-import" as const,
        }),
        prior.revision,
      );
    }
  }
}
