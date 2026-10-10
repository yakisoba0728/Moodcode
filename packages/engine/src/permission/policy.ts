import { EngineError } from '@moodcode/contracts';
import { createHash } from 'node:crypto';
export type ToolEffectClass = 'read' | 'state' | 'write' | 'execute' | 'network' | 'unknown';
export type PolicyDecision = 'allow' | 'ask' | 'deny';
export interface ToolPolicyRule { tool?: string; effect?: ToolEffectClass; resource?: string; decision: PolicyDecision }
export interface ToolPolicyInput { toolName: string; effect: ToolEffectClass; mode: 'plan' | 'build'; requiresApproval: boolean; resources?: readonly string[] }
export interface ToolPolicyResult { decision: PolicyDecision; version: number; reason: string }
/** True when a workspace-relative descendant path is withheld from a directory walk. */
export type PathRestriction = (path: string) => boolean;
const EFFECTS = new Set<ToolEffectClass>(['read', 'state', 'write', 'execute', 'network', 'unknown']);
const restrictions = new WeakMap<object, PathRestriction>();
function applies(rule: ToolPolicyRule, toolName: string, effect: ToolEffectClass): boolean {
  return (rule.tool === undefined || rule.tool === '*' || rule.tool === toolName) && (rule.effect === undefined || rule.effect === effect);
}
/** Lexical match: the exact resource text, or a `path:` prefix ending in `/**` and its base. */
function covers(rule: string, resource: string): boolean {
  return resource === rule || rule.startsWith('path:') && rule.endsWith('/**') && (resource === rule.slice(0, -3) || resource.startsWith(`${rule.slice(0, -3)}/`));
}
/** Runtime-internal: exposes a call's restriction to directory walks that run with this execution context. */
export async function withPathRestriction<T>(context: object, restriction: PathRestriction | undefined, run: () => Promise<T>): Promise<T> {
  if (!restriction) return run();
  const previous = restrictions.get(context);
  restrictions.set(context, restriction);
  try { return await run(); }
  finally { if (previous) restrictions.set(context, previous); else restrictions.delete(context); }
}
export function pathRestriction(context: object): PathRestriction | undefined { return restrictions.get(context); }
export function inferToolEffect(name: string, declared?: ToolEffectClass): ToolEffectClass {
  if (declared !== undefined) { if (!EFFECTS.has(declared)) throw new EngineError('INVALID_TOOL_EFFECT', 'Unsupported tool effect class'); return declared; }
  if (['read_file', 'list_files', 'search_files', 'glob_files', 'regex_search', 'todo_read', 'skill_read'].includes(name)) return 'read';
  if (['ask_user', 'todo_write'].includes(name)) return 'state';
  if (['apply_patch', 'edit_file', 'write_file', 'rename_file', 'delete_file'].includes(name)) return 'write';
  if (['run_command', 'bash'].includes(name)) return 'execute';
  if (['web_fetch', 'web_search'].includes(name)) return 'network';
  return 'unknown';
}
/** Denials dominate rules, prepared requirements, remembered grants and provider visibility. */
export class ToolPolicy {
  private rules: readonly ToolPolicyRule[] = [];
  private current = 0;
  constructor(rules: readonly ToolPolicyRule[] = []) { this.replace(rules); }
  get version(): number { return this.current; }
  replace(rules: readonly ToolPolicyRule[]): number {
    if (!Array.isArray(rules) || rules.length > 256) throw new EngineError('INVALID_TOOL_POLICY', 'Policy requires at most 256 rules');
    const copy = rules.map(rule => {
      if (!rule || typeof rule !== 'object' || !['allow', 'ask', 'deny'].includes(rule.decision) || rule.tool === undefined && rule.effect === undefined || rule.tool !== undefined && (typeof rule.tool !== 'string' || !rule.tool || Buffer.byteLength(rule.tool) > 128 || /[\u0000-\u001f\u007f]/.test(rule.tool)) || rule.effect !== undefined && !EFFECTS.has(rule.effect) || rule.resource !== undefined && (typeof rule.resource !== 'string' || !/^(?:path|command):/.test(rule.resource) || Buffer.byteLength(rule.resource) > 8192 || /[\u0000\r\n]/.test(rule.resource))) throw new EngineError('INVALID_TOOL_POLICY', 'Invalid tool policy rule');
      return Object.freeze({ ...rule });
    });
    this.rules = Object.freeze(copy);
    this.current = this.current === 0 ? Math.max(1, Number.parseInt(createHash('sha256').update(JSON.stringify(copy.map(rule => ({ tool: rule.tool, effect: rule.effect, resource: rule.resource, decision: rule.decision })))).digest('hex').slice(0, 12), 16)) : this.current + 1;
    return this.current;
  }
  evaluate(input: ToolPolicyInput): ToolPolicyResult {
    const result = (decision: PolicyDecision, reason: string) => ({ decision, reason, version: this.current });
    const matches = this.rules.filter(rule => applies(rule, input.toolName, input.effect) && (rule.resource === undefined || input.resources?.some(resource => covers(rule.resource!, resource))));
    if (matches.some(rule => rule.decision === 'deny')) return result('deny', 'configured denial');
    if (input.mode === 'plan' && input.effect !== 'read' && input.effect !== 'state') return result('deny', 'plan mode allows read and internal state effects only');
    if (matches.some(rule => rule.decision === 'ask')) return result('ask', 'configured approval requirement');
    if (input.requiresApproval) return result('ask', 'prepared tool requires approval');
    if (input.effect === 'unknown') return result('ask', 'unknown tool effects require approval');
    if (matches.some(rule => rule.decision === 'allow')) return result('allow', 'configured allowance');
    return input.effect === 'read' || input.effect === 'state' ? result('allow', `${input.effect} effect`) : result('ask', 'effect requires approval');
  }
  /** Deny/ask path rules below a call's own resources; rules those resources matched were already decided for the call. */
  descendantRestriction(input: Pick<ToolPolicyInput, 'toolName' | 'effect' | 'resources'>): PathRestriction | undefined {
    const rules = this.rules.filter(rule => rule.decision !== 'allow' && rule.resource?.startsWith('path:') && applies(rule, input.toolName, input.effect) && !input.resources?.some(resource => covers(rule.resource!, resource)));
    return rules.length ? path => rules.some(rule => covers(rule.resource!, `path:${path}`)) : undefined;
  }
}
