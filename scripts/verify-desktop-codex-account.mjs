import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createDesktopTestDirectory, captureDesktopNativeEvidence, preserveDesktopTestEvidence } from './desktop-test-evidence.mjs';
import { qualifyDesktopNativeCleanup } from './desktop-main-utility-close.mjs';
import { ACCOUNT_DEADLINE_MS, MAX_ACCOUNT_POSTS, parseAccountVerificationArgs, readVerificationFile, selectReadonlyAccount, verifyAccountCoding, safeVerificationCode, verificationFailure, sha256 } from './desktop-codex-account-verification.mjs';

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const project = dirname(dirname(fileURLToPath(import.meta.url)));

export async function runElectron(options) {
  const { app, safeStorage } = await import('electron');
  const source = await realpath(options.sourceUserData);
  let existingOutputParent = dirname(options.reportPath);
  while (true) {
    try { existingOutputParent = await realpath(existingOutputParent); break; }
    catch (error) { if (error?.code !== 'ENOENT' || dirname(existingOutputParent) === existingOutputParent) throw error; existingOutputParent = dirname(existingOutputParent); }
  }
  const artifactsDirectory = await realpath(join(project, 'artifacts'));
  const ancestorRelative = relative(artifactsDirectory, existingOutputParent);
  if (ancestorRelative === '..' || ancestorRelative.startsWith(`..${sep}`) || isAbsolute(ancestorRelative)) throw verificationFailure('VERIFY_ARTIFACT_DIRECTORY_REQUIRED');
  try { await lstat(options.reportPath); throw verificationFailure('VERIFY_EXISTING_REPORT_REFUSED'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await mkdir(dirname(options.reportPath), { recursive: true });
  const outputDirectory = await realpath(dirname(options.reportPath)), outputRelative = relative(source, outputDirectory);
  if (outputRelative === '' || outputRelative !== '..' && !outputRelative.startsWith(`..${sep}`) && !isAbsolute(outputRelative)) throw verificationFailure('VERIFY_REPORT_SOURCE_OVERLAP');
  const artifactsRelative = relative(artifactsDirectory, outputDirectory);
  if (artifactsRelative === '..' || artifactsRelative.startsWith(`..${sep}`) || isAbsolute(artifactsRelative)) throw verificationFailure('VERIFY_ARTIFACT_DIRECTORY_REQUIRED');
  const paths = ['scripts/verify-desktop-codex-account.mjs', 'scripts/desktop-codex-account-verification.mjs', 'apps/desktop/dist/types/main/account-vault.js', 'apps/desktop/dist/types/main/account-auth.js', 'apps/desktop/dist/types/main/settings.js', 'packages/engine/dist/index.js', 'packages/engine/dist/provider/codex.js', 'packages/engine/dist/provider/responses.js', 'packages/engine/dist/runner/index.js'];
  const codePins = async () => Promise.all(paths.map(async path => { const bytes = await readFile(join(project, path)); return { path, bytes: bytes.length, sha256: sha256(bytes) }; }));
  const beforeRunCodePins = await codePins();
  const directory = await createDesktopTestDirectory('app-account-coding');
  // No browser window or production Main is launched; the existing app stays open.
  await app.whenReady();
  const report = { kind: 'actual-selected-Moodcode-account-coding', status: 'running', selectedAppAccountVerified: false,
    originalDirectory: directory, originalPreserved: true, requestLimit: MAX_ACCOUNT_POSTS, deadlineMs: ACCOUNT_DEADLINE_MS,
    credentialSource: 'read-only-Moodcode-encrypted-selected-account', localCodexFallbackUsed: false, refreshedOrSavedUserVault: false,
    existingAppSettingsOrDatabaseWritten: false, runtime: { node: process.versions.node, electron: process.versions.electron, platform: process.platform },
    catalogRequests: [], httpRequests: [], providerAttempts: [], beforeRunCodePins };
  let firstFailure, originalSelectionBytes, originalVault, vault, account;
  try {
    report.stage = 'read-only-selection';
    const accountsDirectory = join(options.sourceUserData, 'accounts');
    try { await lstat(join(accountsDirectory, '.accounts.lock')); throw verificationFailure('VERIFY_ACCOUNT_OPERATION_PENDING'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const { AccountVault } = await import('../apps/desktop/dist/types/main/account-vault.js');
    vault = new AccountVault(accountsDirectory, { isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      ...(process.platform === 'linux' ? { getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend() } : {}), decryptString: bytes => safeStorage.decryptString(bytes),
      encryptString: () => { throw verificationFailure('VERIFY_READ_ONLY_REQUIRED'); } });
    if (await vault.pendingRefresh()) throw verificationFailure('VERIFY_ACCOUNT_REFRESH_UNCERTAIN');
    originalSelectionBytes = await readVerificationFile(join(options.sourceUserData, 'settings.json'), 65_536);
    const settings = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(originalSelectionBytes));
    originalVault = await vault.load();
    account = selectReadonlyAccount(settings, originalVault);
    report.stage = 'native-account-catalog';
    const { ChatGPTAuth, CHATGPT_API, CODEX_CATALOG_VERSION } = await import('../apps/desktop/dist/types/main/account-auth.js');
    const auth = new ChatGPTAuth({ openExternal: async () => { throw verificationFailure('VERIFY_READ_ONLY_REQUIRED'); }, fetch: async (url, init) => {
      if (String(url) !== `${CHATGPT_API}/models?client_version=${CODEX_CATALOG_VERSION}` || init?.method && init.method !== 'GET'
        || init?.redirect !== 'error' || report.catalogRequests.length) throw verificationFailure('VERIFY_CATALOG_REQUEST_LIMIT');
      const observation = { ordinal: 1, responseObserved: false, status: null, failed: false }; report.catalogRequests.push(observation);
      try { const response = await fetch(url, init); observation.responseObserved = true; observation.status = response.status; observation.failed = !response.ok; return response; }
      catch { observation.failed = true; throw verificationFailure('VERIFY_CATALOG_TRANSPORT_FAILED'); }
    } });
    const models = await auth.models(account.tokens, AbortSignal.timeout(25_000));
    if (!models.some(model => model.id === account.modelId)) throw verificationFailure('VERIFY_SELECTED_MODEL_NOT_OFFERED');
    report.modelId = account.modelId; report.catalog = models; report.modelSelection = 'existing-app-settings';
    const { SettingsStore } = await import('../apps/desktop/dist/types/main/settings.js');
    const privateAccount = { accountId: account.publicAccountId, baseURL: CHATGPT_API, models };
    Object.defineProperties(privateAccount, { apiKey: { value: account.credential.accessToken }, chatgptAccountId: { value: account.credential.accountId }, secrets: { value: account.credential.secrets } });
    const store = new SettingsStore({ directory: options.sourceUserData, safeStorage: vault.storage, environment: {}, accountCredential: () => privateAccount });
    const selected = await store.load();
    if (selected.engineConfig.providerId !== 'codex' || selected.engineConfig.codexCredential?.accountId !== account.credential.accountId
      || selected.view.accountId !== account.publicAccountId || selected.engineConfig.modelId !== account.modelId) throw verificationFailure('VERIFY_ACCOUNT_BINDING_REQUIRED');
    report.stage = 'native-coding';
    await verifyAccountCoding({ directory, account, engineModule: await import('@moodcode/engine'), fetch: globalThis.fetch, report });
    report.stage = 'read-only-source-stability';
    report.sourceSelectionUnchanged = originalSelectionBytes.equals(await readVerificationFile(join(options.sourceUserData, 'settings.json'), 65_536));
    report.sourceVaultUnchanged = JSON.stringify(originalVault) === JSON.stringify(await vault.load());
    if (!report.sourceSelectionUnchanged || !report.sourceVaultUnchanged || await vault.pendingRefresh()) throw verificationFailure('VERIFY_SOURCE_CHANGED');
    report.status = 'passed';
  } catch (error) {
    firstFailure = safeVerificationCode(error); report.status = 'failed'; report.selectedAppAccountVerified = false; report.errorCode = firstFailure;
  } finally {
    const failDiagnostic = phase => { (report.diagnosticFailures ??= []).push(phase); report.status = 'failed'; report.selectedAppAccountVerified = false; report.errorCode ??= 'VERIFY_DIAGNOSTIC_FAILED'; };
    // Drop references before producing any diagnostics; no credential object is serialized.
    originalVault = undefined; account = undefined; vault = undefined; originalSelectionBytes = undefined;
    let capture;
    try { capture = await captureDesktopNativeEvidence({ sourceDirectory: directory, phase: 'after-close' }); }
    catch { failDiagnostic('native-capture'); }
    report.cleanup = { state: 'unknown', nativeConfirmed: report.diagnosticFailures ? null : qualifyDesktopNativeCleanup(capture),
      engineCloseCompleted: report.engineClose?.completed === true, originalPreserved: true, establishesRemoteUsage: false };
    if (report.cleanup.nativeConfirmed === false) report.cleanup.state = 'unconfirmed';
    try { report.preservedEvidence = await preserveDesktopTestEvidence({ sourceDirectory: directory, artifactDirectory: dirname(options.reportPath), scenario: 'app-account-coding', outcome: report.status === 'failed' ? 'failed' : 'unknown', cleanup: report.cleanup, nativeAfterClose: capture }); }
    catch { failDiagnostic('evidence-preserve'); report.cleanup.state = 'unknown'; report.cleanup.nativeConfirmed = null; }
    report.remoteUsage = { observedOnly: true, unknownForMissingUsageEvents: true, billingVerified: false, retriesAutomaticallyRequestedByVerifier: false };
    try { report.postRunCodePins = await codePins(); report.selectedCodePinsStable = JSON.stringify(beforeRunCodePins) === JSON.stringify(report.postRunCodePins); if (!report.selectedCodePinsStable) failDiagnostic('code-pin-drift'); }
    catch { failDiagnostic('code-pin'); }
    try { await writeFile(options.reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
    catch { failDiagnostic('report-write'); }
    console.log(JSON.stringify(report));
    app.exit(report.status === 'passed' ? 0 : 1);
  }
}

async function launch(options) {
  const { default: electron } = await import('electron');
  const directory = await createDesktopTestDirectory('app-account-launch');
  await mkdir(join(directory, 'electron-data'), { mode: 0o700 });
  const entry = join(directory, 'verify.cjs');
  // Set the keychain app name and private profile synchronously before ready.
  // Awaiting ready in an ESM entry's module evaluation would prevent readiness.
  await writeFile(entry, `const {app}=require('electron');app.setName('Moodcode');app.setPath('userData',${JSON.stringify(join(directory, 'electron-data'))});void import(${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)}).then(module=>module.runElectron(${JSON.stringify(options)})).catch(()=>{console.error(JSON.stringify({status:'failed',selectedAppAccountVerified:false,errorCode:'VERIFY_ELECTRON_SETUP_FAILED'}));app.exit(1);});\n`, { mode: 0o600 });
  const environment = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'HOME'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const child = spawn(electron, [entry], { cwd: project, env: environment, stdio: ['ignore', 'inherit', 'pipe'] });
  // Native stderr may contain diagnostics; drain it without exposing user data.
  child.stderr.resume();
  let interrupted = false;
  const stop = () => { interrupted = true; child.kill('SIGTERM'); };
  const timer = setTimeout(stop, ACCOUNT_DEADLINE_MS + 90_000);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', () => reject(verificationFailure('VERIFY_ELECTRON_LAUNCH_FAILED')));
      child.once('close', async (code, signal) => {
        if (code !== 0 || signal) process.exitCode = 1;
        try {
          const report = JSON.parse(await readFile(options.reportPath, 'utf8'));
          report.launcherOriginalDirectory = directory; report.launcherOriginalPreserved = true;
          report.applicationClose = { exitObserved: true, exitCode: code, signal, interrupted, establishesNativeCleanup: false };
          if (code !== 0 || signal) { report.status = 'failed'; report.selectedAppAccountVerified = false; report.errorCode ??= 'VERIFY_ORIGINAL_APP_EXIT_FAILED'; }
          await writeFile(options.reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        } catch { process.exitCode = 1; }
        resolve();
      });
    });
  } finally { clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (direct) {
  try {
    if (process.env.NODE_OPTIONS || process.execArgv.some(arg => /^--(?:import|require|loader|eval)|^-[re]/u.test(arg))) throw verificationFailure('VERIFY_PROCESS_HOOKS_REFUSED');
    const options = parseAccountVerificationArgs(process.argv.slice(2));
    if (process.versions.electron) throw verificationFailure('VERIFY_NODE_LAUNCHER_REQUIRED');
    await launch(options);
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', selectedAppAccountVerified: false, errorCode: safeVerificationCode(error) }));
    if (process.versions.electron) (await import('electron')).app.exit(1); else process.exitCode = 1;
  }
}
