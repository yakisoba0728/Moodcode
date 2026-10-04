import type { JsonValue, Run, ToolCallRecord } from "@moodcode/contracts";

export const TEXT_PREVIEW = Object.freeze({ maxLines: 80, maxBytes: 8_192 });
export const TEXT_PAGE = Object.freeze({ maxLines: 400, maxBytes: 32_768 });
export const MAX_COPY_BYTES = 1_048_576;

export interface TextPage {
  text: string;
  start: number;
  end: number;
  firstLine: number;
  lastLine: number;
  bytes: number;
  hasMore: boolean;
  partialLine: boolean;
}

/** Find a 1-based file line without allocating an array of the whole file. */
export function lineLocation(
  source: string,
  requestedLine = 1,
): {
  offset: number;
  line: number;
  requestedLine: number;
  clamped: boolean;
} {
  const target =
    Number.isSafeInteger(requestedLine) && requestedLine > 0
      ? requestedLine
      : 1;
  let offset = 0;
  let line = 1;
  while (line < target) {
    const next = source.indexOf("\n", offset);
    if (next === -1) break;
    offset = next + 1;
    line++;
  }
  return { offset, line, requestedLine: target, clamped: line !== target };
}

/** Offsets are UTF-16 positions; every displayed page ends on a code point. */
export function textPage(
  source: string,
  start = 0,
  limits: { maxLines: number; maxBytes: number } = TEXT_PAGE,
): TextPage {
  let beginning = Math.min(source.length, Math.max(0, Math.trunc(start)));
  if (
    beginning > 0 &&
    source.charCodeAt(beginning) >= 0xdc00 &&
    source.charCodeAt(beginning) <= 0xdfff &&
    source.charCodeAt(beginning - 1) >= 0xd800 &&
    source.charCodeAt(beginning - 1) <= 0xdbff
  )
    beginning--;
  const maxBytes = Math.max(4, Math.trunc(limits.maxBytes));
  const maxLines = Math.max(1, Math.trunc(limits.maxLines));
  let end = beginning;
  let bytes = 0;
  let newlines = 0;
  while (end < source.length) {
    const point = source.codePointAt(end)!;
    const length =
      point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + length > maxBytes) break;
    bytes += length;
    end += point > 0xffff ? 2 : 1;
    if (point === 10 && ++newlines >= maxLines) break;
  }
  const text = source.slice(beginning, end);
  const firstLine = 1 + countNewlines(source, beginning);
  const lineCount = newlines + (text && !text.endsWith("\n") ? 1 : 0);
  return {
    text,
    start: beginning,
    end,
    firstLine,
    lastLine: firstLine + Math.max(0, lineCount - 1),
    bytes,
    hasMore: end < source.length,
    partialLine: end < source.length && !text.endsWith("\n"),
  };
}

export function copyFits(source: string): boolean {
  if (source.length > MAX_COPY_BYTES) return false;
  let bytes = 0;
  for (const character of source) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > MAX_COPY_BYTES) return false;
  }
  return true;
}

function countNewlines(source: string, end: number): number {
  let count = 0;
  for (let index = 0; index < end; index++) if (source[index] === "\n") count++;
  return count;
}

export type ConversationLink =
  | { kind: "external"; url: string }
  | { kind: "file"; path: string; line?: number };

/** Local paths are only hints. The host still validates the selected workspace. */
export function conversationLink(
  value: string,
  options: { bareFile?: boolean } = {},
): ConversationLink | null {
  if (!value || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value))
    return null;
  const source = value.trim();
  if (/^https?:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      if (!url.hostname || url.username || url.password) return null;
      return { kind: "external", url: url.href };
    } catch {
      return null;
    }
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(source);
  } catch {
    return null;
  }
  if (/^file:\/\//i.test(decoded)) {
    try {
      const local = decoded.slice(7);
      if (!local.startsWith("/") || local.startsWith("//")) return null;
      decoded = decodeURIComponent(local);
    } catch {
      return null;
    }
  }
  if (
    !decoded ||
    /[\u0000-\u001f\u007f\\?]/.test(decoded) ||
    decoded.startsWith("//") ||
    /^(?:javascript|data|mailto|command|codex|vscode|https?|ftp|tel|ssh|file):/i.test(
      decoded,
    )
  )
    return null;
  let path = decoded;
  let line: number | undefined;
  const hash = decoded.indexOf("#");
  if (hash !== -1) {
    const range = /^L([1-9]\d*)(?:-L?([1-9]\d*))?$/.exec(
      decoded.slice(hash + 1),
    );
    if (!range) return null;
    line = Number(range[1]);
    if (range[2] && Number(range[2]) < line) return null;
    path = decoded.slice(0, hash);
  }
  const suffix = /^(.*?):([1-9]\d*)(?::([1-9]\d*))?$/.exec(path);
  if (suffix) {
    if (line !== undefined) return null;
    path = suffix[1]!;
    line = Number(suffix[2]);
  }
  if (
    !path ||
    /[:#]/.test(path) ||
    /^[a-z][a-z0-9+.-]*:/i.test(path) ||
    path.split("/").includes("..") ||
    (line !== undefined && (!Number.isSafeInteger(line) || line > 10_000_000))
  )
    return null;
  // Inline code such as `3.14` and arbitrary URI schemes are not file buttons.
  if (
    !options.bareFile &&
    !path.includes("/") &&
    !/\.[a-z][\w.-]*$/i.test(path) &&
    !/^\.[\p{L}_][\p{L}\p{N}_.-]*$/u.test(path) &&
    !/^(?:Dockerfile|Makefile|LICENSE)$/i.test(path)
  )
    return null;
  path = path.replace(/^(?:\.\/)+/, "");
  return { kind: "file", path, ...(line === undefined ? {} : { line }) };
}

