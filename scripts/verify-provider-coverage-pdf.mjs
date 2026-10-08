import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EngineError } from '@moodcode/contracts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const direct = Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
const hooked = Boolean(process.env.NODE_OPTIONS) || process.execArgv.some(arg => /^--(?:import|require|loader|experimental-loader|eval)(?:=|$)|^-[re]/u.test(arg));
const official = 'https://api.openai.com/v1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
function fail(code) { throw Object.assign(new Error('PDF verification did not satisfy its bounded native evidence contract'), { code }); }
function boundedText(value, limit) {
  let text = '', bytes = 0;
  for (const point of value) {
    const next = Buffer.byteLength(point);
    if (bytes + next > limit) break;
    text += point; bytes += next;
  }
  return text;
}
async function cancelRejectedBody(response) {
  if (!response.body) return true;
  if (response.body.locked) return false;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => response.body.cancel()).then(() => true, () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); }),
    ]);
  } finally { clearTimeout(timer); }
}
const errorCode = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code) ? error.code : 'VERIFY_PDF_FAILED';
const values = new Set(['model', 'api-key-env', 'account-reference', 'capability-reference', 'max-requests', 'fixture-endpoint', 'report']);
const flags = new Set(['live', 'declare-pdf', 'allow-unknown-document-token-cost']);

/** Validate the finite lane before reading credentials, importing an engine, or dispatching HTTP. */
export function parseProviderPdfArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]?.slice(2);
    if (!argv[i]?.startsWith('--') || Object.hasOwn(options, key) || (!values.has(key) && !flags.has(key))) fail('VERIFY_INVALID_ARGUMENT');
    if (flags.has(key)) options[key] = true;
    else {
      const value = argv[++i];
      if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 2048 || /[\u0000-\u001f\u007f]/u.test(value) || value.startsWith('--')) fail('VERIFY_INVALID_ARGUMENT');
      options[key] = value;
    }
  }
  if (options.live && options['fixture-endpoint']) fail('VERIFY_INVALID_ARGUMENT');
  if (options.model && (Buffer.byteLength(options.model) > 256 || /^codex(?::|$)/iu.test(options.model))) fail('VERIFY_INVALID_ARGUMENT');
  if (options['api-key-env'] && !/^[A-Z][A-Z0-9_]{0,127}$/u.test(options['api-key-env'])) fail('VERIFY_INVALID_ARGUMENT');
  if (options['account-reference'] && !/^[a-z][a-z0-9_-]{0,63}$/u.test(options['account-reference'])) fail('VERIFY_INVALID_ARGUMENT');
  if (options['max-requests'] !== undefined && options['max-requests'] !== '1') fail('VERIFY_REQUEST_BUDGET');
  if (options.report && (!isAbsolute(options.report) || !options.report.endsWith('.json'))) fail('VERIFY_INVALID_ARGUMENT');
  let endpoint = official;
  if (options['fixture-endpoint']) {
    let url;
    try { url = new URL(options['fixture-endpoint']); } catch { fail('VERIFY_INVALID_FIXTURE_ENDPOINT'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) fail('VERIFY_INVALID_FIXTURE_ENDPOINT');
    endpoint = url.href.replace(/\/$/u, '');
  }
  const execute = Boolean(options.live || options['fixture-endpoint']);
  if (execute && (!options.model || !options['declare-pdf'] || !options['allow-unknown-document-token-cost'] || !options['capability-reference'] || !options['account-reference'] || (options.live && (!options['api-key-env'] || options['max-requests'] !== '1')))) fail('VERIFY_EXPLICIT_CAPABILITY_REQUIRED');
  return Object.freeze({ ...options, execute, endpoint, maxRequests: 1 });
}

