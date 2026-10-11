import { createHash } from 'node:crypto';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import type { PreparedTool, ToolDefinition } from '../../ports.js';
import { boundedJson } from '../../artifacts/validation.js';
import { createToolResultEnvelope } from '../../artifacts/result.js';
import { SessionTaskService, TASK_STATUSES } from '../../session-state/index.js';
import { preparedRequests, sessionCallBinding } from '../prepared-requests.js';

export function createSessionTaskTools(service: SessionTaskService): ToolDefinition[] {
  return (['todo_read', 'todo_write'] as const).map((name): ToolDefinition => {
    const prepared = preparedRequests(sessionCallBinding);
    return {
      name, effectClass: name === 'todo_read' ? 'read' : 'state',
      description: name === 'todo_read' ? 'Read the session planning tasks and their revision. These tasks do not prove execution or authorize effects.' : 'Replace session planning tasks at expectedRevision. Tasks are separate from pending inputs, approvals and actual execution records.',
      inputSchema: name === 'todo_read' ? { type: 'object', additionalProperties: false, properties: {} } : {
        type: 'object', additionalProperties: false, required: ['expectedRevision', 'tasks'],
        properties: { expectedRevision: { type: 'integer', minimum: 0 }, tasks: { type: 'array', maxItems: 128, items: {
          type: 'object', additionalProperties: false, required: ['id', 'title', 'status'], properties: {
            id: { type: 'string' }, title: { type: 'string' }, status: { enum: [...TASK_STATUSES] },
          },
        } } },
      },
      async prepare(input, context) {
        if (context.signal.aborted) throw new EngineError('CANCELLED', 'Task tool cancelled');
        const value = boundedJson(input, 65_536);
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !(name === 'todo_read' ? [] : ['expectedRevision', 'tasks']).includes(key))) throw new EngineError('INVALID_TASK_INPUT', 'Task tool input has unsupported fields');
        if (name === 'todo_write' && (!Number.isSafeInteger(value.expectedRevision) || typeof value.expectedRevision !== 'number' || value.expectedRevision < 0 || !Array.isArray(value.tasks))) throw new EngineError('INVALID_TASK_INPUT', 'Task update requires expectedRevision and tasks');
        const record: PreparedTool = { name, input: value, fingerprint: createHash('sha256').update(JSON.stringify([sessionCallBinding(context), name, value])).digest('hex'), requiresApproval: false, preview: { operation: name } };
        return prepared.remember(record, context);
      },
      async execute(record, context) {
        prepared.claim(record, context, ['INVALID_PREPARED_TOOL', 'Task tool request changed or was already used']);
        if (context.signal.aborted) throw new EngineError('CANCELLED', 'Task tool cancelled');
        const value = record.input as JsonObject;
        const tasks = name === 'todo_read' ? service.get(context.sessionId) : service.replace(context.sessionId, value.expectedRevision as number, value.tasks);
        const data = JSON.parse(JSON.stringify(tasks)) as JsonObject;
        const content = JSON.stringify(data);
        const structuredResult = createToolResultEnvelope({ displayContent: content, structuredData: data }, { maxModelBytes: context.limits.maxOutputBytes });
        return { content: structuredResult.modelContent, data, structuredResult };
      },
    };
  });
}
