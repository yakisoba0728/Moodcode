import { createHash, randomUUID } from "node:crypto";
import {
  EngineError,
  type JsonObject,
  type Workspace,
} from "@moodcode/contracts";
import type { GrantDocumentPort } from "../permission/grants.js";
import type { ManagedWorktree, WorktreeManager } from "../worktrees/index.js";

export interface ChildBudget {
  turns: number;
  toolCalls: number;
  outputBytes: number;
  durationMs: number;
}
export type ChildTaskState =
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain";
export interface ChildOutcome {
  state: "completed" | "failed" | "cancelled";
  content: string;
  usage: Omit<ChildBudget, "durationMs">;
  truncated?: boolean;
}
export interface ChildTaskRecord {
  id: string;
  requestId: string;
  sessionId: string;
  parentRunId: string;
  rootRunId: string;
  parentTaskId?: string;
  depth: number;
  worktreeId: string;
  toolNames: string[];
  budget: ChildBudget;
  state: ChildTaskState;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  childRunId?: string;
  outcome?: ChildOutcome;
  deliveryState: "none" | "pending" | "delivered";
  deliveryRequestId: string;
  inputId?: string;
  errorCode?: string;
}
export interface ChildStart {
  sessionId: string;
  requestId: string;
  parentRunId: string;
  parentTaskId?: string;
  worktreeId: string;
  prompt: string;
  allowedTools: string[];
  requestedTools: string[];
  remainingBudget: ChildBudget;
  allocation: ChildBudget;
}
export interface ChildRunHandle {
  runId: string;
  /** Synchronous release after the actual running task and child Run ID are durable. */
  admitted?(): void;
  wait(): Promise<ChildOutcome>;
  cancel(): Promise<void>;
}
export interface ChildTaskHost {
  /** Must enforce this allocation and exact tool allowlist; no implicit provider or permission escalation. */
  start(request: {
    task: ChildTaskRecord;
    workspace: Workspace;
    prompt: string;
    signal: AbortSignal;
  }): Promise<ChildRunHandle>;
  /** Must deduplicate requestId at the durable input boundary. A retry uses the same id. */
  acceptResult(request: {
    sessionId: string;
    parentRunId: string;
    requestId: string;
    childTaskId: string;
    outcome: ChildOutcome;
  }): Promise<{ inputId: string }>;
}
export interface ChildTaskOptions {
  documents: GrantDocumentPort;
  worktrees: WorktreeManager;
  host: ChildTaskHost;
  /** Synchronous live-parent reservation, after durable intent/ownership and before any host dispatch. */
  beforeDispatch?(task: ChildTaskRecord): void;
  now?: () => number;
  cleanupTimeoutMs?: number;
}
interface Pool {
  /** Lineage only for new pools; the legacy form used this as its allocation key. */
  rootRunId: string;
  /** Missing only in legacy journals. New reservations charge the immediate parent. */
  parentRunId?: string;
  capacity: ChildBudget;
  reserved: ChildBudget;
}
interface Journal {
  revision: number;
  tasks: ChildTaskRecord[];
  pools: Pool[];
}
interface Live {
  controller: AbortController;
  handle?: ChildRunHandle;
  finished: Promise<ChildTaskRecord>;
  unlink(): void;
  timer: ReturnType<typeof setTimeout>;
}
const KIND = "engine.child_tasks";
const KEYS = ["turns", "toolCalls", "outputBytes", "durationMs"] as const;
const TERMINAL = ["completed", "failed", "cancelled", "uncertain"];
const STATES = ["starting", "running", "cancelling", ...TERMINAL];
const clone = <T>(value: T): T => structuredClone(value);
function validBudget(b: ChildBudget): boolean {
  return (
    !!b &&
    KEYS.every(
      (k) =>
        Number.isSafeInteger(b[k]) &&
        b[k] >= 0 &&
        b[k] <=
          (k === "durationMs"
            ? 3_600_000
            : k === "outputBytes"
              ? 16_777_216
              : 10_000),
    ) &&
    b.turns > 0 &&
    b.durationMs > 0
  );
}
function names(input: string[]): string[] {
  if (
    !Array.isArray(input) ||
    input.length > 256 ||
    input.some(
      (n) => typeof n !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(n),
    )
  )
    throw new EngineError(
      "INVALID_CHILD_TOOLS",
      "Child tools must be a bounded exact allowlist",
    );
  return [...new Set(input)].sort();
}
function boundedOutcome(
  value: ChildOutcome,
  budget: ChildBudget,
): ChildOutcome {
  if (
    !value ||
    !["completed", "failed", "cancelled"].includes(value.state) ||
    typeof value.content !== "string" ||
    !value.usage ||
    ["turns", "toolCalls", "outputBytes"].some(
      (k) =>
        !Number.isSafeInteger(value.usage[k as keyof ChildOutcome["usage"]]) ||
        value.usage[k as keyof ChildOutcome["usage"]] < 0 ||
        value.usage[k as keyof ChildOutcome["usage"]] >
          budget[k as keyof ChildBudget],
    )
  )
    throw new EngineError(
      "CHILD_BUDGET_EXCEEDED",
      "Child outcome or measured usage exceeds its reserved allocation",
    );
  if (Buffer.byteLength(value.content) > 16 * 1024 * 1024)
    throw new EngineError(
      "CHILD_RESULT_LIMIT",
      "Child result producer exceeds the 16 MiB bound",
    );
  let content = value.content;
  const raw = Buffer.from(content);
  const limit = Math.min(budget.outputBytes, 4096);
  const truncated = raw.length > limit || value.truncated === true;
  if (raw.length > limit) {
    content = raw.subarray(0, limit).toString("utf8");
    while (Buffer.byteLength(content) > limit || content.endsWith("\ufffd"))
      content = content.slice(0, -1);
  }
  return {
    state: value.state,
    content,
    usage: clone(value.usage),
    ...(truncated ? { truncated: true } : {}),
  };
}
function cancelled(): EngineError {
  return new EngineError("CANCELLED", "Child task was cancelled");
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => {});
  });
}
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new EngineError(
              "CHILD_CLEANUP_UNCERTAIN",
              "Child dispatch or cancellation did not settle before the cleanup deadline",
            ),
          ),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer!));
}

