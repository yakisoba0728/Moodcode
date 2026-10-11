import { lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EngineError } from '@moodcode/contracts';
import type { SqliteStore } from './storage/index.js';
import type { ChildStorageHostIdentity } from './child-tasks/storage-binding.js';
import { knowledgeHash } from './knowledge/validation.js';

export class EngineLifetime {
  closing = false;
  readonly resources = new AbortController();
  readonly pending = new Set<Promise<unknown>>();

  get signal(): AbortSignal { return this.resources.signal; }

  assertOpen(): void {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
  }

  assertEnabled(enabled: boolean, code: string, message: string): void {
    this.assertOpen();
    if (!enabled) throw new EngineError(code, message);
  }

  /** Runs a Promise-returning operation so a synchronous throw becomes its rejection. */
  rejecting<T>(operation: () => Promise<T>): Promise<T> {
    try { return operation(); } catch (error) { return Promise.reject(error); }
  }

  hostSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.signal]) : this.signal;
  }

  track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    return operation;
  }
}

function physicalIdentity(path: string) {
  const stat = statSync(path, { bigint: true });
  return { path: realpathSync(path), dev: stat.dev.toString(), ino: stat.ino.toString() };
}

export class EngineStorage {
  readonly paths: { artifactDir: string; dbPath?: string };
  readonly identity: ChildStorageHostIdentity;
  readonly executionLockPath: string;
  readonly reviewJournalPath: string;
  /** Native database, lock and journal files with their SQLite sidecars, excluded from workspace observation. */
  readonly nativeFiles: readonly string[];

  constructor(private readonly store: SqliteStore, dbPath: string, artifactDir: string) {
    const canonicalDbPath = dbPath === ':memory:' ? undefined : realpathSync(dbPath);
    this.paths = { artifactDir: realpathSync(artifactDir), ...(canonicalDbPath ? { dbPath: canonicalDbPath } : {}) };
    this.identity = {
      database: canonicalDbPath ? physicalIdentity(canonicalDbPath) : { memory: randomUUID() },
      artifacts: physicalIdentity(this.paths.artifactDir),
    };
    this.executionLockPath = canonicalDbPath === undefined ? resolve(artifactDir, 'effects.sqlite') : `${canonicalDbPath}.effects.sqlite`;
    this.reviewJournalPath = canonicalDbPath === undefined ? resolve(artifactDir, 'review.sqlite') : `${canonicalDbPath}.review.sqlite`;
    this.nativeFiles = [canonicalDbPath, canonicalDbPath ? `${canonicalDbPath}.owner.sqlite` : undefined, this.executionLockPath, canonicalDbPath ? `${canonicalDbPath}.review.sqlite` : undefined].filter((path): path is string => path !== undefined)
      .flatMap(path => [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]);
  }

  private unchanged(): boolean {
    return JSON.stringify({
      database: this.paths.dbPath ? physicalIdentity(this.paths.dbPath) : this.identity.database,
      artifacts: physicalIdentity(this.paths.artifactDir),
    }) === JSON.stringify(this.identity);
  }

  /** Throws unless the database and artifact directory are still the physical files this engine opened. */
  verify(): void {
    try { if (!this.unchanged()) throw new Error('changed'); }
    catch { throw new EngineError('CHILD_STORAGE_HOST_CHANGED', 'Child storage inspection requires the unchanged host storage identity'); }
  }

  /** The unchanged physical storage and canonical workspace root that workspace-bound records are written against. */
  readonly knowledgeBinding = (workspaceId: string) => {
    this.verify();
    for (const storagePath of [this.paths.dbPath, this.paths.artifactDir]) if (storagePath && (lstatSync(storagePath).isSymbolicLink() || realpathSync(storagePath) !== storagePath)) throw new EngineError('KNOWLEDGE_BINDING_MISMATCH', 'Workspace knowledge requires the unchanged physical database and artifact owner');
    const workspace = this.store.getWorkspace(workspaceId), root = lstatSync(workspace.root, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(workspace.root) !== workspace.root) throw new EngineError('KNOWLEDGE_BINDING_MISMATCH', 'Workspace knowledge requires its canonical physical root');
    return { workspaceId, root: workspace.root, rootDevice: root.dev.toString(), rootInode: root.ino.toString(), storageBindingSha256: knowledgeHash(this.identity) };
  };

  /** Binds summary and provider recovery decisions to this storage identity and the workspace roots. */
  bindRecovery(): void {
    const recoveryBinding = (workspaceId: string) => {
      if (!this.unchanged()) throw new EngineError('SUMMARY_RECOVERY_STORAGE_CHANGED', 'Summary recovery storage identity changed during this engine lifetime');
      const workspace = this.store.getWorkspace(workspaceId);
      return createHash('sha256').update(JSON.stringify({ ...this.identity, workspace: { id: workspace.id, root: workspace.root, gitRoot: workspace.gitRoot } })).digest('hex');
    };
    this.store.configureSummaryRecovery(recoveryBinding);
    this.store.configureProviderRecovery(workspaceId => {
      try { return recoveryBinding(workspaceId); }
      catch { throw new EngineError('PROVIDER_RECOVERY_STORAGE_CHANGED', 'Provider recovery storage identity changed during this engine lifetime'); }
    });
  }
}
