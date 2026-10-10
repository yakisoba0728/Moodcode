import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { access, constants } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EngineError } from "@moodcode/contracts";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  cleanupGroup,
  createCommandEnvironment,
} from "../tools/command/process-control.js";
import {
  TERMINAL_LIMITS,
  type PtyBackend,
  type PtyCapability,
  type PtyOutcome,
  type PtyProcess,
  type PtySpawnInput,
  type PtyDiagnostics,
  type PtyDiagnosticEvent,
} from "./types.js";
import {
  PtyDiagnosticRecorder,
  ptyDiagnosticErrorCode,
  validatePtyDiagnostics,
  validatePtyOutcome,
} from "./diagnostics.js";

function loaderArgs(): string[] {
  if (import.meta.url.endsWith(".ts")) return ["--import", "tsx"];
  return [];
}
const startupOutcomes = new WeakMap<Error, PtyOutcome>();
/** Engine-internal: the settled outcome behind a post-fork startup rejection. */
export function startupFailureOutcome(error: unknown): PtyOutcome | undefined {
  return error instanceof Error ? startupOutcomes.get(error) : undefined;
}
export class PosixPtyBackend implements PtyBackend {
  async capability(): Promise<PtyCapability> {
    const base = {
      platform: process.platform,
      isolation: "host-user" as const,
    };
    if (!["darwin", "linux", "freebsd"].includes(process.platform))
      return {
        ...base,
        available: false,
        backend: "unavailable",
        processTree: "unsupported",
        code: "PTY_PLATFORM_UNSUPPORTED",
      };
    try {
      createRequire(import.meta.url).resolve("node-pty");
    } catch {
      return {
        ...base,
        available: false,
        backend: "unavailable",
        processTree: "posix-group",
        code: "PTY_DEPENDENCY_UNAVAILABLE",
      };
    }
    try {
      await import("node-pty");
      if (process.platform === "darwin") {
        const directory = dirname(
          createRequire(import.meta.url).resolve("node-pty/package.json"),
        );
        try {
          await access(
            join(
              directory,
              "prebuilds",
              `${process.platform}-${process.arch}`,
              "spawn-helper",
            ),
            constants.X_OK,
          );
        } catch {
          await access(
            join(directory, "build", "Release", "spawn-helper"),
            constants.X_OK,
          );
        }
      }
    } catch {
      return {
        ...base,
        available: false,
        backend: "unavailable",
        processTree: "posix-group",
        code: "PTY_NATIVE_UNAVAILABLE",
      };
    }
    return {
      ...base,
      available: true,
      backend: "posix-pty-supervisor",
      processTree: "posix-group",
    };
  }

