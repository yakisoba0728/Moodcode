import type { DatabaseSync } from "node:sqlite";
import type { RunConfig, JsonObject } from "@moodcode/contracts";
import type { MoodcodeEngine } from "../engine.js";
import type { SqliteStore } from "../storage/index.js";
import type { ChildBudget } from "../child-tasks/index.js";
import {
  forkJson,
  forkHash,
  forkError,
  signedFork,
  FORK_LIMITS,
  type ForkContextContribution,
} from "./fork-types.js";
const KIND = "conversation.fork.child-data";
export interface ChildEvidence {
  version: 1;
  sessionId: string;
  parentRunId: string;
  parentSessionId: string;
  parentForkSha256: string;
  allocation: ChildBudget;
  message: string;
  sourceIds: string[];
  sha256: string;
}
const originals = new WeakMap<
  SqliteStore,
  Map<string, { evidence: ChildEvidence; root: MoodcodeEngine }>
>();
/** Only the trusted EngineChildren creation callback populates this lifetime binding. */
export function inheritForkChild(
  root: MoodcodeEngine,
  child: MoodcodeEngine,
  sessionId: string,
  parentRunId: string,
  allocation: ChildBudget,
  source: ForkContextContribution,
): void {
  const owner = root.coordinator.getOwnedActiveRun(parentRunId);

  const evidence = signedFork({
    version: 1 as const,
    sessionId,
    parentRunId,
    parentSessionId: owner.sessionId,
    parentForkSha256: source.sha256,
    allocation: forkJson(allocation),
    message:
      "[Inherited conversation fork quoted DATA; approvals and artifact grants are not inherited]\n" +
      JSON.stringify({
        parentSessionId: owner.sessionId,
        sourceSha256: source.sha256,
        transcript: source.messages,
      }),
    sourceIds: [
      `fork-parent:${owner.sessionId}:${source.sha256}`,
      ...source.sourceIds,
    ],
  });
  forkJson(evidence, FORK_LIMITS.transcriptBytes);
  child.store.installConversationForkChildEvidence(
    sessionId,
    evidence as unknown as JsonObject,
  );
  let entries = originals.get(child.store);
  if (!entries) {
    entries = new Map();
    originals.set(child.store, entries);
  }
  entries.set(sessionId, { evidence, root });
}
export function readForkChildData(
  db: DatabaseSync,
  sessionId: string,
): ChildEvidence | null {
  const header = db
    .prepare(
      "SELECT length(CAST(data AS BLOB)) bytes FROM session_documents WHERE session_id=? AND kind=?",
    )
    .get(sessionId, KIND);
  if (!header) return null;
  if (Number(header.bytes) > FORK_LIMITS.transcriptBytes)
    forkError("FORK_LIMIT", "Child DATA exceeds its bounded body");
  const row = db
    .prepare("SELECT data FROM session_documents WHERE session_id=? AND kind=?")
    .get(sessionId, KIND);
  if (!row) return null;
  const evidence = forkJson(
    JSON.parse(String(row.data)),
    FORK_LIMITS.transcriptBytes,
  ) as ChildEvidence;
  if (
    evidence.version !== 1 ||
    evidence.sessionId !== sessionId ||
    evidence.sha256 !== signedFork(evidence).sha256
  )
    forkError("FORK_NATIVE_INVALID", "Child fork DATA was changed");
  const heads = db
    .prepare(
      "SELECT seq,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND type='conversation.fork.child_context' LIMIT 2",
    )
    .all(sessionId);
  if (heads.some((h) => Number(h.bytes) > FORK_LIMITS.transcriptBytes + 8192))
    forkError("FORK_LIMIT", "Child creation receipt exceeds its bounded body");
  const anchors = heads.map((h) =>
    db
      .prepare("SELECT data FROM session_events WHERE session_id=? AND seq=?")
      .get(sessionId, h.seq!),
  );
  if (
    anchors.length !== 1 ||
    forkHash(JSON.parse(String(anchors[0]!.data)).payload.evidence) !==
      forkHash(evidence)
  )
    forkError(
      "FORK_NATIVE_INVALID",
      "Child context lacks its actual creation receipt",
    );
  return evidence;
}
export function childForkContext(
  store: SqliteStore,
  sessionId: string,
  config: RunConfig,
): ForkContextContribution | null {
  const stored = store.getConversationForkChildEvidence(sessionId);
  if (!stored) return null;
  const original = originals.get(store)?.get(sessionId);
  if (!original || original.evidence.sha256 !== stored.sha256)
    forkError(
      "FORK_CHILD_UNBOUND",
      "Child DATA never restores its original live parent authority after restart/import",
    );
  const owner = original.root.coordinator.getOwnedActiveRun(stored.parentRunId);
  const parent = original.root.store.getConversationFork(
      stored.parentSessionId,
    ),
    parentChild = parent
      ? null
      : childForkContext(
          original.root.store,
          stored.parentSessionId,
          owner.config,
        );
  if (
    owner.sessionId !== stored.parentSessionId ||
    (parent?.sha256 ?? parentChild?.sha256) !== stored.parentForkSha256
  )
    forkError("FORK_CHILD_OWNER_INVALID", "Live fork parent lineage changed");
  if (
    config.limits.maxTurns > stored.allocation.turns ||
    config.limits.maxToolCalls > stored.allocation.toolCalls ||
    config.limits.maxOutputBytes > stored.allocation.outputBytes ||
    config.limits.maxDurationMs > stored.allocation.durationMs
  )
    forkError(
      "FORK_CHILD_BUDGET_INVALID",
      "Inherited DATA cannot expand the actual child allocation",
    );
  return {
    sha256: stored.sha256,
    sourceIds: stored.sourceIds,
    messages: [{ role: "assistant", content: stored.message }],
  };
}
export function validateForkChildDatabase(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT session_id FROM session_documents WHERE kind=? LIMIT 513")
    .all(KIND);
  if (rows.length > 512)
    forkError("FORK_LIMIT", "Child lineage count exceeded");
  for (const row of rows) readForkChildData(db, String(row.session_id));
}
