import type { ProviderAttempt, Run, TurnRecord } from '@moodcode/contracts';
import type { AttemptCleanupRecord } from '../storage/attempt-cleanup.js';

export const PROVIDER_RECOVERY_LIMITS = Object.freeze({ maxCandidates: 64, maxMessages: 512, maxParts: 128, maxTools: 256,
  maxOwnerBytes: 1_048_576, maxEvidenceBytes: 8_388_608, maxLedgerBytes: 65_536, maxContextDocumentBytes: 262_144 });
export interface ProviderRecoveryBudget { bytes: number; max: number }
export interface ProviderRecoveryPin { table: 'messages' | 'context_revisions'; id: string; sha256: string }
export interface ProviderRecoveryRequest { sessionId: string; attemptId: string; requestId: string; fingerprint: string; acknowledged: true }
export interface ProviderRecoveryReceipt {
  version: 1; id: string; requestId: string; sessionId: string; workspaceId: string; runId: string; turnId: string; attemptId: string;
  fingerprint: string; bindingScope: string; acknowledgedAt: string; state: 'uncertain'; cleanupConfirmed: true;
  providerOutcomeConfirmed: false; providerRetried: false; executionResumed: false; checkpointActivated: false; duplicate: boolean;
}
export interface ProviderRecoveryPreview {
  version: 1; status: 'eligible' | 'acknowledged' | 'blocked'; fingerprint: string | null; blockers: string[];
  sessionId: string; workspaceId: string; runId: string; turnId: string; attemptId: string; bindingScope: string;
  requestSha256: string | null; requestBytes: number | null; recordSha256: string | null; cleanupRecordSha256: string | null; usageSha256: string | null;
  sourceSha256: string | null; contextBaselineSha256: string | null; acknowledgment?: ProviderRecoveryReceipt;
}
export interface ProviderRecoveryEvidence {
  run: Run; turn: TurnRecord; attempt: ProviderAttempt; cleanup: AttemptCleanupRecord;
  recordSha256: string; cleanupRecordSha256: string; usageSha256: string | null; sourceSha256: string;
}
