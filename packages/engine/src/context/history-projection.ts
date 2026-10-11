import { types } from 'node:util';
import { EngineError, type Message } from '@moodcode/contracts';
import type { ProviderMessage } from '../ports.js';
import { entryBytes } from './memory.js';

/** Bounds shared by the media and document history projections. */
export const HISTORY_PROJECTION_LIMITS = Object.freeze({ maxSourceMessages: 512, maxMetadataBytes: 16_384, maxReplayNodes: 4096, maxReplayDepth: 32 });
export type ReplayFault = 'nodes' | 'keys' | 'proxy' | 'cycle' | 'prototype' | 'accessor' | 'unsupported';

export function fail(code: string, message: string): never { throw new EngineError(code, message); }

/** A plain, non-proxy object whose own properties are enumerable string-keyed data. */
export function record(value: unknown): value is Record<string, unknown> {
  if (types.isProxy(value) || !value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every(key => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
  });
}

/** Inspects replay structure only; opaque strings and encrypted/native reasoning are never parsed. */
export function inspectReplay(value: unknown, checkAbort: () => void, forbidden: (key: string, child: unknown) => boolean, fault: (kind: ReplayFault) => never): void {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }], seen = new Set<object>();
  let entries = 0, nodes = 0;
  while (stack.length) {
    checkAbort();
    const item = stack.pop()!;
    if (++nodes > HISTORY_PROJECTION_LIMITS.maxReplayNodes || item.depth > HISTORY_PROJECTION_LIMITS.maxReplayDepth) fault('nodes');
    if (item.value === null || typeof item.value !== 'object') continue;
    if (types.isProxy(item.value)) fault('proxy');
    if (seen.has(item.value)) fault('cycle');
    seen.add(item.value);
    const array = Array.isArray(item.value), prototype = Object.getPrototypeOf(item.value);
    if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) fault('prototype');
    const keys = Reflect.ownKeys(item.value); entries += keys.length;
    if (entries > HISTORY_PROJECTION_LIMITS.maxReplayNodes) fault('keys');
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(item.value, key);
      if (typeof key !== 'string' || !property || !Object.hasOwn(property, 'value') || !property.enumerable && !(array && key === 'length')) fault('accessor');
      const child: unknown = property.value;
      if (forbidden(key, child)) fault('unsupported');
      if (child !== null && typeof child === 'object') stack.push({ value: child, depth: item.depth + 1 });
    }
  }
}

/** The goal, the first and the latest user message of the active Run stay as text anchors. */
export function requiredUserAnchors(messages: readonly Message[], activeRunId?: string): string[] {
  const users = messages.filter(message => message.role === 'user'), activeUsers = users.filter(message => activeRunId === undefined || message.runId === activeRunId);
  return [users[0], activeUsers[0], activeUsers.at(-1)].filter(message => message !== undefined).map(message => message.id);
}

/** The model notice and the projection metadata share one explicit budget. */
export function provenanceNotice(prefix: string, body: object | null, metadata: object, maxMetadataBytes: number, overflow: () => never)
  : { requiredNotice: ProviderMessage | null; noticeBytes: number; metadataBytes: number } {
  const requiredNotice: ProviderMessage | null = body ? { role: 'assistant', content: prefix + JSON.stringify(body) } : null;
  const noticeBytes = requiredNotice ? entryBytes(requiredNotice) : 0;
  const metadataBytes = noticeBytes + Buffer.byteLength(JSON.stringify(metadata));
  if (metadataBytes > maxMetadataBytes) overflow();
  return { requiredNotice, noticeBytes, metadataBytes };
}
