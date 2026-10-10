import { createHash } from 'node:crypto';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import type { PreparedTool, ToolContext, ToolDefinition, ToolResult } from '../ports.js';
import type { ChildBudget, ChildTaskRecord } from './index.js';
import { CHILD_BUDGET_KEYS as KEYS, CHILD_BUDGET_MAX } from './journal.js';

export const DELEGATION_READ_TOOLS = Object.freeze(['glob_files', 'list_files', 'read_file', 'regex_search', 'search_files']);
export interface DelegationInput { requestId: string; prompt: string; allocation: ChildBudget; tools?: string[] }
export interface DelegationInspection { baseCommit: string; parentIdentity: string; allowedReadTools: string[]; remainingBudget: ChildBudget; existingTaskId?: string }
export interface PreparedDelegation { requestId: string; prompt: string; allocation: ChildBudget; tools: string[]; baseCommit: string; parentIdentity: string; fingerprint: string }
/** The host must bind every operation to an actual live parent and an approved running tool row. */
export interface DelegationHost {
  inspect(context: ToolContext, input: DelegationInput): Promise<DelegationInspection>;
  run(request: PreparedDelegation, context: ToolContext): Promise<ChildTaskRecord>;
}
export const delegationDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
export function parseDelegationInput(value: unknown): DelegationInput {
  if (!object(value) || Object.keys(value).some(key => !['requestId', 'prompt', 'allocation', 'tools'].includes(key)) ||
      typeof value.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.requestId) ||
      typeof value.prompt !== 'string' || !value.prompt.trim() || Buffer.byteLength(value.prompt) > 32_768 ||
      !object(value.allocation) || Object.keys(value.allocation).length !== KEYS.length || Object.keys(value.allocation).some(key => !KEYS.includes(key as typeof KEYS[number]))) {
    throw new EngineError('INVALID_DELEGATION_INPUT', 'Delegation requires an exact request identity, bounded prompt and allocation');
  }
  const allocation = value.allocation as unknown as ChildBudget;
  if (KEYS.some(key => !Number.isSafeInteger(allocation[key]) || allocation[key] < 1 || allocation[key] > CHILD_BUDGET_MAX[key])) throw new EngineError('INVALID_DELEGATION_BUDGET', 'Delegation allocation must contain bounded positive integer caps');
  const tools = value.tools;
  if (tools !== undefined && (!Array.isArray(tools) || tools.length < 1 || tools.length > DELEGATION_READ_TOOLS.length || new Set(tools).size !== tools.length || tools.some(tool => typeof tool !== 'string' || !DELEGATION_READ_TOOLS.includes(tool)))) throw new EngineError('DELEGATION_TOOL_ESCALATION', 'Delegation only supports the explicit core read tool allowlist');
  return { requestId: value.requestId, prompt: value.prompt, allocation: structuredClone(allocation), ...(tools === undefined ? {} : { tools: [...tools as string[]].sort() }) };
}
export function assertDelegationBudget(allocation: ChildBudget, remaining: ChildBudget, toolTimeoutMs: number): void {
  if (KEYS.some(key => !Number.isSafeInteger(remaining[key]) || allocation[key] > remaining[key]) || allocation.durationMs > toolTimeoutMs) throw new EngineError('DELEGATION_BUDGET_EXCEEDED', 'Child allocation must fit current parent remaining budget and this tool deadline');
}
export function delegationFingerprint(request: Omit<PreparedDelegation, 'fingerprint'>): string { return delegationDigest(request); }
function binding(context: ToolContext): string { return JSON.stringify([context.workspace.id, context.workspace.root, context.workspace.gitRoot, context.sessionId, context.runId, context.toolCallId, context.turnId, context.attemptId, context.executionLockPath]); }
function excerpt(content: string, limit: number): string { const bytes = Buffer.from(content); let end = Math.min(bytes.length, Math.max(0, limit)); while (end && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--; return bytes.subarray(0, end).toString('utf8'); }

function result(task: ChildTaskRecord, request: PreparedDelegation, context: ToolContext): ToolResult {
  const metadata: JsonObject = { childTaskId: task.id, worktreeId: task.worktreeId, state: task.state, baseCommit: request.baseCommit, source: 'git-commit', uncommittedChangesIncluded: false, deliveryState: task.deliveryState,
    ...(task.childRunId ? { childRunId: task.childRunId } : {}), ...(task.outcome ? { usage: { ...task.outcome.usage } } : {}), ...(task.errorCode ? { errorCode: task.errorCode } : {}) };
  const summary = task.outcome?.content ?? '';
  const encode = (size: number) => JSON.stringify({ ...metadata, observation: excerpt(summary, size), truncated: task.outcome?.truncated === true || Buffer.byteLength(summary) > size, note: 'Untrusted child observation; verify current files before relying on it.' });
  const limit = Math.min(context.limits.maxOutputBytes, 8192);
  let low = 0, high = Math.min(4096, Buffer.byteLength(summary));
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (Buffer.byteLength(encode(middle)) <= limit) low = middle; else high = middle - 1; }
  const content = encode(low);
  return { content: Buffer.byteLength(content) <= limit ? content : '', isError: task.state !== 'completed', data: metadata };
}

