import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AppUpdater, UpdateCheckResult } from 'electron-updater';
import { DesktopUpdates, UpdateError } from './updates.js';

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
