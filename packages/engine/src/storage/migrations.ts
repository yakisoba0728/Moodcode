import { DatabaseSync } from 'node:sqlite';
import { EngineError } from '@moodcode/contracts';
import { inspectIntegrity } from './maintenance.js';
import { migrateNativeSessions } from './native-schema.js';
import { ATTEMPT_USAGE_SCHEMA } from './native-usage.js';
import { SUMMARY_ATTEMPT_SCHEMA } from './summary-attempts.js';
import { SUMMARY_RECOVERY_SCHEMA, SUMMARY_RECOVERY_PROOF_SCHEMA } from '../recovery/summary.js';
import { ATTEMPT_CLEANUP_SCHEMA } from './attempt-cleanup.js';
import { PROVIDER_RECOVERY_SCHEMA } from '../recovery/provider.js';
import { MCP_EXECUTION_SCHEMA } from './mcp-executions.js';
import { KNOWLEDGE_SCHEMA_SQL } from '../knowledge/store.js';
import { KNOWLEDGE_GENERATION_SCHEMA_SQL } from '../knowledge/generation-store.js';
import { KNOWLEDGE_PUBLICATION_SCHEMA_SQL } from '../knowledge/publication-store.js';
import { KNOWLEDGE_FILE_PUBLICATION_SCHEMA_SQL } from '../knowledge/file-publication-store.js';
import { KNOWLEDGE_FILE_EXECUTION_GUARD_SCHEMA_SQL } from '../knowledge/file-execution-guards.js';
import { DIAGNOSTIC_EXECUTION_OBSERVATION_SCHEMA_SQL } from '../diagnostics/execution-observation-store.js';
import { KNOWLEDGE_IMPORT_RECOVERY_SCHEMA_SQL } from '../knowledge/import-recovery-store.js';
import { PROPOSAL_SCHEMA_SQL } from '../proposals/store.js';
import { PROPOSAL_APPLY_SCHEMA_SQL } from '../proposals/apply-store.js';
import { PROPOSAL_APPLY_GUARD_SCHEMA_SQL } from '../proposals/execution-guards.js';
import { TEAM_SCHEMA_SQL } from '../teams/schema.js';
import { WORKFLOW_SCHEMA_SQL } from '../workflows/schema.js';
import { SCHEDULE_SCHEMA_SQL } from '../schedules/schema.js';

export interface DatabaseMigration {
  /** Append-only, consecutive primary database version, starting at 1. */
  readonly version: number;
  readonly name: string;
  /** Synchronous SQL/data changes only; the framework owns the transaction and user_version. */
  readonly apply: (database: DatabaseSync) => void;
}

