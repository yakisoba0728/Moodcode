import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { cleanupGroup, groupExists } from "../tools/command/process-control.js";
import {
  assertCodeModeRuntime,
  type CodeModeRuntimeSource,
} from "./runtime.js";
import { codeJson, codeModeError, codeSign } from "./types.js";
export interface CodeModeProcessProof {
  version: 1;
  generation: string;
  birthNonce: string;
  processId: number;
  runtimeSha256: string;
  sha256: string;
}
export interface CodeModeProcessOutcome {
  version: 1;
  generation: string;
  birthNonce: string;
  processId: number;
  cleanupConfirmed: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sha256: string;
}
/** Root-owned supervisor and original physical process. The program never receives its host context. */
export class OwnedCodeModeProcess {
  private child: ChildProcess | undefined;
  private proof: CodeModeProcessProof | undefined;
  private result: CodeModeProcessOutcome | undefined;
  private closing: Promise<CodeModeProcessOutcome> | undefined;
  private ready!: () => void;
  private readyReject!: (error: unknown) => void;
  private exited!: () => void;
  private closed!: () => void;
  private closeObserved = false;
  private joined = false;
  private readonly readyPromise = new Promise<void>((resolve, reject) => {
    this.ready = resolve;
    this.readyReject = reject;
  });
  private readonly exitPromise = new Promise<void>(
    (resolve) => (this.exited = resolve),
  );
  private readonly closedPromise = new Promise<void>(
    (resolve) => (this.closed = resolve),
  );
  private readonly messages: Record<string, any>[] = [];
  private wake: (() => void) | undefined;
  private error: unknown;
  private bytes = 0;
  private frames = 0;
  private text = "";
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private writes = 0;
  private readonly pending = new Map<
    number,
    { resolve: () => void; reject: (error: unknown) => void; bytes: number }
  >();
  constructor(
    private readonly source: CodeModeRuntimeSource,
    readonly generation: string,
    private readonly assertDispatch: () => void,
  ) {}
  async start(signal: AbortSignal): Promise<CodeModeProcessProof> {
    if (this.child || signal.aborted) codeModeError("CODE_MODE_OWNER_STALE");
    this.assertDispatch();
    assertCodeModeRuntime(this.source);
    const compiled = new URL("./supervisor.js", import.meta.url),
      source = new URL("./supervisor.ts", import.meta.url);
    this.child = fork(existsSync(compiled) ? compiled : source, [], {
      execArgv: existsSync(compiled)
        ? []
        : ["--import", fileURLToPath(import.meta.resolve("tsx"))],
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const child = this.child,
      birthNonce = randomUUID();
    let stderr = "";
    const failed = (error: unknown) => {
      this.error = error;
      this.readyReject(error);
      for (const write of this.pending.values()) write.reject(error);
      this.pending.clear();
      this.wake?.();
    };
    child.stderr?.on("data", (bytes: Buffer) => {
      stderr = (stderr + bytes.toString()).slice(-4096);
    });
    child.stdout?.on("data", (bytes: Buffer) => {
      try {
        this.bytes += bytes.length;
        if (this.bytes > 2097152) codeModeError("CODE_MODE_PROTOCOL_LIMIT");
        this.text += this.decoder.decode(bytes, { stream: true });
        if (Buffer.byteLength(this.text) > 65536)
          codeModeError("CODE_MODE_PROTOCOL_LIMIT");
        let at;
        while ((at = this.text.indexOf("\n")) >= 0) {
          const line = this.text.slice(0, at);
          this.text = this.text.slice(at + 1);
          if (++this.frames > 64 || Buffer.byteLength(line) > 65536)
            codeModeError("CODE_MODE_PROTOCOL_LIMIT");
          const value = codeJson(JSON.parse(line));
          if (!value || typeof value !== "object" || Array.isArray(value))
            codeModeError();
          this.messages.push(value);
          this.wake?.();
        }
      } catch (error) {
        failed(error);
        void this.stop();
      }
    });
    child.on("message", (packet: unknown) => {
      const value = packet as Record<string, any>;
      if (value?.type === "started") {
        if (this.proof || !Number.isSafeInteger(value.pid) || value.pid < 1) {
          failed(new Error("CODE_MODE_PROCESS_INVALID"));
          return;
        }
        this.proof = codeSign({
          version: 1 as const,
          generation: this.generation,
          birthNonce,
          processId: value.pid,
          runtimeSha256: this.source.capability.sha256,
        });
        this.ready();
      } else if (value?.type === "closed") {
        this.closeObserved = true;
        if (this.proof)
          this.result = codeSign({
            version: 1 as const,
            generation: this.generation,
            birthNonce,
            processId: this.proof.processId,
            cleanupConfirmed:
              value.cleanupConfirmed === true &&
              !groupExists(this.proof.processId),
            exitCode: value.exitCode ?? null,
            signal: value.signal ?? null,
          });
        this.closed();
        this.wake?.();
      } else if (value?.type === "written") {
        const write = this.pending.get(value.id);
        this.pending.delete(value.id);
        if (write) {
          if (value.bytes !== write.bytes) {
            write.reject(new Error("CODE_MODE_WRITE_INVALID"));
            failed(new Error("CODE_MODE_WRITE_INVALID"));
          } else write.resolve();
        }
      } else if (value?.type === "failed")
        failed(new Error("CODE_MODE_PROCESS_FAILED"));
    });
    child.once("error", (error) => {
      failed(error);
      this.exited();
      this.closed();
    });
    child.once("exit", () => {
      this.exited();
      this.closed();
      this.wake?.();
      if (!this.proof) failed(new Error("CODE_MODE_PROCESS_FAILED " + stderr));
    });
    child.send({
      type: "init",
      command: this.source.sandbox.path,
      args: [
        "-p",
        this.source.profile,
        this.source.node.path,
        "--max-old-space-size=64",
        this.source.worker.path,
        "--run",
      ],
      cwd: "/",
    });
    const abort = () => {
      void this.stop();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("CODE_MODE_PROCESS_TIMEOUT")),
            5000,
          );
          void this.readyPromise
            .finally(() => clearTimeout(timer))
            .catch(() => {});
        }),
      ]);
      this.assertDispatch();
      assertCodeModeRuntime(this.source);
      return codeJson(this.proof!);
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  readProof(): CodeModeProcessProof {
    if (!this.proof) codeModeError("CODE_MODE_PROCESS_INVALID");
    return codeJson(this.proof);
  }
  async write(packet: object, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.closing || !this.child?.connected)
      codeModeError("CODE_MODE_OWNER_STALE");
    this.assertDispatch();
    const text = JSON.stringify(codeJson(packet)) + "\n";
    if (Buffer.byteLength(text) > 65536)
      codeModeError("CODE_MODE_PROTOCOL_LIMIT");
    const id = ++this.writes;
    const promise = new Promise<void>((resolve, reject) =>
      this.pending.set(id, { resolve, reject, bytes: Buffer.byteLength(text) }),
    );
    this.child.send({ type: "write", id, text });
    const abort = () => {
      this.pending.get(id)?.reject(signal.reason);
      this.pending.delete(id);
    };
    const timer = setTimeout(() => {
      this.pending.get(id)?.reject(new Error("CODE_MODE_WRITE_TIMEOUT"));
      this.pending.delete(id);
    }, 5000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      await promise;
    } finally {
      signal.removeEventListener("abort", abort);
      clearTimeout(timer);
    }
  }
  async next(signal: AbortSignal): Promise<Record<string, any>> {
    while (true) {
      if (signal.aborted) throw signal.reason;
      if (this.error) throw this.error;
      const message = this.messages.shift();
      if (message) return codeJson(message);
      if (
        this.closeObserved ||
        this.child?.exitCode !== null ||
        this.child?.signalCode !== null
      )
        codeModeError("CODE_MODE_EOF");
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          this.wake = undefined;
          reject(signal.reason);
        };
        this.wake = () => {
          signal.removeEventListener("abort", abort);
          this.wake = undefined;
          resolve();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  readOutcome(): CodeModeProcessOutcome {
    if (!this.joined || !this.result)
      codeModeError("CODE_MODE_PROCESS_INVALID");
    return codeJson(this.result);
  }
  stop(): Promise<CodeModeProcessOutcome> {
    return (this.closing ??= (async () => {
      for (const write of this.pending.values())
        write.reject(new Error("CODE_MODE_PROCESS_CLOSED"));
      this.pending.clear();
      if (!this.child) codeModeError("CODE_MODE_PROCESS_INVALID");
      if (this.child?.connected)
        try {
          this.child.send({ type: "stop" });
        } catch {}
      const timer = setTimeout(() => this.child?.kill("SIGKILL"), 4000);
      await this.closedPromise;
      clearTimeout(timer);
      if (!this.result && this.proof) {
        await cleanupGroup(this.proof.processId).catch(() => false);
        this.result = codeSign({
          version: 1 as const,
          generation: this.generation,
          birthNonce: this.proof.birthNonce,
          processId: this.proof.processId,
          cleanupConfirmed: false,
          exitCode: null,
          signal: null,
        });
      }
      await this.exitPromise;
      this.joined = true;
      if (!this.result) codeModeError("CODE_MODE_PROCESS_INVALID");
      return codeJson(this.result);
    })());
  }
}
