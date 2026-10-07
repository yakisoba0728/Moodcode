import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineError, type SessionEventV2 } from '@moodcode/contracts';
import { readPolicyDecisionReceipts } from './decision-receipts.js';
import type { TrajectoryReader } from '../diagnostics/trajectory.js';
const event = (seq: number, summary = 'bounded'): SessionEventV2 => ({ schemaVersion: 2, stream: 'session-v2', eventId: `event-${seq}`, sessionId: 's', runId: 'r', seq, timestamp: new Date().toISOString(), type: 'tool.policy_decision', payload: { authority: 'observation-only', toolCallId: `t-${seq}`, toolName: 'read_file', preparedFingerprint: 'fingerprint', receipt: { roleResource: { decision: 'allow', summary } } } });
const reader = (page: SessionEventV2[]): TrajectoryReader => ({ getSession: () => ({ id: 's', workspaceId: 'w', title: '', createdAt: new Date().toISOString() }), readSessionEvents: (_sessionId, after, limit) => page.filter(item => item.seq > after).slice(0, limit) });
test('receipt pages are detached explanations, preserve native cursor, and never claim the session frontier', () => {
  const original = [event(1), { ...event(2), type: 'message.part.updated' }, event(3)];
  const page = readPolicyDecisionReceipts(reader(original), { sessionId: 's', throughSeq: 3, limit: 3 });
  assert.deepEqual(page.receipts.map(item => item.seq), [1, 3]); assert.equal(page.inspectedThroughSeq, 3); assert.equal(page.nextCursor, null); assert.equal(page.authority, 'observation-only'); assert.equal(page.sessionFrontier, 'unknown');
  page.receipts[0]!.receipt.roleResource = { changed: true };
  assert.equal((original[0]!.payload.receipt as { roleResource: { decision: string } }).roleResource.decision, 'allow');
});
test('an oversized observation is omitted explicitly and advances the cursor without an endless empty page', () => {
  const source = [event(1, 'x'.repeat(4000)), event(2)];
  const first = readPolicyDecisionReceipts(reader(source), { sessionId: 's', maxBytes: 2048 });
  assert.equal(first.receipts.length, 0); assert.equal(first.omittedReceipts, 1); assert.equal(first.truncated, true); assert.equal(first.nextCursor!.afterSeq, 1); assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 2048);
  const next = readPolicyDecisionReceipts(reader(source), { sessionId: 's', afterSeq: first.nextCursor!.afterSeq, maxBytes: 2048 }); assert.equal(next.receipts[0]!.seq, 2);
});
test('a short native page retains a continuation because its byte frontier can be earlier than its count frontier', () => {
  const page = readPolicyDecisionReceipts(reader([event(1)]), { sessionId: 's', limit: 100 }); assert.equal(page.nextCursor!.afterSeq, 1);
  assert.equal(readPolicyDecisionReceipts(reader([]), { sessionId: 's', afterSeq: 1 }).nextCursor, null);
});
test('receipt selection rejects getters before any source read and rejects inconsistent native scope', () => {
  let reads = 0; const source = reader([event(1)]); source.getSession = () => { reads++; throw new Error('Unexpected read'); };
  const options = { sessionId: 's' }; Object.defineProperty(options, 'runId', { enumerable: true, get() { throw new Error('Getter executed'); } });
  assert.throws(() => readPolicyDecisionReceipts(source, options), (error: unknown) => error instanceof EngineError && error.code === 'INVALID_TRAJECTORY_OPTIONS'); assert.equal(reads, 0);
  assert.throws(() => readPolicyDecisionReceipts(reader([{ ...event(1), sessionId: 'other' }]), { sessionId: 's' }), (error: unknown) => error instanceof EngineError && error.code === 'POLICY_RECEIPT_SOURCE_INVALID');
});
