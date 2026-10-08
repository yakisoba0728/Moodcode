const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const { mkdir, writeFile, readFile } = require('node:fs/promises');
const { join, basename, isAbsolute } = require('node:path');
const { app } = require('electron');
const { AppImageUpdater } = require('electron-updater');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor.js');

// The real updater only replaces this disposable fixture program. It never sees a user app path.
let root, server;
async function main() {
  if (process.platform === 'win32') throw new Error('The actual AppImage fixture requires POSIX. Windows signed NSIS verification requires signing credentials.');
  root = process.argv[2];
  if (!isAbsolute(root) || !basename(root).startsWith('moodcode-real-updater-')) throw new Error('A disposable updater fixture directory is required.');
  const current = join(root, 'fixture.AppImage'), marker = join(root, 'installed-version');
  await mkdir(join(root, 'electron-user-data'), { recursive: true });
  app.setPath('userData', join(root, 'electron-user-data'));
  await app.whenReady();
  process.env.APPIMAGE = current;
  process.env.MOODCODE_UPDATE_FIXTURE_MARKER = marker;
  await writeFile(current, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  let releaseVersion = '0.2.0', corrupt = true;
  const payload = version => Buffer.from(`#!/bin/sh\n[ "$APPIMAGE_EXIT_AFTER_INSTALL" = "true" ] || exit 81\nprintf '%s' '${version}' > "$MOODCODE_UPDATE_FIXTURE_MARKER"\n`);
  server = createServer((request, response) => {
    const content = payload(releaseVersion);
    if (request.url.split('?')[0].endsWith('.yml')) {
      const hash = createHash('sha512').update(corrupt ? 'intentionally-corrupt-fixture' : content).digest('base64');
      response.writeHead(200, { 'Content-Type': 'application/yaml' }).end(JSON.stringify({ version: releaseVersion, releaseDate: '2026-10-09T00:00:00Z', files: [{ url: `Moodcode-${releaseVersion}.AppImage`, size: content.length, sha512: hash }] }));
    } else if (request.url.split('?')[0].endsWith('.AppImage')) response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': content.length }).end(content);
    else response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  let quits = 0;
  async function updater(version, name) {
    const cache = join(root, name); await mkdir(cache, { recursive: true });
    const configuration = join(cache, 'app-update.yml');
    await writeFile(configuration, JSON.stringify({ provider: 'generic', url: address, updaterCacheDirName: name }));
    const adapter = { version, name, isPackaged: true, appUpdateConfigPath: configuration, userDataPath: cache, baseCachePath: cache,
      whenReady: async () => {}, relaunch: () => assert.fail('Fixture must not relaunch any app.'), quit: () => { quits += 1; }, onQuit: () => assert.fail('Auto installation on quit must remain disabled.') };
    const instance = new AppImageUpdater(undefined, adapter);
    // Native Electron network transport remains real; SDK checksum/install code is unchanged.
    instance.httpExecutor = new ElectronHttpExecutor(null);
    instance.autoDownload = false; instance.autoInstallOnAppQuit = false; instance.autoRunAppAfterInstall = false;
    instance.allowDowngrade = false; instance.allowPrerelease = false; instance.disableDifferentialDownload = true; instance.logger = null;
    instance.on('error', () => {});
    return instance;
  }
  const damaged = await updater('0.1.0', 'corrupt');
  const bad = await damaged.checkForUpdates(); assert.equal(bad.isUpdateAvailable, true);
  await assert.rejects(damaged.downloadUpdate(bad.cancellationToken), error => /checksum|sha512/i.test(error.message));
  assert.equal(await readFile(current, 'utf8'), '#!/bin/sh\nexit 0\n');
  corrupt = false;
  const valid = await updater('0.1.0', 'valid');
  const found = await valid.checkForUpdates(); assert.equal(found.updateInfo.version, '0.2.0');
  const downloads = await valid.downloadUpdate(found.cancellationToken);
  assert.equal(createHash('sha512').update(await readFile(downloads[0])).digest('base64'), found.updateInfo.files[0].sha512);
  assert.equal(quits, 0); assert.equal(await readFile(current, 'utf8'), '#!/bin/sh\nexit 0\n');
  valid.quitAndInstall(false, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await readFile(marker, 'utf8'), '0.2.0'); assert.equal(quits, 1);
  releaseVersion = '0.3.0';
  const rollback = await updater('0.2.0', 'rollback');
  const replacement = await rollback.checkForUpdates(); assert.equal(replacement.updateInfo.version, '0.3.0');
  await rollback.downloadUpdate(replacement.cancellationToken); rollback.quitAndInstall(false, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await readFile(marker, 'utf8'), '0.3.0'); assert.equal(quits, 2);
  releaseVersion = '0.1.0';
  const downgrade = await updater('0.3.0', 'downgrade'); assert.equal((await downgrade.checkForUpdates()).isUpdateAvailable, false);
  console.log(JSON.stringify({ ok: true, boundary: 'real-electron-updater-disposable-AppImage-fixture', electron: process.versions.electron,
    sdkVersion: require('electron-updater/package.json').version, checksumRejected: true, downloadedDigestVerified: true,
    fixtureInstall: '0.2.0', higherVersionRecovery: '0.3.0', downgradeBlocked: true, realUserAppTouched: false,
    signedMacOrWindowsInstallerVerified: false }));
}
main().then(async () => { server?.closeAllConnections(); await new Promise(resolve => server?.close(resolve)); app.exit(0); })
  .catch(async error => { console.error(JSON.stringify({ ok: false, boundary: 'real-electron-updater-fixture', error: error.name, message: error.message }));
    server?.closeAllConnections(); server?.close(); app.exit(1); });
