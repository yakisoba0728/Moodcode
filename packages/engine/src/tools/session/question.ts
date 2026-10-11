import { createHash } from 'node:crypto';
import { EngineError } from '@moodcode/contracts';
import type { PreparedTool, ToolDefinition } from '../../ports.js';
import { QuestionManager, normalizeQuestionSpec } from '../../questions/index.js';
import { preparedRequests, sessionCallBinding } from '../prepared-requests.js';

export function createQuestionTool(questions: QuestionManager): ToolDefinition {
  const requests = preparedRequests(sessionCallBinding);
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
      const prepared: PreparedTool = { name: 'ask_user', input, requiresApproval: false, fingerprint: createHash('sha256').update(JSON.stringify([sessionCallBinding(context), input])).digest('hex'), preview: { prompt: spec.prompt } };
      return requests.remember(prepared, context);
    },
    async execute(prepared, context) {
      requests.claim(prepared, context, ['INVALID_PREPARED_TOOL', 'Question request is stale or already used']);
      const question = await questions.request({ sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId, spec: prepared.input, timeoutMs: context.limits.toolTimeoutMs }, context.signal);
      const data = JSON.parse(JSON.stringify({ questionId: question.id, version: question.version, answer: question.answer }));
      return { content: JSON.stringify(data), data };
    },
  };
}
