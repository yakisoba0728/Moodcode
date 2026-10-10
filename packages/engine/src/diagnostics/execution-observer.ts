import { EngineError } from "@moodcode/contracts";
import type { PreparedTool, ToolContext } from "../ports.js";
import type { ScopedToolRuntime } from "../tools/runtime/index.js";
import type { SqliteStore } from "../storage/index.js";
import type {
  DiagnosticExecutionCapture,
  DiagnosticExecutionIdentity,
  DiagnosticExecutionRuntimeMetadata,
  ExecutionSourceSnapshot,
} from "./execution-observation-types.js";
import {
  WorkspaceExecutionSource,
  type WorkspaceExecutionSourceCapture,
} from "./execution-source.js";
import type { DiagnosticExecutionObservationStorage } from "./execution-observation-store.js";

const UNKNOWN: ExecutionSourceSnapshot = Object.freeze({
  schemaVersion: 1,
  completeness: "unknown",
  sha256: null,
  fileCount: 0,
  bytes: 0,
});
interface Owned {
  readonly handle: object;
  readonly context: ToolContext;
  readonly identity: DiagnosticExecutionIdentity;
  readonly runtime: ReturnType<ScopedToolRuntime["getExecutionMetadata"]>;
  readonly workspaceSource: boolean;
  before?: WorkspaceExecutionSourceCapture;
  after?: WorkspaceExecutionSourceCapture;
  dispatch?: DiagnosticExecutionCapture;
  resultComplete: boolean;
}
function identity(context: ToolContext): DiagnosticExecutionIdentity {
  if (!context.turnId || !context.attemptId)
    throw new EngineError(
      "EXECUTION_OBSERVATION_OWNER_INVALID",
      "Execution observations require the actual Turn and Attempt",
    );
  return Object.freeze({
    workspaceId: context.workspace.id,
    sessionId: context.sessionId,
    runId: context.runId,
    toolCallId: context.toolCallId,
    turnId: context.turnId,
    attemptId: context.attemptId,
  });
}
/** Original runtime handles and physical captures stay private to the executing owner. */
export class EngineExecutionObserver {
  readonly storage: DiagnosticExecutionObservationStorage;
  readonly #prepared = new WeakMap<PreparedTool, Owned>();
  readonly #handles = new WeakMap<object, Owned>();
  readonly #dispatched = new Map<string, Owned>();
  readonly #nested = new WeakMap<PreparedTool, Owned>();
  constructor(
    private readonly store: SqliteStore,
    private readonly source: WorkspaceExecutionSource,
    private readonly runtime: () => ScopedToolRuntime,
  ) {
    this.storage = store.createDiagnosticExecutionObservationStorage({
      readSourceSnapshot: (handle, phase) => this.metadata(handle, phase),
    });
    this.storage.recoverInterruptedOwners();
  }
  private metadata(
    handle: object,
    phase: "before" | "after",
  ): DiagnosticExecutionRuntimeMetadata {
    const owned = this.#handles.get(handle);
    if (!owned)
      throw new EngineError(
        "EXECUTION_OBSERVATION_SOURCE_INVALID",
        "Source metadata requires the current original host handle",
      );
    const capture = phase === "before" ? owned.before : owned.after;
    return Object.freeze({
      ...owned.identity,
      effectClass: owned.runtime.effectClass,
      effectiveInputSha256: owned.runtime.effectiveInputSha256,
      source: capture ? this.source.getSnapshot(capture) : UNKNOWN,
      resultComplete: phase === "after" && owned.resultComplete,
    });
  }
  async prepare(
    prepared: PreparedTool,
    context: ToolContext,
  ): Promise<string | null> {
    if (this.#prepared.has(prepared))
      throw new EngineError(
        "EXECUTION_OBSERVATION_DUPLICATE",
        "Original observation is already prepared",
      );
    const runtime = this.runtime().getExecutionMetadata(prepared),
      handle = Object.freeze({}),
      owned: Owned = {
        handle,
        context,
        identity: identity(context),
        runtime,
        workspaceSource:
          runtime.workspaceSource &&
          (runtime.effectClass !== "read" ||
            this.source.coversWorkspacePath(
              context.workspace,
              prepared.input &&
                typeof prepared.input === "object" &&
                !Array.isArray(prepared.input) &&
                typeof prepared.input.path === "string"
                ? prepared.input.path
                : ".",
              prepared.name !== "read_file",
            )),
        resultComplete: false,
      };
    this.#prepared.set(prepared, owned);
    this.#handles.set(handle, owned);
    try {
      if (owned.workspaceSource)
        owned.before = await this.source
          .capture(
            context.workspace,
            context.signal,
            runtime.effectClass !== "read",
          )
          .then(
            (result) => result.capture,
            (error: unknown) => {
              // A busy read keeps unknown coverage; effect tools wait so dispatch stays freshness-checked.
              if (
                runtime.effectClass === "read" &&
                error instanceof EngineError &&
                error.code === "EXECUTION_SOURCE_CAPACITY"
              )
                return undefined;
              throw error;
            },
          );
      const snapshot = this.metadata(handle, "before").source;
      // Unknown coverage grants no claim that an identical input saw the same files.
      return runtime.effectClass === "read" && snapshot.completeness === "full"
        ? `${this.runtime().repeatIdentity(prepared)}:${snapshot.sha256}:${this.storage.getEpoch(context.workspace.id)?.epoch ?? 0}`
        : null;
    } catch (error) {
      this.release(prepared);
      throw error;
    }
  }
  async beforeProducer(
    prepared: PreparedTool,
    context: ToolContext,
  ): Promise<() => void> {
    const key = JSON.stringify(identity(context)),
      outer = this.#nested.get(prepared);
    // The outer dispatch already recorded this nested producer's observation and epoch.
    if (outer && this.#dispatched.get(key) === outer)
      return () => {
        if (context.signal.aborted || this.#dispatched.get(key) !== outer)
          throw new EngineError(
            "EXECUTION_OBSERVATION_SOURCE_INVALID",
            "Outer observation changed or was cancelled before nested dispatch",
          );
      };
    const owned = this.#prepared.get(prepared);
    if (!owned || key !== JSON.stringify(owned.identity))
      throw new EngineError(
        "EXECUTION_OBSERVATION_OWNER_INVALID",
        "Producer dispatch requires its original prepared observation",
      );
    if (
      owned.before &&
      this.source.getSnapshot(owned.before).completeness === "full"
    )
      await this.source.assertFresh(owned.before, context.signal);
    return () => {
      if (
        context.signal.aborted ||
        this.#prepared.get(prepared) !== owned ||
        owned.dispatch
      )
        throw new EngineError(
          "EXECUTION_OBSERVATION_SOURCE_INVALID",
          "Producer observation changed or was cancelled before dispatch",
        );
      const current = this.runtime().getExecutionMetadata(prepared);
      if (JSON.stringify(current) !== JSON.stringify(owned.runtime))
        throw new EngineError(
          "EXECUTION_OBSERVATION_STALE",
          "Original runtime execution metadata changed",
        );
      owned.dispatch = this.storage.dispatch(
        owned.identity,
        owned.handle,
      ).capture;
      this.#dispatched.set(key, owned);
    };
  }
  /** Runs one nested producer of a dispatched outer execution without a second observation. */
  async nested<T>(
    outer: ToolContext,
    prepared: PreparedTool,
    execute: () => Promise<T>,
  ): Promise<T> {
    const owned = this.#dispatched.get(JSON.stringify(identity(outer)));
    if (!owned || this.#prepared.has(prepared) || this.#nested.has(prepared))
      throw new EngineError(
        "EXECUTION_OBSERVATION_OWNER_INVALID",
        "Nested dispatch requires its dispatched outer observation",
      );
    this.#nested.set(prepared, owned);
    try {
      return await execute();
    } finally {
      this.#nested.delete(prepared);
    }
  }
  result(prepared: PreparedTool, complete: boolean): void {
    const owned = this.#prepared.get(prepared);
    if (owned) owned.resultComplete = complete;
  }
  async settle(prepared: PreparedTool): Promise<void> {
    const owned = this.#prepared.get(prepared);
    if (!owned) return;
    try {
      if (owned.dispatch) {
        if (owned.workspaceSource && !owned.context.signal.aborted) {
          try {
            owned.after = (
              await this.source.capture(
                owned.context.workspace,
                owned.context.signal,
              )
            ).capture;
          } catch {
            owned.resultComplete = false;
          }
        }
        this.storage.settle(owned.dispatch);
      }
    } catch (error) {
      // Advisory metadata never replaces the tool's real failure, cleanup, or result.
      try {
        this.store.commit(
          owned.identity.runId,
          "execution.observation_failed",
          {
            toolCallId: owned.identity.toolCallId,
            code:
              error instanceof EngineError
                ? error.code
                : "EXECUTION_OBSERVATION_FAILED",
          },
        );
      } catch {
        /* Preserve the original execution result. */
      }
    } finally {
      this.release(prepared);
    }
  }
  release(prepared: PreparedTool): void {
    const owned = this.#prepared.get(prepared);
    if (!owned) return;
    try {
      if (owned.dispatch) this.storage.release(owned.dispatch);
    } catch (error) {
      try {
        this.store.commit(
          owned.identity.runId,
          "execution.observation_failed",
          {
            toolCallId: owned.identity.toolCallId,
            code:
              error instanceof EngineError
                ? error.code
                : "EXECUTION_OBSERVATION_RELEASE_FAILED",
          },
        );
      } catch {
        /* Durable dispatched metadata remains unknown for restart inspection. */
      }
    } finally {
      if (owned.before) this.source.release(owned.before);
      if (owned.after) this.source.release(owned.after);
      const key = JSON.stringify(owned.identity);
      if (this.#dispatched.get(key) === owned) this.#dispatched.delete(key);
      this.#prepared.delete(prepared);
      this.#handles.delete(owned.handle);
    }
  }
  close(): Promise<void> {
    return this.source.close();
  }
}
