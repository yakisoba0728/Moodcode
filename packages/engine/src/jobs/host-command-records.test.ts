import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { knowledgeHash } from '../knowledge/validation.js';
import { signJobData } from './validation.js';
import { sandboxSign } from '../sandbox/types.js';
import { validateHostCommandRecord } from './host-command-records.js';

/** Immutable journal DATA fixture; it owns no process or native authority. */
function record(platform: unknown) {
  const sha = 'a'.repeat(64);
  const body = { version: 1, workspaceId: 'workspace', sessionId: 'session',
    input: { command: 'echo fixture', cwd: resolve('unopened-host-journal-fixture'), timeoutMs: 1000 },
    rootBindingSha256: sha, cwdIdentitySha256: sha, platform, policyVersion: 0,
    limits: { maxDurationMs: 1000, maxOutputBytes: 4096 } };
  return signJobData({ version: 1, id: 'revision', jobId: 'job', workspaceId: 'workspace', sessionId: 'session',
    revision: 1, previousId: null, kind: 'denied', state: 'denied', requestId: 'request', requestSha256: sha,
    preview: { ...body, fingerprint: knowledgeHash(body) },
    owner: { epoch: sha, rootBindingSha256: sha, beforeSnapshotSha256: sha },
    pid: null, completion: null, outputSeq: 0, outputObservedBytes: 0, outputStoredBytes: 0,
    payload: { decision: 'deny' }, createdAt: '2026-10-09T00:00:00.000Z' });
}

test('independent host journal retains exact Windows and historical POSIX platform evidence', () => {
  for (const platform of ['win32', 'darwin', 'linux', 'freebsd']) {
    const source = record(platform), validated = validateHostCommandRecord(source);
    assert.deepEqual(validated, source); assert.equal(validated.preview.platform, platform);
  }
});

test('independent host journal rejects unsupported platforms and unbound preview rewrites', () => {
  for (const platform of ['windows', 'unsupported', '', ['win32'], null])
    assert.throws(() => validateHostCommandRecord(record(platform)), { code: 'HOST_COMMAND_EVIDENCE_INVALID' });
  const source = record('win32');
  assert.throws(() => validateHostCommandRecord(signJobData({ ...source,
    preview: { ...source.preview, platform: 'linux' } })), { code: 'HOST_COMMAND_EVIDENCE_INVALID' });
});

test('Windows host journal never accepts a Darwin-only sandbox launch', () => {
  const source = record('win32'), { fingerprint: _fingerprint, ...body } = source.preview;
  const previewBody = { ...body, sandbox: sandboxSign({ version: 1, backend: 'darwin-seatbelt-v1', executable: '/usr/bin/sandbox-exec', profile: '(version 1)' }) };
  assert.throws(() => validateHostCommandRecord(signJobData({ ...source,
    preview: { ...previewBody, fingerprint: knowledgeHash(previewBody) } })), { code: 'HOST_COMMAND_EVIDENCE_INVALID' });
});
