import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { EngineError } from '@moodcode/contracts';
import test from 'node:test';
import { inspectOnePagePdf, onePagePdf, parseProviderPdfArgs, runProviderPdfCoverage, verifyProviderPdf } from './verify-provider-coverage-pdf.mjs';

const engineModuleURL = process.env.MOODCODE_PROVIDER_PDF_TEST_ENGINE === 'compiled' ? import.meta.resolve('@moodcode/engine') : new URL('../packages/engine/src/index.ts', import.meta.url).href;
const args = ['--model', 'explicit-pdf-fixture', '--declare-pdf', '--allow-unknown-document-token-cost', '--account-reference', 'fixture-account', '--capability-reference', 'authored-loopback-pdf-v1', '--max-requests', '1'];
const token = 'MOODCODEPDF_8A3BCDEF01234567';
const event = data => 'data: ' + JSON.stringify(data) + '\n\n';
function response(text, usage = { input_tokens: 13, output_tokens: 5 }) {
  const part = { type: 'output_text', text, annotations: [] }, item = { id: 'fixture-pdf-answer', type: 'message', role: 'assistant', status: 'completed', content: [part] };
  return [
    { type: 'response.created', response: { id: 'fixture-pdf-response', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
    { type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: text },
    { type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text },
    { type: 'response.content_part.done', output_index: 0, item_id: item.id, content_index: 0, part },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'fixture-pdf-response', status: 'completed', output: [item], ...(usage ? { usage } : {}) } },
  ].map(event).join('');
}
async function fixture(t, mode = 'normal') {
  const requests = [], errors = [];
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) { size += chunk.length; assert.ok(size <= 2097152); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
      assert.equal(incoming.url, '/v1/responses'); assert.equal(incoming.method, 'POST'); assert.equal(body.model, 'explicit-pdf-fixture');
      const blocks = body.input.flatMap(item => Array.isArray(item.content) ? item.content : []), files = blocks.filter(block => block.type === 'input_file');
      assert.equal(files.length, 1); assert.deepEqual(Object.keys(files[0]).sort(), ['file_data', 'filename', 'type']);
      assert.match(files[0].filename, /^doc_[a-f0-9]{32}\.pdf$/u); assert.ok(files[0].file_data.startsWith('data:application/pdf;base64,'));
      const bytes = Buffer.from(files[0].file_data.slice('data:application/pdf;base64,'.length), 'base64'), observed = inspectOnePagePdf(bytes);
      assert.equal(observed.pages, 1); assert.ok(observed.bytes < 4096);
      assert.equal(blocks.filter(block => block.type === 'input_text').some(block => block.text.includes(observed.token)), false);
      const plaintext = JSON.stringify({ ...body, input: body.input.map(item => ({ ...item, ...(Array.isArray(item.content) ? { content: item.content.filter(block => block.type !== 'input_file') } : {}) })) });
      assert.equal(plaintext.includes('MOODCODEPDF_'), false); assert.equal(plaintext.includes(observed.token.slice('MOODCODEPDF_'.length)), false);
      assert.match(plaintext, /Transcribe the entire only printed line/u); assert.match(plaintext, /including every letter, underscore and digit/u);
      assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.tools, undefined);
      if (mode === 'http-error') { outgoing.writeHead(503); outgoing.end('sk-private-fixture-secret private remote failure body'); return; }
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
      const answer = mode === 'wrong-token' ? 'MOODCODEPDF_0000000000000000' : mode === 'suffix-only' ? observed.token.slice('MOODCODEPDF_'.length) : mode === 'long-unicode' ? '🌊'.repeat(40) : mode === 'prefix' ? 'The token is ' + observed.token : mode === 'punctuation' ? observed.token + '.' : mode === 'unicode-space' ? '\u00a0' + observed.token : mode === 'outer-space' ? '\n ' + observed.token + ' \n' : observed.token;
      outgoing.end(response(answer, mode === 'missing-usage' ? null : undefined));
    })().catch(error => { errors.push(error); outgoing.destroy(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); });
  return { endpoint: 'http://127.0.0.1:' + server.address().port + '/v1', requests };
}

