import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { parseProviderCoverageArgs, readProviderCredential, verifyProviderCoverage, confirmProviderCoverageFreeze, closeRejectedProviderResponse, projectPublicProviderCoverage, qualifyProviderCoverageAccount } from './verify-provider-coverage.mjs';

test('plan does not import the engine, resolve a key, or contact a transport', async () => {
  const unexpected = () => { throw new Error('Unexpected side effect'); };
  const report = await verifyProviderCoverage(['--lane', 'pdf', '--model', 'explicit-model'], { readCredential: unexpected, fetch: unexpected,
    get engineModule() { unexpected(); } });
  assert.equal(report.state, 'plan-only'); assert.equal(report.credentialReads, 0);
  assert.deepEqual(report.actualRequests, []); assert.equal(report.accountVerified, false);
});

for (const args of [
  ['--lane', 'pdf', '--model', 'x', '--live'],
  ['--lane', 'pdf', '--model', 'x', '--max-requests', '2'],
  ['--lane', 'media', '--model', 'x', '--max-requests', '4'],
  ['--lane', 'anthropic', '--model', 'x', '--max-requests', '0'],
  ['--lane', 'pdf', '--model', 'x', '--model', 'y'],
  ['--lane', 'pdf', '--model', 'x', '--credential-env', 'a-b'],
  ['--lane', 'unknown', '--model', 'x'],
  ...['pdf', 'media'].map(lane => ['--lane', lane, '--model', 'x', '--workspace-id', 'wrkspc_Test123']),
  ...['', 'wrkspc_', 'workspace_Test123', 'wrkspc_a-b', 'wrkspc_a_b', 'wrkspc_é', 'wrkspc_a b', 'wrkspc_a\r\nb',
    'wrkspc_' + 'a'.repeat(129)].map(id => ['--lane', 'anthropic', '--model', 'x', '--workspace-id', id]),
  ['--lane', 'anthropic', '--model', 'x', '--workspace-id', 'wrkspc_One', '--workspace-id', 'wrkspc_Two'],
]) test(`invalid configuration fails before effects: ${JSON.stringify(args)}`, async () => {
  assert.throws(() => parseProviderCoverageArgs(args), { code: 'VERIFY_INVALID_ARGUMENT' });
  const cli = spawnSync(process.execPath, ['scripts/verify-provider-coverage.mjs', ...args], { encoding: 'utf8' });
  assert.equal(cli.status, 1); assert.match(cli.stderr, /VERIFY_INVALID_ARGUMENT/u);
});

test('host-specified workspace plan accepts bounded ASCII without resolving auth or claiming identity', async () => {
  const unexpected = () => { throw new Error('Unexpected side effect'); };
  for (const id of ['wrkspc_A', 'wrkspc_' + 'aZ09'.repeat(32)]) {
    const report = await verifyProviderCoverage(['--lane', 'anthropic', '--model', 'x', '--workspace-id', id],
      { readCredential: unexpected, fetch: unexpected, get engineModule() { unexpected(); } });
    assert.equal(report.authentication.workspace, 'host-specified');
    assert.equal(report.authentication.persistentAccountIdentity, null); assert.equal(report.accountIdentityClaimed, false);
    assert.equal(report.credentialReads, 0); assert.equal(report.accountVerified, false); assert.equal(report.state, 'plan-only');
    assert.equal(JSON.stringify(report).includes(id), false);
  }
  const report = await verifyProviderCoverage(['--lane', 'anthropic', '--model', 'x']);
  assert.deepEqual(report.authentication, { method: 'api-key', credentialOwner: 'host', rendererCredentialExposure: false, persistentAccountIdentity: null });
});

function anthropicFixtureResponse(body, workspaceId) {
  const blocks = body.messages.flatMap(message => message.content);
  const image = blocks.find(item => item.type === 'image'), toolResult = blocks.find(item => item.type === 'tool_result');
  let text;
  if (image) {
    const bytes = Buffer.from(image.source.data, 'base64'), chunks = [];
    for (let at = 8; at < bytes.length;) {
      const length = bytes.readUInt32BE(at);
      if (bytes.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(bytes.subarray(at + 8, at + 8 + length));
      at += length + 12;
    }
    const pixels = inflateSync(Buffer.concat(chunks));
    text = [0, 1, 2].map(tile => ({ '255,0,0': 'red', '0,255,0': 'green', '0,0,255': 'blue' })[
      [...pixels.subarray(tile * 128 * 3 + 1, tile * 128 * 3 + 4)].join(',')]).join(' ');
  } else if (toolResult) text = toolResult.content.match(/probe-[a-f0-9-]{36}/u)?.[0];
  const events = [{ type: 'message_start', message: { id: 'msg-fixture', type: 'message', role: 'assistant', model: body.model,
    content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } }];
  const block = (index, content, delta) => events.push({ type: 'content_block_start', index, content_block: content },
    { type: 'content_block_delta', index, delta }, { type: 'content_block_stop', index });
  if (text) block(0, { type: 'text', text: '' }, { type: 'text_delta', text });
  else {
    block(0, { type: 'thinking', thinking: '', signature: '' }, { type: 'signature_delta', signature: 'opaque-fixture-signature' });
    block(1, { type: 'tool_use', id: 'toolu-read', name: 'read_file', input: {} }, { type: 'input_json_delta', partial_json: '{"path":"challenge.txt"}' });
  }
  events.push({ type: 'message_delta', delta: { stop_reason: text ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 3 } }, { type: 'message_stop' });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream', ...(workspaceId ? { 'anthropic-workspace-id': workspaceId } : {}) },
  });
}

