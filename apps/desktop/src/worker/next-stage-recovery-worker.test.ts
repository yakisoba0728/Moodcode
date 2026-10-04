import assert from 'node:assert/strict';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MoodcodeEngine } from '@moodcode/engine';
import { UtilityWorker } from './core.js';

const start = { id: 'start', type: 'start', payload: { dbPath: '/main-owned/engine.sqlite', artifactDir: '/main-owned/artifacts', config: { providerId: 'scripted', modelId: 'local', baseURL: '' } } };

test('diagnostic worker reads storage status without constructing an engine/provider or creating the missing database', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-next-stage-diagnostic-worker-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const worker = new UtilityWorker({ emit() {}, createEngine() { assert.fail('Diagnostics must not construct an engine'); } });
  t.after(() => worker.close());
  const response = await worker.handle({ id: 'diagnostic', type: 'diagnostics', payload: { dbPath: join(directory, 'missing.sqlite'), artifactDir: directory } });
  assert.equal(response.ok, true, JSON.stringify(response));
  const status = (response as { result: { state: string; blockers: string[] } }).result;
  assert.equal(status.state, 'blocked');
  assert.ok(status.blockers.includes('PRIMARY_DATABASE_MISSING'));
  assert.deepEqual(await readdir(directory), []);
});

test('private worker recovery validation rejects relative paths and missing consent before touching recovery storage', async t => {
  const worker = new UtilityWorker({ emit() {}, createEngine() { assert.fail('Invalid recovery must not construct an engine'); } });
  t.after(() => worker.close());
  for (const payload of [
    { dbPath: 'relative.sqlite', artifactDir: '/absolute', fingerprint: 'a'.repeat(64), acknowledged: true },
    { dbPath: '/absolute.sqlite', artifactDir: 'relative', fingerprint: 'a'.repeat(64), acknowledged: true },
    { dbPath: '/absolute.sqlite', artifactDir: '/absolute', fingerprint: 'a'.repeat(64) },
    { dbPath: '/absolute.sqlite', artifactDir: '/absolute', fingerprint: 'a'.repeat(64), acknowledged: false },
    { dbPath: '/absolute.sqlite', artifactDir: '/absolute', fingerprint: 'A'.repeat(64), acknowledged: true },
    { dbPath: '/absolute.sqlite', artifactDir: '/absolute', fingerprint: 'a'.repeat(64), acknowledged: true, extra: true },
  ]) {
    const response = await worker.handle({ id: 'invalid-recovery', type: 'recover', payload });
    assert.equal(response.ok, false);
    assert.equal((response as { error: { code: string } }).error.code, 'INVALID_INPUT');
  }
});

test('live utility rejects storage recovery and active Run backup; terminal-only backup forwards the main-selected path', async t => {
  let active = true;
  const backups: string[] = [];
  const engine = {
    store: { listWorkspaces: () => [{ id: 'workspace' }], listSessions: () => [{ id: 'session' }], getSnapshot: () => ({ runs: [{ state: active ? 'awaiting_approval' : 'completed' }] }) },
    dispatch: async () => ({ schemaVersion: 1, commandId: 'capabilities', ok: true, result: {} }),
    async *subscribe() {}, async close() {}, async backup(destination: string) { backups.push(destination); return { bytes: 1234 }; },
  } as unknown as Pick<MoodcodeEngine, 'store' | 'dispatch' | 'subscribe' | 'close' | 'backup'>;
  const worker = new UtilityWorker({ emit() {}, createEngine: () => engine });
  t.after(() => worker.close());
  assert.equal((await worker.handle(start)).ok, true);
  for (const type of ['diagnostics', 'recover']) {
    const response = await worker.handle({ id: type, type, payload: { dbPath: '/main-owned/engine.sqlite', artifactDir: '/main-owned/artifacts', ...(type === 'recover' ? { fingerprint: 'a'.repeat(64), acknowledged: true } : {}) } });
    assert.equal(response.ok, false);
    assert.equal((response as { error: { code: string } }).error.code, 'ENGINE_BUSY');
  }
  const blocked = await worker.handle({ id: 'backup-active', type: 'backup', payload: { destination: '/main-selected/backup.sqlite' } });
  assert.equal(blocked.ok, false);
  assert.equal((blocked as { error: { code: string } }).error.code, 'WORKSPACE_BUSY');
  assert.deepEqual(backups, []);
  active = false;
  const relative = await worker.handle({ id: 'backup-relative', type: 'backup', payload: { destination: 'relative.sqlite' } });
  assert.equal(relative.ok, false);
  const ready = await worker.handle({ id: 'backup-idle', type: 'backup', payload: { destination: '/main-selected/backup.sqlite' } });
  assert.deepEqual(JSON.parse(JSON.stringify(ready)), { id: 'backup-idle', ok: true, result: { bytes: 1234 } });
  assert.deepEqual(backups, ['/main-selected/backup.sqlite']);
});
