import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesktopApi, type DesktopTransport } from './api.js';
import { DESKTOP_CHANNELS } from '../main/ipc-channels.js';

test('recovery bridge sends only a current fingerprint and explicit acknowledgment; backup sends no renderer path', async () => {
  const calls: { channel: string; args: unknown[] }[] = [];
  const transport: DesktopTransport = { async invoke(channel, ...args) { calls.push({ channel, args }); return { ok: true, value: {} }; }, on() {}, removeListener() {} };
  const api = createDesktopApi(transport);
  await api.getRecoveryStatus!();
  await api.recoverEngine!({ fingerprint: 'a'.repeat(64), acknowledged: true });
  await api.backupDatabase!();
  assert.deepEqual(calls, [
    { channel: DESKTOP_CHANNELS.diagnostics, args: [] },
    { channel: DESKTOP_CHANNELS.recover, args: [{ fingerprint: 'a'.repeat(64), acknowledged: true }] },
    { channel: DESKTOP_CHANNELS.backup, args: [] },
  ]);
  for (const input of [null, {}, { fingerprint: 'a'.repeat(64) }, { fingerprint: 'a'.repeat(64), acknowledged: false }, { fingerprint: 'A'.repeat(64), acknowledged: true }, { fingerprint: 'a'.repeat(64) + '\n', acknowledged: true }, { fingerprint: 'a'.repeat(64), acknowledged: true, dbPath: '/renderer-selected' }, { fingerprint: 'a'.repeat(64), acknowledged: true, artifactDir: '/renderer-selected' }]) {
    assert.throws(() => api.recoverEngine!(input as { fingerprint: string; acknowledged: true }));
  }
  assert.equal(calls.length, 3);
  assert.equal('invoke' in api, false);
});
