import { EngineError } from '@moodcode/contracts';
import type { SqliteStore } from './storage/index.js';
import type { EngineLifetime } from './engine-kernel.js';
import type { LspFactory, LspManager } from './lsp/index.js';
import type { WorkspaceChangeHub, WorkspaceChangeWatch, WorkspaceFileChange } from './workspace/changes.js';

/** Host language server routing, workspace change consumers and the document changes they deliver to language servers. */
export class WorkspaceLanguageSync {
  private readonly consumers = new Map<string, { seq: number; running: boolean; done: Promise<void> }>();
  private readonly servers = new Map<string, (path: string) => string | null>();
  private readonly revisions = new Map<string, string>();
  private readonly lspChanges = new Map<string, { version: number; done: Promise<void> }>();
  private readonly failures = new Map<string, string>();

  constructor(private readonly store: SqliteStore, private readonly lsp: LspManager, private readonly changes: WorkspaceChangeHub, private readonly lifetime: EngineLifetime) {}

  register(serverId: string, factory: LspFactory, languageForPath: (path: string) => string | null, revision: string): void {
    this.lifetime.assertOpen();
    if (typeof languageForPath !== 'function') throw new EngineError('INVALID_LSP_CONFIG', 'Host must explicitly select supported language paths');
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(revision)) throw new EngineError('INVALID_LSP_CONFIG', 'Host language server revision must be bounded');
    this.lsp.register(serverId, factory); this.servers.set(serverId, languageForPath); this.revisions.set(serverId, revision);
  }

  /** The one host server that supports a path, or null when none does. */
  route(path: string): { serverId: string; languageId: string; revision: string } | null {
    const matches = [...this.servers].map(([serverId, select]) => ({ serverId, languageId: select(path), revision: this.revisions.get(serverId)! })).filter(item => item.languageId !== null);
    if (matches.length > 1) throw new EngineError('REPOSITORY_SERVER_AMBIGUOUS', 'More than one host server supports this path; narrow the host language routing');
    return matches[0] as { serverId: string; languageId: string; revision: string } | undefined ?? null;
  }

  observation(workspaceId: string): { failure: string | null; active: boolean } {
    return { failure: this.failures.get(workspaceId) ?? null, active: this.consumers.get(workspaceId)?.running === true };
  }

  async watch(workspaceId: string): Promise<WorkspaceChangeWatch> {
    this.lifetime.assertOpen();
    const workspace = this.store.getWorkspace(workspaceId), watch = await this.changes.watch(workspace, { signal: this.lifetime.signal });
    const consumer = this.consumers.get(workspaceId) ?? { seq: 0, running: false, done: Promise.resolve() };
    if (!consumer.running) {
      this.consumers.set(workspaceId, consumer);
      consumer.running = true;
      consumer.done = this.consume(workspaceId, consumer);
    }
    return watch;
  }

  /** The completion of every change consumer, awaited by close. */
  consumersDone(): Promise<void>[] { return [...this.consumers.values()].map(consumer => consumer.done); }

  /** A failed consumer restarts on the next watch after its last processed event, or at the head when that replay no longer fits. */
  private async consume(workspaceId: string, consumer: { seq: number; running: boolean }): Promise<void> {
    try {
      const from = this.changes.resumeCursor(workspaceId, consumer.seq);
      if (from !== consumer.seq && !this.failures.has(workspaceId)) this.failures.set(workspaceId, 'WORKSPACE_CHANGE_CURSOR_EXPIRED');
      consumer.seq = from;
      for await (const event of this.changes.subscribe(workspaceId, from, this.lifetime.signal)) {
        if (event.type === 'change') await this.sync(event.change);
        else if (event.type === 'incomplete') this.failures.set(workspaceId, event.code);
        consumer.seq = event.seq;
      }
    } catch (error) { if (!this.lifetime.signal.aborted) this.failures.set(workspaceId, error instanceof EngineError ? error.code : 'WORKSPACE_OBSERVATION_FAILED'); }
    finally { consumer.running = false; }
  }

  sync(change: WorkspaceFileChange): Promise<void> {
    const workspace = this.store.getWorkspace(change.workspaceId);
    return Promise.all([...this.servers].map(async ([serverId, selectLanguage]) => {
      const language = selectLanguage(change.path); if (!language) return;
      const key = JSON.stringify([workspace.id, serverId, change.path]), known = this.lspChanges.get(key);
      if (known && known.version >= change.documentVersion) return known.done;
      const done = this.lsp.fileChanged(workspace, serverId, change.path, language, change.kind, this.lifetime.signal).catch(error => {
        this.failures.set(workspace.id, error instanceof EngineError ? error.code : 'LSP_UPDATE_FAILED');
        if (this.lspChanges.get(key)?.done === done) this.lspChanges.delete(key);
      });
      this.lspChanges.set(key, { version: change.documentVersion, done });
      if (this.lspChanges.size > 256) this.lspChanges.delete(this.lspChanges.keys().next().value!);
      return done;
    })).then(() => {});
  }
}
