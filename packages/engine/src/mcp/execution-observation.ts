import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import { encodeMessage, type JsonRpcMessage, type JsonRpcRequest, type McpProtocolVersion } from './protocol.js';

export type McpDispatchBoundary = 'http-fetch' | 'stdio-write' | 'legacy-api-entry';
export type McpExecutionReason = 'response' | 'timeout' | 'disconnect' | 'cancel' | 'transport-error' | 'invalid-response' | 'cleanup-error' | 'restart' | 'journal-error' | 'preflight-error';
export interface McpCallIdentity {
  serverId: string; connectionId: string; catalogueRevision: number; remoteTool: string;
  protocolVersion: McpProtocolVersion; transportKind: 'http' | 'stdio'; logicalRpcId: number;
  requestSha256: string; requestBytes: number;
}
export interface McpResponseObservation {
  responseKind: 'tool-result' | 'jsonrpc-error'; responseSha256: string; responseBytes: number; isError?: boolean;
}
export interface McpCallSettlement extends Partial<McpResponseObservation> {
  outcome: 'response-terminal' | 'uncertain' | 'not-dispatched'; reason: McpExecutionReason;
  errorCode?: string; transportCleanupConfirmed: boolean;
}
export type McpToolCallObservation =
  | { phase: 'prepared'; identity: Readonly<McpCallIdentity> }
  | { phase: 'dispatch-intent'; identity: Readonly<McpCallIdentity>; boundary: McpDispatchBoundary }
  | { phase: 'settled'; identity: Readonly<McpCallIdentity>; settlement: Readonly<McpCallSettlement> };
/** Host binds its actual native owner and allowed outer approval to these local observations. */
export type McpToolCallObserver = (event: McpToolCallObservation) => void;
export const MCP_EXECUTION_LIMITS = Object.freeze({ cleanupGraceMs: 250, closeGraceMs: 1000 });

function observeSynchronously(observer: McpToolCallObserver | undefined, event: McpToolCallObservation): void {
  const returned: unknown = observer?.(event);
  const asynchronous = () => { throw new EngineError('MCP_EXECUTION_OBSERVER_ASYNC', 'MCP execution observers must complete synchronously'); };
  if (types.isPromise(returned)) {
    // Observe a rejected host Promise without depending on a supplied then getter.
    void Promise.prototype.then.call(returned, undefined, () => {});
    asynchronous();
  }
  if (returned && (typeof returned === 'object' || typeof returned === 'function')) {
    if (types.isProxy(returned)) asynchronous();
    let current: object | null = returned;
    for (let depth = 0; current && depth < 8; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'then');
      if (descriptor) { if (descriptor.get || descriptor.set || typeof descriptor.value === 'function') asynchronous(); break; }
      current = Object.getPrototypeOf(current) as object | null;
    }
  }
}

export function mcpResponseObservation(message: JsonRpcMessage, responseKind: McpResponseObservation['responseKind'], isError?: boolean): McpResponseObservation {
  const body = encodeMessage(message);
  return { responseKind, responseSha256: createHash('sha256').update(body).digest('hex'), responseBytes: Buffer.byteLength(body), ...(isError === undefined ? {} : { isError }) };
}

