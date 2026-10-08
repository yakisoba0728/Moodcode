import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { knowledgeHash, validateBinding } from "../knowledge/validation.js";
import type {
  AgentMessage,
  CreateTeamInput,
  PutTeamTaskInput,
  RegisterTeamMemberInput,
  SendAgentMessageInput,
  TeamDeliveryCapture,
  TeamDeliveryRecord,
  TeamDeliveryReceipt,
  TeamMailboxCursor,
  TeamMailboxPage,
  TeamMemberRevision,
  TeamMemberOwnerProof,
  TeamOperationReceipt,
  TeamRecord,
  TeamRequestResult,
  TeamStateRevision,
  TeamStoragePorts,
  TeamTaskRevision,
} from "./types.js";
import {
  TEAM_LIMITS,
  teamDate,
  teamError,
  teamHash,
  teamId,
  teamInteger,
  teamJson,
  teamObject,
  teamSha,
  validateAgentMessage,
  validateTeam,
  validateTeamCursor,
  validateTeamMember,
  validateTeamOwner,
  validateTeamReceipt,
  validateTeamTask,
} from "./validation.js";
import { validateTeamRelations } from "./proof-validation.js";
import { createTeam, registerMember, retireMember } from "./membership.js";
import {
  sendMessage,
  readMailbox,
  claimMailbox,
  prepareDelivery,
  dispatchDelivery,
  completeDelivery,
  cancelDelivery,
  recoverDeliveries,
  lookupSend,
  validateDelivery,
  validateDeliveryReceipt,
} from "./mailbox.js";
import { putTask, claimTask, completeTask } from "./board.js";
export { TEAM_SCHEMA_SQL, TEAM_TABLES } from "./schema.js";
export class TeamStorage {
  readonly epoch = randomUUID();
  readonly pages = new WeakMap<object, { original: object; used: boolean }>();
  readonly deliveries = new WeakMap<object, { original: object }>();
  readonly liveDeliveries = new Set<TeamDeliveryCapture>();
  readonly livePages = new Set<TeamMailboxPage>();
  constructor(
    readonly db: DatabaseSync,
    readonly ports: TeamStoragePorts,
  ) {}
  now(): number {
    return teamInteger(this.ports.now?.() ?? Date.now(), 8640000000000000);
  }
  stamp(): string {
    return new Date(this.now()).toISOString();
  }
  tx<T>(op: () => T): T {
    let entries = 0;
    const result = this.ports.writeTx(() => {
      if (++entries !== 1 || !this.db.isTransaction)
        teamError("TEAM_TRANSACTION_REQUIRED");
      const v = op();
      if (v && typeof v === "object" && "then" in v)
        teamError("TEAM_TRANSACTION_REQUIRED");
      return v;
    });
    if (
      entries !== 1 ||
      (result && typeof result === "object" && "then" in result)
    )
      teamError("TEAM_TRANSACTION_REQUIRED");
    return result;
  }
  expiry(value: string, ceiling?: string): string {
    const expires = teamDate(value),
      now = this.now();
    if (
      Date.parse(expires) <= now ||
      Date.parse(expires) - now > TEAM_LIMITS.ttlMs ||
      (ceiling && Date.parse(expires) > Date.parse(ceiling))
    )
      teamError("TEAM_EXPIRED");
    return expires;
  }
  readData(
    table: string,
    where: string,
    args: readonly (string | number)[],
  ): unknown | undefined {
    if (
      ![
        "team_state_revisions",
        "team_messages",
        "team_operation_receipts",
        "team_mailbox_cursors",
        "team_deliveries",
        "team_delivery_receipts",
      ].includes(table)
    )
      teamError();
    const meta = this.db
      .prepare(
        `SELECT length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE ${where}`,
      )
      .get(...args);
    if (!meta) return undefined;
    teamInteger(meta.bytes, 65536);
    const row = this.db
      .prepare(
        `SELECT data FROM ${table} WHERE ${where} AND length(CAST(data AS BLOB))<=65536`,
      )
      .get(...args);
    if (!row || typeof row.data !== "string") teamError("TEAM_SCOPE_MISMATCH");
    try {
      return teamJson(JSON.parse(row.data));
    } catch {
      teamError("TEAM_RECORD_INVALID");
    }
  }
  readRevision(ws: string, id: string): TeamStateRevision | undefined {
    teamId(ws);
    teamId(id);
    const meta = this.db
      .prepare(
        "SELECT workspace_id,team_id,kind,state_key,generation,revision,previous_id,sha256 FROM team_state_revisions WHERE workspace_id=? AND id=?",
      )
      .get(ws, id);
    if (!meta) return undefined;
    const body = this.readData(
      "team_state_revisions",
      "workspace_id=? AND id=?",
      [ws, id],
    );
    const value =
      meta.kind === "team"
        ? validateTeam(body)
        : meta.kind === "member"
          ? validateTeamMember(body)
          : meta.kind === "task"
            ? validateTeamTask(body)
            : teamError("TEAM_SCOPE_MISMATCH");
    const key =
      "memberId" in value
        ? value.memberId
        : "taskId" in value
          ? value.taskId
          : value.id;
    if (
      value.workspaceId !== ws ||
      ("teamId" in value ? value.teamId : value.id) !== meta.team_id ||
      key !== meta.state_key ||
      value.revision !== meta.revision ||
      value.sha256 !== meta.sha256 ||
      ("generation" in value ? value.generation : 0) !== meta.generation ||
      ("previousId" in value && value.previousId !== meta.previous_id)
    )
      teamError("TEAM_SCOPE_MISMATCH");
    return value;
  }
  state<T extends TeamStateRevision>(
    ws: string,
    team: string,
    kind: "team" | "member" | "task",
    key: string,
  ): T | undefined {
    for (const v of [ws, team, key]) teamId(v);
    const h = this.db
      .prepare(
        "SELECT workspace_id,revision_id,generation,revision,sha256 FROM team_state_heads WHERE team_id=? AND kind=? AND state_key=?",
      )
      .get(team, kind, key);
    if (!h) return undefined;
    if (h.workspace_id !== ws) teamError("TEAM_SCOPE_MISMATCH");
    const value = this.readRevision(ws, teamId(h.revision_id));
    if (
      !value ||
      value.sha256 !== h.sha256 ||
      value.revision !== h.revision ||
      ("generation" in value ? value.generation : 0) !== h.generation
    )
      teamError("TEAM_SCOPE_MISMATCH");
    return value as T;
  }
  append(
    kind: "team" | "member" | "task",
    key: string,
    value: TeamStateRevision,
    prior: TeamStateRevision | undefined,
  ): string {
    const team = "teamId" in value ? value.teamId : value.id,
      rowId = kind === "team" ? randomUUID() : value.id,
      previous = this.db
        .prepare(
          "SELECT revision_id FROM team_state_heads WHERE team_id=? AND kind=? AND state_key=?",
        )
        .get(team, kind, key);
    if (!prior !== !previous) teamError("TEAM_STALE");
    this.db
      .prepare(
        "INSERT INTO team_state_revisions(id,workspace_id,team_id,kind,state_key,generation,revision,previous_id,sha256,data) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        rowId,
        value.workspaceId,
        team,
        kind,
        key,
        "generation" in value ? value.generation : 0,
        value.revision,
        (previous?.revision_id as string) ?? null,
        value.sha256,
        JSON.stringify(value),
      );
    if (prior) {
      const changed = this.db
        .prepare(
          "UPDATE team_state_heads SET revision_id=?,generation=?,revision=?,sha256=? WHERE team_id=? AND kind=? AND state_key=? AND workspace_id=? AND revision=? AND sha256=?",
        )
        .run(
          rowId,
          "generation" in value ? value.generation : 0,
          value.revision,
          value.sha256,
          team,
          kind,
          key,
          value.workspaceId,
          prior.revision,
          prior.sha256,
        );
      if (changed.changes !== 1) teamError("TEAM_STALE");
    } else
      this.db
        .prepare(
          "INSERT INTO team_state_heads(team_id,kind,state_key,workspace_id,revision_id,generation,revision,sha256) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          team,
          kind,
          key,
          value.workspaceId,
          rowId,
          "generation" in value ? value.generation : 0,
          value.revision,
          value.sha256,
        );
    return rowId;
  }
  getTeam(ws: string, team: string): TeamRecord | undefined {
    return this.state(ws, team, "team", team);
  }
  getMember(
    ws: string,
    team: string,
    member: string,
  ): TeamMemberRevision | undefined {
    return this.state(ws, team, "member", member);
  }
  getTask(
    ws: string,
    team: string,
    task: string,
  ): TeamTaskRevision | undefined {
    return this.state(ws, team, "task", task);
  }
  activeTeam(ws: string, team: string): TeamRecord {
    const value = this.getTeam(ws, team);
    if (
      !value ||
      value.status !== "active" ||
      Date.parse(value.expiresAt) <= this.now()
    )
      teamError("TEAM_INACTIVE");
    const workspace = this.ports.getWorkspace(ws);
    if (
      workspace.id !== ws ||
      workspace.root !== value.binding.root ||
      knowledgeHash(validateBinding(this.ports.checkBinding(ws))) !==
        knowledgeHash(value.binding)
    )
      teamError("TEAM_BINDING_STALE");
    return value;
  }
  activeMember(
    original: object,
    ws: string,
    team: string,
    id: string,
    generation?: number,
  ): TeamMemberRevision {
    this.activeTeam(ws, team);
    const value = this.getMember(ws, team, id);
    if (
      !value ||
      value.status !== "active" ||
      Date.parse(value.expiresAt) <= this.now() ||
      (generation !== undefined && value.generation !== generation)
    )
      teamError("TEAM_MEMBER_INACTIVE");
    const actual = validateTeamOwner(this.ports.readMemberOwner(original));
    this.assertOwnerUnquarantined(ws, actual);
    const pending = this.cursor(
      ws,
      team,
      id,
      value.generation,
    ).pendingDeliveryId;
    if (
      pending !== null &&
      this.getDelivery(ws, pending)?.state === "uncertain"
    )
      teamError("TEAM_DELIVERY_UNCERTAIN");
    if (actual.sha256 !== value.owner.sha256 || actual.cleanup !== "live")
      teamError("TEAM_OWNER_STALE");
    const result = this.ports.assertMemberOwnerCurrent(original, value);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      teamError("TEAM_OWNER_INVALID");
    }
    if (Date.parse(value.expiresAt) <= this.now()) teamError("TEAM_EXPIRED");
    return value;
  }
  assertOwnerUnquarantined(ws: string, owner: TeamMemberOwnerProof): void {
    let count = 0,
      bytes = 0;
    for (const row of this.db
      .prepare(
        "SELECT id,length(CAST(data AS BLOB)) AS bytes FROM team_deliveries WHERE workspace_id=? AND state='uncertain' ORDER BY id LIMIT 33",
      )
      .iterate(teamId(ws))) {
      if (++count > 32) teamError("TEAM_LIMIT");
      bytes += teamInteger(row.bytes, 65536);
      if (bytes > 1048576) teamError("TEAM_LIMIT");
      const record = this.getDelivery(ws, teamId(row.id));
      if (!record) teamError("TEAM_SCOPE_MISMATCH");
      const actual = record.owner;
      if (
        actual.kind === owner.kind &&
        actual.workspaceId === owner.workspaceId &&
        actual.sessionId === owner.sessionId &&
        actual.runId === owner.runId &&
        actual.childStorageSha256 === owner.childStorageSha256 &&
        actual.ownerEpoch === owner.ownerEpoch
      )
        teamError("TEAM_DELIVERY_UNCERTAIN");
    }
  }
  receipt(
    ws: string,
    team: string,
    actor: string,
    generation: number,
    request: string,
    sha: string,
  ): TeamOperationReceipt | undefined {
    for (const v of [ws, team, actor, request]) teamId(v);
    teamInteger(generation);
    teamSha(sha);
    const data = this.readData(
      "team_operation_receipts",
      "team_id=? AND actor_id=? AND actor_generation=? AND request_id=?",
      [team, actor, generation, request],
    );
    if (data === undefined) return undefined;
    const value = validateTeamReceipt(data);
    if (
      value.workspaceId !== ws ||
      value.teamId !== team ||
      value.actorId !== actor ||
      value.actorGeneration !== generation ||
      value.requestId !== request
    )
      teamError("TEAM_SCOPE_MISMATCH");
    if (value.requestSha256 !== sha) teamError("TEAM_REQUEST_CONFLICT");
    return value;
  }
  putReceipt(
    ws: string,
    team: string,
    actor: string,
    generation: number,
    request: string,
    sha: string,
    operation: TeamOperationReceipt["operation"],
    recordId: string,
    recordSha: string,
    claimProof?: TeamOperationReceipt["claimProof"],
  ): TeamOperationReceipt {
    const value = validateTeamReceipt(
      teamHash({
        id: randomUUID(),
        workspaceId: ws,
        teamId: team,
        actorId: actor,
        actorGeneration: generation,
        requestId: request,
        requestSha256: sha,
        operation,
        recordId,
        recordSha256: recordSha,
        createdAt: this.stamp(),
        ...(claimProof ? { claimProof } : {}),
      }),
    );
    this.db
      .prepare(
        "INSERT INTO team_operation_receipts(id,workspace_id,team_id,actor_id,actor_generation,request_id,request_sha256,operation,record_id,record_sha256,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        value.id,
        ws,
        team,
        actor,
        generation,
        request,
        sha,
        operation,
        recordId,
        recordSha,
        JSON.stringify(value),
      );
    return value;
  }
  getMessage(ws: string, id: string): AgentMessage | undefined {
    const data = this.readData("team_messages", "workspace_id=? AND id=?", [
      teamId(ws),
      teamId(id),
    ]);
    if (data === undefined) return undefined;
    const v = validateAgentMessage(data),
      m = this.db
        .prepare(
          "SELECT team_id,sender_member_id,sender_generation,recipient_member_id,recipient_generation,seq,bytes,request_id,request_sha256 FROM team_messages WHERE id=?",
        )
        .get(id)!;
    if (
      v.id !== id ||
      v.workspaceId !== ws ||
      v.teamId !== m.team_id ||
      v.senderMemberId !== m.sender_member_id ||
      v.senderGeneration !== m.sender_generation ||
      v.recipientMemberId !== m.recipient_member_id ||
      v.recipientGeneration !== m.recipient_generation ||
      v.seq !== m.seq ||
      v.bytes !== m.bytes ||
      v.requestId !== m.request_id ||
      v.requestSha256 !== m.request_sha256
    )
      teamError("TEAM_SCOPE_MISMATCH");
    return v;
  }
  cursor(
    ws: string,
    team: string,
    member: string,
    generation: number,
  ): TeamMailboxCursor {
    const body = this.readData(
      "team_mailbox_cursors",
      "team_id=? AND member_id=? AND generation=?",
      [teamId(team), teamId(member), teamInteger(generation)],
    );
    if (body === undefined) teamError("TEAM_CURSOR_MISSING");
    const c = validateTeamCursor(body);
    if (
      c.workspaceId !== ws ||
      c.teamId !== team ||
      c.memberId !== member ||
      c.generation !== generation
    )
      teamError("TEAM_SCOPE_MISMATCH");
    const m = this.db
      .prepare(
        "SELECT revision,admitted_seq,claimed_seq,pending_delivery_id FROM team_mailbox_cursors WHERE team_id=? AND member_id=? AND generation=?",
      )
      .get(team, member, generation)!;
    if (
      m.revision !== c.revision ||
      m.admitted_seq !== c.admittedSeq ||
      m.claimed_seq !== c.claimedSeq ||
      m.pending_delivery_id !== c.pendingDeliveryId
    )
      teamError("TEAM_SCOPE_MISMATCH");
    return c;
  }
  updateCursor(
    prior: TeamMailboxCursor,
    patch: Partial<TeamMailboxCursor>,
  ): TeamMailboxCursor {
    const { sha256, ...body } = prior;
    const c = validateTeamCursor(
      teamHash({ ...body, ...patch, revision: prior.revision + 1 }),
    );
    const r = this.db
      .prepare(
        "UPDATE team_mailbox_cursors SET revision=?,admitted_seq=?,claimed_seq=?,pending_delivery_id=?,data=? WHERE team_id=? AND member_id=? AND generation=? AND revision=? AND data=?",
      )
      .run(
        c.revision,
        c.admittedSeq,
        c.claimedSeq,
        c.pendingDeliveryId,
        JSON.stringify(c),
        c.teamId,
        c.memberId,
        c.generation,
        prior.revision,
        JSON.stringify(prior),
      );
    if (r.changes !== 1) teamError("TEAM_STALE");
    return c;
  }
  listState<T extends TeamStateRevision>(
    ws: string,
    team: string,
    kind: "member" | "task",
    limit = 32,
  ): T[] {
    teamId(ws);
    teamId(team);
    if (!teamInteger(limit, 64)) teamError("TEAM_LIMIT");
    const rows = this.db
        .prepare(
          "SELECT state_key FROM team_state_heads WHERE workspace_id=? AND team_id=? AND kind=? ORDER BY state_key LIMIT ?",
        )
        .all(ws, team, kind, limit),
      out: T[] = [];
    let bytes = 0;
    for (const row of rows) {
      const v = this.state<T>(ws, team, kind, teamId(row.state_key));
      if (!v) teamError();
      const charge = Buffer.byteLength(JSON.stringify(v));
      if (bytes + charge > 65536) break;
      bytes += charge;
      out.push(v);
    }
    return Object.freeze(out) as unknown as T[];
  }
  listMembers(ws: string, team: string, limit = 32) {
    return this.listState<TeamMemberRevision>(ws, team, "member", limit);
  }
  listTasks(ws: string, team: string, limit = 32) {
    return this.listState<TeamTaskRevision>(ws, team, "task", limit);
  }
  createTeam(input: CreateTeamInput) {
    return createTeam(this, input);
  }
  registerMember(original: object, input: RegisterTeamMemberInput) {
    return registerMember(this, original, input);
  }
  retireMember(original: object, input: Parameters<typeof retireMember>[2]) {
    return retireMember(this, original, input);
  }
  send(original: object, input: SendAgentMessageInput) {
    return sendMessage(this, original, input);
  }
  findSendRequest(input: SendAgentMessageInput) {
    return lookupSend(this, input);
  }
  findOperationRequest(
    ws: string,
    team: string,
    actor: string,
    generation: number,
    requestId: string,
    inputSha256: string,
  ) {
    const receipt = this.receipt(
      ws,
      team,
      actor,
      generation,
      requestId,
      inputSha256,
    );
    if (!receipt) return undefined;
    const record =
      receipt.operation === "send"
        ? this.getMessage(ws, receipt.recordId)
        : this.readRevision(ws, receipt.recordId);
    if (!record || record.sha256 !== receipt.recordSha256)
      teamError("TEAM_SCOPE_MISMATCH");
    return Object.freeze({ record, receipt, duplicate: true });
  }
  getDeliveryHistory(ws: string, id: string) {
    const record = this.getDelivery(ws, id);
    if (!record) return undefined;
    const receipt = this.getDeliveryReceipt(ws, id) ?? null;
    if (
      (record.state === "delivered") !== (receipt !== null) ||
      (receipt &&
        (receipt.deliverySha256 !== record.sha256 ||
          receipt.deliveryId !== record.id ||
          receipt.memberId !== record.memberId ||
          receipt.generation !== record.generation ||
          receipt.messagesSha256 !== knowledgeHash(record.page.messages) ||
          receipt.input.sessionId !== record.owner.sessionId ||
          receipt.input.runId !== record.owner.runId ||
          receipt.input.requestId !== `team-delivery:${record.id}`))
    )
      teamError("TEAM_SCOPE_MISMATCH");
    return Object.freeze({
      record,
      receipt,
    });
  }
  listDeliveries(ws: string, team: string, limit = 32) {
    teamId(ws);
    teamId(team);
    if (!teamInteger(limit, 32)) teamError("TEAM_LIMIT");
    const out = [];
    let bytes = 0;
    for (const row of this.db
      .prepare(
        "SELECT id,length(CAST(data AS BLOB)) AS bytes FROM team_deliveries WHERE workspace_id=? AND team_id=? ORDER BY id LIMIT ?",
      )
      .iterate(ws, team, limit)) {
      teamInteger(row.bytes, 65536);
      if (bytes + Number(row.bytes) > 65536) break;
      const value = this.getDeliveryHistory(ws, teamId(row.id));
      if (!value) teamError();
      bytes += Number(row.bytes);
      out.push(value);
    }
    return Object.freeze(out);
  }
  readMailbox(original: object, input: Parameters<typeof readMailbox>[2]) {
    return readMailbox(this, original, input);
  }
  claimMailbox(
    page: TeamMailboxPage,
    input: Parameters<typeof claimMailbox>[2],
  ) {
    return claimMailbox(this, page, input);
  }
  releasePage(page: TeamMailboxPage) {
    this.pages.delete(page);
    this.livePages.delete(page);
  }
  putTask(original: object, input: PutTeamTaskInput) {
    return putTask(this, original, input);
  }
  claimTask(original: object, input: Parameters<typeof claimTask>[2]) {
    return claimTask(this, original, input);
  }
  completeTask(original: object, input: Parameters<typeof completeTask>[2]) {
    return completeTask(this, original, input);
  }
  prepareDelivery(
    page: TeamMailboxPage,
    input: Parameters<typeof prepareDelivery>[2],
  ) {
    return prepareDelivery(this, page, input);
  }
  dispatchDelivery(c: TeamDeliveryCapture) {
    return dispatchDelivery(this, c);
  }
  completeDelivery(c: TeamDeliveryCapture, input: object) {
    return completeDelivery(this, c, input);
  }
  cancelDelivery(c: TeamDeliveryCapture) {
    return cancelDelivery(this, c);
  }
  releaseDelivery(c: TeamDeliveryCapture) {
    if (this.deliveries.has(c)) {
      try {
        cancelDelivery(this, c);
      } finally {
        this.deliveries.delete(c);
        this.liveDeliveries.delete(c);
      }
    }
  }
  recoverInterruptedDeliveries() {
    return recoverDeliveries(this);
  }
  getDelivery(ws: string, id: string): TeamDeliveryRecord | undefined {
    const data = this.readData("team_deliveries", "workspace_id=? AND id=?", [
      teamId(ws),
      teamId(id),
    ]);
    if (data === undefined) return undefined;
    const value = validateDelivery(data),
      meta = this.db
        .prepare(
          "SELECT team_id,member_id,generation,request_id,request_sha256,state,revision FROM team_deliveries WHERE workspace_id=? AND id=?",
        )
        .get(ws, id)!;
    if (
      value.id !== id ||
      value.workspaceId !== ws ||
      value.teamId !== meta.team_id ||
      value.memberId !== meta.member_id ||
      value.generation !== meta.generation ||
      value.requestId !== meta.request_id ||
      value.requestSha256 !== meta.request_sha256 ||
      value.state !== meta.state ||
      value.revision !== meta.revision
    )
      teamError("TEAM_SCOPE_MISMATCH");
    return value;
  }
  getDeliveryReceipt(ws: string, id: string): TeamDeliveryReceipt | undefined {
    const data = this.readData(
      "team_delivery_receipts",
      "workspace_id=? AND id=?",
      [teamId(ws), teamId(id)],
    );
    if (data === undefined) return undefined;
    const value = validateDeliveryReceipt(data),
      meta = this.db
        .prepare(
          "SELECT team_id FROM team_delivery_receipts WHERE workspace_id=? AND id=?",
        )
        .get(ws, id)!;
    if (
      value.id !== id ||
      value.workspaceId !== ws ||
      value.teamId !== meta.team_id
    )
      teamError("TEAM_SCOPE_MISMATCH");
    return value;
  }
}
export function pauseImportedTeams(
  db: DatabaseSync,
  workspaceId: string,
  archiveSha256: string,
): void {
  teamId(workspaceId);
  teamSha(archiveSha256);
  if (!db.isTransaction) teamError("TEAM_TRANSACTION_REQUIRED");
  const storage = new TeamStorage(db, {
    writeTx: (op) => op(),
    getWorkspace: () => teamError(),
    checkBinding: () => teamError(),
    readMemberOwner: () => teamError(),
    assertMemberOwnerCurrent: () => teamError(),
    assertRecipientCurrent: () => teamError(),
    readAcceptedInput: () => teamError(),
  });
  for (const row of db
    .prepare(
      "SELECT team_id FROM team_state_heads WHERE workspace_id=? AND kind='team' ORDER BY team_id",
    )
    .iterate(workspaceId)) {
    const prior = storage.getTeam(workspaceId, teamId(row.team_id))!;
    const { sha256, ...body } = prior;
    storage.append(
      "team",
      prior.id,
      validateTeam(
        teamHash({
          ...body,
          revision: prior.revision + 1,
          status: "paused-import",
          archiveSha256,
          updatedAt: storage.stamp(),
        }),
      ),
      prior,
    );
  }
  recoverDeliveries(storage);
}
export function validateTeamDatabase(
  db: DatabaseSync,
  check: () => void = () => {},
): void {
  const storage = new TeamStorage(db, {
    writeTx: (op) => op(),
    getWorkspace: () => teamError(),
    checkBinding: () => teamError(),
    readMemberOwner: () => teamError(),
    assertMemberOwnerCurrent: () => teamError(),
    assertRecipientCurrent: () => teamError(),
    readAcceptedInput: () => teamError(),
  });
  validateTeamRelations(storage, check);
}
