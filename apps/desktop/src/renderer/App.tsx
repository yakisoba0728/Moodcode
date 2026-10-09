import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RunConfigInput } from "@moodcode/contracts";
import type { DesktopStore } from "./store.js";
import { activeRun, latestRun, RUN_LABELS, shortPath } from "./model.js";
import { Icon } from "./components/Icon.js";
import { ReviewPane } from "./components/ReviewPane.js";
import { workspaceFilePath, type FileTarget } from "./navigation.js";

const Timeline = lazy(() =>
  import("./components/Timeline.js").then((module) => ({
    default: module.Timeline,
  })),
);
const Recovery = lazy(() =>
  import("./components/Recovery.js").then((module) => ({
    default: module.Recovery,
  })),
);
const Settings = lazy(() =>
  import("./components/Settings.js").then((module) => ({
    default: module.Settings,
  })),
);
const AdvancedPanel = lazy(() =>
  import("./components/AdvancedPanel.js").then((module) => ({
    default: module.AdvancedPanel,
  })),
);

function LoadingDialog({ title, close }: { title: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      className="settings-dialog"
      ref={dialog}
      aria-label={`${title} 불러오는 중`}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <p role="status">{title} 화면을 불러오는 중이에요.</p>
      <button className="button secondary" onClick={close}>
        취소
      </button>
    </dialog>
  );
}

const suggestions = [
  {
    icon: "code",
    title: "코드 구조 살펴보기",
    prompt: "이 저장소의 구조와 주요 모듈이 하는 일을 설명해 줘.",
  },
  {
    icon: "search",
    title: "문제 원인 찾아보기",
    prompt:
      "이 저장소에서 개선이 필요한 부분을 확인하고 근거와 함께 설명해 줘.",
  },
  {
    icon: "edit",
    title: "변경 계획 세우기",
    prompt: "변경하려는 기능을 먼저 분석하고 구현 계획을 세워 줘.",
  },
];
function getDrafts(): Record<string, string> {
  try {
    const data = JSON.parse(
      localStorage.getItem("moodcode.drafts.v1") ?? "{}",
    ) as unknown;
    if (data && typeof data === "object" && !Array.isArray(data))
      return Object.fromEntries(
        Object.entries(data).filter(
          ([key, value]) =>
            typeof value === "string" &&
            value.length <= 65536 &&
            key.length <= 256,
        ),
      );
  } catch {}
  return {};
}

