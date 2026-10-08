import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { PROVIDER_MEDIA_SELECTION, providerMediaCoverageArgs, validateMediaCoverageReport, verifyProviderMediaCoverage, executeProviderMediaChild } from './verify-provider-coverage-media.mjs';

const original = JSON.parse(await readFile(new URL('../docs/moodcode/engine-phase-two-media-account-128px-video-verification.json', import.meta.url), 'utf8'));
const options = { modelId: PROVIDER_MEDIA_SELECTION.modelId, credentialEnv: 'OPENAI_API_KEY', maxRequests: 1, capabilityReference: 'official-model-page plus explicit bounded frame projection', allowUnknownMediaTokenCost: true };
const syntheticSelection = () => {
  const report = structuredClone(original);
  report.configuration.videoModelId = options.modelId;
  for (const value of [...report.actualRequests, ...report.observedAttempts]) value.modelId = options.modelId;
  for (const value of report.scopeCoverage) {
    if (value.selectedModelId) value.selectedModelId = options.modelId;
    if (value.modelId === 'gpt-4.1-mini') value.modelId = options.modelId;
  }
  return report;
};
const nativeCase = report => report.scopeCoverage.find(item => item.caseId === 'video-frame-recognition');
const code = expected => error => { assert.equal(error.code, expected); return true; };

test('finite selected model, host opt-in and one-request budget reject before starting a child', async () => {
  const argv = providerMediaCoverageArgs(options);
  assert.equal(argv.includes('gpt-4.1-2025-04-14'), true);
  assert.equal(argv.includes('128'), true);
  for (const changed of [{ modelId: 'gpt-4.1' }, { modelId: 'gpt-audio-mini' }, { maxRequests: 2 }, { maxRequests: 0 },
    { allowUnknownMediaTokenCost: false }, { credentialEnv: 'KEY\nPRIVATE' }, { capabilityReference: '' }, { reportPath: 'relative.json' }]) {
    let started = 0;
    await assert.rejects(verifyProviderMediaCoverage({ ...options, ...changed }, { execute() { started++; } }), code('PROVIDER_MEDIA_SELECTION_INVALID'));
    assert.equal(started, 0);
  }
});

test('historical actual report satisfies its own source/model qualification without claiming the additional model', () => {
  assert.equal(validateMediaCoverageReport(original, 'gpt-4.1-mini').nativeVerified, true);
  assert.throws(() => validateMediaCoverageReport(original), code('PROVIDER_MEDIA_EVIDENCE_INVALID'));
  assert.equal(original.configuration.videoModelId, 'gpt-4.1-mini');
});

const invalidProofs = [
  ['runtime drift', report => { report.runtimeFreeze.unchanged = false; }],
  ['source drift', report => { report.sourceFreeze.unchanged = false; }],
  ['model mismatch', report => { report.observedAttempts[0].modelId = 'another-model'; }],
  ['owner mismatch', report => { report.observedAttempts[0].ownerSha256 = 'f'.repeat(64); }],
  ['extra request', report => { report.actualRequests.push(structuredClone(report.actualRequests[0])); }],
  ['extra attempt', report => { nativeCase(report).native.attempts.push(structuredClone(nativeCase(report).native.attempts[0])); }],
  ['cleanup unknown', report => { report.cleanupProofs[0].confirmed = false; }],
  ['missing usage', report => { delete nativeCase(report).native.attempts[0].usage; }],
  ['recognition mismatch', report => { nativeCase(report).recognition.observedSha256 = 'd'.repeat(64); }],
  ['answer leakage', report => { nativeCase(report).recognition.expectedAbsentFromFullWire = false; }],
  ['wrong physical source', report => { nativeCase(report).inputProfile.sourceSha256 = 'f'.repeat(64); }],
  ['wrong source attachment', report => { nativeCase(report).inputProfile.nativeAttachmentSha256 = 'f'.repeat(64); }],
  ['wrong native Run source', report => { nativeCase(report).inputProfile.nativeRunMediaSha256 = 'f'.repeat(64); }],
  ['unverified PNG pixels', report => { report.actualRequests[0].videoProbe.wireFrames[0].allPixelsVerified = false; }],
  ['PNG integrity', report => { report.actualRequests[0].videoProbe.wireFrames[0].crcVerified = false; }],
  ['timestamp drift', report => { report.actualRequests[0].videoProbe.wireFrames[1].startMs = 999; }],
  ['unknown metadata cost fabricated', report => { report.configuration.tokenCost = 0; }],
  ['invalid source request', report => { report.scopeCoverage.find(item => item.caseId === 'source-loss').requests = 1; }],
  ['duplicate native drift', report => { report.scopeCoverage.find(item => item.caseId === 'duplicate-input').runId = 'another-run'; }],
  ['restart replay', report => { report.scopeCoverage.find(item => item.caseId === 'restart-paused-import').requests = 1; }],
];
for (const [name, mutate] of invalidProofs) test(`additional media evidence rejects ${name}`, () => {
  const report = syntheticSelection(); mutate(report);
  assert.throws(() => validateMediaCoverageReport(report), code('PROVIDER_MEDIA_EVIDENCE_INVALID'));
});

