export const SCHEDULE_TABLES = Object.freeze([
  "schedule_revisions",
  "schedule_heads",
] as const);
/** Two typed immutable journals, no implicit timer or dispatch queue. */
export const SCHEDULE_SCHEMA_SQL = `
CREATE TABLE schedule_revisions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),kind TEXT NOT NULL CHECK(kind IN ('schedule','lease','occurrence','transition')),entity_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),previous_id TEXT REFERENCES schedule_revisions(id),session_id TEXT REFERENCES sessions(id),input_id TEXT REFERENCES session_inputs(id),run_id TEXT REFERENCES runs(id),owner_epoch TEXT,request_scope TEXT NOT NULL,request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=131072),UNIQUE(workspace_id,kind,entity_id,revision),UNIQUE(workspace_id,request_scope,request_id)) STRICT, WITHOUT ROWID;
CREATE TABLE schedule_heads(workspace_id TEXT NOT NULL REFERENCES workspaces(id),kind TEXT NOT NULL CHECK(kind IN ('schedule','lease','occurrence')),entity_id TEXT NOT NULL,revision_id TEXT NOT NULL REFERENCES schedule_revisions(id),revision INTEGER NOT NULL CHECK(revision>=1),sha256 TEXT NOT NULL,PRIMARY KEY(workspace_id,kind,entity_id)) STRICT, WITHOUT ROWID;
`;