test('finite PDF CLI opt-in rejects invalid inputs before credentials or dispatch', () => {
  for (const tail of [[], ['--model', 'm'], ['--declare-pdf', '--model', 'm'], ['--max-requests', '2'], ['--api-key-env', 'lower-case'], ['--account-reference', 'raw@example.com'], ['--fixture-endpoint', 'http://localhost/v1'], ['--fixture-endpoint', 'https://127.0.0.1/v1'], ['--model', 'm', '--model', 'm'], ['--unknown']]) {
    assert.throws(() => parseProviderPdfArgs(['--live', ...tail]), error => /^VERIFY_/u.test(error.code));
  }
  assert.equal(parseProviderPdfArgs([]).execute, false);
  assert.equal(parseProviderPdfArgs([...args, '--live', '--api-key-env', 'FIXTURE_API_KEY']).maxRequests, 1);
  assert.throws(() => parseProviderPdfArgs([...args, '--live', '--api-key-env', 'FIXTURE_API_KEY', '--fixture-endpoint', 'http://127.0.0.1/v1']), error => error.code === 'VERIFY_INVALID_ARGUMENT');
});

test('authored PDF audit independently checks page count, object/xref binding, length, and exact token', () => {
  const bytes = onePagePdf(token), audit = inspectOnePagePdf(bytes);
  assert.equal(audit.token, token); assert.equal(audit.pages, 1); assert.equal(audit.objects, 5); assert.equal(audit.bytes, bytes.length); assert.equal(audit.compressed, false);
  assert.deepEqual(audit.layout, { font: 'Courier', fontSizePt: 24, lineCharacters: 28, lineWidthPt: 403.2, startXPt: 72, baselineYPt: 700, pageWidthPt: 612, pageHeightPt: 792, fitsPage: true });
  assert.equal(audit.layout.startXPt + audit.layout.lineWidthPt, 475.2); assert.ok(475.2 < 540);
  for (const change of [text => text.replace('/Count 1', '/Count 2'), text => text.replace('/Contents 5 0 R', '/Contents 4 0 R'), text => text.replace('00000 n', '00001 n'), text => text.replace('/Length ', '/Length 9'), text => text.replace('startxref\n', 'startxref\n1'), text => text.replace(token, token + 'X'), text => text.replace('/Courier', '/Helvetica'), text => text.replace('%%EOF', '%%EOF /JS')]) {
    assert.throws(() => inspectOnePagePdf(Buffer.from(change(bytes.toString()), 'ascii')), error => error.code === 'VERIFY_PDF_FIXTURE_INVALID');
  }
  assert.throws(() => onePagePdf('unsafe ) Tj ('), error => error.code === 'VERIFY_PDF_FIXTURE_INVALID');
  assert.throws(() => inspectOnePagePdf(Buffer.alloc(4097)), error => error.code === 'VERIFY_PDF_FIXTURE_INVALID');
});

test('plan-only lane reads no credentials or HTTP and makes no account claim', async () => {
  const report = await verifyProviderPdf([], { readCredential() { throw new Error('No credential read'); }, fetch() { throw new Error('No fetch'); } });
  assert.equal(report.state, 'plan-only'); assert.equal(report.transport, 'none'); assert.equal(report.credentialReads, 0); assert.deepEqual(report.actualRequests, []); assert.equal(report.accountVerified, false);
});

test('actual Engine Input/Run/Part/Attempt audit recognizes native PDF bytes with duplicate/restart/archive request count zero', async t => {
  const host = await fixture(t), report = await verifyProviderPdf([...args, '--fixture-endpoint', host.endpoint], { engineModuleURL });
  assert.equal(report.state, 'passed', JSON.stringify({ failure: report.failure, caseId: report.failureCaseId, cleanup: report.cleanupFailure }));
  assert.equal(report.passed, true); assert.equal(report.transport, 'local-fixture'); assert.equal(report.accountVerified, false); assert.equal(report.cleanupConfirmed, true);
  assert.equal(report.credentialReads, 0); assert.equal(host.requests.length, 1); assert.equal(report.actualRequests.length, 1); assert.equal(report.native.attempts.length, 1);
  assert.equal(report.native.attempts[0].state, 'completed'); assert.equal(report.native.attempts[0].cleanup.confirmed, true); assert.deepEqual(report.native.attempts[0].usage, { inputTokens: 13, outputTokens: 5 });
  assert.equal(report.native.parts.length, 1); assert.equal(report.native.parts[0].type, 'text'); assert.equal(report.native.parts[0].state, 'completed'); assert.equal(report.recognition.matched, true);
  assert.deepEqual(report.scopeCoverage.map(item => [item.caseId, item.requests]), [['pdf-source-owner', 0], ['pdf-exact-recognition', 1], ['pdf-duplicate-input', 0], ['pdf-restart-no-replay', 0], ['pdf-archive-no-replay', 0]]);
  const data = host.requests[0].input.flatMap(item => item.content ?? []).find(block => block.type === 'input_file').file_data;
  const sourceToken = inspectOnePagePdf(Buffer.from(data.split(',')[1], 'base64')).token;
  assert.equal(report.recognition.diagnostic.expectedToken, sourceToken); assert.equal(report.recognition.diagnostic.observedText, sourceToken); assert.equal(report.recognition.diagnostic.observedTextBytes, 28);
  assert.equal(report.recognition.diagnostic.truncated, false); assert.equal(JSON.stringify(report).includes(data), false); assert.equal(report.sourceFreeze.unchanged, true); assert.equal(report.runtimeFreeze.unchanged, true);
  assert.equal(report.supportBoundary.genericPdfPageValidation, false); assert.equal(report.supportBoundary.tokenCost, null); assert.equal(report.probe.pages, 1);
});

