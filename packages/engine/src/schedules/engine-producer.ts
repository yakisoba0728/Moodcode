import { randomUUID } from "node:crypto";
import { types } from "node:util";
import {
  isTerminal,
  type AcceptInput,
  type InputRecord,
  type Run,
  type RunConfig,
} from "@moodcode/contracts";
import { normalizeAcceptInput } from "@moodcode/contracts/validation";
import type { EngineRuntime } from "../engine-runtime.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  describeQueueTarget,
  type QueueTargetChange,
  type QueueTargetRuntime,
} from "../runner/queue-target.js";
import type { ToolCatalogue } from "../tools/runtime/index.js";
import { assertPhysicalKnowledgeRoot } from "../workspace/trust.js";
import type { ActualScheduleInputPort } from "./host.js";
import { scheduleHostError, scheduleHostRecord } from "./host.js";
import type {
  ScheduleAcceptedInputProof,
  ScheduleClaimImage,
  ScheduleInputObservationProof,
  ScheduleStorage,
  ScheduleTargetProof,
  ScheduleTriggerProof,
  SchedulerWorkerProof,
} from "./store.js";
import { scheduleIdentifier, scheduleJson } from "./spec.js";
import {
  calculateScheduleDue,
  calculateWebhookOccurrence,
  formatScheduleInput,
} from "./occurrences.js";
import type {
  ScheduleSpec,
  ScheduleTargetPin,
  ScheduleOccurrenceCandidate,
  ScheduleDueBatch,
} from "./types.js";

interface Target {
  readonly pin: ScheduleTargetPin;
  readonly proof: ScheduleTargetProof;
  readonly binding: KnowledgeHostBinding;
  readonly catalogue?: ToolCatalogue;
  readonly input?: AcceptInput;
  readonly claim?: object;
  readonly observation?: object;
}
interface Worker {
  readonly proof: SchedulerWorkerProof;
  readonly binding: KnowledgeHostBinding;
}
interface Trigger {
  readonly proof: ScheduleTriggerProof;
  readonly observedAt: number;
}
interface DueProof {
  readonly workspaceId: string;
  readonly scheduleRevisionId: string;
  readonly scheduleSha256: string;
  readonly previousCursorSha256: string;
  readonly batch: ScheduleDueBatch;
  readonly sha256: string;
}
const signed = <T extends object>(body: T): T & { readonly sha256: string } =>
  scheduleJson({ ...body, sha256: knowledgeHash(body) });
const TARGET_CHANGES: Record<QueueTargetChange, string> = {
  session: "SCHEDULE_TARGET_STALE",
  provider: "SCHEDULE_PROVIDER_UNSUPPORTED",
  profile: "SCHEDULE_PROFILE_STALE",
};

