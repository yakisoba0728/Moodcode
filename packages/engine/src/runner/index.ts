import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import {
  EngineError, isTerminal,
  type Checkpoint, type JsonObject, type JsonValue, type Message, type ProviderReplay, type ProviderToolCall,
  type Run, type RunReceipt, type RunState, type SubmitInput, type ToolCallRecord,
} from '@moodcode/contracts';
import type {
  CoordinatorOptions, CoordinatorPort, PreparedTool, ProviderAdapter, ProviderEvent,
  ProviderMessage, ToolContext, ToolDefinition, ToolResult,
  ChildRunReservation, RunUsage, LifecycleContinuationCapture,
} from '../ports.js';
import { EXTRACTIVE_MEMORY_PREFIX } from '../context/index.js';
import { SEMANTIC_MEMORY_PREFIX } from '../context/semantic-memory.js';
import { ACTIVE_PREFIX_MEMORY_PREFIX } from '../context/active-prefix.js';
import { BudgetAccount } from '../config/budgets.js';
import { validateToolResultEnvelope } from '@moodcode/contracts/validation';
import { executionRecords, TurnExecutor } from './turn-executor.js';
import { createMcpExecutionObserver, type ApprovedMcpToolOwner } from './mcp-execution-observer.js';
import type { ToolCatalogue } from '../tools/runtime/index.js';
import { DISCOVERY_TOOL_NAME, RunToolDiscovery, type ToolDiscoveryAction } from './tool-discovery.js';
import { bindCheckpointArtifacts } from '../artifacts/result.js';
import type { ChildBudget } from '../child-tasks/index.js';
import type { LifecycleCapture, LifecycleDispatchOutcome, LifecycleInvocation } from '../lifecycle/index.js';
import type { VerificationBoundary } from '../verification/completion.js';
export { InputScheduler, type InputSchedulerOptions } from './input-scheduler.js';

const CLEANUP_GRACE_MS = 1_000;
// Closing the owned generator can join a pending wait, then the adapter's
// separate one-second return deadline and its durable settlement.
const PROVIDER_CLEANUP_GRACE_MS = CLEANUP_GRACE_MS * 3;
const EFFECT_TOOLS = new Set(['apply_patch', 'run_command']);
const READ_TOOLS = new Set(['list_files', 'read_file', 'search_files']);
const UNSAFE_EFFECT_ERRORS = new Set([
  'CLEANUP_UNCERTAIN', 'PROCESS_CLEANUP_FAILED', 'COMMAND_CLEANUP_UNCERTAIN',
  'COMMAND_EFFECTS_LOCK_FAILED', 'PATCH_CHECKPOINT_FAILED',
]);

interface Owner {
  run: Run;
  abort: AbortController;
  done: Promise<Run>;
  outputBytes: number;
  toolCount: number;
  budget: BudgetAccount;
  callIds: Set<string>;
  readonlyCalls: Set<string>;
  checkpointIds: Set<string>;
  checkpoints: Map<string, Checkpoint>;
  terminal: boolean;
  turn?: TurnExecutor;
  catalogue?: ToolCatalogue;
  discovery?: RunToolDiscovery;
  allowedTools?: ReadonlySet<string>;
  invocations: Map<string, string>;
  activeTools: Map<string, ToolCallRecord>;
  readBatchWidth: number;
  deadline: number;
  childReserved: Omit<ChildBudget, 'durationMs'>;
  cleanupError?: EngineError;
  lifecycle?: LifecycleCapture;
  lifecycleStopChecked?: boolean;
  lifecycleContinuation?: LifecycleContinuationCapture;
  lifecycleContinuationsUsed: number;
  verificationContinuation?: { stageId: string; message: ProviderMessage };
  verificationBoundary?: VerificationBoundary;
}

interface WorkspaceLease {
  abort: AbortController;
  done: Promise<void>;
  summaryRecovery: boolean;
  cleanupError?: EngineError;
}

interface Outcome<T> { ok: boolean; value?: T; error?: unknown }

function now(): string { return new Date().toISOString(); }

/** Avoid a trailing replacement character when cutting a UTF-8 string. */
function prefixBytes(content: string, limit: number): string {
  if (limit <= 0) return '';
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length <= limit) return content;
  let end = limit;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function errorOf(error: unknown, code = 'INTERNAL_ERROR', message = 'Run execution failed'): EngineError {
  if (error instanceof EngineError) return error;
  return new EngineError(code, message);
}

/** Validate descriptors before copying native output: no getters, toJSON or proxy traps. */
function copyReplay(items: unknown, providerId: string, maxBytes: number, binding: Pick<ProviderReplay, 'modelId' | 'protocol' | 'version'> = {}): ProviderReplay {
  const invalid = (): never => { throw new EngineError('INVALID_PROVIDER_REPLAY', 'Provider replay must contain plain JSON output objects'); };
  if (typeof providerId !== 'string' || !providerId.trim() || Buffer.byteLength(providerId, 'utf8') > 256 || /[\u0000-\u001f\u007f]/u.test(providerId)) return invalid();
  let remaining = maxBytes - (Buffer.byteLength(JSON.stringify({ providerId, items: [], ...binding }), 'utf8') - 2);
  const spend = (bytes: number): void => {
    if (bytes > remaining) throw new EngineError('CONTEXT_LIMIT', 'Provider replay exceeds the context byte budget');
    remaining -= bytes;
  };
  spend(0);
  const ancestors = new Set<object>();
  const copy = (value: unknown, depth: number): JsonValue => {
    if (value === null) { spend(4); return null; }
    if (typeof value === 'boolean') { spend(value ? 4 : 5); return value; }
    if (typeof value === 'string') {
      // A JS string cannot serialize to fewer bytes than its UTF-16 length.
      if (value.length > remaining) spend(value.length);
      spend(Buffer.byteLength(JSON.stringify(value), 'utf8'));
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) { spend(Buffer.byteLength(JSON.stringify(value))); return value; }
    if (!value || typeof value !== 'object' || depth > 64 || types.isProxy(value) || ancestors.has(value)) return invalid();
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid();
    ancestors.add(value);
    try {
      const keys = Reflect.ownKeys(value);
      if (array) {
        const length = Object.getOwnPropertyDescriptor(value, 'length')?.value as unknown;
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) return invalid();
        spend(2);
        const result: JsonValue[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid();
          if (index) spend(1);
          result.push(copy(descriptor.value, depth + 1));
        }
        return result;
      }
      spend(2);
      const result: JsonObject = {};
      let index = 0;
      for (const key of keys) {
        if (typeof key !== 'string') return invalid();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid();
        if (index++) spend(1);
        if (key.length > remaining) spend(key.length);
        spend(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1);
        Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
      }
      return result;
    } finally { ancestors.delete(value); }
  };
  if (types.isProxy(items) || !Array.isArray(items)) return invalid();
  // Include the providerReplay object level so stored context has the same bound.
  const copied = copy(items, 1);
  if (!Array.isArray(copied) || copied.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) return invalid();
  return { providerId, items: copied as JsonObject[], ...binding };
}

function uncertain(value: unknown): boolean {
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.code === 'string' && UNSAFE_EFFECT_ERRORS.has(record.code)) return true;
    if (record.cleanupConfirmed === false || record.cleanupUncertain === true || record.effectsUncertain === true || record.executionBlocked === true) return true;
    pending.push(record.data, record.details);
  }
  return false;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new EngineError('RUN_CANCELLED', 'Run was cancelled');
}

