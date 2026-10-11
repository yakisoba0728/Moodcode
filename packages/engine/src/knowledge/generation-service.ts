import { randomUUID } from 'node:crypto';
import { EngineError, type ReasoningEffort } from '@moodcode/contracts';
import {
  validateHostGenerationRequest,
  type HostGenerationProviderPort,
} from '../provider/generation.js';
import type {
  KnowledgeHostAdapter,
  KnowledgeSourceProjection,
} from './host.js';
import type { KnowledgeStorage } from './store.js';
import type { KnowledgeCandidate, KnowledgeGenerationPlan } from './types.js';
import {
  canonicalKnowledge,
  identifier,
  knowledgeHostRecord,
  sameKnowledge,
  sha256,
} from './validation.js';
import { normalizeKnowledgeGenerationBudget } from './generation-budget.js';
import { buildKnowledgeGenerationRequest } from './generation-request.js';
import { streamKnowledgeGeneration } from './generation-stream.js';
import type {
  CreateKnowledgeGeneration,
  CreateKnowledgeGenerationResult,
  KnowledgeGenerationAttempt,
  KnowledgeGenerationAttemptCapture,
  KnowledgeGenerationBudget,
  KnowledgeGenerationCapture,
  KnowledgeGenerationObservation,
  KnowledgeGenerationRecord,
  KnowledgeGenerationSettlement,
} from './generation-types.js';

