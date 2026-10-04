import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import {
  TEXT_PAGE,
  TEXT_PREVIEW,
  copyFits,
  fencedCode,
  lineLocation,
  textPage,
} from "../conversation.js";

const LANGUAGES = {
  javascript,
  typescript,
  json,
  python,
  bash,
  css,
  xml,
  sql,
  yaml,
  markdown,
  diff,
  go,
};
const ALIASES: Record<string, keyof typeof LANGUAGES> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  html: "xml",
  svg: "xml",
  yml: "yaml",
  md: "markdown",
  patch: "diff",
  golang: "go",
};
const HIGHLIGHT_OPTIONS = { detect: false, languages: LANGUAGES };
const HIGHLIGHT_PLUGINS: NonNullable<
  ComponentProps<typeof Markdown>["rehypePlugins"]
> = [[rehypeHighlight, HIGHLIGHT_OPTIONS]];
const HIGHLIGHT_COMPONENTS: NonNullable<
  ComponentProps<typeof Markdown>["components"]
> = {
  img: () => null,
  a: ({ children }) => <span>{children}</span>,
};
const HighlightedPage = memo(function HighlightedPage({
  content,
}: {
  content: string;
}) {
  return (
    <Markdown
      skipHtml
      rehypePlugins={HIGHLIGHT_PLUGINS}
      components={HIGHLIGHT_COMPONENTS}
    >
      {content}
    </Markdown>
  );
});

function canonicalLanguage(language: string | undefined): string {
  const value = language?.toLowerCase() ?? "";
  if (Object.hasOwn(LANGUAGES, value)) return value;
  return ALIASES[value] ?? "";
}

