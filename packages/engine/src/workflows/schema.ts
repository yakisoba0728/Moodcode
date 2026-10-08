export const WORKFLOW_TABLES = Object.freeze([
  "workflow_revisions",
  "workflow_heads",
] as const);
/** Two native WITHOUT ROWID tables add exactly two catalog entries. */
export const WORKFLOW_SCHEMA_SQL = `
CREATE TABLE workflow_revisions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),kind TEXT NOT NULL CHECK(kind IN ('spec','instance','stage','transition')),entity_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),previous_id TEXT REFERENCES workflow_revisions(id),root_session_id TEXT REFERENCES sessions(id),root_run_id TEXT REFERENCES runs(id),owner_sha256 TEXT,request_scope TEXT NOT NULL,request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=131072),UNIQUE(workspace_id,kind,entity_id,revision),UNIQUE(workspace_id,request_scope,request_id)) STRICT, WITHOUT ROWID;
CREATE TABLE workflow_heads(workspace_id TEXT NOT NULL REFERENCES workspaces(id),kind TEXT NOT NULL CHECK(kind IN ('spec','instance','stage')),entity_id TEXT NOT NULL,revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),revision INTEGER NOT NULL CHECK(revision>=1),sha256 TEXT NOT NULL,PRIMARY KEY(workspace_id,kind,entity_id)) STRICT, WITHOUT ROWID;
`;
