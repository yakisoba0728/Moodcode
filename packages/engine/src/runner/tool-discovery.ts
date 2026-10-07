import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import type { PreparedTool, ToolContext, ToolDefinition, ToolResult } from '../ports.js';
import type { ScopedToolRuntime, ToolCatalogue } from '../tools/runtime/index.js';
import { TOOL_DISCOVERY_LIMITS, validateDiscoveryQuery, type ResolvedToolDiscoveryPolicy, type ToolDiscoveryCatalogue } from '../tools/runtime/discovery.js';

export const DISCOVERY_TOOL_NAME = 'discover_tools';
export type ToolDiscoveryAction = 'add' | 'replace';
interface Selection { action: ToolDiscoveryAction; names: readonly string[] }
function action(value: unknown): ToolDiscoveryAction {
  if (value !== 'add' && value !== 'replace') throw new EngineError('INVALID_TOOL_DISCOVERY_QUERY', 'Discovery action must be add or replace');
  return value;
}
function discoveryInput(value: unknown): { query: string; limit: number; action?: ToolDiscoveryAction } {
  const invalid = (): never => { throw new EngineError('INVALID_TOOL_DISCOVERY_QUERY', 'Discovery requires plain query, optional limit and optional action data'); };
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return invalid();
  const input: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !['query', 'limit', 'action'].includes(key)) return invalid();
    const field = Object.getOwnPropertyDescriptor(value, key)!;
    if (!field.enumerable || !('value' in field)) return invalid();
    input[key] = field.value;
  }
  const args = validateDiscoveryQuery(input.query, Object.hasOwn(input, 'limit') ? input.limit : 4);
  return { ...args, ...(Object.hasOwn(input, 'action') ? { action: action(input.action) } : {}) };
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function prefix(text: string, maximum: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maximum) return text;
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
export interface ToolDiscoveryDispatch {
  catalogue: ToolCatalogue;
  reservedBytes: number;
  toolCatalogueSha256: string;
}
/** Selections are Run-local observations. They grant no approval or current-batch handler. */
export class RunToolDiscovery {
  private source?: ToolDiscoveryCatalogue;
  private advertised?: ToolDiscoveryDispatch;
  private selected = new Set<string>();
  private pending = new Map<string, Selection>();
  private dirty = true;
  constructor(private readonly runtime: ScopedToolRuntime, private readonly policy: ResolvedToolDiscoveryPolicy,
    private readonly coreNames: readonly string[], private readonly mode: 'plan' | 'build', private readonly allowedNames?: readonly string[]) {}
  private reset(): void {
    this.source = undefined; this.advertised = undefined;
    this.selected.clear(); this.pending.clear(); this.dirty = true;
  }
  private current(): ToolDiscoveryCatalogue {
    if (!this.source) throw new EngineError('TOOL_DISCOVERY_STALE', 'A current Run discovery catalogue is required');
    this.runtime.assertDiscoveryCurrent(this.source);
    return this.source;
  }
  private always(source: ToolDiscoveryCatalogue): Set<string> {
    const requested = new Set([...(this.policy.alwaysVisibleToolNames ?? this.coreNames), DISCOVERY_TOOL_NAME]);
    return new Set(source.tools.filter(tool => requested.has(tool.name)).map(tool => tool.name));
  }
  private names(source: ToolDiscoveryCatalogue, selected: ReadonlySet<string>): string[] {
    const always = this.always(source);
    if (selected.size > this.policy.maxSelectedTools) throw new EngineError('TOOL_DISCOVERY_LIMIT', 'Run selected-tool count exceeds its discovery policy');
    const names = source.tools.filter(tool => always.has(tool.name) || selected.has(tool.name)).map(tool => tool.name);
    if (names.length > TOOL_DISCOVERY_LIMITS.maxVisibleTools) throw new EngineError('TOOL_DISCOVERY_LIMIT', 'Visible tool count exceeds its discovery limit');
    const selectedMetadata = source.tools.filter(tool => always.has(tool.name) || selected.has(tool.name));
    const bytes = 2 + selectedMetadata.reduce((total, tool) => total + tool.definitionBytes, 0) + Math.max(0, names.length - 1);
    if (bytes > this.policy.maxSchemaBytes) throw new EngineError('TOOL_DISCOVERY_LIMIT', 'Selected tool schemas exceed the Run discovery byte budget');
    return names;
  }
  capture(): ToolDiscoveryDispatch {
    if (this.source) {
      try { this.runtime.assertDiscoveryCurrent(this.source); }
      catch (error) {
        if (!(error instanceof EngineError) || error.code !== 'TOOL_DISCOVERY_STALE') throw error;
        this.reset();
      }
    }
    this.source ??= this.runtime.discoveryCatalogue('engine', this.mode, this.allowedNames);
    if (!this.advertised || this.dirty) {
      const names = this.names(this.source, this.selected);
      const catalogue = this.runtime.materializeDiscovery(this.source, names, { maxTools: TOOL_DISCOVERY_LIMITS.maxVisibleTools, maxBytes: this.policy.maxSchemaBytes });
      const tools = JSON.stringify(catalogue.tools);
      this.advertised = { catalogue, reservedBytes: Buffer.byteLength(JSON.stringify({ messages: [], tools: catalogue.tools })) - 2, toolCatalogueSha256: sha(tools) };
      this.dirty = false;
    }
    return this.advertised;
  }
  assertCurrent(): void { this.current(); }
  identity(): { registryRevision: number; policyVersion: number } {
    const source = this.current(); return { registryRevision: source.revision, policyVersion: source.policyVersion };
  }
  stage(toolCallId: string, query: string, limit: number, expected: { registryRevision: number; policyVersion: number }, selectionAction: ToolDiscoveryAction = 'add'): ToolResult {
    action(selectionAction);
    const source = this.current();
    if (source.revision !== expected.registryRevision || source.policyVersion !== expected.policyVersion) throw new EngineError('TOOL_DISCOVERY_STALE', 'Prepared discovery belongs to another catalogue');
    const matches = this.runtime.searchDiscovery(source, query, limit), always = this.always(source);
    const additions = matches.filter(tool => !always.has(tool.name)).map(tool => tool.name);
    const selection: Selection = { action: selectionAction, names: additions };
    const prospective = new Map(this.pending); prospective.set(toolCallId, selection);
    const added = new Set<string>(), bases: ReadonlySet<string>[] = [this.selected];
    for (const pending of prospective.values()) {
      if (pending.action === 'replace') bases.push(new Set(pending.names));
      else for (const name of pending.names) added.add(name);
    }
    // Uncommitted replacement cannot release capacity for another operation.
    // Check every replacement base with all outstanding adds, regardless of
    // commit/discard order. Regular coordinator state tools execute serially.
    for (const base of bases) this.names(source, new Set([...base, ...added]));
    const payload = {
      query, registryRevision: source.revision, policyVersion: source.policyVersion,
      activation: 'next-model-boundary',
      ...(selectionAction === 'replace' ? { selectionMode: 'replace' } : {}),
      matches: matches.map(tool => ({ name: tool.name, description: prefix(tool.description, 512),
        descriptionTruncated: Buffer.byteLength(tool.description) > 512, schemaSha256: tool.schemaSha256,
        definitionSha256: tool.definitionSha256, schemaBytes: tool.schemaBytes, definitionBytes: tool.definitionBytes,
        alreadyVisible: always.has(tool.name) || this.selected.has(tool.name) })),
    };
    const content = JSON.stringify(payload);
    if (Buffer.byteLength(content) > 32 * 1024) throw new EngineError('TOOL_DISCOVERY_LIMIT', 'Discovery result exceeds its model projection bound');
    this.runtime.assertDiscoveryCurrent(source);
    this.pending.set(toolCallId, selection);
    return { content };
  }
  /** Only call after both the ordinary tool result and native Part were committed. */
  commit(toolCallId: string): void {
    const selection = this.pending.get(toolCallId);
    if (!selection) return;
    this.pending.delete(toolCallId);
    let source: ToolDiscoveryCatalogue;
    try { source = this.current(); }
    catch (error) {
      if (!(error instanceof EngineError) || error.code !== 'TOOL_DISCOVERY_STALE') throw error;
      this.reset(); return;
    }
    const selected = selection.action === 'replace' ? new Set<string>() : new Set(this.selected);
    for (const name of selection.names) selected.add(name);
    this.names(source, selected);
    this.selected = selected; this.dirty = true;
  }
  discard(toolCallId: string): void { this.pending.delete(toolCallId); }
}