test('injected execution cannot gain account credit; credential is passed only through child environment', async () => {
  const report = syntheticSelection(), argvSeen = [], secret = 'synthetic-private-provider-key';
  const result = await verifyProviderMediaCoverage(options, { apiKey: secret, execute: async (argv, env) => {
    argvSeen.push(...argv); assert.equal(env.OPENAI_API_KEY, secret); return { report, exitCode: 0 };
  } });
  assert.equal(result.accountVerified, false);
  assert.equal(result.coverageQualification.fixture, true);
  assert.equal(result.coverageQualification.nativeVerified, true);
  assert.equal(result.coverageQualification.protocol, 'openai-responses');
  assert.equal(result.coverageQualification.tokenCost, null);
  assert.equal(result.scopeCoverage.some(item => item.accountVerified), false);
  assert.equal(JSON.stringify(argvSeen).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(report.accountVerified, true);
});

test('original failures remain failures and never receive native/account credit', async () => {
  const failure = { kind: 'media-account-verification', state: 'failed', passed: false, accountVerified: false, failure: 'PROVIDER_HTTP_403', credentialReads: 1,
    actualRequests: [{ ordinal: 1, status: 403, modelId: options.modelId }], cleanupConfirmed: true };
  const result = await verifyProviderMediaCoverage(options, { execute: async () => ({ report: failure, exitCode: 1 }) });
  assert.equal(result.state, 'failed'); assert.equal(result.failure, 'PROVIDER_HTTP_403'); assert.equal(result.accountVerified, false);
  assert.equal(result.coverageQualification.nativeVerified, undefined);
  assert.deepEqual(result.actualRequests, failure.actualRequests);
});

for (const joins of [true, false]) test(`process deadline returns uncertainty with unknown request count; joins=${joins}`, async () => {
  const signals = [], child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
  child.kill = signal => {
    signals.push(signal);
    if (joins && signal === 'SIGTERM') queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  const result = await executeProviderMediaChild([], {}, { deadlineMs: 5, termJoinMs: 5, killJoinMs: 5 }, () => child);
  assert.equal(result.report.state, 'uncertain'); assert.equal(result.report.failure, 'PROVIDER_MEDIA_PROCESS_DEADLINE');
  assert.equal(result.report.accountVerified, false); assert.equal(result.report.cleanupConfirmed, false);
  assert.equal(result.report.actualRequestCount, null); assert.equal(result.report.actualRequestCountKnown, false);
  assert.equal(result.report.subprocessCleanup.processJoined, joins);
  assert.deepEqual(signals, joins ? ['SIGTERM'] : ['SIGTERM', 'SIGKILL']);
  if (!joins) { assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true); }
});

test('forced exit retains captured requests and original failure without a false zero count', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true; child.unref = () => {};
  const resultPromise = executeProviderMediaChild([], {}, { deadlineMs: 50, termJoinMs: 5, killJoinMs: 5 }, () => child);
  child.stdout.write(JSON.stringify({ kind: 'media-account-verification', passed: false, failure: 'PROVIDER_HTTP_ERROR', actualRequests: [{ ordinal: 1, status: 401 }] }));
  child.emit('close', null, 'SIGTERM');
  const result = await resultPromise;
  assert.equal(result.report.failure, 'PROVIDER_MEDIA_PROCESS_UNCERTAIN');
  assert.equal(result.report.subprocessOriginalFailure, 'PROVIDER_HTTP_ERROR');
  assert.equal(result.report.actualRequests.length, 1);
  assert.equal(result.report.actualRequestCountKnown, false);
  assert.equal(result.report.actualRequestCount, null);
});

