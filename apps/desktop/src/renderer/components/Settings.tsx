import { useEffect, useRef, useState } from "react";
import type {
  DesktopProviderId,
  DesktopSettings,
} from "../../shared/protocol.js";
import type { DesktopStore } from "../store.js";
import { Icon } from "./Icon.js";

export function Settings({
  settings,
  store,
  close,
}: {
  settings: DesktopSettings;
  store: DesktopStore;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [provider, setProvider] = useState<DesktopProviderId>(
    settings.providerId,
  );
  const [model, setModel] = useState(settings.modelId);
  const [endpoint, setEndpoint] = useState(settings.baseURL);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  async function save() {
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      if (
        await store.saveSettings({
          providerId: provider,
          modelId: provider === "scripted" ? "local" : model.trim(),
          baseURL:
            provider === "codex" || provider === "scripted"
              ? ""
              : endpoint.trim(),
          ...(key && provider !== "codex" && provider !== "scripted"
            ? { apiKey: key }
            : {}),
          ...(clearKey ? { clearKey: true } : {}),
        })
      ) {
        setKey("");
        close();
      } else setError(store.getSnapshot().error ?? "설정을 저장하지 못했어요.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <dialog
      className="settings-dialog"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) close();
      }}
      aria-labelledby="settings-title"
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">WORKSPACE SETTINGS</span>
          <h2 id="settings-title">모델 연결</h2>
        </div>
        <button
          className="icon-button"
          aria-label="설정 닫기"
          disabled={saving}
          onClick={close}
        >
          <Icon name="close" size={19} />
        </button>
      </div>
      <p className="dialog-description">
        작업에 사용할 모델과 로그인 방식을 선택하세요.
      </p>
      <label className="field-label">
        연결 방식
        <select
          value={provider}
          onChange={(event) => {
            const id = event.target.value as DesktopProviderId;
            setProvider(id);
            if (id === "codex") setModel(settings.codexModelId ?? "");
            else if (id === "scripted") setModel("local");
            else if (model === "local") setModel("");
            if (id === "codex" || id === "scripted") {
              setEndpoint("");
              setKey("");
            } else if (id === "openai-responses")
              setEndpoint("https://api.openai.com/v1");
          }}
        >
          <option value="codex">Codex 로그인 계정</option>
          <option value="openai-responses">OpenAI Responses · API 키</option>
          <option value="openai-compatible">OpenAI 호환 API</option>
          <option value="scripted">테스트 모델 · 로컬</option>
        </select>
      </label>
      {provider === "scripted" ? (
        <div className="settings-note">
          <Icon name="code" />
          <p>
            연결·기록·화면을 확인하는 로컬 테스트 모델이에요. 실제 AI 추론은
            실행하지 않아요.
          </p>
        </div>
      ) : (
        <>
          <label className="field-label">
            모델 ID
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="사용할 모델 ID"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {provider === "codex" ? (
            <div className="settings-note">
              <Icon name="shield" />
              <div>
                <strong>Codex 로그인 사용</strong>
                <p>
                  이 컴퓨터에 로그인된 Codex 계정으로 연결해요. 토큰은 화면에
                  표시하거나 앱 설정에 복사하지 않아요.
                </p>
                <span
                  className={
                    settings.codexAuthState === "available"
                      ? "connection-valid"
                      : "muted"
                  }
                >
                  {settings.codexAuthState === "available"
                    ? "로그인 확인됨"
                    : settings.codexAuthState === "expired"
                      ? "Codex에서 로그인 갱신이 필요해요."
                      : "Codex 로그인 상태를 확인해 주세요."}
                </span>
              </div>
            </div>
          ) : (
            <>
              <label className="field-label">
                API endpoint
                <input
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                  placeholder="https://api.openai.com/v1"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="field-label">
                API 키
                <input
                  type="password"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder={
                    settings.keyConfigured
                      ? "설정됨 · 바꾸려면 새 키를 입력"
                      : "환경 변수 또는 키 입력"
                  }
                  autoComplete="new-password"
                  disabled={settings.credentialStorage === "unavailable"}
                />
              </label>
              <p className="field-help">
                {settings.credentialStorage === "available"
                  ? "입력한 키는 운영체제의 암호화 저장소로 보호해요."
                  : "이 환경에서는 키 저장을 지원하지 않아요. 환경 변수로 연결할 수 있어요."}
              </p>
            </>
          )}
        </>
      )}
      {settings.keySource === "stored" ? (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={clearKey}
            onChange={(event) => setClearKey(event.target.checked)}
          />
          저장된 API 키 제거
        </label>
      ) : null}
      {clearKey &&
      provider !== "scripted" &&
      provider !== "codex" &&
      settings.keySource !== "environment" ? (
        <p className="field-help">
          키를 지우려면 Codex 계정이나 테스트 모델로 전환해 저장하세요.
        </p>
      ) : null}
      <div className="dialog-footer">
        <button className="button secondary" disabled={saving} onClick={close}>
          취소
        </button>
        <button
          className="button primary"
          disabled={saving || (provider !== "scripted" && !model.trim())}
          onClick={() => {
            void save();
          }}
        >
          {saving ? "연결 설정 중…" : "설정 저장"}
        </button>
      </div>
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </dialog>
  );
}
