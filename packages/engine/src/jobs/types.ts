import type { TerminalState } from "../terminals/types.js";

/** Checksummed observation data. Only the Root producer's original handles grant access. */
export interface TerminalJobSourceProof {
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly serviceEpoch: string;
  readonly entryBirthNonce: string;
  readonly journalBindingSha256: string;
  readonly launchSha256: string;
  readonly createdAt: string;
  readonly authority: "current-physical" | "retained-current";
  readonly sha256: string;
}
export type TerminalSourcePin = TerminalJobSourceProof;
export interface JobOwnerProof {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly rootBindingSha256: string;
  readonly ownerEpoch: string;
  readonly sourceSha256: string;
  readonly sha256: string;
}
export interface TerminalObservationProof {
  readonly sourceSha256: string;
  readonly state: TerminalState;
  readonly outputSeq: number;
  readonly oldestSeq: number;
  readonly observedBytes: number;
  readonly retainedBytes: number;
  readonly cleanupConfirmed: boolean | null;
  readonly exitCode: number | null;
  readonly reason: string | null;
  readonly updatedAt: string;
  readonly sha256: string;
}
export interface TerminalClosedOutcomeProof {
  readonly sourceSha256: string;
  readonly state: Exclude<TerminalState, "starting" | "running">;
  readonly exitCode: number | null;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly cleanupConfirmed: boolean;
  readonly reason: string | null;
  readonly closedAt: string;
  readonly sha256: string;
}
export interface JobOutputEvent {
  readonly seq: number;
  readonly data: string;
  readonly bytes: number;
}
export interface JobOutputSnapshot {
  readonly version: 1;
  readonly source: TerminalJobSourceProof;
  readonly throughSeq: number;
  readonly oldestSeq: number;
  readonly observedBytes: number;
  readonly retainedBytes: number;
  readonly output: readonly JobOutputEvent[];
  readonly sha256: string;
}
/** eventSeq/byteOffset points to the next byte. The only EOF is throughSeq + 1, offset 0. */
export interface JobOutputCursor {
  readonly version: 1;
  readonly jobId: string;
  readonly jobRevisionId: string;
  readonly sourceSha256: string;
  readonly snapshotSha256: string;
  readonly throughSeq: number;
  readonly eventSeq: number;
  readonly byteOffset: number;
  readonly sha256: string;
}
export interface JobOutputFragment {
  readonly seq: number;
  readonly byteOffset: number;
  readonly data: string;
  readonly bytes: number;
}
export interface JobOutputGap {
  readonly fromSeq: number;
  readonly fromByteOffset: number;
  readonly toSeq: number;
  readonly oldestSeq: number;
}
export interface JobOutputPage {
  readonly version: 1;
  readonly jobId: string;
  readonly jobRevisionId: string;
  readonly sourceSha256: string;
  readonly snapshotSha256: string;
  readonly throughSeq: number;
  readonly fragments: readonly JobOutputFragment[];
  readonly nextCursor: JobOutputCursor;
  readonly gap: JobOutputGap | null;
  readonly hasMore: boolean;
  readonly rawBytes: number;
  readonly sha256: string;
}
export interface ReadJobOutputInput {
  readonly jobId: string;
  readonly jobRevisionId: string;
  readonly cursor?: JobOutputCursor;
  readonly maxBytes?: number;
  readonly maxFragments?: number;
}
export const JOB_LIMITS = Object.freeze({
  metadataBytes: 8192,
  snapshotBytes: 4_194_304,
  retainedBytes: 262_144,
  eventBytes: 16_384,
  snapshotEvents: 262_144,
  pageRawBytes: 8192,
  pageEncodedBytes: 65_536,
  pageFragments: 64,
  idBytes: 256,
  depth: 16,
});
