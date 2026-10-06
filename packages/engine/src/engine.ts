import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { EngineError, isTerminal, SCHEMA_VERSION, SESSION_SCHEMA_VERSION, SESSION_COMMAND_TYPES, type CommandEnvelope, type CommandResult, type EngineCapabilities, type EngineEvent, type InputCursor, type JsonValue, type Run, type RunConfig, type RunConfigInput, type Session, type SessionCommandResult, type SessionEventV2 } from '@moodcode/contracts';
import { normalizeAcceptInput, normalizeEngineBudgets, normalizeSubmitInput, validateCommand, validateSessionCommand } from '@moodcode/contracts/validation';
import type { ProviderAdapter, ToolDefinition } from './ports.js';
import { SqliteStore, type DatabaseBackup, type IntegrityCheckResult, type StoreBackupOptions } from './storage/index.js';
import { RunCoordinator } from './runner/index.js';
import { InputScheduler } from './runner/input-scheduler.js';
import { ScriptedProvider } from './provider/index.js';
import { ApprovalManager } from './permission/index.js';
import { openWorkspace } from './workspace/index.js';
import { getWorkspaceStatus, listWorkspaceFiles, readWorkspaceFile } from './workspace/presentation.js';
import { buildContext } from './context/index.js';
import { ContextService } from './context/service.js';
import { ModelRegistry, type ModelSpec } from './context/model-spec.js';
import { createReadTools } from './tools/read/index.js';
import { createPatchTool } from './tools/patch/index.js';
import { createCommandTool } from './tools/command/index.js';
import { createExactEditTool } from './tools/edit/index.js';
import { createFileActionTools } from './tools/file-actions/index.js';
import { createPatternSearchTools } from './tools/search/index.js';
import { ScopedToolRuntime } from './tools/runtime/index.js';
import { ToolPolicy, type ToolPolicyRule } from './permission/policy.js';
import { ScopedToolGrants } from './permission/grants.js';
import { QuestionManager, type QuestionAnswer } from './questions/index.js';
import { SessionTaskService } from './session-state/index.js';
import { createSessionTaskTools } from './tools/session/index.js';
import { createQuestionTool } from './tools/session/question.js';
import { createLocalReferenceTools } from './tools/session/skills.js';
import { createArtifactReadTool } from './tools/session/artifact.js';
import { ArtifactStore } from './artifacts/store.js';
import { EnginePluginManager, type EnginePlugin, type ActivePlugin } from './plugins/index.js';
import { McpClient, registerMcp, type McpRegistration } from './mcp/index.js';
import { AgentProfiles, type AgentProfileSpec } from './agents/index.js';
import { TerminalService, SqliteTerminalJournal, type PtyBackend } from './terminals/index.js';
import { EngineChildren, type EngineChildRequest } from './child-tasks/engine-host.js';
import type { ChildTaskManager, ChildTaskRecord } from './child-tasks/index.js';
import type { WorktreeManager } from './worktrees/index.js';
import { createChildMergeTool } from './child-tasks/merge.js';
import { LspManager, type LspFactory } from './lsp/index.js';
import { FormatterRegistry, createFormatTool, createLspFormatTool } from './formatters/index.js';
import { WorkspaceChangeHub, type WorkspaceChangeWatch, type WorkspaceFileChange } from './workspace/changes.js';
import { assertExecutionLockAvailable } from './tools/command/execution-lock.js';
import { getReviewDiff, previewRestoreCheckpoint, restoreCheckpoint, type RestoreResult } from './review/index.js';
import { readRecoveryAcknowledgments, isRestoreAcknowledged } from './recovery/index.js';
import { ReviewJournal, type RestoreOperation, type RestoreOperationInput } from './review/audit.js';
import { ImageAttachmentStore } from './media/index.js';
import { providerImages } from './media/provider.js';
import type { InputImageAttachment } from '@moodcode/contracts';
import { createDelegateTaskTool } from './child-tasks/delegation.js';

export type RestoreCommandResult = RestoreResult & {
  operationId: string;
  duplicate: boolean;
  recordMetadataError?: { code: string; message: string };
};

export interface ReviewHistoryResult {
  runId: string;
  operations: RestoreOperation[];
}

function metadataFailure(): { code: string; message: string } {
  return { code: 'REVIEW_RECORD_FAILED', message: 'Restoration outcome could not be recorded; reconcile the quarantined workspace before further effects' };
}

const NATIVE_COMMANDS_ENABLED = ['input.accept', 'input.list', 'input.cancel', 'session.pause', 'session.resume', 'session.events', 'engine.getCapabilities', 'run.getTurns', 'turn.getParts', 'artifact.get', 'session.getTasks', 'session.setTasks', 'question.list', 'question.answer', 'question.reject', 'session.getContext', 'session.searchHistory', 'session.getDiagnostics'] as const;

export interface EngineOptions {
  dbPath: string;
  artifactDir?: string;
  providers?: ProviderAdapter[];
  tools?: ToolDefinition[];
  defaults?: RunConfigInput;
  toolPolicy?: readonly ToolPolicyRule[];
  /** Trusted host policy shared by an owned child; grants remain local to each engine. */
  toolPolicyInstance?: ToolPolicy;
  modelSpecs?: readonly ModelSpec[];
  outputTokenReserve?: number;
  agentProfiles?: readonly AgentProfileSpec[];
  allowedToolNames?: readonly string[];
  ptyBackend?: PtyBackend;
  worktreeDirectory?: string;
  /** Root task namespace for a host-owned nested engine. No additional tools or grants. */
  childTaskScope?: { tasks: ChildTaskManager; worktrees: WorktreeManager; sessionId: string };
  configureChild?: (engine: MoodcodeEngine, task: Readonly<ChildTaskRecord>) => void;
}
function json(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return null;
  return JSON.parse(encoded) as JsonValue;
}

