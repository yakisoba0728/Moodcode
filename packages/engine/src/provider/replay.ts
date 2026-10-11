import { EngineError, type JsonObject, type JsonValue } from '@moodcode/contracts';
import { isDeepStrictEqual } from 'node:util';
import type { ProviderMessage } from '../ports.js';
import { credentialSecrets, redactCredentialJson, redactCredentialText } from './helpers.js';
import { plainJson } from '../shared/data.js';

export interface ReplayValidationOptions {
  secrets?: readonly string[];
  maxItems: number;
  maxBytes: number;
  maxToolArgumentBytes: number;
  maxToolCalls: number;
}
/** Older replay has no binding; newly emitted replay is portable only within its model/protocol. */
export function replayCompatible(message: ProviderMessage, providerId: string, modelId: string, protocol: string): boolean {
  const replay = message.providerReplay;
  if (!replay || replay.providerId !== providerId) return false;
  const binding: Record<string, unknown> = {};
  for (const key of ['modelId', 'protocol', 'version']) {
    const descriptor = Object.getOwnPropertyDescriptor(replay, key);
    if (!descriptor) continue;
    if (!descriptor.enumerable || !('value' in descriptor)) invalid();
    binding[key] = descriptor.value;
  }
  if (!Object.keys(binding).length) return true;
  if (Object.keys(binding).length !== 3 || typeof binding.modelId !== 'string' || !binding.modelId.trim() || Buffer.byteLength(binding.modelId) > 256 || typeof binding.protocol !== 'string' || !binding.protocol.trim() || Buffer.byteLength(binding.protocol) > 256 || binding.version !== 1) invalid();
  return binding.modelId === modelId && binding.protocol === protocol;
}

const ABSOLUTE_LIMIT = 2_147_483_647;
function invalid(): never { throw new EngineError('PROVIDER_INVALID_REPLAY', 'Provider replay is invalid.'); }
function object(value: JsonValue | undefined): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}
function nonempty(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !value.trim()) invalid();
  return value;
}
function string(value: JsonValue | undefined): string { if (typeof value !== 'string') invalid(); return value; }
function dataProperty(value: unknown, key: string, required = true, array = false): unknown {
  if (value === null || typeof value !== 'object') invalid();
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : Array.isArray(value) || prototype !== Object.prototype && prototype !== null) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) { if (required) invalid(); return undefined; }
  if (!descriptor.enumerable || !('value' in descriptor)) invalid();
  return descriptor.value;
}

/** Read only data descriptors: getters, toJSON hooks, proxies and prototypes are not executed. */
function cloneJson(value: unknown, maximum: number): JsonValue {
  return plainJson(value as JsonValue, { maxBytes: maximum, maxNodes: Infinity, maxDepth: 64, maxItems: maximum, accounting: 'encoded', positiveZero: true, fail: invalid });
}

function argumentCloneBudget(bytes: number): number {
  // A compact finite numeric token such as 1e20 can expand when JSON.stringify
  // prints it in decimal notation. A JSON number needs at most 24 characters.
  return Math.min(ABSOLUTE_LIMIT, Math.max(1, bytes) * 24);
}
function argumentValue(argumentsText: string): JsonValue {
  let parsed: unknown;
  try { parsed = JSON.parse(argumentsText); } catch { invalid(); }
  return cloneJson(parsed, argumentCloneBudget(Buffer.byteLength(argumentsText, 'utf8')));
}

interface NativeCall { itemIndex: number; argumentsText: string; input: JsonValue }
function validateNative(items: JsonObject[], options: ReplayValidationOptions, secrets: readonly string[]): NativeCall[] {
  const ids = new Set<string>();
  const callIds = new Set<string>();
  const calls: NativeCall[] = [];
  let argumentBytes = 0;
  for (const [itemIndex, item] of items.entries()) {
    const id = nonempty(item.id);
    if (ids.has(id)) invalid();
    ids.add(id);
    if (Object.hasOwn(item, 'status') && item.status !== 'completed') invalid();
    if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) invalid();
      if (Object.hasOwn(item, 'phase') && item.phase !== null && item.phase !== 'commentary' && item.phase !== 'final_answer') invalid();
      for (const value of item.content) {
        const part = object(value);
        if (part.type === 'output_text') {
          string(part.text);
          if (Object.hasOwn(part, 'annotations')) {
            if (!Array.isArray(part.annotations)) invalid();
            for (const annotation of part.annotations) object(annotation);
          }
        } else if (part.type === 'refusal') string(part.refusal);
        else invalid();
      }
    } else if (item.type === 'function_call') {
      const callId = nonempty(item.call_id);
      nonempty(item.name);
      if (callIds.has(callId) || callIds.size >= options.maxToolCalls) invalid();
      callIds.add(callId);
      const argumentsText = string(item.arguments);
      argumentBytes += Buffer.byteLength(argumentsText, 'utf8');
      if (argumentBytes > options.maxToolArgumentBytes) invalid();
      calls.push({ itemIndex, argumentsText, input: argumentValue(argumentsText) });
    } else if (item.type === 'reasoning') {
      for (const [field, kind] of [['summary', 'summary_text'], ['content', 'reasoning_text']] as const) {
        if (!Object.hasOwn(item, field)) continue;
        const parts = item[field];
        if (!Array.isArray(parts)) invalid();
        for (const value of parts) { const part = object(value); if (part.type !== kind) invalid(); string(part.text); }
      }
      if (Object.hasOwn(item, 'encrypted_content') && item.encrypted_content !== null) {
        const ciphertext = string(item.encrypted_content);
        if (secrets.some(secret => ciphertext.includes(secret))) invalid();
      }
    } else invalid();
  }
  return calls;
}

