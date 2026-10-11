import { EngineError, type Workspace } from "@moodcode/contracts";
import { createPatchAdapter } from "../tools/file-actions/adapter.js";
import { exactPath, readExactText } from "../tools/file-actions/text.js";
import type { ToolDefinition } from "../ports.js";
import type { LspManager } from "../lsp/index.js";
import { raceAbort, settleWithin } from "../shared/runtime.js";
export { applyTextEdits, positionOffset } from "./edits.js";
export type { TextEdit, TextRange, TextPosition } from "./edits.js";
export type FormatterPort = (request: {
  workspace: Workspace;
  path: string;
  content: string;
  signal: AbortSignal;
}) => Promise<string>;
/** Host-provided formatter receives text only; the model cannot configure executable paths or commands. */
export class FormatterRegistry {
  private formatters = new Map<string, FormatterPort>();
  register(id: string, formatter: FormatterPort): () => void {
    if (
      !/^[A-Za-z0-9_.-]{1,64}$/.test(id) ||
      this.formatters.has(id) ||
      this.formatters.size >= 16 ||
      typeof formatter !== "function"
    )
      throw new EngineError(
        "INVALID_FORMATTER",
        "Formatter requires a unique bounded host identity",
      );
    this.formatters.set(id, formatter);
    return () => {
      if (this.formatters.get(id) === formatter) this.formatters.delete(id);
    };
  }
  async propose(
    workspace: Workspace,
    id: string,
    path: string,
    signal: AbortSignal,
  ): Promise<{ path: string; content: string; expectedHash: string }> {
    path = exactPath(path);
    const formatter = this.formatters.get(id);
    if (!formatter)
      throw new EngineError(
        "FORMATTER_UNAVAILABLE",
        "Formatter is not explicitly registered",
      );
    const before = await readExactText(workspace, path, signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const cancelled = () =>
      new EngineError("CANCELLED", "Formatting cancelled");
    try {
      const formatting = raceAbort(
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw cancelled();
          return formatter({
            workspace: structuredClone(workspace),
            path,
            content: before.content,
            signal: controller.signal,
          });
        }),
        controller.signal,
        cancelled,
      );
      if (!(await settleWithin(formatting, 5000))) {
        controller.abort();
        throw new EngineError(
          "FORMATTER_TIMEOUT",
          "Formatter exceeded its five second deadline",
        );
      }
      const content = await formatting;
      if (
        typeof content !== "string" ||
        Buffer.byteLength(content) > 1024 * 1024 ||
        content.includes("\0") ||
        Buffer.from(content).toString() !== content
      )
        throw new EngineError(
          "INVALID_FORMAT_RESULT",
          "Formatter must return bounded UTF-8 text",
        );
      if (
        signal.aborted ||
        this.formatters.get(id) !== formatter ||
        (await readExactText(workspace, path, signal)).hash !== before.hash
      )
        throw new EngineError(
          "FORMAT_PREIMAGE_STALE",
          "Formatter registration or observed file changed",
        );
      return { path, content, expectedHash: before.hash };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
export function createFormatTool(
  formatters: FormatterRegistry,
): ToolDefinition {
  return createPatchAdapter({
    name: "format_file",
    description:
      "Preview a host-registered formatter result and apply one approved preimage-checked text patch.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, formatterId: { type: "string" } },
      required: ["path", "formatterId"],
      additionalProperties: false,
    },
    async transform(input, context) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length !== 2 ||
        !("path" in input) ||
        !("formatterId" in input) ||
        typeof input.formatterId !== "string"
      )
        throw new EngineError(
          "INVALID_FORMAT_INPUT",
          "Formatting requires exact path and formatter identity",
        );
      const proposal = await formatters.propose(
        context.workspace,
        input.formatterId,
        exactPath(input.path),
        context.signal,
      );
      return {
        input: { path: proposal.path, formatterId: input.formatterId },
        changes: [proposal],
        preview: { formatterId: input.formatterId },
      };
    },
  });
}
export function createLspFormatTool(lsp: LspManager): ToolDefinition {
  return createPatchAdapter({
    name: "lsp_format_file",
    description:
      "Preview UTF-16 LSP formatting edits for the observed document and apply an approved checkpointed patch.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        serverId: { type: "string" },
        languageId: { type: "string" },
      },
      required: ["path", "serverId", "languageId"],
      additionalProperties: false,
    },
    async transform(input, context) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length !== 3 ||
        !("path" in input) ||
        !("serverId" in input) ||
        !("languageId" in input) ||
        typeof input.serverId !== "string" ||
        typeof input.languageId !== "string"
      )
        throw new EngineError(
          "INVALID_FORMAT_INPUT",
          "LSP formatting requires exact path, server and language identity",
        );
      const proposal = await lsp.formatting(
        context.workspace,
        input.serverId,
        exactPath(input.path),
        input.languageId,
        context.signal,
      );
      return {
        input: {
          path: proposal.path,
          serverId: input.serverId,
          languageId: input.languageId,
        },
        changes: [
          {
            path: proposal.path,
            expectedHash: proposal.expectedHash,
            content: proposal.content,
          },
        ],
        preview: {
          serverId: proposal.serverId,
          documentVersion: proposal.documentVersion,
        },
      };
    },
  });
}
