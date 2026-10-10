import { executeShell, type ProcessOutcome, type ShellInput, type ShellStdinControl } from './process-control.js';
import type { acquireExecutionLock } from './execution-lock.js';

// This process deliberately outlives the engine. IPC disconnect is its parent
// liveness signal, including SIGKILL and Electron utility-process loss.
const abort = new AbortController();
let lock: ReturnType<typeof acquireExecutionLock> | undefined;
let input: ShellInput | undefined;
let ready = false;
let interactive = false;
let stdin: ShellStdinControl | undefined;
let stdinBusy = false;
let stdinSeq = 0;
let started = false;
let finished = false;
let disconnected = !process.connected;

function send(message: unknown, delivered?: () => void): void {
  if (!process.connected || !process.send) { delivered?.(); return; }
  const sendMessage = process.send.bind(process);
  try { sendMessage(message, () => delivered?.()); }
  catch { delivered?.(); /* Disconnect cleanup remains authoritative. */ }
}

function finish(outcome: ProcessOutcome): void {
  if (finished) return;
  finished = true;
  try { lock?.release(outcome.cleanupConfirmed); }
  catch (error) { outcome = { ...outcome, cleanupConfirmed: false, error: `Execution lock release failed: ${error instanceof Error ? error.message : String(error)}` }; }
  const exitCode = outcome.cleanupConfirmed ? 0 : 1;
  if (disconnected || outcome.outputDiscarded || outcome.error) {
    // Flush the small bounded queues when the parent is still reading. Abrupt
    // stream destruction can race result IPC with ECONNRESET in the client.
    // A vanished or paused reader still cannot keep this supervisor alive.
    const deadline = setTimeout(() => process.exit(exitCode), 250);
    const delivered = new Promise<void>(resolve => send({ type: 'result', outcome }, resolve));
    const stdoutEnded = new Promise<void>(resolve => process.stdout.end(() => resolve()));
    const stderrEnded = new Promise<void>(resolve => process.stderr.end(() => resolve()));
    void Promise.all([delivered, stdoutEnded, stderrEnded]).then(() => {
      clearTimeout(deadline);
      process.exit(exitCode);
    });
    return;
  } else {
    send({ type: 'result', outcome });
    // Normal success preserves every forwarded byte through stream EOF.
    process.stdout.end(); process.stderr.end();
  }
  if (process.connected) process.disconnect?.();
  process.exitCode = exitCode;
}

function idleCancelled(): void {
  finish({ exitCode: null, signal: null, cancelled: true, timedOut: false, cleanupConfirmed: true, started: false });
}

process.stdout.on('error', () => { if (!finished) abort.abort(); });
process.stderr.on('error', () => { if (!finished) abort.abort(); });
process.on('disconnect', () => {
  disconnected = true;
  abort.abort();
  if (!started) idleCancelled();
});
process.on('SIGTERM', () => { abort.abort(); if (!started) idleCancelled(); });
process.on('SIGINT', () => { abort.abort(); if (!started) idleCancelled(); });

function forwardOutput(stream: 'stdout' | 'stderr', bytes: Buffer): void | Promise<void> {
  if (disconnected || abort.signal.aborted || finished) return;
  const sink = stream === 'stdout' ? process.stdout : process.stderr;
  if (sink.write(bytes)) return;
  // executeShell pauses this shell pipe until drain. Each stream can therefore
  // retain only its current chunk, rather than queuing the complete command.
  return new Promise<void>((resolve, reject) => {
    const settle = (error?: Error): void => {
      sink.removeListener('drain', onDrain);
      sink.removeListener('error', onError);
      sink.removeListener('close', onClose);
      abort.signal.removeEventListener('abort', onAbort);
      if (error && !disconnected && !abort.signal.aborted) reject(error);
      else resolve();
    };
    const onDrain = (): void => settle();
    const onError = (error: Error): void => settle(error);
    const onClose = (): void => settle(new Error('The command output pipe closed before draining.'));
    const onAbort = (): void => settle();
    sink.once('drain', onDrain);
    sink.once('error', onError);
    sink.once('close', onClose);
    abort.signal.addEventListener('abort', onAbort, { once: true });
    if (disconnected || abort.signal.aborted || !sink.writableNeedDrain) settle();
  });
}

process.on('message', async (message: unknown) => {
  if (finished || !message || typeof message !== 'object') return;
  const packet = message as { type?: string; input?: ShellInput; executionLockPath?: string; interactive?: boolean; seq?: number; data?: string };
  if (packet.type === 'stdin' || packet.type === 'eof') {
    const seq = packet.seq;
    if (!interactive || !stdin || stdinBusy || !Number.isSafeInteger(seq) || seq !== stdinSeq + 1 || typeof packet.data !== 'string' || Buffer.byteLength(packet.data) > 22000) { abort.abort(); return; }
    const bytes = Buffer.from(packet.data, 'base64');
    if (bytes.toString('base64') !== packet.data || bytes.length > 16384 || packet.type === 'eof' && bytes.length !== 0) { abort.abort(); return; }
    stdinBusy = true; stdinSeq = seq;
    try { if (packet.type === 'eof') await stdin.end(); else await stdin.write(bytes); send({type:'input-result', seq, ok:true}); }
    catch { send({type:'input-result', seq, ok:false}); }
    finally { stdinBusy = false; }
    return;
  }
  if (packet.type === 'stop') { abort.abort(); if (ready && !started) idleCancelled(); return; }
  if (packet.type === 'init' && !input) {
    input = packet.input;
    interactive = packet.interactive === true;
    if (!input || typeof input.command !== 'string' || typeof input.cwd !== 'string' || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
      finish({ exitCode: null, signal: null, cancelled: false, timedOut: false, cleanupConfirmed: true, started: false, error: 'Invalid supervisor initialization.' });
      return;
    }
    try {
      if (packet.executionLockPath) {
        const { acquireExecutionLock: acquire } = await import('./execution-lock.js');
        if (finished || disconnected) return;
        lock = acquire(packet.executionLockPath);
      }
      if (disconnected || abort.signal.aborted) { idleCancelled(); return; }
      ready = true;
      send({ type: 'ready' });
    } catch (error) {
      finish({ exitCode: null, signal: null, cancelled: false, timedOut: false, cleanupConfirmed: true, started: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (packet.type === 'start' && ready && !started && input) {
    if (disconnected || abort.signal.aborted) { idleCancelled(); return; }
    started = true;
    try {
      const outcome = await executeShell(input, abort.signal, forwardOutput,
        pid => { lock?.recordGroup(pid); send({ type: 'started', pid }); }, warning => send({ type: 'warning', warning }), interactive ? control => { stdin = control; } : undefined);
      finish(outcome);
    } catch (error) {
      finish({ exitCode: null, signal: null, cancelled: abort.signal.aborted, timedOut: false, cleanupConfirmed: false, started: true, error: error instanceof Error ? error.message : String(error) });
    }
  }
});

if (disconnected) idleCancelled();
