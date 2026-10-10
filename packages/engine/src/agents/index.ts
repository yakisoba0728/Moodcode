import { createHash } from 'node:crypto';
import { EngineError, type JsonObject, type ReasoningEffort, type RunConfig } from '@moodcode/contracts';
import { normalizeEngineBudgets, normalizeRunConfig } from '@moodcode/contracts/validation';
import { boundedJson } from '../artifacts/validation.js';
import type { SessionDocumentStore } from '../session-state/index.js';

export interface AgentProfileSpec {
  id: string; description: string; instructions: string; tools?: readonly string[];
  model?: { providerId: string; modelId: string; reasoningEffort?: ReasoningEffort };
  turnAllowance?: number;
}
export interface AgentProfile extends AgentProfileSpec { revision: string }
const MODEL_KEYS: readonly string[] = ['providerId', 'modelId', 'reasoningEffort'];
const key = (id: string, revision: string) => `profile.${createHash('sha256').update(JSON.stringify([id, revision])).digest('hex').slice(0, 32)}`;
/** A profile supplies execution configuration; Plan/Build remains an independent safety mode. */
export class AgentProfiles {
  private readonly profiles = new Map<string, AgentProfile>();
  constructor(private readonly store: SessionDocumentStore, definitions: readonly AgentProfileSpec[] = []) { for (const profile of definitions) this.register(profile); }
  register(value: AgentProfileSpec): AgentProfile {
    const json = boundedJson(value, 65_536);
    if (!json || typeof json !== 'object' || Array.isArray(json) || Object.keys(json).some(key => !['id', 'description', 'instructions', 'tools', 'model', 'turnAllowance'].includes(key))) throw new EngineError('INVALID_AGENT_PROFILE', 'Agent profile requires bounded known fields');
    const profile = json as unknown as AgentProfileSpec;
    if (typeof profile.id !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(profile.id) || typeof profile.description !== 'string' || Buffer.byteLength(profile.description) > 4096
      || typeof profile.instructions !== 'string' || Buffer.byteLength(profile.instructions) > 32_768
      || profile.tools !== undefined && (!Array.isArray(profile.tools) || profile.tools.length > 256 || new Set(profile.tools).size !== profile.tools.length || profile.tools.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(name)))
      || profile.turnAllowance !== undefined && (!Number.isSafeInteger(profile.turnAllowance) || profile.turnAllowance < 1 || profile.turnAllowance > 10_000)) throw new EngineError('INVALID_AGENT_PROFILE', 'Profile identity, instructions, tools or allowance are invalid');
    if (profile.model !== undefined) {
      if (profile.model !== null && typeof profile.model === 'object' && !Array.isArray(profile.model) && Object.keys(profile.model).some(key => !MODEL_KEYS.includes(key))) throw new EngineError('INVALID_AGENT_PROFILE', 'Profile model accepts only providerId, modelId and reasoningEffort');
      normalizeRunConfig(profile.model);
    }
    if (!this.profiles.has(profile.id) && this.profiles.size >= 32) throw new EngineError('AGENT_PROFILE_LIMIT', 'Host agent profile registry is full');
    const revision = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
    const result = { ...structuredClone(profile), revision }; this.profiles.set(profile.id, result); return structuredClone(result);
  }
  list(): AgentProfile[] { return [...this.profiles.values()].map(profile => structuredClone(profile)); }
  /** `admitted` is the stored config of a request with the same ID; its retry resolves the persisted revision it was admitted with. */
  apply(sessionId: string, config: RunConfig, admitted?: RunConfig): RunConfig {
    if (!config.agentProfileId) return config;
    const revision = admitted?.agentProfileId === config.agentProfileId ? admitted.agentProfileRevision : undefined;
    const profile = revision && (config.agentProfileRevision ?? revision) === revision
      ? this.forRun(sessionId, { ...config, agentProfileRevision: revision }) : this.profiles.get(config.agentProfileId);
    if (!profile) throw new EngineError('AGENT_PROFILE_NOT_FOUND', 'Requested agent profile is not registered by this host');
    if (config.agentProfileRevision && config.agentProfileRevision !== profile.revision) throw new EngineError('AGENT_PROFILE_STALE', 'Requested profile revision differs from the registered configuration');
    const stored = this.store.getSessionDocument(sessionId, key(profile.id, profile.revision));
    if (!stored) this.store.putSessionDocument(sessionId, key(profile.id, profile.revision), 0, JSON.parse(JSON.stringify(profile)) as JsonObject);
    const model = Object.fromEntries(Object.entries(profile.model ?? {}).filter(([key]) => MODEL_KEYS.includes(key)));
    const merged = { ...config, ...model, agentProfileId: profile.id, agentProfileRevision: profile.revision,
      budgets: { ...normalizeEngineBudgets(config.budgets), ...(profile.turnAllowance === undefined ? {} : { turnAllowance: Math.min(profile.turnAllowance, config.limits.maxTurns) }) } };
    return normalizeRunConfig(merged);
  }
  forRun(sessionId: string, config: RunConfig): AgentProfile | undefined {
    if (!config.agentProfileId) return undefined;
    if (!config.agentProfileRevision) throw new EngineError('AGENT_PROFILE_BINDING', 'Running profile requires an immutable configuration revision');
    const document = this.store.getSessionDocument(sessionId, key(config.agentProfileId, config.agentProfileRevision));
    const profile = document?.data as unknown as AgentProfile | undefined;
    if (!profile || profile.id !== config.agentProfileId || profile.revision !== config.agentProfileRevision) throw new EngineError('AGENT_PROFILE_BINDING', 'Persisted profile identity is unavailable');
    const { revision, ...definition } = profile;
    if (createHash('sha256').update(JSON.stringify(definition)).digest('hex') !== revision) throw new EngineError('AGENT_PROFILE_BINDING', 'Persisted profile configuration changed');
    return structuredClone(profile);
  }
}
