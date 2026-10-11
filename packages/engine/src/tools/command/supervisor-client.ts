import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EngineError } from "@moodcode/contracts";
import { COMMAND_LIMITS, type CaptureOutput } from "./capture.js";
import type { CommandInput, PhysicalCommandScope } from "./index.js";
import {
  COMMAND_OBSERVATION_LIMITS,
  observationFailure,
  type CommandObservation,
  type CommandOutputStream,
} from "./observation.js";
import {
  cleanupGroup,
  createCommandEnvironment,
  errorText,
  notStartedOutcome,
  TERMINATION_LIMITS,
  type ProcessOutcome,
} from "./process-control.js";

export function supervisorExecArgv(): string[] {
  // Hosts may run the engine via node -e, --test or Electron: forward only module-loader options, resolved since the supervisor cwd differs.
  const result: string[] = [];
  const loaderOptions = [
    "--import",
    "--loader",
    "--experimental-loader",
    "--require",
    "-r",
    "--conditions",
  ];
  const resolveLoader = (option: string, value: string): string => {
    if (option === "--conditions") return value;
    const cjs = option === "--require" || option === "-r";
    if (value.startsWith(".") || isAbsolute(value)) {
      const path = resolve(process.cwd(), value);
      return cjs ? path : pathToFileURL(path).href;
    }
    return cjs
      ? createRequire(import.meta.url).resolve(value)
      : import.meta.resolve(value);
  };
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index]!;
    if (loaderOptions.includes(argument)) {
      const value = process.execArgv[++index];
      if (value !== undefined)
        result.push(argument, resolveLoader(argument, value));
    } else {
      const option = loaderOptions.find((option) =>
        argument.startsWith(`${option}=`),
      );
      if (option)
        result.push(
          `${option}=${resolveLoader(option, argument.slice(option.length + 1))}`,
        );
    }
  }
  result.push("--no-warnings");
  return result;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Runs one command under a forked POSIX supervisor that owns its process group. */