export function App({ store }: { store: DesktopStore }) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [delivery, setDelivery] = useState<"queue" | "steer">("queue");
  const advancedApi =
    window.moodcode?.getAdvancedSnapshot && window.moodcode?.advanced
      ? window.moodcode
      : undefined;
  const [fileTarget, setFileTarget] = useState<FileTarget | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"plan" | "build">(() => {
    try {
      return localStorage.getItem("moodcode.mode.v1") === "build"
        ? "build"
        : "plan";
    } catch {
      return "plan";
    }
  });
  const [drafts, setDrafts] = useState<Record<string, string>>(getDrafts);
  const request = useRef<{
    prompt: string;
    sessionId: string;
    config: string;
    requestId: string;
  } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const workspace = state.workspaces.find((w) => w.id === state.workspaceId);
  const session = state.sessions.find((s) => s.id === state.sessionId);
  const active = activeRun(state.snapshot);
  const run =
    state.historyPage?.runs.find((r) => r.id === state.reviewRunId) ??
    state.snapshot?.runs.find((r) => r.id === state.reviewRunId) ??
    latestRun(state.snapshot);
  const connected = state.host.state === "ready";
  const draft = state.sessionId ? (drafts[state.sessionId] ?? "") : "";
  const modelLabel =
    state.settings?.providerId === "scripted"
      ? "테스트 모델 · 로컬"
      : state.settings?.providerId === "codex"
        ? `Codex · ${state.settings.modelId}`
        : (state.settings?.modelId ?? "모델 연결");
  const setDraft = (value: string) => {
    if (state.sessionId)
      setDrafts((current) => ({ ...current, [state.sessionId!]: value }));
  };
  useEffect(() => {
    try {
      localStorage.setItem(
        "moodcode.selection.v1",
        JSON.stringify({
          workspaceId: state.workspaceId,
          sessionId: state.sessionId,
        }),
      );
    } catch {}
  }, [state.workspaceId, state.sessionId]);
  useEffect(() => {
    try {
      localStorage.setItem(
        "moodcode.drafts.v1",
        JSON.stringify(Object.fromEntries(Object.entries(drafts).slice(-20))),
      );
    } catch {}
  }, [drafts]);
  useEffect(() => {
    try {
      localStorage.setItem("moodcode.mode.v1", mode);
    } catch {}
  }, [mode]);
  useEffect(() => {
    const node = input.current;
    if (node) {
      node.style.height = "auto";
      node.style.height = `${Math.min(180, Math.max(60, node.scrollHeight))}px`;
    }
  }, [draft, state.sessionId]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        const current = store.getSnapshot();
        if (current.workspaceId && current.host.state === "ready")
          void store.createSession();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void store.openWorkspace();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [store]);
  function openFile(path: string, line?: number) {
    if (!workspace) return;
    const relative = workspaceFilePath(workspace.root, path);
    if (!relative) {
      setNavigationError("선택한 저장소 안의 파일만 열 수 있어요.");
      return;
    }
    setNavigationError(null);
    setFileTarget((current) => ({
      id: (current?.id ?? 0) + 1,
      workspaceId: workspace.id,
      path: relative,
      ...(line ? { line } : {}),
    }));
  }
  async function submit() {
    const sessionId = state.sessionId,
      prompt = draft.trim();
    if (
      !sessionId ||
      !prompt ||
      (active && !advancedApi) ||
      state.submitting ||
      !connected
    )
      return;
    const config: RunConfigInput = {
      mode,
      ...(state.settings
        ? {
            providerId: state.settings.providerId,
            modelId: state.settings.modelId,
            ...(state.settings.reasoningEffort
              ? { reasoningEffort: state.settings.reasoningEffort }
              : {}),
          }
        : {}),
    };
    const encoded = JSON.stringify({ config, delivery });
    if (
      !request.current ||
      request.current.prompt !== prompt ||
      request.current.sessionId !== sessionId ||
      request.current.config !== encoded
    )
      request.current = {
        prompt,
        sessionId,
        config: encoded,
        requestId: crypto.randomUUID(),
      };
    const accepted = active
      ? await store.acceptInput(
          prompt,
          config,
          request.current.requestId,
          delivery,
        )
      : await store.submit(prompt, config, request.current.requestId);
    if (accepted) {
      setDrafts((current) =>
        current[sessionId] === draft
          ? { ...current, [sessionId]: "" }
          : current,
      );
      request.current = null;
    }
  }
  return (
    <div className="desktop-shell">
      <header className="titlebar">
        <div className="window-space" />
        <span className="titlebar-location">
          Moodcode <span>/</span>{" "}
          {workspace ? shortPath(workspace.root) : "새로운 작업"}
        </span>
        <div className="titlebar-right">
          <span className={`connection-dot ${connected ? "online" : ""}`} />
          {connected
            ? "연결됨"
            : state.host.state === "starting"
              ? "시작 중"
              : "연결 확인 필요"}
        </div>
      </header>
      <div className="workbench">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <div className="brand-mark">m</div>
            <strong>moodcode</strong>
            <button
              className="icon-button"
              aria-label="모델 설정"
              onClick={() => setSettingsOpen(true)}
            >
              <Icon name="settings" size={17} />
            </button>
          </div>
          <button
            className="new-task"
            disabled={!workspace || !connected}
            onClick={() => {
              void store.createSession();
            }}
          >
            <Icon name="plus" size={17} />새 작업<span>⌘ N</span>
          </button>
          <div className="sidebar-section">
            <div className="section-title">
              프로젝트
              <button
                className="icon-button"
                title="저장소 열기"
                aria-label="저장소 열기"
                disabled={!connected || state.opening}
                onClick={() => {
                  void store.openWorkspace();
                }}
              >
                <Icon name="plus" size={15} />
              </button>
            </div>
            {state.workspaces.map((w) => (
              <button
                key={w.id}
                className={`workspace-row ${w.id === state.workspaceId ? "selected" : ""}`}
                onClick={() => {
                  void store.selectWorkspace(w.id);
                }}
                title={w.root}
              >
                <Icon name="folder" size={16} />
                <span>{shortPath(w.root)}</span>
                {w.id === state.workspaceId ? (
                  <span className="workspace-dot" />
                ) : null}
              </button>
            ))}
            {!state.workspaces.length ? (
              <button
                className="workspace-open"
                disabled={!connected || state.opening}
                onClick={() => {
                  void store.openWorkspace();
                }}
              >
                <Icon name="folder" />
                로컬 저장소 열기
              </button>
            ) : null}
          </div>
          <div className="sidebar-section sessions-section">
            <div className="section-title">
              작업 기록<span>{state.sessions.length}</span>
            </div>
            {state.sessions.length > 5 ? (
              <div className="session-search">
                <Icon name="search" size={13} />
                <input
                  aria-label="작업 검색"
                  placeholder="작업 검색"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            ) : null}
            <div className="session-list">
              {[...state.sessions]
                .reverse()
                .filter((s) =>
                  s.title.toLowerCase().includes(query.toLowerCase()),
                )
                .map((s) => (
                  <button
                    key={s.id}
                    className={`session-row ${s.id === state.sessionId ? "selected" : ""}`}
                    onClick={() => {
                      void store.selectSession(s.id);
                    }}
                  >
                    <Icon name="clock" size={14} />
                    <span>{s.title}</span>
                    {s.id === state.sessionId && active ? (
                      <span className="working-dot" />
                    ) : null}
                  </button>
                ))}
              {!state.sessions.length ? (
                <p className="sidebar-empty">
                  프로젝트를 열고
                  <br />새 작업을 시작하세요.
                </p>
              ) : null}
            </div>
          </div>
          <div className="sidebar-footer">
            <div className="local-avatar">
              <Icon name="shield" size={17} />
            </div>
            <div>
              <strong>
                {state.settings?.providerId === "codex"
                  ? "Codex 계정"
                  : "로컬 워크스페이스"}
              </strong>
              <span>
                {state.settings?.providerId === "codex"
                  ? "로그인된 계정 사용"
                  : "기록은 이 컴퓨터에 저장돼요."}
              </span>
            </div>
            <button
              className="icon-button"
              aria-label="연결 설정"
              onClick={() => setSettingsOpen(true)}
            >
              <Icon name="settings" size={16} />
            </button>
          </div>
        </aside>
        <main className="conversation">
          <header className="conversation-header">
            <div>
              <Icon name="code" size={17} />
              <strong>{session?.title ?? "새로운 작업"}</strong>
              <span className="pill subtle">
                {mode === "plan" ? "Plan" : "Build"}
              </span>
            </div>
            <span className="branch-label">
              <Icon name="branch" size={13} />
              {workspace?.branch ?? (workspace ? "branch 없음" : "로컬")}
            </span>
          </header>
          {navigationError ? (
            <div className="error-banner" role="alert">
              {navigationError}
              <button onClick={() => setNavigationError(null)}>닫기</button>
            </div>
          ) : null}
          {state.error ? (
            <div className="error-banner" role="alert">
              <div>
                <strong>작업을 확인해 주세요</strong>
                <p>{state.error}</p>
              </div>
              {state.host.state === "failed" ? (
                <button
                  className="button secondary"
                  onClick={() => {
                    void store.retry().catch(() => {});
                  }}
                >
                  다시 연결
                </button>
              ) : null}
              <button
                className="icon-button"
                aria-label="알림 닫기"
                onClick={store.clearError}
              >
                <Icon name="close" />
              </button>
            </div>
          ) : null}
          {!connected ? (
            <div className="host-status">
              <span
                className={state.host.state === "starting" ? "spinner" : ""}
              />
              <h2>
                {state.host.state === "starting"
                  ? "작업 공간을 준비하고 있어요"
                  : "엔진 연결을 확인해 주세요"}
              </h2>
              <p>
                {state.host.state === "starting"
                  ? "저장된 프로젝트와 기록을 불러와요."
                  : "설정을 확인하거나 다시 연결할 수 있어요."}
              </p>
              {state.host.state === "failed" ? (
                <div>
                  <button
                    className="button secondary"
                    onClick={() => setSettingsOpen(true)}
                  >
                    모델 설정
                  </button>
                  <button
                    className="button primary"
                    onClick={() => {
                      void store.retry();
                    }}
                  >
                    다시 연결
                  </button>
                </div>
              ) : null}
            </div>
          ) : state.snapshot?.runs.length ? (
            <>
              <div className="history-toolbar">
                <button
                  className="text-button"
                  disabled={!state.historyHasMore || state.loadingHistory}
                  onClick={() => {
                    void store.loadOlder();
                  }}
                >
                  {state.loadingHistory ? "기록 읽는 중…" : "이전 기록"}
                </button>
                {state.historyPage ? (
                  <>
                    <span>이전 기록을 보고 있어요.</span>
                    <button className="text-button" onClick={store.showLatest}>
                      최신 기록
                    </button>
                  </>
                ) : null}
                {state.historyTruncated ? (
                  <span>
                    큰 기록은 일부만 표시했어요. 원본은 저장돼 있어요.
                  </span>
                ) : null}
              </div>
              <Suspense
                fallback={
                  <p className="pane-note" role="status">
                    대화를 불러오는 중이에요.
                  </p>
                }
              >
                <Timeline
                  snapshot={state.historyPage ?? state.snapshot}
                  store={store}
                  onOpenFile={openFile}
                />
              </Suspense>
            </>
          ) : (
            <div className="welcome">
              <div className="welcome-symbol">
                <span>m</span>
                <div className="symbol-spark">
                  <Icon name="spark" size={14} />
                </div>
              </div>
              <p className="welcome-eyebrow">YOUR NEXT IDEA, IN MOTION</p>
              <h1>무엇을 만들어볼까요?</h1>
              <p className="welcome-description">
                코드를 이해하고, 변경을 검토하고,
                <br />
                다음 아이디어를 함께 완성하세요.
              </p>
              {workspace ? (
                <div className="suggestions">
                  {suggestions.map((item) => (
                    <button
                      key={item.title}
                      disabled={!state.sessionId}
                      onClick={() => {
                        setDraft(item.prompt);
                        input.current?.focus();
                      }}
                    >
                      <Icon name={item.icon} size={18} />
                      <span>{item.title}</span>
                      <Icon name="chevron" size={12} />
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  className="button primary open-primary"
                  disabled={state.opening}
                  onClick={() => {
                    void store.openWorkspace();
                  }}
                >
                  <Icon name="folder" />
                  프로젝트 열기
                </button>
              )}
              <div className="welcome-context">
                <Icon name="shield" size={13} />
                <span>
                  {workspace
                    ? "파일 수정과 명령 실행은 승인 후 진행돼요."
                    : "로컬 Git 저장소에서 시작해요."}
                </span>
              </div>
            </div>
          )}
          <div className="composer-region">
            {active ? (
              <div className="active-strip">
                <span className="spinner-small" />
                <span>{RUN_LABELS[active.state]}</span>
                <span>
                  {active.state === "awaiting_approval"
                    ? "요청한 작업의 승인을 기다려요."
                    : "기록을 보면서 진행 상황을 확인할 수 있어요."}
                </span>
              </div>
            ) : null}
            <form
              className={`composer ${active ? "busy" : ""}`}
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <textarea
                ref={input}
                aria-label="작업 요청"
                placeholder={
                  workspace
                    ? "무엇을 할까요? 원하는 작업을 설명해 주세요."
                    : "프로젝트를 열어 작업을 시작하세요."
                }
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={!state.sessionId || !connected}
                maxLength={65536}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
              <div className="composer-toolbar">
                <div>
                  <div
                    className="mode-switch"
                    role="group"
                    aria-label="작업 모드"
                  >
                    <button
                      type="button"
                      className={mode === "plan" ? "selected" : ""}
                      onClick={() => setMode("plan")}
                      disabled={Boolean(active)}
                    >
                      <Icon name="search" size={13} />
                      Plan
                    </button>
                    <button
                      type="button"
                      className={mode === "build" ? "selected" : ""}
                      onClick={() => setMode("build")}
                      disabled={Boolean(active)}
                    >
                      <Icon name="edit" size={13} />
                      Build
                    </button>
                  </div>
                  <button
                    type="button"
                    className="model-select"
                    onClick={() => setSettingsOpen(true)}
                    title="모델 연결 설정"
                  >
                    <span className="model-dot" />
                    {modelLabel}
                    <Icon name="chevronDown" size={11} />
                  </button>
                </div>
                {advancedApi ? (
                  <select
                    className="delivery-select"
                    aria-label="입력 전달 방식"
                    value={delivery}
                    onChange={(event) =>
                      setDelivery(event.target.value as "queue" | "steer")
                    }
                  >
                    <option value="queue">Queue</option>
                    <option value="steer">Steer</option>
                  </select>
                ) : null}
                {active && advancedApi ? (
                  <button
                    type="submit"
                    className="send-button"
                    aria-label="요청 대기열에 추가"
                    disabled={!draft.trim() || state.submitting}
                  >
                    <Icon name="arrow" size={17} />
                  </button>
                ) : null}
                {active ? (
                  <button
                    type="button"
                    className="stop-button"
                    disabled={active.state === "cancelling"}
                    aria-label="작업 중지"
                    onClick={() => {
                      void store.cancel(active.id);
                    }}
                  >
                    <Icon name="stop" size={13} />
                    {active.state === "cancelling" ? "중지 중" : "중지"}
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="send-button"
                    aria-label="작업 시작"
                    disabled={
                      !draft.trim() ||
                      !state.sessionId ||
                      !connected ||
                      state.submitting
                    }
                  >
                    <Icon name="arrow" size={17} />
                  </button>
                )}
              </div>
            </form>
            <div className="composer-hint">
              <span>
                {state.settings?.providerId === "scripted"
                  ? "테스트 모델을 사용 중이에요. 설정에서 실제 모델을 연결하세요."
                  : mode === "plan"
                    ? "Plan은 읽기와 분석을 진행해요."
                    : "Build는 승인받은 수정과 명령을 실행해요."}
              </span>
              <span>⌘ Enter</span>
            </div>
          </div>
        </main>
        <ReviewPane
          workspace={workspace}
          review={state.review}
          run={run}
          store={store}
          fileTarget={
            fileTarget?.workspaceId === workspace?.id ? fileTarget : null
          }
          busy={Boolean(active) || state.submitting}
        />
      </div>
      <footer className="statusbar">
        <div>
          <span className={`connection-dot ${connected ? "online" : ""}`} />
          <span>{connected ? "로컬 엔진 연결됨" : "엔진 연결 확인"}</span>
          <span className="statusbar-separator" />
          <Icon name="branch" size={12} />
          <span>{workspace?.branch ?? "저장소 없음"}</span>
        </div>
        <div>
          <button className="text-button" onClick={() => setRecoveryOpen(true)}>
            진단·복구
          </button>
          {advancedApi ? (
            <button
              className="text-button"
              disabled={!state.sessionId || !connected}
              onClick={() => setAdvancedOpen(true)}
            >
              고급 작업
            </button>
          ) : null}
          <Icon name="shield" size={12} />
          <span>승인 후 실행</span>
          <span className="statusbar-separator" />
          {state.metrics ? (
            <span
              title={
                state.metrics.context
                  ? `컨텍스트 ${state.metrics.context.bytes.toLocaleString()} / ${state.metrics.context.limit.toLocaleString()} bytes · 대화 요약 ${state.metrics.context.summaryIncluded ? "포함" : "없음"}`
                  : "아직 컨텍스트 사용량이 없어요."
              }
            >
              입력 {state.metrics.inputTokens?.toLocaleString() ?? "미제공"} ·
              출력 {state.metrics.outputTokens?.toLocaleString() ?? "미제공"}
              {state.metrics.usageWindowTruncated
                ? " (최근 2,000개 이벤트)"
                : ""}
              {state.metrics.context?.summaryIncluded ? " · 요약 포함" : ""}
            </span>
          ) : null}
          <span>Moodcode {state.version}</span>
        </div>
      </footer>
      {advancedOpen && advancedApi && state.sessionId ? (
        <Suspense
          fallback={
            <LoadingDialog
              title="고급 작업"
              close={() => setAdvancedOpen(false)}
            />
          }
        >
          <AdvancedPanel
            api={
              advancedApi as Required<
                Pick<
                  NonNullable<typeof window.moodcode>,
                  "getAdvancedSnapshot" | "advanced"
                >
              >
            }
            sessionId={state.sessionId}
            generation={state.host.generation}
            parentRunId={active?.id}
            settings={state.settings}
            close={() => setAdvancedOpen(false)}
            onOpenFile={(path, line) => {
              openFile(path, line);
              setAdvancedOpen(false);
            }}
          />
        </Suspense>
      ) : null}
      {recoveryOpen ? (
        <Suspense
          fallback={
            <LoadingDialog
              title="진단·복구"
              close={() => setRecoveryOpen(false)}
            />
          }
        >
          <Recovery close={() => setRecoveryOpen(false)} />
        </Suspense>
      ) : null}
      {settingsOpen && state.settings ? (
        <Suspense
          fallback={
            <LoadingDialog
              title="모델 연결"
              close={() => setSettingsOpen(false)}
            />
          }
        >
          <Settings
            settings={state.settings}
            store={store}
            close={() => setSettingsOpen(false)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
