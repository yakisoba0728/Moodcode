import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { EngineError, type Workspace } from '@moodcode/contracts';
import { captureWorkspace, DEFAULT_CAPTURE_LIMITS, getGitStatus, resolveWorkspacePath, type CaptureWorkspaceOptions, type GitStatus, type GitStatusEntry } from './index.js';

export interface WorkspaceObserverOptions {
  signal?: AbortSignal;
  /** Delay after each completed poll; integer 50..60000, default 1000. */
  intervalMs?: number;
  /** Per Git subprocess timeout; integer 1..60000, default 10000. */
  gitTimeoutMs?: number;
  /** Returned Git entries; integer 1..20000, default 2000. */
  maxGitEntries?: number;
  capture?: Omit<CaptureWorkspaceOptions, 'signal'>;
}

const DEFAULT_WORKSPACE_OBSERVER_OPTIONS = Object.freeze({ intervalMs: 1_000, gitTimeoutMs: 10_000, maxGitEntries: 2_000 });

export interface ObservedWorkspaceFile { hash: string; bytes: number }
export interface ObservedGitStatus extends GitStatus { totalEntries: number; entriesTruncated: boolean }
export interface ObservedWorkspaceChange {
  path: string;
  kind: 'added' | 'modified' | 'removed' | 'observed' | 'unobserved';
  beforeHash: string | null;
  afterHash: string | null;
}
export interface WorkspaceObservation {
  type: 'initial' | 'change';
  workspaceId: string;
  /** Poll sequence; unchanged polls and coalescing can leave gaps. */
  sequence: number;
  observedAt: string;
  files: ReadonlyMap<string, ObservedWorkspaceFile>;
  changes: ObservedWorkspaceChange[];
  git: ObservedGitStatus;
  warnings: string[];
  captureComplete: boolean;
  incomplete: boolean;
  /** Changed pending snapshots replaced by this latest snapshot. */
  coalesced: number;
}
export type WorkspaceObserverState = 'idle' | 'running' | 'stopping' | 'stopped' | 'failed';

interface Sample {
  sequence: number;
  observedAt: string;
  files: Map<string, ObservedWorkspaceFile>;
  git: ObservedGitStatus;
  warnings: string[];
  captureComplete: boolean;
  fingerprint: string;
  coalesced: number;
}

