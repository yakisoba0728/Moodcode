import { EngineError } from '@moodcode/contracts';
import { ModelRegistry, type ModelSpec } from '../context/model-spec.js';
import { jobJson } from '../jobs/validation.js';
import type { ProviderAdapter } from '../ports.js';

export const PROVIDER_COVERAGE_FEATURES = Object.freeze(['image-input', 'pdf-input', 'audio-input', 'video-frames', 'audio-output'] as const);
export type ProviderCoverageFeature = typeof PROVIDER_COVERAGE_FEATURES[number];
export interface ProviderCoverageQualification {
  accountReference: string;
  sourceSha256: string;
  runtimeSha256: string;
}
/** Supplied by a verifier that inspected original native records; declarations alone are not evidence. */
export interface ProviderCoverageEvidence extends ProviderCoverageQualification {
  providerId: string;
  modelId: string;
  protocol: string;
  feature: ProviderCoverageFeature;
  observedAt: string;
  reportSha256: string;
  transport: 'real-remote' | 'local-fixture' | 'none';
  passed: boolean;
  nativeVerified: boolean;
  cleanupConfirmed: boolean;
  duplicateNoReplay: boolean;
}
export interface ProviderCoverageOptions {
  provider: ProviderAdapter;
  modelSpec: ModelSpec;
  /** Host transport identity for adapters without an opaque replay protocol. */
  protocol?: string;
  allowUnknownMediaTokenCost?: boolean;
  allowUnknownDocumentTokenCost?: boolean;
  qualification?: ProviderCoverageQualification;
  evidence?: readonly ProviderCoverageEvidence[];
}
export interface ProviderCoverageVerification extends ProviderCoverageEvidence {
  state: 'account-verified' | 'local-fixture' | 'different-qualification' | 'failed' | 'unverified';
}
export interface ProviderFeatureCoverage {
  feature: ProviderCoverageFeature;
  wireSupported: boolean;
  modelDeclared: boolean | null;
  supported: boolean;
  unknownTokenCostAllowed: boolean | null;
  dispatchAllowed: boolean;
  tokenCost: null;
  accountVerified: boolean;
  evidence: readonly ProviderCoverageVerification[];
}
export interface ProviderCoverage {
  providerId: string;
  modelId: string;
  protocol: string | null;
  modelSource: ModelSpec['source'];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  features: readonly ProviderFeatureCoverage[];
}

const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function reference(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function invalid(): never { throw new EngineError('INVALID_PROVIDER_COVERAGE', 'Provider coverage requires bounded exact qualification and evidence'); }
function qualification(value: ProviderCoverageQualification): void {
  if (!reference(value.accountReference) || !sha(value.sourceSha256) || !sha(value.runtimeSha256)) invalid();
}
function evidence(values: readonly ProviderCoverageEvidence[]): ProviderCoverageEvidence[] {
  const copies = jobJson(values, 65_536);
  if (!Array.isArray(copies) || copies.length > 128) invalid();
  for (const entry of copies) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid();
    const item = entry as unknown as ProviderCoverageEvidence;
    if (Object.keys(item).sort().join(',') !== ['accountReference', 'sourceSha256', 'runtimeSha256', 'providerId', 'modelId', 'protocol', 'feature', 'observedAt', 'reportSha256',
      'transport', 'passed', 'nativeVerified', 'cleanupConfirmed', 'duplicateNoReplay'].sort().join(',')) invalid();
    qualification(item);
    if (!reference(item.providerId) || !reference(item.modelId) || !reference(item.protocol) || !sha(item.reportSha256)
      || !PROVIDER_COVERAGE_FEATURES.includes(item.feature) || !Number.isFinite(Date.parse(item.observedAt))
      || !['real-remote', 'local-fixture', 'none'].includes(item.transport)
      || [item.passed, item.nativeVerified, item.cleanupConfirmed, item.duplicateNoReplay].some(flag => typeof flag !== 'boolean')) invalid();
  }
  return copies as unknown as ProviderCoverageEvidence[];
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function declared(flag: boolean | undefined | null): boolean | null { return flag === undefined ? null : flag; }

/** Read-only admission presentation. Unknown image metadata is permitted by the existing image contract. */
export function describeProviderCoverage(options: ProviderCoverageOptions): ProviderCoverage {
  const spec = new ModelRegistry().put(options.modelSpec), provider = options.provider;
  if (provider.id !== spec.providerId || [options.allowUnknownMediaTokenCost, options.allowUnknownDocumentTokenCost].some(value => value !== undefined && typeof value !== 'boolean')) invalid();
  const current = options.qualification ? jobJson(options.qualification, 4096) as unknown as ProviderCoverageQualification : undefined;
  if (current) qualification(current);
  if (options.protocol !== undefined && (!reference(options.protocol) || provider.replayProtocol !== undefined && options.protocol !== provider.replayProtocol)) invalid();
  const reports = evidence(options.evidence ?? []), protocol = options.protocol ?? provider.replayProtocol ?? null;
  const definitions: [ProviderCoverageFeature, boolean, boolean | null, boolean | null][] = [
    ['image-input', provider.inputModalities?.includes('image') === true, spec.modalities === null ? null : spec.modalities.includes('image'), null],
    ['pdf-input', provider.inputFileTypes?.includes('application/pdf') === true && provider.supportsInputFile?.(spec.modelId, 'application/pdf') !== false,
      spec.inputFileTypes == null ? null : spec.inputFileTypes.includes('application/pdf'), provider.allowUnknownDocumentTokenCost === true && options.allowUnknownDocumentTokenCost === true],
    ['audio-input', provider.supportsInputMedia?.(spec.modelId, 'audio') === true, declared(spec.mediaCapabilities?.audioInput), options.allowUnknownMediaTokenCost === true],
    ['video-frames', provider.supportsInputMedia?.(spec.modelId, 'video') === true, declared(spec.mediaCapabilities?.videoFrames), options.allowUnknownMediaTokenCost === true],
    ['audio-output', provider.requestedOutputMedia?.(spec.modelId) === 'audio/wav', declared(spec.mediaCapabilities?.audioOutput), options.allowUnknownMediaTokenCost === true],
  ];
  return freeze({ providerId: spec.providerId, modelId: spec.modelId, protocol, modelSource: spec.source,
    contextWindow: spec.contextWindow, maxOutputTokens: spec.maxOutputTokens,
    features: definitions.map(([feature, wireSupported, modelDeclared, unknownTokenCostAllowed]) => {
      const supported = wireSupported && modelDeclared === true;
      const items = reports.filter(item => item.providerId === provider.id && item.modelId === spec.modelId && item.feature === feature).map(item => {
        const complete = item.passed && item.nativeVerified && item.cleanupConfirmed && item.duplicateNoReplay;
        const matching = current && item.protocol === protocol && item.accountReference === current.accountReference
          && item.sourceSha256 === current.sourceSha256 && item.runtimeSha256 === current.runtimeSha256;
        const state: ProviderCoverageVerification['state'] = !item.passed ? 'failed' : item.transport === 'local-fixture' ? 'local-fixture'
          : !complete || item.transport !== 'real-remote' ? 'unverified' : !matching ? 'different-qualification' : 'account-verified';
        return { ...item, state };
      });
      const admitted = wireSupported && (feature === 'image-input' ? modelDeclared !== false : modelDeclared === true);
      return { feature, wireSupported, modelDeclared, supported, unknownTokenCostAllowed, dispatchAllowed: admitted && unknownTokenCostAllowed !== false,
        tokenCost: null, accountVerified: supported && items.some(item => item.state === 'account-verified'), evidence: items };
    }) });
}
