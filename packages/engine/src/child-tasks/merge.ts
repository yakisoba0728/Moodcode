import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import type { ToolDefinition } from "../ports.js";
import { runGit } from "../workspace/git.js";
import {
  createPatchAdapter,
  type FullContentChange,
} from "../tools/file-actions/adapter.js";
import {
  exactPath,
  readExactText,
  textHash,
} from "../tools/file-actions/text.js";
import type { WorktreeManager } from "../worktrees/index.js";
import { safeCheckoutArguments } from "../worktrees/safe-checkout.js";
import type { ChildTaskManager } from "./index.js";
/** Produces an ordinary approved patch; Git merge/apply/commit are never invoked. */
export function createChildMergeTool(
  tasks: ChildTaskManager,
  worktrees: WorktreeManager,
  rootSessionId?: string,
): ToolDefinition {
  return createPatchAdapter({
    name: "merge_child_changes",
    description:
      "Preview bounded UTF-8 file changes from an observed terminal child task and apply an approved checkpointed patch only when parent preimages match the child base commit.",
    inputSchema: {
      type: "object",
      properties: { childTaskId: { type: "string" } },
      required: ["childTaskId"],
      additionalProperties: false,
    },
    async transform(input, context) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length !== 1 ||
        !("childTaskId" in input) ||
        typeof input.childTaskId !== "string"
      )
        throw new EngineError(
          "INVALID_CHILD_MERGE",
          "Merge requires one exact child task identity",
        );
      const sessionId = rootSessionId ?? context.sessionId;
      const task = tasks.get(sessionId, input.childTaskId);
      if (
        task.state !== "completed" ||
        !task.outcome ||
        task.parentRunId !== context.runId
      )
        throw new EngineError(
          "CHILD_MERGE_UNAVAILABLE",
          "Merge requires an observed completed child owned by this parent run",
        );
      const worktree = worktrees.get(sessionId, task.worktreeId);
      if (
        worktree.baseRoot !== context.workspace.root ||
        worktree.workspaceId !== context.workspace.id
      )
        throw new EngineError(
          "CHILD_MERGE_OWNER_MISMATCH",
          "Child worktree belongs to a different parent workspace",
        );
      const child = await worktrees.verify(worktree, context.signal);
      const checkoutArgs = await safeCheckoutArguments(
        worktree.baseRoot,
        context.signal,
      );
      const changed = await runGit(
        child.root,
        [
          "diff",
          "--no-renames",
          "--name-only",
          "-z",
          worktree.baseCommit,
          "--",
        ],
        { signal: context.signal },
      );
      const added = await runGit(
        child.root,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        { signal: context.signal },
      );
      if (changed.code !== 0 || added.code !== 0)
        throw new EngineError(
          "CHILD_MERGE_OBSERVATION_FAILED",
          "Could not observe child changes",
        );
      const paths = [
        ...new Set(
          Buffer.concat([changed.stdout, added.stdout])
            .toString("utf8")
            .split("\0")
            .filter(Boolean),
        ),
      ].sort();
      if (!paths.length || paths.length > 32)
        throw new EngineError(
          "CHILD_MERGE_LIMIT",
          "Merge needs between 1 and 32 exact text paths",
        );
      const changes: FullContentChange[] = [];
      let total = 0;
      for (const candidate of paths) {
        const path = exactPath(candidate);
        const entry = await runGit(
          child.root,
          ["ls-tree", "-z", worktree.baseCommit, "--", path],
          { signal: context.signal },
        );
        if (entry.code !== 0)
          throw new EngineError(
            "CHILD_MERGE_OBSERVATION_FAILED",
            "Could not observe child base tree",
          );
        let before: string | null = null;
        if (entry.stdout.length) {
          if (!/^100644 blob [a-f0-9]{40,64}\t/.test(entry.stdout.toString()))
            throw new EngineError(
              "UNSUPPORTED_CHILD_MERGE",
              "Merge supports ordinary non-executable UTF-8 text files only",
            );
          // Parent attributes, not the child's, choose the checkout conversion;
          // filter drivers stay off.
          const blob = await runGit(
            worktree.baseRoot,
            [
              ...checkoutArgs,
              "cat-file",
              "--filters",
              `${worktree.baseCommit}:${path}`,
            ],
            { signal: context.signal },
          );
          if (
            blob.code !== 0 ||
            blob.stdout.length > 1024 * 1024 ||
            blob.stdout.includes(0) ||
            !Buffer.from(blob.stdout.toString("utf8")).equals(blob.stdout)
          )
            throw new EngineError(
              "UNSUPPORTED_CHILD_MERGE",
              "Child base file is not bounded UTF-8 text",
            );
          before = blob.stdout.toString("utf8");
        }
        let content: string | null;
        try {
          const current = await readExactText(child, path, context.signal);
          if (current.mode !== (0o666 & ~process.umask()))
            throw new EngineError(
              "UNSUPPORTED_CHILD_MERGE",
              "Merge refuses custom file modes",
            );
          content = current.content;
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ))
            throw error;
          try {
            await lstat(join(child.root, path));
            throw new EngineError(
              "CHILD_MERGE_STALE",
              "Child path changed during observation",
            );
          } catch (probe) {
            if (!(
              probe instanceof Error &&
              "code" in probe &&
              probe.code === "ENOENT"
            ))
              throw probe;
          }
          content = null;
        }
        if (content === before) continue;
        if (content === null && before === null)
          throw new EngineError(
            "CHILD_MERGE_STALE",
            "Added child path disappeared during observation",
          );
        total +=
          Buffer.byteLength(before ?? "") + Buffer.byteLength(content ?? "");
        if (total > 1024 * 1024)
          throw new EngineError(
            "CHILD_MERGE_LIMIT",
            "Merge preimages and content exceed 1 MiB",
          );
        changes.push({
          path,
          expectedHash: before === null ? null : textHash(before),
          content,
        });
      }
      if (!changes.length)
        throw new EngineError(
          "CHILD_MERGE_EMPTY",
          "Observed child files have no supported content changes",
        );
      const preview: JsonObject = {
        childTaskId: task.id,
        worktreeId: worktree.id,
        baseCommit: worktree.baseCommit,
        integration: "approved_full_content_patch",
        childState: task.state,
      };
      return { input: { childTaskId: task.id }, changes, preview };
    },
  });
}
