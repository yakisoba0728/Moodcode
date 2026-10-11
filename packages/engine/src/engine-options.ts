import { EngineError, type RunConfig, type RunConfigInput } from '@moodcode/contracts';
import { normalizeRunConfig } from '@moodcode/contracts/validation';
import type { ProviderAdapter, ToolDefinition } from './ports.js';
import type { MoodcodeEngine } from './engine.js';
import type { WorkspaceExecutionSourceLimits } from './diagnostics/execution-source.js';
import { knowledgeContextPolicy } from './knowledge/context-source.js';
import type { KnowledgeContextPolicy } from './knowledge/context-types.js';
import { proposalContextPolicy, type ProposalContextPolicy } from './proposals/overlay.js';
import { LifecycleHookRegistry, type LifecycleHookRegistration } from './lifecycle/index.js';
import type { RoleResourcePolicy } from './permission/role-resources.js';
import { RoleResourcePolicyRegistry } from './permission/role-policy-registry.js';
import type { ToolPolicy, ToolPolicyRule } from './permission/policy.js';
import type { ScopedToolRuntimeOptions, RuntimeCommandPreflightOptions } from './tools/runtime/index.js';
import { validateToolDiscoveryPolicy, type ToolDiscoveryPolicy } from './tools/runtime/discovery.js';
import { registerCredentialEnvNames } from './tools/command/process-control.js';
import type { ModelSpec } from './context/model-spec.js';
import { validateMediaHistoryPolicy, type MediaHistoryPolicy } from './context/media-history.js';
import { validateActivePrefixPolicy, type ActivePrefixPolicy } from './context/active-prefix.js';
import { validateDocumentHistoryPolicy, type DocumentHistoryPolicy } from './context/document-history.js';
import { repositoryContextPolicy, type RepositoryContextPolicy } from './context/repository-contributions.js';
import type { AgentBackendSecretResolver } from './agent-backends/engine-producer.js';
import type { AgentProfileSpec } from './agents/index.js';
import type { PtyBackend } from './terminals/index.js';
import type { ChildTaskManager, ChildTaskRecord } from './child-tasks/index.js';
import type { WorktreeManager } from './worktrees/index.js';

