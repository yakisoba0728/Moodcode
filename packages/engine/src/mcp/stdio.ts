import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {supervisorExecArgv} from '../tools/command/index.js';
import {groupExists,cleanupGroup} from '../tools/command/process-control.js';
import type {SandboxLaunch} from '../sandbox/types.js';
import { fork,spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { dirname, isAbsolute } from 'node:path';
import { EngineError } from '@moodcode/contracts';
import { encodeMessage, markMcpDispatchTransport, MCP_LIMITS, parseMessage, type JsonRpcMessage, type McpTransport, type McpTransportSendObservation } from './protocol.js';
export interface StdioMcpOptions { command: string; args?: readonly string[]; cwd: string; env?: Readonly<Record<string, string>>; sandbox?:(message?:JsonRpcMessage)=>SandboxLaunch; observer?:{beforeStart():void;started(pid:number):void;closed(outcome:{exitCode:number|null;cleanupConfirmed:boolean;started:boolean}):void} }
/** Starts only an explicit executable/argv and never inherits account credentials by default. */
export class StdioMcpTransport implements McpTransport {
  readonly dispatchBoundary = 'before-send-v1' as const;
  readonly kind = 'stdio' as const; private child?: ChildProcessWithoutNullStreams; private closed = false; private finished = false; private closePromise?: Promise<void>;
  private onClose?: (error?: EngineError) => void; private exitCode:number|null=null; private effectPid?:number; private sandboxOutcome?:{exitCode:number|null;cleanupConfirmed:boolean;started:boolean};
  constructor(private readonly options: StdioMcpOptions) {
    if (typeof options.command !== 'string' || !isAbsolute(options.command) || options.command.includes('\0') || !isAbsolute(options.cwd) || options.args && (!Array.isArray(options.args) || options.args.length > 64 || options.args.some(arg => typeof arg !== 'string' || Buffer.byteLength(arg) > 8192 || arg.includes('\0')))) throw new EngineError('INVALID_MCP_STDIO', 'MCP stdio requires explicit absolute executable/cwd and bounded argv');
    markMcpDispatchTransport(this, StdioMcpTransport.prototype.send);
  }
  async start(onMessage: (message: JsonRpcMessage) => void, onClose: (error?: EngineError) => void): Promise<void> {
    if (this.child || this.closed) throw new EngineError('MCP_TRANSPORT_STATE', 'MCP stdio transport can start only once'); this.onClose = onClose;
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
    for (const [key, value] of Object.entries(this.options.env ?? {})) { if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof value !== 'string' || Buffer.byteLength(value) > 16_384 || value.includes('\0')) throw new EngineError('INVALID_MCP_STDIO', 'Explicit MCP environment contains invalid values'); env[key] = value; }
    const launch=this.options.sandbox?.();
    if(launch&&(process.platform!=='darwin'||launch.executable!=='/usr/bin/sandbox-exec'))throw new EngineError('SANDBOX_MCP_UNSUPPORTED','No unsandboxed MCP fallback');
    const compiled=fileURLToPath(new URL('../sandbox/mcp-supervisor.js',import.meta.url)),source=fileURLToPath(new URL('../sandbox/mcp-supervisor.ts',import.meta.url)),execArgv=launch?supervisorExecArgv():[];
    this.options.observer?.beforeStart();
    const child = (launch?fork(existsSync(compiled)?compiled:source,[],{cwd:dirname(process.execPath),env:{PATH:'/usr/bin:/bin',ELECTRON_RUN_AS_NODE:'1'},execPath:process.execPath,execArgv,detached:true,stdio:['pipe','pipe','pipe','ipc']}):spawn(this.options.command,[...this.options.args??[]],{cwd:this.options.cwd,env,detached:process.platform!=='win32',shell:false,stdio:['pipe','pipe','pipe']})) as ChildProcessWithoutNullStreams;this.child=child;
    let admit:()=>void=()=>{};let admissionFailed:(error:unknown)=>void=()=>{};const admission=new Promise<void>((resolve,reject)=>{admit=resolve;admissionFailed=reject;});
    if(launch){child.on('message',(packet:unknown)=>{if(!packet||typeof packet!=='object')return;const p=packet as{type?:string;pid?:number;outcome?:{exitCode:number|null;cleanupConfirmed:boolean;started:boolean}};if(p.type==='started'&&Number.isSafeInteger(p.pid)&&Number(p.pid)>0&&!this.effectPid){this.effectPid=p.pid;try{this.options.observer?.started(p.pid!);admit();}catch(error){admissionFailed(error);void this.close().catch(()=>{});}}else if(p.type==='result'&&p.outcome&&typeof p.outcome.cleanupConfirmed==='boolean'){this.sandboxOutcome=p.outcome;}});child.once('exit',()=>admissionFailed(new EngineError('MCP_START_FAILED','Sandbox supervisor exited before actual server admission')));}

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
    child.once('exit', (code) => { this.exitCode=code; this.finished = true; this.fail(new EngineError('MCP_DISCONNECTED', 'MCP server process exited')); });
    child.stdout.once('end', () => this.fail(new EngineError('MCP_DISCONNECTED', 'MCP server output stream closed')));
    try { await once(child, 'spawn'); if(launch){child.send?.({type:'init',command:this.options.command,args:[...this.options.args??[]],cwd:this.options.cwd,profile:launch.profile});await Promise.race([admission,new Promise<never>((_r,reject)=>{const timer=setTimeout(()=>reject(new EngineError('MCP_START_FAILED','Sandbox server admission timed out')),5000);timer.unref();})]);}else this.options.observer?.started(child.pid!); } catch { throw new EngineError('MCP_START_FAILED', 'MCP server process could not be started'); }
  }
  private fail(error: EngineError): void { if (this.closed) return; this.closed = true; this.onClose?.(error); void this.shutdown().catch(()=>{}); }
  async send(message: JsonRpcMessage, signal?: AbortSignal, _headers?: Readonly<Record<string, string>>, observation?: McpTransportSendObservation): Promise<void> {
    if (this.closed || !this.child) throw new EngineError('MCP_DISCONNECTED', 'MCP stdio transport is disconnected'); if (signal?.aborted) throw new EngineError('MCP_CANCELLED', 'MCP write cancelled');
    const encoded = `${encodeMessage(message)}\n`; const child = this.child;
    if (signal?.aborted || this.closed || child.stdin.destroyed || child.stdin.writableEnded) throw new EngineError('MCP_CANCELLED', 'MCP write cancelled before dispatch');
    this.options.sandbox?.(message);
    observation?.beforeSend();
    await new Promise<void>((resolve, reject) => child.stdin.write(encoded, error => error ? reject(new EngineError('MCP_DISCONNECTED', 'MCP write failed')) : resolve()));
  }
  async cancel(requestId: number): Promise<void> { if (!this.closed) await this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } }).catch(() => {}); }
  async close(): Promise<void> { if (!this.closed) { this.closed = true; this.onClose?.(); } return this.shutdown(); }
  private shutdown(): Promise<void> { return this.closePromise ??= this.shutdownProcess(); }
  private async shutdownProcess(): Promise<void> {
    const child = this.child; if (!child) return; child.stdin.end();
    const wait = (ms: number) => new Promise<void>(resolve => { if (this.finished) { resolve(); return; } const timer = setTimeout(done, ms); function done() { clearTimeout(timer); child!.removeListener('exit', done); resolve(); } child.once('exit', done); });
    if(this.options.sandbox){try{child.send?.({type:'stop'});}catch{}await wait(3000);const pid=this.effectPid;const physical=pid?(this.sandboxOutcome?.cleanupConfirmed===true?!groupExists(pid):await cleanupGroup(pid)):this.sandboxOutcome?.started===false;try{if(child.pid&&!this.finished)process.kill(-child.pid,'SIGKILL');}catch{}await wait(200);const confirmed=this.sandboxOutcome?.cleanupConfirmed===true&&physical===true&&this.finished;this.options.observer?.closed({exitCode:this.sandboxOutcome?.exitCode??null,cleanupConfirmed:confirmed,started:this.sandboxOutcome?.started??true});if(!confirmed)throw new EngineError('CLEANUP_UNCERTAIN','Actual sandbox MCP supervisor cleanup is unconfirmed');return;}
    await wait(100);
    const kill = (signal: NodeJS.Signals) => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
    // Terminate the dedicated group even if the parent exited while leaving a descendant.
    kill('SIGTERM'); await wait(100); kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); await wait(100);
    const cleanupConfirmed=process.platform!=='win32'&&child.pid?await cleanupGroup(child.pid):this.finished;
    this.options.observer?.closed({exitCode:this.exitCode,cleanupConfirmed,started:Boolean(child.pid)});
    if(!cleanupConfirmed)throw new EngineError('MCP_TRANSPORT_CLEANUP_UNCERTAIN','MCP process cleanup is unconfirmed',{cleanupUncertain:true,transportCleanupConfirmed:false});
  }
}
