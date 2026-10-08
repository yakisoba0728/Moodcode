import type {
  SessionSnapshot,
  Run,
  MessagePart,
  TurnRecord,
  ProviderAttempt,
  Checkpoint,
} from "@moodcode/contracts";
import type { VerificationSnapshot } from "../verification/types.js";
import type { AttemptCleanupRecord } from "../storage/attempt-cleanup.js";
/** Issued only by the private real child after the native Run terminal boundary and before close. */
export interface WorkflowChildEvidence {
  readonly version: 1;
  readonly run: Run;
  readonly snapshot: SessionSnapshot;
  readonly turns: readonly TurnRecord[];
  readonly attempts: readonly ProviderAttempt[];
  readonly checkpoints: readonly Checkpoint[];
  readonly parts: readonly MessagePart[];
  readonly cleanups: readonly AttemptCleanupRecord[];
  readonly verification: VerificationSnapshot | null;
  readonly sha256: string;
}
