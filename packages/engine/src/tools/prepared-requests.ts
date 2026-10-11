import { EngineError } from '@moodcode/contracts';
import type { PreparedTool, ToolContext } from '../ports.js';

export type CallBinding = (context: ToolContext) => string;
type Failure = readonly [code: string, message: string];

export const executionBinding: CallBinding = context => JSON.stringify([context.workspace.id, context.workspace.root, context.sessionId, context.runId, context.toolCallId, context.turnId, context.attemptId, context.executionLockPath]);
export const workspaceCallBinding: CallBinding = context => JSON.stringify([context.workspace.id, context.workspace.root, context.sessionId, context.runId, context.toolCallId, context.turnId, context.attemptId]);
export const sessionCallBinding: CallBinding = context => JSON.stringify([context.sessionId, context.runId, context.toolCallId, context.turnId, context.attemptId]);

/** Requests one tool prepared: each executes once, under its preparing call identity and unchanged since prepare. */
export function preparedRequests<T = void>(binding: CallBinding) {
  const requests = new WeakMap<PreparedTool, { data: T; snapshot: string; binding: string; used: boolean }>();
  const current = (prepared: PreparedTool, context: ToolContext): boolean => {
    const request = requests.get(prepared);
    return request !== undefined && request.binding === binding(context) && request.snapshot === JSON.stringify(prepared);
  };
  return {
    remember(prepared: PreparedTool, context: ToolContext, data: T): PreparedTool {
      requests.set(prepared, { data, snapshot: JSON.stringify(prepared), binding: binding(context), used: false });
      return prepared;
    },
    peek(prepared: PreparedTool): { readonly data: T; readonly used: boolean } | undefined { return requests.get(prepared); },
    /** Marks the request used before any staleness check; the caller checks `current` afterwards. */
    consume(prepared: PreparedTool, [code, message]: Failure): T {
      const request = requests.get(prepared);
      if (!request || request.used) throw new EngineError(code, message);
      request.used = true;
      return request.data;
    },
    current,
    /** Marks the request used only when it is unused and current. */
    claim(prepared: PreparedTool, context: ToolContext, [code, message]: Failure): T {
      const request = requests.get(prepared);
      if (!request || request.used || !current(prepared, context)) throw new EngineError(code, message);
      request.used = true;
      return request.data;
    },
  };
}
