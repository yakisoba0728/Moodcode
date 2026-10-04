import type {
  Message,
  Run,
  SessionSnapshot,
  ToolCallRecord,
} from "@moodcode/contracts";

export const TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export function activeRun(snapshot: SessionSnapshot | null): Run | undefined {
  return snapshot?.runs.findLast((run) => !TERMINAL.has(run.state));
}
export function latestRun(snapshot: SessionSnapshot | null): Run | undefined {
  return snapshot?.runs.at(-1);
}
export const RUN_LABELS: Record<Run["state"], string> = {
  created: "접수됨",
  running: "실행 중",
  awaiting_approval: "승인 대기",
  cancelling: "중지 중",
  completed: "완료",
  failed: "실패",
  cancelled: "중지됨",
  interrupted: "중단됨",
};
export const TOOL_LABELS: Record<string, string> = {
  list_files: "파일 목록 확인",
  read_file: "파일 읽기",
  search_files: "코드 검색",
  apply_patch: "파일 수정",
  run_command: "명령 실행",
};
export function shortPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? path;
}
export type TimelineRow =
  | { kind: "message"; message: Message }
  | { kind: "tool"; tool: ToolCallRecord };
/** Both collections are in committed order. Associate tools with their source turn. */
export function timelineRows(
  messages: Message[],
  tools: ToolCallRecord[],
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let nextTool = 0;
  for (const message of messages) {
    if (message.role === "tool") continue;
    rows.push({ kind: "message", message });
    for (const call of message.toolCalls ?? []) {
      const tool = tools[nextTool];
      if (!tool || tool.name !== call.name) break;
      rows.push({ kind: "tool", tool });
      nextTool++;
    }
  }
  for (const tool of tools.slice(nextTool)) rows.push({ kind: "tool", tool });
  return rows;
}

export interface DiffLine {
  kind: "same" | "add" | "remove";
  text: string;
  before?: number;
  after?: number;
}
/** A bounded LCS display; larger files retain their exact text in the before/after view. */
export function buildDiff(
  before: string | null,
  after: string | null,
  maxLines = 800,
): { lines: DiffLine[]; large: boolean } {
  const a = before === null ? [] : before.split("\n");
  const b = after === null ? [] : after.split("\n");
  if (a.length > maxLines || b.length > maxLines)
    return { lines: [], large: true };
  const width = b.length + 1;
  const grid = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) {
      grid[i * width + j] =
        a[i] === b[j]
          ? grid[(i + 1) * width + j + 1]! + 1
          : Math.max(grid[(i + 1) * width + j]!, grid[i * width + j + 1]!);
    }
  const lines: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i]!, before: i + 1, after: j + 1 });
      i++;
      j++;
    } else if (
      i < a.length &&
      (j === b.length || grid[(i + 1) * width + j]! >= grid[i * width + j + 1]!)
    ) {
      lines.push({ kind: "remove", text: a[i]!, before: i + 1 });
      i++;
    } else {
      lines.push({ kind: "add", text: b[j]!, after: j + 1 });
      j++;
    }
  }
  return { lines, large: false };
}
