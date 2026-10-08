import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { JsonObject } from '@moodcode/contracts';
import { knowledgeHash } from '../knowledge/validation.js';
import { signJobData } from './validation.js';
import { sandboxSign } from '../sandbox/types.js';
import { validateHostCommandRecord } from './host-command-records.js';
import { jobFixture } from './fixtures/job.js';
import { reserveExecutionLock, readExecutionLockReservation, type ExecutionLockMarker } from '../tools/command/execution-lock.js';

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

/** Real SQLite journal DATA; no command, OS process, or effect marker is created. */
async function markerJournal(t: TestContext, options: { platform?: NodeJS.Platform; reserved?: boolean; approved?: boolean } = {}) {
  const f = await jobFixture(t, { createTerminal: false, jobs: false });
  const journal = f.engine.store.createHostCommandStorage(), path = f.dbPath + '.effects.sqlite';
  const marker = { ...readExecutionLockReservation(reserveExecutionLock(path)) };
  const rootBinding = knowledgeHash({ workspaceId: f.workspace.id, root: f.root, database: f.dbPath });
  const append = () => {
    const payload: JsonObject = { files: [], warnings: [] };
    if (options.reserved !== false) payload.executionLock = { path, marker: { ...marker } };
    const previewBody = { version: 1 as const, workspaceId: f.workspace.id, sessionId: f.session.id,
      input: { command: 'unexecuted Windows journal DATA', cwd: f.root, timeoutMs: 1000 },
      rootBindingSha256: rootBinding, cwdIdentitySha256: knowledgeHash({ cwd: f.root }),
      platform: options.platform ?? 'win32', policyVersion: 0, limits: { maxDurationMs: 1000, maxOutputBytes: 4096 } };
    const preview = { ...previewBody, fingerprint: knowledgeHash(previewBody) }, requestId = randomUUID();
    const approved = options.approved !== false;
    const requestSha256 = knowledgeHash({ workspaceId: f.workspace.id, requestId, fingerprint: preview.fingerprint, approved });
    return journal.append({ version: 1, id: randomUUID(),
      jobId: `host_command_${knowledgeHash([f.workspace.id, requestId, requestSha256]).slice(0, 32)}`,
      workspaceId: f.workspace.id, sessionId: f.session.id, revision: 1, previousId: null,
      kind: approved ? 'approved' : 'denied', state: approved ? 'approved' : 'denied', requestId, requestSha256, preview,
      owner: { epoch: knowledgeHash({ fixture: randomUUID() }), rootBindingSha256: rootBinding, beforeSnapshotSha256: knowledgeHash(payload) },
      pid: null, completion: null, outputSeq: 0, outputObservedBytes: 0, outputStoredBytes: 0,
      payload, createdAt: new Date().toISOString() });
  };
  const original = append();
  const currentRoot = (workspaceId: string) => { assert.equal(workspaceId, f.workspace.id); return rootBinding; };
  const known = (candidate: ExecutionLockMarker = marker, candidatePath = path, binding = currentRoot) =>
    journal.hasKnownWindowsExecutionMarker(candidate, candidatePath, binding);
  return { ...f, journal, path, marker, original, currentRoot, append, known };
}

test('reserved Windows marker correlates only to the latest validated pending SQLite journal DATA without rewriting it', async t => {
  const f = await markerJournal(t);
  assert.equal(f.marker.ownerPid, process.pid); assert.equal(f.marker.groupPid, null); assert.equal(f.marker.active, true);
  const before = f.journal.inspect();
  assert.equal(f.known(), true);
  assert.deepEqual(f.journal.inspect(), before);
  const running = f.journal.append({ ...f.original, id: randomUUID(), revision: 2, previousId: f.original.id,
    kind: 'running', state: 'running', pid: 12345, payload: { pid: 12345 }, createdAt: new Date().toISOString() });
  assert.equal(f.known(), true);
  f.journal.control(running, 'recovery', { reason: 'IMMUTABLE_DATA_INTERRUPTED_NO_REPLAY' });
  assert.equal(f.known(), true);
  assert.equal(f.journal.inspect()[0]!.state, 'uncertain');
  assert.equal(f.engine.store.getSnapshot(f.session.id).runs.length, 0);
  assert.equal(f.providerCalls.length, 0);
});

test('reserved Windows marker rejects wrong owner, nonce, group, path, root binding and inactive SQLite journal DATA', async t => {
  const f = await markerJournal(t);
  const differentNonce = f.marker.updatedAt.replace(/(\d)Z$/u, (_match, digit: string) => `${(Number(digit) + 1) % 10}Z`);
  assert.equal(Date.parse(differentNonce), Date.parse(f.marker.updatedAt), 'Nonce comparison must preserve precision beyond parsed milliseconds');
  for (const [name, change] of [
    ['owner', { ownerPid: f.marker.ownerPid + 1 }],
    ['nonce', { updatedAt: differentNonce }],
    ['group', { groupPid: 12345 }],
    ['inactive', { active: false }],
  ] as const) assert.equal(f.known({ ...f.marker, ...change }), false, name);
  assert.equal(f.known(f.marker, f.path + '.foreign'), false);
  assert.equal(f.known(f.marker, f.path, () => 'b'.repeat(64)), false);
  assert.equal(f.known(), true);
});

test('Windows marker recognition rejects absent reservations, historical POSIX journals and denied approvals', async t => {
  for (const [name, options] of [
    ['absent reservation', { reserved: false }],
    ['historical Darwin', { platform: 'darwin' }],
    ['historical Linux', { platform: 'linux' }],
    ['historical FreeBSD', { platform: 'freebsd' }],
    ['denied Windows', { approved: false }],
  ] as const) await t.test(name, async t => {
    const f = await markerJournal(t, options);
    assert.equal(f.known(), false);
  });
});

test('Windows marker recognition rejects imported history and SQLite prevents duplicate pending workspace proofs', async t => {
  await t.test('latest head is paused import', async t => {
    const f = await markerJournal(t);
    assert.equal(f.known(), true);
    f.journal.control(f.original, 'import', { reason: 'IMMUTABLE_DATA_IMPORT_REQUIRES_RECOVERY' });
    assert.equal(f.known(), false);
  });
  await t.test('a second pending workspace journal cannot replace the original reservation proof', async t => {
    const f = await markerJournal(t);
    assert.equal(f.known(), true);
    const before = f.journal.inspect();
    assert.throws(() => f.append(), { code: 'ERR_SQLITE_ERROR' });
    assert.deepEqual(f.journal.inspect(), before);
    assert.equal(f.known(), true);
  });
});

test('Windows marker recognition verifies the original SQLite approval witness instead of trusting its copied proof', async t => {
  const f = await markerJournal(t);
  assert.equal(f.known(), true);
  const db = new DatabaseSync(f.dbPath);
  try {
    const changed = db.prepare("UPDATE session_events SET data=json_set(data,'$.payload.snapshot.executionLock.marker.ownerPid',?) WHERE session_id=? AND type='host.command.approval'")
      .run(f.marker.ownerPid + 1, f.session.id);
    assert.equal(changed.changes, 1);
  } finally { db.close(); }
  assert.throws(() => f.known(), { code: 'HOST_COMMAND_EVIDENCE_INVALID' });
});
