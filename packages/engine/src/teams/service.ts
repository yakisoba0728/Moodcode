import { types } from "node:util";
import { knowledgeHash } from "../knowledge/validation.js";
import type { TeamHostService } from "./host.js";
import { teamMailboxInput, type TeamChildInputPort } from "./input-port.js";
import {
  teamHostAbort,
  teamHostData,
  teamHostError,
  teamHostIds,
  teamHostObject,
  teamHostSignal,
} from "./policy.js";
import type {
  AgentMessage,
  PutTeamTaskInput,
  SendAgentMessageInput,
  TeamAcceptedInputProof,
  TeamClaimReceipt,
  TeamDeliveryCapture,
  TeamDeliveryReceipt,
  TeamDeliveryRecord,
  TeamMailboxPage,
  TeamMemberRevision,
  TeamRequestResult,
  TeamStateRevision,
  TeamTaskRevision,
} from "./types.js";
import { teamId, teamInteger } from "./validation.js";

export interface TeamServiceNativePort {
  getMember(
    workspaceId: string,
    teamId: string,
    memberId: string,
  ): TeamMemberRevision | undefined;
  findSendRequest(
    input: SendAgentMessageInput,
  ): TeamRequestResult<AgentMessage> | undefined;
  findOperationRequest(
    workspaceId: string,
    teamId: string,
    actorId: string,
    generation: number,
    requestId: string,
    inputSha256: string,
  ): TeamRequestResult<TeamStateRevision | AgentMessage> | undefined;
  send(
    originalSender: object,
    input: SendAgentMessageInput,
  ): TeamRequestResult<AgentMessage>;
  readMailbox(
    originalRecipient: object,
    input: {
      workspaceId: string;
      teamId: string;
      memberId: string;
      generation: number;
      limit?: number;
    },
  ): TeamMailboxPage;
  claimMailbox(
    originalPage: TeamMailboxPage,
    input: { requestId: string; expectedCursorRevision: number },
  ): TeamClaimReceipt;
  releasePage(original: TeamMailboxPage): void;
  putTask(
    originalCoordinator: object,
    input: PutTeamTaskInput,
  ): TeamRequestResult<TeamTaskRevision>;
  claimTask(
    originalMember: object,
    input: TeamTaskMutationInput,
  ): TeamRequestResult<TeamTaskRevision>;
  completeTask(
    originalMember: object,
    input: TeamTaskMutationInput,
  ): TeamRequestResult<TeamTaskRevision>;
  prepareDelivery(
    originalPage: TeamMailboxPage,
    input: { requestId: string; expectedCursorRevision: number },
  ):
    | {
        kind: "created";
        capture: TeamDeliveryCapture;
        record: TeamDeliveryRecord;
      }
    | {
        kind: "duplicate";
        record: TeamDeliveryRecord;
        receipt: TeamDeliveryReceipt | null;
      };
  dispatchDelivery(original: TeamDeliveryCapture): TeamDeliveryRecord;
  completeDelivery(
    original: TeamDeliveryCapture,
    originalAccepted: object,
  ): { record: TeamDeliveryRecord; receipt: TeamDeliveryReceipt };
  cancelDelivery(original: TeamDeliveryCapture, errorCode?: string): void;
  releaseDelivery(original: TeamDeliveryCapture): void;
  getDeliveryHistory(
    workspaceId: string,
    id: string,
  ):
    | { record: TeamDeliveryRecord; receipt: TeamDeliveryReceipt | null }
    | undefined;
}
export interface TeamTaskMutationInput {
  readonly workspaceId: string;
  readonly teamId: string;
  readonly taskId: string;
  readonly memberId: string;
  readonly generation: number;
  readonly requestId: string;
  readonly expectedRevision: number;
}
export interface TeamServicePorts {
  beforeCompleteTask?(input:TeamTaskMutationInput):void;
  readonly native: TeamServiceNativePort;
  readonly host: TeamHostService;
  readonly input: TeamChildInputPort;
}
export interface ReadAgentMailboxInput {
  readonly workspaceId: string;
  readonly teamId: string;
  readonly memberId: string;
  readonly generation: number;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}
export interface ResumeChildTurnInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly approved: boolean;
  readonly page: TeamMailboxPage;
  readonly expectedCursorRevision: number;
  readonly signal?: AbortSignal;
}
export interface ResumeChildTurnResult {
  readonly record: TeamDeliveryRecord;
  readonly receipt: TeamDeliveryReceipt | null;
  readonly duplicate: boolean;
}
interface Page {
  readonly original: TeamMailboxPage;
  readonly owner: object;
  usedRequestId: string | null;
  result?: TeamClaimReceipt;
  deliveryRequestId: string | null;
  delivery?: ResumeChildTurnResult;
  released: boolean;
}
interface Delivery {
  readonly target: object;
  readonly page: Page;
  readonly prompt: string;
  readonly inputRequestId: string;
  accepted?: object;
}