/** Highlight only the current bounded page, never a whole unbounded tool result. */
export const CodeBlock = memo(function CodeBlock({
  source,
  language,
  label = "코드",
  copy = true,
  initialLine,
}: {
  source: string;
  language?: string;
  label?: string;
  copy?: boolean;
  initialLine?: number;
}) {
  const origin = useMemo(
    () => lineLocation(source, initialLine),
    [source, initialLine],
  );
  const [view, setView] = useState(() => ({
    source,
    initialLine,
    expanded: false,
    offsets: [origin.offset],
  }));
  const [copyState, setCopyState] = useState<
    "idle" | "pending" | "copied" | "error"
  >("idle");
  const mounted = useRef(false);
  const copyRequest = useRef(0);
  const currentIdentity = useRef({ source, initialLine });
  currentIdentity.current = { source, initialLine };
  const clearCopy = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      copyRequest.current++;
      clearTimeout(clearCopy.current);
    };
  }, []);
  const current =
    view.source === source && Object.is(view.initialLine, initialLine)
      ? view
      : { source, initialLine, expanded: false, offsets: [origin.offset] };
  const offset = current.offsets.at(-1) ?? origin.offset;
  const currentPageOffset = useRef(offset);
  currentPageOffset.current = offset;
  useEffect(() => {
    copyRequest.current++;
    clearTimeout(clearCopy.current);
    setCopyState("idle");
  }, [source, initialLine, offset]);
  const page = useMemo(
    () => textPage(source, offset, current.expanded ? TEXT_PAGE : TEXT_PREVIEW),
    [source, offset, current.expanded],
  );
  const highlighted = canonicalLanguage(language);
  const fenced = useMemo(
    () => fencedCode(page.text, highlighted),
    [page.text, highlighted],
  );
  const fullCopy = useMemo(() => copyFits(source), [source]);
  const lineNumbers = useMemo(() => {
    const count = Math.max(1, page.lastLine - page.firstLine + 1);
    return Array.from({ length: count }, (_, index) => page.firstLine + index);
  }, [page.firstLine, page.lastLine]);
  async function copySource() {
    if (copyState === "pending") return;
    const api = window.moodcode;
    if (!api || !("copyText" in api) || typeof api.copyText !== "function") {
      setCopyState("error");
      return;
    }
    const request = ++copyRequest.current;
    const stillCurrent = () =>
      mounted.current &&
      request === copyRequest.current &&
      currentPageOffset.current === offset &&
      currentIdentity.current.source === source &&
      Object.is(currentIdentity.current.initialLine, initialLine);
    clearTimeout(clearCopy.current);
    setCopyState("pending");
    try {
      await api.copyText(fullCopy ? source : page.text);
      if (!stillCurrent()) return;
      setCopyState("copied");
      clearCopy.current = setTimeout(() => {
        if (stillCurrent()) setCopyState("idle");
      }, 2_000);
    } catch {
      if (stillCurrent()) setCopyState("error");
    }
  }
  return (
    <div className="conversation-code">
      <div className="conversation-code-header">
        <span>{language || label}</span>
        {copy ? (
          <button
            type="button"
            className="text-button"
            disabled={copyState === "pending"}
            aria-label={`${fullCopy ? "원문" : "현재 화면"} ${label} 복사`}
            onClick={() => {
              void copySource();
            }}
          >
            {copyState === "pending"
              ? "복사 중"
              : copyState === "copied"
                ? "복사됨"
                : fullCopy
                  ? "원문 복사"
                  : "현재 화면 복사"}
          </button>
        ) : null}
      </div>
      {origin.clamped ? (
        <p className="conversation-output-note conversation-line-notice">
          요청한 {origin.requestedLine.toLocaleString("ko-KR")}줄이 없어 마지막{" "}
          {origin.line.toLocaleString("ko-KR")}줄을 열었어요.
        </p>
      ) : null}
      <div
        className={
          initialLine === undefined ? undefined : "conversation-code-with-lines"
        }
      >
        {initialLine === undefined ? null : (
          <div className="conversation-line-numbers" aria-label="원본 줄 번호">
            {lineNumbers.map((line) => (
              <span
                key={line}
                aria-current={line === origin.line ? "location" : undefined}
                title={`${line}줄`}
              >
                {line}
              </span>
            ))}
          </div>
        )}
        {highlighted ? (
          <HighlightedPage content={fenced} />
        ) : (
          <pre>
            <code>{page.text}</code>
          </pre>
        )}
      </div>
      {page.hasMore || current.offsets.length > 1 ? (
        <div className="conversation-code-footer">
          <span>
            저장된 원문 중 {page.firstLine.toLocaleString("ko-KR")}–
            {page.lastLine.toLocaleString("ko-KR")}줄 표시
            {page.partialLine ? " · 줄 일부가 다음 화면에 이어져요" : ""}
          </span>
          {current.offsets.length > 1 ? (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setView({ ...current, offsets: current.offsets.slice(0, -1) });
              }}
            >
              이전
            </button>
          ) : null}
          {!current.expanded ? (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setView({
                  source,
                  initialLine,
                  expanded: true,
                  offsets: [origin.offset],
                });
              }}
            >
              더 보기
            </button>
          ) : page.hasMore ? (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setView({
                  ...current,
                  offsets: [...current.offsets, page.end],
                });
              }}
            >
              다음
            </button>
          ) : null}
          {current.expanded ? (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setView({
                  source,
                  initialLine,
                  expanded: false,
                  offsets: [origin.offset],
                });
              }}
            >
              접기
            </button>
          ) : null}
        </div>
      ) : null}
      {initialLine !== undefined &&
      origin.offset > 0 &&
      offset > 0 &&
      current.offsets.length === 1 ? (
        <div className="conversation-code-footer">
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setView({ source, initialLine, expanded: true, offsets: [0] });
            }}
          >
            파일 처음부터 보기
          </button>
        </div>
      ) : null}
      {copyState === "error" ? (
        <p className="conversation-copy-error" role="status">
          클립보드에 복사하지 못했어요. 표시된 원문을 선택해 복사할 수 있어요.
        </p>
      ) : null}
    </div>
  );
});
