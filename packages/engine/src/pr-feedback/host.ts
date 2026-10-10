import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { types } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { InputRecord, Run} from "@moodcode/contracts";
import { normalizeAcceptInput } from "@moodcode/contracts/validation";
import type { MoodcodeEngine } from "../engine.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { assertPhysicalKnowledgeRoot } from "../workspace/trust.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { verificationHash } from "../verification/types.js";
import { verificationDocumentKind } from "../verification/plans.js";
import type { VerificationHostService } from "../verification/host.js";
import { describeEngineQueueTarget } from "../jobs/queue-target.js";
import { GitHubPrReader, PrHttpError, validatePrApiBase } from "./github.js";
import { PrFeedbackStorage, validatePrPreview } from "./records.js";
import {
  PR_LIMITS,
  prFail,
  prJson,
  prFields,
  prId,
  prInt,
  prSign,
  feedbackPrompt,
  validatePrPolicy,
  validatePrRepository,
  type PrWatchPreview,
  type PreviewPrWatchInput,
  type RegisterPrWatchInput,
  type PollPrWatchInput,
  type PrRemoteSnapshot,
  type PrWatchRecord,
  type PrAcceptedInput,
  type PrSourcePin,
  type PrPollResult,
} from "./types.js";
function rawSha(v: Uint8Array | string) {
  return createHash("sha256").update(v).digest("hex");
}
function gitBlob(root: string, args: string[], maxBuffer: number): Buffer {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  try {
    return execFileSync(
      "git",
      [
        "--no-pager",
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-C",
        root,
        ...args,
      ],
      { timeout: 3000, maxBuffer, env, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    prFail("PR_LOCAL_GIT_INVALID");
  }
}
function git(root: string, ...args: string[]): string {
  return gitBlob(root, args, 1048576).toString("utf8").trim();
}
function fileHash(root: string, path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
  )
    prFail("PR_SOURCE_INVALID");
  const full = join(root, path),
    before = lstatSync(full, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > 8388608n ||
    relative(root, realpathSync(full)) !== path
  )
    prFail("PR_SOURCE_INVALID");
  const data = readFileSync(full),
    after = lstatSync(full, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs
  )
    prFail("PR_SOURCE_STALE");
  return rawSha(data);
}
interface SnapshotHandle {
  readonly watch: PrWatchRecord;
  readonly snapshot: PrRemoteSnapshot;
}
/** The genuine Root owns approvals, HTTP observations and native queue acceptance. Serialized data owns none of them. */
export class PrFeedbackHost {
  private readonly previews = new WeakMap<object, PrWatchPreview>();
  private readonly snapshots = new WeakMap<object, SnapshotHandle>();
  private readonly accepted = new WeakMap<object, PrAcceptedInput>();
  private readonly handles = new Set<object>();
  private readonly readers = new Map<string, GitHubPrReader>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly polls = new Map<string, Promise<PrPollResult>>();
  private readonly loops = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly epoch = rawSha(randomUUID());
  private readonly firstDispatch = new Set<string>();
  private closed = false;
  constructor(
    private readonly engine: MoodcodeEngine,
    readonly records: PrFeedbackStorage,
    private readonly binding: (workspaceId: string) => KnowledgeHostBinding,
    private readonly verification: VerificationHostService,
    private readonly enabled: () => boolean,
    private readonly allowLoopback: boolean,
    private readonly lifetime: AbortSignal,
  ) {}
  private open() {
    if (this.closed || this.lifetime.aborted) prFail("ENGINE_CLOSED");
  }
  private active() {
    this.open();
    if (!this.enabled()) prFail("PR_FEEDBACK_UNSUPPORTED");
  }
  private physical(ws: string) {
    const b = this.binding(ws);
    assertPhysicalKnowledgeRoot(b);
    return prJson(b);
  }
  private issue<T>(map: WeakMap<object, T>, value: T): object {
    if (this.handles.size >= 128) prFail("PR_HANDLE_LIMIT");
    const original = Object.freeze({});
    map.set(original, value);
    this.handles.add(original);
    return original;
  }
  private original<T>(map: WeakMap<object, T>, v: object): T {
    this.open();
    if (!v || typeof v !== "object" || types.isProxy(v) || !this.handles.has(v))
      prFail("PR_ORIGINAL_REQUIRED");
    const data = map.get(v);
    if (!data) prFail("PR_ORIGINAL_REQUIRED");
    return data;
  }
  private tracked<T>(fn: () => Promise<T>): Promise<T> {
    this.active();
    const p = fn();
    this.pending.add(p);
    void p.then(
      () => this.pending.delete(p),
      () => this.pending.delete(p),
    );
    return p;
  }
  private sourceMatches(p: PrWatchPreview): boolean {
    if (!p.source) return false;
    try {
      if (
        !this.configurationMatches(p) ||
        git(p.binding.root, "rev-parse", "HEAD") !== p.source.head ||
        git(
          p.binding.root,
          "status",
          "--porcelain=v1",
          "--untracked-files=no",
        ) !== ""
      )
        return false;
      for (const f of p.source.files) {
        if (fileHash(p.binding.root, f.path) !== f.hash) return false;
        const blob = gitBlob(
          p.binding.root,
          ["cat-file", "blob", p.source.head + ":" + f.path],
          8388609,
        );
        if (rawSha(blob) !== f.hash) return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  private configurationMatches(p: PrWatchPreview) {
    try {
      return (
        !!p.source &&
        knowledgeHash(this.verification.configuration(p.sessionId)) ===
          p.source.configurationSha256 &&
        p.source.receipts.every(
          (r) =>
            this.engine.verificationChecks.capture(r.checkId)
              .registrationSha256 === r.registrationSha256,
        )
      );
    } catch {
      return false;
    }
  }
  private current(p: PrWatchPreview) {
    this.active();
    if (
      knowledgeHash(this.physical(p.workspaceId)) !== knowledgeHash(p.binding)
    )
      prFail("PR_ROOT_STALE");
    const control = this.engine.store.getSessionControl(p.sessionId);
    if (control.paused && control.reason === "recovery_required")
      prFail("PR_IMPORT_PAUSED");
    const target = describeEngineQueueTarget(
      this.engine,
      (ws) => this.physical(ws),
      p.workspaceId,
      p.sessionId,
      p.target.config,
    );
    if (knowledgeHash(target) !== knowledgeHash(p.target))
      prFail("PR_TARGET_STALE");
    this.engine.coordinator.assertWorkspaceCleanupConfirmed(p.workspaceId);
  }
  preview(input: PreviewPrWatchInput, signal?: AbortSignal): Promise<object> {
    return this.tracked(async () => {
      const i = prFields(input, [
        "sessionId",
        "watchId",
        "repository",
        "policy",
        "config",
        "sourceRunId",
        "apiBase",
      ]) as unknown as PreviewPrWatchInput;
      prId(i.sessionId);
      prId(i.watchId);
      const session = this.engine.store.getSession(i.sessionId),
        binding = this.physical(session.workspaceId),
        repository = validatePrRepository(i.repository),
        policy = validatePrPolicy(i.policy),
        apiBase = validatePrApiBase(
          (i.apiBase ?? "https://api.github.com") + "/",
          this.allowLoopback,
        );
      const normalized = normalizeAcceptInput({
        sessionId: i.sessionId,
        requestId: "pr-target",
        prompt: "pr-target",
        config: i.config,
        delivery: "queue",
      });
      normalized.config = this.engine.profiles.apply(
        i.sessionId,
        normalized.config,
      );
      const target = describeEngineQueueTarget(
        this.engine,
        (ws) => this.physical(ws),
        session.workspaceId,
        session.id,
        normalized.config,
      );
      let source: PrSourcePin | null = null;
      const abort = signal
        ? AbortSignal.any([signal, this.lifetime])
        : this.lifetime;
      if (i.sourceRunId !== null) {
        prId(i.sourceRunId);
        const run = this.engine.store.getRun(i.sourceRunId);
        if (
          run.workspaceId !== session.workspaceId ||
          run.sessionId !== session.id
        )
          prFail("PR_SOURCE_RUN_INVALID");
        const state = this.engine.verificationPlans.get(session.id, run.id);
        if (!state) prFail("PR_VERIFICATION_REQUIRED");
        for (const c of state.plans.at(-1)!.checks)
          this.engine.verificationChecks.assertCurrent(c);
        const plan = state.plans.at(-1)!;
        const observed = await this.verification.observe(
          {
            sessionId: session.id,
            runId: run.id,
            workspace: this.engine.store.getWorkspace(session.workspaceId),
          },
          abort,
        );
        const required = plan.checks.filter((c) => c.required),
          receipts = required.map((c) =>
            state.receipts
              .filter(
                (r) => r.planSha256 === plan.planSha256 && r.checkId === c.id,
              )
              .at(-1),
          );
        if (
          !required.length ||
          receipts.some(
            (r) =>
              !r ||
              r.status !== "pass" ||
              r.phase !== "settled" ||
              r.sourceBefore.sha256 !== observed.sha256,
          )
        )
          prFail("PR_VERIFICATION_REQUIRED");
        const configuration = this.verification.configuration(session.id)!;
        const observation = await this.engine.repository.preview(
          this.engine.store.getWorkspace(session.workspaceId),
          { kind: "symbols", paths: configuration.sourcePaths },
          abort,
        );
        const doc = this.engine.store.getSessionDocument(
          session.id,
          verificationDocumentKind(run.id),
        )!;
        source = prSign({
          runId: run.id,
          head: git(binding.root, "rev-parse", "HEAD"),
          files: observation.manifest.files,
          verificationSource: observed,
          verificationRevision: state.revision,
          verificationDocumentSha256: rawSha(JSON.stringify(doc.data)),
          receipts: receipts as NonNullable<(typeof receipts)[number]>[],
          configurationSha256: knowledgeHash(configuration),
        });
      }
      const p = validatePrPreview(
        prSign({
          version: 1 as const,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          id: i.watchId,
          repository,
          apiBase,
          policy,
          binding,
          ownerEpoch: this.epoch,
          target,
          source,
          createdAt: new Date().toISOString(),
        }),
      );
      this.current(p);
      if (source && !this.sourceMatches(p)) prFail("PR_SOURCE_STALE");
      if (abort.aborted) prFail("CANCELLED");
      return this.issue(this.previews, p);
    });
  }
  readPreview(original: object) {
    this.active();
    const p = this.original(this.previews, original);
    this.current(p);
    return structuredClone(p);
  }
  register(original: object, input: RegisterPrWatchInput) {
    this.active();
    return this.records.register(original, input, {
      readPreview: (o) => this.readPreview(o),
      assertPreview: (o, p) => {
        if (
          knowledgeHash(this.readPreview(o)) !== knowledgeHash(p) ||
          (p.source && !this.sourceMatches(p))
        )
          prFail("PR_PREVIEW_STALE");
      },
    });
  }
  private reader(p: PrWatchPreview) {
    let r = this.readers.get(p.apiBase);
    if (!r) {
      r = new GitHubPrReader(p.apiBase, this.allowLoopback);
      this.readers.set(p.apiBase, r);
    }
    return r;
  }
  private pollInput(input: PollPrWatchInput) {
    const p = prFields(input, [
      "workspaceId",
      "sessionId",
      "watchId",
      "requestId",
      "expectedRevision",
    ]) as unknown as PollPrWatchInput;
    for (const x of [p.workspaceId, p.sessionId, p.watchId, p.requestId])
      prId(x);
    prInt(p.expectedRevision, 2048, 1);
    return p;
  }
  poll(input: PollPrWatchInput, signal?: AbortSignal): Promise<PrPollResult> {
    this.active();
    const i = this.pollInput(input),
      key = knowledgeHash([i.workspaceId, i.sessionId, i.watchId]);
    const old = this.polls.get(key);
    if (old) return old.then(() => this.poll(i, signal));
    const operation = this.tracked(async () => {
      const duplicate = this.records.request(i);
      if (duplicate) return duplicate;
      const watch = this.records.get(i.workspaceId, i.sessionId, i.watchId);
      if (
        !watch ||
        watch.state !== "active" ||
        watch.revision !== i.expectedRevision
      )
        prFail("PR_WATCH_STALE");
      this.current(watch.preview);
      if (watch.nextPollAt && Date.parse(watch.nextPollAt) > Date.now())
        return this.records.gap(i, "PR_RATE_LIMIT", watch.nextPollAt);
      const abort = signal
        ? AbortSignal.any([signal, this.lifetime])
        : this.lifetime;
      let snapshot: PrRemoteSnapshot;
      try {
        snapshot = await this.reader(watch.preview).snapshot(
          watch.preview.repository,
          watch.preview.policy,
          abort,
        );
      } catch (error) {
        if (abort.aborted) prFail("CANCELLED");
        return this.records.gap(
          i,
          error instanceof PrHttpError ? error.code : "PR_REMOTE_GAP",
          error instanceof PrHttpError ? error.retryAt : null,
        );
      }
      if (abort.aborted) prFail("CANCELLED");
      this.current(watch.preview);
      const watermarks = this.records.checkWatermarks(
        i.sessionId,
        i.watchId,
        snapshot.head,
      );
      if (
        snapshot.checks.some(
          (c) =>
            c.id <
            (watermarks.get(knowledgeHash([c.kind, c.name, c.appId])) ?? 0),
        )
      )
        return this.records.gap(i, "PR_OUT_OF_ORDER", null);
      const original = this.issue(this.snapshots, { watch, snapshot });
      try {
        return this.records.consume(original, i, {
          readSnapshot: (o) =>
            structuredClone(this.original(this.snapshots, o).snapshot),
          assertCurrent: (o, r) => {
            const s = this.original(this.snapshots, o);
            if (s.watch.sha256 !== r.sha256) prFail("PR_WATCH_STALE");
            this.current(r.preview);
          },
          sourceCurrent: (_o, r) => this.sourceMatches(r.preview),
          acceptAtomic: (o, prompt, id) => this.accept(o, prompt, id),
          readAccepted: (o) => structuredClone(this.original(this.accepted, o)),
          releaseAccepted: (o) => this.release(o),
        });
      } finally {
        this.release(original);
      }
    });
    this.polls.set(key, operation);
    void operation.then(
      () => this.polls.delete(key),
      () => this.polls.delete(key),
    );
    return operation;
  }
  acceptWebhook(
    input: PollPrWatchInput & {
      deliveryId: string;
      event:
        "check_run" | "check_suite" | "pull_request_review" | "pull_request";
    },
    signal?: AbortSignal,
  ) {
    const p = prFields(input, [
      "workspaceId",
      "sessionId",
      "watchId",
      "requestId",
      "expectedRevision",
      "deliveryId",
      "event",
    ]) as unknown as PollPrWatchInput & { deliveryId: string; event: string };
    prId(p.deliveryId);
    if (
      ![
        "check_run",
        "check_suite",
        "pull_request_review",
        "pull_request",
      ].includes(p.event)
    )
      prFail("PR_WEBHOOK_UNSUPPORTED");
    const { deliveryId, event, ...base } = p;
    this.active();
    const requestId = "webhook:" + knowledgeHash([deliveryId, event]),
      prior = this.records.deliveryRequest(
        base.workspaceId,
        base.sessionId,
        base.watchId,
        requestId,
      );
    if (prior) return Promise.resolve(prior);
    return this.poll({ ...base, requestId }, signal);
  }
  reconcileHead(input: PollPrWatchInput, signal?: AbortSignal) {
    return this.poll(input, signal);
  }
  private accept(
    original: object,
    prompt: string,
    inputRequestId: string,
  ): object {
    const { watch, snapshot } = this.original(this.snapshots, original);
    this.current(watch.preview);
    if (
      !this.sourceMatches(watch.preview) ||
      watch.preview.source!.head !== snapshot.head ||
      (snapshot.requiredState !== "failed" && !snapshot.changesRequested)
    )
      prFail("PR_REPAIR_STALE");
    const id = knowledgeHash([watch.preview.sha256, snapshot.semanticSha256]);
    if (
      inputRequestId !== "pr-feedback:" + id ||
      prompt !==
        feedbackPrompt({
          id,
          snapshot,
          source: watch.preview.source,
          preview: watch.preview,
        })
    )
      prFail();
    const input = normalizeAcceptInput({
      sessionId: watch.preview.sessionId,
      requestId: inputRequestId,
      prompt,
      config: watch.preview.target.config,
      delivery: "queue",
    });
    this.engine.store.publishAfterCommit(() => {
      void this.engine.scheduler.wake(input.sessionId).catch(() => {});
    });
    const receipt = this.engine.store.acceptInput(input),
      stored = this.engine.store.getInput(receipt.inputId);
    if (
      stored.requestId !== inputRequestId ||
      stored.prompt !== prompt ||
      knowledgeHash(stored.config) !== knowledgeHash(input.config)
    )
      prFail("PR_INPUT_INVALID");
    return this.issue(this.accepted, {
      inputId: stored.id,
      requestId: stored.requestId,
      admittedSeq: stored.admittedSeq,
      inputSha256: knowledgeHash(input),
    });
  }
  beforePromotion(input: InputRecord) {
    const o = this.records.findInput(input);
    if (!o) return null;
    this.current(o.preview);
    const watch = this.records.get(
      input.workspaceId,
      input.sessionId,
      o.watchId,
    );
    if (
      o.state !== "accepted" ||
      !watch ||
      watch.state !== "active" ||
      watch.gap ||
      watch.snapshot?.head !== o.snapshot.head ||
      watch.snapshot.semanticSha256 !== o.snapshot.semanticSha256 ||
      !this.sourceMatches(o.preview)
    )
      prFail("PR_FEEDBACK_STALE");
    return o;
  }
  beforeProviderDispatch(run: Run) {
    const input = this.engine.store.getInput(run.inputId),
      o = this.records.findInput(input);
    if (!o) return;
    this.current(o.preview);
    const watch = this.records.get(run.workspaceId, run.sessionId, o.watchId);
    if (
      o.state !== "accepted" ||
      watch?.state !== "active" ||
      watch.gap ||
      watch.snapshot?.head !== o.snapshot.head ||
      watch.snapshot.semanticSha256 !== o.snapshot.semanticSha256 ||
      git(o.preview.binding.root, "rev-parse", "HEAD") !== o.snapshot.head ||
      !this.configurationMatches(o.preview) ||
      run.prompt !== o.prompt ||
      knowledgeHash(run.config) !== knowledgeHash(o.preview.target.config) ||
      input.state !== "promoted" ||
      run.requestId !== input.requestId ||
      input.runId !== run.id ||
      Object.hasOwn(run, "attachments") ||
      Object.hasOwn(run, "documents")
    )
      prFail("PR_REPAIR_STALE");
    if (!this.firstDispatch.has(run.id)) {
      if (!this.sourceMatches(o.preview)) prFail("PR_SOURCE_STALE");
      this.firstDispatch.add(run.id);
    }
  }
  async repairVerification(
    workspaceId: string,
    sessionId: string,
    occurrenceId: string,
  ) {
    this.open();
    const o = this.records.occurrence(workspaceId, sessionId, occurrenceId);
    if (!o?.accepted || !o.repairEligible) prFail("PR_REPAIR_NOT_ADMITTED");
    const watch = this.records.get(workspaceId, sessionId, o.watchId),
      input = this.engine.store.getInput(o.accepted.inputId);
    if (watch?.snapshot?.head !== o.snapshot.head || watch.state !== "active")
      return { status: "stale-head", mergeAuthority: false, occurrence: o };
    if (!input.runId)
      return { status: "pending", mergeAuthority: false, occurrence: o };
    const run = this.engine.store.getRun(input.runId),
      state = this.engine.verificationPlans.get(sessionId, run.id);
    if (run.state !== "completed" || !state)
      return {
        status: "incomplete",
        mergeAuthority: false,
        occurrence: o,
        runId: run.id,
      };
    const source = await this.verification.observe(
        {
          sessionId,
          runId: run.id,
          workspace: this.engine.store.getWorkspace(workspaceId),
        },
        this.lifetime,
      ),
      plan = state.plans.at(-1)!;
    for (const c of state.plans.at(-1)!.checks)
      this.engine.verificationChecks.assertCurrent(c);
    const checks = plan.checks.filter((c) => c.required),
      receipts = checks.map((c) =>
        state.receipts
          .filter((r) => r.planSha256 === plan.planSha256 && r.checkId === c.id)
          .at(-1),
      );
    if (
      !checks.length ||
      receipts.some(
        (r) =>
          !r || r.status !== "pass" || r.sourceBefore.sha256 !== source.sha256,
      )
    )
      return {
        status: "incomplete",
        mergeAuthority: false,
        occurrence: o,
        runId: run.id,
      };
    const doc = this.engine.store.getSessionDocument(
      sessionId,
      verificationDocumentKind(run.id),
    )!;
    this.engine.store.validatePrVerificationEvidence({
      runId: run.id,
      workspaceId,
      sessionId,
      verificationRevision: state.revision,
      verificationDocumentSha256: rawSha(JSON.stringify(doc.data)),
      verification: receipts,
      source,
    });
    return {
      status: "verified-local",
      mergeAuthority: false,
      occurrence: o,
      runId: run.id,
      source,
      verificationRevision: state.revision,
      receipts,
    };
  }
  disable(input: PollPrWatchInput) {
    this.active();
    const i = this.pollInput(input);
    this.stop(i.workspaceId, i.sessionId, i.watchId);
    return this.records.control(i, "disabled");
  }
  start(input: {
    workspaceId: string;
    sessionId: string;
    watchId: string;
    intervalMs: number;
  }): object {
    this.active();
    const i = prFields(input, [
      "workspaceId",
      "sessionId",
      "watchId",
      "intervalMs",
    ]) as unknown as typeof input;
    prInt(i.intervalMs, 3600000, PR_LIMITS.intervalMs);
    const watch = this.records.get(i.workspaceId, i.sessionId, i.watchId);
    if (!watch || watch.state !== "active") prFail("PR_WATCH_STALE");
    const key = knowledgeHash([i.workspaceId, i.sessionId, i.watchId]);
    if (this.loops.has(key)) prFail("PR_WATCH_RUNNING");
    const controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, this.lifetime]);
    // Register the original loop owner before its body can settle and release it.
    const promise = Promise.resolve().then(async () => {
      try {
        while (!signal.aborted) {
          const watch = this.records.get(i.workspaceId, i.sessionId, i.watchId);
          if (!watch || watch.state !== "active") break;
          try {
            await this.poll(
              {
                workspaceId: i.workspaceId,
                sessionId: i.sessionId,
                watchId: i.watchId,
                requestId: "poll:" + randomUUID(),
                expectedRevision: watch.revision,
              },
              signal,
            );
          } catch (error) {
            if (signal.aborted) break;
            throw error;
          }
          await delay(i.intervalMs, undefined, { signal });
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      } finally {
        this.loops.delete(key);
      }
    });
    this.loops.set(key, { controller, promise });
    void promise.catch(() => {});
    return Object.freeze({ watchId: i.watchId });
  }
  stop(ws: string, session: string, id: string) {
    this.loops.get(knowledgeHash([ws, session, id]))?.controller.abort();
  }
  release(original: object) {
    this.handles.delete(original);
    this.previews.delete(original);
    this.snapshots.delete(original);
    this.accepted.delete(original);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const loop of this.loops.values()) loop.controller.abort();
    await Promise.allSettled([
      ...this.pending,
      ...[...this.loops.values()].map((l) => l.promise),
    ]);
    this.handles.clear();
    this.firstDispatch.clear();
    this.readers.clear();
  }
}