export function fencedCode(source: string, language = ""): string {
  const runs = source.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  const safeLanguage = /^[a-z0-9_+-]{1,40}$/i.test(language) ? language : "";
  return `${fence}${safeLanguage}\n${source}${source.endsWith("\n") ? "" : "\n"}${fence}`;
}

export function toolInputText(input: JsonValue): string {
  return JSON.stringify(input, null, 2);
}

export interface ToolOutputView {
  source: string;
  language?: string;
  truncated: boolean;
  notices: string[];
  references: { path: string; line?: number; text?: string }[];
}

/** Render only persisted data: extraction never invents a successful outcome. */
export function toolOutputView(tool: ToolCallRecord): ToolOutputView {
  const source = tool.output ?? "";
  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(source);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      data = parsed as Record<string, unknown>;
  } catch {
    // Plain command output is a valid persisted result.
  }
  const references: ToolOutputView["references"] = [];
  const notices: string[] = [];
  const truncated = data?.truncated === true || data?.outputTruncated === true;
  if (truncated)
    notices.push(
      "도구가 일부 결과만 반환했어요. 아래는 저장된 결과이며 전체 파일·검색 결과가 아닐 수 있어요.",
    );
  if (typeof data?.returnedCount === "number")
    notices.push(`반환된 항목 ${data.returnedCount.toLocaleString("ko-KR")}개`);
  if (typeof data?.partialLastLine === "boolean" && data.partialLastLine)
    notices.push("마지막 줄은 도구의 출력 제한 때문에 일부만 반환됐어요.");
  if (tool.name === "read_file" && typeof data?.content === "string") {
    const link =
      typeof data.path === "string"
        ? conversationLink(data.path, { bareFile: true })
        : null;
    if (link?.kind === "file") {
      const line = positiveLine(data.startLine);
      references.push({ path: link.path, ...(line ? { line } : {}) });
    }
  }
  if (tool.name === "list_files" && Array.isArray(data?.files))
    for (const value of data.files.slice(0, 80)) {
      const link =
        typeof value === "string"
          ? conversationLink(value, { bareFile: true })
          : null;
      if (link?.kind === "file") references.push({ path: link.path });
    }
  if (tool.name === "search_files" && Array.isArray(data?.matches))
    for (const value of data.matches.slice(0, 80)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const match = value as Record<string, unknown>;
      const link =
        typeof match.path === "string"
          ? conversationLink(match.path, { bareFile: true })
          : null;
      if (link?.kind !== "file") continue;
      const line = positiveLine(match.line);
      references.push({
        path: link.path,
        ...(line ? { line } : {}),
        ...(typeof match.text === "string"
          ? { text: match.text.slice(0, 240) }
          : {}),
      });
    }
  return {
    source,
    language: data ? "json" : undefined,
    truncated,
    notices,
    references,
  };
}

function positiveLine(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 10_000_000
    ? value
    : undefined;
}

