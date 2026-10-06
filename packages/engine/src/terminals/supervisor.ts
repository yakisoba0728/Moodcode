import { createCommandEnvironment, cleanupGroup, groupExists } from '../tools/command/process-control.js';
import { TERMINAL_LIMITS, type PtySpawnInput, type PtyOutcome } from './types.js';
import type { IPty } from 'node-pty';

// A detached supervisor owns the PTY. Losing engine IPC closes the process
// group even when the engine itself was killed and cannot run a finally block.
let terminal: IPty | undefined;
let starting = false, exited = false, finished = false, disconnected = !process.connected;
let timer: ReturnType<typeof setTimeout> | undefined;
let cleanup: Promise<PtyOutcome> | undefined;
let exitCode: number | null = null;
let outputPaused = false;
const send = (packet: object, done?: () => void): void => {
  try { if (process.connected && process.send) process.send(packet, () => done?.()); else done?.(); }
  catch { done?.(); }
};
const finish = (outcome: PtyOutcome): void => {
  if (finished) return;
  finished = true;
  if (timer) clearTimeout(timer);
  const deadline = setTimeout(() => process.exit(outcome.cleanupConfirmed ? 0 : 1), 250);
  send({ type: 'result', outcome }, () => {
    if (process.connected) process.disconnect?.();
    if (disconnected || outputPaused) process.stdout.destroy();
    else process.stdout.end();
    clearTimeout(deadline);
    process.exitCode = outcome.cleanupConfirmed ? 0 : 1;
  });
};
const stop = (reason: 'cancel' | 'timeout' | 'parent_lost' | 'descendants'): Promise<PtyOutcome> => {
  if (cleanup) return cleanup;
  cleanup = (async () => {
    if (!terminal) return { exitCode, cancelled: reason !== 'descendants', timedOut: reason === 'timeout', cleanupConfirmed: !starting, reason };
    // Release any paused output before waiting for the native PTY close event.
    try { terminal.resume(); } catch { /* Native exit may already have closed it. */ }
    // Interactive shells relay SIGHUP to foreground/background job groups.
    // The original group is still observed and escalated independently below.
    try { terminal.kill('SIGHUP'); } catch { /* Group cleanup remains authoritative. */ }
    const confirmed = await cleanupGroup(terminal.pid, () => exited).catch(() => false);
    return { exitCode, cancelled: reason !== 'descendants', timedOut: reason === 'timeout', cleanupConfirmed: confirmed, reason };
  })();
  void cleanup.then(finish);
  return cleanup;
};
process.on('disconnect', () => { disconnected = true; void stop('parent_lost'); });
process.on('SIGTERM', () => { void stop('cancel'); });
process.on('SIGINT', () => { void stop('cancel'); });
process.stdout.on('error', () => { disconnected = true; void stop('parent_lost'); });
process.stdout.on('drain', () => {
  outputPaused = false;
  if (!cleanup && !finished) try { terminal?.resume(); } catch { void stop('descendants'); }
});

process.on('message', async (message: unknown) => {
  if (finished || !message || typeof message !== 'object') return;
  const packet = message as { type?: string; input?: PtySpawnInput; id?: number; data?: string; cols?: number; rows?: number };
  if (packet.type === 'stop') { void stop('cancel'); return; }
  if (packet.type === 'start' && !starting) {
    const input = packet.input;
    if (!input || typeof input.file !== 'string' || !Array.isArray(input.args) || typeof input.cwd !== 'string'
      || !Number.isSafeInteger(input.cols) || input.cols < 1 || input.cols > TERMINAL_LIMITS.maxCols
      || !Number.isSafeInteger(input.rows) || input.rows < 1 || input.rows > TERMINAL_LIMITS.maxRows
      || !Number.isSafeInteger(input.maxDurationMs) || input.maxDurationMs < 1 || input.maxDurationMs > TERMINAL_LIMITS.maxDurationMs) {
      finish({ exitCode: null, cancelled: false, timedOut: false, cleanupConfirmed: true, reason: 'invalid_start' }); return;
    }
    starting = true;
    try {
      const pty = await import('node-pty');
      if (disconnected || cleanup) { starting = false; return; }
      terminal = pty.spawn(input.file, input.args, { name: 'xterm-256color', cols: input.cols, rows: input.rows, cwd: input.cwd, env: createCommandEnvironment() as Record<string, string> });
      terminal.onData(data => {
        if (finished || disconnected || cleanup) return;
        if (!process.stdout.write(data)) { outputPaused = true; terminal?.pause(); }
      });
      terminal.onExit(event => {
        exited = true; exitCode = event.exitCode;
        if (cleanup) return;
        if (terminal && groupExists(terminal.pid)) { void stop('descendants'); return; }
        finish({ exitCode, cancelled: false, timedOut: false, cleanupConfirmed: true });
      });
      timer = setTimeout(() => { void stop('timeout'); }, input.maxDurationMs);
      send({ type: 'started', pid: terminal.pid });
    } catch {
      starting = false;
      finish({ exitCode: null, cancelled: false, timedOut: false, cleanupConfirmed: true, reason: 'pty_unavailable' });
    }
    return;
  }
  if (packet.type === 'write' || packet.type === 'resize') {
    const reply = (code?: string) => send({ type: 'ack', id: packet.id, ...(code ? { code } : {}) });
    if (!terminal || exited || cleanup || !Number.isSafeInteger(packet.id)) { reply('TERMINAL_CLOSED'); return; }
    try {
      if (packet.type === 'write') {
        if (typeof packet.data !== 'string' || Buffer.byteLength(packet.data) > TERMINAL_LIMITS.maxWriteBytes) { reply('INVALID_TERMINAL_INPUT'); return; }
        terminal.write(packet.data);
      } else {
        if (!Number.isSafeInteger(packet.cols) || packet.cols! < 1 || packet.cols! > TERMINAL_LIMITS.maxCols || !Number.isSafeInteger(packet.rows) || packet.rows! < 1 || packet.rows! > TERMINAL_LIMITS.maxRows) { reply('INVALID_TERMINAL_INPUT'); return; }
        terminal.resize(packet.cols!, packet.rows!);
      }
      reply();
    } catch { reply('TERMINAL_IO_FAILED'); }
  }
});
send({ type: 'ready' });
if (disconnected) void stop('parent_lost');
