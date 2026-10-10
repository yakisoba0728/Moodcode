import {hasPreparedResourceProducer,capturePreparedResource} from '../../effect-batches/claims.js';
import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import type { ApprovalPort, PreparedTool, ProviderTool, ToolContext, ToolDefinition, ToolResult } from '../../ports.js';
import { ArtifactStore } from '../../artifacts/store.js';
import { createToolResultEnvelope, enrichLegacyToolResult } from '../../artifacts/result.js';
import { boundedJson } from '../../artifacts/validation.js';
import { inferToolEffect, ToolPolicy, withPathRestriction, type ToolEffectClass } from '../../permission/policy.js';
import { ScopedToolGrants, type GrantScope, type ScopedToolGrant } from '../../permission/grants.js';
import { RoleResourcePolicy, type RoleResource, type RoleResourceInput, type RoleResourceReceipt } from '../../permission/role-resources.js';
import { RoleResourcePolicyRegistry, type RoleResourcePolicyCapture, type RoleResourcePolicyGeneration } from '../../permission/role-policy-registry.js';
import { CommandPreflightRegistry, type CommandPreflightBinding, type CommandPreflightReceipt } from '../../permission/preflight.js';
import { TOOL_DISCOVERY_LIMITS, discoveryCatalogueSignature, validateDiscoveryMaterializeLimits, validateDiscoveryNames, validateDiscoveryQuery,
  type ToolDiscoveryCatalogue, type ToolDiscoveryMaterializeLimits, type ToolDiscoveryMetadata } from './discovery.js';
