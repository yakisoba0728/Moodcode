import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { cleanupGroup, groupExists } from "../tools/command/process-control.js";
import {
  assertCodeModeRuntime,
  type CodeModeRuntimeSource,
} from "./runtime.js";
import { codeJson, codeModeError, codeSign } from "./types.js";
/** Runs fn once on abort, at once when already aborted; returns the listener's disposer. */
function onAbort(signal: AbortSignal, fn: () => void): () => void {
  signal.addEventListener("abort", fn, { once: true });
  if (signal.aborted) fn();
  return () => signal.removeEventListener("abort", fn);
}
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
  private stdoutFinished = false;
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
    this.child = fork(this.source.supervisor.file, [], {
      execArgv: this.source.supervisor.execArgv,
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
    const fatal = (error: unknown) => {
      failed(error);
      void this.stop();
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
        fatal(error);
      }
    });
    const finishStdout = () => {
      if (this.stdoutFinished) return;
      try {
        if (this.error !== undefined) return;
        this.text += this.decoder.decode();
        if (this.text.length) codeModeError("CODE_MODE_PROTOCOL_INVALID");
      } catch (error) {
        fatal(error);
      } finally {
        this.stdoutFinished = true;
        this.wake?.();
      }
    };
    child.stdout?.once("end", finishStdout);
    child.stdout?.once("error", fatal);
    // IPC cleanup and process exit can precede delivery of the final stdout frame.
    // Child close is the fallback only after its actual stdio streams have closed.
    child.once("close", finishStdout);
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
    const disposeAbort = onAbort(signal, () => void this.stop());
    const timer = setTimeout(
      () => this.readyReject(new Error("CODE_MODE_PROCESS_TIMEOUT")),
      5000,
    );
    try {
      await this.readyPromise;
      this.assertDispatch();
      assertCodeModeRuntime(this.source);
      return codeJson(this.proof!);
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      clearTimeout(timer);
      disposeAbort();
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
    const fail = (error: unknown) => {
      this.pending.get(id)?.reject(error);
      this.pending.delete(id);
    };
    const timer = setTimeout(
      () => fail(new Error("CODE_MODE_WRITE_TIMEOUT")),
      5000,
    );
    const disposeAbort = onAbort(signal, () => fail(signal.reason));
    try {
      await promise;
    } finally {
      disposeAbort();
      clearTimeout(timer);
    }
  }
  async next(signal: AbortSignal): Promise<Record<string, any>> {
    while (true) {
      if (signal.aborted) throw signal.reason;
      if (this.error) throw this.error;
      const message = this.messages.shift();
      if (message) return codeJson(message);
      if (this.stdoutFinished) codeModeError("CODE_MODE_EOF");
      await new Promise<void>((resolve, reject) => {
        this.wake = () => {
          disposeAbort();
          this.wake = undefined;
          resolve();
        };
        const disposeAbort = onAbort(signal, () => {
          this.wake = undefined;
          reject(signal.reason);
        });
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
