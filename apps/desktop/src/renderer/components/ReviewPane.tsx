import { useEffect, useMemo, useRef, useState } from "react";
import type { ReviewDiff, Run, Workspace } from "@moodcode/contracts";
import type {
  RestoreOperation,
  RestoreCommandResult,
  ReviewHistoryResult,
  RestorePreview,
  RestoreResult,
} from "@moodcode/engine";
import type { DesktopStore, FileListing, FilePreview } from "../store.js";
import { buildDiff, shortPath } from "../model.js";
import { CodeBlock } from "./LazyCodeBlock.js";
import type { FileTarget } from "../navigation.js";
import { Icon } from "./Icon.js";

function FileContents({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <>
      <div className="source-code">
        {lines.slice(0, 2000).map((line, i) => (
          <div className="source-line" key={i}>
            <span className="line-number">{i + 1}</span>
            <code>{line || " "}</code>
          </div>
        ))}
      </div>
      {lines.length > 2000 ? (
        <p className="pane-note">화면에는 처음 2,000줄을 표시했어요.</p>
      ) : null}
    </>
  );
}
function DiffContents({
  before,
  after,
}: {
  before: string | null;
  after: string | null;
}) {
  const diff = useMemo(() => buildDiff(before, after), [before, after]);
  const [side, setSide] = useState<"before" | "after">("after");
  if (diff.large)
    return (
      <>
        <div className="segmented">
          <button
            className={side === "before" ? "selected" : ""}
            onClick={() => setSide("before")}
          >
            변경 전
          </button>
          <button
            className={side === "after" ? "selected" : ""}
            onClick={() => setSide("after")}
          >
            변경 후
          </button>
        </div>
        <FileContents content={(side === "before" ? before : after) ?? ""} />
      </>
    );
  return (
    <div className="diff-code">
      {diff.lines.map((line, i) => (
        <div className={`diff-line ${line.kind}`} key={i}>
          <span className="line-number">{line.before ?? ""}</span>
          <span className="line-number">{line.after ?? ""}</span>
          <span className="diff-sign">
            {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
          </span>
          <code>{line.text || " "}</code>
        </div>
      ))}
    </div>
  );
}
export function ReviewPane({
  workspace,
  review,
  run,
  store,
  busy,
  fileTarget,
}: {
  workspace: Workspace | undefined;
  review: ReviewDiff | null;
  run: Run | undefined;
  store: DesktopStore;
  busy: boolean;
  fileTarget?: FileTarget | null;
}) {
  const currentWorkspace = useRef(workspace?.id);
  currentWorkspace.current = workspace?.id;
  const fileRequest = useRef(0);
  const currentRun = useRef(review?.runId);
  currentRun.current = review?.runId;
  const [tab, setTab] = useState<"changes" | "files">("changes");
  const [selected, setSelected] = useState<string | null>(null);
  const [directory, setDirectory] = useState("");
  const [listing, setListing] = useState<FileListing | null>(null);
  const [listingRevision, setListingRevision] = useState(0);
  const [previewLine, setPreviewLine] = useState<number | undefined>();
  const consumedTarget = useRef(0);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [restore, setRestore] = useState<RestorePreview | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [history, setHistory] = useState<RestoreOperation[]>([]);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [restoreResult, setRestoreResult] =
    useState<RestoreCommandResult | null>(null);
  useEffect(() => {
    setDirectory("");
    setListing(null);
    setPreview(null);
    setSelected(null);
    setError(null);
    setRestore(null);
    setRestoreResult(null);
  }, [workspace?.id]);
  useEffect(() => {
    if (selected && !review?.files.some((f) => f.path === selected))
      setSelected(null);
    setRestore(null);
    setRestoreResult(null);
  }, [review?.runId]);
  useEffect(() => {
    const runId = review?.runId;
    setHistory([]);
    if (!runId) return;
    let cancelled = false;
    void store
      .command<ReviewHistoryResult>("review.history", { runId })
      .then((records) => {
        if (!cancelled) setHistory(records.operations);
      })
      .catch((error) => {
        if (!cancelled)
          setError(
            error instanceof Error
              ? error.message
              : "복원 기록을 읽지 못했어요.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [review?.runId, historyRevision, store]);
  useEffect(() => {
    fileRequest.current++;
    setPreview(null);
  }, [directory, workspace?.id]);
  useEffect(() => {
    if (tab !== "files" || !workspace) return;
    let cancelled = false;
    setLoading(true);
    void store
      .command<FileListing>("file.list", {
        workspaceId: workspace.id,
        path: directory,
        limit: 100,
      })
      .then((data) => {
        if (!cancelled) {
          setListing(data);
          setError(null);
        }
      })
      .catch((error) => {
        if (!cancelled)
          setError(
            error instanceof Error
              ? error.message
              : "파일 목록을 읽지 못했어요.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [directory, workspace?.id, tab, listingRevision, store]);
  useEffect(() => {
    if (
      !fileTarget ||
      fileTarget.workspaceId !== workspace?.id ||
      consumedTarget.current === fileTarget.id
    )
      return;
    setTab("files");
    const parent = fileTarget.path.split("/").slice(0, -1).join("/");
    if (directory !== parent) {
      setDirectory(parent);
      return;
    }
    consumedTarget.current = fileTarget.id;
    void openFile(fileTarget.path, fileTarget.line);
  }, [fileTarget, workspace?.id, directory]);
  async function loadMore() {
    if (
      !workspace ||
      !listing?.continuation ||
      loading ||
      listing.entries.length >= 2000
    )
      return;
    const workspaceId = workspace.id,
      request = ++fileRequest.current;
    setLoading(true);
    try {
      const data = await store.command<FileListing>("file.list", {
        workspaceId,
        path: directory,
        limit: 100,
        continuation: listing.continuation,
      });
      if (
        currentWorkspace.current === workspaceId &&
        fileRequest.current === request
      )
        setListing({
          ...data,
          entries: [...listing.entries, ...data.entries].slice(0, 2000),
        });
    } catch (error) {
      if (fileRequest.current === request)
        setError(
          error instanceof Error ? error.message : "다음 목록을 읽지 못했어요.",
        );
    } finally {
      if (fileRequest.current === request) setLoading(false);
    }
  }
  async function openFile(path: string, line?: number) {
    if (!workspace) return;
    const workspaceId = workspace.id,
      request = ++fileRequest.current;
    setLoading(true);
    setError(null);
    try {
      const file = await store.command<FilePreview>("file.read", {
        workspaceId: workspace.id,
        path,
      });
      if (
        currentWorkspace.current === workspaceId &&
        fileRequest.current === request
      ) {
        setPreview(file);
        setPreviewLine(line);
      }
    } catch (error) {
      if (
        currentWorkspace.current === workspaceId &&
        fileRequest.current === request
      )
        setError(
          error instanceof Error ? error.message : "파일을 읽지 못했어요.",
        );
    } finally {
      if (
        fileRequest.current === request &&
        currentWorkspace.current === workspaceId
      )
        setLoading(false);
    }
  }
  async function beginRestore(checkpointId: string) {
    const runId = review?.runId;
    if (!runId) return;
    setError(null);
    setRestoreResult(null);
    try {
      const preview = await store.command<RestorePreview>(
        "review.previewRestore",
        {
          runId,
          checkpointId,
        },
      );
      if (currentRun.current === runId) setRestore(preview);
    } catch (error) {
      if (currentRun.current === runId)
        setError(
          error instanceof Error
            ? error.message
            : "복원할 상태를 확인하지 못했어요.",
        );
    }
  }
  async function confirmRestore() {
    if (!restore || restoring || busy) return;
    const runId = restore.runId;
    setRestoring(true);
    try {
      const result = await store.command<RestoreCommandResult>(
        "review.restore",
        {
          runId: restore.runId,
          checkpointId: restore.checkpointId,
          previewFingerprint: restore.fingerprint,
        },
      );
      if (currentRun.current === runId) {
        setRestoreResult(result);
        setRestore(null);
        setPreview(null);
        setHistoryRevision((value) => value + 1);
      }
      await store.refresh();
    } catch (error) {
      if (currentRun.current === runId) {
        setError(error instanceof Error ? error.message : "복원하지 못했어요.");
        setRestore(null);
        setHistoryRevision((value) => value + 1);
      }
    } finally {
      setRestoring(false);
    }
  }
  const file = review?.files.find((f) => f.path === selected);
  const checkpoint = review?.checkpoints.findLast(
    (value) => value.files.length > 0,
  );
  return (
    <aside className="review-pane" aria-label="변경 검토">
      <div className="pane-tabs">
        <button
          className={tab === "changes" ? "selected" : ""}
          onClick={() => {
            setTab("changes");
            setPreview(null);
          }}
        >
          <Icon name="edit" />
          변경 <span className="count">{review?.files.length ?? 0}</span>
        </button>
        <button
          className={tab === "files" ? "selected" : ""}
          onClick={() => setTab("files")}
        >
          <Icon name="folder" />
          파일
        </button>
      </div>
      {tab === "changes" ? (
        <>
          <div className="pane-heading">
            <span>{run ? "이번 작업의 변경" : "변경 검토"}</span>
            {checkpoint ? (
              <button
                className="icon-button"
                aria-label="마지막 변경 복원 확인"
                title="마지막 파일 변경 복원 확인"
                disabled={busy || restoring}
                onClick={() => {
                  void beginRestore(checkpoint.id);
                }}
              >
                <Icon name="undo" />
              </button>
            ) : null}
          </div>
          {restore ? (
            <div className="restore-card">
              <strong>이 변경을 복원할까요?</strong>
              <p>
                기록된 변경 직전 내용으로 되돌려요. 현재 파일과 충돌하면
                복원하지 않아요.
              </p>
              <ul>
                {restore.files.map((f) => (
                  <li key={f.path}>
                    <code>{f.path}</code>
                  </li>
                ))}
              </ul>
              {restore.diff.slice(0, 10).map((file) => (
                <details className="restore-diff" key={file.path}>
                  <summary>{file.path} · 복원 전 / 후</summary>
                  <DiffContents before={file.before} after={file.after} />
                </details>
              ))}
              {restore.diff.length > 10 ? (
                <p>처음 10개 파일의 내용을 표시했어요.</p>
              ) : null}
              {restore.files.some((f) => f.status !== "ready") ? (
                <p className="inline-error">
                  현재 파일과 충돌이 있어요. 파일을 확인해 주세요.
                </p>
              ) : null}
              <div className="restore-actions">
                <button
                  className="button secondary"
                  disabled={restoring}
                  onClick={() => setRestore(null)}
                >
                  취소
                </button>
                <button
                  className="button primary"
                  disabled={restoring || busy || !restore.canRestore}
                  onClick={() => {
                    void confirmRestore();
                  }}
                >
                  {restoring ? "복원 중…" : "확인하고 복원"}
                </button>
              </div>
            </div>
          ) : null}
          {history.length ? (
            <details className="review-warnings restore-history">
              <summary>복원 기록 {history.length}개</summary>
              {history.map((operation) => (
                <div className="restore-history-entry" key={operation.id}>
                  <strong>
                    {operation.state === "completed"
                      ? operation.result?.effectsUncertain ||
                        operation.result?.executionBlocked ||
                        operation.result?.totals.failed ||
                        operation.result?.totals.conflicts ||
                        operation.result?.cancelled
                        ? "복원 결과 확인 필요"
                        : "복원 완료"
                      : operation.state === "started"
                        ? "복원 결과 확인 대기"
                        : operation.state === "interrupted"
                          ? "복원 중단 · 파일 확인 필요"
                          : "복원 실패"}
                  </strong>
                  <time>
                    {new Intl.DateTimeFormat("ko-KR", {
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    }).format(
                      new Date(operation.finishedAt ?? operation.startedAt),
                    )}
                  </time>
                  {operation.result ? (
                    <p>
                      복원 {operation.result.totals.restored}개 · 충돌{" "}
                      {operation.result.totals.conflicts}개 · 실패{" "}
                      {operation.result.totals.failed}개
                    </p>
                  ) : null}
                  {operation.error ? <p>{operation.error.message}</p> : null}
                </div>
              ))}
            </details>
          ) : null}
          {restoreResult ? (
            <div className="pane-note">
              {!restoreResult.cancelled &&
              !restoreResult.effectsUncertain &&
              !restoreResult.executionBlocked &&
              !restoreResult.recordMetadataError &&
              !restoreResult.failed.length &&
              !restoreResult.conflicts.length
                ? "복원했어요."
                : restoreResult.recordMetadataError
                  ? "파일 변경 결과를 기록하지 못했어요. 이 저장소의 추가 작업을 중지했으니 파일과 기록을 확인해 주세요."
                  : "일부 변경을 복원하지 못했어요. 현재 파일을 확인해 주세요."}
              {restoreResult.warnings.length ? (
                <ul>
                  {restoreResult.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {review?.files.length ? (
            <div className="changed-files">
              {review.files.map((f) => (
                <button
                  key={f.path}
                  className={`file-row ${selected === f.path ? "selected" : ""}`}
                  onClick={() =>
                    setSelected(selected === f.path ? null : f.path)
                  }
                >
                  <Icon name="file" size={15} />
                  <span title={f.path}>{f.path}</span>
                  <span
                    className={`change-kind ${f.before === null ? "added" : f.after === null ? "deleted" : "modified"}`}
                  >
                    {f.before === null ? "A" : f.after === null ? "D" : "M"}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="pane-empty">
              <div className="empty-icon">
                <Icon name="edit" size={23} />
              </div>
              <strong>변경을 여기서 확인하세요</strong>
              <p>
                작업에서 수정한 파일과
                <br />
                변경 전후 내용이 표시돼요.
              </p>
            </div>
          )}
          {file ? (
            <section className="file-inspector">
              <div className="file-inspector-heading">
                <Icon name="file" size={13} />
                <span title={file.path}>{shortPath(file.path)}</span>
                <span>변경 전 / 후</span>
              </div>
              <DiffContents before={file.before} after={file.after} />
            </section>
          ) : null}
          {review?.warnings.length ? (
            <details className="review-warnings">
              <summary>확인할 사항 {review.warnings.length}개</summary>
              <ul>
                {review.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : (
        <>
          <div className="pane-heading">
            <button
              className="text-button"
              disabled={!directory || loading}
              onClick={() => {
                setDirectory(directory.split("/").slice(0, -1).join("/"));
                setPreview(null);
              }}
            >
              <Icon
                name="chevron"
                size={13}
                style={{ transform: "rotate(180deg)" }}
              />
              {directory ||
                (workspace && shortPath(workspace.root)) ||
                "저장소"}
            </button>
            <button
              className="icon-button"
              aria-label="파일 목록 새로고침"
              disabled={!workspace || loading}
              onClick={() => {
                setListingRevision((value) => value + 1);
              }}
            >
              <Icon name="refresh" />
            </button>
          </div>
          {loading ? (
            <div className="pane-note">
              <span className="spinner-small" /> 파일을 읽는 중이에요.
            </div>
          ) : null}
          {listing?.entries.map((entry) => (
            <button
              key={entry.path}
              className="file-row"
              onClick={() => {
                if (entry.kind === "directory") {
                  setDirectory(entry.path);
                  setPreview(null);
                } else void openFile(entry.path);
              }}
            >
              <Icon
                name={entry.kind === "directory" ? "folder" : "file"}
                size={15}
              />
              <span>{entry.name}</span>
              {entry.kind === "directory" ? (
                <Icon name="chevron" size={11} />
              ) : null}
            </button>
          ))}
          {listing?.truncated ? (
            <div className="pane-note">
              파일 목록 일부를 표시했어요.
              {listing.continuation ? (
                <button
                  className="text-button"
                  disabled={loading || listing.entries.length >= 2000}
                  onClick={() => {
                    void loadMore();
                  }}
                >
                  다음 파일
                </button>
              ) : (
                "범위를 좁히거나 새로고침해 주세요."
              )}
              {listing.entries.length >= 2000
                ? "화면 한도 2,000개에 도달했어요. 하위 폴더를 열어 주세요."
                : ""}
            </div>
          ) : null}
          {preview ? (
            <section className="file-inspector">
              <div className="file-inspector-heading">
                <Icon name="file" size={13} />
                <span title={preview.path}>{shortPath(preview.path)}</span>
                <span>읽기 전용</span>
              </div>
              <CodeBlock
                source={preview.content}
                label={preview.path}
                language={
                  (
                    {
                      ts: "typescript",
                      tsx: "typescript",
                      js: "javascript",
                      jsx: "javascript",
                      py: "python",
                      json: "json",
                      css: "css",
                      html: "xml",
                      sql: "sql",
                      md: "markdown",
                      yaml: "yaml",
                      yml: "yaml",
                      sh: "bash",
                      go: "go",
                    } as Record<string, string>
                  )[preview.path.split(".").pop() ?? ""]
                }
                initialLine={previewLine}
              />
              {preview.truncated ? (
                <p className="pane-note">
                  파일 미리보기 한도로 일부 내용만 읽었어요.
                </p>
              ) : null}
            </section>
          ) : null}
          {!workspace ? (
            <div className="pane-empty">
              <Icon name="folder" size={23} />
              <p>저장소를 열면 파일을 확인할 수 있어요.</p>
            </div>
          ) : null}
        </>
      )}
      {error ? (
        <div className="pane-error" role="alert">
          {error}
        </div>
      ) : null}
    </aside>
  );
}