function verifyExecutionIdle(lockPath: string): void {
  try {
    assertExecutionLockAvailable(lockPath);
  } catch (error) {
    if (error instanceof EngineError && error.code === 'COMMAND_EFFECTS_BUSY') {
      throw new EngineError('CLEANUP_PENDING', 'A command supervisor is still cleaning up a previous engine execution; reopen after cleanup');
    }
    throw error;
  }
}

function withImageInputs(provider: ProviderAdapter, images: ImageAttachmentStore, store: SqliteStore, models: ModelRegistry): ProviderAdapter {
  return { id: provider.id, ...(provider.replayProtocol ? { replayProtocol: provider.replayProtocol } : {}),
    ...(provider.retryableHttpStatuses ? { retryableHttpStatuses: provider.retryableHttpStatuses } : {}),
    ...(provider.inputModalities ? { inputModalities: provider.inputModalities } : {}),
    async *streamTurn(request, signal) {
      if (request.resolvedImages !== undefined) throw new EngineError('PROVIDER_INVALID_REQUEST', 'Image bytes must be resolved by the engine');
      const refs = new Map<string, InputImageAttachment>();
      for (const message of request.messages) for (const ref of message.attachments ?? []) {
        if (message.role !== 'user') throw new EngineError('PROVIDER_INVALID_REQUEST', 'Image references belong to user messages');
        const previous = refs.get(ref.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(ref)) throw new EngineError('PROVIDER_INVALID_REQUEST', 'Conflicting image references');
        refs.set(ref.id, ref);
      }
      if (!refs.size) { yield* provider.streamTurn(request, signal); return; }
      const run = store.getRun(request.runId);
      if (request.sessionId !== run.sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Image request belongs to another session');
      const modalities = models.get(provider.id, request.modelId).modalities;
      if (!provider.inputModalities?.includes('image') || modalities !== null && !modalities.includes('image')) throw new EngineError('PROVIDER_UNSUPPORTED_INPUT', 'Selected provider or model does not support image input');
      const resolvedImages = await images.resolve(run.sessionId, [...refs.values()], signal);
      const resolved = { ...request, resolvedImages };
      providerImages(resolved, true, signal);
      yield* provider.streamTurn(resolved, signal);
    },
  };
}

export class MoodcodeEngine {
  readonly store: SqliteStore;
  readonly coordinator: RunCoordinator;
  readonly scheduler: InputScheduler;
  readonly toolRuntime: ScopedToolRuntime;
  readonly approvals: ApprovalManager;
  readonly questions: QuestionManager;
  readonly tasks: SessionTaskService;
  readonly context: ContextService;
  private readonly images: ImageAttachmentStore;
  private readonly pendingImages = new Set<Promise<unknown>>();
  private readonly validateImageInput: (sessionId: string, config: RunConfig, refs: InputImageAttachment[]) => Promise<void>;
  private readonly managedArtifacts: () => Promise<ArtifactStore>;
  readonly plugins: EnginePluginManager;
  readonly profiles: AgentProfiles;
  readonly terminals: TerminalService;
  readonly children: EngineChildren;
  readonly lsp: LspManager;
  readonly formatters: FormatterRegistry;
  readonly changes: WorkspaceChangeHub;
  private readonly watchConsumers = new Map<string, Promise<void>>();
  private readonly languageServers = new Map<string, (path: string) => string | null>();
  private readonly lspChanges = new Map<string, { version: number; done: Promise<void> }>();
  private readonly observationFailures = new Map<string, string>();
  private readonly terminalJournal: SqliteTerminalJournal;
  private readonly hostResources = new AbortController();
  private readonly mcp = new Map<string, McpRegistration>();
  private readonly pendingMcp = new Map<string, Promise<McpRegistration>>();
  private readonly mcpClients = new Map<string, McpClient>();
  readonly reviewJournal: ReviewJournal;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly defaults: RunConfig;
  private readonly hostAllowedTools?: readonly string[];
  private readonly capabilities: EngineCapabilities;
  private readonly executionLockPath: string;
  private readonly restoreRequests = new Map<string, { binding: RestoreOperationInput; promise: Promise<RestoreCommandResult> }>();

  constructor(options: EngineOptions) {
    if (!options || typeof options.dbPath !== 'string' || options.dbPath.length === 0) {
      throw new EngineError('INVALID_CONFIG', 'dbPath must be a non-empty string');
    }
    this.defaults = normalizeSubmitInput({ sessionId: 'defaults', requestId: 'defaults', prompt: 'defaults', config: options.defaults ?? {} }).config;
    const dbPath = options.dbPath === ':memory:' ? options.dbPath : resolve(options.dbPath);
    const artifactDir = options.artifactDir !== undefined ? resolve(options.artifactDir)
      : dbPath === ':memory:' ? mkdtempSync(join(tmpdir(), 'moodcode-memory-artifacts-')) : resolve(`${options.dbPath}.artifacts`);
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    this.store = new SqliteStore(dbPath, this.defaults.budgets);
    let reviewJournal: ReviewJournal | undefined;
    let terminalJournal: SqliteTerminalJournal | undefined;
    try {
      const canonicalDbPath = dbPath === ':memory:' ? undefined : realpathSync(dbPath);
      this.executionLockPath = canonicalDbPath === undefined ? resolve(artifactDir, 'effects.sqlite') : `${canonicalDbPath}.effects.sqlite`;
      verifyExecutionIdle(this.executionLockPath);
      reviewJournal = new ReviewJournal(canonicalDbPath === undefined ? resolve(artifactDir, 'review.sqlite') : `${canonicalDbPath}.review.sqlite`);
      this.reviewJournal = reviewJournal;
      this.store.recoverInterrupted();
      this.approvals = new ApprovalManager(this.store);
      this.questions = new QuestionManager(this.store);
      this.tasks = new SessionTaskService(this.store);
      this.profiles = new AgentProfiles(this.store, options.agentProfiles);
      this.lsp = new LspManager();
      this.formatters = new FormatterRegistry();
      this.changes = new WorkspaceChangeHub({ signal: this.hostResources.signal });
      this.children = new EngineChildren(this, options, options.worktreeDirectory ?? join(realpathSync(artifactDir), 'children'), value => new MoodcodeEngine(value));
      terminalJournal = new SqliteTerminalJournal(join(realpathSync(artifactDir), 'terminals.sqlite'));
      this.terminalJournal = terminalJournal;
      this.terminals = new TerminalService({ journal: terminalJournal, ...(options.ptyBackend ? { backend: options.ptyBackend } : {}), resolveOwner: owner => {
        const session = this.store.getSession(owner.sessionId);
        if (session.workspaceId !== owner.workspaceId) throw new EngineError('TERMINAL_AUTHORITY', 'Terminal session belongs to a different workspace');
        return { sessionId: session.id, workspaceId: session.workspaceId, root: this.store.getWorkspace(session.workspaceId).root };
      } });
      const models = new ModelRegistry();
      for (const spec of options.modelSpecs ?? []) models.put(spec);
      this.images = new ImageAttachmentStore({ directory: join(realpathSync(artifactDir), 'input-media'), documents: this.store });
      let artifacts: Promise<ArtifactStore> | undefined;
      const artifactBudgets = normalizeEngineBudgets(this.defaults.budgets);
      this.managedArtifacts = () => artifacts ??= ArtifactStore.open({ directory: join(realpathSync(artifactDir), 'managed'), limits: {
        maxArtifactBytes: artifactBudgets.maxArtifactBytes, maxProducerBytes: artifactBudgets.maxProducerBytes,
      } });
      const providers = new Map<string, ProviderAdapter>([['scripted', new ScriptedProvider()]]);
      for (const provider of options.providers ?? []) providers.set(provider.id, provider);
      this.validateImageInput = async (sessionId, config, refs) => {
        const modalities = models.get(config.providerId, config.modelId).modalities;
        if (!providers.get(config.providerId)?.inputModalities?.includes('image') || modalities !== null && !modalities.includes('image')) throw new EngineError('PROVIDER_UNSUPPORTED_INPUT', 'Selected provider or model does not support image input');
        await this.images.resolve(sessionId, refs, this.hostResources.signal);
        if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
      };
      for (const [id, provider] of providers) providers.set(id, withImageInputs(provider, this.images, this.store, models));
      this.context = new ContextService(this.store, models, options.outputTokenReserve, id => providers.get(id));
      const availableTools = options.tools ?? [...createReadTools(), createPatchTool(), createCommandTool(), createExactEditTool(), ...createFileActionTools(), ...createPatternSearchTools(), ...createSessionTaskTools(this.tasks), createQuestionTool(this.questions), ...createLocalReferenceTools(), createArtifactReadTool(this.store, this.managedArtifacts), createFormatTool(this.formatters), createLspFormatTool(this.lsp), createChildMergeTool(options.childTaskScope?.tasks ?? this.children.tasks, options.childTaskScope?.worktrees ?? this.children.worktrees, options.childTaskScope?.sessionId), createDelegateTaskTool(this.children.delegationHost(this.executionLockPath))];
      if (options.allowedToolNames && (new Set(options.allowedToolNames).size !== options.allowedToolNames.length || options.allowedToolNames.some(name => !availableTools.some(tool => tool.name === name)))) throw new EngineError('INVALID_TOOL_ALLOWLIST', 'Host tool allowlist must name unique available tools');
      this.hostAllowedTools = options.allowedToolNames ? [...options.allowedToolNames] : undefined;
      const tools = options.allowedToolNames ? availableTools.filter(tool => options.allowedToolNames!.includes(tool.name)) : availableTools;
      if (options.toolPolicy && options.toolPolicyInstance) throw new EngineError('INVALID_TOOL_POLICY', 'Specify rules or one trusted policy instance');
      this.toolRuntime = new ScopedToolRuntime({ policy: options.toolPolicyInstance ?? new ToolPolicy(options.toolPolicy), grants: new ScopedToolGrants(Date.now, this.store), artifacts: this.managedArtifacts });
      for (const tool of tools) this.toolRuntime.register('engine', tool, options.tools ? {} : tool.name === 'delegate_task' ? { exactApproval: true } : { revalidate: async (prepared, context) => {
        const current = await tool.prepare(prepared.input, context);
        if (current.fingerprint !== prepared.fingerprint || JSON.stringify(current.preview) !== JSON.stringify(prepared.preview)) throw new EngineError('TOOL_APPROVAL_STALE', 'Tool resources changed since scoped authorization');
      } });
      this.plugins = new EnginePluginManager(this.toolRuntime);
      this.capabilities = {
        schemaVersion: SCHEMA_VERSION,
        runtime: { node: process.versions.node, electron: process.versions.electron ?? null, platform: process.platform, commandExecution: process.platform === 'win32' ? 'unsupported' : 'posix-process-group' },
        providerIds: [...providers.keys()].sort(),
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: structuredClone(inputSchema) })),
        modes: ['plan', 'build'], defaults: structuredClone(this.defaults),
        features: { historyPaging: true, sessionMetrics: true },
        extensions: { sessionSchemaVersions: [SESSION_SCHEMA_VERSION], commands: [...NATIVE_COMMANDS_ENABLED] },
      };
      this.coordinator = new RunCoordinator({
        store: this.store,
        providers,
        tools,
        approvals: this.approvals,
        artifactDir,
        executionLockPath: this.executionLockPath,
        buildContext: request => this.context.build({ ...request, agentInstructions: this.profiles.forRun(request.snapshot.session.id, request.config)?.instructions }),
        contextSnapshot: (sessionId, config) => this.context.snapshot(sessionId, config),
        getContextRevisionId: sessionId => this.context.revisionId(sessionId),
        getAllowedTools: run => {
          const profile = this.profiles.forRun(run.sessionId, run.config)?.tools;
          return this.hostAllowedTools ? (profile ? profile.filter(name => this.hostAllowedTools!.includes(name)) : this.hostAllowedTools) : profile;
        },
        recoverContextOverflow: (request, provider) => this.context.recoverOverflow(request, provider),
        toolRuntime: this.toolRuntime,
        onToolCheckpoint: async observation => {
          await this.watchWorkspace(observation.workspace.id);
          const changes = await this.changes.recordCheckpoint({ ...observation, sessionId: observation.run.sessionId, runId: observation.run.id });
          await Promise.all(changes.map(change => this.syncLanguageServers(change)));
        },
      });
      this.scheduler = new InputScheduler({ store: this.store, coordinator: this.coordinator });
      const recoveredRestores = this.reviewJournal.recoverPending();
      const recoveryAcknowledgments = canonicalDbPath ? readRecoveryAcknowledgments({ dbPath: canonicalDbPath, artifactDir: realpathSync(artifactDir) }) : [];
      for (const operation of recoveredRestores) {
        const run = this.store.getRun(operation.runId);
        if (run.workspaceId !== operation.workspaceId || run.sessionId !== operation.sessionId
          || !this.store.listCheckpoints(run.id).some((checkpoint) => checkpoint.id === operation.checkpointId && checkpoint.runId === run.id)) {
          throw new EngineError('REVIEW_OPERATION_BINDING_MISMATCH', 'Interrupted restoration does not match the primary run and checkpoint');
        }
        if (!isRestoreAcknowledged(operation, recoveryAcknowledgments)) this.coordinator.quarantineWorkspace(operation.workspaceId);
      }
    } catch (error) {
      terminalJournal?.close();
      try { reviewJournal?.close(); }
      finally { this.store.close(); }
      throw error;
    }
  }

  /** Native inbox/session commands have their own explicit protocol and journal. */
  async dispatchSession(value: unknown): Promise<SessionCommandResult> {
    let commandId = '';
    try {
      const command = validateSessionCommand(value, { defaults: this.defaults, enabledCommands: NATIVE_COMMANDS_ENABLED });
      commandId = command.commandId;
      if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
      const payload = command.payload;
      let result: unknown;
      switch (command.type) {
        case 'engine.getCapabilities': result = this.getCapabilities(); break;
        case 'input.accept': {
          const input = normalizeAcceptInput(payload, this.defaults);
          input.config = this.profiles.apply(input.sessionId, input.config);
          if (input.attachments?.length && !this.store.lookupInputReceipt(input)) await this.validateImageInput(input.sessionId, input.config, input.attachments);
          result = this.scheduler.accept(input); break;
        }
        case 'input.list': result = this.store.listInputs(payload.sessionId as string, payload.cursor as unknown as InputCursor | undefined, payload.limit as number); break;
        case 'input.cancel': {
          const input = this.store.getInput(payload.inputId as string);
          if (input.sessionId !== payload.sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Input belongs to a different session');
          result = this.scheduler.cancelInput(input.id); break;
        }
        case 'session.pause': result = this.scheduler.pause(payload.sessionId as string); break;
        case 'session.resume': result = this.scheduler.resume(payload.sessionId as string); break;
        case 'session.events': {
          this.store.getSession(payload.sessionId as string);
          result = { sessionId: payload.sessionId, stream: 'session-v2', afterSeq: payload.afterSeq }; break;
        }
        case 'session.getTasks': result = this.tasks.get(payload.sessionId as string); break;
        case 'session.getContext': result = this.context.diagnostics(payload.sessionId as string); break;
        case 'session.getDiagnostics': {
          const session = this.store.getSession(payload.sessionId as string);
          result = { metrics: this.store.getNativeMetrics(session.id), context: this.context.diagnostics(session.id), workspaceObservation: { failure: this.observationFailures.get(session.workspaceId) ?? null, active: this.watchConsumers.has(session.workspaceId) } }; break;
        }
        case 'session.searchHistory': result = this.store.searchHistory(payload.sessionId as string, { query: payload.query as string, beforeMessageId: payload.beforeMessageId as string | undefined, limit: payload.limit as number, maxBytes: payload.maxBytes as number }); break;
        case 'session.setTasks': result = this.tasks.replace(payload.sessionId as string, payload.expectedRevision as number, payload.tasks); break;
        case 'question.list': result = this.questions.list(payload.sessionId as string); break;
        case 'question.answer': result = this.questions.answer(payload.sessionId as string, payload.questionId as string, payload.version as number, payload.answer as unknown as QuestionAnswer); break;
        case 'question.reject': result = this.questions.reject(payload.sessionId as string, payload.questionId as string, payload.version as number); break;
        case 'run.getTurns': result = this.store.listTurnsPage(payload.runId as string, payload.afterTurnId as string | undefined, payload.limit as number); break;
        case 'turn.getParts': result = this.store.listPartsPage(payload.turnId as string, payload.afterPartId as string | undefined, payload.limit as number); break;
        case 'artifact.get': {
          const run = this.store.getRun(payload.runId as string);
          if (run.sessionId !== payload.sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Artifact run belongs to a different session');
          const page = await (await this.managedArtifacts()).read(payload.artifactId as string, { identity: {
            sessionId: payload.sessionId as string, runId: run.id, toolCallId: payload.toolCallId as string,
            ...(payload.turnId ? { turnId: payload.turnId as string } : {}), ...(payload.attemptId ? { attemptId: payload.attemptId as string } : {}),
          }, offset: payload.offset as number, limit: payload.limit as number });
          result = { reference: page.reference, offset: page.offset, ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}), encoding: 'base64', content: Buffer.from(page.bytes).toString('base64') }; break;
        }
        default: throw new EngineError('UNKNOWN_COMMAND', 'Unknown session command');
      }
      return { schemaVersion: SESSION_SCHEMA_VERSION, commandId, ok: true, result: json(result) };
    } catch (error) {
      if (!commandId && value && typeof value === 'object') {
        try {
          const id = Object.getOwnPropertyDescriptor(value, 'commandId');
          if (id && 'value' in id && typeof id.value === 'string' && id.value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(id.value)) commandId = id.value;
        } catch { /* Invalid objects are contained by the command result boundary. */ }
      }
      const failure = error instanceof EngineError ? error : new EngineError('INTERNAL_ERROR', 'Session command failed');
      return { schemaVersion: SESSION_SCHEMA_VERSION, commandId, ok: false, error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) } };
    }
  }

  async dispatch(value: CommandEnvelope | unknown): Promise<CommandResult> {
    let commandId = '';
    try {
      const command = validateCommand(value, this.defaults);
      commandId = command.commandId;
      if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
      const payload = command.payload;
      let result: unknown;
      switch (command.type) {
        case 'engine.getCapabilities':
          result = this.getCapabilities();
          break;
        case 'workspace.open': {
          const workspace = await openWorkspace(payload.path as string);
          result = this.store.putWorkspace(workspace);
          break;
        }
        case 'workspace.getStatus':
          result = await getWorkspaceStatus(this.store.getWorkspace(payload.workspaceId as string));
          break;
        case 'file.list':
          result = await listWorkspaceFiles(this.store.getWorkspace(payload.workspaceId as string), payload.path as string | undefined, { ...(payload.limit === undefined ? {} : { limit: payload.limit as number }), ...(payload.continuation === undefined ? {} : { continuation: payload.continuation as string }) });
          break;
        case 'file.read':
          result = await readWorkspaceFile(this.store.getWorkspace(payload.workspaceId as string), payload.path as string);
          break;
        case 'session.create': {
          const workspaceId = payload.workspaceId as string;
          this.store.getWorkspace(workspaceId);
          const session: Session = { id: randomUUID(), workspaceId, title: (payload.title as string | undefined) ?? 'New session', createdAt: new Date().toISOString() };
          result = this.store.createSession(session);
          break;
        }
        case 'session.list': {
          this.store.getWorkspace(payload.workspaceId as string);
          result = this.store.listSessions(payload.workspaceId as string);
          break;
        }
        case 'session.getSnapshot':
          result = this.store.getSnapshot(payload.sessionId as string);
          break;
        case 'session.getHistory':
          result = this.store.getHistory(payload.sessionId as string, payload.beforeRunId as string | undefined, payload.limit as number | undefined);
          break;
        case 'session.getMetrics':
          result = this.store.getMetrics(payload.sessionId as string);
          break;
        case 'run.submit':
          {
            const input = normalizeSubmitInput(payload);
            input.config = this.profiles.apply(input.sessionId, input.config);
            if (input.attachments?.length && !this.store.lookupRunReceipt(input)) await this.validateImageInput(input.sessionId, input.config, input.attachments);
            result = this.scheduler.submitLegacy(input);
          }
          break;
        case 'run.cancel':
          result = this.coordinator.cancel(payload.runId as string);
          break;
        case 'approval.decide':
          result = this.approvals.decide(payload.approvalId as string, payload.decision as 'allow' | 'deny', payload.fingerprint as string);
          break;
        case 'review.getDiff':
          result = await getReviewDiff(this.store, payload.runId as string);
          break;
        case 'review.previewRestore': {
          const run = this.restoreRun(payload.runId as string, payload.checkpointId as string);
          result = await previewRestoreCheckpoint(this.store, this.store.getWorkspace(run.workspaceId), payload.checkpointId as string, { executionLockPath: this.executionLockPath });
          break;
        }
        case 'review.restore':
          result = await this.restore(command.commandId, payload.runId as string, payload.checkpointId as string, payload.previewFingerprint as string);
          break;
        case 'review.history': {
          const run = this.store.getRun(payload.runId as string);
          result = { runId: run.id, operations: this.reviewJournal.list(run.id) } satisfies ReviewHistoryResult;
          break;
        }
        case 'events.subscribe':
          this.store.getSession(payload.sessionId as string);
          result = { sessionId: payload.sessionId, afterSeq: payload.afterSeq ?? 0 };
          break;
        default:
          throw new EngineError('UNKNOWN_COMMAND', 'Unknown engine command');
      }
      return { schemaVersion: SCHEMA_VERSION, commandId, ok: true, result: json(result) };
    } catch (error) {
      if (!commandId && value && typeof value === 'object') {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(value, 'commandId');
          if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
            && descriptor.value.trim().length > 0 && descriptor.value.length <= 256
            && !/[\u0000-\u001f\u007f]/u.test(descriptor.value)
            && Buffer.byteLength(descriptor.value) <= 256) commandId = descriptor.value;
        } catch { /* Invalid object traps must not escape the command result boundary. */ }
      }
      return {
        schemaVersion: SCHEMA_VERSION,
        commandId,
        ok: false,
        error: error instanceof EngineError ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } : { code: 'INTERNAL_ERROR', message: 'Unexpected engine error' },
      };
    }
  }

  private restoreRun(runId: string, checkpointId: string): Run {
    const run = this.store.getRun(runId);
    if (!this.store.listCheckpoints(runId).some((checkpoint) => checkpoint.id === checkpointId && checkpoint.runId === runId)) {
      throw new EngineError('CHECKPOINT_RUN_MISMATCH', 'Checkpoint does not belong to the requested run');
    }
    return run;
  }

  private restoreReply(operation: RestoreOperation): RestoreCommandResult {
    if (operation.state === 'completed' && operation.result) return { ...operation.result, operationId: operation.id, duplicate: true };
    if (operation.state === 'started') throw new EngineError('RESTORE_PENDING', 'Restoration has already started and has no recorded final outcome; effects will not be replayed');
    if (operation.error) throw new EngineError(operation.error.code, operation.error.message);
    throw new EngineError('RESTORE_INTERRUPTED', 'Restoration has no confirmed outcome; effects will not be replayed');
  }

  private restore(commandId: string, runId: string, checkpointId: string, fingerprint: string): Promise<RestoreCommandResult> {
    const sameRequest = (binding: RestoreOperationInput): boolean => binding.runId === runId && binding.checkpointId === checkpointId && binding.fingerprint === fingerprint;
    const conflict = (): never => { throw new EngineError('REVIEW_JOURNAL_OPERATION_CONFLICT', 'Operation ID is already bound to a different restore request'); };
    const inFlight = this.restoreRequests.get(commandId);
    if (inFlight) {
      if (!sameRequest(inFlight.binding)) conflict();
      return inFlight.promise.then((result) => ({ ...result, duplicate: true }));
    }
    const existing = this.reviewJournal.get(commandId);
    if (existing) {
      if (!sameRequest(existing)) conflict();
      const recordedRun = this.restoreRun(runId, checkpointId);
      if (existing.sessionId !== recordedRun.sessionId || existing.workspaceId !== recordedRun.workspaceId) conflict();
      return Promise.resolve(this.restoreReply(existing));
    }
    const run = this.restoreRun(runId, checkpointId);
    if (!isTerminal(run.state)) throw new EngineError('RUN_NOT_TERMINAL', 'An active run cannot be restored');
    const workspace = this.store.getWorkspace(run.workspaceId);
    const binding: RestoreOperationInput = { id: commandId, runId, checkpointId, fingerprint, sessionId: run.sessionId, workspaceId: run.workspaceId };
    let observed: RestoreCommandResult | undefined;
    const lease = this.coordinator.withWorkspaceLease(workspace.id, async (signal) => {
      // All audit writes stay inside the lease so close cannot release either
      // SQLite connection while a restoration is still recording its outcome.
      try {
        // The public journal may have been updated after synchronous dispatch
        // admission but before this microtask. Never execute a known operation.
        const previous = this.reviewJournal.get(commandId);
        if (previous) {
          if ((Object.keys(binding) as (keyof RestoreOperationInput)[]).some((key) => previous[key] !== binding[key])) conflict();
          observed = this.restoreReply(previous);
          return observed;
        }
        this.reviewJournal.start(binding);
      }
      catch (error) {
        if (error instanceof EngineError) throw error;
        throw new EngineError('REVIEW_RECORD_FAILED', 'Restoration could not start because audit recording failed');
      }
      let restored: RestoreResult;
      try { restored = await restoreCheckpoint(this.store, workspace, checkpointId, { signal, executionLockPath: this.executionLockPath, previewFingerprint: fingerprint }); }
      catch (error) {
        const failure = error instanceof EngineError ? error : new EngineError('RESTORE_FAILED', 'Checkpoint restoration failed');
        try { this.reviewJournal.finish(commandId, { error: { code: failure.code, message: failure.message } }); }
        catch {
          this.coordinator.quarantineWorkspace(workspace.id);
          throw new EngineError(failure.code, failure.message, { ...(failure.details ?? {}), recordMetadataError: metadataFailure() });
        }
        throw failure;
      }
      observed = { ...restored, operationId: commandId, duplicate: false };
      if (restored.effectsUncertain || restored.executionBlocked) this.coordinator.quarantineWorkspace(workspace.id);
      if (restored.restored.length) {
        const checkpoint = this.store.listCheckpoints(run.id).find(item => item.id === checkpointId)!;
        try {
          await this.watchWorkspace(workspace.id);
          const restoredPaths = new Set(restored.restored);
          const changes = await this.changes.recordCheckpoint({ workspace, sessionId: run.sessionId, runId: run.id, toolCallId: checkpoint.toolCallId, signal,
            checkpoints: [{ ...checkpoint, id: `restore_${createHash('sha256').update(commandId).digest('hex')}`, createdAt: new Date().toISOString(), files: checkpoint.files.filter(file => restoredPaths.has(file.path)).map(file => ({ ...file, before: file.after, after: file.before, beforeHash: file.afterHash, afterHash: file.beforeHash })) }] });
          await Promise.all(changes.map(change => this.syncLanguageServers(change)));
        } catch { observed.warnings.push('Restoration effects were recorded, but workspace observation or language-service delivery could not be confirmed.'); }
      }
      try { this.reviewJournal.finish(commandId, restored); }
      catch {
        this.coordinator.quarantineWorkspace(workspace.id);
        observed.recordMetadataError = metadataFailure();
        observed.warnings = [...observed.warnings, observed.recordMetadataError.message];
      }
      return observed;
    });
    const pending = lease.catch((error: unknown) => {
      // A returned service result retains its observed partial effects even
      // when the coordinator refuses to claim confirmed cleanup.
      if (observed && error instanceof EngineError && error.code === 'CLEANUP_UNCERTAIN') return observed;
      throw error;
    }).finally(() => { this.restoreRequests.delete(commandId); });
    this.restoreRequests.set(commandId, { binding, promise: pending });
    void pending.catch(() => {});
    return pending;
  }

  subscribe(sessionId: string, afterSeq = 0, signal?: AbortSignal): AsyncIterable<EngineEvent> {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new EngineError('INVALID_CURSOR', 'afterSeq must be a non-negative safe integer');
    return this.store.subscribe(sessionId, afterSeq, signal);
  }

  subscribeSession(sessionId: string, afterSeq = 0, signal?: AbortSignal): AsyncIterable<SessionEventV2> {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.subscribeSessionEvents(sessionId, afterSeq, signal);
  }

  waitForSession(sessionId: string): Promise<void> { return this.scheduler.waitForSession(sessionId); }

  waitForRun(runId: string): Promise<Run> { return this.coordinator.waitForRun(runId); }

  startChildTask(request: EngineChildRequest) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.children.start(request);
  }

  registerLanguageServer(serverId: string, factory: LspFactory, languageForPath: (path: string) => string | null): void {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (typeof languageForPath !== 'function') throw new EngineError('INVALID_LSP_CONFIG', 'Host must explicitly select supported language paths');
    this.lsp.register(serverId, factory); this.languageServers.set(serverId, languageForPath);
  }

  async watchWorkspace(workspaceId: string): Promise<WorkspaceChangeWatch> {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    const workspace = this.store.getWorkspace(workspaceId), watch = await this.changes.watch(workspace, { signal: this.hostResources.signal });
    if (!this.watchConsumers.has(workspaceId)) {
      const consumer = (async () => {
        try { for await (const event of this.changes.subscribe(workspaceId, 0, this.hostResources.signal)) {
          if (event.type === 'change') await this.syncLanguageServers(event.change);
          else if (event.type === 'incomplete') this.observationFailures.set(workspaceId, event.code);
        } } catch (error) { if (!this.hostResources.signal.aborted) this.observationFailures.set(workspaceId, error instanceof EngineError ? error.code : 'WORKSPACE_OBSERVATION_FAILED'); }
      })();
      this.watchConsumers.set(workspaceId, consumer);
    }
    return watch;
  }

  private syncLanguageServers(change: WorkspaceFileChange): Promise<void> {
    const workspace = this.store.getWorkspace(change.workspaceId);
    return Promise.all([...this.languageServers].map(async ([serverId, selectLanguage]) => {
      const language = selectLanguage(change.path); if (!language) return;
      const key = JSON.stringify([workspace.id, serverId, change.path]), known = this.lspChanges.get(key);
      if (known && known.version >= change.documentVersion) return known.done;
      const done = this.lsp.fileChanged(workspace, serverId, change.path, language, change.kind, this.hostResources.signal).catch(error => {
        this.observationFailures.set(workspace.id, error instanceof EngineError ? error.code : 'LSP_UPDATE_FAILED');
        if (this.lspChanges.get(key)?.done === done) this.lspChanges.delete(key);
      });
      this.lspChanges.set(key, { version: change.documentVersion, done });
      if (this.lspChanges.size > 256) this.lspChanges.delete(this.lspChanges.keys().next().value!);
      return done;
    })).then(() => {});
  }

  createWorktree(sessionId: string, requestId: string, reference?: string) {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    const session = this.store.getSession(sessionId), workspace = this.store.getWorkspace(session.workspaceId);
    this.children.recover(sessionId);
    return this.coordinator.withWorkspaceLease(workspace.id, signal => this.children.worktrees.create({ sessionId, requestId, workspace, ...(reference ? { reference } : {}) }, signal));
  }

  cleanupWorktree(sessionId: string, worktreeId: string) {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    const session = this.store.getSession(sessionId);
    return this.coordinator.withWorkspaceLease(session.workspaceId, signal => this.children.worktrees.cleanup(sessionId, worktreeId, signal));
  }

  prepareChildWorktree(sessionId: string, parentWorktreeId: string, requestId: string, reference?: string) {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    const session = this.store.getSession(sessionId);
    this.children.recover(sessionId);
    return this.coordinator.withWorkspaceLease(session.workspaceId, async signal => {
      const parent = this.children.worktrees.get(sessionId, parentWorktreeId);
      if (parent.ownerId) throw new EngineError('CHILD_WORKTREE_BUSY', 'Prepare nested worktrees before an execution owns their parent');
      const workspace = await this.children.worktrees.verify(parent, signal);
      return this.children.worktrees.create({ sessionId, requestId, workspace, ...(reference ? { reference } : {}) }, signal);
    });
  }

  getCapabilities(): EngineCapabilities {
    return { ...structuredClone(this.capabilities), tools: [...this.toolRuntime.catalogue('engine', 'build', this.hostAllowedTools).tools] };
  }

  private refreshToolScopes(): void {
    this.toolRuntime.setIncludedScopes('engine', [...this.plugins.list().map(plugin => plugin.scopeId), ...[...this.mcp.values()].map(connection => connection.scopeId)]);
  }

  async activatePlugin(plugin: EnginePlugin, signal?: AbortSignal): Promise<ActivePlugin> {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    const active = await this.plugins.activate(plugin, signal ? AbortSignal.any([signal, this.hostResources.signal]) : this.hostResources.signal);
    try { this.refreshToolScopes(); return active; }
    catch (error) { await this.plugins.deactivate(active.id); throw error; }
  }

  async deactivatePlugin(id: string): Promise<void> { await this.plugins.deactivate(id); this.refreshToolScopes(); }

  async connectMcp(client: McpClient, signal?: AbortSignal): Promise<{ id: string; scopeId: string; toolNames: string[]; resources: McpRegistration['resources'] }> {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (this.mcp.has(client.id) || this.pendingMcp.has(client.id)) throw new EngineError('MCP_ALREADY_CONNECTED', 'MCP ID is already connected or connecting');
    if (this.mcp.size + this.pendingMcp.size >= 32) throw new EngineError('MCP_CONNECTION_LIMIT', 'Too many engine MCP connections');
    const pending = registerMcp(client, this.toolRuntime, signal ? AbortSignal.any([signal, this.hostResources.signal]) : this.hostResources.signal);
    this.mcpClients.set(client.id, client);
    this.pendingMcp.set(client.id, pending);
    let connection: McpRegistration | undefined;
    try {
      connection = await pending;
      if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine closed during MCP connection');
      this.mcp.set(client.id, connection); this.refreshToolScopes();
      return { id: client.id, scopeId: connection.scopeId, toolNames: connection.tools.map(tool => tool.name), resources: structuredClone(connection.resources) };
    } catch (error) { this.mcp.delete(client.id); this.mcpClients.delete(client.id); if (connection) await connection.close(); else await client.close(); throw error; }
    finally { this.pendingMcp.delete(client.id); }
  }

  async disconnectMcp(id: string): Promise<void> {
    const connection = this.mcp.get(id); if (!connection) return;
    this.mcp.delete(id); this.mcpClients.delete(id); this.refreshToolScopes(); await connection.close();
  }

  integrityCheck(): IntegrityCheckResult {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.integrityCheck();
  }

  backup(destination: string, options?: StoreBackupOptions): Promise<DatabaseBackup> {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    return this.store.backup(destination, options);
  }

  importImage(sessionId: string, data: Uint8Array, mimeType: InputImageAttachment['mimeType'], signal?: AbortSignal): Promise<InputImageAttachment> {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    const operation = this.images.import(sessionId, data, mimeType, signal ? AbortSignal.any([signal, this.hostResources.signal]) : this.hostResources.signal);
    this.pendingImages.add(operation);
    void operation.then(() => this.pendingImages.delete(operation), () => this.pendingImages.delete(operation));
    return operation;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.closePromise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void (async () => {
      try {
        this.hostResources.abort();
        this.questions.close();
        // Both calls synchronously stop admissions before either awaits active work.
        const outcomes = await Promise.allSettled([this.scheduler.close(), this.coordinator.close(), this.children.close(), this.changes.close(), this.lsp.close(), ...this.watchConsumers.values(), ...[...this.pendingImages].map(operation => operation.catch(() => {})), this.terminals.close(), this.plugins.close(), ...[...this.mcpClients.values()].map(client => client.close()), ...[...this.mcp.keys()].map(id => this.disconnectMcp(id)), ...[...this.pendingMcp.values()].map(pending => pending.catch(() => {}))]);
        const failed = outcomes.find(outcome => outcome.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }
      finally {
        try { this.terminalJournal.close(); }
        finally { try { this.reviewJournal.close(); }
        finally { await this.store.closeAsync(); }
        }
      }
    })().then(resolve, reject);
    return this.closePromise;
  }
}

export function createEngine(options: EngineOptions): MoodcodeEngine { return new MoodcodeEngine(options); }
