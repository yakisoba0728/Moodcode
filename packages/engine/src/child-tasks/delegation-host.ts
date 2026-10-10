import { realpath } from 'node:fs/promises';
import { EngineError, type Run } from '@moodcode/contracts';
import type { MoodcodeEngine } from '../engine.js';
import type { ToolContext } from '../ports.js';
import { acquireExecutionLock } from '../tools/command/execution-lock.js';
import { delegationBaseCommit } from '../worktrees/safe-checkout.js';
import type { WorktreeManager } from '../worktrees/index.js';
import type { ChildTaskManager, ChildTaskRecord } from './index.js';
import type { EngineChildRequest } from './engine-host.js';
import { DELEGATION_READ_TOOLS, assertDelegationBudget, delegationDigest, delegationFingerprint, parseDelegationInput, type DelegationHost, type DelegationInput, type DelegationInspection, type PreparedDelegation } from './delegation.js';
import { childRequestFingerprint, childRequestKind } from './storage-binding.js';

export interface EngineDelegationPorts {
  engine: MoodcodeEngine;
  worktrees: WorktreeManager;
  tasks: ChildTaskManager;
  executionLockPath: string;
  start(request: EngineChildRequest, signal: AbortSignal): Promise<ChildTaskRecord>;
}

const delegatedRequestId = (runId: string, requestId: string): string => `delegate:${runId}:${requestId}`;
function delegatedRequest(runId: string, sessionId: string, input: Pick<DelegationInput, 'requestId' | 'prompt' | 'allocation'>, worktreeId: string, tools: string[]): EngineChildRequest {
  return { sessionId, requestId: delegatedRequestId(runId, input.requestId), parentRunId: runId, worktreeId, prompt: input.prompt, tools, allocation: input.allocation };
}

