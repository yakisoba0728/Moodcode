import { teamObject, teamId, teamSha, teamInteger } from "./validation.js";
import { randomUUID, createHash } from "node:crypto";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import type { MoodcodeEngine } from "../engine.js";
import type { ToolContext } from "../ports.js";
import type { TeamMemberRevision } from "./types.js";
import {
  immutableKnowledgeJson,
  knowledgeHash,
} from "../knowledge/validation.js";
import type { TeamModelInput, TeamModelOperation } from "./model-tools.js";
export const TEAM_WORKFLOW_PREFIX = "team.workflow.";
export interface TeamBoardSubmission {
  id: string;
  requestId: string;
  requestSha256: string;
  memberId: string;
  memberGeneration: number;
  memberSha256: string;
  ownerSha256: string;
  text: string;
  native: {
    sessionId: string;
    runId: string;
    turnId: string;
    attemptId: string;
    toolCallId: string;
    approvalFingerprint: string;
    requestFingerprint: string;
  };
  review: null | {
    requestId: string;
    requestSha256: string;
    memberId: string;
    memberSha256: string;
    ownerSha256: string;
    verdict: "accept" | "request_changes";
    text: string;
    native: TeamBoardSubmission["native"];
  };
}
export interface TeamBoardRecord {
  version: 1;
  workspaceId: string;
  teamId: string;
  taskId: string;
  taskRevisionId: string;
  taskSha256: string;
  rootSessionId: string;
  revision: number;
  state: "submitted" | "reviewed" | "paused-import";
  submissions: TeamBoardSubmission[];
  sha256: string;
}
const id = (value: string) => createHash("sha256").update(value).digest("hex");
export const teamBoardKind = (team: string, task: string) =>
  TEAM_WORKFLOW_PREFIX + id(JSON.stringify([team, task])).slice(0, 48);
