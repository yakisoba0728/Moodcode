import { EngineError } from '@moodcode/contracts';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { types } from 'node:util';
import type { PolicyDecision, ToolEffectClass, ToolPolicyResult } from './policy.js';

export const ROLE_RESOURCE_LIMITS = Object.freeze({ maxRules: 128, maxResources: 32, maxPolicyBytes: 64 * 1024, maxReceiptBytes: 64 * 1024, maxPathBytes: 4096, maxPathSegments: 128 });
export type RoleResourceSelector =
  | { kind: 'all' }
  | { kind: 'file'; path: string; descendants?: boolean }
  | { kind: 'mcp'; serverId: string; connectionId: string; catalogueRevision: number; uri: string };
export interface RoleResourceRule {
  id: string; roleId: string; toolName?: string; effect?: ToolEffectClass;
  resource: RoleResourceSelector; decision: PolicyDecision;
}
export interface RoleResourcePolicySnapshot { revision: number; rules: readonly RoleResourceRule[] }
/** MCP identities must be supplied by the host's connected catalogue, never inferred from tool descriptions or model arguments. */
export type RoleResource =
  | { kind: 'file'; path: string }
  | { kind: 'mcp'; serverId: string; connectionId: string; catalogueRevision: number; uri: string }
  | { kind: 'unknown'; label: string };
