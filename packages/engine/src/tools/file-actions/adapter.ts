import {registerPreparedResourceProducer,capturePreparedResource} from '../../effect-batches/claims.js';
import { createHash } from 'node:crypto';
import { EngineError, type JsonObject, type JsonValue } from '@moodcode/contracts';
import type { PreparedTool, ToolContext, ToolDefinition } from '../../ports.js';
import { enrichLegacyToolResult } from '../../artifacts/result.js';
import { createPatchTool } from '../patch/index.js';
import { boundedJson } from '../../artifacts/validation.js';
import { executionBinding, preparedRequests } from '../prepared-requests.js';
export interface FullContentChange { path: string; expectedHash: string | null; content: string | null }
export interface PatchAdapterInput { input: JsonValue; changes: FullContentChange[]; preview?: JsonObject }
/** Keeps the existing patch's opaque preimages and checkpoint lifecycle intact. */
export function createPatchAdapter(definition: { name: string; description: string; inputSchema: JsonObject; transform(input: unknown, context: ToolContext): Promise<PatchAdapterInput> }): ToolDefinition {
  const patch = createPatchTool();
  const requests = preparedRequests<PreparedTool>(executionBinding);
  const tool:ToolDefinition = { name: definition.name, description: definition.description, inputSchema: definition.inputSchema, effectClass: 'write',
    async prepare(input, context) {
      const transformed = await definition.transform(input, context); const inner = await patch.prepare({ changes: transformed.changes }, context);
      const normalized = boundedJson(transformed.input, 4 * 1024 * 1024);
      const preview: JsonObject = { ...inner.preview, operation: definition.name, ...(transformed.preview ?? {}) };
      const fingerprint = createHash('sha256').update(JSON.stringify({ name: definition.name, input: normalized, binding: executionBinding(context), patch: inner.fingerprint, preview })).digest('hex');
      const prepared: PreparedTool = { name: definition.name, input: normalized, fingerprint, requiresApproval: true, preview };
      return requests.remember(prepared, context, inner);
    },
    async execute(prepared, context) {
      const inner = requests.consume(prepared, ['INVALID_PREPARED_FILE_ACTION', 'File action must be prepared by this tool and used once']);
      if (context.signal.aborted) throw new EngineError('CANCELLED', 'File action cancelled');
      if (!requests.current(prepared, context)) throw new EngineError('FILE_ACTION_APPROVAL_STALE', 'File action or execution identity changed; prepare and approve again');
      const result = await patch.execute(inner, context);
      return enrichLegacyToolResult(result, {}, { maxModelBytes: Math.min(context.limits.maxOutputBytes, 32 * 1024), maxDisplayBytes: Math.min(context.limits.maxOutputBytes, 64 * 1024) });
    },
  };
  registerPreparedResourceProducer(tool,prepared=>{const request=requests.peek(prepared);return request&&!request.used?capturePreparedResource(patch,request.data):null;});
  return tool;
}
