import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EngineChildRequest } from '../child-tasks/engine-host.js';
import type { ProviderRecoveryRequest } from '../recovery/provider-contract.js';
import type { SqliteStore } from '../storage/index.js';

// These are deliberately authored fixture observations, not engine/public APIs.
export const CHILD_STORAGE_CRASH_PHASES = ['root-prepared', 'child-run-admitted', 'root-admitted', 'partial-observed', 'child-terminal', 'root-close-proof', 'task-outcome'] as const;
export type ChildStorageCrashPhase = typeof CHILD_STORAGE_CRASH_PHASES[number];
export const CRASH_TABLES = ['workspaces', 'sessions', 'runs', 'inputs', 'messages', 'tools', 'approvals', 'checkpoints', 'events',
  'session_sequences', 'session_controls', 'session_inputs', 'session_turns', 'provider_attempts', 'message_parts', 'context_revisions', 'session_documents', 'session_events',
  'attempt_cleanup', 'attempt_usage', 'summary_attempts', 'summary_usage', 'summary_recovery_acknowledgments', 'provider_recovery_acknowledgments'] as const;
export type CrashRow = Record<string, string | number | null>;
export type CrashSnapshot = Record<typeof CRASH_TABLES[number], CrashRow[]>;
export interface ChildStorageCrashReady {
  phase: ChildStorageCrashPhase;
  sessionId: string;
  parentRunId: string;
  taskId: string;
  worktreeId: string;
  childDbPath: string;
  childSessionId: string;
  childRunId?: string;
  childClosed: boolean;
  request: EngineChildRequest;
  historicalDecision: ProviderRecoveryRequest;
  root: CrashSnapshot;
  child: CrashSnapshot;
}
export function fixtureDatabase(store: SqliteStore): DatabaseSync {
  // Reading the fixture's already-owned handle avoids opening another SQLite
  // connection to the live original and changing its filesystem sidecars.
  const db: unknown = Reflect.get(store, 'db');
  if (!(db instanceof DatabaseSync)) throw new Error('Fixture SQLite handle is unavailable');
  return db;
}
export function fixtureSnapshot(db: DatabaseSync): CrashSnapshot {
  return Object.fromEntries(CRASH_TABLES.map(table => {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT 257`).all();
    if (rows.length > 256) throw new Error('Authored crash fixture exceeded its row bound');
    // IPC JSON restores ordinary objects; keep column values/raw data exactly
    // while making the SQLite row prototype consistent across that boundary.
    return [table, rows.map(row => ({ ...row }))];
  })) as CrashSnapshot;
}
/** Read a stopped fixture copy, including its existing WAL, without SQLite-opening the original. */
export function stoppedFixtureSnapshot(path: string, privateDirectory: string): CrashSnapshot {
  mkdirSync(privateDirectory, { recursive: true });
  const copy = join(privateDirectory, 'engine.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) if (existsSync(path + suffix)) copyFileSync(path + suffix, copy + suffix);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(copy, { readOnly: true });
    db.exec('PRAGMA query_only=ON; BEGIN');
    return fixtureSnapshot(db);
  } finally { db?.close(); rmSync(privateDirectory, { recursive: true, force: true }); }
}
export function rowData<T = Record<string, unknown>>(row: CrashRow): T { return JSON.parse(String(row.data)) as T; }
