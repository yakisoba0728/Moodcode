import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(import.meta.url), root = dirname(dirname(path));
const executor = resolve(root, 'scripts/verify-media-account.mjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const bounded = value => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value);
const hooks = () => Boolean(process.env.NODE_OPTIONS) || process.execArgv.some(arg => /^--(?:import|require|loader|experimental-loader|eval)(?:=|$)|^-[re]/u.test(arg));
const fail = code => { throw Object.assign(new Error('Provider media coverage did not satisfy its exact bounded contract'), { code }); };

export const PROVIDER_MEDIA_SELECTION = Object.freeze({
  modelId: 'gpt-4.1-2025-04-14', protocol: 'openai-responses', wireProtocol: 'responses', scenario: 'video', maxRequests: 1,
  videoProbeProfile: 'rgb24-128px-v1', feature: 'video-frames', nativeVideoTransport: false,
  officialSources: Object.freeze(['https://developers.openai.com/api/docs/models/gpt-4.1', 'https://developers.openai.com/api/docs/guides/images-vision']),
  observedAt: '2026-10-09', tokenCost: null,
});

export function providerMediaCoverageArgs(options) {
  if (!options || options.modelId !== PROVIDER_MEDIA_SELECTION.modelId || options.maxRequests !== 1
    || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(options.credentialEnv ?? '') || !bounded(options.capabilityReference)
    || options.allowUnknownMediaTokenCost !== true
    || options.accountReference !== undefined && (!bounded(options.accountReference) || Buffer.byteLength(options.accountReference) > 256)
    || options.reportPath !== undefined && (!isAbsolute(options.reportPath) || !options.reportPath.endsWith('.json'))) fail('PROVIDER_MEDIA_SELECTION_INVALID');
  return ['--live', '--scenario', 'video', '--video-model', options.modelId, '--video-probe-size', '128', '--api-key-env', options.credentialEnv,
    '--declare-video-frames', '--allow-unknown-media-token-cost', '--capability-reference', options.capabilityReference, '--max-requests', '1'];
}

function one(values, predicate) {
  assert.ok(Array.isArray(values));
  const matches = values.filter(predicate);
  assert.equal(matches.length, 1);
  return matches[0];
}
const passedCase = (report, id) => one(report.scopeCoverage, item => item.caseId === id && item.state === 'passed');

/** Inspect original receipts, physical frame/source proofs and full-answer equality; HTTP success is insufficient. */
export function validateMediaCoverageReport(report, modelId = PROVIDER_MEDIA_SELECTION.modelId) {
  try {
    assert.equal(report.kind, 'media-account-verification');
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.state, 'passed');
    assert.equal(report.passed, true);
    assert.equal(report.failure, undefined);
    assert.equal(report.cleanupConfirmed, true);
    assert.equal(report.scenario, 'video');
    assert.equal(report.maxRequests, 1);
    assert.equal(report.sourceFreeze.unchanged, true);
    assert.equal(report.runtimeFreeze.unchanged, true);
    assert.match(report.implementationCommit, /^[a-f0-9]{40}$/u);
    for (const value of [report.sourceFreeze.files, report.runtimeFreeze.files, report.runtimeFreeze.bytes]) assert.ok(Number.isSafeInteger(value) && value > 0);
    for (const value of [report.sourceFreeze.sha256, report.sourceFreeze.executorSha256, report.runtimeFreeze.sha256, report.runtimeFreeze.engineEntrySha256]) assert.ok(sha(value));
    assert.equal(report.configuration.audioModelId, null);
    assert.equal(report.configuration.videoModelId, modelId);
    assert.equal(report.configuration.providerAttemptsPerTurn, 1);
    assert.equal(report.configuration.unknownMediaTokenCostAllowed, true);
    assert.equal(report.configuration.tokenCost, null);
    assert.equal(report.configuration.outputLayout, null);
    const request = one(report.actualRequests, () => true);
    assert.equal(request.ordinal, 1);
    assert.equal(request.protocol, 'responses');
    assert.equal(request.modelId, modelId);
    assert.equal(request.status, 200);
    assert.ok(sha(request.bodySha256));
    assert.equal(request.recognitionExpectedAbsent, true);
    const recognition = passedCase(report, 'video-frame-recognition'), native = recognition.native;
    assert.equal(native.state, 'completed');
    assert.equal(native.errorCode, null);
    for (const id of [native.sessionId, native.inputId, native.runId]) assert.ok(bounded(id));
    assert.ok(sha(native.runSha256));
    const attempt = one(native.attempts, () => true), observed = one(report.observedAttempts, () => true);
    assert.equal(attempt.runId, native.runId);
    for (const field of ['runId', 'turnId', 'attemptId', 'requestSha256']) assert.equal(observed[field], attempt[field]);
    assert.equal(observed.sessionId, native.sessionId);
    assert.equal(observed.providerId, 'verify-video-frames');
    assert.equal(observed.modelId, modelId);
    assert.equal(observed.ownerSha256, attempt.nativeOwnerSha256);
    for (const value of [attempt.requestSha256, attempt.nativeOwnerSha256]) assert.ok(sha(value));
    assert.equal(attempt.cleanup.confirmed, true);
    const cleanup = one(report.cleanupProofs, item => item.attemptId === attempt.attemptId);
    assert.equal(cleanup.confirmed, true);
    assert.equal(cleanup.state, 'confirmed');
    assert.deepEqual({ state: cleanup.state, confirmed: cleanup.confirmed, method: cleanup.method, reason: cleanup.reason }, attempt.cleanup);
    for (const value of [attempt.usage.inputTokens, attempt.usage.outputTokens]) assert.ok(Number.isSafeInteger(value) && value >= 0);
    const part = one(native.parts, () => true);
    assert.equal(part.type, 'text');
    assert.equal(part.state, 'completed');
    assert.equal(part.turnId, attempt.turnId);
    assert.ok(sha(part.sha256));
    assert.equal(recognition.recognition.matched, true);
    assert.equal(recognition.recognition.expectedAbsentFromFullWire, true);
    assert.ok(sha(recognition.recognition.expectedSha256));
    assert.equal(recognition.recognition.observedSha256, recognition.recognition.expectedSha256);
    assert.equal(recognition.recognition.tokenCount, 3);
    const profile = recognition.inputProfile, wire = request.videoProbe;
    for (const proof of [profile, wire]) {
      assert.equal(proof.profile, 'rgb24-128px-v1');
      assert.equal(proof.width, 128); assert.equal(proof.height, 128); assert.equal(proof.frames, 3);
      assert.equal(proof.allPixelsVerified, true);
      assert.ok(sha(proof.sourceSha256));
      assert.deepEqual(proof.timestamps, [0, 500, 1000]);
    }
    assert.equal(wire.sourceSha256, profile.sourceSha256);
    assert.equal(wire.nativeSourceId, profile.nativeSourceId);
    assert.equal(wire.nativeAttachmentSha256, profile.nativeAttachmentSha256);
    assert.ok(sha(profile.nativeAttachmentSha256));
    assert.ok(sha(profile.nativeInputMediaSha256));
    assert.equal(profile.nativeInputMediaSha256, profile.nativeRunMediaSha256);
    assert.equal(recognition.recognition.sourceSha256, profile.sourceSha256);
    assert.equal(recognition.recognition.decoder, 'avi-rgb24-v1');
    assert.deepEqual(recognition.recognition.timestamps, [0, 500, 1000]);
    assert.equal(wire.wireFrames.length, 3);
    wire.wireFrames.forEach((frame, i) => {
      assert.equal(frame.width, 128); assert.equal(frame.height, 128);
      assert.equal(frame.allPixelsVerified, true); assert.equal(frame.crcVerified, true);
      assert.ok(sha(frame.sha256));
      assert.equal(frame.startMs, i * 500); assert.equal(frame.endMs, (i + 1) * 500);
    });
    const codes = { 'invalid-mime': 'MEDIA_INVALID_SOURCE', 'oversize-source': 'MEDIA_LIMIT_EXCEEDED', 'unknown-capability': 'PROVIDER_UNSUPPORTED_INPUT', 'source-loss': 'MEDIA_STORAGE_FAILED' };
    for (const [id, code] of Object.entries(codes)) {
      const item = passedCase(report, id);
      assert.equal(item.modality, 'video'); assert.equal(item.selectedModelId, modelId);
      assert.equal(item.providerId, observed.providerId); assert.equal(item.code, code);
      assert.equal(item.requests, 0); assert.equal(item.attempts, 0);
      assert.equal(item.modelId, id === 'unknown-capability' ? 'undeclared-verification-model' : modelId);
    }
    const duplicate = passedCase(report, 'duplicate-input');
    assert.equal(duplicate.modality, 'video'); assert.equal(duplicate.sameNativeIdentity, true); assert.equal(duplicate.requests, 0);
    for (const field of ['sessionId', 'inputId', 'runId']) assert.equal(duplicate[field], native[field]);
    for (const field of ['inputSha256', 'nativeSha256']) assert.ok(sha(duplicate[field]));
    const restart = passedCase(report, 'restart-paused-import');
    assert.equal(restart.requests, 0); assert.ok(Number.isSafeInteger(restart.sessions) && restart.sessions >= 1);
    return { nativeVerified: true, cleanupConfirmed: true, duplicateNoReplay: true, feature: 'video-frames', sourceSha256: report.sourceFreeze.sha256, runtimeSha256: report.runtimeFreeze.sha256 };
  } catch { fail('PROVIDER_MEDIA_EVIDENCE_INVALID'); }
}

