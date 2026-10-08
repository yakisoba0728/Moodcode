import type { DatabaseSync } from "node:sqlite";
import {
  normalizeAcceptInput,
  validateInputRecord,
} from "@moodcode/contracts/validation";
import {
  validateChildStorageRecord,
  type ChildStorageRecord,
} from "../child-tasks/storage-binding.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { requestIdentity } from "../storage/native-schema.js";
import { teamMailboxInput } from "./input-port.js";
import { TeamStorage } from "./store.js";
import { teamError, teamId, teamInteger } from "./validation.js";

const CHILD_ROW_BYTES = 262144;
function invalid(): never {
  return teamError("TEAM_CHILD_INPUT_INVALID");
}
function parse(data: unknown): Record<string, unknown> {
  if (typeof data !== "string" || Buffer.byteLength(data) > CHILD_ROW_BYTES)
    invalid();
  try {
    // JSON.parse creates ordinary data; row metadata has already bounded the
    // native body. Knowledge-row cloning would incorrectly impose its 64 KiB cap.
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    return value as Record<string, unknown>;
  } catch {
    return invalid();
  }
}

/** Cross-database historical proof only. The caller supplies an already selected child reader. */
export function validateTeamChildInputRelations(
  primary: DatabaseSync,
  child: DatabaseSync,
  record: ChildStorageRecord,
  check: () => void = () => {},
): void {
  record = validateChildStorageRecord(record);
  const binding = record.binding;
  const storage = new TeamStorage(primary, {
    writeTx: () => invalid(),
    getWorkspace: () => invalid(),
    checkBinding: () => invalid(),
    readMemberOwner: () => invalid(),
    assertMemberOwnerCurrent: () => invalid(),
    assertRecipientCurrent: () => invalid(),
    readAcceptedInput: () => invalid(),
  });
  for (const row of primary
    .prepare(
      "SELECT id,workspace_id FROM team_deliveries WHERE workspace_id=? AND state='delivered' ORDER BY id",
    )
    .iterate(binding.worktree.workspaceId)) {
    check();
    const owner = storage.getDelivery(teamId(row.workspace_id), teamId(row.id));
    if (!owner || owner.state !== "delivered") invalid();
    if (
      owner.owner.kind !== "child" ||
      owner.owner.childTaskId !== binding.lineage.taskId
    )
      continue;
    const proof = owner.owner;
    if (
      binding.phase !== "admitted" ||
      !binding.child.runId ||
      proof.childStorageSha256 !== record.sha256 ||
      proof.childTaskFingerprint !== binding.lineage.taskFingerprint ||
      proof.rootSessionId !== binding.lineage.sessionId ||
      proof.rootRunId !== binding.lineage.sourceRunId ||
      proof.sessionId !== binding.child.sessionId ||
      proof.runId !== binding.child.runId ||
      proof.workspaceId !== binding.child.workspaceId ||
      proof.worktreeId !== binding.worktree.id
    )
      invalid();
    const receipt = storage.getDeliveryReceipt(owner.workspaceId, owner.id);
    if (
      !receipt ||
      receipt.deliveryId !== owner.id ||
      receipt.deliverySha256 !== owner.sha256 ||
      receipt.memberId !== owner.memberId ||
      receipt.generation !== owner.generation ||
      receipt.teamId !== owner.teamId ||
      receipt.messagesSha256 !== knowledgeHash(owner.page.messages) ||
      receipt.input.sessionId !== proof.sessionId ||
      (receipt.input.delivery==="steer" && receipt.input.runId !== proof.runId) ||
      receipt.input.requestId !== `team-delivery:${owner.id}`
    )
      invalid();

    const acceptedRunId=receipt.input.runId;
    check();
    const runMeta = child
      .prepare(
        "SELECT runs.id,runs.session_id,runs.workspace_id,runs.state,length(CAST(runs.data AS BLOB)) AS bytes FROM runs JOIN sessions ON sessions.id=runs.session_id WHERE runs.id=? AND sessions.workspace_id=runs.workspace_id",
      )
      .get(acceptedRunId);
    if (
      !runMeta ||
      runMeta.id !== acceptedRunId ||
      runMeta.session_id !== proof.sessionId ||
      runMeta.workspace_id !== proof.workspaceId
    )
      invalid();
    teamInteger(runMeta.bytes, CHILD_ROW_BYTES);
    const run = parse(
      child
        .prepare(
          "SELECT data FROM runs WHERE id=? AND length(CAST(data AS BLOB))<=?",
        )
        .get(acceptedRunId, CHILD_ROW_BYTES)?.data,
    );
    if (
      run.id !== acceptedRunId ||
      run.sessionId !== proof.sessionId ||
      run.workspaceId !== proof.workspaceId ||
      run.state !== runMeta.state
    )
      invalid();

    check();
    const inputMeta = child
      .prepare(
        "SELECT id,session_id,workspace_id,request_id,delivery,state,admitted_seq,promoted_seq,run_id,legacy_seq,bytes,length(CAST(data AS BLOB)) AS body_bytes,length(CAST(fingerprint AS BLOB)) AS fingerprint_bytes FROM session_inputs WHERE id=?",
      )
      .get(receipt.input.inputId);
    if (!inputMeta) invalid();
    teamInteger(inputMeta.body_bytes, CHILD_ROW_BYTES);
    teamInteger(inputMeta.fingerprint_bytes, CHILD_ROW_BYTES);
    const raw = child
      .prepare(
        "SELECT data,fingerprint FROM session_inputs WHERE id=? AND length(CAST(data AS BLOB))<=? AND length(CAST(fingerprint AS BLOB))<=?",
      )
      .get(receipt.input.inputId, CHILD_ROW_BYTES, CHILD_ROW_BYTES);
    let input;
    try {
      input = validateInputRecord(parse(raw?.data));
    } catch {
      return invalid();
    }
    if (
      input.id !== receipt.input.inputId ||
      input.id !== inputMeta.id ||
      input.sessionId !== proof.sessionId ||
      input.sessionId !== inputMeta.session_id ||
      input.workspaceId !== proof.workspaceId ||
      input.workspaceId !== inputMeta.workspace_id ||
      input.requestId !== receipt.input.requestId ||
      input.requestId !== inputMeta.request_id ||
      input.admittedSeq !== receipt.input.admittedSeq ||
      input.admittedSeq !== inputMeta.admitted_seq ||
      input.delivery !== receipt.input.delivery ||
      input.delivery !== inputMeta.delivery ||
      input.state !== inputMeta.state ||
      (input.runId ?? null) !== inputMeta.run_id ||
      (input.promotedSeq ?? null) !== inputMeta.promoted_seq ||
      (input.state === "promoted" &&
        (input.runId !== acceptedRunId ||
          !Number.isSafeInteger(inputMeta.legacy_seq) ||
          Number(inputMeta.legacy_seq) <= 0)) ||
      (input.state !== "promoted" && inputMeta.legacy_seq !== null) ||
      input.attachments !== undefined ||
      input.documents !== undefined
    )
      invalid();
    const prompt = teamMailboxInput(owner.page).prompt;
    if (input.prompt !== prompt) invalid();
    let accepted;
    try {
      accepted = normalizeAcceptInput({
        sessionId: input.sessionId,
        requestId: input.requestId,
        prompt: input.prompt,
        config: run.config,
        delivery: receipt.input.delivery,
      });
    } catch {
      return invalid();
    }
    if (
      knowledgeHash(accepted.config) !== knowledgeHash(run.config) ||
      knowledgeHash(input.config) !== knowledgeHash(accepted.config) ||
      knowledgeHash(accepted) !== receipt.input.inputSha256 ||
      raw?.fingerprint !== requestIdentity(accepted) ||
      inputMeta.bytes !== Buffer.byteLength(JSON.stringify(accepted))
    )
      invalid();
  }
}
