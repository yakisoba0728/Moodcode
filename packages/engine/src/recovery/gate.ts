import { EngineError } from '@moodcode/contracts';
import { assertExecutionLockAvailable } from '../tools/command/execution-lock.js';

export type RecoveryProducer = 'summaries' | 'execution' | 'knowledgeGeneration' | 'knowledgeFilePublication';

/** Producers that must be certain before each recovery resumes or activates, in check order. The subsets differ on purpose. */
export const RECOVERY_PRECEDENCE = Object.freeze({
  knowledgeFileResume: { blockers: ['summaries', 'execution', 'knowledgeGeneration'], message: 'Other workspace producers still require independent recovery' },
  proposalApplyResume: { blockers: ['execution', 'summaries', 'knowledgeGeneration', 'knowledgeFilePublication'], message: 'Other native producers require their own recovery before proposal resume' },
  knowledgeImportActivation: { blockers: ['summaries', 'execution'], message: 'Independent coding or summary producers require their own recovery approval' },
  knowledgeImportSuccessors: { blockers: ['knowledgeGeneration', 'knowledgeFilePublication'], message: 'Successor knowledge producers require independent recovery before activation' },
  knowledgeGenerationResume: { blockers: ['summaries', 'execution'], message: 'Other workspace producers still require independent recovery' },
} as const satisfies Record<string, { blockers: readonly RecoveryProducer[]; message: string }>);
export type RecoveryPrecedence = keyof typeof RECOVERY_PRECEDENCE;

export interface RecoveryGatePorts {
  store: {
    hasUncertainSummaries(workspaceId: string): boolean; hasUncertainExecution(workspaceId: string): boolean;
    hasUncertainKnowledgeGeneration(workspaceId: string): boolean; hasUncertainKnowledgeFilePublication(workspaceId: string): boolean;
  };
  executionLockPath: string;
  /** The engine is closing. */
  closed: AbortSignal;
  lease<T>(workspaceId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  hold(workspaceId: string): void;
}
export interface RecoveryDecision {
  /** ENGINE_CLOSED message when the engine closes too; otherwise an aborted lease throws its reason. */
  closed?: string;
  idle?: boolean;
  hold?: boolean;
}

/** Cross-producer recovery precedence and the shared decision protocol. */
export class RecoveryGate {
  constructor(private readonly ports: RecoveryGatePorts) {}

  assertIdle(): void {
    try {
      assertExecutionLockAvailable(this.ports.executionLockPath);
    } catch (error) {
      if (error instanceof EngineError && error.code === 'COMMAND_EFFECTS_BUSY') {
        throw new EngineError('CLEANUP_PENDING', 'A command supervisor is still cleaning up a previous engine execution; reopen after cleanup');
      }
      throw error;
    }
  }

  assertCertain(precedence: RecoveryPrecedence, workspaceId: string): void {
    const { blockers, message } = RECOVERY_PRECEDENCE[precedence], store = this.ports.store;
    const uncertain = { summaries: () => store.hasUncertainSummaries(workspaceId), execution: () => store.hasUncertainExecution(workspaceId),
      knowledgeGeneration: () => store.hasUncertainKnowledgeGeneration(workspaceId), knowledgeFilePublication: () => store.hasUncertainKnowledgeFilePublication(workspaceId) };
    if (blockers.some(producer => uncertain[producer]())) throw new EngineError('CLEANUP_PENDING', message);
  }

  assertOpen(signal: AbortSignal, closed?: string): void {
    if (closed !== undefined) { if (signal.aborted || this.ports.closed.aborted) throw new EngineError('ENGINE_CLOSED', closed); }
    else if (signal.aborted) throw signal.reason;
  }

  lease<T>(workspaceId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> { return this.ports.lease(workspaceId, operation); }

  /** Takes the recovery lease, refuses a cancelled decision, optionally checks idle, decides, then optionally holds the workspace. */
  decide<T>(workspaceId: string, decision: RecoveryDecision, operation: (signal: AbortSignal) => T): Promise<T> {
    return this.ports.lease(workspaceId, async signal => {
      this.assertOpen(signal, decision.closed);
      if (decision.idle) this.assertIdle();
      const result = operation(signal);
      if (decision.hold) this.ports.hold(workspaceId);
      return result;
    });
  }
}
