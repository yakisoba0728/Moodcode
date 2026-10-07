import { EngineError } from '@moodcode/contracts';
import { boundedJson } from '../artifacts/validation.js';
import type { McpToolCallObservation, McpToolCallObserver } from '../mcp/execution-observation.js';
import type { EngineStore, ExecutionRecordStore } from '../ports.js';

export interface ApprovedMcpToolOwner {
  sessionId: string; workspaceId: string; runId: string; toolCallId: string; toolName: string;
  turnId?: string; attemptId?: string; approval?: Readonly<{ id: string; fingerprint: string }>;
}

function invalid(): never { throw new EngineError('MCP_EXECUTION_OBSERVATION_INVALID', 'MCP execution requires its exact approved native owner and local request observations.'); }

/** The runner supplies the actual allowed outer approval; the RPC never supplies authority. */
export function createMcpExecutionObserver(store: EngineStore, records: ExecutionRecordStore | undefined, owner: ApprovedMcpToolOwner): McpToolCallObserver {
  const selected = Object.freeze({ ...owner, ...(owner.approval ? { approval: Object.freeze({ ...owner.approval }) } : {}) });
  let request: string | undefined;
  return value => {
    let event: McpToolCallObservation;
    try { event = boundedJson(value, 16_384) as unknown as McpToolCallObservation; } catch { invalid(); }
    if (!event || typeof event !== 'object' || !event.identity || typeof event.identity !== 'object') invalid();
    const identity = JSON.stringify(event.identity);
    if (!records?.createMcpExecution || !records.dispatchMcpExecution || !records.settleMcpExecution || !records.getMcpExecution
      || !selected.turnId || !selected.attemptId || !selected.approval) {
      throw new EngineError('MCP_EXECUTION_STORAGE_REQUIRED', 'MCP tools require native execution storage and an exact allowed approval before dispatch.');
    }
    if (event.phase === 'prepared') {
      if (request !== undefined) invalid();
      const approval = store.getApproval(selected.approval.id);
      if (approval.status !== 'allowed' || approval.fingerprint !== selected.approval.fingerprint
        || approval.toolCallId !== selected.toolCallId || approval.toolName !== selected.toolName
        || approval.runId !== selected.runId || approval.sessionId !== selected.sessionId) invalid();
      const attempt = records.getAttempt(selected.attemptId);
      if (attempt.turnId !== selected.turnId || attempt.runId !== selected.runId || attempt.sessionId !== selected.sessionId) invalid();
      const created = records.createMcpExecution({ ...event.identity, toolCallId: selected.toolCallId, sessionId: selected.sessionId,
        workspaceId: selected.workspaceId, runId: selected.runId, turnId: selected.turnId, attemptId: selected.attemptId,
        providerId: attempt.providerId, modelId: attempt.modelId, ...(attempt.contextRevisionId ? { contextRevisionId: attempt.contextRevisionId } : {}),
        toolName: selected.toolName, approvalId: approval.id, approvalFingerprint: approval.fingerprint, requestProjection: 'mcp-jsonrpc-tools-call-v1' });
      // An idempotent read of an existing receipt never authorizes another send.
      if (created.state !== 'prepared') throw new EngineError('MCP_EXECUTION_ALREADY_DISPATCHED', 'This native tool call already has a dispatch or terminal observation.');
      request = identity;
      return;
    }
    if (request === undefined || request !== identity) invalid();
    if (event.phase === 'dispatch-intent') {
      if (records.getMcpExecution(selected.toolCallId, selected.sessionId).state !== 'prepared') invalid();
      records.dispatchMcpExecution(selected.toolCallId, event.boundary);
    } else if (event.phase === 'settled') {
      records.settleMcpExecution(selected.toolCallId, event.settlement);
    } else invalid();
  };
}
