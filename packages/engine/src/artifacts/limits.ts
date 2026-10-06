import { number, positive } from './validation.js';

export interface ArtifactLimits {
  maxProducerBytes: number;
  maxArtifactBytes: number;
  maxModelBytes: number;
  maxDisplayBytes: number;
  maxStructuredBytes: number;
  maxMetadataBytes: number;
  maxReadBytes: number;
  maxScanEntries: number;
  maxProducerChunks: number;
}
export const DEFAULT_ARTIFACT_LIMITS: Readonly<ArtifactLimits> = Object.freeze({
  maxProducerBytes: 16 * 1024 * 1024, maxArtifactBytes: 8 * 1024 * 1024,
  maxModelBytes: 32 * 1024, maxDisplayBytes: 64 * 1024, maxStructuredBytes: 128 * 1024,
  maxMetadataBytes: 32 * 1024, maxReadBytes: 64 * 1024, maxScanEntries: 10_000, maxProducerChunks: 10_000,
});
const CEILINGS: Readonly<ArtifactLimits> = Object.freeze({
  maxProducerBytes: 64 * 1024 * 1024, maxArtifactBytes: 64 * 1024 * 1024,
  maxModelBytes: 1024 * 1024, maxDisplayBytes: 4 * 1024 * 1024,
  maxStructuredBytes: 4 * 1024 * 1024, maxMetadataBytes: 1024 * 1024,
  maxReadBytes: 4 * 1024 * 1024, maxScanEntries: 100_000, maxProducerChunks: 100_000,
});
export const DEFAULT_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export function artifactLimits(input: Partial<ArtifactLimits> = {}): ArtifactLimits {
  const result = { ...DEFAULT_ARTIFACT_LIMITS };
  for (const key of Object.keys(result) as (keyof ArtifactLimits)[]) {
    const value = input[key] ?? result[key];
    result[key] = key === 'maxProducerBytes' || key === 'maxArtifactBytes' || key === 'maxModelBytes' || key === 'maxDisplayBytes'
      ? number(value, key, CEILINGS[key]) : positive(value, key, CEILINGS[key]);
  }
  return result;
}
