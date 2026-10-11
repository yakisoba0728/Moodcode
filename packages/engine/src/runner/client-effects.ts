import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { types } from 'node:util';
import { EngineError, type JsonObject, type JsonValue, type Message, type ProviderToolCall, type ToolCallRecord } from '@moodcode/contracts';
import type { CoordinatorOptions, ProviderRequestOwner, ToolContext, ToolResult, TurnRequest } from '../ports.js';
import {
  clientEffectToolName, clientReadToolInput, terminalCommandLine, workspaceLocalPath,
  type BackendClientEffectInput, type BackendClientPermissionProof, type BackendClientReadInput, type BackendClientReadProof,
} from '../agent-backends/client-effects.js';
import type { ChildBudget } from '../child-tasks/index.js';
import { immutableKnowledgeJson, knowledgeHash, sha256, withKnowledgeHash } from '../knowledge/validation.js';
import { sha256Hex } from '../shared/canonical.js';
import { within } from '../shared/fs.js';
import { checkAbort, TERMINAL_TOOL_STATES, uncertain } from './abort.js';
import type { Owner } from './index.js';
import type { ApprovedMcpToolOwner } from './mcp-execution-observer.js';

export interface OriginalProviderRequest {
  readonly owner: Owner;
  readonly proof: ProviderRequestOwner;
  readonly signal: AbortSignal;
  pendingRead: boolean;
}

export interface ClientReadCapture {
  record?: ToolCallRecord;
  result?: ToolResult;
  fingerprint?: string;
  signal?: AbortSignal;
  gate?: () => Promise<void>;
  dispatched?: () => void;
  approved?: (approval?: ApprovedMcpToolOwner['approval']) => void;
}

interface ClientEffectHandle {
  request: TurnRequest;
  input: BackendClientEffectInput;
  proof: BackendClientPermissionProof;
  dispatch: () => void;
  abort: AbortController;
  done: Promise<object>;
  started: Promise<void>;
  dispatched: boolean;
  completion: () => BackendClientReadProof | undefined;
}

export interface ClientEffectsPort {
  originalProviderRequest(request: TurnRequest, phase: 'dispatch' | 'observe'): OriginalProviderRequest;
  remainingChildBudget(owner: Owner): ChildBudget;
  message(owner: Owner, role: 'assistant'): Message;
  executeTool(owner: Owner, call: ProviderToolCall, workspace: ToolContext['workspace']): Promise<string>;
}

/** The original request identity, in persisted proof key order. */
function requestScope(proof: ProviderRequestOwner) {
  return { workspaceId: proof.workspaceId, sessionId: proof.sessionId, runId: proof.runId, turnId: proof.turnId, attemptId: proof.attemptId };
}

/** Settled native tool fields shared by read and effect completions, in persisted key order. */
function settledTool(proof: ProviderRequestOwner, toolCallId: string, providerToolCallId: string, preparedFingerprint: string | undefined, record: ToolCallRecord) {
  return { ...requestScope(proof), toolCallId, providerToolCallId, preparedFingerprint: preparedFingerprint ?? null,
    state: (TERMINAL_TOOL_STATES.includes(record.state) ? record.state : 'interrupted') as BackendClientReadProof['state'],
    inputSha256: knowledgeHash(record.input), outputSha256: sha256(record.output ?? ''), outputBytes: Buffer.byteLength(record.output ?? '') };
}

/** Reject a write whose nearest existing parent resolves outside the workspace. */
async function assertParentInside(root: string, path: string): Promise<void> {
  for (let at = dirname(path); ;) {
    try {
      if (!within(root, await realpath(at))) throw new EngineError('PATH_OUTSIDE_WORKSPACE', 'Client write parent escaped the workspace');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(at);
      if (parent === at) throw error;
      at = parent;
    }
  }
}

/** The SHA-256 of a bounded regular source read through one descriptor, or null when it does not exist. */
async function captureSourceHash(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1048576) throw new EngineError('UNSAFE_PATCH_PATH', 'Client write requires a bounded regular source');
    const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await source.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.size > 1048576)
        throw new EngineError('UNSAFE_PATCH_PATH', 'The bounded source was replaced before descriptor capture');
      const bytes = Buffer.alloc(1048577);
      let position = 0;
      while (position < bytes.length) {
        const read = await source.read(bytes, position, bytes.length - position, position);
        if (read.bytesRead === 0) break;
        position += read.bytesRead;
      }
      const after = await source.stat();
      if (position > 1048576 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || position !== after.size)
        throw new EngineError('UNSAFE_PATCH_PATH', 'The bounded source changed during capture');
      return sha256Hex(bytes.subarray(0, position));
    } finally {
      try { await source.close(); }
      catch { throw new EngineError('CLEANUP_UNCERTAIN', 'The source capture descriptor did not confirm closure'); }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}

