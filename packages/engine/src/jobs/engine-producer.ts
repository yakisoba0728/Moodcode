import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { types } from "node:util";
import {
  EngineError,
  type AcceptInput,
  type InputRecord,
  type Run,
  type RunConfig,
} from "@moodcode/contracts";
import { normalizeAcceptInput } from "@moodcode/contracts/validation";
import type { MoodcodeEngine } from "../engine.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { assertPhysicalKnowledgeRoot } from "../workspace/trust.js";
import {
  describeQueueTarget,
  jobTargetChanged,
  type QueueTargetPin,
} from "../runner/queue-target.js";
import type { ActualTerminalJobPort } from "./host.js";
import {
  formatJobResult,
  type ActualJobInputPort,
  type JobAcceptedInputProof,
  type JobDeliveryTargetProof,
} from "./delivery.js";
import type { JobStorage } from "./store.js";
import { readJobOutput } from "./output.js";
import {
  jobHostRecord,
  jobJson,
  signJobData,
  validateJobOutputCursor,
} from "./validation.js";
import type {
  JobOutputPage,
  JobOutputSnapshot,
  JobOwnerProof,
  ReadJobOutputInput,
  TerminalClosedOutcomeProof,
  TerminalJobSourceProof,
} from "./types.js";

interface Source {
  readonly terminal: object;
  readonly proof: TerminalJobSourceProof;
  readonly owner: JobOwnerProof;
  readonly binding: KnowledgeHostBinding;
  readonly journal: string;
  readonly snapshots: Map<string, object>;
  readonly modelSnapshots: Set<object>;
  readonly pages: Set<Page>;
}
interface Page {
  readonly source: Source;
  readonly page: JobOutputPage;
}
interface Closed {
  readonly source: Source;
  readonly terminal: object;
  readonly proof: TerminalClosedOutcomeProof;
}
interface Target {
  readonly binding: KnowledgeHostBinding;
  readonly proof: JobDeliveryTargetProof;
}
interface QueueInput {
  readonly target: Target;
  readonly input: AcceptInput;
}
function fail(code: string): never {
  throw new EngineError(
    code,
    "The actual job observation or delivery capability is no longer current",
  );
}

