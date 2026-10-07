import { randomUUID } from "node:crypto";
import { types } from "node:util";
import {
  EngineError,
  isTerminal,
  type JsonObject,
  type Run,
} from "@moodcode/contracts";
import type {
  CoordinatorOptions,
  LifecycleContinuationCapture,
  LifecycleContinuationRequest,
} from "../ports.js";
import type { SqliteStore } from "../storage/index.js";
import type {
  VerificationController,
  VerificationControllerSnapshot,
  VerificationRemainingBudget,
} from "../verification/controller.js";
import {
  evaluateVerificationCompletion,
  normalizeVerificationBoundary,
  normalizeVerificationControllerProfile,
  type VerificationBoundary,
  type VerificationControllerProfile,
} from "../verification/completion.js";
import type { VerificationPlanService } from "../verification/plans.js";
import {
  normalizeVerificationSource,
  verificationHash,
  verificationNumber,
  verificationPlain,
  verificationText,
  type VerificationSnapshot,
  type VerificationSource,
} from "../verification/types.js";
import { boundedLifecycleJson, freezeLifecycle } from "./validation.js";

export interface LifecycleContinuationPorts {
  store: SqliteStore;
  controller: VerificationController;
  plans: VerificationPlanService;
  observeSource(run: Run, signal: AbortSignal): Promise<VerificationSource>;
  readCurrentProfile(run: Run): VerificationControllerProfile | null;
  /** Called during capture/admission under the original Run's existing workspace lease. */
  assertBoundaryCurrent(run: Run, boundary: VerificationBoundary): void;
  readRemainingBudget(run: Run): VerificationRemainingBudget;
}
interface Graph {
  boundary: VerificationBoundary;
  controllerRevision: number;
  verificationSha256: string;
  verificationRevision: number;
  snapshotSha256: string;
  source: VerificationSource;
  profile: VerificationControllerProfile | null;
  runConfigSha256: string;
  turnSha256: string;
  attemptId: string;
  attemptSha256: string;
  cleanupSha256: string;
}
interface Captured {
  runId: string;
  sessionId: string;
  workspaceId: string;
  graph: Graph;
  documentRevision: number;
  documentSha256: string;
  messageSha256: string;
  originalBudget: VerificationRemainingBudget;
}
export function lifecycleContinuationDocumentKind(runId: string): string {
  verificationText(runId);
  return "lifecycle.continuation." + verificationHash(runId).slice(0, 40);
}
function fail(code: string, message: string): never {
  throw new EngineError(code, message);
}
function check(signal: AbortSignal): void {
  if (signal.aborted) fail("CANCELLED", "Lifecycle continuation was cancelled");
}
function plainRun(value: Run): void {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (item) => !Object.hasOwn(item, "value"),
    )
  )
    fail(
      "INVALID_LIFECYCLE_CONTINUATION",
      "Lifecycle continuation requires a plain original Run",
    );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    !["id", "sessionId", "workspaceId", "config"].every((key) =>
      Object.hasOwn(descriptors, key),
    )
  )
    fail(
      "INVALID_LIFECYCLE_CONTINUATION",
      "Continuation Run identity and configuration must be original own data",
    );
  verificationText(value.id);
  verificationText(value.sessionId);
  verificationText(value.workspaceId);
  boundedLifecycleJson(value.config, 65_536);
}