/** Receipt events never contain request arguments, headers, credentials or returned content. */
export class McpCallObservation {
  readonly identity: Readonly<McpCallIdentity>;
  private intended = false;
  private journalUncertain = false;
  private finished = false;
  constructor(identity: Omit<McpCallIdentity, 'logicalRpcId' | 'requestSha256' | 'requestBytes'>, message: JsonRpcRequest, private readonly observer?: McpToolCallObserver) {
    if (message.method !== 'tools/call' || typeof message.id !== 'number' || !Number.isSafeInteger(message.id)) throw new EngineError('MCP_INVALID_MESSAGE', 'Execution observations require an exact tools/call identity');
    const body = encodeMessage(message);
    this.identity = Object.freeze({ ...identity, logicalRpcId: message.id, requestSha256: createHash('sha256').update(body).digest('hex'), requestBytes: Buffer.byteLength(body) });
    observeSynchronously(this.observer, { phase: 'prepared', identity: this.identity });
  }
  get dispatched(): boolean { return this.intended; }
  beforeSend(boundary: McpDispatchBoundary): void {
    if (this.finished || this.intended) throw new EngineError('MCP_DISPATCH_STATE', 'MCP execution can cross its dispatch boundary only once');
    // A rejected synchronous durable intent must prevent the actual fetch/write.
    try { observeSynchronously(this.observer, { phase: 'dispatch-intent', identity: this.identity, boundary }); }
    catch { this.journalUncertain = true; throw new EngineError('MCP_EXECUTION_RECORD_FAILED', 'MCP dispatch intent could not be recorded', { effectsUncertain: true, executionBlocked: true }); }
    this.intended = true;
  }
  settle(settlement: McpCallSettlement): void {
    if (this.finished) return;
    this.finished = true;
    try { observeSynchronously(this.observer, { phase: 'settled', identity: this.identity, settlement: Object.freeze({ ...settlement }) }); }
    catch { throw new EngineError('MCP_EXECUTION_RECORD_FAILED', 'MCP execution settlement could not be recorded', { effectsUncertain: this.intended || this.journalUncertain, cleanupUncertain: !settlement.transportCleanupConfirmed, executionBlocked: this.intended || this.journalUncertain }); }
  }
}

export function mcpExecutionFailure(error: EngineError, options: { effectsUncertain: boolean; cleanupConfirmed: boolean }): EngineError {
  return new EngineError(error.code, error.message, { ...error.details, effectsUncertain: options.effectsUncertain, transportCleanupConfirmed: options.cleanupConfirmed, ...(options.cleanupConfirmed ? {} : { cleanupUncertain: true }) });
}
export function mcpFailureReason(error: EngineError): McpExecutionReason {
  if (error.code === 'MCP_REQUEST_TIMEOUT') return 'timeout';
  if (error.code === 'MCP_CANCELLED' || error.code === 'CREDENTIAL_CANCELLED') return 'cancel';
  if (error.code === 'MCP_DISCONNECTED' || error.code === 'MCP_SESSION_EXPIRED') return 'disconnect';
  if (error.code === 'MCP_EXECUTION_RECORD_FAILED') return 'journal-error';
  if (['MCP_INVALID_MESSAGE', 'MCP_INVALID_TOOL_RESULT', 'MCP_MESSAGE_LIMIT', 'MCP_RESPONSE_ID_MISMATCH', 'MCP_INPUT_REQUIRED_UNSUPPORTED', 'MCP_UNSUPPORTED_SERVER_REQUEST'].includes(error.code)) return 'invalid-response';
  return 'transport-error';
}

/** Settlement of this local Promise is not proof that the peer stopped or reverted effects. */
export async function joinMcpOperations(operations: readonly Promise<unknown>[], graceMs: number = MCP_EXECUTION_LIMITS.cleanupGraceMs): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(operations).then(results => results.every(result => result.status === 'fulfilled' || !(result.reason instanceof EngineError && (result.reason.details?.cleanupUncertain === true || result.reason.details?.transportCleanupConfirmed === false)))),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), graceMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export function validateMcpToolResult(value: JsonObject): void {
  if (value.resultType !== undefined && value.resultType !== 'complete') {
    if (value.resultType === 'input_required') throw new EngineError('MCP_INPUT_REQUIRED_UNSUPPORTED', 'MCP server requires a host interaction that this adapter has not enabled');
    throw new EngineError('MCP_INVALID_TOOL_RESULT', 'MCP tool result is not a supported terminal response');
  }
  if (!Array.isArray(value.content) || value.content.length > 64 || value.isError !== undefined && typeof value.isError !== 'boolean') throw new EngineError('MCP_INVALID_TOOL_RESULT', 'MCP tool result content is invalid');
  for (const block of value.content) {
    if (!block || typeof block !== 'object' || Array.isArray(block) || typeof block.type !== 'string' || !block.type
      || block.type === 'text' && typeof block.text !== 'string'
      || block.type === 'resource' && (!block.resource || typeof block.resource !== 'object' || Array.isArray(block.resource))) throw new EngineError('MCP_INVALID_TOOL_RESULT', 'MCP tool result contains an invalid content block');
  }
}
