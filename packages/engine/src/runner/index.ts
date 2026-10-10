import type { EffectBatchExecution } from '../effect-batches/host.js';
import {ProviderAudioCapture} from '../media/output.js';
import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { isAbsolute, relative, sep } from 'node:path';
import {
  EngineError, isTerminal,
  type Checkpoint, type JsonObject, type JsonValue, type Message, type ProviderReplay, type ProviderToolCall,
  type Run, type RunReceipt, type RunState, type SubmitInput, type ToolCallRecord,
} from '@moodcode/contracts';
import type {
  CoordinatorOptions, CoordinatorPort, PreparedTool, ProviderAdapter, ProviderEvent,
  ProviderMessage, ToolContext, ToolDefinition, ToolResult,
  ChildRunReservation, RunUsage, LifecycleContinuationCapture, TurnRequest, ProviderRequestOwner,
} from '../ports.js';
import type { BackendClientReadInput, BackendClientReadProof, BackendClientEffectInput, BackendClientPermissionProof } from '../agent-backends/client-effects.js';
import { codeJson, CODE_MODE_TOOLS, codeModeError } from '../code-mode/types.js';
import { immutableKnowledgeJson, knowledgeHash } from '../knowledge/validation.js';
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

const CLEANUP_GRACE_MS = 1_000;
// Closing the owned generator can join a pending wait, then the adapter's
// separate one-second return deadline and its durable settlement.
const PROVIDER_CLEANUP_GRACE_MS = CLEANUP_GRACE_MS * 3;
const EFFECT_TOOLS = new Set(['apply_patch', 'run_command']);
const READ_TOOLS = new Set(['list_files', 'read_file', 'search_files']);
const UNSAFE_EFFECT_ERRORS = new Set([
  'CLEANUP_UNCERTAIN', 'PROCESS_CLEANUP_FAILED', 'COMMAND_CLEANUP_UNCERTAIN',
  'COMMAND_EFFECTS_LOCK_FAILED', 'PATCH_CHECKPOINT_FAILED', 'PATCH_CLEANUP_UNCERTAIN',
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
  interruptedWindowsCommands?: ToolCallRecord[];
  interruptedCodeModeTools?: ToolCallRecord[];
  readBatchWidth: number;
  effectOutputShare?:number;
  effectArtifactShare?:number;
  effectOutputBase?:number;
  effectOutputReservation?:number;
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

interface TeamToolContextCapture {
  owner: Owner;
  record: ToolCallRecord;
  active: () => boolean;
  phase: 'prepare' | 'execute';
  binding: string;
  signal: AbortSignal;
  approval?: ApprovedMcpToolOwner['approval'];
}

interface OriginalProviderRequest {
  readonly owner: Owner;
  readonly proof: ProviderRequestOwner;
  readonly signal: AbortSignal;
  pendingRead: boolean;
}
interface ClientReadCapture {
  record?: ToolCallRecord;
  result?: ToolResult;
  fingerprint?: string;
  signal?: AbortSignal;
  gate?: () => Promise<void>;
  dispatched?:()=>void;
  approved?: (approval?: ApprovedMcpToolOwner['approval']) => void;
}

/** Preserve request insertion order without evaluating adapter-added serializers or accessors. */
function originalRequestSha256(value: TurnRequest, maxBytes: number): string {
  let nodes = 0, bytes = 0;
  const ancestors = new Set<object>();
  function invalid(): never { throw new EngineError('BACKEND_REQUEST_OWNER_STALE', 'The original request must retain ordinary bounded JSON data'); }
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > 32768 || depth > 32) invalid();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item)) invalid(); return item; }
    if (typeof item === 'string') { bytes += Buffer.byteLength(item); if (bytes > maxBytes || Buffer.from(item).toString('utf8') !== item) invalid(); return item; }
    if (!item || typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) invalid();
    const object = item as object, prototype = Object.getPrototypeOf(object), descriptors = Object.getOwnPropertyDescriptors(object);
    if (Array.isArray(object) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
    ancestors.add(object);
    try {
      if (Array.isArray(object)) {
        const length = descriptors.length?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > 4096 || Reflect.ownKeys(descriptors).length !== length + 1) invalid();
        const result: unknown[] = []; Object.setPrototypeOf(result, null);
        for (let index = 0; index < length; index++) { const descriptor = descriptors[String(index)]; if (!descriptor?.enumerable || !('value' in descriptor)) invalid(); result[index] = copy(descriptor.value, depth + 1); }
        return result;
      }
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') invalid(); const descriptor = descriptors[key as string]!;
        if (!descriptor.enumerable || !('value' in descriptor)) invalid(); bytes += Buffer.byteLength(key as string); if (bytes > maxBytes) invalid();
        result[key as string] = copy(descriptor.value, depth + 1);
      }
      return result;
    } finally { ancestors.delete(object); }
  };
  const encoded = JSON.stringify(copy(value, 0));
  if (Buffer.byteLength(encoded) > maxBytes) invalid(); return createHash('sha256').update(encoded).digest('hex');
}

interface WorkspaceLease { commandRunId?:string;
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
  private readonly teamToolContexts = new WeakMap<ToolContext, TeamToolContextCapture>();
  private readonly codeModeContexts = new WeakMap<ToolContext,{owner:Owner;record:ToolCallRecord;phase:'prepare'|'execute';active:()=>boolean;binding:string;signal:AbortSignal;approval?:ApprovedMcpToolOwner['approval']}>();
  private readonly codeModeNested = new Map<string,{outer:ToolContext;signal:AbortSignal;deadline:number;assertCurrent:()=>void}>();
  private readonly commandJobContexts = new WeakMap<ToolContext, { owner: Owner; record: ToolCallRecord; active: () => boolean; binding: string; signal: AbortSignal; approval?: ApprovedMcpToolOwner['approval'] }>();
  private readonly providerRequests = new WeakMap<TurnRequest, OriginalProviderRequest>();
  private readonly clientReadCompletions = new WeakMap<object, BackendClientReadProof>();
  private readonly retainedClientReads = new Set<object>();
  private readonly clientEffectHandles = new WeakMap<object, {request:TurnRequest;input:BackendClientEffectInput;proof:BackendClientPermissionProof;dispatch:()=>void;abort:AbortController;done:Promise<object>;started:Promise<void>;dispatched:boolean;completion:()=>BackendClientReadProof|undefined;}>();
  private readonly clientReadCaptures = new Map<string, ClientReadCapture>();
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

  /** Current native state paired with the original configuration of this actual owner. */
  getOwnedActiveRun(runId: string): Run {
    const owner = this.owners.get(runId);
    if (!owner) throw new EngineError('PARENT_RUN_NOT_ACTIVE', 'Run requires its original active coordinator owner');
    this.assertLive(owner);
    const current = this.options.store.getRun(runId);
    if (current.sessionId !== owner.run.sessionId || current.workspaceId !== owner.run.workspaceId || JSON.stringify(current.config) !== JSON.stringify(owner.run.config) || current.prompt !== owner.run.prompt) throw new EngineError('RUN_OWNER_STALE', 'Native Run changed after original admission');
    return structuredClone({ ...owner.run, state: current.state });
  }

  private originalProviderRequest(request: TurnRequest, phase: 'dispatch' | 'observe'): OriginalProviderRequest {
    if (!request || typeof request !== 'object' || types.isProxy(request)) throw new EngineError('BACKEND_ORIGINAL_REQUEST_REQUIRED', 'A backend requires the original native provider request');
    const captured = this.providerRequests.get(request);
    if (!captured) throw new EngineError('BACKEND_ORIGINAL_REQUEST_REQUIRED', 'The provider request is outside its actual Attempt lifetime');
    const { owner, proof } = captured, records = executionRecords(this.options.store);
    const current = this.options.store.getRun(proof.runId);
    const attempt = records?.getAttempt(proof.attemptId), turn = records?.getTurn(proof.turnId), cleanup = records?.getAttemptCleanup?.(proof.attemptId, proof.sessionId);
    if (!records || this.owners.get(proof.runId) !== owner || owner.turn?.id !== proof.turnId || owner.turn.attemptId !== proof.attemptId
      || current.workspaceId !== proof.workspaceId || current.sessionId !== proof.sessionId || knowledgeHash(current.config) !== proof.configSha256
      || originalRequestSha256(request, owner.run.config.limits.maxContextBytes + 65536) !== proof.requestSha256
      || !attempt || attempt.runId !== proof.runId || attempt.sessionId !== proof.sessionId || attempt.turnId !== proof.turnId || attempt.providerId !== proof.providerId || attempt.modelId !== proof.modelId
      || !turn || turn.runId !== proof.runId || turn.sessionId !== proof.sessionId || !cleanup || cleanup.requestSha256 !== proof.requestSha256
      || knowledgeHash(owner.catalogue ?? request.tools) !== proof.catalogueSha256) throw new EngineError('BACKEND_REQUEST_OWNER_STALE', 'The backend request differs from its actual native owner');
    if (phase === 'dispatch') {
      this.assertLive(owner);
      if (captured.signal.aborted) throw captured.signal.reason ?? new EngineError('RUN_CANCELLED', 'The provider Attempt was cancelled');
      if (!['dispatched', 'streaming'].includes(attempt.state) || !['created', 'streaming'].includes(turn.state)) throw new EngineError('BACKEND_REQUEST_OWNER_STALE', 'New backend effects require the currently dispatched Attempt');
      if (owner.catalogue) this.options.toolRuntime!.assertCatalogueCurrent(owner.catalogue);
      owner.discovery?.assertCurrent();
      if (owner.lifecycle) this.options.lifecycleHooks!.assertCurrent(owner.lifecycle);
    }
    return captured;
  }

  readProviderRequestOwner(request: TurnRequest): ProviderRequestOwner {
    return structuredClone(this.originalProviderRequest(request, 'observe').proof);
  }

  assertProviderRequest(request: TurnRequest, phase: 'dispatch' | 'observe'): void {
    this.originalProviderRequest(request, phase);
  }