export interface EngineOptions {
  /** Actual Darwin kernel sandbox, explicit grants, never a host fallback. */
  osSandbox?:boolean;
  /** Actual OS-isolated closed JSON runtime, with individual nested native approvals. */
  codeMode?:boolean;
  /** Original producer observations; bounded physical reads are disabled by default. */
  diagnosticObservations?: boolean;
  diagnosticSourceLimits?: Partial<WorkspaceExecutionSourceLimits>;
  dbPath: string;
  /** Host credential variable names stripped from every child environment of this process, besides the built-in list. */
  credentialEnvNames?: readonly string[];
  artifactDir?: string;
  providers?: ProviderAdapter[];
  tools?: ToolDefinition[];
  defaults?: RunConfigInput;
  toolPolicy?: readonly ToolPolicyRule[];
  /** Explicit Run-local schema discovery; default provider exposure remains eager. */
  toolDiscoveryPolicy?: ToolDiscoveryPolicy;
  /** Explicit read-only repository navigation; the default core catalogue is unchanged. */
  repositoryContextTools?: boolean;
  repositoryContextPolicy?: RepositoryContextPolicy;
  /** Host-registered checks only; command/profile approval remains mandatory. */
  verificationTools?: boolean;
  /** Idle host Git commits require an exact Original preview and actual verification. */
  gitCommits?: boolean;
  prFeedback?: boolean;
  prFeedbackLoopback?: boolean;
  /** Explicit tools-free host extraction into pending workspace knowledge candidates. */
  knowledgeGeneration?: boolean;
  /** Explicit host-approved publication to native workspace document revisions. */
  knowledgePublication?: boolean;
  /** Explicit exact-approved physical workspace-file and skill publication. */
  knowledgeFilePublication?: boolean;
  /** Explicit host recovery and per-document activation after an archive import. */
  knowledgeImportRecovery?: boolean;
  /** Host-selected current approved documents, consumed as bounded read-only data. */
  knowledgeContextPolicy?: KnowledgeContextPolicy;
  /** Host-authored pending proposals, saved separately from physical application. */
  proposals?: boolean;
  /** Separate exact-approved idle host file application. */
  proposalApply?: boolean;
  /** Explicit host team membership, native mailbox/board and current child input delivery. */
  teams?: boolean;
  /** Fixed tool catalogue; host must separately bind an actual selected team member. */
  teamModelTools?: boolean;
  /** Explicit readonly catalogue plus separately host-bound job aliases; children do not inherit. */
  commandJobModelTools?: boolean;
  residentTeams?: boolean;
  /** Explicit host workflow orchestration through isolated actual child executions. */
  workflows?: boolean;
  codingBatches?: boolean;
  /** Explicit root lifetime and durable queue-only scheduled input admission. */
  schedules?: boolean;
  /** Root-owned ACP v1 stdio providers; imported definitions do not restore runtime authority. */
  agentBackends?: boolean;
  agentBackendClientEffects?: boolean;
  /** Explicit read-only observation of existing user-owned terminals as native jobs. */
  jobs?: boolean;
  /** Exact prepared-resource parallel effects; root opt-in, children remain serial. */
  effectBatches?: boolean;
  /** Explicit independent idle-workspace command owner; disabled by default. */
  hostCommands?: boolean;
  commandLifetimes?: boolean;
  /** Exact host-approved bounded conversation forks; execution approvals are never inherited. */
  conversationForks?: boolean;
  /** Explicit audience-bound runtime secrets; bodies never enter native backend journals. */
  agentBackendSecrets?: AgentBackendSecretResolver;
  /** Exact host-selected pending proposals projected as read-only model data. */
  proposalContextPolicy?: ProposalContextPolicy;
  /** Explicit trusted host callbacks; no workspace hook discovery or shell execution. */
  lifecycleHooks?: readonly LifecycleHookRegistration[];
  /** Shared host policy registry for owned child engines. Captures remain Run-bound. */
  lifecycleHookRegistry?: LifecycleHookRegistry;
  /** Whole bounded host data reserved before optional history and source context. */
  lifecycleContextSlotBytes?: number;
  /** At most one extra turn, bound to actual current passed native verification. */
  lifecycleContinuation?: boolean;
  /** Optional host policy narrowing for persisted agent profiles and exact resources. */
  roleResourcePolicy?: RoleResourcePolicy;
  roleResourcePolicyRegistry?: RoleResourcePolicyRegistry;
  resolveRoleResources?: ScopedToolRuntimeOptions['resolveRoleResources'];
  commandPreflight?: RuntimeCommandPreflightOptions;
  /** Trusted host policy shared by an owned child; grants remain local to each engine. */
  toolPolicyInstance?: ToolPolicy;
  modelSpecs?: readonly ModelSpec[];
  outputTokenReserve?: number;
  /** Explicit host policy; original transcript and image references remain durable. */
  mediaHistoryPolicy?: MediaHistoryPolicy;
  /** Bounded derived observations from completed exchanges of a still-active Run. */
  activePrefixPolicy?: ActivePrefixPolicy;
  /** PDF page/text token cost is opaque. The default refuses this unknown cost. */
  allowUnknownDocumentTokenCost?: boolean;
  /** Explicitly admit media whose token cost remains unknown. */
  allowUnknownMediaTokenCost?: boolean;
  documentHistoryPolicy?: DocumentHistoryPolicy;
  agentProfiles?: readonly AgentProfileSpec[];
  allowedToolNames?: readonly string[];
  ptyBackend?: PtyBackend;
  worktreeDirectory?: string;
  /** Root task namespace for a host-owned nested engine. No additional tools or grants. */
  childTaskScope?: { tasks: ChildTaskManager; worktrees: WorktreeManager; sessionId: string };
  configureChild?: (engine: MoodcodeEngine, task: Readonly<ChildTaskRecord>) => void;
}

