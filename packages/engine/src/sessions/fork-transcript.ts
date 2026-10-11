import type { JsonObject, RunConfig } from "@moodcode/contracts";
import type { ProviderMessage } from "../ports.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { replayCompatible } from "../provider/replay.js";
import {
  FORK_LIMITS,
  forkError,
  forkJson,
  withoutProviderReplay,
  type ConversationFork,
  type ForkPreview,
  type FrozenHistoryManifest,
} from "./fork-types.js";
function projectForkTranscript(
  source: FrozenHistoryManifest,
  config: ForkPreview["config"],
  disposition: ForkPreview["disposition"],
  protocol?: string,
): ProviderMessage[] {
  if (
    source.snapshot.messages.some(
      (m) => m.attachments?.length || m.documents?.length || m.media?.length,
    )
  )
    forkError(
      "FORK_MEDIA_UNSUPPORTED",
      "Forking media reference grants is not supported in this lane",
    );
  const messages: ProviderMessage[] = [];
  const pending = new Map<string, string>();
  for (const message of source.snapshot.messages) {
    if (!["user", "assistant", "tool"].includes(message.role))
      forkError("FORK_NATIVE_INVALID", "Unknown frozen message role");
    if (message.role === "user" && pending.size)
      forkError("FORK_NATIVE_INVALID", "Incomplete frozen tool exchange");
    let entry: ProviderMessage = {
      role: message.role,
      content: message.content,
    };
    if (message.toolCalls?.length) {
      if (message.role !== "assistant" || pending.size)
        forkError("FORK_NATIVE_INVALID", "Overlapping frozen tool exchange");
      entry.toolCalls = structuredClone(message.toolCalls);
      for (const call of message.toolCalls) {
        if (pending.has(call.id))
          forkError("FORK_NATIVE_INVALID", "Duplicated frozen tool call");
        pending.set(call.id, message.runId);
      }
    }
    if (message.role === "tool") {
      if (
        !message.toolCallId ||
        pending.get(message.toolCallId) !== message.runId
      )
        forkError(
          "FORK_NATIVE_INVALID",
          "Frozen tool result has no same-Run call",
        );
      entry.toolCallId = message.toolCallId;
      pending.delete(message.toolCallId);
    }
    if (message.providerReplay) {
      const run = source.snapshot.runs.find((r) => r.id === message.runId);
      if (
        !run ||
        run.config.providerId !== message.providerReplay.providerId ||
        message.providerReplay.modelId !== run.config.modelId
      )
        forkError(
          "FORK_OPAQUE_MISMATCH",
          "Opaque source state has no exact native model binding",
        );
      if (disposition === "exact-replay") {
        if (
          !replayCompatible(
            (entry = {
              ...entry,
              providerReplay: message.providerReplay,
            } as ProviderMessage),
            config.providerId,
            config.modelId,
            protocol ?? "",
          ) ||
          !message.providerReplay.modelId ||
          !message.providerReplay.protocol
        )
          forkError(
            "FORK_OPAQUE_MISMATCH",
            "Exact replay requires the same provider/model/protocol",
          );
      }
    }
    messages.push(entry);
  }
  if (pending.size)
    forkError("FORK_NATIVE_INVALID", "Unmatched frozen tool calls");
  const notice: ProviderMessage = {
    role: "assistant",
    content:
      "[Moodcode conversation fork DATA v1]\n" +
      JSON.stringify({
        sourceSessionId: source.sourceSessionId,
        sourceWorkspaceId: source.sourceWorkspaceId,
        throughRunId: source.throughRunId,
        sourceSha256: source.sha256,
        omittedRuns: source.omittedRuns,
        laterRunIds: source.laterRunIds,
        effectsRetained: true,
        historyIsNotUndo: true,
        priorApprovalsGrantNoAuthority: true,
        disposition,
      }),
  };
  const result =
    disposition === "semantic"
      ? [
          notice,
          {
            role: "assistant" as const,
            content:
              "[Frozen conversation quoted DATA]\n" +
              JSON.stringify(withoutProviderReplay(messages)),
          },
        ]
      : [notice, ...messages];
  return forkJson(result, FORK_LIMITS.transcriptBytes);
}
export function branchTranscript(
  messages: ForkPreview["transcript"],
  source: KnowledgeHostBinding,
  target: KnowledgeHostBinding,
  worktree: JsonObject | null,
): ForkPreview["transcript"] {
  return forkJson(
    [
      {
        role: "assistant" as const,
        content:
          "[Conversation fork branch DATA]\n" +
          JSON.stringify({
            sourceWorkspaceId: source.workspaceId,
            sourceRoot: source.root,
            targetWorkspaceId: target.workspaceId,
            targetRoot: target.root,
            worktreeId: worktree?.id ?? null,
            baseCommit: worktree?.baseCommit ?? null,
            priorEffectsBelongToSourceRoot: true,
            newEffectApprovalRequired: true,
            filesystemRewound: false,
          }),
      },
      ...messages,
    ],
    FORK_LIMITS.transcriptBytes,
  );
}
export function forkTranscript(
  source: FrozenHistoryManifest,
  config: RunConfig,
  disposition: ForkPreview["disposition"],
  parent: ConversationFork | null,
  protocol?: string,
): ForkPreview["transcript"] {
  const messages = projectForkTranscript(source, config, disposition, protocol);
  if (!parent) return messages;
  if (disposition === "semantic")
    return forkJson(
      [
        {
          role: "assistant" as const,
          content:
            "[Frozen parent lineage quoted DATA]\n" +
            JSON.stringify({
              sessionId: parent.sessionId,
              sha256: parent.sha256,
              messages: withoutProviderReplay(parent.preview.transcript),
            }),
        },
        ...messages,
      ],
      FORK_LIMITS.transcriptBytes,
    );
  for (const message of parent.preview.transcript)
    if (
      message.providerReplay &&
      !replayCompatible(
        message,
        config.providerId,
        config.modelId,
        protocol ?? "",
      )
    )
      forkError(
        "FORK_OPAQUE_MISMATCH",
        "Parent lineage opaque state requires the same target provider",
      );
  return forkJson(
    [...parent.preview.transcript, ...messages],
    FORK_LIMITS.transcriptBytes,
  );
}
