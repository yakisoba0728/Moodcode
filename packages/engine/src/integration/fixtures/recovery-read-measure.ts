import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface RecoveryReadMeasurement {
  queries: number;
  returnedSqlBytes: number;
  returnedBodyBytes: number;
  uniqueBodyBytes: number;
  writeStatements: number;
  changedRows: number;
  bodyReads: Record<string, number>;
  bodyBytes: Record<string, number>;
}

/** SQL values crossing into JavaScript; neither SQLite page visits nor disk I/O. */
export function measureRecoveryRead<T>(db: DatabaseSync, operation: () => T): { result: T; measurement: RecoveryReadMeasurement } {
  const originalPrepare = db.prepare, originalExec = db.exec;
  const changed = () => Number(originalPrepare.call(db, 'SELECT total_changes() AS changes').get()!.changes);
  const before = changed(), seen = new Set<string>();
  const measurement: RecoveryReadMeasurement = { queries: 0, returnedSqlBytes: 0, returnedBodyBytes: 0, uniqueBodyBytes: 0, writeStatements: 0, changedRows: 0, bodyReads: {}, bodyBytes: {} };
  db.prepare = ((sql: string) => {
    const statement = originalPrepare.call(db, sql);
    for (const method of ['get', 'all'] as const) {
      const original = statement[method].bind(statement);
      Object.defineProperty(statement, method, { configurable: true, writable: true, value: (...args: unknown[]) => {
        const result: unknown = Reflect.apply(original, undefined, args); measurement.queries++;
        if (result !== undefined) measurement.returnedSqlBytes += Buffer.byteLength(JSON.stringify(result));
        const table = /\bFROM\s+([a-z_]+)/iu.exec(sql)?.[1];
        const projection = /json_remove\s*\(/iu.test(sql) ? 'metadata' : /json_object\s*\(/iu.test(sql) ? 'context-owner' : 'full';
        for (const row of Array.isArray(result) ? result : result ? [result] : []) {
          if (!table || !row || typeof row !== 'object' || typeof (row as { data?: unknown }).data !== 'string') continue;
          const data = (row as { data: string }).data;
          let identity: unknown = table === 'session_documents' ? `${String(args[0])}/${String(args[1])}` : args[0];
          try { const value = JSON.parse(data) as { id?: unknown; attemptId?: unknown; eventId?: unknown }; identity = value.id ?? value.attemptId ?? value.eventId ?? identity; } catch { /* Malformed data remains measurable. */ }
          const key = `${table}:${String(identity)}:${projection}`;
          measurement.bodyReads[key] = (measurement.bodyReads[key] ?? 0) + 1;
          const bytes = Buffer.byteLength(data), version = `${key}:${createHash('sha256').update(data).digest('hex')}`;
          measurement.bodyBytes[key] = bytes;
          measurement.returnedBodyBytes += bytes;
          if (!seen.has(version)) { seen.add(version); measurement.uniqueBodyBytes += bytes; }
        }
        return result;
      } });
    }
    const originalRun = statement.run.bind(statement);
    statement.run = ((...args: unknown[]) => { measurement.writeStatements++; return Reflect.apply(originalRun, undefined, args); }) as typeof statement.run;
    return statement;
  }) as typeof db.prepare;
  db.exec = ((sql: string) => { if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/iu.test(sql)) measurement.writeStatements++; return originalExec.call(db, sql); }) as typeof db.exec;
  try { return { result: operation(), measurement }; }
  finally { db.prepare = originalPrepare; db.exec = originalExec; measurement.changedRows = changed() - before; }
}