import { createToolRegistrationManifest, type ToolRegistrationManifest } from '../../diagnostics/tool-registration-manifest.js';
export interface RuntimeToolRegistration { effect?: ToolEffectClass; exactApproval?: boolean; revalidate?: (prepared: PreparedTool, context: ToolContext) => Promise<void> }
export interface RuntimeToolProfile { id: string; revision: string }
/** Host-owned observation of one exact registration; carries no execute capability. */
export interface ToolRegistrationCapture { readonly scopeId: string; readonly name: string }
export interface ToolCatalogue { scopeId: string; revision: number; policyVersion: number; mode: 'plan' | 'build'; tools: readonly ProviderTool[]; profile?: Readonly<RuntimeToolProfile>; rolePolicy?: RoleResourcePolicyGeneration }
export interface RuntimePolicyDecisionObservation {
  readonly roleResource?: RoleResourceReceipt; readonly commandPreflight?: CommandPreflightReceipt; readonly rolePolicy?: RoleResourcePolicyGeneration;
}
export interface RuntimePreparedToolObservation {
  readonly scopeId: string; readonly producerScopeId: string; readonly registryRevision: number; readonly mode: 'plan' | 'build';
  readonly effect: ToolEffectClass; readonly profile?: Readonly<RuntimeToolProfile>; readonly prepared: Readonly<PreparedTool>;
  readonly rolePolicy?: RoleResourcePolicyGeneration;
  readonly identity: Readonly<{ workspaceId: string; workspaceRoot: string; sessionId: string; runId: string; toolCallId: string; turnId?: string; attemptId?: string }>;
}
export interface RuntimeCommandPreflightOptions {
  registry: CommandPreflightRegistry;
  /** Trusted host selector. undefined explicitly disables this analyzer for the observed tool. */
  selectAnalyzer(observation: RuntimePreparedToolObservation): string | undefined;
  /** Actual host source hash/generation for the command's observed inputs, including uncommitted changes. Catalogue revision is not a source revision. */
  resolveSourceRevision?(observation: RuntimePreparedToolObservation): string | undefined;
  deadlineMs?: number;
}
export interface ScopedToolRuntimeOptions {
  preparedResourceTools?:readonly ToolDefinition[];
  /** Exact original engine registrations whose observed inputs are workspace files. */
  workspaceSourceTools?: readonly ToolDefinition[];
  /** Trusted owner observation after policy validation and before the sole producer call. */
  beforeProducer?(prepared: PreparedTool, context: ToolContext): Promise<() => void>;
  policy?: ToolPolicy; grants?: ScopedToolGrants; artifacts?: ArtifactStore | Promise<ArtifactStore> | (() => ArtifactStore | Promise<ArtifactStore>);
  /** Host-known optional storage capability, fixed before any producer dispatch. */
  artifactsUnavailable?: Readonly<{ code: 'ARTIFACT_PLATFORM_UNSUPPORTED'; reason: string }>;
  roleResources?: RoleResourcePolicy;
  /** Shared host-only CAS policy holder. Cannot be combined with the immutable roleResources option. */
  roleResourcePolicyRegistry?: RoleResourcePolicyRegistry;
  /** Host-owned resource declarations; MCP identities must come from the connected host catalogue. Receives no executable inner capability. */
  resolveRoleResources?(observation: RuntimePreparedToolObservation): readonly RoleResource[];
  commandPreflight?: RuntimeCommandPreflightOptions;
}
interface Entry { scopeId: string; token: symbol; sourceIdentity: ToolDefinition; definition: ToolDefinition; descriptor: Readonly<ProviderTool>; metadata: Readonly<ToolDiscoveryMetadata>; effect: ToolEffectClass; exactApproval: boolean; revalidate?: RuntimeToolRegistration['revalidate'] }
interface Captured { entries: Map<string, Entry>; signature: string; roleCapture?: RoleResourcePolicyCapture }
interface Request { entry: Entry; catalogue: ToolCatalogue; inner: PreparedTool; outerSnapshot: string; innerSnapshot: string; binding: string; grant?: ScopedToolGrant; grantScope: GrantScope; used: boolean; roleReceipt?: RoleResourceReceipt; preflightReceipt?: CommandPreflightReceipt; roleCapture?: RoleResourcePolicyCapture }
function fail(code: string, message: string): never { throw new EngineError(code, message); }
function active(context: ToolContext): void { if (context.signal.aborted) fail('CANCELLED', 'Tool runtime operation cancelled'); }
function binding(context: ToolContext): string { return JSON.stringify([context.workspace.id, context.workspace.root, context.sessionId, context.runId, context.toolCallId, context.turnId, context.attemptId, context.executionLockPath]); }
function name(value: string): void { if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)) fail('INVALID_TOOL_REGISTRATION', 'Tool and scope names must be bounded identifiers'); }
function freezeJson(value: unknown): void { if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeJson(child); Object.freeze(value); } }
function roleGeneration(capture: RoleResourcePolicyCapture): RoleResourcePolicyGeneration {
  return Object.freeze({ registryId: capture.registryId, registryRevision: capture.registryRevision, policyRevision: capture.policyRevision, policySha256: capture.policySha256 });
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value)!;
}
function resources(prepared: PreparedTool): string[] {
  const input = prepared.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const targets: string[] = [];
  for (const key of ['path', 'destination', 'cwd']) if (typeof input[key] === 'string') targets.push(`path:${input[key]}`);
  if (typeof input.command === 'string') targets.push(`command:${input.command}`);
  if (Array.isArray(input.changes)) for (const change of input.changes) if (change && typeof change === 'object' && !Array.isArray(change) && typeof change.path === 'string') targets.push(`path:${change.path}`);
  return [...new Set(targets)].sort();
}
/** Captures handlers with their catalogue revision. The existing coordinator remains the approval owner. */
export class ScopedToolRuntime {
  readonly policy: ToolPolicy; readonly grants: ScopedToolGrants;
  private scopes = new Map<string, Map<string, Entry>>(); private current = 0;
  private included = new Map<string, readonly string[]>(); private artifactPromise?: Promise<ArtifactStore>;
  private captures = new WeakMap<ToolCatalogue, Captured>(); private requests = new WeakMap<PreparedTool, Request>();
  private registrationCaptures = new WeakMap<ToolRegistrationCapture, Entry>();
  private registrationIdentities = new WeakMap<Entry, Readonly<{ revision: number; sha256: string }>>();
  private discoveryCaptures = new WeakMap<ToolDiscoveryCatalogue, Captured>();
  private profileCaptures = new WeakMap<ToolCatalogue, Map<string, ToolCatalogue>>();
  private policyFailures = new WeakMap<object, RuntimePolicyDecisionObservation>();
  private readonly roleResources?: RoleResourcePolicy;
  private readonly roleResourcePolicyRegistry?: RoleResourcePolicyRegistry;
  private readonly resolveRoleResources?: ScopedToolRuntimeOptions['resolveRoleResources'];
  private readonly commandPreflight?: Readonly<RuntimeCommandPreflightOptions>;
  private readonly artifactsUnavailable?: ScopedToolRuntimeOptions['artifactsUnavailable'];
  constructor(private readonly options: ScopedToolRuntimeOptions = {}) {
    this.policy = options.policy ?? new ToolPolicy(); this.grants = options.grants ?? new ScopedToolGrants();
    if (options.roleResources && options.roleResourcePolicyRegistry) fail('INVALID_ROLE_POLICY_CONFIGURATION', 'Use one immutable role policy or one shared role policy registry');
    this.roleResources = options.roleResources; this.resolveRoleResources = options.resolveRoleResources;
    this.roleResourcePolicyRegistry = options.roleResourcePolicyRegistry;
    this.commandPreflight = options.commandPreflight ? Object.freeze({ registry: options.commandPreflight.registry, selectAnalyzer: options.commandPreflight.selectAnalyzer.bind(options.commandPreflight), resolveSourceRevision: options.commandPreflight.resolveSourceRevision?.bind(options.commandPreflight), deadlineMs: options.commandPreflight.deadlineMs }) : undefined;
    if (options.artifactsUnavailable) {
      if (options.artifacts !== undefined || options.artifactsUnavailable.code !== 'ARTIFACT_PLATFORM_UNSUPPORTED' ||
        typeof options.artifactsUnavailable.reason !== 'string' || !options.artifactsUnavailable.reason ||
        Buffer.byteLength(options.artifactsUnavailable.reason) > 256) fail('INVALID_ARTIFACT_CONFIGURATION', 'Known unavailable artifact storage requires one bounded host capability and no persistence port');
      this.artifactsUnavailable = Object.freeze({ ...options.artifactsUnavailable });
    }
  }
  get revision(): number { return this.current; }
  /** Reads one current original entry without catalogue materialization, policy evaluation or producer calls. */
  inspectToolRegistration(scopeId: string, toolName: string): ToolRegistrationManifest {
    name(scopeId); name(toolName);
    const entry = this.scopes.get(scopeId)?.get(toolName);
    if (!entry) fail('TOOL_NOT_FOUND', 'Tool is not currently registered in the exact scope');
    const identity = this.registrationIdentities.get(entry);
    if (!identity) fail('TOOL_PRODUCER_MISMATCH', 'Tool registration identity is unavailable');
    return createToolRegistrationManifest({ scopeId, name: entry.descriptor.name, registryRevision: this.current, policyRevision: this.policy.version,
      registrationRevision: identity.revision, registrationSha256: identity.sha256, effectClass: entry.effect, exactApproval: entry.exactApproval,
      schemaSha256: entry.metadata.schemaSha256, schemaBytes: entry.metadata.schemaBytes,
      descriptionSha256: createHash('sha256').update(entry.descriptor.description).digest('hex'), descriptionBytes: Buffer.byteLength(entry.descriptor.description) });
  }
  private rolePolicyCurrent(capture?: RoleResourcePolicyCapture): boolean {
    if (!this.roleResourcePolicyRegistry) return capture === undefined;
    try { this.roleResourcePolicyRegistry.assertCurrent(capture!); return true; } catch { return false; }
  }
  setIncludedScopes(scopeId: string, scopes: readonly string[]): void {
    name(scopeId); if (!Array.isArray(scopes) || scopes.length > 128 || new Set(scopes).size !== scopes.length || scopes.includes(scopeId)) fail('INVALID_TOOL_SCOPE_COMPOSITION', 'Included scopes must be unique bounded scopes distinct from the base');
    for (const scope of scopes) name(scope);
    const names = new Set<string>(); for (const scope of [scopeId, ...scopes]) for (const toolName of this.scopes.get(scope)?.keys() ?? []) { if (names.has(toolName)) fail('TOOL_SCOPE_CONFLICT', 'Included scopes contain duplicate tool names'); names.add(toolName); }
    if (JSON.stringify(this.included.get(scopeId) ?? []) !== JSON.stringify(scopes)) { this.included.set(scopeId, [...scopes]); this.current++; }
  }
  /** Logical read identity excludes per-call authorization identity; it authorizes no effect. */
  repeatIdentity(prepared: PreparedTool): string {
    const request = this.requests.get(prepared);
    if (!request || JSON.stringify(prepared) !== request.outerSnapshot || JSON.stringify(request.inner) !== request.innerSnapshot) fail('INVALID_PREPARED_TOOL', 'Logical read identity requires an unchanged runtime-prepared request');
    this.entry(request.catalogue, prepared.name);
    return createHash('sha256').update(JSON.stringify({ scope: request.catalogue.scopeId, revision: request.catalogue.revision, policyVersion: request.catalogue.policyVersion, name: request.inner.name, fingerprint: request.inner.fingerprint, ...(request.catalogue.profile ? { profile: request.catalogue.profile } : {}), ...(request.roleCapture ? { rolePolicy: roleGeneration(request.roleCapture) } : {}) })).digest('hex');
  }
  /** Detached metadata from the original prepared request; never invokes a producer or revalidation. */
  getExecutionMetadata(prepared: PreparedTool): Readonly<{ effectClass: ToolEffectClass; effectiveInputSha256: string; workspaceSource: boolean }> {
    const request = this.requests.get(prepared);
    if (!request || JSON.stringify(prepared) !== request.outerSnapshot || JSON.stringify(request.inner) !== request.innerSnapshot) fail('INVALID_PREPARED_TOOL', 'Execution metadata requires the unchanged original runtime request');
    return Object.freeze({ effectClass: request.entry.effect, effectiveInputSha256: createHash('sha256').update(JSON.stringify(request.inner.input)).digest('hex'), workspaceSource: this.options.workspaceSourceTools?.includes(request.entry.sourceIdentity) === true });
  }
  /** Detached immutable observation for journaling. Validates ownership and snapshots only; revalidates no current authority and grants no execution/approval capability. */
  getPolicyDecisionReceipt(prepared: PreparedTool): RuntimePolicyDecisionObservation | undefined {
    const request = this.requests.get(prepared);
    if (!request || JSON.stringify(prepared) !== request.outerSnapshot || JSON.stringify(request.inner) !== request.innerSnapshot) fail('INVALID_PREPARED_TOOL', 'Policy observations require the unchanged runtime-owned prepared request');
    if (!request.roleReceipt && !request.preflightReceipt) return undefined;
    const observation = { ...(request.roleReceipt ? { roleResource: structuredClone(request.roleReceipt) } : {}), ...(request.preflightReceipt ? { commandPreflight: structuredClone(request.preflightReceipt) } : {}), ...(request.roleCapture ? { rolePolicy: roleGeneration(request.roleCapture) } : {}) };
    freezeJson(observation); return observation;
  }
  /** Only runtime-owned denial errors carry trusted observations. Arbitrary producer error fields are never read. */
  getPolicyDecisionFailure(error: unknown): RuntimePolicyDecisionObservation | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const observation = this.policyFailures.get(error); if (!observation) return undefined;
    const copy = structuredClone(observation); freezeJson(copy); return copy;
  }
  private denyNarrowing(code: string, message: string, observation: RuntimePolicyDecisionObservation): never {
    const error = new EngineError(code, message); const copy = structuredClone(observation); freezeJson(copy); this.policyFailures.set(error, copy); throw error;
  }
  register(scopeId: string, source: ToolDefinition, options: RuntimeToolRegistration = {}): () => void {
    if (options.exactApproval !== undefined && typeof options.exactApproval !== 'boolean') fail('INVALID_TOOL_REGISTRATION', 'Exact approval must be a boolean');
    name(scopeId); name(source.name); if (typeof source.prepare !== 'function' || typeof source.execute !== 'function' || typeof source.description !== 'string' || Buffer.byteLength(source.description) > 8192) fail('INVALID_TOOL_REGISTRATION', 'Tool requires bounded schema/description and prepare/execute handlers');
    if (!this.scopes.has(scopeId) && this.scopes.size >= 128) fail('TOOL_REGISTRY_LIMIT', 'Tool scope limit exceeded');
    const entries = this.scopes.get(scopeId) ?? new Map<string, Entry>(); if (entries.has(source.name)) fail('TOOL_REGISTRATION_CONFLICT', 'Tool name already exists in this scope'); if (entries.size >= 256) fail('TOOL_REGISTRY_LIMIT', 'Tool registration limit exceeded');
    for (const [base, included] of this.included) { const group = [base, ...included]; if (group.includes(scopeId) && group.some(scope => scope !== scopeId && this.scopes.get(scope)?.has(source.name))) fail('TOOL_SCOPE_CONFLICT', 'Tool name conflicts with an explicitly included scope'); }
    const schema = boundedJson(source.inputSchema, 64 * 1024) as JsonObject; if (!schema || typeof schema !== 'object' || Array.isArray(schema)) fail('INVALID_TOOL_REGISTRATION', 'Tool schema must be a JSON object');
    freezeJson(schema);
    const descriptor = Object.freeze({ name: source.name, description: source.description, inputSchema: schema });
    const metadata = Object.freeze({ name: descriptor.name, description: descriptor.description,
      schemaSha256: createHash('sha256').update(canonicalJson(schema)).digest('hex'), definitionSha256: createHash('sha256').update(canonicalJson(descriptor)).digest('hex'),
      schemaBytes: Buffer.byteLength(JSON.stringify(schema)), definitionBytes: Buffer.byteLength(JSON.stringify(descriptor)) });
    const effect = inferToolEffect(source.name, options.effect ?? (source as ToolDefinition & { effectClass?: ToolEffectClass }).effectClass);
    const definition: ToolDefinition = { name: source.name, description: source.description, inputSchema: schema, effectClass: effect, prepare: source.prepare.bind(source), execute: source.execute.bind(source) };
    const entry: Entry = { scopeId, token: Symbol(source.name), sourceIdentity: source, definition, descriptor, metadata, effect, exactApproval: options.exactApproval === true, ...(options.revalidate ? { revalidate: options.revalidate } : {}) };
    this.registrationIdentities.set(entry, Object.freeze({ revision: this.current + 1, sha256: createHash('sha256').update(randomUUID()).digest('hex') }));
    entries.set(source.name, entry); this.scopes.set(scopeId, entries); this.current++;
    return () => { const existing = this.scopes.get(scopeId); if (existing?.get(definition.name)?.token !== entry.token) return; existing.delete(definition.name); if (!existing.size) this.scopes.delete(scopeId); this.current++; };
  }
  clearScope(scopeId: string): void { if (this.scopes.delete(scopeId)) this.current++; }
  captureRegistration(scopeId: string, toolName: string, source: ToolDefinition): ToolRegistrationCapture {
    const entry = this.scopes.get(scopeId)?.get(toolName);
    if (!entry || entry.sourceIdentity !== source) fail('TOOL_PRODUCER_MISMATCH', 'Producer observation requires the original registered definition');
    const capture = Object.freeze({ scopeId, name: toolName });
    this.registrationCaptures.set(capture, entry);
    return capture;
  }
  assertRegistrationCurrent(catalogue: ToolCatalogue, capture: ToolRegistrationCapture): void {
    const captured = this.registrationCaptures.get(capture);
    if (!captured || captured.scopeId !== capture.scopeId || captured.definition.name !== capture.name || this.entry(catalogue, capture.name) !== captured) fail('TOOL_PRODUCER_MISMATCH', 'The authenticated catalogue does not contain the captured original producer');
  }
  catalogue(scopeId: string, mode: 'plan' | 'build' = 'build', allowedNames?: readonly string[], profile?: RuntimeToolProfile): ToolCatalogue {
    if (mode !== 'plan' && mode !== 'build') fail('INVALID_TOOL_MODE', 'Tool catalogue mode must be plan or build');
    if (allowedNames !== undefined && (!Array.isArray(allowedNames) || allowedNames.length > 256 || allowedNames.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(name)))) fail('INVALID_TOOL_ALLOWLIST', 'Tool allowlist must contain bounded exact names');
    const allowed = allowedNames === undefined ? undefined : new Set(allowedNames);
    const entries = new Map<string, Entry>(); const tools: ProviderTool[] = [];
    for (const selected of [scopeId, ...this.included.get(scopeId) ?? []]) for (const [toolName, entry] of this.scopes.get(selected) ?? []) {
      if (entries.has(toolName)) fail('TOOL_SCOPE_CONFLICT', 'Composed catalogue contains duplicate tool names');
      if (allowed && !allowed.has(toolName)) continue;
      if (this.policy.evaluate({ toolName, effect: entry.effect, mode, requiresApproval: false }).decision === 'deny') continue;
      entries.set(toolName, entry); tools.push({ name: toolName, description: entry.definition.description, inputSchema: structuredClone(entry.definition.inputSchema) });
    }
    const roleCapture = this.roleResourcePolicyRegistry?.capture();
    const catalogue: ToolCatalogue = { scopeId, revision: this.current, policyVersion: this.policy.version, mode, tools, ...(roleCapture ? { rolePolicy: roleGeneration(roleCapture) } : {}) };
    this.captures.set(catalogue, { entries, signature: JSON.stringify(catalogue), ...(roleCapture ? { roleCapture } : {}) }); return profile ? this.bindProfile(catalogue, profile) : catalogue;
  }
  /** Host-only narrowing of a current eager or materialized discovery capture. Never accepts a model-selected role. */
  bindProfile(catalogue: ToolCatalogue, profile: RuntimeToolProfile): ToolCatalogue {
    this.assertCatalogueCurrent(catalogue);
    if (!profile || typeof profile !== 'object' || types.isProxy(profile) || Array.isArray(profile) || ![Object.prototype, null].includes(Object.getPrototypeOf(profile))) fail('INVALID_TOOL_PROFILE', 'Captured profile must be a plain host record');
    if (Reflect.ownKeys(profile).some(key => typeof key !== 'string' || !['id', 'revision'].includes(key)) || Object.values(Object.getOwnPropertyDescriptors(profile)).some(field => !Object.hasOwn(field, 'value') || !field.enumerable) || [profile.id, profile.revision].some(value => typeof value !== 'string' || !value || Buffer.byteLength(value) > 512 || /[\u0000-\u001f\u007f]/.test(value))) fail('INVALID_TOOL_PROFILE', 'Captured tool profile requires bounded data identity and revision');
    const frozen = Object.freeze({ id: profile.id, revision: profile.revision }), key = JSON.stringify(frozen);
    if (catalogue.profile) { if (JSON.stringify(catalogue.profile) !== key) fail('TOOL_PROFILE_STALE', 'A captured role profile cannot be rebound'); return catalogue; }
    const profiles = this.profileCaptures.get(catalogue) ?? new Map<string, ToolCatalogue>();
    const previous = profiles.get(key); if (previous) { this.assertCatalogueCurrent(previous); return previous; }
    if (profiles.size >= 128) fail('TOOL_PROFILE_LIMIT', 'Too many role profiles bound to one captured catalogue');
    const result = { ...catalogue, profile: frozen };
    this.captures.set(result, { entries: this.captures.get(catalogue)!.entries, signature: JSON.stringify(result), ...(this.captures.get(catalogue)!.roleCapture ? { roleCapture: this.captures.get(catalogue)!.roleCapture } : {}) }); profiles.set(key, result); this.profileCaptures.set(catalogue, profiles); return result;
  }
  /** Candidate metadata carries no schema or execution authority. Host profile and policy narrowing apply before exposure. */
  discoveryCatalogue(scopeId: string, mode: 'plan' | 'build' = 'build', allowedNames?: readonly string[]): ToolDiscoveryCatalogue {
    name(scopeId);
    if (mode !== 'plan' && mode !== 'build') fail('INVALID_TOOL_MODE', 'Tool discovery mode must be plan or build');
    const allowed = allowedNames === undefined ? undefined : new Set(validateDiscoveryNames(allowedNames, 'INVALID_TOOL_ALLOWLIST'));
    const entries = new Map<string, Entry>(), tools: ToolDiscoveryMetadata[] = [];
    let bytes = Buffer.byteLength(JSON.stringify({ scopeId, revision: this.current, policyVersion: this.policy.version, mode, tools: [] }));
    for (const selected of [scopeId, ...this.included.get(scopeId) ?? []]) for (const [toolName, entry] of this.scopes.get(selected) ?? []) {
      if (entries.has(toolName)) fail('TOOL_SCOPE_CONFLICT', 'Composed discovery catalogue contains duplicate tool names');
      if (allowed && !allowed.has(toolName)) continue;
      if (this.policy.evaluate({ toolName, effect: entry.effect, mode, requiresApproval: false }).decision === 'deny') continue;
      if (tools.length >= TOOL_DISCOVERY_LIMITS.maxCandidates) fail('TOOL_DISCOVERY_LIMIT', 'Tool discovery candidate limit exceeded');
      bytes += Buffer.byteLength(JSON.stringify(entry.metadata)) + (tools.length ? 1 : 0);
      if (bytes > TOOL_DISCOVERY_LIMITS.maxMetadataBytes) fail('TOOL_DISCOVERY_LIMIT', 'Tool discovery metadata byte limit exceeded');
      entries.set(toolName, entry); tools.push({ ...entry.metadata });
    }
    const catalogue: ToolDiscoveryCatalogue = { scopeId, revision: this.current, policyVersion: this.policy.version, mode, tools };
    const roleCapture = this.roleResourcePolicyRegistry?.capture();
    this.discoveryCaptures.set(catalogue, { entries, signature: discoveryCatalogueSignature(catalogue), ...(roleCapture ? { roleCapture } : {}) }); return catalogue;
  }
  assertDiscoveryCurrent(catalogue: ToolDiscoveryCatalogue): void {
    const captured = this.discoveryCaptures.get(catalogue);
    if (!captured || captured.signature !== discoveryCatalogueSignature(catalogue) || catalogue.revision !== this.current || catalogue.policyVersion !== this.policy.version || !this.rolePolicyCurrent(captured.roleCapture)) fail('TOOL_DISCOVERY_STALE', 'Tool discovery registry, policy or captured metadata changed');
    for (const entry of captured.entries.values()) if (this.scopes.get(entry.scopeId)?.get(entry.definition.name)?.token !== entry.token) fail('TOOL_DISCOVERY_STALE', 'Tool discovery registration changed');
  }
  searchDiscovery(catalogue: ToolDiscoveryCatalogue, query: string, limit = 4): ToolDiscoveryMetadata[] {
    const search = validateDiscoveryQuery(query, limit); this.assertDiscoveryCurrent(catalogue);
    const matches: { metadata: ToolDiscoveryMetadata; rank: number }[] = [];
    for (const entry of this.discoveryCaptures.get(catalogue)!.entries.values()) {
      const toolName = entry.metadata.name.toLowerCase(), description = entry.metadata.description.toLowerCase();
      const rank = toolName === search.query ? 0 : toolName.startsWith(search.query) ? 1 : toolName.includes(search.query) ? 2 : description.includes(search.query) ? 3 : -1;
      if (rank >= 0) matches.push({ metadata: entry.metadata, rank });
    }
    matches.sort((left, right) => left.rank - right.rank || (left.metadata.name < right.metadata.name ? -1 : left.metadata.name > right.metadata.name ? 1 : 0));
    return matches.slice(0, search.limit).map(match => ({ ...match.metadata }));
  }
  /** Limits the exact JSON tool-array bytes before any selected schema is cloned. */
  materializeDiscovery(catalogue: ToolDiscoveryCatalogue, selectedNames: readonly string[], supplied: ToolDiscoveryMaterializeLimits): ToolCatalogue {
    this.assertDiscoveryCurrent(catalogue);
    const names = validateDiscoveryNames(selectedNames, 'TOOL_DISCOVERY_LIMIT'), limits = validateDiscoveryMaterializeLimits(supplied);
    if (names.length > limits.maxTools) fail('TOOL_DISCOVERY_LIMIT', 'Visible tool count limit exceeded');
    const captured = this.discoveryCaptures.get(catalogue)!;
    const entries = new Map<string, Entry>(); let bytes = 2;
    for (const toolName of names) {
      const entry = captured.entries.get(toolName);
      if (!entry) fail('TOOL_NOT_FOUND', 'Tool is not available in the captured discovery catalogue');
      bytes += entry.metadata.definitionBytes + (entries.size ? 1 : 0);
      if (bytes > limits.maxBytes) fail('TOOL_DISCOVERY_LIMIT', 'Visible tool schema byte limit exceeded');
      entries.set(toolName, entry);
    }
    if (bytes > limits.maxBytes) fail('TOOL_DISCOVERY_LIMIT', 'Visible tool schema byte limit exceeded');
    const tools: ProviderTool[] = [...entries.values()].map(entry => ({ name: entry.descriptor.name, description: entry.descriptor.description, inputSchema: structuredClone(entry.descriptor.inputSchema) }));
    this.assertDiscoveryCurrent(catalogue);
    const result: ToolCatalogue = { scopeId: catalogue.scopeId, revision: catalogue.revision, policyVersion: catalogue.policyVersion, mode: catalogue.mode, tools, ...(captured.roleCapture ? { rolePolicy: roleGeneration(captured.roleCapture) } : {}) };
    this.captures.set(result, { entries, signature: JSON.stringify(result), ...(captured.roleCapture ? { roleCapture: captured.roleCapture } : {}) }); return result;
  }
  resolve(catalogue: ToolCatalogue, toolName: string): ToolDefinition {
    const entry = this.entry(catalogue, toolName); return this.delegateCaptured(catalogue, entry);
  }
  /** Validates an exact captured catalogue even when it contains no tools. */
  assertCatalogueCurrent(catalogue: ToolCatalogue): void {
    const captured = this.captures.get(catalogue);
    if (!captured || captured.signature !== JSON.stringify(catalogue) || catalogue.revision !== this.current || catalogue.policyVersion !== this.policy.version || !this.rolePolicyCurrent(captured.roleCapture)) fail('TOOL_CATALOGUE_STALE', 'Tool registry, policy or captured catalogue changed; request a fresh catalogue');
  }
  hasPreparedResources(catalogue:ToolCatalogue,toolName:string):boolean {this.assertCatalogueCurrent(catalogue);if(!this.captures.get(catalogue)!.entries.has(toolName))return false;const entry=this.entry(catalogue,toolName);return this.options.preparedResourceTools?.includes(entry.sourceIdentity)===true && hasPreparedResourceProducer(entry.sourceIdentity);}
  async capturePreparedResources(prepared:PreparedTool,context:ToolContext):Promise<object|null>{await this.assertPreparedCurrent(prepared,context);const request=this.requests.get(prepared)!;if(!this.options.preparedResourceTools?.includes(request.entry.sourceIdentity))return null;return capturePreparedResource(request.entry.sourceIdentity,request.inner);}
  /** For old runner registration: every prepare takes a fresh catalogue snapshot. */
  delegate(scopeId: string, toolName: string, mode: 'plan' | 'build' = 'build'): ToolDefinition {
    const initial = [scopeId, ...this.included.get(scopeId) ?? []].map(scope => this.scopes.get(scope)?.get(toolName)).find(Boolean); if (!initial) fail('TOOL_NOT_FOUND', 'Tool is not registered in the scope');
    return { name: toolName, description: initial.definition.description, inputSchema: structuredClone(initial.definition.inputSchema), effectClass: initial.effect,
      prepare: (input, context) => this.resolve(this.catalogue(scopeId, mode), toolName).prepare(input, context), execute: (prepared, context) => this.execute(prepared, context) };
  }
  private entry(catalogue: ToolCatalogue, toolName: string): Entry {
    this.assertCatalogueCurrent(catalogue);
    const captured = this.captures.get(catalogue)!;
    const entry = captured.entries.get(toolName); if (!entry || this.scopes.get(entry.scopeId)?.get(toolName)?.token !== entry.token) fail('TOOL_NOT_FOUND', 'Tool is not available in the captured catalogue'); return entry;
  }
  private observation(catalogue: ToolCatalogue, entry: Entry, inner: PreparedTool, context: ToolContext): RuntimePreparedToolObservation {
    const prepared = structuredClone(inner); freezeJson(prepared);
    return Object.freeze({ scopeId: catalogue.scopeId, producerScopeId: entry.scopeId, registryRevision: catalogue.revision, mode: catalogue.mode, effect: entry.effect,
      ...(catalogue.profile ? { profile: catalogue.profile } : {}), prepared,
      ...(catalogue.rolePolicy ? { rolePolicy: catalogue.rolePolicy } : {}),
      identity: Object.freeze({ workspaceId: context.workspace.id, workspaceRoot: context.workspace.root, sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId, ...(context.turnId ? { turnId: context.turnId } : {}), ...(context.attemptId ? { attemptId: context.attemptId } : {}) }) });
  }
  private roleInput(catalogue: ToolCatalogue, entry: Entry, inner: PreparedTool, context: ToolContext, policy: import('../../permission/policy.js').ToolPolicyResult): RoleResourceInput {
    const observation = this.observation(catalogue, entry, inner, context);
    let declared: readonly RoleResource[];
    try { declared = this.resolveRoleResources?.(observation) ?? [{ kind: 'unknown', label: 'Host resource identity unavailable' }]; }
    catch { fail('ROLE_RESOURCE_RESOLUTION_FAILED', 'Host resource declaration failed before tool dispatch'); }
    return { workspaceId: context.workspace.id, workspaceRoot: context.workspace.root, sessionId: context.sessionId,
      roleId: catalogue.profile?.id ?? 'unprofiled', roleRevision: catalogue.profile?.revision ?? 'unknown',
      toolName: inner.name, effect: entry.effect, mode: catalogue.mode, preparedFingerprint: inner.fingerprint,
      requiresApproval: inner.requiresApproval || entry.exactApproval,
      baseDecision: catalogue.profile ? policy : { ...policy, decision: policy.decision === 'deny' ? 'deny' : 'ask', reason: 'Captured host role profile unavailable' }, resources: declared };
  }
  private preflightBinding(catalogue: ToolCatalogue, entry: Entry, inner: PreparedTool, context: ToolContext, policyVersion: number): CommandPreflightBinding {
    const input = inner.input;
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.command !== 'string' || typeof input.cwd !== 'string') fail('COMMAND_PREFLIGHT_COMMAND_REQUIRED', 'Host-selected command analyzer requires an exact producer-prepared command and canonical cwd');
    let sourceRevision: string | undefined;
    try { sourceRevision = this.commandPreflight?.resolveSourceRevision?.(this.observation(catalogue, entry, inner, context)); }
    catch { fail('COMMAND_PREFLIGHT_SOURCE_FAILED', 'Host source revision lookup failed before tool dispatch'); }
    if (sourceRevision === undefined) fail('COMMAND_PREFLIGHT_SOURCE_REQUIRED', 'Host-selected preflight requires an actual host source hash/generation');
    return { workspaceId: context.workspace.id, workspaceRoot: context.workspace.root, sessionId: context.sessionId, runId: context.runId,
      command: input.command, cwd: input.cwd, preparedFingerprint: inner.fingerprint, policyRevision: policyVersion, sourceRevision };
  }
  private selectPreflight(catalogue: ToolCatalogue, entry: Entry, inner: PreparedTool, context: ToolContext): string | undefined {
    try { return this.commandPreflight?.selectAnalyzer(this.observation(catalogue, entry, inner, context)); }
    catch { fail('COMMAND_PREFLIGHT_SELECTION_FAILED', 'Host analyzer selection failed before tool dispatch'); }
  }
  private assertPrepared(catalogue: ToolCatalogue, inner: PreparedTool, snapshot: string, context: ToolContext): void {
    active(context); this.entry(catalogue, inner.name); if (JSON.stringify(inner) !== snapshot) fail('TOOL_APPROVAL_STALE', 'Host policy checks altered the opaque producer-prepared request');
  }
  private async assertNarrowingCurrent(request: Request, context: ToolContext, policy: import('../../permission/policy.js').ToolPolicyResult): Promise<void> {
    if (request.roleCapture) this.roleResourcePolicyRegistry!.assertCurrent(request.roleCapture);
    if (request.roleReceipt) await (request.roleCapture?.policy ?? this.roleResources)!.assertCurrent(request.roleReceipt, this.roleInput(request.catalogue, request.entry, request.inner, context, policy), context.signal);
    if (this.commandPreflight) {
      if (this.selectPreflight(request.catalogue, request.entry, request.inner, context) !== request.preflightReceipt?.analyzerId) fail('COMMAND_PREFLIGHT_STALE', 'Host analyzer selection changed before dispatch');
      if (request.preflightReceipt) await this.commandPreflight.registry.assertCurrent(request.preflightReceipt, this.preflightBinding(request.catalogue, request.entry, request.inner, context, policy.version), context.signal);
    }
    this.assertPrepared(request.catalogue, request.inner, request.innerSnapshot, context);
  }
  private delegateCaptured(catalogue: ToolCatalogue, entry: Entry): ToolDefinition {
    return { name: entry.definition.name, description: entry.definition.description, inputSchema: structuredClone(entry.definition.inputSchema), effectClass: entry.effect,
      prepare: async (input, context) => {
        active(context); this.entry(catalogue, entry.definition.name);
        const inner = await entry.definition.prepare(input, context); active(context); this.entry(catalogue, entry.definition.name);
        if (inner.name !== entry.definition.name || typeof inner.fingerprint !== 'string' || !inner.fingerprint || Buffer.byteLength(inner.fingerprint) > 512 || typeof inner.requiresApproval !== 'boolean') fail('INVALID_PREPARED_TOOL', 'Tool returned an invalid prepared request');
        boundedJson(inner, 5 * 1024 * 1024);
        const innerSnapshot = JSON.stringify(inner);
        const targets = resources(inner);
        const policy = this.policy.evaluate({ toolName: inner.name, effect: entry.effect, mode: catalogue.mode, requiresApproval: inner.requiresApproval, resources: targets }); if (policy.decision === 'deny') fail('TOOL_POLICY_DENIED', 'Tool is denied by configured policy or execution mode');
        const grantScope: GrantScope = { workspaceId: context.workspace.id, sessionId: context.sessionId, toolName: inner.name, effect: entry.effect, ...(targets.length ? { resources: targets } : {}) };
        const roleCapture = this.captures.get(catalogue)!.roleCapture, rolePolicy = roleCapture?.policy ?? this.roleResources;
        const roleReceipt = rolePolicy ? await rolePolicy.evaluate(this.roleInput(catalogue, entry, inner, context, policy), context.signal) : undefined;
        this.assertPrepared(catalogue, inner, innerSnapshot, context);
        if (roleReceipt?.decision === 'deny') this.denyNarrowing('ROLE_RESOURCE_DENIED', 'Role resource policy denied the prepared tool', { roleResource: roleReceipt, ...(roleCapture ? { rolePolicy: roleGeneration(roleCapture) } : {}) });
        let preflightReceipt: CommandPreflightReceipt | undefined;
        if (this.commandPreflight) {
          const selected = this.selectPreflight(catalogue, entry, inner, context);
          if (selected !== undefined) {
            const request = await this.commandPreflight.registry.capture(this.preflightBinding(catalogue, entry, inner, context, policy.version), selected, context.signal);
            preflightReceipt = await this.commandPreflight.registry.run(request, { signal: context.signal, deadlineMs: this.commandPreflight.deadlineMs });
            this.assertPrepared(catalogue, inner, innerSnapshot, context);
            if (preflightReceipt.decision === 'deny') this.denyNarrowing('COMMAND_PREFLIGHT_DENIED', 'Trusted command preflight denied the prepared command', { ...(roleReceipt ? { roleResource: roleReceipt } : {}), commandPreflight: preflightReceipt, ...(roleCapture ? { rolePolicy: roleGeneration(roleCapture) } : {}) });
          }
        }
        this.assertPrepared(catalogue, inner, innerSnapshot, context);
        const narrowingAsk = roleReceipt?.decision === 'ask' || preflightReceipt !== undefined && this.commandPreflight!.registry.decision(preflightReceipt, policy.decision, inner.requiresApproval || entry.exactApproval) === 'ask';
        // Legacy grants have no role-registry generation binding; never adopt them into a dynamic policy generation.
        const grant = !roleCapture && !narrowingAsk && !entry.exactApproval && entry.revalidate && entry.effect !== 'unknown' && policy.reason !== 'configured approval requirement' ? this.grants.find(grantScope, policy.version) : undefined;
        const fingerprint = createHash('sha256').update(JSON.stringify({ scope: catalogue.scopeId, revision: catalogue.revision, policyVersion: policy.version, binding: binding(context), inner: inner.fingerprint, preview: inner.preview, grantId: grant?.id, grantRevision: grant?.revision,
          ...(catalogue.profile ? { profile: catalogue.profile } : {}), ...(roleCapture ? { rolePolicy: roleGeneration(roleCapture) } : {}), ...(roleReceipt ? { roleReceiptSha256: roleReceipt.receiptSha256 } : {}), ...(preflightReceipt ? { preflightReceiptSha256: preflightReceipt.receiptSha256 } : {}) })).digest('hex');
        const prepared: PreparedTool = { name: inner.name, input: structuredClone(inner.input), fingerprint, requiresApproval: entry.exactApproval || narrowingAsk || policy.decision === 'ask' && !grant,
          preview: { ...structuredClone(inner.preview), toolEffect: entry.effect, policyVersion: policy.version, registryRevision: catalogue.revision, ...(grant ? { scopedGrantId: grant.id } : {}),
            ...(catalogue.profile ? { roleProfile: { ...catalogue.profile } } : {}), ...(roleCapture ? { rolePolicy: roleGeneration(roleCapture) as unknown as JsonObject } : {}), ...(roleReceipt ? { roleResourceDecision: structuredClone(roleReceipt) as unknown as JsonObject } : {}), ...(preflightReceipt ? { commandPreflight: structuredClone(preflightReceipt) as unknown as JsonObject } : {}) } };
        this.requests.set(prepared, { entry, catalogue, inner, outerSnapshot: JSON.stringify(prepared), innerSnapshot, binding: binding(context), grantScope, ...(grant ? { grant } : {}), ...(roleReceipt ? { roleReceipt } : {}), ...(preflightReceipt ? { preflightReceipt } : {}), ...(roleCapture ? { roleCapture } : {}), used: false }); return prepared;
      }, execute: (prepared, context) => this.execute(prepared, context) };
  }
  /** Read-only retained-capability check. Invokes trusted policy observations, never producer handlers, grant consumption, approval, or replay. */
  async assertPreparedCurrent(prepared: PreparedTool, context: ToolContext): Promise<void> {
    const inspect = () => {
      active(context); const request = this.requests.get(prepared);
      if (!request || request.used) fail('INVALID_PREPARED_TOOL', 'Retained runtime request is unknown or already used');
      this.entry(request.catalogue, prepared.name);
      if (binding(context) !== request.binding || JSON.stringify(prepared) !== request.outerSnapshot || JSON.stringify(request.inner) !== request.innerSnapshot) fail('TOOL_APPROVAL_STALE', 'Retained request, preview or execution identity changed');
      const policy = this.policy.evaluate({ toolName: prepared.name, effect: request.entry.effect, mode: request.catalogue.mode, requiresApproval: request.inner.requiresApproval, resources: resources(request.inner) });
      if (policy.decision === 'deny') fail('TOOL_POLICY_DENIED', 'Retained tool is denied by current policy');
      if (request.grant) {
        const current = this.grants.find(request.grantScope, policy.version);
        if (!current || current.id !== request.grant.id || current.revision !== request.grant.revision) fail('TOOL_GRANT_STALE', 'Retained request grant is no longer current');
      }
      return { request, policy };
    };
    const current = inspect(); await this.assertNarrowingCurrent(current.request, context, current.policy);
    // Host observations may await physical paths/analyzers or change ownership and metadata.
    inspect();
  }
  async execute(prepared: PreparedTool, context: ToolContext): Promise<ToolResult> {
    active(context); const request = this.requests.get(prepared); if (!request || request.used) fail('INVALID_PREPARED_TOOL', 'Prepared runtime request is unknown or already used'); request.used = true;
    this.entry(request.catalogue, prepared.name);
    if (binding(context) !== request.binding || JSON.stringify(prepared) !== request.outerSnapshot || JSON.stringify(request.inner) !== request.innerSnapshot) fail('TOOL_APPROVAL_STALE', 'Prepared request, preview or execution identity changed');
    const policy = this.policy.evaluate({ toolName: prepared.name, effect: request.entry.effect, mode: request.catalogue.mode, requiresApproval: request.inner.requiresApproval, resources: resources(request.inner) }); if (policy.decision === 'deny') fail('TOOL_POLICY_DENIED', 'Tool is denied by policy');
    if (request.grant) {
      await request.entry.revalidate!(request.inner, context); active(context); this.entry(request.catalogue, prepared.name);
      if (JSON.stringify(request.inner) !== request.innerSnapshot) fail('TOOL_APPROVAL_STALE', 'Grant revalidation altered the prepared request');
    }
    await this.assertNarrowingCurrent(request, context, policy);
    this.assertPrepared(request.catalogue, request.inner, request.innerSnapshot, context);
    if (JSON.stringify(prepared) !== request.outerSnapshot || binding(context) !== request.binding) fail('TOOL_APPROVAL_STALE', 'Prepared request or execution identity changed during host policy checks');
    let commitObservation: (() => void) | undefined;
    if (this.options.beforeProducer) {
      commitObservation = await this.options.beforeProducer(prepared, context);
      const narrowingMetadata = () => canonicalJson({
        ...(request.roleReceipt ? { role: this.roleInput(request.catalogue, request.entry, request.inner, context, policy) } : {}),
        ...(this.commandPreflight ? { analyzer: this.selectPreflight(request.catalogue, request.entry, request.inner, context), ...(request.preflightReceipt ? { command: this.preflightBinding(request.catalogue, request.entry, request.inner, context, policy.version), registryRevision: this.commandPreflight.registry.revision } : {}) } : {}),
      });
      const currentNarrowing = narrowingMetadata();
      await this.assertNarrowingCurrent(request, context, policy);
      active(context); this.entry(request.catalogue, prepared.name);
      this.assertPrepared(request.catalogue, request.inner, request.innerSnapshot, context);
      if (JSON.stringify(prepared) !== request.outerSnapshot || binding(context) !== request.binding) fail('TOOL_APPROVAL_STALE', 'Observed request changed before producer dispatch');
      const current = this.policy.evaluate({ toolName: prepared.name, effect: request.entry.effect, mode: request.catalogue.mode, requiresApproval: request.inner.requiresApproval, resources: resources(request.inner) });
      if (current.decision === 'deny' || current.version !== policy.version) fail('TOOL_POLICY_DENIED', 'Policy changed before observed producer dispatch');
      if (narrowingMetadata() !== currentNarrowing) fail(request.preflightReceipt ? 'COMMAND_PREFLIGHT_STALE' : 'ROLE_RESOURCE_STALE', 'Host narrowing metadata changed before observed dispatch');
    }
    if (request.grant) this.grants.consume(request.grant.id, request.grantScope, this.policy.version, request.grant.revision);
    commitObservation?.();
    const restriction = this.policy.descendantRestriction({ toolName: prepared.name, effect: request.entry.effect, resources: resources(request.inner) });
    const result = await withPathRestriction(context, restriction, () => request.entry.definition.execute(request.inner, context));
    if (!result || typeof result.content !== 'string' || result.isError !== undefined && typeof result.isError !== 'boolean') fail('INVALID_TOOL_RESULT', 'Tool returned invalid content or outcome');
    const limits = { maxModelBytes: Math.min(context.limits.maxOutputBytes, 32 * 1024), maxDisplayBytes: Math.min(context.limits.maxOutputBytes, 64 * 1024) };
    const outcome = context.signal.aborted ? 'interrupted' : result.isError ? 'failed' : 'completed';
    let enriched: ToolResult;
    try { enriched = result.structuredResult ? { ...result, structuredResult: createToolResultEnvelope({ ...result.structuredResult, outcome }, limits) } : enrichLegacyToolResult(result, { outcome }, limits); }
    catch { enriched = { content: result.content, isError: true, ...(result.artifacts ? { artifacts: result.artifacts } : {}), structuredResult: createToolResultEnvelope({ displayContent: result.content, metadata: { resultProjectionFailed: true, producerOutcome: outcome, effectsMayBePresent: true }, warnings: ['Producer returned content, but its structured projection was invalid; recorded checkpoints and returned content remain reviewable.'], outcome: 'failed' }, limits) }; }
    if (this.artifactsUnavailable) return { ...enriched, structuredResult: createToolResultEnvelope({
      ...enriched.structuredResult!,
      metadata: { ...enriched.structuredResult!.metadata, artifactPersistenceUnavailable: true, artifactPersistenceCode: this.artifactsUnavailable.code },
      warnings: [...enriched.structuredResult!.warnings, this.artifactsUnavailable.reason],
    }, limits) };
    if (!this.options.artifacts) return enriched;
    // Only this producer's returned bytes can be observed; legacy truncation must remain explicit.
    try {
      const store = await (this.artifactPromise ??= Promise.resolve().then(() => typeof this.options.artifacts === 'function' ? this.options.artifacts() : this.options.artifacts!));
      const settlementOutcome = enriched.structuredResult!.outcome;
      let artifactContent=result.content, batchTruncated=false;
      if(context.effectBatchArtifactLimit!==undefined){const maximum=context.effectBatchArtifactLimit;if(!Number.isSafeInteger(maximum)||maximum<1||maximum>(context.budgets?.maxArtifactBytes??0))fail('EFFECT_BATCH_BUDGET_STALE','Original effect artifact allocation changed');if(Buffer.byteLength(artifactContent)>maximum){let bytes=Buffer.from(artifactContent).subarray(0,maximum);while(bytes.length&&Buffer.from(bytes.toString('utf8')).length>maximum)bytes=bytes.subarray(0,bytes.length-1);artifactContent=bytes.toString('utf8');batchTruncated=true;}}
      const artifact = await store.put({ identity: { sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId, ...(context.turnId ? { turnId: context.turnId } : {}), ...(context.attemptId ? { attemptId: context.attemptId } : {}) }, content: artifactContent, outcome: batchTruncated ? 'failed' : settlementOutcome, sourceComplete: !batchTruncated && !(result.artifacts?.some(item => item.truncated)), metadata: { toolName: prepared.name, ...(batchTruncated?{batchOriginalBytes:Buffer.byteLength(result.content),batchArtifactBytes:Buffer.byteLength(artifactContent)}:{}) } });
      return { ...enriched, ...(batchTruncated?{isError:true}:{}), structuredResult: createToolResultEnvelope({ ...enriched.structuredResult!, ...(batchTruncated?{outcome:'failed' as const}:{}), artifactRefs: [...(enriched.structuredResult?.artifactRefs ?? []), artifact.reference], warnings: [...(enriched.structuredResult?.warnings ?? []), ...artifact.warnings,...(batchTruncated?['Effect artifact bytes exceeded the original fixed member allocation. Full effects and checkpoints remain reviewable.']:[])], outcome: batchTruncated ? 'failed' : settlementOutcome }, limits) };
    } catch {
      this.artifactPromise = undefined;
      // The producer may already have effects/checkpoints. Preserve that result and expose a partial settlement.
      return { ...enriched, isError: true, structuredResult: createToolResultEnvelope({ displayContent: enriched.structuredResult!.displayContent, modelContent: enriched.structuredResult!.modelContent, structuredData: enriched.structuredResult!.structuredData, metadata: { artifactPersistenceFailed: true, producerOutcome: outcome, effectsMayBePresent: true }, warnings: [...enriched.structuredResult!.warnings, 'Producer returned a result, but its artifact settlement failed; recorded checkpoints and returned content remain reviewable.'], outcome: 'failed' }, limits) };
    }
  }
  /** Standalone headless execution uses the same fingerprint approval contract as the runner. */
  async executeApproved(prepared: PreparedTool, context: ToolContext, approvals: ApprovalPort): Promise<ToolResult> {
    if (!this.requests.has(prepared)) fail('INVALID_PREPARED_TOOL', 'Request was not prepared by this runtime');
    if (prepared.requiresApproval) {
      const approval = await approvals.request({ sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId, toolName: prepared.name, fingerprint: prepared.fingerprint, preview: prepared.preview }, context.signal);
      if (approval.status !== 'allowed' || approval.fingerprint !== prepared.fingerprint || approval.sessionId !== context.sessionId || approval.runId !== context.runId || approval.toolCallId !== context.toolCallId || approval.toolName !== prepared.name) fail('TOOL_APPROVAL_DENIED', 'Tool approval was denied or does not match this execution');
    }
    return this.execute(prepared, context);
  }
}
