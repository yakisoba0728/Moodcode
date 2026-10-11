import { types } from 'node:util';
import { sealRecord, verifySealed } from './canonical.js';

/** Why the walker rejected a value; each wrapper maps it to its own code and message. */
export type PlainJsonFault = 'structure' | 'bytes' | 'items' | 'text' | 'number' | 'value' | 'cycle' | 'prototype' | 'symbol' | 'accessor' | 'holes' | 'element' | 'property';
export interface PlainJsonOptions {
  readonly maxBytes: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxItems?: number;
  /** text charges the UTF-8 bytes of strings and keys; encoded charges the JSON.stringify length. */
  readonly accounting: 'text' | 'encoded';
  readonly wellFormed?: boolean;
  readonly rejectNul?: boolean;
  readonly rejectKeys?: readonly string[];
  /** Copy enumerable data properties only, without rejecting proxies, array prototypes, symbol keys, hidden properties or array extras. */
  readonly lenient?: boolean;
  readonly freeze?: boolean;
  readonly nullPrototype?: boolean;
  readonly fail: (fault: PlainJsonFault) => never;
}

/** Bounded copy of JSON data read through property descriptors: no getter or serializer runs, nor a proxy trap unless lenient. */
export function plainJson<T>(input: T, options: PlainJsonOptions): T {
  const { maxBytes, maxNodes, maxDepth, maxItems, wellFormed, rejectNul, rejectKeys = [], lenient, freeze, nullPrototype } = options;
  const fail: (fault: PlainJsonFault) => never = options.fail;
  const encoded = options.accounting === 'encoded', visiting = new Set<object>();
  let bytes = 0, nodes = 0;
  const charge = (count: number): void => { bytes += count; if (bytes > maxBytes) fail('bytes'); };
  const syntax = (count: number): void => { if (encoded) charge(count); };
  // The raw length is checked first so an oversized string is never JSON-encoded.
  const text = (value: string, extra: number): void => {
    const raw = Buffer.byteLength(value);
    if (raw > maxBytes - bytes) fail('bytes');
    charge(encoded ? Buffer.byteLength(JSON.stringify(value)) + extra : raw);
  };
  const put = (target: Record<string, unknown>, key: string, value: unknown): void => {
    if (nullPrototype) target[key] = value;
    else Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  };
  const exact = (value: object, array: boolean, depth: number): unknown => {
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>, keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string')) fail('symbol');
    if (Object.values(descriptors).some(descriptor => !('value' in descriptor))) fail('accessor');
    syntax(2 + Math.max(0, keys.length - (array ? 2 : 1)));
    if (array) {
      const length = (value as unknown[]).length, target: unknown[] = [];
      if (!descriptors.length || keys.length !== length + 1) fail('holes');
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[index];
        if (!descriptor?.enumerable) fail('element');
        target.push(visit(descriptor.value, depth + 1));
      }
      return target;
    }
    const target: Record<string, unknown> = nullPrototype ? Object.create(null) : {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || rejectKeys.includes(key)) fail('property');
      text(key, 1);
      put(target, key, visit(descriptor.value, depth + 1));
    }
    return target;
  };
  const enumerable = (value: object, array: boolean, depth: number): unknown => {
    syntax(2);
    if (array) {
      const target: unknown[] = [];
      for (let index = 0; index < (value as unknown[]).length; index++) {
        if (index) syntax(1);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) fail('element');
        target.push(visit(descriptor.value, depth + 1));
      }
      return target;
    }
    const target: Record<string, unknown> = nullPrototype ? Object.create(null) : {};
    let count = 0;
    for (const key in value) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) fail('accessor');
      if (rejectKeys.includes(key)) fail('property');
      text(key, count++ ? 2 : 1);
      put(target, key, visit(descriptor.value, depth + 1));
    }
    return target;
  };
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > maxNodes || depth > maxDepth) fail('structure');
    if (value === null || typeof value === 'boolean') { syntax(value === false ? 5 : 4); return value; }
    if (typeof value === 'string') {
      if (wellFormed && !value.isWellFormed() || rejectNul && value.includes('\0')) fail('text');
      text(value, 0);
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('number');
      syntax(Buffer.byteLength(JSON.stringify(value)));
      return value;
    }
    if (typeof value !== 'object' || !lenient && types.isProxy(value)) fail('value');
    if (visiting.has(value)) fail('cycle');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? !lenient && prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail('prototype');
    if (array && maxItems !== undefined && value.length > maxItems) fail('items');
    visiting.add(value);
    const result = lenient ? enumerable(value, array, depth) : exact(value, array, depth);
    visiting.delete(value);
    return freeze ? Object.freeze(result) : result;
  }
  return visit(input, 0) as T;
}