for (const mode of ['wrong-token', 'suffix-only', 'long-unicode', 'prefix', 'punctuation', 'unicode-space', 'missing-usage', 'http-error']) test(`actual native PDF lane preserves ${mode} failure and never grants account credit`, async t => {
  const host = await fixture(t, mode), report = await verifyProviderPdf([...args, '--fixture-endpoint', host.endpoint], { engineModuleURL });
  assert.equal(report.state, 'failed', JSON.stringify({ failure: report.failure, caseId: report.failureCaseId })); assert.equal(report.passed, false); assert.equal(report.accountVerified, false);
  assert.equal(host.requests.length, 1); assert.equal(report.actualRequests.length, 1); assert.equal(report.cleanupConfirmed, true); assert.equal(report.cleanupProofs[0].confirmed, true);
  assert.equal(report.failureCaseId, 'pdf-exact-recognition'); assert.equal(report.native.attempts.length, 1);
  if (mode === 'http-error') { assert.equal(report.actualRequests[0].status, 503); assert.equal(report.native.state, 'failed'); assert.match(report.failure, /^PROVIDER_HTTP/u); }
  else { assert.equal(report.native.state, 'completed'); assert.equal(report.failure, mode === 'missing-usage' ? 'VERIFY_USAGE_UNAVAILABLE' : 'VERIFY_PDF_RECOGNITION_MISMATCH'); }
  assert.equal(report.engineCloseConfirmed, true);
  if (report.failure === 'VERIFY_PDF_RECOGNITION_MISMATCH') {
    assert.equal(report.retainedEvidenceReason, 'semantic-mismatch-after-confirmed-engine-close'); assert.ok(report.retainedEvidenceDirectory);
    assert.equal(report.native.errorCode, null);
    t.after(() => rm(report.retainedEvidenceDirectory, { recursive: true, force: true }));
    await access(join(report.retainedEvidenceDirectory, 'engine.sqlite'));
    const retainedPdf = inspectOnePagePdf(await readFile(join(report.retainedEvidenceDirectory, 'artifacts', 'input-documents', report.probe.nativeDocument.id + '.blob')));
    assert.equal(retainedPdf.sha256, report.probe.sha256); assert.equal(retainedPdf.token, report.recognition.diagnostic.expectedToken);
    const database = new DatabaseSync(join(report.retainedEvidenceDirectory, 'engine.sqlite'), { readOnly: true });
    try {
      const part = JSON.parse(database.prepare('SELECT data FROM message_parts WHERE id=?').get(report.native.parts[0].id).data);
      assert.equal(part.text, mode === 'long-unicode' ? '🌊'.repeat(40) : report.recognition.diagnostic.observedText);
      assert.equal(part.state, 'completed'); assert.equal(part.runId, report.native.runId);
    } finally { database.close(); }
    assert.match(report.recognition.diagnostic.expectedToken, /^MOODCODEPDF_[A-F0-9]{16}$/u);
    assert.ok(Buffer.byteLength(report.recognition.diagnostic.observedText) <= 128);
    if (mode === 'suffix-only') { assert.equal(report.recognition.diagnostic.observedText, report.recognition.diagnostic.expectedToken.slice('MOODCODEPDF_'.length)); assert.equal(report.recognition.diagnostic.observedTextBytes, 16); assert.equal(report.recognition.matched, false); }
    if (mode === 'long-unicode') { assert.equal(report.recognition.diagnostic.observedText, '🌊'.repeat(32)); assert.equal(report.recognition.diagnostic.observedTextBytes, 160); assert.equal(report.recognition.diagnostic.truncated, true); }
  } else assert.equal(report.retainedEvidenceDirectory, undefined);
  assert.equal(JSON.stringify(report).includes('sk-private-fixture-secret'), false); assert.equal(JSON.stringify(report).includes('private remote failure body'), false);
});

