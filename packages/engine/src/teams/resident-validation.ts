import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  RESIDENT_KIND_PREFIX,
  validateResidentRecord,
} from "../child-tasks/resident.js";
import {
  TEAM_WORKFLOW_PREFIX,
  teamBoardKind,
  validateTeamBoardRecord,
  type TeamBoardRecord,
  type TeamBoardSubmission,
} from "./workflow-board.js";
import {
  childStorageKind,
  validateChildStorageRecord,
  type ChildStorageRecord,
} from "../child-tasks/storage-binding.js";
function fail(): never {
  throw new EngineError(
    "RESIDENT_HISTORY_INVALID",
    "Resident/team workflow history lacks its exact native source evidence",
  );
}
function validateBoardNative(
  db: DatabaseSync,
  board: TeamBoardRecord,
  submit: TeamBoardSubmission,
  review: boolean,
  taskRevision: number,
): void {
  const actor = review ? submit.review! : submit,
    n = actor.native,
    operation = review ? "review_team_task" : "submit_team_task";
  const toolRow = db
    .prepare(
      "SELECT session_id,run_id,state,data FROM tools WHERE id=? AND length(CAST(data AS BLOB))<=262144",
    )
    .get(n.toolCallId);
  const turn = db
    .prepare("SELECT session_id,run_id FROM session_turns WHERE id=?")
    .get(n.turnId);
  const attempt = db
    .prepare(
      "SELECT session_id,run_id,turn_id FROM provider_attempts WHERE id=?",
    )
    .get(n.attemptId);
  const approvalRow = db
    .prepare(
      "SELECT data FROM approvals WHERE session_id=? AND run_id=? AND tool_call_id=? AND status='allowed' AND json_extract(data,'$.fingerprint')=? AND length(CAST(data AS BLOB))<=262144",
    )
    .get(n.sessionId, n.runId, n.toolCallId, n.approvalFingerprint);
  const parts = db
    .prepare(
      "SELECT data FROM message_parts WHERE session_id=? AND run_id=? AND turn_id=? AND length(CAST(data AS BLOB))<=262144",
    )
    .all(n.sessionId, n.runId, n.turnId);
  if (
    !toolRow ||
    toolRow.session_id !== n.sessionId ||
    toolRow.run_id !== n.runId ||
    !["running", "completed", "failed", "interrupted"].includes(
      String(toolRow.state),
    ) ||
    turn?.session_id !== n.sessionId ||
    turn.run_id !== n.runId ||
    attempt?.session_id !== n.sessionId ||
    attempt.run_id !== n.runId ||
    attempt.turn_id !== n.turnId ||
    !approvalRow
  )
    fail();
  const tool = JSON.parse(String(toolRow.data)),
    approval = JSON.parse(String(approvalRow.data));
  const expected = {
    requestId: actor.requestId,
    taskId: board.taskId,
    expectedRevision: taskRevision,
    text: actor.text,
    ...(review
      ? { submissionId: submit.id, verdict: submit.review!.verdict }
      : {}),
  };
  if (
    tool.id !== n.toolCallId ||
    tool.sessionId !== n.sessionId ||
    tool.runId !== n.runId ||
    tool.name !== operation ||
    tool.state !== toolRow.state ||
    approval.fingerprint !== n.approvalFingerprint ||
    approval.status !== "allowed" ||
    approval.toolName !== operation ||
    approval.preview?.teamModelRequestFingerprint !== n.requestFingerprint ||
    approval.preview?.actor?.memberId !== actor.memberId ||
    approval.preview?.actor?.memberSha256 !== actor.memberSha256 ||
    approval.preview?.actor?.owner?.sha256 !== actor.ownerSha256 ||
    (review &&
      (approval.preview.actor.role !== "coordinator" ||
        approval.preview.actor.permissions?.manageTasks !== true ||
        actor.memberId === submit.memberId)) ||
    knowledgeHash(approval.preview?.request) !== knowledgeHash(expected) ||
    knowledgeHash(tool.input) !== knowledgeHash(expected) ||
    actor.requestSha256 !==
      knowledgeHash({ operation, data: expected, actor: actor.memberSha256 }) ||
    !parts.some((p) => {
      const v = JSON.parse(String(p.data));
      return (
        v.type === "tool" &&
        v.toolCallId === n.toolCallId &&
        v.name === operation &&
        knowledgeHash(v.input) === knowledgeHash(tool.input) &&
        (tool.state !== "completed" || v.state === "completed")
      );
    })
  )
    fail();
}
function rows(db: DatabaseSync) {
  const headers = db
    .prepare(
      "SELECT session_id,kind,revision,length(CAST(data AS BLOB)) bytes FROM session_documents WHERE kind GLOB 'resident.child.*' OR kind GLOB 'team.workflow.*' ORDER BY session_id,kind LIMIT 161",
    )
    .all();
  if (
    headers.length > 160 ||
    headers.reduce((a, x) => a + Number(x.bytes), 0) > 8388608
  )
    fail();
  return headers;
}
/** Pure SQL validation issues no owner, wake, execution handle or authority. */
export function validateResidentTeamDatabase(
  db: DatabaseSync,
  check: () => void = () => {},
): void {
  const headers = rows(db);
  let residents = 0;
  for (const h of headers) {
    check();
    if (Number(h.bytes) > 65536 || Number(h.bytes) < 1) fail();
    const raw = db
      .prepare(
        "SELECT data FROM session_documents WHERE session_id=? AND kind=? AND revision=? AND length(CAST(data AS BLOB))=?",
      )
      .get(
        String(h.session_id),
        String(h.kind),
        Number(h.revision),
        Number(h.bytes),
      );
    if (!raw) fail();
    const parsed = JSON.parse(String(raw.data));
    const docEvent = db
      .prepare(
        "SELECT data FROM session_events WHERE session_id=? AND type='session.document.updated' AND json_extract(data,'$.payload.kind')=? AND json_extract(data,'$.payload.revision')=? ORDER BY seq DESC LIMIT 1",
      )
      .get(String(h.session_id), String(h.kind), Number(h.revision));
    if (
      !docEvent ||
      JSON.parse(String(docEvent.data)).payload.sha256 !==
        createHash("sha256").update(String(raw.data)).digest("hex")
    )
      fail();
    if (String(h.kind).startsWith(RESIDENT_KIND_PREFIX)) {
      const r = validateResidentRecord(parsed);
      if (
        ++residents > 32 ||
        r.rootSessionId !== h.session_id ||
        RESIDENT_KIND_PREFIX + r.taskId !== h.kind ||
        r.revision !== h.revision
      )
        fail();
      const taskrow = db
        .prepare(
          "SELECT data FROM session_documents WHERE session_id=? AND kind='engine.child_tasks' AND length(CAST(data AS BLOB))<=262144",
        )
        .get(r.rootSessionId);
      if (!taskrow) fail();
      const task = JSON.parse(String(taskrow.data)).tasks.find(
        (t: { id: string }) => t.id === r.taskId,
      );
      if (
        !task ||
        task.childRunId !== r.initialRunId ||
        task.parentRunId !== r.parentRunId ||
        knowledgeHash(task.budget) !== knowledgeHash(r.allocation)
      )
        fail();
      const storage = db
        .prepare(
          "SELECT data FROM session_documents WHERE session_id=? AND kind=? AND length(CAST(data AS BLOB))<=32768",
        )
        .get(r.rootSessionId, childStorageKind(r.taskId));
      if (!storage) fail();
      const proof = validateChildStorageRecord(
        JSON.parse(String(storage.data)),
      );
      if (
        proof.sha256 !== r.storageSha256 ||
        proof.binding.child.runId !== r.initialRunId ||
        proof.binding.child.sessionId !== r.childSessionId
      )
        fail();
      const parent = db
        .prepare("SELECT session_id,state FROM runs WHERE id=?")
        .get(r.parentRunId);
      if (!parent || parent.session_id !== r.rootSessionId) fail();
    } else {
      const r = validateTeamBoardRecord(parsed);
      if (
        r.rootSessionId !== h.session_id ||
        teamBoardKind(r.teamId, r.taskId) !== h.kind ||
        r.revision !== h.revision
      )
        fail();
      const task = db
        .prepare(
          "SELECT data FROM team_state_revisions WHERE id=? AND workspace_id=? AND team_id=? AND kind='task' AND length(CAST(data AS BLOB))<=65536",
        )
        .get(r.taskRevisionId, r.workspaceId, r.teamId);
      if (!task || JSON.parse(String(task.data)).sha256 !== r.taskSha256)
        fail();
      const claimedTask = JSON.parse(String(task.data));
      if (
        claimedTask.state !== "claimed" ||
        r.submissions.some(
          (x) =>
            claimedTask.owner?.memberId !== x.memberId ||
            claimedTask.owner?.memberSha256 !== x.memberSha256 ||
            claimedTask.owner?.generation !== x.memberGeneration,
        )
      )
        fail();
      const event = db
        .prepare(
          "SELECT data FROM session_events WHERE session_id=? AND type='team.workflow.committed' AND json_extract(data,'$.payload.kind')=? ORDER BY seq DESC LIMIT 1",
        )
        .get(r.rootSessionId, h.kind);
      if (!event) fail();
      const anchor = JSON.parse(String(event.data)).payload;
      const { sha256, ...body } = r;
      const originalBody = {
        ...body,
        revision: anchor.revision,
        state: r.submissions.at(-1)!.review ? "reviewed" : "submitted",
      };
      const original = { ...originalBody, sha256: knowledgeHash(originalBody) };
      if (
        !Number.isSafeInteger(anchor.revision) ||
        anchor.revision < 1 ||
        anchor.revision > r.revision ||
        (r.state === "paused-import"
          ? r.revision <= anchor.revision
          : r.revision !== anchor.revision) ||
        anchor.dataSha256 !== knowledgeHash(original)
      )
        fail();
      for (const x of r.submissions) {
        for (const actor of [x, x.review].filter((x) => x !== null)) {
          const member = db
            .prepare(
              "SELECT data FROM team_state_revisions WHERE workspace_id=? AND team_id=? AND kind='member' AND json_extract(data,'$.sha256')=? LIMIT 1",
            )
            .get(r.workspaceId, r.teamId, actor!.memberSha256);
          if (!member) fail();
          const m = JSON.parse(String(member.data));
          if (
            m.memberId !== actor!.memberId ||
            m.owner.sha256 !== actor!.ownerSha256 ||
            m.owner.sessionId !== actor!.native.sessionId ||
            (actor === x && m.owner.rootSessionId !== r.rootSessionId)
          )
            fail();
          if (m.owner.kind === "root") {
            if (actor!.native.runId !== m.owner.runId) fail();
            validateBoardNative(
              db,
              r,
              x,
              actor === x.review,
              JSON.parse(String(task.data)).revision,
            );
          }
        }
      }
    }
  }
}
export function validateResidentChildHistory(
  primary: DatabaseSync,
  child: DatabaseSync,
  source: ChildStorageRecord,
  check: () => void = () => {},
): void {
  const doc = primary
    .prepare(
      "SELECT data FROM session_documents WHERE session_id=? AND kind=? AND length(CAST(data AS BLOB))<=65536",
    )
    .get(
      source.binding.lineage.sessionId,
      RESIDENT_KIND_PREFIX + source.binding.lineage.taskId,
    );
  if (!doc) return;
  const record = validateResidentRecord(JSON.parse(String(doc.data)));
  if (record.storageSha256 !== source.sha256) fail();
  for (const h of rows(primary)) {
    if (!String(h.kind).startsWith(TEAM_WORKFLOW_PREFIX)) continue;
    const row = primary
      .prepare(
        "SELECT data FROM session_documents WHERE session_id=? AND kind=?",
      )
      .get(String(h.session_id), String(h.kind))!;
    const board = validateTeamBoardRecord(JSON.parse(String(row.data)));
    const claimed = primary
      .prepare("SELECT data FROM team_state_revisions WHERE id=?")
      .get(board.taskRevisionId)!;
    const task = JSON.parse(String(claimed.data));
    for (const submit of board.submissions)
      for (const [actor, operation] of [
        [submit, "submit_team_task"],
        [submit.review, "review_team_task"],
      ] as const) {
        if (!actor || actor.native.sessionId !== record.childSessionId)
          continue;
        check();
        if (!record.runs.some((x) => x.runId === actor.native.runId)) fail();
        validateBoardNative(
          child,
          board,
          submit,
          operation === "review_team_task",
          task.revision,
        );
      }
  }
  for (const x of record.runs) {
    check();
    const row = child
      .prepare(
        "SELECT id,session_id,workspace_id,state,data FROM runs WHERE id=? AND length(CAST(data AS BLOB))<=262144",
      )
      .get(x.runId);
    if (
      !row ||
      row.session_id !== record.childSessionId ||
      row.workspace_id !== source.binding.child.workspaceId
    )
      fail();
    const run = JSON.parse(String(row.data));
    if (
      run.id !== row.id ||
      run.state !== row.state ||
      knowledgeHash(run.config) !== x.configSha256
    )
      fail();
    if (
      ["completed", "failed", "cancelled"].includes(x.state) &&
      run.state !== x.state
    )
      fail();
    if (x.inputId) {
      const input = child
        .prepare(
          "SELECT id,run_id,session_id,delivery,state,data FROM session_inputs WHERE id=? AND length(CAST(data AS BLOB))<=262144",
        )
        .get(x.inputId);
      if (
        !input ||
        input.run_id !== run.id ||
        input.session_id !== run.sessionId ||
        input.delivery !== "queue" ||
        input.state !== "promoted"
      )
        fail();
      const value = JSON.parse(String(input.data));
      if (
        value.runId !== run.id ||
        knowledgeHash(value.config) !== x.configSha256
      )
        fail();
    }
  }
}
export function pauseResidentTeamHistories(
  db: DatabaseSync,
  workspaceId: string,
  write: (
    sessionId: string,
    kind: string,
    revision: number,
    data: JsonObject,
  ) => void,
): void {
  if (!db.isTransaction) fail();
  for (const h of rows(db)) {
    const session = db
      .prepare("SELECT workspace_id FROM sessions WHERE id=?")
      .get(String(h.session_id));
    if (session?.workspace_id !== workspaceId) continue;
    const row = db
      .prepare(
        "SELECT data FROM session_documents WHERE session_id=? AND kind=?",
      )
      .get(String(h.session_id), String(h.kind))!;
    const r = String(h.kind).startsWith(RESIDENT_KIND_PREFIX)
      ? validateResidentRecord(JSON.parse(String(row.data)))
      : validateTeamBoardRecord(JSON.parse(String(row.data)));
    const { sha256, ...old } = r;
    const body = { ...old, revision: r.revision + 1, state: "paused-import" };
    write(String(h.session_id), String(h.kind), Number(h.revision), {
      ...body,
      sha256: knowledgeHash(body),
    } as unknown as JsonObject);
  }
}

export function assertResidentHistoryCapacity(
  db: DatabaseSync,
  kind: "resident" | "board",
): void {
  const prefix =
    kind === "resident" ? RESIDENT_KIND_PREFIX : TEAM_WORKFLOW_PREFIX;
  const row = db
    .prepare("SELECT count(*) count FROM session_documents WHERE kind GLOB ?")
    .get(prefix + "*")!;
  if (Number(row.count) >= (kind === "resident" ? 32 : 128))
    throw new EngineError(
      "RESIDENT_HISTORY_LIMIT",
      "Native bounded history admission is full; terminal settlement capacity remains reserved",
    );
}
