import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopTestDirectory, captureDesktopNativeEvidence, preserveDesktopTestEvidence } from '../../../../../scripts/desktop-test-evidence.mjs';
import { aggregateFixtureCleanup, bindMainUtilityClose, readMainUtilityClose, qualifyDesktopNativeCleanup } from '../../../../../scripts/desktop-main-utility-close.mjs';
import { finishAnthropicFixture } from './anthropic-cleanup.mjs';

const output = process.argv[2];
assert.ok(output, 'Provide a report output path.');
const directory = await createDesktopTestDirectory('renderer-anthropic');
const userData = join(directory, 'userData'), workspace = join(directory, 'workspace');
await mkdir(userData, { recursive: true, mode: 0o700 });
await mkdir(workspace, { recursive: true });
await mkdir(join(directory, 'home'), { recursive: true });
await mkdir(join(directory, 'codex'), { recursive: true });
await writeFile(join(userData, 'settings.json'), JSON.stringify({ schemaVersion: 1, providerId: 'scripted', modelId: 'local', baseURL: '' }), { mode: 0o600 });
await writeFile(join(workspace, 'fixture.txt'), 'Native Anthropic desktop fixture.\n');
execFileSync('git', ['init', '-q', workspace]);
const apiKey = `sk-ant-local-fixture-${randomUUID()}`, workspaceId = `wrkspc_${randomUUID().replaceAll('-', '')}`;
const model = 'desktop-anthropic-fixture';
const report = { status: 'running', directory, workspace, originalPreserved: true, checks: [], requests: [], rendererErrors: [], noLive: true, accountVerified: false };
let app, originalProcess, page, route = 'read-tool', expectWorkspace = true, heldResponse, cancellationConnectionClosed = false;
const serverErrors = [];
const toolId = `toolu_${randomUUID().replaceAll('-', '')}`;
const wire = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
function responseEvents(tool) {
  return [
    { type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: toolId, name: 'read_file', input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'fixture.txt' }) } : { type: 'text_delta', text: 'Local Anthropic fixture complete.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
}
const server = createServer((incoming, outgoing) => {
  void (async () => {
    const chunks = []; let bytes = 0;
    for await (const chunk of incoming) { bytes += chunk.length; assert.ok(bytes <= 2_097_152); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(incoming.url, '/v1/messages'); assert.equal(incoming.method, 'POST');
    assert.equal(incoming.headers['x-api-key'], apiKey);
    assert.equal(incoming.headers['anthropic-workspace-id'], expectWorkspace ? workspaceId : undefined);
    assert.equal(body.model, model); assert.equal(body.output_config?.effort, 'high');
    assert.ok(Array.isArray(body.tools) && body.tools.some(tool => tool.name === 'read_file'));
    assert.equal(JSON.stringify(body).includes(apiKey), false);
    report.requests.push({ route, credentialHeaderMatched: true, workspaceHeaderPresent: expectWorkspace, modelMatched: true, effort: body.output_config.effort, nativeReadToolOffered: true });
    outgoing.writeHead(200, { 'Content-Type': 'text/event-stream', 'request-id': 'desktop-local-fixture' });
    if (route === 'hold') {
      heldResponse = outgoing;
      outgoing.on('close', () => { cancellationConnectionClosed = true; });
      outgoing.write(wire(responseEvents(false).slice(0, 1)));
    } else {
      const hasResult = body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result' && block.tool_use_id === toolId));
      outgoing.end(wire(responseEvents(route === 'read-tool' && !hasResult)));
    }
  })().catch(error => { serverErrors.push(error instanceof assert.AssertionError ? 'loopback-contract-assertion' : 'loopback-handler-failed'); outgoing.destroy(); });
});
await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
async function command(type, payload) {
  const result = await page.evaluate(({ type, payload, id }) => window.moodcode.command({ schemaVersion: 1, commandId: id, type, payload }), { type, payload, id: randomUUID() });
  assert.equal(result.ok, true, `${type}: ${result.error?.code}`);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
  return result.result;
}
async function bootstrap() {
  const result = await page.evaluate(() => window.moodcode.getBootstrap());
  assert.equal(JSON.stringify(result).includes(apiKey), false);
  assert.equal('apiKey' in result.settings, false);
  return result;
}
async function openSettings() { report.stage = 'opening-settings'; await page.getByRole('button', { name: '모델 설정', exact: true }).click(); await expect(page.getByLabel('연결 방식')).toBeVisible(); }
async function saveSettings() { report.stage = 'saving-settings'; await page.getByRole('button', { name: '설정 저장', exact: true }).click(); await expect(page.locator('dialog[open]')).toHaveCount(0); }
async function submit(prompt) { await page.getByLabel('작업 요청', { exact: true }).fill(prompt); await page.getByRole('button', { name: '작업 시작', exact: true }).click(); }
let sessionId;
const snapshot = () => command('session.getSnapshot', { sessionId });
try {
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  Object.assign(env, { HOME: join(directory, 'home'), CODEX_HOME: join(directory, 'codex'), MOODCODE_DESKTOP_USER_DATA: userData, MOODCODE_DESKTOP_TEST: '1' });
  app = await electron.launch({ args: [join(dirname(fileURLToPath(import.meta.url)), 'anthropic-launch.cjs')], env });
  originalProcess = app.process();
  report.mainUtilityClosePath = await bindMainUtilityClose(app, directory);
  page = await app.firstWindow(); page.setDefaultTimeout(15_000);
  page.on('pageerror', () => report.rendererErrors.push('renderer-page-error'));
  await expect(page.getByText('무엇을 만들어볼까요?', { exact: true })).toBeVisible();
  const initial = await bootstrap();
  report.credentialStorage = initial.settings.credentialStorage;
  if (initial.settings.credentialStorage === 'unavailable') await app.evaluate((_electron, key) => { process.env.ANTHROPIC_API_KEY = key; }, apiKey);
  await openSettings();
  report.stage = 'selecting-anthropic';
  await page.getByLabel('연결 방식').selectOption('anthropic');
  await expect(page.getByLabel('API endpoint', { exact: true })).toHaveValue('https://api.anthropic.com/v1');
  await page.getByLabel('모델 ID', { exact: true }).fill(model);
  await page.getByLabel('API endpoint', { exact: true }).fill(baseURL);
  report.stage = 'setting-workspace-and-effort';
  await page.getByLabel('Anthropic Workspace ID · 선택', { exact: false }).fill(workspaceId);
  await page.getByLabel('추론 강도', { exact: false }).selectOption('high');
  if (initial.settings.credentialStorage === 'available') await page.getByLabel('API 키', { exact: true }).fill(apiKey);
  await saveSettings();
  report.stage = 'checking-saved-settings';
  const configured = await bootstrap();
  assert.equal(configured.settings.providerId, 'anthropic'); assert.equal(configured.settings.anthropicWorkspaceId, workspaceId);
  assert.equal(configured.settings.reasoningEffort, 'high');
  assert.equal(configured.settings.keySource, initial.settings.credentialStorage === 'available' ? 'stored' : 'environment');
  const saved = await readFile(join(userData, 'settings.json'), 'utf8');
  assert.equal(saved.includes(apiKey), false);
  report.checks.push('GUI selects Anthropic, stores optional workspace and effort, and keeps credential out of settings view/plaintext disk.');
  const opened = await command('workspace.open', { path: workspace });
  const session = await command('session.create', { workspaceId: opened.id }); sessionId = session.id;
  await page.evaluate(value => localStorage.setItem('moodcode.selection.v1', JSON.stringify(value)), { workspaceId: opened.id, sessionId });
  await page.reload();
  await expect(page.getByLabel('작업 요청', { exact: true })).toBeVisible();
  await submit('Read fixture.txt using the native read_file tool.');
  await expect.poll(async () => (await snapshot()).runs.at(-1)?.state).toBe('completed');
  const completed = await snapshot();
  assert.ok(completed.tools.some(tool => tool.name === 'read_file' && tool.state === 'completed'));
  assert.equal(report.requests.length, 2);
  report.checks.push('Production utility Anthropic adapter sends exact credential/workspace header and high effort; Native read_file and tool-result continuation complete.');
  await page.reload();
  await openSettings();
  await expect(page.getByLabel('연결 방식')).toHaveValue('anthropic');
  await expect(page.getByLabel('Anthropic Workspace ID · 선택', { exact: false })).toHaveValue(workspaceId);
  await expect(page.getByLabel('API 키', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '취소', exact: true }).click();
  const retried = await page.evaluate(() => window.moodcode.retryEngine()); assert.equal(retried.state, 'ready');
  assert.equal((await bootstrap()).settings.anthropicWorkspaceId, workspaceId);
  assert.equal(report.requests.length, 2);
  report.checks.push('Reload/settings reopen and private host reconnect retain workspace/credential without provider replay.');
  route = 'text'; expectWorkspace = false;
  await openSettings(); await page.getByLabel('Anthropic Workspace ID · 선택', { exact: false }).fill(''); await saveSettings();
  assert.equal((await bootstrap()).settings.anthropicWorkspaceId, undefined);
  await submit('Scoped-key fixture without an explicit workspace.');
  await expect.poll(async () => (await snapshot()).runs.at(-1)?.state).toBe('completed');
  assert.equal(report.requests.length, 3);
  report.checks.push('Workspace-scoped key compatibility: clearing optional workspace keeps key and omits the workspace header.');
  expectWorkspace = true;
  await openSettings(); await page.getByLabel('Anthropic Workspace ID · 선택', { exact: false }).fill(workspaceId); await saveSettings();
  route = 'hold';
  await submit('Cancel the pending local Anthropic stream.');
  await expect.poll(() => report.requests.length).toBe(4);
  await page.getByRole('button', { name: '작업 중지', exact: true }).click();
  await expect.poll(async () => (await snapshot()).runs.at(-1)?.state).toBe('cancelled');
  await expect.poll(() => cancellationConnectionClosed).toBe(true);
  await page.reload(); await expect(page.getByLabel('작업 요청', { exact: true })).toBeVisible();
  assert.equal((await snapshot()).runs.at(-1).state, 'cancelled'); assert.equal(report.requests.length, 4);
  report.checks.push('GUI cancel aborts the actual loopback stream; cancelled Native run survives reload without replay.');
  const isolation = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process, protocol: location.protocol }));
  assert.deepEqual(isolation, { require: 'undefined', process: 'undefined', protocol: 'file:' });
  assert.equal(await app.evaluate(() => globalThis.anthropicRendererNetworkAttempts), 0);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())), true);
  const publicText = await page.evaluate(() => JSON.stringify({ storage: { ...localStorage }, text: document.body.textContent }));
  assert.equal(publicText.includes(apiKey), false);
  assert.deepEqual(serverErrors, []); assert.deepEqual(report.rendererErrors, []);
  report.isolation = isolation; report.rendererNetworkAttempts = 0; report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  const message = error instanceof Error ? error.message : 'Local Anthropic desktop flow failed.';
  report.failure = message.replaceAll(apiKey, '[REDACTED]').replaceAll(workspaceId, '[SYNTHETIC-WORKSPACE]').slice(0, 2048);
  if (page && !page.isClosed()) {
    const visible = await page.locator('.inline-error').allTextContents().catch(() => []);
    report.visibleErrors = visible.map(text => text.replaceAll(apiKey, '[REDACTED]').replaceAll(workspaceId, '[SYNTHETIC-WORKSPACE]').slice(0, 1024));
  }
  process.exitCode = 1;
} finally {
  let nativeAfterClose;
  await finishAnthropicFixture({ report, heldResponse, server, output,
    closeApplication: async () => {
      if (!app) return;
      try { await app.close(); }
      finally {
        report.applicationClose = { exitObserved: Number.isInteger(originalProcess.exitCode) || typeof originalProcess.signalCode === 'string', exitCode: originalProcess.exitCode ?? null, signal: originalProcess.signalCode ?? null, establishesNativeCleanup: false };
      }
    },
    diagnostics: [
      { phase: 'main-utility-close', collect: async () => { report.mainUtilityClose = await readMainUtilityClose(report.mainUtilityClosePath); } },
      { phase: 'native-capture', collect: async () => {
        nativeAfterClose = await captureDesktopNativeEvidence({ sourceDirectory: directory, phase: 'after-close', close: { mainUtility: report.mainUtilityClose, applicationClose: report.applicationClose } });
        report.cleanup = { ...aggregateFixtureCleanup({ mainReceipt: report.mainUtilityClose, nativeConfirmed: qualifyDesktopNativeCleanup(nativeAfterClose) }), originalPreserved: true };
        if (report.cleanup.utilityAcknowledged !== true || report.cleanup.utilityExitObserved !== true) report.status = 'failed';
      } },
      { phase: 'evidence-preserve', collect: async () => {
        report.preservedEvidence = await preserveDesktopTestEvidence({ sourceDirectory: directory, artifactDirectory: resolve('artifacts/renderer-anthropic'), scenario: 'renderer-anthropic', outcome: report.status === 'failed' ? 'failed' : 'unknown', cleanup: report.cleanup, nativeAfterClose });
      } },
    ],
  });
  if (report.status === 'failed') process.exitCode = 1;
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, requests: report.requests.length, report: resolve(output), originalPreserved: true }));
}
