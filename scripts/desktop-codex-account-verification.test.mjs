import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, lstat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseAccountVerificationArgs, selectReadonlyAccount, createCountedAccountFetch, exactFixtureApproval, verifyAccountCoding,
  CODEX_ACCOUNT_ENDPOINT, FIXTURE_BEFORE, FIXTURE_AFTER, FIXTURE_TEST, FIXTURE_COMMAND, MAX_ACCOUNT_POSTS, ACCOUNT_DEADLINE_MS, sha256, readVerificationFile } from './desktop-codex-account-verification.mjs';

function selected() {
  const id = randomUUID(), settings = { schemaVersion: 1, providerId: 'codex', credentialMode: 'chatgpt', baseURL: '', accountId: id, modelId: 'fixture-account-model' };
  const tokens = { accessToken: 'fixture-private-access', refreshToken: 'fixture-private-refresh', idToken: 'fixture-private-id', chatgptAccountId: 'fixture-private-native-id', expiresAt: Date.now() + 3_600_000 };
  const vault = { schemaVersion: 2, activeAccountId: id, accounts: [{ id, authKind: 'codex-oauth', clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', state: 'connected', tokens }] };
  return { settings, vault, tokens };
}
const code = expected => error => error.code === expected && !/fixture-private/u.test(error.message);

test('live parser requires explicit source and opt-in before any account read or transport', () => {
  assert.throws(() => parseAccountVerificationArgs([]), code('VERIFY_LIVE_OPT_IN_REQUIRED'));
  for (const args of [['--live'], ['--live', '--source-user-data', 'relative', '--report', 'result.json'], ['--live', '--live'], ['--live', '--api-key', 'fixture-private-access']]) assert.throws(() => parseAccountVerificationArgs(args), code('VERIFY_INVALID_ARGUMENT'));
  assert.throws(() => parseAccountVerificationArgs(['--live', '--source-user-data', resolve('fixture-data'), '--report', resolve('fixture-data/settings.json')]), code('VERIFY_REPORT_SOURCE_OVERLAP'));
  assert.equal(parseAccountVerificationArgs(['--live', '--source-user-data', resolve('fixture-data'), '--report', 'result.json']).sourceUserData, resolve('fixture-data'));
});

test('read-only native selection refuses API/local/legacy/mismatched/expired credentials without serializing private identity', () => {
  const f = selected(), account = selectReadonlyAccount(f.settings, f.vault);
  assert.deepEqual(JSON.parse(JSON.stringify(account)), { modelId: f.settings.modelId });
  assert.ok(Object.isFrozen(account.credential)); assert.ok(Object.isFrozen(account.credential.secrets));
  for (const settings of [{ ...f.settings, providerId: 'openai-responses' }, { ...f.settings, credentialMode: undefined }, { ...f.settings, baseURL: 'https://foreign.example' }]) assert.throws(() => selectReadonlyAccount(settings, f.vault), code('VERIFY_SELECTED_NATIVE_ACCOUNT_REQUIRED'));
  assert.throws(() => selectReadonlyAccount(f.settings, { ...f.vault, activeAccountId: randomUUID() }), code('VERIFY_ACCOUNT_BINDING_REQUIRED'));
  assert.throws(() => selectReadonlyAccount(f.settings, { ...f.vault, schemaVersion: 1 }), code('VERIFY_ACCOUNT_BINDING_REQUIRED'));
  for (const change of [{ authKind: 'legacy-siwc' }, { state: 'expired' }, { tokens: { ...f.tokens, chatgptAccountId: 'unsafe\r\nheader' } }]) assert.throws(() => selectReadonlyAccount(f.settings, { ...f.vault, accounts: [{ ...f.vault.accounts[0], ...change }] }), code('VERIFY_FRESH_NATIVE_ACCOUNT_REQUIRED'));
  assert.throws(() => selectReadonlyAccount(f.settings, { ...f.vault, accounts: [{ ...f.vault.accounts[0], tokens: { ...f.tokens, expiresAt: Date.now() + ACCOUNT_DEADLINE_MS } }] }), code('VERIFY_TOKEN_REFRESH_REQUIRED'));
});

test('native request cap counts failed HTTP dispatches and blocks foreign destinations before sending', async () => {
  let calls = 0; const requests = [], transport = createCountedAccountFetch(async () => { calls++; throw new Error('fixture-private-access'); }, requests);
  const init = { method: 'POST', redirect: 'error' };
  await assert.rejects(transport('https://foreign.example', init), code('VERIFY_NATIVE_DESTINATION_REQUIRED')); assert.equal(calls, 0);
  for (let i = 0; i < MAX_ACCOUNT_POSTS; i++) await assert.rejects(transport(CODEX_ACCOUNT_ENDPOINT, init), code('VERIFY_NATIVE_TRANSPORT_FAILED'));
  await assert.rejects(transport(CODEX_ACCOUNT_ENDPOINT, init), code('VERIFY_REQUEST_LIMIT'));
  assert.equal(calls, MAX_ACCOUNT_POSTS); assert.equal(requests.length, MAX_ACCOUNT_POSTS); assert.ok(requests.every(request => request.failed && !request.responseObserved));
});

test('exact approval denies traversal, test modification, environment injection, stale content and extra commands', () => {
  const patch = { name: 'apply_patch', input: { changes: [{ path: 'math.mjs', expectedHash: sha256(FIXTURE_BEFORE), content: FIXTURE_AFTER }] } };
  assert.equal(exactFixtureApproval(patch, FIXTURE_BEFORE), true);
  assert.equal(exactFixtureApproval(patch, FIXTURE_AFTER), false);
  for (const change of [{ path: '../math.mjs' }, { path: 'math.test.mjs' }, { expectedHash: '0'.repeat(64) }, { content: FIXTURE_AFTER + 'extra' }, { mode: 0o777 }]) assert.equal(exactFixtureApproval({ ...patch, input: { changes: [{ ...patch.input.changes[0], ...change }] } }, FIXTURE_BEFORE), false);
  const command = { name: 'run_command', input: { command: FIXTURE_COMMAND, cwd: '.' } };
  assert.equal(exactFixtureApproval(command, FIXTURE_AFTER), true);
  for (const change of [{ command: 'node --test math.test.mjs; echo unsafe' }, { cwd: '..' }, { env: { PRIVATE: 'value' } }, { timeoutMs: 60_000 }]) assert.equal(exactFixtureApproval({ ...command, input: { ...command.input, ...change } }, FIXTURE_AFTER), false);
});

test('bounded source reader preserves bytes and refuses symbolic links without touching targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moodcode-account-read-test-')), file = join(root, 'private.json'), link = join(root, 'link.json');
  await writeFile(file, '{"fixture":true}', { mode: 0o600 }); await symlink(file, link);
  assert.equal((await readVerificationFile(file)).toString(), '{"fixture":true}');
  await assert.rejects(readVerificationFile(link), code('VERIFY_SOURCE_UNSAFE')); assert.equal(await readFile(file, 'utf8'), '{"fixture":true}');
});