export type PlainRecordFault = 'shape' | 'fields' | 'descriptor';
/** Hostile tier: a plain non-proxy object whose own properties are exactly the required and allowed optional enumerable data fields. */
export function plainRecord(value: unknown, required: readonly string[], optional: readonly string[], fail: (fault: PlainRecordFault) => never): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('shape');
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>, keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) || required.some(key => !Object.hasOwn(descriptors, key))) fail('fields');
  if (Object.values(descriptors).some(descriptor => !descriptor.enumerable || !('value' in descriptor))) fail('descriptor');
  return value as Record<string, unknown>;
}
/** Post-parse tier: compares own enumerable keys only, for values that cannot hold proxies or accessors (JSON.parse or walker output). */
export function exactKeys(value: object, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

const SHA256 = /^[a-f0-9]{64}$/u;
export function isCanonicalStamp(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export type RecordFault = 'id' | 'integer' | 'sha' | 'stamp' | 'exact' | 'hash';
export interface RecordGuardOptions {
  readonly fail: (fault: RecordFault) => never;
  /** The module's bounded walker; sealed records are normalized through it. */
  readonly json: <T>(value: T) => T;
  readonly idBytes?: number;
}
/** Record field guards bound once to a module's own codes. */
export function recordGuards({ fail, json, idBytes = 256 }: RecordGuardOptions) {
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > idBytes || /[\u0000-\u001f\u007f]/u.test(value)) fail('id');
    return value as string;
  };
  const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER, minimum = 0): number => {
    if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail('integer');
    return value as number;
  };
  const sha = (value: unknown): string => {
    if (typeof value !== 'string' || !SHA256.test(value)) fail('sha');
    return value as string;
  };
  const stamp = (value: unknown): string => {
    if (!isCanonicalStamp(value)) fail('stamp');
    return value as string;
  };
  const exact = (value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, required, optional)) fail('exact');
    return value as Record<string, unknown>;
  };
  const seal = <T extends object>(body: T): T & { readonly sha256: string } => sealRecord(body, json);
  /** Checks the digest format, then the digest; the caller has already bounded the record. */
  const verify = <T extends object>(record: T): T => {
    sha((record as { sha256?: unknown }).sha256);
    return verifySealed(record, () => fail('hash'));
  };
  return Object.freeze({ id, integer, sha, stamp, exact, json, seal, verify });
}

export type NativeSignalFault = 'shape' | 'override';
const SIGNAL_OBSERVATIONS = ['aborted', 'reason', 'throwIfAborted', 'addEventListener', 'removeEventListener'];
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
/** An unmodified native AbortSignal: no proxy, subclass, own accessor or shadowed observation. */
export function assertNativeSignal(value: unknown, fail: (fault: NativeSignalFault) => never): asserts value is AbortSignal {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !(value instanceof AbortSignal) || Object.getPrototypeOf(value) !== AbortSignal.prototype) fail('shape');
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
  if (Reflect.ownKeys(descriptors).some(key => !('value' in descriptors[key]!) || typeof key === 'string' && SIGNAL_OBSERVATIONS.includes(key))) fail('override');
  try { nativeAborted.call(value); } catch { fail('shape'); }
}

/** Longest prefix of whole Unicode scalars within maximum UTF-8 bytes; unpaired surrogates become U+FFFD, as on the wire. */
export function utf8Prefix(value: string, maximum: number): string {
  let bytes = 0;
  let result = '';
  for (const scalar of value) {
    const count = Buffer.byteLength(scalar);
    if (bytes + count > maximum) break;
    result += scalar;
    bytes += count;
  }
  return result.toWellFormed();
}
