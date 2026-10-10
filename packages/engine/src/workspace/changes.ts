import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { EngineError, type Checkpoint, type Workspace } from '@moodcode/contracts';
import { exactPath, readExactText } from '../tools/file-actions/text.js';
import { WorkspaceObserver, type WorkspaceObservation, type WorkspaceObserverOptions } from './observer.js';

export interface WorkspaceToolChangeOwner { sessionId: string; runId: string; toolCallId: string; turnId?: string; attemptId?: string; checkpointId: string }
export interface WorkspaceFileChange {
  changeId: string; workspaceId: string; path: string; documentVersion: number;
  kind: 'created' | 'changed' | 'deleted'; beforeHash: string | null; afterHash: string | null;
  observedAt: string; sources: ('external' | 'tool')[]; toolOwners: WorkspaceToolChangeOwner[];
}
export type WorkspaceChangeEvent = { type: 'change'; seq: number; change: WorkspaceFileChange }
  | { type: 'attribution'; seq: number; change: WorkspaceFileChange }
  | { type: 'incomplete'; seq: number; workspaceId: string; code: string };
export interface WorkspaceDocumentState { path: string; documentVersion: number; hash: string | null; bytes: number; changeId?: string }
export interface WorkspaceChangeWatch { workspaceId: string; close(): Promise<void> }
export interface WorkspaceCheckpointChanges { workspace: Workspace; sessionId: string; runId: string; toolCallId: string; turnId?: string; attemptId?: string; checkpoints: readonly Checkpoint[]; signal?: AbortSignal }
export interface WorkspaceChangeHubOptions { observer?: Omit<WorkspaceObserverOptions, 'signal'>; signal?: AbortSignal; limits?: Partial<Limits> }
export const WORKSPACE_CHANGE_LIMITS = Object.freeze({ maxWorkspaces: 8, maxDocuments: 4096, maxCheckpointFiles: 128, maxCheckpointBytes: 8_388_608, maxPending: 64, maxSubscribers: 16, historyEvents: 1024, historyBytes: 262_144, subscriberBytes: 65_536, processedCheckpoints: 32 });
type Limits = { -readonly [K in keyof typeof WORKSPACE_CHANGE_LIMITS]: number };
interface Entry {
  workspace: Workspace; observer?: WorkspaceObserver; controller: AbortController; root?: { dev: bigint; ino: bigint };
  signals: Map<AbortSignal, () => void>;
  documents: Map<string, WorkspaceDocumentState>; changes: Map<string, WorkspaceFileChange>;
  processed: Map<string, { fingerprint: string; ids: string[] }>;
  history: { event: WorkspaceChangeEvent; bytes: number }[]; historyBytes: number; seq: number;
  subscribers: Set<ChangeQueue>; pending: number; queue: Promise<void>; worker?: Promise<void>; ready: Promise<void>;
  started: boolean; failed: boolean; closed: boolean; stop?: Promise<void>; lastIncomplete?: string;
}
const clone = <T>(value: T): T => structuredClone(value);
const fail = (code: string, message: string) => new EngineError(code, message);
function check(signal?: AbortSignal): void { if (signal?.aborted) throw fail('ABORTED', 'Workspace change observation was cancelled'); }
function id(value: unknown): string { if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw fail('INVALID_CHANGE_OWNER', 'Workspace change owner requires a bounded identifier'); return value; }
function sha(content: string | null): string | null { return content === null ? null : createHash('sha256').update(content).digest('hex'); }

