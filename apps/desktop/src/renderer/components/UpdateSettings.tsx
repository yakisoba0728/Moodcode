import { useEffect, useState } from "react";
import type {
  DesktopAppUpdate,
  DesktopAppUpdateAction,
} from "../../shared/update-protocol.js";

export function UpdateSettings() {
  const api = window.moodcode;
  const [view, setView] = useState<DesktopAppUpdate | null>(null),
    [busy, setBusy] = useState(false),
    [cancelling, setCancelling] = useState(false),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true,
      pending = false;
    const read = async () => {
      if (!api?.getAppUpdate || pending) return;
      pending = true;
      try {
        const result = await api.getAppUpdate();
        if (alive) setView(result);
      } catch (failure) {
        if (alive)
          setError(
            failure instanceof Error
              ? failure.message
              : "업데이트 상태를 읽지 못했어요.",
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
  }, [api]);
  if (!api?.getAppUpdate || !api.appUpdateAction || !view) return null;
  const act = async (input: DesktopAppUpdateAction) => {
    const cancel = input.action === "cancel";
    if ((busy && !cancel) || (cancel && cancelling)) return;
    if (cancel) setCancelling(true);
    else setBusy(true);
    setError(null);
    try {
      setView(await api.appUpdateAction!(input));
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "업데이트를 처리하지 못했어요.",
      );
    } finally {
      if (cancel) setCancelling(false);
      else setBusy(false);
    }
  };
  const labels = {
    disabled: "업데이트 비활성화",
    idle: "최신 버전 확인 가능",
    checking: "새 버전 확인 중",
    available: "새 버전 사용 가능",
    downloading: "다운로드 중",
    downloaded: "설치 준비됨",
    installing: "설치 중",
    failed: "업데이트 실패",
  };
  return (
    <section className="account-panel" aria-label="앱 업데이트">
      <h3>앱 업데이트</h3>
      <p>
        {labels[view.state]} · 현재 {view.currentVersion}
        {view.version ? ` → ${view.version}` : ""}
      </p>
      {view.reason ? <p className="field-help">{view.reason}</p> : null}
      {view.progress !== undefined ? (
        <progress
          aria-label="업데이트 다운로드 진행"
          max={100}
          value={view.progress}
        />
      ) : null}
      <div className="advanced-actions">
        <button
          type="button"
          className="text-button"
          disabled={
            busy || !["idle", "failed", "available"].includes(view.state)
          }
          onClick={() => void act({ action: "check" })}
        >
          업데이트 확인
        </button>
        {view.state === "available" ? (
          <button
            type="button"
            className="button secondary"
            disabled={busy || !view.version}
            onClick={() =>
              void act({ action: "download", version: view.version })
            }
          >
            검토한 버전 다운로드
          </button>
        ) : null}
        {view.state === "downloading" ? (
          <button
            type="button"
            className="text-button"
            disabled={cancelling}
            onClick={() => void act({ action: "cancel" })}
          >
            다운로드 취소
          </button>
        ) : null}
        {view.state === "downloaded" ? (
          <button
            type="button"
            className="button secondary"
            disabled={busy || !view.version}
            onClick={() =>
              void act({
                action: "install",
                version: view.version,
                acknowledged: true,
              })
            }
          >
            업데이트 설치 및 앱 종료
          </button>
        ) : null}
      </div>
      {error || view.error ? (
        <p className="inline-error" role="alert">
          {error ?? `${view.error!.message} (${view.error!.code})`}
        </p>
      ) : null}
    </section>
  );
}
