import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const digest = value => createHash('sha256').update(value).digest('hex');
const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const flags = new Set(['live']);
const strings = new Set(['lane', 'model', 'max-requests', 'credential-env', 'credential-file', 'capability-reference', 'report']);
const ceilings = Object.freeze({ pdf: 1, anthropic: 3, media: 1 });
const invalid = () => { throw Object.assign(new Error('Invalid provider coverage arguments.'), { code: 'VERIFY_INVALID_ARGUMENT' }); };

/** A plan neither resolves credentials nor imports a provider runtime. */
export function parseProviderCoverageArgs(argv) {
  const args = {};
  for (let at = 0; at < argv.length; at++) {
    const option = argv[at];
    if (!option?.startsWith('--')) invalid();
    const name = option.slice(2);
    if (Object.hasOwn(args, name) || !flags.has(name) && !strings.has(name)) invalid();
    if (flags.has(name)) args[name] = true;
    else {
      const value = argv[++at];
      if (!value || value.startsWith('--') || Buffer.byteLength(value) > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
      args[name] = value;
    }
  }
  if (!Object.hasOwn(ceilings, args.lane) || !args.model || Buffer.byteLength(args.model) > 256) invalid();
  if (args['credential-env'] && !/^[A-Z][A-Z0-9_]{0,127}$/u.test(args['credential-env'])) invalid();
  const maximum = args['max-requests'] ?? String(ceilings[args.lane]);
  if (!/^[1-3]$/u.test(maximum) || Number(maximum) > ceilings[args.lane]) invalid();
  if (args.live && (!args['max-requests'] || !args['credential-env'] || !args['capability-reference'])) invalid();
  return Object.freeze({ ...args, maxRequests: Number(maximum) });
}

/** Explicit literal env files only: no shell evaluation, interpolation, or credential search. */
export async function readProviderCredential(name, file, environment = process.env) {
  if (file === undefined) return environment[name];
  const info = await stat(file);
  if (!info.isFile() || info.size > 65536) throw Object.assign(new Error('Credential file is not bounded.'), { code: 'VERIFY_CREDENTIAL_FILE_INVALID' });
  const text = await readFile(file, 'utf8');
  const values = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (match?.[1] !== name) continue;
    let value = match[2];
    if (/^(['"]).*\1$/u.test(value)) value = value.slice(1, -1);
    else if (/['"\s]/u.test(value)) throw Object.assign(new Error('Credential reference is not literal.'), { code: 'VERIFY_CREDENTIAL_FILE_INVALID' });
    values.push(value);
  }
  if (values.length > 1) throw Object.assign(new Error('Credential reference is ambiguous.'), { code: 'VERIFY_CREDENTIAL_FILE_INVALID' });
  return values[0];
}

async function collect(directory, suffix) {
  const paths = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...await collect(path, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) paths.push(path);
  }
  return paths;
}
export async function freezeProviderCoverageRuntime() {
  const sources = [
    ...await collect('packages/contracts/src', '.ts'), ...await collect('packages/engine/src', '.ts'),
    ...await collect('scripts', '.mjs'), 'package.json', 'package-lock.json',
  ].sort();
  const runtime = [...await collect('packages/contracts/dist', '.js'), ...await collect('packages/engine/dist', '.js')].sort();
  const pins = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, digest(await readFile(join(root, path)))])));
  const sourcePins = await pins(sources), runtimePins = await pins(runtime);
  return { source: { sha256: digest(JSON.stringify(sourcePins)), files: sources.length, pins: sourcePins },
    runtime: { sha256: digest(JSON.stringify(runtimePins)), files: runtime.length, pins: runtimePins } };
}

/** Failed freeze checks must retain already observed requests and original native errors. */
export async function confirmProviderCoverageFreeze(report, before, freeze = freezeProviderCoverageRuntime) {
  try {
    const after = await freeze();
    report.sourceRuntimeUnchanged = before.source.sha256 === after.source.sha256 && before.runtime.sha256 === after.runtime.sha256;
  } catch {
    report.sourceRuntimeUnchanged = false;
    report.freezeFailure = { code: 'VERIFY_SOURCE_UNAVAILABLE' };
  }
}

