export const TEAM_TABLES = Object.freeze([
  "team_state_revisions",
  "team_state_heads",
  "team_messages",
  "team_mailbox_cursors",
  "team_operation_receipts",
  "team_deliveries",
  "team_delivery_receipts",
] as const);
/** Seven WITHOUT ROWID tables add exactly seven non-internal SQLite catalog entries. */
export const TEAM_SCHEMA_SQL = `
CREATE TABLE team_state_revisions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),team_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('team','member','task')),state_key TEXT NOT NULL,generation INTEGER NOT NULL CHECK(generation>=0),revision INTEGER NOT NULL CHECK(revision>=1),previous_id TEXT REFERENCES team_state_revisions(id),sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),UNIQUE(team_id,kind,state_key,revision)) STRICT, WITHOUT ROWID;
CREATE TABLE team_state_heads(team_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('team','member','task')),state_key TEXT NOT NULL,workspace_id TEXT NOT NULL REFERENCES workspaces(id),revision_id TEXT NOT NULL REFERENCES team_state_revisions(id),generation INTEGER NOT NULL CHECK(generation>=0),revision INTEGER NOT NULL CHECK(revision>=1),sha256 TEXT NOT NULL,PRIMARY KEY(team_id,kind,state_key)) STRICT, WITHOUT ROWID;
CREATE TABLE team_messages(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),team_id TEXT NOT NULL,sender_member_id TEXT NOT NULL,sender_generation INTEGER NOT NULL CHECK(sender_generation>=1),recipient_member_id TEXT NOT NULL,recipient_generation INTEGER NOT NULL CHECK(recipient_generation>=1),seq INTEGER NOT NULL CHECK(seq>=1),bytes INTEGER NOT NULL CHECK(bytes>=0 AND bytes<=4096),request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),UNIQUE(team_id,recipient_member_id,recipient_generation,seq)) STRICT, WITHOUT ROWID;
CREATE TABLE team_mailbox_cursors(workspace_id TEXT NOT NULL REFERENCES workspaces(id),team_id TEXT NOT NULL,member_id TEXT NOT NULL,generation INTEGER NOT NULL CHECK(generation>=1),revision INTEGER NOT NULL CHECK(revision>=1),admitted_seq INTEGER NOT NULL CHECK(admitted_seq>=0),claimed_seq INTEGER NOT NULL CHECK(claimed_seq>=0 AND claimed_seq<=admitted_seq),pending_delivery_id TEXT,data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),PRIMARY KEY(team_id,member_id,generation)) STRICT, WITHOUT ROWID;
CREATE TABLE team_operation_receipts(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),team_id TEXT NOT NULL,actor_id TEXT NOT NULL,actor_generation INTEGER NOT NULL CHECK(actor_generation>=0),request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,operation TEXT NOT NULL,record_id TEXT NOT NULL,record_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),UNIQUE(team_id,actor_id,actor_generation,request_id)) STRICT, WITHOUT ROWID;
CREATE TABLE team_deliveries(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),team_id TEXT NOT NULL,member_id TEXT NOT NULL,generation INTEGER NOT NULL CHECK(generation>=1),request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','delivered','cancelled','uncertain')),revision INTEGER NOT NULL CHECK(revision>=1),data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),UNIQUE(team_id,member_id,generation,request_id)) STRICT, WITHOUT ROWID;
CREATE TABLE team_delivery_receipts(id TEXT PRIMARY KEY REFERENCES team_deliveries(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),team_id TEXT NOT NULL,data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536)) STRICT, WITHOUT ROWID;
`;
