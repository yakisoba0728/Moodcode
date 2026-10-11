import { types } from 'node:util';
import { EngineError, type ApprovalRecord, type JsonObject, type ToolCallRecord } from '@moodcode/contracts';
import type { CoordinatorOptions, ToolContext } from '../ports.js';
import { codeModeError } from '../code-mode/types.js';
import { COMMAND_JOB_MODEL_TOOLS } from '../jobs/command-model-tools.js';
import { knowledgeHash } from '../knowledge/validation.js';
import type { SessionDocument } from '../storage/native-records.js';
import { TEAM_MODEL_TOOL_NAMES, TEAM_MODEL_WRITE_TOOL_NAMES } from '../teams/model-tools.js';
import { WORKFLOW_MODEL_NAMES } from '../workflows/spec.js';
import type { Owner, RunCoordinator } from './index.js';
import { approvalAllows, type ApprovedMcpToolOwner } from './mcp-execution-observer.js';

type Phase = 'prepare' | 'execute';
type ApprovalPin = NonNullable<ApprovedMcpToolOwner['approval']>;

const COMMAND_OWNER_TOOLS: readonly string[] = ['run_command', 'verify_changes', 'run_command_job', 'command_job_input', 'wait_command_job'];
const MODEL_CONTEXT_TOOLS: readonly string[] = [...TEAM_MODEL_TOOL_NAMES, ...COMMAND_JOB_MODEL_TOOLS, ...WORKFLOW_MODEL_NAMES];

interface ModelTools { names: readonly string[]; writes: readonly string[]; stale: string; approval: string }
const TEAM_TOOLS: ModelTools = { names: TEAM_MODEL_TOOL_NAMES, writes: TEAM_MODEL_WRITE_TOOL_NAMES, stale: 'TEAM_MODEL_OWNER_STALE', approval: 'TEAM_MODEL_APPROVAL_REQUIRED' };
const WORKFLOW_TOOLS: ModelTools = { names: WORKFLOW_MODEL_NAMES, writes: WORKFLOW_MODEL_NAMES.filter(name => name !== 'observe_workflow_stage'),
  stale: 'WORKFLOW_MODEL_OWNER_STALE', approval: 'WORKFLOW_MODEL_APPROVAL_REQUIRED' };

interface OwnerCapture {
  owner: Owner;
  record: ToolCallRecord;
  active: () => boolean;
  binding: string;
}

interface ContextCapture extends OwnerCapture {
  signal: AbortSignal;
  approval?: ApprovedMcpToolOwner['approval'];
}

interface PhaseCapture extends ContextCapture {
  phase: Phase;
}

/** Checks re-enter through the coordinator's public methods, which hosts and tests may wrap. */
export type ToolOwnerCoordinator = Pick<RunCoordinator, 'assertWorkflowToolContext' | 'captureToolCatalogue' | 'readOwnedCommandContext'>;

function settlementBinding(context: ToolContext): string {
  return JSON.stringify([context.workspace.id, context.workspace.root, context.sessionId, context.runId, context.toolCallId, context.turnId, context.attemptId]);
}

/** Original contexts of active tool operations, authenticated against their live native owner. */
export class ToolOwnerContexts {
  private readonly verificationSettlementOwners = new WeakMap<ToolContext, OwnerCapture>();
  private readonly teamToolContexts = new WeakMap<ToolContext, PhaseCapture>();
  private readonly codeModeContexts = new WeakMap<ToolContext, PhaseCapture>();
  private readonly commandJobContexts = new WeakMap<ToolContext, ContextCapture>();

  constructor(private readonly options: CoordinatorOptions, private readonly owners: ReadonlyMap<string, Owner>, private readonly coordinator: ToolOwnerCoordinator) {}

  captureSettlement(context: ToolContext, owner: Owner, record: ToolCallRecord, active: () => boolean): void {
    if (record.name === 'verify_changes') this.verificationSettlementOwners.set(context, { owner, record, active, binding: settlementBinding(context) });
  }

  capture(context: ToolContext, owner: Owner, record: ToolCallRecord, execute: boolean, signal: AbortSignal, active: () => boolean, approval?: ApprovedMcpToolOwner['approval']): void {
    const phase = execute ? 'execute' : 'prepare';
    const capture = (): ContextCapture => ({ owner, record, active, binding: this.binding(context), signal, ...(approval ? { approval } : {}) });
    if (record.name === 'execute_code') this.codeModeContexts.set(context, { ...capture(), phase });
    if (execute && COMMAND_OWNER_TOOLS.includes(record.name)) this.commandJobContexts.set(context, capture());
    if (MODEL_CONTEXT_TOOLS.includes(record.name)) this.teamToolContexts.set(context, { ...capture(), phase });
  }

