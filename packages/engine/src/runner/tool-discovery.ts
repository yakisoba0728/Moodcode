import { createHash } from 'node:crypto';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import { boundedJson } from '../artifacts/validation.js';
import type { PreparedTool, ToolContext, ToolDefinition, ToolResult } from '../ports.js';
import type { ScopedToolRuntime, ToolCatalogue } from '../tools/runtime/index.js';
import { TOOL_DISCOVERY_LIMITS, validateDiscoveryQuery, type ResolvedToolDiscoveryPolicy, type ToolDiscoveryCatalogue } from '../tools/runtime/discovery.js';

export const DISCOVERY_TOOL_NAME = 'discover_tools';
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
  private pending = new Map<string, readonly string[]>();
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
  stage(toolCallId: string, query: string, limit: number, expected: { registryRevision: number; policyVersion: number }): ToolResult {
    const source = this.current();
    if (source.revision !== expected.registryRevision || source.policyVersion !== expected.policyVersion) throw new EngineError('TOOL_DISCOVERY_STALE', 'Prepared discovery belongs to another catalogue');
    const matches = this.runtime.searchDiscovery(source, query, limit), always = this.always(source);
    const additions = matches.filter(tool => !always.has(tool.name)).map(tool => tool.name);
    const reserved = new Set(this.selected);
    for (const names of this.pending.values()) for (const name of names) reserved.add(name);
    for (const name of additions) reserved.add(name);
    this.names(source, reserved);
    const payload = {
      query, registryRevision: source.revision, policyVersion: source.policyVersion,
      activation: 'next-model-boundary',
      matches: matches.map(tool => ({ name: tool.name, description: prefix(tool.description, 512),
        descriptionTruncated: Buffer.byteLength(tool.description) > 512, schemaSha256: tool.schemaSha256,
        definitionSha256: tool.definitionSha256, schemaBytes: tool.schemaBytes, definitionBytes: tool.definitionBytes,
        alreadyVisible: always.has(tool.name) || this.selected.has(tool.name) })),
    };
    const content = JSON.stringify(payload);
    if (Buffer.byteLength(content) > 32 * 1024) throw new EngineError('TOOL_DISCOVERY_LIMIT', 'Discovery result exceeds its model projection bound');
    this.runtime.assertDiscoveryCurrent(source);
    this.pending.set(toolCallId, additions);
    return { content };
  }
  /** Only call after both the ordinary tool result and native Part were committed. */
  commit(toolCallId: string): void {
    const names = this.pending.get(toolCallId);
    if (!names) return;
    this.pending.delete(toolCallId);
    let source: ToolDiscoveryCatalogue;
    try { source = this.current(); }
    catch (error) {
      if (!(error instanceof EngineError) || error.code !== 'TOOL_DISCOVERY_STALE') throw error;
      this.reset(); return;
    }
    const selected = new Set(this.selected);
    for (const name of names) selected.add(name);
    this.names(source, selected);
    this.selected = selected; this.dirty = true;
  }
  discard(toolCallId: string): void { this.pending.delete(toolCallId); }
}

interface DiscoveryHost {
  identity(context: ToolContext): { registryRevision: number; policyVersion: number };
  stage(context: ToolContext, query: string, limit: number, expected: { registryRevision: number; policyVersion: number }): ToolResult;
}
/** Regular internal-state tool; the scoped runtime remains prepare/approval/execute owner. */
export function createToolDiscoveryTool(host: DiscoveryHost): ToolDefinition {
  const prepared = new WeakMap<PreparedTool, { query: string; limit: number; expected: { registryRevision: number; policyVersion: number } }>();
  return {
    name: DISCOVERY_TOOL_NAME, effectClass: 'state',
    description: 'Find permitted registered tools by name or description. Matching tools become callable from the next model turn after this result is saved. Catalogue changes discard prior selections; search again when needed.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 8 } }, required: ['query'], additionalProperties: false },
    async prepare(value, context) {
      const input = boundedJson(value, 4096);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['query', 'limit'].includes(key))) throw new EngineError('INVALID_TOOL_DISCOVERY_QUERY', 'Discovery requires query and optional result limit');
      const args = validateDiscoveryQuery(input.query, input.limit ?? 4), expected = host.identity(context);
      const preview: JsonObject = { query: args.query, limit: args.limit, ...expected };
      const result: PreparedTool = { name: DISCOVERY_TOOL_NAME, input: { ...args }, fingerprint: sha(JSON.stringify({ preview, sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId })), requiresApproval: false, preview };
      prepared.set(result, { ...args, expected }); return result;
    },
    async execute(value, context) {
      const request = prepared.get(value);
      if (!request) throw new EngineError('INVALID_PREPARED_TOOL', 'Discovery requires its original prepared handle');
      prepared.delete(value);
      return host.stage(context, request.query, request.limit, request.expected);
    },
  };
}
