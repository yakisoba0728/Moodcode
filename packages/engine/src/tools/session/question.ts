import { createHash } from 'node:crypto';
import { EngineError } from '@moodcode/contracts';
import type { PreparedTool, ToolContext, ToolDefinition } from '../../ports.js';
import { QuestionManager, normalizeQuestionSpec } from '../../questions/index.js';

function owner(context: ToolContext): string { return JSON.stringify([context.sessionId, context.runId, context.toolCallId, context.turnId, context.attemptId]); }
export function createQuestionTool(questions: QuestionManager): ToolDefinition {
  const requests = new WeakMap<PreparedTool, { owner: string; serialized: string; used: boolean }>();
  return {
    name: 'ask_user', effectClass: 'state', description: 'Ask a bounded question and await the user answer. Use choices or free text; the answer is bound to this Run and tool call and does not approve file effects.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['prompt'], properties: {
      prompt: { type: 'string', maxLength: 4096 }, options: { type: 'array', maxItems: 12, items: {
        type: 'object', additionalProperties: false, required: ['id', 'label'], properties: { id: { type: 'string' }, label: { type: 'string' } },
      } }, allowFreeText: { type: 'boolean' }, multiple: { type: 'boolean' },
    } },
    async prepare(value, context) {
      if (context.signal.aborted) throw new EngineError('QUESTION_CANCELLED', 'Question tool cancelled');
      const spec = normalizeQuestionSpec(value);
      const input = JSON.parse(JSON.stringify(spec));
      const prepared: PreparedTool = { name: 'ask_user', input, requiresApproval: false, fingerprint: createHash('sha256').update(JSON.stringify([owner(context), input])).digest('hex'), preview: { prompt: spec.prompt } };
      requests.set(prepared, { owner: owner(context), serialized: JSON.stringify(prepared), used: false });
      return prepared;
    },
    async execute(prepared, context) {
      const request = requests.get(prepared);
      if (!request || request.used || request.owner !== owner(context) || request.serialized !== JSON.stringify(prepared)) throw new EngineError('INVALID_PREPARED_TOOL', 'Question request is stale or already used');
      request.used = true;
      const question = await questions.request({ sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId, spec: prepared.input, timeoutMs: context.limits.toolTimeoutMs }, context.signal);
      const data = JSON.parse(JSON.stringify({ questionId: question.id, version: question.version, answer: question.answer }));
      return { content: JSON.stringify(data), data };
    },
  };
}
