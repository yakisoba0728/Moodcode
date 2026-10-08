import { createHash, randomUUID, type Hash } from "node:crypto";
import { fork } from "node:child_process";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import {
  EngineError,
  type Checkpoint,
  type JsonObject,
  type Workspace,
} from "@moodcode/contracts";
import type {
  PreparedTool,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../../ports.js";
import {
  captureWorkspace,
  resolveWorkspacePath,
} from "../../workspace/index.js";
import {
  cleanupGroup,
  createCommandEnvironment,
  type ProcessOutcome,
} from "./process-control.js";
import {
  COMMAND_OBSERVATION_LIMITS,
  validateCommandArtifactDescriptor,
  type CommandArtifactDescriptor,
  type CommandExecutionObserver,
  type CommandOutputStream,
} from "./observation.js";

/** Capture and artifact budgets are shared by stdout and stderr. */
export const COMMAND_LIMITS = Object.freeze({
  maxCommandBytes: 16_384,
  maxTimeoutMs: 300_000,
  captureBytes: 262_144,
  modelBytes: 65_536,
  artifactBytes: 1_048_576,
  termGraceMs: 250,
  killWaitMs: 2_000,
  pollMs: 20,
  checkpointTimeoutMs: 2_000,
  supervisorStartupMs: 5_000,
});

export interface CommandInput {
  command: string;
  cwd: string;
  timeoutMs: number;
}
interface Capture {
  totalBytes: number;
  capturedBytes: number;
  buffers: Buffer[];
  artifactBytes: number;
  fd: number;
  path: string;
  hash: Hash;
  device: string;
  inode: string;
  closedStat?: { size: number; mtimeNs: string };
  sealFailed?: boolean;
}
interface Observation {
  readonly observer: Pick<
    CommandExecutionObserver,
    "started" | "output" | "failed"
  >;
  readonly original: object;
  failure?: string;
}
function observationFailure(observation: Observation, error: unknown): void {
  if (observation.failure) return;
  observation.failure = "Command execution observation failed after admission";
  try {
    observation.observer.failed?.(observation.original, error);
  } catch {
    /* The original observation uncertainty remains authoritative. */
  }
}
interface OutputData {
  text: string;
  totalBytes: number;
  observedBytes: number;
  capturedBytes: number;
  captureTruncatedBytes: number;
  modelBytes: number;
  modelSourceBytes: number;
  modelTruncatedBytes: number;
  artifactBytes: number;
  artifactTruncatedBytes: number;
}
type WorkspaceCapture = Awaited<ReturnType<typeof captureWorkspace>>;

const ATTRIBUTION_WARNING =
  "Checkpoint differences are observations; concurrent external edits cannot be reliably attributed to this command.";
const SCOPE_WARNING =
  "The checkpoint covers bounded workspace text files only. Commands may affect excluded files, processes, or locations outside this workspace; those effects cannot be restored by this checkpoint.";
const PROCESS_SCOPE_WARNING =
  "Termination confirmation covers the original POSIX process group. Descendants that create separate process groups or sessions escape this scope.";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensurePosix(): void {
  if (process.platform === "win32") {
    throw new EngineError(
      "COMMAND_PLATFORM_UNSUPPORTED",
      "run_command requires POSIX process groups. Windows process-tree termination is not supported.",
    );
  }
}

async function normalizeInput(
  value: unknown,
  context: PhysicalCommandScope,
): Promise<CommandInput> {
  ensurePosix();
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !["command", "cwd", "timeoutMs"].includes(key),
    )
  ) {
    throw new EngineError(
      "INVALID_TOOL_INPUT",
      "run_command expects command, optional cwd, and optional timeoutMs.",
    );
  }
  if (
    typeof value.command !== "string" ||
    !value.command.trim() ||
    value.command.includes("\0") ||
    Buffer.byteLength(value.command) > COMMAND_LIMITS.maxCommandBytes
  ) {
    throw new EngineError(
      "INVALID_TOOL_INPUT",
      `command must be a nonempty string of at most ${COMMAND_LIMITS.maxCommandBytes} bytes without NUL characters.`,
    );
  }
  if (
    value.cwd !== undefined &&
    (typeof value.cwd !== "string" || !value.cwd || value.cwd.includes("\0"))
  ) {
    throw new EngineError(
      "INVALID_TOOL_INPUT",
      "cwd must be a nonempty workspace path without NUL characters.",
    );
  }
  if (
    !Number.isSafeInteger(context.limits.toolTimeoutMs) ||
    context.limits.toolTimeoutMs < 1 ||
    !Number.isSafeInteger(context.limits.maxOutputBytes) ||
    context.limits.maxOutputBytes < 1
  ) {
    throw new EngineError(
      "INVALID_TOOL_LIMITS",
      "toolTimeoutMs and maxOutputBytes must be positive safe integers.",
    );
  }
  if (
    value.timeoutMs !== undefined &&
    (!Number.isSafeInteger(value.timeoutMs) ||
      Number(value.timeoutMs) < 1 ||
      Number(value.timeoutMs) > COMMAND_LIMITS.maxTimeoutMs)
  ) {
    throw new EngineError(
      "INVALID_TOOL_INPUT",
      `timeoutMs must be an integer between 1 and ${COMMAND_LIMITS.maxTimeoutMs}.`,
    );
  }
  const root = resolve(context.workspace.root);
  if ((await realpath(root)) !== root) {
    throw new EngineError(
      "WORKSPACE_CHANGED",
      "The canonical workspace root changed.",
    );
  }
  const requestedCwd = value.cwd === undefined ? "." : String(value.cwd);
  const requestedAbsolute = isAbsolute(requestedCwd)
    ? resolve(requestedCwd)
    : resolve(root, requestedCwd);
  const workspaceRelative = relative(root, requestedAbsolute);
  if (
    workspaceRelative === ".." ||
    workspaceRelative.startsWith(`..${sep}`) ||
    isAbsolute(workspaceRelative)
  ) {
    throw new EngineError(
      "PATH_OUTSIDE_WORKSPACE",
      "Command cwd must be inside the workspace.",
    );
  }
  const cwd = await resolveWorkspacePath(
    context.workspace,
    workspaceRelative || ".",
  );
  if (!(await stat(cwd)).isDirectory()) {
    throw new EngineError(
      "INVALID_TOOL_INPUT",
      "Command cwd must be a directory.",
    );
  }
  return {
    command: value.command,
    cwd,
    timeoutMs: Math.min(
      Number(value.timeoutMs ?? context.limits.toolTimeoutMs),
      context.limits.toolTimeoutMs,
      COMMAND_LIMITS.maxTimeoutMs,
    ),
  };
}

