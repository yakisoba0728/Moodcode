import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelSpec } from '../context/model-spec.js';
import { unknownModelSpec } from '../context/model-spec.js';
import { describeProviderCoverage, type ProviderCoverageEvidence } from './coverage.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { ResponsesProvider } from './responses.js';
import type { ProviderAdapter } from '../ports.js';

const modelId = 'exact-model-snapshot';
const spec = (providerId = 'responses'): ModelSpec => ({ providerId, modelId, contextWindow: null, maxOutputTokens: null, modalities: ['text', 'image'],
  inputFileTypes: ['application/pdf'], mediaCapabilities: { audioInput: true, videoFrames: true, audioOutput: true }, tools: null, reasoning: null, nativeReplay: null,
  source: { kind: 'host', observedAt: '2026-10-09T00:00:00.000Z', reference: 'exact-host-declaration' } });
const qualification = { accountReference: 'env:OPENAI_API_KEY', sourceSha256: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64) };
const evidence = (extra: Partial<ProviderCoverageEvidence> = {}): ProviderCoverageEvidence => ({ ...qualification, providerId: 'responses', modelId,
  protocol: 'openai-responses', feature: 'video-frames', observedAt: '2026-10-09T00:00:00.000Z', reportSha256: 'c'.repeat(64), transport: 'real-remote',
  passed: true, nativeVerified: true, cleanupConfirmed: true, duplicateNoReplay: true, ...extra });
const feature = (coverage: ReturnType<typeof describeProviderCoverage>, id: string) => coverage.features.find(item => item.feature === id)!;

test('real adapter exact declarations and ModelSpec must both permit media; a report never grants support', () => {
  const provider = new ResponsesProvider({ id: 'responses', pdfModelIds: [modelId], videoModelIds: [modelId], allowUnknownDocumentTokenCost: true });
  const supported = describeProviderCoverage({ provider, modelSpec: spec(), allowUnknownMediaTokenCost: true, allowUnknownDocumentTokenCost: true, qualification, evidence: [evidence()] });
  assert.equal(feature(supported, 'video-frames').dispatchAllowed, true);
  assert.equal(feature(supported, 'video-frames').accountVerified, true);
  assert.equal(feature(supported, 'pdf-input').dispatchAllowed, true);
  for (const id of ['audio-input', 'audio-output']) assert.equal(feature(supported, id).supported, false);
  const changedModel = describeProviderCoverage({ provider, modelSpec: { ...spec(), modelId: 'another-snapshot' }, allowUnknownMediaTokenCost: true, qualification, evidence: [evidence()] });
  assert.equal(feature(changedModel, 'video-frames').wireSupported, false);
  assert.equal(feature(changedModel, 'video-frames').accountVerified, false);
  assert.deepEqual(feature(changedModel, 'video-frames').evidence, []);
  const unknown = describeProviderCoverage({ provider, modelSpec: unknownModelSpec('responses', modelId), qualification, evidence: [evidence()] });
  assert.equal(feature(unknown, 'video-frames').modelDeclared, null);
  assert.equal(feature(unknown, 'video-frames').supported, false);
  assert.equal(feature(unknown, 'video-frames').accountVerified, false);
  assert.equal(unknown.contextWindow, null);
  assert.equal(unknown.maxOutputTokens, null);
  assert.equal(feature(unknown, 'image-input').modelDeclared, null);
  assert.equal(feature(unknown, 'image-input').supported, false);
  assert.equal(feature(unknown, 'image-input').dispatchAllowed, true);
  const deniedImage = describeProviderCoverage({ provider, modelSpec: { ...spec(), modalities: ['text'] } });
  assert.equal(feature(deniedImage, 'image-input').dispatchAllowed, false);
});

test('custom PDF providers preserve admission with an absent optional exact-model predicate', () => {
  const provider: ProviderAdapter = { id: 'responses', inputFileTypes: ['application/pdf'], allowUnknownDocumentTokenCost: true,
    async *streamTurn() { yield { type: 'finish', reason: 'stop' }; } };
  const coverage = describeProviderCoverage({ provider, modelSpec: spec(), allowUnknownDocumentTokenCost: true });
  assert.equal(feature(coverage, 'pdf-input').wireSupported, true);
  assert.equal(feature(coverage, 'pdf-input').dispatchAllowed, true);
  const explicitDenied = describeProviderCoverage({ provider: { ...provider, supportsInputFile: () => false }, modelSpec: spec(), allowUnknownDocumentTokenCost: true });
  assert.equal(feature(explicitDenied, 'pdf-input').dispatchAllowed, false);
});

