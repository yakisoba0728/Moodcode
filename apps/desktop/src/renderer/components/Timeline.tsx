import { memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalRecord,
  Message,
  SessionSnapshot,
  ToolCallRecord,
} from "@moodcode/contracts";
import type { DesktopStore } from "../store.js";
import { RUN_LABELS, TOOL_LABELS, timelineRows } from "../model.js";
import { Icon } from "./Icon.js";
import { CodeBlock, DeferredCodeBlock } from "./LazyCodeBlock.js";
import {
  ConversationMarkdown,
  type OpenConversationFile,
} from "./ConversationMarkdown.js";
import {
  conversationLink,
  runErrorHelp,
  toolInputText,
  toolOutputView,
} from "../conversation.js";

const RUN_TIME = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
});

const MessageView = memo(function MessageView({
  message,
  onOpenFile,
}: {
  message: Message;
  onOpenFile?: OpenConversationFile;
}) {
  if (
    message.role === "tool" ||
    (message.role === "assistant" && !message.content)
  )
    return null;
  return (
    <div className={`message ${message.role}`}>
      <div className="message-avatar">
        {message.role === "user" ? (
          <Icon name="code" size={16} />
        ) : (
          <span>m</span>
        )}
      </div>
      <div className="message-body">
        <div className="message-author">
          {message.role === "user" ? "나" : "Moodcode"}
        </div>
        <div className="markdown">
          <ConversationMarkdown
            content={message.content}
            onOpenFile={onOpenFile}
          />
        </div>
      </div>
    </div>
  );
});
const ToolView = memo(function ToolView({
  tool,
  onOpenFile,
}: {
  tool: ToolCallRecord;
  onOpenFile?: OpenConversationFile;
}) {
  const [expanded, setExpanded] = useState(false);
  const output = useMemo(
    () => (expanded ? toolOutputView(tool) : null),
    [expanded, tool],
  );
  const pending =
    tool.state === "running" ||
    tool.state === "requested" ||
    tool.state === "awaiting_approval";
  const label =
    tool.state === "completed"
      ? "완료"
      : tool.state === "failed"
        ? "실패"
        : tool.state === "denied"
          ? "거절됨"
          : tool.state === "interrupted"
            ? "중단됨"
            : tool.state === "awaiting_approval"
              ? "승인 대기"
              : "실행 중";
  const input =
    tool.input && typeof tool.input === "object" && !Array.isArray(tool.input)
      ? tool.input
      : {};
  const detail =
    typeof input.path === "string"
      ? input.path
      : typeof input.command === "string"
        ? input.command
        : typeof input.query === "string"
          ? input.query
          : "";
  return (
    <details
      className={`tool-card ${tool.state}`}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className={pending ? "spinner-small" : "tool-icon"}>
          {pending ? null : (
            <Icon
              name={tool.state === "completed" ? "check" : "terminal"}
              size={14}
            />
          )}
        </span>
        <span className="tool-name">{TOOL_LABELS[tool.name] ?? tool.name}</span>
        <code>{detail}</code>
        <span className="tool-state">{label}</span>
        <Icon name="chevronDown" size={13} />
      </summary>
      {expanded ? (
        <div className="tool-body">
          <div className="eyebrow">입력</div>
          {typeof input.path === "string" &&
          onOpenFile &&
          conversationLink(input.path, { bareFile: true })?.kind === "file" ? (
            <button
              type="button"
              className="text-link conversation-file-link"
              onClick={() => {
                const link = conversationLink(input.path as string, {
                  bareFile: true,
                });
                if (link?.kind === "file")
                  onOpenFile(
                    link.path,
                    typeof input.startLine === "number"
                      ? input.startLine
                      : link.line,
                  );
              }}
            >
              {input.path}
              {typeof input.startLine === "number"
                ? `:${input.startLine}`
                : ""}{" "}
              열기
            </button>
          ) : null}
          <CodeBlock
            source={toolInputText(tool.input)}
            language="json"
            label="도구 입력"
          />
          {output?.source ? (
            <>
              <div className="eyebrow">저장된 결과 원문</div>
              {output.notices.map((notice) => (
                <p className="conversation-output-note" key={notice}>
                  {notice}
                </p>
              ))}
              {output.references.length && onOpenFile ? (
                <ul
                  className="tool-file-references"
                  aria-label="결과 파일 위치"
                >
                  {output.references.map((reference, index) => (
                    <li
                      key={`${reference.path}:${reference.line ?? ""}:${index}`}
                    >
                      <button
                        type="button"
                        className="text-link conversation-file-link"
                        onClick={() =>
                          onOpenFile(reference.path, reference.line)
                        }
                      >
                        {reference.path}
                        {reference.line ? `:${reference.line}` : ""}
                      </button>
                      {reference.text ? <code>{reference.text}</code> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {output.references.length >= 80 ? (
                <p className="conversation-output-note">
                  파일 위치 버튼은 처음 80개를 표시했어요. 나머지는 아래 결과
                  원문에서 확인할 수 있어요.
                </p>
              ) : null}
              <CodeBlock
                source={output.source}
                language={output.language}
                label="도구 결과"
              />
            </>
          ) : null}
          {tool.error ? (
            <CodeBlock source={tool.error} label="도구 오류" copy={false} />
          ) : null}
        </div>
      ) : null}
    </details>
  );
});
export function ApprovalPanel({
  approval,
  store,
}: {
  approval: ApprovalRecord;
  store: DesktopStore;
}) {
  const [deciding, setDeciding] = useState(false);
  async function decide(decision: "allow" | "deny") {
    if (deciding) return;
    setDeciding(true);
    try {
      await store.decide(approval.id, decision, approval.fingerprint);
    } finally {
      setDeciding(false);
    }
  }
  return (
    <section className="approval-panel" aria-label="승인 요청">
      <div className="approval-heading">
        <Icon name="shield" size={19} />
        <div>
          <strong>
            {approval.toolName === "apply_patch"
              ? "파일 변경을 승인해 주세요"
              : "명령 실행을 승인해 주세요"}
          </strong>
          <p>아래 작업을 확인한 뒤 실행 여부를 결정해 주세요.</p>
        </div>
        <span className="pill amber">승인 대기</span>
      </div>
      <div className="approval-preview">
        <DeferredCodeBlock
          source={JSON.stringify(approval.preview, null, 2)}
          language="json"
          label="승인 미리보기"
          copy={false}
        />
      </div>
      <div className="approval-actions">
        <span>이번 요청에만 적용돼요.</span>
        <button
          className="button secondary"
          disabled={deciding}
          onClick={() => {
            void decide("deny");
          }}
        >
          거절
        </button>
        <button
          className="button primary"
          disabled={deciding}
          onClick={() => {
            void decide("allow");
          }}
        >
          <Icon name="check" />
          승인하고 실행
        </button>
      </div>
    </section>
  );
}
export function Timeline({
  snapshot,
  store,
  onOpenFile,
}: {
  snapshot: SessionSnapshot;
  store: DesktopStore;
  onOpenFile?: OpenConversationFile;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const node = viewport.current;
    if (node && follow.current) node.scrollTop = node.scrollHeight;
  }, [snapshot.lastSeq]);
  return (
    <div
      className="timeline"
      ref={viewport}
      onScroll={() => {
        const node = viewport.current;
        if (node)
          follow.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 100;
      }}
      aria-label="대화 기록"
    >
      {snapshot.runs.map((run) => {
        const messages = snapshot.messages.filter((m) => m.runId === run.id);
        const tools = snapshot.tools.filter((t) => t.runId === run.id);
        const pending = snapshot.approvals.filter(
          (a) => a.runId === run.id && a.status === "pending",
        );
        return (
          <section className="run-section" key={run.id} data-run-id={run.id}>
            <div className="run-meta">
              <span>{RUN_TIME.format(new Date(run.createdAt))}</span>
              <span className={`run-state ${run.state}`}>
                {RUN_LABELS[run.state]}
              </span>
              <button
                className="text-button"
                onClick={() => {
                  void store.chooseReview(run.id);
                }}
              >
                변경 보기 <Icon name="chevron" size={11} />
              </button>
            </div>
            {timelineRows(messages, tools).map((row) =>
              row.kind === "message" ? (
                <MessageView
                  key={row.message.id}
                  message={row.message}
                  onOpenFile={onOpenFile}
                />
              ) : (
                <div className="tool-stack" key={row.tool.id}>
                  <ToolView tool={row.tool} onOpenFile={onOpenFile} />
                </div>
              ),
            )}
            {pending.map((approval) => (
              <Suspense
                key={approval.id}
                fallback={
                  <p className="pane-note" role="status">
                    승인 미리보기를 불러오는 중이에요.
                  </p>
                }
              >
                <ApprovalPanel approval={approval} store={store} />
              </Suspense>
            ))}
            {run.state === "running" && !pending.length ? (
              <div className="working">
                <span className="spinner-small" />
                작업을 진행하고 있어요.
              </div>
            ) : null}
            {run.error ? (
              <div className="run-error">
                <strong>{runErrorHelp(run.error).cause}</strong>
                <p className="run-error-action">
                  {runErrorHelp(run.error).action}
                </p>
                <details>
                  <summary>오류 원문 · {run.error.code}</summary>
                  <p>{run.error.message}</p>
                </details>
              </div>
            ) : null}
            {run.state === "interrupted" ? (
              <p className="run-notice">
                이전 실행이 중단됐어요. 기록을 확인하고 새 요청을 시작할 수
                있어요.
              </p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
