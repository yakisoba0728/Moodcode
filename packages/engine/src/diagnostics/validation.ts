import { types } from 'node:util';

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
