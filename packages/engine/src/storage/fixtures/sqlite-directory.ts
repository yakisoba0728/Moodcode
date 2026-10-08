import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { SqliteStore } from "../index.js";

/** Own every connection until all native closes succeed, then remove the fixture. */
export function sqliteFixtureDirectory(t: TestContext, prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix)),
    dbPath = join(directory, "engine.sqlite");
  const databases: DatabaseSync[] = [],
    stores: SqliteStore[] = [];
  let removed = false;
  const cleanup = async () => {
    if (removed) return;
    const failures: unknown[] = [];
    for (const database of [...databases].reverse()) {
      try {
        if (database.isOpen) database.close();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const store of [...stores].reverse()) {
      try {
        await store.closeAsync();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "SQLite fixture connections could not be closed; directory preserved.",
      );
    rmSync(directory, { recursive: true, force: true });
    removed = true;
  };
  t.after(cleanup);
  return {
    directory,
    dbPath,
    openStore(budgets?: ConstructorParameters<typeof SqliteStore>[1]) {
      if (removed)
        throw new Error("SQLite fixture directory was already removed");
      const store = new SqliteStore(dbPath, budgets);
      stores.push(store);
      return store;
    },
    openDatabase() {
      if (removed)
        throw new Error("SQLite fixture directory was already removed");
      const database = new DatabaseSync(dbPath);
      databases.push(database);
      return database;
    },
    cleanup,
  };
}