export interface RoleResourceInput {
  workspaceId: string; workspaceRoot: string; sessionId: string; roleId: string; roleRevision: string;
  toolName: string; effect: ToolEffectClass; mode: 'plan' | 'build'; preparedFingerprint: string;
  requiresApproval: boolean; baseDecision: ToolPolicyResult; resources: readonly RoleResource[];
}
export type RoleResourceReason = 'base_denied' | 'role_denied' | 'plan_effect_denied' | 'base_approval_required' | 'prepared_approval_required' | 'unknown_effect' | 'role_approval_required' | 'unknown_resource' | 'no_role_allowance' | 'role_allowed';
export interface ResolvedRoleFileResource { kind: 'file'; path: string; canonicalPath: string; pathRevision: string }
export type ResolvedRoleResource = ResolvedRoleFileResource | Exclude<RoleResource, { kind: 'file' }>;
export interface RoleResourceReceipt {
  schemaVersion: 1; decision: PolicyDecision; reason: RoleResourceReason; policyRevision: number; policySha256: string;
  basePolicyVersion: number; workspaceId: string; workspaceRootRevision: string; sessionId: string;
  roleId: string; roleRevision: string; toolName: string; preparedFingerprint: string;
  resources: readonly ResolvedRoleResource[];
  matchedRules: readonly { id: string; resourceIndex: number; decision: PolicyDecision }[];
  inputSha256: string; receiptSha256: string;
}
const EFFECTS = new Set<ToolEffectClass>(['read', 'state', 'write', 'execute', 'network', 'unknown']);
const DECISIONS = new Set<PolicyDecision>(['allow', 'ask', 'deny']);
function fail(code: string, message: string): never { throw new EngineError(code, message); }
function record(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_ROLE_RESOURCE', 'Role resources require typed plain records');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !fields.includes(key)) || Object.values(descriptors).some(field => !Object.hasOwn(field, 'value') || !field.enumerable)) fail('INVALID_ROLE_RESOURCE', 'Role resource records cannot contain accessors, hidden fields or symbols');
}
function list(value: unknown, max: number): asserts value is unknown[] {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail('INVALID_ROLE_RESOURCE', 'Role resources require plain arrays');
  if (value.length > max) fail('ROLE_RESOURCE_LIMIT', 'Role resource array exceeds its count limit');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1 || Object.entries(fields).some(([key, field]) => key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length || !Object.hasOwn(field, 'value') || !field.enumerable))) fail('INVALID_ROLE_RESOURCE', 'Role resource arrays cannot be sparse, contain accessors or custom fields');
}
function text(value: unknown, max = 512): asserts value is string { if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_ROLE_RESOURCE', 'Role resource identity must be bounded text'); }
function revision(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 1) fail('INVALID_ROLE_RESOURCE', 'Role resource revision must be a positive safe integer'); }
function filePath(value: unknown): asserts value is string {
  text(value, ROLE_RESOURCE_LIMITS.maxPathBytes);
  if (isAbsolute(value) || value.includes(':') || value.includes('\\') || value.split('/').length > ROLE_RESOURCE_LIMITS.maxPathSegments || value !== '.' && value.split('/').some(part => !part || part === '.' || part === '..')) fail('INVALID_ROLE_RESOURCE_PATH', 'File resources require bounded canonical workspace-relative paths');
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function mcp(value: Record<string, unknown>): void { text(value.serverId); text(value.connectionId); revision(value.catalogueRevision); text(value.uri, 4096); }
function validateResource(value: unknown, selector = false): void {
  record(value, ['kind', 'path', 'descendants', 'serverId', 'connectionId', 'catalogueRevision', 'uri', 'label']);
  const kind = value.kind;
  if (kind === 'file') { record(value, selector ? ['kind', 'path', 'descendants'] : ['kind', 'path']); filePath(value.path); if (value.descendants !== undefined && typeof value.descendants !== 'boolean') fail('INVALID_ROLE_RESOURCE', 'File descendant selector must be boolean'); }
  else if (kind === 'mcp') { record(value, ['kind', 'serverId', 'connectionId', 'catalogueRevision', 'uri']); mcp(value); }
  else if (kind === 'all' && selector) record(value, ['kind']);
  else if (kind === 'unknown' && !selector) { record(value, ['kind', 'label']); text(value.label); }
  else fail('INVALID_ROLE_RESOURCE', 'Unsupported role resource kind');
}
function validateInput(input: RoleResourceInput): RoleResourceInput {
  record(input, ['workspaceId', 'workspaceRoot', 'sessionId', 'roleId', 'roleRevision', 'toolName', 'effect', 'mode', 'preparedFingerprint', 'requiresApproval', 'baseDecision', 'resources']);
  for (const name of ['workspaceId', 'sessionId', 'roleId', 'roleRevision', 'toolName', 'preparedFingerprint'] as const) text(input[name]);
  text(input.workspaceRoot, ROLE_RESOURCE_LIMITS.maxPathBytes);
  if (!isAbsolute(input.workspaceRoot) || resolve(input.workspaceRoot) !== input.workspaceRoot) fail('INVALID_ROLE_RESOURCE_PATH', 'Workspace root must be an absolute canonical path');
  if (!EFFECTS.has(input.effect) || !['plan', 'build'].includes(input.mode) || typeof input.requiresApproval !== 'boolean') fail('INVALID_ROLE_RESOURCE', 'Invalid role tool effect, mode or approval requirement');
  record(input.baseDecision, ['decision', 'version', 'reason']); revision(input.baseDecision.version); text(input.baseDecision.reason, 1024);
  if (!DECISIONS.has(input.baseDecision.decision)) fail('INVALID_ROLE_RESOURCE', 'Invalid base policy decision');
  list(input.resources, ROLE_RESOURCE_LIMITS.maxResources);
  for (const resource of input.resources) validateResource(resource);
  if (Buffer.byteLength(JSON.stringify(input)) > ROLE_RESOURCE_LIMITS.maxReceiptBytes) fail('ROLE_RESOURCE_LIMIT', 'Role input exceeds its byte limit');
  return freeze(structuredClone(input));
}
function inside(root: string, target: string): boolean { const rel = relative(root, target); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); }
async function rootRevision(root: string): Promise<string> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) fail('ROLE_WORKSPACE_CHANGED', 'Workspace root must remain a canonical directory');
  return hash([root, String(info.dev), String(info.ino)]);
}
async function resolveFile(root: string, path: string): Promise<ResolvedRoleFileResource> {
  let cursor = resolve(root, path); const missing: string[] = []; let physical: string;
  for (;;) {
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(cursor); if (parent === cursor || !inside(root, parent)) throw error;
      missing.push(relative(parent, cursor)); cursor = parent;
      continue;
    }
    // A dangling symlink is not a missing file: fail rather than silently changing its authority identity.
    physical = await realpath(cursor);
    if (!inside(root, physical)) fail('ROLE_PATH_OUTSIDE_WORKSPACE', 'File resource resolves outside the workspace');
    if (missing.length && !info.isDirectory() && !(info.isSymbolicLink() && (await lstat(physical)).isDirectory())) fail('INVALID_ROLE_RESOURCE_PATH', 'File resource parent must be a directory');
    const resolved = resolve(physical, ...missing.reverse());
    if (!inside(root, resolved)) fail('ROLE_PATH_OUTSIDE_WORKSPACE', 'File resource resolves outside the workspace');
    const canonicalPath = relative(root, resolved).split(sep).join('/') || '.';
    // Pin the nearest existing parent/target, not its contents: producer revalidation still owns file hashes.
    const target = await lstat(physical);
    return { kind: 'file', path, canonicalPath, pathRevision: hash([cursor, physical, resolved, String(target.dev), String(target.ino), missing]) };
  }
}
function pathMatches(rule: Extract<RoleResourceSelector, { kind: 'file' }>, path: string): boolean { return path === rule.path || rule.descendants === true && (rule.path === '.' || path.startsWith(`${rule.path}/`)); }
function resourceMatches(selector: RoleResourceSelector, resource: ResolvedRoleResource, decision: PolicyDecision): boolean {
  if (resource.kind === 'unknown') return false;
  if (selector.kind === 'all') return true;
  if (selector.kind === 'file' && resource.kind === 'file') return pathMatches(selector, resource.canonicalPath) || decision !== 'allow' && pathMatches(selector, resource.path);
  return selector.kind === 'mcp' && resource.kind === 'mcp' && selector.serverId === resource.serverId && selector.connectionId === resource.connectionId && selector.catalogueRevision === resource.catalogueRevision && selector.uri === resource.uri;
}

