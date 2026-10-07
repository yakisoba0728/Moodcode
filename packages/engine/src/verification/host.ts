import { EngineError, type Run } from '@moodcode/contracts';
import type { ToolContext } from '../ports.js';
import type { SqliteStore } from '../storage/index.js';
import { repositoryQuery, type RepositoryContextService } from '../repository/index.js';
import { VerificationPlanService } from './plans.js';
import { VERIFICATION_LIMITS, verificationHash, verificationJson, verificationNumber, verificationPlain, verificationText, type VerificationSource } from './types.js';

export interface VerificationSessionPolicy { checkIds: string[]; sourcePaths: string[]; maxRepairs: number }
export interface VerificationSessionConfiguration extends VerificationSessionPolicy { revision: number }
interface VerificationRunScope extends VerificationSessionPolicy {
  schemaVersion: 1; sessionId: string; runId: string; workspaceId: string; workspaceRoot: string;
  configurationRevision: number; configurationSha256: string; runConfigSha256: string; scopeSha256: string;
}
const POLICY_KIND = 'verification.configuration';
const scopeKind = (runId: string) => 'verification.scope.' + verificationHash(runId).slice(0, 40);

export function verificationSessionPolicy(value: VerificationSessionPolicy): VerificationSessionPolicy {
  verificationPlain(value, ['checkIds', 'sourcePaths', 'maxRepairs']);
  const copy = verificationJson(value) as unknown as VerificationSessionPolicy;
  if (!Array.isArray(copy.checkIds) || copy.checkIds.length < 1 || copy.checkIds.length > VERIFICATION_LIMITS.maxChecks || new Set(copy.checkIds).size !== copy.checkIds.length) throw new EngineError('INVALID_VERIFICATION_PLAN', 'Choose a bounded distinct list of host checks');
  for (const id of copy.checkIds) verificationText(id);
  const query = repositoryQuery({ kind: 'symbols', paths: copy.sourcePaths });
  verificationNumber(copy.maxRepairs, VERIFICATION_LIMITS.maxRepairs);
  return { checkIds: [...copy.checkIds], sourcePaths: query.paths, maxRepairs: copy.maxRepairs };
}

