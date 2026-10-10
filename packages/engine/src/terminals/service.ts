import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { EngineError } from '@moodcode/contracts';
import { PosixPtyBackend, startupFailureOutcome } from './backend.js';
import { MemoryTerminalJournal } from './journal.js';
import { validatePtyOutcome, PtyDiagnosticRecorder } from './diagnostics.js';
import { knowledgeHash } from '../knowledge/validation.js';
import type { JobOutputSnapshot, TerminalJobSourceProof, TerminalObservationProof, TerminalClosedOutcomeProof } from '../jobs/types.js';
import { validateTerminalJobSourceProof, validateJobOutputSnapshot, validateTerminalObservationProof, validateTerminalClosedOutcomeProof } from '../jobs/validation.js';
import { TERMINAL_LIMITS, type TerminalAttachment, type TerminalCreateRequest, type TerminalEvent, type TerminalJournal, type TerminalOwner, type TerminalOutput, type TerminalRecord, type TerminalReplay, type TerminalSnapshot, type PtyBackend, type PtyOutcome, type PtyProcess } from './types.js';

interface TerminalEntry { snapshot: TerminalSnapshot; process?: PtyProcess; attachments: Map<string, AttachmentQueue>; pendingWrites: number; savingFailed?: boolean; birthNonce?: string; readerPins?: number; closedOutcome?: PtyOutcome }
export interface TerminalServiceOptions {
  resolveOwner(owner: TerminalOwner): Promise<{ workspaceId: string; sessionId: string; root: string }> | { workspaceId: string; sessionId: string; root: string };
  backend?: PtyBackend; journal?: TerminalJournal; maxDurationMs?: number;
}
const active = (state: TerminalRecord['state']) => state === 'starting' || state === 'running';
const failure = (code: string, message: string) => new EngineError(code, message);
function dimensions(cols: number, rows: number): void {
  if (!Number.isSafeInteger(cols) || cols < 1 || cols > TERMINAL_LIMITS.maxCols || !Number.isSafeInteger(rows) || rows < 1 || rows > TERMINAL_LIMITS.maxRows) throw failure('INVALID_TERMINAL_INPUT', 'Terminal dimensions are outside the supported bounds');
}
function ownerIdentity(owner: TerminalOwner): void {
  if (!owner || owner.authority !== 'user' || ![owner.sessionId, owner.workspaceId].every(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value))) throw failure('TERMINAL_AUTHORITY', 'A terminal requires a host user authority bound to a session and workspace');
}
function chunks(text: string): TerminalOutput['data'][] {
  const bytes = Buffer.from(text), result: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(bytes.length, offset + TERMINAL_LIMITS.eventBytes);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    result.push(bytes.subarray(offset, end).toString('utf8')); offset = end;
  }
  return result;
}
class AttachmentQueue implements AsyncIterable<TerminalEvent> {
  private readonly queue: { event: TerminalEvent; bytes: number }[] = [];
  private bytes = 0;
  private waiter?: { resolve(value: IteratorResult<TerminalEvent>): void; reject(error: Error): void };
  private stopped = false;
  private error?: Error;
  constructor(private readonly release: () => void) {}
  push(event: TerminalEvent): void {
    if (this.stopped) return;
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve({ done: false, value: structuredClone(event) }); return; }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (this.bytes + bytes > TERMINAL_LIMITS.attachmentBytes) { this.close(failure('TERMINAL_ATTACH_BACKPRESSURE', 'The terminal attachment fell behind its bounded replay buffer')); return; }
    this.queue.push({ event: structuredClone(event), bytes }); this.bytes += bytes;
  }
  close(error?: Error): void {
    if (this.stopped) return;
    this.stopped = true; this.error = error; this.queue.length = 0; this.bytes = 0; this.release();
    const waiter = this.waiter; this.waiter = undefined;
    if (waiter) { if (error) waiter.reject(error); else waiter.resolve({ done: true, value: undefined }); }
  }
  end(): void {
    if (this.stopped) return;
    this.stopped = true; this.release();
    const waiter = this.waiter; this.waiter = undefined;
    waiter?.resolve({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterator<TerminalEvent> {
    return { next: () => {
      const next = this.queue.shift(); if (next) { this.bytes -= next.bytes; return Promise.resolve({ done: false, value: next.event }); }
      if (this.stopped) return this.error ? Promise.reject(this.error) : Promise.resolve({ done: true, value: undefined });
      if (this.waiter) return Promise.reject(failure('TERMINAL_ATTACH_CONCURRENT_READ', 'One attachment permits one pending event read'));
      return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
    }, return: async () => { this.close(); return { done: true, value: undefined }; } };
  }
}

export class TerminalService {
  private readonly serviceEpoch = randomUUID();
  private readonly readSources = new WeakMap<object, { entry: TerminalEntry; proof: TerminalJobSourceProof }>();
  private readonly retainedReadSources = new Set<object>();
  private readonly readSnapshots = new WeakMap<object, { source: object; snapshot: JobOutputSnapshot; observation: TerminalObservationProof; bytes: number }>();
  private readonly retainedReadSnapshots = new Set<object>();
  private readonly readOutcomes = new WeakMap<object, { source: object; proof: TerminalClosedOutcomeProof }>();
  private readonly retainedReadOutcomes = new Set<object>();
  private retainedSnapshotBytes = 0;
  private readonly terminals = new Map<string, TerminalEntry>();
  private readonly backend: PtyBackend;
  private readonly journal: TerminalJournal;
  private readonly duration: number;
  private reservations = 0;
  private readonly creations = new Set<Promise<TerminalRecord>>();
  private closing = false;
  private closePromise?: Promise<void>;
  constructor(private readonly options: TerminalServiceOptions) {
    this.backend = options.backend ?? new PosixPtyBackend(); this.journal = options.journal ?? new MemoryTerminalJournal();
    this.duration = options.maxDurationMs ?? TERMINAL_LIMITS.maxDurationMs;
    if (!Number.isSafeInteger(this.duration) || this.duration < 1 || this.duration > TERMINAL_LIMITS.maxDurationMs) throw failure('INVALID_TERMINAL_INPUT', 'Terminal lifetime is outside the supported bounds');
    for (const snapshot of this.journal.load()) {
      if (this.terminals.has(snapshot.record.id)) throw failure('TERMINAL_JOURNAL_INVALID', 'Terminal history contains duplicate identities');
      if (active(snapshot.record.state)) {
        snapshot.record = { ...snapshot.record, state: 'interrupted', cleanupConfirmed: null, reason: 'engine_restarted', updatedAt: new Date().toISOString() };
        this.journal.save(snapshot);
      }
      this.terminals.set(snapshot.record.id, { snapshot, attachments: new Map(), pendingWrites: 0 });
    }
  }
  capability() { return this.backend.capability(); }
  private entry(id: string, owner: TerminalOwner): TerminalEntry {
    ownerIdentity(owner);
    const entry = this.terminals.get(id);
    if (!entry) throw failure('TERMINAL_NOT_FOUND', 'The terminal was not found');
    if (JSON.stringify(entry.snapshot.record.owner) !== JSON.stringify(owner)) {
      const bound = entry.snapshot.record.owner;
      if (bound.authority !== owner.authority || bound.workspaceId !== owner.workspaceId || bound.sessionId !== owner.sessionId) throw failure('TERMINAL_OWNER_MISMATCH', 'The terminal belongs to a different session or workspace');
    }
    return entry;
  }
  private persist(entry: TerminalEntry): void {
    try { this.journal.save(entry.snapshot); }
    catch (error) { entry.savingFailed = true; if (entry.process) void entry.process.cancel().catch(() => {}); throw error; }
  }
  private state(entry: TerminalEntry): void { for (const attachment of entry.attachments.values()) attachment.push({ type: 'state', terminal: entry.snapshot.record }); }
  private output(entry: TerminalEntry, data: string): void {
    for (const chunk of chunks(data)) {
      const record = entry.snapshot.record, bytes = Buffer.byteLength(chunk);
      if (bytes === 0) continue;
      if (record.outputSeq >= Number.MAX_SAFE_INTEGER || bytes > Number.MAX_SAFE_INTEGER - record.observedBytes) throw failure('TERMINAL_OUTPUT_LIMIT', 'Terminal output accounting exceeded its supported range');
      const event = { seq: ++record.outputSeq, data: chunk, bytes };
      record.observedBytes += bytes; record.retainedBytes += bytes; entry.snapshot.output.push(event);
      while (record.retainedBytes > TERMINAL_LIMITS.bufferBytes) record.retainedBytes -= entry.snapshot.output.shift()!.bytes;
      record.oldestSeq = entry.snapshot.output[0]?.seq ?? record.outputSeq + 1; record.updatedAt = new Date().toISOString();
      this.persist(entry);
      for (const attachment of entry.attachments.values()) attachment.push({ type: 'output', terminalId: record.id, output: event });
    }
  }
  private finish(entry: TerminalEntry, outcome: PtyOutcome): void {
    if (outcome.diagnostics !== undefined) {
      try { outcome = validatePtyOutcome(outcome); }
      catch {
        const recorder = new PtyDiagnosticRecorder(process.platform, null);
        if (entry.process && Number.isSafeInteger(entry.process.pid) && entry.process.pid > 1) recorder.started(entry.process.pid);
        recorder.note({ kind: 'invalid-diagnostics', errorCode: 'PTY_DIAGNOSTICS_INVALID' });
        try { outcome = { ...outcome, diagnostics: recorder.snapshot(outcome) }; }
        catch { const { diagnostics: _invalid, ...actualOutcome } = outcome; outcome = actualOutcome; }
      }
    }
    entry.closedOutcome = structuredClone(outcome);
    entry.process = undefined;
    const record = entry.snapshot.record;
    record.state = !outcome.cleanupConfirmed ? 'uncertain' : entry.savingFailed ? 'failed' : outcome.cancelled || outcome.timedOut ? 'cancelled' : outcome.exitCode === 0 ? 'completed' : 'failed';
    record.exitCode = outcome.exitCode; record.cleanupConfirmed = outcome.cleanupConfirmed; record.updatedAt = new Date().toISOString();
    if (outcome.diagnostics) record.diagnostics = structuredClone(outcome.diagnostics);
    if (outcome.reason) record.reason = outcome.reason;
    try { this.persist(entry); } catch { record.state = 'uncertain'; record.reason = 'journal_failed'; }
    this.state(entry);
    for (const attachment of entry.attachments.values()) attachment.end();
  }
  create(request: TerminalCreateRequest): Promise<TerminalRecord> {
    const creation = this.createOwned(request);
    this.creations.add(creation);
    void creation.then(() => this.creations.delete(creation), () => this.creations.delete(creation));
    return creation;
  }
  private async createOwned(request: TerminalCreateRequest): Promise<TerminalRecord> {
    if (this.closing) throw failure('ENGINE_CLOSED', 'The terminal service is closed');
    ownerIdentity(request.owner);
    if (request.signal?.aborted) throw failure('ABORTED', 'Terminal creation was cancelled');
    const cols = request.cols ?? 80, rows = request.rows ?? 24; dimensions(cols, rows);
    const boundOwner = structuredClone(request.owner);
    const file = request.file ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh'), args = request.args === undefined ? [] : Array.isArray(request.args) ? [...request.args] : request.args;
    if (!isAbsolute(file) || file.includes('\0') || Buffer.byteLength(file) > 8192 || !Array.isArray(args) || args.length > 128 || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 8192) || args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > 65_536) throw failure('INVALID_TERMINAL_INPUT', 'Terminal executable or arguments are invalid');
    if (this.reservations + [...this.terminals.values()].filter(entry => active(entry.snapshot.record.state)).length >= TERMINAL_LIMITS.maxTerminals) throw failure('TERMINAL_COUNT_LIMIT', 'The host terminal limit was reached');
    this.reservations++;
    try {
      const resolved = await this.options.resolveOwner(structuredClone(boundOwner));
      if (resolved.workspaceId !== boundOwner.workspaceId || resolved.sessionId !== boundOwner.sessionId) throw failure('TERMINAL_OWNER_MISMATCH', 'The host did not authorize this terminal owner');
      const root = await realpath(resolved.root), cwd = await realpath(resolve(root, request.cwd ?? '.'));
      const displacement = relative(root, cwd);
      if (!(await stat(cwd)).isDirectory() || displacement === '..' || displacement.startsWith(`..${sep}`) || isAbsolute(displacement)) throw failure('TERMINAL_CWD_OUTSIDE_WORKSPACE', 'Terminal cwd must remain within its workspace');
      if (this.closing || request.signal?.aborted) throw failure('ABORTED', 'Terminal creation was cancelled');
      if ([...this.terminals.values()].filter(entry => active(entry.snapshot.record.state) && entry.snapshot.record.owner.sessionId === boundOwner.sessionId).length >= TERMINAL_LIMITS.maxTerminalsPerSession) throw failure('TERMINAL_COUNT_LIMIT', 'The session terminal limit was reached');
      while (this.terminals.size >= TERMINAL_LIMITS.maxRecords) {
        const oldest = [...this.terminals.values()].filter(entry => !active(entry.snapshot.record.state) && entry.attachments.size === 0 && !entry.readerPins).sort((a, b) => a.snapshot.record.updatedAt.localeCompare(b.snapshot.record.updatedAt))[0];
        if (!oldest) throw failure('TERMINAL_RECORD_LIMIT', 'Terminal history capacity was reached');
        this.journal.remove(oldest.snapshot.record.id); this.terminals.delete(oldest.snapshot.record.id);
      }
      const now = new Date().toISOString();
      const record: TerminalRecord = { version: 1, id: randomUUID(), owner: boundOwner, cwd, file, args: [...args], cols, rows, state: 'starting', createdAt: now, updatedAt: now, outputSeq: 0, oldestSeq: 1, observedBytes: 0, retainedBytes: 0, cleanupConfirmed: null, exitCode: null };
      const entry: TerminalEntry = { snapshot: { record, output: [] }, attachments: new Map(), pendingWrites: 0 };
      this.terminals.set(record.id, entry); this.persist(entry);
      try {
        const handle = await this.backend.spawn({ file, args, cwd, cols, rows, maxDurationMs: this.duration }, data => this.output(entry, data));
        entry.process = handle; entry.birthNonce = randomUUID();
        const abort = () => { void handle.cancel().catch(() => {}); };
        request.signal?.addEventListener('abort', abort, { once: true });
        void handle.closed.then(outcome => { this.finish(entry, outcome); request.signal?.removeEventListener('abort', abort); }, () => { this.finish(entry, { exitCode: null, cancelled: false, timedOut: false, cleanupConfirmed: false, reason: 'backend_closed_failed' }); request.signal?.removeEventListener('abort', abort); });
        record.state = 'running'; record.updatedAt = new Date().toISOString(); this.persist(entry);
        this.state(entry);
        if (this.closing || request.signal?.aborted) { await handle.cancel(); throw failure('ABORTED', 'Terminal creation was cancelled'); }
        return structuredClone(record);
      } catch (error) {
        if (active(record.state)) {
          const outcome = startupFailureOutcome(error);
          record.state = outcome?.cleanupConfirmed === false ? 'uncertain' : 'failed'; record.reason = 'start_failed'; record.cleanupConfirmed = outcome?.cleanupConfirmed ?? entry.process === undefined; record.updatedAt = new Date().toISOString();
          if (outcome?.diagnostics) record.diagnostics = structuredClone(outcome.diagnostics);
          try { this.persist(entry); } catch { /* Original startup error is authoritative. */ } this.state(entry);
        }
        throw error;
      }
    } finally { this.reservations--; }
  }
  get(id: string, owner: TerminalOwner): TerminalRecord { return structuredClone(this.entry(id, owner).snapshot.record); }
  /** A separate retained reader pin does not consume a UI attachment or command authority. */
  captureReadSource(id: string, owner: TerminalOwner, journalBindingSha256: string): object {
    if (this.closing) throw failure('ENGINE_CLOSED', 'Terminal reader admission is closed');
    const entry = this.entry(id, owner), record = entry.snapshot.record;
    if (!entry.birthNonce || (!entry.process && !entry.closedOutcome)) throw failure('JOB_SOURCE_HISTORY_ONLY', 'Restored terminal data cannot reconstruct a physical source');
    if (!/^[a-f0-9]{64}$/.test(journalBindingSha256)) throw failure('JOB_SOURCE_INVALID', 'Terminal journal binding is invalid');
    if (this.retainedReadSources.size >= 128) throw failure('JOB_HANDLE_LIMIT', 'Terminal reader source capacity was reached');
    this.assertReadJournal(entry);
    const body = { terminalId: record.id, workspaceId: record.owner.workspaceId, sessionId: record.owner.sessionId,
      serviceEpoch: this.serviceEpoch, entryBirthNonce: entry.birthNonce, journalBindingSha256,
      launchSha256: this.readLaunchSha(entry), createdAt: record.createdAt,
      authority: entry.process ? 'current-physical' as const : 'retained-current' as const };
    const proof = validateTerminalJobSourceProof({ ...body, sha256: knowledgeHash(body) }), original = Object.freeze({});
    this.readSources.set(original, { entry, proof }); this.retainedReadSources.add(original); entry.readerPins = (entry.readerPins ?? 0) + 1;
    return original;
  }
  private readLaunchSha(entry: TerminalEntry): string {
    const record = entry.snapshot.record;
    return knowledgeHash({ terminalId: record.id, owner: record.owner, file: record.file, args: record.args, cwd: record.cwd, createdAt: record.createdAt });
  }
  private assertReadJournal(entry: TerminalEntry): void {
    if (!this.journal.read) throw failure('JOB_SOURCE_JOURNAL_UNSUPPORTED', 'Terminal observation requires bounded current journal reads');
    const persisted = this.journal.read(entry.snapshot.record.id);
    if (!persisted || knowledgeHash(persisted) !== knowledgeHash(entry.snapshot)) throw failure('JOB_SOURCE_JOURNAL_STALE', 'The actual terminal snapshot differs from its durable sidecar');
  }
  private readSourceEntry(original: object): { entry: TerminalEntry; proof: TerminalJobSourceProof } {
    const source = this.readSources.get(original);
    if (!source || this.terminals.get(source.proof.terminalId) !== source.entry || source.entry.birthNonce !== source.proof.entryBirthNonce
      || this.readLaunchSha(source.entry) !== source.proof.launchSha256) throw failure('JOB_ORIGINAL_SOURCE_REQUIRED', 'Terminal observation requires its current retained original source');
    return source;
  }
  readReadSource(original: object): TerminalJobSourceProof { return structuredClone(this.readSourceEntry(original).proof); }
  assertReadSourceCurrent(original: object): void { this.readSourceEntry(original); }
  captureReadSnapshot(originalSource: object): object {
    const { entry, proof } = this.readSourceEntry(originalSource);
    this.assertReadJournal(entry);
    const record = entry.snapshot.record;
    const body = { version: 1 as const, source: proof, throughSeq: record.outputSeq, oldestSeq: record.oldestSeq,
      observedBytes: record.observedBytes, retainedBytes: record.retainedBytes, output: structuredClone(entry.snapshot.output) };
    const snapshot = validateJobOutputSnapshot({ ...body, sha256: knowledgeHash(body) }), bytes = Buffer.byteLength(JSON.stringify(snapshot));
    if (this.retainedReadSnapshots.size >= 64 || bytes > 16_777_216 - this.retainedSnapshotBytes) throw failure('JOB_SNAPSHOT_LIMIT', 'Terminal reader snapshots exceed their retained byte capacity');
    const observationBody = { sourceSha256: proof.sha256, state: record.state, outputSeq: record.outputSeq, oldestSeq: record.oldestSeq,
      observedBytes: record.observedBytes, retainedBytes: record.retainedBytes, cleanupConfirmed: record.cleanupConfirmed, exitCode: record.exitCode,
      reason: record.reason ?? null, updatedAt: record.updatedAt };
    const observation = validateTerminalObservationProof({ ...observationBody, sha256: knowledgeHash(observationBody) }), original = Object.freeze({});
    this.readSnapshots.set(original, { source: originalSource, snapshot, observation, bytes }); this.retainedReadSnapshots.add(original); this.retainedSnapshotBytes += bytes;
    return original;
  }
  readReadSnapshot(original: object): JobOutputSnapshot {
    const captured = this.readSnapshots.get(original); if (!captured) throw failure('JOB_OUTPUT_SNAPSHOT_EXPIRED', 'Terminal output requires its retained original snapshot');
    this.readSourceEntry(captured.source); return captured.snapshot;
  }
  readReadObservation(originalSnapshot: object): TerminalObservationProof {
    const captured = this.readSnapshots.get(originalSnapshot); if (!captured) throw failure('JOB_OUTPUT_SNAPSHOT_EXPIRED', 'Terminal observation requires its original snapshot');
    this.readSourceEntry(captured.source); return structuredClone(captured.observation);
  }
  captureClosedObservation(originalSource: object): object {
    const { entry, proof } = this.readSourceEntry(originalSource), record = entry.snapshot.record, outcome = entry.closedOutcome;
    if (!outcome || entry.process || active(record.state)) throw failure('JOB_SOURCE_NOT_CLOSED', 'The actual terminal has no settled physical outcome');
    if (this.retainedReadOutcomes.size >= 128) throw failure('JOB_HANDLE_LIMIT', 'Terminal closed observation capacity was reached');
    this.assertReadJournal(entry);
    const body = { sourceSha256: proof.sha256, state: record.state as TerminalClosedOutcomeProof['state'], exitCode: outcome.exitCode,
      cancelled: outcome.cancelled, timedOut: outcome.timedOut, cleanupConfirmed: outcome.cleanupConfirmed,
      reason: record.reason ?? null, closedAt: record.updatedAt };
    const value = validateTerminalClosedOutcomeProof({ ...body, sha256: knowledgeHash(body) }), original = Object.freeze({});
    this.readOutcomes.set(original, { source: originalSource, proof: value }); this.retainedReadOutcomes.add(original); return original;
  }
  readClosedObservation(original: object): TerminalClosedOutcomeProof {
    const captured = this.readOutcomes.get(original); if (!captured) throw failure('JOB_ORIGINAL_OUTCOME_REQUIRED', 'Terminal completion requires its retained original physical outcome');
    this.readSourceEntry(captured.source); return structuredClone(captured.proof);
  }
  releaseReadHandle(original: object): void {
    const source = this.readSources.get(original);
    if (source) { source.entry.readerPins = Math.max(0, (source.entry.readerPins ?? 0) - 1); this.readSources.delete(original); this.retainedReadSources.delete(original); }
    const snapshot = this.readSnapshots.get(original);
    if (snapshot) { this.retainedSnapshotBytes -= snapshot.bytes; this.readSnapshots.delete(original); this.retainedReadSnapshots.delete(original); }
    this.readOutcomes.delete(original); this.retainedReadOutcomes.delete(original);
  }
  list(owner: TerminalOwner): TerminalRecord[] { ownerIdentity(owner); return [...this.terminals.values()].filter(entry => entry.snapshot.record.owner.sessionId === owner.sessionId && entry.snapshot.record.owner.workspaceId === owner.workspaceId).map(entry => structuredClone(entry.snapshot.record)); }
  replay(id: string, owner: TerminalOwner, afterSeq = 0, maxBytes = 65_536): TerminalReplay {
    const entry = this.entry(id, owner), record = entry.snapshot.record;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > record.outputSeq || !Number.isSafeInteger(maxBytes) || maxBytes < TERMINAL_LIMITS.eventBytes || maxBytes > TERMINAL_LIMITS.bufferBytes) throw failure('INVALID_TERMINAL_CURSOR', 'Terminal replay cursor or byte limit is invalid');
    const output: TerminalOutput[] = []; let bytes = 0;
    const pending = entry.snapshot.output.filter(item => item.seq > afterSeq);
    for (const item of pending) { if (bytes + item.bytes > maxBytes) break; output.push(structuredClone(item)); bytes += item.bytes; }
    return { terminal: structuredClone(record), output, nextSeq: output.at(-1)?.seq ?? afterSeq, gap: afterSeq < record.oldestSeq - 1, hasMore: output.length < pending.length };
  }
  attach(id: string, owner: TerminalOwner, afterSeq = 0): TerminalAttachment {
    const entry = this.entry(id, owner);
    if (this.closing) throw failure('ENGINE_CLOSED', 'The terminal service is closed');
    if (entry.attachments.size >= TERMINAL_LIMITS.maxAttachments) throw failure('TERMINAL_ATTACH_LIMIT', 'The terminal attachment limit was reached');
    const replay = this.replay(id, owner, afterSeq, TERMINAL_LIMITS.bufferBytes), attachmentId = randomUUID();
    const queue = new AttachmentQueue(() => entry.attachments.delete(attachmentId)); entry.attachments.set(attachmentId, queue);
    if (!active(entry.snapshot.record.state)) queue.end();
    return { id: attachmentId, replay, events: queue, detach: () => queue.close() };
  }
  async write(id: string, owner: TerminalOwner, data: string): Promise<void> {
    const entry = this.entry(id, owner);
    if (typeof data !== 'string' || Buffer.byteLength(data) > TERMINAL_LIMITS.maxWriteBytes) throw failure('INVALID_TERMINAL_INPUT', 'Terminal input exceeds its byte limit');
    if (!entry.process || !active(entry.snapshot.record.state)) throw failure('TERMINAL_CLOSED', 'The terminal is not running');
    if (entry.pendingWrites >= TERMINAL_LIMITS.maxPendingWrites) throw failure('TERMINAL_BACKPRESSURE', 'Terminal input is already at its pending request limit');
    entry.pendingWrites++; try { await entry.process.write(data); } finally { entry.pendingWrites--; }
  }
  async resize(id: string, owner: TerminalOwner, cols: number, rows: number): Promise<TerminalRecord> {
    const entry = this.entry(id, owner); dimensions(cols, rows);
    if (!entry.process) throw failure('TERMINAL_CLOSED', 'The terminal is not running');
    await entry.process.resize(cols, rows); entry.snapshot.record.cols = cols; entry.snapshot.record.rows = rows; this.persist(entry); this.state(entry);
    return structuredClone(entry.snapshot.record);
  }
  async cancel(id: string, owner: TerminalOwner): Promise<TerminalRecord> {
    const entry = this.entry(id, owner);
    if (entry.process) await entry.process.cancel();
    return structuredClone(entry.snapshot.record);
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await Promise.allSettled(this.creations);
      await Promise.allSettled([...this.terminals.values()].map(entry => entry.process?.cancel()));
      for (const entry of this.terminals.values()) for (const attachment of entry.attachments.values()) attachment.close();
      for (const original of [...this.retainedReadSnapshots, ...this.retainedReadOutcomes, ...this.retainedReadSources]) this.releaseReadHandle(original);
    })();
    return this.closePromise;
  }
}
