import type { MoodcodeEngine } from "../engine.js";
import type { WorkflowEffects } from "../workflows/effects.js";
import type { ActualWorkflowChildObservationPort } from "../workflows/service.js";
import type { WorkflowInstanceRevision } from "../workflows/reducer.js";
import type { WorkflowStageSpec } from "../workflows/types.js";
import { workflowAbort, workflowHostRecord } from "../workflows/host.js";
import { knowledgeHash } from "../knowledge/validation.js";
import type { ToolCatalogue } from "../tools/runtime/index.js";
import { CodingBatchStorage } from "./groups.js";
import {
  assertCodingSources,
  batchFail,
  caseSources,
  signBatch,
  validateBatch,
} from "./validation.js";
import type {
  CodingAttemptGroup,
  CodingBatchInput,
  CodingBatchPreview,
  CodingGroupMutation,
  CodingStartInput,
  CodingSelectionPreview,
  CodingEvidenceExport,
  CodingDeliveryInput,
  CodingConfig,
} from "./types.js";
interface LiveGroup {
  preview: CodingBatchPreview;
  catalogue: ToolCatalogue;
  slots: Map<string, object>;
  controller: AbortController;
  binding?: object;
  exportSha: string | null;
}
export class CodingBatchHost {
  private readonly consumedPreviews = new WeakSet<object>();
  private readonly previews = new Map<
    object,
    {
      proof: CodingBatchPreview;
      catalogue: ToolCatalogue;
      originals: import("../workflows/host.js").WorkflowStartPreview[];
    }
  >();
  private readonly selections = new Map<object, CodingSelectionPreview>();
  private readonly live = new Map<string, LiveGroup>();
  private readonly starts = new Map<
    string,
    { sha: string; result: CodingAttemptGroup }
  >();
  private readonly pending = new Map<string, Promise<CodingAttemptGroup>>();
  private readonly requestSha = new Map<string, string>();
  private readonly pendingGroups = new Map<string, string>();
  private readonly exports = new Map<object, CodingEvidenceExport>();
  private readonly lifetime = new AbortController();
  private readonly targets = new Map<
    object,
    { groupId: string; workspaceId: string; sourceSha: string }
  >();
  constructor(
    private readonly engine: MoodcodeEngine,
    private readonly native: CodingBatchStorage,
    private readonly effects: WorkflowEffects,
    private readonly children: ActualWorkflowChildObservationPort,
    private readonly enabled: boolean,
  ) {
    effects.batchPolicy = {
      merge: (r, s, p) => this.mergeGuard(r, s, p),
      settled: (r) => this.merged(r.instanceId, r.sha256),
    };
    // Reopen never recreates a child owner. Reconcile the existing lazy child
    // journal before exposing a batch whose siblings may have been live at crash.
    for (const sessionId of native.sessions())
      engine.children.recover(sessionId);
    native.recover();
  }
  private open() {
    if (!this.enabled) batchFail("CODING_BATCH_DISABLED");
    workflowAbort(this.lifetime.signal);
  }
  private current(ws: string, id: string): CodingAttemptGroup {
    const r = this.native.list(ws).find((g) => g.groupId === id);
    if (!r) batchFail("CODING_BATCH_MISSING");
    return r;
  }
  private write(
    prior: CodingAttemptGroup,
    change: Partial<CodingAttemptGroup>,
  ): CodingAttemptGroup {
    const next = signBatch({
      ...prior,
      ...change,
      revision: prior.revision + 1,
      previousSha256: prior.sha256,
    });
    this.native.put(next, prior.revision);
    return next;
  }
  private assertLive(record: CodingAttemptGroup): LiveGroup {
    this.open();
    const live = this.live.get(
      knowledgeHash([record.workspaceId, record.groupId]),
    );
    if (
      !live ||
      record.state === "paused-import" ||
      record.state === "uncertain" ||
      record.state === "cancelled"
    )
      batchFail("CODING_BATCH_RUNTIME_UNAVAILABLE");
    workflowAbort(live.controller.signal);
    const run = this.engine.coordinator.getOwnedActiveRun(record.parentRunId);
    if (
      knowledgeHash(run.config) !== live.preview.configSha256 ||
      run.sessionId !== record.sessionId
    )
      batchFail("CODING_BATCH_CONFIG_STALE");
    this.engine.toolRuntime.assertCatalogueCurrent(live.catalogue);
    if (
      Date.now() - Date.parse(record.createdAt) >
      record.preview.input.limits.maxDurationMs
    )
      batchFail("CODING_BATCH_DURATION_LIMIT");
    if (record.selection?.state !== "merged")
      assertCodingSources(live.preview.sources);
    return live;
  }
  async preview(input: CodingBatchInput): Promise<CodingBatchPreview> {
    this.open();
    const selection = validateBatch(input),
      run = this.engine.coordinator.getOwnedActiveRun(selection.parentRunId);
    if (
      run.sessionId !== selection.rootSessionId ||
      run.workspaceId !== selection.workspaceId
    )
      batchFail("CODING_BATCH_OWNER_STALE");
    if (
      this.native.list(selection.workspaceId).length >= 16 ||
      this.previews.size >= 16
    )
      batchFail("CODING_BATCH_LIMIT");
    const previews = [];
    try {
      for (const c of selection.cases) {
        const registered = this.engine.registerWorkflow({
          workspaceId: selection.workspaceId,
          requestId: `batch-spec:${selection.groupId}:${c.id}`,
          expectedRevision: 0,
          spec: c.spec,
        });
        previews.push(
          await this.engine.previewWorkflowStart({
            workspaceId: selection.workspaceId,
            rootSessionId: selection.rootSessionId,
            parentRunId: selection.parentRunId,
            workflowId: registered.record.workflowId,
            expectedSpecRevision: registered.record.revision,
            parameters: {},
            stageWorktrees: c.stageWorktrees,
          }),
        );
      }
      const profile = this.engine.profiles.forRun(run.sessionId, run.config),
        catalogue = this.engine.toolRuntime.catalogue(
          run.sessionId,
          run.config.mode,
          profile?.tools,
          profile ? { id: profile.id, revision: profile.revision } : undefined,
        ),
        sources = caseSources(
          this.engine.store.getWorkspace(run.workspaceId).root,
          selection,
        ),
        stages = selection.cases.flatMap((c) => c.spec.stages),
        attempts = stages.reduce(
          (n, s) =>
            n + s.allocation.turns * run.config.budgets!.maxProviderAttempts,
          0,
        ),
        reservedTokens =
          attempts * run.config.limits.maxContextBytes +
          stages.reduce((n, s) => n + s.allocation.outputBytes, 0),
        reservedCostMicros = attempts * selection.limits.costPerRequestMicros;
      if (
        sources.reduce((n, p) => n + p.size, 0) >
          selection.limits.maxSourceBytes ||
        reservedTokens > selection.limits.maxTokens ||
        reservedCostMicros > selection.limits.maxCostMicros
      )
        batchFail("CODING_BATCH_BUDGET_EXCEEDED");
      const proof = signBatch({
        version: 1 as const,
        input: selection,
        previews,
        sources,
        configSha256: knowledgeHash(run.config),
        catalogueSha256: knowledgeHash(catalogue),
        reservedTokens,
        reservedCostMicros,
      });
      this.previews.set(proof, { proof, catalogue, originals: previews });
      return proof;
    } catch (e) {
      for (const p of previews) this.engine.releaseWorkflowStartPreview(p);
      throw e;
    }
  }
  start(input: CodingStartInput): CodingAttemptGroup {
    workflowHostRecord(
      input,
      ["workspaceId", "requestId", "approved", "preview"],
      ["signal"],
    );
    workflowAbort(input.signal);
    this.open();
    if (input.approved !== true) batchFail("CODING_BATCH_APPROVAL_REQUIRED");
    const p = this.previews.get(input.preview);
    if (
      !p ||
      p.proof !== input.preview ||
      p.proof.input.workspaceId !== input.workspaceId
    )
      batchFail("CODING_BATCH_ORIGINAL_REQUIRED");
    const key = knowledgeHash([input.workspaceId, input.requestId]),
      digest = knowledgeHash([p.proof.sha256, input.approved]);
    const existing = this.starts.get(key);
    if (existing) {
      if (existing.sha !== digest) batchFail("CODING_BATCH_REQUEST_CONFLICT");
      return structuredClone(existing.result);
    }
    if (this.consumedPreviews.has(input.preview))
      batchFail("CODING_BATCH_ADMISSION_UNCERTAIN");
    if (
      this.native
        .list(input.workspaceId)
        .some((g) => g.groupId === p.proof.input.groupId)
    )
      batchFail("CODING_BATCH_EXISTS");
    assertCodingSources(p.proof.sources);
    this.engine.toolRuntime.assertCatalogueCurrent(p.catalogue);
    const run = this.engine.coordinator.getOwnedActiveRun(
      p.proof.input.parentRunId,
    );
    if (knowledgeHash(run.config) !== p.proof.configSha256)
      batchFail("CODING_BATCH_CONFIG_STALE");
    const allocations = p.proof.input.cases.flatMap((c) =>
        c.spec.stages.map((s) => s.allocation),
      ),
      remaining = this.engine.coordinator.getRemainingChildBudget(run.id);
    for (const key of [
      "turns",
      "toolCalls",
      "outputBytes",
      "durationMs",
    ] as const)
      if (allocations.reduce((n, a) => n + a[key], 0) > remaining[key])
        batchFail("CHILD_BUDGET_EXCEEDED");
    this.consumedPreviews.add(input.preview);
    const slots = new Map<string, object>();
    const group = this.engine.store.withWorkflowEffectsTransaction(() => {
      const instances = p.originals.map(
        (preview, i) =>
          this.engine.startWorkflow({
            workspaceId: input.workspaceId,
            requestId: `batch-instance:${p.proof.input.groupId}:${p.proof.input.cases[i]!.id}`,
            approved: true,
            preview,
          }).record,
      );
      const originals = this.engine.coordinator.reserveChildRunGroup(
        run.id,
        allocations,
      );
      let cursor = 0;
      for (const c of p.proof.input.cases)
        for (const stage of c.spec.stages)
          slots.set(`${c.id}:${stage.id}`, originals[cursor++]!);
      const record = signBatch({
        version: 1 as const,
        workspaceId: input.workspaceId,
        sessionId: run.sessionId,
        parentRunId: run.id,
        groupId: p.proof.input.groupId,
        revision: 1,
        previousSha256: null,
        requestId: input.requestId,
        preview: p.proof,
        state: "running" as const,
        cases: p.proof.input.cases.map((c, i) => ({
          id: c.id,
          instanceId: instances[i]!.instanceId,
          state: "pending" as const,
          stage: 0,
          errorCode: null,
          receiptSha256: null,
        })),
        usage: {
          requests: 0,
          reservedTokens: p.proof.reservedTokens,
          chargedCostMicros: 0,
          measuredInputTokens: null,
          measuredOutputTokens: null,
          unknownUsageRequests: 0,
        },
        selection: null,
        createdAt: new Date().toISOString(),
      });
      this.native.put(record, 0);
      return record;
    });
    this.live.set(knowledgeHash([group.workspaceId, group.groupId]), {
      preview: p.proof,
      catalogue: p.catalogue,
      slots,
      controller: new AbortController(),
      exportSha: null,
    });
    this.starts.set(key, { sha: digest, result: structuredClone(group) });
    return structuredClone(group);
  }
  private member(record: WorkflowInstanceRevision) {
    for (const g of this.native.list(record.workspaceId)) {
      const c = g.cases.find((c) => c.instanceId === record.instanceId);
      if (c) return { g, c };
    }
    return null;
  }
  reserved(
    record: WorkflowInstanceRevision,
    stage: WorkflowStageSpec,
  ): boolean {
    const member = this.member(record);
    if (!member) return false;
    const live = this.assertLive(member.g),
      slot = live.slots.get(`${member.c.id}:${stage.id}`);
    if (
      member.c.state !== "running" ||
      ["edit", "validate", "review"][member.c.stage] !== stage.id
    )
      batchFail("CODING_MEMBER_NOT_ADMITTED");
    if (!slot) batchFail("CODING_RESERVATION_STALE");
    this.engine.coordinator.assertChildRunGroupSlot(
      slot,
      member.g.parentRunId,
      stage.allocation,
    );
    return true;
  }
  dispatch(
    record: WorkflowInstanceRevision,
    stage: WorkflowStageSpec,
    requestId: string,
  ): void {
    const member = this.member(record);
    if (!member) return;
    const live = this.assertLive(member.g),
      slot = live.slots.get(`${member.c.id}:${stage.id}`);
    if (
      member.c.state !== "running" ||
      ["edit", "validate", "review"][member.c.stage] !== stage.id
    )
      batchFail("CODING_MEMBER_NOT_ADMITTED");
    if (!slot) batchFail("CODING_RESERVATION_STALE");
    this.engine.children.installCodingMember(
      member.g.sessionId,
      requestId,
      slot,
      () =>
        this.assertLive(this.current(member.g.workspaceId, member.g.groupId)),
      () => this.charge(member.g.workspaceId, member.g.groupId),
    );
  }
  private charge(ws: string, id: string): void {
    const prior = this.current(ws, id);
    this.assertLive(prior);
    const limits = prior.preview.input.limits,
      cost = prior.usage.chargedCostMicros + limits.costPerRequestMicros;
    if (cost > limits.maxCostMicros) batchFail("CODING_BATCH_COST_LIMIT");
    this.write(prior, {
      usage: {
        ...prior.usage,
        requests: prior.usage.requests + 1,
        chargedCostMicros: cost,
        unknownUsageRequests: prior.usage.unknownUsageRequests + 1,
      },
    });
  }
  observed(
    record: WorkflowInstanceRevision,
    stageId: string,
    original: object,
  ): void {
    let member = this.member(record);
    if (!member) return;
    const actual = this.children.readExecution?.(original);
    if (stageId === "edit") {
      const effect = this.engine.inspectWorkflowEffect(
          record.workspaceId,
          record.instanceId,
          "edit",
        ),
        definition = member.g.preview.input.cases.find(
          (c) => c.id === member!.c.id,
        )!;
      if (
        !effect ||
        effect.files.some(
          (p) =>
            !definition.sourcePaths.some(
              (path) => p.path === record.worktrees.edit!.root + "/" + path,
            ),
        )
      )
        batchFail("CODING_EFFECT_OUTSIDE_MANIFEST");
    }
    if (actual) {
      const usages = actual.attemptUsages ?? [],
        known = usages.filter(
          (u) =>
            typeof u.usage.inputTokens === "number" &&
            Number.isSafeInteger(u.usage.inputTokens) &&
            u.usage.inputTokens >= 0 &&
            typeof u.usage.outputTokens === "number" &&
            Number.isSafeInteger(u.usage.outputTokens) &&
            u.usage.outputTokens >= 0,
        );
      const g = this.write(member.g, {
        usage: {
          ...member.g.usage,
          measuredInputTokens: known.length
            ? (member.g.usage.measuredInputTokens ?? 0) +
              known.reduce((n, u) => n + u.usage.inputTokens!, 0)
            : member.g.usage.measuredInputTokens,
          measuredOutputTokens: known.length
            ? (member.g.usage.measuredOutputTokens ?? 0) +
              known.reduce((n, u) => n + u.usage.outputTokens!, 0)
            : member.g.usage.measuredOutputTokens,
          unknownUsageRequests: Math.max(
            0,
            member.g.usage.unknownUsageRequests - known.length,
          ),
        },
      });
      member = { ...member, g };
    }
    if (stageId !== "review") {
      this.write(member.g, {
        cases: member.g.cases.map((c) =>
          c.id === member!.c.id
            ? { ...c, stage: stageId === "edit" ? 1 : 2 }
            : c,
        ),
      });
      return;
    }
    const completion = this.children.readCompletion(original);
    if (
      record.state !== "completed" ||
      completion.state !== "completed" ||
      !completion.complete ||
      !this.children.readExecution
    )
      batchFail("CODING_REVIEW_INCOMPLETE");
    const evidence = this.children.readExecution(original),
      editor = this.engine.inspectWorkflowEffect(
        record.workspaceId,
        record.instanceId,
        "edit",
      )!,
      validator = this.engine.inspectWorkflowEffect(
        record.workspaceId,
        record.instanceId,
        "validate",
      )!;
    const receipt = signBatch({
      version: 1 as const,
      workspaceId: record.workspaceId,
      sessionId: record.owner.sessionId,
      groupId: member.g.groupId,
      caseId: member.c.id,
      sourceSha256: member.g.preview.sha256,
      instance: record,
      reviewer: evidence,
      completion,
      editorSha256: editor.sha256,
      validatorSha256: validator.sha256,
    });
    if (
      Buffer.byteLength(JSON.stringify(receipt)) >
      member.g.preview.input.limits.maxEvidenceBytes
    )
      batchFail("CODING_EVIDENCE_LIMIT");
    this.native.putCase(receipt);
    this.write(member.g, {
      cases: member.g.cases.map((c) =>
        c.id === member.c.id
          ? {
              ...c,
              state: "verified" as const,
              stage: 3,
              receiptSha256: receipt.sha256,
            }
          : c,
      ),
    });
  }
  run(input: CodingGroupMutation): Promise<CodingAttemptGroup> {
    workflowHostRecord(
      input,
      ["workspaceId", "groupId", "requestId", "expectedRevision", "approved"],
      ["signal"],
    );
    workflowAbort(input.signal);
    this.open();
    if (input.approved !== true) batchFail("CODING_BATCH_APPROVAL_REQUIRED");
    const prior = this.current(input.workspaceId, input.groupId),
      key = knowledgeHash([input.workspaceId, input.groupId, input.requestId]),
      scope = knowledgeHash([input.workspaceId, input.groupId]);
    const digest = knowledgeHash({
        workspaceId: input.workspaceId,
        groupId: input.groupId,
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
        approved: input.approved,
      }),
      cached = this.pending.get(key);
    if (cached) {
      if (this.requestSha.get(key) !== digest)
        batchFail("CODING_BATCH_REQUEST_CONFLICT");
      return cached.then((r) => structuredClone(r));
    }
    if (input.expectedRevision !== prior.revision)
      batchFail("CODING_BATCH_STALE");
    if (this.pending.size >= 128) batchFail("CODING_REQUEST_LIMIT");
    this.assertLive(prior);
    if ([...this.pendingGroups.values()].includes(scope))
      batchFail("CODING_BATCH_STALE");
    const promise = this.execute(input),
      settled = () => this.pendingGroups.delete(key);
    this.requestSha.set(key, digest);
    this.pending.set(key, promise);
    this.pendingGroups.set(key, scope);
    void promise.then(settled, settled);
    return promise.then((r) => structuredClone(r));
  }
  private async execute(
    input: CodingGroupMutation,
  ): Promise<CodingAttemptGroup> {
    const first = this.current(input.workspaceId, input.groupId),
      live = this.assertLive(first),
      signal = AbortSignal.any([
        this.lifetime.signal,
        live.controller.signal,
        ...(input.signal ? [input.signal] : []),
      ]),
      queue = first.cases.filter((c) => c.state === "pending").map((c) => c.id);
    let index = 0;
    const worker = async () => {
      for (;;) {
        workflowAbort(signal);
        const id = queue[index++];
        if (!id) return;
        let group = this.current(input.workspaceId, input.groupId);
        if (group.cases.find((c) => c.id === id)?.state !== "pending") continue;
        this.write(group, {
          cases: group.cases.map((c) =>
            c.id === id ? { ...c, state: "running" as const } : c,
          ),
        });
        const c = group.cases.find((c) => c.id === id)!;
        try {
          for (const stage of ["edit", "validate", "review"]) {
            workflowAbort(signal);
            let w = this.engine.inspectWorkflow(
              group.workspaceId,
              c.instanceId,
            )!;
            await this.engine.startWorkflowStage({
              workspaceId: group.workspaceId,
              instanceId: c.instanceId,
              stageId: stage,
              requestId: `batch:${group.groupId}:${id}:${stage}`,
              expectedRevision: w.revision,
              approved: true,
              signal,
            });
            w = this.engine.inspectWorkflow(group.workspaceId, c.instanceId)!;
            const result = await this.engine.observeWorkflowStage({
              workspaceId: group.workspaceId,
              instanceId: c.instanceId,
              stageId: stage,
              requestId: `batch-observe:${group.groupId}:${id}:${stage}`,
              expectedRevision: w.revision,
              signal,
            });
            if (
              result.record.stages.find((s) => s.stageId === stage)?.state !==
              "completed"
            )
              batchFail("CODING_CASE_FAILED");
          }
        } catch (e) {
          group = this.current(input.workspaceId, input.groupId);
          const tasks =
              this.engine
                .inspectWorkflow(group.workspaceId, c.instanceId)
                ?.stages.filter((s) => s.child)
                .map((s) =>
                  this.engine.children.tasks.get(
                    group.sessionId,
                    s.child!.taskId,
                  ),
                ) ?? [],
            unknown = tasks.some(
              (t) => !["completed", "failed", "cancelled"].includes(t.state),
            );
          this.write(group, {
            cases: group.cases.map((c) =>
              c.id === id
                ? {
                    ...c,
                    state: unknown
                      ? ("uncertain" as const)
                      : signal.aborted
                        ? ("cancelled" as const)
                        : ("failed" as const),
                    errorCode:
                      e instanceof Error && "code" in e
                        ? String(e.code)
                        : "CODING_CASE_FAILED",
                  }
                : c,
            ),
          });
        }
      }
    };
    await Promise.allSettled(
      Array.from(
        {
          length: Math.min(
            queue.length,
            first.preview.input.limits.concurrency,
          ),
        },
        worker,
      ),
    );
    const latest = this.current(input.workspaceId, input.groupId);
    return this.write(latest, {
      state: latest.cases.some((c) => c.state === "uncertain")
        ? "uncertain"
        : latest.cases.some((c) => c.state === "verified")
          ? "ready"
          : latest.cases.every((c) =>
                ["failed", "cancelled", "skipped"].includes(c.state),
              )
            ? "cancelled"
            : "running",
    });
  }
  inspect(ws: string, id: string) {
    return this.engine.store.readExecutionObservationEvidence(() =>
      this.current(ws, id),
    );
  }
  async previewSelection(input: {
    workspaceId: string;
    groupId: string;
    caseId: string;
    expectedRevision: number;
  }): Promise<CodingSelectionPreview> {
    workflowHostRecord(input, [
      "workspaceId",
      "groupId",
      "caseId",
      "expectedRevision",
    ]);
    if (this.selections.size >= 32) batchFail("CODING_HANDLE_LIMIT");
    const g = this.current(input.workspaceId, input.groupId);
    this.assertLive(g);
    if (
      g.revision !== input.expectedRevision ||
      g.selection?.state === "merged"
    )
      batchFail("CODING_SELECTION_STALE");
    const c = g.cases.find((c) => c.id === input.caseId),
      receipt = c && this.native.case(g.sessionId, g.groupId, c.id);
    if (c?.state !== "verified" || !receipt)
      batchFail("CODING_SELECTION_UNVERIFIED");
    const candidate = await this.effects.assertMergeCandidate(
      g.workspaceId,
      c.instanceId,
      "edit",
    );
    const proof = signBatch({
      version: 1 as const,
      workspaceId: g.workspaceId,
      groupId: g.groupId,
      groupSha256: g.sha256,
      expectedRevision: g.revision,
      caseId: c.id,
      caseSha256: receipt.sha256,
      editorSha256: candidate.editor.sha256,
      validatorSha256: candidate.validator.sha256,
      head: candidate.head,
    });
    this.selections.set(proof, proof);
    return proof;
  }
  select(input: {
    workspaceId: string;
    requestId: string;
    approved: boolean;
    preview: CodingSelectionPreview;
  }): CodingAttemptGroup {
    workflowHostRecord(input, [
      "workspaceId",
      "requestId",
      "approved",
      "preview",
    ]);
    this.open();
    if (input.approved !== true)
      batchFail("CODING_SELECTION_APPROVAL_REQUIRED");
    const preview = this.selections.get(input.preview);
    if (!preview || input.workspaceId !== preview.workspaceId)
      batchFail("CODING_BATCH_ORIGINAL_REQUIRED");
    const g = this.current(input.workspaceId, preview.groupId),
      live = this.assertLive(g);
    if (
      g.selection?.requestId === input.requestId &&
      g.selection.caseSha256 === preview.caseSha256
    )
      return structuredClone(g);
    if (g.sha256 !== preview.groupSha256 || g.selection?.state === "merged")
      batchFail("CODING_SELECTION_STALE");
    if (live.binding) this.engine.releaseWorkflowModelTools(live.binding);
    live.binding = this.engine.bindWorkflowModelTools({
      workspaceId: g.workspaceId,
      instanceId: g.cases.find((c) => c.id === preview.caseId)!.instanceId,
    });
    const selection = signBatch({
      revision: (g.selection?.revision ?? 0) + 1,
      requestId: input.requestId,
      caseId: preview.caseId,
      caseSha256: preview.caseSha256,
      editorSha256: preview.editorSha256,
      validatorSha256: preview.validatorSha256,
      state: "selected" as const,
      mergeSha256: null,
    });
    return this.write(g, { selection });
  }
  private mergeGuard(
    instance: WorkflowInstanceRevision,
    stageId: string,
    phase: "prepare" | "execute",
  ): import("@moodcode/contracts").JsonObject | null {
    const member = this.member(instance);
    if (!member) return null;
    this.assertLive(member.g);
    if (
      stageId !== "edit" ||
      member.g.selection?.state !== "selected" ||
      member.g.selection.caseId !== member.c.id
    )
      batchFail("CODING_SELECTION_REQUIRED");
    const receipt = this.native.case(
      member.g.sessionId,
      member.g.groupId,
      member.c.id,
    );
    if (!receipt || receipt.sha256 !== member.g.selection.caseSha256)
      batchFail("CODING_SELECTION_STALE");
    return {
      groupId: member.g.groupId,
      groupRevision: member.g.revision,
      groupSha256: member.g.sha256,
      selectionSha256: member.g.selection.sha256,
    };
  }
  private merged(instanceId: string, sha: string): void {
    for (const ws of this.engine.store.listWorkspaces())
      for (const g of this.native.list(ws.id)) {
        const c = g.cases.find((c) => c.instanceId === instanceId);
        if (!c || !g.selection || g.selection.caseId !== c.id) continue;
        if (g.selection.state !== "selected")
          batchFail("CODING_SELECTION_STALE");
        this.write(g, {
          state: "completed",
          selection: signBatch({
            ...g.selection,
            state: "merged" as const,
            mergeSha256: sha,
          }),
        });
      }
  }
  skip(input: CodingGroupMutation & { caseId: string }): CodingAttemptGroup {
    workflowHostRecord(
      input,
      [
        "workspaceId",
        "groupId",
        "requestId",
        "expectedRevision",
        "approved",
        "caseId",
      ],
      ["signal"],
    );
    const g = this.current(input.workspaceId, input.groupId);
    this.assertLive(g);
    if (input.approved !== true) batchFail("CODING_BATCH_APPROVAL_REQUIRED");
    if (g.revision !== input.expectedRevision) batchFail("CODING_BATCH_STALE");
    if (g.cases.find((c) => c.id === input.caseId)?.state !== "pending")
      batchFail("CODING_CASE_ALREADY_EFFECTED");
    return this.write(g, {
      cases: g.cases.map((c) =>
        c.id === input.caseId ? { ...c, state: "skipped" as const } : c,
      ),
    });
  }
  async resume(input: CodingGroupMutation): Promise<CodingAttemptGroup> {
    workflowHostRecord(
      input,
      ["workspaceId", "groupId", "requestId", "expectedRevision", "approved"],
      ["signal"],
    );
    workflowAbort(input.signal);
    if (input.approved !== true) batchFail("CODING_BATCH_APPROVAL_REQUIRED");
    const g = this.current(input.workspaceId, input.groupId);
    if (input.expectedRevision !== g.revision) batchFail("CODING_BATCH_STALE");
    if (g.state === "completed" && g.selection?.state === "merged") {
      const target = this.captureDelivery({
        workspaceId: g.workspaceId,
        groupId: g.groupId,
        config: this.engine.store.getRun(g.parentRunId).config,
      });
      this.release(target);
      return structuredClone(g);
    }
    this.assertLive(g);
    const live = this.live.get(knowledgeHash([g.workspaceId, g.groupId]))!;
    for (const c of g.cases.filter((c) => c.state === "verified"))
      await this.effects.assertMergeCandidate(
        g.workspaceId,
        c.instanceId,
        "edit",
      );
    if (live.exportSha) {
      const exported = this.export(g.workspaceId, g.groupId);
      if (exported.sha256 !== live.exportSha) batchFail("CODING_EXPORT_STALE");
    }
    if (g.selection?.state === "merged") return structuredClone(g);
    if (g.cases.some((c) => c.state === "running" || c.state === "uncertain"))
      batchFail("CODING_RESUME_UNCERTAIN");
    const next = g.cases.some((c) => c.state === "skipped")
      ? this.write(g, {
          cases: g.cases.map((c) =>
            c.state === "skipped" ? { ...c, state: "pending" as const } : c,
          ),
          state: "running",
        })
      : g;
    return this.run({ ...input, expectedRevision: next.revision });
  }
  async cancel(input: CodingGroupMutation): Promise<CodingAttemptGroup> {
    workflowHostRecord(
      input,
      ["workspaceId", "groupId", "requestId", "expectedRevision", "approved"],
      ["signal"],
    );
    const g = this.current(input.workspaceId, input.groupId),
      live = this.assertLive(g);
    if (input.approved !== true) batchFail("CODING_BATCH_APPROVAL_REQUIRED");
    if (g.revision !== input.expectedRevision) batchFail("CODING_BATCH_STALE");
    live.controller.abort();
    const results = await Promise.allSettled(
      g.cases.flatMap((c) =>
        (this.engine.inspectWorkflow(g.workspaceId, c.instanceId)?.stages ?? [])
          .filter((s) => s.child)
          .map((s) =>
            this.engine.children.tasks.cancel(g.sessionId, s.child!.taskId),
          ),
      ),
    );
    const scope = knowledgeHash([g.workspaceId, g.groupId]);
    await Promise.allSettled(
      [...this.pending]
        .filter(([key]) => this.pendingGroups.get(key) === scope)
        .map(([, operation]) => operation),
    );
    const latest = this.current(input.workspaceId, input.groupId);
    return this.write(latest, {
      state: results.some(
        (r) => r.status === "rejected" || r.value.state === "uncertain",
      )
        ? "uncertain"
        : "cancelled",
      cases: latest.cases.map((c) => {
        if (c.state === "pending") return { ...c, state: "cancelled" as const };
        if (c.state === "uncertain" || c.state === "running") {
          const tasks = this.engine
            .inspectWorkflow(g.workspaceId, c.instanceId)!
            .stages.filter((s) => s.child)
            .map((s) =>
              this.engine.children.tasks.get(g.sessionId, s.child!.taskId),
            );
          if (tasks.length && tasks.every((t) => t.state === "cancelled"))
            return { ...c, state: "cancelled" as const };
        }
        return c;
      }),
    });
  }
  export(ws: string, id: string): CodingEvidenceExport {
    const g = this.current(ws, id),
      cases = g.cases.flatMap((c) => {
        const r = this.native.case(g.sessionId, id, c.id);
        return r ? [r] : [];
      }),
      result = signBatch({ version: 1 as const, group: g, cases });
    if (
      Buffer.byteLength(JSON.stringify(result)) >
      g.preview.input.limits.maxExportBytes
    )
      batchFail("CODING_EXPORT_LIMIT");
    return result;
  }
  captureExport(ws: string, id: string): object {
    if (this.exports.size >= 32) batchFail("CODING_HANDLE_LIMIT");
    const g = this.current(ws, id);
    let live: LiveGroup;
    if (g.state === "completed") {
      live = this.live.get(knowledgeHash([g.workspaceId, g.groupId]))!;
      if (!live) batchFail("CODING_BATCH_RUNTIME_UNAVAILABLE");
      const target = this.captureDelivery({
        workspaceId: ws,
        groupId: id,
        config: this.engine.store.getRun(g.parentRunId).config,
      });
      this.release(target);
    } else live = this.assertLive(g);
    for (const c of g.cases.filter((c) => c.state === "verified"))
      this.effects.assertCandidateFiles(g.workspaceId, c.instanceId);
    const data = this.export(ws, id),
      original = Object.freeze(Object.create(null));
    live.exportSha = data.sha256;
    this.exports.set(original, data);
    return original;
  }
  readExport(original: object): CodingEvidenceExport {
    const data = this.exports.get(original);
    if (!data) batchFail("CODING_BATCH_ORIGINAL_REQUIRED");
    return structuredClone(data);
  }
  release(original: object) {
    const preview = this.previews.get(original);
    if (preview) {
      for (const p of preview.originals)
        this.engine.releaseWorkflowStartPreview(p);
      this.previews.delete(original);
    }
    this.selections.delete(original);
    this.exports.delete(original);
    if (this.targets.delete(original)) this.effects.release(original);
  }
  captureDelivery(input: {
    workspaceId: string;
    groupId: string;
    config: CodingConfig;
  }): object {
    workflowHostRecord(input, ["workspaceId", "groupId", "config"]);
    this.open();
    const g = this.current(input.workspaceId, input.groupId);
    if (
      g.selection?.state !== "merged" ||
      g.state !== "completed" ||
      !this.live.has(knowledgeHash([g.workspaceId, g.groupId]))
    )
      batchFail("CODING_RESULT_UNAVAILABLE");
    const c = g.cases.find((c) => c.id === g.selection!.caseId)!;
    const target = this.effects.captureTarget({
      workspaceId: g.workspaceId,
      instanceId: c.instanceId,
      config: input.config,
    });
    this.targets.set(target, {
      groupId: g.groupId,
      workspaceId: g.workspaceId,
      sourceSha: g.sha256,
    });
    return target;
  }
  readDelivery(original: object) {
    if (!this.targets.has(original))
      batchFail("CODING_BATCH_ORIGINAL_REQUIRED");
    return this.effects.readTarget(original);
  }
  deliver(input: CodingDeliveryInput) {
    workflowHostRecord(
      input,
      [
        "workspaceId",
        "groupId",
        "requestId",
        "expectedRevision",
        "approved",
        "target",
      ],
      ["signal"],
    );
    this.open();
    workflowAbort(input.signal);
    if (input.approved !== true) batchFail("CODING_BATCH_APPROVAL_REQUIRED");
    const t = this.targets.get(input.target);
    if (
      !t ||
      t.workspaceId !== input.workspaceId ||
      t.groupId !== input.groupId
    )
      batchFail("CODING_BATCH_ORIGINAL_REQUIRED");
    const g = this.current(input.workspaceId, input.groupId);
    if (g.sha256 !== t.sourceSha) batchFail("CODING_SELECTION_STALE");
    return this.effects.deliver({
      workspaceId: g.workspaceId,
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      approved: input.approved,
      target: input.target,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }
  async close() {
    this.lifetime.abort();
    for (const live of this.live.values()) live.controller.abort();
    await Promise.allSettled([...this.pending.values()]);
    for (const live of this.live.values())
      if (live.binding) this.engine.releaseWorkflowModelTools(live.binding);
    this.live.clear();
    this.previews.clear();
    this.exports.clear();
  }
}
