import type {
  CommandEnvelope,
  CommandResult,
  EngineCapabilities,
  ReviewDiff,
  RunConfigInput,
  RunReceipt,
  Session,
  SessionSnapshot,
  Workspace,
} from "@moodcode/contracts";
import type {
  DesktopApi,
  DesktopSettings,
  DesktopUpdate,
  HostStatus,
  SaveDesktopSettings,
} from "../shared/protocol.js";

export interface FileEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  bytes?: number;
}
export interface FileListing {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
  warnings: string[];
}
export interface FilePreview {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
  truncated: boolean;
}
export interface WorkspaceView {
  branch: string | null;
  changedFiles?: unknown[];
  entries?: unknown[];
  [key: string]: unknown;
}
export interface DesktopState {
  host: HostStatus;
  ready: boolean;
  workspaces: Workspace[];
  workspaceId: string | null;
  sessions: Session[];
  sessionId: string | null;
  snapshot: SessionSnapshot | null;
  capabilities: EngineCapabilities | null;
  settings: DesktopSettings | null;
  review: ReviewDiff | null;
  reviewRunId: string | null;
  error: string | null;
  opening: boolean;
  submitting: boolean;
  version: string;
  platform: string;
}
const empty = (): DesktopState => ({
  host: { state: "starting", generation: 0 },
  ready: false,
  workspaces: [],
  workspaceId: null,
  sessions: [],
  sessionId: null,
  snapshot: null,
  capabilities: null,
  settings: null,
  review: null,
  reviewRunId: null,
  error: null,
  opening: false,
  submitting: false,
  version: "0.1.0",
  platform: "unknown",
});