test('exact semantic token permits only outer ASCII whitespace', async t => {
  const host = await fixture(t, 'outer-space'), report = await verifyProviderPdf([...args, '--fixture-endpoint', host.endpoint], { engineModuleURL });
  assert.equal(report.state, 'passed', report.failure); assert.equal(report.recognition.matched, true); assert.equal(report.recognition.normalization, 'outer ASCII whitespace only');
});

test('missing live credential is an external failure with no runtime/imported Input or request', async () => {
  let reads = 0;
  const report = await verifyProviderPdf([...args, '--live', '--api-key-env', 'FIXTURE_API_KEY'], { readCredential() { reads++; return undefined; }, fetch() { throw new Error('No HTTP'); } });
  assert.equal(report.state, 'failed'); assert.equal(report.failure, 'VERIFY_CREDENTIAL_UNAVAILABLE'); assert.equal(report.credentialReads, 1); assert.equal(reads, 1); assert.deepEqual(report.actualRequests, []); assert.equal(report.native, undefined); assert.equal(report.runtimeFreeze, undefined);
});

test('host injected central executor can supply native evidence without forging subordinate account qualification', async () => {
  const api = await import(engineModuleURL);
  const report = await runProviderPdfCoverage({ api, modelId: 'explicit-pdf-fixture', apiKey: 'sk-host-injected-fixture-secret', accountReference: 'central-account', capabilityReference: 'injected contract fixture', qualification: { transport: 'real-remote', sourceSha256: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64) },
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://api.openai.com/v1/responses'); assert.equal(init.headers.Authorization, 'Bearer sk-host-injected-fixture-secret');
      const body = JSON.parse(init.body), file = body.input.flatMap(item => item.content ?? []).find(block => block.type === 'input_file');
      const observed = inspectOnePagePdf(Buffer.from(file.file_data.split(',')[1], 'base64'));
      return new Response(response(observed.token), { headers: { 'content-type': 'text/event-stream' } });
    } });
  assert.equal(report.state, 'passed', report.failure); assert.equal(report.transport, 'local-fixture'); assert.equal(report.accountVerified, false); assert.equal(report.hostQualification.transport, 'real-remote');
  assert.equal(report.hostQualification.sourceSha256, 'a'.repeat(64)); assert.equal(report.hostQualification.runtimeSha256, 'b'.repeat(64)); assert.equal(report.recognition.matched, true);
  assert.equal(JSON.stringify(report).includes('sk-host-injected-fixture-secret'), false); assert.equal(JSON.stringify(report).includes('central-account'), false);
});