export function validateTeamBoardRecord(value: unknown): TeamBoardRecord {
  const r = immutableKnowledgeJson(value) as unknown as TeamBoardRecord;
  teamObject(r, [
    "version",
    "workspaceId",
    "teamId",
    "taskId",
    "taskRevisionId",
    "taskSha256",
    "rootSessionId",
    "revision",
    "state",
    "submissions",
    "sha256",
  ]);
  for (const k of [
    "workspaceId",
    "teamId",
    "taskId",
    "taskRevisionId",
    "rootSessionId",
  ] as const)
    teamId(r[k]);
  teamSha(r.taskSha256);
  teamSha(r.sha256);
  if (Array.isArray(r.submissions))
    for (const x of r.submissions) {
      teamObject(x, [
        "id",
        "requestId",
        "requestSha256",
        "memberId",
        "memberGeneration",
        "memberSha256",
        "ownerSha256",
        "text",
        "native",
        "review",
      ]);
      for (const k of ["id", "requestId", "memberId"] as const) teamId(x[k]);
      teamInteger(x.memberGeneration);
      for (const k of ["requestSha256", "memberSha256", "ownerSha256"] as const)
        teamSha(x[k]);
      for (const y of [x, x.review].filter((y) => y !== null)) {
        teamObject(y!.native, [
          "sessionId",
          "runId",
          "turnId",
          "attemptId",
          "toolCallId",
          "approvalFingerprint",
          "requestFingerprint",
        ]);
        for (const k of [
          "sessionId",
          "runId",
          "turnId",
          "attemptId",
          "toolCallId",
        ] as const)
          teamId(y!.native[k]);
        teamSha(y!.native.approvalFingerprint);
        teamSha(y!.native.requestFingerprint);
      }
      if (x.review) {
        teamObject(x.review, [
          "requestId",
          "requestSha256",
          "memberId",
          "memberSha256",
          "ownerSha256",
          "verdict",
          "text",
          "native",
        ]);
        if (
          typeof x.review.text !== "string" ||
          Buffer.byteLength(x.review.text) > 4096
        )
          throw new EngineError(
            "TEAM_WORKFLOW_INVALID",
            "Review DATA exceeds its bounded text size",
          );
        for (const k of ["requestId", "memberId"] as const) teamId(x.review[k]);
        for (const k of [
          "requestSha256",
          "memberSha256",
          "ownerSha256",
        ] as const)
          teamSha(x.review[k]);
      }
    }
  const { sha256, ...body } = r;
  if (
    r.version !== 1 ||
    knowledgeHash(body) !== sha256 ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 1 ||
    !["submitted", "reviewed", "paused-import"].includes(r.state) ||
    !Array.isArray(r.submissions) ||
    r.submissions.length < 1 ||
    r.submissions.length > 16 ||
    Buffer.byteLength(JSON.stringify(r)) > 32768
  )
    throw new EngineError(
      "TEAM_WORKFLOW_INVALID",
      "Native team submissions are invalid",
    );
  for (const x of r.submissions) {
    if (
      !x.id ||
      !x.requestId ||
      typeof x.text !== "string" ||
      Buffer.byteLength(x.text) > 4096 ||
      !x.native ||
      !x.native.toolCallId ||
      !x.native.approvalFingerprint ||
      (x.review && !["accept", "request_changes"].includes(x.review.verdict))
    )
      throw new EngineError(
        "TEAM_WORKFLOW_INVALID",
        "Team workflow evidence is incomplete",
      );
  }
  return r;
}
/** Advisory submissions/reviews; actual effects always use the ordinary native tools and approval. */
export class TeamWorkflowBoard {
  constructor(
    private readonly engine: MoodcodeEngine,
    private readonly complete: (
      input: import("./service.js").TeamTaskMutationInput,
    ) => unknown,
  ) {}
  private current(member: TeamMemberRevision, taskId: string) {
    const task = this.engine.getTeamTask(
      member.workspaceId,
      member.teamId,
      taskId,
    );
    if (!task || Date.parse(task.expiresAt) <= Date.now())
      throw new EngineError(
        "TEAM_MODEL_TASK_STALE",
        "Board task is unavailable",
      );
    const doc = this.engine.store.getSessionDocument(
      member.owner.rootSessionId,
      teamBoardKind(member.teamId, taskId),
    );
    const record = doc ? validateTeamBoardRecord(doc.data) : undefined;
    if (record && record.state === "paused-import")
      throw new EngineError(
        "TEAM_WORKFLOW_PAUSED",
        "Imported submissions are historical",
      );
    return { task, doc, record };
  }
  read(member: TeamMemberRevision, input: TeamModelInput = {}): JsonObject {
    const i = input as { afterTaskId?: string; limit?: number };
    const page = this.engine.readTeamTaskPage(
      member.workspaceId,
      member.teamId,
      i.afterTaskId,
      i.limit,
    );
    const value = {
      authority: "untrusted-team-data",
      hasMore: page.hasMore,
      nextTaskId: page.nextTaskId,
      tasks: page.tasks.map((task) => {
        const doc = this.engine.store.getSessionDocument(
          member.owner.rootSessionId,
          teamBoardKind(member.teamId, task.taskId),
        );
        const record = doc ? validateTeamBoardRecord(doc.data) : undefined;
        const latest = record?.submissions.at(-1);
        return {
          taskId: task.taskId,
          revision: task.revision,
          state: task.state,
          title: task.title,
          description: task.description,
          dependencies: task.dependencies.map((d) => d.taskId),
          expiresAt: task.expiresAt,
          owner: task.owner,
          workflow: record
            ? {
                state: record.state,
                revision: record.revision,
                sha256: record.sha256,
                submissionCount: record.submissions.length,
                latest: latest
                  ? {
                      id: latest.id,
                      memberId: latest.memberId,
                      text: latest.text,
                      review: latest.review
                        ? {
                            memberId: latest.review.memberId,
                            verdict: latest.review.verdict,
                            text: latest.review.text,
                          }
                        : null,
                    }
                  : null,
              }
            : null,
        };
      }),
    };
    if (Buffer.byteLength(JSON.stringify(value)) > 24576)
      throw new EngineError(
        "TEAM_MODEL_OUTPUT_LIMIT",
        "Complete board page exceeds the bounded actor snapshot",
      );
    return immutableKnowledgeJson(value) as JsonObject;
  }
  prepare(
    member: TeamMemberRevision,
    operation: TeamModelOperation,
    input: TeamModelInput,
  ): JsonObject {
    const i = input as {
      taskId: string;
      expectedRevision: number;
      submissionId?: string;
      requestId: string;
    };
    const { task, record } = this.current(member, i.taskId);
    const prior = record?.submissions
      .flatMap((x) => [x, x.review])
      .find((x) => x?.requestId === i.requestId);
    if (prior) {
      if (
        prior.requestSha256 !==
        knowledgeHash({ operation, data: input, actor: member.sha256 })
      )
        throw new EngineError("TEAM_REQUEST_CONFLICT", "Board request changed");
      return immutableKnowledgeJson({
        taskId: task.taskId,
        workflowSha256: record!.sha256,
        duplicate: true,
      });
    }
    if (task.revision !== i.expectedRevision || task.state !== "claimed")
      throw new EngineError(
        "TEAM_MODEL_TASK_STALE",
        "Submit/review requires its claimed revision",
      );
    if (
      operation === "submit_team_task" &&
      (!task.owner ||
        task.owner.memberId !== member.memberId ||
        task.owner.generation !== member.generation ||
        task.owner.memberSha256 !== member.sha256)
    )
      throw new EngineError(
        "TEAM_MODEL_PERMISSION_DENIED",
        "Only exact current claimant may submit",
      );
    if (
      operation === "review_team_task" &&
      (member.role !== "coordinator" ||
        !member.permissions.manageTasks ||
        !record ||
        record.submissions.at(-1)?.id !== i.submissionId ||
        record.submissions.at(-1)?.review ||
        task.owner?.memberId === member.memberId)
    )
      throw new EngineError(
        "TEAM_MODEL_PERMISSION_DENIED",
        "Independent coordinator review requires the exact unreviewed submission",
      );
    return immutableKnowledgeJson({
      taskId: task.taskId,
      taskRevisionId: task.id,
      taskSha256: task.sha256,
      workflowSha256: record?.sha256 ?? null,
      submissionId: record?.submissions.at(-1)?.id ?? null,
    });
  }
  invoke(
    member: TeamMemberRevision,
    operation: TeamModelOperation,
    input: TeamModelInput,
    context: ToolContext,
    fingerprint: string,
    nativeApprovalFingerprint?: string,
  ): JsonObject {
    if (operation === "read_team_board") return this.read(member, input);
    const data = immutableKnowledgeJson(input) as unknown as {
      taskId: string;
      expectedRevision: number;
      requestId: string;
      text: string;
      submissionId?: string;
      verdict?: "accept" | "request_changes";
    };
    this.prepare(member, operation, input);
    const { task, record } = this.current(member, data.taskId);
    const requestSha256 = knowledgeHash({
      operation,
      data,
      actor: member.sha256,
    });
    const prior = record?.submissions
      .flatMap((x) => [x, x.review])
      .find((x) => x?.requestId === data.requestId);
    if (prior) {
      if (prior.requestSha256 !== requestSha256)
        throw new EngineError("TEAM_REQUEST_CONFLICT", "Board request changed");
      return {
        recordId: record!.taskId,
        recordSha256: record!.sha256,
        duplicate: true,
      };
    }
    const native = {
      sessionId: context.sessionId,
      runId: context.runId,
      turnId: context.turnId!,
      attemptId: context.attemptId!,
      toolCallId: context.toolCallId,
      approvalFingerprint: teamSha(nativeApprovalFingerprint),
      requestFingerprint: fingerprint,
    };
    let submissions = record?.submissions ?? [];
    if (operation === "submit_team_task") {
      if (
        submissions.length >= 16 ||
        (submissions.at(-1) &&
          submissions.at(-1)!.review?.verdict !== "request_changes")
      )
        throw new EngineError(
          "TEAM_SUBMISSION_CONFLICT",
          "Pending or accepted submission cannot be replaced",
        );
      submissions = [
        ...submissions,
        {
          id: randomUUID(),
          requestId: data.requestId,
          requestSha256,
          memberId: member.memberId,
          memberGeneration: member.generation,
          memberSha256: member.sha256,
          ownerSha256: member.owner.sha256,
          text: data.text,
          native,
          review: null,
        },
      ];
    } else {
      const last = submissions.at(-1)!;
      submissions = [
        ...submissions.slice(0, -1),
        {
          ...last,
          review: {
            requestId: data.requestId,
            requestSha256,
            memberId: member.memberId,
            memberSha256: member.sha256,
            ownerSha256: member.owner.sha256,
            verdict: data.verdict!,
            text: data.text,
            native,
          },
        },
      ];
    }
    const body = {
      version: 1 as const,
      workspaceId: member.workspaceId,
      teamId: member.teamId,
      taskId: task.taskId,
      taskRevisionId: task.id,
      taskSha256: task.sha256,
      rootSessionId: member.owner.rootSessionId,
      revision: (record?.revision ?? 0) + 1,
      state:
        operation === "submit_team_task"
          ? ("submitted" as const)
          : ("reviewed" as const),
      submissions,
    };
    const next = validateTeamBoardRecord({
      ...body,
      sha256: knowledgeHash(body),
    });
    this.engine.store.commitTeamWorkflow(
      member.owner.rootSessionId,
      teamBoardKind(member.teamId, task.taskId),
      record?.revision ?? 0,
      next as unknown as JsonObject,
      () => {
        if (operation === "review_team_task" && data.verdict === "accept") {
          const submit = submissions.at(-1)!;
          this.complete({
            workspaceId: member.workspaceId,
            teamId: member.teamId,
            memberId: submit.memberId,
            generation: submit.memberGeneration,
            taskId: task.taskId,
            expectedRevision: task.revision,
            requestId: `review-accept:${submit.id}`,
          });
        }
      },
    );
    return {
      recordId: next.taskId,
      recordSha256: next.sha256,
      submissionId: submissions.at(-1)!.id,
      state: next.state,
      revision: next.revision,
      duplicate: false,
    };
  }
}
