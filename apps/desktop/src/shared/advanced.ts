import type { JsonObject, JsonValue } from '@moodcode/contracts';

export const ADVANCED_ACTIONS = [
  'input.accept', 'input.cancel', 'session.pause', 'session.resume', 'tasks.replace', 'question.answer', 'question.reject',
  'terminal.preview', 'terminal.create', 'terminal.attach', 'terminal.read', 'terminal.write', 'terminal.resize', 'terminal.cancel',
  'mcp.preview', 'mcp.connect', 'mcp.disconnect', 'lsp.preview', 'lsp.connect', 'lsp.diagnostics',
  'worktree.create', 'worktree.cleanup', 'child.preview', 'child.start', 'child.cancel', 'child.stop',
  'team.create', 'team.inspect', 'team.member.preview', 'team.member.join', 'team.tasks.put', 'team.tasks.claim', 'team.tasks.complete',
  'team.message.send', 'team.mailbox.read', 'team.mailbox.claim',
  'workflow.register', 'workflow.preview', 'workflow.start', 'workflow.stage.start', 'workflow.stage.observe', 'workflow.inspect', 'handle.release',
] as const;
export type DesktopAdvancedActionType = typeof ADVANCED_ACTIONS[number];
export interface DesktopAdvancedAction { sessionId: string; type: DesktopAdvancedActionType; payload?: JsonObject }
/** Handles identify private utility objects; their displayed JSON never carries authority. */
export interface DesktopAdvancedPreview { handleId: string; kind: string; expiresAt: string; preview: JsonValue }
export interface DesktopAdvancedSnapshot {
  sessionId: string; workspaceId: string;
  inbox: JsonValue; control: JsonValue; tasks: JsonValue; questions: JsonValue;
  terminals: JsonValue; terminalCapability: JsonValue; children: JsonValue; worktrees: JsonValue;
  teams: JsonValue; workflows: JsonValue; mcp: JsonValue; languageServers: JsonValue; diagnostics: JsonValue;
}
const encoder = new TextEncoder();
function invalid(): never { throw Object.assign(new Error('The advanced desktop request is invalid.'), { code: 'INVALID_INPUT' }); }
/** Preload and utility both apply this closed, bounded JSON boundary. */
export function validateAdvancedAction(value: unknown): DesktopAdvancedAction {
  let nodes = 0, bytes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > 16) invalid();
    if (typeof item === 'string') bytes += encoder.encode(item).byteLength;
    else if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) bytes += 16;
    else if (item && typeof item === 'object') {
      if (ancestors.has(item)) invalid();
      const proto = Object.getPrototypeOf(item);
      if (!Array.isArray(item) && proto !== null && proto !== Object.prototype) invalid();
      ancestors.add(item);
      for (const key of Reflect.ownKeys(item)) {
        if (Array.isArray(item) && key === 'length') continue;
        if (typeof key !== 'string') invalid();
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
        bytes += encoder.encode(key).byteLength;
        visit(descriptor.value, depth + 1);
      }
      ancestors.delete(item);
    } else invalid();
    if (bytes > 65_536) invalid();
  };
  visit(value, 0);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['sessionId', 'type', 'payload'].includes(key))
    || typeof input.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId)
    || !ADVANCED_ACTIONS.includes(input.type as DesktopAdvancedActionType)
    || input.payload !== undefined && (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload))) invalid();
  return structuredClone(value) as DesktopAdvancedAction;
}
