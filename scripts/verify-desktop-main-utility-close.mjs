import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDesktopTestDirectory, captureDesktopNativeEvidence, preserveDesktopTestEvidence } from './desktop-test-evidence.mjs';
import { MAIN_UTILITY_CLOSE_EVENT, bindMainUtilityClose, readMainUtilityClose, qualifyMainUtilityClose, qualifyDesktopNativeCleanup, aggregateFixtureCleanup } from './desktop-main-utility-close.mjs';

const output = resolve('artifacts/next-main-utility-close');
const runId = randomUUID();
await mkdir(output, { recursive: true });
const environment = { ...process.env, MOODCODE_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' };
delete environment.ELECTRON_RUN_AS_NODE;
const results = [];
let failed = false;
const bounded = (operation, ms = 10_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Object.assign(new Error('Native boundary observation deadline.'), { code: 'NATIVE_BOUNDARY_DEADLINE' })), ms);
  operation.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

async function productionQuit() {
  const fixture = await createDesktopTestDirectory('main-close-positive');
  let application, before, after, receiptPath, receipt, failure;
  const applicationClose = { requested: false, settled: false, exitObserved: false, exitCode: null, establishesNativeCleanup: false };
  try {
    application = await electron.launch({ timeout: 20_000, args: [resolve('apps/desktop')], env: { ...environment, MOODCODE_DESKTOP_USER_DATA: join(fixture, 'userData'),
      MOODCODE_DESKTOP_TEST: '1', MOODCODE_DESKTOP_TEST_SCENARIO: 'coding' } });
    application.process().once('exit', code => { applicationClose.exitObserved = true; applicationClose.exitCode = code; });
    receiptPath = await bindMainUtilityClose(application, fixture);
    const page = await application.firstWindow();
    await expect(page.getByText('무엇을 만들어볼까요?', { exact: true })).toBeVisible({ timeout: 20_000 });
    const bootstrap = await page.evaluate(() => window.moodcode.getBootstrap());
    assert.equal(bootstrap.host.state, 'ready');
    before = await captureDesktopNativeEvidence({ sourceDirectory: fixture, phase: 'before-close', close: { mainUtility: await readMainUtilityClose(receiptPath), applicationClose } });
    assert.equal(before.sqlite.find(item => item.file === 'userData/engine.sqlite')?.userVersion, 23);
    applicationClose.requested = true;
    await bounded(application.close()); application = undefined; applicationClose.settled = true;
    receipt = await readMainUtilityClose(receiptPath);
    after = await captureDesktopNativeEvidence({ sourceDirectory: fixture, phase: 'after-close', close: { mainUtility: receipt, applicationClose } });
    assert.equal(qualifyMainUtilityClose(receipt).state, 'confirmed');
    assert.ok(receipt.connections.every(item => item.source === 'original-electron-utility' && item.utilityExitObservable && item.engineCloseAcknowledged && item.utilityExitObserved && item.exitCode === 0));
    // Utility acceptance is separate from wider native-record coverage. Unknown
    // native cleanup keeps the original fixture even with a genuine clean exit.
    assert.notEqual(qualifyDesktopNativeCleanup(after), false);
    assert.equal(applicationClose.exitObserved, true); assert.equal(applicationClose.exitCode, 0);
  } catch (error) { failure = error; }
  finally {
    if (application) await bounded(application.close()).catch(() => {});
    receipt ??= receiptPath ? await readMainUtilityClose(receiptPath) : null;
    before ??= await captureDesktopNativeEvidence({ sourceDirectory: fixture, phase: 'before-close' });
    after ??= await captureDesktopNativeEvidence({ sourceDirectory: fixture, phase: 'after-close', close: { mainUtility: receipt, applicationClose } });
    const cleanup = aggregateFixtureCleanup({ mainReceipt: receipt, nativeConfirmed: qualifyDesktopNativeCleanup(after) });
    // This acceptance verifier keeps its fresh source as reviewable evidence.
    const retention = await preserveDesktopTestEvidence({ sourceDirectory: fixture, artifactDirectory: join(output, 'fixtures'), scenario: 'main-close-positive',
      outcome: failure ? 'failed' : 'unknown', cleanup, nativeBeforeClose: before, nativeAfterClose: after });
    results.push({ case: 'production-main-app-quit', ok: !failure, receipt, cleanup, applicationClose, sourceFixture: fixture,
      evidenceManifest: retention.manifestPath, originalFixtureRetained: true, errorCode: failure?.code ?? (failure ? 'ASSERTION_FAILED' : null) });
  }
  if (failure) throw failure;
}