/** Opt-in features fixed when the engine is constructed. */
export interface EngineFeatures {
  readonly sandbox: boolean;
  readonly verification: boolean;
  readonly knowledgeGeneration: boolean;
  readonly knowledgePublication: boolean;
  readonly knowledgeFilePublication: boolean;
  readonly knowledgeImportRecovery: boolean;
  readonly proposals: boolean;
  readonly proposalApply: boolean;
  readonly teams: boolean;
  readonly teamModelTools: boolean;
  readonly workflows: boolean;
  readonly codingBatches: boolean;
  readonly schedules: boolean;
  readonly agentBackends: boolean;
  readonly jobs: boolean;
  readonly conversationForks: boolean;
}

export interface ResolvedEngineOptions {
  readonly enabled: EngineFeatures;
  readonly lifecycleHooks: LifecycleHookRegistry;
  readonly defaults: RunConfig;
  readonly repositoryPolicy?: RepositoryContextPolicy;
  readonly knowledgePolicy?: KnowledgeContextPolicy;
  readonly proposalPolicy?: ProposalContextPolicy;
  readonly mediaHistoryPolicy?: ReturnType<typeof validateMediaHistoryPolicy>;
  readonly activePrefixPolicy?: ReturnType<typeof validateActivePrefixPolicy>;
  readonly documentHistoryPolicy?: ReturnType<typeof validateDocumentHistoryPolicy>;
  readonly toolDiscoveryPolicy?: ReturnType<typeof validateToolDiscoveryPolicy>;
}

function assertOptionalBoolean(options: EngineOptions, key: keyof EngineOptions, message: string): void {
  if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new EngineError('INVALID_CONFIG', message);
}