test('synthetic probe diagnostics retain the actual failed native record without exposing an echoed credential', async t => {
  const api = await import(engineModuleURL), apiKey = 'sk-diagnostic-echo-fixture-secret';
  const report = await runProviderPdfCoverage({ api, modelId: 'explicit-pdf-fixture', apiKey, accountReference: 'central-account', capabilityReference: 'injected contract fixture',
    fetch: async () => new Response(response(apiKey), { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(report.state, 'failed'); assert.equal(report.failure, 'VERIFY_PDF_RECOGNITION_MISMATCH'); assert.equal(report.native.errorCode, null);
  assert.equal(report.native.state, 'completed'); assert.equal(report.cleanupConfirmed, true); assert.equal(report.engineCloseConfirmed, true);
  assert.equal(report.recognition.matched, false); assert.equal(report.recognition.diagnostic.observedText, '[REDACTED]'); assert.equal(report.recognition.diagnostic.truncated, false);
  assert.equal(report.actualRequests.length, 1); assert.equal(report.accountVerified, false); assert.equal(JSON.stringify(report).includes(apiKey), false);
  assert.equal(report.retainedEvidenceReason, 'semantic-mismatch-after-confirmed-engine-close'); assert.ok(report.retainedEvidenceDirectory);
  t.after(() => rm(report.retainedEvidenceDirectory, { recursive: true, force: true }));
  const database = new DatabaseSync(join(report.retainedEvidenceDirectory, 'engine.sqlite'), { readOnly: true });
  try {
    const part = JSON.parse(database.prepare('SELECT data FROM message_parts WHERE id=?').get(report.native.parts[0].id).data);
    assert.equal(part.text, '[REDACTED]'); assert.equal(JSON.stringify(part).includes(apiKey), false);
  } finally { database.close(); }
});

test('runtime content drift invalidates native success and retains cleanup evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-pdf-runtime-test-')), path = join(directory, 'entry.mjs');
  await writeFile(path, 'export * from ' + JSON.stringify(engineModuleURL) + ';\n');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await verifyProviderPdf([...args, '--fixture-endpoint', 'http://127.0.0.1:1/v1'], { engineModuleURL: pathToFileURL(path).href,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body), file = body.input.flatMap(item => item.content ?? []).find(block => block.type === 'input_file');
      const observed = inspectOnePagePdf(Buffer.from(file.file_data.split(',')[1], 'base64'));
      await writeFile(path, 'export * from ' + JSON.stringify(engineModuleURL) + ';\n// source drift\n');
      return new Response(response(observed.token), { headers: { 'content-type': 'text/event-stream' } });
    } });
  assert.equal(report.recognition.matched, true); assert.equal(report.native.state, 'completed'); assert.equal(report.cleanupProofs[0].confirmed, true);
  assert.equal(report.runtimeFreeze.unchanged, false); assert.equal(report.state, 'uncertain'); assert.equal(report.failure, 'VERIFY_SOURCE_CHANGED'); assert.equal(report.passed, false); assert.equal(report.accountVerified, false);
  assert.equal(report.cleanupConfirmed, false); assert.ok(report.retainedEvidenceDirectory);
  await rm(report.retainedEvidenceDirectory, { recursive: true, force: true });
});

for (const cooperative of [true, false]) test(`rejected redirected Response keeps actual body cancellation ${cooperative ? 'confirmed' : 'uncertain'}`, async () => {
  let canceled = 0;
  const report = await verifyProviderPdf([...args, '--fixture-endpoint', 'http://127.0.0.1:1/v1'], { engineModuleURL,
    fetch: async () => {
      const response = new Response(new ReadableStream({ cancel() { canceled++; if (!cooperative) return new Promise(() => {}); } }), { headers: { 'content-type': 'text/event-stream' } });
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    } });
  assert.equal(canceled, 1); assert.equal(report.passed, false); assert.equal(report.accountVerified, false); assert.equal(report.actualRequests.length, 1);
  assert.equal(report.actualRequests[0].errorCode, 'VERIFY_ENDPOINT_INVALID'); assert.equal(report.actualRequests[0].rejectedBodyCleanupConfirmed, cooperative);
  assert.equal(report.native.errorCode, cooperative ? 'VERIFY_ENDPOINT_INVALID' : 'CLEANUP_UNCERTAIN');
  assert.equal(report.native.state, 'failed'); assert.equal(report.cleanupConfirmed, cooperative); assert.equal(report.state, cooperative ? 'failed' : 'uncertain');
  if (!cooperative) { assert.equal(report.cleanupFailure, 'VERIFY_TRANSPORT_CLEANUP_UNCERTAIN'); assert.ok(report.retainedEvidenceDirectory); await rm(report.retainedEvidenceDirectory, { recursive: true, force: true }); }
});

test('central capture cleanup uncertainty survives provider sanitization in original native error', async () => {
  const report = await verifyProviderPdf([...args, '--fixture-endpoint', 'http://127.0.0.1:1/v1'], { engineModuleURL,
    fetch: async () => { throw new EngineError('CLEANUP_UNCERTAIN', 'private host capture detail'); } });
  assert.equal(report.passed, false); assert.equal(report.state, 'uncertain'); assert.equal(report.native.errorCode, 'CLEANUP_UNCERTAIN');
  assert.equal(report.actualRequests[0].errorCode, 'CLEANUP_UNCERTAIN'); assert.equal(report.actualRequests.length, 1); assert.equal(report.cleanupConfirmed, false); assert.equal(report.accountVerified, false);
  assert.ok(report.retainedEvidenceDirectory); assert.equal(JSON.stringify(report).includes('private host capture detail'), false);
  await rm(report.retainedEvidenceDirectory, { recursive: true, force: true });
});

test('CLI rejects malformed live lane without echoing raw credential arguments', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-provider-coverage-pdf.mjs', '--live', '--model', 'sk-private-cli-secret'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout.includes('sk-private-cli-secret'), false); assert.equal(JSON.parse(result.stdout).state, 'rejected');
});
