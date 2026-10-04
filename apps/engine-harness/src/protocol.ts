import type { CommandEnvelope, CommandResult, EngineEvent } from '@moodcode/contracts';
import type { Readable, Writable } from 'node:stream';
import type { EventEmitter } from 'node:events';

export interface HarnessEngine {
  dispatch(command: CommandEnvelope): Promise<CommandResult>;
  subscribe(sessionId: string, afterSeq: number, signal?: AbortSignal): AsyncIterable<EngineEvent>;
  close(): void | Promise<void>;
}

export interface HarnessOptions {
  input: Readable;
  output: Writable;
  diagnostics: Writable;
  signals?: EventEmitter;
  secrets?: readonly string[];
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxQueuedOutputBytes?: number;
  maxConcurrentCommands?: number;
  maxSubscriptions?: number;
  shutdownTimeoutMs?: number;
}

export interface HarnessOutcome { exitCode: number; reason: 'eof' | 'signal' | 'error' }

const COMMANDS = new Set([
  'engine.getCapabilities',
  'workspace.open', 'session.create', 'session.list', 'session.getSnapshot',
  'run.submit', 'run.cancel', 'approval.decide', 'review.getDiff', 'events.subscribe',
]);
const CONTROL_COMMANDS = new Set(['run.cancel', 'approval.decide']);
const MAX_ERROR_MESSAGE = 2_048;

class ProtocolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function redact(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
  return text;
}

function errorResult(commandId: string, error: unknown, secrets: readonly string[]): CommandResult {
  const value = error as { code?: unknown; message?: unknown; details?: unknown } | null;
  const code = typeof value?.code === 'string' ? value.code : 'INTERNAL_ERROR';
  const message = typeof value?.message === 'string' ? value.message : 'Command failed';
  // Details can include caller input or transport errors. Keep the public failure bounded.
  return { schemaVersion: 1, commandId, ok: false, error: { code: redact(code, secrets).slice(0, 128), message: redact(message, secrets).slice(0, MAX_ERROR_MESSAGE) } };
}

function commandId(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const id = (value as Record<string, unknown>).commandId;
  return typeof id === 'string' && id.length <= 256 ? id : '';
}

function envelope(value: unknown): CommandEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('INVALID_COMMAND', 'Expected a command object');
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new ProtocolError('UNSUPPORTED_SCHEMA_VERSION', 'Expected schemaVersion 1');
  if (!commandId(value).trim()) throw new ProtocolError('INVALID_COMMAND', 'commandId must be a nonempty string of at most 256 characters');
  if (typeof record.type !== 'string' || !COMMANDS.has(record.type)) throw new ProtocolError('UNKNOWN_COMMAND', 'Unknown command type');
  if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) throw new ProtocolError('INVALID_COMMAND', 'payload must be an object');
  return value as CommandEnvelope;
}

interface PendingWrite { line: Buffer; resolve(): void; reject(error: Error): void }

/** Serial writes pace event readers and cap retained bytes, including the active write. */
class JsonlWriter {
  private queue: PendingWrite[] = [];
  private queuedBytes = 0;
  private active = false;
  private failure?: Error;
  private readonly onError = (error: Error) => this.fail(error);
  private readonly onClose = () => this.fail(new ProtocolError('OUTPUT_CLOSED', 'Output closed'));

  constructor(
    private readonly output: Writable,
    private readonly maxRecordBytes: number,
    private readonly maxQueueBytes: number,
    private readonly secrets: readonly string[],
    private readonly onFailure: (error: Error) => void,
  ) { output.on('error', this.onError); output.on('close', this.onClose); }

  send(record: unknown): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    let serialized: string;
    try { serialized = JSON.stringify(record); }
    catch { return Promise.reject(new ProtocolError('SERIALIZATION_FAILED', 'Output could not be serialized')); }
    for (const secret of this.secrets) {
      if (!secret) continue;
      serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
    }
    const line = Buffer.from(serialized + '\n');
    if (line.length > this.maxRecordBytes) return Promise.reject(new ProtocolError('OUTPUT_TOO_LARGE', 'Output record exceeded the byte limit'));
    if (this.queuedBytes + line.length > this.maxQueueBytes) {
      const error = new ProtocolError('OUTPUT_BACKPRESSURE', 'Output queue exceeded the byte limit');
      this.fail(error);
      return Promise.reject(error);
    }
    this.queuedBytes += line.length;
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ line, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.active || this.failure) return;
    const item = this.queue[0];
    if (!item) return;
    this.active = true;
    try {
      this.output.write(item.line, (error?: Error | null) => {
        if (this.failure) return;
        if (error) { this.fail(error); return; }
        this.queue.shift();
        this.queuedBytes -= item.line.length;
        this.active = false;
        item.resolve();
        this.pump();
      });
    } catch (error) { this.fail(error instanceof Error ? error : new Error('Output write failed')); }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const item of this.queue) item.reject(error);
    this.queue = [];
    this.queuedBytes = 0;
    this.onFailure(error);
  }

  dispose(destroy = false): void {
    // Preserve the error listener on a stream with a pending failed write.
    this.output.removeListener('close', this.onClose);
    if (!destroy) this.output.removeListener('error', this.onError);
    if (destroy) {
      this.fail(new ProtocolError('SHUTDOWN_TIMEOUT', 'Output did not drain before shutdown'));
      this.output.destroy();
    }
  }
}

