import { knowledgeHash } from "../knowledge/validation.js";
import {
  childStorageKind,
  validateChildStorageRecord,
} from "../child-tasks/storage-binding.js";
import type { TeamStorage } from "./store.js";
import type {
  TeamMemberRevision,
  TeamRecord,
  TeamTaskRevision,
} from "./types.js";
import {
  teamError,
  teamId,
  teamInteger,
  validateTeamMember,
  validateTeamReceipt,
} from "./validation.js";

/** Pure native graph checks. Historical facts never rebind or issue an execution handle. */
export function validateTeamRelations(s: TeamStorage, check: () => void): void {
  for (const row of s.db
    .prepare(
      "SELECT id,workspace_id,team_id,kind,state_key,revision,previous_id FROM team_state_revisions ORDER BY id",
    )
    .iterate()) {
    check();
    const value = s.readRevision(teamId(row.workspace_id), teamId(row.id))!;
    if (
      row.kind !== "team" &&
      !s.getTeam(value.workspaceId, teamId(row.team_id))
    )
      teamError("TEAM_SCOPE_MISMATCH");
    if (row.previous_id === null) {
      if (value.revision !== 1) teamError("TEAM_SCOPE_MISMATCH");
    } else {
      const meta = s.db
        .prepare(
          "SELECT workspace_id,team_id,kind,state_key FROM team_state_revisions WHERE id=?",
        )
        .get(teamId(row.previous_id));
      const prior = s.readRevision(value.workspaceId, teamId(row.previous_id));
      if (
        !meta ||
        !prior ||
        meta.workspace_id !== row.workspace_id ||
        meta.team_id !== row.team_id ||
        meta.kind !== row.kind ||
        meta.state_key !== row.state_key ||
        prior.revision + 1 !== value.revision
      )
        teamError("TEAM_SCOPE_MISMATCH");
      if ("generation" in value && "generation" in prior) {
        if (
          value.generation !== prior.generation &&
          !(
            value.generation === prior.generation + 1 &&
            prior.status === "retired" &&
            prior.owner.cleanup === "confirmed"
          )
        )
          teamError("TEAM_SCOPE_MISMATCH");
      }
    }
    if ("memberId" in value) {
      const owner = value.owner;
      const root = s.db
        .prepare(
          "SELECT runs.workspace_id FROM runs JOIN sessions ON sessions.id=runs.session_id WHERE runs.id=? AND runs.session_id=? AND sessions.workspace_id=runs.workspace_id AND json_extract(runs.data,'$.id')=runs.id AND json_extract(runs.data,'$.sessionId')=runs.session_id AND json_extract(runs.data,'$.workspaceId')=runs.workspace_id",
        )
        .get(owner.rootRunId, owner.rootSessionId);
      if (!root || root.workspace_id !== value.workspaceId)
        teamError("TEAM_OWNER_GRAPH_INVALID");
      if (owner.kind === "child") {
        const kind = childStorageKind(owner.childTaskId!);
        const meta = s.db
          .prepare(
            "SELECT length(CAST(data AS BLOB)) AS bytes FROM session_documents WHERE session_id=? AND kind=?",
          )
          .get(owner.rootSessionId, kind);
        if (!meta) teamError("TEAM_OWNER_GRAPH_INVALID");
        teamInteger(meta.bytes, 32768);
        const raw = s.db
          .prepare(
            "SELECT data FROM session_documents WHERE session_id=? AND kind=? AND length(CAST(data AS BLOB))<=32768",
          )
          .get(owner.rootSessionId, kind);
        if (!raw || typeof raw.data !== "string")
          teamError("TEAM_OWNER_GRAPH_INVALID");
        let record;
        try {
          record = validateChildStorageRecord(JSON.parse(raw.data));
        } catch {
          teamError("TEAM_OWNER_GRAPH_INVALID");
        }
        const b = record.binding;
        if (
          record.sha256 !== owner.childStorageSha256 ||
          b.phase !== "admitted" ||
          b.lineage.taskId !== owner.childTaskId ||
          b.lineage.taskFingerprint !== owner.childTaskFingerprint ||
          b.lineage.sourceRunId !== owner.rootRunId ||
          b.lineage.sessionId !== owner.rootSessionId ||
          b.child.sessionId !== owner.sessionId ||
          b.child.runId !== owner.runId ||
          b.child.workspaceId !== owner.workspaceId ||
          b.worktree.id !== owner.worktreeId
        )
          teamError("TEAM_OWNER_GRAPH_INVALID");
      } else if (
        owner.workspaceId !== value.workspaceId ||
        owner.sessionId !== owner.rootSessionId ||
        owner.runId !== owner.rootRunId
      )
        teamError("TEAM_OWNER_GRAPH_INVALID");
    }
    if ("taskId" in value) {
      for (const dep of value.dependencies) {
        const stored = s.readRevision(value.workspaceId, dep.revisionId);
        if (
          !stored ||
          !("taskId" in stored) ||
          stored.teamId !== value.teamId ||
          stored.taskId !== dep.taskId ||
          stored.sha256 !== dep.sha256
        )
          teamError("TEAM_DEPENDENCY");
      }
      if (value.owner) {
        const member = s.readRevision(
          value.workspaceId,
          value.owner.memberRevisionId,
        );
        if (
          !member ||
          !("memberId" in member) ||
          member.teamId !== value.teamId ||
          member.memberId !== value.owner.memberId ||
          member.generation !== value.owner.generation ||
          member.sha256 !== value.owner.memberSha256 ||
          !member.permissions.claimTasks
        )
          teamError("TEAM_SCOPE_MISMATCH");
      }
    }
  }
  for (const row of s.db
    .prepare("SELECT id,workspace_id FROM team_messages ORDER BY id")
    .iterate()) {
    check();
    const message = s.getMessage(teamId(row.workspace_id), teamId(row.id))!;
    const sender = s.readRevision(
        message.workspaceId,
        message.senderRevisionId,
      ),
      recipient = s.readRevision(
        message.workspaceId,
        message.recipientRevisionId,
      );
    if (
      !sender ||
      !recipient ||
      !("memberId" in sender) ||
      !("memberId" in recipient) ||
      sender.teamId !== message.teamId ||
      recipient.teamId !== message.teamId ||
      sender.memberId !== message.senderMemberId ||
      recipient.memberId !== message.recipientMemberId ||
      sender.generation !== message.senderGeneration ||
      recipient.generation !== message.recipientGeneration ||
      !sender.permissions.send ||
      !recipient.permissions.receive ||
      sender.status !== "active" ||
      recipient.status !== "active" ||
      Date.parse(message.expiresAt) >
        Math.min(Date.parse(sender.expiresAt), Date.parse(recipient.expiresAt))
    )
      teamError("TEAM_SCOPE_MISMATCH");
    const receipt = s.receipt(
      message.workspaceId,
      message.teamId,
      message.senderMemberId,
      message.senderGeneration,
      message.requestId,
      message.requestSha256,
    );
    if (
      !receipt ||
      receipt.operation !== "send" ||
      receipt.recordId !== message.id ||
      receipt.recordSha256 !== message.sha256
    )
      teamError("TEAM_RECEIPT_MISSING");
    const normalized = {
      workspaceId: message.workspaceId,
      teamId: message.teamId,
      senderMemberId: message.senderMemberId,
      senderGeneration: message.senderGeneration,
      recipientMemberId: message.recipientMemberId,
      recipientGeneration: message.recipientGeneration,
      requestId: message.requestId,
      text: message.text,
      expiresAt: message.expiresAt,
    };
    if (knowledgeHash(normalized) !== message.requestSha256)
      teamError("TEAM_REQUEST_CONFLICT");
  }
  for (const row of s.db
    .prepare(
      "SELECT workspace_id,team_id,member_id,generation FROM team_mailbox_cursors ORDER BY team_id,member_id,generation",
    )
    .iterate()) {
    check();
    const cursor = s.cursor(
      teamId(row.workspace_id),
      teamId(row.team_id),
      teamId(row.member_id),
      teamInteger(row.generation),
    );
    const counts = s.db
      .prepare(
        "SELECT count(*) AS n,coalesce(max(seq),0) AS seq FROM team_messages WHERE team_id=? AND recipient_member_id=? AND recipient_generation=?",
      )
      .get(cursor.teamId, cursor.memberId, cursor.generation)!;
    if (counts.n !== cursor.admittedSeq || counts.seq !== cursor.admittedSeq)
      teamError("TEAM_CURSOR_INVALID");
    const member = s.db
      .prepare(
        "SELECT 1 AS ok FROM team_state_revisions WHERE workspace_id=? AND team_id=? AND kind='member' AND state_key=? AND generation=? LIMIT 1",
      )
      .get(
        cursor.workspaceId,
        cursor.teamId,
        cursor.memberId,
        cursor.generation,
      );
    if (!member) teamError("TEAM_SCOPE_MISMATCH");
    if (cursor.pendingDeliveryId !== null) {
      const record = s.getDelivery(
        cursor.workspaceId,
        cursor.pendingDeliveryId,
      );
      if (
        !record ||
        record.memberId !== cursor.memberId ||
        record.generation !== cursor.generation ||
        record.teamId !== cursor.teamId ||
        !["prepared", "dispatched", "uncertain"].includes(record.state)
      )
        teamError("TEAM_CURSOR_INVALID");
    }
  }
  for (const row of s.db
    .prepare(
      "SELECT id,workspace_id,team_id,actor_id,actor_generation,request_id,request_sha256,operation,record_id,record_sha256 FROM team_operation_receipts ORDER BY id",
    )
    .iterate()) {
    check();
    const receipt = validateTeamReceipt(
      s.readData("team_operation_receipts", "id=?", [teamId(row.id)]),
    );
    if (
      receipt.id !== row.id ||
      receipt.workspaceId !== row.workspace_id ||
      receipt.teamId !== row.team_id ||
      receipt.actorId !== row.actor_id ||
      receipt.actorGeneration !== row.actor_generation ||
      receipt.requestId !== row.request_id ||
      receipt.requestSha256 !== row.request_sha256 ||
      receipt.operation !== row.operation ||
      receipt.recordId !== row.record_id ||
      receipt.recordSha256 !== row.record_sha256
    )
      teamError("TEAM_SCOPE_MISMATCH");
    if (receipt.claimProof) {
      const p = receipt.claimProof,
        member = s.readRevision(receipt.workspaceId, p.memberRevisionId);
      if (
        !member ||
        !("memberId" in member) ||
        member.memberId !== receipt.actorId ||
        member.generation !== receipt.actorGeneration ||
        member.teamId !== receipt.teamId ||
        !member.permissions.receive
      )
        teamError("TEAM_SCOPE_MISMATCH");
      for (const [index, id] of p.messageIds.entries()) {
        const message = s.getMessage(receipt.workspaceId, id);
        if (
          !message ||
          message.teamId !== receipt.teamId ||
          message.recipientMemberId !== receipt.actorId ||
          message.recipientGeneration !== receipt.actorGeneration ||
          message.seq !== p.before.claimedSeq + index + 1
        )
          teamError("TEAM_SCOPE_MISMATCH");
      }
      const current = s.cursor(
        receipt.workspaceId,
        receipt.teamId,
        receipt.actorId,
        receipt.actorGeneration,
      );
      if (
        current.claimedSeq < p.after.claimedSeq ||
        current.revision < p.after.revision
      )
        teamError("TEAM_CURSOR_INVALID");
    } else {
      const record =
        receipt.operation === "send"
          ? s.getMessage(receipt.workspaceId, receipt.recordId)
          : s.readRevision(receipt.workspaceId, receipt.recordId);
      if (
        !record ||
        record.sha256 !== receipt.recordSha256 ||
        ("teamId" in record ? record.teamId : record.id) !== receipt.teamId
      )
        teamError("TEAM_RECEIPT_INVALID");
      if (receipt.operation === "create") {
        if (
          "teamId" in record ||
          receipt.actorId !== "host" ||
          receipt.actorGeneration !== 0
        )
          teamError("TEAM_RECEIPT_INVALID");
      } else if (receipt.operation === "member") {
        if (
          !("memberId" in record) ||
          receipt.actorId !== "host" ||
          receipt.actorGeneration !== 0
        )
          teamError("TEAM_RECEIPT_INVALID");
      } else if (receipt.operation === "send") {
        if (
          !("senderMemberId" in record) ||
          record.senderMemberId !== receipt.actorId ||
          record.senderGeneration !== receipt.actorGeneration
        )
          teamError("TEAM_RECEIPT_INVALID");
      } else if (
        receipt.operation === "task" ||
        receipt.operation === "claim-task"
      ) {
        if (
          !("taskId" in record) ||
          (receipt.operation === "claim-task" && record.state !== "claimed") ||
          (receipt.operation === "task" &&
            !["pending", "completed"].includes(record.state))
        )
          teamError("TEAM_RECEIPT_INVALID");
        if (record.state === "claimed" || record.state === "completed") {
          const member =
            record.owner &&
            s.readRevision(record.workspaceId, record.owner.memberRevisionId);
          if (
            !record.owner ||
            !member ||
            !("memberId" in member) ||
            record.owner.memberId !== receipt.actorId ||
            record.owner.generation !== receipt.actorGeneration ||
            member.memberId !== receipt.actorId ||
            member.generation !== receipt.actorGeneration ||
            member.id !== record.owner.memberRevisionId ||
            member.sha256 !== record.owner.memberSha256 ||
            member.teamId !== receipt.teamId ||
            !member.permissions.claimTasks
          )
            teamError("TEAM_RECEIPT_INVALID");
        }
      } else teamError("TEAM_RECEIPT_INVALID");
    }
  }
  for (const row of s.db
    .prepare("SELECT id,workspace_id FROM team_deliveries ORDER BY id")
    .iterate()) {
    check();
    const record = s.getDelivery(teamId(row.workspace_id), teamId(row.id))!,
      receipt = s.getDeliveryReceipt(record.workspaceId, record.id),
      member = s.readRevision(record.workspaceId, record.memberRevisionId);
    if (
      !member ||
      !("memberId" in member) ||
      member.teamId !== record.teamId ||
      member.memberId !== record.memberId ||
      member.generation !== record.generation ||
      member.sha256 !== record.memberSha256 ||
      member.owner.sha256 !== record.owner.sha256 ||
      !member.permissions.receive
    )
      teamError("TEAM_SCOPE_MISMATCH");
    for (const [index, message] of record.page.messages.entries()) {
      const actual = s.getMessage(record.workspaceId, message.id);
      if (
        actual?.sha256 !== message.sha256 ||
        message.seq !== record.page.cursor.claimedSeq + index + 1
      )
        teamError("TEAM_SCOPE_MISMATCH");
    }
    if (
      record.requestSha256 !==
      knowledgeHash({
        pageSha256: record.page.sha256,
        requestId: record.requestId,
        expectedCursorRevision: record.page.cursor.revision,
      })
    )
      teamError("TEAM_REQUEST_CONFLICT");
    if ((record.state === "delivered") !== (receipt !== undefined))
      teamError("TEAM_DELIVERY_RECEIPT_MISSING");
    const cursor = s.cursor(
      record.workspaceId,
      record.teamId,
      record.memberId,
      record.generation,
    );
    if (receipt) {
      if (
        receipt.deliverySha256 !== record.sha256 ||
        receipt.deliveryId !== record.id ||
        receipt.memberId !== record.memberId ||
        receipt.generation !== record.generation ||
        receipt.messagesSha256 !== knowledgeHash(record.page.messages) ||
        receipt.input.sessionId !== record.owner.sessionId ||
        (receipt.input.delivery==="steer" && receipt.input.runId !== record.owner.runId) ||
        (receipt.input.delivery==="queue" && record.owner.kind!=="child") ||
        receipt.input.requestId !== `team-delivery:${record.id}` ||
        receipt.cursor.claimedSeq !== record.page.messages.at(-1)!.seq ||
        receipt.cursor.pendingDeliveryId !== null ||
        cursor.claimedSeq < receipt.cursor.claimedSeq ||
        cursor.revision < receipt.cursor.revision
      )
        teamError("TEAM_SCOPE_MISMATCH");
    } else if (
      ["prepared", "dispatched", "uncertain"].includes(record.state) &&
      cursor.pendingDeliveryId !== record.id
    )
      teamError("TEAM_CURSOR_INVALID");
  }
  for (const row of s.db
    .prepare("SELECT id,workspace_id FROM team_delivery_receipts ORDER BY id")
    .iterate()) {
    check();
    const record = s.getDelivery(teamId(row.workspace_id), teamId(row.id));
    if (!record || record.state !== "delivered")
      teamError("TEAM_DELIVERY_RECEIPT_INVALID");
  }
}
