import {registerPreparedResourceProducer,issuePreparedPatchResource,consumeResourcePermit,settleResourcePermit} from '../../effect-batches/claims.js';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { EngineError, type Checkpoint, type JsonValue } from '@moodcode/contracts';
import type { PreparedTool, ToolContext, ToolDefinition, ToolResult } from '../../ports.js';
import { acquireExecutionLock, type ExecutionLock } from '../command/execution-lock.js';
import { PhysicalPatchProducer, PHYSICAL_PATCH_LIMITS, type PhysicalPatchCapture } from './physical.js';

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function active(context: ToolContext): void { if (context.signal.aborted) throw new EngineError('CANCELLED', 'Patch was cancelled'); }
interface BoundRequest {
  workspaceId: string; root: string; sessionId: string; runId: string; toolCallId: string;
  executionLockPath?: string; fingerprint: string; input: string; preview: string;
  capture: PhysicalPatchCapture; resource: object|null; used: boolean;
}

/** The real tool wrapper owns approval and Run checkpoints; physical I/O has its own original capability. */
export function createPatchTool(): ToolDefinition {
  const physical = new PhysicalPatchProducer(), requests = new WeakMap<PreparedTool, BoundRequest>();
  const tool:ToolDefinition = {
    name: 'apply_patch',
    description: 'Propose bounded create, update, or delete changes using full UTF-8 file contents and expected SHA-256 hashes. Requires approval.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['changes'], properties: { changes: {
      type: 'array', minItems: 1, maxItems: PHYSICAL_PATCH_LIMITS.files, items: { type: 'object', additionalProperties: false,
        required: ['path','expectedHash','content'], properties: { path: { type: 'string', maxLength: 512 },
          expectedHash: { anyOf: [{ type: 'string', pattern: '^[a-f0-9]{64}$' }, { type: 'null' }] }, content: { anyOf: [{ type: 'string' }, { type: 'null' }] } } } } } },
    async prepare(input, context) {
      active(context);
      // Input validation precedes root observations; the physical producer validates each original data entry.
      if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'changes')) throw new EngineError('INVALID_PATCH_INPUT', 'A patch requires bounded full-content changes');
      const root = await fs.lstat(context.workspace.root);
      const capture = await physical.prepare({ workspaceId: context.workspace.id, root: context.workspace.root,
        rootDevice: String(root.dev), rootInode: String(root.ino) }, (input as { changes: never[] }).changes, context.signal);
      try {
        active(context); const source = physical.read(capture);
        const identity = { name: 'apply_patch', workspaceId: context.workspace.id, root: context.workspace.root,
          sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId, executionLockPath: context.executionLockPath, changes: source.changes };
        const prepared: PreparedTool = { name: 'apply_patch', input: { changes: source.changes.map(change => ({ ...change })) },
          fingerprint: hash(identity), requiresApproval: true, preview: source.preview };
        requests.set(prepared, { workspaceId: context.workspace.id, root: context.workspace.root, sessionId: context.sessionId,
          runId: context.runId, toolCallId: context.toolCallId, executionLockPath: context.executionLockPath,
          fingerprint: prepared.fingerprint, input: JSON.stringify(prepared.input), preview: JSON.stringify(prepared.preview), capture, resource:physical.resourceSnapshot(capture) ? issuePreparedPatchResource(physical.resourceSnapshot(capture)!,capture,signal=>physical.assertFresh(capture,signal)) : null, used: false });
        return prepared;
      } catch (error) { physical.release(capture); throw error; }
    },
    async execute(prepared, context): Promise<ToolResult> {
      active(context); const request = requests.get(prepared);
      if (!request || request.used) throw new EngineError('INVALID_PREPARED_PATCH', 'A patch must be prepared by this tool and can be executed only once');
      request.used = true;
      if (prepared.name !== 'apply_patch' || !prepared.requiresApproval || prepared.fingerprint !== request.fingerprint
        || JSON.stringify(prepared.input) !== request.input || JSON.stringify(prepared.preview) !== request.preview
        || context.workspace.id !== request.workspaceId || context.workspace.root !== request.root || context.sessionId !== request.sessionId
        || context.runId !== request.runId || context.toolCallId !== request.toolCallId || context.executionLockPath !== request.executionLockPath) {
        physical.release(request.capture); throw new EngineError('PATCH_APPROVAL_STALE', 'Prepared patch or approval context changed; a new preview and approval are required');
      }
      let lock: ExecutionLock | undefined, accountingComplete = false, cleanupConfirmed = false;
      try {
        const originalResult = await physical.apply(request.capture, { signal: context.signal, beforeEffect: async () => {
          active(context); if(context.effectBatchPermit)consumeResourcePermit(context.effectBatchPermit,context,request.capture);else if (request.executionLockPath) lock = acquireExecutionLock(request.executionLockPath);
        } });
        const observation = physical.readResult(originalResult); cleanupConfirmed = observation.cleanupConfirmed;
        const checkpoint: Checkpoint = { id: randomUUID(), runId: context.runId, toolCallId: context.toolCallId, kind: 'patch',
          createdAt: new Date().toISOString(), files: observation.files.filter(file => file.observationComplete && file.mayHaveChanged
            && (file.before !== file.after || file.beforeHash !== file.afterHash)).map(file => ({ path: file.path, before: file.before,
            after: file.after, beforeHash: file.beforeHash, afterHash: file.afterHash })), warnings: [...observation.warnings],
          ...(observation.incomplete ? { incomplete: true } : {}) };
        try { context.recordCheckpoint(checkpoint); }
        catch (error) { throw new EngineError('PATCH_CHECKPOINT_FAILED', 'Filesystem effects may be present, but the checkpoint could not be persisted',
          { checkpointId: checkpoint.id, cause: error instanceof Error ? error.message : String(error) }); }
        accountingComplete = true;
        const data: JsonValue = { cleanupConfirmed: observation.cleanupConfirmed, physicalState: observation.state, checkpointId: checkpoint.id, changedFiles: checkpoint.files.map(file => file.path), incomplete: checkpoint.incomplete ?? false, warnings: checkpoint.warnings };
        const summary = observation.errorMessage === null ? `Applied patch to ${checkpoint.files.length} file(s).` : `Patch partially failed: ${observation.errorMessage}`;
        const limit = Math.max(0, Math.min(context.limits.maxOutputBytes, 4096));
        let content = Buffer.from(summary, 'utf8').subarray(0, limit).toString('utf8'); while (Buffer.byteLength(content, 'utf8') > limit) content = content.slice(0, -1);
        return { content, ...(observation.incomplete ? { isError: true } : {}), data };
      } finally { if(context.effectBatchPermit)settleResourcePermit(context.effectBatchPermit,context,request.capture,accountingComplete && cleanupConfirmed);physical.release(request.capture); lock?.release(accountingComplete && cleanupConfirmed); }
    },
  };
  registerPreparedResourceProducer(tool, prepared=>requests.get(prepared)?.resource??null);
  return tool;
}
