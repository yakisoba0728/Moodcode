export const BACKEND_TABLES = Object.freeze([
  "backend_revisions",
  "backend_heads",
] as const);
/** Immutable native journals. Runtime handles are deliberately absent from persistent storage. */
export const BACKEND_SCHEMA_SQL = `
CREATE TABLE backend_revisions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),kind TEXT NOT NULL CHECK(kind IN ('backend','connection','request','client-effect','transition')),entity_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),previous_id TEXT REFERENCES backend_revisions(id),session_id TEXT REFERENCES sessions(id),run_id TEXT REFERENCES runs(id),turn_id TEXT REFERENCES session_turns(id),attempt_id TEXT REFERENCES provider_attempts(id),tool_id TEXT REFERENCES tools(id),connection_id TEXT,owner_epoch TEXT,request_scope TEXT NOT NULL,request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),sha256 TEXT NOT NULL CHECK(length(sha256)=64),data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),UNIQUE(workspace_id,kind,entity_id,revision),UNIQUE(workspace_id,request_scope,request_id)) STRICT, WITHOUT ROWID;
CREATE TABLE backend_heads(workspace_id TEXT NOT NULL REFERENCES workspaces(id),kind TEXT NOT NULL CHECK(kind IN ('backend','connection','request','client-effect')),entity_id TEXT NOT NULL,revision_id TEXT NOT NULL REFERENCES backend_revisions(id),revision INTEGER NOT NULL CHECK(revision>=1),sha256 TEXT NOT NULL CHECK(length(sha256)=64),PRIMARY KEY(workspace_id,kind,entity_id)) STRICT, WITHOUT ROWID;
`;