function integer(value: number | undefined, fallback: number, name: string, minimum: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new EngineError('INVALID_LIMIT', `${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return selected;
}

function compareEntries(left: GitStatusEntry, right: GitStatusEntry): number {
  const a = JSON.stringify([left.path, left.index, left.worktree, left.originalPath ?? null]);
  const b = JSON.stringify([right.path, right.index, right.worktree, right.originalPath ?? null]);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One-shot, single-consumer polling observer. It performs no writes/journaling
 * and cannot attribute an observed change to a Run or an external editor.
 * Only the latest pending sample is retained; errors are delivered once.
 */
export class WorkspaceObserver implements AsyncIterableIterator<WorkspaceObservation> {
  private readonly workspace: Workspace;
  private readonly options: WorkspaceObserverOptions;
  private readonly captureOptions: Omit<CaptureWorkspaceOptions, 'signal'>;
  private readonly controller = new AbortController();
  private readonly intervalMs: number;
  private readonly gitTimeoutMs: number;
  private readonly maxGitEntries: number;
  private currentState: WorkspaceObserverState = 'idle';
  private worker?: Promise<void>;
  private stopping?: Promise<void>;
  private latest?: Sample;
  private delivered?: Sample;
  private lastFingerprint?: string;
  private sequence = 0;
  private reading = false;
  private wake?: () => void;
  private wakeDelay?: () => void;
  private failure?: unknown;
  private failurePending = false;
  private rootIdentity?: { dev: bigint; ino: bigint };
  private readonly abort = () => { void this.stop(); };

  constructor(workspace: Workspace, options: WorkspaceObserverOptions = {}) {
    this.workspace = { ...workspace };
    this.options = { ...options };
    this.intervalMs = integer(options.intervalMs, DEFAULT_WORKSPACE_OBSERVER_OPTIONS.intervalMs, 'intervalMs', 50, 60_000);
    this.gitTimeoutMs = integer(options.gitTimeoutMs, DEFAULT_WORKSPACE_OBSERVER_OPTIONS.gitTimeoutMs, 'gitTimeoutMs', 1, 60_000);
    this.maxGitEntries = integer(options.maxGitEntries, DEFAULT_WORKSPACE_OBSERVER_OPTIONS.maxGitEntries, 'maxGitEntries', 1, 20_000);
    this.captureOptions = {
      maxFiles: integer(options.capture?.maxFiles, DEFAULT_CAPTURE_LIMITS.maxFiles, 'capture.maxFiles', 1, 100_000),
      maxFileBytes: integer(options.capture?.maxFileBytes, DEFAULT_CAPTURE_LIMITS.maxFileBytes, 'capture.maxFileBytes', 1, 67_108_864),
      maxTotalBytes: integer(options.capture?.maxTotalBytes, DEFAULT_CAPTURE_LIMITS.maxTotalBytes, 'capture.maxTotalBytes', 1, 268_435_456),
      maxEntries: integer(options.capture?.maxEntries, DEFAULT_CAPTURE_LIMITS.maxEntries, 'capture.maxEntries', 1, 500_000),
      maxDepth: integer(options.capture?.maxDepth, DEFAULT_CAPTURE_LIMITS.maxDepth, 'capture.maxDepth', 0, 256),
    };
  }

  get state(): WorkspaceObserverState { return this.currentState; }

  start(): this {
    if (this.currentState === 'running') return this;
    if (this.currentState !== 'idle') throw new EngineError('OBSERVER_CLOSED', 'A stopped or failed workspace observer cannot restart.');
    if (this.options.signal?.aborted) {
      this.currentState = 'stopped';
      return this;
    }
    this.currentState = 'running';
    this.options.signal?.addEventListener('abort', this.abort, { once: true });
    this.worker = this.poll();
    return this;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<WorkspaceObservation> { return this; }

  async next(): Promise<IteratorResult<WorkspaceObservation>> {
    if (this.reading) throw new EngineError('OBSERVER_CONCURRENT_NEXT', 'WorkspaceObserver supports one pending next() call.');
    this.reading = true;
    try {
      if (this.currentState === 'idle') this.start();
      for (;;) {
        if (this.failurePending) {
          this.failurePending = false;
          const failure = this.failure;
          this.failure = undefined;
          throw failure;
        }
        if (this.currentState !== 'running') {
          if (this.currentState === 'stopping') await this.stopping;
          return { done: true, value: undefined };
        }
        if (this.latest) {
          const sample = this.latest;
          this.latest = undefined;
          const observation = this.toObservation(sample);
          this.delivered = sample;
          return { done: false, value: observation };
        }
        await new Promise<void>((resolve) => { this.wake = resolve; });
      }
    } finally {
      this.reading = false;
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.currentState = 'stopping';
    this.controller.abort();
    this.wakeDelay?.();
    this.notify();
    this.latest = undefined;
    this.delivered = undefined;
    this.failure = undefined;
    this.failurePending = false;
    this.stopping = (async () => {
      await this.worker;
      this.options.signal?.removeEventListener('abort', this.abort);
      this.lastFingerprint = undefined;
      this.rootIdentity = undefined;
      this.currentState = 'stopped';
    })();
    return this.stopping;
  }

  async return(): Promise<IteratorResult<WorkspaceObservation>> {
    // A custom return wakes a pending next; async-generator return alone cannot.
    await this.stop();
    return { done: true, value: undefined };
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private async checkRoot(): Promise<void> {
    try {
      const canonical = await resolveWorkspacePath(this.workspace, '.');
      const metadata = await stat(canonical, { bigint: true });
      if (!metadata.isDirectory() || this.rootIdentity && (metadata.dev !== this.rootIdentity.dev || metadata.ino !== this.rootIdentity.ino)) {
        throw new EngineError('WORKSPACE_ROOT_CHANGED', 'Workspace root directory identity changed after observer start.');
      }
      this.rootIdentity ??= { dev: metadata.dev, ino: metadata.ino };
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError('WORKSPACE_UNAVAILABLE', 'Workspace root is unavailable during observation.');
    }
  }

  private async sample(): Promise<Sample> {
    await this.checkRoot();
    const capture = await captureWorkspace(this.workspace, { ...this.captureOptions, signal: this.controller.signal });
    const status = await getGitStatus(this.workspace, { signal: this.controller.signal, timeoutMs: this.gitTimeoutMs });
    await this.checkRoot();
    const files: Sample['files'] = new Map();
    for (const [relative, file] of [...capture.files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      files.set(relative, { hash: file.hash, bytes: Buffer.byteLength(file.content, 'utf8') });
    }
    const entries = [...status.entries].sort(compareEntries);
    const warnings = [...capture.warnings];
    const entriesTruncated = entries.length > this.maxGitEntries;
    if (entriesTruncated) warnings.push(`Git status entries truncated to ${this.maxGitEntries} of ${entries.length}; observation is incomplete.`);
    const git: ObservedGitStatus = { ...status, entries: entries.slice(0, this.maxGitEntries), totalEntries: entries.length, entriesTruncated };
    const digest = createHash('sha256');
    for (const [relative, file] of files) digest.update(JSON.stringify([relative, file.hash, file.bytes]));
    // Changes outside returned Git-entry bounds must still wake consumers.
    digest.update(JSON.stringify([status.branch, status.clean, entries, warnings]));
    return {
      sequence: ++this.sequence, observedAt: new Date().toISOString(), files, git, warnings,
      captureComplete: capture.warnings.length === 0, fingerprint: digest.digest('hex'), coalesced: 0,
    };
  }

  private async poll(): Promise<void> {
    try {
      while (!this.controller.signal.aborted) {
        const sample = await this.sample();
        if (this.controller.signal.aborted) break;
        if (sample.fingerprint !== this.lastFingerprint) {
          sample.coalesced = this.latest ? this.latest.coalesced + 1 : 0;
          this.latest = sample;
          this.lastFingerprint = sample.fingerprint;
          this.notify();
        }
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.wakeDelay = undefined;
            resolve();
          };
          const timer = setTimeout(done, this.intervalMs);
          this.wakeDelay = done;
          if (this.controller.signal.aborted) done();
        });
      }
    } catch (error) {
      if (!this.controller.signal.aborted) {
        this.failure = error;
        this.failurePending = true;
        this.currentState = 'failed';
        this.latest = undefined;
        this.delivered = undefined;
        this.lastFingerprint = undefined;
      }
    } finally {
      this.options.signal?.removeEventListener('abort', this.abort);
      this.notify();
    }
  }

  private toObservation(sample: Sample): WorkspaceObservation {
    const changes: ObservedWorkspaceChange[] = [];
    if (this.delivered) {
      const paths = [...new Set([...this.delivered.files.keys(), ...sample.files.keys()])].sort();
      for (const relative of paths) {
        const before = this.delivered.files.get(relative);
        const after = sample.files.get(relative);
        if (before?.hash === after?.hash) continue;
        changes.push({
          path: relative,
          kind: !after ? (sample.captureComplete ? 'removed' : 'unobserved') : before ? 'modified' : this.delivered.captureComplete ? 'added' : 'observed',
          beforeHash: before?.hash ?? null, afterHash: after?.hash ?? null,
        });
      }
    }
    return {
      type: this.delivered ? 'change' : 'initial', workspaceId: this.workspace.id,
      sequence: sample.sequence, observedAt: sample.observedAt,
      files: new Map([...sample.files].map(([relative, file]) => [relative, { ...file }])),
      changes, git: { ...sample.git, entries: sample.git.entries.map((entry) => ({ ...entry })) },
      warnings: [...sample.warnings], captureComplete: sample.captureComplete,
      incomplete: !sample.captureComplete || sample.git.entriesTruncated, coalesced: sample.coalesced,
    };
  }
}
