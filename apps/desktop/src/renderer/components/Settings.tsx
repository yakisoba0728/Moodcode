import { useEffect, useRef, useState } from "react";
import { REASONING_EFFORTS, type ReasoningEffort } from "@moodcode/contracts";
import type {
  DesktopProviderId,
  DesktopSettings,
} from "../../shared/protocol.js";
import type { DesktopStore } from "../store.js";
import { Icon } from "./Icon.js";
import { AccountSettings } from "./AccountSettings.js";
import { UpdateSettings } from "./UpdateSettings.js";
import type { DesktopAccountView } from "../../shared/account-protocol.js";
import { ANTHROPIC_REASONING_EFFORTS } from "../../shared/protocol.js";

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
  const [credentialMode, setCredentialMode] = useState<"local" | "chatgpt">(
    settings.credentialMode === "chatgpt" ? "chatgpt" : "local",
  );
  const [accounts, setAccounts] = useState<DesktopAccountView | null>(null);
  const [provider, setProvider] = useState<DesktopProviderId>(
    settings.providerId,
  );
  const [model, setModel] = useState(settings.modelId);
  const [effort, setEffort] = useState<ReasoningEffort | "">(
    settings.reasoningEffort ?? "",
  );
  const [endpoint, setEndpoint] = useState(settings.baseURL);
  const [anthropicWorkspaceId, setAnthropicWorkspaceId] = useState(settings.anthropicWorkspaceId ?? "");
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accountLogin = provider === "codex" && credentialMode === "chatgpt";
  useEffect(() => {
    if (settings.credentialMode === "chatgpt" && settings.accountId) {
      setProvider(settings.providerId);
      setCredentialMode("chatgpt");
      setModel(settings.modelId);
      setEndpoint(settings.baseURL);
      setKey("");
    }
  }, [
    settings.accountId,
    settings.credentialMode,
    settings.modelId,
    settings.providerId,
    settings.baseURL,
  ]);
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
          ...(key &&
          provider !== "codex" &&
          provider !== "scripted"
            ? { apiKey: key }
            : {}),
          ...(clearKey ? { clearKey: true } : {}),
          ...(accountLogin
            ? { credentialMode: "chatgpt" as const, accountId: accounts?.activeAccountId ?? settings.accountId }
            : provider === "codex" ? {} : { credentialMode: "api-key" as const }),
          ...(effort &&
          (provider === "codex" || provider === "openai-responses" || provider === "anthropic")
            ? { reasoningEffort: effort }
            : {}),
          ...(provider === "anthropic" && anthropicWorkspaceId
            ? { anthropicWorkspaceId }
            : {}),
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
      <button
        className="text-button"
        disabled={saving}
        onClick={() => {
          void store.refreshConnectionInfo();
        }}
      >
        로그인 상태·모델 목록 새로고침
      </button>
      <p className="dialog-description">
        작업에 사용할 모델과 로그인 방식을 선택하세요.
      </p>
      <AccountSettings store={store} onView={setAccounts} />
      <label className="field-label">
        연결 방식
        <select
          value={provider}
          onChange={(event) => {
            const id = event.target.value as DesktopProviderId;
            setProvider(id);
            setEffort("");
            setCredentialMode(id === "codex" && settings.credentialMode === "chatgpt" ? "chatgpt" : "local");
            if (id === "anthropic" || provider === "anthropic") setKey("");
            setAnthropicWorkspaceId(id === "anthropic" ? settings.anthropicWorkspaceId ?? "" : "");
            if (id === "codex") setModel(settings.credentialMode === "chatgpt" ? settings.modelId : settings.codexModelId ?? "");
            else if (id === "scripted") setModel("local");
            else if (id === "anthropic") setModel(settings.providerId === "anthropic" ? settings.modelId : "");
            else if (model === "local") setModel("");
            if (id === "codex" || id === "scripted") {
              setEndpoint("");
              setKey("");
            } else if (id === "openai-responses")
              setEndpoint("https://api.openai.com/v1");
            else if (id === "anthropic") setEndpoint("https://api.anthropic.com/v1");
          }}
        >
          <option value="codex">Codex · ChatGPT 로그인</option>
          <option value="openai-responses">
            OpenAI Responses · API 키
          </option>
          <option value="openai-compatible">OpenAI 호환 API</option>
          <option value="anthropic">Anthropic · API 키</option>
          <option value="scripted">테스트 모델 · 로컬</option>
        </select>
      </label>
      {provider === "codex" ? (
        <label className="field-label">
          Codex 인증 방식
          <select
            value={credentialMode}
            onChange={(event) => {
              const value = event.target.value as "local" | "chatgpt";
              setCredentialMode(value);
              setEndpoint(""); setKey(""); setEffort("");
              if (value === "chatgpt") {
                setModel(accounts?.models.find(item => item.id === model)?.id ?? accounts?.models[0]?.id ?? "");
              } else setModel(settings.codexModelId ?? "");
            }}
          >
            <option value="chatgpt">앱에서 ChatGPT로 로그인</option>
            <option value="local">이 컴퓨터의 Codex 로그인</option>
          </select>
        </label>
      ) : null}
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
              onChange={(event) => {
                setModel(event.target.value);
                setEffort("");
              }}
              list={
                accountLogin ? "account-models" : provider === "codex" ? "codex-models" : undefined
              }
              placeholder="사용할 모델 ID"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {accountLogin && accounts?.activeAccountId ? (
            <datalist id="account-models">
              {accounts.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName}
                </option>
              ))}
            </datalist>
          ) : null}
          {provider === "codex" && !accountLogin && settings.codexModels?.length ? (
            <>
              <datalist id="codex-models">
                {settings.codexModels.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName}
                  </option>
                ))}
              </datalist>
              <p className="field-help">
                로컬 Codex 목록에서 선택하거나 모델 ID를 입력하세요. 사용 권한은
                요청 시 확인해요.
              </p>
            </>
          ) : null}
          {provider === "codex" || provider === "openai-responses" || provider === "anthropic" ? (
            <label className="field-label">
              추론 강도
              <select
                value={effort}
                onChange={(event) =>
                  setEffort(event.target.value as ReasoningEffort | "")
                }
              >
                <option value="">모델 기본값</option>
                {(provider === "codex" && !accountLogin
                  ? (settings.codexModels?.find((item) => item.id === model)
                      ?.reasoningEfforts ?? REASONING_EFFORTS)
                  : provider === "anthropic" ? ANTHROPIC_REASONING_EFFORTS : REASONING_EFFORTS
                ).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <span className="field-help">
                높은 강도는 응답 시간이 늘 수 있어요. 모델이 지원하는 값을
                선택하세요.
              </span>
            </label>
          ) : null}
          {provider === "codex" ? (
            <div className="settings-note">
              <Icon name="shield" />
              <div>
                <strong>{accountLogin ? "앱의 ChatGPT 로그인 사용" : "로컬 Codex 로그인 사용"}</strong>
                <p>
                  {accountLogin
                    ? "브라우저에서 로그인한 ChatGPT 계정으로 Codex를 사용해요. 계정 모델 목록은 제공된 정보이며 실제 사용 권한은 요청할 때 확인해요."
                    : "이 컴퓨터의 기존 Codex 로그인으로 연결해요. 로그인 파일은 읽기만 하며 앱에서 수정하지 않아요."}
                  {" "}토큰은 화면이나 대화 기록에 표시하지 않아요.
                </p>
                <span
                  className={
                    (accountLogin ? settings.keySource === "chatgpt" : settings.codexAuthState === "available")
                      ? "connection-valid"
                      : "muted"
                  }
                >
                  {(accountLogin ? settings.keySource === "chatgpt" : settings.codexAuthState === "available")
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
                  placeholder={provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              {provider === "anthropic" ? (
                <label className="field-label">
                  Anthropic Workspace ID · 선택
                  <input value={anthropicWorkspaceId} onChange={(event) => setAnthropicWorkspaceId(event.target.value)}
                    placeholder="wrkspc_…" autoComplete="off" spellCheck={false} maxLength={135} />
                  <span className="field-help">여러 Workspace에 접근하는 개인·서비스 계정 키는 ID가 필요해요. Claude Console의 Settings → Workspaces에서 확인하세요. Workspace 전용 키는 비워 둘 수 있어요.</span>
                </label>
              ) : null}
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
      <UpdateSettings />
      <div className="dialog-footer">
        <button className="button secondary" disabled={saving} onClick={close}>
          취소
        </button>
        <button
          className="button primary"
          disabled={
            saving ||
            (provider !== "scripted" && !model.trim()) ||
            (accountLogin &&
              !accounts?.activeAccountId &&
              !settings.accountId)
          }
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