export function runErrorHelp(error: NonNullable<Run["error"]>): {
  cause: string;
  action: string;
} {
  if (error.code === "PROVIDER_HTTP_ERROR") {
    const status = /^Provider HTTP request failed with status (\d{3})\.$/.exec(
      error.message,
    )?.[1];
    if (status === "401" || status === "403")
      return {
        cause: "모델 공급자가 인증 또는 접근 권한을 확인하지 못했어요.",
        action:
          "설정에서 로그인 상태와 모델 접근 권한을 확인한 뒤 새 요청을 시작해 주세요.",
      };
    if (status === "429")
      return {
        cause: "모델 공급자가 요청 제한을 반환했어요.",
        action:
          "잠시 후 새 요청을 시작하거나 설정에서 다른 모델을 선택해 주세요.",
      };
    return {
      cause: "모델 공급자가 요청 오류를 반환했어요.",
      action:
        "아래 HTTP 상태와 모델 설정을 확인해 주세요. 공급자 장애라면 잠시 후 새 요청을 시작할 수 있어요.",
    };
  }
  switch (error.code) {
    case "OUTPUT_LIMIT":
      return {
        cause: "이번 실행에서 반환할 수 있는 출력 분량을 넘었어요.",
        action:
          "파일·폴더 범위를 좁히거나 필요한 줄 범위를 지정해 새 요청을 시작해 주세요. 앞서 실행한 작업은 변경 보기에서 확인할 수 있어요.",
      };
    case "CONTEXT_LIMIT":
      return {
        cause: "모델에 전달할 대화와 도구 결과가 실행 한도를 넘었어요.",
        action:
          "필요한 파일과 목적만 포함해 새 요청을 시작해 주세요. 완료된 변경은 그대로 남아 있으니 변경 보기를 먼저 확인해 주세요.",
      };
    case "TURN_LIMIT":
    case "TOOL_CALL_LIMIT":
      return {
        cause: "이번 실행의 모델 응답 또는 도구 호출 횟수를 모두 사용했어요.",
        action:
          "변경 보기를 확인하고 남은 작업을 더 작은 요청으로 이어가 주세요.",
      };
    case "RUN_TIME_LIMIT":
    case "TOOL_TIMEOUT":
      return {
        cause: "작업이 설정된 실행 시간을 넘었어요.",
        action:
          "명령 결과와 변경 보기를 확인하고 범위를 줄여 다시 요청해 주세요. 같은 명령을 실행하기 전에 이전 결과를 확인해 주세요.",
      };
    case "CLEANUP_PENDING":
    case "CLEANUP_UNCERTAIN":
    case "COMMAND_CLEANUP_UNCERTAIN":
      return {
        cause: "이전 작업의 파일 변경 또는 프로세스 종료를 확인하지 못했어요.",
        action:
          "프로젝트의 진단 화면에서 기록과 실행 상태를 확인해 주세요. 확인이 끝나기 전에는 같은 작업을 다시 실행하지 마세요.",
      };
    case "CODEX_AUTH_MISSING":
    case "CODEX_AUTH_EXPIRED":
    case "CODEX_AUTH_UNREADABLE":
    case "CODEX_AUTH_INVALID":
    case "CODEX_AUTH_UNSUPPORTED":
    case "PROVIDER_AUTH_ERROR":
      return {
        cause: "선택한 모델의 인증 정보를 사용할 수 없어요.",
        action:
          "설정에서 로그인 상태와 모델을 확인해 주세요. Codex 로그인 만료라면 Codex에서 다시 로그인한 후 새 요청을 시작해 주세요.",
      };
    case "PROVIDER_RATE_LIMIT":
      return {
        cause: "모델 공급자가 요청 제한을 반환했어요.",
        action:
          "잠시 후 새 요청을 시작하거나 설정에서 다른 모델을 선택해 주세요.",
      };
    case "PROVIDER_NETWORK_ERROR":
    case "PROVIDER_TRANSPORT_ERROR":
    case "PROVIDER_TIMEOUT":
      return {
        cause: "모델 공급자와의 연결이 끊기거나 응답 시간이 초과됐어요.",
        action:
          "네트워크와 설정을 확인한 뒤 새 요청을 시작해 주세요. 이미 적용된 변경은 변경 보기에 남아 있어요.",
      };
    case "PROVIDER_PROTOCOL_ERROR":
    case "PROVIDER_MALFORMED_STREAM":
    case "PROVIDER_INCOMPLETE_STREAM":
    case "PROVIDER_REMOTE_ERROR":
    case "PROVIDER_UNSUPPORTED_EVENT":
    case "PROVIDER_UNSUPPORTED_OUTPUT":
    case "PROVIDER_LENGTH":
      return {
        cause: "모델 응답이 정상적으로 완료되지 못했어요.",
        action:
          "설정에서 모델과 공급자를 확인하고 필요한 범위를 줄여 새 요청을 시작해 주세요.",
      };
    case "PROVIDER_CONTENT_FILTERED":
      return {
        cause: "모델 공급자가 응답을 제한했어요.",
        action:
          "요청 목적과 필요한 작업 범위를 명확히 설명해 새 요청을 시작해 주세요.",
      };
    case "PROVIDER_INVALID_REQUEST":
    case "PROVIDER_INVALID_REPLAY":
    case "PROVIDER_LIMIT_EXCEEDED":
      return {
        cause:
          "모델에 전달할 요청이 공급자의 형식 또는 분량 제한에 맞지 않아요.",
        action:
          "모델 설정을 확인하고 필요한 파일·목적만 포함해 새 요청을 시작해 주세요.",
      };
    default:
      return {
        cause: "실행 중 오류가 발생했어요.",
        action:
          "아래 오류 원문과 변경 보기를 확인한 뒤 필요한 작업을 새 요청으로 이어가 주세요.",
      };
  }
}