/** Structural port over the actual primary store; data returned by a provider never implements this owner. */
export interface KnowledgeGenerationNativePort {
  hasBlocker(workspaceId: string): boolean;
  findRequest(
    input: CreateKnowledgeGeneration,
  ): KnowledgeGenerationRecord | undefined;
  create(input: CreateKnowledgeGeneration): CreateKnowledgeGenerationResult;
  prepareAttempt(
    capture: KnowledgeGenerationCapture,
    input: { id: string; sha256: string; bytes: number },
  ): {
    capture: KnowledgeGenerationAttemptCapture;
    record: KnowledgeGenerationAttempt;
  };
  dispatch(
    capture: KnowledgeGenerationCapture,
    attempt: KnowledgeGenerationAttemptCapture,
  ): unknown;
  observe(
    capture: KnowledgeGenerationCapture,
    attempt: KnowledgeGenerationAttemptCapture,
    observation: KnowledgeGenerationObservation,
  ): unknown;
  settle(
    capture: KnowledgeGenerationCapture,
    attempt: KnowledgeGenerationAttemptCapture,
    settlement: KnowledgeGenerationSettlement,
  ): unknown;
  failPrepared(capture: KnowledgeGenerationCapture, errorCode: string): unknown;
  getGeneration(
    workspaceId: string,
    generationId: string,
  ): KnowledgeGenerationRecord;
  getAttempt(
    workspaceId: string,
    attemptId: string,
  ): KnowledgeGenerationAttempt;
  markCandidate(
    workspaceId: string,
    generationId: string,
    value:
      | { state: 'recorded'; candidateId: string }
      | { state: 'withheld'; reason: string },
  ): unknown;
  release(capture: KnowledgeGenerationCapture): void;
  releaseAttempt(capture: KnowledgeGenerationAttemptCapture): void;
}
export interface WorkspaceKnowledgeGenerationInput {
  readonly workspaceId: string;
  readonly planId: string;
  readonly requestId: string;
  readonly projection: KnowledgeSourceProjection;
  readonly budget?: Partial<KnowledgeGenerationBudget>;
  readonly reasoningEffort?: ReasoningEffort;
  readonly signal?: AbortSignal;
}
export interface WorkspaceKnowledgeGenerationResult {
  readonly generation: KnowledgeGenerationRecord;
  readonly attempt: KnowledgeGenerationAttempt | null;
  readonly candidate: KnowledgeCandidate | null;
  readonly duplicate: boolean;
  readonly cleanupConfirmed: boolean;
  readonly executionBlocked: boolean;
}
export interface KnowledgeGenerationServicePorts {
  readonly native: KnowledgeGenerationNativePort;
  readonly knowledge: KnowledgeStorage;
  readonly host: KnowledgeHostAdapter;
  readonly provider: (providerId: string) => HostGenerationProviderPort;
  readonly assertPlanCurrent: (plan: KnowledgeGenerationPlan) => void;
  readonly withLease: <T>(
    workspaceId: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
}
const MAX_LIVE_GENERATIONS = 32;
export function assertKnowledgeGenerationHostInput(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  knowledgeHostRecord(
    value,
    required,
    optional,
    'INVALID_KNOWLEDGE_GENERATION',
    'Generation host input must be plain data',
    'Generation host input has unsupported fields',
  );
}
function errorCode(error: unknown): string {
  return error instanceof EngineError
    ? error.code
    : 'KNOWLEDGE_CANDIDATE_UNAVAILABLE';
}

/** Host extraction remains pending knowledge, under one actual workspace reservation and original native deadline. */
export class KnowledgeGenerationService {
  readonly #ports: KnowledgeGenerationServicePorts;
  readonly #live = new Map<
    string,
    { workspaceId: string; abort: AbortController }
  >();
  #reserved = 0;
  constructor(ports: KnowledgeGenerationServicePorts) {
    this.#ports = Object.freeze({ ...ports });
  }
  get(
    workspaceId: string,
    generationId: string,
    duplicate = false,
  ): WorkspaceKnowledgeGenerationResult {
    const generation = this.#ports.native.getGeneration(
      workspaceId,
      generationId,
    );
    const attempt = generation.attemptId
      ? this.#ports.native.getAttempt(workspaceId, generation.attemptId)
      : null;
    if (
      attempt &&
      (attempt.generationId !== generation.id ||
        attempt.planId !== generation.planId ||
        attempt.runtimeEpoch !== generation.runtimeEpoch ||
        attempt.state !== generation.state)
    )
      throw new EngineError(
        'KNOWLEDGE_RECORD_CONFLICT',
        'Attempt does not belong to the exact native generation state',
      );
    const candidate =
      generation.candidate.state === 'recorded'
        ? (this.#ports.knowledge.getCandidate(
            workspaceId,
            generation.candidate.candidateId,
          ) ?? null)
        : null;
    if (generation.candidate.state === 'recorded' && !candidate)
      throw new EngineError(
        'KNOWLEDGE_RECORD_CONFLICT',
        'Native generation refers to a missing candidate',
      );
    if (
      candidate &&
      (!attempt ||
        candidate.generationOwnerId !== generation.id ||
        candidate.planId !== generation.planId ||
        candidate.bodySha256 !== attempt.outputSha256 ||
        candidate.requestSha256 !== generation.logicalRequestSha256 ||
        !sameKnowledge(candidate.binding, generation.binding))
    )
      throw new EngineError(
        'KNOWLEDGE_RECORD_CONFLICT',
        'Candidate does not belong to the exact native output and host binding',
      );
    return {
      generation,
      attempt,
      candidate,
      duplicate,
      cleanupConfirmed:
        attempt?.cleanup?.confirmed ?? generation.state === 'cancelled',
      executionBlocked: this.#ports.native.hasBlocker(workspaceId),
    };
  }
  generate(
    input: WorkspaceKnowledgeGenerationInput,
  ): Promise<WorkspaceKnowledgeGenerationResult> {
    try {
      assertKnowledgeGenerationHostInput(
        input,
        ['workspaceId', 'planId', 'requestId', 'projection'],
        ['budget', 'reasoningEffort', 'signal'],
      );
      const {
        workspaceId,
        planId,
        requestId,
        projection: originalProjection,
        reasoningEffort,
        signal: callerSignal,
      } = input;
      identifier(workspaceId);
      identifier(planId);
      identifier(requestId);
      if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal))
        throw new EngineError(
          'INVALID_KNOWLEDGE_GENERATION',
          'Generation cancellation requires an actual AbortSignal',
        );
      const plan = this.#ports.knowledge.getGenerationPlan(workspaceId, planId);
      if (!plan)
        throw new EngineError(
          'KNOWLEDGE_NOT_FOUND',
          'Generation plan does not exist in this workspace',
        );
      const built = buildKnowledgeGenerationRequest({
        providerId: plan.providerId,
        modelId: plan.modelId,
        source: originalProjection,
        ...(reasoningEffort === undefined
          ? {}
          : { reasoningEffort: reasoningEffort }),
      });
      if (
        originalProjection.workspaceId !== workspaceId ||
        !sameKnowledge(originalProjection.binding, plan.binding) ||
        !sameKnowledge(originalProjection.manifest, plan.source) ||
        built.requestSha256 !== plan.requestSha256 ||
        built.requestBytes !== plan.requestBytes
      )
        throw new EngineError(
          'KNOWLEDGE_GENERATION_REQUEST_CHANGED',
          'Actual tools-free request differs from its exact pending plan',
        );
      const normalized = normalizeKnowledgeGenerationBudget(input.budget),
        budget = normalizeKnowledgeGenerationBudget({
          ...normalized,
          maxOutputBytes: Math.min(
            normalized.maxOutputBytes,
            plan.maxOutputBytes,
          ),
        });
      const request: CreateKnowledgeGeneration = {
        workspaceId: workspaceId,
        planId: plan.id,
        requestId: requestId,
        budget,
        logicalRequestSha256: built.requestSha256,
        logicalRequestBytes: built.requestBytes,
      };
      const duplicate = this.#ports.native.findRequest(request);
      if (duplicate)
        return Promise.resolve(this.get(workspaceId, duplicate.id, true));
      const provider = this.#ports.provider(plan.providerId);
      // Validate complete owned-envelope size before any native generation is admitted.
      validateHostGenerationRequest({
        ...built.payload,
        owner: {
          kind: 'host-generation',
          workspaceId: workspaceId,
          generationId: '00000000-0000-0000-0000-000000000000',
          attemptId: '00000000-0000-0000-0000-000000000000',
        },
      });
      if (this.#reserved >= MAX_LIVE_GENERATIONS)
        throw new EngineError(
          'KNOWLEDGE_GENERATION_LIMIT',
          'Too many live host generations',
        );
      this.#reserved++;
      try {
        return this.#ports
          .withLease(workspaceId, async (leaseSignal) => {
            const signalBeforeOwner = callerSignal
              ? AbortSignal.any([leaseSignal, callerSignal])
              : leaseSignal;
            if (signalBeforeOwner.aborted)
              throw new EngineError(
                'KNOWLEDGE_GENERATION_CANCELLED',
                'Generation was cancelled before native admission',
              );
            this.#ports.host.assertProjectionFresh(originalProjection);
            this.#ports.assertPlanCurrent(plan);
            const admission = this.#ports.native.create(request);
            if (admission.kind === 'duplicate')
              return this.get(workspaceId, admission.record.id, true);
            const owner = admission.capture,
              abort = new AbortController();
            const signal = AbortSignal.any([signalBeforeOwner, abort.signal]);
            this.#live.set(admission.record.id, {
              workspaceId: workspaceId,
              abort,
            });
            let attempt: KnowledgeGenerationAttemptCapture | undefined;
            try {
              const attemptId = randomUUID(),
                dispatch = validateHostGenerationRequest({
                  ...built.payload,
                  owner: {
                    kind: 'host-generation',
                    workspaceId: workspaceId,
                    generationId: admission.record.id,
                    attemptId,
                  },
                });
              const encoded = canonicalKnowledge(dispatch);
              attempt = this.#ports.native.prepareAttempt(owner, {
                id: attemptId,
                sha256: sha256(encoded),
                bytes: Buffer.byteLength(encoded),
              }).capture;
              const actualAttempt = attempt;
              await streamKnowledgeGeneration({
                provider,
                request: dispatch,
                signal,
                budget: admission.record.budget,
                deadline: admission.record.deadline,
                onDispatch: () => {
                  this.#ports.host.assertProjectionFresh(originalProjection);
                  this.#ports.assertPlanCurrent(plan);
                  this.#ports.native.dispatch(owner, actualAttempt);
                },
                onObservation: (observation) => {
                  this.#ports.native.observe(owner, actualAttempt, observation);
                },
                onSettlement: (settlement) => {
                  this.#ports.native.settle(owner, actualAttempt, settlement);
                },
              });
              const result = this.get(workspaceId, admission.record.id);
              if (result.generation.state === 'completed') {
                if (signal.aborted)
                  this.#ports.native.markCandidate(
                    workspaceId,
                    admission.record.id,
                    {
                      state: 'withheld',
                      reason: 'KNOWLEDGE_GENERATION_CANCELLED',
                    },
                  );
                else if (Date.now() >= admission.record.deadline)
                  this.#ports.native.markCandidate(
                    workspaceId,
                    admission.record.id,
                    {
                      state: 'withheld',
                      reason: 'KNOWLEDGE_GENERATION_DEADLINE',
                    },
                  );
                else
                  this.recordCandidate(
                    workspaceId,
                    admission.record.id,
                    'generation_candidate_' + admission.record.id,
                  );
              }
              return this.get(workspaceId, admission.record.id);
            } catch (error) {
              const current = this.#ports.native.getGeneration(
                workspaceId,
                admission.record.id,
              );
              if (current.state === 'prepared')
                this.#ports.native.failPrepared(owner, errorCode(error));
              throw error;
            } finally {
              this.#live.delete(admission.record.id);
              if (attempt) this.#ports.native.releaseAttempt(attempt);
              this.#ports.native.release(owner);
            }
          })
          .finally(() => {
            this.#reserved--;
          });
      } catch (error) {
        this.#reserved--;
        throw error;
      }
    } catch (error) {
      return Promise.reject(error);
    }
  }
  private recordCandidate(
    workspaceId: string,
    generationId: string,
    requestId: string,
  ): void {
    const record = this.#ports.native.getGeneration(workspaceId, generationId);
    if (record.state !== 'completed')
      throw new EngineError(
        'KNOWLEDGE_GENERATION_INCOMPLETE',
        'Only confirmed native output can become a candidate',
      );
    if (record.candidate.state === 'recorded') return;
    try {
      const existing = this.#ports.knowledge.getCandidateByGeneration(
        workspaceId,
        generationId,
      );
      if (existing) {
        const attempt = record.attemptId
          ? this.#ports.native.getAttempt(workspaceId, record.attemptId)
          : null;
        if (
          !attempt ||
          existing.planId !== record.planId ||
          existing.bodySha256 !== attempt.outputSha256 ||
          existing.requestSha256 !== record.logicalRequestSha256
        )
          throw new EngineError(
            'KNOWLEDGE_RECORD_CONFLICT',
            'Existing candidate does not describe this exact native output',
          );
        this.#ports.native.markCandidate(workspaceId, generationId, {
          state: 'recorded',
          candidateId: existing.id,
        });
        return;
      }
      const handle = this.#ports.knowledge.attachGenerationOwner(
        workspaceId,
        record.planId,
        generationId,
      );
      try {
        const attempt = record.attemptId
          ? this.#ports.native.getAttempt(workspaceId, record.attemptId)
          : null;
        if (!attempt)
          throw new EngineError(
            'KNOWLEDGE_RECORD_CONFLICT',
            'Completed host output has no actual native attempt',
          );
        const candidate = this.#ports.knowledge.appendCandidate(handle, {
          requestId,
          body: attempt.output,
        });
        this.#ports.native.markCandidate(workspaceId, generationId, {
          state: 'recorded',
          candidateId: candidate.id,
        });
      } finally {
        this.#ports.knowledge.releaseGenerationOwner(handle);
      }
    } catch (error) {
      this.#ports.native.markCandidate(workspaceId, generationId, {
        state: 'withheld',
        reason: errorCode(error),
      });
    }
  }
  finish(input: {
    workspaceId: string;
    generationId: string;
    requestId: string;
  }): Promise<WorkspaceKnowledgeGenerationResult> {
    try {
      assertKnowledgeGenerationHostInput(input, [
        'workspaceId',
        'generationId',
        'requestId',
      ]);
      const { workspaceId, generationId, requestId } = input;
      for (const value of [workspaceId, generationId, requestId])
        identifier(value);
      return this.#ports.withLease(workspaceId, async (signal) => {
        if (signal.aborted)
          throw new EngineError(
            'KNOWLEDGE_GENERATION_CANCELLED',
            'Candidate finishing was cancelled',
          );
        this.recordCandidate(workspaceId, generationId, requestId);
        return this.get(workspaceId, generationId);
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }
  cancel(
    workspaceId: string,
    generationId: string,
  ): WorkspaceKnowledgeGenerationResult {
    const record = this.get(workspaceId, generationId),
      live = this.#live.get(generationId);
    if (!live || live.workspaceId !== workspaceId) {
      if (
        ['completed', 'failed', 'cancelled', 'uncertain'].includes(
          record.generation.state,
        )
      )
        return record;
      throw new EngineError(
        'KNOWLEDGE_GENERATION_NOT_OWNED',
        'Generation is not owned by this engine runtime',
      );
    }
    live.abort.abort(
      new EngineError(
        'KNOWLEDGE_GENERATION_CANCELLED',
        'Host cancelled this generation',
      ),
    );
    return this.get(workspaceId, generationId);
  }
}
