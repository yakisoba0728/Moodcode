import { EngineError, type EngineBudgets, type RunConfig } from '@moodcode/contracts';
import { normalizeEngineBudgets, normalizeSubmitInput } from '@moodcode/contracts/validation';
import type { MoodcodeEngine } from '../engine.js';
import type { KnowledgeHostBinding } from '../knowledge/types.js';
import { immutableKnowledgeJson, knowledgeHash } from '../knowledge/validation.js';
import { exactKeys, isBoundedId, isSha256 } from '../shared/data.js';
import type { ToolCatalogue } from '../tools/runtime/index.js';

/** Serialized pins are data. The root producer separately authenticates ORIGINAL handles. */
export interface QueueTargetPin {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly workspaceBindingSha256: string;
  readonly capabilitiesSha256: string;
  readonly catalogueSha256: string;
  readonly profile: { readonly id: string; readonly revision: string } | null;
  readonly config: RunConfig & { budgets: EngineBudgets };
  readonly runConfigSha256: string;
  readonly tools: readonly string[];
  readonly delivery: 'queue';
  readonly allocation: {
    readonly maxTurns: number;
    readonly maxToolCalls: number;
    readonly maxOutputBytes: number;
    readonly maxDurationMs: number;
  };
}
export const QUEUE_TARGET_LIMITS = Object.freeze({ bytes: 32_768, tools: 128 });
const ALLOCATION = ['maxTurns', 'maxToolCalls', 'maxOutputBytes', 'maxDurationMs'] as const;

/** Pin faults keep the SCHEDULE_* codes that every producer has always reported for them. */
function invalid(code = 'INVALID_SCHEDULE_SPEC'): never {
  throw new EngineError(code, 'Schedules require bounded immutable definitions and explicit original host admission');
}
function json<T>(input: T): T {
  let result: T;
  try { result = immutableKnowledgeJson(input); } catch { return invalid(); }
  if (Buffer.byteLength(JSON.stringify(result)) > QUEUE_TARGET_LIMITS.bytes) invalid('SCHEDULE_LIMIT');
  return result;
}
function object(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const value = json(input);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, required, optional)) invalid();
  return value as Record<string, unknown>;
}
function identifier(input: unknown): string { return typeof input === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(input) ? input : invalid(); }
function externalId(input: unknown): string { return isBoundedId(input) && input.isWellFormed() ? input : invalid(); }
function sha(input: unknown): string { return isSha256(input) ? input : invalid(); }

/** Validated serialized scope still conveys no runtime owner, time, approval or lease authority. */
export function validateQueueTarget(input: unknown): QueueTargetPin {
  const value = object(input, ['workspaceId', 'sessionId', 'workspaceBindingSha256', 'capabilitiesSha256', 'catalogueSha256', 'profile', 'config', 'runConfigSha256', 'tools', 'delivery', 'allocation']);
  const config = object(value.config, ['providerId', 'modelId', 'mode', 'limits', 'budgets'], ['reasoningEffort', 'agentProfileId', 'agentProfileRevision']);
  let normalized: QueueTargetPin['config'];
  try {
    normalized = normalizeSubmitInput({ sessionId: value.sessionId, requestId: 'schedule-validation', prompt: 'validate', config }).config as QueueTargetPin['config'];
  } catch { return invalid('SCHEDULE_CONFIG_INVALID'); }
  if (knowledgeHash(config) !== knowledgeHash(normalized) || !normalized.budgets || sha(value.runConfigSha256) !== knowledgeHash(normalized)) invalid('SCHEDULE_CONFIG_INCOMPLETE');
  let profile: QueueTargetPin['profile'] = null;
  if (value.profile !== null) {
    const pin = object(value.profile, ['id', 'revision']);
    profile = { id: externalId(pin.id), revision: sha(pin.revision) };
  }
  if (profile
    ? normalized.agentProfileId !== profile.id || normalized.agentProfileRevision !== profile.revision
    : normalized.agentProfileId !== undefined || normalized.agentProfileRevision !== undefined) invalid('SCHEDULE_PROFILE_MISMATCH');
  if (value.delivery !== 'queue' || !Array.isArray(value.tools) || value.tools.length > QUEUE_TARGET_LIMITS.tools || new Set(value.tools).size !== value.tools.length) invalid('SCHEDULE_TARGET_INVALID');
  const tools = value.tools.map(externalId).sort();
  const allocation = object(value.allocation, ALLOCATION);
  for (const key of ALLOCATION) {
    if (!Number.isSafeInteger(allocation[key]) || (allocation[key] as number) < 1) invalid();
    if (allocation[key] !== normalized.limits[key]) invalid('SCHEDULE_ALLOCATION_MISMATCH');
  }
  return json({
    workspaceId: identifier(value.workspaceId), sessionId: identifier(value.sessionId),
    workspaceBindingSha256: sha(value.workspaceBindingSha256), capabilitiesSha256: sha(value.capabilitiesSha256), catalogueSha256: sha(value.catalogueSha256),
    profile, config: normalized, runConfigSha256: knowledgeHash(normalized), tools, delivery: 'queue',
    allocation: { maxTurns: normalized.limits.maxTurns, maxToolCalls: normalized.limits.maxToolCalls, maxOutputBytes: normalized.limits.maxOutputBytes, maxDurationMs: normalized.limits.maxDurationMs },
  });
}

