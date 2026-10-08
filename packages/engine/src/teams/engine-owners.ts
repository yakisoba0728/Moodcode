import { randomUUID } from 'node:crypto';
import { EngineError, isTerminal } from '@moodcode/contracts';
import type { MoodcodeEngine } from '../engine.js';
import type { TeamMemberOwnerProof, TeamMemberRevision } from './types.js';
import { knowledgeHash } from '../knowledge/validation.js';

interface Selection { workspaceId: string; rootSessionId: string; rootRunId?: string; childTaskId?: string }
interface Capture { selection: Selection; runId: string; epoch: string }
const hash = knowledgeHash;
function fail(): never { throw new EngineError('TEAM_OWNER_STALE', 'Team membership requires its original actual engine owner'); }

/** The private live engine graph authenticates owners; descriptive IDs never grant input authority. */
export class EngineTeamOwners {
  private readonly originals = new WeakMap<object, Capture>();
  private readonly epoch = randomUUID();
  constructor(private readonly engine: MoodcodeEngine) {}

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
      if (['created', 'running', 'awaiting_approval'].includes(run.state)) {
        if (this.engine.coordinator.activeRun(run.sessionId)?.id !== run.id || this.engine.store.getSessionControl(run.sessionId).paused || this.engine.coordinator.getRunCancellationSignal(run.id).aborted) fail();
        this.engine.coordinator.assertWorkspaceCleanupConfirmed(run.workspaceId);
      }
      runId = run.id;
      ownerIdentity = run.id;
    }
    const original = Object.freeze({});
    this.originals.set(original, { selection: structuredClone(selection), runId,
      epoch: hash({ runtime: this.epoch, ownerIdentity }) });
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
      if (['created', 'running', 'awaiting_approval'].includes(run.state)) {
        if (this.engine.coordinator.activeRun(run.sessionId)?.id !== run.id || this.engine.store.getSessionControl(run.sessionId).paused || this.engine.coordinator.getRunCancellationSignal(run.id).aborted) fail();
        this.engine.coordinator.assertWorkspaceCleanupConfirmed(run.workspaceId);
        cleanup = 'live';
      } else if (isTerminal(run.state) && run.state !== 'interrupted' && !this.engine.store.hasUncertainWorkspace(run.workspaceId)) {
        // Retained actual coordinator usage requires an observed settled producer in this host.
        this.engine.coordinator.getRunUsage(run.id);
        cleanup = 'confirmed';
      }
      fields = { kind: 'root', workspaceId: run.workspaceId, sessionId: run.sessionId,
        runId, rootSessionId: run.sessionId, rootRunId: runId, childTaskId: null,
        childTaskFingerprint: null, childStorageSha256: null, worktreeId: null,
        ownerEpoch: epoch, cleanup };
    }
    return { ...fields, sha256: hash(fields) };
  }

  assertCurrent(original: object, member: TeamMemberRevision): void {
    const actual = this.read(original);
    const expected = member.owner;
    for (const key of ['kind', 'workspaceId', 'sessionId', 'runId', 'rootSessionId', 'rootRunId', 'childTaskId', 'childTaskFingerprint', 'childStorageSha256', 'worktreeId', 'ownerEpoch'] as const) if (actual[key] !== expected[key]) fail();
  }

  release(original: object): void { this.originals.delete(original); }
}
