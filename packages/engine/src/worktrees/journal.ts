import { join } from "node:path";
import type { JsonObject } from "@moodcode/contracts";
import type { ManagedWorktree } from "./index.js";

export const WORKTREE_STATES = [
  "creating",
  "booting",
  "ready",
  "failed",
  "cleaning",
  "removed",
  "uncertain",
] as const;
export const WORKTREE_JOURNAL = Object.freeze({
  kind: "engine.worktrees",
  maxRecords: 128,
  maxBytes: 200 * 1024,
});
export interface ArchivedWorktreeMapping {
  readonly fromArtifacts: string;
  readonly toArtifacts: string;
  readonly archiveId: string;
  readonly manifestSha256: string;
}
/** Rebinds default-owned roots to the imported artifact tree; records not removed become uncertain with unverified ownership. */
export function relocateArchivedWorktreeJournal(
  data: JsonObject,
  sessionId: string,
  mapping: ArchivedWorktreeMapping,
  fail: (message: string) => never,
): { data: JsonObject; relocated: number } {
  const records = data.records;
  if (
    data.schemaVersion !== 1 ||
    !Array.isArray(records) ||
    records.length > WORKTREE_JOURNAL.maxRecords
  )
    fail("Archived worktree journal is invalid");
  const relocated = records.map((value) => {
    const record = value as unknown as ManagedWorktree;
    if (
      !record ||
      record.sessionId !== sessionId ||
      !/^worktree_[a-f0-9]{32}$/u.test(record.id) ||
      record.root !==
        join(mapping.fromArtifacts, "children", "worktrees", record.id) ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 1 ||
      record.revision >= Number.MAX_SAFE_INTEGER
    )
      fail(
        "Archived worktree path cannot be mapped to the default owned artifact tree",
      );
    return {
      ...record,
      root: join(mapping.toArtifacts, "children", "worktrees", record.id),
      revision: record.revision + 1,
      state: record.state === "removed" ? "removed" : "uncertain",
      errorCode: "WORKTREE_ARCHIVE_RELOCATION",
      relocation: {
        archiveId: mapping.archiveId,
        manifestSha256: mapping.manifestSha256,
        originalRoot: record.root,
        ownershipVerified: false,
      },
    } as unknown as JsonObject;
  });
  return { data: { ...data, records: relocated }, relocated: relocated.length };
}
