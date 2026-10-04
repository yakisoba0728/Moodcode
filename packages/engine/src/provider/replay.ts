import { EngineError, type JsonObject, type JsonValue } from '@moodcode/contracts';
import { isDeepStrictEqual } from 'node:util';
import type { ProviderMessage } from '../ports.js';
import { credentialSecrets, redactCredentialJson, redactCredentialText } from './helpers.js';

export interface ReplayValidationOptions {
  apiKey?: string;
  secrets?: readonly string[];
  maxItems: number;
  maxBytes: number;
  maxToolArgumentBytes: number;
  maxToolCalls: number;
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

/** JSON.stringify's UTF-8 string size, without allocating an escaped copy. */
function quotedBytes(value: string): number {
  let bytes = 2;
  for (let offset = 0; offset < value.length; offset++) {
    const unit = value.charCodeAt(offset);
    if (unit === 34 || unit === 92) bytes += 2;
    else if (unit < 32) bytes += [8, 9, 10, 12, 13].includes(unit) ? 2 : 6;
    else if (unit < 128) bytes++;
    else if (unit < 2048) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(offset + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; offset++; }
      else bytes += 6;
    } else bytes += unit >= 0xdc00 && unit <= 0xdfff ? 6 : 3;
  }
  return bytes;
}

/** Read only data descriptors: getters, toJSON hooks and prototypes are not executed. */
function cloneJson(value: unknown, maximum: number): JsonValue {
  let bytes = 0;
  const ancestors = new Set<object>();
  const account = (count: number) => { bytes += count; if (bytes > maximum) invalid(); };
  const visit = (source: unknown, depth: number): JsonValue => {
    if (depth > 64) invalid();
    if (source === null) { account(4); return null; }
    if (typeof source === 'boolean') { account(source ? 4 : 5); return source; }
    if (typeof source === 'string') { account(quotedBytes(source)); return source; }
    if (typeof source === 'number') {
      if (!Number.isFinite(source)) invalid();
      account(JSON.stringify(source).length);
      return source === 0 ? 0 : source;
    }
    if (typeof source !== 'object' || ancestors.has(source)) invalid();
    const array = Array.isArray(source);
    const prototype = Object.getPrototypeOf(source);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
    ancestors.add(source);
    try {
      account(2);
      const keys = Reflect.ownKeys(source);
      if (array) {
        const length = Object.getOwnPropertyDescriptor(source, 'length')?.value as unknown;
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maximum || keys.length !== length + 1) invalid();
        for (const key of keys) {
          if (key === 'length') continue;
          if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) invalid();
        }
        const result: JsonValue[] = [];
        for (let offset = 0; offset < length; offset++) {
          const descriptor = Object.getOwnPropertyDescriptor(source, String(offset));
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
          if (offset > 0) account(1);
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }
      const result: JsonObject = {};
      for (const [offset, key] of keys.entries()) {
        if (typeof key !== 'string') invalid();
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
        account(quotedBytes(key) + 1 + (offset > 0 ? 1 : 0));
        Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return result;
    } finally { ancestors.delete(source); }
  };
  return visit(value, 0);
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
function validateNative(items: JsonObject[], options: ReplayValidationOptions): NativeCall[] {
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
        if (credentialSecrets(options.apiKey, options.secrets).some(secret => ciphertext.includes(secret))) invalid();
      }
    } else invalid();
  }
  return calls;
}

/** Clone native output safely for persistence and later same-provider stateless input. */
export function validateReplayItems(value: unknown, options: ReplayValidationOptions): JsonObject[] {
  try {
    const secrets = credentialSecrets(options.apiKey, options.secrets);
    for (const [name, limit] of [['maxItems', options.maxItems], ['maxBytes', options.maxBytes], ['maxToolArgumentBytes', options.maxToolArgumentBytes], ['maxToolCalls', options.maxToolCalls]] as const) {
      if (!Number.isSafeInteger(limit) || limit < (name === 'maxBytes' ? 1 : 0) || limit > ABSOLUTE_LIMIT) invalid();
    }
    if (!Array.isArray(value) || value.length > options.maxItems) invalid();
    const cloned = cloneJson(value, options.maxBytes);
    if (!Array.isArray(cloned)) invalid();
    const original = cloned.map(object);
    const calls = validateNative(original, options);
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
    validateNative(items, options);
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
