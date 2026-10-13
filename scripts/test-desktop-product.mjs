import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AI_SDK_PROVIDERS } from '@moodcode/contracts';
import { parseModelCatalog } from '@moodcode/engine';

const root = await mkdtemp(join(tmpdir(), 'moodcode-product-gui-'));
const data = join(root, 'data'), workspace = join(root, 'workspace');
const artifacts = resolve('artifacts/product-connections');
await mkdir(data); await mkdir(workspace); await mkdir(artifacts, { recursive: true });
execFileSync('git', ['init', '-q', workspace]);
await writeFile(join(data, 'settings.json'), JSON.stringify({ schemaVersion: 1, providerId: 'scripted', modelId: 'local', baseURL: '' }), { mode: 0o600 });
await writeFile(join(data, 'model-catalog.json'), JSON.stringify(parseModelCatalog({ google: { name: 'Google', models: {
  'fixture-coding': { name: 'Fixture Coding', tool_call: true, reasoning: true, limit: { context: 128000, output: 8000 }, modalities: { input: ['text', 'image'], output: ['text'] } },
  'fixture-retired': { name: 'Retired', status: 'deprecated' },
} } })));
const pluginRoot = join(data, 'plugins', 'node_modules', 'fixture-plugin'); await mkdir(pluginRoot, { recursive: true });
await writeFile(join(data, 'plugins', 'package.json'), JSON.stringify({ private: true }));
await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', type: 'module', main: 'index.js' }));
await writeFile(join(pluginRoot, 'index.js'), `export default {id:'guiFixture',async activate(){return {tools:[{name:'gui_plugin_read',description:'GUI fixture plugin',effectClass:'read',inputSchema:{type:'object'},async prepare(){return {name:'gui_plugin_read',input:{},fingerprint:'gui-fixture',requiresApproval:false,preview:{}}},async execute(){return {content:'fixture'}}}]}}};`);
await writeFile(join(data, 'product-settings.json'), JSON.stringify({ schemaVersion: 1, web: false, globalSkills: false, compatibilitySkills: false, profiles: [], plugins: [{ name: 'fixture-plugin', version: '1.0.0', enabled: false }] }));
let application;
try {
  application = await electron.launch({ args: [resolve('apps/desktop')], env: { ...process.env, MOODCODE_DESKTOP_TEST: '1', MOODCODE_DESKTOP_USER_DATA: data, MOODCODE_DESKTOP_TEST_WORKSPACE: workspace,
    MOODCODE_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', EXA_API_KEY: '', ...Object.fromEntries(Object.values(AI_SDK_PROVIDERS).map(preset => [preset.apiKeyEnv, ''])) } });
  const page = await application.firstWindow();
  await expect(page.getByText('무엇을 만들어볼까요?', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '모델 설정', exact: true }).click();
  await page.getByLabel('연결 방식').selectOption('google');
  await page.getByLabel('모델 검색', { exact: true }).fill('coding');
  await page.getByLabel('카탈로그에서 선택', { exact: true }).selectOption('fixture-coding');
  await expect(page.getByLabel('모델 ID', { exact: true })).toHaveValue('fixture-coding');
  await expect(page.getByText(/컨텍스트 128,000/)).toBeVisible();
  assert.equal(await page.getByLabel('카탈로그에서 선택').getByRole('option', { name: /Retired/ }).count(), 0);
  await page.getByLabel('연결 방식').selectOption('scripted');
  await page.getByText('웹 조사 · Skills · Plugins · 에이전트', { exact: true }).click();
  await page.getByLabel('공개 웹 문서 읽기 활성화').check();
  await page.getByLabel('사용자 ~/.config/moodcode/skills 포함').check();
  await page.getByLabel(/\.agents\/skills · \.claude\/skills 포함/).check();
  await page.getByRole('button', { name: '에이전트 추가', exact: true }).click();
  await page.getByText('agent-1', { exact: true }).click();
  await page.getByLabel('에이전트 ID', { exact: true }).fill('review');
  await page.getByLabel('설명', { exact: true }).fill('코드 검토');
  await page.getByLabel('지침', { exact: true }).fill('현재 파일을 확인하고 근거를 설명하세요.');
  await page.getByLabel('모델 ID · 현재 공급자', { exact: true }).fill('review-local');
  await page.getByLabel('최대 턴 수 · 선택').fill('2');
  await page.getByLabel(/도구 허용 목록 사용/).check();
  await page.getByLabel('허용 도구 · 쉼표로 구분').fill('read_file, list_files, search_files');
  await page.getByLabel('fixture-plugin@1.0.0 · 설치됨').check();
  await page.getByRole('button', { name: '확장 설정 저장', exact: true }).click();
  await expect(page.getByText('확장 설정을 저장했어요. 다음 실행부터 적용돼요.', { exact: true })).toBeVisible({ timeout: 20000 });
  const bootstrap = await page.evaluate(() => window.moodcode.getBootstrap());
  assert.ok(bootstrap.capabilities.tools.some(tool => tool.name === 'web_fetch'));
  assert.ok(bootstrap.capabilities.tools.some(tool => tool.name === 'gui_plugin_read'));
  assert.ok(!bootstrap.capabilities.tools.some(tool => tool.name === 'web_search'));
  await page.screenshot({ path: join(artifacts, 'product-settings.png') });
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await page.getByRole('button', { name: '프로젝트 열기', exact: true }).click();
  await page.getByLabel('에이전트 프로파일', { exact: true }).selectOption('review');
  await page.getByRole('textbox', { name: '작업 요청' }).fill('프로파일 실행 확인');
  await page.getByRole('button', { name: '작업 시작', exact: true }).click();
  await expect(page.getByText('Received: 프로파일 실행 확인', { exact: true })).toBeVisible({ timeout: 20000 });
  const snapshot = await page.evaluate(async commandId => {
    const api = window.moodcode, bootstrap = await api.getBootstrap();
    const sessions = await api.command({ schemaVersion: 1, commandId, type: 'session.list', payload: { workspaceId: bootstrap.workspaces[0].id } });
    return api.command({ schemaVersion: 1, commandId: `${commandId}-snapshot`, type: 'session.getSnapshot', payload: { sessionId: sessions.result[0].id } });
  }, randomUUID());
  assert.equal(snapshot.ok, true); const run = snapshot.result.runs[0];
  assert.equal(run.config.agentProfileId, 'review'); assert.match(run.config.agentProfileRevision, /^[a-f0-9]{64}$/u);
  assert.equal(run.config.modelId, 'review-local'); assert.equal(run.config.mode, 'plan'); assert.equal(run.config.budgets.turnAllowance, 2);
  const persisted = JSON.parse(await readFile(join(data, 'product-settings.json'), 'utf8'));
  assert.deepEqual(persisted.profiles[0].tools, ['read_file', 'list_files', 'search_files']);
  await application.close(); application = undefined;
  const database = new DatabaseSync(join(data, 'engine.sqlite'), { readOnly: true });
  const databaseSchema = database.prepare('PRAGMA user_version').get().user_version; database.close(); assert.equal(databaseSchema, 23);
  const evidence = { schemaVersion: 1, ok: true, platform: process.platform, catalogSearch: true, deprecatedHidden: true, offlineCache: true, webFetchOptIn: true, missingSearchKeyHidden: true, pluginLoadedInOriginalUtility: true, profileForwardedAndPersisted: true, planPreserved: true, databaseSchema, providerAccountRequests: 0 };
  await writeFile(join(artifacts, 'gui.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
} catch (error) {
  if (application) {
    const page = await application.firstWindow();
    await page.screenshot({ path: join(artifacts, 'gui-failed.png') }).catch(() => {});
    await writeFile(join(artifacts, 'gui-error.txt'), await page.locator('body').innerText()).catch(() => {});
  }
  throw error;
} finally { if (application) await application.close(); await rm(root, { recursive: true, force: true }); }
