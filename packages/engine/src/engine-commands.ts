import { randomUUID } from 'node:crypto';
import { EngineError, SCHEMA_VERSION, SESSION_SCHEMA_VERSION, type CommandEnvelope, type CommandResult, type EngineCapabilities, type InputCursor, type JsonObject, type JsonValue, type RunConfig, type Session, type SessionCommandResult } from '@moodcode/contracts';
import { normalizeAcceptInput, normalizeSubmitInput, validateCommand, validateSessionCommand } from '@moodcode/contracts/validation';
import type { SqliteStore } from './storage/index.js';
import type { RunCoordinator } from './runner/index.js';
import type { InputScheduler } from './runner/input-scheduler.js';
import type { ApprovalManager } from './permission/index.js';
import type { QuestionAnswer, QuestionManager } from './questions/index.js';
import type { SessionTaskService } from './session-state/index.js';
import type { ContextService } from './context/service.js';
import type { AgentProfiles } from './agents/index.js';
import type { ArtifactStore } from './artifacts/store.js';
import type { EngineLifetime } from './engine-kernel.js';
import type { EngineRestore } from './engine-restore.js';
import type { WorkspaceLanguageSync } from './engine-language-sync.js';
import { assertMediaCommandData, type EngineInputMedia } from './media/engine-input.js';
import { openWorkspace } from './workspace/index.js';
import { getWorkspaceStatus, listWorkspaceFiles, readWorkspaceFile } from './workspace/presentation.js';
import { getReviewDiff } from './review/index.js';

export const NATIVE_COMMANDS_ENABLED = ['input.accept', 'input.list', 'input.cancel', 'session.pause', 'session.resume', 'session.events', 'engine.getCapabilities', 'run.getTurns', 'turn.getParts', 'artifact.get', 'session.getTasks', 'session.setTasks', 'question.list', 'question.answer', 'question.reject', 'session.getContext', 'session.searchHistory', 'session.getDiagnostics'] as const;

function json(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return null;
  return JSON.parse(encoded) as JsonValue;
}

/** The commandId of a failed command, echoed only when it satisfies the contract ID rule. */
function echoCommandId(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'commandId');
    if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      && descriptor.value.trim().length > 0 && descriptor.value.length <= 256
      && !/[\u0000-\u001f\u007f]/u.test(descriptor.value)
      && Buffer.byteLength(descriptor.value) <= 256) return descriptor.value;
  } catch { /* Invalid object traps must not escape the command result boundary. */ }
  return '';
}

function commandFailure(error: unknown, fallback: string): { code: string; message: string; details?: JsonObject } {
  return error instanceof EngineError ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } : { code: 'INTERNAL_ERROR', message: fallback };
}

export interface EngineCommandParts {
  readonly store: SqliteStore;
  readonly scheduler: InputScheduler;
  readonly coordinator: RunCoordinator;
  readonly approvals: ApprovalManager;
  readonly questions: QuestionManager;
  readonly tasks: SessionTaskService;
  readonly context: ContextService;
  readonly profiles: AgentProfiles;
  readonly defaults: RunConfig;
  readonly lifetime: EngineLifetime;
  readonly media: EngineInputMedia;
  readonly restorer: EngineRestore;
  readonly languageSync: WorkspaceLanguageSync;
  readonly managedArtifacts: () => Promise<ArtifactStore>;
  getCapabilities(): EngineCapabilities;
}

/** The command and session command routers; a failed command always answers with a contract error result. */
export class EngineCommands {
  constructor(private readonly parts: EngineCommandParts) {}

  private applyProfile(input: { sessionId: string; requestId: string; config: RunConfig }): void {
    const admitted = input.config.agentProfileId ? this.parts.store.findInputByRequest(input.sessionId, input.requestId)?.config : undefined;
    input.config = this.parts.profiles.apply(input.sessionId, input.config, admitted);
  }