  /** One client read executes inside the still-open original provider Attempt. */
  async executeProviderClientRead(request: TurnRequest, value: BackendClientReadInput, signal: AbortSignal): Promise<object> {
    const captured = this.originalProviderRequest(request, 'dispatch'), { owner, proof } = captured;
    const input = immutableKnowledgeJson(value);
    if (Object.keys(input).some(key => !['callId', 'path', 'line', 'limit'].includes(key)) || typeof input.callId !== 'string' || !input.callId || Buffer.byteLength(input.callId) > 256
      || typeof input.path !== 'string' || !isAbsolute(input.path) || Buffer.byteLength(input.path) > 4096 || input.path.includes('\0')
      || input.line !== undefined && (!Number.isSafeInteger(input.line) || input.line < 1)
      || input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 2000)) throw new EngineError('BACKEND_CLIENT_READ_INVALID', 'The client read must have an explicit absolute path and bounded line range');
    if (signal.aborted) throw signal.reason ?? new EngineError('RUN_CANCELLED', 'Client read was cancelled');
    if (captured.pendingRead || owner.callIds.has(input.callId)) throw new EngineError('BACKEND_CLIENT_READ_CONFLICT', 'Client reads must be serialized with distinct request identities');
    if (this.retainedClientReads.size >= 128) throw new EngineError('BACKEND_CLIENT_READ_LIMIT', 'Client read completion handle limit was reached');
    const startLine = input.line ?? 1, endLine = input.limit === undefined ? undefined : startLine + input.limit - 1;
    if (endLine !== undefined && !Number.isSafeInteger(endLine)) throw new EngineError('BACKEND_CLIENT_READ_INVALID', 'Client line range exceeds its integer bound');
    const workspace = this.options.store.getWorkspace(proof.workspaceId), localPath = relative(workspace.root, input.path).split(sep).join('/');
    if (!localPath || localPath === '..' || localPath.startsWith('../') || isAbsolute(localPath)) throw new EngineError('BACKEND_CLIENT_READ_OUTSIDE', 'Client reads must remain inside the actual workspace');
    if (this.remainingChildBudget(owner).toolCalls < 1) throw new EngineError('TOOL_CALL_LIMIT', 'The original Run tool budget is exhausted');
    owner.budget.reserveToolCalls(1);
    const toolCallId = randomUUID(), message = this.message(owner, 'assistant');
    const call: ProviderToolCall = { id: input.callId, name: 'read_file', input: { path: localPath, startLine, ...(endLine === undefined ? {} : { endLine }) } };
    owner.callIds.add(call.id); owner.invocations.set(call.id, toolCallId);
    this.options.store.commit(owner.run.id, 'backend.client_read_proposed', { toolCallId, providerToolCallId: call.id, turnId: proof.turnId, attemptId: proof.attemptId }, { message });
    owner.turn!.toolProposal(message.id, toolCallId, call);
    const readCapture: ClientReadCapture = {};
    this.clientReadCaptures.set(toolCallId, readCapture); captured.pendingRead = true;
    const abort = () => owner.abort.abort(new EngineError('RUN_CANCELLED', 'The original backend client read was cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    let failure: unknown;
    try { this.originalProviderRequest(request, 'dispatch'); await this.executeTool(owner, call, workspace); }
    catch (error) { failure = error; }
    finally { signal.removeEventListener('abort', abort); captured.pendingRead = false; this.clientReadCaptures.delete(toolCallId); }
    const record = readCapture.record;
    if (!record) throw failure ?? new EngineError('BACKEND_CLIENT_READ_FAILED', 'The native client read was not admitted');
    const data = readCapture.result?.data;
    const complete = record.state === 'completed' && data !== null && typeof data === 'object' && !Array.isArray(data) && typeof data.content === 'string' && Buffer.byteLength(data.content) <= 24576
      && data.truncated === false && data.outputTruncated === false && data.hasMore === false && data.partialFirstLine === false && data.partialLastLine === false;
    const errorCode = failure instanceof EngineError ? failure.code : failure ? 'BACKEND_CLIENT_READ_FAILED'
      : record.state === 'denied' ? 'APPROVAL_DENIED' : record.state !== 'completed' ? 'BACKEND_CLIENT_READ_FAILED' : !complete ? 'BACKEND_CLIENT_READ_PARTIAL' : null;
    const resultBody = { workspaceId: proof.workspaceId, sessionId: proof.sessionId, runId: proof.runId, turnId: proof.turnId, attemptId: proof.attemptId,
      toolCallId, providerToolCallId: call.id, preparedFingerprint: readCapture.fingerprint ?? null,
      state: (['completed', 'failed', 'denied', 'interrupted'].includes(record.state) ? record.state : 'interrupted') as BackendClientReadProof['state'],
      inputSha256: knowledgeHash(record.input), outputSha256: createHash('sha256').update(record.output ?? '').digest('hex'), outputBytes: Buffer.byteLength(record.output ?? ''),
      content: complete ? (data as JsonObject).content as string : null, errorCode,
      cleanupConfirmed: !uncertain(failure) && !['CLEANUP_UNCERTAIN', 'TOOL_TIMEOUT'].includes(errorCode ?? '') };
    const completion: BackendClientReadProof = immutableKnowledgeJson({ ...resultBody, sha256: knowledgeHash(resultBody) });
    const original = Object.freeze({}); this.clientReadCompletions.set(original, completion); this.retainedClientReads.add(original);
    return original;
  }

  /** Approval waits in the genuine tool pipeline; an allow-once wire response cannot execute another input. */
  async prepareProviderClientEffect(
    request: TurnRequest,
    value: BackendClientEffectInput,
    signal: AbortSignal,
  ): Promise<object> {
    const captured = this.originalProviderRequest(request, 'dispatch'),
      { owner, proof } = captured;
    const input = immutableKnowledgeJson(value),
      workspace = this.options.store.getWorkspace(proof.workspaceId);
    if (signal.aborted) throw signal.reason;
    if (captured.pendingRead || owner.callIds.has(input.callId))
      throw new EngineError(
        'BACKEND_CLIENT_EFFECT_CONFLICT',
        'Only one exact native client effect may be active',
      );
    if (this.retainedClientReads.size >= 128)
      throw new EngineError(
        'BACKEND_CLIENT_READ_LIMIT',
        'Client completion retention limit reached',
      );
    let toolInput: JsonObject, name: string;
    if (input.method === 'fs/write_text_file') {
      if (
        Object.keys(input).some(
          (key) => !['callId', 'method', 'path', 'content'].includes(key),
        ) ||
        typeof input.content !== 'string' ||
        Buffer.byteLength(input.content) > 16384 ||
        !isAbsolute(input.path)
      )
        throw new EngineError(
          'BACKEND_CLIENT_EFFECT_INVALID',
          'Invalid bounded client write',
        );
      const local = relative(workspace.root, input.path).split(sep).join('/');
      if (
        !local ||
        local === '..' ||
        local.startsWith('../') ||
        isAbsolute(local)
      )
        throw new EngineError(
          'BACKEND_CLIENT_READ_OUTSIDE',
          'Client effects stay inside the workspace',
        );
      let at = dirname(input.path);
      while (true) {
        try {
          const canonical = await realpath(at);
          const rel = relative(workspace.root, canonical);
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
            throw new EngineError(
              'PATH_OUTSIDE_WORKSPACE',
              'Client write parent escaped the workspace',
            );
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const parent = dirname(at);
          if (parent === at) throw error;
          at = parent;
        }
      }
      let expectedHash: string | null = null;
      try {
        const stat = await lstat(input.path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size > 1048576
        )
          throw new EngineError(
            'UNSAFE_PATCH_PATH',
            'Client write requires a bounded regular source',
          );
        const source = await open(
          input.path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const opened = await source.stat();
          if (
            !opened.isFile() ||
            opened.nlink !== 1 ||
            opened.dev !== stat.dev ||
            opened.ino !== stat.ino ||
            opened.size !== stat.size ||
            opened.size > 1048576
          )
            throw new EngineError(
              'UNSAFE_PATCH_PATH',
              'The bounded source was replaced before descriptor capture',
            );
          const bytes = Buffer.alloc(1048577);
          let position = 0;
          while (position < bytes.length) {
            const read = await source.read(
              bytes,
              position,
              bytes.length - position,
              position,
            );
            if (read.bytesRead === 0) break;
            position += read.bytesRead;
          }
          const after = await source.stat();
          if (
            position > 1048576 ||
            after.size !== opened.size ||
            after.mtimeMs !== opened.mtimeMs ||
            after.ctimeMs !== opened.ctimeMs ||
            position !== after.size
          )
            throw new EngineError(
              'UNSAFE_PATCH_PATH',
              'The bounded source changed during capture',
            );
          expectedHash = createHash('sha256')
            .update(bytes.subarray(0, position))
            .digest('hex');
        } finally {
          try {
            await source.close();
          } catch {
            throw new EngineError(
              'CLEANUP_UNCERTAIN',
              'The source capture descriptor did not confirm closure',
            );
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      name = 'apply_patch';
      toolInput = {
        changes: [{ path: local, expectedHash, content: input.content }],
      };
    } else if (input.method === 'terminal/create') {
      if (process.platform === 'win32')
        throw new EngineError(
          'COMMAND_PLATFORM_UNSUPPORTED',
          'ACP terminals require the native POSIX command owner',
        );
      if (
        Object.keys(input).some(
          (key) =>
            ![
              'callId',
              'method',
              'command',
              'args',
              'cwd',
              'outputByteLimit',
            ].includes(key),
        ) ||
        !Array.isArray(input.args) ||
        input.args.length > 64 ||
        input.args.some(
          (arg) => typeof arg !== 'string' || arg.includes('\0'),
        ) ||
        !isAbsolute(input.cwd) ||
        !Number.isSafeInteger(input.outputByteLimit) ||
        input.outputByteLimit < 1 ||
        input.outputByteLimit > 16384
      )
        throw new EngineError(
          'BACKEND_CLIENT_EFFECT_INVALID',
          'Invalid exact terminal input',
        );
      const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
      name = 'run_command';
      toolInput = {
        command: input.args.length
          ? [input.command, ...input.args].map(quote).join(' ')
          : input.command,
        cwd: input.cwd,
        timeoutMs: Math.min(owner.run.config.limits.toolTimeoutMs, 300000),
      };
    } else
      throw new EngineError(
        'ACP_EFFECT_UNSUPPORTED',
        'Unsupported client effect',
      );
    if (!request.tools.some((tool) => tool.name === name))
      throw new EngineError(
        'TOOL_NOT_ALLOWED',
        'The original catalogue does not contain this effect',
      );
    this.originalProviderRequest(request, 'dispatch');
    if (this.remainingChildBudget(owner).toolCalls < 1)
      throw new EngineError(
        'TOOL_CALL_LIMIT',
        'The original Run tool budget is exhausted',
      );
    owner.budget.reserveToolCalls(1);
    const toolCallId = randomUUID(),
      call: ProviderToolCall = { id: input.callId, name, input: toolInput },
      message = this.message(owner, 'assistant');
    owner.callIds.add(call.id);
    owner.invocations.set(call.id, toolCallId);
    this.options.store.commit(
      owner.run.id,
      'backend.client_effect_proposed',
      {
        toolCallId,
        providerToolCallId: call.id,
        effectMethod: input.method,
        input: input as unknown as JsonValue,
        turnId: proof.turnId,
        attemptId: proof.attemptId,
      },
      { message },
    );
    owner.turn!.toolProposal(message.id, toolCallId, call);
    this.options.store.commitRunObservation?.(
      owner.run.id,
      'backend.client_effect_proposed',
      {
        toolCallId,
        providerToolCallId: call.id,
        effectMethod: input.method,
        input: input as unknown as JsonValue,
        turnId: proof.turnId,
        attemptId: proof.attemptId,
      },
      { turnId: proof.turnId, attemptId: proof.attemptId },
    );
    const abort = new AbortController(),
      effectSignal = AbortSignal.any([signal, abort.signal]);
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      admitted = new Promise<void>((resolve) => (ready = resolve));
    let actualStart!: () => void;
    const started = new Promise<void>((resolve) => (actualStart = resolve));
    let permission: BackendClientPermissionProof | undefined;
    let terminalCompletion: BackendClientReadProof | undefined;
    const capture: ClientReadCapture = {
      signal: effectSignal,
      dispatched: actualStart,
      gate: async () => {
        await new Promise<void>((resolve, reject) => {
          const cancel = () => reject(effectSignal.reason);
          if (effectSignal.aborted) return cancel();
          effectSignal.addEventListener('abort', cancel, { once: true });
          void gate.then(() => {
            effectSignal.removeEventListener('abort', cancel);
            resolve();
          });
        });
        checkAbort(effectSignal);
        this.originalProviderRequest(request, 'dispatch');
      },
      approved: (approval) => {
        const body = {
          workspaceId: proof.workspaceId,
          sessionId: proof.sessionId,
          runId: proof.runId,
          turnId: proof.turnId,
          attemptId: proof.attemptId,
          toolCallId,
          providerToolCallId: call.id,
          inputSha256: knowledgeHash(toolInput),
          preparedFingerprint: capture.fingerprint ?? null,
          approvalId: approval?.id ?? null,
          allowed: true,
        };
        const granted: BackendClientPermissionProof = immutableKnowledgeJson({
          ...body,
          sha256: knowledgeHash(body),
        });
        if (!this.options.store.commitRunObservation)
          throw new EngineError(
            'BACKEND_NATIVE_OBSERVATION_REQUIRED',
            'Native permission journal is required',
          );
        this.options.store.commitRunObservation(
          owner.run.id,
          'backend.client_permission',
          { permission: granted as unknown as JsonValue },
          { turnId: proof.turnId, attemptId: proof.attemptId },
        );
        permission = granted;
        ready();
      },
    };
    this.clientReadCaptures.set(toolCallId, capture);
    captured.pendingRead = true;
    const done = (async () => {
      let failure: unknown;
      try {
        await this.executeTool(owner, call, workspace);
      } catch (error) {
        failure = error;
      } finally {
        captured.pendingRead = false;
        this.clientReadCaptures.delete(toolCallId);
      }
      const record = capture.record;
      if (!record)
        throw (
          failure ??
          new EngineError(
            'BACKEND_CLIENT_EFFECT_FAILED',
            'Native effect was not admitted',
          )
        );
      if (!permission) {
        const body = {
          workspaceId: proof.workspaceId,
          sessionId: proof.sessionId,
          runId: proof.runId,
          turnId: proof.turnId,
          attemptId: proof.attemptId,
          toolCallId,
          providerToolCallId: call.id,
          inputSha256: knowledgeHash(record.input),
          preparedFingerprint: capture.fingerprint ?? null,
          approvalId: null,
          allowed: false,
        };
        const denied: BackendClientPermissionProof = immutableKnowledgeJson({
          ...body,
          sha256: knowledgeHash(body),
        });
        this.options.store.commitRunObservation?.(
          owner.run.id,
          'backend.client_permission',
          { permission: denied as unknown as JsonValue },
          { turnId: proof.turnId, attemptId: proof.attemptId },
        );
        permission = denied;
        ready();
      }
      let result: JsonValue | null = null;
      try {
        if (capture.result?.data !== undefined) {
          let data = immutableKnowledgeJson(capture.result.data);
          if (
            input.method === 'terminal/create' &&
            data &&
            typeof data === 'object' &&
            !Array.isArray(data)
          )
            data = immutableKnowledgeJson(
              Object.fromEntries(
                Object.entries(data).filter(([key]) =>
                  [
                    'status',
                    'exitCode',
                    'signal',
                    'cancelled',
                    'timedOut',
                    'cleanupConfirmed',
                    'started',
                    'checkpointId',
                    'checkpointIncomplete',
                    'outputAccountingComplete',
                    'error',
                  ].includes(key),
                ),
              ),
            );
          if (Buffer.byteLength(JSON.stringify(data)) <= 24576) result = data;
        }
      } catch {
        result = null;
      }
      const errorCode =
        failure instanceof EngineError
          ? failure.code
          : failure
            ? 'BACKEND_CLIENT_EFFECT_FAILED'
            : record.state === 'denied'
              ? 'APPROVAL_DENIED'
              : record.state !== 'completed'
                ? 'BACKEND_CLIENT_EFFECT_FAILED'
                : result === null
                  ? 'BACKEND_CLIENT_EFFECT_LIMIT'
                  : null;
      const actualCheckpoint = [...owner.checkpoints.values()].find(
        (cp) => cp.toolCallId === toolCallId,
      );
      const body = {
        checkpoint: actualCheckpoint
          ? { id: actualCheckpoint.id, sha256: knowledgeHash(actualCheckpoint) }
          : null,
        workspaceId: proof.workspaceId,
        sessionId: proof.sessionId,
        runId: proof.runId,
        turnId: proof.turnId,
        attemptId: proof.attemptId,
        toolCallId,
        providerToolCallId: call.id,
        preparedFingerprint: capture.fingerprint ?? null,
        state: (['completed', 'failed', 'denied', 'interrupted'].includes(
          record.state,
        )
          ? record.state
          : 'interrupted') as BackendClientReadProof['state'],
        inputSha256: knowledgeHash(record.input),
        outputSha256: createHash('sha256')
          .update(record.output ?? '')
          .digest('hex'),
        outputBytes: Buffer.byteLength(record.output ?? ''),
        content: null,
        errorCode,
        cleanupConfirmed:
          !uncertain(failure) &&
          (!result ||
            typeof result !== 'object' ||
            Array.isArray(result) ||
            result.cleanupConfirmed !== false),
        effectMethod: input.method,
        result,
      };
      const completion: BackendClientReadProof = immutableKnowledgeJson({
        ...body,
        sha256: knowledgeHash(body),
      });
      if (!this.options.store.commitRunObservation)
        throw new EngineError(
          'BACKEND_NATIVE_OBSERVATION_REQUIRED',
          'Client effects require a native completion anchor',
        );
      this.options.store.commitRunObservation(
        owner.run.id,
        'backend.client_effect_closed',
        { completion: completion as unknown as JsonValue },
        { turnId: proof.turnId, attemptId: proof.attemptId },
      );
      terminalCompletion = completion;
      const original = Object.freeze({});
      this.clientReadCompletions.set(original, completion);
      this.retainedClientReads.add(original);
      return original;
    })().finally(ready);
    // Rejection remains observable to waitEffect.
    void done.catch(() => {});
    await admitted;
    if (!permission) {
      await done;
      throw new EngineError(
        'BACKEND_CLIENT_EFFECT_FAILED',
        'Native preparation failed',
      );
    }
    const original = Object.freeze({});
    this.clientEffectHandles.set(original, {
      request,
      input,
      proof: permission,
      dispatch: release,
      abort,
      done,
      started,
      dispatched: false,
      completion: () => terminalCompletion,
    });
    return original;
  }
  readProviderClientEffectPermission(
    original: object,
  ): BackendClientPermissionProof {
    const x = this.clientEffectHandles.get(original);
    if (!x)
      throw new EngineError(
        'BACKEND_ORIGINAL_REQUIRED',
        'Original prepared effect is required',
      );
    return structuredClone(x.proof);
  }
  async dispatchProviderClientEffect(original: object): Promise<void> {
    const x = this.clientEffectHandles.get(original);
    if (!x || x.dispatched || !x.proof.allowed)
      throw new EngineError(
        'BACKEND_EFFECT_STALE',
        'The precise native effect cannot be dispatched',
      );
    this.originalProviderRequest(x.request, 'dispatch');
    x.dispatched = true;
    x.dispatch();
    await Promise.race([
      x.started,
      x.done.then(() => {
        throw new EngineError(
          'BACKEND_CLIENT_EFFECT_FAILED',
          'Native effect failed before dispatch',
        );
      }),
    ]);
  }
  readProviderClientEffectRequest(original: object): TurnRequest {
    const x = this.clientEffectHandles.get(original);
    if (!x)
      throw new EngineError(
        'BACKEND_ORIGINAL_REQUIRED',
        'Original effect is required',
      );
    this.originalProviderRequest(x.request, 'dispatch');
    return x.request;
  }
  readProviderClientEffectScope(original: object) {
    const x = this.clientEffectHandles.get(original);
    if (!x || !x.dispatched || x.input.method !== 'terminal/create')
      throw new EngineError(
        'BACKEND_ORIGINAL_REQUIRED',
        'Only the original admitted terminal has output authority',
      );
    this.originalProviderRequest(x.request, 'dispatch');
    const completion = x.completion(), result = completion?.result;
    // The same actual settled Tool proves cancellation before a physical source existed.
    const noProcessCompletionSha256 =
      x.abort.signal.aborted && completion?.state === 'failed' &&
      completion.effectMethod === 'terminal/create' &&
      completion.cleanupConfirmed === true && completion.content === null &&
      completion.checkpoint === null && result &&
      typeof result === 'object' && !Array.isArray(result) &&
      result.status === 'cancelled' && result.started === false &&
      result.cancelled === true && result.timedOut === false &&
      result.cleanupConfirmed === true && result.exitCode === null &&
      result.signal === null ? completion.sha256 : null;
    return {
      permission: structuredClone(x.proof),
      input: structuredClone(x.input),
      noProcessCompletionSha256,
    };
  }
  waitProviderClientEffect(original: object): Promise<object> {
    const x = this.clientEffectHandles.get(original);
    if (!x)
      throw new EngineError(
        'BACKEND_ORIGINAL_REQUIRED',
        'Original effect is required',
      );
    return x.done;
  }
  cancelProviderClientEffect(original: object): void {
    this.clientEffectHandles
      .get(original)
      ?.abort.abort(
        new EngineError('CANCELLED', 'The exact remote terminal was cancelled'),
      );
  }
  releaseProviderClientEffect(original: object): void {
    this.clientEffectHandles.delete(original);
  }

  readProviderClientReadCompletion(original: object): BackendClientReadProof {
    if (!original || typeof original !== 'object' || types.isProxy(original)) throw new EngineError('BACKEND_ORIGINAL_REQUIRED', 'Client read completion requires its original receipt');
    const proof = this.clientReadCompletions.get(original);
    if (!proof) throw new EngineError('BACKEND_ORIGINAL_REQUIRED', 'The native client read completion receipt is unavailable');
    return structuredClone(proof);
  }

  releaseProviderClientReadCompletion(original: object): void {
    this.clientReadCompletions.delete(original); this.retainedClientReads.delete(original);
  }

  private teamContextBinding(context: ToolContext): string {
    if (types.isProxy(context) || ![Object.prototype,null].includes(Object.getPrototypeOf(context))) throw new EngineError('TEAM_MODEL_OWNER_STALE', 'Team tools require original plain context data');
    const fields = Object.getOwnPropertyDescriptors(context);
    if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !Object.hasOwn(fields[key]!, 'value')) || ['workspace','limits','signal','sessionId','runId','toolCallId','turnId','attemptId','artifactDir'].some(key => !Object.hasOwn(fields,key))) throw new EngineError('TEAM_MODEL_OWNER_STALE', 'Team tools require unchanged original context data');
    const metadata: Record<string,unknown>[] = [];
    for (const value of [context.workspace, context.limits]) {
      if (!value || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new EngineError('TEAM_MODEL_OWNER_STALE', 'Team context metadata changed');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !descriptors[key]!.enumerable || !Object.hasOwn(descriptors[key]!, 'value') || descriptors[key]!.value !== null && !['string', 'number', 'boolean'].includes(typeof descriptors[key]!.value))) throw new EngineError('TEAM_MODEL_OWNER_STALE', 'Team context metadata must remain plain data');
      const copy: Record<string,unknown> = Object.create(null);
      for (const [key,descriptor] of Object.entries(descriptors)) copy[key] = descriptor.value;
      metadata.push(copy);
    }
    return JSON.stringify([...metadata, fields.sessionId!.value, fields.runId!.value, fields.toolCallId!.value, fields.turnId!.value, fields.attemptId!.value, fields.artifactDir!.value, fields.executionLockPath?.value ?? null]);
  }

  /** Team/workflow live phases require the same unchanged, non-aborted owner. */
  private liveToolOwnerChanged(captured: TeamToolContextCapture, context: ToolContext, phase: 'prepare' | 'execute', safeBinding: string): boolean {
    const { owner, record } = captured;
    return this.owners.get(owner.run.id) !== owner || owner.terminal || owner.abort.signal.aborted || context.signal !== captured.signal || context.signal.aborted
      || safeBinding !== captured.binding || owner.activeTools.get(record.id) !== record
      || owner.run.sessionId !== context.sessionId || owner.run.id !== context.runId || owner.run.workspaceId !== context.workspace.id
      || owner.turn?.id !== context.turnId || owner.turn?.attemptId !== context.attemptId
      || record.id !== context.toolCallId || record.state !== (phase === 'prepare' ? 'requested' : 'running');
  }

  /** SQL-matching copies cannot become an original current tool producer. */
  assertTeamToolContext(context: ToolContext, phase: 'prepare' | 'execute'): void {
    const captured = this.teamToolContexts.get(context);
    if (!captured || captured.phase !== phase || !captured.active()) throw new EngineError('TEAM_MODEL_OWNER_STALE', 'Team tools require their original current coordinator context');
    const { record } = captured;
    const safeBinding = this.teamContextBinding(context);
    if (!['send_agent_message', 'read_agent_mailbox', 'claim_team_task', 'complete_team_task','read_team_board','submit_team_task','review_team_task'].includes(record.name)
      || this.liveToolOwnerChanged(captured, context, phase, safeBinding)) throw new EngineError('TEAM_MODEL_OWNER_STALE', 'Original team tool execution changed');
    this.captureToolCatalogue(context);
    if (phase === 'execute' && !['read_agent_mailbox','read_team_board'].includes(record.name)) {
      if (!captured.approval) throw new EngineError('TEAM_MODEL_APPROVAL_REQUIRED', 'Team mutations require exact original native approval');
      const approval = this.options.store.getApproval(captured.approval.id);
      if (approval.status !== 'allowed' || approval.fingerprint !== captured.approval.fingerprint || approval.sessionId !== context.sessionId || approval.runId !== context.runId || approval.toolCallId !== record.id || approval.toolName !== record.name) throw new EngineError('TEAM_MODEL_APPROVAL_REQUIRED', 'Team mutation approval changed');
    }
  }

  /** Original native context for the two readonly command job model consumers. */
  readCommandJobToolContext(context: ToolContext, phase: 'prepare' | 'execute') {
    const captured=this.teamToolContexts.get(context);
    if(!captured||captured.phase!==phase||!captured.active())throw new EngineError('COMMAND_JOB_MODEL_OWNER_STALE','Command output needs the original current tool context');
    const {owner,record}=captured;const binding=this.teamContextBinding(context);
    if(!['read_command_job','read_command_job_output'].includes(record.name)||this.owners.get(owner.run.id)!==owner||owner.terminal||owner.abort.signal.aborted||context.signal!==captured.signal||context.signal.aborted||binding!==captured.binding||owner.activeTools.get(record.id)!==record||owner.run.id!==context.runId||owner.run.sessionId!==context.sessionId||owner.run.workspaceId!==context.workspace.id||owner.turn?.id!==context.turnId||owner.turn?.attemptId!==context.attemptId||record.id!==context.toolCallId||record.state!==(phase==='prepare'?'requested':'running'))throw new EngineError('COMMAND_JOB_MODEL_OWNER_STALE','The original readonly command job owner changed');
    const catalogue=this.captureToolCatalogue(context);return {workspaceId:context.workspace.id,sessionId:context.sessionId,runId:context.runId,toolCallId:record.id,turnId:context.turnId!,attemptId:context.attemptId!,catalogueSha256:knowledgeHash(catalogue),profile:catalogue.profile?{id:catalogue.profile.id,revision:catalogue.profile.revision}:null};
  }

  assertWorkflowToolContext(context: ToolContext, phase: 'prepare' | 'execute'): void {
    const captured = this.teamToolContexts.get(context);
    if (!captured || captured.phase !== phase || !captured.active()) throw new EngineError('WORKFLOW_MODEL_OWNER_STALE', 'Team tools require their original current coordinator context');
    const { record } = captured;
    const safeBinding = this.teamContextBinding(context);
    if (!['request_workflow_stage', 'observe_workflow_stage', 'merge_workflow_stage', 'deliver_workflow_result'].includes(record.name)
      || this.liveToolOwnerChanged(captured, context, phase, safeBinding)) throw new EngineError('WORKFLOW_MODEL_OWNER_STALE', 'Original team tool execution changed');
    this.captureToolCatalogue(context);
    if (phase === 'execute' && record.name !== 'observe_workflow_stage') {
      if (!captured.approval) throw new EngineError('WORKFLOW_MODEL_APPROVAL_REQUIRED', 'Team mutations require exact original native approval');
      const approval = this.options.store.getApproval(captured.approval.id);
      if (approval.status !== 'allowed' || approval.fingerprint !== captured.approval.fingerprint || approval.sessionId !== context.sessionId || approval.runId !== context.runId || approval.toolCallId !== record.id || approval.toolName !== record.name) throw new EngineError('WORKFLOW_MODEL_APPROVAL_REQUIRED', 'Team mutation approval changed');
    }
  }

  getWorkflowToolApproval(context: ToolContext): { id: string; fingerprint: string } {
    this.assertWorkflowToolContext(context, 'execute');
    const captured = this.teamToolContexts.get(context)!;
    if (!captured.approval) throw new EngineError('WORKFLOW_MODEL_APPROVAL_REQUIRED', 'Workflow effects require their actual native approval');
    return { ...captured.approval };
  }

  /** Nested host verification keeps the original advertised profile/discovery capture. */
  captureToolCatalogue(context: ToolContext): ToolCatalogue {
    const owner = this.owners.get(context.runId);
    if (!owner || owner.terminal || owner.abort.signal.aborted || context.signal.aborted || owner.run.sessionId !== context.sessionId || owner.run.workspaceId !== context.workspace.id || context.workspace.root !== this.options.store.getWorkspace(owner.run.workspaceId).root || !owner.activeTools.has(context.toolCallId) || context.turnId !== owner.turn?.id || context.attemptId !== owner.turn?.attemptId || !owner.catalogue || !this.options.toolRuntime) throw new EngineError('TOOL_CATALOGUE_STALE', 'Nested verification requires the current native tool owner and catalogue');
    owner.discovery?.assertCurrent();
    this.options.toolRuntime.assertCatalogueCurrent(owner.catalogue);
    return owner.catalogue;
  }
  readCodeModeContext(context:ToolContext, phase:'prepare'|'execute'|'observe') {
    const c=this.codeModeContexts.get(context);if(!c||!c.active()||c.phase!==(phase==='observe'?'execute':phase)||this.teamContextBinding(context)!==c.binding)codeModeError('CODE_MODE_OWNER_STALE');
    const {owner,record}=c;if(this.owners.get(owner.run.id)!==owner||owner.terminal||owner.activeTools.get(record.id)!==record||context.signal!==c.signal||record.name!=='execute_code'||context.runId!==owner.run.id||context.sessionId!==owner.run.sessionId||context.workspace.id!==owner.run.workspaceId||context.turnId!==owner.turn?.id||context.attemptId!==owner.turn?.attemptId||phase!=='observe'&&(context.signal.aborted||owner.abort.signal.aborted||record.state!==(phase==='prepare'?'requested':'running')))codeModeError('CODE_MODE_OWNER_STALE');
    const catalogue=phase==='observe'?owner.catalogue:this.captureToolCatalogue(context);if(!catalogue)codeModeError('CODE_MODE_OWNER_STALE');
    let approval:null|{id:string;fingerprint:string}=null;
    if(phase!=='prepare'){if(!c.approval)codeModeError('CODE_MODE_APPROVAL_REQUIRED');const a=this.options.store.getApproval(c.approval.id);if(a.status!=='allowed'||a.fingerprint!==c.approval.fingerprint||a.runId!==context.runId||a.toolCallId!==record.id||a.toolName!==record.name)codeModeError('CODE_MODE_APPROVAL_REQUIRED');approval={id:a.id,fingerprint:a.fingerprint};}
    return {workspaceId:context.workspace.id,sessionId:context.sessionId,runId:context.runId,turnId:context.turnId!,attemptId:context.attemptId!,toolCallId:record.id,configSha256:knowledgeHash(owner.run.config),catalogueSha256:knowledgeHash(catalogue),profile:catalogue.profile??null,approval};
  }
  async executeCodeModeNested(context:ToolContext,input:{id:string;tool:string;input:JsonObject;deadline:number;signal:AbortSignal;assertCurrent:()=>void}) {
    this.readCodeModeContext(context,'execute');input.assertCurrent();if(!(CODE_MODE_TOOLS as readonly string[]).includes(input.tool))codeModeError('CODE_MODE_TOOL_UNSUPPORTED');
    const owner=this.codeModeContexts.get(context)!.owner;
    if(!owner.turn||owner.callIds.has(input.id))codeModeError('CODE_MODE_DUPLICATE_CALL');
    if(this.remainingChildBudget(owner).toolCalls<1)codeModeError('TOOL_CALL_LIMIT');
    const clean=codeJson(input.input);owner.budget.reserveToolCalls(1);owner.callIds.add(input.id);
    const toolId=randomUUID();owner.invocations.set(input.id,toolId);this.codeModeNested.set(toolId,{outer:context,signal:AbortSignal.any([context.signal,input.signal]),deadline:input.deadline,assertCurrent:input.assertCurrent});
    const call={id:input.id,name:input.tool,input:clean};
    const message={...this.message(owner,'assistant',''),toolCalls:[call]};this.options.store.commit(owner.run.id,'message.created',{}, {message});
    owner.turn.toolProposal(message.id,toolId,call);
    try{await this.executeTool(owner,call,context.workspace);const tool=this.options.store.getSnapshot(owner.run.sessionId).tools.find(t=>t.id===toolId)!;const approvals=this.options.store.getSnapshot(owner.run.sessionId).approvals.filter(a=>a.toolCallId===toolId&&a.status==='allowed');return {toolCallId:toolId,providerToolCallId:input.id,name:tool.name,inputSha256:knowledgeHash(tool.input),state:tool.state,outputSha256:createHash('sha256').update(tool.output??'').digest('hex'),outputBytes:Buffer.byteLength(tool.output??''),approval:approvals[0]?{id:approvals[0].id,fingerprint:approvals[0].fingerprint}:null,content:tool.output??''};}
    finally{this.codeModeNested.delete(toolId);}
  }

  /** ORIGINAL approved execution scope, retained only while the genuine command owns its Run. */
  readOwnedCommandContext(context: ToolContext, phase: 'start' | 'settle') {
    const captured = this.commandJobContexts.get(context);
    if (!captured || !captured.active() || this.teamContextBinding(context) !== captured.binding) throw new EngineError('COMMAND_JOB_OWNER_STALE', 'Command jobs require the original unchanged execution context');
    const { owner, record, approval: pin } = captured;
    if (owner.terminal || this.owners.get(owner.run.id) !== owner || owner.activeTools.get(record.id) !== record || context.signal !== captured.signal
      || owner.run.id !== context.runId || owner.run.sessionId !== context.sessionId || owner.run.workspaceId !== context.workspace.id
      || owner.turn?.id !== context.turnId || owner.turn?.attemptId !== context.attemptId || !['run_command','verify_changes','run_command_job','command_job_input','wait_command_job'].includes(record.name)
      || phase === 'start' && (context.signal.aborted || owner.abort.signal.aborted || record.state !== 'running')) throw new EngineError('COMMAND_JOB_OWNER_STALE', 'The actual command execution owner changed');
    if (!pin) throw new EngineError('COMMAND_JOB_APPROVAL_REQUIRED', 'Command observation requires its exact native approval');
    const approval = this.options.store.getApproval(pin.id);
    if (approval.status !== 'allowed' || approval.fingerprint !== pin.fingerprint || approval.toolCallId !== record.id || approval.runId !== context.runId || approval.sessionId !== context.sessionId || approval.toolName !== record.name) throw new EngineError('COMMAND_JOB_APPROVAL_REQUIRED', 'The actual native command approval changed');
    const catalogue = phase === 'start' ? this.captureToolCatalogue(context) : owner.catalogue;
    if (!catalogue) throw new EngineError('COMMAND_JOB_OWNER_STALE', 'Command catalogue is unavailable');
    return { name: record.name, workspaceId: context.workspace.id, sessionId: context.sessionId, runId: context.runId,
      toolCallId: record.id, turnId: context.turnId!, attemptId: context.attemptId!, approvalId: approval.id,
      approvalFingerprint: approval.fingerprint, catalogueSha256: knowledgeHash(catalogue) };
  }

  /** Authenticate only the real verification execution's narrowed nested command, then discard it. */
  async withVerificationCommandContext<T>(outer: ToolContext, nested: ToolContext, execute: () => Promise<T>): Promise<T> {
    const owner = this.readOwnedCommandContext(outer, 'start');
    if (owner.name !== 'verify_changes' || outer === nested || this.commandJobContexts.has(nested))
      throw new EngineError('COMMAND_JOB_OWNER_STALE', 'Nested commands require their original verification owner');
    const binding = this.teamContextBinding(nested);
    const outerFields = Object.getOwnPropertyDescriptors(outer), nestedFields = Object.getOwnPropertyDescriptors(nested);
    const fieldsChanged = Reflect.ownKeys(outerFields).length !== Reflect.ownKeys(nestedFields).length
      || Object.keys(outerFields).some(key => !Object.hasOwn(nestedFields, key)
        || !['limits', 'recordCheckpoint'].includes(key) && outerFields[key]!.value !== nestedFields[key]!.value);
    const nestedLimits = nested.limits as unknown as Record<string, unknown>;
    const limitsChanged = Object.keys(outer.limits).length !== Object.keys(nestedLimits).length
      || Object.entries(outer.limits).some(([key, value]) => {
        if (!Object.hasOwn(nestedLimits, key)) return true;
        const selected = nestedLimits[key];
        if (!['toolTimeoutMs', 'maxOutputBytes'].includes(key)) return selected !== value;
        return typeof selected !== 'number' || !Number.isSafeInteger(selected) || selected < 1 || selected > value;
      });
    if (fieldsChanged || limitsChanged || typeof nested.recordCheckpoint !== 'function')
      throw new EngineError('COMMAND_JOB_OWNER_STALE', 'Verification nesting may only narrow timeout/output limits and wrap checkpoint publication');
    const capture = this.commandJobContexts.get(outer)!;
    this.commandJobContexts.set(nested, { ...capture, binding });
    try { return await execute(); }
    finally { this.commandJobContexts.delete(nested); }
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

  /** A genuine approved command tool may retain a Root lease across its own terminal Run. */
  withCommandWorkspaceLease<T>(context: ToolContext, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const owner = this.readOwnedCommandContext(context, 'start');
    if (owner.name !== 'run_command_job') throw new EngineError('COMMAND_LIFETIME_OWNER_STALE', 'Only the approved original lifetime tool may own this lease');
    const pending=this.workspaceLease(owner.workspaceId, operation, false, false, false, false, owner.runId);
    const lease=this.workspaceLeases.get(owner.workspaceId);if(lease)lease.commandRunId=owner.runId;return pending;
  }
  reserveCommandLifetimeBudget(context: ToolContext, outputBytes: number, durationMs: number): void {
    this.readOwnedCommandContext(context, 'start');
    const owner = this.owners.get(context.runId)!;
    const remaining = this.remainingChildBudget(owner);
    if (!Number.isSafeInteger(outputBytes) || outputBytes < 1 || outputBytes > remaining.outputBytes || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > remaining.durationMs) throw new EngineError('COMMAND_LIFETIME_BUDGET_EXCEEDED', 'Command lifetime must fit the original remaining Run budget');
    owner.childReserved.outputBytes += outputBytes;
  }

  /** Host generation owns a durable quarantine, independently of coding effects. */
  withHostGenerationLease<T>(workspaceId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.workspaceLease(workspaceId, operation, false, true);
  }

  /** Physical knowledge publication has its own durable recovery barrier. */
  withHostFilePublicationLease<T>(workspaceId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.workspaceLease(workspaceId, operation, false, true, true);
  }

  /** Host proposal effects retain their own durable uncertainty after lease settlement. */
  withHostProposalApplyLease<T>(workspaceId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.workspaceLease(workspaceId, operation, false, true, false, true);
  }

  /** Host recovery decisions only. Keeps other quarantines and never wakes queued work. */
  withRecoveryDecisionLease<T>(workspaceId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.workspaceLease(workspaceId, operation, true);
  }

  private workspaceLease<T>(workspaceId: string, operation: (signal: AbortSignal) => Promise<T>, summaryRecovery: boolean, hostGeneration = false, hostFile = false, hostProposal = false, originalRunId?: string): Promise<T> {
    const nativeUncertainty = () => hostProposal ? this.options.store.hasUncertainProposalApply?.(workspaceId)
      : hostFile ? this.options.store.hasUncertainKnowledgeFilePublication?.(workspaceId) : this.options.store.hasUncertainKnowledgeGeneration?.(workspaceId);
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
      const active = this.options.store.hasActiveRuns?.(workspaceId, originalRunId)
        ?? this.options.store.listSessions(workspaceId).some(session => this.options.store.getSnapshot(session.id).runs.some(run => run.id !== originalRunId && !isTerminal(run.state)));
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
          if (!hostGeneration || nativeUncertainty() !== true) throw new EngineError('CLEANUP_UNCERTAIN', 'Workspace maintenance did not confirm its effects and cleanup');
          lease.cleanupError = new EngineError('CLEANUP_UNCERTAIN', 'Host generation cleanup remains recorded in its native quarantine');
        }
        if (!summaryRecovery && hostProposal && nativeUncertainty() === true) {
          lease.cleanupError = new EngineError('CLEANUP_UNCERTAIN', 'Proposal effects remain recorded in their native quarantine');
        }
        // Preserve observed partial/cancelled restore results after abort. The
        // callback's settlement, rather than the signal, confirms cleanup.
        return result;
      } catch (error) {
        if (!summaryRecovery && hostGeneration && nativeUncertainty() === true) {
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

private readonly childGroupSlots = new WeakMap<
    object,
    {
      runId: string;
      allocation: ChildBudget;
      total: ChildBudget;
      used: boolean;
    }
  >();
  /** All members reserve real parent capacity before the first batch child. Slots never refund. */
  reserveChildRunGroup(
    runId: string,
    allocations: readonly ChildBudget[],
  ): object[] {
    if (!allocations.length || allocations.length > 24)
      throw new EngineError(
        "CHILD_BUDGET_EXCEEDED",
        "Bounded member allocations required",
      );
    const total = { turns: 0, toolCalls: 0, outputBytes: 0, durationMs: 0 };
    for (const allocation of allocations)
      for (const key of [
        "turns",
        "toolCalls",
        "outputBytes",
        "durationMs",
      ] as const) {
        if (!Number.isSafeInteger(allocation[key]) || allocation[key] < 1)
          throw new EngineError(
            "CHILD_BUDGET_EXCEEDED",
            "Positive allocations required",
          );
        total[key] += allocation[key];
      }
    this.reserveChildRun(runId, total);
    return allocations.map((allocation) => {
      const original = Object.freeze(Object.create(null));
      this.childGroupSlots.set(original, {
        runId,
        allocation: { ...allocation },
        total: { ...total },
        used: false,
      });
      return original;
    });
  }
  assertChildRunGroupSlot(
    original: object,
    runId: string,
    allocation: ChildBudget,
  ): void {
    const slot = this.childGroupSlots.get(original),
      owner = this.owners.get(runId);
    if (
      !slot ||
      slot.runId !== runId ||
      slot.used ||
      !owner ||
      knowledgeHash(slot.allocation) !== knowledgeHash(allocation)
    )
      throw new EngineError(
        "CHILD_RESERVATION_STALE",
        "Original reserved member required",
      );
    this.assertLive(owner);
  }
  childRunGroupCapacity(
    original: object,
    runId: string,
    allocation: ChildBudget,
  ): ChildBudget {
    this.assertChildRunGroupSlot(original, runId, allocation);
    const slot = this.childGroupSlots.get(original)!,
      remaining = this.getRemainingChildBudget(runId);
    return {
      ...remaining,
      turns: remaining.turns + slot.total.turns,
      toolCalls: remaining.toolCalls + slot.total.toolCalls,
      outputBytes: remaining.outputBytes + slot.total.outputBytes,
    };
  }
  consumeChildRunGroupSlot(
    original: object,
    runId: string,
    allocation: ChildBudget,
  ): void {
    this.assertChildRunGroupSlot(original, runId, allocation);
    this.childGroupSlots.get(original)!.used = true;
  }
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
      outputBytes: Math.max(0, limits.maxOutputBytes - owner.outputBytes - owner.childReserved.outputBytes - (owner.effectOutputReservation===undefined?0:Math.max(0,owner.effectOutputReservation-(owner.outputBytes-owner.effectOutputBase!)))),
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
      owner.lifecycle = this.options.lifecycleHooks?.capture({ workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.id }, run.config.limits);
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
        owner.turn = new TurnExecutor({
          run,
          index: turnIndex,
          inputIds: records?.listRunInputIds?.(run.id) ?? [run.inputId],
          budget: owner.budget,
          store: this.options.store,
          wait: abortable,
          ...(revisionId ? { contextRevisionId: revisionId } : {}),
          currentContextRevisionId: () =>
            this.options.getContextRevisionId?.(run.sessionId),
          beforeAdapterIntent: () => {
            this.assertLive(owner);
            assertCatalogueCurrent();
            if (owner.lifecycle)
              this.options.lifecycleHooks!.assertCurrent(owner.lifecycle);
            this.options.beforeProviderDispatch?.(run);
          },
          beforeAdapterDispatch: (request, signal) => {
            if (
              !request.turnId ||
              !request.attemptId ||
              !records?.getAttemptCleanup
            )
              return;
            const cleanup = records.getAttemptCleanup(
              request.attemptId,
              run.sessionId,
            );
            this.providerRequests.set(request, {
              owner,
              signal,
              pendingRead: false,
              proof: {
                workspaceId: run.workspaceId,
                sessionId: run.sessionId,
                runId: run.id,
                turnId: request.turnId,
                attemptId: request.attemptId,
                providerId: provider.id,
                modelId: request.modelId,
                requestSha256: cleanup.requestSha256,
                configSha256: knowledgeHash(run.config),
                catalogueSha256: knowledgeHash(
                  owner.catalogue ?? request.tools,
                ),
                contextRevisionId: cleanup.contextRevisionId ?? null,
              },
            });
            this.options.beforeActualProviderRequest?.(request);
          },
          afterAdapterSettlement: (request) => {
            this.providerRequests.delete(request);
          },
          assertContextFresh: async (request, signal) => {
            await this.options.assertContextFresh?.(request, signal);
            assertCatalogueCurrent();
            if (owner.lifecycleContinuation)
              await this.options.lifecycleContinuation!.assertFresh(
                run,
                owner.lifecycleContinuation,
                signal,
              );
            if (
              owner.verificationContinuation &&
              owner.verificationBoundary &&
              this.options.verificationBeforeProvider
            )
              await this.options.verificationBeforeProvider(
                run,
                owner.verificationBoundary,
                signal,
              );
            this.assertLive(owner);
            if (owner.lifecycle)
              this.options.lifecycleHooks!.assertCurrent(owner.lifecycle);
            assertCatalogueCurrent();
          },
          ...(this.options.recoverContextOverflow
            ? {
                recoverContextOverflow: async () => {
                  assertCatalogueCurrent();
                  const failedAttemptId = owner.turn?.attemptId;
                  await abortable(
                    () =>
                      this.options.recoverContextOverflow!(
                        {
                          ...contextRequest(),
                          ...(owner.turn && failedAttemptId
                            ? {
                                activePrefixStage: {
                                  stage: "overflow-recovery" as const,
                                  currentTurnId: owner.turn.id,
                                  failedAttemptId,
                                  cleanupConfirmed: true as const,
                                },
                              }
                            : {}),
                        },
                        provider,
                      ),
                    owner.abort.signal,
                    "Context overflow recovery",
                  );
                  // TurnExecutor replaces only messages on overflow retry. Retain the
                  // same advertised schemas and handler capture or stop before retry.
                  messages = structuredClone(await context(true));
                  this.checkContext(owner, messages);
                  return messages;
                },
              }
            : {}),
        });
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
          await this.options.onCommandLifetimesSettling?.(owner.run.id, 'completed');
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
      // Windows native cancellation and code mode can prove physical cleanup
      // before the Run interrupts their Tool. Settle those observations only
      // after Turn.fail has closed the original Part; a Tool interruption alone
      // proves no cleanup.
      for (const tool of owner.interruptedWindowsCommands ?? []) {
        try { this.options.onOwnedCommandToolSettled?.(tool); }
        catch { owner.cleanupError = new EngineError('CLEANUP_UNCERTAIN', 'Native command cancellation observation could not be durably settled'); }
      }
      owner.interruptedWindowsCommands = undefined;
      for (const tool of owner.interruptedCodeModeTools ?? []) {
        try { this.options.onCodeModeToolSettled?.(tool); }
        catch { owner.cleanupError = new EngineError('CLEANUP_UNCERTAIN', 'Code-mode cancellation observation could not be durably settled'); }
      }
      owner.interruptedCodeModeTools = undefined;
      try { this.options.approvals.cancelRun(run.id); }
      catch { owner.cleanupError = new EngineError('CLEANUP_UNCERTAIN', 'Pending approval cleanup could not be confirmed'); }
      const terminalError = owner.cleanupError ?? failure;
      if (!owner.lifecycleStopChecked && !owner.abort.signal.aborted) {
        owner.lifecycleStopChecked = true;
        // Terminal observation cannot replace producer failure or cleanup uncertainty.
        try { await this.lifecycle(owner, 'before-stop', owner.lifecycleContinuationsUsed ? `${owner.turn?.id ?? run.id}:failure-stop` : `${run.id}:stop`, { outcome: terminalError.code === 'RUN_CANCELLED' ? 'cancelled' : 'failed', errorCode: terminalError.code, turnCount: owner.budget.snapshot().logicalTurns, toolCallCount: owner.toolCount, outputBytes: owner.outputBytes, continuationsUsed: owner.lifecycleContinuationsUsed }, false); } catch { /* Preserve the authoritative execution failure. */ }
      }
      try { await this.options.onCommandLifetimesSettling?.(owner.run.id, terminalError.code === 'RUN_CANCELLED' ? 'cancelled' : 'failed'); } catch { owner.cleanupError = new EngineError('CLEANUP_UNCERTAIN', 'Transferred command cleanup remains unconfirmed'); }
      return this.finish(owner, terminalError.code === 'RUN_CANCELLED' ? 'cancelled' : 'failed', owner.cleanupError ?? (terminalError.code === 'RUN_CANCELLED' ? undefined : terminalError));
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
      if (!declaredRead(calls[index]!) && this.options.effectBatches && owner.catalogue && this.options.executionLockPath && this.options.toolRuntime!.hasPreparedResources(owner.catalogue,calls[index]!.name)) {
        const batch: ProviderToolCall[] = [];
        while (index < calls.length && batch.length < 4 && !declaredRead(calls[index]!) && this.options.toolRuntime!.hasPreparedResources(owner.catalogue,calls[index]!.name)) batch.push(calls[index++]!);
        const childReservation=knowledgeHash(owner.childReserved);
        const controller = this.options.effectBatches.create({workspaceId:workspace.id,sessionId:owner.run.sessionId,runId:owner.run.id,turnId:owner.turn!.id,attemptId:owner.turn!.attemptId!,configSha256:knowledgeHash(owner.run.config),catalogueSha256:knowledgeHash(owner.catalogue),calls:batch,budget:{toolCalls:batch.length,outputBytes:Math.max(1,this.toolOutputBudget(owner)),artifactBytes:owner.budget.budgets.maxArtifactBytes,durationMs:Math.max(1,owner.deadline-Date.now())},executionLockPath:this.options.executionLockPath,signal:owner.abort.signal,assertCurrent:()=>{this.getOwnedActiveRun(owner.run.id);if(knowledgeHash(owner.childReserved)!==childReservation)throw new EngineError('EFFECT_BATCH_BUDGET_STALE','Parent child budget changed after effect member reservation');this.options.toolRuntime!.assertCatalogueCurrent(owner.catalogue!);}});
        owner.readBatchWidth = batch.length;owner.effectOutputBase=owner.outputBytes;owner.effectOutputReservation=controller.outputAllocation();owner.effectOutputShare=Math.max(1,Math.floor(controller.outputAllocation()/batch.length));owner.effectArtifactShare=Math.max(1,Math.floor(owner.budget.budgets.maxArtifactBytes/batch.length));
        try {
          const results = await Promise.allSettled(batch.map(async (call,position)=>{try{return await this.executeTool(owner,call,workspace,{controller,index:position});}catch(error){controller.reject(error);owner.abort.abort(errorOf(error));throw error;}}));
          controller.close();const failed=results.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
          results.forEach((r,position)=>{if(r.status==='fulfilled')messages.push({role:'tool',content:r.value,toolCallId:batch[position]!.id});});
        } finally { owner.readBatchWidth = 1;owner.effectOutputShare=undefined;owner.effectArtifactShare=undefined;owner.effectOutputBase=undefined;owner.effectOutputReservation=undefined; }
        continue;
      }
      if (!declaredRead(calls[index]!)) {
        const call = calls[index++]!;if(this.options.effectBatches)this.options.store.commitRunObservation?.(owner.run.id,'effect.batch.serial_fallback',{toolCallId:owner.invocations.get(call.id)!,providerCallId:call.id,toolName:call.name,reason:'unproved-producer-serial',parallelAuthority:false},{turnId:owner.turn!.id,attemptId:owner.turn!.attemptId!}); const content = await this.executeTool(owner, call, workspace); messages.push({ role: 'tool', content, toolCallId: call.id }); continue;
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
    let media:ProviderAudioCapture|undefined;
    const saveMedia=async(success:boolean)=>{if(!media?.bytes)return;if(!this.options.providerArtifacts)throw new EngineError('CLEANUP_UNCERTAIN','Media artifact storage is unavailable');const ref=await media.store(await this.options.providerArtifacts(),success,owner.budget.budgets);if(ref){try{owner.turn!.putMedia(message.id,{type:'media',mime:media.mime,artifact:ref});}catch{throw new EngineError('CLEANUP_UNCERTAIN','Published provider media lacks a durable native Part receipt');}}};
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
      this.options.beforeProviderDispatch?.(owner.run);
      iterator = owner.turn!.stream(provider, request, owner.abort.signal)[Symbol.asyncIterator]();
      while (true) {
        const item = await abortable(() => iterator!.next(), owner.abort.signal, 'Provider stream', PROVIDER_CLEANUP_GRACE_MS);
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
          case 'media.delta': {
            const attemptId=owner.turn!.attemptId;if(!attemptId||!owner.turn!.records)throw new EngineError('PROVIDER_PROTOCOL_ERROR','Media requires an actual native Attempt');
            media??=new ProviderAudioCapture({source:'provider',sessionId:owner.run.sessionId,runId:owner.run.id,turnId:owner.turn!.id,attemptId,providerId:provider.id,modelId:owner.run.config.modelId},provider.requestedOutputMedia?.(owner.run.config.modelId)==='audio/wav');
            owner.outputBytes+=media.append(event,Math.max(0,owner.run.config.limits.maxOutputBytes-owner.outputBytes-owner.childReserved.outputBytes));break;
          }
          case 'media.end': if(!media)throw new EngineError('PROVIDER_PROTOCOL_ERROR','Media end has no stream');else media.end(event);break;
          case 'media': {
            // An adapter-supplied serialized Artifact is never proof of a provider output.
            if('source'in event.artifact.identity)throw new EngineError('PROVIDER_PROTOCOL_ERROR','Provider media artifacts must be published by the actual Attempt');
            owner.turn!.putMedia(message.id, event);break;
          }
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
      await saveMedia(true);
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
        if (!closed){try{await saveMedia(false);}catch{}throw new EngineError('CLEANUP_UNCERTAIN', 'Provider stream cleanup could not be confirmed');}
      }
      try{await saveMedia(false);}catch{throw new EngineError('CLEANUP_UNCERTAIN','Observed media publication or native receipt could not be established');}
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
    if(owner.effectOutputShare!==undefined)return owner.effectOutputShare;
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
    if(['run_command_job','command_job_input','wait_command_job'].includes(tool.name)&&state==='interrupted')this.options.onCommandLifetimeToolSettled?.(tool);
    if(tool.name==='execute_code'&&state==='interrupted')(owner.interruptedCodeModeTools??=[]).push(tool);
    if (tool.name === 'run_command' && state === 'interrupted') {
      if (process.platform === 'win32') (owner.interruptedWindowsCommands ??= []).push(tool);
      else this.options.onOwnedCommandToolSettled?.(tool);
    }
    if(tool.name==='merge_workflow_stage' && state==='interrupted')this.options.onWorkflowToolSettled?.(tool);
  }

  private context(owner: Owner, record: ToolCallRecord, workspace: ToolContext['workspace'], signal: AbortSignal, allowCheckpoint: () => boolean): ToolContext {
    const context: ToolContext = {
      workspace, sessionId: owner.run.sessionId, runId: owner.run.id, toolCallId: record.id,
      signal, limits: { ...owner.run.config.limits, maxOutputBytes: this.toolOutputBudget(owner) }, artifactDir: this.options.artifactDir,
      budgets: { ...owner.budget.budgets, ...(owner.effectArtifactShare!==undefined?{maxArtifactBytes:owner.effectArtifactShare}:{}) },
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
    const nested=this.codeModeNested.get(record.id);if(nested){this.readCodeModeContext(nested.outer,'execute');nested.assertCurrent();}
    const signal = AbortSignal.any([owner.abort.signal, timeout.signal,...(nested?[nested.signal]:[]), ...(this.clientReadCaptures.get(record.id)?.signal ? [this.clientReadCaptures.get(record.id)!.signal!] : [])]);
    const timer = setTimeout(() => timeout.abort(new EngineError('TOOL_TIMEOUT', `Tool ${record.name} exceeded its execution timeout`)), Math.max(1,Math.min(owner.run.config.limits.toolTimeoutMs,nested?nested.deadline-Date.now():Infinity)));
    let active = execute;
    let inProgress = true;
    const context = this.context(owner, record, workspace, signal, () => active);
    if(record.name==='execute_code')this.codeModeContexts.set(context,{owner,record,phase:execute?'execute':'prepare',active:()=>inProgress,binding:this.teamContextBinding(context),signal,...approval?{approval}:{}});
    if (execute && ['run_command','verify_changes','run_command_job','command_job_input','wait_command_job'].includes(record.name)) this.commandJobContexts.set(context, { owner, record, active: () => inProgress, binding: this.teamContextBinding(context), signal, ...(approval ? { approval } : {}) });
    if (['send_agent_message', 'read_agent_mailbox', 'claim_team_task', 'complete_team_task','read_team_board','submit_team_task','review_team_task','read_command_job','read_command_job_output','request_workflow_stage','observe_workflow_stage','merge_workflow_stage','deliver_workflow_result'].includes(record.name)) this.teamToolContexts.set(context, { owner, record, active: () => inProgress, phase: execute ? 'execute' : 'prepare', binding: this.teamContextBinding(context), signal, ...(approval ? { approval } : {}) });
    if (execute) context.mcpExecutionObserver = createMcpExecutionObserver(this.options.store, executionRecords(this.options.store), {
      sessionId: owner.run.sessionId, workspaceId: workspace.id, runId: owner.run.id, toolCallId: record.id, toolName: record.name,
      ...(owner.turn ? { turnId: owner.turn.id, ...(owner.turn.attemptId ? { attemptId: owner.turn.attemptId } : {}) } : {}),
      ...(approval ? { approval } : {}),
    });
    // Command cleanup joins its native owner and captures the after-image.
    const cleanupGraceMs = execute && ['run_command', 'verify_changes', 'execute_code'].includes(record.name) ? 5_000 : CLEANUP_GRACE_MS;
    try { return await abortable(() => operation(context), signal, `Tool ${record.name}`, cleanupGraceMs); }
    finally { inProgress = false; active = false; clearTimeout(timer); }
  }

  private async executeTool(owner: Owner, call: ProviderToolCall, workspace: ToolContext['workspace'], batch?: {controller:EffectBatchExecution;index:number}): Promise<string> {
    owner.toolCount++;
    // Provider IDs belong to a conversation; durable tool rows need globally unique IDs.
    const record: ToolCallRecord = { id: owner.invocations.get(call.id) ?? randomUUID(), runId: owner.run.id, sessionId: owner.run.sessionId, name: call.name, input: call.input, state: 'requested' };
    const clientRead = this.clientReadCaptures.get(record.id);
    if (clientRead) clientRead.record = record;
    owner.activeTools.set(record.id, record);
    batch?.controller.attach(batch.index,record);
    this.options.store.commit(owner.run.id, 'tool.requested', { toolCallId: record.id, providerToolCallId: call.id, name: call.name, input: call.input }, { tool: record });
    let preparedFingerprint: string | undefined;
    let terminalFailure: EngineError | undefined;
    let observedPrepared: PreparedTool | undefined;
    let batchCleanup: boolean | null = true;
    try {
      if (owner.allowedTools && !owner.allowedTools.has(call.name)) return this.toolResult(owner, record, call, this.toolError(owner, 'TOOL_NOT_ALLOWED', 'The active agent profile does not permit this tool'), 'denied');
      const tool = this.options.toolRuntime && owner.catalogue ? this.options.toolRuntime.resolve(owner.catalogue, call.name) : this.tools.get(call.name);
      if (!tool) return this.toolResult(owner, record, call, this.toolError(owner, 'UNKNOWN_TOOL', `Unknown tool: ${call.name}`));
      const commandLease=this.workspaceLeases.get(workspace.id);
      if(commandLease?.commandRunId===owner.run.id&&!['command_job_input','wait_command_job'].includes(call.name)&&!['read','state'].includes(tool.effectClass??'unknown'))return this.toolResult(owner,record,call,this.toolError(owner,'WORKSPACE_BUSY','An independently owned command lifetime retains this workspace effect lease'));
      const originalInput = JSON.stringify(call.input), originalInputSha256 = createHash('sha256').update(originalInput).digest('hex');
      const transform = await this.lifecycle(owner, 'tool-prepare', `${record.id}:prepare`, { toolCallId: record.id, toolName: call.name,
        inputSha256: originalInputSha256, inputBytes: Buffer.byteLength(originalInput),
        ...(owner.catalogue ? { registryRevision: owner.catalogue.revision, policyVersion: owner.catalogue.policyVersion } : {}),
        ...(owner.turn ? { turnId: owner.turn.id, ...(owner.turn.attemptId ? { attemptId: owner.turn.attemptId } : {}) } : {}) });
      if (transform?.action === 'deny') return this.toolResult(owner, record, call, this.toolError(owner, 'LIFECYCLE_DENIED', 'A host lifecycle hook denied tool preparation'), 'denied');
      const effectiveInput = transform?.inputRewrite ? structuredClone(transform.inputRewrite.input) : call.input;
      const effectiveEncoded = JSON.stringify(effectiveInput), effectiveSha256 = createHash('sha256').update(effectiveEncoded).digest('hex');
      if (clientRead && knowledgeHash(effectiveInput) !== knowledgeHash(call.input)) {
        throw new EngineError('BACKEND_CLIENT_READ_REWRITE_UNSUPPORTED', 'A client file read must preserve its requested path and line range');
      }
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
      if (clientRead) {
        clientRead.fingerprint = preparedFingerprint;
        const payload: JsonObject = { toolCallId: record.id, providerToolCallId: call.id, toolName: call.name,
          preparedFingerprint, requiresApproval: prepared.requiresApproval, inputSha256: knowledgeHash(record.input) };
        const refs = owner.turn ? { turnId: owner.turn.id, ...(owner.turn.attemptId ? { attemptId: owner.turn.attemptId } : {}) } : {};
        if (!this.options.store.commitRunObservation) throw new EngineError('BACKEND_NATIVE_OBSERVATION_REQUIRED', 'Client reads require the native preparation journal');
        this.options.store.commitRunObservation(owner.run.id, 'tool.prepared', payload, refs);
      }
      const before = await this.lifecycle(owner, 'tool-prepared', `${record.id}:prepared`, { toolCallId: record.id, toolName: call.name, fingerprint: prepared.fingerprint, requiresApproval: prepared.requiresApproval,
        ...(owner.turn ? { turnId: owner.turn.id, ...(owner.turn.attemptId ? { attemptId: owner.turn.attemptId } : {}) } : {}), ...(tool.effectClass ? { effectClass: tool.effectClass } : {}), inputSha256: createHash('sha256').update(JSON.stringify(prepared.input)).digest('hex'), previewSha256: createHash('sha256').update(JSON.stringify(prepared.preview)).digest('hex') });
      if (JSON.stringify(prepared) !== binding) throw new EngineError('PREPARED_TOOL_CHANGED', 'Prepared request changed during the lifecycle boundary');
      if (before?.action === 'deny') return this.toolResult(owner, record, call, this.toolError(owner, 'LIFECYCLE_DENIED', 'A host lifecycle hook denied this prepared tool'), 'denied');
      let sourceReadKey: string | null | undefined;
      if (this.options.executionObserver) {
        observedPrepared = prepared;
        sourceReadKey = await this.toolOperation(owner, record, workspace, false, context => this.options.executionObserver!.prepare(prepared, context));
        this.assertLive(owner);
      }
      if ((tool.effectClass === 'read' || (tool.effectClass === undefined && READ_TOOLS.has(call.name))) && !prepared.requiresApproval) {
        const key = this.options.executionObserver ? sourceReadKey : `${call.name}:${this.options.toolRuntime ? this.options.toolRuntime.repeatIdentity(prepared) : prepared.fingerprint}`;
        if (key) {
          if (owner.readonlyCalls.has(key)) throw new EngineError('REPEATED_READ_TOOL_CALL', 'This identical read was already attempted with the same observed source and effect epoch. Use its previous result, a continuation, a different line range, or a narrower query.');
          owner.readonlyCalls.add(key);
        }
      }
      if (batch) {
        const resource = await this.toolOperation(owner,record,workspace,false,context=>this.options.toolRuntime!.capturePreparedResources(prepared,context));
        if (!this.options.store.commitRunObservation) throw new EngineError('EFFECT_BATCH_NATIVE_REQUIRED','Prepared effects require the native journal');
        const {readPreparedResource}=await import('../effect-batches/claims.js');
        this.options.store.commitRunObservation(owner.run.id,'effect.batch.resource_prepared',{toolCallId:record.id,providerCallId:call.id,fingerprint:prepared.fingerprint,inputSha256:knowledgeHash(record.input),claim:resource?readPreparedResource(resource) as unknown as JsonObject:null},{turnId:owner.turn!.id,attemptId:owner.turn!.attemptId!});
        await batch.controller.prepared(batch.index,prepared.fingerprint,resource);
      }
      const effectful = tool.effectClass !== undefined && !['read', 'state'].includes(tool.effectClass) || EFFECT_TOOLS.has(call.name);
      let approval: ApprovedMcpToolOwner['approval'];
      if (owner.run.config.mode === 'plan' && (prepared.requiresApproval || effectful)) {
        return this.toolResult(owner, record, call, this.toolError(owner, 'PLAN_MODE_WRITE_BLOCKED', 'Plan mode does not allow this tool effect'), 'denied');
      }
      const codeNested=this.codeModeNested.get(record.id);
      if (prepared.requiresApproval || (codeNested&&effectful) || (!this.options.toolRuntime && effectful) || clientRead?.approved) {
        this.setTool(owner, record, 'awaiting_approval');
        this.options.store.commit(owner.run.id, 'run.awaiting_approval', { toolCallId: record.id }, { run: { state: 'awaiting_approval' } });
        const decision = await abortable(() => this.options.approvals.request({
          sessionId: owner.run.sessionId, runId: owner.run.id, toolCallId: record.id,
          toolName: prepared.name, fingerprint: prepared.fingerprint, preview: structuredClone(prepared.preview),
        }, codeNested?.signal??owner.abort.signal), codeNested?.signal??owner.abort.signal, 'Approval wait');
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
      if (clientRead?.approved) { clientRead.approved(approval); await clientRead.gate!(); this.assertLive(owner); }
      this.setTool(owner, record, 'running');
      if(clientRead?.approved){const refs=owner.turn?{turnId:owner.turn.id,...(owner.turn.attemptId?{attemptId:owner.turn.attemptId}:{})}:{};this.options.store.commitRunObservation?.(owner.run.id,'backend.client_effect_dispatched',{toolCallId:record.id,providerToolCallId:call.id,inputSha256:knowledgeHash(record.input),preparedFingerprint},refs);clientRead.dispatched?.();}
      if (prepared.requiresApproval || effectful) owner.readonlyCalls.clear();
      const result = await this.toolOperation(owner, record, workspace, true, async (context) => {
        if(batch){await batch.controller.enter(batch.index,context,approval);batchCleanup=null;}
        const result=await tool.execute(prepared as PreparedTool, context);if(clientRead?.approved)clientRead.result=structuredClone(result);return result;
      }, approval);
      if(batch)batchCleanup=result.data&&typeof result.data==='object'&&!Array.isArray(result.data)&&result.data.cleanupConfirmed===true?true:null;
      this.assertLive(owner);
      if (uncertain(result)) throw new EngineError('CLEANUP_UNCERTAIN', `Tool ${record.name} did not confirm cleanup`);
      if (!result || typeof result.content !== 'string') throw new EngineError('INVALID_TOOL_RESULT', 'Tool result content must be a string');
      if (observedPrepared) this.options.executionObserver!.result(observedPrepared, !result.isError && !(result.data && typeof result.data === 'object' && !Array.isArray(result.data) && result.data.truncated === true) && !result.artifacts?.some(item => item.truncated) && (!result.structuredResult || result.structuredResult.modelContent === result.content && result.structuredResult.artifactRefs.every(ref => ref.complete)));
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
      if(clientRead?.approved&&clientRead.signal?.aborted&&!owner.abort.signal.aborted&&call.name==='run_command'&&clientRead.result?.data&&typeof clientRead.result.data==='object'&&!Array.isArray(clientRead.result.data)&&clientRead.result.data.cleanupConfirmed===true){return this.toolResult(owner,record,call,{...clientRead.result,isError:true});}
      if(batch&&!uncertain(error))batchCleanup=true;
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
      // A narrowed code scope may cancel its own approval without cancelling the Root Run.
      if(this.codeModeNested.has(record.id)&&record.state==='awaiting_approval'&&!owner.abort.signal.aborted&&this.options.store.getRun(owner.run.id).state==='awaiting_approval'&&![...owner.activeTools.values()].some(other=>other.id!==record.id&&other.state==='awaiting_approval'))this.options.store.commit(owner.run.id,'run.resumed',{toolCallId:record.id},{run:{state:'running'}});
      // Input errors, denied permissions, and ordinary tool failures let the model adapt.
      return this.toolResult(owner, record, call, this.toolError(owner, failure.code, failure.message), deniedReceipt ? 'denied' : undefined);
    } finally {
      if (observedPrepared) await this.options.executionObserver!.settle(observedPrepared);
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
      } finally { try { batch?.controller.finish(batch.index,record,[...owner.checkpoints.values()].filter(c=>c.toolCallId===record.id).map(c=>({id:c.id,sha256:knowledgeHash(c)})),batchCleanup); } finally { owner.activeTools.delete(record.id); } }
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
    if(['run_command_job','command_job_input','wait_command_job'].includes(record.name))this.options.onCommandLifetimeToolSettled?.(record);
    if (record.name === 'run_command') this.options.onOwnedCommandToolSettled?.(record);
    if(record.name==='execute_code')this.options.onCodeModeToolSettled?.(record);
    if(record.name==='merge_workflow_stage')this.options.onWorkflowToolSettled?.(record);
    const clientRead = this.clientReadCaptures.get(record.id);
    if (clientRead) clientRead.result = structuredClone(result);
    if (output.truncated) throw new EngineError('OUTPUT_LIMIT', 'Run output byte budget was exceeded');
    return output.content;
  }
}