/** Read-only native evidence is observed anew; a descriptive controller status alone is insufficient. */
export function createLifecycleContinuationPort(
  ports: LifecycleContinuationPorts,
): NonNullable<CoordinatorOptions["lifecycleContinuation"]> {
  const handles = new WeakMap<LifecycleContinuationCapture, Captured>();
  const owner = (value: Run, signal: AbortSignal): Run => {
    check(signal);
    plainRun(value);
    const run = ports.store.getRun(value.id),
      session = ports.store.getSession(value.sessionId),
      control = ports.store.getSessionControl(value.sessionId);
    if (
      run.sessionId !== value.sessionId ||
      run.workspaceId !== value.workspaceId ||
      session.workspaceId !== run.workspaceId ||
      verificationHash(run.config) !== verificationHash(value.config)
    )
      fail(
        "LIFECYCLE_CONTINUATION_STALE",
        "Lifecycle continuation no longer matches its original Run",
      );
    if (
      isTerminal(run.state) ||
      run.state === "cancelling" ||
      control.paused ||
      ports.store.hasUncertainWorkspace(run.workspaceId)
    )
      fail(
        "LIFECYCLE_CONTINUATION_STALE",
        "Lifecycle continuation requires an active unpaused Run with confirmed cleanup",
      );
    return run;
  };
  const budget = (
    run: Run,
    ceiling?: VerificationRemainingBudget,
    reservedTurn = false,
  ): VerificationRemainingBudget => {
    const current = ports.readRemainingBudget(run);
    verificationPlain(current, [
      "turns",
      "toolCalls",
      "outputBytes",
      "durationMs",
    ]);
    for (const [key, limit] of [
      ["turns", run.config.limits.maxTurns],
      ["toolCalls", run.config.limits.maxToolCalls],
      ["outputBytes", run.config.limits.maxOutputBytes],
      ["durationMs", run.config.limits.maxDurationMs],
    ] as const) {
      verificationNumber(current[key], limit);
      if (
        (current[key] <= 0 &&
          key !== "toolCalls" &&
          !(reservedTurn && key === "turns")) ||
        (ceiling && current[key] > ceiling[key])
      )
        fail(
          "LIFECYCLE_CONTINUATION_BUDGET",
          "Lifecycle continuation cannot reset or exceed its original remaining Run budget",
        );
    }
    return { ...current };
  };
  const read = (run: Run, boundary: VerificationBoundary): Graph | null => {
    const controller: VerificationControllerSnapshot | null =
        ports.controller.get(run.sessionId, run.id),
      snapshot: VerificationSnapshot | null = ports.plans.get(
        run.sessionId,
        run.id,
      );
    if (
      !controller ||
      !snapshot ||
      !controller.completion ||
      controller.result.id !== boundary.id ||
      controller.result.phase !== "stop" ||
      controller.result.turnId !== boundary.turnId ||
      controller.result.action !== "stop" ||
      controller.result.status !== "verified" ||
      controller.result.taskVerified !== true ||
      controller.completion.boundaryId !== boundary.id ||
      controller.completion.verificationRevision !== snapshot.revision
    )
      return null;
    ports.plans.assertCurrent(snapshot);
    const source = normalizeVerificationSource(controller.completion.source),
      profile = normalizeVerificationControllerProfile(
        ports.readCurrentProfile(run),
      );
    if (
      verificationHash(profile) !==
      verificationHash(controller.completion.profile)
    )
      return null;
    const decision = evaluateVerificationCompletion({
      sessionId: run.sessionId,
      runId: run.id,
      workspaceId: run.workspaceId,
      runConfigSha256: verificationHash(run.config),
      source,
      snapshot,
      profile,
      boundary,
      planCurrent: true,
    });
    if (
      !decision.taskVerified ||
      decision.status !== "verified" ||
      decision.decisionSha256 !==
        controller.completion.decision.decisionSha256 ||
      controller.result.decisionSha256 !== decision.decisionSha256
    )
      return null;
    if (
      boundary.phase !== "stop" ||
      !boundary.turnId ||
      !boundary.providerTerminal ||
      !boundary.nativeTurnCompleted
    )
      return null;
    const turn = ports.store.getTurn(boundary.turnId),
      attempt = ports.store.getLatestAttemptForTurn(turn.id);
    if (
      turn.sessionId !== run.sessionId ||
      turn.runId !== run.id ||
      turn.state !== "completed" ||
      turn.finishReason !== "stop" ||
      !attempt ||
      attempt.turnId !== turn.id ||
      attempt.sessionId !== run.sessionId ||
      attempt.runId !== run.id ||
      attempt.state !== "completed" ||
      attempt.providerId !== run.config.providerId ||
      attempt.modelId !== run.config.modelId
    )
      return null;
    const cleanup = ports.store.getAttemptCleanup(attempt.id, run.sessionId);
    if (
      cleanup.runId !== run.id ||
      cleanup.turnId !== turn.id ||
      cleanup.attemptId !== attempt.id ||
      cleanup.state !== "confirmed" ||
      cleanup.cleanupConfirmed !== true ||
      cleanup.requestProjection !== "engine-turn-request-v1"
    )
      return null;
    const checkpoints = ports.store.listCheckpoints(run.id);
    if (checkpoints.length > run.config.limits.maxToolCalls)
      fail(
        "LIFECYCLE_CONTINUATION_EVIDENCE_LIMIT",
        "Continuation checkpoint evidence exceeded its original Run bound",
      );
    for (const required of decision.requiredChecks) {
      const receipt = snapshot.receipts.find(
        (item) => item.id === required.receiptId,
      );
      if (
        !receipt ||
        receipt.status !== "pass" ||
        receipt.phase !== "settled" ||
        !receipt.observation?.executionCheckpointId
      )
        return null;
      const tool = ports.store.getToolCall(receipt.toolCallId);
      if (
        tool.runId !== run.id ||
        tool.sessionId !== run.sessionId ||
        tool.name !== "verify_changes" ||
        tool.state !== "completed" ||
        !checkpoints.some(
          (item) =>
            item.id === receipt.observation!.executionCheckpointId &&
            item.runId === run.id &&
            item.toolCallId === tool.id &&
            item.kind === "command" &&
            item.incomplete !== true,
        )
      )
        return null;
    }
    return {
      boundary,
      controllerRevision: controller.revision,
      verificationSha256: controller.stateSha256,
      verificationRevision: snapshot.revision,
      snapshotSha256: verificationHash(snapshot),
      source,
      profile,
      runConfigSha256: verificationHash(run.config),
      turnSha256: verificationHash(turn),
      attemptId: attempt.id,
      attemptSha256: verificationHash(attempt),
      cleanupSha256: verificationHash(cleanup),
    };
  };
  const current = async (
    input: Run,
    boundaryValue: VerificationBoundary,
    signal: AbortSignal,
    assertBoundary: boolean,
  ): Promise<{ run: Run; graph: Graph } | null> => {
    const boundary = freezeLifecycle(
        normalizeVerificationBoundary(boundaryValue),
      ),
      run = owner(input, signal);
    if (assertBoundary) ports.assertBoundaryCurrent(run, boundary);
    const first = read(run, boundary);
    if (!first) return null;
    const source = normalizeVerificationSource(
      await ports.observeSource(run, signal),
    );
    const refreshed = owner(input, signal);
    if (assertBoundary) ports.assertBoundaryCurrent(refreshed, boundary);
    const second = read(refreshed, boundary);
    if (
      !second ||
      verificationHash(first) !== verificationHash(second) ||
      verificationHash(source) !== verificationHash(second.source)
    )
      fail(
        "LIFECYCLE_CONTINUATION_STALE",
        "Native verification graph or physical source changed during continuation observation",
      );
    return { run: refreshed, graph: second };
  };
  return Object.freeze({
    async capture(run, boundary, signal) {
      const observed = await current(run, boundary, signal, true);
      return observed
        ? Object.freeze({
            verificationSha256: observed.graph.verificationSha256,
          })
        : null;
    },
    async admit(input, boundary, requestValue, signal) {
      const request = boundedLifecycleJson(
        requestValue,
        8192,
      ) as unknown as LifecycleContinuationRequest;
      verificationPlain(request, ["verificationSha256", "data", "sha256"]);
      if (
        Object.keys(request).length !== 3 ||
        typeof request.verificationSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(request.verificationSha256) ||
        !request.data ||
        Array.isArray(request.data) ||
        typeof request.data !== "object" ||
        request.sha256 !== verificationHash(request.data)
      )
        fail(
          "INVALID_LIFECYCLE_CONTINUATION",
          "Continuation requires exact bounded detached data and request digest",
        );
      const first = await current(input, boundary, signal, true);
      if (
        !first ||
        first.graph.verificationSha256 !== request.verificationSha256
      )
        fail(
          "LIFECYCLE_CONTINUATION_STALE",
          "Continuation requires the current native verified completion graph",
        );
      const originalBudget = budget(first.run),
        kind = lifecycleContinuationDocumentKind(first.run.id);
      if (ports.store.getSessionDocument(first.run.sessionId, kind))
        fail(
          "LIFECYCLE_CONTINUATION_LIMIT",
          "Only one durable lifecycle continuation is admitted for the original Run",
        );
      const content =
        "[Moodcode lifecycle continuation v1]\n" +
        JSON.stringify({
          schemaVersion: 1,
          authority: "control-data",
          verificationSha256: request.verificationSha256,
          data: request.data,
        });
      if (Buffer.byteLength(content) > 8192)
        fail(
          "LIFECYCLE_CONTINUATION_LIMIT",
          "Lifecycle continuation control data exceeds its message bound",
        );
      const message = freezeLifecycle({ role: "user" as const, content }),
        id = "lifecycle_continuation_" + randomUUID().replaceAll("-", "");
      const run = owner(input, signal);
      ports.assertBoundaryCurrent(run, first.graph.boundary);
      const latest = read(run, first.graph.boundary);
      if (!latest || verificationHash(latest) !== verificationHash(first.graph))
        fail(
          "LIFECYCLE_CONTINUATION_STALE",
          "Verification graph changed before continuation admission",
        );
      budget(run, originalBudget);
      check(signal);
      const data = {
        schemaVersion: 1,
        id,
        sessionId: run.sessionId,
        runId: run.id,
        workspaceId: run.workspaceId,
        verificationSha256: request.verificationSha256,
        graphSha256: verificationHash(latest),
        messageSha256: verificationHash(message),
        dataSha256: request.sha256,
        originalBudget,
        executionAuthority: "none",
        continuationsUsed: 1,
      } as unknown as JsonObject;
      const document = ports.store.putActiveLifecycleContinuationDocument(
        run.id,
        kind,
        0,
        data,
        {
          controllerRevision: latest.controllerRevision,
          verificationRevision: latest.verificationRevision,
          controllerSha256: latest.verificationSha256,
        },
      );
      // A successful native commit remains consumed even if cancellation arrives afterwards.
      const capture = freezeLifecycle({
        id,
        message,
        verificationSha256: request.verificationSha256,
      });
      handles.set(capture, {
        runId: run.id,
        sessionId: run.sessionId,
        workspaceId: run.workspaceId,
        graph: latest,
        documentRevision: document.revision,
        documentSha256: verificationHash(document.data),
        messageSha256: verificationHash(message),
        originalBudget,
      });
      return capture;
    },
    async assertFresh(input, capture, signal) {
      const bound = handles.get(capture);
      if (!bound)
        fail(
          "INVALID_LIFECYCLE_CONTINUATION_CAPTURE",
          "Continuation freshness requires its original instance-owned capture",
        );
      const run = owner(input, signal);
      if (
        run.id !== bound.runId ||
        run.sessionId !== bound.sessionId ||
        run.workspaceId !== bound.workspaceId ||
        capture.verificationSha256 !== bound.graph.verificationSha256 ||
        verificationHash(capture.message) !== bound.messageSha256
      )
        fail(
          "LIFECYCLE_CONTINUATION_STALE",
          "Continuation capture or owning Run changed",
        );
      const firstBudget = budget(run, bound.originalBudget, true),
        observed = await current(run, bound.graph.boundary, signal, false);
      if (
        !observed ||
        verificationHash(observed.graph) !== verificationHash(bound.graph)
      )
        fail(
          "LIFECYCLE_CONTINUATION_STALE",
          "Continuation original verification graph changed before dispatch",
        );
      const document = ports.store.getSessionDocument(
        run.sessionId,
        lifecycleContinuationDocumentKind(run.id),
      );
      if (
        !document ||
        document.revision !== bound.documentRevision ||
        verificationHash(document.data) !== bound.documentSha256
      )
        fail(
          "LIFECYCLE_CONTINUATION_STALE",
          "Durable continuation consumption changed",
        );
      budget(observed.run, firstBudget, true);
      check(signal);
    },
  });
}