const PROCESS_LIMITS = Object.freeze({ deadlineMs: 90_000, termJoinMs: 1_000, killJoinMs: 1_000 });
/** A killed verifier cannot supply native cleanup or a zero-request claim, even when its process joins. */
export async function executeProviderMediaChild(argv, env, limits = PROCESS_LIMITS, spawnProcess = spawn) {
  if (Object.keys(PROCESS_LIMITS).some(key => !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > PROCESS_LIMITS[key])) fail('PROVIDER_MEDIA_PROCESS_LIMIT_INVALID');
  return new Promise(resolveChild => {
    const child = spawnProcess(process.execPath, [executor, ...argv], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [], timers = []; let total = 0, reason, settled = false, killed = false;
    const parsed = () => { try { return JSON.parse(Buffer.concat(output).toString('utf8')); } catch { return undefined; } };
    const finish = (exitCode, signal, joined) => {
      if (settled) return;
      settled = true; for (const timer of timers) clearTimeout(timer);
      const original = parsed();
      if (reason || signal || !original) {
        resolveChild({ exitCode, report: { ...(original ?? { kind: 'media-account-verification', schemaVersion: 1, actualRequests: [] }),
          state: 'uncertain', passed: false, accountVerified: false, cleanupConfirmed: false,
          failure: reason ?? 'PROVIDER_MEDIA_PROCESS_UNCERTAIN', actualRequestCount: null, actualRequestCountKnown: false,
          subprocessOriginalFailure: original?.failure ?? null,
          subprocessCleanup: { processJoined: joined, forcedTermination: Boolean(reason || signal), sigkillSent: killed, nativeCleanupConfirmed: false },
          evidenceRetention: 'Original verifier temporary evidence was not removed by this wrapper.' } });
        return;
      }
      resolveChild({ report: { ...original, actualRequestCount: original.actualRequests?.length ?? null, actualRequestCountKnown: Array.isArray(original.actualRequests) }, exitCode });
    };
    const terminate = code => {
      if (reason || settled) return;
      reason = code;
      child.kill('SIGTERM');
      timers.push(setTimeout(() => {
        if (settled) return;
        killed = true; child.kill('SIGKILL');
        timers.push(setTimeout(() => {
          // Detach stalled pipes/handles after a bounded join; physical/native cleanup remains unknown.
          finish(null, null, false); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        }, limits.killJoinMs));
      }, limits.termJoinMs));
    };
    timers.push(setTimeout(() => terminate('PROVIDER_MEDIA_PROCESS_DEADLINE'), limits.deadlineMs));
    child.stdout.on('data', bytes => {
      total += bytes.length;
      if (total > 2_097_152) terminate('PROVIDER_MEDIA_PROCESS_OUTPUT_LIMIT');
      else output.push(bytes);
    });
    // The original executor prints bounded structural diagnostics. Never forward arbitrary stderr.
    child.stderr.resume();
    child.on('error', () => { reason ??= 'PROVIDER_MEDIA_PROCESS_FAILED'; finish(null, null, child.pid === undefined); });
    child.on('close', (exitCode, signal) => finish(exitCode, signal, true));
  });
}

/** Credential injection supplies only the child environment; execution/fetch hooks always remain fixture evidence. */
export async function verifyProviderMediaCoverage(options, runtime = {}) {
  const argv = providerMediaCoverageArgs(options), before = hash(await readFile(path));
  const env = { ...process.env };
  if (runtime.apiKey !== undefined) {
    if (typeof runtime.apiKey !== 'string' || !runtime.apiKey.trim() || runtime.apiKey.length > 8192 || /[\u0000-\u0020\u007f]/u.test(runtime.apiKey)) fail('PROVIDER_MEDIA_CREDENTIAL_INVALID');
    env[options.credentialEnv] = runtime.apiKey;
  }
  const fixture = Boolean(runtime.execute || runtime.fixtureEndpoint || hooks());
  if (runtime.fixtureEndpoint) {
    argv.splice(argv.indexOf('--live'), 1);
    argv.push('--fixture-endpoint', runtime.fixtureEndpoint);
  }
  const { report, exitCode } = await (runtime.execute ?? executeProviderMediaChild)(argv, env);
  const unchanged = before === hash(await readFile(path));
  let inspected;
  if (report.passed === true && exitCode !== 0) fail('PROVIDER_MEDIA_PROCESS_UNCERTAIN');
  if (report.passed === true || report.accountVerified === true) inspected = validateMediaCoverageReport(report, options.modelId);
  const accountVerified = report.accountVerified === true && report.transport === 'real-remote' && report.credentialReads === 1 && !fixture && unchanged && exitCode === 0;
  if (report.accountVerified === true && !accountVerified && !fixture) fail('PROVIDER_MEDIA_QUALIFICATION_INVALID');
  const result = { ...report, accountVerified: accountVerified,
    scopeCoverage: report.scopeCoverage?.map(item => ({ ...item, accountVerified: accountVerified && item.accountVerified === true })),
    coverageQualification: { ...inspected, modelId: options.modelId, protocol: 'openai-responses', wireProtocol: 'responses', accountReference: options.accountReference ?? `env:${options.credentialEnv}`,
      wrapperSha256: before, wrapperUnchanged: unchanged, reportSha256: hash(JSON.stringify(report)), fixture, subprocessExitCode: exitCode,
      nativeVideoTransport: false, tokenCost: null } };
  if (!unchanged) { result.state = 'uncertain'; result.passed = false; result.accountVerified = false; result.failure = 'VERIFY_SOURCE_CHANGED'; }
  if (options.reportPath) await writeFile(options.reportPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}
