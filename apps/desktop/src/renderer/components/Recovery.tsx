import { useEffect, useRef, useState } from "react";
import type { DesktopRecoveryStatus } from "../../shared/protocol.js";
import { Icon } from "./Icon.js";

const blockerText: Record<string, string> = {
  RECOVERY_OWNER_BUSY:
    "다른 엔진이 데이터베이스를 사용 중이에요. 실행 중인 작업을 끝내고 다시 확인해 주세요.",
  RECOVERY_EFFECT_BUSY:
    "명령 실행을 정리 중이에요. 종료가 끝난 후 다시 확인해 주세요.",
  PROCESS_OWNER_ALIVE:
    "이전 명령의 관리 프로세스가 살아 있어요. 해당 앱에서 작업을 종료해 주세요.",
  PROCESS_GROUP_ALIVE:
    "이전 명령의 프로세스가 살아 있어요. 종료를 확인한 후 다시 진단해 주세요.",
  PROCESS_GROUP_NOT_RECORDED:
    "이전 프로세스 그룹이 기록되지 않아 종료 여부를 검증할 수 없어요. 자동 복구를 차단했어요.",
  PROCESS_CLEANUP_UNVERIFIED:
    "프로세스 상태를 확인할 권한이 없거나 상태가 불확실해요.",
  RESTORE_RESTART_REQUIRED:
    "복원 작업이 중단됐어요. 먼저 다시 연결해 중단 상태를 기록한 후 진단해 주세요.",
  RECOVERY_DATABASE_INVALID:
    "데이터베이스 무결성을 확인하지 못했어요. 원본을 보존하고 백업을 확인해 주세요.",
  RECOVERY_PATH_UNSUPPORTED: "데이터 경로의 파일 형식을 확인해 주세요.",
  RECOVERY_LIMIT_EXCEEDED:
    "진단 한도를 넘었어요. 원본을 보존하고 별도 점검이 필요해요.",
  RECOVERY_PERMISSION_DENIED: "진단에 필요한 파일을 읽을 권한이 없어요.",
  RECOVERY_SOURCE_CHANGED: "진단 중 기록이 바뀌었어요. 다시 확인해 주세요.",
  PRIMARY_DATABASE_MISSING:
    "대화 데이터베이스가 아직 없어요. 모델 설정 후 다시 연결해 주세요.",
  REVIEW_DATABASE_MISSING:
    "복원 기록 데이터베이스를 확인하지 못했어요. 다시 연결 후 재진단해 주세요.",
};
export function Recovery({ close }: { close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const request = useRef(0);
  const [status, setStatus] = useState<DesktopRecoveryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  async function diagnose() {
    const token = ++request.current;
    setBusy(true);
    setError(null);
    setAcknowledged(false);
    setStatus(null);
    try {
      if (!window.moodcode?.getRecoveryStatus)
        throw new Error("진단 기능을 사용할 수 없어요.");
      const value = await window.moodcode.getRecoveryStatus();
      if (mounted.current && token === request.current) setStatus(value);
    } catch (error) {
      if (mounted.current && token === request.current)
        setError(error instanceof Error ? error.message : "진단하지 못했어요.");
    } finally {
      if (mounted.current && token === request.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    void diagnose();
    return () => {
      mounted.current = false;
      request.current++;
      dialog.current?.close();
    };
  }, []);
  async function recover() {
    if (
      !status?.fingerprint ||
      status.state !== "recoverable" ||
      !acknowledged ||
      busy
    )
      return;
    setBusy(true);
    setError(null);
    try {
      if (!window.moodcode?.recoverEngine)
        throw new Error("복구 기능을 사용할 수 없어요.");
      const value = await window.moodcode.recoverEngine({
        fingerprint: status.fingerprint,
        acknowledged: true,
      });
      if (mounted.current) {
        setResult(
          `백업을 검증하고 복구 기록 ${value.restoredAcknowledgments}개를 저장했어요. 중단된 작업은 새 요청으로 이어가세요.`,
        );
        await diagnose();
      }
    } catch (error) {
      if (mounted.current) {
        setError(error instanceof Error ? error.message : "복구하지 못했어요.");
        setAcknowledged(false);
        setStatus(null);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function backup() {
    setBusy(true);
    setError(null);
    try {
      if (!window.moodcode?.backupDatabase)
        throw new Error("백업 기능을 사용할 수 없어요.");
      const value = await window.moodcode.backupDatabase();
      if (mounted.current && !value.cancelled)
        setResult(
          `대화 DB 백업을 검증했어요 (${value.bytes?.toLocaleString()} bytes).`,
        );
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : "백업하지 못했어요.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="settings-dialog recovery-dialog"
      aria-labelledby="recovery-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="dialog-heading">
        <h2 id="recovery-title">진단·복구</h2>
        <button
          className="icon-button"
          aria-label="진단 닫기"
          disabled={busy}
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      <p className="dialog-description">
        기록과 실행 상태를 확인해요. 복구 전 대화·복원 DB 백업을 검증하고,
        확인한 중단 상태를 별도 기록에 남겨요.
      </p>
      {busy ? <p role="status">처리 중…</p> : null}
      {status ? (
        <div className="recovery-status">
          <strong>
            {status.state === "clear"
              ? "복구가 필요한 기록이 없어요."
              : status.state === "recoverable"
                ? "확인 후 복구할 수 있어요."
                : "현재 복구가 차단돼 있어요."}
          </strong>
          <p>
            미확인 복원 {status.pendingRestoreCount}개 · 확인된 기록{" "}
            {status.resolvedRestoreCount}개
          </p>
          {status.blockers.map((code) => (
            <p key={code}>
              {blockerText[code] ?? "기록을 확인한 후 다시 진단해 주세요."}{" "}
              <code>{code}</code>
            </p>
          ))}
        </div>
      ) : null}
      {status?.state === "recoverable" ? (
        <label className="check-field">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={busy}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>
            현재 파일·Git 변경을 확인했어요. 중단된 작업의 결과가 불확실할 수
            있음을 확인하고 실행 차단 해제를 요청해요.
          </span>
        </label>
      ) : null}
      {result ? <p role="status">{result}</p> : null}
      {error ? (
        <p className="inline-error" role="alert">
          {error} 상태가 바뀌었다면 다시 진단해 주세요.
        </p>
      ) : null}
      <p className="field-help">
        대화 DB 백업 버튼은 대화·실행 기록을 저장해요. 복구 절차의 자동 백업에는
        복원 기록도 포함돼요. 중단된 도구를 다시 실행하려면 새 요청이 필요해요.
      </p>
      <div className="dialog-actions">
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => {
            void backup();
          }}
        >
          대화 DB 백업
        </button>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => {
            void diagnose();
          }}
        >
          다시 진단
        </button>
        <button
          className="button primary"
          disabled={busy || status?.state !== "recoverable" || !acknowledged}
          onClick={() => {
            void recover();
          }}
        >
          백업 후 복구
        </button>
      </div>
    </dialog>
  );
}