function nativeResponse(index) {
  const names = ['read_file', 'apply_patch', 'run_command'];
  const inputs = [{ path: 'math.mjs' }, { changes: [{ path: 'math.mjs', expectedHash: sha256(FIXTURE_BEFORE), content: FIXTURE_AFTER }] }, { command: FIXTURE_COMMAND, cwd: '.' }];
  const id = `response-fixture-${index}`, events = [{ type: 'response.created', response: { id, status: 'in_progress' } }];
  let output;
  if (index < 3) {
    const item = { id: `item-fixture-${index}`, type: 'function_call', status: 'completed', call_id: `call-fixture-${index}`, name: names[index], arguments: JSON.stringify(inputs[index]) };
    events.push({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } }, { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments }, { type: 'response.output_item.done', output_index: 0, item }); output = [item];
  } else {
    const text = 'Observed all ten tests pass.', item = { id: 'message-fixture', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] };
    events.push({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }, { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text }, { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text }, { type: 'response.output_item.done', output_index: 0, item }); output = [item];
  }
  events.push({ type: 'response.completed', response: { id, status: 'completed', output, usage: { input_tokens: 100, output_tokens: 20 } } });
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

test('local HTTP native Codex flow observes red/green, exact approvals, immutable tests, usage and zero duplicate replay while retaining Original', async t => {
  let calls = 0; const server = createServer((request, response) => {
    assert.equal(request.method, 'POST'); assert.equal(request.headers.authorization, 'Bearer fixture-private-access'); assert.equal(request.headers['chatgpt-account-id'], 'fixture-private-native-id');
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      const parsed = JSON.parse(body); assert.equal(parsed.model, 'fixture-account-model'); assert.equal(parsed.store, false);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(nativeResponse(calls++));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-account-coding-local-')), f = selected(), account = selectReadonlyAccount(f.settings, f.vault), report = {};
  const address = `http://127.0.0.1:${server.address().port}`;
  // Child tools need the same non-test environment as the opt-in verifier.
  // NODE_TEST_CONTEXT would make a native `node --test` silently skip its file.
  // A failed verifier still prints its secret-free report, and exits normally so stdout is flushed.
  const helper = new URL('./desktop-codex-account-verification.mjs', import.meta.url).href;
  const program = `import {selectReadonlyAccount,verifyAccountCoding} from ${JSON.stringify(helper)};const account=selectReadonlyAccount(${JSON.stringify(f.settings)},${JSON.stringify(f.vault)});const report={};try{await verifyAccountCoding({directory:${JSON.stringify(directory)},account,engineModule:await import('@moodcode/engine'),fetch:(_url,init)=>fetch(${JSON.stringify(address)},init),report,timeoutMs:30000});}catch(error){process.exitCode=1;console.error(error);}finally{console.log(JSON.stringify(report));}`;
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const output = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', program], { env, timeout: 45_000, maxBuffer: 131_072 });
  Object.assign(report, JSON.parse(output.stdout.trim()));
  assert.equal(calls, 4); assert.equal(report.httpRequests.length, 4); assert.equal(report.selectedAppAccountVerified, true);
  assert.equal(report.duplicateRequest.additionalHttpRequests, 0); assert.equal(report.providerAttempts.length, 4); assert.ok(report.providerAttempts.every(attempt => attempt.cleanup.cleanupConfirmed && attempt.usage.inputTokens === 100));
  assert.equal(await readFile(join(directory, 'repository/math.test.mjs'), 'utf8'), FIXTURE_TEST);
  assert.ok((await lstat(join(directory, 'engine.sqlite'))).isFile()); assert.equal(report.engineClose.completed, true);
  assert.doesNotMatch(JSON.stringify(report), /fixture-private/u);
});
