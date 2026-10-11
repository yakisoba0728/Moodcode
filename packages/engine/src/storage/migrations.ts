import { HOST_COMMAND_SCHEMA_SQL, HOST_COMMAND_TABLES, validateHostCommandDatabase } from '../jobs/host-command-records.js';
import { DatabaseSync } from 'node:sqlite';
import { EngineError } from '@moodcode/contracts';
import { inspectIntegrity } from './maintenance.js';
import { migrateNativeSessions, NATIVE_SESSION_TABLES } from './native-schema.js';
import { ATTEMPT_USAGE_SCHEMA } from './native-usage.js';
import { SUMMARY_ATTEMPT_SCHEMA, SUMMARY_STORAGE_TABLES } from './summary-attempts.js';
import { SUMMARY_RECOVERY_SCHEMA, SUMMARY_RECOVERY_PROOF_SCHEMA, SUMMARY_RECOVERY_TABLES } from '../recovery/summary.js';
import { ATTEMPT_CLEANUP_SCHEMA, ATTEMPT_CLEANUP_TABLES } from './attempt-cleanup.js';
import { PROVIDER_RECOVERY_SCHEMA, PROVIDER_RECOVERY_TABLES } from '../recovery/provider.js';
import { MCP_EXECUTION_SCHEMA, MCP_EXECUTION_TABLES } from './mcp-executions.js';
import { KNOWLEDGE_SCHEMA_SQL } from '../knowledge/store.js';
import { KNOWLEDGE_STORAGE_TABLES, validateKnowledgeArchiveRow } from '../knowledge/validation.js';
import { KNOWLEDGE_GENERATION_SCHEMA_SQL, KNOWLEDGE_GENERATION_TABLES, validateKnowledgeGenerationArchiveRow } from '../knowledge/generation-store.js';
import { validateKnowledgeGenerationDatabase } from '../knowledge/generation-archive-relations.js';
import { KNOWLEDGE_PUBLICATION_SCHEMA_SQL, KNOWLEDGE_PUBLICATION_TABLES } from '../knowledge/publication-store.js';
import { validateKnowledgePublicationDatabase } from '../knowledge/publication-archive-relations.js';
import { KNOWLEDGE_FILE_PUBLICATION_SCHEMA_SQL, KNOWLEDGE_FILE_PUBLICATION_TABLES, validateKnowledgeFilePublicationDatabase } from '../knowledge/file-publication-store.js';
import { KNOWLEDGE_FILE_EXECUTION_GUARD_SCHEMA_SQL, KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE, validateKnowledgeFileExecutionGuards } from '../knowledge/file-execution-guards.js';
import { DIAGNOSTIC_EXECUTION_OBSERVATION_SCHEMA_SQL, DIAGNOSTIC_EXECUTION_OBSERVATION_TABLES, validateDiagnosticExecutionObservationDatabase } from '../diagnostics/execution-observation-store.js';
import { KNOWLEDGE_IMPORT_RECOVERY_SCHEMA_SQL, KNOWLEDGE_IMPORT_RECOVERY_TABLES, validateKnowledgeImportRecoveryDatabase } from '../knowledge/import-recovery-store.js';
import { PROPOSAL_SCHEMA_SQL, PROPOSAL_TABLES, validateProposalDatabase } from '../proposals/store.js';
import { PROPOSAL_APPLY_SCHEMA_SQL, PROPOSAL_APPLY_TABLES, validateProposalApplyDatabase } from '../proposals/apply-store.js';
import { PROPOSAL_APPLY_GUARD_SCHEMA_SQL, PROPOSAL_APPLY_GUARD_TABLE, validateProposalApplyExecutionGuards } from '../proposals/execution-guards.js';
import { TEAM_SCHEMA_SQL, TEAM_TABLES } from '../teams/schema.js';
import { validateTeamDatabase } from '../teams/store.js';
import { validateResidentTeamDatabase } from '../teams/resident-validation.js';
import { WORKFLOW_SCHEMA_SQL, WORKFLOW_TABLES } from '../workflows/schema.js';
import { validateWorkflowDatabase } from '../workflows/store.js';
import { validateWorkflowEffectsDatabase } from '../workflows/effects-records.js';
import { validateCodingBatchDatabase } from '../coding-runs/groups.js';
import { SCHEDULE_SCHEMA_SQL, SCHEDULE_TABLES } from '../schedules/schema.js';
import { validateScheduleDatabase } from '../schedules/store.js';
import { BACKEND_SCHEMA_SQL, BACKEND_TABLES } from '../agent-backends/schema.js';
import { validateAgentBackendDatabase } from '../agent-backends/store.js';
import { JOB_SCHEMA_SQL, JOB_TABLES } from '../jobs/schema.js';
import { validateJobDatabase } from '../jobs/store.js';
import { validateOwnedCommandJobDatabase } from '../jobs/owned-command-records.js';
import { validateOwnedCommandDeliveryDatabase } from '../jobs/owned-command-delivery-records.js';
import { validateHostCommandDeliveryDatabase } from '../jobs/host-command-delivery-records.js';
import { validateCommandLifetimeDatabase } from '../jobs/command-lifetime-records.js';
import { validateEffectBatchDatabase } from '../effect-batches/storage.js';
import { validateGitCommitDatabase } from '../git/commit-receipts.js';
import { validateConversationForkDatabase } from '../sessions/fork-native.js';
import { validatePrFeedbackDatabase } from '../pr-feedback/records.js';
import { validateSandboxDatabase } from '../sandbox/records.js';
import { validateCodeModeDatabase } from '../code-mode/records.js';

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
  Object.freeze({ version: 21, name: 'native-agent-backends-and-client-effect-receipts', apply: (database: DatabaseSync) => { database.exec(BACKEND_SCHEMA_SQL); } }),
  Object.freeze({ version: 22, name: 'native-terminal-watch-jobs-and-completion-delivery', apply: (database: DatabaseSync) => { database.exec(JOB_SCHEMA_SQL); } }),
  Object.freeze({ version: 23, name: 'independent-approved-host-commands', apply: (database: DatabaseSync) => { database.exec(HOST_COMMAND_SCHEMA_SQL); } }),
]);
export const DB_VERSION = DATABASE_MIGRATIONS.length;

