import { EngineError, type Run, type Workspace } from '@moodcode/contracts';
import type { CoordinatorOptions, ToolDefinition } from './ports.js';
import type { SqliteStore } from './storage/index.js';
import type { EngineRuntime } from './engine-runtime.js';
import type { EngineLifetime } from './engine-kernel.js';
import type { ArtifactStore } from './artifacts/store.js';
import type { AgentProfiles } from './agents/index.js';
import { profilePin } from './agents/index.js';
import type { RepositoryContextService } from './repository/index.js';
import type { EngineExecutionObserver } from './diagnostics/execution-observer.js';
import type { ToolRegistrationCapture } from './tools/runtime/index.js';
import { commandBackendCapability } from './tools/command/backends.js';
import { createLifecycleContinuationPort } from './lifecycle/continuation.js';
import { VerificationController, verificationContinuationMessage, type VerificationControllerInput } from './verification/controller.js';
import { VerificationCheckRegistry, VerificationPlanService, VerificationReceiptService, type VerificationCheckRegistration } from './verification/index.js';
import { VerificationHostService, type VerificationSessionPolicy } from './verification/host.js';
import { createVerificationTool } from './verification/tool.js';

type VerificationHooks = Pick<CoordinatorOptions, 'lifecycleContinuation' | 'verificationStop' | 'verificationBeforeProvider'>;

/** Host verification checks, plans, receipts and the controller that decides verification continuations. */
export class EngineVerification {
  readonly checks = new VerificationCheckRegistry();
  readonly plans: VerificationPlanService;
  readonly receipts: VerificationReceiptService;
  readonly host: VerificationHostService;
  readonly controller: VerificationController;

  constructor(private readonly store: SqliteStore, repository: RepositoryContextService, private readonly profiles: AgentProfiles,
    private readonly engine: Pick<EngineRuntime, 'coordinator' | 'toolRuntime'>, allowedTools: (profileTools: readonly string[] | undefined) => readonly string[] | undefined,
    private readonly lifetime: EngineLifetime, private readonly enabled: boolean) {
    this.plans = new VerificationPlanService(store, this.checks);
    this.receipts = new VerificationReceiptService(this.plans);
    this.host = new VerificationHostService(store, this.plans, repository);
    this.controller = new VerificationController(store, this.plans, {
      observeSource: (run, signal) => this.observe(run, signal),
      readCurrentProfile: run => this.profile(run),
      readRemainingBudget: run => engine.coordinator.verificationRemainingBudget(run),
      readExecutionBlocker: run => {
        if (store.hasDeniedVerificationTool(run.id)) return 'verification_denied';
        const profile = profiles.forRun(run.sessionId, run.config);
        const catalogue = engine.toolRuntime.catalogue('engine', run.config.mode, allowedTools(profile?.tools), profilePin(profile) ?? undefined);
        if (!catalogue.tools.some(tool => tool.name === 'verify_changes') || !catalogue.tools.some(tool => tool.name === 'run_command')) return 'verification_denied';
        const checks = this.plans.get(run.sessionId, run.id)?.plans.at(-1)?.checks ?? [];
        if (!checks.length) for (const id of this.host.configuration(run.sessionId)?.checkIds ?? []) {
          try { this.checks.capture(id); }
          catch (error) { if (error instanceof EngineError && error.code === 'VERIFICATION_CHECK_NOT_FOUND') return 'check_stale'; throw error; }
        }
        if (checks.some(check => engine.toolRuntime.policy.evaluate({ toolName: 'run_command', effect: 'execute', mode: run.config.mode, requiresApproval: true, resources: [`command:${check.command}`, `path:${check.cwd}`] }).decision === 'deny')) return 'verification_denied';
        return null;
      },
      assertBoundaryCurrent: (run, boundary) => engine.coordinator.assertVerificationBoundaryCurrent(run, boundary),
      commitCurrent: (runId, kind, revision, data, verificationRevision) => store.putActiveVerificationControllerDocument(runId, kind, revision, data, verificationRevision),
    });
  }

  private profile(run: Run) { return this.profiles.pinForRun(run.sessionId, run.config); }

  private observe(run: Run, signal: AbortSignal, workspace: Workspace = this.store.getWorkspace(run.workspaceId)) {
    return this.host.observe({ sessionId: run.sessionId, runId: run.id, workspace }, signal);
  }

  private evaluate(run: Run, boundary: VerificationControllerInput['boundary'], source: VerificationControllerInput['source'], signal: AbortSignal) {
    const verification = this.plans.get(run.sessionId, run.id);
    return this.controller.evaluate(run.sessionId, run.id, this.controller.get(run.sessionId, run.id)?.revision ?? 0,
      { boundary, source, verificationRevision: verification?.revision ?? 0, planSha256: verification?.plans.at(-1)?.planSha256 ?? null }, signal);
  }

