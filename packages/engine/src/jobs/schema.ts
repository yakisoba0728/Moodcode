export const JOB_TABLES = Object.freeze([
  "job_revisions",
  "job_heads",
] as const);
/** Immutable primary history; a journal row never restores a live PTY handle. */
export const JOB_SCHEMA_SQL = `
CREATE TABLE job_revisions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),kind TEXT NOT NULL CHECK(kind IN ('job','output','delivery','transition')),entity_id TEXT NOT NULL,job_id TEXT NOT NULL,created_at TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),previous_id TEXT REFERENCES job_revisions(id),session_id TEXT NOT NULL REFERENCES sessions(id),terminal_id TEXT NOT NULL,source_sha256 TEXT NOT NULL,owner_epoch TEXT NOT NULL,input_id TEXT REFERENCES session_inputs(id),request_scope TEXT NOT NULL,request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),UNIQUE(workspace_id,kind,entity_id,revision),UNIQUE(workspace_id,request_scope,request_id)) STRICT, WITHOUT ROWID;
CREATE TABLE job_heads(workspace_id TEXT NOT NULL REFERENCES workspaces(id),kind TEXT NOT NULL CHECK(kind IN ('job','output','delivery')),entity_id TEXT NOT NULL,revision_id TEXT NOT NULL REFERENCES job_revisions(id),revision INTEGER NOT NULL CHECK(revision>=1),sha256 TEXT NOT NULL,PRIMARY KEY(workspace_id,kind,entity_id)) STRICT, WITHOUT ROWID;
`;
