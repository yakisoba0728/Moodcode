import type { DatabaseSync } from "node:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import { EngineError } from "@moodcode/contracts";
import type { KnowledgeHostBinding } from "./types.js";
import type { KnowledgeFilePublicationRecord } from "./file-publication-types.js";
import {
  identifier,
  immutableKnowledgeJson,
  knowledgeHash,
  validateBinding,
} from "./validation.js";
import {
  inspectExecutionLock,
  reconcileStoppedExecutionLock,
  type ExecutionLockMarker,
} from "../tools/command/execution-lock.js";

export const KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE =
  "knowledge_file_execution_guards";
export const KNOWLEDGE_FILE_EXECUTION_GUARD_SCHEMA_SQL = `CREATE TABLE knowledge_file_execution_guards (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), publication_id TEXT NOT NULL,
 lock_path TEXT NOT NULL, marker_owner_pid INTEGER NOT NULL CHECK(marker_owner_pid>0), marker_updated_at TEXT NOT NULL,
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=4096), UNIQUE(workspace_id,publication_id),
 FOREIGN KEY(workspace_id,publication_id) REFERENCES knowledge_file_publications(workspace_id,id)
) STRICT;
CREATE UNIQUE INDEX knowledge_file_execution_guard_marker ON knowledge_file_execution_guards(lock_path,marker_owner_pid,marker_updated_at);`;
interface Guard {
  readonly id: string;
  readonly workspaceId: string;
  readonly publicationId: string;
  readonly binding: KnowledgeHostBinding;
  readonly lock: {
    readonly path: string;
    readonly device: string;
    readonly inode: string;
  };
  readonly marker: ExecutionLockMarker;
  readonly sha256: string;
}
function fail(): never {
  throw new EngineError(
    "KNOWLEDGE_FILE_GUARD_INVALID",
    "File execution guard requires its exact native owner and physical lock",
  );
}
function physical(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    realpathSync(path) !== path
  )
    fail();
  return { path, device: stat.dev.toString(), inode: stat.ino.toString() };
}
function valid(input: unknown): Guard {
  const value = immutableKnowledgeJson(input) as Guard;
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "binding,id,lock,marker,publicationId,sha256,workspaceId" ||
    value.id !== value.publicationId ||
    !value.workspaceId ||
    value.binding.workspaceId !== value.workspaceId
  )
    fail();
  validateBinding(value.binding);
  if (
    Object.keys(value.lock).sort().join(",") !== "device,inode,path" ||
    !value.lock.path.startsWith("/") ||
    !/^\d+$/.test(value.lock.device) ||
    !/^\d+$/.test(value.lock.inode)
  )
    fail();
  if (
    Object.keys(value.marker).sort().join(",") !==
      "active,groupPid,ownerPid,updatedAt" ||
    value.marker.active !== true ||
    value.marker.groupPid !== null ||
    !Number.isSafeInteger(value.marker.ownerPid) ||
    value.marker.ownerPid <= 0 ||
    !Number.isFinite(Date.parse(value.marker.updatedAt))
  )
    fail();
  const { sha256, ...body } = value;
  if (knowledgeHash(body) !== sha256) fail();
  return value;
}
export function validateKnowledgeFileExecutionGuards(
  db: DatabaseSync,
  check: () => void = () => {},
): void {
  for (const header of db
    .prepare(
      `SELECT id,workspace_id,publication_id,lock_path,marker_owner_pid,marker_updated_at,length(CAST(data AS BLOB)) AS bytes FROM ${KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE} ORDER BY id`,
    )
    .iterate()) {
    check();
    if (Number(header.bytes) > 4096) fail();
    const row = db
      .prepare(
        `SELECT data FROM ${KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE} WHERE id=?`,
      )
      .get(String(header.id));
    const guard = valid(JSON.parse(String(row?.data)));
    if (
      guard.id !== header.id ||
      guard.workspaceId !== header.workspace_id ||
      guard.publicationId !== header.publication_id ||
      guard.lock.path !== header.lock_path ||
      guard.marker.ownerPid !== header.marker_owner_pid ||
      guard.marker.updatedAt !== header.marker_updated_at
    )
      fail();
    const owner = db
      .prepare(
        "SELECT workspace_id,json_extract(data,'$.binding') AS binding FROM knowledge_file_publications WHERE id=?",
      )
      .get(guard.publicationId);
    if (
      !owner ||
      owner.workspace_id !== guard.workspaceId ||
      knowledgeHash(JSON.parse(String(owner.binding))) !==
        knowledgeHash(guard.binding)
    )
      fail();
  }
}
export class KnowledgeFileExecutionGuards {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ports: {
      writeTx<T>(operation: () => T): T;
      checkBinding(workspaceId: string): KnowledgeHostBinding;
      getOwner(workspaceId: string, id: string): KnowledgeFilePublicationRecord;
    },
  ) {}
  reserve(
    inputBinding: KnowledgeHostBinding,
    publicationId: string,
    path: string,
    inputMarker: Readonly<ExecutionLockMarker>,
  ): void {
    const binding = validateBinding(inputBinding),
      marker = immutableKnowledgeJson(inputMarker);
    identifier(publicationId);
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.includes("\0")
    )
      fail();
    this.ports.writeTx(() => {
      const owner = this.ports.getOwner(binding.workspaceId, publicationId);
      if (
        owner.state !== "prepared" ||
        knowledgeHash(owner.binding) !== knowledgeHash(binding) ||
        knowledgeHash(this.ports.checkBinding(binding.workspaceId)) !==
          knowledgeHash(binding)
      )
        fail();
      const body = {
        id: publicationId,
        workspaceId: binding.workspaceId,
        publicationId,
        binding,
        lock: physical(path),
        marker,
      };
      const guard = valid({ ...body, sha256: knowledgeHash(body) });
      this.db
        .prepare(
          `INSERT INTO ${KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE}(id,workspace_id,publication_id,lock_path,marker_owner_pid,marker_updated_at,data) VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          guard.id,
          guard.workspaceId,
          guard.publicationId,
          path,
          marker.ownerPid,
          marker.updatedAt,
          JSON.stringify(guard),
        );
    });
  }
  matching(path: string, workspaceId?: string): Guard | undefined {
    const inspection = inspectExecutionLock(path);
    if (inspection.status !== "uncertain") return undefined;
    const headers = this.db
      .prepare(
        `SELECT id,workspace_id,publication_id,lock_path,marker_owner_pid,marker_updated_at,length(CAST(data AS BLOB)) AS bytes FROM ${KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE} WHERE marker_updated_at=? AND marker_owner_pid=? AND lock_path=? LIMIT 2`,
      )
      .all(inspection.marker.updatedAt, inspection.marker.ownerPid, path);
    if (headers.length > 1) fail();
    for (const row of headers) {
      if (workspaceId !== undefined && row.workspace_id !== workspaceId)
        continue;
      if (Number(row.bytes) > 4096) fail();
      const guard = valid(
        JSON.parse(
          String(
            this.db
              .prepare(
                `SELECT data FROM ${KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE} WHERE id=?`,
              )
              .get(String(row.id))?.data,
          ),
        ),
      );
      if (
        guard.id !== row.id ||
        guard.workspaceId !== row.workspace_id ||
        guard.publicationId !== row.publication_id ||
        guard.lock.path !== row.lock_path ||
        guard.marker.ownerPid !== row.marker_owner_pid ||
        guard.marker.updatedAt !== row.marker_updated_at
      )
        fail();
      if (
        knowledgeHash(guard.marker) !== knowledgeHash(inspection.marker) ||
        knowledgeHash(guard.lock) !== knowledgeHash(physical(path))
      )
        continue;
      const owner = this.ports.getOwner(guard.workspaceId, guard.publicationId);
      if (
        !["prepared", "dispatched", "uncertain", "cancelled"].includes(
          owner.state,
        ) ||
        knowledgeHash(guard.binding) !==
          knowledgeHash(this.ports.checkBinding(guard.workspaceId)) ||
        knowledgeHash(owner.binding) !== knowledgeHash(guard.binding)
      )
        fail();
      return guard;
    }
    return undefined;
  }
  reconcile(workspaceId: string, path: string): void {
    const current = inspectExecutionLock(path);
    if (current.status === "available" || current.status === "not_initialized")
      return;
    const guard = this.matching(path, workspaceId);
    if (!guard) fail();
    reconcileStoppedExecutionLock(path, guard.marker);
  }
}