  private binding(context: ToolContext): string {
    if (types.isProxy(context) || ![Object.prototype, null].includes(Object.getPrototypeOf(context))) throw new EngineError('TEAM_MODEL_OWNER_STALE', 'Team tools require original plain context data');
    const fields = Object.getOwnPropertyDescriptors(context);
    if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !Object.hasOwn(fields[key]!, 'value'))
      || ['workspace', 'limits', 'signal', 'sessionId', 'runId', 'toolCallId', 'turnId', 'attemptId', 'artifactDir'].some(key => !Object.hasOwn(fields, key))) throw new EngineError('TEAM_MODEL_OWNER_STALE', 'Team tools require unchanged original context data');
    const metadata: Record<string, unknown>[] = [];
    for (const value of [context.workspace, context.limits]) {
      if (!value || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new EngineError('TEAM_MODEL_OWNER_STALE', 'Team context metadata changed');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !descriptors[key]!.enumerable || !Object.hasOwn(descriptors[key]!, 'value') || descriptors[key]!.value !== null && !['string', 'number', 'boolean'].includes(typeof descriptors[key]!.value))) throw new EngineError('TEAM_MODEL_OWNER_STALE', 'Team context metadata must remain plain data');
      const copy: Record<string, unknown> = Object.create(null);
      for (const [key, descriptor] of Object.entries(descriptors)) copy[key] = descriptor.value;
      metadata.push(copy);
    }
    return JSON.stringify([...metadata, fields.sessionId!.value, fields.runId!.value, fields.toolCallId!.value, fields.turnId!.value, fields.attemptId!.value, fields.artifactDir!.value, fields.executionLockPath?.value ?? null]);
  }

  /** Model tool live phases require the same unchanged, non-aborted owner. */
  private liveOwnerChanged(captured: PhaseCapture, context: ToolContext, phase: Phase, safeBinding: string): boolean {
    const { owner, record } = captured;
    return this.owners.get(owner.run.id) !== owner || owner.terminal || owner.abort.signal.aborted || context.signal !== captured.signal || context.signal.aborted
      || safeBinding !== captured.binding || owner.activeTools.get(record.id) !== record
      || owner.run.sessionId !== context.sessionId || owner.run.id !== context.runId || owner.run.workspaceId !== context.workspace.id
      || owner.turn?.id !== context.turnId || owner.turn?.attemptId !== context.attemptId
      || record.id !== context.toolCallId || record.state !== (phase === 'prepare' ? 'requested' : 'running');
  }

  /** The pinned approval, while it still allows exactly this original tool call. */
  private currentApproval(pin: ApprovalPin, context: ToolContext, record: ToolCallRecord): ApprovalRecord | undefined {
    const approval = this.options.store.getApproval(pin.id);
    return approvalAllows(approval, pin.fingerprint, { runId: context.runId, sessionId: context.sessionId, toolCallId: record.id, toolName: record.name }) ? approval : undefined;
  }

  /** SQL-matching copies cannot become an original current tool producer. */
  private assertModelTool(context: ToolContext, phase: Phase, tools: ModelTools): void {
    const captured = this.teamToolContexts.get(context);
    if (!captured || captured.phase !== phase || !captured.active()) throw new EngineError(tools.stale, 'Team tools require their original current coordinator context');
    const { record } = captured;
    const safeBinding = this.binding(context);
    if (!tools.names.includes(record.name) || this.liveOwnerChanged(captured, context, phase, safeBinding)) throw new EngineError(tools.stale, 'Original team tool execution changed');
    this.coordinator.captureToolCatalogue(context);
    if (phase === 'execute' && tools.writes.includes(record.name)) {
      if (!captured.approval) throw new EngineError(tools.approval, 'Team mutations require exact original native approval');
      if (!this.currentApproval(captured.approval, context, record)) throw new EngineError(tools.approval, 'Team mutation approval changed');
    }
  }

  assertTeam(context: ToolContext, phase: Phase): void {
    this.assertModelTool(context, phase, TEAM_TOOLS);
  }

  /** Original native context for the two readonly command job model consumers. */
  readCommandJob(context: ToolContext, phase: Phase) {
    const captured = this.teamToolContexts.get(context);
    if (!captured || captured.phase !== phase || !captured.active()) throw new EngineError('COMMAND_JOB_MODEL_OWNER_STALE', 'Command output needs the original current tool context');
    const { record } = captured;
    const binding = this.binding(context);
    if (!(COMMAND_JOB_MODEL_TOOLS as readonly string[]).includes(record.name) || this.liveOwnerChanged(captured, context, phase, binding)) throw new EngineError('COMMAND_JOB_MODEL_OWNER_STALE', 'The original readonly command job owner changed');
    const catalogue = this.coordinator.captureToolCatalogue(context);
    return { workspaceId: context.workspace.id, sessionId: context.sessionId, runId: context.runId, toolCallId: record.id, turnId: context.turnId!, attemptId: context.attemptId!,
      catalogueSha256: knowledgeHash(catalogue), profile: catalogue.profile ? { id: catalogue.profile.id, revision: catalogue.profile.revision } : null };
  }

  assertWorkflow(context: ToolContext, phase: Phase): void {
    this.assertModelTool(context, phase, WORKFLOW_TOOLS);
  }

  workflowApproval(context: ToolContext): { id: string; fingerprint: string } {
    this.coordinator.assertWorkflowToolContext(context, 'execute');
    const captured = this.teamToolContexts.get(context)!;
    if (!captured.approval) throw new EngineError('WORKFLOW_MODEL_APPROVAL_REQUIRED', 'Workflow effects require their actual native approval');
    return { ...captured.approval };
  }

  readCodeMode(context: ToolContext, phase: Phase | 'observe') {
    const captured = this.codeModeContexts.get(context);
    if (!captured || !captured.active() || captured.phase !== (phase === 'observe' ? 'execute' : phase) || this.binding(context) !== captured.binding) codeModeError('CODE_MODE_OWNER_STALE');
    const { owner, record } = captured;
    if (this.owners.get(owner.run.id) !== owner || owner.terminal || owner.activeTools.get(record.id) !== record || context.signal !== captured.signal || record.name !== 'execute_code'
      || context.runId !== owner.run.id || context.sessionId !== owner.run.sessionId || context.workspace.id !== owner.run.workspaceId
      || context.turnId !== owner.turn?.id || context.attemptId !== owner.turn?.attemptId
      || phase !== 'observe' && (context.signal.aborted || owner.abort.signal.aborted || record.state !== (phase === 'prepare' ? 'requested' : 'running'))) codeModeError('CODE_MODE_OWNER_STALE');
    const catalogue = phase === 'observe' ? owner.catalogue : this.coordinator.captureToolCatalogue(context);
    if (!catalogue) codeModeError('CODE_MODE_OWNER_STALE');
    let approval: null | { id: string; fingerprint: string } = null;
    if (phase !== 'prepare') {
      if (!captured.approval) codeModeError('CODE_MODE_APPROVAL_REQUIRED');
      const current = this.currentApproval(captured.approval, context, record);
      if (!current) codeModeError('CODE_MODE_APPROVAL_REQUIRED');
      approval = { id: current.id, fingerprint: current.fingerprint };
    }
    return { workspaceId: context.workspace.id, sessionId: context.sessionId, runId: context.runId, turnId: context.turnId!, attemptId: context.attemptId!, toolCallId: record.id,
      configSha256: knowledgeHash(owner.run.config), catalogueSha256: knowledgeHash(catalogue), profile: catalogue.profile ?? null, approval };
  }

  /** The owner of a code-mode context that readCodeMode already authenticated. */
  codeModeOwner(context: ToolContext): Owner {
    return this.codeModeContexts.get(context)!.owner;
  }

  /** ORIGINAL approved execution scope, retained only while the genuine command owns its Run. */
  readOwnedCommand(context: ToolContext, phase: 'start' | 'settle') {
    const captured = this.commandJobContexts.get(context);
    if (!captured || !captured.active() || this.binding(context) !== captured.binding) throw new EngineError('COMMAND_JOB_OWNER_STALE', 'Command jobs require the original unchanged execution context');
    const { owner, record, approval: pin } = captured;
    if (owner.terminal || this.owners.get(owner.run.id) !== owner || owner.activeTools.get(record.id) !== record || context.signal !== captured.signal
      || owner.run.id !== context.runId || owner.run.sessionId !== context.sessionId || owner.run.workspaceId !== context.workspace.id
      || owner.turn?.id !== context.turnId || owner.turn?.attemptId !== context.attemptId || !COMMAND_OWNER_TOOLS.includes(record.name)
      || phase === 'start' && (context.signal.aborted || owner.abort.signal.aborted || record.state !== 'running')) throw new EngineError('COMMAND_JOB_OWNER_STALE', 'The actual command execution owner changed');
    if (!pin) throw new EngineError('COMMAND_JOB_APPROVAL_REQUIRED', 'Command observation requires its exact native approval');
    const approval = this.currentApproval(pin, context, record);
    if (!approval) throw new EngineError('COMMAND_JOB_APPROVAL_REQUIRED', 'The actual native command approval changed');
    const catalogue = phase === 'start' ? this.coordinator.captureToolCatalogue(context) : owner.catalogue;
    if (!catalogue) throw new EngineError('COMMAND_JOB_OWNER_STALE', 'Command catalogue is unavailable');
    return { name: record.name, workspaceId: context.workspace.id, sessionId: context.sessionId, runId: context.runId,
      toolCallId: record.id, turnId: context.turnId!, attemptId: context.attemptId!, approvalId: approval.id,
      approvalFingerprint: approval.fingerprint, catalogueSha256: knowledgeHash(catalogue) };
  }

  /** Authenticate only the real verification execution's narrowed nested command, then discard it. */
  async withVerificationCommand<T>(outer: ToolContext, nested: ToolContext, execute: () => Promise<T>): Promise<T> {
    const owner = this.coordinator.readOwnedCommandContext(outer, 'start');
    if (owner.name !== 'verify_changes' || outer === nested || this.commandJobContexts.has(nested))
      throw new EngineError('COMMAND_JOB_OWNER_STALE', 'Nested commands require their original verification owner');
    const binding = this.binding(nested);
    const outerFields = Object.getOwnPropertyDescriptors(outer), nestedFields = Object.getOwnPropertyDescriptors(nested);
    const fieldsChanged = Reflect.ownKeys(outerFields).length !== Reflect.ownKeys(nestedFields).length
      || Object.keys(outerFields).some(key => !Object.hasOwn(nestedFields, key)
        || !['limits', 'recordCheckpoint'].includes(key) && outerFields[key]!.value !== nestedFields[key]!.value);
    const nestedLimits = nested.limits as unknown as Record<string, unknown>;
    const limitsChanged = Object.keys(outer.limits).length !== Object.keys(nestedLimits).length
      || Object.entries(outer.limits).some(([key, value]) => {
        if (!Object.hasOwn(nestedLimits, key)) return true;
        const selected = nestedLimits[key];
        if (!['toolTimeoutMs', 'maxOutputBytes'].includes(key)) return selected !== value;
        return typeof selected !== 'number' || !Number.isSafeInteger(selected) || selected < 1 || selected > value;
      });
    if (fieldsChanged || limitsChanged || typeof nested.recordCheckpoint !== 'function')
      throw new EngineError('COMMAND_JOB_OWNER_STALE', 'Verification nesting may only narrow timeout/output limits and wrap checkpoint publication');
    const capture = this.commandJobContexts.get(outer)!;
    this.commandJobContexts.set(nested, { ...capture, binding });
    try { return await execute(); }
    finally { this.commandJobContexts.delete(nested); }
  }

  /** Cancellation can settle the consumed command, without creating any new verification work. */
  commitConsumedVerificationSettlement(context: ToolContext, kind: string, expectedRevision: number, data: JsonObject): SessionDocument {
    const capture = this.verificationSettlementOwners.get(context), binding = settlementBinding(context);
    if (!capture || capture.binding !== binding || !capture.active() || capture.owner.terminal || this.owners.get(context.runId) !== capture.owner
      || capture.record.name !== 'verify_changes' || capture.record.state !== 'running' || capture.owner.activeTools.get(context.toolCallId) !== capture.record
      || capture.owner.turn?.id !== context.turnId || capture.owner.turn?.attemptId !== context.attemptId || !context.turnId || !context.attemptId
      || !this.options.store.putConsumedVerificationSettlement) throw new EngineError('VERIFICATION_SETTLEMENT_OWNER_INVALID', 'Consumed settlement requires the original live native verification execution owner');
    return this.options.store.putConsumedVerificationSettlement({ runId: context.runId, toolCallId: context.toolCallId, turnId: context.turnId, attemptId: context.attemptId }, kind, expectedRevision, data);
  }
}