  async dispatchSession(value: unknown): Promise<SessionCommandResult> {
    const { store, scheduler, tasks, questions, context } = this.parts;
    let commandId = '';
    try {
      assertMediaCommandData(value);
      const command = validateSessionCommand(value, { defaults: this.parts.defaults, enabledCommands: NATIVE_COMMANDS_ENABLED });
      commandId = command.commandId;
      this.parts.lifetime.assertOpen();
      const payload = command.payload;
      let result: unknown;
      switch (command.type) {
        case 'engine.getCapabilities': result = this.parts.getCapabilities(); break;
        case 'input.accept': {
          const input = normalizeAcceptInput(payload, this.parts.defaults);
          this.applyProfile(input);
          if ((input.attachments?.length || input.documents?.length || input.media?.length) && !store.lookupInputReceipt(input)) {
            await this.parts.media.validateFresh(input);
          }
          result = scheduler.accept(input); break;
        }
        case 'input.list': result = store.listInputs(payload.sessionId as string, payload.cursor as unknown as InputCursor | undefined, payload.limit as number); break;
        case 'input.cancel': {
          const input = store.getInput(payload.inputId as string);
          if (input.sessionId !== payload.sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Input belongs to a different session');
          result = scheduler.cancelInput(input.id); break;
        }
        case 'session.pause': result = scheduler.pause(payload.sessionId as string); break;
        case 'session.resume': result = scheduler.resume(payload.sessionId as string); break;
        case 'session.events': {
          store.getSession(payload.sessionId as string);
          result = { sessionId: payload.sessionId, stream: 'session-v2', afterSeq: payload.afterSeq }; break;
        }
        case 'session.getTasks': result = tasks.get(payload.sessionId as string); break;
        case 'session.getContext': result = context.diagnostics(payload.sessionId as string); break;
        case 'session.getDiagnostics': {
          const session = store.getSession(payload.sessionId as string);
          result = { metrics: store.getNativeMetrics(session.id), context: context.diagnostics(session.id), workspaceObservation: this.parts.languageSync.observation(session.workspaceId) }; break;
        }
        case 'session.searchHistory': result = store.searchHistory(payload.sessionId as string, { query: payload.query as string, beforeMessageId: payload.beforeMessageId as string | undefined, limit: payload.limit as number, maxBytes: payload.maxBytes as number }); break;
        case 'session.setTasks': result = tasks.replace(payload.sessionId as string, payload.expectedRevision as number, payload.tasks); break;
        case 'question.list': result = questions.list(payload.sessionId as string); break;
        case 'question.answer': result = questions.answer(payload.sessionId as string, payload.questionId as string, payload.version as number, payload.answer as unknown as QuestionAnswer); break;
        case 'question.reject': result = questions.reject(payload.sessionId as string, payload.questionId as string, payload.version as number); break;
        case 'run.getTurns': result = store.listTurnsPage(payload.runId as string, payload.afterTurnId as string | undefined, payload.limit as number); break;
        case 'turn.getParts': result = store.listPartsPage(payload.turnId as string, payload.afterPartId as string | undefined, payload.limit as number); break;
        case 'artifact.get': {
          const run = store.getRun(payload.runId as string);
          if (run.sessionId !== payload.sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Artifact run belongs to a different session');
          const page = await (await this.parts.managedArtifacts()).read(payload.artifactId as string, { identity: {
            sessionId: payload.sessionId as string, runId: run.id, toolCallId: payload.toolCallId as string,
            ...(payload.turnId ? { turnId: payload.turnId as string } : {}), ...(payload.attemptId ? { attemptId: payload.attemptId as string } : {}),
          }, offset: payload.offset as number, limit: payload.limit as number });
          result = { reference: page.reference, offset: page.offset, ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}), encoding: 'base64', content: Buffer.from(page.bytes).toString('base64') }; break;
        }
        default: throw new EngineError('UNKNOWN_COMMAND', 'Unknown session command');
      }
      return { schemaVersion: SESSION_SCHEMA_VERSION, commandId, ok: true, result: json(result) };
    } catch (error) {
      if (!commandId) commandId = echoCommandId(value);
      return { schemaVersion: SESSION_SCHEMA_VERSION, commandId, ok: false, error: commandFailure(error, 'Session command failed') };
    }
  }