class ChangeQueue implements AsyncIterableIterator<WorkspaceChangeEvent> {
  private queue: { event: WorkspaceChangeEvent; bytes: number }[] = [];
  private bytes = 0; private stopped = false; private failure?: Error;
  private waiter?: { resolve(value: IteratorResult<WorkspaceChangeEvent>): void; reject(error: Error): void };
  constructor(private readonly maxBytes: number, private readonly release: () => void) {}
  push(event: WorkspaceChangeEvent): void {
    if (this.stopped) return;
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve({ done: false, value: clone(event) }); return; }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (this.bytes + bytes > this.maxBytes) { this.close(fail('WORKSPACE_CHANGE_BACKPRESSURE', 'Workspace change subscriber exceeded its bounded queue')); return; }
    this.queue.push({ event: clone(event), bytes }); this.bytes += bytes;
  }
  close(error?: Error): void {
    if (this.stopped) return;
    this.stopped = true; this.failure = error; this.queue = []; this.bytes = 0; this.release();
    const waiter = this.waiter; this.waiter = undefined;
    if (error) waiter?.reject(error); else waiter?.resolve({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<WorkspaceChangeEvent> { return this; }
  next(): Promise<IteratorResult<WorkspaceChangeEvent>> {
    const item = this.queue.shift(); if (item) { this.bytes -= item.bytes; return Promise.resolve({ done: false, value: item.event }); }
    if (this.stopped) return this.failure ? Promise.reject(this.failure) : Promise.resolve({ done: true, value: undefined });
    if (this.waiter) return Promise.reject(fail('WORKSPACE_CHANGE_CONCURRENT_NEXT', 'Workspace change subscriber allows one pending read'));
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
  async return(): Promise<IteratorResult<WorkspaceChangeEvent>> { this.close(); return { done: true, value: undefined }; }
}

/** One canonical document transition for internal checkpoint and external observation. */
export class WorkspaceChangeHub {
  private readonly entries = new Map<string, Entry>();
  private readonly limits: Limits;
  private readonly options: WorkspaceChangeHubOptions;
  private closing = false; private closePromise?: Promise<void>;
  private readonly abort = () => { void this.close(); };
  constructor(options: WorkspaceChangeHubOptions = {}) {
    this.options = { ...options, ...(options.observer ? { observer: { ...options.observer, ...(options.observer.capture ? { capture: { ...options.observer.capture } } : {}) } } : {}) };
    this.limits = { ...WORKSPACE_CHANGE_LIMITS };
    if (options.limits) for (const key of Object.keys(options.limits)) {
      if (!Object.hasOwn(this.limits, key)) throw fail('INVALID_CHANGE_LIMIT', 'Unknown workspace change limit');
      const selected = options.limits[key as keyof Limits];
      if (!Number.isSafeInteger(selected) || selected! < 1 || selected! > WORKSPACE_CHANGE_LIMITS[key as keyof Limits]) throw fail('INVALID_CHANGE_LIMIT', 'Workspace change limits must be positive integers no larger than host defaults');
      this.limits[key as keyof Limits] = selected!;
    }
    options.signal?.addEventListener('abort', this.abort, { once: true });
    if (options.signal?.aborted) this.closing = true;
  }
  private get(workspaceId: string): Entry {
    const entry = this.entries.get(workspaceId); if (!entry) throw fail('WORKSPACE_NOT_WATCHED', 'Workspace is not registered with the change hub'); return entry;
  }
  async watch(workspace: Workspace, options: { signal?: AbortSignal } = {}): Promise<WorkspaceChangeWatch> {
    check(options.signal); check(this.options.signal);
    if (this.closing) throw fail('ENGINE_CLOSED', 'Workspace change hub is closed');
    id(workspace.id);
    let entry = this.entries.get(workspace.id);
    if (entry) {
      if (entry.workspace.root !== workspace.root || entry.workspace.gitRoot !== workspace.gitRoot) throw fail('WORKSPACE_CHANGE_SCOPE_MISMATCH', 'Workspace watcher identity was reused with another root');
      if (entry.closed) throw fail('WORKSPACE_WATCH_CLOSED', 'A closed workspace watch cannot restart');
      if (entry.failed) this.observe(entry);
    } else {
      if (this.entries.size >= this.limits.maxWorkspaces) throw fail('WORKSPACE_WATCH_LIMIT', 'Workspace watcher capacity was reached');
      entry = { workspace: clone(workspace), controller: new AbortController(), signals: new Map(), documents: new Map(), changes: new Map(), processed: new Map(), history: [], historyBytes: 0, seq: 0,
        subscribers: new Set(), pending: 0, queue: Promise.resolve(), ready: Promise.resolve(), started: false, failed: false, closed: false };
      this.observe(entry);
      this.entries.set(workspace.id, entry);
    }
    const owned = entry, signal = options.signal;
    if (signal && !entry.signals.has(signal)) {
      const abort = () => { void this.stopEntry(owned); };
      entry.signals.set(signal, abort); signal.addEventListener('abort', abort, { once: true });
    }
    if (!entry.started) await entry.ready;
    if (entry.closed || this.closing) throw fail('ABORTED', 'Workspace watch stopped before readiness');
    return { workspaceId: workspace.id, close: () => this.stopEntry(owned) };
  }
  /** A failed observer is replaced on the next watch(); the entry keeps its sequence and document versions. */
  private observe(entry: Entry): void {
    const observer = new WorkspaceObserver(entry.workspace, { intervalMs: 1000, ...this.options.observer, signal: entry.controller.signal,
      capture: { ...this.options.observer?.capture, maxFiles: Math.min(this.options.observer?.capture?.maxFiles ?? this.limits.maxDocuments, this.limits.maxDocuments),
        maxFileBytes: Math.min(this.options.observer?.capture?.maxFileBytes ?? 1_048_576, 1_048_576), maxTotalBytes: Math.min(this.options.observer?.capture?.maxTotalBytes ?? 8_388_608, 8_388_608) } });
    let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); void ready.catch(() => {});
    entry.observer = observer; entry.ready = ready; entry.failed = false;
    entry.worker = (async () => {
      let observed = false;
      try {
        for await (const observation of observer) {
          if (entry.closed) break;
          await this.enqueue(entry, () => this.observation(entry, observation));
          if (!observed) { observed = entry.started = true; resolveReady(); }
        }
        if (!observed) rejectReady(fail('ABORTED', 'Workspace watch stopped before its initial observation'));
      } catch (error) {
        entry.failed = true; rejectReady(error); this.incomplete(entry, 'WORKSPACE_OBSERVER_FAILED');
        for (const subscriber of entry.subscribers) subscriber.close(fail('WORKSPACE_OBSERVER_FAILED', 'Workspace observer could not continue'));
      }
    })();
  }
  private enqueue<T>(entry: Entry, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (entry.closed || this.closing) return Promise.reject(fail('ENGINE_CLOSED', 'Workspace change hub is closed'));
    if (entry.pending >= this.limits.maxPending) return Promise.reject(fail('WORKSPACE_CHANGE_QUEUE_LIMIT', 'Workspace change operations exceeded their queue bound'));
    entry.pending++;
    const pending = entry.queue.then(async () => { check(signal); check(entry.controller.signal); return operation(); });
    entry.queue = pending.then(() => {}, () => {});
    void pending.then(() => entry.pending--, () => entry.pending--); return pending;
  }
  private emit(entry: Entry, event: Omit<Extract<WorkspaceChangeEvent, { change: WorkspaceFileChange }>, 'seq'> | Omit<Extract<WorkspaceChangeEvent, { code: string }>, 'seq'>): boolean {
    if (entry.closed || this.closing) return false;
    const value = { ...event, seq: entry.seq + 1 } as WorkspaceChangeEvent, bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.limits.historyBytes) { this.incomplete(entry, 'WORKSPACE_CHANGE_EVENT_LIMIT'); return false; }
    entry.seq++;
    entry.history.push({ event: clone(value), bytes }); entry.historyBytes += bytes;
    while (entry.history.length > this.limits.historyEvents || entry.historyBytes > this.limits.historyBytes) {
      const removed = entry.history.shift()!; entry.historyBytes -= removed.bytes;
      const removedId = 'change' in removed.event ? removed.event.change.changeId : undefined;
      if (removedId && !entry.history.some(item => 'change' in item.event && item.event.change.changeId === removedId)) entry.changes.delete(removedId);
    }
    for (const subscriber of entry.subscribers) subscriber.push(value);
    return true;
  }
  private incomplete(entry: Entry, code: string): void {
    if (entry.lastIncomplete === code || entry.closed || this.closing) return;
    entry.lastIncomplete = code; this.emit(entry, { type: 'incomplete', workspaceId: entry.workspace.id, code });
  }
  private async current(entry: Entry, path: string): Promise<{ hash: string | null; bytes: number } | undefined> {
    try {
      const root = await lstat(entry.workspace.root, { bigint: true });
      if (!root.isDirectory() || root.isSymbolicLink() || await realpath(entry.workspace.root) !== entry.workspace.root || entry.root && (root.dev !== entry.root.dev || root.ino !== entry.root.ino)) throw fail('WORKSPACE_ROOT_CHANGED', 'Workspace root identity changed');
      entry.root ??= { dev: root.dev, ino: root.ino };
    } catch { this.incomplete(entry, 'WORKSPACE_ROOT_CHANGED'); return undefined; }
    try { const observed = await readExactText(entry.workspace, path, entry.controller.signal); return { hash: observed.hash, bytes: Buffer.byteLength(observed.content) }; }
    catch (error) {
      check(entry.controller.signal);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { hash: null, bytes: 0 };
      this.incomplete(entry, 'WORKSPACE_FILE_UNOBSERVED'); return undefined;
    }
  }
  private change(entry: Entry, path: string, beforeHash: string | null, observed: { hash: string | null; bytes: number }, source: 'external' | 'tool', owner?: WorkspaceToolChangeOwner): WorkspaceFileChange | undefined {
    const prior = entry.documents.get(path);
    if (!prior && entry.documents.size >= this.limits.maxDocuments) { this.incomplete(entry, 'WORKSPACE_DOCUMENT_LIMIT'); return undefined; }
    if (beforeHash === observed.hash) return undefined;
    const value: WorkspaceFileChange = { changeId: randomUUID(), workspaceId: entry.workspace.id, path, documentVersion: (prior?.documentVersion ?? 0) + 1,
      kind: observed.hash === null ? 'deleted' : beforeHash === null ? 'created' : 'changed', beforeHash, afterHash: observed.hash,
      observedAt: new Date().toISOString(), sources: [source], toolOwners: owner ? [clone(owner)] : [] };
    entry.documents.set(path, { path, documentVersion: value.documentVersion, hash: observed.hash, bytes: observed.bytes, changeId: value.changeId });
    entry.changes.set(value.changeId, value);
    if (!this.emit(entry, { type: 'change', change: value })) entry.changes.delete(value.changeId);
    return value;
  }
  private async observation(entry: Entry, sample: WorkspaceObservation): Promise<void> {
    if (sample.workspaceId !== entry.workspace.id) throw fail('WORKSPACE_CHANGE_SCOPE_MISMATCH', 'Workspace observation belongs to another owner');
    if (sample.incomplete) this.incomplete(entry, 'WORKSPACE_OBSERVATION_INCOMPLETE');
    // A restarted observer's initial sample also reconciles documents changed or deleted while it was down.
    const paths = sample.type === 'change' ? [...new Set(sample.changes.map(change => change.path))] : [...new Set([...sample.files.keys(), ...entry.documents.keys()])];
    for (const candidate of paths.slice(0, this.limits.maxDocuments)) {
      check(entry.controller.signal);
      let path: string; try { path = exactPath(candidate); } catch { this.incomplete(entry, 'WORKSPACE_FILE_UNOBSERVED'); continue; }
      const observed = await this.current(entry, path); if (!observed) continue;
      const prior = entry.documents.get(path);
      if (!entry.started && !prior) {
        if (entry.documents.size >= this.limits.maxDocuments) { this.incomplete(entry, 'WORKSPACE_DOCUMENT_LIMIT'); break; }
        entry.documents.set(path, { path, documentVersion: 1, ...observed }); continue;
      }
      // The delayed sample may describe an older state. Current disk hash is
      // authoritative, so a matching internal transition emits no duplicate.
      if (prior?.hash === observed.hash) continue;
      this.change(entry, path, prior?.hash ?? null, observed, 'external');
    }
    if (paths.length > this.limits.maxDocuments) this.incomplete(entry, 'WORKSPACE_DOCUMENT_LIMIT');
  }
  async recordCheckpoint(request: WorkspaceCheckpointChanges): Promise<WorkspaceFileChange[]> {
    check(request.signal);
    if (this.closing) throw fail('ENGINE_CLOSED', 'Workspace change hub is closed');
    const owner = { sessionId: id(request.sessionId), runId: id(request.runId), toolCallId: id(request.toolCallId), ...(request.turnId ? { turnId: id(request.turnId) } : {}), ...(request.attemptId ? { attemptId: id(request.attemptId) } : {}) };
    if (owner.attemptId && !owner.turnId) throw fail('INVALID_CHANGE_OWNER', 'Attempt ownership requires a turn');
    if (!Array.isArray(request.checkpoints) || request.checkpoints.length > 32) throw fail('WORKSPACE_CHANGE_LIMIT', 'Checkpoint batch exceeds its count bound');
    let fileCount = 0, bytes = 0;
    const checkpoints = request.checkpoints.map((checkpoint: Checkpoint) => {
      if (checkpoint.runId !== owner.runId || checkpoint.toolCallId !== owner.toolCallId || !Array.isArray(checkpoint.files)) throw fail('CHECKPOINT_CHANGE_OWNER_MISMATCH', 'Checkpoint is not owned by the stated tool execution');
      const checkpointId = id(checkpoint.id), seen = new Set<string>();
      const files = checkpoint.files.map(file => {
        const path = exactPath(file.path); if (seen.has(path)) throw fail('INVALID_CHANGE_CHECKPOINT', 'Checkpoint contains duplicate file paths'); seen.add(path);
        if (++fileCount > this.limits.maxCheckpointFiles || ![file.before, file.after].every(content => content === null || typeof content === 'string')) throw fail('WORKSPACE_CHANGE_LIMIT', 'Checkpoint files exceed their count or content bound');
        bytes += Buffer.byteLength(file.before ?? '') + Buffer.byteLength(file.after ?? '');
        if (bytes > this.limits.maxCheckpointBytes) throw fail('WORKSPACE_CHANGE_LIMIT', 'Checkpoint content exceeds its byte bound');
        if (sha(file.before) !== file.beforeHash || sha(file.after) !== file.afterHash) throw fail('INVALID_CHANGE_CHECKPOINT', 'Checkpoint content and hashes disagree');
        return { path, beforeHash: file.beforeHash, afterHash: file.afterHash };
      });
      return { checkpointId, files };
    });
    await this.watch(request.workspace);
    const entry = this.get(request.workspace.id);
    return this.enqueue(entry, async () => {
      const result: WorkspaceFileChange[] = [];
      for (const checkpoint of checkpoints) {
        check(request.signal); check(entry.controller.signal);
        const bound = { ...owner, checkpointId: checkpoint.checkpointId }, fingerprint = createHash('sha256').update(JSON.stringify([bound, checkpoint.files])).digest('hex');
        const processed = entry.processed.get(checkpoint.checkpointId);
        if (processed) {
          if (processed.fingerprint !== fingerprint) throw fail('CHECKPOINT_CHANGE_CONFLICT', 'A checkpoint identity cannot be rebound to different changes');
          for (const changeId of processed.ids) { const retained = entry.changes.get(changeId); if (retained) result.push(clone(retained)); }
          continue;
        }
        const ids: string[] = [];
        for (const file of checkpoint.files) {
          check(request.signal); check(entry.controller.signal);
          const observed = await this.current(entry, file.path); if (!observed) continue;
          const matching = [...entry.changes.values()].findLast(change => change.path === file.path && change.beforeHash === file.beforeHash && change.afterHash === file.afterHash);
          if (matching) {
            if (!matching.toolOwners.some(known => JSON.stringify(known) === JSON.stringify(bound))) {
              if (matching.toolOwners.length >= 32) { this.incomplete(entry, 'WORKSPACE_CHANGE_OWNER_LIMIT'); continue; }
              matching.toolOwners.push(clone(bound)); if (!matching.sources.includes('tool')) matching.sources.push('tool');
              this.emit(entry, { type: 'attribution', change: matching });
            }
            ids.push(matching.changeId); result.push(clone(matching));
          } else if (observed.hash === file.afterHash && file.beforeHash !== file.afterHash) {
            const prior = entry.documents.get(file.path);
            if (prior?.changeId && prior.hash !== file.beforeHash) {
              // An already observed transition with another before-hash cannot
              // be rewritten or reported twice on the strength of an old patch.
              this.incomplete(entry, 'CHECKPOINT_CHANGE_TRANSITION_MISMATCH');
              if (prior.hash !== observed.hash) this.change(entry, file.path, prior.hash, observed, 'external');
            } else {
              const canonical = this.change(entry, file.path, file.beforeHash, observed, 'tool', bound);
              if (canonical) { ids.push(canonical.changeId); result.push(clone(canonical)); }
            }
          } else if (observed.hash !== file.afterHash) {
            this.incomplete(entry, 'CHECKPOINT_CHANGE_SUPERSEDED');
            const prior = entry.documents.get(file.path);
            if (prior?.hash !== observed.hash) this.change(entry, file.path, prior?.hash ?? null, observed, 'external');
          }
        }
        entry.processed.set(checkpoint.checkpointId, { fingerprint, ids });
        if (entry.processed.size > this.limits.processedCheckpoints) entry.processed.delete(entry.processed.keys().next().value!);
      }
      return result;
    }, request.signal);
  }
  getDocument(workspaceId: string, path: string): WorkspaceDocumentState | null { const document = this.get(workspaceId).documents.get(exactPath(path)); return document ? clone(document) : null; }
  replay(workspaceId: string, afterSeq = 0, limit = Math.min(100, this.limits.historyEvents)): WorkspaceChangeEvent[] {
    const entry = this.get(workspaceId);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > entry.seq || !Number.isSafeInteger(limit) || limit < 1 || limit > this.limits.historyEvents) throw fail('INVALID_WORKSPACE_CHANGE_CURSOR', 'Workspace change cursor or page size is invalid');
    if (afterSeq < (entry.history[0]?.event.seq ?? entry.seq + 1) - 1) throw fail('WORKSPACE_CHANGE_CURSOR_EXPIRED', 'Workspace change history no longer retains this cursor');
    return entry.history.filter(item => item.event.seq > afterSeq).slice(0, limit).map(item => clone(item.event));
  }
  /** A restarted subscriber's cursor: afterSeq while its retained replay fits one subscriber queue, otherwise the current head. */
  resumeCursor(workspaceId: string, afterSeq: number): number {
    const entry = this.get(workspaceId);
    if (afterSeq < (entry.history[0]?.event.seq ?? entry.seq + 1) - 1) return entry.seq;
    let bytes = 0;
    for (const item of entry.history) if (item.event.seq > afterSeq && (bytes += item.bytes) > this.limits.subscriberBytes) return entry.seq;
    return afterSeq;
  }
  subscribe(workspaceId: string, afterSeq = 0, signal?: AbortSignal): AsyncIterableIterator<WorkspaceChangeEvent> {
    const entry = this.get(workspaceId);
    if (entry.closed || this.closing) throw fail('ENGINE_CLOSED', 'Workspace change hub is closed');
    if (entry.subscribers.size >= this.limits.maxSubscribers) throw fail('WORKSPACE_CHANGE_SUBSCRIBER_LIMIT', 'Workspace change subscriber capacity was reached');
    const replay = this.replay(workspaceId, afterSeq, this.limits.historyEvents);
    const abort = () => queue.close(); const queue = new ChangeQueue(this.limits.subscriberBytes, () => { entry.subscribers.delete(queue); signal?.removeEventListener('abort', abort); });
    entry.subscribers.add(queue);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else for (const event of replay) queue.push(event);
    return queue;
  }
  private stopEntry(entry: Entry): Promise<void> {
    if (entry.stop) return entry.stop;
    entry.closed = true; entry.controller.abort();
    for (const [signal, abort] of entry.signals) signal.removeEventListener('abort', abort);
    entry.signals.clear();
    for (const subscriber of entry.subscribers) subscriber.close();
    entry.stop = (async () => { await entry.observer?.stop(); await entry.worker; await entry.queue; })(); return entry.stop;
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true; this.options.signal?.removeEventListener('abort', this.abort);
    this.closePromise = (async () => { await Promise.allSettled([...this.entries.values()].map(entry => this.stopEntry(entry))); this.entries.clear(); })(); return this.closePromise;
  }
}
