import type { AcceptInput, InputRecord, Run } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";

export function acceptedRequest(input: InputRecord): AcceptInput {
  return {
    sessionId: input.sessionId,
    requestId: input.requestId,
    prompt: input.prompt,
    config: input.config,
    delivery: input.delivery,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.documents ? { documents: input.documents } : {}),
  };
}

export function isPromotedCommandRunInvalid(
  input: InputRecord,
  run: Run,
  receipt: { readonly target: { readonly config: Run["config"] } },
): boolean {
  return (
    input.state !== "promoted" ||
    input.runId !== run.id ||
    run.workspaceId !== input.workspaceId ||
    run.sessionId !== input.sessionId ||
    run.requestId !== input.requestId ||
    run.prompt !== input.prompt ||
    knowledgeHash(run.config) !== knowledgeHash(receipt.target.config) ||
    Object.hasOwn(run, "attachments") ||
    Object.hasOwn(run, "documents")
  );
}
