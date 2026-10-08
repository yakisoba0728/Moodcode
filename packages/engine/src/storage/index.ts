import { PrFeedbackStorage, validatePrFeedbackDatabase } from '../pr-feedback/records.js';
import { validateCommitVerification } from '../git/commit-receipts.js';
import {deliverHostCommandResultAtomic,readHostCommandDeliveries,readHostCommandDelivery,findHostCommandDeliveryForInput,validateHostCommandDeliveryDatabase,pauseImportedHostCommandDeliveries,type HostCommandDeliveryInput,type HostCommandDeliveryPorts} from '../jobs/host-command-delivery-records.js';
import {WorkflowEffectStorage, readWorkflowEffect, readWorkflowDelivery, hasWorkflowEffectUncertainty, pauseImportedWorkflowEffects, type WorkflowEffectNativePorts} from "../workflows/effects-records.js";
import { HostCommandStorage, hasHostCommandUncertainty, validateHostCommandDatabase } from '../jobs/host-command-records.js';
import { GitCommitStorage, hasUncertainGitCommit, hasKnownGitCommitSupervisor, readGitCommitProcessEvidence, validateGitCommitDatabase } from '../git/commit-receipts.js';
import { readForkChildData } from '../sessions/fork-child.js';
import { importPausedFork, type ForkImportPreview } from '../sessions/fork-archive.js';
import { captureForkSource, assertForkSourceCurrent, readConversationFork, materializeConversationFork, validateConversationForkDatabase, type ForkNativePorts } from '../sessions/fork-native.js';
import type { FrozenHistoryManifest } from '../sessions/fork-types.js';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  EngineError, isTerminal, SCHEMA_VERSION,
  type AcceptInput, type ApprovalRecord, type Checkpoint, type ContextRevision, type EngineBudgets, type EngineEvent,
  type InputCursor, type InputPage, type InputReceipt, type InputRecord, type JsonObject, type MessagePart, type ProviderAttempt,
  type Message, type Run, type RunReceipt, type RunState, type Session,
  type SessionSnapshot, type SessionControl, type SessionEventV2, type SessionHistoryPage, type SessionMetrics, type SubmitInput, type ToolCallRecord, type TurnRecord, type Workspace,
} from '@moodcode/contracts';
import { normalizeDocumentAttachments, normalizeImageAttachments } from '@moodcode/contracts/validation';
import type { CommitChange, SessionEngineStore } from '../ports.js';
import { backupDatabase, inspectIntegrity, type DatabaseBackup, type IntegrityCheckResult, type StoreBackupOptions } from './maintenance.js';
import { databaseVersion, DB_VERSION, migrateDatabase } from './migrations.js';
import { NativeSessionStorage, type ExistingInputReceipt, type StoredInputPromotion } from './native.js';
import { NativeExecutionStorage, type PartPage, type SessionDocument, type TurnPage } from './native-records.js';
import { ownedCommandJobKind, validateOwnedCommandJob, validateOwnedCommandJobDatabase, readOwnedCommandJobs, readOwnedCommandJob, recoverInterruptedOwnedCommandJobs, pauseImportedOwnedCommandJobs, type OwnedCommandJobSource } from '../jobs/owned-command-records.js';
import { deliverOwnedCommandResultAtomic, readOwnedCommandDeliveries, readOwnedCommandDelivery, findOwnedCommandDeliveryForInput, validateOwnedCommandDeliveryDatabase, pauseImportedOwnedCommandDeliveries, type OwnedCommandDeliveryInput, type OwnedCommandDeliveryPorts } from '../jobs/owned-command-delivery-records.js';
import { searchHistoryDatabase, type HistorySearchOptions, type HistorySearchPage } from './history-search.js';
import { readNativeMetrics, type NativeMetricsReport } from './native-metrics.js';
import { readActiveHistoryWindow, withSessionDocumentAnchor, withSessionImageAnchor, type ActiveHistoryWindow, type SessionDocumentAnchor, type SessionImageAnchor } from './native-history.js';
import { putAttemptUsage, type AttemptUsageRecord, type AttemptUsageSnapshot } from './native-usage.js';
import { inspectInputImageIndex, type InputImageIndexOptions, type InputImageIndexReport } from './input-image-index.js';
import { inspectInputDocumentIndex, type InputDocumentIndexOptions, type InputDocumentIndexReport } from './input-document-index.js';
import { readChildStorageSelection, type ChildStorageSelectionOptions, type ChildStorageSelectionReport, type ChildStorageSelectionBudget } from '../child-tasks/storage-binding.js';
import type { ChildDocumentReadFrame } from './child-document-reader.js';
import { readActivePrefixSourceDatabase, validateActivePrefixPublication } from './active-prefix.js';
import { SummaryAttemptStorage, type SummaryAttemptIdentity, type SummaryAttemptRecord, type SummaryAttemptListOptions, type SummaryAttemptPage, type SummaryObservation, type SummarySettlement, type SummaryUsageRecord } from './summary-attempts.js';
import { SummaryRecoveryStorage, captureSummaryRecoveryHighWater, type SummaryRecoveryRequest } from '../recovery/summary.js';
import { AttemptCleanupStorage, type AttemptCleanupIdentity, type AttemptCleanupRecord, type AttemptCleanupSettlement } from './attempt-cleanup.js';
import { McpExecutionStorage, hasMcpExecutionUncertainty, type McpExecutionIdentity, type McpExecutionRecord, type McpExecutionSettlement, type McpDispatchBoundary } from './mcp-executions.js';
import { hasExecutionUncertainty, summaryOverflowDependency } from './execution-uncertainty.js';
import { ProviderRecoveryStorage, captureProviderRecoveryHighWater, type ProviderRecoveryRequest } from '../recovery/provider.js';
import { hasEvidenceRead, readEvidenceBody, withEvidenceRead } from './evidence-read.js';
import { captureToolRecoveryFrontiers } from './tool-recovery-frontier.js';
import type { ActivePrefixSource, ActivePrefixSourceOptions, PreparedActivePrefix, ActivePrefixContextPublication } from '../context/active-prefix.js';
import { verificationDocumentKind, validateConsumedVerificationSettlement } from '../verification/plans.js';
import { verificationControllerDocumentKind } from '../verification/controller.js';
import { lifecycleContinuationDocumentKind } from '../lifecycle/continuation.js';
import { KnowledgeStorage } from '../knowledge/store.js';
import { KnowledgeGenerationStorage, hasKnowledgeGenerationBlocker } from '../knowledge/generation-store.js';
import type { KnowledgeGenerationStoragePorts } from '../knowledge/generation-types.js';
import { KnowledgePublicationStorage } from '../knowledge/publication-store.js';
import type { KnowledgePublicationStoragePorts } from '../knowledge/publication-types.js';
import { KnowledgeFilePublicationStorage, hasKnowledgeFilePublicationBlocker } from '../knowledge/file-publication-store.js';
import type { KnowledgeFilePublicationStoragePorts } from '../knowledge/file-publication-types.js';
import { KnowledgeFileExecutionGuards } from '../knowledge/file-execution-guards.js';
import type { KnowledgeStoragePorts } from '../knowledge/types.js';
import { validateKnowledgeArchiveRow } from '../knowledge/validation.js';
import { KnowledgeHostAdapter } from '../knowledge/host.js';
import { KnowledgeContextSource } from '../knowledge/context-source.js';
import { DiagnosticExecutionObservationStorage } from '../diagnostics/execution-observation-store.js';
import type { DiagnosticExecutionObservationPorts } from '../diagnostics/execution-observation-types.js';
import type { KnowledgeContextSourcePorts } from '../knowledge/context-types.js';
import { readKnowledgeImportDocumentProof } from '../knowledge/import-document-proof.js';
import { KnowledgeImportRecoveryStorage } from '../knowledge/import-recovery-store.js';
import type { KnowledgeImportRecoveryStoragePorts } from '../knowledge/import-recovery-types.js';
import { knowledgeHash, validateBinding } from '../knowledge/validation.js';
import { ProposalStorage, pauseImportedProposals } from '../proposals/store.js';
import { ProposalBlobStorage } from '../proposals/blob-store.js';
import type { ProposalStoragePorts } from '../proposals/types.js';
import type { ProposalBlobReference } from '../proposals/types.js';
import { ProposalApplyStorage, hasProposalApplyBlocker, pauseImportedProposalApplies } from '../proposals/apply-store.js';
import type { ProposalApplyStoragePorts } from '../proposals/apply-types.js';
import { ProposalApplyExecutionGuards } from '../proposals/execution-guards.js';
import { TeamStorage, pauseImportedTeams } from '../teams/store.js';
import type { TeamStoragePorts } from '../teams/types.js';
import { WorkflowStorage, markImportedWorkflowsPaused, type WorkflowStoragePorts } from '../workflows/store.js';
import { ScheduleStorage, markImportedSchedulesDisabled, type ScheduleStoragePorts } from '../schedules/store.js';
import { AgentBackendStorage, markImportedAgentBackendsPaused, hasAgentBackendBlocker, type AgentBackendStoragePorts } from '../agent-backends/store.js';
import { JobStorage, markImportedJobsPaused, type JobStoragePorts } from '../jobs/store.js';
export type { DatabaseBackup, IntegrityCheckResult, StoreBackupOptions } from './maintenance.js';
export type { NativeMetricsReport } from './native-metrics.js';
export type { InputImageIndexOptions, InputImageIndexReport } from './input-image-index.js';
export type { InputDocumentIndexOptions, InputDocumentIndexReport } from './input-document-index.js';

const PAGE_SIZE = 128;
const MAX_PAGE_SIZE = 1_024;
type DataRow = { data: string };
type Waiter = { sessionId: string; wake: () => void };
const ACTIVE_STATES = "'created','running','awaiting_approval','cancelling'";
export interface ModelHistoryPage {
  snapshot: SessionSnapshot;
  omittedRuns: number;
  omittedMessages: number;
  beforeRunId: string | null;
  activeWindow?: ActiveHistoryWindow;
  sessionImageAnchor?: SessionImageAnchor;
  sessionDocumentAnchor?: SessionDocumentAnchor;
}
const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  created: ['running', 'cancelling', 'cancelled', 'failed', 'interrupted'],
  running: ['awaiting_approval', 'cancelling', 'completed', 'failed', 'interrupted'],
  awaiting_approval: ['running', 'cancelling', 'failed', 'interrupted'],
  cancelling: ['cancelled', 'failed', 'interrupted'],
  completed: [], cancelled: [], failed: [], interrupted: [],
};

function encode(value: unknown): string { return JSON.stringify(value); }
function decode<T>(row: DataRow): T { return JSON.parse(row.data) as T; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new EngineError('INVALID_RECORD', 'Records must contain JSON values');
  return result;
}
function requireMatch(actual: unknown, expected: unknown, description: string): void {
  if (canonical(actual) !== canonical(expected)) throw new EngineError('RECORD_CONFLICT', description);
}
function cursor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new EngineError('INVALID_CURSOR', 'Event cursor must be a nonnegative safe integer');
}
function assertSingleLink(path: string): void {
  if (statSync(path).nlink > 1) throw new EngineError('DB_PATH_UNSUPPORTED', 'Hard-linked SQLite database paths are unsupported');
}
function canonicalPath(path: string): string {
  if (!path || path.includes('\0')) throw new EngineError('DB_PATH_UNSUPPORTED', 'A database file path is required');
  if (path === ':memory:') return path;
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  if (existsSync(absolute)) {
    const result = realpathSync(absolute);
    if (!statSync(result).isFile()) throw new EngineError('DB_PATH_UNSUPPORTED', 'Database path must be a regular file');
    assertSingleLink(result);
    return result;
  }
  if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new EngineError('DB_PATH_UNSUPPORTED', 'A dangling database symlink is unsupported');
  }
  // Resolve parent aliases before the database exists, so both owners share the same lock.
  return join(realpathSync(dirname(absolute)), basename(absolute));
}
function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: number }).errcode;
  return code !== undefined && ((code & 0xff) === 5 || (code & 0xff) === 6);
}

/** SQLite records and journal. File-backed stores own one OS-released SQLite lock. */
export class SqliteStore implements SessionEngineStore {
  private readonly db: DatabaseSync;
  private readonly databasePath: string;
  private readonly ownership?: DatabaseSync;
  private readonly native: NativeSessionStorage;
  private readonly executionRecords: NativeExecutionStorage;
  private readonly summaryRecords: SummaryAttemptStorage;
  private readonly attemptCleanupRecords: AttemptCleanupStorage;
  private readonly mcpExecutionRecords: McpExecutionStorage;
  private postCommitCallbacks?: Array<() => void>;
  private executionObservationRecords?: DiagnosticExecutionObservationStorage;
  private readonly summaryRecoveryHighWater: string;
  private summaryRecovery?: SummaryRecoveryStorage;
  private readonly providerRecoveryHighWater: string;
  private providerRecovery?: ProviderRecoveryStorage;
  private knowledgeGenerationRecords?: KnowledgeGenerationStorage;
  private knowledgePublicationRecords?: KnowledgePublicationStorage;
  private knowledgeFilePublicationRecords?: KnowledgeFilePublicationStorage;
  private knowledgeImportRecoveryRecords?: KnowledgeImportRecoveryStorage;
  private proposalRecords?: ProposalStorage;
  private proposalApplyRecords?: ProposalApplyStorage;
  private teamRecords?: TeamStorage;
  private workflowRecords?: WorkflowStorage;
  private workflowEffectRecords?:WorkflowEffectStorage;
  private scheduleRecords?: ScheduleStorage;
  private backendRecords?: AgentBackendStorage;
  private jobRecords?: JobStorage;
  private readonly waiters = new Set<Waiter>();
  private pendingBackups = 0;
  private released = false;
  private backupConnectionFailure?: EngineError;
  private resolveClose!: () => void;
  private rejectClose!: (error: unknown) => void;
  private readonly closeCompletion = new Promise<void>((resolveClose, rejectClose) => {
    this.resolveClose = resolveClose;
    this.rejectClose = rejectClose;
  });
  private closed = false;

