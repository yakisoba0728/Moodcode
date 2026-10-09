import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createDesktopTestDirectory } from './desktop-test-evidence.mjs';
import { CODEX_ACCOUNT_ENDPOINT, parseAccountVerificationArgs, readVerificationFile, selectReadonlyAccount, safeVerificationCode, verificationFailure, sha256 } from './desktop-codex-account-verification.mjs';

// One selected-account renewal through the production Main path: the previous access token's
// expiry is advanced in memory only, so real time crosses the 60s renewal window while token
// expiry and ID-token validation keep the real clock. The rotated grant is saved by the product.
export const ADVANCED_EXPIRY_MS = 180_000;
export const RENEWAL_WINDOW_MS = 60_000;
export const TURN_COUNT = 3;
export const RENEWAL_DEADLINE_MS = 420_000;
const ISSUER = 'https://auth.openai.com';
const AUTH_LIMITS = Object.freeze({ 'token-refresh': 1, discovery: 2, jwks: 2, catalog: 3 });
const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const project = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Main-side account requests are allow-listed and counted before dispatch. A refusal during
 * renewal would quarantine the consumed grant, so jwksURL comes from the issuer's own discovery.
 */
export function classifyAccountRequest(url, init, { catalogURL, jwksURL }) {
  const method = init?.method ?? 'GET', target = String(url);
  if (init?.redirect !== 'error') return undefined;
  if (target === `${ISSUER}/oauth/token` && method === 'POST') return 'token-refresh';
  if (target === `${ISSUER}/.well-known/openid-configuration` && method === 'GET') return 'discovery';
  if (target === jwksURL && method === 'GET') return 'jwks';
  if (target === catalogURL && method === 'GET') return 'catalog';
  return undefined;
}

/** The product requires the same issuer and origin; anything else stops before an account request. */
export function discoveredJwksURL(document) {
  const value = document?.jwks_uri;
  if (document?.issuer !== ISSUER || typeof value !== 'string') throw verificationFailure('VERIFY_DISCOVERY_INVALID');
  let url;
  try { url = new URL(value); } catch { throw verificationFailure('VERIFY_DISCOVERY_INVALID'); }
  if (url.origin !== ISSUER || url.username || url.password || url.hash || url.search) throw verificationFailure('VERIFY_DISCOVERY_INVALID');
  return value;
}

/** Advances only the selected account's in-memory expiry on the first decrypt; the stored record is unchanged. */
export function advanceSelectedExpiry(value, now, advanceMs = ADVANCED_EXPIRY_MS) {
  const active = Array.isArray(value?.accounts) ? value.accounts.find(account => account?.id === value.activeAccountId) : undefined;
  if (!active?.tokens || !Number.isFinite(active.tokens.expiresAt)) throw verificationFailure('VERIFY_FRESH_NATIVE_ACCOUNT_REQUIRED');
  active.tokens.expiresAt = Math.min(active.tokens.expiresAt, now + advanceMs);
  return value;
}