/** Backend client reads and effects, executed as native tools inside their original provider Attempt. */
export class ProviderClientEffects {
  private readonly clientReadCaptures = new Map<string, ClientReadCapture>();
  private readonly clientEffectHandles = new WeakMap<object, ClientEffectHandle>();
  private readonly clientReadCompletions = new WeakMap<object, BackendClientReadProof>();
  private readonly retainedClientReads = new Set<object>();

  constructor(private readonly options: CoordinatorOptions, private readonly port: ClientEffectsPort) {}

  capture(toolCallId: string): ClientReadCapture | undefined {
    return this.clientReadCaptures.get(toolCallId);
  }

  /** One client read executes inside the still-open original provider Attempt. */
  async executeRead(request: TurnRequest, value: BackendClientReadInput, signal: AbortSignal): Promise<object> {
    const captured = this.port.originalProviderRequest(request, 'dispatch'), { owner, proof } = captured;
    const input = immutableKnowledgeJson(value);
    if (Object.keys(input).some(key => !['callId', 'path', 'line', 'limit'].includes(key)) || typeof input.callId !== 'string' || !input.callId || Buffer.byteLength(input.callId) > 256
      || typeof input.path !== 'string' || !isAbsolute(input.path) || Buffer.byteLength(input.path) > 4096 || input.path.includes('\0')
      || input.line !== undefined && (!Number.isSafeInteger(input.line) || input.line < 1)
      || input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 2000)) throw new EngineError('BACKEND_CLIENT_READ_INVALID', 'The client read must have an explicit absolute path and bounded line range');
    if (signal.aborted) throw signal.reason ?? new EngineError('RUN_CANCELLED', 'Client read was cancelled');
    if (captured.pendingRead || owner.callIds.has(input.callId)) throw new EngineError('BACKEND_CLIENT_READ_CONFLICT', 'Client reads must be serialized with distinct request identities');
    if (this.retainedClientReads.size >= 128) throw new EngineError('BACKEND_CLIENT_READ_LIMIT', 'Client read completion handle limit was reached');
    const workspace = this.options.store.getWorkspace(proof.workspaceId), localPath = workspaceLocalPath(workspace.root, input.path);
    if (localPath === undefined) throw new EngineError('BACKEND_CLIENT_READ_OUTSIDE', 'Client reads must remain inside the actual workspace');
    const readInput = clientReadToolInput(localPath, input.line, input.limit);
    if (readInput.endLine !== undefined && !Number.isSafeInteger(readInput.endLine)) throw new EngineError('BACKEND_CLIENT_READ_INVALID', 'Client line range exceeds its integer bound');
    if (this.port.remainingChildBudget(owner).toolCalls < 1) throw new EngineError('TOOL_CALL_LIMIT', 'The original Run tool budget is exhausted');
    owner.budget.reserveToolCalls(1);
    const toolCallId = randomUUID(), message = this.port.message(owner, 'assistant');
    const call: ProviderToolCall = { id: input.callId, name: clientEffectToolName(input), input: readInput };
    owner.callIds.add(call.id); owner.invocations.set(call.id, toolCallId);
    this.options.store.commit(owner.run.id, 'backend.client_read_proposed', { toolCallId, providerToolCallId: call.id, turnId: proof.turnId, attemptId: proof.attemptId }, { message });
    owner.turn!.toolProposal(message.id, toolCallId, call);
    const readCapture: ClientReadCapture = {};
    this.clientReadCaptures.set(toolCallId, readCapture); captured.pendingRead = true;
    const abort = () => owner.abort.abort(new EngineError('RUN_CANCELLED', 'The original backend client read was cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    let failure: unknown;
    try { this.port.originalProviderRequest(request, 'dispatch'); await this.port.executeTool(owner, call, workspace); }
    catch (error) { failure = error; }
    finally { signal.removeEventListener('abort', abort); captured.pendingRead = false; this.clientReadCaptures.delete(toolCallId); }
    const record = readCapture.record;
    if (!record) throw failure ?? new EngineError('BACKEND_CLIENT_READ_FAILED', 'The native client read was not admitted');
    const data = readCapture.result?.data;
    const complete = record.state === 'completed' && data !== null && typeof data === 'object' && !Array.isArray(data) && typeof data.content === 'string' && Buffer.byteLength(data.content) <= 24576
      && data.truncated === false && data.outputTruncated === false && data.hasMore === false && data.partialFirstLine === false && data.partialLastLine === false;
    const errorCode = failure instanceof EngineError ? failure.code : failure ? 'BACKEND_CLIENT_READ_FAILED'
      : record.state === 'denied' ? 'APPROVAL_DENIED' : record.state !== 'completed' ? 'BACKEND_CLIENT_READ_FAILED' : !complete ? 'BACKEND_CLIENT_READ_PARTIAL' : null;
    const completion: BackendClientReadProof = withKnowledgeHash({ ...settledTool(proof, toolCallId, call.id, readCapture.fingerprint, record),
      content: complete ? (data as JsonObject).content as string : null, errorCode,
      cleanupConfirmed: !uncertain(failure) && !['CLEANUP_UNCERTAIN', 'TOOL_TIMEOUT'].includes(errorCode ?? '') });
    const original = Object.freeze({}); this.clientReadCompletions.set(original, completion); this.retainedClientReads.add(original);
    return original;
  }

  /** Approval waits in the genuine tool pipeline; an allow-once wire response cannot execute another input. */
  async prepareEffect(request: TurnRequest, value: BackendClientEffectInput, signal: AbortSignal): Promise<object> {
    const captured = this.port.originalProviderRequest(request, 'dispatch'), { owner, proof } = captured;
    const input = immutableKnowledgeJson(value), workspace = this.options.store.getWorkspace(proof.workspaceId);
    if (signal.aborted) throw signal.reason;
    if (captured.pendingRead || owner.callIds.has(input.callId)) throw new EngineError('BACKEND_CLIENT_EFFECT_CONFLICT', 'Only one exact native client effect may be active');
    if (this.retainedClientReads.size >= 128) throw new EngineError('BACKEND_CLIENT_READ_LIMIT', 'Client completion retention limit reached');
    let toolInput: JsonObject;
    if (input.method === 'fs/write_text_file') {
      if (Object.keys(input).some(key => !['callId', 'method', 'path', 'content'].includes(key)) || typeof input.content !== 'string'
        || Buffer.byteLength(input.content) > 16384 || !isAbsolute(input.path)) throw new EngineError('BACKEND_CLIENT_EFFECT_INVALID', 'Invalid bounded client write');
      const local = workspaceLocalPath(workspace.root, input.path);
      if (local === undefined) throw new EngineError('BACKEND_CLIENT_READ_OUTSIDE', 'Client effects stay inside the workspace');
      await assertParentInside(workspace.root, input.path);
      const expectedHash = await captureSourceHash(input.path);
      toolInput = { changes: [{ path: local, expectedHash, content: input.content }] };
    } else if (input.method === 'terminal/create') {
      if (process.platform === 'win32') throw new EngineError('COMMAND_PLATFORM_UNSUPPORTED', 'ACP terminals require the native POSIX command owner');
      if (Object.keys(input).some(key => !['callId', 'method', 'command', 'args', 'cwd', 'outputByteLimit'].includes(key))
        || !Array.isArray(input.args) || input.args.length > 64 || input.args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !isAbsolute(input.cwd)
        || !Number.isSafeInteger(input.outputByteLimit) || input.outputByteLimit < 1 || input.outputByteLimit > 16384) throw new EngineError('BACKEND_CLIENT_EFFECT_INVALID', 'Invalid exact terminal input');
      toolInput = { command: terminalCommandLine(input.command, input.args), cwd: input.cwd, timeoutMs: Math.min(owner.run.config.limits.toolTimeoutMs, 300000) };
    } else throw new EngineError('ACP_EFFECT_UNSUPPORTED', 'Unsupported client effect');
    const name = clientEffectToolName(input);
    if (!request.tools.some(tool => tool.name === name)) throw new EngineError('TOOL_NOT_ALLOWED', 'The original catalogue does not contain this effect');
    this.port.originalProviderRequest(request, 'dispatch');
    if (this.port.remainingChildBudget(owner).toolCalls < 1) throw new EngineError('TOOL_CALL_LIMIT', 'The original Run tool budget is exhausted');
    owner.budget.reserveToolCalls(1);
    const toolCallId = randomUUID(), call: ProviderToolCall = { id: input.callId, name, input: toolInput }, message = this.port.message(owner, 'assistant');
    owner.callIds.add(call.id);
    owner.invocations.set(call.id, toolCallId);
    const refs = { turnId: proof.turnId, attemptId: proof.attemptId };
    const proposed: JsonObject = { toolCallId, providerToolCallId: call.id, effectMethod: input.method, input: input as unknown as JsonValue, ...refs };
    this.options.store.commit(owner.run.id, 'backend.client_effect_proposed', proposed, { message });
    owner.turn!.toolProposal(message.id, toolCallId, call);
    this.options.store.commitRunObservation?.(owner.run.id, 'backend.client_effect_proposed', proposed, refs);
    const abort = new AbortController(), effectSignal = AbortSignal.any([signal, abort.signal]);
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve)), admitted = new Promise<void>(resolve => (ready = resolve));
    let actualStart!: () => void;
    const started = new Promise<void>(resolve => (actualStart = resolve));
    let permission: BackendClientPermissionProof | undefined;
    let terminalCompletion: BackendClientReadProof | undefined;
    const permissionProof = (allowed: boolean, inputSha256: string, approvalId: string | null): BackendClientPermissionProof => withKnowledgeHash({ ...requestScope(proof),
      toolCallId, providerToolCallId: call.id, inputSha256, preparedFingerprint: capture.fingerprint ?? null, approvalId, allowed });
    const capture: ClientReadCapture = {
      signal: effectSignal,
      dispatched: actualStart,
      gate: async () => {
        await new Promise<void>((resolve, reject) => {
          const cancel = () => reject(effectSignal.reason);
          if (effectSignal.aborted) return cancel();
          effectSignal.addEventListener('abort', cancel, { once: true });
          void gate.then(() => { effectSignal.removeEventListener('abort', cancel); resolve(); });
        });
        checkAbort(effectSignal);
        this.port.originalProviderRequest(request, 'dispatch');
      },
      approved: approval => {
        const granted = permissionProof(true, knowledgeHash(toolInput), approval?.id ?? null);
        if (!this.options.store.commitRunObservation) throw new EngineError('BACKEND_NATIVE_OBSERVATION_REQUIRED', 'Native permission journal is required');
        this.options.store.commitRunObservation(owner.run.id, 'backend.client_permission', { permission: granted as unknown as JsonValue }, refs);
        permission = granted;
        ready();
      },
    };
    this.clientReadCaptures.set(toolCallId, capture);
    captured.pendingRead = true;
    const done = (async () => {
      let failure: unknown;
      try { await this.port.executeTool(owner, call, workspace); }
      catch (error) { failure = error; }
      finally { captured.pendingRead = false; this.clientReadCaptures.delete(toolCallId); }
      const record = capture.record;
      if (!record) throw failure ?? new EngineError('BACKEND_CLIENT_EFFECT_FAILED', 'Native effect was not admitted');
      if (!permission) {
        const denied = permissionProof(false, knowledgeHash(record.input), null);
        this.options.store.commitRunObservation?.(owner.run.id, 'backend.client_permission', { permission: denied as unknown as JsonValue }, refs);
        permission = denied;
        ready();
      }
      let result: JsonValue | null = null;
      try {
        if (capture.result?.data !== undefined) {
          let data = immutableKnowledgeJson(capture.result.data);
          if (input.method === 'terminal/create' && data && typeof data === 'object' && !Array.isArray(data))
            data = immutableKnowledgeJson(Object.fromEntries(Object.entries(data).filter(([key]) => ['status', 'exitCode', 'signal', 'cancelled', 'timedOut', 'cleanupConfirmed',
              'started', 'checkpointId', 'checkpointIncomplete', 'outputAccountingComplete', 'error'].includes(key))));
          if (Buffer.byteLength(JSON.stringify(data)) <= 24576) result = data;
        }
      } catch {
        result = null;
      }
      const errorCode = failure instanceof EngineError ? failure.code : failure ? 'BACKEND_CLIENT_EFFECT_FAILED'
        : record.state === 'denied' ? 'APPROVAL_DENIED' : record.state !== 'completed' ? 'BACKEND_CLIENT_EFFECT_FAILED' : result === null ? 'BACKEND_CLIENT_EFFECT_LIMIT' : null;
      const actualCheckpoint = [...owner.checkpoints.values()].find(cp => cp.toolCallId === toolCallId);
      const completion: BackendClientReadProof = withKnowledgeHash({
        checkpoint: actualCheckpoint ? { id: actualCheckpoint.id, sha256: knowledgeHash(actualCheckpoint) } : null,
        ...settledTool(proof, toolCallId, call.id, capture.fingerprint, record),
        content: null, errorCode,
        cleanupConfirmed: !uncertain(failure) && (!result || typeof result !== 'object' || Array.isArray(result) || result.cleanupConfirmed !== false),
        effectMethod: input.method, result,
      });
      if (!this.options.store.commitRunObservation) throw new EngineError('BACKEND_NATIVE_OBSERVATION_REQUIRED', 'Client effects require a native completion anchor');
      this.options.store.commitRunObservation(owner.run.id, 'backend.client_effect_closed', { completion: completion as unknown as JsonValue }, refs);
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
      throw new EngineError('BACKEND_CLIENT_EFFECT_FAILED', 'Native preparation failed');
    }
    const original = Object.freeze({});
    this.clientEffectHandles.set(original, { request, input, proof: permission, dispatch: release, abort, done, started, dispatched: false, completion: () => terminalCompletion });
    return original;
  }