  /** The verify_changes tool, bound to the engine-owned run_command registration captured after catalogue registration. */
  tool(observer: () => EngineExecutionObserver | undefined, artifacts: () => Promise<ArtifactStore>, commandRegistration: () => ToolRegistrationCapture | undefined): ToolDefinition {
    return createVerificationTool({ plans: this.plans, receipts: this.receipts, getRun: id => this.store.getRun(id), ensurePlan: (context, signal) => this.host.ensurePlan(context, signal), sourceObservation: (context, signal) => this.host.observe(context, AbortSignal.any([signal, this.lifetime.signal])), commandRuntime: this.engine.toolRuntime, captureCatalogue: context => this.engine.coordinator.captureToolCatalogue(context),
      executeCommand: (outer,nested,prepared) => this.engine.coordinator.withVerificationCommandContext(outer,nested,()=>{ const execute = () => this.engine.toolRuntime.execute(prepared,nested), executionObserver = observer(); return executionObserver ? executionObserver.nested(outer,prepared,execute) : execute(); }),
      consumedSettlementWriter: (context, kind, revision, data) => this.engine.coordinator.commitConsumedVerificationSettlement(context, kind, revision, data),
      commandCapability: (_context, catalogue) => {
        const registration = commandRegistration();
        if (!registration) throw new EngineError('TOOL_PRODUCER_MISMATCH', 'The original engine command producer is unavailable');
        this.engine.toolRuntime.assertRegistrationCurrent(catalogue, registration);
        return Object.freeze({ producer: 'engine-owned-run-command' as const, platform: process.platform, supported: commandBackendCapability().available, catalogueRevision: catalogue.revision });
      }, artifacts });
  }

  /** Coordinator hooks for the optional lifecycle continuation and, when verification is enabled, its stop and dispatch boundaries. */
  coordinatorHooks(lifecycleContinuation: boolean): VerificationHooks {
    return {
      ...(lifecycleContinuation
        ? {
            lifecycleContinuation: createLifecycleContinuationPort({
              store: this.store,
              controller: this.controller,
              plans: this.plans,
              observeSource: (run, signal) => this.observe(run, signal),
              readCurrentProfile: run => this.profile(run),
              assertBoundaryCurrent: (run, boundary) =>
                this.engine.coordinator.assertVerificationBoundaryCurrent(
                  run,
                  boundary,
                ),
              readRemainingBudget: (run) =>
                this.engine.coordinator.verificationRemainingBudget(run),
            }),
          }
        : {}),
      ...(this.enabled
        ? {
            verificationStop: async (run, boundary, signal) => {
              if (!this.host.configuration(run.sessionId))
                return null;
              const workspace = this.store.getWorkspace(run.workspaceId);
              if (!this.plans.get(run.sessionId, run.id)) {
                try {
                  await this.host.ensurePlan(
                    { sessionId: run.sessionId, runId: run.id, workspace },
                    signal,
                  );
                } catch (error) {
                  if (
                    !(error instanceof EngineError) ||
                    error.code !== "VERIFICATION_CHECK_NOT_FOUND"
                  )
                    throw error;
                }
              }
              const source = await this.observe(run, signal, workspace);
              const result = await this.evaluate(
                run,
                boundary,
                source,
                signal,
              );
              const content = verificationContinuationMessage(result);
              return content && result.result.stageId
                ? {
                    stageId: result.result.stageId,
                    message: {
                      role: "user" as const,
                      content: `[Moodcode verification control v1]\n${content}`,
                    },
                  }
                : null;
            },
            verificationBeforeProvider: async (run, boundary, signal) => {
              const source = await this.observe(run, signal);
              const result = await this.evaluate(
                run,
                boundary,
                source,
                signal,
              );
              if (result.result.action === "stop")
                throw new EngineError(
                  "VERIFICATION_CONTINUATION_BLOCKED",
                  `Verification continuation stopped (${result.result.reason})`,
                );
            },
          }
        : {}),
    };
  }

  register(check: VerificationCheckRegistration): () => void {
    this.lifetime.assertEnabled(this.enabled, 'VERIFICATION_UNSUPPORTED', 'Verification tools require explicit host opt-in');
    this.store.getWorkspace(check.workspaceId);
    return this.checks.register(check);
  }

  configure(sessionId: string, expectedRevision: number, policy: VerificationSessionPolicy) {
    if (this.lifetime.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    if (!this.enabled) return Promise.reject(new EngineError('VERIFICATION_UNSUPPORTED', 'Verification tools require explicit host opt-in'));
    const session = this.store.getSession(sessionId);
    return this.engine.coordinator.withWorkspaceLease(session.workspaceId, signal => this.host.configure(sessionId, expectedRevision, policy, signal));
  }
}