async function deadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProtocolError('SHUTDOWN_TIMEOUT', 'Cleanup exceeded the time limit')), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Input commands are concurrent; run admission never waits for model completion here. */
export function runHarness(engine: HarnessEngine, options: HarnessOptions): Promise<HarnessOutcome> {
  const { input, output, diagnostics, signals } = options;
  const secrets = options.secrets ?? [];
  const maxInputBytes = options.maxInputBytes ?? 1_048_576;
  const maxCommands = options.maxConcurrentCommands ?? 64;
  const maxSubscriptions = options.maxSubscriptions ?? 32;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
  const commands = new Set<Promise<void>>();
  const dispatches = new Set<Promise<CommandResult>>();
  const subscriptions = new Map<string, { abort: AbortController; task: Promise<void> }>();
  let normalCommands = 0;
  let controlCommands = 0;
  let stopping = false;
  let ended = false;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let discarding = false;
  let diagnosticBytes = 0;
  let diagnosticsTruncated = false;
  let resolveOutcome!: (outcome: HarnessOutcome) => void;
  const outcome = new Promise<HarnessOutcome>((resolve) => { resolveOutcome = resolve; });

  function diagnose(error: unknown): void {
    const message = errorResult('', error, secrets).error?.message ?? 'Transport failed';
    const line = Buffer.from(`[moodcode harness] ${message}\n`);
    const remaining = 16_384 - diagnosticBytes;
    try {
      if (remaining > 0) {
        const bounded = line.subarray(0, remaining);
        diagnosticBytes += bounded.length;
        diagnostics.write(bounded, () => { /* Diagnostics do not block cleanup. */ });
      }
      if (line.length > remaining && !diagnosticsTruncated) {
        diagnosticsTruncated = true;
        diagnostics.write('\n[moodcode harness] Diagnostics truncated\n', () => {});
      }
    } catch { /* Diagnostics do not block cleanup. */ }
  }

  const writer = new JsonlWriter(output, options.maxOutputBytes ?? 1_048_576, options.maxQueuedOutputBytes ?? 4_194_304, secrets, (error) => {
    diagnose(error);
    void stop('error', 1);
  });

  async function sendError(id: string, error: unknown): Promise<void> {
    try { await writer.send({ type: 'result', ...errorResult(id, error, secrets) }); }
    catch (failure) { diagnose(failure); void stop('error', 1); }
  }

  async function pumpSubscription(id: string, sessionId: string, afterSeq: number, abort: AbortController): Promise<void> {
    try {
      for await (const event of engine.subscribe(sessionId, afterSeq, abort.signal)) {
        if (abort.signal.aborted) break;
        await writer.send({ type: 'event', subscriptionId: id, event });
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        try { await writer.send({ type: 'subscription.error', subscriptionId: id, ...errorResult(id, error, secrets) }); }
        catch (failure) { diagnose(failure); void stop('error', 1); }
      }
    } finally { subscriptions.delete(id); }
  }

  async function handle(command: CommandEnvelope): Promise<void> {
    const id = command.commandId;
    let subscription: { sessionId: string; afterSeq: number } | undefined;
    try {
      if (command.type === 'events.subscribe') {
        if (subscriptions.has(id)) throw new ProtocolError('DUPLICATE_SUBSCRIPTION', 'A subscription with this commandId is already active');
        if (subscriptions.size >= maxSubscriptions) throw new ProtocolError('SUBSCRIPTION_LIMIT', 'Too many active subscriptions');
        const { sessionId, afterSeq = 0 } = command.payload;
        if (typeof sessionId !== 'string' || !sessionId || typeof afterSeq !== 'number' || !Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new ProtocolError('INVALID_COMMAND', 'Expected sessionId and a nonnegative safe integer afterSeq');
        subscription = { sessionId, afterSeq };
        // Reserve capacity before awaiting dispatch so concurrent subscriptions cannot bypass the cap.
        subscriptions.set(id, { abort: new AbortController(), task: Promise.resolve() });
      }
      const dispatch = engine.dispatch(command);
      dispatches.add(dispatch);
      let result: CommandResult;
      try { result = await dispatch; }
      finally { dispatches.delete(dispatch); }
      await writer.send({ ...(result.ok ? result : errorResult(id, result.error, secrets)), type: 'result' });
      if (subscription) {
        const reservation = subscriptions.get(id);
        if (result.ok && !stopping && reservation) {
          reservation.task = pumpSubscription(id, subscription.sessionId, subscription.afterSeq, reservation.abort);
        } else { reservation?.abort.abort(); subscriptions.delete(id); }
      }
    } catch (error) { if (subscription) subscriptions.delete(id); await sendError(id, error); }
  }

  function schedule(task: Promise<void>): void {
    commands.add(task);
    void task.finally(() => { commands.delete(task); }).catch(() => { /* handle already reports failures */ });
  }

  function accept(line: Buffer): void {
    if (stopping) return;
    let value: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(line);
      if (!text.trim()) return;
      try { value = JSON.parse(text); } catch { throw new ProtocolError('INVALID_JSON', 'Input must be valid JSON'); }
      const command = envelope(value);
      const control = CONTROL_COMMANDS.has(command.type);
      if ((!control && normalCommands >= maxCommands) || (control && controlCommands >= 8)) throw new ProtocolError('COMMAND_LIMIT', 'Too many concurrent commands');
      if (control) controlCommands++; else normalCommands++;
      schedule(handle(command).finally(() => { if (control) controlCommands--; else normalCommands--; }));
    } catch (error) {
      // A malformed UTF-8 sequence is also a malformed JSON record.
      if (error instanceof TypeError) error = new ProtocolError('INVALID_JSON', 'Input must be valid UTF-8 JSON');
      schedule(sendError(commandId(value), error));
    }
  }

  function onData(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length && !stopping) {
      const newline = bytes.indexOf(10, start);
      const end = newline === -1 ? bytes.length : newline;
      const part = bytes.subarray(start, end);
      if (!discarding) {
        if (pendingBytes + part.length > maxInputBytes) {
          pending = []; pendingBytes = 0; discarding = true;
          schedule(sendError('', new ProtocolError('INPUT_TOO_LARGE', 'Input line exceeded the byte limit')));
        } else if (part.length) { pending.push(part); pendingBytes += part.length; }
      }
      if (newline !== -1) {
        if (!discarding) accept(Buffer.concat(pending, pendingBytes));
        pending = []; pendingBytes = 0; discarding = false;
      }
      start = newline === -1 ? bytes.length : newline + 1;
    }
  }

  function onEnd(): void {
    ended = true;
    if (pendingBytes && !discarding) accept(Buffer.concat(pending, pendingBytes));
    pending = []; pendingBytes = 0;
    void stop('eof', 0);
  }
  function onInputError(error: Error): void { diagnose(error); void stop('error', 1); }
  function onInputClose(): void { if (!ended) { diagnose(new ProtocolError('INPUT_CLOSED', 'Input closed before EOF')); void stop('error', 1); } }
  function onSignal(): void { void stop('signal', 0); }

  async function stop(reason: HarnessOutcome['reason'], exitCode: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    input.removeListener('data', onData);
    input.removeListener('end', onEnd);
    input.removeListener('error', onInputError);
    input.removeListener('close', onInputClose);
    input.pause();
    signals?.removeListener('SIGINT', onSignal);
    signals?.removeListener('SIGTERM', onSignal);
    const readers = [...subscriptions.values()];
    for (const reader of readers) reader.abort.abort();
    let timedOut = false;
    let closeInitiated = false;
    const startClose = () => {
      if (closeInitiated) return;
      closeInitiated = true;
      return engine.close();
    };
    try {
      // Finish admitted command operations, then cancel runs independently of stdout.
      const close = Promise.allSettled([...dispatches]).then(startClose);
      await deadline(Promise.all([close, Promise.allSettled([...commands]), Promise.allSettled(readers.map((reader) => reader.task))]), shutdownTimeoutMs);
    } catch (error) {
      diagnose(error); exitCode = 1; timedOut = true;
      // A broken dispatch must not prevent even attempting engine cancellation.
      if (!closeInitiated) void Promise.resolve().then(startClose).catch(diagnose);
    }
    writer.dispose(timedOut);
    resolveOutcome({ reason, exitCode });
  }

  input.on('data', onData);
  input.on('end', onEnd);
  input.on('error', onInputError);
  input.on('close', onInputClose);
  // Keep failed stderr writes from interrupting stdout/engine cleanup.
  diagnostics.on('error', () => {});
  signals?.on('SIGINT', onSignal);
  signals?.on('SIGTERM', onSignal);
  if (input.readableEnded) onEnd();
  return outcome;
}