export async function runSupervised(
  input: CommandInput,
  context: PhysicalCommandScope,
  output: CaptureOutput,
  warnings: string[],
  observation?: CommandObservation,
): Promise<ProcessOutcome> {
  let execArgv: string[];
  try {
    execArgv = supervisorExecArgv();
  } catch {
    return notStartedOutcome(
      false,
      "Supervisor could not start: a host loader option could not be resolved.",
    );
  }
  const compiled = fileURLToPath(new URL("./supervisor.js", import.meta.url));
  const source = fileURLToPath(new URL("./supervisor.ts", import.meta.url));
  const child = fork(existsSync(compiled) ? compiled : source, [], {
    cwd: dirname(process.execPath),
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execPath: process.execPath,
    execArgv,
    env: { ...createCommandEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
  });
  let groupPid: number | undefined;
  let inputSequence = 0;
  let inputClosed = false;
  let pendingInput: { seq: number; yes: () => void; no: (error: unknown) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  const controlEpoch = randomUUID();
  let startSent = false;
  let ready = false;
  let closed = false;
  let outcome: ProcessOutcome | undefined;
  let failure: string | undefined;
  let resolveClosed!: () => void;
  let resolveFailure!: () => void;
  const closePromise = new Promise<void>((resolveClose) => {
    resolveClosed = resolveClose;
  });
  const failurePromise = new Promise<void>((resolveFail) => {
    resolveFailure = resolveFail;
  });
  const fail = (message: string): void => {
    failure ??= message;
    resolveFailure();
  };
  const send = (packet: object): void => {
    if (!child.connected) return;
    try {
      child.send(packet, (error) => {
        if (error) fail(`Supervisor IPC failed: ${error.message}`);
      });
    } catch (error) {
      fail(`Supervisor IPC failed: ${errorText(error)}`);
    }
  };
  const writeInput = (type: "stdin" | "eof", data: string): Promise<void> => {
    if (closed || !child.connected || context.signal.aborted || inputClosed || pendingInput || Buffer.byteLength(data) > 16384) return Promise.reject(new EngineError("COMMAND_STDIN_UNAVAILABLE", "Original stdin is closed, busy or exceeds its bound"));
    if (type === "eof") inputClosed = true;
    const seq = ++inputSequence;
    return new Promise<void>((yes, no) => {
      const timer = setTimeout(() => { if (pendingInput?.seq === seq) { pendingInput = undefined; no(new EngineError("COMMAND_STDIN_UNCERTAIN", "Physical stdin acknowledgement was not received")); send({type:"stop"}); } }, 2000);
      pendingInput = {seq,yes,no,timer};
      send({type,seq,data:Buffer.from(data).toString("base64")});
    });
  };
  const onAbort = (): void => send({ type: "stop" });
  const pendingOutput: { stream: CommandOutputStream; bytes: Buffer }[] = [];
  let pendingOutputBytes = 0;
  const observedOutput = (stream: CommandOutputStream, chunk: Buffer): void => {
    output.consume(stream, chunk);
    if (!observation || observation.failure) return;
    try {
      for (
        let at = 0;
        at < chunk.byteLength;
        at += COMMAND_OBSERVATION_LIMITS.outputHookBytes
      ) {
        const bytes = Buffer.from(
          chunk.subarray(at, at + COMMAND_OBSERVATION_LIMITS.outputHookBytes),
        );
        if (groupPid === undefined) {
          if (
            pendingOutputBytes + bytes.byteLength >
            COMMAND_OBSERVATION_LIMITS.preAdmissionBytes
          )
            throw new EngineError(
              "COMMAND_OBSERVATION_ADMISSION_MISSING",
              "Observed output exceeded its bounded queue before the actual process admission",
            );
          pendingOutput.push({ stream, bytes });
          pendingOutputBytes += bytes.byteLength;
        } else observation.observer.output(observation.original, stream, bytes);
      }
    } catch (error) {
      pendingOutput.length = 0;
      pendingOutputBytes = 0;
      observationFailure(observation, error);
      fail("Command output observation failed");
      send({ type: "stop" });
    }
  };
  child.stdout?.on("data", (chunk) => observedOutput("stdout", chunk));
  child.stderr?.on("data", (chunk) => observedOutput("stderr", chunk));
  child.stdout?.on("error", (error) =>
    fail(`Supervisor stdout failed: ${error.message}`),
  );
  child.stderr?.on("error", (error) =>
    fail(`Supervisor stderr failed: ${error.message}`),
  );
  child.on("error", (error) =>
    fail(`Supervisor could not start: ${error.message}`),
  );
  child.once("close", () => {
    closed = true;
    if (pendingInput) { clearTimeout(pendingInput.timer); pendingInput.no(new EngineError("COMMAND_STDIN_UNCERTAIN", "Supervisor closed before stdin acknowledgement")); pendingInput = undefined; }
    resolveClosed();
  });
  child.on("message", (packet: unknown) => {
    if (!object(packet)) return;
    if (packet.type === "input-result" && pendingInput && pendingInput.seq === packet.seq) {
      const pending = pendingInput; pendingInput = undefined; clearTimeout(pending.timer);
      packet.ok === true ? pending.yes() : pending.no(new EngineError("COMMAND_STDIN_UNAVAILABLE", "Original physical stdin write failed"));
    } else if (packet.type === "ready" && !ready) {
      ready = true;
      if (context.signal.aborted) onAbort();
      else {
        startSent = true;
        send({ type: "start" });
      }
    } else if (
      packet.type === "started" &&
      Number.isSafeInteger(packet.pid) &&
      Number(packet.pid) > 0
    ) {
      if (observation && groupPid !== undefined) {
        observationFailure(
          observation,
          new EngineError(
            "COMMAND_OBSERVATION_ADMISSION_CHANGED",
            "The original process group admission was repeated",
          ),
        );
        fail("Command process admission changed");
        send({ type: "stop" });
      } else {
        groupPid = Number(packet.pid);
        if (observation && !observation.failure)
          try {
            observation.observer.started(observation.original, groupPid);
            observation.observer.control?.(observation.original, Object.freeze({supervisorPid:child.pid!,groupPid,epoch:controlEpoch,write:(data: string)=>writeInput("stdin",data),end:()=>writeInput("eof",""),alive:()=>!closed && child.connected && !context.signal.aborted}));
            for (const entry of pendingOutput)
              observation.observer.output(
                observation.original,
                entry.stream,
                entry.bytes,
              );
          } catch (error) {
            observationFailure(observation, error);
            fail("Command process admission observation failed");
            send({ type: "stop" });
          }
      }
      pendingOutput.length = 0;
      pendingOutputBytes = 0;
    } else if (
      packet.type === "warning" &&
      typeof packet.warning === "string"
    ) {
      warnings.push(packet.warning);
    } else if (
      packet.type === "result" &&
      object(packet.outcome) &&
      typeof packet.outcome.cleanupConfirmed === "boolean"
    ) {
      outcome = packet.outcome as unknown as ProcessOutcome;
    }
  });
  context.signal.addEventListener("abort", onAbort, { once: true });
  send({
    type: "init",
    input: {...input,...(context.sandbox ? {sandbox:context.sandbox} : {})},
    interactive: Boolean(observation?.observer.control),
    ...(context.executionLockPath
      ? { executionLockPath: context.executionLockPath }
      : {}),
  });
  if (context.signal.aborted) onAbort();
  const startupTimer = setTimeout(() => {
    if (!ready && !outcome) fail("Supervisor readiness deadline expired.");
  }, COMMAND_LIMITS.supervisorStartupMs);
  const watchdog = setTimeout(
    () => fail("Supervisor execution or cleanup deadline expired."),
    COMMAND_LIMITS.supervisorStartupMs +
      input.timeoutMs +
      TERMINATION_LIMITS.termGraceMs +
      TERMINATION_LIMITS.killWaitMs +
      1_000,
  );
  const waitClosed = async (ms: number): Promise<boolean> => {
    if (closed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closePromise,
        new Promise<void>((resolveWait) => {
          timer = setTimeout(resolveWait, ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return closed;
  };
  try {
    await Promise.race([closePromise, failurePromise]);
    if (!closed) {
      send({ type: "stop" });
      child.kill("SIGTERM");
      if (
        !(await waitClosed(
          TERMINATION_LIMITS.termGraceMs + TERMINATION_LIMITS.killWaitMs + 250,
        ))
      ) {
        child.kill("SIGKILL");
        await waitClosed(250);
      }
    }
    if (!outcome) {
      let cleanupConfirmed = !startSent;
      if (groupPid !== undefined) {
        try {
          cleanupConfirmed = await cleanupGroup(groupPid);
        } catch (error) {
          failure ??= `Fallback process cleanup failed: ${errorText(error)}`;
        }
      }
      outcome = {
        exitCode: null,
        signal: null,
        cancelled: context.signal.aborted,
        timedOut: false,
        cleanupConfirmed,
        started: startSent,
        outputDiscarded: true,
        error:
          failure ?? "Supervisor exited without reporting command completion.",
      };
      warnings.push(
        "Supervisor completion was lost. A durable execution lock, when configured, remains blocked until cleanup uncertainty is reconciled.",
      );
    }
    if (!closed) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
    if (
      observation &&
      (pendingOutputBytes > 0 || (outcome.started && groupPid === undefined))
    )
      observationFailure(
        observation,
        new EngineError(
          "COMMAND_OBSERVATION_ADMISSION_MISSING",
          "The command closed without its original process group admission",
        ),
      );
    pendingOutput.length = 0;
    pendingOutputBytes = 0;
    output.recordArtifactFailure(outcome);
    if (failure) outcome.error ??= failure;
    return outcome;
  } finally {
    clearTimeout(startupTimer);
    clearTimeout(watchdog);
    context.signal.removeEventListener("abort", onAbort);
  }
}