/** Original capabilities connect the real user PTY and synchronous native InputScheduler. */
export class EngineJobProducer {
  private readonly epoch = knowledgeHash({ nonce: randomUUID() });
  private readonly sources = new WeakMap<object, Source>();
  private readonly pages = new WeakMap<object, Page>();
  private readonly outcomes = new WeakMap<object, Closed>();
  private readonly targets = new WeakMap<object, Target>();
  private readonly inputs = new WeakMap<object, QueueInput>();
  private readonly accepted = new WeakMap<object, JobAcceptedInputProof>();
  private readonly retained = new Set<object>();
  private readonly usedInputs = new WeakSet<object>();
  private readonly sourceEvents = new Set<string>();
  private readonly pageEvents = new WeakSet<object>();
  private readonly closedEvents = new WeakSet<object>();
  private closed = false;
  private readonly journalIdentity: string;
  constructor(
    private readonly engine: MoodcodeEngine,
    private readonly checkBinding: (
      workspaceId: string,
    ) => KnowledgeHostBinding,
    private readonly native: () => JobStorage,
    private readonly isClosing: () => boolean,
    private readonly isEnabled: () => boolean,
    private readonly artifactDir: string,
  ) {
    this.journalIdentity = this.journal();
  }
  private open(): void {
    if (this.closed || this.isClosing()) fail("ENGINE_CLOSED");
  }
  private enabled(): void {
    this.open();
    if (!this.isEnabled()) fail("JOBS_DISABLED");
  }
  private issue<T>(map: WeakMap<object, T>, data: T): object {
    this.open();
    if (this.retained.size >= 256) fail("JOB_HANDLE_LIMIT");
    const original = Object.freeze({});
    map.set(original, data);
    this.retained.add(original);
    return original;
  }
  private original<T>(map: WeakMap<object, T>, original: object): T {
    this.open();
    if (
      !original ||
      typeof original !== "object" ||
      types.isProxy(original) ||
      !this.retained.has(original)
    )
      fail("JOB_ORIGINAL_REQUIRED");
    const result = map.get(original);
    if (!result) fail("JOB_ORIGINAL_REQUIRED");
    return result;
  }
  private binding(workspaceId: string): KnowledgeHostBinding {
    this.open();
    const binding = jobJson(this.checkBinding(workspaceId));
    assertPhysicalKnowledgeRoot(binding);
    return binding;
  }
  private assertBinding(binding: KnowledgeHostBinding): void {
    if (
      knowledgeHash(this.binding(binding.workspaceId)) !==
      knowledgeHash(binding)
    )
      fail("JOB_OWNER_STALE");
  }
  private journal(): string {
    const path = join(this.artifactDir, "terminals.sqlite");
    const st = lstatSync(path, { bigint: true });
    if (!st.isFile() || st.isSymbolicLink() || realpathSync(path) !== path)
      fail("JOB_JOURNAL_STALE");
    return knowledgeHash({
      path,
      device: st.dev.toString(),
      inode: st.ino.toString(),
    });
  }
  private source(original: object): Source {
    const source =
      this.sources.get(original) ??
      this.pages.get(original)?.source ??
      this.outcomes.get(original)?.source;
    if (!source || !this.retained.has(original) || types.isProxy(original))
      fail("JOB_ORIGINAL_REQUIRED");
    this.open();
    return source;
  }
  private assertSource(source: Source): void {
    this.assertBinding(source.binding);
    if (this.journal() !== source.journal) fail("JOB_JOURNAL_STALE");
    this.engine.terminals.assertReadSourceCurrent(source.terminal);
    if (
      knowledgeHash(this.engine.terminals.readReadSource(source.terminal)) !==
      knowledgeHash(source.proof)
    )
      fail("JOB_SOURCE_STALE");
  }
  captureSource(input: {
    workspaceId: string;
    sessionId: string;
    terminalId: string;
  }): object {
    this.enabled();
    jobHostRecord(input, ["workspaceId", "sessionId", "terminalId"]);
    const data = jobJson(input),
      binding = this.binding(data.workspaceId);
    if (
      this.engine.store.getSession(data.sessionId).workspaceId !==
      data.workspaceId
    )
      fail("JOB_OWNER_STALE");
    const journal = this.journal();
    if (journal !== this.journalIdentity) fail("JOB_JOURNAL_STALE");
    const terminal = this.engine.terminals.captureReadSource(
      data.terminalId,
      {
        workspaceId: data.workspaceId,
        sessionId: data.sessionId,
        authority: "user",
      },
      journal,
    );
    try {
      const proof = this.engine.terminals.readReadSource(terminal);
      const owner = signJobData({
        workspaceId: data.workspaceId,
        sessionId: data.sessionId,
        rootBindingSha256: knowledgeHash(binding),
        ownerEpoch: this.epoch,
        sourceSha256: proof.sha256,
      });
      return this.issue(this.sources, {
        terminal,
        proof,
        owner,
        binding,
        journal,
        snapshots: new Map(),
        modelSnapshots: new Set(),
        pages: new Set(),
      });
    } catch (error) {
      this.engine.terminals.releaseReadHandle(terminal);
      throw error;
    }
  }
  readSource(original: object): TerminalJobSourceProof {
    const source = this.source(original);
    this.assertSource(source);
    if (!this.sourceEvents.has(source.proof.sha256)) {
      this.engine.store.commitTerminalJobObservation(
        source.proof.sessionId,
        "terminal.source_admitted",
        jobJson({
          ...source.proof,
          sourceSha256: source.proof.sha256,
          ownerSha256: source.owner.sha256,
          rootBindingSha256: source.owner.rootBindingSha256,
          ownerEpoch: source.owner.ownerEpoch,
        }),
      );
      this.sourceEvents.add(source.proof.sha256);
    }
    return structuredClone(source.proof);
  }
  readOwner(original: object): JobOwnerProof {
    const source = this.source(original);
    this.assertSource(source);
    return structuredClone(source.owner);
  }
  assertOwnerCurrent(original: object, expected: JobOwnerProof): void {
    if (knowledgeHash(this.readOwner(original)) !== knowledgeHash(expected))
      fail("JOB_OWNER_STALE");
  }
  assertSourceCurrent(
    original: object,
    expected: TerminalJobSourceProof,
    phase: "attach" | "observe",
  ): void {
    if (phase === "attach") this.enabled();
    const source = this.source(original);
    this.assertSource(source);
    if (knowledgeHash(source.proof) !== knowledgeHash(expected))
      fail("JOB_SOURCE_STALE");
  }
  /** No native source event or cursor mutation: an actual retained terminal snapshot for readonly model DATA. */
  captureModelSnapshot(original: object, jobId: string): object {
    this.enabled();
    const source = this.original(this.sources, original);
    this.assertSource(source);
    const job = this.native().getJob(source.proof.workspaceId, jobId);
    if (
      !job ||
      job.sourceSha256 !== source.proof.sha256 ||
      job.owner.sha256 !== source.owner.sha256 ||
      ["uncertain", "paused-import"].includes(job.state)
    )
      fail("JOB_OUTPUT_STALE");
    const snapshot = this.engine.terminals.captureReadSnapshot(source.terminal);
    this.engine.terminals.readReadSnapshot(snapshot);
    source.modelSnapshots.add(snapshot);
    return snapshot;
  }
  readModelSnapshot(
    originalSource: object,
    originalSnapshot: object,
  ): JobOutputSnapshot {
    this.enabled();
    const source = this.original(this.sources, originalSource);
    this.assertSource(source);
    const data = this.engine.terminals.readReadSnapshot(originalSnapshot);
    if (
      data.source.sha256 !== source.proof.sha256 ||
      !source.modelSnapshots.has(originalSnapshot)
    )
      fail("JOB_OUTPUT_STALE");
    return structuredClone(data);
  }
  releaseModelSnapshot(originalSource: object, originalSnapshot: object): void {
    if (
      this.sources.get(originalSource)?.modelSnapshots.delete(originalSnapshot)
    )
      this.engine.terminals.releaseReadHandle(originalSnapshot);
  }
  /** Releases output snapshots no live page or attached job's unfinished cursor still names. */
  private prune(source: Source): void {
    const used = new Set(
      [...source.pages].map((entry) => entry.page.snapshotSha256),
    );
    const idle = [...source.snapshots.keys()].filter((sha) => !used.has(sha));
    if (!idle.length) return;
    for (const job of this.native().inspectJobs(source.proof.workspaceId))
      if (
        job.state === "attached" &&
        job.sourceSha256 === source.proof.sha256 &&
        job.cursor &&
        job.cursor.eventSeq <= job.cursor.throughSeq
      )
        used.add(job.cursor.snapshotSha256);
    for (const sha of idle)
      if (!used.has(sha)) {
        this.engine.terminals.releaseReadHandle(source.snapshots.get(sha)!);
        source.snapshots.delete(sha);
      }
  }
  captureOutput(original: object, input: ReadJobOutputInput): object {
    this.enabled();
    const source = this.original(this.sources, original);
    this.assertSource(source);
    const job = this.native().getJob(source.proof.workspaceId, input.jobId);
    if (
      !job ||
      job.sourceSha256 !== source.proof.sha256 ||
      job.owner.sha256 !== source.owner.sha256 ||
      job.sourceRevisionId !== input.jobRevisionId ||
      job.state !== "attached"
    )
      fail("JOB_OUTPUT_STALE");
    let snapshot: object,
      cursor = input.cursor ? validateJobOutputCursor(input.cursor) : undefined;
    if (!cursor && job.cursor && job.cursor.eventSeq <= job.cursor.throughSeq)
      cursor = job.cursor;
    if (cursor) {
      const retained = source.snapshots.get(cursor.snapshotSha256);
      if (!retained) fail("JOB_OUTPUT_SNAPSHOT_EXPIRED");
      snapshot = retained;
    } else {
      this.prune(source);
      snapshot = this.engine.terminals.captureReadSnapshot(source.terminal);
      const data = this.engine.terminals.readReadSnapshot(snapshot);
      const previous = source.snapshots.get(data.sha256);
      if (previous) {
        this.engine.terminals.releaseReadHandle(snapshot);
        snapshot = previous;
      } else source.snapshots.set(data.sha256, snapshot);
      if (job.cursor)
        cursor = signJobData({
          version: 1 as const,
          jobId: job.jobId,
          jobRevisionId: job.sourceRevisionId,
          sourceSha256: source.proof.sha256,
          snapshotSha256: data.sha256,
          throughSeq: data.throughSeq,
          eventSeq: job.cursor.eventSeq,
          byteOffset: job.cursor.byteOffset,
        });
    }
    const entry = {
      source,
      page: readJobOutput(this.engine.terminals.readReadSnapshot(snapshot), {
        ...input,
        ...(cursor ? { cursor } : {}),
      }),
    };
    const handle = this.issue(this.pages, entry);
    source.pages.add(entry);
    return handle;
  }
  readOutput(original: object): JobOutputPage {
    const entry = this.original(this.pages, original);
    this.assertSource(entry.source);
    if (!this.pageEvents.has(original)) {
      this.engine.store.commitTerminalJobObservation(
        entry.source.proof.sessionId,
        "terminal.output_observed",
        jobJson({
          sourceSha256: entry.source.proof.sha256,
          ownerSha256: entry.source.owner.sha256,
          pageSha256: entry.page.sha256,
          snapshotSha256: entry.page.snapshotSha256,
          jobId: entry.page.jobId,
          jobRevisionId: entry.page.jobRevisionId,
        }),
      );
      this.pageEvents.add(original);
    }
    return structuredClone(entry.page);
  }
  captureClosedOutcome(original: object): object {
    this.enabled();
    const source = this.original(this.sources, original);
    this.assertSource(source);
    const terminal = this.engine.terminals.captureClosedObservation(
      source.terminal,
    );
    try {
      const proof = this.engine.terminals.readClosedObservation(terminal);
      return this.issue(this.outcomes, { source, terminal, proof });
    } catch (error) {
      this.engine.terminals.releaseReadHandle(terminal);
      throw error;
    }
  }
  readClosedOutcome(original: object): TerminalClosedOutcomeProof {
    const entry = this.original(this.outcomes, original);
    this.assertSource(entry.source);
    if (!this.closedEvents.has(original)) {
      this.engine.store.commitTerminalJobObservation(
        entry.source.proof.sessionId,
        "terminal.source_closed",
        jobJson({
          ...entry.proof,
          outcomeSha256: entry.proof.sha256,
          ownerSha256: entry.source.owner.sha256,
        }),
      );
      this.closedEvents.add(original);
    }
    return structuredClone(entry.proof);
  }
  private describe(
    workspaceId: string,
    sessionId: string,
    config: RunConfig,
  ): QueueTargetPin {
    return describeQueueTarget(
      this.engine,
      (id) => this.binding(id),
      workspaceId,
      sessionId,
      config,
      jobTargetChanged,
    ).pin;
  }
  captureTarget(
    input: Parameters<ActualJobInputPort["captureTarget"]>[0],
  ): object {
    this.enabled();
    jobHostRecord(input, ["workspaceId", "jobId", "config"]);
    const data = jobJson(input);
    const binding = this.binding(data.workspaceId),
      job = this.native().getJob(data.workspaceId, data.jobId);
    if (
      !job ||
      !["completed", "failed", "cancelled"].includes(job.state) ||
      !job.outcome?.cleanupConfirmed ||
      job.owner.ownerEpoch !== this.epoch
    )
      fail("JOB_NOT_SETTLED");
    const normalized = normalizeAcceptInput({
      sessionId: job.sessionId,
      requestId: "job-target",
      prompt: "job-target",
      config: data.config,
      delivery: "queue",
    });
    normalized.config = this.engine.profiles.apply(
      job.sessionId,
      normalized.config,
    );
    const target = this.describe(
      data.workspaceId,
      job.sessionId,
      normalized.config,
    );
    this.engine.coordinator.assertWorkspaceCleanupConfirmed(data.workspaceId);
    const proof = signJobData({
      workspaceId: data.workspaceId,
      jobId: data.jobId,
      jobRevisionId: job.id,
      jobSha256: job.sha256,
      settledSha256: job.sha256,
      sourceSha256: job.sourceSha256,
      target,
    });
    return this.issue(this.targets, { binding, proof });
  }
  private assertTarget(target: Target): void {
    this.enabled();
    this.assertBinding(target.binding);
    const proof = target.proof,
      job = this.native().getJob(proof.workspaceId, proof.jobId);
    if (
      !job ||
      job.id !== proof.jobRevisionId ||
      job.sha256 !== proof.jobSha256 ||
      job.owner.ownerEpoch !== this.epoch
    )
      fail("JOB_DELIVERY_STALE");
    formatJobResult(job, proof);
    if (
      knowledgeHash(
        this.describe(
          proof.workspaceId,
          proof.target.sessionId,
          proof.target.config,
        ),
      ) !== knowledgeHash(proof.target)
    )
      fail("JOB_TARGET_STALE");
    this.engine.coordinator.assertWorkspaceCleanupConfirmed(proof.workspaceId);
  }
  readTarget(original: object): JobDeliveryTargetProof {
    const target = this.original(this.targets, original);
    this.assertTarget(target);
    return structuredClone(target.proof);
  }
  assertTargetCurrent(
    original: object,
    expected: JobDeliveryTargetProof,
  ): void {
    if (knowledgeHash(this.readTarget(original)) !== knowledgeHash(expected))
      fail("JOB_DELIVERY_STALE");
  }
  captureInput(
    original: object,
    request: { inputRequestId: string; prompt: string },
  ): object {
    jobHostRecord(request, ["inputRequestId", "prompt"]);
    const data = jobJson(request),
      target = this.original(this.targets, original);
    this.assertTarget(target);
    const proof = target.proof,
      job = this.native().getJob(proof.workspaceId, proof.jobId)!;
    if (
      data.inputRequestId !==
        `job-result:${job.jobId}:${proof.settledSha256}` ||
      data.prompt !== formatJobResult(job, proof)
    )
      fail("JOB_INPUT_INVALID");
    const input = normalizeAcceptInput({
      sessionId: proof.target.sessionId,
      requestId: data.inputRequestId,
      prompt: data.prompt,
      config: proof.target.config,
      delivery: "queue",
    });
    return this.issue(this.inputs, { target, input });
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
  accept(original: object): object {
    return this.acceptOwnedInput(original, false);
  }
  acceptAtomicInput(
    originalTarget: object,
    request: { readonly inputRequestId: string; readonly prompt: string },
  ): object {
    const original = this.captureInput(originalTarget, request);
    try {
      return this.acceptOwnedInput(original, true);
    } finally {
      this.release(original);
    }
  }
  private acceptOwnedInput(original: object, atomic: boolean): object {
    const captured = this.original(this.inputs, original);
    this.assertTarget(captured.target);
    if (this.usedInputs.has(original)) fail("JOB_INPUT_ALREADY_USED");
    const proof = captured.target.proof;
    const deliveryId = knowledgeHash([
      "job-result-delivery-v1",
      proof.workspaceId,
      proof.jobId,
      proof.settledSha256,
    ]);
    const intent = this.native().getDelivery(proof.workspaceId, deliveryId);
    if (
      !intent ||
      intent.state !== "dispatching" ||
      intent.target.sha256 !== proof.sha256 ||
      intent.inputRequestId !== captured.input.requestId ||
      intent.prompt !== captured.input.prompt
    )
      fail("JOB_DELIVERY_UNCERTAIN");
    this.usedInputs.add(original);
    if (atomic)
      this.engine.store.publishAfterCommit(() => {
        void this.engine.scheduler
          .wake(captured.input.sessionId)
          .catch(() => {});
      });
    const receipt = atomic
        ? this.engine.store.acceptInput(captured.input)
        : this.engine.scheduler.accept(captured.input),
      stored = this.engine.store.getInput(receipt.inputId);
    if (
      stored.workspaceId !== proof.workspaceId ||
      stored.admittedSeq !== receipt.admittedSeq ||
      knowledgeHash(this.acceptedRequest(stored)) !==
        knowledgeHash(captured.input)
    )
      fail("JOB_INPUT_INVALID");
    return this.issue(
      this.accepted,
      signJobData({
        workspaceId: stored.workspaceId,
        sessionId: stored.sessionId,
        inputId: stored.id,
        requestId: stored.requestId,
        admittedSeq: stored.admittedSeq,
        inputSha256: knowledgeHash(captured.input),
      }),
    );
  }
  readAccepted(original: object): JobAcceptedInputProof {
    const proof = this.original(this.accepted, original),
      input = this.engine.store.getInput(proof.inputId);
    this.binding(proof.workspaceId);
    if (
      input.workspaceId !== proof.workspaceId ||
      input.sessionId !== proof.sessionId ||
      input.requestId !== proof.requestId ||
      input.admittedSeq !== proof.admittedSeq ||
      knowledgeHash(this.acceptedRequest(input)) !== proof.inputSha256
    )
      fail("JOB_INPUT_INVALID");
    return structuredClone(proof);
  }
  beforePromotion(input: InputRecord): void {
    const delivery = this.native().findDeliveryForInput({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      inputId: input.id,
      requestId: input.requestId,
    });
    if (!delivery) return;
    this.enabled();
    if (
      delivery.state !== "accepted" ||
      delivery.accepted?.inputId !== input.id ||
      delivery.prompt !== input.prompt ||
      knowledgeHash(input.config) !==
        knowledgeHash(delivery.target.target.config)
    )
      fail("JOB_DELIVERY_UNCERTAIN");
    if (
      knowledgeHash(
        this.describe(input.workspaceId, input.sessionId, input.config),
      ) !== knowledgeHash(delivery.target.target)
    )
      fail("JOB_TARGET_STALE");
  }
  beforeProviderDispatch(run: Run): void {
    this.beforePromotion(this.engine.store.getInput(run.inputId));
  }
  sourcePort(): ActualTerminalJobPort {
    return {
      captureSource: (input) => this.captureSource(input),
      readSource: (original) => this.readSource(original),
      readOwner: (original) => this.readOwner(original),
      assertSourceCurrent: (original, expected, phase) =>
        this.assertSourceCurrent(original, expected, phase),
      captureOutput: (original, input) => this.captureOutput(original, input),
      readOutput: (original) => this.readOutput(original),
      captureClosedOutcome: (original) => this.captureClosedOutcome(original),
      readClosedOutcome: (original) => this.readClosedOutcome(original),
      release: (original) => this.release(original),
    };
  }
  inputPort(): ActualJobInputPort {
    return {
      captureTarget: (input) => this.captureTarget(input),
      readTarget: (original) => this.readTarget(original),
      assertTargetCurrent: (original, expected) =>
        this.assertTargetCurrent(original, expected),
      captureInput: (original, input) => this.captureInput(original, input),
      accept: (original) => this.accept(original),
      readAccepted: (original) => this.readAccepted(original),
      release: (original) => this.release(original),
    };
  }
  release(original: object): void {
    const source = this.sources.get(original),
      page = this.pages.get(original),
      closed = this.outcomes.get(original);
    if (source) {
      for (const snapshot of [
        ...source.snapshots.values(),
        ...source.modelSnapshots,
      ])
        this.engine.terminals.releaseReadHandle(snapshot);
      source.snapshots.clear();
      source.modelSnapshots.clear();
      this.engine.terminals.releaseReadHandle(source.terminal);
    }
    if (closed) this.engine.terminals.releaseReadHandle(closed.terminal);
    this.sources.delete(original);
    this.pages.delete(original);
    this.outcomes.delete(original);
    this.targets.delete(original);
    this.inputs.delete(original);
    this.accepted.delete(original);
    this.retained.delete(original);
    if (page?.source.pages.delete(page) && !this.closed && !this.isClosing())
      this.prune(page.source);
  }
  close(): void {
    for (const original of this.retained) this.release(original);
    this.closed = true;
    this.sourceEvents.clear();
  }
}