  constructor(dbPath: string, hostBudgets?: EngineBudgets) {
    // Legacy synchronous close may fail before any closeAsync caller attaches a handler.
    void this.closeCompletion.catch(() => {});
    const path = canonicalPath(dbPath);
    this.databasePath = path;
    let ownership: DatabaseSync | undefined;
    let db: DatabaseSync | undefined;
    try {
      if (path !== ':memory:') {
        const ownerPath = `${path}.owner.sqlite`;
        if (existsSync(ownerPath)) {
          if (lstatSync(ownerPath).isSymbolicLink()) throw new EngineError('DB_PATH_UNSUPPORTED', 'Ownership database cannot be a symlink');
          assertSingleLink(ownerPath);
        }
        ownership = new DatabaseSync(ownerPath, { timeout: 0 });
        try {
          // WAL would weaken BEGIN EXCLUSIVE to a reserved writer lock; keep DELETE mode.
          ownership.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
        } catch (error) {
          if (isBusy(error)) throw new EngineError('DB_LOCKED', 'Another engine already owns this database');
          throw error;
        }
      }
      db = new DatabaseSync(path, { timeout: 1_000 });
      databaseVersion(db);
      // Inspect user_version before making any changes to a future-version database.
      db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      migrateDatabase(db);
      if (path !== ':memory:') assertSingleLink(path);
      this.db = db;
      this.ownership = ownership;
      this.native = new NativeSessionStorage(db, {
        assertOpen: () => this.assertOpen(), transaction: operation => this.transaction(operation),
        session: id => this.getSession(id), run: id => this.getRun(id),
        admit: (input, inputId) => this.admitInTransaction(input, inputId),
        steer: (input, run) => this.steerInTransaction(input, run), notify: id => this.notify(id),
      }, hostBudgets);
      this.executionRecords = new NativeExecutionStorage(this.native, turn => {
        const dependency = turn.uncertainty?.summaryDependency;
        if (dependency && this.getSummaryOverflowDependency(dependency.summaryAttemptId, turn.id, dependency.failedAttemptId).cleanupRecordSha256 !== dependency.cleanupRecordSha256) {
          throw new EngineError('SUMMARY_OVERFLOW_BINDING_MISMATCH', 'Turn dependency does not match its durable ordinary cleanup');
        }
      });
      this.summaryRecords = new SummaryAttemptStorage(this.native, (run, type, payload) => this.append(run, type, payload));
      this.attemptCleanupRecords = new AttemptCleanupStorage(this.native, (run, type, payload) => this.append(run, type, payload));
      this.mcpExecutionRecords = new McpExecutionStorage(this.native, (run, type, payload) => this.append(run, type, payload));
      this.summaryRecoveryHighWater = captureSummaryRecoveryHighWater(db);
      this.providerRecoveryHighWater = captureProviderRecoveryHighWater(db);
    } catch (error) {
      try { db?.close(); } finally { ownership?.close(); }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new EngineError('STORE_CLOSED', 'Storage is closed');
  }
  private row(sql: string, ...values: SQLInputValue[]): DataRow | undefined {
    return this.db.prepare(sql).get(...values) as DataRow | undefined;
  }
  private rows<T>(sql: string, ...values: SQLInputValue[]): T[] {
    return (this.db.prepare(sql).all(...values) as DataRow[]).map(decode<T>);
  }
  private ownerRow(table: 'workspaces' | 'sessions' | 'runs', id: string): DataRow | undefined {
    if (!hasEvidenceRead(this.db)) return this.row(`SELECT data FROM ${table} WHERE id=?`, id);
    const data = readEvidenceBody(this.db, { table, key: id }, { maxBytes: 1_048_576 });
    return data === undefined ? undefined : { data };
  }
  private transaction<T>(operation: () => T, write = true): T {
    this.assertOpen();
    this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    const callbacks: Array<() => void> = [];
    this.postCommitCallbacks = callbacks;
    let result: T;
    try { result = operation(); this.db.exec('COMMIT'); }
    catch (error) { this.postCommitCallbacks = undefined; try { this.db.exec('ROLLBACK'); } catch { /* Keep the transaction failure. */ } throw error; }
    this.postCommitCallbacks = undefined;
    // Durable acceptance does not fail merely because a notification or wake is unavailable.
    for (const callback of callbacks) try { callback(); } catch { /* The committed journal remains authoritative. */ }
    return result;
  }
  /** Trusted synchronous storage producers publish/wake only after this owner's COMMIT. */
  publishAfterCommit(operation: () => void): void {
    this.assertOpen();
    if (!this.db.isTransaction || !this.postCommitCallbacks) throw new EngineError('STORAGE_TRANSACTION_REQUIRED', 'Post-commit publication requires this store owner’s active primary transaction');
    this.postCommitCallbacks.push(operation);
  }
  private evidenceRead<T>(operation: () => T): T {
    if (this.db.isTransaction) return withEvidenceRead(this.db, operation);
    return this.transaction(() => withEvidenceRead(this.db, operation), false);
  }
  private recoveryBlocked(operation: () => boolean): boolean {
    try { return this.evidenceRead(operation); }
    catch (error) {
      if (error instanceof EngineError && error.code.startsWith('RECOVERY_EVIDENCE_')) return true;
      throw error;
    }
  }
  /** One coherent primary snapshot for native trajectory and execution provenance. */
  readExecutionObservationEvidence<T>(operation: () => T): T { return this.evidenceRead(operation); }
  /** Original immutable publication and current trust, selected from bounded native primary rows. */
  readKnowledgeImportDocumentProof(workspaceId: string, documentKey: string) {
    this.assertOpen();
    return this.evidenceRead(() => readKnowledgeImportDocumentProof(this.db, workspaceId, documentKey));
  }
  readProposalBlobText(reference: ProposalBlobReference): string {
    this.assertOpen();
    return this.evidenceRead(() => new ProposalBlobStorage(this.db).readText(reference));
  }
  private notify(sessionId: string): void {
    if (this.db.isTransaction && this.postCommitCallbacks) { this.publishAfterCommit(() => this.notify(sessionId)); return; }
    for (const waiter of [...this.waiters]) if (waiter.sessionId === sessionId) waiter.wake();
  }

  putWorkspace(workspace: Workspace): Workspace {
    return this.transaction(() => {
      const byRoot = this.row('SELECT data FROM workspaces WHERE root=?', workspace.root);
      if (byRoot) return decode<Workspace>(byRoot);
      const byId = this.row('SELECT data FROM workspaces WHERE id=?', workspace.id);
      if (byId) throw new EngineError('RECORD_CONFLICT', 'Workspace ID already belongs to a different root');
      this.db.prepare('INSERT INTO workspaces(id,root,data) VALUES(?,?,?)').run(workspace.id, workspace.root, encode(workspace));
      return JSON.parse(encode(workspace)) as Workspace;
    });
  }
  getWorkspace(id: string): Workspace {
    this.assertOpen();
    const row = this.ownerRow('workspaces', id);
    if (!row) throw new EngineError('WORKSPACE_NOT_FOUND', `Workspace ${id} was not found`);
    return decode(row);
  }
  listWorkspaces(): Workspace[] {
    this.assertOpen();
    return this.rows('SELECT data FROM workspaces ORDER BY rowid');
  }
  installConversationForkChildEvidence(sessionId: string, evidence: JsonObject): void { this.transaction(()=>{this.executionRecords.putSessionDocument(sessionId,'conversation.fork.child-data',0,evidence);this.native.appendEvent(sessionId,'conversation.fork.child_context',{evidence});}); }
  getConversationForkChildEvidence(sessionId: string) { return this.evidenceRead(()=>readForkChildData(this.db,sessionId)); }
  captureConversationForkSource(sessionId: string, throughRunId?: string): FrozenHistoryManifest { return this.evidenceRead(() => captureForkSource(this.db,sessionId,throughRunId)); }
  assertConversationForkSource(source: FrozenHistoryManifest, fresh: boolean): void { this.evidenceRead(() => assertForkSourceCurrent(this.db,source,fresh)); }
  getConversationFork(sessionId: string) { return this.evidenceRead(() => readConversationFork(this.db,sessionId)); }
  importPausedConversationFork(preview: ForkImportPreview, requestId: string) { return this.transaction(()=>importPausedFork(this.db,preview,requestId,{
    createSession:s=>this.createSession(s),putDocument:(s,k,r,d)=>this.executionRecords.putSessionDocument(s,k,r,d),
    appendEvent:(s,t,d)=>this.native.appendEvent(s,t,d),pause:s=>this.setSessionPaused(s,true,'recovery_required')})); }
  validateConversationForks(): void { this.evidenceRead(() => validateConversationForkDatabase(this.db)); }
  materializeConversationFork(original: object, requestId: string, fingerprint: string, ports: Omit<ForkNativePorts,'putDocument'|'appendEvent'>) {
    return this.transaction(() => materializeConversationFork(this.db,original,requestId,fingerprint,{...ports,
      putDocument:(sessionId,kind,revision,data)=>this.executionRecords.putSessionDocument(sessionId,kind,revision,data),
      appendEvent:(sessionId,type,payload,refs)=>this.native.appendEvent(sessionId,type,payload,refs)}));
  }
  createSession(session: Session): Session {
    const create = (): Session => {
      this.getWorkspace(session.workspaceId);
      const existing = this.row('SELECT data FROM sessions WHERE id=?', session.id);
      if (existing) { requireMatch(decode(existing), session, 'Session ID already exists'); return decode(existing); }
      this.db.prepare('INSERT INTO sessions(id,workspace_id,data) VALUES(?,?,?)').run(session.id, session.workspaceId, encode(session));
      return JSON.parse(encode(session)) as Session;
    };
    return this.db.isTransaction ? create() : this.transaction(create);
  }
  getSession(id: string): Session {
    this.assertOpen();
    const row = this.ownerRow('sessions', id);
    if (!row) throw new EngineError('SESSION_NOT_FOUND', `Session ${id} was not found`);
    return decode(row);
  }
  listSessions(workspaceId: string): Session[] {
    this.getWorkspace(workspaceId);
    return this.rows('SELECT data FROM sessions WHERE workspace_id=? ORDER BY rowid', workspaceId);
  }

  admit(input: SubmitInput): RunReceipt {
    const receipt = this.transaction(() => {
      const existing = this.native.legacyReceipt(input);
      if (existing) return existing;
      const receipt = this.admitInTransaction(input);
      this.native.bindLegacy(input, this.getRun(receipt.runId), receipt.inputId);
      return receipt;
    });
    this.notify(input.sessionId);
    return receipt;
  }
  private admitInTransaction(input: SubmitInput, inputId: string = randomUUID()): RunReceipt {
      const session = this.getSession(input.sessionId);
      const fingerprint = canonical(input);
      const existing = this.db.prepare('SELECT inputs.id, inputs.fingerprint, inputs.admitted_seq, runs.id AS run_id FROM inputs JOIN runs ON runs.input_id=inputs.id WHERE inputs.session_id=? AND inputs.request_id=?').get(input.sessionId, input.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new EngineError('REQUEST_ID_CONFLICT', 'Request ID was already used for different input');
        return { runId: String(existing.run_id), inputId: String(existing.id), admittedSeq: Number(existing.admitted_seq), duplicate: true };
      }
      if (this.hasUncertainKnowledgeGeneration(session.workspaceId)) throw new EngineError('CLEANUP_PENDING', 'Workspace host generation requires explicit recovery');
      const busy = this.db.prepare(`SELECT id FROM runs WHERE workspace_id=? AND state IN (${ACTIVE_STATES})`).get(session.workspaceId);
      if (busy) throw new EngineError('WORKSPACE_BUSY', 'Workspace already has an active run', { runId: String(busy.id), workspaceId: session.workspaceId });
      const timestamp = new Date().toISOString();
      const run: Run = {
        id: randomUUID(), inputId, sessionId: session.id, workspaceId: session.workspaceId,
        requestId: input.requestId, prompt: input.prompt, config: input.config,
        state: 'created', createdAt: timestamp, updatedAt: timestamp,
        ...(input.attachments === undefined ? {} : { attachments: normalizeImageAttachments(input.attachments) }),
        ...(input.documents === undefined ? {} : { documents: normalizeDocumentAttachments(input.documents) }),
      };
      this.db.prepare('INSERT INTO inputs(id,session_id,request_id,fingerprint,admitted_seq,data) VALUES(?,?,?,?,0,?)').run(inputId, session.id, input.requestId, fingerprint, encode(input));
      this.db.prepare('INSERT INTO runs(id,input_id,session_id,workspace_id,state,data) VALUES(?,?,?,?,?,?)').run(run.id, inputId, session.id, session.workspaceId, run.state, encode(run));
      const message: Message = { id: randomUUID(), sessionId: session.id, runId: run.id, role: 'user', content: input.prompt, createdAt: timestamp,
        ...(run.attachments === undefined ? {} : { attachments: structuredClone(run.attachments) }),
        ...(run.documents === undefined ? {} : { documents: structuredClone(run.documents) }) };
      this.writeMessage(run, message);
      const admitted = this.append(run, 'input.admitted', { runId: run.id, inputId, requestId: input.requestId });
      this.db.prepare('UPDATE inputs SET admitted_seq=? WHERE id=?').run(admitted.seq, inputId);
      return { runId: run.id, inputId, admittedSeq: admitted.seq, duplicate: false };
  }
  private steerInTransaction(input: InputRecord, run: Run): number {
    const message: Message = { id: input.id, sessionId: input.sessionId, runId: run.id, role: 'user', content: input.prompt, createdAt: new Date().toISOString(),
      ...(input.attachments === undefined ? {} : { attachments: normalizeImageAttachments(input.attachments) }),
      ...(input.documents === undefined ? {} : { documents: normalizeDocumentAttachments(input.documents) }) };
    this.writeMessage(run, message);
    return this.append(run, 'input.steered', { inputId: input.id, requestId: input.requestId, messageId: message.id }).seq;
  }
  acceptInput(input: AcceptInput): InputReceipt {
    const receipt = this.native.acceptInput(input);
    if (this.db.isTransaction && this.postCommitCallbacks) this.publishAfterCommit(() => this.notify(input.sessionId));
    return receipt;
  }
  lookupInputReceipt(input: AcceptInput): ExistingInputReceipt | undefined { return this.native.lookupInputReceipt(input); }
  lookupRunReceipt(input: SubmitInput): RunReceipt | undefined { return this.native.lookupRunReceipt(input); }
  getInput(id: string): InputRecord { return this.native.getInput(id); }
  listInputs(sessionId: string, position?: InputCursor, limit?: number): InputPage { return this.native.listInputs(sessionId, position, limit); }
  pendingInputs(sessionId: string, delivery?: AcceptInput['delivery'], limit?: number): InputRecord[] { return this.native.pendingInputs(sessionId, delivery, limit); }
  listRunInputIds(runId: string): string[] { return this.native.listRunInputIds(runId); }
  listRunInputs(runId: string): InputRecord[] { return this.native.listRunInputs(runId); }
  promoteInput(inputId: string, runId?: string): StoredInputPromotion { return this.native.promoteInput(inputId, runId); }
  promoteSteers(inputIds: string[], runId: string): InputRecord[] { return this.native.promoteSteers(inputIds, runId); }
  cancelInput(inputId: string): InputRecord { return this.native.cancelInput(inputId); }
  getSessionControl(sessionId: string): SessionControl { return this.native.getSessionControl(sessionId); }
  setSessionPaused(sessionId: string, paused: boolean, reason?: SessionControl['reason']): SessionControl { return this.native.setSessionPaused(sessionId, paused, reason); }
  readSessionEvents(sessionId: string, afterSeq: number, limit?: number): SessionEventV2[] { return this.native.readSessionEvents(sessionId, afterSeq, limit); }
  putTurn(turn: TurnRecord): TurnRecord { return this.executionRecords.putTurn(turn); }
  getTurn(id: string): TurnRecord { return this.executionRecords.getTurn(id); }
  listTurns(runId: string): TurnRecord[] { return this.executionRecords.listTurns(runId); }
  listTurnsPage(runId: string, afterTurnId?: string, limit?: number): TurnPage { return this.executionRecords.listTurnsPage(runId, afterTurnId, limit); }
  putAttempt(attempt: ProviderAttempt): ProviderAttempt { return this.executionRecords.putAttempt(attempt); }
  putAttemptUsage(attemptId: string, usage: AttemptUsageSnapshot): AttemptUsageRecord { return putAttemptUsage(this.native, attemptId, usage); }
  createSummaryAttempt(identity: SummaryAttemptIdentity): SummaryAttemptRecord { return this.summaryRecords.create(identity); }
  dispatchSummaryAttempt(id: string): SummaryAttemptRecord { return this.summaryRecords.dispatch(id); }
  observeSummaryAttempt(id: string, observation: SummaryObservation): SummaryAttemptRecord { return this.summaryRecords.observe(id, observation); }
  markSummaryProviderCompleted(id: string): SummaryAttemptRecord { return this.summaryRecords.providerCompleted(id); }
  settleSummaryAttempt(id: string, outcome: SummarySettlement): SummaryAttemptRecord { return this.summaryRecords.settle(id, outcome); }
  getSummaryAttempt(id: string, expectedSessionId?: string): SummaryAttemptRecord { return this.summaryRecords.get(id, expectedSessionId); }
  getSummaryUsage(id: string, expectedSessionId?: string): SummaryUsageRecord | null { return this.summaryRecords.getUsage(id, expectedSessionId); }
  listSummaryAttempts(sessionId: string, options?: SummaryAttemptListOptions): SummaryAttemptPage { return this.summaryRecords.list(sessionId, options); }
  /** Set before startup recovery; the boot frontier cannot be advanced by a host decision. */
  configureSummaryRecovery(bindingScope: (workspaceId: string) => string): void {
    this.assertOpen();
    if (this.summaryRecovery) throw new EngineError('SUMMARY_RECOVERY_ALREADY_CONFIGURED', 'Summary recovery has already been bound');
    this.summaryRecovery = new SummaryRecoveryStorage(this.native, this.summaryRecords, {
      bindingScope, startupHighWater: this.summaryRecoveryHighWater,
      appendLegacy: (run, type, payload) => this.append(run, type, payload),
      getSummaryOverflowDependency: (id, turnId, failedAttemptId) => this.getSummaryOverflowDependency(id, turnId, failedAttemptId),
      hasOtherExecutionUncertainty: (workspaceId, excludedSummaryAttemptId) => hasExecutionUncertainty(this.db, this, workspaceId, {
        excludedSummaryAttemptId, hasValidSummaryAcknowledgment: (sessionId, id) => this.summaryRecovery?.hasValidAcknowledgment(sessionId, id) ?? false,
        hasValidProviderAcknowledgment: (sessionId, id) => this.providerRecovery?.hasValidAcknowledgment(sessionId, id) ?? false,
        hasUnacknowledgedProviders: workspaceId => this.providerRecovery?.hasUnacknowledged(workspaceId) ?? true,
      }),
    });
  }
  getSummaryRecoveryPreview(sessionId: string, summaryAttemptId: string) {
    this.assertOpen();
    if (!this.summaryRecovery) throw new EngineError('SUMMARY_RECOVERY_NOT_CONFIGURED', 'Summary recovery requires a host storage binding');
    return this.summaryRecovery.preview(sessionId, summaryAttemptId);
  }
  acknowledgeSummaryRecovery(request: SummaryRecoveryRequest) {
    this.assertOpen();
    if (!this.summaryRecovery) throw new EngineError('SUMMARY_RECOVERY_NOT_CONFIGURED', 'Summary recovery requires a host storage binding');
    return this.summaryRecovery.acknowledge(request);
  }
  findSummaryRecoveryReceipt(request: SummaryRecoveryRequest) {
    this.assertOpen();
    if (!this.summaryRecovery) throw new EngineError('SUMMARY_RECOVERY_NOT_CONFIGURED', 'Summary recovery requires a host storage binding');
    return this.summaryRecovery.findReceipt(request);
  }
  hasUncertainSummaries(workspaceId: string): boolean {
    return this.recoveryBlocked(() => {
      this.getWorkspace(workspaceId);
      return this.summaryRecovery?.hasUnacknowledged(workspaceId)
        ?? !!this.db.prepare("SELECT 1 FROM summary_attempts WHERE workspace_id=? AND state='uncertain' LIMIT 1").get(workspaceId);
    });
  }
  hasUncertainWorkspace(workspaceId: string): boolean {
    return this.recoveryBlocked(() => hasWorkflowEffectUncertainty(this.db,workspaceId) || this.hasUncertainGitCommit(workspaceId) || this.hasUncertainSummaries(workspaceId) || this.hasUncertainExecution(workspaceId) || this.hasUncertainKnowledgeGeneration(workspaceId) || this.hasUncertainKnowledgeFilePublication(workspaceId) || this.hasUncertainProposalApply(workspaceId) || this.hasUncertainAgentBackend(workspaceId) || readOwnedCommandJobs(this.db, workspaceId).some(job => job.state === 'uncertain' || job.state === 'paused-import' && job.errorCode === 'COMMAND_JOB_CLEANUP_UNCERTAIN'));
  }
  hasUncertainAgentBackend(workspaceId: string): boolean {
    return this.recoveryBlocked(() => { this.getWorkspace(workspaceId); return hasAgentBackendBlocker(this.db, workspaceId); });
  }
  hasUncertainProposalApply(workspaceId: string): boolean {
    return this.recoveryBlocked(() => { this.getWorkspace(workspaceId); return this.proposalApplyRecords?.hasBlocker(workspaceId) ?? hasProposalApplyBlocker(this.db, workspaceId); });
  }
  hasUncertainKnowledgeFilePublication(workspaceId: string): boolean {
    return this.recoveryBlocked(() => { this.getWorkspace(workspaceId); return hasKnowledgeFilePublicationBlocker(this.db, workspaceId); });
  }
  hasUncertainKnowledgeGeneration(workspaceId: string): boolean {
    return this.recoveryBlocked(() => {
      this.getWorkspace(workspaceId);
      return this.knowledgeGenerationRecords?.hasBlocker(workspaceId) ?? hasKnowledgeGenerationBlocker(this.db, workspaceId);
    });
  }
  getAttempt(id: string): ProviderAttempt { return this.executionRecords.getAttempt(id); }
  getLatestAttemptForTurn(turnId: string): ProviderAttempt | null { return this.evidenceRead(() => this.executionRecords.getLatestAttemptForTurn(turnId)); }
  createAttemptCleanup(identity: AttemptCleanupIdentity): AttemptCleanupRecord { return this.attemptCleanupRecords.create(identity); }
  dispatchAttemptCleanup(id: string): AttemptCleanupRecord { return this.attemptCleanupRecords.dispatch(id); }
  settleAttemptCleanup(id: string, outcome: AttemptCleanupSettlement): AttemptCleanupRecord { return this.attemptCleanupRecords.settle(id, outcome); }
  getAttemptCleanup(id: string, expectedSessionId?: string): AttemptCleanupRecord { return this.attemptCleanupRecords.get(id, expectedSessionId); }

  createMcpExecution(identity: McpExecutionIdentity): McpExecutionRecord { return this.mcpExecutionRecords.create(identity); }
  dispatchMcpExecution(id: string, boundary?: McpDispatchBoundary): McpExecutionRecord { return this.mcpExecutionRecords.dispatch(id, boundary); }
  settleMcpExecution(id: string, outcome: McpExecutionSettlement): McpExecutionRecord { return this.mcpExecutionRecords.settle(id, outcome); }
  getMcpExecution(id: string, expectedSessionId?: string): McpExecutionRecord { return this.mcpExecutionRecords.get(id, expectedSessionId); }
  hasUncertainMcpExecutions(workspaceId: string): boolean { this.assertOpen(); return hasMcpExecutionUncertainty(this.db,workspaceId); }
  getSummaryOverflowDependency(summaryAttemptId: string, turnId: string, failedAttemptId: string) { return this.evidenceRead(() => summaryOverflowDependency(this.db, this, summaryAttemptId, turnId, failedAttemptId)); }
  createHostCommandStorage(): HostCommandStorage {
    return new HostCommandStorage(this.db, { transaction: operation => this.db.isTransaction ? operation() : this.transaction(operation), appendEvent: (sessionId,type,payload) => { this.native.appendEvent(sessionId,type,payload); this.publishAfterCommit(() => this.notify(sessionId)); } });
  }
  validateHostCommands(): void { this.evidenceRead(() => validateHostCommandDatabase(this.db)); }
  hasUncertainExecution(workspaceId: string): boolean {
    return this.recoveryBlocked(() => {
      this.getWorkspace(workspaceId);
      return hasHostCommandUncertainty(this.db,workspaceId) || hasExecutionUncertainty(this.db, this, workspaceId, {
        hasValidSummaryAcknowledgment: (sessionId, id) => this.summaryRecovery?.hasValidAcknowledgment(sessionId, id) ?? false,
        hasValidProviderAcknowledgment: (sessionId, id) => this.providerRecovery?.hasValidAcknowledgment(sessionId, id) ?? false,
        hasUnacknowledgedProviders: workspaceId => this.providerRecovery?.hasUnacknowledged(workspaceId) ?? true,
      });
    });
  }
  configureProviderRecovery(bindingScope: (workspaceId: string) => string): void {
    this.assertOpen();
    if (this.providerRecovery) throw new EngineError('PROVIDER_RECOVERY_ALREADY_CONFIGURED', 'Provider recovery has already been bound');
    this.providerRecovery = new ProviderRecoveryStorage(this.native, this, { bindingScope, startupHighWater: this.providerRecoveryHighWater,
      appendLegacy: (run, type, payload) => this.append(run, type, payload) });
  }
  getProviderRecoveryPreview(sessionId: string, attemptId: string) {
    this.assertOpen();
    if (!this.providerRecovery) throw new EngineError('PROVIDER_RECOVERY_NOT_CONFIGURED', 'Provider recovery requires a host storage binding');
    return this.providerRecovery.preview(sessionId, attemptId);
  }
  acknowledgeProviderRecovery(request: ProviderRecoveryRequest) {
    this.assertOpen();
    if (!this.providerRecovery) throw new EngineError('PROVIDER_RECOVERY_NOT_CONFIGURED', 'Provider recovery requires a host storage binding');
    return this.providerRecovery.acknowledge(request);
  }
  findProviderRecoveryReceipt(request: ProviderRecoveryRequest) {
    this.assertOpen();
    if (!this.providerRecovery) throw new EngineError('PROVIDER_RECOVERY_NOT_CONFIGURED', 'Provider recovery requires a host storage binding');
    return this.providerRecovery.findReceipt(request);
  }
  putPart(part: MessagePart): MessagePart { return this.executionRecords.putPart(part); }
  listParts(turnId: string): MessagePart[] { return this.executionRecords.listParts(turnId); }
  listPartsPage(turnId: string, afterPartId?: string, limit?: number): PartPage { return this.executionRecords.listPartsPage(turnId, afterPartId, limit); }
  putContextRevision(revision: ContextRevision): ContextRevision { return this.executionRecords.putContextRevision(revision); }
  getContextRevision(id: string): ContextRevision { return this.executionRecords.getContextRevision(id); }
  nextContextRevisionIndex(sessionId: string): number { return this.executionRecords.nextContextRevisionIndex(sessionId); }
  getLatestContextRevision(sessionId: string): ContextRevision | null { return this.executionRecords.getLatestContextRevision(sessionId); }
  readActivePrefixSource(runId: string, options: ActivePrefixSourceOptions): ActivePrefixSource {
    return this.transaction(() => readActivePrefixSourceDatabase(this.db, this.getRun(runId), options), false);
  }
  commitActivePrefixCheckpoint(runId: string, payload: JsonObject, change: PreparedActivePrefix & ActivePrefixContextPublication): EngineEvent {
    const event = this.transaction(() => {
      const run = this.getRun(runId);
      validateActivePrefixPublication(this.db, run, change);
      if (payload.summaryAttemptId !== change.checkpoint.id || payload.scope !== 'active-run-prefix' || payload.revisionId !== change.summaryRevision.id || payload.contextRevisionId !== change.contextRevision.id
        || canonical(payload.usage) !== canonical(change.checkpoint.usage)) throw new EngineError('ACTIVE_PREFIX_BINDING_MISMATCH', 'Summary completion payload must match its checkpoint');
      this.summaryRecords.completeInTransaction(runId, change.checkpoint.id, 'active-run-prefix', change.summaryRevision.id, change.summaryRevision.text, change.checkpoint.usage,
        { sessionId: run.sessionId, workspaceId: run.workspaceId, providerId: change.source.providerId, modelId: change.source.modelId, sourceProjection: change.source.projection,
          sourceSha256: change.source.factsSha256, manifestSha256: change.source.manifestSha256, policySha256: change.source.policySha256,
          sourceMessageIds: change.source.sourceMessageIds, sourceTurnIds: change.source.sourceTurnIds, expectedMemoryRevision: change.source.expectedMemoryRevision,
          expectedContextHeadRevision: change.source.expectedContextHeadRevision, priorCheckpointId: change.source.priorCheckpointId,
          boundaryTurnId: change.source.boundaryTurnId, boundaryAttemptId: change.source.boundaryAttemptId, currentTurnId: change.source.currentTurnId, failedAttemptId: change.source.failedAttemptId }, change.contextRevision.id);
      this.executionRecords.putContextRevision(change.summaryRevision);
      this.executionRecords.putContextRevision(change.contextRevision);
      this.executionRecords.putSessionDocument(run.sessionId, 'context.active_memory', change.source.expectedMemoryRevision,
        { active: JSON.parse(JSON.stringify(change.checkpoint)) as JsonObject });
      this.executionRecords.putSessionDocument(run.sessionId, 'context.head', change.source.expectedContextHeadRevision, change.contextData);
      const completed = this.native.appendEvent(run.sessionId, 'summary.completed', payload, { runId });
      const result = this.append(run, 'summary.completed', completed.payload);
      const activated = this.native.appendEvent(run.sessionId, 'context.revision.activated', { contextRevisionId: change.contextRevision.id,
        revision: change.contextRevision.revision, sha256: change.contextRevision.sha256, summaryAttemptId: change.checkpoint.id }, { runId });
      this.append(run, 'context.revision.activated', activated.payload);
      return result;
    });
    this.notify(event.sessionId);
    return event;
  }
  commitContextDocument(runId: string, eventType: string, payload: JsonObject, change: { revision: ContextRevision; kind: string; expectedRevision: number; data: JsonObject }): EngineEvent {
    const event = this.transaction(() => {
      const run = this.getRun(runId);
      if (isTerminal(run.state) || run.state === 'cancelling') throw new EngineError('RUN_TERMINAL', 'Context activation requires an active Run');
      if (change.revision.sessionId !== run.sessionId || change.revision.runId !== run.id) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Context activation belongs to another Run');
      if (eventType === 'summary.completed' && typeof payload.summaryAttemptId === 'string' && this.db.prepare('SELECT 1 FROM summary_attempts WHERE id=?').get(payload.summaryAttemptId)) {
        const checkpoint = change.data.active as JsonObject | undefined;
        if (change.kind !== 'context.memory' || change.revision.kind !== 'summary' || !checkpoint || checkpoint.version !== 1 || checkpoint.sessionId !== run.sessionId || checkpoint.runId !== runId || typeof payload.summaryAttemptId !== 'string' || payload.summaryAttemptId !== checkpoint.id || payload.revisionId !== change.revision.id || change.revision.id !== checkpoint.revisionId
          || canonical(payload.usage) !== canonical(checkpoint.usage)) throw new EngineError('SUMMARY_BINDING_MISMATCH', 'Summary completion must match its memory checkpoint');
        const prepared = this.summaryRecords.get(payload.summaryAttemptId, run.sessionId), priorData = this.executionRecords.getSessionDocument(run.sessionId, 'context.memory')?.data.active;
        const prior = priorData && typeof priorData === 'object' && !Array.isArray(priorData) ? priorData as JsonObject : undefined;
        if (checkpoint.cutoffRunId !== prepared.sourceRunIds?.at(-1) || prepared.priorCheckpointId !== undefined && (prepared.priorCheckpointId !== prior?.id || typeof prior.revisionId !== 'string')) throw new EngineError('SUMMARY_BINDING_MISMATCH', 'Summary cutoff and prior revision must match its prepared source');
        const sourceIds = [...(prepared.sourceMessageIds ?? []), ...(prepared.priorCheckpointId ? [prior?.revisionId] : [])];
        if (canonical(change.revision.sourceIds) !== canonical(sourceIds) || prepared.priorCheckpointId !== undefined && prepared.priorCheckpointId !== prior?.id) throw new EngineError('SUMMARY_BINDING_MISMATCH', 'Immutable summary revision must match the pinned source and prior checkpoint');
        this.summaryRecords.completeInTransaction(runId, payload.summaryAttemptId, 'completed-history', change.revision.id, change.revision.text, checkpoint.usage,
          { sessionId: run.sessionId, workspaceId: run.workspaceId, providerId: checkpoint.providerId as string, modelId: checkpoint.modelId as string, sourceProjection: 'conversation-text-v1',
            sourceSha256: checkpoint.sourceSha256 as string, sourceMessageIds: checkpoint.sourceMessageIds as string[], sourceRunIds: checkpoint.sourceRunIds as string[],
            expectedMemoryRevision: change.expectedRevision, priorCheckpointId: checkpoint.previousCheckpointId as string | undefined });
      }
      this.executionRecords.putContextRevision(change.revision);
      this.executionRecords.putSessionDocument(run.sessionId, change.kind, change.expectedRevision, change.data);
      const validated = this.native.appendEvent(run.sessionId, eventType, payload, { runId: run.id });
      return this.append(run, eventType, validated.payload);
    });
    this.notify(event.sessionId);
    return event;
  }
  getSessionDocument(sessionId: string, kind: string): SessionDocument | null { return this.executionRecords.getSessionDocument(sessionId, kind); }
  createKnowledgeStorage(ports: Omit<KnowledgeStoragePorts, 'writeTx' | 'getWorkspace'>): KnowledgeStorage {
    this.assertOpen();
    return new KnowledgeStorage(this.db, { ...ports, getWorkspace: id => this.getWorkspace(id), writeTx: operation => this.transaction(operation) });
  }
  createKnowledgeGenerationStorage(ports: Omit<KnowledgeGenerationStoragePorts, 'writeTx' | 'getWorkspace'>): KnowledgeGenerationStorage {
    this.assertOpen();
    if (this.knowledgeGenerationRecords) throw new EngineError('KNOWLEDGE_GENERATION_ALREADY_CONFIGURED', 'Native generation storage already has a host owner');
    return this.knowledgeGenerationRecords = new KnowledgeGenerationStorage(this.db, { ...ports, getWorkspace: id => this.getWorkspace(id), writeTx: operation => this.transaction(operation) });
  }
  createKnowledgeHostAdapter(ports: Omit<ConstructorParameters<typeof KnowledgeHostAdapter>[1], 'readTx' | 'getWorkspace'>): KnowledgeHostAdapter {
    this.assertOpen();
    return new KnowledgeHostAdapter(this.db, { ...ports, getWorkspace: id => this.getWorkspace(id), readTx: operation => this.transaction(operation, false) });
  }
  createKnowledgePublicationStorage(ports: Omit<KnowledgePublicationStoragePorts, 'writeTx' | 'getWorkspace'>): KnowledgePublicationStorage {
    this.assertOpen();
    if (this.knowledgePublicationRecords) throw new EngineError('KNOWLEDGE_PUBLICATION_ALREADY_CONFIGURED', 'Native publication storage already has a host owner');
    return this.knowledgePublicationRecords = new KnowledgePublicationStorage(this.db, { ...ports, getWorkspace: id => this.getWorkspace(id), writeTx: operation => this.transaction(operation) });
  }
  createKnowledgeFilePublicationStorage(ports: Omit<KnowledgeFilePublicationStoragePorts, 'writeTx' | 'getWorkspace'>): KnowledgeFilePublicationStorage {
    this.assertOpen();
    if (this.knowledgeFilePublicationRecords) throw new EngineError('KNOWLEDGE_FILE_ALREADY_CONFIGURED', 'Native physical publication storage already has a host owner');
    return this.knowledgeFilePublicationRecords = new KnowledgeFilePublicationStorage(this.db, { ...ports, getWorkspace: id => this.getWorkspace(id), writeTx: operation => this.db.isTransaction ? operation() : this.transaction(operation) });
  }
  createKnowledgeFileExecutionGuards(ports: Omit<ConstructorParameters<typeof KnowledgeFileExecutionGuards>[1], 'writeTx'>): KnowledgeFileExecutionGuards {
    return new KnowledgeFileExecutionGuards(this.db, { ...ports, writeTx: operation => this.transaction(operation) });
  }
  createKnowledgeContextSource(ports: Omit<KnowledgeContextSourcePorts, 'readTx' | 'getWorkspace'>): KnowledgeContextSource {
    this.assertOpen();
    return new KnowledgeContextSource(this.db, { ...ports, getWorkspace: id => this.getWorkspace(id), readTx: operation => this.evidenceRead(operation) });
  }
  createKnowledgeImportRecoveryStorage(ports: Omit<KnowledgeImportRecoveryStoragePorts, 'writeTx' | 'getWorkspace'>): KnowledgeImportRecoveryStorage {
    this.assertOpen();
    if (this.knowledgeImportRecoveryRecords) throw new EngineError('KNOWLEDGE_IMPORT_ALREADY_CONFIGURED', 'Native imported knowledge already has an original host recovery owner');
    return this.knowledgeImportRecoveryRecords = new KnowledgeImportRecoveryStorage(this.db, { ...ports, getWorkspace: id => this.getWorkspace(id), writeTx: operation => this.db.isTransaction ? operation() : this.transaction(operation) });
  }
  createDiagnosticExecutionObservationStorage(ports: Omit<DiagnosticExecutionObservationPorts, 'writeTx'>): DiagnosticExecutionObservationStorage {
    this.assertOpen();
    if (this.executionObservationRecords) throw new EngineError('EXECUTION_OBSERVATION_ALREADY_CONFIGURED', 'Native execution observations already have an original host owner');
    return this.executionObservationRecords = new DiagnosticExecutionObservationStorage(this.db, { ...ports, writeTx: operation => this.db.isTransaction ? operation() : this.transaction(operation) });
  }
  createProposalStorage(ports: Omit<ProposalStoragePorts, 'writeTx' | 'getWorkspace' | 'blobs'>): ProposalStorage {
    this.assertOpen();
    if (this.proposalRecords) throw new EngineError('PROPOSALS_ALREADY_CONFIGURED', 'Native proposals already have an original host owner');
    return this.proposalRecords = new ProposalStorage(this.db, { ...ports, blobs: new ProposalBlobStorage(this.db),
      getWorkspace: id => this.getWorkspace(id), writeTx: operation => this.db.isTransaction ? operation() : this.transaction(operation) });
  }
  createProposalApplyStorage(ports: Omit<ProposalApplyStoragePorts, 'writeTx'>): ProposalApplyStorage {
    this.assertOpen();
    if (this.proposalApplyRecords) throw new EngineError('PROPOSAL_APPLY_ALREADY_CONFIGURED', 'Native proposal application already has an original host owner');
    return this.proposalApplyRecords = new ProposalApplyStorage(this.db, { ...ports,
      writeTx: operation => this.db.isTransaction ? operation() : this.transaction(operation) });
  }
  createProposalApplyExecutionGuards(ports: Omit<ConstructorParameters<typeof ProposalApplyExecutionGuards>[1], 'writeTx'>): ProposalApplyExecutionGuards {
    this.assertOpen(); return new ProposalApplyExecutionGuards(this.db, { ...ports,
      writeTx: operation => this.db.isTransaction ? operation() : this.transaction(operation) });
  }
  createTeamStorage(ports: Omit<TeamStoragePorts, 'writeTx' | 'getWorkspace'>): TeamStorage {
    this.assertOpen();
    if (this.teamRecords) throw new EngineError('TEAMS_ALREADY_CONFIGURED', 'Native team storage already has an original host owner');
    return this.teamRecords = new TeamStorage(this.db, { ...ports, getWorkspace: id => this.getWorkspace(id),
      writeTx: operation => this.db.isTransaction ? operation() : this.transaction(operation) });
  }
  readWorkflowEffect(sessionId:string,instanceId:string,stageId:string){return this.evidenceRead(()=>readWorkflowEffect(this.db,sessionId,instanceId,stageId));}
  readWorkflowDelivery(sessionId:string,instanceId:string){return this.evidenceRead(()=>readWorkflowDelivery(this.db,sessionId,instanceId));}
  withWorkflowEffectsTransaction<T>(operation:()=>T):T {return this.db.isTransaction?operation():this.transaction(operation);}
  createWorkflowEffectStorage(ports:Omit<WorkflowEffectNativePorts,'transaction'|'putDocument'|'appendEvent'>):WorkflowEffectStorage {
    this.assertOpen();if(this.workflowEffectRecords)throw new EngineError('WORKFLOW_EFFECTS_ALREADY_BOUND','Workflow effects have one actual Root producer');
    return this.workflowEffectRecords=new WorkflowEffectStorage(this.db,{...ports,transaction:operation=>this.withWorkflowEffectsTransaction(operation),putDocument:(s,k,r,d)=>{this.executionRecords.putSessionDocument(s,k,r,d);},appendEvent:(s,t,d,inputId)=>{this.native.appendEvent(s,t,d,inputId?{inputId}:{});this.publishAfterCommit(()=>this.notify(s));}});
  }
  createWorkflowStorage(ports: Omit<WorkflowStoragePorts, 'writeTx' | 'getWorkspace'>): WorkflowStorage {
    this.assertOpen();
    if (this.workflowRecords) throw new EngineError('WORKFLOWS_ALREADY_CONFIGURED', 'Native workflows already have an original host owner');
    return this.workflowRecords = new WorkflowStorage(this.db, { ...ports, getWorkspace: id => this.getWorkspace(id),
      writeTx: operation => this.db.isTransaction ? operation() : this.transaction(operation) });
  }
  createScheduleStorage(ports: Omit<ScheduleStoragePorts, 'writeTx' | 'getWorkspace'>): ScheduleStorage {
    this.assertOpen();
    if (this.scheduleRecords) throw new EngineError('SCHEDULES_ALREADY_CONFIGURED', 'Native schedules already have an original root owner');
    return this.scheduleRecords = new ScheduleStorage(this.db, { ...ports, getWorkspace: id => this.getWorkspace(id),
      writeTx: operation => this.db.isTransaction ? operation() : this.transaction(operation) });
  }
  createAgentBackendStorage(ports: Omit<AgentBackendStoragePorts, 'writeTx' | 'getWorkspace'>): AgentBackendStorage {
    this.assertOpen();
    if (this.backendRecords) throw new EngineError('AGENT_BACKENDS_ALREADY_CONFIGURED', 'Native agent backends already have an original root owner');
    return this.backendRecords = new AgentBackendStorage(this.db, { ...ports, getWorkspace: id => this.getWorkspace(id),
      writeTx: operation => this.db.isTransaction ? operation() : this.transaction(operation) });
  }
  createJobStorage(ports: Omit<JobStoragePorts, 'writeTx' | 'getWorkspace'>): JobStorage {
    this.assertOpen();
    if (this.jobRecords) throw new EngineError('JOBS_ALREADY_CONFIGURED', 'Native jobs already have an original root owner');
    return this.jobRecords = new JobStorage(this.db, { ...ports, getWorkspace: id => this.getWorkspace(id),
      writeTx: operation => this.db.isTransaction ? operation() : this.transaction(operation) });
  }
  createPrFeedbackStorage(): PrFeedbackStorage { return new PrFeedbackStorage(this.db, {
    writeTx:operation=>this.db.isTransaction?operation():this.transaction(operation),
    writeDocument:(sessionId,kind,revision,data)=>this.executionRecords.putSessionDocument(sessionId,kind,revision,data),
    appendEvent:(sessionId,type,payload,refs)=>this.native.appendEvent(sessionId,type,payload,refs),
  }); }
  validatePrFeedback():void {this.evidenceRead(()=>validatePrFeedbackDatabase(this.db));}
  validatePrVerificationEvidence(evidence:unknown):void {this.evidenceRead(()=>validateCommitVerification(this.db,evidence as import('../git/types.js').GitCommitPreview));}
  createGitCommitStorage(): GitCommitStorage {
    return new GitCommitStorage(this.db, {
      writeTx: operation => this.db.isTransaction ? operation() : this.transaction(operation),
      writeDocument: (sessionId,kind,revision,data) => this.executionRecords.putSessionDocument(sessionId,kind,revision,data),
      appendEvent: (sessionId,type,payload) => this.native.appendEvent(sessionId,type,payload),
    });
  }
  commitGitCommitObservation(sessionId:string, type:'git.commit.supervisor_admitted'|'git.commit.process_admitted'|'git.commit.closed'|'git.commit.reconciled', payload:JsonObject): SessionEventV2 {
    const write=()=>this.native.appendEvent(sessionId,type,payload);
    const event=this.db.isTransaction?write():this.transaction(write);this.notify(sessionId);return event;
  }
  hasKnownGitCommitSupervisor(pid:number):boolean {return this.evidenceRead(()=>hasKnownGitCommitSupervisor(this.db,pid));}
  readGitCommitProcessEvidence(sessionId:string,id:string) {return this.evidenceRead(()=>readGitCommitProcessEvidence(this.db,sessionId,id));}
  validateGitCommits():void { this.evidenceRead(()=>validateGitCommitDatabase(this.db)); }
  getGitCommitReceipt(workspaceId:string,sessionId:string,requestId:string) { return this.evidenceRead(()=>this.createGitCommitStorage().get(workspaceId,sessionId,requestId)); }
  inspectGitCommitReceipts(workspaceId:string) { return this.evidenceRead(()=>this.createGitCommitStorage().list(workspaceId)); }
  hasUncertainGitCommit(workspaceId:string):boolean { return this.recoveryBlocked(()=>hasUncertainGitCommit(this.db,workspaceId)); }
  putOwnedCommandJob(source: OwnedCommandJobSource, jobId: string, expectedRevision: number, data: JsonObject): SessionDocument {
    const write = () => {
      const record = validateOwnedCommandJob(data), run = this.getRun(source.runId), tool = this.getToolCall(source.toolCallId);
      if (isTerminal(run.state) || run.workspaceId !== source.workspaceId || run.sessionId !== source.sessionId || tool.runId !== run.id || tool.name !== 'run_command'
        || record.source.sha256 !== source.sha256 || record.jobId !== jobId || record.revision !== expectedRevision + 1) throw new EngineError('COMMAND_JOB_OWNER_STALE', 'Command job updates require their actual nonterminal native owner');
      const kind = ownedCommandJobKind(jobId), previous = this.executionRecords.getSessionDocument(source.sessionId, kind);
      if (expectedRevision === 0) this.native.appendEvent(source.sessionId, 'command.job.source_admitted', { jobId, source: source as unknown as JsonObject, workspaceRoot: this.getWorkspace(source.workspaceId).root }, { runId: run.id, turnId: source.turnId, attemptId: source.attemptId });
      if (record.groupPid !== null && !previous?.data.groupPid) this.native.appendEvent(source.sessionId, 'command.job.process_admitted', { jobId, sourceSha256: source.sha256, groupPid: record.groupPid }, { runId: run.id, turnId: source.turnId, attemptId: source.attemptId });
      if (record.completion && !previous?.data.completion) this.native.appendEvent(source.sessionId, 'command.job.closed_observed', { jobId, sourceSha256: source.sha256, completionSha256: knowledgeHash(record.completion) }, { runId: run.id, turnId: source.turnId, attemptId: source.attemptId });
      const saved = this.executionRecords.putSessionDocument(source.sessionId, kind, expectedRevision, data);
      validateOwnedCommandJobDatabase(this.db); this.publishAfterCommit(() => this.notify(source.sessionId)); return saved;
    };
    return this.db.isTransaction ? write() : this.transaction(write);
  }
  getOwnedCommandJob(workspaceId: string, jobId: string) { return this.evidenceRead(() => readOwnedCommandJob(this.db, workspaceId, jobId)); }
  inspectOwnedCommandJobs(workspaceId: string, sessionId?: string) { return this.evidenceRead(() => readOwnedCommandJobs(this.db, workspaceId, sessionId)); }
  recoverOwnedCommandJobs(): number { return this.transaction(() => recoverInterruptedOwnedCommandJobs(this.db, { writeDocument: (sessionId, kind, expectedRevision, data) => this.executionRecords.putSessionDocument(sessionId,kind,expectedRevision,data) })); }
  deliverOwnedCommandResultAtomic(originalTarget: object, input: OwnedCommandDeliveryInput, ports: Pick<OwnedCommandDeliveryPorts,'readTargetOriginal'|'assertTarget'|'acceptAtomic'|'readAccepted'|'releaseAccepted'>) {
    const write = () => deliverOwnedCommandResultAtomic(this.db, originalTarget, input, {...ports,
      writeDocument: (sessionId,kind,expectedRevision,data) => this.executionRecords.putSessionDocument(sessionId,kind,expectedRevision,data),
      appendEvent: (sessionId,type,payload,refs) => this.native.appendEvent(sessionId,type,payload,refs) });
    return this.db.isTransaction ? write() : this.transaction(write);
  }
  getOwnedCommandJobDelivery(workspaceId: string, deliveryId: string) { return this.evidenceRead(() => readOwnedCommandDelivery(this.db,workspaceId,deliveryId)); }
  inspectOwnedCommandJobDeliveries(workspaceId: string, sessionId?: string) { return this.evidenceRead(() => readOwnedCommandDeliveries(this.db,workspaceId,sessionId)); }
  findOwnedCommandDeliveryForInput(input: Parameters<typeof findOwnedCommandDeliveryForInput>[1]) { return this.evidenceRead(() => findOwnedCommandDeliveryForInput(this.db,input)); }
  validateOwnedCommandDeliveries(): void { this.evidenceRead(() => validateOwnedCommandDeliveryDatabase(this.db)); }
  deliverHostCommandResultAtomic(originalTarget: object, input: HostCommandDeliveryInput, ports: Pick<HostCommandDeliveryPorts,'readTargetOriginal'|'assertTarget'|'acceptAtomic'|'readAccepted'|'releaseAccepted'>) {
    const write = () => deliverHostCommandResultAtomic(this.db, originalTarget, input, {...ports,
      writeDocument: (sessionId,kind,expectedRevision,data) => this.executionRecords.putSessionDocument(sessionId,kind,expectedRevision,data),
      appendEvent: (sessionId,type,payload,refs) => this.native.appendEvent(sessionId,type,payload,refs) });
    return this.db.isTransaction ? write() : this.transaction(write);
  }
  getHostCommandJobDelivery(workspaceId: string, deliveryId: string) { return this.evidenceRead(() => readHostCommandDelivery(this.db,workspaceId,deliveryId)); }
  inspectHostCommandJobDeliveries(workspaceId: string, sessionId?: string) { return this.evidenceRead(() => readHostCommandDeliveries(this.db,workspaceId,sessionId)); }
  findHostCommandDeliveryForInput(input: Parameters<typeof findHostCommandDeliveryForInput>[1]) { return this.evidenceRead(() => findHostCommandDeliveryForInput(this.db,input)); }
  validateHostCommandDeliveries(): void { this.evidenceRead(() => validateHostCommandDeliveryDatabase(this.db)); }
  /** Only genuine Root terminal readers publish these session-scoped observations. */
  commitTerminalJobObservation(sessionId: string, type: 'terminal.source_admitted' | 'terminal.output_observed' | 'terminal.source_closed', payload: JsonObject): SessionEventV2 {
    if (!['terminal.source_admitted', 'terminal.output_observed', 'terminal.source_closed'].includes(type)) throw new EngineError('INVALID_SESSION_OBSERVATION', 'Unknown terminal observation type');
    const append = () => { this.getSession(sessionId); return this.native.appendEvent(sessionId, type, payload); };
    if (this.db.isTransaction) { const event = append(); this.publishAfterCommit(() => this.notify(sessionId)); return event; }
    const event = this.transaction(append); this.notify(sessionId); return event;
  }
  /** Archive relocation pauses historical knowledge without rebinding its original physical trust. */
  pauseImportedWorkspaceKnowledge(workspaceId: string, archiveSha256: string, origin?: { readonly importId: string; readonly sourcePrimaryLogicalSha256: string; readonly sourceStorageBindingSha256: string }): void {
    this.transaction(() => {
      const workspace = this.getWorkspace(workspaceId);
      this.createGitCommitStorage().pause(workspaceId, archiveSha256);
      this.createPrFeedbackStorage().pause(workspaceId,archiveSha256);
      for (const session of this.listSessions(workspaceId)) if (this.getConversationFork(session.id)) { const old=this.getSessionDocument(session.id,'conversation.fork.import'); if (old?.data.kind !== 'target-only-history') this.executionRecords.putSessionDocument(session.id,'conversation.fork.import',old?.revision??0,{paused:true,archiveSha256}); }
      pauseImportedProposals(this.db, workspaceId, archiveSha256);
      pauseImportedProposalApplies(this.db, workspaceId, archiveSha256);
      pauseImportedTeams(this.db, workspaceId, archiveSha256);
      markImportedWorkflowsPaused(this.db, archiveSha256, workspaceId);
      pauseImportedWorkflowEffects(this.db,workspaceId,{putDocument:(s,k,r,d)=>{this.executionRecords.putSessionDocument(s,k,r,d);},appendEvent:(s,t,d,inputId)=>{this.native.appendEvent(s,t,d,inputId?{inputId}:{});}});
      markImportedSchedulesDisabled(this.db, archiveSha256, workspaceId);
      markImportedAgentBackendsPaused(this.db, archiveSha256, workspaceId);
      markImportedJobsPaused(this.db, archiveSha256, workspaceId);
      pauseImportedOwnedCommandJobs(this.db, workspaceId, archiveSha256, { writeDocument: (sessionId,kind,expectedRevision,data) => this.executionRecords.putSessionDocument(sessionId,kind,expectedRevision,data) });
      this.createHostCommandStorage().pauseImport(workspaceId,archiveSha256);
      pauseImportedOwnedCommandDeliveries(this.db, workspaceId, archiveSha256, { writeDocument: (sessionId,kind,expectedRevision,data) => this.executionRecords.putSessionDocument(sessionId,kind,expectedRevision,data) });
      pauseImportedHostCommandDeliveries(this.db, workspaceId, archiveSha256, { writeDocument: (sessionId,kind,expectedRevision,data) => this.executionRecords.putSessionDocument(sessionId,kind,expectedRevision,data) });
      if (origin) {
        // Imported runtime capabilities are absent. Persist the ordinary native
        // interrupted-owner transition before pinning recovery; this performs
        // no provider dispatch, target write, marker removal or source rebinding.
        const denied = (): never => { throw new EngineError('KNOWLEDGE_IMPORT_PAUSED', 'Archive quarantine cannot dispatch or approve an effect'); };
        const base = { writeTx: <T>(operation: () => T): T => operation(), getWorkspace: (id: string) => this.getWorkspace(id), checkBinding: denied };
        new KnowledgeGenerationStorage(this.db, { ...base, getPlan: denied, assertPlanCurrent: denied }).recoverInterruptedOwners();
        new KnowledgePublicationStorage(this.db, { ...base, getCandidate: denied, assertCommitCurrent: denied }).recoverInterruptedOwners();
        const guardHeaders = this.db.prepare("SELECT g.publication_id FROM knowledge_file_execution_guards g JOIN knowledge_file_publications p ON p.workspace_id=g.workspace_id AND p.id=g.publication_id WHERE p.state='prepared' ORDER BY g.id LIMIT 129").all();
        if (guardHeaders.length > 128) throw new EngineError('KNOWLEDGE_IMPORT_LIMIT', 'Imported physical effect guards exceed the native quarantine cap');
        new KnowledgeFilePublicationStorage(this.db, { ...base, getCandidate: denied, assertCommitCurrent: denied }).recoverInterruptedOwners(guardHeaders.map(row => String(row.publication_id)));
      }
      const record = validateKnowledgeArchiveRow({ table: 'knowledge_import_pauses', key: workspaceId, workspaceId, data: { workspaceId, archiveSha256, createdAt: new Date().toISOString(), state: 'paused' } });
      this.db.prepare('INSERT INTO knowledge_import_pauses(id,workspace_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(workspaceId, workspaceId, JSON.stringify(record.data));
      if (origin) {
        // The physical workspace can be absent at import. Preserve an actual
        // historical root pin when available instead of inventing old inode proof.
        const trustHead = this.db.prepare('SELECT revision_id FROM workspace_trust_heads WHERE workspace_id=?').get(workspaceId);
        const trust = trustHead ? this.db.prepare('SELECT id,workspace_id,length(CAST(data AS BLOB)) AS bytes,substr(data,1,65537) AS data FROM workspace_trust_revisions WHERE id=? AND workspace_id=?').get(String(trustHead.revision_id), workspaceId) : undefined;
        if (trust && (Number(trust.bytes) < 1 || Number(trust.bytes) > 65_536)) throw new EngineError('KNOWLEDGE_IMPORT_LIMIT', 'Historical workspace binding exceeds the import read cap');
        const raw = trust ? validateKnowledgeArchiveRow({ table: 'workspace_trust_revisions', key: trust.id, workspaceId, data: JSON.parse(String(trust.data)) }).data as import('../knowledge/types.js').TrustRevision : undefined;
        const originalBinding = raw ? validateBinding(raw.binding) : null;
        if (originalBinding && originalBinding.root !== workspace.root) throw new EngineError('KNOWLEDGE_IMPORT_BINDING_MISMATCH', 'Historical workspace root differs from the imported workspace');
        const native = new KnowledgeImportRecoveryStorage(this.db, { writeTx: operation => operation(), getWorkspace: id => this.getWorkspace(id),
          checkBinding: () => { throw new EngineError('KNOWLEDGE_IMPORT_PAUSED', 'Archive seeding grants no physical binding authority'); },
          assertCommitCurrent: () => { throw new EngineError('KNOWLEDGE_IMPORT_PAUSED', 'Archive seeding grants no recovery approval'); } });
        native.seedImport({ workspaceId, archiveSha256, ...origin, originalBinding, pauseSha256: knowledgeHash(record.data) });
      }
    });
  }
  putSessionDocument(sessionId: string, kind: string, expectedRevision: number, data: JsonObject): SessionDocument { return this.executionRecords.putSessionDocument(sessionId, kind, expectedRevision, data); }
  getRun(id: string): Run {
    this.assertOpen();
    const row = this.ownerRow('runs', id);
    if (!row) throw new EngineError('RUN_NOT_FOUND', `Run ${id} was not found`);
    return decode(row);
  }
  hasActiveRuns(workspaceId: string, excludedRunId?: string): boolean {
    this.getWorkspace(workspaceId);
    return this.db.prepare("SELECT 1 FROM runs WHERE workspace_id=? AND state IN ('created','running','awaiting_approval','cancelling') AND (? IS NULL OR id<>?) LIMIT 1").get(workspaceId, excludedRunId ?? null, excludedRunId ?? null) !== undefined;
  }
  hasRunRequest(sessionId: string, requestId: string): boolean {
    const session = this.getSession(sessionId);
    return this.db.prepare(`SELECT 1 FROM inputs i JOIN runs r ON r.input_id=i.id
      WHERE i.session_id=? AND i.request_id=? AND r.session_id=? AND r.workspace_id=?
      AND json_extract(r.data,'$.requestId')=? LIMIT 1`).get(sessionId, requestId, sessionId, session.workspaceId, requestId) !== undefined;
  }
  getLastRunAssistantContent(runId: string): string {
    return this.transaction(() => {
      const run = this.getRun(runId), session = this.getSession(run.sessionId);
      const owner = this.db.prepare('SELECT session_id,workspace_id FROM runs WHERE id=?').get(runId)!;
      if (run.id !== runId || session.id !== run.sessionId || session.workspaceId !== run.workspaceId || owner.session_id !== run.sessionId || owner.workspace_id !== run.workspaceId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Child output owner is inconsistent');
      const configured = run.config?.limits?.maxOutputBytes;
      if (!Number.isSafeInteger(configured) || configured < 1 || configured > 1_048_576) throw new EngineError('CHILD_OUTPUT_READ_LIMIT', 'Child output budget is outside the supported read bound');
      const row = this.db.prepare(`SELECT session_id,run_id,json_type(data,'$.content') AS content_type,
        substr(json_extract(data,'$.id'),1,257) AS payload_id,substr(json_extract(data,'$.sessionId'),1,257) AS payload_session_id,
        substr(json_extract(data,'$.runId'),1,257) AS payload_run_id,
        CASE WHEN length(CAST(id AS BLOB))<=256 THEN id ELSE NULL END AS id,
        length(CAST(json_extract(data,'$.content') AS BLOB)) AS content_bytes,
        CASE WHEN json_type(data,'$.content')='text' AND length(CAST(json_extract(data,'$.content') AS BLOB))<=? THEN json_extract(data,'$.content') ELSE NULL END AS content
        FROM messages WHERE run_id=? AND json_extract(data,'$.role')='assistant' ORDER BY ordinal DESC LIMIT 1`).get(configured, runId);
      if (!row) return '';
      if (row.session_id !== run.sessionId || row.run_id !== runId || row.payload_session_id !== run.sessionId || row.payload_run_id !== runId || row.payload_id !== row.id || row.id === null) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Child output message has an inconsistent owner');
      if (row.content_type !== 'text' || Number(row.content_bytes) > configured || typeof row.content !== 'string') throw new EngineError('CHILD_OUTPUT_READ_LIMIT', 'Latest child assistant content exceeds its bounded UTF-8 read budget');
      return row.content;
    }, false);
  }

  private append(run: Run, type: string, payload: JsonObject): EngineEvent {
    const row = this.db.prepare('UPDATE sessions SET last_seq=last_seq+1 WHERE id=? AND last_seq < ? RETURNING last_seq').get(run.sessionId, Number.MAX_SAFE_INTEGER);
    if (!row) throw new EngineError('SEQUENCE_EXHAUSTED', 'Session event sequence exceeded the safe integer range');
    const event: EngineEvent = { schemaVersion: SCHEMA_VERSION, eventId: randomUUID(), sessionId: run.sessionId, runId: run.id, seq: Number(row.last_seq), timestamp: new Date().toISOString(), type, payload };
    this.db.prepare('INSERT INTO events(session_id,seq,event_id,run_id,type,data) VALUES(?,?,?,?,?,?)').run(event.sessionId, event.seq, event.eventId, event.runId, type, encode(event));
    return event;
  }
  private assertScope(run: Run, record: { runId: string; sessionId?: string }): void {
    if (record.runId !== run.id || (record.sessionId !== undefined && record.sessionId !== run.sessionId)) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Record belongs to a different run or session');
  }
  private writeMessage(run: Run, message: Message): void {
    this.assertScope(run, message);
    const previous = this.row('SELECT data FROM messages WHERE id=?', message.id);
    if (previous) {
      const old = decode<Message>(previous);
      requireMatch([old.runId, old.sessionId, old.role, old.createdAt], [message.runId, message.sessionId, message.role, message.createdAt], 'Message identity cannot change');
    }
    this.db.prepare('INSERT INTO messages(id,session_id,run_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(message.id, message.sessionId, message.runId, encode(message));
  }
  private writeTool(run: Run, tool: ToolCallRecord): void {
    this.assertScope(run, tool);
    const previous = this.row('SELECT data FROM tools WHERE id=?', tool.id);
    if (previous) {
      const old = decode<ToolCallRecord>(previous);
      requireMatch([old.runId, old.sessionId, old.name, old.input], [tool.runId, tool.sessionId, tool.name, tool.input], 'Tool identity and input cannot change');
      if (['completed', 'failed', 'denied', 'interrupted'].includes(old.state)) requireMatch(old, tool, 'Finished tool record cannot change');
    }
    this.db.prepare('INSERT INTO tools(id,session_id,run_id,state,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data').run(tool.id, tool.sessionId, tool.runId, tool.state, encode(tool));
  }
  private writeApproval(run: Run, approval: ApprovalRecord): void {
    this.assertScope(run, approval);
    const toolRow = this.row('SELECT data FROM tools WHERE id=?', approval.toolCallId);
    if (!toolRow) throw new EngineError('TOOL_NOT_FOUND', `Tool ${approval.toolCallId} was not found`);
    const tool = decode<ToolCallRecord>(toolRow);
    this.assertScope(run, tool);
    if (tool.name !== approval.toolName) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Approval tool name does not match its tool');
    const previous = this.row('SELECT data FROM approvals WHERE id=?', approval.id);
    if (previous) {
      const old = decode<ApprovalRecord>(previous);
      requireMatch([old.runId, old.sessionId, old.toolCallId, old.toolName, old.fingerprint, old.preview, old.createdAt], [approval.runId, approval.sessionId, approval.toolCallId, approval.toolName, approval.fingerprint, approval.preview, approval.createdAt], 'Approval identity and request cannot change');
      if (old.status !== 'pending') requireMatch(old, approval, 'Resolved approval cannot change');
    }
    this.db.prepare('INSERT INTO approvals(id,session_id,run_id,tool_call_id,status,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(approval.id, approval.sessionId, approval.runId, approval.toolCallId, approval.status, encode(approval));
  }
  private writeCheckpoint(run: Run, checkpoint: Checkpoint): void {
    this.assertScope(run, checkpoint);
    const toolRow = this.row('SELECT data FROM tools WHERE id=?', checkpoint.toolCallId);
    if (!toolRow) throw new EngineError('TOOL_NOT_FOUND', `Tool ${checkpoint.toolCallId} was not found`);
    this.assertScope(run, decode<ToolCallRecord>(toolRow));
    const previous = this.row('SELECT data FROM checkpoints WHERE id=?', checkpoint.id);
    if (previous) { requireMatch(decode(previous), checkpoint, 'Checkpoint is immutable'); return; }
    this.db.prepare('INSERT INTO checkpoints(id,run_id,tool_call_id,data) VALUES(?,?,?,?)').run(checkpoint.id, checkpoint.runId, checkpoint.toolCallId, encode(checkpoint));
  }
  private apply(run: Run, change: CommitChange): Run {
    if (change.run) {
      run = { ...run, ...change.run, updatedAt: new Date().toISOString() };
      this.db.prepare('UPDATE runs SET state=?,data=? WHERE id=?').run(run.state, encode(run), run.id);
    }
    if (change.message) this.writeMessage(run, change.message);
    if (change.tool) this.writeTool(run, change.tool);
    if (change.approval) this.writeApproval(run, change.approval);
    if (change.checkpoint) this.writeCheckpoint(run, change.checkpoint);
    return run;
  }
  private expirePendingApprovals(run: Run, reason: 'run_terminal' | 'recovery'): void {
    const pending = this.rows<ApprovalRecord>("SELECT data FROM approvals WHERE run_id=? AND session_id=? AND status='pending' ORDER BY ordinal", run.id, run.sessionId);
    const resolvedAt = new Date().toISOString();
    for (const approval of pending) {
      const expired: ApprovalRecord = { ...approval, status: 'expired', resolvedAt };
      this.writeApproval(run, expired);
      this.append(run, 'approval.expired', {
        approvalId: approval.id, toolCallId: approval.toolCallId, toolName: approval.toolName,
        status: 'expired', reason, approval: JSON.parse(encode(expired)),
      });
    }
  }
  commit(runId: string, type: string, payload: JsonObject, change: CommitChange = {}): EngineEvent {
    const event = this.transaction(() => {
      let run = this.getRun(runId);
      if (isTerminal(run.state)) throw new EngineError('RUN_TERMINAL', 'Run is already terminal', { runId, state: run.state });
      const target = change.run?.state;
      if (target !== undefined && target !== run.state && !TRANSITIONS[run.state].includes(target)) throw new EngineError('INVALID_RUN_TRANSITION', `Cannot change run state from ${run.state} to ${target}`);
      if (target !== undefined && isTerminal(target) && type !== `run.${target}`) throw new EngineError('INVALID_TERMINAL_EVENT', 'Terminal state must be recorded with its terminal event');
      if (['run.completed', 'run.cancelled', 'run.failed', 'run.interrupted'].includes(type) && target !== type.slice(4)) throw new EngineError('INVALID_TERMINAL_EVENT', 'Terminal event must change the run to its matching state');
      run = this.apply(run, change);
      // Run termination and approval expiry are one durable state change. Publish
      // the Run terminal event last, so its cursor includes all approval outcomes.
      if (target !== undefined && isTerminal(target)) this.expirePendingApprovals(run, 'run_terminal');
      if (target === 'cancelled') this.native.setControlInTransaction(run.sessionId, true, 'run_cancelled');
      return this.append(run, type, payload);
    });
    this.notify(event.sessionId);
    return event;
  }

  /** Observation only: same active-Run transaction and scope checks in both journals. */
  commitRunObservation(runId: string, type: 'lifecycle.outcome' | 'tool.policy_decision' | 'tool.prepared' | 'backend.launch_reserved' | 'backend.connection_admitted', payload: JsonObject, refs: { turnId?: string; attemptId?: string } = {}): EngineEvent {
    if (!['lifecycle.outcome', 'tool.policy_decision', 'tool.prepared', 'backend.launch_reserved', 'backend.connection_admitted'].includes(type)) throw new EngineError('INVALID_RUN_OBSERVATION', 'Unsupported host observation type');
    const append = () => {
      const run = this.getRun(runId);
      if (isTerminal(run.state)) throw new EngineError('RUN_TERMINAL', 'Terminal Runs cannot accept late observations');
      const native = this.native.appendEvent(run.sessionId, type, payload, { runId, ...refs });
      return this.append(run, type, native.payload);
    };
    // Admission is read from an original process handle inside the backend's
    // primary write transaction. Its observation and connection receipt must
    // commit or roll back together.
    if (this.db.isTransaction && type === 'backend.connection_admitted') {
      const event = append();
      this.publishAfterCommit(() => this.notify(event.sessionId));
      return event;
    }
    const event = this.transaction(append);
    this.notify(event.sessionId);
    return event;
  }

  /** CAS plus the owning Run state are checked inside one primary write transaction. */
  putActiveRunDocument(runId: string, kind: string, expectedRevision: number, data: JsonObject): SessionDocument {
    let sessionId!: string;
    const document = this.transaction(() => {
      const run = this.getRun(runId); sessionId = run.sessionId;
      if (isTerminal(run.state) || run.state === 'cancelling') throw new EngineError('RUN_TERMINAL', 'Stopped Runs cannot accept verification publication');
      return this.executionRecords.putSessionDocument(sessionId, kind, expectedRevision, data);
    });
    this.notify(sessionId);
    return document;
  }

  /** One existing dispatched receipt can settle while its real native tool still owns cleanup. */
  putConsumedVerificationSettlement(identity: { runId: string; toolCallId: string; turnId: string; attemptId: string }, kind: string, expectedRevision: number, data: JsonObject): SessionDocument {
    let sessionId!: string;
    const saved = this.transaction(() => {
      const run = this.getRun(identity.runId); sessionId = run.sessionId;
      if (isTerminal(run.state)) throw new EngineError('RUN_TERMINAL', 'Terminal Runs cannot accept consumed settlement');
      const tool = this.getToolCall(identity.toolCallId), turn = this.getTurn(identity.turnId), attempt = this.getAttempt(identity.attemptId);
      const part = this.listParts(turn.id).find(value => value.type === 'tool' && value.toolCallId === tool.id);
      if (tool.runId !== run.id || tool.sessionId !== sessionId || tool.name !== 'verify_changes' || tool.state !== 'running' || turn.runId !== run.id || turn.sessionId !== sessionId || turn.state !== 'awaiting_tools' || attempt.runId !== run.id || attempt.sessionId !== sessionId || attempt.turnId !== turn.id || attempt.state !== 'completed' || !part || part.type !== 'tool' || part.name !== tool.name || part.runId !== run.id || part.sessionId !== sessionId || part.state !== 'open') throw new EngineError('VERIFICATION_SETTLEMENT_OWNER_INVALID', 'Consumed settlement does not match the still executing native tool, Turn, Attempt and Part');
      if (kind !== verificationDocumentKind(run.id)) throw new EngineError('VERIFICATION_SCOPE_MISMATCH', 'Consumed settlement can write only its exact Run receipt document');
      const before = this.getSessionDocument(sessionId, kind);
      if (!before || before.revision !== expectedRevision) throw new EngineError('SESSION_DOCUMENT_CONFLICT', 'Consumed settlement document revision changed');
      validateConsumedVerificationSettlement(before.data, data, { sessionId, runId: run.id, toolCallId: tool.id });
      if (before.data.workspaceId !== run.workspaceId || data.workspaceId !== run.workspaceId) throw new EngineError('VERIFICATION_SCOPE_MISMATCH', 'Consumed settlement workspace changed');
      return this.executionRecords.putSessionDocument(sessionId, kind, expectedRevision, data);
    });
    this.notify(sessionId);
    return saved;
  }

  /** Verification receipt revision and controller publication are one primary CAS transaction. */
  putActiveVerificationControllerDocument(runId: string, kind: string, expectedRevision: number, data: JsonObject, expectedVerificationRevision: number): SessionDocument {
    let sessionId!: string;
    const saved = this.transaction(() => {
      const run = this.getRun(runId); sessionId = run.sessionId;
      if (isTerminal(run.state) || run.state === 'cancelling') throw new EngineError('RUN_TERMINAL', 'Stopped Runs cannot publish task completion or repair stages');
      if (kind !== verificationControllerDocumentKind(runId) || data.runId !== run.id || data.sessionId !== sessionId || data.workspaceId !== run.workspaceId) throw new EngineError('VERIFICATION_SCOPE_MISMATCH', 'Controller publication must match its exact Run document');
      const observed = this.getSessionDocument(sessionId, verificationDocumentKind(runId));
      if ((observed?.revision ?? 0) !== expectedVerificationRevision) throw new EngineError('VERIFICATION_CONTROLLER_SOURCE_STALE', 'Verification receipt revision changed before controller CAS');
      return this.executionRecords.putSessionDocument(sessionId, kind, expectedRevision, data);
    });
    this.notify(sessionId); return saved;
  }
  /** Native continuation admission pins both actual verification ledgers in one CAS. */
  putActiveLifecycleContinuationDocument(runId: string, kind: string, expectedRevision: number, data: JsonObject,
    expected: { controllerRevision: number; verificationRevision: number; controllerSha256: string }): SessionDocument {
    let sessionId!: string;
    const saved = this.transaction(() => {
      const run = this.getRun(runId); sessionId = run.sessionId;
      if (isTerminal(run.state) || run.state === 'cancelling') throw new EngineError('RUN_TERMINAL', 'Stopped Runs cannot admit lifecycle continuation');
      if (this.getSessionControl(sessionId).paused) throw new EngineError('LIFECYCLE_CONTINUATION_STALE', 'Paused sessions cannot admit lifecycle continuation');
      if (expectedRevision !== 0 || this.getSessionDocument(sessionId, kind)) throw new EngineError('LIFECYCLE_CONTINUATION_LIMIT', 'The original Run may consume only one continuation document');
      if (kind !== lifecycleContinuationDocumentKind(runId) || data.runId !== runId || data.sessionId !== sessionId || data.workspaceId !== run.workspaceId)
        throw new EngineError('LIFECYCLE_CONTINUATION_STALE', 'Continuation document must match its exact native Run');
      const controller = this.getSessionDocument(sessionId, verificationControllerDocumentKind(runId)), verification = this.getSessionDocument(sessionId, verificationDocumentKind(runId));
      if (!controller || !verification || controller.revision !== expected.controllerRevision || verification.revision !== expected.verificationRevision
        || controller.data.stateSha256 !== expected.controllerSha256)
        throw new EngineError('LIFECYCLE_CONTINUATION_STALE', 'Actual verification ledgers changed before continuation admission');
      return this.executionRecords.putSessionDocument(sessionId, kind, expectedRevision, data);
    });
    this.notify(sessionId); return saved;
  }

  getSnapshot(sessionId: string): SessionSnapshot {
    return this.transaction(() => {
      const session = this.getSession(sessionId);
      const lastSeq = Number(this.db.prepare('SELECT last_seq FROM sessions WHERE id=?').get(sessionId)?.last_seq);
      return {
        session,
        runs: this.rows<Run>('SELECT data FROM runs WHERE session_id=? ORDER BY ordinal', sessionId),
        messages: this.rows<Message>('SELECT data FROM messages WHERE session_id=? ORDER BY ordinal', sessionId),
        tools: this.rows<ToolCallRecord>('SELECT data FROM tools WHERE session_id=? ORDER BY ordinal', sessionId),
        approvals: this.rows<ApprovalRecord>('SELECT data FROM approvals WHERE session_id=? ORDER BY ordinal', sessionId),
        lastSeq,
      };
    }, false);
  }
  getToolCall(toolCallId: string): ToolCallRecord {
    this.assertOpen();
    const row = this.row('SELECT data FROM tools WHERE id=?', toolCallId);
    if (!row) throw new EngineError('TOOL_NOT_FOUND', 'Tool call was not found');
    const tool = decode<ToolCallRecord>(row);
    this.assertScope(this.getRun(tool.runId), tool);
    return tool;
  }

  hasDeniedVerificationTool(runId: string): boolean {
    const run = this.getRun(runId);
    const row = this.db.prepare("SELECT id FROM tools WHERE run_id=? AND state='denied' AND json_extract(data,'$.name')='verify_changes' ORDER BY ordinal LIMIT 1").get(runId);
    if (!row) return false;
    const tool = this.getToolCall(String(row.id));
    if (tool.sessionId !== run.sessionId || tool.runId !== run.id || tool.name !== 'verify_changes' || tool.state !== 'denied') throw new EngineError('RECORD_SCOPE_MISMATCH', 'Verification denial belongs to another native owner');
    return true;
  }
  listToolApprovals(toolCallId: string): ApprovalRecord[] {
    return this.transaction(() => {
      const tool = this.getToolCall(toolCallId);
      const sizes = this.db.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM approvals WHERE tool_call_id=?').get(toolCallId)!;
      if (Number(sizes.count) > 8 || Number(sizes.bytes) > 32_768) throw new EngineError('TOOL_APPROVAL_LIMIT', 'Tool approval projection exceeds its read budget');
      const records = this.rows<ApprovalRecord>('SELECT data FROM approvals WHERE tool_call_id=? ORDER BY ordinal LIMIT 8', toolCallId);
      for (const record of records) this.assertScope(this.getRun(tool.runId), record);
      return records;
    }, false);
  }
  /** All pending decisions or an explicit read-limit failure; never a partial list. */
  listPendingRunApprovals(runId: string, limit = 64): ApprovalRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new EngineError('INVALID_PAGE_SIZE', 'Pending approval read limit must be between 1 and 64');
    return this.transaction(() => {
      const run = this.getRun(runId), session = this.getSession(run.sessionId);
      if (run.id !== runId || session.id !== run.sessionId || session.workspaceId !== run.workspaceId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Run approval owner is inconsistent');
      const metadata = this.db.prepare(`SELECT a.id,a.session_id,a.run_id,a.tool_call_id,length(CAST(a.data AS BLOB)) AS bytes,
        t.id AS tool_id,t.session_id AS tool_session_id,t.run_id AS tool_run_id,
        substr(json_extract(t.data,'$.id'),1,257) AS tool_payload_id,
        substr(json_extract(t.data,'$.sessionId'),1,257) AS tool_payload_session_id,
        substr(json_extract(t.data,'$.runId'),1,257) AS tool_payload_run_id,
        substr(json_extract(t.data,'$.name'),1,129) AS tool_name
        FROM approvals a LEFT JOIN tools t ON t.id=a.tool_call_id WHERE a.run_id=? AND a.status='pending' ORDER BY a.ordinal LIMIT ?`).all(runId, limit + 1);
      if (metadata.length > limit || metadata.reduce((total, row) => total + Number(row.bytes), 0) > 524_288) throw new EngineError('APPROVAL_READ_LIMIT', 'Pending approvals exceed their count or UTF-8 byte read budget');
      const records: ApprovalRecord[] = [];
      for (const row of metadata) {
        if (row.session_id !== run.sessionId || row.run_id !== runId || row.tool_id !== row.tool_call_id || row.tool_session_id !== run.sessionId || row.tool_run_id !== runId
          || row.tool_payload_id !== row.tool_id || row.tool_payload_session_id !== run.sessionId || row.tool_payload_run_id !== runId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Pending approval belongs to another owner');
        const record = decode<ApprovalRecord>(this.row('SELECT data FROM approvals WHERE id=?', row.id as string)!);
        this.assertScope(run, record);
        if (record.id !== row.id || record.toolCallId !== row.tool_call_id || record.toolName !== row.tool_name || record.status !== 'pending') throw new EngineError('RECORD_SCOPE_MISMATCH', 'Pending approval payload has an inconsistent identity');
        records.push(record);
      }
      return records;
    }, false);
  }
  /** Model context reads whole recent Run groups without first loading the entire transcript. */
  searchHistory(sessionId: string, options: HistorySearchOptions): HistorySearchPage {
    return this.transaction(() => { this.getSession(sessionId); return searchHistoryDatabase(this.db, sessionId, options); }, false);
  }
  readModelHistory(sessionId: string, maxMessages = 200, maxBytes = 8_388_608): ModelHistoryPage {
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 4096 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 33_554_432) {
      throw new EngineError('INVALID_MODEL_HISTORY_LIMIT', 'Model history needs bounded message and byte limits');
    }
    return this.transaction(() => {
      const session = this.getSession(sessionId);
      const activePage = (run: Run): ModelHistoryPage => {
        const lastSeq = Number(this.db.prepare('SELECT last_seq FROM sessions WHERE id=?').get(sessionId)?.last_seq);
        const active = readActiveHistoryWindow(this.db, session, run, lastSeq, maxMessages, maxBytes);
        const totalRuns = Number(this.db.prepare('SELECT count(*) AS count FROM runs WHERE session_id=?').get(sessionId)?.count);
        const totalMessages = Number(this.db.prepare('SELECT count(*) AS count FROM messages WHERE session_id=?').get(sessionId)?.count);
        return withSessionDocumentAnchor(this.db, withSessionImageAnchor(this.db, { snapshot: active.snapshot, omittedRuns: totalRuns-1, omittedMessages: totalMessages-active.snapshot.messages.length,
          beforeRunId: totalRuns > 1 ? run.id : null, activeWindow: active.window }, maxMessages, maxBytes), maxMessages, maxBytes);
      };
      const newest = this.db.prepare('SELECT id,state FROM runs WHERE session_id=? ORDER BY ordinal DESC LIMIT 1').get(sessionId);
      if (newest && !isTerminal(String(newest.state) as RunState)) {
        // Cardinality first: a long active Run must not scan all message/tool JSON
        // just to discover that its complete group cannot fit this bounded read.
        const count = Number(this.db.prepare('SELECT count(*) AS count FROM messages WHERE run_id=?').get(String(newest.id))?.count);
        if (count > maxMessages) return activePage(this.getRun(String(newest.id)));
      }
      const candidates = this.db.prepare(`SELECT runs.id,runs.ordinal,length(CAST(runs.data AS BLOB)) AS run_bytes,
        (SELECT count(*) FROM messages WHERE run_id=runs.id) AS message_count,
        coalesce((SELECT sum(length(CAST(data AS BLOB))) FROM messages WHERE run_id=runs.id),0) AS message_bytes,
        coalesce((SELECT sum(length(CAST(data AS BLOB))) FROM tools WHERE run_id=runs.id),0) AS tool_bytes,
        coalesce((SELECT sum(length(CAST(data AS BLOB))) FROM approvals WHERE run_id=runs.id),0) AS approval_bytes
        FROM runs WHERE session_id=? ORDER BY ordinal DESC LIMIT 129`).all(sessionId);
      const selected: string[] = [];
      let messages = 0, bytes = Buffer.byteLength(JSON.stringify(session)) + 256;
      for (const row of candidates.slice(0, 128)) {
        const count = Number(row.message_count);
        const requiredBytes = Number(row.run_bytes) + Number(row.message_bytes) + Number(row.tool_bytes) + Number(row.approval_bytes) + 128;
        if (messages + count > maxMessages || bytes + requiredBytes > maxBytes) {
          if (!selected.length) {
            const run = this.getRun(String(row.id));
            if (!isTerminal(run.state)) return activePage(run);
            throw new EngineError('MODEL_HISTORY_LIMIT', 'The newest complete Run exceeds the required model history budget');
          }
          break;
        }
        selected.push(String(row.id)); messages += count; bytes += requiredBytes;
      }
      const lastSeq = Number(this.db.prepare('SELECT last_seq FROM sessions WHERE id=?').get(sessionId)?.last_seq);
      const snapshot: SessionSnapshot = { session, runs: [], messages: [], tools: [], approvals: [], lastSeq };
      if (selected.length) {
        const placeholders = selected.map(() => '?').join(',');
        snapshot.runs = this.rows<Run>(`SELECT data FROM runs WHERE session_id=? AND id IN (${placeholders}) ORDER BY ordinal`, sessionId, ...selected);
        // Native continuation metadata stays available to model projection.
        snapshot.messages = this.rows<Message>(`SELECT data FROM messages WHERE session_id=? AND run_id IN (${placeholders}) ORDER BY ordinal`, sessionId, ...selected);
        snapshot.tools = this.rows<ToolCallRecord>(`SELECT data FROM tools WHERE session_id=? AND run_id IN (${placeholders}) ORDER BY ordinal`, sessionId, ...selected);
        snapshot.approvals = this.rows<ApprovalRecord>(`SELECT data FROM approvals WHERE session_id=? AND run_id IN (${placeholders}) ORDER BY ordinal`, sessionId, ...selected);
        while (Buffer.byteLength(JSON.stringify(snapshot)) > maxBytes && snapshot.runs.length > 1) {
          const dropped = snapshot.runs.shift()!.id;
          snapshot.messages = snapshot.messages.filter(message => message.runId !== dropped);
          snapshot.tools = snapshot.tools.filter(tool => tool.runId !== dropped);
          snapshot.approvals = snapshot.approvals.filter(approval => approval.runId !== dropped);
        }
        if (Buffer.byteLength(JSON.stringify(snapshot)) > maxBytes) throw new EngineError('MODEL_HISTORY_LIMIT', 'The newest complete Run exceeds the required model history budget');
      }
      const totalRuns = Number(this.db.prepare('SELECT count(*) AS count FROM runs WHERE session_id=?').get(sessionId)?.count);
      const totalMessages = Number(this.db.prepare('SELECT count(*) AS count FROM messages WHERE session_id=?').get(sessionId)?.count);
      return withSessionDocumentAnchor(this.db, withSessionImageAnchor(this.db, { snapshot, omittedRuns: totalRuns - snapshot.runs.length, omittedMessages: totalMessages - snapshot.messages.length,
        beforeRunId: totalRuns > snapshot.runs.length ? snapshot.runs[0]?.id ?? null : null }, maxMessages, maxBytes), maxMessages, maxBytes);
    }, false);
  }
  /** GUI pages never expose native replay; the original journal remains intact. */
  getHistory(sessionId: string, beforeRunId?: string, limit = 20): SessionHistoryPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new EngineError('INVALID_PAGE_SIZE', 'History page size must be between 1 and 50');
    return this.transaction(() => {
      const session = this.getSession(sessionId);
      let before = Number.MAX_SAFE_INTEGER;
      if (beforeRunId !== undefined) {
        const row = this.db.prepare('SELECT ordinal FROM runs WHERE id=? AND session_id=?').get(beforeRunId, sessionId);
        if (!row) throw new EngineError('INVALID_HISTORY_CURSOR', 'History cursor does not belong to this session');
        before = Number(row.ordinal);
      }
      const rows = this.db.prepare('SELECT ordinal, data FROM runs WHERE session_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?').all(sessionId, before, limit).reverse();
      const runs = rows.map(row => decode<Run>(row as DataRow));
      const lastSeq = Number(this.db.prepare('SELECT last_seq FROM sessions WHERE id=?').get(sessionId)?.last_seq);
      const snapshot: SessionSnapshot = { session, runs, messages: [], tools: [], approvals: [], lastSeq };
      let truncatedRecords = false;
      if (runs.length) {
        const ids = runs.map(run => run.id);
        const placeholders = ids.map(() => '?').join(',');
        snapshot.messages = this.rows<Message>(`SELECT json_remove(data,'$.providerReplay') AS data FROM messages WHERE session_id=? AND run_id IN (${placeholders}) ORDER BY ordinal`, sessionId, ...ids);
        snapshot.tools = this.rows<ToolCallRecord>(`SELECT data FROM tools WHERE session_id=? AND run_id IN (${placeholders}) ORDER BY ordinal`, sessionId, ...ids);
        snapshot.approvals = this.rows<ApprovalRecord>(`SELECT data FROM approvals WHERE session_id=? AND run_id IN (${placeholders}) ORDER BY ordinal`, sessionId, ...ids);
        // Return whole Run groups whenever possible. Dropped groups remain reachable
        // through beforeRunId; never cut an active approval's exact preview.
        while (Buffer.byteLength(JSON.stringify(snapshot)) > 4_194_304 && snapshot.runs.length > 1) {
          const dropped = snapshot.runs.shift()!.id;
          snapshot.messages = snapshot.messages.filter(message => message.runId !== dropped);
          snapshot.tools = snapshot.tools.filter(tool => tool.runId !== dropped);
          snapshot.approvals = snapshot.approvals.filter(approval => approval.runId !== dropped);
        }
        // Unusually large single Runs expose their recent records with a notice.
        // Historical native state is still available to the context builder.
        while (Buffer.byteLength(JSON.stringify(snapshot)) > 4_194_304 && snapshot.messages.length > 2) {
          snapshot.messages.splice(1, 1); truncatedRecords = true;
        }
        while (Buffer.byteLength(JSON.stringify(snapshot)) > 4_194_304 && snapshot.tools.some(tool => tool.state === 'completed' || tool.state === 'failed' || tool.state === 'denied')) {
          const index = snapshot.tools.findIndex(tool => tool.state === 'completed' || tool.state === 'failed' || tool.state === 'denied');
          snapshot.tools.splice(index, 1); truncatedRecords = true;
        }
        if (Buffer.byteLength(JSON.stringify(snapshot)) > 4_194_304) throw new EngineError('HISTORY_PAGE_TOO_LARGE', 'The current Run exceeds the display page budget; its original records remain stored');
      }
      const first = snapshot.runs[0];
      const ordinal = first ? Number(this.db.prepare('SELECT ordinal FROM runs WHERE id=?').get(first.id)?.ordinal) : 0;
      const hasMore = Boolean(this.db.prepare('SELECT 1 FROM runs WHERE session_id=? AND ordinal<? LIMIT 1').get(sessionId, ordinal));
      return { snapshot, hasMore, beforeRunId: first?.id ?? null, truncatedRecords };
    }, false);
  }

  getMetrics(sessionId: string): SessionMetrics {
    this.getSession(sessionId);
    const rows = this.rows<EngineEvent>("SELECT data FROM events WHERE session_id=? AND type IN ('run.usage','context.prepared') ORDER BY seq DESC LIMIT 2001", sessionId);
    const selected = rows.slice(0, 2000);
    const usage = selected.filter(event => event.type === 'run.usage');
    const sum = (key: 'inputTokens' | 'outputTokens'): number | null => {
      const values = usage.flatMap(event => typeof event.payload[key] === 'number' ? [event.payload[key] as number] : []);
      if (!values.length) return null;
      const count = values.reduce((total, value) => total + value, 0);
      return Number.isSafeInteger(count) ? count : null;
    };
    const context = selected.find(event => event.type === 'context.prepared')?.payload;
    return { observedUsageEvents: usage.length, inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), usageWindowTruncated: rows.length > 2000,
      context: context && typeof context.bytes === 'number' && typeof context.limit === 'number' && typeof context.turnIndex === 'number'
        ? { bytes: context.bytes, limit: context.limit, summaryIncluded: context.summaryIncluded === true, turnIndex: context.turnIndex } : null };
  }
  getNativeMetrics(sessionId?: string): NativeMetricsReport {
    return this.transaction(() => {
      if (sessionId !== undefined) this.getSession(sessionId);
      return readNativeMetrics(this.db, sessionId);
    }, false);
  }

  inspectInputImageIndex(options?: InputImageIndexOptions): InputImageIndexReport {
    return this.transaction(() => inspectInputImageIndex(this.db, options), false);
  }
  inspectInputDocumentIndex(options?: InputDocumentIndexOptions): InputDocumentIndexReport {
    return this.transaction(() => inspectInputDocumentIndex(this.db, options), false);
  }
  inspectChildStorageSelection(options: ChildStorageSelectionOptions, budget?: ChildStorageSelectionBudget): ChildStorageSelectionReport {
    return this.transaction(() => readChildStorageSelection(this.db, options, budget), false);
  }
  /** Root owner selection and index share one primary read snapshot and one cumulative budget. */
  inspectChildDocumentStorageSources(options: ChildStorageSelectionOptions, frame: ChildDocumentReadFrame): { selection: ChildStorageSelectionReport; rootIndex?: InputDocumentIndexReport } {
    return this.transaction(() => {
      frame.check();
      const selection = readChildStorageSelection(this.db, options, frame);
      if (frame.remainingMetadataBytes < 1 || frame.remainingRefs < 1 || frame.remainingRows < 3) return { selection };
      frame.check();
      const rootIndex = inspectInputDocumentIndex(this.db, {
        maxDocuments: Math.min(64, Math.floor(frame.remainingRows / 3)),
        maxJsonBytes: Math.min(frame.remainingMetadataBytes, 4_194_304),
        maxRefs: Math.min(frame.remainingRefs, 2048),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      frame.chargeIndex(rootIndex);
      frame.check();
      return { selection, rootIndex };
    }, false);
  }
  readEvents(sessionId: string, afterSeq: number, limit = PAGE_SIZE): EngineEvent[] {
    cursor(afterSeq);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new EngineError('INVALID_PAGE_SIZE', `Event page size must be between 1 and ${MAX_PAGE_SIZE}`);
    this.getSession(sessionId);
    return this.rows('SELECT data FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?', sessionId, afterSeq, limit);
  }
  subscribe(sessionId: string, afterSeq: number, signal?: AbortSignal): AsyncIterable<EngineEvent> {
    return this.subscribeStream(sessionId, afterSeq, (id, position) => this.readEvents(id, position), signal);
  }
  subscribeSessionEvents(sessionId: string, afterSeq: number, signal?: AbortSignal): AsyncIterable<SessionEventV2> {
    return this.subscribeStream(sessionId, afterSeq, (id, position) => this.readSessionEvents(id, position), signal);
  }
  private async *subscribeStream<T extends { seq: number }>(sessionId: string, afterSeq: number, read: (id: string, position: number) => T[], signal?: AbortSignal): AsyncIterable<T> {
    cursor(afterSeq);
    this.getSession(sessionId);
    let position = afterSeq;
    while (!this.closed && !signal?.aborted) {
      // Register before reading: a commit between a read and a wait cannot be missed.
      let release!: () => void;
      const changed = new Promise<void>(resolvePromise => { release = resolvePromise; });
      const waiter: Waiter = { sessionId, wake: release };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', release, { once: true });
      try {
        const page = read(sessionId, position);
        if (page.length > 0) {
          for (const event of page) {
            if (this.closed || signal?.aborted) return;
            position = event.seq;
            yield event;
          }
        } else {
          await changed;
        }
      } finally {
        this.waiters.delete(waiter);
        signal?.removeEventListener('abort', release);
      }
    }
  }
  getApproval(id: string): ApprovalRecord {
    this.assertOpen();
    const row = this.row('SELECT data FROM approvals WHERE id=?', id);
    if (!row) throw new EngineError('APPROVAL_NOT_FOUND', `Approval ${id} was not found`);
    return decode(row);
  }
  listCheckpoints(runId: string): Checkpoint[] {
    this.getRun(runId);
    return this.rows('SELECT data FROM checkpoints WHERE run_id=? ORDER BY ordinal', runId);
  }

  recoverInterrupted(): Run[] {
    const sessions = new Set<string>();
    const recovered = this.transaction(() => {
      // Exact MCP prepared intents can prove no dispatch. Settle them before
      // capturing generic running intent, without leaving the recovery TX.
      this.mcpExecutionRecords.recoverInTransaction(sessions);
      const toolFrontiers = captureToolRecoveryFrontiers(this.native, {
        getMcpExecution: (id, sessionId) => this.mcpExecutionRecords.get(id, sessionId),
        appendLegacy: (run, type, payload) => this.append(run, type, payload),
      });
      const active = this.rows<Run>(`SELECT data FROM runs WHERE state IN (${ACTIVE_STATES}) ORDER BY ordinal`);
      const affected = this.rows<Run>(`SELECT DISTINCT runs.data, runs.ordinal FROM runs LEFT JOIN tools ON tools.run_id=runs.id LEFT JOIN approvals ON approvals.run_id=runs.id WHERE runs.state IN (${ACTIVE_STATES}) OR tools.state IN ('requested','awaiting_approval','running') OR approvals.status='pending' ORDER BY runs.ordinal`);
      for (let run of affected) {
        const tools = this.rows<ToolCallRecord>("SELECT data FROM tools WHERE run_id=? AND state IN ('requested','awaiting_approval','running') ORDER BY ordinal", run.id);
        for (const tool of tools) {
          const interrupted: ToolCallRecord = { ...tool, state: 'interrupted', error: 'Engine process ended before the tool outcome was recorded' };
          this.writeTool(run, interrupted);
          this.append(run, 'tool.interrupted', { toolCallId: tool.id, tool: JSON.parse(encode(interrupted)) });
        }
        this.expirePendingApprovals(run, 'recovery');
        if (!isTerminal(run.state)) {
          const error = { code: 'ENGINE_INTERRUPTED', message: 'Engine process ended before this run finished' };
          run = this.apply(run, { run: { state: 'interrupted', error } });
          this.append(run, 'run.interrupted', { state: 'interrupted', error });
        }
        sessions.add(run.sessionId);
      }
      this.summaryRecords.recoverInTransaction(sessions);
      this.attemptCleanupRecords.recoverInTransaction(sessions);
      this.executionRecords.recoverInTransaction(sessions, toolFrontiers);
      return active.map(run => this.getRun(run.id));
    });
    for (const sessionId of sessions) this.notify(sessionId);
    return recovered;
  }

  integrityCheck(): IntegrityCheckResult {
    return this.transaction(() => inspectIntegrity(this.db, DB_VERSION), false);
  }

  async backup(destination: string, options: StoreBackupOptions = {}): Promise<DatabaseBackup> {
    this.assertOpen();
    const checkCancelled = () => {
      this.assertOpen();
      if (options.signal?.aborted) throw new EngineError('BACKUP_ABORTED', 'SQLite backup was cancelled');
    };
    checkCancelled();
    this.pendingBackups++;
    let reader: DatabaseSync | undefined;
    try {
      if (this.databasePath !== ':memory:') {
        reader = new DatabaseSync(this.databasePath, { readOnly: true, timeout: 1_000 });
        reader.exec('BEGIN');
        // Fix a WAL read snapshot before the native job starts. The live writer uses
        // a different handle, so its transactions cannot produce SQLITE_LOCKED here.
        reader.prepare('SELECT last_seq FROM sessions LIMIT 1').get();
      }
      return await backupDatabase(reader ?? this.db, destination, DB_VERSION, checkCancelled, !reader);
    }
    finally {
      let readerFailure: EngineError | undefined;
      try { reader?.close(); }
      catch {
        readerFailure = new EngineError('STORE_CLOSE_FAILED', 'SQLite backup read connection could not be released');
        this.backupConnectionFailure ??= readerFailure;
      }
      this.pendingBackups--;
      if (this.closed && this.pendingBackups === 0) this.releaseConnections();
      if (readerFailure) throw readerFailure;
    }
  }

  private releaseConnections(): void {
    if (this.released) return;
    this.released = true;
    // Keep ownership until native backup, validation, publication and cleanup have settled.
    const failures: unknown[] = [];
    if (this.backupConnectionFailure) failures.push(this.backupConnectionFailure);
    try { this.db.close(); } catch (error) { failures.push(error); }
    try { this.ownership?.close(); } catch (error) { failures.push(error); }
    if (failures.length) {
      const error = new EngineError('STORE_CLOSE_FAILED', 'SQLite storage connections could not be fully released', { failedConnections: failures.length });
      this.rejectClose(error);
      throw error;
    }
    this.resolveClose();
  }

  async closeAsync(): Promise<void> {
    this.close();
    await this.closeCompletion;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of [...this.waiters]) waiter.wake();
    this.waiters.clear();
    // Never unlink a lock file: existing contenders might still hold its inode open.
    if (this.pendingBackups === 0) this.releaseConnections();
  }
}