test('unknown media and document cost policy is independent of supported wire/model', () => {
  const provider = new ResponsesProvider({ id: 'responses', pdfModelIds: [modelId], videoModelIds: [modelId] });
  const coverage = describeProviderCoverage({ provider, modelSpec: spec() });
  for (const id of ['pdf-input', 'video-frames']) {
    assert.equal(feature(coverage, id).supported, true);
    assert.equal(feature(coverage, id).dispatchAllowed, false);
    assert.equal(feature(coverage, id).tokenCost, null);
  }
  assert.equal(feature(coverage, 'image-input').dispatchAllowed, true);
  const providerOptIn = new ResponsesProvider({ id: 'responses', pdfModelIds: [modelId], allowUnknownDocumentTokenCost: true });
  assert.equal(feature(describeProviderCoverage({ provider: providerOptIn, modelSpec: spec() }), 'pdf-input').dispatchAllowed, false);
  assert.equal(feature(describeProviderCoverage({ provider, modelSpec: spec(), allowUnknownDocumentTokenCost: true }), 'pdf-input').dispatchAllowed, false);
  assert.equal(feature(describeProviderCoverage({ provider: providerOptIn, modelSpec: spec(), allowUnknownDocumentTokenCost: true }), 'pdf-input').dispatchAllowed, true);
  const chat = new OpenAICompatibleProvider({ id: 'chat', audioModelIds: [modelId], outputAudio: { modelIds: [modelId], voice: 'alloy', sampleRate: 24000, channels: 1 } });
  const audio = describeProviderCoverage({ provider: chat, modelSpec: spec('chat'), allowUnknownMediaTokenCost: true });
  for (const id of ['audio-input', 'audio-output']) assert.equal(feature(audio, id).dispatchAllowed, true);
  assert.equal(feature(audio, 'pdf-input').supported, false);
  const proof = evidence({ providerId: 'chat', feature: 'audio-output', protocol: 'openai-chat-completions' });
  const qualified = describeProviderCoverage({ provider: chat, modelSpec: spec('chat'), protocol: 'openai-chat-completions', qualification, evidence: [proof] });
  assert.equal(feature(qualified, 'audio-output').accountVerified, true);
  assert.equal(feature(describeProviderCoverage({ provider: chat, modelSpec: spec('chat'), qualification, evidence: [proof] }), 'audio-output').accountVerified, false);
  assert.throws(() => describeProviderCoverage({ provider, modelSpec: spec(), protocol: 'codex-responses' }),
    (error: unknown) => (error as { code: string }).code === 'INVALID_PROVIDER_COVERAGE');
});

test('account, source, runtime and protocol qualification stay distinct; failed and fixture evidence remains visible', () => {
  const provider = new ResponsesProvider({ id: 'responses', videoModelIds: [modelId] });
  const reports = [evidence(), evidence({ accountReference: 'env:OTHER_ACCOUNT' }), evidence({ sourceSha256: 'd'.repeat(64) }),
    evidence({ runtimeSha256: 'e'.repeat(64) }), evidence({ protocol: 'codex-responses' }), evidence({ passed: false }), evidence({ transport: 'local-fixture' }),
    evidence({ cleanupConfirmed: false }), evidence({ duplicateNoReplay: false }), evidence({ nativeVerified: false })];
  const result = describeProviderCoverage({ provider, modelSpec: spec(), qualification, evidence: reports });
  assert.deepEqual(feature(result, 'video-frames').evidence.map(item => item.state), ['account-verified', 'different-qualification', 'different-qualification',
    'different-qualification', 'different-qualification', 'failed', 'local-fixture', 'unverified', 'unverified', 'unverified']);
  const unqualified = describeProviderCoverage({ provider, modelSpec: spec(), evidence: [evidence()] });
  assert.equal(feature(unqualified, 'video-frames').accountVerified, false);
  assert.equal(feature(unqualified, 'video-frames').evidence[0]!.state, 'different-qualification');
});

test('coverage detaches and freezes metadata/evidence and rejects malformed evidence without changing adapter state', () => {
  const provider = new ResponsesProvider({ id: 'responses', videoModelIds: [modelId] }), metadata = spec(), proof = evidence();
  const result = describeProviderCoverage({ provider, modelSpec: metadata, evidence: [proof], qualification });
  proof.passed = false; metadata.source.reference = 'mutated';
  assert.equal(feature(result, 'video-frames').evidence[0]!.passed, true);
  assert.equal(result.modelSource.reference, 'exact-host-declaration');
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.features)); assert.ok(Object.isFrozen(feature(result, 'video-frames').evidence[0]));
  assert.equal(provider.supportsInputMedia(modelId, 'video'), true);
  for (const extra of [{ runtimeSha256: 'unknown' }, { transport: 'fake-account' }, { duplicateNoReplay: null }]) {
    assert.throws(() => describeProviderCoverage({ provider, modelSpec: spec(), evidence: [evidence(extra as Partial<ProviderCoverageEvidence>)] }),
      (error: unknown) => (error as { code: string }).code === 'INVALID_PROVIDER_COVERAGE');
  }
  assert.throws(() => describeProviderCoverage({ provider, modelSpec: spec(), evidence: [{ ...evidence(), credential: 'synthetic-private-value' } as ProviderCoverageEvidence] }),
    (error: unknown) => (error as { code: string }).code === 'INVALID_PROVIDER_COVERAGE');
  assert.throws(() => describeProviderCoverage({ provider, modelSpec: spec('foreign') }), (error: unknown) => (error as { code: string }).code === 'INVALID_PROVIDER_COVERAGE');
});