/** Optional host policy narrowing. Receipts are descriptive capabilities owned by this instance, never substitute for exact tool approval. */
export class RoleResourcePolicy {
  readonly revision: number; readonly sha256: string; readonly rules: readonly RoleResourceRule[];
  private readonly receipts = new WeakMap<RoleResourceReceipt, RoleResourceInput>();
  constructor(snapshot: RoleResourcePolicySnapshot) {
    record(snapshot, ['revision', 'rules']); revision(snapshot.revision);
    list(snapshot.rules, ROLE_RESOURCE_LIMITS.maxRules);
    const ids = new Set<string>();
    for (const rule of snapshot.rules) {
      record(rule, ['id', 'roleId', 'toolName', 'effect', 'resource', 'decision']); text(rule.id, 128); text(rule.roleId);
      if (ids.has(rule.id)) fail('INVALID_ROLE_RESOURCE', 'Role rule IDs must be unique'); ids.add(rule.id);
      if (rule.toolName !== undefined) text(rule.toolName, 128);
      if (rule.effect !== undefined && !EFFECTS.has(rule.effect as ToolEffectClass) || !DECISIONS.has(rule.decision as PolicyDecision)) fail('INVALID_ROLE_RESOURCE', 'Invalid role policy effect or decision');
      validateResource(rule.resource, true);
    }
    if (Buffer.byteLength(JSON.stringify(snapshot)) > ROLE_RESOURCE_LIMITS.maxPolicyBytes) fail('ROLE_RESOURCE_LIMIT', 'Role policy exceeds its byte limit');
    this.revision = snapshot.revision; this.rules = freeze(structuredClone(snapshot.rules)); this.sha256 = hash({ revision: this.revision, rules: this.rules });
    Object.freeze(this);
  }
  async evaluate(value: RoleResourceInput, signal?: AbortSignal): Promise<RoleResourceReceipt> {
    const input = validateInput(value); this.active(signal);
    const before = await rootRevision(input.workspaceRoot); const resources: ResolvedRoleResource[] = [];
    for (const resource of input.resources) { this.active(signal); resources.push(resource.kind === 'file' ? await resolveFile(input.workspaceRoot, resource.path) : structuredClone(resource)); }
    this.active(signal); if (await rootRevision(input.workspaceRoot) !== before) fail('ROLE_WORKSPACE_CHANGED', 'Workspace root changed during role evaluation');
    const rules = this.rules.filter(rule => rule.roleId === input.roleId && (rule.toolName === undefined || rule.toolName === '*' || rule.toolName === input.toolName) && (rule.effect === undefined || rule.effect === input.effect));
    const matches: { id: string; resourceIndex: number; decision: PolicyDecision }[] = [];
    for (const [index, resource] of resources.entries()) for (const rule of rules) if (resourceMatches(rule.resource, resource, rule.decision)) matches.push({ id: rule.id, resourceIndex: index, decision: rule.decision });
    if (!resources.length) for (const rule of rules) if (rule.resource.kind === 'all') matches.push({ id: rule.id, resourceIndex: -1, decision: rule.decision });
    let decision: PolicyDecision = 'ask'; let reason: RoleResourceReason = 'no_role_allowance';
    if (input.baseDecision.decision === 'deny') { decision = 'deny'; reason = 'base_denied'; }
    else if (matches.some(match => match.decision === 'deny')) { decision = 'deny'; reason = 'role_denied'; }
    else if (input.mode === 'plan' && !['read', 'state'].includes(input.effect)) { decision = 'deny'; reason = 'plan_effect_denied'; }
    else if (input.baseDecision.decision === 'ask') reason = 'base_approval_required';
    else if (input.requiresApproval) reason = 'prepared_approval_required';
    else if (input.effect === 'unknown') reason = 'unknown_effect';
    else if (matches.some(match => match.decision === 'ask')) reason = 'role_approval_required';
    else if (resources.some(resource => resource.kind === 'unknown')) reason = 'unknown_resource';
    else if ((resources.length ? resources.every((_, index) => matches.some(match => match.resourceIndex === index && match.decision === 'allow')) : matches.some(match => match.decision === 'allow'))) { decision = 'allow'; reason = 'role_allowed'; }
    const data = { schemaVersion: 1 as const, decision, reason, policyRevision: this.revision, policySha256: this.sha256,
      basePolicyVersion: input.baseDecision.version, workspaceId: input.workspaceId, workspaceRootRevision: before, sessionId: input.sessionId,
      roleId: input.roleId, roleRevision: input.roleRevision, toolName: input.toolName, preparedFingerprint: input.preparedFingerprint,
      resources, matchedRules: matches, inputSha256: hash(input) };
    const receipt = freeze({ ...data, receiptSha256: hash(data) });
    if (Buffer.byteLength(JSON.stringify(receipt)) > ROLE_RESOURCE_LIMITS.maxReceiptBytes) fail('ROLE_RESOURCE_LIMIT', 'Role decision provenance exceeds its byte limit');
    this.receipts.set(receipt, input); return receipt;
  }
  /** Call immediately before existing producer revalidation/dispatch; this checks scope, physical paths and policy binding, not OS isolation. */
  async assertCurrent(receipt: RoleResourceReceipt, current: RoleResourceInput, signal?: AbortSignal): Promise<void> {
    const captured = this.receipts.get(receipt);
    if (!captured || hash(validateInput(current)) !== receipt.inputSha256) fail('ROLE_RESOURCE_STALE', 'Role receipt does not belong to this policy and exact current prepared request');
    const fresh = await this.evaluate(current, signal);
    if (fresh.receiptSha256 !== receipt.receiptSha256) fail('ROLE_RESOURCE_STALE', 'Workspace, resource identity or role decision changed after preparation');
  }
  private active(signal?: AbortSignal): void { if (signal?.aborted) fail('CANCELLED', 'Role resource evaluation cancelled'); }
}