/** Host configuration is separate from model input; each Run captures it before any provider dispatch. */
export class VerificationHostService {
  constructor(private readonly store: SqliteStore, readonly plans: VerificationPlanService, private readonly repository: RepositoryContextService) {}
  configuration(sessionId: string): VerificationSessionConfiguration | null {
    this.store.getSession(sessionId);
    const doc = this.store.getSessionDocument(sessionId, POLICY_KIND);
    return doc ? { ...verificationSessionPolicy(doc.data as unknown as VerificationSessionPolicy), revision: doc.revision } : null;
  }
  async configure(sessionId: string, expectedRevision: number, value: VerificationSessionPolicy, signal: AbortSignal): Promise<VerificationSessionConfiguration> {
    verificationNumber(expectedRevision);
    const policy = verificationSessionPolicy(value), session = this.store.getSession(sessionId);
    for (const id of policy.checkIds) if (this.plans.registry.capture(id).workspaceId !== session.workspaceId) throw new EngineError('VERIFICATION_SCOPE_MISMATCH', 'Host check belongs to another workspace');
    // This read validates real bounded source files, ignores and canonical paths. It is not a semantic query.
    await this.source(session.workspaceId, policy.sourcePaths, signal);
    if (signal.aborted) throw signal.reason;
    const doc = this.store.putSessionDocument(sessionId, POLICY_KIND, expectedRevision, verificationJson(policy));
    return { ...policy, revision: doc.revision };
  }
  async start(run: Run, signal: AbortSignal): Promise<void> {
    const configuration = this.configuration(run.sessionId);
    if (!configuration) return;
    const { revision, ...policy } = configuration, workspace = this.store.getWorkspace(run.workspaceId);
    await this.source(run.workspaceId, policy.sourcePaths, signal);
    if (signal.aborted) throw signal.reason;
    const latest = this.configuration(run.sessionId);
    if (!latest || latest.revision !== revision || verificationHash(latest) !== verificationHash(configuration)) throw new EngineError('VERIFICATION_CONFIGURATION_STALE', 'Host configuration changed during Run capture');
    const body = { schemaVersion: 1 as const, ...policy, sessionId: run.sessionId, runId: run.id, workspaceId: run.workspaceId, workspaceRoot: workspace.root, configurationRevision: revision, configurationSha256: verificationHash(policy), runConfigSha256: verificationHash(run.config) };
    this.store.putActiveRunDocument(run.id, scopeKind(run.id), 0, verificationJson({ ...body, scopeSha256: verificationHash(body) }));
  }
  async ensurePlan(context: Pick<ToolContext, 'sessionId' | 'runId' | 'workspace'>, signal: AbortSignal): Promise<void> {
    const source = await this.observe(context, signal), current = this.plans.get(context.sessionId, context.runId);
    if (current && verificationHash(current.plans.at(-1)!.source) === verificationHash(source)) { this.plans.assertCurrent(current); return; }
    const configuration = this.configuration(context.sessionId)!;
    this.plans.create(context.sessionId, context.runId, current?.revision ?? 0, { checkIds: configuration.checkIds, source, maxRepairs: configuration.maxRepairs });
  }
  async observe(context: Pick<ToolContext, 'sessionId' | 'runId' | 'workspace'>, signal: AbortSignal): Promise<VerificationSource> {
    const run = this.store.getRun(context.runId), doc = this.store.getSessionDocument(context.sessionId, scopeKind(context.runId));
    if (!doc || run.sessionId !== context.sessionId || run.workspaceId !== context.workspace.id) throw new EngineError('VERIFICATION_SCOPE_MISMATCH', 'Verification requires this Run captured host source scope');
    const scope = verificationJson(doc.data) as unknown as VerificationRunScope;
    verificationPlain(scope, ['schemaVersion', 'sessionId', 'runId', 'workspaceId', 'workspaceRoot', 'configurationRevision', 'configurationSha256', 'runConfigSha256', 'scopeSha256', 'checkIds', 'sourcePaths', 'maxRepairs']);
    const { scopeSha256, ...body } = scope, policy = verificationSessionPolicy({ checkIds: scope.checkIds, sourcePaths: scope.sourcePaths, maxRepairs: scope.maxRepairs });
    const current = this.configuration(run.sessionId), workspace = this.store.getWorkspace(run.workspaceId);
    if (scope.schemaVersion !== 1 || scope.sessionId !== run.sessionId || scope.runId !== run.id || scope.workspaceId !== run.workspaceId || scope.workspaceRoot !== workspace.root || scope.workspaceRoot !== context.workspace.root || scope.runConfigSha256 !== verificationHash(run.config) || scopeSha256 !== verificationHash(body) || scope.configurationSha256 !== verificationHash(policy) || !current || current.revision !== scope.configurationRevision || verificationHash({ checkIds: current.checkIds, sourcePaths: current.sourcePaths, maxRepairs: current.maxRepairs }) !== scope.configurationSha256) throw new EngineError('VERIFICATION_SCOPE_STALE', 'Captured host verification scope changed');
    return this.source(run.workspaceId, scope.sourcePaths, signal);
  }
  private async source(workspaceId: string, paths: string[], signal: AbortSignal): Promise<VerificationSource> {
    const workspace = this.store.getWorkspace(workspaceId), observation = await this.repository.preview(workspace, { kind: 'symbols', paths }, signal);
    if (signal.aborted) throw signal.reason;
    const { bindings: _languageBindings, ...physical } = observation.manifest;
    return { sha256: verificationHash(physical), revision: 'bounded-selected-files-v1', checkpointId: null };
  }
}
