import { randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { InputRecord, JsonObject, Workspace } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import { sha256Hex } from "../shared/canonical.js";
import type {
  ScheduleSpec,
  ScheduleSpecInput,
  ScheduleOccurrenceCandidate,
  ScheduleTargetPin,
} from "./types.js";
import { validateScheduleSpec } from "./spec.js";
import {
  formatScheduleInput,
  validateScheduleOccurrence,
  validateScheduleCursor,
  initialScheduleCursor,
} from "./occurrences.js";
import {
  SCHEDULE_STORAGE_LIMITS,
  ScheduleJournal,
  digest,
  fail,
  id,
  integer,
  json,
  signed,
  type Revision,
  type ScheduleAcceptedInputProof,
  type ScheduleDueBatchProof,
  type ScheduleInputObservationProof,
  type ScheduleOccurrenceState,
  type ScheduleRequestResult,
  type ScheduleRevision,
  type ScheduleTargetProof,
  type SchedulerLease,
  type SchedulerWorkerProof,
  type TriggerOccurrence,
} from "./journal.js";
export {
  SCHEDULE_STORAGE_LIMITS,
  markImportedSchedulesDisabled,
  validateScheduleDatabase,
} from "./journal.js";
export type {
  ScheduleAcceptedInputProof,
  ScheduleDueBatchProof,
  ScheduleInputObservationProof,
  ScheduleOccurrenceState,
  ScheduleRequestResult,
  ScheduleRevision,
  ScheduleTargetProof,
  ScheduleTransitionReceipt,
  SchedulerLease,
  SchedulerWorkerProof,
  TriggerOccurrence,
} from "./journal.js";
export interface ScheduleTriggerProof {
  readonly workspaceId: string;
  readonly scheduleId: string;
  readonly scheduleRevisionId: string;
  readonly scheduleSha256: string;
  readonly candidate: ScheduleOccurrenceCandidate;
  readonly sha256: string;
}
export interface ScheduleStoragePorts {
  writeTx<T>(operation: () => T): T;
  getWorkspace(workspaceId: string): Workspace;
  readWorker(original: object): SchedulerWorkerProof;
  assertWorkerCurrent(
    original: object,
    expected: SchedulerWorkerProof,
    phase: "dispatch" | "observe",
  ): void;
  readTarget(original: object): ScheduleTargetProof;
  assertTargetCurrent(
    original: object,
    expected: ScheduleTargetProof,
    spec: ScheduleSpec,
  ): void;
  readTrigger(original: object): ScheduleTriggerProof;
  assertTriggerCurrent(
    original: object,
    expected: ScheduleTriggerProof,
    spec: ScheduleSpec,
  ): void;
  readAcceptedInput(original: object): ScheduleAcceptedInputProof;
  readInputObservation(original: object): ScheduleInputObservationProof;
  readDueBatch(original: object): ScheduleDueBatchProof;
  assertDueBatchCurrent(
    original: object,
    proof: ScheduleDueBatchProof,
    spec: ScheduleSpec,
  ): void;
  readonly now?: () => number;
}
export interface RegisterScheduleInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly spec: ScheduleSpecInput;
}
export interface DisableScheduleInput {
  readonly workspaceId: string;
  readonly scheduleId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
}
export interface AcceptScheduleTriggerInput {
  readonly workspaceId: string;
  readonly scheduleId: string;
  readonly requestId: string;
  readonly expectedScheduleRevision: number;
}
export interface AcquireSchedulerLeaseInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly ttlMs: number;
}
export interface ClaimScheduleOccurrenceInput {
  readonly workspaceId: string;
  readonly occurrenceId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
}
export interface DispatchScheduleClaimInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly inputRequestId: string;
  readonly prompt: string;
}
export interface SettleScheduleClaimInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
}
export interface ScheduleClaimImage {
  readonly authority: "dispatch" | "observe";
  readonly workspaceId: string;
  readonly scheduleId: string;
  readonly occurrenceId: string;
  readonly occurrenceRevision: number;
  readonly scheduleRevisionId: string;
  readonly scheduleSha256: string;
  readonly occurrenceSha256: string;
  readonly leaseSha256: string | null;
  readonly inputRequestId: string;
  readonly target: ScheduleTargetPin;
  readonly prompt: string;
  readonly data: JsonObject;
  readonly candidate: ScheduleOccurrenceCandidate;
  readonly sha256: string;
}
export interface ScheduleClaimResult extends ScheduleRequestResult<TriggerOccurrence> {
  readonly claim?: object;
}
export interface SchedulerLeaseResult extends ScheduleRequestResult<SchedulerLease> {
  readonly lease?: object;
}
export interface ScheduleInputBinding {
  readonly occurrence: TriggerOccurrence;
  readonly schedule: ScheduleRevision;
  readonly target: ScheduleTargetPin;
}
export interface AdvanceScheduleDueInput extends DisableScheduleInput {}
export interface ScheduleDueResult extends ScheduleRequestResult<ScheduleRevision> {
  readonly occurrences: readonly TriggerOccurrence[];
}
export interface AbandonScheduleClaimInput extends SettleScheduleClaimInput {
  readonly operation: "cancelled" | "uncertain";
  readonly errorCode: string;
}
type Cap = {
  authority: "dispatch" | "observe";
  worker: object;
  workerProof: SchedulerWorkerProof;
  occurrenceId: string;
  image: ScheduleClaimImage;
  claimToken: string | null;
};
function data<T>(input: T, required: readonly string[]): T {
  const value = json(input);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key))
  )
    fail("INVALID_SCHEDULE_INPUT");
  return value;
}
function sync(value: unknown): void {
  if (value !== undefined) {
    void Promise.resolve(value).catch(() => {});
    fail("SCHEDULE_ORIGINAL_REQUIRED");
  }
}