for (const mode of ['matched', 'missing', 'mismatch', 'absent'])
  test(`Anthropic ${mode} workspace preserves headers, three-request budget and local qualification`, { timeout: 30000 }, async () => {
    const workspaceId = 'wrkspc_Fixture123', credential = 'local-workspace-fixture-key', requests = [];
    const report = await verifyProviderCoverage(['--lane', 'anthropic', '--model', 'local-anthropic-fixture', '--live',
      '--max-requests', '3', '--credential-env', 'FIXTURE_KEY', '--capability-reference', 'local-protocol-fixture',
      ...(mode === 'absent' ? [] : ['--workspace-id', workspaceId])], {
      readCredential: () => credential,
      fetch(url, init) {
        const headers = new Headers(init.headers), body = JSON.parse(init.body);
        assert.equal(String(url), 'https://api.anthropic.com/v1/messages'); assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal); assert.equal(init.signal.aborted, false);
        assert.equal(headers.get('x-api-key'), credential); assert.equal(headers.get('anthropic-version'), '2023-06-01');
        assert.equal(headers.get('content-type'), 'application/json');
        assert.equal(headers.get('anthropic-workspace-id'), mode === 'absent' ? null : workspaceId);
        assert.equal(body.model, 'local-anthropic-fixture'); assert.equal(body.max_tokens, 2048); assert.equal(body.stream, true);
        requests.push(body); assert.ok(requests.length <= 3);
        return anthropicFixtureResponse(body, mode === 'matched' ? workspaceId : mode === 'missing' ? undefined : 'wrkspc_Other');
      },
    });
    assert.equal(report.passed, true, JSON.stringify(report)); assert.equal(report.cleanupConfirmed, true);
    assert.equal(report.sourceRuntimeUnchanged, true); assert.equal(report.transport, 'local-fixture'); assert.equal(report.accountVerified, false);
    assert.equal(report.maxRequests, 3); assert.equal(requests.length, 3); assert.equal(report.actualRequestCount, 3);
    assert.equal(report.actualRequestCountKnown, true); assert.equal(report.credentialReads, 1);
    assert.ok(report.actualRequests.every(request => request.status === 200 && (mode === 'absent'
      ? !Object.hasOwn(request, 'workspaceBindingConfirmed') : request.workspaceBindingConfirmed === (mode === 'matched'))));
    assert.equal(report.authentication.workspace, mode === 'absent' ? undefined : 'host-specified');
    assert.equal(report.authentication.persistentAccountIdentity, null); assert.equal(report.accountIdentityClaimed, false);
    assert.equal(JSON.stringify(report).includes(workspaceId), false); assert.equal(JSON.stringify(report).includes(credential), false);
    assert.equal(report.evidence.scopeCoverage.filter(scope => scope.caseId === 'duplicate-input' && scope.requests === 0).length, 2);
    assert.equal(report.publicCoverage.features.find(feature => feature.feature === 'image-input').accountVerified, false);
  });

