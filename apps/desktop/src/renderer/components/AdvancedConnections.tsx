import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JsonObject, JsonValue } from "@moodcode/contracts";
import { terminalCleanupLabel } from "../terminal-status.js";
import {
  number,
  object,
  rows,
  text,
  type AdvancedStore,
} from "../advanced-store.js";

export function TerminalPanel({
  value,
  capability,
  store,
  busy,
}: {
  value: JsonValue;
  capability: JsonValue;
  store: AdvancedStore;
  busy: boolean;
}) {
  const terminals = rows(value);
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const controls = useRef(
    new Map<string, { handleId: string; expiresAt: string }>(),
  );
  const [controlRevision, setControlRevision] = useState(0);
  useEffect(() => {
    const result = object(state.result),
      terminal = object(
        result.terminal ??
          (result.kind === "terminal.control" ? result.preview : null),
      );
    if (
      typeof result.handleId === "string" &&
      typeof terminal.id === "string"
    ) {
      controls.current.set(terminal.id, {
        handleId: result.handleId,
        expiresAt: text(result.expiresAt),
      });
      setSelected(terminal.id);
      setControlRevision((revision) => revision + 1);
      store.clearResult();
    }
  }, [state.result, store]);
  useEffect(
    () => () => {
      for (const { handleId } of controls.current.values())
        void store.query("handle.release", { handleId }).catch(() => {});
      controls.current.clear();
    },
    [store],
  );
  const [file, setFile] = useState(""),
    [args, setArgs] = useState(""),
    [selected, setSelected] = useState(""),
    [input, setInput] = useState("");
  const [output, setOutput] = useState(""),
    [gap, setGap] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [cols, setCols] = useState(100),
    [height, setHeight] = useState(28);
  const records = terminals.map((row) =>
    Object.keys(object(row.record)).length ? object(row.record) : row,
  );
  const terminalId = records.some((row) => row.id === selected)
    ? selected
    : text(records.at(-1)?.id);
  const record = records.find((row) => row.id === terminalId);
  const control = controls.current.get(terminalId);
  const handleId =
    control && Date.parse(control.expiresAt) > Date.now()
      ? control.handleId
      : undefined;
  void controlRevision;
  useEffect(() => {
    let alive = true,
      pending = false,
      afterSeq = 0;
    setOutput("");
    setGap(false);
    setError(null);
    const read = async () => {
      if (!terminalId || pending) return;
      pending = true;
      try {
        const result = object(
          await store.query("terminal.read", { terminalId, afterSeq }),
        );
        if (!alive) return;
        const chunks = rows(result.output);
        afterSeq = number(
          result.nextSeq,
          chunks.length ? number(chunks.at(-1)?.seq) : afterSeq,
        );
        if (result.gap === true) setGap(true);
        if (chunks.length)
          setOutput((previous) =>
            (previous + chunks.map((row) => text(row.data)).join("")).slice(
              -65536,
            ),
          );
      } catch (failure) {
        if (alive)
          setError(
            failure instanceof Error
              ? failure.message
              : "터미널 출력을 읽지 못했어요.",
          );
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [terminalId, store]);
  return (
    <section className="advanced-section">
      <h3>터미널</h3>
      <p className="field-help">
        새 프로세스의 실행 파일·인수를 먼저 검토하고 승인해요. 연결을 다시 열면
        저장된 출력부터 이어서 읽어요.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void store.action("terminal.preview", {
            ...(file.trim() ? { file: file.trim() } : {}),
            args: args.split("\n").filter(Boolean),
            cols,
            rows: height,
          });
        }}
      >
        <label className="field-label">
          실행 파일
          <input
            value={file}
            onChange={(event) => setFile(event.target.value)}
            placeholder="기본 셸"
          />
        </label>
        <label className="field-label">
          인수 · 한 줄에 하나
          <textarea
            value={args}
            onChange={(event) => setArgs(event.target.value)}
            rows={2}
          />
        </label>
        <button
          className="button secondary"
          disabled={busy || object(capability).available === false}
        >
          터미널 실행 검토
        </button>
        {object(capability).available === false ? (
          <p className="field-help">
            이 환경의 터미널 backend를 사용할 수 없어요.{" "}
            {text(object(capability).code)}
          </p>
        ) : null}
      </form>
      {records.length ? (
        <>
          <label className="field-label">
            터미널 선택
            <select
              value={terminalId}
              onChange={(event) => setSelected(event.target.value)}
            >
              {records.map((row) => (
                <option key={text(row.id)} value={text(row.id)}>
                  {text(row.file)} · {text(row.state)} ·{" "}
                  {text(row.id).slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <pre className="advanced-output" aria-label="터미널 출력">
            {output || "출력을 기다려요."}
          </pre>
          {gap ? (
            <p className="field-help">
              출력 보존 상한으로 오래된 일부 출력이 생략됐어요.
            </p>
          ) : null}
          <p className="field-help">
            상태 {text(record?.state)} · 종료 코드{" "}
            {record?.exitCode === null
              ? "미확정"
              : String(record?.exitCode ?? "미확정")}{" "}
            · cleanup{" "}
            {terminalCleanupLabel(record?.cleanupConfirmed)}
          </p>
          <div className="advanced-inline-form">
            <label>
              터미널 열
              <input
                aria-label="터미널 열"
                type="number"
                min={1}
                max={512}
                value={cols}
                onChange={(event) => setCols(event.target.valueAsNumber)}
              />
            </label>
            <label>
              터미널 행
              <input
                aria-label="터미널 행"
                type="number"
                min={1}
                max={256}
                value={height}
                onChange={(event) => setHeight(event.target.valueAsNumber)}
              />
            </label>
            <button
              type="button"
              className="text-button"
              disabled={
                busy ||
                !handleId ||
                record?.state !== "running" ||
                !Number.isInteger(cols) ||
                !Number.isInteger(height)
              }
              onClick={() =>
                void store.action("terminal.resize", {
                  handleId: handleId!,
                  cols,
                  rows: height,
                })
              }
            >
              터미널 크기 변경
            </button>
          </div>
          {!handleId && record?.state === "running" ? (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void store.action("terminal.attach", {
                  terminalId,
                  approved: true,
                })
              }
            >
              터미널 제어 다시 연결
            </button>
          ) : null}
          <form
            className="advanced-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              void store
                .action("terminal.write", {
                  handleId: handleId!,
                  data: input + "\n",
                })
                .then((result) => {
                  if (result !== null) setInput("");
                });
            }}
          >
            <input
              aria-label="터미널 입력"
              value={input}
              maxLength={8192}
              onChange={(event) => setInput(event.target.value)}
              disabled={record?.state !== "running" || !handleId}
            />
            <button
              className="button secondary"
              disabled={
                busy || record?.state !== "running" || !handleId || !input
              }
            >
              터미널에 전달
            </button>
            <button
              type="button"
              className="text-button"
              disabled={
                busy ||
                !handleId ||
                !["starting", "running"].includes(text(record?.state))
              }
              onClick={() =>
                void store.action("terminal.cancel", { handleId: handleId! })
              }
            >
              터미널 종료
            </button>
          </form>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="inline-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
export function McpPanel({
  value,
  store,
  busy,
}: {
  value: JsonValue;
  store: AdvancedStore;
  busy: boolean;
}) {
  const [id, setId] = useState(""),
    [file, setFile] = useState(""),
    [args, setArgs] = useState(""),
    [url, setUrl] = useState(""),
    [transport, setTransport] = useState("stdio");
  const connections = rows(value);
  return (
    <section className="advanced-section">
      <h3>MCP 연결과 도구</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void store.action("mcp.preview", {
            id: id.trim(),
            ...(transport === "stdio"
              ? {
                  transport: "stdio",
                  file: file.trim(),
                  args: args.split("\n").filter(Boolean),
                }
              : { transport: "http", url: url.trim() }),
          });
        }}
      >
        <label className="field-label">
          서버 이름
          <input
            value={id}
            maxLength={128}
            onChange={(event) => setId(event.target.value)}
          />
        </label>
        <label className="field-label">
          연결 방식
          <select
            value={transport}
            onChange={(event) => setTransport(event.target.value)}
          >
            <option value="stdio">로컬 프로세스</option>
            <option value="http">HTTP 서버</option>
          </select>
        </label>
        {transport === "stdio" ? (
          <>
            <label className="field-label">
              MCP 실행 파일
              <input
                value={file}
                onChange={(event) => setFile(event.target.value)}
              />
            </label>
            <label className="field-label">
              MCP 인수 · 한 줄에 하나
              <textarea
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                rows={2}
              />
            </label>
          </>
        ) : (
          <label className="field-label">
            MCP URL
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
        )}
        <button
          className="button secondary"
          disabled={
            busy ||
            !id.trim() ||
            (transport === "stdio" ? !file.trim() : !url.trim())
          }
        >
          MCP 연결 검토
        </button>
      </form>
      <ul className="advanced-list">
        {connections.map((connection) => (
          <li key={text(connection.id)}>
            <span>
              {text(connection.id)} ·{" "}
              {connection.connected === false ? "disconnected" : "connected"}
            </span>
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void store.action("mcp.disconnect", { id: connection.id! })
              }
            >
              연결 해제
            </button>
          </li>
        ))}
      </ul>
      <ul className="advanced-list">
        {connections.flatMap((connection) =>
          Array.isArray(connection.toolNames)
            ? connection.toolNames.map((name) => (
                <li key={`${text(connection.id)}:${text(name)}`}>
                  <strong>{text(name)}</strong>
                  <span>{text(connection.id)}</span>
                </li>
              ))
            : [],
        )}
      </ul>
      <p className="field-help">
        연결된 도구는 기존 도구 정책과 실행 승인 범위에서 모델이 사용해요.
      </p>
    </section>
  );
}
export function LspPanel({
  value,
  store,
  busy,
  onOpenFile,
}: {
  value: JsonValue;
  store: AdvancedStore;
  busy: boolean;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const [id, setId] = useState(""),
    [file, setFile] = useState(""),
    [args, setArgs] = useState(""),
    [extensions, setExtensions] = useState(".ts,.tsx"),
    [path, setPath] = useState("");
  const [diagnostics, setDiagnostics] = useState<JsonValue | null>(null);
  const [observedPath, setObservedPath] = useState("");
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  useEffect(() => {
    if (!observedPath) return;
    let alive = true,
      pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await store.query("lsp.diagnostics", {
          path: observedPath,
        });
        if (alive && result !== null) {
          setDiagnostics(result);
          setDiagnosticError(null);
        }
      } catch (error) {
        if (alive)
          setDiagnosticError(
            error instanceof Error
              ? error.message
              : "파일 진단을 새로 읽지 못했어요.",
          );
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [observedPath, store]);
  const read = async () => {
    const result = await store.action("lsp.diagnostics", { path: path.trim() });
    if (result !== null) {
      setDiagnostics(result);
      setObservedPath(path.trim());
    }
  };
  return (
    <section className="advanced-section">
      <h3>언어 서버와 진단</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void store.action("lsp.preview", {
            id: id.trim(),
            file: file.trim(),
            args: args.split("\n").filter(Boolean),
            extensions: Object.fromEntries(
              extensions
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean)
                .map((extension) => [
                  extension,
                  extension === ".tsx"
                    ? "typescriptreact"
                    : extension === ".ts"
                      ? "typescript"
                      : extension === ".js"
                        ? "javascript"
                        : extension === ".jsx"
                          ? "javascriptreact"
                          : extension.slice(1),
                ]),
            ),
          });
        }}
      >
        <label className="field-label">
          언어 서버 이름
          <input value={id} onChange={(event) => setId(event.target.value)} />
        </label>
        <label className="field-label">
          언어 서버 실행 파일
          <input
            value={file}
            onChange={(event) => setFile(event.target.value)}
          />
        </label>
        <label className="field-label">
          언어 서버 인수 · 한 줄에 하나
          <textarea
            value={args}
            onChange={(event) => setArgs(event.target.value)}
            rows={2}
          />
        </label>
        <label className="field-label">
          확장자
          <input
            value={extensions}
            onChange={(event) => setExtensions(event.target.value)}
          />
        </label>
        <button
          className="button secondary"
          disabled={busy || !id.trim() || !file.trim()}
        >
          언어 서버 연결 검토
        </button>
      </form>
      <ul className="advanced-list">
        {rows(value).map((connection) => (
          <li key={text(connection.id)}>
            {text(connection.id)} ·{" "}
            {connection.connected === false ? "disconnected" : "connected"}
          </li>
        ))}
      </ul>
      <form
        className="advanced-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void read();
        }}
      >
        <input
          aria-label="진단 파일 경로"
          value={path}
          placeholder="src/example.ts"
          onChange={(event) => setPath(event.target.value)}
        />
        <button className="button secondary" disabled={busy || !path.trim()}>
          파일 진단 읽기
        </button>
      </form>
      <DiagnosticList
        value={diagnostics ?? []}
        onOpenFile={onOpenFile}
        defaultPath={observedPath}
      />
      {diagnosticError ? (
        <p className="inline-error" role="alert">
          {diagnosticError}
        </p>
      ) : null}
    </section>
  );
}
function DiagnosticList({
  value,
  onOpenFile,
  defaultPath,
}: {
  value: JsonValue;
  onOpenFile: (path: string, line?: number) => void;
  defaultPath: string;
}) {
  const data = object(value),
    sources = Array.isArray(value) ? rows(value) : [data];
  const items = sources.flatMap((source) =>
    source.snapshot
      ? rows(object(source.snapshot).diagnostics).map((item) => ({
          ...item,
          path: object(source.snapshot).path ?? defaultPath,
        }))
      : source.message
        ? [source]
        : rows(source.diagnostics ?? source.items),
  );
  return (
    <ul className="advanced-list">
      {items.map((item, index) => (
        <li key={index}>
          <button
            className="text-button"
            onClick={() =>
              onOpenFile(
                text(item.path ?? item.uri, defaultPath),
                number(object(object(item.range).start).line) + 1,
              )
            }
          >
            {text(item.message)} · 줄{" "}
            {number(object(object(item.range).start).line) + 1}
          </button>
        </li>
      ))}
    </ul>
  );
}