export type QueueTargetChange = 'session' | 'provider' | 'profile';
const JOB_TARGET_CHANGES = {
  session: ['JOB_TARGET_STALE', 'The queue target session changed'],
  provider: ['JOB_PROVIDER_UNSUPPORTED', 'The queue target provider is unavailable'],
  profile: ['JOB_PROFILE_STALE', 'The queue target profile changed'],
} as const;
/** The codes every producer except schedules reports for a changed queue target. */
export function jobTargetChanged(change: QueueTargetChange): never {
  const [code, message] = JOB_TARGET_CHANGES[change];
  throw new EngineError(code, message);
}
export interface QueueTarget { readonly pin: QueueTargetPin; readonly binding: KnowledgeHostBinding; readonly catalogue: ToolCatalogue }
/** Pins the current session, provider, profile and tool catalogue; each producer retains its own ORIGINAL authority. */
export function describeQueueTarget(engine: MoodcodeEngine, readBinding: (workspaceId: string) => KnowledgeHostBinding, workspaceId: string, sessionId: string,
  input: RunConfig, changed: (change: QueueTargetChange) => never): QueueTarget {
  const config = { ...input, budgets: normalizeEngineBudgets(input.budgets) };
  const binding = readBinding(workspaceId);
  if (engine.store.getSession(sessionId).workspaceId !== workspaceId) changed('session');
  const capabilities = engine.getCapabilities();
  if (!capabilities.providerIds.includes(config.providerId)) changed('provider');
  const profile = engine.profiles.forRun(sessionId, config);
  if (profile && !engine.profiles.list().some(item => item.id === profile.id && item.revision === profile.revision)) changed('profile');
  const profilePin = profile ? { id: profile.id, revision: profile.revision } : null;
  const tools = capabilities.tools.map(tool => tool.name);
  const catalogue = engine.toolRuntime.catalogue('engine', config.mode, profile?.tools ? tools.filter(name => profile.tools!.includes(name)) : tools, profilePin ?? undefined);
  const pin = validateQueueTarget({
    workspaceId, sessionId, workspaceBindingSha256: knowledgeHash(binding), capabilitiesSha256: knowledgeHash(capabilities), catalogueSha256: knowledgeHash(catalogue),
    profile: profilePin, config, runConfigSha256: knowledgeHash(config), tools: catalogue.tools.map(tool => tool.name).sort(), delivery: 'queue',
    allocation: { maxTurns: config.limits.maxTurns, maxToolCalls: config.limits.maxToolCalls, maxOutputBytes: config.limits.maxOutputBytes, maxDurationMs: config.limits.maxDurationMs },
  });
  return { pin, binding, catalogue };
}
