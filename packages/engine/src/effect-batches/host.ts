import {
  EngineError,
  type ProviderToolCall,
  type ToolCallRecord,
} from "@moodcode/contracts";
import type { ToolContext } from "../ports.js";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  acquireExecutionLock,
  assertExecutionLockCurrent,
  reserveExecutionLock,
  readExecutionLockReservation,
  type ExecutionLock,
} from "../tools/command/execution-lock.js";
import {
  assertPreparedResourceCurrent,
  planPreparedResources,
  issueResourcePermit,
  readPreparedResource,
  readResourcePermitCleanup,
  resourcePermitConsumed,
} from "./claims.js";
import { signEffectBatch } from "./storage.js";
import type { EffectBatchRecord, EffectBatchMember } from "./types.js";
export interface EffectBatchHostPorts {
  save(record: EffectBatchRecord): void;
  memberSettled(record: EffectBatchRecord, index: number): void;
  assertOpen(): void;
}
export interface EffectBatchAdmission {
  workspaceId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  attemptId: string;
  configSha256: string;
  catalogueSha256: string;
  calls: readonly ProviderToolCall[];
  budget: EffectBatchRecord["budget"];
  executionLockPath: string;
  signal: AbortSignal;
  assertCurrent(): void;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
async function wait(
  promise: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  let abort!: () => void;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        abort = () =>
          reject(
            signal.reason ??
              new EngineError("CANCELLED", "Effect batch cancelled"),
          );
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
/** Constructed only by the Engine. Original resource producers remain private. */
export class EffectBatchHost {
  constructor(private readonly ports: EffectBatchHostPorts) {}
  create(input: EffectBatchAdmission): EffectBatchExecution {
    this.ports.assertOpen();
    input.assertCurrent();
    if (
      input.calls.length < 1 ||
      input.calls.length > 4 ||
      input.budget.toolCalls !== input.calls.length ||
      input.budget.outputBytes < input.calls.length ||
      input.budget.artifactBytes < input.calls.length
    )
      throw new EngineError(
        "EFFECT_BATCH_LIMIT",
        "Effect batch member allocation exceeds the original reservation",
      );
    return new EffectBatchExecution(input, this.ports);
  }
}
export class EffectBatchExecution {
  private readonly arrival = deferred();
  private readonly changed = new Set<() => void>();
  private readonly originals = new Map<number, object>();
  private readonly permits = new Map<number, object>();
  private readonly arrived = new Set<number>();
  private readonly settled = new Set<number>();
  private lease: ExecutionLock | undefined;
  private leaseWave = -1;
  private persistFailure: unknown;
  private rejection: unknown;
  private blocked = false;
  private durable = false;
  private record: EffectBatchRecord;
  constructor(
    private readonly input: EffectBatchAdmission,
    private readonly ports: EffectBatchHostPorts,
  ) {
    const id = knowledgeHash([
      "effect-batch-v1",
      input.workspaceId,
      input.sessionId,
      input.runId,
      input.turnId,
      input.attemptId,
      input.calls.map((c) => c.id),
    ]).slice(0, 32);
    this.record = signEffectBatch({
      version: 1,
      id,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      attemptId: input.attemptId,
      revision: 1,
      previousSha256: null,
      state: "preparing",
      configSha256: input.configSha256,
      catalogueSha256: input.catalogueSha256,
      budget: { ...input.budget },
      mode: "serial",
      fallback: [],
      lockEpoch: null,
      lockReleased: true,
      lockOwnerPid: null,
      executionLockPath: input.executionLockPath,
      createdAt: new Date().toISOString(),
      members: input.calls.map((c) => ({
        providerCallId: c.id,
        toolCallId: null,
        toolName: c.name,
        fingerprint: null,
        claim: null,
        wave: 0,
        state: "proposed",
        approvalId: null,
        startedAt: null,
        endedAt: null,
        cleanupConfirmed: null,
        checkpointIds: [],
        checkpointSha256: [],
        outputBytes: 0,
        outputSha256: null,
        errorCode: null,
      })),
    });
  }
  outputAllocation(): number {
    return this.input.budget.outputBytes;
  }
  attach(index: number, tool: ToolCallRecord): void {
    this.update(index, { toolCallId: tool.id });
  }
  private update(index: number, patch: Partial<EffectBatchMember>): void {
    this.record = {
      ...this.record,
      members: this.record.members.map((m, i) =>
        i === index ? { ...m, ...patch } : m,
      ),
    };
  }
  private publish(state: EffectBatchRecord["state"]): void {
    if (this.persistFailure) throw this.persistFailure;
    const { sha256, ...body } = this.record;
    const next = signEffectBatch({
      ...body,
      revision: this.durable ? this.record.revision + 1 : 1,
      previousSha256: this.durable ? sha256 : null,
      state,
    });
    try {
      this.ports.save(next);
      this.record = next;
      this.durable = true;
    } catch (error) {
      this.persistFailure = error;
      this.blocked = true;
      this.wake();
      throw error;
    }
  }
  private wake(): void {
    for (const notify of this.changed) notify();
    this.changed.clear();
  }
  private arrange(): void {
    const plan = planPreparedResources(this.record.members);
    this.record = {
      ...this.record,
      members: this.record.members.map((m, i) => ({
        ...m,
        wave: plan.waves[i]!,
      })),
      mode: plan.mode,
      fallback: plan.fallback,
    };
  }
  private arrive(index: number): void {
    if (this.arrived.has(index)) return;
    this.arrived.add(index);
    if (this.arrived.size === this.record.members.length) {
      try {
        this.input.assertCurrent();
        this.arrange();
        this.publish("prepared");
      } catch (error) {
        this.persistFailure = error;
        this.blocked = true;
      } finally {
        this.arrival.resolve();
      }
    }
  }
  async prepared(
    index: number,
    fingerprint: string,
    original: object | null,
  ): Promise<void> {
    if (original) this.originals.set(index, original);
    this.update(index, {
      fingerprint,
      claim: original ? readPreparedResource(original) : null,
      state: "prepared",
    });
    this.arrive(index);
    await wait(this.arrival.promise, this.input.signal);
    if (this.persistFailure) throw this.persistFailure;
  }
  async enter(
    index: number,
    context: ToolContext,
    approval?: { id: string; fingerprint: string },
  ): Promise<void> {
    await wait(this.arrival.promise, context.signal);
    if (this.persistFailure) throw this.persistFailure;
    const m = this.record.members[index]!;
    while (
      this.record.members.some(
        (p, i) => p.wave < m.wave && !this.settled.has(i),
      )
    ) {
      const d = deferred();
      this.changed.add(d.resolve);
      try {
        await wait(d.promise, context.signal);
      } finally {
        this.changed.delete(d.resolve);
      }
      if (this.blocked)
        throw new EngineError(
          "CLEANUP_UNCERTAIN",
          "An earlier batch effect remains unconfirmed",
        );
    }
    if (this.blocked)
      throw new EngineError(
        "CLEANUP_UNCERTAIN",
        "Prepared batch ownership or cleanup is unconfirmed",
      );
    this.input.assertCurrent();
    if (
      context.runId !== this.input.runId ||
      context.sessionId !== this.input.sessionId ||
      context.turnId !== this.input.turnId ||
      context.attemptId !== this.input.attemptId ||
      context.toolCallId !== m.toolCallId ||
      context.workspace.id !== this.input.workspaceId ||
      context.signal.aborted
    )
      throw new EngineError(
        "EFFECT_BATCH_CONTEXT_STALE",
        "Actual current member context required",
      );
    const original = this.originals.get(index);
    if (original) {
      if (!approval || approval.fingerprint !== m.fingerprint)
        throw new EngineError(
          "EFFECT_BATCH_APPROVAL_REQUIRED",
          "Prepared effect member needs exact original approval",
        );
      await assertPreparedResourceCurrent(original, context.signal);
      this.input.assertCurrent();
      if (this.blocked)
        throw new EngineError(
          "CLEANUP_UNCERTAIN",
          "Effect batch is quarantined",
        );
      if (!this.lease) {
        const reservation = reserveExecutionLock(this.input.executionLockPath),
          marker = readExecutionLockReservation(reservation);
        this.lease = acquireExecutionLock(
          this.input.executionLockPath,
          reservation,
        );
        this.leaseWave = m.wave;
        this.record = {
          ...this.record,
          lockEpoch: marker.updatedAt,
          lockReleased: false,
          lockOwnerPid: marker.ownerPid,
        };
      }
      if (this.leaseWave !== m.wave)
        throw new EngineError(
          "EFFECT_BATCH_LOCK_STALE",
          "Batch resource wave differs from its physical lease",
        );
      assertExecutionLockCurrent(this.lease);
    }
    this.update(index, {
      state: "running",
      approvalId: approval?.id ?? null,
      startedAt: new Date().toISOString(),
    });
    try {
      this.publish("running");
    } catch (error) {
      if (this.lease && !this.permits.size) {
        this.lease.release(true);
        this.lease = undefined;
      }
      throw error;
    }
    context.effectBatchArtifactLimit = Math.max(
      1,
      Math.floor(this.input.budget.artifactBytes / this.record.members.length),
    );
    if (original) {
      const lease = this.lease!;
      const permit = issueResourcePermit(original, context, () => {
        this.input.assertCurrent();
        if (this.blocked)
          throw new EngineError(
            "CLEANUP_UNCERTAIN",
            "Effect batch resource permit is quarantined",
          );
        assertExecutionLockCurrent(lease);
      });
      this.permits.set(index, permit);
      context.effectBatchPermit = permit;
    }
  }
  reject(error: unknown): void {
    this.rejection ??= error;
    this.arrival.resolve();
    this.wake();
  }
  finish(
    index: number,
    tool: ToolCallRecord,
    checkpoints: readonly { id: string; sha256: string }[],
    fallbackCleanup: boolean | null = true,
  ): void {
    if (this.settled.has(index)) return;
    const permit = this.permits.get(index),
      used = permit ? resourcePermitConsumed(permit) : false;
    let cleanup = permit
      ? (readResourcePermitCleanup(permit) ?? (used ? null : true))
      : fallbackCleanup;
    if (this.lease) {
      try {
        assertExecutionLockCurrent(this.lease);
      } catch {
        cleanup = null;
        this.blocked = true;
      }
    }
    const state =
      cleanup !== true
        ? "uncertain"
        : tool.state === "completed"
          ? "completed"
          : tool.state === "denied"
            ? "denied"
            : tool.state === "interrupted"
              ? "cancelled"
              : "failed";
    this.update(index, {
      state,
      endedAt: new Date().toISOString(),
      cleanupConfirmed: cleanup,
      checkpointIds: checkpoints.map((c) => c.id),
      checkpointSha256: checkpoints.map((c) => c.sha256),
      outputBytes: Buffer.byteLength(tool.output ?? ""),
      outputSha256: knowledgeHash(tool.output ?? null),
      errorCode: tool.error?.slice(0, 256) ?? null,
    });
    this.settled.add(index);
    if (cleanup !== true) this.blocked = true;
    try {
      this.ports.memberSettled(this.record, index);
      this.arrive(index);
      if (this.durable && !this.persistFailure)
        this.publish(this.blocked ? "uncertain" : "running");
      if (
        this.lease &&
        this.record.members.every(
          (m, i) => m.wave !== this.leaseWave || this.settled.has(i),
        )
      ) {
        const clean = !this.blocked && !this.persistFailure;
        this.lease.release(clean);
        this.lease = undefined;
        this.record = { ...this.record, lockReleased: clean };
      }
      if (
        this.durable &&
        !this.persistFailure &&
        this.settled.size === this.record.members.length
      )
        this.publish(
          this.blocked
            ? "uncertain"
            : this.record.members.every((m) => m.state === "completed")
              ? "completed"
              : "partial",
        );
    } catch {
      this.blocked = true;
      if (this.lease) {
        try {
          this.lease.release(false);
        } catch {}
        this.lease = undefined;
      }
      throw new EngineError(
        "CLEANUP_UNCERTAIN",
        "Effect batch member receipt or lease release could not be committed",
      );
    } finally {
      this.wake();
    }
  }
  close(): void {
    if (this.lease) {
      this.lease.release(false);
      this.lease = undefined;
    }
    if (this.persistFailure) {
      if (this.record.members.some((m) => m.startedAt))
        throw new EngineError(
          "CLEANUP_UNCERTAIN",
          "Effect batch effect or durable settlement remains unconfirmed",
        );
      throw this.persistFailure;
    }
    if (this.blocked)
      throw new EngineError(
        "CLEANUP_UNCERTAIN",
        "Effect batch requires explicit reconciliation",
      );
    if (this.rejection) throw this.rejection;
  }
}