const INITIAL_SCHEMA = `
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, data TEXT NOT NULL) STRICT;
  CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), last_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_seq >= 0), data TEXT NOT NULL) STRICT;
  CREATE TABLE inputs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, admitted_seq INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(session_id, request_id)) STRICT;
  CREATE TABLE runs (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, input_id TEXT NOT NULL UNIQUE REFERENCES inputs(id), session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), state TEXT NOT NULL CHECK(state IN ('created','running','awaiting_approval','cancelling','completed','cancelled','failed','interrupted')), data TEXT NOT NULL) STRICT;
  CREATE UNIQUE INDEX one_active_run_per_workspace ON runs(workspace_id) WHERE state IN ('created','running','awaiting_approval','cancelling');
  CREATE TABLE messages (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL) STRICT;
  CREATE TABLE tools (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id), state TEXT NOT NULL, data TEXT NOT NULL) STRICT;
  CREATE TABLE approvals (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id), tool_call_id TEXT NOT NULL REFERENCES tools(id), status TEXT NOT NULL, data TEXT NOT NULL) STRICT;
  CREATE TABLE checkpoints (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL REFERENCES runs(id), tool_call_id TEXT NOT NULL REFERENCES tools(id), data TEXT NOT NULL) STRICT;
  CREATE TABLE events (session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL CHECK(seq > 0), event_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL REFERENCES runs(id), type TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id, seq)) STRICT;
  CREATE INDEX runs_session ON runs(session_id, ordinal);
  CREATE INDEX messages_session ON messages(session_id, ordinal);
  CREATE INDEX tools_session ON tools(session_id, ordinal);
  CREATE INDEX approvals_session ON approvals(session_id, ordinal);
  CREATE INDEX checkpoints_run ON checkpoints(run_id, ordinal);
`;

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = Object.freeze([
  Object.freeze({ version: 1, name: 'initial-engine-records', apply: (database: DatabaseSync) => { database.exec(INITIAL_SCHEMA); } }),
  Object.freeze({ version: 2, name: 'session-inbox-and-execution-records', apply: migrateNativeSessions }),
  Object.freeze({ version: 3, name: 'durable-provider-attempt-usage', apply: (database: DatabaseSync) => {
    database.exec(ATTEMPT_USAGE_SCHEMA);
    database.exec("CREATE INDEX model_messages_role ON messages(run_id,json_extract(data,'$.role'),ordinal)");
  } }),
  Object.freeze({ version: 4, name: 'durable-summary-attempts-and-image-anchor', apply: (database: DatabaseSync) => {
    database.exec(SUMMARY_ATTEMPT_SCHEMA);
    database.exec("CREATE INDEX model_session_latest_image ON messages(session_id,ordinal DESC) WHERE json_extract(data,'$.role')='user' AND json_type(data,'$.attachments')='array' AND json_array_length(data,'$.attachments')>0");
  } }),
  Object.freeze({ version: 5, name: 'explicit-summary-recovery-acknowledgments', apply: (database: DatabaseSync) => {
    database.exec("CREATE INDEX summary_workspace_uncertain ON summary_attempts(workspace_id) WHERE state='uncertain'");
    database.exec(SUMMARY_RECOVERY_SCHEMA);
  } }),
  Object.freeze({ version: 6, name: 'durable-provider-cleanup-observations', apply: (database: DatabaseSync) => {
    database.exec(ATTEMPT_CLEANUP_SCHEMA);
    database.exec("CREATE INDEX ordinary_workspace_uncertain ON runs(workspace_id,id); CREATE INDEX ordinary_uncertain_turns ON session_turns(run_id) WHERE state='uncertain'; CREATE INDEX ordinary_uncertain_attempts ON provider_attempts(run_id) WHERE state='uncertain'");
  } }),
  Object.freeze({ version: 7, name: 'explicit-provider-outcome-recovery', apply: (database: DatabaseSync) => {
    database.exec(PROVIDER_RECOVERY_SCHEMA);
    database.exec(SUMMARY_RECOVERY_PROOF_SCHEMA);
  } }),
  Object.freeze({ version: 8, name: 'bounded-session-document-anchor', apply: (database: DatabaseSync) => {
    database.exec("CREATE INDEX model_session_latest_document ON messages(session_id,ordinal DESC) WHERE json_extract(data,'$.role')='user' AND json_type(data,'$.documents')='array' AND json_array_length(data,'$.documents')>0");
  } }),
  Object.freeze({ version: 9, name: 'durable-mcp-tools-call-execution', apply: (database: DatabaseSync) => { database.exec(MCP_EXECUTION_SCHEMA); } }),
  Object.freeze({ version: 10, name: 'workspace-trust-and-pending-knowledge', apply: (database: DatabaseSync) => { database.exec(KNOWLEDGE_SCHEMA_SQL); } }),
  Object.freeze({ version: 11, name: 'native-host-knowledge-generation', apply: (database: DatabaseSync) => { database.exec(KNOWLEDGE_GENERATION_SCHEMA_SQL); } }),
  Object.freeze({ version: 12, name: 'workspace-knowledge-publication-cas', apply: (database: DatabaseSync) => { database.exec(KNOWLEDGE_PUBLICATION_SCHEMA_SQL); } }),
  Object.freeze({ version: 13, name: 'native-physical-knowledge-publication', apply: (database: DatabaseSync) => {
    database.exec('CREATE UNIQUE INDEX knowledge_candidate_workspace_identity ON knowledge_candidates(workspace_id,id)');
    database.exec(KNOWLEDGE_FILE_PUBLICATION_SCHEMA_SQL); database.exec(KNOWLEDGE_FILE_EXECUTION_GUARD_SCHEMA_SQL);
  } }),
  Object.freeze({ version: 14, name: 'native-execution-source-observations', apply: (database: DatabaseSync) => { database.exec(DIAGNOSTIC_EXECUTION_OBSERVATION_SCHEMA_SQL); } }),
  Object.freeze({ version: 15, name: 'explicit-imported-knowledge-recovery', apply: (database: DatabaseSync) => { database.exec(KNOWLEDGE_IMPORT_RECOVERY_SCHEMA_SQL); } }),
  Object.freeze({ version: 16, name: 'native-pending-proposal-artifacts', apply: (database: DatabaseSync) => { database.exec(PROPOSAL_SCHEMA_SQL); } }),
  Object.freeze({ version: 17, name: 'native-approved-proposal-effects', apply: (database: DatabaseSync) => { database.exec(PROPOSAL_APPLY_SCHEMA_SQL); database.exec(PROPOSAL_APPLY_GUARD_SCHEMA_SQL); } }),
  Object.freeze({ version: 18, name: 'native-team-mailbox-and-task-board', apply: (database: DatabaseSync) => { database.exec(TEAM_SCHEMA_SQL); } }),
  Object.freeze({ version: 19, name: 'native-workflow-revisions-and-heads', apply: (database: DatabaseSync) => { database.exec(WORKFLOW_SCHEMA_SQL); } }),
  Object.freeze({ version: 20, name: 'native-schedules-and-occurrence-admission', apply: (database: DatabaseSync) => { database.exec(SCHEDULE_SCHEMA_SQL); } }),
]);
export const DB_VERSION = DATABASE_MIGRATIONS.length;