/** Wait for an aborted operation to settle before claiming that its cleanup finished. */
async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal, label: string, cleanupGraceMs = CLEANUP_GRACE_MS): Promise<T> {
  checkAbort(signal);
  const pending: Promise<Outcome<T>> = Promise.resolve().then(() => { checkAbort(signal); return operation(); }).then(
    (value) => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }),
  );
  let onAbort!: () => void;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  let result: Outcome<T> | null;
  try { result = await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
  if (result !== null && !signal.aborted) {
    if (!result.ok) throw result.error;
    return result.value as T;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = await Promise.race([
    pending,
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), cleanupGraceMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (cleanup === null || uncertain(cleanup.ok ? cleanup.value : cleanup.error)) {
    const cause = cleanup && !cleanup.ok && cleanup.error instanceof EngineError ? ` (${cleanup.error.code})` : '';
    throw new EngineError('CLEANUP_UNCERTAIN', `${label} did not confirm cleanup after abort${cause}`);
  }
  checkAbort(signal);
  throw new EngineError('INTERNAL_ERROR', 'Aborted operation lost its abort reason');
}

export class RunCoordinator implements CoordinatorPort {
  private readonly owners = new Map<string, Owner>();
  private readonly workspaceLeases = new Map<string, WorkspaceLease>();
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly unsafeWorkspaces = new Set<string>();
  private readonly finalUsage = new Map<string, Readonly<RunUsage>>();
  private readonly verificationSettlementOwners = new WeakMap<ToolContext, { owner: Owner; record: ToolCallRecord; active: () => boolean; binding: string }>();
  private closing = false;
  private closePromise?: Promise<void>;
  private sessionHooks?: {
    boundary(run: Run): boolean;
    cancelled(run: Run): void;
    settled(run: Run): void;
    workspaceIdle(workspaceId: string): void;
  };

  constructor(private readonly options: CoordinatorOptions) {
    for (const tool of options.tools) {
      if (this.tools.has(tool.name)) throw new EngineError('INVALID_CONFIG', `Duplicate tool name: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  submit(input: SubmitInput): RunReceipt {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Run coordinator is closing');
    const recoverySession = this.options.store.hasUncertainWorkspace || this.options.store.hasUncertainSummaries || this.options.store.hasUncertainExecution ? this.options.store.getSession(input.sessionId) : undefined;
    const recoveryBlocked = recoverySession ? this.hasWorkspaceRecoveryBlocker(recoverySession.workspaceId) : false;
    if (recoveryBlocked || this.unsafeWorkspaces.size || this.workspaceLeases.size) {
      const session = recoverySession ?? this.options.store.getSession(input.sessionId);
      if (recoveryBlocked || this.unsafeWorkspaces.has(session.workspaceId) || this.workspaceLeases.has(session.workspaceId)) {
        // Preserve durable request identity before refusing new workspace work.
        const known = this.options.store.hasRunRequest?.(input.sessionId, input.requestId)
          ?? this.options.store.getSnapshot(input.sessionId).runs.some((run) => run.requestId === input.requestId);
        if (known) return this.options.store.admit(input);
        if (recoveryBlocked || this.unsafeWorkspaces.has(session.workspaceId)) throw new EngineError('CLEANUP_PENDING', 'Workspace cleanup is unconfirmed; new runs are blocked');
        throw new EngineError('WORKSPACE_BUSY', 'Workspace maintenance is in progress');
      }
    }
    // Admission owns request identity and workspace busy checks, in that order.
    const receipt = this.options.store.admit(input);
    if (receipt.duplicate) return receipt;
    const run = this.options.store.getRun(receipt.runId);
    this.startOwner(run);
    return receipt;
  }

  setSessionHooks(hooks: NonNullable<RunCoordinator['sessionHooks']>): void {
    if (this.sessionHooks) throw new EngineError('SCHEDULER_ALREADY_ATTACHED', 'Only one session scheduler can own this coordinator');
    this.sessionHooks = hooks;
  }

  activeRun(sessionId: string): Run | undefined {
    for (const owner of this.owners.values()) if (owner.run.sessionId === sessionId && !owner.terminal) return this.options.store.getRun(owner.run.id);
    return undefined;
  }

  /** Nested host verification keeps the original advertised profile/discovery capture. */
  captureToolCatalogue(context: ToolContext): ToolCatalogue {
    const owner = this.owners.get(context.runId);
    if (!owner || owner.terminal || owner.abort.signal.aborted || context.signal.aborted || owner.run.sessionId !== context.sessionId || owner.run.workspaceId !== context.workspace.id || context.workspace.root !== this.options.store.getWorkspace(owner.run.workspaceId).root || !owner.activeTools.has(context.toolCallId) || context.turnId !== owner.turn?.id || context.attemptId !== owner.turn?.attemptId || !owner.catalogue || !this.options.toolRuntime) throw new EngineError('TOOL_CATALOGUE_STALE', 'Nested verification requires the current native tool owner and catalogue');
    owner.discovery?.assertCurrent();
    this.options.toolRuntime.assertCatalogueCurrent(owner.catalogue);
    return owner.catalogue;
  }

  /** Cancellation can settle the consumed command, without creating any new verification work. */
  commitConsumedVerificationSettlement(context: ToolContext, kind: string, expectedRevision: number, data: JsonObject): import('../storage/native-records.js').SessionDocument {
    const capture = this.verificationSettlementOwners.get(context);
    const binding = JSON.stringify([context.workspace.id, context.workspace.root, context.sessionId, context.runId, context.toolCallId, context.turnId, context.attemptId]);
    if (!capture || capture.binding !== binding || !capture.active() || capture.owner.terminal || this.owners.get(context.runId) !== capture.owner || capture.record.name !== 'verify_changes' || capture.record.state !== 'running' || capture.owner.activeTools.get(context.toolCallId) !== capture.record || capture.owner.turn?.id !== context.turnId || capture.owner.turn?.attemptId !== context.attemptId || !context.turnId || !context.attemptId || !this.options.store.putConsumedVerificationSettlement) throw new EngineError('VERIFICATION_SETTLEMENT_OWNER_INVALID', 'Consumed settlement requires the original live native verification execution owner');
    return this.options.store.putConsumedVerificationSettlement({ runId: context.runId, toolCallId: context.toolCallId, turnId: context.turnId, attemptId: context.attemptId }, kind, expectedRevision, data);
  }

  verificationRemainingBudget(run: Run): ChildBudget {
    const owner = this.owners.get(run.id);
    if (!owner || owner.run.sessionId !== run.sessionId) throw new EngineError('VERIFICATION_BOUNDARY_STALE', 'Verification budget requires its current native Run owner');
    this.assertLive(owner);
    const remaining = this.remainingChildBudget(owner), usage = owner.budget.snapshot();
    return { ...remaining, turns: Math.min(remaining.turns, Math.max(0, owner.budget.budgets.turnAllowance - usage.allowanceUsed)) };
  }

  assertVerificationBoundaryCurrent(run: Run, boundary: VerificationBoundary): void {
    const owner = this.owners.get(run.id), records = executionRecords(this.options.store);
    if (!owner || owner.run.sessionId !== run.sessionId || !owner.verificationBoundary || JSON.stringify(owner.verificationBoundary) !== JSON.stringify(boundary) || !records) throw new EngineError('VERIFICATION_BOUNDARY_STALE', 'Verification decision requires the captured current native boundary');
    this.assertLive(owner);
    if (boundary.phase === 'stop') {
      const turn = owner.turn && records.getTurn(owner.turn.id), attempt = owner.turn?.attemptId && records.getAttempt(owner.turn.attemptId);
      const cleanup = attempt && records.getAttemptCleanup?.(attempt.id, run.sessionId);
      if (!turn || turn.id !== boundary.turnId || turn.state !== 'completed' || !attempt || attempt.turnId !== turn.id || attempt.state !== 'completed' || !boundary.providerTerminal || !boundary.nativeTurnCompleted || cleanup && cleanup.cleanupConfirmed !== true) throw new EngineError('VERIFICATION_BOUNDARY_STALE', 'Task completion requires the real completed native Turn and provider Attempt with confirmed cleanup');
    }
  }

  assertWorkspaceAvailable(workspaceId: string, excludedRunId?: string): void {
    // A queued drain during an audit decision must wait without changing the
    // session's durable pause. The decision owns this temporary reservation.
    if (this.workspaceLeases.get(workspaceId)?.summaryRecovery) throw new EngineError('WORKSPACE_BUSY', 'A summary recovery decision is in progress');
    this.assertWorkspaceCleanupConfirmed(workspaceId);
    if (this.workspaceLeases.has(workspaceId)) throw new EngineError('WORKSPACE_BUSY', 'Workspace maintenance is in progress');
    if (this.options.store.hasActiveRuns) { if (this.options.store.hasActiveRuns(workspaceId, excludedRunId)) throw new EngineError('WORKSPACE_BUSY', 'Workspace has an active Run'); }
    else for (const session of this.options.store.listSessions(workspaceId)) if (this.options.store.getSnapshot(session.id).runs.some(run => run.id !== excludedRunId && !isTerminal(run.state))) throw new EngineError('WORKSPACE_BUSY', 'Workspace has an active Run');
  }

  /** Resume may coexist with a live Run, but must never clear uncertain cleanup. */
  assertWorkspaceCleanupConfirmed(workspaceId: string): void {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Run coordinator is closing');
    if (this.unsafeWorkspaces.has(workspaceId) || this.hasWorkspaceRecoveryBlocker(workspaceId)) throw new EngineError('CLEANUP_PENDING', 'Workspace execution is quarantined');
  }
  private hasWorkspaceRecoveryBlocker(workspaceId: string): boolean {
    return this.options.store.hasUncertainWorkspace?.(workspaceId)
      ?? Boolean(this.options.store.hasUncertainSummaries?.(workspaceId) || this.options.store.hasUncertainExecution?.(workspaceId));
  }

  /** The input promotion transaction already admitted this real durable Run. */
  startPromoted(runId: string): Promise<Run> {
    const existing = this.owners.get(runId);
    if (existing) return existing.done;
    const run = this.options.store.getRun(runId);
    if (isTerminal(run.state)) return Promise.resolve(run);
    if (run.state !== 'created') throw new EngineError('RUN_NOT_OWNED', 'Only a newly promoted Run can start; interrupted work requires recovery');
    this.assertWorkspaceAvailable(run.workspaceId, run.id);
    return this.startOwner(run).done;
  }

  private startOwner(run: Run): Owner {
    let resolve!: (run: Run) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<Run>((yes, no) => { resolve = yes; reject = no; });
    const owner: Owner = {
      run, abort: new AbortController(), done, outputBytes: 0, toolCount: 0, budget: new BudgetAccount(run.config),
      callIds: new Set(), readonlyCalls: new Set(), checkpointIds: new Set(), checkpoints: new Map(), terminal: false, invocations: new Map(), activeTools: new Map(), readBatchWidth: 1,
      deadline: Date.now() + run.config.limits.maxDurationMs, childReserved: { turns: 0, toolCalls: 0, outputBytes: 0 }, lifecycleContinuationsUsed: 0,
    };
    this.owners.set(run.id, owner);
    // Attach a rejection observer even if the caller never waits for this run.
    void done.catch(() => {});
    queueMicrotask(() => {
      void this.execute(owner).then(resolve, error => { this.unsafeWorkspaces.add(run.workspaceId); reject(error); }).finally(() => {
        this.owners.delete(run.id);
        try { this.sessionHooks?.settled(this.options.store.getRun(run.id)); }
        catch { this.unsafeWorkspaces.add(run.workspaceId); }
        try { this.sessionHooks?.workspaceIdle(run.workspaceId); } catch { this.unsafeWorkspaces.add(run.workspaceId); }
      });
    });
    return owner;
  }

  /**
   * Hold workspace admission through every effect, observation and cleanup in
   * operation's promise. close() signals abort and waits for that promise;
   * operation must not await close() or detach work from its settlement.
   */
  withWorkspaceLease<T>(workspaceId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.workspaceLease(workspaceId, operation, false);
  }

  /** Host generation owns a durable quarantine, independently of coding effects. */
  withHostGenerationLease<T>(workspaceId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.workspaceLease(workspaceId, operation, false, true);
  }

  /** Physical knowledge publication has its own durable recovery barrier. */
  withHostFilePublicationLease<T>(workspaceId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.workspaceLease(workspaceId, operation, false, true, true);
  }

  /** Host ledger decisions only. Keeps other quarantines and never wakes queued work. */
  withSummaryRecoveryLease<T>(workspaceId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.withRecoveryDecisionLease(workspaceId, operation);
  }

  withRecoveryDecisionLease<T>(workspaceId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.workspaceLease(workspaceId, operation, true);
  }

  private workspaceLease<T>(workspaceId: string, operation: (signal: AbortSignal) => Promise<T>, summaryRecovery: boolean, hostGeneration = false, hostFile = false): Promise<T> {
    try {
      if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Run coordinator is closing');
      this.options.store.getWorkspace(workspaceId);
      if (summaryRecovery) {
        if (this.unsafeWorkspaces.has(workspaceId)) throw new EngineError('CLEANUP_PENDING', 'Independent workspace execution quarantine prevents a recovery decision');
        if ([...this.owners.values()].some(owner => owner.run.workspaceId === workspaceId)) throw new EngineError('WORKSPACE_BUSY', 'A live workspace execution owner prevents a recovery decision');
      } else this.assertWorkspaceCleanupConfirmed(workspaceId);
      if (this.workspaceLeases.has(workspaceId)) throw new EngineError('WORKSPACE_BUSY', 'Workspace maintenance is in progress');
      // Persisted runs can be active without a local owner. SQL stores check
      // the workspace directly; custom legacy stores retain the snapshot path.
      const active = this.options.store.hasActiveRuns?.(workspaceId)
        ?? this.options.store.listSessions(workspaceId).some(session => this.options.store.getSnapshot(session.id).runs.some(run => !isTerminal(run.state)));
      if (active) throw new EngineError('WORKSPACE_BUSY', 'An active workspace run prevents maintenance');
    } catch (error) { return Promise.reject(error); }
    let settled!: () => void;
    const lease: WorkspaceLease = { abort: new AbortController(), done: new Promise<void>((resolve) => { settled = resolve; }), summaryRecovery };
    // No await precedes this registration: immediately following submit/lease
    // calls see the reservation even before operation's microtask starts.
    this.workspaceLeases.set(workspaceId, lease);
    const pending = Promise.resolve().then(async () => {
      try {
        checkAbort(lease.abort.signal);
        const result = await operation(lease.abort.signal);
        if (!summaryRecovery && uncertain(result)) {
          if (!hostGeneration || (hostFile ? this.options.store.hasUncertainKnowledgeFilePublication?.(workspaceId) : this.options.store.hasUncertainKnowledgeGeneration?.(workspaceId)) !== true) throw new EngineError('CLEANUP_UNCERTAIN', 'Workspace maintenance did not confirm its effects and cleanup');
          lease.cleanupError = new EngineError('CLEANUP_UNCERTAIN', 'Host generation cleanup remains recorded in its native quarantine');
        }
        // Preserve observed partial/cancelled restore results after abort. The
        // callback's settlement, rather than the signal, confirms cleanup.
        return result;
      } catch (error) {
        if (!summaryRecovery && hostGeneration && (hostFile ? this.options.store.hasUncertainKnowledgeFilePublication?.(workspaceId) : this.options.store.hasUncertainKnowledgeGeneration?.(workspaceId)) === true) {
          lease.cleanupError = new EngineError('CLEANUP_UNCERTAIN', 'Host generation cleanup remains recorded in its native quarantine');
          throw error;
        }
        if (!summaryRecovery && uncertain(error)) {
          const cause = error instanceof EngineError && error.code !== 'CLEANUP_UNCERTAIN' ? ` (${error.code.slice(0, 128)})` : '';
          lease.cleanupError = new EngineError('CLEANUP_UNCERTAIN', `Workspace maintenance did not confirm its effects and cleanup${cause}`);
          this.unsafeWorkspaces.add(workspaceId);
          throw lease.cleanupError;
        }
        throw error;
      } finally {
        this.workspaceLeases.delete(workspaceId);
        settled();
        if (!summaryRecovery) this.sessionHooks?.workspaceIdle(workspaceId);
      }
    });
    // close can abort a lease whose caller has not attached a handler yet.
    void pending.catch(() => {});
    return pending;
  }

  /** Block new workspace work after recovery or unconfirmed effect accounting. */
  quarantineWorkspace(workspaceId: string): void {
    this.options.store.getWorkspace(workspaceId);
    this.unsafeWorkspaces.add(workspaceId);
  }

  cancel(runId: string): { runId: string; state: RunState } {
    const run = this.options.store.getRun(runId);
    if (isTerminal(run.state)) return { runId, state: run.state };
    const owner = this.owners.get(runId);
    if (!owner) throw new EngineError('RUN_NOT_OWNED', 'Active run is not owned by this coordinator');
    try { this.sessionHooks?.cancelled(run); }
    catch { owner.cleanupError = new EngineError('CLEANUP_UNCERTAIN', 'Session cancellation pause could not be recorded'); }
    if (run.state !== 'cancelling') this.options.store.commit(runId, 'run.cancelling', {}, { run: { state: 'cancelling' } });
    owner.abort.abort(new EngineError('RUN_CANCELLED', 'Run was cancelled'));
    try { this.options.approvals.cancelRun(runId); }
    catch { owner.cleanupError = new EngineError('CLEANUP_UNCERTAIN', 'Pending approval cleanup could not be confirmed'); }
    return { runId, state: this.options.store.getRun(runId).state };
  }

  async waitForRun(runId: string): Promise<Run> {
    const run = this.options.store.getRun(runId);
    if (isTerminal(run.state)) return run;
    const owner = this.owners.get(runId);
    if (!owner) throw new EngineError('RUN_NOT_OWNED', 'Active run is not owned by this coordinator');
    return owner.done;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const pending = [...this.owners.values()];
    const leases = [...this.workspaceLeases.values()];
    const failures: unknown[] = [];
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    // Store the promise before abort dispatch: listeners may synchronously
    // reenter close(), and must receive this same pending promise.
    this.closePromise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    for (const lease of leases) lease.abort.abort(new EngineError('ENGINE_CLOSED', 'Run coordinator is closing'));
    for (const owner of pending) {
      try { this.cancel(owner.run.id); }
      catch (error) { owner.abort.abort(new EngineError('RUN_CANCELLED', 'Run coordinator is closing')); failures.push(error); }
    }
    void Promise.allSettled([...pending.map((owner) => owner.done), ...leases.map((lease) => lease.done)]).then((results) => {
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      for (const lease of leases) if (lease.cleanupError) failures.push(lease.cleanupError);
      if (failures.length) reject(failures[0]);
      else resolve();
    }, reject);
    return this.closePromise;
  }

  private assertLive(owner: Owner): void {
    if (owner.terminal || isTerminal(this.options.store.getRun(owner.run.id).state)) {
      throw new EngineError('RUN_TERMINAL', 'Run already reached a terminal state');
    }
    checkAbort(owner.abort.signal);
  }

  /** Child allocations permanently reduce the active parent's absolute caps. */
  reserveChildRun(runId: string, allocation: ChildBudget): ChildRunReservation {
    const owner = this.owners.get(runId);
    if (!owner) throw new EngineError('PARENT_RUN_NOT_ACTIVE', 'Child allocation requires an active owned parent Run');
    this.assertLive(owner);
    const remainingBudget = this.remainingChildBudget(owner);
    if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation) || Object.keys(allocation).some(key => !['turns', 'toolCalls', 'outputBytes', 'durationMs'].includes(key))
      || !['turns', 'toolCalls', 'outputBytes', 'durationMs'].every(key => Number.isSafeInteger(allocation[key as keyof ChildBudget]) && allocation[key as keyof ChildBudget] >= 0 && allocation[key as keyof ChildBudget] <= remainingBudget[key as keyof ChildBudget])
      || allocation.turns < 1 || allocation.durationMs < 1) throw new EngineError('CHILD_BUDGET_EXCEEDED', 'Child allocation must fit the active parent remaining budget');
    const selected = { ...allocation };
    for (const key of ['turns', 'toolCalls', 'outputBytes'] as const) owner.childReserved[key] += selected[key];
    return { signal: owner.abort.signal, remainingBudget, allocation: selected };
  }

  getRemainingChildBudget(runId: string): ChildBudget {
    const owner = this.owners.get(runId);
    if (!owner) throw new EngineError('PARENT_RUN_NOT_ACTIVE', 'Child budget inspection requires an active owned parent Run');
    this.assertLive(owner); return this.remainingChildBudget(owner);
  }

  getRunCancellationSignal(runId: string): AbortSignal {
    const owner = this.owners.get(runId);
    if (!owner) throw new EngineError('PARENT_RUN_NOT_ACTIVE', 'Child cancellation ownership requires an active owned parent Run');
    this.assertLive(owner); return owner.abort.signal;
  }

  getRunUsage(runId: string): Readonly<RunUsage> {
    const owner = this.owners.get(runId);
    if (owner) return Object.freeze({ turns: owner.budget.snapshot().logicalTurns, toolCalls: owner.toolCount, outputBytes: owner.outputBytes });
    const usage = this.finalUsage.get(runId);
    if (!usage) throw new EngineError('RUN_USAGE_UNAVAILABLE', 'Measured Run usage is not retained by this coordinator');
    return Object.freeze({ ...usage });
  }

  private discoveryOwner(context: ToolContext): Owner & { discovery: RunToolDiscovery } {
    checkAbort(context.signal);
    const owner = this.owners.get(context.runId);
    if (!owner || !owner.discovery || owner.run.sessionId !== context.sessionId || owner.run.workspaceId !== context.workspace.id
      || owner.turn?.id !== context.turnId || owner.turn?.attemptId !== context.attemptId) {
      throw new EngineError('TOOL_DISCOVERY_STALE', 'Discovery requires its active Run and Turn owner');
    }
    this.assertLive(owner);
    const record = owner.activeTools.get(context.toolCallId);
    if (!record || record.name !== DISCOVERY_TOOL_NAME || !['requested', 'awaiting_approval', 'running'].includes(record.state)) {
      throw new EngineError('TOOL_DISCOVERY_STALE', 'Discovery requires its active tool invocation');
    }
    return owner as Owner & { discovery: RunToolDiscovery };
  }

  toolDiscoveryIdentity(context: ToolContext): { registryRevision: number; policyVersion: number } {
    return this.discoveryOwner(context).discovery.identity();
  }

  stageToolDiscovery(context: ToolContext, query: string, limit: number, expected: { registryRevision: number; policyVersion: number }, action?: ToolDiscoveryAction): ToolResult {
    const owner = this.discoveryOwner(context);
    if (owner.activeTools.get(context.toolCallId)!.state !== 'running') throw new EngineError('TOOL_DISCOVERY_STALE', 'Discovery selection requires the executing tool owner');
    return owner.discovery.stage(context.toolCallId, query, limit, expected, action);
  }

  private remainingChildBudget(owner: Owner): ChildBudget {
    const usage = owner.budget.snapshot(), limits = owner.run.config.limits;
    return { turns: Math.max(0, limits.maxTurns - usage.logicalTurns - owner.childReserved.turns),
      toolCalls: Math.max(0, limits.maxToolCalls - Math.max(owner.toolCount, usage.toolCalls) - owner.childReserved.toolCalls),
      outputBytes: Math.max(0, limits.maxOutputBytes - owner.outputBytes - owner.childReserved.outputBytes),
      durationMs: Math.max(0, owner.deadline - Date.now()) };
  }

  private finish(owner: Owner, state: 'completed' | 'cancelled' | 'failed', error?: EngineError): Run {
    const run = this.options.store.getRun(owner.run.id);
    if (owner.terminal || isTerminal(run.state)) { owner.terminal = true; if (!owner.abort.signal.aborted) owner.abort.abort(new EngineError('PARENT_RUN_TERMINAL', 'The owning parent Run reached a terminal state')); return run; }
    const failure = error ? { code: error.code.slice(0, 128), message: prefixBytes(error.message, 2_048) } : undefined;
    if (error?.code === 'CLEANUP_UNCERTAIN') this.unsafeWorkspaces.add(run.workspaceId);
    this.options.store.commit(run.id, `run.${state}`, failure ? { error: failure } : {}, {
      run: { state, ...(failure ? { error: failure } : {}) },
    });
    owner.terminal = true;
    this.finalUsage.delete(run.id);
    this.finalUsage.set(run.id, Object.freeze({ turns: owner.budget.snapshot().logicalTurns, toolCalls: owner.toolCount, outputBytes: owner.outputBytes }));
    if (this.finalUsage.size > 256) this.finalUsage.delete(this.finalUsage.keys().next().value!);
    // Provider/tool settlement has completed. Owned children must not outlive
    // either successful parent completion or failure/cancellation.
    if (!owner.abort.signal.aborted) owner.abort.abort(new EngineError('PARENT_RUN_TERMINAL', 'The owning parent Run reached a terminal state'));
    return this.options.store.getRun(run.id);
  }

  private async execute(owner: Owner): Promise<Run> {
    const { run } = owner;
    const timer = setTimeout(() => {
      owner.abort.abort(new EngineError('RUN_TIME_LIMIT', 'Run duration budget was exceeded'));
      try { this.options.approvals.cancelRun(run.id); }
      catch { owner.cleanupError = new EngineError('CLEANUP_UNCERTAIN', 'Pending approval cleanup could not be confirmed'); }
    }, run.config.limits.maxDurationMs);
    try {
      this.assertLive(owner);
      this.options.store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
      owner.lifecycle = this.options.lifecycleHooks?.capture({ workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.id });
      if (this.options.onRunStarted) await abortable(() => this.options.onRunStarted!(run, owner.abort.signal), owner.abort.signal, 'Host Run initialization');
      this.assertLive(owner);
      const provider = this.options.providers.get(run.config.providerId);
      if (!provider) throw new EngineError('PROVIDER_NOT_FOUND', `Unknown provider: ${run.config.providerId}`);
      const workspace = this.options.store.getWorkspace(run.workspaceId);
      const allowed = this.options.getAllowedTools?.(run);
      const profile = this.options.getToolProfile?.(run);
      if (allowed !== undefined) {
        if (!Array.isArray(allowed) || allowed.length > 1024 || allowed.some(name => typeof name !== 'string' || name.length === 0 || Buffer.byteLength(name) > 256)) throw new EngineError('INVALID_TOOL_ALLOWLIST', 'The host tool allowlist is invalid');
        owner.allowedTools = new Set(allowed);
      }
      if (this.options.toolDiscoveryPolicy) {
        if (!this.options.toolRuntime) throw new EngineError('INVALID_TOOL_DISCOVERY_POLICY', 'Discovery requires the scoped tool runtime');
        owner.discovery = new RunToolDiscovery(this.options.toolRuntime, this.options.toolDiscoveryPolicy, this.options.coreToolNames ?? this.options.tools.map(tool => tool.name), run.config.mode, owner.allowedTools ? [...owner.allowedTools] : undefined);
      }
      let reservedBytes = 0, toolCatalogueSha256 = '', plannedCatalogue: ToolCatalogue | undefined;
      const assertCatalogueCurrent = () => {
        owner.discovery?.assertCurrent();
        if (owner.catalogue) this.options.toolRuntime!.assertCatalogueCurrent(owner.catalogue);
      };
      const captureCatalogue = () => {
        if (owner.discovery) {
          const dispatch = owner.discovery.capture(); owner.catalogue = profile ? this.options.toolRuntime!.bindProfile(dispatch.catalogue, profile) : dispatch.catalogue; reservedBytes = dispatch.reservedBytes; toolCatalogueSha256 = dispatch.toolCatalogueSha256;
        } else {
          // catalogue() creates a new opaque handle. Reuse a current capture so
          // identity comparison at the dispatch boundary does not cause churn.
          if (owner.catalogue) {
            try { assertCatalogueCurrent(); return; }
            catch (error) { if (!(error instanceof EngineError) || error.code !== 'TOOL_CATALOGUE_STALE') throw error; }
          }
          owner.catalogue = this.options.toolRuntime?.catalogue('engine', run.config.mode, owner.allowedTools ? [...owner.allowedTools] : undefined, profile);
          const schemas = owner.catalogue?.tools ?? this.availableTools(owner).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
          reservedBytes = Buffer.byteLength(JSON.stringify({ messages: [], tools: schemas }), 'utf8') - 2;
          toolCatalogueSha256 = createHash('sha256').update(JSON.stringify(schemas)).digest('hex');
        }
      };
      captureCatalogue();
      let contextTurnIndex = 0;
      const contextRequest = () => ({
        workspace, snapshot: this.options.contextSnapshot?.(run.sessionId, run.config) ?? this.options.store.getSnapshot(run.sessionId), config: run.config, signal: owner.abort.signal, reservedBytes, run, budget: owner.budget,
        ...(owner.lifecycle ? { lifecycleCapture: owner.lifecycle } : {}),
        turnIndex: contextTurnIndex,
        ...(owner.verificationContinuation ? { verificationContinuation: structuredClone(owner.verificationContinuation.message) } : {}),
        ...(owner.lifecycleContinuation ? { lifecycleContinuation: structuredClone(owner.lifecycleContinuation.message) } : {}),
        consumeSummaryOutput: (bytes: number) => {
          if (!Number.isSafeInteger(bytes) || bytes < 0) throw new EngineError('INVALID_BUDGET_USAGE', 'Summary output bytes must be a nonnegative safe integer');
          if (bytes > run.config.limits.maxOutputBytes - owner.outputBytes - owner.childReserved.outputBytes) throw new EngineError('OUTPUT_LIMIT', 'Summary output exceeds the remaining Run output budget');
          owner.outputBytes += bytes;
        },
      });
      const context = async (fixedCatalogue = false) => {
        for (let changes = 0; changes < 16; changes++) {
          if (fixedCatalogue) assertCatalogueCurrent();
          else captureCatalogue();
          const messages = await abortable(() => this.options.buildContext(contextRequest()), owner.abort.signal, 'Context builder');
          try { assertCatalogueCurrent(); }
          catch (error) {
            if (!fixedCatalogue && error instanceof EngineError && ['TOOL_DISCOVERY_STALE', 'TOOL_CATALOGUE_STALE'].includes(error.code)) continue;
            throw error;
          }
          plannedCatalogue = owner.catalogue; return messages;
        }
        throw new EngineError(owner.discovery ? 'TOOL_DISCOVERY_STALE' : 'TOOL_CATALOGUE_STALE', 'Repeated catalogue changes exceeded the bounded context rebuild allowance');
      };
      let messages = await context();
      this.assertLive(owner);
      messages = structuredClone(messages);
      for (let turnIndex = 0; turnIndex < run.config.limits.maxTurns; turnIndex++) {
        contextTurnIndex = turnIndex;
        this.assertLive(owner);
        // Context construction may await a provider summary. Drain any steer that
        // arrived during that await before fixing the next dispatch cutoff.
        let steerRebuilds = 0, catalogueRebuilds = 0;
        while (true) {
          if (this.sessionHooks?.boundary(run)) {
            if (++steerRebuilds > 16) throw new EngineError('STEER_CONTEXT_LIMIT', 'Continuous steer arrivals exceeded the bounded context rebuild allowance');
            owner.budget.inputPromoted(); messages = structuredClone(await context());
            this.assertLive(owner); continue;
          }
          captureCatalogue();
          if (owner.catalogue !== plannedCatalogue) {
            if (++catalogueRebuilds > 16) throw new EngineError(owner.discovery ? 'TOOL_DISCOVERY_STALE' : 'TOOL_CATALOGUE_STALE', 'Repeated catalogue changes exceeded the bounded dispatch rebuild allowance');
            messages = structuredClone(await context()); this.assertLive(owner); continue;
          }
          break;
        }
        if (owner.budget.snapshot().logicalTurns + owner.childReserved.turns >= run.config.limits.maxTurns) throw new EngineError('TURN_LIMIT', 'Parent and reserved child turns reached the Run turn limit');
        if (owner.verificationContinuation && this.options.verificationBeforeProvider) {
          owner.verificationBoundary = { id: `${run.id}:next:${turnIndex}:${owner.verificationContinuation.stageId}`, phase: 'before-provider', turnId: null, providerTerminal: false, nativeTurnCompleted: false };
          await abortable(() => this.options.verificationBeforeProvider!(run, owner.verificationBoundary!, owner.abort.signal), owner.abort.signal, 'Verification continuation boundary');
          this.assertLive(owner);
        }
        owner.budget.startTurn();
        owner.invocations.clear();
        const bytes = this.checkContext(owner, messages);
        this.options.store.commit(run.id, 'context.prepared', {
          turnIndex, bytes, limit: run.config.limits.maxContextBytes,
          reservedToolBytes: reservedBytes, toolCatalogueSha256,
          advertisedToolNames: (owner.catalogue?.tools ?? this.availableTools(owner)).map(tool => tool.name),
          ...(owner.catalogue ? { registryRevision: owner.catalogue.revision, policyVersion: owner.catalogue.policyVersion } : {}),
          summaryIncluded: messages.some((message) => message.role === 'assistant' && [EXTRACTIVE_MEMORY_PREFIX, SEMANTIC_MEMORY_PREFIX, ACTIVE_PREFIX_MEMORY_PREFIX].some(prefix => message.content.startsWith(prefix))),
        });
        const records = executionRecords(this.options.store);
        const revisionId = this.options.getContextRevisionId?.(run.sessionId);
        owner.turn = new TurnExecutor({ run, index: turnIndex, inputIds: records?.listRunInputIds?.(run.id) ?? [run.inputId], budget: owner.budget,
          store: this.options.store, wait: abortable, ...(revisionId ? { contextRevisionId: revisionId } : {}), currentContextRevisionId: () => this.options.getContextRevisionId?.(run.sessionId),
          assertContextFresh: async (request, signal) => {
            await this.options.assertContextFresh?.(request, signal); assertCatalogueCurrent();
            if (owner.lifecycleContinuation) await this.options.lifecycleContinuation!.assertFresh(run, owner.lifecycleContinuation, signal);
            if (owner.verificationContinuation && owner.verificationBoundary && this.options.verificationBeforeProvider) await this.options.verificationBeforeProvider(run, owner.verificationBoundary, signal);
            this.assertLive(owner);
            if (owner.lifecycle) this.options.lifecycleHooks!.assertCurrent(owner.lifecycle);
            assertCatalogueCurrent();
          },
          ...(this.options.recoverContextOverflow ? { recoverContextOverflow: async () => {
            assertCatalogueCurrent();
            const failedAttemptId = owner.turn?.attemptId;
            await abortable(() => this.options.recoverContextOverflow!({ ...contextRequest(), ...(owner.turn && failedAttemptId ? {
              activePrefixStage: { stage: 'overflow-recovery' as const, currentTurnId: owner.turn.id, failedAttemptId, cleanupConfirmed: true as const },
            } : {}) }, provider), owner.abort.signal, 'Context overflow recovery');
            // TurnExecutor replaces only messages on overflow retry. Retain the
            // same advertised schemas and handler capture or stop before retry.
            messages = structuredClone(await context(true)); this.checkContext(owner, messages); return messages;
          } } : {}) });
        const turn = await this.providerTurn(owner, provider, messages, turnIndex);
        owner.verificationContinuation = undefined; owner.verificationBoundary = undefined; owner.lifecycleContinuation = undefined;
        this.assertLive(owner);
        if (turn.calls.length > this.remainingChildBudget(owner).toolCalls) throw new EngineError('TOOL_CALL_LIMIT', 'Parent and reserved child tools reached the Run tool limit');
        owner.budget.reserveToolCalls(turn.calls.length);
        messages.push({ role: 'assistant', content: turn.message.content, ...(turn.calls.length ? { toolCalls: turn.calls } : {}) });
        if (turn.calls.length === 0) {
          if (this.sessionHooks?.boundary(run)) { owner.budget.inputPromoted(); messages = structuredClone(await context()); continue; }
          if (this.options.verificationStop && owner.turn) {
            owner.verificationBoundary = { id: owner.turn.id, phase: 'stop', turnId: owner.turn.id, providerTerminal: true, nativeTurnCompleted: true };
            const continuation = await abortable(() => this.options.verificationStop!(run, owner.verificationBoundary!, owner.abort.signal), owner.abort.signal, 'Verification completion boundary');
            owner.verificationBoundary = undefined; this.assertLive(owner);
            if (continuation) { owner.verificationContinuation = continuation; contextTurnIndex = turnIndex + 1; messages = structuredClone(await context()); continue; }
          }
          const boundary: VerificationBoundary = { id: owner.turn!.id, phase: 'stop', turnId: owner.turn!.id, providerTerminal: true, nativeTurnCompleted: true };
          owner.verificationBoundary = boundary;
          const receipt = this.options.lifecycleContinuation
            ? await abortable(() => this.options.lifecycleContinuation!.capture(run, boundary, owner.abort.signal), owner.abort.signal, 'Lifecycle verification receipt') : null;
          this.assertLive(owner);
          owner.lifecycleStopChecked = true;
          const stopping = await this.lifecycle(owner, 'before-stop', owner.lifecycleContinuationsUsed ? `${owner.turn!.id}:stop` : `${run.id}:stop`, { outcome: 'completed', turnCount: owner.budget.snapshot().logicalTurns, toolCallCount: owner.toolCount, outputBytes: owner.outputBytes,
            continuationsUsed: owner.lifecycleContinuationsUsed, ...(receipt ? { verificationSha256: receipt.verificationSha256 } : {}) });
          if (stopping?.continuation) {
            if (!this.options.lifecycleContinuation) throw new EngineError('LIFECYCLE_CONTINUATION_UNSUPPORTED', 'Lifecycle continuation requires an explicit host execution port');
            if (!receipt || receipt.verificationSha256 !== stopping.continuation.verificationSha256) throw new EngineError('LIFECYCLE_CONTINUATION_STALE', 'Lifecycle continuation requires the original completed verification receipt');
            if (owner.lifecycleContinuationsUsed >= 1) throw new EngineError('LIFECYCLE_CONTINUATION_LIMIT', 'Only one lifecycle continuation is admitted per original Run');
            if (this.remainingChildBudget(owner).turns < 1) throw new EngineError('TURN_LIMIT', 'Lifecycle continuation cannot exceed the original Run turn budget');
            if (owner.budget.snapshot().allowanceUsed >= owner.budget.budgets.turnAllowance) throw new EngineError('TURN_ALLOWANCE', 'Lifecycle continuation cannot reset the original input turn allowance');
            if (this.remainingChildBudget(owner).outputBytes < 1) throw new EngineError('OUTPUT_LIMIT', 'Lifecycle continuation requires remaining original Run output budget');
            if (Date.now() >= owner.deadline) throw new EngineError('RUN_TIME_LIMIT', 'Lifecycle continuation cannot extend the original Run deadline');
            const admitted = await abortable(() => this.options.lifecycleContinuation!.admit(run, boundary, stopping.continuation!, owner.abort.signal), owner.abort.signal, 'Lifecycle continuation admission');
            this.assertLive(owner);
            if (owner.lifecycle) this.options.lifecycleHooks!.assertCurrent(owner.lifecycle);
            assertCatalogueCurrent();
            await abortable(() => this.options.lifecycleContinuation!.assertFresh(run, admitted, owner.abort.signal), owner.abort.signal, 'Lifecycle continuation freshness');
            this.assertLive(owner);
            owner.lifecycleContinuation = admitted; owner.lifecycleContinuationsUsed++; owner.lifecycleStopChecked = false; owner.verificationBoundary = undefined;
            contextTurnIndex = turnIndex + 1; messages = structuredClone(await context()); continue;
          }
          return this.finish(owner, 'completed');
        }
        await this.executeCalls(owner, turn.calls, workspace, messages);
        owner.turn.complete();
        // Rebuild from committed exchanges so older context can be trimmed again.
        if (turnIndex + 1 < run.config.limits.maxTurns) { contextTurnIndex = turnIndex + 1; messages = structuredClone(await context()); }
      }
      throw new EngineError('TURN_LIMIT', 'Model turn budget was exceeded');
    } catch (error) {
      const failure = owner.cleanupError ?? errorOf(error);
      // Context construction can report cancellation before any Turn exists.
      // Use the same durable cancelling transition and session pause as an
      // external cancellation before settling the authoritative result.
      if (failure.code === 'RUN_CANCELLED' && this.options.store.getRun(run.id).state !== 'cancelling') {
        try { this.cancel(run.id); }
        catch { owner.cleanupError = new EngineError('CLEANUP_UNCERTAIN', 'Run cancellation could not be durably recorded'); }
      }
      try { owner.turn?.fail(failure); }
      catch { owner.cleanupError = new EngineError('CLEANUP_UNCERTAIN', 'Execution records could not be durably settled'); }
      for (const tool of owner.activeTools.values()) if (!['completed', 'denied', 'failed', 'interrupted'].includes(tool.state)) this.setTool(owner, tool, 'interrupted', { error: prefixBytes(failure.message, 2_048) });
      try { this.options.approvals.cancelRun(run.id); }
      catch { owner.cleanupError = new EngineError('CLEANUP_UNCERTAIN', 'Pending approval cleanup could not be confirmed'); }
      const terminalError = owner.cleanupError ?? failure;
      if (!owner.lifecycleStopChecked && !owner.abort.signal.aborted) {
        owner.lifecycleStopChecked = true;
        // Terminal observation cannot replace producer failure or cleanup uncertainty.
        try { await this.lifecycle(owner, 'before-stop', owner.lifecycleContinuationsUsed ? `${owner.turn?.id ?? run.id}:failure-stop` : `${run.id}:stop`, { outcome: terminalError.code === 'RUN_CANCELLED' ? 'cancelled' : 'failed', errorCode: terminalError.code, turnCount: owner.budget.snapshot().logicalTurns, toolCallCount: owner.toolCount, outputBytes: owner.outputBytes, continuationsUsed: owner.lifecycleContinuationsUsed }, false); } catch { /* Preserve the authoritative execution failure. */ }
      }
      return this.finish(owner, terminalError.code === 'RUN_CANCELLED' ? 'cancelled' : 'failed', terminalError.code === 'RUN_CANCELLED' ? undefined : terminalError);
    } finally { clearTimeout(timer); if (owner.lifecycle) this.options.lifecycleHooks!.release(owner.lifecycle); this.options.releaseContext?.(run.sessionId, run.id); }
  }

  private async lifecycle(owner: Owner, stage: LifecycleInvocation['stage'], invocationId: string, metadata: LifecycleInvocation['metadata'], control = true): Promise<LifecycleDispatchOutcome | undefined> {
    const registry = this.options.lifecycleHooks, capture = owner.lifecycle;
    if (!registry || !capture) return undefined;
    registry.assertCurrent(capture);
    if (!capture.hooks.some(hook => hook.stages.includes(stage))) return undefined;
    const outcome = await registry.dispatch(capture, { invocationId, identity: capture.identity, stage, metadata } as LifecycleInvocation, owner.abort.signal);
    // Store bounded identity/status only. Host-returned metadata and reason text
    // do not become durable request data or replay/cleanup authority.
    const payload: JsonObject = { invocationId, stage, registryRevision: outcome.registryRevision, status: outcome.status, action: outcome.action,
      ...(outcome.inputRewrite ? { originalInputSha256: outcome.inputRewrite.originalSha256, effectiveInputSha256: outcome.inputRewrite.effectiveSha256 } : {}),
      outcomes: outcome.outcomes.map(item => ({ hookId: item.hookId, hookRevision: item.hookRevision, status: item.status, action: item.action, elapsedMs: item.elapsedMs, ...(item.code ? { code: item.code } : {}), ...(item.transform ? { transform: { ...item.transform } } : {}) })) };
    const refs = owner.turn ? { turnId: owner.turn.id, ...(owner.turn.attemptId ? { attemptId: owner.turn.attemptId } : {}) } : {};
    if (this.options.store.commitRunObservation) this.options.store.commitRunObservation(owner.run.id, 'lifecycle.outcome', payload, refs);
    else this.options.store.commit(owner.run.id, 'lifecycle.outcome', payload);
    if (!control) return outcome;
    this.assertLive(owner);
    if (outcome.status === 'stale') throw new EngineError('LIFECYCLE_REGISTRY_STALE', 'Lifecycle configuration changed during this Run');
    if (outcome.action === 'stop' || outcome.status === 'cancelled') {
      this.cancel(owner.run.id);
      throw new EngineError('RUN_CANCELLED', 'A host lifecycle hook stopped the Run');
    }
    return outcome;
  }

  private availableTools(owner: Owner): readonly ToolDefinition[] {
    const allowed = owner.allowedTools;
    return allowed ? this.options.tools.filter(tool => allowed.has(tool.name)) : this.options.tools;
  }

  private checkContext(owner: Owner, messages: ProviderMessage[]): number {
    const schemas = owner.catalogue?.tools ?? this.availableTools(owner).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const bytes = Buffer.byteLength(JSON.stringify({ messages, tools: schemas }), 'utf8');
    if (bytes > owner.run.config.limits.maxContextBytes) {
      throw new EngineError('CONTEXT_LIMIT', 'Model context byte budget was exceeded');
    }
    return bytes;
  }

  private message(owner: Owner, role: 'assistant' | 'tool', content = ''): Message {
    return { id: randomUUID(), sessionId: owner.run.sessionId, runId: owner.run.id, role, content, createdAt: now() };
  }
  private async executeCalls(owner: Owner, calls: ProviderToolCall[], workspace: ToolContext['workspace'], messages: ProviderMessage[]): Promise<void> {
    const declaredRead = (call: ProviderToolCall): boolean => {
      try { return (this.options.toolRuntime && owner.catalogue ? this.options.toolRuntime.resolve(owner.catalogue, call.name) : this.tools.get(call.name))?.effectClass === 'read'; }
      catch { return false; }
    };
    for (let index = 0; index < calls.length;) {
      this.assertLive(owner);
      if (!declaredRead(calls[index]!)) {
        const call = calls[index++]!; const content = await this.executeTool(owner, call, workspace); messages.push({ role: 'tool', content, toolCallId: call.id }); continue;
      }
      const batch: ProviderToolCall[] = [];
      while (index < calls.length && declaredRead(calls[index]!) && batch.length < owner.budget.budgets.maxReadConcurrency) batch.push(calls[index++]!);
      owner.readBatchWidth = batch.length;
      try {
        const outcomes = await Promise.allSettled(batch.map(async call => {
          try { return await this.executeTool(owner, call, workspace); }
          catch (error) { owner.abort.abort(errorOf(error)); throw error; }
        }));
        const failure = outcomes.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        outcomes.forEach((result, position) => { if (result.status === 'fulfilled') messages.push({ role: 'tool', content: result.value, toolCallId: batch[position]!.id }); });
      } finally { owner.readBatchWidth = 1; }
    }
  }

  private async providerTurn(owner: Owner, provider: ProviderAdapter, messages: ProviderMessage[], turnIndex: number): Promise<{ message: Message; calls: ProviderToolCall[] }> {
    const message = this.message(owner, 'assistant');
    const calls: ProviderToolCall[] = [];
    let finish: 'stop' | 'tool_calls' | 'length' | undefined;
    let replay: ProviderReplay | undefined;
    let pendingDelta = '', firstDelta = true;
    const flush = () => {
      if (!pendingDelta) return;
      const delta = pendingDelta;
      pendingDelta = '';
      this.options.store.commit(owner.run.id, 'message.delta', { messageId: message.id, delta, turnIndex }, { message: { ...message } });
      owner.turn!.putText(message.id, 'text', delta);
    };
    const flushTimer = setInterval(() => {
      if (!pendingDelta || owner.terminal || owner.abort.signal.aborted) return;
      try { flush(); } catch { owner.abort.abort(new EngineError('STORAGE_COMMIT_FAILED', 'Streamed output could not be persisted')); }
    }, 16);
    const advertised = [...(owner.catalogue?.tools ?? this.availableTools(owner).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })))];
    const tools = structuredClone(advertised);
    let iterator: AsyncIterator<ProviderEvent> | undefined;
    try {
      const request = { runId: owner.run.id, sessionId: owner.run.sessionId, turnIndex, modelId: owner.run.config.modelId, messages: structuredClone(messages), tools,
        ...(owner.run.config.reasoningEffort !== undefined ? { reasoningEffort: owner.run.config.reasoningEffort } : {}),
      };
      const contextRevisionId = this.options.getContextRevisionId?.(owner.run.sessionId);
      const before = await this.lifecycle(owner, 'before-model', `${owner.turn!.id}:before-model`, { providerId: provider.id, modelId: request.modelId, turnIndex, turnId: owner.turn!.id,
        ...(contextRevisionId ? { contextRevisionId } : {}), contextBytes: Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools })), toolCount: tools.length, requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex') });
      if (before?.action === 'deny') throw new EngineError('LIFECYCLE_DENIED', 'A host lifecycle hook denied model dispatch');
      this.assertLive(owner);
      if (owner.catalogue) this.options.toolRuntime!.assertCatalogueCurrent(owner.catalogue);
      if (this.options.getContextRevisionId?.(owner.run.sessionId) !== contextRevisionId) throw new EngineError('CONTEXT_REVISION_STALE', 'Context changed during the model lifecycle boundary');
      if (this.options.assertContextFresh) {
        const observedRequest = structuredClone(request), requestHash = createHash('sha256').update(JSON.stringify(observedRequest)).digest('hex');
        await abortable(() => this.options.assertContextFresh!(observedRequest, owner.abort.signal), owner.abort.signal, 'Context dispatch freshness');
        if (createHash('sha256').update(JSON.stringify(observedRequest)).digest('hex') !== requestHash) throw new EngineError('CONTEXT_REQUEST_MUTATED', 'Context freshness observer altered the frozen logical request');
      }
      this.assertLive(owner);
      if (owner.catalogue) this.options.toolRuntime!.assertCatalogueCurrent(owner.catalogue);
      if (this.options.getContextRevisionId?.(owner.run.sessionId) !== contextRevisionId) throw new EngineError('CONTEXT_REVISION_STALE', 'Context changed during source freshness validation');
      iterator = owner.turn!.stream(provider, request, owner.abort.signal)[Symbol.asyncIterator]();
      while (true) {
        const item = await abortable(() => iterator!.next(), owner.abort.signal, 'Provider stream');
        this.assertLive(owner);
        if (item.done) break;
        const event = item.value;
        if (event.type !== 'text.delta') flush();
        if (finish && event.type !== 'usage') throw new EngineError('PROVIDER_PROTOCOL_ERROR', 'Provider emitted content after finishing its turn');
        switch (event.type) {
          case 'text.delta': {
            if (typeof event.delta !== 'string') throw new EngineError('PROVIDER_PROTOCOL_ERROR', 'Provider text delta must be a string');
            if (!event.delta) break;
            const text = this.consumeOutput(owner, event.delta);
            if (text.content) {
              message.content += text.content;
              pendingDelta += text.content;
              if (firstDelta || Buffer.byteLength(pendingDelta) >= 4096) { flush(); firstDelta = false; }
            }
            if (text.truncated) throw new EngineError('OUTPUT_LIMIT', 'Run output byte budget was exceeded');
            break;
          }
          case 'tool.call': {
            const call = event.call;
            if (!call || typeof call.id !== 'string' || !call.id || call.id.length > 256 || typeof call.name !== 'string' || !call.name || call.name.length > 128 || call.input === undefined) {
              throw new EngineError('PROVIDER_PROTOCOL_ERROR', 'Provider returned an invalid complete tool call');
            }
            if (calls.some(previous => previous.id === call.id) || (!owner.turn!.records && owner.callIds.has(call.id))) throw new EngineError('PROVIDER_PROTOCOL_ERROR', 'Provider reused a tool call ID');
            if (owner.toolCount + calls.length + owner.childReserved.toolCalls >= owner.run.config.limits.maxToolCalls) throw new EngineError('TOOL_CALL_LIMIT', 'Tool call budget was exceeded');
            if (Buffer.byteLength(JSON.stringify(call), 'utf8') > owner.run.config.limits.maxContextBytes) throw new EngineError('CONTEXT_LIMIT', 'Tool call input exceeds the context byte budget');
            owner.callIds.add(call.id);
            calls.push(structuredClone(call));
            // Preserve complete proposals before provider completion. They are
            // observations only; execution still requires a validated finish.
            flush();
            const internalId = randomUUID(); owner.invocations.set(call.id, internalId);
            owner.turn!.toolProposal(message.id, internalId, call);
            break;
          }
          case 'usage': {
            const usage: JsonObject = { turnIndex, ...(owner.turn ? { turnId: owner.turn.id, ...(owner.turn.attemptId ? { attemptId: owner.turn.attemptId } : {}) } : {}) };
            for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens'] as const) {
              const count = event[key];
              if (count === undefined) continue;
              if (!Number.isSafeInteger(count) || count < 0) throw new EngineError('PROVIDER_PROTOCOL_ERROR', 'Provider usage must be non-negative integer counts');
              usage[key] = count;
            }
            if (event.cachedInputTokens !== undefined && event.inputTokens !== undefined && event.cachedInputTokens > event.inputTokens || event.reasoningOutputTokens !== undefined && event.outputTokens !== undefined && event.reasoningOutputTokens > event.outputTokens) throw new EngineError('PROVIDER_PROTOCOL_ERROR', 'Provider usage details exceed inclusive totals');
            // Missing usage remains absent; a zero count is a supplied value.
            if (owner.turn?.attemptId && owner.turn.records?.putAttemptUsage) {
              const { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens } = event;
              owner.turn.records.putAttemptUsage(owner.turn.attemptId, {
                ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
                ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }), ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
              });
            }
            this.options.store.commit(owner.run.id, 'run.usage', usage);
            break;
          }
          case 'reasoning.delta': {
            if (typeof event.delta !== 'string') throw new EngineError('PROVIDER_PROTOCOL_ERROR', 'Public reasoning summary must be a string');
            const output = this.consumeOutput(owner, event.delta); if (output.content) owner.turn!.putText(message.id, 'reasoning', output.content);
            if (output.truncated) throw new EngineError('OUTPUT_LIMIT', 'Run output byte budget was exceeded');
            break;
          }
          case 'media': owner.turn!.putMedia(message.id, event); break;
          case 'progress': break;
          case 'finish':
            if (!['stop', 'tool_calls', 'length'].includes(event.reason)) throw new EngineError('PROVIDER_PROTOCOL_ERROR', 'Provider finish reason is unsupported');
            finish = event.reason;
            if (finish !== 'length') {
              const descriptor = Object.getOwnPropertyDescriptor(event, 'replayItems');
              if ((!descriptor && 'replayItems' in event) || (descriptor && !('value' in descriptor))) throw new EngineError('INVALID_PROVIDER_REPLAY', 'Provider replay must contain plain JSON output objects');
              if (descriptor?.value !== undefined) replay = copyReplay(descriptor.value, provider.id, owner.run.config.limits.maxContextBytes, provider.replayProtocol ? { modelId: owner.run.config.modelId, protocol: provider.replayProtocol, version: 1 } : {});
            }
            break;
          default: throw new EngineError('PROVIDER_PROTOCOL_ERROR', 'Provider emitted an unsupported event');
        }
      }
      if (!finish) throw new EngineError('PROVIDER_PROTOCOL_ERROR', 'Provider stream ended without a finish event');
      flush();
      if (finish === 'length') throw new EngineError('PROVIDER_LENGTH', 'Provider stopped at its output limit');
      if ((finish === 'tool_calls') !== (calls.length > 0)) throw new EngineError('PROVIDER_PROTOCOL_ERROR', 'Provider finish reason does not match its complete tool calls');
      if (calls.length) message.toolCalls = calls;
      if (replay) message.providerReplay = replay;
      this.options.store.commit(owner.run.id, 'message.completed', { messageId: message.id, turnIndex, finishReason: finish }, { message });
      owner.turn!.outputFinished(finish, calls.length > 0);
      await this.lifecycle(owner, 'after-model', `${owner.turn!.id}:after-model`, { providerId: provider.id, modelId: owner.run.config.modelId, turnIndex, turnId: owner.turn!.id,
        ...(owner.turn!.attemptId ? { attemptId: owner.turn!.attemptId } : {}), finishReason: finish, toolCallCount: calls.length, outputBytes: Buffer.byteLength(message.content) });
      return { message, calls };
    } catch (error) {
      let failure = error;
      try { flush(); } catch (flushError) { failure = flushError; }
      // A return() that queues behind a non-cooperative next() must also be bounded.
      if (iterator?.return) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const closed = await Promise.race([
          Promise.resolve().then(() => iterator!.return!()).then(result => result?.done === true, () => false),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), PROVIDER_CLEANUP_GRACE_MS); }),
        ]);
        if (timer) clearTimeout(timer);
        if (!closed) throw new EngineError('CLEANUP_UNCERTAIN', 'Provider stream cleanup could not be confirmed');
      }
      throw errorOf(failure, 'PROVIDER_ERROR', 'Provider failed while streaming a turn');
    } finally { clearInterval(flushTimer); }
  }

  private consumeOutput(owner: Owner, content: string): { content: string; truncated: boolean } {
    const available = Math.max(0, owner.run.config.limits.maxOutputBytes - owner.outputBytes - owner.childReserved.outputBytes);
    const bounded = prefixBytes(content, available);
    owner.outputBytes += Buffer.byteLength(bounded, 'utf8');
    return { content: bounded, truncated: Buffer.byteLength(content, 'utf8') > available };
  }

  private toolOutputBudget(owner: Owner): number {
    // Tool observations share the run budget with every assistant delta. Keep a
    // quarter of the configured budget (at most 4 KiB) for a final explanation.
    const availableCap = owner.run.config.limits.maxOutputBytes - owner.childReserved.outputBytes;
    const reserve = Math.min(4_096, Math.max(1, Math.floor(availableCap / 4)));
    return Math.floor(Math.max(0, availableCap - owner.outputBytes - reserve) / owner.readBatchWidth);
  }

  private toolError(owner: Owner, code: string, message: string): ToolResult {
    const budget = this.toolOutputBudget(owner);
    const encode = (limit: number) => JSON.stringify({ error: { code, message: prefixBytes(message, limit) } });
    let content = encode(2_048);
    if (Buffer.byteLength(content) > budget) {
      let low = 0;
      let high = Math.min(2_048, Buffer.byteLength(message));
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(encode(middle)) <= budget) low = middle;
        else high = middle - 1;
      }
      content = encode(low);
      if (Buffer.byteLength(content) > budget) content = [JSON.stringify({ error: code }), '{"error":true}', '{}', '0', ''].find(value => Buffer.byteLength(value) <= budget)!;
    }
    return { content, isError: true };
  }

  private setTool(owner: Owner, tool: ToolCallRecord, state: ToolCallRecord['state'], fields: Partial<Pick<ToolCallRecord, 'output' | 'error'>> = {}): void {
    Object.assign(tool, { state }, fields);
    this.options.store.commit(owner.run.id, `tool.${state}`, { toolCallId: tool.id, name: tool.name, state, ...fields }, { tool: { ...tool } });
  }

  private context(owner: Owner, record: ToolCallRecord, workspace: ToolContext['workspace'], signal: AbortSignal, allowCheckpoint: () => boolean): ToolContext {
    const context: ToolContext = {
      workspace, sessionId: owner.run.sessionId, runId: owner.run.id, toolCallId: record.id,
      signal, limits: { ...owner.run.config.limits, maxOutputBytes: this.toolOutputBudget(owner) }, artifactDir: this.options.artifactDir,
      budgets: { ...owner.budget.budgets },
      ...(owner.turn ? { turnId: owner.turn.id, ...(owner.turn.attemptId ? { attemptId: owner.turn.attemptId } : {}) } : {}),
      ...(this.options.executionLockPath ? { executionLockPath: this.options.executionLockPath } : {}),
      recordCheckpoint: (checkpoint: Checkpoint) => {
        // Cleanup may record observed effects after abort, until this operation settles.
        if (!allowCheckpoint() || owner.terminal || isTerminal(this.options.store.getRun(owner.run.id).state)) throw new EngineError('RUN_TERMINAL', 'Checkpoint is outside its active tool execution');
        if (!checkpoint.id || checkpoint.runId !== owner.run.id || checkpoint.toolCallId !== record.id || owner.checkpointIds.has(checkpoint.id)) throw new EngineError('INVALID_CHECKPOINT', 'Checkpoint identity does not match the active tool execution');
        this.options.store.commit(owner.run.id, 'workspace.changed', { checkpointId: checkpoint.id, toolCallId: record.id, kind: checkpoint.kind, incomplete: checkpoint.incomplete ?? false, warnings: checkpoint.warnings }, { checkpoint: structuredClone(checkpoint) });
        owner.checkpointIds.add(checkpoint.id);
        owner.checkpoints.set(checkpoint.id, structuredClone(checkpoint));
      },
    };
    if (record.name === 'verify_changes') this.verificationSettlementOwners.set(context, { owner, record, active: allowCheckpoint, binding: JSON.stringify([workspace.id, workspace.root, context.sessionId, context.runId, context.toolCallId, context.turnId, context.attemptId]) });
    return context;
  }

  private async toolOperation<T>(owner: Owner, record: ToolCallRecord, workspace: ToolContext['workspace'], execute: boolean, operation: (context: ToolContext) => Promise<T>, approval?: ApprovedMcpToolOwner['approval']): Promise<T> {
    const timeout = new AbortController();
    const signal = AbortSignal.any([owner.abort.signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(new EngineError('TOOL_TIMEOUT', `Tool ${record.name} exceeded its execution timeout`)), owner.run.config.limits.toolTimeoutMs);
    let active = execute;
    const context = this.context(owner, record, workspace, signal, () => active);
    if (execute) context.mcpExecutionObserver = createMcpExecutionObserver(this.options.store, executionRecords(this.options.store), {
      sessionId: owner.run.sessionId, workspaceId: workspace.id, runId: owner.run.id, toolCallId: record.id, toolName: record.name,
      ...(owner.turn ? { turnId: owner.turn.id, ...(owner.turn.attemptId ? { attemptId: owner.turn.attemptId } : {}) } : {}),
      ...(approval ? { approval } : {}),
    });
    // Command cleanup includes process-group termination and an after-image capture.
    const cleanupGraceMs = execute && ['run_command', 'verify_changes'].includes(record.name) ? 5_000 : CLEANUP_GRACE_MS;
    try { return await abortable(() => operation(context), signal, `Tool ${record.name}`, cleanupGraceMs); }
    finally { active = false; clearTimeout(timer); }
  }

  private async executeTool(owner: Owner, call: ProviderToolCall, workspace: ToolContext['workspace']): Promise<string> {
    owner.toolCount++;
    // Provider IDs belong to a conversation; durable tool rows need globally unique IDs.
    const record: ToolCallRecord = { id: owner.invocations.get(call.id) ?? randomUUID(), runId: owner.run.id, sessionId: owner.run.sessionId, name: call.name, input: call.input, state: 'requested' };
    owner.activeTools.set(record.id, record);
    this.options.store.commit(owner.run.id, 'tool.requested', { toolCallId: record.id, providerToolCallId: call.id, name: call.name, input: call.input }, { tool: record });
    let preparedFingerprint: string | undefined;
    let terminalFailure: EngineError | undefined;
    try {
      if (owner.allowedTools && !owner.allowedTools.has(call.name)) return this.toolResult(owner, record, call, this.toolError(owner, 'TOOL_NOT_ALLOWED', 'The active agent profile does not permit this tool'), 'denied');
      const tool = this.options.toolRuntime && owner.catalogue ? this.options.toolRuntime.resolve(owner.catalogue, call.name) : this.tools.get(call.name);
      if (!tool) return this.toolResult(owner, record, call, this.toolError(owner, 'UNKNOWN_TOOL', `Unknown tool: ${call.name}`));
      const originalInput = JSON.stringify(call.input), originalInputSha256 = createHash('sha256').update(originalInput).digest('hex');
      const transform = await this.lifecycle(owner, 'tool-prepare', `${record.id}:prepare`, { toolCallId: record.id, toolName: call.name,
        inputSha256: originalInputSha256, inputBytes: Buffer.byteLength(originalInput),
        ...(owner.catalogue ? { registryRevision: owner.catalogue.revision, policyVersion: owner.catalogue.policyVersion } : {}),
        ...(owner.turn ? { turnId: owner.turn.id, ...(owner.turn.attemptId ? { attemptId: owner.turn.attemptId } : {}) } : {}) });
      if (transform?.action === 'deny') return this.toolResult(owner, record, call, this.toolError(owner, 'LIFECYCLE_DENIED', 'A host lifecycle hook denied tool preparation'), 'denied');
      const effectiveInput = transform?.inputRewrite ? structuredClone(transform.inputRewrite.input) : call.input;
      const effectiveEncoded = JSON.stringify(effectiveInput), effectiveSha256 = createHash('sha256').update(effectiveEncoded).digest('hex');
      if (transform?.inputRewrite && (transform.inputRewrite.originalSha256 !== originalInputSha256 || transform.inputRewrite.effectiveSha256 !== effectiveSha256))
        throw new EngineError('LIFECYCLE_INPUT_STALE', 'Lifecycle tool transformation does not match the exact original/effective input');
      if (Buffer.byteLength(effectiveEncoded) > owner.run.config.limits.maxContextBytes) throw new EngineError('CONTEXT_LIMIT', 'Transformed tool input exceeds the original Run context limit');
      // PreparedTool is an opaque handle: tools may bind preimages to its identity.
      const prepared = await this.toolOperation(owner, record, workspace, false, (context) => {
        this.assertLive(owner);
        if (owner.lifecycle) this.options.lifecycleHooks!.assertCurrent(owner.lifecycle);
        owner.discovery?.assertCurrent();
        if (owner.catalogue) this.options.toolRuntime!.assertCatalogueCurrent(owner.catalogue);
        return tool.prepare(effectiveInput, context);
      });
      this.assertLive(owner);
      if (prepared.name !== call.name || typeof prepared.fingerprint !== 'string' || !prepared.fingerprint || typeof prepared.requiresApproval !== 'boolean' || !prepared.preview || typeof prepared.preview !== 'object' || Array.isArray(prepared.preview)) {
        throw new EngineError('INVALID_PREPARED_TOOL', 'Prepared tool identity or approval metadata is invalid');
      }
      const binding = JSON.stringify(prepared);
      const policyReceipt = this.options.toolRuntime?.getPolicyDecisionReceipt(prepared);
      if (policyReceipt) {
        const payload: JsonObject = { toolCallId: record.id, toolName: call.name, preparedFingerprint: prepared.fingerprint, receipt: JSON.parse(JSON.stringify(policyReceipt)) as JsonObject, authority: 'observation-only' };
        const refs = owner.turn ? { turnId: owner.turn.id, ...(owner.turn.attemptId ? { attemptId: owner.turn.attemptId } : {}) } : {};
        if (this.options.store.commitRunObservation) this.options.store.commitRunObservation(owner.run.id, 'tool.policy_decision', payload, refs);
        else this.options.store.commit(owner.run.id, 'tool.policy_decision', payload);
      }
      preparedFingerprint = prepared.fingerprint;
      const before = await this.lifecycle(owner, 'tool-prepared', `${record.id}:prepared`, { toolCallId: record.id, toolName: call.name, fingerprint: prepared.fingerprint, requiresApproval: prepared.requiresApproval,
        ...(owner.turn ? { turnId: owner.turn.id, ...(owner.turn.attemptId ? { attemptId: owner.turn.attemptId } : {}) } : {}), ...(tool.effectClass ? { effectClass: tool.effectClass } : {}), inputSha256: createHash('sha256').update(JSON.stringify(prepared.input)).digest('hex'), previewSha256: createHash('sha256').update(JSON.stringify(prepared.preview)).digest('hex') });
      if (JSON.stringify(prepared) !== binding) throw new EngineError('PREPARED_TOOL_CHANGED', 'Prepared request changed during the lifecycle boundary');
      if (before?.action === 'deny') return this.toolResult(owner, record, call, this.toolError(owner, 'LIFECYCLE_DENIED', 'A host lifecycle hook denied this prepared tool'), 'denied');
      if ((tool.effectClass === 'read' || (tool.effectClass === undefined && READ_TOOLS.has(call.name))) && !prepared.requiresApproval) {
        const key = `${call.name}:${this.options.toolRuntime ? this.options.toolRuntime.repeatIdentity(prepared) : prepared.fingerprint}`;
        if (owner.readonlyCalls.has(key)) throw new EngineError('REPEATED_READ_TOOL_CALL', 'This identical read was already attempted without an intervening workspace effect. Use its previous result, a continuation, a different line range, or a narrower query.');
        owner.readonlyCalls.add(key);
      }
      const effectful = tool.effectClass !== undefined && !['read', 'state'].includes(tool.effectClass) || EFFECT_TOOLS.has(call.name);
      let approval: ApprovedMcpToolOwner['approval'];
      if (owner.run.config.mode === 'plan' && (prepared.requiresApproval || effectful)) {
        return this.toolResult(owner, record, call, this.toolError(owner, 'PLAN_MODE_WRITE_BLOCKED', 'Plan mode does not allow this tool effect'), 'denied');
      }
      if (prepared.requiresApproval || (!this.options.toolRuntime && effectful)) {
        this.setTool(owner, record, 'awaiting_approval');
        this.options.store.commit(owner.run.id, 'run.awaiting_approval', { toolCallId: record.id }, { run: { state: 'awaiting_approval' } });
        const decision = await abortable(() => this.options.approvals.request({
          sessionId: owner.run.sessionId, runId: owner.run.id, toolCallId: record.id,
          toolName: prepared.name, fingerprint: prepared.fingerprint, preview: structuredClone(prepared.preview),
        }, owner.abort.signal), owner.abort.signal, 'Approval wait');
        this.assertLive(owner);
        if (![...owner.activeTools.values()].some(other => other.id !== record.id && other.state === 'awaiting_approval')) this.options.store.commit(owner.run.id, 'run.resumed', { toolCallId: record.id }, { run: { state: 'running' } });
        const current = this.options.store.getApproval(decision.id);
        const matches = (approval: typeof current) => approval.runId === owner.run.id && approval.sessionId === owner.run.sessionId && approval.toolCallId === record.id && approval.toolName === prepared.name && approval.fingerprint === prepared.fingerprint && approval.status === 'allowed';
        if (!matches(current) || !matches(decision)) {
          return this.toolResult(owner, record, call, this.toolError(owner, 'APPROVAL_DENIED', 'Tool approval was denied, expired, or did not match the prepared request'), 'denied');
        }
        approval = Object.freeze({ id: current.id, fingerprint: current.fingerprint });
      }
      this.assertLive(owner);
      if (JSON.stringify(prepared) !== binding) throw new EngineError('PREPARED_TOOL_CHANGED', 'Prepared request changed while waiting for approval');
      if (owner.lifecycle) this.options.lifecycleHooks!.assertCurrent(owner.lifecycle);
      this.setTool(owner, record, 'running');
      if (prepared.requiresApproval || effectful) owner.readonlyCalls.clear();
      const result = await this.toolOperation(owner, record, workspace, true, (context) => tool.execute(prepared as PreparedTool, context), approval);
      this.assertLive(owner);
      if (uncertain(result)) throw new EngineError('CLEANUP_UNCERTAIN', `Tool ${record.name} did not confirm cleanup`);
      if (!result || typeof result.content !== 'string') throw new EngineError('INVALID_TOOL_RESULT', 'Tool result content must be a string');
      if (result.data && typeof result.data === 'object' && !Array.isArray(result.data) && result.data.timedOut === true) {
        this.toolResult(owner, record, call, { ...result, isError: true });
        throw new EngineError('TOOL_TIMEOUT', `Tool ${record.name} reported an execution timeout`);
      }
      const content = this.toolResult(owner, record, call, result);
      if (call.name === DISCOVERY_TOOL_NAME && record.state === 'completed') owner.discovery?.commit(record.id);
      return content;
    } catch (error) {
      const deniedReceipt = this.options.toolRuntime?.getPolicyDecisionFailure(error);
      if (deniedReceipt && !owner.abort.signal.aborted) {
        const fingerprint = deniedReceipt.roleResource?.preparedFingerprint ?? deniedReceipt.commandPreflight?.preparedFingerprint;
        if (!fingerprint) throw new EngineError('INVALID_POLICY_RECEIPT', 'Owned policy failure has no producer fingerprint');
        const payload: JsonObject = { toolCallId: record.id, toolName: call.name, preparedFingerprint: fingerprint, fingerprintScope: 'producer-prepared-denied', receipt: JSON.parse(JSON.stringify(deniedReceipt)) as JsonObject, authority: 'observation-only' };
        const refs = owner.turn ? { turnId: owner.turn.id, ...(owner.turn.attemptId ? { attemptId: owner.turn.attemptId } : {}) } : {};
        if (this.options.store.commitRunObservation) this.options.store.commitRunObservation(owner.run.id, 'tool.policy_decision', payload, refs);
        else this.options.store.commit(owner.run.id, 'tool.policy_decision', payload);
      }
      const original = errorOf(error, 'TOOL_ERROR', 'Tool operation failed');
      // An effect may have happened without a durable checkpoint or released lease.
      // These gaps must stop the loop even when abort arrived at the same boundary.
      const failure = uncertain(error) && original.code !== 'CLEANUP_UNCERTAIN'
        ? new EngineError('CLEANUP_UNCERTAIN', `Tool ${record.name} effects or cleanup are unconfirmed (${original.code})`)
        : original;
      if (owner.abort.signal.aborted || failure.code.startsWith('LIFECYCLE_') || ['CLEANUP_UNCERTAIN', 'TOOL_TIMEOUT', 'CONTEXT_LIMIT', 'OUTPUT_LIMIT'].includes(failure.code)) {
        terminalFailure = failure;
        if (!['completed', 'failed', 'denied', 'interrupted'].includes(record.state)) this.setTool(owner, record, 'interrupted', { error: prefixBytes(failure.message, 2_048) });
        throw failure;
      }
      // Input errors, denied permissions, and ordinary tool failures let the model adapt.
      return this.toolResult(owner, record, call, this.toolError(owner, failure.code, failure.message), deniedReceipt ? 'denied' : undefined);
    } finally {
      owner.discovery?.discard(record.id);
      if (this.options.onToolCheckpoint) {
        const checkpoints = [...owner.checkpoints.values()].filter(checkpoint => checkpoint.toolCallId === record.id);
        if (checkpoints.length) {
          try {
            await abortable(() => Promise.resolve(this.options.onToolCheckpoint!({ workspace: structuredClone(workspace), run: structuredClone(this.options.store.getRun(owner.run.id)), toolCallId: record.id,
              ...(owner.turn ? { turnId: owner.turn.id, ...(owner.turn.attemptId ? { attemptId: owner.turn.attemptId } : {}) } : {}), checkpoints: structuredClone(checkpoints), signal: owner.abort.signal })), AbortSignal.timeout(2_000), 'Workspace checkpoint observation');
          } catch {
            // Observer/LSP delivery is metadata. Durable checkpoint ownership and
            // the tool's real effect/cleanup result remain authoritative.
            try { this.options.store.commit(owner.run.id, 'workspace.observation_failed', { toolCallId: record.id, checkpointIds: checkpoints.map(checkpoint => checkpoint.id) }); } catch { /* Preserve an existing tool failure. */ }
          }
        }
      }
      try {
        if (!owner.abort.signal.aborted && ['completed', 'failed', 'denied', 'interrupted'].includes(record.state)) {
          try { await this.lifecycle(owner, 'tool-settled', `${record.id}:settled`, { toolCallId: record.id, toolName: record.name, outcome: record.state as 'completed' | 'failed' | 'denied' | 'interrupted', outputBytes: Buffer.byteLength(record.output ?? ''),
            ...(preparedFingerprint ? { fingerprint: preparedFingerprint } : {}), ...(owner.turn ? { turnId: owner.turn.id, ...(owner.turn.attemptId ? { attemptId: owner.turn.attemptId } : {}) } : {}) }, !terminalFailure); }
          catch (error) { if (!terminalFailure) throw error; }
        }
      } finally { owner.activeTools.delete(record.id); }
    }
  }

  private toolResult(owner: Owner, record: ToolCallRecord, call: ProviderToolCall, result: ToolResult, state?: 'denied'): string {
    this.assertLive(owner);
    const structured = result.structuredResult ? validateToolResultEnvelope(result.structuredResult) : undefined;
    if (structured?.artifactRefs.length) {
      const identity = { sessionId: owner.run.sessionId, runId: owner.run.id, toolCallId: record.id,
        ...(owner.turn ? { turnId: owner.turn.id, ...(owner.turn.attemptId ? { attemptId: owner.turn.attemptId } : {}) } : {}) };
      const checkpoints = [...owner.checkpoints.values()].filter(checkpoint => checkpoint.toolCallId === record.id);
      try {
        if (structured.artifactRefs.length > 32 || structured.artifactRefs.some(ref => Object.keys(identity).some(key => ref.identity[key as keyof typeof ref.identity] !== identity[key as keyof typeof identity]) || Object.keys(ref.identity).some(key => ref.identity[key as keyof typeof ref.identity] !== identity[key as keyof typeof identity]))) throw new EngineError('CHECKPOINT_ARTIFACT_MISMATCH', 'Tool artifacts must match the active execution identity');
        const bindings = checkpoints.map(checkpoint => bindCheckpointArtifacts(checkpoint, identity, structured.artifactRefs));
        for (const binding of bindings) this.options.store.commit(owner.run.id, 'checkpoint.artifacts', {
          ...binding, artifacts: structured.artifactRefs.map(ref => ({ artifactId: ref.id, sha256: ref.sha256, complete: ref.complete, outcome: ref.outcome })),
        });
      } catch (error) {
        if (checkpoints.some(checkpoint => checkpoint.incomplete)) throw new EngineError('CLEANUP_UNCERTAIN', 'Incomplete workspace effects remain unconfirmed after artifact binding failed');
        throw error;
      }
    }
    const output = this.consumeOutput(owner, structured?.modelContent ?? result.content);
    const finalState = state ?? (result.isError || output.truncated ? 'failed' : 'completed');
    const message = this.message(owner, 'tool', output.content);
    message.toolCallId = call.id;
    if (structured) message.toolResult = { artifactRefs: structuredClone(structured.artifactRefs), warnings: [...structured.warnings], outcome: structured.outcome };
    record.state = finalState;
    record.output = output.content;
    if (result.isError || output.truncated) record.error = output.truncated ? 'Tool output exceeded the run output budget' : prefixBytes(result.content, 2_048);
    const payload: JsonObject = {
      toolCallId: record.id, providerToolCallId: call.id, name: call.name,
      output: output.content, isError: result.isError ?? false, truncated: output.truncated,
    };
    if (structured) {
      const normalized = { ...structured, modelContent: output.content };
      if (Buffer.byteLength(JSON.stringify(normalized)) <= owner.run.config.limits.maxContextBytes) payload.structuredResult = JSON.parse(JSON.stringify(normalized)) as JsonObject;
      else payload.structuredResultOmitted = true;
      payload.artifactRefs = JSON.parse(JSON.stringify(structured.artifactRefs.slice(0, 32))) as JsonValue;
    }
    // Content is the model handoff; retain only bounded metadata in the journal.
    if (result.artifacts) payload.artifacts = result.artifacts.slice(0, 32).map(({ path, bytes, truncated }) => ({ path: prefixBytes(path, 4_096), bytes, truncated }));
    if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
      const data = result.data as JsonObject;
      if (typeof data.cleanupConfirmed === 'boolean') payload.cleanupConfirmed = data.cleanupConfirmed;
      if (typeof data.cleanupUncertain === 'boolean') payload.cleanupUncertain = data.cleanupUncertain;
      if (typeof data.timedOut === 'boolean') payload.timedOut = data.timedOut;
    }
    this.options.store.commit(owner.run.id, `tool.${finalState}`, payload, { tool: { ...record }, message });
    owner.turn?.toolResult(record.id, { output: output.content, isError: result.isError ?? false, truncated: output.truncated }, finalState !== 'completed');
    if (output.truncated) throw new EngineError('OUTPUT_LIMIT', 'Run output byte budget was exceeded');
    return output.content;
  }
}