  async spawn(
    input: PtySpawnInput,
    output: (data: string) => void,
  ): Promise<PtyProcess> {
    if (!(await this.capability()).available)
      throw new EngineError(
        "PTY_UNAVAILABLE",
        "The host has no supported PTY backend",
      );
    const source = import.meta.url.endsWith(".ts");
    const file = fileURLToPath(
      new URL(`./supervisor.${source ? "ts" : "js"}`, import.meta.url),
    );
    const child = fork(file, [], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore", "ipc"],
      execArgv: loaderArgs(),
      env: { ...createCommandEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
    });
    let pid: number | undefined,
      result: PtyOutcome | undefined,
      settled = false;
    let observedDiagnostics: PtyDiagnostics | undefined;
    const backendEvents: Omit<PtyDiagnosticEvent, "seq">[] = [];
    let backendExited = false,
      backendClosed = false,
      transportDisconnected = false,
      stdoutEnded = false;
    let backendExitCode: number | null = null,
      backendExitSignal: NodeJS.Signals | null = null;
    let missingResultCheck: ReturnType<typeof setImmediate> | undefined;
    let lossSettlement: Promise<void> | undefined;
    const receiveDiagnostics = (value: unknown): boolean => {
      try {
        const data = validatePtyDiagnostics(value);
        if (
          data.source.platform !== process.platform ||
          data.source.supervisorPid !== (child.pid ?? null) ||
          data.source.terminalPid !== (pid ?? null)
        )
          throw failure("PTY_DIAGNOSTICS_INVALID");
        observedDiagnostics = data;
        return true;
      } catch {
        if (backendEvents.length < 8)
          backendEvents.push({
            kind: "invalid-diagnostics",
            errorCode: "PTY_DIAGNOSTICS_INVALID",
          });
        return false;
      }
    };
    let resolveStarted!: () => void,
      rejectStarted!: (error: Error) => void,
      resolveClosed!: (outcome: PtyOutcome) => void;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const closed = new Promise<PtyOutcome>((resolve) => {
      resolveClosed = resolve;
    });
    let requestId = 0;
    const pending = new Map<
      number,
      {
        resolve(): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const failure = (code: string) =>
      new EngineError(
        code,
        "The terminal backend could not complete the operation",
      );
    const settle = (outcome: PtyOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(startup);
      if (missingResultCheck) clearImmediate(missingResultCheck);
      child.removeListener("exit", observedExit);
      child.removeListener("disconnect", observedDisconnect);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(failure("TERMINAL_CLOSED"));
      }
      pending.clear();
      if (pid === undefined)
        rejectStarted(
          failure(
            outcome.reason === "pty_unavailable"
              ? "PTY_UNAVAILABLE"
              : "PTY_START_FAILED",
          ),
        );
      const recorder = new PtyDiagnosticRecorder(
        process.platform,
        child.pid ?? null,
        observedDiagnostics,
      );
      if (pid !== undefined && !observedDiagnostics) recorder.started(pid);
      if (
        backendEvents.some((event) => event.kind === "supervisor-lost") ||
        outcome.reason === "supervisor_cleanup_timeout"
      )
        recorder.groupSnapshot(undefined, "backend-fallback");
      for (const event of backendEvents) recorder.note(event);
      if (backendExited || backendClosed)
        recorder.supervisorExit(
          backendExitCode,
          backendExitSignal,
          backendClosed,
        );
      resolveClosed({ ...outcome, diagnostics: recorder.snapshot(outcome) });
    };
    const send = (packet: object): void => {
      if (!child.connected) throw failure("TERMINAL_CLOSED");
      child.send(packet, (error) => {
        if (error) child.disconnect();
      });
    };
    const decoder = new StringDecoder("utf8");
    const settleLost = (): Promise<void> =>
      (lossSettlement ??= (async () => {
        backendEvents.push({
          kind: "supervisor-lost",
          ...(pid !== undefined ? { pid } : {}),
        });
        if (pid !== undefined) {
          const confirmed = await cleanupGroup(pid).catch(() => false);
          backendEvents.push({
            kind: "group-cleanup",
            groupPid: pid,
            confirmed,
          });
        }
        // Exit/EOF cannot reconstruct separate native PTY job-control groups.
        settle({
          exitCode: null,
          cancelled: false,
          timedOut: false,
          cleanupConfirmed: false,
          reason: "supervisor_lost",
        });
      })());
    const checkDisconnectedExit = (): void => {
      if (
        settled ||
        result ||
        missingResultCheck ||
        !backendExited ||
        !transportDisconnected ||
        !stdoutEnded
      )
        return;
      // Give already queued original IPC frames a turn to drain. This is an
      // observed transport boundary, not a delay or a favorable cleanup probe.
      missingResultCheck = setImmediate(() => {
        missingResultCheck = undefined;
        if (
          !settled &&
          !result &&
          backendExited &&
          transportDisconnected &&
          stdoutEnded
        )
          void settleLost();
      });
    };
    const observedExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      backendExited = true;
      backendExitCode = code;
      backendExitSignal = signal;
      checkDisconnectedExit();
    };
    const observedDisconnect = (): void => {
      transportDisconnected = true;
      checkDisconnectedExit();
    };
    child.once("exit", observedExit);
    child.once("disconnect", observedDisconnect);
    child.stdout!.on("data", (chunk: Buffer) => {
      try {
        const data = decoder.write(chunk);
        if (data) output(data);
      } catch {
        try {
          send({ type: "stop" });
        } catch {
          /* Disconnect closes the supervisor. */
        }
      }
    });
    child.stdout!.once("end", () => {
      stdoutEnded = true;
      const rest = decoder.end();
      if (rest)
        try {
          output(rest);
        } catch {
          /* Closed PTY has no later output. */
        }
      checkDisconnectedExit();
    });
    child.on("message", (message: unknown) => {
      if (settled || !message || typeof message !== "object") return;
      const packet = message as {
        type?: string;
        pid?: number;
        id?: number;
        code?: string;
        outcome?: PtyOutcome;
        diagnostics?: unknown;
      };
      if (packet.type === "ready")
        try {
          send({ type: "start", input });
        } catch {
          /* close fallback observes the startup failure. */
        }
      if (
        packet.type === "started" &&
        Number.isSafeInteger(packet.pid) &&
        packet.pid! > 0
      ) {
        pid = packet.pid;
        clearTimeout(startup);
        resolveStarted();
      }
      if (packet.type === "diagnostics") receiveDiagnostics(packet.diagnostics);
      if (packet.type === "result" && packet.outcome) {
        try {
          const checked = validatePtyOutcome(packet.outcome);
          if (
            checked.diagnostics !== undefined &&
            !receiveDiagnostics(checked.diagnostics)
          )
            return;
          result = checked;
        } catch {
          if (backendEvents.length < 8)
            backendEvents.push({
              kind: "invalid-diagnostics",
              errorCode: "PTY_DIAGNOSTICS_INVALID",
            });
        }
      }
      if (packet.type === "ack" && packet.id !== undefined) {
        const request = pending.get(packet.id);
        if (!request) return;
        pending.delete(packet.id);
        clearTimeout(request.timer);
        if (packet.code) request.reject(failure(packet.code));
        else request.resolve();
      }
    });
    child.once("error", (error) => {
      backendEvents.push({
        kind: "error",
        errorCode: ptyDiagnosticErrorCode(error),
      });
      settle({
        exitCode: null,
        cancelled: false,
        timedOut: false,
        cleanupConfirmed: child.pid === undefined,
        reason: "supervisor_failed",
      });
    });
    child.once("close", (code, signal) => {
      backendClosed = true;
      backendExitCode = code;
      backendExitSignal = signal;
      if (result) {
        settle(result);
        return;
      }
      void settleLost();
    });
    const startup = setTimeout(() => {
      rejectStarted(failure("PTY_START_TIMEOUT"));
      if (child.connected) child.disconnect();
      const escalation = setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout?.destroy();
        child.unref();
        settle({
          exitCode: null,
          cancelled: false,
          timedOut: false,
          cleanupConfirmed: false,
          reason: "startup_cleanup_uncertain",
        });
      }, TERMINAL_LIMITS.cleanupMs);
      void closed.then(() => clearTimeout(escalation));
    }, TERMINAL_LIMITS.startupMs);
    try {
      await started;
    } catch (error) {
      if (child.connected) child.disconnect();
      startupOutcomes.set(error as Error, await closed);
      throw error;
    }
    const request = (packet: object): Promise<void> => {
      if (settled) return Promise.reject(failure("TERMINAL_CLOSED"));
      if (pending.size >= TERMINAL_LIMITS.maxPendingWrites)
        return Promise.reject(failure("TERMINAL_BACKPRESSURE"));
      const id = ++requestId;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(failure("TERMINAL_IO_TIMEOUT"));
          if (child.connected) child.disconnect();
        }, TERMINAL_LIMITS.cleanupMs);
        pending.set(id, { resolve, reject, timer });
        try {
          send({ ...packet, id });
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    };
    let cancelling: Promise<PtyOutcome> | undefined;
    const cancel = (): Promise<PtyOutcome> => {
      if (cancelling) return cancelling;
      cancelling = (async () => {
        if (settled) return closed;
        try {
          send({ type: "stop" });
        } catch {
          /* Fallback observes and cleans the group. */
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const observed = await Promise.race([
          closed,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), TERMINAL_LIMITS.cleanupMs);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (observed) return observed;
        const confirmed = await cleanupGroup(pid!).catch(() => false);
        backendEvents.push({
          kind: "group-cleanup",
          groupPid: pid!,
          confirmed,
        });
        child.kill("SIGKILL");
        child.stdout?.destroy();
        child.unref();
        const outcome = {
          exitCode: null,
          cancelled: true,
          timedOut: false,
          cleanupConfirmed: false,
          reason: "supervisor_cleanup_timeout",
        };
        settle(outcome);
        return outcome;
      })();
      return cancelling;
    };
    return {
      pid: pid!,
      closed,
      write: (data) => request({ type: "write", data }),
      resize: (cols, rows) => request({ type: "resize", cols, rows }),
      cancel,
    };
  }
}
