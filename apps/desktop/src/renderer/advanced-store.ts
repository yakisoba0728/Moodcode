import type { JsonObject, JsonValue } from "@moodcode/contracts";
import type {
  DesktopAdvancedActionType,
  DesktopAdvancedSnapshot,
} from "../shared/advanced.js";

export interface AdvancedTransport {
  getAdvancedSnapshot(sessionId: string): Promise<DesktopAdvancedSnapshot>;
  advanced(input: {
    sessionId: string;
    type: DesktopAdvancedActionType;
    payload?: JsonObject;
  }): Promise<JsonValue>;
}
export interface AdvancedPreview {
  handleId: string;
  kind: string;
  expiresAt: string;
  preview: JsonValue;
}
export interface AdvancedState {
  sessionId: string | null;
  snapshot: DesktopAdvancedSnapshot | null;
  preview: AdvancedPreview | null;
  busy: boolean;
  error: string | null;
  result: JsonValue | null;
}
const initial = (): AdvancedState => ({
  sessionId: null,
  snapshot: null,
  preview: null,
  busy: false,
  error: null,
  result: null,
});

/** UI lifetime is independent of native ownership; obsolete replies cannot select a new session. */
export function createAdvancedStore(api: AdvancedTransport) {
  let state = initial(),
    epoch = 0,
    disposed = false,
    readPending = false;
  const listeners = new Set<() => void>();
  const ownedHandles = new Map<string, string>();
  const publish = (patch: Partial<AdvancedState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const release = async (
    sessionId: string,
    preview: Pick<AdvancedPreview, "handleId">,
  ) => {
    await api
      .advanced({
        sessionId,
        type: "handle.release",
        payload: { handleId: preview.handleId },
      })
      .catch(() => {});
  };
  const releaseOwned = () => {
    const pending = [...ownedHandles].map(([handleId, sessionId]) =>
      release(sessionId, { handleId }),
    );
    ownedHandles.clear();
    return pending;
  };
  async function refresh() {
    const sessionId = state.sessionId,
      token = epoch;
    if (!sessionId || disposed || readPending) return;
    readPending = true;
    try {
      const snapshot = await api.getAdvancedSnapshot(sessionId);
      if (token === epoch && !disposed && snapshot.sessionId === sessionId)
        publish({ snapshot });
    } catch (error) {
      if (token === epoch)
        publish({
          error:
            error instanceof Error
              ? error.message
              : "고급 작업 상태를 읽지 못했어요.",
        });
    } finally {
      readPending = false;
      if (token !== epoch && state.sessionId && !disposed) void refresh();
    }
  }
  async function bind(sessionId: string | null) {
    const previous = state;
    epoch++;
    void Promise.all(releaseOwned());
    publish({ ...initial(), sessionId });
    if (previous.sessionId && previous.preview)
      void release(previous.sessionId, previous.preview);
    await refresh();
  }
  async function action(
    type: DesktopAdvancedActionType,
    payload: JsonObject = {},
  ): Promise<JsonValue | null> {
    const sessionId = state.sessionId,
      token = epoch;
    if (!sessionId || state.busy || disposed) return null;
    publish({ busy: true, error: null });
    try {
      const result = await api.advanced({ sessionId, type, payload });
      if (token !== epoch || disposed) {
        const handleId = object(result).handleId;
        if (typeof handleId === "string") void release(sessionId, { handleId });
        return null;
      }
      const preview = asPreview(result);
      if (preview) {
        if (state.preview) void release(sessionId, state.preview);
        publish({ preview, result: null });
      } else {
        const handleId = object(result).handleId;
        if (typeof handleId === "string") ownedHandles.set(handleId, sessionId);
        publish({ result });
      }
      await refresh();
      return result;
    } catch (error) {
      if (token === epoch)
        publish({
          error:
            error instanceof Error
              ? error.message
              : "고급 작업을 처리하지 못했어요.",
        });
      return null;
    } finally {
      if (token === epoch) publish({ busy: false });
    }
  }
  async function approve(type: DesktopAdvancedActionType) {
    const preview = state.preview,
      sessionId = state.sessionId;
    if (!preview || state.busy) return null;
    // Consume the UI handle before dispatch; an uncertain reply must never automatically replay an effect.
    publish({ preview: null });
    const result = await action(type, {
      handleId: preview.handleId,
      approved: true,
    });
    if (result === null && sessionId) await release(sessionId, preview);
    return result;
  }
  async function dismissPreview() {
    const { preview, sessionId } = state;
    publish({ preview: null });
    if (preview && sessionId) await release(sessionId, preview);
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    clearResult: () => publish({ result: null }),
    bind,
    refresh,
    action,
    approve,
    dismissPreview,
    query: async (
      type: DesktopAdvancedActionType,
      payload: JsonObject = {},
    ) => {
      if (type === "handle.release") {
        const handleId = payload.handleId;
        const sourceSessionId =
          typeof handleId === "string" ? ownedHandles.get(handleId) : undefined;
        if (!sourceSessionId || typeof handleId !== "string") return null;
        ownedHandles.delete(handleId);
        await release(sourceSessionId, { handleId });
        return null;
      }
      const sessionId = state.sessionId,
        token = epoch;
      if (!sessionId || disposed) return null;
      const result = await api.advanced({ sessionId, type, payload });
      return token === epoch && !disposed ? result : null;
    },
    dispose: async () => {
      const { preview, sessionId } = state;
      epoch++;
      disposed = true;
      state = initial();
      listeners.clear();
      await Promise.all([
        ...(preview && sessionId ? [release(sessionId, preview)] : []),
        ...releaseOwned(),
      ]);
    },
  };
}
export type AdvancedStore = ReturnType<typeof createAdvancedStore>;
export function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
export function rows(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object) : [];
}
export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
export function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function asPreview(value: JsonValue): AdvancedPreview | null {
  const row = object(value);
  if (row.kind === "terminal.control" || row.kind === "team.mailbox.claim")
    return null;
  return typeof row.handleId === "string" &&
    typeof row.kind === "string" &&
    typeof row.expiresAt === "string" &&
    row.preview !== undefined
    ? {
        handleId: row.handleId,
        kind: row.kind,
        expiresAt: row.expiresAt,
        preview: row.preview,
      }
    : null;
}