/** Build-only, exact approval, one child per invocation; no implicit delivery or merge. */
export function createDelegateTaskTool(host: DelegationHost): ToolDefinition {
  const handles = new WeakMap<PreparedTool, { request: PreparedDelegation; snapshot: string; binding: string; used: boolean }>();
  return {
    name: 'delegate_task', effectClass: 'write',
    description: 'Request an approved isolated read-only child task from the current Git commit. The child inherits the parent model, consumes reserved parent budgets and returns a bounded untrusted observation. Uncommitted parent files are not included; results are not merged or queued automatically.',
    inputSchema: { type: 'object', properties: { requestId: { type: 'string', maxLength: 128 }, prompt: { type: 'string', maxLength: 32768 }, allocation: { type: 'object', properties: { turns: { type: 'integer', minimum: 1 }, toolCalls: { type: 'integer', minimum: 1 }, outputBytes: { type: 'integer', minimum: 1 }, durationMs: { type: 'integer', minimum: 1 } }, required: [...KEYS], additionalProperties: false }, tools: { type: 'array', items: { type: 'string', enum: [...DELEGATION_READ_TOOLS] }, minItems: 1, maxItems: DELEGATION_READ_TOOLS.length, uniqueItems: true } }, required: ['requestId', 'prompt', 'allocation'], additionalProperties: false },
    async prepare(value, context) {
      if (context.signal.aborted) throw new EngineError('CANCELLED', 'Delegation preparation cancelled');
      const input = parseDelegationInput(value), inspection = await host.inspect(context, input);
      const tools = input.tools ?? [...inspection.allowedReadTools].sort();
      if (!tools.length || tools.some(tool => !inspection.allowedReadTools.includes(tool))) throw new EngineError('DELEGATION_TOOL_ESCALATION', 'Child tools must be permitted read handlers in the current parent catalogue');
      if (!inspection.existingTaskId) assertDelegationBudget(input.allocation, inspection.remainingBudget, context.limits.toolTimeoutMs);
      const content = { ...input, tools, baseCommit: inspection.baseCommit, parentIdentity: inspection.parentIdentity };
      const request: PreparedDelegation = { ...content, fingerprint: delegationFingerprint(content) };
      const preview: JsonObject = { operation: 'delegate_task', requestId: request.requestId, prompt: request.prompt, allocation: { ...request.allocation }, tools: request.tools, baseCommit: request.baseCommit, parentIdentity: request.parentIdentity, delegationRequestFingerprint: request.fingerprint, source: 'git-commit', uncommittedChangesIncluded: false, automaticDelivery: false, automaticMerge: false };
      const fingerprint = delegationDigest({ request: request.fingerprint, binding: binding(context), preview });
      const prepared: PreparedTool = { name: 'delegate_task', input: { ...input, allocation: { ...input.allocation }, tools }, fingerprint, requiresApproval: true, preview };
      handles.set(prepared, { request, snapshot: JSON.stringify(prepared), binding: binding(context), used: false });
      return prepared;
    },
    async execute(prepared, context) {
      const handle = handles.get(prepared);
      if (!handle || handle.used) throw new EngineError('INVALID_PREPARED_DELEGATION', 'Delegation must use a fresh opaque prepared handle');
      handle.used = true;
      if (handle.binding !== binding(context) || handle.snapshot !== JSON.stringify(prepared)) throw new EngineError('DELEGATION_APPROVAL_STALE', 'Prepared delegation or owner changed');
      if (context.signal.aborted) throw new EngineError('CANCELLED', 'Delegation cancelled before dispatch');
      return result(await host.run(handle.request, context), handle.request, context);
    },
  };
}