/** Actual primary SQLite transactions; native original claims never derive authority from serialized DTOs. */
export class ScheduleStorage extends ScheduleJournal {
  private readonly leases = new WeakMap<
    object,
    { worker: object; proof: SchedulerWorkerProof; lease: SchedulerLease }
  >();
  private readonly claims = new WeakMap<object, Cap>();
  constructor(
    db: DatabaseSync,
    private readonly ports: ScheduleStoragePorts,
  ) {
    super(db, () => ports.now?.() ?? Date.now());
  }
  private worker(
    original: object,
    phase: "dispatch" | "observe",
  ): SchedulerWorkerProof {
    const proof = digest(this.ports.readWorker(original));
    id(proof.workspaceId);
    id(proof.ownerEpoch);
    if (this.ports.getWorkspace(proof.workspaceId).id !== proof.workspaceId)
      fail();
    sync(this.ports.assertWorkerCurrent(original, proof, phase));
    return proof;
  }
  registerSchedule(
    original: object,
    input: RegisterScheduleInput,
  ): ScheduleRequestResult<ScheduleRevision> {
    const safe = data(input, [
        "workspaceId",
        "requestId",
        "expectedRevision",
        "spec",
      ]),
      spec = validateScheduleSpec(safe.spec),
      request = json({
        ...safe,
        spec,
        operation: "register",
      }) as unknown as JsonObject,
      scope = `schedule:${spec.id}`,
      prior = this.duplicate<ScheduleRevision>(
        id(safe.workspaceId),
        scope,
        id(safe.requestId),
        knowledgeHash(request),
      );
    if (prior) return prior;
    return this.ports.writeTx(() => {
      const duplicate = this.duplicate<ScheduleRevision>(
        safe.workspaceId,
        scope,
        safe.requestId,
        knowledgeHash(request),
      );
      if (duplicate) return duplicate;
      const before = this.getSchedule(safe.workspaceId, spec.id);
      if ((before?.revision ?? 0) !== integer(safe.expectedRevision))
        fail("SCHEDULE_STALE");
      const proof = digest(this.ports.readTarget(original));
      this.target(proof, spec);
      sync(this.ports.assertTargetCurrent(original, proof, spec));
      if (proof.workspaceId !== safe.workspaceId) fail();
      if (
        !before &&
        (Number(
          this.db
            .prepare(
              "SELECT count(*) AS n FROM schedule_heads WHERE kind='schedule'",
            )
            .get()!.n,
        ) >= SCHEDULE_STORAGE_LIMITS.globalSchedules ||
          this.inspectSchedules(safe.workspaceId).length >=
            SCHEDULE_STORAGE_LIMITS.schedules)
      )
        fail("SCHEDULE_LIMIT");
      return this.commit(
        "schedule",
        spec.id,
        this.revise(
          {
            workspaceId: safe.workspaceId,
            scheduleId: spec.id,
            spec,
            target: proof,
            worker: null,
            cursor: initialScheduleCursor(spec),
            due: null,
          },
          before,
        ),
        before,
        "register",
        request,
      );
    });
  }
  disableSchedule(
    input: DisableScheduleInput,
  ): ScheduleRequestResult<ScheduleRevision> {
    const safe = data(input, [
        "workspaceId",
        "scheduleId",
        "requestId",
        "expectedRevision",
      ]),
      request = { ...safe, operation: "disable" } as JsonObject;
    return this.ports.writeTx(() => {
      const duplicate = this.duplicate<ScheduleRevision>(
        safe.workspaceId,
        `schedule:${safe.scheduleId}`,
        safe.requestId,
        knowledgeHash(request),
      );
      if (duplicate) return duplicate;
      const before = this.getSchedule(safe.workspaceId, safe.scheduleId);
      if (!before || before.revision !== safe.expectedRevision)
        fail("SCHEDULE_STALE");
      const { sha256: _sha, ...definition } = before.spec;
      const spec = validateScheduleSpec({ ...definition, enabled: false });
      return this.commit(
        "schedule",
        safe.scheduleId,
        this.revise(
          {
            ...before,
            spec,
            cursor: initialScheduleCursor(spec),
            due: null,
            worker: null,
          },
          before,
        ),
        before,
        "disable",
        request,
      );
    });
  }
  acquireLease(
    original: object,
    input: AcquireSchedulerLeaseInput,
  ): SchedulerLeaseResult {
    const safe = data(input, [
        "workspaceId",
        "requestId",
        "expectedRevision",
        "ttlMs",
      ]),
      request = { ...safe, operation: "lease-acquire" } as JsonObject,
      duplicate = this.duplicate<SchedulerLease>(
        safe.workspaceId,
        "lease:scheduler",
        safe.requestId,
        knowledgeHash(request),
      );
    if (duplicate) return duplicate;
    const result = this.ports.writeTx(() => {
      const before = this.getLease(safe.workspaceId),
        now = this.now(),
        worker = this.worker(original, "dispatch");
      if (
        worker.workspaceId !== safe.workspaceId ||
        (before?.revision ?? 0) !== safe.expectedRevision
      )
        fail("SCHEDULE_STALE");
      if (before && now < Date.parse(before.lastClockAt))
        fail("SCHEDULE_CLOCK_ROLLBACK");
      if (before && Date.parse(before.expiresAt) > now)
        fail("SCHEDULE_LEASE_BUSY");
      const ttl = integer(
        safe.ttlMs,
        SCHEDULE_STORAGE_LIMITS.leaseMinMs,
        SCHEDULE_STORAGE_LIMITS.leaseMaxMs,
      );
      return this.commit(
        "lease",
        "scheduler",
        this.revise(
          {
            workspaceId: safe.workspaceId,
            worker,
            generation: (before?.generation ?? 0) + 1,
            expiresAt: new Date(now + ttl).toISOString(),
            lastClockAt: new Date(now).toISOString(),
          },
          before,
        ),
        before,
        "lease-acquire",
        request,
      );
    });
    const lease = Object.freeze({});
    this.leases.set(lease, {
      worker: original,
      proof: result.record.worker,
      lease: result.record,
    });
    return { ...result, lease };
  }
  renewLease(
    original: object,
    input: AcquireSchedulerLeaseInput,
  ): SchedulerLeaseResult {
    const safe = data(input, [
        "workspaceId",
        "requestId",
        "expectedRevision",
        "ttlMs",
      ]),
      request = { ...safe, operation: "lease-renew" } as JsonObject,
      duplicate = this.duplicate<SchedulerLease>(
        safe.workspaceId,
        "lease:scheduler",
        safe.requestId,
        knowledgeHash(request),
      );
    if (duplicate) return duplicate;
    const cap = this.leases.get(original);
    if (!cap) fail("SCHEDULE_ORIGINAL_REQUIRED");
    const result = this.ports.writeTx(() => {
      const before = this.getLease(safe.workspaceId),
        now = this.now();
      if (
        !before ||
        before.revision !== safe.expectedRevision ||
        before.generation !== cap.lease.generation ||
        before.worker.sha256 !== cap.proof.sha256 ||
        Date.parse(before.expiresAt) <= now
      )
        fail("SCHEDULE_LEASE_STALE");
      if (now < Date.parse(before.lastClockAt)) fail("SCHEDULE_CLOCK_ROLLBACK");
      this.worker(cap.worker, "dispatch");
      const ttl = integer(safe.ttlMs, 1000, 300000);
      return this.commit(
        "lease",
        "scheduler",
        this.revise(
          {
            ...before,
            expiresAt: new Date(now + ttl).toISOString(),
            lastClockAt: new Date(now).toISOString(),
          },
          before,
        ),
        before,
        "lease-renew",
        request,
      );
    });
    const lease = Object.freeze({});
    this.leases.set(lease, { ...cap, lease: result.record });
    return { ...result, lease };
  }
  private occurrenceBudget(): void {
    if (
      Number(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM schedule_heads WHERE kind='occurrence'",
          )
          .get()!.n,
      ) >= SCHEDULE_STORAGE_LIMITS.globalOccurrences
    )
      fail("SCHEDULE_LIMIT");
  }
  private candidateRecord(
    schedule: ScheduleRevision,
    candidate: ScheduleOccurrenceCandidate,
  ): TriggerOccurrence {
    return this.revise({
      workspaceId: schedule.workspaceId,
      occurrenceId: candidate.occurrenceId,
      scheduleId: schedule.scheduleId,
      scheduleRevisionId: schedule.id,
      scheduleSha256: schedule.spec.sha256,
      candidate,
      state: "queued",
      leaseRevisionId: null,
      leaseSha256: null,
      worker: null,
      generation: null,
      claimToken: null,
      inputRequestId: candidate.inputRequestId,
      prompt: null,
      promptSha256: null,
      input: null,
      observation: null,
      errorCode: null,
    });
  }
  acceptTrigger(
    original: object,
    input: AcceptScheduleTriggerInput,
  ): ScheduleRequestResult<TriggerOccurrence> {
    const safe = data(input, [
      "workspaceId",
      "scheduleId",
      "requestId",
      "expectedScheduleRevision",
    ]);
    return this.ports.writeTx(() => {
      const proof = digest(this.ports.readTrigger(original)),
        schedule = this.getSchedule(safe.workspaceId, safe.scheduleId);
      if (
        !schedule ||
        schedule.revision !== safe.expectedScheduleRevision ||
        !schedule.spec.enabled ||
        proof.workspaceId !== safe.workspaceId ||
        proof.scheduleId !== safe.scheduleId ||
        proof.scheduleRevisionId !== schedule.id ||
        proof.scheduleSha256 !== schedule.spec.sha256
      )
        fail("SCHEDULE_TRIGGER_STALE");
      const candidate = validateScheduleOccurrence(
          proof.candidate,
          schedule.spec,
        ),
        identity = {
          scheduleId: schedule.scheduleId,
          triggerKey: candidate.triggerKey,
          dataSha256: candidate.dataSha256,
        };
      const prior = this.inspectOccurrences(
        safe.workspaceId,
        safe.scheduleId,
      ).find((row) => row.candidate.triggerKey === candidate.triggerKey);
      if (prior) {
        if (prior.candidate.dataSha256 !== candidate.dataSha256)
          fail("SCHEDULE_REQUEST_CONFLICT");
        return { record: prior, receipt: this.receipt(prior), duplicate: true };
      }
      const request = {
        ...safe,
        operation: "trigger",
        identity,
      } as unknown as JsonObject;
      const duplicate = this.duplicate<TriggerOccurrence>(
        safe.workspaceId,
        `occurrence:${candidate.occurrenceId}`,
        safe.requestId,
        knowledgeHash(request),
      );
      if (duplicate) return duplicate;
      sync(this.ports.assertTriggerCurrent(original, proof, schedule.spec));
      this.occurrenceBudget();
      if (this.inspectOccurrences(safe.workspaceId).length >= 512)
        fail("SCHEDULE_LIMIT");
      const record = this.candidateRecord(schedule, candidate);
      return this.commit(
        "occurrence",
        candidate.occurrenceId,
        record,
        undefined,
        "trigger",
        request,
      );
    });
  }
  private issueClaim(
    worker: object,
    proof: SchedulerWorkerProof,
    record: TriggerOccurrence,
    authority: "dispatch" | "observe",
  ): object {
    const schedule = this.scheduleFor(record),
      image = signed({
        authority,
        workspaceId: record.workspaceId,
        scheduleId: record.scheduleId,
        occurrenceId: record.occurrenceId,
        occurrenceRevision: record.revision,
        scheduleRevisionId: record.scheduleRevisionId,
        scheduleSha256: record.scheduleSha256,
        occurrenceSha256: record.sha256,
        leaseSha256: record.leaseSha256,
        inputRequestId: record.inputRequestId,
        target: schedule.spec.target,
        prompt:
          authority === "dispatch"
            ? schedule.spec.prompt
            : (record.prompt ??
              formatScheduleInput(schedule.spec, record.candidate)),
        data: record.candidate.data,
        candidate: record.candidate,
      });
    const original = Object.freeze({});
    this.claims.set(original, {
      worker,
      workerProof: proof,
      occurrenceId: record.occurrenceId,
      authority,
      image,
      claimToken: record.claimToken,
    });
    return original;
  }
  claimOccurrence(
    originalWorker: object,
    originalLease: object,
    input: ClaimScheduleOccurrenceInput,
  ): ScheduleClaimResult {
    const safe = data(input, [
        "workspaceId",
        "occurrenceId",
        "requestId",
        "expectedRevision",
      ]),
      request = { ...safe, operation: "claim" } as JsonObject,
      duplicate = this.duplicate<TriggerOccurrence>(
        safe.workspaceId,
        `occurrence:${safe.occurrenceId}`,
        safe.requestId,
        knowledgeHash(request),
      );
    if (duplicate) return duplicate;
    const cap = this.leases.get(originalLease);
    if (!cap || cap.worker !== originalWorker)
      fail("SCHEDULE_ORIGINAL_REQUIRED");
    const result = this.ports.writeTx(() => {
      const worker = this.worker(originalWorker, "dispatch"),
        before = this.getOccurrence(safe.workspaceId, safe.occurrenceId),
        lease = this.getLease(safe.workspaceId),
        now = this.now();
      if (
        !before ||
        before.revision !== safe.expectedRevision ||
        before.state !== "queued" ||
        !lease ||
        lease.generation !== cap.lease.generation ||
        lease.worker.sha256 !== worker.sha256 ||
        Date.parse(lease.expiresAt) <= now
      )
        fail("SCHEDULE_CLAIM_STALE");
      if (now < Date.parse(lease.createdAt)) fail("SCHEDULE_CLOCK_ROLLBACK");
      const schedule = this.scheduleFor(before),
        current = this.getSchedule(safe.workspaceId, before.scheduleId);
      if (
        !current?.spec.enabled ||
        current.spec.sha256 !== schedule.spec.sha256
      )
        fail("SCHEDULE_DISABLED");
      const active = this.inspectOccurrences(
        safe.workspaceId,
        before.scheduleId,
      ).filter((row) =>
        [
          "claimed",
          "dispatching",
          "accepted",
          "promoted",
          "uncertain",
        ].includes(row.state),
      );
      if (active.length >= schedule.spec.concurrency)
        fail("SCHEDULE_CONCURRENCY_LIMIT");
      return this.commit(
        "occurrence",
        before.occurrenceId,
        this.revise(
          {
            ...before,
            state: "claimed" as const,
            leaseRevisionId: lease.id,
            leaseSha256: lease.sha256,
            worker,
            generation: lease.generation,
            claimToken: randomUUID(),
          },
          before,
          now,
        ),
        before,
        "claim",
        request,
      );
    });
    return {
      ...result,
      claim: this.issueClaim(
        originalWorker,
        result.record.worker!,
        result.record,
        "dispatch",
      ),
    };
  }
  readClaim(original: object): ScheduleClaimImage {
    const cap = this.claims.get(original);
    if (!cap || cap.authority !== "dispatch")
      fail("SCHEDULE_ORIGINAL_REQUIRED");
    return json(cap.image);
  }
  readObservation(original: object): ScheduleClaimImage {
    const cap = this.claims.get(original);
    if (!cap || cap.authority !== "observe") fail("SCHEDULE_ORIGINAL_REQUIRED");
    return json(cap.image);
  }
  assertClaimCurrent(original: object, phase: "dispatch" | "observe"): void {
    const cap = this.claims.get(original);
    if (!cap || (phase === "dispatch" && cap.authority !== "dispatch"))
      fail("SCHEDULE_ORIGINAL_REQUIRED");
    const worker = this.worker(cap.worker, phase),
      record = this.getOccurrence(cap.image.workspaceId, cap.occurrenceId);
    if (
      worker.sha256 !== cap.workerProof.sha256 ||
      !record ||
      record.scheduleRevisionId !== cap.image.scheduleRevisionId ||
      (cap.authority === "dispatch" && record.claimToken !== cap.claimToken)
    )
      fail("SCHEDULE_CLAIM_STALE");
    if (phase === "dispatch") {
      const lease = this.getLease(record.workspaceId),
        schedule = this.getSchedule(record.workspaceId, record.scheduleId);
      if (
        !["claimed", "dispatching"].includes(record.state) ||
        !lease ||
        lease.worker.sha256 !== worker.sha256 ||
        lease.generation !== record.generation ||
        Date.parse(lease.expiresAt) <= this.now() ||
        !schedule?.spec.enabled ||
        schedule.spec.sha256 !== record.scheduleSha256
      )
        fail("SCHEDULE_CLAIM_STALE");
    } else if (
      cap.authority === "observe" &&
      record.revision !== cap.image.occurrenceRevision
    )
      fail("SCHEDULE_STALE");
  }
  captureOccurrenceObservation(
    original: object,
    input: ClaimScheduleOccurrenceInput,
  ): object {
    const safe = data(input, [
        "workspaceId",
        "occurrenceId",
        "requestId",
        "expectedRevision",
      ]),
      worker = this.worker(original, "observe"),
      record = this.getOccurrence(safe.workspaceId, safe.occurrenceId);
    if (
      worker.workspaceId !== safe.workspaceId ||
      !record ||
      record.revision !== safe.expectedRevision ||
      ![
        "dispatching",
        "accepted",
        "promoted",
        "completed",
        "failed",
        "cancelled",
        "uncertain",
      ].includes(record.state)
    )
      fail("SCHEDULE_STALE");
    return this.issueClaim(original, worker, record, "observe");
  }
  private mutate(
    original: object,
    input: SettleScheduleClaimInput,
    operation: string,
    update: (
      before: TriggerOccurrence,
    ) => Omit<TriggerOccurrence, keyof Revision>,
    phase: "dispatch" | "observe",
  ): ScheduleRequestResult<TriggerOccurrence> {
    const safe = json(input),
      cap = this.claims.get(original);
    if (!cap) fail("SCHEDULE_ORIGINAL_REQUIRED");
    const request = {
        ...safe,
        ...(Object.hasOwn(safe, "operation")
          ? { requestedOperation: Reflect.get(safe, "operation") }
          : {}),
        operation,
      } as unknown as JsonObject,
      scope = `occurrence:${cap.occurrenceId}`,
      duplicate = this.duplicate<TriggerOccurrence>(
        safe.workspaceId,
        scope,
        id(safe.requestId),
        knowledgeHash(request),
      );
    if (duplicate) return duplicate;
    return this.ports.writeTx(() => {
      const prior = this.duplicate<TriggerOccurrence>(
        safe.workspaceId,
        scope,
        safe.requestId,
        knowledgeHash(request),
      );
      if (prior) return prior;
      this.assertClaimCurrent(original, phase);
      const before = this.getOccurrence(safe.workspaceId, cap.occurrenceId);
      if (
        !before ||
        before.revision !== safe.expectedRevision ||
        safe.workspaceId !== cap.image.workspaceId
      )
        fail("SCHEDULE_STALE");
      const now = this.now();
      if (
        before.leaseRevisionId !== null &&
        now <
          Date.parse(
            this.read<SchedulerLease>(
              before.leaseRevisionId,
              before.workspaceId,
              "lease",
            ).createdAt,
          )
      )
        fail("SCHEDULE_CLOCK_ROLLBACK");
      return this.commit(
        "occurrence",
        before.occurrenceId,
        this.revise(update(before), before, now),
        before,
        operation,
        request,
      );
    });
  }
  dispatchClaim(
    original: object,
    input: DispatchScheduleClaimInput,
  ): ScheduleRequestResult<TriggerOccurrence> {
    const safe = data(input, [
      "workspaceId",
      "requestId",
      "expectedRevision",
      "prompt",
      "inputRequestId",
    ]);
    return this.mutate(
      original,
      safe,
      "dispatch",
      (before) => {
        const schedule = this.scheduleFor(before);
        if (
          before.state !== "claimed" ||
          safe.inputRequestId !== before.inputRequestId ||
          safe.prompt !== formatScheduleInput(schedule.spec, before.candidate)
        )
          fail("SCHEDULE_INPUT_INVALID");
        return {
          ...before,
          state: "dispatching",
          prompt: safe.prompt,
          promptSha256: sha256Hex(safe.prompt),
        };
      },
      "dispatch",
    );
  }
  completeAccepted(
    original: object,
    accepted: object,
    input: SettleScheduleClaimInput,
  ): ScheduleRequestResult<TriggerOccurrence> {
    const safe = data(input, ["workspaceId", "requestId", "expectedRevision"]);
    return this.mutate(
      original,
      safe,
      "accepted",
      (before) => {
        if (!["dispatching", "uncertain"].includes(before.state))
          fail("SCHEDULE_STALE");
        const proof = digest(this.ports.readAcceptedInput(accepted)),
          record = this.inputRecord(this.scheduleFor(before), before);
        if (
          !record ||
          knowledgeHash(this.inputProof(record)) !== knowledgeHash(proof)
        )
          fail("SCHEDULE_INPUT_INVALID");
        return { ...before, state: "accepted", input: proof, errorCode: null };
      },
      "observe",
    );
  }
  settleObserved(
    original: object,
    observation: object,
    input: SettleScheduleClaimInput,
  ): ScheduleRequestResult<TriggerOccurrence> {
    const safe = data(input, ["workspaceId", "requestId", "expectedRevision"]);
    return this.mutate(
      original,
      safe,
      "observe",
      (before) => {
        const proof = digest(this.ports.readInputObservation(observation)),
          record = this.inputRecord(this.scheduleFor(before), before);
        if (!record) fail("SCHEDULE_INPUT_INVALID");
        this.observation(record, proof);
        let state: ScheduleOccurrenceState =
          proof.state === "cancelled"
            ? "cancelled"
            : proof.state === "pending"
              ? "accepted"
              : "promoted";
        if (
          proof.runState &&
          [
            "completed",
            "failed",
            "cancelled",
            "interrupted",
            "uncertain",
          ].includes(proof.runState)
        )
          state =
            proof.cleanupConfirmed === true &&
            ["completed", "failed", "cancelled"].includes(proof.runState)
              ? (proof.runState as ScheduleOccurrenceState)
              : "uncertain";
        return {
          ...before,
          state,
          input: this.inputProof(record),
          observation: proof,
          errorCode: state === "uncertain" ? "SCHEDULE_RUN_UNCERTAIN" : null,
        };
      },
      "observe",
    );
  }
  abandonClaim(
    original: object,
    input: AbandonScheduleClaimInput,
  ): ScheduleRequestResult<TriggerOccurrence> {
    const safe = data(input, [
      "workspaceId",
      "requestId",
      "expectedRevision",
      "operation",
      "errorCode",
    ]);
    if (!["cancelled", "uncertain"].includes(safe.operation)) fail();
    id(safe.errorCode);
    return this.mutate(
      original,
      safe,
      "abandon",
      (before) => ({
        ...before,
        state:
          before.state === "claimed" && safe.operation === "cancelled"
            ? "cancelled"
            : "uncertain",
        errorCode: safe.errorCode,
      }),
      "observe",
    );
  }
  releaseClaim(original: object): void {
    this.claims.delete(original);
    this.leases.delete(original);
  }
  lookupScheduleInput(input: InputRecord): ScheduleInputBinding | null {
    if (
      !input ||
      typeof input !== "object" ||
      nodeTypes.isProxy(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    )
      fail("SCHEDULE_INPUT_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(input),
      safe = { workspaceId: "", id: "", requestId: "" };
    for (const key of ["workspaceId", "id", "requestId"] as const) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor))
        fail("SCHEDULE_INPUT_INVALID");
      safe[key] = id(descriptor.value);
    }
    const match = /^schedule:([a-f0-9]{64})$/u.exec(safe.requestId);
    const links = this.db
      .prepare(
        "SELECT h.entity_id FROM schedule_heads h JOIN schedule_revisions r ON r.id=h.revision_id AND r.workspace_id=h.workspace_id WHERE h.workspace_id=? AND h.kind='occurrence' AND r.input_id=? LIMIT 2",
      )
      .all(id(safe.workspaceId), id(safe.id));
    if (links.length > 1) fail("SCHEDULE_INPUT_INVALID");
    const linked = links[0] ? String(links[0].entity_id) : undefined,
      canonical = match ? `occ_${match[1]}` : undefined;
    if (linked && canonical && linked !== canonical)
      fail("SCHEDULE_INPUT_INVALID");
    if (!linked && !canonical) {
      if (safe.requestId.startsWith("schedule:"))
        fail("SCHEDULE_INPUT_UNBOUND");
      return null;
    }
    const occurrence = this.getOccurrence(
      safe.workspaceId,
      linked ?? canonical!,
    );
    if (!occurrence) {
      if (safe.requestId.startsWith("schedule:") || linked)
        fail("SCHEDULE_INPUT_UNBOUND");
      return null;
    }
    const schedule = this.scheduleFor(occurrence),
      actual = this.inputRecord(schedule, occurrence);
    if (
      !actual ||
      actual.id !== safe.id ||
      this.inputProof(actual).inputSha256 !==
        this.inputProof(json(input)).inputSha256 ||
      safe.requestId !== occurrence.inputRequestId
    )
      fail("SCHEDULE_INPUT_INVALID");
    return { occurrence, schedule, target: schedule.spec.target };
  }
  recoverInterrupted(): void {
    if (
      Number(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM schedule_heads WHERE kind='occurrence'",
          )
          .get()!.n,
      ) > 512
    )
      fail("SCHEDULE_LIMIT");
    this.ports.writeTx(() => {
      for (const row of this.db
        .prepare(
          "SELECT workspace_id,entity_id FROM schedule_heads WHERE kind='occurrence' LIMIT 513",
        )
        .all()) {
        const before = this.getOccurrence(
          String(row.workspace_id),
          String(row.entity_id),
        )!;
        if (["claimed", "dispatching"].includes(before.state)) {
          const input =
            before.state === "dispatching"
              ? this.inputRecord(this.scheduleFor(before), before)
              : undefined;
          this.recoveryRecord(
            before,
            "uncertain",
            `recover:${before.id}`,
            "recover",
            input ? this.inputProof(input) : undefined,
          );
        }
      }
    });
  }
  advanceDueBatch(
    originalWorker: object,
    originalDue: object,
    input: AdvanceScheduleDueInput,
  ): ScheduleDueResult {
    const safe = data(input, [
        "workspaceId",
        "scheduleId",
        "requestId",
        "expectedRevision",
      ]),
      request = { ...safe, operation: "due" } as JsonObject,
      duplicate = this.duplicate<ScheduleRevision>(
        safe.workspaceId,
        `schedule:${safe.scheduleId}`,
        safe.requestId,
        knowledgeHash(request),
      );
    if (duplicate)
      return {
        ...duplicate,
        occurrences:
          duplicate.record.due?.batch.occurrences
            .map((candidate) =>
              this.getOccurrence(safe.workspaceId, candidate.occurrenceId),
            )
            .filter(
              (occurrence): occurrence is TriggerOccurrence =>
                occurrence !== undefined,
            ) ?? [],
      };
    return this.ports.writeTx(() => {
      const worker = this.worker(originalWorker, "dispatch"),
        before = this.getSchedule(safe.workspaceId, safe.scheduleId);
      if (
        !before ||
        before.revision !== safe.expectedRevision ||
        !before.spec.enabled ||
        worker.workspaceId !== safe.workspaceId
      )
        fail("SCHEDULE_DUE_STALE");
      const proof = digest(this.ports.readDueBatch(originalDue));
      if (
        proof.workspaceId !== safe.workspaceId ||
        proof.scheduleRevisionId !== before.id ||
        proof.scheduleSha256 !== before.spec.sha256 ||
        proof.previousCursorSha256 !== knowledgeHash(before.cursor) ||
        proof.batch.executionAuthority !== false ||
        proof.batch.clockRollback ||
        proof.batch.occurrences.length > 32
      )
        fail("SCHEDULE_DUE_STALE");
      validateScheduleCursor(proof.batch.nextCursor, before.spec);
      sync(this.ports.assertDueBatchCurrent(originalDue, proof, before.spec));
      const occurrences: TriggerOccurrence[] = [];
      let claimedSlots: ReadonlySet<string> | undefined;
      for (const value of proof.batch.occurrences) {
        const candidate = validateScheduleOccurrence(value, before.spec),
          old = this.getOccurrence(safe.workspaceId, candidate.occurrenceId);
        if (old) {
          if (old.candidate.dataSha256 !== candidate.dataSha256)
            fail("SCHEDULE_REQUEST_CONFLICT");
          occurrences.push(old);
          continue;
        }
        this.occurrenceBudget();
        // A slot an earlier revision already claimed is omitted; one left queued there can no longer be claimed.
        claimedSlots ??= new Set(
          this.inspectOccurrences(safe.workspaceId, safe.scheduleId)
            .filter((row) => row.worker !== null)
            .map((row) => row.candidate.triggerKey),
        );
        if (claimedSlots.has(candidate.triggerKey)) continue;
        if (this.inspectOccurrences(safe.workspaceId).length >= 512)
          fail("SCHEDULE_LIMIT");
        const record = this.candidateRecord(before, candidate),
          requestId = `due:${knowledgeHash({ requestId: safe.requestId, occurrenceId: candidate.occurrenceId })}`;
        this.commit(
          "occurrence",
          candidate.occurrenceId,
          record,
          undefined,
          "due-occurrence",
          {
            workspaceId: safe.workspaceId,
            scheduleId: safe.scheduleId,
            requestId,
            operation: "due-occurrence",
            dueSha256: proof.sha256,
          },
        );
        occurrences.push(record);
      }
      const result = this.commit(
        "schedule",
        before.scheduleId,
        this.revise(
          { ...before, cursor: proof.batch.nextCursor, due: proof, worker },
          before,
        ),
        before,
        "due",
        request,
      );
      return { ...result, occurrences };
    });
  }
}
