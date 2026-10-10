import { EngineError } from "@moodcode/contracts";
import {
  immutableKnowledgeJson,
  knowledgeHash,
} from "../knowledge/validation.js";
import type {
  TeamAcceptedInputProof,
  TeamMailboxPage,
  TeamMemberOwnerProof,
  TeamMemberRevision,
} from "./types.js";
import { TEAM_LIMITS, teamId } from "./validation.js";

/** The host owns these handles. A description of a child is never input authority. */
export interface TeamOwnerPort {
  capture(selection: {
    readonly workspaceId: string;
    readonly rootSessionId: string;
    readonly rootRunId?: string;
    readonly childTaskId?: string;
  }): object;
  read(original: object): TeamMemberOwnerProof;
  assertCurrent(original: object, member: TeamMemberRevision): void;
  release(original: object): void;
}
export interface TeamChildInputTarget {
  readonly rootSessionId: string;
  readonly rootRunId: string;
  readonly childTaskId: string;
  readonly childSessionId: string;
  readonly childRunId: string;
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly storageBindingSha256: string;
}
export interface TeamChildInputPort {
  capture(rootSessionId: string, childTaskId: string): object;
  readTarget(original: object): TeamChildInputTarget;
  assertCurrent(original: object): void;
  /** assertCurrent plus whether the child can admit new input right now. */
  assertAdmissible(original: object): void;
  accept(
    original: object,
    input: { readonly requestId: string; readonly prompt: string },
  ): object;
  readAccepted(
    originalTarget: object,
    originalAccepted: object,
  ): TeamAcceptedInputProof;
  confirmDelivery(originalTarget:object,originalAccepted:object):void;
  release(original: object): void;
}
const TEAM_INPUT_PREFIX = "[Moodcode team mailbox v1]\n";
/** Complete quoted DATA; this message does not grant tool, source or completion authority. */
export function teamMailboxInput(page: TeamMailboxPage): {
  readonly prompt: string;
  readonly sha256: string;
} {
  page = immutableKnowledgeJson(page);
  if (
    Buffer.byteLength(JSON.stringify(page)) > TEAM_LIMITS.pageBytes ||
    page.messages.length > TEAM_LIMITS.pageItems
  )
    throw new EngineError(
      "TEAM_LIMIT",
      "Team input requires a complete bounded page",
    );
  const data = immutableKnowledgeJson({
    schemaVersion: 1,
    authority: "untrusted-team-data",
    teamId: teamId(page.teamId),
    memberId: teamId(page.memberId),
    generation: page.generation,
    pageSha256: page.sha256,
    messages: page.messages.map((message) => ({
      id: message.id,
      senderMemberId: message.senderMemberId,
      senderGeneration: message.senderGeneration,
      text: message.text,
      sha256: message.sha256,
    })),
  });
  const prompt = TEAM_INPUT_PREFIX + JSON.stringify(data);
  if (Buffer.byteLength(prompt) > TEAM_LIMITS.pageBytes)
    throw new EngineError(
      "TEAM_LIMIT",
      "Whole team input exceeds the native input budget",
    );
  return Object.freeze({ prompt, sha256: knowledgeHash(data) });
}