async function faultBoundary(mode) {
  const fixture = await createDesktopTestDirectory(`main-close-${mode}`);
  const entry = join(fixture, 'entry.mjs'), worker = join(fixture, 'worker.cjs');
  const key = `__moodcodeNativeClose_${randomUUID().replaceAll('-', '')}`;
  await writeFile(entry, `import { app } from 'electron'; import { DesktopHost } from ${JSON.stringify(pathToFileURL(resolve('apps/desktop/dist/types/main/host.js')).href)}; globalThis[${JSON.stringify(key)}]=DesktopHost; app.on('window-all-closed', () => {});\n`);
  await writeFile(worker, `const parentPort=process.parentPort;if(!parentPort)throw new Error('Original Electron utility parent port required.');
let rejected=false;
parentPort.on('message',({data:m})=>{
  if(m.type==='start'||m.type==='assertIdle'){parentPort.postMessage({id:m.id,ok:true,result:{}});return;}
  if(m.type!=='close')return;
  const mode=process.argv[2];
  if(mode==='close-error'&&!rejected){rejected=true;parentPort.postMessage({id:m.id,ok:false,error:{code:'NATIVE_CLOSE_REFUSED',message:'Controlled native close refusal.'}});setTimeout(()=>process.exit(0),200);return;}
  if(mode==='ack-absent'){setTimeout(()=>process.exit(0),1000);return;}
  if(mode==='exit-without-ack'){setTimeout(()=>process.exit(0),30);return;}
  parentPort.postMessage({id:m.id,ok:true,result:{}});
  setTimeout(()=>process.exit(0),mode==='exit-timeout'?1000:mode==='late-original'?450:30);
});\n`);
  let application, receiptPath, before, after, receipt, observation, failure;
  try {
    application = await electron.launch({ timeout: 20_000, args: [entry], env: { ...environment, MOODCODE_DESKTOP_USER_DATA: join(fixture, 'userData') } });
    receiptPath = await bindMainUtilityClose(application, fixture);
    const started = await application.evaluate(async ({ app, utilityProcess }, { key, worker, fixture, mode, event }) => {
      const DesktopHost = globalThis[key];
      const children = [];
      const config = { providerId: 'scripted', modelId: 'local', baseURL: '' };
      const settings = { load: async () => ({ engineConfig: config }), getView: () => ({ ...config, keyConfigured: false, keySource: 'none', credentialStorage: 'unavailable' }) };
      const host = new DesktopHost({ settings, dbPath: `${fixture}/engine.sqlite`, artifactDir: `${fixture}/artifacts`, platform: process.platform, version: 'fixture',
        rpcTimeoutMs: 2000, closeTimeoutMs: 200, utilityExitTimeoutMs: mode === 'late-original' ? 1500 : 100,
        onUtilityClose: dto => app.emit(event, dto), spawn: () => {
          const childMode = mode === 'late-original' && children.length ? 'clean' : mode;
          const child = utilityProcess.fork(worker, [childMode], { stdio: 'pipe', serviceName: 'Moodcode finite original utility boundary' });
          child.stdout?.resume(); child.stderr?.resume();
          const original = { child, exitObserved: false, exitCode: null };
          original.exit = new Promise(resolve => child.once('exit', code => { original.exitObserved = true; original.exitCode = code; resolve(code); }));
          children.push(original);
          return { diagnosticSource: 'original-electron-utility', postMessage: message => child.postMessage(message),
            onMessage: listener => { child.on('message', listener); return () => child.off('message', listener); },
            onExit: listener => { child.on('exit', listener); return () => child.off('exit', listener); } };
        } });
      globalThis[key] = { host, children };
      if (mode !== 'never-started') return await host.initialize();
      return host.getStatus();
    }, { key, worker, fixture, mode, event: MAIN_UTILITY_CLOSE_EVENT });
    assert.equal(started.state, mode === 'never-started' ? 'starting' : 'ready', 'A fault must be applied to a genuinely started original utility.');
    before = await captureDesktopNativeEvidence({ sourceDirectory: fixture, phase: 'before-close', close: { mainUtility: await readMainUtilityClose(receiptPath) } });
    observation = await bounded(application.evaluate(async ({}, { key, mode }) => {
      const { host, children } = globalThis[key];
      const code = error => typeof error?.code === 'string' ? error.code : 'NATIVE_BOUNDARY_FAILURE';
      let closeError = null, updateError = null, beforeLateExit = null;
      if (mode === 'late-original') {
        await host.retryEngine();
        beforeLateExit = host.getUtilityCloseDiagnostics();
      }
      try { await host.closeForUpdate(); } catch (error) { closeError = code(error); }
      // Workers end themselves on finite timers. Their original objects remain
      // the exit source; no PID lookup, app exit, or driver kill grants proof.
      await Promise.all(children.map(item => item.exit));
      try { await host.closeForUpdate(); } catch (error) { updateError = code(error); }
      return { closeError, updateError, beforeLateExit, receipt: host.getUtilityCloseDiagnostics(), originalUtilityCount: children.length,
        originalExits: children.map(item => ({ exitObserved: item.exitObserved, exitCode: item.exitCode })), forcedStop: false };
    }, { key, mode }), 5000);
    receipt = observation.receipt;
    if (mode === 'never-started') {
      assert.equal(observation.originalUtilityCount, 0); assert.equal(observation.closeError, null); assert.equal(observation.updateError, null);
      assert.equal(qualifyMainUtilityClose(receipt).state, 'unknown');
    } else if (mode === 'late-original') {
      assert.equal(observation.originalUtilityCount, 2);
      assert.equal(observation.beforeLateExit.connections[0].engineCloseAcknowledged, true);
      assert.equal(observation.beforeLateExit.connections[0].utilityExitObserved, false);
      assert.equal(observation.beforeLateExit.connections[1].generation, 2);
      assert.equal(qualifyMainUtilityClose(observation.beforeLateExit).state, 'unknown');
      assert.equal(qualifyMainUtilityClose(receipt).state, 'confirmed');
      assert.equal(observation.closeError, null); assert.equal(observation.updateError, null);
    } else {
      assert.equal(qualifyMainUtilityClose(receipt).state, 'unknown');
      assert.equal(observation.updateError, 'HOST_UTILITY_CLOSE_UNCONFIRMED');
      assert.equal(receipt.connections[0].reason, mode === 'ack-absent' ? 'close-timeout' : mode);
      assert.equal(receipt.connections[0].engineCloseAcknowledged, mode === 'exit-timeout');
    }
    assert.ok(observation.originalExits.every(item => item.exitObserved && item.exitCode === 0));
    const persisted = await readMainUtilityClose(receiptPath);
    assert.deepEqual(persisted, qualifyMainUtilityClose(receipt).receipt);
    await bounded(application.close()); application = undefined;
    after = await captureDesktopNativeEvidence({ sourceDirectory: fixture, phase: 'after-close', close: { mainUtility: persisted } });
  } catch (error) { failure = error; }
  finally {
    if (application) await bounded(application.close()).catch(() => {});
    before ??= await captureDesktopNativeEvidence({ sourceDirectory: fixture, phase: 'before-close' });
    after ??= await captureDesktopNativeEvidence({ sourceDirectory: fixture, phase: 'after-close', close: { mainUtility: receipt } });
    const cleanup = aggregateFixtureCleanup({ mainReceipt: receipt, nativeConfirmed: qualifyDesktopNativeCleanup(after) });
    const retention = await preserveDesktopTestEvidence({ sourceDirectory: fixture, artifactDirectory: join(output, 'fixtures'), scenario: `main-close-${mode}`,
      outcome: failure || !['never-started', 'late-original'].includes(mode) ? 'failed' : 'unknown', cleanup, nativeBeforeClose: before, nativeAfterClose: after });
    assert.ok((await stat(fixture)).isDirectory());
    results.push({ case: mode, ok: !failure, expectedControlledFault: !['never-started', 'late-original'].includes(mode), observation, cleanup,
      nativeEngineEffectsCovered: false, originalFixtureRetained: true, sourceFixture: fixture, evidenceManifest: retention.manifestPath,
      errorCode: failure?.code ?? (failure ? 'ASSERTION_FAILED' : null) });
  }
  if (failure) throw failure;
}

try {
  await productionQuit();
  for (const mode of ['close-error', 'ack-absent', 'exit-without-ack', 'exit-timeout', 'late-original', 'never-started']) await faultBoundary(mode);
} catch (error) { failed = true; console.error(error); process.exitCode = 1; }
const report = { schemaVersion: 1, ok: !failed, platform: process.platform, architecture: process.arch, finite: true,
  physicalApplicationExitEstablishesCleanup: false, noForcedStop: results.every(result => !result.observation?.forcedStop), results };
const reportPath = join(output, `native-close-boundary-${runId}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ ok: report.ok, cases: results.map(result => ({ case: result.case, ok: result.ok })), reportPath }));
