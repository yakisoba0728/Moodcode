import { parseJsonOr, plainJson, plainRecord, recordGuards } from '../shared/data.js';

export interface ProposalCheckOptions {
  /** The module's error; called without a code for its default invalid-input code. */
  readonly fail: (code?: string) => never;
  readonly limitCode: string;
  readonly hashCode: string;
  /** A stored row whose data is not JSON. */
  readonly rowCode: string;
  readonly maxBytes: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxItems: number;
}
/** Record guards, a bounded frozen JSON copy and stored-row decoding bound to one proposal module's codes and limits. */
export function proposalChecks({ fail, limitCode, hashCode, rowCode, maxBytes: rowBytes, maxNodes, maxDepth, maxItems }: ProposalCheckOptions) {
  const json = <T>(input: T, maxBytes = rowBytes): T => {
    const result = plainJson(input, {
      maxBytes, maxNodes, maxDepth, maxItems, accounting: 'text', wellFormed: true, rejectKeys: ['__proto__'], freeze: true,
      fail: fault => fail(fault === 'structure' || fault === 'bytes' || fault === 'text' ? limitCode : undefined),
    });
    if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail(limitCode);
    return result;
  };
  const decoded = (data: unknown, maxBytes: number): unknown => {
    if (typeof data !== 'string' || Buffer.byteLength(data) > maxBytes) fail(limitCode);
    return parseJsonOr(data as string, () => fail(rowCode));
  };
  return Object.freeze({ ...recordGuards({ json, fail: fault => fail(fault === 'hash' ? hashCode : undefined) }), json, decoded });
}

/** Own data fields of a plain host record as prototype-free descriptors, so an absent optional field reads undefined. */
export function ownDataFields(value: unknown, required: readonly string[], optional: readonly string[], fail: () => never): Record<string, PropertyDescriptor> {
  return Object.setPrototypeOf(Object.getOwnPropertyDescriptors(plainRecord(value, required, optional, fail)), null);
}

/** A port called inside a transaction must finish before it returns. */
export function assertNotThenable(value: unknown, fail: () => never): void {
  if (value && typeof value === 'object' && 'then' in value) fail();
}

/** Holds a task in its owner's close set until it settles. */
export function trackPending<T>(pending: Set<Promise<unknown>>, task: Promise<T>): Promise<T> {
  const settled = (): void => { pending.delete(task); };
  pending.add(task);
  void task.then(settled, settled);
  return task;
}
