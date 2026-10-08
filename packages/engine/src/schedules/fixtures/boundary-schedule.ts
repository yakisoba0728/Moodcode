import assert from "node:assert/strict";
import type { RunConfig } from "@moodcode/contracts";
import type { ScheduleEngine } from "./schedule.js";
import { scheduleInvoke } from "./schedule.js";
import type {
  ScheduleClaimResult,
  ScheduleRequestResult,
  ScheduleRevision,
  SchedulerLeaseResult,
  TriggerOccurrence,
} from "../store.js";
import type { ScheduleSpecInput, ScheduleTargetPin } from "../types.js";

/** All handles originate from the actual public Root producer and actual native journal. */
export function prepareScheduleBoundary(
  engine: ScheduleEngine,
  workspaceId: string,
  sessionId: string,
  config: RunConfig,
  prefix = "boundary",
  ttlMs = 1000,
) {
  const target = scheduleInvoke<object>(engine, "captureScheduleTarget", {
      workspaceId,
      sessionId,
      config,
    }),
    pin = scheduleInvoke<ScheduleTargetPin>(
      engine,
      "readScheduleTarget",
      target,
    ),
    spec: ScheduleSpecInput = {
      schemaVersion: 1,
      id: `${prefix}-schedule`,
      description:
        "Actual original scheduled admission, archive and ownership boundary",
      enabled: true,
      startsAt: new Date(Date.now() - 60000).toISOString(),
      endsAt: null,
      prompt:
        "Read the admitted readonly context and return a bounded repository observation.",
      target: pin,
      trigger: {
        kind: "webhook",
        secretReference: "host-fixture:repository-event",
        bodySchema: {
          type: "object",
          properties: { observation: { type: "string", maxLength: 128 } },
          required: ["observation"],
          additionalProperties: false,
        },
      },
      misfire: { mode: "catch-up", graceMs: 60000 },
      concurrency: 1,
    },
    registered = scheduleInvoke<ScheduleRequestResult<ScheduleRevision>>(
      engine,
      "registerSchedule",
      target,
      {
        workspaceId,
        requestId: `${prefix}-register`,
        expectedRevision: 0,
        spec,
      },
    ),
    worker = scheduleInvoke<object>(
      engine,
      "captureScheduleWorker",
      workspaceId,
    ),
    leased = scheduleInvoke<SchedulerLeaseResult>(
      engine,
      "acquireSchedulerLease",
      worker,
      {
        workspaceId,
        requestId: `${prefix}-lease`,
        expectedRevision: 0,
        ttlMs,
      },
    );
  assert.ok(leased.lease, "Actual native lease returns an ORIGINAL capability");
  const trigger = scheduleInvoke<object>(engine, "previewScheduleWebhook", {
      workspaceId,
      scheduleId: spec.id,
      eventId: `${prefix}-event`,
      data: { observation: "Actual host selected advisory event." },
    }),
    queued = scheduleInvoke<ScheduleRequestResult<TriggerOccurrence>>(
      engine,
      "acceptScheduleTrigger",
      trigger,
      {
        workspaceId,
        scheduleId: spec.id,
        requestId: `${prefix}-queue`,
        expectedScheduleRevision: registered.record.revision,
      },
    ),
    claimed = scheduleInvoke<ScheduleClaimResult>(
      engine,
      "claimScheduleOccurrence",
      worker,
      leased.lease,
      {
        workspaceId,
        occurrenceId: queued.record.occurrenceId,
        requestId: `${prefix}-claim`,
        expectedRevision: queued.record.revision,
      },
    );
  assert.ok(
    claimed.claim,
    "Only the ORIGINAL worker and native lease issue the dispatch claim",
  );
  scheduleInvoke(engine, "releaseScheduleHandle", target);
  scheduleInvoke(engine, "releaseScheduleHandle", trigger);
  return { target, pin, spec, registered, worker, leased, queued, claimed };
}

export function dispatchScheduleBoundary(
  engine: ScheduleEngine,
  prepared: ReturnType<typeof prepareScheduleBoundary>,
  requestId = "boundary-dispatch",
) {
  return scheduleInvoke<ScheduleRequestResult<TriggerOccurrence>>(
    engine,
    "dispatchScheduleOccurrence",
    {
      workspaceId: prepared.pin.workspaceId,
      requestId,
      expectedRevision: prepared.claimed.record.revision,
      approved: true,
      claim: prepared.claimed.claim!,
    },
  );
}
