import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_LIMITS, type ToolCallRecord } from '@moodcode/contracts';
import { SqliteStore } from '../../storage/index.js';
import { ApprovalManager } from '../index.js';

const dbPath = process.argv[2];
const markerPath = process.argv[3];
const control = process.argv[4] === 'allow-control';
if (!dbPath || !markerPath) throw new Error('Expected database path and marker path');

const markerFile = resolve(markerPath);
const workspaceRoot = dirname(resolve(dbPath));
const store = new SqliteStore(dbPath);
const manager = new ApprovalManager(store);
const now = new Date().toISOString();
const workspace = store.putWorkspace({
  id: randomUUID(), root: workspaceRoot, gitRoot: workspaceRoot, branch: null, createdAt: now,
});
const session = store.createSession({
  id: randomUUID(), workspaceId: workspace.id, title: 'Pending approval crash fixture', createdAt: now,
});
const receipt = store.admit({
  sessionId: session.id, requestId: randomUUID(), prompt: 'Wait for approval before writing a fixture marker',
  config: { providerId: 'scripted', modelId: 'local', mode: 'build', limits: { ...DEFAULT_LIMITS } },
});
store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });

// This local test tool has one observable effect and never launches a command.
const tool: ToolCallRecord = {
  id: randomUUID(), runId: receipt.runId, sessionId: session.id, name: 'fixture_marker',
  input: { path: markerFile, content: 'executed' }, state: 'requested',
};
store.commit(receipt.runId, 'tool.requested', { toolCallId: tool.id, name: tool.name }, { tool });
store.commit(receipt.runId, 'tool.awaiting_approval', { toolCallId: tool.id }, {
  tool: { ...tool, state: 'awaiting_approval' },
});
store.commit(receipt.runId, 'run.awaiting_approval', { toolCallId: tool.id }, {
  run: { state: 'awaiting_approval' },
});

const fingerprint = createHash('sha256').update(JSON.stringify({
  runId: receipt.runId, toolCallId: tool.id, toolName: tool.name, input: tool.input,
})).digest('hex');
const waiting = manager.request({
  sessionId: session.id, runId: receipt.runId, toolCallId: tool.id,
  toolName: tool.name, fingerprint, preview: { path: markerFile, content: 'executed' },
}, new AbortController().signal);

void waiting.then((approval) => {
  if (approval.status !== 'allowed') return;
  const current = store.getApproval(approval.id);
  if (current.status !== 'allowed' || current.sessionId !== session.id || current.runId !== receipt.runId
    || current.toolCallId !== tool.id || current.toolName !== tool.name || current.fingerprint !== fingerprint) {
    throw new Error('Fixture approval no longer matches its tool');
  }
  store.commit(receipt.runId, 'run.resumed', { toolCallId: tool.id }, { run: { state: 'running' } });
  store.commit(receipt.runId, 'tool.started', { toolCallId: tool.id }, { tool: { ...tool, state: 'running' } });
  writeFileSync(markerFile, 'executed', 'utf8');
  store.commit(receipt.runId, 'tool.completed', { toolCallId: tool.id }, {
    tool: { ...tool, state: 'completed', output: 'Fixture marker was written' },
  });
  store.commit(receipt.runId, 'run.completed', {}, { run: { state: 'completed' } });
  if (control) {
    clearInterval(keepalive);
    store.close();
    process.stdout.write(`${JSON.stringify({ type: 'effect.completed', runId: receipt.runId, approvalId: approval.id })}\n`);
  }
}).catch(() => {
  // Expiration and storage failure never authorize the marker effect.
  process.stderr.write('Approval fixture wait ended without a completed effect.\n');
  if (control) {
    clearInterval(keepalive);
    store.close();
    process.exitCode = 1;
  }
});

const snapshot = store.getSnapshot(session.id);
const pending = snapshot.approvals.find((approval) => approval.runId === receipt.runId
  && approval.toolCallId === tool.id && approval.status === 'pending');
if (!pending) throw new Error('Fixture did not durably record a pending approval');
process.stdout.write(`${JSON.stringify({
  sessionId: session.id, runId: receipt.runId, toolCallId: tool.id,
  approvalId: pending.id, fingerprint, lastSeq: snapshot.lastSeq,
})}\n`);

// An unresolved promise alone does not keep Node alive. SIGKILL models loss of the owner.
const keepalive = setInterval(() => {}, 1_000);
if (control) queueMicrotask(() => manager.decide(pending.id, 'allow', fingerprint));
