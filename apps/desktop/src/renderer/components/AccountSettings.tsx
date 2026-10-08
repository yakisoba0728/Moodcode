import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DesktopAccountAction,
  DesktopAccountView,
} from "../../shared/account-protocol.js";
import type { DesktopStore } from "../store.js";

export function AccountSettings({
  store,
  onView,
}: {
  store: DesktopStore;
  onView?: (view: DesktopAccountView) => void;
}) {
  const api = window.moodcode;
  const [view, setView] = useState<DesktopAccountView | null>(null),
    [busy, setBusy] = useState(false),
    [cancelling, setCancelling] = useState(false),
    [selectedId, setSelectedId] = useState(""),
    [error, setError] = useState<string | null>(null);
  const revision = useRef(-1);
  const apply = useCallback(
    (value: DesktopAccountView) => {
      if (value.revision < revision.current) return;
      revision.current = value.revision;
      setView(value);
      onView?.(value);
    },
    [onView],
  );
  useEffect(() => {
    if (view?.activeAccountId) setSelectedId(view.activeAccountId);
  }, [view?.activeAccountId]);
  useEffect(() => {
    let alive = true,
      pending = false;
    const read = async () => {
      if (!api?.getAccounts || pending) return;
      pending = true;
      try {
        const value = await api.getAccounts();
        if (alive) apply(value);
      } catch (failure) {
        if (alive)
          setError(
            failure instanceof Error
              ? failure.message
              : "계정 상태를 읽지 못했어요.",
          );
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, apply]);
  if (!api?.getAccounts || !api.accountAction) return null;
  const act = async (input: DesktopAccountAction) => {
    const cancel = input.action === "cancel";
    if ((busy && !cancel) || (cancel && cancelling)) return;
    if (cancel) setCancelling(true);
    else setBusy(true);
    setError(null);
    try {
      const value = await api.accountAction!(input);
      apply(value);
      await store.refreshConnectionInfo();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "계정 요청을 처리하지 못했어요.",
      );
    } finally {
      if (cancel) setCancelling(false);
      else setBusy(false);
    }
  };
  const displayedId = view?.accounts.some((row) => row.id === selectedId)
    ? selectedId
    : (view?.activeAccountId ?? view?.accounts.at(-1)?.id ?? "");
  const account = view?.accounts.find((row) => row.id === displayedId);
  return (
    <section className="account-panel" aria-label="앱 계정 관리">
      <h3>ChatGPT 계정</h3>
      <p className="field-help">
        브라우저의 공식 로그인으로 연결해요. 로그인 정보를 화면이나 대화 기록에
        표시하지 않아요.
      </p>
      {view?.accounts.length ? (
        <label className="field-label">
          사용할 앱 계정
          <select
            aria-label="사용할 앱 계정"
            value={displayedId}
            disabled={busy || view.pending}
            onChange={(event) => {
              const id = event.target.value;
              setSelectedId(id);
              const account = view.accounts.find((row) => row.id === id);
              if (account && ["connected", "expired"].includes(account.state))
                void act({ action: "select", accountId: id });
            }}
          >
            <option value="">계정 선택</option>
            {view.accounts.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label} · {row.state}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {account ? (
        <p className="field-help">
          {account.state === "connected"
            ? "연결됨"
            : account.state === "expired"
              ? "로그인 갱신이 필요해요."
              : account.state === "signed-out"
                ? "로그아웃됨"
                : "연결에 실패했어요."}
          {account.expiresAt
            ? ` · 만료 ${new Date(account.expiresAt).toLocaleString()}`
            : ""}
        </p>
      ) : null}
      <div className="advanced-actions">
        {view?.pending ? (
          <>
            <span role="status">브라우저 로그인을 기다려요.</span>
            <button
              type="button"
              className="text-button"
              disabled={cancelling}
              onClick={() => void act({ action: "cancel" })}
            >
              로그인 취소
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button secondary"
            disabled={busy || view?.secureStorage === "unavailable"}
            onClick={() => void act({ action: "sign-in" })}
          >
            ChatGPT로 계속
          </button>
        )}
        {account ? (
          <>
            {account.state !== "connected" ? (
              <button
                type="button"
                className="text-button"
                disabled={
                  busy || view?.pending || view?.secureStorage === "unavailable"
                }
                onClick={() =>
                  void act({ action: "sign-in", accountId: account.id })
                }
              >
                계정 다시 연결
              </button>
            ) : null}
            <button
              type="button"
              className="text-button"
              disabled={busy || view?.pending || account.state === "signed-out"}
              onClick={() =>
                void act({ action: "refresh", accountId: account.id })
              }
            >
              계정 갱신
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy || view?.pending || account.state === "signed-out"}
              onClick={() =>
                void act({ action: "sign-out", accountId: account.id })
              }
            >
              앱 계정 로그아웃
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy || view?.pending || account.state === "connected"}
              onClick={() =>
                void act({ action: "forget", accountId: account.id })
              }
            >
              앱에서 계정 제거
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="text-button"
          onClick={() =>
            void api
              .openExternal("https://chatgpt.com/settings/usage")
              .catch((failure) =>
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "사용량 페이지를 열지 못했어요.",
                ),
              )
          }
        >
          ChatGPT 사용량 관리
        </button>
      </div>
      {view?.secureStorage === "unavailable" ? (
        <p className="field-help">
          이 환경에서는 로그인 credential을 안전하게 저장할 수 없어 앱 계정
          로그인을 사용할 수 없어요.
        </p>
      ) : null}
      {account?.state === "connected" && !account.sharing ? (
        <p className="field-help">
          이 계정은 앱 모델 사용 공유를 허용하지 않았어요. ChatGPT에서 연결
          권한을 확인하세요.
        </p>
      ) : null}
      {view?.models.length ? (
        <p className="field-help">
          계정 모델: {view.models.map((model) => model.displayName).join(", ")}
        </p>
      ) : null}
      {error || view?.error ? (
        <p className="inline-error" role="alert">
          {error ?? `${view!.error!.message} (${view!.error!.code})`}
        </p>
      ) : null}
    </section>
  );
}
