import assert from "node:assert/strict";
import test from "node:test";
import type { Message, ToolCallRecord } from "@moodcode/contracts";
import { buildDiff, timelineRows } from "./model.js";

test("diff preserves exact inserted/deleted/empty text and both source line positions", () => {
  const before = "a\nremoved\nb\n",
    after = "a\nb\nadded\n";
  const result = buildDiff(before, after);
  assert.equal(result.large, false);
  assert.equal(
    result.lines
      .filter((l) => l.kind !== "add")
      .map((l) => l.text)
      .join("\n"),
    before,
  );
  assert.equal(
    result.lines
      .filter((l) => l.kind !== "remove")
      .map((l) => l.text)
      .join("\n"),
    after,
  );
  assert.deepEqual(
    result.lines
      .filter((l) => l.kind === "same")
      .map((l) => [l.before, l.after]),
    [
      [1, 1],
      [3, 2],
      [4, 4],
    ],
  );
  assert.equal(buildDiff(null, "").lines[0]?.kind, "add");
  assert.equal(buildDiff("", null).lines[0]?.kind, "remove");
});

test("large diffs use the bounded before/after display without fabricating a partial diff", () => {
  assert.deepEqual(buildDiff("a\n".repeat(801), "b"), {
    lines: [],
    large: true,
  });
});

test("tool cards remain between their source turn and the final assistant response", () => {
  const message = (
    id: string,
    role: Message["role"],
    names: string[] = [],
  ): Message => ({
    id,
    role,
    sessionId: "s",
    runId: "r",
    content: id,
    createdAt: "2026-10-04T00:00:00Z",
    ...(names.length
      ? {
          toolCalls: names.map((name, index) => ({
            id: `native-${id}-${index}`,
            name,
            input: {},
          })),
        }
      : {}),
  });
  const tool = (id: string, name: string): ToolCallRecord => ({
    id,
    name,
    sessionId: "s",
    runId: "r",
    input: {},
    state: "completed",
  });
  const result = timelineRows(
    [
      message("user", "user"),
      message("first", "assistant", ["read_file", "read_file"]),
      message("toolResult", "tool"),
      message("second", "assistant", ["apply_patch"]),
      message("final", "assistant"),
    ],
    [
      tool("read1", "read_file"),
      tool("read2", "read_file"),
      tool("patch", "apply_patch"),
    ],
  );
  assert.deepEqual(
    result.map((r) => (r.kind === "message" ? r.message.id : r.tool.id)),
    ["user", "first", "read1", "read2", "second", "patch", "final"],
  );
});