/** Maps credential digests to ordinal revisions; no digest or credential is reported. */
export function createRevisionTracker() {
  const revisions = new Map();
  return digest => { if (!revisions.has(digest)) revisions.set(digest, revisions.size + 1); return revisions.get(digest); };
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runElectron(options) {
  const { app, safeStorage, utilityProcess } = await import('electron');
  const source = await realpath(options.sourceUserData), accountsDirectory = join(source, 'accounts');
  await mkdir(dirname(options.reportPath), { recursive: true });
  const artifactsRelative = relative(await realpath(join(project, 'artifacts')), await realpath(dirname(options.reportPath)));
  if (artifactsRelative === '..' || artifactsRelative.startsWith(`..${sep}`) || isAbsolute(artifactsRelative)) throw verificationFailure('VERIFY_ARTIFACT_DIRECTORY_REQUIRED');
  try { await lstat(options.reportPath); throw verificationFailure('VERIFY_EXISTING_REPORT_REFUSED'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await app.whenReady();
  const directory = await createDesktopTestDirectory('app-account-renewal');
  const dist = path => pathToFileURL(join(project, 'apps/desktop/dist', path)).href;
  const [{ AccountVault }, { DesktopAccounts }, { SettingsStore }, { DesktopHost, HostError }, { CHATGPT_API, CODEX_CATALOG_VERSION }] = await Promise.all(
    ['types/main/account-vault.js', 'types/main/accounts.js', 'types/main/settings.js', 'types/main/host.js', 'types/main/account-auth.js'].map(path => import(dist(path))));
  const report = { kind: 'actual-selected-Moodcode-account-renewal', status: 'running', originalDirectory: directory,
    freshnessTrigger: 'previous-access-token-expiry-advanced-in-memory', storedRecordAdvanced: false, renewalWindowMs: RENEWAL_WINDOW_MS, advancedExpiryAfterLoadMs: ADVANCED_EXPIRY_MS,
    runtime: { node: process.versions.node, electron: process.versions.electron, platform: process.platform }, accountRequests: [], modelRequests: [], credentialResolutions: [], turns: [] };
  const secrets = new Set(), revisionOf = createRevisionTracker();
  const plainStorage = { isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(), encryptString: value => safeStorage.encryptString(value), decryptString: bytes => safeStorage.decryptString(bytes),
    ...(process.platform === 'linux' ? { getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend() } : {}) };
  const readOnly = () => new AccountVault(accountsDirectory, { ...plainStorage, encryptString: () => { throw verificationFailure('VERIFY_READ_ONLY_REQUIRED'); } });
  let accounts, host, firstFailure, advancedAt, original, settingsBytes;
  const stage = name => { report.stage = name; };
  try {
    stage('read-only-preflight');
    try { await lstat(join(accountsDirectory, '.accounts.lock')); throw verificationFailure('VERIFY_ACCOUNT_OPERATION_PENDING'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const before = readOnly();
    if (await before.pendingRefresh()) throw verificationFailure('VERIFY_ACCOUNT_REFRESH_UNCERTAIN');
    settingsBytes = await readVerificationFile(join(source, 'settings.json'), 65_536);
    const settings = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(settingsBytes));
    original = await before.load();
    const selected = selectReadonlyAccount(settings, original);
    for (const secret of selected.credential.secrets) secrets.add(secret);
    original = { hostId: original.hostId, count: original.accounts.length, activeAccountId: original.activeAccountId, subject: original.accounts.find(item => item.id === original.activeAccountId).subject,
      access: sha256(selected.tokens.accessToken), refresh: selected.tokens.refreshToken ? sha256(selected.tokens.refreshToken) : null, routing: sha256(selected.credential.accountId) };
    report.modelId = selected.modelId;

    // Public, unauthenticated: the same document the product reads before ID-token validation.
    const discovery = await fetch(`${ISSUER}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    report.preflightDiscovery = { status: discovery.status };
    if (!discovery.ok) throw verificationFailure('VERIFY_DISCOVERY_INVALID');
    const destinations = { catalogURL: `${CHATGPT_API}/models?client_version=${CODEX_CATALOG_VERSION}`, jwksURL: discoveredJwksURL(await discovery.json()) }, counts = {};
    const accountFetch = async (url, init) => {
      const kind = classifyAccountRequest(url, init, destinations);
      if (!kind) throw verificationFailure('VERIFY_ACCOUNT_DESTINATION_REFUSED');
      if ((counts[kind] = (counts[kind] ?? 0) + 1) > AUTH_LIMITS[kind]) throw verificationFailure('VERIFY_REQUEST_LIMIT');
      const observation = { ordinal: report.accountRequests.length + 1, kind, atMs: Date.now() - (advancedAt ?? Date.now()), status: null, failed: false };
      report.accountRequests.push(observation);
      try { const response = await fetch(url, init); observation.status = response.status; observation.failed = !response.ok; return response; }
      catch (error) { observation.failed = true; throw error; }
    };
    const advancingStorage = { ...plainStorage, decryptString: bytes => {
      const value = JSON.parse(safeStorage.decryptString(bytes));
      if (advancedAt !== undefined) throw verificationFailure('VERIFY_UNEXPECTED_RELOAD');
      advancedAt = Date.now();
      return JSON.stringify(advanceSelectedExpiry(value, advancedAt));
    } };
    accounts = new DesktopAccounts({ directory: accountsDirectory, safeStorage: advancingStorage, fetch: accountFetch, openExternal: async () => { throw verificationFailure('VERIFY_BROWSER_REFUSED'); } });
    const settingsStore = new SettingsStore({ directory: source, safeStorage: plainStorage, environment: {}, accountCredential: () => accounts.getCredential() });
    const refused = async () => { throw verificationFailure('VERIFY_READ_ONLY_REQUIRED'); };
    const worker = join(directory, 'worker.cjs'), workerModule = dist('main/engine-worker.js');
    await writeFile(worker, `const real=globalThis.fetch;let posts=0;const note=value=>process.stdout.write('MOODCODE_RENEWAL_HTTP '+JSON.stringify(value)+'\\n');
globalThis.fetch=async(url,init)=>{if(String(url)!==${JSON.stringify(CODEX_ACCOUNT_ENDPOINT)}||init?.method!=='POST'||init.redirect!=='error')throw new Error('VERIFY_NATIVE_DESTINATION_REQUIRED');
const ordinal=++posts;if(ordinal>${TURN_COUNT})throw new Error('VERIFY_REQUEST_LIMIT');note({ordinal,phase:'dispatched'});
try{const response=await real(url,init);note({ordinal,phase:'response',status:response.status});return response;}catch(error){note({ordinal,phase:'failed'});throw error;}};
void import(${JSON.stringify(workerModule)});\n`, { mode: 0o600 });
    let spawned = 0;
    host = new DesktopHost({
      settings: { load: async () => { await accounts.resolveCredential(); return settingsStore.load(); }, prepare: refused, commit: refused, getView: () => settingsStore.getView() },
      dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), platform: process.platform, version: 'renewal-verification',
      rpcTimeoutMs: 120_000, closeTimeoutMs: 30_000, utilityExitTimeoutMs: 15_000,
      resolveCodexCredential: async (accountId, modelId, signal) => {
        const resolution = { ordinal: report.credentialResolutions.length + 1, startedAtMs: Date.now() - advancedAt, refreshesBefore: counts['token-refresh'] ?? 0 };
        report.credentialResolutions.push(resolution);
        const credential = await accounts.resolveCredential(signal, accountId);
        // Same rejection as production Main.
        if (!credential || credential.accountId !== accountId || !credential.models.some(model => model.id === modelId)) throw new HostError('ACCOUNT_REAUTH_REQUIRED', 'The selected Codex account or model is unavailable.');
        for (const secret of credential.secrets) secrets.add(secret);
        Object.assign(resolution, { revision: revisionOf(sha256(credential.apiKey)), routingUnchanged: sha256(credential.chatgptAccountId) === original.routing, refreshesAfter: counts['token-refresh'] ?? 0 });
        return { accessToken: credential.apiKey, accountId: credential.chatgptAccountId, secrets: [...credential.secrets] };
      },
      spawn: () => {
        spawned++;
        const child = utilityProcess.fork(worker, [], { serviceName: 'Moodcode account renewal verification', stdio: 'pipe' });
        let buffered = '';
        child.stdout?.on('data', chunk => { buffered += chunk; let index; while ((index = buffered.indexOf('\n')) >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
          if (line.startsWith('MOODCODE_RENEWAL_HTTP ')) try { report.modelRequests.push({ ...JSON.parse(line.slice(22)), atMs: Date.now() - advancedAt }); } catch { /* Malformed diagnostics are ignored. */ } } });
        child.stderr?.resume();
        return { diagnosticSource: 'original-electron-utility', postMessage: message => child.postMessage(message),
          onMessage: listener => { child.on('message', listener); return () => child.off('message', listener); },
          onExit: listener => { child.on('exit', listener); return () => child.off('exit', listener); } };
      },
    });
    const command = async (type, payload) => { const response = await host.command({ schemaVersion: 1, commandId: randomUUID(), type, payload }); if (!response.ok) throw verificationFailure(safeVerificationCode(response.error)); return response.result; };
    const finish = async (sessionId, runId) => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) { const snapshot = await command('session.getSnapshot', { sessionId }); const run = snapshot.runs.find(item => item.id === runId);
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run?.state)) return run; await pause(250); }
      throw verificationFailure('VERIFY_RUN_TIMEOUT');
    };

    stage('initialize');
    if ((await host.initialize()).state !== 'ready') throw verificationFailure('VERIFY_HOST_NOT_READY');
    if ((counts['token-refresh'] ?? 0) !== 0) throw verificationFailure('VERIFY_UNEXPECTED_EARLY_RENEWAL');
    const repository = join(directory, 'repository'); await mkdir(repository, { mode: 0o700 });
    execFileSync('git', ['init', '-q', '--template=', repository], { timeout: 5_000, stdio: 'ignore' });
    const workspace = await command('workspace.open', { path: repository });
    const session = await command('session.create', { workspaceId: workspace.id, title: 'Selected account renewal verification' });
    for (let ordinal = 1; ordinal <= TURN_COUNT; ordinal++) {
      stage(`turn-${ordinal}`);
      // Turn 1 must resolve before the window; turn 2 after it. Nothing grant-consuming happens before turn 2.
      if (ordinal === 1 && Date.now() - advancedAt > ADVANCED_EXPIRY_MS - RENEWAL_WINDOW_MS - 15_000) throw verificationFailure('VERIFY_FRESHNESS_WINDOW_MISSED');
      if (ordinal === 2) { const wait = advancedAt + ADVANCED_EXPIRY_MS - RENEWAL_WINDOW_MS + 5_000 - Date.now(); if (wait > 0) await pause(wait); }
      const receipt = await command('run.submit', { sessionId: session.id, requestId: `renewal-${ordinal}`, prompt: 'Reply with exactly the word OK. Do not call any tools.',
        config: { mode: 'plan', providerId: 'codex', modelId: report.modelId, limits: { maxTurns: 1, maxDurationMs: 90_000 } } });
      const run = await finish(session.id, receipt.runId);
      report.turns.push({ ordinal, state: run.state, errorCode: run.error?.code ?? null, refreshesAfter: counts['token-refresh'] ?? 0 });
      if (run.state !== 'completed') throw verificationFailure('VERIFY_TURN_FAILED');
      if (ordinal === 1 && (counts['token-refresh'] ?? 0) !== 0) throw verificationFailure('VERIFY_UNEXPECTED_EARLY_RENEWAL');
      if (ordinal >= 2 && (counts['token-refresh'] ?? 0) !== 1) throw verificationFailure('VERIFY_RENEWAL_NOT_OBSERVED');
    }
    stage('close');
    report.generation = host.getStatus().generation; report.spawned = spawned;
    await host.close(); report.utilityClose = host.getUtilityCloseDiagnostics(); host = undefined;
    await accounts.close(); accounts = undefined;
    if (report.credentialResolutions.map(item => item.revision).join(',') !== '1,2,2' || !report.credentialResolutions.every(item => item.routingUnchanged)) throw verificationFailure('VERIFY_CREDENTIAL_SEQUENCE_UNEXPECTED');
    if (report.generation !== 1 || report.spawned !== 1) throw verificationFailure('VERIFY_WORKER_RESTARTED');
    if (report.utilityClose?.cleanupConfirmed !== true || report.utilityClose.connections?.[0]?.exitCode !== 0) throw verificationFailure('VERIFY_UTILITY_CLOSE_UNCONFIRMED');
    report.status = 'observed';
  } catch (error) {
    firstFailure = safeVerificationCode(error); report.status = 'failed'; report.errorCode = firstFailure;
  } finally {
    try { await host?.close(); report.utilityClose ??= host?.getUtilityCloseDiagnostics(); } catch { report.hostCloseFailed = true; }
    try { await accounts?.close(); } catch { report.accountsCloseFailed = true; }
    try {
      // Read-only after-state from a separate vault instance; only digests are compared.
      const after = readOnly(), pending = await after.pendingRefresh(), saved = await after.load();
      const active = saved?.accounts?.find(item => item.id === saved.activeAccountId), now = Date.now();
      for (const value of [active?.tokens?.accessToken, active?.tokens?.refreshToken, active?.tokens?.idToken, active?.tokens?.chatgptAccountId]) if (value) secrets.add(value);
      report.afterVault = { pendingRefresh: !!pending, state: active?.state ?? null, hasTokens: !!active?.tokens, sameActiveAccount: saved?.activeAccountId === original?.activeAccountId,
        sameHost: saved?.hostId === original?.hostId, sameAccountCount: saved?.accounts?.length === original?.count, sameSubject: active?.subject === original?.subject,
        accessTokenChanged: !!active?.tokens && sha256(active.tokens.accessToken) !== original?.access,
        refreshTokenChanged: !!active?.tokens?.refreshToken && sha256(active.tokens.refreshToken) !== original?.refresh,
        routingUnchanged: !!active?.tokens && sha256(active.tokens.chatgptAccountId) === original?.routing,
        expiresAt: active?.tokens ? new Date(active.tokens.expiresAt).toISOString() : null, remainingHours: active?.tokens ? Math.round((active.tokens.expiresAt - now) / 3_600_000) : null,
        advancedExpiryNotPersisted: !!active?.tokens && active.tokens.expiresAt > now + 86_400_000,
        // A lease left behind would make the real app report ACCOUNT_STORAGE_BUSY.
        leaseReleased: await lstat(join(accountsDirectory, '.accounts.lock')).then(() => false, error => error?.code === 'ENOENT') };
      report.settingsUnchanged = !!settingsBytes && settingsBytes.equals(await readVerificationFile(join(source, 'settings.json'), 65_536));
    } catch (error) { report.afterVault = { readFailed: safeVerificationCode(error) }; }
    const state = report.afterVault;
    report.renewalPersisted = state.state === 'connected' && state.hasTokens && !state.pendingRefresh && state.accessTokenChanged && state.routingUnchanged
      && state.sameSubject && state.sameActiveAccount && state.sameHost && state.sameAccountCount && state.advancedExpiryNotPersisted && state.leaseReleased && report.settingsUnchanged === true;
    const serialized = JSON.stringify(report, null, 2) + '\n';
    if ([...secrets].some(secret => serialized.includes(secret))) { console.error(JSON.stringify({ status: 'failed', errorCode: 'VERIFY_REPORT_REDACTION_FAILED' })); app.exit(1); }
    else {
      try { await writeFile(options.reportPath, serialized, { mode: 0o600, flag: 'wx' }); } catch { report.reportWriteFailed = true; }
      console.log(serialized.trim());
      app.exit(report.status === 'observed' && !firstFailure && report.renewalPersisted ? 0 : 1);
    }
  }
}

async function launch(options) {
  const { default: electron } = await import('electron');
  const directory = await createDesktopTestDirectory('app-account-renewal-launch');
  await mkdir(join(directory, 'electron-data'), { mode: 0o700 });
  const entry = join(directory, 'verify.cjs');
  // Keychain app name and a private profile are set synchronously before ready.
  await writeFile(entry, `const {app}=require('electron');app.setName('Moodcode');app.setPath('userData',${JSON.stringify(join(directory, 'electron-data'))});app.on('window-all-closed',()=>{});void import(${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)}).then(module=>module.runElectron(${JSON.stringify(options)})).catch(()=>{console.error(JSON.stringify({status:'failed',errorCode:'VERIFY_ELECTRON_SETUP_FAILED'}));app.exit(1);});\n`, { mode: 0o600 });
  const environment = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'HOME'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const child = spawn(electron, [entry], { cwd: project, env: environment, stdio: ['ignore', 'inherit', 'pipe'] });
  child.stderr.resume();
  const stop = () => child.kill('SIGTERM'), timer = setTimeout(stop, RENEWAL_DEADLINE_MS + 60_000);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', () => reject(verificationFailure('VERIFY_ELECTRON_LAUNCH_FAILED')));
      child.once('close', (code, signal) => { if (code !== 0 || signal) process.exitCode = 1; resolve(); });
    });
  } finally { clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (direct) {
  try {
    if (process.env.NODE_OPTIONS || process.execArgv.some(arg => /^--(?:import|require|loader|eval)|^-[re]/u.test(arg))) throw verificationFailure('VERIFY_PROCESS_HOOKS_REFUSED');
    if (process.versions.electron) throw verificationFailure('VERIFY_NODE_LAUNCHER_REQUIRED');
    const options = parseAccountVerificationArgs(process.argv.slice(2));
    await mkdir(join(project, 'artifacts'), { recursive: true });
    await launch(options);
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', errorCode: safeVerificationCode(error) }));
    process.exitCode = 1;
  }
}
