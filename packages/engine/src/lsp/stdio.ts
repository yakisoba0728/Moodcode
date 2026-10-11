import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { isAbsolute } from "node:path";
import {
  EngineError,
  type JsonObject,
  type JsonValue,
} from "@moodcode/contracts";
import { boundedJson } from "../artifacts/validation.js";
import { cleanupGroup } from "../shared/runtime.js";
export interface LspConnection {
  request(
    method: string,
    params: JsonValue,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<JsonValue>;
  notify(method: string, params: JsonValue): Promise<void>;
  onNotification(
    listener: (method: string, params: JsonValue) => void,
  ): () => void;
  close(): Promise<void>;
}
export interface StdioLspOptions {
  command: string;
  cwd: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}
const MAX = 1024 * 1024;
interface Pending {
  resolve(value: JsonValue): void;
  reject(error: EngineError): void;
  clean(): void;
}
/** Explicit host-configured executable, bounded Content-Length JSON-RPC, and owned process-group teardown. */
export class StdioLspConnection implements LspConnection {
  private pending = new Map<number, Pending>();
  private listeners = new Set<(method: string, params: JsonValue) => void>();
  private sequence = 0;
  private closed = false;
  private closePromise?: Promise<void>;
  private exited = false;
  private constructor(private child: ChildProcessWithoutNullStreams) {
    let bytes = Buffer.alloc(0);
    let expected: number | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      try {
        let cursor = 0;
        while (cursor < chunk.length) {
          const available =
            expected === undefined
              ? 4096 - bytes.length
              : expected - bytes.length;
          if (available <= 0)
            throw new EngineError(
              "LSP_FRAME_LIMIT",
              "LSP header or body exceeds its limit",
            );
          const take = Math.min(available, chunk.length - cursor);
          bytes = Buffer.concat([bytes, chunk.subarray(cursor, cursor + take)]);
          cursor += take;
          if (expected === undefined) {
            const end = bytes.indexOf("\r\n\r\n");
            if (end < 0) continue;
            const header = bytes.subarray(0, end);
            if (
              [...header].some(
                (b) => (b < 32 && b !== 13 && b !== 10) || b > 126,
              )
            )
              throw new EngineError(
                "INVALID_LSP_FRAME",
                "LSP header must be ASCII",
              );
            const fields = header.toString("ascii").split("\r\n");
            const lengths = fields.filter((f) => /^Content-Length:/i.test(f));
            if (
              lengths.length !== 1 ||
              !/^Content-Length:\s*[1-9][0-9]{0,6}\s*$/i.test(lengths[0]!)
            )
              throw new EngineError(
                "INVALID_LSP_FRAME",
                "LSP frame needs one bounded Content-Length",
              );
            expected = Number(lengths[0]!.split(":")[1]!.trim());
            if (expected > MAX)
              throw new EngineError(
                "LSP_FRAME_LIMIT",
                "LSP message exceeds 1 MiB",
              );
            const remainder = bytes.subarray(end + 4);
            bytes = Buffer.alloc(0);
            cursor -= remainder.length;
          }
          if (expected !== undefined && bytes.length === expected) {
            this.receive(bytes);
            bytes = Buffer.alloc(0);
            expected = undefined;
          }
        }
      } catch (error) {
        this.fail(
          error instanceof EngineError
            ? error
            : new EngineError(
                "INVALID_LSP_MESSAGE",
                "LSP server sent invalid JSON-RPC",
              ),
        );
      }
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () =>
      this.fail(new EngineError("LSP_DISCONNECTED", "LSP server input closed")),
    );
    child.once("error", () => {
      // A failed spawn has no owned PID to await; an error after spawn does.
      if (child.pid === undefined) this.exited = true;
      this.fail(
        new EngineError("LSP_START_FAILED", "LSP process could not start"),
      );
    });
    child.once("exit", () => {
      this.exited = true;
      this.fail(new EngineError("LSP_DISCONNECTED", "LSP process exited"));
    });
    child.stdout.once("end", () =>
      this.fail(new EngineError("LSP_DISCONNECTED", "LSP output closed")),
    );
  }
  static async open(options: StdioLspOptions): Promise<StdioLspConnection> {
    if (
      typeof options.command !== "string" ||
      !isAbsolute(options.command) ||
      options.command.includes("\0") ||
      !isAbsolute(options.cwd) ||
      (options.args &&
        (!Array.isArray(options.args) ||
          options.args.length > 64 ||
          options.args.some(
            (a) =>
              typeof a !== "string" ||
              Buffer.byteLength(a) > 8192 ||
              a.includes("\0"),
          )))
    )
      throw new EngineError(
        "INVALID_LSP_CONFIG",
        "LSP needs explicit absolute executable/cwd and bounded argv",
      );
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      ...(process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot }
        : {}),
    };
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ||
        typeof value !== "string" ||
        Buffer.byteLength(value) > 16_384 ||
        value.includes("\0")
      )
        throw new EngineError(
          "INVALID_LSP_CONFIG",
          "Explicit LSP environment is invalid",
        );
      env[key] = value;
    }
    const child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const connection = new StdioLspConnection(child);
    try {
      await once(child, "spawn");
      if (connection.closed) throw new Error();
      return connection;
    } catch {
      await connection.close();
      throw new EngineError("LSP_START_FAILED", "LSP process could not start");
    }
  }
  private send(value: JsonObject): Promise<void> {
    if (this.closed)
      return Promise.reject(
        new EngineError("LSP_DISCONNECTED", "LSP connection is closed"),
      );
    const content = Buffer.from(JSON.stringify(boundedJson(value, MAX)));
    if (content.length > MAX)
      throw new EngineError(
        "LSP_FRAME_LIMIT",
        "LSP outgoing message exceeds its byte limit",
      );
    return new Promise((resolve, reject) =>
      this.child.stdin.write(
        Buffer.concat([
          Buffer.from(`Content-Length: ${content.length}\r\n\r\n`),
          content,
        ]),
        (error) =>
          error
            ? reject(new EngineError("LSP_DISCONNECTED", "LSP write failed"))
            : resolve(),
      ),
    );
  }
  private receive(bytes: Buffer): void {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes))
      throw new EngineError("INVALID_LSP_MESSAGE", "LSP body must be UTF-8");
    let value = JSON.parse(text) as JsonValue;
    // The frame byte cap is fatal; a parsed message over the JSON shape caps fails only itself.
    let oversized = false;
    try {
      value = boundedJson(value, MAX);
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      oversized = true;
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.jsonrpc !== "2.0"
    )
      throw new EngineError(
        "INVALID_LSP_MESSAGE",
        "LSP needs one JSON-RPC object",
      );
    if ("method" in value) {
      if (typeof value.method !== "string" || value.method.length > 256)
        throw new EngineError("INVALID_LSP_MESSAGE", "Invalid LSP method");
      if ("id" in value) {
        if (typeof value.id !== "number" && typeof value.id !== "string")
          throw new EngineError(
            "INVALID_LSP_MESSAGE",
            "Invalid server request identity",
          );
        void this.send({
          jsonrpc: "2.0",
          id: value.id,
          error: { code: -32601, message: "Host capability unavailable" },
        }).catch(() => {});
        return;
      }
      if (oversized) return;
      for (const listener of this.listeners) {
        try {
          listener(value.method, value.params ?? null);
        } catch {}
      }
      return;
    }
    if (!Number.isSafeInteger(value.id))
      throw new EngineError(
        "INVALID_LSP_MESSAGE",
        "Invalid LSP response identity",
      );
    const pending = this.pending.get(value.id as number);
    if (!pending) return;
    if (Object.hasOwn(value, "result") === Object.hasOwn(value, "error"))
      throw new EngineError(
        "INVALID_LSP_MESSAGE",
        "LSP response needs exactly one result or error",
      );
    this.pending.delete(value.id as number);
    pending.clean();
    if (oversized)
      pending.reject(
        new EngineError(
          "LSP_FRAME_LIMIT",
          "LSP response exceeds its JSON shape limit",
        ),
      );
    else if ("error" in value)
      pending.reject(
        new EngineError(
          "LSP_RPC_ERROR",
          "Language server rejected the request",
        ),
      );
    else pending.resolve(value.result!);
  }
  request(
    method: string,
    params: JsonValue,
    signal: AbortSignal,
    timeoutMs = 5000,
  ): Promise<JsonValue> {
    if (this.closed || signal.aborted)
      return Promise.reject(
        new EngineError(
          signal.aborted ? "CANCELLED" : "LSP_DISCONNECTED",
          "LSP request unavailable",
        ),
      );
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60_000 ||
      this.pending.size >= 32
    )
      return Promise.reject(
        new EngineError(
          "LSP_REQUEST_LIMIT",
          "LSP request count or deadline exceeds its limit",
        ),
      );
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cancel = (error: EngineError) => {
        if (!this.pending.delete(id)) return;
        clean();
        void this.notify("$/cancelRequest", { id }).catch(() => {});
        reject(error);
      };
      const abort = () =>
        cancel(new EngineError("CANCELLED", "LSP request cancelled"));
      const timer = setTimeout(
        () =>
          cancel(
            new EngineError("LSP_TIMEOUT", "LSP request deadline exceeded"),
          ),
        timeoutMs,
      );
      const clean = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      this.pending.set(id, { resolve, reject, clean });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      try {
        void this.send({
          jsonrpc: "2.0",
          id,
          method,
          ...(method === "shutdown" ? {} : { params }),
        }).catch(() =>
          cancel(new EngineError("LSP_DISCONNECTED", "LSP dispatch failed")),
        );
      } catch (error) {
        cancel(
          error instanceof EngineError
            ? error
            : new EngineError(
                "LSP_FRAME_LIMIT",
                "LSP request could not be encoded",
              ),
        );
      }
    });
  }
  notify(method: string, params: JsonValue): Promise<void> {
    return this.send({
      jsonrpc: "2.0",
      method,
      ...(method === "exit" ? {} : { params }),
    });
  }
  onNotification(
    listener: (method: string, params: JsonValue) => void,
  ): () => void {
    if (this.listeners.size >= 16)
      throw new EngineError(
        "LSP_LISTENER_LIMIT",
        "LSP listener limit exceeded",
      );
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private fail(error: EngineError): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.clean();
      pending.reject(error);
    }
    this.pending.clear();
    this.listeners.clear();
    // Observe the background rejection while preserving the original close
    // promise so an explicit host close still receives cleanup uncertainty.
    void this.shutdown().catch(() => {});
  }
  close(): Promise<void> {
    this.fail(new EngineError("LSP_DISCONNECTED", "LSP connection closed"));
    return this.shutdown();
  }
  private shutdown(): Promise<void> {
    return (this.closePromise ??= (async () => {
      this.child.stdin.end();
      const wait = (ms: number) =>
        new Promise<void>((resolve) => {
          if (this.exited) {
            resolve();
            return;
          }
          const done = () => {
            clearTimeout(timer);
            this.child.removeListener("exit", done);
            resolve();
          };
          const timer = setTimeout(done, ms);
          this.child.once("exit", done);
        });
      const group = process.platform === "win32" ? undefined : this.child.pid;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (group) process.kill(-group, signal);
          else this.child.kill(signal);
        } catch {}
      };
      await wait(100);
      kill("SIGTERM");
      await wait(100);
      kill("SIGKILL");
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      this.child.stdin.destroy();
      await wait(100);
      // The leader's exit says nothing about descendants left in its group.
      const groupGone =
        !group || (await cleanupGroup(group).catch(() => false));
      if (!this.exited || !groupGone)
        throw new EngineError(
          "LSP_CLEANUP_UNCERTAIN",
          "Owned LSP process group did not confirm exit before its teardown deadline",
        );
    })());
  }
}
