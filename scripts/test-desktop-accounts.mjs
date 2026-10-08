import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const directory = await mkdtemp(join(tmpdir(), 'moodcode-account-gui-'));
let app;
try {
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ schemaVersion: 1, providerId: 'scripted', modelId: 'local', baseURL: '' }), { mode: 0o600 });
  app = await electron.launch({ args: [resolve('apps/desktop')], env: { ...process.env, MOODCODE_DESKTOP_USER_DATA: directory,
    MOODCODE_DESKTOP_TEST: '1', MOODCODE_DESKTOP_TEST_SCENARIO: 'account', MOODCODE_API_KEY: '', OPENAI_API_KEY: '' } });
  const page = await app.firstWindow();
  await expect(page.getByText('무엇을 만들어볼까요?', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '모델 설정', exact: true }).click();
  const panel = page.getByRole('region', { name: '앱 계정 관리' });
  await expect(panel).toBeVisible();
  const initial = await page.evaluate(() => window.moodcode.getAccounts());
  const updates = page.getByRole('region', { name: '앱 업데이트' });
  await expect(updates).toContainText('업데이트 비활성화');
  if (initial.secureStorage === 'unavailable') {
    await expect(panel.getByRole('button', { name: /ChatGPT로/ })).toBeDisabled();
    console.log(JSON.stringify({ ok: true, boundary: 'actual-GUI-native-account-storage-unavailable', secureStorage: 'unavailable', credentialPersistenceRefused: true,
      externalIdentityVerified: false, inferenceRequests: 0, unsignedUpdateDisabled: true }));
  } else {
    await panel.getByRole('button', { name: /ChatGPT로/ }).click();
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).accounts.length).toBe(1);
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).accounts[0]?.state).toBe('connected');
    await expect(panel.getByRole('button', { name: /ChatGPT로/ })).toBeEnabled();
    const first = await page.evaluate(() => window.moodcode.getAccounts());
    assert.equal(first.accounts[0].state, 'connected'); assert.equal(first.accounts[0].sharing, true);
    assert.deepEqual(first.models, [{ id: 'fixture-chatgpt-model', displayName: 'Fixture ChatGPT model' }]);
    await expect.poll(async () => JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).accountId).toBe(first.activeAccountId);
    const selection = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'));
    assert.equal(selection.credentialMode, 'chatgpt'); assert.equal(selection.providerId, 'openai-responses');
    const expiry = first.accounts[0].expiresAt;
    await panel.getByRole('button', { name: /계정 갱신/ }).click();
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).accounts[0].expiresAt).toBeGreaterThan(expiry);
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).pending).toBe(false);
    await expect(panel.getByRole('button', { name: /ChatGPT로/ })).toBeEnabled();
    await panel.getByRole('button', { name: /ChatGPT로/ }).click();
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).accounts.length).toBe(2);
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).activeAccountId).not.toBe(first.activeAccountId);
    await expect(panel.getByRole('button', { name: /ChatGPT로/ })).toBeEnabled();
    const second = await page.evaluate(() => window.moodcode.getAccounts()); assert.notEqual(first.activeAccountId, second.activeAccountId);
    await panel.getByLabel('사용할 앱 계정').selectOption(first.activeAccountId);
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).activeAccountId).toBe(first.activeAccountId);
    await panel.getByRole('button', { name: '앱 계정 로그아웃', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).accounts.find(account => account.id === first.activeAccountId).state).toBe('signed-out');
    assert.equal((await page.evaluate(() => window.moodcode.getAccounts())).activeAccountId, undefined);
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getBootstrap())).host.state).toBe('failed');
    const disconnected = await page.evaluate(() => window.moodcode.getBootstrap());
    assert.equal(disconnected.settings.keyConfigured, false);
    await expect(panel.getByRole('button', { name: '계정 다시 연결', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: '계정 다시 연결', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).activeAccountId).toBe(first.activeAccountId);
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getBootstrap())).host.state).toBe('ready');
    assert.equal((await page.evaluate(() => window.moodcode.getAccounts())).accounts.length, 2, 'Reconnect must reuse the registered account.');
    await expect(panel.getByRole('button', { name: '앱 계정 로그아웃', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: '앱 계정 로그아웃', exact: true }).click();
    await expect(panel.getByRole('button', { name: '앱에서 계정 제거', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: '앱에서 계정 제거', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.moodcode.getAccounts())).accounts.length).toBe(1);
    const encrypted = await readFile(join(directory, 'accounts', 'accounts.enc.json'), 'utf8');
    assert.doesNotMatch(encrypted, /moodcode-fixture-access|moodcode-fixture-refresh/u);
    assert.doesNotMatch(await page.locator('body').innerText(), /moodcode-fixture-access|moodcode-fixture-refresh|oaiapp_moodcode/u);
    assert.doesNotMatch(JSON.stringify(await page.evaluate(() => window.moodcode.getAccounts())), /moodcode-fixture-access|moodcode-fixture-refresh|oaiapp_moodcode/u);
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(directory, 'accounts', 'accounts.enc.json'))).mode & 0o777, 0o600);
      assert.equal((await stat(join(directory, 'accounts'))).mode & 0o777, 0o700);
    }
    for (const name of await readdir(directory)) if (/\.sqlite(?:-wal)?$/u.test(name)) {
      assert.doesNotMatch((await readFile(join(directory, name))).toString('utf8'), /moodcode-fixture-access|moodcode-fixture-refresh/u);
    }
    console.log(JSON.stringify({ ok: true, boundary: 'actual-GUI-official-contract-account-fixture', secureStorage: 'native-operating-system',
      signIn: true, accountSelection: true, refresh: true, logout: true, reconnectSameRegistration: true, forget: true,
      encryptedTokens: true, rendererSecretsAbsent: true, nativeJournalSecretsAbsent: true, logoutStoppedWorker: true,
      persistedExactAccountBinding: true, externalIdentityVerified: false, inferenceRequests: 0, unsignedUpdateDisabled: true }));
  }
} finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
