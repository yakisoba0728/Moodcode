import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join, resolve, relative, sep } from 'node:path';

export const CODEX_ACCOUNT_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
export const MAX_ACCOUNT_POSTS = 6;
export const ACCOUNT_DEADLINE_MS = 180_000;
export const FIXTURE_BEFORE = 'export function add(a, b) { return a - b; }\nexport function multiply(a, b) { return a * b; }\n';
export const FIXTURE_AFTER = FIXTURE_BEFORE.replace('return a - b;', 'return a + b;');
export const FIXTURE_COMMAND = 'node --test --test-reporter=tap math.test.mjs';
export const FIXTURE_TEST = "import {test} from 'node:test';import assert from 'node:assert/strict';import {add,multiply} from './math.mjs';\nfor(const [a,b,expected] of [[2,3,5],[0,0,0],[-2,-3,-5],[0,5,5],[1.5,2.5,4]])test(`add ${a},${b}`,()=>assert.equal(add(a,b),expected));\nfor(const [a,b,expected] of [[2,3,6],[0,5,0],[-2,-3,6],[-2,3,-6],[1.5,2,3]])test(`multiply ${a},${b}`,()=>assert.equal(multiply(a,b),expected));\n";
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function verificationFailure(code) { return Object.assign(new Error('The bounded app-account verification did not complete.'), { code }); }
export function safeVerificationCode(error) { return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code) ? error.code : 'ACCOUNT_CODING_VERIFICATION_FAILED'; }
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const ascii = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/u.test(value);

export function parseAccountVerificationArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--live', '--source-user-data', '--report'].includes(flag) || Object.hasOwn(result, flag)) throw verificationFailure('VERIFY_INVALID_ARGUMENT');
    if (flag === '--live') result[flag] = true;
    else {
      const value = argv[++i];
      if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/u.test(value) || value.length > 4096) throw verificationFailure('VERIFY_INVALID_ARGUMENT');
      result[flag] = value;
    }
  }
  if (result['--live'] !== true) throw verificationFailure('VERIFY_LIVE_OPT_IN_REQUIRED');
  if (!isAbsolute(result['--source-user-data'] ?? '') || !result['--report']) throw verificationFailure('VERIFY_INVALID_ARGUMENT');
  const sourceUserData = resolve(result['--source-user-data']), reportPath = resolve(result['--report']);
  const child = relative(sourceUserData, reportPath);
  if (child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)) throw verificationFailure('VERIFY_REPORT_SOURCE_OVERLAP');
  return Object.freeze({ sourceUserData, reportPath });
}

/** Bounded stable bytes only; this never opens a user's SQLite database. */
export async function readVerificationFile(path, maxBytes = 1_048_576) {
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes
      || (process.platform !== 'win32' && (before.mode & 0o077) !== 0)) throw verificationFailure('VERIFY_SOURCE_UNSAFE');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw verificationFailure('VERIFY_SOURCE_CHANGED');
    const buffer = Buffer.alloc(maxBytes + 1); let bytes = 0;
    while (bytes < buffer.length) { const part = await handle.read(buffer, bytes, buffer.length - bytes, bytes); if (!part.bytesRead) break; bytes += part.bytesRead; }
    const after = await handle.stat(), current = await lstat(path);
    if (bytes > maxBytes || bytes !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || current.dev !== opened.dev || current.ino !== opened.ino) throw verificationFailure('VERIFY_SOURCE_CHANGED');
    return buffer.subarray(0, bytes);
  } finally { await handle?.close(); }
}

