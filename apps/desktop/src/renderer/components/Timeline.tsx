import { memo, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type {
  ApprovalRecord,
  Message,
  SessionSnapshot,
  ToolCallRecord,
} from "@moodcode/contracts";
import type { DesktopStore } from "../store.js";
import { RUN_LABELS, TOOL_LABELS, timelineRows } from "../model.js";
import { Icon } from "./Icon.js";

const MessageView = memo(function MessageView({
  message,
}: {
  message: Message;
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
          <Markdown
            skipHtml
            components={{
              img: () => null,
              a: ({ href, children }) =>
                href && /^https?:\/\//.test(href) ? (
                  <button
                    className="text-link"
                    onClick={() => {
                      void window.moodcode?.openExternal(href).catch(() => {});
                    }}
                  >
                    {children}
                  </button>
                ) : (
                  <span>{children}</span>
                ),
            }}
          >
            {message.content}
          </Markdown>
        </div>
      </div>
    </div>
  );
});
const ToolView = memo(function ToolView({ tool }: { tool: ToolCallRecord }) {
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
    <details className={`tool-card ${tool.state}`}>
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
      <div className="tool-body">
        <div className="eyebrow">입력</div>
        <pre>{JSON.stringify(tool.input, null, 2)}</pre>
        {tool.output ? (
          <>
            <div className="eyebrow">결과</div>
            <pre>{tool.output}</pre>
          </>
        ) : null}
        {tool.error ? <p className="inline-error">{tool.error}</p> : null}
      </div>
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
      <pre className="approval-preview">
        {JSON.stringify(approval.preview, null, 2)}
      </pre>
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
}: {
  snapshot: SessionSnapshot;
  store: DesktopStore;
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
              <span>
                {new Intl.DateTimeFormat("ko-KR", {
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(new Date(run.createdAt))}
              </span>
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
                <MessageView key={row.message.id} message={row.message} />
              ) : (
                <div className="tool-stack" key={row.tool.id}>
                  <ToolView tool={row.tool} />
                </div>
              ),
            )}
            {pending.map((approval) => (
              <ApprovalPanel
                key={approval.id}
                approval={approval}
                store={store}
              />
            ))}
            {run.state === "running" && !pending.length ? (
              <div className="working">
                <span className="spinner-small" />
                작업을 진행하고 있어요.
              </div>
            ) : null}
            {run.error ? (
              <div className="run-error">
                <strong>{run.error.code}</strong>
                <p>{run.error.message}</p>
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
