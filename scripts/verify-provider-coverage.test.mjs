import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseProviderCoverageArgs, readProviderCredential, verifyProviderCoverage, confirmProviderCoverageFreeze, closeRejectedProviderResponse, projectPublicProviderCoverage } from './verify-provider-coverage.mjs';

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
]) test(`invalid configuration fails before effects: ${JSON.stringify(args)}`, async () => {
  assert.throws(() => parseProviderCoverageArgs(args), { code: 'VERIFY_INVALID_ARGUMENT' });
  const cli = spawnSync(process.execPath, ['scripts/verify-provider-coverage.mjs', ...args], { encoding: 'utf8' });
  assert.equal(cli.status, 1); assert.match(cli.stderr, /VERIFY_INVALID_ARGUMENT/u);
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
