import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { knowledgeHash } from "../knowledge/validation.js";
import type {
  AgentMessage,
  CreateTeamInput,
  RegisterTeamMemberInput,
  TeamMemberOwnerProof,
  TeamMemberRevision,
  TeamRecord,
  TeamRequestResult,
  TeamStateRevision,
} from "./types.js";
import type { TeamOwnerPort } from "./input-port.js";
import {
  teamHostAbort,
  teamHostData,
  teamHostError,
  teamHostExpiry,
  teamHostIds,
  teamHostObject,
  teamHostPermissions,
  teamHostSignal,
} from "./policy.js";
import { teamId, teamInteger, validateTeamOwner } from "./validation.js";

export interface TeamHostNativePort {
  createTeam(input: CreateTeamInput): TeamRequestResult<TeamRecord>;
  getTeam(workspaceId: string, teamId: string): TeamRecord | undefined;
  getMember(
    workspaceId: string,
    teamId: string,
    memberId: string,
  ): TeamMemberRevision | undefined;
  findOperationRequest(
    workspaceId: string,
    teamId: string,
    actorId: string,
    generation: number,
    requestId: string,
    inputSha256: string,
  ): TeamRequestResult<TeamStateRevision | AgentMessage> | undefined;
  registerMember(
    originalOwner: object,
    input: RegisterTeamMemberInput,
  ): TeamRequestResult<TeamMemberRevision>;
  retireMember(
    originalOwner: object,
    input: {
      workspaceId: string;
      teamId: string;
      memberId: string;
      generation: number;
      expectedRevision: number;
      requestId: string;
    },
  ): TeamRequestResult<TeamMemberRevision>;
}
export interface TeamHostServicePorts {
  readonly native: TeamHostNativePort;
  readonly owner: TeamOwnerPort;
  readonly now?: () => number;
}
export interface PreviewTeamMemberInput extends Omit<
  RegisterTeamMemberInput,
  "requestId" | "ownerSha256"
> {
  readonly rootSessionId: string;
  readonly childTaskId?: string;
  readonly signal?: AbortSignal;
}
export interface TeamMemberPreview {
  readonly schemaVersion: 1;
  readonly projection: "team-member-preview-v1";
  readonly id: string;
  readonly input: Omit<RegisterTeamMemberInput, "requestId">;
  readonly owner: TeamMemberOwnerProof;
  readonly teamSha256: string;
  readonly previousMemberSha256: string | null;
  readonly expiresAt: string;
  readonly sha256: string;
}
export interface JoinTeamMemberInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly approved: boolean;
  readonly preview: TeamMemberPreview;
  readonly signal?: AbortSignal;
}
export interface RetireTeamMemberInput {
  readonly workspaceId: string;
  readonly teamId: string;
  readonly memberId: string;
  readonly generation: number;
  readonly expectedRevision: number;
  readonly requestId: string;
  readonly signal?: AbortSignal;
}
interface Owner {
  readonly original: object;
  readonly proof: TeamMemberOwnerProof;
  released: boolean;
}
interface Preview {
  readonly public: TeamMemberPreview;
  readonly owner: object;
  usedRequestId: string | null;
  result?: TeamRequestResult<TeamMemberRevision>;
}