  async dispatch(value: CommandEnvelope | unknown): Promise<CommandResult> {
    const { store, restorer } = this.parts;
    let commandId = '';
    try {
      assertMediaCommandData(value);
      const command = validateCommand(value, this.parts.defaults);
      commandId = command.commandId;
      this.parts.lifetime.assertOpen();
      const payload = command.payload;
      let result: unknown;
      switch (command.type) {
        case 'engine.getCapabilities':
          result = this.parts.getCapabilities();
          break;
        case 'workspace.open': {
          const workspace = await openWorkspace(payload.path as string);
          result = store.putWorkspace(workspace);
          break;
        }
        case 'workspace.getStatus':
          result = await getWorkspaceStatus(store.getWorkspace(payload.workspaceId as string));
          break;
        case 'file.list':
          result = await listWorkspaceFiles(store.getWorkspace(payload.workspaceId as string), payload.path as string | undefined, { ...(payload.limit === undefined ? {} : { limit: payload.limit as number }), ...(payload.continuation === undefined ? {} : { continuation: payload.continuation as string }) });
          break;
        case 'file.read':
          result = await readWorkspaceFile(store.getWorkspace(payload.workspaceId as string), payload.path as string);
          break;
        case 'session.create': {
          const workspaceId = payload.workspaceId as string;
          store.getWorkspace(workspaceId);
          const session: Session = { id: randomUUID(), workspaceId, title: (payload.title as string | undefined) ?? 'New session', createdAt: new Date().toISOString() };
          result = store.createSession(session);
          break;
        }
        case 'session.list': {
          store.getWorkspace(payload.workspaceId as string);
          result = store.listSessions(payload.workspaceId as string);
          break;
        }
        case 'session.getSnapshot':
          result = store.getSnapshot(payload.sessionId as string);
          break;
        case 'session.getHistory':
          result = store.getHistory(payload.sessionId as string, payload.beforeRunId as string | undefined, payload.limit as number | undefined);
          break;
        case 'session.getMetrics':
          result = store.getMetrics(payload.sessionId as string);
          break;
        case 'run.submit':
          {
            const input = normalizeSubmitInput(payload);
            this.applyProfile(input);
            if ((input.attachments?.length || input.documents?.length || input.media?.length) && !store.lookupRunReceipt(input)) {
              await this.parts.media.validateFresh(input);
            }
            result = this.parts.scheduler.submitLegacy(input);
          }
          break;
        case 'run.cancel':
          result = this.parts.coordinator.cancel(payload.runId as string);
          break;
        case 'approval.decide':
          result = this.parts.approvals.decide(payload.approvalId as string, payload.decision as 'allow' | 'deny', payload.fingerprint as string);
          break;
        case 'review.getDiff':
          result = await getReviewDiff(store, payload.runId as string);
          break;
        case 'review.previewRestore':
          result = await restorer.preview(payload.runId as string, payload.checkpointId as string);
          break;
        case 'review.restore':
          result = await restorer.restore(command.commandId, payload.runId as string, payload.checkpointId as string, payload.previewFingerprint as string);
          break;
        case 'review.history':
          result = restorer.history(payload.runId as string);
          break;
        case 'events.subscribe':
          store.getSession(payload.sessionId as string);
          result = { sessionId: payload.sessionId, afterSeq: payload.afterSeq ?? 0 };
          break;
        default:
          throw new EngineError('UNKNOWN_COMMAND', 'Unknown engine command');
      }
      return { schemaVersion: SCHEMA_VERSION, commandId, ok: true, result: json(result) };
    } catch (error) {
      if (!commandId) commandId = echoCommandId(value);
      return { schemaVersion: SCHEMA_VERSION, commandId, ok: false, error: commandFailure(error, 'Unexpected engine error') };
    }
  }
}
