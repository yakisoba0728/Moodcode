import { EngineError, type JsonObject } from '@moodcode/contracts';
import { boundedJson } from '../artifacts/validation.js';
import { validateTrajectoryOptions, type TrajectoryOptions, type TrajectoryReader } from '../diagnostics/trajectory.js';

export interface PolicyDecisionReceiptPage {
  schemaVersion: 1;
  sessionId: string;
  workspaceId: string;
  afterSeq: number;
  inspectedThroughSeq: number;
  requestedThroughSeq: number | null;
  receipts: Array<{ seq: number; runId: string; toolCallId: string; toolName: string; preparedFingerprint: string; receipt: JsonObject }>;
  truncated: boolean;
  omittedReceipts: number;
  nextCursor: { sessionId: string; afterSeq: number; throughSeq: number | null } | null;
  coverage: 'bounded-native-journal-page';
  sessionFrontier: 'unknown';
  authority: 'observation-only';
}

/** Bounded historical explanation. Returned copies cannot approve or dispatch a tool. */
export function readPolicyDecisionReceipts(reader: TrajectoryReader, options: TrajectoryOptions): PolicyDecisionReceiptPage {
  validateTrajectoryOptions(options);
  const session = reader.getSession(options.sessionId), afterSeq = options.afterSeq ?? 0, limit = options.limit ?? 50, maxBytes = options.maxBytes ?? 65_536;
  const result: PolicyDecisionReceiptPage = { schemaVersion: 1, sessionId: session.id, workspaceId: session.workspaceId, afterSeq, inspectedThroughSeq: afterSeq, requestedThroughSeq: options.throughSeq ?? null, receipts: [], truncated: false, omittedReceipts: 0, nextCursor: null, coverage: 'bounded-native-journal-page', sessionFrontier: 'unknown', authority: 'observation-only' };
  const page = reader.readSessionEvents(session.id, afterSeq, limit);
  for (const event of page) {
    if (event.seq <= result.inspectedThroughSeq || event.sessionId !== session.id) throw new EngineError('POLICY_RECEIPT_SOURCE_INVALID', 'Decision journal page has inconsistent scope or cursor');
    if (options.throughSeq !== undefined && event.seq > options.throughSeq) break;
    if (event.type === 'tool.policy_decision' && (options.runId === undefined || event.runId === options.runId)) {
      const payload = boundedJson(event.payload, 131_072) as JsonObject;
      if (!event.runId || payload.authority !== 'observation-only' || ['toolCallId', 'toolName', 'preparedFingerprint'].some(key => typeof payload[key] !== 'string' || !payload[key] || Buffer.byteLength(payload[key] as string) > 1024) || !payload.receipt || typeof payload.receipt !== 'object' || Array.isArray(payload.receipt)) throw new EngineError('POLICY_RECEIPT_SOURCE_INVALID', 'Decision observation has invalid typed identity');
      result.receipts.push({ seq: event.seq, runId: event.runId, toolCallId: payload.toolCallId as string, toolName: payload.toolName as string, preparedFingerprint: payload.preparedFingerprint as string, receipt: payload.receipt as JsonObject });
      if (Buffer.byteLength(JSON.stringify(result)) > maxBytes - 256) {
        result.receipts.pop(); result.truncated = true;
        // Only a receipt that overflows an empty page can never fit; any other starts the next page.
        if (result.receipts.length === 0) { result.omittedReceipts++; result.inspectedThroughSeq = event.seq; }
        break;
      }
    }
    result.inspectedThroughSeq = event.seq;
  }
  const boundaryReached = options.throughSeq !== undefined && result.inspectedThroughSeq >= options.throughSeq;
  // Native paging may stop at its own byte cap before the count limit. Advance
  // until an empty page or the requested boundary, never infer a global frontier.
  if (!boundaryReached && result.inspectedThroughSeq > afterSeq) result.nextCursor = { sessionId: session.id, afterSeq: result.inspectedThroughSeq, throughSeq: options.throughSeq ?? null };
  return result;
}