/** Messages and board state are native data. Only explicit delivery touches an already live child. */
export class TeamService {
  private readonly pages = new WeakMap<object, Page>();
  private readonly retained = new Set<TeamMailboxPage>();
  private readonly deliveries = new WeakMap<object, Delivery>();
  private closed = false;
  constructor(private readonly ports: TeamServicePorts) {}
  private open(): void {
    if (this.closed) teamHostError("TEAM_CLOSED");
  }
  private member(
    workspaceId: string,
    teamId: string,
    memberId: string,
    generation: number,
  ): TeamMemberRevision {
    const member = this.ports.native.getMember(workspaceId, teamId, memberId);
    if (
      !member ||
      member.generation !== generation ||
      member.status !== "active"
    )
      teamHostError("TEAM_MEMBER_STALE");
    return member;
  }
  private owner(member: TeamMemberRevision): object {
    return this.ports.host.captureOwner({
      workspaceId: member.workspaceId,
      rootSessionId: member.owner.rootSessionId,
      ...(member.owner.childTaskId === null
        ? {}
        : { childTaskId: member.owner.childTaskId }),
    });
  }
  sendAgentMessage(
    input: SendAgentMessageInput,
  ): TeamRequestResult<AgentMessage> {
    this.open();
    const data = teamHostData(input),
      duplicate = this.ports.native.findSendRequest(data);
    if (duplicate) return duplicate;
    const recipient = this.member(
      data.workspaceId,
      data.teamId,
      data.recipientMemberId,
      data.recipientGeneration,
    );
    this.ports.host.assertRecipientCurrent(recipient);
    const member = this.member(
        data.workspaceId,
        data.teamId,
        data.senderMemberId,
        data.senderGeneration,
      ),
      owner = this.owner(member);
    try {
      return this.ports.native.send(owner, data);
    } finally {
      this.ports.host.releaseOwner(owner);
    }
  }
  readAgentMailbox(input: ReadAgentMailboxInput): TeamMailboxPage {
    this.open();
    teamHostObject(
      input,
      ["workspaceId", "teamId", "memberId", "generation"],
      ["limit", "signal"],
    );
    if (input.signal !== undefined) teamHostSignal(input.signal);
    teamHostAbort(input.signal);
    teamHostIds(input, ["workspaceId", "teamId", "memberId"]);
    teamInteger(input.generation);
    if (input.limit !== undefined) teamInteger(input.limit, 64);
    if (this.retained.size >= 128) teamHostError("TEAM_LIMIT");
    const member = this.member(
        input.workspaceId,
        input.teamId,
        input.memberId,
        input.generation,
      ),
      owner = this.owner(member);
    try {
      const page = this.ports.native.readMailbox(owner, {
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        memberId: input.memberId,
        generation: input.generation,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      teamHostAbort(input.signal);
      this.pages.set(page, {
        original: page,
        owner,
        usedRequestId: null,
        deliveryRequestId: null,
        released: false,
      });
      this.retained.add(page);
      return page;
    } catch (error) {
      this.ports.host.releaseOwner(owner);
      throw error;
    }
  }
  private page(original: TeamMailboxPage, allowUsed = false): Page {
    if (!original || types.isProxy(original)) teamHostError("TEAM_PAGE_STALE");
    const page = this.pages.get(original);
    if (!page || (!allowUsed && page.released))
      teamHostError("TEAM_PAGE_STALE");
    return page;
  }
  claimAgentMailbox(input: {
    readonly workspaceId: string;
    readonly requestId: string;
    readonly page: TeamMailboxPage;
    readonly expectedCursorRevision: number;
    readonly signal?: AbortSignal;
  }): TeamClaimReceipt {
    teamHostObject(
      input,
      ["workspaceId", "requestId", "page", "expectedCursorRevision"],
      ["signal"],
    );
    teamHostIds(input, ["workspaceId", "requestId"]);
    teamInteger(input.expectedCursorRevision);
    if (input.signal !== undefined) teamHostSignal(input.signal);
    const page = this.page(input.page, true);
    if (page.original.workspaceId !== input.workspaceId)
      teamHostError("TEAM_PAGE_STALE");
    if (input.expectedCursorRevision !== page.original.cursor.revision)
      teamHostError("TEAM_REQUEST_CONFLICT");
    if (page.usedRequestId !== null) {
      if (page.usedRequestId !== input.requestId || !page.result)
        teamHostError("TEAM_PAGE_USED");
      return Object.freeze({ ...page.result, duplicate: true });
    }
    this.open();
    teamHostAbort(input.signal);
    if (page.released || page.deliveryRequestId !== null)
      teamHostError("TEAM_PAGE_USED");
    const result = this.ports.native.claimMailbox(page.original, {
      requestId: input.requestId,
      expectedCursorRevision: input.expectedCursorRevision,
    });
    page.usedRequestId = input.requestId;
    page.result = result;
    this.releasePage(page.original);
    return result;
  }
  putTeamTask(input: PutTeamTaskInput): TeamRequestResult<TeamTaskRevision> {
    this.open();
    const data = teamHostData(input),
      duplicate = this.taskDuplicate(data, knowledgeHash(data));
    if (duplicate) return duplicate;
    const member = this.member(
        data.workspaceId,
        data.teamId,
        data.memberId,
        data.generation,
      ),
      owner = this.owner(member);
    try {
      return this.ports.native.putTask(owner, data);
    } finally {
      this.ports.host.releaseOwner(owner);
    }
  }
  claimTeamTask(
    input: TeamTaskMutationInput,
  ): TeamRequestResult<TeamTaskRevision> {
    return this.task(input, false);
  }
  completeTeamTask(
    input: TeamTaskMutationInput,
  ): TeamRequestResult<TeamTaskRevision> {
    this.ports.beforeCompleteTask?.(teamHostData(input));
    return this.task(input, true);
  }
  /** Called only through the private exact-approved board review producer. */
  completeReviewedTask(input:TeamTaskMutationInput):TeamRequestResult<TeamTaskRevision>{return this.task(input,true);}
  private taskDuplicate(
    data: {
      workspaceId: string;
      teamId: string;
      memberId: string;
      generation: number;
      requestId: string;
    },
    sha: string,
  ): TeamRequestResult<TeamTaskRevision> | undefined {
    const duplicate = this.ports.native.findOperationRequest(
      data.workspaceId,
      data.teamId,
      data.memberId,
      data.generation,
      data.requestId,
      sha,
    );
    if (!duplicate) return undefined;
    if (!("taskId" in duplicate.record)) teamHostError("TEAM_SCOPE_MISMATCH");
    return Object.freeze({ ...duplicate, record: duplicate.record });
  }
  private task(
    input: TeamTaskMutationInput,
    complete: boolean,
  ): TeamRequestResult<TeamTaskRevision> {
    this.open();
    const data = teamHostData(input),
      duplicate = this.taskDuplicate(
        data,
        knowledgeHash(complete ? { ...data, operation: "complete" } : data),
      );
    if (duplicate) return duplicate;
    const member = this.member(
        data.workspaceId,
        data.teamId,
        data.memberId,
        data.generation,
      ),
      owner = this.owner(member);
    try {
      return complete
        ? this.ports.native.completeTask(owner, data)
        : this.ports.native.claimTask(owner, data);
    } finally {
      this.ports.host.releaseOwner(owner);
    }
  }
  resumeChildTurn(input: ResumeChildTurnInput): ResumeChildTurnResult {
    teamHostObject(
      input,
      [
        "workspaceId",
        "requestId",
        "approved",
        "page",
        "expectedCursorRevision",
      ],
      ["signal"],
    );
    teamHostIds(input, ["workspaceId", "requestId"]);
    teamInteger(input.expectedCursorRevision);
    if (input.signal !== undefined) teamHostSignal(input.signal);
    if (input.approved !== true) teamHostError("TEAM_APPROVAL_REQUIRED");
    const page = this.page(input.page, true);
    if (page.original.workspaceId !== input.workspaceId)
      teamHostError("TEAM_PAGE_STALE");
    if (input.expectedCursorRevision !== page.original.cursor.revision)
      teamHostError("TEAM_REQUEST_CONFLICT");
    if (page.deliveryRequestId !== null) {
      if (page.deliveryRequestId !== input.requestId || !page.delivery)
        teamHostError("TEAM_PAGE_USED");
      return Object.freeze({ ...page.delivery, duplicate: true });
    }
    this.open();
    teamHostAbort(input.signal);
    if (
      page.released ||
      page.usedRequestId !== null ||
      page.original.messages.length === 0
    )
      teamHostError("TEAM_PAGE_USED");
    const member = this.member(
      input.workspaceId,
      page.original.teamId,
      page.original.memberId,
      page.original.generation,
    );
    if (member.owner.kind !== "child" || member.owner.childTaskId === null)
      teamHostError("TEAM_CHILD_REQUIRED");
    this.ports.host.assertMemberOwnerCurrent(page.owner, member);
    const target = this.ports.input.capture(
      member.owner.rootSessionId,
      member.owner.childTaskId,
    );
    let capture: TeamDeliveryCapture | undefined,
      dispatched = false,
      failed = false;
    try {
      const described = this.ports.input.readTarget(target);
      if (
        described.childSessionId !== member.owner.sessionId ||
        described.childRunId !== member.owner.runId ||
        described.childTaskId !== member.owner.childTaskId ||
        described.rootSessionId !== member.owner.rootSessionId ||
        described.rootRunId !== member.owner.rootRunId ||
        described.storageBindingSha256 !== member.owner.childStorageSha256 ||
        described.worktreeId !== member.owner.worktreeId ||
        described.workspaceId !== member.owner.workspaceId
      )
        teamHostError("TEAM_CHILD_STALE");
      const prepared = this.ports.native.prepareDelivery(page.original, {
        requestId: input.requestId,
        expectedCursorRevision: input.expectedCursorRevision,
      });
      if (prepared.kind === "duplicate") {
        const result = teamHostData({
          record: prepared.record,
          receipt: prepared.receipt,
          duplicate: true,
        });
        page.deliveryRequestId = input.requestId;
        page.delivery = result;
        this.releasePage(page.original);
        return result;
      }
      capture = prepared.capture;
      const formatted = teamMailboxInput(page.original),
        inputRequestId = `team-delivery:${prepared.record.id}`;
      const state: Delivery = {
        target,
        page,
        prompt: formatted.prompt,
        inputRequestId,
      };
      this.deliveries.set(capture, state);
      teamHostAbort(input.signal);
      this.ports.input.assertAdmissible(target);
      this.ports.host.assertMemberOwnerCurrent(page.owner, member);
      this.ports.native.dispatchDelivery(capture);
      dispatched = true;
      // Synchronous original acceptance: no scheduler wake or budget reset.
      teamHostAbort(input.signal);
      this.ports.input.assertCurrent(target);
      const accepted = this.ports.input.accept(target, {
        requestId: inputRequestId,
        prompt: formatted.prompt,
      });
      state.accepted = accepted;
      const completed = this.ports.native.completeDelivery(capture, accepted),
        result = teamHostData({ ...completed, duplicate: false });
      this.ports.input.confirmDelivery?.(target,accepted);
      page.deliveryRequestId = input.requestId;
      page.delivery = result;
      this.releasePage(page.original);
      return result;
    } catch (error) {
      failed = true;
      if (capture !== undefined)
        try {
          this.ports.native.cancelDelivery(
            capture,
            dispatched ? "TEAM_DELIVERY_UNCERTAIN" : "TEAM_DELIVERY_CANCELLED",
          );
          const history = this.ports.native.getDeliveryHistory(
            input.workspaceId,
            capture.deliveryId,
          );
          if (history) {
            page.deliveryRequestId = input.requestId;
            page.delivery = teamHostData({ ...history, duplicate: false });
            this.releasePage(page.original);
          }
        } catch {}
      throw error;
    } finally {
      try {
        if (capture !== undefined) this.ports.native.releaseDelivery(capture);
      } catch (releaseError) {
        if (!failed) throw releaseError;
      } finally {
        this.ports.input.release(target);
      }
    }
  }
  readAcceptedInput(
    capture: TeamDeliveryCapture,
    original: object,
  ): TeamAcceptedInputProof {
    const state = this.deliveries.get(capture);
    if (!state || state.accepted !== original || types.isProxy(original))
      teamHostError("TEAM_INPUT_STALE");
    const proof = teamHostData(
        this.ports.input.readAccepted(state.target, original),
      ),
      target = this.ports.input.readTarget(state.target);
    if (
      proof.sessionId !== target.childSessionId ||
      (proof.delivery==="steer" && proof.runId !== target.childRunId) ||
      proof.requestId !== state.inputRequestId ||
      !["steer","queue"].includes(proof.delivery)
    )
      teamHostError("TEAM_INPUT_STALE");
    return proof;
  }
  releasePage(original: TeamMailboxPage): void {
    const page = this.pages.get(original);
    if (!page || page.released) return;
    page.released = true;
    this.retained.delete(original);
    this.ports.native.releasePage(original);
    this.ports.host.releaseOwner(page.owner);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const page of this.retained) this.releasePage(page);
  }
}
