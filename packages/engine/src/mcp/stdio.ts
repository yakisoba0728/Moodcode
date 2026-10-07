import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { isAbsolute } from 'node:path';
import { EngineError } from '@moodcode/contracts';
import { encodeMessage, markMcpDispatchTransport, MCP_LIMITS, parseMessage, type JsonRpcMessage, type McpTransport, type McpTransportSendObservation } from './protocol.js';
export interface StdioMcpOptions { command: string; args?: readonly string[]; cwd: string; env?: Readonly<Record<string, string>> }
/** Starts only an explicit executable/argv and never inherits account credentials by default. */
export class StdioMcpTransport implements McpTransport {
  readonly dispatchBoundary = 'before-send-v1' as const;
  readonly kind = 'stdio' as const; private child?: ChildProcessWithoutNullStreams; private closed = false; private finished = false; private closePromise?: Promise<void>;
  private onClose?: (error?: EngineError) => void;
  constructor(private readonly options: StdioMcpOptions) {
    if (typeof options.command !== 'string' || !isAbsolute(options.command) || options.command.includes('\0') || !isAbsolute(options.cwd) || options.args && (!Array.isArray(options.args) || options.args.length > 64 || options.args.some(arg => typeof arg !== 'string' || Buffer.byteLength(arg) > 8192 || arg.includes('\0')))) throw new EngineError('INVALID_MCP_STDIO', 'MCP stdio requires explicit absolute executable/cwd and bounded argv');
    markMcpDispatchTransport(this, StdioMcpTransport.prototype.send);
  }
  async start(onMessage: (message: JsonRpcMessage) => void, onClose: (error?: EngineError) => void): Promise<void> {
    if (this.child || this.closed) throw new EngineError('MCP_TRANSPORT_STATE', 'MCP stdio transport can start only once'); this.onClose = onClose;
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
    for (const [key, value] of Object.entries(this.options.env ?? {})) { if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof value !== 'string' || Buffer.byteLength(value) > 16_384 || value.includes('\0')) throw new EngineError('INVALID_MCP_STDIO', 'Explicit MCP environment contains invalid values'); env[key] = value; }
    const child = spawn(this.options.command, [...this.options.args ?? []], { cwd: this.options.cwd, env, detached: process.platform !== 'win32', shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); this.child = child;
    let buffered = Buffer.alloc(0);
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      try {
        // Process lines before retaining the incomplete suffix, avoiding chunk-concat amplification.
        let position = 0;
        while (position < chunk.length) { const end = chunk.indexOf(10, position); const part = chunk.subarray(position, end < 0 ? chunk.length : end); if (buffered.length + part.length > MCP_LIMITS.maxMessageBytes) throw new EngineError('MCP_MESSAGE_LIMIT', 'MCP stdout frame exceeds its byte budget'); buffered = Buffer.concat([buffered, part]); if (end < 0) break; const line = buffered; buffered = Buffer.alloc(0); if (line.length) onMessage(parseMessage(line)); position = end + 1; }
      } catch (error) { this.fail(error instanceof EngineError ? error : new EngineError('MCP_INVALID_MESSAGE', 'MCP stdout could not be parsed')); }
    });
    child.stderr.on('data', () => { /* Drain without retaining or exposing potentially secret-bearing server logs. */ });
    child.stdin.on('error', () => this.fail(new EngineError('MCP_DISCONNECTED', 'MCP server input stream closed')));
    child.once('error', () => this.fail(new EngineError('MCP_START_FAILED', 'MCP server process could not be started')));
    child.once('exit', () => { this.finished = true; this.fail(new EngineError('MCP_DISCONNECTED', 'MCP server process exited')); });
    child.stdout.once('end', () => this.fail(new EngineError('MCP_DISCONNECTED', 'MCP server output stream closed')));
    try { await once(child, 'spawn'); } catch { throw new EngineError('MCP_START_FAILED', 'MCP server process could not be started'); }
  }
  private fail(error: EngineError): void { if (this.closed) return; this.closed = true; this.onClose?.(error); void this.shutdown(); }
  async send(message: JsonRpcMessage, signal?: AbortSignal, _headers?: Readonly<Record<string, string>>, observation?: McpTransportSendObservation): Promise<void> {
    if (this.closed || !this.child) throw new EngineError('MCP_DISCONNECTED', 'MCP stdio transport is disconnected'); if (signal?.aborted) throw new EngineError('MCP_CANCELLED', 'MCP write cancelled');
    const encoded = `${encodeMessage(message)}\n`; const child = this.child;
    if (signal?.aborted || this.closed || child.stdin.destroyed || child.stdin.writableEnded) throw new EngineError('MCP_CANCELLED', 'MCP write cancelled before dispatch');
    observation?.beforeSend();
    await new Promise<void>((resolve, reject) => child.stdin.write(encoded, error => error ? reject(new EngineError('MCP_DISCONNECTED', 'MCP write failed')) : resolve()));
  }
  async cancel(requestId: number): Promise<void> { if (!this.closed) await this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } }).catch(() => {}); }
  async close(): Promise<void> { if (!this.closed) { this.closed = true; this.onClose?.(); } return this.shutdown(); }
  private shutdown(): Promise<void> { return this.closePromise ??= this.shutdownProcess(); }
  private async shutdownProcess(): Promise<void> {
    const child = this.child; if (!child) return; child.stdin.end();
    const wait = (ms: number) => new Promise<void>(resolve => { if (this.finished) { resolve(); return; } const timer = setTimeout(done, ms); function done() { clearTimeout(timer); child!.removeListener('exit', done); resolve(); } child.once('exit', done); });
    await wait(100);
    const kill = (signal: NodeJS.Signals) => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
    // Terminate the dedicated group even if the parent exited while leaving a descendant.
    kill('SIGTERM'); await wait(100); kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); await wait(100);
  }
}