/** Host-only membership admission. It neither changes child tool permissions nor wakes a child. */
export class TeamHostService {
  private readonly owners = new WeakMap<object, Owner>();
  private readonly previews = new WeakMap<object, Preview>();
  private readonly retained = new Set<object>();
  private readonly retainedPreviews = new Set<object>();
  private closed = false;
  constructor(private readonly ports: TeamHostServicePorts) {}
  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }
  private open(): void {
    if (this.closed) teamHostError("TEAM_CLOSED");
  }
  captureOwner(selection: {
    readonly workspaceId: string;
    readonly rootSessionId: string;
    readonly rootRunId?: string;
    readonly childTaskId?: string;
  }): object {
    this.open();
    teamHostObject(
      selection,
      ["workspaceId", "rootSessionId"],
      ["childTaskId", "rootRunId"],
    );
    teamHostIds(selection, ["workspaceId", "rootSessionId"]);
    if (selection.childTaskId !== undefined) teamId(selection.childTaskId);
    if (selection.rootRunId !== undefined) teamId(selection.rootRunId);
    if (this.retained.size >= 128) teamHostError("TEAM_LIMIT");
    const original = this.ports.owner.capture(teamHostData(selection));
    try {
      const proof = validateTeamOwner(this.ports.owner.read(original));
      if (
        proof.rootSessionId !== selection.rootSessionId ||
        proof.childTaskId !== (selection.childTaskId ?? null) ||
        (selection.rootRunId !== undefined &&
          proof.rootRunId !== selection.rootRunId)
      )
        teamHostError("TEAM_OWNER_STALE");
      const handle = Object.freeze({ id: randomUUID() });
      this.owners.set(handle, { original, proof, released: false });
      this.retained.add(handle);
      return handle;
    } catch (error) {
      this.ports.owner.release(original);
      throw error;
    }
  }
  private owned(original: object): Owner {
    if (!original || types.isProxy(original)) teamHostError("TEAM_OWNER_STALE");
    const state = this.owners.get(original);
    if (!state || state.released) teamHostError("TEAM_OWNER_STALE");
    return state;
  }
  readMemberOwner(original: object): TeamMemberOwnerProof {
    const state = this.owned(original),
      current = validateTeamOwner(this.ports.owner.read(state.original));
    if (current.sha256 !== state.proof.sha256)
      teamHostError("TEAM_OWNER_STALE");
    return current;
  }
  assertMemberOwnerCurrent(original: object, member: TeamMemberRevision): void {
    this.open();
    const state = this.owned(original);
    this.ports.owner.assertCurrent(state.original, member);
    const {
        cleanup: _currentCleanup,
        sha256: _currentSha,
        ...current
      } = this.readMemberOwner(original),
      { cleanup: _oldCleanup, sha256: _oldSha, ...previous } = member.owner;
    // Retirement can observe confirmed/unknown cleanup of the same actual owner.
    // Native activeMember separately requires the original complete SHA and live cleanup.
    if (knowledgeHash(current) !== knowledgeHash(previous))
      teamHostError("TEAM_OWNER_STALE");
  }
  releaseOwner(original: object): void {
    const state = this.owners.get(original);
    if (!state || state.released) return;
    state.released = true;
    this.retained.delete(original);
    this.ports.owner.release(state.original);
  }
  assertRecipientCurrent(member: TeamMemberRevision): void {
    const original = this.captureOwner({
      workspaceId: member.workspaceId,
      rootSessionId: member.owner.rootSessionId,
      rootRunId: member.owner.rootRunId,
      ...(member.owner.childTaskId === null
        ? {}
        : { childTaskId: member.owner.childTaskId }),
    });
    try {
      const current = this.readMemberOwner(original);
      if (current.cleanup !== "live" || current.sha256 !== member.owner.sha256)
        teamHostError("TEAM_OWNER_STALE");
      this.assertMemberOwnerCurrent(original, member);
    } finally {
      this.releaseOwner(original);
    }
  }
  createTeam(input: CreateTeamInput): TeamRequestResult<TeamRecord> {
    this.open();
    return this.ports.native.createTeam(teamHostData(input));
  }
  previewMember(input: PreviewTeamMemberInput): TeamMemberPreview {
    this.open();
    teamHostObject(
      input,
      [
        "workspaceId",
        "teamId",
        "memberId",
        "expectedRevision",
        "role",
        "permissions",
        "expiresAt",
        "rootSessionId",
      ],
      ["childTaskId", "signal"],
    );
    if (input.signal !== undefined) teamHostSignal(input.signal);
    teamHostAbort(input.signal);
    teamHostIds(input, ["workspaceId", "teamId", "memberId", "rootSessionId"]);
    teamInteger(input.expectedRevision);
    const permissions = teamHostPermissions(input.role, input.permissions),
      team = this.ports.native.getTeam(input.workspaceId, input.teamId);
    if (!team || team.status !== "active") teamHostError("TEAM_INACTIVE");
    const expiresAt = teamHostExpiry(
      input.expiresAt,
      this.now(),
      Date.parse(team.expiresAt),
    );
    if (this.retainedPreviews.size >= 128) teamHostError("TEAM_LIMIT");
    const previous = this.ports.native.getMember(
      input.workspaceId,
      input.teamId,
      input.memberId,
    );
    if ((previous?.revision ?? 0) !== input.expectedRevision)
      teamHostError("TEAM_REVISION_CONFLICT");
    const owner = this.captureOwner({
      workspaceId: input.workspaceId,
      rootSessionId: input.rootSessionId,
      ...(input.childTaskId !== undefined
        ? { childTaskId: input.childTaskId }
        : {}),
    });
    try {
      const ownerProof = this.readMemberOwner(owner);
      const body = {
        schemaVersion: 1 as const,
        projection: "team-member-preview-v1" as const,
        id: randomUUID(),
        input: {
          workspaceId: input.workspaceId,
          teamId: input.teamId,
          memberId: input.memberId,
          ownerSha256: ownerProof.sha256,
          expectedRevision: input.expectedRevision,
          ...permissions,
          expiresAt,
        },
        owner: ownerProof,
        teamSha256: team.sha256,
        previousMemberSha256: previous?.sha256 ?? null,
        expiresAt,
      };
      const preview = teamHostData({ ...body, sha256: knowledgeHash(body) });
      teamHostAbort(input.signal);
      this.previews.set(preview, {
        public: preview,
        owner,
        usedRequestId: null,
      });
      this.retainedPreviews.add(preview);
      return preview;
    } catch (error) {
      this.releaseOwner(owner);
      throw error;
    }
  }
  joinMember(
    input: JoinTeamMemberInput,
  ): TeamRequestResult<TeamMemberRevision> {
    teamHostObject(
      input,
      ["workspaceId", "requestId", "approved", "preview"],
      ["signal"],
    );
    teamId(input.workspaceId);
    teamId(input.requestId);
    if (input.signal !== undefined) teamHostSignal(input.signal);
    if (input.approved !== true) teamHostError("TEAM_APPROVAL_REQUIRED");
    if (!input.preview || types.isProxy(input.preview))
      teamHostError("TEAM_PREVIEW_STALE");
    const state = this.previews.get(input.preview);
    if (!state || state.public.input.workspaceId !== input.workspaceId)
      teamHostError("TEAM_PREVIEW_STALE");
    if (state.usedRequestId !== null) {
      if (state.usedRequestId !== input.requestId || !state.result)
        teamHostError("TEAM_PREVIEW_USED");
      return Object.freeze({ ...state.result, duplicate: true });
    }
    this.open();
    teamHostAbort(input.signal);
    if (
      !this.retainedPreviews.has(input.preview) ||
      Date.parse(state.public.expiresAt) <= this.now()
    )
      teamHostError("TEAM_PREVIEW_STALE");
    const team = this.ports.native.getTeam(
        input.workspaceId,
        state.public.input.teamId,
      ),
      previous = this.ports.native.getMember(
        input.workspaceId,
        state.public.input.teamId,
        state.public.input.memberId,
      );
    if (
      team?.sha256 !== state.public.teamSha256 ||
      (previous?.sha256 ?? null) !== state.public.previousMemberSha256
    )
      teamHostError("TEAM_PREVIEW_STALE");
    this.readMemberOwner(state.owner);
    teamHostAbort(input.signal);
    const result = this.ports.native.registerMember(state.owner, {
      ...state.public.input,
      requestId: input.requestId,
    });
    if (result.record.owner.sha256 !== state.public.owner.sha256)
      teamHostError("TEAM_REQUEST_CONFLICT");
    state.usedRequestId = input.requestId;
    state.result = result;
    this.releasePreview(input.preview);
    return result;
  }
  releasePreview(original: TeamMemberPreview): void {
    const state = this.previews.get(original);
    if (!state || !this.retainedPreviews.delete(original)) return;
    this.releaseOwner(state.owner);
  }
  retireMember(
    input: RetireTeamMemberInput,
  ): TeamRequestResult<TeamMemberRevision> {
    this.open();
    teamHostObject(
      input,
      [
        "workspaceId",
        "teamId",
        "memberId",
        "generation",
        "expectedRevision",
        "requestId",
      ],
      ["signal"],
    );
    teamHostIds(input, ["workspaceId", "teamId", "memberId", "requestId"]);
    teamInteger(input.generation);
    teamInteger(input.expectedRevision);
    if (input.signal !== undefined) teamHostSignal(input.signal);
    teamHostAbort(input.signal);
    const nativeInput = teamHostData({
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        memberId: input.memberId,
        generation: input.generation,
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
      }),
      duplicate = this.ports.native.findOperationRequest(
        input.workspaceId,
        input.teamId,
        "host",
        0,
        input.requestId,
        knowledgeHash(nativeInput),
      );
    if (duplicate) {
      if (!("memberId" in duplicate.record))
        teamHostError("TEAM_SCOPE_MISMATCH");
      return Object.freeze({ ...duplicate, record: duplicate.record });
    }
    const member = this.ports.native.getMember(
      input.workspaceId,
      input.teamId,
      input.memberId,
    );
    if (!member || member.generation !== input.generation)
      teamHostError("TEAM_MEMBER_STALE");
    const owner = this.captureOwner({
      workspaceId: member.workspaceId,
      rootSessionId: member.owner.rootSessionId,
      rootRunId: member.owner.rootRunId,
      ...(member.owner.childTaskId === null
        ? {}
        : { childTaskId: member.owner.childTaskId }),
    });
    try {
      return this.ports.native.retireMember(owner, nativeInput);
    } finally {
      this.releaseOwner(owner);
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const preview of this.retainedPreviews)
      this.releasePreview(preview as TeamMemberPreview);
    for (const owner of this.retained) this.releaseOwner(owner);
  }
}
