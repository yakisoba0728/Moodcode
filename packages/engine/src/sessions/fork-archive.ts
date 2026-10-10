import type { DatabaseSync } from "node:sqlite";
import type { Session, JsonObject } from "@moodcode/contracts";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import {
  FORK_KIND,
  forkJson,
  forkId,
  forkError,
  signedFork,
  type ConversationFork,
} from "./fork-types.js";
import { assertForkRecordShape, assertFrozenManifest } from "./fork-native.js";
export interface ConversationForkArchive {
  version: 1;
  purpose: "paused-conversation-history";
  record: ConversationFork;
  sha256: string;
}
export interface ForkImportPreview {
  version: 1;
  archive: ConversationForkArchive;
  binding: KnowledgeHostBinding;
  expiresAt: string;
  sha256: string;
}
export function validateForkArchive(value: unknown): ConversationForkArchive {
  const archive = forkJson(value) as ConversationForkArchive;
  if (
    archive.version !== 1 ||
    archive.purpose !== "paused-conversation-history" ||
    archive.sha256 !== signedFork(archive).sha256 ||
    archive.record.sha256 !== signedFork(archive.record).sha256 ||
    archive.record.preview.sha256 !== signedFork(archive.record.preview).sha256
  )
    forkError(
      "FORK_ARCHIVE_INVALID",
      "Fork archive signature or purpose changed",
    );
  assertFrozenManifest(archive.record.preview.source);
  assertForkRecordShape(archive.record, "FORK_ARCHIVE_INVALID");
  forkId(archive.record.sessionId);
  forkId(archive.record.workspaceId);
  return archive;
}
export function importPausedFork(
  db: DatabaseSync,
  preview: ForkImportPreview,
  requestId: string,
  ports: {
    createSession(s: Session): void;
    putDocument(s: string, k: string, r: number, v: JsonObject): void;
    appendEvent(s: string, t: string, v: JsonObject): void;
    pause(s: string): void;
  },
): ConversationFork {
  const archive = validateForkArchive(preview.archive),
    record = archive.record;
  const old = db
    .prepare("SELECT data FROM session_documents WHERE session_id=? AND kind=?")
    .get(record.sessionId, "conversation.fork.import");
  if (old) {
    const marker = JSON.parse(String(old.data));
    if (
      marker.archiveSha256 !== archive.sha256 ||
      marker.requestId !== requestId
    )
      forkError(
        "FORK_REQUEST_CONFLICT",
        "Imported fork history request already differs",
      );
    return record;
  }
  if (db.prepare("SELECT id FROM sessions WHERE id=?").get(record.sessionId))
    forkError(
      "FORK_SESSION_CONFLICT",
      "Historical target Session identity already exists",
    );
  ports.createSession({
    id: record.sessionId,
    workspaceId: preview.binding.workspaceId,
    title: "Imported conversation history (paused)",
    createdAt: new Date().toISOString(),
  });
  const marker = signedFork({
    version: 1,
    kind: "target-only-history",
    paused: true,
    requestId,
    archiveSha256: archive.sha256,
    sourceRecordSha256: record.sha256,
    workspaceId: preview.binding.workspaceId,
    binding: preview.binding,
    approvalFingerprint: preview.sha256,
  });
  ports.putDocument(
    record.sessionId,
    FORK_KIND,
    0,
    record as unknown as JsonObject,
  );
  ports.putDocument(
    record.sessionId,
    "conversation.fork.import",
    0,
    marker as unknown as JsonObject,
  );
  ports.appendEvent(record.sessionId, "conversation.fork.imported", {
    record: record as unknown as JsonObject,
    importProof: marker as unknown as JsonObject,
  });
  ports.pause(record.sessionId);
  return structuredClone(record);
}