/** Durable allocation and lifecycle boundary. The host owns actual run execution and result-input deduplication. */
export class ChildTaskManager {
  private live = new Map<string, Live>();
  private pendingCleanup = new Set<Promise<void>>();
  private closing = false;
  private now: () => number;
  private timeout: number;
  constructor(private readonly options: ChildTaskOptions) {
    this.now = options.now ?? Date.now;
    this.timeout = options.cleanupTimeoutMs ?? 1000;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 10_000
    )
      throw new EngineError(
        "INVALID_CHILD_CONFIG",
        "Child cleanup deadline must be bounded",
      );
  }
  private journal(sessionId: string): Journal {
    const document = this.options.documents.getSessionDocument(sessionId, KIND);
    if (!document) return { revision: 0, tasks: [], pools: [] };
    const tasks = document.data.tasks as unknown as ChildTaskRecord[];
    const pools = document.data.pools as unknown as Pool[];
    if (
      document.data.schemaVersion !== 1 ||
      !Array.isArray(tasks) ||
      tasks.length > 32 ||
      !Array.isArray(pools) ||
      pools.length > 32 ||
      tasks.some(
        (t) =>
          !t ||
          t.sessionId !== sessionId ||
          !/^child_[a-f0-9]{32}$/.test(t.id) ||
          !STATES.includes(t.state) ||
          !validBudget(t.budget) ||
          !Number.isSafeInteger(t.depth) ||
          t.depth < 1 ||
          t.depth > 3 ||
          !Array.isArray(t.toolNames) ||
          !["none", "pending", "delivered"].includes(t.deliveryState),
      ) ||
      new Set(tasks.map((t) => t.id)).size !== tasks.length ||
      pools.some(
        (p) =>
          typeof p.rootRunId !== "string" ||
          !p.rootRunId ||
          Buffer.byteLength(p.rootRunId) > 256 ||
          (p.parentRunId !== undefined &&
            (typeof p.parentRunId !== "string" ||
              !p.parentRunId ||
              Buffer.byteLength(p.parentRunId) > 256)) ||
          !validBudget(p.capacity) ||
          !p.reserved ||
          KEYS.some(
            (k) =>
              !Number.isSafeInteger(p.reserved[k]) ||
              p.reserved[k] < 0 ||
              p.reserved[k] > p.capacity[k],
          ),
      ) ||
      new Set(pools.map((p) => p.parentRunId ?? p.rootRunId)).size !==
        pools.length
    )
      throw new EngineError(
        "INVALID_CHILD_JOURNAL",
        "Stored child task ownership, budget or state is invalid",
      );
    return {
      revision: document.revision,
      tasks: clone(tasks),
      pools: clone(pools),
    };
  }
  private commit(sessionId: string, journal: Journal): void {
    const data = {
      schemaVersion: 1,
      tasks: journal.tasks,
      pools: journal.pools,
    } as unknown as JsonObject;
    if (Buffer.byteLength(JSON.stringify(data)) > 240 * 1024)
      throw new EngineError(
        "CHILD_JOURNAL_LIMIT",
        "Child task journal exceeds its durable byte limit",
      );
    this.options.documents.putSessionDocument(
      sessionId,
      KIND,
      journal.revision,
      data,
    );
  }
  private update(
    sessionId: string,
    id: string,
    change: Partial<ChildTaskRecord>,
  ): ChildTaskRecord {
    const journal = this.journal(sessionId);
    const task = journal.tasks.find((t) => t.id === id);
    if (!task)
      throw new EngineError(
        "CHILD_TASK_NOT_FOUND",
        "Child task does not belong to this session",
      );
    Object.assign(task, clone(change), {
      updatedAt: new Date(this.now()).toISOString(),
    });
    this.commit(sessionId, journal);
    return clone(task);
  }
  /** This path is allowed only while host.start is proven not to have been called. */
  private failBeforeDispatch(
    task: ChildTaskRecord,
    error: unknown,
  ): ChildTaskRecord {
    const journal = this.journal(task.sessionId);
    const stored = journal.tasks.find((value) => value.id === task.id);
    const pool = journal.pools.find(
      (value) => (value.parentRunId ?? value.rootRunId) === task.parentRunId,
    );
    if (
      !stored ||
      stored.state !== "starting" ||
      !pool ||
      KEYS.some((key) => pool.reserved[key] < task.budget[key])
    ) {
      throw new EngineError(
        "CHILD_ADMISSION_UNCERTAIN",
        "Undispatched child reservation could not be reconciled",
      );
    }
    for (const key of KEYS) pool.reserved[key] -= task.budget[key];
    stored.state =
      error instanceof EngineError && error.code === "CANCELLED"
        ? "cancelled"
        : "failed";
    stored.errorCode =
      error instanceof EngineError ? error.code : "CHILD_ADMISSION_FAILED";
    stored.updatedAt = new Date(this.now()).toISOString();
    this.commit(task.sessionId, journal);
    try {
      // A failed ownership claim may already belong to somebody else. Never
      // release another task's owner when recording a known pre-dispatch failure.
      if (
        this.options.worktrees.get(task.sessionId, task.worktreeId).ownerId ===
        task.id
      ) {
        this.options.worktrees.releaseOwnership(
          task.sessionId,
          task.worktreeId,
          task.id,
        );
      }
    } catch {
      this.update(task.sessionId, task.id, {
        state: "uncertain",
        errorCode: "CHILD_CLEANUP_UNCERTAIN",
      });
      throw new EngineError(
        "CHILD_CLEANUP_UNCERTAIN",
        "Undispatched child worktree ownership could not be released",
      );
    }
    return clone(stored);
  }
  list(sessionId: string): ChildTaskRecord[] {
    return this.journal(sessionId).tasks;
  }
  get(sessionId: string, id: string): ChildTaskRecord {
    const task = this.list(sessionId).find((t) => t.id === id);
    if (!task)
      throw new EngineError(
        "CHILD_TASK_NOT_FOUND",
        "Child task does not belong to this session",
      );
    return task;
  }
  async start(
    input: ChildStart,
    parentSignal: AbortSignal,
  ): Promise<ChildTaskRecord> {
    input = clone(input);
    if (this.closing || parentSignal.aborted) throw cancelled();
    if (
      ![
        input.sessionId,
        input.requestId,
        input.parentRunId,
        input.worktreeId,
      ].every(
        (v) => typeof v === "string" && !!v && Buffer.byteLength(v) <= 256,
      ) ||
      typeof input.prompt !== "string" ||
      Buffer.byteLength(input.prompt) > 32 * 1024 ||
      !validBudget(input.remainingBudget) ||
      !validBudget(input.allocation) ||
      KEYS.some((k) => input.allocation[k] > input.remainingBudget[k])
    )
      throw new EngineError(
        "INVALID_CHILD_INPUT",
        "Child identity, prompt and allocation must fit the parent remaining budget",
      );
    const allowed = names(input.allowedTools);
    const requested = names(input.requestedTools);
    if (requested.some((n) => !allowed.includes(n)))
      throw new EngineError(
        "CHILD_TOOL_ESCALATION",
        "Child tools must be a subset of parent permissions",
      );
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          ...input,
          allowedTools: allowed,
          requestedTools: requested,
        }),
      )
      .digest("hex");
    let journal = this.journal(input.sessionId);
    const prior = journal.tasks.find((t) => t.requestId === input.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new EngineError(
          "CHILD_REQUEST_CONFLICT",
          "Child request id is bound to a different input",
        );
      return clone(prior);
    }
    const parent = input.parentTaskId
      ? journal.tasks.find((t) => t.id === input.parentTaskId)
      : undefined;
    if (
      input.parentTaskId &&
      (!parent ||
        parent.childRunId !== input.parentRunId ||
        parent.state !== "running" ||
        requested.some((n) => !parent.toolNames.includes(n)) ||
        KEYS.some((k) => input.remainingBudget[k] > parent.budget[k]))
    )
      throw new EngineError(
        "CHILD_PARENT_MISMATCH",
        "Nested child authority must come from its live parent task",
      );
    const depth = parent ? parent.depth + 1 : 1;
    if (depth > 3 || journal.tasks.length >= 32)
      throw new EngineError(
        "CHILD_TASK_LIMIT",
        "Child depth or session task count exceeded",
      );
    const worktree = this.options.worktrees.get(
      input.sessionId,
      input.worktreeId,
    );
    if (worktree.state !== "ready")
      throw new EngineError(
        "CHILD_WORKTREE_NOT_READY",
        "Child task needs a ready managed worktree",
      );
    if (
      journal.tasks.some(
        (t) => t.worktreeId === worktree.id && !TERMINAL.includes(t.state),
      )
    )
      throw new EngineError(
        "CHILD_WORKTREE_BUSY",
        "A live child task already owns this isolated worktree",
      );
    const workspace = await this.options.worktrees.verify(
      worktree,
      parentSignal,
    );
    if (this.closing || parentSignal.aborted) throw cancelled();
    // Reload after asynchronous filesystem observation; reserve in the same CAS as dispatch intent.
    journal = this.journal(input.sessionId);
    if (journal.tasks.length >= 32)
      throw new EngineError(
        "CHILD_TASK_LIMIT",
        "Session child count changed during admission",
      );
    if (parent) {
      const freshParent = journal.tasks.find((t) => t.id === parent.id);
      if (
        !freshParent ||
        freshParent.state !== "running" ||
        freshParent.childRunId !== input.parentRunId ||
        freshParent.fingerprint !== parent.fingerprint
      )
        throw new EngineError(
          "CHILD_PARENT_MISMATCH",
          "Parent finished or its authority changed during admission",
        );
    }
    if (
      journal.tasks.some(
        (t) =>
          t.requestId === input.requestId ||
          (t.worktreeId === worktree.id && !TERMINAL.includes(t.state)),
      )
    )
      throw new EngineError(
        "CHILD_ADMISSION_CONFLICT",
        "Concurrent child admission changed request or worktree ownership",
      );
    const rootRunId = parent?.rootRunId ?? input.parentRunId;
    let pool = journal.pools.find(
      (p) => (p.parentRunId ?? p.rootRunId) === input.parentRunId,
    );
    if (pool && pool.rootRunId !== rootRunId)
      throw new EngineError(
        "CHILD_PARENT_MISMATCH",
        "Child budget pool belongs to different root lineage",
      );
    if (!pool) {
      pool = {
        rootRunId,
        parentRunId: input.parentRunId,
        capacity: clone(input.remainingBudget),
        reserved: { turns: 0, toolCalls: 0, outputBytes: 0, durationMs: 0 },
      };
      journal.pools.push(pool);
    }
    if (
      KEYS.some(
        (k) => pool!.reserved[k] + input.allocation[k] > pool!.capacity[k],
      )
    )
      throw new EngineError(
        "CHILD_BUDGET_EXCEEDED",
        "Sibling allocations exhaust their immediate parent's shared budget",
      );
    for (const k of KEYS) pool.reserved[k] += input.allocation[k];
    const id = `child_${randomUUID().replaceAll("-", "")}`;
    const stamp = new Date(this.now()).toISOString();
    const task: ChildTaskRecord = {
      id,
      requestId: input.requestId,
      sessionId: input.sessionId,
      parentRunId: input.parentRunId,
      rootRunId,
      ...(parent ? { parentTaskId: parent.id } : {}),
      depth,
      worktreeId: worktree.id,
      toolNames: requested,
      budget: clone(input.allocation),
      state: "starting",
      fingerprint,
      createdAt: stamp,
      updatedAt: stamp,
      deliveryState: "none",
      deliveryRequestId: `child-result:${id}`,
    };
    journal.tasks.push(task);
    this.commit(input.sessionId, journal);
    try {
      this.options.worktrees.claimOwnership(input.sessionId, worktree.id, id);
      if (this.closing || parentSignal.aborted) throw cancelled();
      const result = this.options.beforeDispatch?.(clone(task));
      if (result !== undefined) {
        // A promise-returning callback cannot reserve authority after dispatch.
        void Promise.resolve(result).catch(() => {});
        throw new EngineError(
          "INVALID_CHILD_ADMISSION_HOOK",
          "Child admission hook must synchronously return void",
        );
      }
      if (this.closing || parentSignal.aborted) throw cancelled();
    } catch (error) {
      this.failBeforeDispatch(task, error);
      throw error;
    }
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
      void this.cancel(input.sessionId, id).catch(() => {});
    };
    parentSignal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, input.allocation.durationMs);
    const live = {
      controller,
      finished: Promise.resolve(task),
      unlink: () => parentSignal.removeEventListener("abort", abort),
      timer,
    } as Live;
    this.live.set(id, live);
    live.finished = this.dispatch(task, workspace, input.prompt, live).finally(
      () => {
        clearTimeout(timer);
        live.unlink();
        this.live.delete(id);
      },
    );
    live.finished.catch(() => {});
    if (parentSignal.aborted) abort();
    return clone(task);
  }
  private async dispatch(
    task: ChildTaskRecord,
    workspace: Workspace,
    prompt: string,
    live: Live,
  ): Promise<ChildTaskRecord> {
    const pending = Promise.resolve().then(() =>
      this.options.host.start({
        task: clone(task),
        workspace,
        prompt,
        signal: live.controller.signal,
      }),
    );
    let discarded = false;
    const lateCleanup = pending.then(async (handle) => {
      if (
        (!discarded && !live.controller.signal.aborted) ||
        live.handle === handle
      )
        return;
      await handle.cancel();
      await handle.wait();
    });
    this.pendingCleanup.add(lateCleanup);
    lateCleanup
      .finally(() => this.pendingCleanup.delete(lateCleanup))
      .catch(() => {});
    try {
      const handle = await abortable(pending, live.controller.signal);
      if (
        !handle ||
        typeof handle.runId !== "string" ||
        !handle.runId ||
        typeof handle.wait !== "function" ||
        typeof handle.cancel !== "function"
      )
        throw new EngineError(
          "INVALID_CHILD_HANDLE",
          "Host did not return an owned child run handle",
        );
      live.handle = handle;
      this.update(task.sessionId, task.id, {
        state: live.controller.signal.aborted ? "cancelling" : "running",
        childRunId: handle.runId,
      });
      if (!live.controller.signal.aborted && handle.admitted) {
        const result: unknown = handle.admitted();
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => {});
          throw new EngineError('INVALID_CHILD_ADMISSION_HOOK', 'Child provider admission must synchronously return void');
        }
      }
      if (live.controller.signal.aborted)
        await within(handle.cancel(), this.timeout);
      const outcome = await abortable(
        handle.wait(),
        live.controller.signal,
      ).catch(async (error) => {
        if (!live.controller.signal.aborted) throw error;
        await within(handle.cancel(), this.timeout);
        return within(handle.wait(), this.timeout);
      });
      const bounded = boundedOutcome(outcome, task.budget);
      const result = this.update(task.sessionId, task.id, {
        state: bounded.state,
        outcome: bounded,
      });
      this.options.worktrees.releaseOwnership(
        task.sessionId,
        task.worktreeId,
        task.id,
      );
      return result;
    } catch (error) {
      discarded = !live.handle;
      if (live.handle) {
        try {
          await within(live.handle.cancel(), this.timeout);
          await within(live.handle.wait(), this.timeout);
        } catch {}
      }
      if (discarded && live.controller.signal.aborted) {
        try {
          await within(lateCleanup, this.timeout);
        } catch {}
      }
      // A thrown dispatch or rejected wait cannot prove that provider/tools never ran.
      return this.update(task.sessionId, task.id, {
        state: "uncertain",
        errorCode:
          error instanceof EngineError
            ? error.code
            : "CHILD_EXECUTION_UNCERTAIN",
      });
    }
  }
  async wait(sessionId: string, id: string): Promise<ChildTaskRecord> {
    this.get(sessionId, id);
    return this.live.get(id)?.finished ?? this.get(sessionId, id);
  }
  async cancel(sessionId: string, id: string): Promise<ChildTaskRecord> {
    const task = this.get(sessionId, id);
    if (TERMINAL.includes(task.state)) return task;
    const live = this.live.get(id);
    if (!live)
      return this.update(sessionId, id, {
        state: "uncertain",
        errorCode: "CHILD_OWNER_UNAVAILABLE",
      });
    this.update(sessionId, id, { state: "cancelling" });
    live.controller.abort();
    try {
      if (live.handle) await within(live.handle.cancel(), this.timeout);
      return await within(live.finished, this.timeout * 2);
    } catch {
      return this.update(sessionId, id, {
        state: "uncertain",
        errorCode: "CHILD_CLEANUP_UNCERTAIN",
      });
    }
  }
  async deliver(sessionId: string, id: string): Promise<ChildTaskRecord> {
    const task = this.get(sessionId, id);
    if (task.deliveryState === "delivered") return task;
    if (
      !task.outcome ||
      !["completed", "failed", "cancelled"].includes(task.state)
    )
      throw new EngineError(
        "CHILD_RESULT_UNAVAILABLE",
        "Only an observed terminal child outcome can be delivered",
      );
    this.update(sessionId, id, { deliveryState: "pending" });
    const receipt = await this.options.host.acceptResult({
      sessionId,
      parentRunId: task.parentRunId,
      requestId: task.deliveryRequestId,
      childTaskId: id,
      outcome: clone(task.outcome),
    });
    if (
      !receipt ||
      typeof receipt.inputId !== "string" ||
      !receipt.inputId ||
      Buffer.byteLength(receipt.inputId) > 256
    )
      throw new EngineError(
        "INVALID_CHILD_DELIVERY",
        "Host did not acknowledge a durable result input",
      );
    const current = this.get(sessionId, id);
    if (
      current.deliveryState === "delivered" &&
      current.inputId !== receipt.inputId
    )
      throw new EngineError(
        "CHILD_DELIVERY_CONFLICT",
        "Host returned different input identities for one durable result request",
      );
    return this.update(sessionId, id, {
      deliveryState: "delivered",
      inputId: receipt.inputId,
    });
  }
  recover(sessionId: string): ChildTaskRecord[] {
    const journal = this.journal(sessionId);
    const changed: ChildTaskRecord[] = [];
    for (const task of journal.tasks)
      if (!TERMINAL.includes(task.state) && !this.live.has(task.id)) {
        task.state = "uncertain";
        task.errorCode = "CHILD_OWNER_UNAVAILABLE";
        task.updatedAt = new Date(this.now()).toISOString();
        changed.push(clone(task));
      }
    if (changed.length) this.commit(sessionId, journal);
    return changed;
  }
  async close(): Promise<void> {
    this.closing = true;
    const tasks = [...this.live.entries()];
    for (const [, live] of tasks) live.controller.abort();
    const results = await Promise.allSettled(
      tasks.map(async ([id, live]) => {
        if (live.handle) await within(live.handle.cancel(), this.timeout);
        return within(live.finished, this.timeout * 2);
      }),
    );
    const pending = await Promise.allSettled(
      [...this.pendingCleanup].map((p) => within(p, this.timeout)),
    );
    if (
      results.some(
        (r) => r.status === "rejected" || r.value.state === "uncertain",
      ) ||
      pending.some((r) => r.status === "rejected")
    )
      throw new EngineError(
        "CHILD_CLEANUP_UNCERTAIN",
        "One or more child runs could not confirm cleanup before host shutdown",
      );
  }
}
