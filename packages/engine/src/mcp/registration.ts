import { createHash } from 'node:crypto';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import type { PreparedTool, ToolContext, ToolDefinition } from '../ports.js';
import { projectToolResult } from '../artifacts/result.js';
import { cappedJson, object } from './protocol.js';
import { McpClient, type McpResource, type McpTool } from './client.js';
import { ScopedToolRuntime } from '../tools/runtime/index.js';
function binding(context: ToolContext): string { return JSON.stringify([context.workspace.id, context.workspace.root, context.sessionId, context.runId, context.toolCallId, context.turnId, context.attemptId]); }
function hostName(id: string, remote: string): string { const name = `mcp_${id}_${remote}`; return name.length <= 128 ? name : `mcp_${id}_${remote.slice(0, 64)}_${createHash('sha256').update(remote).digest('hex').slice(0, 16)}`; }
function definition(client: McpClient, remote: McpTool, revision: number): ToolDefinition {
  const name = hostName(client.id, remote.name); const requests = new WeakMap<PreparedTool, { snapshot: string; binding: string; used: boolean }>();
  return { name, effectClass: 'unknown', description: remote.description, inputSchema: structuredClone(remote.inputSchema),
    async prepare(value, context) { if (!client.connected || client.revision !== revision) throw new EngineError('MCP_CATALOGUE_STALE', 'MCP connection or advertised schema changed'); const input = cappedJson(value, 256 * 1024); if (!object(input)) throw new EngineError('MCP_INVALID_TOOL_ARGUMENT', 'MCP tool arguments must be a bounded object');
      const preview: JsonObject = { serverId: client.id, remoteTool: remote.name, arguments: input, catalogueRevision: revision, effects: 'untrusted server effects require approval' };
      const prepared: PreparedTool = { name, input, preview, requiresApproval: true, fingerprint: createHash('sha256').update(JSON.stringify({ name, revision, input, binding: binding(context), preview })).digest('hex') }; requests.set(prepared, { snapshot: JSON.stringify(prepared), binding: binding(context), used: false }); return prepared;
    },
    async execute(prepared, context) { const request = requests.get(prepared); if (!request || request.used) throw new EngineError('INVALID_PREPARED_MCP_TOOL', 'MCP call must be prepared by this connection and used once'); request.used = true;
      if (request.binding !== binding(context) || request.snapshot !== JSON.stringify(prepared)) throw new EngineError('MCP_APPROVAL_STALE', 'MCP call or authorization context changed');
      const result = await client.callTool(remote.name, prepared.input as JsonObject, revision, context.signal);
      if (!Array.isArray(result.content) || result.content.length > 64 || result.isError !== undefined && typeof result.isError !== 'boolean') throw new EngineError('MCP_INVALID_TOOL_RESULT', 'MCP tool result content is invalid');
      const texts: string[] = []; let omitted = 0;
      for (const block of result.content) { if (!object(block) || typeof block.type !== 'string') throw new EngineError('MCP_INVALID_TOOL_RESULT', 'MCP content block is invalid'); if (block.type === 'text') { if (typeof block.text !== 'string') throw new EngineError('MCP_INVALID_TOOL_RESULT', 'MCP text content is invalid'); texts.push(block.text); } else if (block.type === 'resource' && object(block.resource) && typeof block.resource.text === 'string') texts.push(block.resource.text); else omitted++; }
      const warnings = omitted ? [`${omitted} non-text MCP content block(s) were omitted from model text projection.`] : [];
      return projectToolResult({ displayContent: texts.join('\n'), structuredData: result.structuredContent ?? result, metadata: { serverId: client.id, remoteTool: remote.name, catalogueRevision: revision, omittedNonTextBlocks: omitted }, warnings, outcome: result.isError ? 'failed' : 'completed' }, { maxModelBytes: Math.min(context.limits.maxOutputBytes, 32 * 1024), maxDisplayBytes: Math.min(context.limits.maxOutputBytes, 64 * 1024) });
    },
  };
}
export interface McpRegistration { scopeId: string; tools: readonly ToolDefinition[]; resources: readonly McpResource[]; close(): Promise<void> }
/** Scope removal runs on disconnect/list-change, invalidating every captured prepared request. */
export async function registerMcp(client: McpClient, runtime: ScopedToolRuntime, signal: AbortSignal): Promise<McpRegistration> {
  if (!client.connected) await client.connect(signal); const discovered = await client.listTools(signal); const revision = client.revision; const resources = await client.listResources(signal);
  if (!client.connected || client.revision !== revision || signal.aborted) throw new EngineError('MCP_CATALOGUE_STALE', 'MCP catalogue changed during registration');
  const tools = discovered.map(tool => definition(client, tool, revision)); const scopeId = `mcp_${client.id}`; const disposers: (() => void)[] = []; let removed = false;
  const remove = () => { if (removed) return; removed = true; for (const dispose of disposers.reverse()) dispose(); };
  try { for (const tool of tools) disposers.push(runtime.register(scopeId, tool, { effect: 'unknown' })); }
  catch (error) { remove(); await client.close(); throw error; }
  const detachClose = client.onClose(remove); const detachChange = client.onCatalogChanged(remove);
  return { scopeId, tools, resources, async close() { remove(); detachClose(); detachChange(); await client.close(); } };
}
