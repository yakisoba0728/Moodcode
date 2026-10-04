import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EngineError, SCHEMA_VERSION, type CommandEnvelope, type CommandResult, type EngineCapabilities, type EngineEvent, type JsonValue, type Run, type RunConfig, type RunConfigInput, type Session } from '@moodcode/contracts';
import { normalizeSubmitInput, validateCommand } from '@moodcode/contracts/validation';
import type { ProviderAdapter, ToolDefinition } from './ports.js';
import { SqliteStore, type DatabaseBackup, type IntegrityCheckResult, type StoreBackupOptions } from './storage/index.js';
import { RunCoordinator } from './runner/index.js';
import { ScriptedProvider } from './provider/index.js';
import { ApprovalManager } from './permission/index.js';
import { openWorkspace } from './workspace/index.js';
import { buildContext } from './context/index.js';
import { createReadTools } from './tools/read/index.js';
import { createPatchTool } from './tools/patch/index.js';
import { createCommandTool } from './tools/command/index.js';
import { assertExecutionLockAvailable } from './tools/command/execution-lock.js';
import { getReviewDiff } from './review/index.js';

export interface EngineOptions {
  dbPath: string;
  artifactDir?: string;
  providers?: ProviderAdapter[];
  tools?: ToolDefinition[];
  defaults?: RunConfigInput;
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

export class MoodcodeEngine {
  readonly store: SqliteStore;
  readonly coordinator: RunCoordinator;
  readonly approvals: ApprovalManager;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly defaults: RunConfig;
  private readonly capabilities: EngineCapabilities;

  constructor(options: EngineOptions) {
    if (!options || typeof options.dbPath !== 'string' || options.dbPath.length === 0) {
      throw new EngineError('INVALID_CONFIG', 'dbPath must be a non-empty string');
    }
    this.defaults = normalizeSubmitInput({ sessionId: 'defaults', requestId: 'defaults', prompt: 'defaults', config: options.defaults ?? {} }).config;
    const dbPath = options.dbPath === ':memory:' ? options.dbPath : resolve(options.dbPath);
    const artifactDir = resolve(options.artifactDir ?? `${options.dbPath}.artifacts`);
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    this.store = new SqliteStore(dbPath);
    try {
      const executionLockPath = dbPath === ':memory:' ? resolve(artifactDir, 'effects.sqlite') : `${realpathSync(dbPath)}.effects.sqlite`;
      verifyExecutionIdle(executionLockPath);
      this.store.recoverInterrupted();
      this.approvals = new ApprovalManager(this.store);
      const providers = new Map<string, ProviderAdapter>([['scripted', new ScriptedProvider()]]);
      for (const provider of options.providers ?? []) providers.set(provider.id, provider);
      const tools = options.tools ?? [...createReadTools(), createPatchTool(), createCommandTool()];
      this.capabilities = {
        schemaVersion: SCHEMA_VERSION,
        runtime: { node: process.versions.node, electron: process.versions.electron ?? null, platform: process.platform, commandExecution: process.platform === 'win32' ? 'unsupported' : 'posix-process-group' },
        providerIds: [...providers.keys()].sort(),
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: structuredClone(inputSchema) })),
        modes: ['plan', 'build'], defaults: structuredClone(this.defaults),
      };
      this.coordinator = new RunCoordinator({
        store: this.store,
        providers,
        tools,
        approvals: this.approvals,
        artifactDir,
        executionLockPath,
        buildContext,
      });
    } catch (error) {
      this.store.close();
      throw error;
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
          result = this.capabilities;
          break;
        case 'workspace.open': {
          const workspace = await openWorkspace(payload.path as string);
          result = this.store.putWorkspace(workspace);
          break;
        }
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
        case 'run.submit':
          result = this.coordinator.submit(normalizeSubmitInput(payload));
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

  subscribe(sessionId: string, afterSeq = 0, signal?: AbortSignal): AsyncIterable<EngineEvent> {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new EngineError('INVALID_CURSOR', 'afterSeq must be a non-negative safe integer');
    return this.store.subscribe(sessionId, afterSeq, signal);
  }

  waitForRun(runId: string): Promise<Run> { return this.coordinator.waitForRun(runId); }

  integrityCheck(): IntegrityCheckResult {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.integrityCheck();
  }

  backup(destination: string, options?: StoreBackupOptions): Promise<DatabaseBackup> {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    return this.store.backup(destination, options);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      try { await this.coordinator.close(); }
      finally { await this.store.closeAsync(); }
    })();
    return this.closePromise;
  }
}

export function createEngine(options: EngineOptions): MoodcodeEngine { return new MoodcodeEngine(options); }
