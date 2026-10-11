import { isAbsolute } from "node:path";
import type { ExecutionLockMarker } from "../tools/command/execution-lock.js";
import type { DatabaseSync } from "node:sqlite";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  findEventPayloads,
  type EventSearch,
} from "../storage/native-records.js";
import { planPreparedResources } from "./claims.js";
import { jobJson } from "../jobs/validation.js";
import type { EffectBatchRecord } from "./types.js";
export const EFFECT_BATCH_LIMITS = Object.freeze({
  members: 4,
  records: 256,
  nativeBytes: 131072,
  revisions: 32,
});
const effectBatchKind = (id: string) => `effect.batch.${id}`;
const fail = (): never => {
  throw new EngineError(
    "EFFECT_BATCH_EVIDENCE_INVALID",
    "Prepared effect batch native evidence is inconsistent",
  );
};
export function signEffectBatch(
  value: Omit<EffectBatchRecord, "sha256">,
): EffectBatchRecord {
  const { sha256: ignored, ...body } = value as EffectBatchRecord;
  return { ...body, sha256: knowledgeHash(body) };
}
export function validateEffectBatch(value: unknown): EffectBatchRecord {
  let r: EffectBatchRecord;
  try {
    r = jobJson(value, EFFECT_BATCH_LIMITS.nativeBytes) as EffectBatchRecord;
  } catch {
    return fail();
  }
  if (
    !r ||
    r.version !== 1 ||
    typeof r.id !== "string" ||
    !/^[a-f0-9]{32}$/.test(r.id) ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 1 ||
    r.revision > EFFECT_BATCH_LIMITS.revisions ||
    ![
      "preparing",
      "prepared",
      "running",
      "completed",
      "partial",
      "uncertain",
      "paused-import",
    ].includes(r.state) ||
    !["parallel", "serial"].includes(r.mode) ||
    !Array.isArray(r.members) ||
    r.members.length < 1 ||
    r.members.length > EFFECT_BATCH_LIMITS.members
  )
    fail();
  const { sha256, ...body } = r;
  if (knowledgeHash(body) !== sha256) fail();
  for (const id of [r.workspaceId, r.sessionId, r.runId, r.turnId, r.attemptId])
    if (typeof id !== "string" || !id || Buffer.byteLength(id) > 256) fail();
  if (
    r.budget.toolCalls !== r.members.length ||
    Object.values(r.budget).some((v) => !Number.isSafeInteger(v) || v < 1) ||
    new Set(r.members.map((m) => m.providerCallId)).size !== r.members.length
  )
    fail();
  for (const m of r.members) {
    if (
      !m.toolCallId ||
      !m.providerCallId ||
      !m.toolName ||
      !Number.isSafeInteger(m.wave) ||
      m.wave < 0 ||
      m.wave >= r.members.length ||
      ![
        "proposed",
        "prepared",
        "running",
        "completed",
        "failed",
        "denied",
        "cancelled",
        "uncertain",
      ].includes(m.state) ||
      !Number.isSafeInteger(m.outputBytes) ||
      m.outputBytes < 0 ||
      m.checkpointIds.length > 32 ||
      m.checkpointSha256.length !== m.checkpointIds.length
    )
      fail();
    if (m.claim) {
      const { sha256, ...claim } = m.claim;
      if (
        knowledgeHash(claim) !== sha256 ||
        claim.producer !== "physical-patch" ||
        claim.workspaceId !== r.workspaceId ||
        !claim.files.length ||
        claim.files.length > 32
      )
        fail();
    }
  }
  const plan = planPreparedResources(r.members);
  if (
    r.mode !== plan.mode ||
    knowledgeHash(r.fallback) !== knowledgeHash(plan.fallback) ||
    r.members.some((m, i) => m.wave !== plan.waves[i]) ||
    r.members.reduce((sum, m) => sum + m.outputBytes, 0) > r.budget.outputBytes
  )
    fail();
  if (
    !isAbsolute(r.executionLockPath) ||
    r.executionLockPath.includes("\0") ||
    Buffer.byteLength(r.executionLockPath) > 8192 ||
    (r.lockEpoch !== null &&
      (typeof r.lockEpoch !== "string" ||
        !Number.isFinite(Date.parse(r.lockEpoch)) ||
        !Number.isSafeInteger(r.lockOwnerPid) ||
        r.lockOwnerPid! < 1))
  )
    fail();
  if (
    typeof r.lockReleased !== "boolean" ||
    (r.state === "completed" && !r.lockReleased)
  )
    fail();
  if (
    r.state === "partial" &&
    (!r.lockReleased ||
      r.members.some(
        (m) =>
          !["completed", "failed", "denied", "cancelled"].includes(m.state) ||
          m.cleanupConfirmed !== true,
      ))
  )
    fail();
  if (
    r.state === "completed" &&
    r.members.some(
      (m) => m.state !== "completed" || m.cleanupConfirmed !== true,
    )
  )
    fail();
  return r;
}
function body(
  db: DatabaseSync,
  table: string,
  id: string,
): Record<string, unknown> {
  const h = db
    .prepare(`SELECT length(CAST(data AS BLOB)) bytes FROM ${table} WHERE id=?`)
    .get(id);
  const maximum =
    table === "checkpoints"
      ? 8 * 1024 * 1024 + 131072
      : table === "tools"
        ? 4 * 1024 * 1024 + 131072
        : EFFECT_BATCH_LIMITS.nativeBytes;
  if (!h || Number(h.bytes) > maximum) fail();
  return JSON.parse(
    String(db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id)!.data),
  );
}
/** The payload of the one bounded event matching the search. */
function onlyEvent(
  db: DatabaseSync,
  search: Omit<EventSearch, "maxRows" | "maxRowBytes">,
): JsonObject {
  const events = findEventPayloads(
    db,
    { ...search, maxRows: 1, maxRowBytes: EFFECT_BATCH_LIMITS.nativeBytes },
    { limit: fail, invalid: fail },
  );
  return events[0] ?? fail();
}
function relation(db: DatabaseSync, r: EffectBatchRecord): void {
  const run = db
      .prepare("SELECT workspace_id,session_id FROM runs WHERE id=?")
      .get(r.runId),
    turn = db
      .prepare("SELECT run_id,session_id FROM session_turns WHERE id=?")
      .get(r.turnId),
    attempt = db
      .prepare(
        "SELECT run_id,session_id,turn_id FROM provider_attempts WHERE id=?",
      )
      .get(r.attemptId);
  if (
    run?.workspace_id !== r.workspaceId ||
    run.session_id !== r.sessionId ||
    turn?.run_id !== r.runId ||
    turn.session_id !== r.sessionId ||
    attempt?.run_id !== r.runId ||
    attempt.session_id !== r.sessionId ||
    attempt.turn_id !== r.turnId
  )
    fail();
  const actualRun = body(db, "runs", r.runId);
  if (knowledgeHash(actualRun.config) !== r.configSha256) fail();
  for (const m of r.members) {
    const t = db
      .prepare("SELECT session_id,run_id,state FROM tools WHERE id=?")
      .get(m.toolCallId!);
    if (t?.session_id !== r.sessionId || t.run_id !== r.runId) fail();
    const tool = body(db, "tools", m.toolCallId!);
    if (
      tool.name !== m.toolName ||
      (m.outputSha256 !== null &&
        m.outputSha256 !== knowledgeHash(tool.output ?? null))
    )
      fail();
    if (m.approvalId) {
      const a = body(db, "approvals", m.approvalId);
      if (
        a.runId !== r.runId ||
        a.sessionId !== r.sessionId ||
        a.toolCallId !== m.toolCallId ||
        a.toolName !== m.toolName ||
        a.fingerprint !== m.fingerprint ||
        a.status !== "allowed"
      )
        fail();
    }
    for (const [index, id] of m.checkpointIds.entries()) {
      const c = body(db, "checkpoints", id);
      if (knowledgeHash(c) !== m.checkpointSha256[index]) fail();
      if (
        c.runId !== r.runId ||
        c.toolCallId !== m.toolCallId ||
        c.kind !== "patch"
      )
        fail();
      if (m.claim && m.state === "completed") {
        if (c.incomplete === true) fail();
        for (const file of c.files as {
          path: string;
          beforeHash: string;
          afterHash: string;
        }[]) {
          const pin = m.claim.files.find((p) => p.path === file.path);
          if (
            !pin ||
            pin.beforeHash !== file.beforeHash ||
            pin.afterHash !== file.afterHash
          )
            fail();
        }
      }
    }
    if (
      m.startedAt &&
      m.claim &&
      m.state === "completed" &&
      m.checkpointIds.length !== 1
    )
      fail();
    if (
      ["completed", "failed", "denied"].includes(m.state) &&
      r.state !== "paused-import"
    ) {
      if (t!.state !== m.state) fail();
      const headers = db
        .prepare(
          "SELECT id,length(CAST(data AS BLOB)) bytes FROM message_parts WHERE turn_id=? AND run_id=? AND instr(data,?)>0 LIMIT 65",
        )
        .all(r.turnId, r.runId, m.toolCallId!);
      if (
        headers.length > 64 ||
        headers.reduce((sum, p) => sum + Number(p.bytes), 0) > 16 * 1024 * 1024
      )
        fail();
      if (
        !headers.some((h) => {
          if (Number(h.bytes) > 4 * 1024 * 1024 + 131072) fail();
          const p = db
            .prepare("SELECT data FROM message_parts WHERE id=?")
            .get(h.id!);
          if (!p) fail();
          const part = JSON.parse(String(p!.data));
          return (
            part.type === "tool" &&
            part.toolCallId === m.toolCallId &&
            ["completed", "failed"].includes(part.state) &&
            part.providerCallId === m.providerCallId &&
            knowledgeHash(part.input) === knowledgeHash(tool.input) &&
            part.result?.output === tool.output
          );
        })
      )
        fail();
    }
    if (m.fingerprint) {
      const payload = onlyEvent(db, {
        sessionId: r.sessionId,
        type: "effect.batch.resource_prepared",
        refs: { runId: r.runId, turnId: r.turnId, attemptId: r.attemptId },
        contains: m.toolCallId!,
      });
      if (
        payload.toolCallId !== m.toolCallId ||
        payload.providerCallId !== m.providerCallId ||
        payload.fingerprint !== m.fingerprint ||
        payload.inputSha256 !== knowledgeHash(tool.input) ||
        knowledgeHash(payload.claim) !== knowledgeHash(m.claim)
      )
        fail();
    }
    if (
      ["completed", "failed", "denied", "cancelled"].includes(m.state) ||
      (m.state === "uncertain" && m.endedAt)
    ) {
      const settled = {
        sessionId: r.sessionId,
        type: "effect.batch.member_settled",
        contains: m.toolCallId!,
      };
      const payload = onlyEvent(db, settled);
      // The one settled event must carry no Run.
      onlyEvent(db, { ...settled, refs: { runId: null } });
      if (
        payload.batchId !== r.id ||
        payload.runId !== r.runId ||
        payload.turnId !== r.turnId ||
        payload.attemptId !== r.attemptId ||
        knowledgeHash(payload.member) !== knowledgeHash(m)
      )
        fail();
    }
    if (m.startedAt && m.claim && (!m.approvalId || !m.fingerprint)) fail();
  }
}
export function readEffectBatch(
  db: DatabaseSync,
  sessionId: string,
  id: string,
): EffectBatchRecord | null {
  if (!/^[a-f0-9]{32}$/.test(id))
    throw new EngineError(
      "EFFECT_BATCH_ID_INVALID",
      "Effect batch ID must be the exact native identifier",
    );
  const row = db
    .prepare(
      "SELECT revision,length(CAST(data AS BLOB)) bytes FROM session_documents WHERE session_id=? AND kind=?",
    )
    .get(sessionId, effectBatchKind(id));
  if (!row) return null;
  if (Number(row.bytes) > EFFECT_BATCH_LIMITS.nativeBytes) fail();
  const r = validateEffectBatch(
    JSON.parse(
      String(
        db
          .prepare(
            "SELECT data FROM session_documents WHERE session_id=? AND kind=?",
          )
          .get(sessionId, effectBatchKind(id))!.data,
      ),
    ),
  );
  if (r.sessionId !== sessionId || r.id !== id || r.revision !== row.revision)
    fail();
  const rows = db
    .prepare(
      "SELECT data FROM session_events WHERE session_id=? AND type='effect.batch.recorded' AND instr(data,?)>0 ORDER BY seq LIMIT 33",
    )
    .all(sessionId, id);
  if (rows.length !== r.revision || rows.length > EFFECT_BATCH_LIMITS.revisions)
    fail();
  let prior: EffectBatchRecord | undefined;
  for (const row of rows) {
    if (
      Buffer.byteLength(String(row.data)) >
      EFFECT_BATCH_LIMITS.nativeBytes + 1024
    )
      fail();
    const event = JSON.parse(String(row.data)),
      p = validateEffectBatch(event.payload?.record);
    if (
      p.id !== id ||
      p.revision !== (prior?.revision ?? 0) + 1 ||
      p.previousSha256 !== (prior?.sha256 ?? null) ||
      p.runId !== r.runId ||
      p.turnId !== r.turnId ||
      p.attemptId !== r.attemptId ||
      p.configSha256 !== r.configSha256 ||
      p.catalogueSha256 !== r.catalogueSha256 ||
      p.executionLockPath !== r.executionLockPath ||
      knowledgeHash(p.budget) !== knowledgeHash(r.budget)
    )
      fail();
    if (
      prior &&
      p.members.some((m, i) => {
        const old = prior!.members[i]!;
        return (
          m.providerCallId !== old.providerCallId ||
          m.toolCallId !== old.toolCallId ||
          m.toolName !== old.toolName ||
          m.fingerprint !== old.fingerprint ||
          knowledgeHash(m.claim) !== knowledgeHash(old.claim) ||
          m.wave !== old.wave ||
          (["completed", "failed", "denied", "cancelled", "uncertain"].includes(
            old.state,
          ) &&
            knowledgeHash(m) !== knowledgeHash(old))
        );
      })
    )
      fail();
    prior = p;
  }
  if (prior?.sha256 !== r.sha256) fail();
  relation(db, r);
  return r;
}
export function listEffectBatches(
  db: DatabaseSync,
  workspaceId?: string,
  sessionId?: string,
): EffectBatchRecord[] {
  const rows = db
    .prepare(
      "SELECT d.session_id,d.kind FROM session_documents d JOIN sessions s ON s.id=d.session_id WHERE d.kind GLOB 'effect.batch.*' AND (? IS NULL OR s.workspace_id=?) AND (? IS NULL OR d.session_id=?) LIMIT 257",
    )
    .all(
      workspaceId ?? null,
      workspaceId ?? null,
      sessionId ?? null,
      sessionId ?? null,
    );
  if (rows.length > EFFECT_BATCH_LIMITS.records) fail();
  return rows.map((x) =>
    readEffectBatch(
      db,
      String(x.session_id),
      String(x.kind).slice("effect.batch.".length),
    )!,
  );
}
export function hasUncertainEffectBatches(
  db: DatabaseSync,
  workspaceId: string,
): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM session_documents d JOIN sessions s ON s.id=d.session_id WHERE s.workspace_id=? AND d.kind GLOB 'effect.batch.*' AND (json_extract(d.data,'$.state')='uncertain' OR EXISTS (SELECT 1 FROM json_each(d.data,'$.members') m WHERE json_extract(m.value,'$.state')='uncertain') OR json_extract(d.data,'$.state') IN ('preparing','prepared','running') AND EXISTS (SELECT 1 FROM runs r WHERE r.id=json_extract(d.data,'$.runId') AND r.state IN ('completed','failed','cancelled','interrupted'))) LIMIT 1",
    )
    .get(workspaceId);
  return !!row;
}
export function hasKnownEffectBatchMarker(
  db: DatabaseSync,
  marker: ExecutionLockMarker,
  executionLockPath: string,
): boolean {
  return (
    marker.active &&
    marker.groupPid === null &&
    listEffectBatches(db).some(
      (r) =>
        !r.lockReleased &&
        r.executionLockPath === executionLockPath &&
        r.lockEpoch === marker.updatedAt &&
        r.lockOwnerPid === marker.ownerPid,
    )
  );
}
export function validateEffectBatchDatabase(db: DatabaseSync): void {
  listEffectBatches(db);
}
export interface EffectBatchWritePorts {
  putDocument(
    sessionId: string,
    kind: string,
    revision: number,
    data: JsonObject,
  ): unknown;
  appendEvent(sessionId: string, type: string, data: JsonObject): unknown;
}
export function writeEffectBatch(
  db: DatabaseSync,
  r: EffectBatchRecord,
  ports: EffectBatchWritePorts,
): void {
  validateEffectBatch(r);
  const prior = readEffectBatch(db, r.sessionId, r.id);
  if (
    (prior?.revision ?? 0) !== r.revision - 1 ||
    r.previousSha256 !== (prior?.sha256 ?? null)
  )
    throw new EngineError(
      "EFFECT_BATCH_REVISION_STALE",
      "Effect batch revision changed",
    );
  if (
    !prior &&
    Number(
      db
        .prepare(
          "SELECT count(*) n FROM session_documents WHERE kind GLOB 'effect.batch.*'",
        )
        .get()!.n,
    ) >= EFFECT_BATCH_LIMITS.records
  )
    throw new EngineError(
      "EFFECT_BATCH_LIMIT",
      "Native effect batch bound reached",
    );
  relation(db, r);
  ports.putDocument(
    r.sessionId,
    effectBatchKind(r.id),
    r.revision - 1,
    r as unknown as JsonObject,
  );
  ports.appendEvent(r.sessionId, "effect.batch.recorded", {
    record: r as unknown as JsonObject,
  });
  readEffectBatch(db, r.sessionId, r.id);
}
export function pauseEffectBatches(
  db: DatabaseSync,
  ports: EffectBatchWritePorts,
  workspaceId?: string,
): number {
  let count = 0;
  for (const r of listEffectBatches(db, workspaceId)) {
    if (r.state === "paused-import") continue;
    if (!workspaceId && !["preparing", "prepared", "running"].includes(r.state))
      continue;
    const members = r.members.map((m) =>
      ["proposed", "prepared", "running"].includes(m.state)
        ? {
            ...m,
            state: "uncertain" as const,
            cleanupConfirmed: null,
            endedAt: null,
            errorCode: "EFFECT_BATCH_OWNER_LOST",
          }
        : m,
    );
    writeEffectBatch(
      db,
      signEffectBatch({
        ...r,
        revision: r.revision + 1,
        previousSha256: r.sha256,
        state: workspaceId ? "paused-import" : "uncertain",
        members,
      }),
      ports,
    );
    count++;
  }
  return count;
}
