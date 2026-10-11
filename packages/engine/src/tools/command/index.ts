import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
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
import { within } from "../../shared/fs.js";
import type { SandboxLaunch } from "../../sandbox/types.js";
import {
  captureWorkspace,
  resolveWorkspacePath,
  type CaptureWorkspaceOptions,
  type WorkspaceCapture,
} from "../../workspace/index.js";
import {
  COMMAND_LIMITS,
  captureOutput,
  closeCaptures,
  createCaptures,
  modelPrefix,
  outputData,
  sealedArtifact,
  type CaptureOutput,
  type Captures,
} from "./capture.js";
import {
  errorText,
  notStartedOutcome,
  type ProcessOutcome,
} from "./process-control.js";
import {
  COMMAND_OBSERVATION_LIMITS,
  observationFailure,
  type CommandArtifactDescriptor,
  type CommandExecutionObserver,
  type CommandObservation,
} from "./observation.js";
import { commandBackendCapability, WindowsJobCommandBackend } from "./backends.js";
import { acquireExecutionLock, type ExecutionLockReservation } from "./execution-lock.js";
import { runSupervised } from "./supervisor-client.js";

export { COMMAND_LIMITS } from "./capture.js";
export { supervisorExecArgv } from "./supervisor-client.js";

export interface CommandInput {
  command: string;
  cwd: string;
  timeoutMs: number;
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
  readonly executionLockReservation?: ExecutionLockReservation;
  readonly sandbox?: SandboxLaunch;
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

const ATTRIBUTION_WARNING =
  "Checkpoint differences are observations; concurrent external edits cannot be reliably attributed to this command.";
const SCOPE_WARNING =
  "The checkpoint covers bounded workspace text files only. Commands may affect excluded files, processes, or locations outside this workspace; those effects cannot be restored by this checkpoint.";
const processScopeWarning = (): string => process.platform === "win32"
  ? "Termination confirmation covers processes owned by the original Windows Job Object. Commands run with the host user's file and network authority."
  : "Termination confirmation covers the original POSIX process group. Descendants that create separate process groups or sessions escape this scope.";
const terminationScope = (): string => process.platform === "win32" ? "windows-job-object" : "posix-process-group";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensureCommandBackend(): void {
  const capability = commandBackendCapability();
  if (!capability.available) {
    throw new EngineError(
      capability.code ?? "COMMAND_PLATFORM_UNSUPPORTED",
      "run_command requires an available native process-tree ownership backend.",
    );
  }
}

async function normalizeInput(
  value: unknown,
  context: PhysicalCommandScope,
): Promise<CommandInput> {
  ensureCommandBackend();
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
  if (!within(root, requestedAbsolute)) {
    throw new EngineError(
      "PATH_OUTSIDE_WORKSPACE",
      "Command cwd must be inside the workspace.",
    );
  }
  const cwd = await resolveWorkspacePath(
    context.workspace,
    relative(root, requestedAbsolute) || ".",
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
    termination: terminationScope(),
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

async function runWindowsJob(
  input: CommandInput,
  context: PhysicalCommandScope,
  output: CaptureOutput,
  warnings: string[],
  observation?: CommandObservation,
): Promise<ProcessOutcome> {
  if (context.sandbox) throw new EngineError("SANDBOX_BACKEND_UNSUPPORTED", "Windows Job Object ownership has no supported sandbox launch");
  const backend = new WindowsJobCommandBackend();
  if (!backend.capability().available) throw new EngineError("WINDOWS_JOB_BACKEND_UNAVAILABLE", "A native Windows Job Object host is required");
  let lock: ReturnType<typeof acquireExecutionLock> | undefined;
  let outcome: ProcessOutcome | undefined;
  try {
    if (context.executionLockPath) lock = acquireExecutionLock(context.executionLockPath, context.executionLockReservation);
    outcome = await backend.execute(input, context.signal, (stream, bytes) => {
      output.consume(stream, bytes);
      if (!observation || observation.failure) return;
      try {
        for (let at = 0; at < bytes.length; at += COMMAND_OBSERVATION_LIMITS.outputHookBytes)
          observation.observer.output(observation.original, stream, Buffer.from(bytes.subarray(at, at + COMMAND_OBSERVATION_LIMITS.outputHookBytes)));
      } catch (error) {
        observationFailure(observation, error);
        throw new EngineError("COMMAND_OBSERVATION_FAILED", "Command output observation failed");
      }
    }, pid => {
      lock?.recordGroup(pid);
      if (observation) try { observation.observer.started(observation.original, pid); }
      catch (error) { observationFailure(observation, error); throw error; }
    }, message => warnings.push(message));
    output.recordArtifactFailure(outcome);
    return outcome;
  } finally {
    // A crashed engine loses its kill-on-close handle but leaves this marker
    // active. Restart preserves unknown effects and never replays a command.
    lock?.release(outcome?.cleanupConfirmed === true);
  }
}

async function runProcess(
  input: CommandInput,
  context: PhysicalCommandScope,
  captures: Captures,
  warnings: string[],
  observation?: CommandObservation,
): Promise<ProcessOutcome> {
  if (context.signal.aborted) return notStartedOutcome(true);
  const output = captureOutput(captures, warnings);
  return process.platform === "win32"
    ? runWindowsJob(input, context, output, warnings, observation)
    : runSupervised(input, context, output, warnings, observation);
}

function originalObservation(
  observer: CommandObservation["observer"],
  original: unknown,
  message: string,
): CommandObservation {
  if (!original || typeof original !== "object" || types.isProxy(original))
    throw new EngineError("COMMAND_OBSERVATION_ORIGINAL_REQUIRED", message);
  return { observer, original };
}

/**
 * One command from artifact setup to its sealed outputs and workspace diff.
 * `admit` rechecks the preparation immediately before spawn, attaches the
 * observation as soon as it exists so later failures reach its observer, and
 * returns the scope the process runs in.
 */
async function runCapturedCommand(
  input: CommandInput,
  scope: PhysicalCommandScope,
  before: WorkspaceCapture,
  admit: (attach: (observation: CommandObservation) => void) => Promise<PhysicalCommandScope>,
  afterCapture: { readonly label: string; readonly limits?: Omit<CaptureWorkspaceOptions, "signal"> },
) {
  const warnings = [
    ATTRIBUTION_WARNING,
    SCOPE_WARNING,
    processScopeWarning(),
    ...before.warnings,
  ];
  const captures = await createCaptures(scope.artifactDir);
  let observation: CommandObservation | undefined;
  let outcome: ProcessOutcome;
  try {
    const launch = await admit((admitted) => {
      observation = admitted;
    });
    outcome = await runProcess(input, launch, captures, warnings, observation);
  } catch (error) {
    if (observation) observationFailure(observation, error);
    throw error;
  } finally {
    closeCaptures(captures, warnings, observation !== undefined);
  }
  let after: WorkspaceCapture | undefined;
  try {
    after = await captureWorkspace(scope.workspace, {
      signal: AbortSignal.timeout(COMMAND_LIMITS.checkpointTimeoutMs),
      ...afterCapture.limits,
    });
    warnings.push(...after.warnings);
  } catch (error) {
    warnings.push(`${afterCapture.label}: ${errorText(error)}`);
  }
  const ownArtifactPaths = new Set(
    [captures.stdout, captures.stderr].map((capture) =>
      relative(scope.workspace.root, capture.path).split(sep).join("/"),
    ),
  );
  const files = after
    ? changedFiles(before, after, warnings, ownArtifactPaths)
    : [];
  return {
    outcome,
    captures,
    observation,
    files,
    warnings: [...new Set(warnings)],
    incomplete:
      !after ||
      !outcome.cleanupConfirmed ||
      before.warnings.length > 0 ||
      Boolean(after?.warnings.length),
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
    data: { status: "cancelled", ...notStartedOutcome(true) },
  };
}

export function createCommandTool(
  options: { readonly observer?: CommandExecutionObserver; readonly sandbox?: (context: ToolContext) => SandboxLaunch } = {},
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
      "Run an approved shell command in a workspace directory with bounded output and timeout using the available native process-tree backend. Workspace checkpoints cannot restore arbitrary command effects.",
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
      const run = await runCapturedCommand(input, context, before, async (attach) => {
        // Recheck immediately before spawn, after snapshot and artifact setup.
        const ready = await prepare(checked.input, context);
        if (ready.fingerprint !== checked.fingerprint)
          throw new EngineError(
            "COMMAND_APPROVAL_MISMATCH",
            "Command cwd changed immediately before execution.",
          );
        if (observer) {
          const binding = JSON.stringify(prepared);
          attach(originalObservation(
            observer,
            observer.beforeSpawn(context, prepared),
            "The command observer must return its actual original owner",
          ));
          if (JSON.stringify(prepared) !== binding)
            throw new EngineError(
              "COMMAND_APPROVAL_MISMATCH",
              "The original command preparation changed before spawn",
            );
        }
        return {...context,...(options.sandbox ? {sandbox:options.sandbox(context)} : {})};
      }, { label: "After-command workspace capture failed" });
      const { captures, observation } = run;
      let outcome = run.outcome;
      const checkpoint: Checkpoint = {
        id: randomUUID(),
        runId: context.runId,
        toolCallId: context.toolCallId,
        kind: "command",
        createdAt: new Date().toISOString(),
        files: run.files,
        warnings: run.warnings,
        incomplete: run.incomplete,
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
          terminationScope: terminationScope(),
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

export const preparePhysicalCommand = normalizeInput;
/** Reuses native process ownership, exact observations and bounded artifacts. */
export async function executePhysicalCommand(
  input: CommandInput,
  scope: PhysicalCommandScope,
  before: WorkspaceCapture,
  observer: Pick<CommandExecutionObserver, "started" | "output" | "failed" | "control">,
  beforeSpawn: () => object,
): Promise<PhysicalCommandResult> {
  const { outcome, captures, observation, files, warnings, incomplete } =
    await runCapturedCommand(input, scope, before, async (attach) => {
      const ready = await normalizeInput(input, scope);
      if (JSON.stringify(ready) !== JSON.stringify(input))
        throw new EngineError(
          "COMMAND_APPROVAL_MISMATCH",
          "Physical command preparation changed before execution",
        );
      attach(originalObservation(
        observer,
        beforeSpawn(),
        "Physical command requires its original owner",
      ));
      return scope;
    }, {
      label: "After-command capture failed",
      limits: { maxFiles: 128, maxFileBytes: 8192, maxTotalBytes: 32768 },
    });
  return {
    outcome: Object.freeze({ ...outcome }),
    stdout: sealedArtifact(captures.stdout),
    stderr: sealedArtifact(captures.stderr),
    files,
    warnings,
    incomplete,
    ...(observation?.failure
      ? { observationFailure: observation.failure }
      : {}),
  };
}
