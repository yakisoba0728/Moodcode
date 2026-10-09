import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AppUpdater, UpdateCheckResult } from 'electron-updater';
import { DesktopUpdates, UpdateError } from './updates.js';
import { DesktopHost, type UtilityTransport } from './host.js';
import type { WorkerRequest } from '../worker/protocol.js';

class FixtureUpdater extends EventEmitter {
  autoDownload = true; autoInstallOnAppQuit = true; autoRunAppAfterInstall = true; allowDowngrade = true;
  allowPrerelease = true; disableWebInstaller = false; logger = null; channel = null;
  installs = 0; downloads = 0; cancelled = false; checkVersion = '0.2.0'; available = true;
  checkFailure?: Error;
  downloadHook?: () => Promise<void>;
  async checkForUpdates(): Promise<UpdateCheckResult> {
    if (this.checkFailure) throw this.checkFailure;
    const info = { version: this.checkVersion, files: [], path: 'fixture', sha512: 'fixture', releaseDate: '2026-10-09' };
    return { isUpdateAvailable: this.available, updateInfo: info, versionInfo: info, cancellationToken: { cancel: () => { this.cancelled = true; } } as never };
  }
  async downloadUpdate(): Promise<string[]> { this.downloads += 1; await this.downloadHook?.(); return ['private-fixture-path']; }
  quitAndInstall(silent: boolean, restart: boolean): void { assert.equal(silent, false); assert.equal(restart, false); this.installs += 1; }
}
function fixture() {
  const updater = new FixtureUpdater(); let cleanups = 0, blocked = false;
  const updates = new DesktopUpdates(updater as unknown as AppUpdater, { currentVersion: '0.1.0', enabled: true, closeEngine: async () => { cleanups += 1; if (blocked) throw new Error('private-cleanup'); } });
  return { updater, updates, cleanups: () => cleanups, block: () => { blocked = true; }, unblock: () => { blocked = false; } };
}
const code = (expected: string) => (error: unknown) => { assert.ok(error instanceof UpdateError); assert.equal(error.code, expected); assert.doesNotMatch(error.message, /private-/u); return true; };

test('release updater prevents automatic downloads, quit installation and downgrade', () => {
  const { updater } = fixture();
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false); assert.equal(updater.autoRunAppAfterInstall, false);
  assert.equal(updater.allowDowngrade, false); assert.equal(updater.allowPrerelease, false); assert.equal(updater.disableWebInstaller, true);
});
test('exact-version approval and confirmed engine cleanup gate explicit installation', async () => {
  const f = fixture(); assert.equal((await f.updates.action({ action: 'check' })).state, 'available');
  await assert.rejects(f.updates.action({ action: 'download', version: '9.9.9' }), code('UPDATE_STALE')); assert.equal(f.updater.downloads, 0);
  await f.updates.action({ action: 'download', version: '0.2.0' });
  await assert.rejects(f.updates.action({ action: 'install', version: '0.2.0' }), code('UPDATE_APPROVAL_REQUIRED'));
  assert.equal(f.cleanups(), 0); assert.equal(f.updater.installs, 0);
  f.block(); await assert.rejects(f.updates.action({ action: 'install', version: '0.2.0', acknowledged: true }), code('UPDATE_CLEANUP_PENDING'));
  assert.equal(f.updates.getView().state, 'downloaded'); assert.equal(f.updater.installs, 0);
  f.unblock(); assert.equal((await f.updates.action({ action: 'install', version: '0.2.0', acknowledged: true })).state, 'installing');
  assert.equal(f.updater.installs, 1); assert.equal(f.cleanups(), 2);
});
test('download cancellation does not install and a new check is required before retry', async () => {
  const f = fixture(); await f.updates.action({ action: 'check' });
  let release!: () => void; f.updater.downloadHook = () => new Promise(resolve => { release = resolve; });
  const downloading = f.updates.action({ action: 'download', version: '0.2.0' });
  await f.updates.action({ action: 'cancel' }); assert.equal(f.updater.cancelled, true); release();
  assert.equal((await downloading).state, 'idle'); assert.equal(f.updates.getView().version, undefined); assert.equal(f.updater.installs, 0);
  await assert.rejects(f.updates.action({ action: 'install', version: '0.2.0', acknowledged: true }), code('UPDATE_APPROVAL_REQUIRED'));
});
test('SDK availability decision and installed version both prevent rollback downloads', async () => {
  const f = fixture(); f.updater.checkVersion = '0.0.9'; assert.equal((await f.updates.action({ action: 'check' })).state, 'idle');
  f.updater.checkVersion = '0.2.0'; f.updater.available = false; assert.equal((await f.updates.action({ action: 'check' })).state, 'idle');
  assert.equal(f.updater.downloads, 0);
});
test('raw update errors never expose server URLs or fixture paths', async () => {
  const f = fixture(); f.updater.checkFailure = new Error('private-server-url private-fixture-path');
  await assert.rejects(f.updates.action({ action: 'check' }), code('UPDATE_FAILED'));
  assert.doesNotMatch(JSON.stringify(f.updates.getView()), /private-/u); assert.equal(f.updater.installs, 0);
});
test('unsigned development packages reject every update action', async () => {
  const updates = new DesktopUpdates(undefined, { currentVersion: '0.1.0', enabled: false, closeEngine: async () => assert.fail('unexpected cleanup') });
  assert.equal(updates.getView().state, 'disabled'); await assert.rejects(updates.action({ action: 'check' }), code('UPDATE_DISABLED'));
});