interface DiscoveryHost {
  identity(context: ToolContext): { registryRevision: number; policyVersion: number };
  stage(context: ToolContext, query: string, limit: number, expected: { registryRevision: number; policyVersion: number }, action?: ToolDiscoveryAction): ToolResult;
}
/** Regular internal-state tool; the scoped runtime remains prepare/approval/execute owner. */
export function createToolDiscoveryTool(host: DiscoveryHost): ToolDefinition {
  const prepared = new WeakMap<PreparedTool, { query: string; limit: number; action?: ToolDiscoveryAction; expected: { registryRevision: number; policyVersion: number } }>();
  return {
    name: DISCOVERY_TOOL_NAME, effectClass: 'state',
    description: 'Find permitted registered tools by name or description. Matches become callable next model turn after this result is saved. Default action add retains previous selections. Action replace exchanges selected tools for these matches; no matches clears selections. Core tools stay visible. Catalogue changes require a new search.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 8 }, action: { type: 'string', enum: ['add', 'replace'] } }, required: ['query'], additionalProperties: false },
    async prepare(value, context) {
      const args = discoveryInput(value), expected = host.identity(context);
      const preview: JsonObject = { ...args, ...expected };
      const result: PreparedTool = { name: DISCOVERY_TOOL_NAME, input: { ...args }, fingerprint: sha(JSON.stringify({ preview, sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId })), requiresApproval: false, preview };
      prepared.set(result, { ...args, expected }); return result;
    },
    async execute(value, context) {
      const request = prepared.get(value);
      if (!request) throw new EngineError('INVALID_PREPARED_TOOL', 'Discovery requires its original prepared handle');
      prepared.delete(value);
      return host.stage(context, request.query, request.limit, request.expected, request.action);
    },
  };
}
