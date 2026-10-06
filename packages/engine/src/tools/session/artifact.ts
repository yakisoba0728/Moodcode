import { createHash } from "node:crypto";
import {
  EngineError,
  type ArtifactIdentity,
  type JsonObject,
} from "@moodcode/contracts";
import type { PreparedTool, ToolContext, ToolDefinition } from "../../ports.js";
import type { ArtifactStore } from "../../artifacts/store.js";
import type { SqliteStore } from "../../storage/index.js";
import { boundedJson } from "../../artifacts/validation.js";

export function createArtifactReadTool(
  store: SqliteStore,
  artifacts: () => Promise<ArtifactStore>,
): ToolDefinition {
  const requests = new WeakMap<
    PreparedTool,
    {
      owner: string;
      snapshot: string;
      used: boolean;
      identity: ArtifactIdentity;
      id: string;
      offset: number;
      limit: number;
    }
  >();
  const owner = (context: ToolContext) =>
    JSON.stringify([
      context.workspace.id,
      context.workspace.root,
      context.sessionId,
      context.runId,
      context.toolCallId,
      context.turnId,
      context.attemptId,
    ]);
  return {
    name: "read_artifact",
    effectClass: "read",
    description:
      "Read a bounded page of a historical tool artifact in the current session. References describe past observations; re-read files to check current state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        artifactId: { type: "string" },
        runId: { type: "string" },
        toolCallId: { type: "string" },
        turnId: { type: "string" },
        attemptId: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 16384 },
      },
      required: ["artifactId", "runId", "toolCallId"],
    },
    async prepare(value, context) {
      const input = boundedJson(value, 8192);
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) =>
            ![
              "artifactId",
              "runId",
              "toolCallId",
              "turnId",
              "attemptId",
              "offset",
              "limit",
            ].includes(key),
        )
      )
        throw new EngineError(
          "INVALID_ARTIFACT_INPUT",
          "Artifact read requires bounded exact identity fields",
        );
      for (const key of [
        "artifactId",
        "runId",
        "toolCallId",
        ...(input.turnId === undefined ? [] : ["turnId"]),
        ...(input.attemptId === undefined ? [] : ["attemptId"]),
      ]) {
        if (
          typeof input[key] !== "string" ||
          !input[key] ||
          Buffer.byteLength(input[key]) > 256 ||
          /[\u0000-\u001f\u007f]/u.test(input[key])
        )
          throw new EngineError(
            "INVALID_ARTIFACT_INPUT",
            "Artifact identity is invalid",
          );
      }
      if (input.attemptId !== undefined && input.turnId === undefined)
        throw new EngineError(
          "INVALID_ARTIFACT_INPUT",
          "Attempt identity requires its Turn",
        );
      const offset = input.offset ?? 0,
        limit = input.limit ?? 8192;
      if (
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        typeof limit !== "number" ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 16384
      )
        throw new EngineError(
          "INVALID_ARTIFACT_INPUT",
          "Artifact paging exceeds its bound",
        );
      const run = store.getRun(input.runId as string);
      if (run.sessionId !== context.sessionId)
        throw new EngineError(
          "RECORD_SCOPE_MISMATCH",
          "Artifact belongs to a different session",
        );
      if (context.signal.aborted)
        throw new EngineError("CANCELLED", "Artifact read cancelled");
      const identity: ArtifactIdentity = {
        sessionId: context.sessionId,
        runId: run.id,
        toolCallId: input.toolCallId as string,
        ...(input.turnId ? { turnId: input.turnId as string } : {}),
        ...(input.attemptId ? { attemptId: input.attemptId as string } : {}),
      };
      const normalized = { ...input, offset, limit } as JsonObject;
      const prepared: PreparedTool = {
        name: "read_artifact",
        input: normalized,
        fingerprint: createHash("sha256")
          .update(JSON.stringify([identity, normalized]))
          .digest("hex"),
        requiresApproval: false,
        preview: { operation: "artifact.read", ...normalized },
      };
      requests.set(prepared, {
        owner: owner(context),
        snapshot: JSON.stringify(prepared),
        identity,
        id: input.artifactId as string,
        offset,
        limit,
        used: false,
      });
      return prepared;
    },
    async execute(prepared, context) {
      const request = requests.get(prepared);
      if (
        !request ||
        request.used ||
        request.owner !== owner(context) ||
        request.snapshot !== JSON.stringify(prepared)
      )
        throw new EngineError(
          "ARTIFACT_REQUEST_STALE",
          "Artifact read must use its fresh prepared owner",
        );
      request.used = true;
      const page = await (
        await artifacts()
      ).read(request.id, {
        identity: request.identity,
        offset: request.offset,
        limit: request.limit,
        signal: context.signal,
      });
      const content = JSON.stringify({
        reference: page.reference,
        offset: page.offset,
        nextOffset: page.nextOffset ?? null,
        encoding: "base64",
        bytes: Buffer.from(page.bytes).toString("base64"),
        historicalObservation: true,
      });
      return { content, data: JSON.parse(content) as JsonObject };
    },
  };
}