for (const scenario of ['never-started', 'confirmed', 'crashed-history', 'ack-no-exit', 'exit-without-ack'] as const) {
  test(`the actual host update gate ${scenario} controls installer admission`, async t => {
    const updater = new FixtureUpdater();
    const originals: EventEmitter[] = [];
    const view = { providerId: 'scripted' as const, modelId: 'fixture', baseURL: '', keyConfigured: false,
      keySource: 'none' as const, credentialStorage: 'unavailable' as const };
    const resolved = { view, engineConfig: { providerId: 'scripted' as const, modelId: 'fixture', baseURL: '' } };
    const host = new DesktopHost({
      platform: 'fixture', version: '0.1.0', dbPath: '/unused-fixture/database', artifactDir: '/unused-fixture/artifacts',
      rpcTimeoutMs: 100, closeTimeoutMs: 20, utilityExitTimeoutMs: 15,
      settings: { getView: () => view, load: async () => resolved, prepare: async () => resolved, commit: async () => resolved },
      spawn(): UtilityTransport {
        const original = new EventEmitter(); originals.push(original);
        return {
          onMessage(listener) { original.on('message', listener); return () => { original.off('message', listener); }; },
          onExit(listener) { original.on('exit', listener); return () => { original.off('exit', listener); }; },
          postMessage(request: WorkerRequest) {
            queueMicrotask(() => {
              if (request.type === 'close' && scenario === 'exit-without-ack') { original.emit('exit', 0); return; }
              original.emit('message', { id: request.id, ok: true });
              if (request.type === 'close' && scenario !== 'ack-no-exit') queueMicrotask(() => original.emit('exit', 0));
            });
          },
        };
      },
    });
    t.after(async () => { for (const original of originals) original.emit('exit', 0); await host.close().catch(() => {}); });
    if (scenario !== 'never-started') await host.initialize();
    if (scenario === 'crashed-history') { originals[0]!.emit('exit', 1); assert.equal((await host.retryEngine()).state, 'ready'); }
    const updates = new DesktopUpdates(updater as unknown as AppUpdater, {
      currentVersion: '0.1.0', enabled: true, closeEngine: () => host.closeForUpdate(),
    });
    await updates.action({ action: 'check' }); await updates.action({ action: 'download', version: '0.2.0' });
    const installing = updates.action({ action: 'install', version: '0.2.0', acknowledged: true });
    if (scenario === 'never-started' || scenario === 'confirmed') {
      assert.equal((await installing).state, 'installing'); assert.equal(updater.installs, 1);
    } else {
      await assert.rejects(installing, code('UPDATE_CLEANUP_PENDING'));
      assert.equal(updater.installs, 0); assert.equal(updates.getView().state, 'downloaded');
      assert.notEqual(host.getUtilityCloseDiagnostics().cleanupConfirmed, true);
      // Physical exit may allow normal quit, but cannot erase failed installer admission.
      for (const original of originals) original.emit('exit', 0);
      await host.close();
      await assert.rejects(updates.action({ action: 'install', version: '0.2.0', acknowledged: true }), code('UPDATE_CLEANUP_PENDING'));
      assert.equal(updater.installs, 0);
    }
  });
}
