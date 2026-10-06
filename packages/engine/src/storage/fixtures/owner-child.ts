import { DEFAULT_LIMITS, type ApprovalRecord, type ToolCallRecord } from '@moodcode/contracts';
import { SqliteStore } from '../index.js';

const dbPath = process.argv[2];
const mode = process.argv[3];
if (!dbPath || (mode !== 'running-tool' && mode !== 'pending-approval')) {
  throw new Error('Expected database path and recovery scenario');
}

const store = new SqliteStore(dbPath);
const now = new Date().toISOString();
const workspace = store.putWorkspace({
  id: `workspace-${mode}`, root: process.cwd(), gitRoot: process.cwd(), branch: null, createdAt: now,
});
const session = store.createSession({
  id: `session-${mode}`, workspaceId: workspace.id, title: 'Crash recovery fixture', createdAt: now,
});
const receipt = store.admit({
  sessionId: session.id,
  requestId: `request-${mode}`,
  prompt: 'Exercise interrupted recovery without repeating an effect',
  config: { providerId: 'scripted', modelId: 'local', mode: 'build', limits: { ...DEFAULT_LIMITS } },
});
store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
const tool: ToolCallRecord = {
  id: `tool-${mode}`, runId: receipt.runId, sessionId: session.id, name: 'run_command',
  input: { command: 'fixture command; never executed' }, state: 'requested',
};
store.commit(receipt.runId, 'tool.requested', { toolCallId: tool.id }, { tool });

let approvalId: string | undefined;
if (mode === 'running-tool') {
  store.commit(receipt.runId, 'tool.started', { toolCallId: tool.id }, { tool: { ...tool, state: 'running' } });
} else {
  const approval: ApprovalRecord = {
    id: `approval-${mode}`, sessionId: session.id, runId: receipt.runId, toolCallId: tool.id,
    toolName: tool.name, fingerprint: 'fixture-fingerprint', preview: { command: 'fixture command; never executed' },
    status: 'pending', createdAt: now,
  };
  approvalId = approval.id;
  store.commit(receipt.runId, 'approval.requested', { approvalId: approval.id, toolCallId: tool.id }, {
    run: { state: 'awaiting_approval' }, tool: { ...tool, state: 'awaiting_approval' }, approval,
  });
}

process.stdout.write(`${JSON.stringify({
  sessionId: session.id, runId: receipt.runId, toolId: tool.id, approvalId,
  lastSeq: store.getSnapshot(session.id).lastSeq,
})}\n`);
// The process represents a live engine owner; keep its store reachable even when
// no client command is pending. Otherwise SQLite handle finalizers can release
// the lock while this fixture's empty timer is still alive.
setInterval(() => { store.getRun(receipt.runId); }, 1_000);