test('workspace binding adds to all central account gates and never grants fixture account credit', () => {
  const options = parseProviderCoverageArgs(['--lane', 'anthropic', '--model', 'm', '--workspace-id', 'wrkspc_Test']);
  const report = { passed: true, cleanupConfirmed: true, sourceRuntimeUnchanged: true, actualRequestCountKnown: true,
    actualRequests: [1, 2, 3].map(() => ({ modelId: 'm', status: 200, workspaceBindingConfirmed: true })) };
  assert.equal(qualifyProviderCoverageAccount(report, options, true), true);
  assert.equal(qualifyProviderCoverageAccount(report, options, false), false);
  for (const binding of [undefined, false, 'true']) for (let index = 0; index < 3; index++) {
    const requests = report.actualRequests.map((request, at) => ({ ...request, ...(at === index ? { workspaceBindingConfirmed: binding } : {}) }));
    assert.equal(qualifyProviderCoverageAccount({ ...report, actualRequests: requests }, options, true), false);
  }
  for (const change of [{ passed: false }, { cleanupConfirmed: false }, { sourceRuntimeUnchanged: false }, { actualRequestCountKnown: false },
    { actualRequests: [] }, { actualRequests: [...report.actualRequests, report.actualRequests[0]] },
    { actualRequests: [{ modelId: 'other', status: 200, workspaceBindingConfirmed: true }] },
    { actualRequests: [{ modelId: 'm', status: 401, workspaceBindingConfirmed: true }] }])
    assert.equal(qualifyProviderCoverageAccount({ ...report, ...change }, options, true), false);
  const unscoped = parseProviderCoverageArgs(['--lane', 'anthropic', '--model', 'm']);
  assert.equal(qualifyProviderCoverageAccount({ ...report, actualRequests: [{ modelId: 'm', status: 200 }] }, unscoped, true), true);
  const media = parseProviderCoverageArgs(['--lane', 'media', '--model', 'm']);
  const single = { ...report, actualRequests: [{ modelId: 'm', status: 200 }] };
  assert.equal(qualifyProviderCoverageAccount(single, media, true), false);
  assert.equal(qualifyProviderCoverageAccount({ ...single, evidence: { accountVerified: true } }, media, true), true);
});

test('workspace option cannot expand the fixed Anthropic lane request budget', async () => {
  let requests = 0;
  const report = await verifyProviderCoverage(['--lane', 'anthropic', '--model', 'local-anthropic-fixture', '--live',
    '--max-requests', '2', '--credential-env', 'FIXTURE_KEY', '--capability-reference', 'local-protocol-fixture',
    '--workspace-id', 'wrkspc_Test'], { readCredential: () => 'local-workspace-fixture-key', fetch() { requests++; throw new Error('Unexpected fetch'); } });
  assert.equal(report.error.code, 'VERIFY_INVALID_ARGUMENT'); assert.equal(report.passed, false); assert.equal(report.accountVerified, false);
  assert.equal(requests, 0); assert.equal(report.actualRequestCount, 0);
});

test('workspace fetch retains rejected redirect response cleanup ownership', { timeout: 10000 }, async () => {
  let requests = 0, cancelled = 0;
  const report = await verifyProviderCoverage(['--lane', 'anthropic', '--model', 'local-anthropic-fixture', '--live',
    '--max-requests', '3', '--credential-env', 'FIXTURE_KEY', '--capability-reference', 'local-protocol-fixture',
    '--workspace-id', 'wrkspc_Test'], { readCredential: () => 'local-workspace-fixture-key', fetch(url, init) {
    requests++; assert.equal(init.redirect, 'error'); assert.equal(new Headers(init.headers).get('anthropic-workspace-id'), 'wrkspc_Test');
    const response = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'anthropic-workspace-id': 'wrkspc_Test' } });
    Object.defineProperty(response, 'redirected', { value: true }); return response;
  } });
  assert.equal(requests, 1); assert.equal(cancelled, 1); assert.equal(report.actualRequestCount, 1);
  assert.equal(report.passed, false); assert.equal(report.cleanupConfirmed, true); assert.equal(report.accountVerified, false);
  assert.equal(report.originalFailure.code, 'VERIFY_ENDPOINT_INVALID'); assert.equal(report.actualRequests[0].workspaceBindingConfirmed, true);
});

test('missing account is a qualified external condition, with no engine import or request', async () => {
  let reads = 0;
  const report = await verifyProviderCoverage(['--lane', 'anthropic', '--model', 'explicit-model', '--live', '--max-requests', '3',
    '--credential-env', 'MISSING_API_KEY', '--capability-reference', 'official-model-contract'], {
    readCredential() { reads++; return undefined; }, fetch() { throw new Error('Unexpected fetch'); },
    get engineModule() { throw new Error('Unexpected engine import'); },
  });
  assert.equal(reads, 1); assert.equal(report.state, 'external-condition');
  assert.equal(report.error.code, 'VERIFY_CREDENTIAL_UNAVAILABLE'); assert.equal(report.cleanupConfirmed, true);
  assert.equal(report.accountVerified, false); assert.deepEqual(report.actualRequests, []);
});

