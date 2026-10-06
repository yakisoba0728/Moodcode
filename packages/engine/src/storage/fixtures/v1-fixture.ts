import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { V1_DATABASE_FIXTURE } from './v1-database.js';

interface FrozenDatabase {
  readonly version: number;
  readonly applicationId: number;
  readonly schema: readonly { readonly sql: string }[];
  readonly tables: readonly { readonly name: string; readonly rows: readonly Record<string, SQLInputValue>[] }[];
}

function rebase(value: unknown, root: string): unknown {
  if (value === V1_DATABASE_FIXTURE.rootPlaceholder) return root;
  if (Array.isArray(value)) return value.map(item => rebase(item, root));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebase(item, root)]));
  }
  return value;
}

/** Restore frozen SQL/rows without calling the current schema, store, or review writer. */
export function restoreFrozenDatabase(path: string, fixture: FrozenDatabase, root?: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const item of fixture.schema) db.exec(item.sql);
    for (const table of fixture.tables) {
      for (const row of table.rows) {
        const columns = Object.keys(row);
        const values = columns.map(column => {
          const value = row[column]!;
          if (root && column === 'data' && typeof value === 'string') return JSON.stringify(rebase(JSON.parse(value), root));
          if (root && value === V1_DATABASE_FIXTURE.rootPlaceholder) return root;
          return value;
        });
        db.prepare(`INSERT INTO "${table.name}" (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values);
      }
    }
    db.exec(`PRAGMA user_version=${fixture.version}; PRAGMA application_id=${fixture.applicationId}; COMMIT`);
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}

export function restoreV1Fixture(primaryPath: string, root: string): void {
  restoreFrozenDatabase(primaryPath, V1_DATABASE_FIXTURE.primary, root);
  restoreFrozenDatabase(primaryPath + '.review.sqlite', V1_DATABASE_FIXTURE.review);
  restoreFrozenDatabase(primaryPath + '.recovery.sqlite', V1_DATABASE_FIXTURE.ledger);
}

/** Compare durable columns, ordinals, JSON strings, constraints and indexes without API projection. */
export function databaseContents(db: DatabaseSync) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY rowid").all();
  return {
    version: db.prepare('PRAGMA user_version').get()?.user_version,
    applicationId: db.prepare('PRAGMA application_id').get()?.application_id,
    schema,
    tables: schema.filter(row => row.type === 'table').map(row => ({
      name: row.name, rows: db.prepare(`SELECT * FROM "${String(row.name)}" ORDER BY rowid`).all(),
    })),
  };
}