/** Validates host options in a fixed order, so the first invalid option decides the error; registers credential names and initial lifecycle hooks on the way. */
export function resolveEngineOptions(options: EngineOptions): ResolvedEngineOptions {
  const sandbox = options.osSandbox === true;
  if (!options || typeof options.dbPath !== 'string' || options.dbPath.length === 0) {
    throw new EngineError('INVALID_CONFIG', 'dbPath must be a non-empty string');
  }
  const credentialEnvNames: unknown = options.credentialEnvNames;
  if (credentialEnvNames !== undefined) {
    const names = Array.isArray(credentialEnvNames) && credentialEnvNames.length <= 256 ? Array.from(credentialEnvNames as unknown[]) : undefined;
    if (!names?.every((name): name is string => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)))
      throw new EngineError('INVALID_CONFIG', 'credentialEnvNames must list at most 256 environment variable names');
    registerCredentialEnvNames(names);
  }
  const repositoryPolicy = options.repositoryContextPolicy !== undefined ? repositoryContextPolicy(options.repositoryContextPolicy) : undefined;
  const knowledgePolicy = options.knowledgeContextPolicy === undefined ? undefined : knowledgeContextPolicy(options.knowledgeContextPolicy);
  const proposalPolicy = options.proposalContextPolicy === undefined ? undefined : proposalContextPolicy(options.proposalContextPolicy);
  if (options.lifecycleHookRegistry !== undefined && !(options.lifecycleHookRegistry instanceof LifecycleHookRegistry)) throw new EngineError('INVALID_LIFECYCLE_HOOK', 'Shared hook registry requires an explicit trusted host registry');
  if (options.lifecycleHookRegistry && options.lifecycleHooks !== undefined) throw new EngineError('INVALID_LIFECYCLE_HOOK', 'Specify one host registry or initial hook registrations');
  const lifecycleHooks = options.lifecycleHookRegistry ?? new LifecycleHookRegistry();
  if (options.lifecycleContextSlotBytes !== undefined && (!Number.isSafeInteger(options.lifecycleContextSlotBytes) || options.lifecycleContextSlotBytes < 128 || options.lifecycleContextSlotBytes > 16_384))
    throw new EngineError('INVALID_LIFECYCLE_CONTEXT', 'Lifecycle context slot must be between 128 and 16384 bytes');
  assertOptionalBoolean(options, 'lifecycleContinuation', 'Lifecycle continuation requires an explicit host boolean');
  if (options.roleResourcePolicyRegistry !== undefined && !(options.roleResourcePolicyRegistry instanceof RoleResourcePolicyRegistry)) throw new EngineError('INVALID_ROLE_POLICY_CONFIGURATION', 'Shared role policy requires a trusted host registry');
  if (options.roleResourcePolicyRegistry && options.roleResourcePolicy) throw new EngineError('INVALID_ROLE_POLICY_CONFIGURATION', 'Specify one role policy registry or immutable role policy');
  assertOptionalBoolean(options, 'prFeedback', 'PR feedback requires explicit host boolean opt-in');
  assertOptionalBoolean(options, 'prFeedbackLoopback', 'PR feedback requires explicit host boolean opt-in');
  assertOptionalBoolean(options, 'gitCommits', 'gitCommits must be an explicit boolean');
  assertOptionalBoolean(options, 'verificationTools', 'Verification tool exposure must be an explicit boolean');
  assertOptionalBoolean(options, 'knowledgeGeneration', 'Knowledge generation requires an explicit host boolean');
  assertOptionalBoolean(options, 'knowledgePublication', 'Knowledge publication requires an explicit host boolean');
  assertOptionalBoolean(options, 'knowledgeFilePublication', 'Knowledge file publication requires an explicit host boolean');
  assertOptionalBoolean(options, 'knowledgeImportRecovery', 'knowledgeImportRecovery must be an explicit boolean');
  assertOptionalBoolean(options, 'proposals', 'proposals must be an explicit boolean');
  assertOptionalBoolean(options, 'teams', 'teams must be an explicit boolean');
  assertOptionalBoolean(options, 'teamModelTools', 'teamModelTools must be an explicit boolean');
  const teamModelTools = options.teamModelTools === true;
  assertOptionalBoolean(options, 'commandJobModelTools', 'commandJobModelTools must be an explicit boolean');
  assertOptionalBoolean(options, 'residentTeams', 'residentTeams requires explicit boolean');
  if(options.residentTeams===true&&(!teamModelTools||options.teams!==true))throw new EngineError('INVALID_CONFIG','Resident teams require teams and team model tools');
  assertOptionalBoolean(options, 'workflows', 'workflows must be an explicit boolean');
  assertOptionalBoolean(options, 'codingBatches', 'codingBatches must be explicit boolean');
  if (options.codingBatches === true && (options.workflows !== true || options.verificationTools !== true || options.tools))
    throw new EngineError("CODING_BATCH_UNSUPPORTED", "Coding batches require core workflow and verification tools");
  assertOptionalBoolean(options, 'schedules', 'schedules must be an explicit boolean');
  assertOptionalBoolean(options, 'agentBackends', 'agentBackends requires an explicit root host boolean');
  if (options.agentBackendSecrets !== undefined && (!options.agentBackendSecrets || typeof options.agentBackendSecrets.resolve !== 'function')) throw new EngineError('INVALID_CONFIG', 'Backend secrets require an explicit trusted host resolver');
  assertOptionalBoolean(options, 'agentBackendClientEffects', 'ACP client effects require explicit host opt-in');
  if(options.agentBackendClientEffects&&options.agentBackends!==true)throw new EngineError("INVALID_CONFIG","ACP effects require agentBackends opt-in");
  assertOptionalBoolean(options, 'jobs', 'jobs requires an explicit root host boolean');
  assertOptionalBoolean(options, 'codeMode', 'codeMode requires an explicit boolean');
  if(options.codeMode&&options.tools)throw new EngineError('CODE_MODE_CUSTOM_TOOLS_UNSUPPORTED','Restricted code mode requires the actual engine core tool producers');
  assertOptionalBoolean(options, 'effectBatches', 'effectBatches requires an explicit boolean');
  assertOptionalBoolean(options, 'conversationForks', 'conversationForks must be an explicit boolean');
  if (teamModelTools && options.teams !== true) throw new EngineError('INVALID_CONFIG', 'Model team tools require explicit host teams');
  assertOptionalBoolean(options, 'proposalApply', 'proposalApply must be an explicit boolean');
  assertOptionalBoolean(options, 'diagnosticObservations', 'Execution observations require an explicit host boolean');
  if (options.verificationTools === true && options.tools !== undefined) throw new EngineError('INVALID_VERIFICATION_CONFIG', 'Verification requires the engine-owned command producer and core registrations');
  assertOptionalBoolean(options, 'osSandbox', 'osSandbox must be an explicit boolean');
  if(options.osSandbox && (options.repositoryContextTools||options.verificationTools||options.lifecycleHooks?.length||options.lifecycleHookRegistry?.list().length))throw new EngineError('SANDBOX_EXTERNAL_EFFECT_UNSUPPORTED','Repository/verification or host lifecycle callbacks require a separately sandbox-bound producer');
  if(options.osSandbox && options.tools)throw new EngineError('SANDBOX_CUSTOM_TOOLS_UNSUPPORTED','Custom effects cannot assert OS sandbox enforcement');
  assertOptionalBoolean(options, 'commandLifetimes', 'commandLifetimes requires an explicit host boolean');
  if(options.osSandbox && options.commandLifetimes===true)throw new EngineError('SANDBOX_COMMAND_LIFETIME_UNSUPPORTED','Interactive ownership transfer requires a separately sandbox-bound command lifetime producer');
  if(options.commandLifetimes===true&&(options.jobs!==true||options.hostCommands!==true))throw new EngineError('INVALID_CONFIG','commandLifetimes requires jobs and hostCommands');
  assertOptionalBoolean(options, 'hostCommands', 'hostCommands must be an explicit boolean');
  assertOptionalBoolean(options, 'allowUnknownMediaTokenCost', 'Media token cost policy must be a boolean');
  assertOptionalBoolean(options, 'allowUnknownDocumentTokenCost', 'Document token cost policy must be a boolean');
  assertOptionalBoolean(options, 'repositoryContextTools', 'Repository tool exposure must be an explicit boolean');
  if (options.lifecycleHooks !== undefined) {
    if (!Array.isArray(options.lifecycleHooks) || options.lifecycleHooks.length > lifecycleHooks.limits.maxHooks) throw new EngineError('INVALID_LIFECYCLE_HOOK', 'Initial lifecycle hooks must be a bounded explicit host list');
    for (const hook of options.lifecycleHooks) lifecycleHooks.register(hook);
  }
  const defaults = normalizeRunConfig(options.defaults ?? {});
  const mediaHistoryPolicy = options.mediaHistoryPolicy === undefined ? undefined : validateMediaHistoryPolicy(options.mediaHistoryPolicy);
  const activePrefixPolicy = options.activePrefixPolicy === undefined ? undefined : validateActivePrefixPolicy(options.activePrefixPolicy);
  const documentHistoryPolicy = options.documentHistoryPolicy === undefined ? undefined : validateDocumentHistoryPolicy(options.documentHistoryPolicy);
  const toolDiscoveryPolicy = options.toolDiscoveryPolicy === undefined ? undefined : validateToolDiscoveryPolicy(options.toolDiscoveryPolicy);
  const enabled: EngineFeatures = {
    sandbox, verification: options.verificationTools === true,
    knowledgeGeneration: options.knowledgeGeneration === true, knowledgePublication: options.knowledgePublication === true,
    knowledgeFilePublication: options.knowledgeFilePublication === true, knowledgeImportRecovery: options.knowledgeImportRecovery === true,
    proposals: options.proposals === true, proposalApply: options.proposalApply === true,
    teams: options.teams === true, teamModelTools, workflows: options.workflows === true, codingBatches: options.codingBatches === true,
    schedules: options.schedules === true, agentBackends: options.agentBackends === true, jobs: options.jobs === true,
    conversationForks: options.conversationForks === true,
  };
  return { enabled: Object.freeze(enabled), lifecycleHooks, defaults, repositoryPolicy, knowledgePolicy, proposalPolicy, mediaHistoryPolicy, activePrefixPolicy, documentHistoryPolicy, toolDiscoveryPolicy };
}