export function createDesktopStore(
  api: DesktopApi,
  selection?: { workspaceId?: string; sessionId?: string },
) {
  let state = empty();
  let revision = 0;
  let initializeRevision = 0;
  let reviewRevision = 0;
  let subscription: string | undefined;
  let stopped = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshPending = false;
  let refreshAgain = false;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<DesktopState>) => {
    if (stopped) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const fail = (error: unknown) => {
    publish({
      error:
        error instanceof Error ? error.message : "요청을 처리하지 못했어요.",
    });
  };
  async function command<T>(
    type: string,
    payload: CommandEnvelope["payload"],
  ): Promise<T> {
    const result: CommandResult = await api.command({
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      type,
      payload,
    });
    if (!result.ok) {
      const metadata = result.error?.details?.recordMetadataError;
      const warning =
        metadata &&
        typeof metadata === "object" &&
        !Array.isArray(metadata) &&
        typeof metadata.message === "string"
          ? ` 파일 변경 결과 기록이 미확정이어서 추가 작업이 차단됐어요. ${metadata.message}`
          : "";
      throw new Error(
        `${result.error?.message ?? "요청 실패"} (${result.error?.code ?? "UNKNOWN"})${warning}`,
      );
    }
    return result.result as T;
  }
  async function detach() {
    const previous = subscription;
    subscription = undefined;
    if (previous) await api.unsubscribe(previous).catch(() => {});
  }
  async function refresh() {
    if (refreshPending) {
      refreshAgain = true;
      return;
    }
    const id = state.sessionId,
      token = revision;
    if (!id || stopped) return;
    refreshPending = true;
    try {
      const snapshot = await command<SessionSnapshot>("session.getSnapshot", {
        sessionId: id,
      });
      if (token !== revision || stopped || state.sessionId !== id) return;
      if (!state.snapshot || snapshot.lastSeq >= state.snapshot.lastSeq)
        publish({ snapshot });
      const runId = state.reviewRunId ?? snapshot.runs.at(-1)?.id;
      if (runId) {
        const choice = reviewRevision;
        const review = await command<ReviewDiff>("review.getDiff", { runId });
        if (
          token === revision &&
          choice === reviewRevision &&
          !stopped &&
          state.sessionId === id
        )
          publish({ review, reviewRunId: runId });
      }
    } catch (error) {
      if (token === revision && !stopped) fail(error);
    } finally {
      refreshPending = false;
      if (refreshAgain && !stopped) {
        refreshAgain = false;
        void refresh();
      }
    }
  }
  function scheduleRefresh(update: DesktopUpdate) {
    if (
      update.subscriptionId !== subscription ||
      update.sessionId !== state.sessionId
    )
      return;
    if (update.error) {
      publish({ error: `${update.error.message} (${update.error.code})` });
      void reconnect();
      return;
    }
    if (update.lastSeq <= (state.snapshot?.lastSeq ?? 0)) return;
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh();
    }, 35);
  }
  async function reconnect() {
    const id = state.sessionId;
    if (!id) return;
    await selectSession(id);
  }
  const offUpdate = api.onUpdate(scheduleRefresh);
  const offHost = api.onHostState((host) => {
    if (stopped || host.generation < state.host.generation) return;
    const wasReady = state.host.state === "ready";
    publish({ host });
    if (host.state === "failed" || host.state === "stopped") {
      revision++;
      initializeRevision++;
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
      }
      void detach();
      if (host.state === "failed")
        publish({
          error: host.error
            ? `${host.error.message} (${host.error.code})`
            : "엔진 연결이 끊겼어요.",
        });
    }
    if (host.state === "ready" && !wasReady) void initialize();
  });
  async function initialize() {
    const request = ++initializeRevision,
      token = revision;
    try {
      const bootstrap = await api.getBootstrap();
      if (
        stopped ||
        request !== initializeRevision ||
        bootstrap.host.generation < state.host.generation
      )
        return;
      publish({
        host: bootstrap.host,
        ready: true,
        workspaces: bootstrap.workspaces,
        capabilities: bootstrap.capabilities ?? null,
        settings: bootstrap.settings,
        version: bootstrap.version,
        platform: bootstrap.platform,
      });
      if (bootstrap.host.state === "failed")
        publish({
          error: bootstrap.host.error
            ? `${bootstrap.host.error.message} (${bootstrap.host.error.code})`
            : "엔진 연결이 끊겼어요.",
        });
      if (bootstrap.host.state !== "ready") return;
      if (token !== revision) return;
      const workspaceId =
        state.workspaceId ??
        selection?.workspaceId ??
        bootstrap.workspaces.at(-1)?.id;
      if (workspaceId && bootstrap.workspaces.some((w) => w.id === workspaceId))
        await selectWorkspace(
          workspaceId,
          state.sessionId ?? selection?.sessionId,
        );
    } catch (error) {
      if (!stopped && request === initializeRevision) fail(error);
    }
  }
  async function selectWorkspace(
    workspaceId: string,
    preferredSession?: string,
  ) {
    const token = ++revision;
    await detach();
    if (stopped || token !== revision) return;
    publish({
      workspaceId,
      sessionId: null,
      sessions: [],
      snapshot: null,
      review: null,
      reviewRunId: null,
      error: null,
    });
    try {
      const sessions = await command<Session[]>("session.list", {
        workspaceId,
      });
      if (token !== revision || stopped) return;
      publish({ sessions });
      const session =
        sessions.find((s) => s.id === preferredSession) ?? sessions.at(-1);
      if (session) await selectSession(session.id);
    } catch (error) {
      if (token === revision && !stopped) fail(error);
    }
  }
  async function selectSession(sessionId: string) {
    const token = ++revision;
    await detach();
    if (token !== revision || stopped) return;
    publish({
      sessionId,
      snapshot: null,
      review: null,
      reviewRunId: null,
      error: null,
    });
    try {
      const snapshot = await command<SessionSnapshot>("session.getSnapshot", {
        sessionId,
      });
      if (token !== revision || stopped) return;
      publish({ snapshot });
      const sub = await api.subscribe(sessionId, snapshot.lastSeq);
      if (token !== revision || stopped) {
        await api.unsubscribe(sub).catch(() => {});
        return;
      }
      subscription = sub;
      await refresh();
    } catch (error) {
      if (token === revision && !stopped) fail(error);
    }
  }
  async function createSession() {
    const workspaceId = state.workspaceId;
    if (!workspaceId) return;
    try {
      const session = await command<Session>("session.create", {
        workspaceId,
        title: `새 작업 ${state.sessions.length + 1}`,
      });
      if (state.workspaceId !== workspaceId || stopped) return;
      publish({ sessions: [...state.sessions, session] });
      await selectSession(session.id);
    } catch (error) {
      fail(error);
    }
  }
  async function openWorkspace() {
    if (state.opening) return;
    publish({ opening: true, error: null });
    try {
      const workspace = await api.chooseWorkspace();
      if (workspace && !stopped) {
        publish({
          workspaces: [
            ...state.workspaces.filter((w) => w.id !== workspace.id),
            workspace,
          ],
        });
        await selectWorkspace(workspace.id);
        if (!state.sessions.length) await createSession();
      }
    } catch (error) {
      fail(error);
    } finally {
      if (!stopped) publish({ opening: false });
    }
  }
  async function submit(
    prompt: string,
    config: RunConfigInput,
    requestId: string,
  ): Promise<boolean> {
    const sessionId = state.sessionId;
    if (!sessionId || state.submitting) return false;
    publish({ submitting: true, error: null });
    try {
      const receipt = await command<RunReceipt>("run.submit", {
        sessionId,
        requestId,
        prompt,
        config: config as CommandEnvelope["payload"],
      });
      if (state.sessionId === sessionId && !stopped) {
        publish({ reviewRunId: receipt.runId });
        await refresh();
      }
      return true;
    } catch (error) {
      fail(error);
      return false;
    } finally {
      if (!stopped) publish({ submitting: false });
    }
  }
  async function cancel(runId: string) {
    try {
      await command("run.cancel", { runId });
      await refresh();
    } catch (error) {
      fail(error);
    }
  }
  async function decide(
    approvalId: string,
    decision: "allow" | "deny",
    fingerprint: string,
  ) {
    try {
      await command("approval.decide", { approvalId, decision, fingerprint });
      await refresh();
    } catch (error) {
      fail(error);
    }
  }
  async function saveSettings(input: SaveDesktopSettings) {
    try {
      const settings = await api.saveSettings(input);
      publish({ settings, error: null });
      await initialize();
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  }
  async function chooseReview(runId: string) {
    reviewRevision++;
    publish({ reviewRunId: runId, review: null });
    await refresh();
  }
  async function stop() {
    stopped = true;
    revision++;
    if (refreshTimer) clearTimeout(refreshTimer);
    offUpdate();
    offHost();
    await detach();
    listeners.clear();
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    initialize,
    selectWorkspace,
    selectSession,
    createSession,
    openWorkspace,
    submit,
    cancel,
    decide,
    saveSettings,
    chooseReview,
    command,
    refresh,
    stop,
    clearError: () => publish({ error: null }),
    retry: () => api.retryEngine(),
  };
}
export type DesktopStore = ReturnType<typeof createDesktopStore>;
