import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDesktopTestDirectory, captureDesktopNativeEvidence, preserveDesktopTestEvidence } from './desktop-test-evidence.mjs';
import { aggregateFixtureCleanup, bindMainUtilityClose, readMainUtilityClose, qualifyDesktopNativeCleanup } from './desktop-main-utility-close.mjs';

const directory = await createDesktopTestDirectory('account-gui');
const artifactDirectory = resolve(process.argv[2] ?? 'artifacts/desktop-accounts');
const userData = join(directory, 'userData');
await mkdir(userData, { recursive: true, mode: 0o700 });
await mkdir(join(directory, 'home'), { recursive: true });
await mkdir(join(directory, 'codex'), { recursive: true });
const launch = join(directory, 'account-launch.cjs');
await writeFile(launch, `const { BrowserWindow } = require('electron');\nBrowserWindow.prototype.show = function () {};\nvoid import(${JSON.stringify(pathToFileURL(resolve('apps/desktop/dist/main/index.js')).href)});\n`);
const report = { status: 'running', originalDirectory: directory, originalPreserved: true, externalIdentityVerified: false, inferenceRequests: 0 };
let app, originalProcess, mainUtilityClosePath;
try {
  report.stage = 'launch';
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ schemaVersion: 1, providerId: 'scripted', modelId: 'local', baseURL: '' }), { mode: 0o600 });
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  Object.assign(env, { HOME: join(directory, 'home'), CODEX_HOME: join(directory, 'codex'), MOODCODE_DESKTOP_USER_DATA: userData,
    MOODCODE_DESKTOP_TEST: '1', MOODCODE_DESKTOP_TEST_SCENARIO: 'account' });
  app = await electron.launch({ args: [launch], env });
  originalProcess = app.process(); mainUtilityClosePath = await bindMainUtilityClose(app, directory);
  const page = await app.firstWindow();
  report.stage = 'settings';
  await expect(page.getByText('무엇을 만들어볼까요?', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '모델 설정', exact: true }).click();
  const panel = page.getByRole('region', { name: '앱 계정 관리' });
  await expect(panel).toBeVisible();
  const initial = await page.evaluate(() => window.moodcode.getAccounts());
  const updates = page.getByRole('region', { name: '앱 업데이트' });
  await expect(updates).toContainText('업데이트 비활성화');
  if (initial.secureStorage === 'unavailable') {
    await expect(panel.getByRole('button', { name: /ChatGPT로/ })).toBeDisabled();
    Object.assign(report, { ok: true, boundary: 'actual-GUI-native-account-storage-unavailable', secureStorage: 'unavailable', credentialPersistenceRefused: true, unsignedUpdateDisabled: true });
  } else {
    report.stage = 'first-sign-in';
    await panel.getByRole('button', { name: /ChatGPT로/ }).click();
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).accounts.length).toBe(1);
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).accounts[0]?.state).toBe('connected');
    await expect(panel.getByRole('button', { name: /ChatGPT로/ })).toBeEnabled();
    const first = await page.evaluate(() => window.moodcode.getAccounts());
    assert.equal(first.accounts[0].state, 'connected'); assert.equal(first.accounts[0].sharing, true);
    assert.deepEqual(first.models, [{ id: 'fixture-chatgpt-model', displayName: 'Fixture ChatGPT model' }]);
    await expect.poll(async () => JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')).accountId).toBe(first.activeAccountId);
    const selection = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8'));
    assert.equal(selection.credentialMode, 'chatgpt'); assert.equal(selection.providerId, 'codex'); assert.equal(selection.baseURL, '');
    await expect(page.getByLabel('연결 방식')).toHaveValue('codex');
    await expect(page.getByLabel('Codex 인증 방식')).toHaveValue('chatgpt');
    await expect(page.getByLabel('모델 ID', { exact: true })).toHaveValue('fixture-chatgpt-model');
    await expect(page.getByLabel('API endpoint', { exact: true })).toHaveCount(0);
    const expiry = first.accounts[0].expiresAt;
    report.stage = 'refresh';
    await panel.getByRole('button', { name: /계정 갱신/ }).click();
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).accounts[0].expiresAt).toBeGreaterThan(expiry);
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).pending).toBe(false);
    await expect(panel.getByRole('button', { name: /ChatGPT로/ })).toBeEnabled();
    report.stage = 'second-sign-in';
    await panel.getByRole('button', { name: /ChatGPT로/ }).click();
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).accounts.length).toBe(2);
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).activeAccountId).not.toBe(first.activeAccountId);
    await expect(panel.getByRole('button', { name: /ChatGPT로/ })).toBeEnabled();
    const second = await page.evaluate(() => window.moodcode.getAccounts()); assert.notEqual(first.activeAccountId, second.activeAccountId);
    report.stage = 'select-and-sign-out';
    await panel.getByLabel('사용할 앱 계정').selectOption(first.activeAccountId);
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).activeAccountId).toBe(first.activeAccountId);
    await panel.getByRole('button', { name: '앱 계정 로그아웃', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).accounts.find(account => account.id === first.activeAccountId).state).toBe('signed-out');
    assert.equal((await page.evaluate(() => window.moodcode.getAccounts())).activeAccountId, undefined);
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getBootstrap())).host.state).toBe('failed');
    const disconnected = await page.evaluate(() => window.moodcode.getBootstrap());
    assert.equal(disconnected.settings.keyConfigured, false);
    await expect(panel.getByRole('button', { name: '계정 다시 연결', exact: true })).toBeEnabled();
    report.stage = 'reconnect';
    await panel.getByRole('button', { name: '계정 다시 연결', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).activeAccountId).toBe(first.activeAccountId);
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getBootstrap())).host.state).toBe('ready');
    assert.equal((await page.evaluate(() => window.moodcode.getAccounts())).accounts.length, 2, 'Reconnect must reuse the same saved account entry.');
    await expect(panel.getByRole('button', { name: '앱 계정 로그아웃', exact: true })).toBeEnabled();
    report.stage = 'forget-and-private-boundaries';
    await panel.getByRole('button', { name: '앱 계정 로그아웃', exact: true }).click();
    await expect(panel.getByRole('button', { name: '앱에서 계정 제거', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: '앱에서 계정 제거', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).accounts.length).toBe(1);
    const encrypted = await readFile(join(userData, 'accounts', 'accounts.enc.json'), 'utf8');
    assert.doesNotMatch(encrypted, /moodcode-fixture-access|moodcode-fixture-refresh/u);
    assert.doesNotMatch(await page.locator('body').innerText(), /moodcode-fixture-access|moodcode-fixture-refresh|fixture-chatgpt-account|fixture-account-\d+|oaiapp_moodcode/u);
    assert.doesNotMatch(JSON.stringify(await page.evaluate(() => window.moodcode.getAccounts())), /moodcode-fixture-access|moodcode-fixture-refresh|fixture-chatgpt-account|fixture-account-\d+|oaiapp_moodcode/u);
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(userData, 'accounts', 'accounts.enc.json'))).mode & 0o777, 0o600);
      assert.equal((await stat(join(userData, 'accounts'))).mode & 0o777, 0o700);
    }
    for (const name of await readdir(userData)) if (/\.sqlite(?:-wal)?$/u.test(name)) {
      assert.doesNotMatch((await readFile(join(userData, name))).toString('utf8'), /moodcode-fixture-access|moodcode-fixture-refresh|fixture-chatgpt-account|fixture-account-\d+/u);
    }
    Object.assign(report, { ok: true, boundary: 'actual-GUI-native-Codex-OAuth-account-fixture', secureStorage: 'native-operating-system',
      signIn: true, accountSelection: true, refresh: true, logout: true, reconnectSameRegistration: true, forget: true,
      encryptedTokens: true, rendererSecretsAbsent: true, nativeJournalSecretsAbsent: true, logoutStoppedWorker: true,
      persistedExactAccountBinding: true, selectedProvider: 'codex', fixedNativeEndpoint: true, nativeCatalogFixtureAssertions: true, unsignedUpdateDisabled: true });
  }
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())), true);
  report.hidden = true; report.status = 'passed';
} catch {
  report.status = 'failed'; report.ok = false; report.failure = { code: 'ACCOUNT_GUI_VERIFICATION_FAILED', message: 'The isolated account GUI flow did not complete.' }; process.exitCode = 1;
} finally {
  const failed = phase => { report.status = 'failed'; report.ok = false; (report.diagnosticFailures ??= []).push({ phase, code: 'ACCOUNT_GUI_FINALIZATION_FAILED' }); };
  if (app) {
    try { await app.close(); } catch { failed('application-close'); }
    report.applicationClose = { exitObserved: Number.isInteger(originalProcess?.exitCode) || typeof originalProcess?.signalCode === 'string', exitCode: originalProcess?.exitCode ?? null, signal: originalProcess?.signalCode ?? null, establishesNativeCleanup: false };
    try { report.mainUtilityClose = await readMainUtilityClose(mainUtilityClosePath); } catch { failed('main-utility-close'); }
    let nativeAfterClose;
    try { nativeAfterClose = await captureDesktopNativeEvidence({ sourceDirectory: directory, phase: 'after-close', close: { mainUtility: report.mainUtilityClose, applicationClose: report.applicationClose } }); }
    catch { failed('native-capture'); }
    report.cleanup = { ...aggregateFixtureCleanup({ mainReceipt: report.mainUtilityClose, nativeConfirmed: report.diagnosticFailures ? null : qualifyDesktopNativeCleanup(nativeAfterClose) }), originalPreserved: true };
    try { report.preservedEvidence = await preserveDesktopTestEvidence({ sourceDirectory: directory, artifactDirectory, scenario: 'account-gui', outcome: report.status === 'failed' ? 'failed' : 'unknown', cleanup: report.cleanup, nativeAfterClose }); }
    catch { failed('evidence-preserve'); report.cleanup.state = 'unknown'; report.cleanup.nativeConfirmed = null; }
    if (report.cleanup.utilityAcknowledged !== true || report.cleanup.utilityExitObserved !== true || report.applicationClose.exitObserved !== true) failed('original-close-unconfirmed');
  }
  if (report.status === 'failed') process.exitCode = 1;
  try { await mkdir(artifactDirectory, { recursive: true }); await writeFile(join(artifactDirectory, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`); }
  catch { failed('report-write'); process.exitCode = 1; }
  console.log(JSON.stringify(report));
}