/** A scoped capability for an actual approved serial tool; never acquires a second workspace lease. */
export function createApprovedDelegationHost(ports: EngineDelegationPorts): DelegationHost {
  const claimed = new Set<string>();
  function owner(context: ToolContext, phase: 'prepare' | 'execute', fingerprint?: string): Run {
    if (context.signal.aborted) throw new EngineError('CANCELLED', 'Delegation owner was cancelled');
    if (context.executionLockPath !== ports.executionLockPath) throw new EngineError('DELEGATION_OWNER_MISMATCH', 'Delegation requires the engine-owned workspace effect lock');
    const run = ports.engine.store.getRun(context.runId), session = ports.engine.store.getSession(context.sessionId), workspace = ports.engine.store.getWorkspace(run.workspaceId);
    const tool = ports.engine.store.getToolCall(context.toolCallId);
    if (run.state !== 'running' || run.config.mode !== 'build' || run.sessionId !== context.sessionId || session.workspaceId !== run.workspaceId || workspace.id !== context.workspace.id || workspace.root !== context.workspace.root || workspace.gitRoot !== context.workspace.gitRoot ||
        tool.sessionId !== run.sessionId || tool.runId !== run.id || tool.name !== 'delegate_task' || tool.state !== (phase === 'execute' ? 'running' : 'requested')) throw new EngineError('DELEGATION_OWNER_MISMATCH', 'Delegation requires this live Build Run and its actual active tool row');
    // Obtaining this signal checks the coordinator's live ownership, beyond a persisted Run state.
    if (ports.engine.coordinator.getRunCancellationSignal(run.id).aborted) throw new EngineError('CANCELLED', 'Parent Run is cancelled');
    if (phase === 'execute') {
      const approvals = ports.engine.store.listToolApprovals(tool.id);
      if (!approvals.some(approval => approval.status === 'allowed' && approval.runId === run.id && approval.sessionId === run.sessionId && approval.toolName === tool.name && approval.toolCallId === tool.id && approval.preview.operation === 'delegate_task' && approval.preview.delegationRequestFingerprint === fingerprint)) throw new EngineError('DELEGATION_APPROVAL_REQUIRED', 'Delegation requires a matching allowed approval for this exact tool request');
    }
    return run;
  }
  async function inspect(context: ToolContext, input: DelegationInput, phase: 'prepare' | 'execute', fingerprint?: string): Promise<DelegationInspection> {
    const run = owner(context, phase, fingerprint);
    if (await realpath(context.workspace.root) !== context.workspace.root) throw new EngineError('DELEGATION_OWNER_MISMATCH', 'Parent workspace root changed or is not canonical');
    const profile = ports.engine.profiles.forRun(run.sessionId, run.config);
    const catalogue = ports.engine.toolRuntime.catalogue('engine', run.config.mode, profile?.tools);
    const exposed = new Set(ports.engine.getCapabilities().tools.map(tool => tool.name));
    const allowedReadTools = DELEGATION_READ_TOOLS.filter(name => exposed.has(name) && catalogue.tools.some(tool => tool.name === name) && ports.engine.toolRuntime.resolve(catalogue, name).effectClass === 'read');
    const baseCommit = await delegationBaseCommit(context.workspace.root, context.signal);
    owner(context, phase, fingerprint);
    const requestId = delegatedRequestId(run.id, input.requestId), existing = ports.tasks.list(run.sessionId).find(task => task.requestId === requestId);
    if (existing) {
      const expected = delegatedRequest(run.id, run.sessionId, input, existing.worktreeId, input.tools ?? [...allowedReadTools]);
      const stored = ports.engine.store.getSessionDocument(run.sessionId, childRequestKind(requestId));
      const worktree = ports.worktrees.get(run.sessionId, existing.worktreeId);
      if (stored?.data.fingerprint !== childRequestFingerprint(expected) || worktree.baseCommit !== baseCommit || worktree.baseRoot !== context.workspace.root) throw new EngineError('CHILD_REQUEST_CONFLICT', 'Delegation request already belongs to different content, allocation, commit or tools');
    }
    return { baseCommit, allowedReadTools: [...allowedReadTools], parentIdentity: delegationDigest({ runId: run.id, sessionId: run.sessionId, workspaceId: run.workspaceId, root: context.workspace.root, gitRoot: context.workspace.gitRoot, config: run.config, allowedReadTools }), remainingBudget: ports.engine.coordinator.getRemainingChildBudget(run.id), ...(existing ? { existingTaskId: existing.id } : {}) };
  }
  return {
    inspect: (context, input) => inspect(context, input, 'prepare'),
    async run(value: PreparedDelegation, context: ToolContext): Promise<ChildTaskRecord> {
      const request = structuredClone(value), { fingerprint, ...content } = request;
      const normalized = parseDelegationInput({ requestId: request.requestId, prompt: request.prompt, allocation: request.allocation, tools: request.tools });
      if (delegationFingerprint(content) !== fingerprint || JSON.stringify(normalized.tools) !== JSON.stringify(request.tools)) throw new EngineError('DELEGATION_APPROVAL_STALE', 'Delegation request fingerprint or canonical tool list changed');
      const current = await inspect(context, normalized, 'execute', fingerprint);
      if (current.baseCommit !== request.baseCommit || current.parentIdentity !== request.parentIdentity || request.tools.some(name => !current.allowedReadTools.includes(name))) throw new EngineError('DELEGATION_APPROVAL_STALE', 'Parent commit, profile or read catalogue changed since approval preparation');
      if (!current.existingTaskId) assertDelegationBudget(request.allocation, current.remainingBudget, context.limits.toolTimeoutMs);
      if (claimed.has(context.toolCallId) || claimed.size >= 256) throw new EngineError('DELEGATION_TOOL_REUSED', 'This delegation host tool was already used or its invocation bound was reached');
      claimed.add(context.toolCallId);
      const worktreeRequestId = `delegate:${delegationDigest([context.runId, request.requestId]).slice(0, 40)}`;
      let worktreeId: string;
      const lock = acquireExecutionLock(ports.executionLockPath);
      let cleanupConfirmed = true;
      try {
        owner(context, 'execute', fingerprint);
        const worktree = await ports.worktrees.create({ sessionId: context.sessionId, requestId: worktreeRequestId, workspace: context.workspace, reference: request.baseCommit, safeCheckout: true }, context.signal);
        if (worktree.state === 'failed' || worktree.state === 'removed') throw new EngineError('CHILD_WORKTREE_NOT_READY', 'Delegation worktree for this request already failed or was removed');
        if (worktree.state !== 'ready' || worktree.baseCommit !== request.baseCommit || worktree.baseRoot !== context.workspace.root || worktree.workspaceId !== context.workspace.id) throw new EngineError('CLEANUP_UNCERTAIN', 'Delegation worktree ownership or preparation is unconfirmed');
        worktreeId = worktree.id;
        owner(context, 'execute', fingerprint);
      } catch (error) {
        // A failed journal read/update cannot prove that Git effects stopped.
        // Set the conservative value before inspecting possibly damaged state.
        cleanupConfirmed = false;
        try {
          const record = ports.worktrees.list(context.sessionId).find(item => item.requestId === worktreeRequestId);
          cleanupConfirmed = !record || !['creating', 'booting', 'cleaning', 'uncertain'].includes(record.state);
        } catch { /* Keep the active marker when durable observation itself fails. */ }
        if (error instanceof EngineError && error.code.includes('UNCERTAIN')) cleanupConfirmed = false;
        if (!cleanupConfirmed) throw new EngineError('CLEANUP_UNCERTAIN', 'Delegation worktree preparation or cleanup is unconfirmed; its effect marker and path were retained');
        throw error;
      } finally { lock.release(cleanupConfirmed); }
      owner(context, 'execute', fingerprint);
      if (!current.existingTaskId) assertDelegationBudget(request.allocation, ports.engine.coordinator.getRemainingChildBudget(context.runId), context.limits.toolTimeoutMs);
      const task = await ports.start(delegatedRequest(context.runId, context.sessionId, request, worktreeId, request.tools), context.signal);
      const terminal = await ports.tasks.wait(context.sessionId, task.id);
      if (terminal.state === 'uncertain') throw new EngineError('CLEANUP_UNCERTAIN', 'Child dispatch or cleanup is unconfirmed; its worktree owner was retained');
      return terminal;
    },
  };
}
