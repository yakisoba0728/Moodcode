import { randomUUID } from "node:crypto";
import { knowledgeHash } from "../knowledge/validation.js";
import type { TeamStorage } from "./store.js";
import type {
  CursorRequestInput,
  ReadMailboxNativeInput,
  SendAgentMessageInput,
  TeamDeliveryCapture,
  TeamDeliveryRecord,
  TeamMailboxPage,
} from "./types.js";
import {
  TEAM_LIMITS,
  deliveryInputMatches,
  teamDate,
  teamError,
  teamHash,
  teamId,
  teamInteger,
  teamJson,
  teamObject,
  teamSyncResult,
  teamText,
  validateAgentMessage,
  validateDeliveryReceipt,
  validateTeamAcceptedInput,
  validateTeamDelivery,
} from "./validation.js";
export function parseSend(input: SendAgentMessageInput) {
  const r = teamObject(input, [
    "workspaceId",
    "teamId",
    "senderMemberId",
    "senderGeneration",
    "recipientMemberId",
    "recipientGeneration",
    "requestId",
    "text",
    "expiresAt",
  ]);
  for (const k of [
    "workspaceId",
    "teamId",
    "senderMemberId",
    "recipientMemberId",
    "requestId",
  ])
    teamId(r[k]);
  for (const k of ["senderGeneration", "recipientGeneration"])
    if (!teamInteger(r[k])) teamError();
  teamText(r.text, TEAM_LIMITS.messageBytes);
  teamDate(r.expiresAt);
  return r;
}
export function lookupSend(s: TeamStorage, r: Record<string, unknown>) {
  const duplicate = s.receipt(
    r.workspaceId as string,
    r.teamId as string,
    r.senderMemberId as string,
    r.senderGeneration as number,
    r.requestId as string,
    knowledgeHash(r),
  );
  if (!duplicate) return undefined;
  const record = s.getMessage(r.workspaceId as string, duplicate.recordId);
  if (!record || record.sha256 !== duplicate.recordSha256)
    teamError("TEAM_SCOPE_MISMATCH");
  return Object.freeze({ record, receipt: duplicate, duplicate: true });
}
export function sendMessage(
  s: TeamStorage,
  original: object,
  input: SendAgentMessageInput,
) {
  const r = parseSend(input),
    duplicate = lookupSend(s, r);
  if (duplicate) return duplicate;
  return s.tx(() => {
    const sender = s.activeMember(
        original,
        r.workspaceId as string,
        r.teamId as string,
        r.senderMemberId as string,
        r.senderGeneration as number,
      ),
      recipient = s.getMember(
        sender.workspaceId,
        sender.teamId,
        r.recipientMemberId as string,
      ),
      cursor = s.cursor(
        sender.workspaceId,
        sender.teamId,
        r.recipientMemberId as string,
        r.recipientGeneration as number,
      );
    if (!sender.permissions.send || !recipient?.permissions.receive)
      teamError("TEAM_PERMISSION");
    if (
      recipient.status !== "active" ||
      recipient.generation !== r.recipientGeneration ||
      Date.parse(recipient.expiresAt) <= s.now() ||
      recipient.owner.cleanup !== "live"
    )
      teamError("TEAM_MEMBER_INACTIVE");
    const checked = s.ports.assertRecipientCurrent(recipient);
    s.assertOwnerUnquarantined(recipient.workspaceId, recipient.owner);
    teamSyncResult(checked);
    if (
      Date.parse(recipient.expiresAt) <= s.now() ||
      Date.parse(sender.expiresAt) <= s.now()
    )
      teamError("TEAM_EXPIRED");
    if (cursor.pendingDeliveryId !== null) teamError("TEAM_DELIVERY_PENDING");
    const pending = s.db
      .prepare(
        "SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes FROM team_messages WHERE team_id=? AND recipient_member_id=? AND recipient_generation=? AND seq>?",
      )
      .get(
        sender.teamId,
        recipient.memberId,
        recipient.generation,
        cursor.claimedSeq,
      )!;
    if (
      Number(pending.n) >= TEAM_LIMITS.pendingMessages ||
      Number(pending.bytes) + Buffer.byteLength(r.text as string) >
        TEAM_LIMITS.pendingBytes
    )
      teamError("TEAM_BACKLOG_LIMIT");
    const expires = s.expiry(
        r.expiresAt as string,
        new Date(
          Math.min(
            Date.parse(sender.expiresAt),
            Date.parse(recipient.expiresAt),
          ),
        ).toISOString(),
      ),
      record = validateAgentMessage(
        teamHash({
          id: randomUUID(),
          workspaceId: sender.workspaceId,
          teamId: sender.teamId,
          senderMemberId: sender.memberId,
          senderGeneration: sender.generation,
          senderRevisionId: sender.id,
          recipientMemberId: recipient.memberId,
          recipientGeneration: recipient.generation,
          recipientRevisionId: recipient.id,
          seq: cursor.admittedSeq + 1,
          text: r.text,
          bytes: Buffer.byteLength(r.text as string),
          requestId: r.requestId,
          requestSha256: knowledgeHash(r),
          expiresAt: expires,
          createdAt: s.stamp(),
        }),
      );
    s.db
      .prepare(
        "INSERT INTO team_messages(id,workspace_id,team_id,sender_member_id,sender_generation,recipient_member_id,recipient_generation,seq,bytes,request_id,request_sha256,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        record.id,
        record.workspaceId,
        record.teamId,
        record.senderMemberId,
        record.senderGeneration,
        record.recipientMemberId,
        record.recipientGeneration,
        record.seq,
        record.bytes,
        record.requestId,
        record.requestSha256,
        JSON.stringify(record),
      );
    s.updateCursor(cursor, { admittedSeq: record.seq });
    return s.receipted(
      record,
      record.workspaceId,
      record.teamId,
      sender.memberId,
      sender.generation,
      record.requestId,
      record.requestSha256,
      "send",
    );
  });
}
export function readMailbox(
  s: TeamStorage,
  original: object,
  input: ReadMailboxNativeInput,
) {
  const r = teamObject(
    input,
    ["workspaceId", "teamId", "memberId", "generation"],
    ["limit"],
  );
  const ws = teamId(r.workspaceId),
    team = teamId(r.teamId),
    id = teamId(r.memberId),
    gen = teamInteger(r.generation),
    limit = r.limit === undefined ? 64 : teamInteger(r.limit, 64);
  if (!limit) teamError("TEAM_LIMIT");
  return s.tx(() => {
    const member = s.activeMember(original, ws, team, id, gen);
    if (!member.permissions.receive) teamError("TEAM_PERMISSION");
    const cursor = s.cursor(ws, team, id, gen);
    if (cursor.pendingDeliveryId !== null) teamError("TEAM_DELIVERY_PENDING");
    const rows = s.db
      .prepare(
        "SELECT id,seq,length(CAST(data AS BLOB)) AS bytes FROM team_messages WHERE team_id=? AND recipient_member_id=? AND recipient_generation=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(team, id, gen, cursor.claimedSeq, limit + 1);
    const messages = [];
    let bytes = 2048,
      expiredPage = false;
    for (const row of rows) {
      teamInteger(row.bytes, TEAM_LIMITS.rowBytes);
      if (
        messages.length >= limit ||
        bytes + Number(row.bytes) > TEAM_LIMITS.deliveryPageBytes
      )
        break;
      const message = s.getMessage(ws, teamId(row.id));
      if (
        !message ||
        message.seq !== row.seq ||
        message.recipientGeneration !== gen
      )
        teamError("TEAM_SCOPE_MISMATCH");
      const expired = Date.parse(message.expiresAt) <= s.now();
      if (!messages.length) expiredPage = expired;
      else if (expired !== expiredPage) break;
      messages.push(message);
      bytes += Buffer.byteLength(JSON.stringify(message));
    }
    const base = {
      workspaceId: ws,
      teamId: team,
      memberId: id,
      generation: gen,
      memberRevisionId: member.id,
      memberSha256: member.sha256,
      cursor,
      messages,
      bytes,
      hasMore: rows.length > messages.length,
    };
    let page = teamHash({ ...base, bytes: 0 }) as TeamMailboxPage;
    for (let pass = 0; pass < 4; pass++) {
      const actual = Buffer.byteLength(JSON.stringify(page));
      if (page.bytes === actual) break;
      page = teamHash({ ...base, bytes: actual }) as TeamMailboxPage;
    }
    const size = Buffer.byteLength(JSON.stringify(page));
    if (page.bytes !== size || size > TEAM_LIMITS.deliveryPageBytes)
      teamError("TEAM_LIMIT");
    if (s.livePages.size >= 128) teamError("TEAM_CAPACITY");
    s.pages.set(page, { original, used: false });
    s.livePages.add(page);
    return page;
  });
}
function ownedPage(
  s: TeamStorage,
  page: TeamMailboxPage,
  expiredOk = false,
) {
  const own = s.pages.get(page);
  if (!own || own.used) teamError("TEAM_PAGE_REQUIRED");
  const actual = s.activeMember(
      own.original,
      page.workspaceId,
      page.teamId,
      page.memberId,
      page.generation,
    ),
    cursor = s.cursor(
      page.workspaceId,
      page.teamId,
      page.memberId,
      page.generation,
    );
  if (
    actual.id !== page.memberRevisionId ||
    actual.sha256 !== page.memberSha256 ||
    cursor.sha256 !== page.cursor.sha256 ||
    cursor.pendingDeliveryId !== null
  )
    teamError("TEAM_STALE");
  let expired = 0;
  for (const message of page.messages) {
    const stored = s.getMessage(page.workspaceId, message.id);
    if (stored?.sha256 !== message.sha256) teamError("TEAM_STALE");
    if (Date.parse(message.expiresAt) <= s.now()) expired++;
  }
  if (expired && (!expiredOk || expired !== page.messages.length))
    teamError("TEAM_STALE");
  return own;
}
export function claimMailbox(
  s: TeamStorage,
  page: TeamMailboxPage,
  input: CursorRequestInput,
) {
  const r = teamObject(input, ["requestId", "expectedCursorRevision"]),
    request = teamId(r.requestId),
    revision = teamInteger(r.expectedCursorRevision);
  if (!s.pages.has(page)) teamError("TEAM_PAGE_REQUIRED");
  const requestSha = knowledgeHash({ pageSha256: page.sha256, ...r }),
    duplicate = s.receipt(
      page.workspaceId,
      page.teamId,
      page.memberId,
      page.generation,
      request,
      requestSha,
    );
  if (duplicate) {
    const proof = duplicate.claimProof;
    if (!proof || proof.pageSha256 !== page.sha256)
      teamError("TEAM_SCOPE_MISMATCH");
    return Object.freeze({
      receipt: duplicate,
      cursor: proof.after,
      messages: page.messages,
      duplicate: true,
    });
  }
  return s.tx(() => {
    const own = ownedPage(s, page, true);
    if (page.cursor.revision !== revision || !page.messages.length)
      teamError("TEAM_STALE");
    const cursor = s.updateCursor(page.cursor, {
        claimedSeq: page.messages.at(-1)!.seq,
      }),
      receipt = s.putReceipt(
        page.workspaceId,
        page.teamId,
        page.memberId,
        page.generation,
        request,
        requestSha,
        "claim-mailbox",
        page.sha256,
        cursor.sha256,
        {
          before: page.cursor,
          after: cursor,
          messageIds: page.messages.map((message) => message.id),
          memberRevisionId: page.memberRevisionId,
          pageSha256: page.sha256,
        },
      );
    own.used = true;
    return Object.freeze({
      receipt,
      cursor,
      messages: page.messages,
      duplicate: false,
    });
  });
}
export function prepareDelivery(
  s: TeamStorage,
  page: TeamMailboxPage,
  input: CursorRequestInput,
) {
  const r = teamObject(input, ["requestId", "expectedCursorRevision"]),
    request = teamId(r.requestId),
    revision = teamInteger(r.expectedCursorRevision);
  if (!s.pages.has(page)) teamError("TEAM_PAGE_REQUIRED");
  const sha = knowledgeHash({ pageSha256: page.sha256, ...r }),
    meta = s.db
      .prepare(
        "SELECT id,request_sha256 FROM team_deliveries WHERE team_id=? AND member_id=? AND generation=? AND request_id=?",
      )
      .get(page.teamId, page.memberId, page.generation, request);
  if (meta) {
    if (meta.request_sha256 !== sha) teamError("TEAM_REQUEST_CONFLICT");
    const record = s.getDelivery(page.workspaceId, teamId(meta.id))!;
    return Object.freeze({
      kind: "duplicate" as const,
      record,
      receipt: s.getDeliveryReceipt(page.workspaceId, record.id) ?? null,
    });
  }
  return s.tx(() => {
    const own = ownedPage(s, page);
    if (
      !page.messages.length ||
      revision !== page.cursor.revision ||
      s.liveDeliveries.size >= 32
    )
      teamError("TEAM_LIMIT");
    const frontier = s.db
      .prepare(
        "SELECT count(*) AS n,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM team_deliveries WHERE workspace_id=? AND state IN ('prepared','dispatched','uncertain')",
      )
      .get(page.workspaceId)!;
    if (
      Number(frontier.n) >= 32 ||
      Number(frontier.bytes) + Buffer.byteLength(JSON.stringify(page)) + 4096 >
        TEAM_LIMITS.frontierBytes
    )
      teamError("TEAM_LIMIT");
    const record = validateTeamDelivery(
      teamHash({
        id: randomUUID(),
        workspaceId: page.workspaceId,
        teamId: page.teamId,
        memberId: page.memberId,
        generation: page.generation,
        memberRevisionId: page.memberRevisionId,
        memberSha256: page.memberSha256,
        owner: s.getMember(page.workspaceId, page.teamId, page.memberId)!.owner,
        requestId: request,
        requestSha256: sha,
        runtimeEpoch: s.epoch,
        state: "prepared",
        revision: 1,
        page,
        createdAt: s.stamp(),
        updatedAt: s.stamp(),
        errorCode: null,
      }),
    );
    s.db
      .prepare(
        "INSERT INTO team_deliveries(id,workspace_id,team_id,member_id,generation,request_id,request_sha256,state,revision,data) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        record.id,
        record.workspaceId,
        record.teamId,
        record.memberId,
        record.generation,
        record.requestId,
        record.requestSha256,
        record.state,
        1,
        JSON.stringify(record),
      );
    s.updateCursor(page.cursor, { pendingDeliveryId: record.id });
    const capture = teamJson({
      workspaceId: record.workspaceId,
      teamId: record.teamId,
      deliveryId: record.id,
      runtimeEpoch: s.epoch,
    });
    s.deliveries.set(capture, { original: own.original });
    s.liveDeliveries.add(capture);
    own.used = true;
    return Object.freeze({ kind: "created" as const, capture, record });
  });
}
function ownedDelivery(s: TeamStorage, c: TeamDeliveryCapture) {
  const own = s.deliveries.get(c);
  if (!own || !s.liveDeliveries.has(c))
    teamError("TEAM_DELIVERY_CAPTURE_REQUIRED");
  const record = s.getDelivery(c.workspaceId, c.deliveryId);
  if (
    !record ||
    record.runtimeEpoch !== c.runtimeEpoch ||
    c.runtimeEpoch !== s.epoch
  )
    teamError("TEAM_STALE");
  return { own, record };
}
function updateDelivery(
  s: TeamStorage,
  old: TeamDeliveryRecord,
  patch: Partial<TeamDeliveryRecord>,
) {
  const { sha256, ...body } = old,
    next = validateTeamDelivery(
      teamHash({
        ...body,
        ...patch,
        revision: old.revision + 1,
        updatedAt: s.stamp(),
      }),
    );
  const changes = s.db
    .prepare(
      "UPDATE team_deliveries SET state=?,revision=?,data=? WHERE id=? AND workspace_id=? AND revision=? AND data=?",
    )
    .run(
      next.state,
      next.revision,
      JSON.stringify(next),
      old.id,
      old.workspaceId,
      old.revision,
      JSON.stringify(old),
    );
  if (changes.changes !== 1) teamError("TEAM_STALE");
  return next;
}
export function dispatchDelivery(s: TeamStorage, c: TeamDeliveryCapture) {
  return s.tx(() => {
    const { own, record } = ownedDelivery(s, c);
    if (record.state !== "prepared") teamError("TEAM_STALE");
    const member = s.activeMember(
        own.original,
        record.workspaceId,
        record.teamId,
        record.memberId,
        record.generation,
      ),
      cursor = s.cursor(
        record.workspaceId,
        record.teamId,
        record.memberId,
        record.generation,
      );
    if (
      member.sha256 !== record.memberSha256 ||
      cursor.pendingDeliveryId !== record.id
    )
      teamError("TEAM_STALE");
    return updateDelivery(s, record, { state: "dispatched" });
  });
}
export function completeDelivery(
  s: TeamStorage,
  c: TeamDeliveryCapture,
  originalInput: object,
) {
  return s.tx(() => {
    const { record } = ownedDelivery(s, c);
    if (record.state !== "dispatched") teamError("TEAM_STALE");
    const input = validateTeamAcceptedInput(
      s.ports.readAcceptedInput(c, originalInput),
    );
    if (!deliveryInputMatches(record, input)) teamError("TEAM_INPUT_SCOPE");
    const cursor = s.cursor(
      record.workspaceId,
      record.teamId,
      record.memberId,
      record.generation,
    );
    if (
      cursor.pendingDeliveryId !== record.id ||
      cursor.claimedSeq !== record.page.cursor.claimedSeq
    )
      teamError("TEAM_STALE");
    const next = updateDelivery(s, record, { state: "delivered" }),
      after = s.updateCursor(cursor, {
        claimedSeq: record.page.messages.at(-1)!.seq,
        pendingDeliveryId: null,
      }),
      receipt = validateDeliveryReceipt(
        teamHash({
          id: record.id,
          workspaceId: record.workspaceId,
          teamId: record.teamId,
          deliveryId: record.id,
          deliverySha256: next.sha256,
          memberId: record.memberId,
          generation: record.generation,
          messagesSha256: knowledgeHash(record.page.messages),
          input,
          cursor: after,
          createdAt: s.stamp(),
        }),
      );
    s.db
      .prepare(
        "INSERT INTO team_delivery_receipts(id,workspace_id,team_id,data) VALUES(?,?,?,?)",
      )
      .run(
        receipt.id,
        receipt.workspaceId,
        receipt.teamId,
        JSON.stringify(receipt),
      );
    return Object.freeze({ record: next, receipt });
  });
}
function settleDelivery(
  s: TeamStorage,
  record: TeamDeliveryRecord,
  errorCode: string,
) {
  const next = updateDelivery(s, record, {
    state: record.state === "prepared" ? "cancelled" : "uncertain",
    errorCode,
  });
  if (record.state === "prepared") {
    const cursor = s.cursor(
      record.workspaceId,
      record.teamId,
      record.memberId,
      record.generation,
    );
    if (cursor.pendingDeliveryId === record.id)
      s.updateCursor(cursor, { pendingDeliveryId: null });
  }
  return next;
}
export function cancelDelivery(s: TeamStorage, c: TeamDeliveryCapture) {
  return s.tx(() => {
    const { record } = ownedDelivery(s, c);
    if (!["prepared", "dispatched"].includes(record.state)) return record;
    return settleDelivery(s, record, "TEAM_DELIVERY_OWNER_RELEASED");
  });
}
export function recoverDeliveries(s: TeamStorage) {
  return s.tx(() => {
    let n = 0;
    for (const row of s.db
      .prepare(
        "SELECT id,workspace_id FROM team_deliveries WHERE state IN ('prepared','dispatched') ORDER BY id LIMIT 33",
      )
      .iterate()) {
      if (++n > 32) teamError("TEAM_LIMIT");
      const record = s.getDelivery(teamId(row.workspace_id), teamId(row.id))!;
      settleDelivery(s, record, "TEAM_DELIVERY_OWNER_UNAVAILABLE");
    }
    return n;
  });
}