export async function closeRejectedProviderResponse(response, timeoutMs = 1000) {
  if (!response.body) return true;
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(() => response.body.cancel()).then(() => true, () => false),
      new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(false), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

export function projectPublicProviderCoverage(api, report) {
  const providerId = report.evidence?.configuration?.providerId ?? report.evidence?.observedAttempts?.[0]?.providerId;
  if (!providerId) return null;
  const provider = report.lane === 'anthropic' ? new api.AnthropicProvider({ id: providerId, thinking: 'adaptive' })
    : new api.ResponsesProvider({ id: providerId, ...(report.lane === 'pdf'
      ? { pdfModelIds: [report.modelId], allowUnknownDocumentTokenCost: true } : { videoModelIds: [report.modelId] }) });
  const spec = report.lane === 'anthropic' ? api.anthropicModelSpec(report.modelId, { providerId, observedAt: report.observedAt })
    : { providerId, modelId: report.modelId, contextWindow: null, maxOutputTokens: null, modalities: ['text', 'image'],
      inputFileTypes: report.lane === 'pdf' ? ['application/pdf'] : [],
      mediaCapabilities: { audioInput: false, videoFrames: report.lane === 'media', audioOutput: false },
      tools: false, reasoning: false, nativeReplay: true,
      source: { kind: 'host', observedAt: report.observedAt, reference: report.capabilityReference } };
  const feature = report.lane === 'pdf' ? 'pdf-input' : report.lane === 'media' ? 'video-frames' : 'image-input';
  const evidence = [{ providerId, modelId: report.modelId, protocol: provider.replayProtocol, feature,
    observedAt: report.observedAt, reportSha256: digest(JSON.stringify(report.evidence)), transport: report.transport,
    passed: report.passed, nativeVerified: report.passed && (report.transport === 'local-fixture' || report.accountVerified), cleanupConfirmed: report.cleanupConfirmed === true,
    duplicateNoReplay: report.passed, ...report.qualification }];
  return api.describeProviderCoverage({ provider, modelSpec: spec, evidence, qualification: report.qualification,
    allowUnknownDocumentTokenCost: report.lane === 'pdf', allowUnknownMediaTokenCost: report.lane === 'media' });
}

function errorRecord(error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/u.test(error.code) ? error.code : 'VERIFY_EXECUTION_FAILED';
  const status = error?.details?.status ?? error?.status;
  return { code, ...(Number.isSafeInteger(status) && status >= 100 && status <= 599 ? { status } : {}) };
}

/** Direct CLI transport owns account credit; dependency-injected tests retain fixture status. */
export async function verifyProviderCoverage(argv, runtime = {}) {
  const options = parseProviderCoverageArgs(argv);
  const report = {
    schemaVersion: 1, kind: 'provider-coverage-verification', observedAt: new Date().toISOString(),
    lane: options.lane, modelId: options.model, state: options.live ? 'running' : 'plan-only',
    implementationCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
    maxRequests: options.maxRequests, actualRequests: [], actualRequestCountKnown: true, actualRequestCount: 0, credentialReads: 0,
    accountVerified: false, passed: false, cleanupConfirmed: null, sourceRuntimeUnchanged: null,
    capabilityReference: options['capability-reference'] ?? null,
    authentication: { method: 'api-key', credentialOwner: 'host', rendererCredentialExposure: false, persistentAccountIdentity: null },
    credentialReference: options.live ? `process:${options['credential-env']}` : null,
    accountReference: options.live ? `probe-account-${randomUUID()}` : null,
    accountIdentityClaimed: false,
    accountReferenceScope: 'One resolved credential in this invocation; no persistent provider account identity or cross-run reuse.',
    unknownDocumentTokenCost: null, unknownMediaTokenCost: null,
  };
  if (!options.live) return report;
  const realTransport = Boolean(direct && !Object.keys(runtime).length && !process.env.NODE_OPTIONS
    && !process.execArgv.some(value => /^--(?:import|require|loader|experimental-loader|eval)(?:=|$)|^-[re]/u.test(value)));
  report.transport = realTransport ? 'real-remote' : 'local-fixture';
  let apiKey, frozen, api, physicalUnknown = false;
  try {
    report.credentialReads++;
    apiKey = await (runtime.readCredential ?? readProviderCredential)(options['credential-env'], options['credential-file']);
    if (options['credential-file']) report.credentialReference = `env-file-path-sha256:${digest(await realpath(options['credential-file']))}:${options['credential-env']}`;
    if (!apiKey) {
      report.state = 'external-condition'; report.error = { code: 'VERIFY_CREDENTIAL_UNAVAILABLE' };
      report.cleanupConfirmed = true;
      return report;
    }
    if (typeof apiKey !== 'string' || apiKey.length > 8192 || /[\u0000-\u0020\u007f]/u.test(apiKey)) {
      throw Object.assign(new Error('Invalid credential value.'), { code: 'VERIFY_CREDENTIAL_INVALID' });
    }
    frozen = await freezeProviderCoverageRuntime();
    report.sourceFreeze = frozen.source; report.runtimeFreeze = frozen.runtime;
    const qualification = { transport: report.transport, accountReference: report.accountReference,
      sourceSha256: frozen.source.sha256, runtimeSha256: frozen.runtime.sha256 };
    api = runtime.engineModule ?? await import('../packages/engine/dist/index.js');
    const { EngineError } = await import('../packages/contracts/dist/index.js');
    const requestFetch = runtime.fetch ?? globalThis.fetch;
    const captureFetch = async (url, init) => {
      const target = new URL(String(url));
      const endpoint = options.lane === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/responses';
      if (target.href !== endpoint || init?.method !== 'POST') throw Object.assign(new Error('Unexpected provider endpoint.'), { code: 'VERIFY_ENDPOINT_INVALID' });
      const body = JSON.parse(String(init.body));
      if (body.model !== options.model || report.actualRequests.length >= options.maxRequests) {
        throw Object.assign(new Error('Provider request budget or model mismatch.'), { code: 'VERIFY_REQUEST_BUDGET' });
      }
      const request = { ordinal: report.actualRequests.length + 1, endpoint, modelId: body.model,
        bodyBytes: Buffer.byteLength(String(init.body)), bodySha256: digest(String(init.body)), status: null };
      report.actualRequests.push(request);
      const response = await requestFetch(url, { ...init, redirect: 'error' });
      request.status = response.status;
      if (response.redirected || realTransport && response.url !== endpoint) {
        if (!await closeRejectedProviderResponse(response)) {
          physicalUnknown = true;
          throw new EngineError('CLEANUP_UNCERTAIN', 'Rejected provider response cleanup is unconfirmed.');
        }
        throw new EngineError('VERIFY_ENDPOINT_INVALID', 'Unexpected provider redirect.');
      }
      return response;
    };
    if (options.lane === 'pdf') {
      const { runProviderPdfCoverage } = await import('./verify-provider-coverage-pdf.mjs');
      report.evidence = await runProviderPdfCoverage({ api, modelId: options.model, apiKey, fetch: captureFetch,
        maxRequests: options.maxRequests, capabilityReference: report.capabilityReference, accountReference: report.accountReference, qualification });
    } else if (options.lane === 'anthropic') {
      const { verifyAnthropicCoverage } = await import('./verify-provider-coverage-anthropic.mjs');
      report.evidence = await verifyAnthropicCoverage({ api, AnthropicProvider: api.AnthropicProvider,
        anthropicModelSpec: api.anthropicModelSpec, modelId: options.model, apiKey, fetch: captureFetch,
        maxRequests: options.maxRequests, capabilityReference: report.capabilityReference, qualification });
    } else {
      const { verifyProviderMediaCoverage } = await import('./verify-provider-coverage-media.mjs');
      report.evidence = await verifyProviderMediaCoverage({ modelId: options.model, credentialEnv: options['credential-env'],
        maxRequests: options.maxRequests, capabilityReference: report.capabilityReference,
        allowUnknownMediaTokenCost: true, accountReference: report.accountReference }, { apiKey });
      report.actualRequests = report.evidence.actualRequests ?? [];
      if (report.evidence.actualRequestCountKnown === false) report.actualRequestCountKnown = false;
    }
    report.passed = report.evidence.passed === true;
    report.cleanupConfirmed = report.evidence.cleanupConfirmed === true;
    if (report.evidence.failure) report.originalFailure = {
      code: /^[A-Z][A-Z0-9_]{0,100}$/u.test(report.evidence.failure) ? report.evidence.failure : 'VERIFY_EXECUTION_FAILED',
      caseId: report.evidence.failureCaseId ?? null,
      nativeErrorCode: report.evidence.originalNativeErrorCode ?? report.evidence.native?.errorCode ?? null,
    };
    if (report.evidence.error) report.error = errorRecord(report.evidence.error);
    report.state = report.passed ? 'completed' : 'failed';
    report.qualification = qualification;
  } catch (error) {
    report.state = 'failed'; report.error = errorRecord(error);
  } finally {
    if (frozen) {
      await confirmProviderCoverageFreeze(report, frozen);
    }
    if (physicalUnknown) {
      report.cleanupConfirmed = false; report.passed = false; report.state = 'uncertain';
      report.transportFailure = { code: 'CLEANUP_UNCERTAIN' };
    }
    report.actualRequestCount = report.actualRequestCountKnown ? report.actualRequests.length : null;
    report.accountVerified = Boolean(realTransport && report.passed && report.cleanupConfirmed && report.sourceRuntimeUnchanged
      && report.actualRequestCountKnown && report.actualRequests.length > 0 && report.actualRequests.length <= options.maxRequests
      && report.actualRequests.every(request => request.modelId === options.model && request.status === 200)
      && (options.lane !== 'media' || report.evidence?.accountVerified === true));
    if (!report.sourceRuntimeUnchanged && frozen) { report.passed = false; report.state = 'failed'; report.error ??= { code: 'VERIFY_SOURCE_CHANGED' }; }
  }
  if (api?.describeProviderCoverage && report.qualification) {
    try { report.publicCoverage = projectPublicProviderCoverage(api, report); }
    catch { report.projectionFailure = { code: 'VERIFY_COVERAGE_PROJECTION_FAILED' }; }
  }
  // Keep an injected provider's accidental diagnostic from exposing the host key.
  const serialized = JSON.stringify(report);
  return JSON.parse(typeof apiKey === 'string' ? serialized.replaceAll(apiKey, '[REDACTED]') : serialized);
}

if (direct) {
  try {
    const options = parseProviderCoverageArgs(process.argv.slice(2));
    const report = await verifyProviderCoverage(process.argv.slice(2));
    if (options.report) await writeFile(resolve(options.report), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ state: report.state, lane: report.lane, modelId: report.modelId, passed: report.passed,
      accountVerified: report.accountVerified, requests: report.actualRequestCount, requestsKnown: report.actualRequestCountKnown, cleanupConfirmed: report.cleanupConfirmed,
      error: report.error ?? null, report: options.report ?? null }));
    if (options.live && !report.accountVerified) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify(errorRecord(error))); process.exitCode = 1; }
}