/** The private credential is non-enumerable and exists only in the verifier process. */
export function selectReadonlyAccount(settings, vault, now = Date.now()) {
  if (settings?.schemaVersion !== 1 || settings.providerId !== 'codex' || settings.credentialMode !== 'chatgpt' || settings.baseURL !== ''
    || !uuid(settings.accountId) || !ascii(settings.modelId, 512)) throw verificationFailure('VERIFY_SELECTED_NATIVE_ACCOUNT_REQUIRED');
  if (vault?.schemaVersion !== 2 || vault.activeAccountId !== settings.accountId || !Array.isArray(vault.accounts) || vault.accounts.length > 16) throw verificationFailure('VERIFY_ACCOUNT_BINDING_REQUIRED');
  const matches = vault.accounts.filter(account => account?.id === settings.accountId);
  const account = matches.length === 1 ? matches[0] : undefined, tokens = account?.tokens;
  if (account?.authKind !== 'codex-oauth' || account.clientId !== 'app_EMoamEEZ73f0CkXaXp7hrann' || account.state !== 'connected'
    || !tokens || !ascii(tokens.accessToken, 16_384) || !ascii(tokens.idToken, 65_536)
    || (tokens.refreshToken !== undefined && !ascii(tokens.refreshToken, 16_384))
    || !ascii(tokens.chatgptAccountId, 256) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u.test(tokens.chatgptAccountId)) throw verificationFailure('VERIFY_FRESH_NATIVE_ACCOUNT_REQUIRED');
  if (!Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= now + ACCOUNT_DEADLINE_MS + 30_000) throw verificationFailure('VERIFY_TOKEN_REFRESH_REQUIRED');
  const secrets = Object.freeze([...new Set([tokens.accessToken, tokens.idToken, tokens.refreshToken, tokens.chatgptAccountId].filter(Boolean))]);
  if (secrets.some(secret => settings.modelId.includes(secret))) throw verificationFailure('VERIFY_MODEL_INVALID');
  const value = { modelId: settings.modelId, ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}) };
  Object.defineProperties(value, {
    credential: { value: Object.freeze({ accessToken: tokens.accessToken, accountId: tokens.chatgptAccountId, secrets }), enumerable: false },
    tokens: { value: Object.freeze({ ...tokens }), enumerable: false },
    expiresAt: { value: tokens.expiresAt, enumerable: false },
    publicAccountId: { value: settings.accountId, enumerable: false },
  });
  return Object.freeze(value);
}

export function createCountedAccountFetch(transport, requests) {
  return async (url, init) => {
    if (String(url) !== CODEX_ACCOUNT_ENDPOINT || init?.method !== 'POST' || init.redirect !== 'error') throw verificationFailure('VERIFY_NATIVE_DESTINATION_REQUIRED');
    if (requests.length >= MAX_ACCOUNT_POSTS) throw verificationFailure('VERIFY_REQUEST_LIMIT');
    const observation = { ordinal: requests.length + 1, responseObserved: false, status: null, failed: false };
    requests.push(observation); // Count dispatches before await, including failed requests.
    try {
      const response = await transport(url, init);
      observation.responseObserved = true; observation.status = response.status; observation.failed = !response.ok;
      return response;
    } catch { observation.failed = true; throw verificationFailure('VERIFY_NATIVE_TRANSPORT_FAILED'); }
  };
}

export function exactFixtureApproval(tool, currentContent) {
  const input = tool?.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (tool.name === 'apply_patch') {
    if (Object.keys(input).some(key => key !== 'changes') || !Array.isArray(input.changes) || input.changes.length !== 1) return false;
    const change = input.changes[0];
    return !!change && Object.keys(change).every(key => ['path', 'expectedHash', 'content'].includes(key)) && change.path === 'math.mjs'
      && change.expectedHash === sha256(FIXTURE_BEFORE) && change.content === FIXTURE_AFTER && currentContent === FIXTURE_BEFORE;
  }
  return tool.name === 'run_command' && Object.keys(input).every(key => ['command', 'cwd', 'timeoutMs'].includes(key))
    && input.command === FIXTURE_COMMAND && (input.cwd === undefined || input.cwd === '.')
    && (input.timeoutMs === undefined || Number.isSafeInteger(input.timeoutMs) && input.timeoutMs > 0 && input.timeoutMs <= 30_000)
    && currentContent === FIXTURE_AFTER;
}

/** Only the code of the Engine's tool-error envelope is reported; its message and command output stay in the Original. */
function toolErrorCode(tool) {
  try { const code = JSON.parse(tool.output ?? '')?.error?.code; return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : undefined; }
  catch { return undefined; }
}

