import { types } from 'node:util';
import type { PolicyDecision, ToolEffectClass } from './policy.js';

export const TOOL_EFFECTS: ReadonlySet<ToolEffectClass> = new Set(['read', 'state', 'write', 'execute', 'network', 'unknown']);
export const POLICY_DECISIONS: ReadonlySet<PolicyDecision> = new Set(['allow', 'ask', 'deny']);

export type PlainListFault = 'shape' | 'limit' | 'elements';
/** A non-proxy Array.prototype array of at most max own enumerable data elements and no other own properties. */
export function plainList(value: unknown, max: number, fail: (fault: PlainListFault) => never): asserts value is unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail('shape');
  if (value.length > max) fail('limit');
  if (Reflect.ownKeys(value).length !== value.length + 1) fail('elements');
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('elements');
  }
}
