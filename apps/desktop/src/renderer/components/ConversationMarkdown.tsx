import { memo, useMemo, type ComponentProps } from "react";
import Markdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { conversationLink } from "../conversation.js";
import { CodeBlock } from "./CodeBlock.js";
import "./conversation.css";

export type OpenConversationFile = (path: string, line?: number) => void;
const REMARK_PLUGINS = [remarkGfm];
const DISALLOWED = [
  "img",
  "iframe",
  "object",
  "embed",
  "script",
  "style",
  "form",
];

function MarkdownCode({ node, children }: ComponentProps<"pre"> & ExtraProps) {
  const code = node?.children.find(
    (child) => child.type === "element" && child.tagName === "code",
  );
  if (!code || code.type !== "element") return <pre>{children}</pre>;
  const source = code.children
    .map((child) => (child.type === "text" ? child.value : ""))
    .join("");
  const classes = code.properties.className;
  const language = Array.isArray(classes)
    ? classes.find(
        (value) => typeof value === "string" && value.startsWith("language-"),
      )
    : undefined;
  return (
    <CodeBlock
      source={source}
      language={typeof language === "string" ? language.slice(9) : undefined}
    />
  );
}

export const ConversationMarkdown = memo(function ConversationMarkdown({
  content,
  onOpenFile,
}: {
  content: string;
  onOpenFile?: OpenConversationFile;
}) {
  const components = useMemo<
    NonNullable<ComponentProps<typeof Markdown>["components"]>
  >(
    () => ({
      pre: MarkdownCode,
      img: () => null,
      table: ({ children }) => (
        <div
          className="conversation-table"
          role="region"
          aria-label="대화 표"
          tabIndex={0}
        >
          <table>{children}</table>
        </div>
      ),
      th: ({ children, node }) => (
        <th
          className={
            node?.properties.align === "right"
              ? "conversation-align-right"
              : node?.properties.align === "center"
                ? "conversation-align-center"
                : undefined
          }
        >
          {children}
        </th>
      ),
      td: ({ children, node }) => (
        <td
          className={
            node?.properties.align === "right"
              ? "conversation-align-right"
              : node?.properties.align === "center"
                ? "conversation-align-center"
                : undefined
          }
        >
          {children}
        </td>
      ),
      a: ({ href, children }) => {
        const link = href ? conversationLink(href, { bareFile: true }) : null;
        if (link?.kind === "external")
          return (
            <button
              type="button"
              className="text-link"
              onClick={() => {
                void window.moodcode?.openExternal(link.url).catch(() => {});
              }}
            >
              {children}
            </button>
          );
        if (link?.kind === "file" && onOpenFile)
          return (
            <button
              type="button"
              className="text-link conversation-file-link"
              title={`${link.path}${link.line ? `:${link.line}` : ""} 열기`}
              onClick={() => onOpenFile(link.path, link.line)}
            >
              {children}
            </button>
          );
        return <span>{children}</span>;
      },
      code: ({ children, className }) => {
        const text = typeof children === "string" ? children : "";
        const link =
          !className && !text.includes("\n") ? conversationLink(text) : null;
        if (link?.kind === "file" && onOpenFile)
          return (
            <button
              type="button"
              className="conversation-inline-file"
              title={`${link.path}${link.line ? `:${link.line}` : ""} 열기`}
              onClick={() => onOpenFile(link.path, link.line)}
            >
              <code>{children}</code>
            </button>
          );
        return <code className={className}>{children}</code>;
      },
    }),
    [onOpenFile],
  );
  return (
    <Markdown
      skipHtml
      remarkPlugins={REMARK_PLUGINS}
      components={components}
      disallowedElements={DISALLOWED}
      urlTransform={(value) =>
        conversationLink(value, { bareFile: true }) ? value : ""
      }
    >
      {content}
    </Markdown>
  );
});
