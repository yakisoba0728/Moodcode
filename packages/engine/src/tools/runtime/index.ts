import { createHash } from 'node:crypto';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import type { ApprovalPort, PreparedTool, ProviderTool, ToolContext, ToolDefinition, ToolResult } from '../../ports.js';
import { ArtifactStore } from '../../artifacts/store.js';
import { createToolResultEnvelope, enrichLegacyToolResult } from '../../artifacts/result.js';
import { boundedJson } from '../../artifacts/validation.js';
import { inferToolEffect, ToolPolicy, type ToolEffectClass } from '../../permission/policy.js';
import { ScopedToolGrants, type GrantScope, type ScopedToolGrant } from '../../permission/grants.js';
import { TOOL_DISCOVERY_LIMITS, discoveryCatalogueSignature, validateDiscoveryMaterializeLimits, validateDiscoveryNames, validateDiscoveryQuery,
  type ToolDiscoveryCatalogue, type ToolDiscoveryMaterializeLimits, type ToolDiscoveryMetadata } from './discovery.js';
export interface RuntimeToolRegistration { effect?: ToolEffectClass; exactApproval?: boolean; revalidate?: (prepared: PreparedTool, context: ToolContext) => Promise<void> }
export interface ToolCatalogue { scopeId: string; revision: number; policyVersion: number; mode: 'plan' | 'build'; tools: readonly ProviderTool[] }
export interface ScopedToolRuntimeOptions { policy?: ToolPolicy; grants?: ScopedToolGrants; artifacts?: ArtifactStore | Promise<ArtifactStore> | (() => ArtifactStore | Promise<ArtifactStore>) }
interface Entry { scopeId: string; token: symbol; definition: ToolDefinition; descriptor: Readonly<ProviderTool>; metadata: Readonly<ToolDiscoveryMetadata>; effect: ToolEffectClass; exactApproval: boolean; revalidate?: RuntimeToolRegistration['revalidate'] }
interface Captured { entries: Map<string, Entry>; signature: string }
interface Request { entry: Entry; catalogue: ToolCatalogue; inner: PreparedTool; outerSnapshot: string; innerSnapshot: string; binding: string; grant?: ScopedToolGrant; grantScope: GrantScope; used: boolean }
function fail(code: string, message: string): never { throw new EngineError(code, message); }
function active(context: ToolContext): void { if (context.signal.aborted) fail('CANCELLED', 'Tool runtime operation cancelled'); }
function binding(context: ToolContext): string { return JSON.stringify([context.workspace.id, context.workspace.root, context.sessionId, context.runId, context.toolCallId, context.turnId, context.attemptId, context.executionLockPath]); }
function name(value: string): void { if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)) fail('INVALID_TOOL_REGISTRATION', 'Tool and scope names must be bounded identifiers'); }
function freezeJson(value: unknown): void { if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeJson(child); Object.freeze(value); } }
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
  private discoveryCaptures = new WeakMap<ToolDiscoveryCatalogue, Captured>();
  constructor(private readonly options: ScopedToolRuntimeOptions = {}) { this.policy = options.policy ?? new ToolPolicy(); this.grants = options.grants ?? new ScopedToolGrants(); }
  get revision(): number { return this.current; }
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
    return createHash('sha256').update(JSON.stringify({ scope: request.catalogue.scopeId, revision: request.catalogue.revision, policyVersion: request.catalogue.policyVersion, name: request.inner.name, fingerprint: request.inner.fingerprint })).digest('hex');
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
    const entry: Entry = { scopeId, token: Symbol(source.name), definition, descriptor, metadata, effect, exactApproval: options.exactApproval === true, ...(options.revalidate ? { revalidate: options.revalidate } : {}) }; entries.set(source.name, entry); this.scopes.set(scopeId, entries); this.current++;
    return () => { const existing = this.scopes.get(scopeId); if (existing?.get(definition.name)?.token !== entry.token) return; existing.delete(definition.name); if (!existing.size) this.scopes.delete(scopeId); this.current++; };
  }
  clearScope(scopeId: string): void { if (this.scopes.delete(scopeId)) this.current++; }
  catalogue(scopeId: string, mode: 'plan' | 'build' = 'build', allowedNames?: readonly string[]): ToolCatalogue {
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
    const catalogue: ToolCatalogue = { scopeId, revision: this.current, policyVersion: this.policy.version, mode, tools };
    this.captures.set(catalogue, { entries, signature: JSON.stringify(catalogue) }); return catalogue;
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
    this.discoveryCaptures.set(catalogue, { entries, signature: discoveryCatalogueSignature(catalogue) }); return catalogue;
  }
  assertDiscoveryCurrent(catalogue: ToolDiscoveryCatalogue): void {
    const captured = this.discoveryCaptures.get(catalogue);
    if (!captured || captured.signature !== discoveryCatalogueSignature(catalogue) || catalogue.revision !== this.current || catalogue.policyVersion !== this.policy.version) fail('TOOL_DISCOVERY_STALE', 'Tool discovery registry, policy or captured metadata changed');
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
    const result: ToolCatalogue = { scopeId: catalogue.scopeId, revision: catalogue.revision, policyVersion: catalogue.policyVersion, mode: catalogue.mode, tools };
    this.captures.set(result, { entries, signature: JSON.stringify(result) }); return result;
  }
  resolve(catalogue: ToolCatalogue, toolName: string): ToolDefinition {
    const entry = this.entry(catalogue, toolName); return this.delegateCaptured(catalogue, entry);
  }
  /** Validates an exact captured catalogue even when it contains no tools. */
  assertCatalogueCurrent(catalogue: ToolCatalogue): void {
    const captured = this.captures.get(catalogue);
    if (!captured || captured.signature !== JSON.stringify(catalogue) || catalogue.revision !== this.current || catalogue.policyVersion !== this.policy.version) fail('TOOL_CATALOGUE_STALE', 'Tool registry, policy or captured catalogue changed; request a fresh catalogue');
  }
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
  private delegateCaptured(catalogue: ToolCatalogue, entry: Entry): ToolDefinition {
    return { name: entry.definition.name, description: entry.definition.description, inputSchema: structuredClone(entry.definition.inputSchema), effectClass: entry.effect,
      prepare: async (input, context) => {
        active(context); this.entry(catalogue, entry.definition.name);
        const inner = await entry.definition.prepare(input, context); active(context); this.entry(catalogue, entry.definition.name);
        if (inner.name !== entry.definition.name || typeof inner.fingerprint !== 'string' || !inner.fingerprint || Buffer.byteLength(inner.fingerprint) > 512 || typeof inner.requiresApproval !== 'boolean') fail('INVALID_PREPARED_TOOL', 'Tool returned an invalid prepared request');
        boundedJson(inner, 5 * 1024 * 1024);
        const targets = resources(inner);
        const policy = this.policy.evaluate({ toolName: inner.name, effect: entry.effect, mode: catalogue.mode, requiresApproval: inner.requiresApproval, resources: targets }); if (policy.decision === 'deny') fail('TOOL_POLICY_DENIED', 'Tool is denied by configured policy or execution mode');
        const grantScope: GrantScope = { workspaceId: context.workspace.id, sessionId: context.sessionId, toolName: inner.name, effect: entry.effect, ...(targets.length ? { resources: targets } : {}) };
        const grant = !entry.exactApproval && entry.revalidate && entry.effect !== 'unknown' && policy.reason !== 'configured approval requirement' ? this.grants.find(grantScope, policy.version) : undefined;
        const fingerprint = createHash('sha256').update(JSON.stringify({ scope: catalogue.scopeId, revision: catalogue.revision, policyVersion: policy.version, binding: binding(context), inner: inner.fingerprint, preview: inner.preview, grantId: grant?.id, grantRevision: grant?.revision })).digest('hex');
        const prepared: PreparedTool = { name: inner.name, input: structuredClone(inner.input), fingerprint, requiresApproval: entry.exactApproval || policy.decision === 'ask' && !grant,
          preview: { ...structuredClone(inner.preview), toolEffect: entry.effect, policyVersion: policy.version, registryRevision: catalogue.revision, ...(grant ? { scopedGrantId: grant.id } : {}) } };
        this.requests.set(prepared, { entry, catalogue, inner, outerSnapshot: JSON.stringify(prepared), innerSnapshot: JSON.stringify(inner), binding: binding(context), grantScope, ...(grant ? { grant } : {}), used: false }); return prepared;
      }, execute: (prepared, context) => this.execute(prepared, context) };
  }
  async execute(prepared: PreparedTool, context: ToolContext): Promise<ToolResult> {
    active(context); const request = this.requests.get(prepared); if (!request || request.used) fail('INVALID_PREPARED_TOOL', 'Prepared runtime request is unknown or already used'); request.used = true;
    this.entry(request.catalogue, prepared.name);
    if (binding(context) !== request.binding || JSON.stringify(prepared) !== request.outerSnapshot || JSON.stringify(request.inner) !== request.innerSnapshot) fail('TOOL_APPROVAL_STALE', 'Prepared request, preview or execution identity changed');
    const policy = this.policy.evaluate({ toolName: prepared.name, effect: request.entry.effect, mode: request.catalogue.mode, requiresApproval: request.inner.requiresApproval, resources: resources(request.inner) }); if (policy.decision === 'deny') fail('TOOL_POLICY_DENIED', 'Tool is denied by policy');
    if (request.grant) {
      await request.entry.revalidate!(request.inner, context); active(context); this.entry(request.catalogue, prepared.name);
      if (JSON.stringify(request.inner) !== request.innerSnapshot) fail('TOOL_APPROVAL_STALE', 'Grant revalidation altered the prepared request');
      this.grants.consume(request.grant.id, request.grantScope, this.policy.version, request.grant.revision);
    }
    const result = await request.entry.definition.execute(request.inner, context);
    if (!result || typeof result.content !== 'string' || result.isError !== undefined && typeof result.isError !== 'boolean') fail('INVALID_TOOL_RESULT', 'Tool returned invalid content or outcome');
    const limits = { maxModelBytes: Math.min(context.limits.maxOutputBytes, 32 * 1024), maxDisplayBytes: Math.min(context.limits.maxOutputBytes, 64 * 1024) };
    const outcome = context.signal.aborted ? 'interrupted' : result.isError ? 'failed' : 'completed';
    let enriched: ToolResult;
    try { enriched = result.structuredResult ? { ...result, structuredResult: createToolResultEnvelope({ ...result.structuredResult, outcome }, limits) } : enrichLegacyToolResult(result, { outcome }, limits); }
    catch { enriched = { content: result.content, isError: true, ...(result.artifacts ? { artifacts: result.artifacts } : {}), structuredResult: createToolResultEnvelope({ displayContent: result.content, metadata: { resultProjectionFailed: true, producerOutcome: outcome, effectsMayBePresent: true }, warnings: ['Producer returned content, but its structured projection was invalid; recorded checkpoints and returned content remain reviewable.'], outcome: 'failed' }, limits) }; }
    if (!this.options.artifacts) return enriched;
    // Only this producer's returned bytes can be observed; legacy truncation must remain explicit.
    try {
      const store = await (this.artifactPromise ??= Promise.resolve().then(() => typeof this.options.artifacts === 'function' ? this.options.artifacts() : this.options.artifacts!));
      const settlementOutcome = enriched.structuredResult!.outcome;
      const artifact = await store.put({ identity: { sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId, ...(context.turnId ? { turnId: context.turnId } : {}), ...(context.attemptId ? { attemptId: context.attemptId } : {}) }, content: result.content, outcome: settlementOutcome, sourceComplete: !(result.artifacts?.some(item => item.truncated)), metadata: { toolName: prepared.name } });
      return { ...enriched, structuredResult: createToolResultEnvelope({ ...enriched.structuredResult!, artifactRefs: [...(enriched.structuredResult?.artifactRefs ?? []), artifact.reference], warnings: [...(enriched.structuredResult?.warnings ?? []), ...artifact.warnings], outcome: settlementOutcome }, limits) };
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
export { ToolPolicy, ScopedToolGrants, inferToolEffect };
export type { ToolEffectClass, ToolPolicyRule, ToolPolicyResult } from '../../permission/policy.js';
export type { GrantScope, ScopedToolGrant } from '../../permission/grants.js';
export { DEFAULT_TOOL_DISCOVERY_POLICY, TOOL_DISCOVERY_LIMITS, validateToolDiscoveryPolicy } from './discovery.js';
export type { ToolDiscoveryPolicy, ResolvedToolDiscoveryPolicy, ToolDiscoveryCatalogue, ToolDiscoveryMetadata, ToolDiscoveryMaterializeLimits } from './discovery.js';