  private handle(original: object, message = 'Original effect is required'): ClientEffectHandle {
    const handle = this.clientEffectHandles.get(original);
    if (!handle) throw new EngineError('BACKEND_ORIGINAL_REQUIRED', message);
    return handle;
  }

  readPermission(original: object): BackendClientPermissionProof {
    return structuredClone(this.handle(original, 'Original prepared effect is required').proof);
  }

  async dispatchEffect(original: object): Promise<void> {
    const handle = this.clientEffectHandles.get(original);
    if (!handle || handle.dispatched || !handle.proof.allowed) throw new EngineError('BACKEND_EFFECT_STALE', 'The precise native effect cannot be dispatched');
    this.port.originalProviderRequest(handle.request, 'dispatch');
    handle.dispatched = true;
    handle.dispatch();
    await Promise.race([handle.started, handle.done.then(() => { throw new EngineError('BACKEND_CLIENT_EFFECT_FAILED', 'Native effect failed before dispatch'); })]);
  }

  readRequest(original: object): TurnRequest {
    const handle = this.handle(original);
    this.port.originalProviderRequest(handle.request, 'dispatch');
    return handle.request;
  }

  readScope(original: object) {
    const handle = this.clientEffectHandles.get(original);
    if (!handle || !handle.dispatched || handle.input.method !== 'terminal/create') throw new EngineError('BACKEND_ORIGINAL_REQUIRED', 'Only the original admitted terminal has output authority');
    this.port.originalProviderRequest(handle.request, 'dispatch');
    const completion = handle.completion(), result = completion?.result;
    // The same actual settled Tool proves cancellation before a physical source existed.
    const noProcessCompletionSha256 = handle.abort.signal.aborted && completion?.state === 'failed' && completion.effectMethod === 'terminal/create'
      && completion.cleanupConfirmed === true && completion.content === null && completion.checkpoint === null
      && result && typeof result === 'object' && !Array.isArray(result) && result.status === 'cancelled' && result.started === false
      && result.cancelled === true && result.timedOut === false && result.cleanupConfirmed === true && result.exitCode === null
      && result.signal === null ? completion.sha256 : null;
    return { permission: structuredClone(handle.proof), input: structuredClone(handle.input), noProcessCompletionSha256 };
  }

  waitEffect(original: object): Promise<object> {
    return this.handle(original).done;
  }

  cancelEffect(original: object): void {
    this.clientEffectHandles.get(original)?.abort.abort(new EngineError('CANCELLED', 'The exact remote terminal was cancelled'));
  }

  releaseEffect(original: object): void {
    this.clientEffectHandles.delete(original);
  }

  readCompletion(original: object): BackendClientReadProof {
    if (!original || typeof original !== 'object' || types.isProxy(original)) throw new EngineError('BACKEND_ORIGINAL_REQUIRED', 'Client read completion requires its original receipt');
    const proof = this.clientReadCompletions.get(original);
    if (!proof) throw new EngineError('BACKEND_ORIGINAL_REQUIRED', 'The native client read completion receipt is unavailable');
    return structuredClone(proof);
  }

  releaseCompletion(original: object): void {
    this.clientReadCompletions.delete(original); this.retainedClientReads.delete(original);
  }
}