const execute = promisify(execFile);
export async function verifyAccountCoding({ directory, account, engineModule, fetch, report, nodePath = 'node', timeoutMs = ACCOUNT_DEADLINE_MS }) {
  const { createEngine, CodexProvider } = engineModule;
  const repository = join(directory, 'repository'); await mkdir(repository, { mode: 0o700 });
  await execute('git', ['init', '-q', repository]);
  await writeFile(join(repository, 'math.mjs'), FIXTURE_BEFORE);
  await writeFile(join(directory, 'before-math.mjs'), FIXTURE_BEFORE);
  await writeFile(join(repository, 'math.test.mjs'), FIXTURE_TEST);
  const childEnvironment = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const baseline = await execute(nodePath, ['--test', '--test-reporter=tap', 'math.test.mjs'], { cwd: repository, timeout: 30_000, env: childEnvironment }).then(value => ({ ...value, code: 0 }), error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code }));
  await writeFile(join(directory, 'baseline-test.log'), baseline.stdout + baseline.stderr);
  report.baseline = { exitCode: baseline.code, additionFailureObserved: /not ok.*add/u.test(baseline.stdout), unchangedMultiplyPassed: /# pass 6/u.test(baseline.stdout) };
  assert.equal(baseline.code, 1); assert.equal(report.baseline.additionFailureObserved, true); assert.equal(report.baseline.unchangedMultiplyPassed, true);
  const httpRequests = report.httpRequests ??= [], attempts = report.providerAttempts ??= [];
  const native = new CodexProvider({ timeoutMs: 90_000, fetch: createCountedAccountFetch(fetch, httpRequests), credentialReader: {
    use: async (signal, callback) => {
      if (signal.aborted) throw verificationFailure('VERIFY_CANCELLED');
      if (Date.now() >= account.expiresAt) throw verificationFailure('VERIFY_TOKEN_REFRESH_REQUIRED');
      return callback(account.credential);
    },
  } });
  const provider = { id: native.id, replayProtocol: native.replayProtocol, inputModalities: native.inputModalities,
    async *streamTurn(request, signal) {
      const observed = { attemptId: request.attemptId, ordinal: attempts.length + 1, usage: null, cleanup: null };
      attempts.push(observed);
      for await (const event of native.streamTurn(request, signal)) {
        if (event.type === 'usage') observed.usage = { ...observed.usage, ...Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens'].filter(key => event[key] !== undefined).map(key => [key, event[key]])) };
        yield event;
      }
    },
  };
  let engine, events, receipt, sessionId, firstFailure;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  async function command(type, payload) {
    const response = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload });
    if (!response.ok) throw verificationFailure(safeVerificationCode(response.error));
    return response.result;
  }
  try {
    engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [provider], allowedToolNames: ['read_file', 'apply_patch', 'run_command'], defaults: { providerId: 'codex', modelId: account.modelId } });
    const workspace = await command('workspace.open', { path: repository });
    const session = await command('session.create', { workspaceId: workspace.id, title: 'Isolated app-account coding verification' });
    sessionId = session.id;
    const approvals = report.approvals ??= [];
    events = (async () => {
      for await (const event of engine.subscribe(session.id, 0, controller.signal)) {
        if (event.type !== 'approval.requested') continue;
        const snapshot = await command('session.getSnapshot', { sessionId: session.id });
        for (const approval of snapshot.approvals.filter(value => value.status === 'pending')) {
          const tool = snapshot.tools.find(value => value.id === approval.toolCallId);
          const allowed = exactFixtureApproval(tool, await readFile(join(repository, 'math.mjs'), 'utf8'));
          approvals.push({ tool: ['apply_patch', 'run_command'].includes(tool?.name) ? tool.name : 'unexpected', exactFingerprintDecision: true, allowed });
          await command('approval.decide', { approvalId: approval.id, fingerprint: approval.fingerprint, decision: allowed ? 'allow' : 'deny' });
          if (!allowed) { firstFailure ??= verificationFailure('VERIFY_UNEXPECTED_ACTION'); controller.abort(); }
        }
      }
    })().catch(error => { firstFailure ??= error; controller.abort(); });
    const input = { sessionId: session.id, requestId: 'app-account-coding-one', prompt: `Read math.mjs with read_file. Fix only math.mjs using apply_patch. Its complete replacement content must be exactly:\n${FIXTURE_AFTER}Use the sha256 from read_file as expectedHash. Then run exactly ${FIXTURE_COMMAND} with run_command at cwd ".". Do not modify math.test.mjs, create any files, run other commands, or change multiply. Report only the observed test result.`, config: { providerId: 'codex', modelId: account.modelId, mode: 'build', ...(account.reasoningEffort ? { reasoningEffort: account.reasoningEffort } : {}), limits: { maxTurns: MAX_ACCOUNT_POSTS, maxToolCalls: 6, maxDurationMs: timeoutMs, toolTimeoutMs: 30_000, maxOutputBytes: 32_768, maxContextBytes: 262_144 }, budgets: { maxProviderAttempts: 1, turnAllowance: MAX_ACCOUNT_POSTS, providerRequestTimeoutMs: 90_000, providerInactivityTimeoutMs: 90_000 } } };
    receipt = await command('run.submit', input);
    const cancel = () => { void command('run.cancel', { runId: receipt.runId }).catch(() => undefined); };
    controller.signal.addEventListener('abort', cancel, { once: true });
    if (controller.signal.aborted) cancel();
    let run;
    try { run = await engine.waitForRun(receipt.runId); await engine.waitForSession(session.id); }
    finally { controller.signal.removeEventListener('abort', cancel); }
    controller.abort(); await events;
    const snapshot = await command('session.getSnapshot', { sessionId: session.id });
    for (const attempt of attempts) {
      const proof = engine.getAttemptCleanup(session.id, attempt.attemptId);
      attempt.cleanup = proof ? { state: proof.state, cleanupConfirmed: proof.cleanupConfirmed, method: proof.method, reason: proof.reason } : null;
      delete attempt.attemptId;
    }
    const requestsBeforeDuplicate = httpRequests.length;
    const duplicate = await command('run.submit', input);
    assert.equal(duplicate.runId, receipt.runId);
    await engine.waitForSession(session.id);
    report.duplicateRequest = { sameRun: true, additionalHttpRequests: httpRequests.length - requestsBeforeDuplicate };
    const patch = await readFile(join(repository, 'math.mjs'), 'utf8'), test = await readFile(join(repository, 'math.test.mjs'), 'utf8');
    const testTool = snapshot.tools.find(tool => tool.name === 'run_command' && tool.state === 'completed');
    report.runState = run.state; report.errorCode = run.error?.code ?? null;
    report.tools = snapshot.tools.map(tool => { const errorCode = toolErrorCode(tool); return { name: tool.name, state: tool.state, ...(errorCode ? { errorCode } : {}) }; });
    report.patchVerified = patch === FIXTURE_AFTER; report.originalTestUnchanged = sha256(test) === sha256(FIXTURE_TEST);
    report.observedTest = { nativeExitZero: testTool?.output?.includes('exitCode=0') === true, nativeCleanupConfirmed: testTool?.output?.includes('cleanupConfirmed=true') === true,
      tenCasesPassed: /# pass 10/u.test(testTool?.output ?? ''), zeroFailures: /# fail 0/u.test(testTool?.output ?? '') };
    await writeFile(join(directory, 'observed-test.log'), testTool?.output ?? 'No completed test tool output.\n');
    report.diff = await execute('git', ['diff', '--no-index', '--', join(directory, 'before-math.mjs'), 'math.mjs'], { cwd: repository }).then(value => value.stdout, error => error.stdout ?? '');
    assert.equal(run.state, 'completed'); if (firstFailure) throw firstFailure;
    assert.equal(report.patchVerified, true); assert.equal(report.originalTestUnchanged, true);
    assert.deepEqual(report.observedTest, { nativeExitZero: true, nativeCleanupConfirmed: true, tenCasesPassed: true, zeroFailures: true });
    assert.equal(approvals.filter(value => value.allowed && value.tool === 'apply_patch').length, 1);
    assert.equal(approvals.filter(value => value.allowed && value.tool === 'run_command').length, 1);
    assert.equal(report.duplicateRequest.additionalHttpRequests, 0);
    report.selectedAppAccountVerified = true;
    return report;
  } catch (error) {
    firstFailure ??= error;
    throw firstFailure;
  } finally {
    clearTimeout(timer); controller.abort();
    try { await events; } catch { firstFailure ??= verificationFailure('VERIFY_EVENT_OBSERVATION_FAILED'); }
    if (engine) {
      for (const attempt of attempts) if (attempt.attemptId) {
        try {
          const proof = engine.getAttemptCleanup(sessionId, attempt.attemptId);
          attempt.cleanup = proof ? { state: proof.state, cleanupConfirmed: proof.cleanupConfirmed, method: proof.method, reason: proof.reason } : null;
        } catch { attempt.cleanup = null; }
        delete attempt.attemptId;
      }
      try { await engine.close(); report.engineClose = { completed: true, establishesNativeCleanup: false }; }
      catch { report.engineClose = { completed: false, establishesNativeCleanup: false }; throw firstFailure ?? verificationFailure('VERIFY_ENGINE_CLOSE_FAILED'); }
    }
    if (firstFailure) throw firstFailure;
  }
}