test('real child that ignores SIGTERM is killed and joined with native cleanup still unknown', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', "process.on('SIGTERM',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000)"],
    { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); });
  await once(child.stdout, 'data');
  const result = await executeProviderMediaChild([], {}, { deadlineMs: 20, termJoinMs: 20, killJoinMs: 100 }, () => child);
  assert.equal(result.report.subprocessCleanup.sigkillSent, true);
  assert.equal(result.report.subprocessCleanup.processJoined, true);
  assert.equal(result.report.cleanupConfirmed, false); assert.equal(result.report.actualRequestCount, null);
  assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
});

function decodeFrame(url) {
  const bytes = Buffer.from(url.split(',')[1], 'base64'), compressed = [];
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  for (let at = 8; at < bytes.length;) {
    const n = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
    if (type === 'IDAT') compressed.push(bytes.subarray(at + 8, at + 8 + n));
    if (type === 'IHDR') { assert.equal(bytes.readUInt32BE(at + 8), 128); assert.equal(bytes.readUInt32BE(at + 12), 128); }
    at += n + 12;
  }
  const pixels = inflateSync(Buffer.concat(compressed)), rgb = [...pixels.subarray(1, 4)];
  assert.equal(pixels.length, 128 * (128 * 3 + 1));
  for (let y = 0; y < 128; y++) {
    assert.equal(pixels[y * 385], 0);
    for (let x = 0; x < 128; x++) assert.deepEqual([...pixels.subarray(y * 385 + x * 3 + 1, y * 385 + x * 3 + 4)], rgb);
  }
  const color = { '255,0,0': 'red', '0,255,0': 'green', '0,0,255': 'blue', '255,255,0': 'yellow' }[rgb.join(',')];
  assert.ok(color); return color;
}
const sse = value => 'data: ' + JSON.stringify(value) + '\n\n';
function responseStream(text) {
  const item = { id: 'bounded-fixture-message', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] };
  return [
    { type: 'response.created', response: { id: 'bounded-fixture-response', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'bounded-fixture-response', status: 'completed', output: [item], usage: { input_tokens: 19, output_tokens: 3 } } },
  ].map(sse).join('');
}

test('direct child executor verifies real native records and physical frames against a local fixture with one request', async t => {
  const requests = [], errors = [];
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks = []; for await (const bytes of incoming) chunks.push(bytes);
      const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
      assert.equal(incoming.headers.authorization, undefined);
      assert.equal(incoming.url, '/v1/responses'); assert.equal(body.model, options.modelId);
      const content = body.input.flatMap(item => item.content ?? []), frames = content.filter(item => item.type === 'input_image');
      assert.equal(frames.length, 3);
      const colors = frames.map(item => decodeFrame(item.image_url));
      const plaintext = content.filter(item => item.type === 'input_text').map(item => item.text).join('\n');
      for (const color of colors) assert.equal(new RegExp('\\b' + color + '\\b', 'u').test(plaintext), false);
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' }); outgoing.end(responseStream(colors.join(' ')));
    })().catch(error => { errors.push(error); outgoing.destroy(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const result = await verifyProviderMediaCoverage(options, { fixtureEndpoint: `http://127.0.0.1:${server.address().port}/v1` });
  assert.deepEqual(errors, []);
  assert.equal(result.failure, undefined);
  assert.equal(result.passed, true); assert.equal(result.accountVerified, false);
  assert.equal(result.coverageQualification.fixture, true); assert.equal(result.coverageQualification.nativeVerified, true);
  assert.equal(result.actualRequests.length, 1); assert.equal(requests.length, 1);
  assert.equal(result.credentialReads, 0); assert.equal(result.cleanupConfirmed, true);
});
