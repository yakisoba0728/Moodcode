import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export interface WriteTransactionPort { writeTx<T>(operation: () => T): T }
export interface GuardedWriteOptions {
  /** Run inline when the caller already holds a transaction instead of asking the host for one. */
  join: boolean;
  /** Also reject a thenable returned inside the host callback. */
  innerAsyncCheck: boolean;
  isThenable?: (value: unknown) => boolean;
  /** The callback was entered twice or outside a transaction. */
  required: () => never;
  /** The host did not run the callback exactly once or returned a thenable; defaults to required. */
  detached?: () => never;
  /** The operation returned a thenable inside the callback; defaults to required. */
  async?: () => never;
}
export interface CasReplace {
  table: string;
  /** Row identity, matched first and in order. */
  key: Readonly<Record<string, SQLInputValue>>;
  /** Columns written before data, in order. */
  set: Readonly<Record<string, SQLInputValue>>;
  /** Columns the row must still hold, matched after the key. */
  fence: Readonly<Record<string, SQLInputValue>>;
  /** When given, the stored data must still be exactly JSON.stringify(previous). */
  previous?: object;
}

const CAS_TABLES = new Set([
  'knowledge_generations', 'knowledge_generation_attempts', 'knowledge_generation_workspace_barriers', 'knowledge_publications', 'workspace_document_heads',
  'knowledge_file_heads', 'knowledge_file_publications', 'knowledge_import_frontier_heads', 'knowledge_import_document_activation_heads',
  'diagnostic_effect_epochs', 'diagnostic_execution_observations', 'proposal_apply_owners', 'proposal_heads',
]);
const COLUMN = /^[a-z][a-z0-9_]{0,63}$/u;
function hasThen(value: unknown): boolean { return !!value && typeof value === 'object' && 'then' in value; }

/** Enter the host write transaction exactly once, and never across an await. */
export function guardedWrite<T>(db: DatabaseSync, port: WriteTransactionPort, operation: () => T, options: GuardedWriteOptions): T {
  if (options.join && db.isTransaction) return operation();
  const thenable = options.isThenable ?? hasThen;
  let entries = 0;
  const result = port.writeTx(() => {
    if (++entries !== 1 || !db.isTransaction) options.required();
    const value = operation();
    if (options.innerAsyncCheck && thenable(value)) (options.async ?? options.required)();
    return value;
  });
  if (entries !== 1 || thenable(result)) (options.detached ?? options.required)();
  return result;
}

export function assertInTransaction(db: DatabaseSync, fail: () => never): void {
  if (!db.isTransaction) fail();
}

/** Write JSON.stringify(next) only while key and fence still match one row; anything else is stale. */
export function casReplace(db: DatabaseSync, update: CasReplace, next: object, stale: () => never): void {
  const set = [...Object.entries(update.set), ['data', JSON.stringify(next)] as const];
  const where = [...Object.entries(update.key), ...Object.entries(update.fence), ...(update.previous === undefined ? [] : [['data', JSON.stringify(update.previous)] as const])];
  const columns = [...Object.keys(update.set), ...Object.keys(update.key), ...Object.keys(update.fence)];
  if (!CAS_TABLES.has(update.table) || !Object.keys(update.key).length || columns.some(column => column === 'data' || !COLUMN.test(column)))
    throw new TypeError('CAS replace requires a known table, a key and plain column names');
  const result = db.prepare(`UPDATE ${update.table} SET ${set.map(([column]) => `${column}=?`).join(',')} WHERE ${where.map(([column]) => `${column}=?`).join(' AND ')}`)
    .run(...set.map(([, value]) => value), ...where.map(([, value]) => value));
  if (result.changes !== 1) stale();
}
