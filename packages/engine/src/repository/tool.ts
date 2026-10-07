import { createHash } from "node:crypto";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import { projectToolResult } from "../artifacts/index.js";
import type { PreparedTool, ToolContext, ToolDefinition } from "../ports.js";
import { repositoryQuery, type RepositoryContextService } from "./index.js";
const owner = (context: ToolContext) =>
  JSON.stringify([
    context.workspace.id,
    context.workspace.root,
    context.sessionId,
    context.runId,
    context.toolCallId,
    context.turnId ?? null,
    context.attemptId ?? null,
  ]);

/** Explicit read tool; the caller supplies paths/positions, never executable, server or language configuration. */
export function createRepositoryContextTool(
  repository: RepositoryContextService,
): ToolDefinition {
  const prepared = new WeakMap<
    PreparedTool,
    { owner: string; snapshot: string; preview: string; used: boolean }
  >();
  return {
    name: "repository_context",
    effectClass: "read",
    description:
      "Read host-supported document symbols, definitions or references with bounded source hashes. Results are observed snapshots; unsupported or omitted sources are explicit.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["symbols", "definition", "references"] },
        paths: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
          items: { type: "string" },
        },
        position: {
          type: "object",
          properties: {
            line: { type: "integer", minimum: 0, maximum: 1_000_000 },
            character: { type: "integer", minimum: 0, maximum: 1_000_000 },
          },
          required: ["line", "character"],
          additionalProperties: false,
        },
      },
      required: ["kind", "paths"],
      additionalProperties: false,
    },
    async prepare(value, context) {
      const query = repositoryQuery(value);
      const preview = await repository.preview(
        context.workspace,
        query,
        context.signal,
      );
      const result: PreparedTool = {
        name: "repository_context",
        input: JSON.parse(JSON.stringify(query)),
        requiresApproval: false,
        fingerprint: createHash("sha256")
          .update(JSON.stringify([owner(context), preview.fingerprint]))
          .digest("hex"),
        preview: {
          authority: "read-only",
          sourceManifestDigest: preview.fingerprint,
          files: preview.manifest.files,
          bindings: preview.manifest.bindings,
        } as unknown as JsonObject,
      };
      prepared.set(result, {
        owner: owner(context),
        snapshot: JSON.stringify(result),
        preview: preview.fingerprint,
        used: false,
      });
      return result;
    },
    async execute(request, context) {
      const binding = prepared.get(request);
      if (
        !binding ||
        binding.used ||
        binding.owner !== owner(context) ||
        binding.snapshot !== JSON.stringify(request)
      )
        throw new EngineError(
          "REPOSITORY_REQUEST_STALE",
          "Repository request must be unchanged and consumed once by its original owner",
        );
      binding.used = true;
      const result = await repository.query(
        context.workspace,
        repositoryQuery(request.input),
        context.signal,
        binding.preview,
      );
      return projectToolResult(
        {
          displayContent: JSON.stringify(result),
          structuredData: JSON.parse(JSON.stringify(result)),
          warnings: result.complete
            ? []
            : [
                "Repository observations are incomplete; inspect unsupported and omitted sources.",
              ],
          outcome: "completed",
        },
        {
          maxModelBytes: Math.min(context.limits.maxOutputBytes, 16_384),
          maxDisplayBytes: Math.min(context.limits.maxOutputBytes, 16_384),
          maxStructuredBytes: Math.min(context.limits.maxOutputBytes, 16_384),
        },
      );
    },
  };
}