/** Authored, uncompressed single-page PDF with an exact ASCII token in its only content stream. */
export function onePagePdf(token) {
  if (typeof token !== 'string' || !/^MOODCODEPDF_[A-F0-9]{16}$/u.test(token)) fail('VERIFY_PDF_FIXTURE_INVALID');
  const stream = `BT\n/F1 24 Tf\n72 700 Td\n(${token}) Tj\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let text = '%PDF-1.7\n% Moodcode authored one-page recognition probe\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(text);
  text += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text, 'ascii');
}

/** Independent structural audit of this fixed probe grammar, not a general-purpose PDF parser. */
export function inspectOnePagePdf(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 4096 || bytes.some(byte => byte > 127)) fail('VERIFY_PDF_FIXTURE_INVALID');
  const text = bytes.toString('ascii');
  const objects = [...text.matchAll(/^(\d+) 0 obj\n([\s\S]*?)\nendobj\n/gmu)];
  const tail = /xref\n0 6\n0000000000 65535 f \n((?:\d{10} 00000 n \n){5})trailer\n<< \/Size 6 \/Root 1 0 R >>\nstartxref\n(\d+)\n%%EOF\n$/u.exec(text);
  if (!text.startsWith('%PDF-1.7\n') || objects.length !== 5 || !tail || Number(tail[2]) !== tail.index) fail('VERIFY_PDF_FIXTURE_INVALID');
  const offsets = tail[1].trimEnd().split('\n').map(line => Number(line.slice(0, 10)));
  for (let i = 0; i < objects.length; i++) if (objects[i][1] !== String(i + 1) || objects[i].index !== offsets[i]) fail('VERIFY_PDF_FIXTURE_INVALID');
  if (objects[0][2] !== '<< /Type /Catalog /Pages 2 0 R >>' || objects[1][2] !== '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
    || objects[2][2] !== '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'
    || objects[3][2] !== '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>') fail('VERIFY_PDF_FIXTURE_INVALID');
  const content = /^<< \/Length (\d+) >>\nstream\n(BT\n\/F1 24 Tf\n72 700 Td\n\((MOODCODEPDF_[A-F0-9]{16})\) Tj\nET\n)endstream$/u.exec(objects[4][2]);
  if (!content || Number(content[1]) !== Buffer.byteLength(content[2]) || [...text.matchAll(/\/Type \/Page\b/gu)].length !== 1
    || /\/(?:Encrypt|Filter|OpenAction|JavaScript|JS|EmbeddedFiles)\b/u.test(text)) fail('VERIFY_PDF_FIXTURE_INVALID');
  // Standard Courier has a 600/1000-em advance; the full 28-character line fits its fixed MediaBox.
  const lineWidthPt = content[3].length * 24 * 600 / 1000;
  if (72 + lineWidthPt > 612 - 72 || 700 + 24 > 792) fail('VERIFY_PDF_FIXTURE_INVALID');
  return { token: content[3], pages: 1, bytes: bytes.length, sha256: hash(bytes), objects: objects.length, compressed: false, encrypted: false,
    layout: { font: 'Courier', fontSizePt: 24, lineCharacters: content[3].length, lineWidthPt, startXPt: 72, baselineYPt: 700, pageWidthPt: 612, pageHeightPt: 792, fitsPage: true } };
}

async function freezeDirectory(directory, prefix, pins, paths, budget) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name), key = prefix + '/' + entry.name;
    if (entry.isDirectory()) await freezeDirectory(path, key, pins, paths, budget);
    else if (entry.isFile() && /\.(?:[cm]?js|json|ts)$/u.test(entry.name) && !/\.test\./u.test(entry.name) && !key.includes('/fixtures/')) {
      const bytes = await readFile(path);
      if (Object.keys(pins).length >= 2048 || bytes.length > 4194304 || (budget.bytes += bytes.length) > 67108864) fail('VERIFY_SOURCE_LIMIT');
      pins[key] = hash(bytes); paths[key] = path;
    }
  }
}
async function freezeSources() {
  const pins = {}, paths = {}, budget = { bytes: 0 };
  for (const name of ['packages/contracts/src', 'packages/engine/src']) await freezeDirectory(join(root, name), name, pins, paths, budget);
  pins['scripts/verify-provider-coverage-pdf.mjs'] = hash(await readFile(fileURLToPath(import.meta.url)));
  paths['scripts/verify-provider-coverage-pdf.mjs'] = fileURLToPath(import.meta.url);
  return { pins, paths };
}
async function freezeRuntime(engineURL) {
  const pins = {}, paths = {}, budget = { bytes: 0 };
  await freezeDirectory(dirname(fileURLToPath(engineURL)), 'engine', pins, paths, budget);
  await freezeDirectory(dirname(fileURLToPath(import.meta.resolve('@moodcode/contracts'))), 'contracts', pins, paths, budget);
  return { pins, paths };
}
async function unchanged(frozen) {
  for (const [key, path] of Object.entries(frozen.paths)) if (hash(await readFile(path)) !== frozen.pins[key]) return false;
  return true;
}
const freezeReport = frozen => ({ sha256: jsonHash(frozen.pins), files: Object.keys(frozen.pins).length, pins: frozen.pins, unchanged: null });

function nativeEvidence(engine, run, owners) {
  const turns = engine.store.listTurns(run.id);
  const parts = turns.flatMap(turn => engine.store.listParts(turn.id));
  const attempts = owners.filter(owner => owner.runId === run.id).map(owner => {
    const attempt = engine.store.getAttempt(owner.attemptId), cleanup = engine.store.getAttemptCleanup(owner.attemptId, run.sessionId);
    const usage = engine.store.getAttemptUsage(owner.attemptId);
    assert.equal(cleanup.requestSha256, owner.requestSha256);
    return { ...owner, state: attempt.state, attemptSha256: jsonHash(attempt), cleanup: { state: cleanup.state, confirmed: cleanup.cleanupConfirmed, method: cleanup.method, reason: cleanup.reason }, usage: usage?.usage ?? null, usageRecordSha256: usage ? jsonHash(usage) : null };
  });
  return { inputId: run.inputId, sessionId: run.sessionId, runId: run.id, state: run.state, errorCode: run.error?.code ?? null, runSha256: jsonHash(run), turns: turns.map(turn => ({ id: turn.id, state: turn.state, sha256: jsonHash(turn) })), attempts,
    parts: parts.map(part => ({ id: part.id, turnId: part.turnId, type: part.type, state: part.state, sha256: jsonHash(part), ...(part.type === 'text' ? { textSha256: hash(part.text), textBytes: Buffer.byteLength(part.text) } : {}) })) };
}

/** A local injected transport or loader may verify native contracts but never earns account credit. */
export async function verifyProviderPdf(argv, runtime = {}) {
  const options = parseProviderPdfArgs(argv), sources = await freezeSources();
  const report = { schemaVersion: 1, kind: 'provider-pdf-coverage', observedAt: new Date().toISOString(), implementationCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    state: options.execute ? 'running' : 'plan-only', passed: false, accountVerified: false, credentialReads: 0, maxRequests: 1, actualRequests: [], scopeCoverage: [],
    sourceFreeze: freezeReport(sources), runtime: { node: process.versions.node, platform: process.platform, arch: process.arch }, cleanupConfirmed: false,
    transport: !direct || hooked || options['fixture-endpoint'] || Object.keys(runtime).length ? 'local-fixture' : 'real-remote',
    supportBoundary: { protocol: 'standard-openai-responses', transport: 'native-input_file-file_data', mimeType: 'application/pdf', probePages: 1, probeMaxBytes: 4096, nativeMaxDocumentBytes: 524288, nativeMaxCombinedBytes: 1048576, providerMaxRequestBytes: 2097152, providerTimeoutMs: 45000, providerAttemptsPerTurn: 1, genericPdfPageValidation: false, tokenCost: null },
    officialSources: ['https://developers.openai.com/api/docs/guides/file-inputs', 'https://developers.openai.com/api/docs/models/gpt-4.1', 'https://developers.openai.com/api/docs/models/gpt-4.1-mini'],
    remainingScopes: ['unselected accounts and models', 'general PDF page/object parsing', 'Codex PDF', 'provider file_url/file_id input', 'E5-13 broader media'] };
  if (!options.execute) { report.transport = 'none'; report.cleanupConfirmed = true; report.sourceFreeze.unchanged = true; return report; }
  let engine, temporary, frozenRuntime, currentOwner, rejectedResponse, document, audit, activeCase = 'configuration', uncertain = false;
  const owners = [], engines = [], cleanupProofs = new Map();
  try {
    let apiKey;
    if (options.live) { report.credentialReads++; apiKey = (runtime.readCredential ?? (name => process.env[name]))(options['api-key-env']); if (!apiKey) fail('VERIFY_CREDENTIAL_UNAVAILABLE'); }
    if (apiKey && options.model.includes(apiKey)) fail('VERIFY_INVALID_ARGUMENT');
    const engineURL = runtime.engineModuleURL ?? import.meta.resolve('@moodcode/engine');
    frozenRuntime = await freezeRuntime(engineURL); report.runtimeFreeze = freezeReport(frozenRuntime);
    const api = runtime.engineModule ?? await import(engineURL);
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-provider-pdf-')));
    const repository = join(temporary, 'repository'); await mkdir(repository); execFileSync('git', ['init', '-q', repository]);
    const dbPath = join(temporary, 'engine.sqlite'), artifactDir = join(temporary, 'artifacts');
    const transport = new api.ResponsesProvider({ id: 'verify-pdf-responses', baseURL: options.endpoint, apiKey, pdfModelIds: [options.model], allowUnknownDocumentTokenCost: true, timeoutMs: 45000, maxResponseBytes: 65536,
      fetch: async (url, init) => {
        if (report.actualRequests.length >= options.maxRequests) fail('VERIFY_REQUEST_BUDGET');
        const target = new URL(String(url)), expected = new URL(options.endpoint + '/responses');
        if (target.href !== expected.href || init.method !== 'POST' || init.redirect !== 'error') fail('VERIFY_ENDPOINT_INVALID');
        const body = JSON.parse(String(init.body)), blocks = body.input.flatMap(item => Array.isArray(item.content) ? item.content : []), files = blocks.filter(item => item.type === 'input_file');
        if (!currentOwner || body.model !== options.model || body.stream !== true || body.store !== false || files.length !== 1 || body.tools !== undefined) fail('VERIFY_PDF_WIRE_INVALID');
        assert.deepEqual(files[0], { type: 'input_file', filename: document.id + '.pdf', file_data: 'data:application/pdf;base64,' + audit.bytesValue.toString('base64') });
        const plaintext = JSON.stringify({ ...body, input: body.input.map(item => ({ ...item, ...(Array.isArray(item.content) ? { content: item.content.filter(block => block.type !== 'input_file') } : {}) })) });
        if (plaintext.includes('MOODCODEPDF_') || plaintext.includes(audit.token.slice('MOODCODEPDF_'.length))) fail('VERIFY_ANSWER_LEAKED');
        const observation = { ordinal: report.actualRequests.length + 1, ...currentOwner, protocol: 'responses', modelId: body.model, bodyBytes: Buffer.byteLength(String(init.body)), bodySha256: hash(String(init.body)), documentId: document.id, sourceSha256: document.sha256, probePages: audit.pages, recognitionExpectedAbsent: true, status: null };
        report.actualRequests.push(observation);
        let response;
        try { response = await (runtime.fetch ?? globalThis.fetch)(url, { ...init, redirect: 'error' }); }
        catch (error) {
          observation.errorCode = errorCode(error);
          if (observation.errorCode === 'CLEANUP_UNCERTAIN') { rejectedResponse = { confirmed: false }; uncertain = true; report.cleanupFailure = 'VERIFY_TRANSPORT_CLEANUP_UNCERTAIN'; }
          throw error;
        }
        observation.status = response.status;
        observation.contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'text/event-stream' ? 'text/event-stream' : 'other';
        let endpointValid = !response.redirected;
        if (options.live && report.transport === 'real-remote') {
          try { endpointValid &&= response.url && new URL(response.url).href === expected.href; } catch { endpointValid = false; }
        }
        if (!endpointValid) {
          observation.errorCode = 'VERIFY_ENDPOINT_INVALID';
          observation.rejectedBodyCleanupConfirmed = await cancelRejectedBody(response);
          rejectedResponse = { confirmed: observation.rejectedBodyCleanupConfirmed };
          if (!observation.rejectedBodyCleanupConfirmed) { uncertain = true; report.cleanupFailure = 'VERIFY_TRANSPORT_CLEANUP_UNCERTAIN'; }
          throw new EngineError(rejectedResponse.confirmed ? 'VERIFY_ENDPOINT_INVALID' : 'CLEANUP_UNCERTAIN', 'Rejected provider response requires confirmed cleanup');
        }
        return response;
      } });
    const provider = { id: transport.id, inputModalities: transport.inputModalities, inputFileTypes: transport.inputFileTypes, replayProtocol: transport.replayProtocol,
      allowUnknownDocumentTokenCost: transport.allowUnknownDocumentTokenCost, supportsInputFile: transport.supportsInputFile.bind(transport),
      async *streamTurn(request, signal) {
        const native = engine.store.getAttemptCleanup(request.attemptId, request.sessionId);
        for (const key of ['runId', 'sessionId', 'turnId', 'attemptId', 'modelId']) assert.equal(native[key], request[key]);
        assert.equal(native.providerId, transport.id); assert.equal(native.state, 'dispatched');
        currentOwner = { workspaceId: native.workspaceId, sessionId: native.sessionId, inputId: engine.store.getRun(request.runId).inputId, runId: native.runId, turnId: native.turnId, attemptId: native.attemptId, providerId: native.providerId, modelId: native.modelId, requestSha256: native.requestSha256 };
        owners.push(currentOwner);
        rejectedResponse = undefined;
        try { yield* transport.streamTurn(request, signal); }
        catch (error) {
          if (rejectedResponse) throw new EngineError(rejectedResponse.confirmed ? 'VERIFY_ENDPOINT_INVALID' : 'CLEANUP_UNCERTAIN', 'Rejected provider response requires confirmed cleanup');
          throw error;
        } finally { currentOwner = null; }
      } };
    const modelSpec = { providerId: provider.id, modelId: options.model, contextWindow: null, maxOutputTokens: null, modalities: ['text', 'image'], inputFileTypes: ['application/pdf'], tools: false, reasoning: false, nativeReplay: true,
      source: { kind: report.transport === 'real-remote' ? 'host' : 'fixture', observedAt: report.observedAt, reference: options['capability-reference'] } };
    const engineOptions = { dbPath, artifactDir, providers: [provider], tools: [], modelSpecs: [modelSpec], allowUnknownDocumentTokenCost: true,
      defaults: { providerId: provider.id, modelId: options.model, mode: 'plan', limits: { maxTurns: 1, maxToolCalls: 1, maxContextBytes: 262144, maxOutputBytes: 4096, maxDurationMs: 60000 }, budgets: { maxProviderAttempts: 1, providerRequestTimeoutMs: 45000, providerInactivityTimeoutMs: 10000 } } };
    report.configuration = { providerId: provider.id, modelId: options.model, modelSource: modelSpec.source.kind, capabilitiesSha256: jsonHash(modelSpec), capabilityReferenceSha256: hash(options['capability-reference']), accountReferenceSha256: hash(options['account-reference']), credentialReference: options.live ? options['api-key-env'] : null, unknownDocumentTokenCostAllowed: true };
    engine = api.createEngine(engineOptions); engines.push(engine);
    const workspace = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type: 'workspace.open', payload: { path: repository } }); assert.equal(workspace.ok, true);
    const createSession = async () => { const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type: 'session.create', payload: { workspaceId: workspace.result.id } }); assert.equal(result.ok, true); return result.result.id; };
    const sessionId = await createSession(), otherSessionId = await createSession();
    const bytes = onePagePdf('MOODCODEPDF_' + randomBytes(8).toString('hex').toUpperCase()); audit = { ...inspectOnePagePdf(bytes), bytesValue: bytes };
    document = await engine.importDocument(sessionId, bytes); assert.equal(document.sha256, audit.sha256); assert.equal(document.bytes, audit.bytes);
    assert.deepEqual(await readFile(join(artifactDir, 'input-documents', document.id + '.blob')), bytes);
    report.probe = { profile: 'authored-single-page-courier-v1', pages: audit.pages, bytes: audit.bytes, sha256: audit.sha256, tokenSha256: hash(audit.token), layout: audit.layout, nativeDocument: document };
    const prompt = 'Transcribe the entire only printed line on the supplied PDF page, including every letter, underscore and digit from the first character to the last. Return that complete line exactly, without adding punctuation, explanation, quotes or formatting. Do not omit any portion of the line.';
    const payload = { sessionId, requestId: randomUUID(), prompt, documents: [document], delivery: 'queue' };
    const accept = value => engine.dispatchSession({ schemaVersion: 2, commandId: randomUUID(), type: 'input.accept', payload: value });
    activeCase = 'pdf-source-owner';
    const foreign = await accept({ ...payload, sessionId: otherSessionId }); assert.equal(foreign.ok, false); assert.equal(foreign.error.code, 'RECORD_SCOPE_MISMATCH'); assert.equal(engine.store.listInputs(otherSessionId).inputs.length, 0); assert.equal(report.actualRequests.length, 0);
    report.scopeCoverage.push({ caseId: activeCase, state: 'passed', errorCode: foreign.error.code, requests: 0 });
    activeCase = 'pdf-exact-recognition';
    const result = await accept(payload); if (!result.ok) fail(result.error.code);
    await engine.scheduler.waitForSession(sessionId);
    const input = engine.store.getInput(result.result.inputId), run = await engine.waitForRun(input.runId);
    assert.deepEqual(input.documents, [document]); assert.deepEqual(run.documents, [document]);
    const evidence = nativeEvidence(engine, run, owners);
    for (const attempt of evidence.attempts) cleanupProofs.set(attempt.attemptId, attempt.cleanup);
    report.native = evidence;
    if (evidence.attempts.some(attempt => attempt.cleanup.confirmed !== true) || run.state === 'uncertain' || run.cleanupUncertainty) uncertain = true;
    if (run.state !== 'completed') fail(run.error?.code ?? 'VERIFY_RUN_NOT_COMPLETED');
    if (evidence.attempts.length !== 1 || evidence.attempts[0].state !== 'completed' || report.actualRequests.length !== 1 || evidence.turns.length !== 1) fail('VERIFY_NATIVE_EVIDENCE_INVALID');
    const parts = engine.store.listParts(evidence.turns[0].id), answer = parts.filter(part => part.type === 'text').map(part => part.text).join('');
    const matched = /^[\t\n\r ]*MOODCODEPDF_[A-F0-9]{16}[\t\n\r ]*$/u.test(answer) && answer.trim() === audit.token;
    const diagnosticText = apiKey ? answer.replaceAll(apiKey, '[REDACTED]') : answer;
    const observedText = boundedText(diagnosticText, 128);
    report.recognition = { matched, expectedSha256: hash(audit.token), observedSha256: hash(answer), expectedOnlyInPdf: true, normalization: 'outer ASCII whitespace only',
      diagnostic: { source: 'authored-synthetic-probe; native adapter-redacted text', expectedToken: apiKey ? audit.token.replaceAll(apiKey, '[REDACTED]') : audit.token,
        observedText, observedTextBytes: Buffer.byteLength(answer), maxObservedBytes: 128, truncated: Buffer.byteLength(diagnosticText) > 128 } };
    if (!matched || parts.length !== 1 || parts[0].type !== 'text' || parts[0].state !== 'completed') fail('VERIFY_PDF_RECOGNITION_MISMATCH');
    const usage = evidence.attempts[0].usage;
    if (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 1 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 1) fail('VERIFY_USAGE_UNAVAILABLE');
    const history = engine.store.readModelHistory(sessionId, 32, 262144).snapshot, user = history.messages.find(message => message.role === 'user');
    assert.deepEqual(user.documents, [document]); assert.equal(user.content, prompt);
    for (const native of [input, run, user]) { assert.equal(JSON.stringify(native).includes(bytes.toString('base64')), false); assert.equal(JSON.stringify(native).includes(audit.token), false); }
    const estimate = engine.context.diagnostics(sessionId).plan.inputEstimate; assert.equal(estimate.documentTokens, null); assert.equal(estimate.complete, false);
    report.scopeCoverage.push({ caseId: activeCase, state: 'passed', requests: 1, nativeSha256: jsonHash(evidence), tokenCost: null, accountVerified: false });
    activeCase = 'pdf-duplicate-input';
    const duplicate = await accept(payload); assert.equal(duplicate.ok, true); assert.equal(duplicate.result.inputId, input.id);
    await engine.scheduler.waitForSession(sessionId); assert.deepEqual(engine.store.getInput(input.id), input); assert.deepEqual(nativeEvidence(engine, engine.store.getRun(run.id), owners), evidence); assert.equal(report.actualRequests.length, 1);
    const conflict = await accept({ ...payload, prompt: prompt + ' Different.' }); assert.equal(conflict.ok, false); assert.equal(conflict.error.code, 'REQUEST_ID_CONFLICT'); assert.equal(report.actualRequests.length, 1);
    report.scopeCoverage.push({ caseId: activeCase, state: 'passed', requests: 0, sameNativeIdentity: true, conflictErrorCode: conflict.error.code });
    activeCase = 'pdf-restart-no-replay';
    await engine.close(); engine = api.createEngine(engineOptions); engines.push(engine);
    assert.deepEqual(engine.store.getInput(input.id), input); assert.deepEqual(nativeEvidence(engine, engine.store.getRun(run.id), owners), evidence); assert.equal(report.actualRequests.length, 1);
    report.scopeCoverage.push({ caseId: activeCase, state: 'passed', requests: 0 });
    activeCase = 'pdf-archive-no-replay';
    await engine.close();
    await api.exportEngineArchive({ dbPath, artifactDir, destination: join(temporary, 'archive') });
    const imported = await api.importEngineArchive({ directory: join(temporary, 'archive'), destination: join(temporary, 'imported') });
    engine = api.createEngine({ ...engineOptions, dbPath: imported.dbPath, artifactDir: imported.artifactDir }); engines.push(engine);
    assert.deepEqual(await readFile(join(imported.artifactDir, 'input-documents', document.id + '.blob')), bytes);
    assert.deepEqual(engine.store.getInput(input.id), input); assert.deepEqual(nativeEvidence(engine, engine.store.getRun(run.id), owners), evidence);
    assert.deepEqual(engine.store.readModelHistory(sessionId, 32, 262144).snapshot, history); assert.equal(engine.store.getSessionControl(sessionId).paused, true); assert.equal(report.actualRequests.length, 1);
    report.scopeCoverage.push({ caseId: activeCase, state: 'passed', requests: 0, exactBlobRestored: true, sessionPaused: true });
    report.passed = true; report.state = 'passed';
  } catch (error) { report.failure = errorCode(error); report.failureCaseId = activeCase; report.state = uncertain ? 'uncertain' : 'failed'; }
  finally {
    for (const owner of owners) if (!cleanupProofs.has(owner.attemptId)) {
      try { const native = engine.store.getAttemptCleanup(owner.attemptId, owner.sessionId); cleanupProofs.set(owner.attemptId, { state: native.state, confirmed: native.cleanupConfirmed, method: native.method, reason: native.reason }); }
      catch { uncertain = true; report.cleanupFailure = 'VERIFY_NATIVE_EVIDENCE_UNAVAILABLE'; }
    }
    report.engineCloseConfirmed = true;
    for (const owned of engines) try { await owned.close(); } catch (error) { report.engineCloseConfirmed = false; uncertain = true; report.cleanupFailure = errorCode(error); }
    if ([...cleanupProofs.values()].some(proof => proof.confirmed !== true)) uncertain = true;
    report.cleanupProofs = [...cleanupProofs].map(([attemptId, proof]) => ({ attemptId, ...proof }));
    report.observedAttempts = owners;
    try { report.sourceFreeze.unchanged = await unchanged(sources); } catch { report.sourceFreeze.unchanged = false; }
    if (frozenRuntime) try { report.runtimeFreeze.unchanged = await unchanged(frozenRuntime); } catch { report.runtimeFreeze.unchanged = false; }
    if (!report.sourceFreeze.unchanged || report.runtimeFreeze?.unchanged === false) { uncertain = true; report.failure = 'VERIFY_SOURCE_CHANGED'; }
    report.cleanupConfirmed = !uncertain;
    const retainSemanticFailure = report.recognition?.matched === false && Boolean(report.native);
    if (temporary && !uncertain && !retainSemanticFailure) try { await rm(temporary, { recursive: true, force: true }); } catch { report.cleanupConfirmed = false; }
    if (temporary && (retainSemanticFailure || !report.cleanupConfirmed)) {
      report.retainedEvidenceDirectory = temporary;
      report.retainedEvidenceReason = retainSemanticFailure && report.cleanupConfirmed ? 'semantic-mismatch-after-confirmed-engine-close' : 'cleanup-or-source-uncertainty';
    }
    if (!report.cleanupConfirmed) { report.passed = false; report.state = 'uncertain'; }
    report.accountVerified = report.passed && report.cleanupConfirmed && options.live === true && report.transport === 'real-remote';
    for (const coverage of report.scopeCoverage) coverage.accountVerified = report.accountVerified && coverage.caseId === 'pdf-exact-recognition';
  }
  return report;
}

/** Central account executors own their qualification; this injected lane supplies native evidence only. */
export async function runProviderPdfCoverage({ api, modelId, apiKey, fetch, accountReference, capabilityReference, qualification = {} }) {
  const reference = typeof accountReference === 'string' ? accountReference : 'central-host-account';
  const report = await verifyProviderPdf(['--live', '--model', modelId, '--declare-pdf', '--allow-unknown-document-token-cost',
    '--api-key-env', 'MOODCODE_PDF_HOST_API_KEY', '--account-reference', 'account-' + hash(reference).slice(0, 16),
    '--capability-reference', capabilityReference, '--max-requests', '1'], { engineModule: api, readCredential: () => apiKey, fetch });
  report.hostQualification = { transport: qualification.transport === 'real-remote' ? 'real-remote' : 'local-fixture', accountReferenceSha256: hash(reference),
    sourceSha256: /^[a-f0-9]{64}$/u.test(qualification.sourceSha256 ?? '') ? qualification.sourceSha256 : null,
    runtimeSha256: /^[a-f0-9]{64}$/u.test(qualification.runtimeSha256 ?? '') ? qualification.runtimeSha256 : null,
    qualifiedByCentralExecutor: true };
  return report;
}

if (direct) {
  let report;
  try { report = await verifyProviderPdf(process.argv.slice(2)); }
  catch (error) { report = { schemaVersion: 1, kind: 'provider-pdf-coverage', state: 'rejected', failure: errorCode(error), accountVerified: false, credentialReads: 0, actualRequests: [], cleanupConfirmed: true }; }
  if (['failed', 'uncertain', 'rejected'].includes(report.state)) process.exitCode = 1;
  const text = JSON.stringify(report, null, 2) + '\n', index = process.argv.indexOf('--report');
  if (index !== -1 && report.state !== 'rejected') try { await writeFile(process.argv[index + 1], text, { flag: 'wx', mode: 0o600 }); } catch { process.exitCode = 1; console.error('PDF_REPORT_WRITE_FAILED'); }
  console.log(text);
}