/** Clone native output safely for persistence and later same-provider stateless input. */
export function validateReplayItems(value: unknown, options: ReplayValidationOptions): JsonObject[] {
  try {
    const secrets = credentialSecrets(undefined, options.secrets);
    for (const [name, limit] of [['maxItems', options.maxItems], ['maxBytes', options.maxBytes], ['maxToolArgumentBytes', options.maxToolArgumentBytes], ['maxToolCalls', options.maxToolCalls]] as const) {
      if (!Number.isSafeInteger(limit) || limit < (name === 'maxBytes' ? 1 : 0) || limit > ABSOLUTE_LIMIT) invalid();
    }
    if (!Array.isArray(value) || value.length > options.maxItems) invalid();
    const cloned = cloneJson(value, options.maxBytes);
    if (!Array.isArray(cloned)) invalid();
    const original = cloned.map(object);
    const calls = validateNative(original, options, secrets);
    const redacted = redactCredentialJson(original, secrets);
    if (!Array.isArray(redacted)) invalid();
    const safe = redacted.map(object);
    for (const call of calls) {
      const input = redactCredentialJson(call.input, secrets);
      // Serialized arguments may contain JSON escapes hiding a credential. Redact
      // their parsed values too, preserving original formatting when unchanged.
      const rawRedacted = redactCredentialText(call.argumentsText, secrets);
      const changed = rawRedacted !== call.argumentsText || !isDeepStrictEqual(input, call.input);
      const argumentsText = changed ? JSON.stringify(input) : call.argumentsText;
      if (secrets.some(secret => argumentsText.includes(secret))) invalid();
      safe[call.itemIndex]!.arguments = argumentsText;
    }
    const checked = cloneJson(safe, options.maxBytes);
    if (!Array.isArray(checked)) invalid();
    const items = checked.map(object);
    validateNative(items, options, secrets);
    return items;
  } catch { invalid(); }
}

/** A replay cannot replace the normalized assistant text or executable calls. */
export function validateReplayBinding(message: ProviderMessage, items: readonly JsonObject[]): void {
  try {
    const replay = validateReplayItems(items, { maxItems: ABSOLUTE_LIMIT, maxBytes: ABSOLUTE_LIMIT, maxToolArgumentBytes: ABSOLUTE_LIMIT, maxToolCalls: ABSOLUTE_LIMIT });
    const role = dataProperty(message, 'role');
    const messageContent = dataProperty(message, 'content');
    const normalized = dataProperty(message, 'toolCalls', false);
    if (role !== 'assistant' || typeof messageContent !== 'string') invalid();
    let content = '';
    const calls: { id: string; name: string; input: JsonValue; bytes: number }[] = [];
    for (const item of replay) {
      if (item.type === 'message') {
        for (const value of item.content as JsonValue[]) { const part = object(value); content += string(part.type === 'output_text' ? part.text : part.refusal); }
      } else if (item.type === 'function_call') {
        const argumentsText = string(item.arguments);
        calls.push({ id: nonempty(item.call_id), name: nonempty(item.name), input: argumentValue(argumentsText), bytes: Buffer.byteLength(argumentsText, 'utf8') });
      }
    }
    if (content !== messageContent) invalid();
    if (normalized === undefined) { if (calls.length > 0) invalid(); return; }
    if (!Array.isArray(normalized) || Object.getPrototypeOf(normalized) !== Array.prototype) invalid();
    const length = Object.getOwnPropertyDescriptor(normalized, 'length')?.value as unknown;
    if (length !== calls.length || Reflect.ownKeys(normalized).length !== calls.length + 1) invalid();
    for (const [offset, call] of calls.entries()) {
      const expected = dataProperty(normalized, String(offset), true, true);
      if (dataProperty(expected, 'id') !== call.id || dataProperty(expected, 'name') !== call.name || !isDeepStrictEqual(cloneJson(dataProperty(expected, 'input'), argumentCloneBudget(call.bytes)), call.input)) invalid();
    }
  } catch { invalid(); }
}
