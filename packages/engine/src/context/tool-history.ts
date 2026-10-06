import type { Message, SessionSnapshot } from "@moodcode/contracts";
import { validateToolResultEnvelope } from "@moodcode/contracts/validation";
import { textPrefix } from "../artifacts/validation.js";

export const TOOL_HISTORY_PREFIX = "[Moodcode historical tool result v1]";
/** Preserve the original journal; compact only old result observations with verified references. */
export function projectToolHistory(
  snapshot: SessionSnapshot,
  activeRunId?: string,
): SessionSnapshot {
  const messages = snapshot.messages.map((message) => {
    if (
      message.role !== "tool" ||
      message.runId === activeRunId ||
      !message.toolResult ||
      Buffer.byteLength(message.content) <= 2048
    )
      return message;
    let result: NonNullable<Message["toolResult"]>;
    try {
      result = validateToolResultEnvelope({
        ...message.toolResult,
        displayContent: "",
        modelContent: "",
      });
      if (
        !result.artifactRefs.length ||
        result.artifactRefs.some(
          (ref) =>
            ref.identity.sessionId !== message.sessionId ||
            ref.identity.runId !== message.runId,
        )
      )
        return message;
    } catch {
      return message;
    }
    const content = `${TOOL_HISTORY_PREFIX}\n${JSON.stringify({
      historicalObservation: true,
      currentFileEvidence: false,
      outcome: result.outcome,
      toolCallId: message.toolCallId,
      excerpt: textPrefix(message.content, 1024),
      omittedContentBytes: Math.max(
        0,
        Buffer.byteLength(message.content) -
          Buffer.byteLength(textPrefix(message.content, 1024)),
      ),
      warnings: result.warnings
        .slice(0, 8)
        .map((warning) => textPrefix(warning, 256)),
      omittedWarnings: Math.max(0, result.warnings.length - 8),
      artifacts: result.artifactRefs
        .slice(0, 4)
        .map((ref) => ({
          id: ref.id,
          identity: ref.identity,
          sha256: ref.sha256,
          storedBytes: ref.storedBytes,
          complete: ref.complete,
          outcome: ref.outcome,
          expiresAt: ref.expiresAt,
        })),
      omittedArtifactRefs: Math.max(0, result.artifactRefs.length - 4),
    })}`;
    // Pathological identity lengths cannot make a historical projection larger than its source.
    return Buffer.byteLength(content) < Buffer.byteLength(message.content) &&
      Buffer.byteLength(content) <= 8192
      ? { ...message, content }
      : message;
  });
  return { ...snapshot, messages };
}