/** Archive-only bounded JSON row checks, run before the feature's relationship checks. */
interface ArchiveRowCheck { readonly validate: (row: unknown) => unknown; readonly boundMessage: string; readonly message: string }
interface PrimaryChecks {
  /** Relationship checks shared by recovery and archives; `archive` adds the ones recovery does not run. */
  readonly validate: (db: DatabaseSync, check: () => void, archive: boolean) => void;
  readonly archiveCode: string;
  readonly archiveMessage: string;
  /** Archives map only knowledge errors to archiveCode and rethrow other engine errors. */
  readonly archiveKnowledgeOnly?: true;
}
export type PrimaryFeature = { readonly since: number; readonly tables: readonly string[]; readonly archiveRows?: ArchiveRowCheck }
  & (PrimaryChecks | { readonly validate?: undefined });

/** Tables each primary schema version adds, in version order; recovery and archives check them in this order. */
const PRIMARY_FEATURES: readonly PrimaryFeature[] = [
  { since: 1, tables: ['workspaces', 'sessions', 'inputs', 'runs', 'messages', 'tools', 'approvals', 'checkpoints', 'events'] },
  { since: 2, tables: NATIVE_SESSION_TABLES },
  { since: 3, tables: ['attempt_usage'] },
  { since: 4, tables: SUMMARY_STORAGE_TABLES },
  { since: 5, tables: SUMMARY_RECOVERY_TABLES },
  { since: 6, tables: ATTEMPT_CLEANUP_TABLES },
  { since: 7, tables: PROVIDER_RECOVERY_TABLES },
  { since: 9, tables: MCP_EXECUTION_TABLES },
  { since: 10, tables: KNOWLEDGE_STORAGE_TABLES, archiveRows: { validate: validateKnowledgeArchiveRow,
    boundMessage: 'Archived knowledge row exceeds its bound', message: 'Archived workspace trust or pending knowledge record is invalid' } },
  { since: 11, tables: KNOWLEDGE_GENERATION_TABLES, archiveRows: { validate: validateKnowledgeGenerationArchiveRow,
    boundMessage: 'Archived generation row exceeds its bound', message: 'Archived native generation record is invalid' },
    validate: (db, check) => validateKnowledgeGenerationDatabase(db, check), archiveKnowledgeOnly: true,
    archiveCode: 'ARCHIVE_KNOWLEDGE_INVALID', archiveMessage: 'Archived native generation relationships are invalid' },
  { since: 12, tables: KNOWLEDGE_PUBLICATION_TABLES, validate: (db, check) => validateKnowledgePublicationDatabase(db, check), archiveKnowledgeOnly: true,
    archiveCode: 'ARCHIVE_KNOWLEDGE_INVALID', archiveMessage: 'Archived workspace publication relationships are invalid' },
  { since: 13, tables: [...KNOWLEDGE_FILE_PUBLICATION_TABLES, KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE],
    validate: (db, check) => { validateKnowledgeFilePublicationDatabase(db, check); validateKnowledgeFileExecutionGuards(db, check); },
    archiveCode: 'ARCHIVE_KNOWLEDGE_INVALID', archiveMessage: 'Archived physical file publication relationships are invalid' },
  { since: 14, tables: DIAGNOSTIC_EXECUTION_OBSERVATION_TABLES, validate: (db, check) => validateDiagnosticExecutionObservationDatabase(db, check),
    archiveCode: 'ARCHIVE_EXECUTION_OBSERVATION_INVALID', archiveMessage: 'Archived original execution observations or effect epochs are invalid' },
  { since: 15, tables: KNOWLEDGE_IMPORT_RECOVERY_TABLES, validate: (db, check) => validateKnowledgeImportRecoveryDatabase(db, check),
    archiveCode: 'ARCHIVE_KNOWLEDGE_IMPORT_INVALID', archiveMessage: 'Archived imported knowledge recovery decisions or activation lineage are invalid' },
  { since: 16, tables: PROPOSAL_TABLES, validate: (db, check) => validateProposalDatabase(db, check),
    archiveCode: 'ARCHIVE_PROPOSAL_INVALID', archiveMessage: 'Archived pending proposals or their original artifact owners are invalid' },
  { since: 17, tables: [...PROPOSAL_APPLY_TABLES, PROPOSAL_APPLY_GUARD_TABLE],
    validate: (db, check) => { validateProposalApplyDatabase(db, check); validateProposalApplyExecutionGuards(db, check); },
    archiveCode: 'ARCHIVE_DATABASE_INVALID', archiveMessage: 'Proposal apply ownership, checkpoints, artifacts or receipt proofs are invalid' },
  { since: 18, tables: TEAM_TABLES, validate: (db, check) => { validateTeamDatabase(db, check); validateResidentTeamDatabase(db, check); },
    archiveCode: 'ARCHIVE_TEAM_INVALID', archiveMessage: 'Team membership, mailbox, board or actual input delivery relationships are invalid' },
  { since: 19, tables: WORKFLOW_TABLES,
    validate: (db, check) => { validateWorkflowDatabase(db, { check }); validateWorkflowEffectsDatabase(db); validateCodingBatchDatabase(db); },
    archiveCode: 'ARCHIVE_WORKFLOW_INVALID', archiveMessage: 'Archived workflow revisions, native stage ownership or transition receipts are invalid' },
  { since: 20, tables: SCHEDULE_TABLES, validate: (db, check) => validateScheduleDatabase(db, { check }),
    archiveCode: 'ARCHIVE_SCHEDULE_INVALID', archiveMessage: 'Archived schedule revisions, occurrence ownership or actual input relationships are invalid' },
  { since: 21, tables: BACKEND_TABLES, validate: (db, check) => validateAgentBackendDatabase(db, { check }),
    archiveCode: 'ARCHIVE_BACKEND_INVALID', archiveMessage: 'Archived backend ownership, remote requests or client effect receipts are invalid' },
  { since: 22, tables: JOB_TABLES, validate: (db, check, archive) => {
    // Only archives check effect batches and code-mode records.
    if (archive) validateEffectBatchDatabase(db);
    validateJobDatabase(db, { check }); validateOwnedCommandJobDatabase(db, { check }); validateOwnedCommandDeliveryDatabase(db, { check });
    validateGitCommitDatabase(db, { check }); validateConversationForkDatabase(db); validatePrFeedbackDatabase(db, { check }); validateSandboxDatabase(db, { check });
    if (archive) validateCodeModeDatabase(db, { check });
  }, archiveCode: 'ARCHIVE_JOB_INVALID', archiveMessage: 'Archived terminal job sources, immutable output pages or completion delivery receipts are invalid' },
  { since: 23, tables: HOST_COMMAND_TABLES,
    validate: (db, check) => { validateHostCommandDatabase(db, { check }); validateHostCommandDeliveryDatabase(db, { check }); validateCommandLifetimeDatabase(db, check); },
    archiveCode: 'ARCHIVE_HOST_COMMAND_INVALID', archiveMessage: 'Independent host command approval, process, checkpoint or cleanup evidence is invalid' },
];
export const primaryFeaturesFor = (version: number): PrimaryFeature[] => PRIMARY_FEATURES.filter(feature => version >= feature.since);
/** checkDatabase sorts tables, so this order does not affect logical hashes. */
export const primaryTablesFor = (version: number): string[] => primaryFeaturesFor(version).flatMap(feature => feature.tables);

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