test('explicit credential file selects one literal name without evaluating shell syntax', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-provider-env-'));
  try {
    const file = join(directory, '.env');
    await writeFile(file, 'OTHER_KEY=ignored\nexport CHOSEN_KEY="literal-$(must-not-execute)-`no-shell`"\n');
    assert.equal(await readProviderCredential('CHOSEN_KEY', file), 'literal-$(must-not-execute)-`no-shell`');
    assert.equal(await readProviderCredential('MISSING_KEY', file), undefined);
    await writeFile(file, 'CHOSEN_KEY=one\nCHOSEN_KEY=two\n');
    await assert.rejects(readProviderCredential('CHOSEN_KEY', file), { code: 'VERIFY_CREDENTIAL_FILE_INVALID' });
    await writeFile(file, 'CHOSEN_KEY=' + 'x'.repeat(65536));
    await assert.rejects(readProviderCredential('CHOSEN_KEY', file), { code: 'VERIFY_CREDENTIAL_FILE_INVALID' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid key failure is sanitized and cannot grant real account credit through runtime hooks', async () => {
  const secret = 'unprintable-secret\ncredential';
  const report = await verifyProviderCoverage(['--lane', 'pdf', '--model', 'explicit-model', '--live', '--max-requests', '1',
    '--credential-env', 'KEY', '--capability-reference', 'official-model-contract'], { readCredential: () => secret });
  assert.equal(report.error.code, 'VERIFY_CREDENTIAL_INVALID'); assert.equal(report.accountVerified, false);
  assert.equal(report.transport, 'local-fixture'); assert.equal(JSON.stringify(report).includes(secret), false);
  assert.deepEqual(report.actualRequests, []);
});

test('missing source after dispatch retains original failure and request evidence', async () => {
  const report = { actualRequests: [{ ordinal: 1, status: 401 }], originalFailure: { code: 'PROVIDER_HTTP_ERROR' }, evidence: { native: 'original' } };
  const retained = JSON.stringify(report);
  await confirmProviderCoverageFreeze(report, { source: { sha256: 's' }, runtime: { sha256: 'r' } }, async () => { throw new Error('Removed source'); });
  assert.equal(report.sourceRuntimeUnchanged, false); assert.equal(report.freezeFailure.code, 'VERIFY_SOURCE_UNAVAILABLE');
  const { sourceRuntimeUnchanged, freezeFailure, ...original } = report;
  assert.equal(JSON.stringify(original), retained);
});

test('rejected response cancellation has a finite physical cleanup result', async () => {
  let cancelled = 0;
  const cooperative = new Response(new ReadableStream({ cancel() { cancelled++; } }));
  assert.equal(await closeRejectedProviderResponse(cooperative, 20), true); assert.equal(cancelled, 1);
  const stuck = new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }));
  assert.equal(await closeRejectedProviderResponse(stuck, 20), false); assert.equal(cancelled, 2);
});

test('public capability presentation cannot exceed central actual account qualification', async () => {
  const api = await import('../packages/engine/dist/index.js');
  const qualification = { accountReference: 'opaque-invocation', sourceSha256: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64) };
  const report = { lane: 'pdf', modelId: 'exact-pdf-model', evidence: { configuration: { providerId: 'verify-pdf-responses' } },
    observedAt: '2026-10-09T00:00:00.000Z', capabilityReference: 'official-contract', transport: 'real-remote', passed: true,
    cleanupConfirmed: true, accountVerified: false, qualification };
  const feature = projectPublicProviderCoverage(api, report).features.find(item => item.feature === 'pdf-input');
  assert.equal(feature.supported, true); assert.equal(feature.accountVerified, false);
  assert.equal(feature.evidence[0].state, 'unverified');
  const qualified = projectPublicProviderCoverage(api, { ...report, accountVerified: true }).features.find(item => item.feature === 'pdf-input');
  assert.equal(qualified.accountVerified, true);
  const local = projectPublicProviderCoverage(api, { ...report, transport: 'local-fixture' }).features.find(item => item.feature === 'pdf-input');
  assert.equal(local.accountVerified, false); assert.equal(local.evidence[0].state, 'local-fixture');
});

test('actual native PDF rejects an unjoinable host response and retains cleanup uncertainty', async () => {
  const report = await verifyProviderCoverage(['--lane', 'pdf', '--model', 'explicit-local-pdf', '--live', '--max-requests', '1',
    '--credential-env', 'FIXTURE_KEY', '--capability-reference', 'local-protocol-fixture'], {
    readCredential: () => 'local-only-credential',
    fetch() {
      const response = new Response(new ReadableStream({ cancel() { return new Promise(() => {}); } }));
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    },
  });
  assert.equal(report.transport, 'local-fixture'); assert.equal(report.state, 'uncertain');
  assert.equal(report.cleanupConfirmed, false); assert.equal(report.accountVerified, false);
  assert.equal(report.actualRequests.length, 1); assert.equal(report.transportFailure.code, 'CLEANUP_UNCERTAIN');
  assert.equal(report.evidence.originalNativeErrorCode ?? report.evidence.native?.errorCode, 'CLEANUP_UNCERTAIN');
  if (report.evidence.retainedEvidenceDirectory) await rm(report.evidence.retainedEvidenceDirectory, { recursive: true, force: true });
});