/** Capabilities are issued by this actual root Engine, never reconstructed from serialized pins. */
export class EngineScheduleProducer {
  private readonly epoch = randomUUID();
  private readonly workers = new WeakMap<object, Worker>();
  private readonly targets = new WeakMap<object, Target>();
  private readonly triggers = new WeakMap<object, Trigger>();
  private readonly due = new WeakMap<object, DueProof>();
  private readonly accepted = new WeakMap<object, ScheduleAcceptedInputProof>();
  private readonly observed = new WeakMap<
    object,
    ScheduleInputObservationProof
  >();
  private readonly retained = new Set<object>();
  private closed = false;
  constructor(
    private readonly engine: Pick<EngineRuntime, "coordinator" | "scheduler"> &
      QueueTargetRuntime,
    private readonly checkBinding: (
      workspaceId: string,
    ) => KnowledgeHostBinding,
    private readonly native: () => ScheduleStorage,
    private readonly isClosing: () => boolean,
    private readonly isEnabled: () => boolean,
  ) {}
  private open(): void {
    if (this.closed || this.isClosing()) scheduleHostError("ENGINE_CLOSED");
  }
  private original<T>(map: WeakMap<object, T>, value: object): T {
    this.open();
    if (!value || typeof value !== "object" || types.isProxy(value))
      scheduleHostError("SCHEDULE_ORIGINAL_REQUIRED");
    const result = map.get(value);
    if (!result) scheduleHostError("SCHEDULE_ORIGINAL_REQUIRED");
    return result;
  }
  private issue<T>(map: WeakMap<object, T>, data: T): object {
    this.open();
    if (this.retained.size >= 128) scheduleHostError("SCHEDULE_HANDLE_LIMIT");
    const cap = Object.freeze({});
    map.set(cap, data);
    this.retained.add(cap);
    return cap;
  }
  private binding(workspaceId: string): KnowledgeHostBinding {
    this.open();
    const binding = scheduleJson(this.checkBinding(workspaceId));
    assertPhysicalKnowledgeRoot(binding);
    return binding;
  }
  private assertBinding(expected: KnowledgeHostBinding): void {
    if (
      knowledgeHash(this.binding(expected.workspaceId)) !==
      knowledgeHash(expected)
    )
      scheduleHostError("SCHEDULE_TARGET_STALE");
  }
  captureWorker(workspaceId: string): object {
    scheduleIdentifier(workspaceId);
    const binding = this.binding(workspaceId);
    const proof = signed({
      workspaceId,
      ownerEpoch: knowledgeHash({ epoch: this.epoch, binding }),
      rootBindingSha256: knowledgeHash(binding),
    });
    return this.issue(this.workers, { proof, binding });
  }
  readWorker(original: object): SchedulerWorkerProof {
    return scheduleJson(this.original(this.workers, original).proof);
  }
  assertWorkerCurrent(
    original: object,
    expected: SchedulerWorkerProof,
    phase: "dispatch" | "observe",
  ): void {
    const worker = this.original(this.workers, original);
    this.assertBinding(worker.binding);
    if (knowledgeHash(expected) !== knowledgeHash(worker.proof))
      scheduleHostError("SCHEDULE_WORKER_STALE");
    if (phase === "dispatch")
      this.engine.coordinator.assertWorkspaceCleanupConfirmed(
        expected.workspaceId,
      );
  }
  private describe(
    workspaceId: string,
    sessionId: string,
    config: RunConfig,
  ): Target {
    const { pin, binding, catalogue } = describeQueueTarget(
      this.engine,
      (id) => this.binding(id),
      workspaceId,
      sessionId,
      config,
      (change) => scheduleHostError(TARGET_CHANGES[change]),
    );
    const proof = signed({
      workspaceId,
      sessionId,
      sourceSha256: pin.workspaceBindingSha256,
      config: pin.config,
      configSha256: pin.runConfigSha256,
      capabilitiesSha256: pin.capabilitiesSha256,
      catalogueSha256: pin.catalogueSha256,
      profile: pin.profile,
    });
    return { pin, proof, binding, catalogue };
  }
  captureTarget(input: {
    workspaceId: string;
    sessionId: string;
    config: RunConfig;
  }): object {
    scheduleHostRecord(input, ["workspaceId", "sessionId", "config"]);
    const selection = scheduleJson(input),
      normalized = normalizeAcceptInput({
        sessionId: selection.sessionId,
        requestId: "schedule-target",
        prompt: "schedule-target",
        config: selection.config,
        delivery: "queue",
      });
    this.binding(selection.workspaceId);
    if (
      this.engine.store.getSession(selection.sessionId).workspaceId !==
      selection.workspaceId
    )
      scheduleHostError("SCHEDULE_TARGET_STALE");
    normalized.config = this.engine.profiles.apply(
      selection.sessionId,
      normalized.config,
    );
    const target = this.describe(
      selection.workspaceId,
      selection.sessionId,
      normalized.config,
    );
    this.engine.coordinator.assertWorkspaceCleanupConfirmed(
      selection.workspaceId,
    );
    return this.issue(this.targets, target);
  }
  targetPin(original: object): ScheduleTargetPin {
    return scheduleJson(this.original(this.targets, original).pin);
  }
  readTarget(original: object): ScheduleTargetProof {
    return scheduleJson(this.original(this.targets, original).proof);
  }
  assertTargetCurrent(
    original: object,
    expected: ScheduleTargetProof,
    spec: ScheduleSpec,
  ): void {
    const target = this.original(this.targets, original);
    this.assertTarget(target);
    if (
      knowledgeHash(target.proof) !== knowledgeHash(expected) ||
      knowledgeHash(target.pin) !== knowledgeHash(spec.target)
    )
      scheduleHostError("SCHEDULE_TARGET_STALE");
  }
  private assertTarget(target: Target): void {
    this.assertBinding(target.binding);
    if (!target.catalogue) scheduleHostError("SCHEDULE_TARGET_STALE");
    this.engine.toolRuntime.assertCatalogueCurrent(target.catalogue);
    if (
      knowledgeHash(
        this.describe(
          target.pin.workspaceId,
          target.pin.sessionId,
          target.pin.config,
        ).pin,
      ) !== knowledgeHash(target.pin)
    )
      scheduleHostError("SCHEDULE_TARGET_STALE");
    this.engine.coordinator.assertWorkspaceCleanupConfirmed(
      target.pin.workspaceId,
    );
  }
  /** Only a root-calculated occurrence gets an original trigger; advisory candidate DTOs have no authority. */
  private issueTrigger(
    workspaceId: string,
    scheduleRevisionId: string,
    spec: ScheduleSpec,
    candidate: ScheduleOccurrenceCandidate,
    observedAt: number,
  ): object {
    this.binding(workspaceId);
    const proof = signed({
      workspaceId,
      scheduleId: spec.id,
      scheduleRevisionId,
      scheduleSha256: spec.sha256,
      candidate: scheduleJson(candidate),
    });
    return this.issue(this.triggers, { proof, observedAt });
  }
  readTrigger(original: object): ScheduleTriggerProof {
    return scheduleJson(this.original(this.triggers, original).proof);
  }
  assertTriggerCurrent(
    original: object,
    expected: ScheduleTriggerProof,
    spec: ScheduleSpec,
  ): void {
    const trigger = this.original(this.triggers, original);
    this.binding(expected.workspaceId);
    if (
      knowledgeHash(expected) !== knowledgeHash(trigger.proof) ||
      spec.sha256 !== expected.scheduleSha256 ||
      spec.id !== expected.scheduleId ||
      !spec.enabled ||
      Date.parse(expected.candidate.scheduledAt) > trigger.observedAt ||
      expected.candidate.scheduleSha256 !== spec.sha256
    )
      scheduleHostError("SCHEDULE_TRIGGER_STALE");
  }
  captureWebhook(input: {
    workspaceId: string;
    scheduleId: string;
    eventId: string;
    data: unknown;
  }): object {
    scheduleHostRecord(input, ["workspaceId", "scheduleId", "eventId", "data"]);
    const selection = scheduleJson(input);
    this.binding(selection.workspaceId);
    const record = this.native().getSchedule(
        selection.workspaceId,
        selection.scheduleId,
      ),
      now = Date.now();
    if (!record) scheduleHostError("SCHEDULE_NOT_FOUND");
    const candidate = calculateWebhookOccurrence(
      record.spec,
      selection.eventId,
      selection.data,
      new Date(now).toISOString(),
    );
    return this.issueTrigger(
      selection.workspaceId,
      record.id,
      record.spec,
      candidate,
      now,
    );
  }
  captureDue(input: { workspaceId: string; scheduleId: string }): object {
    scheduleHostRecord(input, ["workspaceId", "scheduleId"]);
    const selection = scheduleJson(input);
    this.binding(selection.workspaceId);
    const record = this.native().getSchedule(
      selection.workspaceId,
      selection.scheduleId,
    );
    if (!record) scheduleHostError("SCHEDULE_NOT_FOUND");
    const batch = calculateScheduleDue(
      record.spec,
      record.cursor,
      new Date().toISOString(),
    );
    return this.issue(
      this.due,
      signed({
        workspaceId: selection.workspaceId,
        scheduleRevisionId: record.id,
        scheduleSha256: record.spec.sha256,
        previousCursorSha256: knowledgeHash(record.cursor),
        batch,
      }),
    );
  }
  readDueBatch(original: object): DueProof {
    return scheduleJson(this.original(this.due, original));
  }
  assertDueBatchCurrent(
    original: object,
    expected: DueProof,
    spec: ScheduleSpec,
  ): void {
    const proof = this.original(this.due, original);
    this.binding(expected.workspaceId);
    const record = this.native().getSchedule(expected.workspaceId, spec.id);
    if (!record) scheduleHostError("SCHEDULE_DUE_STALE");
    if (
      knowledgeHash(proof) !== knowledgeHash(expected) ||
      expected.scheduleRevisionId !== record.id ||
      expected.scheduleSha256 !== spec.sha256 ||
      expected.previousCursorSha256 !== knowledgeHash(record.cursor)
    )
      scheduleHostError("SCHEDULE_DUE_STALE");
  }
  private fromImage(image: ScheduleClaimImage): Target {
    const target = this.describe(
      image.workspaceId,
      image.target.sessionId,
      image.target.config,
    );
    if (knowledgeHash(target.pin) !== knowledgeHash(image.target))
      scheduleHostError("SCHEDULE_TARGET_STALE");
    return target;
  }
  captureInput(
    originalClaim: object,
    request: { inputRequestId: string; prompt: string },
  ): object {
    scheduleHostRecord(request, ["inputRequestId", "prompt"]);
    const data = scheduleJson(request);
    const image = this.native().readClaim(originalClaim);
    this.native().assertClaimCurrent(originalClaim, "dispatch");
    const expectedPrompt = formatScheduleInput(
      {
        id: image.scheduleId,
        sha256: image.scheduleSha256,
        prompt: image.prompt,
      },
      image.candidate,
    );
    if (
      image.authority !== "dispatch" ||
      data.inputRequestId !== image.inputRequestId ||
      data.prompt !== expectedPrompt
    )
      scheduleHostError("SCHEDULE_CLAIM_STALE");
    const target = this.fromImage(image);
    const input = normalizeAcceptInput({
      sessionId: image.target.sessionId,
      requestId: data.inputRequestId,
      prompt: data.prompt,
      config: target.pin.config,
      delivery: "queue",
    });
    return this.issue(this.targets, {
      ...target,
      input: scheduleJson(input),
      claim: originalClaim,
    });
  }
  assertInputCurrent(original: object): void {
    const target = this.original(this.targets, original);
    if (!target.input || !target.claim)
      scheduleHostError("SCHEDULE_CLAIM_STALE");
    this.native().assertClaimCurrent(target.claim, "dispatch");
    this.assertTarget(target);
  }
  acceptInput(original: object): object {
    this.assertInputCurrent(original);
    const target = this.original(this.targets, original),
      input = target.input!;
    const receipt = this.engine.scheduler.accept(input),
      stored = this.engine.store.getInput(receipt.inputId);
    if (
      knowledgeHash(this.acceptedRequest(stored)) !== knowledgeHash(input) ||
      stored.workspaceId !== target.pin.workspaceId ||
      stored.admittedSeq !== receipt.admittedSeq
    )
      scheduleHostError("SCHEDULE_INPUT_CONTRADICTION");
    const proof = signed({
      workspaceId: stored.workspaceId,
      sessionId: stored.sessionId,
      inputId: stored.id,
      requestId: stored.requestId,
      admittedSeq: stored.admittedSeq,
      inputSha256: knowledgeHash(input),
    });
    return this.issue(this.accepted, proof);
  }
  private acceptedRequest(input: InputRecord): AcceptInput {
    return {
      sessionId: input.sessionId,
      requestId: input.requestId,
      prompt: input.prompt,
      config: input.config,
      delivery: input.delivery,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.documents ? { documents: input.documents } : {}),
    };
  }
  readAcceptedInput(original: object): ScheduleAcceptedInputProof {
    const proof = this.original(this.accepted, original),
      input = this.engine.store.getInput(proof.inputId);
    this.binding(proof.workspaceId);
    if (
      input.sessionId !== proof.sessionId ||
      input.workspaceId !== proof.workspaceId ||
      input.requestId !== proof.requestId ||
      input.admittedSeq !== proof.admittedSeq ||
      knowledgeHash(this.acceptedRequest(input)) !== proof.inputSha256
    )
      scheduleHostError("SCHEDULE_INPUT_CONTRADICTION");
    return scheduleJson(proof);
  }
  captureInputObservation(original: object): object {
    const image = this.native().readObservation(original);
    this.native().assertClaimCurrent(original, "observe");
    this.binding(image.workspaceId);
    // Observation retains historical pins and never requires a dispatch-capable current catalogue.
    const binding = this.binding(image.workspaceId);
    const target: Target = {
      pin: image.target,
      proof: signed({
        workspaceId: image.workspaceId,
        sessionId: image.target.sessionId,
        sourceSha256: image.target.workspaceBindingSha256,
        config: image.target.config,
        configSha256: image.target.runConfigSha256,
        capabilitiesSha256: image.target.capabilitiesSha256,
        catalogueSha256: image.target.catalogueSha256,
        profile: image.target.profile,
      }),
      binding,
      observation: original,
    };
    return this.issue(this.targets, target);
  }
  observeInput(original: object): object {
    const target = this.original(this.targets, original);
    if (!target.observation) scheduleHostError("SCHEDULE_OBSERVATION_STALE");
    this.native().assertClaimCurrent(target.observation, "observe");
    this.assertBinding(target.binding);
    const image = this.native().readObservation(target.observation);
    const expected: AcceptInput = {
      sessionId: image.target.sessionId,
      requestId: image.inputRequestId,
      prompt: image.prompt,
      config: image.target.config,
      delivery: "queue",
    };
    const receipt = this.engine.store.lookupInputReceipt(expected);
    if (!receipt) scheduleHostError("SCHEDULE_INPUT_NOT_ACCEPTED");
    const input = this.engine.store.getInput(receipt.inputId),
      run = input.runId ? this.engine.store.getRun(input.runId) : null;
    let usage: ScheduleInputObservationProof["usage"] = null,
      cleanupConfirmed: boolean | null = null;
    if (run) {
      if (
        run.workspaceId !== input.workspaceId ||
        run.sessionId !== input.sessionId ||
        run.prompt !== input.prompt ||
        knowledgeHash(run.config) !== knowledgeHash(input.config)
      )
        scheduleHostError("SCHEDULE_INPUT_CONTRADICTION");
      try {
        usage = this.engine.coordinator.getRunUsage(run.id);
      } catch {
        /* unavailable after restart */
      }
      if (isTerminal(run.state)) {
        try {
          this.engine.coordinator.assertWorkspaceCleanupConfirmed(
            input.workspaceId,
          );
          cleanupConfirmed = run.state !== "interrupted";
        } catch {
          cleanupConfirmed = false;
        }
      }
    }
    const proof = signed({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      inputId: input.id,
      inputSha256: knowledgeHash(this.acceptedRequest(input)),
      state: input.state,
      runId: run?.id ?? null,
      runState: run?.state ?? null,
      runSha256: run
        ? knowledgeHash({
            id: run.id,
            inputId: run.inputId,
            sessionId: run.sessionId,
            workspaceId: run.workspaceId,
            prompt: run.prompt,
            config: run.config,
          })
        : null,
      cleanupConfirmed,
      usage,
    });
    return this.issue(this.observed, proof);
  }
  readInputObservation(original: object): ScheduleInputObservationProof {
    return scheduleJson(this.original(this.observed, original));
  }
  beforePromotion(input: InputRecord): void {
    const binding = this.native().lookupScheduleInput(input);
    if (!binding) return;
    if (!this.isEnabled()) scheduleHostError("SCHEDULES_DISABLED");
    const current = this.describe(
      binding.target.workspaceId,
      binding.target.sessionId,
      binding.target.config,
    );
    if (knowledgeHash(current.pin) !== knowledgeHash(binding.target))
      scheduleHostError("SCHEDULE_TARGET_STALE");
    this.assertTarget(current);
    if (
      binding.occurrence.state === "paused-import" ||
      !["accepted", "promoted"].includes(binding.occurrence.state)
    )
      scheduleHostError("SCHEDULE_ACCEPTANCE_UNCERTAIN");
  }
  /** Recheck after awaited context/lifecycle work, immediately before each actual provider iterator. */
  beforeProviderDispatch(run: Run): void {
    this.beforePromotion(this.engine.store.getInput(run.inputId));
  }
  inputPort(): ActualScheduleInputPort {
    return {
      capture: (claim, request) => this.captureInput(claim, request),
      readTarget: (value) => this.readTarget(value),
      assertCurrent: (value) => this.assertInputCurrent(value),
      accept: (value) => this.acceptInput(value),
      captureObservation: (value) => this.captureInputObservation(value),
      observe: (value) => this.observeInput(value),
      release: (value) => this.release(value),
    };
  }
  release(value: object): void {
    this.workers.delete(value);
    this.targets.delete(value);
    this.triggers.delete(value);
    this.due.delete(value);
    this.accepted.delete(value);
    this.observed.delete(value);
    this.retained.delete(value);
  }
  close(): void {
    for (const value of this.retained) this.release(value);
    this.closed = true;
  }
}
