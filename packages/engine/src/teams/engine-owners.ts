import { randomUUID } from 'node:crypto';
import { EngineError, isTerminal, type Run } from '@moodcode/contracts';
import type { ChildExecutionView } from '../child-tasks/engine-host.js';
import type { MoodcodeEngine } from '../engine.js';
import type { EngineRuntime } from '../engine-runtime.js';
import type { TeamMemberOwnerProof, TeamMemberRevision } from './types.js';
import { knowledgeHash } from '../knowledge/validation.js';
import { teamOwnerIdentity } from './validation.js';

interface Selection { workspaceId: string; rootSessionId: string; rootRunId?: string; childTaskId?: string }
interface Capture { selection: Selection; runId: string; epoch: string }
function fail(): never { throw new EngineError('TEAM_OWNER_STALE', 'Team membership requires its original actual engine owner'); }
function modelOwnerStale(message: string): never { throw new EngineError('TEAM_MODEL_OWNER_STALE', message); }

/** An actual live owner selects the private child engine; caller IDs alone do not. */
export function teamChildEngine(children: Pick<ChildExecutionView, 'teamBridge' | 'execution'>, owner: TeamMemberOwnerProof): MoodcodeEngine {
  if (owner.kind !== 'child' || !owner.childTaskId) modelOwnerStale('Expected the original actual child owner');
  const original = children.teamBridge.capture(owner.rootSessionId, owner.childTaskId);
  try {
    const target = children.teamBridge.readTarget(original);
    if (target.childRunId !== owner.runId || target.childSessionId !== owner.sessionId || target.storageBindingSha256 !== owner.childStorageSha256
      || target.rootRunId !== owner.rootRunId || target.workspaceId !== owner.workspaceId) modelOwnerStale('Child tool owner changed after actual admission');
    const execution = children.execution(owner.childTaskId);
    if (!execution || execution.closed) modelOwnerStale('Child tool owner is unavailable');
    return execution.engine;
  } finally { children.teamBridge.release(original); }
}

/** A resident child's current Run, else the Run the owner proof names. */
export function teamChildRunId(children: Pick<ChildExecutionView, 'execution'>, owner: TeamMemberOwnerProof): string {
  const execution = owner.childTaskId ? children.execution(owner.childTaskId) : undefined;
  return execution?.resident?.currentRunId ?? owner.runId;
}

/** The private live engine graph authenticates owners; descriptive IDs never grant input authority. */
export class EngineTeamOwners {
  private readonly originals = new WeakMap<object, Capture>();
  private readonly epoch = randomUUID();
  constructor(private readonly engine: Pick<EngineRuntime, 'store' | 'coordinator' | 'children'>) {}

  private assertLive(run: Run): boolean {
    if (!['created', 'running', 'awaiting_approval'].includes(run.state)) return false;
    if (this.engine.coordinator.activeRun(run.sessionId)?.id !== run.id || this.engine.store.getSessionControl(run.sessionId).paused || this.engine.coordinator.getRunCancellationSignal(run.id).aborted) fail();
    this.engine.coordinator.assertWorkspaceCleanupConfirmed(run.workspaceId);
    return true;
  }

  capture(selection: Selection): object {
    const session = this.engine.store.getSession(selection.rootSessionId);
    if (session.workspaceId !== selection.workspaceId) fail();
    let runId: string;
    let ownerIdentity: string;
    if (selection.childTaskId) {
      const actual = this.engine.children.describeTeamOwner(selection.rootSessionId, selection.childTaskId);
      if (selection.rootRunId !== undefined && selection.rootRunId !== actual.rootRunId) fail();
      runId = actual.runId;
      ownerIdentity = actual.childStorageSha256;
    } else {
      const run = selection.rootRunId === undefined ? this.engine.coordinator.activeRun(selection.rootSessionId) : this.engine.store.getRun(selection.rootRunId);
      if (!run || run.workspaceId !== selection.workspaceId || run.sessionId !== selection.rootSessionId) fail();
      this.engine.coordinator.getRunUsage(run.id);
      this.assertLive(run);
      runId = run.id;
      ownerIdentity = run.id;
    }
    const original = Object.freeze({});
    this.originals.set(original, { selection: structuredClone(selection), runId,
      epoch: knowledgeHash({ runtime: this.epoch, ownerIdentity }) });
    return original;
  }

  read(original: object): TeamMemberOwnerProof {
    const captured = this.originals.get(original);
    if (!captured) fail();
    const { selection, runId, epoch } = captured;
    let fields: Omit<TeamMemberOwnerProof, 'sha256'>;
    if (selection.childTaskId) {
      const actual = this.engine.children.describeTeamOwner(selection.rootSessionId, selection.childTaskId);
      if (actual.runId !== runId || this.engine.store.getSession(selection.rootSessionId).workspaceId !== selection.workspaceId) fail();
      fields = { kind: 'child', ...actual, ownerEpoch: epoch };
    } else {
      const run = this.engine.store.getRun(runId);
      if (run.sessionId !== selection.rootSessionId || run.workspaceId !== selection.workspaceId) fail();
      let cleanup: TeamMemberOwnerProof['cleanup'] = 'unknown';
      if (this.assertLive(run)) cleanup = 'live';
      else if (isTerminal(run.state) && run.state !== 'interrupted' && !this.engine.store.hasUncertainWorkspace(run.workspaceId)) {
        // Retained actual coordinator usage requires an observed settled producer in this host.
        this.engine.coordinator.getRunUsage(run.id);
        cleanup = 'confirmed';
      }
      fields = { kind: 'root', workspaceId: run.workspaceId, sessionId: run.sessionId,
        runId, rootSessionId: run.sessionId, rootRunId: runId, childTaskId: null,
        childTaskFingerprint: null, childStorageSha256: null, worktreeId: null,
        ownerEpoch: epoch, cleanup };
    }
    return { ...fields, sha256: knowledgeHash(fields) };
  }

  assertCurrent(original: object, member: TeamMemberRevision): void {
    if (teamOwnerIdentity(this.read(original)) !== teamOwnerIdentity(member.owner)) fail();
  }

  release(original: object): void { this.originals.delete(original); }
}
