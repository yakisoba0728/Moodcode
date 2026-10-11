import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIMITS } from '@moodcode/contracts';
import type { PreparedTool, ToolContext } from '../ports.js';
import { preparedRequests, workspaceCallBinding } from './prepared-requests.js';

const context: ToolContext = { workspace: { id: 'workspace', root: '/workspace', gitRoot: '/workspace', branch: null, createdAt: new Date(0).toISOString() },
  sessionId: 's', runId: 'r', toolCallId: 'call', turnId: 'turn', attemptId: 'attempt', signal: new AbortController().signal,
  limits: { ...DEFAULT_LIMITS }, artifactDir: '/artifacts', recordCheckpoint() {} };
const other = { ...context, attemptId: 'other' };
const request = (): PreparedTool => ({ name: 'tool', input: {}, fingerprint: 'f', requiresApproval: false, preview: {} });

test('consume uses a request before its staleness check, so a stale execute cannot be retried', () => {
  const requests = preparedRequests<string>(workspaceCallBinding), prepared = requests.remember(request(), context, 'data');
  assert.equal(requests.peek(prepared)?.used, false);
  assert.equal(requests.consume(prepared, ['MISSING', 'missing']), 'data');
  assert.equal(requests.current(prepared, other), false);
  assert.equal(requests.peek(prepared)?.used, true);
  assert.throws(() => requests.consume(prepared, ['MISSING', 'missing']), { code: 'MISSING', message: 'missing' });
});

test('claim leaves a stale or changed request usable once by its preparing call', () => {
  const requests = preparedRequests(workspaceCallBinding), prepared = requests.remember(request(), context);
  assert.throws(() => requests.claim(prepared, other, ['STALE', 'stale']), { code: 'STALE' });
  prepared.preview.changed = true;
  assert.throws(() => requests.claim(prepared, context, ['STALE', 'stale']), { code: 'STALE' });
  delete prepared.preview.changed;
  requests.claim(prepared, context, ['STALE', 'stale']);
  assert.throws(() => requests.claim(prepared, context, ['STALE', 'stale']), { code: 'STALE' });
  assert.throws(() => requests.claim({ ...prepared }, context, ['STALE', 'stale']), { code: 'STALE' });
});
