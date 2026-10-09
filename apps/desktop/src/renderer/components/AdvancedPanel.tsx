import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JsonObject, JsonValue } from "@moodcode/contracts";
import type { DesktopSettings } from "../../shared/protocol.js";
import type { DesktopAdvancedActionType } from "../../shared/advanced.js";
import {
  createAdvancedStore,
  object,
  type AdvancedStore,
  type AdvancedTransport,
} from "../advanced-store.js";
import { Inbox, Questions, Tasks } from "./AdvancedTasks.js";
import { LspPanel, McpPanel, TerminalPanel } from "./AdvancedConnections.js";
import { ChildrenPanel, TeamPanel, WorkflowPanel } from "./AdvancedAgents.js";
import { Icon } from "./Icon.js";
import "./advanced.css";

const tabs = [
  "대기열·작업",
  "터미널",
  "MCP",
  "자식·팀",
  "워크플로",
  "진단",
] as const;
const approvals: Record<string, DesktopAdvancedActionType> = {
  terminal: "terminal.create",
  mcp: "mcp.connect",
  lsp: "lsp.connect",
  child: "child.start",
  "team-member": "team.member.join",
  workflow: "workflow.start",
};
export function AdvancedPanel({
  api,
  sessionId,
  parentRunId,
  settings,
  generation,
  close,
  onOpenFile,
}: {
  api: AdvancedTransport;
  sessionId: string;
  parentRunId?: string;
  settings: DesktopSettings | null;
  generation: number;
  close: () => void;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const [store] = useState(() => createAdvancedStore(api));
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const [tab, setTab] = useState<(typeof tabs)[number]>("대기열·작업");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  useEffect(() => {
    void store.bind(sessionId);
    const timer = setInterval(() => void store.refresh(), 1000);
    return () => {
      clearInterval(timer);
      void store.bind(null);
    };
  }, [store, sessionId, generation]);
  useEffect(
    () => () => {
      void store.dispose();
    },
    [store],
  );
  const snapshot = state.snapshot;
  const busy = state.busy || !snapshot;
  const paused = object(snapshot?.control).paused === true;
  const kind = state.preview?.kind ?? "";
  const approval =
    approvals[kind] ??
    (kind.includes("terminal")
      ? "terminal.create"
      : kind.includes("mcp")
        ? "mcp.connect"
        : kind.includes("lsp")
          ? "lsp.connect"
          : kind.includes("team")
            ? "team.member.join"
            : kind.includes("workflow")
              ? "workflow.start"
              : kind.includes("child")
                ? "child.start"
                : undefined);
  return (
    <dialog
      className="advanced-dialog"
      ref={dialog}
      aria-labelledby="advanced-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">SESSION TOOLS</span>
          <h2 id="advanced-title">고급 작업</h2>
        </div>
        <button
          className="icon-button"
          aria-label="고급 작업 닫기"
          onClick={close}
        >
          <Icon name="close" size={19} />
        </button>
      </div>
      <nav className="advanced-tabs" aria-label="고급 작업 범주">
        {tabs.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={tab === item}
            className={tab === item ? "selected" : ""}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </nav>
      {state.error ? (
        <p role="alert" className="inline-error">
          {state.error}
        </p>
      ) : null}
      {paused && (tab === "자식·팀" || tab === "워크플로") ? (
        <p className="field-help">
          세션이 일시 정지되어 있어요. 새 실행을 검토하려면 대기열·작업에서
          세션을 재개하세요.
        </p>
      ) : null}
      {state.preview ? (
        <section className="advanced-preview" aria-label="실행 검토">
          <h3>요청한 작업을 검토해 주세요</h3>
          <p className="field-help">
            유효 기간 {new Date(state.preview.expiresAt).toLocaleTimeString()} ·
            이 검토의 정확한 입력을 승인해요.
          </p>
          <pre>{JSON.stringify(state.preview.preview, null, 2)}</pre>
          <div className="advanced-actions">
            <button
              className="button secondary"
              disabled={state.busy}
              onClick={() => void store.dismissPreview()}
            >
              검토 취소
            </button>
            <button
              className="button primary"
              disabled={
                state.busy ||
                !approval ||
                (paused &&
                  [
                    "child.start",
                    "team.member.join",
                    "workflow.start",
                  ].includes(approval)) ||
                Date.parse(state.preview.expiresAt) <= Date.now()
              }
              onClick={() => {
                if (approval) void store.approve(approval);
              }}
            >
              검토한 작업 승인
            </button>
          </div>
        </section>
      ) : null}
      <div className="advanced-content" key={`${sessionId}:${generation}`}>
        {!snapshot ? (
          <p className="muted">세션 상태를 읽는 중이에요.</p>
        ) : (
          <>
            {tab === "대기열·작업" ? (
              <>
                <Inbox
                  inbox={snapshot.inbox}
                  control={snapshot.control}
                  store={store}
                  busy={busy}
                />
                <Tasks value={snapshot.tasks} store={store} busy={busy} />
                <Questions
                  value={snapshot.questions}
                  store={store}
                  busy={busy}
                />
              </>
            ) : null}
            {tab === "터미널" ? (
              <TerminalPanel
                value={snapshot.terminals}
                capability={snapshot.terminalCapability}
                store={store}
                busy={busy}
              />
            ) : null}
            {tab === "MCP" ? (
              <McpPanel value={snapshot.mcp} store={store} busy={busy} />
            ) : null}
            {tab === "자식·팀" ? (
              <>
                <ChildrenPanel
                  children={snapshot.children}
                  worktrees={snapshot.worktrees}
                  parentRunId={parentRunId}
                  paused={paused}
                  store={store}
                  busy={busy}
                />
                <TeamPanel
                  value={snapshot.teams}
                  parentRunId={parentRunId}
                  paused={paused}
                  store={store}
                  busy={busy}
                />
              </>
            ) : null}
            {tab === "워크플로" ? (
              <WorkflowPanel
                value={snapshot.workflows}
                worktrees={snapshot.worktrees}
                parentRunId={parentRunId}
                paused={paused}
                settings={settings}
                store={store}
                busy={busy}
              />
            ) : null}
            {tab === "진단" ? (
              <>
                <LspPanel
                  value={snapshot.languageServers}
                  store={store}
                  busy={busy}
                  onOpenFile={onOpenFile}
                />
                <Diagnostics value={snapshot.diagnostics} />
              </>
            ) : null}
          </>
        )}
      </div>
      <div className="dialog-footer">
        <button
          className="text-button"
          disabled={state.busy}
          onClick={() => void store.refresh()}
        >
          상태 새로고침
        </button>
        <button className="button secondary" onClick={close}>
          닫기
        </button>
      </div>
    </dialog>
  );
}
function Diagnostics({ value }: { value: JsonValue }) {
  const data = object(value);
  return (
    <section className="advanced-section">
      <h3>엔진 진단</h3>
      <p className="field-help">
        저장된 실행·cleanup·컨텍스트 관측이에요. 진단을 읽어도 작업을 다시
        실행하지 않아요.
      </p>
      {Object.entries(data).map(([name, item]) => (
        <details key={name}>
          <summary>{name}</summary>
          <pre className="advanced-output">{JSON.stringify(item, null, 2)}</pre>
        </details>
      ))}
    </section>
  );
}