async function prepareCommand(
  value: unknown,
  context: ToolContext,
): Promise<PreparedTool> {
  const input = await normalizeInput(value, context);
  const preview: JsonObject = {
    command: input.command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    workspaceId: context.workspace.id,
    runId: context.runId,
    toolCallId: context.toolCallId,
    platform: process.platform,
    termination: "posix-process-group",
  };
  const data: JsonObject = {
    workspaceRoot: context.workspace.root,
    sessionId: context.sessionId,
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ version: 1, name: "run_command", preview, data }))
    .digest("hex");
  return {
    name: "run_command",
    input: { ...input },
    fingerprint,
    requiresApproval: true,
    preview,
    data,
  };
}

function newCapture(path: string): Capture {
  const fd = openSync(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stat = fstatSync(fd, { bigint: true });
    return {
      totalBytes: 0,
      capturedBytes: 0,
      buffers: [],
      artifactBytes: 0,
      fd,
      path,
      hash: createHash("sha256"),
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

async function createCaptures(
  artifactDir: string,
): Promise<{ stdout: Capture; stderr: Capture }> {
  const root = resolve(artifactDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(await realpath(root), "command-"));
  await chmod(directory, 0o700);
  let stdout: Capture | undefined;
  try {
    stdout = newCapture(join(directory, "stdout.log"));
    return { stdout, stderr: newCapture(join(directory, "stderr.log")) };
  } catch (error) {
    if (stdout) closeSync(stdout.fd);
    throw error;
  }
}

export function supervisorExecArgv(): string[] {
  // Consumers may run the engine through node -e, --test, or Electron. Only
  // module-loader options belong to this different program's script entry.
  const result: string[] = [];
  const loaderOptions = [
    "--import",
    "--loader",
    "--experimental-loader",
    "--require",
    "-r",
    "--conditions",
  ];
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index]!;
    if (loaderOptions.includes(argument)) {
      const value = process.execArgv[++index];
      if (value !== undefined) result.push(argument, value);
    } else if (
      loaderOptions.some((option) => argument.startsWith(`${option}=`))
    )
      result.push(argument);
  }
  result.push("--no-warnings");
  return result;
}

function closeCaptures(
  captures: { stdout: Capture; stderr: Capture },
  warnings: string[],
  seal = false,
): void {
  for (const capture of Object.values(captures)) {
    if (capture.fd < 0) continue;
    try {
      if (seal) {
        const stat = fstatSync(capture.fd, { bigint: true });
        if (
          !stat.isFile() ||
          stat.dev.toString() !== capture.device ||
          stat.ino.toString() !== capture.inode ||
          stat.size !== BigInt(capture.artifactBytes)
        )
          throw new EngineError(
            "COMMAND_ARTIFACT_CHANGED",
            "The actual command output file changed before sealing",
          );
        capture.closedStat = {
          size: Number(stat.size),
          mtimeNs: stat.mtimeNs.toString(),
        };
      }
    } catch (error) {
      capture.sealFailed = true;
      warnings.push(
        `Could not seal output artifact: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      closeSync(capture.fd);
    } catch (error) {
      capture.sealFailed = true;
      warnings.push(
        `Could not close output artifact: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    capture.fd = -1;
  }
}

function sealedArtifact(capture: Capture): CommandArtifactDescriptor {
  if (!capture.closedStat || capture.sealFailed || capture.fd >= 0)
    throw new EngineError(
      "COMMAND_ARTIFACT_UNSEALED",
      "The command output file has no confirmed original seal",
    );
  const fd = openSync(
    capture.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(fd, { bigint: true });
    const current = () => {
      const st = fstatSync(fd, { bigint: true });
      return (
        st.isFile() &&
        st.dev.toString() === capture.device &&
        st.ino.toString() === capture.inode &&
        st.size === BigInt(capture.closedStat!.size) &&
        st.mtimeNs.toString() === capture.closedStat!.mtimeNs
      );
    };
    if (!before.isFile() || !current())
      throw new EngineError(
        "COMMAND_ARTIFACT_CHANGED",
        "The current command output source differs from its original sealed file",
      );
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(16_384);
    for (let at = 0; at < capture.artifactBytes;) {
      const size = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.byteLength, capture.artifactBytes - at),
        at,
      );
      if (size < 1)
        throw new EngineError(
          "COMMAND_ARTIFACT_CHANGED",
          "The current command output source is incomplete",
        );
      hash.update(buffer.subarray(0, size));
      at += size;
    }
    const sha256 = hash.digest("hex");
    if (!current() || sha256 !== capture.hash.copy().digest("hex"))
      throw new EngineError(
        "COMMAND_ARTIFACT_CHANGED",
        "The current command output bytes differ from the actual producer writes",
      );
    return validateCommandArtifactDescriptor({
      version: 1,
      path: capture.path,
      sha256,
      device: capture.device,
      inode: capture.inode,
      size: capture.closedStat.size,
      mtimeNs: capture.closedStat.mtimeNs,
      observedBytes: capture.totalBytes,
      artifactBytes: capture.artifactBytes,
      truncated: capture.totalBytes > capture.artifactBytes,
    });
  } finally {
    closeSync(fd);
  }
}
async function runProcess(
  input: CommandInput,
  context: PhysicalCommandScope,
  captures: { stdout: Capture; stderr: Capture },
  warnings: string[],
  observation?: Observation,
): Promise<ProcessOutcome> {
  let remainingCaptureBytes: number = COMMAND_LIMITS.captureBytes;
  let remainingArtifactBytes: number = COMMAND_LIMITS.artifactBytes;
  let artifactFailure = false;
  const consume = (capture: Capture, chunk: Buffer | string): void => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    capture.totalBytes += bytes.byteLength;
    const capturedBytes = Math.min(bytes.byteLength, remainingCaptureBytes);
    if (capturedBytes > 0) {
      capture.buffers.push(Buffer.from(bytes.subarray(0, capturedBytes)));
      capture.capturedBytes += capturedBytes;
      remainingCaptureBytes -= capturedBytes;
    }
    const artifactBytes = Math.min(bytes.byteLength, remainingArtifactBytes);
    if (artifactBytes > 0 && !artifactFailure) {
      try {
        let offset = 0;
        while (offset < artifactBytes) {
          const written = writeSync(
            capture.fd,
            bytes,
            offset,
            artifactBytes - offset,
          );
          if (written < 1) throw new Error("Artifact write made no progress.");
          offset += written;
          capture.hash.update(bytes.subarray(offset - written, offset));
          capture.artifactBytes += written;
          remainingArtifactBytes -= written;
        }
      } catch (error) {
        artifactFailure = true;
        warnings.push(
          `Output artifact write failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  if (context.signal.aborted)
    return {
      exitCode: null,
      signal: null,
      cancelled: true,
      timedOut: false,
      cleanupConfirmed: true,
      started: false,
    };
  const compiled = fileURLToPath(new URL("./supervisor.js", import.meta.url));
  const source = fileURLToPath(new URL("./supervisor.ts", import.meta.url));
  const child = fork(existsSync(compiled) ? compiled : source, [], {
    cwd: context.workspace.root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execPath: process.execPath,
    execArgv: supervisorExecArgv(),
    env: { ...createCommandEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
  });
  let groupPid: number | undefined;
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
      fail(
        `Supervisor IPC failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const onAbort = (): void => {
    send({ type: "stop" });
  };
  const pendingOutput: { stream: CommandOutputStream; bytes: Buffer }[] = [];
  let pendingOutputBytes = 0;
  const observedOutput = (
    stream: CommandOutputStream,
    capture: Capture,
    chunk: Buffer,
  ): void => {
    consume(capture, chunk);
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
  child.stdout?.on("data", (chunk) =>
    observedOutput("stdout", captures.stdout, chunk),
  );
  child.stderr?.on("data", (chunk) =>
    observedOutput("stderr", captures.stderr, chunk),
  );
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
    resolveClosed();
  });
  child.on("message", (packet: unknown) => {
    if (!object(packet)) return;
    if (packet.type === "ready" && !ready) {
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
      COMMAND_LIMITS.termGraceMs +
      COMMAND_LIMITS.killWaitMs +
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
          COMMAND_LIMITS.termGraceMs + COMMAND_LIMITS.killWaitMs + 250,
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
          failure ??= `Fallback process cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
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
    if (artifactFailure)
      outcome.error ??=
        "Output artifact storage failed after the command started.";
    if (failure) outcome.error ??= failure;
    return outcome;
  } finally {
    clearTimeout(startupTimer);
    clearTimeout(watchdog);
    context.signal.removeEventListener("abort", onAbort);
  }
}

/** A complete UTF-8 prefix, with replacement characters for invalid output. */
function modelPrefix(
  capture: Capture,
  budget: number,
): { text: string; sourceBytes: number } {
  const bytes = Buffer.concat(capture.buffers, capture.capturedBytes);
  if (budget <= 0) return { text: "", sourceBytes: 0 };
  let end = 0;
  let renderedBytes = 0;
  while (end < bytes.byteLength) {
    const first = bytes[end]!;
    let length =
      first < 0x80
        ? 1
        : first >= 0xc2 && first <= 0xdf
          ? 2
          : first >= 0xe0 && first <= 0xef
            ? 3
            : first >= 0xf0 && first <= 0xf4
              ? 4
              : 0;
    let valid = length > 0 && end + length <= bytes.byteLength;
    for (let index = 1; valid && index < length; index++)
      valid = (bytes[end + index]! & 0xc0) === 0x80;
    const second = bytes[end + 1];
    if (
      (first === 0xe0 && second! < 0xa0) ||
      (first === 0xed && second! >= 0xa0) ||
      (first === 0xf0 && second! < 0x90) ||
      (first === 0xf4 && second! > 0x8f)
    )
      valid = false;
    // Invalid bytes render as replacement characters. Counting each separately
    // is conservative when the decoder consumes a malformed multi-byte sequence.
    const renderedLength = valid ? length : 3;
    if (renderedBytes + renderedLength > budget) break;
    if (!valid) length = 1;
    renderedBytes += renderedLength;
    end += length;
  }
  const text = bytes.subarray(0, end).toString("utf8");
  return { text, sourceBytes: end };
}

function outputData(
  capture: Capture,
  text: string,
  sourceBytes: number,
): OutputData {
  return {
    text,
    totalBytes: capture.totalBytes,
    observedBytes: capture.totalBytes,
    capturedBytes: capture.capturedBytes,
    captureTruncatedBytes: capture.totalBytes - capture.capturedBytes,
    modelBytes: Buffer.byteLength(text),
    modelSourceBytes: sourceBytes,
    modelTruncatedBytes: capture.totalBytes - sourceBytes,
    artifactBytes: capture.artifactBytes,
    artifactTruncatedBytes: capture.totalBytes - capture.artifactBytes,
  };
}

function changedFiles(
  before: WorkspaceCapture,
  after: WorkspaceCapture,
  warnings: string[],
  excludedPaths: ReadonlySet<string>,
): Checkpoint["files"] {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  return [...paths].sort().flatMap((path) => {
    if (excludedPaths.has(path)) return [];
    const oldFile = before.files.get(path);
    const newFile = after.files.get(path);
    if (oldFile?.hash === newFile?.hash) return [];
    // Omission in a bounded/binary-filtered capture does not prove absence.
    // Never encode an unobserved preimage/postimage as a creation/deletion.
    if (
      (!oldFile && before.warnings.length > 0) ||
      (!newFile && after.warnings.length > 0)
    ) {
      warnings.push(
        `Checkpoint omitted ${path}: file absence cannot be verified from an incomplete workspace capture.`,
      );
      return [];
    }
    return [
      {
        path,
        before: oldFile?.content ?? null,
        after: newFile?.content ?? null,
        beforeHash: oldFile?.hash ?? null,
        afterHash: newFile?.hash ?? null,
      },
    ];
  });
}

function cancelledResult(context: ToolContext): ToolResult {
  return {
    content: "Command cancelled before starting.".slice(
      0,
      Math.min(context.limits.maxOutputBytes, COMMAND_LIMITS.modelBytes),
    ),
    isError: true,
    data: {
      status: "cancelled",
      exitCode: null,
      signal: null,
      cancelled: true,
      timedOut: false,
      cleanupConfirmed: true,
      started: false,
    },
  };
}

export function createCommandTool(
  options: { readonly observer?: CommandExecutionObserver; readonly sandbox?: (context: ToolContext) => import("../../sandbox/types.js").SandboxLaunch } = {},
): ToolDefinition {
  const observer = options.observer;
  const consumed = new Set<string>();
  const prepare = async (value:unknown,context:ToolContext):Promise<PreparedTool> => {
    const prepared = await prepareCommand(value,context);
    if (!options.sandbox) return prepared;
    const launch = options.sandbox(context);
    const preview = {...prepared.preview,sandbox:launch as unknown as JsonObject};
    const data = {...prepared.data as JsonObject,sandbox:launch as unknown as JsonObject};
    const fingerprint=createHash("sha256").update(JSON.stringify({version:1,name:"run_command",preview,data})).digest("hex");
    return {...prepared,preview,data,fingerprint};
  };
  return {
    name: "run_command",
    description:
      "Run an approved shell command in a workspace directory with bounded output and timeout. POSIX process groups are supported; Windows is unsupported. Workspace checkpoints cannot restore arbitrary command effects.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: {
          type: "string",
          minLength: 1,
          maxLength: COMMAND_LIMITS.maxCommandBytes,
        },
        cwd: {
          type: "string",
          description: "Directory inside the workspace; defaults to its root.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: COMMAND_LIMITS.maxTimeoutMs,
        },
      },
    },
    prepare,
    async execute(prepared, context) {
      const checked = await prepare(prepared.input, context);
      if (
        prepared.name !== checked.name ||
        prepared.requiresApproval !== true ||
        prepared.fingerprint !== checked.fingerprint ||
        JSON.stringify(prepared.preview) !== JSON.stringify(checked.preview) ||
        JSON.stringify(prepared.data) !== JSON.stringify(checked.data) ||
        JSON.stringify(prepared.input) !== JSON.stringify(checked.input)
      ) {
        throw new EngineError(
          "COMMAND_APPROVAL_MISMATCH",
          "Command, cwd, timeout, or execution binding changed after preparation.",
        );
      }
      if (consumed.has(prepared.fingerprint))
        throw new EngineError(
          "COMMAND_ALREADY_EXECUTED",
          "This prepared command has already been consumed; use a new tool call instead of retrying effects.",
        );
      if (context.signal.aborted) return cancelledResult(context);
      const input = checked.input as unknown as CommandInput;
      const before = await captureWorkspace(context.workspace, {
        signal: context.signal,
      });
      if (context.signal.aborted) return cancelledResult(context);
      // Claim before the first filesystem/process effect. A partial failure must
      // never cause a replay of the same command through this tool instance.
      if (consumed.has(prepared.fingerprint))
        throw new EngineError(
          "COMMAND_ALREADY_EXECUTED",
          "This prepared command has already been consumed; use a new tool call instead of retrying effects.",
        );
      consumed.add(prepared.fingerprint);
      const warnings = [
        ATTRIBUTION_WARNING,
        SCOPE_WARNING,
        PROCESS_SCOPE_WARNING,
        ...before.warnings,
      ];
      const captures = await createCaptures(context.artifactDir);
      let outcome: ProcessOutcome;
      let observation: Observation | undefined;
      try {
        // Recheck immediately before spawn, after snapshot and artifact setup.
        const ready = await prepare(checked.input, context);
        if (ready.fingerprint !== checked.fingerprint)
          throw new EngineError(
            "COMMAND_APPROVAL_MISMATCH",
            "Command cwd changed immediately before execution.",
          );
        if (observer) {
          const binding = JSON.stringify(prepared),
            original = observer.beforeSpawn(context, prepared);
          if (
            !original ||
            typeof original !== "object" ||
            types.isProxy(original)
          )
            throw new EngineError(
              "COMMAND_OBSERVATION_ORIGINAL_REQUIRED",
              "The command observer must return its actual original owner",
            );
          observation = { observer, original };
          if (JSON.stringify(prepared) !== binding)
            throw new EngineError(
              "COMMAND_APPROVAL_MISMATCH",
              "The original command preparation changed before spawn",
            );
        }
        outcome = await runProcess(
          input,
          {...context,...(options.sandbox ? {sandbox:options.sandbox(context)} : {})},
          captures,
          warnings,
          observation,
        );
      } catch (error) {
        if (observation) observationFailure(observation, error);
        throw error;
      } finally {
        closeCaptures(captures, warnings, observation !== undefined);
      }
      let after: WorkspaceCapture | undefined;
      try {
        after = await captureWorkspace(context.workspace, {
          signal: AbortSignal.timeout(COMMAND_LIMITS.checkpointTimeoutMs),
        });
        warnings.push(...after.warnings);
      } catch (error) {
        warnings.push(
          `After-command workspace capture failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const ownArtifactPaths = new Set(
        [captures.stdout, captures.stderr].map((capture) =>
          relative(context.workspace.root, capture.path).split(sep).join("/"),
        ),
      );
      const files = after
        ? changedFiles(before, after, warnings, ownArtifactPaths)
        : [];
      const checkpoint: Checkpoint = {
        id: randomUUID(),
        runId: context.runId,
        toolCallId: context.toolCallId,
        kind: "command",
        createdAt: new Date().toISOString(),
        files,
        warnings: [...new Set(warnings)],
        incomplete:
          !after ||
          !outcome.cleanupConfirmed ||
          before.warnings.length > 0 ||
          Boolean(after?.warnings.length),
      };
      try {
        context.recordCheckpoint(checkpoint);
      } catch (error) {
        if (!observation) throw error;
        observationFailure(observation, error);
        throw new EngineError(
          "CLEANUP_UNCERTAIN",
          "The owned command settled physically without a confirmed native checkpoint",
        );
      }
      if (observation) {
        try {
          observer!.closed(observation.original, {
            outcome: Object.freeze({ ...outcome }),
            stdout: sealedArtifact(captures.stdout),
            stderr: sealedArtifact(captures.stderr),
            checkpoint,
            ...(observation.failure
              ? { observationFailure: observation.failure }
              : {}),
          });
        } catch (error) {
          observationFailure(observation, error);
        }
        if (observation.failure)
          outcome = {
            ...outcome,
            cleanupConfirmed: false,
            error: observation.failure,
          };
      }
      const status = !outcome.cleanupConfirmed
        ? "failed"
        : outcome.cancelled
          ? "cancelled"
          : outcome.timedOut
            ? "timed_out"
            : outcome.error || outcome.exitCode !== 0
              ? "failed"
              : "completed";
      const modelBudget = Math.min(
        context.limits.maxOutputBytes,
        COMMAND_LIMITS.modelBytes,
      );
      const header = `Command ${status}; exitCode=${outcome.exitCode ?? "null"}; signal=${outcome.signal ?? "null"}; cleanupConfirmed=${outcome.cleanupConfirmed}.\n${outcome.outputDiscarded ? "Output accounting is incomplete; byte totals include only observed output.\n" : ""}`;
      const labels = "stdout:\n\nstderr:\n";
      const outputBudget = Math.max(
        0,
        modelBudget - Buffer.byteLength(header + labels),
      );
      const stdout = modelPrefix(captures.stdout, outputBudget);
      const stderr = modelPrefix(
        captures.stderr,
        outputBudget - Buffer.byteLength(stdout.text),
      );
      const content = (
        header + `stdout:\n${stdout.text}\nstderr:\n${stderr.text}`
      ).slice(0, modelBudget);
      const stdoutData = outputData(
        captures.stdout,
        stdout.text,
        stdout.sourceBytes,
      );
      const stderrData = outputData(
        captures.stderr,
        stderr.text,
        stderr.sourceBytes,
      );
      return {
        content,
        isError: status !== "completed",
        data: {
          status,
          command: input.command,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          cancelled: outcome.cancelled,
          timedOut: outcome.timedOut,
          cleanupConfirmed: outcome.cleanupConfirmed,
          started: outcome.started,
          terminationScope: "posix-process-group",
          outputAccounting: "observed-parent-pipe-bytes",
          outputAccountingComplete: !outcome.outputDiscarded,
          ...(outcome.outputDiscarded ? { unobservedBytes: null } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
          stdout: { ...stdoutData },
          stderr: { ...stderrData },
          checkpointId: checkpoint.id,
          checkpointIncomplete: Boolean(checkpoint.incomplete),
          warnings: checkpoint.warnings,
          limits: {
            captureBytes: COMMAND_LIMITS.captureBytes,
            modelBytes: modelBudget,
            artifactBytes: COMMAND_LIMITS.artifactBytes,
          },
        },
        artifacts: [captures.stdout, captures.stderr].map((capture) => ({
          path: capture.path,
          bytes: capture.artifactBytes,
          truncated:
            capture.totalBytes > capture.artifactBytes ||
            Boolean(outcome.outputDiscarded),
        })),
      };
    },
  };
}

/** Neutral physical scope: no Run, Turn, Attempt, Tool or PTY identity is synthesized. */
export interface PhysicalCommandScope {
  readonly workspace: Workspace;
  readonly signal: AbortSignal;
  readonly limits: {
    readonly toolTimeoutMs: number;
    readonly maxOutputBytes: number;
  };
  readonly artifactDir: string;
  readonly executionLockPath?: string;
  readonly sandbox?: import("../../sandbox/types.js").SandboxLaunch;
}
export interface PhysicalCommandResult {
  readonly outcome: ProcessOutcome;
  readonly stdout: CommandArtifactDescriptor;
  readonly stderr: CommandArtifactDescriptor;
  readonly files: Checkpoint["files"];
  readonly warnings: readonly string[];
  readonly incomplete: boolean;
  readonly observationFailure?: string;
}
export const preparePhysicalCommand = normalizeInput;
/** Reuses the exact native command supervisor, bounded artifacts and process-group cleanup. */
export async function executePhysicalCommand(
  input: CommandInput,
  scope: PhysicalCommandScope,
  before: WorkspaceCapture,
  observer: Pick<CommandExecutionObserver, "started" | "output" | "failed">,
  beforeSpawn: () => object,
): Promise<PhysicalCommandResult> {
  const warnings = [
    ATTRIBUTION_WARNING,
    SCOPE_WARNING,
    PROCESS_SCOPE_WARNING,
    ...before.warnings,
  ];
  const captures = await createCaptures(scope.artifactDir);
  let observation: Observation | undefined;
  let outcome: ProcessOutcome;
  try {
    const ready = await normalizeInput(input, scope);
    if (JSON.stringify(ready) !== JSON.stringify(input))
      throw new EngineError(
        "COMMAND_APPROVAL_MISMATCH",
        "Physical command preparation changed before execution",
      );
    const original = beforeSpawn();
    if (!original || typeof original !== "object" || types.isProxy(original))
      throw new EngineError(
        "COMMAND_OBSERVATION_ORIGINAL_REQUIRED",
        "Physical command requires its original owner",
      );
    observation = { observer, original };
    outcome = await runProcess(input, scope, captures, warnings, observation);
  } catch (error) {
    if (observation) observationFailure(observation, error);
    throw error;
  } finally {
    closeCaptures(captures, warnings, true);
  }
  let after: WorkspaceCapture | undefined;
  try {
    after = await captureWorkspace(scope.workspace, {
      signal: AbortSignal.timeout(COMMAND_LIMITS.checkpointTimeoutMs),
      maxFiles: 128,
      maxFileBytes: 8192,
      maxTotalBytes: 32768,
    });
    warnings.push(...after.warnings);
  } catch (error) {
    warnings.push(
      `After-command capture failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const excluded = new Set(
    [captures.stdout, captures.stderr].map((capture) =>
      relative(scope.workspace.root, capture.path).split(sep).join("/"),
    ),
  );
  return {
    outcome: Object.freeze({ ...outcome }),
    stdout: sealedArtifact(captures.stdout),
    stderr: sealedArtifact(captures.stderr),
    files: after ? changedFiles(before, after, warnings, excluded) : [],
    warnings: [...new Set(warnings)],
    incomplete:
      !after ||
      !outcome.cleanupConfirmed ||
      before.warnings.length > 0 ||
      Boolean(after?.warnings.length),
    ...(observation?.failure
      ? { observationFailure: observation.failure }
      : {}),
  };
}
