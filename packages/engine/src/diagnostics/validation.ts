import { types } from 'node:util';
import { plainRecord } from '../shared/data.js';

/** An own data property's value; a primitive, proxy, accessor or missing key reads as undefined without running a getter or trap. */
export function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

/** The elements of a plain dense array of at most max enumerable data elements and no extra properties. */
export function denseValues(value: unknown, max: number, reject: () => never): unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) reject();
  const output: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject();
    output.push(descriptor.value);
  }
  return output;
}

export function isChildTaskId(value: unknown): value is string { return typeof value === 'string' && /^child_[a-f0-9]{32}$/u.test(value); }

/** Distinct child task ids from a plain dense array of at most max. */
export function childTaskIds(value: unknown, max: number, reject: () => never): string[] {
  const seen = new Set<string>(), selected: string[] = [];
  for (const id of denseValues(value, max, reject)) { if (!isChildTaskId(id) || seen.has(id)) reject(); seen.add(id); selected.push(id); }
  return selected;
}

/** Frozen defaults overridden by a plain record of their keys; each value is a safe integer from 1 to its default unless bounds overrides either end. */
export function boundedLimits<T extends { [K in keyof T]: number }>(value: unknown, defaults: Readonly<T>, bounds: { readonly [K in keyof T]?: { min?: number; max?: number } }, reject: () => never): Readonly<T> {
  const selected: T = { ...defaults, ...(value === undefined ? {} : plainRecord(value, [], Object.keys(defaults), reject)) };
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const { min = 1, max = defaults[key] } = bounds[key] ?? {};
    if (!Number.isSafeInteger(selected[key]) || selected[key] < min || selected[key] > max) reject();
  }
  return Object.freeze(selected);
}

/** A native AbortSignal, checked through its brand without running a caller's shadowed getter or proxy trap. */
export function nativeAbortSignal(value: unknown, reject: () => never): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (types.isProxy(value) || !value || typeof value !== 'object' || Object.getPrototypeOf(value) !== AbortSignal.prototype) reject();
  if (Reflect.ownKeys(value).some(key => ['aborted', 'reason', 'throwIfAborted'].includes(String(key)) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) reject();
  const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
  try { if (!aborted || typeof aborted.call(value) !== 'boolean') reject(); } catch { reject(); }
  return value as AbortSignal;
}