/** Read before changing connection pragmas, especially for a database from a newer engine. */
export function databaseVersion(database: DatabaseSync, maximum = DB_VERSION): number {
  const version = Number(database.prepare('PRAGMA user_version').get()?.user_version);
  if (!Number.isSafeInteger(version) || version < 0 || version > maximum) {
    throw new EngineError('DB_VERSION_UNSUPPORTED', `Database version ${version} is unsupported (maximum ${maximum})`);
  }
  return version;
}

function validatePlan(migrations: readonly DatabaseMigration[]): void {
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1 || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(migration.name) || typeof migration.apply !== 'function') {
      throw new EngineError('DB_MIGRATION_PLAN_INVALID', 'Database migrations must have consecutive versions and bounded names');
    }
  }
}

/**
 * Apply the complete pending chain in one transaction. Any failed migration or
 * integrity check rolls back every pending change, including all version updates.
 * Existing records and secondary review/recovery databases are not rewritten.
 */
export function migrateDatabase(database: DatabaseSync, migrations: readonly DatabaseMigration[] = DATABASE_MIGRATIONS): void {
  validatePlan(migrations);
  const targetVersion = migrations.length;
  const initialVersion = databaseVersion(database, targetVersion);
  if (initialVersion === targetVersion) return;
  if (database.isTransaction) throw new EngineError('DB_MIGRATION_TRANSACTION_ACTIVE', 'Database migration requires its own transaction');
  if (database.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) {
    throw new EngineError('DB_MIGRATION_FOREIGN_KEYS_DISABLED', 'Database migration requires foreign key enforcement');
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    const currentVersion = databaseVersion(database, targetVersion);
    for (const migration of migrations.slice(currentVersion)) {
      const result = migration.apply(database);
      if (result !== undefined || !database.isTransaction || databaseVersion(database, targetVersion) !== migration.version - 1) {
        throw new EngineError('DB_MIGRATION_CONTRACT_INVALID', 'Database migrations must be synchronous and leave transaction/version ownership to the framework');
      }
      database.exec(`PRAGMA user_version=${migration.version}`);
    }
    if (!inspectIntegrity(database, targetVersion).ok) {
      throw new EngineError('DB_INTEGRITY_FAILED', 'Database migration failed SQLite integrity or foreign key checks');
    }
    database.exec('COMMIT');
  } catch (error) {
    try { if (database.isTransaction) database.exec('ROLLBACK'); } catch { /* Preserve the migration failure. */ }
    throw error;
  }
}
